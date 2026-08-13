/** @format */

"use strict";

/**
 * One-time reconciliation for OTA reservations released to hotel confirmation
 * before `pendingConfirmation.inventoryBlocks` was stamped by the release
 * controller.
 *
 * Dry-run (default):
 *   node scripts/reconcileReleasedOtaInventoryBlocks20260813.js
 *
 * Apply the exact unchanged dry-run plan:
 *   node scripts/reconcileReleasedOtaInventoryBlocks20260813.js \
 *     --apply \
 *     --repair-id=released-ota-inventory-blocks-20260813-v1 \
 *     --proof=<64-character proof emitted by dry-run>
 *
 * This utility never changes lifecycle, stay, room, hotel, guest, payment, or
 * financial fields. Each write is fenced by the exact version, updatedAt,
 * lifecycle, release timestamps, stay, identity, and current room arrays read
 * during planning. Terminal or internally inconsistent rows are reported and
 * excluded.
 */

const crypto = require("node:crypto");
const path = require("node:path");

require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const mongoose = require("mongoose");

// A reconciliation must never create or rebuild indexes on the live PMS DB.
mongoose.set("autoIndex", false);
mongoose.set("autoCreate", false);

const HotelDetails = require("../models/hotel_details");
const Reservations = require("../models/reservations");

const REPAIR_ID = "released-ota-inventory-blocks-20260813-v1";
const REPAIR_VERSION = 1;
const REPAIR_CUTOFF = new Date("2026-08-13T00:00:00.000Z");
const MAX_CANDIDATES = 500;
const MAX_STAY_NIGHTS = 400;
const MAX_ROOM_LINES = 50;
const AUDIT_SOURCE = "ota-inventory-reconciliation";
const AUDIT_ACTION = "released-ota-inventory-block-enabled";
const WRITE_OPTIONS = Object.freeze({ ordered: true, writeConcern: { w: "majority" } });

const TERMINAL_METADATA_KEY_PATTERN =
	/(?:cancel|reject|void|no.?show|checked.?in|checked.?out|closed|revert)/i;
const PENDING_CONFIRMATION_EXACT = /^pending[\s_-]+confirmation$/i;
const POST_HOTEL_CONFIRMATION_EXACT =
	/^(?:pending[\s_-]+finance[\s_-]+review|pending[\s_-]+agent[\s_-]+commission[\s_-]+approval|finance[\s_-]+rejected)$/i;

const CANDIDATE_FILTER = Object.freeze({
	"otaPlatformReview.status": "released",
	"pendingConfirmation.source": "ota_platform_release",
	$and: [
		{
			$or: [
				{ "pendingConfirmation.inventoryBlocks": { $exists: false } },
				{ "pendingConfirmation.inventoryBlocks": false },
			],
		},
		{
			$or: [
				{
					reservation_status: PENDING_CONFIRMATION_EXACT,
					state: PENDING_CONFIRMATION_EXACT,
					"pendingConfirmation.status": "pending",
				},
				{
					reservation_status: POST_HOTEL_CONFIRMATION_EXACT,
					state: POST_HOTEL_CONFIRMATION_EXACT,
					"pendingConfirmation.status": "confirmed",
				},
			],
		},
	],
	"reservationAuditLog.repairId": { $ne: REPAIR_ID },
});

const CANDIDATE_PROJECTION = [
	"_id",
	"__v",
	"updatedAt",
	"confirmation_number",
	"reservation_id",
	"hotelId",
	"checkin_date",
	"checkout_date",
	"reservation_status",
	"state",
	"cancel_reason",
	"cancelReason",
	"cancellationReason",
	"cancelledAt",
	"noShowAt",
	"otaIdentityKey",
	"otaCrossTransportIdentityKey",
	"customer_details.confirmation_number2",
	"supplierData.otaProvider",
	"supplierData.suppliedBookingNo",
	"supplierData.otaConfirmationNumber",
	"supplierData.platformConfirmationNumber",
	"otaPlatformReview",
	"pendingConfirmation",
	"agentDecisionSnapshot",
	"financial_cycle.totalReviewStatus",
	"reservationAuditLog",
	"pickedRoomsType",
	"pickedRoomsPricing",
	"total_rooms",
].join(" ");

const IDENTITY_PROJECTION = [
	"_id",
	"booking_source",
	"otaIdentityKey",
	"otaCrossTransportIdentityKey",
	"reservation_id",
	"customer_details.confirmation_number2",
	"supplierData.otaProvider",
	"supplierData.suppliedBookingNo",
	"supplierData.otaConfirmationNumber",
	"supplierData.platformConfirmationNumber",
	"otaPlatformReview.provider",
].join(" ");

function fail(message, code = "OTA_INVENTORY_RECONCILIATION_BLOCKED") {
	const error = new Error(message);
	error.code = code;
	throw error;
}

function clean(value = "") {
	return String(value?._id || value?.id || value || "").trim();
}

function normalizedStatus(value = "") {
	return String(value || "")
		.trim()
		.toLowerCase()
		.replace(/[\s_-]+/g, " ");
}

function providerKey(value = "") {
	const compact = normalizedStatus(value).replace(/[^a-z0-9]+/g, "");
	if (["trip", "tripcom", "ctrip", "ctripcom"].includes(compact)) return "trip";
	if (["agoda", "agodacom"].includes(compact)) return "agoda";
	if (["expedia", "expediacom", "hotelscom"].includes(compact)) return "expedia";
	if (["airbnb", "airbnbcom"].includes(compact)) return "airbnb";
	if (["booking", "bookingcom"].includes(compact)) return "booking";
	if (["hotelrunner", "hotelrunnercom"].includes(compact)) return "hotelrunner";
	return compact;
}

