/** @format */

"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const InboundEmail = require("../models/inbound_email");

const {
	ARCHIVE_START,
	CoverageAuditLimitError,
	buildArchiveCandidateFilter,
	buildCoverageReport,
	buildPipelineAnomalyFilter,
	buildReservationLookupFilter,
	buildReservationLookupFilters,
	groupCandidateArchives,
	isAuthenticatedNewArchive,
	loadCoverageInputs,
	loadIndexedReservationCandidates,
} = require("./otaInboundCoverageAudit20260813");
const {
	exitCodeForReport,
	main: cliMain,
	parseArgs,
} = require("../scripts/auditOtaInboundCoverage20260813");
const {
	buildMonitorState,
} = require("../scripts/ops/otaInboundCoverageMonitorState");

const AS_OF = new Date("2026-08-13T22:00:00.000Z");

function archive({
	provider,
	confirmationNumber,
	receivedAt,
	checkoutDate = "2026-08-20",
	intent = "new_reservation",
	eventType = "new",
	processingStatus = "needs_review",
	bookingSource = "",
	commercialProviders = [],
	authenticated = true,
	trustedProvider = provider,
	reservationMongoId = null,
	hasReservationConnection = false,
	bodyText = "PRIVATE BODY",
	guestName = "PRIVATE GUEST",
} = {}) {
	return {
		_id: `${provider}-${confirmationNumber}-${receivedAt}`,
		provider,
		confirmationNumber,
		receivedAt: new Date(receivedAt),
		intent,
		eventType,
		processingStatus,
		reservationMongoId,
		hasReservationConnection,
		from: "private@example.invalid",
		subject: "PRIVATE SUBJECT",
		bodyText,
		senderAuthentication: {
			authenticatedAligned: authenticated,
			trustedProvider,
		},
		normalizedReservation: {
			provider,
			confirmationNumber,
			checkoutDate,
			bookingSource,
			hotelRunnerCommercialSourceProviders: commercialProviders,
			guestName,
		},
	};
}

function hotelRunnerRelay(options = {}) {
	return archive({
		...options,
		provider: options.storedProvider || "hotelrunner",
		trustedProvider: "hotelrunner",
		bookingSource: options.bookingSource || options.otaProvider,
		commercialProviders: options.otaProvider ? [options.otaProvider] : [],
	});
}

function reservation({
	_id = "reservation-id",
	provider,
	confirmationNumber,
	identityField = "otaIdentityKey",
} = {}) {
	return {
		_id,
		[identityField]: `${provider}:${confirmationNumber}`,
		booking_source: provider,
		reservation_id: confirmationNumber,
		supplierData: {
			otaProvider: provider,
			otaConfirmationNumber: confirmationNumber,
		},
	};
}

