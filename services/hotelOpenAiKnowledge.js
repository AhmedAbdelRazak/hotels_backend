/** @format */

const crypto = require("crypto");

const SCHEMA_VERSION = 3;
const DEFAULT_TIMEZONE = "Asia/Riyadh";
const BLOCKED_STATUSES = new Set([
	"blocked",
	"closed",
	"restricted",
	"unavailable",
	"ma7zoor",
	"ma7zor",
	"mahzoor",
	"mahzor",
	"محظور",
	"محجوب",
	"مقيد",
	"مقيّد",
]);
const BLOCKED_COLORS = new Set([
	"black",
	"#000",
	"#000000",
	"rgb(0,0,0)",
	"rgb(0, 0, 0)",
]);
const NUMBER_WORDS = new Map([
	["one", 1],
	["single", 1],
	["two", 2],
	["twin", 2],
	["double", 2],
	["three", 3],
	["triple", 3],
	["four", 4],
	["quad", 4],
	["quadruple", 4],
	["five", 5],
	["quintuple", 5],
	["six", 6],
	["sextuple", 6],
	["seven", 7],
	["eight", 8],
	["nine", 9],
	["ten", 10],
	["واحد", 1],
	["واحدة", 1],
	["فردي", 1],
	["فردية", 1],
	["اثنان", 2],
	["اثنين", 2],
	["اثنتان", 2],
	["اثنتين", 2],
	["ثنائي", 2],
	["ثنائية", 2],
	["ثلاثة", 3],
	["ثلاث", 3],
	["ثلاثي", 3],
	["ثلاثية", 3],
	["أربعة", 4],
	["اربعة", 4],
	["أربع", 4],
	["اربع", 4],
	["رباعي", 4],
	["رباعية", 4],
	["خمسة", 5],
	["خمس", 5],
	["خماسي", 5],
	["خماسية", 5],
	["ستة", 6],
	["ست", 6],
	["سداسي", 6],
	["سداسية", 6],
	["سبعة", 7],
	["سبع", 7],
	["ثمانية", 8],
	["ثمان", 8],
	["تسعة", 9],
	["تسع", 9],
	["عشرة", 10],
	["عشر", 10],
]);

const ROOM_TYPE_MAX_GUESTS = new Map([
	["singlerooms", 1],
	["twinrooms", 2],
	["doublerooms", 2],
	["triplerooms", 3],
	["quadrooms", 4],
]);

const COUNT_TOKEN =
	"(?:\\d{1,2}|[٠-٩۰-۹]{1,2}|one|single|two|twin|double|three|triple|four|quadruple|quad|five|quintuple|six|sextuple|seven|eight|nine|ten|واحد(?:ة)?|فردي(?:ة)?|اثنان|اثنين|اثنتان|اثنتين|ثنائي(?:ة)?|ثلاثة|ثلاث|ثلاثي(?:ة)?|أربعة|اربعة|أربع|اربع|رباعي(?:ة)?|خمسة|خمس|خماسي(?:ة)?|ستة|ست|سداسي(?:ة)?|سبعة|سبع|ثمانية|ثمان|تسعة|تسع|عشرة|عشر)";
const QUANTITY_TOKEN =
	"(?:\\d{1,2}|[٠-٩۰-۹]{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|واحد(?:ة)?|اثنان|اثنين|اثنتان|اثنتين|ثلاثة|ثلاث|أربعة|اربعة|أربع|اربع|خمسة|خمس|ستة|ست|سبعة|سبع|ثمانية|ثمان|تسعة|تسع|عشرة|عشر)";

const countPattern = (source, flags = "i") => new RegExp(source.replaceAll("COUNT", `(${COUNT_TOKEN})`), flags);
const quantityPattern = (source, flags = "i") =>
	new RegExp(source.replaceAll("QUANTITY", `(${QUANTITY_TOKEN})`), flags);

const roundMoney = (value) => Number(Number(value || 0).toFixed(2));

const finiteNumber = (value, fallback = null) => {
	if (value === "" || value === null || value === undefined) return fallback;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
};

