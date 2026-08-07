/** @format */

"use strict";

require("dotenv").config();

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const mongoose = require("mongoose");

mongoose.set("strictQuery", true);

const InboundEmail = require("../models/inbound_email");
const Reservations = require("../models/reservations");
const {
	hasDirectHotelRunnerProjection,
} = require("../services/hotelrunnerOtaEmailBoundary");
const {
	buildOtaConfirmationLookup,
	canCreateUnmappedOtaReviewReservation,
	extractNormalizedReservation,
	hashText,
	otaInboundAllocationSafety,
	reconcileOtaReservation,
	requiredNewReservationMissing,
	trustedProviderFromSenderAddress,
} = require("../services/otaReservationMapper");

const TARGET = Object.freeze({
	auditId: "6a75ff6b8e82560c40d648d3",
	confirmationNumber: "hmzdmhqqre",
	provider: "airbnb",
	repairId: "airbnb-hmzdmhqqre-20260807-parser-recovery-v1",
});

const id = (value) => String(value?._id || value || "");

function parseArguments(argv = process.argv.slice(2)) {
	const apply = argv.includes("--apply");
	const repairIdIndex = argv.indexOf("--repair-id");
	const repairId =
		repairIdIndex >= 0 ? String(argv[repairIdIndex + 1] || "").trim() : "";
	const planHashIndex = argv.indexOf("--plan-hash");
	const planHash =
		planHashIndex >= 0 ? String(argv[planHashIndex + 1] || "").trim() : "";
	if (apply) {
		assert.equal(
			repairId,
			TARGET.repairId,
			`--apply requires --repair-id ${TARGET.repairId}`
		);
		assert.match(planHash, /^[a-f0-9]{64}$/, "--apply requires the dry-run plan hash.");
	}
	return { apply, repairId, planHash };
}

function emailFromAudit(audit = {}) {
	const priorSource = audit.normalizedReservation?.source || {};
	const subject = String(audit.subject || "").replace(/\r/g, "").trim();
	const storedBody = String(audit.bodyText || "").replace(/\r/g, "");
	const text = storedBody.startsWith(`${subject}\n`)
		? storedBody.slice(subject.length + 1)
		: storedBody;
	return {
		from: audit.from || "",
		to: audit.to || "",
		cc: audit.cc || "",
		bcc: audit.bcc || "",
		subject: audit.subject || "",
		text,
		html: audit.bodyHtml || "",
		messageId: audit.messageId || "",
		receivedAt: audit.receivedAt,
		sourceReceivedAt: priorSource.receivedAt || audit.receivedAt,
		sourceTimestampMethod: priorSource.timestampMethod || "",
		senderAuthentication: audit.senderAuthentication || {},
	};
}

function assertTargetAudit(audit) {
	assert.ok(audit, `Missing inbound audit ${TARGET.auditId}`);
	assert.equal(id(audit._id), TARGET.auditId, "Inbound audit ID changed.");
	assert.equal(audit.provider, TARGET.provider, "Inbound provider changed.");
	assert.equal(audit.source, "sendgrid", "Inbound source changed.");
	assert.ok(!audit.duplicateOf, "The target is unexpectedly a duplicate audit.");
	assert.notEqual(audit.emailContext?.forwarded, true, "Forwarded mail cannot mutate PMS data.");
	assert.equal(
		audit.confirmationNumber,
		TARGET.confirmationNumber,
		"Inbound confirmation changed."
	);
	assert.equal(
		audit.senderAuthentication?.authenticatedAligned,
		true,
		"The direct Airbnb delivery is no longer authenticated."
	);
	assert.equal(
		audit.senderAuthentication?.trustedProvider,
		TARGET.provider,
		"The authenticated sender is no longer aligned to Airbnb."
	);
	assert.equal(
		trustedProviderFromSenderAddress(audit.from || ""),
		TARGET.provider,
		"The stored From mailbox is not a direct trusted Airbnb mailbox."
	);
	assert.equal(
		audit.normalizedReservation?.sourceSenderAuthenticated,
		true,
		"The original normalized audit no longer records aligned authentication."
	);
	assert.ok(audit.textHash, "Stored audit text hash is missing.");
	assert.ok(Number.isInteger(audit.__v), "Stored audit version is missing.");
	assert.equal(
		hashText(audit.bodyText || ""),
		audit.textHash,
		"Stored redacted body no longer matches its immutable text hash."
	);
}

