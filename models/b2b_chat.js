/** @format */

const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema;

const B2BSeenSchema = new mongoose.Schema(
	{
		userId: { type: ObjectId, ref: "User", required: true },
		seenAt: { type: Date, default: Date.now },
	},
	{ _id: false }
);

const B2BAttachmentSchema = new mongoose.Schema(
	{
		name: { type: String, trim: true, default: "attachment" },
		type: { type: String, trim: true, default: "" },
		size: { type: Number, default: 0 },
		kind: {
			type: String,
			enum: ["image", "file"],
			default: "file",
		},
		dataUrl: { type: String, default: "" },
		uploadedAt: { type: Date, default: Date.now },
	},
	{ _id: false }
);

const B2BMessageSchema = new mongoose.Schema(
	{
		senderId: { type: ObjectId, ref: "User", required: true },
		senderName: { type: String, trim: true, default: "" },
		senderRole: { type: String, trim: true, default: "" },
		body: { type: String, trim: true, default: "" },
		attachments: { type: [B2BAttachmentSchema], default: [] },
		seenBy: { type: [B2BSeenSchema], default: [] },
		createdAt: { type: Date, default: Date.now },
	},
	{ _id: true }
);

const B2BParticipantSchema = new mongoose.Schema(
	{
		userId: { type: ObjectId, ref: "User", required: true },
		name: { type: String, trim: true, default: "" },
		email: { type: String, trim: true, lowercase: true, default: "" },
		role: { type: Number, default: 0 },
		roleDescription: { type: String, trim: true, lowercase: true, default: "" },
		participantType: {
			type: String,
			enum: ["staff", "agent", "admin"],
			default: "staff",
		},
		hotelIds: [{ type: ObjectId, ref: "HotelDetails" }],
		lastSeenAt: { type: Date, default: null },
	},
	{ _id: false }
);

const B2BChatSchema = new mongoose.Schema(
	{
		subject: { type: String, trim: true, default: "" },
		scope: {
			type: String,
			enum: ["internal", "agent"],
			default: "internal",
		},
		status: {
			type: String,
			enum: ["active", "closed"],
			default: "active",
			index: true,
		},
		hotelIds: [{ type: ObjectId, ref: "HotelDetails", index: true }],
		participantIds: [{ type: ObjectId, ref: "User", index: true }],
		participants: { type: [B2BParticipantSchema], default: [] },
		messages: { type: [B2BMessageSchema], default: [] },
		createdBy: { type: ObjectId, ref: "User", required: true },
		closedBy: { type: ObjectId, ref: "User", default: null },
		closedAt: { type: Date, default: null },
		closedReason: { type: String, trim: true, default: "" },
		lastActivityAt: { type: Date, default: Date.now, index: true },
	},
	{ timestamps: true }
);

B2BChatSchema.index({ status: 1, lastActivityAt: -1 });
B2BChatSchema.index({ participantIds: 1, status: 1, lastActivityAt: -1 });
B2BChatSchema.index({ hotelIds: 1, status: 1, lastActivityAt: -1 });

B2BChatSchema.statics.closeInactiveChats = async function ({
	now = new Date(),
	inactiveMs = 2 * 60 * 60 * 1000,
	limit = 100,
} = {}) {
	const cutoff = new Date(now.getTime() - inactiveMs);
	const chats = await this.find({
		status: "active",
		lastActivityAt: { $lte: cutoff },
	})
		.limit(limit)
		.exec();

	for (const chat of chats) {
		const participantIds = (chat.participantIds || []).map((id) => String(id));
		(chat.messages || []).forEach((message) => {
			const seenIds = new Set(
				(message.seenBy || []).map((item) => String(item.userId))
			);
			participantIds.forEach((userId) => {
				if (!seenIds.has(userId)) {
					message.seenBy.push({ userId, seenAt: now });
				}
			});
		});
		(chat.participants || []).forEach((participant) => {
			participant.lastSeenAt = now;
		});
		chat.status = "closed";
		chat.closedAt = now;
		chat.closedReason = "inactive_timeout";
		await chat.save();
	}

	return { closed: chats.length, cutoff };
};

module.exports = mongoose.model("B2BChat", B2BChatSchema);
