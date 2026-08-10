/** @format */

"use strict";

const HotelRunnerEvent = require("../models/hotelrunner_event");
const Reservations = require("../models/reservations");
const {
	authenticatedProviderExistingHandoffProof,
	findLinkedReservation,
	hotelRunnerCommercialProvider,
} = require("./hotelrunnerReservationAdapter");
const {
	loadHotelRunnerEmailCommercialBridge,
	loadHotelRunnerQueuedEmailCommercialBridge,
} = require("./hotelrunnerEmailCommercialBridge");
const {
	buildHotelRunnerProjectionEligibilityFilter,
} = require("./hotelrunnerFirstOtaFallback");
const { loadConfiguredHotel } = require("./hotelrunnerEventService");
const {
	LATE_EVIDENCE_WAITING_ERROR,
	isLateEvidenceIdleFailure,
	lateEvidenceIdleFailureFilter,
} = require("./hotelrunnerLateEvidencePolicy");

const DEFAULT_LATE_EVIDENCE_SCAN_LIMIT = 25;
const SHA256_HEX = /^[a-f0-9]{64}$/;

const clean = (value = "") => String(value == null ? "" : value).trim();

function queryResult(query) {
	return query && typeof query.exec === "function" ? query.exec() : query;
}

function modifiedOne(result) {
	return (
		Number(result?.modifiedCount ?? result?.nModified ?? result?.n ?? 0) === 1
	);
}

function validEvidenceHash(value) {
	const evidenceHash = clean(value).toLowerCase();
	return SHA256_HEX.test(evidenceHash) ? evidenceHash : "";
}

function failedLateEvidenceFilter({ config, cursor = null } = {}) {
	const filter = {
		hotelId: config.hotelId,
		...lateEvidenceIdleFailureFilter(),
		$and: [
			buildHotelRunnerProjectionEligibilityFilter(config.projectionNotBefore),
		],
	};
	if (cursor) filter._id = { $gt: cursor };
	return filter;
}

function lateEvidenceRecoveryCasFilter(event, evidenceHash) {
	return {
		_id: event._id,
		hotelId: event.hotelId,
		...lateEvidenceIdleFailureFilter(),
		payloadHash: event.payloadHash,
		canonicalHash: event.canonicalHash,
		attempts: event.attempts,
		processedAt: event.processedAt,
		updatedAt: event.updatedAt,
		"result.lateEvidenceRecovery.evidenceHash": { $ne: evidenceHash },
	};
}

function lateEvidenceRecoveryUpdate(now, evidenceHash, evidenceKind) {
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
			"result.lateEvidenceRecovery": {
				version: 1,
				evidenceHash,
				evidenceKind,
				recoveredAt: now,
			},
		},
		$unset: {
			leaseOwner: 1,
			leaseAcquiredAt: 1,
			leaseUntil: 1,
		},
	};
}

