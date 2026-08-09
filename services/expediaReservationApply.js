/** @format */

const crypto = require("crypto");
const mongoose = require("mongoose");
const { isDeepStrictEqual } = require("node:util");
const Reservations = require("../models/reservations");
const OtaReservationSyncJob = require("../models/ota_reservation_sync_job");
const {
	reconcileOtaReservation,
	findReservationByOtaConfirmation,
	detectConfirmationMatchFields,
	normalizeConfirmation,
	normalizeStatusToApply,
	hasCaptureOrSettlementActivity,
} = require("./otaReservationMapper");
const {
	getExpediaCandidateLookupValues,
} = require("./expediaReservationIdentity");
const {
	buildAuthenticatedProviderCommercialEvidence,
	validateOtaCommercialEvidence,
} = require("./otaCommercialEvidence");
const {
	addReservationVersionBump,
	buildReservationSnapshotFilter,
} = require("./otaReviewConcurrency");
const {
	hasDirectHotelRunnerProjection,
} = require("./hotelrunnerOtaEmailBoundary");
const {
	hasHousingOrTerminalProtection,
} = require("./hotelrunnerReservationAdapter");

const activeApplyJobs = new Set();
const EXPEDIA_PROVIDER = "expedia";
const EXPEDIA_EXISTING_RESERVATION_PROJECTION =
	"_id __v updatedAt hotelId belongsTo confirmation_number reservation_id otaIdentityKey otaCrossTransportIdentityKey customer_details supplierData reservation_status state checkin_date checkout_date total_rooms total_amount sub_total currency commission commission_ota pickedRoomsType pickedRoomsPricing adminPricing adminPricingVisibility ota_financial_summary otaPlatformReview payment_details paid_amount paid_amount_breakdown financial_cycle financeStatus payment moneyTransferredToHotel commissionPaid moneyTransferredAt commissionPaidAt commissionStatus commissionData vcc_payment braintree_payment bofa_payment paypal_details roomId bedNumber housedBy orderTakeId adminChangeLog financeRejectionComment totalReviewStatus";
const WRITTEN_STATUSES = new Set([
	"created",
	"updated",
	"cancelled",
	"status_updated",
]);

const round2 = (value) => {
	const parsed = Number(value || 0);
	return Number.isFinite(parsed) ? Number(parsed.toFixed(2)) : 0;
};

const normalizeId = (value) => String(value || "").trim();

const compact = (value) => String(value || "").replace(/\s+/g, " ").trim();

const normalizePaymentCollectionModel = (value = "") => {
	const model = compact(value).toLowerCase();
	if (["expedia_collect", "expedia collect", "ota_collect", "ota collect"].includes(model)) {
		return "ota_collect";
	}
	if (["hotel_collect", "hotel collect"].includes(model)) return "hotel_collect";
	if (["virtual_card", "virtual card", "vcc"].includes(model)) return "virtual_card";
	return model || "unknown";
};

const candidateLookupValues = (candidate = {}) =>
	getExpediaCandidateLookupValues(candidate);

const findExistingForCandidate = async (
	candidate = {},
	{
		findReservation = findReservationByOtaConfirmation,
	} = {}
) => {
	const lookups = candidateLookupValues(candidate);
	for (const lookupValue of lookups) {
		// eslint-disable-next-line no-await-in-loop
		const existing = await findReservation(
			lookupValue,
			EXPEDIA_PROVIDER,
			EXPEDIA_EXISTING_RESERVATION_PROJECTION
		);
		if (existing) {
			return { existing, matchedLookupValue: lookupValue };
		}
	}
	return { existing: null, matchedLookupValue: "" };
};

const detectExpediaConfirmationMatchFields = (reservation, confirmationNumber) =>
	detectConfirmationMatchFields(
		reservation,
		confirmationNumber,
		EXPEDIA_PROVIDER
	);

const money = (...values) => {
	for (const value of values) {
		const parsed = Number(value || 0);
		if (Number.isFinite(parsed) && parsed > 0) return round2(parsed);
	}
	return 0;
};

const requiresCapturedOtaPayout = (candidate = {}) => {
	const collectionModel = normalizePaymentCollectionModel(
		candidate.paymentCollectionModel
	);
	return collectionModel === "ota_collect";
};

const requiredNewCandidateFields = (candidate = {}, amountSar = 0) => {
	const missing = [];
	if (!candidateLookupValues(candidate).length) missing.push("confirmation number");
	if (!compact(candidate.guestName)) missing.push("guest name");
	if (!normalizeId(candidate.hotelId)) missing.push("hotel id");
	if (!compact(candidate.hotelName || candidate.expediaPropertyName)) {
		missing.push("hotel name");
	}
	if (!compact(candidate.roomName)) missing.push("room name");
	if (!compact(candidate.checkinDate)) missing.push("check-in date");
	if (!compact(candidate.checkoutDate)) missing.push("check-out date");
	if (!amountSar) missing.push("SAR guest total");
	return missing;
};

const expediaPortalCommercialSnapshot = ({
	candidate = {},
	job = {},
	sourceCurrency = "",
	sourceGross = null,
	sourcePayout = null,
} = {}) => ({
	provider: EXPEDIA_PROVIDER,
	sourceType: "authenticated_provider_portal",
	jobId: normalizeId(job._id),
	jobNumber: normalizeId(job.jobNumber),
	jobCreatedAt: job.createdAt ? new Date(job.createdAt).toISOString() : null,
	confirmationNumber: normalizeConfirmation(
		candidate.confirmationNumber || candidate.reservationId
	),
	expediaReservationId: normalizeConfirmation(candidate.reservationId),
	sourceCurrency,
	guestGross: sourceGross,
	hotelPayout: sourcePayout,
	bookingBasis: "reservation_total",
	paymentCollectionModel: normalizePaymentCollectionModel(
		candidate.paymentCollectionModel
	),
});

const buildExpediaPortalCommercialEvidence = ({
	candidate = {},
	job = {},
	sourceCurrency = "",
	sourceAmount = null,
} = {}) => {
	const paymentSummary = candidate.paymentSummary || {};
	const payoutWasCaptured =
		Object.prototype.hasOwnProperty.call(
			paymentSummary,
			"sourceTotalPayoutAmount"
		) &&
		paymentSummary.sourceTotalPayoutAmount !== null &&
		paymentSummary.sourceTotalPayoutAmount !== "" &&
		Number.isFinite(Number(paymentSummary.sourceTotalPayoutAmount)) &&
		Number(paymentSummary.sourceTotalPayoutAmount) >= 0;
	const sourcePayout = payoutWasCaptured
		? round2(paymentSummary.sourceTotalPayoutAmount)
		: null;
	const sourceGross =
		Number.isFinite(Number(sourceAmount)) && Number(sourceAmount) > 0
			? round2(sourceAmount)
			: null;
	if (!sourceGross && sourcePayout === null) {
		return { evidence: null, sourceHash: "", sourceId: "" };
	}
	let snapshot;
	try {
		snapshot = expediaPortalCommercialSnapshot({
			candidate,
			job,
			sourceCurrency,
			sourceGross,
			sourcePayout,
		});
	} catch (_error) {
		return { evidence: null, sourceHash: "", sourceId: "" };
	}
	if (!snapshot.jobCreatedAt || !snapshot.jobId) {
		return { evidence: null, sourceHash: "", sourceId: "" };
	}
	const sourceHash = crypto
		.createHash("sha256")
		.update(JSON.stringify(snapshot))
		.digest("hex");
	const sourceId = `expedia-sync-${sourceHash.slice(0, 24)}`;
	try {
		const evidence = buildAuthenticatedProviderCommercialEvidence({
			provider: EXPEDIA_PROVIDER,
			authenticatedProvider: EXPEDIA_PROVIDER,
			sourceAuthenticated: true,
			sourceTrusted: true,
			sourceType: "authenticated_provider_portal",
			sourceCurrency,
			propertyCurrency: "SAR",
			bookingBasis: "reservation_total",
			sourceHash,
			sourceTimestamp: snapshot.jobCreatedAt,
			sourceId,
			...(sourceGross !== null
				? { guestGross: { verified: true, amount: sourceGross } }
				: {}),
			...(sourcePayout !== null
				? { hotelPayout: { verified: true, amount: sourcePayout } }
				: {}),
			...(candidate.currencyConversionEvidence
				? { currencyConversion: candidate.currencyConversionEvidence }
				: {}),
		});
		return { evidence, sourceHash, sourceId };
	} catch (_error) {
		return { evidence: null, sourceHash, sourceId };
	}
};