const positiveNumber = (value, fallback = null) => {
	const parsed = finiteNumber(value, fallback);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const normalizedString = (value) => String(value || "").trim();

const publicSlug = (value) =>
	normalizedString(value)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");

const sanitizeHotelDescription = (value, language) => {
	const lines = normalizedString(value).split(/\r?\n/);
	return lines
		.filter((line) => {
			const text = line.trim();
			if (language === "ar") return !/^التسكين\s*4[.،]?8\s*$/i.test(text);
			return !/^accommodation capacity:\s*up to\s*4\s*[–-]\s*8\s*guests?\.?$/i.test(text);
		})
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
};

const uniqueStrings = (values = []) =>
	Array.from(
		new Set(
			(Array.isArray(values) ? values : [])
				.map((value) => normalizedString(value))
				.filter(Boolean)
		)
	);

const sha256 = (value) =>
	crypto.createHash("sha256").update(String(value), "utf8").digest("hex");

const dateKeyInTimeZone = (value = new Date(), timeZone = DEFAULT_TIMEZONE) => {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).formatToParts(value);
	const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
	return `${byType.year}-${byType.month}-${byType.day}`;
};

const isGregorianDateKey = (value) =>
	/^20\d{2}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/.test(String(value || ""));

const utcDateFromKey = (dateKey) => {
	if (!isGregorianDateKey(dateKey)) return null;
	const parsed = new Date(`${dateKey}T00:00:00.000Z`);
	return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const enumerateDateKeys = (from, through) => {
	const start = utcDateFromKey(from);
	const end = utcDateFromKey(through);
	if (!start || !end || start > end) {
		throw new Error(`Invalid knowledge coverage: ${from} through ${through}`);
	}
	const output = [];
	for (let cursor = start; cursor <= end; cursor = new Date(cursor.getTime() + 86400000)) {
		output.push(cursor.toISOString().slice(0, 10));
	}
	return output;
};

const numberToken = (value) => {
	const text = normalizedString(value)
		.toLowerCase()
		.replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
		.replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0))
		.replace(/[\u064b-\u065f\u0670\u0640]/g, "");
	if (/^\d+$/.test(text)) return Number(text);
	return NUMBER_WORDS.get(text) || null;
};

const firstMatchedNumber = (text, patterns = []) => {
	for (const pattern of patterns) {
		const match = String(text || "").match(pattern);
		if (!match) continue;
		const parsed = numberToken(match[1]);
		if (Number.isFinite(parsed) && parsed > 0) return parsed;
	}
	return null;
};

const wholePositiveNumber = (value, fallback = 0) => {
	const parsed = finiteNumber(value, fallback);
	if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
	return Math.floor(parsed);
};

const isIndividualBedRoom = (room = {}) =>
	normalizedString(room.roomType).toLowerCase() === "individualbed";

const isAmbiguousFamilyOrSuite = (room = {}) => {
	const roomType = normalizedString(room.roomType).toLowerCase();
	const text = `${normalizedString(room.displayName)} ${normalizedString(
		room.displayName_OtherLanguage
	)}`.toLowerCase();
	return roomType === "familyrooms" || /\bfamily\b|\bsuite\b|عائل|جناح/i.test(text);
};

const explicitGuestCapacity = (text = "") =>
	firstMatchedNumber(text, [
		countPattern(
			"(?:accommodat(?:es|ing)|sleeps?|fits?|holds?)(?:\\s+comfortably)?(?:\\s+up\\s+to)?\\s+COUNT\\s+(?:guests?|people|persons?|adults?)"
		),
		countPattern(
			"(?:capacity(?:\\s+of)?|up\\s+to|room\\s+for|ideal\\s+for|perfect\\s+for|suitable\\s+for)\\s+COUNT\\s+(?:guests?|people|persons?|adults?)"
		),
		countPattern("(?:for)\\s+COUNT\\s+(?:guests?|people|persons?|adults?)"),
		countPattern("COUNT\\s+(?:guests?|people|persons?|adults?)"),
		countPattern(
			"(?:تتسع|تستوعب|تسع|مناسبة|مثالية)(?:\\s+ل)?(?:\\s+حتى)?(?:\\s+عدد)?\\s*COUNT\\s*(?:أشخاص|اشخاص|أفراد|افراد|ضيوف|نزلاء|شخص)?"
		),
		countPattern("(?:شخص|أشخاص|اشخاص|أفراد|افراد|ضيوف|نزلاء)\\s*COUNT"),
	]);

