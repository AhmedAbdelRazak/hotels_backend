/** @format */

const crypto = require("crypto");
const multer = require("multer");
const mongoose = require("mongoose");
const InboundEmail = require("../models/inbound_email");
const User = require("../models/user");
const {
	hashText,
	redactSensitive,
	safeSnippet,
	normalizeWhitespace,
	evaluateTrustedSenderAuthentication,
	extractNormalizedReservation,
	resolveHotel,
} = require("../services/otaReservationMapper");
const {
	orchestrateInboundReservationEmail,
	buildRedactedEmailText,
} = require("../services/otaEmailOrchestrator");
const { reconcileOtaReservation } = require("../services/otaReservationMapper");
const {
	forwardImportantInboundEmail,
} = require("../services/inboundEmailForwarder");
const {
	emitHotelNotificationRefresh,
	emitPlatformNotificationRefresh,
} = require("../services/notificationEvents");
const {
	OTA_PLATFORM_REVIEW_PENDING,
	canManageOtaReservations,
	strictPlatformOtaHotelScopeFilter,
} = require("../services/otaReservationVisibility");
const {
	INBOUND_CLAIM_LEASE_MS,
	buildInboundDedupeKey,
	isReclaimableInboundClaim,
	shouldRetryInboundCollision,
} = require("../services/otaInboundDedupe");
const {
	INBOUND_DEDUPE_INDEX_UNAVAILABLE,
	ensureInboundDedupeIndex,
} = require("../services/otaInboundDedupeIndex");
const {
	notifyAirbnbOtaInboundWhatsapp,
} = require("../services/airbnbOtaWhatsappNotifier");
const { getHotelRunnerConfig } = require("../services/hotelrunnerConfig");
const {
	DIRECT_OTA_PROVIDERS,
	canonicalProvider,
	createHotelRunnerFirstOtaFallbackCoordinator,
	safeErrorMessage: safeHotelRunnerFallbackError,
} = require("../services/hotelrunnerFirstOtaFallback");

let simpleParser = null;
try {
	({ simpleParser } = require("mailparser"));
} catch (error) {
	console.warn(
		"[ota-inbound] Optional dependency mailparser is not installed. Raw MIME payloads will use a basic fallback parser until `npm install` is run."
	);
}

const ObjectId = mongoose.Types.ObjectId;

// Raw MIME includes base64 attachment payloads, so its pre-parser ceiling must
// be materially higher than the 256 KiB trusted text/HTML representation
// ceiling enforced by otaReservationMapper. 16 MiB still accommodates one
// ordinary 10 MiB attachment after base64 expansion while preventing the
// multipart field's 25 MiB maximum from reaching mailparser unchecked.
const RAW_MIME_PREPARSER_MAX_BYTES = 16 * 1024 * 1024;
const RAW_MIME_HEADER_SCAN_MAX_BYTES = 64 * 1024;

const configuredSuperAdminIds = () =>
	[process.env.SUPER_ADMIN_ID, process.env.REACT_APP_SUPER_ADMIN_ID]
		.flatMap((value) => String(value || "").split(","))
		.map((id) => String(id).trim())
		.filter(Boolean);

const canViewInboundEmails = (user = {}) =>
	user?.activeUser !== false &&
	(configuredSuperAdminIds().includes(String(user?._id || user?.id || "").trim()) ||
		canManageOtaReservations(user));

const upload = multer({
	limits: {
		fieldSize: 25 * 1024 * 1024,
		fileSize: 10 * 1024 * 1024,
		fields: 100,
		files: 20,
	},
});

const duplicateBlockingEmailStatuses = [
	"created",
	"updated",
	"cancelled",
	"status_updated",
	"duplicate_reservation",
	"not_reservation",
	"hotelrunner_relay_audit_only",
	"awaiting_hotelrunner",
	"parsed_awaiting_hotelrunner",
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

const fileMetadata = (file = {}) => {
	const content = file.buffer || file.content;
	const contentHash = content
		? crypto
				.createHash("sha256")
				.update(Buffer.isBuffer(content) ? content : String(content))
				.digest("hex")
		: "";
	return {
		filename: file.originalname || file.filename || file.name || "",
		contentType: file.mimetype || file.contentType || "",
		size: Number(file.size || file.content?.length || file.buffer?.length || 0) || 0,
		contentId: file.contentId || "",
		contentHash,
	};
};

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
			res.set("Retry-After", "60");
			return res.status(503).send("Inbound multipart parsing failed; retry later");
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
			.select(
				"_id role roles roleDescription roleDescriptions accessTo activeUser hotelIdWork hotelIdsWork hotelsToSupport hotelIdsOwner"
			)
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
	const expectedSecrets = String(process.env.SENDGRID_INBOUND_SECRET || "")
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
	if (!expectedSecrets.length) return false;
	const provided =
		req.query.token ||
		req.get("x-inbound-secret") ||
		"";
	const providedBuffer = Buffer.from(String(provided));
	return expectedSecrets.some((expected) => {
		const expectedBuffer = Buffer.from(expected);
		return (
			expectedBuffer.length === providedBuffer.length &&
			crypto.timingSafeEqual(expectedBuffer, providedBuffer)
		);
	});
};

exports.requireInboundSecret = (req, res, next) => {
	if (!String(process.env.SENDGRID_INBOUND_SECRET || "").trim()) {
		console.error(
			"[SendGrid Inbound] SENDGRID_INBOUND_SECRET is missing; request rejected before multipart parsing."
		);
		res.set("Retry-After", "300");
		return res.status(503).send("Inbound authentication is not configured");
	}
	if (!inboundSecretIsValid(req)) {
		console.warn("[SendGrid Inbound] rejected invalid secret before multipart parsing");
		return res.status(401).send("Unauthorized");
	}
	return next();
};

const getHeaderMessageId = (headers = "") => {
	const match = String(headers || "").match(/^message-id:\s*(.+)$/im);
	return normalizeWhitespace(match?.[1] || "");
};

const getMimeHeader = (raw = "", headerName = "") => {
	const pattern = new RegExp(`^${headerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:\\s*(.+)$`, "im");
	return normalizeWhitespace(String(raw || "").match(pattern)?.[1] || "");
};

const getRawMimeBodyFallback = (raw = "") => {
	const text = String(raw || "");
	const body = text.split(/\r?\n\r?\n/).slice(1).join("\n\n");
	return normalizeWhitespace(body || text);
};

const rawMimeByteLength = (raw = "") =>
	Buffer.isBuffer(raw)
		? raw.length
		: Buffer.byteLength(String(raw || ""), "utf8");

const boundedRawMimeHeaderBlock = (raw = "") => {
	const prefix = Buffer.isBuffer(raw)
		? raw
				.subarray(0, Math.min(raw.length, RAW_MIME_HEADER_SCAN_MAX_BYTES))
				.toString("utf8")
		: Buffer.from(
				String(raw || "").slice(0, RAW_MIME_HEADER_SCAN_MAX_BYTES),
				"utf8"
			)
				.subarray(0, RAW_MIME_HEADER_SCAN_MAX_BYTES)
				.toString("utf8");
	const separator = prefix.search(/\r?\n\r?\n/);
	const headerBlock = separator >= 0 ? prefix.slice(0, separator) : prefix;
	// RFC 5322 folding is bounded to the header window before unfolding.
	return headerBlock.replace(/\r?\n[ \t]+/g, " ");
};