const candidateToNormalized = ({ candidate = {}, job = {}, intent, eventType, statusToApply }) => {
	const paymentSummary = candidate.paymentSummary || {};
	const sourceCurrency = String(
		candidate.sourceCurrency ||
			paymentSummary.sourceCurrency ||
			candidate.currency ||
			""
	)
		.trim()
		.toUpperCase();
	const sourceAmount = money(
		candidate.sourceAmount,
		paymentSummary.sourceTotalGuestPaymentAmount,
		sourceCurrency === "SAR" ? candidate.amount : null
	);
	const portalCommercial = buildExpediaPortalCommercialEvidence({
		candidate,
		job,
		sourceCurrency,
		sourceAmount: sourceAmount || null,
	});
	const otaCommercialEvidence = portalCommercial.evidence;
	const propertyGross =
		otaCommercialEvidence?.roles?.guestGross?.propertyAmount ?? null;
	const propertyPayout =
		otaCommercialEvidence?.roles?.hotelPayout?.propertyAmount ?? null;
	const propertyConversionVerified = propertyGross !== null;
	const amountSar = propertyGross;
	const sourceExchangeRateToSar = Number(
		candidate.exchangeRateToSar ||
			paymentSummary.exchangeRateToSar ||
			(String(sourceCurrency || "").toUpperCase() === "SAR" ? 1 : 0)
	);
	const confirmationNumber = normalizeConfirmation(
		candidate.confirmationNumber || candidate.reservationId
	);
	const paymentCollectionModel = normalizePaymentCollectionModel(
		candidate.paymentCollectionModel
	);
	const totalGuests = Math.max(
		1,
		Number(
			candidate.totalGuests ||
				Number(candidate.adults || 0) + Number(candidate.children || 0) ||
				1
		)
	);
	const normalizedPaymentSummary = {
		...paymentSummary,
		totalGuestPaymentAmount: propertyGross,
		totalPayoutAmount: propertyPayout,
		currency:
			propertyGross !== null || propertyPayout !== null ? "SAR" : null,
		propertyCurrency: "SAR",
		propertyConversionVerified,
	};

	return {
		provider: "expedia",
		providerLabel: "Expedia",
		bookingSource: "Expedia",
		intent,
		eventType,
		statusToApply,
		reservationId: confirmationNumber,
		confirmationNumber,
		hotelId: candidate.hotelId,
		hotelName: candidate.hotelName || candidate.expediaPropertyName || "",
		hotelNameAliases: [
			candidate.hotelName,
			candidate.expediaPropertyName,
			candidate.expediaPropertyId,
		].filter(Boolean),
		roomName: candidate.roomName || "",
		checkinDate: candidate.checkinDate || "",
		checkoutDate: candidate.checkoutDate || "",
		bookedAt: candidate.bookedAt || job.createdAt || new Date(),
		amount: amountSar,
		currency: "SAR",
		totalAmountSar: amountSar,
		sourceAmount,
		sourceCurrency,
		sourceAmountHint: candidate.sourceAmountHint || candidate.amountHint || "",
		sourceExchangeRateToSar,
		sourceExchangeRateSource:
			candidate.exchangeRateSource || paymentSummary.exchangeRateSource || "",
		exchangeRateToSar: Number(
			candidate.exchangeRateToSar ||
				paymentSummary.exchangeRateToSar ||
				(sourceCurrency === "SAR" ? 1 : 0)
		),
		exchangeRateSource:
			candidate.exchangeRateSource || paymentSummary.exchangeRateSource || "",
		amountConvertedAt:
			candidate.amountConvertedAt || paymentSummary.amountConvertedAt || "",
		totalPayoutSar: propertyPayout,
		propertyCurrency: "SAR",
		propertyConversionVerified,
		trustedTransportProvider: "expedia",
		sourceSenderTrusted: true,
		sourceSenderAuthenticated: true,
		commercialSourceType: "authenticated_provider_portal",
		...(otaCommercialEvidence ? { otaCommercialEvidence } : {}),
		adults: Math.max(0, Number(candidate.adults || 0)),
		children: Math.max(0, Number(candidate.children || 0)),
		totalGuests,
		roomCount: Math.max(1, Number(candidate.roomCount || 1)),
		guestName: candidate.guestName || "",
		guestEmail: candidate.guestEmail || "no-email@jannatbooking.com",
		guestPhone: candidate.guestPhone || "0000",
		nationality: candidate.nationality || "",
		comment: candidate.comment || candidate.guestNotes || "",
		guestNotes: candidate.guestNotes || candidate.comment || "",
		paidOnline: paymentCollectionModel === "ota_collect",
		paymentCollectionModel,
		paymentInstructions: [
			candidate.paymentCollectionModel || "",
			sourceAmount && sourceCurrency ? `source ${sourceCurrency} ${sourceAmount}` : "",
			paymentSummary.sourceTotalPayoutAmount
				? `payout ${sourceCurrency} ${paymentSummary.sourceTotalPayoutAmount}`
				: "",
		]
			.filter(Boolean)
			.join("; "),
		paymentSummary: normalizedPaymentSummary,
		inboundEmailId: `ota-sync:${job.jobNumber || job._id || ""}`,
		sourcePresence: {
			reservationId: true,
			confirmationNumber: true,
			bookingSource: true,
			hotelName: true,
			roomName: Boolean(candidate.roomName),
			checkinDate: Boolean(candidate.checkinDate),
			checkoutDate: Boolean(candidate.checkoutDate),
			bookedAt: Boolean(candidate.bookedAt),
			amount: sourceAmount > 0,
			adults: Number(candidate.adults || 0) > 0,
			children: true,
			totalGuests: totalGuests > 0,
			roomCount: true,
			guestName: Boolean(candidate.guestName),
			guestEmail: Boolean(candidate.guestEmail),
			guestPhone: Boolean(candidate.guestPhone),
			nationality: Boolean(candidate.nationality),
			comment: Boolean(candidate.comment || candidate.guestNotes),
			guestNotes: Boolean(candidate.guestNotes || candidate.comment),
			paymentCollectionModel: paymentCollectionModel !== "unknown",
			paymentInstructions: true,
		},
		source: {
			from: "expedia-sync",
			subject: `Expedia reservation sync ${confirmationNumber}`,
			messageId:
				portalCommercial.sourceId ||
				`ota-sync:${job.jobNumber || job._id || ""}:${confirmationNumber}`,
			textHash: portalCommercial.sourceHash,
			safeSnippet: candidate.sourceSnippet || "",
			receivedAt:
				job.createdAt ||
				candidate.collectedAt ||
				null,
		},
		warnings: [],
		errors: [],
	};
};