test("all-time authenticated transport coverage surfaces the three current active identities only", () => {
	const creating = [
		archive({
			provider: "agoda",
			confirmationNumber: "689553735",
			receivedAt: "2026-08-13T21:13:17.712Z",
			checkoutDate: "2026-08-22",
		}),
		hotelRunnerRelay({
			otaProvider: "agoda",
			storedProvider: "agoda",
			confirmationNumber: "689553735",
			receivedAt: "2026-08-13T21:13:56.683Z",
			checkoutDate: "2026-08-22",
		}),
		archive({
			provider: "agoda",
			confirmationNumber: "689554695",
			receivedAt: "2026-08-13T21:16:48.917Z",
			checkoutDate: "2026-08-15",
		}),
		hotelRunnerRelay({
			otaProvider: "agoda",
			storedProvider: "agoda",
			confirmationNumber: "689554695",
			receivedAt: "2026-08-13T21:18:50.645Z",
			checkoutDate: "2026-08-15",
		}),
		archive({
			provider: "trip",
			confirmationNumber: "1567953939695657",
			receivedAt: "2026-08-08T19:31:29.694Z",
			checkoutDate: "2026-08-15",
		}),
		hotelRunnerRelay({
			otaProvider: "trip",
			confirmationNumber: "1567953939695657",
			receivedAt: "2026-08-08T19:31:50.672Z",
			checkoutDate: "2026-08-15",
		}),
		archive({
			provider: "hotelrunner",
			confirmationNumber: "R411331378",
			receivedAt: "2026-08-13T15:21:40.468Z",
			checkoutDate: "2026-11-12",
			bookingSource: "Direct Plus - Google",
		}),
		archive({
			provider: "trip",
			confirmationNumber: "1567953895146560",
			receivedAt: "2026-08-07T12:00:00.000Z",
			checkoutDate: "2026-08-08",
		}),
		archive({
			provider: "agoda",
			confirmationNumber: "represented-1",
			receivedAt: "2026-08-13T12:00:00.000Z",
			checkoutDate: "2026-08-20",
		}),
	];
	const cancellation = archive({
		provider: "hotelrunner",
		confirmationNumber: "R411331378",
		receivedAt: "2026-08-13T15:23:20.148Z",
		checkoutDate: "2026-11-12",
		intent: "reservation_status",
		eventType: "cancelled",
		processingStatus: "cancelled",
		bookingSource: "Direct Plus - Google",
	});
	const report = buildCoverageReport({
		creatingArchives: creating,
		lifecycleArchives: [...creating, cancellation],
		reservations: [
			reservation({
				provider: "agoda",
				confirmationNumber: "represented-1",
			}),
		],
		since: ARCHIVE_START,
		asOf: AS_OF,
	});

	assert.equal(report.readOnly, true);
	assert.equal(report.vendorCalls, false);
	assert.equal(report.summary.canonicalIdentityCount, 6);
	assert.equal(report.summary.representedIdentityCount, 1);
	assert.equal(report.summary.noReservationIdentityCount, 5);
	assert.equal(report.summary.activeNonterminalMissingCount, 3);
	assert.equal(report.summary.laterTerminalMissingCount, 1);
	assert.equal(report.summary.expiredMissingCount, 1);
	assert.equal(report.alert.active, true);
	assert.equal(report.alert.exitCode, 2);
	assert.deepEqual(
		report.missingIdentities
			.filter((item) => item.status === "active_nonterminal")
			.map((item) => `${item.provider}:${item.confirmationNumber}`)
			.sort(),
		[
			"agoda:689553735",
			"agoda:689554695",
			"trip:1567953939695657",
		]
	);
	const r411 = report.missingIdentities.find(
		(item) => item.confirmationNumber === "r411331378"
	);
	assert.equal(r411.status, "later_terminal");
	assert.equal(r411.reason, "later_cancelled_email");
	const serialized = JSON.stringify(report);
	for (const privateValue of [
		"PRIVATE BODY",
		"PRIVATE GUEST",
		"PRIVATE SUBJECT",
		"private@example.invalid",
	]) {
		assert.equal(serialized.includes(privateValue), false);
	}
});

test("HotelRunner relay collapses into the authenticated direct winner even without parsed booking source", () => {
	const direct = archive({
		provider: "trip",
		confirmationNumber: "same-id",
		receivedAt: "2026-08-13T10:00:00Z",
	});
	const relay = hotelRunnerRelay({
		confirmationNumber: "same-id",
		receivedAt: "2026-08-13T10:01:00Z",
		bookingSource: "Direct Plus - unparsed",
	});
	const { groups } = groupCandidateArchives([direct, relay]);
	assert.equal(groups.size, 1);
	const group = groups.get("trip:same-id");
	assert.ok(group);
	assert.deepEqual(Array.from(group.transportProviders).sort(), ["hotelrunner", "trip"]);
});

test("a terminal email before a later new reservation does not suppress an active miss", () => {
	const creating = archive({
		provider: "airbnb",
		confirmationNumber: "hm-reopened",
		receivedAt: "2026-08-13T10:00:00Z",
		checkoutDate: "2026-08-20",
	});
	const earlierCancellation = archive({
		provider: "airbnb",
		confirmationNumber: "hm-reopened",
		receivedAt: "2026-08-12T10:00:00Z",
		checkoutDate: "2026-08-20",
		intent: "reservation_status",
		eventType: "cancelled",
		processingStatus: "cancelled",
	});
	const report = buildCoverageReport({
		creatingArchives: [creating],
		lifecycleArchives: [earlierCancellation, creating],
		asOf: AS_OF,
	});
	assert.equal(report.summary.activeNonterminalMissingCount, 1);
	assert.equal(report.missingIdentities[0].reason, "future_stay_nonterminal");
});

test("untrusted candidate and untrusted cancellation cannot alter coverage", () => {
	const untrustedNew = archive({
		provider: "agoda",
		confirmationNumber: "forged-new",
		receivedAt: "2026-08-13T10:00:00Z",
		authenticated: false,
	});
	assert.equal(isAuthenticatedNewArchive(untrustedNew), false);
	const trustedNew = archive({
		provider: "agoda",
		confirmationNumber: "trusted-new",
		receivedAt: "2026-08-13T10:00:00Z",
	});
	const untrustedCancellation = archive({
		provider: "agoda",
		confirmationNumber: "trusted-new",
		receivedAt: "2026-08-13T11:00:00Z",
		intent: "reservation_status",
		eventType: "cancelled",
		processingStatus: "cancelled",
		authenticated: false,
	});
	const report = buildCoverageReport({
		creatingArchives: [untrustedNew, trustedNew],
		lifecycleArchives: [trustedNew, untrustedCancellation],
		asOf: AS_OF,
	});
	assert.equal(report.summary.authenticatedNewArchiveCount, 1);
	assert.equal(report.summary.activeNonterminalMissingCount, 1);
	assert.equal(report.summary.laterTerminalMissingCount, 0);
});

