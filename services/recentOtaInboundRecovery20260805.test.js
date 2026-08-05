"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { ObjectId } = require("bson");

const {
	ALL_AUDIT_IDS,
	EXPECTED_HOTEL_ID,
	EXPECTED_OWNER_ID,
	OPERATION,
	RESERVATION_TARGET_KEYS,
	TARGET_KEYS,
	TARGETS,
	applyPlanToScope,
	auditEvidenceSnapshot,
	buildBackupCollectionName,
	buildBackupRecords,
	buildRecoveryPlan,
	buildRecoveryPlans,
	canonicalEjsonSha256,
	canonicalEqual,
	classifyPlanScope,
	cloneBson,
	hasRoomConfiguration,
	targetAuditScope,
	verifyBackupRecords,
	verifyRecoveryPlan,
	verifyRepairedTarget,
	validatePricingTargetConstants,
} = require("./recentOtaInboundRecovery20260805");

const REPAIR_ID = "ota-inbound-recovery-unit-20260805";
const REPAIR_AT = "2026-08-05T13:00:00.000Z";
const BACKUP_COLLECTION = buildBackupCollectionName(REPAIR_ID);
const context = () => ({
	repairId: REPAIR_ID,
	repairAt: new Date(REPAIR_AT),
	backupCollection: BACKUP_COLLECTION,
});

const oid = (value) => new ObjectId(value);
const baseProcessors = () => ({
	payment_details: { captured: false, onsite_paid_amount: 0 },
	vcc_payment: {
		source: "",
		charged: false,
		processing: false,
		total_captured_sar: 0,
		total_captured_usd: 0,
		attempts: [],
	},
	bofa_payment: {
		secure_acceptance: { status: "not_started", callbacks: [] },
		vcc: {
			charged: false,
			processing: false,
			total_captured_sar: 0,
			total_captured_usd: 0,
			attempts: [],
		},
	},
	braintree_payment: {
		charged: false,
		processing: false,
		total_captured_usd: 0,
		attempts: [],
	},
	paypal_details: {},
	moneyTransferredToHotel: false,
	commissionPaid: false,
	adminChangeLog: [],
});

const paymentBreakdown = (amount, comment) => ({
	paid_online_via_link: 0,
	paid_at_hotel_cash: 0,
	paid_at_hotel_card: 0,
	paid_to_hotel: 0,
	paid_online_jannatbooking: 0,
	paid_online_other_platforms: amount,
	paid_online_via_instapay: 0,
	paid_no_show: 0,
	payment_comments: comment,
});

const aliases = (target) => ({
	_id: oid(target.mongoId),
	reservation_id: target.otaConfirmation,
	confirmation_number: target.pmsConfirmation,
	otaIdentityKey: target.otaIdentityKey,
	otaCrossTransportIdentityKey: target.crossTransportIdentityKey || "",
	customer_details: {
		confirmation_number2: target.otaConfirmation,
	},
	checkin_date: new Date(`${target.checkinDate}T00:00:00.000Z`),
	checkout_date: new Date(`${target.checkoutDate}T00:00:00.000Z`),
});

const supplierAliases = (target) => ({
	suppliedBookingNo: target.otaConfirmation,
	otaConfirmationNumber: target.otaConfirmation,
	platformConfirmationNumber: target.otaConfirmation,
	pmsConfirmationNumber: target.pmsConfirmation,
});

const oldPricingDay = (target, expected) => ({
	date: expected.date,
	price: target.old.clientSar / target.nights,
	clientPrice: target.old.clientSar / target.nights,
	mainPrice: target.old.clientSar / target.nights,
	rootPrice: expected.root,
	commissionRate: 20,
	totalPriceWithCommission: target.old.clientSar / target.nights,
	totalPriceWithoutCommission: expected.root,
	netAfterExpenses: target.old.payoutSar / target.nights,
	netAfterOtaExpenses: target.old.payoutSar / target.nights,
	otaExpenseAmount: target.old.expenseSar / target.nights,
	platformMargin: target.old.marginSar / target.nights,
});

const pricingReservation = (targetKey) => {
	const target = TARGETS[targetKey];
	const room = {
		room_type: target.roomType,
		displayName: target.kind === "pricing" && target.provider === "agoda"
			? "Spacious Six-Bed Room"
			: "Double Room – Comfort & Relaxation",
		hotelRoomConfigId: oid(target.roomConfigId),
		sourceRoomName: `Source room ${target.roomType}`,
		otaRoomMatchType: "explicit_capacity",
		otaRoomMatchScore: 0.98,
		chosenPrice: target.old.chosenPrice,
		count: 1,
		pricingByDay: target.daily.map((day) => oldPricingDay(target, day)),
		totalPriceWithCommission: target.old.clientSar,
		hotelShouldGet: target.old.rootSar,
	};
	const sourcePayment = {
		sourceCurrency: target.currency,
		sourceTotalGuestPaymentAmount: target.old.sourceAmount,
		totalGuestPaymentAmount: target.old.clientSar,
		currency: "SAR",
		exchangeRateToSar: target.exchangeRate,
		exchangeRateSource: target.provider === "trip" ? "fallback_default" : "identity",
		amountConvertedAt: new Date("2026-08-05T11:54:04.714Z"),
	};
	return {
		...aliases(target),
		booking_source: target.bookingSource,
		customer_details: {
			...aliases(target).customer_details,
			booking_source: target.providerLabel,
			name: "Fixture guest",
		},
		hotelId: oid(target.hotelId),
		belongsTo: oid(target.ownerId),
		roomId: [],
		pickedRoomsType: [cloneBson(room)],
		pickedRoomsPricing: [cloneBson(room)],
		total_rooms: 1,
		days_of_residence: target.nights,
		booked_at: new Date("2026-08-05T00:00:00.000Z"),
		state: "ota platform review",
		reservation_status: "ota platform review",
		total_amount: target.old.clientSar,
		paid_amount: target.old.clientSar,
		paid_amount_breakdown: paymentBreakdown(target.old.clientSar, target.paymentComment),
		sub_total: target.old.rootSar,
		commission: target.old.commissionSar,
		payment: "paid online",
		financeStatus: "paid online",
		adminPricing: {
			mode: "ota_platform_sync",
			clientTotal: target.old.clientSar,
			rootTotal: target.old.rootSar,
			netAfterExpensesTotal: target.old.payoutSar,
			otaExpenseTotal: target.old.expenseSar,
			platformMarginTotal: target.old.marginSar,
			commissionAmount: target.old.commissionSar,
			defaultDeductionRate: 0.2,
			defaultDeductionApplied: true,
			source: "ota_email_create",
			provider: target.transportProvider,
			providerLabel: target.providerLabel,
			sourceCurrency: target.currency,
			sourceAmount: target.old.sourceAmount,
			sourceExchangeRateToSar: target.exchangeRate,
			sourceExchangeRateSource: target.provider === "trip" ? "fallback_default" : "identity",
		},
		ota_financial_summary: {
			show: true,
			source: "ota_email_create",
			provider: target.transportProvider,
			providerLabel: target.providerLabel,
			currency: "SAR",
			clientTotal: target.old.clientSar,
			hotelVisibleAmount: target.old.rootSar,
			netAfterExpenses: target.old.payoutSar,
			netAfterOtaExpenses: target.old.payoutSar,
			otaExpenseTotal: target.old.expenseSar,
			platformProfit: target.old.marginSar,
			commissionAmount: target.old.commissionSar,
			sourceCurrency: target.currency,
			sourceAmount: target.old.sourceAmount,
			paymentSummary: cloneBson(sourcePayment),
		},
		supplierData: {
			...supplierAliases(target),
			supplierName: target.providerLabel,
			otaProvider: target.transportProvider,
			otaSourceAuthority: 1,
			otaAmount: target.old.sourceAmount,
			otaAmountSar: target.old.clientSar,
			otaSourceAmount: target.old.sourceAmount,
			otaSourceCurrency: target.currency,
			otaPaymentSummary: cloneBson(sourcePayment),
			otaTotalPayoutSar: target.old.payoutSar,
			otaExpenseTotalSar: target.old.expenseSar,
			otaPlatformMarginSar: target.old.marginSar,
			otaPaymentCollectionModel: "ota_collect",
			otaPaymentInstructions: "old relay instructions",
			otaLastInboundEmailId: target.audits[0].id,
			otaLastEmailAt: new Date("2026-08-05T12:00:00.000Z"),
			otaLastSourceReceivedAt: new Date(target.relayWatermark),
			otaLastEventType: "new",
		},
		otaPlatformReview: {
			status: "pending",
			source: "ota_email_create",
			inboundEmailId: target.audits[0].id,
			provider: target.transportProvider,
			providerLabel: target.providerLabel,
			confirmationNumber: target.otaConfirmation,
		},
		financial_cycle: {
			collectionModel: "pms_collected",
			status: "open",
			commissionType: "amount",
			commissionValue: target.old.commissionSar,
			commissionAmount: target.old.commissionSar,
			commissionAssigned: false,
			commissionAssignedAt: null,
			commissionAssignedBy: null,
			pmsCollectedAmount: target.old.clientSar,
			hotelCollectedAmount: 0,
			hotelPayoutDue: target.old.rootSar,
			commissionDueToPms: 0,
		},
		availabilitySnapshot: { captured: true, immutableMarker: targetKey },
		reservationAuditLog: [{ action: "created", at: new Date("2026-08-05T12:00:00.000Z") }],
		...baseProcessors(),
		updatedAt: new Date("2026-08-05T12:00:00.000Z"),
		__v: target.expectedVersion,
	};
};

