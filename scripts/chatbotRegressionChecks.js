const assert = require("assert");

process.env.SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "SG.test";
process.env.WHATSAPP_DRY_RUN = "true";
process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "AC00000000000000000000000000000000";
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "test-token";
process.env.TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER || "+10000000000";
process.env.AI_AGENT_TEST_EXPORTS = "true";

const orchestrator = require("../aiagent/core/orchestrator").__test;
const jannatSupport = require("../aiagent/jannatSupport/orchestrator").__test;
const jannatBrain = require("../aiagent/jannatSupport/brain").__test;
const reservationController = require("../controllers/reservations").__test;

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

check("Direct-booking discount quote shows struck old price and green final price", () => {
	assert.strictEqual(orchestrator.originalAmountBeforeDirectDiscount(75), 100);
	const discount = orchestrator.quoteDiscountDisplay(
		{ total: 75, averagePerNight: 75, currency: "SAR" },
		"en"
	);
	assert(discount.displayTotalLine.includes('<s class="message-price-old">100 SAR</s>'));
	assert(discount.displayTotalLine.includes('<strong class="message-price-new">75 SAR</strong>'));
	assert(discount.displayTotalLine.includes("25% direct-booking discount"));

	const reply = orchestrator.buildQuoteFallbackMessage(
		{ preferredLanguageCode: "en", displayName1: "Ahmed" },
		{
			languageCode: "en",
			checkinISO: "2026-08-25",
			checkoutISO: "2026-08-28",
			roomTypeKey: "tripleRooms",
			rooms: 1,
		},
		{ available: true, quote: quoteForTriple() },
		hotel
	);
	assert(reply.includes('<s class="message-price-old">300 SAR</s>'));
	assert(reply.includes('<strong class="message-price-new">225 SAR</strong>'));
});

check("Available quote validator rejects missing discount markup", () => {
	const toolResult = {
		tool: "get_quote",
		available: true,
		discount: orchestrator.quoteDiscountDisplay(
			{ total: 75, averagePerNight: 75, currency: "SAR" },
			"en"
		),
	};
	assert.strictEqual(orchestrator.quoteReplyMissingDiscountFormat("Total: 75 SAR", toolResult), true);
	assert.strictEqual(
		orchestrator.quoteReplyMissingDiscountFormat(toolResult.discount.displayTotalLine, toolResult),
		false
	);
});

check("Budget objection reply is concise and explains no-commission direct booking", () => {
	const reply = orchestrator.buildValueObjectionFallbackReply(
		{ preferredLanguageCode: "en", displayName1: "Ahmed" },
		hotel,
		{ languageCode: "en", quote: { ...quoteForTriple(), total: 75, averagePerNight: 75 } },
		guest("Can I get a discount?")
	);
	assert(reply.includes('<s class="message-price-old">100 SAR</s>'));
	assert(reply.includes("no middleman commission"));
	assert(!reply.includes("Which way would you like me to continue?"));
	assert(!reply.includes("Check the best available option"));
});

check("Triple-room correction can reduce ambiguous three-room request to one room", () => {
	const text = "لا، غرفة ثلاثية واحدة فقط لثلاثة أشخاص";
	assert.strictEqual(orchestrator.roomCountCorrectionFromText(text), 1);
	const selections = orchestrator.extractRoomSelectionsFromText(text);
	assert.strictEqual(selections[0]?.roomTypeKey, "tripleRooms");
	assert.strictEqual(orchestrator.roomSelectionsGuestCapacity(selections), 3);
});

