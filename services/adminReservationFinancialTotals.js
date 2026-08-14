/** @format */

"use strict";

const {
	validateOtaCommercialEvidence,
} = require("./otaCommercialEvidence");
const {
	isHotelRunnerReservation,
	verifiedHotelRunnerProfitMetrics,
} = require("./hotelrunnerReportPricing");
const { summarizeRooms } = require("./reservationPricing");

const OTA_BOOKING_SOURCE_PATTERN =
	/(?:\bota\b|expedia|agoda|booking\.?com|airbnb|hotels?\.?com|trivago|trip\.?com|\btrip\b|ctrip)/i;
const CALCULATED_PRICING_MODE_PATTERN =
	/^(?:admin_three_price$|ota(?:_|$)|platform(?:_|$)|hotelrunner_api$)/i;
const AUDITED_OVERRIDE_SOURCE = "platform_ota_pricing_review";
const AUDITED_OVERRIDE_MODES = new Set(["ota_review", "admin_three_price"]);

const hasOwn = (source, field) =>
	Boolean(
		source &&
			typeof source === "object" &&
			Object.prototype.hasOwnProperty.call(source, field)
	);

const finiteMoneyOrNull = (value, { allowNegative = false } = {}) => {
	if (
		value === null ||
		value === undefined ||
		value === "" ||
		typeof value === "boolean" ||
		(typeof value !== "number" && typeof value !== "string")
	) {
		return null;
	}
	const normalized =
		typeof value === "string" ? value.replace(/,/g, "").trim() : value;
	if (normalized === "") return null;
	const amount = Number(normalized);
	return Number.isFinite(amount) && (allowNegative || amount >= 0)
		? Number(amount.toFixed(2))
		: null;
};

const sameMoney = (left, right) => {
	const leftAmount = finiteMoneyOrNull(left);
	const rightAmount = finiteMoneyOrNull(right);
	return (
		leftAmount !== null &&
		rightAmount !== null &&
		Math.abs(leftAmount - rightAmount) <= 0.009
	);
};

const sameSignedMoney = (left, right) => {
	const leftAmount = finiteMoneyOrNull(left, { allowNegative: true });
	const rightAmount = finiteMoneyOrNull(right, { allowNegative: true });
	return (
		leftAmount !== null &&
		rightAmount !== null &&
		Math.abs(leftAmount - rightAmount) <= 0.009
	);
};

const explicitCurrency = (...values) => {
	for (const value of values) {
		const currency = String(value || "").trim().toUpperCase();
		if (/^[A-Z]{3}$/.test(currency)) return currency;
	}
	return "";
};

const allExplicitCurrenciesAre = (expected, ...values) => {
	const currencies = values
		.map((value) => String(value || "").trim().toUpperCase())
		.filter(Boolean);
	return (
		currencies.length > 0 &&
		currencies.every(
			(currency) => /^[A-Z]{3}$/.test(currency) && currency === expected
		)
	);
};

const explicitMoneyCandidates = (entries = []) => {
	const amounts = [];
	for (const [source, field] of entries) {
		if (!hasOwn(source, field)) continue;
		const amount = finiteMoneyOrNull(source[field]);
		if (amount === null) return { valid: false, amounts: [] };
		amounts.push(amount);
	}
	return { valid: true, amounts };
};

const amountMatchesMaterializedCandidates = (amount, candidates) =>
	candidates.valid && candidates.amounts.every((value) => sameMoney(value, amount));

const normalizedId = (value) =>
	String(value?._id || value?.id || value || "").trim();

const validAuditActorId = (value) =>
	/^[a-f0-9]{24}$/i.test(normalizedId(value));

const validAuditDate = (value) => {
	if (!value) return false;
	const parsed = new Date(value);
	return Number.isFinite(parsed.getTime());
};

const sameAuditMoment = (left, right) => {
	if (!validAuditDate(left) || !validAuditDate(right)) return false;
	return new Date(left).getTime() === new Date(right).getTime();
};

const normalizedProvider = (value) =>
	String(value || "")
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "");

const nonEmptyString = (value) =>
	typeof value === "string" && value.trim().length > 0;

const strictFiniteNumber = (value, { allowNegative = false } = {}) =>
	typeof value === "number" &&
	Number.isFinite(value) &&
	(allowNegative || value >= 0);