const explicitBedCount = (text = "") => {
	const parsed = firstMatchedNumber(text, [
		quantityPattern(
			"QUANTITY[-\\s]?(?:single\\s+|double\\s+|queen\\s+|king\\s+|individual\\s+|bunk\\s+)?beds?\\b"
		),
		quantityPattern(
			"(?:featur(?:e|es|ing)|with|includes?|offers?|has|containing)\\s+QUANTITY\\s+(?:comfortable\\s+|cozy\\s+|separate\\s+|single\\s+|double\\s+|queen\\s+|king\\s+|individual\\s+|bunk\\s+)?beds?\\b"
		),
		quantityPattern("QUANTITY\\s*(?:سرير|سرائر|أسرة|اسرة|أسرّة|اسرّة)"),
	]);
	if (parsed) return parsed;
	if (
		/\b(?:a|one)\s+(?:comfortable\s+|cozy\s+|single\s+|double\s+|queen\s+|king\s+)?bed\b/i.test(
			text
		)
	) {
		return 1;
	}
	if (/(?:سريرين|سريران)/.test(text)) return 2;
	if (/(?:سرير\s+واحد|سريراً\s+واحداً|سريرا\s+واحدا)/.test(text)) return 1;
	return null;
};

const capacityFromDisplayName = (displayName = "") =>
	explicitGuestCapacity(displayName) ||
	firstMatchedNumber(displayName, [
		countPattern("\\bCOUNT[-\\s]?beds?\\b"),
		countPattern("\\bCOUNT\\s+room\\b"),
		countPattern("(?:غرفة)\\s+COUNT"),
	]);

const bedCountFromDisplayName = (displayName = "") =>
	firstMatchedNumber(displayName, [
		quantityPattern("\\bQUANTITY[-\\s]?beds?\\b"),
		/\b(single|twin)\s+room\b/i,
	]);

const namedCapacityFromDisplayName = (displayName = "") =>
	capacityFromDisplayName(displayName) ||
	(/\bsextuple\b|\bsix[-\s]?bed\b|سداسي/i.test(displayName)
		? 6
		: /\bquintuple\b|\bfive[-\s]?bed\b|خماسي/i.test(displayName)
		? 5
		: /\bquadruple\b|\bquad\s+room\b|\bfour[-\s]?bed\b|رباعي/i.test(displayName)
		? 4
		: /\btriple\b|\bthree[-\s]?bed\b|ثلاثي/i.test(displayName)
		? 3
		: /\bdouble\b|\btwin\b|\btwo[-\s]?bed\b|مزدوج|ثنائي/i.test(displayName)
		? 2
		: /\bsingle\b|\bone[-\s]?bed\b|فردي/i.test(displayName)
		? 1
		: null);

