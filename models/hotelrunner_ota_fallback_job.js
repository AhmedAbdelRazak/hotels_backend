/** @format */

const mongoose = require("mongoose");

const { ObjectId } = mongoose.Schema;

const DIRECT_OTA_PROVIDERS = [
	"agoda",
	"airbnb",
	"booking",
	"expedia",
	"hotels",
	"trip",
];

const HOTELRUNNER_FIRST_FALLBACK_STATES = [
	"awaiting_hotelrunner",
	"processing",
	"retry",
	"completed_api",
	"completed_email_fallback",
	"needs_review",
];

const negativeLookupProofSchema = new mongoose.Schema(
	{
		proofId: { type: String, trim: true, default: "" },
		status: {
			type: String,
			trim: true,
			lowercase: true,
			enum: ["", "confirmed_empty"],
			default: "",
		},
		hotelId: { type: String, trim: true, lowercase: true, default: "" },
		hrIdFingerprint: {
			type: String,
			trim: true,
			lowercase: true,
			default: "",
		},
		provider: { type: String, trim: true, lowercase: true, default: "" },
		confirmationNumber: {
			type: String,
			trim: true,
			lowercase: true,
			default: "",
		},
		lookupConfirmationHash: {
			type: String,
			trim: true,
			lowercase: true,
			default: "",
		},
		archiveFingerprint: {
			type: String,
			trim: true,
			lowercase: true,
			default: "",
		},
		resolvedHotelProofHash: {
			type: String,
			trim: true,
			lowercase: true,
			default: "",
		},
		responseHash: {
			type: String,
			trim: true,
			lowercase: true,
			default: "",
		},
		resultCount: { type: Number, default: null },
		checkedAt: { type: Date, default: null },
		expiresAt: { type: Date, default: null },
	},
	{ _id: false, minimize: false }
);

const ingressDecisionSchema = new mongoose.Schema(
	{
		status: {
			type: String,
			trim: true,
			lowercase: true,
			enum: ["open", "api_observed", "email_authorized", "email_committed"],
			default: "open",
		},
		apiObservationKey: {
			type: String,
			trim: true,
			lowercase: true,
			default: "",
		},
		apiPayloadHash: {
			type: String,
			trim: true,
			lowercase: true,
			default: "",
		},
		apiObservedAt: { type: Date, default: null },
		apiLastObservedAt: { type: Date, default: null },
		apiObservationCount: { type: Number, min: 0, default: 0 },
		emailAuthorization: {
			type: mongoose.Schema.Types.Mixed,
			default: undefined,
		},
		emailAuthorizationLeaseUntil: { type: Date, default: null },
		emailReservationId: {
			type: ObjectId,
			ref: "Reservations",
			default: null,
		},
		emailCommittedAt: { type: Date, default: null },
	},
	{ _id: false, minimize: false }
);

