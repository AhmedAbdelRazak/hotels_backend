/** @format */

"use strict";

const mongoose = require("mongoose");
const User = require("../models/user");
const HotelDetails = require("../models/hotel_details");
const {
	orchestrateRoomText,
} = require("../services/overallRoomTextOrchestrator");
const {
	buildAgentRow,
	buildGeneralRow,
	buildPricingPlan,
	ensurePlanSize,
	normalizeId: normalizeCalendarId,
	toDateKey: toCalendarDateKey,
} = require("../services/overallCalendarPricingOrchestrator");

const ObjectId = mongoose.Types.ObjectId;

const ROOM_TYPE_COLORS = {
	standardRooms: "#003366",
	singleRooms: "#8B0000",
	doubleRooms: "#004d00",
	twinRooms: "#800080",
	queenRooms: "#FF8C00",
	kingRooms: "#2F4F4F",
	tripleRooms: "#8B4513",
	quadRooms: "#00008B",
	studioRooms: "#696969",
	suite: "#483D8B",
	masterSuite: "#556B2F",
	familyRooms: "#A52A2A",
	individualBed: "#064E3B",
};

const normalizeId = (value) => String(value?._id || value || "").trim();

const uniqueValidIds = (values = []) => [
	...new Set(
		(Array.isArray(values) ? values : [values])
			.map(normalizeId)
			.filter((id) => id && ObjectId.isValid(id))
	),
];

