/** @format */

const crypto = require("crypto");

const MAX_TEXT = 4_000;
const MAX_IDENTIFIER = 256;
const MAX_ROOMS = 100;
const MAX_NIGHTS_PER_ROOM = 366;
// HotelRunner and the PMS may differ slightly, but a remote clock must not be
// allowed to advance durable ordering watermarks arbitrarily far ahead.
const MAX_SOURCE_UPDATED_AT_FUTURE_SKEW_MS = 5 * 60 * 1000;
const MAX_FINANCIAL_DETAIL_ROWS = 100;
const MAX_FINANCIAL_DETAIL_KEYS = 50;
const MAX_FINANCIAL_DETAIL_DEPTH = 4;
const SENSITIVE_DETAIL_KEY =
	/(?:auth|bearer|card(?:holder|number)?|credential|cvv|cvc|password|secret|token|expir(?:y|ation)|security[_\s-]?code|account[_\s-]?number|track[_\s-]?data|cryptogram)/i;

const isSensitiveFinancialDetailKey = (key = "") => {
	const text = String(key || "");
	const compact = text.toLowerCase().replace(/[^a-z0-9]+/g, "");
	return Boolean(
		SENSITIVE_DETAIL_KEY.test(text) ||
		compact.endsWith("pan")
	);
};

const cleanText = (value, max = MAX_TEXT) =>
	String(value == null ? "" : value)
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, max);

const cleanIdentifier = (value) => cleanText(value, MAX_IDENTIFIER);

function stableClone(value) {
	if (Array.isArray(value)) return value.map(stableClone);
	if (value instanceof Date) {
		return Number.isFinite(value.getTime()) ? value.toISOString() : null;
	}
	if (value && typeof value === "object") {
		return Object.keys(value)
			.filter((key) => !["__proto__", "prototype", "constructor"].includes(key))
			.sort()
			.reduce((result, key) => {
				result[key] = stableClone(value[key]);
				return result;
			}, {});
	}
	return value;
}

const stableStringify = (value) => JSON.stringify(stableClone(value));
const sha256 = (value) =>
	crypto.createHash("sha256").update(String(value), "utf8").digest("hex");

const hashObject = (value) => sha256(stableStringify(value));

function parseDateOnly(value) {
	const text = cleanIdentifier(value);
	if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return "";
	const [year, month, day] = text.split("-").map(Number);
	const parsed = new Date(Date.UTC(year, month - 1, day));
	return parsed.getUTCFullYear() === year &&
		parsed.getUTCMonth() === month - 1 &&
		parsed.getUTCDate() === day
		? text
		: "";
}

function parseTimestamp(value) {
	const text = cleanIdentifier(value);
	if (!text) return null;
	const parsed = new Date(text);
	return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function parseTimezoneQualifiedTimestamp(value) {
	const text = cleanIdentifier(value);
	const match = text.match(
		/^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.[0-9]{1,9})?(Z|[+-]([0-9]{2}):([0-9]{2}))$/i
	);
	if (!match) return null;
	const [, yearText, monthText, dayText, hourText, minuteText, secondText] =
		match;
	const year = Number(yearText);
	const month = Number(monthText);
	const day = Number(dayText);
	const hour = Number(hourText);
	const minute = Number(minuteText);
	const second = Number(secondText);
	const offsetHour = match[8] === undefined ? 0 : Number(match[8]);
	const offsetMinute = match[9] === undefined ? 0 : Number(match[9]);
	const daysInMonth =
		month >= 1 && month <= 12
			? new Date(Date.UTC(year, month, 0)).getUTCDate()
			: 0;
	if (
		day < 1 ||
		day > daysInMonth ||
		hour > 23 ||
		minute > 59 ||
		second > 59 ||
		offsetHour > 23 ||
		offsetMinute > 59
	) {
		return null;
	}
	return parseTimestamp(text);
}