function createHotelRunnerLateEvidenceRecovery({
	config,
	normalizeEvent,
	dependencies = {},
} = {}) {
	const EventModel = dependencies.EventModel || HotelRunnerEvent;
	const ReservationModel = dependencies.ReservationModel || Reservations;
	const loadHotel = dependencies.loadConfiguredHotel || loadConfiguredHotel;
	const findReservation =
		dependencies.findLinkedReservation || findLinkedReservation;
	const loadEmailBridge =
		dependencies.loadEmailCommercialBridge ||
		loadHotelRunnerEmailCommercialBridge;
	const loadQueuedEmailBridge =
		dependencies.loadQueuedEmailCommercialBridge ||
		loadHotelRunnerQueuedEmailCommercialBridge;
	const providerHandoffProof =
		dependencies.authenticatedProviderExistingHandoffProof ||
		authenticatedProviderExistingHandoffProof;
	const commercialProvider =
		dependencies.hotelRunnerCommercialProvider || hotelRunnerCommercialProvider;
	let cursor = null;

	if (typeof normalizeEvent !== "function") {
		throw new TypeError(
			"HotelRunner late-evidence recovery needs an event normalizer."
		);
	}

	async function loadCandidatePage(limit) {
		const query = EventModel.find(failedLateEvidenceFilter({ config, cursor }))
			.sort({ _id: 1 })
			.limit(limit)
			.select("+payload")
			.lean();
		return (await queryResult(query)) || [];
	}

	async function hasCandidates() {
		if (
			config?.configured !== true ||
			config?.projectionEnabled !== true ||
			!config.hotelId
		) {
			return false;
		}
		return Boolean(
			await queryResult(
				EventModel.exists(failedLateEvidenceFilter({ config, cursor: null }))
			)
		);
	}

	async function authoritativeEvidence(event, hotel) {
		let normalized;
		try {
			normalized = normalizeEvent(event);
		} catch (_error) {
			return null;
		}
		const provider = commercialProvider(normalized);
		try {
			const queuedBridge = await loadQueuedEmailBridge(
				{ normalized, provider, hotel, config },
				{
					FallbackJobModel: dependencies.FallbackJobModel,
					InboundEmailModel: dependencies.InboundEmailModel,
					resolveArchivedHotel: dependencies.resolveArchivedHotel,
					now: dependencies.queuedEmailBridgeNow,
				}
			);
			const queuedEvidenceHash = validEvidenceHash(
				queuedBridge?.ok === true ? queuedBridge?.evidence?.evidenceHash : ""
			);
			if (queuedEvidenceHash) {
				return {
					evidenceHash: queuedEvidenceHash,
					evidenceKind: "authenticated_ota_email_queue",
				};
			}
		} catch (_error) {
			// The existing-record paths below may independently prove late evidence.
		}

		let linked;
		try {
			linked = await findReservation(normalized, hotel._id, {
				ReservationModel,
			});
		} catch (_error) {
			return null;
		}
		const existing = linked?.reservation;
		if (!existing) return null;

		try {
			const emailBridge = await loadEmailBridge(
				{
					existing,
					normalized,
					provider,
				},
				dependencies.InboundEmailModel
					? { InboundEmailModel: dependencies.InboundEmailModel }
					: undefined
			);
			const emailEvidenceHash = validEvidenceHash(
				emailBridge?.ok === true ? emailBridge?.evidence?.evidenceHash : ""
			);
			if (emailEvidenceHash) {
				return {
					evidenceHash: emailEvidenceHash,
					evidenceKind: "authenticated_ota_email",
				};
			}
		} catch (_error) {
			// A lookup or validation error leaves the terminal event untouched.
		}

		let proof;
		try {
			proof = providerHandoffProof({
				existing,
				normalized,
				hotel,
				linkMethod: linked.method,
			});
		} catch (_error) {
			return null;
		}
		const providerEvidenceHash = validEvidenceHash(
			proof?.ok === true ? proof.evidenceHash : ""
		);
		return providerEvidenceHash
			? {
					evidenceHash: providerEvidenceHash,
					evidenceKind: "authenticated_provider",
			  }
			: null;
	}

	async function scanOnce({
		now = new Date(),
		limit = DEFAULT_LATE_EVIDENCE_SCAN_LIMIT,
	} = {}) {
		if (
			config?.configured !== true ||
			config?.projectionEnabled !== true ||
			!config.hotelId
		) {
			return { status: "disabled", scanned: 0, requeued: false };
		}
		const boundedLimit = Math.min(
			DEFAULT_LATE_EVIDENCE_SCAN_LIMIT,
			Math.max(1, Number.isSafeInteger(limit) ? limit : 0)
		);
		const candidates = await loadCandidatePage(boundedLimit);
		if (!candidates.length) {
			cursor = null;
			return { status: "idle", scanned: 0, requeued: false };
		}
		const hotel = await loadHotel(config, dependencies);
		let scanned = 0;
		for (const event of candidates) {
			cursor = event._id;
			scanned += 1;
			if (!isLateEvidenceIdleFailure(event, { projectionEligible: true })) {
				continue;
			}
			const evidence = await authoritativeEvidence(event, hotel);
			if (!evidence) continue;
			if (
				validEvidenceHash(event.result?.lateEvidenceRecovery?.evidenceHash) ===
				evidence.evidenceHash
			) {
				continue;
			}
			const result = await queryResult(
				EventModel.updateOne(
					lateEvidenceRecoveryCasFilter(event, evidence.evidenceHash),
					lateEvidenceRecoveryUpdate(
						now,
						evidence.evidenceHash,
						evidence.evidenceKind
					)
				)
			);
			if (modifiedOne(result)) {
				return { status: "requeued", scanned, requeued: true };
			}
		}
		return { status: "scanned", scanned, requeued: false };
	}

	return { hasCandidates, scanOnce };
}

module.exports = {
	DEFAULT_LATE_EVIDENCE_SCAN_LIMIT,
	LATE_EVIDENCE_WAITING_ERROR,
	createHotelRunnerLateEvidenceRecovery,
	failedLateEvidenceFilter,
	lateEvidenceRecoveryCasFilter,
	lateEvidenceRecoveryUpdate,
	validEvidenceHash,
};