const strictLegacyEmailMarkerShape = (marker = {}) =>
	Boolean(
		marker &&
			typeof marker === "object" &&
			!Array.isArray(marker) &&
			typeof marker.version === "number" &&
			marker.version === 2 &&
			marker.verified === true &&
			marker.source === "authenticated_ota_email" &&
			[
				marker.provider,
				marker.otaIdentityKey,
				marker.inboundEmailId,
				marker.sourceTextHash,
				marker.sourceReceivedAt,
				marker.evidenceHash,
			].every(nonEmptyString) &&
			/^[a-f0-9]{64}$/i.test(marker.sourceTextHash.trim()) &&
			/^[a-f0-9]{64}$/i.test(marker.evidenceHash.trim()) &&
			strictFiniteNumber(marker.grossTotalSar) &&
			strictFiniteNumber(marker.payoutTotalSar) &&
			strictFiniteNumber(marker.otaExpenseTotalSar) &&
			(marker.otaCommissionSar === null ||
				strictFiniteNumber(marker.otaCommissionSar)) &&
			strictFiniteNumber(marker.unclassifiedDeductionSar) &&
			Array.isArray(marker.deductionComponents) &&
			marker.deductionComponents.every(
				(component) =>
					component &&
					typeof component === "object" &&
					!Array.isArray(component) &&
					[component.type, component.label, component.currency, component.source].every(
						nonEmptyString
					) &&
					strictFiniteNumber(component.amountSar) &&
					component.amountSar > 0
			) &&
			Array.isArray(marker.unpricedDeductionLabels) &&
			marker.unpricedDeductionLabels.every(nonEmptyString) &&
			validAuditDate(marker.sourceReceivedAt) &&
			validAuditDate(marker.appliedAt)
	);

const legacyMarkerMatchesCanonicalEvidence = (
	reservation,
	marker,
	evidence
) => {
	if (!strictLegacyEmailMarkerShape(marker)) return false;
	const supplier = reservation?.supplierData || {};
	const primary = evidence?.provenance?.primary;
	const evidenceProvider = normalizedProvider(evidence?.provider);
	if (
		!primary ||
		typeof primary !== "object" ||
		primary.sourceType !== "authenticated_ota_email" ||
		!evidenceProvider ||
		normalizedProvider(primary.provider) !== evidenceProvider ||
		normalizedProvider(marker.provider) !== evidenceProvider ||
		(Boolean(String(supplier.otaProvider || "").trim()) &&
			normalizedProvider(supplier.otaProvider) !== evidenceProvider) ||
		String(marker.sourceTextHash).trim() !==
			String(primary.sourceHash || "").trim() ||
		String(marker.inboundEmailId).trim() !==
			String(primary.sourceId || "").trim() ||
		String(marker.sourceReceivedAt).trim() !==
			String(primary.sourceTimestamp || "").trim()
	) {
		return false;
	}
	return true;
};

const hasExplicitReviewedPricingDay = (day = {}) =>
	["totalPriceWithCommission", "price"].some((field) => hasOwn(day, field)) &&
	["rootPrice", "totalPriceWithoutCommission"].some((field) =>
		hasOwn(day, field)
	) &&
	[
		"netAfterExpenses",
		"netAfterOtaExpenses",
		"netAfterOtherExpenses",
		"otaExpenseAmount",
		"otherExpenseAmount",
		"expenseAmount",
	].some((field) => hasOwn(day, field));

const reviewedPricingRoomsAreComplete = (rooms = []) =>
	Array.isArray(rooms) &&
	rooms.length > 0 &&
	rooms.every((room) => {
		const count = Number(room?.count ?? 1);
		const rows = Array.isArray(room?.pricingByDay) ? room.pricingByDay : [];
		return (
			Number.isSafeInteger(count) &&
			count > 0 &&
			rows.length > 0 &&
			rows.every(hasExplicitReviewedPricingDay)
		);
	});

const persistedOriginalEvidenceAgrees = (
	reservation,
	{ gross, payout, expense }
) => {
	const found = { gross: false, payout: false, expense: false };
	for (const summary of [
		reservation?.ota_financial_summary,
		reservation?.otaFinancialSummary,
	]) {
		if (!summary || typeof summary !== "object") continue;
		for (const [role, fields, expected] of [
			["gross", ["clientTotal", "client_total"], gross],
			[
				"payout",
				["netAfterExpenses", "netAfterOtaExpenses", "hotelPayout"],
				payout,
			],
			["expense", ["otaExpenseTotal", "ota_expense_total"], expense],
		]) {
			for (const field of fields) {
				if (!hasOwn(summary, field)) continue;
				const value = summary[field];
				if (value === null || value === undefined || value === "") continue;
				found[role] = true;
				if (!sameMoney(value, expected)) return false;
			}
		}
		const summaryCurrencies = [summary.propertyCurrency, summary.currency].filter(
			(value) => String(value || "").trim()
		);
		if (
			summaryCurrencies.length > 0 &&
			!allExplicitCurrenciesAre("SAR", ...summaryCurrencies)
		) {
			return false;
		}
	}
	return found.gross && found.payout && found.expense;
};

