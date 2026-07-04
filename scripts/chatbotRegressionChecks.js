const assert = require("assert");

process.env.SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "SG.test";
process.env.WHATSAPP_DRY_RUN = "true";
process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "AC00000000000000000000000000000000";
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "test-token";
process.env.TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER || "+10000000000";

const orchestrator = require("../aiagent/core/orchestrator").__test;

const hotel = {
	_id: "zad-ajyad-test",
	hotelName: "Zad Ajyad",
	hotelName_OtherLanguage: "Zad Ajyad",
	currency: "SAR",
	hasBusService: true,
	busDetails: "يوفر الفندق باصًا خاصًا لنقل الضيوف إلى موقف الشهداء.",
	roomCountDetails: [
		{ roomType: "doubleRooms", activeRoom: true, displayName: "Double Room", bedsCount: 1, price: { basePrice: 110 } },
		{ roomType: "tripleRooms", activeRoom: true, displayName: "Triple Room - Premium Comfort", bedsCount: 1, price: { basePrice: 75 } },
		{ roomType: "quadRooms", activeRoom: true, displayName: "Quadruple Room", bedsCount: 1, price: { basePrice: 120 } },
		{ roomType: "familyRooms", activeRoom: true, displayName: "Family Quintuple Room", bedsCount: 1, price: { basePrice: 140 } },
	],
};

const supportEmail = "support@jannatbooking.com";
const guestEmail = "guest@example.com";

function ai(message, clientAction = "") {
	return {
		isAi: true,
		clientAction,
		message,
		date: new Date(),
		messageBy: { customerName: "Hana", customerEmail: supportEmail },
	};
}

function guest(message, clientAction = "") {
	return {
		isAi: false,
		clientAction,
		message,
		date: new Date(),
		messageBy: { customerName: "Ahmed", customerEmail: guestEmail },
	};
}

function selectionMap(selections) {
	return new Map((selections || []).map((item) => [item.roomTypeKey, item.count]));
}

function quoteForTriple() {
	return {
		available: true,
		checkinISO: "2026-08-25",
		checkoutISO: "2026-08-28",
		roomTypeKey: "tripleRooms",
		roomSelections: [{ roomTypeKey: "tripleRooms", count: 1 }],
		totalRooms: 1,
		roomCount: 1,
		nights: 3,
		averagePerNight: 75,
		total: 225,
		currency: "SAR",
	};
}

let checks = 0;
function check(name, fn) {
	fn();
	checks += 1;
	console.log(`PASS ${name}`);
}

check("Arabic labeled children-under-age count is preserved", () => {
	const text = "عدد الكبار 4 عدد الاطفال تحت 12 سنه 3";
	assert.deepStrictEqual(orchestrator.explicitGuestCountFactsFromText(text), {
		adults: 4,
		children: 3,
	});
	assert.deepStrictEqual(
		orchestrator.guestCountFactsFromAskedAnswer(text, {
			clientAction: "ask_guest_count",
			message: "كم عدد البالغين والأطفال؟",
		}),
		{ adults: 4, children: 3 }
	);
});

check("Arabic children-under-age with dates ignores the age as child count", () => {
	const text =
		"\u0646\u062d\u0646 \u0664 \u0643\u0628\u0627\u0631 \u0648\u0663 \u0623\u0637\u0641\u0627\u0644 \u062a\u062d\u062a \u0661\u0662 \u0633\u0646\u0629 \u0645\u0646 \u0662\u0665 \u0623\u063a\u0633\u0637\u0633 \u0625\u0644\u0649 \u0662\u0668 \u0623\u063a\u0633\u0637\u0633";
	assert.deepStrictEqual(orchestrator.explicitGuestCountFactsFromText(text), {
		adults: 4,
		children: 3,
	});
	assert.deepStrictEqual(
		orchestrator.sanitizeBrainFactsForLatestText({ adults: 4, children: 19 }, {}, text),
		{ adults: 4, children: 3 }
	);
});

check("Arabic checkout correction with Arabic month is parsed", () => {
	const text =
		"\u0644\u0627\u060c \u0642\u0635\u062f\u064a \u0627\u0644\u062e\u0631\u0648\u062c \u0661\u0662 \u0623\u063a\u0633\u0637\u0633";
	assert.strictEqual(
		orchestrator.standaloneSingleDateFromText(text, {
			checkinISO: "2026-08-05",
			checkoutISO: "2026-08-10",
		}),
		"2026-08-12"
	);
	assert.deepStrictEqual(
		orchestrator.dateBoundaryFactsFromAskedAnswer(
			text,
			{ checkinISO: "2026-08-05", checkoutISO: "2026-08-10" },
			{ message: "\u0645\u0627 \u062a\u0627\u0631\u064a\u062e \u0627\u0644\u062e\u0631\u0648\u062c\u061f" }
		),
		{ checkoutISO: "2026-08-12", dateCalendar: "gregorian" }
	);
});