const normalizedKey = (value = "") =>
	compact(value)
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9]+/g, " ")
		.trim();

const dateKey = (value) => {
	if (!value) return "";
	if (typeof value === "string") {
		const match = value.trim().match(/^(\d{4}-\d{2}-\d{2})(?:$|T)/);
		if (match) return match[1];
	}
	const parsed = value instanceof Date ? value : new Date(value);
	return Number.isFinite(parsed.getTime())
		? parsed.toISOString().slice(0, 10)
		: "";
};

const stayDateKeys = (checkin, checkout) => {
	const startKey = dateKey(checkin);
	const endKey = dateKey(checkout);
	if (!startKey || !endKey || startKey >= endKey) return [];
	const cursor = new Date(`${startKey}T00:00:00.000Z`);
	const end = new Date(`${endKey}T00:00:00.000Z`);
	const dates = [];
	while (cursor < end && dates.length <= 730) {
		dates.push(cursor.toISOString().slice(0, 10));
		cursor.setUTCDate(cursor.getUTCDate() + 1);
	}
	return cursor.getTime() === end.getTime() ? dates : [];
};

const propertyRoleAmount = (evidence, roleName) => {
	const role = evidence?.roles?.[roleName];
	if (role?.verified !== true || role.propertyAmount === null) return null;
	const numeric = Number(role.propertyAmount);
	return Number.isFinite(numeric) && numeric >= 0 ? round2(numeric) : null;
};

const isAuthenticatedCommercialEvidence = (evidence = {}) =>
	String(evidence.sourceType || "").startsWith("authenticated_");

const roleEvidenceConflicts = (left, right) => {
	if (left?.verified !== true || right?.verified !== true) return false;
	if (!(
		left.sourceCurrency === right.sourceCurrency &&
		left.bookingBasis === right.bookingBasis &&
		Math.abs(Number(left.sourceAmount) - Number(right.sourceAmount)) <= 0.004
	)) {
		return true;
	}
	if (
		left.propertyAmount !== null &&
		left.propertyAmount !== undefined &&
		right.propertyAmount !== null &&
		right.propertyAmount !== undefined
	) {
		return (
			left.propertyCurrency !== right.propertyCurrency ||
			Math.abs(Number(left.propertyAmount) - Number(right.propertyAmount)) >
				0.004
		);
	}
	return false;
};

const existingAuthenticatedEvidenceDecision = (existing = {}, incoming = {}) => {
	const current = existing?.supplierData?.otaCommercialEvidence;
	if (!current || validateOtaCommercialEvidence(current).ok !== true) {
		return { ok: true, current: null };
	}
	if (current.evidenceHash === incoming.evidenceHash) {
		return { ok: false, idempotent: true, reason: "already_attached" };
	}
	if (!isAuthenticatedCommercialEvidence(current)) {
		return { ok: true, current };
	}
	if (current.provider !== incoming.provider) {
		return { ok: false, reason: "authenticated_provider_conflict" };
	}
	for (const roleName of [
		"guestGross",
		"hotelPayout",
		"explicitOtaCommission",
	]) {
		const currentRole = current.roles?.[roleName];
		const incomingRole = incoming.roles?.[roleName];
		if (roleEvidenceConflicts(currentRole, incomingRole)) {
			return { ok: false, reason: `authenticated_${roleName}_conflict` };
		}
		if (currentRole?.verified === true && incomingRole?.verified !== true) {
			return { ok: false, reason: `authenticated_${roleName}_downgrade` };
		}
		if (
			currentRole?.propertyAmount !== null &&
			currentRole?.propertyAmount !== undefined &&
			(incomingRole?.propertyAmount === null ||
				incomingRole?.propertyAmount === undefined)
		) {
			return { ok: false, reason: `authenticated_${roleName}_currency_downgrade` };
		}
	}
	return { ok: true, current };
};

const hasMeaningfulMatchedExistingValue = (value) => {
	if (value === null || value === undefined || value === "") return false;
	if (typeof value === "boolean") return value;
	if (typeof value === "number") return Math.abs(value) > 0.0001;
	if (Array.isArray(value)) return value.length > 0;
	if (typeof value === "object") return Object.keys(value).length > 0;
	return compact(value) !== "";
};

const matchedExistingManualOrReleasedProtection = (existing = {}) => {
	if (hasHousingOrTerminalProtection(existing)) return "housing_or_terminal";
	if (hasMeaningfulMatchedExistingValue(existing.orderTakeId)) return "manual_order";
	if (
		(Array.isArray(existing.adminChangeLog) && existing.adminChangeLog.length) ||
		hasMeaningfulMatchedExistingValue(existing.financeRejectionComment) ||
		hasMeaningfulMatchedExistingValue(existing.totalReviewStatus)
	) {
		return "employee_or_finance_state";
	}
	const review = existing.otaPlatformReview || {};
	if (
		[
			review.releasedAt,
			review.releasedBy,
			review.closedAt,
			review.closedBy,
			review.lastPricingUpdatedAt,
			review.pricingInvalidatedAt,
		].some(hasMeaningfulMatchedExistingValue) ||
		["released", "closed", "approved", "rejected"].includes(
			compact(review.status).toLowerCase()
		)
	) {
		return "released_or_reviewed_state";
	}
	const adminPricing = existing.adminPricing || {};
	if (
		Object.keys(adminPricing).some((key) =>
			key.toLowerCase().startsWith("clienttotaloverride")
		) ||
		/manual|employee|admin/.test(
			`${compact(adminPricing.mode)} ${compact(adminPricing.source)}`.toLowerCase()
		) ||
		hasMeaningfulMatchedExistingValue(existing.adminPricingVisibility?.appliedBy)
	) {
		return "manual_pricing_state";
	}
	if (
		[existing.supplierData?.otaRoomMatchType]
			.concat(
				(existing.pickedRoomsType || []).flatMap((room) => [
					room?.otaRoomMatchType,
					room?.otaRoomMatchReason,
					room?.otaRoomMatchedByModel,
				])
			)
			.some((value) => /manual|employee|admin/i.test(String(value || "")))
	) {
		return "manual_room_state";
	}
	return "";
};

const allocateCentsByWeight = (totalAmount, weights = []) => {
	if (totalAmount === null || totalAmount === undefined) return null;
	const totalCents = Math.round(Number(totalAmount) * 100);
	if (!Number.isSafeInteger(totalCents) || totalCents < 0 || !weights.length) {
		return null;
	}
	const safeWeights = weights.map((weight) => Number(weight));
	if (safeWeights.some((weight) => !Number.isFinite(weight) || weight <= 0)) {
		return null;
	}
	const weightTotal = safeWeights.reduce((sum, weight) => sum + weight, 0);
	const exact = safeWeights.map((weight) => (totalCents * weight) / weightTotal);
	const allocations = exact.map(Math.floor);
	let remainder = totalCents - allocations.reduce((sum, value) => sum + value, 0);
	const order = exact
		.map((value, index) => ({ index, fraction: value - Math.floor(value) }))
		.sort((left, right) => right.fraction - left.fraction || left.index - right.index);
	for (let index = 0; remainder > 0; index += 1) {
		allocations[order[index % order.length].index] += 1;
		remainder -= 1;
	}
	return allocations.map((value) => value / 100);
};

