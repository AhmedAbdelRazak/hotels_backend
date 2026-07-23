/** @format */

process.env.SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "SG.test";

const test = require("node:test");
const assert = require("node:assert/strict");
const Reservations = require("../models/reservations");
const InboundEmail = require("../models/inbound_email");
const {
	buildExistingReservationUpdateSet,
	buildOtaConfirmationLookup,
	buildOtaIdentityKey,
	buildReservationDocument,
	buildUnmappedOtaReviewReservationDocument,
	canCreateUnmappedOtaReviewReservation,
	detectConfirmationMatchFields,
	detectPaymentCollectionModel,
	detectStatusToApply,
	explicitRoomCapacity,
	extractNormalizedReservation,
	findConfidentFuzzyHotelMatch,
	isAuthoritativeSourceUpgrade,
	isOtaInboundTotalOutlier,
	isPlausibleOtaGuestName,
	isPlausibleOtaRoomName,
	otaSourceAuthority,
	parseDate,
	parseMoney,
	requiredNewReservationMissing,
	reconcileOtaReservation,
	resolvePaymentMapping,
	resolveRoomMatch,
} = require("./otaReservationMapper");

const HOTEL_ROOMS = [
	{ roomType: "doubleRooms", displayName: "Double Room", activeRoom: true },
	{ roomType: "tripleRooms", displayName: "Triple Room", activeRoom: true },
	{ roomType: "quadRooms", displayName: "Quadruple Room", activeRoom: true },
	{ roomType: "familyRooms", displayName: "Family Quintuple Room", activeRoom: true },
];

const hotelRunnerEmail = ({ roomName, guestCount }) => ({
	from: '"HotelRunner" <noreply@hotelrunner.com>',
	to: "ota@example.com",
	subject: "Zad AJYAD Hotel - New Reservation #R123456789",
	text: [
		"Booking Source Agoda",
		"Confirmation Number 680785631",
		"Hotel Name Zad Ajyad",
		"Room Type",
		roomName,
		"Check-in Date",
		"Jul 23, 2026",
		"Check-out Date",
		"Jul 24, 2026",
		"Guest Count",
		String(guestCount),
		`Adult Count:${guestCount}`,
		"Children Count:0",
		"Channel:Maximum Gain",
	].join("\n"),
});

test("HotelRunner guest occupancy is not treated as a room count", () => {
	const normalized = extractNormalizedReservation(
		hotelRunnerEmail({
			roomName: "Comfort Triple Room - 3 beds - AJYAD Hotel- 15 Mins from Haram",
			guestCount: 2,
		})
	);

	assert.equal(normalized.provider, "agoda");
	assert.equal(normalized.totalGuests, 2);
	assert.equal(normalized.roomCount, 1);
});

test("explicit bed capacity wins over unrelated numbers and broad family wording", () => {
	const triple = extractNormalizedReservation(
		hotelRunnerEmail({
			roomName: "Comfort Triple Room - 3 beds - AJYAD Hotel- 15 Mins from Haram",
			guestCount: 2,
		})
	);
	const tripleMatch = resolveRoomMatch(
		{ roomCountDetails: HOTEL_ROOMS },
		triple.roomName,
		{ totalGuests: triple.totalGuests, normalized: triple }
	);
	assert.equal(tripleMatch.roomDetails.roomType, "tripleRooms");

	const tripleWithFourGuests = extractNormalizedReservation(
		hotelRunnerEmail({
			roomName: "Comfort Triple Room - 3 beds - AJYAD Hotel- 15 Mins from Haram",
			guestCount: 4,
		})
	);
	const tripleWithFourGuestsMatch = resolveRoomMatch(
		{ roomCountDetails: HOTEL_ROOMS },
		tripleWithFourGuests.roomName,
		{
			totalGuests: tripleWithFourGuests.totalGuests,
			normalized: tripleWithFourGuests,
		}
	);
	assert.equal(tripleWithFourGuests.totalGuests, 4);
	assert.equal(tripleWithFourGuestsMatch.sourceCapacity, 3);
	assert.equal(tripleWithFourGuestsMatch.roomDetails.roomType, "tripleRooms");

	const familyFourBed = extractNormalizedReservation(
		hotelRunnerEmail({
			roomName: "Comfort Family Room - 4 beds - AJYAD Hotel- 15 Mins from Haram",
			guestCount: 4,
		})
	);
	const familyMatch = resolveRoomMatch(
		{ roomCountDetails: HOTEL_ROOMS },
		familyFourBed.roomName,
		{ totalGuests: familyFourBed.totalGuests, normalized: familyFourBed }
	);
	assert.equal(familyMatch.roomDetails.roomType, "quadRooms");
});

test("explicit Agoda room-count labels remain supported", () => {
	const normalized = extractNormalizedReservation({
		from: "no-reply@agoda.com",
		subject: "Agoda Booking ID 2034360128 - CONFIRMED",
		text: [
			"Booking ID",
			"2034360128",
			"Room Type",
			"Deluxe Room",
			"No. of rooms",
			"2",
			"Occupancy",
			"2 adults",
		].join("\n"),
	});

	assert.equal(normalized.roomCount, 2);
});

