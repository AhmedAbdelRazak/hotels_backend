/** @format */

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
	AUDIT_DAY_END,
	AUDIT_DAY_START,
	EXACT_TARGETS,
	MANIFEST_COLLECTION,
	REPAIR_ID,
	agodaEventResolutionUpdate,
	agodaMirrorResolutionUpdate,
	agodaReservationBackfillUpdate,
	applyScope,
	assertBridge,
	assertExactEvent,
	assertOperationalScope,
	assertManifestTargetResumeSafe,
	commercialBackfillSet,
	eventCasFilter,
	exactEventFilter,
	exactReservationFilter,
	immutablePlanHash,
	immutableScopeEntry,
	loadTargetScope,
	manifestDocument,
	mirrorCasFilter,
	mirrorResolutionSatisfied,
	parseArguments,
	repairSnapshot,
	reservationBackfillSatisfied,
	reservationCasFilter,
	sanitizedPlan,
	targetRepairState,
	tripRequeueUpdate,
} = require("./reconcileHotelRunnerPriorityCommission20260807");

const HOTEL_ID = "6a40b6a1a6efe70450536038";
const RESERVATION_ID = "6a75f93d8e82560c40d64281";
const NOW = new Date("2026-08-07T19:00:00.000Z");

const targetByKey = (key) => EXACT_TARGETS.find((target) => target.key === key);
const agodaTarget = () => targetByKey("agoda_1");
const tripTarget = () => targetByKey("trip_1");

const clone = (value) => {
	if (value instanceof Date) return new Date(value);
	if (Array.isArray(value)) return value.map(clone);
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
	}
	return value;
};

const evidenceFixture = (target = agodaTarget()) => ({
	version: 1,
	verified: true,
	source: "authenticated_ota_email",
	provider: "agoda",
	otaIdentityKey: `agoda:${target.providerNumber}`,
	grossTotalSar: 95.06,
	payoutTotalSar: 58.82,
	otaExpenseTotalSar: 36.24,
	currency: "SAR",
	sourceReceivedAt: "2026-08-07T15:32:00.000Z",
	appliedAt: NOW,
	evidenceHash: "b".repeat(64),
});

function eventFixture(target, overrides = {}) {
	const trip = target.provider === "trip";
	return {
		_id: `event-${target.key}`,
		hotelId: HOTEL_ID,
		source: "push",
		hotelRunnerReservationId: target.hotelRunnerReservationId,
		hrNumber: target.hrNumber,
		providerNumber: target.providerNumber,
		payloadHash: "a".repeat(64),
		canonicalHash: "c".repeat(64),
		sourceUpdatedAt: new Date("2026-08-07T15:33:00.000Z"),
		receivedAt: new Date("2026-08-07T15:33:01.000Z"),
		status: trip ? "quarantined" : target.cancelled ? "completed" : "attention",
		attempts: 1,
		nextAttemptAt: NOW,
		leaseOwner: "",
		leaseUntil: null,
		integrityConflict: false,
		integrityReason: "",
		errorCode: trip
			? "hotelrunner_currency_requires_review"
			: target.cancelled
				? ""
				: "hotelrunner_commercial_evidence_stale",
		errorMessage: "",
		processedAt: NOW,
		result: trip
			? { status: "quarantined", code: "hotelrunner_currency_requires_review" }
			: {
					status: target.cancelled ? "cancelled" : "updated",
					commercialEvidenceStale: !target.cancelled,
					attentionCode: target.cancelled
						? ""
						: "hotelrunner_commercial_evidence_stale",
			  },
		payload: {
			hotelRunnerReservationId: target.hotelRunnerReservationId,
			hrNumber: target.hrNumber,
			providerNumber: target.providerNumber,
			channel: trip ? "tripcom" : "agoda",
			channelDisplay: trip ? "Trip.com V2" : "Agoda",
			state: target.cancelled ? "canceled" : "reserved",
			currency: trip ? "USD" : "SAR",
			totalCents: trip ? 1878 : 5882,
			totalRooms: 1,
			checkinDate: "2026-08-08",
			checkoutDate: "2026-08-09",
			rooms: [{}],
			issues: [],
		},
		...overrides,
	};
}