const cancellationReservation = (state = "confirmed", reservationStatus = "inhouse") => {
	const target = TARGETS.airbnb_cancellation_hm2w4qqrt9;
	const room = {
		room_type: "familyRooms",
		displayName: "Family Quintuple Room",
		chosenPrice: "80.00",
		count: 1,
		pricingByDay: ["05", "06", "07", "08"].map((day) => ({
			date: `2026-08-${day}`,
			clientPrice: 80,
			rootPrice: 0,
			netAfterOtaExpenses: day === "08" ? 69.53 : 69.54,
		})),
		totalPriceWithCommission: 320,
		hotelShouldGet: 0,
	};
	return {
		...aliases(target),
		booking_source: "airbnb",
		customer_details: { ...aliases(target).customer_details, booking_source: "Airbnb" },
		hotelId: oid(target.hotelId),
		belongsTo: oid(target.ownerId),
		roomId: [oid("6a4e146ededc8e0e7a768d71")],
		pickedRoomsType: [cloneBson(room)],
		pickedRoomsPricing: [cloneBson(room)],
		state,
		reservation_status: reservationStatus,
		total_amount: 320,
		paid_amount: 320,
		paid_amount_breakdown: paymentBreakdown(388.8, "Airbnb collected by platform"),
		sub_total: 0,
		commission: 0,
		payment: "paid online",
		financeStatus: "paid online",
		adminPricing: { clientTotal: 320, rootTotal: 0, netAfterExpensesTotal: 278.15 },
		supplierData: {
			...supplierAliases(target),
			supplierName: "Airbnb",
			otaProvider: "airbnb",
			otaSourceAmount: 388.8,
			otaPaymentSummary: { totalGuestPaymentAmount: 388.8, totalPayoutAmount: 278.16 },
			otaLastInboundEmailId: target.audits[0].id,
			otaLastEventType: "new",
		},
		otaPlatformReview: {
			status: "released",
			provider: "airbnb",
			providerLabel: "Airbnb",
			confirmationNumber: target.otaConfirmation,
			releasedAt: new Date("2026-07-06T15:17:25.821Z"),
		},
		pendingConfirmation: {
			status: "confirmed",
			confirmationReason: "Manual confirmation",
			confirmedAt: new Date("2026-07-06T15:22:04.452Z"),
		},
		agentDecisionSnapshot: {
			status: "confirmed",
			reason: "Manual confirmation",
			decidedAt: new Date("2026-07-06T15:22:04.452Z"),
		},
		financial_cycle: {
			collectionModel: "pms_collected",
			status: "open",
			pmsCollectedAmount: 388.8,
			hotelPayoutDue: 320,
			commissionAssigned: true,
			closedAt: null,
			closedBy: null,
		},
		commissionData: {
			assigned: true,
			amount: 0,
			status: "no commission due",
			assignedAt: new Date("2026-07-06T15:21:14.831Z"),
			proposedByAgent: false,
		},
		commissionStatus: "no commission due",
		availabilitySnapshot: { captured: true, immutableMarker: "airbnb" },
		reservationAuditLog: [{ action: "manual-release" }],
		...baseProcessors(),
		updatedAt: new Date("2026-08-05T05:32:36.976Z"),
		__v: target.expectedVersion,
	};
};

const hotelAssignmentReservation = (targetKey) => {
	const target = TARGETS[targetKey];
	const nightlyClient = Number((target.clientTotal / target.nights).toFixed(2));
	const dates = [];
	for (let at = new Date(`${target.checkinDate}T00:00:00.000Z`); at < new Date(`${target.checkoutDate}T00:00:00.000Z`); at = new Date(at.getTime() + 86400000)) {
		dates.push(at.toISOString().slice(0, 10));
	}
	const room = {
		room_type: "familyRooms",
		displayName: "Deluxe Family Room 2 - Non-Refundable - 4 Occupancy | غرفة عائلة لاربع أفراد",
		chosenPrice: nightlyClient,
		count: 1,
		pricingByDay: dates.map((date) => ({
			date,
			price: nightlyClient,
			clientPrice: nightlyClient,
			mainPrice: nightlyClient,
			rootPrice: 0,
			commissionRate: 0,
			totalPriceWithCommission: nightlyClient,
			totalPriceWithoutCommission: 0,
			netAfterExpenses: Number((target.payoutTotal / target.nights).toFixed(2)),
			netAfterOtaExpenses: Number((target.payoutTotal / target.nights).toFixed(2)),
			otaExpenseAmount: Number((target.expenseTotal / target.nights).toFixed(2)),
			platformMargin: 0,
			platformMarginRate: 0,
		})),
		totalPriceWithCommission: target.clientTotal,
		hotelShouldGet: 0,
	};
	return {
		...aliases(target),
		booking_source: "agoda",
		customer_details: { ...aliases(target).customer_details, booking_source: "Agoda" },
		hotelId: null,
		belongsTo: null,
		roomId: [],
		pickedRoomsType: [cloneBson(room)],
		pickedRoomsPricing: [cloneBson(room)],
		state: "ota platform review",
		reservation_status: "ota platform review",
		total_amount: target.clientTotal,
		paid_amount: target.clientTotal,
		paid_amount_breakdown: paymentBreakdown(target.clientTotal, "Agoda collected by platform"),
		sub_total: 0,
		commission: 0,
		payment: "paid online",
		financeStatus: "paid online",
		adminPricing: {
			mode: "ota_platform_unmapped",
			clientTotal: target.clientTotal,
			rootTotal: 0,
			netAfterExpensesTotal: target.payoutTotal,
			otaExpenseTotal: target.expenseTotal,
			platformMarginTotal: 0,
			commissionAmount: 0,
			defaultDeductionApplied: true,
			hotelAssignmentRequired: true,
		},
		ota_financial_summary: {
			clientTotal: target.clientTotal,
			hotelVisibleAmount: 0,
			netAfterExpenses: target.payoutTotal,
			otaExpenseTotal: target.expenseTotal,
			platformProfit: 0,
			commissionAmount: 0,
		},
		supplierData: {
			...supplierAliases(target),
			supplierName: "Agoda",
			otaProvider: "agoda",
			otaSourceAuthority: 1,
			otaHotelName: "Zad Ajyad",
			otaHotelMappingRequired: true,
			otaSourceAmount: target.clientTotal,
			otaPaymentSummary: { totalGuestPaymentAmount: target.clientTotal },
			otaTotalPayoutSar: target.payoutTotal,
			otaExpenseTotalSar: target.expenseTotal,
			otaLastSourceReceivedAt: new Date(target.relayWatermark),
			otaLastInboundEmailId: target.audits[0].id,
			otaLastEventType: "new",
		},
		otaPlatformReview: {
			status: "pending",
			provider: "agoda",
			providerLabel: "Agoda",
			confirmationNumber: target.otaConfirmation,
			hotelAssignmentRequired: true,
			hotelAssignmentStatus: "missing",
			originalHotelName: "Zad Ajyad",
			otaRoomName: room.displayName,
			inboundEmailId: target.audits[0].id,
		},
		financial_cycle: {
			collectionModel: "pms_collected",
			status: "open",
			commissionType: "amount",
			commissionValue: 0,
			commissionAmount: 0,
			commissionAssigned: false,
			commissionAssignedAt: null,
			commissionAssignedBy: null,
			pmsCollectedAmount: target.clientTotal,
			hotelCollectedAmount: 0,
			hotelPayoutDue: target.clientTotal,
			commissionDueToPms: 0,
			closedAt: null,
			closedBy: null,
		},
		availabilitySnapshot: { captured: false, immutableMarker: targetKey, rooms: [] },
		reservationAuditLog: [{ action: "created-unmapped" }],
		...baseProcessors(),
		updatedAt: new Date("2026-08-05T12:17:30.854Z"),
		__v: target.expectedVersion,
	};
};

const hotelFixture = () => ({
	_id: oid(EXPECTED_HOTEL_ID),
	hotelName: "zad ajyad",
	hotelName_OtherLanguage: "فندق زاد أجياد",
	belongsTo: oid(EXPECTED_OWNER_ID),
	activateHotel: true,
	xHotelProActive: true,
});

