/** @format */

const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema;

const houseKeepingSchema = new mongoose.Schema(
	{
		taskDate: {
			type: Date,
			default: new Date(),
		},

		confirmation_number: {
			type: String,
			default: "manual task",
			lowercase: true,
		},

		task_status: {
			type: String,
			default: "Unfinished",
			lowercase: true,
		},

		cleaningDate: {
			type: Date,
			default: new Date(),
		},

		task_comment: {
			type: String,
			default: "",
			lowercase: true,
		},
		taskType: {
			type: String,
			enum: ["room", "general"],
			default: "room",
			lowercase: true,
		},
		generalAreas: [
			{
				type: String,
				trim: true,
				lowercase: true,
			},
		],
		customTask: {
			type: String,
			default: "",
			trim: true,
		},

		assignedTo: { type: ObjectId, ref: "User", default: null },
		assignedBy: { type: ObjectId, ref: "User", default: null },
		cleanedBy: { type: ObjectId, ref: "User", default: null },
		cleaningStartedAt: { type: Date, default: null },
		completedAt: { type: Date, default: null },
		cleaningDurationMs: { type: Number, default: 0 },
		statusHistory: [
			{
				status: { type: String, default: "" },
				changedBy: { type: ObjectId, ref: "User", default: null },
				changedAt: { type: Date, default: Date.now },
				comment: { type: String, default: "" },
				room: { type: ObjectId, ref: "Rooms", default: null },
			},
		],
		rooms: [{ type: ObjectId, ref: "Rooms" }],
		// Tracks cleaning per room so a multi-room task can be completed room by room.
		roomStatus: [
			{
				room: { type: ObjectId, ref: "Rooms", default: null },
				status: {
					type: String,
					default: "unfinished",
					lowercase: true,
				},
				cleanedBy: { type: ObjectId, ref: "User", default: null },
				startedBy: { type: ObjectId, ref: "User", default: null },
				startedAt: { type: Date, default: null },
				cleanedAt: { type: Date, default: null },
				durationMs: { type: Number, default: 0 },
				comment: { type: String, default: "" },
			},
		],
		hotelId: { type: ObjectId, ref: "HotelDetails" },
	},
	{ timestamps: true }
);

module.exports = mongoose.model("HouseKeeping", houseKeepingSchema);
