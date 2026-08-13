/** @format */

"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
	AUDIT_ACTION,
	AUDIT_SOURCE,
	REPAIR_ID,
	REPAIR_VERSION,
	assessCandidate,
	buildAuditMarker,
	buildPlan,
	candidateCasFilter,
	candidateUpdate,
	parseArguments,
	repairedPostcondition,
	runReconciliation,
} = require("./reconcileReleasedOtaInventoryBlocks20260813");

const HOTEL_ID = "6a40b6a1a6efe70450536038";
const RESERVATION_ID = "68a000000000000000000001";
const RELEASED_AT = new Date("2026-08-13T19:35:15.199Z");
const UPDATED_AT = new Date("2026-08-13T19:40:00.000Z");

function pricingByDay() {
	return Array.from({ length: 8 }, (_, index) => ({
		date: new Date(Date.UTC(2026, 7, 13 + index)),
		price: 60.15,
		rootPrice: 51,
	}));
}

function safeReservation(overrides = {}) {
	const room = {
		room_type: "doubleRooms",
		displayName: "Double Room",
		count: 1,
		pricingByDay: pricingByDay(),
	};
	const reservation = {
		_id: RESERVATION_ID,
		__v: 7,
		updatedAt: UPDATED_AT,
		confirmation_number: "5482777647",
		reservation_id: "2041081954",
		hotelId: HOTEL_ID,
		checkin_date: new Date("2026-08-13T00:00:00.000Z"),
		checkout_date: new Date("2026-08-21T00:00:00.000Z"),
		reservation_status: "Pending Confirmation",
		state: "Pending Confirmation",
		otaIdentityKey: "agoda:2041081954",
		customer_details: { confirmation_number2: "2041081954" },
		supplierData: {
			otaProvider: "agoda",
			otaConfirmationNumber: "2041081954",
			platformConfirmationNumber: "2041081954",
		},
		otaPlatformReview: {
			status: "released",
			provider: "agoda",
			releasedAt: RELEASED_AT,
			releasedBy: { _id: "64a000000000000000000001", role: 1000 },
		},
		pendingConfirmation: {
			status: "pending",
			source: "ota_platform_release",
			releasedToHotelAt: RELEASED_AT,
			lastUpdatedAt: RELEASED_AT,
			rejectionReason: "",
			confirmationReason: "",
			confirmedAt: null,
			rejectedAt: null,
		},
		reservationAuditLog: [
			{
				at: RELEASED_AT,
				source: "ota-review",
				action: "released-to-hotel",
				by: { _id: "64a000000000000000000001", role: 1000 },
				to: { reservation_status: "Pending Confirmation" },
			},
		],
		pickedRoomsType: [structuredClone(room)],
		pickedRoomsPricing: [structuredClone(room)],
		total_rooms: 1,
	};
	return { ...reservation, ...overrides };
}

function confirmedFinancialReservation(status = "Pending Finance Review") {
	const reservation = safeReservation({
		reservation_status: status,
		state: status,
	});
	const confirmedAt = new Date("2026-08-13T19:36:15.199Z");
	const confirmationAuditAt = new Date("2026-08-13T19:36:15.200Z");
	const actor = { _id: "64a000000000000000000002", role: "reservationemployee" };
	const beforePending = structuredClone(reservation.pendingConfirmation);
	const afterPending = {
		...structuredClone(beforePending),
		status: "confirmed",
		confirmationReason: "Hotel confirmed the reservation.",
		confirmedAt,
		lastUpdatedAt: confirmedAt,
		lastUpdatedBy: actor,
	};
	const beforeDecision = {};
	const afterDecision = {
		status: "confirmed",
		reason: "Hotel confirmed the reservation.",
		decidedAt: confirmedAt,
		decidedBy: actor,
	};
	reservation.pendingConfirmation = afterPending;
	reservation.agentDecisionSnapshot = afterDecision;
	reservation.reservationAuditLog.push(
		{
			at: confirmationAuditAt,
			action: "reservation_update",
			field: "reservation_status",
			by: actor,
			from: "Pending Confirmation",
			to: status,
		},
		{
			at: confirmationAuditAt,
			action: "reservation_update",
			field: "pendingConfirmation",
			by: actor,
			from: beforePending,
			to: afterPending,
		},
		{
			at: confirmationAuditAt,
			action: "reservation_update",
			field: "agentDecisionSnapshot",
			by: actor,
			from: beforeDecision,
			to: afterDecision,
		}
	);
	return reservation;
}

