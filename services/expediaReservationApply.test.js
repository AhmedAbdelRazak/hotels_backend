/** @format */

process.env.SENDGRID_API_KEY = /^SG\./.test(process.env.SENDGRID_API_KEY || "")
	? process.env.SENDGRID_API_KEY
	: "SG.test";

const test = require("node:test");
const assert = require("node:assert/strict");
const Reservations = require("../models/reservations");
const HotelDetails = require("../models/hotel_details");
const { reconcileOtaReservation } = require("./otaReservationMapper");
const { __private } = require("./expediaReservationApply");
const {
	validateOtaCommercialEvidence,
} = require("./otaCommercialEvidence");

const expediaReservation = (confirmationNumber = "exp-123") => ({
	_id: "reservation-1",
	hotelId: "hotel-1",
	confirmation_number: "pms-123",
	otaIdentityKey: `expedia:${confirmationNumber}`,
	reservation_id: confirmationNumber,
	customer_details: {
		confirmation_number2: confirmationNumber,
	},
	supplierData: {
		otaProvider: "expedia",
		otaConfirmationNumber: confirmationNumber,
		platformConfirmationNumber: confirmationNumber,
	},
});

const matchedExistingCandidate = (overrides = {}) => ({
	confirmationNumber: "exp-match-123",
	// The collector intentionally places the matched local id here. The apply
	// path must continue to use confirmationNumber as the provider identity.
	reservationId: "local-reservation-hr-1",
	hotelId: "hotel-1",
	hotelName: "Example Hotel",
	roomName: "Standard Room",
	roomCount: 1,
	checkinDate: "2026-10-05",
	checkoutDate: "2026-10-11",
	sourceCurrency: "SAR",
	sourceAmount: 600,
	amount: 600,
	paymentCollectionModel: "ota_collect",
	paymentSummary: {
		sourceCurrency: "SAR",
		sourceTotalGuestPaymentAmount: 600,
		sourceTotalPayoutAmount: 423.45,
	},
	...overrides,
});

const matchedExistingJob = (overrides = {}) => ({
	_id: "job-match-1",
	jobNumber: "JOB-MATCH-1",
	createdAt: new Date("2026-08-09T05:00:00.000Z"),
	...overrides,
});

const directHotelRunnerReservation = (overrides = {}) => {
	const sourceWeights = [70.58, 70.58, 70.58, 70.57, 70.57, 70.57];
	const pickedRooms = [
		{
			room_type: "Standard Room",
			displayName: "Standard Room",
			sourceRoomName: "Standard Room - Room Only",
			hotelRoomConfigId: "room-1",
			localRoomConfigId: "room-1",
			count: 1,
			chosenPrice: null,
			totalPriceWithCommission: null,
			hotelShouldGet: 534,
			pricingByDay: sourceWeights.map((hotelRunnerSourcePrice, index) => ({
				date: `2026-10-${String(index + 5).padStart(2, "0")}`,
				price: null,
				clientPrice: null,
				mainPrice: null,
				rootPrice: 89,
				totalPriceWithCommission: null,
				netAfterExpenses: null,
				netAfterOtaExpenses: null,
				otaExpenseAmount: null,
				platformMargin: null,
				hotelRunnerSourcePrice,
			})),
		},
	];
	return {
		_id: "local-reservation-hr-1",
		__v: 4,
		updatedAt: new Date("2026-08-09T04:30:00.000Z"),
		hotelId: "hotel-1",
		belongsTo: "owner-1",
		confirmation_number: "pms-7255791395",
		reservation_id: "exp-match-123",
		otaIdentityKey: "expedia:exp-match-123",
		state: "confirmed",
		reservation_status: "confirmed",
		checkin_date: "2026-10-05",
		checkout_date: "2026-10-11",
		total_rooms: 1,
		total_amount: null,
		sub_total: 534,
		currency: "SAR",
		commission: 0,
		commission_ota: null,
		paid_amount: 0,
		payment_details: { captured: false, onsite_paid_amount: 0 },
		financial_cycle: { status: "open", commissionAssigned: false },
		pickedRoomsType: pickedRooms,
		pickedRoomsPricing: pickedRooms,
		adminPricing: {
			mode: "hotelrunner_api",
			source: "hotelrunner_api",
			clientTotal: null,
			rootTotal: 534,
			netAfterExpensesTotal: null,
			otaExpenseTotal: null,
			platformMarginTotal: null,
			commercialVerified: false,
		},
		ota_financial_summary: {
			show: false,
			source: "hotelrunner_api",
			clientTotal: null,
			hotelVisibleAmount: 534,
			netAfterExpenses: null,
			otaExpenseTotal: null,
			commercialVerified: false,
		},
		supplierData: {
			otaProvider: "expedia",
			suppliedBookingNo: "exp-match-123",
			otaConfirmationNumber: "exp-match-123",
			platformConfirmationNumber: "exp-match-123",
			otaAutomationPipeline: "hotelrunner-background-worker",
			otaSourceAuthority: 4,
			hotelRunner: {
				transport: "hotelrunner_api",
				reservationId: "hotelrunner-reservation-1",
				providerNumber: "exp-match-123",
			},
		},
		...overrides,
	};
};