function decimalToCents(value) {
	if (value === null || value === undefined || value === "") return null;
	const text = String(value).trim().replace(/,/g, "");
	if (!/^-?\d+(?:\.\d+)?$/.test(text)) return null;
	const negative = text.startsWith("-");
	const unsigned = negative ? text.slice(1) : text;
	const [wholeRaw, fractionRaw = ""] = unsigned.split(".");
	const fraction = `${fractionRaw}00`.slice(0, 3);
	let cents = Number.parseInt(wholeRaw, 10) * 100;
	cents += Number.parseInt(fraction.slice(0, 2), 10);
	if (Number(fraction[2] || 0) >= 5) cents += 1;
	if (!Number.isSafeInteger(cents)) return null;
	return negative ? -cents : cents;
}

function decimalToFiniteNumber(value) {
	if (value === null || value === undefined || value === "") return null;
	const text = String(value).trim().replace(/,/g, "");
	if (!/^-?\d+(?:\.\d+)?$/.test(text)) return null;
	const parsed = Number(text);
	return Number.isFinite(parsed) ? parsed : null;
}

const centsToAmount = (cents) =>
	Number.isSafeInteger(cents) ? Number((cents / 100).toFixed(2)) : 0;

function normalizeState(value) {
	const state = cleanIdentifier(value).toLowerCase();
	if (state === "cancelled") return "canceled";
	if (["reserved", "confirmed", "canceled"].includes(state)) return state;
	return "unknown";
}

function normalizeNextState(value) {
	const state = cleanIdentifier(value).toLowerCase();
	if (["confirm", "confirmed"].includes(state)) return "confirm";
	if (["cancel", "canceled", "cancelled"].includes(state)) return "cancel";
	return "";
}

function dateRange(from, to) {
	const start = parseDateOnly(from);
	const end = parseDateOnly(to);
	if (!start || !end || start >= end) return [];
	const rows = [];
	let cursor = new Date(`${start}T00:00:00.000Z`);
	const endDate = new Date(`${end}T00:00:00.000Z`);
	while (cursor < endDate && rows.length <= MAX_NIGHTS_PER_ROOM) {
		rows.push(cursor.toISOString().slice(0, 10));
		cursor = new Date(cursor.getTime() + 86_400_000);
	}
	return rows.length <= MAX_NIGHTS_PER_ROOM ? rows : [];
}

function normalizeDailyPrices(rows = []) {
	if (!Array.isArray(rows)) return { rows: [], overflow: false };
	return {
		rows: rows.slice(0, MAX_NIGHTS_PER_ROOM).map((row) => ({
		date: parseDateOnly(row?.date),
		priceCents: decimalToCents(row?.price),
		originalPriceCents: decimalToCents(row?.original_price),
		discountCents: decimalToCents(row?.discount),
		rateCode: cleanIdentifier(row?.rate_code),
		version: cleanIdentifier(row?.version),
		})),
		overflow: rows.length > MAX_NIGHTS_PER_ROOM,
	};
}

const boundedWholeNumber = (value, max = 10_000) => {
	if (value === null || value === undefined || value === "") return null;
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed >= 0 && parsed <= max ? parsed : null;
};

function sanitizeFinancialDetail(value, depth = 0) {
	if (value === null || value === undefined) return null;
	if (typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value === "string") return cleanText(value);
	if (value instanceof Date) {
		return Number.isFinite(value.getTime()) ? value.toISOString() : null;
	}
	if (depth >= MAX_FINANCIAL_DETAIL_DEPTH) return null;
	if (Array.isArray(value)) {
		return value
			.slice(0, MAX_FINANCIAL_DETAIL_ROWS)
			.map((item) => sanitizeFinancialDetail(item, depth + 1));
	}
	if (typeof value !== "object") return null;
	return Object.entries(value)
		.filter(
			([key]) =>
				!["__proto__", "prototype", "constructor"].includes(key) &&
				!isSensitiveFinancialDetailKey(key)
		)
		.slice(0, MAX_FINANCIAL_DETAIL_KEYS)
		.reduce((result, [key, item]) => {
			const safeKey = cleanIdentifier(key);
			if (safeKey) result[safeKey] = sanitizeFinancialDetail(item, depth + 1);
			return result;
		}, {});
}

function normalizeFinancialDetails(rows) {
	return {
		rows: Array.isArray(rows)
			? rows
					.slice(0, MAX_FINANCIAL_DETAIL_ROWS)
					.map((row) => sanitizeFinancialDetail(row))
			: [],
		overflow: Array.isArray(rows) && rows.length > MAX_FINANCIAL_DETAIL_ROWS,
	};
}