/**
 * Resolve the server-stamped OTA pricing-review override without weakening the
 * normal evidence conflict boundary. The original authenticated OTA evidence
 * remains immutable; this branch accepts the later reviewed price only when
 * every persisted override, review, currency, and nightly-pricing invariant
 * reconciles exactly.
 */
const resolveAuditedOtaPricingOverride = (reservation = {}) => {
	const unavailable = () => ({
		available: false,
		gross: unavailableRole("invalid_audited_ota_pricing_override"),
		net: unavailableRole("invalid_audited_ota_pricing_override"),
	});
	const pricing = reservation?.adminPricing;
	if (!pricing || typeof pricing !== "object") return unavailable();
	if (pricing.clientTotalOverrideActive !== true) return unavailable();
	if (
		String(pricing.clientTotalOverrideSource || "").trim() !==
			AUDITED_OVERRIDE_SOURCE ||
		!AUDITED_OVERRIDE_MODES.has(
			String(pricing.mode || "").trim().toLowerCase()
		) ||
		pricing.commercialVerified !== true
	) {
		return unavailable();
	}

	const overrideAt = pricing.clientTotalOverrideAt;
	const overrideActorId = normalizedId(pricing.clientTotalOverrideBy);
	const review = reservation?.otaPlatformReview || {};
	const reviewActorId = normalizedId(review.lastPricingUpdatedBy);
	if (
		!validAuditActorId(overrideActorId) ||
		!validAuditActorId(reviewActorId) ||
		overrideActorId !== reviewActorId ||
		!sameAuditMoment(overrideAt, review.lastPricingUpdatedAt) ||
		!new Set(["pending", "released"]).has(
			String(review.status || "").trim().toLowerCase()
		)
	) {
		return unavailable();
	}

	const evidence = reservation?.supplierData?.otaCommercialEvidence;
	if (
		!evidence ||
		typeof evidence !== "object" ||
		Array.isArray(evidence) ||
		String(
			reservation?.supplierData?.otaCommercialEvidenceStaleReason || ""
		).trim() ||
		!validateOtaCommercialEvidence(evidence).ok ||
		evidence.bookingBasis !== "reservation_total" ||
		explicitCurrency(evidence.propertyCurrency) !== "SAR"
	) {
		return unavailable();
	}
	const evidenceGrossRole = evidence?.roles?.guestGross;
	const originalGross =
		evidenceGrossRole?.verified === true &&
		evidenceGrossRole.bookingBasis === evidence.bookingBasis &&
		explicitCurrency(evidenceGrossRole.propertyCurrency) === "SAR"
			? finiteMoneyOrNull(evidenceGrossRole.propertyAmount)
			: null;
	if (originalGross === null || originalGross <= 0) return unavailable();
	// The exceptional override must also remain anchored to the independently
	// hashed authenticated-email marker. This validator checks marker schema,
	// identity/provider, SAR arithmetic, timestamps, and its constant-time hash
	// without requiring the old source tuple to remain materialized as current
	// pricing.
	const markerCandidate =
		reservation?.supplierData?.hotelRunnerEmailCommercialEvidence;
	if (
		!legacyMarkerMatchesCanonicalEvidence(
			reservation,
			markerCandidate,
			evidence
		)
	) {
		return unavailable();
	}
	const {
		validatedHotelRunnerEmailCommercialEvidenceMarker,
	} = require("./otaReservationMapper");
	const legacyMarker = validatedHotelRunnerEmailCommercialEvidenceMarker(
		reservation,
		{
			provider: evidence.provider,
			grossTotalSar: originalGross,
			currency: "SAR",
		}
	);
	if (!legacyMarker) return unavailable();
	const evidencePayoutRole = evidence?.roles?.hotelPayout;
	const originalPayout =
		evidencePayoutRole?.verified === true &&
		evidencePayoutRole.bookingBasis === evidence.bookingBasis &&
		explicitCurrency(evidencePayoutRole.propertyCurrency) === "SAR"
			? finiteMoneyOrNull(evidencePayoutRole.propertyAmount)
			: null;
	const originalExpense =
		originalPayout !== null
			? finiteMoneyOrNull(originalGross - originalPayout)
			: null;
	if (
		originalPayout === null ||
		originalPayout <= 0 ||
		originalExpense === null ||
		!sameMoney(legacyMarker.payoutTotalSar, originalPayout) ||
		!sameMoney(legacyMarker.otaExpenseTotalSar, originalExpense) ||
		!persistedOriginalEvidenceAgrees(reservation, {
			gross: originalGross,
			payout: originalPayout,
			expense: originalExpense,
		})
	) {
		return unavailable();
	}

	const overrideGross = finiteMoneyOrNull(pricing.clientTotalOverrideSar);
	const overrideOriginal = finiteMoneyOrNull(
		pricing.clientTotalOverrideOriginalSar
	);
	const sourceOriginal = finiteMoneyOrNull(pricing.sourceClientTotalSar);
	const materializedGross = finiteMoneyOrNull(reservation.total_amount);
	const pricingGross = finiteMoneyOrNull(pricing.clientTotal);
	const pricingNet = finiteMoneyOrNull(pricing.netAfterExpensesTotal, {
		allowNegative: true,
	});
	const pricingExpense = finiteMoneyOrNull(pricing.otaExpenseTotal);
	const pricingRoot = finiteMoneyOrNull(pricing.rootTotal);
	const pricingMargin = finiteMoneyOrNull(pricing.platformMarginTotal, {
		allowNegative: true,
	});
	if (
		overrideGross === null ||
		overrideGross <= 0 ||
		![materializedGross, pricingGross].every((value) =>
			sameMoney(value, overrideGross)
		) ||
		![overrideOriginal, sourceOriginal].every((value) =>
			sameMoney(value, originalGross)
		) ||
		!String(pricing.sourceClientTotalSource || "").trim() ||
		pricingNet === null ||
		pricingExpense === null ||
		pricingRoot === null ||
		pricingMargin === null ||
		!sameMoney(pricingNet + pricingExpense, overrideGross) ||
		!sameSignedMoney(pricingNet - pricingRoot, pricingMargin) ||
		!allExplicitCurrenciesAre(
			"SAR",
			pricing.propertyCurrency,
			reservation.currency
		) ||
		(Boolean(String(pricing.sourceCurrency || "").trim()) &&
			explicitCurrency(pricing.sourceCurrency) !==
				explicitCurrency(evidence.sourceCurrency))
	) {
		return unavailable();
	}

	const rooms = reservation.pickedRoomsPricing;
	if (!reviewedPricingRoomsAreComplete(rooms)) return unavailable();
	const roomSummary = summarizeRooms(rooms);
	if (
		!sameMoney(roomSummary.total_amount, overrideGross) ||
		!sameMoney(roomSummary.adminPricing.clientTotal, pricingGross) ||
		!sameMoney(roomSummary.adminPricing.rootTotal, pricingRoot) ||
		!sameSignedMoney(
			roomSummary.adminPricing.netAfterExpensesTotal,
			pricingNet
		) ||
		!sameMoney(roomSummary.adminPricing.otaExpenseTotal, pricingExpense) ||
		!sameSignedMoney(
			roomSummary.adminPricing.platformMarginTotal,
			pricingMargin
		)
	) {
		return unavailable();
	}

	return {
		available: true,
		gross: availableRole(
			overrideGross,
			"SAR",
			"audited_ota_pricing_override"
		),
		net: availableRole(
			pricingNet,
			"SAR",
			"audited_ota_pricing_override",
			{ allowNegative: true }
		),
	};
};

