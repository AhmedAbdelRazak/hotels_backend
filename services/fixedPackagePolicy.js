/** @format */

"use strict";

const FIXED_PACKAGE_TIME_ZONE = "Asia/Riyadh";
const FIXED_PACKAGE_PAY_IN_HOTEL_MARKUP = 1.1;
const FIXED_PACKAGE_MAX_START_YEARS = 5;
const FIXED_PACKAGE_MAX_NIGHTS = Object.freeze({
	offer: 45,
	monthly: 75,
});

const TYPE_FIELDS = Object.freeze({
	offer: Object.freeze({
		array: "offers",
		from: "offerFrom",
		to: "offerTo",
		guestTotal: "offerPrice",
		rootTotal: "offerRootPrice",
		name: "offerName",
	}),
	monthly: Object.freeze({
		array: "monthly",
		from: "monthFrom",
		to: "monthTo",
		guestTotal: "monthPrice",
		rootTotal: "monthRootPrice",
		name: "monthName",
	}),
});

class FixedPackageValidationError extends Error {
	constructor(message, code = "fixed_package_invalid", details = {}) {
		super(message);
		this.name = "FixedPackageValidationError";
		this.statusCode = 409;
		this.code = code;
		this.details = details;
	}
}

const normalizeId = (value) =>
	String(value?._id || value?.id || value || "").trim();

const normalizeText = (value) =>
	String(value || "")
		.trim()
		.toLowerCase();

const moneyNumber = (value) => {
	if (value === null || value === undefined || value === "") return null;
	const parsed = Number(String(value).replace(/,/g, "").trim());
	return Number.isFinite(parsed) ? parsed : null;
};

const moneyCents = (value) => {
	const parsed = moneyNumber(value);
	return parsed === null ? null : Math.round(parsed * 100);
};

const moneyMatches = (left, right) => {
	const leftCents = moneyCents(left);
	const rightCents = moneyCents(right);
	return leftCents !== null && rightCents !== null && leftCents === rightCents;
};

const isRealDateKey = (value = "") => {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const parsed = new Date(`${value}T00:00:00.000Z`);
	return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

// Hotel package dates are date-only business values. When Mongo/Mongoose returns an
// ISO timestamp, preserve its stored YYYY-MM-DD prefix rather than shifting it through
// the machine's local time zone.
const canonicalPackageDateKey = (value) => {
	if (!value) return "";
	if (typeof value === "string") {
		const match = value.trim().match(/^(\d{4}-\d{2}-\d{2})/);
		if (match && isRealDateKey(match[1])) return match[1];
	}
	const parsed = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(parsed.getTime())) return "";
	const key = parsed.toISOString().slice(0, 10);
	return isRealDateKey(key) ? key : "";
};

const saudiTodayKey = (now = new Date()) => {
	const parsed = now instanceof Date ? now : new Date(now);
	if (Number.isNaN(parsed.getTime())) return "";
	try {
		const parts = new Intl.DateTimeFormat("en-US", {
			timeZone: FIXED_PACKAGE_TIME_ZONE,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
		}).formatToParts(parsed);
		const part = (type) => parts.find((row) => row.type === type)?.value || "";
		const key = `${part("year")}-${part("month")}-${part("day")}`;
		return isRealDateKey(key) ? key : "";
	} catch (_error) {
		return "";
	}
};

const normalizePackageType = (value) => {
	const normalized = String(value || "").trim().toLowerCase();
	if (["offer", "offers"].includes(normalized)) return "offer";
	if (["monthly", "month"].includes(normalized)) return "monthly";
	return "";
};

const packageDateDifference = (from, to) => {
	if (!isRealDateKey(from) || !isRealDateKey(to)) return 0;
	return Math.round(
		(Date.parse(`${to}T00:00:00.000Z`) -
			Date.parse(`${from}T00:00:00.000Z`)) /
			86400000,
	);
};

