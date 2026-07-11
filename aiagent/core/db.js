// aiagent/core/db.js
const mongoose = require("mongoose");
const SupportCase = require("../../models/supportcase");
const HotelDetails = require("../../models/hotel_details");
const Reservations = require("../../models/reservations");
const Janat = require("../../models/janat");
const AiAgentLearning = require("../../models/aiagent_learning");
const AiAgentTrainingChat = require("../../models/aiagent_training_chat");

const AI_HOTEL_CONTEXT_CACHE_TTL_MS = Number(
	process.env.AI_HOTEL_CONTEXT_CACHE_TTL_MS || 60000
);
const AI_SETTINGS_CACHE_TTL_MS = Number(
	process.env.AI_SETTINGS_CACHE_TTL_MS || 10000
);
const hotelContextCache = new Map();
let janatAiSettingsCache = null;

const HOTEL_AI_BASE_SELECT = [
	"_id",
	"hotelName",
	"hotelName_OtherLanguage",
	"hotelAddress",
	"hotelCity",
	"hotelState",
	"hotelCountry",
	"propertyType",
	"aboutHotel",
	"aboutHotelArabic",
	"distances",
	"location",
	"parkingLot",
	"hasBusService",
	"busDetails",
	"hasMealsService",
	"mealsDetails",
	"isNusuk",
	"isNusukText",
	"hotelPolicyQA",
	"currency",
	"aiToRespond",
	"activateHotel",
	"xHotelProActive",
	"belongsTo",
	"updatedAt",
	"+openaiKnowledge",
];

const ROOM_AI_CONTEXT_SELECT = [
	"roomCountDetails._id",
	"roomCountDetails.roomType",
	"roomCountDetails.displayName",
	"roomCountDetails.displayName_OtherLanguage",
	"roomCountDetails.description",
	"roomCountDetails.description_OtherLanguage",
	"roomCountDetails.amenities",
	"roomCountDetails.views",
	"roomCountDetails.extraAmenities",
	"roomCountDetails.price",
	"roomCountDetails.count",
	"roomCountDetails.activeRoom",
	"roomCountDetails.commisionIncluded",
	"roomCountDetails.refundPolicyDays",
	"roomCountDetails.roomSize",
	"roomCountDetails.defaultCost",
	"roomCountDetails.roomCommission",
	"roomCountDetails.bedsCount",
	"roomCountDetails.roomForGender",
	"roomCountDetails.roomColor",
	"roomCountDetails.offers",
	"roomCountDetails.monthly",
];

function compactPricingRateForAi(row = {}) {
	const calendarDate = String(row?.calendarDate || row?.date || "").slice(0, 10);
	if (!calendarDate) return null;
	return {
		calendarDate,
		price: row.price,
		rootPrice: row.rootPrice,
		commissionRate: row.commissionRate,
		color: row.color,
		backgroundColor: row.backgroundColor,
		status: row.status,
		state: row.state,
		availability: row.availability,
		type: row.type,
		blocked: row.blocked,
		isBlocked: row.isBlocked,
		restricted: row.restricted,
		isRestricted: row.isRestricted,
		calendarBlocked: row.calendarBlocked,
		unavailable: row.unavailable,
	};
}

function isoDateOnly(value = "") {
	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) return "";
	return date.toISOString().slice(0, 10);
}

function compactOffersForAi(offers = []) {
	const today = new Date();
	today.setUTCHours(0, 0, 0, 0);
	return (Array.isArray(offers) ? offers : [])
		.map((offer) => ({
			offerName: String(offer?.offerName || "").trim(),
			offerFrom: isoDateOnly(offer?.offerFrom),
			offerTo: isoDateOnly(offer?.offerTo),
			offerPrice: Number.isFinite(Number(offer?.offerPrice))
				? Number(offer.offerPrice)
				: null,
		}))
		.filter((offer) => {
			if (!offer.offerName && !offer.offerPrice) return false;
			if (!offer.offerTo) return true;
			return new Date(`${offer.offerTo}T23:59:59.999Z`) >= today;
		})
		.slice(0, 6);
}

