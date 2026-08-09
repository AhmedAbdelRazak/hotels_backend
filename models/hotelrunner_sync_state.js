/** @format */

const mongoose = require("mongoose");

const { ObjectId } = mongoose.Schema;

const hotelRunnerSyncStateSchema = new mongoose.Schema(
	{
		hotelId: {
			type: ObjectId,
			ref: "HotelDetails",
			required: true,
			unique: true,
			index: true,
		},
		status: {
			type: String,
			trim: true,
			lowercase: true,
			enum: ["idle", "pulling", "retry", "disabled"],
			default: "idle",
		},
		lastPullStartedAt: { type: Date, default: null },
		lastPullCompletedAt: { type: Date, default: null },
		lastPullSucceededAt: { type: Date, default: null },
		nextPullAt: { type: Date, default: Date.now, index: true },
		historyCursorFrom: { type: Date, default: null },
		historyCursorPage: { type: Number, min: 1, default: 1 },
		historyCycleStartedAt: { type: Date, default: null },
		lastRoomListSyncAt: { type: Date, default: null },
		lastRoomListStartedAt: { type: Date, default: null },
		lastRoomListCompletedAt: { type: Date, default: null },
		nextRoomListSyncAt: { type: Date, default: Date.now },
		activeRoomListSyncGeneration: {
			type: String,
			trim: true,
			default: "",
		},
		activeRoomListPublishedAt: { type: Date, default: null },
		roomListRequeuePendingGeneration: {
			type: String,
			trim: true,
			default: "",
		},
		leaseOwner: { type: String, trim: true, default: "" },
		leaseUntil: { type: Date, default: null, index: true },
		projectionLeaseOwner: { type: String, trim: true, default: "" },
		projectionLeaseAcquiredAt: { type: Date, default: null },
		projectionLeaseUntil: { type: Date, default: null, index: true },
		workerReleaseSha: {
			type: String,
			trim: true,
			lowercase: true,
			default: "",
		},
		workerReleaseTreeSha: {
			type: String,
			trim: true,
			lowercase: true,
			default: "",
		},
		workerInstanceId: { type: String, trim: true, default: "" },
		workerStartedAt: { type: Date, default: null },
		workerHeartbeatAt: { type: Date, default: null },
		workerStoppedAt: { type: Date, default: null },
		workerStopReason: { type: String, trim: true, default: "" },
		lastErrorCode: { type: String, trim: true, default: "" },
		lastErrorMessage: { type: String, trim: true, default: "" },
		disabledConfigFingerprint: {
			type: String,
			trim: true,
			lowercase: true,
			default: "",
			select: false,
		},
		metrics: {
			pulls: { type: Number, default: 0 },
			pullFailures: { type: Number, default: 0 },
			roomListPulls: { type: Number, default: 0 },
			eventsReceived: { type: Number, default: 0 },
			eventsProcessed: { type: Number, default: 0 },
		},
	},
	{ timestamps: true }
);

module.exports = mongoose.model(
	"HotelRunnerSyncState",
	hotelRunnerSyncStateSchema
);