const boundedInboundHeader = (value = "", maxLength = 4096) =>
	normalizeWhitespace(String(value || "").slice(0, maxLength * 4)).slice(
		0,
		maxLength
	);

const boundedRawMimeAuthenticationBody = (body = {}, boundedHeaders = "") => ({
	SPF: boundedInboundHeader(body.SPF ?? body.spf ?? "", 4096),
	dkim: boundedInboundHeader(body.dkim ?? body.DKIM ?? "", 16384),
	envelope: String(body.envelope || "").slice(0, 64 * 1024),
	headers: String(body.headers || boundedHeaders || "").slice(0, 64 * 1024),
});

const validInboundMessageDate = (value, receivedAt = new Date()) => {
	if (!value) return null;
	const parsed = value instanceof Date ? new Date(value) : new Date(String(value));
	if (Number.isNaN(parsed.getTime())) return null;
	// A future sender-controlled Date must never advance the lifecycle watermark.
	if (parsed.getTime() > receivedAt.getTime() + 5 * 60 * 1000) return null;
	return parsed;
};

const withSendGridSenderAuthentication = (email = {}, body = {}) => {
	const deliveryReceivedAt = new Date();
	const senderAuthentication = evaluateTrustedSenderAuthentication({
		from: email.from || "",
		spf: body.SPF ?? body.spf ?? "",
		dkim: body.dkim ?? body.DKIM ?? "",
		envelope: body.envelope ?? null,
	});
	const messageDate = validInboundMessageDate(
		email.date || body.date || getMimeHeader(body.headers || "", "date"),
		deliveryReceivedAt
	);
	const usesAuthenticatedMessageDate = !!(
		senderAuthentication.authenticatedAligned && messageDate
	);
	return {
		...email,
		date: messageDate,
		deliveryReceivedAt,
		sourceReceivedAt: usesAuthenticatedMessageDate
			? messageDate
			: deliveryReceivedAt,
		sourceTimestampMethod: usesAuthenticatedMessageDate
			? `authenticated_${String(senderAuthentication.method || "sender")
					.replace(/\+/g, "_")}_message_date`
			: "sendgrid_webhook_received_at",
		senderAuthentication,
	};
};

const parseSendGridPayload = async (
	body = {},
	files = [],
	{ mimeParser = simpleParser } = {}
) => {
	const rawMime = body.email || body.raw || body.mime || body.rawEmail || "";
	if (rawMime) {
		const rawBytes = rawMimeByteLength(rawMime);
		if (rawBytes > RAW_MIME_PREPARSER_MAX_BYTES) {
			const boundedHeaders = boundedRawMimeHeaderBlock(rawMime);
			const boundedAuthenticationBody = boundedRawMimeAuthenticationBody(
				body,
				boundedHeaders
			);
			// Deliberately do not call mailparser or the raw-body fallback here. Only
			// bounded transport headers survive so authentication, dedupe/audit, and
			// coverage can still identify the delivery without parsing its body.
			return withSendGridSenderAuthentication({
				from: boundedInboundHeader(
					body.from || getMimeHeader(boundedHeaders, "from")
				),
				to: boundedInboundHeader(
					body.to || getMimeHeader(boundedHeaders, "to")
				),
				cc: "",
				bcc: "",
				subject: boundedInboundHeader(
					body.subject || getMimeHeader(boundedHeaders, "subject")
				),
				text: "",
				html: "",
				messageId: boundedInboundHeader(
					body.messageId ||
						body["message-id"] ||
						getMimeHeader(boundedHeaders, "message-id") ||
						getHeaderMessageId(boundedAuthenticationBody.headers),
					1024
				),
				date: boundedInboundHeader(
					body.date ||
						getMimeHeader(boundedHeaders, "date") ||
						getMimeHeader(boundedAuthenticationBody.headers, "date"),
					256
				),
				rawHash: hashText(rawMime),
				hasRawMime: true,
				rawMimeByteLength: rawBytes,
				rawMimePreparserMaxBytes: RAW_MIME_PREPARSER_MAX_BYTES,
				otaInboundParserResourceLimitExceeded: true,
				attachments: Array.isArray(files) ? files.map(fileMetadata) : [],
			}, boundedAuthenticationBody);
		}
		if (mimeParser) {
			const parsed = await mimeParser(rawMime);
			const attachments = [
				...(Array.isArray(parsed.attachments)
					? parsed.attachments.map(fileMetadata)
					: []),
				...(Array.isArray(files) ? files.map(fileMetadata) : []),
			];
			return withSendGridSenderAuthentication({
				from: parsed.from?.text || body.from || "",
				to: parsed.to?.text || body.to || "",
				cc: parsed.cc?.text || body.cc || "",
				bcc: parsed.bcc?.text || body.bcc || "",
				subject: parsed.subject || body.subject || "",
				text: parsed.text || body.text || "",
				html: parsed.html || body.html || "",
				messageId:
					parsed.messageId || body.messageId || getHeaderMessageId(body.headers),
				date:
					parsed.date ||
					body.date ||
					getMimeHeader(body.headers || "", "date"),
				rawHash: hashText(rawMime),
				hasRawMime: true,
				attachments,
			}, body);
		}

		console.warn(
			"[ota-inbound] mailparser unavailable; using raw MIME fallback parser."
		);
		return withSendGridSenderAuthentication({
			from: body.from || getMimeHeader(rawMime, "from"),
			to: body.to || getMimeHeader(rawMime, "to"),
			cc: body.cc || getMimeHeader(rawMime, "cc"),
			bcc: body.bcc || getMimeHeader(rawMime, "bcc"),
			subject: body.subject || getMimeHeader(rawMime, "subject"),
			text: body.text || getRawMimeBodyFallback(rawMime),
			html: body.html || "",
			messageId:
				body.messageId ||
				body["message-id"] ||
				getMimeHeader(rawMime, "message-id") ||
				getHeaderMessageId(body.headers),
			date:
				body.date ||
				getMimeHeader(rawMime, "date") ||
				getMimeHeader(body.headers || "", "date"),
			rawHash: hashText(rawMime),
			hasRawMime: true,
			attachments: Array.isArray(files) ? files.map(fileMetadata) : [],
		}, body);
	}

	return withSendGridSenderAuthentication({
		from: body.from || "",
		to: body.to || "",
		cc: body.cc || "",
		bcc: body.bcc || "",
		subject: body.subject || "",
		text: body.text || "",
		html: body.html || "",
		messageId:
			body.messageId || body["message-id"] || getHeaderMessageId(body.headers),
		date: body.date || getMimeHeader(body.headers || "", "date"),
		rawHash: "",
		hasRawMime: false,
		attachments: Array.isArray(files) ? files.map(fileMetadata) : [],
	}, body);
};

exports.parseSendGridPayload = parseSendGridPayload;
exports.RAW_MIME_PREPARSER_MAX_BYTES = RAW_MIME_PREPARSER_MAX_BYTES;

const duplicateRecordSelection =
	"_id processingStatus receivedAt dedupeKey reservationMongoId hotelId hasReservationConnection reconciliation.reservationId provider providerLabel intent eventType confirmationNumber pmsConfirmationNumber hotelName roomName sourceAmount sourceCurrency totalAmountSar exchangeRateToSar exchangeRateSource paymentCollectionModel";

