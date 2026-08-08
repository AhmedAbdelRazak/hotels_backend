/** @format */

process.env.SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "SG.test";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
	allocateCents,
	buildCreateReservationDocument,
	buildPickedRoomsProjection,
	candidateMatchesStrongIdentity,
	criticalOwnershipProjection,
	discoverAndResolveRoomMappings,
	findLinkedReservation,
	hasFinanceOrSettlementActivity,
	hasHousingOrTerminalProtection,
	hotelRunnerCommercialProvider,
	isLocalTerminal,
	localRootPriceCents,
	pmsWatermarkComparison,
	projectionFromIncoming,
	projectionFromReservation,
	projectHotelRunnerReservation,
	sourceTimestampComparison,
} = require("./hotelrunnerReservationAdapter");
const { normalizeHotelRunnerReservation } = require("./hotelrunnerPayload");
const { normalizedFromStoredEvent } = require("./hotelrunnerWorker");
const {
	hotelRunnerEmailCommercialEvidenceHash,
	validateReservationOtaIdentityConsistency,
} = require("./otaReservationMapper");
const {
	isOtaPlatformReviewPending,
	validateOtaPlatformReviewActionState,
} = require("./otaReservationVisibility");

const LOCAL_DOUBLE_ID = "64b000000000000000000101";
const LOCAL_TRIPLE_ID = "64b000000000000000000102";

const rawRoom = ({
	id,
	invCode,
	name,
	prices,
	adults = 2,
	children = 0,
}) => ({
	id,
	state: "confirmed",
	inv_code: invCode,
	rate_code: "BAR",
	rate_plan_code: "ROOM_ONLY",
	name,
	name_presentation: `${name} / Room Only`,
	checkin_date: "2026-08-10",
	checkout_date: "2026-08-12",
	nights: 2,
	total_guest: adults + children,
	total_adult: adults,
	child_ages: Array.from({ length: children }, () => 6),
	price: String(prices.reduce((sum, value) => sum + Number(value), 0)),
	total: String(prices.reduce((sum, value) => sum + Number(value), 0)),
	room_base_price: String(prices.reduce((sum, value) => sum + Number(value), 0)),
	room_sub_total: String(prices.reduce((sum, value) => sum + Number(value), 0)),
	extras_total: "0",
	fixed_adjustments_total: "0",
	included_taxes_total: "0",
	excluded_fees_and_taxes_total: "0",
	cancelation_refund_total: "0",
	cancelation_penalty_total: "0",
	promotions_total: "0",
	daily_prices: prices.map((price, index) => ({
		date: `2026-08-${10 + index}`,
		price,
		original_price: price,
		discount: "0",
		version: "v2",
	})),
});

const normalizedMultiRoom = (overrides = {}) => {
	const payload = {
		message_uid: "adapter-message-1",
		reservation_id: "hr-reservation-101",
		hr_number: "R-101",
		provider_number: "BOOKING-101",
		channel: "bookingcom",
		channel_display: "Booking.com",
		source_display: "Booking.com",
		state: "confirmed",
		modified: false,
		guest: "Projection Guest",
		country: "SA",
		address: {
			email: "projection@example.test",
			phone: "+966500000001",
			postal_code: "24231",
		},
		checkin_date: "2026-08-10",
		checkout_date: "2026-08-12",
		completed_at: "2026-08-06T10:00:00.000Z",
		updated_at: "2026-08-06T11:00:00.000Z",
		total_guests: 5,
		total_rooms: 2,
		sub_total: "100.01",
		extras_total: "0",
		adjustments_total: "0",
		item_total: "100.01",
		tax_total: "0",
		total: "100.01",
		currency: "SAR",
		payment: "OTA virtual card reported",
		paid_amount: "100.01",
		payments: [
			{
				id: "reported-payment-1",
				state: "paid",
				amount: "100.01",
				currency: "SAR",
				payment_method: "virtual_card",
			},
		],
		rooms: [
			rawRoom({
				id: "external-room-1",
				invCode: "INV-DOUBLE",
				name: "Double Room",
				prices: ["100", "200"],
			}),
			rawRoom({
				id: "external-room-2",
				invCode: "INV-TRIPLE",
				name: "Triple Room",
				prices: ["300", "400"],
				adults: 2,
				children: 1,
			}),
		],
		...overrides,
	};
	if (
		Object.prototype.hasOwnProperty.call(overrides, "state") &&
		!Object.prototype.hasOwnProperty.call(overrides, "rooms")
	) {
		payload.rooms = payload.rooms.map((room) => ({
			...room,
			state: overrides.state,
		}));
	}
	return normalizeHotelRunnerReservation(payload);
};

function resolvedRooms(normalized) {
	return [
		{
			sourceRoom: normalized.rooms[0],
			mapping: { invCode: "INV-DOUBLE", status: "active" },
			roomDetails: {
				_id: LOCAL_DOUBLE_ID,
				roomType: "doubleRooms",
				displayName: "Double Room – Comfort",
				defaultCost: 75,
				pricingRate: [
					{ calendarDate: "2026-08-10", rootPrice: "80" },
					{ calendarDate: "2026-08-11", rootPrice: "81" },
				],
			},
		},
		{
			sourceRoom: normalized.rooms[1],
			mapping: { invCode: "INV-TRIPLE", status: "active" },
			roomDetails: {
				_id: LOCAL_TRIPLE_ID,
				roomType: "tripleRooms",
				displayName: "Triple Room – Premium",
				defaultCost: 50,
				pricingRate: [],
			},
		},
	];
}

function queryResult(getValue) {
	const query = {
		select() {
			return this;
		},
		limit() {
			return this;
		},
		lean() {
			return this;
		},
		exec() {
			return Promise.resolve().then(getValue);
		},
		then(resolve, reject) {
			return Promise.resolve().then(getValue).then(resolve, reject);
		},
	};
	return query;
}

function syncStateModelFor(generation) {
	return {
		findOne() {
			return queryResult(() => ({
				activeRoomListSyncGeneration:
					typeof generation === "function" ? generation() : generation,
			}));
		},
	};
}

function setDotted(target, path, value) {
	const parts = String(path).split(".");
	let cursor = target;
	for (const part of parts.slice(0, -1)) {
		if (!cursor[part] || typeof cursor[part] !== "object") cursor[part] = {};
		cursor = cursor[part];
	}
	cursor[parts[parts.length - 1]] = value;
}

function applyMongoUpdate(target, update = {}) {
	for (const [path, value] of Object.entries(update.$set || {})) {
		setDotted(target, path, value);
	}
	for (const [path, value] of Object.entries(update.$inc || {})) {
		setDotted(target, path, Number(path.split(".").reduce(
			(current, part) => current?.[part],
			target
		) || 0) + Number(value || 0));
	}
	for (const [path, value] of Object.entries(update.$push || {})) {
		const parts = path.split(".");
		let cursor = target;
		for (const part of parts.slice(0, -1)) {
			if (!cursor[part] || typeof cursor[part] !== "object") cursor[part] = {};
			cursor = cursor[part];
		}
		const leaf = parts[parts.length - 1];
		if (!Array.isArray(cursor[leaf])) cursor[leaf] = [];
		cursor[leaf].push(value);
	}
	for (const [path, value] of Object.entries(update.$addToSet || {})) {
		if (value === undefined || value === null || value === "") continue;
		const current = target[path] || [];
		const values = value?.$each || [value];
		target[path] = [...current];
		for (const item of values) {
			if (!target[path].some((entry) => String(entry) === String(item))) {
				target[path].push(item);
			}
		}
	}
}

function createInMemoryProjectionSystem() {
	let mirror = null;
	const reservations = [];
	const mirrorWrites = [];
	const reservationWrites = [];
	const mappingWrites = [];
	let mirrorSequence = 0;

	const MirrorModel = {
		findOne(filter) {
			return queryResult(() =>
				mirror &&
				String(mirror.hotelId) === String(filter.hotelId) &&
				mirror.hotelRunnerReservationId === filter.hotelRunnerReservationId
					? mirror
					: null
			);
		},
		async create(document) {
			mirror = {
				_id: `mirror-${++mirrorSequence}`,
				reservationMongoId: null,
				projectionVersion: 0,
				appliedCanonicalHash: "",
				appliedSourceUpdatedAt: null,
				lastAppliedProjection: {},
				...document,
			};
			return {
				...mirror,
				toObject: () => mirror,
			};
		},
		updateOne(filter, update) {
			return queryResult(() => {
				mirrorWrites.push({ filter, update });
				if (mirror && (!filter._id || String(filter._id) === String(mirror._id))) {
					applyMongoUpdate(mirror, update);
				}
				return { matchedCount: mirror ? 1 : 0 };
			});
		},
		findById(id) {
			return queryResult(() =>
				mirror && String(mirror._id) === String(id) ? mirror : null
			);
		},
		findOneAndUpdate(filter, update) {
			return queryResult(() => {
				if (!mirror || (filter._id && String(filter._id) !== String(mirror._id))) {
					return null;
				}
				if (filter.reservationMongoId === null && mirror.reservationMongoId) {
					return null;
				}
				mirrorWrites.push({ filter, update });
				applyMongoUpdate(mirror, update);
				return mirror;
			});
		},
	};

	const ReservationModel = {
		findOne(filter) {
			return queryResult(() =>
				reservations.find(
					(reservation) =>
						String(reservation.hotelId) === String(filter.hotelId) &&
						reservation.supplierData?.hotelRunner?.reservationId ===
							filter["supplierData.hotelRunner.reservationId"]
				) || null
			);
		},
		find() {
			return queryResult(() => reservations);
		},
		findById(id) {
			return queryResult(
				() => reservations.find((reservation) => String(reservation._id) === String(id)) || null
			);
		},
		updateOne(filter, update) {
			return queryResult(() => {
				const reservation = reservations.find(
					(candidate) => !filter._id || String(candidate._id) === String(filter._id)
				);
				reservationWrites.push({ filter, update });
				if (!reservation) return { matchedCount: 0 };
				applyMongoUpdate(reservation, update);
				return { matchedCount: 1 };
			});
		},
	};

	const localRooms = [
		{
			_id: LOCAL_DOUBLE_ID,
			roomType: "doubleRooms",
			displayName: "Double Room – Comfort",
			activeRoom: true,
			defaultCost: 75,
			pricingRate: [
				{ calendarDate: "2026-08-10", rootPrice: "80" },
				{ calendarDate: "2026-08-11", rootPrice: "81" },
			],
		},
		{
			_id: LOCAL_TRIPLE_ID,
			roomType: "tripleRooms",
			displayName: "Triple Room – Premium",
			activeRoom: true,
			defaultCost: 50,
			pricingRate: [],
		},
	];
	const mappings = [
		{
			invCode: "INV-DOUBLE",
			status: "active",
			roomListVerifiedAt: new Date("2026-08-06T09:00:00.000Z"),
			roomListSyncGeneration: "synthetic-generation",
			roomListVerificationState: "verified",
			localRoomConfigId: LOCAL_DOUBLE_ID,
		},
		{
			invCode: "INV-TRIPLE",
			status: "active",
			roomListVerifiedAt: new Date("2026-08-06T09:00:00.000Z"),
			roomListSyncGeneration: "synthetic-generation",
			roomListVerificationState: "verified",
			localRoomConfigId: LOCAL_TRIPLE_ID,
		},
	];
	const MappingModel = {
		findOneAndUpdate(filter, update) {
			return queryResult(() => {
				mappingWrites.push({ filter, update });
				return mappings.find((mapping) => mapping.invCode === filter.invCode) || null;
			});
		},
		find() {
			return queryResult(() => mappings);
		},
	};
	const SyncStateModel = syncStateModelFor("synthetic-generation");

	return {
		MirrorModel,
		ReservationModel,
		MappingModel,
		reservations,
		mirrorWrites,
		reservationWrites,
		mappingWrites,
		hotel: {
			_id: "64b000000000000000000001",
			belongsTo: "64b000000000000000000002",
			hotelName: "Zad AJYAD Hotel",
			currency: "SAR",
			roomCountDetails: localRooms,
		},
		config: { hrIdFingerprint: "synthetic-property-fingerprint" },
		dependencies: {
			MirrorModel,
			ReservationModel,
			MappingModel,
			SyncStateModel,
			generateConfirmation: async () => "PMS-HR-SYNTHETIC-1",
			createWithSnapshot: async (document) => {
				reservations.push(document);
				return document;
			},
			validateInventory: async () => ({ issues: [] }),
			mappingNow: () => new Date("2026-08-06T12:00:00.000Z"),
		},
		get mirror() {
			return mirror;
		},
	};
}

