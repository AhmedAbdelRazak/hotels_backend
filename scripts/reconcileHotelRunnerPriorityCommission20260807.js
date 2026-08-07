/** @format */

"use strict";

const path = require("path");

require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const mongoose = require("mongoose");

// A repair must never create or rebuild indexes on the packed PMS database.
mongoose.set("autoIndex", false);
mongoose.set("autoCreate", false);

const HotelDetails = require("../models/hotel_details");
const HotelRunnerEvent = require("../models/hotelrunner_event");
const HotelRunnerReservation = require("../models/hotelrunner_reservation");
const Reservations = require("../models/reservations");
const { getHotelRunnerConfig } = require("../services/hotelrunnerConfig");
const { safeErrorMessage } = require("../services/hotelrunnerEventService");
const {
	loadHotelRunnerEmailCommercialBridge,
} = require("../services/hotelrunnerEmailCommercialBridge");
const { hashObject, stableClone } = require("../services/hotelrunnerPayload");

const REPAIR_ID = "hotelrunner-zad-ajyad-20260807-api-priority-commission-v1";
const AUDIT_DAY_START = new Date("2026-08-07T00:00:00.000Z");
const AUDIT_DAY_END = new Date("2026-08-08T00:00:00.000Z");
const EXPECTED_HOTEL_ID = "6a40b6a1a6efe70450536038";
const EXPECTED_HOTEL_NAME_KEY = "zadajyad";
const MANIFEST_COLLECTION = "hotelrunner_priority_commission_repairs";
const MANIFEST_VERSION = 1;
const WRITE_OPTIONS = Object.freeze({ writeConcern: { w: "majority" } });
const CURRENCY_REVIEW_CODE = "hotelrunner_currency_requires_review";
const COMMERCIAL_STALE_CODE = "hotelrunner_commercial_evidence_stale";

const EXACT_TARGETS = Object.freeze(
	[
		{
			key: "agoda_1",
			action: "agoda_backfill",
			provider: "agoda",
			hotelRunnerReservationId: "40339710",
			hrNumber: "R975197182",
			providerNumber: "687268443",
			cancelled: false,
		},
		{
			key: "trip_1",
			action: "trip_requeue",
			provider: "trip",
			hotelRunnerReservationId: "40335625",
			hrNumber: "R820693493",
			providerNumber: "1539366616295913",
			cancelled: false,
		},
		{
			key: "agoda_2",
			action: "agoda_backfill",
			provider: "agoda",
			hotelRunnerReservationId: "40334795",
			hrNumber: "R932599996",
			providerNumber: "2039272929",
			cancelled: false,
		},
		{
			key: "trip_2",
			action: "trip_requeue",
			provider: "trip",
			hotelRunnerReservationId: "40333628",
			hrNumber: "R990965712",
			providerNumber: "1658113850697820",
			cancelled: false,
		},
		{
			key: "agoda_3",
			action: "agoda_backfill",
			provider: "agoda",
			hotelRunnerReservationId: "40291843",
			hrNumber: "R583676061",
			providerNumber: "686444019",
			cancelled: true,
		},
		{
			key: "agoda_4",
			action: "agoda_backfill",
			provider: "agoda",
			hotelRunnerReservationId: "40330675",
			hrNumber: "R071469597",
			providerNumber: "2039222293",
			cancelled: false,
		},
		{
			key: "trip_3",
			action: "trip_requeue",
			provider: "trip",
			hotelRunnerReservationId: "40328737",
			hrNumber: "R282107190",
			providerNumber: "1367842780034782",
			cancelled: false,
		},
		{
			key: "trip_4",
			action: "trip_requeue",
			provider: "trip",
			hotelRunnerReservationId: "40328738",
			hrNumber: "R064683472",
			providerNumber: "1367842780034772",
			cancelled: false,
		},
	].map((target) => Object.freeze(target))
);

const clean = (value = "") => String(value?._id || value || "").trim();
const lower = (value = "") => clean(value).toLowerCase();
const upper = (value = "") => clean(value).toUpperCase();
const round2 = (value) => Number(Number(value).toFixed(2));
const dateMs = (value) => {
	const parsed = value instanceof Date ? value : new Date(value);
	return Number.isFinite(parsed.getTime()) ? parsed.getTime() : NaN;
};
const isOnAuditDay = (value) => {
	const milliseconds = dateMs(value);
	return (
		Number.isFinite(milliseconds) &&
		milliseconds >= AUDIT_DAY_START.getTime() &&
		milliseconds < AUDIT_DAY_END.getTime()
	);
};

function fail(message, code = "HOTELRUNNER_RECONCILIATION_BLOCKED") {
	const error = new Error(message);
	error.code = code;
	throw error;
}

function providerKey(value = "") {
	const compact = lower(value).replace(/[^a-z0-9]+/g, "");
	if (["trip", "tripcom", "ctrip", "ctripcom"].includes(compact)) return "trip";
	if (["agoda", "agodacom"].includes(compact)) return "agoda";
	return compact;
}

function storedEventProviderKeys(normalized = {}) {
	return new Set(
		[normalized.channel, normalized.channelDisplay, normalized.sourceDisplay]
			.map(providerKey)
			.filter((value) => ["trip", "agoda"].includes(value))
	);
}

function exactTargetIdentity(target = {}) {
	return `${target.provider}:${target.providerNumber}`;
}