const hotelRunnerOtaFallbackJobSchema = new mongoose.Schema(
	{
		hotelId: {
			type: ObjectId,
			ref: "HotelDetails",
			required: true,
			index: true,
		},
		provider: {
			type: String,
			trim: true,
			lowercase: true,
			enum: DIRECT_OTA_PROVIDERS,
			required: true,
		},
		lookupConfirmationNumber: {
			type: String,
			trim: true,
			maxlength: 256,
			required: true,
		},
		lookupConfirmationHash: {
			type: String,
			trim: true,
			lowercase: true,
			maxlength: 64,
			required: true,
		},
		confirmationNumber: {
			type: String,
			trim: true,
			lowercase: true,
			maxlength: 256,
			required: true,
		},
		identityKey: {
			type: String,
			trim: true,
			lowercase: true,
			maxlength: 300,
			required: true,
		},
		hrIdFingerprint: {
			type: String,
			trim: true,
			lowercase: true,
			maxlength: 64,
			required: true,
		},
		inboundEmailId: {
			type: ObjectId,
			ref: "InboundEmail",
			required: true,
			index: true,
		},
		inboundEmailHash: {
			type: String,
			trim: true,
			lowercase: true,
			maxlength: 64,
			required: true,
		},
		normalizedReservationHash: {
			type: String,
			trim: true,
			lowercase: true,
			maxlength: 64,
			required: true,
		},
		resolvedHotelProofHash: {
			type: String,
			trim: true,
			lowercase: true,
			maxlength: 64,
			required: true,
		},
		archiveFingerprint: {
			type: String,
			trim: true,
			lowercase: true,
			maxlength: 64,
			required: true,
		},
		status: {
			type: String,
			trim: true,
			lowercase: true,
			enum: HOTELRUNNER_FIRST_FALLBACK_STATES,
			default: "awaiting_hotelrunner",
			index: true,
		},
		notBefore: { type: Date, required: true, index: true },
		nextAttemptAt: { type: Date, required: true, index: true },
		attemptCount: { type: Number, default: 0, min: 0 },
		lookupAttemptCount: { type: Number, default: 0, min: 0 },
		seenCount: { type: Number, default: 0, min: 0 },
		lastSeenAt: { type: Date, default: null },
		leaseOwner: { type: String, trim: true, default: "" },
		leaseToken: { type: String, trim: true, lowercase: true, default: "" },
		leaseAcquiredAt: { type: Date, default: null },
		leaseUntil: { type: Date, default: null, index: true },
		lastStartedAt: { type: Date, default: null },
		lastDecision: { type: String, trim: true, lowercase: true, default: "" },
		lastErrorCode: { type: String, trim: true, default: "" },
		lastErrorMessage: { type: String, trim: true, default: "" },
		lastLookup: {
			status: { type: String, trim: true, lowercase: true, default: "" },
			checkedAt: { type: Date, default: null },
			responseHash: {
				type: String,
				trim: true,
				lowercase: true,
				default: "",
			},
			resultCount: { type: Number, default: null },
			code: { type: String, trim: true, default: "" },
		},
		negativeLookupProof: {
			type: negativeLookupProofSchema,
			default: () => ({}),
		},
		// This is the cross-process linearization record shared by HotelRunner
		// callback persistence and the final confirmed-empty email create boundary.
		ingressDecision: {
			type: ingressDecisionSchema,
			default: () => ({}),
		},
		hotelRunnerEventId: {
			type: ObjectId,
			ref: "HotelRunnerEvent",
			default: null,
		},
		hotelRunnerMirrorId: {
			type: ObjectId,
			ref: "HotelRunnerReservation",
			default: null,
		},
		reservationMongoId: {
			type: ObjectId,
			ref: "Reservations",
			default: null,
			index: true,
		},
		hotelRunnerEventOrigin: {
			type: String,
			trim: true,
			lowercase: true,
			default: "",
		},
		lookupEventProjectableAt: { type: Date, default: null },
		inboundAuditFinalizationStatus: {
			type: String,
			trim: true,
			lowercase: true,
			enum: ["", "pending", "completed", "retry"],
			default: "",
		},
		inboundAuditFinalizedAt: { type: Date, default: null },
		pendingTerminalStatus: {
			type: String,
			trim: true,
			lowercase: true,
			enum: ["", "completed_api", "completed_email_fallback", "needs_review"],
			default: "",
		},
		pendingTerminalDetails: {
			type: mongoose.Schema.Types.Mixed,
			default: undefined,
		},
		pendingTerminalAt: { type: Date, default: null },
		notificationOutboxStatus: {
			type: String,
			trim: true,
			lowercase: true,
			enum: ["", "pending", "enqueued"],
			default: "",
			index: true,
		},
		notificationOutboxId: {
			type: ObjectId,
			ref: "HotelRunnerFallbackNotificationOutbox",
			default: null,
		},
		notificationOutboxEnqueuedAt: { type: Date, default: null },
		identityConflict: { type: Boolean, default: false },
		identityCollisions: { type: [Object], default: [], select: false },
		result: { type: Object, default: {}, select: false },
		completedAt: { type: Date, default: null },
	},
	{ timestamps: true, minimize: false }
);

hotelRunnerOtaFallbackJobSchema.index(
	{ hotelId: 1, provider: 1, confirmationNumber: 1 },
	{
		unique: true,
		name: "uniq_hotelrunner_ota_fallback_identity",
	}
);

hotelRunnerOtaFallbackJobSchema.index(
	{
		hotelId: 1,
		status: 1,
		nextAttemptAt: 1,
		leaseUntil: 1,
		createdAt: 1,
	},
	{ name: "hotelrunner_ota_fallback_claim_queue" }
);

const HotelRunnerOtaFallbackJob = mongoose.model(
	"HotelRunnerOtaFallbackJob",
	hotelRunnerOtaFallbackJobSchema
);

module.exports = HotelRunnerOtaFallbackJob;
module.exports.DIRECT_OTA_PROVIDERS = DIRECT_OTA_PROVIDERS;
module.exports.HOTELRUNNER_FIRST_FALLBACK_STATES =
	HOTELRUNNER_FIRST_FALLBACK_STATES;
