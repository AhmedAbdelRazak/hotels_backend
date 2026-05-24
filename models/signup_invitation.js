/** @format */

const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema;

const signupInvitationSchema = new mongoose.Schema(
	{
		codeHash: {
			type: String,
			required: true,
			unique: true,
			index: true,
		},
		payload: {
			type: Object,
			default: {},
		},
		createdBy: {
			type: ObjectId,
			ref: "User",
			default: null,
		},
		expiresAt: {
			type: Date,
			required: true,
			index: { expires: 0 },
		},
		revokedAt: {
			type: Date,
			default: null,
		},
	},
	{ timestamps: true }
);

module.exports = mongoose.model("SignupInvitation", signupInvitationSchema);