const normalizeRoomCapacity = (room = {}) => {
	const displayName = normalizedString(room.displayName);
	const displayNameOther = normalizedString(room.displayName_OtherLanguage);
	const description = normalizedString(room.description);
	const descriptionOther = normalizedString(room.description_OtherLanguage);
	const displayCombined = [displayName, displayNameOther].filter(Boolean).join(". ");
	const descriptionCombined = [description, descriptionOther]
		.filter(Boolean)
		.join(". ");
	const roomType = normalizedString(room.roomType).toLowerCase();
	const individualBed = isIndividualBedRoom(room);

	let maxGuests = individualBed ? 1 : namedCapacityFromDisplayName(displayCombined);
	let maxGuestsSource = individualBed
		? "individual_bed_pricing_unit"
		: maxGuests
		? "display_name"
		: "";
	if (!maxGuests && !individualBed) {
		maxGuests = ROOM_TYPE_MAX_GUESTS.get(roomType);
		maxGuestsSource = maxGuests ? "unambiguous_room_type" : "";
	}
	if (!maxGuests && !individualBed) {
		maxGuests = explicitGuestCapacity(descriptionCombined);
		maxGuestsSource = maxGuests ? "explicit_guest_text" : "";
	}

	let bedCount = bedCountFromDisplayName(displayCombined);
	let bedCountSource = bedCount ? "display_name" : "";
	if (!bedCount && descriptionCombined) {
		bedCount = explicitBedCount(descriptionCombined);
		bedCountSource = bedCount ? "explicit_bed_text" : "";
	}
	if (!bedCount && displayCombined) {
		bedCount = explicitBedCount(displayCombined);
		bedCountSource = bedCount ? "display_name" : "";
	}
	const structuredBedCount = wholePositiveNumber(room.bedsCount, 0);
	if (!bedCount && structuredBedCount > 1) {
		bedCount = structuredBedCount;
		bedCountSource = "validated_structured_beds_count";
	}
	if (!bedCount && !individualBed && structuredBedCount === 1 && maxGuests === 1) {
		bedCount = 1;
		bedCountSource = "single_occupancy_structured_beds_count";
	}

	const sharedRoomBedCount = individualBed ? bedCount : null;
	const capacityKnown = Number.isFinite(maxGuests) && maxGuests > 0;
	const sharedInventoryKnown = !individualBed || (sharedRoomBedCount || 0) > 0;
	const ambiguousFamilyOrSuite = !capacityKnown && isAmbiguousFamilyOrSuite(room);
	const eligibleForCapacityRecommendation = capacityKnown && sharedInventoryKnown;

	return {
		maxGuests: capacityKnown ? maxGuests : null,
		maxGuestsPerUnit: capacityKnown ? maxGuests : null,
		bedCount: bedCount || null,
		bedConfiguration: bedCount ? [{ count: bedCount, type: "unspecified" }] : [],
		capacityStatus: eligibleForCapacityRecommendation
			? "verified"
			: "unknown_requires_management_review",
		eligibleForCapacityRecommendation,
		capacitySource: maxGuestsSource || (ambiguousFamilyOrSuite ? "ambiguous_family_or_suite" : "unknown"),
		maxGuestsSource: maxGuestsSource || "unknown",
		bedCountSource: bedCountSource || "unknown",
		capacityClarification: eligibleForCapacityRecommendation
			? ""
			: ambiguousFamilyOrSuite
			? "Do not infer this family room or suite capacity. Obtain an explicit management-approved guest capacity before recommending it by party size."
			: "Do not recommend this room by party size until management provides an explicit approved guest capacity.",
		...(individualBed
			? {
					sharedRoomBedCount: sharedRoomBedCount || null,
					sharedRoomCapacityGuests: sharedRoomBedCount || null,
			  }
			: {}),
	};
};

const isCalendarRowBlocked = (row = {}) => {
	if (!row || typeof row !== "object") return false;
	const price = finiteNumber(row.price, null);
	const color = normalizedString(row.color || row.backgroundColor).toLowerCase();
	const statuses = [row.status, row.state, row.availability, row.type]
		.map((value) => normalizedString(value).toLowerCase())
		.filter(Boolean);
	return (
		row.blocked === true ||
		row.isBlocked === true ||
		row.restricted === true ||
		row.isRestricted === true ||
		row.calendarBlocked === true ||
		row.unavailable === true ||
		statuses.some((status) => BLOCKED_STATUSES.has(status)) ||
		BLOCKED_COLORS.has(color) ||
		(Number.isFinite(price) && price <= 0)
	);
};

const effectiveGuestNightlyRate = (_hotel = {}, room = {}, row = null) => {
	const basePrice = positiveNumber(room?.price?.basePrice, 0);
	return roundMoney(row ? positiveNumber(row.price, basePrice) : basePrice);
};

const monthBounds = (month, coverageFrom, coverageThrough) => {
	const monthStart = `${month}-01`;
	const startDate = utcDateFromKey(monthStart);
	const nextMonth = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth() + 1, 1));
	const monthEnd = new Date(nextMonth.getTime() - 86400000).toISOString().slice(0, 10);
	return {
		from: coverageFrom > monthStart ? coverageFrom : monthStart,
		through: coverageThrough < monthEnd ? coverageThrough : monthEnd,
	};
};

