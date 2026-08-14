/** @format */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
	assertOtaReservationIdentityMaterialization,
	isEstablishedOtaReservation,
	protectEstablishedOtaReservationIdentityUpdate,
	validateEstablishedOtaReservationIdentityCandidate,
	validateEstablishedOtaReservationIdentityUpdate,
	validateOtaReservationIdentityMaterialization,
} = require("./otaReservationIdentityUpdatePolicy");

const clone = (value) => JSON.parse(JSON.stringify(value));

const otaReservation = () => ({
	_id: "reservation-1",
	confirmation_number: "PMS-90001",
	pms_number: "PMS-90001",
	reservation_id: "AGODA-70001",
	otaIdentityKey: "agoda:agoda-70001",
	otaCrossTransportIdentityKey: "agoda:agoda-70001",
	booking_source: "Agoda",
	customer_details: {
		name: "Guest",
		booking_source: "Agoda",
		confirmation_number2: "AGODA-70001",
	},
	supplierData: {
		supplierName: "Agoda",
		suppliedBookingNo: "AGODA-70001",
		otaConfirmationNumber: "AGODA-70001",
		platformConfirmationNumber: "AGODA-70001",
		pmsConfirmationNumber: "PMS-90001",
		otaProvider: "agoda",
		otaInboundEmailId: "inbound-audit-1",
		otaAutomationPipeline: "ota-email-orchestrator",
		otaCreatedFromEmail: true,
		otaCreatedFromSync: false,
		otaNormalizedSnapshot: {
			provider: "agoda",
			confirmationNumber: "AGODA-70001",
			reservationId: "AGODA-70001",
		},
		hotelRunner: {
			reservationId: "HR-RES-70001",
			hrNumber: "HR-70001",
			providerNumber: "AGODA-70001",
			hrNumberAliases: ["HR-70001", "HR-LEGACY-70001"],
			providerNumberAliases: ["AGODA-70001", "AGODA-LEGACY-70001"],
			provider: "agoda",
			channel: "agoda",
			transport: "hotelrunner",
		},
	},
	otaPlatformReview: {
		status: "needs_review",
		source: "ota_email_create",
		inboundEmailId: "inbound-audit-1",
		provider: "agoda",
		providerLabel: "Agoda",
		confirmationNumber: "AGODA-70001",
	},
});

test("detects mapped, review, legacy-source, and HotelRunner OTA records without classifying manual PMS rows", () => {
	assert.equal(isEstablishedOtaReservation(otaReservation()), true);
	assert.equal(
		isEstablishedOtaReservation({
			confirmation_number: "PMS-1",
			booking_source: "booking.com",
			customer_details: { confirmation_number2: "BOOKING-1" },
		}),
		true
	);
	assert.equal(
		isEstablishedOtaReservation({
			confirmation_number: "PMS-2",
			reservation_id: "TRIP-2",
			supplierData: {
				otaAutomationPipeline: "ota-reservation-sync-orchestrator",
			},
		}),
		true
	);
	assert.equal(
		isEstablishedOtaReservation({
			confirmation_number: "PMS-3",
			reservation_id: "HR-3",
			supplierData: { hotelRunner: { provider: "hotelrunner" } },
		}),
		true
	);
	assert.equal(
		isEstablishedOtaReservation({
			confirmation_number: "MANUAL-1",
			reservation_id: "LOCAL-REFERENCE",
			booking_source: "jannat employee",
		}),
		false
	);
});