const sumDailyField = (rooms, field) =>
	Number(
		rooms
			.flatMap((room) => room.pricingByDay)
			.reduce((sum, day) => sum + Number(day[field]), 0)
			.toFixed(2)
	);

const COMMERCIAL_PROTECTED_SET_PATHS = [
	"state",
	"reservation_status",
	"checkin_date",
	"checkout_date",
	"total_rooms",
	"sub_total",
	"currency",
	"commission",
	"belongsTo",
	"hotelId",
	"payment_details",
	"paid_amount",
	"financial_cycle",
	"adminPricing.rootTotal",
	"ota_financial_summary.hotelVisibleAmount",
	"supplierData.hotelRunner",
];

test("Expedia apply lookup passes the provider before the projection", async () => {
	const calls = [];
	const existing = expediaReservation();
	const result = await __private.findExistingForCandidate(
		{ confirmationNumber: "EXP-123" },
		{
			findReservation: async (...args) => {
				calls.push(args);
				return existing;
			},
		}
	);

	assert.equal(result.existing, existing);
	assert.equal(result.matchedLookupValue, "exp-123");
	assert.equal(calls.length, 1);
	assert.equal(calls[0][0], "exp-123");
	assert.equal(calls[0][1], "expedia");
	assert.match(calls[0][2], /confirmation_number/);
});

test("Expedia apply match explanations remain provider scoped", () => {
	const fields = __private.detectExpediaConfirmationMatchFields(
		expediaReservation(),
		"EXP-123"
	);

	assert.ok(fields.includes("otaIdentityKey"));
	assert.ok(fields.includes("supplierData.otaConfirmationNumber"));
});

test("Expedia sync lifecycle events carry the immutable job timestamp", () => {
	const createdAt = new Date("2026-08-04T12:34:56.000Z");
	const normalized = __private.candidateToNormalized({
		candidate: {
			confirmationNumber: "EXP-STATUS-123",
			hotelId: "hotel-1",
			hotelName: "Example Hotel",
			roomName: "Double Room",
			checkinDate: "2026-08-10",
			checkoutDate: "2026-08-11",
			guestName: "Example Guest",
			amount: 100,
		},
		job: {
			_id: "job-1",
			jobNumber: "JOB-1",
			createdAt,
		},
		intent: "reservation_status",
		eventType: "cancelled",
		statusToApply: "cancelled",
	});

	assert.equal(normalized.source.receivedAt, createdAt);
	assert.equal(normalized.source.from, "expedia-sync");
});