const buildRoomCalendarSummary = ({ hotel, room, coverageFrom, coverageThrough }) => {
	const rateMap = new Map();
	for (const row of Array.isArray(room.pricingRate) ? room.pricingRate : []) {
		const date = normalizedString(row?.calendarDate).slice(0, 10);
		if (!isGregorianDateKey(date) || rateMap.has(date)) continue;
		rateMap.set(date, row);
	}

	const byMonth = new Map();
	const blockedDates = [];
	for (const date of enumerateDateKeys(coverageFrom, coverageThrough)) {
		const month = date.slice(0, 7);
		if (!byMonth.has(month)) {
			byMonth.set(month, { rates: [], blockedDates: [] });
		}
		const bucket = byMonth.get(month);
		const row = rateMap.get(date) || null;
		if (row && isCalendarRowBlocked(row)) {
			blockedDates.push(date);
			bucket.blockedDates.push(date);
			continue;
		}
		bucket.rates.push(effectiveGuestNightlyRate(hotel, room, row));
	}

	const monthlyAverageRates = Array.from(byMonth.entries()).map(([month, bucket]) => {
		const bounds = monthBounds(month, coverageFrom, coverageThrough);
		if (!bucket.rates.length) {
			return {
				month,
				coverageFrom: bounds.from,
				coverageThrough: bounds.through,
				status: "fully_blocked",
				estimatedAverageNightlyRate: null,
				minimumNightlyRate: null,
				maximumNightlyRate: null,
				openNightCount: 0,
				blockedNightCount: bucket.blockedDates.length,
				blockedDates: bucket.blockedDates,
			};
		}
		const total = bucket.rates.reduce((sum, rate) => sum + rate, 0);
		return {
			month,
			coverageFrom: bounds.from,
			coverageThrough: bounds.through,
			status: bucket.blockedDates.length ? "partially_open" : "open",
			estimatedAverageNightlyRate: roundMoney(total / bucket.rates.length),
			minimumNightlyRate: roundMoney(Math.min(...bucket.rates)),
			maximumNightlyRate: roundMoney(Math.max(...bucket.rates)),
			openNightCount: bucket.rates.length,
			blockedNightCount: bucket.blockedDates.length,
			blockedDates: bucket.blockedDates,
		};
	});

	return { monthlyAverageRates, blockedDates };
};

const publicTransportDetails = (hotel = {}) => ({
	available: hotel.hasBusService === true,
	details: normalizedString(hotel.busDetails),
});

const sanitizeRoomAmenities = (room = {}) => {
	const extraAmenities = uniqueStrings(room.extraAmenities).filter(
		(value) => !/shuttle\s+service\s+to\s+haram/i.test(value)
	);
	return {
		amenities: uniqueStrings(room.amenities),
		views: uniqueStrings(room.views),
		extraAmenities,
	};
};

const buildRoomInventory = (room = {}, capacity = {}) => {
	const physicalRoomCount = wholePositiveNumber(room.count, 0);
	const pricingUnit = isIndividualBedRoom(room) ? "per_bed_per_night" : "per_room_per_night";
	const sellableUnitsPerPhysicalRoom =
		pricingUnit === "per_bed_per_night"
			? wholePositiveNumber(capacity.sharedRoomBedCount, 0)
			: 1;
	const totalSellableUnits = physicalRoomCount * sellableUnitsPerPhysicalRoom;
	return {
		pricingUnit,
		count: physicalRoomCount,
		totalRooms: physicalRoomCount,
		physicalRoomCount,
		sellableUnit: pricingUnit === "per_bed_per_night" ? "bed" : "room",
		sellableUnitsPerPhysicalRoom,
		totalSellableUnits,
		inventoryStatus:
			physicalRoomCount > 0 && sellableUnitsPerPhysicalRoom > 0
				? "declared"
				: "unavailable_missing_physical_inventory",
		reservationOccupancyConsidered: false,
		explicitBlockedDatesEnforced: true,
	};
};

const canonicalKnowledgeRoomType = (room = {}, capacity = {}) => {
	const raw = normalizedString(room.roomType);
	if (
		[
			"singleRooms",
			"doubleRooms",
			"tripleRooms",
			"quadRooms",
			"familyRooms",
			"suite",
			"individualBed",
			"other",
		].includes(raw)
	) {
		return raw;
	}
	const maxGuests = wholePositiveNumber(capacity.maxGuests, 0);
	if (maxGuests === 1) return "singleRooms";
	if (maxGuests === 2) return "doubleRooms";
	if (maxGuests === 3) return "tripleRooms";
	if (maxGuests === 4) return "quadRooms";
	if (maxGuests >= 5) return "familyRooms";
	return raw || "other";
};