// This intentionally mirrors the worker's local reconstruction without
// importing the worker or any pull/client module into the one-time repair.
function normalizedFromStoredEvent(event = {}) {
	const payload =
		event.payload && typeof event.payload === "object" ? event.payload : {};
	return {
		...payload,
		messageUid: event.messageUid,
		hotelRunnerReservationId: event.hotelRunnerReservationId,
		sourceUpdatedAt: new Date(event.sourceUpdatedAt),
		bookedAt: payload.bookedAt ? new Date(payload.bookedAt) : null,
		payloadHash: event.payloadHash,
		canonicalHash: event.canonicalHash,
		rooms: (payload.rooms || []).map((room) => ({
			...room,
			updatedAt: room?.updatedAt ? new Date(room.updatedAt) : null,
		})),
	};
}

function parseArguments(argv = []) {
	let apply = false;
	let repairId = "";
	for (const raw of argv) {
		const argument = clean(raw);
		if (argument === "--apply") {
			if (apply) fail("--apply may be supplied only once.", "HOTELRUNNER_RECONCILIATION_ARGUMENT_INVALID");
			apply = true;
			continue;
		}
		if (argument.startsWith("--repair-id=")) {
			if (repairId) fail("--repair-id may be supplied only once.", "HOTELRUNNER_RECONCILIATION_ARGUMENT_INVALID");
			repairId = argument.slice("--repair-id=".length);
			continue;
		}
		fail("Unsupported HotelRunner reconciliation argument.", "HOTELRUNNER_RECONCILIATION_ARGUMENT_INVALID");
	}
	if (!apply && repairId) {
		fail("--repair-id is accepted only with --apply.", "HOTELRUNNER_RECONCILIATION_ARGUMENT_INVALID");
	}
	if (apply && repairId !== REPAIR_ID) {
		fail(
			`Apply requires the exact immutable repair ID: ${REPAIR_ID}.`,
			"HOTELRUNNER_RECONCILIATION_REPAIR_ID_REQUIRED"
		);
	}
	return { apply, repairId };
}

function exactEventFilter(target, hotelId) {
	return {
		hotelId,
		source: "push",
		hotelRunnerReservationId: target.hotelRunnerReservationId,
		hrNumber: target.hrNumber,
		providerNumber: target.providerNumber,
		sourceUpdatedAt: { $gte: AUDIT_DAY_START, $lt: AUDIT_DAY_END },
		receivedAt: { $gte: AUDIT_DAY_START, $lt: AUDIT_DAY_END },
	};
}

function exactReservationFilter(target, hotelId) {
	const identity = exactTargetIdentity(target);
	return {
		hotelId,
		$or: [
			{ "supplierData.hotelRunner.reservationId": target.hotelRunnerReservationId },
			{ otaIdentityKey: identity },
			{ otaCrossTransportIdentityKey: identity },
		],
	};
}

async function leanMany(Model, filter, { select = "", limit = 2 } = {}) {
	let query = Model.find(filter);
	if (select && typeof query.select === "function") query = query.select(select);
	if (typeof query.limit === "function") query = query.limit(limit);
	if (typeof query.lean === "function") query = query.lean();
	return query && typeof query.exec === "function" ? query.exec() : query;
}

async function leanOne(Model, filter, { select = "" } = {}) {
	let query = Model.findOne(filter);
	if (select && typeof query.select === "function") query = query.select(select);
	if (typeof query.lean === "function") query = query.lean();
	return query && typeof query.exec === "function" ? query.exec() : query;
}

async function executeUpdate(Model, filter, update) {
	const query = Model.updateOne(filter, update, WRITE_OPTIONS);
	return query && typeof query.exec === "function" ? query.exec() : query;
}

function matchedCount(result) {
	return Number(result?.matchedCount ?? result?.n ?? 0);
}

function modifiedCount(result) {
	return Number(result?.modifiedCount ?? result?.nModified ?? result?.n ?? 0);
}

function assertOperationalScope(config = {}, hotel = {}, { apply = false } = {}) {
	if (config.configured !== true || config.callbackConfigured !== true) {
		fail("HotelRunner configuration is incomplete.");
	}
	if (
		!config.hotelId ||
		clean(config.hotelId) !== EXPECTED_HOTEL_ID ||
		clean(config.hotelId) !== clean(hotel._id)
	) {
		fail("The configured HotelRunner property does not match the loaded PMS hotel.");
	}
	const hotelNameKey = lower(hotel.hotelName).replace(/[^a-z0-9]+/g, "");
	if (
		hotelNameKey !== EXPECTED_HOTEL_NAME_KEY ||
		hotel.activateHotel !== true ||
		hotel.xHotelProActive === false
	) {
		fail("This repair is permanently scoped to the active Zad Ajyad PMS hotel.");
	}
	if (
		config.pullEnabled === true ||
		config.roomListSyncEnabled === true ||
		config.confirmDeliveryEnabled === true
	) {
		fail("Pull, room/calendar synchronization, and delivery confirmation must remain disabled.");
	}
	if (apply && config.projectionEnabled !== true) {
		fail("HotelRunner projection must be enabled before exact Trip events are requeued.");
	}
	if (apply && config.requireOtaReview !== true) {
		fail("HotelRunner OTA review mode must remain enabled during this reconciliation.");
	}
	return true;
}