check("Combined identity and bus detour do not damage known quote or guest name", () => {
	const known = {
		languageCode: "ar",
		checkinISO: "2026-07-17",
		checkoutISO: "2026-07-29",
		roomSelections: [
			{ roomTypeKey: "quadRooms", count: 1 },
			{ roomTypeKey: "doubleRooms", count: 1 },
		],
		rooms: 2,
		adults: 6,
		quote: {
			available: true,
			checkinISO: "2026-07-17",
			checkoutISO: "2026-07-29",
			roomSelections: [
				{ roomTypeKey: "quadRooms", count: 1 },
				{ roomTypeKey: "doubleRooms", count: 1 },
			],
			totalRooms: 2,
			total: 1800,
			currency: "SAR",
		},
	};
	const identity = orchestrator.bookingIdentityFactsFromText(
		"الاسم مرسي ربيع\nالجنسية مصري\nالهاتف 01012345678",
		{ allowName: true }
	);
	const merged = orchestrator.mergeKnownFacts(known, identity);
	assert.strictEqual(merged.quote.total, 1800);
	assert.strictEqual(orchestrator.roomSelectionsTotal(merged.roomSelections), 2);
	assert.strictEqual(merged.phone, "01012345678");
	assert.strictEqual(merged.fullName, "مرسي ربيع");

	const busFacts = orchestrator.bookingIdentityFactsFromText("قبل اي شي هل يوجد اتوبيس", {
		allowName: true,
		allowUnlabeledName: true,
	});
	assert.strictEqual(busFacts.fullName, undefined);
	assert.strictEqual(
		orchestrator.latestGuestMentionsBus({ message: "قبل اي شي هل يوجد اتوبيس" }),
		true
	);
	assert.strictEqual(orchestrator.runtimeTuning.guestReplyQuietMs >= 3000, true);
	assert.strictEqual(orchestrator.runtimeTuning.planMaxActiveTurns, 1);
});

check("Clarification and count-closure phrases cannot become booking names", () => {
	const confusedArabic = "\u0645\u0648 \u0641\u0627\u0647\u0645";
	const confusedEnglish = "I do not understand";
	const confusedFrench = "je ne comprends pas";
	const countClosure = "\u0643\u062f\u0647 \u0627\u0644\u0627\u0631\u0628\u0639\u0647";
	assert.strictEqual(orchestrator.looksLikeClarificationOrConfusionPhrase(confusedArabic), true);
	assert.strictEqual(orchestrator.looksLikeClarificationOrConfusionPhrase(confusedEnglish), true);
	assert.strictEqual(orchestrator.looksLikeClarificationOrConfusionPhrase(confusedFrench), true);
	assert.strictEqual(orchestrator.looksLikeGuestCountClosurePhrase(countClosure), true);
	assert.strictEqual(
		orchestrator.bookingIdentityFactsFromText(confusedArabic, {
			allowName: true,
			allowUnlabeledName: true,
		}).fullName,
		undefined
	);
	assert.strictEqual(
		orchestrator.bookingIdentityFactsFromText(confusedFrench, {
			allowName: true,
			allowUnlabeledName: true,
		}).fullName,
		undefined
	);
	assert.strictEqual(
		orchestrator.bookingIdentityFactsFromText(countClosure, {
			allowName: true,
			allowUnlabeledName: true,
		}).fullName,
		undefined
	);
});

check("Separate adult and child messages preserve the reviewed party split", () => {
	const previousAi = {
		clientAction: "required_details_needed",
		message:
			"\u0643\u0645 \u0639\u062f\u062f \u0627\u0644\u0628\u0627\u0644\u063a\u064a\u0646 \u0648\u0643\u0645 \u0639\u062f\u062f \u0627\u0644\u0623\u0637\u0641\u0627\u0644\u061f",
	};
	const adultFacts = orchestrator.guestCountFactsFromAskedAnswer(
		"\u0627\u0644\u0628\u0627\u0644\u0641\u064a\u0646 \u0663",
		previousAi
	);
	const childFacts = orchestrator.guestCountFactsFromAskedAnswer("\u0648\u0637\u0641\u0644", previousAi);
	let known = orchestrator.mergeKnownFacts(
		{ languageCode: "ar", adults: 4, children: 0 },
		adultFacts
	);
	known = orchestrator.mergeKnownFacts(known, childFacts);
	assert.strictEqual(known.adults, 3);
	assert.strictEqual(known.children, 1);
	assert.strictEqual(
		orchestrator.bookingIdentityFactsFromText("\u0643\u062f\u0647 \u0627\u0644\u0627\u0631\u0628\u0639\u0647", {
			allowName: true,
			allowUnlabeledName: true,
		}).fullName,
		undefined
	);
});