function reservationFixture(target, overrides = {}) {
	const direct = target.action === "agoda_backfill";
	return {
		_id: RESERVATION_ID,
		__v: 4,
		hotelId: HOTEL_ID,
		otaIdentityKey: `${target.provider}:${target.providerNumber}`,
		otaCrossTransportIdentityKey:
			target.provider === "trip" ? `trip:${target.providerNumber}` : "",
		commission: direct ? 15 : 0,
		commission_ota: null,
		state: target.cancelled ? "canceled" : "ota platform review",
		reservation_status: target.cancelled ? "canceled" : "ota platform review",
		checkin_date: new Date("2026-08-08T00:00:00.000Z"),
		checkout_date: new Date("2026-08-09T00:00:00.000Z"),
		total_rooms: 1,
		adminPricing: {
			clientTotal: 95.06,
			netAfterExpensesTotal: 58.82,
			otaExpenseTotal: 36.24,
			defaultDeductionApplied: false,
			commercialVerified: false,
			payoutFallbackReason: "hotelrunner_commercial_evidence_stale",
		},
		ota_financial_summary: {
			show: false,
			clientTotal: 95.06,
			netAfterExpenses: 58.82,
			netAfterOtaExpenses: 58.82,
			otaExpenseTotal: 36.24,
			commercialVerified: false,
			payoutFallbackReason: "hotelrunner_commercial_evidence_stale",
		},
		supplierData: {
			otaLastInboundEmailId: "inbound-1",
			otaTotalPayoutSar: 58.82,
			otaExpenseTotalSar: 36.24,
			otaPayoutFallbackReason: "hotelrunner_commercial_evidence_stale",
			hotelRunner: direct
				? {
						transport: "hotelrunner_api",
						reservationId: target.hotelRunnerReservationId,
				  }
				: undefined,
		},
		reservationAuditLog: [],
		...overrides,
	};
}

function mirrorFixture(target, overrides = {}) {
	return {
		_id: `mirror-${target.key}`,
		__v: 2,
		hotelId: HOTEL_ID,
		hotelRunnerReservationId: target.hotelRunnerReservationId,
		hrNumber: target.hrNumber,
		providerNumber: target.providerNumber,
		reservationMongoId: RESERVATION_ID,
		projectionVersion: 3,
		projectionStatus: target.cancelled ? "cancelled" : "updated",
		observedCanonicalHash: "c".repeat(64),
		appliedCanonicalHash:
			target.action === "trip_requeue" ? "" : "d".repeat(64),
		identityConflict: false,
		lastErrorCode:
			target.action === "agoda_backfill" && !target.cancelled
				? "hotelrunner_commercial_evidence_stale"
				: "",
		lastErrorMessage:
			target.action === "agoda_backfill" && !target.cancelled
				? "commercial evidence needs review"
				: "",
		lastResult: {
			commercialEvidenceStale:
				target.action === "agoda_backfill" && !target.cancelled,
			attentionCode:
				target.action === "agoda_backfill" && !target.cancelled
					? "hotelrunner_commercial_evidence_stale"
					: "",
		},
		...overrides,
	};
}

function scopeFixture(target, overrides = {}) {
	const bridge =
		target.action === "agoda_backfill"
			? {
					ok: true,
					amountRole: "payout",
					evidence: evidenceFixture(target),
			  }
			: {
					ok: true,
					amountRole: "gross",
					evidence: null,
			  };
	const reservation = reservationFixture(target);
	const financialSet = bridge.evidence
		? commercialBackfillSet(bridge.evidence)
		: null;
	const scope = {
		target,
		event: eventFixture(target),
		mirror: mirrorFixture(target),
		reservation,
		bridge,
		financialSet,
		...overrides,
	};
	scope.repairState = targetRepairState(scope);
	scope.before = repairSnapshot(scope);
	return scope;
}

