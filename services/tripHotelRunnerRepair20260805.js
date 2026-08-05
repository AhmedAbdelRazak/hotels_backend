/**
 * Pure planning and verification helpers for the narrowly scoped Trip.com /
 * HotelRunner incident repair from 2026-08-05.
 *
 * This module performs no database I/O. The companion script is deliberately
 * the only place that can write, and it remains dry-run-only without both an
 * explicit --apply flag and a caller-supplied repair ID.
 */

"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { EJSON } = require("bson");

const {
	validateOtaSourceClientPricing,
	validateOtaStayDateCoverage,
	validatePersistedOtaRooms,
} = require("./otaReviewPricingInvariants");

const OPERATION = "trip_hotelrunner_source_pricing_repair_20260805";
const EXCLUDED_PMS_CONFIRMATION = "7043857218";
const EXPECTED_HOTEL_ID = "6a40b6a1a6efe70450536038";
const MANIFEST_COLLECTION = "ota_trip_source_repair_manifests";
const BACKUP_COLLECTION_PREFIX = "ota_trip_source_repair_backup_";
const REPAIR_SOURCE = "trip-hotelrunner-targeted-repair-20260805";
const REPAIR_ACTION = "trip-source-pricing-payment-vcc-correction";
const PAYMENT_INSTRUCTIONS = "Net rate | Prepaid | monthly settlement";
const PAYMENT_COMMENT = "Trip.com collected by platform";
const SOURCE_CLIENT_TOTAL_SOURCE = "trip_direct_email_final_room_rate";

const asUtcDate = (value) => new Date(`${value}T00:00:00.000Z`);

const TARGETS = Object.freeze([
	Object.freeze({
		mongoId: "6a727710c0900e055a1b83ba",
		pmsConfirmation: "8234871006",
		otaConfirmation: "1651516732730092",
		otaIdentityKey: "hotelrunner:1651516732730092",
		crossTransportIdentityKey: "trip:1651516732730092",
		falseCardLast4: "0092",
		createdAt: "2026-08-04T23:34:40.834Z",
		updatedAt: "2026-08-04T23:34:40.834Z",
		exchange: Object.freeze({
			rateToSar: 3.75,
			rateSource: "fallback_default",
			adminAmountConvertedAt: "2026-08-04T23:34:37.849Z",
			paymentAmountConvertedAt: "2026-08-04T23:33:51.157Z",
			supplierRateSource: "exchange_rate_api_cached",
		}),
		checkinDate: "2026-08-26",
		checkoutDate: "2026-09-01",
		bookedAt: "2026-08-05",
		nights: 6,
		roomType: "doubleRooms",
		roomConfigId: "6a40df5f1a6d1850eb25c183",
		old: Object.freeze({
			clientSar: 346.72,
			netSar: 277.38,
			expenseSar: 69.34,
			marginSar: -172.62,
			sourceUsd: 92.46,
			chosenPrice: 57.79,
		}),
		corrected: Object.freeze({
			clientUsd: 97.9,
			payoutUsd: 92.46,
			clientSar: 367.13,
			payoutSar: 346.72,
			expenseSar: 20.41,
			rootSar: 450,
			marginSar: -103.28,
			commissionSar: 90,
			chosenPrice: 61.19,
		}),
		daily: Object.freeze([
			Object.freeze({ date: "2026-08-26", client: 60.23, net: 56.89, expense: 3.34, margin: -18.11 }),
			Object.freeze({ date: "2026-08-27", client: 60.23, net: 56.89, expense: 3.34, margin: -18.11 }),
			Object.freeze({ date: "2026-08-28", client: 60.23, net: 56.89, expense: 3.34, margin: -18.11 }),
			Object.freeze({ date: "2026-08-29", client: 60.22, net: 56.89, expense: 3.33, margin: -18.11 }),
			Object.freeze({ date: "2026-08-30", client: 63.11, net: 59.58, expense: 3.53, margin: -15.42 }),
			Object.freeze({ date: "2026-08-31", client: 63.11, net: 59.58, expense: 3.53, margin: -15.42 }),
		]),
		audits: Object.freeze([
			Object.freeze({
				id: "6a7276d1c0900e055a1b8392",
				role: "direct_trip_commercial_evidence",
				provider: "trip",
				textHash: "1a1701dbd02e2587efb1b5554e3bf1cfe6353805ae044a8a0198dd66f9ba8abc",
				emailHash: "690ecc7e40ecd79d2576066bbbbfdb1bea747cb171418974c38b32a9a8869a76",
				receivedAt: "2026-08-04T23:33:37.627Z",
				processedAt: "2026-08-04T23:33:52.270Z",
				authority: 3,
			}),
			Object.freeze({
				id: "6a7276dfc0900e055a1b83ac",
				role: "hotelrunner_creating_relay",
				provider: "hotelrunner",
				textHash: "4e4f666bf81d4858cd2c1a17fc5d57e5986d4d4cb13fc61fc55ae6c2f292dc98",
				emailHash: "bf1244ea4f9b2d8641d6de4400d419c2662f77ab0c72bd067e72bfe357637bcc",
				receivedAt: "2026-08-04T23:33:51.024Z",
				processedAt: "2026-08-04T23:34:40.842Z",
				authority: 1,
			}),
			Object.freeze({
				id: "6a72771bc0900e055a1b83ce",
				role: "duplicate_relay_no_mutation_authority",
				provider: "hotelrunner",
				textHash: "4e4f666bf81d4858cd2c1a17fc5d57e5986d4d4cb13fc61fc55ae6c2f292dc98",
				emailHash: "bf1244ea4f9b2d8641d6de4400d419c2662f77ab0c72bd067e72bfe357637bcc",
				receivedAt: "2026-08-04T23:34:51.019Z",
				processedAt: "2026-08-04T23:34:51.030Z",
				authority: 0,
			}),
		]),
	}),
	Object.freeze({
		mongoId: "6a7289cbc0900e055a1b8b9e",
		pmsConfirmation: "9764914393",
		otaConfirmation: "1167731616604825",
		otaIdentityKey: "hotelrunner:1167731616604825",
		crossTransportIdentityKey: "trip:1167731616604825",
		falseCardLast4: "4825",
		createdAt: "2026-08-05T00:54:35.686Z",
		updatedAt: "2026-08-05T00:54:35.686Z",
		exchange: Object.freeze({
			rateToSar: 3.75,
			rateSource: "fallback_default",
			adminAmountConvertedAt: "2026-08-05T00:54:32.503Z",
			paymentAmountConvertedAt: "2026-08-05T00:53:46.192Z",
			supplierRateSource: "exchange_rate_api_cached",
		}),
		checkinDate: "2026-08-05",
		checkoutDate: "2026-08-06",
		bookedAt: "2026-08-05",
		nights: 1,
		roomType: "doubleRooms",
		roomConfigId: "6a40df5f1a6d1850eb25c183",
		old: Object.freeze({
			clientSar: 56.89,
			netSar: 45.51,
			expenseSar: 11.38,
			marginSar: -29.49,
			sourceUsd: 15.17,
			chosenPrice: 56.89,
		}),
		corrected: Object.freeze({
			clientUsd: 16.06,
			payoutUsd: 15.17,
			clientSar: 60.22,
			payoutSar: 56.89,
			expenseSar: 3.33,
			rootSar: 75,
			marginSar: -18.11,
			commissionSar: 15,
			chosenPrice: 60.22,
		}),
		daily: Object.freeze([
			Object.freeze({ date: "2026-08-05", client: 60.22, net: 56.89, expense: 3.33, margin: -18.11 }),
		]),
		audits: Object.freeze([
			Object.freeze({
				id: "6a728870c0900e055a1b8b04",
				role: "direct_trip_commercial_evidence",
				provider: "trip",
				textHash: "bea07af3df16add65e9c90d5f4b33b700763a592dc3597229b7edddfb1f87889",
				emailHash: "75f4a822d73459f7337638b071f1861795cc3b9abc7b97f836e3def34e134f2f",
				receivedAt: "2026-08-05T00:48:48.439Z",
				processedAt: "2026-08-05T00:49:16.655Z",
				authority: 3,
			}),
			Object.freeze({
				id: "6a72899ac0900e055a1b8b93",
				role: "hotelrunner_creating_relay",
				provider: "hotelrunner",
				textHash: "418bbecb16f48984b3ac1afa8920e6171f1d073c67182432ddccd5b6a9e6916e",
				emailHash: "299d64c13845f1425eb4bded13e2ae6f5613ca6d00be9df443d85978b16a5864",
				receivedAt: "2026-08-05T00:53:46.041Z",
				processedAt: "2026-08-05T00:54:35.694Z",
				authority: 1,
			}),
			Object.freeze({
				id: "6a7289d6c0900e055a1b8bb2",
				role: "duplicate_relay_no_mutation_authority",
				provider: "hotelrunner",
				textHash: "418bbecb16f48984b3ac1afa8920e6171f1d073c67182432ddccd5b6a9e6916e",
				emailHash: "299d64c13845f1425eb4bded13e2ae6f5613ca6d00be9df443d85978b16a5864",
				receivedAt: "2026-08-05T00:54:46.103Z",
				processedAt: "2026-08-05T00:54:46.113Z",
				authority: 0,
			}),
		]),
	}),
]);