function validDate(value) {
	if (!value) return false;
	const parsed = value instanceof Date ? value : new Date(value);
	return Number.isFinite(parsed.getTime());
}

function dateMs(value) {
	return validDate(value) ? new Date(value).getTime() : NaN;
}

function iso(value) {
	return validDate(value) ? new Date(value).toISOString() : "";
}

function isUtcMidnight(value) {
	return validDate(value) && /T00:00:00\.000Z$/.test(iso(value));
}

function hasOwn(object, key) {
	return Boolean(
		object &&
			typeof object === "object" &&
			Object.prototype.hasOwnProperty.call(object, key)
	);
}

function hasMeaningfulValue(value) {
	if (value === null || value === undefined || value === "") return false;
	if (typeof value === "string") return Boolean(value.trim());
	if (typeof value === "boolean") return value;
	if (typeof value === "number") return value !== 0;
	if (Array.isArray(value)) return value.length > 0;
	return true;
}

function stableValue(value) {
	if (value === undefined) return { $undefined: true };
	if (value === null) return null;
	if (value instanceof Date) return { $date: value.toISOString() };
	if (Buffer.isBuffer(value)) return { $buffer: value.toString("hex") };
	if (Array.isArray(value)) return value.map(stableValue);
	if (value && typeof value === "object") {
		if (
			typeof value.toHexString === "function" &&
			/^[a-f0-9]{24}$/i.test(value.toHexString())
		) {
			return { $oid: value.toHexString() };
		}
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map((key) => [key, stableValue(value[key])])
		);
	}
	return value;
}

function stableStringify(value) {
	return JSON.stringify(stableValue(value));
}

function sha256(value) {
	return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function dateOnlyKey(value) {
	if (!validDate(value)) return "";
	return new Date(value).toISOString().slice(0, 10);
}

function expectedStayDates(checkin, checkout) {
	const start = dateMs(checkin);
	const end = dateMs(checkout);
	if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
	const difference = end - start;
	if (difference % 86_400_000 !== 0) return [];
	const nights = difference / 86_400_000;
	if (nights < 1 || nights > MAX_STAY_NIGHTS) return [];
	return Array.from({ length: nights }, (_, index) =>
		new Date(start + index * 86_400_000).toISOString().slice(0, 10)
	);
}

function explicitInventoryState(reservation = {}) {
	const pending = reservation.pendingConfirmation;
	if (!pending || typeof pending !== "object" || Array.isArray(pending)) {
		return "invalid";
	}
	if (!hasOwn(pending, "inventoryBlocks")) return "missing";
	if (pending.inventoryBlocks === false) return "false";
	return "invalid";
}

function normalizedAuditActor(value = {}) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const actor = {
		id: clean(value._id || value.id),
		name: String(value.name || "").trim(),
		email: String(value.email || "").trim().toLowerCase(),
		role: String(value.role || "").trim().toLowerCase(),
	};
	return actor.id || actor.name || actor.email ? actor : null;
}

function matchingReleaseAudit(reservation = {}) {
	const review = reservation.otaPlatformReview || {};
	const expectedActor = normalizedAuditActor(review.releasedBy);
	if (!expectedActor || !validDate(review.releasedAt)) return null;
	const audits = Array.isArray(reservation.reservationAuditLog)
		? reservation.reservationAuditLog
		: [];
	const matching = audits.filter(
		(entry) =>
			entry &&
			typeof entry === "object" &&
			entry.action === "released-to-hotel" &&
			["ota-review", "ota-incident-repair"].includes(entry.source) &&
			dateMs(entry.at) === dateMs(review.releasedAt) &&
			normalizedStatus(entry?.to?.reservation_status) ===
				"pending confirmation" &&
			stableStringify(normalizedAuditActor(entry.by)) ===
				stableStringify(expectedActor)
	);
	return matching.length === 1 ? matching[0] : null;
}