function normalizeTargetAudit(audit) {
	const normalized = extractNormalizedReservation(emailFromAudit(audit));
	normalized.inboundEmailId = TARGET.auditId;
	assert.equal(normalized.provider, TARGET.provider, "Parser provider mismatch.");
	assert.equal(
		normalized.confirmationNumber,
		TARGET.confirmationNumber,
		"Parser confirmation mismatch."
	);
	assert.equal(normalized.intent, "new_reservation", "Expected a new booking.");
	assert.equal(normalized.eventType, "new", "Expected a new-booking event.");
	assert.equal(
		normalized.sourceSenderAuthenticated,
		true,
		"Stored delivery authentication was not preserved."
	);
	assert.equal(
		normalized.requiresManualReview,
		false,
		"The production-shaped Airbnb message still fails parser validation."
	);
	assert.deepEqual(
		normalized.genericRepeatedFactConflictFields || [],
		[],
		"The false repeated-date conflict is not fixed."
	);
	assert.equal(
		canCreateUnmappedOtaReviewReservation(normalized, true),
		true,
		"The booking cannot be isolated safely in OTA Platform Review."
	);
	assert.deepEqual(
		requiredNewReservationMissing(normalized),
		["source-backed hotel/property"],
		"Unexpected required booking facts are missing."
	);
	assert.equal(normalized.checkinDate, "2026-08-09", "Check-in changed.");
	assert.equal(normalized.checkoutDate, "2026-08-14", "Checkout changed.");
	assert.ok(Number(normalized.totalAmountSar) > 0, "Guest total is missing.");
	assert.equal(
		Number(normalized.totalAmountSar),
		Number(audit.normalizedReservation?.totalAmountSar),
		"Source-backed guest total changed during deterministic reparse."
	);
	for (const field of [
		"confirmationNumber",
		"guestName",
		"roomName",
		"checkinDate",
		"checkoutDate",
		"amount",
		"totalGuests",
	]) {
		assert.equal(
			normalized.sourcePresence?.[field],
			true,
			`${field} is no longer source-backed.`
		);
	}
	assert.equal(
		otaInboundAllocationSafety(normalized).ok,
		true,
		"The booking exceeds inbound allocation safety limits."
	);
	return normalized;
}

function buildPlanHash(audit, normalized) {
	return crypto
		.createHash("sha256")
		.update(
			JSON.stringify({
				repairId: TARGET.repairId,
				auditId: TARGET.auditId,
				confirmationNumber: TARGET.confirmationNumber,
				messageId: audit.messageId || "",
				emailHash: audit.emailHash || "",
				textHash: audit.textHash || "",
				receivedAt: new Date(audit.receivedAt).toISOString(),
				updatedAt: new Date(audit.updatedAt).toISOString(),
				version: audit.__v,
				processingStatus: audit.processingStatus || "",
				skipReason: audit.skipReason || "",
				checkinDate: normalized.checkinDate,
				checkoutDate: normalized.checkoutDate,
				totalAmountSar: Number(normalized.totalAmountSar),
			})
		)
		.digest("hex");
}

async function exactReservations() {
	return Reservations.find(
		buildOtaConfirmationLookup(
			TARGET.confirmationNumber,
			TARGET.provider
		)
	)
		.select(
			"_id reservation_status hotelId confirmation_number otaIdentityKey otaPlatformReview supplierData checkin_date checkout_date total_amount"
		)
		.lean()
		.exec();
}

function assertRecoveredReservation(reservation, normalized) {
	assert.ok(reservation, "Recovered reservation is missing.");
	assert.equal(
		String(reservation.reservation_status || "").toLowerCase(),
		"ota platform review",
		"Recovered booking did not enter OTA Platform Review."
	);
	assert.equal(
		String(reservation.otaPlatformReview?.status || "").toLowerCase(),
		"pending",
		"Recovered booking is not pending staff release."
	);
	assert.equal(
		String(reservation.supplierData?.otaProvider || "").toLowerCase(),
		TARGET.provider,
		"Recovered provider changed."
	);
	assert.equal(
		String(reservation.supplierData?.otaConfirmationNumber || "").toLowerCase(),
		TARGET.confirmationNumber,
		"Recovered OTA identity changed."
	);
	assert.equal(
		new Date(reservation.checkin_date).toISOString().slice(0, 10),
		normalized.checkinDate,
		"Recovered check-in changed."
	);
	assert.equal(
		new Date(reservation.checkout_date).toISOString().slice(0, 10),
		normalized.checkoutDate,
		"Recovered checkout changed."
	);
	assert.equal(
		Number(reservation.total_amount),
		Number(normalized.totalAmountSar),
		"Recovered guest total changed."
	);
}