function normalizeRoomExtras(rows) {
	return {
		rows: Array.isArray(rows)
			? rows.slice(0, MAX_FINANCIAL_DETAIL_ROWS).map((row) => ({
					name: cleanText(row?.name),
					priceCents: decimalToCents(row?.price),
					basePriceCents: decimalToCents(row?.base_price),
					code: cleanIdentifier(row?.code),
					promotionsTotalCents: decimalToCents(row?.promotions_total),
					isExtra: typeof row?.is_extra === "boolean" ? row.is_extra : null,
					totalCents: decimalToCents(row?.total),
					quantity: decimalToFiniteNumber(row?.quantity),
					dates: sanitizeFinancialDetail(row?.dates),
					repeatType: cleanIdentifier(row?.repeat_type),
					includedInPrice:
						typeof row?.included_in_price === "boolean"
							? row.included_in_price
							: null,
			  }))
			: [],
		overflow: Array.isArray(rows) && rows.length > MAX_FINANCIAL_DETAIL_ROWS,
	};
}

const normalizeComments = (comments) =>
	Array.isArray(comments)
		? comments
				.slice(0, 25)
				.map((item) => ({
					body:
						typeof item === "string"
							? cleanText(item)
							: cleanText(
									item?.body || item?.comment || item?.text || item?.note || ""
							  ),
					channelNote: item?.channel_note === true,
					housekeeping: item?.housekeeping === true,
					guestVisible: item?.guest_visible === true,
				}))
				.filter((item) => item.body)
		: [];

function normalizeRoom(room = {}, index = 0) {
	const checkinDate = parseDateOnly(room?.checkin_date);
	const checkoutDate = parseDateOnly(room?.checkout_date);
	const dailyPrices = normalizeDailyPrices(room?.daily_prices);
	const extras = normalizeRoomExtras(room?.extras);
	const totalGuests = boundedWholeNumber(room?.total_guest, 1_000);
	const adults = boundedWholeNumber(room?.total_adult, 1_000);
	const reportedChildCount = Array.isArray(room?.child_ages)
		? room.child_ages.length
		: 0;
	const children =
		totalGuests !== null && adults !== null && adults <= totalGuests
			? totalGuests - adults
			: reportedChildCount;
	return {
		index,
		roomId: cleanIdentifier(room?.id),
		code: cleanIdentifier(room?.code),
		number: cleanIdentifier(room?.number),
		voucherNumber: cleanIdentifier(room?.voucher_number),
		availabilityGroup: cleanIdentifier(room?.availability_group),
		state: normalizeState(room?.state),
		invCode: cleanIdentifier(room?.inv_code || room?.availability_group),
		rateCode: cleanIdentifier(room?.rate_code),
		ratePlanCode: cleanIdentifier(room?.rate_plan_code),
		name: cleanText(room?.name),
		namePresentation: cleanText(room?.name_presentation),
		checkinDate,
		checkoutDate,
		nights: boundedWholeNumber(room?.nights, MAX_NIGHTS_PER_ROOM),
		totalGuests,
		adults,
		children,
		priceCents: decimalToCents(room?.price),
		totalCents: decimalToCents(room?.total),
		roomBasePriceCents: decimalToCents(room?.room_base_price),
		roomSubTotalCents: decimalToCents(room?.room_sub_total),
		nonRefundable: room?.non_refundable === true,
		mealPlan: cleanText(room?.meal_plan),
		mealPlanPresentation: cleanText(room?.meal_plan_presentation),
		extraInfo: cleanText(room?.extra_info),
		extras: extras.rows,
		extrasOverflow: extras.overflow,
		extrasTotalCents: decimalToCents(room?.extras_total),
		fixedAdjustmentsTotalCents: decimalToCents(room?.fixed_adjustments_total),
		includedTaxesTotalCents: decimalToCents(room?.included_taxes_total),
		excludedFeesAndTaxesTotalCents: decimalToCents(
			room?.excluded_fees_and_taxes_total
		),
		cancelationRefundTotalCents: decimalToCents(
			room?.cancelation_refund_total
		),
		cancelationRefundTaxType: cleanIdentifier(
			room?.cancelation_refund_tax_type
		),
		cancelationPenaltyTotalCents: decimalToCents(
			room?.cancelation_penalty_total
		),
		cancelationPenaltyTaxType: cleanIdentifier(
			room?.cancelation_penalty_tax_type
		),
		promotionsTotalCents: decimalToCents(room?.promotions_total),
		meta: sanitizeFinancialDetail(room?.meta),
		comments: normalizeComments(room?.comments),
		dailyPrices: dailyPrices.rows,
		dailyPricesOverflow: dailyPrices.overflow,
		updatedAt: parseTimestamp(room?.updated_at),
		identifierOverflow: [
			room?.id,
			room?.inv_code,
			room?.availability_group,
			room?.rate_code,
			room?.rate_plan_code,
		].some((value) => String(value == null ? "" : value).trim().length > MAX_IDENTIFIER),
	};
}