function matchingHotelConfirmationAudit(reservation = {}) {
	const pending = reservation.pendingConfirmation || {};
	const decision = reservation.agentDecisionSnapshot || {};
	const expectedActor = normalizedAuditActor(pending.lastUpdatedBy);
	if (
		normalizedStatus(pending.status) !== "confirmed" ||
		!expectedActor ||
		!validDate(pending.confirmedAt) ||
		!validDate(pending.lastUpdatedAt) ||
		dateMs(pending.confirmedAt) !== dateMs(pending.lastUpdatedAt) ||
		String(pending.source || "").trim() !== "ota_platform_release" ||
		!validDate(pending.releasedToHotelAt) ||
		normalizedStatus(decision.status) !== "confirmed" ||
		!validDate(decision.decidedAt) ||
		dateMs(decision.decidedAt) !== dateMs(pending.confirmedAt) ||
		stableStringify(normalizedAuditActor(decision.decidedBy)) !==
			stableStringify(expectedActor)
	) {
		return null;
	}
	const audits = Array.isArray(reservation.reservationAuditLog)
		? reservation.reservationAuditLog
		: [];
	const pendingAudits = audits.filter(
		(entry) =>
			entry &&
			typeof entry === "object" &&
			entry.action === "reservation_update" &&
			entry.field === "pendingConfirmation" &&
			normalizedStatus(entry?.from?.status) === "pending" &&
			normalizedStatus(entry?.to?.status) === "confirmed" &&
			String(entry?.from?.source || "").trim() === "ota_platform_release" &&
			String(entry?.to?.source || "").trim() === "ota_platform_release" &&
			dateMs(entry?.from?.releasedToHotelAt) ===
				dateMs(pending.releasedToHotelAt) &&
			dateMs(entry?.to?.releasedToHotelAt) === dateMs(pending.releasedToHotelAt) &&
			dateMs(entry?.to?.confirmedAt) === dateMs(pending.confirmedAt) &&
			dateMs(entry?.to?.lastUpdatedAt) === dateMs(pending.lastUpdatedAt) &&
			Math.abs(dateMs(entry.at) - dateMs(pending.confirmedAt)) <= 5_000 &&
			stableStringify(normalizedAuditActor(entry.by)) ===
				stableStringify(expectedActor) &&
			stableStringify(normalizedAuditActor(entry?.to?.lastUpdatedBy)) ===
				stableStringify(expectedActor)
	);
	if (pendingAudits.length !== 1) return null;
	const pendingAudit = pendingAudits[0];
	const statusAudits = audits.filter(
		(entry) =>
			entry &&
			typeof entry === "object" &&
			entry.action === "reservation_update" &&
			entry.field === "reservation_status" &&
			dateMs(entry.at) === dateMs(pendingAudit.at) &&
			normalizedStatus(entry.from) === "pending confirmation" &&
			[
				"pending finance review",
				"pending agent commission approval",
				"finance rejected",
			].includes(normalizedStatus(entry.to)) &&
			stableStringify(normalizedAuditActor(entry.by)) ===
				stableStringify(expectedActor)
	);
	const decisionAudits = audits.filter(
		(entry) =>
			entry &&
			typeof entry === "object" &&
			entry.action === "reservation_update" &&
			entry.field === "agentDecisionSnapshot" &&
			dateMs(entry.at) === dateMs(pendingAudit.at) &&
			normalizedStatus(entry?.to?.status) === "confirmed" &&
			dateMs(entry?.to?.decidedAt) === dateMs(pending.confirmedAt) &&
			stableStringify(normalizedAuditActor(entry.by)) ===
				stableStringify(expectedActor) &&
			stableStringify(normalizedAuditActor(entry?.to?.decidedBy)) ===
				stableStringify(expectedActor)
	);
	return statusAudits.length === 1 && decisionAudits.length === 1
		? {
				at: pendingAudit.at,
				by: pendingAudit.by,
				decisionAudit: decisionAudits[0],
				pendingAudit,
				statusAudit: statusAudits[0],
		  }
		: null;
}

function terminalMetadataPresent(value = {}) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	return Object.entries(value).some(
		([key, fieldValue]) =>
			TERMINAL_METADATA_KEY_PATTERN.test(key) && hasMeaningfulValue(fieldValue)
	);
}

function reservationProvider(reservation = {}) {
	return providerKey(
		reservation?.supplierData?.otaProvider ||
			reservation?.otaPlatformReview?.provider ||
			reservation?.booking_source
	);
}

function identityTokens(reservation = {}) {
	const provider = reservationProvider(reservation);
	const tokens = new Set();
	for (const canonical of [
		reservation.otaIdentityKey,
		reservation.otaCrossTransportIdentityKey,
	]) {
		const value = normalizedStatus(canonical);
		if (value && value.includes(":")) tokens.add(value.replace(/\s+/g, ""));
	}
	if (provider) {
		for (const confirmation of [
			reservation.reservation_id,
			reservation?.customer_details?.confirmation_number2,
			reservation?.supplierData?.suppliedBookingNo,
			reservation?.supplierData?.otaConfirmationNumber,
			reservation?.supplierData?.platformConfirmationNumber,
		]) {
			const value = normalizedStatus(confirmation).replace(/\s+/g, "");
			if (value) tokens.add(`${provider}:${value}`);
		}
	}
	return Array.from(tokens).sort();
}

function validateRoomLines(reservation = {}) {
	const rooms = reservation.pickedRoomsPricing;
	const mirroredRooms = reservation.pickedRoomsType;
	if (
		!Array.isArray(rooms) ||
		rooms.length < 1 ||
		rooms.length > MAX_ROOM_LINES ||
		!Array.isArray(mirroredRooms) ||
		stableStringify(rooms) !== stableStringify(mirroredRooms)
	) {
		return { ok: false, reason: "room_arrays_invalid_or_divergent" };
	}
	const expectedDates = expectedStayDates(
		reservation.checkin_date,
		reservation.checkout_date
	);
	if (!expectedDates.length) return { ok: false, reason: "stay_dates_invalid" };

	let totalRooms = 0;
	for (const room of rooms) {
		if (!room || typeof room !== "object" || Array.isArray(room)) {
			return { ok: false, reason: "room_line_malformed" };
		}
		const count = Number(room.count ?? 1);
		if (!Number.isInteger(count) || count < 1 || count > 100) {
			return { ok: false, reason: "room_count_invalid" };
		}
		if (!String(room.room_type || room.displayName || "").trim()) {
			return { ok: false, reason: "room_identity_missing" };
		}
		const pricingByDay = room.pricingByDay;
		if (!Array.isArray(pricingByDay) || pricingByDay.length !== expectedDates.length) {
			return { ok: false, reason: "room_nightly_rows_incomplete" };
		}
		const actualDates = pricingByDay.map((day) => dateOnlyKey(day?.date));
		if (stableStringify(actualDates) !== stableStringify(expectedDates)) {
			return { ok: false, reason: "room_nightly_dates_conflict" };
		}
		totalRooms += count;
	}
	if (
		!Number.isInteger(Number(reservation.total_rooms)) ||
		Number(reservation.total_rooms) < 1 ||
		totalRooms !== Number(reservation.total_rooms)
	) {
		return { ok: false, reason: "total_rooms_conflict" };
	}
	return { ok: true, roomCount: totalRooms, nights: expectedDates.length };
}