const packageDateKeys = (from, to, maxNights = 75) => {
	const nights = packageDateDifference(from, to);
	if (nights < 1 || nights > maxNights) return [];
	const dates = [];
	const cursor = new Date(`${from}T00:00:00.000Z`);
	for (let index = 0; index < nights; index += 1) {
		dates.push(cursor.toISOString().slice(0, 10));
		cursor.setUTCDate(cursor.getUTCDate() + 1);
	}
	return dates;
};

const fixedPackageConfig = (row = {}, typeValue = "") => {
	const type = normalizePackageType(typeValue);
	const fields = TYPE_FIELDS[type];
	if (!fields) return null;
	const guestTotal = moneyNumber(row?.[fields.guestTotal]);
	const rawRootTotal = moneyNumber(row?.[fields.rootTotal]);
	return {
		type,
		id: normalizeId(row),
		name: String(row?.[fields.name] || "").trim(),
		from: canonicalPackageDateKey(row?.[fields.from]),
		to: canonicalPackageDateKey(row?.[fields.to]),
		guestTotal,
		rootTotal: rawRootTotal === null ? 0 : rawRootTotal,
		row,
	};
};

const fixedPackageEligibility = (
	row,
	typeValue,
	{ now = new Date(), todayKey = "" } = {},
) => {
	const config = fixedPackageConfig(row, typeValue);
	if (!config) {
		return { eligible: false, code: "fixed_package_type_invalid", config: null };
	}
	const today = canonicalPackageDateKey(todayKey) || saudiTodayKey(now);
	if (!config.id) {
		return { eligible: false, code: "fixed_package_id_missing", config };
	}
	if (!config.from || !config.to || !today) {
		return { eligible: false, code: "fixed_package_dates_invalid", config };
	}
	const nights = packageDateDifference(config.from, config.to);
	const maxNights = FIXED_PACKAGE_MAX_NIGHTS[config.type];
	if (nights < 1 || nights > maxNights) {
		return { eligible: false, code: "fixed_package_range_invalid", config, nights };
	}
	const latestStartYear = Number(today.slice(0, 4)) + FIXED_PACKAGE_MAX_START_YEARS;
	if (Number(config.from.slice(0, 4)) > latestStartYear) {
		return { eligible: false, code: "fixed_package_range_unsupported", config, nights };
	}
	// Inclusive: a package starting on the current Saudi business date has not
	// missed any package day. It becomes ineligible on the following date.
	if (config.from < today) {
		return { eligible: false, code: "fixed_package_already_started", config, nights };
	}
	if (!(config.guestTotal > 0) || !(config.rootTotal >= 0)) {
		return { eligible: false, code: "fixed_package_price_invalid", config, nights };
	}
	return { eligible: true, code: "fixed_package_eligible", config, nights };
};

const sortFixedPackageRows = (rows = [], typeValue = "") =>
	[...(Array.isArray(rows) ? rows : [])].sort((left, right) => {
		const leftConfig = fixedPackageConfig(left, typeValue) || {};
		const rightConfig = fixedPackageConfig(right, typeValue) || {};
		const byStart = String(leftConfig.from || "").localeCompare(
			String(rightConfig.from || ""),
		);
		if (byStart !== 0) return byStart;
		return String(leftConfig.id || "").localeCompare(String(rightConfig.id || ""));
	});

const bookableFixedPackageRows = (rows = [], typeValue = "", options = {}) =>
	sortFixedPackageRows(
		(Array.isArray(rows) ? rows : []).filter(
			(row) => fixedPackageEligibility(row, typeValue, options).eligible,
		),
		typeValue,
	);

const filterRoomToBookableFixedPackages = (room = {}, options = {}) => ({
	...room,
	offers: bookableFixedPackageRows(room?.offers, "offer", options),
	monthly: bookableFixedPackageRows(room?.monthly, "monthly", options),
});