const findProcessedDuplicate = async (emailHash, messageId) => {
	if (!emailHash && !messageId) return null;
	const query = {
		// Review/mapping failures are intentionally retryable after parser or mapping fixes.
		processingStatus: { $in: duplicateBlockingEmailStatuses },
		$or: [],
	};
	if (emailHash) query.$or.push({ emailHash });
	if (messageId) query.$or.push({ messageId });
	if (!query.$or.length) return null;
	return InboundEmail.findOne(query)
		.select(duplicateRecordSelection)
		.sort({ receivedAt: 1 })
		.lean()
		.exec();
};

const findClaimedDuplicate = async (dedupeKey = "") => {
	if (!dedupeKey) return null;
	return InboundEmail.findOne({ dedupeKey })
		.select(duplicateRecordSelection)
		.sort({ receivedAt: 1 })
		.lean()
		.exec();
};

const isDedupeKeyCollision = (error) => Number(error?.code) === 11000;

const releaseReclaimableClaim = async (record = {}, dedupeKey = "") => {
	if (!dedupeKey || !isReclaimableInboundClaim(record)) return false;
	const staleBefore = new Date(Date.now() - INBOUND_CLAIM_LEASE_MS);
	const result = await InboundEmail.updateOne(
		{
			_id: record._id,
			dedupeKey,
			$or: [
				{ processingStatus: "failed" },
				{
					processingStatus: { $in: ["needs_review", "needs_mapping"] },
					reservationMongoId: null,
					hasReservationConnection: { $ne: true },
					"reconciliation.reservationId": null,
				},
				{ processingStatus: "received", receivedAt: { $lte: staleBefore } },
			],
		},
		{ $unset: { dedupeKey: "" } },
	);
	return Number(result?.matchedCount ?? result?.n ?? 0) > 0;
};

const createWithDedupeClaim = async (email, dedupeKey) => {
	try {
		return {
			inboundRecord: await createInboundEmailRecord(email, { dedupeKey }),
			duplicate: null,
			duplicateSource: "",
			reclaimedFrom: null,
		};
	} catch (error) {
		if (!dedupeKey || !isDedupeKeyCollision(error)) throw error;
		let claimed = await findClaimedDuplicate(dedupeKey);
		if (!claimed) throw error;
		if (await releaseReclaimableClaim(claimed, dedupeKey)) {
			try {
				return {
					inboundRecord: await createInboundEmailRecord(email, { dedupeKey }),
					duplicate: null,
					duplicateSource: "",
					reclaimedFrom: claimed,
				};
			} catch (retryError) {
				if (!isDedupeKeyCollision(retryError)) throw retryError;
				claimed = await findClaimedDuplicate(dedupeKey);
				if (!claimed) throw retryError;
			}
		}
		return {
			inboundRecord: await createInboundEmailRecord(email, {
				duplicate: claimed,
			}),
			duplicate: claimed,
			duplicateSource: "atomic_claim",
			reclaimedFrom: null,
		};
	}
};

const buildNormalizedFromDuplicateRecord = (duplicate = {}) => ({
	provider: duplicate.provider || "",
	providerLabel: duplicate.providerLabel || "",
	intent: duplicate.intent || "",
	eventType: duplicate.eventType || "",
	confirmationNumber: duplicate.confirmationNumber || "",
	hotelName: duplicate.hotelName || "",
	roomName: duplicate.roomName || "",
	amount: Number(duplicate.sourceAmount || 0),
	currency: duplicate.sourceCurrency || "",
	totalAmountSar: Number(duplicate.totalAmountSar || 0),
	exchangeRateToSar: Number(duplicate.exchangeRateToSar || 0),
	exchangeRateSource: duplicate.exchangeRateSource || "",
	paymentCollectionModel: duplicate.paymentCollectionModel || "",
	warnings: [],
	errors: [],
});

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
		forwardingStatus:
			record.forwarding?.status || extra.forwardingStatus || "",
		forwardReason:
			record.forwardDecision?.reason || extra.forwardReason || "",
		airbnbWhatsappNotificationStatus:
			record.airbnbWhatsappNotification?.status ||
			extra.airbnbWhatsappNotificationStatus ||
			"",
		updatedAt: new Date().toISOString(),
	});
};

const createInboundEmailRecord = async (
	email,
	{ duplicate = null, dedupeKey = "" } = {}
) => {
	const redactedText = buildRedactedEmailText(email);
	const emailHash = email.rawHash || hashText(redactedText);
	const record = {
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
		senderAuthentication: email.senderAuthentication || undefined,
		receivedAt: email.deliveryReceivedAt || new Date(),
	};
	if (dedupeKey) record.dedupeKey = dedupeKey;
	return InboundEmail.create(record);
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

const finalizeRecord = async (
	recordId,
	update,
	{ releaseDedupeClaim = false } = {},
) => {
	const mongoUpdate = {
		$set: {
			...update,
			processedAt: new Date(),
		},
	};
	if (releaseDedupeClaim) mongoUpdate.$unset = { dedupeKey: "" };
	return InboundEmail.findByIdAndUpdate(
		recordId,
		mongoUpdate,
		{ new: true }
	)
		.lean()
		.exec();
};

let hotelRunnerFirstFallbackCoordinatorCache = null;
let hotelRunnerFirstFallbackCoordinatorCacheKey = "";

const normalizedObjectId = (value) =>
	String(value?._id || value || "").trim().toLowerCase();

const canonicalInboundTransportProvider = (value) => {
	const key = String(value || "")
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "");
	if (key === "hotelrunner" || key === "hotelrunnercom") return "hotelrunner";
	return canonicalProvider(value);
};

const hotelRunnerFirstFallbackCoordinatorKey = (config = {}) =>
	[
		config.hotelId || "",
		config.hrIdFingerprint || "",
		config.otaEmailFallbackGraceMs || "",
		config.otaEmailFallbackLeaseMs || "",
		config.otaEmailFallbackProofTtlMs || "",
		config.otaEmailFallbackMaxAttempts || "",
	].join(":");

const getHotelRunnerFirstFallbackCoordinator = (config) => {
	const key = hotelRunnerFirstFallbackCoordinatorKey(config);
	if (
		hotelRunnerFirstFallbackCoordinatorCache &&
		hotelRunnerFirstFallbackCoordinatorCacheKey === key
	) {
		return hotelRunnerFirstFallbackCoordinatorCache;
	}
	const coordinator = createHotelRunnerFirstOtaFallbackCoordinator({
		config,
		graceMs: config.otaEmailFallbackGraceMs,
		leaseMs: config.otaEmailFallbackLeaseMs,
		negativeProofTtlMs: config.otaEmailFallbackProofTtlMs,
		maxAttempts: config.otaEmailFallbackMaxAttempts,
	});
	hotelRunnerFirstFallbackCoordinatorCache = coordinator;
	hotelRunnerFirstFallbackCoordinatorCacheKey = key;
	return coordinator;
};

const resetHotelRunnerFirstFallbackCoordinatorForTests = () => {
	hotelRunnerFirstFallbackCoordinatorCache = null;
	hotelRunnerFirstFallbackCoordinatorCacheKey = "";
};

