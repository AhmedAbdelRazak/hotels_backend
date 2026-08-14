/** @format */

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const {
	__excelOtaIdentityTestHooks: {
		prepareExcelReservationIdentity,
		resolveExcelOtaIdentity,
	},
} = require("../controllers/reservation_excel_import");

test("Excel commit recognizes only exact supported OTA booking-source labels", () => {
	for (const [bookingSource, provider] of [
		["Agoda", "agoda"],
		[" expedia ", "expedia"],
		["AIRBNB", "airbnb"],
		["Booking", "booking"],
		["Booking.com", "booking"],
		["Trip.com", "trip"],
		["Trip.com V2", "trip"],
		["Ctrip", "trip"],
		["Trivago", "trivago"],
		["Hotel.com", "hotels"],
		["Hotels.com", "hotels"],
	]) {
		assert.deepEqual(
			resolveExcelOtaIdentity({
				bookingSource,
				rowConfirmationNumber: "OTA-123",
			}),
			{ provider, externalConfirmationNumber: "OTA-123" }
		);
	}

	for (const bookingSource of [
		"Agoda Agent",
		"My Expedia Agency",
		"Booking Holdings",
		"Airbnb Direct Sales",
		"Excel Upload",
		"jannat employee",
	]) {
		assert.equal(
			resolveExcelOtaIdentity({
				bookingSource,
				rowConfirmationNumber: "LOCAL-123",
			}),
			null
		);
	}
});

test("Excel OTA rows fail closed when the spreadsheet omits the external confirmation", () => {
	for (const rowConfirmationNumber of [undefined, null, "   ", false, {}]) {
		assert.throws(
			() =>
				resolveExcelOtaIdentity({
					bookingSource: "Agoda",
					rowConfirmationNumber,
				}),
			(error) => {
				assert.equal(error.code, "excel_ota_external_confirmation_required");
				assert.equal(error.statusCode, 400);
				return true;
			}
		);
	}
});

test("Excel OTA confirmation is external-only and gets a distinct server PMS identity", async () => {
	const external = "OTA-EXCEL-123";
	const pms = "2207032999";
	let allocatorInputs;
	const sourcePayload = {
		confirmation_number: external,
		booking_source: "Agoda",
		hotelId: "hotel-1",
		customer_details: { name: "Example Guest" },
	};

	const { reservationPayload, otaIdentity } =
		await prepareExcelReservationIdentity({
			reservationPayload: sourcePayload,
			bookingSource: "Agoda",
			rowConfirmationNumber: external,
			generateConfirmation: async (attempts, externalValues) => {
				allocatorInputs = { attempts, externalValues };
				return pms;
			},
		});

	assert.equal(otaIdentity.provider, "agoda");
	assert.equal(reservationPayload.confirmation_number, pms);
	assert.equal(reservationPayload.pms_number, pms);
	assert.equal(reservationPayload.customer_details.confirmation_number2, external);
	assert.equal(reservationPayload.reservation_id, external);
	assert.equal(reservationPayload.otaIdentityKey, "agoda:ota-excel-123");
	assert.equal(reservationPayload.supplierData.otaProvider, "agoda");
	assert.equal(reservationPayload.supplierData.suppliedBookingNo, external);
	assert.equal(reservationPayload.supplierData.otaConfirmationNumber, external);
	assert.equal(
		reservationPayload.supplierData.platformConfirmationNumber,
		external
	);
	assert.equal(reservationPayload.supplierData.pmsConfirmationNumber, pms);
	assert.equal(allocatorInputs.attempts, 25);
	assert.ok(allocatorInputs.externalValues.includes(external));
	assert.ok(allocatorInputs.externalValues.includes("agoda:ota-excel-123"));
	assert.notEqual(reservationPayload.confirmation_number, external);
	assert.equal(sourcePayload.confirmation_number, external);
});

test("Excel OTA preparation rejects an allocator result equal to the external ID", async () => {
	await assert.rejects(
		prepareExcelReservationIdentity({
			reservationPayload: {
				booking_source: "Agoda",
				customer_details: { name: "Example Guest" },
			},
			bookingSource: "Agoda",
			rowConfirmationNumber: "2041108213",
			generateConfirmation: async () => "2041108213",
		}),
		(error) => {
			assert.equal(error.code, "pms_confirmation_matches_external_ota");
			return true;
		}
	);
});

test("non-OTA Excel reservation identity semantics remain unchanged", async () => {
	const reservationPayload = {
		confirmation_number: "LOCAL-EXCEL-123",
		booking_source: "Direct Corporate",
		customer_details: { name: "Example Guest" },
	};
	let generatorCalled = false;
	const prepared = await prepareExcelReservationIdentity({
		reservationPayload,
		bookingSource: "Direct Corporate",
		rowConfirmationNumber: "LOCAL-EXCEL-123",
		generateConfirmation: async () => {
			generatorCalled = true;
			return "9999999999";
		},
	});

	assert.equal(prepared.reservationPayload, reservationPayload);
	assert.equal(prepared.otaIdentity, null);
	assert.equal(prepared.reservationPayload.confirmation_number, "LOCAL-EXCEL-123");
	assert.equal(generatorCalled, false);
});

test("Excel commit asserts OTA identity at the final pre-insert boundary", () => {
	const source = fs.readFileSync(
		require.resolve("../controllers/reservation_excel_import"),
		"utf8"
	);
	const commitStart = source.indexOf("exports.commitReservationExcelImport");
	const hooksStart = source.indexOf("exports.__excelOtaIdentityTestHooks");
	const commitSource = source.slice(commitStart, hooksStart);
	assert.match(
		commitSource,
		/createReservationWithAvailabilitySnapshot\([\s\S]*?"ai_excel_import",[\s\S]*?beforeInsert:\s*\(\{ reservationData \}\)\s*=>[\s\S]*?assertReservationPmsConfirmationDistinct\([\s\S]*?reservationData/
	);
});
