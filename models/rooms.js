/** @format */

const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema;

const roomsSchema = new mongoose.Schema(
	{
		room_number: {
			type: String,
			trim: true,
			lowercase: true,
			required: true,
		},

		room_type: {
			type: String,
			trim: true,
			default: "Standard Room",
		},

		display_name: {
			type: String,
			trim: true,
			default: "",
		},

		room_features: {
			type: Object,
			trim: true,
			default: {
				bedSize: "Double",
				view: "city view",
				bathroom: ["bathtub", "jacuzzi"],
				airConditiong: "climate control features",
				television: "Smart TV",
				internet: ["WiFi", "Ethernet Connection"],
				Minibar: ["Refrigerator with drinks & snacks"],
				smoking: false,
			},
		},

		// room_pricing: {
		// 	type: Object,
		// 	trim: true,
		// 	default: {
		// 		basePrice: 0,
		// 		seasonPrice: 0,
		// 		weekendPrice: 0,
		// 		lastMinuteDealPrice: 0,
		// 	},
		// },

		floor: {
			type: Number,
			trim: true,
			default: 1,
		},

		roomColorCode: {
			type: String,
			trim: true,
			default: "#000",
		},

		activeRoom: {
			type: Boolean,
			default: true,
		},

		cleanRoom: {
			type: Boolean,
			default: true,
		},

		individualBeds: {
			type: Boolean,
			default: false,
		},

		isHandicapped: {
			type: Boolean,
			default: false,
		},

		isVip: {
			type: Boolean,
			default: false,
		},

		active: {
			type: Boolean,
			default: true,
		},

		bedsNumber: {
			type: Array,
			trim: true,
			lowercase: true,
			default: [],
		},

		bedPricing: {
			type: Array,
			default: [],
		},

		belongsTo: { type: ObjectId, ref: "User" },
		hotelId: { type: ObjectId, ref: "HotelDetails" },
	},
	{ timestamps: true }
);

module.exports = mongoose.model("Rooms", roomsSchema);
