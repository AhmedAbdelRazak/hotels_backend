/** @format */

const multer = require("multer");
const { simpleParser } = require("mailparser");
const mongoose = require("mongoose");
const InboundEmail = require("../models/inbound_email");
const User = require("../models/user");
const {
	hashText,
	redactSensitive,
	safeSnippet,
	normalizeWhitespace,
} = require("../services/otaReservationMapper");
const {
	orchestrateInboundReservationEmail,
	buildRedactedEmailText,
} = require("../services/otaEmailOrchestrator");
const { reconcileOtaReservation } = require("../services/otaReservationMapper");
const { emitHotelNotificationRefresh } = require("../services/notificationEvents");

const ObjectId = mongoose.Types.ObjectId;

const configuredSuperAdminIds = () =>
	[process.env.SUPER_ADMIN_ID, process.env.REACT_APP_SUPER_ADMIN_ID]
		.filter(Boolean)
		.map((id) => String(id).trim());

const canViewInboundEmails = (user = {}) => {
	const role = Number(user?.role);
	const roleDescriptions = [
		String(user?.roleDescription || "").toLowerCase(),
		...(Array.isArray(user?.roleDescriptions)
			? user.roleDescriptions.map((item) => String(item || "").toLowerCase())
			: []),
	];
	return (
		role === 1000 ||
		configuredSuperAdminIds().includes(String(user?._id || user?.id || "").trim()) ||
		roleDescriptions.includes("superadmin") ||
		roleDescriptions.includes("admin")
	);
};

const upload = multer({
	limits: {
		fieldSize: 25 * 1024 * 1024,
		fileSize: 10 * 1024 * 1024,
		fields: 100,
		files: 20,
	},
});

const terminalEmailStatuses = [
	"created",
	"updated",
	"cancelled",
	"status_updated",
	"duplicate_reservation",
	"not_reservation",
	"needs_review",
	"needs_mapping",
];

const shortHash = (value = "") => String(value || "").slice(0, 12);

const logInbound = (stage, payload = {}) => {
	console.log(`[ota-inbound] ${stage}`, {
		at: new Date().toISOString(),
		...payload,
	});
};

const sanitizeStoredBody = (value = "", max = 100000) =>
	redactSensitive(String(value || "")).slice(0, max);

const escapeRegExp = (value = "") =>
	String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const fileMetadata = (file = {}) => ({
	filename: file.originalname || file.filename || file.name || "",
	contentType: file.mimetype || file.contentType || "",
	size: Number(file.size || file.content?.length || 0) || 0,
	contentId: file.contentId || "",
});

exports.parseInboundForm = (req, res, next) => {
	upload.any()(req, res, (err) => {
		if (err) {
			console.error("[SendGrid Inbound] multipart parse error:", err.message);
			InboundEmail.create({
				source: "sendgrid",
				processingStatus: "failed",
				reconcileErrors: [`multipart parse error: ${err.message}`],
				receivedAt: new Date(),
				processedAt: new Date(),
			}).catch(() => {});
			return res.status(200).send("OK");
		}
		return next();
	});
};

exports.sendgridHealth = (_req, res) => {
	res.status(200).json({ ok: true, msg: "SendGrid inbound endpoint is live" });
};

exports.requireInboundEmailAdmin = async (req, res, next) => {
	try {
		const userId = req.auth?._id;
		if (!userId || !ObjectId.isValid(userId)) {
			return res.status(403).json({ error: "Admin resource! access denied" });
		}
		const user = await User.findById(userId)
			.select("_id role roleDescription roleDescriptions")
			.lean()
			.exec();
		if (!user || !canViewInboundEmails(user)) {
			return res.status(403).json({ error: "Admin resource! access denied" });
		}
		req.inboundEmailViewer = user;
		return next();
	} catch (error) {
		console.error("[inbound-emails] admin check failed:", error.message);
		return res.status(500).json({ error: "Could not verify admin access." });
	}
};