test("ExpediaCollect with EVC is treated as a virtual card pending capture", () => {
	const normalized = extractNormalizedReservation({
		from: '"Reservations" <notifications@example.com>',
		to: "ota@inbound.jannatbooking.com",
		subject: "Expedia reservation",
		text: [
			"Expedia (Expedia Affiliate Network)",
			"Confirmation Number 9990001112",
			"Guest Name Test Guest",
			"Order Total $ 154.26",
			"Note Payment Method:ExpediaCollect EVC Charge Status:READY TO CHARGE ON CHECK IN DATE",
			"Room Type Comfort Family Room - 4 beds - AJYAD Hotel- 15 Mins from Haram",
			"Check-in Date Aug 06, 2026",
			"Check-out Date Aug 16, 2026",
			"Guest Count 4 (2 children, 2 adults)",
			"Status Reservation",
		].join("\n"),
	});

	assert.equal(normalized.provider, "expedia");
	assert.equal(normalized.paymentCollectionModel, "virtual_card");
	assert.equal(normalized.paidOnline, false);
	assert.equal(normalized.sourcePresence.paymentCollectionModel, true);

	const payment = resolvePaymentMapping(normalized, 578.47, 520.62, 57.85);
	assert.equal(payment.payment, "credit/ debit");
	assert.equal(payment.financeStatus, "not paid");
	assert.equal(payment.paidAmount, 0);
});

test("compact ExpediaCollect remains OTA collect without virtual-card evidence", () => {
	assert.equal(
		detectPaymentCollectionModel("Payment Method:ExpediaCollect"),
		"ota_collect"
	);
	assert.equal(
		detectPaymentCollectionModel("Payment Method:Expedia Collect"),
		"ota_collect"
	);
	assert.equal(
		detectPaymentCollectionModel(
			"Payment Method:ExpediaCollect EVC Charge Status:READY"
		),
		"virtual_card"
	);
	assert.equal(detectPaymentCollectionModel("Reference code EVC"), "unknown");
});

test("reservation schema declares an atomic partial unique OTA identity index", () => {
	const index = Reservations.schema
		.indexes()
		.find(([, options]) => options?.name === "uniq_ota_identity_key");

	assert.ok(index);
	assert.deepEqual(index[0], { otaIdentityKey: 1 });
	assert.equal(index[1].unique, true);
	assert.deepEqual(index[1].partialFilterExpression, {
		otaIdentityKey: { $type: "string", $gt: "" },
	});
});

const hotelRunnerAgodaVccEmail = {
	from: '"HotelRunner" <noreply@hotelrunner.com>',
	to: "ota@example.com",
	subject: "Zad AJYAD Hotel - New Reservation #RTEST",
	text: [
		"AGODA (RETAIL)",
		"Confirmation Number 9990002223 Guest Name Test Guest Country Saudi",
		"Arabia Order Total \uFDFC 44 Booked Date Tuesday, July 21, 2026 23:56 Note Payment:",
		"Merchance booking (Agoda Collect) Card Effective Date:2026-07-22 Card Current Balance:44.00 Card Future Balance:44.00 Card Currency Code:SAR Card Is VCC:true",
		"Hotel Name Zad Ajyad",
		"Room Type Double Room - Comfort & Relaxation",
		"Check-in Date Jul 23, 2026",
		"Check-out Date Jul 24, 2026",
		"Guest Count 2",
		"Adult Count:2",
		"Children Count:0",
		"Status Reservation",
	].join("\n"),
};

test("HotelRunner Agoda total stops at the first money token", () => {
	assert.deepEqual(
		parseMoney("\uFDFC 44 Booked Date Tuesday, July 21, 2026 23:56"),
		{ amount: 44, currency: "SAR" }
	);
	assert.deepEqual(parseMoney("SAR 1560.00"), {
		amount: 1560,
		currency: "SAR",
	});
	assert.equal(
		parseMoney("44 Booked Date Tuesday, July 21, 2026 23:56").amount,
		44
	);
});

test("HotelRunner Agoda VCC pricing uses the order total and current card balance", () => {
	const normalized = extractNormalizedReservation(hotelRunnerAgodaVccEmail);

	assert.equal(normalized.provider, "agoda");
	assert.equal(normalized.confirmationNumber, "9990002223");
	assert.equal(normalized.guestName, "Test Guest");
	assert.equal(normalized.nationality, "Saudi Arabia");
	assert.equal(normalized.amount, 44);
	assert.equal(normalized.currency, "SAR");
	assert.equal(normalized.totalAmountSar, 44);
	assert.equal(normalized.paymentCollectionModel, "virtual_card");
	assert.equal(normalized.vcc.amountToCharge, 44);
	assert.equal(normalized.vcc.amountToChargeCurrency, "SAR");
	assert.equal(normalized.vcc.amountToChargeSar, 44);
	assert.equal(normalized.vcc.activationDate, "2026-07-22");
	assert.equal(normalized.totalPayoutSar, 44);
	assert.equal(normalized.netAfterExpensesTotal, 44);
	assert.equal(normalized.paymentSummary.totalPayoutAmount, 44);

	const built = buildReservationDocument(normalized, {
		_id: "test-hotel-id",
		belongsTo: "test-owner-id",
		roomCountDetails: [
			{
				roomType: "doubleRooms",
				displayName: "Double Room - Comfort & Relaxation",
				activeRoom: true,
				price: { basePrice: 75 },
			},
		],
	});

	assert.equal(built.ok, true);
	assert.equal(built.document.total_amount, 44);
	assert.equal(built.document.sub_total, 75);
	assert.equal(built.document.adminPricing.clientTotal, 44);
	assert.equal(built.document.adminPricing.rootTotal, 75);
	assert.equal(built.document.adminPricing.netAfterExpensesTotal, 44);
	assert.equal(built.document.adminPricing.otaExpenseTotal, 0);
	assert.equal(built.document.adminPricing.platformMarginTotal, -31);
	assert.equal(built.document.adminPricing.defaultDeductionApplied, false);
	assert.equal(built.document.payment, "credit/ debit");
	assert.equal(built.document.financeStatus, "not paid");
	assert.equal(built.document.paid_amount, 0);
});