const buildPortalCommercialPricing = (existing = {}, evidence = {}) => {
	const pickedRoomsType = Array.isArray(existing.pickedRoomsType)
		? existing.pickedRoomsType
		: [];
	const pickedRoomsPricing = Array.isArray(existing.pickedRoomsPricing)
		? existing.pickedRoomsPricing
		: [];
	if (
		!pickedRoomsType.length ||
		!pickedRoomsPricing.length ||
		!isDeepStrictEqual(pickedRoomsType, pickedRoomsPricing) ||
		pickedRoomsPricing.length !== Number(existing.total_rooms || 0)
	) {
		return { ok: false, reason: "room_pricing_projection_conflict" };
	}
	const expectedStayDates = stayDateKeys(
		existing.checkin_date,
		existing.checkout_date
	);
	if (!expectedStayDates.length) {
		return { ok: false, reason: "room_pricing_stay" };
	}

	const slots = [];
	for (const [roomIndex, room] of pickedRoomsPricing.entries()) {
		if (
			Number(room?.count || 1) !== 1 ||
			!Array.isArray(room?.pricingByDay) ||
			!room.pricingByDay.length
		) {
			return { ok: false, reason: "room_pricing_shape" };
		}
		const roomStayDates = room.pricingByDay.map((day) => dateKey(day?.date));
		if (
			roomStayDates.length !== expectedStayDates.length ||
			new Set(roomStayDates).size !== roomStayDates.length ||
			!expectedStayDates.every((stayDate) => roomStayDates.includes(stayDate))
		) {
			return { ok: false, reason: "room_pricing_stay" };
		}
		for (const [dayIndex, day] of room.pricingByDay.entries()) {
			const sourceWeight = Number(
				day?.hotelRunnerSourcePrice ?? day?.clientPrice ?? day?.price
			);
			const rootPrice = Number(day?.rootPrice);
			if (
				!dateKey(day?.date) ||
				!Number.isFinite(sourceWeight) ||
				sourceWeight <= 0 ||
				!Number.isFinite(rootPrice) ||
				rootPrice < 0
			) {
				return { ok: false, reason: "room_pricing_slot" };
			}
			slots.push({ roomIndex, dayIndex, sourceWeight, rootPrice });
		}
	}

	const gross = propertyRoleAmount(evidence, "guestGross");
	const payout = propertyRoleAmount(evidence, "hotelPayout");
	if (gross !== null && gross <= 0) {
		return { ok: false, reason: "guest_gross_invalid" };
	}
	if (gross !== null && payout !== null && payout > gross + 0.02) {
		return { ok: false, reason: "payout_exceeds_gross" };
	}
	const weights = slots.map((slot) => slot.sourceWeight);
	const grossSlots = allocateCentsByWeight(gross, weights);
	const payoutSlots = allocateCentsByWeight(payout, weights);
	if ((gross !== null && !grossSlots) || (payout !== null && !payoutSlots)) {
		return { ok: false, reason: "commercial_allocation" };
	}
	if (
		grossSlots &&
		payoutSlots &&
		payoutSlots.some((value, index) => value > grossSlots[index] + 0.02)
	) {
		return { ok: false, reason: "nightly_payout_exceeds_gross" };
	}

	const rooms = pickedRoomsPricing.map((room) => ({
		...room,
		pricingByDay: room.pricingByDay.map((day) => ({ ...day })),
	}));
	for (const [index, slot] of slots.entries()) {
		const day = rooms[slot.roomIndex].pricingByDay[slot.dayIndex];
		const client = grossSlots ? round2(grossSlots[index]) : null;
		const net = payoutSlots ? round2(payoutSlots[index]) : null;
		const expense = client !== null && net !== null ? round2(client - net) : null;
		const margin = net !== null ? round2(net - slot.rootPrice) : null;
		Object.assign(day, {
			price: client,
			clientPrice: client,
			mainPrice: client,
			totalPriceWithCommission: client,
			netAfterExpenses: net,
			netAfterOtaExpenses: net,
			otaExpenseAmount: expense,
			platformMargin: margin,
			commercialVerification:
				gross !== null && payout !== null
					? "authenticated_provider_portal_verified"
					: gross !== null || payout !== null
						? "authenticated_provider_portal_partial"
						: "authenticated_provider_portal_source_only",
		});
	}

	for (const room of rooms) {
		const clientRows = room.pricingByDay.map((day) => day.clientPrice);
		room.totalPriceWithCommission = clientRows.every((value) => value !== null)
			? round2(clientRows.reduce((sum, value) => sum + Number(value), 0))
			: null;
		room.chosenPrice =
			room.totalPriceWithCommission === null
				? null
				: round2(room.totalPriceWithCommission / room.pricingByDay.length);
		room.hotelShouldGet = round2(
			room.pricingByDay.reduce(
				(sum, day) => sum + Number(day.rootPrice),
				0
			)
		);
	}

	const rootTotal = round2(
		slots.reduce((sum, slot) => sum + slot.rootPrice, 0)
	);
	const canonicalRootTotals = [
		existing.sub_total,
		existing.adminPricing?.rootTotal,
		existing.ota_financial_summary?.hotelVisibleAmount,
	].map(Number);
	if (
		canonicalRootTotals.some(
			(value) =>
				!Number.isFinite(value) || Math.abs(round2(value) - rootTotal) > 0.02
		)
	) {
		return { ok: false, reason: "protected_root_pricing" };
	}

	return {
		ok: true,
		rooms,
		gross,
		payout,
		rootTotal,
		deduction:
			gross !== null && payout !== null ? round2(gross - payout) : null,
		platformMargin:
			payout !== null ? round2(payout - rootTotal) : null,
	};
};