const selectedReservationRooms = (payload = {}) => {
	if (Array.isArray(payload.pickedRoomsType) && payload.pickedRoomsType.length) {
		return payload.pickedRoomsType;
	}
	if (Array.isArray(payload.pickedRoomsPricing) && payload.pickedRoomsPricing.length) {
		return payload.pickedRoomsPricing;
	}
	return [];
};

const hasFixedPackageSignal = (room = {}) =>
	room?.fromPackagesOffers === true ||
	Boolean(
		room?.packageMeta &&
			typeof room.packageMeta === "object" &&
			(room.packageMeta.pkgId || room.packageMeta.type || room.packageMeta.roomId),
	);

const hasFixedPackageReservationSignal = (payload = {}) =>
	[payload?.pickedRoomsType, payload?.pickedRoomsPricing].some(
		(rooms) =>
			Array.isArray(rooms) && rooms.some((room) => hasFixedPackageSignal(room)),
	);

const isPayInHotelPackagePayload = (payload = {}) => {
	const payment = String(payload.payment || "").trim().toLowerCase();
	return (
		["not paid", "not_paid", "unpaid"].includes(payment) &&
		(moneyNumber(payload.paid_amount) || 0) === 0
	);
};

const validationFailure = (code, message, details = {}) => ({
	applies: true,
	valid: false,
	statusCode: 409,
	code,
	message,
	details,
});

const roomCountForPackage = (value) => {
	const count = Number(value ?? 1);
	// The public cart expands quantity into one locked package row per room.
	// Keeping count fixed at one avoids two competing multiplication models.
	return count === 1 ? 1 : 0;
};

const rowDateKeys = (rows = []) =>
	(Array.isArray(rows) ? rows : []).map((row) =>
		canonicalPackageDateKey(row?.date || row?.calendarDate),
	);

const sumMoneyField = (rows = [], fields = []) =>
	(Array.isArray(rows) ? rows : []).reduce((sum, row) => {
		for (const field of fields) {
			const parsed = moneyNumber(row?.[field]);
			if (parsed !== null) return sum + parsed;
		}
		return sum;
	}, 0);

const sameDateList = (left = [], right = []) =>
	left.length === right.length && left.every((value, index) => value === right[index]);

const packageSelectionSignature = (validation = {}) => {
	if (!validation?.valid || !Array.isArray(validation.selections)) return "";
	return JSON.stringify(
		validation.selections
			.map((selection) => ({
				roomId: selection.roomId,
				type: selection.type,
				packageId: selection.packageId,
				count: selection.count,
				from: selection.from,
				to: selection.to,
				guestTotalCents: moneyCents(selection.guestTotal),
				rootTotalCents: moneyCents(selection.rootTotal),
			}))
			.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
	);
};

const fixedPackageSelectionsMatch = (left = {}, right = {}) => {
	if (!left?.valid || !right?.valid) return false;
	const leftApplies = Boolean(left.applies);
	const rightApplies = Boolean(right.applies);
	if (leftApplies !== rightApplies) return false;
	if (!leftApplies) return true;
	const leftSignature = packageSelectionSignature(left);
	const rightSignature = packageSelectionSignature(right);
	return Boolean(leftSignature) && leftSignature === rightSignature;
};