test("canonical, cross-transport, and indexed alias reservations represent an identity", () => {
	const creating = [
		archive({ provider: "agoda", confirmationNumber: "a-1", receivedAt: "2026-08-13T10:00:00Z" }),
		archive({ provider: "trip", confirmationNumber: "t-1", receivedAt: "2026-08-13T10:01:00Z" }),
		archive({ provider: "booking", confirmationNumber: "b-1", receivedAt: "2026-08-13T10:02:00Z" }),
	];
	const aliasReservation = {
		_id: "alias-reservation",
		booking_source: "booking.com",
		reservation_id: "b-1",
		supplierData: { otaProvider: "booking", otaConfirmationNumber: "b-1" },
	};
	const report = buildCoverageReport({
		creatingArchives: creating,
		lifecycleArchives: creating,
		reservations: [
			reservation({ provider: "agoda", confirmationNumber: "a-1" }),
			reservation({
				provider: "trip",
				confirmationNumber: "t-1",
				identityField: "otaCrossTransportIdentityKey",
			}),
			aliasReservation,
		],
		asOf: AS_OF,
	});
	assert.equal(report.summary.representedIdentityCount, 3);
	assert.equal(report.summary.noReservationIdentityCount, 0);
	assert.equal(report.alert.active, false);
});

test("provider and confirmation aliases cannot cross storage sections to synthesize an identity", () => {
	const malformed = {
		_id: "crossed-provider-confirmation-fields",
		reservation_id: "TRIP-A",
		booking_source: "agoda",
		supplierData: {
			otaConfirmationNumber: "AGODA-B",
			otaProvider: "trip",
		},
	};
	for (const [provider, confirmationNumber] of [
		["trip", "TRIP-A"],
		["agoda", "AGODA-B"],
	]) {
		const creating = archive({
			provider,
			confirmationNumber,
			receivedAt: "2026-08-13T10:00:00Z",
		});
		const report = buildCoverageReport({
			creatingArchives: [creating],
			lifecycleArchives: [creating],
			reservations: [malformed],
			asOf: AS_OF,
		});

		assert.equal(report.summary.representedIdentityCount, 0);
		assert.equal(report.summary.activeNonterminalMissingCount, 1);
		assert.equal(report.summary.integrityFlagIdentityCount, 1);
		assert.deepEqual(report.summary.integrityFlagCounts, {
			alias_provider_provenance_conflict: 1,
		});
		assert.deepEqual(report.missingIdentities[0].integrityFlags, [
			"alias_provider_provenance_conflict",
		]);
	}
});

test("field-local provenance preserves the two identities that are actually stored", () => {
	const reservationWithTwoProviders = {
		_id: "field-local-provider-confirmation-fields",
		reservation_id: "AGODA-A",
		booking_source: "agoda",
		supplierData: {
			otaConfirmationNumber: "TRIP-B",
			otaProvider: "trip",
		},
	};
	const creating = [
		archive({
			provider: "agoda",
			confirmationNumber: "AGODA-A",
			receivedAt: "2026-08-13T10:00:00Z",
		}),
		archive({
			provider: "trip",
			confirmationNumber: "TRIP-B",
			receivedAt: "2026-08-13T10:01:00Z",
		}),
	];
	const report = buildCoverageReport({
		creatingArchives: creating,
		lifecycleArchives: creating,
		reservations: [reservationWithTwoProviders],
		asOf: AS_OF,
	});

	assert.equal(report.summary.representedIdentityCount, 2);
	assert.equal(report.summary.noReservationIdentityCount, 0);
	assert.equal(report.summary.integrityFlagIdentityCount, 0);
});

test("a legacy alias remains valid when every provider signal is unambiguous", () => {
	const creating = archive({
		provider: "booking",
		confirmationNumber: "LEGACY-SUPPLIED-ID",
		receivedAt: "2026-08-13T10:00:00Z",
	});
	const report = buildCoverageReport({
		creatingArchives: [creating],
		lifecycleArchives: [creating],
		reservations: [
			{
				_id: "legacy-single-provider-alias",
				booking_source: "booking.com",
				supplierData: { suppliedBookingNo: "LEGACY-SUPPLIED-ID" },
			},
		],
		asOf: AS_OF,
	});

	assert.equal(report.summary.representedIdentityCount, 1);
	assert.equal(report.summary.noReservationIdentityCount, 0);
	assert.equal(report.summary.integrityFlagIdentityCount, 0);
});