const hasOtaManagedPricingSignal = (reservation = {}) => {
	const supplierData = reservation?.supplierData || {};
	const pricingMode = String(reservation?.adminPricing?.mode || "").trim();
	return Boolean(
		reservation?.otaPlatformReview ||
		supplierData.otaCreatedFromEmail ||
		supplierData.otaProvider ||
		supplierData.otaCommercialEvidence ||
		supplierData.hotelRunnerEmailCommercialEvidence ||
		reservation?.adminPricingVisibility?.rootOnlyForHotelManagement ||
		CALCULATED_PRICING_MODE_PATTERN.test(pricingMode) ||
		OTA_BOOKING_SOURCE_PATTERN.test(String(reservation?.booking_source || "")) ||
		isHotelRunnerReservation(reservation)
	);
};

const unavailableRole = (reason = "unavailable") => ({
	available: false,
	amount: null,
	currency: "",
	source: "",
	reason,
});

const availableRole = (
	amount,
	currency,
	source,
	{ allowNegative = false } = {}
) => ({
	available: true,
	amount: finiteMoneyOrNull(amount, { allowNegative }),
	currency,
	source,
	reason: "",
});

const resolveProviderNeutralEvidence = (reservation = {}) => {
	const supplierData = reservation?.supplierData || {};
	const evidence = supplierData.otaCommercialEvidence;
	if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
		return { present: false, gross: unavailableRole(), net: unavailableRole() };
	}
	if (String(supplierData.otaCommercialEvidenceStaleReason || "").trim()) {
		return {
			present: true,
			gross: unavailableRole("stale_commercial_evidence"),
			net: unavailableRole("stale_commercial_evidence"),
		};
	}

	const validation = validateOtaCommercialEvidence(evidence);
	if (!validation.ok) {
		return {
			present: true,
			gross: unavailableRole("invalid_commercial_evidence"),
			net: unavailableRole("invalid_commercial_evidence"),
		};
	}

	const evidenceCurrency = explicitCurrency(evidence.propertyCurrency);
	const materializedCurrencies = [
		reservation?.adminPricing?.propertyCurrency,
		reservation?.ota_financial_summary?.propertyCurrency,
		reservation?.otaFinancialSummary?.propertyCurrency,
	]
		.map((value) => explicitCurrency(value))
		.filter(Boolean);
	const currencyConflict = materializedCurrencies.some(
		(currency) => currency !== evidenceCurrency
	);
	const roleAmount = (role) => {
		if (
			role?.verified !== true ||
			role.bookingBasis !== evidence.bookingBasis ||
			explicitCurrency(role.propertyCurrency) !== evidenceCurrency
		) {
			return null;
		}
		return finiteMoneyOrNull(role.propertyAmount);
	};

	const grossAmount = roleAmount(evidence?.roles?.guestGross);
	const payoutAmount = roleAmount(evidence?.roles?.hotelPayout);
	const grossCandidates = explicitMoneyCandidates([
		[reservation, "total_amount"],
		[reservation?.adminPricing, "clientTotal"],
		[reservation?.ota_financial_summary, "clientTotal"],
		[reservation?.otaFinancialSummary, "clientTotal"],
	]);
	const netCandidates = explicitMoneyCandidates([
		[reservation?.adminPricing, "netAfterExpensesTotal"],
		[reservation?.ota_financial_summary, "netAfterExpenses"],
		[reservation?.ota_financial_summary, "netAfterOtaExpenses"],
		[reservation?.otaFinancialSummary, "netAfterExpenses"],
		[reservation?.otaFinancialSummary, "netAfterOtaExpenses"],
	]);

	const gross =
		grossAmount !== null &&
		!currencyConflict &&
		amountMatchesMaterializedCandidates(grossAmount, grossCandidates)
			? availableRole(grossAmount, evidenceCurrency, "ota_commercial_evidence")
			: unavailableRole("gross_evidence_conflict");
	const net =
		payoutAmount !== null &&
		!currencyConflict &&
		amountMatchesMaterializedCandidates(payoutAmount, netCandidates)
			? availableRole(payoutAmount, evidenceCurrency, "ota_commercial_evidence")
			: unavailableRole("net_evidence_conflict");

	return { present: true, gross, net };
};