const validateFixedPackageReservationPayload = ({
	payload = {},
	hotel = {},
	now = new Date(),
	applyPayInHotelMarkup = true,
} = {}) => {
	const rooms = selectedReservationRooms(payload);
	const signalledRooms = rooms.filter(hasFixedPackageSignal);
	const packageSignalPresent = hasFixedPackageReservationSignal(payload);
	if (!packageSignalPresent) return { applies: false, valid: true };
	if (!signalledRooms.length) {
		return validationFailure(
			"fixed_package_room_payload_mismatch",
			"The package room details are inconsistent. Please remove the package and add it again.",
		);
	}
	if (signalledRooms.length !== rooms.length) {
		return validationFailure(
			"fixed_package_mixed_with_standard_rooms",
			"Fixed-date packages must be checked out separately from standard room reservations.",
		);
	}
	if (!hotel || !normalizeId(hotel)) {
		return validationFailure(
			"fixed_package_hotel_missing",
			"The package hotel could not be verified. Please refresh the offers page.",
		);
	}
	if (hotel.activateHotel === false || hotel.xHotelProActive === false) {
		return validationFailure(
			"fixed_package_hotel_inactive",
			"This package is no longer available. Please refresh the offers page.",
		);
	}
	const requestHotelId = normalizeId(payload.hotelId);
	const hotelId = normalizeId(hotel);
	if (!requestHotelId || requestHotelId !== hotelId) {
		return validationFailure(
			"fixed_package_hotel_mismatch",
			"The selected package does not belong to this hotel. Please refresh your cart.",
		);
	}

	const topFrom = canonicalPackageDateKey(payload.checkin_date);
	const topTo = canonicalPackageDateKey(payload.checkout_date);
	if (!topFrom || !topTo) {
		return validationFailure(
			"fixed_package_top_level_dates_invalid",
			"The package dates are invalid. Please refresh the offers page.",
		);
	}

	const hotelRooms = Array.isArray(hotel.roomCountDetails)
		? hotel.roomCountDetails
		: [];
	const selections = [];
	const windowKeys = new Set();
	let expectedGuestTotal = 0;
	let expectedBaseGuestTotal = 0;
	let expectedRootTotal = 0;
	const payInHotel = isPayInHotelPackagePayload(payload);
	const payInHotelMarkupApplied = payInHotel && applyPayInHotelMarkup !== false;
	const guestMarkup = payInHotelMarkupApplied
		? FIXED_PACKAGE_PAY_IN_HOTEL_MARKUP
		: 1;

	for (let index = 0; index < rooms.length; index += 1) {
		const selected = rooms[index] || {};
		const meta =
			selected.packageMeta && typeof selected.packageMeta === "object"
				? selected.packageMeta
				: null;
		if (!meta || selected.fromPackagesOffers !== true) {
			return validationFailure(
				"fixed_package_reference_required",
				"This package cart is missing its authoritative offer reference. Please remove it and add it again.",
				{ selectionIndex: index },
			);
		}
		const type = normalizePackageType(meta.type);
		const fields = TYPE_FIELDS[type];
		const roomId = normalizeId(meta.roomId);
		const packageId = normalizeId(meta.pkgId);
		const count = roomCountForPackage(selected.count);
		if (!fields || !roomId || !packageId || !count) {
			return validationFailure(
				"fixed_package_reference_invalid",
				"This package reference is invalid. Please remove it and add it again.",
				{ selectionIndex: index },
			);
		}
		if (selected.lockDates !== true && selected.datesLocked !== true) {
			return validationFailure(
				"fixed_package_dates_not_locked",
				"Package dates are fixed and cannot be changed. Please refresh your cart.",
				{ selectionIndex: index },
			);
		}
		const room = hotelRooms.find((candidate) => normalizeId(candidate) === roomId);
		if (!room || room.activeRoom !== true) {
			return validationFailure(
				"fixed_package_room_unavailable",
				"The room attached to this package is no longer available.",
				{ selectionIndex: index, roomId },
			);
		}
		const selectedRoomType = normalizeText(
			selected.room_type || selected.roomType,
		);
		const configuredRoomType = normalizeText(room.roomType || room.room_type);
		const selectedDisplayName = normalizeText(
			selected.displayName || selected.display_name,
		);
		const configuredDisplayNames = new Set(
			[
				room.displayName,
				room.display_name,
				room.displayName_OtherLanguage,
			]
				.map(normalizeText)
				.filter(Boolean),
		);
		if (
			!selectedRoomType ||
			selectedRoomType !== configuredRoomType ||
			!selectedDisplayName ||
			!configuredDisplayNames.has(selectedDisplayName)
		) {
			return validationFailure(
				"fixed_package_room_identity_mismatch",
				"The selected package room does not match its configured room. Please refresh your cart.",
				{ selectionIndex: index, roomId },
			);
		}
		const configuredRow = (Array.isArray(room?.[fields.array])
			? room[fields.array]
			: []
		).find((candidate) => normalizeId(candidate) === packageId);
		if (!configuredRow) {
			return validationFailure(
				"fixed_package_not_found",
				"This package is no longer available. Please refresh the offers page.",
				{ selectionIndex: index, roomId, packageId, type },
			);
		}
		const eligibility = fixedPackageEligibility(configuredRow, type, { now });
		if (!eligibility.eligible) {
			return validationFailure(
				eligibility.code,
				"This fixed-date package has started, expired, or is no longer valid. Please choose a future package.",
				{ selectionIndex: index, roomId, packageId, type },
			);
		}
		const { config, nights } = eligibility;
		if (topFrom !== config.from || topTo !== config.to) {
			return validationFailure(
				"fixed_package_top_level_window_mismatch",
				"Package dates are fixed and must match the configured offer window.",
				{ selectionIndex: index, from: config.from, to: config.to },
			);
		}
		const metaFrom = canonicalPackageDateKey(meta.from);
		const metaTo = canonicalPackageDateKey(meta.to);
		if (metaFrom !== config.from || metaTo !== config.to) {
			return validationFailure(
				"fixed_package_metadata_window_mismatch",
				"The package date details changed. Please refresh the offers page.",
				{ selectionIndex: index, from: config.from, to: config.to },
			);
		}
		if (Number(meta.nights) !== nights || meta.usesSelectedStayDates === true) {
			return validationFailure(
				"fixed_package_nights_mismatch",
				"The complete fixed package must be reserved without slicing its dates.",
				{ selectionIndex: index, nights },
			);
		}
		if (!moneyMatches(meta.totalSar, config.guestTotal)) {
			return validationFailure(
				"fixed_package_guest_total_mismatch",
				"The package price changed. Please refresh the offers page before checkout.",
				{ selectionIndex: index },
			);
		}
		if (!moneyMatches(meta.totalRootSar, config.rootTotal)) {
			return validationFailure(
				"fixed_package_root_total_mismatch",
				"The package pricing details changed. Please refresh the offers page before checkout.",
				{ selectionIndex: index },
			);
		}

		const expectedDates = packageDateKeys(
			config.from,
			config.to,
			FIXED_PACKAGE_MAX_NIGHTS[type],
		);
		const pricingRows = Array.isArray(selected.pricingByDay)
			? selected.pricingByDay
			: [];
		if (!sameDateList(rowDateKeys(pricingRows), expectedDates)) {
			return validationFailure(
				"fixed_package_daily_dates_mismatch",
				"The package daily pricing must cover every fixed date exactly once.",
				{ selectionIndex: index, from: config.from, to: config.to },
			);
		}
		const selectedGuestTotal = sumMoneyField(pricingRows, [
			"totalPriceWithCommission",
			"price",
		]);
		const selectedRootTotal = sumMoneyField(pricingRows, ["rootPrice"]);
		const configuredCheckoutGuestTotal = Number(
			(config.guestTotal * guestMarkup).toFixed(2),
		);
		if (!moneyMatches(selectedGuestTotal, configuredCheckoutGuestTotal)) {
			return validationFailure(
				"fixed_package_daily_guest_total_mismatch",
				"The package price is not current. Please refresh the offers page before checkout.",
				{ selectionIndex: index },
			);
		}
		if (
			selected.totalPriceWithCommission !== undefined &&
			selected.totalPriceWithCommission !== null &&
			!moneyMatches(selected.totalPriceWithCommission, selectedGuestTotal)
		) {
			return validationFailure(
				"fixed_package_room_guest_total_mismatch",
				"The package room total does not match its daily pricing. Please refresh your cart.",
				{ selectionIndex: index },
			);
		}
		if (!moneyMatches(selectedRootTotal, config.rootTotal)) {
			return validationFailure(
				"fixed_package_daily_root_total_mismatch",
				"The package pricing details are not current. Please refresh the offers page before checkout.",
				{ selectionIndex: index },
			);
		}
		if (!moneyMatches(selected.hotelShouldGet, config.rootTotal)) {
			return validationFailure(
				"fixed_package_room_root_total_mismatch",
				"The package pricing details are incomplete. Please refresh the offers page before checkout.",
				{ selectionIndex: index },
			);
		}

		windowKeys.add(`${config.from}|${config.to}`);
		expectedGuestTotal += configuredCheckoutGuestTotal * count;
		expectedBaseGuestTotal += config.guestTotal * count;
		expectedRootTotal += config.rootTotal * count;
		selections.push({
			roomId,
			type,
			packageId,
			count,
			from: config.from,
			to: config.to,
			nights,
			guestTotal: config.guestTotal,
			rootTotal: config.rootTotal,
		});
	}

	if (windowKeys.size !== 1) {
		return validationFailure(
			"fixed_package_mixed_windows",
			"Fixed-date packages with different date windows must be checked out separately.",
		);
	}
	expectedGuestTotal = Number(expectedGuestTotal.toFixed(2));
	expectedBaseGuestTotal = Number(expectedBaseGuestTotal.toFixed(2));
	expectedRootTotal = Number(expectedRootTotal.toFixed(2));
	if (!moneyMatches(payload.total_amount, expectedGuestTotal)) {
		return validationFailure(
			"fixed_package_reservation_total_mismatch",
			"The reservation total does not match the configured package price. Please refresh your cart.",
		);
	}
	const expectedNights = selections[0]?.nights || 0;
	if (Number(payload.days_of_residence) !== expectedNights) {
		return validationFailure(
			"fixed_package_stay_length_mismatch",
			"The complete package stay length must be reserved.",
		);
	}

	return {
		applies: true,
		valid: true,
		statusCode: 200,
		code: "fixed_package_valid",
		from: topFrom,
		to: topTo,
		nights: expectedNights,
		payInHotel,
		payInHotelMarkupApplied,
		guestMarkup,
		expectedGuestTotal,
		expectedBaseGuestTotal,
		expectedRootTotal,
		selections,
	};
};