const buildMatchedExistingCommercialUpdate = ({ existing = {}, normalized = {} }) => {
	const evidence = normalized.otaCommercialEvidence;
	const validation = validateOtaCommercialEvidence(evidence);
	if (
		validation.ok !== true ||
		evidence.provider !== EXPEDIA_PROVIDER ||
		evidence.sourceType !== "authenticated_provider_portal"
	) {
		return { ok: false, reason: "commercial_evidence_invalid" };
	}
	if (!hasDirectHotelRunnerProjection(existing)) {
		return { ok: false, reason: "hotelrunner_ownership_required" };
	}
	const propertyCurrency = String(existing.currency || "").trim().toUpperCase();
	if (!propertyCurrency || evidence.propertyCurrency !== propertyCurrency) {
		return { ok: false, reason: "property_currency_mismatch" };
	}
	const protectedState = matchedExistingManualOrReleasedProtection(existing);
	if (protectedState) return { ok: false, reason: protectedState };
	if (
		hasCaptureOrSettlementActivity(existing) ||
		Math.abs(Number(existing.paid_amount || 0)) > 0.0001
	) {
		return { ok: false, reason: "capture_or_settlement" };
	}
	const existingDecision = existingAuthenticatedEvidenceDecision(
		existing,
		evidence
	);
	if (!existingDecision.ok) return existingDecision;
	const evidenceOnly =
		propertyRoleAmount(evidence, "guestGross") === null &&
		propertyRoleAmount(evidence, "hotelPayout") === null;
	if (evidenceOnly) {
		return {
			ok: true,
			commercialMaterialized: false,
			set: {
				"supplierData.otaCommercialEvidence": evidence,
				"supplierData.otaCommercialEvidenceStaleReason": "",
				"supplierData.otaPaymentSummary": normalized.paymentSummary || {},
				"supplierData.otaSourceCurrency": evidence.sourceCurrency,
				"supplierData.otaSourceAmount":
					evidence.roles.guestGross?.sourceAmount ?? null,
				"supplierData.otaSourceExchangeRateToSar": null,
				"supplierData.otaSourceExchangeRateSource": "",
			},
		};
	}
	if (Math.abs(Number(existing.commission || 0)) > 0.0001) {
		return { ok: false, reason: "pms_commission_protected" };
	}
	if (Math.abs(Number(existing.commission_ota || 0)) > 0.0001) {
		return { ok: false, reason: "ota_commission_protected" };
	}
	if (
		existing.adminPricing?.commercialVerified === true &&
		!isAuthenticatedCommercialEvidence(
			existing?.supplierData?.otaCommercialEvidence || {}
		)
	) {
		return { ok: false, reason: "existing_commercial_state_protected" };
	}

	const pricing = buildPortalCommercialPricing(existing, evidence);
	if (!pricing.ok) return pricing;
	const explicitCommission = propertyRoleAmount(
		evidence,
		"explicitOtaCommission"
	);
	const commercialVerified =
		pricing.gross !== null &&
		pricing.payout !== null &&
		pricing.deduction !== null;
	const sourceGross = evidence.roles.guestGross?.verified
		? evidence.roles.guestGross.sourceAmount
		: null;
	const conversionRate =
		evidence.currencyConversion?.rate ??
		(evidence.sourceCurrency === evidence.propertyCurrency ? 1 : null);
	const conversionSource = evidence.currencyConversion
		? evidence.provenance?.conversion?.sourceType || ""
		: evidence.sourceCurrency === evidence.propertyCurrency
			? "identity"
			: "";
	const paymentSummary = normalized.paymentSummary || {};

	return {
		ok: true,
		commercialMaterialized:
			pricing.gross !== null || pricing.payout !== null,
		set: {
			total_amount: pricing.gross,
			commission_ota: explicitCommission,
			pickedRoomsType: pricing.rooms,
			pickedRoomsPricing: pricing.rooms,
			"adminPricing.clientTotal": pricing.gross,
			"adminPricing.netAfterExpensesTotal": pricing.payout,
			"adminPricing.otaExpenseTotal": pricing.deduction,
			"adminPricing.platformMarginTotal": pricing.platformMargin,
			"adminPricing.commissionAmount": 0,
			"adminPricing.defaultDeductionRate": null,
			"adminPricing.defaultDeductionApplied": false,
			"adminPricing.commercialResolution": evidence.verificationState,
			"adminPricing.commercialVerified": commercialVerified,
			"adminPricing.payoutFallbackReason": "",
			"adminPricing.sourceCurrency": evidence.sourceCurrency,
			"adminPricing.propertyCurrency": evidence.propertyCurrency,
			"adminPricing.sourceAmount": sourceGross,
			"adminPricing.sourceExchangeRateToSar": conversionRate,
			"adminPricing.sourceExchangeRateSource": conversionSource,
			"ota_financial_summary.show": pricing.gross !== null || pricing.payout !== null,
			"ota_financial_summary.clientTotal": pricing.gross,
			"ota_financial_summary.netAfterExpenses": pricing.payout,
			"ota_financial_summary.netAfterOtaExpenses": pricing.payout,
			"ota_financial_summary.otaExpenseTotal": pricing.deduction,
			"ota_financial_summary.platformProfit": pricing.platformMargin,
			"ota_financial_summary.commissionAmount": 0,
			"ota_financial_summary.otaCommissionAmount": explicitCommission,
			"ota_financial_summary.otaDeductionBreakdown": [],
			"ota_financial_summary.unclassifiedOtaDeduction": pricing.deduction,
			"ota_financial_summary.commercialVerified": commercialVerified,
			"ota_financial_summary.sourceCurrency": evidence.sourceCurrency,
			"ota_financial_summary.sourceAmount": sourceGross,
			"ota_financial_summary.sourceExchangeRateToSar": conversionRate,
			"ota_financial_summary.sourceExchangeRateSource": conversionSource,
			"ota_financial_summary.paymentSummary": paymentSummary,
			"ota_financial_summary.payoutFallbackReason": "",
			"supplierData.otaCommercialEvidence": evidence,
			"supplierData.otaCommercialEvidenceStaleReason": "",
			"supplierData.otaPaymentSummary": paymentSummary,
			"supplierData.otaTotalPayoutSar": pricing.payout,
			"supplierData.otaExpenseTotalSar": pricing.deduction,
			"supplierData.otaCommissionSar": explicitCommission,
			"supplierData.otaCommissionSource": "",
			"supplierData.otaCommissionSourceBacked": explicitCommission !== null,
			"supplierData.otaPlatformMarginSar": pricing.platformMargin,
			"supplierData.otaPayoutFallbackReason": "",
			"supplierData.otaSourceCurrency": evidence.sourceCurrency,
			"supplierData.otaSourceAmount": sourceGross,
			"supplierData.otaSourceExchangeRateToSar": conversionRate,
			"supplierData.otaSourceExchangeRateSource": conversionSource,
		},
	};
};

const roomLabelCompatible = (candidate = {}, existing = {}) => {
	const incoming = normalizedKey(candidate.roomName || "");
	if (!incoming) return false;
	const labels = [
		existing?.supplierData?.otaRoomName,
		...(existing.pickedRoomsType || []).flatMap((room) => [
			room?.sourceRoomName,
			room?.otaMatchedRoomName,
			room?.displayName,
			room?.room_type,
		]),
	].filter(Boolean);
	return labels.some((label) => {
		if (normalizedKey(label) === incoming) return true;
		const [base, ...qualifiers] = String(label)
			.split(/\s+[-\u2013\u2014]\s+/)
			.map(normalizedKey)
			.filter(Boolean);
		return (
			base === incoming &&
			qualifiers.length > 0 &&
			qualifiers.every((qualifier) =>
				/^(?:non refundable|refundable|room only|nr|\d+ occupancy|breakfast included|with breakfast|breakfast|pay at hotel|pay at property|pay now)$/.test(
					qualifier
				)
			)
		);
	});
};

const exactExpediaProviderIdentityMatches = (candidate = {}, existing = {}) => {
	const incoming = normalizeConfirmation(candidate.confirmationNumber);
	if (!incoming) return false;
	if (
		normalizedKey(existing?.supplierData?.otaProvider) !== EXPEDIA_PROVIDER
	) {
		return false;
	}
	const identityKey = String(existing.otaIdentityKey || "").trim().toLowerCase();
	const identityAlias = identityKey.startsWith(`${EXPEDIA_PROVIDER}:`)
		? normalizeConfirmation(identityKey.slice(EXPEDIA_PROVIDER.length + 1))
		: "";
	const aliases = [
		existing?.supplierData?.otaConfirmationNumber,
		existing?.supplierData?.platformConfirmationNumber,
		existing?.supplierData?.suppliedBookingNo,
		existing?.supplierData?.hotelRunner?.providerNumber,
		identityAlias,
	]
		.map(normalizeConfirmation)
		.filter(Boolean);
	return aliases.length > 0 && aliases.every((alias) => alias === incoming);
};