const auditFixture = (targetKey, expected) => {
	const target = TARGETS[targetKey];
	const hasReservation = Boolean(target.mongoId);
	const normalized = {
		provider: expected.provider,
		providerLabel:
			expected.provider === "hotelrunner"
				? "HotelRunner"
				: expected.provider === "trip"
					? "Trip.com"
					: expected.provider === "agoda"
						? "Agoda"
						: "Airbnb",
		sourceSenderTrusted: Boolean(expected.trustedProvider),
		sourceSenderAuthenticated: Boolean(expected.trustedProvider),
		intent: "new_reservation",
		eventType: "new",
		statusToApply: "",
		confirmationNumber: target.otaConfirmation || "hm2d9npr35",
		hotelName: hasReservation ? "Zad Ajyad" : "Comfy Family 6 Beds Room",
		roomName: hasReservation ? "Source room wording" : "Airbnb listing payout wording",
		checkinDate: hasReservation ? target.checkinDate : "2026-08-04",
		checkoutDate: hasReservation ? target.checkoutDate : "2026-08-06",
		amount: 0,
		currency: "SAR",
		totalAmountSar: 0,
		totalPayoutSar: 0,
		paymentCollectionModel: "ota_collect",
		paymentInstructions: "fixture instructions",
		source: expected.sourceReceivedAt
			? { receivedAt: new Date(expected.sourceReceivedAt), immutableSourceMarker: expected.id }
			: { immutableSourceMarker: expected.id },
	};
	if (target.kind === "pricing") {
		const direct = expected.role === "authoritative_direct_pricing";
		normalized.amount = direct ? target.corrected.clientSource : target.old.sourceAmount;
		normalized.currency = target.currency;
		normalized.totalAmountSar = direct ? target.corrected.clientSar : target.old.clientSar;
		normalized.totalPayoutSar = direct ? target.corrected.payoutSar : 0;
		normalized.paymentInstructions = direct ? target.paymentInstructions : "relay instructions";
		if (direct) {
			normalized.sourceCurrency = target.currency;
			normalized.exchangeRateToSar = target.exchangeRate;
			normalized.exchangeRateSource = target.exchangeRateSource;
			normalized.amountConvertedAt = new Date(target.amountConvertedAt);
			normalized.paymentSummary = {
				sourceCurrency: target.currency,
				sourceTotalGuestPaymentAmount: target.corrected.clientSource,
				sourceTotalPayoutAmount: target.corrected.payoutSource,
				totalGuestPaymentAmount: target.corrected.clientSar,
				totalPayoutAmount: target.corrected.payoutSar,
				currency: "SAR",
				exchangeRateToSar: target.exchangeRate,
				exchangeRateSource: target.exchangeRateSource,
				amountConvertedAt: new Date(target.amountConvertedAt),
			};
		}
	}
	if (target.kind === "hotel_assignment") {
		const direct = expected.role === "authoritative_direct_pricing";
		normalized.amount = direct ? target.corrected.clientSource : target.clientTotal;
		normalized.totalAmountSar = direct ? target.corrected.clientSar : target.clientTotal;
		normalized.totalPayoutSar = direct ? target.corrected.payoutSar : 0;
		normalized.hotelName = direct ? "Zyd Agyad" : "Zad Ajyad";
		normalized.hotelNameAliases = direct
			? ["Zyd Agyad", "Zyd Ajyad", "Zad Agyad", "Zad Ajyad", "ZAD AJYAD"]
			: ["Zad Ajyad"];
		normalized.currency = "SAR";
		normalized.sourceCurrency = "SAR";
		normalized.sourceAmount = normalized.amount;
		normalized.exchangeRateToSar = 1;
		normalized.exchangeRateSource = "identity";
		normalized.paymentCollectionModel = "ota_collect";
		normalized.paymentInstructions = direct ? target.paymentInstructions : "Merchance";
		if (direct) {
			normalized.amountConvertedAt = new Date(target.corrected.amountConvertedAt);
			normalized.paymentSummary = {
				sourceCurrency: "SAR",
				sourceTotalGuestPaymentAmount: target.corrected.clientSource,
				sourceTotalPayoutAmount: target.corrected.payoutSource,
				totalGuestPaymentAmount: target.corrected.clientSar,
				totalPayoutAmount: target.corrected.payoutSar,
				currency: "SAR",
				exchangeRateToSar: 1,
				exchangeRateSource: "identity",
				amountConvertedAt: new Date(target.corrected.amountConvertedAt),
			};
		}
	}
	if (target.kind === "cancellation") {
		if (expected.role === "creation_identity_and_stay_evidence") {
			normalized.totalAmountSar = 388.8;
			normalized.amount = 388.8;
			normalized.hotelName = "Arabic Airbnb listing";
		} else {
			normalized.intent = "reservation_status";
			normalized.eventType = "cancelled";
			normalized.statusToApply = "cancelled";
			normalized.hotelName = "";
			normalized.roomName = "";
			normalized.checkinDate = null;
			normalized.checkoutDate = null;
		}
	}
	if (target.kind === "audit_only") {
		normalized.intent = "new_reservation";
		normalized.eventType = "unknown";
		normalized.amount = 108.75;
		normalized.totalAmountSar = 108.75;
	}
	const reconciliation = {
		status: expected.processingStatus,
		actionTaken: expected.automationAction,
		skipReason: expected.skipReason,
		automationComment: "Original outcome",
		warnings: [],
		errors: expected.skipReason ? ["Original review reason"] : [],
	};
	if (hasReservation) {
		reconciliation.reservationId = oid(target.mongoId);
		reconciliation.hotelId = target.kind === "hotel_assignment" ? null : oid(target.hotelId);
		reconciliation.pmsConfirmationNumber = target.pmsConfirmation;
		reconciliation.matchedReservationBy = expected.processingStatus === "needs_review" ? ["otaIdentityKey", "reservation_id"] : [];
	}
	return {
		_id: oid(expected.id),
		source: "sendgrid",
		provider: expected.provider,
		providerLabel: normalized.providerLabel,
		intent: normalized.intent,
		eventType: normalized.eventType,
		processingStatus: expected.processingStatus,
		automationAction: expected.automationAction,
		skipReason: expected.skipReason,
		automationComment: "Original outcome",
		hasReservationConnection: hasReservation,
		matchedReservationBy: cloneBson(reconciliation.matchedReservationBy || []),
		from: `${expected.provider}@example.invalid`,
		to: "ota@example.invalid",
		subject: `Fixture ${expected.id}`,
		messageId: `<${expected.id}@fixture.invalid>`,
		emailHash: expected.emailHash,
		textHash: expected.textHash,
		dedupeKey: `fixture:${expected.id}`,
		bodyText: `Immutable body ${expected.id}`,
		bodyHtml: `<p>Immutable body ${expected.id}</p>`,
		safeSnippet: `Immutable snippet ${expected.id}`,
		attachments: [{ filename: "fixture.pdf", contentHash: expected.textHash }],
		senderAuthentication: expected.trustedProvider
			? {
				authenticatedAligned: true,
				trustedProvider: expected.trustedProvider,
				method: expected.trustedProvider === "hotelrunner" ? "spf+dkim" : "dkim",
			}
			: undefined,
		confirmationNumber: target.otaConfirmation || "hm2d9npr35",
		pmsConfirmationNumber: hasReservation ? target.pmsConfirmation : "",
		hotelName: normalized.hotelName,
		roomName: normalized.roomName,
		sourceAmount: normalized.amount,
		sourceCurrency: normalized.currency,
		totalAmountSar: normalized.totalAmountSar,
		paymentCollectionModel: normalized.paymentCollectionModel,
		hotelId:
			target.kind === "hotel_assignment" || target.kind === "audit_only"
				? null
				: hasReservation
					? oid(target.hotelId)
					: null,
		reservationMongoId: hasReservation ? oid(target.mongoId) : null,
		normalizedReservation: normalized,
		emailContext: { forwarded: false, immutableContextMarker: expected.id },
		orchestratorDecision: { usedAI: false, immutableDecisionMarker: expected.id },
		reconciliation,
		forwardDecision: { shouldForward: true, immutableForwardMarker: expected.id },
		forwarding: { status: "sent", immutableForwardingMarker: expected.id },
		parseWarnings: [],
		parseErrors: [],
		reconcileWarnings: [],
		reconcileErrors: expected.skipReason ? ["Original review reason"] : [],
		receivedAt: new Date(expected.receivedAt || "2026-08-05T12:00:00.000Z"),
		processedAt: new Date("2026-08-05T12:00:02.000Z"),
		createdAt: new Date("2026-08-05T12:00:00.100Z"),
		updatedAt: new Date("2026-08-05T12:00:03.000Z"),
		__v: 0,
	};
};

const reservationFixture = (targetKey) => {
	const target = TARGETS[targetKey];
	if (target.kind === "pricing") return pricingReservation(targetKey);
	if (target.kind === "cancellation") return cancellationReservation();
	if (target.kind === "hotel_assignment") return hotelAssignmentReservation(targetKey);
	return null;
};

const targetFixture = (targetKey, overrides = {}) => {
	const target = TARGETS[targetKey];
	return {
		targetKey,
		reservation: ownOverride(overrides, "reservation")
			? overrides.reservation
			: reservationFixture(targetKey),
		audits: target.audits.map((expected) => auditFixture(targetKey, expected)),
		hotel: target.kind === "hotel_assignment" ? hotelFixture() : null,
		context: context(),
		...overrides,
	};
};

function ownOverride(object, key) {
	return Object.prototype.hasOwnProperty.call(object || {}, key);
}

const fullFixture = () => ({
	reservations: RESERVATION_TARGET_KEYS.map((targetKey) => reservationFixture(targetKey)),
	audits: TARGET_KEYS.flatMap((targetKey) => TARGETS[targetKey].audits.map((expected) => auditFixture(targetKey, expected))),
	hotels: [hotelFixture()],
	context: context(),
});

test("fixed scope contains six reservations, seven operations, and thirteen exact audit IDs", () => {
	assert.equal(TARGET_KEYS.length, 7);
	assert.equal(RESERVATION_TARGET_KEYS.length, 6);
	assert.equal(ALL_AUDIT_IDS.length, 13);
	assert.equal(new Set(ALL_AUDIT_IDS).size, 13);
	assert.deepEqual(
		TARGET_KEYS,
		[
			"agoda_pricing_2038722839",
			"agoda_pricing_2038686448",
			"trip_pricing_1433813442496171",
			"airbnb_cancellation_hm2w4qqrt9",
			"agoda_hotel_2038703612",
			"agoda_hotel_2038704202",
			"airbnb_payout",
		],
	);
	assert.deepEqual(targetAuditScope("agoda_hotel_2038703612").auditIds, [
		"6a73267239b444f30248e34e",
		"6a732cd039b444f30248ed10",
	]);
});

