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
		const value = id && typeof id === "object" && id._id ? id._id : id;
		if (!value) return null;
		return new mongoose.Types.ObjectId(value);
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

function compactRoomForAi(room = {}) {
	if (!room || typeof room !== "object") return room;
	return {
		_id: room._id,
		roomType: room.roomType,
		displayName: room.displayName,
		displayName_OtherLanguage: room.displayName_OtherLanguage,
		description: room.description,
		description_OtherLanguage: room.description_OtherLanguage,
		amenities: room.amenities,
		views: room.views,
		extraAmenities: room.extraAmenities,
		pricedExtras: room.pricedExtras,
		price: room.price,
		pricingRate: room.pricingRate,
		monthly: room.monthly,
		offers: room.offers,
		count: room.count,
		activeRoom: room.activeRoom,
		commisionIncluded: room.commisionIncluded,
		refundPolicyDays: room.refundPolicyDays,
		roomSize: room.roomSize,
		defaultCost: room.defaultCost,
		roomCommission: room.roomCommission,
		bedsCount: room.bedsCount,
		roomForGender: room.roomForGender,
		roomColor: room.roomColor,
	};
}

function compactHotelForAi(hotel = null) {
	if (!hotel) return null;
	return {
		...hotel,
		roomCountDetails: Array.isArray(hotel.roomCountDetails)
			? hotel.roomCountDetails.map(compactRoomForAi)
			: [],
	};
}

async function getHotelById(id) {
	const _id = safeId(id);
	if (!_id) return null;
	const hotel = await HotelDetails.findById(_id)
		.select(
			[
				"_id",
				"hotelName",
				"hotelName_OtherLanguage",
				"hotelCity",
				"hotelState",
				"hotelCountry",
				"distances",
				"currency",
				"aiToRespond",
				"activateHotel",
				"xHotelProActive",
				"belongsTo",
				"roomCountDetails",
			].join(" ")
		)
		.lean()
		.exec();
	return compactHotelForAi(hotel);
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
	const hotels = await HotelDetails.find({
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
			"_id hotelName hotelName_OtherLanguage hotelCity hotelState hotelCountry distances roomCountDetails currency aiToRespond activateHotel xHotelProActive belongsTo"
		)
		.lean()
		.exec();
	return hotels.map(compactHotelForAi).filter(Boolean);
}

async function getReservationByConfirmation(cn) {
	if (!cn) return null;
	return Reservations.findOne({ confirmation_number: String(cn) })
		.lean()
		.exec();
}

const AI_SUPPORT_EMAILS = new Set([
	"support@jannatbooking.com",
	"management@xhotelpro.com",
]);
const AI_SUPPORT_USER_IDS = new Set([
	"jannat-system",
	"jannat-ai-support",
	"system",
]);

function normalizeIdentity(value = "") {
	return String(value || "").trim().toLowerCase();
}

function collectGuestIdentity(supportCase = {}) {
	const conversation = Array.isArray(supportCase.conversation)
		? supportCase.conversation
		: [];
	const customerEmails = new Set();
	const userIds = new Set();
	const names = new Set();
	for (const message of conversation) {
		if (message?.isAi || message?.isSystem) continue;
		const messageBy = message?.messageBy || {};
		const email = normalizeIdentity(messageBy.customerEmail);
		const userId = String(messageBy.userId || "").trim();
		const name = String(messageBy.customerName || "").trim();
		if (email && !AI_SUPPORT_EMAILS.has(email)) customerEmails.add(email);
		if (userId && !AI_SUPPORT_USER_IDS.has(userId)) userIds.add(userId);
		if (name) names.add(name);
	}
	const displayName = String(supportCase.displayName1 || "").trim();
	if (displayName) names.add(displayName);
	return {
		customerEmails: [...customerEmails],
		userIds: [...userIds],
		names: [...names].filter((name) => name.length >= 2),
	};
}

async function listPreviousGuestSupportChats({ supportCase, limit = 4 } = {}) {
	const currentId = safeId(supportCase?._id);
	const hotelId = safeId(supportCase?.hotelId);
	const { customerEmails, userIds, names } = collectGuestIdentity(supportCase);
	const stableMatches = [];
	if (customerEmails.length) {
		stableMatches.push({
			"conversation.messageBy.customerEmail": { $in: customerEmails },
		});
	}
	if (userIds.length) {
		stableMatches.push({
			"conversation.messageBy.userId": { $in: userIds },
		});
	}

	const filter = {
		openedBy: "client",
		conversation: { $exists: true, $ne: [] },
	};
	if (currentId) filter._id = { $ne: currentId };
	if (hotelId) filter.hotelId = hotelId;
	if (stableMatches.length) {
		filter.$or = stableMatches;
	} else if (names.length && hotelId) {
		filter.displayName1 = { $in: names };
	} else {
		return [];
	}

	try {
		return await SupportCase.find(filter)
			.select(
				"_id hotelId displayName1 displayName2 preferredLanguage preferredLanguageCode caseStatus escalationStatus aiHandoffReason createdAt updatedAt conversation"
			)
			.populate("hotelId", "hotelName hotelNameSlug")
			.sort({ updatedAt: -1, createdAt: -1 })
			.limit(Math.max(1, Math.min(Number(limit) || 4, 6)))
			.lean()
			.exec();
	} catch (error) {
		console.error("[aiagent] previous guest chat lookup failed:", error?.message || error);
		return [];
	}
}

const learningTokens = (text = "") =>
	String(text || "")
		.toLowerCase()
		.replace(/https?:\/\/\S+/g, " ")
		.replace(/[^a-z0-9\u00C0-\u024F\u0600-\u06FF\u0900-\u097F\s]/gi, " ")
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
		doc.sourceType,
		doc.chatTitle,
		doc.summary,
		doc.customerIntent,
		doc.supportResolution,
		...(doc.learningNotes || []),
		...(doc.responseGuidance || []),
		...(Array.isArray(doc.conversation)
			? doc.conversation.map((turn) => turn?.message || "")
			: []),
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
				"sourceType chatTitle chatKeywords conversation summary language customerIntent supportResolution learningNotes responseGuidance hotelId hotelName updatedAt createdAt"
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

async function listRelevantTrainingChats({
	hotelId,
	text,
	limit = 4,
	includeGlobal = true,
} = {}) {
	const safeHotelId = safeId(hotelId);
	const scopedFilter = { status: "active" };
	if (safeHotelId) {
		if (includeGlobal) {
			scopedFilter.$or = [
				{ hotelId: safeHotelId },
				{ hotelId: null },
				{ hotelId: { $exists: false } },
			];
		} else {
			scopedFilter.hotelId = safeHotelId;
		}
	}
	const [learningDocs, legacyTrainingDocs] = await Promise.all([
		findTrainingDocs(AiAgentLearning, scopedFilter),
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
	listPreviousGuestSupportChats,
	listRelevantTrainingChats,
};