function attachVerifiedHotelRunnerEmailCommercialEvidence(reservation) {
	const evidenceWithoutHash = {
		version: 1,
		verified: true,
		source: "authenticated_ota_email",
		provider: "booking",
		otaIdentityKey: "booking:booking-101",
		grossTotalSar: 100.01,
		payoutTotalSar: 85.01,
		otaExpenseTotalSar: 15,
		currency: "SAR",
		sourceReceivedAt: "2026-08-06T11:15:00.000Z",
		appliedAt: new Date("2026-08-06T11:16:00.000Z"),
	};
	const evidence = {
		...evidenceWithoutHash,
		evidenceHash: hotelRunnerEmailCommercialEvidenceHash(evidenceWithoutHash),
	};
	const paymentSummary = {
		sourceCurrency: "SAR",
		sourceTotalGuestPaymentAmount: 100.01,
		sourceTotalPayoutAmount: 85.01,
		totalGuestPaymentAmount: 100.01,
		totalPayoutAmount: 85.01,
		currency: "SAR",
		exchangeRateToSar: 1,
	};
	reservation.supplierData.hotelRunnerEmailCommercialEvidence = evidence;
	reservation.commission = 0;
	reservation.commission_ota = 15;
	reservation.supplierData.otaTotalPayoutSar = 85.01;
	reservation.supplierData.otaExpenseTotalSar = 15;
	reservation.supplierData.otaPayoutFallbackReason = "";
	reservation.supplierData.otaPaymentSummary = paymentSummary;
	reservation.adminPricing.clientTotal = 100.01;
	reservation.adminPricing.netAfterExpensesTotal = 85.01;
	reservation.adminPricing.otaExpenseTotal = 15;
	reservation.adminPricing.defaultDeductionApplied = false;
	reservation.adminPricing.payoutFallbackReason = "";
	reservation.adminPricing.commercialVerified = true;
	reservation.ota_financial_summary.clientTotal = 100.01;
	reservation.ota_financial_summary.netAfterExpenses = 85.01;
	reservation.ota_financial_summary.netAfterOtaExpenses = 85.01;
	reservation.ota_financial_summary.otaExpenseTotal = 15;
	reservation.ota_financial_summary.payoutFallbackReason = "";
	reservation.ota_financial_summary.paymentSummary = paymentSummary;
	reservation.ota_financial_summary.commercialVerified = true;
	reservation.ota_financial_summary.show = true;
	return evidence;
}

test("cent allocation is deterministic, weighted, and preserves the exact total", () => {
	assert.deepEqual(allocateCents(10001, [100, 200, 300, 400]), [1001, 2000, 3000, 4000]);
	assert.equal(
		allocateCents(10001, [100, 200, 300, 400]).reduce(
			(sum, amount) => sum + amount,
			0
		),
		10001
	);
	assert.deepEqual(allocateCents(5, [1, 1]), [3, 2]);
	assert.deepEqual(allocateCents(3, [0, -1, "bad"]), [1, 1, 1]);
	assert.deepEqual(allocateCents(-1, [1]), []);
	assert.deepEqual(allocateCents(100, []), []);
});

test("local root pricing uses the exact date, preserves zero fallback, and never uses OTA price", () => {
	const room = {
		defaultCost: "70.00",
		pricingRate: [
			{ calendarDate: "2026-08-10", rootPrice: "80.25", price: "999" },
			{ calendarDate: "2026-08-11", rootPrice: "", price: "81.50" },
		],
	};
	assert.equal(localRootPriceCents(room, "2026-08-10"), 8025);
	assert.equal(localRootPriceCents(room, "2026-08-11"), 8150);
	assert.equal(localRootPriceCents(room, "2026-08-12"), 7000);
	assert.equal(localRootPriceCents({ defaultCost: 0 }, "2026-08-12"), 0);
});

test("multi-room projection uses explicit local mappings and allocates the client total exactly", () => {
	const normalized = normalizedMultiRoom();
	assert.deepEqual(normalized.issues, []);
	const pricing = buildPickedRoomsProjection(
		normalized,
		resolvedRooms(normalized)
	);

	assert.equal(pricing.ok, true);
	assert.equal(pricing.clientTotal, 100.01);
	assert.equal(pricing.rootTotal, 261);
	assert.equal(pricing.pickedRooms.length, 2);
	assert.deepEqual(
		pricing.pickedRooms.map((room) => [
			String(room.hotelRoomConfigId),
			room.hotelRunnerInvCode,
			room.count,
		]),
		[
			[LOCAL_DOUBLE_ID, "INV-DOUBLE", 1],
			[LOCAL_TRIPLE_ID, "INV-TRIPLE", 1],
		]
	);
	assert.deepEqual(
		pricing.pickedRooms.flatMap((room) =>
			room.pricingByDay.map((day) => day.totalPriceWithCommission)
		),
		[10.01, 20, 30, 40]
	);
	assert.equal(
		pricing.pickedRooms.reduce(
			(sum, room) => sum + room.totalPriceWithCommission,
			0
		),
		100.01
	);
	assert.deepEqual(
		pricing.pickedRooms[0].pricingByDay.map((day) => day.rootPrice),
		[80, 81]
	);
	assert.deepEqual(
		pricing.pickedRooms[1].pricingByDay.map((day) => day.rootPrice),
		[50, 50]
	);
});

test("an existing PMS-owned root price is preserved across HotelRunner projection updates", () => {
	const normalized = normalizedMultiRoom();
	const existing = {
		pickedRoomsType: [
			{
				hotelRunnerRoomId: "external-room-1",
				hotelRoomConfigId: LOCAL_DOUBLE_ID,
				pricingByDay: [
					{ date: "2026-08-10", rootPrice: 99 },
					{ date: "2026-08-11", rootPrice: 98 },
				],
			},
		],
	};
	const pricing = buildPickedRoomsProjection(
		normalized,
		resolvedRooms(normalized),
		existing
	);

	assert.equal(pricing.rootTotal, 297);
	assert.deepEqual(
		pricing.pickedRooms[0].pricingByDay.map((day) => day.rootPrice),
		[99, 98]
	);
});

test("a projection with an unusable total fails closed instead of inventing prices", () => {
	const normalized = normalizedMultiRoom();
	normalized.totalCents = null;
	assert.deepEqual(
		buildPickedRoomsProjection(normalized, resolvedRooms(normalized)),
		{ ok: false, code: "hotelrunner_pricing_allocation_failed" }
	);
});

test("new PMS documents keep HotelRunner-reported payments informational and locally unpaid", () => {
	const normalized = normalizedMultiRoom();
	const pricing = buildPickedRoomsProjection(
		normalized,
		resolvedRooms(normalized)
	);
	const document = buildCreateReservationDocument({
		normalized,
		event: { _id: "event-1" },
		hotel: {
			_id: "64b000000000000000000001",
			belongsTo: "64b000000000000000000002",
			currency: "SAR",
		},
		pricing,
		confirmationNumber: "PMS-HR-000001",
		reservationMongoId: "64b000000000000000000003",
	});

	assert.equal(document.state, "confirmed");
	assert.equal(document.reservation_status, "confirmed");
	assert.equal(document.confirmation_number, "PMS-HR-000001");
	assert.equal(document.pms_number, "PMS-HR-000001");
	assert.equal(document.reservation_id, "BOOKING-101");
	assert.equal(document.otaIdentityKey, "booking:booking-101");
	assert.equal(document.otaCrossTransportIdentityKey, undefined);
	assert.equal(document.total_rooms, 2);
	assert.equal(document.total_amount, 100.01);
	assert.equal(document.financeStatus, "not paid");
	assert.equal(document.paid_amount, 0);
	assert.equal(document.payment_details.captured, false);
	assert.equal(document.payment_details.onsite_paid_amount, 0);
	assert.equal(document.commission, 0);
	assert.equal(document.commission_ota, null);
	assert.equal(document.moneyTransferredToHotel, undefined);
	assert.equal(document.commissionPaid, undefined);
	assert.equal(document.vcc_payment, undefined);
	assert.equal(document.bofa_payment, undefined);
	assert.equal(document.supplierData.hotelRunner.reportedPaidAmount, 100.01);
	assert.equal(
		document.supplierData.hotelRunner.reportedPaidAmountCurrency,
		"SAR"
	);
	assert.equal(document.supplierData.hotelRunner.transport, "hotelrunner_api");
	assert.deepEqual(
		{
			subTotal: document.supplierData.hotelRunner.pricing.subTotal,
			extrasTotal: document.supplierData.hotelRunner.pricing.extrasTotal,
			adjustmentsTotal:
				document.supplierData.hotelRunner.pricing.adjustmentsTotal,
			itemTotal: document.supplierData.hotelRunner.pricing.itemTotal,
			taxTotal: document.supplierData.hotelRunner.pricing.taxTotal,
			grandTotal: document.supplierData.hotelRunner.pricing.grandTotal,
			paidAmount: document.supplierData.hotelRunner.pricing.paidAmount,
		},
		{
			subTotal: 100.01,
			extrasTotal: 0,
			adjustmentsTotal: 0,
			itemTotal: 100.01,
			taxTotal: 0,
			grandTotal: 100.01,
			paidAmount: 100.01,
		}
	);
	assert.equal(
		document.supplierData.hotelRunner.pricing.hotelNetStatus,
		"not_provided_by_hotelrunner"
	);
	assert.equal(document.supplierData.hotelRunner.pricing.hotelNetPayout, null);
	assert.equal(document.supplierData.hotelRunner.pricing.otaCommission, null);
	assert.equal(
		document.supplierData.hotelRunner.pricing.rooms[0].nightly[0].version,
		"v2"
	);
	assert.equal(
		document.supplierData.hotelRunner.pricing.reconciliation
			.roomTotalsMatchGrandTotal,
		false
	);
	assert.equal(document.supplierData.otaSourceAuthority, 4);
	assert.equal(document.supplierData.otaProvider, "booking");
	assert.equal(
		document.supplierData.otaAutomationPipeline,
		"hotelrunner-background-worker"
	);
	assert.equal(document.ota_financial_summary.show, false);
	assert.equal(document.ota_financial_summary.commercialVerified, false);
	assert.equal(document.ota_financial_summary.netAfterExpenses, null);
	assert.equal(document.ota_financial_summary.otaExpenseTotal, null);
	assert.equal(document.ota_financial_summary.platformProfit, null);
	assert.equal(document.adminPricing.commercialVerified, false);
	assert.equal(document.adminPricing.netAfterExpensesTotal, null);
	assert.equal(document.adminPricing.otaExpenseTotal, null);
	assert.equal(document.adminPricing.platformMarginTotal, null);
	assert.equal(
		document.adminPricing.payoutFallbackReason,
		"hotelrunner_payout_not_provided"
	);
	assert.equal(
		document.ota_financial_summary.payoutFallbackReason,
		"hotelrunner_payout_not_provided"
	);
	assert.equal(
		document.supplierData.otaPayoutFallbackReason,
		"hotelrunner_payout_not_provided"
	);
	assert.ok(
		document.pickedRoomsType.every((room) =>
			room.pricingByDay.every(
				(day) =>
					day.netAfterExpenses === null &&
					day.otaExpenseAmount === null &&
					day.platformMargin === null
			)
		)
	);
	assert.equal(
		document.supplierData.hotelRunner.pricing.payments[0].id,
		"reported-payment-1"
	);
	assert.equal(document.supplierData.hotelRunner.pricing.payments[0].amount, 100.01);
	assert.deepEqual(
		validateReservationOtaIdentityConsistency(
			document,
			normalized.providerNumber,
			"booking"
		),
		{ valid: true, reason: "" },
		"an API-first reservation must be selectable by the existing email pipeline"
	);
});

test("review mode uses the existing canonical OTA review lifecycle with HotelRunner metadata", () => {
	const normalized = normalizedMultiRoom();
	const pricing = buildPickedRoomsProjection(
		normalized,
		resolvedRooms(normalized)
	);
	const document = buildCreateReservationDocument({
		normalized,
		event: { _id: "event-review-mode" },
		hotel: {
			_id: "64b000000000000000000001",
			belongsTo: "64b000000000000000000002",
			hotelName: "Zad AJYAD Hotel",
			currency: "SAR",
		},
		pricing,
		confirmationNumber: "PMS-HR-REVIEW-1",
		reservationMongoId: "64b000000000000000000003",
		config: { requireOtaReview: true },
	});

	assert.equal(document.state, "OTA Platform Review");
	assert.equal(document.reservation_status, "OTA Platform Review");
	assert.equal(document.pendingConfirmation, undefined);
	assert.equal(document.otaPlatformReview.status, "pending");
	assert.equal(document.otaPlatformReview.source, "hotelrunner_api");
	assert.equal(document.otaPlatformReview.hotelRunnerManaged, true);
	assert.equal(document.otaPlatformReview.provider, "booking");
	assert.equal(document.otaPlatformReview.confirmationNumber, "BOOKING-101");
	assert.equal(document.otaPlatformReview.hotelAssignmentRequired, false);
	assert.equal(document.otaPlatformReview.hotelAssignmentStatus, "assigned");
	assert.equal(
		document.otaPlatformReview.assignedHotelId,
		"64b000000000000000000001"
	);
	assert.equal(document.otaPlatformReview.roomMappingStatus, "mapped");
	assert.equal(document.adminPricingVisibility.rootOnlyForHotelManagement, true);
	assert.equal(document.adminPricingVisibility.source, "hotelrunner_api");
	assert.equal(isOtaPlatformReviewPending(document), true);
	assert.deepEqual(validateOtaPlatformReviewActionState(document), {
		ready: true,
	});
	assert.equal(
		document.supplierData.hotelRunner.transport,
		"hotelrunner_api"
	);
});