test("Expedia sync does not promote fallback FX into property-currency money", () => {
	const normalized = __private.candidateToNormalized({
		candidate: {
			confirmationNumber: "2530158461",
			hotelId: "hotel-1",
			sourceCurrency: "USD",
			sourceAmount: 146.46,
			amount: 549.23,
			totalAmountSar: 549.23,
			exchangeRateToSar: 3.75,
			exchangeRateSource: "fallback_default",
			propertyConversionVerified: false,
			paymentSummary: {
				sourceCurrency: "USD",
				sourceTotalGuestPaymentAmount: 146.46,
				totalGuestPaymentAmount: 549.23,
			},
		},
		job: {
			_id: "job-1",
			jobNumber: "JOB-1",
			createdAt: new Date("2026-08-09T03:38:15.000Z"),
		},
		intent: "new_reservation",
		eventType: "created",
		statusToApply: "confirmed",
	});

	assert.equal(normalized.sourceAmount, 146.46);
	assert.equal(normalized.sourceCurrency, "USD");
	assert.equal(normalized.totalAmountSar, null);
	assert.equal(normalized.amount, null);
	assert.equal(normalized.totalPayoutSar, null);
	assert.equal(normalized.propertyConversionVerified, false);
	assert.equal(normalized.trustedTransportProvider, "expedia");
	assert.equal(normalized.sourceSenderAuthenticated, true);
	assert.equal(validateOtaCommercialEvidence(normalized.otaCommercialEvidence).ok, true);
	assert.equal(
		normalized.otaCommercialEvidence.roles.guestGross.sourceAmount,
		146.46
	);
	assert.equal(
		normalized.otaCommercialEvidence.roles.guestGross.propertyAmount,
		null
	);
	assert.equal(normalized.otaCommercialEvidence.roles.hotelPayout.verified, false);
	assert.equal(
		normalized.otaCommercialEvidence.roles.hotelPayout.sourceAmount,
		null
	);
	assert.equal(normalized.otaCommercialEvidence.verificationState, "partial");
	assert.match(normalized.source.textHash, /^[a-f0-9]{64}$/);
	assert.equal(
		normalized.source.textHash,
		normalized.otaCommercialEvidence.provenance.primary.sourceHash
	);
});

test("Expedia portal same-currency gross and payout materialize only explicit roles", () => {
	const normalized = __private.candidateToNormalized({
		candidate: {
			confirmationNumber: "EXP-SAR-1",
			hotelId: "hotel-1",
			sourceCurrency: "SAR",
			sourceAmount: 600,
			amount: 600,
			exchangeRateToSar: 1,
			exchangeRateSource: "identity",
			paymentSummary: {
				sourceCurrency: "SAR",
				sourceTotalGuestPaymentAmount: 600,
				sourceTotalPayoutAmount: 510,
			},
		},
		job: {
			_id: "job-sar-1",
			jobNumber: "JOB-SAR-1",
			createdAt: new Date("2026-08-09T04:00:00.000Z"),
		},
		intent: "new_reservation",
		eventType: "created",
		statusToApply: "confirmed",
	});

	assert.equal(validateOtaCommercialEvidence(normalized.otaCommercialEvidence).ok, true);
	assert.equal(normalized.totalAmountSar, 600);
	assert.equal(normalized.totalPayoutSar, 510);
	assert.equal(
		normalized.otaCommercialEvidence.roles.deductionAggregate.propertyAmount,
		90
	);
	assert.equal(
		normalized.otaCommercialEvidence.roles.explicitOtaCommission.verified,
		false
	);
});

test("Expedia portal money without an explicit source currency has no commercial authority", () => {
	const normalized = __private.candidateToNormalized({
		candidate: {
			confirmationNumber: "EXP-NO-CURRENCY",
			hotelId: "hotel-1",
			sourceAmount: 600,
			paymentSummary: { sourceTotalGuestPaymentAmount: 600 },
		},
		job: {
			_id: "job-no-currency",
			jobNumber: "JOB-NO-CURRENCY",
			createdAt: new Date("2026-08-09T04:00:00.000Z"),
		},
		intent: "new_reservation",
		eventType: "created",
		statusToApply: "confirmed",
	});

	assert.equal(normalized.sourceCurrency, "");
	assert.equal(normalized.totalAmountSar, null);
	assert.equal(normalized.otaCommercialEvidence, undefined);
});

