/** @format */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
	AUTHENTICATED_SOURCE_TYPES,
	OtaCommercialEvidenceError,
	buildAuthenticatedProviderCommercialEvidence,
	buildHotelRunnerUnresolvedCommercialEvidence,
	hashOtaCommercialEvidence,
	validateOtaCommercialEvidence,
} = require("./otaCommercialEvidence");

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

function authenticatedInput(overrides = {}) {
	return {
		provider: "expedia",
		authenticatedProvider: "expedia",
		sourceAuthenticated: true,
		sourceTrusted: true,
		sourceType: "authenticated_provider_portal",
		sourceCurrency: "USD",
		propertyCurrency: "SAR",
		bookingBasis: "reservation_total",
		sourceHash: HASH_A,
		sourceTimestamp: "2026-08-08T12:00:00.000Z",
		sourceId: "6a77f627cdbc8acbbe4968a5",
		...overrides,
	};
}

function expectCode(fn, code) {
	assert.throws(fn, (error) => {
		assert.ok(error instanceof OtaCommercialEvidenceError);
		assert.equal(error.code, code);
		return true;
	});
}

test("HotelRunner-only evidence is immutable and commercially unresolved", () => {
	const evidence = buildHotelRunnerUnresolvedCommercialEvidence({
		provider: "Expedia",
		sourceType: "hotelrunner_email_relay",
		reportedAmount: 112.92,
		reportedCurrency: "USD",
		propertyCurrency: "SAR",
		sourceHash: HASH_B,
		sourceTimestamp: "2026-08-08T12:01:00Z",
		sourceId: "hr-relay-2530158461",
		guestName: "must-not-persist",
	});

	assert.equal(evidence.sourceType, "hotelrunner_email_relay");
	assert.equal(evidence.hotelRunnerReportedAmount.role, "unknown");
	assert.equal(evidence.hotelRunnerReportedAmount.roleVerified, false);
	assert.equal(evidence.verificationState, "unresolved");
	assert.deepEqual(evidence.nightlyEvidence, []);
	assert.deepEqual(evidence.deductionComponents, []);
	for (const role of Object.values(evidence.roles)) {
		assert.equal(role.verified, false);
		assert.equal(role.sourceAmount, null);
		assert.equal(role.propertyAmount, null);
	}
	assert.equal(JSON.stringify(evidence).includes("must-not-persist"), false);
	assert.equal(Object.isFrozen(evidence.provenance.primary), true);
	assert.deepEqual(validateOtaCommercialEvidence(evidence), { ok: true, errors: [] });
});

test("authenticated Expedia portal gross stays in USD without unsafe SAR promotion", () => {
	assert.equal(AUTHENTICATED_SOURCE_TYPES.includes("authenticated_provider_portal"), true);
	const evidence = buildAuthenticatedProviderCommercialEvidence(
		authenticatedInput({
			guestGross: { verified: true, amount: 146.46 },
			hotelRunnerReportedAmount: {
				amount: 112.92,
				currency: "USD",
				role: "unknown",
				provenance: {
					provider: "expedia",
					sourceType: "hotelrunner_webhook",
					sourceHash: HASH_B,
					sourceTimestamp: "2026-08-08T12:01:00.000Z",
					sourceId: "hr-event-7255791395",
				},
			},
		})
	);

	assert.equal(evidence.roles.guestGross.sourceAmount, 146.46);
	assert.equal(evidence.roles.guestGross.sourceCurrency, "USD");
	assert.equal(evidence.roles.guestGross.propertyAmount, null);
	assert.equal(evidence.roles.guestGross.propertyCurrency, null);
	assert.equal(evidence.roles.hotelPayout.sourceAmount, null);
	assert.equal(evidence.roles.deductionAggregate.sourceAmount, null);
	assert.equal(evidence.roles.explicitOtaCommission.sourceAmount, null);
	assert.equal(evidence.hotelRunnerReportedAmount.role, "unknown");
	assert.equal(evidence.currencyConversion, null);
	assert.equal(evidence.verificationState, "partial");
	assert.equal(validateOtaCommercialEvidence(evidence).ok, true);
});

