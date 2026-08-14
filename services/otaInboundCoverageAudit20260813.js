/** @format */

"use strict";

const crypto = require("crypto");
const { INBOUND_CLAIM_LEASE_MS } = require("./otaInboundDedupe");

const POLICY_DATE = "2026-08-13";
// Version 4 adds represented-reservation financial completeness to the
// identity/pipeline coverage contract.  Keep this distinct from v3 so stored
// monitor evidence is not mistaken for having run the new materialization
// check.
const REPORT_VERSION = 4;
const ARCHIVE_START = new Date("2026-05-12T00:00:00.000Z");
const TRANSPORT_PROVIDERS = Object.freeze([
	"agoda",
	"airbnb",
	"booking",
	"expedia",
	"hotels",
	"trip",
	"hotelrunner",
]);
const DIRECT_OTA_PROVIDERS = Object.freeze(
	TRANSPORT_PROVIDERS.filter((provider) => provider !== "hotelrunner")
);
const TERMINAL_STATUSES = new Set([
	"cancelled",
	"canceled",
	"no_show",
	"no-show",
	"noshow",
]);
const RESERVATION_TERMINAL_STATUSES = new Set([
	...TERMINAL_STATUSES,
	"checked_out",
	"checked-out",
	"checkedout",
	"refunded",
]);
const ACTIVE_OR_PENDING_RESERVATION_STATUSES = new Set([
	"confirmed",
	"inhouse",
	"in_house",
	"in-house",
	"ota_platform_review",
	"pending",
	"pending_confirmation",
	"reserved",
]);
const DEFAULT_MAX_ARCHIVES = 10000;
const DEFAULT_MAX_RESERVATIONS = 20000;
const PIPELINE_HOLD_STATUSES = Object.freeze([
	"failed",
	"needs_review",
	"needs_mapping",
]);

class CoverageAuditLimitError extends Error {
	constructor(code, message) {
		super(message);
		this.name = "CoverageAuditLimitError";
		this.code = code;
	}
}

const clean = (value) => String(value ?? "").trim();
const lower = (value) => clean(value).toLowerCase();

function normalizeConfirmation(value) {
	return lower(value);
}

function canonicalProvider(value) {
	const text = lower(value);
	if (!text) return "";
	if (/\bhotels\.com\b/.test(text)) return "hotels";
	if (/\bbooking\.com\b|^booking$/.test(text)) return "booking";
	if (/\btrip\.com\b|\bctrip\b|^trip$/.test(text)) return "trip";
	if (/\bexpedia(?:\s+group)?\b|expediapartnercentral/.test(text)) {
		return "expedia";
	}
	if (/\bagoda\b/.test(text)) return "agoda";
	if (/\bairbnb\b/.test(text)) return "airbnb";
	if (/\bhotel\s*runner\b|^hotelrunner$/.test(text)) return "hotelrunner";
	return "";
}

function identityKey(provider, confirmationNumber) {
	const canonical = canonicalProvider(provider);
	const confirmation = normalizeConfirmation(confirmationNumber);
	return canonical && confirmation ? `${canonical}:${confirmation}` : "";
}

function parseIdentityKey(value) {
	const text = lower(value);
	const separator = text.indexOf(":");
	if (separator < 1) return null;
	const provider = canonicalProvider(text.slice(0, separator));
	const confirmationNumber = normalizeConfirmation(text.slice(separator + 1));
	return provider && confirmationNumber
		? { provider, confirmationNumber, key: `${provider}:${confirmationNumber}` }
		: null;
}

function validDate(value) {
	const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
	return Number.isFinite(date.getTime()) ? date : null;
}

function requireDate(value, label) {
	const date = validDate(value);
	if (!date) throw new TypeError(`${label} must be a valid date.`);
	return date;
}