test("Agoda 2038686448 target is locked to the independently audited production facts", () => {
	const target = TARGETS.agoda_pricing_2038686448;
	assert.deepEqual(
		{
			kind: target.kind,
			mongoId: target.mongoId,
			pmsConfirmation: target.pmsConfirmation,
			otaConfirmation: target.otaConfirmation,
			otaIdentityKey: target.otaIdentityKey,
			crossTransportIdentityKey: target.crossTransportIdentityKey,
			hotelId: target.hotelId,
			ownerId: target.ownerId,
			checkinDate: target.checkinDate,
			checkoutDate: target.checkoutDate,
			roomType: target.roomType,
			roomConfigId: target.roomConfigId,
			nights: target.nights,
			provider: target.provider,
			providerLabel: target.providerLabel,
			transportProvider: target.transportProvider,
			bookingSource: target.bookingSource,
			currency: target.currency,
			exchangeRate: target.exchangeRate,
			exchangeRateSource: target.exchangeRateSource,
			amountConvertedAt: target.amountConvertedAt,
			paymentInstructions: target.paymentInstructions,
			paymentComment: target.paymentComment,
			sourceClientTotalSource: target.sourceClientTotalSource,
			relayWatermark: target.relayWatermark,
			expectedVersion: target.expectedVersion,
		},
		{
			kind: "pricing",
			mongoId: "6a733f4e39b444f3024905ff",
			pmsConfirmation: "6567634147",
			otaConfirmation: "2038686448",
			otaIdentityKey: "agoda:2038686448",
			crossTransportIdentityKey: "",
			hotelId: "6a40b6a1a6efe70450536038",
			ownerId: "68b74714fb50e159d48c714d",
			checkinDate: "2026-08-05",
			checkoutDate: "2026-08-06",
			roomType: "tripleRooms",
			roomConfigId: "6a40e0981a6d1850eb25c27c",
			nights: 1,
			provider: "agoda",
			providerLabel: "Agoda",
			transportProvider: "agoda",
			bookingSource: "agoda",
			currency: "SAR",
			exchangeRate: 1,
			exchangeRateSource: "identity",
			amountConvertedAt: "2026-08-05T14:30:39.677Z",
			paymentInstructions: "Agoda prepaid reservation; net rate is provided by Agoda.",
			paymentComment: "Agoda collected by platform",
			sourceClientTotalSource: "agoda_direct_email_guest_total",
			relayWatermark: "2026-08-05T08:24:41.000Z",
			expectedVersion: 0,
		},
	);
	assert.deepEqual(target.old, {
		clientSar: 46.69,
		payoutSar: 37.35,
		expenseSar: 9.34,
		rootSar: 75,
		marginSar: -37.65,
		commissionSar: 15,
		sourceAmount: 46.69,
		chosenPrice: 46.69,
	});
	assert.deepEqual(target.corrected, {
		clientSource: 75.46,
		payoutSource: 46.69,
		clientSar: 75.46,
		payoutSar: 46.69,
		expenseSar: 28.77,
		rootSar: 75,
		marginSar: -28.31,
		commissionSar: 15,
		chosenPrice: 75.46,
	});
	assert.deepEqual(target.daily, [
		{ date: "2026-08-05", client: 75.46, payout: 46.69, expense: 28.77, root: 75, margin: -28.31 },
	]);
	assert.deepEqual(target.audits, [
		{
			id: "6a733f4b39b444f3024905f6",
			role: "creating_relay_evidence",
			mutable: false,
			emailHash: "badbe215a80e019aa32fccfcd99db8d8e69ccd4f78c1a5494fb3e99f60f38989",
			textHash: "3eb809289d651cf98ff93564b6e438a19e9c1a1abbb8900aa884d90074e3cd66",
			provider: "agoda",
			trustedProvider: "hotelrunner",
			sourceReceivedAt: "2026-08-05T08:24:41.000Z",
			processingStatus: "created",
			automationAction: "created",
			skipReason: "",
		},
		{
			id: "6a73490f39b444f302491651",
			role: "authoritative_direct_pricing",
			mutable: true,
			emailHash: "1ce9f8eadcea901a6f3cf9159835f70a21b5de8f1eeb5c3d9c8514787097fb6f",
			textHash: "0580f1366981287e739883319621895143bbc81066138645995a64c10200313f",
			provider: "agoda",
			trustedProvider: "agoda",
			sourceReceivedAt: "2026-08-05T08:21:24.000Z",
			processingStatus: "needs_review",
			automationAction: "skipped",
			skipReason: "stale_ota_lifecycle_event",
		},
	]);
});

test("all pricing targets satisfy fixed source conversion, stay, and cent-exact arithmetic invariants", () => {
	for (const targetKey of [
		"agoda_pricing_2038722839",
		"agoda_pricing_2038686448",
		"trip_pricing_1433813442496171",
	]) {
		assert.equal(validatePricingTargetConstants(TARGETS[targetKey]), TARGETS[targetKey]);
	}
});

test("pricing target arithmetic validation rejects every derived or nightly inconsistency", () => {
	const mutations = [
		["night count", (target) => { target.nights += 1; }],
		["checkout", (target) => { target.checkoutDate = "2026-08-07"; }],
		["old expense", (target) => { target.old.expenseSar += 0.01; }],
		["old margin", (target) => { target.old.marginSar += 0.01; }],
		["corrected expense", (target) => { target.corrected.expenseSar += 0.01; }],
		["corrected margin", (target) => { target.corrected.marginSar += 0.01; }],
		["old source conversion", (target) => { target.old.sourceAmount += 0.01; }],
		["guest source conversion", (target) => { target.corrected.clientSource += 0.01; }],
		["payout source conversion", (target) => { target.corrected.payoutSource += 0.01; }],
		["source-client-total provenance", (target) => { target.sourceClientTotalSource = "generic_total"; }],
		["old chosen price", (target) => { target.old.chosenPrice += 0.01; }],
		["corrected chosen price", (target) => { target.corrected.chosenPrice += 0.01; }],
		["nightly date", (target) => { target.daily[0].date = "2026-08-06"; }],
		["nightly expense", (target) => { target.daily[0].expense += 0.01; }],
		["nightly margin", (target) => { target.daily[0].margin += 0.01; }],
		["nightly aggregate", (target) => {
			target.daily[0].client += 0.01;
			target.daily[0].expense += 0.01;
		}],
		["nightly root aggregate", (target) => {
			target.daily[0].root += 0.01;
			target.daily[0].margin -= 0.01;
		}],
	];
	for (const [label, mutate] of mutations) {
		const target = cloneBson(TARGETS.agoda_pricing_2038686448);
		mutate(target);
		assert.throws(
			() => validatePricingTargetConstants(target),
			undefined,
			`2038686448 accepted ${label} drift.`,
		);
	}
});

test("combined hotel/commercial plans select exact Zad Ajyad, apply direct totals, and leave every room unmapped", () => {
	for (const targetKey of ["agoda_hotel_2038703612", "agoda_hotel_2038704202"]) {
		const fixture = targetFixture(targetKey);
		const availabilityBefore = cloneBson(fixture.reservation.availabilitySnapshot);
		const protectedPaymentBefore = cloneBson({
			paymentDetails: fixture.reservation.payment_details,
			vcc: fixture.reservation.vcc_payment,
			bofa: fixture.reservation.bofa_payment,
			braintree: fixture.reservation.braintree_payment,
			paypal: fixture.reservation.paypal_details,
		});
		const plan = buildRecoveryPlan(fixture);
		const after = plan.reservationPlan.expectedDocument;
		assert.equal(String(after.hotelId), EXPECTED_HOTEL_ID);
		assert.equal(String(after.belongsTo), EXPECTED_OWNER_ID);
		assert.deepEqual(after.roomId, []);
		assert.equal(hasRoomConfiguration(after), false);
		assert.equal(after.otaPlatformReview.status, "pending");
		assert.equal(after.otaPlatformReview.hotelAssignmentStatus, "assigned");
		assert.equal(after.otaPlatformReview.roomMappingStatus, "unreviewed");
		assert.equal(after.otaPlatformReview.hotelAssignmentRequired, false);
		assert.equal(Object.hasOwn(after.otaPlatformReview, "inventoryBlocks"), false);
		assert.equal(after.adminPricing.mode, "ota_assignment_pending_pricing");
		assert.equal(after.adminPricing.pricingReviewRequired, true);
		assert.equal(after.total_amount, plan.target.corrected.clientSar);
		assert.equal(after.paid_amount, plan.target.corrected.clientSar);
		assert.equal(after.paid_amount_breakdown.paid_online_other_platforms, plan.target.corrected.clientSar);
		assert.equal(after.adminPricing.netAfterExpensesTotal, plan.target.corrected.payoutSar);
		assert.equal(after.adminPricing.otaExpenseTotal, plan.target.corrected.expenseSar);
		assert.equal(after.adminPricing.defaultDeductionApplied, false);
		assert.equal(after.supplierData.otaSourceAuthority, 3);
		assert.equal(after.supplierData.otaPaymentInstructions, plan.target.paymentInstructions);
		assert.equal(new Date(after.supplierData.otaLastSourceReceivedAt).toISOString(), plan.target.relayWatermark);
		assert.equal(after.adminPricing.rootTotal, 0);
		assert.equal(after.sub_total, 0);
		assert.equal(after.commission, 0);
		assert.ok(after.pickedRoomsType.every((room) => room.room_type === "familyRooms"));
		assert.ok(after.pickedRoomsType.every((room) => !room.hotelRoomConfigId));
		assert.ok(after.pickedRoomsType.every((room) => room.pricingByDay.every((day) => day.rootPrice === 0 && day.platformMargin === 0)));
		assert.ok(canonicalEqual(after.availabilitySnapshot, availabilityBefore));
		assert.ok(canonicalEqual({
			paymentDetails: after.payment_details,
			vcc: after.vcc_payment,
			bofa: after.bofa_payment,
			braintree: after.braintree_payment,
			paypal: after.paypal_details,
		}, protectedPaymentBefore));
		assert.equal(plan.auditPlans.length, 2);
		assert.equal(plan.auditPlans[0].expectedDocument.processingStatus, "created");
		assert.equal(plan.auditPlans[0].expectedDocument.automationAction, "created_unmapped_ota_review");
		assert.equal(String(plan.auditPlans[0].expectedDocument.hotelId), EXPECTED_HOTEL_ID);
		assert.equal(plan.auditPlans[1].expectedDocument.processingStatus, "updated");
		assert.equal(plan.auditPlans[1].expectedDocument.automationAction, "updated");
		assert.equal(plan.auditPlans[1].expectedDocument.skipReason, "");
		assert.equal(plan.immutableEvidence.length, 0);
		verifyRecoveryPlan(plan);
	}
});

test("hotel recovery accepts only the observed absent relay-authority field or canonical authority one", () => {
	for (const targetKey of ["agoda_hotel_2038703612", "agoda_hotel_2038704202"]) {
		const absentFixture = targetFixture(targetKey);
		delete absentFixture.reservation.supplierData.otaSourceAuthority;
		const absentPlan = buildRecoveryPlan(absentFixture);
		assert.equal(absentPlan.reservationPlan.expectedDocument.supplierData.otaSourceAuthority, 3);

		for (const invalidAuthority of [null, 0, 2, 3, "1", true, [1]]) {
			const invalidFixture = targetFixture(targetKey);
			invalidFixture.reservation.supplierData.otaSourceAuthority = invalidAuthority;
			assert.throws(
				() => buildRecoveryPlan(invalidFixture),
				/supplierData\.otaSourceAuthority/,
				`${targetKey}:${String(invalidAuthority)}`,
			);
		}
	}
});

