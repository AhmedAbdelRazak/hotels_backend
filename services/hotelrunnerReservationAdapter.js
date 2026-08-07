/** @format */

const mongoose = require("mongoose");
const Reservations = require("../models/reservations");
const HotelRunnerReservation = require("../models/hotelrunner_reservation");
const HotelRunnerRoomMapping = require("../models/hotelrunner_room_mapping");
const HotelRunnerSyncState = require("../models/hotelrunner_sync_state");
const {
	createReservationWithAvailabilitySnapshot,
	validateReservationInventoryForCreate,
} = require("../controllers/reservations");
const {
	loadHotelRunnerEmailCommercialBridge,
} = require("./hotelrunnerEmailCommercialBridge");
const {
	authoritativeExistingRefreshProtectedStateGuard,
	buildOtaIdentityKey,
	generateUniquePmsConfirmationNumber,
	verifiedHotelRunnerEmailCommercialEvidence,
} = require("./otaReservationMapper");
const {
	addReservationVersionBump,
	buildReservationSnapshotFilter,
} = require("./otaReviewConcurrency");
const {
	OTA_PLATFORM_REVIEW_RESERVATION_STATUS,
	buildOtaReviewSnapshot,
} = require("./otaReservationVisibility");
const {
	centsToAmount,
	dateRange,
	decimalToCents,
	hashObject,
	stableClone,
	stableStringify,
} = require("./hotelrunnerPayload");

const ObjectId = mongoose.Types.ObjectId;
const MAX_CAS_ATTEMPTS = 3;
const DEFAULT_ROOM_LIST_VERIFICATION_MAX_AGE_MS = 72 * 60 * 60 * 1000;
const HOTELRUNNER_PAYOUT_NOT_PROVIDED =
	"hotelrunner_payout_not_provided";
const HOTELRUNNER_COMMERCIAL_EVIDENCE_STALE =
	"hotelrunner_commercial_evidence_stale";
const OTA_PROVIDER_KEYS = new Set([
	"booking",
	"agoda",
	"expedia",
	"hotels",
	"trip",
	"airbnb",
	"hotelrunner",
]);
const NATIVE_HOTELRUNNER_PROVIDER_ALIASES = new Set([
	"hotelrunner",
	"hotelrunnerbookingengine",
]);
const HOTELRUNNER_PROVIDER_ALIASES = new Map([
	["booking", "booking"],
	["bookingcom", "booking"],
	["agoda", "agoda"],
	["agodacom", "agoda"],
	["expedia", "expedia"],
	["expediacom", "expedia"],
	["hotels", "hotels"],
	["hotelscom", "hotels"],
	["trip", "trip"],
	["tripcom", "trip"],
	["ctrip", "trip"],
	["ctripcom", "trip"],
	["airbnb", "airbnb"],
	["airbnbcom", "airbnb"],
]);

const clean = (value = "") => String(value == null ? "" : value).trim();
const comparable = (value = "") =>
	clean(value)
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9]+/g, " ")
		.trim();

const dateKey = (value) => {
	if (!value) return "";
	const parsed = value instanceof Date ? value : new Date(value);
	return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : "";
};

const round2 = (value) => Number((Number(value || 0)).toFixed(2));
const centsToNullableAmount = (value) =>
	Number.isSafeInteger(value) ? Number((value / 100).toFixed(2)) : null;

function hotelRunnerPricingBreakdown(normalized = {}) {
	const rooms = (normalized.rooms || []).map((room) => ({
		roomId: clean(room.roomId),
		invCode: clean(room.invCode),
		rateCode: clean(room.rateCode),
		ratePlanCode: clean(room.ratePlanCode),
		currency: clean(normalized.currency).toUpperCase(),
		priceBeforeTax: centsToNullableAmount(room.priceCents),
		totalAfterTax: centsToNullableAmount(room.totalCents),
		roomBasePrice: centsToNullableAmount(room.roomBasePriceCents),
		roomSubTotal: centsToNullableAmount(room.roomSubTotalCents),
		extrasTotal: centsToNullableAmount(room.extrasTotalCents),
		fixedAdjustmentsTotal: centsToNullableAmount(
			room.fixedAdjustmentsTotalCents
		),
		includedTaxesTotal: centsToNullableAmount(room.includedTaxesTotalCents),
		excludedFeesAndTaxesTotal: centsToNullableAmount(
			room.excludedFeesAndTaxesTotalCents
		),
		cancelationRefundTotal: centsToNullableAmount(
			room.cancelationRefundTotalCents
		),
		cancelationRefundTaxType: clean(room.cancelationRefundTaxType),
		cancelationPenaltyTotal: centsToNullableAmount(
			room.cancelationPenaltyTotalCents
		),
		cancelationPenaltyTaxType: clean(room.cancelationPenaltyTaxType),
		promotionsTotal: centsToNullableAmount(room.promotionsTotalCents),
		nightly: (room.dailyPrices || []).map((day) => ({
			date: clean(day.date),
			finalPrice: centsToNullableAmount(day.priceCents),
			originalPrice: centsToNullableAmount(day.originalPriceCents),
			discount: centsToNullableAmount(day.discountCents),
			rateCode: clean(day.rateCode),
			version: clean(day.version),
		})),
		extras: (room.extras || []).map((extra) => ({
			name: clean(extra.name),
			price: centsToNullableAmount(extra.priceCents),
			basePrice: centsToNullableAmount(extra.basePriceCents),
			code: clean(extra.code),
			promotionsTotal: centsToNullableAmount(extra.promotionsTotalCents),
			isExtra: typeof extra.isExtra === "boolean" ? extra.isExtra : null,
			total: centsToNullableAmount(extra.totalCents),
			quantity: Number.isFinite(extra.quantity) ? extra.quantity : null,
			dates: stableClone(extra.dates),
			repeatType: clean(extra.repeatType),
			includedInPrice:
				typeof extra.includedInPrice === "boolean"
					? extra.includedInPrice
					: null,
		})),
	}));
	const totalCents = normalized.totalCents;
	const roomTotals = (normalized.rooms || []).map((room) => room.totalCents);
	const roomTotalsKnown =
		roomTotals.length > 0 && roomTotals.every(Number.isSafeInteger);
	return {
		schemaVersion: 1,
		source: "hotelrunner_api",
		currency: clean(normalized.currency).toUpperCase(),
		subTotal: centsToNullableAmount(normalized.subTotalCents),
		extrasTotal: centsToNullableAmount(normalized.extrasTotalCents),
		adjustmentsTotal: centsToNullableAmount(normalized.adjustmentsTotalCents),
		itemTotal: centsToNullableAmount(normalized.itemTotalCents),
		taxTotal: centsToNullableAmount(normalized.taxTotalCents),
		grandTotal: centsToNullableAmount(totalCents),
		paidAmount: centsToNullableAmount(normalized.paidAmountCents),
		depositTaxInclusive:
			typeof normalized.depositTaxInclusive === "boolean"
				? normalized.depositTaxInclusive
				: null,
		extraAdjustmentsDetails: stableClone(
			normalized.extraAdjustmentsDetails || []
		),
		adjustmentDetails: stableClone(normalized.adjustmentDetails || []),
		priceAdjustmentsDetails: stableClone(
			normalized.priceAdjustmentsDetails || []
		),
		cancelationPolicy: stableClone(normalized.cancelationPolicy || []),
		payments: (normalized.payments || []).map((payment) => ({
			id: clean(payment.id),
			state: clean(payment.state),
			amount: centsToNullableAmount(payment.amountCents),
			currency: clean(payment.currency).toUpperCase(),
			exchangedAmount: centsToNullableAmount(payment.exchangedAmountCents),
			exchangeCurrency: clean(payment.exchangeCurrency).toUpperCase(),
			exchangeRate: Number.isFinite(payment.exchangeRate)
				? payment.exchangeRate
				: null,
			paidAt: payment.paidAt || null,
			methodName: clean(payment.methodName),
			method: clean(payment.method),
			installment: Number.isInteger(payment.installment)
				? payment.installment
				: null,
			responseCode: clean(payment.responseCode),
		})),
		rooms,
		reconciliation: {
			roomTotalsMatchGrandTotal:
				roomTotalsKnown && Number.isSafeInteger(totalCents)
					? roomTotals.reduce((sum, value) => sum + value, 0) === totalCents
					: null,
		},
		otaCommission: null,
		hotelNetPayout: null,
		hotelNetStatus: "not_provided_by_hotelrunner",
	};
}

function normalizedHasPricingBreakdown(normalized = {}) {
	if (
		[
			normalized.subTotalCents,
			normalized.extrasTotalCents,
			normalized.adjustmentsTotalCents,
			normalized.itemTotalCents,
			normalized.taxTotalCents,
			normalized.totalCents,
			normalized.paidAmountCents,
		].some(Number.isSafeInteger)
	) {
		return true;
	}
	if (
		(normalized.payments || []).some(
			(payment) =>
				Number.isSafeInteger(payment?.amountCents) ||
				Number.isSafeInteger(payment?.exchangedAmountCents) ||
				Number.isFinite(payment?.exchangeRate)
		)
	) {
		return true;
	}
	return (normalized.rooms || []).some((room) => {
		if (
			[
				room?.priceCents,
				room?.totalCents,
				room?.roomBasePriceCents,
				room?.roomSubTotalCents,
				room?.extrasTotalCents,
				room?.fixedAdjustmentsTotalCents,
				room?.includedTaxesTotalCents,
				room?.excludedFeesAndTaxesTotalCents,
				room?.cancelationRefundTotalCents,
				room?.cancelationPenaltyTotalCents,
				room?.promotionsTotalCents,
			].some(Number.isSafeInteger)
		) {
			return true;
		}
		if (
			(room?.dailyPrices || []).some((day) =>
				[
					day?.priceCents,
					day?.originalPriceCents,
					day?.discountCents,
				].some(Number.isSafeInteger)
			)
		) {
			return true;
		}
		return (room?.extras || []).some((extra) =>
			[
				extra?.priceCents,
				extra?.basePriceCents,
				extra?.promotionsTotalCents,
				extra?.totalCents,
			].some(Number.isSafeInteger)
		);
	});
}

function allocateCents(totalCents, weights = []) {
	if (!Number.isSafeInteger(totalCents) || totalCents < 0 || !weights.length) {
		return [];
	}
	const safeWeights = weights.map((weight) =>
		Number.isFinite(Number(weight)) && Number(weight) > 0 ? Number(weight) : 1
	);
	const weightTotal = safeWeights.reduce((sum, weight) => sum + weight, 0);
	const allocations = safeWeights.map((weight) =>
		Math.floor((totalCents * weight) / weightTotal)
	);
	let remainder = totalCents - allocations.reduce((sum, amount) => sum + amount, 0);
	for (let index = 0; remainder > 0; index = (index + 1) % allocations.length) {
		allocations[index] += 1;
		remainder -= 1;
	}
	return allocations;
}

function localRootPriceCents(roomDetails = {}, ymd = "") {
	const row = (roomDetails.pricingRate || []).find(
		(rate) => dateKey(rate?.calendarDate) === ymd
	);
	const rootCents = decimalToCents(row?.rootPrice);
	if (Number.isSafeInteger(rootCents) && rootCents > 0) return rootCents;
	const calendarPriceCents = decimalToCents(row?.price);
	if (Number.isSafeInteger(calendarPriceCents) && calendarPriceCents > 0) {
		return calendarPriceCents;
	}
	const fallback = decimalToCents(
		roomDetails.defaultCost ?? roomDetails.price?.basePrice
	);
	return Number.isSafeInteger(fallback) && fallback >= 0 ? fallback : 0;
}

function existingRootPriceMaps(existing = {}) {
	const exact = new Map();
	const byLocalRoomAndDate = new Map();
	for (const room of existing.pickedRoomsType || []) {
		const sourceRoomId = clean(room?.hotelRunnerRoomId);
		const configId = clean(room?.hotelRoomConfigId || room?.localRoomConfigId);
		for (const day of room?.pricingByDay || []) {
			const dayKey = clean(day?.date);
			const key = [sourceRoomId, configId, dayKey].join("\u0000");
			const fallbackKey = [configId, dayKey].join("\u0000");
			const cents = decimalToCents(day?.rootPrice);
			if (!Number.isSafeInteger(cents) || cents < 0) continue;
			exact.set(key, cents);
			if (!byLocalRoomAndDate.has(fallbackKey)) {
				byLocalRoomAndDate.set(fallbackKey, []);
			}
			byLocalRoomAndDate.get(fallbackKey).push(cents);
		}
	}
	return { exact, byLocalRoomAndDate };
}