function dateOnly(value) {
	const match = clean(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
	if (!match) return "";
	const candidate = `${match[1]}-${match[2]}-${match[3]}`;
	const parsed = new Date(`${candidate}T00:00:00.000Z`);
	return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === candidate
		? candidate
		: "";
}

function idString(value) {
	if (!value) return "";
	if (typeof value === "object" && typeof value.toHexString === "function") {
		return lower(value.toHexString());
	}
	return lower(value);
}

function unique(values) {
	return Array.from(new Set(values.filter(Boolean)));
}

function sortedUnique(values) {
	return unique(values).sort((left, right) => left.localeCompare(right));
}

function increment(counts, key) {
	const normalized = clean(key) || "unknown";
	counts[normalized] = Number(counts[normalized] || 0) + 1;
}

function sortedCounts(counts) {
	return Object.fromEntries(
		Object.entries(counts).sort(([left], [right]) => left.localeCompare(right))
	);
}

function archiveTransportProvider(archive = {}) {
	return canonicalProvider(
		archive?.senderAuthentication?.trustedProvider || archive.provider
	);
}

function archiveConfirmation(archive = {}) {
	return normalizeConfirmation(
		archive.confirmationNumber ||
			archive?.normalizedReservation?.confirmationNumber ||
			archive?.normalizedReservation?.reservationId
	);
}

function archiveIntent(archive = {}) {
	const storedIntent = lower(archive.intent);
	const normalizedIntent = lower(archive?.normalizedReservation?.intent);
	if (storedIntent && normalizedIntent && storedIntent !== normalizedIntent) return "";
	return storedIntent || normalizedIntent;
}

function isAlignedTrustedTransportArchive(archive = {}) {
	return Boolean(
		archive?.senderAuthentication?.authenticatedAligned === true &&
		TRANSPORT_PROVIDERS.includes(archiveTransportProvider(archive))
	);
}

function isAuthenticatedArchive(archive = {}) {
	const transport = archiveTransportProvider(archive);
	const representedProviders = unique(
		[
			canonicalProvider(archive.provider),
			canonicalProvider(archive?.normalizedReservation?.provider),
		].filter(Boolean)
	);
	const representedProvidersAreValidForTransport = representedProviders.every(
		(provider) =>
			provider === transport ||
			(transport === "hotelrunner" && DIRECT_OTA_PROVIDERS.includes(provider))
	);
	return Boolean(
		isAlignedTrustedTransportArchive(archive) &&
		representedProvidersAreValidForTransport &&
		archiveConfirmation(archive)
	);
}

function isAuthenticatedNewArchive(archive = {}) {
	return isAuthenticatedArchive(archive) && archiveIntent(archive) === "new_reservation";
}

function hotelRunnerCommercialProvider(archive = {}) {
	if (archiveTransportProvider(archive) !== "hotelrunner") return "";
	const normalized = archive.normalizedReservation || {};
	const explicit = unique(
		(normalized.hotelRunnerCommercialSourceProviders || [])
			.map(canonicalProvider)
			.filter((provider) => provider && provider !== "hotelrunner")
	);
	if (explicit.length === 1) return explicit[0];
	if (explicit.length > 1) return "";
	const bookingSource = canonicalProvider(normalized.bookingSource);
	if (bookingSource && bookingSource !== "hotelrunner") return bookingSource;
	const storedProvider = canonicalProvider(archive.provider);
	return DIRECT_OTA_PROVIDERS.includes(storedProvider) ? storedProvider : "";
}

function initialArchiveIdentity(archive = {}) {
	if (!isAuthenticatedArchive(archive)) return null;
	const transportProvider = archiveTransportProvider(archive);
	const confirmationNumber = archiveConfirmation(archive);
	const commercialProvider = hotelRunnerCommercialProvider(archive);
	const provider =
		transportProvider === "hotelrunner"
			? commercialProvider || "hotelrunner"
			: transportProvider;
	return {
		provider,
		confirmationNumber,
		key: identityKey(provider, confirmationNumber),
		transportProvider,
		commercialProvider,
	};
}

function directWinnerProvidersByConfirmation(archives = []) {
	const providers = new Map();
	for (const archive of archives) {
		if (!isAuthenticatedNewArchive(archive)) continue;
		const identity = initialArchiveIdentity(archive);
		if (!identity || identity.transportProvider === "hotelrunner") continue;
		const current = providers.get(identity.confirmationNumber) || new Set();
		current.add(identity.transportProvider);
		providers.set(identity.confirmationNumber, current);
	}
	return new Map(
		Array.from(providers.entries()).map(([confirmation, values]) => [
			confirmation,
			values.size === 1 ? Array.from(values)[0] : "",
		])
	);
}

function canonicalArchiveIdentity(archive = {}, directWinners = new Map()) {
	const initial = initialArchiveIdentity(archive);
	if (!initial) return null;
	if (initial.transportProvider !== "hotelrunner") return initial;
	const directWinner = directWinners.get(initial.confirmationNumber) || "";
	const provider = initial.commercialProvider || directWinner || "hotelrunner";
	return {
		...initial,
		provider,
		key: identityKey(provider, initial.confirmationNumber),
		directWinnerApplied: Boolean(!initial.commercialProvider && directWinner),
	};
}

function groupCandidateArchives(creatingArchives = []) {
	const eligible = creatingArchives.filter(isAuthenticatedNewArchive);
	const directWinners = directWinnerProvidersByConfirmation(eligible);
	const groups = new Map();
	for (const archive of eligible) {
		const identity = canonicalArchiveIdentity(archive, directWinners);
		if (!identity?.key) continue;
		const group = groups.get(identity.key) || {
			...identity,
			archives: [],
			transportProviders: new Set(),
		};
		group.archives.push(archive);
		group.transportProviders.add(identity.transportProvider);
		groups.set(identity.key, group);
	}
	return { groups, directWinners, eligible };
}

function groupLifecycleArchives(lifecycleArchives = [], directWinners = new Map()) {
	const groups = new Map();
	for (const archive of lifecycleArchives) {
		if (!isAuthenticatedArchive(archive)) continue;
		const identity = canonicalArchiveIdentity(archive, directWinners);
		if (!identity?.key) continue;
		const values = groups.get(identity.key) || [];
		values.push(archive);
		groups.set(identity.key, values);
	}
	for (const values of groups.values()) {
		values.sort(
			(left, right) =>
				(validDate(left.receivedAt)?.getTime() || 0) -
				(validDate(right.receivedAt)?.getTime() || 0)
		);
	}
	return groups;
}

function normalizedTerminalStatus(archive = {}) {
	const candidates = [
		archive.eventType,
		archive?.normalizedReservation?.eventType,
		archive?.normalizedReservation?.statusToApply,
		archive.processingStatus,
		archive.automationAction,
	];
	for (const candidate of candidates) {
		const normalized = lower(candidate).replace(/\s+/g, "_");
		if (!TERMINAL_STATUSES.has(normalized)) continue;
		return normalized.startsWith("cancel") ? "cancelled" : "no_show";
	}
	return "";
}

function latestLaterTerminal(group, lifecycle = []) {
	const firstNewAt = Math.min(
		...group.archives
			.map((archive) => validDate(archive.receivedAt)?.getTime())
			.filter(Number.isFinite)
	);
	if (!Number.isFinite(firstNewAt)) return null;
	return (
		lifecycle
			.map((archive) => ({
				archive,
				status: normalizedTerminalStatus(archive),
				receivedAt: validDate(archive.receivedAt),
			}))
			.filter(
				(item) =>
					item.status &&
					item.receivedAt &&
					item.receivedAt.getTime() >= firstNewAt
			)
			.sort((left, right) => right.receivedAt - left.receivedAt)[0] || null
	);
}

function reservationAliases(reservation = {}) {
	return unique(
		[
			reservation.reservation_id,
			reservation?.customer_details?.confirmation_number2,
			reservation?.supplierData?.suppliedBookingNo,
			reservation?.supplierData?.otaConfirmationNumber,
			reservation?.supplierData?.platformConfirmationNumber,
			reservation?.supplierData?.hotelRunner?.providerNumber,
			reservation?.otaPlatformReview?.confirmationNumber,
		].map(normalizeConfirmation)
	);
}

function reservationAliasEvidence(reservation = {}) {
	const aliases = reservationAliases(reservation);
	const providerSignals = unique(
		[
			reservation.booking_source,
			reservation?.supplierData?.otaProvider,
			reservation?.supplierData?.hotelRunner?.channel,
			reservation?.otaPlatformReview?.provider,
			parseIdentityKey(reservation.otaIdentityKey)?.provider,
			parseIdentityKey(reservation.otaCrossTransportIdentityKey)?.provider,
		].map(canonicalProvider)
	);
	const pairs = new Map();
	const addPair = (providerValue, confirmationValue, provenance) => {
		const provider = canonicalProvider(providerValue);
		const confirmationNumber = normalizeConfirmation(confirmationValue);
		const key = identityKey(provider, confirmationNumber);
		if (!key) return;
		const existing = pairs.get(key) || {
			provider,
			confirmationNumber,
			key,
			provenance: new Set(),
		};
		existing.provenance.add(provenance);
		pairs.set(key, existing);
	};

	// Keep provider/confirmation values paired within the storage section that
	// produced them. Crossing these sections can synthesize an OTA identity that
	// was never present on the Reservation.
	for (const [confirmationValue, provenance] of [
		[reservation.reservation_id, "booking_source.reservation_id"],
		[
			reservation?.customer_details?.confirmation_number2,
			"booking_source.customer_confirmation",
		],
	]) {
		addPair(reservation.booking_source, confirmationValue, provenance);
	}
	for (const [confirmationValue, provenance] of [
		[
			reservation?.supplierData?.suppliedBookingNo,
			"supplier_data.supplied_booking_no",
		],
		[
			reservation?.supplierData?.otaConfirmationNumber,
			"supplier_data.ota_confirmation_number",
		],
		[
			reservation?.supplierData?.platformConfirmationNumber,
			"supplier_data.platform_confirmation_number",
		],
	]) {
		addPair(reservation?.supplierData?.otaProvider, confirmationValue, provenance);
	}
	addPair(
		reservation?.supplierData?.hotelRunner?.channel,
		reservation?.supplierData?.hotelRunner?.providerNumber,
		"hotelrunner.provider_number"
	);
	addPair(
		reservation?.otaPlatformReview?.provider,
		reservation?.otaPlatformReview?.confirmationNumber,
		"ota_platform_review.confirmation_number"
	);

	// Older rows sometimes carry the confirmation in a different legacy alias
	// field. That remains safe only when every available provider signal agrees.
	if (providerSignals.length === 1) {
		for (const confirmationNumber of aliases) {
			addPair(
				providerSignals[0],
				confirmationNumber,
				"unambiguous_single_provider_legacy_alias"
			);
		}
	}

	return {
		aliases,
		providers: providerSignals,
		pairs,
	};
}

function reservationProviders(reservation = {}) {
	return reservationAliasEvidence(reservation).providers;
}

function reservationStoredIdentities(reservation = {}) {
	return [
		["otaIdentityKey", reservation.otaIdentityKey],
		["otaCrossTransportIdentityKey", reservation.otaCrossTransportIdentityKey],
	]
		.filter(([, value]) => clean(value))
		.map(([field, value]) => ({
			field,
			raw: lower(value),
			identity: parseIdentityKey(value),
		}));
}

function reservationHasExactTripBridge(reservation = {}, confirmationNumber = "") {
	const canonical = parseIdentityKey(reservation.otaIdentityKey);
	const crossTransport = parseIdentityKey(
		reservation.otaCrossTransportIdentityKey
	);
	return !!(
		canonical?.provider === "hotelrunner" &&
		canonical.confirmationNumber === confirmationNumber &&
		crossTransport?.provider === "trip" &&
		crossTransport.confirmationNumber === confirmationNumber
	);
}

function storedIdentityCompatibleWithGroup(
	stored = {},
	group = {},
	reservation = {}
) {
	const { identity, field } = stored;
	if (!identity?.provider || !identity?.confirmationNumber) return false;
	if (identity.confirmationNumber !== group.confirmationNumber) return false;
	if (identity.provider === group.provider) return true;
	// The only supported bridge shape is exact and directional: the historical
	// HotelRunner transport remains canonical and Trip owns the cross-transport
	// key. Merely seeing the two provider names in reverse/arbitrary fields is not
	// enough to excuse a conflicting stored identity.
	if (!reservationHasExactTripBridge(reservation, group.confirmationNumber)) {
		return false;
	}
	return !!(
		(group.provider === "trip" &&
			field === "otaIdentityKey" &&
			identity.provider === "hotelrunner") ||
		(group.provider === "hotelrunner" &&
			field === "otaCrossTransportIdentityKey" &&
			identity.provider === "trip")
	);
}

function reservationStoredIdentityConflictsGroup(reservation = {}, group = {}) {
	return reservationStoredIdentities(reservation).some(
		(stored) => !storedIdentityCompatibleWithGroup(stored, group, reservation)
	);
}

function reservationMatchMethod(reservation = {}, group = {}) {
	const expected = group.key;
	const canonical = parseIdentityKey(reservation.otaIdentityKey);
	const crossTransport = parseIdentityKey(reservation.otaCrossTransportIdentityKey);
	if (reservationStoredIdentityConflictsGroup(reservation, group)) return "";
	if (canonical?.key === expected) return "ota_identity_key";
	if (crossTransport?.key === expected) return "ota_cross_transport_identity_key";
	const evidence = reservationAliasEvidence(reservation);
	if (!evidence.pairs.has(group.key)) return "";
	return "indexed_confirmation_alias";
}

function reservationHasAliasProvenanceConflict(reservation = {}, group = {}) {
	const evidence = reservationAliasEvidence(reservation);
	return !!(
		evidence.aliases.includes(group.confirmationNumber) &&
		evidence.providers.includes(group.provider) &&
		!evidence.pairs.has(group.key)
	);
}

function addReservationIndexEntry(index, key, reservation) {
	if (!key) return;
	const values = index.get(key) || [];
	values.push(reservation);
	index.set(key, values);
}

function buildReservationCoverageIndexes(reservations = []) {
	const byId = new Map();
	const byIdentityKey = new Map();
	const byProviderConfirmation = new Map();
	const byConfirmationAlias = new Map();
	for (const reservation of reservations) {
		const reservationId = idString(reservation._id);
		if (reservationId) byId.set(reservationId, reservation);
		for (const identity of [
			parseIdentityKey(reservation.otaIdentityKey),
			parseIdentityKey(reservation.otaCrossTransportIdentityKey),
		].filter(Boolean)) {
			addReservationIndexEntry(byIdentityKey, identity.key, reservation);
		}
		const evidence = reservationAliasEvidence(reservation);
		for (const key of evidence.pairs.keys()) {
			addReservationIndexEntry(byProviderConfirmation, key, reservation);
		}
		for (const confirmationNumber of evidence.aliases) {
			addReservationIndexEntry(
				byConfirmationAlias,
				confirmationNumber,
				reservation
			);
		}
	}
	return {
		byId,
		byIdentityKey,
		byProviderConfirmation,
		byConfirmationAlias,
	};
}

function reservationCandidatesForGroup(group, indexes) {
	const candidates = new Set([
		...(indexes.byIdentityKey.get(group.key) || []),
		...(indexes.byProviderConfirmation.get(group.key) || []),
		...(indexes.byConfirmationAlias.get(group.confirmationNumber) || []),
	]);
	for (const archive of group.archives) {
		const linked = indexes.byId.get(idString(archive.reservationMongoId));
		if (linked) candidates.add(linked);
	}
	return Array.from(candidates);
}

function representedGroup(group, indexes) {
	const linkedIds = new Set(
		group.archives.map((archive) => idString(archive.reservationMongoId)).filter(Boolean)
	);
	for (const reservation of reservationCandidatesForGroup(group, indexes)) {
		const method = reservationMatchMethod(reservation, group);
		if (method) return { reservation, method };
		if (!linkedIds.has(idString(reservation._id))) continue;
		if (reservationMatchMethod(reservation, group)) {
			return { reservation, method: "authenticated_archive_link" };
		}
	}
	return null;
}

function transportDisposition(group) {
	const transports = group.transportProviders;
	const hasHotelRunner = transports.has("hotelrunner");
	const hasDirect = DIRECT_OTA_PROVIDERS.some((provider) => transports.has(provider));
	if (hasHotelRunner && hasDirect) {
		return "corroborating_hotelrunner_relay_direct_winner";
	}
	if (hasHotelRunner && group.provider !== "hotelrunner") {
		return "hotelrunner_relay_only";
	}
	if (hasHotelRunner) return "hotelrunner_email_booking_only";
	return "direct_ota_only";
}

function firstSeenAt(group) {
	const timestamps = group.archives
		.map((archive) => validDate(archive.receivedAt)?.getTime())
		.filter(Number.isFinite);
	return timestamps.length ? new Date(Math.min(...timestamps)) : null;
}

function checkoutDates(group) {
	return sortedUnique(
		group.archives.map((archive) =>
			dateOnly(archive?.normalizedReservation?.checkoutDate)
		)
	);
}

function ageDetails(group, asOf) {
	const firstSeen = firstSeenAt(group);
	const ageDays = firstSeen
		? Math.max(0, Math.round(((asOf - firstSeen) / 86400000) * 10) / 10)
		: null;
	let ageBucket = "unknown";
	if (ageDays !== null && ageDays < 1) ageBucket = "under_1_day";
	else if (ageDays !== null && ageDays < 4) ageBucket = "1_to_3_days";
	else if (ageDays !== null && ageDays < 8) ageBucket = "4_to_7_days";
	else if (ageDays !== null && ageDays < 31) ageBucket = "8_to_30_days";
	else if (ageDays !== null) ageBucket = "over_30_days";
	return { ageDays, ageBucket };
}

function missingClassification(group, lifecycle, asOf) {
	const terminal = latestLaterTerminal(group, lifecycle);
	if (terminal) {
		return {
			classification: "later_terminal",
			reason: `later_${terminal.status}_email`,
			terminalStatus: terminal.status,
		};
	}
	const today = asOf.toISOString().slice(0, 10);
	const checkouts = checkoutDates(group);
	const latestCheckout = checkouts[checkouts.length - 1] || "";
	if (latestCheckout && latestCheckout < today) {
		return {
			classification: "expired",
			reason: "stay_checkout_before_audit_date",
			terminalStatus: "",
		};
	}
	if (!latestCheckout) {
		return {
			classification: "active_nonterminal",
			reason: "missing_checkout_cannot_prove_expired",
			terminalStatus: "",
		};
	}
	if (checkouts.length > 1) {
		return {
			classification: "active_nonterminal",
			reason: "conflicting_current_or_future_checkout_dates",
			terminalStatus: "",
		};
	}
	return {
		classification: "active_nonterminal",
		reason:
			latestCheckout === today
				? "checkout_today_nonterminal"
				: "future_stay_nonterminal",
		terminalStatus: "",
	};
}

function integrityFlags(group, indexes) {
	const loadedById = indexes.byId;
	const flags = new Set();
	const linkedIds = new Set(
		group.archives.map((archive) => idString(archive.reservationMongoId)).filter(Boolean)
	);
	for (const candidate of reservationCandidatesForGroup(group, indexes)) {
		if (reservationHasAliasProvenanceConflict(candidate, group)) {
			flags.add("alias_provider_provenance_conflict");
		}
		if (!reservationStoredIdentityConflictsGroup(candidate, group)) continue;
		const isAliasCandidate =
			reservationAliases(candidate).includes(group.confirmationNumber) &&
			reservationProviders(candidate).includes(group.provider);
		if (isAliasCandidate) {
			flags.add("alias_candidate_stored_identity_conflict");
		}
		if (linkedIds.has(idString(candidate._id))) {
			flags.add("linked_reservation_stored_identity_conflict");
		}
	}
	for (const archive of group.archives) {
		const linkedId = idString(archive.reservationMongoId);
		if (archive.hasReservationConnection === true && !linkedId) {
			flags.add("reservation_connection_without_id");
		}
		if (linkedId && !loadedById.has(linkedId)) {
			flags.add("linked_reservation_not_found");
			continue;
		}
		if (linkedId) {
			const linkedReservation = loadedById.get(linkedId);
			if (
				!reservationAliases(linkedReservation).includes(group.confirmationNumber)
			) {
				flags.add("linked_reservation_confirmation_mismatch");
			}
			if (!reservationProviders(linkedReservation).includes(group.provider)) {
				flags.add("linked_reservation_provider_mismatch");
			}
		}
	}
	return sortedUnique(Array.from(flags));
}

function normalizedLifecycleStatus(value) {
	return lower(value).replace(/[\s-]+/g, "_");
}

function positiveMoney(value) {
	const amount = Number(value);
	return Number.isFinite(amount) && amount > 0;
}

function samePositiveMoney(left, right) {
	if (!positiveMoney(left) || !positiveMoney(right)) return false;
	return Math.round(Number(left) * 100) === Math.round(Number(right) * 100);
}

function authenticatedDirectCommercialEvidence(group = {}) {
	return group.archives.find((archive) => {
		if (!isAuthenticatedNewArchive(archive)) return false;
		const transportProvider = archiveTransportProvider(archive);
		if (
			transportProvider === "hotelrunner" ||
			transportProvider !== group.provider
		) {
			return false;
		}
		const normalized = archive.normalizedReservation || {};
		const summary = normalized.paymentSummary || {};
		return Boolean(
			normalized?.sourcePresence?.amount === true &&
			normalized.propertyConversionVerified === true &&
			clean(normalized.propertyCurrency).toUpperCase() === "SAR" &&
			positiveMoney(normalized.sourceAmount) &&
			clean(normalized.sourceCurrency) &&
			positiveMoney(normalized.sourcePayoutAmount) &&
			clean(normalized.sourcePayoutCurrency) &&
			positiveMoney(normalized.totalAmountSar) &&
			positiveMoney(normalized.totalPayoutSar) &&
			samePositiveMoney(
				summary.totalGuestPaymentAmount,
				normalized.totalAmountSar
			) &&
			samePositiveMoney(
				summary.totalPayoutAmount,
				normalized.totalPayoutSar
			) &&
			clean(summary.currency).toUpperCase() === "SAR"
		);
	});
}

function isActiveOtaEmailCreatedReservation(reservation = {}) {
	if (
		lower(reservation?.supplierData?.otaAutomationPipeline) !==
		"ota-email-orchestrator"
	) {
		return false;
	}
	const creationSources = [
		reservation?.adminPricing?.source,
		reservation?.ota_financial_summary?.source,
	]
		.map(lower)
		.filter(Boolean);
	if (!creationSources.includes("ota_email_create")) return false;
	const statuses = sortedUnique(
		[reservation.state, reservation.reservation_status]
			.map(normalizedLifecycleStatus)
			.filter(Boolean)
	);
	if (!statuses.length) return false;
	if (
		statuses.some((status) => RESERVATION_TERMINAL_STATUSES.has(status))
	) {
		return false;
	}
	return statuses.some((status) =>
		ACTIVE_OR_PENDING_RESERVATION_STATUSES.has(status)
	);
}

function representedFinancialIntegrityReason(
	group = {},
	represented = null,
	lifecycle = []
) {
	if (!represented?.reservation) return "";
	if (latestLaterTerminal(group, lifecycle)) return "";
	if (!authenticatedDirectCommercialEvidence(group)) return "";
	const reservation = represented.reservation;
	if (!isActiveOtaEmailCreatedReservation(reservation)) return "";
	const hasGross = Boolean(
		positiveMoney(reservation.total_amount) ||
		positiveMoney(reservation?.adminPricing?.clientTotal)
	);
	const hasPayout = Boolean(
		positiveMoney(reservation?.adminPricing?.netAfterExpensesTotal) ||
		positiveMoney(reservation?.ota_financial_summary?.netAfterExpenses) ||
		positiveMoney(reservation?.supplierData?.otaTotalPayoutSar)
	);
	if (!hasGross && !hasPayout) {
		return "authenticated_direct_gross_and_payout_not_materialized";
	}
	if (!hasGross) return "authenticated_direct_gross_not_materialized";
	if (!hasPayout) return "authenticated_direct_payout_not_materialized";
	return "";
}

function pipelineAnomalyReason(archive = {}, asOf = new Date(), leaseMs = INBOUND_CLAIM_LEASE_MS) {
	if (!isAlignedTrustedTransportArchive(archive)) return "";
	if (isAuthenticatedNewArchive(archive)) return "";
	const intent = archiveIntent(archive);
	if (intent && intent !== "new_reservation") return "";
	const status = lower(archive.processingStatus);
	if (PIPELINE_HOLD_STATUSES.includes(status)) {
		return `${status}_without_canonical_identity`;
	}
	if (status !== "received") return "";
	const receivedAt = validDate(archive.receivedAt);
	const asOfDate = validDate(asOf);
	if (!receivedAt || !asOfDate) return "";
	return receivedAt.getTime() <= asOfDate.getTime() - Number(leaseMs)
		? "stale_received_without_canonical_identity"
		: "";
}

function summarizePipelineAnomalies(
	archives = [],
	{ asOf = new Date(), leaseMs = INBOUND_CLAIM_LEASE_MS } = {}
) {
	const asOfDate = requireDate(asOf, "asOf");
	const processingStatusCounts = {};
	const reasonCounts = {};
	const ageBucketCounts = {};
	const transportProviderCounts = {};
	let count = 0;
	for (const archive of archives) {
		const reason = pipelineAnomalyReason(archive, asOfDate, leaseMs);
		if (!reason) continue;
		count += 1;
		increment(processingStatusCounts, lower(archive.processingStatus));
		increment(reasonCounts, reason);
		increment(
			ageBucketCounts,
			ageDetails({ archives: [archive] }, asOfDate).ageBucket
		);
		increment(transportProviderCounts, archiveTransportProvider(archive));
	}
	return {
		count,
		processingStatusCounts: sortedCounts(processingStatusCounts),
		reasonCounts: sortedCounts(reasonCounts),
		ageBucketCounts: sortedCounts(ageBucketCounts),
		transportProviderCounts: sortedCounts(transportProviderCounts),
	};
}

function pipelineAnomalyIssueKeys(
	archives = [],
	{ asOf = new Date(), leaseMs = INBOUND_CLAIM_LEASE_MS } = {}
) {
	const asOfDate = requireDate(asOf, "asOf");
	return sortedUnique(
		archives
			.filter((archive) => pipelineAnomalyReason(archive, asOfDate, leaseMs))
			.map((archive) => {
				const receivedAt = validDate(archive.receivedAt);
				return (
					idString(archive._id) ||
					[
						archiveTransportProvider(archive),
						receivedAt
							? receivedAt.toISOString()
							: "unknown_received_at",
					].join(":")
				);
			})
	);
}

function buildAlertFingerprint(
	missingIdentities = [],
	pipelineIssueKeys = [],
	financialIntegrityIssueKeys = []
) {
	const activeIdentityKeys = sortedUnique(
		missingIdentities
			.filter((item) => item.status === "active_nonterminal")
			.map((item) => identityKey(item.provider, item.confirmationNumber))
	);
	return crypto
		.createHash("sha256")
		.update(
			JSON.stringify({
				activeIdentityKeys,
				pipelineIssueKeys: sortedUnique(pipelineIssueKeys),
				financialIntegrityIssueKeys: sortedUnique(
					financialIntegrityIssueKeys
				),
			})
		)
		.digest("hex");
}

function sanitizedMissingIdentity(group, classification, lifecycle, asOf, flags) {
	const statuses = sortedUnique(group.archives.map((archive) => lower(archive.processingStatus)));
	return {
		provider: group.provider,
		confirmationNumber: group.confirmationNumber,
		status: classification.classification,
		reason: classification.reason,
		ageDays: ageDetails(group, asOf).ageDays,
		ageBucket: ageDetails(group, asOf).ageBucket,
		transportDisposition: transportDisposition(group),
		creatingProcessingStatuses: statuses,
		creatingArchiveCount: group.archives.length,
		lifecycleArchiveCount: lifecycle.length,
		...(classification.terminalStatus
			? { terminalStatus: classification.terminalStatus }
			: {}),
		...(flags.length ? { integrityFlags: flags } : {}),
	};
}

function buildCoverageReport({
	creatingArchives = [],
	lifecycleArchives = [],
	pipelineArchives = [],
	reservations = [],
	since = ARCHIVE_START,
	asOf = new Date(),
	leaseMs = INBOUND_CLAIM_LEASE_MS,
	queryStats = {},
} = {}) {
	const sinceDate = requireDate(since, "since");
	const asOfDate = requireDate(asOf, "asOf");
	if (sinceDate > asOfDate) throw new RangeError("since cannot be after asOf.");
	const { groups, directWinners, eligible } = groupCandidateArchives(creatingArchives);
	const lifecycleGroups = groupLifecycleArchives(lifecycleArchives, directWinners);
	const reservationIndexes = buildReservationCoverageIndexes(reservations);
	const classificationCounts = {};
	const reasonCounts = {};
	const ageBucketCounts = {};
	const transportDispositionCounts = {};
	const creatingProcessingStatusCounts = {};
	const integrityFlagCounts = {};
	const missingIdentities = [];
	const financialIntegrityIssues = [];
	const financialIntegrityIssueKeys = [];
	let representedIdentityCount = 0;
	let integrityFlagIdentityCount = 0;

	for (const archive of eligible) {
		increment(creatingProcessingStatusCounts, lower(archive.processingStatus));
	}
	for (const group of Array.from(groups.values()).sort((left, right) =>
		left.key.localeCompare(right.key)
	)) {
		increment(transportDispositionCounts, transportDisposition(group));
		const flags = integrityFlags(group, reservationIndexes);
		const represented = representedGroup(group, reservationIndexes);
		if (represented) {
			representedIdentityCount += 1;
			increment(classificationCounts, "represented");
			const lifecycle = lifecycleGroups.get(group.key) || group.archives;
			const financialReason = representedFinancialIntegrityReason(
				group,
				represented,
				lifecycle
			);
			if (financialReason) {
				flags.push(financialReason);
				financialIntegrityIssueKeys.push(group.key);
				financialIntegrityIssues.push({
					provider: group.provider,
					confirmationNumber: group.confirmationNumber,
					status: "represented_financial_integrity",
					reason: financialReason,
					matchMethod: represented.method,
					transportDisposition: transportDisposition(group),
				});
			}
			const uniqueFlags = sortedUnique(flags);
			if (uniqueFlags.length) integrityFlagIdentityCount += 1;
			for (const flag of uniqueFlags) increment(integrityFlagCounts, flag);
			continue;
		}
		const uniqueFlags = sortedUnique(flags);
		if (uniqueFlags.length) integrityFlagIdentityCount += 1;
		for (const flag of uniqueFlags) increment(integrityFlagCounts, flag);
		const lifecycle = lifecycleGroups.get(group.key) || group.archives;
		const classification = missingClassification(group, lifecycle, asOfDate);
		const item = sanitizedMissingIdentity(
			group,
			classification,
			lifecycle,
			asOfDate,
			uniqueFlags
		);
		missingIdentities.push(item);
		increment(classificationCounts, classification.classification);
		increment(reasonCounts, classification.reason);
		increment(ageBucketCounts, item.ageBucket);
	}

	missingIdentities.sort((left, right) =>
		`${left.status}:${left.provider}:${left.confirmationNumber}`.localeCompare(
			`${right.status}:${right.provider}:${right.confirmationNumber}`
		)
	);
	financialIntegrityIssues.sort((left, right) =>
		`${left.provider}:${left.confirmationNumber}`.localeCompare(
			`${right.provider}:${right.confirmationNumber}`
		)
	);
	const activeNonterminalMissingCount = missingIdentities.filter(
		(item) => item.status === "active_nonterminal"
	).length;
	const laterTerminalMissingCount = missingIdentities.filter(
		(item) => item.status === "later_terminal"
	).length;
	const expiredMissingCount = missingIdentities.filter(
		(item) => item.status === "expired"
	).length;
	const pipelineAnomalies = summarizePipelineAnomalies(pipelineArchives, {
		asOf: asOfDate,
		leaseMs,
	});
	const alertFingerprint = buildAlertFingerprint(
		missingIdentities,
		pipelineAnomalyIssueKeys(pipelineArchives, {
			asOf: asOfDate,
			leaseMs,
		}),
		financialIntegrityIssueKeys
	);
	const financialIntegrityIssueCount = financialIntegrityIssues.length;
	const summary = {
		authenticatedNewArchiveCount: eligible.length,
		canonicalIdentityCount: groups.size,
		representedIdentityCount,
		noReservationIdentityCount: missingIdentities.length,
		activeNonterminalMissingCount,
		laterTerminalMissingCount,
		expiredMissingCount,
		incompletePipelineArchiveCount: pipelineAnomalies.count,
		classificationCounts: sortedCounts(classificationCounts),
		reasonCounts: sortedCounts(reasonCounts),
		ageBucketCounts: sortedCounts(ageBucketCounts),
		transportDispositionCounts: sortedCounts(transportDispositionCounts),
		creatingProcessingStatusCounts: sortedCounts(creatingProcessingStatusCounts),
		pipelineProcessingStatusCounts: pipelineAnomalies.processingStatusCounts,
		pipelineReasonCounts: pipelineAnomalies.reasonCounts,
		pipelineAgeBucketCounts: pipelineAnomalies.ageBucketCounts,
		pipelineTransportProviderCounts:
			pipelineAnomalies.transportProviderCounts,
		integrityFlagIdentityCount,
		integrityFlagCounts: sortedCounts(integrityFlagCounts),
		financialIntegrityIssueCount,
	};
	const report = {
		report: "ota_inbound_email_reservation_coverage",
		reportVersion: REPORT_VERSION,
		policyDate: POLICY_DATE,
		readOnly: true,
		vendorCalls: false,
		window: {
			since: sinceDate.toISOString(),
			asOf: asOfDate.toISOString(),
		},
		summary,
		missingIdentities,
		financialIntegrityIssues,
		alertFingerprint,
		alert: {
			active:
				activeNonterminalMissingCount > 0 ||
				pipelineAnomalies.count > 0 ||
				financialIntegrityIssueCount > 0,
			activeIdentityCount:
				activeNonterminalMissingCount + financialIntegrityIssueCount,
			incompletePipelineArchiveCount: pipelineAnomalies.count,
			financialIntegrityIssueCount,
			activeIssueCount:
				activeNonterminalMissingCount +
				pipelineAnomalies.count +
				financialIntegrityIssueCount,
			exitCode:
				activeNonterminalMissingCount > 0 ||
				pipelineAnomalies.count > 0 ||
				financialIntegrityIssueCount > 0
					? 2
					: 0,
			fingerprint: alertFingerprint,
		},
		queryStats: {
			creatingArchivesRead: Number(queryStats.creatingArchivesRead ?? creatingArchives.length),
			lifecycleArchivesRead: Number(queryStats.lifecycleArchivesRead ?? lifecycleArchives.length),
			pipelineArchivesRead: Number(queryStats.pipelineArchivesRead ?? pipelineArchives.length),
			reservationsRead: Number(queryStats.reservationsRead ?? reservations.length),
			reservationLookupRowsRead: Number(
				queryStats.reservationLookupRowsRead ?? reservations.length
			),
			reservationLookupQueryCount: Number(
				queryStats.reservationLookupQueryCount ?? 0
			),
		},
	};
	const cacheMaterial = JSON.stringify(report);
	report.cacheKey = crypto.createHash("sha256").update(cacheMaterial).digest("hex");
	return report;
}

const ARCHIVE_PROJECTION = [
	"_id",
	"provider",
	"intent",
	"eventType",
	"automationAction",
	"processingStatus",
	"hasReservationConnection",
	"confirmationNumber",
	"reservationMongoId",
	"receivedAt",
	"senderAuthentication.authenticatedAligned",
	"senderAuthentication.trustedProvider",
	"normalizedReservation.provider",
	"normalizedReservation.intent",
	"normalizedReservation.confirmationNumber",
	"normalizedReservation.reservationId",
	"normalizedReservation.bookingSource",
	"normalizedReservation.checkoutDate",
	"normalizedReservation.propertyCurrency",
	"normalizedReservation.propertyConversionVerified",
	"normalizedReservation.sourceAmount",
	"normalizedReservation.sourceCurrency",
	"normalizedReservation.sourcePayoutAmount",
	"normalizedReservation.sourcePayoutCurrency",
	"normalizedReservation.totalAmountSar",
	"normalizedReservation.totalPayoutSar",
	"normalizedReservation.paymentSummary.totalGuestPaymentAmount",
	"normalizedReservation.paymentSummary.totalPayoutAmount",
	"normalizedReservation.paymentSummary.currency",
	"normalizedReservation.sourcePresence.amount",
	"normalizedReservation.eventType",
	"normalizedReservation.statusToApply",
	"normalizedReservation.hotelRunnerCommercialSourceProviders",
].join(" ");

const RESERVATION_PROJECTION = [
	"_id",
	"otaIdentityKey",
	"otaCrossTransportIdentityKey",
	"reservation_id",
	"booking_source",
	"state",
	"reservation_status",
	"total_amount",
	"adminPricing.source",
	"adminPricing.clientTotal",
	"adminPricing.netAfterExpensesTotal",
	"ota_financial_summary.source",
	"ota_financial_summary.netAfterExpenses",
	"customer_details.confirmation_number2",
	"supplierData.suppliedBookingNo",
	"supplierData.otaConfirmationNumber",
	"supplierData.platformConfirmationNumber",
	"supplierData.otaProvider",
	"supplierData.otaAutomationPipeline",
	"supplierData.otaTotalPayoutSar",
	"supplierData.hotelRunner.providerNumber",
	"supplierData.hotelRunner.channel",
	"otaPlatformReview.confirmationNumber",
	"otaPlatformReview.provider",
].join(" ");

function buildArchiveCandidateFilter({ since = ARCHIVE_START, asOf = new Date() } = {}) {
	return {
		"senderAuthentication.authenticatedAligned": true,
		"senderAuthentication.trustedProvider": { $in: [...TRANSPORT_PROVIDERS] },
		$or: [
			{ intent: "new_reservation" },
			{ "normalizedReservation.intent": "new_reservation" },
		],
		receivedAt: {
			$gte: requireDate(since, "since"),
			$lte: requireDate(asOf, "asOf"),
		},
	};
}

function buildPipelineAnomalyFilter({
	since = ARCHIVE_START,
	asOf = new Date(),
	leaseMs = INBOUND_CLAIM_LEASE_MS,
} = {}) {
	const sinceDate = requireDate(since, "since");
	const asOfDate = requireDate(asOf, "asOf");
	if (sinceDate > asOfDate) throw new RangeError("since cannot be after asOf.");
	const staleBefore = new Date(asOfDate.getTime() - Number(leaseMs));
	const statusWindows = [
		{
			processingStatus: { $in: [...PIPELINE_HOLD_STATUSES] },
			receivedAt: { $gte: sinceDate, $lte: asOfDate },
		},
	];
	if (staleBefore >= sinceDate) {
		statusWindows.push({
			processingStatus: "received",
			receivedAt: { $gte: sinceDate, $lte: staleBefore },
		});
	}
	return {
		"senderAuthentication.authenticatedAligned": true,
		"senderAuthentication.trustedProvider": { $in: [...TRANSPORT_PROVIDERS] },
		$or: statusWindows,
	};
}

function buildLifecycleFilter(confirmations, { since = ARCHIVE_START, asOf = new Date() } = {}) {
	return {
		provider: { $in: [...TRANSPORT_PROVIDERS] },
		confirmationNumber: { $in: sortedUnique(confirmations.map(normalizeConfirmation)) },
		"senderAuthentication.authenticatedAligned": true,
		"senderAuthentication.trustedProvider": { $in: [...TRANSPORT_PROVIDERS] },
		receivedAt: {
			$gte: requireDate(since, "since"),
			$lte: requireDate(asOf, "asOf"),
		},
	};
}

function buildReservationLookupFilter(groups) {
	return { $or: buildReservationLookupFilters(groups) };
}

function buildReservationLookupFilters(groups) {
	const values = Array.from(groups.values());
	const keys = sortedUnique(values.map((group) => group.key));
	const confirmations = sortedUnique(
		values.map((group) => group.confirmationNumber)
	);
	const linkedIds = sortedUnique(
		values.flatMap((group) =>
			group.archives.map((archive) => idString(archive.reservationMongoId))
		)
	);
	const filters = [
		{ otaIdentityKey: { $in: keys, $type: "string", $gt: "" } },
		{
			otaCrossTransportIdentityKey: {
				$in: keys,
				$type: "string",
				$gt: "",
			},
		},
		{ reservation_id: { $in: confirmations } },
		{ "customer_details.confirmation_number2": { $in: confirmations } },
		{ "supplierData.suppliedBookingNo": { $in: confirmations } },
		{ "supplierData.otaConfirmationNumber": { $in: confirmations } },
		{ "supplierData.platformConfirmationNumber": { $in: confirmations } },
	];
	if (linkedIds.length) filters.push({ _id: { $in: linkedIds } });
	return filters;
}

async function leanFind(Model, filter, projection, sort, limit) {
	let query = Model.find(filter);
	if (typeof query.select === "function") query = query.select(projection);
	if (sort && typeof query.sort === "function") query = query.sort(sort);
	if (limit && typeof query.limit === "function") query = query.limit(limit);
	if (typeof query.lean === "function") query = query.lean();
	return typeof query.exec === "function" ? query.exec() : query;
}

async function loadIndexedReservationCandidates(
	ReservationModel,
	groups,
	{ maxReservations = DEFAULT_MAX_RESERVATIONS } = {}
) {
	const reservationLimit = Math.max(
		1,
		Number(maxReservations) || DEFAULT_MAX_RESERVATIONS
	);
	const byId = new Map();
	let rowsRead = 0;
	let queryCount = 0;
	for (const filter of buildReservationLookupFilters(groups)) {
		const rows = await leanFind(
			ReservationModel,
			filter,
			RESERVATION_PROJECTION,
			null,
			reservationLimit + 1
		);
		queryCount += 1;
		rowsRead += rows.length;
		if (rows.length > reservationLimit) {
			throw new CoverageAuditLimitError(
				"OTA_COVERAGE_RESERVATION_LIMIT",
				"An indexed Reservation identity query exceeded the shared safety limit."
			);
		}
		for (const reservation of rows) {
			const reservationId = idString(reservation._id);
			if (!reservationId) {
				throw new CoverageAuditLimitError(
					"OTA_COVERAGE_RESERVATION_ID_MISSING",
					"An indexed Reservation identity query returned a document without an ID."
				);
			}
			if (!byId.has(reservationId)) byId.set(reservationId, reservation);
		}
		if (byId.size > reservationLimit) {
			throw new CoverageAuditLimitError(
				"OTA_COVERAGE_RESERVATION_LIMIT",
				"Unique Reservation identity candidates exceeded the shared safety limit."
			);
		}
	}
	return {
		reservations: Array.from(byId.values()),
		queryCount,
		rowsRead,
	};
}

async function loadCoverageInputs({
	InboundEmailModel,
	ReservationModel,
	since = ARCHIVE_START,
	asOf = new Date(),
	maxArchives = DEFAULT_MAX_ARCHIVES,
	maxReservations = DEFAULT_MAX_RESERVATIONS,
	leaseMs = INBOUND_CLAIM_LEASE_MS,
} = {}) {
	if (!InboundEmailModel?.find || !ReservationModel?.find) {
		throw new TypeError("InboundEmailModel and ReservationModel are required.");
	}
	const sinceDate = requireDate(since, "since");
	const asOfDate = requireDate(asOf, "asOf");
	if (sinceDate > asOfDate) throw new RangeError("since cannot be after asOf.");
	const archiveLimit = Math.max(1, Number(maxArchives) || DEFAULT_MAX_ARCHIVES);
	const reservationLimit = Math.max(
		1,
		Number(maxReservations) || DEFAULT_MAX_RESERVATIONS
	);
	const creatingArchives = await leanFind(
		InboundEmailModel,
		buildArchiveCandidateFilter({ since: sinceDate, asOf: asOfDate }),
		ARCHIVE_PROJECTION,
		{ receivedAt: 1, _id: 1 },
		archiveLimit + 1
	);
	if (creatingArchives.length > archiveLimit) {
		throw new CoverageAuditLimitError(
			"OTA_COVERAGE_CREATING_ARCHIVE_LIMIT",
			"Authenticated new-reservation archive query exceeded its safety limit."
		);
	}
	const pipelineArchives = await leanFind(
		InboundEmailModel,
		buildPipelineAnomalyFilter({
			since: sinceDate,
			asOf: asOfDate,
			leaseMs,
		}),
		ARCHIVE_PROJECTION,
		{ receivedAt: 1, _id: 1 },
		archiveLimit + 1
	);
	if (pipelineArchives.length > archiveLimit) {
		throw new CoverageAuditLimitError(
			"OTA_COVERAGE_PIPELINE_ARCHIVE_LIMIT",
			"Authenticated incomplete-pipeline archive query exceeded its safety limit."
		);
	}
	const { groups } = groupCandidateArchives(creatingArchives);
	if (!groups.size) {
		return {
			creatingArchives,
			lifecycleArchives: [],
			pipelineArchives,
			reservations: [],
			queryStats: {
				creatingArchivesRead: creatingArchives.length,
				lifecycleArchivesRead: 0,
				pipelineArchivesRead: pipelineArchives.length,
				reservationsRead: 0,
				reservationLookupRowsRead: 0,
				reservationLookupQueryCount: 0,
			},
		};
	}
	const confirmations = Array.from(groups.values()).map(
		(group) => group.confirmationNumber
	);
	const lifecycleArchives = await leanFind(
		InboundEmailModel,
		buildLifecycleFilter(confirmations, { since: sinceDate, asOf: asOfDate }),
		ARCHIVE_PROJECTION,
		{ receivedAt: 1, _id: 1 },
		archiveLimit + 1
	);
	if (lifecycleArchives.length > archiveLimit) {
		throw new CoverageAuditLimitError(
			"OTA_COVERAGE_LIFECYCLE_ARCHIVE_LIMIT",
			"Authenticated lifecycle archive query exceeded its safety limit."
		);
	}
	const reservationLookup = await loadIndexedReservationCandidates(
		ReservationModel,
		groups,
		{ maxReservations: reservationLimit }
	);
	const reservations = reservationLookup.reservations;
	return {
		creatingArchives,
		lifecycleArchives,
		pipelineArchives,
		reservations,
		queryStats: {
			creatingArchivesRead: creatingArchives.length,
			lifecycleArchivesRead: lifecycleArchives.length,
			pipelineArchivesRead: pipelineArchives.length,
			reservationsRead: reservations.length,
			reservationLookupRowsRead: reservationLookup.rowsRead,
			reservationLookupQueryCount: reservationLookup.queryCount,
		},
	};
}

async function auditOtaInboundCoverage(options = {}) {
	const since = options.since || ARCHIVE_START;
	const asOf = options.asOf || new Date();
	const inputs = await loadCoverageInputs({ ...options, since, asOf });
	return buildCoverageReport({
		...inputs,
		since,
		asOf,
		leaseMs: options.leaseMs || INBOUND_CLAIM_LEASE_MS,
	});
}

module.exports = {
	ARCHIVE_START,
	DIRECT_OTA_PROVIDERS,
	TRANSPORT_PROVIDERS,
	CoverageAuditLimitError,
	ageDetails,
	auditOtaInboundCoverage,
	buildArchiveCandidateFilter,
	buildAlertFingerprint,
	buildCoverageReport,
	buildLifecycleFilter,
	buildPipelineAnomalyFilter,
	buildReservationLookupFilter,
	buildReservationLookupFilters,
	canonicalArchiveIdentity,
	canonicalProvider,
	groupCandidateArchives,
	identityKey,
	isAuthenticatedArchive,
	isAuthenticatedNewArchive,
	loadIndexedReservationCandidates,
	loadCoverageInputs,
	normalizedTerminalStatus,
	parseIdentityKey,
	pipelineAnomalyReason,
	representedFinancialIntegrityReason,
	reservationMatchMethod,
	summarizePipelineAnomalies,
	transportDisposition,
};
