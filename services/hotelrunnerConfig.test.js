/** @format */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { getHotelRunnerConfig } = require("./hotelrunnerConfig");

const baseEnvironment = {
	HOTELRUNNER_INTEGRATION_ENABLED: "true",
	HOTELRUNNER_API_TOKEN: "synthetic-token",
	HOTELRUNNER_API_HR_ID: "synthetic-hr-id",
	HOTELRUNNER_SUPPORTED_HOTELIDS: "64b000000000000000000001",
};

test("HotelRunner integration master switch defaults off and disables every runtime boundary", () => {
	const disabled = getHotelRunnerConfig({
		...baseEnvironment,
		HOTELRUNNER_INTEGRATION_ENABLED: "false",
		HOTELRUNNER_PROJECTION_ENABLED: "true",
		HOTELRUNNER_ROOM_LIST_SYNC_ENABLED: "true",
		HOTELRUNNER_PROJECTION_NOT_BEFORE: "2026-08-06T12:34:56.000Z",
	});
	assert.equal(disabled.integrationEnabled, false);
	assert.equal(disabled.configured, false);
	assert.equal(disabled.callbackConfigured, false);

	const defaultOff = getHotelRunnerConfig({
		HOTELRUNNER_API_TOKEN: "synthetic-token",
		HOTELRUNNER_API_HR_ID: "synthetic-hr-id",
		HOTELRUNNER_SUPPORTED_HOTELIDS: "64b000000000000000000001",
	});
	assert.equal(defaultOff.integrationEnabled, false);
	assert.equal(defaultOff.configured, false);
	assert.equal(defaultOff.callbackConfigured, false);

	const malformed = getHotelRunnerConfig({
		...baseEnvironment,
		HOTELRUNNER_INTEGRATION_ENABLED: "tru",
	});
	assert.equal(malformed.integrationEnabled, false);
	assert.equal(malformed.configured, false);
	assert.equal(
		malformed.errors.some((error) =>
			error.startsWith("HOTELRUNNER_INTEGRATION_ENABLED")
		),
		true
	);
});

test("local projection is fail-closed until explicitly activated", () => {
	assert.equal(getHotelRunnerConfig(baseEnvironment).projectionEnabled, false);
	assert.equal(
		getHotelRunnerConfig({
			...baseEnvironment,
			HOTELRUNNER_PROJECTION_ENABLED: "true",
			HOTELRUNNER_PROJECTION_NOT_BEFORE: "2026-08-06T12:34:56.000Z",
		}).projectionEnabled,
		true
	);
});

test("HotelRunner OTA review mode is opt-in and uses an explicit boolean", () => {
	assert.equal(getHotelRunnerConfig(baseEnvironment).requireOtaReview, false);
	assert.equal(
		getHotelRunnerConfig({
			...baseEnvironment,
			HOTELRUNNER_REQUIRE_OTA_REVIEW: "true",
		}).requireOtaReview,
		true
	);
	assert.equal(
		getHotelRunnerConfig({
			...baseEnvironment,
			HOTELRUNNER_REQUIRE_OTA_REVIEW: "false",
		}).requireOtaReview,
		false
	);
});

test("projection requires a valid timezone-qualified activation cutoff", () => {
	const missing = getHotelRunnerConfig({
		...baseEnvironment,
		HOTELRUNNER_PROJECTION_ENABLED: "true",
	});
	assert.equal(missing.configured, false);
	assert.equal(missing.projectionNotBefore, null);
	assert.equal(
		missing.errors.some((error) =>
			error.startsWith("HOTELRUNNER_PROJECTION_NOT_BEFORE")
		),
		true
	);

	for (const timestamp of [
		"2026-08-06",
		"2026-08-06T12:34:56",
		"2026-02-30T12:34:56Z",
		"not-a-timestamp",
	]) {
		const invalid = getHotelRunnerConfig({
			...baseEnvironment,
			HOTELRUNNER_PROJECTION_ENABLED: "true",
			HOTELRUNNER_PROJECTION_NOT_BEFORE: timestamp,
		});
		assert.equal(invalid.configured, false, timestamp);
		assert.equal(invalid.projectionNotBefore, null, timestamp);
	}

	const enabled = getHotelRunnerConfig({
		...baseEnvironment,
		HOTELRUNNER_PROJECTION_ENABLED: "true",
		HOTELRUNNER_PROJECTION_NOT_BEFORE: "2026-08-06T15:34:56+03:00",
		HOTELRUNNER_ROOM_LIST_SYNC_ENABLED: "true",
	});
	assert.equal(enabled.configured, true);
	assert.ok(enabled.projectionNotBefore instanceof Date);
	assert.equal(enabled.projectionNotBeforeIso, "2026-08-06T12:34:56.000Z");
});