test("HotelRunner create surfaces the durable overbooking snapshot as attention data", async () => {
	const system = createInMemoryProjectionSystem();
	const normalized = normalizedMultiRoom({
		message_uid: "adapter-create-overbooking-attention",
	});
	system.dependencies.createWithSnapshot = async (document) => {
		document.availabilitySnapshot = {
			overbooked: true,
			issueCount: 1,
			rooms: [
				{
					room_type: "doubleRooms",
					displayName: "Double Room",
					requested: 1,
					capacity: 1,
					days: [
						{
							date: "2026-08-10",
							capacity: 1,
							reservedBefore: 1,
							requested: 1,
							availableAfterRaw: -1,
						},
					],
				},
			],
		};
		system.reservations.push(document);
		return document;
	};

	const result = await projectHotelRunnerReservation(
		{
			normalized,
			event: { payload: normalized.storedPayload },
			hotel: system.hotel,
			config: system.config,
		},
		system.dependencies
	);

	assert.equal(result.status, "created");
	assert.equal(result.inventoryIssueCount, 1);
	assert.deepEqual(result.inventorySummary, {
		overbooked: true,
		issueCount: 1,
		issues: [
			{
				code: "inventory_overbook",
				date: "2026-08-10",
				roomType: "doubleRooms",
				displayName: "Double Room",
				capacity: 1,
				reserved: 1,
				requested: 1,
			},
		],
	});
	assert.equal(system.mirror.lastResult.inventoryIssueCount, 1);
	assert.equal(system.mirror.lastResult.inventorySummary.overbooked, true);
});

test("automatic creation requires one deterministic identity shared with email ingestion", async () => {
	for (const overrides of [
		{
			message_uid: "missing-all-shared-aliases",
			provider_number: null,
			hr_number: null,
		},
		{
			message_uid: "relayed-ota-missing-provider-number",
			provider_number: null,
			channel: "bookingcom",
			channel_display: "Booking.com",
			source_display: "Booking.com",
		},
		{
			message_uid: "unrecognized-provider-namespace",
			provider_number: null,
			channel: "online",
			channel_display: "Online",
			source_display: "Online",
		},
	]) {
		const system = createInMemoryProjectionSystem();
		const normalized = normalizedMultiRoom(overrides);
		const result = await projectHotelRunnerReservation(
			{
				normalized,
				event: { payload: normalized.storedPayload },
				hotel: system.hotel,
				config: system.config,
			},
			system.dependencies
		);
		assert.equal(result.status, "quarantined");
		assert.equal(result.code, "hotelrunner_shared_identity_required");
		assert.equal(system.reservations.length, 0);
		assert.equal(system.reservationWrites.length, 0);
		assert.equal(system.mappingWrites.length, 0);
		assert.equal(system.mirror.projectionStatus, "quarantined");
	}
});

test("verified Trip API reservations claim the existing cross-transport unique key", () => {
	const normalized = normalizedMultiRoom({
		provider_number: "TRIP-777",
		channel: "tripcom",
		channel_display: "Trip.com",
		source_display: "Trip.com",
	});
	const pricing = buildPickedRoomsProjection(
		normalized,
		resolvedRooms(normalized)
	);
	const document = buildCreateReservationDocument({
		normalized,
		event: { _id: "event-trip-identity" },
		hotel: {
			_id: "64b000000000000000000001",
			belongsTo: "64b000000000000000000002",
			currency: "SAR",
		},
		pricing,
		confirmationNumber: "PMS-HR-TRIP-1",
		reservationMongoId: "64b000000000000000000003",
	});
	assert.equal(document.otaIdentityKey, "trip:trip-777");
	assert.equal(document.otaCrossTransportIdentityKey, "trip:trip-777");
});

test("reserved bookings block inventory locally until HotelRunner confirms them", async () => {
	const system = createInMemoryProjectionSystem();
	const reserved = normalizedMultiRoom({
		state: "reserved",
		requires_response: true,
		next_states: ["confirm", "cancel"],
	});
	const created = await projectHotelRunnerReservation(
		{
			normalized: reserved,
			event: { payload: reserved.storedPayload },
			hotel: system.hotel,
			config: system.config,
		},
		system.dependencies
	);
	assert.equal(created.status, "created");
	assert.equal(system.reservations[0].state, "Pending Confirmation");
	assert.equal(system.reservations[0].reservation_status, "Pending Confirmation");
	assert.equal(system.reservations[0].pendingConfirmation.status, "pending");
	assert.equal(system.reservations[0].pendingConfirmation.inventoryBlocks, true);
	assert.equal(system.reservations[0].pendingConfirmation.requiresResponse, true);
	assert.deepEqual(system.reservations[0].pendingConfirmation.nextStates, [
		"confirm",
		"cancel",
	]);

	const confirmed = normalizedMultiRoom({
		message_uid: "adapter-reserved-confirmed-2",
		state: "confirmed",
		modified: true,
		requires_response: false,
		next_states: ["cancel"],
		updated_at: "2026-08-06T12:00:00.000Z",
	});
	const updated = await projectHotelRunnerReservation(
		{
			normalized: confirmed,
			event: { payload: confirmed.storedPayload },
			hotel: system.hotel,
			config: system.config,
		},
		system.dependencies
	);
	assert.equal(updated.status, "updated");
	assert.equal(system.reservations[0].state, "confirmed");
	assert.equal(system.reservations[0].reservation_status, "confirmed");
	assert.equal(system.reservations[0].pendingConfirmation.status, "confirmed");
	assert.equal(
		system.reservations[0].pendingConfirmation.confirmationReason,
		"confirmed_by_hotelrunner"
	);
	assert.equal(
		system.reservations[0].supplierData.hotelRunner.sourceState,
		"confirmed"
	);

	const lateReserved = normalizedMultiRoom({
		message_uid: "adapter-reserved-late-3",
		state: "reserved",
		modified: true,
		requires_response: true,
		updated_at: "2026-08-06T13:00:00.000Z",
	});
	await projectHotelRunnerReservation(
		{
			normalized: lateReserved,
			event: { payload: lateReserved.storedPayload },
			hotel: system.hotel,
			config: system.config,
		},
		system.dependencies
	);
	assert.equal(
		system.reservations[0].state,
		"confirmed",
		"a later reserved delivery must not downgrade an already confirmed local lifecycle"
	);
});

test("review mode routes a HotelRunner reserved-to-confirmed transition into OTA review", async () => {
	const system = createInMemoryProjectionSystem();
	system.config.requireOtaReview = true;
	const reserved = normalizedMultiRoom({
		message_uid: "review-mode-reserved-1",
		state: "reserved",
		requires_response: true,
		updated_at: "2026-08-06T11:00:00.000Z",
	});
	assert.equal(
		(
			await projectHotelRunnerReservation(
				{
					normalized: reserved,
					event: { payload: reserved.storedPayload },
					hotel: system.hotel,
					config: system.config,
				},
				system.dependencies
			)
		).status,
		"created"
	);
	assert.equal(system.reservations[0].state, "Pending Confirmation");

	const confirmed = normalizedMultiRoom({
		message_uid: "review-mode-reserved-confirmed-2",
		state: "confirmed",
		modified: true,
		updated_at: "2026-08-06T12:00:00.000Z",
	});
	const result = await projectHotelRunnerReservation(
		{
			normalized: confirmed,
			event: { payload: confirmed.storedPayload },
			hotel: system.hotel,
			config: system.config,
		},
		system.dependencies
	);
	assert.equal(result.status, "updated");
	assert.equal(system.reservations.length, 1);
	assert.equal(system.reservations[0].state, "OTA Platform Review");
	assert.equal(system.reservations[0].reservation_status, "OTA Platform Review");
	assert.equal(system.reservations[0].otaPlatformReview.status, "pending");
	assert.equal(system.reservations[0].otaPlatformReview.source, "hotelrunner_api");
});

test("authoritative HotelRunner confirmation upgrades an untouched email-ingested pending match", async () => {
	const system = createInMemoryProjectionSystem();
	const normalized = normalizedMultiRoom({
		message_uid: "adapter-cross-transport-confirmed",
		state: "confirmed",
		updated_at: "2026-08-06T12:00:00.000Z",
	});
	const pricing = buildPickedRoomsProjection(normalized, resolvedRooms(normalized));
	const existing = buildCreateReservationDocument({
		normalized,
		event: { _id: "email-event" },
		hotel: system.hotel,
		pricing,
		confirmationNumber: "PMS-EMAIL-SYNTHETIC-1",
		reservationMongoId: "64b000000000000000000099",
	});
	existing.reservation_id = normalized.providerNumber;
	existing.otaIdentityKey = `booking:${normalized.providerNumber}`;
	existing.state = "Pending Confirmation";
	existing.reservation_status = "Pending Confirmation";
	existing.pendingConfirmation = {
		status: "pending",
		source: "ota_platform_release",
		inventoryBlocks: true,
		lastUpdatedBy: null,
	};
	existing.supplierData.otaAutomationPipeline = "ota-email-orchestrator";
	existing.supplierData.otaProvider = "booking";
	existing.supplierData.otaSourceAuthority = 1;
	delete existing.supplierData.hotelRunner;
	system.reservations.push(existing);

	const result = await projectHotelRunnerReservation(
		{
			normalized,
			event: { payload: normalized.storedPayload },
			hotel: system.hotel,
			config: system.config,
		},
		system.dependencies
	);
	assert.equal(result.status, "updated");
	assert.equal(system.reservations.length, 1);
	assert.equal(system.reservations[0].state, "confirmed");
	assert.equal(system.reservations[0].reservation_status, "confirmed");
	assert.equal(system.reservations[0].pendingConfirmation.status, "confirmed");
	assert.equal(
		system.reservations[0].supplierData.hotelRunner.reservationId,
		normalized.hotelRunnerReservationId
	);
	assert.equal(system.reservations[0].supplierData.otaSourceAuthority, 4);
	assert.equal(
		system.reservations[0].supplierData.otaAutomationPipeline,
		"hotelrunner-background-worker"
	);
	assert.equal(system.reservations[0].supplierData.otaProvider, "booking");
});

test("review mode links an email-first OTA review without releasing or duplicating it", async () => {
	const system = createInMemoryProjectionSystem();
	system.config.requireOtaReview = true;
	const normalized = normalizedMultiRoom({
		message_uid: "adapter-email-first-review-link",
		state: "confirmed",
		updated_at: "2026-08-06T12:00:00.000Z",
	});
	const pricing = buildPickedRoomsProjection(normalized, resolvedRooms(normalized));
	const existing = buildCreateReservationDocument({
		normalized,
		event: { _id: "email-first-review-event" },
		hotel: system.hotel,
		pricing,
		confirmationNumber: "PMS-EMAIL-REVIEW-1",
		reservationMongoId: "64b000000000000000000099",
		config: { requireOtaReview: true },
	});
	existing.otaPlatformReview = {
		...existing.otaPlatformReview,
		source: "ota_email_create",
		inboundEmailId: "64b000000000000000000098",
		hotelRunnerManaged: false,
		hotelRunnerLinkedAt: null,
		lastHotelRunnerUpdatedAt: null,
		roomMappingStatus: "unreviewed",
		roomMappingHotelId: "",
	};
	existing.adminPricingVisibility.source = "ota_email_create";
	existing.supplierData.otaAutomationPipeline = "ota-email-orchestrator";
	existing.supplierData.otaSourceAuthority = 1;
	delete existing.supplierData.hotelRunner;
	system.reservations.push(existing);

	const result = await projectHotelRunnerReservation(
		{
			normalized,
			event: { payload: normalized.storedPayload },
			hotel: system.hotel,
			config: system.config,
		},
		system.dependencies
	);

	assert.equal(result.status, "updated");
	assert.equal(system.reservations.length, 1);
	assert.equal(String(system.reservations[0]._id), String(existing._id));
	assert.equal(system.reservations[0].state, "OTA Platform Review");
	assert.equal(system.reservations[0].reservation_status, "OTA Platform Review");
	assert.equal(system.reservations[0].otaPlatformReview.status, "pending");
	assert.equal(
		system.reservations[0].otaPlatformReview.source,
		"ota_email_create",
		"the original email-review provenance remains auditable"
	);
	assert.equal(system.reservations[0].otaPlatformReview.hotelRunnerManaged, true);
	assert.equal(
		system.reservations[0].supplierData.hotelRunner.reservationId,
		normalized.hotelRunnerReservationId
	);
	assert.equal(
		system.reservations[0].supplierData.otaAutomationPipeline,
		"hotelrunner-background-worker"
	);
	assert.equal(system.reservations[0].commission, 0);
	assert.equal(system.reservations[0].commission_ota, null);
});