test("missing payout remains null across current and future providers", () => {
	for (const provider of [
		"expedia",
		"booking",
		"trip",
		"agoda",
		"airbnb",
		"futureota",
	]) {
		const evidence = buildAuthenticatedProviderCommercialEvidence(
			authenticatedInput({
				provider,
				authenticatedProvider: provider,
				sourceId: `commercial-${provider}-1`,
				guestGross: { verified: true, amount: 146.46 },
			})
		);
		assert.equal(evidence.roles.guestGross.sourceAmount, 146.46, provider);
		assert.equal(evidence.roles.hotelPayout.verified, false, provider);
		assert.equal(evidence.roles.hotelPayout.sourceAmount, null, provider);
		assert.equal(evidence.roles.hotelPayout.propertyAmount, null, provider);
		assert.equal(evidence.roles.deductionAggregate.verified, false, provider);
		assert.equal(
			evidence.roles.explicitOtaCommission.sourceAmount,
			null,
			provider
		);
		assert.equal(validateOtaCommercialEvidence(evidence).ok, true, provider);
	}
});

test("same-basis gross and payout derive deduction but never infer commission", () => {
	const evidence = buildAuthenticatedProviderCommercialEvidence(
		authenticatedInput({
			propertyCurrency: "USD",
			guestGross: { verified: true, amount: 150 },
			hotelPayout: { verified: true, amount: 120 },
		})
	);
	assert.equal(evidence.roles.deductionAggregate.sourceAmount, 30);
	assert.equal(evidence.roles.deductionAggregate.verified, true);
	assert.equal(evidence.roles.explicitOtaCommission.sourceAmount, null);
	assert.equal(evidence.verificationState, "verified");
});

test("explicit nightly evidence and provider-specific deduction components normalize deterministically", () => {
	const details = {
		propertyCurrency: "USD",
		guestGross: { verified: true, amount: 150 },
		hotelPayout: { verified: true, amount: 120 },
		explicitOtaCommission: { verified: true, explicit: true, amount: 10 },
		hotelBase: {
			verified: true,
			amount: 140,
			provenance: {
				provider: "jannat_pms",
				sourceType: "pms_calendar",
				sourceHash: HASH_C,
				sourceTimestamp: "2026-08-08T11:00:00.000Z",
				sourceId: "calendar-rate-88",
			},
		},
		nightlyEvidence: [
			{
				stayDate: "2026-10-06",
				guestGross: { verified: true, amount: 75 },
				hotelPayout: { verified: true, amount: 60 },
			},
			{
				stayDate: "2026-10-05",
				guestGross: { verified: true, amount: 75 },
				hotelPayout: { verified: true, amount: 60 },
			},
		],
		deductionComponents: [
			{ verified: true, type: "tax_on_commission", amount: 2, direction: "deduction" },
			{ verified: true, type: "promotion", amount: 5, direction: "credit" },
		],
	};
	const first = buildAuthenticatedProviderCommercialEvidence(authenticatedInput(details));
	const second = buildAuthenticatedProviderCommercialEvidence(
		authenticatedInput({
			...details,
			nightlyEvidence: [...details.nightlyEvidence].reverse(),
			deductionComponents: [...details.deductionComponents].reverse(),
		})
	);

	assert.equal(first.nightlyEvidence[0].stayDate, "2026-10-05");
	assert.equal(first.nightlyEvidence[0].deductionAggregate.sourceAmount, 15);
	assert.equal(first.roles.explicitOtaCommission.sourceAmount, 10);
	assert.equal(first.roles.deductionAggregate.sourceAmount, 30);
	assert.deepEqual(first.deductionComponents.map((item) => item.componentType), [
		"promotion",
		"tax_on_commission",
	]);
	assert.equal(first.evidenceHash, second.evidenceHash);
	assert.equal(validateOtaCommercialEvidence(first).ok, true);
});