test("provider-provenance diagnostics remain aggregate-only in monitor state", () => {
	const creating = archive({
		provider: "trip",
		confirmationNumber: "PRIVATE-TRIP-ALIAS",
		receivedAt: "2026-08-13T10:00:00Z",
	});
	const report = buildCoverageReport({
		creatingArchives: [creating],
		lifecycleArchives: [creating],
		reservations: [
			{
				_id: "private-crossed-reservation-id",
				reservation_id: "PRIVATE-TRIP-ALIAS",
				booking_source: "agoda",
				supplierData: {
					otaConfirmationNumber: "PRIVATE-AGODA-ALIAS",
					otaProvider: "trip",
				},
			},
		],
		asOf: AS_OF,
	});
	const state = buildMonitorState({
		report,
		auditExitCode: 2,
		mode: "recent",
	});

	assert.equal(state.integrityFlagIdentityCount, 1);
	assert.deepEqual(state.integrityFlagCounts, {
		alias_provider_provenance_conflict: 1,
	});
	const serialized = JSON.stringify(state);
	assert.equal(serialized.includes("PRIVATE-TRIP-ALIAS"), false);
	assert.equal(serialized.includes("PRIVATE-AGODA-ALIAS"), false);
	assert.equal(serialized.includes("private-crossed-reservation-id"), false);
});

test("an authenticated archive link cannot let a same-confirmation wrong-provider reservation hide a miss", () => {
	const creating = archive({
		provider: "agoda",
		confirmationNumber: "shared-provider-id",
		receivedAt: "2026-08-13T10:00:00Z",
		reservationMongoId: "wrong-provider-reservation",
		hasReservationConnection: true,
	});
	const wrongProvider = reservation({
		_id: "wrong-provider-reservation",
		provider: "trip",
		confirmationNumber: "shared-provider-id",
	});
	const report = buildCoverageReport({
		creatingArchives: [creating],
		lifecycleArchives: [creating],
		reservations: [wrongProvider],
		asOf: AS_OF,
	});

	assert.equal(report.summary.representedIdentityCount, 0);
	assert.equal(report.summary.activeNonterminalMissingCount, 1);
	assert.equal(report.summary.integrityFlagIdentityCount, 1);
	assert.equal(
		report.summary.integrityFlagCounts.linked_reservation_provider_mismatch,
		1
	);
	assert.equal(
		report.summary.integrityFlagCounts
			.linked_reservation_stored_identity_conflict,
		1
	);
	assert.deepEqual(report.missingIdentities[0].integrityFlags, [
		"linked_reservation_provider_mismatch",
		"linked_reservation_stored_identity_conflict",
	]);
});

test("conflicting canonical or cross-transport provider keys cannot make a same-confirmation alias look represented", () => {
	for (const identityField of [
		"otaIdentityKey",
		"otaCrossTransportIdentityKey",
	]) {
		for (const linked of [false, true]) {
			const reservationId = `${identityField}-${linked ? "linked" : "alias"}`;
			const creating = archive({
				provider: "agoda",
				confirmationNumber: "shared-provider-key",
				receivedAt: "2026-08-13T10:00:00Z",
				reservationMongoId: linked ? reservationId : null,
				hasReservationConnection: linked,
			});
			const conflicting = {
				_id: reservationId,
				[identityField]: "trip:shared-provider-key",
				booking_source: "agoda",
				reservation_id: "shared-provider-key",
				customer_details: {
					confirmation_number2: "shared-provider-key",
				},
				supplierData: {
					otaProvider: "agoda",
					otaConfirmationNumber: "shared-provider-key",
				},
			};
			const report = buildCoverageReport({
				creatingArchives: [creating],
				lifecycleArchives: [creating],
				reservations: [conflicting],
				asOf: AS_OF,
			});

			assert.equal(
				report.summary.representedIdentityCount,
				0,
				`${identityField} ${linked ? "archive link" : "indexed alias"}`
			);
			assert.equal(report.summary.activeNonterminalMissingCount, 1);
			assert.equal(report.summary.integrityFlagIdentityCount, 1);
			assert.equal(
				report.summary.integrityFlagCounts
					.alias_candidate_stored_identity_conflict,
				1
			);
			const expectedFlags = ["alias_candidate_stored_identity_conflict"];
			if (linked) {
				expectedFlags.push("linked_reservation_stored_identity_conflict");
				assert.equal(
					report.summary.integrityFlagCounts
						.linked_reservation_stored_identity_conflict,
					1
				);
			}
			assert.deepEqual(report.missingIdentities[0].integrityFlags, expectedFlags);
		}
	}
});