const matchedExistingCompatibility = ({ candidate = {}, existing = {} }) => {
	if (!hasDirectHotelRunnerProjection(existing)) {
		return { ok: false, reason: "hotelrunner_ownership_required" };
	}
	if (!exactExpediaProviderIdentityMatches(candidate, existing)) {
		return { ok: false, reason: "provider_identity_mismatch" };
	}
	if (
		!normalizeId(candidate.hotelId) ||
		normalizeId(candidate.hotelId) !== normalizeId(existing.hotelId)
	) {
		return { ok: false, reason: "hotel_identity_mismatch" };
	}
	if (
		!dateKey(candidate.checkinDate) ||
		!dateKey(candidate.checkoutDate) ||
		dateKey(candidate.checkinDate) !== dateKey(existing.checkin_date) ||
		dateKey(candidate.checkoutDate) !== dateKey(existing.checkout_date)
	) {
		return { ok: false, reason: "stay_mismatch" };
	}
	const incomingRoomCount = Number(candidate.roomCount || 1);
	if (
		!Number.isInteger(incomingRoomCount) ||
		incomingRoomCount <= 0 ||
		incomingRoomCount !== Number(existing.total_rooms || 0)
	) {
		return { ok: false, reason: "room_count_mismatch" };
	}
	if (!roomLabelCompatible(candidate, existing)) {
		return { ok: false, reason: "room_identity_mismatch" };
	}
	return { ok: true };
};

const matchedExistingCommercialSnapshotFilter = (existing = {}) => {
	const filter = {
		...buildReservationSnapshotFilter(existing, { includeHotel: true }),
		belongsTo: existing.belongsTo,
		state: existing.state,
		reservation_status: existing.reservation_status,
		checkin_date: existing.checkin_date,
		checkout_date: existing.checkout_date,
		total_rooms: existing.total_rooms,
		total_amount: existing.total_amount,
		sub_total: existing.sub_total,
		currency: existing.currency,
		commission: existing.commission,
		payment_details: existing.payment_details,
		paid_amount: existing.paid_amount,
		paid_amount_breakdown: existing.paid_amount_breakdown,
		financial_cycle: existing.financial_cycle,
		financeStatus: existing.financeStatus,
		payment: existing.payment,
		moneyTransferredToHotel: existing.moneyTransferredToHotel,
		commissionPaid: existing.commissionPaid,
		moneyTransferredAt: existing.moneyTransferredAt,
		commissionPaidAt: existing.commissionPaidAt,
		commissionStatus: existing.commissionStatus,
		commissionData: existing.commissionData,
		vcc_payment: existing.vcc_payment,
		braintree_payment: existing.braintree_payment,
		bofa_payment: existing.bofa_payment,
		paypal_details: existing.paypal_details,
		pickedRoomsType: existing.pickedRoomsType,
		pickedRoomsPricing: existing.pickedRoomsPricing,
		"adminPricing.mode": existing.adminPricing?.mode,
		"adminPricing.source": existing.adminPricing?.source,
		"adminPricing.clientTotal": existing.adminPricing?.clientTotal,
		"adminPricing.rootTotal": existing.adminPricing?.rootTotal,
		"adminPricing.netAfterExpensesTotal":
			existing.adminPricing?.netAfterExpensesTotal,
		"adminPricing.otaExpenseTotal": existing.adminPricing?.otaExpenseTotal,
		"adminPricing.platformMarginTotal":
			existing.adminPricing?.platformMarginTotal,
		"ota_financial_summary.source": existing.ota_financial_summary?.source,
		"ota_financial_summary.clientTotal":
			existing.ota_financial_summary?.clientTotal,
		"ota_financial_summary.hotelVisibleAmount":
			existing.ota_financial_summary?.hotelVisibleAmount,
		"ota_financial_summary.netAfterExpenses":
			existing.ota_financial_summary?.netAfterExpenses,
		"ota_financial_summary.otaExpenseTotal":
			existing.ota_financial_summary?.otaExpenseTotal,
		"supplierData.hotelRunner.transport":
			existing.supplierData?.hotelRunner?.transport,
		"supplierData.hotelRunner.reservationId":
			existing.supplierData?.hotelRunner?.reservationId,
		"supplierData.hotelRunner.providerNumber":
			existing.supplierData?.hotelRunner?.providerNumber,
		"supplierData.otaAutomationPipeline":
			existing.supplierData?.otaAutomationPipeline,
		"supplierData.otaSourceAuthority":
			existing.supplierData?.otaSourceAuthority,
	};
	filter.commission_ota = existing.commission_ota ?? null;
	return filter;
};

const persistMatchedExistingCommercialUpdate = async ({
	existing,
	plan,
	normalized,
	job,
	actor,
}) =>
	Reservations.updateOne(
		matchedExistingCommercialSnapshotFilter(existing),
		addReservationVersionBump({
			$set: plan.set,
			$push: {
				reservationAuditLog: {
					at: new Date(),
					source: "expedia-provider-portal",
					action: plan.commercialMaterialized
						? "commercial-enriched-existing-hotelrunner-reservation"
						: "commercial-evidence-attached-no-financial-mutation",
					by: actor?._id || actor?.id || "",
					jobId: normalizeId(job?._id),
					expediaConfirmationNumber: normalized.confirmationNumber,
					evidenceHash: normalized.otaCommercialEvidence.evidenceHash,
					changedPaths: Object.keys(plan.set).slice(0, 100),
				},
			},
		})
	);

const loadExistingForCommercialRetry = async (reservationId) => {
	let query = Reservations.findById(reservationId).select(
		EXPEDIA_EXISTING_RESERVATION_PROJECTION
	);
	if (query && typeof query.lean === "function") query = query.lean();
	if (query && typeof query.exec === "function") return query.exec();
	return query;
};

const updateMatchedCount = (result) =>
	Number(result?.matchedCount ?? result?.n ?? result ?? 0);

const resultEntry = ({ candidate = {}, action, status, result = {}, extra = {} }) => ({
	action,
	status,
	confirmationNumber:
		candidate.confirmationNumber || candidate.reservationId || result.confirmationNumber || "",
	expediaReservationId: candidate.reservationId || "",
	hotelConfirmationNumber: candidate.hotelConfirmationNumber || "",
	hotelId: candidate.hotelId || result.hotelId || "",
	hotelName: candidate.hotelName || candidate.expediaPropertyName || "",
	reservationId: result.reservationId || "",
	pmsConfirmationNumber: result.pmsConfirmationNumber || "",
	warnings: result.warnings || [],
	errors: result.errors || [],
	matchedReservationBy: result.matchedReservationBy || [],
	...extra,
});