function releasedInventoryLifecycle(reservation = {}) {
	const reservationStatus = normalizedStatus(reservation.reservation_status);
	const state = normalizedStatus(reservation.state);
	const pendingStatus = normalizedStatus(reservation?.pendingConfirmation?.status);
	if (
		reservationStatus === "pending confirmation" &&
		state === "pending confirmation" &&
		pendingStatus === "pending"
	) {
		return "released_pending_confirmation";
	}
	if (
		reservationStatus === state &&
		[
			"pending finance review",
			"pending agent commission approval",
			"finance rejected",
		].includes(reservationStatus) &&
		pendingStatus === "confirmed"
	) {
		return "hotel_confirmed_financial_workflow";
	}
	return "";
}

function assessCandidate(reservation = {}, { hotelExists = false } = {}) {
	const reject = (reason) => ({ eligible: false, reason });
	if (!clean(reservation._id)) return reject("reservation_id_invalid");
	if (!Number.isInteger(Number(reservation.__v)) || Number(reservation.__v) < 0) {
		return reject("version_invalid");
	}
	if (!validDate(reservation.updatedAt)) return reject("updated_at_invalid");
	if (!mongoose.Types.ObjectId.isValid(clean(reservation.hotelId)) || !hotelExists) {
		return reject("hotel_invalid_or_missing");
	}
	const lifecycle = releasedInventoryLifecycle(reservation);
	if (!lifecycle) {
		return reject("reservation_lifecycle_inconsistent");
	}
	if (
		hasMeaningfulValue(reservation.cancel_reason) ||
		hasMeaningfulValue(reservation.cancelReason) ||
		hasMeaningfulValue(reservation.cancellationReason) ||
		hasMeaningfulValue(reservation.cancelledAt) ||
		hasMeaningfulValue(reservation.noShowAt)
	) {
		return reject("terminal_reservation_state");
	}

	const review = reservation.otaPlatformReview;
	const pending = reservation.pendingConfirmation;
	if (
		!review ||
		typeof review !== "object" ||
		Array.isArray(review) ||
		!pending ||
		typeof pending !== "object" ||
		Array.isArray(pending) ||
		normalizedStatus(review.status) !== "released" ||
		String(pending.source || "").trim() !== "ota_platform_release"
	) {
		return reject("release_lifecycle_inconsistent");
	}
	if (terminalMetadataPresent(review) || terminalMetadataPresent(pending)) {
		return reject("terminal_release_metadata_present");
	}
	const releaseAudit = matchingReleaseAudit(reservation);
	if (!releaseAudit) return reject("release_audit_missing_or_conflicting");
	const confirmationAudit =
		lifecycle === "hotel_confirmed_financial_workflow"
			? matchingHotelConfirmationAudit(reservation)
			: null;
	if (
		lifecycle === "hotel_confirmed_financial_workflow" &&
		!confirmationAudit
	) {
		return reject("hotel_confirmation_audit_missing_or_conflicting");
	}
	if (
		!validDate(review.releasedAt) ||
		!validDate(pending.releasedToHotelAt) ||
		dateMs(review.releasedAt) !== dateMs(pending.releasedToHotelAt) ||
		!validDate(pending.lastUpdatedAt)
	) {
		return reject("release_timestamps_invalid");
	}
	if (explicitInventoryState(reservation) !== "missing") {
		return reject("inventory_block_state_not_repairable");
	}
	if (
		!isUtcMidnight(reservation.checkin_date) ||
		!isUtcMidnight(reservation.checkout_date) ||
		dateMs(reservation.checkout_date) <= REPAIR_CUTOFF.getTime()
	) {
		return reject("stay_dates_invalid_or_expired");
	}
	const roomValidation = validateRoomLines(reservation);
	if (!roomValidation.ok) return reject(roomValidation.reason);
	const identities = identityTokens(reservation);
	if (!identities.length) return reject("ota_identity_missing");

	return {
		eligible: true,
		confirmationAudit,
		identities,
		lifecycle,
		nights: roomValidation.nights,
		releaseAudit,
		previousInventoryBlocks: explicitInventoryState(reservation),
		roomCount: roomValidation.roomCount,
	};
}

function exactOrMissing(filter, pathName, object, key) {
	filter[pathName] = hasOwn(object, key) ? object[key] : { $exists: false };
}

function immutableCandidateSnapshot(reservation = {}) {
	return {
		_id: reservation._id,
		hotelId: reservation.hotelId,
		confirmation_number: reservation.confirmation_number,
		reservation_id: reservation.reservation_id,
		reservation_status: reservation.reservation_status,
		state: reservation.state,
		checkin_date: reservation.checkin_date,
		checkout_date: reservation.checkout_date,
		total_rooms: reservation.total_rooms,
		otaIdentityKey: reservation.otaIdentityKey,
		otaCrossTransportIdentityKey: reservation.otaCrossTransportIdentityKey,
		confirmationNumber2: reservation?.customer_details?.confirmation_number2,
		suppliedBookingNo: reservation?.supplierData?.suppliedBookingNo,
		otaConfirmationNumber: reservation?.supplierData?.otaConfirmationNumber,
		platformConfirmationNumber:
			reservation?.supplierData?.platformConfirmationNumber,
		otaProvider: reservation?.supplierData?.otaProvider,
		otaPlatformReview: reservation.otaPlatformReview,
		pendingConfirmation: {
			...(reservation.pendingConfirmation || {}),
			inventoryBlocks: undefined,
		},
		agentDecisionSnapshot: reservation.agentDecisionSnapshot,
		financial_cycle: {
			totalReviewStatus: reservation?.financial_cycle?.totalReviewStatus,
		},
		pickedRoomsType: reservation.pickedRoomsType,
		pickedRoomsPricing: reservation.pickedRoomsPricing,
		cancel_reason: reservation.cancel_reason,
		cancelReason: reservation.cancelReason,
		cancellationReason: reservation.cancellationReason,
		cancelledAt: reservation.cancelledAt,
		noShowAt: reservation.noShowAt,
	};
}

