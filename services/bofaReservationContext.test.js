"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
	buildBankReferenceNumber,
	buildHostedMerchantDefinedData,
	buildReservationPaymentContext,
} = require("./bofaReservationContext");

const reservation = {
	_id: "6a4aeb022186129b5e8b2b3a",
	confirmation_number: "8613390780",
	reservation_id: "675894003",
	booking_source: "agoda",
	reservation_status: "confirmed",
	checkin_date: "2026-07-19T00:00:00.000Z",
	checkout_date: "2026-07-25T00:00:00.000Z",
	days_of_residence: 6,
	total_rooms: 1,
	customer_details: {
		confirmation_number2: "675894003",
		name: "This must never be emitted to merchant-defined data",
	},
};

test("builds a traceable internal OTA VCC context without card or guest data", () => {
	const referenceNumber = buildBankReferenceNumber(reservation, 1784764800000);
	const context = buildReservationPaymentContext({
		reservation,
		hotelName: "Zyd Agyad",
		provider: "agoda",
		referenceNumber,
		amountUsd: 108.8,
		billingProfileId: "agoda-sg-v2",
		billingSource: "built_in",
	});

	assert.match(referenceNumber, /^JB-8613390780-/);
	assert.equal(context.hotel_reservation_confirmation_number, "8613390780");
	assert.equal(context.ota_confirmation_number, "675894003");
	assert.equal(context.hotel_name, "Zyd Agyad");
	assert.equal(context.ota_name, "Agoda");
	assert.equal(context.check_in_date, "2026-07-19");
	assert.equal(context.check_out_date, "2026-07-25");
	assert.equal(context.stay_nights, 6);
	assert.equal(context.amount_usd, 108.8);
	assert.equal(JSON.stringify(context).includes("This must never"), false);
});

test("emits only non-PII merchant-defined fields and hashes the OTA reference", () => {
	const context = buildReservationPaymentContext({
		reservation,
		hotelName: "Zyd Agyad",
		provider: "agoda",
		referenceNumber: "JB-8613390780-TEST",
		amountUsd: 108.8,
	});
	const fields = buildHostedMerchantDefinedData(context);
	const serialized = JSON.stringify(fields);

	assert.equal(fields.merchant_defined_data1, "OTA_VIRTUAL_CARD");
	assert.equal(fields.merchant_defined_data2, "OTA=Agoda");
	assert.equal(fields.merchant_defined_data3, "HOTEL=Zyd Agyad");
	assert.match(fields.merchant_defined_data4, /STAY=2026-07-19\/2026-07-25/);
	assert.match(fields.merchant_defined_data4, /OTA_REF_SHA256=[a-f0-9]{16}/);
	assert.equal(fields.merchant_defined_data5, "OTA_VIRTUAL_CARD");
	assert.equal(fields.merchant_defined_data6, "OTA=Agoda");
	assert.equal(fields.merchant_defined_data7, "HOTEL=Zyd Agyad");
	assert.equal(fields.merchant_defined_data8, fields.merchant_defined_data4);
	assert.equal(serialized.includes("675894003"), false);
	assert.equal(serialized.includes("This must never"), false);
	for (const value of Object.values(fields)) assert.ok(value.length <= 100);
});

test("normalizes hosted metadata to English-safe ASCII", () => {
	const fields = buildHostedMerchantDefinedData({
		ota_name: "Agoda",
		hotel_name: "فندق Zyd Agyad",
		check_in_date: "2026-07-19",
		check_out_date: "2026-07-25",
	});
	assert.equal(fields.merchant_defined_data3, "HOTEL=Zyd Agyad");
	for (const value of Object.values(fields)) assert.match(value, /^[\x20-\x7E]+$/);
	assert.equal(
		buildHostedMerchantDefinedData({ hotel_name: "فندق" }).merchant_defined_data3,
		"HOTEL=UNSPECIFIED",
	);
});