const applyMatchedExistingCandidate = async (
	{ candidate = {}, job = {}, actor } = {},
	{
		findExisting = findExistingForCandidate,
		persistCommercialUpdate = persistMatchedExistingCommercialUpdate,
		loadLatest = loadExistingForCommercialRetry,
	} = {}
) => {
	const { existing, matchedLookupValue } = await findExisting(candidate);
	if (!existing) {
		return resultEntry({
			candidate,
			action: "needs_review_matched_existing_missing",
			status: "needs_review",
			extra: {
				expediaReservationId: normalizeConfirmation(
					candidate.confirmationNumber
				),
				skipReason:
					"The previewed HotelRunner reservation no longer matches; no reservation was created.",
				errors: ["Matched reservation was not found during the apply recheck."],
			},
		});
	}

	const matchedReservationBy = detectExpediaConfirmationMatchFields(
		existing,
		matchedLookupValue || candidate.confirmationNumber
	);
	const existingResult = {
		reservationId: existing._id,
		hotelId: existing.hotelId,
		pmsConfirmationNumber: existing.confirmation_number,
		matchedReservationBy,
	};
	const incomingConfirmation = normalizeConfirmation(candidate.confirmationNumber);
	const compatibility = matchedExistingCompatibility({ candidate, existing });
	if (!compatibility.ok) {
		return resultEntry({
			candidate,
			action: "needs_review_matched_existing_identity",
			status: "needs_review",
			result: existingResult,
			extra: {
				expediaReservationId: incomingConfirmation,
				matchedLookupValue,
				skipReason: compatibility.reason,
				errors: [
					`Matched HotelRunner commercial enrichment failed its ${compatibility.reason} safety check.`,
				],
			},
		});
	}

	const normalized = candidateToNormalized({
		candidate: {
			...candidate,
			// matchedExisting preview rows use reservationId for the local Mongo id.
			// Re-anchor the provider payload to Expedia's exact confirmation.
			reservationId: incomingConfirmation,
			hotelId: existing.hotelId,
		},
		job,
		intent: "commercial_enrichment",
		eventType: "commercial_enrichment",
		statusToApply: "",
	});
	const plan = buildMatchedExistingCommercialUpdate({ existing, normalized });
	if (!plan.ok) {
		if (plan.idempotent) {
			return resultEntry({
				candidate,
				action: "commercial_evidence_already_attached",
				status: "duplicate_reservation",
				result: existingResult,
				extra: {
					expediaReservationId: incomingConfirmation,
					matchedLookupValue,
					skipReason: plan.reason,
				},
			});
		}
		return resultEntry({
			candidate,
			action: "needs_review_matched_existing_commercial",
			status: "needs_review",
			result: existingResult,
			extra: {
				expediaReservationId: incomingConfirmation,
				matchedLookupValue,
				skipReason: plan.reason,
				errors: [
					`Authenticated Expedia commercial evidence could not be applied safely: ${plan.reason}.`,
				],
			},
		});
	}

	const updateResult = await persistCommercialUpdate({
		existing,
		plan,
		normalized,
		job,
		actor,
	});
	if (!updateMatchedCount(updateResult)) {
		const latest = await loadLatest(existing._id);
		const latestEvidence = latest?.supplierData?.otaCommercialEvidence;
		if (
			validateOtaCommercialEvidence(latestEvidence).ok === true &&
			latestEvidence.evidenceHash === normalized.otaCommercialEvidence.evidenceHash
		) {
			return resultEntry({
				candidate,
				action: "commercial_evidence_already_attached",
				status: "duplicate_reservation",
				result: existingResult,
				extra: {
					expediaReservationId: incomingConfirmation,
					matchedLookupValue,
					skipReason: "already_attached_after_concurrent_apply",
				},
			});
		}
		return resultEntry({
			candidate,
			action: "needs_review_matched_existing_concurrent_change",
			status: "needs_review",
			result: existingResult,
			extra: {
				expediaReservationId: incomingConfirmation,
				matchedLookupValue,
				skipReason: "reservation_snapshot_changed",
				errors: [
					"The reservation changed concurrently; no retrying commercial overwrite was attempted.",
				],
			},
		});
	}

	return resultEntry({
		candidate,
		action: plan.commercialMaterialized
			? "commercial_enriched_existing"
			: "commercial_evidence_attached_existing",
		status: "updated",
		result: existingResult,
		extra: {
			expediaReservationId: incomingConfirmation,
			matchedLookupValue,
			commercialMaterialized: plan.commercialMaterialized,
			commercialEvidenceHash: normalized.otaCommercialEvidence.evidenceHash,
			updatedFields: Object.keys(plan.set),
		},
	});
};

const applyNewCandidate = async ({ candidate, job }) => {
	const statusToApply = normalizeStatusToApply(
		candidate.statusToApply || candidate.statusRaw || "confirmed"
	);
	if (["cancelled", "no_show"].includes(statusToApply)) {
		return resultEntry({
			candidate,
			action: "skipped_cancelled_new_candidate",
			status: "skipped",
			extra: {
				skipReason: "Cancelled/no-show Expedia reservations are not created when no PMS document exists.",
			},
		});
	}

	const normalized = candidateToNormalized({
		candidate,
		job,
		intent: "new_reservation",
		eventType: "created",
		statusToApply: "confirmed",
	});
	const amountSar = Number(
		normalized.otaCommercialEvidence?.roles?.guestGross?.propertyAmount
	);
	const missing = requiredNewCandidateFields(candidate, amountSar);
	if (missing.length) {
		return resultEntry({
			candidate,
			action: "needs_review_missing_required_fields",
			status: "needs_review",
			extra: {
				errors: [`Missing required field(s): ${missing.join(", ")}.`],
			},
		});
	}
	if (
		requiresCapturedOtaPayout(candidate) &&
		(normalized.otaCommercialEvidence?.roles?.hotelPayout?.propertyAmount ===
			null ||
			normalized.otaCommercialEvidence?.roles?.hotelPayout?.propertyAmount ===
				undefined)
	) {
		return resultEntry({
			candidate,
			action: "needs_review_missing_ota_payout",
			status: "needs_review",
			extra: {
				errors: [
					"Expedia Collect payout was not captured; review payment details before creating with OTA net pricing.",
				],
			},
		});
	}

	const { existing, matchedLookupValue } = await findExistingForCandidate(candidate);
	if (existing) {
		return resultEntry({
			candidate,
			action: "duplicate_recheck_skipped",
			status: "duplicate_reservation",
			result: {
				reservationId: existing._id,
				hotelId: existing.hotelId,
				pmsConfirmationNumber: existing.confirmation_number,
				matchedReservationBy: detectExpediaConfirmationMatchFields(
					existing,
					matchedLookupValue
				),
			},
			extra: {
				skipReason: "A PMS reservation matched during pre-create recheck.",
				matchedLookupValue,
			},
		});
	}

	const result = await reconcileOtaReservation(normalized);
	return resultEntry({
		candidate,
		action: result.status === "created" ? "created_new_reservation" : "not_created",
		status: result.status,
		result,
	});
};

const applyStatusCandidate = async ({ candidate, job }) => {
	const statusToApply = normalizeStatusToApply(
		candidate.statusToApply || candidate.incomingStatus || candidate.statusRaw
	);
	if (!["cancelled", "no_show"].includes(statusToApply)) {
		return resultEntry({
			candidate,
			action: "skipped_non_terminal_status",
			status: "skipped",
			extra: {
				skipReason: "Only cancelled/no-show status changes are auto-applied.",
			},
		});
	}

	const { existing, matchedLookupValue } = await findExistingForCandidate(candidate);
	if (!existing) {
		return resultEntry({
			candidate,
			action: "needs_review_status_no_match",
			status: "needs_review",
			extra: {
				errors: ["Status change did not match an existing PMS reservation."],
			},
		});
	}

	const currentStatus = compact(
		existing.reservation_status || existing.state || ""
	).toLowerCase();
	if (currentStatus === statusToApply) {
		return resultEntry({
			candidate,
			action: "status_already_applied",
			status: "skipped",
			result: {
				reservationId: existing._id,
				hotelId: existing.hotelId,
				pmsConfirmationNumber: existing.confirmation_number,
				matchedReservationBy: detectExpediaConfirmationMatchFields(
					existing,
					matchedLookupValue
				),
			},
			extra: {
				skipReason: "PMS reservation already has the incoming Expedia status.",
				matchedLookupValue,
			},
		});
	}

	const normalized = candidateToNormalized({
		candidate: {
			...candidate,
			hotelId: candidate.hotelId || existing.hotelId,
		},
		job,
		intent: "reservation_status",
		eventType: statusToApply,
		statusToApply,
	});
	const result = await reconcileOtaReservation(normalized);
	return resultEntry({
		candidate,
		action: ["cancelled", "status_updated"].includes(result.status)
			? "updated_status"
			: "status_not_updated",
		status: result.status,
		result,
		extra: { matchedLookupValue },
	});
};

