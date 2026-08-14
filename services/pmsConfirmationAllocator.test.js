/** @format */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
	RESERVATION_EXTERNAL_CONFIRMATION_PATHS,
	assertReservationPmsConfirmationDistinct,
	assertReservationPmsConfirmationUpdateSafe,
	generateUniquePmsConfirmationNumber,
	reservationExternalConfirmationValues,
} = require("./pmsConfirmationAllocator");

const noExistingReservation = { exists: async () => null };

test("PMS allocation skips an incoming OTA identifier before querying persistence", async () => {
	const originalRandom = Math.random;
	let calls = 0;
	Math.random = () => (calls++ === 0 ? 0.123456789 : 0.223456789);
	try {
		const result = await generateUniquePmsConfirmationNumber(
			2,
			["2111111101", "agoda:2111111101"],
			{ ReservationModel: noExistingReservation }
		);
		assert.equal(result, "3011111101");
		assert.notEqual(result, "2111111101");
	} finally {
		Math.random = originalRandom;
	}
});

test("a safe OTA record rejects an external alias equal to its PMS confirmation", () => {
	const existing = {
		confirmation_number: "2200000001",
		otaIdentityKey: "agoda:8800000001",
		reservation_id: "8800000001",
		supplierData: { pmsConfirmationNumber: "2200000001" },
	};
	assert.throws(
		() =>
			assertReservationPmsConfirmationUpdateSafe(existing, {
				"supplierData.suppliedBookingNo": "2200000001",
			}),
		(error) => error?.code === "pms_confirmation_matches_external_ota"
	);
});

test("the legacy supplier confirmation alias cannot equal the PMS confirmation", () => {
	const existing = {
		confirmation_number: "2200000002",
		otaIdentityKey: "agoda:8800000002",
		reservation_id: "8800000002",
		supplierData: { pmsConfirmationNumber: "2200000002" },
	};
	assert.throws(
		() =>
			assertReservationPmsConfirmationUpdateSafe(existing, {
				"supplierData.confirmationNumber": "2200000002",
			}),
		(error) => error?.code === "pms_confirmation_matches_external_ota"
	);
});

test("a grandfathered equality allows lifecycle updates but locks every identity value", () => {
	const existing = {
		confirmation_number: "3300000001",
		reservation_id: "3300000001",
		booking_source: "agoda",
		supplierData: { pmsConfirmationNumber: "3300000001" },
	};
	const candidate = assertReservationPmsConfirmationUpdateSafe(existing, {
		reservation_status: "cancelled",
	});
	assert.equal(candidate.reservation_status, "cancelled");

	assert.throws(
		() =>
			assertReservationPmsConfirmationUpdateSafe(existing, {
				"supplierData.otaConfirmationNumber": "8800000002",
			}),
		(error) => error?.code === "legacy_pms_ota_identity_locked"
	);
});

test("PMS mirrors cannot diverge during an OTA update", () => {
	const existing = {
		confirmation_number: "4400000001",
		reservation_id: "9900000001",
	};
	assert.throws(
		() =>
			assertReservationPmsConfirmationUpdateSafe(existing, {
				"supplierData.pmsConfirmationNumber": "4400000002",
			}),
		(error) => error?.code === "pms_confirmation_mirror_mismatch"
	);
});

test("every persisted external alias spelling is covered by the final invariant", () => {
	const pms = "5500000001";
	for (const path of RESERVATION_EXTERNAL_CONFIRMATION_PATHS) {
		const reservation = {
			confirmation_number: pms,
			supplierData: { pmsConfirmationNumber: pms },
		};
		let cursor = reservation;
		const parts = path.split(".");
		for (let index = 0; index < parts.length - 1; index += 1) {
			cursor[parts[index]] ||= {};
			cursor = cursor[parts[index]];
		}
		cursor[parts[parts.length - 1]] = pms;
		assert.throws(
			() => assertReservationPmsConfirmationDistinct(reservation),
			(error) => error?.code === "pms_confirmation_matches_external_ota",
			path
		);
	}
});

test("OrderTaker camel-case aliases are reserved during PMS allocation", async () => {
	const originalRandom = Math.random;
	let calls = 0;
	Math.random = () => (calls++ === 0 ? 0.345678901 : 0.445678901);
	try {
		const externalValues = reservationExternalConfirmationValues({
			customerDetails: { confirmationNumber2: "4111110109" },
		});
		const result = await generateUniquePmsConfirmationNumber(
			2,
			externalValues,
			{ ReservationModel: noExistingReservation }
		);
		assert.equal(result, "5011110109");
		assert.notEqual(result, "4111110109");
	} finally {
		Math.random = originalRandom;
	}
});