function compactMonthlyForAi(monthly = []) {
	const today = new Date();
	today.setUTCHours(0, 0, 0, 0);
	return (Array.isArray(monthly) ? monthly : [])
		.map((month) => ({
			monthName: String(month?.monthName || "").trim(),
			monthFrom: isoDateOnly(month?.monthFrom),
			monthTo: isoDateOnly(month?.monthTo),
			monthFromHijri: String(month?.monthFromHijri || "").trim(),
			monthToHijri: String(month?.monthToHijri || "").trim(),
			monthPrice: Number.isFinite(Number(month?.monthPrice))
				? Number(month.monthPrice)
				: null,
		}))
		.filter((month) => {
			if (!month.monthName && !month.monthPrice) return false;
			if (!month.monthTo) return true;
			return new Date(`${month.monthTo}T23:59:59.999Z`) >= today;
		})
		.slice(0, 6);
}

function dateOnlyKey(value = "") {
	return String(value || "").slice(0, 10);
}

function normalizeDateKeys(values = []) {
	return [
		...new Set(
			(Array.isArray(values) ? values : [])
				.map(dateOnlyKey)
				.filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value))
		),
	].slice(0, 90);
}

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
	const supportCase = await SupportCase.findById(_id)
		.select("+aiStateSnapshot")
		.lean()
		.exec();
	return normalizeSupportCaseQuickReplies(supportCase);
}

function normalizeQuickReplyAction(action = "") {
	const value = String(action || "").trim().slice(0, 60);
	if (["continue_booking", "proceed_to_booking", "continue"].includes(value)) {
		return "proceed";
	}
	if (value === "confirm_reservation") return "place_reservation";
	return value;
}

function normalizeConversationQuickReplies(conversation = {}) {
	if (!conversation || typeof conversation !== "object") return conversation;
	if (!Array.isArray(conversation.quickReplies)) return conversation;
	return {
		...conversation,
		quickReplies: conversation.quickReplies.slice(0, 6).map((reply) => ({
			...reply,
			action: normalizeQuickReplyAction(reply?.action),
		})),
	};
}

function normalizeSupportCaseQuickReplies(supportCase) {
	if (!supportCase || !Array.isArray(supportCase.conversation)) {
		return supportCase;
	}
	return {
		...supportCase,
		conversation: supportCase.conversation.map(normalizeConversationQuickReplies),
	};
}