const summarizeApplyResults = (results = {}) => {
	const created = results.created || [];
	const statusUpdated = results.statusUpdated || [];
	const commercialEnriched = results.commercialEnriched || [];
	const duplicateSkipped = results.duplicateSkipped || [];
	const skipped = results.skipped || [];
	const needsReview = results.needsReview || [];
	const failed = results.failed || [];
	return {
		created: created.length,
		statusUpdated: statusUpdated.length,
		commercialEnriched: commercialEnriched.length,
		duplicateSkipped: duplicateSkipped.length,
		skipped: skipped.length,
		needsReview: needsReview.length,
		failed: failed.length,
		appliedWrites:
			created.length + statusUpdated.length + commercialEnriched.length,
	};
};

const pushApplyEntry = (results, entry) => {
	if (entry.status === "created") {
		results.created.push(entry);
		return;
	}
	if (
		entry.status === "updated" &&
		[
			"commercial_enriched_existing",
			"commercial_evidence_attached_existing",
		].includes(entry.action)
	) {
		results.commercialEnriched.push(entry);
		return;
	}
	if (
		["cancelled", "status_updated", "updated"].includes(entry.status) &&
		entry.action === "updated_status"
	) {
		results.statusUpdated.push(entry);
		return;
	}
	if (entry.status === "duplicate_reservation") {
		results.duplicateSkipped.push(entry);
		return;
	}
	if (entry.status === "needs_review" || entry.status === "needs_mapping") {
		results.needsReview.push(entry);
		return;
	}
	if (WRITTEN_STATUSES.has(entry.status)) {
		results.statusUpdated.push(entry);
		return;
	}
	results.skipped.push(entry);
};

const applyExpediaReservationSyncJob = async ({ jobId, actor }) => {
	const key = normalizeId(jobId);
	if (!mongoose.Types.ObjectId.isValid(key)) {
		return { ok: false, statusCode: 400, error: "Invalid OTA sync job id." };
	}
	if (activeApplyJobs.has(key)) {
		const job = await OtaReservationSyncJob.findById(key).lean().exec();
		return {
			ok: false,
			statusCode: 409,
			error: "This OTA sync job is already applying.",
			job,
		};
	}

	activeApplyJobs.add(key);
	const startedAt = new Date();
	try {
		const job = await OtaReservationSyncJob.findOneAndUpdate(
			{ _id: key, status: { $in: ["preview_ready", "apply_needs_review"] } },
			{
				$set: {
					status: "applying",
					applyResults: {
						startedAt,
						status: "applying",
						readOnlyPreviewRequired: true,
					},
				},
				$push: {
					auditLog: {
						at: startedAt,
						action: "apply_started",
						by: actor?._id || actor?.id || "",
						writePolicy:
							"create new confirmed reservations; apply cancelled/no-show status changes; attach authenticated Expedia commercial evidence to the same HotelRunner-owned reservation",
					},
				},
			},
			{ new: true }
		)
			.lean()
			.exec();

		if (!job) {
			const existingJob = await OtaReservationSyncJob.findById(key).lean().exec();
			return {
				ok: false,
				statusCode: 409,
				error:
					existingJob?.status === "applied"
						? "This OTA sync job was already applied."
						: "Only preview_ready or apply_needs_review OTA sync jobs can be applied.",
				job: existingJob,
			};
		}

		const buckets = job.previewBuckets || {};
		const results = {
			startedAt,
			created: [],
			statusUpdated: [],
			commercialEnriched: [],
			duplicateSkipped: [],
			skipped: [],
			needsReview: [],
			failed: [],
		};

		const newCandidates = Array.isArray(buckets.newReservations)
			? buckets.newReservations
			: [];
		for (const candidate of newCandidates) {
			try {
				// eslint-disable-next-line no-await-in-loop
				const entry = await applyNewCandidate({ candidate, job });
				pushApplyEntry(results, entry);
			} catch (error) {
				results.failed.push(
					resultEntry({
						candidate,
						action: "create_failed",
						status: "failed",
						extra: { errors: [error.message || String(error)] },
					})
				);
			}
		}

		const matchedExistingCandidates = Array.isArray(buckets.matchedExisting)
			? buckets.matchedExisting
			: [];
		for (const candidate of matchedExistingCandidates) {
			try {
				// eslint-disable-next-line no-await-in-loop
				const entry = await applyMatchedExistingCandidate({
					candidate,
					job,
					actor,
				});
				pushApplyEntry(results, entry);
			} catch (error) {
				results.failed.push(
					resultEntry({
						candidate,
						action: "commercial_enrichment_failed",
						status: "failed",
						extra: {
							expediaReservationId: normalizeConfirmation(
								candidate.confirmationNumber
							),
							errors: [error.message || String(error)],
						},
					})
				);
			}
		}

		const statusCandidates = Array.isArray(buckets.statusChanged)
			? buckets.statusChanged
			: [];
		for (const candidate of statusCandidates) {
			try {
				// eslint-disable-next-line no-await-in-loop
				const entry = await applyStatusCandidate({ candidate, job });
				pushApplyEntry(results, entry);
			} catch (error) {
				results.failed.push(
					resultEntry({
						candidate,
						action: "status_update_failed",
						status: "failed",
						extra: { errors: [error.message || String(error)] },
					})
				);
			}
		}

		const summary = summarizeApplyResults(results);
		const finalStatus =
			summary.failed || summary.needsReview ? "apply_needs_review" : "applied";
		results.finishedAt = new Date();
		results.status = finalStatus;
		results.summary = summary;

		const updatedJob = await OtaReservationSyncJob.findByIdAndUpdate(
			key,
			{
				$set: {
					status: finalStatus,
					applyResults: results,
					resultSummary: {
						...(job.resultSummary || {}),
						appliedWrites: summary.appliedWrites,
						applyCreated: summary.created,
						applyStatusUpdated: summary.statusUpdated,
						applyCommercialEnriched: summary.commercialEnriched,
						applyDuplicateSkipped: summary.duplicateSkipped,
						applySkipped: summary.skipped,
						applyNeedsReview: summary.needsReview,
						applyFailed: summary.failed,
					},
					"collectorState.status": finalStatus,
					"collectorState.appliedAt": results.finishedAt,
					"collectorState.appliedWrites": summary.appliedWrites,
				},
				$push: {
					auditLog: {
						at: results.finishedAt,
						action: "apply_finished",
						by: actor?._id || actor?.id || "",
						status: finalStatus,
						summary,
					},
				},
			},
			{ new: true }
		)
			.lean()
			.exec();

		return { ok: true, statusCode: 200, job: updatedJob, summary };
	} finally {
		activeApplyJobs.delete(key);
	}
};

module.exports = {
	applyExpediaReservationSyncJob,
	normalizePaymentCollectionModel,
	candidateLookupValues,
	__private: {
		findExistingForCandidate,
		detectExpediaConfirmationMatchFields,
		candidateToNormalized,
		allocateCentsByWeight,
		buildPortalCommercialPricing,
		buildMatchedExistingCommercialUpdate,
		matchedExistingCompatibility,
		matchedExistingCommercialSnapshotFilter,
		applyMatchedExistingCandidate,
	},
};