const resolveLegacyEmailEvidence = (reservation = {}) => {
	const marker = reservation?.supplierData?.hotelRunnerEmailCommercialEvidence;
	if (!marker || typeof marker !== "object" || Array.isArray(marker)) {
		return { present: false, gross: unavailableRole(), net: unavailableRole() };
	}

	// This validator also checks identity, hash, SAR role, reconciliation, and
	// exact materialization into the reservation's canonical financial fields.
	const {
		verifiedHotelRunnerEmailCommercialEvidence,
	} = require("./otaReservationMapper");
	const verified = verifiedHotelRunnerEmailCommercialEvidence(reservation, {
		provider: marker.provider,
		grossTotalSar: marker.grossTotalSar,
		currency: "SAR",
	});
	if (!verified) {
		return {
			present: true,
			gross: unavailableRole("invalid_legacy_email_evidence"),
			net: unavailableRole("invalid_legacy_email_evidence"),
		};
	}
	return {
		present: true,
		gross: availableRole(verified.grossTotalSar, "SAR", "ota_email_evidence"),
		net: availableRole(verified.payoutTotalSar, "SAR", "ota_email_evidence"),
	};
};

const resolveVerifiedHotelRunnerMaterializedNet = (reservation = {}) => {
	const metrics = verifiedHotelRunnerProfitMetrics(reservation);
	if (!metrics.isHotelRunner || !metrics.netAfterExpenses?.available) {
		return unavailableRole("unverified_hotelrunner_net");
	}
	const currency = explicitCurrency(
		reservation?.adminPricing?.propertyCurrency,
		reservation?.ota_financial_summary?.propertyCurrency,
		reservation?.otaFinancialSummary?.propertyCurrency,
		reservation?.currency,
		"SAR"
	);
	return availableRole(
		metrics.netAfterExpenses.amount,
		currency,
		"verified_hotelrunner_pricing"
	);
};

