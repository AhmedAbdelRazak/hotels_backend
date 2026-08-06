/** @format */

const test = require("node:test");
const assert = require("node:assert/strict");
const {
	hotelRunnerManagedEmailSkipResult,
	hotelRunnerManagedHotelIds,
	isHotelRunnerManagedHotelId,
} = require("./hotelrunnerOtaEmailBoundary");

const HOTEL_A = "64B000000000000000000001";
const HOTEL_B = "64b000000000000000000002";

test("OTA email suppression is exact and requires one runnable property binding", () => {
	const disabled = {
		HOTELRUNNER_API_TOKEN: "synthetic-token",
		HOTELRUNNER_API_HR_ID: "synthetic-hr-id",
		HOTELRUNNER_SUPPORTED_HOTELIDS: ` ${HOTEL_A} `,
		HOTELRUNNER_PROJECTION_ENABLED: "false",
	};
	assert.equal(isHotelRunnerManagedHotelId(HOTEL_A, disabled), false);

	const enabled = {
		...disabled,
		HOTELRUNNER_PROJECTION_ENABLED: "true",
	};
	assert.deepEqual(
		[...hotelRunnerManagedHotelIds(enabled)],
		[HOTEL_A.toLowerCase()]
	);
	assert.equal(isHotelRunnerManagedHotelId(HOTEL_A.toLowerCase(), enabled), true);
	assert.equal(
		isHotelRunnerManagedHotelId("64b000000000000000000003", enabled),
		false
	);
	assert.equal(isHotelRunnerManagedHotelId("", enabled), false);

	const unsafeMultipleProperties = {
		...enabled,
		HOTELRUNNER_SUPPORTED_HOTELIDS: `${HOTEL_A},${HOTEL_B}`,
	};
	assert.equal(
		isHotelRunnerManagedHotelId(HOTEL_A, unsafeMultipleProperties),
		false,
		"email must remain available when the singular worker cannot run"
	);
	assert.equal(
		isHotelRunnerManagedHotelId(HOTEL_B, unsafeMultipleProperties),
		false
	);
});

test("the boundary result is an audit-only skip and never claims a mutation", () => {
	assert.deepEqual(
		hotelRunnerManagedEmailSkipResult({
			hotelId: HOTEL_A,
			reservation: {
				_id: "reservation-1",
				hotelId: HOTEL_A,
				confirmation_number: "PMS-1",
			},
			warnings: ["kept"],
			matchedReservationBy: ["otaIdentityKey"],
		}),
		{
			status: "ignored",
			actionTaken: "skipped",
			skipReason: "hotelrunner_managed_hotel_ota_email_disabled",
			automationComment:
				"This hotel is managed by the direct HotelRunner integration. The OTA email remains archived for audit only and cannot create or change a PMS reservation.",
			warnings: ["kept"],
			errors: [],
			reservationId: "reservation-1",
			hotelId: HOTEL_A,
			pmsConfirmationNumber: "PMS-1",
			matchedReservationBy: ["otaIdentityKey"],
		}
	);
});