const hasSourceBackedHotelIdentity = (normalized = {}) => {
	const presence =
		normalized.sourcePresence && typeof normalized.sourcePresence === "object"
			? normalized.sourcePresence
			: {};
	return (
		presence.hotelName === true &&
		Boolean(String(normalized.hotelId || normalized.hotelName || "").trim())
	);
};

const buildHotelRunnerResolvedHotelProof = (hotel = {}) => {
	const value = hotel || {};
	return {
		version: 1,
		hotelId: normalizedObjectId(value._id),
		belongsTo: normalizedObjectId(value.belongsTo),
		currency: String(value.currency || "SAR").trim().toUpperCase(),
		activateHotel: value.activateHotel === true,
		xHotelProActive: value.xHotelProActive !== false,
	};
};

const hotelRunnerFirstPreliminaryGate = ({
	normalized = {},
	inboundRecord,
	config,
} = {}) => {
	const parsedProvider = canonicalProvider(normalized.provider);
	const transportProvider = canonicalInboundTransportProvider(
		normalized.trustedTransportProvider
	);
	const authentication =
		inboundRecord?.senderAuthentication || normalized.senderAuthentication || {};
	const authenticatedProvider = canonicalInboundTransportProvider(
		authentication.trustedProvider
	);
	const authenticatedAligned = !!(
		normalized.sourceSenderAuthenticated === true &&
		normalized.sourceSenderTrusted === true &&
		authentication.authenticatedAligned === true
	);
	const authenticatedHotelRunnerTransport = !!(
		authenticatedAligned &&
		transportProvider === "hotelrunner" &&
		authenticatedProvider === "hotelrunner"
	);
	const directTransport = !!(
		authenticatedAligned &&
		DIRECT_OTA_PROVIDERS.has(parsedProvider) &&
		transportProvider === parsedProvider &&
		authenticatedProvider === parsedProvider
	);
	const embeddedProviders = Array.from(
		new Set(
			(Array.isArray(normalized.hotelRunnerCommercialSourceProviders)
				? normalized.hotelRunnerCommercialSourceProviders
				: []
			)
				.map(canonicalProvider)
				.filter((provider) => DIRECT_OTA_PROVIDERS.has(provider))
		)
	);
	const embeddedProvider =
		embeddedProviders.length === 1 ? embeddedProviders[0] : "";
	const hotelRunnerRelay = !!(
		authenticatedAligned &&
		transportProvider === "hotelrunner" &&
		authenticatedProvider === "hotelrunner" &&
		embeddedProvider &&
		(!DIRECT_OTA_PROVIDERS.has(parsedProvider) ||
			parsedProvider === embeddedProvider) &&
		normalized.hotelRunnerBookingSourceConflict !== true &&
		normalized.hotelRunnerTripIdentityConflict !== true &&
		normalized.hotelRunnerNonTripIdentityConflict !== true &&
		normalized.hotelRunnerProviderSpecificBookingIdConflict !== true
	);
	// HotelRunner transport is evidence for the private inbound audit only. This
	// branch is intentionally independent of every HotelRunner API feature flag:
	// disabling the integration must never make a relay fall through to ordinary
	// OTA reconciliation. Even an incomplete/conflicting relay is terminally
	// audit-only; only a directly authenticated OTA transport may create or mutate.
	if (authenticatedHotelRunnerTransport) {
		const provider = hotelRunnerRelay ? embeddedProvider : "hotelrunner";
		return {
			eligible: true,
			provider,
			handlingMode: "hotelrunner_relay_audit_only",
			queueAvailable: false,
			queueUnavailableReason: "",
			normalizedReservation: normalized,
		};
	}
	if (!directTransport) {
		return { eligible: false, reason: "not_authenticated_direct_ota" };
	}
	if (config?.integrationEnabled !== true) {
		return { eligible: false, reason: "hotelrunner_integration_disabled" };
	}
	const provider = parsedProvider;
	const handlingMode = "direct_ota_queue";
	if (
		String(normalized.intent || "").trim().toLowerCase() !== "new_reservation" ||
		String(normalized.eventType || "").trim().toLowerCase() !== "new"
	) {
		return { eligible: false, reason: "not_new_reservation" };
	}
	const sourcePresence = normalized.sourcePresence || {};
	if (
		!String(normalized.confirmationNumber || normalized.reservationId || "").trim() ||
		(sourcePresence.confirmationNumber !== true &&
			sourcePresence.reservationId !== true)
	) {
		return { eligible: false, reason: "confirmation_not_source_backed" };
	}
	if (!hasSourceBackedHotelIdentity(normalized)) {
		return { eligible: false, reason: "hotel_not_source_backed" };
	}
	if (!ObjectId.isValid(String(config?.hotelId || "").trim())) {
		return { eligible: false, reason: "hotelrunner_property_not_configured" };
	}
	const queueAvailable = !!(
		config?.configured === true && config?.projectionEnabled === true
	);
	return {
		eligible: true,
		provider,
		handlingMode,
		queueAvailable,
		queueUnavailableReason: queueAvailable
			? ""
			: "hotelrunner_projection_unavailable",
		normalizedReservation: normalized,
	};
};

const resolveHotelRunnerFirstInboundEligibility = async (
	{ normalized = {}, inboundRecord, config = getHotelRunnerConfig() } = {},
	{ resolveHotelDetails = resolveHotel } = {}
) => {
	const preliminary = hotelRunnerFirstPreliminaryGate({
		normalized,
		inboundRecord,
		config,
	});
	if (!preliminary.eligible) return preliminary;
	if (preliminary.handlingMode === "hotelrunner_relay_audit_only") {
		let hotel = null;
		if (hasSourceBackedHotelIdentity(normalized)) {
			hotel = await resolveHotelDetails(normalized);
			if (
				hotel &&
				(hotel.activateHotel !== true ||
					hotel.xHotelProActive === false ||
					!normalizedObjectId(hotel.belongsTo))
			) {
				hotel = null;
			}
		}
		return { ...preliminary, hotel };
	}
	const hotel = await resolveHotelDetails(normalized);
	if (!hotel) return { eligible: false, reason: "hotel_not_resolved" };
	if (normalizedObjectId(hotel._id) !== normalizedObjectId(config.hotelId)) {
		return { eligible: false, reason: "different_hotelrunner_property" };
	}
	if (
		hotel.activateHotel !== true ||
		hotel.xHotelProActive === false ||
		!normalizedObjectId(hotel.belongsTo)
	) {
		return { eligible: false, reason: "hotelrunner_property_not_active" };
	}
	return {
		eligible: true,
		provider: preliminary.provider,
		handlingMode: preliminary.handlingMode,
		queueAvailable: preliminary.queueAvailable,
		queueUnavailableReason: preliminary.queueUnavailableReason,
		normalizedReservation: preliminary.normalizedReservation,
		hotel,
	};
};

const markHotelRunnerFirstFallbackAudit = async (recordId, fields = {}) =>
	InboundEmail.findByIdAndUpdate(
		recordId,
		{ $set: fields },
		{ new: true }
	)
		.lean()
		.exec();

const buildHotelRunnerAwaitingReconciliation = ({
	hotel,
	normalized,
} = {}) => ({
	status: "awaiting_hotelrunner",
	actionTaken: "queued",
	skipReason: "",
	automationComment:
		"Authenticated direct-OTA reservation was archived for HotelRunner-first processing.",
	reservationId: null,
	hotelId: hotel?._id || null,
	pmsConfirmationNumber: "",
	provider: canonicalProvider(normalized?.provider),
	confirmationNumber:
		normalized?.confirmationNumber || normalized?.reservationId || "",
	warnings: [],
	errors: [],
	hotelRunnerFirst: true,
});