test("Trip source-currency API lifecycle claims one email reservation without inventing OTA commission", async () => {
	const system = createInMemoryProjectionSystem();
	system.config.requireOtaReview = true;
	const providerNumber = "1539366616295913";
	const normalized = normalizedMultiRoom({
		message_uid: "adapter-trip-usd-email-bridge",
		provider_number: providerNumber,
		channel: "tripcom",
		channel_display: "Trip.com",
		source_display: "Trip.com",
		currency: "USD",
		sub_total: "18.78",
		item_total: "18.78",
		total: "18.78",
		paid_amount: "0",
		updated_at: "2026-08-06T12:00:00.000Z",
	});
	const pricing = buildPickedRoomsProjection(normalized, resolvedRooms(normalized));
	const existing = buildCreateReservationDocument({
		normalized,
		event: { _id: "trip-email-event" },
		hotel: system.hotel,
		pricing,
		confirmationNumber: "PMS-TRIP-EMAIL-1",
		reservationMongoId: "64b000000000000000000099",
		config: { requireOtaReview: true },
	});
	existing.total_amount = 70.43;
	existing.currency = "SAR";
	existing.adminPricing.clientTotal = 70.43;
	existing.adminPricing.sourceCurrency = "USD";
	existing.adminPricing.sourceAmount = 18.78;
	existing.ota_financial_summary.clientTotal = 70.43;
	existing.ota_financial_summary.currency = "SAR";
	existing.otaIdentityKey = `hotelrunner:${providerNumber}`;
	existing.otaCrossTransportIdentityKey = `trip:${providerNumber}`;
	existing.reservation_id = providerNumber;
	existing.supplierData.otaProvider = "trip";
	existing.supplierData.otaAutomationPipeline = "ota-email-orchestrator";
	existing.supplierData.otaSourceAuthority = 1;
	existing.supplierData.otaLastInboundEmailId =
		"64b000000000000000000098";
	existing.supplierData.otaLastSourceReceivedAt =
		new Date("2026-08-06T11:55:00.000Z");
	existing.commission = 15;
	delete existing.supplierData.hotelRunner;
	system.reservations.push(existing);
	system.dependencies.loadEmailCommercialBridge = async () => ({
		ok: true,
		reason: "",
		amountRole: "gross",
		grossTotalSar: 70.43,
		sourceCurrency: "USD",
		sourceAmount: 18.78,
		hotelRunnerAmount: 18.78,
		evidence: null,
	});

	const result = await projectHotelRunnerReservation(
		{
			normalized,
			event: { payload: normalized.storedPayload },
			hotel: system.hotel,
			config: system.config,
		},
		system.dependencies
	);

	assert.equal(result.status, "updated");
	assert.equal(system.reservations.length, 1);
	assert.equal(String(system.reservations[0]._id), String(existing._id));
	assert.equal(system.reservations[0].total_amount, 70.43);
	assert.equal(system.reservations[0].currency, "SAR");
	assert.equal(system.reservations[0].commission, 0);
	assert.equal(system.reservations[0].commission_ota, null);
	assert.equal(system.reservations[0].state, "OTA Platform Review");
	assert.equal(
		system.reservations[0].supplierData.hotelRunner.transport,
		"hotelrunner_api"
	);
});

test("cross-currency API event waits visibly for its email identity bridge instead of creating a second reservation", async () => {
	const system = createInMemoryProjectionSystem();
	const normalized = normalizedMultiRoom({
		message_uid: "adapter-trip-usd-waits-for-email",
		provider_number: "1539366616295999",
		channel: "tripcom",
		channel_display: "Trip.com",
		source_display: "Trip.com",
		currency: "USD",
		sub_total: "18.78",
		item_total: "18.78",
		total: "18.78",
		paid_amount: "0",
	});
	const result = await projectHotelRunnerReservation(
		{
			normalized,
			event: { payload: normalized.storedPayload },
			hotel: system.hotel,
			config: system.config,
		},
		system.dependencies
	);
	assert.equal(result.status, "retry");
	assert.equal(result.code, "hotelrunner_currency_waiting_for_email_bridge");
	assert.equal(system.reservations.length, 0);
	assert.equal(system.reservationWrites.length, 0);
	assert.equal(system.mappingWrites.length, 0);
});

test("verified Agoda email pricing enriches the one API-owned reservation and keeps raw API pricing", async () => {
	const system = createInMemoryProjectionSystem();
	system.config.requireOtaReview = true;
	const normalized = normalizedMultiRoom({
		message_uid: "adapter-agoda-payout-email-bridge",
		provider_number: "687268443",
		channel: "agoda",
		channel_display: "Agoda",
		source_display: "Agoda",
		sub_total: "58.82",
		item_total: "58.82",
		total: "58.82",
		paid_amount: "0",
		updated_at: "2026-08-06T12:00:00.000Z",
	});
	const pricing = buildPickedRoomsProjection(normalized, resolvedRooms(normalized));
	const existing = buildCreateReservationDocument({
		normalized,
		event: { _id: "agoda-email-event" },
		hotel: system.hotel,
		pricing,
		confirmationNumber: "PMS-AGODA-EMAIL-1",
		reservationMongoId: "64b000000000000000000097",
		config: { requireOtaReview: true },
	});
	existing.total_amount = 95.06;
	existing.adminPricing.clientTotal = 95.06;
	existing.adminPricing.netAfterExpensesTotal = 58.82;
	existing.adminPricing.otaExpenseTotal = 36.24;
	existing.adminPricing.defaultDeductionApplied = false;
	existing.adminPricing.commercialVerified = false;
	existing.adminPricing.payoutFallbackReason =
		"hotelrunner_commercial_evidence_stale";
	existing.ota_financial_summary.clientTotal = 95.06;
	existing.ota_financial_summary.netAfterExpenses = 58.82;
	existing.ota_financial_summary.netAfterOtaExpenses = 58.82;
	existing.ota_financial_summary.otaExpenseTotal = 36.24;
	existing.ota_financial_summary.commercialVerified = false;
	existing.ota_financial_summary.payoutFallbackReason =
		"hotelrunner_commercial_evidence_stale";
	existing.supplierData.otaProvider = "agoda";
	existing.supplierData.otaAutomationPipeline = "ota-email-orchestrator";
	existing.supplierData.otaSourceAuthority = 1;
	existing.supplierData.otaLastSourceReceivedAt =
		new Date("2026-08-06T11:55:00.000Z");
	existing.commission = 15;
	delete existing.supplierData.hotelRunner;
	system.reservations.push(existing);
	const evidenceWithoutHash = {
		version: 2,
		verified: true,
		source: "authenticated_ota_email",
		provider: "agoda",
		otaIdentityKey: "agoda:687268443",
		grossTotalSar: 95.06,
		payoutTotalSar: 58.82,
		otaExpenseTotalSar: 36.24,
		otaCommissionSar: 14.26,
		deductionComponents: [
			{
				type: "commission",
				label: "Commission",
				amountSar: 14.26,
				currency: "SAR",
				source: "authenticated_agoda_email",
			},
			{
				type: "growth_program",
				label: "Agoda Growth Program",
				amountSar: 9.51,
				currency: "SAR",
				source: "authenticated_agoda_email",
			},
			{
				type: "tax_on_commission",
				label: "Tax on Commission",
				amountSar: 3.57,
				currency: "SAR",
				source: "authenticated_agoda_email",
			},
		],
		unclassifiedDeductionSar: 8.9,
		unpricedDeductionLabels: ["Targeted promotions"],
		currency: "SAR",
		inboundEmailId: "64b000000000000000000098",
		sourceTextHash: "a".repeat(64),
		sourceReceivedAt: "2026-08-06T11:55:00.000Z",
		appliedAt: new Date("2026-08-06T11:56:00.000Z"),
	};
	const evidence = {
		...evidenceWithoutHash,
		evidenceHash: hotelRunnerEmailCommercialEvidenceHash(evidenceWithoutHash),
	};
	system.dependencies.loadEmailCommercialBridge = async () => ({
		ok: true,
		reason: "",
		amountRole: "payout",
		grossTotalSar: 95.06,
		sourceCurrency: "SAR",
		sourceAmount: 95.06,
		hotelRunnerAmount: 58.82,
		evidence,
	});

	const result = await projectHotelRunnerReservation(
		{
			normalized,
			event: { payload: normalized.storedPayload },
			hotel: system.hotel,
			config: system.config,
		},
		system.dependencies
	);

	assert.equal(result.status, "updated");
	assert.equal(system.reservations.length, 1);
	assert.equal(system.reservations[0].total_amount, 95.06);
	assert.equal(system.reservations[0].commission, 0);
	assert.equal(system.reservations[0].commission_ota, 14.26);
	assert.equal(system.reservations[0].supplierData.otaExpenseTotalSar, 36.24);
	assert.equal(system.reservations[0].supplierData.otaCommissionSar, 14.26);
	assert.equal(
		system.reservations[0].ota_financial_summary.unclassifiedOtaDeduction,
		8.9
	);
	assert.equal(system.reservations[0].adminPricing.commercialVerified, true);
	assert.equal(
		system.reservations[0].supplierData.hotelRunner.pricing.grandTotal,
		58.82
	);
	assert.equal(
		system.reservations[0].supplierData.hotelRunnerEmailCommercialEvidence
			.evidenceHash,
		evidence.evidenceHash
	);
});

test("concurrent email and HotelRunner creates converge through the unique OTA identity", async () => {
	const system = createInMemoryProjectionSystem();
	const normalized = normalizedMultiRoom({
		message_uid: "adapter-concurrent-cross-transport-create",
		provider_number: "BOOKING-CONCURRENT-101",
	});
	const sharedAlias = normalized.providerNumber;
	let insertedEmailWinner = false;
	system.dependencies.createWithSnapshot = async (document) => {
		if (insertedEmailWinner) {
			assert.fail("a relinked retry must update the winner, not create again");
		}
		assert.equal(document.otaIdentityKey, `booking:${sharedAlias.toLowerCase()}`);
		assert.equal(document.reservation_id, sharedAlias);
		insertedEmailWinner = true;
		const emailWinner = {
			...document,
			_id: "64b000000000000000000099",
			reservation_id: sharedAlias,
			supplierData: {
				...document.supplierData,
				otaAutomationPipeline: "ota-email-orchestrator",
				otaProvider: "booking",
				otaSourceAuthority: 1,
			},
		};
		delete emailWinner.supplierData.hotelRunner;
		system.reservations.push(emailWinner);
		const duplicate = new Error("synthetic cross-transport unique collision");
		duplicate.code = 11000;
		throw duplicate;
	};

	const first = await projectHotelRunnerReservation(
		{
			normalized,
			event: { payload: normalized.storedPayload },
			hotel: system.hotel,
			config: system.config,
		},
		system.dependencies
	);
	assert.equal(first.status, "retry");
	assert.equal(first.code, "hotelrunner_cross_transport_create_race_relinked");
	assert.equal(system.reservations.length, 1);
	assert.equal(
		String(system.mirror.reservationMongoId),
		"64b000000000000000000099"
	);

	const converged = await projectHotelRunnerReservation(
		{
			normalized,
			event: { payload: normalized.storedPayload },
			hotel: system.hotel,
			config: system.config,
		},
		system.dependencies
	);
	assert.equal(converged.status, "updated");
	assert.equal(system.reservations.length, 1);
	assert.equal(
		system.reservations[0].supplierData.hotelRunner.reservationId,
		normalized.hotelRunnerReservationId
	);
});

test("HotelRunner master fallback room mappings are never projection-safe", async () => {
	const normalized = normalizedMultiRoom({
		rooms: [
			rawRoom({
				id: "external-master-room",
				invCode: "MASTER",
				name: "Unmatched room fallback",
				prices: ["50", "50"],
			}),
		],
		total_rooms: 1,
		total_guests: 2,
		total: "100",
		sub_total: "100",
	});
	const MappingModel = {
		findOneAndUpdate() {
			return queryResult(() => null);
		},
		find() {
			return queryResult(() => [
				{
					invCode: "MASTER",
					status: "active",
					isMaster: true,
					localRoomConfigId: LOCAL_DOUBLE_ID,
				},
			]);
		},
	};
	const result = await discoverAndResolveRoomMappings(
		normalized,
		{
			_id: "64b000000000000000000001",
			roomCountDetails: [
				{ _id: LOCAL_DOUBLE_ID, roomType: "doubleRooms", activeRoom: true },
			],
		},
		{
			MappingModel,
			SyncStateModel: syncStateModelFor("published-master-generation"),
		}
	);
	assert.equal(result.ok, false);
	assert.deepEqual(result.unsafeMasterInvCodes, ["MASTER"]);
	assert.equal(result.resolvedRooms.length, 0);
});

