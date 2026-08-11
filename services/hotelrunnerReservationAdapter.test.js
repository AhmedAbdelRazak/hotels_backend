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
	createArchiveFingerprint,
} = require("./hotelrunnerFirstOtaFallback");
const {
	applyLiveSarConversion,
	buildHotelRunnerEmailCommercialEvidence,
	hotelRunnerEmailCommercialEvidenceHash,
	validateReservationOtaIdentityConsistency,
} = require("./otaReservationMapper");
const {
	buildAuthenticatedProviderCommercialEvidence,
	validateOtaCommercialEvidence,
} = require("./otaCommercialEvidence");
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
		find(filter = {}) {
			return queryResult(() => {
				if (
					Object.prototype.hasOwnProperty.call(
						filter,
						"supplierData.hotelRunner.reservationId"
					)
				) {
					return reservations.filter(
						(reservation) =>
							String(reservation.hotelId) === String(filter.hotelId) &&
							reservation.supplierData?.hotelRunner?.reservationId ===
								filter["supplierData.hotelRunner.reservationId"]
					);
		}
				return reservations;
			});
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

function authenticatedProviderPortalHandoffFixture({
	provider = "expedia",
	reportedRole = "hotel_payout",
	olderThanPortalWatermark = false,
	providerCollected = false,
	sourceType = "authenticated_provider_portal",
	equalCommercialRoles = false,
	evidenceHotelRunnerRole = "",
} = {}) {
	const system = createInMemoryProjectionSystem();
	const providerNumber = `${provider}-portal-handoff-101`;
	const providerLabel = provider === "booking" ? "Booking.com" : "Expedia";
	const channel = provider === "booking" ? "bookingcom" : "expedia";
	const sourceGross = 568.64;
	const sourcePayout = equalCommercialRoles ? sourceGross : 438.4;
	const propertyGross = 2132.4;
	const propertyPayout = equalCommercialRoles ? propertyGross : 1644;
	const propertyDeduction = Number((propertyGross - propertyPayout).toFixed(2));
	const reportedAmount =
		reportedRole === "guest_gross" ? sourceGross : sourcePayout;
	const normalized = normalizedMultiRoom({
		message_uid: `${provider}-portal-handoff-event`,
		reservation_id: `hr-${provider}-portal-handoff`,
		hr_number: `HR-${provider.toUpperCase()}-PORTAL-HANDOFF`,
		provider_number: providerNumber,
		channel,
		channel_display: providerLabel,
		source_display: providerLabel,
		currency: "USD",
		sub_total: reportedAmount.toFixed(2),
		item_total: reportedAmount.toFixed(2),
		total: reportedAmount.toFixed(2),
		paid_amount: "0",
		updated_at: "2026-08-06T12:00:00.000Z",
	});
	const pricing = buildPickedRoomsProjection(
		normalized,
		resolvedRooms(normalized),
		null,
		{ propertyCurrency: "SAR" }
	);
	const reservation = buildCreateReservationDocument({
		normalized,
		event: { _id: `${provider}-portal-handoff-create-event` },
		hotel: system.hotel,
		pricing,
		confirmationNumber: `PMS-${provider.toUpperCase()}-PORTAL-HANDOFF`,
		reservationMongoId: `64b0000000000000000000${
			provider === "booking" ? "89" : "88"
		}`,
		config: {},
	});
	const evidence = buildAuthenticatedProviderCommercialEvidence({
		provider,
		authenticatedProvider: provider,
		sourceAuthenticated: true,
		sourceTrusted: true,
		sourceType,
		sourceCurrency: "USD",
		propertyCurrency: "SAR",
		bookingBasis: "reservation_total",
		sourceHash: (provider === "booking" ? "b" : "e").repeat(64),
		sourceTimestamp: "2026-08-06T15:00:00.000Z",
		sourceId: `${provider}-provider-portal-handoff`,
		guestGross: { verified: true, amount: sourceGross },
		hotelPayout: { verified: true, amount: sourcePayout },
		...(evidenceHotelRunnerRole
			? {
					hotelRunnerReportedAmount: {
						amount:
							evidenceHotelRunnerRole === "guest_gross"
								? sourceGross
								: sourcePayout,
						currency: "USD",
						role: evidenceHotelRunnerRole,
						explicitRoleAssignment: true,
						provenance: {
							provider,
							sourceType: "hotelrunner_api",
							sourceHash: "f".repeat(64),
							sourceTimestamp: "2026-08-06T12:00:00.000Z",
							sourceId: `${provider}-hotelrunner-reported-amount`,
						},
					},
			  }
			: {}),
		currencyConversion: {
			trusted: true,
			verified: true,
			sourceCurrency: "USD",
			propertyCurrency: "SAR",
			rate: 3.75,
			provenance: {
				provider,
				sourceType: "trusted_exchange_evidence",
				sourceHash: (provider === "booking" ? "c" : "d").repeat(64),
				sourceTimestamp: "2026-08-06T15:00:00.000Z",
				sourceId: `${provider}-provider-portal-fx`,
			},
		},
	});
	assert.equal(validateOtaCommercialEvidence(evidence).ok, true);

	reservation.hr_number = "";
	reservation.reservation_id = providerNumber;
	reservation.booking_source = providerLabel;
	reservation.customer_details.booking_source = providerLabel;
	reservation.customer_details.confirmation_number2 = providerNumber;
	reservation.otaIdentityKey = `${provider}:${providerNumber}`;
	reservation.otaCrossTransportIdentityKey = "";
	reservation.state = "confirmed";
	reservation.reservation_status = "confirmed";
	reservation.currency = "SAR";
	reservation.total_amount = propertyGross;
	reservation.sub_total = 0;
	reservation.extras_total = 0;
	reservation.tax_total = 0;
	reservation.commission = 0;
	reservation.commission_ota = null;
	delete reservation.supplierData.hotelRunner;
	Object.assign(reservation.supplierData, {
		suppliedBookingNo: providerNumber,
		otaConfirmationNumber: providerNumber,
		platformConfirmationNumber: providerNumber,
		otaProvider: provider,
		otaAutomationPipeline: "ota-reservation-sync-orchestrator",
		otaSourceAuthority: 4,
		otaLastSourceReceivedAt: new Date(
			olderThanPortalWatermark
				? "2026-08-06T15:00:00.000Z"
				: "2026-08-06T11:00:00.000Z"
		),
		otaCommercialEvidence: evidence,
		otaCommercialEvidenceStaleReason: "",
		otaSourceCurrency: "USD",
		otaSourceAmount: sourceGross,
		otaAmount: sourceGross,
		otaAmountSar: propertyGross,
		otaTotalPayoutSar: propertyPayout,
		otaExpenseTotalSar: propertyDeduction,
		otaPayoutFallbackReason: "",
		otaPaymentCollectionModel: providerCollected
			? "ota_collect"
			: "hotel_collect",
		otaPaymentSummary: {
			sourceCurrency: "USD",
			sourceTotalGuestPaymentAmount: sourceGross,
			sourceTotalPayoutAmount: sourcePayout,
			totalGuestPaymentAmount: propertyGross,
			totalPayoutAmount: propertyPayout,
			currency: "SAR",
		},
	});
	reservation.adminPricing = {
		...(reservation.adminPricing || {}),
		clientTotal: propertyGross,
		netAfterExpensesTotal: propertyPayout,
		otaExpenseTotal: propertyDeduction,
		commercialResolution: "verified",
		commercialVerified: true,
		payoutFallbackReason: "",
		sourceCurrency: "USD",
		propertyCurrency: "SAR",
		sourceAmount: sourceGross,
	};
	reservation.ota_financial_summary = {
		...(reservation.ota_financial_summary || {}),
		show: true,
		currency: "SAR",
		clientTotal: propertyGross,
		netAfterExpenses: propertyPayout,
		netAfterOtaExpenses: propertyPayout,
		otaExpenseTotal: propertyDeduction,
		commercialVerified: true,
		payoutFallbackReason: "",
		sourceCurrency: "USD",
		sourceAmount: sourceGross,
		paymentSummary: reservation.supplierData.otaPaymentSummary,
	};
	const grossSlots = allocateCents(
		propertyGross * 100,
		reservation.pickedRoomsType
			.flatMap((room) => room.pricingByDay)
			.map(() => 1)
	);
	const payoutSlots = allocateCents(
		propertyPayout * 100,
		reservation.pickedRoomsType
			.flatMap((room) => room.pricingByDay)
			.map(() => 1)
	);
	let slot = 0;
	for (const room of reservation.pickedRoomsType) {
		for (const day of room.pricingByDay) {
			const gross = grossSlots[slot] / 100;
			const payout = payoutSlots[slot] / 100;
			day.price = gross;
			day.clientPrice = gross;
			day.mainPrice = gross;
			day.totalPriceWithCommission = gross;
			day.netAfterExpenses = payout;
			day.netAfterOtaExpenses = payout;
			day.otaExpenseAmount = Number((gross - payout).toFixed(2));
			slot += 1;
		}
		room.totalPriceWithCommission = Number(
			room.pricingByDay
				.reduce((sum, day) => sum + day.totalPriceWithCommission, 0)
				.toFixed(2)
		);
	}
	reservation.pickedRoomsPricing = JSON.parse(
		JSON.stringify(reservation.pickedRoomsType)
	);
	reservation.paid_amount = providerCollected ? propertyGross : 0;
	reservation.paid_amount_breakdown = {
		paid_online_via_link: 0,
		paid_at_hotel_cash: 0,
		paid_at_hotel_card: 0,
		paid_to_hotel: 0,
		paid_online_jannatbooking: 0,
		paid_online_other_platforms: providerCollected ? propertyGross : 0,
		paid_online_via_instapay: 0,
		paid_no_show: 0,
		payment_comments: providerCollected
			? `${providerLabel} collected by platform`
			: `${providerLabel} hotel collect`,
	};
	reservation.payment_details = { captured: false, onsite_paid_amount: 0 };
	reservation.financial_cycle = {
		collectionModel: providerCollected ? "pms_collected" : "pending",
		status: "open",
		commissionType: "amount",
		commissionValue: 0,
		commissionAmount: 0,
		commissionAssigned: false,
		pmsCollectedAmount: providerCollected ? propertyGross : 0,
		hotelCollectedAmount: 0,
		hotelPayoutDue: 0,
		commissionDueToPms: 0,
	};
	system.reservations.push(reservation);
	system.dependencies.loadEmailCommercialBridge = async () => ({
		ok: false,
		reason: "commercial_evidence_not_found",
		amountRole: "",
	});
	return {
		system,
		normalized,
		reservation,
		evidence,
		providerNumber,
		reportedRole,
	};
}

function authenticatedProviderHotelRunnerSourceProjection(
	system,
	normalized,
	reservation
) {
	const pricing = buildPickedRoomsProjection(
		normalized,
		resolvedRooms(normalized),
		reservation,
		{ propertyCurrency: system.hotel.currency }
	);
	assert.equal(pricing.ok, true);
	return projectionFromIncoming(normalized, pricing);
}

function portalCommercialSnapshot(reservation) {
	return JSON.parse(
		JSON.stringify({
			state: reservation.state,
			reservation_status: reservation.reservation_status,
			reservation_id: reservation.reservation_id,
			customer_details: reservation.customer_details,
			comment: reservation.comment,
			booking_comment: reservation.booking_comment,
			total_amount: reservation.total_amount,
			sub_total: reservation.sub_total,
			extras_total: reservation.extras_total,
			tax_total: reservation.tax_total,
			currency: reservation.currency,
			commission: reservation.commission,
			commission_ota: reservation.commission_ota,
			pickedRoomsType: reservation.pickedRoomsType,
			pickedRoomsPricing: reservation.pickedRoomsPricing,
			paid_amount: reservation.paid_amount,
			paid_amount_breakdown: reservation.paid_amount_breakdown,
			payment_details: reservation.payment_details,
			financial_cycle: reservation.financial_cycle,
			adminPricing: reservation.adminPricing,
			ota_financial_summary: reservation.ota_financial_summary,
			otaCommercialEvidence: reservation.supplierData.otaCommercialEvidence,
			otaCommercialEvidenceStaleReason:
				reservation.supplierData.otaCommercialEvidenceStaleReason,
			otaPaymentSummary: reservation.supplierData.otaPaymentSummary,
			otaTotalPayoutSar: reservation.supplierData.otaTotalPayoutSar,
			otaExpenseTotalSar: reservation.supplierData.otaExpenseTotalSar,
			otaPayoutFallbackReason: reservation.supplierData.otaPayoutFallbackReason,
			otaSourceCurrency: reservation.supplierData.otaSourceCurrency,
			otaSourceAmount: reservation.supplierData.otaSourceAmount,
			otaAmount: reservation.supplierData.otaAmount,
			otaAmountSar: reservation.supplierData.otaAmountSar,
		})
	);
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

async function canonicalReleasedHotelRunnerFixture({
	finance = false,
	housing = false,
	sourceState = "confirmed",
} = {}) {
	const system = createInMemoryProjectionSystem();
	system.config.requireOtaReview = true;
	const initial = normalizedMultiRoom({
		message_uid: "canonical-release-initial",
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
	const reservation = system.reservations[0];
	const releasedAt = new Date("2026-08-06T11:30:00.000Z");
	const actor = {
		_id: "64b000000000000000000777",
		name: "Platform Admin",
		email: "platform-admin@example.test",
		role: "admin",
	};
	reservation.state = "Pending Confirmation";
	reservation.reservation_status = "Pending Confirmation";
	reservation.pendingConfirmation = {
		...(reservation.pendingConfirmation || {}),
		status: "pending",
		source: "ota_platform_release",
		releasedToHotelAt: releasedAt,
		lastUpdatedAt: releasedAt,
		lastUpdatedBy: structuredClone(actor),
	};
	reservation.otaPlatformReview = {
		...(reservation.otaPlatformReview || {}),
		status: "released",
		releasedAt,
		releasedBy: structuredClone(actor),
		priceAtRelease: reservation.adminPricing.rootTotal,
	};
	reservation.adminPricingVisibility = {
		...(reservation.adminPricingVisibility || {}),
		rootOnlyForHotelManagement: true,
		source: "ota_platform_release",
		appliedAt: releasedAt,
		appliedBy: actor._id,
	};
	reservation.supplierData.hotelRunner.sourceState = sourceState;
	if (finance) {
		attachVerifiedHotelRunnerEmailCommercialEvidence(reservation);
		reservation.paypal_details = {
			status: "captured",
			captured_total_sar: reservation.total_amount,
			capture_id: "release-protected-capture",
		};
		reservation.moneyTransferredToHotel = true;
	}
	if (housing) {
		reservation.roomId = [LOCAL_DOUBLE_ID, LOCAL_TRIPLE_ID];
		reservation.bedNumber = ["201-A", "305-B"];
		reservation.housedBy = {
			_id: "64b000000000000000000778",
			name: "Hotel Operations",
			role: "hotel employee",
		};
	}
	return { system, reservation, releasedAt, actor };
}

function deleteDottedPath(target, path) {
	const parts = String(path).split(".");
	let cursor = target;
	for (const part of parts.slice(0, -1)) {
		if (!cursor || typeof cursor !== "object") return;
		cursor = cursor[part];
	}
	if (cursor && typeof cursor === "object") {
		delete cursor[parts[parts.length - 1]];
	}
}

const RELEASED_HOTELRUNNER_MUTABLE_PATHS = [
	"state",
	"reservation_status",
	"pendingConfirmation.status",
	"pendingConfirmation.confirmedAt",
	"pendingConfirmation.cancelledAt",
	"pendingConfirmation.inventoryBlocks",
	"pendingConfirmation.lastUpdatedAt",
	"supplierData.hotelRunner.transport",
	"supplierData.hotelRunner.reservationId",
	"supplierData.hotelRunner.sourceState",
	"supplierData.hotelRunner.lastMessageUid",
	"supplierData.hotelRunner.appliedSourceUpdatedAt",
	"supplierData.hotelRunner.appliedCanonicalHash",
	"supplierData.hotelRunner.lastAppliedAt",
	"supplierData.otaAutomationPipeline",
	"supplierData.otaSourceAuthority",
	"supplierData.otaLastSourceReceivedAt",
	"supplierData.otaLastEventType",
	"reservationAuditLog",
	"__v",
	"updatedAt",
];

function releasedProtectedSnapshot(reservation) {
	const snapshot = structuredClone(reservation);
	for (const path of RELEASED_HOTELRUNNER_MUTABLE_PATHS) {
		deleteDottedPath(snapshot, path);
	}
	return snapshot;
}

async function projectFixtureEvent(system, normalized) {
	return projectHotelRunnerReservation(
		{
			normalized,
			event: { payload: normalized.storedPayload },
			hotel: system.hotel,
			config: system.config,
		},
		system.dependencies
	);
}

function sanitizedAgodaCriticalHandoffFixture() {
	const system = createInMemoryProjectionSystem();
	system.config.requireOtaReview = true;
	const providerNumber = "SANITIZED-AGODA-YCS-42";
	const normalized = normalizedMultiRoom({
		message_uid: "sanitized-agodaycs5-critical-handoff",
		reservation_id: "sanitized-hotelrunner-reservation",
		hr_number: "SANITIZED-HR-NUMBER",
		provider_number: providerNumber,
		channel: "agodaycs5",
		channel_display: "Agoda",
		source_display: "Agoda",
		sub_total: "363.78",
		item_total: "363.78",
		total: "363.78",
		paid_amount: "0",
		rooms: [
			rawRoom({
				id: "sanitized-room-1",
				invCode: "INV-DOUBLE",
				name: "Double Room",
				prices: ["90.95", "90.94"],
			}),
			rawRoom({
				id: "sanitized-room-2",
				invCode: "INV-TRIPLE",
				name: "Triple Room",
				prices: ["90.95", "90.94"],
				adults: 2,
				children: 1,
			}),
		],
	});
	const pricing = buildPickedRoomsProjection(normalized, resolvedRooms(normalized));
	const existing = buildCreateReservationDocument({
		normalized,
		event: { _id: "sanitized-email-event" },
		hotel: system.hotel,
		pricing,
		confirmationNumber: "PMS-SANITIZED-AGODA",
		reservationMongoId: "64b000000000000000000096",
		config: { requireOtaReview: true },
	});

	// Model the email-created representation before HotelRunner takes ownership:
	// the stay and total room count agree, but local room ownership is not yet the
	// explicit API mapping and therefore produces a critical projection change.
	existing.pickedRoomsType = existing.pickedRoomsType.map((room) => ({
		...room,
		hotelRoomConfigId: "",
		localRoomConfigId: "",
	}));
	existing.total_amount = 588;
	existing.currency = "SAR";
	existing.otaIdentityKey = `agoda:${providerNumber.toLowerCase()}`;
	existing.reservation_id = providerNumber;
	existing.supplierData.otaProvider = "agoda";
	existing.supplierData.otaAutomationPipeline = "ota-email-orchestrator";
	existing.supplierData.otaSourceAuthority = 3;
	existing.supplierData.otaInboundEmailId = "64b000000000000000000095";
	delete existing.supplierData.hotelRunner;
	delete existing.supplierData.otaCommercialEvidence;

	const evidenceWithoutHash = {
		version: 1,
		verified: true,
		source: "authenticated_ota_email",
		provider: "agoda",
		otaIdentityKey: `agoda:${providerNumber.toLowerCase()}`,
		grossTotalSar: 588,
		payoutTotalSar: 363.78,
		otaExpenseTotalSar: 224.22,
		currency: "SAR",
		inboundEmailId: "64b000000000000000000095",
		sourceTextHash: "8".repeat(64),
		sourceReceivedAt: "2026-08-09T15:28:53.811Z",
		appliedAt: new Date("2026-08-09T15:29:04.176Z"),
	};
	const evidence = {
		...evidenceWithoutHash,
		evidenceHash: hotelRunnerEmailCommercialEvidenceHash(evidenceWithoutHash),
	};
	const paymentSummary = {
		sourceCurrency: "SAR",
		sourceTotalGuestPaymentAmount: 588,
		sourceTotalPayoutAmount: 363.78,
		totalGuestPaymentAmount: 588,
		totalPayoutAmount: 363.78,
		currency: "SAR",
		exchangeRateToSar: 1,
	};
	existing.supplierData.hotelRunnerEmailCommercialEvidence = evidence;
	existing.supplierData.otaAmountSar = 588;
	existing.supplierData.otaTotalPayoutSar = 363.78;
	existing.supplierData.otaExpenseTotalSar = 224.22;
	existing.supplierData.otaPayoutFallbackReason = "";
	existing.supplierData.otaPaymentSummary = paymentSummary;
	existing.adminPricing.clientTotal = 588;
	existing.adminPricing.netAfterExpensesTotal = 363.78;
	existing.adminPricing.otaExpenseTotal = 224.22;
	existing.adminPricing.defaultDeductionApplied = false;
	existing.adminPricing.payoutFallbackReason = "";
	existing.adminPricing.commercialVerified = true;
	existing.ota_financial_summary.clientTotal = 588;
	existing.ota_financial_summary.netAfterExpenses = 363.78;
	existing.ota_financial_summary.netAfterOtaExpenses = 363.78;
	existing.ota_financial_summary.otaExpenseTotal = 224.22;
	existing.ota_financial_summary.payoutFallbackReason = "";
	existing.ota_financial_summary.paymentSummary = paymentSummary;
	existing.ota_financial_summary.commercialVerified = true;
	existing.ota_financial_summary.show = true;
	system.reservations.push(existing);

	const bridge = {
		ok: true,
		reason: "",
		amountRole: "payout",
		grossTotalSar: 588,
		sourceCurrency: "SAR",
		sourceAmount: 588,
		hotelRunnerAmount: 363.78,
		evidence,
	};
	system.dependencies.loadEmailCommercialBridge = async () => bridge;
	return { system, normalized, pricing, existing, evidence, bridge };
}

function queuedEmailBridgeFromInbound(inbound, {
	amountRole = "payout",
	hotelRunnerAmount,
	jobId = "64b000000000000000000501",
	inboundEmailId = inbound.inboundEmailId || "64b000000000000000000502",
} = {}) {
	const evidence = buildHotelRunnerEmailCommercialEvidence(inbound, {
		appliedAt: new Date("2026-08-09T06:01:00.000Z"),
	});
	assert.ok(evidence, "queued inbound fixture must have verified commercial evidence");
	return {
		ok: true,
		reason: "",
		amountRole,
		grossTotalSar: evidence.grossTotalSar,
		sourceCurrency: inbound.sourceCurrency,
		sourceAmount: inbound.sourceAmount,
		hotelRunnerAmount,
		evidence,
		jobId,
		inboundEmailId,
		inboundEmailHash: "1".repeat(64),
		normalizedReservationHash: "2".repeat(64),
		resolvedHotelProofHash: "5".repeat(64),
		archiveFingerprint: "3".repeat(64),
		normalizedReservation: inbound,
	};
}

function directQueuedInbound(overrides = {}) {
	return {
		inboundEmailId: "64b000000000000000000502",
		provider: "agoda",
		trustedTransportProvider: "agoda",
		confirmationNumber: "2039878308",
		reservationId: "2039878308",
		intent: "new_reservation",
		eventType: "new",
		sourceSenderTrusted: true,
		sourceSenderAuthenticated: true,
		requiresManualReview: false,
		hotelName: "Zad AJYAD Hotel",
		roomName: "Double Room â€“ Comfort",
		checkinDate: "2026-08-10",
		checkoutDate: "2026-08-12",
		roomCount: 1,
		amount: 95.06,
		totalAmountSar: 95.06,
		sourceAmount: 95.06,
		sourceCurrency: "SAR",
		currency: "SAR",
		propertyCurrency: "SAR",
		propertyConversionVerified: true,
		totalPayoutSar: 58.82,
		netAfterExpensesTotal: 58.82,
		exchangeRateToSar: 1,
		exchangeRateSource: "identity",
		paidOnline: true,
		paymentCollectionModel: "ota_collect",
		paymentInstructions: "OTA collected payment",
		paymentSummary: {
			sourceCurrency: "SAR",
			sourceTotalGuestPaymentAmount: 95.06,
			sourceTotalPayoutAmount: 58.82,
			totalGuestPaymentAmount: 95.06,
			totalPayoutAmount: 58.82,
			currency: "SAR",
			exchangeRateToSar: 1,
			exchangeRateSource: "identity",
		},
		sourcePresence: {
			confirmationNumber: true,
			hotelName: true,
			roomName: true,
			checkinDate: true,
			checkoutDate: true,
			roomCount: true,
			amount: true,
			paymentCollectionModel: true,
			paymentInstructions: true,
		},
		source: {
			receivedAt: "2026-08-09T05:59:00.000Z",
			textHash: "4".repeat(64),
		},
		...overrides,
	};
}

async function storedFxTripQueuedInbound(
	overrides = {},
	{ conversionRate = 3.8 } = {}
) {
	const sourceTimestamp = "2026-08-09T00:00:00.000Z";
	const base = directQueuedInbound({
		provider: "trip",
		trustedTransportProvider: "trip",
		confirmationNumber: "1653715890127438",
		reservationId: "1653715890127438",
		amount: null,
		totalAmountSar: null,
		sourceAmount: 21.4,
		sourceCurrency: "USD",
		currency: "USD",
		propertyCurrency: "SAR",
		propertyConversionVerified: false,
		totalPayoutSar: null,
		netAfterExpensesTotal: null,
		exchangeRateToSar: null,
		exchangeRateSource: "",
		paymentSummary: {
			sourceCurrency: "USD",
			sourceTotalGuestPaymentAmount: 21.4,
			sourceTotalPayoutAmount: 18.2,
			sourceTotalPayoutCurrency: "USD",
			totalGuestPaymentAmount: null,
			totalPayoutAmount: null,
			currency: null,
			exchangeRateToSar: null,
		},
		...overrides,
	});
	const live = await applyLiveSarConversion(base, {
		apiKey: "adapter-queued-trip-fx",
		cache: new Map(),
		now: () => Date.parse("2026-08-09T06:00:00.000Z"),
		fetchImpl: async () => ({
			ok: true,
			async json() {
				return {
					result: "success",
					base_code: "USD",
					target_code: "SAR",
					conversion_rate: conversionRate,
					time_last_update_unix: Date.parse(sourceTimestamp) / 1000,
				};
			},
		}),
	});
	return applyLiveSarConversion(live, {
		rateLookup: async () => null,
	});
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

test("Expedia HotelRunner USD total stays unresolved while six PMS root nights remain SAR 534", () => {
	const dates = ["05", "06", "07", "08", "09", "10"].map(
		(day) => `2026-10-${day}`
	);
	const normalized = {
		messageUid: "exact-expedia-hotelrunner-event",
		hotelRunnerReservationId: "40371346",
		hrNumber: "R166595975",
		providerNumber: "2530158461",
		channel: "expedia",
		channelDisplay: "Expedia",
		sourceDisplay: "Expedia",
		state: "confirmed",
		guestName: "Redacted Guest",
		checkinDate: "2026-10-05",
		checkoutDate: "2026-10-11",
		bookedAt: new Date("2026-08-09T03:00:00.000Z"),
		sourceUpdatedAt: new Date("2026-08-09T03:01:00.000Z"),
		payloadHash:
			"4783f5ad70a7df6c6c432d7179b044a4045d6c555d31d7d13bada059b9fef01d",
		currency: "USD",
		totalCents: 11292,
		extrasTotalCents: 0,
		taxTotalCents: 0,
		paidAmountCents: 11292,
		totalGuests: 2,
		paymentMethod: "Bank Transfer",
		rooms: [
			{
				roomId: "hotelrunner-room-exact",
				invCode: "INV-EXACT",
				name: "Double Room",
				namePresentation: "Double Room / Room Only",
				adults: 2,
				children: 0,
				dailyPrices: dates.map((date) => ({
					date,
					priceCents: 1882,
				})),
			},
		],
	};
	const roomDetails = {
		_id: LOCAL_DOUBLE_ID,
		roomType: "doubleRooms",
		displayName: "Double Room",
		defaultCost: 89,
		pricingRate: dates.map((calendarDate) => ({
			calendarDate,
			rootPrice: 89,
		})),
	};
	const pricing = buildPickedRoomsProjection(
		normalized,
		[
			{
				sourceRoom: normalized.rooms[0],
				mapping: { invCode: "INV-EXACT", status: "active" },
				roomDetails,
			},
		],
		null,
		{ propertyCurrency: "SAR" }
	);

	assert.equal(pricing.ok, true);
	assert.equal(pricing.clientTotal, null);
	assert.equal(pricing.sourceTotal, 112.92);
	assert.equal(pricing.rootTotal, 534);
	assert.ok(
		pricing.pickedRooms[0].pricingByDay.every(
			(day) =>
				day.rootPrice === 89 &&
				day.clientPrice === null &&
				day.netAfterExpenses === null &&
				day.hotelRunnerSourcePrice === 18.82
		)
	);

	const document = buildCreateReservationDocument({
		normalized,
		event: { _id: "event-exact-expedia" },
		hotel: {
			_id: "6a40b6a1a6efe70450536038",
			belongsTo: "64b000000000000000000002",
			currency: "SAR",
		},
		pricing,
		confirmationNumber: "7255791395",
		reservationMongoId: "6a77efde7735a50431e27126",
	});
	assert.equal(document.sub_total, 534);
	assert.equal(document.total_amount, null);
	assert.equal(document.adminPricing.clientTotal, null);
	assert.equal(document.adminPricing.netAfterExpensesTotal, null);
	assert.equal(
		document.supplierData.otaCommercialEvidence.hotelRunnerReportedAmount.amount,
		112.92
	);
	assert.equal(
		document.supplierData.otaCommercialEvidence.hotelRunnerReportedAmount.role,
		"unknown"
	);
	assert.equal(
		document.supplierData.otaCommercialEvidence.roles.hotelBase.verified,
		false
	);
});

test("multi-room projection preserves source allocation without assigning an external OTA role", () => {
	const normalized = normalizedMultiRoom();
	assert.deepEqual(normalized.issues, []);
	const pricing = buildPickedRoomsProjection(
		normalized,
		resolvedRooms(normalized)
	);

	assert.equal(pricing.ok, true);
	assert.equal(pricing.clientTotal, null);
	assert.equal(pricing.sourceTotal, 100.01);
	assert.equal(pricing.amountRole, "unknown");
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
		[null, null, null, null]
	);
	assert.deepEqual(
		pricing.pickedRooms.flatMap((room) =>
			room.pricingByDay.map((day) => day.hotelRunnerSourcePrice)
		),
		[100, 200, 300, 400]
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
	assert.equal(document.total_amount, null);
	assert.equal(document.extras_total, null);
	assert.equal(document.tax_total, null);
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
	assert.equal(document.adminPricing.sourceAmount, 100.01);
	assert.equal(document.adminPricing.hotelRunnerAmountRole, "unknown");
	assert.equal(
		validateOtaCommercialEvidence(
			document.supplierData.otaCommercialEvidence
		).ok,
		true
	);
	assert.equal(
		document.supplierData.otaCommercialEvidence.hotelRunnerReportedAmount.role,
		"unknown"
	);
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

test("Trip source-currency API lifecycle cannot bridge property money without verified evidence", async () => {
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

	assert.equal(result.status, "quarantined");
	assert.equal(result.code, "hotelrunner_currency_requires_review");
	assert.equal(system.reservations.length, 1);
	assert.equal(String(system.reservations[0]._id), String(existing._id));
	assert.equal(system.reservations[0].total_amount, 70.43);
	assert.equal(system.reservations[0].currency, "SAR");
	assert.equal(system.reservations[0].commission, 15);
	assert.equal(system.reservations[0].commission_ota, null);
	assert.equal(system.reservations[0].state, "OTA Platform Review");
	assert.equal(system.reservations[0].supplierData.hotelRunner, undefined);
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

test("an older Expedia payout event performs one exact metadata-only portal handoff without touching provider money or lifecycle", async () => {
	const { system, normalized, reservation, evidence } =
		authenticatedProviderPortalHandoffFixture({
			provider: "expedia",
			reportedRole: "hotel_payout",
			olderThanPortalWatermark: true,
			providerCollected: true,
		});
	assert.equal(hasFinanceOrSettlementActivity(reservation), true);
	const commercialBefore = portalCommercialSnapshot(reservation);
	const portalWatermark = reservation.supplierData.otaLastSourceReceivedAt;

	const result = await projectHotelRunnerReservation(
		{
			normalized,
			event: {
				_id: "expedia-provider-portal-event",
				payload: normalized.storedPayload,
			},
			hotel: system.hotel,
			config: system.config,
		},
		system.dependencies
	);

	assert.equal(result.status, "updated");
	assert.equal(result.code, "hotelrunner_older_authenticated_provider_handoff");
	assert.equal(result.metadataOnly, true);
	assert.equal(result.hotelRunnerAmountRole, "hotel_payout");
	assert.equal(system.reservations.length, 1);
	assert.deepEqual(portalCommercialSnapshot(reservation), commercialBefore);
	assert.equal(reservation.hr_number, normalized.hrNumber);
	assert.equal(
		reservation.supplierData.hotelRunner.reservationId,
		normalized.hotelRunnerReservationId
	);
	assert.equal(
		reservation.supplierData.hotelRunner.appliedCanonicalHash,
		normalized.canonicalHash
	);
	assert.match(
		reservation.supplierData.hotelRunner.metadataHandoffProjectionHash,
		/^[a-f0-9]{64}$/
	);
	assert.equal(
		reservation.supplierData.otaAutomationPipeline,
		"hotelrunner-background-worker"
	);
	assert.equal(reservation.supplierData.otaSourceAuthority, 4);
	assert.equal(
		reservation.supplierData.otaLastSourceReceivedAt,
		portalWatermark,
		"the provider collector watermark must not be rolled back"
	);
	assert.equal(
		reservation.supplierData.otaCommercialEvidence.evidenceHash,
		evidence.evidenceHash
	);
	assert.equal(system.mirror.reservationMongoId, reservation._id);
	assert.equal(system.mirror.appliedCanonicalHash, normalized.canonicalHash);
	assert.equal(system.mirror.lastResult.metadataOnly, true);
});

test("a newer Booking.com gross event uses the same provider-generic portal proof and preserves commercial facts", async () => {
	const { system, normalized, reservation, evidence } =
		authenticatedProviderPortalHandoffFixture({
			provider: "booking",
			reportedRole: "guest_gross",
		});
	const commercialBefore = portalCommercialSnapshot(reservation);

	const result = await projectHotelRunnerReservation(
		{
			normalized,
			event: {
				_id: "booking-provider-portal-event",
				payload: normalized.storedPayload,
			},
			hotel: system.hotel,
			config: system.config,
		},
		system.dependencies
	);

	assert.equal(result.status, "updated");
	assert.equal(result.commercialProtected, true);
	assert.deepEqual(portalCommercialSnapshot(reservation), commercialBefore);
	assert.equal(
		reservation.supplierData.hotelRunner.reservationId,
		normalized.hotelRunnerReservationId
	);
	assert.equal(
		reservation.supplierData.otaCommercialEvidence.evidenceHash,
		evidence.evidenceHash
	);
	assert.equal(
		reservation.supplierData.otaAutomationPipeline,
		"hotelrunner-background-worker"
	);
	assert.equal(reservation.supplierData.otaSourceAuthority, 4);
});

test("an older Booking.com gross event uses the provider-generic metadata-only handoff", async () => {
	const { system, normalized, reservation } =
		authenticatedProviderPortalHandoffFixture({
			provider: "booking",
			reportedRole: "guest_gross",
			olderThanPortalWatermark: true,
		});
	const commercialBefore = portalCommercialSnapshot(reservation);
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
	assert.equal(result.code, "hotelrunner_older_authenticated_provider_handoff");
	assert.equal(result.metadataOnly, true);
	assert.equal(result.hotelRunnerAmountRole, "guest_gross");
	assert.deepEqual(portalCommercialSnapshot(reservation), commercialBefore);
});

test("explicit authenticated provider API evidence can bridge the same exact existing-record gate", async () => {
	const { system, normalized, reservation } =
		authenticatedProviderPortalHandoffFixture({
			provider: "expedia",
			reportedRole: "hotel_payout",
			sourceType: "authenticated_provider_api",
		});
	const commercialBefore = portalCommercialSnapshot(reservation);
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
	assert.equal(result.commercialProtected, true);
	assert.deepEqual(portalCommercialSnapshot(reservation), commercialBefore);
});

test("an older event cannot metadata-link a locally terminal provider reservation", async () => {
	const { system, normalized, reservation } =
		authenticatedProviderPortalHandoffFixture({
			olderThanPortalWatermark: true,
		});
	reservation.state = "cancelled";
	reservation.reservation_status = "cancelled";
	const before = portalCommercialSnapshot(reservation);
	const result = await projectHotelRunnerReservation(
		{
			normalized,
			event: { payload: normalized.storedPayload },
			hotel: system.hotel,
			config: system.config,
		},
		system.dependencies
	);
	assert.equal(result.status, "ignored");
	assert.equal(result.code, "hotelrunner_stale_against_pms_watermark");
	assert.equal(system.reservationWrites.length, 0);
	assert.deepEqual(portalCommercialSnapshot(reservation), before);
	assert.equal(reservation.supplierData.hotelRunner, undefined);
});

test("metadata-only handoff retry finishes only the mirror after a post-reservation mirror failure", async () => {
	const { system, normalized, reservation } =
		authenticatedProviderPortalHandoffFixture({
			olderThanPortalWatermark: true,
			providerCollected: true,
		});
	const expectedSourceProjection =
		authenticatedProviderHotelRunnerSourceProjection(
			system,
			normalized,
			reservation
		);
	const commercialBefore = portalCommercialSnapshot(reservation);
	const portalWatermark = reservation.supplierData.otaLastSourceReceivedAt;
	const originalMirrorUpdateOne = system.MirrorModel.updateOne.bind(
		system.MirrorModel
	);
	let failAppliedMirrorOnce = true;
	system.MirrorModel.updateOne = (filter, update) => {
		if (failAppliedMirrorOnce && update?.$set?.appliedCanonicalHash) {
			return queryResult(() => {
				failAppliedMirrorOnce = false;
				throw new Error(
					"synthetic mirror write failure after reservation metadata"
				);
			});
		}
		return originalMirrorUpdateOne(filter, update);
	};

	await assert.rejects(
		projectHotelRunnerReservation(
			{
				normalized,
				event: { payload: normalized.storedPayload },
				hotel: system.hotel,
				config: system.config,
			},
			system.dependencies
		),
		/synthetic mirror write failure/
	);
	assert.equal(system.reservationWrites.length, 1);
	assert.equal(system.mirror.appliedCanonicalHash, "");
	assert.equal(
		reservation.supplierData.hotelRunner.appliedCanonicalHash,
		normalized.canonicalHash
	);
	assert.deepEqual(portalCommercialSnapshot(reservation), commercialBefore);
	assert.equal(
		reservation.supplierData.otaLastSourceReceivedAt,
		portalWatermark
	);

	const recovered = await projectHotelRunnerReservation(
		{
			normalized,
			event: { payload: normalized.storedPayload },
			hotel: system.hotel,
			config: system.config,
		},
		system.dependencies
	);
	assert.equal(recovered.status, "updated");
	assert.equal(
		recovered.code,
		"hotelrunner_authenticated_provider_mirror_recovered"
	);
	assert.equal(recovered.mirrorRecovery, true);
	assert.equal(system.reservationWrites.length, 1);
	assert.equal(system.mirror.appliedCanonicalHash, normalized.canonicalHash);
	assert.equal(system.mirror.lastResult.mirrorRecovery, true);
	assert.deepEqual(
		system.mirror.lastAppliedProjection,
		expectedSourceProjection,
		"mirror-only recovery must restore the HotelRunner source assertion, not claim the provider portal projection"
	);
	assert.deepEqual(portalCommercialSnapshot(reservation), commercialBefore);
	assert.equal(
		reservation.supplierData.otaLastSourceReceivedAt,
		portalWatermark
	);
});

test("mirror recovery rejects a post-metadata projection change without a second reservation write", async () => {
	const { system, normalized, reservation } =
		authenticatedProviderPortalHandoffFixture({
			olderThanPortalWatermark: true,
			providerCollected: true,
		});
	const originalMirrorUpdateOne = system.MirrorModel.updateOne.bind(
		system.MirrorModel
	);
	let failAppliedMirrorOnce = true;
	system.MirrorModel.updateOne = (filter, update) => {
		if (failAppliedMirrorOnce && update?.$set?.appliedCanonicalHash) {
			return queryResult(() => {
				failAppliedMirrorOnce = false;
				throw new Error(
					"synthetic mirror write failure before projection drift"
				);
			});
		}
		return originalMirrorUpdateOne(filter, update);
	};
	await assert.rejects(
		projectHotelRunnerReservation(
			{
				normalized,
				event: { payload: normalized.storedPayload },
				hotel: system.hotel,
				config: system.config,
			},
			system.dependencies
		),
		/synthetic mirror write failure/
	);
	assert.equal(system.reservationWrites.length, 1);
	const storedProjectionHash =
		reservation.supplierData.hotelRunner.metadataHandoffProjectionHash;
	reservation.customer_details.name = "Legacy writer changed the guest";
	reservation.total_amount += 1;

	const rejected = await projectHotelRunnerReservation(
		{
			normalized,
			event: { payload: normalized.storedPayload },
			hotel: system.hotel,
			config: system.config,
		},
		system.dependencies
	);
	assert.equal(rejected.status, "quarantined");
	assert.equal(
		rejected.code,
		"hotelrunner_authenticated_provider_mirror_recovery_rejected"
	);
	assert.equal(rejected.handoffReason, "metadata_projection_hash_mismatch");
	assert.equal(system.reservationWrites.length, 1);
	assert.equal(system.mirror.appliedCanonicalHash, "");
	assert.equal(system.mirror.projectionStatus, "quarantined");
	assert.equal(
		reservation.supplierData.hotelRunner.metadataHandoffProjectionHash,
		storedProjectionHash
	);
});

test("mirror recovery quarantines a corrupt nonempty handoff hash instead of entering the normal update path", async () => {
	const { system, normalized, reservation } =
		authenticatedProviderPortalHandoffFixture({
			olderThanPortalWatermark: true,
			providerCollected: true,
		});
	const originalMirrorUpdateOne = system.MirrorModel.updateOne.bind(
		system.MirrorModel
	);
	let failAppliedMirrorOnce = true;
	system.MirrorModel.updateOne = (filter, update) => {
		if (failAppliedMirrorOnce && update?.$set?.appliedCanonicalHash) {
			return queryResult(() => {
				failAppliedMirrorOnce = false;
				throw new Error("synthetic mirror failure before hash corruption");
			});
		}
		return originalMirrorUpdateOne(filter, update);
	};
	await assert.rejects(
		projectHotelRunnerReservation(
			{
				normalized,
				event: { payload: normalized.storedPayload },
				hotel: system.hotel,
				config: system.config,
			},
			system.dependencies
		),
		/synthetic mirror failure/
	);
	assert.equal(system.reservationWrites.length, 1);
	reservation.supplierData.hotelRunner.metadataHandoffProjectionHash =
		"corrupt-handoff-hash";

	const rejected = await projectHotelRunnerReservation(
		{
			normalized,
			event: { payload: normalized.storedPayload },
			hotel: system.hotel,
			config: system.config,
		},
		system.dependencies
	);
	assert.equal(rejected.status, "quarantined");
	assert.equal(
		rejected.code,
		"hotelrunner_authenticated_provider_mirror_recovery_rejected"
	);
	assert.equal(rejected.handoffReason, "metadata_projection_hash_invalid");
	assert.equal(system.reservationWrites.length, 1);
	assert.equal(system.mirror.appliedCanonicalHash, "");
	assert.equal(system.mirror.projectionStatus, "quarantined");
});

test("a normal newer provider update without a handoff hash retries through its ordinary apply path", async () => {
	const { system, normalized, reservation } =
		authenticatedProviderPortalHandoffFixture({
			provider: "booking",
			reportedRole: "guest_gross",
		});
	const commercialBefore = portalCommercialSnapshot(reservation);
	const originalMirrorUpdateOne = system.MirrorModel.updateOne.bind(
		system.MirrorModel
	);
	let failAppliedMirrorOnce = true;
	system.MirrorModel.updateOne = (filter, update) => {
		if (failAppliedMirrorOnce && update?.$set?.appliedCanonicalHash) {
			return queryResult(() => {
				failAppliedMirrorOnce = false;
				throw new Error("synthetic ordinary mirror failure");
			});
		}
		return originalMirrorUpdateOne(filter, update);
	};
	await assert.rejects(
		projectHotelRunnerReservation(
			{
				normalized,
				event: { payload: normalized.storedPayload },
				hotel: system.hotel,
				config: system.config,
			},
			system.dependencies
		),
		/synthetic ordinary mirror failure/
	);
	assert.equal(system.reservationWrites.length, 1);
	assert.equal(
		reservation.supplierData.hotelRunner.metadataHandoffProjectionHash,
		undefined
	);
	assert.deepEqual(portalCommercialSnapshot(reservation), commercialBefore);

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
	assert.equal(result.mirrorRecovery, undefined);
	assert.equal(system.reservationWrites.length, 2);
	assert.equal(system.mirror.appliedCanonicalHash, normalized.canonicalHash);
	assert.deepEqual(portalCommercialSnapshot(reservation), commercialBefore);
});

test("metadata-only mirror ownership records the HotelRunner source projection, not portal or concurrent PMS facts", async () => {
	const { system, normalized, reservation } =
		authenticatedProviderPortalHandoffFixture({
			olderThanPortalWatermark: true,
		});
	const expectedTotal = reservation.total_amount;
	const expectedSourceProjection =
		authenticatedProviderHotelRunnerSourceProjection(
			system,
			normalized,
			reservation
		);
	const originalMirrorUpdateOne = system.MirrorModel.updateOne.bind(
		system.MirrorModel
	);
	let injectedConcurrentChange = false;
	system.MirrorModel.updateOne = (filter, update) => {
		if (!injectedConcurrentChange && update?.$set?.appliedCanonicalHash) {
			injectedConcurrentChange = true;
			reservation.customer_details.name = "Concurrent manual guest edit";
			reservation.total_amount = expectedTotal + 1;
		}
		return originalMirrorUpdateOne(filter, update);
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
	assert.equal(result.status, "updated");
	assert.equal(result.metadataOnly, true);
	assert.equal(
		reservation.customer_details.name,
		"Concurrent manual guest edit"
	);
	assert.equal(reservation.total_amount, expectedTotal + 1);
	assert.deepEqual(
		system.mirror.lastAppliedProjection,
		expectedSourceProjection
	);
	assert.notEqual(
		system.mirror.lastAppliedProjection.commercial.totalAmount,
		expectedTotal,
		"verified portal gross must not become HotelRunner's owned commercial baseline"
	);
});

test("provider guest, note, and guest-count facts stay protected until HotelRunner first matches them", async () => {
	const { system, normalized, reservation, providerNumber } =
		authenticatedProviderPortalHandoffFixture({
			olderThanPortalWatermark: true,
		});
	const providerFacts = {
		name: "Provider Portal Guest",
		note: "Provider portal booking note",
		totalGuests: 7,
		adults: 5,
		children: 2,
	};
	reservation.customer_details.name = providerFacts.name;
	reservation.comment = providerFacts.note;
	reservation.booking_comment = providerFacts.note;
	reservation.total_guests = providerFacts.totalGuests;
	reservation.adults = providerFacts.adults;
	reservation.children = providerFacts.children;

	const hotelRunnerEvent = ({
		messageUid,
		updatedAt,
		guest = "Projection Guest",
		note = "",
		totalGuests = 5,
		roomGuests = [
			{ adults: 2, children: 0 },
			{ adults: 2, children: 1 },
		],
	}) =>
		normalizedMultiRoom({
			message_uid: messageUid,
			reservation_id: normalized.hotelRunnerReservationId,
			hr_number: normalized.hrNumber,
			provider_number: providerNumber,
			channel: "expedia",
			channel_display: "Expedia",
			source_display: "Expedia",
			currency: "USD",
			sub_total: "438.40",
			item_total: "438.40",
			total: "438.40",
			paid_amount: "0",
			updated_at: updatedAt,
			guest,
			note,
			total_guests: totalGuests,
			rooms: [
				rawRoom({
					id: "external-room-1",
					invCode: "INV-DOUBLE",
					name: "Double Room",
					prices: ["100", "200"],
					...roomGuests[0],
				}),
				rawRoom({
					id: "external-room-2",
					invCode: "INV-TRIPLE",
					name: "Triple Room",
					prices: ["300", "400"],
					...roomGuests[1],
				}),
			],
		});
	const project = (next) =>
		projectHotelRunnerReservation(
			{
				normalized: next,
				event: { payload: next.storedPayload },
				hotel: system.hotel,
				config: system.config,
			},
			system.dependencies
		);

	const first = await project(normalized);
	assert.equal(first.code, "hotelrunner_older_authenticated_provider_handoff");
	assert.equal(
		system.mirror.lastAppliedProjection.guest.name,
		"Projection Guest"
	);
	assert.equal(system.mirror.lastAppliedProjection.note.comment, "");
	assert.deepEqual(system.mirror.lastAppliedProjection.guestCounts, {
		totalGuests: 5,
		adults: 4,
		children: 1,
	});

	const stillDifferent = hotelRunnerEvent({
		messageUid: "expedia-source-still-differs",
		updatedAt: "2026-08-06T13:00:00.000Z",
	});
	const protectedResult = await project(stillDifferent);
	assert.equal(protectedResult.status, "updated");
	assert.equal(protectedResult.guestCountsProtected, true);
	assert.equal(reservation.customer_details.name, providerFacts.name);
	assert.equal(reservation.comment, providerFacts.note);
	assert.equal(reservation.booking_comment, providerFacts.note);
	assert.equal(reservation.total_guests, providerFacts.totalGuests);
	assert.equal(reservation.adults, providerFacts.adults);
	assert.equal(reservation.children, providerFacts.children);
	assert.equal(
		system.mirror.lastAppliedProjection.guest.name,
		"Projection Guest"
	);
	assert.equal(system.mirror.lastAppliedProjection.note.comment, "");
	assert.equal(system.mirror.lastAppliedProjection.guestCounts.totalGuests, 5);

	const sourceMatchesProvider = hotelRunnerEvent({
		messageUid: "expedia-source-now-matches-provider",
		updatedAt: "2026-08-06T14:00:00.000Z",
		guest: providerFacts.name,
		note: providerFacts.note,
		totalGuests: providerFacts.totalGuests,
		roomGuests: [
			{ adults: 3, children: 1 },
			{ adults: 2, children: 1 },
		],
	});
	const matchedResult = await project(sourceMatchesProvider);
	assert.equal(matchedResult.status, "updated");
	assert.equal(
		system.mirror.lastAppliedProjection.guest.name,
		providerFacts.name
	);
	assert.equal(
		system.mirror.lastAppliedProjection.note.comment,
		providerFacts.note
	);
	assert.deepEqual(system.mirror.lastAppliedProjection.guestCounts, {
		totalGuests: providerFacts.totalGuests,
		adults: providerFacts.adults,
		children: providerFacts.children,
	});

	const laterSourceChange = hotelRunnerEvent({
		messageUid: "expedia-source-changes-after-match",
		updatedAt: "2026-08-06T14:30:00.000Z",
		guest: "HotelRunner Confirmed Guest",
		note: "HotelRunner confirmed note",
		totalGuests: 6,
		roomGuests: [
			{ adults: 2, children: 1 },
			{ adults: 2, children: 1 },
		],
	});
	const changedResult = await project(laterSourceChange);
	assert.equal(changedResult.status, "updated");
	assert.equal(
		reservation.customer_details.name,
		"HotelRunner Confirmed Guest"
	);
	assert.equal(reservation.comment, "HotelRunner confirmed note");
	assert.equal(reservation.booking_comment, "HotelRunner confirmed note");
	assert.equal(reservation.total_guests, 6);
	assert.equal(reservation.adults, 4);
	assert.equal(reservation.children, 2);
});

test("provider-portal handoff rejects tampering, role mismatch, stale evidence, room mismatch, and non-portal sources without PMS mutation", async (t) => {
	const cases = [
		{
			name: "tampered evidence hash",
			mutate: ({ reservation }) => {
				reservation.supplierData.otaCommercialEvidence = JSON.parse(
					JSON.stringify(reservation.supplierData.otaCommercialEvidence)
				);
				reservation.supplierData.otaCommercialEvidence.evidenceHash =
					"0".repeat(64);
			},
			expectedCode: "hotelrunner_currency_requires_review",
		},
		{
			name: "HotelRunner total matches no verified source role",
			mutate: ({ normalized }) => {
				normalized.totalCents += 1;
			},
			expectedCode: "hotelrunner_currency_requires_review",
		},
		{
			name: "commercial evidence has a stale marker",
			mutate: ({ reservation }) => {
				reservation.supplierData.otaCommercialEvidenceStaleReason =
					"provider_stay_changed";
			},
			expectedCode: "hotelrunner_currency_requires_review",
		},
		{
			name: "picked room pricing diverges from the canonical room rows",
			mutate: ({ reservation }) => {
				reservation.pickedRoomsPricing[0].pricingByDay[0].netAfterExpenses += 0.01;
			},
			expectedCode: "hotelrunner_currency_requires_review",
		},
		{
			name: "provider payment summary contradicts the verified payout role",
			mutate: ({ reservation }) => {
				reservation.supplierData.otaPaymentSummary = {
					...reservation.supplierData.otaPaymentSummary,
					sourceTotalPayoutAmount: 438.41,
				};
			},
			expectedCode: "hotelrunner_currency_requires_review",
		},
		{
			name: "redundant property gross contradicts verified evidence",
			mutate: ({ reservation }) => {
				reservation.supplierData.otaAmountSar = 2132.41;
			},
			expectedCode: "hotelrunner_currency_requires_review",
		},
		{
			name: "nightly commercial totals contradict the verified reservation total",
			mutate: ({ reservation }) => {
				reservation.pickedRoomsType[0].pricingByDay[0].totalPriceWithCommission += 0.01;
				reservation.pickedRoomsPricing = JSON.parse(
					JSON.stringify(reservation.pickedRoomsType)
				);
			},
			expectedCode: "hotelrunner_currency_requires_review",
		},
		{
			name: "HotelRunner total ambiguously matches equal gross and payout roles",
			fixture: () =>
				authenticatedProviderPortalHandoffFixture({
					reportedRole: "guest_gross",
					equalCommercialRoles: true,
				}),
			mutate: () => {},
			expectedCode: "hotelrunner_currency_requires_review",
		},
		{
			name: "explicit HotelRunner evidence assigns a contradictory amount role",
			fixture: () =>
				authenticatedProviderPortalHandoffFixture({
					reportedRole: "hotel_payout",
					evidenceHotelRunnerRole: "guest_gross",
				}),
			mutate: () => {},
			expectedCode: "hotelrunner_currency_requires_review",
		},
		{
			name: "resolved HotelRunner room differs from the provider-created room",
			mutate: ({ reservation }) => {
				reservation.pickedRoomsType[0].hotelRoomConfigId = LOCAL_TRIPLE_ID;
				reservation.pickedRoomsType[0].localRoomConfigId = LOCAL_TRIPLE_ID;
				reservation.pickedRoomsPricing[0].hotelRoomConfigId = LOCAL_TRIPLE_ID;
				reservation.pickedRoomsPricing[0].localRoomConfigId = LOCAL_TRIPLE_ID;
			},
			expectedCode: "hotelrunner_authenticated_provider_handoff_rejected",
		},
	];
	for (const scenario of cases) {
		await t.test(scenario.name, async () => {
			const fixture = scenario.fixture
				? scenario.fixture()
				: authenticatedProviderPortalHandoffFixture();
			scenario.mutate(fixture);
			const before = portalCommercialSnapshot(fixture.reservation);
			const result = await projectHotelRunnerReservation(
				{
					normalized: fixture.normalized,
					event: { payload: fixture.normalized.storedPayload },
					hotel: fixture.system.hotel,
					config: fixture.system.config,
				},
				fixture.system.dependencies
			);
			assert.equal(result.status, "quarantined");
			assert.equal(result.code, scenario.expectedCode);
			assert.equal(fixture.system.reservationWrites.length, 0);
			assert.deepEqual(portalCommercialSnapshot(fixture.reservation), before);
			assert.equal(fixture.reservation.supplierData.hotelRunner, undefined);
		});
	}

	await t.test(
		"valid authenticated relay/audit evidence is not portal authority",
		async () => {
			const fixture = authenticatedProviderPortalHandoffFixture({
				sourceType: "authenticated_ota_audit",
			});
			assert.equal(
				validateOtaCommercialEvidence(
					fixture.reservation.supplierData.otaCommercialEvidence
				).ok,
				true
			);
			const before = portalCommercialSnapshot(fixture.reservation);
			const result = await projectHotelRunnerReservation(
				{
					normalized: fixture.normalized,
					event: { payload: fixture.normalized.storedPayload },
					hotel: fixture.system.hotel,
					config: fixture.system.config,
				},
				fixture.system.dependencies
			);
			assert.equal(result.status, "quarantined");
			assert.equal(result.code, "hotelrunner_currency_requires_review");
			assert.equal(fixture.system.reservationWrites.length, 0);
			assert.deepEqual(portalCommercialSnapshot(fixture.reservation), before);
			assert.equal(fixture.reservation.supplierData.hotelRunner, undefined);
		}
	);
});

test("queued Trip stored-FX evidence creates one authority-4 API reservation with gross and payout atomically", async () => {
	const system = createInMemoryProjectionSystem();
	system.config.requireOtaReview = true;
	const confirmationNumber = "1653715890127438";
	const room = rawRoom({
		id: "trip-api-room-1",
		invCode: "INV-DOUBLE",
		name: "Double Room",
		prices: ["9.10", "9.10"],
	});
	const normalized = normalizedMultiRoom({
		message_uid: "adapter-trip-stored-fx-queued-create",
		reservation_id: "hr-trip-stored-fx-create",
		hr_number: "R-TRIP-STORED-FX",
		provider_number: confirmationNumber,
		channel: "tripcom",
		channel_display: "Trip.com",
		source_display: "Trip.com",
		currency: "USD",
		total_rooms: 1,
		total_guests: 2,
		sub_total: "18.20",
		item_total: "18.20",
		total: "18.20",
		paid_amount: "0",
		rooms: [room],
	});
	const inbound = await storedFxTripQueuedInbound({
		roomName: system.hotel.roomCountDetails[0].displayName,
	});
	assert.equal(inbound.exchangeRateSource, "exchange_rate_api_stored");
	const bridge = queuedEmailBridgeFromInbound(inbound, {
		amountRole: "payout",
		hotelRunnerAmount: 18.2,
	});
	let queueReads = 0;
	system.dependencies.loadQueuedEmailCommercialBridge = async () => {
		queueReads += 1;
		return bridge;
	};

	const result = await projectHotelRunnerReservation(
		{
			normalized,
			event: { _id: "event-trip-stored-fx", payload: normalized.storedPayload },
			hotel: system.hotel,
			config: system.config,
		},
		system.dependencies
	);

	assert.equal(result.status, "created", JSON.stringify(result));
	assert.equal(queueReads, 1);
	assert.equal(system.reservations.length, 1);
	const created = system.reservations[0];
	assert.equal(created.total_amount, 81.32);
	assert.equal(created.adminPricing.clientTotal, 81.32);
	assert.equal(created.adminPricing.netAfterExpensesTotal, 69.16);
	assert.equal(created.adminPricing.otaExpenseTotal, 12.16);
	assert.equal(created.adminPricing.rootTotal, 161);
	assert.equal(created.adminPricing.platformMarginTotal, -91.84);
	assert.equal(created.adminPricing.commercialVerified, true);
	assert.equal(created.payment, "paid online");
	assert.equal(created.financeStatus, "paid online");
	assert.equal(created.paid_amount, 81.32);
	assert.equal(
		created.paid_amount_breakdown.paid_online_other_platforms,
		81.32
	);
	assert.equal(created.payment_details.captured, false);
	assert.equal(created.financial_cycle.collectionModel, "pms_collected");
	assert.equal(created.financial_cycle.pmsCollectedAmount, 81.32);
	assert.equal(created.financial_cycle.hotelPayoutDue, 161);
	assert.equal(
		created.supplierData.otaPaymentCollectionModel,
		"ota_collect"
	);
	assert.equal(created.ota_financial_summary.show, true);
	assert.equal(created.ota_financial_summary.netAfterExpenses, 69.16);
	assert.equal(created.supplierData.otaSourceAuthority, 4);
	assert.equal(
		created.supplierData.otaAutomationPipeline,
		"hotelrunner-background-worker"
	);
	assert.equal(created.supplierData.hotelRunner.transport, "hotelrunner_api");
	assert.equal(
		created.supplierData.hotelRunnerFirstFallbackCommercialBridge.jobId,
		bridge.jobId
	);
	assert.equal(created.supplierData.otaInboundEmailId, bridge.inboundEmailId);
	assert.equal(created.otaPlatformReview.inboundEmailId, "");
	assert.equal(
		created.supplierData.hotelRunnerEmailCommercialEvidence.evidenceHash,
		bridge.evidence.evidenceHash
	);
	const daily = created.pickedRoomsPricing.flatMap((entry) => entry.pricingByDay);
	assert.equal(daily.length, 2);
	assert.equal(
		Number(daily.reduce((sum, day) => sum + day.clientPrice, 0).toFixed(2)),
		81.32
	);
	assert.equal(
		Number(daily.reduce((sum, day) => sum + day.netAfterExpenses, 0).toFixed(2)),
		69.16
	);
});

test("queued Trip half-cent FX conversion cannot quarantine an otherwise valid API reservation", async () => {
	const system = createInMemoryProjectionSystem();
	system.config.requireOtaReview = true;
	const confirmationNumber = "1567954036129867";
	const room = rawRoom({
		id: "trip-api-half-cent-room-1",
		invCode: "INV-DOUBLE",
		name: "Double Room",
		prices: ["13.72", "13.72"],
	});
	const normalized = normalizedMultiRoom({
		message_uid: "adapter-trip-half-cent-fx-queued-create",
		reservation_id: "hr-trip-half-cent-fx-create",
		hr_number: "R-TRIP-HALF-CENT-FX",
		provider_number: confirmationNumber,
		channel: "tripcom",
		channel_display: "Trip.com",
		source_display: "Trip.com",
		currency: "USD",
		total_rooms: 1,
		total_guests: 2,
		sub_total: "27.44",
		item_total: "27.44",
		total: "27.44",
		paid_amount: "0",
		rooms: [room],
	});
	const inbound = await storedFxTripQueuedInbound(
		{
			confirmationNumber,
			reservationId: confirmationNumber,
			roomName: system.hotel.roomCountDetails[0].displayName,
			sourceAmount: 29.06,
			sourcePayoutAmount: 27.44,
			paymentSummary: {
				sourceCurrency: "USD",
				sourceTotalGuestPaymentAmount: 29.06,
				sourceTotalPayoutAmount: 27.44,
				sourceTotalPayoutCurrency: "USD",
				totalGuestPaymentAmount: null,
				totalPayoutAmount: null,
				currency: null,
				exchangeRateToSar: null,
			},
		},
		{ conversionRate: 3.75 }
	);
	assert.equal(inbound.totalAmountSar, 108.98);
	assert.equal(inbound.paymentSummary.totalGuestPaymentAmount, 108.98);
	assert.equal(inbound.totalPayoutSar, 102.9);

	const bridge = queuedEmailBridgeFromInbound(inbound, {
		amountRole: "payout",
		hotelRunnerAmount: 27.44,
	});
	system.dependencies.loadQueuedEmailCommercialBridge = async () => bridge;

	const result = await projectHotelRunnerReservation(
		{
			normalized,
			event: { _id: "event-trip-half-cent-fx", payload: normalized.storedPayload },
			hotel: system.hotel,
			config: system.config,
		},
		system.dependencies
	);

	assert.equal(result.status, "created", JSON.stringify(result));
	assert.equal(system.reservations.length, 1);
	const created = system.reservations[0];
	assert.equal(created.total_amount, 108.98);
	assert.equal(created.adminPricing.clientTotal, 108.98);
	assert.equal(created.adminPricing.netAfterExpensesTotal, 102.9);
	assert.equal(created.adminPricing.otaExpenseTotal, 6.08);
	assert.equal(created.adminPricing.commercialVerified, true);
	assert.equal(created.payment, "paid online");
	assert.equal(created.financeStatus, "paid online");
	assert.equal(created.paid_amount, 108.98);
	assert.equal(
		created.paid_amount_breakdown.paid_online_other_platforms,
		108.98
	);
	assert.equal(created.supplierData.hotelRunner.transport, "hotelrunner_api");
	assert.equal(created.supplierData.otaSourceAuthority, 4);
	assert.equal(
		created.supplierData.hotelRunnerEmailCommercialEvidence.grossTotalSar,
		108.98
	);
});

test("incident-shaped two-room Agoda queue creates 588/363.78/root 534 while HotelRunner owns heterogeneous mappings", async () => {
	const system = createInMemoryProjectionSystem();
	system.hotel.activateHotel = true;
	system.hotel.xHotelProActive = true;
	system.config = {
		...system.config,
		hotelId: String(system.hotel._id),
		hrIdFingerprint: "f".repeat(64),
		requireOtaReview: true,
	};
	for (const room of system.hotel.roomCountDetails) {
		room.defaultCost = 89;
		room.pricingRate = [];
	}
	const threeNightRoom = ({ id, invCode, name, adults = 2 }) => ({
		...rawRoom({
			id,
			invCode,
			name,
			prices: ["60.63", "60.63", "60.63"],
			adults,
		}),
		checkout_date: "2026-08-13",
		nights: 3,
	});
	const normalized = normalizedMultiRoom({
		message_uid: "adapter-agoda-2039878308-queued-create",
		reservation_id: "hr-agoda-2039878308",
		hr_number: "R-2039878308",
		provider_number: "2039878308",
		channel: "agodaycs5",
		channel_display: "Agoda",
		source_display: "Agoda",
		checkout_date: "2026-08-13",
		total_rooms: 2,
		total_guests: 5,
		sub_total: "363.78",
		item_total: "363.78",
		total: "363.78",
		paid_amount: "0",
		rooms: [
			threeNightRoom({
				id: "agoda-room-1",
				invCode: "INV-DOUBLE",
				name: "Double Room",
			}),
			threeNightRoom({
				id: "agoda-room-2",
				invCode: "INV-TRIPLE",
				name: "Triple Room",
				adults: 3,
			}),
		],
	});
	const inbound = directQueuedInbound({
		roomName: "Multiple room allocation",
		checkoutDate: "2026-08-13",
		roomCount: 2,
		amount: 588,
		totalAmountSar: 588,
		sourceAmount: 588,
		totalPayoutSar: 363.78,
		netAfterExpensesTotal: 363.78,
		paymentSummary: {
			sourceCurrency: "SAR",
			sourceTotalGuestPaymentAmount: 588,
			sourceTotalPayoutAmount: 363.78,
			totalGuestPaymentAmount: 588,
			totalPayoutAmount: 363.78,
			currency: "SAR",
			exchangeRateToSar: 1,
			exchangeRateSource: "identity",
		},
		requiresManualReview: true,
		ambiguousMultiRoomEvidence: true,
		blocksUnmappedReservationCreation: true,
		manualReviewReasons: [
			"Agoda email contains multiple rooms; automatic partial-room creation is disabled and the booking requires room review.",
		],
	});
	const jobId = "64b000000000000000000501";
	const inboundEmailId = inbound.inboundEmailId;
	const audit = {
		_id: inboundEmailId,
		hotelId: String(system.hotel._id),
		provider: "agoda",
		confirmationNumber: "2039878308",
		intent: "new_reservation",
		eventType: "new",
		emailHash: "1".repeat(64),
		senderAuthentication: {
			authenticatedAligned: true,
			trustedProvider: "agoda",
		},
		reservationMongoId: null,
		hasReservationConnection: false,
		processingStatus: "awaiting_hotelrunner",
		automationAction: "queued",
		hotelRunnerFirstFallback: {
			status: "archive_ready",
			jobId: null,
			resolvedHotelProof: {
				version: 1,
				hotelId: String(system.hotel._id),
				belongsTo: String(system.hotel.belongsTo),
				currency: "SAR",
				activateHotel: true,
				xHotelProActive: true,
			},
		},
		normalizedReservation: inbound,
	};
	const identity = {
		hotelId: String(system.hotel._id),
		provider: "agoda",
		confirmationNumber: "2039878308",
	};
	const archive = createArchiveFingerprint({ identity, audit });
	const job = {
		_id: jobId,
		...identity,
		lookupConfirmationNumber: identity.confirmationNumber,
		identityKey: `agoda:${identity.confirmationNumber}`,
		hrIdFingerprint: system.config.hrIdFingerprint,
		...archive,
		status: "awaiting_hotelrunner",
		identityConflict: false,
		leaseOwner: "",
		leaseToken: "",
		leaseAcquiredAt: null,
		leaseUntil: null,
	};
	let jobReads = 0;
	let auditReads = 0;
	system.dependencies.FallbackJobModel = {
		find(filter) {
			jobReads += 1;
			assert.deepEqual(filter, {
				hotelId: identity.hotelId,
				provider: identity.provider,
				confirmationNumber: identity.confirmationNumber,
			});
			return queryResult(() => [job]);
		},
	};
	system.dependencies.InboundEmailModel = {
		findById(value) {
			auditReads += 1;
			assert.equal(String(value), inboundEmailId);
			return queryResult(() => audit);
		},
	};
	system.dependencies.resolveArchivedHotel = async () => system.hotel;
	system.dependencies.queuedEmailBridgeNow = () =>
		new Date("2026-08-09T06:01:00.000Z");

	const result = await projectHotelRunnerReservation(
		{
			normalized,
			event: { _id: "event-agoda-2039878308", payload: normalized.storedPayload },
			hotel: system.hotel,
			config: system.config,
		},
		system.dependencies
	);

	assert.equal(result.status, "created", JSON.stringify(result));
	assert.equal(jobReads, 1);
	assert.equal(auditReads, 1);
	assert.equal(system.reservations.length, 1);
	const created = system.reservations[0];
	assert.equal(created.total_amount, 588);
	assert.equal(created.adminPricing.clientTotal, 588);
	assert.equal(created.adminPricing.netAfterExpensesTotal, 363.78);
	assert.equal(created.adminPricing.otaExpenseTotal, 224.22);
	assert.equal(created.adminPricing.rootTotal, 534);
	assert.equal(created.adminPricing.platformMarginTotal, -170.22);
	assert.equal(created.payment, "paid online");
	assert.equal(created.financeStatus, "paid online");
	assert.equal(created.paid_amount, 588);
	assert.equal(
		created.paid_amount_breakdown.paid_online_other_platforms,
		588
	);
	assert.equal(created.payment_details.captured, false);
	assert.equal(created.financial_cycle.collectionModel, "pms_collected");
	assert.equal(created.financial_cycle.pmsCollectedAmount, 588);
	assert.equal(created.financial_cycle.hotelPayoutDue, 534);
	assert.equal(
		created.supplierData.otaPaymentCollectionModel,
		"ota_collect"
	);
	const daily = created.pickedRoomsPricing.flatMap((entry) => entry.pricingByDay);
	assert.equal(daily.length, 6);
	assert.ok(daily.every((day) => day.clientPrice === 98));
	assert.ok(daily.every((day) => day.netAfterExpenses === 60.63));
	assert.ok(daily.every((day) => day.rootPrice === 89));
	assert.ok(daily.every((day) => day.otaExpenseAmount === 37.37));
	assert.ok(daily.every((day) => day.platformMargin === -28.37));
	assert.deepEqual(
		new Set(created.pickedRoomsPricing.map((room) => room.hotelRoomConfigId)),
		new Set([LOCAL_DOUBLE_ID, LOCAL_TRIPLE_ID])
	);
	assert.equal(
		created.supplierData.hotelRunnerFirstFallbackCommercialBridge.jobId,
		jobId
	);
	assert.equal(created.supplierData.otaInboundEmailId, inboundEmailId);
	assert.equal(
		created.supplierData.hotelRunnerFirstFallbackCommercialBridge.archiveFingerprint,
		archive.archiveFingerprint
	);
	assert.equal(audit.processingStatus, "awaiting_hotelrunner");
	assert.equal(audit.automationAction, "queued");
	assert.equal(job.status, "awaiting_hotelrunner");

	const nearMissSystem = createInMemoryProjectionSystem();
	nearMissSystem.config.requireOtaReview = true;
	const nearMissInbound = {
		...inbound,
		requiresManualReview: false,
		ambiguousMultiRoomEvidence: false,
		blocksUnmappedReservationCreation: false,
		manualReviewReasons: [],
		roomName: nearMissSystem.hotel.roomCountDetails[0].displayName,
	};
	const bridge = queuedEmailBridgeFromInbound(inbound, {
		amountRole: "payout",
		hotelRunnerAmount: 363.78,
	});
	nearMissSystem.dependencies.loadQueuedEmailCommercialBridge = async () => ({
		...bridge,
		normalizedReservation: nearMissInbound,
	});
	const nearMiss = await projectHotelRunnerReservation(
		{
			normalized,
			event: { _id: "event-agoda-heterogeneous-near-miss", payload: normalized.storedPayload },
			hotel: nearMissSystem.hotel,
			config: nearMissSystem.config,
		},
		nearMissSystem.dependencies
	);
	assert.equal(nearMiss.status, "created", JSON.stringify(nearMiss));
	assert.equal(nearMissSystem.reservations.length, 1);
	assert.equal(nearMissSystem.reservations[0].adminPricing.commercialVerified, false);
	assert.equal(
		nearMissSystem.reservations[0].supplierData.hotelRunnerEmailCommercialEvidence,
		undefined
	);
});

test("sparse queued email never blocks an otherwise valid same-currency HotelRunner create", async () => {
	const system = createInMemoryProjectionSystem();
	const normalized = normalizedMultiRoom({
		message_uid: "adapter-sar-api-sparse-queued-email",
		provider_number: "BOOKING-SPARSE-QUEUE-101",
	});
	system.dependencies.loadQueuedEmailCommercialBridge = async () => ({
		ok: false,
		reason: "queued_commercial_evidence_invalid",
		amountRole: "",
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
	assert.equal(result.status, "created", JSON.stringify(result));
	assert.equal(system.reservations.length, 1);
	assert.equal(system.reservations[0].supplierData.hotelRunner.transport, "hotelrunner_api");
	assert.equal(system.reservations[0].supplierData.otaSourceAuthority, 4);
	assert.equal(system.reservations[0].adminPricing.commercialVerified, false);
});

test("contradictory queued email identity cannot block same-currency HotelRunner authority", async () => {
	const system = createInMemoryProjectionSystem();
	const normalized = normalizedMultiRoom({
		message_uid: "adapter-sar-api-conflicting-queued-email",
		provider_number: "BOOKING-CONFLICT-QUEUE-101",
	});
	system.dependencies.loadQueuedEmailCommercialBridge = async () => ({
		ok: false,
		reason: "queued_stay_mismatch",
		amountRole: "",
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
	assert.equal(result.status, "created", JSON.stringify(result));
	assert.equal(system.reservations.length, 1);
	assert.equal(system.reservations[0].supplierData.otaSourceAuthority, 4);
	assert.equal(system.reservations[0].adminPricing.commercialVerified, false);
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

test("sanitized agodaycs5 projection preserves exact email money across the critical room ownership handoff", async () => {
	const { system, normalized, pricing, existing, evidence } =
		sanitizedAgodaCriticalHandoffFixture();
	assert.notDeepEqual(
		criticalOwnershipProjection(projectionFromReservation(existing).critical),
		criticalOwnershipProjection(projectionFromIncoming(normalized, pricing).critical),
		"the regression must exercise a real critical room projection change"
	);

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
	assert.equal(result.commercialProtected, true);
	assert.equal(result.commercialEvidenceStale, false);
	assert.equal(result.attentionCode, "");
	assert.equal(system.reservations.length, 1);
	assert.equal(existing.total_amount, 588);
	assert.equal(existing.adminPricing.clientTotal, 588);
	assert.equal(existing.adminPricing.netAfterExpensesTotal, 363.78);
	assert.equal(existing.adminPricing.otaExpenseTotal, 224.22);
	assert.equal(existing.adminPricing.commercialVerified, true);
	assert.equal(existing.ota_financial_summary.show, true);
	assert.equal(existing.ota_financial_summary.commercialVerified, true);
	assert.equal(existing.supplierData.otaPayoutFallbackReason, "");
	assert.equal(
		existing.supplierData.hotelRunnerEmailCommercialEvidence.evidenceHash,
		evidence.evidenceHash
	);
	assert.equal(existing.supplierData.hotelRunner.channel, "agodaycs5");
	assert.equal(existing.supplierData.otaProvider, "agoda");
	assert.ok(
		existing.pickedRoomsType.every((room) => room.hotelRoomConfigId),
		"HotelRunner may take explicit local-room ownership without erasing exact email money"
	);
});

test("critical HotelRunner handoff invalidates email money when any exact bridge gate fails", async () => {
	const rejectedBridges = [
		{
			name: "provider identity",
			value: { ok: false, reason: "provider_identity_mismatch", amountRole: "" },
		},
		{
			name: "stay",
			value: { ok: false, reason: "stay_mismatch", amountRole: "" },
		},
		{
			name: "room count",
			value: { ok: false, reason: "room_count_mismatch", amountRole: "" },
		},
		{
			name: "currency",
			value: { ok: false, reason: "currency_mismatch", amountRole: "" },
		},
		{
			name: "amount",
			value: { ok: false, reason: "amount_mismatch", amountRole: "" },
		},
	];

	for (const rejected of rejectedBridges) {
		const { system, normalized, existing } =
			sanitizedAgodaCriticalHandoffFixture();
		system.dependencies.loadEmailCommercialBridge = async () => rejected.value;
		const result = await projectHotelRunnerReservation(
			{
				normalized,
				event: { payload: normalized.storedPayload },
				hotel: system.hotel,
				config: system.config,
			},
			system.dependencies
		);

		assert.equal(result.status, "updated", rejected.name);
		assert.equal(result.commercialEvidenceStale, true, rejected.name);
		assert.equal(
			result.attentionCode,
			"hotelrunner_commercial_evidence_stale",
			rejected.name
		);
		assert.equal(
			existing.supplierData.hotelRunnerEmailCommercialEvidence,
			null,
			rejected.name
		);
		assert.equal(existing.adminPricing.commercialVerified, false, rejected.name);
		assert.equal(existing.ota_financial_summary.show, false, rejected.name);
	}

	const forged = sanitizedAgodaCriticalHandoffFixture();
	forged.system.dependencies.loadEmailCommercialBridge = async () => ({
		...forged.bridge,
		evidence: {
			...forged.bridge.evidence,
			otaIdentityKey: "agoda:different-reservation",
		},
	});
	const forgedResult = await projectHotelRunnerReservation(
		{
			normalized: forged.normalized,
			event: { payload: forged.normalized.storedPayload },
			hotel: forged.system.hotel,
			config: forged.system.config,
		},
		forged.system.dependencies
	);
	assert.equal(forgedResult.status, "updated");
	assert.equal(forgedResult.commercialEvidenceStale, true);
	assert.equal(
		forged.existing.supplierData.hotelRunnerEmailCommercialEvidence,
		null,
		"an internally inconsistent successful bridge must fail closed"
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
		hotelRunnerCommercialProvider({
			channel: "agodaycs5",
			channelDisplay: "Agoda",
			sourceDisplay: "Agoda",
		}),
		"agoda",
		"the production Agoda YCS machine channel must resolve explicitly"
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
			channel: "agodaycs5",
			channelDisplay: "Booking.com",
			sourceDisplay: "Agoda",
		}),
		"",
		"the Agoda YCS alias must still fail closed on contradictory displays"
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
		find: (filter) => queryResult(() =>
				filter["supplierData.hotelRunner.reservationId"] ? [] : [candidate]),
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
		find: (filter) => queryResult(() =>
				filter["supplierData.hotelRunner.reservationId"] ? [] : candidates),
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
		find: (filter) => {
			if (filter["supplierData.hotelRunner.reservationId"]) {
				return queryResult(() => []);
			}
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

test("direct HotelRunner identity linking fails closed when the primary identifier is duplicated", async () => {
	const normalized = normalizedMultiRoom();
	const duplicates = ["direct-duplicate-a", "direct-duplicate-b"].map(
		(_id) => ({
			_id,
			hotelId: "64b000000000000000000001",
			supplierData: {
				hotelRunner: { reservationId: normalized.hotelRunnerReservationId },
			},
		})
	);
	let requestedLimit = null;
	const ReservationModel = {
		find(filter) {
			const matches = filter["supplierData.hotelRunner.reservationId"]
				? duplicates
				: [];
			const query = queryResult(() => matches);
			query.limit = (value) => {
				requestedLimit = value;
				return query;
			};
			return query;
		},
	};

	await assert.rejects(
		findLinkedReservation(normalized, duplicates[0].hotelId, {
			ReservationModel,
		}),
		(error) => error?.code === "hotelrunner_identity_ambiguous"
	);
	assert.equal(requestedLimit, 2);
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

test("a descriptive HotelRunner update preserves valid common-only authenticated commercial evidence", async () => {
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
	const commonEvidence = buildAuthenticatedProviderCommercialEvidence({
		provider: "booking",
		authenticatedProvider: "booking",
		sourceAuthenticated: true,
		sourceTrusted: true,
		sourceType: "authenticated_provider_api",
		sourceCurrency: "SAR",
		propertyCurrency: "SAR",
		bookingBasis: "reservation_total",
		sourceHash: "b".repeat(64),
		sourceTimestamp: "2026-08-06T11:15:00.000Z",
		sourceId: "booking-common-only-descriptive-test",
		guestGross: { verified: true, amount: 100.01 },
		hotelPayout: { verified: true, amount: 85.01 },
	});
	delete reservation.supplierData.hotelRunnerEmailCommercialEvidence;
	reservation.supplierData.otaCommercialEvidence = commonEvidence;
	reservation.supplierData.otaCommercialEvidenceStaleReason = "";
	reservation.supplierData.otaPaymentSummary = {
		sourceCurrency: "SAR",
		sourceTotalGuestPaymentAmount: 100.01,
		sourceTotalPayoutAmount: 85.01,
		totalGuestPaymentAmount: 100.01,
		totalPayoutAmount: 85.01,
		currency: "SAR",
		exchangeRateToSar: 1,
	};
	reservation.supplierData.otaTotalPayoutSar = 85.01;
	reservation.supplierData.otaExpenseTotalSar = 15;
	reservation.supplierData.otaPayoutFallbackReason = "";
	reservation.total_amount = 100.01;
	reservation.adminPricing.clientTotal = 100.01;
	reservation.adminPricing.netAfterExpensesTotal = 85.01;
	reservation.adminPricing.otaExpenseTotal = 15;
	reservation.adminPricing.commercialVerified = true;
	reservation.adminPricing.payoutFallbackReason = "";
	reservation.ota_financial_summary.clientTotal = 100.01;
	reservation.ota_financial_summary.netAfterExpenses = 85.01;
	reservation.ota_financial_summary.netAfterOtaExpenses = 85.01;
	reservation.ota_financial_summary.otaExpenseTotal = 15;
	reservation.ota_financial_summary.commercialVerified = true;
	reservation.ota_financial_summary.payoutFallbackReason = "";
	reservation.ota_financial_summary.show = true;

	const descriptive = normalizedMultiRoom({
		message_uid: "adapter-common-only-descriptive",
		modified: true,
		updated_at: "2026-08-06T12:00:00.000Z",
		guest: "Updated Descriptive Guest",
	});
	const result = await projectHotelRunnerReservation(
		{
			normalized: descriptive,
			event: { payload: descriptive.storedPayload },
			hotel: system.hotel,
			config: system.config,
		},
		system.dependencies
	);

	assert.equal(result.status, "updated");
	assert.equal(result.commercialEvidenceStale, false);
	assert.equal(result.attentionCode, "");
	assert.equal(
		reservation.supplierData.otaCommercialEvidence.evidenceHash,
		commonEvidence.evidenceHash
	);
	assert.equal(validateOtaCommercialEvidence(
		reservation.supplierData.otaCommercialEvidence
	).ok, true);
	assert.equal(reservation.supplierData.otaCommercialEvidenceStaleReason, "");
	assert.equal(reservation.supplierData.otaCommercialEvidencePrevious, undefined);
	assert.equal(reservation.total_amount, 100.01);
	assert.equal(reservation.adminPricing.netAfterExpensesTotal, 85.01);
	assert.equal(reservation.adminPricing.otaExpenseTotal, 15);
	assert.equal(reservation.adminPricing.commercialVerified, true);
	assert.equal(reservation.ota_financial_summary.show, true);
	assert.equal(reservation.ota_financial_summary.commercialVerified, true);
	assert.equal(reservation.supplierData.otaPayoutFallbackReason, "");
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
	const authenticatedCommonEvidence = buildAuthenticatedProviderCommercialEvidence({
		provider: "booking",
		authenticatedProvider: "booking",
		sourceAuthenticated: true,
		sourceTrusted: true,
		sourceType: "authenticated_provider_api",
		sourceCurrency: "SAR",
		propertyCurrency: "SAR",
		bookingBasis: "reservation_total",
		sourceHash: "a".repeat(64),
		sourceTimestamp: "2026-08-06T12:00:00.000Z",
		sourceId: "booking-commercial-critical-test",
		guestGross: { verified: true, amount: 100.01 },
		hotelPayout: { verified: true, amount: 85.01 },
	});
	reservation.supplierData.otaCommercialEvidence = authenticatedCommonEvidence;
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
		reservation.supplierData.otaCommercialEvidencePrevious.evidenceHash,
		authenticatedCommonEvidence.evidenceHash
	);
	assert.equal(
		validateOtaCommercialEvidence(
			reservation.supplierData.otaCommercialEvidence
		).ok,
		true
	);
	assert.equal(
		reservation.supplierData.otaCommercialEvidence.sourceType,
		"hotelrunner_webhook"
	);
	assert.equal(
		reservation.supplierData.otaCommercialEvidence.verificationState,
		"unresolved"
	);
	assert.equal(
		reservation.supplierData.otaCommercialEvidenceStaleReason,
		"hotelrunner_stay_or_room_changed"
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

test("released HotelRunner modifications preserve all protected domains and mirror ownership", async () => {
	const { system, reservation } = await canonicalReleasedHotelRunnerFixture();
	const protectedBefore = releasedProtectedSnapshot(reservation);
	const releaseBefore = structuredClone(reservation.otaPlatformReview);
	const mirrorBaselineBefore = structuredClone(system.mirror.lastAppliedProjection);
	const mappingWritesBefore = system.mappingWrites.length;
	system.dependencies.loadEmailCommercialBridge = async () => {
		throw new Error("released lifecycle path loaded commercial evidence");
	};
	system.dependencies.validateInventory = async () => {
		throw new Error("released lifecycle path validated changed rooms");
	};
	const modified = normalizedMultiRoom({
		message_uid: "released-protected-modification",
		modified: true,
		guest: "Source Must Not Replace Released Guest",
		currency: "USD",
		sub_total: "1040",
		item_total: "1040",
		total: "1040",
		checkin_date: "2026-08-11",
		checkout_date: "2026-08-13",
		updated_at: "2026-08-06T12:00:00.000Z",
		rooms: [
			rawRoom({
				id: "external-room-1",
				invCode: "INV-DOUBLE",
				name: "Changed Double Room",
				prices: ["110", "210"],
			}),
			rawRoom({
				id: "external-room-2",
				invCode: "INV-TRIPLE",
				name: "Changed Triple Room",
				prices: ["310", "410"],
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
	const result = await projectFixtureEvent(system, modified);

	assert.equal(result.status, "updated");
	assert.equal(result.code, "hotelrunner_released_reservation_lifecycle_only");
	assert.equal(result.lifecycleOnly, true);
	assert.equal(result.releaseProtected, true);
	assert.deepEqual(releasedProtectedSnapshot(reservation), protectedBefore);
	assert.deepEqual(reservation.otaPlatformReview, releaseBefore);
	assert.deepEqual(system.mirror.lastAppliedProjection, mirrorBaselineBefore);
	assert.equal(system.mappingWrites.length, mappingWritesBefore);
	assert.equal(
		result.changedPaths.some((path) =>
			/^(?:customer_details|pickedRooms|adminPricing|ota_financial|commission|total_)/.test(
				path
			)
		),
		false
	);
});

test("released reserved-to-confirmed changes lifecycle only, including with finance and housing", async () => {
	const { system, reservation } = await canonicalReleasedHotelRunnerFixture({
		finance: true,
		housing: true,
		sourceState: "reserved",
	});
	const protectedBefore = releasedProtectedSnapshot(reservation);
	const releaseBefore = structuredClone(reservation.otaPlatformReview);
	const releasedToHotelAt = reservation.pendingConfirmation.releasedToHotelAt;
	const confirmed = normalizedMultiRoom({
		message_uid: "released-reserved-to-confirmed",
		modified: true,
		updated_at: "2026-08-06T12:15:00.000Z",
	});
	const result = await projectFixtureEvent(system, confirmed);

	assert.equal(result.status, "updated");
	assert.equal(reservation.state, "confirmed");
	assert.equal(reservation.reservation_status, "confirmed");
	assert.equal(reservation.pendingConfirmation.status, "confirmed");
	assert.equal(
		reservation.pendingConfirmation.releasedToHotelAt,
		releasedToHotelAt
	);
	assert.deepEqual(releasedProtectedSnapshot(reservation), protectedBefore);
	assert.deepEqual(reservation.otaPlatformReview, releaseBefore);
});

test("released active events never downgrade confirmed, in-house, or checked-out lifecycle", async () => {
	const confirmedFixture = await canonicalReleasedHotelRunnerFixture();
	confirmedFixture.reservation.state = "confirmed";
	confirmedFixture.reservation.reservation_status = "confirmed";
	confirmedFixture.reservation.pendingConfirmation.status = "confirmed";
	const reserved = normalizedMultiRoom({
		message_uid: "released-confirmed-late-reserved",
		state: "reserved",
		modified: true,
		updated_at: "2026-08-06T12:20:00.000Z",
	});
	const reservedResult = await projectFixtureEvent(
		confirmedFixture.system,
		reserved
	);
	assert.equal(reservedResult.status, "updated");
	assert.equal(confirmedFixture.reservation.state, "confirmed");
	assert.equal(confirmedFixture.reservation.reservation_status, "confirmed");

	for (const terminal of ["inhouse", "checked_out"]) {
		const { system, reservation } = await canonicalReleasedHotelRunnerFixture({
			housing: true,
			sourceState: "reserved",
		});
		reservation.state = terminal;
		reservation.reservation_status = terminal;
		const before = JSON.parse(JSON.stringify(reservation));
		const active = normalizedMultiRoom({
			message_uid: `released-${terminal}-active-confirmed`,
			modified: true,
			updated_at: "2026-08-06T12:25:00.000Z",
		});
		const result = await projectFixtureEvent(system, active);
		assert.equal(result.status, "quarantined");
		assert.equal(result.code, "hotelrunner_terminal_reopen_blocked");
		assert.deepEqual(JSON.parse(JSON.stringify(reservation)), before);
	}
});

test("released cancellation over housed checked-out finance changes only allowlisted lifecycle and ordering paths", async () => {
	const { system, reservation } = await canonicalReleasedHotelRunnerFixture({
		finance: true,
		housing: true,
	});
	reservation.state = "checked_out";
	reservation.reservation_status = "checked_out";
	reservation.pendingConfirmation.status = "confirmed";
	const protectedBefore = releasedProtectedSnapshot(reservation);
	const releaseBefore = structuredClone(reservation.otaPlatformReview);
	const mirrorBaselineBefore = structuredClone(system.mirror.lastAppliedProjection);
	const cancellation = normalizeHotelRunnerReservation({
		message_uid: "released-housed-finance-cancelled",
		reservation_id: reservation.supplierData.hotelRunner.reservationId,
		state: "canceled",
		updated_at: "2026-08-06T13:00:00.000Z",
		rooms: [{ id: "external-room-1", state: "canceled" }],
	});
	const result = await projectFixtureEvent(system, cancellation);
	const allowed = new Set([
		"state",
		"reservation_status",
		"pendingConfirmation.status",
		"pendingConfirmation.cancelledAt",
		"pendingConfirmation.inventoryBlocks",
		"pendingConfirmation.lastUpdatedAt",
		...RELEASED_HOTELRUNNER_MUTABLE_PATHS.filter((path) =>
			path.startsWith("supplierData.")
		),
	]);

	assert.equal(result.status, "cancelled");
	assert.equal(result.code, "hotelrunner_released_reservation_lifecycle_only");
	assert.equal(reservation.state, "cancelled");
	assert.equal(reservation.reservation_status, "cancelled");
	assert.deepEqual(new Set(result.changedPaths), allowed);
	assert.deepEqual(releasedProtectedSnapshot(reservation), protectedBefore);
	assert.deepEqual(reservation.otaPlatformReview, releaseBefore);
	assert.deepEqual(system.mirror.lastAppliedProjection, mirrorBaselineBefore);
	assert.equal(
		reservation.reservationAuditLog.at(-1).action,
		"released-reservation-cancelled-from-hotelrunner"
	);
});

test("released HotelRunner lifecycle outranks a later portal or email collector watermark", async (t) => {
	for (const lifecycle of ["confirmed", "canceled"]) {
		await t.test(lifecycle, async () => {
			const { system, reservation } =
				await canonicalReleasedHotelRunnerFixture({
					finance: true,
					housing: true,
					sourceState: "reserved",
				});
			const hotelRunnerReservationId =
				reservation.supplierData.hotelRunner.reservationId;
			reservation.supplierData.hotelRunner = {};
			reservation.supplierData.otaAutomationPipeline =
				"authenticated-provider-portal";
			reservation.supplierData.otaSourceAuthority = 4;
			reservation.supplierData.otaLastSourceReceivedAt =
				new Date("2026-08-06T15:00:00.000Z");
			system.mirror.reservationMongoId = null;
			system.mirror.appliedCanonicalHash = "";
			system.mirror.appliedSourceUpdatedAt = null;
			system.mirror.lastAppliedProjection = {};
			const protectedBefore = releasedProtectedSnapshot(reservation);
			const source = normalizedMultiRoom({
				message_uid: `released-portal-watermark-${lifecycle}`,
				reservation_id: hotelRunnerReservationId,
				state: lifecycle,
				modified: true,
				updated_at: "2026-08-06T12:00:00.000Z",
			});
			assert.equal(pmsWatermarkComparison(source, reservation), "older");
			system.dependencies.loadEmailCommercialBridge = async () => {
				throw new Error("released lifecycle loaded lower-authority evidence");
			};
			const result = await projectFixtureEvent(system, source);
			assert.equal(result.releaseProtected, true);
			assert.equal(
				result.status,
				lifecycle === "canceled" ? "cancelled" : "updated"
			);
			assert.equal(
				reservation.reservation_status,
				lifecycle === "canceled" ? "cancelled" : "Pending Confirmation"
			);
			assert.equal(
				reservation.supplierData.hotelRunner.sourceState,
				lifecycle
			);
			assert.deepEqual(
				releasedProtectedSnapshot(reservation),
				protectedBefore
			);
		});
	}
});

test("released lifecycle still rejects an event older than a genuine direct HotelRunner watermark", async () => {
	const { system, reservation } = await canonicalReleasedHotelRunnerFixture();
	reservation.supplierData.hotelRunner.appliedSourceUpdatedAt =
		new Date("2026-08-06T14:00:00.000Z");
	reservation.supplierData.otaLastSourceReceivedAt =
		new Date("2026-08-06T16:00:00.000Z");
	const before = JSON.parse(JSON.stringify(reservation));
	const cancellation = normalizeHotelRunnerReservation({
		message_uid: "released-stale-direct-hotelrunner-cancelled",
		reservation_id: reservation.supplierData.hotelRunner.reservationId,
		state: "canceled",
		updated_at: "2026-08-06T13:00:00.000Z",
		rooms: [{ id: "external-room-1", state: "canceled" }],
	});
	const result = await projectFixtureEvent(system, cancellation);
	assert.equal(result.status, "ignored");
	assert.equal(result.code, "hotelrunner_stale_against_pms_watermark");
	assert.deepEqual(JSON.parse(JSON.stringify(reservation)), before);
});

test("release near-misses use the ordinary update path", async (t) => {
	const cases = [
		{
			name: "legacy status and date only",
			mutate(reservation) {
				delete reservation.otaPlatformReview.releasedBy;
				delete reservation.pendingConfirmation.releasedToHotelAt;
			},
		},
		{
			name: "wrong pending source",
			mutate(reservation) {
				reservation.pendingConfirmation.source = "hotelrunner_api";
			},
		},
		{
			name: "missing release actor",
			mutate(reservation) {
				reservation.otaPlatformReview.releasedBy = null;
			},
		},
	];
	for (const [index, entry] of cases.entries()) {
		await t.test(entry.name, async () => {
			const { system, reservation } =
				await canonicalReleasedHotelRunnerFixture();
			entry.mutate(reservation);
			const modified = normalizedMultiRoom({
				message_uid: `release-near-miss-${index}`,
				modified: true,
				guest: `Ordinary Update ${index}`,
				updated_at: `2026-08-06T12:4${index}:00.000Z`,
			});
			const result = await projectFixtureEvent(system, modified);
			assert.equal(result.status, "updated");
			assert.equal(result.releaseProtected, undefined);
			assert.equal(
				reservation.customer_details.name,
				`Ordinary Update ${index}`
			);
			assert.equal(
				reservation.reservationAuditLog.at(-1).action,
				"updated-from-hotelrunner"
			);
		});
	}
});

test("unreleased cancellation retains commission ownership behavior", async () => {
	const system = createInMemoryProjectionSystem();
	const initial = normalizedMultiRoom({ message_uid: "unreleased-cancel-initial" });
	assert.equal((await projectFixtureEvent(system, initial)).status, "created");
	system.reservations[0].commission = 17;
	const cancellation = normalizeHotelRunnerReservation({
		message_uid: "unreleased-cancel-final",
		reservation_id: initial.hotelRunnerReservationId,
		state: "canceled",
		updated_at: "2026-08-06T12:30:00.000Z",
		rooms: [{ id: "external-room-1", state: "canceled" }],
	});
	const result = await projectFixtureEvent(system, cancellation);
	assert.equal(result.status, "cancelled");
	assert.equal(result.releaseProtected, undefined);
	assert.equal(system.reservations[0].commission, 0);
	assert.equal(
		system.reservations[0].reservationAuditLog.at(-1).action,
		"cancelled-from-hotelrunner"
	);
});

test("released lifecycle CAS fences every release marker without partial mutation", async () => {
	const { system, reservation, releasedAt, actor } =
		await canonicalReleasedHotelRunnerFixture();
	const before = JSON.parse(JSON.stringify(reservation));
	const mirrorHashBefore = system.mirror.appliedCanonicalHash;
	let attempted = null;
	system.ReservationModel.updateOne = (filter, update) => queryResult(() => {
		attempted = { filter, update };
		return { matchedCount: 0 };
	});
	const modified = normalizedMultiRoom({
		message_uid: "released-cas-conflict",
		modified: true,
		updated_at: "2026-08-06T13:15:00.000Z",
	});
	const result = await projectFixtureEvent(system, modified);

	assert.equal(result.status, "retry");
	assert.equal(result.code, "hotelrunner_reservation_cas_conflict");
	assert.equal(attempted.filter["otaPlatformReview.status"], "released");
	assert.equal(attempted.filter["otaPlatformReview.releasedAt"], releasedAt);
	assert.equal(
		attempted.filter["otaPlatformReview.releasedBy._id"],
		actor._id
	);
	assert.equal(
		attempted.filter["pendingConfirmation.source"],
		"ota_platform_release"
	);
	assert.equal(
		attempted.filter["pendingConfirmation.releasedToHotelAt"],
		releasedAt
	);
	assert.equal(attempted.update.$inc.__v, 1);
	assert.deepEqual(JSON.parse(JSON.stringify(reservation)), before);
	assert.equal(system.mirror.appliedCanonicalHash, mirrorHashBefore);
});

test("released lifecycle retry recovers only the mirror after its post-CAS failure", async () => {
	const { system, reservation } = await canonicalReleasedHotelRunnerFixture();
	const protectedBefore = releasedProtectedSnapshot(reservation);
	const baselineBefore = structuredClone(system.mirror.lastAppliedProjection);
	const originalMirrorUpdateOne = system.MirrorModel.updateOne.bind(
		system.MirrorModel
	);
	let failAppliedMirrorOnce = true;
	system.MirrorModel.updateOne = (filter, update) => {
		if (failAppliedMirrorOnce && update?.$set?.appliedCanonicalHash) {
			return queryResult(() => {
				failAppliedMirrorOnce = false;
				throw new Error("synthetic released lifecycle mirror failure");
			});
		}
		return originalMirrorUpdateOne(filter, update);
	};
	const modified = normalizedMultiRoom({
		message_uid: "released-mirror-recovery",
		modified: true,
		updated_at: "2026-08-06T13:30:00.000Z",
	});
	const auditCountBefore = reservation.reservationAuditLog.length;
	await assert.rejects(
		projectFixtureEvent(system, modified),
		/synthetic released lifecycle mirror failure/
	);
	assert.equal(system.reservationWrites.length, 1);
	assert.equal(reservation.reservationAuditLog.length, auditCountBefore + 1);
	const recovered = await projectFixtureEvent(system, modified);
	assert.equal(
		recovered.code,
		"hotelrunner_released_reservation_mirror_recovered"
	);
	assert.equal(recovered.mirrorRecovery, true);
	assert.equal(system.reservationWrites.length, 1);
	assert.equal(reservation.reservationAuditLog.length, auditCountBefore + 1);
	assert.deepEqual(system.mirror.lastAppliedProjection, baselineBefore);
	assert.deepEqual(releasedProtectedSnapshot(reservation), protectedBefore);
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