const compactRoomText = (value = "", limit = 500) =>
	String(value || "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, limit);

const normalizeRoomIdentity = (value = "") =>
	compactRoomText(value, 500).toLowerCase();

const toWholeNumber = (value, fallback = 0) => {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : fallback;
};

const toMoneyNumber = (value, fallback = 0) => {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const toBooleanDefault = (value, fallback = true) =>
	value === undefined || value === null
		? fallback
		: value === true || value === "true";

const normalizeRoomArray = (items = []) =>
	Array.isArray(items)
		? items
				.map((item) => compactRoomText(item, 90))
				.filter((item, index, list) => item && list.indexOf(item) === index)
		: [];

const randomDarkRoomColor = () => {
	const part = () =>
		Math.floor(Math.random() * 130)
			.toString(16)
			.padStart(2, "0");
	return `#${part()}${part()}${part()}`;
};

const pickRoomColor = (roomType = "", existingRooms = []) => {
	const existingColors = new Set(
		(existingRooms || []).map((room) => room?.roomColor).filter(Boolean)
	);
	const preferred = ROOM_TYPE_COLORS[roomType];
	if (preferred && !existingColors.has(preferred)) return preferred;
	let candidate = randomDarkRoomColor();
	let attempts = 0;
	while (existingColors.has(candidate) && attempts < 20) {
		candidate = randomDarkRoomColor();
		attempts += 1;
	}
	return candidate;
};

const roomToPlain = (room = {}) =>
	room && typeof room.toObject === "function" ? room.toObject() : { ...room };

const setupSnapshot = (hotel = {}) => {
	const roomsDone = !!hotel?.roomCountDetails?.length;
	const photosDone = !!hotel?.hotelPhotos?.length;
	const locationDone =
		Array.isArray(hotel?.location?.coordinates) &&
		hotel.location.coordinates[0] !== 0 &&
		hotel.location.coordinates[1] !== 0;
	const dataDone = Boolean(
		hotel?.aboutHotel || hotel?.aboutHotelArabic || hotel?.overallRoomsCount
	);
	const bankDone = !!hotel?.paymentSettings?.length;
	return {
		roomsDone,
		photosDone,
		locationDone,
		dataDone,
		bankDone,
		settingsDone: roomsDone && photosDone && locationDone && dataDone,
		activationReady: roomsDone && photosDone && locationDone && dataDone,
		activeHotel:
			hotel?.activateHotel === true && hotel?.xHotelProActive !== false,
		ownerActivatedHotel: hotel?.activateHotel === true,
		xHotelProActive: hotel?.xHotelProActive !== false,
	};
};

const serializeAdminSettingsHotel = (hotel = {}) => ({
	_id: normalizeId(hotel._id),
	hotelName: hotel.hotelName || "Hotel",
	ownerId: normalizeId(hotel.belongsTo),
	ownerName: hotel.belongsTo?.name || "",
	ownerEmail: hotel.belongsTo?.email || "",
	hotelAddress: hotel.hotelAddress || "",
	hotelCity: hotel.hotelCity || "",
	hotelState: hotel.hotelState || "",
	hotelCountry: hotel.hotelCountry || "",
	activateHotel: hotel.activateHotel === true && hotel.xHotelProActive !== false,
	ownerActivatedHotel: hotel.activateHotel === true,
	xHotelProActive: hotel.xHotelProActive !== false,
	overallRoomsCount: Number(hotel.overallRoomsCount || 0),
	roomTypes: Array.isArray(hotel.roomCountDetails)
		? hotel.roomCountDetails.length
		: 0,
	photos: Array.isArray(hotel.hotelPhotos) ? hotel.hotelPhotos.length : 0,
	setup: setupSnapshot(hotel),
	createdAt: hotel.createdAt,
	updatedAt: hotel.updatedAt,
});

const serializeAdminRoom = (room = {}) => {
	const plain = roomToPlain(room);
	return {
		_id: normalizeId(plain._id),
		roomType: plain.roomType || "",
		displayName: plain.displayName || "",
		displayName_OtherLanguage: plain.displayName_OtherLanguage || "",
		description: plain.description || "",
		description_OtherLanguage: plain.description_OtherLanguage || "",
		count: Number(plain.count || 0),
		price: {
			basePrice: Number(plain?.price?.basePrice || plain.basePrice || 0),
		},
		defaultCost: Number(plain.defaultCost || plain.rootPrice || 0),
		amenities: Array.isArray(plain.amenities) ? plain.amenities : [],
		views: Array.isArray(plain.views) ? plain.views : [],
		extraAmenities: Array.isArray(plain.extraAmenities)
			? plain.extraAmenities
			: [],
		activeRoom: plain.activeRoom !== false,
		bedsCount: Number(plain.bedsCount || 1),
		roomForGender: plain.roomForGender || "Unisex",
		roomColor: plain.roomColor || "",
		roomCommission: Number(plain.roomCommission || 0),
		commisionIncluded: plain.commisionIncluded === true,
	};
};

const serializeAdminRoomHotel = (hotel = {}) => {
	const rooms = Array.isArray(hotel.roomCountDetails)
		? hotel.roomCountDetails
		: [];
	return {
		_id: normalizeId(hotel._id),
		hotelName: hotel.hotelName || "Hotel",
		ownerId: normalizeId(hotel.belongsTo),
		ownerName: hotel.belongsTo?.name || "",
		ownerEmail: hotel.belongsTo?.email || "",
		overallRoomsCount: Number(hotel.overallRoomsCount || 0),
		roomTypes: rooms.length,
		rooms: rooms.map(serializeAdminRoom),
		setup: setupSnapshot(hotel),
		updatedAt: hotel.updatedAt,
	};
};

const serializeCalendarRoom = (room = {}) => {
	const plain = roomToPlain(room);
	return {
		_id: normalizeId(plain._id),
		roomType: plain.roomType || "",
		displayName:
			plain.displayName || plain.displayName_OtherLanguage || plain.roomType || "",
		displayName_OtherLanguage: plain.displayName_OtherLanguage || "",
		roomForGender: plain.roomForGender || "",
		count: Number(plain.count || 0),
		activeRoom: plain.activeRoom !== false,
		roomColor: plain.roomColor || "",
		pricingDays: Array.isArray(plain.pricingRate)
			? plain.pricingRate.length
			: 0,
		agentPricingDays: Array.isArray(plain.agentPricingRate)
			? plain.agentPricingRate.length
			: 0,
	};
};

const serializeCalendarHotel = (hotel = {}) => {
	const rooms = Array.isArray(hotel.roomCountDetails)
		? hotel.roomCountDetails
		: [];
	return {
		_id: normalizeId(hotel._id),
		hotelName: hotel.hotelName || "Hotel",
		ownerId: normalizeId(hotel.belongsTo),
		ownerName: hotel.belongsTo?.name || "",
		ownerEmail: hotel.belongsTo?.email || "",
		rooms: rooms.map(serializeCalendarRoom),
		roomTypes: rooms.length,
		overallRoomsCount: Number(hotel.overallRoomsCount || 0),
		updatedAt: hotel.updatedAt,
	};
};

const ADMIN_GLOBAL_OVERVIEW_SELECT =
	"_id hotelName belongsTo hotelAddress hotelCountry hotelState hotelCity overallRoomsCount roomCountDetails._id hotelPhotos._id location aboutHotel aboutHotelArabic paymentSettings._id activateHotel xHotelProActive createdAt updatedAt";
const ADMIN_GLOBAL_ROOM_MANAGER_SELECT =
	"_id hotelName belongsTo overallRoomsCount activateHotel xHotelProActive createdAt updatedAt roomCountDetails._id roomCountDetails.roomType roomCountDetails.displayName roomCountDetails.displayName_OtherLanguage roomCountDetails.description roomCountDetails.description_OtherLanguage roomCountDetails.count roomCountDetails.price roomCountDetails.defaultCost roomCountDetails.amenities roomCountDetails.views roomCountDetails.extraAmenities roomCountDetails.activeRoom roomCountDetails.bedsCount roomCountDetails.roomForGender roomCountDetails.roomColor roomCountDetails.roomCommission roomCountDetails.commisionIncluded";
const ADMIN_GLOBAL_CALENDAR_SELECT =
	"_id hotelName belongsTo overallRoomsCount createdAt updatedAt roomCountDetails._id roomCountDetails.roomType roomCountDetails.displayName roomCountDetails.displayName_OtherLanguage roomCountDetails.roomForGender roomCountDetails.count roomCountDetails.activeRoom roomCountDetails.roomColor";

const allHotelsQuery = (select = ADMIN_GLOBAL_OVERVIEW_SELECT) =>
	HotelDetails.find({})
		.select(select)
		.populate("belongsTo", "_id name email phone")
		.sort({ hotelName: 1 })
		.exec();

const requestedRoomHotelIds = (body = {}, action = "add") => {
	const rawIds =
		action === "add" && Array.isArray(body.hotelIds)
			? body.hotelIds
			: [body.hotelId];
	return rawIds.map(normalizeId).filter(Boolean);
};

const roomCountForHotel = (body = {}, hotelId = "", fallback = 1) => {
	const roomInput = body.room || {};
	const countMap =
		body.countsByHotelId ||
		body.hotelCounts ||
		roomInput.countsByHotelId ||
		roomInput.hotelCounts ||
		{};
	return toWholeNumber(
		countMap[hotelId] ??
			countMap[String(hotelId)] ??
			roomInput.count ??
			body.count,
		fallback
	);
};

const pricingEntryForHotel = (body = {}, hotelId = "") => {
	const roomInput = body.room || {};
	const priceMap =
		body.basePricesByHotelId ||
		body.hotelBasePrices ||
		body.pricesByHotelId ||
		body.basePriceByHotelId ||
		roomInput.basePricesByHotelId ||
		roomInput.hotelBasePrices ||
		roomInput.pricesByHotelId ||
		roomInput.basePriceByHotelId ||
		{};
	return priceMap[hotelId] ?? priceMap[String(hotelId)];
};

const roomPricingForHotel = (
	body = {},
	hotelId = "",
	fallbackBasePrice = 0,
	fallbackDefaultCost = fallbackBasePrice
) => {
	const roomInput = body.room || {};
	const rawEntry = pricingEntryForHotel(body, hotelId);
	const entry =
		rawEntry && typeof rawEntry === "object" && !Array.isArray(rawEntry)
			? rawEntry
			: {};
	const rawBasePrice =
		entry?.price?.basePrice ??
		entry.price ??
		entry.basePrice ??
		rawEntry ??
		roomInput.basePrice ??
		roomInput?.price?.basePrice ??
		body.basePrice;
	const basePrice = toMoneyNumber(rawBasePrice, fallbackBasePrice);
	const defaultCost = toMoneyNumber(
		entry.defaultCost ??
			entry.rootPrice ??
			entry.cost ??
			roomInput.defaultCost ??
			roomInput.rootPrice ??
			body.defaultCost ??
			body.rootPrice,
		basePrice || fallbackDefaultCost || fallbackBasePrice
	);
	return {
		basePrice,
		defaultCost: defaultCost || basePrice,
	};
};

const findRoomDuplicate = (rooms = [], candidate = {}, ignoreRoomId = "") => {
	const roomType = normalizeRoomIdentity(candidate.roomType);
	const englishName = normalizeRoomIdentity(candidate.displayName);
	const arabicName = normalizeRoomIdentity(candidate.displayName_OtherLanguage);
	return (rooms || []).find((room) => {
		if (ignoreRoomId && normalizeId(room?._id) === normalizeId(ignoreRoomId)) {
			return false;
		}
		if (normalizeRoomIdentity(room?.roomType) !== roomType) return false;
		const existingEnglish = normalizeRoomIdentity(room?.displayName);
		const existingArabic = normalizeRoomIdentity(room?.displayName_OtherLanguage);
		return (
			(englishName && existingEnglish && englishName === existingEnglish) ||
			(arabicName && existingArabic && arabicName === existingArabic)
		);
	});
};

const buildRoomFieldsFromBody = async (body = {}, existingRoom = {}) => {
	const roomInput = body.room || body;
	const existing = roomToPlain(existingRoom);
	const roomType =
		compactRoomText(roomInput.roomType || existing.roomType, 80) ||
		compactRoomText(roomInput.customRoomType || "", 80);
	const rawName = compactRoomText(
		roomInput.name ||
			roomInput.displayName ||
			roomInput.displayName_OtherLanguage ||
			existing.displayName ||
			existing.displayName_OtherLanguage,
		180
	);
	const shouldRegenerateDescription =
		roomInput.regenerateDescription === true ||
		roomInput.regenerateDescription === "true" ||
		body.regenerateDescription === true ||
		body.regenerateDescription === "true";
	const rawDescription = shouldRegenerateDescription
		? ""
		: compactRoomText(
				roomInput.descriptionInput ||
					roomInput.description ||
					roomInput.description_OtherLanguage ||
					existing.description ||
					existing.description_OtherLanguage,
				1200
		  );
	const orchestrated = await orchestrateRoomText({
		name: rawName,
		description: rawDescription,
		roomType,
		language: body.language || roomInput.language || "English",
		amenities: normalizeRoomArray(roomInput.amenities ?? existing.amenities),
		views: normalizeRoomArray(roomInput.views ?? existing.views),
		extraAmenities: normalizeRoomArray(
			roomInput.extraAmenities ?? existing.extraAmenities
		),
	});
	const basePrice = toMoneyNumber(
		roomInput.basePrice ?? roomInput?.price?.basePrice,
		toMoneyNumber(existing?.price?.basePrice ?? existing.basePrice, 0)
	);
	const defaultCost = toMoneyNumber(
		roomInput.defaultCost ?? roomInput.rootPrice,
		toMoneyNumber(existing.defaultCost ?? existing.rootPrice, basePrice)
	);
	const bedsCountSource =
		roomInput.bedsCount ?? existing.bedsCount ?? orchestrated.bedsCount ?? 1;

	return {
		roomType,
		displayName: orchestrated.displayName,
		displayName_OtherLanguage: orchestrated.displayName_OtherLanguage,
		description: orchestrated.description,
		description_OtherLanguage: orchestrated.description_OtherLanguage,
		count: toWholeNumber(roomInput.count ?? roomInput.roomCount, existing.count || 0),
		price: {
			...(existing.price && typeof existing.price === "object"
				? existing.price
				: {}),
			basePrice,
		},
		defaultCost,
		amenities: normalizeRoomArray(roomInput.amenities ?? existing.amenities),
		views: normalizeRoomArray(roomInput.views ?? existing.views),
		extraAmenities: normalizeRoomArray(
			roomInput.extraAmenities ?? existing.extraAmenities
		),
		activeRoom: toBooleanDefault(roomInput.activeRoom, existing.activeRoom !== false),
		bedsCount: Math.max(1, toWholeNumber(bedsCountSource, 1)),
		roomForGender: compactRoomText(
			roomInput.roomForGender || existing.roomForGender || "Unisex",
			40
		),
		commisionIncluded: toBooleanDefault(
			roomInput.commisionIncluded,
			existing.commisionIncluded === true
		),
		roomCommission: toMoneyNumber(
			roomInput.roomCommission,
			toMoneyNumber(existing.roomCommission, 10)
		),
		ai: {
			applied: orchestrated.aiApplied === true,
			model: orchestrated.aiModel || "",
			skippedReason: orchestrated.aiSkippedReason || "",
			error: orchestrated.aiError || "",
		},
	};
};

const sumRoomCounts = (rooms = []) =>
	(rooms || []).reduce((total, room) => total + toWholeNumber(room?.count, 0), 0);

const buildCalendarAgentQuery = (hotelIds = [], agentIds = []) => {
	const ids = uniqueValidIds(hotelIds);
	const objectIds = ids.map((id) => ObjectId(id));
	return {
		...(agentIds.length
			? { _id: { $in: agentIds.filter(ObjectId.isValid).map((id) => ObjectId(id)) } }
			: {}),
		$and: [
			{
				$or: [
					{ role: 7000 },
					{ roles: 7000 },
					{ roleDescription: "ordertaker" },
					{ roleDescriptions: "ordertaker" },
				],
			},
			{
				$or: [
					{ activeUser: { $exists: false } },
					{ activeUser: { $ne: false } },
				],
			},
			{
				$or: [
					{ "agentApproval.status": { $exists: false } },
					{ "agentApproval.status": null },
					{ "agentApproval.status": { $regex: /^approved$/i } },
				],
			},
			{
				$or: [
					{ hotelIdWork: { $in: ids } },
					{ hotelIdsWork: { $in: objectIds } },
					{ hotelsToSupport: { $in: objectIds } },
					{ hotelIdsOwner: { $in: objectIds } },
				],
			},
		],
	};
};

const serializeCalendarAgent = (agent = {}) => ({
	_id: normalizeId(agent._id),
	name: agent.name || agent.email || "Agent",
	email: agent.email || "",
	companyName: agent.companyName || agent.companyOfficialName || "",
	agentCommercialModel: agent.agentCommercialModel || "",
	hotelIds: uniqueValidIds([
		agent.hotelIdWork,
		...(Array.isArray(agent.hotelIdsWork) ? agent.hotelIdsWork : []),
		...(Array.isArray(agent.hotelsToSupport) ? agent.hotelsToSupport : []),
		...(Array.isArray(agent.hotelIdsOwner) ? agent.hotelIdsOwner : []),
	]),
});

const requestedCalendarHotelIds = (body = {}) =>
	uniqueValidIds(Array.isArray(body.hotelIds) ? body.hotelIds : [body.hotelId]);

const requestedCalendarRoomSelections = (body = {}) =>
	(Array.isArray(body.roomSelections) ? body.roomSelections : [])
		.map((selection) => ({
			hotelId: normalizeId(selection?.hotelId),
			roomId: normalizeId(selection?.roomId),
		}))
		.filter((selection) => selection.hotelId && selection.roomId);

const requestedCalendarRows = (body = {}) =>
	(Array.isArray(body.rows) ? body.rows : [])
		.map((row) => ({
			hotelId: normalizeId(row?.hotelId),
			roomId: normalizeId(row?.roomId),
			calendarDate: toCalendarDateKey(
				row?.calendarDate || row?.date || row?.pricingDate
			),
			status:
				String(row?.status || "open").toLowerCase() === "blocked"
					? "blocked"
					: "open",
			sellingPrice: row?.sellingPrice ?? row?.price,
			commissionPercent: row?.commissionPercent ?? row?.commission,
		}))
		.filter((row) => row.hotelId && row.roomId && row.calendarDate);

const sortCalendarRows = (rows = []) =>
	[...(Array.isArray(rows) ? rows : [])].sort((left, right) =>
		toCalendarDateKey(left?.calendarDate).localeCompare(
			toCalendarDateKey(right?.calendarDate)
		)
	);

const mergeGeneralCalendarRows = (existing = [], nextRows = [], dateSet = new Set()) =>
	sortCalendarRows([
		...(Array.isArray(existing) ? existing : []).filter(
			(row) => !dateSet.has(toCalendarDateKey(row?.calendarDate))
		),
		...nextRows,
	]);

const mergeAgentCalendarRows = (
	existing = [],
	nextRows = [],
	dateSet = new Set(),
	agentSet = new Set()
) =>
	sortCalendarRows([
		...(Array.isArray(existing) ? existing : []).filter((row) => {
			const rowAgentId = normalizeCalendarId(row?.agentId);
			const rowDate = toCalendarDateKey(row?.calendarDate);
			return !(agentSet.has(rowAgentId) && dateSet.has(rowDate));
		}),
		...nextRows,
	]);

exports.adminGlobalHotelSettingsOverview = async (_req, res) => {
	try {
		const hotels = await allHotelsQuery(ADMIN_GLOBAL_OVERVIEW_SELECT);
		return res.json({
			total: hotels.length,
			hotels: hotels.map(serializeAdminSettingsHotel),
		});
	} catch (error) {
		console.error("adminGlobalHotelSettingsOverview error:", error);
		return res.status(500).json({ error: "Could not load global hotel settings" });
	}
};

exports.adminGlobalRoomManagerOptions = async (_req, res) => {
	try {
		const hotels = await allHotelsQuery(ADMIN_GLOBAL_ROOM_MANAGER_SELECT);
		return res.json({
			hotels: hotels.map(serializeAdminRoomHotel),
		});
	} catch (error) {
		console.error("adminGlobalRoomManagerOptions error:", error);
		return res.status(500).json({ error: "Could not load global room options" });
	}
};

exports.saveAdminGlobalRoomManagerRoom = async (req, res) => {
	try {
		const action = String(req.body?.action || "add").toLowerCase();
		const hotelIds = requestedRoomHotelIds(req.body, action);
		if (!hotelIds.length || hotelIds.some((hotelId) => !ObjectId.isValid(hotelId))) {
			return res.status(400).json({ error: "Valid hotel selection is required" });
		}

		if (action === "update") {
			const hotelId = hotelIds[0];
			const hotel = await HotelDetails.findById(hotelId)
				.populate("belongsTo", "_id name email phone")
				.exec();
			if (!hotel) return res.status(404).json({ error: "Hotel not found" });
			const rooms = Array.isArray(hotel.roomCountDetails)
				? hotel.roomCountDetails
				: [];
			const roomId = normalizeId(req.body?.roomId || req.body?.room?._id);
			if (!roomId) return res.status(400).json({ error: "roomId is required" });
			const roomIndex = rooms.findIndex(
				(room) => normalizeId(room?._id) === roomId
			);
			if (roomIndex < 0) {
				return res.status(404).json({ error: "Room type was not found" });
			}
			const existingRoom = roomToPlain(rooms[roomIndex]);
			const fields = await buildRoomFieldsFromBody(req.body, existingRoom);
			if (!fields.roomType || !fields.displayName) {
				return res
					.status(400)
					.json({ error: "Room type and room name are required" });
			}
			const duplicate = findRoomDuplicate(rooms, fields, roomId);
			if (duplicate) {
				return res.status(409).json({
					error: "Another room with the same type and name already exists",
				});
			}
			const { ai, ...roomFields } = fields;
			const updatedRoomPayload = {
				...existingRoom,
				...roomFields,
				roomColor:
					existingRoom.roomColor ||
					pickRoomColor(fields.roomType, rooms.map(roomToPlain)),
			};
			if (typeof rooms.set === "function") {
				rooms.set(roomIndex, updatedRoomPayload);
			} else {
				rooms[roomIndex] = updatedRoomPayload;
			}
			hotel.roomCountDetails = rooms;
			hotel.overallRoomsCount = sumRoomCounts(rooms);
			hotel.markModified("roomCountDetails");
			await hotel.save();
			const updatedRoom =
				hotel.roomCountDetails.id(roomId) || hotel.roomCountDetails[roomIndex];
			return res.json({
				ok: true,
				action,
				hotel: serializeAdminRoomHotel(hotel),
				room: serializeAdminRoom(updatedRoom),
				ai,
			});
		}

		const hotels = await HotelDetails.find({ _id: { $in: hotelIds } })
			.populate("belongsTo", "_id name email phone")
			.exec();
		if (hotels.length !== hotelIds.length) {
			return res.status(404).json({ error: "One or more hotels were not found" });
		}
		const hotelsById = new Map(hotels.map((hotel) => [normalizeId(hotel._id), hotel]));
		const orderedHotels = hotelIds.map((hotelId) => hotelsById.get(hotelId)).filter(Boolean);
		const fields = await buildRoomFieldsFromBody(req.body, {});
		if (!fields.roomType || !fields.displayName) {
			return res
				.status(400)
				.json({ error: "Room type and room name are required" });
		}
		const duplicateHotels = orderedHotels.filter((hotel) =>
			findRoomDuplicate(
				Array.isArray(hotel.roomCountDetails) ? hotel.roomCountDetails : [],
				fields
			)
		);
		if (duplicateHotels.length) {
			return res.status(409).json({
				error: "A room with the same type and name already exists in one or more selected hotels",
				hotels: duplicateHotels.map((hotel) => ({
					_id: normalizeId(hotel._id),
					hotelName: hotel.hotelName || "Hotel",
				})),
			});
		}
		const hotelPricingRows = orderedHotels.map((hotel) => {
			const hotelId = normalizeId(hotel._id);
			return {
				hotel,
				hotelId,
				pricing: roomPricingForHotel(
					req.body,
					hotelId,
					fields.price?.basePrice || 0,
					fields.defaultCost || fields.price?.basePrice || 0
				),
			};
		});
		const missingBasePriceHotels = hotelPricingRows.filter(
			(row) => !(Number(row.pricing?.basePrice) > 0)
		);
		if (missingBasePriceHotels.length) {
			return res.status(400).json({
				error: "Base price is required for every selected hotel",
				hotels: missingBasePriceHotels.map(({ hotel }) => ({
					_id: normalizeId(hotel._id),
					hotelName: hotel.hotelName || "Hotel",
				})),
			});
		}
		const { ai, ...roomFields } = fields;
		const savedHotels = [];
		const savedRooms = [];
		for (const { hotel, hotelId, pricing } of hotelPricingRows) {
			const existingRooms = Array.isArray(hotel.roomCountDetails)
				? hotel.roomCountDetails
				: [];
			const nextRoom = {
				...roomFields,
				count: roomCountForHotel(req.body, hotelId, fields.count || 1),
				price: {
					...(roomFields.price && typeof roomFields.price === "object"
						? roomFields.price
						: {}),
					basePrice: pricing.basePrice,
				},
				defaultCost: pricing.defaultCost || pricing.basePrice,
				pricedExtras: [],
				pricingRate: [],
				agentInventory: [],
				agentPricingRate: [],
				photos: [],
				offers: [],
				monthly: [],
				roomColor: pickRoomColor(fields.roomType, existingRooms.map(roomToPlain)),
			};
			hotel.roomCountDetails.push(nextRoom);
			hotel.overallRoomsCount = sumRoomCounts(hotel.roomCountDetails);
			hotel.markModified("roomCountDetails");
			await hotel.save();
			const savedRoom =
				hotel.roomCountDetails[hotel.roomCountDetails.length - 1] || nextRoom;
			savedHotels.push(serializeAdminRoomHotel(hotel));
			savedRooms.push(serializeAdminRoom(savedRoom));
		}
		return res.status(201).json({
			ok: true,
			action: "add",
			hotel: savedHotels[0],
			hotels: savedHotels,
			room: savedRooms[0],
			rooms: savedRooms,
			createdCount: savedHotels.length,
			ai,
		});
	} catch (error) {
		console.error("saveAdminGlobalRoomManagerRoom error:", error);
		return res.status(500).json({ error: "Could not save global room settings" });
	}
};

exports.adminGlobalCalendarPricingOptions = async (_req, res) => {
	try {
		const hotels = await allHotelsQuery(ADMIN_GLOBAL_CALENDAR_SELECT);
		const hotelIds = hotels.map((hotel) => normalizeId(hotel._id));
		const agents = hotelIds.length
			? await User.find(buildCalendarAgentQuery(hotelIds))
					.select(
						"_id name email phone companyName companyOfficialName agentCommercialModel hotelIdWork hotelIdsWork hotelsToSupport hotelIdsOwner"
					)
					.sort({ name: 1, email: 1 })
					.lean()
					.exec()
			: [];
		return res.json({
			hotels: hotels.map(serializeCalendarHotel),
			agents: agents.map(serializeCalendarAgent),
		});
	} catch (error) {
		console.error("adminGlobalCalendarPricingOptions error:", error);
		return res
			.status(500)
			.json({ error: "Could not load global calendar pricing options" });
	}
};

exports.saveAdminGlobalCalendarPricing = async (req, res) => {
	try {
		const body = req.body || {};
		const scope =
			String(body.scope || "general").toLowerCase() === "agents"
				? "agents"
				: "general";
		const explicitRows = requestedCalendarRows(body);
		const explicitRowMode = explicitRows.length > 0;
		const hotelIds = explicitRowMode
			? uniqueValidIds(explicitRows.map((row) => row.hotelId))
			: requestedCalendarHotelIds(body);
		const roomSelections = explicitRowMode
			? [
					...new Map(
						explicitRows.map((row) => [
							`${row.hotelId}:${row.roomId}`,
							{ hotelId: row.hotelId, roomId: row.roomId },
						])
					).values(),
			  ]
			: requestedCalendarRoomSelections(body);
		const agentIds =
			scope === "agents"
				? uniqueValidIds(Array.isArray(body.agentIds) ? body.agentIds : [body.agentId])
				: [];

		if (!hotelIds.length || hotelIds.some((hotelId) => !ObjectId.isValid(hotelId))) {
			return res.status(400).json({ error: "Valid hotel selection is required" });
		}
		if (!roomSelections.length) {
			return res.status(400).json({ error: "Please select at least one room" });
		}
		if (scope === "agents" && !agentIds.length) {
			return res.status(400).json({ error: "Please select at least one agent" });
		}

		const plan = explicitRowMode
			? null
			: buildPricingPlan({
					scope,
					dates: body.dates,
					sellingPrice: body.sellingPrice ?? body.price,
					commissionPercent: body.commissionPercent ?? body.commission,
					status: body.status,
					calendarType: body.calendarType,
			  });
		if (!explicitRowMode && !plan.ok) {
			return res.status(400).json({ error: plan.error });
		}
		if (explicitRowMode) {
			const invalidRow = explicitRows.find((row) => {
				const rowPlan = buildPricingPlan({
					scope,
					dates: [row.calendarDate],
					sellingPrice: row.sellingPrice,
					commissionPercent: row.commissionPercent,
					status: row.status,
					calendarType: body.calendarType,
				});
				return !rowPlan.ok;
			});
			if (invalidRow) {
				return res.status(400).json({
					error: "One or more calendar rows has invalid pricing",
					row: invalidRow,
				});
			}
		}

		const sizeCheck = explicitRowMode
			? {
					ok:
						explicitRows.length * (scope === "agents" ? agentIds.length : 1) <=
						25000,
					error:
						"This would update too many rows. Please split it into smaller batches.",
			  }
			: ensurePlanSize({
					dates: plan.dates,
					roomCount: roomSelections.length,
					agentCount: scope === "agents" ? agentIds.length : 1,
			  });
		if (!sizeCheck.ok) return res.status(400).json({ error: sizeCheck.error });

		const hotelDocs = await HotelDetails.find({ _id: { $in: hotelIds } })
			.populate("belongsTo", "_id name email phone")
			.exec();
		if (hotelDocs.length !== hotelIds.length) {
			return res.status(404).json({ error: "One or more hotels were not found" });
		}
		const hotelMap = new Map(hotelDocs.map((hotel) => [normalizeId(hotel._id), hotel]));
		const missingRoom = roomSelections.find((selection) => {
			const hotel = hotelMap.get(selection.hotelId);
			const rooms = Array.isArray(hotel?.roomCountDetails)
				? hotel.roomCountDetails
				: [];
			return !rooms.some((room) => normalizeId(room?._id) === selection.roomId);
		});
		if (missingRoom) {
			return res.status(404).json({
				error: "One or more selected rooms were not found",
				missingRooms: [missingRoom],
			});
		}

		const agentDocs =
			scope === "agents"
				? await User.find(buildCalendarAgentQuery(hotelIds, agentIds))
						.select("_id name email companyName companyOfficialName")
						.lean()
						.exec()
				: [];
		if (scope === "agents" && agentDocs.length !== agentIds.length) {
			return res.status(404).json({
				error: "One or more selected agents were not found for these hotels",
			});
		}
		const defaultDateSet = new Set(plan?.dates || []);
		const agentSet = new Set(agentIds.map(normalizeId));
		const agentMap = new Map(agentDocs.map((agent) => [normalizeId(agent._id), agent]));
		let updatedRows = 0;
		const updatedHotels = [];
		const calendarType = body.calendarType === "gregorian" ? "gregorian" : "hijri";

		for (const hotel of hotelDocs) {
			const hotelId = normalizeId(hotel._id);
			const hotelSelections = roomSelections.filter(
				(selection) => selection.hotelId === hotelId
			);
			if (!hotelSelections.length) continue;
			const rooms = Array.isArray(hotel.roomCountDetails)
				? hotel.roomCountDetails
				: [];
			hotelSelections.forEach((selection) => {
				const roomIndex = rooms.findIndex(
					(room) => normalizeId(room?._id) === selection.roomId
				);
				const room = roomToPlain(rooms[roomIndex]);
				const roomRows = explicitRowMode
					? explicitRows.filter(
							(row) =>
								row.hotelId === selection.hotelId &&
								row.roomId === selection.roomId
					  )
					: [];
				const roomDateSet = explicitRowMode
					? new Set(roomRows.map((row) => row.calendarDate))
					: defaultDateSet;
				if (scope === "agents") {
					const nextRows = [];
					if (explicitRowMode) {
						roomRows.forEach((row) => {
							const rowPlan = buildPricingPlan({
								scope,
								dates: [row.calendarDate],
								sellingPrice: row.sellingPrice,
								commissionPercent: row.commissionPercent,
								status: row.status,
								calendarType,
							});
							if (!rowPlan.ok) return;
							agentIds.forEach((agentId) => {
								const agent = agentMap.get(normalizeId(agentId));
								nextRows.push(
									buildAgentRow(rowPlan, room, row.calendarDate, agent)
								);
							});
						});
					} else {
						agentIds.forEach((agentId) => {
							const agent = agentMap.get(normalizeId(agentId));
							plan.dates.forEach((calendarDate) => {
								nextRows.push(buildAgentRow(plan, room, calendarDate, agent));
							});
						});
					}
					rooms[roomIndex].agentPricingRate = mergeAgentCalendarRows(
						room.agentPricingRate,
						nextRows,
						roomDateSet,
						agentSet
					);
					updatedRows += nextRows.length;
				} else {
					const nextRows = explicitRowMode
						? roomRows
								.map((row) => {
									const rowPlan = buildPricingPlan({
										scope,
										dates: [row.calendarDate],
										sellingPrice: row.sellingPrice,
										commissionPercent: row.commissionPercent,
										status: row.status,
										calendarType,
									});
									return rowPlan.ok
										? buildGeneralRow(rowPlan, room, row.calendarDate)
										: null;
								})
								.filter(Boolean)
						: plan.dates.map((calendarDate) =>
								buildGeneralRow(plan, room, calendarDate)
						  );
					rooms[roomIndex].pricingRate = mergeGeneralCalendarRows(
						room.pricingRate,
						nextRows,
						roomDateSet
					);
					updatedRows += nextRows.length;
				}
			});
			hotel.roomCountDetails = rooms;
			hotel.markModified("roomCountDetails");
			await hotel.save();
			updatedHotels.push(serializeCalendarHotel(hotelMap.get(hotelId) || hotel));
		}

		return res.json({
			ok: true,
			scope,
			updatedRows,
			updatedHotels,
			summary: {
				days: explicitRowMode
					? new Set(explicitRows.map((row) => row.calendarDate)).size
					: plan.dates.length,
				rows: explicitRowMode ? explicitRows.length : undefined,
				rooms: roomSelections.length,
				agents: scope === "agents" ? agentIds.length : 0,
				sellingPrice: plan?.sellingPrice ?? null,
				rootPrice: plan?.rootPrice ?? null,
				commissionPercent: plan?.commissionPercent ?? null,
				blocked: plan?.blocked ?? null,
			},
		});
	} catch (error) {
		console.error("saveAdminGlobalCalendarPricing error:", error);
		return res.status(500).json({ error: "Could not save global calendar pricing" });
	}
};