function applyMongoUpdate(document, update) {
	const setPath = (pathText, value) => {
		const parts = pathText.split(".");
		let current = document;
		for (let index = 0; index < parts.length - 1; index += 1) {
			current[parts[index]] ||= {};
			current = current[parts[index]];
		}
		current[parts.at(-1)] = clone(value);
	};
	for (const [pathText, value] of Object.entries(update.$set || {})) {
		setPath(pathText, value);
	}
	for (const pathText of Object.keys(update.$unset || {})) {
		const parts = pathText.split(".");
		let current = document;
		for (const key of parts.slice(0, -1)) current = current?.[key];
		if (current) delete current[parts.at(-1)];
	}
	for (const [pathText, value] of Object.entries(update.$inc || {})) {
		setPath(pathText, Number(pathValue(document, pathText) || 0) + Number(value));
	}
	for (const [pathText, value] of Object.entries(update.$push || {})) {
		const current = pathValue(document, pathText) || [];
		setPath(pathText, [...current, clone(value)]);
	}
}

const pathValue = (document, pathText) =>
	pathText.split(".").reduce((current, key) => current?.[key], document);

function mutableModel(document) {
	return {
		findOne() {
			return {
				lean() {
					return this;
				},
				exec: async () => clone(document),
			};
		},
		updateOne(_filter, update) {
			return {
				exec: async () => {
					applyMongoUpdate(document, update);
					return { matchedCount: 1, modifiedCount: 1 };
				},
			};
		},
	};
}

function findModel(documents) {
	return {
		find() {
			let limited = documents;
			return {
				select() {
					return this;
				},
				limit(value) {
					limited = documents.slice(0, value);
					return this;
				},
				lean() {
					return this;
				},
				exec: async () => clone(limited),
			};
		},
	};
}

test("the immutable scope is exactly four Trip and four Agoda audited pushes", () => {
	assert.equal(EXACT_TARGETS.length, 8);
	assert.equal(EXACT_TARGETS.filter((target) => target.action === "trip_requeue").length, 4);
	assert.equal(EXACT_TARGETS.filter((target) => target.action === "agoda_backfill").length, 4);
	assert.equal(EXACT_TARGETS.filter((target) => target.cancelled).length, 1);
	assert.equal(
		new Set(
			EXACT_TARGETS.map((target) =>
				[target.hotelRunnerReservationId, target.hrNumber, target.providerNumber].join(":")
			)
		).size,
		8
	);
	assert.deepEqual(
		EXACT_TARGETS.map((target) => target.hrNumber).sort(),
		[
			"R064683472",
			"R071469597",
			"R282107190",
			"R583676061",
			"R820693493",
			"R932599996",
			"R975197182",
			"R990965712",
		]
	);
});

test("CLI is dry-run by default and apply requires the exact immutable repair ID", () => {
	assert.deepEqual(parseArguments([]), { apply: false, repairId: "" });
	assert.deepEqual(
		parseArguments(["--apply", `--repair-id=${REPAIR_ID}`]),
		{ apply: true, repairId: REPAIR_ID }
	);
	assert.throws(() => parseArguments(["--apply"]), /exact immutable repair ID/);
	assert.throws(
		() => parseArguments(["--apply", "--repair-id=wrong"]),
		/exact immutable repair ID/
	);
	assert.throws(() => parseArguments([`--repair-id=${REPAIR_ID}`]), /only with --apply/);
	assert.throws(() => parseArguments(["--target=all"]), /Unsupported/);
});

test("every event query is fenced by exact HR/provider IDs, push transport, and the audit day", () => {
	for (const target of EXACT_TARGETS) {
		const filter = exactEventFilter(target, HOTEL_ID);
		assert.equal(filter.hotelId, HOTEL_ID);
		assert.equal(filter.source, "push");
		assert.equal(filter.hotelRunnerReservationId, target.hotelRunnerReservationId);
		assert.equal(filter.hrNumber, target.hrNumber);
		assert.equal(filter.providerNumber, target.providerNumber);
		assert.equal(filter.sourceUpdatedAt.$gte, AUDIT_DAY_START);
		assert.equal(filter.sourceUpdatedAt.$lt, AUDIT_DAY_END);
		assert.equal(filter.receivedAt.$gte, AUDIT_DAY_START);
		assert.equal(filter.receivedAt.$lt, AUDIT_DAY_END);
	}
});