function candidateSnapshot(reservation = {}, assessment = {}) {
	return {
		...immutableCandidateSnapshot(reservation),
		__v: Number(reservation.__v),
		updatedAt: reservation.updatedAt,
		previousInventoryBlocks: assessment.previousInventoryBlocks,
		reservationAuditLogHash: sha256(
			stableStringify(
				Array.isArray(reservation.reservationAuditLog)
					? reservation.reservationAuditLog
					: []
			)
		),
	};
}

function candidateCasFilter(candidate) {
	const reservation = candidate.reservation;
	const pending = reservation.pendingConfirmation || {};
	const review = reservation.otaPlatformReview || {};
	const filter = {
		_id: reservation._id,
		__v: Number(reservation.__v),
		updatedAt: reservation.updatedAt,
		hotelId: reservation.hotelId,
		confirmation_number: reservation.confirmation_number,
		reservation_status: reservation.reservation_status,
		state: reservation.state,
		checkin_date: reservation.checkin_date,
		checkout_date: reservation.checkout_date,
		total_rooms: reservation.total_rooms,
		pickedRoomsType: reservation.pickedRoomsType,
		pickedRoomsPricing: reservation.pickedRoomsPricing,
		otaPlatformReview: review,
		pendingConfirmation: pending,
		agentDecisionSnapshot: reservation.agentDecisionSnapshot,
		"otaPlatformReview.status": review.status,
		"otaPlatformReview.releasedAt": review.releasedAt,
		"pendingConfirmation.status": pending.status,
		"pendingConfirmation.source": pending.source,
		"pendingConfirmation.releasedToHotelAt": pending.releasedToHotelAt,
		"pendingConfirmation.lastUpdatedAt": pending.lastUpdatedAt,
		"reservationAuditLog.repairId": { $ne: REPAIR_ID },
		$and: [
			{
				reservationAuditLog: {
					$elemMatch: {
						at: candidate.releaseAudit.at,
						source: candidate.releaseAudit.source,
						action: candidate.releaseAudit.action,
						by: candidate.releaseAudit.by,
						"to.reservation_status":
							candidate.releaseAudit?.to?.reservation_status,
					},
				},
			},
		],
	};
	if (candidate.confirmationAudit) {
		filter.$and.push(
			{
				reservationAuditLog: {
					$elemMatch: {
						at: candidate.confirmationAudit.pendingAudit.at,
						action: candidate.confirmationAudit.pendingAudit.action,
						field: "pendingConfirmation",
						by: candidate.confirmationAudit.pendingAudit.by,
						from: candidate.confirmationAudit.pendingAudit.from,
						to: candidate.confirmationAudit.pendingAudit.to,
					},
				},
			},
			{
				reservationAuditLog: {
					$elemMatch: {
						at: candidate.confirmationAudit.statusAudit.at,
						action: candidate.confirmationAudit.statusAudit.action,
						field: "reservation_status",
						by: candidate.confirmationAudit.statusAudit.by,
						from: candidate.confirmationAudit.statusAudit.from,
						to: candidate.confirmationAudit.statusAudit.to,
					},
				},
			},
			{
				reservationAuditLog: {
					$elemMatch: {
						at: candidate.confirmationAudit.decisionAudit.at,
						action: candidate.confirmationAudit.decisionAudit.action,
						field: "agentDecisionSnapshot",
						by: candidate.confirmationAudit.decisionAudit.by,
						from: candidate.confirmationAudit.decisionAudit.from,
						to: candidate.confirmationAudit.decisionAudit.to,
					},
				},
			}
		);
	}

	if (candidate.previousInventoryBlocks === "missing") {
		filter["pendingConfirmation.inventoryBlocks"] = { $exists: false };
	} else {
		filter["pendingConfirmation.inventoryBlocks"] = false;
	}
	for (const [pathName, object, key] of [
		["otaIdentityKey", reservation, "otaIdentityKey"],
		[
			"otaCrossTransportIdentityKey",
			reservation,
			"otaCrossTransportIdentityKey",
		],
		["reservation_id", reservation, "reservation_id"],
		[
			"customer_details.confirmation_number2",
			reservation.customer_details || {},
			"confirmation_number2",
		],
		[
			"supplierData.otaProvider",
			reservation.supplierData || {},
			"otaProvider",
		],
		[
			"otaPlatformReview.provider",
			review,
			"provider",
		],
		[
			"supplierData.suppliedBookingNo",
			reservation.supplierData || {},
			"suppliedBookingNo",
		],
		[
			"supplierData.otaConfirmationNumber",
			reservation.supplierData || {},
			"otaConfirmationNumber",
		],
		[
			"supplierData.platformConfirmationNumber",
			reservation.supplierData || {},
			"platformConfirmationNumber",
		],
		["cancel_reason", reservation, "cancel_reason"],
		["cancelReason", reservation, "cancelReason"],
		["cancellationReason", reservation, "cancellationReason"],
		["cancelledAt", reservation, "cancelledAt"],
		["noShowAt", reservation, "noShowAt"],
		["pendingConfirmation.confirmedAt", pending, "confirmedAt"],
		["pendingConfirmation.rejectedAt", pending, "rejectedAt"],
		["pendingConfirmation.cancelledAt", pending, "cancelledAt"],
		["pendingConfirmation.noShowAt", pending, "noShowAt"],
		["pendingConfirmation.rejectionReason", pending, "rejectionReason"],
		[
			"pendingConfirmation.confirmationReason",
			pending,
			"confirmationReason",
		],
		["otaPlatformReview.revertedAt", review, "revertedAt"],
		["otaPlatformReview.closedAt", review, "closedAt"],
		["otaPlatformReview.cancelledAt", review, "cancelledAt"],
	]) {
		exactOrMissing(filter, pathName, object, key);
	}
	return filter;
}