function assertExactEvent(target, event) {
	if (!event) fail(`${target.key} has no exact HotelRunner push event.`);
	if (
		clean(event.hotelRunnerReservationId) !== target.hotelRunnerReservationId ||
		clean(event.hrNumber) !== target.hrNumber ||
		clean(event.providerNumber) !== target.providerNumber ||
		lower(event.source) !== "push" ||
		!isOnAuditDay(event.sourceUpdatedAt) ||
		!isOnAuditDay(event.receivedAt)
	) {
		fail(`${target.key} event identity/date boundary changed.`);
	}
	if (
		event.integrityConflict === true ||
		!["", null, undefined].includes(event.integrityReason)
	) {
		fail(`${target.key} has an unresolved payload-integrity condition.`);
	}
	if (!/^[a-f0-9]{64}$/i.test(clean(event.payloadHash))) {
		fail(`${target.key} has an invalid payload hash.`);
	}
	if (!/^[a-f0-9]{64}$/i.test(clean(event.canonicalHash))) {
		fail(`${target.key} has an invalid canonical hash.`);
	}
	const normalized = normalizedFromStoredEvent(event);
	const storedProviders = storedEventProviderKeys(normalized);
	if (
		clean(normalized.hotelRunnerReservationId) !== target.hotelRunnerReservationId ||
		clean(normalized.hrNumber) !== target.hrNumber ||
		clean(normalized.providerNumber) !== target.providerNumber ||
		storedProviders.size !== 1 ||
		!storedProviders.has(target.provider)
	) {
		fail(`${target.key} stored payload identity differs from its event envelope.`);
	}
	const cancelled = lower(normalized.state) === "canceled";
	if (cancelled !== target.cancelled) {
		fail(`${target.key} lifecycle classification differs from the audited target.`);
	}
	return normalized;
}

function assertExactMirror(target, mirror, reservation) {
	if (!mirror) fail(`${target.key} has no exact HotelRunner reservation mirror.`);
	if (
		clean(mirror.hotelRunnerReservationId) !== target.hotelRunnerReservationId ||
		(clean(mirror.hrNumber) && clean(mirror.hrNumber) !== target.hrNumber) ||
		(clean(mirror.providerNumber) && clean(mirror.providerNumber) !== target.providerNumber)
	) {
		fail(`${target.key} mirror identity differs from the audited target.`);
	}
	if (
		!clean(mirror._id) ||
		!/^[a-f0-9]{64}$/i.test(clean(mirror.observedCanonicalHash)) ||
		(clean(mirror.appliedCanonicalHash) &&
			!/^[a-f0-9]{64}$/i.test(clean(mirror.appliedCanonicalHash)))
	) {
		fail(`${target.key} mirror immutable projection proof is invalid.`);
	}
	if (
		clean(mirror.reservationMongoId) &&
		clean(mirror.reservationMongoId) !== clean(reservation._id)
	) {
		fail(`${target.key} mirror is linked to a different PMS reservation.`);
	}
	return true;
}

function assertExactReservation(target, reservation) {
	if (!reservation) fail(`${target.key} has no exact local OTA-email reservation.`);
	const expectedIdentity = exactTargetIdentity(target);
	const identities = new Set(
		[reservation.otaIdentityKey, reservation.otaCrossTransportIdentityKey]
			.map(lower)
			.filter(Boolean)
	);
	if (!identities.has(expectedIdentity)) {
		fail(`${target.key} PMS reservation lacks the exact cross-transport OTA identity.`);
	}
	if (target.action === "agoda_backfill") {
		if (
			lower(reservation?.supplierData?.hotelRunner?.transport) !== "hotelrunner_api" ||
			clean(reservation?.supplierData?.hotelRunner?.reservationId) !==
				target.hotelRunnerReservationId
		) {
			fail(`${target.key} is not already owned by the direct HotelRunner transport.`);
		}
	}
	return true;
}

function assertBridge(target, bridge) {
	if (bridge?.ok !== true) {
		fail(`${target.key} authenticated OTA-email bridge rejected: ${clean(bridge?.reason) || "unknown"}.`);
	}
	if (target.action === "trip_requeue") {
		if (bridge.amountRole !== "gross" || bridge.evidence) {
			fail(`${target.key} must be a gross-only Trip bridge with no invented OTA commission.`);
		}
		return true;
	}
	const evidence = bridge.evidence;
	if (
		bridge.amountRole !== "payout" ||
		!evidence ||
		evidence.verified !== true ||
		evidence.source !== "authenticated_ota_email" ||
		providerKey(evidence.provider) !== "agoda" ||
		lower(evidence.otaIdentityKey) !== exactTargetIdentity(target) ||
		upper(evidence.currency) !== "SAR" ||
		!/^[a-f0-9]{64}$/i.test(clean(evidence.evidenceHash))
	) {
		fail(`${target.key} lacks complete authenticated Agoda commercial evidence.`);
	}
	const gross = round2(evidence.grossTotalSar);
	const payout = round2(evidence.payoutTotalSar);
	const expense = round2(evidence.otaExpenseTotalSar);
	if (
		!Number.isFinite(gross) ||
		!Number.isFinite(payout) ||
		!Number.isFinite(expense) ||
		gross <= 0 ||
		payout <= 0 ||
		expense < 0 ||
		Math.abs(round2(gross - payout) - expense) > 0.02
	) {
		fail(`${target.key} authenticated Agoda amounts do not reconcile exactly.`);
	}
	return true;
}

function commercialBackfillSet(evidence) {
	const payout = round2(evidence.payoutTotalSar);
	const expense = round2(evidence.otaExpenseTotalSar);
	return {
		commission: 0,
		commission_ota: expense,
		"supplierData.hotelRunnerEmailCommercialEvidence": { ...evidence },
		"supplierData.otaTotalPayoutSar": payout,
		"supplierData.otaExpenseTotalSar": expense,
		"supplierData.otaPayoutFallbackReason": "",
		"adminPricing.netAfterExpensesTotal": payout,
		"adminPricing.otaExpenseTotal": expense,
		"adminPricing.defaultDeductionApplied": false,
		"adminPricing.payoutFallbackReason": "",
		"adminPricing.commercialVerified": true,
		"ota_financial_summary.show": true,
		"ota_financial_summary.netAfterExpenses": payout,
		"ota_financial_summary.netAfterOtaExpenses": payout,
		"ota_financial_summary.otaExpenseTotal": expense,
		"ota_financial_summary.commercialVerified": true,
		"ota_financial_summary.payoutFallbackReason": "",
	};
}