test("payload-discovered inventory remains held until room-list non-master verification", async () => {
	const normalized = normalizedMultiRoom({
		rooms: [
			rawRoom({
				id: "external-unverified-room",
				invCode: "INV-UNVERIFIED",
				name: "Payload-only room",
				prices: ["50", "50"],
			}),
		],
		total_rooms: 1,
		total_guests: 2,
		total: "100",
		sub_total: "100",
	});
	let roomListVerifiedAt = null;
	let roomListSyncGeneration = "";
	let roomListVerificationState = "unverified";
	let activeRoomListSyncGeneration = "";
	const MappingModel = {
		findOneAndUpdate() {
			return queryResult(() => null);
		},
		find() {
			return queryResult(() => [
				{
					invCode: "INV-UNVERIFIED",
					status: "active",
					isMaster: false,
					roomListVerifiedAt,
					roomListSyncGeneration,
					roomListVerificationState,
					localRoomConfigId: LOCAL_DOUBLE_ID,
				},
			]);
		},
	};
	const hotel = {
		_id: "64b000000000000000000001",
		roomCountDetails: [
			{ _id: LOCAL_DOUBLE_ID, roomType: "doubleRooms", activeRoom: true },
		],
	};
	const SyncStateModel = syncStateModelFor(
		() => activeRoomListSyncGeneration
	);

	const payloadOnly = await discoverAndResolveRoomMappings(normalized, hotel, {
		MappingModel,
		SyncStateModel,
		mappingNow: () => new Date("2026-08-06T12:00:00.000Z"),
	});
	assert.equal(payloadOnly.ok, false);
	assert.deepEqual(payloadOnly.missingInvCodes, ["INV-UNVERIFIED"]);
	assert.equal(payloadOnly.resolvedRooms.length, 0);

	roomListVerifiedAt = new Date("2026-08-06T09:30:00.000Z");
	roomListSyncGeneration = "verified-generation";
	roomListVerificationState = "verified";
	activeRoomListSyncGeneration = "different-unpublished-generation";
	const unpublished = await discoverAndResolveRoomMappings(normalized, hotel, {
		MappingModel,
		SyncStateModel,
		mappingNow: () => new Date("2026-08-06T12:00:00.000Z"),
	});
	assert.equal(unpublished.ok, false);
	assert.deepEqual(unpublished.staleInvCodes, ["INV-UNVERIFIED"]);

	activeRoomListSyncGeneration = "verified-generation";
	const verified = await discoverAndResolveRoomMappings(normalized, hotel, {
		MappingModel,
		SyncStateModel,
		mappingNow: () => new Date("2026-08-06T12:00:00.000Z"),
	});
	assert.equal(verified.ok, true);
	assert.deepEqual(verified.missingInvCodes, []);
	assert.equal(verified.resolvedRooms.length, 1);

	const stale = await discoverAndResolveRoomMappings(normalized, hotel, {
		MappingModel,
		SyncStateModel,
		mappingNow: () => new Date("2026-08-10T12:00:00.000Z"),
	});
	assert.equal(stale.ok, false);
	assert.deepEqual(stale.staleInvCodes, ["INV-UNVERIFIED"]);
});

test("financial activity guard recognizes every local settlement and processor signal", () => {
	assert.equal(hasFinanceOrSettlementActivity({}), false);
	assert.equal(
		hasFinanceOrSettlementActivity({
			paid_amount_breakdown: { payment_comments: "informational only" },
		}),
		false
	);
	assert.equal(
		hasFinanceOrSettlementActivity({
			vcc_payment: {
				source: "",
				charged: false,
				processing: false,
				charge_count: 0,
				attempts_count: 0,
				total_captured_usd: 0,
				last_capture: {},
			},
			bofa_payment: {
				secure_acceptance: {
					status: "not_started",
					currency: "USD",
					transaction_type: "sale",
					callbacks: [],
				},
				vcc: { charged: false, total_captured_usd: 0 },
			},
		}),
		false,
		"schema defaults alone must not falsely claim local settlement activity"
	);
	assert.equal(
		hasFinanceOrSettlementActivity({
			moneyTransferredAt: null,
			commissionPaidAt: null,
			financial_cycle: {
				closedAt: null,
				hotelCollectedAmount: 0,
				pmsCollectedAmount: 0,
				hotelPayoutDue: 0,
				commissionDueToPms: 0,
				commissionAmount: 0,
				commissionValue: 0,
			},
		}),
		false,
		"empty settlement timestamps and zero cycle amounts are safe defaults"
	);

	const protectedCases = [
		{ paid_amount: 0.01 },
		{ paid_amount_breakdown: { cash: 0.01 } },
		{ payment_details: { captured: true } },
		{ paypal_details: { captured_total_usd: 1 } },
		{ paypal_details: { initial: { status: "COMPLETED" } } },
		{ vcc_payment: { total_captured_usd: 1 } },
		{ bofa_payment: { vcc: { total_captured_usd: 1 } } },
		{ moneyTransferredToHotel: true },
		{ commissionPaid: true },
		{ moneyTransferredAt: new Date("2026-08-06T10:00:00.000Z") },
		{ commissionPaidAt: new Date("2026-08-06T10:00:00.000Z") },
		{ financial_cycle: { commissionAssigned: true } },
		{ financial_cycle: { closedAt: new Date("2026-08-06T10:00:00.000Z") } },
		{ financial_cycle: { status: "closed" } },
		{ financial_cycle: { notes: "manual reconciliation" } },
		{ financial_cycle: { hotelCollectedAmount: 0.01 } },
		{ financial_cycle: { pmsCollectedAmount: 0.01 } },
		{ financial_cycle: { hotelPayoutDue: 0.01 } },
		{ financial_cycle: { commissionDueToPms: 0.01 } },
		{ financial_cycle: { commissionAmount: 0.01 } },
		{ financial_cycle: { commissionValue: 0.01 } },
		{ vcc_payment: { charged: true } },
		{ vcc_payment: { processing: true } },
		{ vcc_payment: { charge_count: 1 } },
		{ vcc_payment: { attempts_count: 1 } },
		{ vcc_payment: { last_transaction_id: "txn-local" } },
		{ braintree_payment: { last_reference_number: "ref-local" } },
		{ bofa_payment: { vcc: { processing: true } } },
		{ bofa_payment: { secure_acceptance: { charged: true } } },
	];
	for (const reservation of protectedCases) {
		assert.equal(
			hasFinanceOrSettlementActivity(reservation),
			true,
			JSON.stringify(reservation)
		);
	}
});

test("housing and terminal guards protect assigned, in-house, checked-out, and no-show stays", () => {
	assert.equal(hasHousingOrTerminalProtection({}), false);
	assert.equal(hasHousingOrTerminalProtection({ roomId: [""] }), false);
	for (const reservation of [
		{ roomId: ["physical-room-1"] },
		{ bedNumber: ["bed-1"] },
		{ housedBy: { name: "Front Desk" } },
		{ state: "inhouse" },
		{ reservation_status: "checked_in" },
		{ state: "checked_out" },
		{ state: "no_show" },
	]) {
		assert.equal(
			hasHousingOrTerminalProtection(reservation),
			true,
			JSON.stringify(reservation)
		);
	}
	assert.equal(isLocalTerminal({ state: "cancelled" }), "cancelled");
	assert.equal(isLocalTerminal({ state: "No Show" }), "no_show");
	assert.equal(isLocalTerminal({ reservation_status: "checked out" }), "checked_out");
	assert.equal(isLocalTerminal({ state: "in house" }), "inhouse");
	assert.equal(isLocalTerminal({ state: "confirmed" }), "");
});

test("cross-transport linking requires an exact alias, stay, provider, and non-conflicting HR id", () => {
	const normalized = normalizedMultiRoom();
	const candidate = {
		reservation_id: "legacy-email-id",
		booking_source: "Booking.com",
		checkin_date: "2026-08-10",
		checkout_date: "2026-08-12",
		customer_details: { confirmation_number2: " booking-101 " },
		supplierData: {},
	};

	assert.equal(candidateMatchesStrongIdentity(candidate, normalized), true);
	assert.equal(
		candidateMatchesStrongIdentity(
			{ ...candidate, checkout_date: "2026-08-13" },
			normalized
		),
		false
	);
	assert.equal(
		candidateMatchesStrongIdentity(
			{ ...candidate, booking_source: "Agoda" },
			normalized
		),
		false
	);
	assert.equal(
		candidateMatchesStrongIdentity(
			{
				...candidate,
				supplierData: {
					hotelRunner: { reservationId: "different-hr-reservation" },
				},
			},
			normalized
		),
		false
	);
	assert.equal(
		candidateMatchesStrongIdentity(
			{
				...candidate,
				booking_source: "HotelRunner",
				otaIdentityKey: "agoda:booking-101",
				customer_details: { confirmation_number2: "not-an-alias" },
				supplierData: { otaProvider: "agoda" },
			},
			normalized
		),
		false
	);
	assert.equal(
		candidateMatchesStrongIdentity(
			{
				...candidate,
				booking_source: "HotelRunner",
				otaIdentityKey: "agoda:booking-101",
				supplierData: { otaProvider: "agoda" },
			},
			normalized
		),
		false,
		"a HotelRunner display label must not override contradictory canonical OTA identity"
	);
	assert.equal(
		candidateMatchesStrongIdentity(
			{
				...candidate,
				otaIdentityKey: "booking:booking-101",
				supplierData: { otaProvider: "agoda" },
			},
			normalized
		),
		false,
		"contradictory canonical provider fields must fail closed"
	);
	assert.equal(
		candidateMatchesStrongIdentity(
			{
				...candidate,
				otaIdentityKey: "booking:booking-101",
				otaCrossTransportIdentityKey: "trip:booking-101",
				supplierData: { otaProvider: "booking" },
			},
			normalized
		),
		false,
		"only a Trip incoming identity may use the verified Trip bridge namespace"
	);
	assert.equal(
		candidateMatchesStrongIdentity(
			{
				...candidate,
				customer_details: { confirmation_number2: "R-101" },
			},
			normalizedMultiRoom({ provider_number: null })
		),
		false,
		"HotelRunner hr_number must not masquerade as an OTA confirmation when provider_number is blank"
	);
});

test("HotelRunner provider recognition uses explicit aliases without substring guessing", async () => {
	assert.equal(
		hotelRunnerCommercialProvider({ channelDisplay: "HotelRunner Booking Engine" }),
		"hotelrunner"
	);
	assert.equal(
		hotelRunnerCommercialProvider({ channel: "HotelRunnerBookingEngine" }),
		"hotelrunner"
	);
	assert.equal(
		hotelRunnerCommercialProvider({ channelDisplay: "Booking.com" }),
		"booking"
	);
	assert.equal(
		hotelRunnerCommercialProvider({ channelDisplay: "Trip.com" }),
		"trip"
	);
	assert.equal(
		hotelRunnerCommercialProvider({ channelDisplay: "Tripadvisor" }),
		""
	);
	assert.equal(
		hotelRunnerCommercialProvider({
			channelDisplay: "Booking.com",
			sourceDisplay: "Agoda",
			channel: "bookingcom",
		}),
		"",
		"contradictory recognized provider namespaces must fail closed"
	);
	assert.equal(
		hotelRunnerCommercialProvider({
			channelDisplay: "Booking.com",
			sourceDisplay: "booking",
			channel: "bookingcom",
		}),
		"booking",
		"equivalent labels in one provider family remain valid"
	);

	const system = createInMemoryProjectionSystem();
	const contradictory = normalizedMultiRoom({
		message_uid: "adapter-contradictory-booking-agoda-provider",
		channel: "bookingcom",
		channel_display: "Booking.com",
		source_display: "Agoda",
	});
	const contradictoryResult = await projectHotelRunnerReservation(
		{
			normalized: contradictory,
			event: { payload: contradictory.storedPayload },
			hotel: system.hotel,
			config: system.config,
		},
		system.dependencies
	);
	assert.equal(contradictoryResult.status, "quarantined");
	assert.equal(
		contradictoryResult.code,
		"hotelrunner_shared_identity_required"
	);
	assert.equal(system.reservations.length, 0);

	const unknownSystem = createInMemoryProjectionSystem();
	const unknown = normalizedMultiRoom({
		message_uid: "adapter-unknown-tripadvisor-provider",
		channel: "tripadvisor",
		channel_display: "Tripadvisor",
		source_display: "Tripadvisor",
	});
	const result = await projectHotelRunnerReservation(
		{
			normalized: unknown,
			event: { payload: unknown.storedPayload },
			hotel: unknownSystem.hotel,
			config: unknownSystem.config,
		},
		unknownSystem.dependencies
	);
	assert.equal(result.status, "quarantined");
	assert.equal(result.code, "hotelrunner_shared_identity_required");
	assert.equal(unknownSystem.reservations.length, 0);
});