const buildHotelInventorySummary = (rooms = []) => {
	const byRoomId = rooms.map((room) => ({
		roomId: room.roomId,
		roomType: room.roomType,
		displayName: room.displayName,
		pricingUnit: room.pricingUnit,
		physicalRoomCount: room.physicalRoomCount,
		totalSellableUnits: room.totalSellableUnits,
		maxGuestsPerUnit: room.maxGuestsPerUnit,
		capacityStatus: room.capacityStatus,
	}));
	const byType = new Map();
	for (const room of byRoomId) {
		const key = room.roomType || "unspecified";
		if (!byType.has(key)) {
			byType.set(key, {
				roomType: key,
				physicalRoomCount: 0,
				totalSellableUnits: 0,
				variants: [],
			});
		}
		const group = byType.get(key);
		group.physicalRoomCount += room.physicalRoomCount;
		group.totalSellableUnits += room.totalSellableUnits;
		group.variants.push({
			roomId: room.roomId,
			displayName: room.displayName,
			pricingUnit: room.pricingUnit,
			physicalRoomCount: room.physicalRoomCount,
			totalSellableUnits: room.totalSellableUnits,
			maxGuestsPerUnit: room.maxGuestsPerUnit,
			capacityStatus: room.capacityStatus,
		});
	}
	return {
		mode: "physical_counts_with_blackout_only_provisional_availability",
		reservationOccupancyConsidered: false,
		reservationHistoryConsidered: false,
		physicalInventoryCountsEnforced: true,
		totalPhysicalRooms: rooms.reduce((sum, room) => sum + room.physicalRoomCount, 0),
		totalSellableUnits: rooms.reduce((sum, room) => sum + room.totalSellableUnits, 0),
		byRoomId,
		byRoomType: Array.from(byType.values()),
		allocationRule:
			"Never allocate more units from a roomId than its totalSellableUnits. If a request exceeds one room's declared inventory, use only its declared units and continue with other capacity-suitable roomIds. For example, if ten double rooms are requested but only five exist, use at most five doubles and propose suitable next room types for the remainder. Existing or historical reservations are deliberately not subtracted; explicit blocked dates and physical counts are the provisional chat limits.",
	};
};