const TARGET_BY_MONGO_ID = new Map(TARGETS.map((target) => [target.mongoId, target]));
const TARGET_BY_PMS = new Map(TARGETS.map((target) => [target.pmsConfirmation, target]));
const ALL_AUDIT_IDS = Object.freeze(TARGETS.flatMap((target) => target.audits.map((audit) => audit.id)));

const id = (value) => String(value?._id || value || "");
const round2 = (value) => Number(Number(value || 0).toFixed(2));
const cents = (value) => Math.round(Number(value || 0) * 100);
const dateIso = (value) => {
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? "" : date.toISOString();
};
const dateKey = (value) => dateIso(value).slice(0, 10);

const serializedBson = (value) => EJSON.serialize(value, { relaxed: false });

const sortCanonical = (value) => {
	if (Array.isArray(value)) return value.map(sortCanonical);
	if (!value || typeof value !== "object") return value;
	return Object.keys(value)
		.sort()
		.reduce((result, key) => {
			result[key] = sortCanonical(value[key]);
			return result;
		}, {});
};

const canonicalEjson = (value) => JSON.stringify(sortCanonical(serializedBson(value)));
const canonicalEjsonSha256 = (value) =>
	crypto.createHash("sha256").update(canonicalEjson(value)).digest("hex");
const canonicalEqual = (left, right) => canonicalEjson(left) === canonicalEjson(right);
// Canonical hashing uses strict Extended JSON, while operational clones should
// retain normal JavaScript numbers (not BSON Int32/Double wrapper instances).
const cloneBson = (value) => EJSON.deserialize(serializedBson(value), { relaxed: true });

const own = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key);

const getPath = (object, path) =>
	String(path)
		.split(".")
		.reduce((current, key) => (current == null ? undefined : current[key]), object);

const setPath = (object, path, value) => {
	const keys = String(path).split(".");
	let current = object;
	for (let index = 0; index < keys.length - 1; index += 1) {
		const key = keys[index];
		if (!current[key] || typeof current[key] !== "object" || Array.isArray(current[key])) {
			current[key] = {};
		}
		current = current[key];
	}
	current[keys[keys.length - 1]] = cloneBson(value);
};

const unsetPath = (object, path) => {
	const keys = String(path).split(".");
	let current = object;
	for (let index = 0; index < keys.length - 1; index += 1) {
		current = current?.[keys[index]];
		if (!current || typeof current !== "object") return;
	}
	delete current[keys[keys.length - 1]];
};

const applyUpdateToDocument = (original, update) => {
	const document = cloneBson(original);
	for (const [path, value] of Object.entries(update.$set || {})) setPath(document, path, value);
	for (const path of Object.keys(update.$unset || {})) unsetPath(document, path);
	for (const [path, value] of Object.entries(update.$inc || {})) {
		setPath(document, path, Number(getPath(document, path) || 0) + Number(value));
	}
	for (const [path, value] of Object.entries(update.$push || {})) {
		const current = getPath(document, path);
		assert.ok(Array.isArray(current), `${path} must be an array before $push.`);
		current.push(cloneBson(value));
	}
	return document;
};

const assertEqual = (actual, expected, label) => {
	assert.equal(actual, expected, `${label}: expected ${expected}, received ${actual}`);
};

const assertMoney = (actual, expected, label) => {
	assert.equal(cents(actual), cents(expected), `${label}: expected ${expected}, received ${actual}`);
};

const assertDate = (actual, expected, label) => {
	assert.equal(dateIso(actual), expected, `${label}: expected ${expected}, received ${dateIso(actual)}`);
};

const assertDateKey = (actual, expected, label) => {
	assert.equal(dateKey(actual), expected, `${label}: expected ${expected}, received ${dateKey(actual)}`);
};

const assertNoClientOverride = (adminPricing = {}) => {
	const found = Object.keys(adminPricing || {}).filter((key) => key.startsWith("clientTotalOverride"));
	assert.deepEqual(found, [], `Client-total override fields are not allowed in this source-fact repair: ${found.join(", ")}`);
};

const paymentBreakdownCents = (breakdown = {}) =>
	Object.entries(breakdown || {}).reduce((total, [key, value]) => {
		if (key === "payment_comments") return total;
		return total + cents(value);
	}, 0);

const assertZeroPaymentBreakdown = (breakdown = {}) => {
	for (const [key, value] of Object.entries(breakdown || {})) {
		if (key === "payment_comments") continue;
		assert.ok(Number.isFinite(Number(value)), `${key} must be a finite payment amount.`);
		assert.equal(
			cents(value),
			0,
			`${key} must be exactly zero before this OTA-collect correction.`,
		);
	}
	return true;
};

const hasMeaningfulPaymentValue = (value) => {
	if (value == null) return false;
	if (value instanceof Date) return !Number.isNaN(value.getTime());
	if (Array.isArray(value)) {
		return value.some((entry) => hasMeaningfulPaymentValue(entry));
	}
	if (typeof value === "object") {
		return Object.values(value).some((entry) =>
			hasMeaningfulPaymentValue(entry),
		);
	}
	if (typeof value === "boolean") return value;
	if (typeof value === "number") return !Number.isFinite(value) || value !== 0;
	return String(value).trim() !== "";
};

const hasCaptureEvidence = (reservation = {}) => {
	const payment = reservation.payment_details || {};
	const vcc = reservation.vcc_payment || {};
	const bofa = reservation.bofa_payment || {};
	const bofaVcc = bofa.vcc || {};
	const secure = bofa.secure_acceptance || {};
	const paypal = reservation.paypal_details || {};
	const braintree = reservation.braintree_payment || {};
	const paymentRemainder = cloneBson(payment);
	delete paymentRemainder.captured;
	delete paymentRemainder.onsite_paid_amount;
	const secureRemainder = cloneBson(secure);
	const secureStatus = String(secureRemainder.status || "")
		.trim()
		.toLowerCase();
	const secureCurrency = String(secureRemainder.currency || "")
		.trim()
		.toUpperCase();
	const secureTransactionType = String(
		secureRemainder.transaction_type || "",
	)
		.trim()
		.toLowerCase();
	delete secureRemainder.status;
	delete secureRemainder.currency;
	delete secureRemainder.transaction_type;
	return (
		payment.captured === true ||
		Number(payment.onsite_paid_amount || 0) !== 0 ||
		hasMeaningfulPaymentValue(paymentRemainder) ||
		vcc.charged === true ||
		vcc.processing === true ||
		Number(vcc.charge_count || 0) !== 0 ||
		Number(vcc.attempts_count || 0) !== 0 ||
		Number(vcc.total_captured_usd || 0) !== 0 ||
		Boolean(vcc.last_transaction_id) ||
		hasMeaningfulPaymentValue(vcc.last_capture) ||
		hasMeaningfulPaymentValue(braintree) ||
		bofaVcc.charged === true ||
		bofaVcc.processing === true ||
		Number(bofaVcc.charge_count || 0) !== 0 ||
		Number(bofaVcc.attempts_count || 0) !== 0 ||
		Number(bofaVcc.failed_attempts_count || 0) !== 0 ||
		Number(bofaVcc.total_captured_usd || 0) !== 0 ||
		Number(bofaVcc.total_captured_sar || 0) !== 0 ||
		Boolean(bofaVcc.last_transaction_id) ||
		hasMeaningfulPaymentValue(bofaVcc.last_capture) ||
		hasMeaningfulPaymentValue(bofaVcc) ||
		!["", "not_started"].includes(secureStatus) ||
		!["", "USD"].includes(secureCurrency) ||
		!["", "sale"].includes(secureTransactionType) ||
		hasMeaningfulPaymentValue(secureRemainder) ||
		hasMeaningfulPaymentValue(paypal)
	);
};

const assertExpectedRoomIdentity = (room, target, label) => {
	assert.ok(room && typeof room === "object", `${label} room is missing.`);
	assertEqual(room.room_type, target.roomType, `${label}.room_type`);
	assertEqual(id(room.hotelRoomConfigId), target.roomConfigId, `${label}.hotelRoomConfigId`);
	assertEqual(Number(room.count), 1, `${label}.count`);
	assertMoney(room.hotelShouldGet, target.corrected.rootSar, `${label}.hotelShouldGet`);
	assert.ok(String(room.sourceRoomName || "").trim(), `${label}.sourceRoomName is required.`);
};