const inboundSecretIsValid = (req) => {
	const expected = process.env.SENDGRID_INBOUND_SECRET;
	if (!expected) return true;
	const provided =
		req.query.token ||
		req.get("x-inbound-secret") ||
		req.body?.token ||
		req.body?.secret;
	return provided === expected;
};

const getHeaderMessageId = (headers = "") => {
	const match = String(headers || "").match(/^message-id:\s*(.+)$/im);
	return normalizeWhitespace(match?.[1] || "");
};

const parseSendGridPayload = async (body = {}, files = []) => {
	const rawMime = body.email || body.raw || body.mime || body.rawEmail || "";
	if (rawMime) {
		const parsed = await simpleParser(rawMime);
		const attachments = [
			...(Array.isArray(parsed.attachments)
				? parsed.attachments.map(fileMetadata)
				: []),
			...(Array.isArray(files) ? files.map(fileMetadata) : []),
		];
		return {
			from: parsed.from?.text || body.from || "",
			to: parsed.to?.text || body.to || "",
			cc: parsed.cc?.text || body.cc || "",
			bcc: parsed.bcc?.text || body.bcc || "",
			subject: parsed.subject || body.subject || "",
			text: parsed.text || body.text || "",
			html: parsed.html || body.html || "",
			messageId:
				parsed.messageId || body.messageId || getHeaderMessageId(body.headers),
			rawHash: hashText(rawMime),
			attachments,
		};
	}

	return {
		from: body.from || "",
		to: body.to || "",
		cc: body.cc || "",
		bcc: body.bcc || "",
		subject: body.subject || "",
		text: body.text || "",
		html: body.html || "",
		messageId:
			body.messageId || body["message-id"] || getHeaderMessageId(body.headers),
		rawHash: hashText(
			`${body.from || ""}|${body.to || ""}|${body.subject || ""}|${
				body.text || ""
			}|${body.html || ""}`
		),
		attachments: Array.isArray(files) ? files.map(fileMetadata) : [],
	};
};

const findProcessedDuplicate = async (emailHash, messageId) => {
	if (!emailHash && !messageId) return null;
	const query = {
		processingStatus: { $in: terminalEmailStatuses },
		$or: [],
	};
	if (emailHash) query.$or.push({ emailHash });
	if (messageId) query.$or.push({ messageId });
	if (!query.$or.length) return null;
	return InboundEmail.findOne(query)
		.select("_id processingStatus reservationMongoId hotelId pmsConfirmationNumber")
		.sort({ receivedAt: 1 })
		.lean()
		.exec();
};

const emitInboundEmailUpdated = (req, record, extra = {}) => {
	const io = req?.app?.get("io");
	if (!io || !record?._id) return;
	io.emit("inboundEmailUpdated", {
		_id: String(record._id),
		processingStatus: record.processingStatus || extra.processingStatus || "",
		provider: record.provider || extra.provider || "",
		intent: record.intent || extra.intent || "",
		confirmationNumber:
			record.confirmationNumber || extra.confirmationNumber || "",
		pmsConfirmationNumber:
			record.pmsConfirmationNumber || extra.pmsConfirmationNumber || "",
		hotelId: String(record.hotelId || extra.hotelId || ""),
		reservationMongoId: String(
			record.reservationMongoId || extra.reservationMongoId || ""
		),
		updatedAt: new Date().toISOString(),
	});
};

const createInboundEmailRecord = async (email, duplicate) => {
	const redactedText = buildRedactedEmailText(email);
	const emailHash = email.rawHash || hashText(redactedText);
	return InboundEmail.create({
		source: "sendgrid",
		processingStatus: "received",
		from: email.from || "",
		to: email.to || "",
		cc: email.cc || "",
		bcc: email.bcc || "",
		subject: email.subject || "",
		messageId: email.messageId || "",
		emailHash,
		textHash: hashText(redactedText),
		duplicateOf: duplicate?._id || null,
		bodyText: sanitizeStoredBody(redactedText),
		bodyHtml: "",
		safeSnippet: safeSnippet(redactedText, 800),
		attachments: email.attachments || [],
		receivedAt: new Date(),
	});
};