test("OTA inbound totals above the safety limit require review", () => {
	const normalized = extractNormalizedReservation(hotelRunnerAgodaVccEmail);
	assert.equal(
		isOtaInboundTotalOutlier({ ...normalized, totalAmountSar: 1000001 }),
		true
	);
	assert.equal(
		isOtaInboundTotalOutlier({
			...normalized,
			totalAmountSar: 1000001,
			source: {},
			inboundEmailId: "",
		}),
		false
	);
});

test("OTA identities are provider-namespaced and never query PMS confirmation numbers", () => {
	assert.equal(buildOtaIdentityKey("agoda", "682028095"), "agoda:682028095");
	assert.equal(buildOtaIdentityKey("booking", "682028095"), "booking:682028095");
	assert.equal(buildOtaIdentityKey("unknown", "682028095"), "");

	const query = buildOtaConfirmationLookup("682028095", "agoda");
	assert.equal(JSON.stringify(query).includes("confirmation_number"), true);
	assert.equal(JSON.stringify(query).includes('"confirmation_number"'), false);
	assert.equal(JSON.stringify(query).includes("agoda:682028095"), true);

	const legacyAgoda = {
		otaIdentityKey: "682028095",
		confirmation_number: "9796481455",
		reservation_id: "682028095",
		supplierData: { otaProvider: "agoda", otaConfirmationNumber: "682028095" },
	};
	assert.ok(
		detectConfirmationMatchFields(legacyAgoda, "682028095", "agoda").includes(
			"supplierData.otaConfirmationNumber"
		)
	);
	assert.deepEqual(
		detectConfirmationMatchFields(legacyAgoda, "682028095", "booking"),
		[],
		"a different provider cannot claim the same confirmation number",
	);
});

test("ambiguous numeric OTA dates fail closed", () => {
	assert.equal(parseDate("08/09/2026"), null);
	assert.equal(parseDate("09/08/2026"), null);
	assert.equal(parseDate("07/23/2026"), "2026-07-23");
	assert.equal(parseDate("23/07/2026"), "2026-07-23");
	assert.equal(parseDate("08/08/2026"), "2026-08-08");
});

test("occupancy, tax, and nightly rates cannot masquerade as a guest total", () => {
	const normalized = extractNormalizedReservation({
		from: "Booking.com <no-reply@booking.com>",
		subject: "New reservation 12345678",
		text: [
			"Reservation ID: 12345678",
			"Guest name: Safe Guest",
			"Hotel name: Zad Ajyad",
			"Room type: Double Room",
			"Check-in date: 2026-08-01",
			"Check-out date: 2026-08-03",
			"Total guests: 2",
			"Nightly rate: SAR 100",
			"Tax: SAR 30",
		].join("\n"),
	});

	assert.equal(normalized.amount, 0);
	assert.equal(normalized.totalAmountSar, 0);
	assert.equal(normalized.sourcePresence.amount, false);
	assert.ok(
		requiredNewReservationMissing(normalized).includes(
			"positive source-backed guest total",
		),
	);
});

test("flattened Agoda vouchers keep bounded guest, room, occupancy, and gross pricing fields", () => {
	const normalized = extractNormalizedReservation({
		from: '"agoda.com" <no-reply@agoda.com>',
		subject: "Agoda Booking ID 681911771 - CONFIRMED",
		text: [
			"Booking ID 681911771 Reservation Information",
			"PREPAID Booking confirmation",
			"Zyd Agyad",
			"(Property ID 90720772) City : Mecca",
			"Customer First Name Waqas Customer Last Name Khan Country of Residence Saudi",
			"Arabia Check-in July 23, 2026 Check-out July 24, 2026 Other Guests",
			"Room Type No. of Rooms Occupancy Children\u2019s age No. of Extra Bed Family - 6",
			"Persons 1 2 Adults, 3 Children 4,7,8 0",
			"From - To Rates July 23, 2026 SAR 50.48 Reference sell rate (incl. taxes & fees) SAR 70.00 Compensation Commission SAR -10.50",
			"Net rate (incl. taxes & fees) SAR 50.48",
			"Customer Info - Name: Waqas Khan, Phone: 966 581481515",
			"http://img.agoda.net/images/email/logo/logo-header-agoda@2x.png",
		].join("\n"),
	});

	assert.equal(normalized.guestName, "Waqas Khan");
	assert.equal(normalized.nationality, "Saudi Arabia");
	assert.equal(normalized.guestEmail, "");
	assert.equal(normalized.roomName, "Family - 6 Persons");
	assert.equal(normalized.roomCount, 1);
	assert.equal(normalized.adults, 2);
	assert.equal(normalized.children, 3);
	assert.equal(normalized.totalGuests, 5);
	assert.equal(normalized.totalAmountSar, 70);
	assert.equal(normalized.totalPayoutSar, 50.48);
});