test("the intentional HotelRunner-to-Trip cross-transport pair still represents the direct Trip identity", () => {
	const creating = archive({
		provider: "trip",
		confirmationNumber: "trip-cross-transport",
		receivedAt: "2026-08-13T10:00:00Z",
	});
	const report = buildCoverageReport({
		creatingArchives: [creating],
		lifecycleArchives: [creating],
		reservations: [
			{
				_id: "legitimate-trip-cross-transport",
				otaIdentityKey: "hotelrunner:trip-cross-transport",
				otaCrossTransportIdentityKey: "trip:trip-cross-transport",
				booking_source: "trip",
				reservation_id: "trip-cross-transport",
				supplierData: {
					otaProvider: "trip",
					otaConfirmationNumber: "trip-cross-transport",
				},
			},
		],
		asOf: AS_OF,
	});

	assert.equal(report.summary.representedIdentityCount, 1);
	assert.equal(report.summary.activeNonterminalMissingCount, 0);
});

test("reversed or incomplete HotelRunner-to-Trip key fields are not treated as a valid bridge", () => {
	for (const provider of ["trip", "hotelrunner"]) {
		const creating = archive({
			provider,
			confirmationNumber: "reversed-trip-bridge",
			receivedAt: "2026-08-13T10:00:00Z",
		});
		const report = buildCoverageReport({
			creatingArchives: [creating],
			lifecycleArchives: [creating],
			reservations: [
				{
					_id: `reversed-${provider}`,
					otaIdentityKey: "trip:reversed-trip-bridge",
					otaCrossTransportIdentityKey:
						"hotelrunner:reversed-trip-bridge",
					booking_source: provider,
					reservation_id: "reversed-trip-bridge",
					supplierData: {
						otaProvider: provider,
						otaConfirmationNumber: "reversed-trip-bridge",
					},
				},
			],
			asOf: AS_OF,
		});

		assert.equal(report.summary.representedIdentityCount, 0, provider);
		assert.equal(report.summary.activeNonterminalMissingCount, 1, provider);
		assert.equal(
			report.summary.integrityFlagCounts
				.alias_candidate_stored_identity_conflict,
			1,
			provider
		);
	}
});

test("archive-link integrity flags include represented identities", () => {
	const creating = archive({
		provider: "agoda",
		confirmationNumber: "represented-integrity-id",
		receivedAt: "2026-08-13T10:00:00Z",
		hasReservationConnection: true,
		reservationMongoId: null,
	});
	const report = buildCoverageReport({
		creatingArchives: [creating],
		lifecycleArchives: [creating],
		reservations: [
			reservation({
				provider: "agoda",
				confirmationNumber: "represented-integrity-id",
			}),
		],
		asOf: AS_OF,
	});

	assert.equal(report.summary.representedIdentityCount, 1);
	assert.equal(report.summary.noReservationIdentityCount, 0);
	assert.equal(report.summary.integrityFlagIdentityCount, 1);
	assert.equal(
		report.summary.integrityFlagCounts.reservation_connection_without_id,
		1
	);
});

test("stale or failed authenticated deliveries without a canonical identity alert without exposing PII", () => {
	const pipelineArchives = [
		archive({
			provider: "",
			confirmationNumber: "",
			intent: "",
			processingStatus: "received",
			trustedProvider: "agoda",
			receivedAt: "2026-08-13T21:00:00Z",
		}),
		archive({
			provider: "",
			confirmationNumber: "",
			intent: "",
			processingStatus: "failed",
			trustedProvider: "trip",
			receivedAt: "2026-08-13T21:10:00Z",
		}),
		archive({
			provider: "agoda",
			confirmationNumber: "",
			intent: "new_reservation",
			processingStatus: "needs_review",
			receivedAt: "2026-08-13T21:20:00Z",
		}),
		// A currently leased delivery is not called stranded yet.
		archive({
			provider: "",
			confirmationNumber: "",
			intent: "",
			processingStatus: "received",
			trustedProvider: "booking",
			receivedAt: "2026-08-13T21:59:00Z",
		}),
		// Explicit non-reservation intents are outside reservation coverage.
		archive({
			provider: "agoda",
			confirmationNumber: "",
			intent: "guest_message",
			processingStatus: "needs_review",
			receivedAt: "2026-08-13T21:00:00Z",
		}),
	];
	const report = buildCoverageReport({
		pipelineArchives,
		asOf: AS_OF,
	});

	assert.equal(report.summary.incompletePipelineArchiveCount, 3);
	assert.deepEqual(report.summary.pipelineProcessingStatusCounts, {
		failed: 1,
		needs_review: 1,
		received: 1,
	});
	assert.equal(report.alert.active, true);
	assert.equal(report.alert.activeIdentityCount, 0);
	assert.equal(report.alert.incompletePipelineArchiveCount, 3);
	assert.equal(report.alert.activeIssueCount, 3);
	assert.equal(report.alert.exitCode, 2);
	const serialized = JSON.stringify(report);
	for (const privateValue of [
		"PRIVATE BODY",
		"PRIVATE GUEST",
		"PRIVATE SUBJECT",
		"private@example.invalid",
	]) {
		assert.equal(serialized.includes(privateValue), false);
	}
});