function auditUpdate(normalized, reconciliation, reservation, processingStatus) {
	const createdFromThisAudit =
		id(reservation.supplierData?.otaInboundEmailId) === TARGET.auditId;
	return {
		provider: normalized.provider,
		providerLabel: normalized.providerLabel || "Airbnb",
		intent: normalized.intent,
		eventType: normalized.eventType,
		processingStatus,
		confirmationNumber: TARGET.confirmationNumber,
		pmsConfirmationNumber: reconciliation.pmsConfirmationNumber || "",
		hotelName: normalized.hotelName || "",
		roomName: normalized.roomName || "",
		sourceAmount: Number(normalized.amount || 0),
		sourceCurrency: normalized.currency || "",
		totalAmountSar: Number(normalized.totalAmountSar || 0),
		exchangeRateToSar: Number(normalized.exchangeRateToSar || 0),
		exchangeRateSource: normalized.exchangeRateSource || "",
		paymentCollectionModel: normalized.paymentCollectionModel || "",
		hotelId: reservation.hotelId || null,
		reservationMongoId: reservation._id,
		hasReservationConnection: true,
		matchedReservationBy: reconciliation.matchedReservationBy || [],
		automationAction: createdFromThisAudit ? "created" : "skipped",
		skipReason: createdFromThisAudit
			? ""
			: "duplicate_existing_reservation_no_update",
		automationComment: createdFromThisAudit
			? "Authenticated Airbnb booking recovered after the two-column stay-date parser fix and saved once in OTA Platform Review."
			: "The authenticated Airbnb audit was linked to the one exact existing reservation; no duplicate was created.",
		normalizedReservation: normalized,
		orchestratorDecision: {
			usedAI: false,
			skipped: true,
			skipReason: "deterministic_parser_recovery",
			repairId: TARGET.repairId,
		},
		reconciliation: {
			...reconciliation,
			repairId: TARGET.repairId,
			recoveredFromInboundAudit: true,
		},
		parseWarnings: normalized.warnings || [],
		parseErrors: normalized.errors || [],
		reconcileWarnings: reconciliation.warnings || [],
		reconcileErrors: reconciliation.errors || [],
		processedAt: new Date(),
	};
}

