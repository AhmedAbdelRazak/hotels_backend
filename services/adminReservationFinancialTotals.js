/** @format */

"use strict";

const {
	validateOtaCommercialEvidence,
} = require("./otaCommercialEvidence");
const {
	isHotelRunnerReservation,
	verifiedHotelRunnerProfitMetrics,
} = require("./hotelrunnerReportPricing");

const OTA_BOOKING_SOURCE_PATTERN =
	/(?:\bota\b|expedia|agoda|booking\.?com|airbnb|hotels?\.?com|trivago|trip\.?com|\btrip\b|ctrip)/i;
const CALCULATED_PRICING_MODE_PATTERN =
	/^(?:admin_three_price$|ota(?:_|$)|platform(?:_|$)|hotelrunner_api$)/i;

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

const explicitCurrency = (...values) => {
	for (const value of values) {
		const currency = String(value || "").trim().toUpperCase();
		if (/^[A-Z]{3}$/.test(currency)) return currency;
	}
	return "";
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

	let gross = authoritativeEvidence.gross;
	if (!authoritativeEvidence.present && !isHotelRunner) {
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

	let net = authoritativeEvidence.net;
	if (!authoritativeEvidence.present) {
		if (isHotelRunner) {
			net = resolveVerifiedHotelRunnerMaterializedNet(reservation);
		} else if (otaManaged) {
			net = resolveCalculatedNet(reservation);
		} else if (gross.available) {
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
	resolveAdminReservationFinancialTotals,
};