test("hotel assignment rejects a wrong, inactive, owner-mismatched, or approximate hotel", () => {
	for (const mutate of [
		(hotel) => { hotel._id = oid("6a40b6a1a6efe70450536039"); },
		(hotel) => { hotel.belongsTo = oid("68b74714fb50e159d48c714e"); },
		(hotel) => { hotel.activateHotel = false; },
		(hotel) => { hotel.xHotelProActive = false; },
		(hotel) => { hotel.hotelName = "Another Ajyad Hotel"; },
	]) {
		const fixture = targetFixture("agoda_hotel_2038704202");
		mutate(fixture.hotel);
		assert.throws(() => buildRecoveryPlan(fixture));
	}
});

test("hotel assignment preflight rejects room configuration, root, total, identity, and audit drift", () => {
	const mutations = [
		(fixture) => { fixture.reservation.reservation_id = "2038704203"; },
		(fixture) => { fixture.reservation.total_amount += 0.01; },
		(fixture) => { fixture.reservation.adminPricing.netAfterExpensesTotal += 0.01; },
		(fixture) => { fixture.reservation.pickedRoomsType[0].hotelRoomConfigId = oid("6a40df5f1a6d1850eb25c183"); },
		(fixture) => { fixture.reservation.pickedRoomsType[0].roomId = oid("6a40df5f1a6d1850eb25c183"); },
		(fixture) => { fixture.reservation.pickedRoomsType[0].otaMatchedRoomName = "Employee mapped room"; },
		(fixture) => { fixture.reservation.pickedRoomsType[0].otaRoomMatchReason = "Manual selection"; },
		(fixture) => { fixture.reservation.pickedRoomsType[0].otaRoomMatchedByModel = "manual"; },
		(fixture) => { fixture.reservation.pickedRoomsType[0].otaRoomMatchType = "manual"; },
		(fixture) => { fixture.reservation.pickedRoomsType[0].otaRoomMatchScore = 1; },
		(fixture) => { fixture.reservation.pickedRoomsType[0].adminPricing = { rootTotal: 1 }; },
		(fixture) => { fixture.reservation.adminPricing.clientTotalOverride = 500; },
		(fixture) => { fixture.reservation.adminPricing.mode = "manual"; },
		(fixture) => { fixture.reservation.adminPricing.hotelAssignmentRequired = false; },
		(fixture) => { fixture.reservation.adminPricing.defaultDeductionApplied = false; },
		(fixture) => { fixture.reservation.adminPricing.assignedHotelId = EXPECTED_HOTEL_ID; },
		(fixture) => { fixture.reservation.adminPricing.assignedHotelName = "zad ajyad"; },
		(fixture) => { fixture.reservation.adminPricing.pricingReviewRequired = true; },
		(fixture) => { fixture.reservation.otaPlatformReview.inboundEmailId = fixture.audits[1]._id; },
		(fixture) => { fixture.reservation.otaPlatformReview.assignedHotelId = EXPECTED_HOTEL_ID; },
		(fixture) => { fixture.reservation.otaPlatformReview.assignedHotelName = "zad ajyad"; },
		(fixture) => { fixture.reservation.otaPlatformReview.assignedAt = new Date(REPAIR_AT); },
		(fixture) => { fixture.reservation.otaPlatformReview.assignedBy = { role: "employee" }; },
		(fixture) => { fixture.reservation.otaPlatformReview.roomMappingStatus = "mapped"; },
		(fixture) => { fixture.reservation.otaPlatformReview.roomMappingHotelId = EXPECTED_HOTEL_ID; },
		(fixture) => { fixture.reservation.otaPlatformReview.pricingInvalidatedAt = new Date(REPAIR_AT); },
		(fixture) => { fixture.reservation.otaPlatformReview.pricingInvalidationReason = "employee"; },
		(fixture) => { fixture.reservation.otaPlatformReview.lastPricingUpdatedAt = new Date(REPAIR_AT); },
		(fixture) => { fixture.reservation.supplierData.otaSourceAuthority = 3; },
		(fixture) => { fixture.reservation.supplierData.otaLastInboundEmailId = fixture.audits[1]._id; },
		(fixture) => { fixture.reservation.supplierData.otaLastEventType = "updated"; },
		(fixture) => { fixture.reservation.supplierData.otaAssignedHotelId = EXPECTED_HOTEL_ID; },
		(fixture) => { fixture.reservation.supplierData.otaAssignedHotelName = "zad ajyad"; },
		(fixture) => { fixture.reservation.supplierData.otaAssignedHotelAt = new Date(REPAIR_AT); },
		(fixture) => { fixture.reservation.supplierData.otaAssignedHotelBy = { role: "employee" }; },
		(fixture) => { fixture.reservation.supplierData.otaMatchedRoomName = "Employee room"; },
		(fixture) => { fixture.reservation.supplierData.otaHotelRoomConfigId = oid("6a40df5f1a6d1850eb25c183"); },
		(fixture) => { fixture.reservation.supplierData.otaRoomMatchScore = 1; },
		(fixture) => { fixture.reservation.supplierData.otaRoomMatchType = "manual"; },
		(fixture) => { fixture.reservation.supplierData.otaRoomMatchReason = "employee"; },
		(fixture) => { fixture.reservation.supplierData.otaRoomMatchedByModel = "manual"; },
		(fixture) => { fixture.reservation.pickedRoomsPricing[0].room_type = "quadRooms"; },
		(fixture) => { fixture.reservation.sub_total = 1; },
		(fixture) => { fixture.reservation.__v = 1; },
		(fixture) => { fixture.audits[0].emailHash = "0".repeat(64); },
		(fixture) => { fixture.audits[0].senderAuthentication.authenticatedAligned = false; },
		(fixture) => { fixture.audits[0].normalizedReservation.hotelName = "Wrong hotel"; },
		(fixture) => { fixture.audits[1].senderAuthentication.authenticatedAligned = false; },
		(fixture) => { fixture.audits[1].normalizedReservation.totalAmountSar += 0.01; },
		(fixture) => { fixture.audits[1].normalizedReservation.totalPayoutSar += 0.01; },
		(fixture) => { fixture.audits[1].normalizedReservation.hotelNameAliases = ["Another Hotel"]; },
		(fixture) => { fixture.audits[1].normalizedReservation.source.receivedAt = new Date("2026-08-05T09:40:00.000Z"); },
		(fixture) => { fixture.audits[0].hotelId = oid(EXPECTED_HOTEL_ID); },
		(fixture) => { fixture.audits[0].reconciliation.hotelId = oid(EXPECTED_HOTEL_ID); },
		(fixture) => { fixture.audits[1].hotelId = oid(EXPECTED_HOTEL_ID); },
		(fixture) => { fixture.audits[1].reconciliation.hotelId = oid(EXPECTED_HOTEL_ID); },
	];
	for (const mutate of mutations) {
		const fixture = targetFixture("agoda_hotel_2038704202");
		mutate(fixture);
		assert.throws(() => buildRecoveryPlan(fixture));
	}
	const extra = targetFixture("agoda_hotel_2038703612");
	extra.audits.push(cloneBson(extra.audits[1]));
	extra.audits[2]._id = oid("6a732cd039b444f30248ed11");
	assert.throws(() => buildRecoveryPlan(extra), /Exactly 2 audit documents/);
});

test("hotel assignment refuses every employee payment, collection, or commission drift it would otherwise rewrite", () => {
	const mutations = [
		(fixture) => { fixture.reservation.paid_amount_breakdown.paid_online_via_link = 1; },
		(fixture) => { fixture.reservation.paid_amount_breakdown.paid_at_hotel_cash = 1; },
		(fixture) => { fixture.reservation.paid_amount_breakdown.paid_at_hotel_card = 1; },
		(fixture) => { fixture.reservation.paid_amount_breakdown.paid_to_hotel = 1; },
		(fixture) => { fixture.reservation.paid_amount_breakdown.paid_online_jannatbooking = 1; },
		(fixture) => { fixture.reservation.paid_amount_breakdown.paid_online_via_instapay = 1; },
		(fixture) => { fixture.reservation.paid_amount_breakdown.paid_no_show = 1; },
		(fixture) => { fixture.reservation.paid_amount_breakdown.employee_bucket = 1; },
		(fixture) => { fixture.reservation.paid_amount_breakdown.payment_comments = "Employee changed this payment"; },
		(fixture) => { fixture.reservation.financial_cycle.collectionModel = "hotel_collected"; },
		(fixture) => { fixture.reservation.financial_cycle.status = "pending"; },
		(fixture) => { fixture.reservation.financial_cycle.commissionType = "percentage"; },
		(fixture) => { fixture.reservation.financial_cycle.commissionValue = 1; },
		(fixture) => { fixture.reservation.financial_cycle.commissionAmount = 1; },
		(fixture) => { fixture.reservation.financial_cycle.commissionAssigned = true; },
		(fixture) => { fixture.reservation.financial_cycle.commissionAssignedAt = new Date(REPAIR_AT); },
		(fixture) => { fixture.reservation.financial_cycle.commissionAssignedBy = oid("6553f1c6d06c5cea2f98a838"); },
		(fixture) => { fixture.reservation.financial_cycle.pmsCollectedAmount += 0.01; },
		(fixture) => { fixture.reservation.financial_cycle.hotelCollectedAmount = 1; },
		(fixture) => { fixture.reservation.financial_cycle.hotelPayoutDue += 0.01; },
		(fixture) => { fixture.reservation.financial_cycle.commissionDueToPms = 1; },
	];
	for (const targetKey of ["agoda_hotel_2038703612", "agoda_hotel_2038704202"]) {
		for (const mutate of mutations) {
			const fixture = targetFixture(targetKey);
			mutate(fixture);
			assert.throws(
				() => buildRecoveryPlan(fixture),
				undefined,
				`${targetKey} accepted employee payment or financial-cycle drift.`,
			);
		}
	}
});

