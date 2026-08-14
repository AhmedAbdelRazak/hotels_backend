/** @format */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
	CANONICAL_CONFIRMATION_MODES,
	EXACT_OTA_SOURCE_LABELS,
	preparePublicDirectReservationPayload,
} = require("./publicDirectReservationIdentity");

const directPayload = (bookingSource = "Online Jannat Booking") => ({
	hotelId: "hotel-example-1",
	booking_source: bookingSource,
	customerDetails: {
		name: "Example Guest",
		email: "guest@example.test",
		phone: "+10000000000",
	},
});

const section = (source, start, end) => {
	const from = source.indexOf(start);
	assert.notEqual(from, -1, `Missing section start: ${start}`);
	const to = source.indexOf(end, from + start.length);
	assert.notEqual(to, -1, `Missing section end: ${end}`);
	return source.slice(from, to);
};

test("legitimate public direct source labels remain unchanged", () => {
	for (const source of [
		"Online Jannat Booking",
		"Online Zad Hotels",
		"AI Chat",
		"Generated Link",
	]) {
		const payload = directPayload(source);
		assert.equal(preparePublicDirectReservationPayload(payload), payload);
	}
});

test("OTA classification uses an explicit exact label set", () => {
	for (const source of [
		" Agoda ",
		"BOOKING.COM",
		"Expedia.com",
		"Airbnb",
		"Trip.com V2",
		"Hotels.com",
		"Trivago",
		"HotelRunner",
	]) {
		assert.throws(
			() => preparePublicDirectReservationPayload(directPayload(source)),
			(error) =>
				error.code === "public_direct_ota_source_forbidden" &&
				error.fields.includes("booking_source")
		);
	}
	assert.equal(EXACT_OTA_SOURCE_LABELS.includes("agoda"), true);
	assert.doesNotThrow(() =>
		preparePublicDirectReservationPayload(
			directPayload("Agoda Partner Referral")
		)
	);
});

test("public ingress rejects caller-owned PMS and OTA aliases in every accepted shape", () => {
	const fixtures = [
		["confirmation_number", { confirmation_number: "CALLER-PMS-1" }],
		["reservation_id", { reservation_id: "OTA-1" }],
		["pmsNumber", { pmsNumber: "CALLER-PMS-2" }],
		["otaIdentityKey", { otaIdentityKey: "agoda:ota-1" }],
		[
			"customerDetails.confirmation_number2",
			{ customerDetails: { confirmation_number2: "OTA-2" } },
		],
		[
			"customer_details.confirmationNumber2",
			{ customer_details: { confirmationNumber2: "OTA-3" } },
		],
		[
			"customerDetails.supplierData",
			{
				customerDetails: {
					supplierData: { suppliedBookingNo: "OTA-NESTED-3" },
				},
			},
		],
		[
			"supplierData",
			{ supplierData: { otaConfirmationNumber: "OTA-4" } },
		],
		[
			"otaPlatformReview",
			{ otaPlatformReview: { provider: "booking" } },
		],
	];

	for (const [field, injected] of fixtures) {
		const payload = {
			...directPayload(),
			...injected,
			customerDetails: {
				...directPayload().customerDetails,
				...(injected.customerDetails || {}),
			},
		};
		assert.throws(
			() => preparePublicDirectReservationPayload(payload),
			(error) =>
				error.code === "public_direct_identity_forbidden" &&
				error.fields.includes(field),
			field
		);
	}
});

test("empty legacy form fields are harmless but meaningful identity containers fail closed", () => {
	assert.doesNotThrow(() =>
		preparePublicDirectReservationPayload({
			...directPayload(),
			reservation_id: "",
			pms_number: null,
			customerDetails: {
				...directPayload().customerDetails,
				confirmation_number2: "   ",
			},
			supplierData: { otaConfirmationNumber: "" },
		})
	);
	assert.throws(
		() =>
			preparePublicDirectReservationPayload({
				...directPayload(),
				supplierData: { unexpectedAlias: "OTA-UNKNOWN-1" },
			}),
		(error) =>
			error.code === "public_direct_identity_forbidden" &&
			error.fields.includes("supplierData")
	);
});