test("first modified and cancellation events may use one unique exact alias without trusting stale stay dates", async () => {
	const candidate = {
		_id: "legacy-email-reservation-1",
		hotelId: "64b000000000000000000001",
		reservation_id: "legacy-email-transport-id",
		booking_source: "Booking.com",
		checkin_date: "2026-08-10",
		checkout_date: "2026-08-12",
		customer_details: { confirmation_number2: "BOOKING-101" },
		supplierData: {
			otaProvider: "booking",
			otaAutomationPipeline: "ota-email",
		},
	};
	const ReservationModel = {
		findOne: () => queryResult(() => null),
		find: () => queryResult(() => [candidate]),
	};
	const modified = normalizedMultiRoom();
	modified.modified = true;
	modified.checkinDate = "2026-08-11";
	modified.checkoutDate = "2026-08-13";
	const modifiedLink = await findLinkedReservation(
		modified,
		candidate.hotelId,
		{ ReservationModel }
	);
	assert.equal(modifiedLink.reservation, candidate);
	assert.equal(modifiedLink.method, "provider_or_hr_alias_unique");

	const cancellation = normalizeHotelRunnerReservation({
		message_uid: "cancel-first-event",
		reservation_id: "hr-reservation-101",
		hr_number: "R-101",
		provider_number: "BOOKING-101",
		channel: "bookingcom",
		channel_display: "Booking.com",
		state: "canceled",
		updated_at: "2026-08-06T12:00:00.000Z",
	});
	const cancellationLink = await findLinkedReservation(
		cancellation,
		candidate.hotelId,
		{ ReservationModel }
	);
	assert.equal(cancellationLink.reservation, candidate);
	assert.equal(cancellationLink.method, "provider_or_hr_alias_unique");

	const nonLifecycle = normalizedMultiRoom();
	nonLifecycle.checkinDate = "2026-08-11";
	nonLifecycle.checkoutDate = "2026-08-13";
	const noRelaxedLink = await findLinkedReservation(
		nonLifecycle,
		candidate.hotelId,
		{ ReservationModel }
	);
	assert.equal(noRelaxedLink.reservation, null);
});

test("relaxed lifecycle identity linking fails closed when the exact alias is not unique", async () => {
	const candidates = ["legacy-a", "legacy-b"].map((id, index) => ({
		_id: id,
		hotelId: "64b000000000000000000001",
		booking_source: "Booking.com",
		checkin_date: `2026-08-${10 + index}`,
		checkout_date: `2026-08-${12 + index}`,
		customer_details: { confirmation_number2: "BOOKING-101" },
		supplierData: { otaProvider: "booking", otaAutomationPipeline: "ota-email" },
	}));
	const ReservationModel = {
		findOne: () => queryResult(() => null),
		find: () => queryResult(() => candidates),
	};
	const modified = normalizedMultiRoom();
	modified.modified = true;
	modified.checkinDate = "2026-08-20";
	modified.checkoutDate = "2026-08-22";

	await assert.rejects(
		findLinkedReservation(modified, candidates[0].hotelId, { ReservationModel }),
		(error) => error?.code === "hotelrunner_identity_ambiguous"
	);
});

test("alias linking quarantines when the bounded candidate query cannot prove uniqueness", async () => {
	const candidates = Array.from({ length: 6 }, (_, index) => ({
		_id: `legacy-overflow-${index}`,
		hotelId: "64b000000000000000000001",
		booking_source: index === 0 ? "Booking.com" : "Agoda",
		checkin_date: "2026-08-10",
		checkout_date: "2026-08-12",
		customer_details: { confirmation_number2: "BOOKING-101" },
		supplierData: {
			otaProvider: index === 0 ? "booking" : "agoda",
			otaAutomationPipeline: "ota-email",
		},
	}));
	let requestedLimit = null;
	const ReservationModel = {
		findOne: () => queryResult(() => null),
		find: () => {
			const query = queryResult(() => candidates);
			query.limit = (value) => {
				requestedLimit = value;
				return query;
			};
			return query;
		},
	};

	await assert.rejects(
		findLinkedReservation(normalizedMultiRoom(), candidates[0].hotelId, {
			ReservationModel,
		}),
		(error) => error?.code === "hotelrunner_identity_ambiguous"
	);
	assert.equal(requestedLimit, 6);
});

test("critical ownership ignores transport room IDs but detects local room, date, and count changes", () => {
	const baseline = {
		checkinDate: "2026-08-10",
		checkoutDate: "2026-08-12",
		totalRooms: 1,
		rooms: [
			{
				localRoomConfigId: LOCAL_DOUBLE_ID,
				hotelRunnerRoomId: "external-room-original",
				roomType: "doubleRooms",
				displayName: "Double Room",
				count: 1,
				stayDates: ["2026-08-10", "2026-08-11"],
			},
		],
	};
	const owned = criticalOwnershipProjection(baseline);
	assert.deepEqual(
		owned,
		criticalOwnershipProjection({
			...baseline,
			rooms: [
				{
					...baseline.rooms[0],
					hotelRunnerRoomId: "external-room-new",
					roomType: "renamed transport label",
					displayName: "renamed transport display",
				},
			],
		})
	);
	for (const changed of [
		{
			...baseline,
			rooms: [{ ...baseline.rooms[0], localRoomConfigId: LOCAL_TRIPLE_ID }],
		},
		{
			...baseline,
			rooms: [{ ...baseline.rooms[0], stayDates: ["2026-08-11"] }],
		},
		{
			...baseline,
			rooms: [{ ...baseline.rooms[0], count: 2 }],
		},
		{ ...baseline, checkinDate: "2026-08-11" },
		{ ...baseline, totalRooms: 2 },
	]) {
		assert.notDeepEqual(criticalOwnershipProjection(changed), owned);
	}
});

test("review-mode create, modifications, redelivery, and cancellation keep one PMS reservation", async () => {
	const system = createInMemoryProjectionSystem();
	system.config.requireOtaReview = true;
	const confirmed = normalizedMultiRoom({
		message_uid: "review-mode-confirmed-1",
		updated_at: "2026-08-06T11:00:00.000Z",
	});
	const created = await projectHotelRunnerReservation(
		{
			normalized: confirmed,
			event: { payload: confirmed.storedPayload },
			hotel: system.hotel,
			config: system.config,
		},
		system.dependencies
	);
	assert.equal(created.status, "created");
	assert.equal(system.reservations.length, 1);
	const reservationId = String(system.reservations[0]._id);
	assert.equal(system.reservations[0].state, "OTA Platform Review");
	assert.equal(
		system.reservations[0].reservation_status,
		"OTA Platform Review"
	);
	assert.equal(system.reservations[0].otaPlatformReview.status, "pending");
	assert.equal(system.reservations[0].otaPlatformReview.source, "hotelrunner_api");

	const modified = normalizedMultiRoom({
		message_uid: "review-mode-modified-2",
		modified: true,
		guest: "Updated Review Guest",
		updated_at: "2026-08-06T12:00:00.000Z",
	});
	const updated = await projectHotelRunnerReservation(
		{
			normalized: modified,
			event: { payload: modified.storedPayload },
			hotel: system.hotel,
			config: system.config,
		},
		system.dependencies
	);
	assert.equal(updated.status, "updated");
	assert.equal(system.reservations.length, 1);
	assert.equal(String(system.reservations[0]._id), reservationId);
	assert.equal(system.reservations[0].customer_details.name, "Updated Review Guest");
	assert.equal(system.reservations[0].state, "OTA Platform Review");
	assert.equal(system.reservations[0].reservation_status, "OTA Platform Review");
	assert.equal(system.reservations[0].otaPlatformReview.status, "pending");

	const redelivered = await projectHotelRunnerReservation(
		{
			normalized: modified,
			event: { payload: modified.storedPayload },
			hotel: system.hotel,
			config: system.config,
		},
		system.dependencies
	);
	assert.equal(redelivered.status, "ignored");
	assert.equal(redelivered.code, "hotelrunner_already_applied");
	assert.equal(system.reservations.length, 1);

	// Once created as a HotelRunner review, a configuration rollback must not
	// silently release it. Only the existing staff release workflow may do that.
	system.config.requireOtaReview = false;
	const modifiedAfterFlagRollback = normalizedMultiRoom({
		message_uid: "review-mode-modified-3",
		modified: true,
		guest: "Updated After Flag Rollback",
		updated_at: "2026-08-06T13:00:00.000Z",
	});
	const updatedAfterFlagRollback = await projectHotelRunnerReservation(
		{
			normalized: modifiedAfterFlagRollback,
			event: { payload: modifiedAfterFlagRollback.storedPayload },
			hotel: system.hotel,
			config: system.config,
		},
		system.dependencies
	);
	assert.equal(updatedAfterFlagRollback.status, "updated");
	assert.equal(system.reservations.length, 1);
	assert.equal(String(system.reservations[0]._id), reservationId);
	assert.equal(system.reservations[0].state, "OTA Platform Review");
	assert.equal(system.reservations[0].reservation_status, "OTA Platform Review");
	assert.equal(system.reservations[0].otaPlatformReview.status, "pending");

	const cancelled = normalizedMultiRoom({
		message_uid: "review-mode-cancelled-4",
		state: "canceled",
		modified: true,
		updated_at: "2026-08-06T14:00:00.000Z",
	});
	const cancelledResult = await projectHotelRunnerReservation(
		{
			normalized: cancelled,
			event: { payload: cancelled.storedPayload },
			hotel: system.hotel,
			config: system.config,
		},
		system.dependencies
	);
	assert.equal(cancelledResult.status, "cancelled");
	assert.equal(system.reservations.length, 1);
	assert.equal(String(system.reservations[0]._id), reservationId);
	assert.equal(system.reservations[0].state, "cancelled");
	assert.equal(system.reservations[0].reservation_status, "cancelled");
	assert.equal(system.reservations[0].otaPlatformReview.status, "cancelled");
});

test("offline projection creates once, updates owned guest counts, preserves local counts, and cancels", async () => {
	const system = createInMemoryProjectionSystem();
	const createdNormalized = normalizedMultiRoom();
	const created = await projectHotelRunnerReservation(
		{
			normalized: createdNormalized,
			event: { payload: createdNormalized.storedPayload },
			hotel: system.hotel,
			config: system.config,
		},
		system.dependencies
	);
	assert.equal(created.status, "created");
	assert.equal(system.reservations.length, 1);
	assert.equal(system.reservations[0].paid_amount, 0);
	assert.equal(system.reservations[0].payment_details.captured, false);

	// Legacy email-created rows do not contain HotelRunner's transport room ID.
	// This difference must not be treated as a local room/stay ownership edit.
	for (const field of ["pickedRoomsType", "pickedRoomsPricing"]) {
		for (const room of system.reservations[0][field]) {
			delete room.hotelRunnerRoomId;
		}
	}
	const ownedGuestUpdate = normalizedMultiRoom();
	ownedGuestUpdate.messageUid = "adapter-message-2";
	ownedGuestUpdate.modified = true;
	ownedGuestUpdate.sourceUpdatedAt = new Date("2026-08-06T12:00:00.000Z");
	ownedGuestUpdate.canonicalHash = "synthetic-update-hash-1";
	ownedGuestUpdate.payloadHash = "synthetic-update-payload-1";
	ownedGuestUpdate.totalGuests = 6;
	ownedGuestUpdate.rooms[0].totalGuests = 3;
	ownedGuestUpdate.rooms[0].adults = 3;
	const updated = await projectHotelRunnerReservation(
		{
			normalized: ownedGuestUpdate,
			event: { payload: ownedGuestUpdate.storedPayload },
			hotel: system.hotel,
			config: system.config,
		},
		system.dependencies
	);
	assert.equal(updated.status, "updated");
	assert.equal(updated.guestCountsProtected, false);
	assert.equal(system.reservations.length, 1);
	assert.equal(system.reservations[0].total_guests, 6);
	assert.equal(system.reservations[0].adults, 5);
	assert.equal(system.reservations[0].children, 1);
	const ownedUpdateSet = system.reservationWrites.at(-1).update.$set;
	assert.equal(ownedUpdateSet.total_guests, 6);
	assert.equal(Object.hasOwn(ownedUpdateSet, "checkin_date"), false);
	assert.equal(Object.hasOwn(ownedUpdateSet, "pickedRoomsType"), false);

	// A local front-desk count edit after the last applied projection is owned by
	// the PMS and must not be silently overwritten by the next OTA event.
	system.reservations[0].total_guests = 9;
	system.reservations[0].adults = 9;
	system.reservations[0].children = 0;
	system.reservations[0].customer_details.name = "Front Desk Guest";
	system.reservations[0].total_amount = 777;
	const protectedGuestUpdate = normalizedMultiRoom();
	protectedGuestUpdate.messageUid = "adapter-message-3";
	protectedGuestUpdate.modified = true;
	protectedGuestUpdate.sourceUpdatedAt = new Date("2026-08-06T13:00:00.000Z");
	protectedGuestUpdate.canonicalHash = "synthetic-update-hash-2";
	protectedGuestUpdate.payloadHash = "synthetic-update-payload-2";
	protectedGuestUpdate.totalGuests = 7;
	protectedGuestUpdate.rooms[0].totalGuests = 4;
	protectedGuestUpdate.rooms[0].adults = 4;
	const protected = await projectHotelRunnerReservation(
		{
			normalized: protectedGuestUpdate,
			event: { payload: protectedGuestUpdate.storedPayload },
			hotel: system.hotel,
			config: system.config,
		},
		system.dependencies
	);
	assert.equal(protected.status, "updated");
	assert.equal(protected.guestCountsProtected, true);
	assert.equal(system.reservations[0].total_guests, 9);
	assert.equal(system.reservations[0].customer_details.name, "Front Desk Guest");
	assert.equal(system.reservations[0].total_amount, 777);
	const protectedSet = system.reservationWrites.at(-1).update.$set;
	assert.equal(Object.hasOwn(protectedSet, "total_guests"), false);
	assert.equal(Object.hasOwn(protectedSet, "adults"), false);
	assert.equal(Object.hasOwn(protectedSet, "children"), false);
	assert.equal(Object.hasOwn(protectedSet, "customer_details.name"), false);
	assert.equal(Object.hasOwn(protectedSet, "total_amount"), false);

	const secondProtectedUpdate = normalizedMultiRoom();
	secondProtectedUpdate.messageUid = "adapter-message-3b";
	secondProtectedUpdate.modified = true;
	secondProtectedUpdate.sourceUpdatedAt = new Date("2026-08-06T13:30:00.000Z");
	secondProtectedUpdate.canonicalHash = "synthetic-update-hash-2b";
	secondProtectedUpdate.payloadHash = "synthetic-update-payload-2b";
	secondProtectedUpdate.guestName = "Another OTA Guest Name";
	secondProtectedUpdate.totalGuests = 8;
	secondProtectedUpdate.rooms[0].totalGuests = 5;
	secondProtectedUpdate.rooms[0].adults = 5;
	secondProtectedUpdate.totalCents = 15000;
	const protectedAgain = await projectHotelRunnerReservation(
		{
			normalized: secondProtectedUpdate,
			event: { payload: secondProtectedUpdate.storedPayload },
			hotel: system.hotel,
			config: system.config,
		},
		system.dependencies
	);
	assert.equal(protectedAgain.status, "updated");
	assert.equal(protectedAgain.guestCountsProtected, true);
	assert.equal(protectedAgain.commercialProtected, true);
	assert.equal(system.reservations[0].total_guests, 9);
	assert.equal(system.reservations[0].customer_details.name, "Front Desk Guest");
	assert.equal(system.reservations[0].total_amount, 777);
	const protectedAgainSet = system.reservationWrites.at(-1).update.$set;
	assert.equal(Object.hasOwn(protectedAgainSet, "total_guests"), false);
	assert.equal(Object.hasOwn(protectedAgainSet, "customer_details.name"), false);
	assert.equal(Object.hasOwn(protectedAgainSet, "total_amount"), false);

	const cancellation = normalizeHotelRunnerReservation({
		message_uid: "adapter-message-4",
		reservation_id: "hr-reservation-101",
		hr_number: "R-101",
		provider_number: "BOOKING-101",
		channel: "bookingcom",
		channel_display: "Booking.com",
		state: "canceled",
		cancel_reason: "OTA cancellation",
		// The immutable HotelRunner link is authoritative even when a missed
		// modification means the cancellation carries revised stay dates.
		checkin_date: "2026-08-11",
		checkout_date: "2026-08-13",
		updated_at: "2026-08-06T14:00:00.000Z",
	});
	const cancelled = await projectHotelRunnerReservation(
		{
			normalized: cancellation,
			event: { payload: cancellation.storedPayload },
			hotel: system.hotel,
			config: system.config,
		},
		system.dependencies
	);
	assert.equal(cancelled.status, "cancelled");
	assert.equal(system.reservations.length, 1);
	assert.equal(system.reservations[0].state, "cancelled");
	assert.equal(system.reservations[0].reservation_status, "cancelled");
	assert.equal(system.reservations[0].paid_amount, 0);
	assert.equal(system.reservations[0].payment_details.captured, false);
});