test("the production Agoda six-person template keeps exact identity, room, and pricing facts", () => {
	const normalized = extractNormalizedReservation({
		from: '"agoda.com" <no-reply@agoda.com>',
		subject:
			"Agoda Booking ID 682028095 - CONFIRMED Hotel Country: Saudi Arabia Check-in July 23, 2026 / Language_English",
		text: [
			"Booking ID 682028095 Reservation Information",
			"PREPAID Booking confirmation",
			"Zyd Agyad",
			"Customer First Name KHALIL Customer Last Name BADAT Country of Residence Saudi",
			"Arabia Check-in July 23, 2026 Check-out July 24, 2026 Other Guests [RmNo.1]",
			"Room Type No. of Rooms Occupancy No. of Extra Bed Family - 6 Persons 1 6 Adults 0",
			"From - To Rates July 23, 2026 SAR 67.08 Reference sell rate (incl. taxes & fees) SAR 93.00 Compensation Commission SAR -13.95 Tax on Commission SAR -2.09",
			"Net rate (incl. taxes & fees) SAR 67.08",
			"http://img.agoda.net/images/email/logo/logo-header-agoda@2x.png",
			"Customer Notes Customer Info - Name: KHALIL BADAT, Phone: 966 505343351",
		].join("\n"),
	});

	assert.equal(normalized.guestName, "KHALIL BADAT");
	assert.equal(normalized.guestEmail, "");
	assert.equal(normalized.nationality, "Saudi Arabia");
	assert.equal(normalized.roomName, "Family - 6 Persons");
	assert.equal(normalized.totalGuests, 6);
	assert.equal(normalized.totalAmountSar, 93);
	assert.equal(normalized.totalPayoutSar, 67.08);

	const built = buildReservationDocument(normalized, {
		_id: "zad",
		belongsTo: "owner",
		roomCountDetails: [
			{
				_id: "five",
				roomType: "familyRooms",
				displayName: "Family Quintuple Room",
				activeRoom: true,
				pricingRate: [{ calendarDate: "2026-07-23", rootPrice: 75 }],
			},
			{
				_id: "six",
				roomType: "familyRooms",
				displayName: "Spacious Six-Bed Room",
				activeRoom: true,
				pricingRate: [
					{ calendarDate: "2026-07-23", rootPrice: 0.00001, price: 75 },
				],
			},
		],
	});
	assert.equal(built.ok, true);
	assert.equal(built.document.pickedRoomsType[0].displayName, "Spacious Six-Bed Room");
	assert.equal(built.document.pickedRoomsType[0].hotelRoomConfigId, "six");
	assert.equal(built.document.total_amount, 93);
	assert.equal(built.document.adminPricing.netAfterExpensesTotal, 67.08);
	assert.equal(built.document.sub_total, 75);
});

test("multi-room or multi-rate Agoda payloads require manual review", () => {
	const multiRoom = extractNormalizedReservation({
		from: "no-reply@agoda.com",
		subject: "Agoda Booking ID 682028096 - CONFIRMED",
		text: [
			"Booking ID 682028096 Reservation Information",
			"Customer First Name Safe Customer Last Name Guest Country of Residence Saudi Arabia Check-in July 23, 2026 Check-out July 24, 2026",
			"Other Guests [RmNo.1] Safe Guest [RmNo.2] Other Guest",
			"Room Type No. of Rooms Occupancy No. of Extra Bed Family - 6 Persons 2 6 Adults 0",
			"Reference sell rate (incl. taxes & fees) SAR 210.00",
		].join("\n"),
	});
	assert.equal(multiRoom.requiresManualReview, true);
	assert.ok(multiRoom.manualReviewReasons.some((reason) => /multiple rooms/i.test(reason)));

	const multiRate = extractNormalizedReservation({
		from: "no-reply@agoda.com",
		subject: "Agoda Booking ID 682028097 - CONFIRMED",
		text: [
			"Booking ID 682028097 Reservation Information",
			"Customer First Name Safe Customer Last Name Guest Country of Residence Saudi Arabia Check-in July 23, 2026 Check-out July 25, 2026",
			"Room Type No. of Rooms Occupancy No. of Extra Bed Double Room 1 2 Adults 0",
			"Reference sell rate (incl. taxes & fees) SAR 100.00",
			"Reference sell rate (incl. taxes & fees) SAR 110.00",
			"Total amount SAR 210.00",
		].join("\n"),
	});
	assert.equal(multiRate.totalAmountSar, 210);
	assert.equal(multiRate.requiresManualReview, true);
	assert.ok(multiRate.manualReviewReasons.some((reason) => /multiple reference/i.test(reason)));
});

test("explicit six-person inventory selects the six-bed config, never the quintuple", () => {
	const rooms = [
		{
			_id: "family-five",
			roomType: "familyRooms",
			displayName: "Family Quintuple Room",
			activeRoom: true,
		},
		{
			_id: "family-six",
			roomType: "familyRooms",
			displayName: "Spacious Six-Bed Room",
			activeRoom: true,
		},
	];
	const match = resolveRoomMatch(
		{ roomCountDetails: rooms },
		"Private Family Room for 6 Persons"
	);

	assert.equal(match.roomDetails?._id, "family-six");
	assert.equal(match.matchType, "explicit_capacity");
});