function validationIssues(normalized) {
	const issues = [];
	const add = (code) => {
		if (!issues.includes(code)) issues.push(code);
	};
	if (!normalized.messageUidValid) add("invalid_message_uid");
	if (!normalized.hotelRunnerReservationId) add("invalid_reservation_id");
	if (normalized.sourceUpdatedAtTooFarInFuture) {
		add("source_updated_at_too_far_in_future");
	} else if (!normalized.sourceUpdatedAt) {
		add("invalid_source_updated_at");
	}
	if (normalized.state === "unknown") add("unknown_state");
	if (normalized.roomsOverflow) add("room_resource_limit");
	if (normalized.paymentsOverflow) add("payment_resource_limit");
	if (normalized.identifierOverflow) add("identifier_resource_limit");
	const hasCompleteStay = Boolean(
		normalized.checkinDate &&
			normalized.checkoutDate &&
			dateRange(normalized.checkinDate, normalized.checkoutDate).length
	);
	if (normalized.state !== "canceled" && !hasCompleteStay) add("invalid_stay_dates");
	if (
		normalized.state === "canceled" &&
		normalized.stayWasSupplied &&
		!hasCompleteStay
	) {
		add("invalid_stay_dates");
	}
	if (
		normalized.state !== "canceled" &&
		(normalized.totalCents === null || normalized.totalCents < 0)
	) add("invalid_total");
	if (normalized.state !== "canceled") {
		if (!normalized.guestName) add("missing_guest");
		if (!normalized.currency || !/^[A-Z]{3}$/.test(normalized.currency)) {
			add("invalid_currency");
		}
		if (normalized.totalRooms === null || normalized.totalRooms < 1) {
			add("invalid_room_count");
		}
		if (normalized.totalGuests === null || normalized.totalGuests < 1) {
			add("invalid_guest_count");
		}
		if (!normalized.rooms.length) add("missing_rooms");
		for (const room of normalized.rooms) {
			if (room.identifierOverflow) add("identifier_resource_limit");
			if (room.extrasOverflow) add("room_extra_resource_limit");
			if (!room.invCode) add("missing_room_inv_code");
			if (
				!["reserved", "confirmed"].includes(room.state) ||
				room.state !== normalized.state
			) {
				add("mixed_or_unsupported_room_state");
			}
			if (
				room.checkinDate !== normalized.checkinDate ||
				room.checkoutDate !== normalized.checkoutDate
			) {
				add("room_stay_conflict");
			}
			const expectedDates = dateRange(room.checkinDate, room.checkoutDate);
			if (room.dailyPricesOverflow) add("daily_price_resource_limit");
			if (!room.dailyPrices.length) add("missing_room_daily_prices");
			if (
				room.dailyPrices.some(
					(day) => !Number.isSafeInteger(day.priceCents) || day.priceCents < 0
				)
			) {
				add("invalid_room_daily_price");
			}
			if (room.nights === null || room.nights !== expectedDates.length) {
				add("room_nights_conflict");
			}
			if (
				room.totalGuests === null ||
				room.totalGuests < 1 ||
				room.adults === null ||
				room.adults > room.totalGuests
			) {
				add("invalid_room_guest_count");
			}
			if (
				room.dailyPrices.length &&
				(expectedDates.length !== room.dailyPrices.length ||
					expectedDates.some(
						(date, index) => room.dailyPrices[index]?.date !== date
					))
			) {
				add("room_daily_prices_conflict");
			}
		}
	}
	if (normalized.financialDetailsOverflow) add("pricing_detail_resource_limit");
	if (
		normalized.state !== "canceled" &&
		normalized.totalGuests !== null &&
		normalized.rooms.length > 0 &&
		normalized.rooms.every((room) => room.totalGuests !== null) &&
		normalized.rooms.reduce((sum, room) => sum + room.totalGuests, 0) !==
			normalized.totalGuests
	) {
		add("guest_count_conflict");
	}
	if (
		normalized.totalRooms !== null &&
		normalized.totalRooms > 0 &&
		normalized.rooms.length > 0 &&
		normalized.totalRooms !== normalized.rooms.length
	) {
		add("room_count_conflict");
	}
	return issues;
}

