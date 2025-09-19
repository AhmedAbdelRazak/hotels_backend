// aiagent/core/db.js
const mongoose = require("mongoose");
const SupportCase = require("../../models/supportcase");
const HotelDetails = require("../../models/hotel_details");
const Reservations = require("../../models/reservations");

function safeId(id) {
	try {
		return new mongoose.Types.ObjectId(id);
	} catch {
		return null;
	}
}

async function getSupportCaseById(id) {
	const _id = safeId(id);
	if (!_id) return null;
	return SupportCase.findById(_id).lean().exec();
}

async function updateSupportCaseAppend(caseId, messageOrFields) {
	const _id = safeId(caseId);
	if (!_id) return null;

	const update = {};
	if (messageOrFields && messageOrFields.conversation) {
		update.$push = { conversation: messageOrFields.conversation };
	}
	const other = { ...messageOrFields };
	delete other.conversation;

	if (Object.keys(other).length) {
		update.$set = other;
	}

	return SupportCase.findByIdAndUpdate(_id, update, { new: true })
		.lean()
		.exec();
}

async function setCaseStatus(caseId, fields) {
	const _id = safeId(caseId);
	if (!_id) return null;
	return SupportCase.findByIdAndUpdate(_id, { $set: fields }, { new: true })
		.lean()
		.exec();
}

async function getHotelById(id) {
	const _id = safeId(id);
	if (!_id) return null;
	return HotelDetails.findById(_id).lean().exec();
}

async function getReservationByConfirmation(cn) {
	if (!cn) return null;
	return Reservations.findOne({ confirmation_number: String(cn) })
		.lean()
		.exec();
}

module.exports = {
	getSupportCaseById,
	updateSupportCaseAppend,
	setCaseStatus,
	getHotelById,
	getReservationByConfirmation,
};