test("stored provider proof accepts the production machine channel and rejects a recognized contradiction", () => {
	const target = tripTarget();
	const event = eventFixture(target);
	assert.equal(assertExactEvent(target, event).channel, "tripcom");
	assert.throws(
		() =>
			assertExactEvent(target, {
				...event,
				payload: { ...event.payload, channelDisplay: "Agoda" },
			}),
		/stored payload identity differs/
	);
});

test("reservation lookup can only resolve the target direct ID or exact OTA identity", () => {
	const target = tripTarget();
	const filter = exactReservationFilter(target, HOTEL_ID);
	assert.equal(filter.hotelId, HOTEL_ID);
	assert.deepEqual(filter.$or, [
		{ "supplierData.hotelRunner.reservationId": target.hotelRunnerReservationId },
		{ otaIdentityKey: `trip:${target.providerNumber}` },
		{ otaCrossTransportIdentityKey: `trip:${target.providerNumber}` },
	]);
});

test("operational gate is permanently scoped to active Zad Ajyad and closed outbound features", () => {
	const config = {
		configured: true,
		callbackConfigured: true,
		hotelId: HOTEL_ID,
		projectionEnabled: true,
		pullEnabled: false,
		roomListSyncEnabled: false,
		confirmDeliveryEnabled: false,
		requireOtaReview: true,
	};
	const hotel = {
		_id: HOTEL_ID,
		hotelName: "Zad Ajyad",
		activateHotel: true,
		xHotelProActive: true,
	};
	assert.equal(assertOperationalScope(config, hotel, { apply: true }), true);
	assert.throws(
		() => assertOperationalScope({ ...config, pullEnabled: true }, hotel, { apply: true }),
		/Pull, room\/calendar/
	);
	assert.throws(
		() => assertOperationalScope(config, { ...hotel, hotelName: "Another Hotel" }, { apply: true }),
		/permanently scoped/
	);
});

test("Trip bridge is accepted only as exact gross evidence and never invents commission_ota", () => {
	const target = tripTarget();
	assert.equal(
		assertBridge(target, { ok: true, amountRole: "gross", evidence: null }),
		true
	);
	assert.throws(
		() => assertBridge(target, {
			ok: true,
			amountRole: "gross",
			evidence: evidenceFixture(agodaTarget()),
		}),
		/no invented OTA commission/
	);
	assert.throws(
		() => assertBridge(target, { ok: false, reason: "source_not_authenticated" }),
		/authenticated OTA-email bridge rejected/
	);
});

test("Agoda bridge requires complete exact authenticated evidence", () => {
	const target = agodaTarget();
	const bridge = {
		ok: true,
		amountRole: "payout",
		evidence: evidenceFixture(target),
	};
	assert.equal(assertBridge(target, bridge), true);
	assert.throws(
		() => assertBridge(target, {
			...bridge,
			evidence: { ...bridge.evidence, otaExpenseTotalSar: 99 },
		}),
		/do not reconcile exactly/
	);
	assert.throws(
		() => assertBridge(target, {
			...bridge,
			evidence: { ...bridge.evidence, evidenceHash: "short" },
		}),
		/lacks complete authenticated Agoda/
	);
});

test("Agoda commercial backfill sets platform commission zero and only verified OTA aliases", () => {
	const evidence = evidenceFixture();
	const set = commercialBackfillSet(evidence);
	assert.equal(set.commission, 0);
	assert.equal(set.commission_ota, 36.24);
	assert.equal(set["adminPricing.netAfterExpensesTotal"], 58.82);
	assert.equal(set["adminPricing.otaExpenseTotal"], 36.24);
	assert.equal(set["adminPricing.defaultDeductionApplied"], false);
	assert.equal(set["adminPricing.commercialVerified"], true);
	assert.equal(set["ota_financial_summary.show"], true);
	assert.equal(set["supplierData.otaPayoutFallbackReason"], "");
	assert.equal(
		set["supplierData.hotelRunnerEmailCommercialEvidence"].evidenceHash,
		evidence.evidenceHash
	);
	for (const forbidden of [
		"state",
		"reservation_status",
		"checkin_date",
		"checkout_date",
		"total_rooms",
		"pickedRoomsType",
		"roomId",
		"paid_amount",
		"payment",
		"payment_details",
		"customer_details",
		"total_amount",
	]) {
		assert.equal(Object.hasOwn(set, forbidden), false);
	}
});