test("strips exact full-form identity echoes and preserves unrelated root and nested edits", () => {
	const existing = otaReservation();
	const update = {
		confirmation_number: " pms-90001 ",
		reservationId: "agoda-70001",
		otaIdentityKey: "AGODA:AGODA-70001",
		bookingSource: "AGODA",
		comment: "late arrival",
		customer_details: {
			name: "Updated Guest",
			confirmationNumber: "PMS-90001",
			confirmationNumber2: "AGODA-70001",
			booking_source: "agoda",
		},
		supplierData: {
			supplierName: "agoda",
			otaConfirmationNumber: "AGODA-70001",
			pmsConfirmationNumber: "PMS-90001",
			otaProvider: "AGODA",
			otaCreatedFromEmail: true,
			guestPreference: "quiet",
		},
		otaPlatformReview: {
			provider: "AGODA",
			confirmationNumber: "AGODA-70001",
			inboundEmailId: "inbound-audit-1",
			status: "needs_review",
		},
		"supplierData.platformConfirmationNumber": "AGODA-70001",
	};
	const result = protectEstablishedOtaReservationIdentityUpdate(update, existing);

	assert.equal(result.allowed, true);
	assert.equal(result.establishedOta, true);
	assert.equal(update.confirmation_number, undefined);
	assert.equal(update.reservationId, undefined);
	assert.equal(update.otaIdentityKey, undefined);
	assert.equal(update.bookingSource, undefined);
	assert.deepEqual(update.customer_details, { name: "Updated Guest" });
	assert.deepEqual(update.supplierData, { guestPreference: "quiet" });
	assert.deepEqual(update.otaPlatformReview, { status: "needs_review" });
	assert.equal(update["supplierData.platformConfirmationNumber"], undefined);
	assert.equal(update.comment, "late arrival");
});

test("non-mutating validation preserves a full customer replacement identity echo", () => {
	const update = {
		customer_details: {
			name: "Updated Guest",
			confirmation_number2: "AGODA-70001",
		},
	};
	const result = validateEstablishedOtaReservationIdentityUpdate(
		update,
		otaReservation()
	);
	assert.equal(result.allowed, true);
	assert.equal(
		update.customer_details.confirmation_number2,
		"AGODA-70001"
	);
});

test("fails closed on PMS, OTA alias, provider, review, identity-key, and malformed-container changes", () => {
	const cases = [
		["confirmation_number", { confirmation_number: "AGODA-70001" }],
		["reservation_id", { reservation_id: "PMS-90001" }],
		["otaIdentityKey", { otaIdentityKey: "agoda:pms-90001" }],
		["customer_details.confirmation_number2", { customer_details: { confirmation_number2: "PMS-90001" } }],
		["supplierData.confirmationNumber", { "supplierData.confirmationNumber": "PMS-90001" }],
		["supplierData.otaConfirmationNumber", { "supplierData.otaConfirmationNumber": "PMS-90001" }],
		["supplierData.otaProvider", { supplierData: { otaProvider: "trip" } }],
		["otaPlatformReview.confirmationNumber", { otaPlatformReview: { confirmationNumber: "PMS-90001" } }],
		["otaPlatformReview.provider", { "otaPlatformReview.provider": "booking" }],
		["supplierData.otaNormalizedSnapshot.confirmationNumber", { supplierData: { otaNormalizedSnapshot: { confirmationNumber: "PMS-90001" } } }],
		["supplierData.hotelRunner.hrNumberAliases", { "supplierData.hotelRunner.hrNumberAliases": ["HR-70001", "PMS-90001"] }],
		["customer_details", { customer_details: null }],
		["supplierData", { supplierData: [] }],
	];
	for (const [field, update] of cases) {
		const result = protectEstablishedOtaReservationIdentityUpdate(
			clone(update),
			otaReservation()
		);
		assert.equal(result.allowed, false, field);
		assert.equal(result.status, 409, field);
		assert.equal(result.code, "ota_reservation_identity_locked", field);
		assert.equal(result.field, field, field);
		assert.equal(JSON.stringify(result).includes("AGODA-70001"), false, field);
	}
});

test("manual non-OTA updates retain existing generic behavior", () => {
	const update = {
		confirmation_number: "MANUAL-2",
		reservation_id: "LOCAL-2",
		customer_details: { name: "Updated Guest" },
	};
	const result = protectEstablishedOtaReservationIdentityUpdate(update, {
		confirmation_number: "MANUAL-1",
		reservation_id: "LOCAL-1",
		booking_source: "jannat employee",
	});
	assert.deepEqual(result, {
		allowed: true,
		establishedOta: false,
		strippedFields: [],
	});
	assert.equal(update.confirmation_number, "MANUAL-2");
});