check("Submit restores official review facts before reservation creation", () => {
	const reviewed = {
		languageCode: "ar",
		checkinISO: "2026-07-20",
		checkoutISO: "2026-07-25",
		roomTypeKey: "quadRooms",
		roomSelections: [{ roomTypeKey: "quadRooms", count: 1 }],
		rooms: 1,
		adults: 3,
		children: 1,
		fullName: "\u0645\u062d\u0645\u062f \u0627\u0628\u0631\u0627\u0647\u064a\u0645 \u0645\u062d\u0645\u062f \u063a\u0627\u0632\u0649",
		fullNameConfirmed: true,
		phone: "0530057894",
		phoneConfirmed: true,
		nationality: "\u0645\u0635\u0631\u064a",
		nationalityConfirmed: true,
		email: "mabokmel55@gmail.com",
	};
	const officialReviewSnapshot = orchestrator.officialReviewSnapshotFromKnown(reviewed);
	const contaminated = {
		...reviewed,
		officialReviewSnapshot,
		fullName: "\u0645\u0648 \u0641\u0627\u0647\u0645",
		adults: 1,
		children: 0,
	};
	const restored = orchestrator.applyOfficialReviewSnapshotForSubmit(contaminated);
	assert.strictEqual(restored.fullName, reviewed.fullName);
	assert.strictEqual(restored.adults, 3);
	assert.strictEqual(restored.children, 1);
	assert.strictEqual(restored.phone, "0530057894");
});

check("AI chat reservation update preserves reviewed multi-guest count by default", () => {
	assert(reservationController?.protectAiReservationGuestCountUpdate);
	const existing = {
		aiSupportCaseId: "case-1",
		aiReservationFingerprint: "fingerprint-1",
		adults: 3,
		children: 1,
		total_guests: 4,
	};
	const protectedUpdate = reservationController.protectAiReservationGuestCountUpdate(
		{ adults: 1, children: 0, total_guests: 1 },
		existing
	);
	assert.deepStrictEqual(
		{
			adults: protectedUpdate.adults,
			children: protectedUpdate.children,
			total_guests: protectedUpdate.total_guests,
		},
		{ adults: 3, children: 1, total_guests: 4 }
	);
	const explicitUpdate = reservationController.protectAiReservationGuestCountUpdate(
		{ adults: 1, children: 0, total_guests: 1 },
		existing,
		{ hasExplicitGuestCountUpdateIntent: true }
	);
	assert.deepStrictEqual(
		{
			adults: explicitUpdate.adults,
			children: explicitUpdate.children,
			total_guests: explicitUpdate.total_guests,
		},
		{ adults: 1, children: 0, total_guests: 1 }
	);
});

check("Jannat support collects missing pricing detail before handoff", () => {
	const sc = {
		preferredLanguageCode: "en",
		conversation: [guest("I want the price from August 25 to August 28")],
	};
	const facts = {
		languageCode: "en",
		checkinISO: "2026-08-25",
		checkoutISO: "2026-08-28",
	};
	assert.strictEqual(jannatSupport.guestLikelyWantsPricingOrBooking(sc), true);
	assert.deepStrictEqual(jannatSupport.missingPricingFacts(facts), ["room_or_guests"]);
	assert(
		jannatSupport
			.missingPricingDetailsMessage(sc, facts)
			.includes("room type or number of guests")
	);
});

check("Jannat support recommendation can show direct-booking discount quote", () => {
	const facts = {
		languageCode: "en",
		checkinISO: "2026-08-25",
		checkoutISO: "2026-08-28",
		roomTypeKey: "tripleRooms",
		roomSelections: [{ roomTypeKey: "tripleRooms", count: 1 }],
		rooms: 1,
		adults: 3,
	};
	const quote = jannatSupport.buildQuoteForFacts(hotel, facts);
	assert.strictEqual(quote.available, true);
	assert.strictEqual(quote.total, 225);
	const reply = jannatSupport.recommendationMessage({
		supportCase: { preferredLanguageCode: "en" },
		hotel,
		facts: { ...facts, quote },
		availabilityChecked: true,
		quote,
	});
	assert(reply.includes('<s class="message-price-old">300 SAR</s>'));
	assert(reply.includes('<strong class="message-price-new">225 SAR</strong>'));
	assert(reply.includes("25% direct-booking discount"));
	assert(reply.includes("lively Ajyad area"));
	assert(reply.includes("many restaurants"));
	assert(reply.includes("Current offer"));

	const backupHotel = {
		...hotel,
		_id: "zad-mashaer-test",
		hotelName: "Zad Al Mashaer",
	};
	assert.strictEqual(
		jannatSupport.chooseTargetHotel({
			plan: { targetHotelId: "zad-ajyad-test" },
			candidateHotels: [hotel, backupHotel],
			facts: { ...facts, jannatUnavailableRecoveryFromHotelId: "zad-mashaer-test" },
		})?._id,
		"zad-ajyad-test"
	);
	assert.strictEqual(
		jannatSupport.chooseTargetHotel({
			plan: { targetHotelId: "zad-ajyad-test" },
			candidateHotels: [hotel, backupHotel],
			facts: { ...facts, jannatUnavailableRecoveryFromHotelId: "zad-ajyad-test" },
		})?._id,
		"zad-mashaer-test"
	);
});