test("HotelRunner preserves verified email payout evidence until provider or gross facts change", async () => {
	const system = createInMemoryProjectionSystem();
	const first = normalizedMultiRoom();
	assert.equal(
		(
			await projectHotelRunnerReservation(
				{
					normalized: first,
					event: { payload: first.storedPayload },
					hotel: system.hotel,
					config: system.config,
				},
				system.dependencies
			)
		).status,
		"created"
	);
	const reservation = system.reservations[0];
	const evidenceWithoutHash = {
		version: 1,
		verified: true,
		source: "authenticated_ota_email",
		provider: "booking",
		otaIdentityKey: "booking:booking-101",
		grossTotalSar: 100.01,
		payoutTotalSar: 85.01,
		otaExpenseTotalSar: 15,
		currency: "SAR",
		sourceReceivedAt: "2026-08-06T11:15:00.000Z",
		appliedAt: new Date("2026-08-06T11:16:00.000Z"),
	};
	const evidence = {
		...evidenceWithoutHash,
		evidenceHash: hotelRunnerEmailCommercialEvidenceHash(evidenceWithoutHash),
	};
	const paymentSummary = {
		sourceCurrency: "SAR",
		sourceTotalGuestPaymentAmount: 100.01,
		sourceTotalPayoutAmount: 85.01,
		totalGuestPaymentAmount: 100.01,
		totalPayoutAmount: 85.01,
		currency: "SAR",
		exchangeRateToSar: 1,
	};
	reservation.supplierData.hotelRunnerEmailCommercialEvidence = evidence;
	reservation.supplierData.otaTotalPayoutSar = 85.01;
	reservation.supplierData.otaExpenseTotalSar = 15;
	reservation.supplierData.otaPayoutFallbackReason = "";
	reservation.supplierData.otaPaymentSummary = paymentSummary;
	reservation.adminPricing.clientTotal = 100.01;
	reservation.adminPricing.netAfterExpensesTotal = 85.01;
	reservation.adminPricing.otaExpenseTotal = 15;
	reservation.adminPricing.defaultDeductionApplied = false;
	reservation.adminPricing.payoutFallbackReason = "";
	reservation.adminPricing.commercialVerified = true;
	reservation.ota_financial_summary.clientTotal = 100.01;
	reservation.ota_financial_summary.netAfterExpenses = 85.01;
	reservation.ota_financial_summary.netAfterOtaExpenses = 85.01;
	reservation.ota_financial_summary.otaExpenseTotal = 15;
	reservation.ota_financial_summary.payoutFallbackReason = "";
	reservation.ota_financial_summary.paymentSummary = paymentSummary;
	reservation.ota_financial_summary.commercialVerified = true;
	reservation.ota_financial_summary.show = true;

	const sameCommercial = normalizedMultiRoom({
		message_uid: "adapter-commercial-preserve",
		modified: true,
		updated_at: "2026-08-06T12:00:00.000Z",
		guest: "Updated Guest",
	});
	const preserved = await projectHotelRunnerReservation(
		{
			normalized: sameCommercial,
			event: { payload: sameCommercial.storedPayload },
			hotel: system.hotel,
			config: system.config,
		},
		system.dependencies
	);
	assert.equal(preserved.status, "updated");
	assert.equal(reservation.adminPricing.netAfterExpensesTotal, 85.01);
	assert.equal(reservation.adminPricing.otaExpenseTotal, 15);
	assert.equal(reservation.adminPricing.commercialVerified, true);
	assert.equal(
		reservation.commission_ota,
		null,
		"legacy gross-to-net expense evidence must not be relabeled as OTA commission"
	);
	assert.deepEqual(
		reservation.supplierData.hotelRunnerEmailCommercialEvidence,
		evidence
	);

	const changedGross = normalizedMultiRoom({
		message_uid: "adapter-commercial-invalidate",
		modified: true,
		updated_at: "2026-08-06T13:00:00.000Z",
		total: "110.01",
		sub_total: "110.01",
		item_total: "110.01",
	});
	const invalidated = await projectHotelRunnerReservation(
		{
			normalized: changedGross,
			event: { payload: changedGross.storedPayload },
			hotel: system.hotel,
			config: system.config,
		},
		system.dependencies
	);
	assert.equal(invalidated.status, "updated");
	assert.equal(reservation.adminPricing.netAfterExpensesTotal, null);
	assert.equal(reservation.adminPricing.otaExpenseTotal, null);
	assert.equal(reservation.adminPricing.commercialVerified, false);
	assert.equal(reservation.commission_ota, null);
	assert.equal(
		reservation.supplierData.hotelRunnerEmailCommercialEvidence,
		null
	);
	assert.equal(
		reservation.supplierData.otaPayoutFallbackReason,
		"hotelrunner_commercial_evidence_stale"
	);
	assert.equal(
		reservation.adminPricing.payoutFallbackReason,
		"hotelrunner_commercial_evidence_stale"
	);
	assert.equal(
		reservation.ota_financial_summary.payoutFallbackReason,
		"hotelrunner_commercial_evidence_stale"
	);
});

test("finance-protected gross changes stale payout evidence without overwriting money", async () => {
	const system = createInMemoryProjectionSystem();
	const initial = normalizedMultiRoom();
	assert.equal(
		(
			await projectHotelRunnerReservation(
				{
					normalized: initial,
					event: { payload: initial.storedPayload },
					hotel: system.hotel,
					config: system.config,
				},
				system.dependencies
			)
		).status,
		"created"
	);
	const reservation = system.reservations[0];
	attachVerifiedHotelRunnerEmailCommercialEvidence(reservation);
	reservation.paypal_details = { captured_total_usd: 100.01 };

	const protectedAmounts = {
		totalAmount: reservation.total_amount,
		adminClientTotal: reservation.adminPricing.clientTotal,
		adminNet: reservation.adminPricing.netAfterExpensesTotal,
		adminExpense: reservation.adminPricing.otaExpenseTotal,
		summaryClientTotal: reservation.ota_financial_summary.clientTotal,
		summaryNet: reservation.ota_financial_summary.netAfterExpenses,
		summaryExpense: reservation.ota_financial_summary.otaExpenseTotal,
		supplierPayout: reservation.supplierData.otaTotalPayoutSar,
		supplierExpense: reservation.supplierData.otaExpenseTotalSar,
	};
	const changedGross = normalizedMultiRoom({
		message_uid: "adapter-finance-protected-gross",
		modified: true,
		updated_at: "2026-08-06T13:00:00.000Z",
		total: "110.01",
		sub_total: "110.01",
		item_total: "110.01",
	});
	const result = await projectHotelRunnerReservation(
		{
			normalized: changedGross,
			event: { payload: changedGross.storedPayload },
			hotel: system.hotel,
			config: system.config,
		},
		system.dependencies
	);

	assert.equal(result.status, "updated");
	assert.equal(result.commercialProtected, true);
	assert.equal(result.commercialEvidenceStale, true);
	assert.equal(
		result.attentionCode,
		"hotelrunner_commercial_evidence_stale"
	);
	assert.equal(reservation.total_amount, protectedAmounts.totalAmount);
	assert.equal(
		reservation.adminPricing.clientTotal,
		protectedAmounts.adminClientTotal
	);
	assert.equal(
		reservation.adminPricing.netAfterExpensesTotal,
		protectedAmounts.adminNet
	);
	assert.equal(
		reservation.adminPricing.otaExpenseTotal,
		protectedAmounts.adminExpense
	);
	assert.equal(
		reservation.ota_financial_summary.clientTotal,
		protectedAmounts.summaryClientTotal
	);
	assert.equal(
		reservation.ota_financial_summary.netAfterExpenses,
		protectedAmounts.summaryNet
	);
	assert.equal(
		reservation.ota_financial_summary.otaExpenseTotal,
		protectedAmounts.summaryExpense
	);
	assert.equal(
		reservation.supplierData.otaTotalPayoutSar,
		protectedAmounts.supplierPayout
	);
	assert.equal(
		reservation.supplierData.otaExpenseTotalSar,
		protectedAmounts.supplierExpense
	);
	assert.equal(reservation.adminPricing.commercialVerified, false);
	assert.equal(reservation.ota_financial_summary.commercialVerified, false);
	assert.equal(reservation.ota_financial_summary.show, false);
	assert.equal(
		reservation.supplierData.hotelRunnerEmailCommercialEvidence,
		null
	);
	assert.equal(
		reservation.supplierData.otaPayoutFallbackReason,
		"hotelrunner_commercial_evidence_stale"
	);
	assert.equal(
		reservation.adminPricing.payoutFallbackReason,
		"hotelrunner_commercial_evidence_stale"
	);
	assert.equal(
		reservation.ota_financial_summary.payoutFallbackReason,
		"hotelrunner_commercial_evidence_stale"
	);
	assert.equal(
		reservation.supplierData.hotelRunner.pricing.grandTotal,
		110.01,
		"the new HotelRunner gross remains archived separately from protected PMS money"
	);
	assert.equal(system.mirror.lastResult.commercialEvidenceStale, true);
});