const validateCurrentReservation = (reservation, target) => {
	assert.ok(reservation && typeof reservation === "object", `Missing reservation ${target.mongoId}.`);
	assertEqual(id(reservation), target.mongoId, "reservation._id");
	assert.notEqual(String(reservation.confirmation_number || ""), EXCLUDED_PMS_CONFIRMATION, "Excluded forensic reservation entered repair scope.");
	assertEqual(String(reservation.confirmation_number || ""), target.pmsConfirmation, "confirmation_number");
	assertEqual(String(reservation.reservation_id || ""), target.otaConfirmation, "reservation_id");
	assertEqual(String(reservation.otaIdentityKey || ""), target.otaIdentityKey, "otaIdentityKey");
	assertEqual(
		String(reservation.otaCrossTransportIdentityKey || ""),
		"",
		"otaCrossTransportIdentityKey must be empty before the targeted bridge backfill",
	);
	assertEqual(id(reservation.hotelId), EXPECTED_HOTEL_ID, "hotelId");
	assertEqual(String(reservation.customer_details?.confirmation_number2 || ""), target.otaConfirmation, "customer_details.confirmation_number2");
	assertEqual(String(reservation.supplierData?.suppliedBookingNo || ""), target.otaConfirmation, "supplierData.suppliedBookingNo");
	assertEqual(String(reservation.supplierData?.otaConfirmationNumber || ""), target.otaConfirmation, "supplierData.otaConfirmationNumber");
	assertEqual(String(reservation.supplierData?.platformConfirmationNumber || ""), target.otaConfirmation, "supplierData.platformConfirmationNumber");
	assertEqual(String(reservation.supplierData?.pmsConfirmationNumber || ""), target.pmsConfirmation, "supplierData.pmsConfirmationNumber");
	assertEqual(String(reservation.otaPlatformReview?.confirmationNumber || ""), target.otaConfirmation, "otaPlatformReview.confirmationNumber");

	assertEqual(Number(reservation.__v), 0, "__v");
	assertDate(reservation.createdAt, target.createdAt, "createdAt");
	assertDate(reservation.updatedAt, target.updatedAt, "updatedAt");
	assert.equal(reservation.adminLastUpdatedAt, null, "adminLastUpdatedAt must still be null.");
	assertEqual(String(reservation.otaPlatformReview?.status || ""), "pending", "otaPlatformReview.status");

	assertEqual(String(reservation.booking_source || ""), "hotelrunner", "booking_source");
	assertEqual(String(reservation.customer_details?.booking_source || ""), "HotelRunner", "customer_details.booking_source");
	assertEqual(String(reservation.supplierData?.supplierName || ""), "HotelRunner", "supplierData.supplierName");
	assertEqual(String(reservation.adminPricing?.provider || ""), "hotelrunner", "adminPricing.provider");
	assertEqual(String(reservation.adminPricing?.providerLabel || ""), "HotelRunner", "adminPricing.providerLabel");
	assertEqual(String(reservation.supplierData?.otaProvider || ""), "hotelrunner", "supplierData.otaProvider");
	assertEqual(Number(reservation.supplierData?.otaSourceAuthority), 1, "supplierData.otaSourceAuthority");
	assertEqual(String(reservation.otaPlatformReview?.provider || ""), "hotelrunner", "otaPlatformReview.provider");
	assertEqual(String(reservation.otaPlatformReview?.providerLabel || ""), "HotelRunner", "otaPlatformReview.providerLabel");

	assertDateKey(reservation.checkin_date, target.checkinDate, "checkin_date");
	assertDateKey(reservation.checkout_date, target.checkoutDate, "checkout_date");
	assertDateKey(reservation.booked_at, target.bookedAt, "booked_at");
	assertEqual(Number(reservation.days_of_residence), target.nights, "days_of_residence");
	assertEqual(Number(reservation.total_rooms), 1, "total_rooms");
	assertEqual(String(reservation.currency || "").toLowerCase(), "sar", "currency");
	assertMoney(reservation.total_amount, target.old.clientSar, "total_amount");
	assertMoney(reservation.sub_total, target.corrected.rootSar, "sub_total");
	assertMoney(reservation.commission, target.corrected.commissionSar, "commission");

	assert.ok(canonicalEqual(reservation.pickedRoomsType, reservation.pickedRoomsPricing), "pickedRoomsType and pickedRoomsPricing must be identical before repair.");
	for (const [field, rooms] of [
		["pickedRoomsType", reservation.pickedRoomsType],
		["pickedRoomsPricing", reservation.pickedRoomsPricing],
	]) {
		assert.ok(Array.isArray(rooms) && rooms.length === 1, `${field} must contain exactly one room.`);
		const room = rooms[0];
		assertExpectedRoomIdentity(room, target, `${field}[0]`);
		assertMoney(room.chosenPrice, target.old.chosenPrice, `${field}[0].chosenPrice`);
		assertMoney(room.totalPriceWithCommission, target.old.clientSar, `${field}[0].totalPriceWithCommission`);
		assert.ok(Array.isArray(room.pricingByDay) && room.pricingByDay.length === target.nights, `${field}[0].pricingByDay must contain ${target.nights} rows.`);
		assert.deepEqual(room.pricingByDay.map((day) => String(day.date)), target.daily.map((day) => day.date), `${field}[0] nightly dates changed.`);
		for (const day of room.pricingByDay) {
			assertMoney(day.rootPrice, 75, `${field} ${day.date} rootPrice`);
			assertMoney(day.totalPriceWithoutCommission, 75, `${field} ${day.date} totalPriceWithoutCommission`);
			assertMoney(day.commissionRate, 20, `${field} ${day.date} commissionRate`);
			assert.equal(
				own(day, "otaExpenseRate"),
				false,
				`${field} ${day.date} has a stale OTA-expense rate that requires manual review.`,
			);
			assert.equal(
				own(day, "platformMarginRate"),
				false,
				`${field} ${day.date} has a stale platform-margin rate that requires manual review.`,
			);
		}
	}

	const pricing = reservation.adminPricing || {};
	assertEqual(String(pricing.mode || ""), "ota_platform_sync", "adminPricing.mode");
	assertMoney(pricing.clientTotal, target.old.clientSar, "adminPricing.clientTotal");
	assertMoney(pricing.rootTotal, target.corrected.rootSar, "adminPricing.rootTotal");
	assertMoney(pricing.netAfterExpensesTotal, target.old.netSar, "adminPricing.netAfterExpensesTotal");
	assertMoney(pricing.otaExpenseTotal, target.old.expenseSar, "adminPricing.otaExpenseTotal");
	assertMoney(pricing.platformMarginTotal, target.old.marginSar, "adminPricing.platformMarginTotal");
	assertMoney(pricing.commissionAmount, target.corrected.commissionSar, "adminPricing.commissionAmount");
	assertEqual(String(pricing.source || ""), "ota_email_create", "adminPricing.source");
	assertMoney(pricing.defaultDeductionRate, 0.2, "adminPricing.defaultDeductionRate");
	assert.equal(pricing.defaultDeductionApplied, true, "adminPricing.defaultDeductionApplied must expose the historical double deduction.");
	assertEqual(String(pricing.sourceCurrency || ""), "USD", "adminPricing.sourceCurrency");
	assertMoney(pricing.sourceAmount, target.old.sourceUsd, "adminPricing.sourceAmount");
	assertMoney(
		pricing.sourceExchangeRateToSar,
		target.exchange.rateToSar,
		"adminPricing.sourceExchangeRateToSar",
	);
	assertEqual(
		String(pricing.sourceExchangeRateSource || ""),
		target.exchange.rateSource,
		"adminPricing.sourceExchangeRateSource",
	);
	assertMoney(
		pricing.exchangeRateToSar,
		target.exchange.rateToSar,
		"adminPricing.exchangeRateToSar",
	);
	assertEqual(
		String(pricing.exchangeRateSource || ""),
		target.exchange.rateSource,
		"adminPricing.exchangeRateSource",
	);
	assertDate(
		pricing.amountConvertedAt,
		target.exchange.adminAmountConvertedAt,
		"adminPricing.amountConvertedAt",
	);
	assertNoClientOverride(pricing);
	assert.equal(
		own(reservation, "ota_financial_summary"),
		false,
		"ota_financial_summary must be absent before this targeted backfill.",
	);

	const supplier = reservation.supplierData || {};
	assertMoney(supplier.otaAmount, target.old.sourceUsd, "supplierData.otaAmount");
	assertMoney(supplier.otaAmountSar, target.old.clientSar, "supplierData.otaAmountSar");
	assertMoney(supplier.otaSourceAmount, target.old.sourceUsd, "supplierData.otaSourceAmount");
	assertEqual(String(supplier.otaSourceCurrency || ""), "USD", "supplierData.otaSourceCurrency");
	assertMoney(supplier.otaTotalPayoutSar, target.old.netSar, "supplierData.otaTotalPayoutSar");
	assertMoney(supplier.otaExpenseTotalSar, target.old.expenseSar, "supplierData.otaExpenseTotalSar");
	assertMoney(supplier.otaPlatformMarginSar, target.old.marginSar, "supplierData.otaPlatformMarginSar");
	assertMoney(supplier.otaPaymentSummary?.sourceTotalGuestPaymentAmount, target.old.sourceUsd, "supplierData.otaPaymentSummary.sourceTotalGuestPaymentAmount");
	assertMoney(supplier.otaPaymentSummary?.sourceTotalPayoutAmount, 0, "supplierData.otaPaymentSummary.sourceTotalPayoutAmount");
	assertMoney(supplier.otaPaymentSummary?.totalGuestPaymentAmount, target.old.clientSar, "supplierData.otaPaymentSummary.totalGuestPaymentAmount");
	assertMoney(supplier.otaPaymentSummary?.totalPayoutAmount, 0, "supplierData.otaPaymentSummary.totalPayoutAmount");
	assert.deepEqual(
		Object.keys(supplier.otaPaymentSummary || {}).sort(),
		[
			"amountConvertedAt",
			"currency",
			"exchangeRateSource",
			"exchangeRateToSar",
			"sourceCurrency",
			"sourceTotalGuestPaymentAmount",
			"sourceTotalPayoutAmount",
			"totalGuestPaymentAmount",
			"totalPayoutAmount",
		].sort(),
		"Unexpected supplier payment-summary fields require manual review.",
	);
	assertMoney(
		supplier.otaPaymentSummary?.exchangeRateToSar,
		target.exchange.rateToSar,
		"supplierData.otaPaymentSummary.exchangeRateToSar",
	);
	assertEqual(
		String(supplier.otaPaymentSummary?.exchangeRateSource || ""),
		target.exchange.rateSource,
		"supplierData.otaPaymentSummary.exchangeRateSource",
	);
	assertDate(
		supplier.otaPaymentSummary?.amountConvertedAt,
		target.exchange.paymentAmountConvertedAt,
		"supplierData.otaPaymentSummary.amountConvertedAt",
	);
	assertMoney(
		supplier.otaSourceExchangeRateToSar,
		target.exchange.rateToSar,
		"supplierData.otaSourceExchangeRateToSar",
	);
	assertEqual(
		String(supplier.otaSourceExchangeRateSource || ""),
		target.exchange.rateSource,
		"supplierData.otaSourceExchangeRateSource",
	);
	assertMoney(
		supplier.otaExchangeRateToSar,
		target.exchange.rateToSar,
		"supplierData.otaExchangeRateToSar",
	);
	assertEqual(
		String(supplier.otaExchangeRateSource || ""),
		target.exchange.supplierRateSource,
		"supplierData.otaExchangeRateSource",
	);
	assertDate(
		supplier.otaAmountConvertedAt,
		target.exchange.adminAmountConvertedAt,
		"supplierData.otaAmountConvertedAt",
	);
	assertEqual(String(supplier.otaPaymentCollectionModel || ""), "virtual_card", "supplierData.otaPaymentCollectionModel");
	assertEqual(String(supplier.otaPaymentInstructions || ""), "virtual_card", "supplierData.otaPaymentInstructions");

	assertEqual(String(reservation.payment || ""), "credit/ debit", "payment");
	assertEqual(String(reservation.financeStatus || ""), "not paid", "financeStatus");
	assertMoney(reservation.paid_amount, 0, "paid_amount");
	assertZeroPaymentBreakdown(reservation.paid_amount_breakdown);
	assert.equal(reservation.payment_details?.captured, false, "payment_details.captured must be false.");
	assertEqual(String(reservation.vcc_payment?.source || ""), "hotelrunner", "vcc_payment.source");
	assertEqual(String(reservation.vcc_payment?.metadata?.card_last4 || ""), target.falseCardLast4, "vcc_payment.metadata.card_last4");
	assert.deepEqual(Object.keys(reservation.vcc_payment || {}).sort(), ["metadata", "source"], "Unexpected VCC state requires manual review.");
	assert.deepEqual(Object.keys(reservation.vcc_payment?.metadata || {}).sort(), ["card_last4"], "Unexpected VCC metadata requires manual review.");
	assert.equal(hasCaptureEvidence(reservation), false, "Capture/attempt evidence exists; automated repair is forbidden.");
	assertEqual(String(reservation.financial_cycle?.collectionModel || ""), "pending", "financial_cycle.collectionModel");
	assertEqual(String(reservation.financial_cycle?.status || ""), "open", "financial_cycle.status");
	assertMoney(reservation.financial_cycle?.commissionValue, target.corrected.commissionSar, "financial_cycle.commissionValue");
	assertMoney(reservation.financial_cycle?.commissionAmount, target.corrected.commissionSar, "financial_cycle.commissionAmount");
	assert.equal(reservation.financial_cycle?.commissionAssigned, false, "financial_cycle.commissionAssigned must be false.");
	assertMoney(reservation.financial_cycle?.pmsCollectedAmount, 0, "financial_cycle.pmsCollectedAmount");
	assertMoney(reservation.financial_cycle?.hotelCollectedAmount, 0, "financial_cycle.hotelCollectedAmount");
	assertMoney(reservation.financial_cycle?.hotelPayoutDue, 0, "financial_cycle.hotelPayoutDue");
	assertMoney(reservation.financial_cycle?.commissionDueToPms, 0, "financial_cycle.commissionDueToPms");
	assert.equal(
		reservation.moneyTransferredToHotel,
		false,
		"moneyTransferredToHotel must be false before rewriting settlement state.",
	);
	assert.equal(
		reservation.commissionPaid,
		false,
		"commissionPaid must be false before rewriting settlement state.",
	);
	assert.equal(
		reservation.moneyTransferredAt ?? null,
		null,
		"moneyTransferredAt must be null/absent before repair.",
	);
	assert.equal(
		reservation.commissionPaidAt ?? null,
		null,
		"commissionPaidAt must be null/absent before repair.",
	);
	assert.equal(
		own(reservation, "commissionData"),
		false,
		"commissionData must be absent before repair.",
	);
	assert.equal(
		own(reservation, "commissionStatus"),
		false,
		"commissionStatus must be absent before repair.",
	);
	assert.deepEqual(
		reservation.adminChangeLog,
		[],
		"adminChangeLog must be empty before repair.",
	);

	return reservation;
};