const buildHotelRunnerRelayAuditOnlyReconciliation = ({
	hotel,
	normalized,
	provider,
} = {}) => ({
	status: "needs_review",
	actionTaken: "skipped",
	skipReason: "hotelrunner_relay_audit_only",
	automationComment:
		"Authenticated HotelRunner transport was archived for audit only; it cannot create, price, or mutate a reservation.",
	reservationId: null,
	hotelId: hotel?._id || null,
	pmsConfirmationNumber: "",
	provider,
	confirmationNumber:
		normalized?.confirmationNumber || normalized?.reservationId || "",
	warnings: [],
	errors: [],
	hotelRunnerFirst: true,
	hotelRunnerRelayAuditOnly: true,
});

const archiveAndEnqueueHotelRunnerFirstInbound = async (
	{
		inboundRecord,
		email,
		normalized,
		orchestration,
		config = getHotelRunnerConfig(),
	} = {},
	dependencies = {}
) => {
	const eligibility = await resolveHotelRunnerFirstInboundEligibility(
		{ normalized, inboundRecord, config },
		{ resolveHotelDetails: dependencies.resolveHotelDetails || resolveHotel }
	);
	if (!eligibility.eligible) return { handled: false, eligibility };

	const persistAudit = dependencies.persistAudit || finalizeRecord;
	if (eligibility.handlingMode === "hotelrunner_relay_audit_only") {
		const reconciliation = buildHotelRunnerRelayAuditOnlyReconciliation({
			hotel: eligibility.hotel,
			normalized,
			provider: eligibility.provider,
		});
		const audited = await persistAudit(inboundRecord._id, {
			provider: eligibility.provider,
			providerLabel: normalized.providerLabel || "HotelRunner",
			intent: normalized.intent || "unknown",
			eventType: normalized.eventType || "unknown",
			processingStatus: "hotelrunner_relay_audit_only",
			confirmationNumber:
				normalized.confirmationNumber || normalized.reservationId || "",
			hotelName: normalized.hotelName || "",
			roomName: normalized.roomName || "",
			...buildInboundExtractionFields(normalized, reconciliation),
			hotelId: eligibility.hotel?._id || null,
			reservationMongoId: null,
			normalizedReservation: normalized,
			emailContext: orchestration.emailContext || {},
			orchestratorDecision: orchestration.decision || {},
			reconciliation,
			parseWarnings: normalized.warnings || [],
			parseErrors: normalized.errors || [],
			reconcileWarnings: [],
			reconcileErrors: [],
			safeSnippet:
				orchestration.safeSnippet ||
				safeSnippet(`${email?.subject || ""}\n${email?.text || ""}`, 800),
			hotelRunnerFirstFallback: {
				eligible: false,
				status: "hotelrunner_relay_audit_only",
				archiveReadyAt: new Date(),
				enqueueAttemptedAt: null,
				queuedAt: null,
				jobId: null,
				collision: false,
				lastErrorCode: "",
				lastErrorMessage: "",
				resolvedHotelProof: eligibility.hotel
					? buildHotelRunnerResolvedHotelProof(eligibility.hotel)
					: null,
			},
		});
		if (!audited?._id) {
			const error = new Error(
				"The HotelRunner relay audit could not be persisted safely."
			);
			error.code = "HOTELRUNNER_RELAY_AUDIT_PERSIST_FAILED";
			throw error;
		}
		return {
			handled: true,
			eligibility,
			reconciliation,
			record: audited,
			relayAuditOnly: true,
			queuedResult: null,
			collision: false,
		};
	}

	const archiveReadyAt = new Date();
	const reconciliation = buildHotelRunnerAwaitingReconciliation({
		hotel: eligibility.hotel,
		normalized,
	});
	const queueUnavailable = eligibility.queueAvailable !== true;
	const queueUnavailableError = queueUnavailable
		? Object.assign(
				new Error(
					"HotelRunner-first projection is unavailable for the configured property; the archived OTA email was held without inline reservation mutation."
				),
				{
					code: "HOTELRUNNER_FIRST_PROJECTION_UNAVAILABLE",
					retryable: true,
				}
			)
		: null;
	const archived = await persistAudit(inboundRecord._id, {
		provider: eligibility.provider,
		providerLabel: normalized.providerLabel || "",
		intent: "new_reservation",
		eventType: "new",
		processingStatus: "awaiting_hotelrunner",
		confirmationNumber:
			normalized.confirmationNumber || normalized.reservationId || "",
		hotelName: normalized.hotelName || "",
		roomName: normalized.roomName || "",
		...buildInboundExtractionFields(normalized, reconciliation),
		hotelId: eligibility.hotel._id,
		reservationMongoId: null,
		normalizedReservation: normalized,
		emailContext: orchestration.emailContext || {},
		orchestratorDecision: orchestration.decision || {},
		reconciliation,
		parseWarnings: normalized.warnings || [],
		parseErrors: normalized.errors || [],
		reconcileWarnings: [],
		reconcileErrors: [],
		safeSnippet:
			orchestration.safeSnippet ||
			safeSnippet(`${email?.subject || ""}\n${email?.text || ""}`, 800),
		hotelRunnerFirstFallback: {
			eligible: true,
			status: queueUnavailable ? "recovery_pending" : "archive_ready",
			archiveReadyAt,
			enqueueAttemptedAt: queueUnavailable ? archiveReadyAt : null,
			queuedAt: null,
			jobId: null,
			collision: false,
			lastErrorCode: queueUnavailable
				? queueUnavailableError.code
				: "",
			lastErrorMessage: queueUnavailable
				? queueUnavailableError.message
				: "",
			resolvedHotelProof: buildHotelRunnerResolvedHotelProof(
				eligibility.hotel
			),
		},
	});
	if (!archived?._id) {
		const error = new Error(
			"The normalized OTA inbound audit could not be persisted before queueing."
		);
		error.code = "HOTELRUNNER_FALLBACK_ARCHIVE_PERSIST_FAILED";
		throw error;
	}
	if (queueUnavailable) {
		return {
			handled: true,
			eligibility,
			reconciliation,
			record: archived,
			enqueueError: queueUnavailableError,
			errorCode: queueUnavailableError.code,
			errorMessage: queueUnavailableError.message,
		};
	}

	const enqueueAttemptedAt = new Date();
	const markAudit = dependencies.markAudit || markHotelRunnerFirstFallbackAudit;
	try {
		const enqueueArchivedEmail =
			dependencies.enqueueArchivedEmail ||
			getHotelRunnerFirstFallbackCoordinator(config).enqueueArchivedEmail;
		const queuedResult = await enqueueArchivedEmail({
			inboundEmailId: String(archived._id),
			hotelId: String(eligibility.hotel._id),
			provider: eligibility.provider,
			confirmationNumber:
				normalized.confirmationNumber || normalized.reservationId || "",
		});
		const jobId = normalizedObjectId(queuedResult?.job?._id);
		const collision = queuedResult?.collision === true;
		const markerFields = {
			"hotelRunnerFirstFallback.status": collision
				? "identity_collision"
				: "enqueued",
			"hotelRunnerFirstFallback.enqueueAttemptedAt": enqueueAttemptedAt,
			"hotelRunnerFirstFallback.queuedAt": new Date(),
			"hotelRunnerFirstFallback.jobId": jobId || null,
			"hotelRunnerFirstFallback.collision": collision,
			"hotelRunnerFirstFallback.lastErrorCode": "",
			"hotelRunnerFirstFallback.lastErrorMessage": "",
		};
		if (collision) {
			markerFields.processingStatus = "needs_review";
			markerFields.reconciliation = {
				...reconciliation,
				status: "needs_review",
				actionTaken: "skipped",
				skipReason: "hotelrunner_fallback_identity_collision",
				automationComment:
					"The HotelRunner-first queue found a conflicting archived email for this OTA identity.",
				errors: [
					"A conflicting archived OTA email already owns this HotelRunner fallback identity.",
				],
			};
			markerFields.reconcileErrors = markerFields.reconciliation.errors;
		}
		const marked = await markAudit(archived._id, markerFields).catch((error) => {
			console.error(
				"[ota-inbound] HotelRunner-first queue marker update failed safely:",
				error.message
			);
			return null;
		});
		return {
			handled: true,
			eligibility,
			reconciliation: collision
				? markerFields.reconciliation
				: reconciliation,
			record: marked || archived,
			queuedResult,
			collision,
		};
	} catch (error) {
		const errorCode = String(
			error?.code || "HOTELRUNNER_FALLBACK_ENQUEUE_FAILED"
		).slice(0, 140);
		const errorMessage = safeHotelRunnerFallbackError(error);
		const marked = await markAudit(archived._id, {
			"hotelRunnerFirstFallback.status": "recovery_pending",
			"hotelRunnerFirstFallback.enqueueAttemptedAt": enqueueAttemptedAt,
			"hotelRunnerFirstFallback.lastErrorCode": errorCode,
			"hotelRunnerFirstFallback.lastErrorMessage": errorMessage,
		}).catch(() => null);
		return {
			handled: true,
			eligibility,
			reconciliation,
			record: marked || archived,
			enqueueError: error,
			errorCode,
		};
	}
};