test("projection worker requires recurring room-list sync without disabling callbacks", () => {
	const config = getHotelRunnerConfig({
		...baseEnvironment,
		HOTELRUNNER_PROJECTION_ENABLED: "true",
		HOTELRUNNER_PROJECTION_NOT_BEFORE: "2026-08-06T12:34:56.000Z",
		HOTELRUNNER_ROOM_LIST_SYNC_ENABLED: "false",
	});
	assert.equal(config.configured, false);
	assert.equal(config.callbackConfigured, true);
	assert.equal(config.projectionEnabled, true);
	assert.equal(config.roomListSyncEnabled, false);
	assert.equal(
		config.errors.some(
			(error) =>
				error.includes("HOTELRUNNER_ROOM_LIST_SYNC_ENABLED") &&
				error.includes("HOTELRUNNER_PROJECTION_ENABLED")
		),
		true
	);
});

test("background reservation pulls are opt-in while controlled room discovery remains configured", () => {
	const defaultConfig = getHotelRunnerConfig(baseEnvironment);
	assert.equal(defaultConfig.configured, true);
	assert.equal(defaultConfig.pullEnabled, false);
	assert.equal(defaultConfig.roomListSyncEnabled, false);

	const enabledConfig = getHotelRunnerConfig({
		...baseEnvironment,
		HOTELRUNNER_PULL_ENABLED: "true",
	});
	assert.equal(enabledConfig.configured, true);
	assert.equal(enabledConfig.pullEnabled, true);
	const roomListEnabled = getHotelRunnerConfig({
		...baseEnvironment,
		HOTELRUNNER_ROOM_LIST_SYNC_ENABLED: "true",
	});
	assert.equal(roomListEnabled.configured, true);
	assert.equal(roomListEnabled.roomListSyncEnabled, true);
});

test("malformed explicit safety booleans fail closed and invalidate configuration", () => {
	for (const key of [
		"HOTELRUNNER_PULL_ENABLED",
		"HOTELRUNNER_ROOM_LIST_SYNC_ENABLED",
		"HOTELRUNNER_PROJECTION_ENABLED",
		"HOTELRUNNER_CONFIRM_DELIVERY_ENABLED",
		"HOTELRUNNER_REQUIRE_OTA_REVIEW",
	]) {
		const config = getHotelRunnerConfig({
			...baseEnvironment,
			[key]: "tru",
		});
		assert.equal(config.configured, false, key);
		assert.equal(config.callbackConfigured, true, key);
		const configProperty = {
			HOTELRUNNER_PULL_ENABLED: "pullEnabled",
			HOTELRUNNER_ROOM_LIST_SYNC_ENABLED: "roomListSyncEnabled",
			HOTELRUNNER_PROJECTION_ENABLED: "projectionEnabled",
			HOTELRUNNER_CONFIRM_DELIVERY_ENABLED: "confirmDeliveryEnabled",
			HOTELRUNNER_REQUIRE_OTA_REVIEW: "requireOtaReview",
		}[key];
		assert.equal(config[configProperty], false, key);
		assert.equal(config.errors.some((error) => error.startsWith(key)), true, key);
	}
	const explicitlyBlankPull = getHotelRunnerConfig({
		...baseEnvironment,
		HOTELRUNNER_PULL_ENABLED: "",
	});
	assert.equal(explicitlyBlankPull.configured, false);
	assert.equal(explicitlyBlankPull.pullEnabled, false);
});

