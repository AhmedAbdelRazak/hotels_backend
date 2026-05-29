// aiagent/core/db.js
const mongoose = require("mongoose");
const SupportCase = require("../../models/supportcase");
const HotelDetails = require("../../models/hotel_details");
const Reservations = require("../../models/reservations");
const Janat = require("../../models/janat");
const AiAgentLearning = require("../../models/aiagent_learning");
const AiAgentTrainingChat = require("../../models/aiagent_training_chat");

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
	update.$set = { ...(update.$set || {}), updatedAt: new Date() };

	return SupportCase.findByIdAndUpdate(_id, update, { new: true })
		.lean()
		.exec();
}

async function setCaseStatus(caseId, fields) {
	const _id = safeId(caseId);
	if (!_id) return null;
	return SupportCase.findByIdAndUpdate(
		_id,
		{ $set: { ...fields, updatedAt: new Date() } },
		{ new: true }
	)
		.lean()
		.exec();
}

async function getHotelById(id) {
	const _id = safeId(id);
	if (!_id) return null;
	return HotelDetails.findById(_id).lean().exec();
}

async function getJanatAiSettings() {
	const doc = await Janat.findOne({})
		.sort({ updatedAt: -1, createdAt: -1, _id: -1 })
		.select("aiToRespond")
		.lean()
		.exec();
	return {
		aiToRespond: !doc || doc.aiToRespond !== false,
	};
}

async function listActivePublicHotels() {
	return HotelDetails.find({
		activateHotel: true,
		xHotelProActive: { $ne: false },
		roomCountDetails: {
			$elemMatch: {
				activeRoom: true,
				"price.basePrice": { $gt: 0 },
			},
		},
	})
		.select(
			"_id hotelName hotelName_OtherLanguage hotelCity distances roomCountDetails currency"
		)
		.lean()
		.exec();
}

async function getReservationByConfirmation(cn) {
	if (!cn) return null;
	return Reservations.findOne({ confirmation_number: String(cn) })
		.lean()
		.exec();
}

const learningTokens = (text = "") =>
	String(text || "")
		.toLowerCase()
		.replace(/https?:\/\/\S+/g, " ")
		.replace(/[^a-z0-9\u0600-\u06FF\s]/gi, " ")
		.split(/\s+/)
		.map((word) => word.trim())
		.filter((word) => word.length >= 4);

function scoreTrainingChat(doc = {}, queryTokens = new Set(), hotelId = "") {
	let score = 0;
	const docHotelId = doc.hotelId ? String(doc.hotelId) : "";
	if (hotelId && docHotelId === hotelId) score += 8;
	const keywords = Array.isArray(doc.chatKeywords) ? doc.chatKeywords : [];
	keywords.forEach((keyword) => {
		if (queryTokens.has(String(keyword || "").toLowerCase())) score += 3;
	});
	const haystack = [
		doc.chatTitle,
		doc.summary,
		doc.customerIntent,
		doc.supportResolution,
		...(doc.learningNotes || []),
		...(doc.responseGuidance || []),
	]
		.join(" ")
		.toLowerCase();
	queryTokens.forEach((token) => {
		if (haystack.includes(token)) score += 1;
	});
	return score;
}

async function findTrainingDocs(Model, filter) {
	try {
		return await Model.find(filter)
			.select(
				"chatTitle chatKeywords conversation summary language customerIntent supportResolution learningNotes responseGuidance hotelId hotelName updatedAt createdAt"
			)
			.sort({ updatedAt: -1, createdAt: -1 })
			.limit(80)
			.lean()
			.exec();
	} catch (error) {
		console.error("[aiagent] training lookup failed:", error?.message || error);
		return [];
	}
}

async function listRelevantTrainingChats({ hotelId, text, limit = 4 } = {}) {
	const safeHotelId = safeId(hotelId);
	const scopedFilter = { status: "active" };
	if (safeHotelId) {
		scopedFilter.$or = [
			{ hotelId: safeHotelId },
			{ hotelId: null },
			{ hotelId: { $exists: false } },
		];
	}
	const learningFilter = { ...scopedFilter, sourceType: "manual_chat" };

	const [learningDocs, legacyTrainingDocs] = await Promise.all([
		findTrainingDocs(AiAgentLearning, learningFilter),
		findTrainingDocs(AiAgentTrainingChat, scopedFilter),
	]);
	const docs = [...learningDocs, ...legacyTrainingDocs];

	const tokens = new Set(learningTokens(text));
	const hotelIdString = safeHotelId ? String(safeHotelId) : "";
	const sortedDocs = docs
		.map((doc) => ({
			...doc,
			_relevanceScore: scoreTrainingChat(doc, tokens, hotelIdString),
		}))
		.sort(
			(a, b) =>
				b._relevanceScore - a._relevanceScore ||
				new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0)
		);

	const max = Math.max(1, Math.min(Number(limit) || 4, 8));
	const picked = [];
	const seenLanguages = new Set();
	const topRelevantSlots = Math.max(1, Math.floor(max / 2));
	for (const doc of sortedDocs) {
		if (picked.length >= topRelevantSlots) break;
		if (doc._relevanceScore > 0 || picked.length < 2) {
			picked.push(doc);
			seenLanguages.add(String(doc.language || "unknown").toLowerCase());
		}
	}
	for (const doc of sortedDocs) {
		if (picked.length >= max) break;
		const language = String(doc.language || "unknown").toLowerCase();
		if (
			!seenLanguages.has(language) &&
			!picked.some((item) => String(item._id) === String(doc._id))
		) {
			picked.push(doc);
			seenLanguages.add(language);
		}
	}
	for (const doc of sortedDocs) {
		if (picked.length >= max) break;
		if (!picked.some((item) => String(item._id) === String(doc._id))) {
			picked.push(doc);
		}
	}
	return picked;
}

module.exports = {
	getSupportCaseById,
	updateSupportCaseAppend,
	setCaseStatus,
	getHotelById,
	getJanatAiSettings,
	listActivePublicHotels,
	getReservationByConfirmation,
	listRelevantTrainingChats,
};