function safePlan(reservation = safeReservation()) {
	return buildPlan({
		reservations: [reservation],
		hotels: [{ _id: HOTEL_ID }],
		identityDocuments: [reservation],
	});
}

test("CLI is dry-run by default and apply requires the exact repair ID and proof", () => {
	assert.deepEqual(parseArguments([]), { apply: false, proof: "", repairId: "" });
	assert.throws(() => parseArguments(["--apply"]), /repair-id/i);
	assert.throws(
		() =>
			parseArguments([
				"--apply",
				`--repair-id=${REPAIR_ID}`,
				"--proof=bad",
			]),
		/exact 64-character proof/i
	);
	assert.deepEqual(
		parseArguments([
			"--apply",
			`--repair-id=${REPAIR_ID}`,
			`--proof=${"a".repeat(64)}`,
		]),
		{ apply: true, repairId: REPAIR_ID, proof: "a".repeat(64) }
	);
	assert.throws(
		() => parseArguments([`--repair-id=${REPAIR_ID}`]),
		/only with --apply/i
	);
});

test("the production-shaped released pending row is eligible only with exact stay and room invariants", () => {
	const reservation = safeReservation();
	assert.deepEqual(assessCandidate(reservation, { hotelExists: true }), {
		eligible: true,
		confirmationAudit: null,
		identities: ["agoda:2041081954"],
		lifecycle: "released_pending_confirmation",
		nights: 8,
		releaseAudit: reservation.reservationAuditLog[0],
		previousInventoryBlocks: "missing",
		roomCount: 1,
	});

	const divergentRooms = safeReservation({
		pickedRoomsType: [
			{
				...reservation.pickedRoomsType[0],
				count: 2,
			},
		],
	});
	assert.equal(
		assessCandidate(divergentRooms, { hotelExists: true }).reason,
		"room_arrays_invalid_or_divergent"
	);

	const shiftedNight = safeReservation();
	shiftedNight.pickedRoomsType[0].pricingByDay[0].date = new Date(
		"2026-08-12T00:00:00.000Z"
	);
	shiftedNight.pickedRoomsPricing = structuredClone(shiftedNight.pickedRoomsType);
	assert.equal(
		assessCandidate(shiftedNight, { hotelExists: true }).reason,
		"room_nightly_dates_conflict"
	);
});

test("a hotel-confirmed financial workflow is eligible only with the exact audited transition triple", () => {
	for (const status of [
		"Pending Finance Review",
		"Pending Agent Commission Approval",
		"Finance Rejected",
	]) {
		const reservation = confirmedFinancialReservation(status);
		const assessment = assessCandidate(reservation, { hotelExists: true });
		assert.equal(assessment.eligible, true, status);
		assert.equal(assessment.lifecycle, "hotel_confirmed_financial_workflow");
		assert.equal(assessment.confirmationAudit.statusAudit.to, status);
	}

	const missingDecisionAudit = confirmedFinancialReservation();
	missingDecisionAudit.reservationAuditLog.pop();
	assert.equal(
		assessCandidate(missingDecisionAudit, { hotelExists: true }).reason,
		"hotel_confirmation_audit_missing_or_conflicting"
	);

	const wrongActor = confirmedFinancialReservation();
	wrongActor.reservationAuditLog.at(-1).by = {
		_id: "64a000000000000000000003",
		role: "reservationemployee",
	};
	assert.equal(
		assessCandidate(wrongActor, { hotelExists: true }).reason,
		"hotel_confirmation_audit_missing_or_conflicting"
	);
});