test("Arabic numeric room capacities are normalized before matching", () => {
	assert.equal(
		explicitRoomCapacity(
			"\u063a\u0631\u0641\u0629 \u0666 \u0623\u0641\u0631\u0627\u062f"
		),
		6
	);
	assert.equal(
		explicitRoomCapacity(
			"\u063a\u0631\u0641\u0629 5 \u0627\u0634\u062e\u0627\u0635"
		),
		5
	);
});

test("repeated HotelRunner room blocks require manual review", () => {
	const roomBlock = [
		"Room Type",
		"Double Room",
		"Check-in Date",
		"Jul 23, 2026",
		"Check-out Date",
		"Jul 24, 2026",
		"Guest Count",
		"2",
		"Total SAR 100",
	].join("\n");
	const normalized = extractNormalizedReservation({
		from: '"HotelRunner" <noreply@hotelrunner.com>',
		subject: "Zad Ajyad - New Reservation #681911771",
		text: [
			"Booking Source Agoda",
			"Confirmation Number 681911771",
			"Hotel Name Zad Ajyad",
			roomBlock,
			roomBlock,
			"Go to reservation",
		].join("\n"),
	});

	assert.equal(normalized.requiresManualReview, true);
	assert.match(normalized.manualReviewReasons[0], /2 room blocks/i);

	const mirroredMimeParts = extractNormalizedReservation({
		from: '"HotelRunner" <noreply@hotelrunner.com>',
		subject: "Zad Ajyad - New Reservation #681911772",
		text: roomBlock,
		html: roomBlock
			.split("\n")
			.map((line) => `<div>${line}</div>`)
			.join(""),
	});
	assert.equal(mirroredMimeParts.requiresManualReview, false);
});

test("ambiguous broad room categories and occupancy-only guesses fail closed", () => {
	const rooms = [
		{
			_id: "family-a",
			roomType: "familyRooms",
			displayName: "Family Annex",
			activeRoom: true,
		},
		{
			_id: "family-b",
			roomType: "familyRooms",
			displayName: "Family Economy",
			activeRoom: true,
		},
	];
	const broad = resolveRoomMatch(
		{ roomCountDetails: rooms },
		"Family Room",
		{ totalGuests: 5 }
	);
	const nonsense = resolveRoomMatch(
		{ roomCountDetails: HOTEL_ROOMS },
		"Children's age",
		{ totalGuests: 5 }
	);

	assert.equal(broad.roomDetails, null);
	assert.equal(nonsense.roomDetails, null);
});

test("heterogeneous HotelRunner room blocks require review instead of partial creation", () => {
	const normalized = extractNormalizedReservation({
		from: "noreply@hotelrunner.com",
		subject: "New Reservation #R637859217",
		text: [
			"Confirmation Number 682005847 Guest Name Test Guest Country Saudi Arabia Order Total SAR 217.80",
			"Hotel Name Zad Ajyad",
			"Room Type Comfort Family Room - 5 beds",
			"Check-in Date Jul 23, 2026 Check-out Date Jul 24, 2026 Guest Count 5 Daily Average Rate SAR 108.90 Total SAR 108.90",
			"Room Type Comfort Family Room - 4 beds",
			"Check-in Date Jul 23, 2026 Check-out Date Jul 24, 2026 Guest Count 4 Daily Average Rate SAR 108.90 Total SAR 108.90",
			"Go to reservation",
		].join("\n"),
	});

	assert.equal(normalized.requiresManualReview, true);
	assert.match(normalized.manualReviewReasons[0], /2 room blocks/i);
});

test("alphabetic template fragments cannot become OTA confirmation identities", () => {
	for (const value of [
		"RESERVATION CANCELATION",
		"Reservation\nExtra Info",
		"Confirmation number\nreceive",
	]) {
		const normalized = extractNormalizedReservation({
			from: "noreply@hotelrunner.com",
			subject: "Reservation cancellation",
			text: value,
		});
		assert.equal(normalized.confirmationNumber, "");
	}
});

test("confirmation nouns and bare active text cannot mutate reservation status", () => {
	for (const text of [
		"Reservation ID: 12345678. Confirmation details are available.",
		"Reservation ID: 12345678. Your active promotions are listed below.",
	]) {
		assert.equal(
			detectStatusToApply({ subject: "Reservation status", text }),
			"",
			text,
		);
	}
	for (const input of [
		{ subject: "Reservation status: confirmed", text: "ID 12345678" },
		{ subject: "Reservation status", text: "Status: confirmed" },
		{ subject: "Reservation status", text: "The reservation has been confirmed." },
	]) {
		assert.equal(detectStatusToApply(input), "confirmed", input.text);
	}
});

test("policy and instructional text cannot become no-show or stay status", () => {
	for (const input of [
		{
			subject: "Question about no-show policy - Booking 12345678",
			text: "Reservation ID: 12345678",
		},
		{
			subject: "Reservation status",
			text: "Once the guest has checked out, you can leave a review.",
		},
		{
			subject: "Reservation status",
			text: "Online check-in completed by the guest? Read the instructions.",
		},
	]) {
		assert.equal(detectStatusToApply(input), "", input.text);
	}
	for (const input of [
		{ subject: "Reservation status: no-show", text: "ID 12345678" },
		{ subject: "Reservation status", text: "Status: checked out" },
		{ subject: "Guest checked in", text: "Reservation ID: 12345678" },
	]) {
		assert.notEqual(detectStatusToApply(input), "", input.subject);
	}
});

