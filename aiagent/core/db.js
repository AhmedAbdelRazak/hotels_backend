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

function buildSupportCaseAppendUpdate(messageOrFields = {}) {
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
	return update;
}

async function updateSupportCaseAppend(caseId, messageOrFields) {
	const _id = safeId(caseId);
	if (!_id) return null;

	const update = buildSupportCaseAppendUpdate(messageOrFields);

	return SupportCase.findByIdAndUpdate(_id, update, { new: true })
		.lean()
		.exec();
}

async function updateSupportCaseAppendIfNoRecentAiDuplicate(
	caseId,
	messageOrFields,
	{ duplicateWindowMs = 2 * 60 * 1000 } = {}
) {
	const _id = safeId(caseId);
	if (!_id) return { updatedCase: null, skipped: true };

	const message = messageOrFields?.conversation || {};
	const update = buildSupportCaseAppendUpdate(messageOrFields);
	const filter = { _id };
	const text = String(message.message || "").trim();
	const userId = String(message.messageBy?.userId || "").trim();
	if ((message.isAi === true || message.isSystem === true) && text) {
		const cutoff = new Date(Date.now() - Math.max(1000, Number(duplicateWindowMs) || 0));
		const duplicateMatch = {
			message: text,
			date: { $gte: cutoff },
		};
		if (message.isAi === true) duplicateMatch.isAi = true;
		if (message.isSystem === true) duplicateMatch.isSystem = true;
		if (userId) duplicateMatch["messageBy.userId"] = userId;
		filter.$nor = [{ conversation: { $elemMatch: duplicateMatch } }];
	}

	const updatedCase = await SupportCase.findOneAndUpdate(filter, update, {
		new: true,
	})
		.lean()
		.exec();
	if (updatedCase) return { updatedCase, skipped: false };
	return {
		updatedCase: await SupportCase.findById(_id).lean().exec(),
		skipped: true,
	};
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

async function closeSupportCaseForAiIdle(
	caseId,
	{ now = new Date(), reason = "ai_idle_timeout" } = {}
) {
	const _id = safeId(caseId);
	if (!_id) return null;
	return SupportCase.findOneAndUpdate(
		{
			_id,
			openedBy: "client",
			caseStatus: "open",
			aiToRespond: true,
		},
		{
			$set: {
				caseStatus: "closed",
				closedAt: now,
				closedBy: "csr",
				updatedAt: now,
				aiToRespond: false,
				aiPausedAt: now,
				aiHandoffReason: reason,
				"conversation.$[].seenByAdmin": true,
				"conversation.$[].seenByHotel": true,
				"conversation.$[].seenByCustomer": true,
			},
		},
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
				"hotelAddress",
				"hotelCity",
				"hotelState",
				"hotelCountry",
				"aboutHotel",
				"aboutHotelArabic",
				"distances",
				"location",
				"parkingLot",
				"hasBusService",
				"busDetails",
				"isNusuk",
				"isNusukText",
				"hotelPolicyQA",
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
			"_id hotelName hotelName_OtherLanguage hotelAddress hotelCity hotelState hotelCountry aboutHotel aboutHotelArabic distances location parkingLot hasBusService busDetails isNusuk isNusukText hotelPolicyQA roomCountDetails currency aiToRespond activateHotel xHotelProActive belongsTo"
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

async function getReservationById(id) {
	const _id = safeId(id);
	if (!_id) return null;
	return Reservations.findById(_id).lean().exec();
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

const LEARNING_STOPWORDS = new Set([
	"about",
	"active",
	"agent",
	"arabic",
	"booking",
	"case",
	"chat",
	"client",
	"context",
	"customer",
	"details",
	"english",
	"guest",
	"hotel",
	"hotels",
	"inquiry",
	"jannat",
	"language",
	"message",
	"preferred",
	"reservation",
	"room",
	"rooms",
	"slots",
	"support",
	"\u0641\u0646\u062f\u0642",
	"\u0627\u0644\u0641\u0646\u062f\u0642",
	"\u062d\u062c\u0632",
	"\u0627\u0644\u062d\u062c\u0632",
	"\u063a\u0631\u0641\u0629",
	"\u0627\u0644\u063a\u0631\u0641\u0629",
	"\u062f\u0639\u0645",
	"ÙÙ†Ø¯Ù‚",
	"Ø§Ù„ÙÙ†Ø¯Ù‚",
	"Ø­Ø¬Ø²",
	"Ø§Ù„Ø­Ø¬Ø²",
	"ØºØ±ÙØ©",
	"Ø§Ù„ØºØ±ÙØ©",
	"Ø¯Ø¹Ù…",
]);

const normalizeTrainingLanguage = (value = "") => {
	const text = String(value || "").trim().toLowerCase();
	if (!text) return "";
	if (/arabic|\bar\b|\u0639\u0631\u0628/.test(text)) return "arabic";
	if (/arabic|\bar\b|Ø¹Ø±Ø¨/.test(text)) return "arabic";
	if (/urdu|\bur\b/.test(text)) return "urdu";
	if (/hindi|\bhi\b/.test(text)) return "hindi";
	if (/spanish|\bes\b|espa/.test(text)) return "spanish";
	if (/french|\bfr\b|fran/.test(text)) return "french";
	if (/indonesian|\bindonesia\b|\bid\b/.test(text)) return "indonesian";
	if (/malay|malaysia|malaysian|\bms\b/.test(text)) return "malay";
	if (/english|\ben\b/.test(text)) return "english";
	return text.replace(/[^a-z]+/g, " ").trim();
};

const languageMatchesLearning = (docLanguage = "", targetLanguage = "") => {
	const doc = normalizeTrainingLanguage(docLanguage);
	const target = normalizeTrainingLanguage(targetLanguage);
	if (!doc || !target) return false;
	if (doc === target) return true;
	if (target === "arabic" && doc.startsWith("arabic")) return true;
	if (target === "malay" && /malay/.test(doc)) return true;
	return false;
};

const learningTokens = (text = "") =>
	Array.from(
		new Set(
			String(text || "")
				.toLowerCase()
				.replace(/https?:\/\/\S+/g, " ")
				.replace(/[^a-z0-9\u00C0-\u024F\u0600-\u06FF\u0900-\u097F\s]/gi, " ")
				.split(/\s+/)
				.map((word) => word.trim())
				.filter((word) => word.length >= 4 && !LEARNING_STOPWORDS.has(word))
		)
	);

function scoreTrainingChat(doc = {}, queryTokens = new Set(), hotelId = "", language = "") {
	let score = 0;
	let keywordMatches = 0;
	let contentMatches = 0;
	const docHotelId = doc.hotelId ? String(doc.hotelId) : "";
	if (hotelId && docHotelId === hotelId) score += 8;
	if (languageMatchesLearning(doc.language, language)) score += 2;
	const keywords = Array.isArray(doc.chatKeywords) ? doc.chatKeywords : [];
	keywords.forEach((keyword) => {
		learningTokens(keyword).forEach((token) => {
			if (queryTokens.has(token)) {
				keywordMatches += 1;
				score += 5;
			}
		});
	});
	const haystack = [
		doc.sourceType,
		doc.chatTitle,
		doc.summary,
		doc.customerIntent,
		doc.supportResolution,
		...(doc.learningNotes || []),
		...(doc.responseGuidance || []),
		...(doc.decisionRules || []),
		...(doc.recommendedResponses || []),
		...(doc.commonQuestions || []),
		...(doc.tags || []),
	]
		.join(" ")
		.toLowerCase();
	queryTokens.forEach((token) => {
		if (haystack.includes(token)) {
			contentMatches += 1;
			score += 1;
		}
	});
	if (Number(doc.qualityScore || doc.confidenceScore || 0) >= 0.75) score += 1;
	return {
		score,
		keywordMatches,
		contentMatches,
		languageMatched: languageMatchesLearning(doc.language, language),
	};
}

function shouldIncludeLearningExampleTurns() {
	return (
		String(process.env.AI_LEARNING_INCLUDE_EXAMPLE_TURNS || "")
			.trim()
			.toLowerCase() === "true"
	);
}

function trainingLookupLimit() {
	const parsed = parseInt(process.env.AI_LEARNING_LOOKUP_LIMIT || "", 10);
	if (!Number.isFinite(parsed)) return 30;
	return Math.max(10, Math.min(parsed, 40));
}

async function findTrainingDocs(Model, filter) {
	try {
		const fields = [
			"sourceType",
			"chatTitle",
			"chatKeywords",
			"summary",
			"language",
			"customerIntent",
			"supportResolution",
			"learningNotes",
			"responseGuidance",
			"decisionRules",
			"recommendedResponses",
			"commonQuestions",
			"qualityScore",
			"confidenceScore",
			"tags",
			"messageCount",
			"hotelId",
			"hotelName",
			"updatedAt",
			"createdAt",
		];
		if (shouldIncludeLearningExampleTurns()) fields.push("conversation");
		return await Model.find(filter)
			.select(fields.join(" "))
			.sort({ updatedAt: -1, createdAt: -1 })
			.limit(trainingLookupLimit())
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
	language,
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
	if (!tokens.size) return [];
	const hotelIdString = safeHotelId ? String(safeHotelId) : "";
	const sortedDocs = docs
		.map((doc) => {
			const relevance = scoreTrainingChat(doc, tokens, hotelIdString, language);
			return {
				...doc,
				_relevanceScore: relevance.score,
				_learningSignalMatches:
					relevance.keywordMatches + relevance.contentMatches,
				_learningLanguageMatched: relevance.languageMatched,
			};
		})
		.filter(
			(doc) =>
				doc._learningSignalMatches > 0 &&
				doc._relevanceScore >= (hotelIdString ? 3 : 4)
		)
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
		picked.push(doc);
		seenLanguages.add(String(doc.language || "unknown").toLowerCase());
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
	updateSupportCaseAppendIfNoRecentAiDuplicate,
	closeSupportCaseForAiIdle,
	setCaseStatus,
	getHotelById,
	getJanatAiSettings,
	listActivePublicHotels,
	getReservationByConfirmation,
	getReservationById,
	listPreviousGuestSupportChats,
	listRelevantTrainingChats,
};