const buildHotelKnowledgeDocument = ({
	hotel,
	coverageFrom,
	coverageThrough,
	generatedAt,
	knowledgeVersion,
	timezone = DEFAULT_TIMEZONE,
}) => {
	if (!hotel?._id) throw new Error("A hotel document is required");
	if (hotel.activateHotel !== true || hotel.xHotelProActive === false) {
		throw new Error("Hotel is not active for public publication");
	}

	const rooms = (Array.isArray(hotel.roomCountDetails) ? hotel.roomCountDetails : [])
		.filter((room) => room?.activeRoom === true && positiveNumber(room?.price?.basePrice, 0) > 0)
		.map((room) => {
			const capacity = normalizeRoomCapacity(room);
			const canonicalRoomType = canonicalKnowledgeRoomType(room, capacity);
			const inventory = buildRoomInventory(room, capacity);
			const calendar = buildRoomCalendarSummary({
				hotel,
				room,
				coverageFrom,
				coverageThrough,
			});
			return {
				roomId: String(room._id),
				roomType: canonicalRoomType,
				sourcePmsRoomType: normalizedString(room.roomType),
				displayName: {
					en: normalizedString(room.displayName),
					ar: normalizedString(room.displayName_OtherLanguage),
				},
				description: {
					en: normalizedString(room.description),
					ar: normalizedString(room.description_OtherLanguage),
				},
				...capacity,
				...inventory,
				referenceBaseNightlyRate: effectiveGuestNightlyRate(hotel, room, null),
				roomForGender: normalizedString(room.roomForGender) || "Unisex",
				...sanitizeRoomAmenities(room),
				preferenceClarifications: {
					smoking:
						uniqueStrings(room.amenities).some((value) => /^smoking$/i.test(value)) &&
						uniqueStrings(room.amenities).some((value) => /^non-smoking$/i.test(value))
							? "Both smoking and non-smoking preferences are listed; confirm the guest preference when reserving."
							: "",
				},
				monthlyAverageRates: calendar.monthlyAverageRates,
				blockedDates: calendar.blockedDates,
				availabilityMode: "blackout_only",
				availabilityInstruction:
					"Within coverage, this room is provisionally available only when every occupied night is absent from blockedDates and the requested quantity does not exceed totalSellableUnits. Existing and historical reservation occupancy is deliberately ignored. Final live validation is still required before a database action.",
			};
		});

	if (!rooms.length) throw new Error("Hotel has no active public rooms to publish");
	const hotelWideBlockedDates = rooms
		.map((room) => new Set(room.blockedDates))
		.reduce((intersection, set, index) => {
			if (index === 0) return new Set(set);
			return new Set(Array.from(intersection).filter((date) => set.has(date)));
		}, new Set());

	const coordinates = Array.isArray(hotel?.location?.coordinates)
		? hotel.location.coordinates
		: [];
	const activePolicies = (Array.isArray(hotel.hotelPolicyQA) ? hotel.hotelPolicyQA : [])
		.filter(
			(policy) =>
				policy?.active === true &&
				normalizedString(policy.question) &&
				normalizedString(policy.answer)
		)
		.sort((a, b) => finiteNumber(a.sortOrder, 999) - finiteNumber(b.sortOrder, 999))
		.map((policy) => ({
			key: normalizedString(policy.key),
			category: normalizedString(policy.category),
			question: normalizedString(policy.question),
			answer: normalizedString(policy.answer),
			mandatory: policy.mandatory === true,
		}));
	const walkingToAlHaram = normalizedString(hotel?.distances?.walkingToElHaram);
	const drivingToAlHaram = normalizedString(hotel?.distances?.drivingToElHaram);
	const roomAmenities = rooms.flatMap((room) => room.amenities || []);
	const inventorySummary = buildHotelInventorySummary(rooms);
	const factClarifications = [
		roomAmenities.some((amenity) => /restaurant/i.test(amenity))
			? "Restaurant may appear as a facility or room amenity, but every Jannat Booking chatbot offer is room-only. Do not promise breakfast, meals, meal packages, or included food."
			: "Every Jannat Booking chatbot offer is room-only. Do not promise breakfast, meals, meal packages, or included food.",
	];
	if (hotel.hasBusService === true && normalizedString(hotel.busDetails)) {
		factClarifications.push(
			"Use only the hotel-provided transport details; do not infer destinations or schedules that are not explicitly stated."
		);
	}

	return {
		schemaVersion: SCHEMA_VERSION,
		documentType: "hotel_knowledge",
		hotelId: String(hotel._id),
		knowledgeVersion,
		sourceUpdatedAt: hotel.updatedAt ? new Date(hotel.updatedAt).toISOString() : null,
		generatedAt: new Date(generatedAt).toISOString(),
		timezone,
		publicPageUrl: `https://jannatbooking.com/single-hotel/${publicSlug(
			hotel.hotelName
		)}?lang=en`,
		hotel: {
			name: {
				en: normalizedString(hotel.hotelName),
				ar: normalizedString(hotel.hotelName_OtherLanguage),
			},
			description: {
				en: sanitizeHotelDescription(hotel.aboutHotel, "en"),
				ar: sanitizeHotelDescription(hotel.aboutHotelArabic, "ar"),
			},
			propertyType: normalizedString(hotel.propertyType) || "Hotel",
			listingRating: finiteNumber(hotel.hotelRating, null),
			listingRatingMeaning: "Jannat Booking listing rating; not an official star classification.",
			floors: finiteNumber(hotel.hotelFloors, null),
			location: {
				address: normalizedString(hotel.hotelAddress),
				city: normalizedString(hotel.hotelCity),
				state: normalizedString(hotel.hotelState),
				country: normalizedString(hotel.hotelCountry),
				longitude: finiteNumber(coordinates[0], null),
				latitude: finiteNumber(coordinates[1], null),
				walkingToAlHaram,
				drivingToAlHaram,
			},
			services: {
				parkingAvailable: hotel.parkingLot === true,
				transport: publicTransportDetails(hotel),
				mealPlan: {
					available: false,
					included: false,
					bookingBasis: "room_only",
					details: "",
					instruction:
						"All Jannat Booking chatbot offers and reservations are room-only. Never promise breakfast, meals, a meal package, or included food.",
				},
				nusuk: {
					available: hotel.isNusuk === true,
					details: normalizedString(hotel.isNusukText),
				},
			},
			factClarifications,
			nearbyPlaces: [
				{
					name: "Masjid al-Haram",
					category: "landmark",
					relation:
						walkingToAlHaram || drivingToAlHaram
							? "Hotel-provided travel estimates are listed below."
							: "",
					walkingTime: walkingToAlHaram,
					drivingTime: drivingToAlHaram,
					source: "hotel_provided",
				},
			].filter((place) => place.relation),
		},
		policies: activePolicies,
		inventorySummary,
		availabilityRules: {
			mode: "blackout_only",
			checkInIncluded: true,
			checkOutExcluded: true,
			coverageFrom,
			coverageThrough,
			outsideCoverage: "unavailable",
			missingCalendarRowWithinCoverage:
				"available_at_exact_room_base_price_unless_explicitly_blocked",
			reservationOccupancyConsidered: false,
			reservationHistoryConsidered: false,
			physicalInventoryCountsEnforced: true,
			explicitBlockedDatesEnforced: true,
			status: "provisional_until_final_reservation_action",
			instruction:
				"A stay is provisionally available only when every occupied night is within coverage, none appears in the selected room's blockedDates, and the requested quantity does not exceed that room's totalSellableUnits. Existing and historical reservation occupancy is deliberately ignored by this blackout-only business rule. Final live validation is required before any database action.",
			hotelWideBlockedDates: Array.from(hotelWideBlockedDates).sort(),
		},
		priceRules: {
			currency: normalizedString(hotel.currency).toUpperCase() || "SAR",
			basis: "per_sellable_unit_per_night",
			roomPricingUnitField: "rooms[].pricingUnit",
			type: "estimated_monthly_average",
			calculation:
				"Arithmetic mean of each open date's effective guest nightly rate: use pricingRate.price when a positive calendar row exists, otherwise use room.price.basePrice exactly. Blocked nights are excluded. Internal costs and commissions are never added.",
			missingCalendarRowRule:
				"Within the published coverage, a date without a specific calendar rate uses room.price.basePrice exactly, with nothing added, unless the date is explicitly blocked.",
			guestWording:
				"Always describe these amounts as estimates or averages. Confirm the exact current total during the final reservation action.",
		},
		roomSelectionRules: {
			stableIdentity: "roomId",
			instruction:
				"Prefer one eligible room unit that safely accommodates the full party. A single guest may use a double room. Never use a room with eligibleForCapacityRecommendation=false as a party-size recommendation. Suggest multiple units only when no suitable single unit is available or the guest requests separation, and never exceed totalSellableUnits. Never identify a room only by roomType because multiple rooms may share that value.",
		},
		rooms,
	};
};