const validateAuditDocument = (audit, target, expected) => {
	assert.ok(audit, `Missing inbound audit ${expected.id}.`);
	assertEqual(id(audit), expected.id, "audit._id");
	assertEqual(String(audit.provider || ""), expected.provider, `${expected.id}.provider`);
	assertEqual(String(audit.confirmationNumber || ""), target.otaConfirmation, `${expected.id}.confirmationNumber`);
	assertEqual(String(audit.textHash || ""), expected.textHash, `${expected.id}.textHash`);
	assertEqual(String(audit.emailHash || ""), expected.emailHash, `${expected.id}.emailHash`);
	assertDate(audit.receivedAt, expected.receivedAt, `${expected.id}.receivedAt`);
	assertDate(audit.processedAt, expected.processedAt, `${expected.id}.processedAt`);
	if (expected.role === "direct_trip_commercial_evidence") {
		assertEqual(String(audit.providerLabel || ""), "Trip.com", `${expected.id}.providerLabel`);
		assert.match(
			String(audit.from || "").toLowerCase(),
			/@(?:[a-z0-9-]+\.)*trip\.com(?:[>\s]|$)/,
			`${expected.id} is not from a direct Trip.com sender domain.`,
		);
		assert.equal(audit.hasReservationConnection, false, `${expected.id} direct audit must remain unlinked historical evidence.`);
		assert.ok(!audit.reservationMongoId, `${expected.id} direct audit unexpectedly links a reservation.`);
		assertEqual(String(audit.processingStatus || ""), "needs_review", `${expected.id}.processingStatus`);
		assertEqual(String(audit.automationAction || ""), "skipped", `${expected.id}.automationAction`);
		assert.ok(String(audit.subject || "").includes(target.otaConfirmation), `${expected.id} subject does not retain the full OTA confirmation.`);
	} else {
		assertEqual(String(audit.providerLabel || ""), "HotelRunner", `${expected.id}.providerLabel`);
		assert.match(
			String(audit.from || "").toLowerCase(),
			/@(?:[a-z0-9-]+\.)*hotelrunner\.com(?:[>\s]|$)/,
			`${expected.id} is not from a HotelRunner sender domain.`,
		);
		assert.equal(audit.hasReservationConnection, true, `${expected.id} relay must remain linked.`);
		assertEqual(id(audit.reservationMongoId), target.mongoId, `${expected.id}.reservationMongoId`);
		assertEqual(String(audit.pmsConfirmationNumber || ""), target.pmsConfirmation, `${expected.id}.pmsConfirmationNumber`);
	}
	if (expected.role === "hotelrunner_creating_relay") {
		assertEqual(String(audit.processingStatus || ""), "created", `${expected.id}.processingStatus`);
		assertEqual(String(audit.automationAction || ""), "created", `${expected.id}.automationAction`);
		assert.ok(!audit.duplicateOf, `${expected.id} creating relay cannot be a duplicate.`);
	}
	if (expected.role === "duplicate_relay_no_mutation_authority") {
		assertEqual(String(audit.processingStatus || ""), "duplicate_email", `${expected.id}.processingStatus`);
		assertEqual(String(audit.automationAction || ""), "skipped", `${expected.id}.automationAction`);
		assertEqual(String(audit.skipReason || ""), "duplicate_email", `${expected.id}.skipReason`);
		assertEqual(id(audit.duplicateOf), target.audits[1].id, `${expected.id}.duplicateOf`);
	}
	return audit;
};