function buildAuditMarker(candidate, at) {
	const marker = {
		at,
		source: AUDIT_SOURCE,
		action: AUDIT_ACTION,
		repairId: REPAIR_ID,
		version: REPAIR_VERSION,
		previousInventoryBlocks: candidate.previousInventoryBlocks,
		inventoryBlocks: true,
	};
	if (stableStringify(marker).length > 512) {
		fail("The inventory reconciliation audit marker exceeded its fixed bound.");
	}
	return marker;
}

function candidateUpdate(candidate, at) {
	return {
		$set: {
			"pendingConfirmation.inventoryBlocks": true,
			updatedAt: at,
		},
		$inc: { __v: 1 },
		$push: { reservationAuditLog: buildAuditMarker(candidate, at) },
	};
}

function duplicateIdentityTokens(identityDocuments = []) {
	const ownersByIdentity = new Map();
	for (const reservation of identityDocuments) {
		const owner = clean(reservation._id);
		for (const token of identityTokens(reservation)) {
			if (!ownersByIdentity.has(token)) ownersByIdentity.set(token, new Set());
			ownersByIdentity.get(token).add(owner);
		}
	}
	return new Set(
		Array.from(ownersByIdentity.entries())
			.filter(([, owners]) => owners.size > 1)
			.map(([token]) => token)
	);
}

function planProof(candidates) {
	const immutablePlan = candidates
		.map((candidate) => ({
			id: clean(candidate.reservation._id),
			snapshotHash: candidate.snapshotHash,
		}))
		.sort((left, right) => left.id.localeCompare(right.id));
	return sha256(
		stableStringify({
			repairId: REPAIR_ID,
			version: REPAIR_VERSION,
			cutoff: REPAIR_CUTOFF,
			candidates: immutablePlan,
		})
	);
}

function buildPlan({ reservations = [], hotels = [], identityDocuments = [] } = {}) {
	if (!Array.isArray(reservations) || reservations.length > MAX_CANDIDATES) {
		fail(
			`Candidate scope must contain at most ${MAX_CANDIDATES} rows.`,
			"OTA_INVENTORY_RECONCILIATION_SCOPE_TOO_LARGE"
		);
	}
	const hotelIds = new Set(hotels.map((hotel) => clean(hotel._id)).filter(Boolean));
	const duplicateTokens = duplicateIdentityTokens(identityDocuments);
	const candidates = [];
	const exclusions = [];

	for (const reservation of reservations) {
		const assessment = assessCandidate(reservation, {
			hotelExists: hotelIds.has(clean(reservation.hotelId)),
		});
		if (!assessment.eligible) {
			exclusions.push({ reservation, reason: assessment.reason });
			continue;
		}
		if (assessment.identities.some((identity) => duplicateTokens.has(identity))) {
			exclusions.push({ reservation, reason: "duplicate_ota_identity" });
			continue;
		}
		const snapshot = candidateSnapshot(reservation, assessment);
		candidates.push({
			reservation,
			...assessment,
			snapshot,
			snapshotHash: sha256(stableStringify(snapshot)),
			immutableHash: sha256(
				stableStringify(immutableCandidateSnapshot(reservation))
			),
		});
	}
	const proof = planProof(candidates);
	const excludedByReason = Object.fromEntries(
		Array.from(
			exclusions.reduce((counts, exclusion) => {
				counts.set(exclusion.reason, (counts.get(exclusion.reason) || 0) + 1);
				return counts;
			}, new Map())
		).sort(([left], [right]) => left.localeCompare(right))
	);
	return { candidates, exclusions, excludedByReason, proof };
}

function parseArguments(argv = []) {
	const options = { apply: false, proof: "", repairId: "" };
	for (const raw of argv) {
		const argument = String(raw || "").trim();
		if (argument === "--apply") {
			if (options.apply) {
				fail(
					"--apply may be supplied only once.",
					"OTA_INVENTORY_RECONCILIATION_ARGUMENT_INVALID"
				);
			}
			options.apply = true;
			continue;
		}
		if (argument.startsWith("--proof=")) {
			if (options.proof) {
				fail(
					"--proof may be supplied only once.",
					"OTA_INVENTORY_RECONCILIATION_ARGUMENT_INVALID"
				);
			}
			options.proof = argument.slice("--proof=".length).trim().toLowerCase();
			continue;
		}
		if (argument.startsWith("--repair-id=")) {
			if (options.repairId) {
				fail(
					"--repair-id may be supplied only once.",
					"OTA_INVENTORY_RECONCILIATION_ARGUMENT_INVALID"
				);
			}
			options.repairId = argument.slice("--repair-id=".length).trim();
			continue;
		}
		fail(
			"Unsupported inventory reconciliation argument.",
			"OTA_INVENTORY_RECONCILIATION_ARGUMENT_INVALID"
		);
	}
	if (!options.apply && (options.proof || options.repairId)) {
		fail(
			"--proof and --repair-id are accepted only with --apply.",
			"OTA_INVENTORY_RECONCILIATION_ARGUMENT_INVALID"
		);
	}
	if (options.apply) {
		if (options.repairId !== REPAIR_ID) {
			fail(
				`--apply requires --repair-id=${REPAIR_ID}.`,
				"OTA_INVENTORY_RECONCILIATION_REPAIR_ID_REQUIRED"
			);
		}
		if (!/^[a-f0-9]{64}$/.test(options.proof)) {
			fail(
				"--apply requires the exact 64-character proof emitted by dry-run.",
				"OTA_INVENTORY_RECONCILIATION_PROOF_REQUIRED"
			);
		}
	}
	return options;
}