test("pricing plans correct source guest totals, OTA payouts, nightly sums, labels, and monotonic relay watermarks", () => {
	for (const targetKey of [
		"agoda_pricing_2038722839",
		"agoda_pricing_2038686448",
		"trip_pricing_1433813442496171",
	]) {
		const fixture = targetFixture(targetKey);
		const plan = buildRecoveryPlan(fixture);
		const { target } = plan;
		const after = plan.reservationPlan.expectedDocument;
		assert.equal(after.total_amount, target.corrected.clientSar);
		assert.equal(after.paid_amount, target.corrected.clientSar);
		assert.equal(after.adminPricing.netAfterExpensesTotal, target.corrected.payoutSar);
		assert.equal(after.adminPricing.otaExpenseTotal, target.corrected.expenseSar);
		assert.equal(after.adminPricing.platformMarginTotal, target.corrected.marginSar);
		assert.equal(after.adminPricing.rootTotal, target.corrected.rootSar);
		assert.equal(after.commission, target.corrected.commissionSar);
		assert.equal(after.supplierData.otaSourceAuthority, 3);
		assert.equal(new Date(after.supplierData.otaLastSourceReceivedAt).toISOString(), target.relayWatermark);
		assert.equal(after.supplierData.otaPaymentInstructions, target.paymentInstructions);
		assert.equal(after.supplierData.otaProvider, target.transportProvider);
		assert.equal(after.adminPricing.provider, target.transportProvider);
		assert.equal(after.ota_financial_summary.provider, target.transportProvider);
		assert.equal(after.otaPlatformReview.provider, target.transportProvider);
		assert.equal(after.otaPlatformReview.status, "pending");
		assert.equal(plan.auditPlans[0].expectedDocument.processingStatus, "updated");
		assert.equal(plan.auditPlans[0].expectedDocument.skipReason, "");
		assert.equal(plan.immutableEvidence.length, 1);
		verifyRecoveryPlan(plan);
	}
});

test("pricing preflight binds every observed direct conversion and payment-summary field", () => {
	const mutations = [
		["currency", (normalized) => { normalized.currency = "EUR"; }],
		["sourceCurrency", (normalized) => { normalized.sourceCurrency = "EUR"; }],
		["exchangeRateToSar", (normalized) => { normalized.exchangeRateToSar += 0.01; }],
		["exchangeRateSource", (normalized) => { normalized.exchangeRateSource = "fallback_default"; }],
		["amountConvertedAt", (normalized) => { normalized.amountConvertedAt = new Date("2026-08-05T14:30:40.677Z"); }],
		["paymentCollectionModel", (normalized) => { normalized.paymentCollectionModel = "unknown"; }],
		["paymentInstructions", (normalized) => { normalized.paymentInstructions = "Changed instructions"; }],
		["paymentSummary.sourceCurrency", (normalized) => { normalized.paymentSummary.sourceCurrency = "EUR"; }],
		["paymentSummary.sourceTotalGuestPaymentAmount", (normalized) => { normalized.paymentSummary.sourceTotalGuestPaymentAmount += 0.01; }],
		["paymentSummary.sourceTotalPayoutAmount", (normalized) => { normalized.paymentSummary.sourceTotalPayoutAmount += 0.01; }],
		["paymentSummary.totalGuestPaymentAmount", (normalized) => { normalized.paymentSummary.totalGuestPaymentAmount += 0.01; }],
		["paymentSummary.totalPayoutAmount", (normalized) => { normalized.paymentSummary.totalPayoutAmount += 0.01; }],
		["paymentSummary.currency", (normalized) => { normalized.paymentSummary.currency = "USD"; }],
		["paymentSummary.exchangeRateToSar", (normalized) => { normalized.paymentSummary.exchangeRateToSar += 0.01; }],
		["paymentSummary.exchangeRateSource", (normalized) => { normalized.paymentSummary.exchangeRateSource = "fallback_default"; }],
		["paymentSummary.amountConvertedAt", (normalized) => { normalized.paymentSummary.amountConvertedAt = new Date("2026-08-05T14:30:40.677Z"); }],
	];
	for (const targetKey of [
		"agoda_pricing_2038722839",
		"agoda_pricing_2038686448",
		"trip_pricing_1433813442496171",
	]) {
		for (const [label, mutate] of mutations) {
			const fixture = targetFixture(targetKey);
			const direct = fixture.audits.find((audit) =>
				String(audit._id) === TARGETS[targetKey].audits.find((audit) => audit.role === "authoritative_direct_pricing").id
			);
			mutate(direct.normalizedReservation);
			assert.throws(
				() => buildRecoveryPlan(fixture),
				undefined,
				`${targetKey} accepted ${label} drift.`,
			);
		}
	}
});

test("pricing validation fails closed for identity, provider, amount, room, capture, settlement, and evidence drift", () => {
	const mutations = [
		(fixture) => { fixture.reservation.confirmation_number = "0000000000"; },
		(fixture) => { fixture.reservation.otaIdentityKey = "trip:wrong"; },
		(fixture) => { fixture.reservation.hotelId = oid("6a40b6a1a6efe70450536039"); },
		(fixture) => { fixture.reservation.supplierData.otaProvider = "trip"; },
		(fixture) => { fixture.reservation.adminPricing.clientTotal += 0.01; },
		(fixture) => { fixture.reservation.ota_financial_summary.platformProfit += 0.01; },
		(fixture) => { fixture.reservation.otaPlatformReview.inboundEmailId = fixture.audits[1]._id; },
		(fixture) => { fixture.reservation.otaPlatformReview.lastPricingUpdatedAt = new Date(REPAIR_AT); },
		(fixture) => { fixture.reservation.supplierData.otaLastInboundEmailId = fixture.audits[1]._id; },
		(fixture) => { fixture.reservation.pickedRoomsType[0].pricingByDay[0].netAfterOtaExpenses += 0.01; },
		(fixture) => { fixture.reservation.pickedRoomsPricing[0].hotelRoomConfigId = oid("6a40df5f1a6d1850eb25c184"); },
		(fixture) => { fixture.reservation.payment_details.captured = true; },
		(fixture) => { fixture.reservation.moneyTransferredToHotel = true; },
		(fixture) => { fixture.reservation.__v += 1; },
		(fixture) => { fixture.reservation.adminPricing.clientTotalOverrideReason = "Employee override"; },
		(fixture) => { fixture.audits[1].emailHash = "f".repeat(64); },
		(fixture) => { fixture.audits[1].senderAuthentication.trustedProvider = "hotelrunner"; },
		(fixture) => { fixture.audits[1].normalizedReservation.totalPayoutSar += 0.01; },
		(fixture) => { fixture.audits[1].normalizedReservation.source.receivedAt = new Date("2026-08-05T10:00:00.000Z"); },
		(fixture) => { fixture.audits[1].reconciliation.status = "manually_reviewed"; },
		(fixture) => { fixture.audits[1].reconciliation.actionTaken = "manually_reviewed"; },
		(fixture) => { fixture.audits[1].reconciliation.skipReason = "manual_change"; },
		(fixture) => { fixture.audits[1].reconciliation.reservationId = oid("6a73245f39b444f30248df63"); },
		(fixture) => { fixture.audits[1].reconciliation.pmsConfirmationNumber = "0000000000"; },
		(fixture) => { fixture.audits[1].reconciliation.hotelId = oid("6a40b6a1a6efe70450536039"); },
	];
	for (const mutate of mutations) {
		const fixture = targetFixture("trip_pricing_1433813442496171");
		mutate(fixture);
		assert.throws(() => buildRecoveryPlan(fixture));
	}
});

test("pricing recovery refuses every employee payment, collection, or commission drift before changing totals", () => {
	const mutations = [
		(fixture) => { fixture.reservation.paid_amount_breakdown.paid_online_via_link = 1; },
		(fixture) => { fixture.reservation.paid_amount_breakdown.paid_at_hotel_cash = 1; },
		(fixture) => { fixture.reservation.paid_amount_breakdown.paid_at_hotel_card = 1; },
		(fixture) => { fixture.reservation.paid_amount_breakdown.paid_to_hotel = 1; },
		(fixture) => { fixture.reservation.paid_amount_breakdown.paid_online_jannatbooking = 1; },
		(fixture) => { fixture.reservation.paid_amount_breakdown.paid_online_via_instapay = 1; },
		(fixture) => { fixture.reservation.paid_amount_breakdown.paid_no_show = 1; },
		(fixture) => { fixture.reservation.paid_amount_breakdown.employee_bucket = 1; },
		(fixture) => { fixture.reservation.paid_amount_breakdown.payment_comments = "Employee changed this payment"; },
		(fixture) => { fixture.reservation.financial_cycle.collectionModel = "hotel_collected"; },
		(fixture) => { fixture.reservation.financial_cycle.status = "pending"; },
		(fixture) => { fixture.reservation.financial_cycle.commissionType = "percentage"; },
		(fixture) => { fixture.reservation.financial_cycle.commissionValue += 0.01; },
		(fixture) => { fixture.reservation.financial_cycle.commissionAmount += 0.01; },
		(fixture) => { fixture.reservation.financial_cycle.commissionAssigned = true; },
		(fixture) => { fixture.reservation.financial_cycle.commissionAssignedAt = new Date(REPAIR_AT); },
		(fixture) => { fixture.reservation.financial_cycle.commissionAssignedBy = oid("6553f1c6d06c5cea2f98a838"); },
		(fixture) => { fixture.reservation.financial_cycle.pmsCollectedAmount += 0.01; },
		(fixture) => { fixture.reservation.financial_cycle.hotelCollectedAmount = 1; },
		(fixture) => { fixture.reservation.financial_cycle.hotelPayoutDue += 0.01; },
		(fixture) => { fixture.reservation.financial_cycle.commissionDueToPms = 1; },
		(fixture) => { fixture.reservation.commissionData = { assigned: true, amount: 0, status: "pending" }; },
	];
	for (const targetKey of [
		"agoda_pricing_2038722839",
		"agoda_pricing_2038686448",
		"trip_pricing_1433813442496171",
	]) {
		for (const mutate of mutations) {
			const fixture = targetFixture(targetKey);
			mutate(fixture);
			assert.throws(
				() => buildRecoveryPlan(fixture),
				undefined,
				`${targetKey} accepted employee payment or financial-cycle drift.`,
			);
		}
	}
});

