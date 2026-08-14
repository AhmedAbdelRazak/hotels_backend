/** @format */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
	buildLegacyOtaImportCreateDocument,
	buildLegacyOtaImportLookup,
	buildLegacyOtaImportUpdateDocument,
	createLegacyOtaImportReservation,
	findLegacyOtaImportReservation,
} = require("./legacyOtaImportIdentity");

const EXAMPLE_AGODA_ID = "AGODA-EXAMPLE-9001";
const EXAMPLE_PMS_ID = "1234506789";

test("legacy OTA lookup is constrained by hotel, source, provider, and external aliases", () => {
	const query = buildLegacyOtaImportLookup({
		provider: "Agoda",
		externalConfirmationNumber: EXAMPLE_AGODA_ID,
		hotelId: "hotel-1",
		bookingSources: ["online jannat booking"],
		legacyState: "Agoda",
	});

	assert.equal(query.hotelId, "hotel-1");
	assert.deepEqual(query.booking_source, { $in: ["online jannat booking"] });
	assert.deepEqual(query.$or[0], {
		otaIdentityKey: "agoda:agoda-example-9001",
	});
	assert.deepEqual(query.$or[1].$and[0].$or[0], {
		"supplierData.otaProvider": "agoda",
	});
	assert.deepEqual(query.$or[2].$and[0].confirmation_number, {
		$in: [
			"AGODA-EXAMPLE-9001",
			"agoda-example-9001",
		],
	});
	assert.equal(query.$or[2].$and[0].state.test("agoda"), true);
	assert.equal(query.$or[2].$and[0].state.test("expedia"), false);
	assert.deepEqual(query.$or[2].$and[1].$or, [
		{ otaIdentityKey: { $exists: false } },
		{ otaIdentityKey: "" },
		{ otaIdentityKey: null },
	]);
});