function buildPickedRoomsProjection(normalized, resolvedRooms, existing = null) {
	const slots = [];
	for (const resolved of resolvedRooms) {
		const sourceRoom = resolved.sourceRoom;
		for (const day of sourceRoom.dailyPrices || []) {
			slots.push({
				resolved,
				date: day.date,
				weight: Number.isSafeInteger(day.priceCents) && day.priceCents > 0
					? day.priceCents
					: 1,
			});
		}
	}
	const clientAllocations = allocateCents(normalized.totalCents, slots.map((slot) => slot.weight));
	if (clientAllocations.length !== slots.length) {
		return { ok: false, code: "hotelrunner_pricing_allocation_failed" };
	}
	const rootMaps = existingRootPriceMaps(existing || {});
	const fallbackRootCursors = new Map();
	const roomRows = [];
	let cursor = 0;
	let rootTotalCents = 0;
	for (const resolved of resolvedRooms) {
		const { sourceRoom, roomDetails } = resolved;
		const pricingByDay = (sourceRoom.dailyPrices || []).map((day) => {
			const clientCents = clientAllocations[cursor] || 0;
			cursor += 1;
			const rootKey = [
				clean(sourceRoom.roomId),
				clean(roomDetails._id),
				day.date,
			].join("\u0000");
			const fallbackKey = [clean(roomDetails._id), day.date].join("\u0000");
			const fallbackValues = rootMaps.byLocalRoomAndDate.get(fallbackKey) || [];
			const fallbackCursor = fallbackRootCursors.get(fallbackKey) || 0;
			const fallbackRootCents = fallbackValues[fallbackCursor];
			const rootCents = rootMaps.exact.has(rootKey)
				? rootMaps.exact.get(rootKey)
				: Number.isSafeInteger(fallbackRootCents)
					? fallbackRootCents
					: localRootPriceCents(roomDetails, day.date);
			if (!rootMaps.exact.has(rootKey) && Number.isSafeInteger(fallbackRootCents)) {
				fallbackRootCursors.set(fallbackKey, fallbackCursor + 1);
			}
			rootTotalCents += rootCents;
			const clientAmount = centsToAmount(clientCents);
			const rootAmount = centsToAmount(rootCents);
			return {
				date: day.date,
				price: clientAmount,
				clientPrice: clientAmount,
				mainPrice: clientAmount,
				rootPrice: rootAmount,
				commissionRate: 0,
				totalPriceWithCommission: clientAmount,
				totalPriceWithoutCommission: rootAmount,
				netAfterExpenses: null,
				netAfterOtaExpenses: null,
				otaExpenseAmount: null,
				platformMargin: null,
				commercialVerification: "hotelrunner_payout_not_provided",
				hotelRunnerSourcePrice: centsToAmount(day.priceCents),
			};
		});
		const clientTotal = round2(
			pricingByDay.reduce(
				(sum, day) => sum + Number(day.totalPriceWithCommission || 0),
				0
			)
		);
		const rootTotal = round2(
			pricingByDay.reduce(
				(sum, day) => sum + Number(day.rootPrice || 0),
				0
			)
		);
		roomRows.push({
			room_type: roomDetails.roomType || "",
			displayName: roomDetails.displayName || roomDetails.roomType || "",
			hotelRoomConfigId: roomDetails._id,
			localRoomConfigId: roomDetails._id,
			hotelRunnerRoomId: sourceRoom.roomId,
			hotelRunnerInvCode: sourceRoom.invCode,
			hotelRunnerRateCode: sourceRoom.rateCode,
			hotelRunnerRatePlanCode: sourceRoom.ratePlanCode,
			sourceRoomName: sourceRoom.namePresentation || sourceRoom.name,
			otaRoomMatchType: "hotelrunner_explicit_inv_code",
			otaRoomMatchScore: 1,
			chosenPrice: pricingByDay.length
				? round2(clientTotal / pricingByDay.length)
				: 0,
			count: 1,
			pricingByDay,
			totalPriceWithCommission: clientTotal,
			hotelShouldGet: rootTotal,
		});
	}
	return {
		ok: true,
		pickedRooms: roomRows,
		clientTotal: centsToAmount(normalized.totalCents),
		rootTotal: centsToAmount(rootTotalCents),
	};
}

function commercialSourceLabel(normalized = {}) {
	return (
		clean(normalized.channelDisplay) ||
		clean(normalized.sourceDisplay) ||
		clean(normalized.channel) ||
		"HotelRunner"
	);
}

function hotelRunnerCommercialProvider(normalized = {}) {
	const providers = new Set(
		[
			normalized.channelDisplay,
			normalized.sourceDisplay,
			normalized.channel,
		]
			.map(providerKey)
			.filter((provider) => OTA_PROVIDER_KEYS.has(provider))
	);
	return providers.size === 1 ? Array.from(providers)[0] : "";
}

function hotelRunnerExternalIdentityAliases(normalized = {}) {
	const provider = hotelRunnerCommercialProvider(normalized);
	// hr_number is HotelRunner's own reservation code, not the OTA/provider
	// confirmation number. For a relayed OTA booking, using it as the shared
	// email identity can create a second local reservation when provider_number
	// is blank. Fail closed until the OTA confirmation is supplied. A native
	// HotelRunner booking may still use its HR number in the HotelRunner namespace.
	const values =
		provider === "hotelrunner"
			? [normalized.providerNumber, normalized.hrNumber]
			: [normalized.providerNumber];
	return Array.from(new Set(values.map(clean).filter(Boolean)));
}

function hotelRunnerExternalAlias(normalized = {}) {
	return hotelRunnerExternalIdentityAliases(normalized)[0] || "";
}

function hotelRunnerOtaIdentityKeys(normalized = {}) {
	const provider = hotelRunnerCommercialProvider(normalized);
	const providerIdentity = buildOtaIdentityKey(
		provider,
		hotelRunnerExternalAlias(normalized)
	);
	return {
		otaIdentityKey: providerIdentity,
		otaCrossTransportIdentityKey:
			provider === "trip" && providerIdentity ? providerIdentity : "",
	};
}

function hotelRunnerSupplierMetadata(
	normalized,
	event,
	appliedAt = new Date(),
	previous = {}
) {
	const pricing = normalizedHasPricingBreakdown(normalized)
		? hotelRunnerPricingBreakdown(normalized)
		: previous.pricing;
	return {
		transport: "hotelrunner_api",
		reservationId:
			normalized.hotelRunnerReservationId || previous.reservationId || "",
		hrNumber: normalized.hrNumber || previous.hrNumber || "",
		providerNumber: normalized.providerNumber || previous.providerNumber || "",
		channel: normalized.channel || previous.channel || "",
		channelDisplay: normalized.channelDisplay || previous.channelDisplay || "",
		sourceDisplay: normalized.sourceDisplay || previous.sourceDisplay || "",
		sourceState: normalized.state,
		requiresResponse: normalized.requiresResponse === true,
		nextStates: normalized.nextStates || [],
		lastMessageUid: normalized.messageUid,
		appliedSourceUpdatedAt: normalized.sourceUpdatedAt,
		appliedCanonicalHash: normalized.canonicalHash,
		lastAppliedAt: appliedAt,
		reportedPaymentMethod:
			normalized.paymentMethod || previous.reportedPaymentMethod || "",
		reportedPaidAmount: Number.isSafeInteger(normalized.paidAmountCents)
			? centsToAmount(normalized.paidAmountCents)
			: previous.reportedPaidAmount ?? null,
		reportedPaidAmountCurrency:
			normalized.currency || previous.reportedPaidAmountCurrency || "",
		...(pricing ? { pricing } : {}),
	};
}

function hotelRunnerOtaReviewMetadata(normalized, hotel, now = new Date()) {
	const externalConfirmation = hotelRunnerExternalAlias(normalized);
	return {
		...buildOtaReviewSnapshot({
			source: "hotelrunner_api",
			provider: hotelRunnerCommercialProvider(normalized),
			providerLabel: commercialSourceLabel(normalized),
			confirmationNumber: externalConfirmation,
		}),
		createdAt: now,
		hotelRunnerManaged: true,
		hotelRunnerLinkedAt: now,
		lastHotelRunnerUpdatedAt: now,
		hotelAssignmentRequired: false,
		hotelAssignmentStatus: "assigned",
		assignedHotelId: String(hotel._id),
		assignedHotelName: hotel.hotelName || "",
		assignedAt: now,
		roomMappingStatus: "mapped",
		roomMappingHotelId: String(hotel._id),
		lastUpdatedAt: now,
	};
}

function buildCreateReservationDocument({
	normalized,
	event,
	hotel,
	pricing,
	confirmationNumber,
	reservationMongoId,
	config = {},
}) {
	const sourceLabel = commercialSourceLabel(normalized);
	const externalConfirmation = hotelRunnerExternalAlias(normalized);
	const adults = normalized.rooms.reduce(
		(sum, room) => sum + Number(room.adults || 0),
		0
	);
	const children = normalized.rooms.reduce(
		(sum, room) => sum + Number(room.children || 0),
		0
	);
	const now = new Date();
	const sourceConfirmed = normalized.state === "confirmed";
	const requiresOtaReview =
		sourceConfirmed && config.requireOtaReview === true;
	const initialStatus = requiresOtaReview
		? OTA_PLATFORM_REVIEW_RESERVATION_STATUS
		: sourceConfirmed
			? "confirmed"
			: "Pending Confirmation";
	const identityKeys = hotelRunnerOtaIdentityKeys(normalized);
	if (!externalConfirmation || !identityKeys.otaIdentityKey) {
		const error = new Error(
			"HotelRunner reservation creation requires a shared OTA identity."
		);
		error.code = "hotelrunner_shared_identity_required";
		throw error;
	}
	return {
		_id: reservationMongoId,
		// Keep the same external confirmation semantics used by the established
		// OTA email pipeline. HotelRunner's transport-primary reservation_id is
		// retained only in supplierData.hotelRunner and the immutable mirror.
		reservation_id: externalConfirmation,
		hr_number: normalized.hrNumber,
		confirmation_number: confirmationNumber,
		otaIdentityKey: identityKeys.otaIdentityKey,
		...(identityKeys.otaCrossTransportIdentityKey
			? {
					otaCrossTransportIdentityKey:
						identityKeys.otaCrossTransportIdentityKey,
			  }
			: {}),
		pms_number: confirmationNumber,
		booking_source: sourceLabel,
		customer_details: {
			booking_source: sourceLabel,
			name: normalized.guestName || "HotelRunner Guest",
			phone: normalized.phone || normalized.address?.phone || "",
			email:
				normalized.email ||
				normalized.address?.email ||
				"no-email@jannatbooking.com",
			passport: "Not Provided",
			passportExpiry: "",
			nationality: normalized.country || "",
			postalCode: normalized.address?.postalCode || "",
			confirmation_number2: externalConfirmation,
		},
		state: initialStatus,
		reservation_status: initialStatus,
		pendingConfirmation: sourceConfirmed
			? undefined
			: {
					status: "pending",
					rejectionReason: "",
					confirmationReason: "",
					confirmedAt: null,
					rejectedAt: null,
					requestedAt: now,
					lastUpdatedAt: now,
					lastUpdatedBy: null,
					source: "hotelrunner_api_reserved",
					inventoryBlocks: true,
					clientVisibleStatus: "confirmed",
					requiresResponse: normalized.requiresResponse === true,
					nextStates: normalized.nextStates || [],
			  },
		total_guests: Number(normalized.totalGuests || adults + children || 1),
		adults,
		children,
		total_rooms: normalized.rooms.length,
		booked_at: normalized.bookedAt || normalized.sourceUpdatedAt || now,
		sub_total: pricing.rootTotal,
		extras_total: centsToAmount(normalized.extrasTotalCents),
		tax_total: centsToAmount(normalized.taxTotalCents),
		total_amount: pricing.clientTotal,
		currency: normalized.currency || "SAR",
		checkin_date: normalized.checkinDate,
		checkout_date: normalized.checkoutDate,
		days_of_residence: dateRange(
			normalized.checkinDate,
			normalized.checkoutDate
		).length,
		comment: normalized.note || "",
		booking_comment: normalized.note || "",
		financeStatus: "not paid",
		payment: normalized.paymentMethod || "",
		payment_details: { captured: false, onsite_paid_amount: 0 },
		paid_amount: 0,
		commission: 0,
		commission_ota: null,
		pickedRoomsType: pricing.pickedRooms,
		pickedRoomsPricing: pricing.pickedRooms,
		roomId: [],
		hotelId: hotel._id,
		belongsTo: hotel.belongsTo,
		adminPricing: {
			mode: "hotelrunner_api",
			clientTotal: pricing.clientTotal,
			rootTotal: pricing.rootTotal,
			netAfterExpensesTotal: null,
			otaExpenseTotal: null,
			platformMarginTotal: null,
			commissionAmount: null,
			commercialVerified: false,
			source: "hotelrunner_api",
			provider: normalized.channel || "hotelrunner",
			providerLabel: sourceLabel,
			sourceCurrency: normalized.currency,
			sourceAmount: pricing.clientTotal,
			payoutFallbackReason: HOTELRUNNER_PAYOUT_NOT_PROVIDED,
		},
		adminPricingVisibility: requiresOtaReview
			? {
					rootOnlyForHotelManagement: true,
					source: "hotelrunner_api",
					appliedAt: now,
					appliedBy: null,
			  }
			: undefined,
		ota_financial_summary: {
			show: false,
			source: "hotelrunner_api",
			provider: normalized.channel || "hotelrunner",
			providerLabel: sourceLabel,
			currency: normalized.currency,
			clientTotal: pricing.clientTotal,
			hotelVisibleAmount: pricing.rootTotal,
			netAfterExpenses: null,
			netAfterOtaExpenses: null,
			otaExpenseTotal: null,
			platformProfit: null,
			commissionAmount: null,
			commercialVerified: false,
			sourceCurrency: normalized.currency,
			sourceAmount: pricing.clientTotal,
			payoutFallbackReason: HOTELRUNNER_PAYOUT_NOT_PROVIDED,
		},
		otaPlatformReview: requiresOtaReview
			? hotelRunnerOtaReviewMetadata(normalized, hotel, now)
			: undefined,
		supplierData: {
			supplierName: sourceLabel,
			suppliedBookingNo: externalConfirmation,
			otaConfirmationNumber: externalConfirmation,
			platformConfirmationNumber: externalConfirmation,
			pmsConfirmationNumber: confirmationNumber,
			otaAutomationPipeline: "hotelrunner-background-worker",
			otaProvider: hotelRunnerCommercialProvider(normalized),
			otaSourceAuthority: 4,
			otaLastSourceReceivedAt: normalized.sourceUpdatedAt,
			otaLastEventType: normalized.state === "canceled" ? "cancelled" : "reservation",
			otaTotalPayoutSar: null,
			otaExpenseTotalSar: null,
			otaPayoutFallbackReason: HOTELRUNNER_PAYOUT_NOT_PROVIDED,
			hotelRunner: hotelRunnerSupplierMetadata(normalized, event, now),
		},
		reservationAuditLog: [
			{
				at: now,
				source: "hotelrunner-api",
				action: "created-from-hotelrunner",
				hotelRunnerReservationId: normalized.hotelRunnerReservationId,
				messageUid: normalized.messageUid,
				sourceUpdatedAt: normalized.sourceUpdatedAt,
				payloadHash: normalized.payloadHash,
			},
		],
	};
}

function normalizedPickedRooms(rows = []) {
	return (rows || []).map((room) => ({
		localRoomConfigId: clean(room?.hotelRoomConfigId || room?.localRoomConfigId),
		hotelRunnerRoomId: clean(room?.hotelRunnerRoomId),
		roomType: clean(room?.room_type || room?.roomType),
		displayName: clean(room?.displayName || room?.display_name),
		count: Number(room?.count || 1),
		pricingByDay: (room?.pricingByDay || []).map((day) => ({
			date: clean(day?.date),
			clientPrice: round2(
				day?.totalPriceWithCommission ?? day?.clientPrice ?? day?.price
			),
			rootPrice: round2(day?.rootPrice),
		})),
	}));
}