const getPath = (value, pathText) =>
	String(pathText)
		.split(".")
		.reduce((current, key) => (current == null ? undefined : current[key]), value);

function setMatchesDocument(document, set = {}) {
	return Object.entries(set).every(([pathText, expected]) => {
		const actual = getPath(document, pathText);
		if (typeof expected === "number") {
			return Number.isFinite(Number(actual)) && Math.abs(Number(actual) - expected) <= 0.000001;
		}
		return hashObject(actual) === hashObject(expected);
	});
}

function reservationBackfillSatisfied(reservation, target, set) {
	return Boolean(
		reservation &&
		clean(reservation?.supplierData?.hotelRunner?.reservationId) ===
			target.hotelRunnerReservationId &&
		setMatchesDocument(reservation, set)
	);
}

function eventHandedOff(event, target, reservationId) {
	if (!event) return false;
	if (target.action === "agoda_backfill") {
		return (
			lower(event.status) === "completed" &&
			clean(event?.result?.reconciliation?.repairId) === REPAIR_ID
		);
	}
	const status = lower(event.status);
	if (!["pending", "processing", "retry", "completed", "attention"].includes(status)) {
		return false;
	}
	return (
		clean(event?.result?.reconciliation?.repairId) === REPAIR_ID ||
		clean(event.reservationMongoId) === clean(reservationId)
	);
}

function mirrorResolutionSatisfied(mirror, target, reservationId) {
	if (!mirror || target.action !== "agoda_backfill") return false;
	if (
		clean(mirror.hotelRunnerReservationId) !== target.hotelRunnerReservationId ||
		clean(mirror.reservationMongoId) !== clean(reservationId) ||
		mirror?.lastResult?.commercialEvidenceStale !== false ||
		clean(mirror?.lastResult?.attentionCode) ||
		clean(mirror?.lastResult?.reconciliation?.repairId) !== REPAIR_ID
	) {
		return false;
	}
	return clean(mirror.lastErrorCode) !== COMMERCIAL_STALE_CODE;
}

function repairSnapshot(scope) {
	const financialPaths = scope.financialSet
		? Object.keys(scope.financialSet)
		: [];
	return {
		target: {
			key: scope.target.key,
			action: scope.target.action,
			hotelRunnerReservationId: scope.target.hotelRunnerReservationId,
			hrNumber: scope.target.hrNumber,
			providerNumber: scope.target.providerNumber,
		},
		event: {
			id: clean(scope.event._id),
			payloadHash: clean(scope.event.payloadHash),
			status: lower(scope.event.status),
			attempts: Number(scope.event.attempts || 0),
			nextAttemptAt: scope.event.nextAttemptAt || null,
			processedAt: scope.event.processedAt || null,
			errorCode: clean(scope.event.errorCode),
			errorMessage: clean(scope.event.errorMessage),
			result: stableClone(scope.event.result || {}),
		},
		mirror: {
			id: clean(scope.mirror._id),
			version: Number(scope.mirror.__v || 0),
			projectionVersion: Number(scope.mirror.projectionVersion || 0),
			projectionStatus: lower(scope.mirror.projectionStatus),
			lastErrorCode: clean(scope.mirror.lastErrorCode),
			commercialEvidenceStale:
				scope.mirror?.lastResult?.commercialEvidenceStale,
			attentionCode: clean(scope.mirror?.lastResult?.attentionCode),
			reconciliationRepairId: clean(
				scope.mirror?.lastResult?.reconciliation?.repairId
			),
		},
		reservation: {
			id: clean(scope.reservation._id),
			version: Number(scope.reservation.__v || 0),
			financialFields: Object.fromEntries(
				financialPaths.map((pathText) => [
					pathText,
					stableClone(getPath(scope.reservation, pathText)),
				])
			),
		},
	};
}

function targetRepairState(scope) {
	if (scope.target.action === "trip_requeue") {
		if (eventHandedOff(scope.event, scope.target, scope.reservation._id)) {
			return "already_handed_off";
		}
		if (
			lower(scope.event.status) !== "quarantined" ||
			![clean(scope.event.errorCode), clean(scope.event?.result?.code)].includes(
				CURRENCY_REVIEW_CODE
			)
		) {
			fail(`${scope.target.key} is not in the exact audited cross-currency quarantine.`);
		}
		return "requeue";
	}
	const reservationDone = reservationBackfillSatisfied(
		scope.reservation,
		scope.target,
		scope.financialSet
	);
	const mirrorDone = mirrorResolutionSatisfied(
		scope.mirror,
		scope.target,
		scope.reservation._id
	);
	const eventDone = eventHandedOff(scope.event, scope.target, scope.reservation._id);
	if (reservationDone && mirrorDone && eventDone) return "already_backfilled";
	if (!reservationDone && !["attention", "completed"].includes(lower(scope.event.status))) {
		fail(`${scope.target.key} is no longer in its audited terminal event state.`);
	}
	if (
		lower(scope.event.status) === "attention" &&
		![clean(scope.event.errorCode), clean(scope.event?.result?.attentionCode)].includes(
			COMMERCIAL_STALE_CODE
		)
	) {
		fail(`${scope.target.key} attention reason is not the audited commercial-evidence condition.`);
	}
	return reservationDone ? "resolve_event" : "backfill";
}