test("Agoda reservation CAS uses exact direct ownership, version, and both commission snapshots", () => {
	const scope = scopeFixture(agodaTarget());
	const filter = reservationCasFilter(scope);
	assert.equal(filter._id, RESERVATION_ID);
	assert.equal(filter.hotelId, HOTEL_ID);
	assert.equal(filter.__v, 4);
	assert.equal(filter["supplierData.hotelRunner.transport"], "hotelrunner_api");
	assert.equal(
		filter["supplierData.hotelRunner.reservationId"],
		scope.target.hotelRunnerReservationId
	);
	assert.equal(filter.commission, 15);
	assert.equal(filter.commission_ota, null);
});

test("event CAS is exact and excludes active leases or integrity conflicts", () => {
	const scope = scopeFixture(tripTarget());
	const filter = eventCasFilter(scope);
	assert.equal(filter._id, scope.event._id);
	assert.equal(filter.hotelRunnerReservationId, scope.target.hotelRunnerReservationId);
	assert.equal(filter.hrNumber, scope.target.hrNumber);
	assert.equal(filter.providerNumber, scope.target.providerNumber);
	assert.equal(filter.payloadHash, scope.event.payloadHash);
	assert.equal(filter.status, "quarantined");
	assert.deepEqual(filter.leaseOwner, { $in: ["", null] });
	assert.deepEqual(filter.integrityConflict, { $ne: true });
});

test("Agoda mirror CAS preserves projection identity/status and clears only exact stale attention", () => {
	const scope = scopeFixture(agodaTarget());
	const filter = mirrorCasFilter(scope);
	assert.equal(filter._id, scope.mirror._id);
	assert.equal(filter.__v, 2);
	assert.equal(filter.projectionVersion, 3);
	assert.equal(filter.projectionStatus, "updated");
	assert.equal(filter.hotelRunnerReservationId, scope.target.hotelRunnerReservationId);
	assert.equal(filter.reservationMongoId, RESERVATION_ID);
	const update = agodaMirrorResolutionUpdate(scope, NOW);
	assert.equal(update.$set["lastResult.commercialEvidenceStale"], false);
	assert.equal(update.$set["lastResult.attentionCode"], "");
	assert.equal(update.$set["lastResult.reconciliation"].repairId, REPAIR_ID);
	assert.equal(update.$set.lastErrorCode, "");
	assert.equal(update.$set.lastErrorMessage, "");
	assert.deepEqual(update.$inc, { __v: 1 });
	for (const forbidden of [
		"projectionStatus",
		"projectionVersion",
		"reservationMongoId",
		"state",
		"hrNumber",
		"providerNumber",
	]) {
		assert.equal(Object.hasOwn(update.$set, forbidden), false);
	}
});

test("Trip update only requeues the exact durable event and retains prior error in audit metadata", () => {
	const scope = scopeFixture(tripTarget());
	const update = tripRequeueUpdate(scope, NOW);
	assert.equal(update.$set.status, "pending");
	assert.equal(update.$set.attempts, 0);
	assert.equal(update.$set.errorCode, "");
	assert.equal(update.$set["result.reconciliation"].repairId, REPAIR_ID);
	assert.equal(
		update.$set["result.reconciliation"].previousCode,
		"hotelrunner_currency_requires_review"
	);
	assert.equal(update.$unset.leaseOwner, 1);
	assert.equal(Object.hasOwn(update.$set, "reservationMongoId"), false);
});