test("ordinary Jannat/direct booking labels are never mistaken for Booking.com", () => {
	for (const bookingSource of [
		"Jannat Booking",
		"Online Jannat Booking",
		"Direct booking",
	]) {
		assert.equal(
			isEstablishedOtaReservation({
				confirmation_number: "PMS-1",
				booking_source: bookingSource,
				customer_details: { confirmation_number2: "DIRECT-REFERENCE" },
			}),
			false,
			bookingSource
		);
	}
});

test("preexisting equal PMS/OTA identities are grandfathered for unrelated edits and exact echoes", () => {
	const existing = otaReservation();
	existing.confirmation_number = "LEGACY-SAME";
	existing.pms_number = "LEGACY-SAME";
	existing.reservation_id = "LEGACY-SAME";
	existing.customer_details.confirmation_number2 = "LEGACY-SAME";
	existing.supplierData.suppliedBookingNo = "LEGACY-SAME";
	existing.supplierData.otaConfirmationNumber = "LEGACY-SAME";
	existing.supplierData.platformConfirmationNumber = "LEGACY-SAME";
	existing.supplierData.pmsConfirmationNumber = "LEGACY-SAME";
	existing.otaPlatformReview.confirmationNumber = "LEGACY-SAME";

	const unrelated = { comment: "safe legacy edit" };
	assert.equal(
		protectEstablishedOtaReservationIdentityUpdate(unrelated, existing).allowed,
		true
	);
	const echoes = {
		confirmation_number: "LEGACY-SAME",
		reservation_id: "LEGACY-SAME",
		customer_details: { confirmation_number2: "LEGACY-SAME" },
	};
	assert.equal(
		protectEstablishedOtaReservationIdentityUpdate(echoes, existing).allowed,
		true
	);
	assert.deepEqual(echoes, {});
	assert.equal(
		validateEstablishedOtaReservationIdentityCandidate(existing, {
			...existing,
			comment: "safe legacy edit",
		}).allowed,
		true
	);
	assert.equal(
		protectEstablishedOtaReservationIdentityUpdate(
			{ reservation_id: "DIFFERENT" },
			existing
		).allowed,
		false
	);
});

test("final candidate invariant catches whole-object identity loss and newly added equalization", () => {
	const existing = otaReservation();
	const supplierReplacement = {
		...existing,
		supplierData: { guestPreference: "quiet" },
	};
	assert.deepEqual(
		validateEstablishedOtaReservationIdentityCandidate(
			existing,
			supplierReplacement
		),
		{
			allowed: false,
			status: 409,
			field: "supplierData.supplierName",
			code: "ota_reservation_identity_locked",
			error:
				"Established OTA and PMS identity fields cannot be changed through this reservation update path.",
		}
	);
	const newAlias = clone(existing);
	newAlias.customer_details.reservation_id = "PMS-90001";
	assert.equal(
		validateEstablishedOtaReservationIdentityCandidate(existing, newAlias).allowed,
		false
	);
	assert.equal(
		validateEstablishedOtaReservationIdentityCandidate(existing, newAlias).field,
		"customer_details.reservation_id"
	);
});

test("replacement-container mode protects the public editor from partial supplier replacement", () => {
	const update = { supplierData: { guestPreference: "quiet" } };
	const result = protectEstablishedOtaReservationIdentityUpdate(
		update,
		otaReservation(),
		{ replacementContainers: ["supplierData", "otaPlatformReview"] }
	);
	assert.equal(result.allowed, false);
	assert.equal(result.field, "supplierData.supplierName");
});

test("replacement-container mode rejects whole supplier deletion but strips a complete exact echo", () => {
	for (const supplierData of [null, {}]) {
		const result = protectEstablishedOtaReservationIdentityUpdate(
			{ supplierData },
			otaReservation(),
			{ replacementContainers: ["supplierData"] }
		);
		assert.equal(result.allowed, false);
		assert.equal(result.field, "supplierData");
	}
	const update = {
		supplierData: {
			supplierName: "Agoda",
			suppliedBookingNo: "AGODA-70001",
			otaConfirmationNumber: "AGODA-70001",
			platformConfirmationNumber: "AGODA-70001",
			pmsConfirmationNumber: "PMS-90001",
			otaProvider: "agoda",
			otaInboundEmailId: "inbound-audit-1",
			otaAutomationPipeline: "ota-email-orchestrator",
			otaCreatedFromEmail: true,
			otaCreatedFromSync: false,
			otaNormalizedSnapshot: {
				provider: "agoda",
				confirmationNumber: "AGODA-70001",
				reservationId: "AGODA-70001",
			},
			hotelRunner: clone(otaReservation().supplierData.hotelRunner),
		},
	};
	const result = protectEstablishedOtaReservationIdentityUpdate(
		update,
		otaReservation(),
		{ replacementContainers: ["supplierData"] }
	);
	assert.equal(result.allowed, true);
	assert.deepEqual(update, {});
});