function projectionFromReservation(reservation = {}) {
	const pickedRooms = normalizedPickedRooms(reservation.pickedRoomsType || []);
	return stableClone({
		guest: {
			name: clean(reservation.customer_details?.name),
			email: clean(reservation.customer_details?.email),
			phone: clean(reservation.customer_details?.phone),
			nationality: clean(reservation.customer_details?.nationality),
		},
		guestCounts: {
			totalGuests: Number(reservation.total_guests || 0),
			adults: Number(reservation.adults || 0),
			children: Number(reservation.children || 0),
		},
		critical: {
			checkinDate: dateKey(reservation.checkin_date),
			checkoutDate: dateKey(reservation.checkout_date),
			totalRooms: Number(reservation.total_rooms || pickedRooms.length),
			rooms: pickedRooms.map((room) => ({
				localRoomConfigId: room.localRoomConfigId,
				hotelRunnerRoomId: room.hotelRunnerRoomId,
				roomType: room.roomType,
				displayName: room.displayName,
				count: room.count,
				stayDates: room.pricingByDay.map((day) => day.date),
			})),
		},
		commercial: {
			totalAmount: round2(reservation.total_amount),
			subTotal: round2(reservation.sub_total),
			extrasTotal: round2(reservation.extras_total),
			taxTotal: round2(reservation.tax_total),
			currency: clean(reservation.currency).toUpperCase(),
			rooms: pickedRooms,
		},
		note: {
			comment: clean(reservation.comment),
			bookingComment: clean(reservation.booking_comment),
		},
		state: clean(reservation.state).toLowerCase(),
		reservationStatus: clean(reservation.reservation_status).toLowerCase(),
	});
}

function projectionFromIncoming(normalized, pricing) {
	const adults = normalized.rooms.reduce(
		(sum, room) => sum + Number(room.adults || 0),
		0
	);
	const children = normalized.rooms.reduce(
		(sum, room) => sum + Number(room.children || 0),
		0
	);
	return projectionFromReservation({
		customer_details: {
			name: normalized.guestName,
			email: normalized.email || normalized.address?.email,
			phone: normalized.phone || normalized.address?.phone,
			nationality: normalized.country,
		},
		checkin_date: normalized.checkinDate,
		checkout_date: normalized.checkoutDate,
		total_guests: Number(normalized.totalGuests || adults + children || 1),
		adults,
		children,
		total_rooms: normalized.rooms.length,
		total_amount: pricing.clientTotal,
		sub_total: pricing.rootTotal,
		extras_total: centsToAmount(normalized.extrasTotalCents),
		tax_total: centsToAmount(normalized.taxTotalCents),
		currency: normalized.currency,
		pickedRoomsType: pricing.pickedRooms,
		comment: normalized.note,
		booking_comment: normalized.note,
		state: normalized.state === "confirmed" ? "confirmed" : "Pending Confirmation",
		reservation_status:
			normalized.state === "confirmed" ? "confirmed" : "Pending Confirmation",
	});
}

const same = (left, right) => stableStringify(left) === stableStringify(right);

function criticalOwnershipProjection(critical = {}) {
	return stableClone({
		checkinDate: dateKey(critical.checkinDate),
		checkoutDate: dateKey(critical.checkoutDate),
		totalRooms: Number(critical.totalRooms || 0),
		rooms: (critical.rooms || [])
			.map((room) => ({
				localRoomConfigId: clean(room.localRoomConfigId),
				count: Number(room.count || 0),
				stayDates: (room.stayDates || []).map(dateKey).filter(Boolean).sort(),
			}))
			.sort((left, right) =>
				stableStringify(left).localeCompare(stableStringify(right))
			),
	});
}

const hasNonZeroFinanceValue = (...values) =>
	values.some((value) => {
		const amount = Number(value);
		return Number.isFinite(amount) && amount !== 0;
	});

const hasFinanceReference = (...values) =>
	values.some(
		(value) =>
			(typeof value === "string" || typeof value === "number") && clean(value)
	);

const hasRecordedProcessorActivity = (processor = {}) => {
	if (!processor || typeof processor !== "object" || Array.isArray(processor)) {
		return false;
	}
	return Boolean(
		processor.charged === true ||
		processor.processing === true ||
		processor.captured === true ||
		processor.authorized === true ||
		processor.outcome_unknown === true ||
		hasNonZeroFinanceValue(
			processor.charge_count,
			processor.attempts_count,
			processor.failed_attempts_count,
			processor.total_captured_usd,
			processor.total_captured_sar,
			processor.captured_total_usd,
			processor.captured_total_sar,
			processor.captured_total,
			processor.amount,
			processor.amount_usd,
			processor.amount_sar,
			processor.gross_amount_usd
		) ||
		(Boolean(clean(processor.status || processor.last_status)) &&
			clean(processor.status || processor.last_status).toLowerCase() !==
				"not_started") ||
		hasFinanceReference(
			processor.last_transaction_id,
			processor.last_reference_number,
			processor.last_merchant_transaction_id,
			processor.last_reconciliation_id,
			processor.capture_id,
			processor.transaction_id,
			processor.authorization_id,
			processor.auth_id
		) ||
		[processor.last_attempt_at, processor.last_success_at, processor.last_failure_at].some(
			(value) => value !== undefined && value !== null && value !== ""
		) ||
		(Array.isArray(processor.attempts) && processor.attempts.length > 0) ||
		(Array.isArray(processor.captures) && processor.captures.length > 0) ||
		(processor.last_capture &&
			typeof processor.last_capture === "object" &&
			Object.keys(processor.last_capture).length > 0)
	);
};

const hasCompletedProcessorStatus = (...values) =>
	values.some((value) =>
		/^(?:accepted|authorized|captured|completed|settled|succeeded|success)$/i.test(
			clean(value)
		)
	);

function hasFinanceOrSettlementActivity(reservation = {}) {
	const breakdown = reservation.paid_amount_breakdown || {};
	const paidBreakdown = Object.entries(breakdown).some(
		([key, value]) => key !== "payment_comments" && Number(value || 0) !== 0
	);
	const processorObjects = [
		reservation.vcc_payment,
		reservation.braintree_payment,
		reservation.bofa_payment?.vcc,
	];
	const processorActivity = processorObjects.some(hasRecordedProcessorActivity);
	const paymentDetails = reservation.payment_details || {};
	const paypal = reservation.paypal_details || {};
	const paypalInitial = paypal.initial || {};
	const secureAcceptance = reservation.bofa_payment?.secure_acceptance || {};
	const financialCycle = reservation.financial_cycle || {};
	const paymentDetailsActivity = Boolean(
		hasRecordedProcessorActivity(paymentDetails) ||
		paymentDetails.captured === true ||
		paymentDetails.capturing === true ||
		paymentDetails.vccCharged === true ||
		paymentDetails.bofaVccCharged === true ||
		paymentDetails.bofaSaAccepted === true ||
		hasNonZeroFinanceValue(
			paymentDetails.onsite_paid_amount,
			paymentDetails.captured_total_usd,
			paymentDetails.captured_total_sar,
			paymentDetails.triggeredAmountUSD,
			paymentDetails.triggeredAmountSAR,
			paymentDetails.authorizationAmountUSD,
			paymentDetails.authorizationAmountSAR
		) ||
		hasFinanceReference(
			paymentDetails.transactionId,
			paymentDetails.vccCaptureId,
			paymentDetails.finalCaptureTransactionId,
			paymentDetails.bofaVccTransactionId,
			paymentDetails.authorizationId,
			paymentDetails.transactionResponse?.transId,
			paymentDetails.transactionResponse?.transactionId,
			paymentDetails.processor_reference
		) ||
		(paymentDetails.transactionResponse &&
			typeof paymentDetails.transactionResponse === "object" &&
			Object.keys(paymentDetails.transactionResponse).length > 0)
	);
	const paypalActivity = Boolean(
		hasRecordedProcessorActivity(paypal) ||
		hasRecordedProcessorActivity(paypalInitial) ||
		hasRecordedProcessorActivity(paypal.external_virtual_terminal) ||
		hasCompletedProcessorStatus(
			paypal.status,
			paypal.capture_status,
			paypalInitial.status,
			paypalInitial.capture_status,
			paypal.external_virtual_terminal?.status
		) ||
		(Array.isArray(paypal.mit) && paypal.mit.length > 0)
	);
	const secureAcceptanceActivity = Boolean(
		hasRecordedProcessorActivity(secureAcceptance) ||
		!['', 'not_started'].includes(clean(secureAcceptance.status).toLowerCase()) ||
		(Array.isArray(secureAcceptance.callbacks) &&
			secureAcceptance.callbacks.length > 0)
	);
	return Boolean(
		Number(reservation.paid_amount || 0) !== 0 ||
		paidBreakdown ||
		paymentDetailsActivity ||
		paypalActivity ||
		reservation.moneyTransferredToHotel === true ||
		reservation.commissionPaid === true ||
		Boolean(reservation.moneyTransferredAt) ||
		Boolean(reservation.commissionPaidAt) ||
		financialCycle.commissionAssigned === true ||
		Boolean(financialCycle.closedAt) ||
		clean(financialCycle.status).toLowerCase() === "closed" ||
		clean(financialCycle.notes) ||
		hasNonZeroFinanceValue(
			financialCycle.hotelCollectedAmount,
			financialCycle.pmsCollectedAmount,
			financialCycle.hotelPayoutDue,
			financialCycle.commissionDueToPms,
			financialCycle.commissionAmount,
			financialCycle.commissionValue
		) ||
		processorActivity ||
		secureAcceptanceActivity
	);
}

function hasHousingOrTerminalProtection(reservation = {}) {
	const statuses = [reservation.state, reservation.reservation_status]
		.map((status) => comparable(status).replace(/\s+/g, "_"));
	return Boolean(
		(reservation.roomId || []).some(Boolean) ||
		(reservation.bedNumber || []).some(Boolean) ||
		clean(reservation.housedBy?.name) ||
		statuses.some((status) =>
			["inhouse", "in_house", "checked_in", "checked_out", "checkedout", "no_show"].includes(
				status
			)
		)
	);
}

function isLocalTerminal(reservation = {}) {
	const text = [reservation.state, reservation.reservation_status]
		.map(comparable)
		.join(" ");
	if (/cancel/.test(text)) return "cancelled";
	if (/no show/.test(text)) return "no_show";
	if (/checked out|checkedout/.test(text)) return "checked_out";
	if (/inhouse|in house|checked in/.test(text)) return "inhouse";
	return "";
}

function isCanonicalPendingOtaReview(reservation = {}) {
	return Boolean(
		clean(reservation.otaPlatformReview?.status).toLowerCase() === "pending" &&
		comparable(reservation.state) === "ota platform review" &&
		comparable(reservation.reservation_status) === "ota platform review" &&
		!reservation.otaPlatformReview?.releasedAt &&
		!reservation.otaPlatformReview?.releasedBy
	);
}

function isHotelRunnerManagedOtaReview(reservation = {}) {
	return Boolean(
		reservation.otaPlatformReview?.hotelRunnerManaged === true ||
		clean(reservation.otaPlatformReview?.source).toLowerCase() ===
			"hotelrunner_api" ||
		clean(reservation.supplierData?.hotelRunner?.transport).toLowerCase() ===
			"hotelrunner_api"
	);
}

function isPristinePendingOtaReview(reservation = {}) {
	return Boolean(
		isCanonicalPendingOtaReview(reservation) &&
		!(reservation.roomId || []).some(Boolean) &&
		!reservation.orderTakeId &&
		!reservation.createdByUserId &&
		!hasFinanceOrSettlementActivity(reservation) &&
		authoritativeExistingRefreshProtectedStateGuard(reservation).ok === true
	);
}

function isHotelRunnerOwnedPendingConfirmation(reservation = {}) {
	return Boolean(
		comparable(reservation.state) === "pending confirmation" &&
		comparable(reservation.reservation_status) === "pending confirmation" &&
		clean(reservation.pendingConfirmation?.status).toLowerCase() === "pending" &&
		clean(reservation.pendingConfirmation?.source).toLowerCase() ===
			"hotelrunner_api_reserved"
	);
}

function isSystemOwnedOtaPendingConfirmation(reservation = {}) {
	const source = clean(reservation.pendingConfirmation?.source).toLowerCase();
	return Boolean(
		comparable(reservation.state) === "pending confirmation" &&
		comparable(reservation.reservation_status) === "pending confirmation" &&
		clean(reservation.pendingConfirmation?.status).toLowerCase() === "pending" &&
		["ota_platform_release", "ota_email_status"].includes(source) &&
		!reservation.pendingConfirmation?.lastUpdatedBy &&
		!(Array.isArray(reservation.adminChangeLog) && reservation.adminChangeLog.length)
	);
}

function isEligibleCrossTransportHandoff(reservation = {}, linkMethod = "") {
	const supplier = reservation.supplierData || {};
	const exactAliasLink = clean(linkMethod).startsWith("provider_or_hr_alias");
	const hasOtaProvenance = Boolean(
		clean(supplier.otaAutomationPipeline) ||
		clean(supplier.otaProvider) ||
		Number(supplier.otaSourceAuthority || 0) > 0 ||
		clean(reservation.otaPlatformReview?.status)
	);
	return Boolean(
		exactAliasLink &&
		hasOtaProvenance &&
		!reservation.createdByUserId &&
		!reservation.orderTakeId &&
		!(Array.isArray(reservation.adminChangeLog) && reservation.adminChangeLog.length) &&
		!hasHousingOrTerminalProtection(reservation) &&
		!hasFinanceOrSettlementActivity(reservation)
	);
}