test("Agoda updates cannot modify lifecycle, guest, stay, room, or payment fields", () => {
	const scope = scopeFixture(agodaTarget());
	const reservationUpdate = agodaReservationBackfillUpdate(scope, NOW);
	const eventUpdate = agodaEventResolutionUpdate(NOW);
	const mirrorUpdate = agodaMirrorResolutionUpdate(scope, NOW);
	const serializedReservationUpdate = JSON.stringify(reservationUpdate);
	for (const forbidden of [
		'"state"',
		'"reservation_status"',
		'"checkin_date"',
		'"checkout_date"',
		'"pickedRoomsType"',
		'"roomId"',
		'"paid_amount"',
		'"customer_details"',
	]) {
		assert.equal(serializedReservationUpdate.includes(forbidden), false);
	}
	assert.equal(reservationUpdate.$push.reservationAuditLog.repairId, REPAIR_ID);
	assert.deepEqual(reservationUpdate.$inc, { __v: 1 });
	assert.equal(eventUpdate.$set.status, "completed");
	assert.equal(eventUpdate.$set["result.commercialEvidenceStale"], false);
	assert.equal(Object.hasOwn(mirrorUpdate.$set, "projectionStatus"), false);
});

test("canceled Agoda target receives financial evidence without any lifecycle mutation", () => {
	const target = targetByKey("agoda_3");
	const scope = scopeFixture(target);
	assert.equal(scope.reservation.state, "canceled");
	assert.equal(scope.reservation.reservation_status, "canceled");
	const update = agodaReservationBackfillUpdate(scope, NOW);
	assert.equal(Object.hasOwn(update.$set, "state"), false);
	assert.equal(Object.hasOwn(update.$set, "reservation_status"), false);
	assert.equal(update.$set.commission, 0);
	assert.equal(update.$set.commission_ota, 36.24);
});

test("target state accepts only the audited quarantine/attention conditions", () => {
	assert.equal(scopeFixture(tripTarget()).repairState, "requeue");
	assert.equal(scopeFixture(agodaTarget()).repairState, "backfill");
	assert.throws(
		() => scopeFixture(tripTarget(), {
			event: eventFixture(tripTarget(), {
				status: "failed",
				errorCode: "some_other_failure",
			}),
		}),
		/exact audited cross-currency quarantine/
	);
	assert.throws(
		() => scopeFixture(agodaTarget(), {
			event: eventFixture(agodaTarget(), {
				status: "attention",
				errorCode: "inventory_problem",
				result: { attentionCode: "inventory_problem" },
			}),
		}),
		/attention reason/
	);
});

test("a resumed repair never requeues or backfills the same target a second time", () => {
	const trip = scopeFixture(tripTarget());
	assert.throws(
		() =>
			assertManifestTargetResumeSafe(
				{ targets: { [trip.target.key]: { state: "requeued" } } },
				trip
			),
		/will not be written twice/
	);
	assert.equal(
		assertManifestTargetResumeSafe(
			{ targets: { [trip.target.key]: { state: "planned" } } },
			trip
		),
		true
	);
	const handedOff = {
		...trip,
		repairState: "already_handed_off",
	};
	assert.equal(
		assertManifestTargetResumeSafe(
			{ targets: { [trip.target.key]: { state: "requeued" } } },
			handedOff
		),
		true
	);
});

