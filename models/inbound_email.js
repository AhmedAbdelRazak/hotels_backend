/** @format */

const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema;

const inboundEmailSchema = new mongoose.Schema(
	{
		source: { type: String, trim: true, lowercase: true, default: "sendgrid" },
		provider: { type: String, trim: true, lowercase: true, default: "" },
		providerLabel: { type: String, trim: true, default: "" },
		intent: { type: String, trim: true, lowercase: true, default: "" },
		eventType: { type: String, trim: true, lowercase: true, default: "" },
		automationAction: {
			type: String,
			trim: true,
			lowercase: true,
			default: "",
		},
		skipReason: { type: String, trim: true, lowercase: true, default: "" },
		automationComment: { type: String, trim: true, default: "" },
		hasReservationConnection: { type: Boolean, default: false },
		matchedReservationBy: { type: [String], default: [] },
		processingStatus: {
			type: String,
			trim: true,
			lowercase: true,
			default: "received",
		},

		from: { type: String, trim: true, default: "" },
		to: { type: String, trim: true, default: "" },
		cc: { type: String, trim: true, default: "" },
		bcc: { type: String, trim: true, default: "" },
		subject: { type: String, trim: true, default: "" },
		messageId: { type: String, trim: true, default: "" },
		emailHash: { type: String, trim: true, default: "" },
		textHash: { type: String, trim: true, default: "" },
		duplicateOf: { type: ObjectId, ref: "InboundEmail", default: null },

		bodyText: { type: String, default: "" },
		bodyHtml: { type: String, default: "" },
		safeSnippet: { type: String, default: "" },
		attachments: {
			type: [
				{
					filename: { type: String, default: "" },
					contentType: { type: String, default: "" },
					size: { type: Number, default: 0 },
					contentId: { type: String, default: "" },
				},
			],
			default: [],
		},

		confirmationNumber: { type: String, trim: true, lowercase: true, default: "" },
		pmsConfirmationNumber: { type: String, trim: true, lowercase: true, default: "" },
		hotelName: { type: String, trim: true, default: "" },
		roomName: { type: String, trim: true, default: "" },
		sourceAmount: { type: Number, default: 0 },
		sourceCurrency: { type: String, trim: true, uppercase: true, default: "" },
		totalAmountSar: { type: Number, default: 0 },
		exchangeRateToSar: { type: Number, default: 0 },
		exchangeRateSource: { type: String, trim: true, lowercase: true, default: "" },
		paymentCollectionModel: { type: String, trim: true, lowercase: true, default: "" },
		hotelId: { type: ObjectId, ref: "HotelDetails", default: null },
		reservationMongoId: { type: ObjectId, ref: "Reservations", default: null },

		normalizedReservation: { type: Object, default: {} },
		emailContext: { type: Object, default: {} },
		orchestratorDecision: { type: Object, default: {} },
		reconciliation: { type: Object, default: {} },
		parseWarnings: { type: [String], default: [] },
		parseErrors: { type: [String], default: [] },
		reconcileWarnings: { type: [String], default: [] },
		reconcileErrors: { type: [String], default: [] },

		receivedAt: { type: Date, default: Date.now },
		processedAt: { type: Date, default: null },
	},
	{ timestamps: true }
);

inboundEmailSchema.index({ emailHash: 1 });
inboundEmailSchema.index({ messageId: 1 });
inboundEmailSchema.index({ provider: 1, confirmationNumber: 1 });
inboundEmailSchema.index({ paymentCollectionModel: 1, receivedAt: -1 });
inboundEmailSchema.index({ processingStatus: 1, receivedAt: -1 });
inboundEmailSchema.index({ automationAction: 1, receivedAt: -1 });
inboundEmailSchema.index({ skipReason: 1, receivedAt: -1 });
inboundEmailSchema.index({ hasReservationConnection: 1, receivedAt: -1 });
inboundEmailSchema.index({ hotelId: 1, receivedAt: -1 });
inboundEmailSchema.index({ reservationMongoId: 1, receivedAt: -1 });

module.exports = mongoose.model("InboundEmail", inboundEmailSchema);