test("matched Expedia portal evidence enriches the same HotelRunner pricing without protected mutations", async () => {
	const candidate = matchedExistingCandidate();
	const job = matchedExistingJob();
	const existing = directHotelRunnerReservation();
	const originalRooms = structuredClone(existing.pickedRoomsType);
	let persisted = null;
	let loadLatestCalled = false;

	const result = await __private.applyMatchedExistingCandidate(
		{ candidate, job },
		{
			findExisting: async () => ({
				existing,
				matchedLookupValue: candidate.confirmationNumber,
			}),
			persistCommercialUpdate: async (input) => {
				persisted = input;
				return { matchedCount: 1 };
			},
			loadLatest: async () => {
				loadLatestCalled = true;
				return null;
			},
		}
	);

	assert.equal(result.status, "updated");
	assert.equal(result.action, "commercial_enriched_existing");
	assert.equal(result.reservationId, existing._id);
	assert.equal(result.expediaReservationId, candidate.confirmationNumber);
	assert.equal(result.commercialMaterialized, true);
	assert.equal(loadLatestCalled, false);
	assert.ok(persisted);
	assert.equal(persisted.existing, existing);
	assert.equal(persisted.normalized.reservationId, candidate.confirmationNumber);
	assert.equal(persisted.normalized.confirmationNumber, candidate.confirmationNumber);
	assert.equal(persisted.plan.set.total_amount, 600);
	assert.equal(persisted.plan.set["adminPricing.clientTotal"], 600);
	assert.equal(
		persisted.plan.set["adminPricing.netAfterExpensesTotal"],
		423.45
	);
	assert.equal(persisted.plan.set["adminPricing.otaExpenseTotal"], 176.55);
	assert.equal(persisted.plan.set.commission_ota, null);
	assert.equal(
		validateOtaCommercialEvidence(
			persisted.plan.set["supplierData.otaCommercialEvidence"]
		).ok,
		true
	);
	for (const path of COMMERCIAL_PROTECTED_SET_PATHS) {
		assert.equal(
			Object.prototype.hasOwnProperty.call(persisted.plan.set, path),
			false,
			`protected path ${path} must not be updated`
		);
	}
	assert.deepEqual(existing.pickedRoomsType, originalRooms);
	assert.equal(sumDailyField(persisted.plan.set.pickedRoomsType, "clientPrice"), 600);
	assert.equal(
		sumDailyField(persisted.plan.set.pickedRoomsType, "netAfterExpenses"),
		423.45
	);
	assert.equal(sumDailyField(persisted.plan.set.pickedRoomsType, "rootPrice"), 534);
	assert.ok(
		persisted.plan.set.pickedRoomsType
			.flatMap((room) => room.pricingByDay)
			.every((day) => day.rootPrice === 89)
	);
});

test("matched Expedia fallback FX attaches source evidence without canonical money", async () => {
	const candidate = matchedExistingCandidate({
		sourceCurrency: "USD",
		sourceAmount: 146.46,
		amount: 549.23,
		totalAmountSar: 549.23,
		exchangeRateToSar: 3.75,
		exchangeRateSource: "fallback_default",
		propertyConversionVerified: false,
		paymentSummary: {
			sourceCurrency: "USD",
			sourceTotalGuestPaymentAmount: 146.46,
			sourceTotalPayoutAmount: 112.92,
			totalGuestPaymentAmount: 549.23,
			totalPayoutAmount: 423.45,
			exchangeRateToSar: 3.75,
			exchangeRateSource: "fallback_default",
		},
	});
	const existing = directHotelRunnerReservation();
	let persisted = null;
	const result = await __private.applyMatchedExistingCandidate(
		{ candidate, job: matchedExistingJob() },
		{
			findExisting: async () => ({
				existing,
				matchedLookupValue: candidate.confirmationNumber,
			}),
			persistCommercialUpdate: async (input) => {
				persisted = input;
				return { matchedCount: 1 };
			},
		}
	);

	assert.equal(result.status, "updated");
	assert.equal(result.action, "commercial_evidence_attached_existing");
	assert.equal(result.commercialMaterialized, false);
	assert.ok(persisted);
	const set = persisted.plan.set;
	assert.deepEqual(Object.keys(set).sort(), [
		"supplierData.otaCommercialEvidence",
		"supplierData.otaCommercialEvidenceStaleReason",
		"supplierData.otaPaymentSummary",
		"supplierData.otaSourceAmount",
		"supplierData.otaSourceCurrency",
		"supplierData.otaSourceExchangeRateSource",
		"supplierData.otaSourceExchangeRateToSar",
	]);
	assert.equal(set["supplierData.otaSourceCurrency"], "USD");
	assert.equal(set["supplierData.otaSourceAmount"], 146.46);
	assert.equal(set["supplierData.otaSourceExchangeRateToSar"], null);
	assert.equal(
		set["supplierData.otaCommercialEvidence"].roles.guestGross.propertyAmount,
		null
	);
	assert.equal(
		set["supplierData.otaCommercialEvidence"].roles.hotelPayout.propertyAmount,
		null
	);
	for (const path of [
		"total_amount",
		"commission_ota",
		"pickedRoomsType",
		"pickedRoomsPricing",
		"adminPricing.clientTotal",
		"adminPricing.netAfterExpensesTotal",
		"ota_financial_summary.clientTotal",
		"ota_financial_summary.netAfterExpenses",
		...COMMERCIAL_PROTECTED_SET_PATHS,
	]) {
		assert.equal(
			Object.prototype.hasOwnProperty.call(set, path),
			false,
			`fallback FX must not update ${path}`
		);
	}
});

