/** @format */

const test = require("node:test");
const assert = require("node:assert/strict");
const {
	hasActiveHotelRunnerLifecycleAuthority,
	hasDirectHotelRunnerProjection,
	normalizeMarker,
} = require("./hotelrunnerOtaEmailBoundary");

const projectedReservation = {
	supplierData: {
		hotelRunner: {
			transport: "hotelrunner_api",
			reservationId: "hr-reservation-1",
		},
		otaAutomationPipeline: "hotelrunner_background_worker",
		otaSourceAuthority: 4,
	},
};

test("historical projection provenance loses lifecycle authority in email-only mode", () => {
	assert.equal(hasDirectHotelRunnerProjection(projectedReservation), true);
	assert.equal(
		hasActiveHotelRunnerLifecycleAuthority(projectedReservation, {
			integrationEnabled: false,
		}),
		false
	);
	assert.equal(
		hasActiveHotelRunnerLifecycleAuthority(projectedReservation, {
			integrationEnabled: true,
		}),
		true
	);
});

test("direct HotelRunner ownership requires a reservation-level projection marker", () => {
	assert.equal(hasDirectHotelRunnerProjection(), false);
	assert.equal(hasDirectHotelRunnerProjection({ supplierData: {} }), false);
	assert.equal(
		hasDirectHotelRunnerProjection({
			hotelId: "configured-property-is-not-enough",
			supplierData: {
				otaAutomationPipeline: "ota-inbound-email",
				otaSourceAuthority: 3,
			},
		}),
		false,
		"property membership or ordinary OTA metadata must not disable email ingestion"
	);
});

test("direct ownership requires the complete atomic HotelRunner projection stamp", () => {
	assert.equal(
		hasDirectHotelRunnerProjection({
			supplierData: {
				hotelRunner: { transport: " HotelRunner API " },
			},
		}),
		false,
		"transport alone may be partial or malformed metadata"
	);
	assert.equal(
		hasDirectHotelRunnerProjection({
			supplierData: {
				hotelRunner: {
					transport: "hotelrunner_api",
					reservationId: "hr-reservation-1",
				},
				otaAutomationPipeline: "hotelrunner-background-worker",
				otaSourceAuthority: 4,
			},
		}),
		true
	);
});

test("none of the worker ownership fields is sufficient when another is missing", () => {
	assert.equal(
		hasDirectHotelRunnerProjection({
			supplierData: {
				hotelRunner: {
					transport: "hotelrunner_api",
					reservationId: "hr-reservation-1",
				},
				otaAutomationPipeline: "HotelRunner Background Worker",
				otaSourceAuthority: 3,
			},
		}),
		false
	);
	assert.equal(
		hasDirectHotelRunnerProjection({
			supplierData: {
				hotelRunner: {
					transport: "hotelrunner_api",
					reservationId: "hr-reservation-1",
				},
				otaAutomationPipeline: "hotelrunner-background-worker",
				otaSourceAuthority: 4,
			},
		}),
		true
	);
	assert.equal(
		hasDirectHotelRunnerProjection({
			supplierData: {
				hotelRunner: {
					transport: "hotelrunner_api",
					reservationId: "hr-reservation-1",
				},
				otaAutomationPipeline: "another-background-worker",
				otaSourceAuthority: 4,
			},
		}),
		false
	);
});

test("marker normalization is exact across supported separators", () => {
	assert.equal(
		normalizeMarker(" HotelRunner-Background Worker "),
		"hotelrunner_background_worker"
	);
	assert.equal(normalizeMarker(null), "");
});