const FORBIDDEN_KEYS = new Set([
	"belongsto",
	"hotelrunnertoken",
	"subscriptiontoken",
	"subscriptionid",
	"stripe_account_id",
	"paymentsettings",
	"ownerpaymentmethods",
	"platform_wallet",
	"hotel_wallet",
	"rootprice",
	"defaultcost",
	"commission",
	"roomcommission",
	"commisionincluded",
	"agentinventory",
	"agentpricingrate",
]);

const assertSafeKnowledgeDocument = (value, path = "document") => {
	if (Array.isArray(value)) {
		value.forEach((item, index) => assertSafeKnowledgeDocument(item, `${path}[${index}]`));
		return;
	}
	if (!value || typeof value !== "object") return;
	for (const [key, child] of Object.entries(value)) {
		if (FORBIDDEN_KEYS.has(key.toLowerCase())) {
			throw new Error(`Forbidden internal field found at ${path}.${key}`);
		}
		assertSafeKnowledgeDocument(child, `${path}.${key}`);
	}
};

const stableSourcePayload = (document) => {
	const clone = JSON.parse(JSON.stringify(document));
	delete clone.generatedAt;
	delete clone.knowledgeVersion;
	delete clone.sourceUpdatedAt;
	return clone;
};

module.exports = {
	SCHEMA_VERSION,
	DEFAULT_TIMEZONE,
	assertSafeKnowledgeDocument,
	buildHotelKnowledgeDocument,
	dateKeyInTimeZone,
	isCalendarRowBlocked,
	normalizeRoomCapacity,
	sha256,
	stableSourcePayload,
};