const persistedNightlyRoleAmount = (
	reservation,
	fields,
	{ allowNegative = false } = {}
) => {
	for (const rooms of [
		reservation?.pickedRoomsPricing,
		reservation?.pickedRoomsType,
	]) {
		if (!Array.isArray(rooms) || rooms.length === 0) continue;
		let total = 0;
		let sawDay = false;
		let complete = true;
		for (const room of rooms) {
			const count = Number(room?.count ?? 1);
			const days = Array.isArray(room?.pricingByDay)
				? room.pricingByDay
				: [];
			if (!Number.isSafeInteger(count) || count <= 0 || days.length === 0) {
				complete = false;
				break;
			}
			for (const day of days) {
				let amount = null;
				for (const field of fields) {
					if (!hasOwn(day, field)) continue;
					amount = finiteMoneyOrNull(day[field], { allowNegative });
					if (amount !== null) break;
				}
				if (amount === null) {
					complete = false;
					break;
				}
				total += amount * count;
				sawDay = true;
			}
			if (!complete) break;
		}
		if (complete && sawDay && Number.isFinite(total)) {
			return Number(total.toFixed(2));
		}
	}
	return null;
};

const firstPersistedRole = (
	candidates,
	defaultCurrency,
	{
		allowNegative = false,
		preferPositive = false,
		requiredCurrency = "",
	} = {}
) => {
	let deferredZero = null;
	const normalizedRequiredCurrency = explicitCurrency(requiredCurrency);
	for (const candidate of candidates) {
		if (!candidate || !hasOwn(candidate.source, candidate.field)) continue;
		const amount = finiteMoneyOrNull(candidate.source[candidate.field], {
			allowNegative,
		});
		if (amount === null || (candidate.ignoreUnmarkedZero && amount === 0)) {
			continue;
		}
		const rawCandidateCurrency = String(candidate.currency || "").trim();
		const currency = rawCandidateCurrency
			? /^[A-Z]{3}$/.test(rawCandidateCurrency.toUpperCase())
				? rawCandidateCurrency.toUpperCase()
				: ""
			: defaultCurrency;
		if (!currency) continue;
		if (normalizedRequiredCurrency && currency !== normalizedRequiredCurrency) {
			continue;
		}
		const role = availableRole(amount, currency, candidate.label, {
			allowNegative,
		});
		if (preferPositive && amount === 0) {
			deferredZero ||= role;
			continue;
		}
		return role;
	}
	return deferredZero || unavailableRole("persisted_role_not_recorded");
};

/**
 * Admin pages display persisted commercial roles. Authentication/evidence
 * remains authoritative when it resolves a role, but incomplete or stale
 * evidence must not hide a separately saved guest gross or hotel payout.
 * These fallbacks are display-only and deliberately never use paid, root/base,
 * subtotal, or commission fields as substitutes for a commercial role.
 */