function pmsWatermarkComparison(normalized = {}, reservation = {}) {
	const supplier = reservation.supplierData || {};
	const directHotelRunnerWatermark = supplier.hotelRunner?.appliedSourceUpdatedAt;
	if (
		directHotelRunnerWatermark &&
		Number.isFinite(new Date(directHotelRunnerWatermark).getTime())
	) {
		return sourceTimestampComparison(
			normalized.sourceUpdatedAt,
			directHotelRunnerWatermark
		);
	}
	// Email ingestion records a relay receipt time, while HotelRunner supplies
	// the provider's updated_at. Those clocks are not comparable. Only another
	// authority-level direct source watermark may reject an incoming event.
	if (Number(supplier.otaSourceAuthority || 0) >= 4) {
		return sourceTimestampComparison(
			normalized.sourceUpdatedAt,
			supplier.otaLastSourceReceivedAt
		);
	}
	return "newer";
}

function valuesFromReservation(reservation = {}) {
	return [
		reservation.reservation_id,
		reservation.hr_number,
		reservation.customer_details?.confirmation_number2,
		reservation.supplierData?.suppliedBookingNo,
		reservation.supplierData?.otaConfirmationNumber,
		reservation.supplierData?.platformConfirmationNumber,
	]
		.map((value) => comparable(value).replace(/\s+/g, ""))
		.filter(Boolean);
}

function providerKey(value = "") {
	const compact = comparable(value).replace(/\s+/g, "");
	// Provider identity is security-sensitive: only explicit aliases are accepted.
	// Native HotelRunner labels are checked first because labels such as
	// "HotelRunner Booking Engine" must never be mistaken for Booking.com.
	if (NATIVE_HOTELRUNNER_PROVIDER_ALIASES.has(compact)) return "hotelrunner";
	return HOTELRUNNER_PROVIDER_ALIASES.get(compact) || "";
}

function recognizedProviderKey(value = "") {
	const key = providerKey(value);
	return OTA_PROVIDER_KEYS.has(key) ? key : "";
}

function identityComparable(value = "") {
	return comparable(value).replace(/\s+/g, "");
}

function parseCandidateIdentityKey(value = "") {
	const raw = clean(value).toLowerCase();
	if (!raw) return null;
	const separator = raw.indexOf(":");
	if (separator <= 0 || separator === raw.length - 1) {
		return { invalid: true, provider: "", alias: "", raw };
	}
	const provider = recognizedProviderKey(raw.slice(0, separator));
	const alias = identityComparable(raw.slice(separator + 1));
	return {
		invalid: !provider || !alias,
		provider,
		alias,
		raw,
	};
}

function candidateMatchesStrongIdentity(candidate, normalized, { requireStay = true } = {}) {
	const incomingAliases = new Set(
		hotelRunnerExternalIdentityAliases(normalized)
			.map(identityComparable)
			.filter(Boolean)
	);
	if (!incomingAliases.size) return false;
	const values = valuesFromReservation(candidate);
	if (!values.some((value) => incomingAliases.has(value))) return false;
	const providerConfirmationAliases = [
		candidate.customer_details?.confirmation_number2,
		candidate.supplierData?.suppliedBookingNo,
		candidate.supplierData?.otaConfirmationNumber,
		candidate.supplierData?.platformConfirmationNumber,
	]
		.map(identityComparable)
		.filter(Boolean);
	// reservation_id may be a transport primary in older relay records, but
	// explicit provider-confirmation fields may not contradict the incoming aliases.
	if (
		providerConfirmationAliases.some(
			(value) => !incomingAliases.has(value)
		)
	) {
		return false;
	}
	if (
		candidate.supplierData?.hotelRunner?.reservationId &&
		clean(candidate.supplierData.hotelRunner.reservationId) !==
			normalized.hotelRunnerReservationId
	) {
		return false;
	}
	if (
		requireStay &&
		(dateKey(candidate.checkin_date) !== normalized.checkinDate ||
			dateKey(candidate.checkout_date) !== normalized.checkoutDate)
		) {
		return false;
	}
	const incomingProvider = hotelRunnerCommercialProvider(normalized);
	if (!incomingProvider) return false;

	const identityKey = parseCandidateIdentityKey(candidate.otaIdentityKey);
	const crossTransportKey = parseCandidateIdentityKey(
		candidate.otaCrossTransportIdentityKey
	);
	if (identityKey?.invalid || crossTransportKey?.invalid) return false;
	if (identityKey?.alias && !incomingAliases.has(identityKey.alias)) return false;
	if (
		crossTransportKey &&
		(crossTransportKey.provider !== "trip" ||
			!incomingAliases.has(crossTransportKey.alias))
	) {
		return false;
	}
	if (crossTransportKey && incomingProvider !== "trip") return false;

	const rawCanonicalProviders = [
		candidate.supplierData?.otaProvider,
		candidate.otaPlatformReview?.provider,
	].filter((value) => clean(value));
	const canonicalProviders = rawCanonicalProviders.map(recognizedProviderKey);
	if (canonicalProviders.some((provider) => !provider)) return false;
	if (identityKey?.provider) canonicalProviders.push(identityKey.provider);

	const tripBridge = Boolean(
		incomingProvider === "trip" &&
		crossTransportKey?.provider === "trip" &&
		incomingAliases.has(crossTransportKey.alias)
	);
	if (tripBridge) {
		if (
			canonicalProviders.some(
				(provider) => !["trip", "hotelrunner"].includes(provider)
			)
		) {
			return false;
		}
	} else if (
		canonicalProviders.some((provider) => provider !== incomingProvider)
	) {
		return false;
	}

	if (!canonicalProviders.length) {
		const rawLegacyProviders = [
			candidate.booking_source,
			candidate.customer_details?.booking_source,
			candidate.supplierData?.supplierName,
		].filter((value) => clean(value));
		const legacyProviders = rawLegacyProviders.map(recognizedProviderKey);
		if (
			legacyProviders.some((provider) => !provider) ||
			!legacyProviders.length ||
			legacyProviders.some((provider) => provider !== incomingProvider)
		) {
			return false;
		}
	}
	return true;
}