test("AI-only critical facts do not satisfy automatic-create requirements", () => {
	const missing = requiredNewReservationMissing({
		inboundEmailId: "audit-id",
		confirmationNumber: "681911771",
		guestName: "Suggested Guest",
		hotelName: "Suggested Hotel",
		roomName: "Suggested Room",
		checkinDate: "2026-07-23",
		checkoutDate: "2026-07-24",
		amount: 70,
		totalAmountSar: 70,
		sourcePresence: {
			confirmationNumber: true,
			guestName: false,
			hotelName: false,
			roomName: false,
			checkinDate: false,
			checkoutDate: false,
			amount: false,
		},
	});

	assert.ok(missing.includes("source-backed guest name"));
	assert.ok(missing.includes("source-backed room type/name"));
	assert.ok(missing.includes("positive source-backed guest total"));
});

test("critical-field gate is provider-independent for every supported OTA source", () => {
	for (const provider of ["hotelrunner", "agoda", "expedia", "airbnb"]) {
		const normalized = {
			inboundEmailId: `audit-${provider}`,
			provider,
			confirmationNumber: `${provider}-123456`,
			guestName: "Khalil Badat",
			hotelName: "Zad Ajyad",
			roomName: "Spacious Six-Bed Room",
			checkinDate: "2026-07-23",
			checkoutDate: "2026-07-24",
			amount: 93,
			totalAmountSar: 93,
			sourcePresence: {
				confirmationNumber: true,
				guestName: true,
				hotelName: true,
				roomName: true,
				checkinDate: true,
				checkoutDate: true,
				amount: true,
			},
		};
		assert.deepEqual(requiredNewReservationMissing(normalized), [], provider);
		for (const field of [
			"confirmationNumber",
			"guestName",
			"hotelName",
			"roomName",
			"checkinDate",
			"checkoutDate",
			"amount",
		]) {
			const unsafe = {
				...normalized,
				sourcePresence: { ...normalized.sourcePresence, [field]: false },
			};
			assert.notDeepEqual(requiredNewReservationMissing(unsafe), [], `${provider}:${field}`);
		}
	}
});

test("template labels, assets, and adjacent metadata cannot become guest or room facts", () => {
	for (const value of [
		"KHALIL Customer Last Name BADAT Country of Residence Saudi",
		"Country of Residence Saudi Arabia",
		"logo-header-agoda@2x.png",
		"https://example.com/voucher",
	]) {
		assert.equal(isPlausibleOtaGuestName(value), false, value);
	}
	for (const value of [
		"Children's Age 4",
		"Guest Name Khalil Badat",
		"Check-in Date 2026-07-23",
		"logo-header-agoda@2x.png",
	]) {
		assert.equal(isPlausibleOtaRoomName(value), false, value);
	}
	assert.equal(isPlausibleOtaGuestName("KHALIL BADAT"), true);
	assert.equal(isPlausibleOtaGuestName("خالد محمد"), true);
	assert.equal(isPlausibleOtaRoomName("Family - 6 Persons"), true);
	assert.equal(isPlausibleOtaRoomName("غرفة سداسية"), true);
});

test("room-name matching does not require occupancy and never guesses an ambiguous category", () => {
	const hotel = {
		roomCountDetails: [
			{ roomType: "familyRooms", displayName: "Family Quintuple Room", activeRoom: true },
			{ roomType: "familyRooms", displayName: "Spacious Six-Bed Room", activeRoom: true },
		],
	};
	const close = resolveRoomMatch(hotel, "Spacious Six Bed Room", {
		totalGuests: 0,
	});
	assert.equal(close.roomDetails?.displayName, "Spacious Six-Bed Room");
	const ambiguous = resolveRoomMatch(hotel, "Family Room", { totalGuests: 0 });
	assert.equal(ambiguous.roomDetails, null);
	assert.equal(ambiguous.matchType, "ambiguous");
});

test("a resolved hotel stores the selected configured PMS room while retaining OTA wording only as provenance", () => {
	const normalized = {
		provider: "agoda",
		providerLabel: "Agoda",
		bookingSource: "Agoda",
		confirmationNumber: "ROOM-AI-1001",
		reservationId: "ROOM-AI-1001",
		guestName: "Safe Guest",
		hotelName: "Zad Ajyad",
		roomName: "A roomy family accommodation with six separate beds",
		checkinDate: "2026-08-01",
		checkoutDate: "2026-08-02",
		amount: 93,
		totalAmountSar: 93,
		currency: "SAR",
		eventType: "confirmed",
	};
	const selectedRoom = {
		_id: "room-six",
		roomType: "familyRooms",
		displayName: "Spacious Six-Bed Room",
		activeRoom: true,
		price: { basePrice: 75 },
	};
	const built = buildReservationDocument(
		normalized,
		{
			_id: "hotel-zad",
			belongsTo: "owner-zad",
			roomCountDetails: [selectedRoom],
		},
		{
			roomMatch: {
				roomDetails: selectedRoom,
				score: 0.96,
				matchType: "ai_pms_room_match",
				aiRoomMatch: {
					model: "test-model",
					reason: "Best semantic PMS match",
				},
			},
		}
	);

	assert.equal(built.ok, true);
	assert.equal(built.document.hotelId, "hotel-zad");
	assert.equal(built.document.pickedRoomsType[0].displayName, "Spacious Six-Bed Room");
	assert.equal(built.document.pickedRoomsType[0].hotelRoomConfigId, "room-six");
	assert.equal(
		built.document.pickedRoomsType[0].sourceRoomName,
		"A roomy family accommodation with six separate beds"
	);
	assert.equal(built.document.supplierData.otaRoomMatchedByModel, "test-model");
});