test("the bounded loader retains stranded pipeline deliveries even when no canonical groups exist", async () => {
	const stale = archive({
		provider: "",
		confirmationNumber: "",
		intent: "",
		processingStatus: "received",
		trustedProvider: "agoda",
		receivedAt: "2026-08-13T21:00:00Z",
	});
	const filters = [];
	const results = [[], [stale]];
	const queryResult = (value) => ({
		select() {
			return this;
		},
		sort() {
			return this;
		},
		limit() {
			return this;
		},
		lean() {
			return this;
		},
		exec: async () => value,
	});
	const inputs = await loadCoverageInputs({
		InboundEmailModel: {
			find(filter) {
				filters.push(filter);
				return queryResult(results.shift() || []);
			},
		},
		ReservationModel: {
			find() {
				throw new Error("reservations must not load without canonical groups");
			},
		},
		since: ARCHIVE_START,
		asOf: AS_OF,
	});

	assert.equal(filters.length, 2);
	assert.equal(inputs.creatingArchives.length, 0);
	assert.equal(inputs.pipelineArchives.length, 1);
	assert.equal(inputs.queryStats.pipelineArchivesRead, 1);
	const report = buildCoverageReport({ ...inputs, asOf: AS_OF });
	assert.equal(report.alert.active, true);
	assert.equal(report.alert.incompletePipelineArchiveCount, 1);
});

test("a normalized authenticated new identity remains covered while top-level identity fields are partially finalized", () => {
	const partiallyFinalized = archive({
		provider: "",
		confirmationNumber: "",
		intent: "",
		trustedProvider: "agoda",
		receivedAt: "2026-08-13T21:45:00Z",
	});
	partiallyFinalized.normalizedReservation = {
		provider: "agoda",
		intent: "new_reservation",
		confirmationNumber: "partial-identity-1",
		checkoutDate: "2026-08-20",
		guestName: "PRIVATE GUEST",
	};

	assert.equal(isAuthenticatedNewArchive(partiallyFinalized), true);
	const report = buildCoverageReport({
		creatingArchives: [partiallyFinalized],
		lifecycleArchives: [partiallyFinalized],
		asOf: AS_OF,
	});
	assert.equal(report.summary.canonicalIdentityCount, 1);
	assert.equal(report.summary.activeNonterminalMissingCount, 1);
	assert.equal(report.missingIdentities[0].provider, "agoda");
	assert.equal(
		report.missingIdentities[0].confirmationNumber,
		"partial-identity-1"
	);
	assert.equal(JSON.stringify(report).includes("PRIVATE GUEST"), false);
});

test("alertFingerprint is stable across audit time and age changes but changes with the active issue set", () => {
	const missing = archive({
		provider: "agoda",
		confirmationNumber: "stable-alert-id",
		receivedAt: "2026-08-10T10:00:00Z",
		checkoutDate: "2026-08-20",
	});
	const pipeline = archive({
		provider: "",
		confirmationNumber: "",
		intent: "",
		processingStatus: "failed",
		trustedProvider: "trip",
		receivedAt: "2026-08-13T20:00:00Z",
	});
	const first = buildCoverageReport({
		creatingArchives: [missing],
		lifecycleArchives: [missing],
		pipelineArchives: [pipeline],
		asOf: AS_OF,
	});
	const later = buildCoverageReport({
		creatingArchives: [missing],
		lifecycleArchives: [missing],
		pipelineArchives: [
			{ ...pipeline, processingStatus: "needs_review" },
		],
		asOf: new Date("2026-08-15T22:00:00.000Z"),
	});

	assert.match(first.alertFingerprint, /^[a-f0-9]{64}$/);
	assert.equal(first.alert.fingerprint, first.alertFingerprint);
	assert.equal(first.alertFingerprint, later.alertFingerprint);
	assert.notEqual(first.cacheKey, later.cacheKey);

	const additional = archive({
		provider: "booking",
		confirmationNumber: "new-alert-id",
		receivedAt: "2026-08-13T21:00:00Z",
		checkoutDate: "2026-08-21",
	});
	const changed = buildCoverageReport({
		creatingArchives: [missing, additional],
		lifecycleArchives: [missing, additional],
		pipelineArchives: [pipeline],
		asOf: AS_OF,
	});
	assert.notEqual(changed.alertFingerprint, first.alertFingerprint);
});