async function loadTargetScope(
	target,
	hotelId,
	{
		EventModel = HotelRunnerEvent,
		MirrorModel = HotelRunnerReservation,
		ReservationModel = Reservations,
		loadBridge = loadHotelRunnerEmailCommercialBridge,
	} = {}
) {
	const events = await leanMany(EventModel, exactEventFilter(target, hotelId), {
		select: "+payload",
		limit: 2,
	});
	if (!Array.isArray(events) || events.length !== 1) {
		fail(`${target.key} requires exactly one exact HotelRunner push event; found ${events?.length || 0}.`);
	}
	const event = events[0];
	const normalized = assertExactEvent(target, event);
	const mirrors = await leanMany(
		MirrorModel,
		{
			hotelId,
			hotelRunnerReservationId: target.hotelRunnerReservationId,
		},
		{ limit: 2 }
	);
	if (!Array.isArray(mirrors) || mirrors.length !== 1) {
		fail(`${target.key} requires exactly one exact HotelRunner mirror; found ${mirrors?.length || 0}.`);
	}
	const reservations = await leanMany(
		ReservationModel,
		exactReservationFilter(target, hotelId),
		{ limit: 2 }
	);
	if (!Array.isArray(reservations) || reservations.length !== 1) {
		fail(`${target.key} requires exactly one local PMS reservation; found ${reservations?.length || 0}.`);
	}
	const reservation = reservations[0];
	assertExactReservation(target, reservation);
	assertExactMirror(target, mirrors[0], reservation);
	if (
		clean(event.reservationMongoId) &&
		clean(event.reservationMongoId) !== clean(reservation._id)
	) {
		fail(`${target.key} event is linked to a different PMS reservation.`);
	}
	const bridge = await loadBridge({
		existing: reservation,
		normalized,
		provider: target.provider,
	});
	assertBridge(target, bridge);
	const financialSet = bridge.evidence
		? commercialBackfillSet(bridge.evidence)
		: null;
	const scope = {
		target,
		event,
		mirror: mirrors[0],
		reservation,
		normalized,
		bridge,
		financialSet,
	};
	scope.repairState = targetRepairState(scope);
	scope.before = repairSnapshot(scope);
	return scope;
}

async function loadPlan(
	config,
	{
		HotelModel = HotelDetails,
		clock = () => new Date(),
		...dependencies
	} = {},
	{ apply = false } = {}
) {
	const hotel = await leanOne(HotelModel, { _id: config.hotelId }, {
		select: "_id hotelName activateHotel xHotelProActive",
	});
	assertOperationalScope(config, hotel, { apply });
	const scopes = [];
	for (const target of EXACT_TARGETS) {
		scopes.push(await loadTargetScope(target, config.hotelId, dependencies));
	}
	const identityTriples = new Set(
		scopes.map(({ target }) =>
			[target.hotelRunnerReservationId, target.hrNumber, target.providerNumber].join(":")
		)
	);
	const eventIds = new Set(scopes.map(({ event }) => clean(event._id)));
	if (identityTriples.size !== 8 || eventIds.size !== 8) {
		fail("The exact eight-target HotelRunner scope is not unique.");
	}
	const immutableScope = scopes.map(immutableScopeEntry);
	return {
		repairId: REPAIR_ID,
		version: MANIFEST_VERSION,
		hotelId: clean(config.hotelId),
		hotelName: clean(hotel.hotelName),
		plannedAt: clock(),
		immutableScope,
		planHash: immutablePlanHash(clean(config.hotelId), immutableScope),
		scopes,
	};
}

function exactIso(value, label) {
	const milliseconds = dateMs(value);
	if (!Number.isFinite(milliseconds)) fail(`${label} is not a valid immutable timestamp.`);
	return new Date(milliseconds).toISOString();
}

function immutableScopeEntry({ target, event, mirror, reservation, bridge }) {
	return {
		key: target.key,
		action: target.action,
		hotelRunnerReservationId: target.hotelRunnerReservationId,
		hrNumber: target.hrNumber,
		providerNumber: target.providerNumber,
		reservationMongoId: clean(reservation._id),
		evidenceHash: clean(bridge?.evidence?.evidenceHash),
		eventProof: {
			id: clean(event._id),
			payloadHash: clean(event.payloadHash),
			canonicalHash: clean(event.canonicalHash),
			sourceUpdatedAt: exactIso(
				event.sourceUpdatedAt,
				`${target.key} sourceUpdatedAt`
			),
			receivedAt: exactIso(event.receivedAt, `${target.key} receivedAt`),
		},
		mirrorProof: {
			id: clean(mirror._id),
			observedCanonicalHash: clean(mirror.observedCanonicalHash),
			...(target.action === "agoda_backfill"
				? { appliedCanonicalHash: clean(mirror.appliedCanonicalHash) }
				: {}),
		},
	};
}

function immutablePlanHash(hotelId, immutableScope) {
	return hashObject({
		repairId: REPAIR_ID,
		version: MANIFEST_VERSION,
		hotelId: clean(hotelId),
		immutableScope,
	});
}

function eventCasFilter(scope) {
	return {
		_id: scope.event._id,
		hotelId: scope.event.hotelId,
		source: "push",
		hotelRunnerReservationId: scope.target.hotelRunnerReservationId,
		hrNumber: scope.target.hrNumber,
		providerNumber: scope.target.providerNumber,
		payloadHash: scope.event.payloadHash,
		status: scope.event.status,
		attempts: Number(scope.event.attempts || 0),
		integrityConflict: { $ne: true },
		integrityReason: { $in: ["", null] },
		leaseOwner: { $in: ["", null] },
		$or: [
			{ leaseUntil: { $exists: false } },
			{ leaseUntil: null },
		],
	};
}