test("authenticated cancellation overwrites every prior lifecycle status and preserves commercial bytes", () => {
	const lifecycleStates = [
		["confirmed", "confirmed"],
		["confirmed", "inhouse"],
		["inhouse", "inhouse"],
		["checked_out", "checked_out"],
		["no_show", "no_show"],
		["cancelled", "cancelled"],
		["ota platform review", "ota platform review"],
	];
	for (const [state, reservationStatus] of lifecycleStates) {
		const fixture = targetFixture("airbnb_cancellation_hm2w4qqrt9", {
			reservation: cancellationReservation(state, reservationStatus),
		});
		const beforeCommercial = cloneBson({
			total_amount: fixture.reservation.total_amount,
			paid_amount: fixture.reservation.paid_amount,
			paid_amount_breakdown: fixture.reservation.paid_amount_breakdown,
			pickedRoomsType: fixture.reservation.pickedRoomsType,
			pickedRoomsPricing: fixture.reservation.pickedRoomsPricing,
			adminPricing: fixture.reservation.adminPricing,
			financial_cycle: fixture.reservation.financial_cycle,
			payment_details: fixture.reservation.payment_details,
			availabilitySnapshot: fixture.reservation.availabilitySnapshot,
		});
		const plan = buildRecoveryPlan(fixture);
		const after = plan.reservationPlan.expectedDocument;
		const cancellationProcessedAt = fixture.audits[1].processedAt.toISOString();
		assert.equal(after.state, "cancelled");
		assert.equal(after.reservation_status, "cancelled");
		assert.equal(after.pendingConfirmation.status, "cancelled");
		assert.equal(after.agentDecisionSnapshot.status, "cancelled");
		assert.equal(after.otaPlatformReview.status, "closed");
		assert.equal(after.otaPlatformReview.closedReason, "ota_status_cancelled");
		assert.equal(after.pendingConfirmation.cancelledAt.toISOString(), cancellationProcessedAt);
		assert.equal(after.pendingConfirmation.lastUpdatedAt.toISOString(), cancellationProcessedAt);
		assert.equal(after.agentDecisionSnapshot.decidedAt.toISOString(), cancellationProcessedAt);
		assert.equal(after.otaPlatformReview.closedAt.toISOString(), cancellationProcessedAt);
		assert.equal(after.otaPlatformReview.lastUpdatedAt.toISOString(), cancellationProcessedAt);
		assert.equal(after.supplierData.otaLastEmailAt.toISOString(), cancellationProcessedAt);
		assert.equal(after.updatedAt.toISOString(), REPAIR_AT);
		assert.equal(after.reservationAuditLog.at(-1).at.toISOString(), REPAIR_AT);
		assert.ok(canonicalEqual({
			total_amount: after.total_amount,
			paid_amount: after.paid_amount,
			paid_amount_breakdown: after.paid_amount_breakdown,
			pickedRoomsType: after.pickedRoomsType,
			pickedRoomsPricing: after.pickedRoomsPricing,
			adminPricing: after.adminPricing,
			financial_cycle: after.financial_cycle,
			payment_details: after.payment_details,
			availabilitySnapshot: after.availabilitySnapshot,
		}, beforeCommercial));
		assert.equal(plan.auditPlans[0].expectedDocument.processingStatus, "cancelled");
		assert.equal(plan.auditPlans[0].expectedDocument.skipReason, "");
		assert.equal(plan.immutableEvidence.length, 1);
	}
});

test("cancellation uses the immutable creation audit for hotel/stay and rejects cancellation evidence drift", () => {
	const fixture = targetFixture("airbnb_cancellation_hm2w4qqrt9");
	assert.equal(fixture.audits[1].normalizedReservation.checkinDate, null);
	assert.doesNotThrow(() => buildRecoveryPlan(fixture));
	for (const mutate of [
		(candidate) => { candidate.audits[0].normalizedReservation.checkinDate = "2026-08-06"; },
		(candidate) => { candidate.audits[0].hotelId = oid("6a40b6a1a6efe70450536039"); },
		(candidate) => { candidate.audits[1].normalizedReservation.eventType = "confirmed"; },
		(candidate) => { candidate.audits[1].normalizedReservation.statusToApply = "confirmed"; },
		(candidate) => { candidate.audits[1].senderAuthentication.authenticatedAligned = false; },
		(candidate) => { candidate.audits[1].processedAt = null; },
		(candidate) => { candidate.audits[1].processedAt = "not-a-date"; },
		(candidate) => { candidate.reservation.checkout_date = new Date("2026-08-10T00:00:00.000Z"); },
	]) {
		const candidate = targetFixture("airbnb_cancellation_hm2w4qqrt9");
		mutate(candidate);
		assert.throws(() => buildRecoveryPlan(candidate));
	}
});

test("cancellation refuses equal/newer lifecycle watermarks and accepts only absent or strictly older ones", () => {
	for (const watermark of [undefined, null, new Date("2026-08-05T11:54:14.999Z")]) {
		const fixture = targetFixture("airbnb_cancellation_hm2w4qqrt9");
		if (watermark !== undefined) fixture.reservation.supplierData.otaLastSourceReceivedAt = watermark;
		assert.doesNotThrow(() => buildRecoveryPlan(fixture));
	}
	for (const watermark of [
		new Date("2026-08-05T11:54:15.000Z"),
		new Date("2026-08-05T11:54:15.001Z"),
		new Date("2026-08-06T00:00:00.000Z"),
	]) {
		const fixture = targetFixture("airbnb_cancellation_hm2w4qqrt9");
		fixture.reservation.supplierData.otaLastSourceReceivedAt = watermark;
		assert.throws(() => buildRecoveryPlan(fixture), /newer or equal/);
	}
});

test("all recovery paths fail closed on processor remainders, attempts, transactions, PayPal, transfers, or financial-cycle closure", () => {
	const mutations = [
		(reservation) => { reservation.payment_details.processor_reference = "processor-1"; },
		(reservation) => { reservation.vcc_payment.attempts = [{ id: "attempt-1" }]; },
		(reservation) => { reservation.vcc_payment.last_capture = { id: "capture-1" }; },
		(reservation) => { reservation.braintree_payment.last_transaction_id = "bt-1"; },
		(reservation) => { reservation.bofa_payment.vcc.attempts_count = 1; },
		(reservation) => { reservation.bofa_payment.secure_acceptance.status = "authorized"; },
		(reservation) => { reservation.paypal_details.capture_id = "paypal-1"; },
		(reservation) => { reservation.moneyTransferredAt = new Date(REPAIR_AT); },
		(reservation) => { reservation.commissionPaidAt = new Date(REPAIR_AT); },
		(reservation) => { reservation.commissionData = { paid: true }; },
		(reservation) => { reservation.commissionStatus = "paid"; },
		(reservation) => { reservation.financial_cycle.status = "closed"; },
		(reservation) => { reservation.financial_cycle.closedAt = new Date(REPAIR_AT); },
		(reservation) => { reservation.financial_cycle.closedBy = oid("6553f1c6d06c5cea2f98a838"); },
	];
	for (const mutate of mutations) {
		for (const targetKey of [
			"airbnb_cancellation_hm2w4qqrt9",
			"trip_pricing_1433813442496171",
			"agoda_hotel_2038704202",
		]) {
			const fixture = targetFixture(targetKey);
			mutate(fixture.reservation);
			assert.throws(() => buildRecoveryPlan(fixture), undefined, `${targetKey} accepted forbidden settlement/capture drift.`);
		}
	}
});

test("Airbnb payout recovery changes only outcome classification and preserves raw, normalized, auth, and forwarding evidence", () => {
	const fixture = targetFixture("airbnb_payout", { reservation: null });
	const original = cloneBson(fixture.audits[0]);
	const plan = buildRecoveryPlan(fixture);
	assert.equal(plan.reservationPlan, null);
	assert.equal(plan.documentPlans.length, 1);
	const after = plan.auditPlans[0].expectedDocument;
	assert.equal(after.processingStatus, "not_reservation");
	assert.equal(after.automationAction, "skipped");
	assert.equal(after.skipReason, "airbnb_payout_notification");
	assert.equal(after.hasReservationConnection, false);
	assert.equal(after.reservationMongoId, null);
	assert.ok(canonicalEqual(auditEvidenceSnapshot(original), auditEvidenceSnapshot(after)));
	assert.ok(canonicalEqual(original.normalizedReservation, after.normalizedReservation));
	assert.ok(canonicalEqual(original.forwarding, after.forwarding));
	assert.ok(canonicalEqual(original.senderAuthentication, after.senderAuthentication));
	const forged = targetFixture("airbnb_payout", { reservation: null });
	forged.audits[0].senderAuthentication.authenticatedAligned = false;
	assert.throws(() => buildRecoveryPlan(forged));
});

test("all-target builder is fixed-scope, deterministic, BSON-aware, and rejects unknown audits", () => {
	const fixture = fullFixture();
	const first = buildRecoveryPlans(fixture);
	const second = buildRecoveryPlans(cloneBson(fixture));
	assert.equal(first.length, 7);
	for (let index = 0; index < first.length; index += 1) {
		assert.equal(canonicalEjsonSha256(first[index]), canonicalEjsonSha256(second[index]));
		verifyRecoveryPlan(first[index]);
		for (const documentPlan of first[index].documentPlans) {
			assert.equal(documentPlan.originalHash.length, 64);
			assert.equal(documentPlan.expectedHash.length, 64);
			assert.equal(documentPlan.casFilterHash.length, 64);
			assert.ok(canonicalEqual(documentPlan.casFilter.$and[0], documentPlan.originalDocument));
			assert.deepEqual(documentPlan.casFilter.$and[1], {
				$expr: {
					$eq: [
						{ $size: { $objectToArray: "$$ROOT" } },
						Object.keys(documentPlan.originalDocument).length,
					],
				},
			});
		}
	}
	const extra = fullFixture();
	extra.audits.push(cloneBson(extra.audits[0]));
	extra.audits.at(-1)._id = oid("6a7324a939b444f30248e099");
	assert.throws(() => buildRecoveryPlans(extra), /Exactly 13/);
});