check("French nationality with accent is captured", () => {
	const text =
		"Bonjour, je veux une chambre triple du 25 ao\u00fbt au 28 ao\u00fbt pour 3 adultes. Nationalit\u00e9 alg\u00e9rienne.";
	assert.strictEqual(orchestrator.nationalityFromIdentityText(text), "Algerian");
	assert.deepStrictEqual(orchestrator.bookingIdentityFactsFromText(text), {
		nationality: "Algerian",
		nationalityConfirmed: true,
	});
});

check("Seven guests produce family plus double room plan", () => {
	const selections = orchestrator.bestRoomSelectionsForGuests(hotel, 7);
	const map = selectionMap(selections);
	assert.strictEqual(map.get("familyRooms"), 1);
	assert.strictEqual(map.get("doubleRooms"), 1);
	assert.strictEqual(orchestrator.roomSelectionsGuestCapacity(selections), 7);
});

check("Eight requested beds produce family plus triple room plan", () => {
	const selections = orchestrator.bestRoomSelectionsForGuests(hotel, 8);
	const map = selectionMap(selections);
	assert.strictEqual(map.get("familyRooms"), 1);
	assert.strictEqual(map.get("tripleRooms"), 1);
	assert.strictEqual(orchestrator.roomSelectionsGuestCapacity(selections), 8);
});

check("Arabic me and six friends with eight beds recovers target and plan", () => {
	const firstGuest = guest("كنت عايز غرفة ليا انا و ٦ اصحابى هل متاح غرف ب٨ سراير");
	const dateGuest = guest("تمام\nمن ١٥ اغسطس ل٢٥ اغسطس");
	const sc = {
		preferredLanguageCode: "ar",
		conversation: [firstGuest, ai("ابعت تاريخ الدخول والخروج."), dateGuest],
	};
	let known = orchestrator.recoverKnownFactsFromConversation(sc, {});
	known = orchestrator.ensureRoomPlanForGuestCapacity(hotel, known).known;
	const map = selectionMap(known.roomSelections);
	assert.strictEqual(known.adults, 7);
	assert.strictEqual(known.children, 0);
	assert.strictEqual(known.requestedBeds, 8);
	assert.strictEqual(orchestrator.capacityTargetFromKnown(known), 8);
	assert.strictEqual(known.checkinISO, "2026-08-15");
	assert.strictEqual(known.checkoutISO, "2026-08-25");
	assert.strictEqual(map.get("familyRooms"), 1);
	assert.strictEqual(map.get("tripleRooms"), 1);
	assert.strictEqual(orchestrator.roomSelectionsGuestCapacity(known.roomSelections), 8);
});

check("Invalid one-room family selection is replanned before quote/review", () => {
	const known = {
		checkinISO: "2026-07-20",
		checkoutISO: "2026-07-30",
		roomTypeKey: "familyRooms",
		roomSelections: [{ roomTypeKey: "familyRooms", count: 1 }],
		rooms: 1,
		adults: 4,
		children: 3,
		quote: quoteForTriple(),
	};
	const result = orchestrator.ensureRoomPlanForGuestCapacity(hotel, known);
	const map = selectionMap(result.known.roomSelections);
	assert.strictEqual(result.changed, true);
	assert.strictEqual(map.get("familyRooms"), 1);
	assert.strictEqual(map.get("doubleRooms"), 1);
	assert.strictEqual(result.known.quote, undefined);
});

check("Quote cannot match if selected capacity is too small", () => {
	const known = {
		checkinISO: "2026-07-20",
		checkoutISO: "2026-07-30",
		roomTypeKey: "quadRooms",
		roomSelections: [{ roomTypeKey: "quadRooms", count: 1 }],
		rooms: 1,
		adults: 4,
		children: 3,
		quote: {
			available: true,
			checkinISO: "2026-07-20",
			checkoutISO: "2026-07-30",
			roomTypeKey: "quadRooms",
			roomSelections: [{ roomTypeKey: "quadRooms", count: 1 }],
			totalRooms: 1,
			total: 750,
			currency: "SAR",
		},
	};
	assert.strictEqual(orchestrator.quoteMatchesKnown(known), false);
});

check("Hotel fact side question restores final review checkpoint and buttons", () => {
	const review = {
		...ai("Final review for 225 SAR", "review_reservation"),
		quickReplies: [
			{ label: "إتمام الحجز", value: "إتمام الحجز", action: "place_reservation" },
			{ label: "هناك شيء غير صحيح", value: "هناك شيء غير صحيح", action: "revise_reservation" },
		],
	};
	const busQuestion = guest("عندكم اوتوبيس يوصل للحرم");
	const sc = {
		preferredLanguageCode: "ar",
		targetUserName: "Ahmed Abdelrazak",
		conversation: [review, busQuestion],
	};
	const known = {
		languageCode: "ar",
		checkinISO: "2026-08-25",
		checkoutISO: "2026-08-28",
		roomTypeKey: "tripleRooms",
		roomSelections: [{ roomTypeKey: "tripleRooms", count: 1 }],
		rooms: 1,
		adults: 3,
		children: 0,
		fullName: "Ahmed Abdelrazak",
		phone: "8888888876",
		nationality: "مصري",
		emailSkipped: true,
		quote: quoteForTriple(),
	};
	const reply = orchestrator.appendBookingCheckpointToHotelFactReply(
		"نعم، يوجد باص حسب بيانات الفندق.",
		sc,
		hotel,
		known,
		busQuestion
	);
	assert(reply.includes("نعم"));
	assert(/225|\u0662\u0662\u0665/.test(reply));
	const quickReplies = orchestrator.hotelFactQuickRepliesWithBookingCheckpoint(sc, known, busQuestion);
	assert.deepStrictEqual(
		quickReplies.map((item) => item.action),
		["place_reservation", "revise_reservation"]
	);
	assert.strictEqual(orchestrator.shouldAnswerHotelFactNow(busQuestion, ""), true);

	const quoteMismatchedKnown = { ...known };
	delete quoteMismatchedKnown.quote;
	const storedCheckpointReplies = orchestrator.hotelFactQuickRepliesWithBookingCheckpoint(
		sc,
		quoteMismatchedKnown,
		busQuestion
	);
	assert.deepStrictEqual(
		storedCheckpointReplies.map((item) => item.action),
		["place_reservation", "revise_reservation"]
	);
});