test("alias arrays compare as normalized sets and every element participates in PMS separation", () => {
	const update = {
		"supplierData.hotelRunner.hrNumberAliases": [
			" hr-legacy-70001 ",
			"HR-70001",
		],
	};
	const protectedResult = protectEstablishedOtaReservationIdentityUpdate(
		update,
		otaReservation()
	);
	assert.equal(protectedResult.allowed, true);
	assert.deepEqual(update, {});

	const collision = validateOtaReservationIdentityMaterialization(
		otaReservation(),
		{
			"supplierData.hotelRunner.providerNumberAliases": [
				"AGODA-70001",
				"PMS-90001",
			],
		}
	);
	assert.equal(collision.allowed, false);
	assert.equal(collision.code, "ota_pms_identity_collision");
});

test("a generic edit cannot convert a manual row into OTA identity, including equal-ID conversion", () => {
	const existing = {
		confirmation_number: "PMS-1",
		booking_source: "jannat employee",
		customer_details: { name: "Guest" },
	};
	const update = {
		booking_source: "agoda",
		customer_details: { confirmation_number2: "PMS-1" },
	};
	const result = protectEstablishedOtaReservationIdentityUpdate(update, existing);
	assert.equal(result.allowed, false);
	assert.equal(result.field, "ota_identity_conversion");
	assert.equal(result.code, "ota_reservation_identity_locked");
	assert.deepEqual(update, {
		booking_source: "agoda",
		customer_details: { confirmation_number2: "PMS-1" },
	});
	assert.equal(
		validateEstablishedOtaReservationIdentityCandidate(existing, {
			...existing,
			booking_source: "agoda",
			customer_details: { confirmation_number2: "PMS-1" },
		}).allowed,
		false
	);
	assert.equal(
		protectEstablishedOtaReservationIdentityUpdate(
			{
				bookingSource: "booking.com",
				customerDetails: { confirmationNumber2: "PMS-1" },
			},
			existing
		).field,
		"ota_identity_conversion"
	);
});

test("source-authoritative materialization permits a distinct alias but blocks an alias equal to PMS", () => {
	const existing = otaReservation();
	delete existing.reservation_id;
	assert.equal(
		validateOtaReservationIdentityMaterialization(existing, {
			reservation_id: "AGODA-70001",
			"supplierData.suppliedBookingNo": "AGODA-70001",
		}).allowed,
		true
	);
	const collision = validateOtaReservationIdentityMaterialization(existing, {
		reservation_id: "PMS-90001",
		"supplierData.suppliedBookingNo": "PMS-90001",
	});
	assert.equal(collision.allowed, false);
	assert.equal(collision.code, "ota_pms_identity_collision");
	assert.equal(collision.field, "pms_ota_identity_roles");
	assert.throws(
		() =>
			assertOtaReservationIdentityMaterialization(existing, {
				reservation_id: "PMS-90001",
			}),
		(error) =>
			error.code === "ota_pms_identity_collision" &&
			error.statusCode === 409 &&
			error.field === "pms_ota_identity_roles"
	);
});