function normalizeSafePayments(rows) {
	return Array.isArray(rows)
		? rows.slice(0, 100).map((row) => ({
				id: cleanIdentifier(row?.id),
				state: cleanIdentifier(row?.state).toLowerCase(),
				amountCents: decimalToCents(row?.amount),
				currency: cleanIdentifier(row?.currency).toUpperCase(),
				exchangedAmountCents: decimalToCents(row?.exchanged_amount),
				exchangeCurrency: cleanIdentifier(row?.exchange_currency).toUpperCase(),
				exchangeRate: decimalToFiniteNumber(row?.exchange_rate),
				paidAt: parseTimestamp(row?.paid_at),
				methodName: cleanText(row?.payment_method_name),
				method: cleanIdentifier(row?.payment_method).toLowerCase(),
				installment: boundedWholeNumber(row?.installment, 1_000),
				responseCode: cleanIdentifier(row?.response_code),
			}))
		: [];
}

function sanitizedStoredPayload(normalized = {}) {
	return stableClone({
		messageUid: normalized.messageUid,
		hotelRunnerReservationId: normalized.hotelRunnerReservationId,
		hrNumber: normalized.hrNumber,
		providerNumber: normalized.providerNumber,
		pmsNumber: normalized.pmsNumber,
		channel: normalized.channel,
		channelDisplay: normalized.channelDisplay,
		sourceDisplay: normalized.sourceDisplay,
		state: normalized.state,
		modified: normalized.modified,
		requiresResponse: normalized.requiresResponse,
		nextStates: normalized.nextStates,
		guestName: normalized.guestName,
		firstName: normalized.firstName,
		lastName: normalized.lastName,
		country: normalized.country,
		phone: normalized.phone,
		email: normalized.email,
		address: normalized.address,
		checkinDate: normalized.checkinDate,
		checkoutDate: normalized.checkoutDate,
		stayWasSupplied: normalized.stayWasSupplied === true,
		bookedAt: normalized.bookedAt,
		sourceUpdatedAt: normalized.sourceUpdatedAt,
		totalGuests: normalized.totalGuests,
		totalRooms: normalized.totalRooms,
		subTotalCents: normalized.subTotalCents,
		extrasTotalCents: normalized.extrasTotalCents,
		adjustmentsTotalCents: normalized.adjustmentsTotalCents,
		itemTotalCents: normalized.itemTotalCents,
		taxTotalCents: normalized.taxTotalCents,
		totalCents: normalized.totalCents,
		currency: normalized.currency,
		note: normalized.note,
		cancelReason: normalized.cancelReason,
		paymentMethod: normalized.paymentMethod,
		paidAmountCents: normalized.paidAmountCents,
		payments: normalized.payments,
		depositTaxInclusive: normalized.depositTaxInclusive,
		extraAdjustmentsDetails: normalized.extraAdjustmentsDetails,
		adjustmentDetails: normalized.adjustmentDetails,
		priceAdjustmentsDetails: normalized.priceAdjustmentsDetails,
		cancelationPolicy: normalized.cancelationPolicy,
		rooms: normalized.rooms,
		issues: normalized.issues,
	});
}