test("the as-is OTA room fallback is unassigned and financially blocked pending hotel mapping", () => {
	const normalized = {
		provider: "agoda",
		providerLabel: "Agoda",
		bookingSource: "Agoda",
		confirmationNumber: "NO-HOTEL-1001",
		reservationId: "NO-HOTEL-1001",
		guestName: "Safe Guest",
		roomName: "Original OTA Room Wording",
		checkinDate: "2026-08-01",
		checkoutDate: "2026-08-02",
		amount: 93,
		totalAmountSar: 93,
		currency: "SAR",
		eventType: "confirmed",
		inboundEmailId: "audit-no-hotel",
		sourcePresence: {
			confirmationNumber: true,
			guestName: true,
			hotelName: false,
			roomName: true,
			checkinDate: true,
			checkoutDate: true,
			amount: true,
		},
	};
	const document = buildUnmappedOtaReviewReservationDocument(normalized);

	assert.equal(canCreateUnmappedOtaReviewReservation(normalized, true), true);
	assert.equal(
		canCreateUnmappedOtaReviewReservation(
			{
				...normalized,
				sourcePresence: { ...normalized.sourcePresence, guestName: false },
			},
			true
		),
		false
	);
	assert.equal(canCreateUnmappedOtaReviewReservation(normalized, false), false);
	assert.equal(document.hotelId, undefined);
	assert.equal(document.belongsTo, undefined);
	assert.equal(document.pickedRoomsType[0].displayName, "Original OTA Room Wording");
	assert.equal(document.pickedRoomsType[0].hotelRoomConfigId, undefined);
	assert.equal(document.pickedRoomsType[0].pricingByDay[0].rootPrice, 0);
	assert.equal(document.otaPlatformReview.hotelAssignmentRequired, true);
	assert.equal(document.adminPricing.hotelAssignmentRequired, true);
});

test("a complete generic email with an unknown provider still cannot mutate reservations", async () => {
	const result = await reconcileOtaReservation({
		inboundEmailId: "audit-generic-unknown",
		provider: "unknown",
		providerLabel: "unknown",
		intent: "new_reservation",
		eventType: "new",
		confirmationNumber: "GEN-123456",
		guestName: "Khalil Badat",
		hotelName: "Zad Ajyad",
		roomName: "Spacious Six-Bed Room",
		checkinDate: "2026-07-23",
		checkoutDate: "2026-07-24",
		amount: 93,
		currency: "SAR",
		totalAmountSar: 93,
		sourcePresence: {
			confirmationNumber: true,
			guestName: true,
			hotelName: true,
			roomName: true,
			checkinDate: true,
			checkoutDate: true,
			amount: true,
		},
		source: {
			from: "reservations@example.com",
			subject: "New reservation GEN-123456",
			messageId: "generic-unknown@example.com",
		},
	});
	assert.equal(result.status, "needs_review");
	assert.equal(result.skipReason, "unknown_ota_provider_no_mutation");
	assert.equal(result.reservationId, undefined);
});

test("ordinary OTA modifications are staged without overwriting canonical guest or stay", () => {
	const set = buildExistingReservationUpdateSet({
		normalized: {
			inboundEmailId: "audit-update",
			intent: "reservation_update",
			eventType: "modified",
			provider: "agoda",
			providerLabel: "Agoda",
			confirmationNumber: "680785631",
			guestName: "Guest of Wrong Name",
			checkinDate: "2026-08-01",
			checkoutDate: "2026-08-03",
			amount: 999,
			totalAmountSar: 999,
			sourceAmount: 999,
			sourceCurrency: "SAR",
			paymentSummary: {
				totalGuestPaymentAmount: 999,
				totalPayoutAmount: 700,
			},
			sourcePresence: {
				confirmationNumber: true,
				guestName: true,
				checkinDate: true,
				checkoutDate: true,
				amount: true,
			},
		},
		existing: {
			customer_details: { name: "Correct Guest" },
			checkin_date: "2026-07-23",
			checkout_date: "2026-07-24",
		},
	});

	assert.equal(set["customer_details.name"], undefined);
	assert.equal(set.checkin_date, undefined);
	assert.equal(set.checkout_date, undefined);
	assert.equal(set["supplierData.otaAmountSar"], undefined);
	assert.equal(set["supplierData.otaSourceAmount"], undefined);
	assert.equal(set["supplierData.otaPaymentSummary"], undefined);
	assert.equal(
		set["otaPlatformReview.proposedInbound"].guest.name,
		"Guest of Wrong Name"
	);
	assert.equal(
		set["otaPlatformReview.proposedInbound"].pricing.guestTotalSar,
		999
	);
});