test("source materialization cannot grandfather a collision while converting a non-OTA row", () => {
	const existing = {
		confirmation_number: "PMS-1",
		booking_source: "manual",
		customer_details: { confirmation_number2: "PMS-1" },
	};
	const result = validateOtaReservationIdentityMaterialization(existing, {
		booking_source: "agoda",
	});
	assert.equal(result.allowed, false);
	assert.equal(result.code, "ota_pms_identity_collision");

	for (const materializedUpdate of [
		{
			booking_source: "agoda",
			"customer_details.otaIdentityKey": "agoda:PMS-1",
		},
		{
			booking_source: "agoda",
			"customerDetails.otaCrossTransportIdentityKey": "trip:PMS-1",
		},
		{
			booking_source: "agoda",
			"supplierData.otaIdentityKey": "agoda:PMS-1",
		},
		{
			booking_source: "agoda",
			"supplierData.otaCrossTransportIdentityKey": "trip:PMS-1",
		},
	]) {
		const nestedResult = validateOtaReservationIdentityMaterialization(
			{
				confirmation_number: "PMS-1",
				booking_source: "manual",
				customer_details: {},
			},
			materializedUpdate
		);
		assert.equal(nestedResult.allowed, false);
		assert.equal(nestedResult.code, "ota_pms_identity_collision");
	}
});

test("source-authoritative materialization also grandfathers an unchanged legacy collision", () => {
	const existing = otaReservation();
	existing.confirmation_number = "LEGACY-SAME";
	existing.reservation_id = "LEGACY-SAME";
	const result = validateOtaReservationIdentityMaterialization(existing, {
		"supplierData.otaConfirmationNumber": "LEGACY-SAME",
	});
	assert.equal(result.allowed, true);
});

test("works with a Mongoose-style document without retaining guest values in errors", () => {
	const stored = otaReservation();
	const mongooseLike = { toObject: () => clone(stored) };
	const result = protectEstablishedOtaReservationIdentityUpdate(
		{ customer_details: { confirmation_number2: "tampered-secret" } },
		mongooseLike
	);
	assert.equal(result.allowed, false);
	assert.equal(JSON.stringify(result).includes("tampered-secret"), false);
});

test("all generic/source update writers enforce identity before mutation", () => {
	const reservationsController = fs.readFileSync(
		path.join(__dirname, "../controllers/reservations.js"),
		"utf8"
	);
	const genericStart = reservationsController.indexOf(
		"exports.updateReservation = async"
	);
	const genericWriter = reservationsController.indexOf(
		"Reservations.findOneAndUpdate(",
		genericStart
	);
	const genericEarlyGuard = reservationsController.indexOf(
		"protectEstablishedOtaReservationIdentityUpdate(",
		genericStart
	);
	const genericFinalGuard = reservationsController.indexOf(
		"validateEstablishedOtaReservationIdentityUpdate(",
		genericStart
	);
	assert.ok(genericStart >= 0);
	assert.ok(genericEarlyGuard > genericStart && genericEarlyGuard < genericWriter);
	assert.ok(genericFinalGuard > genericEarlyGuard && genericFinalGuard < genericWriter);

	const publicController = fs.readFileSync(
		path.join(__dirname, "../controllers/janat.js"),
		"utf8"
	);
	const publicStart = publicController.indexOf(
		"exports.updateReservationDetails = async"
	);
	const publicPayment = publicController.indexOf(
		"processPaymentFromLink(",
		publicStart
	);
	const publicGuard = publicController.indexOf(
		"protectEstablishedOtaReservationIdentityUpdate(",
		publicStart
	);
	const publicFinalGuard = publicController.indexOf(
		"validateEstablishedOtaReservationIdentityCandidate(",
		publicStart
	);
	const publicSave = publicController.indexOf(
		"reservation.save()",
		publicStart
	);
	assert.ok(publicGuard > publicStart && publicGuard < publicPayment);
	assert.ok(publicFinalGuard > publicGuard && publicFinalGuard < publicSave);

	const mapper = fs.readFileSync(
		path.join(__dirname, "otaReservationMapper.js"),
		"utf8"
	);
	const mapperStart = mapper.indexOf(
		"async function applyExistingReservationEmailUpdate"
	);
	const mapperGuard = mapper.indexOf(
		"assertOtaReservationIdentityMaterialization(existing, set)",
		mapperStart
	);
	const mapperWriter = mapper.indexOf("Reservations.updateOne(", mapperStart);
	assert.ok(mapperGuard > mapperStart && mapperGuard < mapperWriter);
});