check("Booking intent after hotel fact resumes final review", () => {
	const review = ai("Final review for 225 SAR", "review_reservation");
	const fact = ai("نعم، يوجد باص.", "hotel_fact_answered");
	const continueGuest = guest("يلا نحجز بقا ههههههه");
	const sc = { conversation: [review, fact, continueGuest] };
	assert.strictEqual(
		orchestrator.actionToResumeAfterHotelFactAffirmation(sc, continueGuest, fact, ""),
		"send_review"
	);
});

check("July 2 quote unavailable detour resumes alternatives, not location", () => {
	const unavailable = ai("Family Suite is not available for these dates.", "quote_unavailable");
	const fact = ai("The hotel is close to Haram.", "hotel_fact_answered");
	const continueGuest = guest("Yes");
	const sc = { conversation: [unavailable, fact, continueGuest] };
	assert.strictEqual(
		orchestrator.actionToResumeAfterHotelFactAffirmation(sc, continueGuest, fact, ""),
		"check_alternatives"
	);
});

check("July 2 quote ready detour resumes review path", () => {
	const quote = ai("Available quote for 1 Family Quintuple Room.", "quote_ready");
	const fact = ai("The hotel is close to Haram.", "hotel_fact_answered");
	const continueGuest = guest("OK");
	const sc = { conversation: [quote, fact, continueGuest] };
	assert.strictEqual(
		orchestrator.actionToResumeAfterHotelFactAffirmation(sc, continueGuest, fact, ""),
		"send_review"
	);
});

check("July 2 booking process replies must show known dates and room", () => {
	const latestGuest = guest("Whats the process of booking");
	const known = {
		languageCode: "en",
		checkinISO: "2026-08-05",
		checkoutISO: "2026-08-20",
		roomTypeKey: "familyRooms",
		quote: {
			roomLabel: "Family Quintuple Room",
		},
	};
	assert.strictEqual(orchestrator.latestGuestAsksBookingProcess(latestGuest), true);
	assert.strictEqual(
		orchestrator.bookingProcessReplyNeedsCorrection(
			{
				action: "reply",
				reply: "Share your check-in and check-out dates, choose the room type, then I will send a quote.",
			},
			known,
			latestGuest
		),
		true
	);
	assert.strictEqual(
		orchestrator.bookingProcessReplyNeedsCorrection(
			{
				action: "reply",
				reply:
					"For your stay from 2026-08-05 to 2026-08-20, the available quoted option is 1 Family Quintuple Room. To continue, please send the remaining required details.",
			},
			known,
			latestGuest
		),
		false
	);
});

check("July 2 alternatives replies cannot drift back to location facts", () => {
	assert.strictEqual(
		orchestrator.alternativeReplyDriftedToHotelFact(
			"Here is the hotel location on Google Maps. It is about 10 minutes walking from Al Haram."
		),
		true
	);
	assert.strictEqual(
		orchestrator.alternativeReplyDriftedToHotelFact(
			"I checked nearby dates and no alternatives are available for the current room choice. We can try different dates or another room type."
		),
		false
	);
});

check("Turkish language and economical nearby dates are detected", () => {
	assert.deepStrictEqual(
		orchestrator.languageFactsFromGuestText("20 Temmuz'dan itibaren 10 gece fiyat nedir?"),
		{ languageCode: "tr", languageName: "Turkish" }
	);
	assert.strictEqual(
		orchestrator.latestGuestRequestsCheaperNearbyDates("buna yakın ekonomik günler var mı?", ""),
		true
	);
});

check("Room facts expose type capacity before unreliable bedsCount", () => {
	const facts = orchestrator.compactHotelFacts(hotel);
	const family = facts.rooms.find((room) => room.roomTypeKey === "familyRooms");
	const double = facts.rooms.find((room) => room.roomTypeKey === "doubleRooms");
	assert.strictEqual(family.bedsCount, 5);
	assert.strictEqual(double.bedsCount, 2);
});

console.log(`PASS ${checks} chatbot regression checks`);