test("status-only OTA updates keep the applied status and close terminal review state", () => {
	const existing = {
		reservation_status: "OTA Platform Review",
		state: "OTA Platform Review",
		otaPlatformReview: { status: "pending" },
	};
	const confirmed = buildExistingReservationUpdateSet({
		existing,
		statusToApply: "confirmed",
		normalized: {
			intent: "reservation_status",
			eventType: "status",
			statusToApply: "confirmed",
			confirmationNumber: "12345678",
		},
	});
	assert.equal(confirmed.reservation_status, "confirmed");
	assert.equal(confirmed.state, "confirmed");
	assert.equal(confirmed["otaPlatformReview.status"], undefined);

	const cancelled = buildExistingReservationUpdateSet({
		existing,
		statusToApply: "cancelled",
		normalized: {
			intent: "reservation_status",
			eventType: "cancelled",
			statusToApply: "cancelled",
			confirmationNumber: "12345678",
			providerLabel: "Agoda",
		},
	});
	assert.equal(cancelled.reservation_status, "cancelled");
	assert.equal(cancelled.state, "cancelled");
	assert.equal(cancelled["otaPlatformReview.status"], "closed");
	assert.equal(cancelled["otaPlatformReview.closedReason"], "ota_status_cancelled");
});

test("authoritative refresh requires a built document and never copies placeholders", () => {
	const normalized = {
		inboundEmailId: "audit-refresh",
		intent: "new_reservation",
		eventType: "created",
		provider: "agoda",
		providerLabel: "Agoda",
		confirmationNumber: "681911771",
		guestName: "Waqas Khan",
		checkinDate: "2026-07-23",
		checkoutDate: "2026-07-24",
		authoritativeExistingRefresh: true,
		sourcePresence: {
			confirmationNumber: true,
			guestName: true,
			guestEmail: false,
			guestPhone: false,
			checkinDate: true,
			checkoutDate: true,
		},
	};
	const existing = {
		customer_details: { name: "Lower Authority Guest" },
		checkin_date: "2026-07-25",
		checkout_date: "2026-07-26",
	};
	const withoutDocument = buildExistingReservationUpdateSet({
		normalized,
		existing,
	});
	assert.equal(withoutDocument["customer_details.name"], undefined);
	assert.equal(withoutDocument.checkin_date, undefined);

	const withDocument = buildExistingReservationUpdateSet({
		normalized,
		existing,
		document: {
			customer_details: {
				name: "Waqas Khan",
				email: "no-email@jannatbooking.com",
				phone: "0000",
				passport: "Not Provided",
			},
			checkin_date: "2026-07-23",
			checkout_date: "2026-07-24",
			adminPricing: { clientTotal: 70 },
			ota_financial_summary: { clientTotal: 70 },
			adminPricingVisibility: { rootOnlyForHotelManagement: true },
			supplierData: { otaAmountSar: 70 },
		},
	});
	assert.equal(withDocument["customer_details.name"], "Waqas Khan");
	assert.equal(withDocument.checkin_date, "2026-07-23");
	assert.equal(withDocument["customer_details.email"], undefined);
	assert.equal(withDocument["customer_details.phone"], undefined);
	assert.equal(withDocument["customer_details.passport"], undefined);
	assert.equal(withDocument["supplierData.otaAmountSar"], 70);
});

test("source authority distinguishes direct OTA confirmations from HotelRunner copies", () => {
	assert.equal(
		otaSourceAuthority({
			provider: "agoda",
			source: { from: '"agoda.com" <no-reply@agoda.com>' },
		}),
		3
	);
	assert.equal(
		otaSourceAuthority({
			provider: "agoda",
			source: { from: '"HotelRunner" <noreply@hotelrunner.com>' },
		}),
		1
	);
	assert.equal(isAuthoritativeSourceUpgrade(2, 1), false);
	assert.equal(isAuthoritativeSourceUpgrade(3, 1), true);
	assert.equal(isAuthoritativeSourceUpgrade(3, 3), false);
	assert.equal(isAuthoritativeSourceUpgrade(4, 3), true);
});

test("fuzzy hotel matching requires a unique high-margin candidate", () => {
	const hotels = [
		{ _id: "zad", hotelName: "Zad Ajyad" },
		{ _id: "farway", hotelName: "Farway Hotel" },
	];
	assert.equal(
		findConfidentFuzzyHotelMatch(hotels, ["Zad Agyad"])?._id,
		"zad"
	);
	assert.equal(
		findConfidentFuzzyHotelMatch(
			[
				{ _id: "royal-hotel", hotelName: "Royal Ajyad Hotel" },
				{ _id: "royal-suites", hotelName: "Royal Ajyad Suites" },
			],
			["Royal Ajyad"]
		),
		null
	);
	assert.equal(findConfidentFuzzyHotelMatch(hotels, ["Unknown Palace"]), null);
});

test("inbound audit schema has an atomic partial unique delivery key", () => {
	const index = InboundEmail.schema
		.indexes()
		.find(([, options]) => options?.name === "uniq_inbound_email_dedupe_key");
	assert.ok(index);
	assert.deepEqual(index[0], { dedupeKey: 1 });
	assert.equal(index[1].unique, true);
});