const resolvePersistedDisplayPricing = (
	reservation = {},
	{ requiredGrossCurrency = "", requiredNetCurrency = "" } = {}
) => {
	const adminPricing = reservation?.adminPricing || {};
	const snakeSummary = reservation?.ota_financial_summary || {};
	const camelSummary = reservation?.otaFinancialSummary || {};
	const supplier = reservation?.supplierData || {};
	const paymentSummary = supplier.otaPaymentSummary || {};
	const snakePaymentSummary = snakeSummary.paymentSummary || {};
	const camelPaymentSummary = camelSummary.paymentSummary || {};
	const calculatedMode = CALCULATED_PRICING_MODE_PATTERN.test(
		String(adminPricing.mode || "").trim()
	);
	const defaultCurrency = explicitCurrency(
		adminPricing.propertyCurrency,
		reservation?.currency,
		snakeSummary.propertyCurrency,
		snakeSummary.currency,
		camelSummary.propertyCurrency,
		camelSummary.currency,
		paymentSummary.propertyCurrency,
		paymentSummary.currency,
		snakePaymentSummary.propertyCurrency,
		snakePaymentSummary.currency,
		camelPaymentSummary.propertyCurrency,
		camelPaymentSummary.currency,
		"SAR"
	);
	const gross = firstPersistedRole(
		[
			{
				source: adminPricing,
				field: "clientTotal",
				currency: adminPricing.propertyCurrency,
				label: "persisted_admin_pricing",
				ignoreUnmarkedZero: !calculatedMode,
			},
			...[
				[snakeSummary, "clientTotal"],
				[snakeSummary, "client_total"],
				[camelSummary, "clientTotal"],
				[camelSummary, "client_total"],
			].map(([source, field]) => ({
				source,
				field,
				currency: source.propertyCurrency || source.currency,
				label: "persisted_ota_financial_summary",
				ignoreUnmarkedZero:
					source.commercialVerified !== true && !calculatedMode,
			})),
			...[
				[snakePaymentSummary, "totalGuestPaymentAmount"],
				[camelPaymentSummary, "totalGuestPaymentAmount"],
			].map(([source, field]) => ({
				source,
				field,
				currency: source.propertyCurrency || source.currency,
				label: "persisted_ota_financial_summary",
			})),
			{
				source: supplier,
				field: "otaAmountSar",
				currency: "SAR",
				label: "persisted_supplier_pricing",
			},
			{
				source: paymentSummary,
				field: "totalGuestPaymentAmount",
				currency: paymentSummary.propertyCurrency || paymentSummary.currency,
				label: "persisted_supplier_pricing",
			},
			{
				source: reservation,
				field: "total_amount",
				currency: reservation.currency,
				label: "reservation_total",
			},
		],
		defaultCurrency,
		{ preferPositive: true, requiredCurrency: requiredGrossCurrency }
	);
	const net = firstPersistedRole(
		[
			{
				source: adminPricing,
				field: "netAfterExpensesTotal",
				currency: adminPricing.propertyCurrency,
				label: "persisted_admin_pricing",
				ignoreUnmarkedZero: !calculatedMode,
			},
			...[
				[snakeSummary, "netAfterExpenses"],
				[snakeSummary, "netAfterOtaExpenses"],
				[snakeSummary, "hotelPayout"],
				[camelSummary, "netAfterExpenses"],
				[camelSummary, "netAfterOtaExpenses"],
				[camelSummary, "hotelPayout"],
			].map(([source, field]) => ({
				source,
				field,
				currency: source.propertyCurrency || source.currency,
				label: "persisted_ota_financial_summary",
				ignoreUnmarkedZero:
					source.commercialVerified !== true && !calculatedMode,
			})),
			...[
				[snakePaymentSummary, "totalPayoutAmount"],
				[camelPaymentSummary, "totalPayoutAmount"],
			].map(([source, field]) => ({
				source,
				field,
				currency: source.propertyCurrency || source.currency,
				label: "persisted_ota_financial_summary",
			})),
			{
				source: supplier,
				field: "otaTotalPayoutSar",
				currency: "SAR",
				label: "persisted_supplier_pricing",
			},
			{
				source: paymentSummary,
				field: "totalPayoutAmount",
				currency: paymentSummary.propertyCurrency || paymentSummary.currency,
				label: "persisted_supplier_pricing",
			},
		],
		defaultCurrency,
		{ allowNegative: true, requiredCurrency: requiredNetCurrency }
	);
	const nightlyGross = persistedNightlyRoleAmount(
		reservation,
		["clientPrice", "mainPrice", "totalPriceWithCommission", "price"]
	);
	const nightlyNet = persistedNightlyRoleAmount(
		reservation,
		["netAfterExpenses", "netAfterOtaExpenses", "netAfterOtherExpenses"],
		{ allowNegative: true }
	);
	const nightlyGrossCurrencyMatches =
		!explicitCurrency(requiredGrossCurrency) ||
		defaultCurrency === explicitCurrency(requiredGrossCurrency);
	const nightlyNetCurrencyMatches =
		!explicitCurrency(requiredNetCurrency) ||
		defaultCurrency === explicitCurrency(requiredNetCurrency);
	const shouldUseNightlyGross =
		nightlyGrossCurrencyMatches &&
		nightlyGross !== null &&
		(!gross.available || (gross.amount === 0 && nightlyGross > 0));
	return {
		gross: shouldUseNightlyGross
			? availableRole(
						nightlyGross,
						defaultCurrency,
						"persisted_nightly_pricing"
					)
			: gross,
		net:
			net.available || nightlyNet === null || !nightlyNetCurrencyMatches
				? net
				: availableRole(
						nightlyNet,
						defaultCurrency,
						"persisted_nightly_pricing",
						{ allowNegative: true }
					),
	};
};

// Preserve the established direct-reservation calculation path when no
// persisted OTA role was recorded.
const resolveCalculatedNet = (reservation = {}) => {
	const adminPricing = reservation?.adminPricing || {};
	const mode = String(adminPricing.mode || "").trim();
	if (
		!CALCULATED_PRICING_MODE_PATTERN.test(mode) ||
		!hasOwn(adminPricing, "netAfterExpensesTotal")
	) {
		return unavailableRole("net_not_calculated");
	}
	const amount = finiteMoneyOrNull(adminPricing.netAfterExpensesTotal, {
		allowNegative: true,
	});
	if (amount === null) return unavailableRole("invalid_calculated_net");
	return availableRole(
		amount,
		explicitCurrency(adminPricing.propertyCurrency, reservation?.currency, "SAR"),
		"admin_pricing",
		{ allowNegative: true }
	);
};

