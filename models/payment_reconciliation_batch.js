/** @format */

"use strict";

const mongoose = require("mongoose");
const {
	PAYMENT_BREAKDOWN_KEYS,
} = require("../services/paymentReconciliation");

const { ObjectId } = mongoose.Schema.Types;

const PAYOUT_PURPOSES = Object.freeze([
	"paid_out_to_zad",
	"paid_out_as_commission",
	"paid_out_to_jannat",
	"paid_out_other",
]);

const reconciliationBatchItemSchema = new mongoose.Schema(
	{
		reservationId: { type: ObjectId, ref: "Reservations", required: true },
		paymentBreakdownKey: {
			type: String,
			enum: PAYMENT_BREAKDOWN_KEYS,
			required: true,
			trim: true,
		},
		amountCents: { type: Number, required: true, min: 0 },
		from: { type: String, default: "", trim: true },
		to: { type: String, required: true, trim: true },
	},
	{ _id: false }
);

const reconciliationAttachmentSchema = new mongoose.Schema(
	{
		publicId: { type: String, required: true, trim: true },
		resourceType: { type: String, required: true, trim: true },
		format: { type: String, default: "", trim: true },
		version: { type: Number, default: null },
		bytes: { type: Number, required: true, min: 0 },
		originalName: { type: String, required: true, trim: true },
		mimeType: { type: String, required: true, trim: true },
		uploadedAt: { type: Date, required: true },
	},
	{ _id: false }
);

const paymentReconciliationBatchSchema = new mongoose.Schema(
	{
		batchId: { type: String, required: true, unique: true, index: true, trim: true },
		hotelId: {
			type: ObjectId,
			ref: "HotelDetails",
			required: true,
			index: true,
		},
		action: {
			type: String,
			enum: ["reconcile", "reset"],
			required: true,
			index: true,
		},
		paymentBreakdownKeys: {
			type: [{ type: String, enum: PAYMENT_BREAKDOWN_KEYS }],
			required: true,
			default: [],
		},
		payoutPurpose: {
			type: String,
			enum: ["", ...PAYOUT_PURPOSES],
			default: "",
		},
		comment: { type: String, default: "", trim: true, maxlength: 1000 },
		attachment: { type: reconciliationAttachmentSchema, default: null },
		plannedAmountCents: { type: Number, required: true, min: 0 },
		appliedAmountCents: { type: Number, default: 0, min: 0 },
		plannedReservationCount: { type: Number, required: true, min: 0 },
		appliedReservationCount: { type: Number, default: 0, min: 0 },
		plannedItemCount: { type: Number, required: true, min: 0 },
		appliedItemCount: { type: Number, default: 0, min: 0 },
		plannedItems: { type: [reconciliationBatchItemSchema], default: [] },
		appliedItems: { type: [reconciliationBatchItemSchema], default: [] },
		status: {
			type: String,
			enum: ["applying", "complete", "partial", "failed"],
			default: "applying",
			index: true,
		},
		actor: { type: Object, required: true },
		startedAt: { type: Date, required: true },
		completedAt: { type: Date, default: null },
	},
	{ timestamps: true }
);

paymentReconciliationBatchSchema.index({ hotelId: 1, createdAt: -1 });

const PaymentReconciliationBatch = mongoose.model(
	"PaymentReconciliationBatch",
	paymentReconciliationBatchSchema
);

module.exports = PaymentReconciliationBatch;
module.exports.PAYOUT_PURPOSES = PAYOUT_PURPOSES;