const buildForwardDecisionAudit = (decision = {}) => ({
	shouldForward: !!decision.shouldForward,
	reason: String(decision.reason || "").toLowerCase(),
	categories: Array.isArray(decision.categories) ? decision.categories : [],
	matchedTerms: Array.isArray(decision.matchedTerms) ? decision.matchedTerms : [],
	linkCount: Number(decision.linkCount || 0),
	status: String(decision.status || "").toLowerCase(),
});

const persistForwardingResult = async (recordId, result = {}) => {
	if (!recordId || !result?.decision || !result?.forwarding) return null;
	return InboundEmail.findByIdAndUpdate(
		recordId,
		{
			$set: {
				forwardDecision: buildForwardDecisionAudit(result.decision),
				forwarding: result.forwarding,
			},
		},
		{ new: true }
	)
		.lean()
		.exec();
};

const handleImportantInboundForwarding = async ({
	req,
	record,
	email,
	normalized,
	reconciliation,
} = {}) => {
	if (!record?._id || !email) return record || null;
	const result = await forwardImportantInboundEmail({
		email,
		inboundRecord: record,
		normalized,
		reconciliation,
	});
	const updated = await persistForwardingResult(record._id, result);
	if (result?.decision?.shouldForward) {
		logInbound("forwarding.checked", {
			inboundEmailId: String(record._id),
			shouldForward: true,
			reason: result.decision.reason || "",
			categories: result.decision.categories || [],
			forwardingStatus: result.forwarding?.status || "",
			forwardedTo: result.forwarding?.forwardedTo || [],
			error: result.forwarding?.error || "",
		});
		emitInboundEmailUpdated(req, updated || record, {
			forwardingStatus: result.forwarding?.status || "",
			forwardReason: result.decision.reason || "",
		});
	}
	return updated || record;
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
	if (reconciliation.otaPlatformReviewStatus === OTA_PLATFORM_REVIEW_PENDING) {
		emitPlatformNotificationRefresh(req, {
			type: "ota_reservation_pending",
			reservationId: reconciliation.reservationId,
			hotelId: reconciliation.hotelId,
			ownerId: reconciliation.ownerId,
		});
		return;
	}
	await emitHotelNotificationRefresh(req, reconciliation.hotelId, {
		type: "reservation_update",
		reservationId: reconciliation.reservationId,
		ownerId: reconciliation.ownerId,
	});
};

const archiveRawMimeParserResourceLimitInbound = async (req, email = {}) => {
	const record = await createInboundEmailRecord(email);
	const normalized = {
		...extractNormalizedReservation({
			...email,
			text: "",
			html: "",
			otaInboundParserResourceLimitExceeded: true,
		}),
		otaInboundParserResourceLimitExceeded: true,
		inboundEmailId: String(record._id),
	};
	const resourceLimitMessage =
		"Raw MIME exceeded the bounded pre-parser budget; body parsing and all reservation lookup or mutation were disabled.";
	const reconciliation = {
		status: "needs_review",
		actionTaken: "skipped",
		skipReason: "ota_inbound_parser_resource_limit",
		automationComment: resourceLimitMessage,
		warnings: [
			...(normalized.warnings || []),
			...(normalized.manualReviewReasons || []),
		],
		errors: [...(normalized.errors || []), resourceLimitMessage],
		reservationId: null,
		hotelId: null,
		pmsConfirmationNumber: "",
		matchedReservationBy: [],
	};
	const updated = await finalizeRecord(record._id, {
		processingStatus: reconciliation.status,
		provider: normalized.provider || "",
		providerLabel: normalized.providerLabel || "",
		intent: normalized.intent || "",
		eventType: normalized.eventType || "",
		confirmationNumber: normalized.confirmationNumber || "",
		hotelName: normalized.hotelName || "",
		roomName: "",
		...buildInboundExtractionFields(normalized, reconciliation),
		hotelId: null,
		reservationMongoId: null,
		normalizedReservation: normalized,
		emailContext: {
			rawMimeResourceLimitExceeded: true,
			rawMimeByteLength: Number(email.rawMimeByteLength || 0),
			rawMimePreparserMaxBytes: Number(
				email.rawMimePreparserMaxBytes || RAW_MIME_PREPARSER_MAX_BYTES
			),
		},
		orchestratorDecision: {
			usedAI: false,
			skipped: true,
			skipReason: "ota_inbound_parser_resource_limit",
			reason: resourceLimitMessage,
		},
		reconciliation,
		parseWarnings: reconciliation.warnings,
		parseErrors: reconciliation.errors,
		reconcileWarnings: reconciliation.warnings,
		reconcileErrors: reconciliation.errors,
		safeSnippet: safeSnippet(email.subject || "", 800),
	});
	emitInboundEmailUpdated(req, updated || record, {
		processingStatus: reconciliation.status,
		provider: normalized.provider || "",
		intent: normalized.intent || "",
		confirmationNumber: normalized.confirmationNumber || "",
	});
	return { record, updated: updated || record, normalized, reconciliation };
};