test("terminal and lifecycle-inconsistent rows are excluded instead of being inventory-blocked", () => {
	for (const [label, mutate, expected] of [
		[
			"cancelled status",
			(reservation) => {
				reservation.reservation_status = "cancelled";
				reservation.state = "cancelled";
			},
			"reservation_lifecycle_inconsistent",
		],
		[
			"rejection timestamp",
			(reservation) => {
				reservation.pendingConfirmation.rejectedAt = RELEASED_AT;
			},
			"terminal_release_metadata_present",
		],
		[
			"historical revert marker",
			(reservation) => {
				reservation.pendingConfirmation.revertedAt = new Date(
					"2026-08-13T19:36:15.199Z"
				);
			},
			"terminal_release_metadata_present",
		],
		[
			"mismatched release timestamps",
			(reservation) => {
				reservation.pendingConfirmation.releasedToHotelAt = new Date(
					"2026-08-13T19:35:16.199Z"
				);
			},
			"release_timestamps_invalid",
		],
		[
			"already blocking",
			(reservation) => {
				reservation.pendingConfirmation.inventoryBlocks = true;
			},
			"inventory_block_state_not_repairable",
		],
		[
			"explicit non-blocking decision",
			(reservation) => {
				reservation.pendingConfirmation.inventoryBlocks = false;
			},
			"inventory_block_state_not_repairable",
		],
		[
			"missing release audit",
			(reservation) => {
				reservation.reservationAuditLog = [];
			},
			"release_audit_missing_or_conflicting",
		],
		[
			"release actor mismatch",
			(reservation) => {
				reservation.reservationAuditLog[0].by = {
					_id: "64a000000000000000000002",
					role: 1000,
				};
			},
			"release_audit_missing_or_conflicting",
		],
	]) {
		const reservation = safeReservation();
		mutate(reservation);
		assert.equal(
			assessCandidate(reservation, { hotelExists: true }).reason,
			expected,
			label
		);
	}
});

test("duplicate provider-scoped OTA identity excludes every ambiguous row", () => {
	const first = safeReservation();
	const second = safeReservation({
		_id: "68a000000000000000000002",
		confirmation_number: "5482777648",
	});
	const plan = buildPlan({
		reservations: [first],
		hotels: [{ _id: HOTEL_ID }],
		identityDocuments: [first, second],
	});
	assert.equal(plan.candidates.length, 0);
	assert.deepEqual(plan.excludedByReason, { duplicate_ota_identity: 1 });
});

test("the CAS filter binds version, updatedAt, lifecycle, release, stay, identities, and exact room arrays", () => {
	const candidate = safePlan().candidates[0];
	const filter = candidateCasFilter(candidate);
	assert.equal(filter._id, RESERVATION_ID);
	assert.equal(filter.__v, 7);
	assert.equal(filter.updatedAt, UPDATED_AT);
	assert.equal(filter.confirmation_number, "5482777647");
	assert.equal(filter.reservation_status, "Pending Confirmation");
	assert.equal(filter.state, "Pending Confirmation");
	assert.equal(filter["otaPlatformReview.status"], "released");
	assert.equal(filter["pendingConfirmation.status"], "pending");
	assert.equal(filter["pendingConfirmation.source"], "ota_platform_release");
	assert.equal(filter["pendingConfirmation.releasedToHotelAt"], RELEASED_AT);
	assert.deepEqual(
		filter.pendingConfirmation,
		candidate.reservation.pendingConfirmation
	);
	assert.deepEqual(
		filter.otaPlatformReview,
		candidate.reservation.otaPlatformReview
	);
	assert.deepEqual(filter["pendingConfirmation.inventoryBlocks"], {
		$exists: false,
	});
	assert.deepEqual(filter["reservationAuditLog.repairId"], { $ne: REPAIR_ID });
	assert.deepEqual(filter.$and[0].reservationAuditLog, {
		$elemMatch: {
			at: candidate.releaseAudit.at,
			source: candidate.releaseAudit.source,
			action: candidate.releaseAudit.action,
			by: candidate.releaseAudit.by,
			"to.reservation_status": "Pending Confirmation",
		},
	});
	assert.deepEqual(filter.pickedRoomsType, candidate.reservation.pickedRoomsType);
	assert.deepEqual(
		filter.pickedRoomsPricing,
		candidate.reservation.pickedRoomsPricing
	);
});