test("matched authenticated Expedia enrichment fails closed before writes for protected reservation states", async () => {
	const protectedCases = [
		{
			label: "housed or terminal",
			reason: "housing_or_terminal",
			mutate(existing) {
				existing.state = "checked_out";
				existing.reservation_status = "checked_out";
				existing.roomId = ["occupied-room-1"];
				existing.bedNumber = ["occupied-bed-1"];
			},
		},
		{
			label: "capture or settlement",
			reason: "capture_or_settlement",
			mutate(existing) {
				existing.payment_details = {
					...existing.payment_details,
					captured: true,
					processor_reference: "expedia-capture-1",
				};
			},
		},
		{
			label: "released or reviewed",
			reason: "released_or_reviewed_state",
			mutate(existing) {
				existing.otaPlatformReview = {
					status: "released",
					releasedAt: new Date("2026-08-09T04:45:00.000Z"),
					releasedBy: "operations-user-1",
				};
			},
		},
		{
			label: "manual pricing",
			reason: "manual_pricing_state",
			mutate(existing) {
				existing.adminPricing = {
					...existing.adminPricing,
					mode: "manual",
					source: "admin",
					clientTotalOverrideActive: true,
				};
			},
		},
	];

	for (const protectedCase of protectedCases) {
		const candidate = matchedExistingCandidate();
		const existing = directHotelRunnerReservation();
		protectedCase.mutate(existing);
		let persistCalls = 0;
		let loadLatestCalls = 0;
		const result = await __private.applyMatchedExistingCandidate(
			{ candidate, job: matchedExistingJob() },
			{
				findExisting: async () => ({
					existing,
					matchedLookupValue: candidate.confirmationNumber,
				}),
				persistCommercialUpdate: async () => {
					persistCalls += 1;
					throw new Error("protected enrichment must not reach a write");
				},
				loadLatest: async () => {
					loadLatestCalls += 1;
					throw new Error("protected enrichment must fail before CAS retry");
				},
			}
		);

		assert.equal(result.status, "needs_review", protectedCase.label);
		assert.equal(
			result.action,
			"needs_review_matched_existing_commercial",
			protectedCase.label
		);
		assert.equal(result.skipReason, protectedCase.reason, protectedCase.label);
		assert.match(
			result.errors.join(" "),
			new RegExp(protectedCase.reason),
			protectedCase.label
		);
		assert.equal(persistCalls, 0, protectedCase.label);
		assert.equal(loadLatestCalls, 0, protectedCase.label);
	}
});

