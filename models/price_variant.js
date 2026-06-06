/** @format */

"use strict";

const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema;

const priceVariantItemSchema = new mongoose.Schema(
	{
		name: {
			type: String,
			trim: true,
			required: true,
		},
		nameOtherLanguage: {
			type: String,
			trim: true,
			default: "",
		},
		status: {
			type: String,
			enum: ["open", "blocked"],
			default: "open",
		},
		sellingPrice: {
			type: Number,
			default: 0,
		},
		commissionPercent: {
			type: Number,
			default: 0,
		},
		rootPrice: {
			type: Number,
			default: 0,
		},
		color: {
			type: String,
			default: "",
		},
		sortOrder: {
			type: Number,
			default: 0,
		},
		pricingBasis: {
			mode: {
				type: String,
				enum: ["manual", "derived", "calendar_base"],
				default: "manual",
			},
			basePriceVariantItemId: {
				type: ObjectId,
				default: null,
			},
			direction: {
				type: String,
				enum: ["increase", "decrease"],
				default: "increase",
			},
			adjustmentType: {
				type: String,
				enum: ["money", "percentage"],
				default: "money",
			},
			amount: {
				type: Number,
				default: 0,
			},
		},
		assignedAgents: {
			type: [
				{
					agentId: {
						type: ObjectId,
						ref: "User",
					},
					agentName: {
						type: String,
						default: "",
					},
					agentEmail: {
						type: String,
						default: "",
					},
					companyName: {
						type: String,
						default: "",
					},
					hotelIds: {
						type: [{ type: ObjectId, ref: "HotelDetails" }],
						default: [],
					},
					assignedAt: {
						type: Date,
						default: Date.now,
					},
					assignedBy: {
						type: ObjectId,
						ref: "User",
						default: null,
					},
				},
			],
			default: [],
		},
	},
	{ _id: true }
);

const priceVariantRoomSchema = new mongoose.Schema(
	{
		hotelId: {
			type: ObjectId,
			ref: "HotelDetails",
			required: true,
		},
		roomId: {
			type: ObjectId,
			required: true,
		},
		roomType: {
			type: String,
			default: "",
		},
		displayName: {
			type: String,
			default: "",
		},
		displayNameOtherLanguage: {
			type: String,
			default: "",
		},
		roomForGender: {
			type: String,
			default: "",
		},
	},
	{ _id: false }
);

const priceVariantPeriodPriceSchema = new mongoose.Schema(
	{
		periodKey: {
			type: String,
			default: "",
		},
		label: {
			type: String,
			default: "",
		},
		calendarType: {
			type: String,
			enum: ["hijri", "gregorian"],
			default: "hijri",
		},
		periodMode: {
			type: String,
			enum: ["months", "custom"],
			default: "months",
		},
		year: {
			type: Number,
			default: null,
		},
		month: {
			type: Number,
			default: null,
		},
		startDate: {
			type: String,
			default: "",
		},
		endDate: {
			type: String,
			default: "",
		},
		status: {
			type: String,
			enum: ["open", "blocked"],
			default: "open",
		},
		sellingPrice: {
			type: Number,
			default: 0,
		},
		mainCalendarPrice: {
			type: Number,
			default: 0,
		},
		commissionPercent: {
			type: Number,
			default: 0,
		},
		baseSource: {
			type: String,
			default: "",
		},
		manualOverride: {
			type: Boolean,
			default: false,
		},
		rootPrice: {
			type: Number,
			default: 0,
		},
		color: {
			type: String,
			default: "",
		},
	},
	{ _id: false }
);

const priceVariantRoomPricingItemSchema = new mongoose.Schema(
	{
		priceVariantItemId: {
			type: ObjectId,
			required: true,
		},
		name: {
			type: String,
			trim: true,
			default: "",
		},
		nameOtherLanguage: {
			type: String,
			trim: true,
			default: "",
		},
		status: {
			type: String,
			enum: ["open", "blocked"],
			default: "open",
		},
		sellingPrice: {
			type: Number,
			default: 0,
		},
		commissionPercent: {
			type: Number,
			default: 0,
		},
		rootPrice: {
			type: Number,
			default: 0,
		},
		color: {
			type: String,
			default: "",
		},
		sortOrder: {
			type: Number,
			default: 0,
		},
		periodPrices: {
			type: [priceVariantPeriodPriceSchema],
			default: [],
		},
	},
	{ _id: false }
);

const priceVariantRoomPricingSchema = new mongoose.Schema(
	{
		hotelId: {
			type: ObjectId,
			ref: "HotelDetails",
			required: true,
		},
		roomId: {
			type: ObjectId,
			required: true,
		},
		roomType: {
			type: String,
			default: "",
		},
		displayName: {
			type: String,
			default: "",
		},
		displayNameOtherLanguage: {
			type: String,
			default: "",
		},
		roomForGender: {
			type: String,
			default: "",
		},
		pricingItems: {
			type: [priceVariantRoomPricingItemSchema],
			default: [],
		},
	},
	{ _id: false }
);

const priceVariantSchema = new mongoose.Schema(
	{
		ownerId: {
			type: ObjectId,
			ref: "User",
			default: null,
			index: true,
		},
		hotelIds: {
			type: [{ type: ObjectId, ref: "HotelDetails" }],
			default: [],
			index: true,
		},
		roomSelections: {
			type: [priceVariantRoomSchema],
			default: [],
		},
		dataType: {
			type: String,
			enum: ["price_variant"],
			default: "price_variant",
			index: true,
		},
		basePriceSource: {
			type: String,
			enum: ["manual", "calendar_main_price"],
			default: "calendar_main_price",
		},
		calendarType: {
			type: String,
			enum: ["hijri", "gregorian"],
			default: "hijri",
		},
		periodMode: {
			type: String,
			enum: ["months", "custom"],
			default: "months",
		},
		hijriYear: {
			type: Number,
			default: null,
		},
		hijriMonths: {
			type: [Number],
			default: [],
		},
		gregorianYear: {
			type: Number,
			default: null,
		},
		gregorianMonths: {
			type: [Number],
			default: [],
		},
		startDate: {
			type: String,
			default: "",
		},
		endDate: {
			type: String,
			default: "",
		},
		dates: {
			type: [String],
			default: [],
		},
		pricingItems: {
			type: [priceVariantItemSchema],
			default: [],
		},
		roomPricing: {
			type: [priceVariantRoomPricingSchema],
			default: [],
		},
		active: {
			type: Boolean,
			default: true,
			index: true,
		},
		createdBy: {
			type: ObjectId,
			ref: "User",
			default: null,
		},
		updatedBy: {
			type: ObjectId,
			ref: "User",
			default: null,
		},
	},
	{ timestamps: true }
);

priceVariantSchema.index({ hotelIds: 1, active: 1, createdAt: -1 });
priceVariantSchema.index({ ownerId: 1, active: 1, createdAt: -1 });

module.exports = mongoose.model("PriceVariant", priceVariantSchema, "pricevariants");