const fixedPackageConflictResponse = (validation = {}) => ({
	message:
		validation.message ||
		"This fixed-date package is no longer available. Please refresh the offers page.",
	code: validation.code || "fixed_package_invalid",
	refreshRequired: true,
	fixedPackage: {
		valid: false,
		code: validation.code || "fixed_package_invalid",
		...(validation?.details?.from ? { from: validation.details.from } : {}),
		...(validation?.details?.to ? { to: validation.details.to } : {}),
	},
});

module.exports = {
	FIXED_PACKAGE_MAX_NIGHTS,
	FIXED_PACKAGE_MAX_START_YEARS,
	FIXED_PACKAGE_PAY_IN_HOTEL_MARKUP,
	FIXED_PACKAGE_TIME_ZONE,
	FixedPackageValidationError,
	bookableFixedPackageRows,
	canonicalPackageDateKey,
	filterRoomToBookableFixedPackages,
	fixedPackageConfig,
	fixedPackageConflictResponse,
	fixedPackageEligibility,
	fixedPackageSelectionsMatch,
	hasFixedPackageReservationSignal,
	hasFixedPackageSignal,
	isPayInHotelPackagePayload,
	moneyMatches,
	normalizePackageType,
	packageDateDifference,
	packageDateKeys,
	packageSelectionSignature,
	saudiTodayKey,
	sortFixedPackageRows,
	validateFixedPackageReservationPayload,
};