test("matched Expedia commercial evidence is idempotent and never enters a create path", async () => {
	const candidate = matchedExistingCandidate();
	const job = matchedExistingJob();
	const normalized = __private.candidateToNormalized({
		candidate: {
			...candidate,
			reservationId: candidate.confirmationNumber,
		},
		job,
		intent: "commercial_enrichment",
		eventType: "commercial_enrichment",
		statusToApply: "",
	});
	const existing = directHotelRunnerReservation();
	existing.supplierData.otaCommercialEvidence = normalized.otaCommercialEvidence;
	let persistCalls = 0;
	const result = await __private.applyMatchedExistingCandidate(
		{ candidate, job },
		{
			findExisting: async () => ({
				existing,
				matchedLookupValue: candidate.confirmationNumber,
			}),
			persistCommercialUpdate: async () => {
				persistCalls += 1;
				return { matchedCount: 1 };
			},
		}
	);

	assert.equal(result.status, "duplicate_reservation");
	assert.equal(result.action, "commercial_evidence_already_attached");
	assert.equal(result.reservationId, existing._id);
	assert.equal(persistCalls, 0);
});

test("matched Expedia commercial CAS snapshots lifecycle, root, and HotelRunner ownership", () => {
	const existing = directHotelRunnerReservation();
	const filter = __private.matchedExistingCommercialSnapshotFilter(existing);

	assert.equal(filter._id, existing._id);
	assert.equal(filter.__v, existing.__v);
	assert.equal(filter.state, "confirmed");
	assert.equal(filter.reservation_status, "confirmed");
	assert.equal(filter.checkin_date, "2026-10-05");
	assert.equal(filter.checkout_date, "2026-10-11");
	assert.equal(filter.sub_total, 534);
	assert.equal(filter["adminPricing.rootTotal"], 534);
	assert.equal(filter["ota_financial_summary.hotelVisibleAmount"], 534);
	assert.equal(
		filter["supplierData.hotelRunner.reservationId"],
		"hotelrunner-reservation-1"
	);
	assert.equal(filter["supplierData.hotelRunner.providerNumber"], "exp-match-123");
});

test("an existing Expedia cancellation applies and persists the immutable job watermark", async () => {
	const originalReservationFind = Reservations.find;
	const originalReservationUpdateOne = Reservations.updateOne;
	const originalHotelFindById = HotelDetails.findById;
	let updateSet = null;
	const existing = expediaReservation("exp-status-123");
	existing.state = "confirmed";
	existing.reservation_status = "confirmed";
	existing.supplierData.otaLastSourceReceivedAt =
		"2026-08-04T10:00:00.000Z";
	existing.otaPlatformReview = {
		provider: "expedia",
		confirmationNumber: "exp-status-123",
	};
	Reservations.find = () => ({
		limit() {
			return this;
		},
		async exec() {
			return [existing];
		},
	});
	Reservations.updateOne = async (_filter, update) => {
		updateSet = update.$set;
		return { matchedCount: 1 };
	};
	HotelDetails.findById = () => ({
		select() {
			return this;
		},
		async lean() {
			return { _id: "hotel-1", hotelName: "Example Hotel" };
		},
	});

	try {
		const jobCreatedAt = new Date("2026-08-04T11:00:00.000Z");
		const normalized = __private.candidateToNormalized({
			candidate: {
				confirmationNumber: "exp-status-123",
				hotelId: "hotel-1",
				hotelName: "Example Hotel",
			},
			job: {
				_id: "job-status-1",
				jobNumber: "JOB-STATUS-1",
				createdAt: jobCreatedAt,
			},
			intent: "reservation_status",
			eventType: "cancelled",
			statusToApply: "cancelled",
		});
		const result = await reconcileOtaReservation(normalized);

		assert.equal(result.status, "cancelled");
		assert.equal(updateSet.state, "cancelled");
		assert.equal(updateSet.reservation_status, "cancelled");
		assert.equal(
			updateSet["supplierData.otaLastSourceReceivedAt"].toISOString(),
			jobCreatedAt.toISOString()
		);
	} finally {
		Reservations.find = originalReservationFind;
		Reservations.updateOne = originalReservationUpdateOne;
		HotelDetails.findById = originalHotelFindById;
	}
});