function buildSupportCaseAppendUpdate(messageOrFields = {}) {
	const update = {};
	if (messageOrFields && messageOrFields.conversation) {
		update.$push = {
			conversation: normalizeConversationQuickReplies(messageOrFields.conversation),
		};
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

	const supportCase = await SupportCase.findByIdAndUpdate(_id, update, { new: true })
		.lean()
		.exec();
	return normalizeSupportCaseQuickReplies(supportCase);
}

async function updateSupportCaseAiStateSnapshot(caseId, snapshot = null) {
	const _id = safeId(caseId);
	if (!_id) return false;
	await SupportCase.updateOne(
		{ _id },
		{
			$set: {
				aiStateSnapshot: snapshot,
			},
		}
	).exec();
	return true;
}

async function updateSupportCaseAppendIfNoRecentAiDuplicate(
	caseId,
	messageOrFields,
	{
		duplicateWindowMs = 2 * 60 * 1000,
		duplicateAfter = null,
		requireOpenClientAi = false,
		requireLatestGuestText = "",
		requireNoAiAfter = null,
		skipDuplicateCheck = false,
	} = {}
) {
	const _id = safeId(caseId);
	if (!_id) return { updatedCase: null, skipped: true };

	const message = messageOrFields?.conversation || {};
	const update = buildSupportCaseAppendUpdate(messageOrFields);
	const filter = { _id };
	if (requireOpenClientAi) {
		filter.openedBy = "client";
		filter.caseStatus = "open";
		filter.aiToRespond = true;
	}
	const latestGuestText = String(requireLatestGuestText || "").trim();
	if (latestGuestText) {
		filter.$expr = {
			$eq: [
				{
					$let: {
						vars: {
							latestGuest: {
								$arrayElemAt: [
									{
										$filter: {
											input: "$conversation",
											as: "entry",
											cond: {
												$and: [
													{ $ne: ["$$entry.isAi", true] },
													{ $ne: ["$$entry.isSystem", true] },
												],
											},
										},
									},
									-1,
								],
							},
						},
						in: {
							$trim: { input: { $ifNull: ["$$latestGuest.message", ""] } },
						},
					},
				},
				latestGuestText,
			],
		};
	}
	const text = String(message.message || "").trim();
	const userId = String(message.messageBy?.userId || "").trim();
	const norFilters = [];
	const noAiAfterDate =
		requireNoAiAfter instanceof Date
			? requireNoAiAfter
			: Number.isFinite(Number(requireNoAiAfter))
			? new Date(Number(requireNoAiAfter))
			: null;
	if (noAiAfterDate && Number.isFinite(noAiAfterDate.getTime())) {
		norFilters.push({
			conversation: {
				$elemMatch: {
					isAi: true,
					isSystem: { $ne: true },
					date: { $gt: noAiAfterDate },
				},
			},
		});
	}
	if (!skipDuplicateCheck && (message.isAi === true || message.isSystem === true) && text) {
		const cutoff = new Date(Date.now() - Math.max(1000, Number(duplicateWindowMs) || 0));
		const duplicateAfterDate =
			duplicateAfter instanceof Date
				? duplicateAfter
				: Number.isFinite(Number(duplicateAfter))
				? new Date(Number(duplicateAfter))
				: null;
		const duplicateDate = { $gte: cutoff };
		if (duplicateAfterDate && Number.isFinite(duplicateAfterDate.getTime())) {
			duplicateDate.$gt = duplicateAfterDate;
		}
		const duplicateMatch = {
			message: text,
			date: duplicateDate,
		};
		if (message.isAi === true) duplicateMatch.isAi = true;
		if (message.isSystem === true) duplicateMatch.isSystem = true;
		if (userId) duplicateMatch["messageBy.userId"] = userId;
		norFilters.push({ conversation: { $elemMatch: duplicateMatch } });
	}
	if (norFilters.length) filter.$nor = norFilters;

	const updatedCase = await SupportCase.findOneAndUpdate(filter, update, {
		new: true,
	})
		.lean()
		.exec();
	if (updatedCase) {
		return {
			updatedCase: normalizeSupportCaseQuickReplies(updatedCase),
			skipped: false,
		};
	}
	return {
		updatedCase: normalizeSupportCaseQuickReplies(
			await SupportCase.findById(_id).lean().exec()
		),
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
	{ now = new Date(), reason = "ai_idle_timeout", latestAiDate = null } = {}
) {
	const _id = safeId(caseId);
	if (!_id) return null;
	const filter = {
		_id,
		openedBy: "client",
		caseStatus: "open",
		aiToRespond: true,
	};
	const expectedAiDate =
		latestAiDate instanceof Date
			? latestAiDate
			: latestAiDate
			? new Date(latestAiDate)
			: null;
	if (expectedAiDate && Number.isFinite(expectedAiDate.getTime())) {
		filter.$expr = {
			$let: {
				vars: {
					latestEntry: { $arrayElemAt: ["$conversation", -1] },
				},
				in: {
					$and: [
						{ $eq: ["$$latestEntry.isAi", true] },
						{ $ne: ["$$latestEntry.isSystem", true] },
						{ $eq: ["$$latestEntry.date", expectedAiDate] },
					],
				},
			},
		};
	}
	return SupportCase.findOneAndUpdate(
		filter,
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
		.select(
			"_id openedBy caseStatus aiToRespond hotelId updatedAt closedAt closedBy aiHandoffReason aiPausedAt displayName1 displayName2 supporterName clientName clientContact clientContactType preferredLanguage preferredLanguageCode supportScope sourceWebsite sourcePage sourceUrl aiRelated aiReservation escalationStatus escalationReason"
		)
		.lean()
		.exec();
}

async function listOpenClientAiCasesForIdleSweep({ limit = 100 } = {}) {
	const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 100));
	const cases = await SupportCase.aggregate([
		{
			$match: {
				openedBy: "client",
				caseStatus: "open",
				aiToRespond: true,
				conversation: { $exists: true, $ne: [] },
			},
		},
		{ $sort: { updatedAt: -1, _id: -1 } },
		{ $limit: safeLimit },
		{
			$project: {
				_id: 1,
				openedBy: 1,
				caseStatus: 1,
				aiToRespond: 1,
				updatedAt: 1,
				conversation: [{ $arrayElemAt: ["$conversation", -1] }],
			},
		},
	]).exec();
	return cases.map(normalizeSupportCaseQuickReplies);
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
		pricedExtras: [],
		price: room.price,
		// Full pricing histories can be very large. Quote flows hydrate only the
		// requested stay dates through getHotelByIdWithPricingDates.
		pricingRate: [],
		monthly: compactMonthlyForAi(room.monthly),
		offers: compactOffersForAi(room.offers),
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
	const knowledge = hotel.openaiKnowledge
		? {
				provider: String(hotel.openaiKnowledge.provider || ""),
				status: String(hotel.openaiKnowledge.status || ""),
				knowledgeVersion: Number(hotel.openaiKnowledge.knowledgeVersion || 0) || 0,
				coverageFrom: String(hotel.openaiKnowledge.coverageFrom || ""),
				coverageThrough: String(hotel.openaiKnowledge.coverageThrough || ""),
		  }
		: undefined;
	return {
		...hotel,
		openaiKnowledge: knowledge,
		roomCountDetails: Array.isArray(hotel.roomCountDetails)
			? hotel.roomCountDetails.map(compactRoomForAi)
			: [],
	};
}

function cloneCompactHotelForAi(hotel = null) {
	if (!hotel) return null;
	return {
		...hotel,
		distances: hotel.distances ? { ...hotel.distances } : hotel.distances,
		location: hotel.location ? { ...hotel.location } : hotel.location,
		hotelPolicyQA: Array.isArray(hotel.hotelPolicyQA)
			? hotel.hotelPolicyQA.map((row) => ({ ...row }))
			: hotel.hotelPolicyQA,
		roomCountDetails: Array.isArray(hotel.roomCountDetails)
			? hotel.roomCountDetails.map((room) => ({
					...room,
					amenities: Array.isArray(room.amenities) ? [...room.amenities] : room.amenities,
					views: Array.isArray(room.views) ? [...room.views] : room.views,
					extraAmenities: Array.isArray(room.extraAmenities)
						? [...room.extraAmenities]
						: room.extraAmenities,
					pricedExtras: Array.isArray(room.pricedExtras)
						? room.pricedExtras.map((extra) => ({ ...extra }))
						: room.pricedExtras,
					monthly: Array.isArray(room.monthly)
						? room.monthly.map((month) => ({ ...month }))
						: room.monthly,
					offers: Array.isArray(room.offers)
						? room.offers.map((offer) => ({ ...offer }))
						: room.offers,
			  }))
			: [],
	};
}

function normalizeReadyHotelOpenAiKnowledge(hotel = null) {
	if (!hotel?._id) return null;
	const knowledge = hotel.openaiKnowledge;
	const provider = String(knowledge?.provider || "").trim().toLowerCase();
	const status = String(knowledge?.status || "").trim().toLowerCase();
	const vectorStoreId = String(knowledge?.vectorStoreId || "").trim();
	if (
		provider !== "openai" ||
		status !== "ready" ||
		!/^vs_[A-Za-z0-9_-]+$/.test(vectorStoreId)
	) {
		return null;
	}

	// A hotel update queues a replacement vector asynchronously. Do not expose
	// the previous ready pointer in the gap before that replacement is published.
	const hotelUpdatedAt = hotel.updatedAt
		? new Date(hotel.updatedAt).getTime()
		: NaN;
	const sourceUpdatedAt = knowledge.sourceUpdatedAt
		? new Date(knowledge.sourceUpdatedAt).getTime()
		: NaN;
	if (
		Number.isFinite(hotelUpdatedAt) &&
		(!Number.isFinite(sourceUpdatedAt) || sourceUpdatedAt !== hotelUpdatedAt)
	) {
		return null;
	}

	return {
		hotelId: String(hotel._id),
		provider,
		status,
		vectorStoreId,
		knowledgeVersion: Number(knowledge.knowledgeVersion || 0) || 0,
		sourceSha256: String(knowledge.sourceSha256 || "").trim(),
		documentSha256: String(knowledge.documentSha256 || "").trim(),
		coverageFrom: String(knowledge.coverageFrom || "").trim(),
		coverageThrough: String(knowledge.coverageThrough || "").trim(),
	};
}

async function getReadyHotelOpenAiKnowledge(id) {
	const _id = safeId(id);
	if (!_id) return null;
	const hotel = await HotelDetails.findOne({
		_id,
		activateHotel: true,
		xHotelProActive: { $ne: false },
		"openaiKnowledge.provider": "openai",
		"openaiKnowledge.status": "ready",
	})
		.select("_id updatedAt +openaiKnowledge")
		.lean()
		.exec();
	return normalizeReadyHotelOpenAiKnowledge(hotel);
}

async function getHotelById(id) {
	const _id = safeId(id);
	if (!_id) return null;
	const cacheKey = String(_id);
	const cached = hotelContextCache.get(cacheKey);
	if (cached && cached.expiresAt > Date.now()) {
		return cloneCompactHotelForAi(cached.hotel);
	}
	const hotel = await HotelDetails.findById(_id)
		.select([...HOTEL_AI_BASE_SELECT, ...ROOM_AI_CONTEXT_SELECT].join(" "))
		.lean()
		.exec();
	const compactHotel = compactHotelForAi(hotel);
	if (compactHotel) {
		hotelContextCache.set(cacheKey, {
			hotel: compactHotel,
			expiresAt: Date.now() + AI_HOTEL_CONTEXT_CACHE_TTL_MS,
		});
		if (hotelContextCache.size > 200) {
			const firstKey = hotelContextCache.keys().next().value;
			if (firstKey) hotelContextCache.delete(firstKey);
		}
	}
	return cloneCompactHotelForAi(compactHotel);
}

async function getHotelByIdForAiContext(id) {
	const _id = safeId(id);
	if (!_id) return null;
	// Hotel facts shown to guests must reflect a committed PMS edit immediately.
	// Exact quote reads already bypass this cache; keep the prompt/fact path just
	// as fresh so it cannot disagree with a newly synchronized knowledge vector.
	const hotel = await HotelDetails.findById(_id)
		.select([...HOTEL_AI_BASE_SELECT, ...ROOM_AI_CONTEXT_SELECT].join(" "))
		.lean()
		.exec();
	const compactHotel = compactHotelForAi(hotel);
	return cloneCompactHotelForAi(compactHotel);
}

async function getHotelByIdWithPricingDates(id, dateKeys = []) {
	const _id = safeId(id);
	const dates = normalizeDateKeys(dateKeys);
	if (!_id) return null;
	const maxSnapshotAttempts = 2;
	for (let attempt = 1; attempt <= maxSnapshotAttempts; attempt += 1) {
		// Exact quote/finalization paths intentionally bypass the hotel-facts cache
		// so a PMS price, blackout, capacity, or physical-count edit is immediate.
		const freshHotel = await HotelDetails.findById(_id)
			.select([...HOTEL_AI_BASE_SELECT, ...ROOM_AI_CONTEXT_SELECT].join(" "))
			.lean()
			.exec();
		const hotel = compactHotelForAi(freshHotel);
		if (!hotel || !dates.length) return hotel;

		const [pricingDoc] = await HotelDetails.aggregate([
			{ $match: { _id } },
			{
				$project: {
					updatedAt: 1,
					roomCountDetails: {
						$map: {
							input: { $ifNull: ["$roomCountDetails", []] },
							as: "room",
							in: {
								_id: "$$room._id",
								roomType: "$$room.roomType",
								pricingRate: {
									$map: {
										input: {
											$filter: {
												input: { $ifNull: ["$$room.pricingRate", []] },
												as: "rate",
												cond: {
													$in: [
														{
															$substrBytes: [
																{
																	$toString: {
																		$ifNull: [
																			"$$rate.calendarDate",
																			{ $ifNull: ["$$rate.date", ""] },
																		],
																	},
																},
																0,
																10,
															],
														},
														dates,
													],
												},
											},
										},
										as: "rate",
										in: {
											calendarDate: {
												$substrBytes: [
													{
														$toString: {
															$ifNull: [
																"$$rate.calendarDate",
																{ $ifNull: ["$$rate.date", ""] },
															],
														},
													},
													0,
													10,
												],
											},
											price: "$$rate.price",
											rootPrice: "$$rate.rootPrice",
											commissionRate: "$$rate.commissionRate",
											color: "$$rate.color",
											backgroundColor: "$$rate.backgroundColor",
											status: "$$rate.status",
											state: "$$rate.state",
											availability: "$$rate.availability",
											type: "$$rate.type",
											blocked: "$$rate.blocked",
											isBlocked: "$$rate.isBlocked",
											restricted: "$$rate.restricted",
											isRestricted: "$$rate.isRestricted",
											calendarBlocked: "$$rate.calendarBlocked",
											unavailable: "$$rate.unavailable",
										},
									},
								},
							},
						},
					},
				},
			},
		]).exec();

		const hotelUpdatedAt = new Date(hotel.updatedAt || 0).getTime();
		const pricingUpdatedAt = new Date(pricingDoc?.updatedAt || 0).getTime();
		const snapshotsMatch =
			Number.isFinite(hotelUpdatedAt) &&
			hotelUpdatedAt > 0 &&
			Number.isFinite(pricingUpdatedAt) &&
			pricingUpdatedAt > 0 &&
			hotelUpdatedAt === pricingUpdatedAt;
		if (!snapshotsMatch) {
			if (attempt < maxSnapshotAttempts) continue;
			const error = new Error(
				"Hotel pricing changed while the quote was being loaded. Please retry."
			);
			error.code = "hotel_pricing_snapshot_changed";
			throw error;
		}

		const byRoomId = new Map();
		(pricingDoc?.roomCountDetails || []).forEach((room) => {
			const compactRows = Array.isArray(room.pricingRate)
				? room.pricingRate.map(compactPricingRateForAi).filter(Boolean)
				: [];
			byRoomId.set(String(room._id || ""), compactRows);
		});

		return {
			...hotel,
			roomCountDetails: Array.isArray(hotel.roomCountDetails)
				? hotel.roomCountDetails.map((room) => ({
						...room,
						pricingRate:
							byRoomId.get(String(room._id || "")) || [],
				  }))
				: [],
		};
	}
	return null;
}

async function getJanatAiSettings() {
	if (janatAiSettingsCache && janatAiSettingsCache.expiresAt > Date.now()) {
		return { ...janatAiSettingsCache.settings };
	}
	const doc = await Janat.findOne({})
		.sort({ updatedAt: -1, createdAt: -1, _id: -1 })
		.select("aiToRespond")
		.lean()
		.exec();
	const settings = {
		aiToRespond: !doc || doc.aiToRespond !== false,
	};
	janatAiSettingsCache = {
		settings,
		expiresAt: Date.now() + AI_SETTINGS_CACHE_TTL_MS,
	};
	return { ...settings };
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
		.select([...HOTEL_AI_BASE_SELECT, ...ROOM_AI_CONTEXT_SELECT].join(" "))
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

async function listHotelReservationsByExactStay({
	hotelId,
	checkinISO,
	checkoutISO,
	limit = 20,
} = {}) {
	const safeHotelId = safeId(hotelId);
	if (
		!safeHotelId ||
		!/^\d{4}-\d{2}-\d{2}$/.test(String(checkinISO || "")) ||
		!/^\d{4}-\d{2}-\d{2}$/.test(String(checkoutISO || ""))
	) {
		return [];
	}
	const checkinStart = new Date(`${checkinISO}T00:00:00.000Z`);
	const checkinEnd = new Date(`${checkinISO}T23:59:59.999Z`);
	const checkoutStart = new Date(`${checkoutISO}T00:00:00.000Z`);
	const checkoutEnd = new Date(`${checkoutISO}T23:59:59.999Z`);
	if (
		Number.isNaN(checkinStart.getTime()) ||
		Number.isNaN(checkoutStart.getTime())
	) {
		return [];
	}
	const safeLimit = Math.max(1, Math.min(Number(limit) || 20, 50));
	try {
		return await Reservations.find({
			hotelId: safeHotelId,
			checkin_date: { $gte: checkinStart, $lte: checkinEnd },
			checkout_date: { $gte: checkoutStart, $lte: checkoutEnd },
		})
			.select(
				"_id hotelId hotelName confirmation_number customer_details checkin_date checkout_date days_of_residence total_amount currency payment payment_details paypal_details paid_amount paid_amount_breakdown reservation_status state total_rooms total_guests adults children pickedRoomsType pickedRoomsPricing pendingConfirmation createdAt updatedAt booked_at orderTakenAt aiSupportCaseId"
			)
			.sort({ createdAt: -1, booked_at: -1, orderTakenAt: -1, _id: -1 })
			.limit(safeLimit)
			.maxTimeMS(2500)
			.lean()
			.exec();
	} catch (error) {
		console.error("[aiagent] exact-stay reservation lookup failed:", error?.message || error);
		return [];
	}
}

async function listRecentHotelReservationsForExistingGuest({
	hotelId,
	since,
	limit = 150,
} = {}) {
	const safeHotelId = safeId(hotelId);
	const sinceDate =
		since instanceof Date ? since : since ? new Date(since) : new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
	if (!safeHotelId || Number.isNaN(sinceDate.getTime())) return [];
	const safeLimit = Math.max(1, Math.min(Number(limit) || 150, 300));
	try {
		return await Reservations.find({
			hotelId: safeHotelId,
			$or: [
				{ createdAt: { $gte: sinceDate } },
				{ booked_at: { $gte: sinceDate } },
				{ orderTakenAt: { $gte: sinceDate } },
			],
		})
			.select(
				"_id hotelId hotelName confirmation_number customer_details checkin_date checkout_date days_of_residence total_amount currency payment payment_details paypal_details paid_amount paid_amount_breakdown reservation_status state total_rooms total_guests adults children pickedRoomsType pickedRoomsPricing pendingConfirmation createdAt updatedAt booked_at orderTakenAt aiSupportCaseId"
			)
			.sort({ createdAt: -1, booked_at: -1, orderTakenAt: -1, _id: -1 })
			.limit(safeLimit)
			.maxTimeMS(2500)
			.lean()
			.exec();
	} catch (error) {
		console.error("[aiagent] recent hotel reservation lookup failed:", error?.message || error);
		return [];
	}
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
	updateSupportCaseAiStateSnapshot,
	closeSupportCaseForAiIdle,
	listOpenClientAiCasesForIdleSweep,
	setCaseStatus,
	getHotelById,
	getHotelByIdForAiContext,
	getHotelByIdWithPricingDates,
	getReadyHotelOpenAiKnowledge,
	normalizeReadyHotelOpenAiKnowledge,
	getJanatAiSettings,
	listActivePublicHotels,
	getReservationByConfirmation,
	listHotelReservationsByExactStay,
	listRecentHotelReservationsForExistingGuest,
	listPreviousGuestSupportChats,
	listRelevantTrainingChats,
};