test("every explicit OTA import and OrderTaker creation path keeps the shared final invariant wired", () => {
	const integratorSource = fs.readFileSync(
		path.join(__dirname, "../controllers/integrator.js"),
		"utf8"
	);
	const reservationSource = fs.readFileSync(
		path.join(__dirname, "../controllers/reservations.js"),
		"utf8"
	);
	const orderTakerSource = fs.readFileSync(
		path.join(__dirname, "../controllers/janat.js"),
		"utf8"
	);

	for (const sourceName of [
		"integrator_agoda_import",
		"integrator_expedia_import",
	]) {
		assert.match(integratorSource, new RegExp(`createLegacyOtaImportReservation[\\s\\S]+?${sourceName}`));
	}
	for (const sourceName of [
		"agoda_import",
		"expedia_import",
		"airbnb_import",
		"booking_import",
	]) {
		assert.match(reservationSource, new RegExp(`createLegacyOtaImportReservation[\\s\\S]+?${sourceName}`));
	}
	assert.equal(
		(integratorSource.match(/createReservation: \(prepared, options\)/g) || [])
			.length,
		2
	);
	assert.equal(
		(reservationSource.match(/createReservation: \(prepared, options\)/g) || [])
			.length,
		4
	);
	assert.match(
		orderTakerSource,
		/generateUniquePmsConfirmationNumber\(\s*25,\s*externalConfirmationValues/
	);
	assert.match(
		orderTakerSource,
		/assertReservationPmsConfirmationDistinct\(reservationPayload\)/
	);
});

test("new legacy OTA imports keep provider aliases separate from the PMS confirmation", () => {
	const document = buildLegacyOtaImportCreateDocument({
		document: {
			booking_source: "agoda",
			customer_details: { name: "Example Guest" },
		},
		provider: "agoda",
		externalConfirmationNumber: EXAMPLE_AGODA_ID,
		pmsConfirmationNumber: EXAMPLE_PMS_ID,
	});

	assert.equal(document.confirmation_number, EXAMPLE_PMS_ID);
	assert.equal(document.pms_number, EXAMPLE_PMS_ID);
	assert.equal(document.reservation_id, EXAMPLE_AGODA_ID);
	assert.equal(document.otaIdentityKey, "agoda:agoda-example-9001");
	assert.equal(document.customer_details.name, "Example Guest");
	assert.equal(
		document.customer_details.confirmation_number2,
		EXAMPLE_AGODA_ID
	);
	assert.deepEqual(document.supplierData, {
		supplierName: "Agoda",
		suppliedBookingNo: EXAMPLE_AGODA_ID,
		otaProvider: "agoda",
		otaConfirmationNumber: EXAMPLE_AGODA_ID,
		platformConfirmationNumber: EXAMPLE_AGODA_ID,
		pmsConfirmationNumber: EXAMPLE_PMS_ID,
	});
});

test("legacy OTA creation fails before writing when an allocator returns the provider ID", async () => {
	let createCalls = 0;
	await assert.rejects(
		createLegacyOtaImportReservation({
			document: { booking_source: "agoda" },
			provider: "agoda",
			externalConfirmationNumber: EXAMPLE_AGODA_ID,
			generateConfirmation: async () => EXAMPLE_AGODA_ID,
			findExisting: async () => null,
			createReservation: async () => {
				createCalls += 1;
			},
		}),
		(error) => error.code === "pms_confirmation_matches_external_ota"
	);
	assert.equal(createCalls, 0);
});

test("legacy OTA creation revalidates distinct identities at the final pre-insert boundary", async () => {
	let insertCalls = 0;
	await assert.rejects(
		createLegacyOtaImportReservation({
			document: { booking_source: "agoda" },
			provider: "agoda",
			externalConfirmationNumber: EXAMPLE_AGODA_ID,
			generateConfirmation: async () => EXAMPLE_PMS_ID,
			findExisting: async () => null,
			createReservation: async (document, options) => {
				document.reservation_id = document.confirmation_number;
				await options.beforeInsert({ reservationData: document });
				insertCalls += 1;
			},
		}),
		(error) => error.code === "pms_confirmation_matches_external_ota"
	);
	assert.equal(insertCalls, 0);
});

test("legacy OTA lookup fails closed when more than one scoped identity matches", async () => {
	const ReservationModel = {
		find: () => ({
			limit: () => ({
				exec: async () => [{ _id: "first" }, { _id: "second" }],
			}),
		}),
	};
	await assert.rejects(
		findLegacyOtaImportReservation(
			{
				provider: "agoda",
				externalConfirmationNumber: EXAMPLE_AGODA_ID,
				hotelId: "hotel-1",
				bookingSources: ["agoda"],
			},
			ReservationModel
		),
		(error) => error.code === "legacy_ota_import_identity_ambiguous"
	);
});

test("legacy OTA lookup rejects a single alias match with a conflicting canonical identity", async () => {
	const ReservationModel = {
		find: () => ({
			limit: () => ({
				exec: async () => [
					{
						_id: "conflict",
						otaIdentityKey: "expedia:agoda-example-9001",
						reservation_id: EXAMPLE_AGODA_ID,
					},
				],
			}),
		}),
	};
	await assert.rejects(
		findLegacyOtaImportReservation(
			{
				provider: "agoda",
				externalConfirmationNumber: EXAMPLE_AGODA_ID,
				hotelId: "hotel-1",
				bookingSources: ["agoda"],
			},
			ReservationModel
		),
		(error) => error.code === "legacy_ota_import_identity_conflict"
	);
});

test("a raced PMS unique collision allocates a fresh internal number", async () => {
	const allocations = ["1234500001", "1234500002"];
	const writes = [];
	const result = await createLegacyOtaImportReservation({
		document: { booking_source: "booking.com" },
		provider: "booking.com",
		externalConfirmationNumber: "BOOK-991",
		generateConfirmation: async () => allocations.shift(),
		findExisting: async () => null,
		createReservation: async (document) => {
			writes.push(document);
			if (writes.length === 1) {
				const error = new Error("confirmation_number_1 dup key");
				error.code = 11000;
				error.keyPattern = { confirmation_number: 1 };
				throw error;
			}
			return { _id: "created-1" };
		},
	});

	assert.equal(result.created, true);
	assert.equal(writes.length, 2);
	assert.equal(writes[0].confirmation_number, "1234500001");
	assert.equal(writes[1].confirmation_number, "1234500002");
	assert.equal(writes[1].reservation_id, "BOOK-991");
	assert.equal(writes[1].otaIdentityKey, "booking:book-991");
});

test("an unresolved non-PMS duplicate conflict fails closed", async () => {
	let writeCalls = 0;
	await assert.rejects(
		createLegacyOtaImportReservation({
			document: { booking_source: "expedia" },
			provider: "expedia",
			externalConfirmationNumber: "EXP-77",
			generateConfirmation: async () => "1234500003",
			findExisting: async () => null,
			createReservation: async () => {
				writeCalls += 1;
				const error = new Error("uniq_ota_identity_key dup key");
				error.code = 11000;
				error.keyPattern = { otaIdentityKey: 1 };
				throw error;
			},
		}),
		(error) => error.code === "legacy_ota_import_duplicate_conflict"
	);
	assert.equal(writeCalls, 1);
});

test("an exact concurrent provider identity is deduplicated without a second write", async () => {
	const raced = { _id: "race-winner", confirmation_number: "1234500004" };
	let writeCalls = 0;
	const result = await createLegacyOtaImportReservation({
		document: { booking_source: "airbnb" },
		provider: "airbnb",
		externalConfirmationNumber: "HMABC123",
		generateConfirmation: async () => "1234500005",
		findExisting: async () => raced,
		createReservation: async () => {
			writeCalls += 1;
			const error = new Error("uniq_ota_identity_key dup key");
			error.code = 11000;
			error.keyPattern = { otaIdentityKey: 1 };
			throw error;
		},
	});

	assert.equal(writeCalls, 1);
	assert.equal(result.created, false);
	assert.equal(result.reservation, raced);
	assert.equal(result.reason, "external_identity_race");
});

test("legacy re-import updates cannot overwrite existing PMS or OTA identity fields", () => {
	const existingLegacyReservation = {
		confirmation_number: "OTA-123",
		booking_source: "agoda",
		customer_details: {
			name: "Original Guest",
			confirmation_number2: "OTA-123",
		},
		supplierData: {
			otaProvider: "agoda",
			otaConfirmationNumber: "OTA-123",
		},
	};
	const incoming = {
		confirmation_number: "OTA-123",
		pms_number: "OTA-123",
		reservation_id: "OTA-123",
		otaIdentityKey: "agoda:ota-123",
		customer_details: {
			name: "Updated Guest",
			confirmation_number2: "OTA-123",
		},
		supplierData: {
			suppliedBookingNo: "OTA-123",
			pmsConfirmationNumber: "OTA-123",
			commercialNote: "safe to update",
		},
		total_amount: 75,
	};
	const update = buildLegacyOtaImportUpdateDocument(
		existingLegacyReservation,
		incoming
	);

	assert.equal(update.confirmation_number, undefined);
	assert.equal(update.pms_number, undefined);
	assert.equal(update.reservation_id, undefined);
	assert.equal(update.otaIdentityKey, undefined);
	assert.deepEqual(update.customer_details, {
		name: "Updated Guest",
		confirmation_number2: "OTA-123",
	});
	assert.deepEqual(update.supplierData, {
		otaProvider: "agoda",
		otaConfirmationNumber: "OTA-123",
		commercialNote: "safe to update",
	});
	assert.equal(update.total_amount, 75);
	assert.equal(incoming.confirmation_number, "OTA-123");
	assert.equal(incoming.customer_details.confirmation_number2, "OTA-123");
	assert.equal(
		{ ...existingLegacyReservation, ...update }.confirmation_number,
		"OTA-123"
	);
});