function escapedExactRegex(value) {
	return new RegExp(`^${clean(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
}

async function findLinkedReservation(
	normalized,
	hotelId,
	{ ReservationModel = Reservations } = {}
) {
	const direct = await ReservationModel.findOne({
		hotelId,
		"supplierData.hotelRunner.reservationId": normalized.hotelRunnerReservationId,
	})
		.lean()
		.exec();
	if (direct) return { reservation: direct, method: "hotelrunner_primary_id" };

	const aliases = hotelRunnerExternalIdentityAliases(normalized)
		.filter(Boolean)
		.map(escapedExactRegex);
	if (!aliases.length) return { reservation: null, method: "" };
	const candidates = await ReservationModel.find({
		hotelId,
		$or: [
			{ reservation_id: { $in: aliases } },
			{ hr_number: { $in: aliases } },
			{ "customer_details.confirmation_number2": { $in: aliases } },
			{ "supplierData.suppliedBookingNo": { $in: aliases } },
			{ "supplierData.otaConfirmationNumber": { $in: aliases } },
			{ "supplierData.platformConfirmationNumber": { $in: aliases } },
		],
	})
		.limit(6)
		.lean()
		.exec();
	if (candidates.length >= 6) {
		const error = new Error(
			"Too many PMS reservations match the HotelRunner alias query to prove uniqueness."
		);
		error.code = "hotelrunner_identity_ambiguous";
		throw error;
	}
	const strictMatches = candidates.filter((candidate) =>
		candidateMatchesStrongIdentity(candidate, normalized, {
			requireStay: true,
		})
	);
	if (strictMatches.length > 1) {
		const error = new Error("Multiple PMS reservations match HotelRunner identity evidence.");
		error.code = "hotelrunner_identity_ambiguous";
		throw error;
	}
	if (strictMatches.length === 1) {
		return {
			reservation: strictMatches[0],
			method: "provider_or_hr_alias_plus_stay",
		};
	}

	// A first lifecycle event can legitimately carry the newly modified stay,
	// or a cancellation can omit it. Only those explicit lifecycle events may
	// fall back to a unique exact alias without stay evidence. New reservations
	// retain the stricter alias-plus-stay rule so a reused identifier cannot link
	// an unrelated booking.
	const lifecycleEvent = normalized.modified === true || normalized.state === "canceled";
	const relaxedMatches = lifecycleEvent
		? candidates.filter((candidate) =>
				candidateMatchesStrongIdentity(candidate, normalized, {
					requireStay: false,
				})
		  )
		: [];
	if (relaxedMatches.length > 1) {
		const error = new Error("Multiple PMS reservations match HotelRunner identity evidence.");
		error.code = "hotelrunner_identity_ambiguous";
		throw error;
	}
	return {
		reservation: relaxedMatches[0] || null,
		method: relaxedMatches[0] ? "provider_or_hr_alias_unique" : "",
	};
}

async function discoverAndResolveRoomMappings(
	normalized,
	hotel,
	{
		MappingModel = HotelRunnerRoomMapping,
		SyncStateModel = HotelRunnerSyncState,
		mappingNow = () => new Date(),
		roomListVerificationMaxAgeMs = DEFAULT_ROOM_LIST_VERIFICATION_MAX_AGE_MS,
	} = {}
) {
	const referenceTime = new Date(mappingNow());
	const referenceMs = Number.isFinite(referenceTime.getTime())
		? referenceTime.getTime()
		: Date.now();
	const maxVerificationAgeMs =
		Number.isFinite(Number(roomListVerificationMaxAgeMs)) &&
		Number(roomListVerificationMaxAgeMs) > 0
			? Number(roomListVerificationMaxAgeMs)
			: DEFAULT_ROOM_LIST_VERIFICATION_MAX_AGE_MS;
	const syncState = await SyncStateModel.findOne({ hotelId: hotel._id })
		.select("activeRoomListSyncGeneration")
		.lean()
		.exec();
	const activeRoomListSyncGeneration = clean(
		syncState?.activeRoomListSyncGeneration
	);
	const byInvCode = new Map();
	for (const sourceRoom of normalized.rooms) {
		if (!byInvCode.has(sourceRoom.invCode)) byInvCode.set(sourceRoom.invCode, []);
		byInvCode.get(sourceRoom.invCode).push(sourceRoom);
	}
	for (const [invCode, rooms] of byInvCode) {
		const rateCodes = Array.from(new Set(rooms.map((room) => room.rateCode).filter(Boolean)));
		const ratePlanCodes = Array.from(
			new Set(rooms.map((room) => room.ratePlanCode).filter(Boolean))
		);
		await MappingModel.findOneAndUpdate(
			{ hotelId: hotel._id, invCode },
			{
				$setOnInsert: {
					hotelId: hotel._id,
					invCode,
					status: "pending",
					discoveredFrom: "payload",
				},
				$set: {
					externalName: rooms[0]?.name || "",
					externalNamePresentation: rooms[0]?.namePresentation || "",
					lastSeenAt: new Date(),
				},
				$addToSet: {
					rateCodes: { $each: rateCodes },
					ratePlanCodes: { $each: ratePlanCodes },
				},
			},
			{ upsert: true, new: true, setDefaultsOnInsert: true }
		).exec();
	}
	const mappings = await MappingModel.find({
		hotelId: hotel._id,
		invCode: { $in: Array.from(byInvCode.keys()) },
	})
		.lean()
		.exec();
	const mappingByCode = new Map(mappings.map((mapping) => [mapping.invCode, mapping]));
	const localRooms = new Map(
		(hotel.roomCountDetails || [])
			.filter((room) => room?._id && room?.activeRoom !== false)
			.map((room) => [String(room._id), room])
	);
	const missingInvCodes = [];
	const staleInvCodes = [];
	const unsafeMasterInvCodes = [];
	const resolvedRooms = [];
	for (const sourceRoom of normalized.rooms) {
		const mapping = mappingByCode.get(sourceRoom.invCode);
		if (mapping?.isMaster === true) {
			unsafeMasterInvCodes.push(sourceRoom.invCode);
			continue;
		}
		const verifiedAtMs = mapping?.roomListVerifiedAt
			? new Date(mapping.roomListVerifiedAt).getTime()
			: Number.NaN;
		const hasRoomListProof = Boolean(
			mapping?.roomListSyncGeneration &&
			mapping?.roomListVerificationState === "verified" &&
			mapping?.variantConflict !== true
		);
		const hasCurrentGenerationProof = Boolean(
			hasRoomListProof &&
			activeRoomListSyncGeneration &&
			mapping.roomListSyncGeneration === activeRoomListSyncGeneration
		);
		const roomListVerified = Boolean(
			hasCurrentGenerationProof &&
			Number.isFinite(verifiedAtMs) &&
			verifiedAtMs <= referenceMs + 5 * 60 * 1000 &&
			referenceMs - verifiedAtMs <= maxVerificationAgeMs
		);
		const roomDetails = mapping
			? localRooms.get(String(mapping.localRoomConfigId || ""))
			: null;
		if (
			!mapping ||
			!roomListVerified ||
			mapping.status !== "active" ||
			!roomDetails
		) {
			missingInvCodes.push(sourceRoom.invCode);
			if (
				mapping &&
				mapping?.variantConflict !== true &&
				((hasRoomListProof && !roomListVerified) ||
					mapping?.roomListVerificationState === "refreshing")
			) {
				staleInvCodes.push(sourceRoom.invCode);
			}
			continue;
		}
		resolvedRooms.push({ sourceRoom, mapping, roomDetails });
	}
	return {
		ok:
			missingInvCodes.length === 0 &&
			unsafeMasterInvCodes.length === 0 &&
			resolvedRooms.length === normalized.rooms.length,
		missingInvCodes: Array.from(new Set(missingInvCodes)),
		staleInvCodes: Array.from(new Set(staleInvCodes)),
		unsafeMasterInvCodes: Array.from(new Set(unsafeMasterInvCodes)),
		activeRoomListSyncGeneration,
		resolvedRooms,
	};
}

function sourceTimestampComparison(incoming, existing) {
	const incomingTime = new Date(incoming).getTime();
	const existingTime = existing ? new Date(existing).getTime() : 0;
	if (!Number.isFinite(incomingTime)) return "invalid";
	if (!existing || !Number.isFinite(existingTime)) return "newer";
	if (incomingTime < existingTime) return "older";
	if (incomingTime > existingTime) return "newer";
	return "equal";
}

async function ensureMirror(
	{ normalized, event, hotel, config },
	{ MirrorModel = HotelRunnerReservation } = {}
) {
	const filter = {
		hotelId: hotel._id,
		hotelRunnerReservationId: normalized.hotelRunnerReservationId,
	};
	let mirror = await MirrorModel.findOne(filter)
		.select("+normalizedSnapshot +lastAppliedProjection")
		.lean()
		.exec();
	if (!mirror) {
		try {
			mirror = await MirrorModel.create({
				...filter,
				hrIdFingerprint: config.hrIdFingerprint,
				hrNumber: normalized.hrNumber,
				providerNumber: normalized.providerNumber,
				hrNumberAliases: normalized.hrNumber ? [normalized.hrNumber] : [],
				providerNumberAliases: normalized.providerNumber
					? [normalized.providerNumber]
					: [],
				channel: normalized.channel,
				channelDisplay: normalized.channelDisplay,
				sourceDisplay: normalized.sourceDisplay,
				state: normalized.state,
				modified: normalized.modified,
				observedSourceUpdatedAt: normalized.sourceUpdatedAt,
				observedCanonicalHash: normalized.canonicalHash,
				lastMessageUid: normalized.messageUid,
				normalizedSnapshot: stableClone(event.payload),
				projectionStatus: "pending",
			});
			mirror = mirror.toObject();
			return { mirror, ordering: "newer", newlyCreated: true };
		} catch (error) {
			if (error?.code !== 11000) throw error;
			mirror = await MirrorModel.findOne(filter)
				.select("+normalizedSnapshot +lastAppliedProjection")
				.lean()
				.exec();
		}
	}

	if (
		(mirror.hrNumber && normalized.hrNumber && mirror.hrNumber !== normalized.hrNumber) ||
		(mirror.providerNumber &&
			normalized.providerNumber &&
			mirror.providerNumber !== normalized.providerNumber)
	) {
		await MirrorModel.updateOne(filter, {
			$set: {
				identityConflict: true,
				projectionStatus: "quarantined",
				lastErrorCode: "hotelrunner_identity_alias_conflict",
				lastErrorMessage: "HotelRunner identifiers changed for an established reservation link.",
			},
		}).exec();
		return { mirror, ordering: "identity_conflict", newlyCreated: false };
	}

	const ordering = sourceTimestampComparison(
		normalized.sourceUpdatedAt,
		mirror.observedSourceUpdatedAt
	);
	if (ordering === "older") return { mirror, ordering, newlyCreated: false };
	if (
		ordering === "equal" &&
		mirror.observedCanonicalHash !== normalized.canonicalHash
	) {
		await MirrorModel.updateOne(filter, {
			$set: {
				identityConflict: true,
				projectionStatus: "quarantined",
				lastErrorCode: "hotelrunner_equal_timestamp_conflict",
				lastErrorMessage: "Equal HotelRunner timestamps carried different reservation facts.",
			},
		}).exec();
		return { mirror, ordering: "equal_conflict", newlyCreated: false };
	}
	if (ordering === "newer") {
		await MirrorModel.updateOne(
			{
				_id: mirror._id,
				observedSourceUpdatedAt: mirror.observedSourceUpdatedAt,
				observedCanonicalHash: mirror.observedCanonicalHash,
			},
			{
				$set: {
					hrNumber: normalized.hrNumber || mirror.hrNumber,
					providerNumber: normalized.providerNumber || mirror.providerNumber,
					channel: normalized.channel,
					channelDisplay: normalized.channelDisplay,
					sourceDisplay: normalized.sourceDisplay,
					state: normalized.state,
					modified: normalized.modified,
					observedSourceUpdatedAt: normalized.sourceUpdatedAt,
					observedCanonicalHash: normalized.canonicalHash,
					lastMessageUid: normalized.messageUid,
					normalizedSnapshot: stableClone(event.payload),
					identityConflict: false,
					lastErrorCode: "",
					lastErrorMessage: "",
				},
				$addToSet: {
					hrNumberAliases: normalized.hrNumber,
					providerNumberAliases: normalized.providerNumber,
				},
			}
		).exec();
		mirror = await MirrorModel.findById(mirror._id)
			.select("+normalizedSnapshot +lastAppliedProjection")
			.lean()
			.exec();
		const postUpdateOrdering = sourceTimestampComparison(
			normalized.sourceUpdatedAt,
			mirror.observedSourceUpdatedAt
		);
		if (postUpdateOrdering === "older") {
			return { mirror, ordering: "older", newlyCreated: false };
		}
		if (
			postUpdateOrdering === "equal" &&
			mirror.observedCanonicalHash !== normalized.canonicalHash
		) {
			return { mirror, ordering: "equal_conflict", newlyCreated: false };
		}
	}
	return { mirror, ordering, newlyCreated: false };
}

async function updateMirrorApplied(
	mirror,
	{
		status,
		normalized,
		reservationMongoId,
		linkMethod,
		linkEvidence = {},
		lastAppliedProjection,
		result = {},
	} = {},
	{ MirrorModel = HotelRunnerReservation } = {}
) {
	const now = new Date();
	await MirrorModel.updateOne(
		{ _id: mirror._id },
		{
			$set: {
				reservationMongoId: reservationMongoId || mirror.reservationMongoId,
				linkedAt: mirror.linkedAt || now,
				linkMethod: linkMethod || mirror.linkMethod,
				linkEvidence,
				projectionStatus: status,
				appliedSourceUpdatedAt: normalized.sourceUpdatedAt,
				appliedCanonicalHash: normalized.canonicalHash,
				lastAppliedProjection: stableClone(lastAppliedProjection || {}),
				lastResult: stableClone(result),
				lastErrorCode: "",
				lastErrorMessage: "",
			},
			$inc: { projectionVersion: 1 },
		}
	).exec();
}

async function markMirrorReview(
	mirror,
	status,
	code,
	message,
	result = {},
	{ MirrorModel = HotelRunnerReservation } = {}
) {
	await MirrorModel.updateOne(
		{ _id: mirror._id },
		{
			$set: {
				projectionStatus: status,
				lastErrorCode: code,
				lastErrorMessage: clean(message).slice(0, 500),
				lastResult: stableClone(result),
			},
		}
	).exec();
}

async function establishMirrorLink(
	mirror,
	existing,
	linkMethod,
	{ MirrorModel = HotelRunnerReservation } = {}
) {
	if (!existing?._id) return mirror;
	if (mirror.reservationMongoId) {
		if (String(mirror.reservationMongoId) === String(existing._id)) return mirror;
		const conflict = new Error(
			"The HotelRunner mirror is already linked to another PMS reservation."
		);
		conflict.code = "hotelrunner_reservation_already_linked";
		throw conflict;
	}
	try {
		const linked = await MirrorModel.findOneAndUpdate(
			{ _id: mirror._id, reservationMongoId: null },
			{
				$set: {
					reservationMongoId: existing._id,
					linkedAt: new Date(),
					linkMethod: linkMethod || "strong_identity_link",
					linkEvidence: {
						strongIdentity: true,
						hotelId: String(existing.hotelId || ""),
					},
				},
			},
			{ new: true }
		)
			.select("+normalizedSnapshot +lastAppliedProjection")
			.lean()
			.exec();
		if (linked) return linked;
		const winner = await MirrorModel.findById(mirror._id)
			.select("+normalizedSnapshot +lastAppliedProjection")
			.lean()
			.exec();
		if (
			winner?.reservationMongoId &&
			String(winner.reservationMongoId) === String(existing._id)
		) {
			return winner;
		}
		const conflict = new Error(
			"The HotelRunner mirror was concurrently linked to another PMS reservation."
		);
		conflict.code = "hotelrunner_reservation_already_linked";
		throw conflict;
	} catch (error) {
		if (error?.code === 11000) {
			const conflict = new Error(
				"The PMS reservation is already linked to another HotelRunner identity."
			);
			conflict.code = "hotelrunner_reservation_already_linked";
			throw conflict;
		}
		throw error;
	}
}

async function reassignPreallocatedMirrorLink(
	mirror,
	existing,
	{ MirrorModel = HotelRunnerReservation } = {}
) {
	if (!mirror?.reservationMongoId || !existing?._id) {
		const error = new Error("HotelRunner create-race link evidence is incomplete.");
		error.code = "hotelrunner_create_race_link_invalid";
		throw error;
	}
	if (
		clean(mirror.linkMethod) !== "preallocated_create" ||
		clean(mirror.appliedCanonicalHash)
	) {
		const error = new Error(
			"An established HotelRunner reservation link cannot be reassigned."
		);
		error.code = "hotelrunner_reservation_already_linked";
		throw error;
	}
	const provisionalReservationMongoId = mirror.reservationMongoId;
	try {
		const linked = await MirrorModel.findOneAndUpdate(
			{
				_id: mirror._id,
				reservationMongoId: provisionalReservationMongoId,
				linkMethod: "preallocated_create",
				appliedCanonicalHash: { $in: ["", null] },
			},
			{
				$set: {
					reservationMongoId: existing._id,
					linkedAt: new Date(),
					linkMethod: "provider_or_hr_alias_create_race",
					linkEvidence: {
						strongIdentity: true,
						createRaceRecovered: true,
						hotelId: String(existing.hotelId || ""),
						provisionalReservationMongoId: String(
							provisionalReservationMongoId
						),
					},
				},
			},
			{ new: true }
		)
			.select("+normalizedSnapshot +lastAppliedProjection")
			.lean()
			.exec();
		if (linked) return linked;
		const winner = await MirrorModel.findById(mirror._id)
			.select("+normalizedSnapshot +lastAppliedProjection")
			.lean()
			.exec();
		if (
			winner?.reservationMongoId &&
			String(winner.reservationMongoId) === String(existing._id)
		) {
			return winner;
		}
		const conflict = new Error(
			"The HotelRunner provisional link changed during create-race recovery."
		);
		conflict.code = "hotelrunner_reservation_already_linked";
		throw conflict;
	} catch (error) {
		if (error?.code === 11000) {
			const conflict = new Error(
				"The PMS reservation is already linked to another HotelRunner identity."
			);
			conflict.code = "hotelrunner_reservation_already_linked";
			throw conflict;
		}
		throw error;
	}
}

function reservationCasFilter(existing, normalized) {
	return {
		...buildReservationSnapshotFilter(existing, { includeHotel: true }),
		$or: [
			{
				"supplierData.hotelRunner.reservationId":
					normalized.hotelRunnerReservationId,
			},
			{ "supplierData.hotelRunner.reservationId": { $exists: false } },
			{ "supplierData.hotelRunner.reservationId": "" },
		],
	};
}

function auditEntry(normalized, action, changedPaths = []) {
	return {
		at: new Date(),
		source: "hotelrunner-api",
		action,
		hotelRunnerReservationId: normalized.hotelRunnerReservationId,
		messageUid: normalized.messageUid,
		sourceUpdatedAt: normalized.sourceUpdatedAt,
		payloadHash: normalized.payloadHash,
		changedPaths: changedPaths.slice(0, 50),
	};
}

const IMMUTABLE_HOTELRUNNER_LINK_METHODS = new Set([
	"hotelrunner_primary_id",
	"hotelrunner_primary_create",
	"mirror_immutable_link",
	"preallocated_create",
	"preallocated_create_recovery",
	"provider_or_hr_alias_create_race",
]);

async function applyCancellation(
	{ normalized, event, mirror, existing, linkMethod, emailBridge = null },
	dependencies
) {
	const ReservationModel = dependencies.ReservationModel || Reservations;
	const terminal = isLocalTerminal(existing);
	if (["inhouse", "checked_out", "no_show"].includes(terminal)) {
		return {
			status: "quarantined",
			code: "hotelrunner_cancellation_terminal_conflict",
			message: "A HotelRunner cancellation cannot automatically change this local terminal stay.",
		};
	}
	const immutableHotelRunnerLink = IMMUTABLE_HOTELRUNNER_LINK_METHODS.has(
		clean(linkMethod)
	);
	if (
		normalized.stayWasSupplied &&
		!immutableHotelRunnerLink &&
		(normalized.checkinDate !== dateKey(existing.checkin_date) ||
			normalized.checkoutDate !== dateKey(existing.checkout_date))
	) {
		return {
			status: "quarantined",
			code: "hotelrunner_cancellation_stay_conflict",
			message: "Cancellation stay dates do not match the linked PMS reservation.",
		};
	}
	const now = new Date();
	const ownershipEvidenceBridge = hotelRunnerOwnershipEvidenceBridge(
		existing,
		normalized,
		emailBridge
	);
	const set = {
		...hotelRunnerOwnershipCommissionSet(existing, ownershipEvidenceBridge),
		state: "cancelled",
		reservation_status: "cancelled",
		cancel_reason: normalized.cancelReason || "Cancelled by OTA through HotelRunner",
		"pendingConfirmation.status": "cancelled",
		"pendingConfirmation.cancelledAt": now,
		"pendingConfirmation.inventoryBlocks": false,
		"pendingConfirmation.lastUpdatedAt": now,
		"supplierData.hotelRunner": hotelRunnerSupplierMetadata(
			normalized,
			event,
			now,
			existing.supplierData?.hotelRunner
		),
		"supplierData.otaAutomationPipeline": "hotelrunner-background-worker",
		"supplierData.otaSourceAuthority": 4,
		"supplierData.otaLastSourceReceivedAt": normalized.sourceUpdatedAt,
		"supplierData.otaLastEventType": "cancelled",
	};
	if (clean(existing.otaPlatformReview?.status).toLowerCase() === "pending") {
		set["otaPlatformReview.status"] = "cancelled";
		set["otaPlatformReview.cancelledAt"] = now;
	}
	const changedPaths = Object.keys(set);
	const result = await ReservationModel.updateOne(
		reservationCasFilter(existing, normalized),
		addReservationVersionBump({
			$set: set,
			$push: {
				reservationAuditLog: auditEntry(
					normalized,
					"cancelled-from-hotelrunner",
					changedPaths
				),
			},
		})
	).exec();
	const matched = Number(result?.matchedCount ?? result?.n ?? 0);
	if (!matched) return { status: "retry", code: "hotelrunner_reservation_cas_conflict" };
	const after = await ReservationModel.findById(existing._id).lean().exec();
	if (!after) {
		return { status: "retry", code: "hotelrunner_cancelled_reservation_missing" };
	}
	const afterProjection = projectionFromReservation(after);
	await updateMirrorApplied(
		mirror,
		{
			status: "cancelled",
			normalized,
			reservationMongoId: existing._id,
			lastAppliedProjection: afterProjection,
			result: { changedPaths },
		},
		dependencies
	);
	return { status: "cancelled", reservationMongoId: existing._id, changedPaths };
}

function safeDescriptiveUpdates(existing, priorProjection, incomingProjection) {
	const set = {};
	const paths = [
		["customer_details.name", "name"],
		["customer_details.email", "email"],
		["customer_details.phone", "phone"],
		["customer_details.nationality", "nationality"],
	];
	for (const [mongoPath, key] of paths) {
		const current = clean(existing.customer_details?.[key]);
		const previous = clean(priorProjection?.guest?.[key]);
		const incoming = clean(incomingProjection.guest?.[key]);
		if (incoming && (!current || (previous && current === previous))) {
			set[mongoPath] = incoming;
		}
	}
	const currentComment = clean(existing.comment);
	const priorComment = clean(priorProjection?.note?.comment);
	const incomingComment = clean(incomingProjection.note?.comment);
	if (incomingComment && (!currentComment || (priorComment && currentComment === priorComment))) {
		set.comment = incomingComment;
		set.booking_comment = incomingComment;
	}
	return set;
}

function sourceOwnedProjectionAfterUpdate({
	actualProjection,
	priorProjection,
	incomingProjection,
	hasPriorProjection,
	set,
	commercialProtected,
	guestCountsProtected,
}) {
	const baseline = stableClone(actualProjection);
	const previousOrIncoming = (group) =>
		hasPriorProjection && priorProjection?.[group]
			? stableClone(priorProjection[group])
			: stableClone(incomingProjection[group]);

	if (commercialProtected) {
		baseline.commercial = previousOrIncoming("commercial");
	}
	if (guestCountsProtected) {
		baseline.guestCounts = previousOrIncoming("guestCounts");
	}
	for (const [mongoPath, key] of [
		["customer_details.name", "name"],
		["customer_details.email", "email"],
		["customer_details.phone", "phone"],
		["customer_details.nationality", "nationality"],
	]) {
		if (
			!Object.prototype.hasOwnProperty.call(set, mongoPath) &&
			!same(actualProjection.guest?.[key], incomingProjection.guest?.[key])
		) {
			baseline.guest[key] = hasPriorProjection
				? priorProjection.guest?.[key]
				: incomingProjection.guest?.[key];
		}
	}
	if (
		!Object.prototype.hasOwnProperty.call(set, "comment") &&
		!same(actualProjection.note, incomingProjection.note)
	) {
		baseline.note = previousOrIncoming("note");
	}
	return stableClone(baseline);
}

function staleEmailCommercialEvidenceSet({ preserveFinancialAmounts = false } = {}) {
	const set = {
		// `commission_ota` is valid only while the authenticated commercial
		// evidence remains valid. It is not a settlement field, so never leave a
		// stale amount visible even when protected finance amounts must be retained.
		commission_ota: null,
		"supplierData.hotelRunnerEmailCommercialEvidence": null,
		"supplierData.otaPayoutFallbackReason":
			HOTELRUNNER_COMMERCIAL_EVIDENCE_STALE,
		"adminPricing.commercialVerified": false,
		"adminPricing.payoutFallbackReason":
			HOTELRUNNER_COMMERCIAL_EVIDENCE_STALE,
		"ota_financial_summary.show": false,
		"ota_financial_summary.commercialVerified": false,
		"ota_financial_summary.payoutFallbackReason":
			HOTELRUNNER_COMMERCIAL_EVIDENCE_STALE,
	};
	if (!preserveFinancialAmounts) {
		set["supplierData.otaTotalPayoutSar"] = null;
		set["supplierData.otaExpenseTotalSar"] = null;
		set["adminPricing.netAfterExpensesTotal"] = null;
		set["adminPricing.otaExpenseTotal"] = null;
		set["ota_financial_summary.netAfterExpenses"] = null;
		set["ota_financial_summary.netAfterOtaExpenses"] = null;
		set["ota_financial_summary.otaExpenseTotal"] = null;
	}
	return set;
}

function hotelRunnerOwnershipCommissionSet(existing = {}, emailBridge = null) {
	const set = { commission: 0 };
	const evidence = emailBridge?.ok === true ? emailBridge.evidence : null;
	if (!evidence) {
		set.commission_ota = null;
		return set;
	}
	const otaCommission = round2(evidence.otaExpenseTotalSar);
	if (!Number.isFinite(otaCommission) || otaCommission < 0) {
		set.commission_ota = null;
		return set;
	}
	set.commission_ota = otaCommission;
	set["supplierData.hotelRunnerEmailCommercialEvidence"] = evidence;
	set["supplierData.otaTotalPayoutSar"] = round2(evidence.payoutTotalSar);
	set["supplierData.otaExpenseTotalSar"] = otaCommission;
	set["supplierData.otaPayoutFallbackReason"] = "";
	set["adminPricing.netAfterExpensesTotal"] = round2(evidence.payoutTotalSar);
	set["adminPricing.otaExpenseTotal"] = otaCommission;
	set["adminPricing.defaultDeductionApplied"] = false;
	set["adminPricing.payoutFallbackReason"] = "";
	set["adminPricing.commercialVerified"] = true;
	set["ota_financial_summary.show"] = true;
	set["ota_financial_summary.netAfterExpenses"] = round2(
		evidence.payoutTotalSar
	);
	set["ota_financial_summary.netAfterOtaExpenses"] = round2(
		evidence.payoutTotalSar
	);
	set["ota_financial_summary.otaExpenseTotal"] = otaCommission;
	set["ota_financial_summary.commercialVerified"] = true;
	set["ota_financial_summary.payoutFallbackReason"] = "";
	return set;
}

function hotelRunnerOwnershipEvidenceBridge(existing = {}, normalized = {}, emailBridge = null) {
	if (emailBridge?.ok === true && emailBridge.evidence) return emailBridge;
	const evidence = verifiedHotelRunnerEmailCommercialEvidence(existing, {
		provider: hotelRunnerCommercialProvider(normalized),
	});
	if (!evidence) return null;

	const reportedCents = Number(normalized.totalCents);
	const reportedAmount =
		Number.isSafeInteger(reportedCents) && reportedCents > 0
			? round2(reportedCents / 100)
			: null;
	// Minimal cancellation pushes legitimately omit commercial totals. They do
	// not invalidate previously proven OTA evidence.
	if (!reportedAmount && normalized.state === "canceled") {
		return { ok: true, evidence };
	}
	if (!reportedAmount) return null;

	const provider = hotelRunnerCommercialProvider(normalized);
	const sourceCurrency = clean(normalized.currency).toUpperCase();
	const storedPayment = existing?.supplierData?.otaPaymentSummary || {};
	const storedSourceCurrency = clean(storedPayment.sourceCurrency).toUpperCase();
	const candidateAmounts = [];
	if (sourceCurrency === "SAR") {
		candidateAmounts.push(Number(evidence.grossTotalSar));
		if (provider === "agoda") {
			candidateAmounts.push(Number(evidence.payoutTotalSar));
		}
	}
	if (sourceCurrency && sourceCurrency === storedSourceCurrency) {
		candidateAmounts.push(Number(storedPayment.sourceTotalGuestPaymentAmount));
		if (provider === "agoda") {
			candidateAmounts.push(Number(storedPayment.sourceTotalPayoutAmount));
		}
	}
	return candidateAmounts.some(
		(value) =>
			Number.isFinite(value) &&
			value > 0 &&
			Math.abs(round2(value) - reportedAmount) <= 0.02
	)
		? { ok: true, evidence }
		: null;
}

function availabilitySnapshotInventorySummary(snapshot = {}) {
	if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
		return null;
	}
	const issues = [];
	for (const room of Array.isArray(snapshot.rooms) ? snapshot.rooms : []) {
		for (const day of Array.isArray(room?.days) ? room.days : []) {
			const availableAfterRaw = Number(day?.availableAfterRaw);
			if (!Number.isFinite(availableAfterRaw) || availableAfterRaw >= 0) {
				continue;
			}
			issues.push({
				code: "inventory_overbook",
				date: clean(day?.date),
				roomType: clean(room?.room_type || room?.roomType),
				displayName: clean(room?.displayName || room?.display_name),
				capacity: Number(day?.capacity || room?.capacity || 0),
				reserved: Number(day?.reservedBefore || 0),
				requested: Number(day?.requested || room?.requested || 0),
			});
			if (issues.length >= 25) break;
		}
		if (issues.length >= 25) break;
	}
	const reportedIssueCount = Number(snapshot.issueCount);
	let issueCount =
		Number.isSafeInteger(reportedIssueCount) && reportedIssueCount >= 0
			? reportedIssueCount
			: issues.length;
	if (snapshot.overbooked === true && issueCount === 0) issueCount = 1;
	issueCount = Math.min(issueCount, 10_000);
	return {
		overbooked: snapshot.overbooked === true || issueCount > 0,
		issueCount,
		issues,
	};
}

async function applyActiveUpdate({
	normalized,
	event,
	mirror,
	existing,
	pricing,
	linkMethod,
	hotel,
	emailBridge = null,
	config = {},
}, dependencies) {
	const ReservationModel = dependencies.ReservationModel || Reservations;
	const terminal = isLocalTerminal(existing);
	if (terminal) {
		return {
			status: "quarantined",
			code: "hotelrunner_terminal_reopen_blocked",
			message: "An active HotelRunner event cannot reopen or rewrite a local terminal stay.",
		};
	}
	const currentProjection = projectionFromReservation(existing);
	const incomingProjection = projectionFromIncoming(normalized, pricing);
	const priorProjection = mirror.lastAppliedProjection || {};
	const hasPriorProjection = Boolean(mirror.appliedCanonicalHash);
	const pendingOtaReview = isCanonicalPendingOtaReview(existing);
	const pristineReview = isPristinePendingOtaReview(existing);
	const hotelRunnerOwnedPending = isHotelRunnerOwnedPendingConfirmation(existing);
	const crossTransportHandoff =
		!hasPriorProjection && isEligibleCrossTransportHandoff(existing, linkMethod);
	const crossTransportPending =
		crossTransportHandoff && isSystemOwnedOtaPendingConfirmation(existing);
	const reviewLifecycleManaged =
		config.requireOtaReview === true || isHotelRunnerManagedOtaReview(existing);
	const preservePendingOtaReview =
		pendingOtaReview && reviewLifecycleManaged;
	const preserveReleasedOtaReview = Boolean(
		reviewLifecycleManaged &&
		crossTransportPending &&
		clean(existing.otaPlatformReview?.status).toLowerCase() === "released"
	);
	const enterOtaReviewFromHotelRunnerPending = Boolean(
		config.requireOtaReview === true &&
		hotelRunnerOwnedPending &&
		normalized.state === "confirmed"
	);
	const currentCriticalOwnership = criticalOwnershipProjection(
		currentProjection.critical
	);
	const incomingCriticalOwnership = criticalOwnershipProjection(
		incomingProjection.critical
	);
	const priorCriticalOwnership = criticalOwnershipProjection(
		priorProjection.critical
	);
	const criticalChanged = !same(
		currentCriticalOwnership,
		incomingCriticalOwnership
	);
	const commercialChanged = !same(
		currentProjection.commercial,
		incomingProjection.commercial
	);
	const criticalOwned = hasPriorProjection
		? same(currentCriticalOwnership, priorCriticalOwnership)
		: same(currentCriticalOwnership, incomingCriticalOwnership) ||
			pristineReview ||
			crossTransportHandoff;
	const commercialOwned = hasPriorProjection
		? same(currentProjection.commercial, priorProjection.commercial)
		: same(currentProjection.commercial, incomingProjection.commercial) ||
			pristineReview ||
			crossTransportHandoff;
	const hasFinanceProtection = hasFinanceOrSettlementActivity(existing);
	const existingCommercialEvidence =
		existing?.supplierData?.hotelRunnerEmailCommercialEvidence;
	const verifiedCommercialEvidence =
		verifiedHotelRunnerEmailCommercialEvidence(existing, {
			provider: hotelRunnerCommercialProvider(normalized),
			grossTotalSar: pricing.clientTotal,
			currency: normalized.currency,
		});
	const incomingCommercialEvidence =
		emailBridge?.ok === true && emailBridge.evidence
			? emailBridge.evidence
			: verifiedCommercialEvidence;
	const hasPresentedCommercialEvidence = Boolean(
		existingCommercialEvidence ||
			existing?.adminPricing?.commercialVerified === true ||
			existing?.ota_financial_summary?.commercialVerified === true
	);
	const commercialEvidenceStale = Boolean(
		hasPresentedCommercialEvidence &&
			(!incomingCommercialEvidence || criticalChanged)
	);
	if (
		criticalChanged &&
		(!criticalOwned ||
			hasHousingOrTerminalProtection(existing) ||
			hasFinanceProtection)
	) {
		let changedPaths = [];
		if (commercialEvidenceStale) {
			const staleSet = staleEmailCommercialEvidenceSet({
				preserveFinancialAmounts: true,
			});
			changedPaths = Object.keys(staleSet);
			const staleResult = await ReservationModel.updateOne(
				reservationCasFilter(existing, normalized),
				addReservationVersionBump({
					$set: staleSet,
					$push: {
						reservationAuditLog: auditEntry(
							normalized,
							"hotelrunner-commercial-evidence-invalidated",
							changedPaths
						),
					},
				})
			).exec();
			const matched = Number(
				staleResult?.matchedCount ?? staleResult?.n ?? 0
			);
			if (!matched) {
				return {
					status: "retry",
					code: "hotelrunner_reservation_cas_conflict",
				};
			}
		}
		return {
			status: "quarantined",
			code: "hotelrunner_local_room_or_stay_conflict",
			message: "Local room, stay, housing, or finance changes protect this reservation from an automatic HotelRunner rewrite.",
			changedPaths,
			commercialEvidenceStale,
			attentionCode: commercialEvidenceStale
				? HOTELRUNNER_COMMERCIAL_EVIDENCE_STALE
				: "",
		};
	}

	const ownershipEvidenceBridge = hotelRunnerOwnershipEvidenceBridge(
		existing,
		normalized,
		emailBridge
	);
	const set = {
		...safeDescriptiveUpdates(existing, priorProjection, incomingProjection),
		...hotelRunnerOwnershipCommissionSet(existing, ownershipEvidenceBridge),
	};
	const guestCountsChanged = !same(
		currentProjection.guestCounts,
		incomingProjection.guestCounts
	);
	const guestCountsOwned = hasPriorProjection
		? same(currentProjection.guestCounts, priorProjection.guestCounts)
		: same(currentProjection.guestCounts, incomingProjection.guestCounts) ||
			pristineReview ||
			crossTransportHandoff;
	if (guestCountsChanged && guestCountsOwned) {
		set.total_guests = incomingProjection.guestCounts.totalGuests;
		set.adults = incomingProjection.guestCounts.adults;
		set.children = incomingProjection.guestCounts.children;
	}
	if (criticalChanged) {
		set.checkin_date = normalized.checkinDate;
		set.checkout_date = normalized.checkoutDate;
		set.days_of_residence = dateRange(
			normalized.checkinDate,
			normalized.checkoutDate
		).length;
		set.total_rooms = normalized.rooms.length;
		set.pickedRoomsType = pricing.pickedRooms;
		set.pickedRoomsPricing = pricing.pickedRooms;
	}
	const preserveVerifiedEmailCommercial = Boolean(
		(emailBridge?.ok === true || incomingCommercialEvidence) && !criticalChanged
	);
	const commercialProtected =
		commercialChanged &&
		(!commercialOwned || hasFinanceProtection || preserveVerifiedEmailCommercial);
	if (commercialChanged && !commercialProtected) {
		set.total_amount = pricing.clientTotal;
		set.sub_total = pricing.rootTotal;
		set.extras_total = centsToAmount(normalized.extrasTotalCents);
		set.tax_total = centsToAmount(normalized.taxTotalCents);
		set.currency = normalized.currency;
		set.pickedRoomsType = pricing.pickedRooms;
		set.pickedRoomsPricing = pricing.pickedRooms;
		set.adminPricing = {
			...(existing.adminPricing || {}),
			mode: "hotelrunner_api",
			clientTotal: pricing.clientTotal,
			rootTotal: pricing.rootTotal,
			netAfterExpensesTotal: null,
			otaExpenseTotal: null,
			platformMarginTotal: null,
			commercialVerified: false,
			source: "hotelrunner_api",
			sourceCurrency: normalized.currency,
			sourceAmount: pricing.clientTotal,
			payoutFallbackReason: commercialEvidenceStale
				? HOTELRUNNER_COMMERCIAL_EVIDENCE_STALE
				: HOTELRUNNER_PAYOUT_NOT_PROVIDED,
		};
		set.ota_financial_summary = {
			...(existing.ota_financial_summary || {}),
			show: false,
			source: "hotelrunner_api",
			provider: normalized.channel || "hotelrunner",
			providerLabel: commercialSourceLabel(normalized),
			currency: normalized.currency,
			clientTotal: pricing.clientTotal,
			hotelVisibleAmount: pricing.rootTotal,
			netAfterExpenses: null,
			netAfterOtaExpenses: null,
			otaExpenseTotal: null,
			platformProfit: null,
			commissionAmount: null,
			commercialVerified: false,
			sourceCurrency: normalized.currency,
			sourceAmount: pricing.clientTotal,
			payoutFallbackReason: commercialEvidenceStale
				? HOTELRUNNER_COMMERCIAL_EVIDENCE_STALE
				: HOTELRUNNER_PAYOUT_NOT_PROVIDED,
		};
		set["supplierData.otaTotalPayoutSar"] = null;
		set["supplierData.otaExpenseTotalSar"] = null;
		set["supplierData.otaPayoutFallbackReason"] = commercialEvidenceStale
			? HOTELRUNNER_COMMERCIAL_EVIDENCE_STALE
			: HOTELRUNNER_PAYOUT_NOT_PROVIDED;
	}
	if (commercialEvidenceStale) {
		if (commercialChanged && !commercialProtected) {
			set["supplierData.hotelRunnerEmailCommercialEvidence"] = null;
		} else {
			Object.assign(
				set,
				staleEmailCommercialEvidenceSet({
					preserveFinancialAmounts: commercialProtected,
				})
			);
		}
	}
	const now = new Date();
	if (
		!preservePendingOtaReview &&
		!preserveReleasedOtaReview &&
		!enterOtaReviewFromHotelRunnerPending &&
		(pristineReview || hotelRunnerOwnedPending || crossTransportPending)
	) {
		const sourceConfirmed = normalized.state === "confirmed";
		set.state = sourceConfirmed ? "confirmed" : "Pending Confirmation";
		set.reservation_status = sourceConfirmed
			? "confirmed"
			: "Pending Confirmation";
		set["pendingConfirmation.status"] = sourceConfirmed ? "confirmed" : "pending";
		set["pendingConfirmation.source"] = "hotelrunner_api_reserved";
		set["pendingConfirmation.inventoryBlocks"] = true;
		set["pendingConfirmation.clientVisibleStatus"] = "confirmed";
		set["pendingConfirmation.requiresResponse"] = normalized.requiresResponse === true;
		set["pendingConfirmation.nextStates"] = normalized.nextStates || [];
		set["pendingConfirmation.lastUpdatedAt"] = now;
		if (sourceConfirmed) {
			set["pendingConfirmation.confirmationReason"] = "confirmed_by_hotelrunner";
			set["pendingConfirmation.confirmedAt"] = now;
			set["pendingConfirmation.rejectionReason"] = "";
			set["pendingConfirmation.rejectedAt"] = null;
		} else {
			set["pendingConfirmation.requestedAt"] =
				existing.pendingConfirmation?.requestedAt || now;
		}
	}
	if (pristineReview && !preservePendingOtaReview) {
		set["otaPlatformReview.status"] = "released";
		set["otaPlatformReview.releasedAt"] = now;
		set["otaPlatformReview.releaseReason"] = "superseded_by_hotelrunner_api";
	}
	if (preservePendingOtaReview) {
		set.state = OTA_PLATFORM_REVIEW_RESERVATION_STATUS;
		set.reservation_status = OTA_PLATFORM_REVIEW_RESERVATION_STATUS;
		set["otaPlatformReview.status"] = "pending";
		set["otaPlatformReview.hotelRunnerManaged"] = true;
		set["otaPlatformReview.hotelRunnerLinkedAt"] =
			existing.otaPlatformReview?.hotelRunnerLinkedAt || now;
		set["otaPlatformReview.lastHotelRunnerUpdatedAt"] = now;
		set["otaPlatformReview.lastUpdatedAt"] = now;
		set["adminPricingVisibility.rootOnlyForHotelManagement"] = true;
	}
	if (enterOtaReviewFromHotelRunnerPending) {
		set.state = OTA_PLATFORM_REVIEW_RESERVATION_STATUS;
		set.reservation_status = OTA_PLATFORM_REVIEW_RESERVATION_STATUS;
		set.otaPlatformReview = hotelRunnerOtaReviewMetadata(
			normalized,
			hotel || { _id: existing.hotelId, hotelName: "" },
			now
		);
		set["adminPricingVisibility.rootOnlyForHotelManagement"] = true;
		set["adminPricingVisibility.source"] = "hotelrunner_api";
		set["adminPricingVisibility.appliedAt"] = now;
		set["adminPricingVisibility.appliedBy"] = null;
	}
	if (preserveReleasedOtaReview) {
		set["otaPlatformReview.hotelRunnerManaged"] = true;
		set["otaPlatformReview.hotelRunnerLinkedAt"] =
			existing.otaPlatformReview?.hotelRunnerLinkedAt || now;
		set["otaPlatformReview.lastHotelRunnerUpdatedAt"] = now;
	}
	set.hr_number = normalized.hrNumber || existing.hr_number || "";
	set["supplierData.hotelRunner"] = hotelRunnerSupplierMetadata(
		normalized,
		event,
		now,
		existing.supplierData?.hotelRunner
	);
	set["supplierData.otaAutomationPipeline"] = "hotelrunner-background-worker";
	set["supplierData.otaSourceAuthority"] = 4;
	set["supplierData.otaLastSourceReceivedAt"] = normalized.sourceUpdatedAt;
	set["supplierData.otaLastEventType"] = normalized.state;
	const changedPaths = Object.keys(set);

	let modificationAvailability = null;
	if (criticalChanged) {
		modificationAvailability = await (
			dependencies.validateInventory || validateReservationInventoryForCreate
		)(
			{
				...existing,
				checkin_date: set.checkin_date,
				checkout_date: set.checkout_date,
				pickedRoomsType: set.pickedRoomsType,
				pickedRoomsPricing: set.pickedRoomsPricing,
			},
			{ allowOverbook: true, excludeReservationId: existing._id }
		);
	}
	const updateResult = await ReservationModel.updateOne(
		reservationCasFilter(existing, normalized),
		addReservationVersionBump({
			$set: set,
			$push: {
				reservationAuditLog: auditEntry(
					normalized,
					"updated-from-hotelrunner",
					changedPaths
				),
			},
		})
	).exec();
	const matched = Number(updateResult?.matchedCount ?? updateResult?.n ?? 0);
	if (!matched) return { status: "retry", code: "hotelrunner_reservation_cas_conflict" };
	const after = await ReservationModel.findById(existing._id).lean().exec();
	if (!after) {
		return { status: "retry", code: "hotelrunner_updated_reservation_missing" };
	}
	const actualProjection = projectionFromReservation(after);
	const guestCountsProtected = guestCountsChanged && !guestCountsOwned;
	const finalProjection = sourceOwnedProjectionAfterUpdate({
		actualProjection,
		priorProjection,
		incomingProjection,
		hasPriorProjection,
		set,
		commercialProtected,
		guestCountsProtected,
	});
	const inventorySummary = modificationAvailability
		? {
				overbooked: Array.isArray(modificationAvailability.issues) &&
					modificationAvailability.issues.length > 0,
				issueCount: Number(modificationAvailability.issues?.length || 0),
				issues: (modificationAvailability.issues || []).slice(0, 25).map((issue) => ({
					code: clean(issue?.code),
					date: clean(issue?.date),
					roomType: clean(issue?.room_type),
					displayName: clean(issue?.displayName),
					capacity: Number(issue?.capacity || 0),
					reserved: Number(issue?.reserved || 0),
					requested: Number(issue?.requested || 0),
				})),
		  }
		: null;
	await updateMirrorApplied(
		mirror,
		{
			status: "updated",
			normalized,
			reservationMongoId: existing._id,
			linkMethod,
			linkEvidence: { strongIdentity: true, hotelId: String(existing.hotelId) },
			lastAppliedProjection: finalProjection,
			result: {
				changedPaths,
				commercialProtected,
				commercialEvidenceStale,
				attentionCode: commercialEvidenceStale
					? HOTELRUNNER_COMMERCIAL_EVIDENCE_STALE
					: "",
				inventoryIssueCount: Number(modificationAvailability?.issues?.length || 0),
				inventorySummary,
			},
		},
		dependencies
	);
	return {
		status: "updated",
		reservationMongoId: existing._id,
		changedPaths,
		commercialProtected,
		commercialEvidenceStale,
		attentionCode: commercialEvidenceStale
			? HOTELRUNNER_COMMERCIAL_EVIDENCE_STALE
			: "",
		guestCountsProtected,
		inventoryIssueCount: Number(modificationAvailability?.issues?.length || 0),
		inventorySummary,
	};
}

async function createReservation({
	normalized,
	event,
	mirror,
	hotel,
	pricing,
	config = {},
}, dependencies) {
	const ReservationModel = dependencies.ReservationModel || Reservations;
	const MirrorModel = dependencies.MirrorModel || HotelRunnerReservation;
	let reservationMongoId = mirror.reservationMongoId;
	if (!reservationMongoId) {
		const plannedId = new ObjectId();
		const claimed = await MirrorModel.findOneAndUpdate(
			{ _id: mirror._id, reservationMongoId: null },
			{
				$set: {
					reservationMongoId: plannedId,
					linkMethod: "preallocated_create",
					linkEvidence: { planned: true },
				},
			},
			{ new: true }
		)
			.select("+normalizedSnapshot +lastAppliedProjection")
			.lean()
			.exec();
		if (claimed?.reservationMongoId) {
			reservationMongoId = claimed.reservationMongoId;
			mirror = claimed;
		} else {
			const winner = await MirrorModel.findById(mirror._id)
				.select("+normalizedSnapshot +lastAppliedProjection")
				.lean()
				.exec();
			if (!winner?.reservationMongoId) {
				const error = new Error(
					"HotelRunner PMS identifier allocation changed concurrently."
				);
				error.code = "hotelrunner_preallocation_cas_conflict";
				throw error;
			}
			reservationMongoId = winner.reservationMongoId;
			mirror = winner;
		}
	}
	let existingById = await ReservationModel.findById(reservationMongoId).lean().exec();
	if (existingById) {
		if (
			String(existingById.hotelId) !== String(hotel._id) ||
			clean(existingById.supplierData?.hotelRunner?.reservationId) !==
				normalized.hotelRunnerReservationId
		) {
			return {
				status: "quarantined",
				code: "hotelrunner_preallocated_id_conflict",
				message: "The reserved PMS identifier belongs to a different reservation.",
			};
		}
		const projection = projectionFromReservation(existingById);
		const inventorySummary = availabilitySnapshotInventorySummary(
			existingById.availabilitySnapshot
		);
		const inventoryIssueCount = Number(inventorySummary?.issueCount || 0);
		await updateMirrorApplied(
			mirror,
			{
				status: "created",
				normalized,
				reservationMongoId,
				linkMethod: "preallocated_create_recovery",
				linkEvidence: { recovered: true },
				lastAppliedProjection: projection,
				result: {
					crashRecovery: true,
					inventoryIssueCount,
					inventorySummary,
				},
			},
			dependencies
		);
		return {
			status: "created",
			reservationMongoId,
			crashRecovery: true,
			inventoryIssueCount,
			inventorySummary,
		};
	}
	const generateConfirmation =
		dependencies.generateConfirmation || generateUniquePmsConfirmationNumber;
	const confirmationNumber = await generateConfirmation();
	const document = buildCreateReservationDocument({
		normalized,
		event,
		hotel,
		pricing,
		confirmationNumber,
		reservationMongoId,
		config,
	});
	let createdReservation = null;
	try {
		const createWithSnapshot =
			dependencies.createWithSnapshot || createReservationWithAvailabilitySnapshot;
		createdReservation = await createWithSnapshot(document, "hotelrunner_api_create");
	} catch (error) {
		if (error?.code !== 11000) throw error;
		existingById = await ReservationModel.findById(reservationMongoId).lean().exec();
		if (existingById) {
			if (
				clean(existingById.supplierData?.hotelRunner?.reservationId) !==
				normalized.hotelRunnerReservationId
			) {
				throw error;
			}
		} else {
			const createRaceWinner = await findLinkedReservation(
				normalized,
				hotel._id,
				dependencies
			);
			if (!createRaceWinner.reservation) throw error;
			await reassignPreallocatedMirrorLink(
				mirror,
				createRaceWinner.reservation,
				dependencies
			);
			return {
				status: "retry",
				code: "hotelrunner_cross_transport_create_race_relinked",
			};
		}
	}
	const persistedReservation =
		existingById ||
		(createdReservation?.toObject
			? createdReservation.toObject()
			: createdReservation) ||
		(await ReservationModel.findById(reservationMongoId).lean().exec());
	if (!persistedReservation) {
		const error = new Error(
			"HotelRunner reservation creation did not produce a durable PMS record."
		);
		error.code = "hotelrunner_created_reservation_missing";
		throw error;
	}
	const projection = projectionFromReservation(persistedReservation);
	const inventorySummary = availabilitySnapshotInventorySummary(
		persistedReservation.availabilitySnapshot
	);
	const inventoryIssueCount = Number(inventorySummary?.issueCount || 0);
	await updateMirrorApplied(
		mirror,
		{
			status: "created",
			normalized,
			reservationMongoId,
			linkMethod: "hotelrunner_primary_create",
			linkEvidence: { hotelId: String(hotel._id) },
			lastAppliedProjection: projection,
			result: {
				confirmationNumber,
				inventoryIssueCount,
				inventorySummary,
			},
		},
		dependencies
	);
	return {
		status: "created",
		reservationMongoId,
		confirmationNumber,
		inventoryIssueCount,
		inventorySummary,
	};
}

async function projectHotelRunnerReservation(
	{ normalized, event, hotel, config },
	dependencies = {}
) {
	const mirrorState = await ensureMirror(
		{ normalized, event, hotel, config },
		dependencies
	);
	let { mirror } = mirrorState;
	if (["identity_conflict", "equal_conflict"].includes(mirrorState.ordering)) {
		return {
			status: "quarantined",
			code:
				mirrorState.ordering === "identity_conflict"
					? "hotelrunner_identity_alias_conflict"
					: "hotelrunner_equal_timestamp_conflict",
			mirrorId: mirror._id,
		};
	}
	if (mirrorState.ordering === "older") {
		return {
			status: "ignored",
			code: "hotelrunner_stale_event",
			mirrorId: mirror._id,
		};
	}
	if (
		mirror.appliedCanonicalHash === normalized.canonicalHash &&
		new Date(mirror.appliedSourceUpdatedAt || 0).getTime() ===
			new Date(normalized.sourceUpdatedAt).getTime()
	) {
		return {
			status: "ignored",
			code: "hotelrunner_already_applied",
			mirrorId: mirror._id,
			reservationMongoId: mirror.reservationMongoId,
		};
	}

	let linked;
	try {
		linked = await findLinkedReservation(normalized, hotel._id, dependencies);
	} catch (error) {
		await markMirrorReview(
			mirror,
			"quarantined",
			error.code || "hotelrunner_identity_ambiguous",
			error.message,
			{},
			dependencies
		);
		return { status: "quarantined", code: error.code, mirrorId: mirror._id };
	}
	let existing = linked.reservation;
	if (mirror.reservationMongoId) {
		const byMirrorId = await (dependencies.ReservationModel || Reservations)
			.findById(mirror.reservationMongoId)
			.lean()
			.exec();
		if (byMirrorId) {
			if (existing && String(existing._id) !== String(byMirrorId._id)) {
				await markMirrorReview(
					mirror,
					"quarantined",
					"hotelrunner_link_conflict",
					"HotelRunner mirror and strong identity point to different PMS reservations.",
					{},
					dependencies
				);
				return {
					status: "quarantined",
					code: "hotelrunner_link_conflict",
					mirrorId: mirror._id,
				};
			}
			existing = byMirrorId;
			linked.method = mirror.linkMethod || "mirror_immutable_link";
		} else if (mirror.appliedCanonicalHash) {
			await markMirrorReview(
				mirror,
				"quarantined",
				"hotelrunner_linked_reservation_missing",
				"The previously linked PMS reservation no longer exists; it will not be recreated automatically.",
				{},
				dependencies
			);
			return {
				status: "quarantined",
				code: "hotelrunner_linked_reservation_missing",
				mirrorId: mirror._id,
			};
		} else if (existing) {
			try {
				mirror = await reassignPreallocatedMirrorLink(
					mirror,
					existing,
					dependencies
				);
				linked.method = "provider_or_hr_alias_create_race";
			} catch (error) {
				await markMirrorReview(
					mirror,
					"quarantined",
					error.code || "hotelrunner_link_conflict",
					error.message,
					{},
					dependencies
				);
				return {
					status: "quarantined",
					code: error.code || "hotelrunner_link_conflict",
					mirrorId: mirror._id,
				};
			}
		}
	}
	if (existing && !mirror.reservationMongoId) {
		try {
			mirror = await establishMirrorLink(
				mirror,
				existing,
				linked.method,
				dependencies
			);
		} catch (error) {
			await markMirrorReview(
				mirror,
				"quarantined",
				error.code || "hotelrunner_link_conflict",
				error.message,
				{},
				dependencies
			);
			return {
				status: "quarantined",
				code: error.code || "hotelrunner_link_conflict",
				mirrorId: mirror._id,
			};
		}
	}
	if (existing && pmsWatermarkComparison(normalized, existing) === "older") {
		await markMirrorReview(
			mirror,
			"ignored",
			"hotelrunner_stale_against_pms_watermark",
			"The HotelRunner event predates the PMS reservation's latest OTA source update.",
			{
				incomingSourceUpdatedAt: normalized.sourceUpdatedAt,
				pmsSourceUpdatedAt: existing.supplierData?.otaLastSourceReceivedAt,
			},
			dependencies
		);
		return {
			status: "ignored",
			code: "hotelrunner_stale_against_pms_watermark",
			mirrorId: mirror._id,
		};
	}
	const loadEmailBridge =
		dependencies.loadEmailCommercialBridge ||
		loadHotelRunnerEmailCommercialBridge;
	const emailBridge = existing
		? await loadEmailBridge(
				{
					existing,
					normalized,
					provider: hotelRunnerCommercialProvider(normalized),
				},
				dependencies.InboundEmailModel
					? { InboundEmailModel: dependencies.InboundEmailModel }
					: undefined
			  )
		: { ok: false, reason: "pms_reservation_not_created_yet", amountRole: "" };

	if (normalized.state === "canceled") {
		if (!existing) {
			await markMirrorReview(
				mirror,
				"quarantined",
				"hotelrunner_unmatched_cancellation",
				"An unmatched HotelRunner cancellation cannot create or select a PMS reservation.",
				{},
				dependencies
			);
			return {
				status: "quarantined",
				code: "hotelrunner_unmatched_cancellation",
				mirrorId: mirror._id,
			};
		}
		const result = await applyCancellation(
			{
				normalized,
				event,
				mirror,
				existing,
				linkMethod: linked.method,
				emailBridge,
			},
			dependencies
		);
		return { ...result, mirrorId: mirror._id };
	}

	if (!existing) {
		const sharedIdentity = hotelRunnerOtaIdentityKeys(normalized);
		if (
			!hotelRunnerExternalAlias(normalized) ||
			!sharedIdentity.otaIdentityKey
		) {
			await markMirrorReview(
				mirror,
				"quarantined",
				"hotelrunner_shared_identity_required",
				"A new HotelRunner reservation needs a recognized OTA provider and a provider or HotelRunner confirmation number before it can be created locally.",
				{
					hasExternalAlias: Boolean(hotelRunnerExternalAlias(normalized)),
					hasRecognizedProvider: Boolean(
						hotelRunnerCommercialProvider(normalized)
					),
				},
				dependencies
			);
			return {
				status: "quarantined",
				code: "hotelrunner_shared_identity_required",
				mirrorId: mirror._id,
			};
		}
	}

	const hotelCurrency = clean(hotel.currency || "SAR").toUpperCase();
	const currencyBridgedByAuthenticatedEmail = emailBridge?.ok === true;
	if (
		normalized.currency !== hotelCurrency &&
		!currencyBridgedByAuthenticatedEmail
	) {
		if (
			!existing ||
			[
				"pms_reservation_not_created_yet",
				"missing_inbound_email_reference",
				"inbound_email_not_found",
				"inbound_email_lookup_failed",
			].includes(clean(emailBridge?.reason))
		) {
			return {
				status: "retry",
				code: "hotelrunner_currency_waiting_for_email_bridge",
				mirrorId: mirror._id,
			};
		}
		await markMirrorReview(
			mirror,
			"quarantined",
			"hotelrunner_currency_requires_review",
			"HotelRunner currency differs from the PMS hotel currency; no implicit conversion was made.",
			{ sourceCurrency: normalized.currency, hotelCurrency },
			dependencies
		);
		return {
			status: "quarantined",
			code: "hotelrunner_currency_requires_review",
			mirrorId: mirror._id,
		};
	}
	const configuredRoomListAgeMs =
		Math.max(48, Number(config.roomListIntervalHours || 24) * 3) *
		60 *
		60 *
		1000;
	const mapping = await discoverAndResolveRoomMappings(normalized, hotel, {
		...dependencies,
		roomListVerificationMaxAgeMs:
			dependencies.roomListVerificationMaxAgeMs || configuredRoomListAgeMs,
	});
	if (!mapping.ok) {
		const masterRoomConflict = mapping.unsafeMasterInvCodes.length > 0;
		const staleRoomMapping = mapping.staleInvCodes.length > 0;
		const code = masterRoomConflict
			? "hotelrunner_master_room_not_mappable"
			: staleRoomMapping
				? "hotelrunner_room_mapping_stale"
			: "hotelrunner_room_mapping_required";
		const message = masterRoomConflict
			? "HotelRunner master fallback inventory cannot be mapped to a PMS room category."
			: staleRoomMapping
				? "One or more HotelRunner room-list verifications are stale and must be refreshed before projection."
			: "One or more HotelRunner inventory codes need an explicit PMS room mapping.";
		await markMirrorReview(
			mirror,
			"needs_mapping",
			code,
			message,
			{
				missingInvCodes: mapping.missingInvCodes,
				staleInvCodes: mapping.staleInvCodes,
				unsafeMasterInvCodes: mapping.unsafeMasterInvCodes,
			},
			dependencies
		);
		return {
			status: "needs_mapping",
			code,
			missingInvCodes: mapping.missingInvCodes,
			staleInvCodes: mapping.staleInvCodes,
			unsafeMasterInvCodes: mapping.unsafeMasterInvCodes,
			mirrorId: mirror._id,
		};
	}
	const pricing = buildPickedRoomsProjection(
		normalized,
		mapping.resolvedRooms,
		existing
	);
	if (!pricing.ok) {
		await markMirrorReview(
			mirror,
			"quarantined",
			pricing.code,
			"HotelRunner pricing could not be represented exactly in the PMS.",
			{},
			dependencies
		);
		return { status: "quarantined", code: pricing.code, mirrorId: mirror._id };
	}
	if (!existing) {
		try {
			const raceRecheck = await findLinkedReservation(
				normalized,
				hotel._id,
				dependencies
			);
			if (raceRecheck.reservation) {
				existing = raceRecheck.reservation;
				linked = raceRecheck;
				mirror = await establishMirrorLink(
					mirror,
					existing,
					linked.method,
					dependencies
				);
				if (pmsWatermarkComparison(normalized, existing) === "older") {
					await markMirrorReview(
						mirror,
						"ignored",
						"hotelrunner_stale_against_pms_watermark",
						"The HotelRunner event predates the PMS reservation's latest OTA source update.",
						{},
						dependencies
					);
					return {
						status: "ignored",
						code: "hotelrunner_stale_against_pms_watermark",
						mirrorId: mirror._id,
					};
				}
			}
		} catch (error) {
			await markMirrorReview(
				mirror,
				"quarantined",
				error.code || "hotelrunner_link_conflict",
				error.message,
				{},
				dependencies
			);
			return {
				status: "quarantined",
				code: error.code || "hotelrunner_link_conflict",
				mirrorId: mirror._id,
			};
		}
	}
	const result = existing
		? await applyActiveUpdate(
				{
					normalized,
					event,
					mirror,
				existing,
				pricing,
				linkMethod: linked.method,
				hotel,
				emailBridge,
				config,
				},
				dependencies
		  )
		: await createReservation(
				{ normalized, event, mirror, hotel, pricing, config },
				dependencies
		  );
	if (["quarantined", "needs_mapping"].includes(result.status)) {
		await markMirrorReview(
			mirror,
			result.status,
			result.code,
			result.message || result.code,
			result,
			dependencies
		);
	}
	return { ...result, mirrorId: mirror._id };
}

module.exports = {
	MAX_CAS_ATTEMPTS,
	DEFAULT_ROOM_LIST_VERIFICATION_MAX_AGE_MS,
	allocateCents,
	applyActiveUpdate,
	applyCancellation,
	buildCreateReservationDocument,
	buildPickedRoomsProjection,
	candidateMatchesStrongIdentity,
	criticalOwnershipProjection,
	discoverAndResolveRoomMappings,
	establishMirrorLink,
	findLinkedReservation,
	hasFinanceOrSettlementActivity,
	hasHousingOrTerminalProtection,
	hotelRunnerCommercialProvider,
	hotelRunnerPricingBreakdown,
	isLocalTerminal,
	isEligibleCrossTransportHandoff,
	isPristinePendingOtaReview,
	localRootPriceCents,
	projectionFromIncoming,
	projectionFromReservation,
	projectHotelRunnerReservation,
	pmsWatermarkComparison,
	sourceOwnedProjectionAfterUpdate,
	sourceTimestampComparison,
};