function reservationCasFilter(scope) {
	return {
		_id: scope.reservation._id,
		hotelId: scope.reservation.hotelId,
		__v: Number(scope.reservation.__v || 0),
		"supplierData.hotelRunner.transport": "hotelrunner_api",
		"supplierData.hotelRunner.reservationId":
			scope.target.hotelRunnerReservationId,
		commission: scope.reservation.commission ?? null,
		commission_ota: scope.reservation.commission_ota ?? null,
	};
}

function mirrorCasFilter(scope) {
	return {
		_id: scope.mirror._id,
		hotelId: scope.mirror.hotelId,
		__v: Number(scope.mirror.__v || 0),
		projectionVersion: Number(scope.mirror.projectionVersion || 0),
		hotelRunnerReservationId: scope.target.hotelRunnerReservationId,
		hrNumber: scope.target.hrNumber,
		providerNumber: scope.target.providerNumber,
		reservationMongoId: scope.reservation._id,
		projectionStatus: scope.mirror.projectionStatus,
		identityConflict: { $ne: true },
		"lastResult.commercialEvidenceStale":
			scope.mirror?.lastResult?.commercialEvidenceStale ?? null,
		"lastResult.attentionCode":
			scope.mirror?.lastResult?.attentionCode ?? null,
		lastErrorCode: scope.mirror.lastErrorCode ?? null,
	};
}

function tripRequeueUpdate(scope, now) {
	return {
		$set: {
			status: "pending",
			attempts: 0,
			nextAttemptAt: now,
			processedAt: null,
			finalRecoveryAttempted: false,
			finalRecoveryClaimedAt: null,
			errorCode: "",
			errorMessage: "",
			"result.reconciliation": {
				repairId: REPAIR_ID,
				action: "requeued_for_authenticated_email_bridge",
				at: now,
				previousCode:
					clean(scope.event.errorCode) || clean(scope.event?.result?.code),
			},
		},
		$unset: {
			leaseOwner: 1,
			leaseAcquiredAt: 1,
			leaseUntil: 1,
		},
	};
}

function agodaEventResolutionUpdate(now) {
	return {
		$set: {
			status: "completed",
			errorCode: "",
			errorMessage: "",
			"result.commercialEvidenceStale": false,
			"result.attentionCode": "",
			"result.reconciliation": {
				repairId: REPAIR_ID,
				action: "authenticated_ota_commercial_evidence_backfilled",
				at: now,
			},
		},
		$unset: {
			leaseOwner: 1,
			leaseAcquiredAt: 1,
			leaseUntil: 1,
		},
	};
}

function agodaMirrorResolutionUpdate(scope, now) {
	const set = {
		"lastResult.commercialEvidenceStale": false,
		"lastResult.attentionCode": "",
		"lastResult.reconciliation": {
			repairId: REPAIR_ID,
			action: "authenticated_ota_commercial_evidence_backfilled",
			at: now,
		},
	};
	if (clean(scope.mirror.lastErrorCode) === COMMERCIAL_STALE_CODE) {
		set.lastErrorCode = "";
		set.lastErrorMessage = "";
	}
	return { $set: set, $inc: { __v: 1 } };
}

function agodaReservationBackfillUpdate(scope, now) {
	return {
		$set: scope.financialSet,
		$push: {
			reservationAuditLog: {
				at: now,
				source: "hotelrunner-reconciliation",
				action: "authenticated-ota-commercial-evidence-backfilled",
				repairId: REPAIR_ID,
				hotelRunnerReservationId:
					scope.target.hotelRunnerReservationId,
				evidenceHash: scope.bridge.evidence.evidenceHash,
			},
		},
		$inc: { __v: 1 },
	};
}

async function readById(Model, idValue) {
	return leanOne(Model, { _id: idValue });
}

async function updateOnceWithReadback({
	Model,
	filter,
	update,
	idValue,
	postcondition,
	label,
}) {
	let writeError = null;
	let result = null;
	try {
		result = await executeUpdate(Model, filter, update);
	} catch (error) {
		writeError = error;
	}
	if (!writeError && matchedCount(result) === 1 && modifiedCount(result) === 1) {
		return { changed: true, acknowledgementRecovered: false };
	}
	const live = await readById(Model, idValue);
	if (postcondition(live)) {
		return {
			changed: true,
			acknowledgementRecovered: Boolean(writeError),
		};
	}
	if (writeError) throw writeError;
	fail(`${label} optimistic update did not match and its postcondition is absent.`, "HOTELRUNNER_RECONCILIATION_CAS_LOST");
}

function manifestDocument(plan, now) {
	return {
		_id: REPAIR_ID,
		version: MANIFEST_VERSION,
		planHash: plan.planHash,
		hotelId: plan.hotelId,
		hotelName: plan.hotelName,
		auditDay: "2026-08-07",
		state: "applying",
		attempts: 1,
		createdAt: now,
		updatedAt: now,
		vendorApiCalls: 0,
		immutableScope: plan.immutableScope,
		targets: Object.fromEntries(
			plan.scopes.map((scope) => [
				scope.target.key,
				{
					state: "planned",
					before: scope.before,
					updatedAt: now,
				},
			])
		),
		lastError: null,
	};
}

