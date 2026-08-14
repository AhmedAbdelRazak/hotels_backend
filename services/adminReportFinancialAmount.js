/** @format */

"use strict";

const {
  resolveAdminReservationFinancialTotals,
} = require("./adminReservationFinancialTotals");

const ADMIN_REPORT_FINANCIAL_AMOUNT_PROJECTION = Object.freeze([
  "total_amount",
  "currency",
  "booking_source",
  "adminPricing",
  "adminPricingVisibility.rootOnlyForHotelManagement",
  "ota_financial_summary",
  "otaFinancialSummary",
  "otaPlatformReview",
  "supplierData.otaCreatedFromEmail",
  "supplierData.otaProvider",
  "supplierData.otaAutomationPipeline",
  "supplierData.otaCommercialEvidence",
  "supplierData.otaCommercialEvidenceStaleReason",
  "supplierData.hotelRunnerEmailCommercialEvidence",
  "supplierData.hotelRunner.transport",
  "supplierData.hotelRunner.reservationId",
  "supplierData.hotelRunner.hrNumber",
  "supplierData.hotelRunner.pricing",
  "supplierData.otaCommissionSar",
  "supplierData.otaCommissionSource",
  "supplierData.otaCommissionSourceBacked",
  "supplierData.otaAmountSar",
  "supplierData.otaTotalPayoutSar",
  "supplierData.otaExpenseTotalSar",
  "supplierData.otaPayoutFallbackReason",
  "supplierData.otaPaymentSummary",
  // Legacy authenticated-email evidence verifies these materialized fields in
  // addition to the canonical pricing and supplier objects above.
  "otaIdentityKey",
  "otaCrossTransportIdentityKey",
  "pickedRoomsPricing",
  "pickedRoomsType",
  "commission_ota",
]).join(" ");

const normalizeAdminReportFinancialMode = (value = "gross") => {
  const normalized = String(value == null ? "" : value)
    .trim()
    .toLowerCase();
  return normalized === "net" ? "net" : "gross";
};

const moneyCentsOrNull = (value) => {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const cents = Math.round(value * 100);
  return Number.isSafeInteger(cents) ? cents : null;
};

const normalizedCurrency = (value) => {
  const currency = String(value || "")
    .trim()
    .toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : "";
};

const unavailableAmount = (mode, reason) => ({
  mode,
  available: false,
  amount: null,
  amountCents: null,
  currency: "",
  netFallback: false,
  sourceMode: null,
  reason,
});

const availableAmount = ({
  mode,
  amountCents,
  currency,
  netFallback = false,
  sourceMode,
}) => ({
  mode,
  available: true,
  amount: amountCents / 100,
  amountCents,
  currency,
  netFallback,
  sourceMode,
  reason: "",
});

/**
 * Select one role-safe reservation amount for an admin financial report.
 *
 * Net follows the established all-reservations display policy: use the
 * canonical verified/available net when present, otherwise use the canonical
 * verified/available gross. Raw totals never bypass the canonical resolver.
 */
const resolveAdminReportFinancialAmount = (
  reservation = {},
  requestedMode = "gross"
) => {
  const mode = normalizeAdminReportFinancialMode(requestedMode);
  const totals = resolveAdminReservationFinancialTotals(reservation);
  const currency = normalizedCurrency(totals.currency);
  if (!currency) return unavailableAmount(mode, "currency_unavailable");

  const grossCents =
    totals.grossAvailable === true
      ? moneyCentsOrNull(totals.grossTotalAmount)
      : null;
  const netCents =
    totals.netAvailable === true
      ? moneyCentsOrNull(totals.netTotalAmount)
      : null;

  if (mode === "gross") {
    if (grossCents === null) {
      return unavailableAmount(mode, "gross_unavailable");
    }
    return availableAmount({
      mode,
      amountCents: grossCents,
      currency,
      sourceMode: "gross",
    });
  }

  if (netCents !== null) {
    return availableAmount({
      mode,
      amountCents: netCents,
      currency,
      sourceMode: "net",
    });
  }
  if (grossCents !== null) {
    return availableAmount({
      mode,
      amountCents: grossCents,
      currency,
      netFallback: true,
      sourceMode: "gross",
    });
  }
  return unavailableAmount(mode, "net_and_gross_unavailable");
};

/**
 * Aggregate only SAR property amounts. Metadata categories are intentionally
 * not mutually exclusive: a foreign-currency row can also have used the net
 * fallback, while unavailable rows never enter the total.
 */
const aggregateAdminReportFinancialAmounts = (
  reservations = [],
  requestedMode = "gross"
) => {
  const mode = normalizeAdminReportFinancialMode(requestedMode);
  const rows = Array.isArray(reservations) ? reservations : [];
  const metadata = {
    netFallback: 0,
    unavailable: 0,
    foreignCurrency: 0,
  };
  let totalCents = 0;
  let includedCount = 0;

  for (const reservation of rows) {
    const selected = resolveAdminReportFinancialAmount(reservation, mode);
    if (!selected.available) {
      metadata.unavailable += 1;
      continue;
    }
    if (selected.netFallback) metadata.netFallback += 1;
    if (selected.currency !== "SAR") {
      metadata.foreignCurrency += 1;
      continue;
    }

    const nextTotalCents = totalCents + selected.amountCents;
    if (!Number.isSafeInteger(nextTotalCents)) {
      metadata.unavailable += 1;
      continue;
    }
    totalCents = nextTotalCents;
    includedCount += 1;
  }

  return {
    mode,
    currency: "SAR",
    totalAmount: totalCents / 100,
    totalCents,
    includedCount,
    metadata,
  };
};

module.exports = {
  ADMIN_REPORT_FINANCIAL_AMOUNT_PROJECTION,
  aggregateAdminReportFinancialAmounts,
  normalizeAdminReportFinancialMode,
  resolveAdminReportFinancialAmount,
};
