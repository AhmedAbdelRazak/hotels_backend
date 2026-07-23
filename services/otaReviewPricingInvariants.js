/** @format */

"use strict";

const {
	isTerminalPendingQueueReservation,
} = require("./reservationStatus");

const TOTAL_TOLERANCE = 0.05;

const money = (value) => {
	if (value === null || value === undefined || value === "") return 0;
	const parsed = Number(String(value).replace(/,/g, "").trim());
	return Number.isFinite(parsed) ? parsed : 0;
};

const round2 = (value) => Number(money(value).toFixed(2));
const hasMoney = (source = {}, field) =>
	Object.prototype.hasOwnProperty.call(source || {}, field) &&
	source[field] !== null &&
	source[field] !== undefined &&
	source[field] !== "";
const positiveMoney = (value) => {
	const parsed = round2(value);
	return parsed > 0 ? parsed : null;
};
const roomCount = (room = {}) => {
	const parsed = Number(room.count || room.totalRooms || room.total_rooms || 1);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
};
const normalizeId = (value) => {
	const candidate = value?._id || value;
	if (!candidate) return "";
	if (typeof candidate.toHexString === "function") {
		return String(candidate.toHexString()).trim();
	}
	return String(candidate).trim();
};
const normalizeLabel = (value) =>
	String(value || "")
		.trim()
		.toLowerCase()
		.replace(/\s+/g, " ");

const otaDateKey = (value) => {
	if (!value) return "";
	const raw = String(value).trim();
	const candidate = /^\d{4}-\d{2}-\d{2}/.test(raw)
		? raw.slice(0, 10)
		: (() => {
				const parsed = new Date(value);
				return Number.isNaN(parsed.getTime())
					? ""
					: parsed.toISOString().slice(0, 10);
		  })();
	if (!candidate) return "";
	const parsed = new Date(`${candidate}T00:00:00.000Z`);
	return !Number.isNaN(parsed.getTime()) &&
		parsed.toISOString().slice(0, 10) === candidate
		? candidate
		: "";
};

const otaStayDateKeys = (checkinDate, checkoutDate) => {
	const checkin = otaDateKey(checkinDate);
	const checkout = otaDateKey(checkoutDate);
	if (!checkin || !checkout || checkout <= checkin) return [];
	const cursor = new Date(`${checkin}T00:00:00.000Z`);
	const end = new Date(`${checkout}T00:00:00.000Z`);
	const keys = [];
	while (cursor < end && keys.length <= 366) {
		keys.push(cursor.toISOString().slice(0, 10));
		cursor.setUTCDate(cursor.getUTCDate() + 1);
	}
	return cursor.getTime() === end.getTime() && keys.length <= 366 ? keys : [];
};

const validateOtaStayDateCoverage = (reservation = {}, rooms = []) => {
	const expectedDates = otaStayDateKeys(
		reservation.checkin_date,
		reservation.checkout_date,
	);
	if (!expectedDates.length) {
		return {
			ready: false,
			code: "ota_stay_dates_invalid",
			message:
				"The OTA check-in and checkout dates must define a valid stay of no more than 366 nights.",
			expectedDates: [],
		};
	}
	const expected = new Set(expectedDates);
	for (let roomIndex = 0; roomIndex < rooms.length; roomIndex += 1) {
		const rows = Array.isArray(rooms[roomIndex]?.pricingByDay)
			? rooms[roomIndex].pricingByDay
			: [];
		const rowDates = rows.map((day) => otaDateKey(day?.date || day?.calendarDate));
		const uniqueDates = new Set(rowDates.filter(Boolean));
		const missingDates = expectedDates.filter((date) => !uniqueDates.has(date));
		const unexpectedDates = [...uniqueDates].filter((date) => !expected.has(date));
		const hasInvalidDate = rowDates.some((date) => !date);
		const hasDuplicateDate = uniqueDates.size !== rowDates.filter(Boolean).length;
		if (
			rows.length !== expectedDates.length ||
			hasInvalidDate ||
			hasDuplicateDate ||
			missingDates.length ||
			unexpectedDates.length
		) {
			return {
				ready: false,
				code: "ota_daily_date_coverage_mismatch",
				message:
					"Every reviewed OTA room must contain exactly one nightly pricing row for each stay date, excluding checkout.",
				roomIndex,
				expectedDates,
				missingDates,
				unexpectedDates,
				hasInvalidDate,
				hasDuplicateDate,
			};
		}
	}
	return { ready: true, expectedDates };
};