async function createOrResumeManifest(collection, plan, now) {
	let manifest = await collection.findOne({ _id: REPAIR_ID });
	let created = false;
	if (!manifest) {
		try {
			await collection.insertOne(manifestDocument(plan, now), WRITE_OPTIONS);
			manifest = await collection.findOne({ _id: REPAIR_ID });
			created = true;
		} catch (error) {
			if (Number(error?.code) !== 11000) throw error;
			manifest = await collection.findOne({ _id: REPAIR_ID });
		}
	}
	if (
		!manifest ||
		Number(manifest.version) !== MANIFEST_VERSION ||
		clean(manifest.planHash) !== plan.planHash ||
		clean(manifest.hotelId) !== plan.hotelId ||
		Number(manifest.vendorApiCalls) !== 0
	) {
		fail("The immutable HotelRunner reconciliation manifest differs from this exact plan.");
	}
	if (manifest.state === "applied") return manifest;
	if (created) return manifest;
	const resumed = await collection.updateOne(
		{
			_id: REPAIR_ID,
			planHash: plan.planHash,
			state: { $in: ["applying", "attention"] },
		},
		{
			$set: { state: "applying", updatedAt: now, lastError: null },
			$inc: { attempts: 1 },
		},
		WRITE_OPTIONS
	);
	if (matchedCount(resumed) !== 1) {
		fail("The reconciliation manifest is not resumable from its current state.");
	}
	return collection.findOne({ _id: REPAIR_ID });
}

async function markManifestTarget(collection, planHash, targetKey, state, now) {
	const result = await collection.updateOne(
		{ _id: REPAIR_ID, planHash, state: "applying" },
		{
			$set: {
				[`targets.${targetKey}.state`]: state,
				[`targets.${targetKey}.updatedAt`]: now,
				updatedAt: now,
			},
		},
		WRITE_OPTIONS
	);
	if (matchedCount(result) !== 1) {
		fail("The immutable reconciliation manifest ownership fence was lost.");
	}
}

function assertManifestTargetResumeSafe(manifest, scope) {
	const priorState = clean(manifest?.targets?.[scope.target.key]?.state);
	if (!priorState || priorState === "planned") return true;
	const satisfied = ["already_handed_off", "already_backfilled"].includes(
		scope.repairState
	);
	if (satisfied) return true;
	fail(
		`${scope.target.key} was already written by this repair but no longer satisfies its live postcondition; it will not be written twice.`,
		"HOTELRUNNER_RECONCILIATION_POSTCONDITION_FAILED"
	);
}

async function applyScope(
	scope,
	{
		EventModel = HotelRunnerEvent,
		MirrorModel = HotelRunnerReservation,
		ReservationModel = Reservations,
		clock = () => new Date(),
	} = {}
) {
	if (["already_handed_off", "already_backfilled"].includes(scope.repairState)) {
		return { state: scope.repairState, changed: false };
	}
	const now = clock();
	if (scope.target.action === "trip_requeue") {
		const outcome = await updateOnceWithReadback({
			Model: EventModel,
			filter: eventCasFilter(scope),
			update: tripRequeueUpdate(scope, now),
			idValue: scope.event._id,
			postcondition: (event) =>
				eventHandedOff(event, scope.target, scope.reservation._id),
			label: `${scope.target.key} event requeue`,
		});
		return { state: "requeued", ...outcome };
	}
	let changed = false;
	let acknowledgementRecovered = false;
	if (scope.repairState === "backfill") {
		const reservationOutcome = await updateOnceWithReadback({
			Model: ReservationModel,
			filter: reservationCasFilter(scope),
			update: agodaReservationBackfillUpdate(scope, now),
			idValue: scope.reservation._id,
			postcondition: (reservation) =>
				reservationBackfillSatisfied(
					reservation,
					scope.target,
					scope.financialSet
				),
			label: `${scope.target.key} reservation backfill`,
		});
		changed = changed || reservationOutcome.changed;
		acknowledgementRecovered =
			acknowledgementRecovered || reservationOutcome.acknowledgementRecovered;
	}
	if (
		!mirrorResolutionSatisfied(
			scope.mirror,
			scope.target,
			scope.reservation._id
		)
	) {
		const mirrorOutcome = await updateOnceWithReadback({
			Model: MirrorModel,
			filter: mirrorCasFilter(scope),
			update: agodaMirrorResolutionUpdate(scope, now),
			idValue: scope.mirror._id,
			postcondition: (mirror) =>
				mirrorResolutionSatisfied(
					mirror,
					scope.target,
					scope.reservation._id
				),
			label: `${scope.target.key} mirror commercial-attention resolution`,
		});
		changed = changed || mirrorOutcome.changed;
		acknowledgementRecovered =
			acknowledgementRecovered || mirrorOutcome.acknowledgementRecovered;
	}
	const eventOutcome = await updateOnceWithReadback({
		Model: EventModel,
		filter: eventCasFilter(scope),
		update: agodaEventResolutionUpdate(now),
		idValue: scope.event._id,
		postcondition: (event) =>
			eventHandedOff(event, scope.target, scope.reservation._id),
		label: `${scope.target.key} event resolution`,
	});
	return {
		state: "backfilled",
		changed: changed || eventOutcome.changed,
		acknowledgementRecovered:
			acknowledgementRecovered || eventOutcome.acknowledgementRecovered,
	};
}