function canonicalPayload(normalized = {}) {
	const sanitized = sanitizedStoredPayload(normalized);
	delete sanitized.messageUid;
	delete sanitized.issues;
	delete sanitized.sourceUpdatedAt;
	delete sanitized.modified;
	sanitized.rooms = (sanitized.rooms || [])
		.map((room) => {
			const copy = { ...room };
			delete copy.index;
			delete copy.updatedAt;
			delete copy.dailyPricesOverflow;
			delete copy.identifierOverflow;
			copy.dailyPrices = (copy.dailyPrices || []).sort((left, right) => {
				const dateOrder = String(left?.date || "").localeCompare(
					String(right?.date || "")
				);
				return dateOrder || stableStringify(left).localeCompare(stableStringify(right));
			});
			return copy;
		})
		.sort((left, right) => {
			const identityOrder = [
				left.roomId,
				left.invCode,
				left.rateCode,
				left.ratePlanCode,
				left.checkinDate,
			].join("\u0000").localeCompare(
				[
					right.roomId,
					right.invCode,
					right.rateCode,
					right.ratePlanCode,
					right.checkinDate,
				].join("\u0000")
			);
			return identityOrder || stableStringify(left).localeCompare(stableStringify(right));
		});
	return stableClone(sanitized);
}

function normalizeHotelRunnerReservation(raw = {}, { receivedAt = null } = {}) {
	const payload = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
	const payloadHash = hashObject(payload);
	const rawMessageUid = String(payload.message_uid == null ? "" : payload.message_uid).trim();
	const originalMessageUid = cleanIdentifier(payload.message_uid);
	const messageUidValid = Boolean(
		typeof payload.message_uid === "string" &&
			rawMessageUid &&
			rawMessageUid.length <= MAX_IDENTIFIER
	);
	const messageUid = messageUidValid
		? originalMessageUid
		: `invalid-${payloadHash.slice(0, 32)}`;
	const address = payload.address && typeof payload.address === "object"
		? payload.address
		: {};
	const roomsOverflow = Array.isArray(payload.rooms) && payload.rooms.length > MAX_ROOMS;
	const rooms = Array.isArray(payload.rooms)
		? payload.rooms.slice(0, MAX_ROOMS).map(normalizeRoom)
		: [];
	const extraAdjustments = normalizeFinancialDetails(
		payload.extra_adjustments_details
	);
	const adjustments = normalizeFinancialDetails(payload.adjustment_details);
	const priceAdjustments = normalizeFinancialDetails(
		payload.price_adjustments_details
	);
	const cancelationPolicy = normalizeFinancialDetails(payload.cancelation_policy);
	const parsedSourceUpdatedAt = parseTimezoneQualifiedTimestamp(payload.updated_at);
	const receiptTimestamp =
		receivedAt instanceof Date && Number.isFinite(receivedAt.getTime())
			? receivedAt
			: parseTimestamp(receivedAt);
	const sourceUpdatedAtTooFarInFuture = Boolean(
		parsedSourceUpdatedAt &&
			receiptTimestamp &&
			parsedSourceUpdatedAt.getTime() >
				receiptTimestamp.getTime() + MAX_SOURCE_UPDATED_AT_FUTURE_SKEW_MS
	);
	const sourceUpdatedAt = sourceUpdatedAtTooFarInFuture
		? null
		: parsedSourceUpdatedAt;
	const rawReservationId = String(
		payload.reservation_id == null ? "" : payload.reservation_id
	).trim();
	const normalized = {
		messageUid,
		messageUidValid,
		hotelRunnerReservationId:
			rawReservationId && rawReservationId.length <= MAX_IDENTIFIER
				? cleanIdentifier(payload.reservation_id)
				: "",
		hrNumber: cleanIdentifier(payload.hr_number),
		providerNumber: cleanIdentifier(payload.provider_number),
		pmsNumber: cleanIdentifier(payload.pms_number),
		channel: cleanIdentifier(payload.channel).toLowerCase(),
		channelDisplay: cleanText(payload.channel_display),
		sourceDisplay: cleanText(payload.source_display),
		state: normalizeState(payload.state),
		modified: payload.modified === true,
		requiresResponse: payload.requires_response === true,
		nextStates: Array.isArray(payload.next_states)
			? Array.from(
					new Set(
						payload.next_states
							.slice(0, 10)
							.map(normalizeNextState)
							.filter(Boolean)
					)
			  )
			: [],
		guestName:
			cleanText(payload.guest) ||
			cleanText(`${payload.firstname || ""} ${payload.lastname || ""}`),
		firstName: cleanText(payload.firstname),
		lastName: cleanText(payload.lastname),
		country: cleanText(payload.country || address.country_code || address.country),
		phone: cleanText(address.phone, 200),
		email: cleanText(address.email, 320),
		address: {
			city: cleanText(address.city),
			state: cleanText(address.state),
			country: cleanText(address.country),
			countryCode: cleanIdentifier(address.country_code).toUpperCase(),
			phone: cleanText(address.phone, 200),
			email: cleanText(address.email, 320),
			street: cleanText(address.street),
			street2: cleanText(address.street_2),
			postalCode: cleanText(address.postal_code, 100),
		},
		checkinDate: parseDateOnly(payload.checkin_date),
		checkoutDate: parseDateOnly(payload.checkout_date),
		stayWasSupplied:
			(payload.checkin_date !== null && payload.checkin_date !== undefined) ||
			(payload.checkout_date !== null && payload.checkout_date !== undefined),
		bookedAt: parseTimestamp(payload.completed_at),
		sourceUpdatedAt,
		sourceUpdatedAtTooFarInFuture,
		totalGuests: boundedWholeNumber(payload.total_guests, 10_000),
		totalRooms:
			payload.total_rooms === null || payload.total_rooms === undefined
				? rooms.length
				: boundedWholeNumber(payload.total_rooms, MAX_ROOMS),
		subTotalCents: decimalToCents(payload.sub_total),
		extrasTotalCents: decimalToCents(payload.extras_total),
		adjustmentsTotalCents: decimalToCents(payload.adjustments_total),
		itemTotalCents: decimalToCents(payload.item_total),
		taxTotalCents: decimalToCents(payload.tax_total),
		totalCents: decimalToCents(payload.total),
		currency: cleanIdentifier(payload.currency).toUpperCase(),
		note: cleanText(payload.note),
		cancelReason: cleanText(payload.cancel_reason),
		paymentMethod: cleanText(payload.payment),
		paidAmountCents: decimalToCents(payload.paid_amount),
		payments: normalizeSafePayments(payload.payments),
		paymentsOverflow: Array.isArray(payload.payments) && payload.payments.length > 100,
		depositTaxInclusive:
			typeof payload.deposit_tax_inclusive === "boolean"
				? payload.deposit_tax_inclusive
				: null,
		extraAdjustmentsDetails: extraAdjustments.rows,
		adjustmentDetails: adjustments.rows,
		priceAdjustmentsDetails: priceAdjustments.rows,
		cancelationPolicy: cancelationPolicy.rows,
		financialDetailsOverflow: [
			extraAdjustments,
			adjustments,
			priceAdjustments,
			cancelationPolicy,
		].some((detail) => detail.overflow),
		rooms,
		roomsOverflow,
		identifierOverflow: [payload.hr_number, payload.provider_number, payload.pms_number]
			.some(
				(value) =>
					String(value == null ? "" : value).trim().length > MAX_IDENTIFIER
			),
		payloadHash,
		canonicalHash: "",
	};
	normalized.issues = validationIssues(normalized);
	normalized.canonicalHash = hashObject(canonicalPayload(normalized));
	normalized.storedPayload = sanitizedStoredPayload(normalized);
	return normalized;
}

function eventKey(hrIdFingerprint, messageUid) {
	return sha256(`${cleanIdentifier(hrIdFingerprint)}\u0000${cleanIdentifier(messageUid)}`);
}

module.exports = {
	MAX_IDENTIFIER,
	MAX_NIGHTS_PER_ROOM,
	MAX_ROOMS,
	MAX_SOURCE_UPDATED_AT_FUTURE_SKEW_MS,
	canonicalPayload,
	centsToAmount,
	cleanIdentifier,
	cleanText,
	dateRange,
	decimalToCents,
	eventKey,
	hashObject,
	normalizeHotelRunnerReservation,
	normalizeNextState,
	normalizeState,
	sanitizedStoredPayload,
	parseDateOnly,
	parseTimestamp,
	sha256,
	stableClone,
	stableStringify,
	validationIssues,
};