exports.handleSendGridInbound = async (req, res) => {
	let inboundRecord = null;
	let parsedEmail = null;
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
		parsedEmail = email;
		logInbound("payload.parsed", {
			from: email.from,
			to: email.to,
			subject: email.subject,
			messageId: email.messageId,
			rawHash: shortHash(email.rawHash),
			senderAuthenticated:
				email.senderAuthentication?.authenticatedAligned === true,
			senderAuthenticationMethod:
				email.senderAuthentication?.method || "",
			senderAuthenticationReason:
				email.senderAuthentication?.reason || "",
			sourceTimestampMethod: email.sourceTimestampMethod || "",
			attachments: (email.attachments || []).map((attachment) => ({
				filename: attachment.filename,
				contentType: attachment.contentType,
				size: attachment.size,
			})),
		});

		if (email.otaInboundParserResourceLimitExceeded === true) {
			const guarded = await archiveRawMimeParserResourceLimitInbound(req, email);
			inboundRecord = guarded.updated;
			logInbound("payload.raw_mime_resource_limit", {
				inboundEmailId: String(guarded.record._id),
				provider: guarded.normalized.provider || "",
				intent: guarded.normalized.intent || "",
				confirmationNumber: guarded.normalized.confirmationNumber || "",
				rawMimeByteLength: Number(email.rawMimeByteLength || 0),
				rawMimePreparserMaxBytes: RAW_MIME_PREPARSER_MAX_BYTES,
				reservationAutomationSkipped: true,
			});
			return res.status(200).send("OK");
		}

		const preliminaryHash = email.hasRawMime ? email.rawHash : "";
		const dedupeKey = buildInboundDedupeKey(email);
		let duplicate = await findProcessedDuplicate(
			preliminaryHash,
			email.messageId
		);
		let duplicateSource = duplicate ? "processed_precheck" : "";
		logInbound("duplicate.checked", {
			emailHash: shortHash(preliminaryHash),
			messageId: email.messageId,
			isDuplicate: !!duplicate,
			duplicateStatus: duplicate?.processingStatus || "",
			duplicateId: duplicate?._id ? String(duplicate._id) : "",
		});

		if (duplicate) {
			inboundRecord = await createInboundEmailRecord(email, { duplicate });
		} else {
			if (dedupeKey) await ensureInboundDedupeIndex();
			const claim = await createWithDedupeClaim(email, dedupeKey);
			inboundRecord = claim.inboundRecord;
			duplicate = claim.duplicate;
			duplicateSource = claim.duplicateSource;
			if (claim.reclaimedFrom) {
				logInbound("dedupe.claim_reclaimed", {
					inboundEmailId: String(inboundRecord._id),
					reclaimedFrom: String(claim.reclaimedFrom._id),
					previousStatus: claim.reclaimedFrom.processingStatus || "",
				});
			}
			if (duplicate) {
				logInbound("duplicate.claim_collision", {
					inboundEmailId: String(inboundRecord._id),
					duplicateId: String(duplicate._id),
					duplicateStatus: duplicate.processingStatus || "",
				});
			}
		}
		logInbound("audit.saved", {
			inboundEmailId: String(inboundRecord._id),
			duplicateOf: duplicate?._id ? String(duplicate._id) : "",
			claimStatus: duplicateSource || (dedupeKey ? "claimed" : "unavailable"),
		});

		if (duplicate) {
			const normalized = buildNormalizedFromDuplicateRecord(duplicate);
			normalized.inboundEmailId = String(inboundRecord._id);
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
				matchedReservationBy: [
					duplicateSource === "atomic_claim"
						? "dedupe_key"
						: "email_hash_or_message_id",
				],
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
				emailContext: {
					duplicateOf: String(duplicate._id),
					duplicatePrecheck: duplicateSource === "processed_precheck",
					duplicateAtomicClaim: duplicateSource === "atomic_claim",
				},
				orchestratorDecision: {
					usedAI: false,
					skipped: true,
					skipReason:
						duplicateSource === "atomic_claim"
							? "duplicate_email_atomic_claim"
							: "duplicate_email_precheck",
				},
				reconciliation: duplicateReconciliation,
				parseWarnings: [],
				parseErrors: [],
				safeSnippet: safeSnippet(buildRedactedEmailText(email), 800),
			});
			logInbound("duplicate.audited", {
				inboundEmailId: String(inboundRecord._id),
				duplicateOf: String(duplicate._id),
				provider: normalized.provider,
				intent: normalized.intent,
				confirmationNumber: normalized.confirmationNumber,
				orchestrationSkipped: true,
			});
			emitInboundEmailUpdated(req, updated || inboundRecord);
			if (shouldRetryInboundCollision(duplicate, duplicateSource)) {
				res.set("Retry-After", "30");
				return res.status(503).send("Inbound delivery is still processing");
			}
			return res.status(200).send("OK");
		}

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

		const hotelRunnerFirst = await archiveAndEnqueueHotelRunnerFirstInbound({
			inboundRecord,
			email,
			normalized,
			orchestration,
		});
		if (hotelRunnerFirst.handled) {
			const queuedRecord = hotelRunnerFirst.record || inboundRecord;
			if (hotelRunnerFirst.relayAuditOnly) {
				logInbound("hotelrunner_relay.audit_only", {
					inboundEmailId: String(inboundRecord._id),
					hotelId: normalizedObjectId(
						hotelRunnerFirst.eligibility?.hotel?._id
					),
					provider: hotelRunnerFirst.eligibility?.provider || "",
					confirmationNumber: normalized.confirmationNumber || "",
				});
				emitInboundEmailUpdated(req, queuedRecord, {
					processingStatus: "hotelrunner_relay_audit_only",
					provider: hotelRunnerFirst.eligibility?.provider || "",
					intent: normalized.intent,
					confirmationNumber: normalized.confirmationNumber,
					hotelId: hotelRunnerFirst.eligibility?.hotel?._id,
				});
				// HotelRunner transport is intentionally private audit evidence only.
				// Do not turn its terminal audit status into a needs-review forwarding
				// alert: direct OTA transport is the sole reservation/notification input.
				return res.status(200).send("OK");
			}
			if (hotelRunnerFirst.enqueueError) {
				logInbound("hotelrunner_first.enqueue_failed", {
					inboundEmailId: String(inboundRecord._id),
					hotelId: normalizedObjectId(hotelRunnerFirst.eligibility?.hotel?._id),
					provider: normalized.provider || "",
					confirmationNumber: normalized.confirmationNumber || "",
					errorCode: hotelRunnerFirst.errorCode || "",
				});
				emitInboundEmailUpdated(req, queuedRecord, {
					processingStatus: "awaiting_hotelrunner",
					provider: normalized.provider,
					intent: normalized.intent,
					confirmationNumber: normalized.confirmationNumber,
					hotelId: hotelRunnerFirst.eligibility?.hotel?._id,
				});
				// The complete normalized audit remains the durable recovery input and
				// retains its dedupe claim. A transient 503 asks SendGrid to retry while
				// the HotelRunner worker can also recover the orphaned archive.
				res.set("Retry-After", "60");
				return res
					.status(503)
					.send("HotelRunner-first inbound queue is temporarily unavailable");
			}

			logInbound("hotelrunner_first.queued", {
				inboundEmailId: String(inboundRecord._id),
				jobId: normalizedObjectId(hotelRunnerFirst.queuedResult?.job?._id),
				hotelId: normalizedObjectId(hotelRunnerFirst.eligibility?.hotel?._id),
				provider: normalized.provider || "",
				confirmationNumber: normalized.confirmationNumber || "",
				collision: hotelRunnerFirst.collision === true,
			});
			emitInboundEmailUpdated(req, queuedRecord, {
				processingStatus: hotelRunnerFirst.reconciliation.status,
				provider: normalized.provider,
				intent: normalized.intent,
				confirmationNumber: normalized.confirmationNumber,
				hotelId: hotelRunnerFirst.eligibility?.hotel?._id,
			});
			const response = res.status(200).send("OK");
			// Important-email forwarding is independent of reservation creation. It
			// may run after acceptance, but reservation refresh and creation WhatsApp
			// notifications must wait for the background coordinator's final result.
			void handleImportantInboundForwarding({
				req,
				record: queuedRecord,
				email,
				normalized,
				reconciliation: hotelRunnerFirst.reconciliation,
			}).catch((error) =>
				console.error(
					"[SendGrid Inbound] queued-email forwarding failed safely:",
					error.message
				)
			);
			return response;
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
		await handleImportantInboundForwarding({
			req,
			record: updated || inboundRecord,
			email,
			normalized,
			reconciliation,
		});

		console.log("[SendGrid Inbound]", {
			status: reconciliation.status,
			provider: normalized.provider,
			intent: normalized.intent,
			confirmationNumber: normalized.confirmationNumber,
			subject: email.subject,
			at: new Date().toISOString(),
		});

		const response = res.status(200).send("OK");
		const airbnbWhatsappNotification = await notifyAirbnbOtaInboundWhatsapp({
			inboundRecord: updated || inboundRecord,
			email,
			normalized,
			reconciliation,
		}).catch((error) => {
			console.error(
				"[SendGrid Inbound] Airbnb WhatsApp notification failed safely:",
				error.message
			);
			return null;
		});
		if (airbnbWhatsappNotification?.attempted) {
			logInbound("airbnb_whatsapp.completed", {
				inboundEmailId: String(inboundRecord._id),
				status: airbnbWhatsappNotification.status,
				submittedCount: airbnbWhatsappNotification.submittedCount,
				failedCount: airbnbWhatsappNotification.failedCount,
				unknownCount: airbnbWhatsappNotification.unknownCount,
				skippedCount: airbnbWhatsappNotification.skippedCount,
				auditError: airbnbWhatsappNotification.auditError || "",
			});
			try {
				emitInboundEmailUpdated(
					req,
					airbnbWhatsappNotification.record || updated || inboundRecord,
					{
						airbnbWhatsappNotificationStatus:
							airbnbWhatsappNotification.status || "",
					}
				);
			} catch (error) {
				console.error(
					"[SendGrid Inbound] Airbnb WhatsApp socket update failed safely:",
					error.message
				);
			}
		}
		return response;
	} catch (err) {
		console.error("[SendGrid Inbound] error:", err.message);
		if (err?.code === INBOUND_DEDUPE_INDEX_UNAVAILABLE && !inboundRecord) {
			res.set("Retry-After", "60");
			return res.status(503).send("Inbound delivery safety is unavailable");
		}
		if (inboundRecord?._id) {
			const updated = await finalizeRecord(
				inboundRecord._id,
				{
					processingStatus: "failed",
					reconcileErrors: [err.message],
				},
				{ releaseDedupeClaim: true },
			).catch(() => null);
			await handleImportantInboundForwarding({
				req,
				record: updated || inboundRecord,
				email: parsedEmail,
				normalized: {},
				reconciliation: {
					status: "failed",
					errors: [err.message],
				},
			}).catch((forwardError) =>
				console.error("[SendGrid Inbound] forwarding failed:", forwardError.message)
			);
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
		res.set("Retry-After", "60");
		return res.status(503).send("Inbound delivery processing failed; retry later");
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
		if (req.query.shouldForward !== undefined) {
			query["forwardDecision.shouldForward"] =
				String(req.query.shouldForward).toLowerCase() === "true";
		}
		if (req.query.forwardingStatus) {
			query["forwarding.status"] = String(req.query.forwardingStatus).toLowerCase();
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
		const hotelScope = strictPlatformOtaHotelScopeFilter(
			req.inboundEmailViewer || {}
		);
		const scopedQuery = hotelScope ? { $and: [query, hotelScope] } : query;

		const [data, total] = await Promise.all([
			InboundEmail.find(scopedQuery)
				.select("-bodyText -bodyHtml -normalizedReservation")
				.sort({ receivedAt: -1 })
				.skip(skip)
				.limit(records)
				.lean()
				.exec(),
			InboundEmail.countDocuments(scopedQuery),
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
		const hotelScope = strictPlatformOtaHotelScopeFilter(
			req.inboundEmailViewer || {}
		);
		const emailFilter = hotelScope
			? { $and: [{ _id: inboundEmailId }, hotelScope] }
			: { _id: inboundEmailId };
		const email = await InboundEmail.findOne(emailFilter)
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

exports.releaseInboundEmailRetryClaim = async (req, res) => {
	try {
		const viewer = req.inboundEmailViewer || {};
		if (
			!configuredSuperAdminIds().includes(
				String(viewer._id || viewer.id || "").trim()
			)
		) {
			return res.status(403).json({ error: "SUPER ADMIN access required." });
		}
		const { inboundEmailId } = req.params;
		if (!ObjectId.isValid(inboundEmailId)) {
			return res.status(400).json({ error: "Invalid inbound email ID." });
		}
		const released = await InboundEmail.findOneAndUpdate(
			{
				_id: inboundEmailId,
				processingStatus: { $in: ["needs_review", "needs_mapping", "failed"] },
				dedupeKey: { $type: "string", $gt: "" },
			},
			{
				$unset: { dedupeKey: "" },
				$set: {
					processingStatus: "retry_ready",
					automationAction: "skipped",
					skipReason: "manual_retry_claim_released",
					automationComment:
						"SUPER ADMIN released the delivery claim for a controlled re-delivery after parser or mapping review.",
					processedAt: new Date(),
				},
			},
			{ new: true }
		)
			.select("_id processingStatus confirmationNumber subject receivedAt")
			.lean()
			.exec();
		if (!released) {
			return res.status(409).json({
				error:
					"Only failed or manual-review deliveries with an active claim can be prepared for retry.",
			});
		}
		return res.json({
			success: true,
			data: released,
			message:
				"The dedupe claim was released. Re-deliver the original email to process it again.",
		});
	} catch (error) {
		console.error("[inbound-emails] retry claim release failed:", error);
		return res.status(500).json({ error: "Could not release the retry claim." });
	}
};

// Focused exports keep the HotelRunner-first gate/order independently testable
// without exposing a production dependency-injection switch on the HTTP route.
exports.archiveAndEnqueueHotelRunnerFirstInbound =
	archiveAndEnqueueHotelRunnerFirstInbound;
exports.hotelRunnerFirstPreliminaryGate = hotelRunnerFirstPreliminaryGate;
exports.resolveHotelRunnerFirstInboundEligibility =
	resolveHotelRunnerFirstInboundEligibility;
exports.resetHotelRunnerFirstFallbackCoordinatorForTests =
	resetHotelRunnerFirstFallbackCoordinatorForTests;
exports.duplicateBlockingEmailStatuses = [...duplicateBlockingEmailStatuses];