const buildInboundExtractionFields = (normalized = {}, reconciliation = {}) => ({
	pmsConfirmationNumber: reconciliation.pmsConfirmationNumber || "",
	sourceAmount: Number(normalized.amount || 0),
	sourceCurrency: normalized.currency || "",
	totalAmountSar: Number(normalized.totalAmountSar || 0),
	exchangeRateToSar: Number(normalized.exchangeRateToSar || 0),
	exchangeRateSource: normalized.exchangeRateSource || "",
	paymentCollectionModel: normalized.paymentCollectionModel || "",
	...buildAutomationAuditFields(reconciliation),
});

const normalizeSkipReason = (value = "") =>
	String(value || "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 140);

const buildAutomationAuditFields = (reconciliation = {}) => {
	const status = String(reconciliation.status || "").toLowerCase();
	const hasReservationConnection = !!reconciliation.reservationId;
	const matchedReservationBy = Array.isArray(reconciliation.matchedReservationBy)
		? reconciliation.matchedReservationBy.filter(Boolean)
		: reconciliation.matchedReservationBy
			? [String(reconciliation.matchedReservationBy)]
			: [];

	let automationAction = reconciliation.actionTaken || "";
	let skipReason = reconciliation.skipReason || "";
	let automationComment = reconciliation.automationComment || "";

	if (!automationAction) {
		if (status === "created") automationAction = "created";
		else if (["updated", "cancelled", "status_updated"].includes(status)) {
			automationAction = "updated";
		} else if (status === "duplicate_reservation") {
			automationAction = "skipped";
			skipReason = skipReason || "duplicate_existing_reservation_no_update";
			automationComment =
				automationComment ||
				"Existing reservation matched by confirmation number; no new reservation was created.";
		} else if (status === "duplicate_email") {
			automationAction = "skipped";
			skipReason = skipReason || "duplicate_email";
			automationComment =
				automationComment ||
				"Duplicate inbound email payload; email was saved for audit only.";
		} else if (status === "not_reservation") {
			automationAction = "skipped";
			skipReason = skipReason || "not_reservation";
			automationComment =
				automationComment ||
				"Orchestrator classified this inbound email as not a reservation.";
		} else if (["needs_review", "needs_mapping"].includes(status)) {
			automationAction = "skipped";
			skipReason =
				skipReason ||
				normalizeSkipReason(
					(reconciliation.errors || [])[0] || status || "needs_manual_review"
				);
			automationComment =
				automationComment ||
				(reconciliation.errors || [])[0] ||
				"Email needs manual review before any reservation action.";
		}
	}

	if (automationAction === "skipped" && !skipReason) {
		skipReason = status || "skipped";
	}

	return {
		automationAction: normalizeSkipReason(automationAction),
		skipReason: normalizeSkipReason(skipReason),
		automationComment: String(automationComment || "").slice(0, 500),
		hasReservationConnection,
		matchedReservationBy,
	};
};

const finalizeRecord = async (recordId, update) => {
	return InboundEmail.findByIdAndUpdate(
		recordId,
		{
			$set: {
				...update,
				processedAt: new Date(),
			},
		},
		{ new: true }
	)
		.lean()
		.exec();
};

const emitReservationRefreshIfNeeded = async (req, reconciliation) => {
	if (
		!reconciliation?.hotelId ||
		!["created", "updated", "cancelled", "status_updated"].includes(
			reconciliation.status
		)
	) {
		return;
	}
	await emitHotelNotificationRefresh(req, reconciliation.hotelId, {
		type: "reservation_update",
		reservationId: reconciliation.reservationId,
		ownerId: reconciliation.ownerId,
	});
};

exports.handleSendGridInbound = async (req, res) => {
	let inboundRecord = null;
	try {
		logInbound("request.received", {
			contentType: req.get("content-type") || "",
			hasFiles: Array.isArray(req.files) && req.files.length > 0,
			fileCount: Array.isArray(req.files) ? req.files.length : 0,
		});

		if (!inboundSecretIsValid(req)) {
			console.warn("[SendGrid Inbound] rejected invalid secret");
			return res.status(401).send("Unauthorized");
		}
		logInbound("secret.accepted");

		const email = await parseSendGridPayload(req.body || {}, req.files || []);
		logInbound("payload.parsed", {
			from: email.from,
			to: email.to,
			subject: email.subject,
			messageId: email.messageId,
			rawHash: shortHash(email.rawHash),
			attachments: (email.attachments || []).map((attachment) => ({
				filename: attachment.filename,
				contentType: attachment.contentType,
				size: attachment.size,
			})),
		});

		const preliminaryHash =
			email.rawHash || hashText(`${email.subject || ""}|${email.text || ""}`);
		const duplicate = await findProcessedDuplicate(
			preliminaryHash,
			email.messageId
		);
		logInbound("duplicate.checked", {
			emailHash: shortHash(preliminaryHash),
			messageId: email.messageId,
			isDuplicate: !!duplicate,
			duplicateStatus: duplicate?.processingStatus || "",
			duplicateId: duplicate?._id ? String(duplicate._id) : "",
		});

		inboundRecord = await createInboundEmailRecord(email, duplicate);
		logInbound("audit.saved", {
			inboundEmailId: String(inboundRecord._id),
			duplicateOf: duplicate?._id ? String(duplicate._id) : "",
		});

		logInbound("orchestrator.start", {
			inboundEmailId: String(inboundRecord._id),
		});
		const orchestration = await orchestrateInboundReservationEmail(email);
		const normalized = orchestration.normalized;
		normalized.inboundEmailId = String(inboundRecord._id);
		logInbound("orchestrator.done", {
			inboundEmailId: String(inboundRecord._id),
			provider: normalized.provider,
			intent: normalized.intent,
			eventType: normalized.eventType,
			statusToApply: normalized.statusToApply || "",
			confirmationNumber: normalized.confirmationNumber,
			sourceCurrency: normalized.currency || "",
			sourceAmount: normalized.amount || 0,
			totalAmountSar: normalized.totalAmountSar || 0,
			exchangeRateToSar: normalized.exchangeRateToSar || 0,
			paymentCollectionModel: normalized.paymentCollectionModel || "",
			forwarded: !!orchestration.emailContext?.forwarded,
			originalFrom: orchestration.emailContext?.originalFrom || "",
			originalSubject: orchestration.emailContext?.originalSubject || "",
			usedAI: !!orchestration.decision?.usedAI,
			aiSkipped: !!orchestration.decision?.skipped,
			warnings: normalized.warnings || [],
			errors: normalized.errors || [],
		});

		if (duplicate) {
			const duplicateReconciliation = {
				status: "duplicate_email",
				duplicateOf: duplicate._id,
				reservationId: duplicate.reservationMongoId || null,
				hotelId: duplicate.hotelId || null,
				pmsConfirmationNumber: duplicate.pmsConfirmationNumber || "",
				actionTaken: "skipped",
				skipReason: "duplicate_email",
				automationComment:
					"Duplicate inbound email payload; email was saved for audit only.",
				matchedReservationBy: ["email_hash_or_message_id"],
			};
			const updated = await finalizeRecord(inboundRecord._id, {
				processingStatus: "duplicate_email",
				provider: normalized.provider || "",
				providerLabel: normalized.providerLabel || "",
				intent: normalized.intent || "",
				eventType: normalized.eventType || "",
				confirmationNumber: normalized.confirmationNumber || "",
				hotelName: normalized.hotelName || "",
				roomName: normalized.roomName || "",
				...buildInboundExtractionFields(normalized, duplicateReconciliation),
				reservationMongoId: duplicate.reservationMongoId || null,
				hotelId: duplicate.hotelId || null,
				normalizedReservation: normalized,
				emailContext: orchestration.emailContext || {},
				orchestratorDecision: orchestration.decision || {},
				reconciliation: duplicateReconciliation,
				parseWarnings: normalized.warnings || [],
				parseErrors: normalized.errors || [],
				safeSnippet:
					orchestration.safeSnippet ||
					safeSnippet(`${email.subject || ""}\n${email.text || ""}`, 800),
			});
			logInbound("duplicate.audited", {
				inboundEmailId: String(inboundRecord._id),
				duplicateOf: String(duplicate._id),
				provider: normalized.provider,
				intent: normalized.intent,
				confirmationNumber: normalized.confirmationNumber,
			});
			emitInboundEmailUpdated(req, updated || inboundRecord);
			return res.status(200).send("OK");
		}

		logInbound("reconcile.start", {
			inboundEmailId: String(inboundRecord._id),
			intent: normalized.intent,
			eventType: normalized.eventType,
			statusToApply: normalized.statusToApply || "",
			confirmationNumber: normalized.confirmationNumber,
			totalAmountSar: normalized.totalAmountSar || 0,
			paymentCollectionModel: normalized.paymentCollectionModel || "",
		});
		const reconciliation = await reconcileOtaReservation(normalized);
		logInbound("reconcile.done", {
			inboundEmailId: String(inboundRecord._id),
			status: reconciliation.status,
			pmsConfirmationNumber: reconciliation.pmsConfirmationNumber || "",
			reservationId: reconciliation.reservationId
				? String(reconciliation.reservationId)
				: "",
			hotelId: reconciliation.hotelId ? String(reconciliation.hotelId) : "",
			warnings: reconciliation.warnings || [],
			errors: reconciliation.errors || [],
		});

		const updated = await finalizeRecord(inboundRecord._id, {
			provider: normalized.provider || "",
			providerLabel: normalized.providerLabel || "",
			intent: normalized.intent || "",
			eventType: normalized.eventType || "",
			processingStatus: reconciliation.status || "processed",
			confirmationNumber: normalized.confirmationNumber || "",
			hotelName: normalized.hotelName || "",
			roomName: normalized.roomName || "",
			...buildInboundExtractionFields(normalized, reconciliation),
			hotelId: reconciliation.hotelId || null,
			reservationMongoId: reconciliation.reservationId || null,
			normalizedReservation: normalized,
			emailContext: orchestration.emailContext || {},
			orchestratorDecision: orchestration.decision || {},
			reconciliation,
			parseWarnings: normalized.warnings || [],
			parseErrors: normalized.errors || [],
			reconcileWarnings: reconciliation.warnings || [],
			reconcileErrors: reconciliation.errors || [],
			safeSnippet:
				orchestration.safeSnippet ||
				safeSnippet(`${email.subject || ""}\n${email.text || ""}`, 800),
		});

		await emitReservationRefreshIfNeeded(req, reconciliation).catch((error) =>
			console.error("[SendGrid Inbound] notification emit failed:", error.message)
		);
		logInbound("socket.emit", {
			inboundEmailId: String(inboundRecord._id),
			hotelId: reconciliation.hotelId ? String(reconciliation.hotelId) : "",
			reservationId: reconciliation.reservationId
				? String(reconciliation.reservationId)
				: "",
			reconciliationStatus: reconciliation.status,
		});
		emitInboundEmailUpdated(req, updated || inboundRecord, {
			processingStatus: reconciliation.status,
			provider: normalized.provider,
			intent: normalized.intent,
			confirmationNumber: normalized.confirmationNumber,
			pmsConfirmationNumber: reconciliation.pmsConfirmationNumber,
			hotelId: reconciliation.hotelId,
			reservationMongoId: reconciliation.reservationId,
		});

		console.log("[SendGrid Inbound]", {
			status: reconciliation.status,
			provider: normalized.provider,
			intent: normalized.intent,
			confirmationNumber: normalized.confirmationNumber,
			subject: email.subject,
			at: new Date().toISOString(),
		});

		return res.status(200).send("OK");
	} catch (err) {
		console.error("[SendGrid Inbound] error:", err.message);
		if (inboundRecord?._id) {
			const updated = await finalizeRecord(inboundRecord._id, {
				processingStatus: "failed",
				reconcileErrors: [err.message],
			}).catch(() => null);
			emitInboundEmailUpdated(req, updated || inboundRecord);
		} else {
			await InboundEmail.create({
				source: "sendgrid",
				processingStatus: "failed",
				subject: req.body?.subject || "",
				from: req.body?.from || "",
				to: req.body?.to || "",
				reconcileErrors: [err.message],
				bodyText: sanitizeStoredBody(req.body?.text || ""),
				bodyHtml: "",
				safeSnippet: safeSnippet(req.body?.subject || "", 800),
				processedAt: new Date(),
			}).catch(() => null);
		}
		return res.status(200).send("OK");
	}
};

exports.listInboundEmails = async (req, res) => {
	try {
		const page = Math.max(Number(req.params.page || 1), 1);
		const records = Math.min(Math.max(Number(req.params.records || 25), 1), 200);
		const skip = (page - 1) * records;
		const query = {};

		if (req.query.status) {
			query.processingStatus = String(req.query.status).toLowerCase();
		}
		if (req.query.provider) {
			query.provider = String(req.query.provider).toLowerCase();
		}
		if (req.query.automationAction) {
			query.automationAction = String(req.query.automationAction).toLowerCase();
		}
		if (req.query.skipReason) {
			query.skipReason = String(req.query.skipReason).toLowerCase();
		}
		if (req.query.hasReservationConnection !== undefined) {
			query.hasReservationConnection =
				String(req.query.hasReservationConnection).toLowerCase() === "true";
		}
		if (req.query.hotelId && ObjectId.isValid(req.query.hotelId)) {
			query.hotelId = ObjectId(req.query.hotelId);
		}
		if (req.query.reservationId && ObjectId.isValid(req.query.reservationId)) {
			query.reservationMongoId = ObjectId(req.query.reservationId);
		}
		if (req.query.confirmationNumber) {
			query.confirmationNumber = String(req.query.confirmationNumber)
				.trim()
				.toLowerCase();
		}
		if (req.query.search) {
			const search = escapeRegExp(String(req.query.search).trim());
			query.$or = [
				{ subject: new RegExp(search, "i") },
				{ from: new RegExp(search, "i") },
				{ confirmationNumber: new RegExp(search, "i") },
				{ pmsConfirmationNumber: new RegExp(search, "i") },
				{ hotelName: new RegExp(search, "i") },
			];
		}

		const [data, total] = await Promise.all([
			InboundEmail.find(query)
				.select("-bodyText -bodyHtml -normalizedReservation")
				.sort({ receivedAt: -1 })
				.skip(skip)
				.limit(records)
				.lean()
				.exec(),
			InboundEmail.countDocuments(query),
		]);

		res.json({ data, total, page, records });
	} catch (error) {
		console.error("[inbound-emails] list failed:", error);
		res.status(500).json({ error: "Could not load inbound emails." });
	}
};

exports.singleInboundEmail = async (req, res) => {
	try {
		const { inboundEmailId } = req.params;
		if (!ObjectId.isValid(inboundEmailId)) {
			return res.status(400).json({ error: "Invalid inbound email ID." });
		}
		const email = await InboundEmail.findById(inboundEmailId)
			.populate("hotelId", "hotelName hotelName_OtherLanguage")
			.populate(
				"reservationMongoId",
				"confirmation_number customer_details checkin_date checkout_date reservation_status total_amount"
			)
			.lean()
			.exec();
		if (!email) return res.status(404).json({ error: "Inbound email not found." });
		res.json(email);
	} catch (error) {
		console.error("[inbound-emails] single failed:", error);
		res.status(500).json({ error: "Could not load inbound email." });
	}
};