test("an explicit false inventory marker is preserved as a deliberate non-blocking decision", () => {
	const reservation = safeReservation();
	reservation.pendingConfirmation.inventoryBlocks = false;
	const plan = safePlan(reservation);
	assert.equal(plan.candidates.length, 0);
	assert.deepEqual(plan.excludedByReason, {
		inventory_block_state_not_repairable: 1,
	});
});

test("the update changes only the inventory flag, version/timestamp, and one bounded dated audit marker", () => {
	const candidate = safePlan().candidates[0];
	const at = new Date("2026-08-13T21:00:00.000Z");
	const marker = buildAuditMarker(candidate, at);
	assert.equal(JSON.stringify(marker).length < 512, true);
	assert.deepEqual(marker, {
		at,
		source: AUDIT_SOURCE,
		action: AUDIT_ACTION,
		repairId: REPAIR_ID,
		version: REPAIR_VERSION,
		previousInventoryBlocks: "missing",
		inventoryBlocks: true,
	});
	assert.deepEqual(candidateUpdate(candidate, at), {
		$set: {
			"pendingConfirmation.inventoryBlocks": true,
			updatedAt: at,
		},
		$inc: { __v: 1 },
		$push: { reservationAuditLog: marker },
	});
});

test("dry-run returns the exact plan and performs no database write", async () => {
	const plan = safePlan();
	let writes = 0;
	const report = await runReconciliation(
		{ apply: false, proof: "", repairId: "" },
		{
			loadPlan: async () => plan,
			ReservationModel: {
				bulkWrite: async () => {
					writes += 1;
					throw new Error("dry-run attempted a write");
				},
			},
		}
	);
	assert.equal(writes, 0);
	assert.equal(report.mode, "dry-run");
	assert.equal(report.candidateCount, 1);
	assert.equal(report.candidateRoomCount, 1);
	assert.match(report.proof, /^[a-f0-9]{64}$/);
	assert.match(report.applyCommand, new RegExp(report.proof));
});

test("apply rejects a stale proof before the mocked write boundary", async () => {
	const plan = safePlan();
	let writes = 0;
	await assert.rejects(
		runReconciliation(
			{ apply: true, proof: "f".repeat(64), repairId: REPAIR_ID },
			{
				loadPlan: async () => plan,
				ReservationModel: {
					bulkWrite: async () => {
						writes += 1;
					},
				},
			}
		),
		(error) => error.code === "OTA_INVENTORY_RECONCILIATION_PROOF_MISMATCH"
	);
	assert.equal(writes, 0);
});

test("mocked apply verifies one exact audit marker and preserves immutable state", async () => {
	const plan = safePlan();
	const at = new Date("2026-08-13T21:00:00.000Z");
	let operations = null;
	const after = structuredClone(plan.candidates[0].reservation);
	after.__v += 1;
	after.updatedAt = at;
	after.pendingConfirmation.inventoryBlocks = true;
	after.reservationAuditLog.push(buildAuditMarker(plan.candidates[0], at));
	const report = await runReconciliation(
		{ apply: true, proof: plan.proof, repairId: REPAIR_ID },
		{
			loadPlan: async () => plan,
			ReservationModel: {
				bulkWrite: async (nextOperations) => {
					operations = nextOperations;
					return { matchedCount: 1, modifiedCount: 1 };
				},
			},
			clock: () => at,
			readBack: async () => [after],
		}
	);
	assert.equal(operations.length, 1);
	assert.equal(operations[0].updateOne.timestamps, false);
	assert.equal(report.mode, "apply");
	assert.equal(report.appliedCount, 1);
	assert.equal(
		repairedPostcondition(plan.candidates[0], after, at),
		true
	);
});