check("Jannat support infers recommended double room before handoff", () => {
	const sc = {
		preferredLanguageCode: "en",
		conversation: [
			guest("We arrive August 25 and leave August 28, two adults please."),
		],
	};
	const facts = jannatBrain.normalizeFacts({}, sc);
	assert.strictEqual(facts.checkinISO, "2026-08-25");
	assert.strictEqual(facts.checkoutISO, "2026-08-28");
	assert.strictEqual(facts.roomTypeKey, "doubleRooms");
	assert.deepStrictEqual(facts.roomSelections, [{ roomTypeKey: "doubleRooms", count: 1 }]);
	const quote = jannatSupport.buildQuoteForFacts(hotel, facts);
	assert.strictEqual(quote.available, true);
	assert.strictEqual(quote.total, 330);
	const reply = jannatSupport.recommendationMessage({
		supportCase: sc,
		hotel,
		facts: { ...facts, quote },
		availabilityChecked: true,
		quote,
	});
	assert(reply.includes("Double Room"));
	assert(reply.includes('<s class="message-price-old">440 SAR</s>'));
	assert(reply.includes('<strong class="message-price-new">330 SAR</strong>'));
});

check("Jannat support canonicalizes LLM room aliases before availability checks", () => {
	const sc = {
		preferredLanguageCode: "ar",
		aiStateSnapshot: {
			known: {
				checkinISO: "2026-07-27",
				checkoutISO: "2026-08-02",
				roomTypeKey: "doubleRooms",
				roomSelections: [{ roomTypeKey: "doubleRooms", count: 1 }],
				adults: 2,
				children: 0,
				jannatUnavailableRecoveryFromHotelId: "zad-mashaer-test",
			},
		},
		conversation: [
			guest("\u0623\u0646\u0627 \u0648\u0632\u0648\u062c\u062a\u064a \u0646\u062d\u062a\u0627\u062c \u063a\u0631\u0641\u0629 \u0645\u0632\u062f\u0648\u062c\u0629"),
		],
	};
	const facts = jannatBrain.normalizeFacts(
		{
			checkinISO: "2026-07-27",
			checkoutISO: "2026-08-02",
			roomTypeKey: "double_room",
			roomSelections: [{ roomTypeKey: "double_room", count: 1 }],
			adults: 2,
			children: 0,
		},
		sc
	);
	assert.strictEqual(facts.roomTypeKey, "doubleRooms");
	assert.deepStrictEqual(facts.roomSelections, [{ roomTypeKey: "doubleRooms", count: 1 }]);
	assert.strictEqual(jannatSupport.hotelHasRequestedAvailability(hotel, facts), true);
	assert.strictEqual(
		jannatSupport.chooseTargetHotel({
			plan: { targetHotelId: "zad-ajyad-test" },
			candidateHotels: [
				{ ...hotel, _id: "zad-ajyad-test" },
				{ ...hotel, _id: "zad-mashaer-test" },
			],
			facts: { ...facts, jannatUnavailableRecoveryFromHotelId: "zad-mashaer-test" },
		})?._id,
		"zad-ajyad-test"
	);
});