test("recurring monitor state keeps only aggregate PII-free alert data", () => {
	const missing = archive({
		provider: "agoda",
		confirmationNumber: "must-not-enter-monitor-state",
		receivedAt: "2026-08-13T20:00:00Z",
		checkoutDate: "2026-08-20",
	});
	const report = buildCoverageReport({
		creatingArchives: [missing],
		lifecycleArchives: [missing],
		asOf: AS_OF,
	});
	const first = buildMonitorState({
		report,
		auditExitCode: 2,
		mode: "recent",
	});
	const repeated = buildMonitorState({
		report,
		auditExitCode: 2,
		mode: "recent",
		previous: first,
	});

	assert.equal(first.status, "alert");
	assert.equal(first.transition, "alert_new");
	assert.equal(repeated.transition, "alert_unchanged");
	assert.deepEqual(first.activeProviderCounts, { agoda: 1 });
	assert.deepEqual(first.activeReasonCounts, { future_stay_nonterminal: 1 });
	const serialized = JSON.stringify(first);
	for (const privateValue of [
		"must-not-enter-monitor-state",
		"PRIVATE BODY",
		"PRIVATE GUEST",
		"PRIVATE SUBJECT",
		"private@example.invalid",
	]) {
		assert.equal(serialized.includes(privateValue), false);
	}

	const errorState = buildMonitorState({
		auditExitCode: 1,
		mode: "full",
		errorCode: "audit_timeout private@example.invalid",
		previous: first,
	});
	assert.equal(errorState.status, "error");
	assert.equal(errorState.transition, "audit_error");
	assert.equal(errorState.errorCode, "coverage_audit_failed");
	assert.equal(JSON.stringify(errorState).includes("private"), false);
});

test("recurring monitor state preserves only aggregate stored-identity conflict diagnostics", () => {
	const creating = archive({
		provider: "agoda",
		confirmationNumber: "private-conflicting-confirmation",
		receivedAt: "2026-08-13T20:00:00Z",
		checkoutDate: "2026-08-20",
		reservationMongoId: "conflicting-linked-reservation",
		hasReservationConnection: true,
	});
	const conflicting = {
		_id: "conflicting-linked-reservation",
		otaIdentityKey: "trip:private-conflicting-confirmation",
		booking_source: "agoda",
		reservation_id: "private-conflicting-confirmation",
		supplierData: {
			otaProvider: "agoda",
			otaConfirmationNumber: "private-conflicting-confirmation",
		},
	};
	const report = buildCoverageReport({
		creatingArchives: [creating],
		lifecycleArchives: [creating],
		reservations: [conflicting],
		asOf: AS_OF,
	});
	const state = buildMonitorState({
		report,
		auditExitCode: 2,
		mode: "recent",
	});

	assert.equal(state.integrityFlagIdentityCount, 1);
	assert.deepEqual(state.integrityFlagCounts, {
		alias_candidate_stored_identity_conflict: 1,
		linked_reservation_stored_identity_conflict: 1,
	});
	const serialized = JSON.stringify(state);
	assert.equal(serialized.includes("private-conflicting-confirmation"), false);
	assert.equal(serialized.includes("conflicting-linked-reservation"), false);
});

test("indexed Reservation lookups are separate, bounded, and deduplicated under one unique limit", async () => {
	const creating = archive({
		provider: "agoda",
		confirmationNumber: "indexed-loader-id",
		receivedAt: "2026-08-13T10:00:00Z",
	});
	const { groups } = groupCandidateArchives([creating]);
	const found = reservation({
		_id: "shared-reservation-id",
		provider: "agoda",
		confirmationNumber: "indexed-loader-id",
	});
	const filters = [];
	let sortCalls = 0;
	const resultForFilter = (filter) => {
		const field = Object.keys(filter)[0];
		return ["otaIdentityKey", "reservation_id"].includes(field) ? [found] : [];
	};
	const ReservationModel = {
		find(filter) {
			filters.push(filter);
			const value = resultForFilter(filter);
			return {
				select() {
					return this;
				},
				sort() {
					sortCalls += 1;
					return this;
				},
				limit() {
					return this;
				},
				lean() {
					return this;
				},
				exec: async () => value,
			};
		},
	};
	const loaded = await loadIndexedReservationCandidates(
		ReservationModel,
		groups,
		{ maxReservations: 10 }
	);

	assert.equal(filters.length, 7);
	assert.equal(sortCalls, 0);
	assert.equal(loaded.queryCount, 7);
	assert.equal(loaded.rowsRead, 2);
	assert.equal(loaded.reservations.length, 1);
	assert.equal(loaded.reservations[0]._id, "shared-reservation-id");
	for (const filter of filters) assert.equal(Object.keys(filter).length, 1);

	const overflowingModel = {
		find() {
			return {
				select() {
					return this;
				},
				limit() {
					return this;
				},
				lean() {
					return this;
				},
				exec: async () => [
					{ ...found, _id: "one" },
					{ ...found, _id: "two" },
				],
			};
		},
	};
	await assert.rejects(
		loadIndexedReservationCandidates(overflowingModel, groups, {
			maxReservations: 1,
		}),
		(error) =>
			error instanceof CoverageAuditLimitError &&
			error.code === "OTA_COVERAGE_RESERVATION_LIMIT"
	);
});