test("basis mismatch preserves independently verified totals but derives nothing", () => {
	const evidence = buildAuthenticatedProviderCommercialEvidence(
		authenticatedInput({
			propertyCurrency: "USD",
			guestGross: { verified: true, amount: 150, bookingBasis: "reservation_total" },
			hotelPayout: { verified: true, amount: 120, bookingBasis: "room_total" },
		})
	);
	assert.equal(evidence.roles.guestGross.verified, true);
	assert.equal(evidence.roles.hotelPayout.verified, true);
	assert.equal(evidence.roles.deductionAggregate.verified, false);
	assert.equal(evidence.reconciliation.grossAndPayoutSameBasis, false);
	assert.equal(evidence.verificationState, "partial");
});

test("trusted explicit conversion is required before property-currency materialization", () => {
	const converted = buildAuthenticatedProviderCommercialEvidence(
		authenticatedInput({
			guestGross: { verified: true, amount: 146.46, propertyAmount: 549.23 },
			currencyConversion: {
				trusted: true,
				verified: true,
				sourceCurrency: "USD",
				propertyCurrency: "SAR",
				rate: 3.75,
				provenance: {
					provider: "expedia",
					sourceType: "provider_explicit_exchange",
					sourceHash: HASH_C,
					sourceTimestamp: "2026-08-08T12:02:00.000Z",
					sourceId: "expedia-explicit-fx-1",
				},
			},
		})
	);
	assert.equal(converted.roles.guestGross.propertyAmount, 549.23);

	expectCode(
		() =>
			buildAuthenticatedProviderCommercialEvidence(
				authenticatedInput({
					guestGross: { verified: true, amount: 146.46, propertyAmount: 549.23 },
				})
			),
		"UNSAFE_CONVERSION"
	);
	expectCode(
		() =>
			buildAuthenticatedProviderCommercialEvidence(
				authenticatedInput({
					guestGross: { verified: true, amount: 146.46 },
					currencyConversion: {
						trusted: true,
						verified: true,
						sourceCurrency: "USD",
						propertyCurrency: "SAR",
						rate: 3.75,
						provenance: {
							provider: "expedia",
							sourceType: "fallback_default",
							sourceHash: HASH_C,
							sourceTimestamp: "2026-08-08T12:02:00.000Z",
							sourceId: "fallback-fx-1",
						},
					},
				})
			),
		"UNTRUSTED_SOURCE_TYPE"
	);
});

test("trusted FX materialization and revalidation share exact decimal-cent products", () => {
	for (const [sourceAmount, expectedSar] of [
		[29.06, 108.98],
		[10.18, 38.18],
	]) {
		const evidence = buildAuthenticatedProviderCommercialEvidence(
			authenticatedInput({
				guestGross: { verified: true, amount: sourceAmount },
				currencyConversion: {
					trusted: true,
					verified: true,
					sourceCurrency: "USD",
					propertyCurrency: "SAR",
					rate: 3.75,
					provenance: {
						provider: "expedia",
						sourceType: "provider_explicit_exchange",
						sourceHash: HASH_C,
						sourceTimestamp: "2026-08-08T12:02:00.000Z",
						sourceId: `exact-fx-${sourceAmount}`,
					},
				},
			})
		);
		assert.equal(evidence.contractVersion, 2);
		assert.equal(evidence.roles.guestGross.propertyAmount, expectedSar);
		assert.deepEqual(validateOtaCommercialEvidence(evidence), {
			ok: true,
			errors: [],
		});
	}
});

test("legacy v1 FX evidence keeps its original projection semantics", () => {
	const current = buildAuthenticatedProviderCommercialEvidence(
		authenticatedInput({
			guestGross: { verified: true, amount: 10.18 },
			currencyConversion: {
				trusted: true,
				verified: true,
				sourceCurrency: "USD",
				propertyCurrency: "SAR",
				rate: 3.75,
				provenance: {
					provider: "expedia",
					sourceType: "provider_explicit_exchange",
					sourceHash: HASH_C,
					sourceTimestamp: "2026-08-08T12:02:00.000Z",
					sourceId: "legacy-v1-half-cent",
				},
			},
		})
	);
	const legacy = JSON.parse(JSON.stringify(current));
	legacy.contractVersion = 1;
	legacy.roles.guestGross.propertyAmount = 38.17;
	legacy.evidenceHash = hashOtaCommercialEvidence(legacy);
	assert.deepEqual(validateOtaCommercialEvidence(legacy), {
		ok: true,
		errors: [],
	});

	const mislabeledCurrent = JSON.parse(JSON.stringify(legacy));
	mislabeledCurrent.contractVersion = 2;
	mislabeledCurrent.evidenceHash = hashOtaCommercialEvidence(mislabeledCurrent);
	assert.equal(validateOtaCommercialEvidence(mislabeledCurrent).ok, false);
	assert.ok(
		validateOtaCommercialEvidence(mislabeledCurrent).errors.includes(
			"gross_property_projection"
		)
	);

	const unsupported = JSON.parse(JSON.stringify(current));
	unsupported.contractVersion = 3;
	unsupported.evidenceHash = hashOtaCommercialEvidence(unsupported);
	assert.ok(
		validateOtaCommercialEvidence(unsupported).errors.includes("contract_version")
	);
});

