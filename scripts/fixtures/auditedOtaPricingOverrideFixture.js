/** @format */

"use strict";

const mongoose = require("mongoose");

const {
	buildAuthenticatedProviderCommercialEvidence,
} = require("../../services/otaCommercialEvidence");
const {
	hotelRunnerEmailCommercialEvidenceHash,
} = require("../../services/otaReservationMapper");

const RESERVATION_ID = "6a7e156c0efaa0e2faa4077f";
const HOTEL_ID = "6a40b6a1a6efe70450536038";
const OWNER_ID = "64c000000000000000000003";
const REVIEWER_ID = "64a000000000000000000001";
const PMS_CONFIRMATION = "5482777647";
const OTA_CONFIRMATION = "2041081954";
const REVIEWED_AT = "2026-08-13T19:35:15.199Z";
const SOURCE_RECEIVED_AT = "2026-08-13T19:05:09.000Z";
const SOURCE_HASH =
	"158b2613106438c37373553e08f1257db4f34615ffe92954b1e588b7b0dc8188";
const INBOUND_EMAIL_ID = "6a7e15690efaa0e2faa40776";

const auditedAgodaPricingOverrideReservation = () => {
	const otaIdentityKey = `agoda:${OTA_CONFIRMATION}`;
	const originalEvidence = buildAuthenticatedProviderCommercialEvidence({
		provider: "agoda",
		authenticatedProvider: "agoda",
		sourceAuthenticated: true,
		sourceTrusted: true,
		sourceType: "authenticated_ota_email",
		sourceCurrency: "SAR",
		propertyCurrency: "SAR",
		bookingBasis: "reservation_total",
		sourceHash: SOURCE_HASH,
		sourceTimestamp: SOURCE_RECEIVED_AT,
		sourceId: INBOUND_EMAIL_ID,
		guestGross: { verified: true, amount: 490.9 },
		hotelPayout: { verified: true, amount: 303.69 },
	});
	const emailEvidence = {
		version: 2,
		verified: true,
		source: "authenticated_ota_email",
		provider: "agoda",
		otaIdentityKey,
		grossTotalSar: 490.9,
		payoutTotalSar: 303.69,
		otaExpenseTotalSar: 187.21,
		otaCommissionSar: 73.61,
		deductionComponents: [
			{
				type: "commission",
				label: "Commission",
				amountSar: 73.61,
				currency: "SAR",
				source: "authenticated_agoda_email",
			},
			{
				type: "growth_program",
				label: "Agoda Growth Program",
				amountSar: 49.13,
				currency: "SAR",
				source: "authenticated_agoda_email",
			},
			{
				type: "tax_on_commission",
				label: "Tax on Commission",
				amountSar: 18.44,
				currency: "SAR",
				source: "authenticated_agoda_email",
			},
			{
				type: "targeted_promotion",
				label: "Targeted promotions",
				amountSar: 4.98,
				currency: "SAR",
				source: "authenticated_agoda_email",
			},
		],
		unclassifiedDeductionSar: 41.05,
		unpricedDeductionLabels: [],
		currency: "SAR",
		inboundEmailId: INBOUND_EMAIL_ID,
		sourceTextHash: SOURCE_HASH,
		sourceReceivedAt: SOURCE_RECEIVED_AT,
		appliedAt: new Date("2026-08-13T19:05:16.906Z"),
	};
	emailEvidence.evidenceHash =
		hotelRunnerEmailCommercialEvidenceHash(emailEvidence);

	const pricingByDay = Array.from({ length: 8 }, (_, index) => ({
		date: `2026-08-${String(index + 13).padStart(2, "0")}`,
		price: 60.15,
		totalPriceWithCommission: 60.15,
		rootPrice: 51,
		totalPriceWithoutCommission: 51,
		clientPrice: 60.15,
		netAfterExpenses: 37.21,
		netAfterOtaExpenses: 37.21,
		otaExpenseAmount: 22.94,
		platformMargin: -13.79,
	}));
	const reviewedRoom = {
		room_type: "doubleRooms",
		displayName: "Double Room",
		count: 1,
		pricingByDay,
	};

	return {
		_id: new mongoose.Types.ObjectId(RESERVATION_ID),
		confirmation_number: PMS_CONFIRMATION,
		reservation_id: OTA_CONFIRMATION,
		otaIdentityKey,
		booking_source: "agoda",
		currency: "SAR",
		reservation_status: "Pending Confirmation",
		state: "Pending Confirmation",
		payment: "paid online",
		createdAt: new Date("2026-08-13T18:00:00.000Z"),
		updatedAt: new Date(REVIEWED_AT),
		checkin_date: new Date("2026-08-13T00:00:00.000Z"),
		checkout_date: new Date("2026-08-21T00:00:00.000Z"),
		days_of_residence: 8,
		total_rooms: 1,
		total_amount: 481.2,
		paid_amount: 490.9,
		commission: 0,
		roomId: [],
		belongsTo: {
			_id: new mongoose.Types.ObjectId(OWNER_ID),
			name: "Jannat Hotels",
			email: "owner@example.test",
			role: 2000,
		},
		hotelId: {
			_id: new mongoose.Types.ObjectId(HOTEL_ID),
			hotelName: "Ajyad Hotel",
			belongsTo: new mongoose.Types.ObjectId(OWNER_ID),
		},
		customer_details: {
			name: "Muhammad Zahid",
			nickName: "Muhammad",
			phone: "+966500000000",
			email: "guest@example.test",
			booking_source: "agoda",
			reservedBy: "OTA inbound email",
			confirmation_number2: OTA_CONFIRMATION,
		},
		payment_details: {
			captured: true,
			capturing: false,
			onsite_paid_amount: 0,
		},
		paid_amount_breakdown: {
			paid_online_other_platforms: 490.9,
			payment_comments: {
				paid_online_other_platforms: "Agoda collected from the guest",
			},
		},
		paypal_details: {
			captured_total_sar: 0,
			initial: {},
			mit: [],
			captures: [],
		},
		adminPricing: {
			mode: "admin_three_price",
			propertyCurrency: "SAR",
			clientTotal: 481.2,
			rootTotal: 408,
			netAfterExpensesTotal: 297.68,
			otaExpenseTotal: 183.52,
			platformMarginTotal: -110.32,
			commercialVerified: true,
			sourceCurrency: "SAR",
			sourceClientTotalSar: 490.9,
			sourceClientTotalSource: "supplierData.otaAmountSar",
			clientTotalOverrideActive: true,
			clientTotalOverrideSar: 481.2,
			clientTotalOverrideOriginalSar: 490.9,
			clientTotalOverrideAt: REVIEWED_AT,
			clientTotalOverrideBy: { _id: REVIEWER_ID, role: 1000 },
			clientTotalOverrideSource: "platform_ota_pricing_review",
		},
		adminPricingVisibility: { rootOnlyForHotelManagement: true },
		otaPlatformReview: {
			status: "released",
			lastPricingUpdatedAt: REVIEWED_AT,
			lastPricingUpdatedBy: { _id: REVIEWER_ID, role: 1000 },
		},
		ota_financial_summary: {
			clientTotal: 490.9,
			netAfterExpenses: 303.69,
			netAfterOtaExpenses: 303.69,
			otaExpenseTotal: 187.21,
			propertyCurrency: "SAR",
		},
		pickedRoomsType: [reviewedRoom],
		pickedRoomsPricing: [reviewedRoom],
		supplierData: {
			otaCreatedFromEmail: true,
			otaProvider: "agoda",
			otaCommercialEvidenceStaleReason: "",
			otaCommercialEvidence: originalEvidence,
			hotelRunnerEmailCommercialEvidence: emailEvidence,
		},
	};
};

module.exports = {
	HOTEL_ID,
	OTA_CONFIRMATION,
	PMS_CONFIRMATION,
	auditedAgodaPricingOverrideReservation,
};