const validateAuditSet = (audits) => {
	assert.ok(Array.isArray(audits), "Inbound audits must be an array.");
	assert.equal(audits.length, ALL_AUDIT_IDS.length, `Exactly ${ALL_AUDIT_IDS.length} inbound audits are required.`);
	const byId = new Map(audits.map((audit) => [id(audit), audit]));
	assert.equal(byId.size, ALL_AUDIT_IDS.length, "Inbound audit IDs must be unique.");
	for (const target of TARGETS) {
		for (const expected of target.audits) validateAuditDocument(byId.get(expected.id), target, expected);
	}
	return byId;
};

const correctedRoom = (room, target) => {
	const next = cloneBson(room);
	next.chosenPrice = target.corrected.chosenPrice;
	next.totalPriceWithCommission = target.corrected.clientSar;
	next.hotelShouldGet = target.corrected.rootSar;
	next.pricingByDay = target.daily.map((expected, index) => {
		const day = cloneBson(room.pricingByDay[index]);
		assertEqual(String(day.date || ""), expected.date, `pricingByDay[${index}].date`);
		return {
			...day,
			price: expected.client,
			clientPrice: expected.client,
			mainPrice: expected.client,
			totalPriceWithCommission: expected.client,
			netAfterExpenses: expected.net,
			netAfterOtaExpenses: expected.net,
			otaExpenseAmount: expected.expense,
			platformMargin: expected.margin,
		};
	});
	return next;
};

const withoutClientOverrides = (adminPricing) => {
	const next = cloneBson(adminPricing || {});
	for (const key of Object.keys(next)) {
		if (key.startsWith("clientTotalOverride")) delete next[key];
	}
	return next;
};

const correctedPaymentSummary = (reservation, target) => ({
	sourceCurrency: "USD",
	sourceTotalGuestPaymentAmount: target.corrected.clientUsd,
	sourceTotalPayoutAmount: target.corrected.payoutUsd,
	totalGuestPaymentAmount: target.corrected.clientSar,
	totalPayoutAmount: target.corrected.payoutSar,
	currency: "SAR",
	exchangeRateToSar: target.exchange.rateToSar,
	exchangeRateSource: target.exchange.rateSource,
	amountConvertedAt: cloneBson(
		reservation.supplierData.otaPaymentSummary.amountConvertedAt,
	),
});

const correctedFinancialSummary = (reservation, target) => ({
	show: true,
	source: "ota_email_create",
	provider: "hotelrunner",
	providerLabel: "Trip.com",
	currency: "SAR",
	clientTotal: target.corrected.clientSar,
	hotelVisibleAmount: target.corrected.rootSar,
	netAfterExpenses: target.corrected.payoutSar,
	netAfterOtaExpenses: target.corrected.payoutSar,
	otaExpenseTotal: target.corrected.expenseSar,
	platformProfit: target.corrected.marginSar,
	commissionAmount: target.corrected.commissionSar,
	sourceCurrency: "USD",
	sourceAmount: target.corrected.clientUsd,
	sourceExchangeRateToSar: target.exchange.rateToSar,
	sourceExchangeRateSource: target.exchange.rateSource,
	paymentSummary: correctedPaymentSummary(reservation, target),
	payoutFallbackReason: "",
});

const buildRepairAuditEntry = ({ target, repairId, repairAt, backupCollection }) => ({
	at: new Date(repairAt),
	source: REPAIR_SOURCE,
	action: REPAIR_ACTION,
	provider: "hotelrunner",
	bookingSource: "trip.com",
	reservationId: target.otaConfirmation,
	repairId,
	backupCollection,
	evidenceAuditIds: target.audits.map((audit) => audit.id),
	evidenceAuthority: {
		previousTransportAuthority: 1,
		directTripCommercialAuthority: 3,
	},
	before: {
		bookingSource: "hotelrunner",
		clientTotalSar: target.old.clientSar,
		netAfterExpensesSar: target.old.netSar,
		paymentCollectionModel: "virtual_card",
		falseCardLast4: target.falseCardLast4,
	},
		after: {
			bookingSource: "trip.com",
			otaCrossTransportIdentityKey: target.crossTransportIdentityKey,
			clientTotalSar: target.corrected.clientSar,
			netAfterExpensesSar: target.corrected.payoutSar,
			paymentCollectionModel: "ota_collect",
			paymentInstructions: PAYMENT_INSTRUCTIONS,
		vccEvidencePresent: false,
	},
		notes: [
		"Targeted correction from verified direct Trip.com commercial evidence; stored redacted email bodies were not replayed.",
		`Payment evidence: ${PAYMENT_INSTRUCTIONS}.`,
		"Canonical HotelRunner transport identity, PMS confirmation, OTA aliases, stay dates, room identity, hotel root total, and commission were preserved.",
	],
});

const buildRepairUpdate = (reservation, target, context) => {
	const repairedRooms = reservation.pickedRoomsType.map((room) => correctedRoom(room, target));
	const repairedPricingRooms = reservation.pickedRoomsPricing.map((room) => correctedRoom(room, target));
	assert.ok(canonicalEqual(repairedRooms, repairedPricingRooms), "Corrected room arrays diverged.");

	const adminPricing = {
		...withoutClientOverrides(reservation.adminPricing),
		providerLabel: "Trip.com",
		sourceAmount: target.corrected.clientUsd,
		clientTotal: target.corrected.clientSar,
		netAfterExpensesTotal: target.corrected.payoutSar,
		otaExpenseTotal: target.corrected.expenseSar,
		platformMarginTotal: target.corrected.marginSar,
		defaultDeductionApplied: false,
		sourceClientTotalSar: target.corrected.clientSar,
		sourceClientTotalSource: SOURCE_CLIENT_TOTAL_SOURCE,
		sourceClientTotalLockedAt: new Date(context.repairAt),
		payoutFallbackReason: "",
	};

	const supplierData = {
		...cloneBson(reservation.supplierData || {}),
		supplierName: "Trip.com",
		otaSourceAuthority: 3,
		otaAmount: target.corrected.clientUsd,
		otaAmountSar: target.corrected.clientSar,
		otaSourceAmount: target.corrected.clientUsd,
		otaSourceCurrency: "USD",
		otaPaymentSummary: {
			...correctedPaymentSummary(reservation, target),
		},
		otaPayoutFallbackReason: "",
		otaTotalPayoutSar: target.corrected.payoutSar,
		otaExpenseTotalSar: target.corrected.expenseSar,
		otaPlatformMarginSar: target.corrected.marginSar,
		otaPaymentCollectionModel: "ota_collect",
		otaPaymentInstructions: PAYMENT_INSTRUCTIONS,
	};

	const paidAmountBreakdown = {
		...cloneBson(reservation.paid_amount_breakdown || {}),
		paid_online_via_link: 0,
		paid_at_hotel_cash: 0,
		paid_at_hotel_card: 0,
		paid_to_hotel: 0,
		paid_online_jannatbooking: 0,
		paid_online_other_platforms: target.corrected.clientSar,
		paid_online_via_instapay: 0,
		paid_no_show: 0,
		payment_comments: PAYMENT_COMMENT,
	};

	const financialCycle = {
		...cloneBson(reservation.financial_cycle || {}),
		collectionModel: "pms_collected",
		status: "open",
		commissionType: "amount",
		commissionValue: target.corrected.commissionSar,
		commissionAmount: target.corrected.commissionSar,
		commissionAssigned: false,
		pmsCollectedAmount: target.corrected.clientSar,
		hotelCollectedAmount: 0,
		hotelPayoutDue: target.corrected.rootSar,
		commissionDueToPms: 0,
		lastUpdatedAt: new Date(context.repairAt),
	};

	return {
		$set: {
			booking_source: "trip.com",
			otaCrossTransportIdentityKey: target.crossTransportIdentityKey,
			ota_financial_summary: correctedFinancialSummary(reservation, target),
			"customer_details.booking_source": "Trip.com",
			pickedRoomsType: repairedRooms,
			pickedRoomsPricing: repairedPricingRooms,
			total_amount: target.corrected.clientSar,
			adminPricing,
			supplierData,
			"otaPlatformReview.providerLabel": "Trip.com",
			payment: "paid online",
			financeStatus: "paid online",
			paid_amount: target.corrected.clientSar,
			paid_amount_breakdown: paidAmountBreakdown,
			financial_cycle: financialCycle,
			updatedAt: new Date(context.repairAt),
		},
		$unset: {
			"vcc_payment.source": "",
			"vcc_payment.metadata.card_last4": "",
		},
		$push: {
			reservationAuditLog: buildRepairAuditEntry({ ...context, target }),
		},
		$inc: { __v: 1 },
	};
};

