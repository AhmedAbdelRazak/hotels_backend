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
const modelConfig = require("../services/openaiModelConfig");
const nlu = require("../aiagent/core/nlu");

const hotel = {
	_id: "zad-ajyad-test",
	hotelName: "Zad Ajyad",
	hotelName_OtherLanguage: "Zad Ajyad",
	currency: "SAR",
	hasBusService: true,
	hasMealsService: false,
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

check("Chatbot brain reasoning is never demoted below medium", () => {
	const previousBooking = process.env.OPENAI_CHATBOT_BOOKING_REASONING_EFFORT;
	const previousReasoning = process.env.OPENAI_CHATBOT_REASONING_EFFORT;
	const previousNlu = process.env.OPENAI_CHATBOT_NLU_REASONING_EFFORT;
	const previousWriter = process.env.OPENAI_CHATBOT_WRITER_REASONING_EFFORT;
	const previousAnalysis = process.env.OPENAI_CHATBOT_ANALYSIS_REASONING_EFFORT;
	process.env.OPENAI_CHATBOT_BOOKING_REASONING_EFFORT = "low";
	process.env.OPENAI_CHATBOT_REASONING_EFFORT = "low";
	process.env.OPENAI_CHATBOT_NLU_REASONING_EFFORT = "low";
	process.env.OPENAI_CHATBOT_WRITER_REASONING_EFFORT = "low";
	process.env.OPENAI_CHATBOT_ANALYSIS_REASONING_EFFORT = "low";
	assert.strictEqual(modelConfig.pickReasoningEffort("reasoning"), "medium");
	assert.strictEqual(modelConfig.pickReasoningEffort("nlu"), "medium");
	assert.strictEqual(modelConfig.pickReasoningEffort("writer"), "medium");
	assert.strictEqual(modelConfig.pickReasoningEffort("analysis"), "medium");
	assert.strictEqual(modelConfig.pickReasoningEffort("default"), "medium");
	process.env.OPENAI_CHATBOT_BOOKING_REASONING_EFFORT = "high";
	assert.strictEqual(modelConfig.pickReasoningEffort("reasoning"), "high");
	if (previousBooking === undefined) delete process.env.OPENAI_CHATBOT_BOOKING_REASONING_EFFORT;
	else process.env.OPENAI_CHATBOT_BOOKING_REASONING_EFFORT = previousBooking;
	if (previousReasoning === undefined) delete process.env.OPENAI_CHATBOT_REASONING_EFFORT;
	else process.env.OPENAI_CHATBOT_REASONING_EFFORT = previousReasoning;
	if (previousNlu === undefined) delete process.env.OPENAI_CHATBOT_NLU_REASONING_EFFORT;
	else process.env.OPENAI_CHATBOT_NLU_REASONING_EFFORT = previousNlu;
	if (previousWriter === undefined) delete process.env.OPENAI_CHATBOT_WRITER_REASONING_EFFORT;
	else process.env.OPENAI_CHATBOT_WRITER_REASONING_EFFORT = previousWriter;
	if (previousAnalysis === undefined) delete process.env.OPENAI_CHATBOT_ANALYSIS_REASONING_EFFORT;
	else process.env.OPENAI_CHATBOT_ANALYSIS_REASONING_EFFORT = previousAnalysis;
});

check("Protocol JSON is never treated as raw customer-facing text", () => {
	const valid = orchestrator.sanitizeCustomerFacingProtocolText(
		'{"action":"reply","reply":"Hello from the brain"}'
	);
	assert.strictEqual(valid.text, "Hello from the brain");
	assert.strictEqual(valid.blocked, false);
	const malformed = orchestrator.sanitizeCustomerFacingProtocolText(
		'{"action":"reply","reply":"\u062a\u0645\u0627\u0645\u060c \u0641\u0647\u0645\u062a \u0623\u0646\u0643 \u062a\u0631\u064a\u062f \u0625\u0642\u0627\u0645\u0629 9 \u0644\u064a\u0627\u0644'
	);
	assert.strictEqual(malformed.blocked, true);
	assert.strictEqual(malformed.text, "");
});

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

check("Arabic child age phrasing keeps child count separate from age", () => {
	const text = "\u0634\u062e\u0635 \u0628\u0627\u0644\u063a \u0648\u0637\u0641\u0644\u064a\u0646 7 \u0633\u0646\u0648\u0627\u062a";
	assert.deepStrictEqual(
		orchestrator.sanitizeBrainFactsForLatestText(
			{ adults: 1, children: 2 },
			{},
			text
		),
		{ adults: 1, children: 2 }
	);
	assert.notStrictEqual(orchestrator.explicitGuestCountFactsFromText(text).children, 7);
});

check("Arabic children-under-age with dates ignores the age as child count", () => {
	const text =
		"\u0646\u062d\u0646 \u0664 \u0643\u0628\u0627\u0631 \u0648\u0663 \u0623\u0637\u0641\u0627\u0644 \u062a\u062d\u062a \u0661\u0662 \u0633\u0646\u0629 \u0645\u0646 \u0662\u0665 \u0623\u063a\u0633\u0637\u0633 \u0625\u0644\u0649 \u0662\u0668 \u0623\u063a\u0633\u0637\u0633";
	assert.deepStrictEqual(orchestrator.explicitGuestCountFactsFromText(text), {
		adults: 4,
		children: 3,
	});
	assert.deepStrictEqual(
		orchestrator.sanitizeBrainFactsForLatestText({ adults: 4 }, {}, text),
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

check("Arabic Levant month date range keeps checkout day-only and guest count", () => {
	const text =
		"\u0627\u0644\u062f\u062e\u0648\u0644 \u064a\u0648\u0645 \u0661\u0663 \u062a\u0645\u0648\u0632 2027 \u0648\u0627\u0644\u062e\u0631\u0648\u062c \u0662\u0660 \u0627\u0631\u0628\u0639\u0629 \u0646\u0632\u0644\u0627\u0621";
	assert.deepStrictEqual(nlu.quickDateRange(text), {
		checkinISO: "2027-07-13",
		checkoutISO: "2027-07-20",
		raw: {
			checkin: "2027-07-13",
			checkout: "2027-07-20",
			calendar: "gregorian",
		},
	});
	const known = orchestrator.recoverKnownFactsFromConversation(
		{
			preferredLanguageCode: "ar",
			conversation: [guest(text)],
		},
		{}
	);
	assert.strictEqual(known.checkinISO, "2027-07-13");
	assert.strictEqual(known.checkoutISO, "2027-07-20");
	assert.strictEqual(known.adults, 4);
});

check("Arabic slash date range with extra booking facts is parsed for quoting", () => {
	const text =
		"\u0627\u0631\u064a\u062f \u063a\u0631\u0641\u0629 \u0645\u0632\u062f\u0648\u062c\u0629 \u0645\u0646 15/12 \u0627\u0644\u0649 20/12 \u0627\u0631\u0628\u0639\u0629 \u0627\u0634\u062e\u0627\u0635";
	const dates = nlu.quickDateRange(text);
	assert.strictEqual(dates.checkinISO?.slice(5), "12-15");
	assert.strictEqual(dates.checkoutISO?.slice(5), "12-20");
	assert.strictEqual(dates.raw?.calendar, "gregorian");
	const known = orchestrator.recoverKnownFactsFromConversation(
		{
			preferredLanguageCode: "ar",
			conversation: [guest(text)],
		},
		{}
	);
	assert.strictEqual(known.checkinISO?.slice(5), "12-15");
	assert.strictEqual(known.checkoutISO?.slice(5), "12-20");
	assert.strictEqual(known.roomTypeKey, "doubleRooms");
	assert.strictEqual(known.rooms, 1);
	assert.strictEqual(known.adults, 4);
});

check("Arabic checkout-only follow-up completes separate-message stay", () => {
	const aiCheckoutAsk =
		"\u062a\u0645\u0627\u0645\u060c \u0623\u0631\u0633\u0644 \u0644\u064a \u062a\u0627\u0631\u064a\u062e \u0627\u0644\u062e\u0631\u0648\u062c \u0641\u0642\u0637.";
	assert.strictEqual(
		orchestrator.previousAiAskedForCheckoutDate({
			isAi: true,
			clientAction: "ai_reply",
			message: aiCheckoutAsk,
		}),
		true
	);
	assert.deepStrictEqual(
		orchestrator.dateBoundaryFactsFromAskedAnswer(
			"21/7",
			{ checkinISO: "2026-07-19" },
			{ isAi: true, clientAction: "ai_reply", message: aiCheckoutAsk }
		),
		{ checkoutISO: "2026-07-21", dateCalendar: "gregorian" }
	);
	const known = orchestrator.recoverKnownFactsFromConversation(
		{
			preferredLanguageCode: "ar",
			conversation: [
				guest(
					"\u0623\u0631\u064a\u062f \u0633\u0639\u0631 \u063a\u0631\u0641\u0629 \u0631\u0628\u0627\u0639\u064a\u0629 \u0644\u0623\u0631\u0628\u0639\u0629 \u0623\u0634\u062e\u0627\u0635 \u0627\u0644\u062f\u062e\u0648\u0644 19/7"
				),
				ai(aiCheckoutAsk),
				guest("21/7"),
			],
		},
		{}
	);
	assert.strictEqual(known.checkinISO, "2026-07-19");
	assert.strictEqual(known.checkoutISO, "2026-07-21");
	assert.strictEqual(known.roomTypeKey, "quadRooms");
	assert.strictEqual(known.rooms, 1);
	assert.strictEqual(known.adults, 4);
});

check("Brain acknowledged dates after price context are enough to quote", () => {
	const previousAi = ai(
		"\u0623\u0643\u064a\u062f. \u062d\u062a\u0649 \u0623\u0639\u0637\u064a\u0643 \u0633\u0639\u0631 \u0627\u0644\u063a\u0631\u0641\u0629 \u0627\u0644\u0645\u0632\u062f\u0648\u062c\u0629 \u0628\u062f\u0642\u0629\u060c \u0623\u062d\u062a\u0627\u062c \u062a\u0627\u0631\u064a\u062e \u0627\u0644\u062f\u062e\u0648\u0644 \u0648\u062a\u0627\u0631\u064a\u062e \u0627\u0644\u062e\u0631\u0648\u062c\u060c \u0648\u0643\u0645 \u0639\u062f\u062f \u0627\u0644\u0636\u064a\u0648\u0641\u061f"
	);
	const latestText =
		"\u0623\u0633\u0628\u0648\u0639 \u0645\u0646 \u0627\u0648\u0644 \u0623\u063a\u0633\u0637\u0633 \u062d\u062a\u0649 \u062e\u0645\u0633\u0629";
	const badReply =
		"\u0623\u0641\u0647\u0645 \u0623\u0646 \u0627\u0644\u0645\u0642\u0635\u0648\u062f \u0645\u0646 2026-08-01 \u0625\u0644\u0649 2026-08-05. \u0643\u0645 \u0639\u062f\u062f \u0627\u0644\u0636\u064a\u0648\u0641\u061f";
	const facts = orchestrator.dateFactsFromBrainAcknowledgedReply(
		badReply,
		latestText,
		previousAi
	);
	assert.deepStrictEqual(facts, {
		checkinISO: "2026-08-01",
		checkoutISO: "2026-08-05",
		dateCalendar: "gregorian",
	});
	const known = orchestrator.mergeKnownFacts(
		{
			languageCode: "ar",
			roomTypeKey: "doubleRooms",
			roomSelections: [{ roomTypeKey: "doubleRooms", count: 1 }],
			rooms: 1,
		},
		facts
	);
	assert.strictEqual(orchestrator.quoteInputsKnown(known), true);
	assert.strictEqual(orchestrator.requiredBookingMissing(known).includes("adults"), true);
});

check("Brain acknowledged checkin-only text cannot trigger premature quote", () => {
	const previousAi = ai(
		"\u0623\u0643\u064a\u062f. \u0623\u062d\u062a\u0627\u062c \u062a\u0627\u0631\u064a\u062e \u0627\u0644\u062f\u062e\u0648\u0644 \u0648\u062a\u0627\u0631\u064a\u062e \u0627\u0644\u062e\u0631\u0648\u062c \u0644\u0625\u0639\u0637\u0627\u0626\u0643 \u0627\u0644\u0633\u0639\u0631."
	);
	const latestText =
		"\u0623\u0631\u064a\u062f \u0633\u0639\u0631 \u063a\u0631\u0641\u0629 \u0631\u0628\u0627\u0639\u064a\u0629 \u0644\u0623\u0631\u0628\u0639\u0629 \u0623\u0634\u062e\u0627\u0635 \u0627\u0644\u062f\u062e\u0648\u0644 19/7";
	const reply =
		"\u062a\u0645\u0627\u0645\u060c \u0641\u0647\u0645\u062a \u0623\u0646 \u0627\u0644\u062f\u062e\u0648\u0644 2026-07-19. \u0623\u0631\u0633\u0644 \u0644\u064a \u062a\u0627\u0631\u064a\u062e \u0627\u0644\u062e\u0631\u0648\u062c \u0644\u0623\u0639\u0637\u064a\u0643 \u0627\u0644\u0633\u0639\u0631 \u0627\u0644\u062f\u0642\u064a\u0642.";
	assert.strictEqual(
		orchestrator.latestGuestSuppliesCheckoutBoundary(latestText, {}, previousAi),
		false
	);
	assert.strictEqual(
		orchestrator.dateFactsFromBrainAcknowledgedReply(reply, latestText, previousAi, {
			languageCode: "ar",
			roomTypeKey: "quadRooms",
			roomSelections: [{ roomTypeKey: "quadRooms", count: 1 }],
			rooms: 1,
			adults: 4,
		}),
		null
	);
	const systemHandoff = ai(
		"QA scenario Arabic separate checkout follow-up quotes after bot asks"
	);
	systemHandoff.isSystem = true;
	assert.strictEqual(
		orchestrator.latestGuestSuppliesCheckoutBoundary(latestText, {}, systemHandoff),
		false
	);
	assert.strictEqual(
		orchestrator.dateFactsFromBrainAcknowledgedReply(
			"\u062a\u0645\u0627\u0645\u060c \u0641\u0647\u0645\u062a \u0623\u0646 \u0627\u0644\u062f\u062e\u0648\u0644 2026-07-19 \u0648\u0627\u0644\u062e\u0631\u0648\u062c 2026-07-21.",
			latestText,
			systemHandoff,
			{}
		),
		null
	);
	assert.strictEqual(
		orchestrator.latestGuestSuppliesCheckoutBoundary(
			"21/7",
			{ languageCode: "ar", checkinISO: "2026-07-19" },
			ai("\u0645\u0627 \u062a\u0627\u0631\u064a\u062e \u0627\u0644\u062e\u0631\u0648\u062c\u061f")
		),
		true
	);
});

check("On-demand Arabic room comparison splits alternatives for pricing", () => {
	const text =
		"\u0639\u062f\u062f \u0627\u0644\u0636\u064a\u0648\u0641 4\n\u0646\u062d\u062a\u0627\u062c \u0625\u0644\u0649 \u063a\u0631\u0641\u062a\u064a\u0646 \u0645\u0632\u062f\u0648\u062c\u0629\n\u0623\u0648 \u063a\u0631\u0641\u0629 \u0648\u0627\u062d\u062f\u0629 \u0631\u0628\u0627\u0639\u064a\u0629";
	const options = orchestrator.roomPriceComparisonOptionsFromText(
		text,
		{
			languageCode: "ar",
			checkinISO: "2026-08-01",
			checkoutISO: "2026-08-05",
			roomSelections: [
				{ roomTypeKey: "doubleRooms", count: 2 },
				{ roomTypeKey: "quadRooms", count: 1 },
			],
			adults: 4,
		},
		ai("\u0627\u0644\u0633\u0639\u0631 \u0645\u062a\u0627\u062d\u060c \u0647\u0644 \u062a\u0641\u0636\u0644 \u062e\u064a\u0627\u0631\u0627 \u0645\u0639\u064a\u0646\u0627\u061f", "quote_ready")
	);
	assert.deepStrictEqual(options, [
		[{ roomTypeKey: "doubleRooms", count: 2 }],
		[{ roomTypeKey: "quadRooms", count: 1 }],
	]);
});

check("Same-date room comparison accepts quick-reply and typed room choices", () => {
	const known = {
		languageCode: "ar",
		checkinISO: "2026-08-01",
		checkoutISO: "2026-08-05",
		sameDateRoomOptions: [
			{
				roomTypeKey: "doubleRooms",
				roomLabel: "2 x Double Room",
				requestedRooms: 2,
				quotedRooms: 2,
				checkinISO: "2026-08-01",
				checkoutISO: "2026-08-05",
			},
			{
				roomTypeKey: "quadRooms",
				roomLabel: "1 x Quadruple Room",
				requestedRooms: 1,
				quotedRooms: 1,
				checkinISO: "2026-08-01",
				checkoutISO: "2026-08-05",
			},
		],
	};
	const previous = ai("\u0627\u062e\u062a\u0631 \u0627\u0644\u0623\u0646\u0633\u0628 \u0644\u0643.", "same_date_room_options_ready");
	const replies = orchestrator.roomOptionQuickReplies(known.sameDateRoomOptions, "ar");
	assert.strictEqual(replies.length, 2);
	assert.strictEqual(replies[0].action, "select_room_option");
	assert.strictEqual(
		orchestrator.sameDateRoomChoiceFromText(
			known,
			replies[0].value,
			"select_room_option",
			previous
		)?.roomTypeKey,
		"doubleRooms"
	);
	assert.strictEqual(
		orchestrator.sameDateRoomChoiceFromText(
			known,
			"\u0627\u062e\u062a\u0627\u0631 \u063a\u0631\u0641\u062a\u064a\u0646 \u0645\u0632\u062f\u0648\u062c\u0629",
			"",
			previous
		)?.roomTypeKey,
		"doubleRooms"
	);
	assert.strictEqual(
		orchestrator.sameDateRoomChoiceFromText(known, "Double Room", "", previous)
			?.roomTypeKey,
		"doubleRooms"
	);
	assert.strictEqual(
		orchestrator.sameDateRoomChoiceFromText(
			known,
			"\u0627\u062e\u062a\u0627\u0631 \u063a\u0631\u0641\u0629 \u0631\u0628\u0627\u0639\u064a\u0629",
			"",
			previous
		)?.roomTypeKey,
		"quadRooms"
	);
});

check("Selected same-date room option locks the final reservation room mix", () => {
	const locked = orchestrator.applySelectedSameDateRoomOptionLock({
		languageCode: "ar",
		checkinISO: "2026-08-01",
		checkoutISO: "2026-08-05",
		roomSelections: [
			{ roomTypeKey: "doubleRooms", count: 2 },
			{ roomTypeKey: "quadRooms", count: 1 },
		],
		rooms: 3,
		sameDateRoomSelectionLocked: true,
		sameDateRoomSelectedOption: {
			roomTypeKey: "doubleRooms",
			roomLabel: "2 x Double Room",
			requestedRooms: 2,
			quotedRooms: 2,
			checkinISO: "2026-08-01",
			checkoutISO: "2026-08-05",
			roomSelections: [{ roomTypeKey: "doubleRooms", count: 2 }],
		},
	});
	assert.strictEqual(locked.roomTypeKey, "doubleRooms");
	assert.strictEqual(locked.rooms, 2);
	assert.deepStrictEqual(locked.roomSelections, [
		{ roomTypeKey: "doubleRooms", count: 2 },
	]);
});

check("Human staff messages are prompt context, not guest turns", () => {
	const promptConversation = orchestrator.conversationForPrompt({
		conversation: [
			guest("\u0623\u0631\u064a\u062f \u0633\u0639\u0631 \u063a\u0631\u0641\u0629"),
			{
				isAi: false,
				isSystem: false,
				clientAction: "manual_takeover",
				message: "\u062a\u0645 \u0625\u0646\u0634\u0627\u0621 \u0627\u0644\u062d\u062c\u0632 \u064a\u062f\u0648\u064a\u0627",
				date: new Date(),
				messageBy: { customerName: "Staff", customerEmail: supportEmail, userId: "csr-1" },
			},
		],
	});
	assert.strictEqual(promptConversation[0].role, "guest");
	assert.strictEqual(promptConversation[1].role, "staff");
	assert.strictEqual(promptConversation[1].staffContext, true);
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

check("Quad Rooms 4 guest means one quad room for four adults", () => {
	const text = "29 July to 5 August\nQuad Rooms 4 guest";
	assert.strictEqual(orchestrator.roomCountOnlyFromText(text), null);
	assert.deepStrictEqual(orchestrator.explicitGuestCountFactsFromText(text), {
		adults: 4,
		children: 0,
	});
	assert.deepStrictEqual(orchestrator.extractRoomSelectionsFromText(text), [
		{ roomTypeKey: "quadRooms", count: 1 },
	]);
	const sanitized = orchestrator.sanitizeBrainFactsForLatestText(
		{
			roomTypeKey: "quadRooms",
			rooms: 4,
			adults: 4,
			children: 0,
		},
		{},
		text
	);
	assert.deepStrictEqual(sanitized.roomSelections, [
		{ roomTypeKey: "quadRooms", count: 1 },
	]);
	assert.strictEqual(sanitized.rooms, 1);
	assert.strictEqual(sanitized.adults, 4);
	assert.strictEqual(sanitized.children, 0);
});

check("ISO dates before Quad Rooms do not become room counts", () => {
	const text = "2026-07-19 to 2026-07-21\nQuad Rooms 4 guest";
	assert.strictEqual(orchestrator.roomCountOnlyFromText(text), null);
	assert.strictEqual(orchestrator.roomCountCorrectionFromText(text), null);
	assert.deepStrictEqual(orchestrator.explicitGuestCountFactsFromText(text), {
		adults: 4,
		children: 0,
	});
	assert.deepStrictEqual(orchestrator.extractRoomSelectionsFromText(text), [
		{ roomTypeKey: "quadRooms", count: 1 },
	]);
});

check("Explicit one quad room with four beds is not replanned", () => {
	const text = "No, I need only one room with 4 beds";
	const sanitized = orchestrator.sanitizeBrainFactsForLatestText(
		{
			roomSelections: [{ roomTypeKey: "familyRooms", count: 1 }],
			rooms: 2,
			requestedBeds: 4,
		},
		{
			roomSelections: [
				{ roomTypeKey: "familyRooms", count: 1 },
				{ roomTypeKey: "tripleRooms", count: 1 },
			],
			rooms: 2,
			adults: 4,
			children: 0,
		},
		text
	);
	const merged = orchestrator.mergeKnownFacts(
		{
			roomSelections: [
				{ roomTypeKey: "familyRooms", count: 1 },
				{ roomTypeKey: "tripleRooms", count: 1 },
			],
			rooms: 2,
			adults: 4,
			children: 0,
		},
		sanitized
	);
	const result = orchestrator.ensureRoomPlanForGuestCapacity(hotel, merged);
	assert.deepStrictEqual(result.known.roomSelections, [
		{ roomTypeKey: "quadRooms", count: 1 },
	]);
	assert.strictEqual(result.known.rooms, 1);
	assert.strictEqual(result.known.requestedBeds, 4);
	assert.strictEqual(result.changed, false);
});

check("Arabic suite composition is not parsed as two bookable rooms", () => {
	const text =
		"\u0627\u0644\u062c\u0646\u0627\u062d \u064a\u062d\u062a\u0648\u0649 \u0639\u0644\u0649 (\u063a\u0631\u0641\u062a\u064a\u0646 + 2 \u062d\u0645\u0627\u0645)";
	assert.strictEqual(orchestrator.roomCountOnlyFromText(text), null);
	assert.strictEqual(orchestrator.roomCountCorrectionFromText(text), null);
	assert.deepStrictEqual(orchestrator.extractRoomSelectionsFromText(text), [
		{ roomTypeKey: "suite", count: 1 },
	]);
});

check("Arabic apartment request is caught by the hotel-room clarification guard", () => {
	const text =
		"\u0647\u0644 \u0645\u062a\u0627\u062d \u0634\u0642\u0647 \u063a\u0631\u0641\u062a\u064a\u0646 \u0648\u0635\u0627\u0644\u0647 \u0648\u0634\u0642\u062a\u064a\u0646 \u063a\u0631\u0641\u0647 \u0648\u0635\u0627\u0644\u0647\u061f";
	assert.strictEqual(orchestrator.latestGuestRequestsApartmentUnit(text), true);
	assert.strictEqual(
		orchestrator.hotelOffersApartmentUnits({
			propertyType: "hotel",
			roomCountDetails: [{ roomType: "Suite" }],
		}),
		false
	);
	const reply = orchestrator.buildNoApartmentClarificationMessage(
		{ preferredLanguageCode: "ar" },
		{
			hotelName: "Zad Ajyad",
			hotelName_OtherLanguage: "\u0632\u0627\u062f \u0623\u062c\u064a\u0627\u062f",
			propertyType: "hotel",
			roomCountDetails: [{ roomType: "Suite" }],
		},
		{ languageCode: "ar" },
		text
	);
	assert.match(reply, /\u064a\u0648\u0641\u0631 \u063a\u0631\u0641\u0627 \u0641\u0646\u062f\u0642\u064a\u0629/u);
	assert.doesNotMatch(reply, /\u0634\u0642\u0629\s+\u0645\u062a\u0627\u062d/u);
});

check("Quote validation rejects hallucinated mixed room counts", () => {
	const toolResult = {
		tool: "get_quote",
		available: true,
		totalRooms: 1,
		roomSelections: [{ roomTypeKey: "quadRooms", count: 1 }],
		quote: {
			available: true,
			totalRooms: 1,
			roomSelections: [{ roomTypeKey: "quadRooms", count: 1 }],
		},
	};
	assert.strictEqual(
		orchestrator.quoteReplyRoomCountConflictsWithTool(
			"Rooms: 1 x Family Quintuple Room + 1 x Triple Room - Premium Comfort",
			toolResult
		),
		true
	);
	assert.strictEqual(
		orchestrator.quoteReplyRoomCountConflictsWithTool(
			"Rooms: 1 x Quadruple Room\nDates: 2026-07-29 to 2026-08-05",
			toolResult
		),
		false
	);
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

check("Hotel fact service answer sounds human and avoids stored-detail labels", () => {
	const latestGuest = guest("هل يوجد وسيله مواصلات من الفندق");
	const sc = {
		preferredLanguageCode: "ar",
		conversation: [latestGuest],
	};
	const known = { languageCode: "ar" };
	const reply = orchestrator.buildAuthoritativeHotelServiceFactReply(
		sc,
		hotel,
		known,
		latestGuest
	);
	assert(/نقل|باص/.test(reply));
	assert.strictEqual(orchestrator.hotelFactReplyHasRoboticSourceLabel(reply), false);
	assert.strictEqual(
		orchestrator.hotelFactReplyHasRoboticSourceLabel("التفاصيل المسجلة: test"),
		true
	);
});

check("Short Nusuk follow-up answers latest fact instead of repeating bus", () => {
	const busQuestion = guest("\u0647\u0644 \u0639\u0646\u062f\u0643\u0645 \u0623\u062a\u0648\u0628\u064a\u0633 \u0644\u0644\u062d\u0631\u0645\u061f");
	const latestGuest = guest("\u0648\u0646\u0633\u0643 \u0645\u062a\u0627\u062d\u061f");
	const sc = {
		preferredLanguageCode: "ar",
		conversation: [
			busQuestion,
			ai("\u0646\u0639\u0645\u060c \u064a\u0648\u062c\u062f \u0628\u0627\u0635.", "hotel_fact_answered"),
			latestGuest,
		],
	};
	assert.strictEqual(
		orchestrator.hotelFactQuestionForCurrentTurn(sc, latestGuest),
		"\u0648\u0646\u0633\u0643 \u0645\u062a\u0627\u062d\u061f"
	);
	const reply = orchestrator.buildAuthoritativeHotelServiceFactReply(
		sc,
		{
			...hotel,
			isNusuk: true,
			isNusukText: "\u0645\u062a\u0627\u062d \u0636\u0645\u0646 \u0628\u064a\u0627\u0646\u0627\u062a \u0627\u0644\u0641\u0646\u062f\u0642.",
		},
		{ languageCode: "ar" },
		latestGuest
	);
	assert.match(reply, /\u0646\u0633\u0643|Nusuk/i);
	assert.doesNotMatch(reply, /\u0645\u0648\u0642\u0641\s+\u0627\u0644\u0634\u0647\u062f\u0627\u0621/u);
});

check("Confirmed bus facts reject vague transport deferrals", () => {
	const latestGuest = guest("\u0639\u0646\u062f\u0643\u0645 \u0627\u0648\u062a\u0648\u0628\u064a\u0633 \u064a\u0648\u0635\u0644 \u0644\u0644\u062d\u0631\u0645");
	const vagueReply =
		"\u062e\u062f\u0645\u0629 \u0627\u0644\u0646\u0642\u0644 \u0625\u0644\u0649 \u0627\u0644\u062d\u0631\u0645 \u062a\u062e\u062a\u0644\u0641 \u062d\u0633\u0628 \u0627\u0644\u062a\u0634\u063a\u064a\u0644 \u0627\u0644\u064a\u0648\u0645\u064a. \u0623\u0631\u0633\u0644 \u0644\u064a \u062a\u0627\u0631\u064a\u062e \u0625\u0642\u0627\u0645\u062a\u0643 \u0648\u0623\u0648\u0636\u062d \u0644\u0643 \u0627\u0644\u0645\u062a\u0627\u062d.";
	const cannotConfirmReply =
		"\u0644\u0627 \u0623\u0642\u062f\u0631 \u0623\u0624\u0643\u062f \u0644\u0643 \u0648\u062c\u0648\u062f\u0647 \u0627\u0644\u0622\u0646 \u0645\u0646 \u063a\u064a\u0631 \u0627\u0644\u062a\u062d\u0642\u0642 \u0645\u0646 \u0633\u064a\u0627\u0633\u0629 \u0627\u0644\u0641\u0646\u062f\u0642 \u0627\u0644\u062d\u0627\u0644\u064a\u0629.";
	assert.strictEqual(orchestrator.replyOmitsConfirmedBusDetails(vagueReply, hotel), true);
	assert.strictEqual(orchestrator.replyDefersKnownHotelFact(cannotConfirmReply), true);
	assert.strictEqual(
		orchestrator.hotelFactReplyNeedsCorrection(
			{ action: "reply", reply: vagueReply },
			hotel,
			latestGuest
		),
		true
	);
	assert.strictEqual(
		orchestrator.hotelFactReplyNeedsCorrection(
			{ action: "reply", reply: cannotConfirmReply },
			hotel,
			latestGuest
		),
		true
	);
	const goodReply = orchestrator.buildAuthoritativeHotelServiceFactReply(
		{ preferredLanguageCode: "ar", conversation: [latestGuest] },
		hotel,
		{ languageCode: "ar" },
		latestGuest
	);
	assert(/[\u0627\u0644]*\u0634\u0647\u062f\u0627\u0621/.test(goodReply));
	assert.strictEqual(
		orchestrator.hotelFactReplyNeedsCorrection(
			{ action: "reply", reply: goodReply },
			hotel,
			latestGuest
		),
		false
	);
});

check("Confirmed Nusuk fact cannot be omitted from a compound service answer", () => {
	const latestGuest = guest(
		"\u0628\u0639\u062f \u0627\u0644\u062d\u062c\u0632\u060c \u0639\u0646\u062f\u0643\u0645 \u0628\u0627\u0635\u061f \u0648\u0646\u0633\u0643\u061f \u0648\u0627\u0644\u0644\u0648\u0643\u064a\u0634\u0646\u061f"
	);
	const nusukHotel = {
		...hotel,
		isNusuk: true,
		isNusukText: "\u0627\u0644\u0641\u0646\u062f\u0642 \u0645\u062a\u0627\u062d \u0639\u0644\u0649 \u0646\u0633\u0643.",
		distances: { walkingToElHaram: "15 minutes walking" },
		hotelAddress: "Ajyad, Makkah",
	};
	const omitted =
		"\u0646\u0639\u0645\u060c \u064a\u0648\u062c\u062f \u0628\u0627\u0635 \u0644\u0645\u0648\u0642\u0641 \u0627\u0644\u0634\u0647\u062f\u0627\u0621. \u0627\u0644\u0645\u0648\u0642\u0639 \u0642\u0631\u064a\u0628 \u0645\u0646 \u0627\u0644\u062d\u0631\u0645.";
	assert.strictEqual(orchestrator.replyOmitsConfirmedNusukFact(omitted, nusukHotel), true);
	assert.strictEqual(
		orchestrator.hotelFactReplyNeedsCorrection(
			{ action: "reply", reply: omitted },
			nusukHotel,
			latestGuest
		),
		true
	);
	const answered =
		"\u0646\u0639\u0645\u060c \u064a\u0648\u062c\u062f \u0628\u0627\u0635 \u0644\u0645\u0648\u0642\u0641 \u0627\u0644\u0634\u0647\u062f\u0627\u0621\u060c \u0648\u0627\u0644\u0641\u0646\u062f\u0642 \u0645\u062a\u0627\u062d \u0639\u0644\u0649 \u0646\u0633\u0643. \u0627\u0644\u0645\u0648\u0642\u0639 \u064a\u0628\u0639\u062f 15 \u062f\u0642\u064a\u0642\u0629 \u0645\u0634\u064a.";
	assert.strictEqual(orchestrator.replyOmitsConfirmedNusukFact(answered, nusukHotel), false);
});

check("Hotel fact replies cannot dump raw booking numbers", () => {
	assert.strictEqual(
		orchestrator.hotelFactReplyHasRawBookingNumberDump(
			"\u0648\u0644\u0644\u062a\u0623\u0643\u064a\u062f \u0639\u0644\u0649 \u062a\u0641\u0627\u0635\u064a\u0644 \u0627\u0644\u062d\u062c\u0632 \u0627\u0644\u0638\u0627\u0647\u0631\u0629 \u0644\u062f\u064a\u0643\u0645: 1\u060c 16\u060c 2026\u060c 18\u060c 2026\u060c 2\u060c 100\u060c 75\u060c 25\u060c 200\u060c 150\u060c 25.",
			{ tool: "hotel_fact" }
		),
		true
	);
	assert.strictEqual(
		orchestrator.hotelFactReplyHasRawBookingNumberDump(
			"\u0627\u0644\u063a\u0631\u0641\u0629: \u063a\u0631\u0641\u0629 \u062b\u0644\u0627\u062b\u064a\u0629\n\u0627\u0644\u062a\u0648\u0627\u0631\u064a\u062e: 2026-07-16 \u0625\u0644\u0649 2026-07-18\n\u0627\u0644\u0625\u062c\u0645\u0627\u0644\u064a: 150 \u0631\u064a\u0627\u0644",
			{ tool: "hotel_fact" }
		),
		false
	);
});

check("Meal questions stay room-only and point to nearby restaurants", () => {
	const latestGuest = guest("Do you include breakfast or meals?");
	const sc = {
		preferredLanguageCode: "en",
		conversation: [latestGuest],
	};
	const known = { languageCode: "en" };
	const reply = orchestrator.buildAuthoritativeHotelServiceFactReply(
		sc,
		hotel,
		known,
		latestGuest
	);
	assert(/room-only|not included|not provided/i.test(reply));
	assert(/restaurant|nearby/i.test(reply));
	assert.strictEqual(orchestrator.replyPromisesHotelMeals(reply), false);
	assert.strictEqual(orchestrator.replyMentionsNearbyFoodAlternative(reply), true);
	assert.strictEqual(
		orchestrator.hotelFactReplyNeedsCorrection(
			{ action: "reply", reply: "The stay is room-only, and breakfast/meals are not included or provided by the hotel." },
			hotel,
			latestGuest
		),
		true
	);
	assert.strictEqual(
		orchestrator.hotelFactReplyNeedsCorrection(
			{
				action: "reply",
				reply:
					"The stay is room-only, and breakfast/meals are not included or provided by the hotel. Nearby restaurants and services around the hotel make meals easy to arrange.",
			},
			hotel,
			latestGuest
		),
		false
	);
	assert.strictEqual(
		orchestrator.replyPromisesHotelMeals("Breakfast is included and meal service is available."),
		true
	);
	const facts = orchestrator.compactHotelFacts(hotel);
	assert(/room-only/i.test(facts.mealServiceGuidance));
});

check("Open hotel fact answer gets a light booking bridge", () => {
	const latestGuest = guest("كم يبعد الفندق عن الحرم");
	const sc = {
		preferredLanguageCode: "ar",
		conversation: [latestGuest],
	};
	assert.strictEqual(orchestrator.latestGuestLooksLikeHotelFactForBridge(latestGuest), true);
	const bridge = orchestrator.postHotelFactBookingBridge(
		sc,
		hotel,
		{ languageCode: "ar" },
		latestGuest
	);
	assert(/تاريخ الدخول|الدخول/.test(bridge));
	assert(/الخروج/.test(bridge));
	assert(/خصم/.test(bridge));
	assert(/٢٥|25/.test(bridge));
	assert(!/للحجز المباشر للحجز المباشر/.test(bridge));
	assert.strictEqual(orchestrator.hotelFactReplyAlreadyHasBookingBridge(bridge), true);
	assert.strictEqual(
		orchestrator.postHotelFactBookingBridge(
			sc,
			hotel,
			{ languageCode: "ar", confirmation: "1234567890" },
			latestGuest
		),
		""
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
	assert.strictEqual(family.capacityGuests, 5);
	assert.strictEqual(double.capacityGuests, 2);
	assert.strictEqual(family.bedsCount, 1);
	assert.strictEqual(double.bedsCount, 1);
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

check("Unavailable quote replies must clearly say unavailable or offer alternatives", () => {
	const toolResult = {
		tool: "get_quote",
		available: false,
		code: "inventory_overbook",
		inventory: { requested: 50, available: 32, shortage: 18 },
	};
	assert.strictEqual(
		orchestrator.unavailableQuoteMissingClearLanguage(
			"Confirmed availability right now is 32 of 50 family rooms.",
			toolResult
		),
		true
	);
	assert.strictEqual(
		orchestrator.unavailableQuoteMissingClearLanguage(
			"The full request is not available: only 32 of 50 family rooms are available. I can offer alternatives or adjust the room count.",
			toolResult
		),
		false
	);
});

check("Quote writer validation rejects invented money amounts and unbacked deposits", () => {
	const discount = orchestrator.quoteDiscountDisplay(
		{ total: 1050, averagePerNight: 75, currency: "SAR" },
		"en"
	);
	const toolResult = {
		tool: "get_quote",
		available: true,
		quote: {
			total: 1050,
			averagePerNight: 75,
			currency: "SAR",
			discount,
		},
		discount,
	};
	const fallback = [
		"Rate per night: " + discount.displayAveragePerNightLine,
		"Total: " + discount.displayTotalLine,
	].join("\n");
	assert.strictEqual(
		orchestrator.quoteReplyHasExtraneousMoneyAmount(
			`${fallback}\nDeposit: 50 SAR\nTotal today: 400 SAR`,
			toolResult,
			fallback
		),
		true
	);
	assert.strictEqual(
		orchestrator.quoteReplyHasExtraneousMoneyAmount(fallback, toolResult, fallback),
		false
	);
	assert.strictEqual(
		orchestrator.quoteReplyMentionsUnbackedDeposit("Deposit is 50 SAR.", toolResult),
		true
	);
});

check("Quote writer validation requires exact tool date range", () => {
	const toolResult = {
		tool: "get_quote",
		available: true,
		checkinISO: "2026-07-20",
		checkoutISO: "2026-07-22",
		quote: { checkinISO: "2026-07-20", checkoutISO: "2026-07-22" },
	};
	assert.strictEqual(
		orchestrator.quoteReplyMissingToolDates(
			"Dates: 20 July to 22 July\nTotal: 150 SAR",
			toolResult
		),
		true
	);
	assert.strictEqual(
		orchestrator.quoteReplyMissingToolDates(
			"Dates: 2026-07-20 to 2026-07-22\nTotal: 150 SAR",
			toolResult
		),
		false
	);
});

check("Official review and hotel-fact checkpoint preserve discount markup", () => {
	const known = {
		languageCode: "en",
		checkinISO: "2026-08-25",
		checkoutISO: "2026-08-28",
		roomTypeKey: "tripleRooms",
		roomSelections: [{ roomTypeKey: "tripleRooms", count: 1 }],
		rooms: 1,
		adults: 3,
		children: 0,
		fullName: "Ahmed Codex",
		phone: "0551000099",
		nationality: "Egyptian",
		quote: quoteForTriple(),
	};
	const review = orchestrator.buildReviewMessage(
		{ preferredLanguageCode: "en", displayName1: "Ahmed" },
		known,
		hotel
	);
	assert(review.includes('<s class="message-price-old">300 SAR</s>'));
	assert(review.includes('<strong class="message-price-new">225 SAR</strong>'));

	const toolResult = {
		tool: "send_review",
		code: "review_ready",
		review: {
			quote: {
				discount: orchestrator.quoteDiscountDisplay(
					{ total: 225, averagePerNight: 75, currency: "SAR" },
					"en"
				),
			},
		},
	};
	assert.strictEqual(
		orchestrator.reviewReplyMissingDiscountFormat("Total: 225 SAR", toolResult),
		true
	);
	assert.strictEqual(orchestrator.reviewReplyMissingDiscountFormat(review, toolResult), false);
	const splitPeriodDiscount = orchestrator.quoteDiscountDisplay(
		{ total: 150, averagePerNight: 0, currency: "SAR" },
		"en"
	);
	const splitTotalDiscount = orchestrator.quoteDiscountDisplay(
		{ total: 300, averagePerNight: 0, currency: "SAR" },
		"en"
	);
	const splitToolResult = {
		tool: "send_review",
		code: "review_ready",
		review: {
			discount: splitTotalDiscount,
			reservations: [
				{ discount: splitPeriodDiscount },
				{ discount: splitPeriodDiscount },
			],
		},
	};
	assert.strictEqual(
		orchestrator.reviewReplyMissingDiscountFormat("Total: 300 SAR", splitToolResult),
		true
	);
	assert.strictEqual(
		orchestrator.reviewReplyMissingDiscountFormat(
			`${splitPeriodDiscount.displayTotalLine}\n${splitPeriodDiscount.displayTotalLine}\n${splitTotalDiscount.displayTotalLine}`,
			splitToolResult
		),
		false
	);

	assert.strictEqual(
		orchestrator.hotelFactReplyAlreadyHasBookingCheckpoint(
			"Room: Triple Room\nDates: 2026-08-25 to 2026-08-28\nTotal: 225 SAR",
			known
		),
		false
	);
	assert.strictEqual(orchestrator.hotelFactReplyAlreadyHasBookingCheckpoint(review, known), true);
});

check("Official review must ask guest to confirm before booking creation", () => {
	const toolResult = {
		tool: "send_review",
		code: "review_ready",
		review: {
			fullName: "Mona Codex",
			phone: "8888888836",
			nationality: "Egyptian",
			checkinISO: "2026-08-25",
			checkoutISO: "2026-08-28",
			quote: {
				discount: orchestrator.quoteDiscountDisplay(
					{ total: 225, averagePerNight: 75, currency: "SAR" },
					"ar"
				),
			},
		},
	};
	const passive =
		"\u0645\u0631\u0627\u062c\u0639\u0629 \u0627\u0644\u062d\u062c\u0632:\n\u0627\u0644\u0627\u0633\u0645: Mona Codex\n\u0627\u0644\u0625\u062c\u0645\u0627\u0644\u064a: <s class=\"message-price-old\">300 SAR</s> <strong class=\"message-price-new\">225 SAR</strong>";
	assert.strictEqual(orchestrator.reviewReplyMissingConfirmationAsk(passive, toolResult), true);
	assert.strictEqual(
		orchestrator.reviewReplyMissingConfirmationAsk(
			`${passive}\n\u0625\u0630\u0627 \u0643\u0644 \u0634\u064a\u0621 \u0635\u062d\u064a\u062d\u060c \u0623\u0643\u062f \u0644\u064a \u0644\u0625\u062a\u0645\u0627\u0645 \u0627\u0644\u062d\u062c\u0632.`,
			toolResult
		),
		false
	);
});

check("Quote identity validator rejects room label as hotel name", () => {
	const toolResult = {
		tool: "get_quote",
		roomLabel: "Double Room – Comfort & Relaxation",
	};
	assert.strictEqual(
		orchestrator.quoteReplyUsesRoomLabelAsHotelName(
			"\u0623\u0646\u0627 \u0641\u0627\u0637\u0645\u0629 \u0645\u0646 \u0641\u0631\u064a\u0642 \u0627\u0644\u0627\u0633\u062a\u0642\u0628\u0627\u0644 \u0648\u0627\u0644\u062d\u062c\u0648\u0632\u0627\u062a \u0641\u064a Double Room \u2013 Comfort & Relaxation.\n- \u0627\u0644\u0625\u062c\u0645\u0627\u0644\u064a: 150 SAR",
			toolResult
		),
		true
	);
	assert.strictEqual(
		orchestrator.quoteReplyUsesRoomLabelAsHotelName(
			"\u0623\u0643\u064a\u062f\u060c \u0647\u0630\u0627 \u0639\u0631\u0636 \u0627\u0644\u062d\u062c\u0632:\n- \u0627\u0644\u063a\u0631\u0641\u0629: Double Room \u2013 Comfort & Relaxation",
			toolResult
		),
		false
	);
});

check("Quote replies cannot sound like premature final review", () => {
	const toolResult = {
		tool: "get_quote",
		available: true,
		discount: orchestrator.quoteDiscountDisplay(
			{ total: 150, averagePerNight: 75, currency: "SAR" },
			"ar"
		),
	};
	assert.strictEqual(
		orchestrator.quoteReplyUsesPrematureReviewLanguage(
			"\u0647\u0630\u0627 \u0645\u0644\u062e\u0635 \u0627\u0644\u062d\u062c\u0632 \u0627\u0644\u0646\u0647\u0627\u0626\u064a. \u0633\u0623\u0631\u0641\u0639 \u0627\u0644\u062d\u062c\u0632 \u0644\u0644\u0645\u0631\u0627\u062c\u0639\u0629 \u0627\u0644\u0646\u0647\u0627\u0626\u064a\u0629.",
			toolResult
		),
		true
	);
	assert.strictEqual(
		orchestrator.quoteReplyUsesPrematureReviewLanguage(
			"\u0627\u0644\u062d\u062c\u0632 \u0645\u062a\u0627\u062d\u060c \u0647\u0644 \u062a\u0631\u063a\u0628 \u0628\u0627\u0644\u0645\u062a\u0627\u0628\u0639\u0629\u061f",
			toolResult
		),
		false
	);
});

check("Date correction after quote is not treated as continuing old quote", () => {
	const previousQuote = ai("Quote ready", "quote_ready");
	assert.strictEqual(
		orchestrator.latestGuestContinuesAfterQuote(
			previousQuote,
			"\u0644\u0627\u060c \u0639\u062f\u0644 \u0627\u0644\u062f\u062e\u0648\u0644 \u0625\u0644\u0649 2026-07-18 \u0648\u0627\u0644\u062e\u0631\u0648\u062c \u0625\u0644\u0649 2026-07-20",
			""
		),
		false
	);
	assert.strictEqual(
		orchestrator.latestGuestContinuesAfterQuote(previousQuote, "Ù†Ø¹Ù… ØªØ§Ø¨Ø¹", ""),
		true
	);
});

check("Hotel fact question before continuing a quote is not swallowed as continue", () => {
	const previousQuote = ai("Quote ready", "quote_ready");
	const latest = "\u0642\u0628\u0644 \u0645\u0627 \u0623\u0643\u0645\u0644\u060c \u0647\u0644 \u0639\u0646\u062f\u0643\u0645 \u0623\u062a\u0648\u0628\u064a\u0633 \u0644\u0644\u062d\u0631\u0645\u061f";
	assert.strictEqual(orchestrator.latestGuestAsksHotelFactOnly(guest(latest)), true);
	assert.strictEqual(orchestrator.latestGuestContinuesAfterQuote(previousQuote, latest, ""), false);
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

check("Budget-only turns restore the last validated quote state", () => {
	const before = {
		checkinISO: "2026-08-25",
		checkoutISO: "2026-08-28",
		roomTypeKey: "doubleRooms",
		roomSelections: [{ roomTypeKey: "doubleRooms", count: 1 }],
		rooms: 1,
		adults: 2,
		children: 0,
		quote: {
			...quoteForTriple(),
			roomTypeKey: "doubleRooms",
			roomSelections: [{ roomTypeKey: "doubleRooms", count: 1 }],
			roomCount: 1,
			totalRooms: 1,
		},
	};
	const after = {
		...before,
		roomSelections: [{ roomTypeKey: "doubleRooms", count: 2 }],
		rooms: 2,
		quote: null,
	};
	const restored = orchestrator.restoreStaySelectionForNonStayTurn(before, after);
	assert.strictEqual(restored.rooms, 1);
	assert.strictEqual(restored.roomSelections[0].count, 1);
	assert.strictEqual(restored.quote.roomCount, 1);
});

check("Budget-only text is not treated as a stay change", () => {
	assert.strictEqual(
		orchestrator.latestGuestHasExplicitStayChangeForBudget("The price is high, any discount?"),
		false
	);
	assert.strictEqual(
		orchestrator.latestGuestHasExplicitStayChangeForBudget(
			"\u0627\u0644\u0633\u0639\u0631 \u063a\u0627\u0644\u064a \u0634\u0648\u064a\u0629\u060c \u0647\u0644 \u0641\u064a \u062e\u0635\u0645\u061f"
		),
		false
	);
	assert.strictEqual(
		orchestrator.latestGuestHasExplicitStayChangeForBudget("Make it one triple room"),
		true
	);
	assert.strictEqual(
		orchestrator.latestGuestHasExplicitStayChangeForBudget("\u063a\u0631\u0641\u0629 \u062b\u0644\u0627\u062b\u064a\u0629 \u0648\u0627\u062d\u062f\u0629"),
		true
	);
});

check("Triple-room correction can reduce ambiguous three-room request to one room", () => {
	const text = "لا، غرفة ثلاثية واحدة فقط لثلاثة أشخاص";
	assert.strictEqual(orchestrator.roomCountCorrectionFromText(text), 1);
	const selections = orchestrator.extractRoomSelectionsFromText(text);
	assert.strictEqual(selections[0]?.roomTypeKey, "tripleRooms");
	assert.strictEqual(orchestrator.roomSelectionsGuestCapacity(selections), 3);
});

check("Explicit Arabic plural family rooms are preserved before capacity planning", () => {
	const text =
		"\u0623\u0631\u064a\u062f 3 \u063a\u0631\u0641 \u0639\u0627\u0626\u0644\u064a\u0629 \u0645\u0646 2026-07-18 \u0625\u0644\u0649 2026-07-20 \u0644\u0640 6 \u0628\u0627\u0644\u063a\u064a\u0646";
	assert.deepStrictEqual(orchestrator.explicitNamedRoomSelectionsFromText(text), [
		{ roomTypeKey: "familyRooms", count: 3 },
	]);
	assert.deepStrictEqual(orchestrator.extractRoomSelectionsFromText(text), [
		{ roomTypeKey: "familyRooms", count: 3 },
	]);
	const latestGuest = guest(text);
	const hint = orchestrator.latestMessageFactsHintForPrompt({
		sc: { conversation: [latestGuest], preferredLanguageCode: "ar" },
		hotel,
		known: {},
		latestGuest,
	});
	assert.strictEqual(hint.facts.roomTypeKey, "familyRooms");
	assert.strictEqual(hint.facts.rooms, 3);
	assert.deepStrictEqual(hint.facts.roomSelections, [
		{ roomTypeKey: "familyRooms", count: 3 },
	]);
});

check("Room for people wording is not treated as room count", () => {
	assert.strictEqual(
		orchestrator.roomCountOnlyFromText("\u0627\u062d\u062c\u0632 \u063a\u0631\u0641\u0629 \u0644\u0634\u062e\u0635\u064a\u0646 \u0645\u0646 2026-07-16 \u0625\u0644\u0649 2026-07-18"),
		null
	);
	assert.strictEqual(orchestrator.roomCountOnlyFromText("2 rooms for 2 people"), 2);
});

check("Latest capacity wording cannot silently reduce explicit multi-room state", () => {
	const sanitized = orchestrator.sanitizeBrainFactsForLatestText(
		{
			roomTypeKey: "familyRooms",
			rooms: 1,
			roomSelections: [{ roomTypeKey: "familyRooms", count: 1 }],
			quote: { total: 400, averagePerNight: 75, currency: "SAR" },
		},
		{
			roomTypeKey: "tripleRooms",
			rooms: 3,
			roomSelections: [{ roomTypeKey: "tripleRooms", count: 3 }],
			adults: 6,
			children: 0,
		},
		"\u0627\u0644\u063a\u0631\u0641 \u062a\u0633\u0639 5 \u0627\u0634\u062e\u0627\u0635"
	);
	assert.strictEqual(sanitized.roomTypeKey, undefined);
	assert.strictEqual(sanitized.rooms, undefined);
	assert.deepStrictEqual(sanitized.roomSelections, undefined);
	assert.strictEqual(sanitized.quote, undefined);
});

check("Capacity follow-up is not converted into a new five-guest quote hint", () => {
	const latestGuest = guest("\u0627\u0644\u063a\u0631\u0641 \u062a\u0633\u0639 5 \u0627\u0634\u062e\u0627\u0635\u061f");
	const hint = orchestrator.latestMessageFactsHintForPrompt({
		sc: { conversation: [latestGuest], preferredLanguageCode: "ar" },
		hotel,
		known: {
			checkinISO: "2026-07-18",
			checkoutISO: "2026-07-20",
			adults: 6,
			children: 0,
			roomTypeKey: "familyRooms",
			rooms: 3,
			roomSelections: [{ roomTypeKey: "familyRooms", count: 3 }],
			quote: {
				available: true,
				checkinISO: "2026-07-18",
				checkoutISO: "2026-07-20",
				roomTypeKey: "familyRooms",
				roomSelections: [{ roomTypeKey: "familyRooms", count: 3 }],
				totalRooms: 3,
				total: 450,
				currency: "SAR",
			},
		},
		latestGuest,
	});
	assert.strictEqual(hint.recommendedAction, "");
	assert.deepStrictEqual(hint.facts, {});
});

check("Brain room facts survive Arabic room wording when local parser is quiet", () => {
	const sanitized = orchestrator.sanitizeBrainFactsForLatestText(
		{
			roomTypeKey: "familyRooms",
			rooms: 3,
			adults: 6,
			children: 0,
		},
		{},
		"\u0623\u0631\u064a\u062f 3 \u063a\u0631\u0641 \u0639\u0627\u0626\u0644\u064a\u0629 \u0645\u0646 2026-07-18 \u0625\u0644\u0649 2026-07-20 \u0644\u0640 6 \u0628\u0627\u0644\u063a\u064a\u0646"
	);
	assert.deepStrictEqual(sanitized.roomSelections, [{ roomTypeKey: "familyRooms", count: 3 }]);
	assert.strictEqual(sanitized.rooms, 3);
	assert.strictEqual(sanitized.roomTypeKey, "familyRooms");
});

check("Latest facts hint cannot override brain-provided Arabic family room selection", () => {
	const latestText =
		"\u0623\u0631\u064a\u062f 3 \u063a\u0631\u0641 \u0639\u0627\u0626\u0644\u064a\u0629 \u0645\u0646 2026-07-18 \u0625\u0644\u0649 2026-07-20 \u0644\u0640 6 \u0628\u0627\u0644\u063a\u064a\u0646";
	const mergeFacts = orchestrator.latestHintFactsForMerge(
		{
			facts: {
				checkinISO: "2026-07-18",
				checkoutISO: "2026-07-20",
				adults: 6,
				children: 0,
				roomSelections: [
					{ roomTypeKey: "doubleRooms", count: 1 },
					{ roomTypeKey: "quadRooms", count: 1 },
				],
				rooms: 2,
			},
		},
		{
			roomTypeKey: "familyRooms",
			rooms: 3,
			roomSelections: [{ roomTypeKey: "familyRooms", count: 3 }],
		},
		latestText
	);
	assert.strictEqual(mergeFacts.roomSelections, undefined);
	assert.strictEqual(mergeFacts.roomTypeKey, undefined);
	assert.strictEqual(mergeFacts.rooms, undefined);
	assert.strictEqual(mergeFacts.checkinISO, "2026-07-18");
	assert.strictEqual(mergeFacts.adults, 6);
});

check("Capacity shorthand keeps one matching room for explicit guest count", () => {
	const selections = orchestrator.extractRoomSelectionsFromText(
		"\u0646\u062d\u0646 3 \u0623\u0634\u062e\u0627\u0635 \u0648\u0646\u062d\u062a\u0627\u062c 03 \u063a\u0631\u0641\u0629 \u062b\u0644\u0627\u062b\u064a\u0629 \u0645\u0646 2026-07-16 \u0625\u0644\u0649 2026-07-18"
	);
	assert.strictEqual(selections.length, 1);
	assert.strictEqual(selections[0].roomTypeKey, "tripleRooms");
	assert.strictEqual(selections[0].count, 1);
	assert.strictEqual(orchestrator.extractRoomSelectionsFromText("3 triple rooms")[0].count, 3);
});

check("Quote reply cannot display raw shorthand room count against tool result", () => {
	const toolResult = {
		tool: "get_quote",
		available: true,
		totalRooms: 1,
		roomSelections: [{ roomTypeKey: "tripleRooms", count: 1 }],
	};
	assert.strictEqual(
		orchestrator.quoteReplyRoomCountConflictsWithTool(
			"\u062a\u0645 \u0641\u0647\u0645 \u0637\u0644\u0628\u0643\u0645: 03 \u063a\u0631\u0641\u0629 \u062b\u0644\u0627\u062b\u064a\u0629",
			toolResult
		),
		true
	);
	assert.strictEqual(
		orchestrator.quoteReplyRoomCountConflictsWithTool(
			"\u0627\u0644\u063a\u0631\u0641\u0629: \u063a\u0631\u0641\u0629 \u062b\u0644\u0627\u062b\u064a\u0629 \u0648\u0627\u062d\u062f\u0629",
			toolResult
		),
		false
	);
});

check("Date-like numbers are not recovered as guest phones", () => {
	assert.strictEqual(
		orchestrator.phoneFromIdentityText("\u0627\u0644\u062c\u0648\u0627\u0644 20260716"),
		""
	);
	assert.strictEqual(
		orchestrator.phoneFromIdentityText("\u0627\u0644\u062c\u0648\u0627\u0644 0551000007"),
		"0551000007"
	);
	const sc = {
		conversation: [
			ai(
				[
					"\u062a\u0645\u0627\u0645\u060c \u0623\u0631\u0633\u0644 \u0644\u064a \u0627\u0644\u0628\u064a\u0627\u0646\u0627\u062a \u0627\u0644\u0646\u0627\u0642\u0635\u0629:",
					"- **\u0631\u0642\u0645 \u0627\u0644\u0647\u0627\u062a\u0641:** 20260716",
				].join("\n"),
				"required_details_needed"
			),
		],
	};
	const recovered = orchestrator.recoverKnownFactsFromConversation(sc, {});
	assert.strictEqual(recovered.phone, undefined);
});

check("Arabic review extraction does not treat guest count as double-room count", () => {
	const review = ai(
		[
			"\u0627\u0644\u063a\u0631\u0641\u0629: \u063a\u0631\u0641\u0629 \u0645\u0632\u062f\u0648\u062c\u0629 \u0648\u0627\u062d\u062f\u0629",
			"\u0639\u062f\u062f \u0627\u0644\u0636\u064a\u0648\u0641: 2",
			"\u062a\u0627\u0631\u064a\u062e \u0627\u0644\u062f\u062e\u0648\u0644: 2026-07-26",
			"\u062a\u0627\u0631\u064a\u062e \u0627\u0644\u062e\u0631\u0648\u062c: 2026-07-30",
			"\u0627\u0644\u0625\u062c\u0645\u0627\u0644\u064a: 300 \u0631\u064a\u0627\u0644 \u0633\u0639\u0648\u062f\u064a",
		].join("\n"),
		"review_reservation"
	);
	const facts = orchestrator.quoteFactsFromAiMessage(review);
	assert.strictEqual(facts.roomTypeKey, "doubleRooms");
	assert.deepStrictEqual(facts.roomSelections, [{ roomTypeKey: "doubleRooms", count: 1 }]);
	assert.strictEqual(facts.rooms, 1);
});

check("Support contact number is deterministic in Arabic and English", () => {
	assert.strictEqual(orchestrator.latestGuestAsksSupportContactNumber("ممكن رقم الواتساب؟"), true);
	assert.strictEqual(orchestrator.latestGuestAsksSupportContactNumber("What is your WhatsApp number?"), true);
	assert.strictEqual(
		orchestrator.latestGuestAsksSupportContactNumber("\u0645\u0645\u0643\u0646 \u0631\u0642\u0645 \u0627\u0644\u062a\u0623\u0643\u064a\u062f\u061f"),
		false
	);
	assert.strictEqual(orchestrator.latestGuestAsksSupportContactNumber("01226500044"), false);
	const reply = orchestrator.buildSupportContactNumberMessage(
		{ preferredLanguageCode: "ar" },
		{},
		guest("ممكن رقم الواتساب؟")
	);
	assert(reply.includes("+1 (909) 222-3374"));
	assert(reply.includes("https://wa.me/19092223374"));
	const photosReply = orchestrator.buildSupportContactNumberMessage(
		{ preferredLanguageCode: "ar" },
		{},
		guest("\u0645\u0645\u0643\u0646 \u0631\u0642\u0645 \u0648\u0627\u062a\u0633\u0627\u0628 \u0648\u0635\u0648\u0631 \u0627\u0644\u063a\u0631\u0641\u061f")
	);
	assert(photosReply.includes("+1 (909) 222-3374"));
	assert(photosReply.includes("\u0635\u0648\u0631 \u0627\u0644\u063a\u0631\u0641"));
});

check("Brain escalation and arrival contract requires 909 WhatsApp contact", () => {
	const prompt = orchestrator.orchestratorContractPrompt();
	assert(prompt.includes('+1 (909) 222-3374'));
	assert(prompt.includes("https://wa.me/19092223374"));
	assert(prompt.includes('action="escalate"'));
	assert(/arrival coordination/i.test(prompt));
	assert(/4:00 AM/i.test(prompt));
});

check("Human escalation contact tool facts expose exact 909 phone and WhatsApp", () => {
	const toolResult = orchestrator.humanEscalationContactToolResult(
		"guest_requested_human",
		"I will ask the team to help."
	);
	assert.strictEqual(toolResult.tool, "human_escalation_contact");
	assert.strictEqual(toolResult.contactPhone, "+1 (909) 222-3374");
	assert.strictEqual(toolResult.whatsapp, "https://wa.me/19092223374");
	assert(toolResult.instruction.includes("OpenAI"));
	assert(toolResult.instruction.includes("contactPhone"));
	assert(toolResult.brainDraftReply.includes("team"));
});

check("Human escalation fallback wording includes 909 phone and WhatsApp", () => {
	const english = orchestrator.buildHumanEscalationContactMessage(
		{ preferredLanguageCode: "en", displayName1: "Aisha" },
		{},
		guest("Can I speak to a human?")
	);
	assert(english.includes("+1 (909) 222-3374"));
	assert(english.includes("https://wa.me/19092223374"));
	assert(/team member|team/i.test(english));
	const arabic = orchestrator.buildHumanEscalationContactMessage(
		{ preferredLanguageCode: "ar", displayName1: "Ahmed" },
		{},
		guest("\u0627\u062d\u062a\u0627\u062c \u0627\u0643\u0644\u0645 \u0645\u0648\u0638\u0641")
	);
	assert(arabic.includes("+1 (909) 222-3374"));
	assert(arabic.includes("https://wa.me/19092223374"));
});

check("Hotel facts expose human support contact for arrival coordination", () => {
	const facts = orchestrator.compactHotelFacts(hotel);
	assert.strictEqual(facts.serviceFacts.humanSupportContact.contactPhone, "+1 (909) 222-3374");
	assert.strictEqual(facts.serviceFacts.humanSupportContact.whatsapp, "https://wa.me/19092223374");
	assert.strictEqual(facts.serviceFacts.arrivalCoordination.contactPhone, "+1 (909) 222-3374");
	assert(/early arrival|late arrival|operational timing/i.test(facts.serviceFacts.arrivalCoordination.guidance));
});

check("Post-confirmation pay-at-hotel questions get a clear confirmation answer", () => {
	assert.strictEqual(
		orchestrator.latestGuestAsksPayAtHotel("\u064a\u0646\u0641\u0639 \u0627\u062f\u0641\u0639 \u0641\u064a \u0627\u0644\u0641\u0646\u062f\u0642\u061f"),
		true
	);
	const liveQuestion = "\u0647\u0644 \u064a\u0645\u0643\u0646 \u0627\u0644\u062f\u0641\u0639 \u0639\u0646\u062f \u0627\u0644\u0648\u0635\u0648\u0644";
	const liveBadReply =
		"\u0623\u0633\u062a\u0627\u0630 \u0623\u062d\u0645\u062f\u060c \u0627\u0644\u0645\u062a\u0627\u062d \u0644\u064a \u062d\u0627\u0644\u064a\u0627 \u0647\u0648 \u0627\u0644\u062f\u0641\u0639 \u0639\u0628\u0631 \u0631\u0627\u0628\u0637 \u0627\u0644\u062f\u0641\u0639 \u0627\u0644\u062e\u0627\u0635 \u0628\u0627\u0644\u062d\u062c\u0632. \u0644\u0627 \u0623\u0633\u062a\u0637\u064a\u0639 \u062a\u0623\u0643\u064a\u062f \u0627\u0644\u062f\u0641\u0639 \u0639\u0646\u062f \u0627\u0644\u0648\u0635\u0648\u0644 \u0645\u0646 \u062f\u0627\u062e\u0644 \u0627\u0644\u0645\u062d\u0627\u062f\u062b\u0629.";
	assert.strictEqual(orchestrator.latestGuestAsksPayAtHotel(liveQuestion), true);
	assert.strictEqual(orchestrator.replyContradictsPayAtHotelPolicy(liveBadReply), true);
	assert.strictEqual(
		orchestrator.paymentAtHotelReplyNeedsCorrection(
			{ action: "reply", reply: liveBadReply },
			guest(liveQuestion)
		),
		true
	);
	assert.strictEqual(
		orchestrator.paymentAtHotelReplyNeedsCorrection({ action: "get_quote", reply: "" }, guest(liveQuestion)),
		true
	);
	const tooLightConfirmedReply =
		"\u0646\u0639\u0645\u060c \u064a\u0645\u0643\u0646 \u0627\u0644\u062f\u0641\u0639 \u0641\u064a \u0627\u0644\u0641\u0646\u062f\u0642 \u0639\u0646\u062f \u0627\u0644\u0648\u0635\u0648\u0644. \u0646\u0646\u0635\u062d \u0628\u0631\u0627\u0628\u0637 \u0627\u0644\u062f\u0641\u0639 \u0625\u0630\u0627 \u0643\u0627\u0646 \u0623\u0646\u0633\u0628 \u0644\u0643.";
	assert.strictEqual(
		orchestrator.paymentAtHotelReplyNeedsCorrection(
			{ action: "reply", reply: tooLightConfirmedReply },
			guest(liveQuestion),
			{ confirmation: "2544466389", reservationAlreadyConfirmed: true }
		),
		true
	);
	const tooLightNoPaymentLink =
		"\u0646\u0639\u0645\u060c \u064a\u0645\u0643\u0646 \u0627\u0644\u062f\u0641\u0639 \u0641\u064a \u0627\u0644\u0641\u0646\u062f\u0642 \u0639\u0646\u062f \u0627\u0644\u0648\u0635\u0648\u0644. \u0631\u0642\u0645 \u0627\u0644\u062a\u0623\u0643\u064a\u062f: 2544466389. \u0627\u0644\u062d\u062c\u0632 \u064a\u0638\u0644 \u0642\u0627\u0626\u0645\u0627.";
	assert.strictEqual(
		orchestrator.paymentAtHotelReplyNeedsCorrection(
			{ action: "reply", reply: tooLightNoPaymentLink },
			guest(liveQuestion),
			{ confirmation: "2544466389", reservationAlreadyConfirmed: true }
		),
		true
	);
	const reply = orchestrator.buildPostConfirmationPayAtHotelMessage(
		{
			clientName: "Shaimaa Elsherif",
			preferredLanguageCode: "ar",
			conversation: [
				ai(
					"\u062a\u0645 \u062a\u0623\u0643\u064a\u062f \u0627\u0644\u062d\u062c\u0632 \u0628\u0646\u062c\u0627\u062d. \u0631\u0642\u0645 \u0627\u0644\u062a\u0623\u0643\u064a\u062f: 2544466389.",
					"reservation_confirmed"
				),
			],
		},
		{ languageCode: "ar" },
		guest("\u064a\u0646\u0641\u0639 \u0627\u062f\u0641\u0639 \u0641\u064a \u0627\u0644\u0641\u0646\u062f\u0642\u061f")
	);
	assert(reply.includes("2544466389"));
	assert(reply.includes("\u064a\u0645\u0643\u0646 \u0627\u0644\u062f\u0641\u0639 \u0641\u064a \u0627\u0644\u0641\u0646\u062f\u0642"));
	assert(reply.includes("\u0631\u0627\u0628\u0637 \u0627\u0644\u062f\u0641\u0639"));
	assert(reply.includes("\u0639\u0631\u0628\u0648\u0646"));
	assert(reply.includes("\u062c\u062f\u064a\u0629 \u0627\u0644\u062d\u0636\u0648\u0631"));
	assert(reply.includes("\u0627\u0644\u062d\u062c\u0632 \u064a\u0638\u0644 \u0642\u0627\u0626\u0645"));
	assert(!/\u063a\u0627\u0644\u0628(?:\u0627|\u064b)/u.test(reply));
	assert.strictEqual(
		orchestrator.paymentAtHotelReplyNeedsCorrection(
			{ action: "reply", reply },
			guest(liveQuestion),
			{ confirmation: "2544466389", reservationAlreadyConfirmed: true }
		),
		false
	);
});

check("Repeated AI wording is detected before sending robotic replies", () => {
	const previous =
		"نعم يا ضيفنا العزيز، يوجد خدمة نقل حسب بيانات فندق زاد أجياد. يوفر الفندق باصًا خاصًا لنقل الضيوف إلى موقف الشهداء.";
	const candidate =
		"نعم يا ضيفنا العزيز، يوجد خدمة نقل حسب بيانات فندق زاد أجياد. يوفر الفندق باصًا خاصًا لنقل الضيوف إلى موقف الشهداء.";
	const fresh =
		"نعم، يوجد باص للفندق يساعد الضيوف في الوصول إلى موقف الشهداء، وأقدر أراجع لك السعر والتوفر إذا أرسلت التواريخ.";
	const sc = {
		conversation: [
			ai(previous, "hotel_fact_answered"),
			guest("هل يوجد وسيلة مواصلات من الفندق؟"),
		],
	};
	const latestGuest = sc.conversation[1];
	assert.strictEqual(orchestrator.replyTooSimilarToRecentAi(sc, candidate, latestGuest), true);
	assert.strictEqual(orchestrator.replyTooSimilarToRecentAi(sc, fresh, latestGuest), false);
});

check("Emoji replies are rejected for professional chatbot tone", () => {
	assert.strictEqual(orchestrator.replyContainsEmoji("\u0623\u0643\u064a\u062f \u064a\u0627 \u0636\u064a\u0641\u0646\u0627 \u0627\u0644\u0639\u0632\u064a\u0632 \ud83c\udf37"), true);
	assert.strictEqual(orchestrator.replyContainsEmoji("\u0623\u0643\u064a\u062f \u064a\u0627 \u0636\u064a\u0641\u0646\u0627 \u0627\u0644\u0639\u0632\u064a\u0632."), false);
	assert.strictEqual(
		orchestrator.stripReplyEmoji("\u0627\u0644\u0639\u0641\u0648 \u064a\u0627 \u0636\u064a\u0641\u0646\u0627 \u0627\u0644\u0639\u0632\u064a\u0632 \ud83c\udf37"),
		"\u0627\u0644\u0639\u0641\u0648 \u064a\u0627 \u0636\u064a\u0641\u0646\u0627 \u0627\u0644\u0639\u0632\u064a\u0632"
	);
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

check("Guest address keeps titles and smart gendered Arabic address", () => {
	assert.strictEqual(
		orchestrator.guestAddressForPrompt(
			{ clientName: "Dr. Ahmed Fawzy", preferredLanguageCode: "ar" },
			{ languageCode: "ar" }
		),
		"دكتور أحمد"
	);
	assert.strictEqual(
		orchestrator.guestAddressForPrompt(
			{ clientName: "Shaimaa Elsherif", preferredLanguageCode: "ar" },
			{ languageCode: "ar" }
		),
		"أستاذة شيماء"
	);
	assert.strictEqual(
		orchestrator.guestAddressForPrompt(
			{ clientName: "Dr. Ahmed Fawzy", preferredLanguageCode: "en" },
			{ languageCode: "en" }
		),
		"Dr. Ahmed"
	);
	assert.strictEqual(
		orchestrator.guestAddressForPrompt(
			{ clientName: "Codex QA 08", preferredLanguageCode: "ar" },
			{ languageCode: "ar" }
		),
		"ضيفنا العزيز"
	);
	assert.strictEqual(
		orchestrator.guestAddressForPrompt(
			{ clientName: "Shaimaa Elsherif", preferredLanguageCode: "ar" },
			{ languageCode: "ar", fullName: "Ahmed Codex" },
			"الاسم أحمد كودكس والجوال 0551000008 والجنسية مصري"
		),
		"أستاذة شيماء"
	);
	assert.strictEqual(
		orchestrator.guestAddressForPrompt(
			{ clientName: "Dr. Ahmed Fawzy", preferredLanguageCode: "en" },
			{ languageCode: "en", fullName: "Khaled Reservation" },
			"booking name is Khaled Reservation"
		),
		"Dr. Ahmed"
	);
});

check("Profile display name is not silently used as booking full name", () => {
	const recovered = orchestrator.recoverKnownFactsFromConversation(
		{
			clientName: "Shaimaa Elsherif",
			preferredLanguageCode: "ar",
			conversation: [],
		},
		{ languageCode: "ar" }
	);
	assert.strictEqual(recovered.fullName, undefined);
	assert.strictEqual(
		orchestrator.guestAddressForPrompt(
			{ clientName: "Shaimaa Elsherif", preferredLanguageCode: "ar" },
			recovered
		),
		"\u0623\u0633\u062a\u0627\u0630\u0629 \u0634\u064a\u0645\u0627\u0621"
	);
});

check("Official review addresses chat guest when booking holder differs", () => {
	const sc = {
		clientName: "Shaimaa Elsherif",
		preferredLanguageCode: "en",
		conversation: [],
	};
	const known = { languageCode: "en", fullName: "Khaled Codex" };
	const toolResult = {
		tool: "send_review",
		code: "review_ready",
		review: { fullName: "Khaled Codex" },
		chatGuest: {
			address: "\u0623\u0633\u062a\u0627\u0630\u0629 \u0634\u064a\u0645\u0627\u0621",
			addressName: "\u0634\u064a\u0645\u0627\u0621",
			profileName: "Shaimaa Elsherif",
			differsFromBookingHolder: true,
		},
	};
	assert.strictEqual(
		orchestrator.reviewReplyNeedsChatGuestAddress(
			"Dear Khaled, here is the official review.\nName: Khaled Codex",
			sc,
			known,
			toolResult,
			null
		),
		true
	);
	assert.strictEqual(
		orchestrator.reviewReplyNeedsChatGuestAddress(
			"Dear Shaimaa, here is the official review.\nBooking name: Khaled Codex",
			sc,
			known,
			toolResult,
			null
		),
		false
	);
	assert.strictEqual(
		orchestrator.reviewReplyNeedsChatGuestAddress(
			"\u062a\u0645\u0627\u0645\u060c \u0647\u0630\u0647 \u0645\u0631\u0627\u062c\u0639\u0629 \u0627\u0644\u062d\u062c\u0632:\n\u0627\u0644\u0627\u0633\u0645: Khaled Codex",
			{ ...sc, preferredLanguageCode: "ar" },
			{ ...known, languageCode: "ar" },
			toolResult,
			null
		),
		true
	);
	assert.strictEqual(
		orchestrator.reviewReplyNeedsChatGuestAddress(
			"\u0623\u0633\u062a\u0627\u0630\u0629 \u0634\u064a\u0645\u0627\u0621\u060c \u0647\u0630\u0647 \u0645\u0631\u0627\u062c\u0639\u0629 \u0627\u0644\u062d\u062c\u0632:\n\u0627\u0644\u0627\u0633\u0645: Khaled Codex",
			{ ...sc, preferredLanguageCode: "ar" },
			{ ...known, languageCode: "ar" },
			toolResult,
			null
		),
		false
	);
});

check("Official review with tool facts is not blocked as vague progress", () => {
	const toolResult = {
		tool: "send_review",
		code: "review_ready",
		review: {
			checkinISO: "2026-07-18",
			checkoutISO: "2026-07-20",
			fullName: "Omar Codex",
			phone: "0551000099",
			nationality: "Egyptian",
			adults: 2,
			quote: { total: 150, currency: "SAR" },
		},
	};
	const reply = [
		"Dear Omar, here is the official booking review:",
		"Booking name: Omar Codex",
		"Phone: 0551000099",
		"Nationality: Egyptian",
		"Dates: 2026-07-18 to 2026-07-20",
		"Guests: 2 adults",
		"Total: 150 SAR",
		"After you confirm, I will complete the booking.",
	].join("\n");
	assert.strictEqual(orchestrator.replyPromisesProgressWithoutAction(reply), true);
	assert.strictEqual(orchestrator.reviewReplyHasOfficialToolFacts(reply, toolResult), true);
	assert.strictEqual(orchestrator.reviewReplyMissingBookingIdentity(reply, toolResult), false);
	assert.strictEqual(
		orchestrator.reviewReplyHasOfficialToolFacts(
			"I will continue with the same booking details now.",
			toolResult
		),
		false
	);
	assert.strictEqual(
		orchestrator.reviewReplyMissingBookingIdentity(
			[
				"Here is the official booking review:",
				"Phone: 0551000099",
				"Nationality: Egyptian",
				"Dates: 2026-07-18 to 2026-07-20",
				"Guests: 2 adults",
				"Total: 150 SAR",
			].join("\n"),
			toolResult
		),
		true
	);
});

check("Arabic optional email skip is persisted before official review", () => {
	const skipText = "\u0627\u0644\u0645\u062a\u0627\u0628\u0639\u0629 \u0628\u062f\u0648\u0646 \u0628\u0631\u064a\u062f";
	const known = {
		languageCode: "ar",
		checkinISO: "2026-07-19",
		checkoutISO: "2026-07-21",
		roomTypeKey: "doubleRooms",
		roomSelections: [{ roomTypeKey: "doubleRooms", count: 1 }],
		rooms: 1,
		adults: 2,
		children: 0,
		fullName: "\u0645\u0646\u0649 \u0643\u0648\u062f\u0643\u0633",
		phone: "0557380036",
		nationality: "\u0645\u0635\u0631\u064a",
		quote: {
			available: true,
			checkinISO: "2026-07-19",
			checkoutISO: "2026-07-21",
			roomTypeKey: "doubleRooms",
			roomSelections: [{ roomTypeKey: "doubleRooms", count: 1 }],
			totalRooms: 1,
			nights: 2,
			total: 150,
			currency: "SAR",
		},
	};
	assert.strictEqual(orchestrator.guestDeclinesOptionalEmail(skipText, ""), true);
	const facts = orchestrator.sanitizeBrainFactsForLatestText(
		{ emailSkipped: true, email: "" },
		known,
		skipText
	);
	const merged = orchestrator.mergeKnownFacts(known, facts);
	assert.strictEqual(merged.emailSkipped, true);
	assert.strictEqual(merged.email || "", "");
	assert.strictEqual(orchestrator.requiredBookingMissing(merged).length, 0);
	assert.strictEqual(orchestrator.shouldOfferOptionalEmail({}, merged), false);
});

check("Conditional review wording is not treated as already confirmed", () => {
	assert.strictEqual(
		orchestrator.reviewReplyClaimsBookingConfirmed(
			"Your booking is not confirmed yet. After you confirm this review, I will create the reservation."
		),
		false
	);
	assert.strictEqual(
		orchestrator.reviewReplyClaimsBookingConfirmed(
			"\u0627\u0644\u062d\u062c\u0632 \u063a\u064a\u0631 \u0645\u0624\u0643\u062f \u0628\u0639\u062f\u060c \u0648\u0628\u0639\u062f \u062a\u0623\u0643\u064a\u062f\u0643 \u0644\u0644\u062a\u0641\u0627\u0635\u064a\u0644 \u0633\u064a\u062a\u0645 \u0625\u0646\u0634\u0627\u0621 \u0627\u0644\u062d\u062c\u0632."
		),
		false
	);
	assert.strictEqual(
		orchestrator.reviewReplyClaimsBookingConfirmed("Your booking is confirmed."),
		true
	);
	assert.strictEqual(
		orchestrator.reviewReplyClaimsBookingConfirmed(
			"\u062a\u0645 \u062a\u0623\u0643\u064a\u062f \u0627\u0644\u062d\u062c\u0632"
		),
		true
	);
});

check("Arabic issue-booking confirmation invite is treated as official review handoff", () => {
	assert.strictEqual(
		orchestrator.replyInvitesConfirmationAction(
			"\u062a\u0645\u0627\u0645 \u064a\u0627 \u0623\u0633\u062a\u0627\u0630 \u064a\u0627\u0633\u0631\u060c \u062a\u0645 \u0627\u0633\u062a\u0644\u0627\u0645 \u0627\u0644\u0627\u0633\u0645 \u0648\u0627\u0644\u062c\u0648\u0627\u0644 \u0648\u0627\u0644\u062c\u0646\u0633\u064a\u0629. \u0647\u0644 \u062a\u0624\u0643\u062f \u0627\u0644\u0645\u0636\u064a \u0641\u064a \u0625\u0635\u062f\u0627\u0631 \u0627\u0644\u062d\u062c\u0632\u061f"
		),
		true
	);
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

check("Identity details cannot introduce fake split-stay periods", () => {
	const facts = orchestrator.sanitizeBrainFactsForLatestText(
		{
			fullName: "\u0623\u062d\u0645\u062f \u0643\u0648\u062f\u0643\u0633",
			phone: "0557850008",
			nationality: "\u0645\u0635\u0631\u064a",
			splitStayPeriods: [
				{ checkinISO: "2026-07-16", checkoutISO: "2026-07-18" },
				{ checkinISO: "2026-07-16", checkoutISO: "2026-07-18" },
			],
		},
		{},
		"\u0627\u0644\u0627\u0633\u0645 \u0623\u062d\u0645\u062f \u0643\u0648\u062f\u0643\u0633 \u0648\u0627\u0644\u062c\u0648\u0627\u0644 0557850008 \u0648\u0627\u0644\u062c\u0646\u0633\u064a\u0629 \u0645\u0635\u0631\u064a",
		{}
	);
	assert.strictEqual(facts.splitStayPeriods, undefined);
});

check("Brain-provided split-stay periods survive ISO same-hotel request", () => {
	const latestText =
		"\u0623\u0631\u064a\u062f \u062d\u062c\u0632\u064a\u0646 \u0645\u0646\u0641\u0635\u0644\u064a\u0646 \u0641\u064a \u0646\u0641\u0633 \u0627\u0644\u0641\u0646\u062f\u0642: \u063a\u0631\u0641\u0629 \u0644\u0634\u062e\u0635\u064a\u0646 \u0645\u0646 2026-07-16 \u0625\u0644\u0649 2026-07-18\u060c \u0648\u063a\u0631\u0641\u0629 \u0644\u0634\u062e\u0635\u064a\u0646 \u0645\u0646 2026-07-20 \u0625\u0644\u0649 2026-07-22";
	const facts = orchestrator.sanitizeBrainFactsForLatestText(
		{
			roomTypeKey: "doubleRooms",
			rooms: 2,
			adults: 2,
			splitStayPeriods: [
				{ checkinISO: "2026-07-16", checkoutISO: "2026-07-18" },
				{ checkinISO: "2026-07-20", checkoutISO: "2026-07-22" },
			],
		},
		{},
		latestText,
		{ action: "get_quote" }
	);
	assert.strictEqual(orchestrator.brainSplitStayPeriodsGroundedInLatestText(latestText, facts.splitStayPeriods), true);
	assert.strictEqual(facts.splitStayPeriods.length, 2);
	assert.strictEqual(facts.splitStayPeriods[0].checkinISO, "2026-07-16");
	assert.strictEqual(facts.splitStayPeriods[1].checkoutISO, "2026-07-22");
});

check("Split-stay one-room periods do not get quoted as rooms per period", () => {
	const latestText =
		"\u0623\u0631\u064a\u062f \u062d\u062c\u0632\u064a\u0646 \u0645\u0646\u0641\u0635\u0644\u064a\u0646 \u0641\u064a \u0646\u0641\u0633 \u0627\u0644\u0641\u0646\u062f\u0642: \u063a\u0631\u0641\u0629 \u0644\u0634\u062e\u0635\u064a\u0646 \u0645\u0646 2026-07-16 \u0625\u0644\u0649 2026-07-18\u060c \u0648\u063a\u0631\u0641\u0629 \u0644\u0634\u062e\u0635\u064a\u0646 \u0645\u0646 2026-07-20 \u0625\u0644\u0649 2026-07-22";
	const facts = orchestrator.sanitizeBrainFactsForLatestText(
		{
			roomTypeKey: "doubleRooms",
			rooms: 2,
			roomSelections: [{ roomTypeKey: "doubleRooms", count: 2 }],
			adults: 2,
			splitStayPeriods: [
				{ checkinISO: "2026-07-16", checkoutISO: "2026-07-18" },
				{ checkinISO: "2026-07-20", checkoutISO: "2026-07-22" },
			],
		},
		{},
		latestText,
		{ action: "get_quote" }
	);
	assert.strictEqual(orchestrator.latestTextSuggestsOneRoomPerSplitPeriod(latestText), true);
	assert.strictEqual(facts.rooms, 1);
	assert.deepStrictEqual(facts.roomSelections, [{ roomTypeKey: "doubleRooms", count: 1 }]);
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

check("Reservation confirmations expose exact lines for the brain to copy", () => {
	const lines = orchestrator.reservationConfirmationRequiredLines({
		tool: "submit_reservation",
		ok: true,
		code: "split_stay_reservations_created",
		reservations: [
			{
				confirmation: "JB-111",
				links: {
					reservationConfirmation: "https://example.com/details/111",
					payment: "https://example.com/pay/111",
				},
			},
			{
				confirmation: "JB-222",
				links: {
					reservationConfirmation: "https://example.com/details/222",
					payment: "https://example.com/pay/222",
				},
			},
		],
	});
	assert.deepStrictEqual(lines, [
		"Reservation 1 confirmation: JB-111",
		"Reservation 1 details link: https://example.com/details/111",
		"Reservation 1 payment link: https://example.com/pay/111",
		"Reservation 2 confirmation: JB-222",
		"Reservation 2 details link: https://example.com/details/222",
		"Reservation 2 payment link: https://example.com/pay/222",
	]);
});

check("Arabic free-text official review confirmation triggers submit intent", () => {
	const submitText = "\u0625\u062a\u0645\u0627\u0645 \u0627\u0644\u062d\u062c\u0632";
	const mojibakeSubmitText = Buffer.from(submitText, "utf8").toString("latin1");
	assert.strictEqual(orchestrator.repairMojibakeText(mojibakeSubmitText), submitText);
	assert.strictEqual(orchestrator.guestConfirms(mojibakeSubmitText, ""), true);
	assert.strictEqual(orchestrator.guestExplicitlyRequestsBookingSubmit(submitText, ""), true);
	assert.strictEqual(orchestrator.guestExplicitlyRequestsBookingSubmit("\u0646\u0639\u0645 \u062a\u0627\u0628\u0639", ""), false);
	assert.strictEqual(
		orchestrator.guestPressedOfficialReviewConfirmation(
			guest(submitText),
			ai("review", "review_reservation")
		),
		true
	);
	assert.strictEqual(
		orchestrator.guestPressedOfficialReviewConfirmation(
			guest(mojibakeSubmitText),
			ai("review", "review_reservation")
		),
		true
	);
	assert.strictEqual(
		orchestrator.guestConfirmedAfterLatestReview({
			conversation: [
				ai("review", "review_reservation"),
				guest(mojibakeSubmitText),
			],
		}),
		true
	);
	assert.strictEqual(orchestrator.knownHasCreatedReservation({ confirmation: "JB-FAKE" }), false);
	assert.strictEqual(orchestrator.knownHasCreatedReservation({ reservationId: "abc123" }), true);
	assert.strictEqual(
		orchestrator.guestPressedOfficialReviewConfirmation(
			guest(submitText),
			ai("quote", "quote_ready")
		),
		false
	);
	const untaggedArabicReview = [
		"\u0645\u0631\u0627\u062c\u0639\u0629 \u0627\u0644\u062d\u062c\u0632 \u0642\u0628\u0644 \u0625\u062a\u0645\u0627\u0645 \u0627\u0644\u062d\u062c\u0632:",
		"\u0627\u0644\u0627\u0633\u0645: \u062e\u0627\u0644\u062f \u0643\u0648\u062f\u0643\u0633",
		"\u0627\u0644\u062c\u0648\u0627\u0644: 0551234567",
		"\u0627\u0644\u062c\u0646\u0633\u064a\u0629: \u0645\u0635\u0631\u064a",
		"\u062a\u0627\u0631\u064a\u062e \u0627\u0644\u0648\u0635\u0648\u0644: 2026-07-19",
		"\u062a\u0627\u0631\u064a\u062e \u0627\u0644\u0645\u063a\u0627\u062f\u0631\u0629: 2026-07-21",
		"\u0627\u0644\u063a\u0631\u0641\u0629: \u063a\u0631\u0641\u0629 \u0645\u0632\u062f\u0648\u062c\u0629",
		"\u0627\u0644\u0636\u064a\u0648\u0641: 2",
		"\u0627\u0644\u0625\u062c\u0645\u0627\u0644\u064a: 150 \u0631\u064a\u0627\u0644",
		"\u0625\u0630\u0627 \u0627\u0644\u062a\u0641\u0627\u0635\u064a\u0644 \u0635\u062d\u064a\u062d\u0629\u060c \u0623\u0631\u0633\u0644 \u0625\u062a\u0645\u0627\u0645 \u0627\u0644\u062d\u062c\u0632.",
	].join("\n");
	assert.strictEqual(orchestrator.arabicReplyLooksLikeManualBookingReview(untaggedArabicReview), true);
	assert.strictEqual(
		orchestrator.previousAiLooksLikeOfficialReviewForSubmit(
			{ conversation: [ai(untaggedArabicReview, "reply"), guest(submitText)] },
			guest(submitText),
			ai(untaggedArabicReview, "reply")
		),
		true
	);
	assert.strictEqual(
		orchestrator.previousAiLooksLikeOfficialReviewForSubmit(
			{ conversation: [ai("\u0627\u0644\u0633\u0639\u0631 150 \u0631\u064a\u0627\u0644", "quote_ready"), guest(submitText)] },
			guest(submitText),
			ai("\u0627\u0644\u0633\u0639\u0631 150 \u0631\u064a\u0627\u0644", "quote_ready")
		),
		false
	);
});

check("Arabic review confirmation is detected from conversation memory", () => {
	assert.strictEqual(
		orchestrator.guestConfirmedAfterLatestReview({
			conversation: [
				guest("\u0628\u062f\u0648\u0646 \u0628\u0631\u064a\u062f"),
				ai("review", "review_reservation"),
				guest("\u0625\u062a\u0645\u0627\u0645 \u0627\u0644\u062d\u062c\u0632"),
			],
		}),
		true
	);
	assert.strictEqual(
		orchestrator.guestConfirmedAfterLatestReview({
			conversation: [
				ai("review", "review_reservation"),
				guest("\u0625\u062a\u0645\u0627\u0645 \u0627\u0644\u062d\u062c\u0632"),
				ai("confirmed", "reservation_confirmed"),
				guest("\u0645\u0645\u0643\u0646 \u0631\u0642\u0645 \u0648\u0627\u062a\u0633\u0627\u0628\u061f"),
			],
		}),
		false
	);
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

check("Jannat support brain sees contact-page reservation reference details", () => {
	const sc = {
		preferredLanguageCode: "ar",
		sourceWebsite: "jannatbooking_ssr",
		sourcePage: "contact_page",
		sourceUrl: "https://jannatbooking.com/contact?lang=ar",
		conversation: [
			{
				isAi: false,
				isSystem: true,
				message: "Jannat Booking support will be with you shortly.",
				inquiryAbout: "room_availability",
				inquiryDetails:
					"[Source: Jannat Booking contact page]\n[Reservation Reference: 8602335422]\nThe guest says the reservation page shows 22 to 26 but requested 23 to 27.",
				date: new Date(),
				messageBy: { customerName: "Jannat Booking", customerEmail: supportEmail },
			},
			guest("Please correct the reservation dates from 22-26 to 23-27."),
		],
	};
	const compact = jannatBrain.compactConversation(sc);
	assert(compact[0].inquiryDetails.includes("Reservation Reference: 8602335422"));
	assert.strictEqual(compact[0].inquiryAbout, "room_availability");
	assert.strictEqual(compact[1].role, "guest");
	assert(compact[1].message.includes("correct the reservation dates"));
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