const isOtaEmailReservation = (reservation = {}) => {
	const supplier = reservation.supplierData || {};
	return (
		String(supplier.otaCreatedFromEmail || "").toLowerCase() === "true" ||
		String(supplier.otaAutomationPipeline || "") ===
			"ota-email-orchestrator" ||
		/ota_email/i.test(String(reservation?.otaPlatformReview?.source || "")) ||
		/ota_email/i.test(String(reservation?.adminPricing?.source || ""))
	);
};

const isOtaSyncReservation = (reservation = {}) => {
	const supplier = reservation.supplierData || {};
	return (
		String(supplier.otaCreatedFromSync || "").toLowerCase() === "true" ||
		String(supplier.otaAutomationPipeline || "") ===
			"ota-reservation-sync-orchestrator" ||
		/ota_sync/i.test(String(reservation?.otaPlatformReview?.source || "")) ||
		/ota_sync/i.test(String(reservation?.adminPricing?.source || ""))
	);
};

const isOtaSourceReservation = (reservation = {}) =>
	isOtaEmailReservation(reservation) || isOtaSyncReservation(reservation);

const isOtaReviewReservation = (reservation = {}) =>
	isOtaSourceReservation(reservation) ||
	Boolean(reservation?.otaPlatformReview?.status) ||
	/^ota[_-]/i.test(String(reservation?.otaPlatformReview?.source || ""));

const otaReleaseBlockingStatus = (reservation = {}) => {
	if (!isTerminalPendingQueueReservation(reservation)) return "";
	for (const value of [reservation.reservation_status, reservation.state]) {
		const normalized = String(value || "")
			.trim()
			.toLowerCase()
			.replace(/[\s-]+/g, "_");
		if (
			normalized &&
			isTerminalPendingQueueReservation({ reservation_status: value })
		) {
			return normalized;
		}
	}
	return "terminal";
};

const resolveOtaSourceClientTotal = (reservation = {}) => {
	const supplier = reservation.supplierData || {};
	const pricing = reservation.adminPricing || {};
	const candidates = [
		["adminPricing.sourceClientTotalSar", pricing.sourceClientTotalSar],
		[
			"supplierData.otaNormalizedSnapshot.totalAmountSar",
			supplier?.otaNormalizedSnapshot?.totalAmountSar,
		],
		["supplierData.otaAmountSar", supplier.otaAmountSar],
		[
			"supplierData.otaPaymentSummary.totalGuestPaymentAmount",
			supplier?.otaPaymentSummary?.totalGuestPaymentAmount,
		],
		["adminPricing.clientTotal", pricing.clientTotal],
		["reservation.total_amount", reservation.total_amount],
	];
	for (const [source, value] of candidates) {
		const amount = positiveMoney(value);
		if (amount !== null) return { amount, source };
	}
	return { amount: 0, source: "" };
};

const dayClientPrice = (day = {}) => {
	for (const field of [
		"clientPrice",
		"mainPrice",
		"totalPriceWithCommission",
		"price",
	]) {
		if (hasMoney(day, field)) return round2(day[field]);
	}
	return 0;
};

const summarizeOtaReviewedClientPricing = (rooms = []) => {
	let dailyClientTotal = 0;
	let dailyRows = 0;
	let missingClientRows = 0;
	for (const room of Array.isArray(rooms) ? rooms : []) {
		const rows = Array.isArray(room?.pricingByDay) ? room.pricingByDay : [];
		if (!rows.length) {
			missingClientRows += 1;
			continue;
		}
		for (const day of rows) {
			dailyRows += 1;
			const clientPrice = dayClientPrice(day);
			if (clientPrice <= 0) missingClientRows += 1;
			else dailyClientTotal = round2(dailyClientTotal + clientPrice * roomCount(room));
		}
	}
	return { dailyClientTotal, dailyRows, missingClientRows };
};