async function executeQuery(query) {
	return query && typeof query.exec === "function" ? query.exec() : query;
}

async function leanMany(Model, filter, { select = "", limit = 0 } = {}) {
	let query = Model.find(filter);
	if (select && typeof query.select === "function") query = query.select(select);
	if (limit && typeof query.limit === "function") query = query.limit(limit);
	if (typeof query.lean === "function") query = query.lean();
	return executeQuery(query);
}

function identityLookupFilter(reservations = []) {
	const canonical = new Set();
	const confirmations = new Set();
	for (const reservation of reservations) {
		for (const value of [
			reservation.otaIdentityKey,
			reservation.otaCrossTransportIdentityKey,
		]) {
			if (clean(value)) canonical.add(clean(value));
		}
		for (const value of [
			reservation.reservation_id,
			reservation?.customer_details?.confirmation_number2,
			reservation?.supplierData?.suppliedBookingNo,
			reservation?.supplierData?.otaConfirmationNumber,
			reservation?.supplierData?.platformConfirmationNumber,
		]) {
			if (clean(value)) confirmations.add(clean(value));
		}
	}
	const or = [];
	if (canonical.size) {
		const values = Array.from(canonical);
		or.push({ otaIdentityKey: { $in: values } });
		or.push({ otaCrossTransportIdentityKey: { $in: values } });
	}
	if (confirmations.size) {
		const values = Array.from(confirmations);
		for (const pathName of [
			"reservation_id",
			"customer_details.confirmation_number2",
			"supplierData.suppliedBookingNo",
			"supplierData.otaConfirmationNumber",
			"supplierData.platformConfirmationNumber",
		]) {
			or.push({ [pathName]: { $in: values } });
		}
	}
	return or.length ? { $or: or } : { _id: { $in: [] } };
}

async function loadPlanFromDatabase({
	ReservationModel = Reservations,
	HotelModel = HotelDetails,
} = {}) {
	const reservations = await leanMany(ReservationModel, CANDIDATE_FILTER, {
		select: CANDIDATE_PROJECTION,
		limit: MAX_CANDIDATES + 1,
	});
	if (reservations.length > MAX_CANDIDATES) {
		fail(
			`Candidate query exceeded the fixed ${MAX_CANDIDATES}-row safety bound.`,
			"OTA_INVENTORY_RECONCILIATION_SCOPE_TOO_LARGE"
		);
	}
	const hotelIds = Array.from(
		new Set(reservations.map((reservation) => clean(reservation.hotelId)).filter(Boolean))
	);
	const hotels = hotelIds.length
		? await leanMany(HotelModel, { _id: { $in: hotelIds } }, { select: "_id" })
		: [];
	const identityDocuments = reservations.length
		? await leanMany(ReservationModel, identityLookupFilter(reservations), {
				select: IDENTITY_PROJECTION,
		  })
		: [];
	return buildPlan({ reservations, hotels, identityDocuments });
}

function reportForPlan(plan, { mode = "dry-run", appliedCount = 0 } = {}) {
	const hotelCounts = {};
	let roomCount = 0;
	for (const candidate of plan.candidates) {
		const hotelId = clean(candidate.reservation.hotelId);
		hotelCounts[hotelId] = (hotelCounts[hotelId] || 0) + 1;
		roomCount += candidate.roomCount;
	}
	return {
		mode,
		repairId: REPAIR_ID,
		repairVersion: REPAIR_VERSION,
		cutoff: REPAIR_CUTOFF.toISOString(),
		proof: plan.proof,
		scannedCount: plan.candidates.length + plan.exclusions.length,
		candidateCount: plan.candidates.length,
		candidateRoomCount: roomCount,
		excludedCount: plan.exclusions.length,
		excludedByReason: plan.excludedByReason,
		hotelCounts,
		appliedCount,
		candidates: plan.candidates.map((candidate) => ({
			reservationMongoId: clean(candidate.reservation._id),
			pmsConfirmation: clean(candidate.reservation.confirmation_number),
			otaConfirmation: clean(candidate.reservation.reservation_id),
			hotelId: clean(candidate.reservation.hotelId),
			checkoutDate: dateOnlyKey(candidate.reservation.checkout_date),
			rooms: candidate.roomCount,
			nights: candidate.nights,
			previousInventoryBlocks: candidate.previousInventoryBlocks,
			lifecycle: candidate.lifecycle,
			snapshotHash: candidate.snapshotHash,
		})),
		applyCommand: `node scripts/reconcileReleasedOtaInventoryBlocks20260813.js --apply --repair-id=${REPAIR_ID} --proof=${plan.proof}`,
	};
}

function matchedCount(result) {
	return Number(
		result?.matchedCount ?? result?.nMatched ?? result?.result?.nMatched ?? 0
	);
}

function modifiedCount(result) {
	return Number(
		result?.modifiedCount ??
			result?.nModified ??
			result?.result?.nModified ??
			0
	);
}