async function run(args = parseArguments()) {
	const database =
		process.env.DATABASE || process.env.MONGO_URI || process.env.MONGODB_URI;
	assert.ok(database, "Missing DATABASE/MONGO connection string.");
	await mongoose.connect(database, { autoIndex: false });

	const audit = await InboundEmail.findById(TARGET.auditId).lean();
	assertTargetAudit(audit);
	const normalized = normalizeTargetAudit(audit);
	const beforeMatches = await exactReservations();
	assert.ok(beforeMatches.length <= 1, "Duplicate Airbnb reservations already exist.");
	if (beforeMatches.length === 1) {
		assert.equal(
			id(beforeMatches[0].supplierData?.otaInboundEmailId),
			TARGET.auditId,
			"An unrelated existing reservation owns this Airbnb identity."
		);
		assert.equal(
			hasDirectHotelRunnerProjection(beforeMatches[0]),
			false,
			"A direct HotelRunner-owned reservation cannot be recovered from email."
		);
	}
	const planHash = buildPlanHash(audit, normalized);
	if (args.apply) {
		assert.equal(args.planHash, planHash, "Dry-run plan hash no longer matches.");
	}

	const plan = {
		mode: args.apply ? "apply" : "dry-run",
		repairId: args.apply ? TARGET.repairId : "not-applied",
		planHash,
		auditId: TARGET.auditId,
		confirmationNumber: TARGET.confirmationNumber,
		authenticatedDirectAirbnb: true,
		parserReady: true,
		currentExactReservationCount: beforeMatches.length,
		plannedAction: beforeMatches.length
			? "link-one-existing-exact-reservation"
			: "create-one-unmapped-ota-platform-review",
	};
	console.log(JSON.stringify(plan, null, 2));
	if (!args.apply) return plan;

	if (
		audit.reconciliation?.repairId === TARGET.repairId &&
		audit.reservationMongoId
	) {
		assert.equal(beforeMatches.length, 1, "Applied repair lost its reservation.");
		assert.equal(
			id(beforeMatches[0]._id),
			id(audit.reservationMongoId),
			"Applied repair points at a different reservation."
		);
		assertRecoveredReservation(beforeMatches[0], normalized);
		return { ...plan, idempotent: true, reservationId: id(beforeMatches[0]._id) };
	}

	assert.equal(
		audit.processingStatus,
		"needs_review",
		"Target audit is no longer in its reviewed pre-repair state."
	);
	assert.equal(
		audit.skipReason,
		"ota_parser_requires_manual_review",
		"Target audit skip reason changed."
	);
	assert.ok(!audit.reservationMongoId, "Target audit is already linked.");

	const externalEnvironmentKeys = [
		"OPENAI_API_KEY",
		"OPENAI_KEY",
		"CHATGPT_API_KEY",
		"EXCHANGE_RATE_API_KEY",
		"EXCHANGERATE_API_KEY",
	];
	const savedEnvironment = Object.fromEntries(
		externalEnvironmentKeys.map((key) => [key, process.env[key]])
	);
	for (const key of externalEnvironmentKeys) delete process.env[key];
	const originalFetch = global.fetch;
	let externalAttempts = 0;
	global.fetch = async () => {
		externalAttempts += 1;
		throw new Error("External HTTP is disabled for this recovery.");
	};
	let reconciliation;
	try {
		reconciliation = await reconcileOtaReservation(normalized);
	} finally {
		global.fetch = originalFetch;
		for (const key of externalEnvironmentKeys) {
			if (savedEnvironment[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnvironment[key];
		}
	}
	assert.equal(externalAttempts, 0, "Recovery attempted an external HTTP call.");
	assert.ok(
		["created", "duplicate_reservation"].includes(reconciliation.status),
		`Unexpected reconciliation status: ${reconciliation.status}`
	);
	const afterMatches = await exactReservations();
	assert.equal(afterMatches.length, 1, "Recovery did not leave exactly one booking.");
	assert.equal(
		id(afterMatches[0]._id),
		id(reconciliation.reservationId),
		"Reconciliation linked a different reservation."
	);
	assertRecoveredReservation(afterMatches[0], normalized);

	const createdFromThisAudit =
		id(afterMatches[0].supplierData?.otaInboundEmailId) === TARGET.auditId;
	const processingStatus = createdFromThisAudit
		? "created"
		: "duplicate_reservation";
	const auditWrite = await InboundEmail.updateOne(
		{
			_id: TARGET.auditId,
			__v: audit.__v,
			source: "sendgrid",
			duplicateOf: null,
			messageId: audit.messageId || "",
			emailHash: audit.emailHash || "",
			textHash: audit.textHash,
			receivedAt: audit.receivedAt,
			provider: TARGET.provider,
			confirmationNumber: TARGET.confirmationNumber,
			processingStatus: "needs_review",
			skipReason: "ota_parser_requires_manual_review",
			reservationMongoId: null,
			"senderAuthentication.authenticatedAligned": true,
			"senderAuthentication.trustedProvider": TARGET.provider,
		},
		{
			$set: auditUpdate(
				normalized,
				reconciliation,
				afterMatches[0],
				processingStatus
			),
		},
		{ writeConcern: { w: "majority" } }
	);
	assert.equal(auditWrite.matchedCount, 1, "Inbound audit CAS was not acquired.");
	assert.equal(auditWrite.modifiedCount, 1, "Inbound audit was not finalized.");

	const finalAudit = await InboundEmail.findById(TARGET.auditId)
		.select(
			"processingStatus skipReason reservationMongoId confirmationNumber reconciliation.repairId"
		)
		.lean();
	assert.equal(id(finalAudit.reservationMongoId), id(afterMatches[0]._id));
	assert.equal(finalAudit.reconciliation?.repairId, TARGET.repairId);
	assert.equal(finalAudit.processingStatus, processingStatus);

	const result = {
		...plan,
		success: true,
		processingStatus,
		reservationId: id(afterMatches[0]._id),
		exactReservationCount: 1,
		otaPlatformReviewStatus:
			afterMatches[0].otaPlatformReview?.status || "",
		hotelAssignmentRequired:
			afterMatches[0].otaPlatformReview?.hotelAssignmentRequired === true,
		externalAttempts,
		hotelRunnerApiCalls: 0,
	};
	console.log(JSON.stringify(result, null, 2));
	return result;
}

if (require.main === module) {
	run()
		.catch((error) => {
			console.error(error.message);
			process.exitCode = 1;
		})
		.finally(async () => {
			if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
		});
}

module.exports = {
	TARGET,
	buildPlanHash,
	emailFromAudit,
	normalizeTargetAudit,
	parseArguments,
	run,
};