check("Jannat-transferred unavailable fixed-date lead is preserved", () => {
	const fixedDatesText =
		"\u0627\u0644\u0645\u0648\u0639\u062f \u0628\u0627\u0644\u0646\u0633\u0628\u0629 \u0644\u064a \u063a\u064a\u0631 \u0642\u0627\u0628\u0644 \u0644\u0644\u062a\u063a\u064a\u064a\u0631";
	const sc = {
		preferredLanguageCode: "ar",
		displayName1: "Mohamed Sherif Ghanem",
		aiStateSnapshot: {
			known: { jannatPlatformTransfer: true },
			jannatSupport: { transferredAt: "2026-07-05T08:05:54.000Z" },
		},
		conversation: [
			{ isSystem: true, clientAction: "jannat_hotel_transfer", message: "transfer" },
			ai("Not available", "quote_unavailable"),
			guest(fixedDatesText),
		],
	};
	const known = {
		languageCode: "ar",
		jannatPlatformTransfer: true,
		checkinISO: "2026-07-27",
		checkoutISO: "2026-08-02",
		roomTypeKey: "doubleRooms",
		roomSelections: [{ roomTypeKey: "doubleRooms", count: 1 }],
		rooms: 1,
		adults: 2,
		quote: {
			available: false,
			checkinISO: "2026-07-27",
			checkoutISO: "2026-08-02",
			roomTypeKey: "doubleRooms",
			firstUnavailableDate: "2026-07-27",
		},
	};
	assert.strictEqual(orchestrator.latestGuestSaysDatesAreFixed(fixedDatesText), true);
	assert.strictEqual(orchestrator.jannatTransferredLeadContext(sc, known), true);
	assert.strictEqual(
		orchestrator.shouldPreserveJannatUnavailableLead(
			sc,
			known,
			fixedDatesText,
			"",
			"quote_unavailable"
		),
		true
	);
	const quickReplies = orchestrator.quoteUnavailableQuickRepliesForCase(sc, known);
	assert.strictEqual(quickReplies[0].action, "jannat_lead_review");
	const reply = orchestrator.buildJannatUnavailableLeadReviewMessage(sc, known, hotel, {
		message: fixedDatesText,
	});
	assert(reply.includes("\u0644\u0646 \u0623\u063a\u0644\u0642 \u0627\u0644\u0637\u0644\u0628"));
	assert(reply.includes("\u0641\u0631\u064a\u0642 \u062c\u0646\u0627\u062a \u0628\u0648\u0643\u064a\u0646\u062c"));
});

check("Normal hotel unavailable only recovers to Jannat when no rooms exist", () => {
	const normalHotelCase = {
		preferredLanguageCode: "ar",
		supportScope: "hotel",
		conversation: [ai("Not available", "quote_unavailable")],
	};
	const normalKnown = {
		languageCode: "ar",
		checkinISO: "2026-07-27",
		checkoutISO: "2026-08-02",
		roomTypeKey: "doubleRooms",
		quote: {
			available: false,
			checkinISO: "2026-07-27",
			checkoutISO: "2026-08-02",
			roomTypeKey: "doubleRooms",
			code: "blocked",
		},
	};
	assert.strictEqual(
		orchestrator.shouldPreserveJannatUnavailableLead(
			normalHotelCase,
			normalKnown,
			"\u0627\u0648\u0643\u064a\u0647 \u0634\u0643\u0631\u0627",
			"",
			"quote_unavailable"
		),
		false
	);
	assert.strictEqual(
		orchestrator.shouldRecoverHotelUnavailableToJannat(normalHotelCase, normalKnown, {
			available: false,
			code: "blocked",
			sameHotelHasAnyAvailability: true,
		}),
		false
	);
	assert.strictEqual(
		orchestrator.shouldRecoverHotelUnavailableToJannat(normalHotelCase, normalKnown, {
			available: false,
			code: "blocked",
			sameHotelHasAnyAvailability: false,
		}),
		true
	);
	assert(
		orchestrator
			.buildHotelUnavailableJannatTransferMessage(normalHotelCase, normalKnown, hotel)
			.includes("\u0641\u0631\u064a\u0642 \u062c\u0646\u0627\u062a \u0628\u0648\u0643\u064a\u0646\u062c")
	);
	assert.strictEqual(
		orchestrator.shouldPreserveJannatUnavailableLead(
			{ preferredLanguageCode: "ar", aiStateSnapshot: { known: { jannatPlatformTransfer: true } } },
			{ languageCode: "ar", jannatPlatformTransfer: true },
			"\u0627\u0648\u0643\u064a\u0647 \u0634\u0643\u0631\u0627",
			"",
			"quote_unavailable"
		),
		true
	);
});

console.log(`PASS ${checks} chatbot regression checks`);