const validateOtaSourceClientPricing = (reservation = {}, rooms = []) => {
	const daily = summarizeOtaReviewedClientPricing(rooms);
	if (isOtaReviewReservation(reservation)) {
		const dateCoverage = validateOtaStayDateCoverage(reservation, rooms);
		if (!dateCoverage.ready) return dateCoverage;
	}
	if (!isOtaSourceReservation(reservation)) {
		return {
			ready: true,
			sourceClientTotal: round2(reservation.total_amount),
			dailyClientTotal: daily.dailyClientTotal,
		};
	}
	const source = resolveOtaSourceClientTotal(reservation);
	if (!(source.amount > 0)) {
		return {
			ready: false,
			code: "ota_source_client_total_required",
			message:
				"The original OTA guest total is missing. Confirm the source total before saving or releasing pricing.",
			sourceClientTotal: 0,
			dailyClientTotal: 0,
		};
	}
	if (!daily.dailyRows || daily.missingClientRows) {
		return {
			ready: false,
			code: "ota_daily_client_price_required",
			message:
				"Every OTA pricing day must have a positive client price before pricing can be saved or released.",
			sourceClientTotal: source.amount,
			dailyClientTotal: daily.dailyClientTotal,
			missingClientRows: daily.missingClientRows,
		};
	}
	const reviewedTotals = [
		["reviewed nightly client pricing", daily.dailyClientTotal],
		["admin client total", positiveMoney(reservation?.adminPricing?.clientTotal)],
		["reservation client total", positiveMoney(reservation.total_amount)],
	].filter(([, value]) => value !== null);
	const mismatch = reviewedTotals.find(
		([, value]) => Math.abs(value - source.amount) > TOTAL_TOLERANCE,
	);
	if (mismatch) {
		return {
			ready: false,
			code: "ota_source_client_total_mismatch",
			message: `The ${mismatch[0]} must match the original OTA guest total of SAR ${source.amount.toFixed(
				2,
			)}. OTA payout/net amounts must not replace the guest total.`,
			sourceClientTotal: source.amount,
			sourceClientTotalSource: source.source,
			dailyClientTotal: daily.dailyClientTotal,
			storedClientTotal: positiveMoney(reservation?.adminPricing?.clientTotal) || 0,
			reservationClientTotal: positiveMoney(reservation.total_amount) || 0,
		};
	}
	return {
		ready: true,
		sourceClientTotal: source.amount,
		sourceClientTotalSource: source.source,
		dailyClientTotal: daily.dailyClientTotal,
	};
};

const configIdForRoom = (room = {}) =>
	normalizeId(
		room.hotelRoomConfigId || room.roomConfigId || room.roomCountDetailId,
	);
const activeRoomConfigs = (hotel = {}) =>
	(Array.isArray(hotel.roomCountDetails) ? hotel.roomCountDetails : []).filter(
		(room) => room && room.activeRoom !== false,
	);

const exactRoomConfig = (selection = {}, hotel = {}) => {
	const configs = activeRoomConfigs(hotel);
	const selectedId = configIdForRoom(selection);
	if (selectedId) {
		const byId = configs.find((config) => normalizeId(config._id) === selectedId);
		return byId
			? { room: byId }
			: {
					code: "ota_room_mapping_stale",
					message:
						"A reviewed OTA room no longer exists in the assigned hotel's active room configuration.",
			  };
	}
	const roomType = normalizeLabel(selection.room_type || selection.roomType);
	const displayName = normalizeLabel(
		selection.displayName || selection.display_name,
	);
	const matches = configs.filter((config) => {
		const typeMatches =
			normalizeLabel(config.roomType || config.room_type) === roomType;
		const names = [
			config.displayName,
			config.display_name,
			config.displayName_OtherLanguage,
		]
			.map(normalizeLabel)
			.filter(Boolean);
		if (roomType && displayName) return typeMatches && names.includes(displayName);
		if (displayName) return names.includes(displayName);
		return roomType && typeMatches;
	});
	if (matches.length === 1) return { room: matches[0] };
	return {
		code:
			matches.length > 1
				? "ota_room_mapping_ambiguous"
				: "ota_room_mapping_required",
		message:
			matches.length > 1
				? "The reviewed OTA room matches multiple active hotel room configurations."
				: "The reviewed OTA room does not exactly match an active room in the assigned hotel.",
	};
};