test("authentication, provider, currency, and explicit-commission gates fail closed", () => {
	expectCode(
		() => buildAuthenticatedProviderCommercialEvidence(authenticatedInput({ sourceTrusted: false })),
		"SOURCE_NOT_AUTHENTICATED"
	);
	expectCode(
		() =>
			buildAuthenticatedProviderCommercialEvidence(
				authenticatedInput({ authenticatedProvider: "agoda" })
			),
		"PROVIDER_MISMATCH"
	);
	expectCode(
		() =>
			buildAuthenticatedProviderCommercialEvidence(
				authenticatedInput({ guestGross: { verified: true, amount: 10, currency: "EUR" } })
			),
		"CURRENCY_MISMATCH"
	);
	expectCode(
		() =>
			buildAuthenticatedProviderCommercialEvidence(
				authenticatedInput({
					explicitOtaCommission: { verified: true, amount: 10 },
				})
			),
		"EXPLICIT_COMMISSION_REQUIRED"
	);
});

test("HotelRunner amount cannot gain a role without explicit matching verified evidence", () => {
	const common = authenticatedInput({
		propertyCurrency: "USD",
		guestGross: { verified: true, amount: 146.46 },
		hotelRunnerReportedAmount: {
			amount: 146.46,
			currency: "USD",
			role: "guest_gross",
			provenance: {
				provider: "expedia",
				sourceType: "hotelrunner_api",
				sourceHash: HASH_B,
				sourceTimestamp: "2026-08-08T12:01:00.000Z",
				sourceId: "hr-amount-1",
			},
		},
	});
	expectCode(
		() => buildAuthenticatedProviderCommercialEvidence(common),
		"HOTELRUNNER_ROLE_NOT_EXPLICIT"
	);
	const evidence = buildAuthenticatedProviderCommercialEvidence({
		...common,
		hotelRunnerReportedAmount: {
			...common.hotelRunnerReportedAmount,
			explicitRoleAssignment: true,
		},
	});
	assert.equal(evidence.hotelRunnerReportedAmount.roleVerified, true);
});

test("strict validator rejects PII-shaped additions and rehashed unsafe projections", () => {
	const evidence = buildAuthenticatedProviderCommercialEvidence(
		authenticatedInput({ guestGross: { verified: true, amount: 146.46 } })
	);
	const withPii = JSON.parse(JSON.stringify(evidence));
	withPii.guestName = "not allowed";
	withPii.evidenceHash = hashOtaCommercialEvidence(withPii);
	assert.deepEqual(validateOtaCommercialEvidence(withPii), {
		ok: false,
		errors: ["contract_shape"],
	});

	const unsafe = JSON.parse(JSON.stringify(evidence));
	unsafe.roles.guestGross.propertyAmount = 549.23;
	unsafe.roles.guestGross.propertyCurrency = "SAR";
	unsafe.evidenceHash = hashOtaCommercialEvidence(unsafe);
	const validation = validateOtaCommercialEvidence(unsafe);
	assert.equal(validation.ok, false);
	assert.ok(validation.errors.includes("gross_unsafe_property_projection"));
});

test("source identifiers reject email addresses so the contract cannot retain obvious PII", () => {
	expectCode(
		() =>
			buildAuthenticatedProviderCommercialEvidence(
				authenticatedInput({ sourceId: "guest@example.com" })
			),
		"INVALID_SOURCE_ID"
	);
});