async function applyPlan(
	plan,
	{
		db = mongoose.connection.db,
		clock = () => new Date(),
		...dependencies
	} = {}
) {
	if (!db || typeof db.collection !== "function") {
		fail("A connected MongoDB database is required for apply mode.");
	}
	const collection = db.collection(MANIFEST_COLLECTION);
	const now = clock();
	const manifest = await createOrResumeManifest(collection, plan, now);
	if (manifest.state === "applied") {
		const incomplete = plan.scopes.filter(
			(scope) =>
				!["already_handed_off", "already_backfilled"].includes(
					scope.repairState
				)
		);
		if (incomplete.length) {
			fail(
				"The applied reconciliation manifest no longer satisfies every live postcondition.",
				"HOTELRUNNER_RECONCILIATION_POSTCONDITION_FAILED"
			);
		}
		return { state: "already_applied", results: [], vendorApiCalls: 0 };
	}
	const results = [];
	try {
		for (const scope of plan.scopes) {
			assertManifestTargetResumeSafe(manifest, scope);
			const result = await applyScope(scope, { clock, ...dependencies });
			results.push({ key: scope.target.key, ...result });
			await markManifestTarget(
				collection,
				plan.planHash,
				scope.target.key,
				result.state,
				clock()
			);
		}
		const completion = await collection.updateOne(
			{ _id: REPAIR_ID, planHash: plan.planHash, state: "applying" },
			{
				$set: {
					state: "applied",
					appliedAt: clock(),
					updatedAt: clock(),
					lastError: null,
				},
			},
			WRITE_OPTIONS
		);
		if (matchedCount(completion) !== 1) {
			fail("The reconciliation manifest completion fence was lost.");
		}
		return { state: "applied", results, vendorApiCalls: 0 };
	} catch (error) {
		await collection.updateOne(
			{ _id: REPAIR_ID, planHash: plan.planHash, state: "applying" },
			{
				$set: {
					state: "attention",
					updatedAt: clock(),
					lastError: {
						code: clean(error?.code || "HOTELRUNNER_RECONCILIATION_FAILED").slice(0, 100),
						message: safeErrorMessage(error).slice(0, 300),
						at: clock(),
					},
				},
			},
			WRITE_OPTIONS
		);
		throw error;
	}
}

function sanitizedPlan(plan, mode) {
	const stateCounts = plan.scopes.reduce((counts, scope) => {
		counts[scope.repairState] = Number(counts[scope.repairState] || 0) + 1;
		return counts;
	}, {});
	return {
		mode,
		repairId: mode === "apply" ? REPAIR_ID : undefined,
		hotelName: plan.hotelName,
		auditDay: "2026-08-07",
		targetCount: plan.scopes.length,
		tripRequeueCount: plan.scopes.filter(
			(scope) => scope.target.action === "trip_requeue"
		).length,
		agodaCommercialBackfillCount: plan.scopes.filter(
			(scope) => scope.target.action === "agoda_backfill"
		).length,
		stateCounts,
		commissionZeroTargetCount: plan.scopes.length,
		verifiedOtaCommissionCount: plan.scopes.filter(
			(scope) => Boolean(scope.bridge?.evidence)
		).length,
		unknownOtaCommissionCount: plan.scopes.filter(
			(scope) => !scope.bridge?.evidence
		).length,
		mutatesLifecycleStayRoomsPayments: false,
		createsReservations: false,
		vendorApiCalls: 0,
	};
}

async function connectDatabase(database) {
	await mongoose.connect(database, {
		useNewUrlParser: true,
		useUnifiedTopology: true,
		autoIndex: false,
		autoCreate: false,
	});
	return mongoose.connection.db;
}

async function main(
	argv = process.argv.slice(2),
	{
		config = getHotelRunnerConfig(),
		connect = connectDatabase,
		disconnect = async () => mongoose.disconnect(),
		clock = () => new Date(),
		...dependencies
	} = {}
) {
	const options = parseArguments(argv);
	const database =
		process.env.DATABASE || process.env.MONGO_URI || process.env.MONGODB_URI;
	if (!database && !dependencies.db) fail("Missing DATABASE/MONGO connection string.");
	let connectedHere = false;
	try {
		const db = dependencies.db || (await connect(database));
		connectedHere = !dependencies.db;
		const plan = await loadPlan(
			config,
			{ clock, ...dependencies },
			{ apply: options.apply }
		);
		console.log(
			JSON.stringify(
				sanitizedPlan(plan, options.apply ? "apply" : "dry_run"),
				null,
				2
			)
		);
		if (!options.apply) return { state: "dry_run_ready", plan };
		const result = await applyPlan(plan, { db, clock, ...dependencies });
		console.log(
			JSON.stringify(
				{
					state: result.state,
					repairId: REPAIR_ID,
					targetCount: plan.scopes.length,
					vendorApiCalls: 0,
				},
				null,
				2
			)
		);
		return result;
	} finally {
		if (connectedHere) await disconnect();
	}
}

if (require.main === module) {
	main().catch((error) => {
		console.error("[hotelrunner-priority-commission-reconciliation] stopped", {
			code: clean(error?.code || "HOTELRUNNER_RECONCILIATION_FAILED").slice(0, 100),
			message: safeErrorMessage(error),
		});
		process.exitCode = 1;
	});
}

module.exports = {
	AUDIT_DAY_END,
	AUDIT_DAY_START,
	COMMERCIAL_STALE_CODE,
	CURRENCY_REVIEW_CODE,
	EXACT_TARGETS,
	EXPECTED_HOTEL_ID,
	MANIFEST_COLLECTION,
	REPAIR_ID,
	agodaEventResolutionUpdate,
	agodaMirrorResolutionUpdate,
	agodaReservationBackfillUpdate,
	applyPlan,
	applyScope,
	assertManifestTargetResumeSafe,
	assertBridge,
	assertExactEvent,
	assertOperationalScope,
	commercialBackfillSet,
	eventCasFilter,
	eventHandedOff,
	exactEventFilter,
	exactReservationFilter,
	immutablePlanHash,
	immutableScopeEntry,
	loadPlan,
	loadTargetScope,
	main,
	manifestDocument,
	mirrorCasFilter,
	mirrorResolutionSatisfied,
	normalizedFromStoredEvent,
	parseArguments,
	repairSnapshot,
	reservationBackfillSatisfied,
	reservationCasFilter,
	sanitizedPlan,
	setMatchesDocument,
	storedEventProviderKeys,
	targetRepairState,
	tripRequeueUpdate,
	updateOnceWithReadback,
};