test("pure apply and postverify change only mutable documents and keep immutable evidence byte-exact", () => {
	for (const targetKey of TARGET_KEYS) {
		const fixture = targetFixture(targetKey, targetKey === "airbnb_payout" ? { reservation: null } : {});
		const plan = buildRecoveryPlan(fixture);
		const scope = {
			reservations: fixture.reservation ? [fixture.reservation] : [],
			audits: fixture.audits,
		};
		assert.ok(classifyPlanScope({ plan, scope }).every((entry) => entry.state === "original"));
		const applied = applyPlanToScope({ plan, scope });
		assert.ok(classifyPlanScope({ plan, scope: applied }).every((entry) => entry.state === "repaired"));
		assert.equal(verifyRepairedTarget({ plan, scope: applied }), true);
		for (const evidence of plan.immutableEvidence) {
			const actual = applied.audits.find((audit) => String(audit._id) === evidence.documentId);
			assert.equal(canonicalEjsonSha256(actual), evidence.originalHash);
		}
	}
});

test("backup records contain every mutable and immutable source exactly once and detect tampering", () => {
	const fixture = fullFixture();
	const plans = buildRecoveryPlans(fixture);
	const records = buildBackupRecords({
		plans,
		repairId: REPAIR_ID,
		backupCollection: BACKUP_COLLECTION,
		backupAt: REPAIR_AT,
	});
	assert.equal(records.length, 19);
	assert.equal(records.filter((record) => record.sourceCollection === "reservations").length, 6);
	assert.equal(records.filter((record) => record.sourceCollection === "inboundemails").length, 13);
	assert.equal(verifyBackupRecords({ records, repairId: REPAIR_ID, backupCollection: BACKUP_COLLECTION }), true);
	const tampered = cloneBson(records);
	tampered[0].originalDocument.__v = 999;
	assert.throws(() => verifyBackupRecords({ records: tampered, repairId: REPAIR_ID, backupCollection: BACKUP_COLLECTION }), /canonical original hash/);
});

const documentKey = (collection, documentId) => `${collection}:${documentId}`;

const standaloneStore = (plan) => {
	const documents = new Map();
	for (const entry of [...plan.documentPlans, ...plan.immutableEvidence]) {
		documents.set(documentKey(entry.collection, entry.documentId), cloneBson(entry.originalDocument));
	}
	return documents;
};

const storeScope = (store) => ({
	reservations: [...store.entries()]
		.filter(([key]) => key.startsWith("reservations:"))
		.map(([, document]) => cloneBson(document)),
	audits: [...store.entries()]
		.filter(([key]) => key.startsWith("inboundemails:"))
		.map(([, document]) => cloneBson(document)),
});

const compensateExact = ({ plan, store, written, counters }) => {
	for (const documentPlan of [...written].reverse()) {
		const key = documentKey(documentPlan.collection, documentPlan.documentId);
		const current = store.get(key);
		const currentHash = canonicalEjsonSha256(current);
		if (currentHash === documentPlan.originalHash) continue;
		assert.equal(
			currentHash,
			documentPlan.expectedHash,
			`Compensation refused changed third state for ${key}`,
		);
		store.set(key, cloneBson(documentPlan.originalDocument));
		counters.writes += 1;
	}
};

const executeStandalone = ({
	plan,
	store,
	mode = "normal",
	fence = () => true,
	beforeCompensation = () => {},
} = {}) => {
	const counters = { writes: 0, fenceReads: 0, attempts: 0 };
	const written = [];
	for (let index = 0; index < plan.documentPlans.length; index += 1) {
		const documentPlan = plan.documentPlans[index];
		counters.fenceReads += 1;
		try {
			assert.equal(fence(index), true, `Manifest ownership fence lost before write ${index + 1}`);
			const key = documentKey(documentPlan.collection, documentPlan.documentId);
			const currentHash = canonicalEjsonSha256(store.get(key));
			if (currentHash === documentPlan.expectedHash) {
				written.push(documentPlan);
				continue;
			}
			assert.equal(currentHash, documentPlan.originalHash, `CAS rejected ${key}`);
			counters.attempts += 1;
			if (mode === "clean_reject_second" && index === 1) {
				throw new Error(`CAS rejected ${key}`);
			}
			store.set(key, cloneBson(documentPlan.expectedDocument));
			counters.writes += 1;
			written.push(documentPlan);
			if (mode === "reservation_ack_lost" && index === 0) {
				throw new Error(`Write acknowledgement lost ${key}`);
			}
			if (mode === "audit_ack_lost" && index === 1) {
				throw new Error(`Write acknowledgement lost ${key}`);
			}
		} catch (error) {
			const key = documentKey(documentPlan.collection, documentPlan.documentId);
			const readback = store.get(key);
			if (readback && canonicalEjsonSha256(readback) === documentPlan.expectedHash) {
				// A committed write with a lost acknowledgement is success.  There is
				// no retry: the exact expected hash is the acknowledgement.
				continue;
			}
			beforeCompensation({ plan, store, written, counters, failedIndex: index });
			compensateExact({ plan, store, written, counters });
			throw error;
		}
	}
	verifyRepairedTarget({ plan, scope: storeScope(store) });
	return counters;
};

test("standalone serial apply postverifies reservation and audit with a finite two-write path", () => {
	const plan = buildRecoveryPlan(targetFixture("trip_pricing_1433813442496171"));
	const store = standaloneStore(plan);
	const counters = executeStandalone({ plan, store });
	assert.equal(counters.writes, 2);
	assert.equal(counters.attempts, 2);
	assert.equal(counters.fenceReads, 2);
	assert.ok(classifyPlanScope({ plan, scope: storeScope(store) }).every((entry) => entry.state === "repaired"));
});

test("clean audit CAS rejection exactly compensates the already-written reservation", () => {
	const plan = buildRecoveryPlan(targetFixture("trip_pricing_1433813442496171"));
	const store = standaloneStore(plan);
	assert.throws(
		() => executeStandalone({ plan, store, mode: "clean_reject_second" }),
		/CAS rejected/,
	);
	assert.ok(classifyPlanScope({ plan, scope: storeScope(store) }).every((entry) => entry.state === "original"));
});

test("lost reservation or audit acknowledgement continues from exact hash readback without retry", () => {
	for (const mode of ["reservation_ack_lost", "audit_ack_lost"]) {
		const plan = buildRecoveryPlan(targetFixture("agoda_pricing_2038722839"));
		const store = standaloneStore(plan);
		const counters = executeStandalone({ plan, store, mode });
		assert.equal(counters.writes, 2, `${mode} performed an unexpected retry.`);
		assert.equal(counters.attempts, 2, `${mode} performed an unexpected retry attempt.`);
		assert.ok(classifyPlanScope({ plan, scope: storeScope(store) }).every((entry) => entry.state === "repaired"));
	}
});

test("manifest fence loss between writes prevents the second write and compensates the first", () => {
	const plan = buildRecoveryPlan(targetFixture("agoda_pricing_2038722839"));
	const store = standaloneStore(plan);
	assert.throws(
		() => executeStandalone({ plan, store, fence: (index) => index === 0 }),
		/ownership fence lost/,
	);
	assert.ok(classifyPlanScope({ plan, scope: storeScope(store) }).every((entry) => entry.state === "original"));
});

test("concurrent third state blocks compensation and is never overwritten", () => {
	const plan = buildRecoveryPlan(targetFixture("trip_pricing_1433813442496171"));
	const store = standaloneStore(plan);
	const reservationPlan = plan.reservationPlan;
	assert.throws(
		() => executeStandalone({
			plan,
			store,
			mode: "clean_reject_second",
			beforeCompensation: () => {
				const changed = cloneBson(reservationPlan.expectedDocument);
				changed.concurrentManualMarker = "must-survive";
				store.set(documentKey("reservations", reservationPlan.documentId), changed);
			},
		}),
		/Compensation refused changed third state/,
	);
	const actual = store.get(documentKey("reservations", reservationPlan.documentId));
	assert.equal(actual.concurrentManualMarker, "must-survive");
	assert.equal(classifyPlanScope({ plan, scope: storeScope(store) })[0].state, "changed_or_missing");
});

test("rollback restores only exact expected hashes and never overwrites originals or third states", () => {
	const plan = buildRecoveryPlan(targetFixture("trip_pricing_1433813442496171"));
	const reservationPlan = plan.reservationPlan;
	const key = documentKey("reservations", reservationPlan.documentId);
	const counters = { writes: 0 };

	const originalStore = standaloneStore(plan);
	compensateExact({ plan, store: originalStore, written: [reservationPlan], counters });
	assert.equal(counters.writes, 0, "Already-original state must be a no-op.");

	const repairedStore = standaloneStore(plan);
	repairedStore.set(key, cloneBson(reservationPlan.expectedDocument));
	compensateExact({ plan, store: repairedStore, written: [reservationPlan], counters });
	assert.equal(counters.writes, 1);
	assert.equal(canonicalEjsonSha256(repairedStore.get(key)), reservationPlan.originalHash);

	const thirdStore = standaloneStore(plan);
	const third = cloneBson(reservationPlan.expectedDocument);
	third.concurrentManualMarker = true;
	thirdStore.set(key, third);
	assert.throws(
		() => compensateExact({ plan, store: thirdStore, written: [reservationPlan], counters }),
		/Compensation refused changed third state/,
	);
	assert.equal(thirdStore.get(key).concurrentManualMarker, true);
});