const resolveAdminReservationFinancialTotals = (reservation = {}) => {
	const auditedOverride = resolveAuditedOtaPricingOverride(reservation);
	if (auditedOverride.available) {
		return {
			grossTotalAmount: auditedOverride.gross.amount,
			netTotalAmount: auditedOverride.net.amount,
			currency: "SAR",
			grossAvailable: true,
			netAvailable: true,
			grossSource: auditedOverride.gross.source,
			netSource: auditedOverride.net.source,
			isOtaManaged: hasOtaManagedPricingSignal(reservation),
			isHotelRunner: isHotelRunnerReservation(reservation),
		};
	}
	const providerEvidence = resolveProviderNeutralEvidence(reservation);
	const legacyEvidence = resolveLegacyEmailEvidence(reservation);
	const chooseEvidenceRole = (providerRole, legacyRole) => {
		if (
			providerRole.available &&
			legacyRole.available &&
			(!sameMoney(providerRole.amount, legacyRole.amount) ||
				providerRole.currency !== legacyRole.currency)
		) {
			return unavailableRole("commercial_evidence_conflict");
		}
		return providerRole.available ? providerRole : legacyRole;
	};
	const authoritativeEvidence = {
		present: providerEvidence.present || legacyEvidence.present,
		gross: chooseEvidenceRole(providerEvidence.gross, legacyEvidence.gross),
		net: chooseEvidenceRole(providerEvidence.net, legacyEvidence.net),
	};
	const isHotelRunner = isHotelRunnerReservation(reservation);
	const otaManaged = hasOtaManagedPricingSignal(reservation);
	const defaultCurrency = explicitCurrency(
		reservation?.adminPricing?.propertyCurrency,
		reservation?.currency,
		"SAR"
	);
	const supplierData = reservation?.supplierData || {};
	const hasAnyCommercialEvidenceState =
		hasOwn(supplierData, "otaCommercialEvidence") ||
		hasOwn(supplierData, "hotelRunnerEmailCommercialEvidence") ||
		Boolean(
			String(supplierData.otaCommercialEvidenceStaleReason || "").trim()
		);
	const persistedDisplayPricing = otaManaged
		? resolvePersistedDisplayPricing(reservation)
		: null;

	let gross = authoritativeEvidence.gross;
	if (!gross.available) {
		if (persistedDisplayPricing?.gross.available) {
			gross = persistedDisplayPricing.gross;
		} else if (!authoritativeEvidence.present && !isHotelRunner) {
			const totalAmount = hasOwn(reservation, "total_amount")
				? finiteMoneyOrNull(reservation.total_amount)
				: null;
			const clientTotal = hasOwn(reservation?.adminPricing, "clientTotal")
				? finiteMoneyOrNull(reservation.adminPricing.clientTotal)
				: null;
			const amount = totalAmount !== null ? totalAmount : clientTotal;
			gross =
				amount === null
					? unavailableRole("gross_not_recorded")
					: availableRole(amount, defaultCurrency, "reservation_total");
		}
	}

	let net = authoritativeEvidence.net;
	if (
		net.available &&
		gross.available &&
		net.currency !== gross.currency
	) {
		net = unavailableRole("commercial_role_currency_conflict");
	}
	if (!net.available) {
		let persistedNet = persistedDisplayPricing?.net;
		if (
			persistedNet?.available &&
			gross.available &&
			persistedNet.currency !== gross.currency
		) {
			persistedNet = resolvePersistedDisplayPricing(reservation, {
				requiredNetCurrency: gross.currency,
			}).net;
		}
		if (persistedNet?.available) {
			net = persistedNet;
		} else if (
			!authoritativeEvidence.present &&
			isHotelRunner &&
			!hasAnyCommercialEvidenceState
		) {
			net = resolveVerifiedHotelRunnerMaterializedNet(reservation);
		} else if (
			!authoritativeEvidence.present &&
			!isHotelRunner &&
			otaManaged
		) {
			net = resolveCalculatedNet(reservation);
		} else if (
			!authoritativeEvidence.present &&
			!isHotelRunner &&
			gross.available
		) {
			net = availableRole(gross.amount, gross.currency, "no_ota_deduction");
		}
	}

	const currency =
		(gross.available && gross.currency) ||
		(net.available && net.currency) ||
		defaultCurrency;
	return {
		grossTotalAmount: gross.available ? gross.amount : null,
		netTotalAmount: net.available ? net.amount : null,
		currency,
		grossAvailable: gross.available,
		netAvailable: net.available,
		grossSource: gross.source,
		netSource: net.source,
		isOtaManaged: otaManaged,
		isHotelRunner,
	};
};

module.exports = {
	finiteMoneyOrNull,
	hasOtaManagedPricingSignal,
	resolveAuditedOtaPricingOverride,
	resolveAdminReservationFinancialTotals,
};
