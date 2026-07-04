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

check("Seven guests produce family plus double room plan", () => {
	const selections = orchestrator.bestRoomSelectionsForGuests(hotel, 7);
	const map = selectionMap(selections);
	assert.strictEqual(map.get("familyRooms"), 1);
	assert.strictEqual(map.get("doubleRooms"), 1);
	assert.strictEqual(orchestrator.roomSelectionsGuestCapacity(selections), 7);
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
	const review = ai("Final review for 225 SAR", "review_reservation");
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