test("manifest plan proof binds immutable event/mirror facts but not mutable queue state", () => {
	const scope = scopeFixture(agodaTarget());
	const baselineEntry = immutableScopeEntry(scope);
	const baseline = immutablePlanHash(HOTEL_ID, [baselineEntry]);
	const mutableQueueChange = {
		...scope,
		event: { ...scope.event, status: "completed", attempts: 99 },
	};
	assert.equal(
		immutablePlanHash(HOTEL_ID, [immutableScopeEntry(mutableQueueChange)]),
		baseline
	);
	for (const changedScope of [
		{
			...scope,
			event: { ...scope.event, payloadHash: "e".repeat(64) },
		},
		{
			...scope,
			event: { ...scope.event, canonicalHash: "f".repeat(64) },
		},
		{
			...scope,
			event: {
				...scope.event,
				receivedAt: new Date("2026-08-07T15:34:01.000Z"),
			},
		},
		{
			...scope,
			mirror: { ...scope.mirror, observedCanonicalHash: "1".repeat(64) },
		},
		{
			...scope,
			mirror: { ...scope.mirror, appliedCanonicalHash: "2".repeat(64) },
		},
	]) {
		assert.notEqual(
			immutablePlanHash(HOTEL_ID, [immutableScopeEntry(changedScope)]),
			baseline
		);
	}
	const trip = scopeFixture(tripTarget());
	const tripBaseline = immutablePlanHash(HOTEL_ID, [immutableScopeEntry(trip)]);
	assert.equal(
		immutablePlanHash(HOTEL_ID, [
			immutableScopeEntry({
				...trip,
				mirror: {
					...trip.mirror,
					appliedCanonicalHash: trip.event.canonicalHash,
				},
			}),
		]),
		tripBaseline,
		"the intended Trip worker handoff must not invalidate an applied manifest"
	);
});

test("target loader requires one event, one mirror, one PMS record, and the authenticated bridge", async () => {
	const target = agodaTarget();
	const event = eventFixture(target);
	const reservation = reservationFixture(target);
	const mirror = mirrorFixture(target, { _id: "mirror-1" });
	let bridgeCalls = 0;
	const scope = await loadTargetScope(target, HOTEL_ID, {
		EventModel: findModel([event]),
		MirrorModel: findModel([mirror]),
		ReservationModel: findModel([reservation]),
		async loadBridge(input) {
			bridgeCalls += 1;
			assert.equal(input.existing._id, reservation._id);
			assert.equal(input.normalized.providerNumber, target.providerNumber);
			assert.equal(input.provider, "agoda");
			return {
				ok: true,
				amountRole: "payout",
				evidence: evidenceFixture(target),
			};
		},
	});
	assert.equal(scope.repairState, "backfill");
	assert.equal(bridgeCalls, 1);
	await assert.rejects(
		loadTargetScope(target, HOTEL_ID, {
			EventModel: findModel([event, { ...event, _id: "event-duplicate" }]),
			MirrorModel: findModel([mirror]),
			ReservationModel: findModel([reservation]),
			loadBridge: async () => ({
				ok: true,
				amountRole: "payout",
				evidence: evidenceFixture(target),
			}),
		}),
		/requires exactly one exact HotelRunner push event/
	);
});

test("applyScope requeues one Trip event and never writes the PMS reservation", async () => {
	const scope = scopeFixture(tripTarget());
	const event = clone(scope.event);
	const EventModel = mutableModel(event);
	let reservationWrites = 0;
	const result = await applyScope(scope, {
		EventModel,
		ReservationModel: {
			updateOne() {
				reservationWrites += 1;
				throw new Error("unexpected reservation write");
			},
		},
		clock: () => NOW,
	});
	assert.equal(result.state, "requeued");
	assert.equal(event.status, "pending");
	assert.equal(event.attempts, 0);
	assert.equal(reservationWrites, 0);
});

test("applyScope backfills one Agoda reservation and resolves only its event attention", async () => {
	const scope = scopeFixture(agodaTarget());
	const reservation = clone(scope.reservation);
	const event = clone(scope.event);
	const result = await applyScope(scope, {
		EventModel: mutableModel(event),
		MirrorModel: mutableModel(clone(scope.mirror)),
		ReservationModel: mutableModel(reservation),
		clock: () => NOW,
	});
	assert.equal(result.state, "backfilled");
	assert.equal(reservation.commission, 0);
	assert.equal(reservation.commission_ota, 36.24);
	assert.equal(reservation.__v, 5);
	assert.equal(reservation.state, "ota platform review");
	assert.equal(reservation.reservation_status, "ota platform review");
	assert.equal(event.status, "completed");
	assert.equal(
		reservationBackfillSatisfied(reservation, scope.target, scope.financialSet),
		true
	);
});