const canonicalRoom = (selection, config) => ({
	...selection,
	room_type: config.roomType || config.room_type || "",
	displayName:
		config.displayName ||
		config.display_name ||
		config.roomType ||
		config.room_type ||
		"",
	hotelRoomConfigId: normalizeId(config._id),
	roomMappingStatus: "reviewed",
});

const canonicalizeOtaReviewedRooms = (rooms = [], hotel = {}) => {
	if (!Array.isArray(rooms) || !rooms.length) {
		return {
			ready: false,
			code: "ota_room_mapping_required",
			message: "At least one exact hotel room mapping is required.",
		};
	}
	const canonicalRooms = [];
	for (let index = 0; index < rooms.length; index += 1) {
		const resolved = exactRoomConfig(rooms[index] || {}, hotel);
		if (!resolved.room) {
			return {
				ready: false,
				code: resolved.code,
				message: `${resolved.message} Save pricing again after selecting the current room. (Room ${
					index + 1
				})`,
				roomIndex: index,
			};
		}
		canonicalRooms.push(canonicalRoom(rooms[index], resolved.room));
	}
	return { ready: true, rooms: canonicalRooms };
};

const validateCurrentRoomReferences = (rooms = [], hotel = null) => {
	if (!Array.isArray(rooms) || !rooms.length) {
		return {
			ready: false,
			code: "ota_room_mapping_required",
			message: "Reviewed OTA rooms must reference an exact current hotel room.",
		};
	}
	if (!hotel) return { ready: true, canonicalRooms: rooms };
	const canonicalRooms = [];
	for (let index = 0; index < rooms.length; index += 1) {
		const selection = rooms[index] || {};
		const resolved = exactRoomConfig(selection, hotel);
		if (!resolved.room) {
			return {
				ready: false,
				code: resolved.code,
				message: `${resolved.message} Save pricing again before release.`,
				roomIndex: index,
			};
		}
		if (configIdForRoom(selection)) {
			const storedType = normalizeLabel(selection.room_type || selection.roomType);
			const storedName = normalizeLabel(
				selection.displayName || selection.display_name,
			);
			const currentType = normalizeLabel(
				resolved.room.roomType || resolved.room.room_type,
			);
			const currentName = normalizeLabel(
				resolved.room.displayName ||
					resolved.room.display_name ||
					resolved.room.roomType ||
					resolved.room.room_type,
			);
			if (storedType !== currentType || storedName !== currentName) {
				return {
					ready: false,
					code: "ota_room_mapping_stale",
					message:
						"A reviewed OTA room no longer matches its current hotel room configuration. Save pricing again before release.",
					roomIndex: index,
				};
			}
		}
		canonicalRooms.push(canonicalRoom(selection, resolved.room));
	}
	return { ready: true, canonicalRooms };
};

const invalidateOtaRoomPricingForHotelAssignment = (rooms = []) =>
	(Array.isArray(rooms) ? rooms : []).map((room) => {
		const next = { ...(room || {}) };
		[
			"_id",
			"hotelRoomConfigId",
			"roomConfigId",
			"roomCountDetailId",
			"roomId",
		].forEach((field) => delete next[field]);
		next.roomMappingStatus = "unreviewed";
		next.hotelShouldGet = 0;
		next.subTotal = 0;
		next.pricingByDay = Array.isArray(next.pricingByDay)
			? next.pricingByDay.map((day) => ({
					...(day || {}),
					rootPrice: 0,
					totalPriceWithoutCommission: 0,
					platformMargin: 0,
					platformMarginRate: 0,
			  }))
			: [];
		return next;
	});

const dayRootPrice = (day = {}) => {
	const root = hasMoney(day, "rootPrice") ? positiveMoney(day.rootPrice) : null;
	if (root) return root;
	return hasMoney(day, "totalPriceWithoutCommission")
		? positiveMoney(day.totalPriceWithoutCommission) || 0
		: 0;
};