test("database filters are bounded by time and use indexed reservation identities/aliases", () => {
	const candidateFilter = buildArchiveCandidateFilter({
		since: ARCHIVE_START,
		asOf: AS_OF,
	});
	assert.deepEqual(candidateFilter.$or, [
		{ intent: "new_reservation" },
		{ "normalizedReservation.intent": "new_reservation" },
	]);
	assert.equal(candidateFilter.receivedAt.$gte.toISOString(), ARCHIVE_START.toISOString());
	assert.equal(candidateFilter.receivedAt.$lte.toISOString(), AS_OF.toISOString());
	assert.equal(candidateFilter["senderAuthentication.authenticatedAligned"], true);
	const authenticatedReceivedAtIndex = InboundEmail.schema
		.indexes()
		.find(([, options]) => options?.name === "inbound_authenticated_received_at");
	assert.deepEqual(authenticatedReceivedAtIndex?.[0], {
		"senderAuthentication.authenticatedAligned": 1,
		receivedAt: -1,
		_id: -1,
	});
	const pipelineFilter = buildPipelineAnomalyFilter({
		since: ARCHIVE_START,
		asOf: AS_OF,
		leaseMs: 30 * 60 * 1000,
	});
	assert.equal(
		pipelineFilter["senderAuthentication.authenticatedAligned"],
		true
	);
	assert.equal(pipelineFilter.$or[0].processingStatus.$in.includes("failed"), true);
	assert.equal(pipelineFilter.$or[1].processingStatus, "received");
	assert.equal(
		pipelineFilter.$or[1].receivedAt.$lte.toISOString(),
		"2026-08-13T21:30:00.000Z"
	);

	const { groups } = groupCandidateArchives([
		archive({
			provider: "agoda",
			confirmationNumber: "indexed-id",
			receivedAt: "2026-08-13T10:00:00Z",
		}),
	]);
	const lookup = buildReservationLookupFilter(groups);
	const indexedLookups = buildReservationLookupFilters(groups);
	assert.deepEqual(lookup.$or, indexedLookups);
	assert.equal(indexedLookups[0].otaIdentityKey.$type, "string");
	assert.equal(indexedLookups[0].otaIdentityKey.$gt, "");
	assert.equal(
		indexedLookups[1].otaCrossTransportIdentityKey.$type,
		"string"
	);
	const fields = lookup.$or.map((branch) => Object.keys(branch)[0]);
	for (const indexedField of [
		"otaIdentityKey",
		"otaCrossTransportIdentityKey",
		"reservation_id",
		"customer_details.confirmation_number2",
		"supplierData.suppliedBookingNo",
		"supplierData.otaConfirmationNumber",
		"supplierData.platformConfirmationNumber",
	]) {
		assert.ok(fields.includes(indexedField), indexedField);
	}
});

test("CLI has explicit alert exit semantics and emits only the sanitized service report", async () => {
	const parsed = parseArgs([
		"--since=2026-05-12T00:00:00.000Z",
		"--as-of=2026-08-13T22:00:00.000Z",
	]);
	assert.equal(parsed.since.toISOString(), ARCHIVE_START.toISOString());
	assert.equal(parsed.asOf.toISOString(), AS_OF.toISOString());
	assert.equal(exitCodeForReport({ alert: { active: false } }), 0);
	assert.equal(exitCodeForReport({ alert: { active: true } }), 2);

	let output = "";
	const report = {
		readOnly: true,
		missingIdentities: [
			{ provider: "agoda", confirmationNumber: "safe-id", status: "active_nonterminal" },
		],
		alert: { active: true },
	};
	const exitCode = await cliMain(
		["--as-of=2026-08-13T22:00:00.000Z"],
		{
			skipConnect: true,
			audit: async () => report,
			write: (value) => {
				output += value;
			},
		}
	);
	assert.equal(exitCode, 2);
	assert.deepEqual(JSON.parse(output), report);
});