function repairedPostcondition(candidate, reservation, at) {
	if (!reservation || reservation?.pendingConfirmation?.inventoryBlocks !== true) {
		return false;
	}
	if (Number(reservation.__v) !== Number(candidate.reservation.__v) + 1) {
		return false;
	}
	if (dateMs(reservation.updatedAt) !== dateMs(at)) return false;
	if (
		sha256(stableStringify(immutableCandidateSnapshot(reservation))) !==
		candidate.immutableHash
	) {
		return false;
	}
	const beforeAudits = Array.isArray(candidate.reservation.reservationAuditLog)
		? candidate.reservation.reservationAuditLog
		: [];
	const afterAudits = Array.isArray(reservation.reservationAuditLog)
		? reservation.reservationAuditLog
		: [];
	if (
		afterAudits.length !== beforeAudits.length + 1 ||
		stableStringify(afterAudits.slice(0, -1)) !== stableStringify(beforeAudits)
	) {
		return false;
	}
	const markers = afterAudits.filter((entry) => entry?.repairId === REPAIR_ID);
	return (
		markers.length === 1 &&
		dateMs(markers[0].at) === dateMs(at) &&
		markers[0].source === AUDIT_SOURCE &&
		markers[0].action === AUDIT_ACTION &&
		Number(markers[0].version) === REPAIR_VERSION &&
		markers[0].previousInventoryBlocks === candidate.previousInventoryBlocks &&
		markers[0].inventoryBlocks === true
	);
}

async function applyPlan(
	plan,
	{
		ReservationModel = Reservations,
		clock = () => new Date(),
		readBack = null,
	} = {}
) {
	if (!plan.candidates.length) return { appliedCount: 0, at: null };
	const at = clock();
	if (!validDate(at)) fail("The reconciliation clock returned an invalid date.");
	const operations = plan.candidates.map((candidate) => ({
		updateOne: {
			filter: candidateCasFilter(candidate),
			update: candidateUpdate(candidate, at),
			// Keep the audit timestamp and top-level updatedAt identical so the
			// postcondition can prove this exact write. Otherwise Mongoose's bulk
			// timestamp hook replaces updatedAt with a second, implicit clock read.
			timestamps: false,
		},
	}));
	const result = await ReservationModel.bulkWrite(operations, WRITE_OPTIONS);
	const after = readBack
		? await readBack(plan.candidates.map((candidate) => candidate.reservation._id))
		: await leanMany(
				ReservationModel,
				{ _id: { $in: plan.candidates.map((candidate) => candidate.reservation._id) } },
				{ select: `${CANDIDATE_PROJECTION} reservationAuditLog` }
		  );
	const afterById = new Map(after.map((reservation) => [clean(reservation._id), reservation]));
	const satisfied = plan.candidates.filter((candidate) =>
		repairedPostcondition(
			candidate,
			afterById.get(clean(candidate.reservation._id)),
			at
		)
	);
	if (
		matchedCount(result) !== plan.candidates.length ||
		modifiedCount(result) !== plan.candidates.length ||
		satisfied.length !== plan.candidates.length
	) {
		fail(
			"One or more guarded inventory updates lost their snapshot fence or failed post-write verification. No unsafe fallback was attempted.",
			"OTA_INVENTORY_RECONCILIATION_CAS_LOST"
		);
	}
	return { appliedCount: satisfied.length, at };
}

async function runReconciliation(
	options,
	{
		loadPlan = loadPlanFromDatabase,
		ReservationModel = Reservations,
		clock = () => new Date(),
		readBack = null,
	} = {}
) {
	const plan = await loadPlan();
	if (!options.apply) return reportForPlan(plan);
	if (options.proof !== plan.proof) {
		fail(
			"The live candidate plan differs from the supplied dry-run proof. Run a new dry-run and review it before applying.",
			"OTA_INVENTORY_RECONCILIATION_PROOF_MISMATCH"
		);
	}
	const outcome = await applyPlan(plan, { ReservationModel, clock, readBack });
	return {
		...reportForPlan(plan, {
			mode: "apply",
			appliedCount: outcome.appliedCount,
		}),
		appliedAt: outcome.at ? outcome.at.toISOString() : null,
	};
}

async function main(argv = process.argv.slice(2)) {
	const options = parseArguments(argv);
	const database =
		process.env.DATABASE || process.env.MONGO_URI || process.env.MONGODB_URI;
	if (!database) fail("Missing DATABASE/MONGO connection string.");
	await mongoose.connect(database, {
		autoIndex: false,
		autoCreate: false,
		serverSelectionTimeoutMS: 15_000,
	});
	try {
		const report = await runReconciliation(options);
		console.log(JSON.stringify(report, null, 2));
		return report;
	} finally {
		await mongoose.disconnect();
	}
}

if (require.main === module) {
	main().catch((error) => {
		console.error(
			JSON.stringify({
				code: error?.code || "OTA_INVENTORY_RECONCILIATION_FAILED",
				message: error?.message || "Inventory reconciliation failed.",
			})
		);
		process.exitCode = 1;
	});
}

module.exports = {
	AUDIT_ACTION,
	AUDIT_SOURCE,
	CANDIDATE_FILTER,
	MAX_CANDIDATES,
	REPAIR_CUTOFF,
	REPAIR_ID,
	REPAIR_VERSION,
	applyPlan,
	assessCandidate,
	buildAuditMarker,
	buildPlan,
	candidateCasFilter,
	candidateUpdate,
	duplicateIdentityTokens,
	identityLookupFilter,
	identityTokens,
	immutableCandidateSnapshot,
	matchingReleaseAudit,
	matchingHotelConfirmationAudit,
	normalizedAuditActor,
	parseArguments,
	repairedPostcondition,
	reportForPlan,
	runReconciliation,
	stableStringify,
	validateRoomLines,
};
