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
const openaiCore = require("../aiagent/core/openai");
const nlu = require("../aiagent/core/nlu");
const selectors = require("../aiagent/core/selectors");
const actions = require("../aiagent/core/actions").__test;

const hotel = {
	_id: "zad-ajyad-test",
	hotelName: "Zad Ajyad",
	hotelName_OtherLanguage: "Zad Ajyad",
	currency: "SAR",
	hasBusService: true,
	hasMealsService: false,
	busDetails: "يوفر الفندق باصًا خاصًا لنقل الضيوف إلى موقف الشهداء.",
	roomCountDetails: [
		{ _id: "double-test", roomType: "doubleRooms", activeRoom: true, displayName: "Double Room", bedsCount: 1, count: 20, price: { basePrice: 110 } },
		{ _id: "triple-test", roomType: "tripleRooms", activeRoom: true, displayName: "Triple Room - Premium Comfort", bedsCount: 1, count: 20, price: { basePrice: 75 } },
		{ _id: "quad-test", roomType: "quadRooms", activeRoom: true, displayName: "Quadruple Room", bedsCount: 1, count: 20, price: { basePrice: 120 } },
		{ _id: "family-five-test", roomType: "familyRooms", activeRoom: true, displayName: "Family Quintuple Room", bedsCount: 1, count: 20, price: { basePrice: 140 } },
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

check("Chatbot OpenAI runtime has one bounded attempt per stage", () => {
	const runtime = openaiCore.getChatbotOpenAIRuntimeConfig();
	assert(runtime.timeoutMs <= 24000);
	assert.strictEqual(runtime.maxRetries, 0);
	assert.strictEqual(runtime.sequentialFallbacksEnabled, false);
	assert.deepStrictEqual(
		openaiCore.normalizeOpenAiMetadata({ fileSearchAllowed: false, version: 2 }),
		{ fileSearchAllowed: "false", version: "2" }
	);
});

check("Priority booking and contact rules survive the real prompt cap", () => {
	const fullPrompt = orchestrator.systemPrompt({
		sc: {
			_id: "prompt-cap-case",
			preferredLanguageCode: "en",
			conversation: [guest("I need a room")],
		},
		hotel,
		known: { languageCode: "en" },
		turnKind: "new_chat_first_guest_message",
	});
	assert(fullPrompt.length > 28000, "fixture did not exercise prompt trimming");
	const [trimmed] = openaiCore.trimMessagesForOpenAI([
		{ role: "system", content: fullPrompt },
		{ role: "user", content: "latest guest turn".repeat(2000) },
	]);
	for (const required of [
		"PRIORITY CONTRACT",
		"do not repeat an adjacent assistant answer",
		"positive PMS guest calendar price is exact",
		"physical totalSellableUnits",
		"Use submit_reservation only after",
		"completed payment fully secures",
		"+1 (909) 222-3374",
		"https://wa.me/19092223374",
		"Never reveal a Saudi reception/front-desk number",
	]) {
		assert(trimmed.content.includes(required), `trimmed prompt lost: ${required}`);
	}
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

check("Khalifa guest burst keeps the price out of the child count", () => {
	const messages = [
		guest("\u0646\u0639\u0645\u060c \u062a\u0627\u0628\u0639"),
		guest("\u0627\u0644\u0632\u0648\u062c\u0629 \u0648\u0637\u0641\u0644"),
		guest("\u064a\u0639\u0646\u064a \u0627\u0644\u0644\u064a\u0644\u062a\u064a\u0646 \u0628\u0640 150 \u0631\u064a\u0627\u0644"),
	];
	assert.deepStrictEqual(
		orchestrator.guestCountFactsFromBurstMessages(messages, {
			adults: 1,
			children: 0,
		}),
		{ adults: 2, children: 1 }
	);
	const known = {
		languageCode: "ar",
		checkinISO: "2026-07-21",
		checkoutISO: "2026-07-23",
		roomTypeKey: "doubleRooms",
		rooms: 1,
		roomSelections: [{ roomId: "double-test", roomTypeKey: "doubleRooms", count: 1 }],
		adults: 1,
		children: 0,
	};
	const hint = orchestrator.latestMessageFactsHintForPrompt({
		sc: {
			_id: "khalifa-regression",
			preferredLanguageCode: "ar",
			conversation: messages,
		},
		hotel,
		known,
		latestGuest: messages[messages.length - 1],
	});
	assert.strictEqual(hint.facts.adults, 2);
	assert.strictEqual(hint.facts.children, 1);
	assert.strictEqual(hint.facts.rooms, 1);
	assert.strictEqual(hint.facts.roomTypeKey, "tripleRooms");
	assert.strictEqual(hint.facts.roomSelections.length, 1);
	assert.strictEqual(hint.facts.roomSelections[0].roomId, "triple-test");
});

check("Trusted guest transcript heals old corrupted roster and inferred room plan", () => {
	const conversation = [
		guest("\u0643\u0645 \u0633\u0639\u0631 \u063a\u0631\u0641\u0629 \u0644\u0634\u062e\u0635 \u0648\u0627\u062d\u062f"),
		ai("old quote", "quote_ready"),
		guest("\u0627\u0644\u0632\u0648\u062c\u0629 \u0648\u0637\u0641\u0644"),
		guest("\u064a\u0639\u0646\u064a \u0627\u0644\u0644\u064a\u0644\u062a\u064a\u0646 \u0628\u0640 150 \u0631\u064a\u0627\u0644"),
		ai("wrong options", "same_date_room_options_ready"),
		guest("\u063a\u0631\u0641\u0629 \u0648\u0627\u062d\u062f\u0629"),
	];
	const corrupted = {
		adults: 1,
		children: 20,
		rooms: 4,
		roomTypeKey: "familyRooms",
		roomSelections: [{ roomTypeKey: "familyRooms", count: 4 }],
		quote: { available: true, total: 600 },
	};
	const healed = orchestrator.healKnownGuestRosterFromConversation(
		hotel,
		{ conversation },
		corrupted
	);
	assert.strictEqual(healed.changed, true);
	assert.strictEqual(healed.known.adults, 2);
	assert.strictEqual(healed.known.children, 1);
	assert.strictEqual(healed.known.rooms, 1);
	assert.strictEqual(healed.known.roomTypeKey, "tripleRooms");
	assert.strictEqual(healed.known.roomSelections.length, 1);
	assert.strictEqual(healed.known.roomSelections[0].roomTypeKey, "tripleRooms");
	assert.strictEqual(healed.known.quote, undefined);
});

check("Guest-selected larger room survives a smaller updated party", () => {
	const latest = guest("\u0627\u0644\u0632\u0648\u062c\u0629 \u0648\u0637\u0641\u0644");
	const known = {
		checkinISO: "2026-07-21",
		checkoutISO: "2026-07-23",
		adults: 1,
		children: 20,
		rooms: 1,
		roomTypeKey: "quadRooms",
		roomSelections: [{ roomId: "quad-test", roomTypeKey: "quadRooms", count: 1 }],
	};
	const healed = orchestrator.healKnownGuestRosterFromConversation(
		hotel,
		{
			conversation: [
				guest("\u0623\u0631\u064a\u062f \u063a\u0631\u0641\u0629 \u0631\u0628\u0627\u0639\u064a\u0629"),
				latest,
			],
		},
		known
	);
	assert.strictEqual(healed.known.adults, 2);
	assert.strictEqual(healed.known.children, 1);
	assert.strictEqual(healed.known.roomTypeKey, "quadRooms");
	assert.strictEqual(healed.known.roomSelections[0].roomId, "quad-test");
	const hint = orchestrator.latestMessageFactsHintForPrompt({
		sc: { preferredLanguageCode: "ar", conversation: [latest] },
		hotel,
		known: healed.known,
		latestGuest: latest,
	});
	assert(!hint.facts.roomTypeKey);
});

check("Room-capacity questions never overwrite a trusted booking party", () => {
	const current = {
		adults: 2,
		children: 1,
		rooms: 1,
		roomTypeKey: "tripleRooms",
		roomSelections: [{ roomId: "triple-test", roomTypeKey: "tripleRooms", count: 1 }],
		quote: quoteForTriple(),
	};
	const healed = orchestrator.healKnownGuestRosterFromConversation(
		hotel,
		{
			conversation: [
				guest("\u0627\u0644\u0632\u0648\u062c\u0629 \u0648\u0637\u0641\u0644"),
				guest("Does the six-bed room fit 6 people?"),
			],
		},
		current
	);
	assert.strictEqual(healed.changed, false);
	assert.strictEqual(healed.known.adults, 2);
	assert.strictEqual(healed.known.children, 1);
	assert.strictEqual(healed.known.roomTypeKey, "tripleRooms");
	assert.strictEqual(healed.known.quote.total, 225);
});

check("Common English and Arabic capacity questions never become booking party counts", () => {
	const current = {
		adults: 2,
		children: 1,
		rooms: 1,
		roomTypeKey: "tripleRooms",
		roomSelections: [{ roomId: "triple-test", roomTypeKey: "tripleRooms", count: 1 }],
		quote: quoteForTriple(),
	};
	const questions = [
		"Is one triple room enough for 3 people?",
		"Can 3 people stay in a triple room?",
		"\u0647\u0644 \u062a\u0643\u0641\u064a \u0627\u0644\u063a\u0631\u0641\u0629 \u0627\u0644\u062b\u0644\u0627\u062b\u064a\u0629 \u0644\u062b\u0644\u0627\u062b\u0629 \u0623\u0634\u062e\u0627\u0635\u061f",
	];
	for (const question of questions) {
		assert.deepStrictEqual(orchestrator.guestCountFactsFromBurstMessages([question], current), {});
		const latest = guest(question);
		const hint = orchestrator.latestMessageFactsHintForPrompt({
			sc: { conversation: [latest], preferredLanguageCode: "en" },
			hotel,
			known: current,
			latestGuest: latest,
		});
		assert.deepStrictEqual(hint.facts, {});
		const healed = orchestrator.healKnownGuestRosterFromConversation(
			hotel,
			{ conversation: [guest("wife and a child"), latest] },
			current
		);
		assert.strictEqual(healed.known.adults, 2);
		assert.strictEqual(healed.known.children, 1);
		assert.strictEqual(healed.known.roomTypeKey, "tripleRooms");
	}
});

check("Arabic dual children and young son ages preserve the exact party", () => {
	const dual = "\u0623\u0646\u0627 \u0648\u0632\u0648\u062c\u062a\u064a \u0648\u0637\u0641\u0644\u064a\u0646";
	assert.deepStrictEqual(orchestrator.explicitGuestCountFactsFromText(dual), { children: 2 });
	assert.deepStrictEqual(orchestrator.relationshipGuestFactsFromText(dual, {}), {
		adults: 2,
		children: 2,
	});
	assert.deepStrictEqual(orchestrator.guestCountFactsFromBurstMessages([dual], {}), {
		adults: 2,
		children: 2,
	});
	for (const text of [
		"my wife and my son, he is 5 years old",
		"me, my wife, and my 5-year-old son",
		"my wife and my son aged 7",
		"\u0623\u0646\u0627 \u0648\u0632\u0648\u062c\u062a\u064a \u0648\u0627\u0628\u0646\u064a \u0639\u0645\u0631\u0647 5 \u0633\u0646\u0648\u0627\u062a",
	]) {
		assert.deepStrictEqual(orchestrator.relationshipGuestFactsFromText(text, {}), {
			adults: 2,
			children: 1,
		});
	}
});

check("Unnumbered plural children remain unresolved instead of being guessed", () => {
	for (const text of [
		"my wife and children",
		"me, my wife and kids",
		"I am coming with my children",
		"\u0623\u0646\u0627 \u0648\u0632\u0648\u062c\u062a\u064a \u0648\u0627\u0644\u0623\u0637\u0641\u0627\u0644",
	]) {
		const burst = orchestrator.guestCountFactsFromBurstMessages([text], {});
		assert.strictEqual(burst.children, undefined);
		assert.strictEqual(burst.childrenCountUnclear, true);
	}
	const latest = guest("my wife and children");
	const hint = orchestrator.latestMessageFactsHintForPrompt({
		sc: { conversation: [latest], preferredLanguageCode: "en" },
		hotel,
		known: {
			checkinISO: "2026-08-25",
			checkoutISO: "2026-08-28",
			roomTypeKey: "doubleRooms",
			rooms: 1,
		},
		latestGuest: latest,
	});
	assert.notStrictEqual(hint.facts.children, 0);
	assert.strictEqual(hint.facts.childrenCountUnclear, true);
	assert.strictEqual(hint.canQuote, false);
	assert(hint.missingForQuote.includes("children"));
});

check("Transcript healing reconciles explicit one room even when party counts already match", () => {
	const current = {
		adults: 2,
		children: 1,
		rooms: 4,
		roomTypeKey: "familyRooms",
		roomSelections: [{ roomId: "family-five-test", roomTypeKey: "familyRooms", count: 4 }],
		quote: { ...quoteForTriple(), roomTypeKey: "familyRooms", rooms: 4, totalRooms: 4 },
	};
	const healed = orchestrator.healKnownGuestRosterFromConversation(
		hotel,
		{ conversation: [guest("wife and a child"), guest("one room")] },
		current
	);
	assert.strictEqual(healed.changed, true);
	assert.strictEqual(healed.known.adults, 2);
	assert.strictEqual(healed.known.children, 1);
	assert.strictEqual(healed.known.rooms, 1);
	assert.strictEqual(healed.known.roomTypeKey, "tripleRooms");
	assert.strictEqual(healed.known.quote, undefined);
});

check("Room amenity questions never rewrite the confirmed room plan", () => {
	const current = {
		adults: 2,
		children: 1,
		rooms: 1,
		roomTypeKey: "tripleRooms",
		roomSelections: [{ roomId: "triple-test", roomTypeKey: "tripleRooms", count: 1 }],
		quote: quoteForTriple(),
	};
	const healed = orchestrator.healKnownGuestRosterFromConversation(
		hotel,
		{
			conversation: [
				guest("wife and a child"),
				ai("The triple room total is SAR 225.", "quote_ready"),
				guest("Does the double room have parking?"),
			],
		},
		current
	);
	assert.strictEqual(healed.changed, false);
	assert.strictEqual(healed.known.roomTypeKey, "tripleRooms");
	assert.strictEqual(healed.known.rooms, 1);
	assert.strictEqual(healed.known.quote.total, 225);
});

check("Spouse and child roster replaces corrupted model guest counts", () => {
	const text = "\u0627\u0644\u0632\u0648\u062c\u0629 \u0648\u0637\u0641\u0644";
	assert.deepStrictEqual(
		orchestrator.sanitizeBrainFactsForLatestText(
			{ adults: 1, children: 20 },
			{ adults: 1, children: 20 },
			text
		),
		{ adults: 2, children: 1 }
	);
	assert.deepStrictEqual(
		orchestrator.relationshipGuestFactsFromText(text, { adults: 1, children: 0 }),
		{ adults: 2, children: 1 }
	);
	assert.deepStrictEqual(
		orchestrator.relationshipGuestFactsFromText(
			"\u0623\u0646\u0627 \u0648\u0632\u0648\u062c\u062a\u064a\u060c \u0627\u0644\u0632\u0648\u062c\u0629 \u0648\u0637\u0641\u0644",
			{ adults: 1, children: 0 }
		),
		{ adults: 2, children: 1 }
	);
	assert.deepStrictEqual(
		orchestrator.relationshipGuestFactsFromText(
			"\u0632\u0648\u062c\u062a\u064a \u0648\u0637\u0641\u0644\u060c \u0627\u0644\u0637\u0641\u0644 \u0639\u0645\u0631\u0647 5 \u0633\u0646\u0648\u0627\u062a",
			{ adults: 1, children: 0 }
		),
		{ adults: 2, children: 1 }
	);
	assert.deepStrictEqual(
		orchestrator.relationshipGuestFactsFromText(
			"my wife, my son and my daughter",
			{ adults: 1, children: 0 }
		),
		{ adults: 4, children: 0 }
	);
});

check("Room choices require explicit comparison intent", () => {
	assert.strictEqual(
		orchestrator.latestGuestExplicitlyRequestsRoomChoices(
			"\u064a\u0639\u0646\u064a \u0627\u0644\u0644\u064a\u0644\u062a\u064a\u0646 \u0628\u0640 150 \u0631\u064a\u0627\u0644"
		),
		false
	);
	assert.strictEqual(
		orchestrator.latestGuestExplicitlyRequestsRoomChoices("\u063a\u0631\u0641\u0629 \u0648\u0627\u062d\u062f\u0629"),
		false
	);
	assert.strictEqual(
		orchestrator.latestGuestExplicitlyRequestsRoomChoices(
			"\u0642\u0627\u0631\u0646 \u0644\u064a \u0628\u064a\u0646 \u063a\u0631\u0641\u0629 \u062f\u0628\u0644 \u0623\u0648 \u0631\u0628\u0627\u0639\u064a\u0629"
		),
		true
	);
	assert.strictEqual(
		orchestrator.latestGuestExplicitlyRequestsRoomChoices(
			"\u0644\u0627 \u0623\u0631\u064a\u062f \u062e\u064a\u0627\u0631\u0627\u062a\u060c \u0627\u0639\u0637\u0646\u064a \u0627\u0644\u0623\u0646\u0633\u0628"
		),
		false
	);
	assert.strictEqual(
		orchestrator.latestGuestExplicitlyRequestsRoomChoices(
			"I don't want room options, just sell me the best fit"
		),
		false
	);
	assert.strictEqual(
		orchestrator.latestGuestExplicitlyRequestsRoomChoices(
			"No, show me room options"
		),
		true
	);
});

check("Customer room options never expose hotel stock and stop at two choices", () => {
	const redacted = orchestrator.redactInternalStockForCustomer({
		availableRooms: 35,
		inventory: { available: 35, requested: 1 },
		rooms: [
			{ roomId: "private-room-id", physicalRoomCount: 35, totalSellableUnits: 35, count: 1 },
		],
		roomSelections: [
			{ roomId: "private-room-id", roomTypeKey: "doubleRooms", count: 1, totalRooms: 35 },
		],
		quote: { totalRooms: 1, total: 150 },
	});
	const serialized = JSON.stringify(redacted);
	assert(!serialized.includes("availableRooms"));
	assert(!serialized.includes("physicalRoomCount"));
	assert(!serialized.includes("totalSellableUnits"));
	assert(!serialized.includes("inventory"));
	assert(!serialized.includes("private-room-id"));
	assert(!serialized.includes('"roomSelections":[{"roomTypeKey":"doubleRooms","count":1,"totalRooms"'));
	assert(serialized.includes('"totalRooms":1'));
	assert(orchestrator.replyDisclosesInternalStock("35 rooms available"));
	assert(orchestrator.replyDisclosesInternalStock("\u0627\u0644\u0645\u062a\u0648\u0641\u0631 35 \u063a\u0631\u0641\u0629"));
	assert(orchestrator.replyDisclosesInternalStock("We have 35 double rooms"));
	assert(orchestrator.replyDisclosesInternalStock("The hotel has 35 double rooms"));
	assert(orchestrator.replyDisclosesInternalStock("35 double rooms available"));
	assert(orchestrator.replyDisclosesInternalStock("35 Double Rooms are currently available"));
	assert(orchestrator.replyDisclosesInternalStock("Available: 35 double rooms"));
	assert(orchestrator.replyDisclosesInternalStock("Remaining: 35 double rooms"));
	assert(orchestrator.replyDisclosesInternalStock("We currently have a total of 35 double rooms"));
	assert(orchestrator.replyDisclosesInternalStock("The hotel offers 35 double rooms."));
	assert(orchestrator.replyDisclosesInternalStock("We offer 35 double rooms."));
	assert(orchestrator.replyDisclosesInternalStock("Our capacity is 35 double rooms."));
	assert(orchestrator.replyDisclosesInternalStock("The hotel offers thirty-five double rooms."));
	assert(orchestrator.replyDisclosesInternalStock("The property consists of 35 double rooms."));
	assert(orchestrator.replyDisclosesInternalStock("The hotel comprises 35 double rooms."));
	assert(orchestrator.replyDisclosesInternalStock("Our inventory includes 35 double rooms."));
	assert(orchestrator.replyDisclosesInternalStock("Our configured inventory is 35."));
	assert(orchestrator.replyDisclosesInternalStock("There are 35 doubles at the property."));
	assert(orchestrator.replyDisclosesInternalStock("We can offer up to 35 double rooms."));
	assert(orchestrator.replyDisclosesInternalStock("We have around 35 double rooms."));
	assert(orchestrator.replyDisclosesInternalStock("The hotel has thirty-five rooms."));
	assert(orchestrator.replyDisclosesInternalStock("We have thirty five double rooms."));
	assert(orchestrator.replyDisclosesInternalStock("There are thirty-five double rooms."));
	assert(orchestrator.replyDisclosesInternalStock("Available: 35 doubles"));
	assert(orchestrator.replyDisclosesInternalStock("35 doubles are available"));
	assert(orchestrator.replyDisclosesInternalStock("Thirty-five doubles are available"));
	assert(orchestrator.replyDisclosesInternalStock("\u0644\u062f\u064a\u0646\u0627 35 \u063a\u0631\u0641\u0629 \u062f\u0628\u0644"));
	assert(orchestrator.replyDisclosesInternalStock("\u064a\u0648\u062c\u062f \u0644\u062f\u064a\u0646\u0627 35 \u063a\u0631\u0641\u0629"));
	assert(orchestrator.replyDisclosesInternalStock("\u0639\u062f\u062f \u0627\u0644\u063a\u0631\u0641 35"));
	assert(orchestrator.replyDisclosesInternalStock("\u0627\u0644\u0641\u0646\u062f\u0642 \u0628\u0647 35 \u063a\u0631\u0641\u0629"));
	assert(orchestrator.replyDisclosesInternalStock("\u0627\u0644\u0641\u0646\u062f\u0642 \u0641\u064a\u0647 35 \u063a\u0631\u0641\u0629"));
	assert(orchestrator.replyDisclosesInternalStock("\u0644\u062f\u064a\u0646\u0627 \u062d\u0648\u0627\u0644\u064a 35 \u063a\u0631\u0641\u0629"));
	assert(orchestrator.replyDisclosesInternalStock("\u0645\u062a\u0627\u062d 35 \u063a\u0631\u0641\u0629"));
	assert(orchestrator.replyDisclosesInternalStock("\u0645\u062a\u0628\u0642\u064a 35 \u063a\u0631\u0641\u0629"));
	assert(orchestrator.replyDisclosesInternalStock("\u064a\u0648\u062c\u062f \u0628\u0627\u0644\u0641\u0646\u062f\u0642 35 \u063a\u0631\u0641\u0629"));
	assert(orchestrator.replyDisclosesInternalStock("\u064a\u0648\u0641\u0631 \u0627\u0644\u0641\u0646\u062f\u0642 35 \u063a\u0631\u0641\u0629 \u062f\u0628\u0644"));
	assert(orchestrator.replyDisclosesInternalStock("\u0627\u0644\u0641\u0646\u062f\u0642 \u064a\u0648\u0641\u0631 35 \u063a\u0631\u0641\u0629 \u062f\u0628\u0644"));
	assert(orchestrator.replyDisclosesInternalStock("\u0633\u0639\u0629 \u0627\u0644\u0641\u0646\u062f\u0642 35 \u063a\u0631\u0641\u0629"));
	assert(orchestrator.replyDisclosesInternalStock("\u0644\u062f\u064a\u0646\u0627 \u062e\u0645\u0633 \u0648\u062b\u0644\u0627\u062b\u0648\u0646 \u063a\u0631\u0641\u0629"));
	assert(orchestrator.replyDisclosesInternalStock("L'h\u00f4tel dispose de 35 chambres."));
	assert(orchestrator.replyDisclosesInternalStock("El hotel tiene 35 habitaciones."));
	assert(orchestrator.replyDisclosesInternalStock("Hay 35 habitaciones dobles disponibles."));
	assert(!orchestrator.replyDisclosesInternalStock("There are 2 rooms in your confirmed reservation."));
	assert(!orchestrator.replyDisclosesInternalStock("We have 2 rooms booked for you."));
	assert(!orchestrator.replyDisclosesInternalStock("Nous avons 2 chambres r\u00e9serv\u00e9es pour vous."));
	assert(!orchestrator.replyDisclosesInternalStock("Tenemos 2 habitaciones reservadas para usted."));
	assert(!orchestrator.replyDisclosesInternalStock("I can offer 5 double rooms + 5 triple rooms."));
	assert.strictEqual(
		orchestrator.replyDisclosesInternalStock(
			"\u0645\u0631\u0627\u062c\u0639\u0629 \u0627\u0644\u062d\u062c\u0632\n\u0639\u062f\u062f \u0627\u0644\u063a\u0631\u0641: 1\n\u0627\u0633\u0645 \u0627\u0644\u0636\u064a\u0641: \u0645\u0646\u0649 \u0643\u0648\u062f\u0643\u0633",
			{
				known: { rooms: 1, roomSelections: [{ roomTypeKey: "doubleRooms", count: 1 }] },
				clientAction: "review_reservation",
			}
		),
		false
	);
	assert(
		orchestrator.replyDisclosesInternalStock(
			"\u0645\u0631\u0627\u062c\u0639\u0629 \u0627\u0644\u062d\u062c\u0632\n\u0639\u062f\u062f \u0627\u0644\u063a\u0631\u0641: 35",
			{
				known: { rooms: 1, roomSelections: [{ roomTypeKey: "doubleRooms", count: 1 }] },
				clientAction: "review_reservation",
			}
		)
	);
	const message = orchestrator.buildSameDateRoomOptionsMessage(
		{ preferredLanguageCode: "en", clientName: "Khalifa" },
		{ languageCode: "en", checkinISO: "2026-07-21", checkoutISO: "2026-07-23" },
		{
			options: [
				{ roomTypeKey: "tripleRooms", roomLabel: "Triple Room", requestedRooms: 1, quotedRooms: 1, availableRooms: 4, total: 150, currency: "SAR" },
				{ roomTypeKey: "quadRooms", roomLabel: "Quad Room", requestedRooms: 1, quotedRooms: 1, availableRooms: 25, total: 180, currency: "SAR" },
				{ roomTypeKey: "familyRooms", roomLabel: "Six-Bed Room", requestedRooms: 1, quotedRooms: 1, availableRooms: 35, total: 200, currency: "SAR" },
			],
		}
	);
	assert(message.includes("Triple Room"));
	assert(message.includes("Quad Room"));
	assert(!message.includes("Six-Bed Room"));
	assert(!message.includes("35"));
	assert(!/rooms? available/i.test(message));
});

check("Repetition recovery never cycles back to an already-used fallback", () => {
	const base = { preferredLanguageCode: "en", clientName: "Khalifa", conversation: [] };
	const latest = guest("Please answer the same point again");
	const prior = [0, 1, 2].map((variant) =>
		ai(
			orchestrator.nonRepeatedCustomerReplyRecovery(
				base,
				{},
				latest,
				"ai_reply",
				variant
			),
			"ai_reply"
		)
	);
	const firstCase = { ...base, conversation: [...prior, latest] };
	const first = orchestrator.selectNonRepeatedCustomerReplyRecovery(
		firstCase,
		{},
		latest,
		"ai_reply"
	);
	assert(!prior.some((entry) => entry.message === first));
	assert.strictEqual(
		orchestrator.replyTooSimilarToRecentAi(firstCase, first, latest, "ai_reply"),
		false
	);
	const latestAgain = guest("Please answer the same point again");
	const secondCase = {
		...base,
		conversation: [...prior, latest, ai(first, "ai_reply"), latestAgain],
	};
	const second = orchestrator.selectNonRepeatedCustomerReplyRecovery(
		secondCase,
		{},
		latestAgain,
		"ai_reply"
	);
	assert.notStrictEqual(second, first);
	assert.strictEqual(
		orchestrator.replyTooSimilarToRecentAi(secondCase, second, latestAgain, "ai_reply"),
		false
	);
});

check("Blocked protocol replies use the validated critical fallback with public links", () => {
	const fallback = [
		"Your booking is confirmed. Confirmation number: 12345678.",
		"[View reservation details](https://jannatbooking.com/reservations/12345678)",
		"[Payment link](https://jannatbooking.com/pay/12345678)",
	].join("\n");
	const safe = orchestrator.safeProtocolBlockedCustomerReply(
		{ preferredLanguageCode: "en", clientName: "Khalifa" },
		{ confirmation: "12345678", quote: { total: 150, currency: "SAR" } },
		guest("Confirm reservation"),
		"reservation_confirmed",
		fallback
	);
	assert.strictEqual(safe, fallback);
	assert(safe.includes("View reservation details"));
	assert(safe.includes("Payment link"));
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

check("Exact calendar prices cross months and missing nights use basePrice only", () => {
	const pricingHotel = {
		currency: "SAR",
		openaiKnowledge: {
			coverageFrom: "2026-07-10",
			coverageThrough: "2027-04-15",
		},
		roomCountDetails: [
			{
				_id: "pricing-double",
				roomType: "doubleRooms",
				displayName: "Double Room",
				activeRoom: true,
				count: 5,
				bedsCount: 1,
				price: { basePrice: 100 },
				defaultCost: 67,
				roomCommission: 50,
				pricingRate: [
					{
						calendarDate: "2026-07-31",
						price: 75,
						rootPrice: 0,
						commissionRate: 90,
					},
				],
			},
		],
	};
	const quote = selectors.priceRoomForStay(
		pricingHotel,
		{ roomId: "pricing-double" },
		"2026-07-31",
		"2026-08-02"
	);
	assert.strictEqual(quote.available, true);
	assert.deepStrictEqual(quote.perNight, [75, 100]);
	assert.strictEqual(quote.totals.totalPriceWithCommission, 175);
	assert.strictEqual(quote.totals.hotelShouldGet, 134);
	assert.strictEqual(quote.totals.totalCommission, 41);
});

check("Mixed quote summary preserves exact per-room averages and totals", () => {
	const summary = orchestrator.compactQuoteToolResult(
		{
			ok: true,
			available: true,
			quote: {
				available: true,
				checkinISO: "2026-07-31",
				checkoutISO: "2026-08-02",
				nights: 2,
				totalRooms: 2,
				total: 390,
				averagePerNight: 195,
				currency: "SAR",
				roomSelections: [
					{ roomId: "mixed-double", roomTypeKey: "doubleRooms", count: 1 },
					{ roomId: "mixed-triple", roomTypeKey: "tripleRooms", count: 1 },
				],
				roomLines: [
					{
						roomTypeKey: "doubleRooms",
						roomLabel: "Double Room",
						count: 1,
						capacityGuests: 2,
						totalRooms: 5,
						perRoomAverageNightly: 87.5,
						perRoomStayTotal: 175,
						lineTotal: 175,
						perNightPerRoom: [75, 100],
					},
					{
						roomTypeKey: "tripleRooms",
						roomLabel: "Triple Room",
						count: 1,
						capacityGuests: 3,
						totalRooms: 5,
						perRoomAverageNightly: 107.5,
						perRoomStayTotal: 215,
						lineTotal: 215,
						perNightPerRoom: [95, 120],
					},
				],
			},
		},
		{ languageCode: "en", rooms: 2 }
	);
	assert.strictEqual(summary.roomLines.length, 2);
	assert.deepStrictEqual(
		summary.roomLines.map((line) => [line.roomLabel, line.perRoomStayTotal, line.lineTotal]),
		[
			["Double Room", 175, 175],
			["Triple Room", 215, 215],
		]
	);
});

check("Split-stay final refresh compares exact room mix even when totals match", () => {
	const periodA = { checkinISO: "2026-08-01", checkoutISO: "2026-08-03" };
	const periodB = { checkinISO: "2026-08-10", checkoutISO: "2026-08-12" };
	const makeQuote = (period, roomId, roomTypeKey) => ({
		available: true,
		...period,
		nights: 2,
		total: 200,
		currency: "SAR",
		selectionKey: `id:${roomId}:1`,
		roomSelections: [{ roomId, roomTypeKey, count: 1 }],
		roomLines: [
			{
				roomId,
				roomTypeKey,
				count: 1,
				perRoomStayTotal: 200,
				lineTotal: 200,
				perNightPerRoom: [100, 100],
			},
		],
		perNight: [100, 100],
	});
	const quoteA = makeQuote(periodA, "split-double", "doubleRooms");
	const quoteB = makeQuote(periodB, "split-double", "doubleRooms");
	const known = {
		splitStayTotal: 400,
		splitStayPeriods: [
			{
				...periodA,
				total: 200,
				quoteFingerprint: orchestrator.splitStayPeriodQuoteFingerprint(quoteA, periodA),
			},
			{
				...periodB,
				total: 200,
				quoteFingerprint: orchestrator.splitStayPeriodQuoteFingerprint(quoteB, periodB),
			},
		],
	};
	const unchanged = known.splitStayPeriods.map((period, index) => ({
		...period,
		quoteFingerprint: orchestrator.splitStayPeriodQuoteFingerprint(
			index === 0 ? quoteA : quoteB,
			period
		),
	}));
	assert.strictEqual(
		orchestrator.splitStayQuoteTotalsMatchKnown(known, unchanged, 400),
		true
	);
	const changedQuoteB = makeQuote(periodB, "split-triple", "tripleRooms");
	const changed = [
		unchanged[0],
		{
			...unchanged[1],
			quoteFingerprint: orchestrator.splitStayPeriodQuoteFingerprint(
				changedQuoteB,
				periodB
			),
		},
	];
	assert.strictEqual(
		orchestrator.splitStayQuoteTotalsMatchKnown(known, changed, 400),
		false
	);
});

check("Explicit blackout blocks while root price zero alone never blocks", () => {
	const room = {
		_id: "blackout-double",
		roomType: "doubleRooms",
		displayName: "Double Room",
		activeRoom: true,
		count: 5,
		price: { basePrice: 100 },
		pricingRate: [
			{ calendarDate: "2026-08-10", price: 100, rootPrice: 0 },
			{ calendarDate: "2026-08-11", price: 100, status: "blocked" },
		],
	};
	const hotelWithBlackout = {
		currency: "SAR",
		openaiKnowledge: { coverageThrough: "2027-04-15" },
		roomCountDetails: [room],
	};
	assert.strictEqual(
		selectors.priceRoomForStay(
			hotelWithBlackout,
			{ roomId: room._id },
			"2026-08-10",
			"2026-08-11"
		).available,
		true
	);
	const blocked = selectors.priceRoomForStay(
		hotelWithBlackout,
		{ roomId: room._id },
		"2026-08-11",
		"2026-08-12"
	);
	assert.strictEqual(blocked.available, false);
	assert.strictEqual(blocked.firstBlockedDate, "2026-08-11");
});

check("Published pricing horizon is a strict quote boundary", () => {
	const outside = selectors.priceRoomForStay(
		{
			currency: "SAR",
			openaiKnowledge: { coverageThrough: "2027-04-15" },
			roomCountDetails: [
				{
					_id: "horizon-double",
					roomType: "doubleRooms",
					displayName: "Double Room",
					activeRoom: true,
					count: 5,
					price: { basePrice: 100 },
				},
			],
		},
		{ roomId: "horizon-double" },
		"2027-04-15",
		"2027-04-17"
	);
	assert.strictEqual(outside.available, false);
	assert.strictEqual(outside.reason, "outside_pricing_coverage");
	assert.strictEqual(outside.firstBlockedDate, "2027-04-16");
	const withoutVectorMetadata = selectors.priceRoomForStay(
		{
			currency: "SAR",
			roomCountDetails: [
				{
					_id: "horizon-no-vector",
					roomType: "doubleRooms",
					displayName: "Double Room",
					activeRoom: true,
					count: 5,
					price: { basePrice: 100 },
				},
			],
		},
		{ roomId: "horizon-no-vector" },
		"2027-04-16",
		"2027-04-17"
	);
	assert.strictEqual(withoutVectorMetadata.available, false);
	assert.strictEqual(withoutVectorMetadata.reason, "outside_pricing_coverage");
});

check("Six guests select the exact six-bed family configuration by roomId", () => {
	const capacityHotel = {
		roomCountDetails: [
			{
				_id: "family-five",
				roomType: "familyRooms",
				displayName: "Family Quintuple Room",
				description: "Accommodates up to 5 guests.",
				activeRoom: true,
				count: 10,
				price: { basePrice: 100 },
			},
			{
				_id: "family-six",
				roomType: "familyRooms",
				displayName: "Spacious Six-Bed Room",
				description: "Accommodates up to 6 guests with six beds.",
				activeRoom: true,
				count: 35,
				price: { basePrice: 100 },
			},
		],
	};
	const plan = orchestrator.bestRoomSelectionsForGuests(capacityHotel, 6);
	assert.strictEqual(plan.length, 1);
	assert.strictEqual(plan[0].roomId, "family-six");
	assert.strictEqual(plan[0].capacityGuests, 6);
	assert.strictEqual(plan[0].count, 1);
});

check("Ten double rooms cap at five and fill the remainder with five triples", () => {
	const inventoryHotel = {
		currency: "SAR",
		openaiKnowledge: { coverageThrough: "2027-04-15" },
		roomCountDetails: [
			{
				_id: "five-doubles",
				roomType: "doubleRooms",
				displayName: "Double Room",
				activeRoom: true,
				count: 5,
				price: { basePrice: 100 },
			},
			{
				_id: "five-triples",
				roomType: "tripleRooms",
				displayName: "Triple Room",
				activeRoom: true,
				count: 5,
				price: { basePrice: 120 },
			},
		],
	};
	const plan = orchestrator.fitRoomSelectionsToPhysicalInventory(
		inventoryHotel,
		[{ roomTypeKey: "doubleRooms", count: 10 }],
		{
			checkinISO: "2026-08-20",
			checkoutISO: "2026-08-22",
		}
	);
	assert.strictEqual(plan.adjusted, true);
	assert.strictEqual(plan.unfilledRooms, 0);
	assert.deepStrictEqual(
		plan.roomSelections.map((item) => [item.roomId, item.count]),
		[
			["five-doubles", 5],
			["five-triples", 5],
		]
	);
	const known = orchestrator.syncKnownFromQuote({
		quote: {
			available: true,
			checkinISO: "2026-08-20",
			checkoutISO: "2026-08-22",
			roomPlanAdjusted: true,
			roomPlanRequiresGuestConfirmation: true,
			requestedRoomSelections: plan.requestedRoomSelections,
			recommendedRoomSelections: plan.roomSelections,
			roomSelections: plan.roomSelections,
			rooms: plan.roomSelections,
			totalRooms: 10,
			nights: 2,
			total: 2200,
		},
	});
	assert.strictEqual(orchestrator.adjustedRoomPlanConfirmationPending(known), true);
	const confirmed = orchestrator.applyAdjustedRoomPlanGuestConfirmation(
		known,
		guest("Yes, I agree"),
		ai("Recommended mix", "quote_ready")
	);
	assert.strictEqual(orchestrator.adjustedRoomPlanConfirmationPending(confirmed), false);
	const driftedIdentityTurn = {
		...confirmed,
		roomSelections: [{ roomTypeKey: "familyRooms", count: 4 }],
		rooms: 4,
		roomTypeKey: "familyRooms",
		adults: 20,
		children: 0,
		fullName: "Omar Codex",
		phone: "+966500000044",
		nationality: "Egyptian",
	};
	delete driftedIdentityTurn.quote;
	const lockedIdentityTurn = orchestrator.preserveConfirmedAdjustedRoomPlan(
		confirmed,
		driftedIdentityTurn,
		"The booking name is Omar Codex, phone +966500000044, nationality Egyptian, 20 adults and no children.",
		{ changedFields: ["fullName", "phone", "nationality", "adults", "children"] }
	);
	assert.deepStrictEqual(
		lockedIdentityTurn.roomSelections.map((item) => [item.roomId, item.count]),
		plan.roomSelections.map((item) => [item.roomId, item.count])
	);
	assert.strictEqual(lockedIdentityTurn.rooms, 10);
	assert.strictEqual(orchestrator.quoteMatchesKnown(lockedIdentityTurn), true);
	const lockedRoomFactQuestion = orchestrator.preserveConfirmedAdjustedRoomPlan(
		confirmed,
		driftedIdentityTurn,
		"Does the double room have parking?",
		{ changedFields: ["roomSelections", "rooms", "roomTypeKey"] }
	);
	assert.deepStrictEqual(
		lockedRoomFactQuestion.roomSelections.map((item) => [item.roomId, item.count]),
		plan.roomSelections.map((item) => [item.roomId, item.count])
	);
	assert.strictEqual(lockedRoomFactQuestion.rooms, 10);
	assert.strictEqual(lockedRoomFactQuestion.roomPlanConfirmedKey, confirmed.roomPlanConfirmedKey);
	assert.strictEqual(orchestrator.quoteMatchesKnown(lockedRoomFactQuestion), true);
	const explicitRoomChange = orchestrator.preserveConfirmedAdjustedRoomPlan(
		confirmed,
		driftedIdentityTurn,
		"Change it to 4 family rooms",
		{ changedFields: ["roomSelections", "rooms", "roomTypeKey"] }
	);
	assert.deepStrictEqual(explicitRoomChange.roomSelections, [
		{ roomTypeKey: "familyRooms", count: 4 },
	]);
	assert.strictEqual(explicitRoomChange.roomPlanConfirmedKey, undefined);
	const largeInventoryHotel = {
		...inventoryHotel,
		roomCountDetails: [
			{ ...inventoryHotel.roomCountDetails[0], count: 5 },
			{ ...inventoryHotel.roomCountDetails[1], count: 55 },
		],
	};
	const parsedLargeRequest = orchestrator.extractRoomSelectionsFromText("I need 60 double rooms");
	assert.deepStrictEqual(
		parsedLargeRequest.map((item) => [item.roomTypeKey, item.count]),
		[["doubleRooms", 60]]
	);
	const largePlan = orchestrator.fitRoomSelectionsToPhysicalInventory(
		largeInventoryHotel,
		parsedLargeRequest,
		{ checkinISO: "2026-08-20", checkoutISO: "2026-08-22" }
	);
	assert.strictEqual(largePlan.unfilledRooms, 0);
	assert.strictEqual(orchestrator.roomSelectionsTotal(largePlan.roomSelections), 60);
	assert.deepStrictEqual(
		largePlan.roomSelections.map((item) => [item.roomId, item.count]),
		[
			["five-doubles", 5],
			["five-triples", 55],
		]
	);
	assert.strictEqual(orchestrator.roomCountRequestLimitExceeded("I need 60 double rooms"), false);
	assert.strictEqual(orchestrator.roomCountRequestLimitExceeded("I need 201 double rooms"), true);
	assert.strictEqual(orchestrator.roomCountRequestLimitExceeded("201"), true);
	assert.strictEqual(
		orchestrator.roomCountRequestLimitExceeded("I need 150 double rooms and 75 triple rooms"),
		true
	);
	assert.strictEqual(
		orchestrator.knownRoomCountRequestLimitExceeded({
			rooms: 201,
			roomSelections: [{ roomTypeKey: "doubleRooms", count: 201 }],
		}),
		true
	);
	assert.strictEqual(actions.roomSelectionCount(60), 60);
	assert.throws(() => actions.roomSelectionCount(201), /supported maximum/i);
	assert.throws(
		() =>
			actions.validateRequiredGuestDetails({
				fullName: "Large Group Guest",
				phone: "+966500000001",
				nationality: "Saudi",
				adults: 200,
				children: 0,
				rooms: 201,
			}),
		/supported maximum/i
	);
	const limitReply = orchestrator.buildRoomCountLimitMessage(
		{ preferredLanguageCode: "en" },
		{ languageCode: "en" },
		guest("I need 201 double rooms")
	);
	assert(/have not reduced the requested count/i.test(limitReply));
	assert(limitReply.includes("+1 (909) 222-3374"));
});

check("Exact family variant overflow uses the next same-category physical configuration", () => {
	const inventoryHotel = {
		currency: "SAR",
		openaiKnowledge: { coverageThrough: "2027-04-15" },
		roomCountDetails: [
			{
				_id: "family-five-exact",
				roomType: "familyRooms",
				displayName: "Family Quintuple Room",
				activeRoom: true,
				count: 2,
				price: { basePrice: 140 },
			},
			{
				_id: "family-six-overflow",
				roomType: "familyRooms",
				displayName: "Spacious Six-Bed Room",
				activeRoom: true,
				count: 3,
				price: { basePrice: 100 },
			},
		],
	};
	const plan = orchestrator.fitRoomSelectionsToPhysicalInventory(
		inventoryHotel,
		[
			{
				roomId: "family-five-exact",
				roomTypeKey: "familyRooms",
				roomDisplayName: "Family Quintuple Room",
				capacityGuests: 5,
				count: 4,
			},
		],
		{ checkinISO: "2026-08-20", checkoutISO: "2026-08-22" }
	);
	assert.strictEqual(plan.adjusted, true);
	assert.strictEqual(plan.unfilledRooms, 0);
	assert.deepStrictEqual(
		plan.roomSelections.map((item) => [item.roomId, item.count]),
		[
			["family-five-exact", 2],
			["family-six-overflow", 2],
		]
	);
	const reversePlan = orchestrator.fitRoomSelectionsToPhysicalInventory(
		inventoryHotel,
		[
			{
				roomId: "family-six-overflow",
				roomTypeKey: "familyRooms",
				roomDisplayName: "Spacious Six-Bed Room",
				count: 5,
			},
		],
		{ checkinISO: "2026-08-20", checkoutISO: "2026-08-22" }
	);
	assert.strictEqual(reversePlan.adjusted, true);
	assert.strictEqual(reversePlan.unfilledRooms, 2);
	assert.deepStrictEqual(
		reversePlan.roomSelections.map((item) => [item.roomId, item.count]),
		[["family-six-overflow", 3]]
	);
	assert(
		!reversePlan.roomSelections.some((item) => item.roomId === "family-five-exact"),
		"six-bed overflow was downgraded to a lower-capacity quintuple room"
	);
});

check("Inactive zero-count zero-base and unknown-capacity rooms fail closed", () => {
	const baseRoom = {
		_id: "unsellable-room",
		roomType: "doubleRooms",
		displayName: "Double Room",
		activeRoom: true,
		count: 1,
		price: { basePrice: 100 },
	};
	const quote = (room) =>
		selectors.priceRoomForStay(
			{
				currency: "SAR",
				openaiKnowledge: { coverageThrough: "2027-04-15" },
				roomCountDetails: [room],
			},
			{ roomId: room._id },
			"2026-08-20",
			"2026-08-22"
		);
	assert.strictEqual(quote({ ...baseRoom, activeRoom: false }).available, false);
	assert.strictEqual(quote({ ...baseRoom, count: 0 }).available, false);
	assert.strictEqual(
		quote({
			...baseRoom,
			price: { basePrice: 0 },
			pricingRate: [{ calendarDate: "2026-08-20", price: 200 }],
		}).available,
		false
	);
	assert.strictEqual(
		quote({
			...baseRoom,
			roomType: "other",
			displayName: "Generic Room",
			description: "Contact management for capacity.",
		}).available,
		false
	);
});

check("No sellable physical candidates reports the full requested shortage", () => {
	const plan = orchestrator.fitRoomSelectionsToPhysicalInventory(
		{
			roomCountDetails: [
				{
					_id: "zero-double",
					roomType: "doubleRooms",
					displayName: "Double Room",
					activeRoom: true,
					count: 0,
					price: { basePrice: 100 },
				},
			],
		},
		[{ roomTypeKey: "doubleRooms", count: 3 }],
		{}
	);
	assert.strictEqual(plan.adjusted, true);
	assert.strictEqual(plan.unfilledRooms, 3);
	assert.deepStrictEqual(plan.roomSelections, []);
});

check("Adding the exact roomId to a normal type request is not a changed room plan", () => {
	const plan = orchestrator.fitRoomSelectionsToPhysicalInventory(
		{
			roomCountDetails: [
				{
					_id: "normal-double",
					roomType: "doubleRooms",
					displayName: "Double Room",
					activeRoom: true,
					count: 5,
					price: { basePrice: 100 },
				},
			],
		},
		[{ roomTypeKey: "doubleRooms", count: 1 }],
		{}
	);
	assert.strictEqual(plan.adjusted, false);
	assert.strictEqual(plan.roomSelections[0].roomId, "normal-double");
});

check("Large group planner searches beyond minRooms plus two", () => {
	const plan = orchestrator.bestRoomSelectionsForGuests(
		{
			roomCountDetails: [
				{
					_id: "one-six-bed",
					roomType: "familyRooms",
					displayName: "Spacious Six-Bed Room",
					activeRoom: true,
					count: 1,
					price: { basePrice: 100 },
				},
				{
					_id: "many-doubles",
					roomType: "doubleRooms",
					displayName: "Double Room",
					activeRoom: true,
					count: 20,
					price: { basePrice: 100 },
				},
			],
		},
		20
	);
	assert.strictEqual(orchestrator.roomSelectionsGuestCapacity(plan), 20);
	assert.strictEqual(
		plan.reduce((total, item) => total + item.count, 0),
		8
	);
});

check("Single occupancy maps to a real double room when no single exists", () => {
	const plan = orchestrator.fitRoomSelectionsToPhysicalInventory(
		{
			roomCountDetails: [
				{
					_id: "single-use-double",
					roomType: "doubleRooms",
					displayName: "Double Room",
					activeRoom: true,
					count: 4,
					price: { basePrice: 100 },
				},
			],
		},
		[{ roomTypeKey: "singleRooms", count: 1 }],
		{}
	);
	assert.strictEqual(plan.singleMappedToDouble, true);
	assert.strictEqual(plan.roomSelections[0].roomTypeKey, "doubleRooms");
	assert.strictEqual(plan.roomSelections[0].roomId, "single-use-double");
});

check("Six-bed wording maps to family category for exact configuration resolution", () => {
	assert.strictEqual(nlu.mapRoomToKey("I need a six-bed room"), "familyRooms");
	assert.strictEqual(nlu.mapRoomToKey("room for 6"), "familyRooms");
});

check("Legacy PMS room type aliases use the display capacity and stable roomId", () => {
	const legacyTriple = {
		_id: "legacy-twin-triple",
		roomType: "twinRooms",
		displayName: "Triple Room - Comfort",
		activeRoom: true,
		count: 8,
		price: { basePrice: 75 },
	};
	assert.strictEqual(selectors.canonicalRoomTypeKey(legacyTriple), "tripleRooms");
	assert.strictEqual(
		selectors.resolveRoomForStay(
			{ roomCountDetails: [legacyTriple] },
			{ roomType: "tripleRooms" }
		)?._id,
		"legacy-twin-triple"
	);
});

check("Reservation updates hydrate every requested stay night", () => {
	assert.deepStrictEqual(
		actions.reservationUpdatePricingDateKeys("2026-07-31", "2026-08-03"),
		["2026-07-31", "2026-08-01", "2026-08-02"]
	);
});

check("Reservation update selection preserves one stable hotel room configuration", () => {
	const selection = actions.reservationRoomSelection({
		pickedRoomsType: [
			{
				hotelRoomConfigId: "family-six",
				room_type: "familyRooms",
				displayName: "Spacious Six-Bed Room",
				count: 1,
			},
			{
				hotelRoomConfigId: "family-six",
				room_type: "familyRooms",
				displayName: "Spacious Six-Bed Room",
				count: 1,
			},
		],
	});
	assert.strictEqual(selection.supported, true);
	assert.strictEqual(selection.roomId, "family-six");
	assert.strictEqual(selection.hotelRoomConfigId, "family-six");
	assert.strictEqual(selection.count, 2);
});

check("Reservation update rejects distinct configurations sharing one room type", () => {
	const selection = actions.reservationRoomSelection({
		pickedRoomsType: [
			{
				hotelRoomConfigId: "family-five",
				room_type: "familyRooms",
				displayName: "Family Quintuple Room",
			},
			{
				hotelRoomConfigId: "family-six",
				room_type: "familyRooms",
				displayName: "Spacious Six-Bed Room",
			},
		],
	});
	assert.strictEqual(selection.supported, false);
	assert.strictEqual(selection.reason, "multiple_room_configurations");
});

check("Reservation room override outranks the old room ID and display name", () => {
	const updateHotel = {
		roomCountDetails: [
			{
				_id: "double-config",
				roomType: "doubleRooms",
				displayName: "Double Room",
				activeRoom: true,
				count: 1,
				price: { basePrice: 100 },
			},
			{
				_id: "triple-config",
				roomType: "tripleRooms",
				displayName: "Triple Room",
				activeRoom: true,
				count: 1,
				price: { basePrice: 100 },
			},
		],
	};
	const overridden = actions.findHotelRoomForSelection(
		updateHotel,
		{
			roomId: "double-config",
			roomType: "doubleRooms",
			displayName: "Double Room",
		},
		"tripleRooms"
	);
	assert.strictEqual(overridden?._id, "triple-config");
});

check("Reservation update keeps stable room ID when the type is unchanged", () => {
	const updateHotel = {
		roomCountDetails: [
			{
				_id: "family-five",
				roomType: "familyRooms",
				displayName: "Family Quintuple Room",
				activeRoom: true,
				count: 1,
				price: { basePrice: 100 },
			},
			{
				_id: "family-six",
				roomType: "familyRooms",
				displayName: "Spacious Six-Bed Room",
				activeRoom: true,
				count: 1,
				price: { basePrice: 100 },
			},
		],
	};
	const preserved = actions.findHotelRoomForSelection(
		updateHotel,
		{
			roomId: "family-six",
			roomType: "familyRooms",
			displayName: "Spacious Six-Bed Room",
		},
		"familyRooms"
	);
	assert.strictEqual(preserved?._id, "family-six");
});

check("Reservation update requote wording never claims a stale update succeeded", () => {
	const message = orchestrator.buildFriendlyReservationUpdateMessage(
		{ preferredLanguageCode: "en", clientName: "Ahmed" },
		{
			languageCode: "en",
			confirmation: "1234567890",
			checkinISO: "2026-08-20",
			checkoutISO: "2026-08-22",
		},
		{
			ok: false,
			code: "requote_required",
			requiresRequote: true,
			quote: { totals: { totalPriceWithCommission: 450 } },
		},
		guest("Yes, change it")
	);
	assert(/was not updated/i.test(message));
	assert(/450\s*SAR/i.test(message));
	assert(!/updated successfully/i.test(message));
});

check("Final refresh detects any price or physical room-mix change", () => {
	const base = {
		available: true,
		checkinISO: "2026-08-20",
		checkoutISO: "2026-08-22",
		roomSelections: [
			{ roomId: "five-doubles", roomTypeKey: "doubleRooms", count: 5 },
			{ roomId: "five-triples", roomTypeKey: "tripleRooms", count: 5 },
		],
		totalRooms: 10,
		nights: 2,
		averagePerNight: 1100,
		total: 2200,
	};
	assert.strictEqual(orchestrator.quoteMateriallyChanged(base, { ...base }), false);
	assert.strictEqual(
		orchestrator.quoteMateriallyChanged(base, { ...base, total: 2300 }),
		true
	);
	assert.strictEqual(
		orchestrator.quoteMateriallyChanged(base, { ...base, currency: "USD" }),
		true
	);
	assert.strictEqual(
		orchestrator.quoteMateriallyChanged(base, { ...base, available: false }),
		true
	);
	assert.strictEqual(
		orchestrator.quoteMateriallyChanged(base, {
			...base,
			roomSelections: [
				{ roomId: "five-doubles", roomTypeKey: "doubleRooms", count: 4 },
				{ roomId: "five-triples", roomTypeKey: "tripleRooms", count: 6 },
			],
		}),
		true
	);
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
	const nusukAnsweredButBusDetailOmitted =
		"\u0646\u0639\u0645\u060c \u064a\u0648\u062c\u062f \u0628\u0627\u0635\u060c \u0648\u0627\u0644\u0641\u0646\u062f\u0642 \u0645\u062a\u0627\u062d \u0639\u0644\u0649 \u0646\u0633\u0643. \u0627\u0644\u0645\u0648\u0642\u0639 \u064a\u0628\u0639\u062f 15 \u062f\u0642\u064a\u0642\u0629 \u0645\u0634\u064a.";
	assert.strictEqual(
		orchestrator.hotelFactReplyNeedsCorrection(
			{ action: "reply", reply: nusukAnsweredButBusDetailOmitted },
			nusukHotel,
			latestGuest
		),
		true
	);
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
	assert.strictEqual(
		orchestrator.replyDisclosesInternalStock(review, {
			known,
			clientAction: "review_reservation",
			toolResult: { tool: "send_review" },
		}),
		false
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

check("Repeated official review keeps every fact without repeating the prior prose", () => {
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
	const sc = { preferredLanguageCode: "en", displayName1: "Ahmed", conversation: [] };
	const firstReview = orchestrator.buildReviewMessage(sc, known, hotel);
	const repeatedReview = orchestrator.buildRepeatedReviewMessage(sc, known, hotel);
	const previous = ai(firstReview, "review_reservation");
	const latest = guest("Please show me all booking details once more.");
	sc.conversation = [previous, latest];
	assert.strictEqual(
		orchestrator.replyTooSimilarToRecentAi(
			sc,
			firstReview,
			latest,
			"review_reservation"
		),
		true
	);
	assert.strictEqual(
		orchestrator.replyTooSimilarToRecentAi(
			sc,
			repeatedReview,
			latest,
			"review_reservation"
		),
		false
	);
	assert(repeatedReview.includes("Ahmed Codex"));
	assert(repeatedReview.includes("0551000099"));
	assert(repeatedReview.includes("Egyptian"));
	assert(repeatedReview.includes('<s class="message-price-old">300 SAR</s>'));
	assert(repeatedReview.includes('<strong class="message-price-new">225 SAR</strong>'));
	assert(/complete booking/i.test(repeatedReview));
	const quoteLike = firstReview.replace(
		"here is the final review before I create the booking",
		"here is the available quote before the booking review"
	);
	const transitionGuest = guest("Yes, continue to review.");
	const transitionSc = {
		...sc,
		conversation: [ai(quoteLike, "quote_ready"), transitionGuest],
	};
	assert.strictEqual(
		orchestrator.replyTooSimilarToRecentAi(
			transitionSc,
			firstReview,
			transitionGuest,
			"review_reservation"
		),
		false
	);

	const arabicKnown = { ...known, languageCode: "ar", fullName: "منى كودكس", nationality: "مصرية" };
	const arabicSc = {
		preferredLanguageCode: "ar",
		clientName: "منى",
		conversation: [],
	};
	const arabicFirst = orchestrator.buildReviewMessage(arabicSc, arabicKnown, hotel);
	const arabicRepeated = orchestrator.buildRepeatedReviewMessage(arabicSc, arabicKnown, hotel);
	const arabicPrevious = ai(arabicFirst, "review_reservation");
	const arabicLatest = guest("ممكن أشوف تفاصيل الحجز كاملة مرة ثانية؟");
	arabicSc.conversation = [arabicPrevious, arabicLatest];
	assert.strictEqual(
		orchestrator.replyTooSimilarToRecentAi(
			arabicSc,
			arabicRepeated,
			arabicLatest,
			"review_reservation"
		),
		false
	);
	assert(arabicRepeated.includes("منى كودكس"));
	assert(arabicRepeated.includes("0551000099"));
	assert(arabicRepeated.includes("مصرية"));
	assert(/<s\b[^>]*message-price-old/i.test(arabicRepeated));
	assert(/<strong\b[^>]*message-price-new/i.test(arabicRepeated));
	const arabicDiscount = orchestrator.quoteDiscountDisplay(arabicKnown.quote, "ar");
	assert(arabicRepeated.includes(arabicDiscount.displayAveragePerNightLine));
	assert(arabicRepeated.includes(arabicDiscount.displayTotalLine));
	assert.strictEqual(
		orchestrator.reviewReplyMissingDiscountFormat(arabicRepeated, {
			tool: "send_review",
			code: "review_ready",
			review: {
				quote: {
					discount: arabicDiscount,
				},
			},
		}),
		false
	);
	assert(arabicRepeated.includes("إتمام الحجز"));
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
	const busReply = orchestrator.buildSupportContactNumberMessage(
		{ preferredLanguageCode: "en" },
		{},
		guest("What is the WhatsApp number and bus stop?"),
		{ ...hotel, busDetails: "Bus stop: Martyrs parking." }
	);
	assert(busReply.includes("+1 (909) 222-3374"));
	assert(busReply.includes("Martyrs parking"));
	assert(!busReply.includes("+966541981804"));
});

check("Brain-invented email skip cannot bypass optional email offer", () => {
	const completeKnown = {
		languageCode: "ar",
		checkinISO: "2026-08-25",
		checkoutISO: "2026-08-28",
		roomTypeKey: "tripleRooms",
		rooms: 1,
		roomSelections: [{ roomTypeKey: "tripleRooms", count: 1 }],
		adults: 2,
		children: 0,
		fullName: "Ahmed Codex",
		phone: "966500000008",
		nationality: "Egyptian",
		quote: quoteForTriple(),
		emailSkipped: true,
	};
	const sc = {
		preferredLanguageCode: "ar",
		conversation: [ai("Quote is ready.", "quote_ready"), guest("Continue")],
	};
	const cleaned = orchestrator.clearUntrustedEmailSkipped(
		completeKnown,
		sc,
		"name Ahmed Codex phone 966500000008 nationality Egyptian",
		""
	);
	assert.strictEqual(cleaned.emailSkipped, undefined);
	assert.strictEqual(orchestrator.shouldOfferOptionalEmail(sc, cleaned), true);

	const skippedSc = {
		preferredLanguageCode: "ar",
		conversation: [
			ai("Email is optional. Continue without email?", "optional_email"),
			guest("continue without email", "skip_email"),
		],
	};
	const trusted = orchestrator.clearUntrustedEmailSkipped(
		completeKnown,
		skippedSc,
		"continue without email",
		"skip_email"
	);
	assert.strictEqual(trusted.emailSkipped, true);
	assert.strictEqual(orchestrator.shouldOfferOptionalEmail(skippedSc, trusted), false);
});

check("Existing reservation lookup reports confirmed payment without inventing pending review", () => {
	const reservation = {
		_id: "6a5030efefd4fdbb5d061a8c",
		confirmation_number: "8940361462",
		reservation_status: "confirmed",
		checkin_date: "2026-07-27T00:00:00.000Z",
		checkout_date: "2026-08-03T00:00:00.000Z",
		total_amount: 525,
		paid_amount: 78.75,
		currency: "SAR",
		payment: "paypal",
		payment_details: {},
		paypal_details: {},
	};
	const summary = orchestrator.reservationPaymentSummary(reservation);
	assert.strictEqual(summary.confirmedPaid, 78.75);
	assert.strictEqual(summary.pendingReview, 0);
	assert.strictEqual(summary.remaining, 446.25);
	const reply = orchestrator.buildReservationLookupMessage(
		{ preferredLanguageCode: "en" },
		{ confirmation: "8940361462", languageCode: "en" },
		reservation,
		guest("How much is remaining to pay at the hotel?")
	);
	assert(reply.includes("Confirmed paid: 78.75 SAR"));
	assert(reply.includes("Remaining balance: 446.25 SAR"));
	assert(!/pending|review/i.test(reply));
	assert(!reply.includes("/client-payment/"));
});

check("Existing reservation lookup can provide payment and receipt links on request", () => {
	const reservation = {
		_id: "6a5030efefd4fdbb5d061a8c",
		confirmation_number: "8940361462",
		reservation_status: "confirmed",
		checkin_date: "2026-07-27T00:00:00.000Z",
		checkout_date: "2026-08-03T00:00:00.000Z",
		total_amount: 525,
		paid_amount: 78.75,
		currency: "SAR",
		payment: "paypal",
		payment_details: {},
		paypal_details: {},
	};
	const english = orchestrator.buildReservationLookupMessage(
		{ preferredLanguageCode: "en" },
		{ confirmation: "8940361462", languageCode: "en" },
		reservation,
		guest("Please send me the payment link and receipt link")
	);
	assert(english.includes("/client-payment/6a5030efefd4fdbb5d061a8c/8940361462"));
	assert(english.includes("/single-reservation/8940361462"));
	const arabic = orchestrator.buildReservationLookupMessage(
		{ preferredLanguageCode: "ar" },
		{ confirmation: "8940361462", languageCode: "ar" },
		reservation,
		guest(
			"\u0627\u0631\u0633\u0644 \u0631\u0627\u0628\u0637 \u0627\u0644\u062f\u0641\u0639 \u0648\u0631\u0627\u0628\u0637 \u0627\u0644\u0641\u0627\u062a\u0648\u0631\u0629"
		)
	);
	assert(arabic.includes("/client-payment/6a5030efefd4fdbb5d061a8c/8940361462"));
	assert(arabic.includes("/single-reservation/8940361462"));
});

check("Bare confirmation inherits prior deposit question for reservation payment lookup", () => {
	const latest = guest("8940361462");
	const sc = {
		conversation: [
			guest("I paid a deposit for my reservation"),
			ai("Please send the confirmation number.", "reservation_lookup_not_found"),
			latest,
		],
	};
	assert.strictEqual(orchestrator.latestGuestIsBareReservationConfirmation(latest.message), true);
	assert.strictEqual(orchestrator.reservationLookupTurnAsksPayment(sc, latest), true);
	const tool = orchestrator.reservationLookupToolResult(
		{
			confirmation_number: "8940361462",
			total_amount: 525,
			paid_amount: 78.75,
			currency: "SAR",
			payment: "paypal",
		},
		{ paymentRequested: true }
	);
	assert.strictEqual(tool.paymentRequested, true);
	assert.strictEqual(tool.paymentSummary.confirmedPaid, 78.75);
	assert.strictEqual(tool.paymentSummary.pendingReview, 0);
	assert.strictEqual(tool.paymentSummary.remaining, 446.25);
	assert.match(tool.instruction, /Do not mention double payment or pending review/);
});

check("Bare number after reservation-confirmation ask is lookup, not booking phone", () => {
	const previousAi = ai("Please send the reservation confirmation number.", "reservation_lookup_not_found");
	const sc = {
		conversation: [
			guest("I paid a deposit for my reservation"),
			previousAi,
			guest("8940361462"),
		],
	};
	assert.strictEqual(orchestrator.previousAiAskedForReservationConfirmation(previousAi), true);
	assert.strictEqual(
		orchestrator.latestGuestRequestsReservationLookup(
			sc,
			"8940361462",
			{},
			previousAi
		),
		true
	);
});

check("Existing reservation service mode is not triggered by ordinary booking intent", () => {
	assert.strictEqual(
		orchestrator.latestGuestRequestsExistingReservationService("I want to book a double room"),
		false
	);
	assert.strictEqual(
		orchestrator.latestGuestRequestsExistingReservationService(
			"\u0627\u0631\u064a\u062f \u062d\u062c\u0632 \u063a\u0631\u0641\u0629 \u0645\u0632\u062f\u0648\u062c\u0629"
		),
		false
	);
	assert.strictEqual(
		orchestrator.latestGuestRequestsExistingReservationService("I already paid a deposit for my reservation"),
		true
	);
	assert.strictEqual(
		orchestrator.latestGuestRequestsExistingReservationService(
			"\u062f\u0641\u0639\u062a \u0639\u0631\u0628\u0648\u0646 \u062d\u062c\u0632"
		),
		true
	);
});

check("PayPal pending review is separated from confirmed paid amount", () => {
	const reservation = {
		total_amount: 525,
		paid_amount: 78.75,
		currency: "SAR",
		payment: "paypal",
		paypal_details: {
			pending_total_usd: 21,
			pending_review_captures: [{ capture_status: "PENDING", amount_sar: 78.75 }],
		},
		payment_details: {
			paypalReviewPending: true,
			triggeredAmountSAR: 78.75,
		},
	};
	const summary = orchestrator.reservationPaymentSummary(reservation);
	assert.strictEqual(summary.confirmedPaid, 78.75);
	assert.strictEqual(summary.pendingReview, 78.75);
	assert.strictEqual(summary.remaining, 446.25);
});

check("Existing reservation without confirmation asks safe lookup details only", () => {
	const reply = orchestrator.buildReservationLookupMessage(
		{ preferredLanguageCode: "en" },
		{ languageCode: "en" },
		null,
		guest("I already paid a deposit"),
		{ missingReason: "missing_details" }
	);
	assert(/confirmation number/i.test(reply));
	assert(/exact reservation name/i.test(reply));
	assert(/check-in and checkout dates/i.test(reply));
	assert(!/room type|nationality|adult|guest count/i.test(reply));
	const ambiguous = orchestrator.buildMissingReservationConfirmationMessage(
		{ preferredLanguageCode: "en" },
		{},
		guest("My name is Mohamed Gaber and dates are July 27 to August 3"),
		"multiple_matches"
	);
	assert(/more than one reservation/i.test(ambiguous));
	assert(/confirmation number/i.test(ambiguous));
});

check("Saudi reception number is gated to paid guests after 909 administration contact", () => {
	const reservation = {
		confirmation_number: "8940361462",
		total_amount: 525,
		paid_amount: 78.75,
		payment: "paypal",
		payment_details: {},
		paypal_details: {},
	};
	const latest = guest("No, I need the Saudi reception number please");
	const noPriorContact = { preferredLanguageCode: "en", conversation: [latest] };
	assert.strictEqual(orchestrator.latestGuestInsistsOnPaidReceptionPhone(latest.message), true);
	assert.strictEqual(
		orchestrator.paidReceptionPhoneAllowed({
			reservation,
			sc: noPriorContact,
			latestGuest: latest,
		}),
		false
	);
	const firstReply = orchestrator.buildReservationLookupMessage(
		noPriorContact,
		{ confirmation: "8940361462", languageCode: "en" },
		reservation,
		latest
	);
	assert(firstReply.includes("+1 (909) 222-3374"));
	assert(!orchestrator.replyContainsPaidGuestReceptionPhone(firstReply));
	const priorAdmin = ai("Please WhatsApp administration at +1 (909) 222-3374\nhttps://wa.me/19092223374");
	const withPriorContact = {
		preferredLanguageCode: "en",
		conversation: [priorAdmin, latest],
	};
	assert.strictEqual(orchestrator.previousAiSharedAdminContact(withPriorContact, latest), true);
	assert.strictEqual(
		orchestrator.paidReceptionPhoneAllowed({
			reservation,
			sc: withPriorContact,
			latestGuest: latest,
		}),
		true
	);
	const allowedReply = orchestrator.buildReservationLookupMessage(
		withPriorContact,
		{ confirmation: "8940361462", languageCode: "en" },
		reservation,
		latest
	);
	assert(allowedReply.includes("+966541981804"));
	assert(orchestrator.replyContainsPaidGuestReceptionPhone(allowedReply));
	assert(!allowedReply.includes("525"));
	assert(!allowedReply.includes("8940361462"));
	assert(!allowedReply.includes("3001"));
	const unpaidReply = orchestrator.buildReservationLookupMessage(
		withPriorContact,
		{ confirmation: "8940361462", languageCode: "en" },
		{ ...reservation, paid_amount: 0 },
		latest
	);
	assert(unpaidReply.includes("+1 (909) 222-3374"));
	assert(!orchestrator.replyContainsPaidGuestReceptionPhone(unpaidReply));
});

check("Brain escalation and arrival contract requires 909 WhatsApp contact", () => {
	const prompt = orchestrator.orchestratorContractPrompt();
	assert(prompt.includes('+1 (909) 222-3374'));
	assert(prompt.includes("https://wa.me/19092223374"));
	assert(prompt.includes('action="escalate"'));
	assert(/arrival coordination/i.test(prompt));
	assert(/4:00 AM/i.test(prompt));
	assert(/confirmation that also contains a question, hesitation/i.test(prompt));
	const priority = orchestrator.priorityBrainRules({});
	assert(/unresolved question, hesitation, wait\/later request/i.test(priority));
	assert(/must not create the reservation/i.test(priority));
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
	const preBookingReply = orchestrator.buildPreBookingPayAtHotelMessage(
		{ clientName: "Shaimaa Elsherif", preferredLanguageCode: "en" },
		{ languageCode: "en" },
		guest("Yes, complete it. Can I pay at the hotel?")
	);
	assert(/pay at the hotel on arrival/i.test(preBookingReply));
	assert(/online payment is not mandatory/i.test(preBookingReply));
	assert(/not created the reservation yet/i.test(preBookingReply));
	assert(!/confirmation number/i.test(preBookingReply));
	assert.strictEqual(
		orchestrator.paymentAtHotelReplyNeedsCorrection(
			{ action: "reply", reply },
			guest(liveQuestion),
			{ confirmation: "2544466389", reservationAlreadyConfirmed: true }
		),
		false
	);
});

check("Reservation processing status is transient wording and never claims completion", () => {
	const arabic = orchestrator.reservationProcessingStatusText(
		{ preferredLanguageCode: "ar" },
		{ languageCode: "ar" }
	);
	const english = orchestrator.reservationProcessingStatusText(
		{ preferredLanguageCode: "en" },
		{ languageCode: "en" }
	);
	assert(/\u062f\u0642\u064a\u0642\u0629/u.test(arabic));
	assert(/\u0631\u0642\u0645 \u0627\u0644\u062a\u0623\u0643\u064a\u062f/u.test(arabic));
	assert(/up to one minute/i.test(english));
	assert(/confirmation number/i.test(english));
	assert(!/reservation (?:is|was) (?:confirmed|created|complete)/i.test(english));
});

check("Reservation processing acknowledgements do not interrupt final creation", () => {
	const confirmation = guest("\u0625\u062a\u0645\u0627\u0645 \u0627\u0644\u062d\u062c\u0632");
	confirmation.clientTag = "confirmation-turn";
	confirmation.date = new Date("2026-07-11T12:00:00.000Z");
	const acknowledgement = guest("\u062a\u0645\u0627\u0645\u060c \u062e\u0630 \u0648\u0642\u062a\u0643");
	acknowledgement.clientTag = "wait-ack";
	acknowledgement.date = new Date("2026-07-11T12:00:04.000Z");
	assert(orchestrator.guestAcknowledgesReservationProcessing("Take your time"));
	assert(orchestrator.guestAcknowledgesReservationProcessing("Ok"));
	assert(orchestrator.guestAcknowledgesReservationProcessing("No problem"));
	assert(orchestrator.guestAcknowledgesReservationProcessing("That's fine"));
	assert(orchestrator.guestAcknowledgesReservationProcessing("Take all the time you need"));
	assert(orchestrator.guestAcknowledgesReservationProcessing("Go ahead"));
	assert(orchestrator.guestAcknowledgesReservationProcessing("Please continue"));
	assert(orchestrator.guestAcknowledgesReservationProcessing("I am here"));
	assert(orchestrator.guestAcknowledgesReservationProcessing("\u0644\u0627 \u0645\u0634\u0643\u0644\u0629\u060c \u062a\u0627\u0628\u0639"));
	assert(orchestrator.guestAcknowledgesReservationProcessing("\u062a\u0645\u0627\u0645\u060c \u062e\u0630 \u0648\u0642\u062a\u0643"));
	assert(!orchestrator.guestAcknowledgesReservationProcessing("Ok, change the checkout date"));
	assert(!orchestrator.guestAcknowledgesReservationProcessing("Go ahead and change the checkout date"));
	assert(!orchestrator.guestAcknowledgesReservationProcessing("Please continue with two rooms"));
	assert(
		orchestrator.onlyReservationProcessingAcknowledgementsAfter(
			{ conversation: [ai("review", "review_reservation"), confirmation, acknowledgement] },
			confirmation
		)
	);
	const correction = guest("\u0644\u0627\u060c \u063a\u064a\u0631 \u062a\u0627\u0631\u064a\u062e \u0627\u0644\u062e\u0631\u0648\u062c");
	correction.clientTag = "correction";
	correction.date = new Date("2026-07-11T12:00:05.000Z");
	assert(
		!orchestrator.onlyReservationProcessingAcknowledgementsAfter(
			{ conversation: [confirmation, acknowledgement, correction] },
			confirmation
		)
	);
});

check("Reservation progress is recognized before queueing and planner concurrency is bounded above one", () => {
	assert(orchestrator.runtimeTuning.planMaxActiveTurns >= 2);
	assert(orchestrator.runtimeTuning.planMaxActiveTurns <= 6);
	const review = ai(
		"Official review complete. Confirm to create the reservation.",
		"review_reservation"
	);
	const confirm = guest("Complete booking", "place_reservation");
	const sc = {
		preferredLanguageCode: "en",
		conversation: [review, confirm],
		aiStateSnapshot: {
			known: {
				...quoteForTriple(),
				quote: quoteForTriple(),
				fullName: "Ahmed Test",
				phone: "+201001234567",
				nationality: "Egyptian",
			},
		},
	};
	assert(orchestrator.reservationProcessingScheduleContext(sc));
	const sideQuestion = guest(
		"Complete booking. Can I pay at the hotel?",
		"place_reservation"
	);
	assert.strictEqual(
		orchestrator.reservationProcessingScheduleContext({ ...sc, conversation: [review, sideQuestion] }),
		null
	);
});

check("Large first-turn room requests retain medium planner reasoning", () => {
	assert.strictEqual(
		orchestrator.plannerReasoningEffortForTurn(
			{},
			{},
			guest("I need 10 double rooms for 20 adults")
		),
		"medium"
	);
	assert.strictEqual(
		orchestrator.plannerReasoningEffortForTurn({}, {}, guest("Hello, how far is the hotel?")),
		"low"
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
	assert.strictEqual(orchestrator.runtimeTuning.planMaxActiveTurns >= 2, true);
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

check("Submit preserves the exact reviewed PMS room and complete price fingerprint", () => {
	const exactQuote = {
		available: true,
		checkinISO: "2026-07-20",
		checkoutISO: "2026-07-22",
		roomTypeKey: "doubleRooms",
		// This reproduces the former live state: a broad public selection plus the
		// exact priced configuration in roomLines.
		roomSelections: [{ roomTypeKey: "doubleRooms", count: 1 }],
		selectionKey: "type:doubleRooms:1",
		roomLines: [
			{
				roomId: "exact-double-room",
				roomTypeKey: "doubleRooms",
				count: 1,
				perRoomStayTotal: 150,
				lineTotal: 150,
				perNightPerRoom: [75, 75],
			},
		],
		totalRooms: 1,
		nights: 2,
		perNight: [75, 75],
		averagePerNight: 75,
		total: 150,
		currency: "SAR",
	};
	const reviewed = orchestrator.syncKnownFromQuote({
		languageCode: "ar",
		quote: exactQuote,
		fullName: "\u064a\u0627\u0633\u0631 \u0643\u0648\u062f\u0643\u0633",
		fullNameConfirmed: true,
		phone: "0530000038",
		phoneConfirmed: true,
		nationality: "\u0645\u0635\u0631\u064a",
		nationalityConfirmed: true,
		adults: 2,
		children: 0,
	});
	assert.strictEqual(reviewed.roomSelections[0].roomId, "exact-double-room");
	assert.strictEqual(orchestrator.quoteMatchesKnown(reviewed), true);

	const officialReviewSnapshot = orchestrator.officialReviewSnapshotFromKnown(reviewed);
	assert.strictEqual(officialReviewSnapshot.version, 2);
	assert.strictEqual(
		officialReviewSnapshot.roomSelections[0].roomId,
		"exact-double-room"
	);
	assert.strictEqual(
		officialReviewSnapshot.reviewedQuote.roomSelections[0].roomId,
		"exact-double-room"
	);
	assert.strictEqual(
		orchestrator.officialReviewCheckpointUsable({
			...reviewed,
			officialReviewSnapshot,
		}),
		true
	);
	assert.strictEqual(
		orchestrator.officialReviewCheckpointUsable({
			...reviewed,
			officialReviewSnapshot: {
				...officialReviewSnapshot,
				reviewedQuote: {
					...officialReviewSnapshot.reviewedQuote,
					total: 999,
				},
			},
		}),
		true,
		"a self-consistent stored price can be reviewed, but final refresh must still compare it"
	);
	assert.strictEqual(
		orchestrator.officialReviewCheckpointUsable({
			...reviewed,
			officialReviewSnapshot: { version: 1 },
		}),
		false
	);
	const forcedSubmitDecision = orchestrator.forceOfficialReviewSubmitDecision({
		action: "submit_reservation",
		facts: {
			roomSelections: [{ roomTypeKey: "doubleRooms", count: 3 }],
			adults: 3,
			fullName: "\u0645\u0644\u062e\u0635 \u0627\u0644\u062d\u062c\u0632",
		},
		memory: {
			changedFields: ["roomSelections", "adults", "fullName"],
			missingFields: [],
		},
	});
	assert.deepStrictEqual(forcedSubmitDecision.facts, {});
	assert.deepStrictEqual(forcedSubmitDecision.memory.changedFields, []);
	const checkpointAfterBrainMerge = orchestrator.mergeKnownFacts(
		{ ...reviewed, officialReviewSnapshot },
		forcedSubmitDecision.facts
	);
	assert.strictEqual(
		checkpointAfterBrainMerge.officialReviewSnapshot.reviewedQuote.roomSelections[0].roomId,
		"exact-double-room",
		"confirmation-turn model facts must not erase or mutate the official review checkpoint"
	);

	const restored = orchestrator.applyOfficialReviewSnapshotForSubmit({
		...reviewed,
		officialReviewSnapshot,
		roomSelections: [{ roomTypeKey: "doubleRooms", count: 1 }],
		quote: {},
	});
	assert.strictEqual(restored.roomSelections[0].roomId, "exact-double-room");
	const recoveredAtSubmit = orchestrator.recoverKnownFactsFromConversation(
		{
			preferredLanguageCode: "ar",
			conversation: [
				ai("\u0645\u0631\u0627\u062c\u0639\u0629 \u0627\u0644\u062d\u062c\u0632 \u062c\u0627\u0647\u0632\u0629.", "review_reservation"),
				guest("\u0625\u062a\u0645\u0627\u0645 \u0627\u0644\u062d\u062c\u0632"),
			],
		},
		{
			...restored,
			quote: {},
		}
	);
	const recoveredReview = orchestrator.applyOfficialReviewSnapshotForSubmit(recoveredAtSubmit);
	assert.strictEqual(recoveredReview.roomSelections[0].roomId, "exact-double-room");
	assert.strictEqual(
		recoveredReview.officialReviewSnapshot.reviewedQuote.roomSelections[0].roomId,
		"exact-double-room"
	);
	const reviewedQuote = orchestrator.reviewedQuoteForSubmit(restored);
	const unchangedFreshQuote = {
		...exactQuote,
		roomSelections: officialReviewSnapshot.roomSelections,
		selectionKey: "id:exact-double-room:1",
	};
	assert.strictEqual(
		orchestrator.quoteMateriallyChanged(reviewedQuote, unchangedFreshQuote),
		false
	);
	assert.strictEqual(
		orchestrator.quoteMateriallyChanged(reviewedQuote, {
			...unchangedFreshQuote,
			perNight: [74, 76],
		}),
		true,
		"a nightly price redistribution must require a fresh review even when the total is unchanged"
	);
	assert.strictEqual(
		orchestrator.quoteMateriallyChanged(reviewedQuote, {
			...unchangedFreshQuote,
			roomSelections: [
				{ roomId: "different-double-room", roomTypeKey: "doubleRooms", count: 1 },
			],
			roomLines: [
				{
					...unchangedFreshQuote.roomLines[0],
					roomId: "different-double-room",
				},
			],
		}),
		true,
		"a different physical room configuration must require a fresh review"
	);
	assert.deepStrictEqual(
		orchestrator.reviewedQuoteForSubmit({
			officialReviewSnapshot: { version: 2, reviewedQuote: { available: true } },
			quote: unchangedFreshQuote,
		}),
		{},
		"a malformed version-2 review fingerprint must fail closed instead of using mutable state"
	);
	assert.deepStrictEqual(
		orchestrator.reviewedQuoteForSubmit({
			officialReviewSnapshot: { version: 1 },
			quote: {},
		}),
		{},
		"a legacy review without a server quote must require another review"
	);
	const staleConfirmationConversation = {
		conversation: [
			ai("Official review", "review_reservation"),
			guest("Yes, complete"),
			ai("The price changed; please continue after the new quote.", "quote_ready"),
			guest("Continue"),
		],
	};
	assert.strictEqual(
		orchestrator.guestConfirmedAfterLatestReview(staleConfirmationConversation),
		true,
		"fixture must reproduce the historical confirmation-memory signal"
	);
	assert.strictEqual(
		orchestrator.latestGuestConfirmsAfterOfficialReview(
			staleConfirmationConversation,
			staleConfirmationConversation.conversation.at(-1)
		),
		true,
		"the current continue message is itself a confirmation signal"
	);
	const unrelatedAfterOldConfirmation = {
		conversation: [
			...staleConfirmationConversation.conversation.slice(0, -1),
			guest("Does the hotel have a bus?"),
		],
	};
	assert.strictEqual(
		orchestrator.guestConfirmedAfterLatestReview(unrelatedAfterOldConfirmation),
		true,
		"fixture must retain the old broad memory behavior"
	);
	assert.strictEqual(
		orchestrator.latestGuestConfirmsAfterOfficialReview(
			unrelatedAfterOldConfirmation,
			unrelatedAfterOldConfirmation.conversation.at(-1)
		),
		false,
		"an unrelated latest question must never reuse an older confirmation"
	);
	assert.strictEqual(
		orchestrator.officialReviewCheckpointUsable({ quote: unchangedFreshQuote }),
		false,
		"a fresh quote without a renewed version-2 review cannot reuse old consent"
	);
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
		orchestrator.confirmationTurnContainsReviewedBookingFacts(submitText),
		false
	);
	assert.strictEqual(
		orchestrator.confirmationTurnContainsReviewedBookingFacts(
			"\u0646\u0639\u0645\u060c \u0648\u0644\u0643\u0646 \u0627\u0644\u062c\u0648\u0627\u0644 0530000099"
		),
		true
	);
	assert.strictEqual(
		orchestrator.confirmationTurnContainsReviewedBookingFacts(
			"Yes, complete it, but use 2 double rooms for 4 adults"
		),
		true
	);
	for (const correction of [
		"Yes, but no children",
		"Yes, but it is only me",
		"Yes, but me and my wife",
		"Yes, but check-in is July 28, 2026",
		"Yes, but checkout is July 30",
		"move arrival to 28/07/2026",
		"phone is +966541234567\nyes, complete",
	]) {
		assert.strictEqual(
			orchestrator.confirmationTurnContainsReviewedBookingFacts(correction, {
				checkinISO: "2026-07-21",
				checkoutISO: "2026-07-23",
				adults: 2,
				children: 0,
			}),
			true,
			`review correction was misclassified as a pure confirmation: ${correction}`
		);
	}
	for (const question of [
		"Yes, complete it. Does the hotel have parking?",
		"Yes, book it, but is breakfast included?",
		"Yes, complete the booking. How far is the Haram?",
		"Yes, complete it. What is the cancellation policy?",
		"Yes, go ahead. Can I pay at the hotel?",
	]) {
		const latest = guest(question);
		assert.strictEqual(
			orchestrator.confirmationTurnHasUnresolvedQuestion(
				{ conversation: [ai("Review", "review_reservation"), latest] },
				latest
			),
			true,
			`compound confirmation question was treated as pure consent: ${question}`
		);
	}
	for (const requestedChange of [
		"Yes, but can you use phone +966541234567?",
		"Yes, but can you make it 2 triple rooms?",
		"Yes, but could you make it 4 adults?",
		"Yes, but can checkout be July 30, 2026?",
	]) {
		assert.strictEqual(
			orchestrator.confirmationQuestionRequestsReviewedBookingChange(requestedChange, {
				checkinISO: "2026-07-21",
				checkoutISO: "2026-07-23",
				phone: "+966500000000",
				roomSelections: [{ roomTypeKey: "doubleRooms", count: 1 }],
				adults: 2,
				children: 0,
			}),
			true,
			`explicit review correction question was treated as an ordinary side question: ${requestedChange}`
		);
	}
	for (const factQuestion of [
		"Yes, complete it. Does the double room have parking?",
		"Yes, complete it. What time is check-in?",
		"Yes, book it, but is breakfast included?",
	]) {
		assert.strictEqual(
			orchestrator.confirmationQuestionRequestsReviewedBookingChange(factQuestion, {
				roomSelections: [{ roomTypeKey: "doubleRooms", count: 1 }],
				adults: 2,
				children: 0,
			}),
			false,
			`hotel fact question was incorrectly treated as a reviewed booking change: ${factQuestion}`
		);
	}
	for (const pureConfirmation of [
		"Yes, that is correct",
		"Yes, everything is correct, complete it",
		"Yes, all details are correct",
		"Yes, I will proceed",
		"Yes, you can book it",
		"Yes, please do book it",
		"Yes, this is fine, go ahead",
	]) {
		const latest = guest(pureConfirmation);
		assert.strictEqual(
			orchestrator.confirmationTurnHasUnresolvedQuestion(
				{ conversation: [ai("Review", "review_reservation"), latest] },
				latest
			),
			false,
			`pure confirmation was misclassified as a side question: ${pureConfirmation}`
		);
	}
	for (const deferred of [
		"Yes, but wait",
		"Yes, hold on",
		"Yes, but let me think",
		"Yes, maybe later",
		"Okay, give me a moment",
		"\u0646\u0639\u0645\u060c \u0644\u0643\u0646 \u0627\u0633\u062a\u0646\u0649 \u0644\u062d\u0638\u0629",
	]) {
		assert.strictEqual(
			orchestrator.confirmationTurnDefersBooking(deferred),
			true,
			`hesitation was treated as immediate consent: ${deferred}`
		);
	}
	const deferredReply = orchestrator.buildReviewedBookingDeferredMessage(
		{ clientName: "Gamal", preferredLanguageCode: "en" },
		{ languageCode: "en" },
		guest("Yes, but wait")
	);
	assert(/not created the reservation/i.test(deferredReply));
	assert(/reviewed details remain ready/i.test(deferredReply));
	assert(/Complete booking/i.test(deferredReply));
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