test("applyScope resolves the exact linked Agoda mirror without changing projection lifecycle", async () => {
	const scope = scopeFixture(agodaTarget());
	const reservation = clone(scope.reservation);
	const event = clone(scope.event);
	const mirror = clone(scope.mirror);
	const beforeStatus = mirror.projectionStatus;
	const beforeProjectionVersion = mirror.projectionVersion;
	await applyScope(scope, {
		EventModel: mutableModel(event),
		MirrorModel: mutableModel(mirror),
		ReservationModel: mutableModel(reservation),
		clock: () => NOW,
	});
	assert.equal(mirror.projectionStatus, beforeStatus);
	assert.equal(mirror.projectionVersion, beforeProjectionVersion);
	assert.equal(mirror.lastResult.commercialEvidenceStale, false);
	assert.equal(mirror.lastResult.attentionCode, "");
	assert.equal(mirror.lastResult.reconciliation.repairId, REPAIR_ID);
	assert.equal(mirror.lastErrorCode, "");
	assert.equal(mirrorResolutionSatisfied(mirror, scope.target, RESERVATION_ID), true);
});

test("manifest retains only exact recovery fields and no payload, guest, room, or payment content", () => {
	const scopes = [scopeFixture(agodaTarget()), scopeFixture(tripTarget())];
	const plan = {
		planHash: "d".repeat(64),
		hotelId: HOTEL_ID,
		hotelName: "Zad Ajyad",
		immutableScope: scopes.map((scope) => ({
			key: scope.target.key,
			action: scope.target.action,
			hotelRunnerReservationId: scope.target.hotelRunnerReservationId,
			hrNumber: scope.target.hrNumber,
			providerNumber: scope.target.providerNumber,
			reservationMongoId: RESERVATION_ID,
			evidenceHash: scope.bridge.evidence?.evidenceHash || "",
		})),
		scopes,
	};
	const manifest = manifestDocument(plan, NOW);
	assert.equal(manifest._id, REPAIR_ID);
	assert.equal(manifest.vendorApiCalls, 0);
	assert.equal(MANIFEST_COLLECTION, "hotelrunner_priority_commission_repairs");
	const serialized = JSON.stringify(manifest).toLowerCase();
	for (const forbidden of [
		'"payload"',
		"customer_details",
		"guest",
		"card",
		"payment_details",
		"pickedroom",
	]) {
		assert.equal(serialized.includes(forbidden), false);
	}
});

test("sanitized output reports exact scope and zero vendor calls without payload data", () => {
	const scopes = [scopeFixture(agodaTarget()), scopeFixture(tripTarget())];
	const output = sanitizedPlan(
		{ hotelName: "Zad Ajyad", scopes },
		"dry_run"
	);
	assert.equal(output.targetCount, 2);
	assert.equal(output.vendorApiCalls, 0);
	assert.equal(output.createsReservations, false);
	assert.equal(output.mutatesLifecycleStayRoomsPayments, false);
	assert.equal(output.commissionZeroTargetCount, 2);
	assert.equal(output.verifiedOtaCommissionCount, 1);
	assert.equal(output.unknownOtaCommissionCount, 1);
	assert.equal(Object.hasOwn(output, "targets"), false);
	const serialized = JSON.stringify(output);
	assert.equal(serialized.includes("payload"), false);
	for (const target of [agodaTarget(), tripTarget()]) {
		assert.equal(serialized.includes(target.hotelRunnerReservationId), false);
		assert.equal(serialized.includes(target.providerNumber), false);
		assert.equal(serialized.includes(`\"hrNumber\":\"${target.hrNumber}\"`), false);
	}
});

test("script has no HotelRunner client, fetch, HTTP, or API invocation path", () => {
	const source = fs.readFileSync(
		path.join(__dirname, "reconcileHotelRunnerPriorityCommission20260807.js"),
		"utf8"
	);
	assert.doesNotMatch(source, /hotelrunnerClient|createHotelRunnerClient|axios|https\.request|fetch\s*\(/);
	assert.doesNotMatch(
		source,
		/HotelRunnerClient|createHotelRunnerClient|retrieveHotelRunnerReservations|confirmHotelRunnerDelivery|createHotelRunnerPullSync/
	);
});