test("critical conflicts hide stale payout evidence while preserving protected finance", async () => {
	const system = createInMemoryProjectionSystem();
	const initial = normalizedMultiRoom();
	assert.equal(
		(
			await projectHotelRunnerReservation(
				{
					normalized: initial,
					event: { payload: initial.storedPayload },
					hotel: system.hotel,
					config: system.config,
				},
				system.dependencies
			)
		).status,
		"created"
	);
	const reservation = system.reservations[0];
	attachVerifiedHotelRunnerEmailCommercialEvidence(reservation);
	reservation.paypal_details = { captured_total_usd: 100.01 };
	const protectedNet = reservation.adminPricing.netAfterExpensesTotal;
	const protectedExpense = reservation.adminPricing.otaExpenseTotal;

	const criticalChange = normalizedMultiRoom({
		message_uid: "adapter-finance-protected-critical",
		modified: true,
		updated_at: "2026-08-06T13:30:00.000Z",
		checkin_date: "2026-08-11",
		checkout_date: "2026-08-13",
		total: "120.01",
		sub_total: "120.01",
		item_total: "120.01",
		rooms: [
			rawRoom({
				id: "external-room-1",
				invCode: "INV-DOUBLE",
				name: "Double Room",
				prices: ["100", "200"],
			}),
			rawRoom({
				id: "external-room-2",
				invCode: "INV-TRIPLE",
				name: "Triple Room",
				prices: ["300", "400"],
				adults: 2,
				children: 1,
			}),
		].map((room) => ({
			...room,
			checkin_date: "2026-08-11",
			checkout_date: "2026-08-13",
			daily_prices: room.daily_prices.map((day, index) => ({
				...day,
				date: `2026-08-${11 + index}`,
			})),
		})),
	});
	const result = await projectHotelRunnerReservation(
		{
			normalized: criticalChange,
			event: { payload: criticalChange.storedPayload },
			hotel: system.hotel,
			config: system.config,
		},
		system.dependencies
	);

	assert.equal(result.status, "quarantined");
	assert.equal(result.code, "hotelrunner_local_room_or_stay_conflict");
	assert.equal(result.commercialEvidenceStale, true);
	assert.equal(reservation.adminPricing.netAfterExpensesTotal, protectedNet);
	assert.equal(reservation.adminPricing.otaExpenseTotal, protectedExpense);
	assert.equal(reservation.adminPricing.commercialVerified, false);
	assert.equal(reservation.ota_financial_summary.show, false);
	assert.equal(
		reservation.supplierData.hotelRunnerEmailCommercialEvidence,
		null
	);
	assert.equal(
		reservation.reservationAuditLog.at(-1).action,
		"hotelrunner-commercial-evidence-invalidated"
	);
	assert.equal(
		system.mirror.lastErrorCode,
		"hotelrunner_local_room_or_stay_conflict"
	);
});

test("minimal cancellation preserves canonical provider and prior HotelRunner identity metadata", async () => {
	const system = createInMemoryProjectionSystem();
	const initial = normalizedMultiRoom({
		message_uid: "minimal-cancellation-initial",
		updated_at: "2026-08-06T11:00:00.000Z",
	});
	const created = await projectHotelRunnerReservation(
		{
			normalized: initial,
			event: { payload: initial.storedPayload },
			hotel: system.hotel,
			config: system.config,
		},
		system.dependencies
	);
	assert.equal(created.status, "created");
	const completePricingSnapshot = structuredClone(
		system.reservations[0].supplierData.hotelRunner.pricing
	);

	const cancellation = normalizeHotelRunnerReservation({
		message_uid: "minimal-cancellation-final",
		reservation_id: initial.hotelRunnerReservationId,
		state: "canceled",
		updated_at: "2026-08-06T12:00:00.000Z",
		rooms: [
			{
				id: "external-room-1",
				inv_code: "INV-DOUBLE",
				state: "canceled",
			},
		],
	});
	assert.deepEqual(cancellation.issues, []);
	const cancelled = await projectHotelRunnerReservation(
		{
			normalized: cancellation,
			event: { payload: cancellation.storedPayload },
			hotel: system.hotel,
			config: system.config,
		},
		system.dependencies
	);
	assert.equal(cancelled.status, "cancelled");
	const local = system.reservations[0];
	assert.equal(local.otaIdentityKey, "booking:booking-101");
	assert.equal(local.reservation_id, "BOOKING-101");
	assert.equal(local.supplierData.otaProvider, "booking");
	assert.equal(local.supplierData.otaSourceAuthority, 4);
	assert.equal(local.supplierData.hotelRunner.hrNumber, "R-101");
	assert.equal(local.supplierData.hotelRunner.providerNumber, "BOOKING-101");
	assert.equal(local.supplierData.hotelRunner.channel, "bookingcom");
	assert.equal(local.supplierData.hotelRunner.reportedPaidAmount, 100.01);
	assert.equal(local.supplierData.hotelRunner.reportedPaidAmountCurrency, "SAR");
	assert.equal(local.supplierData.hotelRunner.sourceState, "canceled");
	assert.deepEqual(
		local.supplierData.hotelRunner.pricing,
		completePricingSnapshot,
		"room identity without monetary facts must not replace a complete pricing snapshot"
	);
});

test("first alias-only cancellation with conflicting stay dates is quarantined", async () => {
	const system = createInMemoryProjectionSystem();
	system.reservations.push({
		_id: "64b000000000000000000099",
		hotelId: system.hotel._id,
		reservation_id: "legacy-email-transport-id",
		booking_source: "Booking.com",
		checkin_date: new Date("2026-08-10T00:00:00.000Z"),
		checkout_date: new Date("2026-08-12T00:00:00.000Z"),
		state: "Pending Confirmation",
		reservation_status: "Pending Confirmation",
		customer_details: { confirmation_number2: "BOOKING-101" },
		supplierData: {
			otaProvider: "booking",
			otaAutomationPipeline: "ota-email",
		},
	});
	const cancellation = normalizeHotelRunnerReservation({
		message_uid: "alias-only-cancellation-conflicting-stay",
		reservation_id: "hr-reservation-101",
		hr_number: "R-101",
		provider_number: "BOOKING-101",
		channel: "bookingcom",
		channel_display: "Booking.com",
		state: "canceled",
		checkin_date: "2026-08-11",
		checkout_date: "2026-08-13",
		updated_at: "2026-08-06T15:00:00.000Z",
	});
	const result = await projectHotelRunnerReservation(
		{
			normalized: cancellation,
			event: { payload: cancellation.storedPayload },
			hotel: system.hotel,
			config: system.config,
		},
		system.dependencies
	);
	assert.equal(result.status, "quarantined");
	assert.equal(result.code, "hotelrunner_cancellation_stay_conflict");
	assert.equal(system.reservations[0].state, "Pending Confirmation");
	assert.equal(system.reservationWrites.length, 0);
});

test("captured finance state quarantines a stay-only HotelRunner modification", async () => {
	const system = createInMemoryProjectionSystem();
	for (const room of system.hotel.roomCountDetails) room.pricingRate = [];
	const initial = normalizedMultiRoom();
	const created = await projectHotelRunnerReservation(
		{
			normalized: initial,
			event: { payload: initial.storedPayload },
			hotel: system.hotel,
			config: system.config,
		},
		system.dependencies
	);
	assert.equal(created.status, "created");
	system.reservations[0].paypal_details = { captured_total_usd: 100.01 };

	const stayOnly = normalizedMultiRoom();
	stayOnly.messageUid = "captured-stay-only-modification";
	stayOnly.modified = true;
	stayOnly.sourceUpdatedAt = new Date("2026-08-06T16:00:00.000Z");
	stayOnly.payloadHash = "captured-stay-only-payload";
	stayOnly.canonicalHash = "captured-stay-only-canonical";
	stayOnly.checkinDate = "2026-08-11";
	stayOnly.checkoutDate = "2026-08-13";
	for (const room of stayOnly.rooms) {
		room.checkinDate = "2026-08-11";
		room.checkoutDate = "2026-08-13";
		room.dailyPrices = room.dailyPrices.map((day, index) => ({
			...day,
			date: `2026-08-${11 + index}`,
		}));
	}
	const result = await projectHotelRunnerReservation(
		{
			normalized: stayOnly,
			event: { payload: stayOnly.storedPayload },
			hotel: system.hotel,
			config: system.config,
		},
		system.dependencies
	);
	assert.equal(result.status, "quarantined");
	assert.equal(result.code, "hotelrunner_local_room_or_stay_conflict");
	assert.equal(
		new Date(system.reservations[0].checkin_date).toISOString().slice(0, 10),
		"2026-08-10"
	);
});

test("PMS source watermark blocks an older HotelRunner projection before room mapping or mutation", async () => {
	const system = createInMemoryProjectionSystem();
	const initial = normalizedMultiRoom();
	const created = await projectHotelRunnerReservation(
		{
			normalized: initial,
			event: { payload: initial.storedPayload },
			hotel: system.hotel,
			config: system.config,
		},
		system.dependencies
	);
	assert.equal(created.status, "created");
	system.reservations[0].supplierData.otaLastSourceReceivedAt =
		new Date("2026-08-06T13:00:00.000Z");
	system.reservations[0].supplierData.hotelRunner.appliedSourceUpdatedAt =
		new Date("2026-08-06T13:00:00.000Z");
	const beforeReservationWrites = system.reservationWrites.length;
	const beforeMappingWrites = system.mappingWrites.length;
	const stale = normalizedMultiRoom();
	stale.messageUid = "stale-against-pms-watermark";
	stale.modified = true;
	stale.sourceUpdatedAt = new Date("2026-08-06T12:00:00.000Z");
	stale.canonicalHash = "synthetic-stale-canonical-hash";
	stale.payloadHash = "synthetic-stale-payload-hash";

	assert.equal(pmsWatermarkComparison(stale, system.reservations[0]), "older");
	const result = await projectHotelRunnerReservation(
		{
			normalized: stale,
			event: { payload: stale.storedPayload },
			hotel: system.hotel,
			config: system.config,
		},
		system.dependencies
	);
	assert.equal(result.status, "ignored");
	assert.equal(result.code, "hotelrunner_stale_against_pms_watermark");
	assert.equal(system.reservationWrites.length, beforeReservationWrites);
	assert.equal(system.mappingWrites.length, beforeMappingWrites);
	assert.equal(system.mirror.lastErrorCode, "hotelrunner_stale_against_pms_watermark");
});

test("email relay receipt clocks do not make an authoritative HotelRunner event stale", () => {
	const normalized = normalizedMultiRoom();
	assert.equal(
		pmsWatermarkComparison(normalized, {
			supplierData: {
				otaSourceAuthority: 3,
				otaLastSourceReceivedAt: "2026-08-06T12:00:00.000Z",
			},
		}),
		"newer"
	);
});

test("incoming and stored projections compare only PMS fields owned by this integration", () => {
	const normalized = normalizedMultiRoom();
	const pricing = buildPickedRoomsProjection(
		normalized,
		resolvedRooms(normalized)
	);
	const incoming = projectionFromIncoming(normalized, pricing);
	const stored = projectionFromReservation(
		buildCreateReservationDocument({
			normalized,
			event: { _id: "event-1" },
			hotel: {
				_id: "64b000000000000000000001",
				belongsTo: "64b000000000000000000002",
			},
			pricing,
			confirmationNumber: "PMS-HR-000001",
			reservationMongoId: "64b000000000000000000003",
		})
	);

	assert.deepEqual(stored.guest, incoming.guest);
	assert.deepEqual(stored.critical, incoming.critical);
	assert.deepEqual(stored.commercial, incoming.commercial);
	assert.deepEqual(stored.note, incoming.note);
	assert.equal(stored.state, "confirmed");
	assert.equal(stored.reservationStatus, "confirmed");
});

test("source timestamp ordering is strict and invalid timestamps fail closed", () => {
	assert.equal(
		sourceTimestampComparison(
			"2026-08-06T11:00:00.000Z",
			"2026-08-06T10:00:00.000Z"
		),
		"newer"
	);
	assert.equal(
		sourceTimestampComparison(
			"2026-08-06T09:00:00.000Z",
			"2026-08-06T10:00:00.000Z"
		),
		"older"
	);
	assert.equal(
		sourceTimestampComparison(
			"2026-08-06T10:00:00.000Z",
			"2026-08-06T10:00:00.000Z"
		),
		"equal"
	);
	assert.equal(sourceTimestampComparison("invalid", null), "invalid");
	assert.equal(
		sourceTimestampComparison("2026-08-06T10:00:00.000Z", null),
		"newer"
	);
});

test("stored event timestamps remain ISO strings and reconstruct as valid Dates", () => {
	const normalized = normalizedMultiRoom();
	assert.equal(
		normalized.storedPayload.bookedAt,
		"2026-08-06T10:00:00.000Z"
	);
	assert.equal(
		normalized.storedPayload.sourceUpdatedAt,
		"2026-08-06T11:00:00.000Z"
	);
	const reconstructed = normalizedFromStoredEvent({
		payload: normalized.storedPayload,
		messageUid: normalized.messageUid,
		hotelRunnerReservationId: normalized.hotelRunnerReservationId,
		sourceUpdatedAt: normalized.sourceUpdatedAt,
		payloadHash: normalized.payloadHash,
		canonicalHash: normalized.canonicalHash,
	});
	assert.equal(reconstructed.bookedAt.toISOString(), "2026-08-06T10:00:00.000Z");
	assert.equal(
		reconstructed.sourceUpdatedAt.toISOString(),
		"2026-08-06T11:00:00.000Z"
	);
});