test("PayPal completion discards the echoed confirmation and never mutates input", () => {
	const original = {
		...directPayload(),
		confirmation_number: "SERVER-PENDING-1001",
		pendingReservationId: "pending-example-1",
	};
	const prepared = preparePublicDirectReservationPayload(original, {
		canonicalConfirmation: CANONICAL_CONFIRMATION_MODES.STRIP,
	});
	assert.notEqual(prepared, original);
	assert.equal(prepared.confirmation_number, undefined);
	assert.equal(original.confirmation_number, "SERVER-PENDING-1001");
	assert.equal(prepared.pendingReservationId, "pending-example-1");
	assert.throws(
		() =>
			preparePublicDirectReservationPayload(
				{ ...original, hr_number: "OTA-HR-1" },
				{ canonicalConfirmation: CANONICAL_CONFIRMATION_MODES.STRIP }
			),
		(error) => error.code === "public_direct_identity_forbidden"
	);
});

test("only signed/server-built documents may retain the canonical confirmation", () => {
	const serverDocument = {
		...directPayload("AI Chat"),
		confirmation_number: "SERVER-PMS-1002",
	};
	assert.equal(
		preparePublicDirectReservationPayload(serverDocument, {
			canonicalConfirmation: CANONICAL_CONFIRMATION_MODES.ALLOW,
		}),
		serverDocument
	);
	assert.throws(
		() =>
			preparePublicDirectReservationPayload(
				{
					...serverDocument,
					customerDetails: {
						...serverDocument.customerDetails,
						confirmation_number: "SECOND-PMS-ALIAS",
					},
				},
				{ canonicalConfirmation: CANONICAL_CONFIRMATION_MODES.ALLOW }
			),
		(error) => error.code === "public_direct_identity_forbidden"
	);
});

test("Janat public create and signed verification enforce the boundary before side effects", () => {
	const source = fs.readFileSync(
		path.join(__dirname, "../controllers/janat.js"),
		"utf8"
	);
	const create = section(
		source,
		"exports.createNewReservationClient = async",
		"// Helper function to handle user creation or updating"
	);
	assert.ok(
		create.indexOf("preparePublicDirectReservationPayload(req.body || {})") <
			create.indexOf("HotelDetails.findOne")
	);
	const save = section(
		source,
		"async function saveReservation(",
		"// Payment processing function"
	);
	assert.ok(
		save.indexOf("preparePublicDirectReservationPayload(reservationPayload") <
			save.indexOf("new Reservations(reservationPayload)")
	);
	const verify = section(
		source,
		"exports.verifyReservationToken = async",
		"exports.getUserAndReservationData"
	);
	assert.ok(
		verify.indexOf("preparePublicDirectReservationPayload(decoded") <
			verify.indexOf("validateReservationInventoryForCreate")
	);
});

test("PayPal pending, completion, webhook persistence, and verification use server identity", () => {
	const source = fs.readFileSync(
		path.join(__dirname, "../controllers/paypal_reservation.js"),
		"utf8"
	);
	const build = section(
		source,
		"async function buildAndSaveReservation(",
		"async function reservePendingCaptureUSD"
	);
	assert.ok(
		build.indexOf("preparePublicDirectReservationPayload(reservationPayload") <
			build.indexOf("new Reservations(reservationPayload)")
	);
	const pending = section(
		source,
		"exports.preparePendingReservation = async",
		"exports.cancelPendingReservation = async"
	);
	assert.ok(
		pending.indexOf("preparePublicDirectReservationPayload(req.body || {})") <
			pending.indexOf("HotelDetails.findOne")
	);
	assert.ok(
		pending.indexOf("preparePublicDirectReservationPayload(pendingPayload") <
			pending.indexOf("new UncompleteReservations(pendingPayload)")
	);
	const create = section(
		source,
		"exports.createReservationAndProcess = async",
		"exports.mitChargeReservation = async"
	);
	assert.match(
		create,
		/canonicalConfirmation:\s*CANONICAL_CONFIRMATION_MODES\.STRIP/
	);
	assert.ok(
		create.indexOf("preparePublicDirectReservationPayload(req.body || {}") <
			create.indexOf("HotelDetails.findOne")
	);
	assert.match(
		create,
		/pendingReservation\.toObject[\s\S]+?CANONICAL_CONFIRMATION_MODES\.ALLOW/
	);
	const verify = section(
		source,
		"exports.verifyReservationAndCreate = async",
		"exports.attachVaultToReservation = async"
	);
	assert.ok(
		verify.indexOf("preparePublicDirectReservationPayload(decoded") <
			verify.indexOf("Reservations.findOne")
	);
	assert.match(source, /reqBodyFromPendingReviewReservation[\s\S]+?buildAndSaveReservation/);
});