const immutableIdentitySnapshot = (reservation = {}) => ({
	_id: reservation._id,
	confirmation_number: reservation.confirmation_number,
	reservation_id: reservation.reservation_id,
	otaIdentityKey: reservation.otaIdentityKey,
	hotelId: reservation.hotelId,
	belongsTo: reservation.belongsTo,
	roomId: reservation.roomId,
	availabilitySnapshot: reservation.availabilitySnapshot,
	confirmation_number2: reservation.customer_details?.confirmation_number2,
	suppliedBookingNo: reservation.supplierData?.suppliedBookingNo,
	otaConfirmationNumber: reservation.supplierData?.otaConfirmationNumber,
	platformConfirmationNumber: reservation.supplierData?.platformConfirmationNumber,
	pmsConfirmationNumber: reservation.supplierData?.pmsConfirmationNumber,
	otaReviewConfirmationNumber: reservation.otaPlatformReview?.confirmationNumber,
	otaProvider: reservation.supplierData?.otaProvider,
	otaReviewProvider: reservation.otaPlatformReview?.provider,
	adminPricingProvider: reservation.adminPricing?.provider,
	checkin_date: reservation.checkin_date,
	checkout_date: reservation.checkout_date,
	booked_at: reservation.booked_at,
	days_of_residence: reservation.days_of_residence,
	total_rooms: reservation.total_rooms,
	sub_total: reservation.sub_total,
	commission: reservation.commission,
	currency: reservation.currency,
	settlementState: {
		moneyTransferredToHotel: reservation.moneyTransferredToHotel,
		commissionPaid: reservation.commissionPaid,
		moneyTransferredAtPresent: own(reservation, "moneyTransferredAt"),
		moneyTransferredAt: reservation.moneyTransferredAt,
		commissionPaidAtPresent: own(reservation, "commissionPaidAt"),
		commissionPaidAt: reservation.commissionPaidAt,
		commissionDataPresent: own(reservation, "commissionData"),
		commissionData: reservation.commissionData,
		commissionStatusPresent: own(reservation, "commissionStatus"),
		commissionStatus: reservation.commissionStatus,
		adminChangeLog: reservation.adminChangeLog,
	},
	roomIdentity: (reservation.pickedRoomsType || []).map((room) => ({
		room_type: room.room_type,
		displayName: room.displayName,
		hotelRoomConfigId: room.hotelRoomConfigId,
		sourceRoomName: room.sourceRoomName,
		otaRoomMatchType: room.otaRoomMatchType,
		otaRoomMatchScore: room.otaRoomMatchScore,
		count: room.count,
		rootByDay: (room.pricingByDay || []).map((day) => ({
			date: day.date,
			rootPrice: day.rootPrice,
			totalPriceWithoutCommission: day.totalPriceWithoutCommission,
			commissionRate: day.commissionRate,
		})),
	})),
});

const assertCorrectedDailyTotals = (rooms, target) => {
	let client = 0;
	let net = 0;
	let expense = 0;
	let margin = 0;
	for (const room of rooms) {
		for (const day of room.pricingByDay || []) {
			client += cents(day.clientPrice) * Number(room.count || 1);
			net += cents(day.netAfterOtaExpenses) * Number(room.count || 1);
			expense += cents(day.otaExpenseAmount) * Number(room.count || 1);
			margin += cents(day.platformMargin) * Number(room.count || 1);
		}
	}
	assert.equal(client, cents(target.corrected.clientSar), "Corrected nightly client total does not reconcile.");
	assert.equal(net, cents(target.corrected.payoutSar), "Corrected nightly payout total does not reconcile.");
	assert.equal(expense, cents(target.corrected.expenseSar), "Corrected nightly OTA expense does not reconcile.");
	assert.equal(margin, cents(target.corrected.marginSar), "Corrected nightly margin does not reconcile.");
};

const exchangeMetadataSnapshot = (reservation = {}) => ({
	adminPricing: {
		sourceExchangeRateToSar:
			reservation.adminPricing?.sourceExchangeRateToSar,
		sourceExchangeRateSource:
			reservation.adminPricing?.sourceExchangeRateSource,
		exchangeRateToSar: reservation.adminPricing?.exchangeRateToSar,
		exchangeRateSource: reservation.adminPricing?.exchangeRateSource,
		amountConvertedAt: reservation.adminPricing?.amountConvertedAt,
	},
	supplierData: {
		otaSourceExchangeRateToSar:
			reservation.supplierData?.otaSourceExchangeRateToSar,
		otaSourceExchangeRateSource:
			reservation.supplierData?.otaSourceExchangeRateSource,
		otaExchangeRateToSar: reservation.supplierData?.otaExchangeRateToSar,
		otaExchangeRateSource: reservation.supplierData?.otaExchangeRateSource,
		otaAmountConvertedAt: reservation.supplierData?.otaAmountConvertedAt,
		paymentSummary: {
			exchangeRateToSar:
				reservation.supplierData?.otaPaymentSummary?.exchangeRateToSar,
			exchangeRateSource:
				reservation.supplierData?.otaPaymentSummary?.exchangeRateSource,
			amountConvertedAt:
				reservation.supplierData?.otaPaymentSummary?.amountConvertedAt,
		},
	},
});