test("callback readiness is independent from worker-only safety configuration", () => {
	const workerInvalid = getHotelRunnerConfig({
		...baseEnvironment,
		HOTELRUNNER_PROJECTION_ENABLED: "tru",
	});
	assert.equal(workerInvalid.configured, false);
	assert.equal(workerInvalid.callbackConfigured, true);

	const callbackInvalid = getHotelRunnerConfig({
		...baseEnvironment,
		HOTELRUNNER_API_TOKEN: "",
	});
	assert.equal(callbackInvalid.callbackConfigured, false);
});

test("delivery confirmation is separately opt-in and keeps the status alias in sync", () => {
	const disabled = getHotelRunnerConfig(baseEnvironment);
	assert.equal(disabled.confirmDeliveryEnabled, false);
	assert.equal(disabled.confirmPulledDeliveryEnabled, false);

	const enabled = getHotelRunnerConfig({
		...baseEnvironment,
		HOTELRUNNER_CONFIRM_DELIVERY_ENABLED: "yes",
	});
	assert.equal(enabled.configured, true);
	assert.equal(enabled.confirmDeliveryEnabled, true);
	assert.equal(enabled.confirmPulledDeliveryEnabled, true);
});

test("history pull and live projection cannot be enabled together in the push-only phase", () => {
	const config = getHotelRunnerConfig({
		...baseEnvironment,
		HOTELRUNNER_PULL_ENABLED: "true",
		HOTELRUNNER_PROJECTION_ENABLED: "true",
		HOTELRUNNER_PROJECTION_NOT_BEFORE: "2026-08-06T12:34:56.000Z",
	});
	assert.equal(config.configured, false);
	assert.equal(config.pullEnabled, true);
	assert.equal(config.projectionEnabled, true);
	assert.ok(
		config.errors.some(
			(error) =>
				error.includes("HOTELRUNNER_PULL_ENABLED") &&
				error.includes("HOTELRUNNER_PROJECTION_ENABLED")
		)
	);
});

test("HotelRunner-first OTA email queue timing and retry controls have safe bounded defaults", () => {
	const defaults = getHotelRunnerConfig(baseEnvironment);
	assert.equal(defaults.otaEmailFallbackGraceMs, 180_000);
	assert.equal(defaults.otaEmailFallbackLeaseMs, 300_000);
	assert.equal(defaults.otaEmailFallbackProofTtlMs, 120_000);
	assert.equal(defaults.otaEmailFallbackMaxAttempts, 12);

	const bounded = getHotelRunnerConfig({
		...baseEnvironment,
		HOTELRUNNER_OTA_EMAIL_FALLBACK_GRACE_MS: "1",
		HOTELRUNNER_OTA_EMAIL_FALLBACK_LEASE_MS: "999999999",
		HOTELRUNNER_OTA_EMAIL_FALLBACK_PROOF_TTL_MS: "1",
		HOTELRUNNER_OTA_EMAIL_FALLBACK_MAX_ATTEMPTS: "999",
	});
	assert.equal(bounded.otaEmailFallbackGraceMs, 30_000);
	assert.equal(bounded.otaEmailFallbackLeaseMs, 900_000);
	assert.equal(bounded.otaEmailFallbackProofTtlMs, 30_000);
	assert.equal(bounded.otaEmailFallbackMaxAttempts, 30);

	const configured = getHotelRunnerConfig({
		...baseEnvironment,
		HOTELRUNNER_OTA_EMAIL_FALLBACK_GRACE_MS: "240000",
		HOTELRUNNER_OTA_EMAIL_FALLBACK_LEASE_MS: "180000",
		HOTELRUNNER_OTA_EMAIL_FALLBACK_PROOF_TTL_MS: "90000",
		HOTELRUNNER_OTA_EMAIL_FALLBACK_MAX_ATTEMPTS: "9",
	});
	assert.equal(configured.otaEmailFallbackGraceMs, 240_000);
	assert.equal(configured.otaEmailFallbackLeaseMs, 180_000);
	assert.equal(configured.otaEmailFallbackProofTtlMs, 90_000);
	assert.equal(configured.otaEmailFallbackMaxAttempts, 9);
});