const validateOtaReleaseHotelBasePrice = (reservation = {}, { hotel = null } = {}) => {
	const blockingStatus = otaReleaseBlockingStatus(reservation);
	if (blockingStatus) {
		return {
			ready: false,
			code: "ota_terminal_status_release_blocked",
			message: `A reservation with OTA status ${blockingStatus} cannot be released to a hotel.`,
			hotelBaseTotal: 0,
		};
	}
	if (!normalizeId(reservation.hotelId)) {
		return {
			ready: false,
			code: "ota_hotel_assignment_required",
			message: "Assign a hotel before releasing this OTA reservation to the hotel.",
			hotelBaseTotal: 0,
		};
	}
	const pricing = reservation.adminPricing || {};
	if (
		String(pricing.mode || "").trim().toLowerCase() !== "ota_review" ||
		!reservation?.otaPlatformReview?.lastPricingUpdatedAt
	) {
		return {
			ready: false,
			code: "ota_pricing_review_required",
			message: "Update and save the OTA pricing review before release.",
			hotelBaseTotal: 0,
		};
	}
	const hotelBaseTotal = positiveMoney(pricing.rootTotal) || 0;
	if (!hotelBaseTotal) {
		return {
			ready: false,
			code: "ota_hotel_base_price_required",
			message: "Total base hotel price is required before release.",
			hotelBaseTotal: 0,
		};
	}
	const typeRooms = Array.isArray(reservation.pickedRoomsType)
		? reservation.pickedRoomsType
		: [];
	const pricingRooms = Array.isArray(reservation.pickedRoomsPricing)
		? reservation.pickedRoomsPricing
		: [];
	const rooms = pricingRooms.length ? pricingRooms : typeRooms;
	const roomValidation = validateCurrentRoomReferences(rooms, hotel);
	if (!roomValidation.ready) return { ...roomValidation, hotelBaseTotal };
	const clientValidation = validateOtaSourceClientPricing(reservation, rooms);
	if (!clientValidation.ready) return { ...clientValidation, hotelBaseTotal };

	let dailyBaseTotal = 0;
	let dailyRows = 0;
	let missingBaseRows = 0;
	for (const room of rooms) {
		const rows = Array.isArray(room?.pricingByDay) ? room.pricingByDay : [];
		if (!rows.length) {
			missingBaseRows += 1;
			continue;
		}
		for (const day of rows) {
			dailyRows += 1;
			const root = dayRootPrice(day);
			if (!root) missingBaseRows += 1;
			else dailyBaseTotal = round2(dailyBaseTotal + root * roomCount(room));
		}
	}
	if (!dailyRows || missingBaseRows || !dailyBaseTotal) {
		return {
			ready: false,
			code: "ota_daily_base_price_required",
			message: "Every OTA pricing day must have a base hotel price before release.",
			hotelBaseTotal,
			dailyBaseTotal,
			missingBaseRows,
		};
	}
	if (Math.abs(dailyBaseTotal - hotelBaseTotal) > TOTAL_TOLERANCE) {
		return {
			ready: false,
			code: "ota_hotel_base_price_mismatch",
			message:
				"Total base hotel price must match the saved daily base hotel pricing before release.",
			hotelBaseTotal,
			dailyBaseTotal,
		};
	}
	return {
		ready: true,
		hotelBaseTotal,
		dailyBaseTotal,
		sourceClientTotal: clientValidation.sourceClientTotal,
		dailyClientTotal: clientValidation.dailyClientTotal,
		canonicalRooms: roomValidation.canonicalRooms,
		missingBaseRows: 0,
	};
};

module.exports = {
	canonicalizeOtaReviewedRooms,
	invalidateOtaRoomPricingForHotelAssignment,
	isOtaEmailReservation,
	isOtaSourceReservation,
	isOtaSyncReservation,
	normalizeId,
	otaReleaseBlockingStatus,
	resolveOtaSourceClientTotal,
	summarizeOtaReviewedClientPricing,
	validateOtaStayDateCoverage,
	validateOtaReleaseHotelBasePrice,
	validateOtaSourceClientPricing,
};