const verifyRepairedDocument = ({ before, after, target, context }) => {
	assert.ok(canonicalEqual(immutableIdentitySnapshot(before), immutableIdentitySnapshot(after)), "Immutable identity/stay/root/room facts changed during repair.");
	assert.ok(
		canonicalEqual(
			exchangeMetadataSnapshot(before),
			exchangeMetadataSnapshot(after),
		),
		"Admin/supplier exchange-rate metadata changed during repair.",
	);
	assertEqual(Number(after.__v), Number(before.__v) + 1, "repaired __v");
	assertDate(after.updatedAt, new Date(context.repairAt).toISOString(), "repaired updatedAt");
	assert.equal(after.adminLastUpdatedAt, null, "adminLastUpdatedAt must remain null.");
	assertEqual(String(after.otaPlatformReview?.status || ""), "pending", "repaired otaPlatformReview.status");
	assertEqual(String(after.booking_source || ""), "trip.com", "repaired booking_source");
	assertEqual(
		String(after.otaCrossTransportIdentityKey || ""),
		target.crossTransportIdentityKey,
		"repaired otaCrossTransportIdentityKey",
	);
	assertEqual(String(after.customer_details?.booking_source || ""), "Trip.com", "repaired customer booking source");
	assertEqual(String(after.supplierData?.supplierName || ""), "Trip.com", "repaired supplier label");
	assertEqual(String(after.adminPricing?.providerLabel || ""), "Trip.com", "repaired admin provider label");
	assertEqual(String(after.otaPlatformReview?.providerLabel || ""), "Trip.com", "repaired review provider label");
	assert.equal(
		own(before, "ota_financial_summary"),
		false,
		"Original ota_financial_summary was unexpectedly present.",
	);
	assert.ok(
		canonicalEqual(
			after.ota_financial_summary,
			correctedFinancialSummary(before, target),
		),
		"Repaired ota_financial_summary is incomplete or inconsistent.",
	);

	assert.ok(canonicalEqual(after.pickedRoomsType, after.pickedRoomsPricing), "Corrected room arrays must be identical.");
	assertCorrectedDailyTotals(after.pickedRoomsType, target);
	assertMoney(after.total_amount, target.corrected.clientSar, "repaired total_amount");
	assertMoney(after.adminPricing?.clientTotal, target.corrected.clientSar, "repaired adminPricing.clientTotal");
	assertMoney(after.adminPricing?.netAfterExpensesTotal, target.corrected.payoutSar, "repaired adminPricing.netAfterExpensesTotal");
	assertMoney(after.adminPricing?.otaExpenseTotal, target.corrected.expenseSar, "repaired adminPricing.otaExpenseTotal");
	assertMoney(after.adminPricing?.platformMarginTotal, target.corrected.marginSar, "repaired adminPricing.platformMarginTotal");
	assertMoney(after.adminPricing?.sourceAmount, target.corrected.clientUsd, "repaired adminPricing.sourceAmount");
	assert.equal(after.adminPricing?.defaultDeductionApplied, false, "Default deduction must be recorded as not applied.");
	assertMoney(after.adminPricing?.defaultDeductionRate, 0.2, "Configured fallback deduction rate must be preserved.");
	assertMoney(after.adminPricing?.sourceClientTotalSar, target.corrected.clientSar, "repaired sourceClientTotalSar");
	assertEqual(String(after.adminPricing?.sourceClientTotalSource || ""), SOURCE_CLIENT_TOTAL_SOURCE, "repaired sourceClientTotalSource");
	assertDate(after.adminPricing?.sourceClientTotalLockedAt, new Date(context.repairAt).toISOString(), "sourceClientTotalLockedAt");
	assertNoClientOverride(after.adminPricing);

	assertEqual(Number(after.supplierData?.otaSourceAuthority), 3, "repaired otaSourceAuthority");
	assertMoney(after.supplierData?.otaAmount, target.corrected.clientUsd, "repaired supplier otaAmount");
	assertMoney(after.supplierData?.otaAmountSar, target.corrected.clientSar, "repaired supplier otaAmountSar");
	assertMoney(after.supplierData?.otaSourceAmount, target.corrected.clientUsd, "repaired supplier otaSourceAmount");
	assert.ok(
		canonicalEqual(
			after.supplierData?.otaPaymentSummary,
			correctedPaymentSummary(before, target),
		),
		"Repaired supplier payment summary is incomplete or inconsistent.",
	);
	assertMoney(after.supplierData?.otaPaymentSummary?.sourceTotalPayoutAmount, target.corrected.payoutUsd, "repaired source payout USD");
	assertMoney(after.supplierData?.otaPaymentSummary?.totalPayoutAmount, target.corrected.payoutSar, "repaired payout SAR");
	assertMoney(after.supplierData?.otaTotalPayoutSar, target.corrected.payoutSar, "repaired otaTotalPayoutSar");
	assertMoney(after.supplierData?.otaExpenseTotalSar, target.corrected.expenseSar, "repaired otaExpenseTotalSar");
	assertMoney(after.supplierData?.otaPlatformMarginSar, target.corrected.marginSar, "repaired otaPlatformMarginSar");
	assertEqual(String(after.supplierData?.otaPaymentCollectionModel || ""), "ota_collect", "repaired payment model");
	assertEqual(String(after.supplierData?.otaPaymentInstructions || ""), PAYMENT_INSTRUCTIONS, "repaired payment instructions");

	assertEqual(String(after.payment || ""), "paid online", "repaired payment");
	assertEqual(String(after.financeStatus || ""), "paid online", "repaired financeStatus");
	assertMoney(after.paid_amount, target.corrected.clientSar, "repaired paid_amount");
	assertMoney(after.paid_amount_breakdown?.paid_online_other_platforms, target.corrected.clientSar, "repaired paid_online_other_platforms");
	for (const [key, value] of Object.entries(after.paid_amount_breakdown || {})) {
		if (key === "payment_comments") continue;
		assert.ok(Number.isFinite(Number(value)), `${key} must remain finite after repair.`);
		assert.equal(
			cents(value),
			key === "paid_online_other_platforms"
				? cents(target.corrected.clientSar)
				: 0,
			`Unexpected repaired payment amount in ${key}.`,
		);
	}
	assert.equal(paymentBreakdownCents(after.paid_amount_breakdown), cents(target.corrected.clientSar), "Only the OTA-collect payment bucket may contain money.");
	assertEqual(String(after.paid_amount_breakdown?.payment_comments || ""), PAYMENT_COMMENT, "repaired payment comment");
	assert.equal(after.payment_details?.captured, false, "OTA collection cannot be represented as a local processor capture.");
	assert.equal(own(after.vcc_payment || {}, "source"), false, "False VCC source was not removed.");
	assert.equal(own(after.vcc_payment?.metadata || {}, "card_last4"), false, "False VCC last4 was not removed.");
	assert.equal(hasCaptureEvidence(after), false, "Repair manufactured capture evidence.");
	assertEqual(String(after.financial_cycle?.collectionModel || ""), "pms_collected", "repaired financial collectionModel");
	assertMoney(after.financial_cycle?.pmsCollectedAmount, target.corrected.clientSar, "repaired pmsCollectedAmount");
	assertMoney(after.financial_cycle?.hotelPayoutDue, target.corrected.rootSar, "repaired hotelPayoutDue");
	assertMoney(after.financial_cycle?.hotelCollectedAmount, 0, "repaired hotelCollectedAmount");
	assertMoney(after.financial_cycle?.commissionDueToPms, 0, "repaired commissionDueToPms");

	const dateCoverage = validateOtaStayDateCoverage(after, after.pickedRoomsType);
	assert.equal(dateCoverage.ready, true, `Stay-date validation failed: ${dateCoverage.code || "unknown"}`);
	const roomValidation = validatePersistedOtaRooms(after.pickedRoomsType);
	assert.equal(roomValidation.ready, true, `Persisted-room validation failed: ${roomValidation.code || "unknown"}`);
	const sourcePricing = validateOtaSourceClientPricing(after, after.pickedRoomsType);
	assert.equal(sourcePricing.ready, true, `OTA source/client pricing validation failed: ${sourcePricing.code || "unknown"}`);

	const lastAudit = after.reservationAuditLog?.[after.reservationAuditLog.length - 1];
	assertEqual(String(lastAudit?.repairId || ""), context.repairId, "repair audit repairId");
	assertEqual(String(lastAudit?.backupCollection || ""), context.backupCollection, "repair audit backupCollection");
	assertEqual(String(lastAudit?.action || ""), REPAIR_ACTION, "repair audit action");
	assert.deepEqual(lastAudit?.evidenceAuditIds, target.audits.map((audit) => audit.id), "repair audit evidence IDs changed.");
	return true;
};

const buildExactCasFilter = (reservation) => ({
	$and: [
		cloneBson(reservation),
		{
			$expr: {
				$eq: [
					{ $size: { $objectToArray: "$$ROOT" } },
					Object.keys(reservation || {}).length,
				],
			},
		},
	],
});

const buildRepairPlan = ({ reservation, target, context }) => {
	validateCurrentReservation(reservation, target);
	assert.ok(context && typeof context === "object", "Repair context is required.");
	assert.ok(String(context.repairId || "").trim(), "Repair context requires a repairId.");
	assert.ok(String(context.backupCollection || "").trim(), "Repair context requires a backup collection.");
	assert.ok(!Number.isNaN(new Date(context.repairAt).getTime()), "Repair context requires a valid repairAt timestamp.");
	const update = buildRepairUpdate(reservation, target, context);
	const expectedDocument = applyUpdateToDocument(reservation, update);
	verifyRepairedDocument({ before: reservation, after: expectedDocument, target, context });
	return {
		target,
		originalDocument: cloneBson(reservation),
		originalHash: canonicalEjsonSha256(reservation),
		casFilter: buildExactCasFilter(reservation),
		casFilterHash: canonicalEjsonSha256(buildExactCasFilter(reservation)),
		update,
		expectedDocument,
		expectedHash: canonicalEjsonSha256(expectedDocument),
		diff: [
			{ path: "booking_source", before: "hotelrunner", after: "trip.com" },
			{
				path: "otaCrossTransportIdentityKey",
				before: "<absent>",
				after: target.crossTransportIdentityKey,
			},
			{
				path: "ota_financial_summary",
				before: "<absent>",
				after: correctedFinancialSummary(reservation, target),
			},
			{ path: "total_amount", before: target.old.clientSar, after: target.corrected.clientSar },
			{ path: "adminPricing.netAfterExpensesTotal", before: target.old.netSar, after: target.corrected.payoutSar },
			{ path: "adminPricing.otaExpenseTotal", before: target.old.expenseSar, after: target.corrected.expenseSar },
			{ path: "adminPricing.platformMarginTotal", before: target.old.marginSar, after: target.corrected.marginSar },
			{ path: "supplierData.otaPaymentCollectionModel", before: "virtual_card", after: "ota_collect" },
			{ path: "vcc_payment.metadata.card_last4", before: target.falseCardLast4, after: "<unset>" },
			{ path: "payment", before: "credit/ debit", after: "paid online" },
			{ path: "paid_amount", before: 0, after: target.corrected.clientSar },
		],
	};
};

const orderAndValidateReservations = (reservations) => {
	assert.ok(Array.isArray(reservations), "Reservations must be an array.");
	assert.equal(reservations.length, TARGETS.length, `Exactly ${TARGETS.length} reservation documents are required.`);
	const byId = new Map(reservations.map((reservation) => [id(reservation), reservation]));
	assert.equal(byId.size, TARGETS.length, "Reservation IDs must be unique.");
	assert.equal(reservations.some((reservation) => String(reservation.confirmation_number) === EXCLUDED_PMS_CONFIRMATION), false, `PMS ${EXCLUDED_PMS_CONFIRMATION} is explicitly excluded.`);
	return TARGETS.map((target) => {
		const reservation = byId.get(target.mongoId);
		validateCurrentReservation(reservation, target);
		return reservation;
	});
};

const buildRepairPlans = ({ reservations, audits, context }) => {
	const ordered = orderAndValidateReservations(reservations);
	validateAuditSet(audits);
	return TARGETS.map((target, index) => buildRepairPlan({ reservation: ordered[index], target, context }));
};

const validateRepairId = (repairId) => {
	const value = String(repairId || "").trim();
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{7,79}$/.test(value)) {
		throw new Error("--repair-id must be 8-80 characters using only letters, digits, dot, underscore, or hyphen.");
	}
	return value;
};

const buildBackupCollectionName = (repairId, createdAt = new Date()) => {
	const validated = validateRepairId(repairId);
	const stamp = new Date(createdAt).toISOString().replace(/[-:.]/g, "").replace("Z", "Z");
	const suffix = crypto.createHash("sha256").update(validated).digest("hex").slice(0, 12);
	return `${BACKUP_COLLECTION_PREFIX}${stamp}_${suffix}`;
};

const buildBackupRecords = ({ plans, audits, repairId, backupCollection, backupAt }) => {
	validateAuditSet(audits);
	assert.equal(plans.length, TARGETS.length, "Backup requires both reservation plans.");
	const records = [];
	for (const plan of plans) {
		records.push({
			repairId,
			operation: OPERATION,
			sourceCollection: "reservations",
			originalId: plan.originalDocument._id,
			originalHash: plan.originalHash,
			expectedRepairedHash: plan.expectedHash,
			originalDocument: cloneBson(plan.originalDocument),
			evidenceAuditIds: plan.target.audits.map((audit) => audit.id),
			backupCollection,
			backupAt: new Date(backupAt),
		});
	}
	for (const audit of audits) {
		const target = TARGETS.find((candidate) => candidate.audits.some((expected) => expected.id === id(audit)));
		assert.ok(target, `Audit ${id(audit)} is outside the repair scope.`);
		records.push({
			repairId,
			operation: OPERATION,
			sourceCollection: "inboundemails",
			originalId: audit._id,
			originalHash: canonicalEjsonSha256(audit),
			expectedRepairedHash: canonicalEjsonSha256(audit),
			originalDocument: cloneBson(audit),
			evidenceAuditIds: target.audits.map((expected) => expected.id),
			backupCollection,
			backupAt: new Date(backupAt),
		});
	}
	assert.equal(records.length, 8, "Backup must contain exactly two reservations and six inbound audits.");
	return records;
};

const verifyBackupRecords = ({ records, repairId, backupCollection }) => {
	assert.ok(Array.isArray(records), "Backup records must be an array.");
	assert.equal(records.length, 8, "Backup readback must contain exactly eight documents.");
	const keys = new Set();
	for (const record of records) {
		assertEqual(String(record.repairId || ""), repairId, "backup repairId");
		assertEqual(String(record.operation || ""), OPERATION, "backup operation");
		assertEqual(String(record.backupCollection || ""), backupCollection, "backup collection marker");
		assert.ok(["reservations", "inboundemails"].includes(record.sourceCollection), "Unexpected backup source collection.");
		const key = `${record.sourceCollection}:${id(record.originalId)}`;
		assert.equal(keys.has(key), false, `Duplicate backup source key ${key}.`);
		keys.add(key);
		assertEqual(
			id(record.originalDocument),
			id(record.originalId),
			`${key} embedded original _id`,
		);
		assertEqual(canonicalEjsonSha256(record.originalDocument), record.originalHash, `${key} canonical EJSON SHA-256`);
		assert.match(String(record.expectedRepairedHash || ""), /^[a-f0-9]{64}$/, `${key} expected repair hash is invalid.`);
	}
	assert.equal(records.filter((record) => record.sourceCollection === "reservations").length, 2, "Backup must contain two reservations.");
	assert.equal(records.filter((record) => record.sourceCollection === "inboundemails").length, 6, "Backup must contain six inbound audits.");
	for (const target of TARGETS) {
		assert.ok(keys.has(`reservations:${target.mongoId}`), `Backup is missing reservation ${target.mongoId}.`);
		for (const audit of target.audits) assert.ok(keys.has(`inboundemails:${audit.id}`), `Backup is missing audit ${audit.id}.`);
	}
	return true;
};

const assertAuditsUnchangedFromBackup = (audits, backupRecords) => {
	validateAuditSet(audits);
	const backupById = new Map(
		backupRecords
			.filter((record) => record.sourceCollection === "inboundemails")
			.map((record) => [id(record.originalId), record]),
	);
	for (const audit of audits) {
		const backup = backupById.get(id(audit));
		assert.ok(backup, `No backup exists for audit ${id(audit)}.`);
		assertEqual(canonicalEjsonSha256(audit), backup.originalHash, `Inbound audit ${id(audit)} changed`);
	}
	return true;
};

const parseCliArguments = (argv = []) => {
	const args = { apply: false, rollback: false, repairId: "", help: false };
	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index];
		if (token === "--apply") args.apply = true;
		else if (token === "--rollback") args.rollback = true;
		else if (token === "--help" || token === "-h") args.help = true;
		else if (token === "--repair-id") {
			if (args.repairId) throw new Error("--repair-id may be supplied only once.");
			args.repairId = validateRepairId(argv[index + 1]);
			index += 1;
		} else {
			throw new Error(`Unknown argument: ${token}`);
		}
	}
	if (args.apply && !args.repairId) throw new Error("--apply requires an explicit --repair-id.");
	if (args.rollback && !args.repairId) throw new Error("--rollback requires --repair-id, including for rollback dry runs.");
	return args;
};

const transactionSupportFromHello = (hello = {}) => {
	if (hello.logicalSessionTimeoutMinutes == null) return false;
	const maxWireVersion = Number(hello.maxWireVersion || 0);
	// Replica-set transactions arrived in MongoDB 4.0 (wire version 7), while
	// transactions through mongos require MongoDB 4.2 (wire version 8).
	if (hello.msg === "isdbgrid") return maxWireVersion >= 8;
	return Boolean(hello.setName) && maxWireVersion >= 7;
};

const buildDryRunReport = ({ plans, audits, repairId = "" }) => ({
	ok: true,
	mode: "dry-run",
	action: "repair",
	writesPerformed: false,
	repairId: repairId || null,
	scope: {
		pmsConfirmations: TARGETS.map((target) => target.pmsConfirmation),
		reservationMongoIds: TARGETS.map((target) => target.mongoId),
		inboundAuditIds: ALL_AUDIT_IDS,
		excludedPmsConfirmation: EXCLUDED_PMS_CONFIRMATION,
	},
	safety: {
		cas: "full original reservation document equality, including _id, __v, updatedAt, all identities, rooms, pricing, payment, capture state, and audit log",
		backup: "two full reservations plus six full inbound audits; canonical Extended JSON SHA-256 verified after database readback",
		emailReplay: false,
		transaction: "used when deployment hello response confirms replica-set or mongos transaction support",
	},
	sourceDocumentsRead: plans.length + audits.length,
	results: plans.map((plan) => ({
		pmsConfirmation: plan.target.pmsConfirmation,
		reservationMongoId: plan.target.mongoId,
		otaConfirmation: plan.target.otaConfirmation,
		originalHash: plan.originalHash,
		casFilterHash: plan.casFilterHash,
		expectedRepairedHash: plan.expectedHash,
		evidenceAuditIds: plan.target.audits.map((audit) => audit.id),
		diff: plan.diff,
		preserved: [
			"PMS and OTA confirmations",
			"canonical hotelrunner otaIdentityKey/provider",
			"hotel, stay dates, room identity/count",
			"hotel root total and PMS commission",
			"payment_details.captured=false and all processor histories",
			"unsettled hotel-transfer/commission flags and empty admin change journal",
			"original inbound audit documents",
		],
	})),
	nextStep: "Review every row, then run with both --apply and a unique --repair-id. No write is possible without both.",
});

module.exports = {
	ALL_AUDIT_IDS,
	BACKUP_COLLECTION_PREFIX,
	EXCLUDED_PMS_CONFIRMATION,
	EXPECTED_HOTEL_ID,
	MANIFEST_COLLECTION,
	OPERATION,
	PAYMENT_COMMENT,
	PAYMENT_INSTRUCTIONS,
	REPAIR_ACTION,
	REPAIR_SOURCE,
	SOURCE_CLIENT_TOTAL_SOURCE,
	TARGETS,
	TARGET_BY_MONGO_ID,
	TARGET_BY_PMS,
	applyUpdateToDocument,
	assertAuditsUnchangedFromBackup,
	buildBackupCollectionName,
	buildBackupRecords,
	buildDryRunReport,
	buildExactCasFilter,
	buildRepairPlan,
	buildRepairPlans,
	canonicalEjson,
	canonicalEjsonSha256,
	canonicalEqual,
	cloneBson,
	hasCaptureEvidence,
	id,
	immutableIdentitySnapshot,
	parseCliArguments,
	transactionSupportFromHello,
	validateAuditSet,
	validateCurrentReservation,
	validateRepairId,
	verifyBackupRecords,
	verifyRepairedDocument,
};
