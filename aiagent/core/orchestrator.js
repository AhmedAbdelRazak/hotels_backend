// aiagent/core/orchestrator.js
const { AsyncLocalStorage } = require("async_hooks");
const {
	getSupportCaseById,
	updateSupportCaseAppend,
	updateSupportCaseAppendIfNoRecentAiDuplicate,
	closeSupportCaseForAiIdle,
	getHotelById,
	getReservationByConfirmation,
	listActivePublicHotels,
	listPreviousGuestSupportChats,
	listRelevantTrainingChats,
} = require("./db");
const { ensureAIAllowed } = require("./policy");

const {
	listAvailableRoomsForStay,
	roomHasAmenity,
	hotelHasAmenity,
	findAmenityMatch,
} = require("./selectors");

const {
	nluStep,
	firstNameOf,
	validateNationalityLLM,
	normalizeNameLLM,
	mapRoomToKey,
	quickDateRange,
	asciiize,
	digitsToEnglish,
	detectAmenityQuestion,
} = require("./nlu");
const { hasSemanticSignal } = require("./scriptSignals");
const { normalizeNumberWordsForParsing, numberFromWords } = require("./numberWords");

const { chat } = require("./openai");
const {
	createReservationForCase,
	updateReservationDatesForCase,
	getReservationCancellationPolicyForCase,
	dispatchAiReservationConfirmation,
} = require("./actions");
const {
	isJannatBookingSupportCase,
} = require("../../services/jannatBookingSupportScope");
const {
	activeHotelPolicyQA,
	DEFAULT_CANCELLATION_REFUND_ANSWER,
} = require("../../services/hotelPolicyQa");
const {
	waNotifyImmediateSupportEscalation,
} = require("../../controllers/whatsappsender");

const DEFAULT_AGENT_POOL = ["Hana", "Aisha", "Sara", "Amira", "Yasmin", "Nadia"];
const AI_SUPPORT_EMAIL = "support@jannatbooking.com";
const LEGACY_AI_SUPPORT_EMAIL = "management@xhotelpro.com";

function intFromEnv(name, fallback, { min = 0, max = 60000 } = {}) {
	const parsed = parseInt(process.env[name] || "", 10);
	const value = Number.isFinite(parsed) ? parsed : fallback;
	return Math.min(max, Math.max(min, value));
}

function boolFromEnv(name, fallback = false) {
	const raw = String(process.env[name] || "").trim().toLowerCase();
	if (!raw) return fallback;
	return ["1", "true", "yes", "on"].includes(raw);
}

const HUMAN_THINK_MIN_MS = intFromEnv("AI_HUMAN_THINK_MIN_MS", 900, {
	min: 0,
	max: 5000,
});
const HUMAN_THINK_MAX_MS = Math.max(
	HUMAN_THINK_MIN_MS,
	intFromEnv("AI_HUMAN_THINK_MAX_MS", 1400, { min: 0, max: 5000 })
);
const HUMAN_TYPE_CHAR_MIN_MS = intFromEnv("AI_HUMAN_TYPE_CHAR_MIN_MS", 2, {
	min: 1,
	max: 300,
});
const HUMAN_TYPE_CHAR_MAX_MS = Math.max(
	HUMAN_TYPE_CHAR_MIN_MS,
	intFromEnv("AI_HUMAN_TYPE_CHAR_MAX_MS", 5, { min: 1, max: 300 })
);
const HUMAN_TYPE_CLAMP_MIN_MS = intFromEnv("AI_HUMAN_TYPE_CLAMP_MIN_MS", 1700, {
	min: 250,
	max: 10000,
});
const HUMAN_TYPE_CLAMP_MAX_MS = Math.max(
	HUMAN_TYPE_CLAMP_MIN_MS,
	intFromEnv("AI_HUMAN_TYPE_CLAMP_MAX_MS", 3200, { min: 250, max: 15000 })
);
const HUMAN_BETWEEN_SENDS_MIN_MS = intFromEnv(
	"AI_HUMAN_BETWEEN_SENDS_MIN_MS",
	150,
	{ min: 0, max: 10000 }
);
const HUMAN_BETWEEN_SENDS_MAX_MS = Math.max(
	HUMAN_BETWEEN_SENDS_MIN_MS,
	intFromEnv("AI_HUMAN_BETWEEN_SENDS_MAX_MS", 350, {
		min: 0,
		max: 10000,
	})
);

const HUMAN = {
	greetThinkMs: intFromEnv("AI_HUMAN_GREET_THINK_MS", 1400, {
		min: 0,
		max: 7000,
	}),
	thinkMinMs: HUMAN_THINK_MIN_MS,
	thinkMaxMs: HUMAN_THINK_MAX_MS,
	typeCharMinMs: HUMAN_TYPE_CHAR_MIN_MS,
	typeCharMaxMs: HUMAN_TYPE_CHAR_MAX_MS,
	typeClampMinMs: HUMAN_TYPE_CLAMP_MIN_MS,
	typeClampMaxMs: HUMAN_TYPE_CLAMP_MAX_MS,
	betweenSendsMinMs: HUMAN_BETWEEN_SENDS_MIN_MS,
	betweenSendsMaxMs: HUMAN_BETWEEN_SENDS_MAX_MS,
};
const AI_REPLY_TARGET_MIN_MS = intFromEnv("AI_REPLY_TARGET_MIN_MS", 3000, {
	min: 500,
	max: 8000,
});
const AI_REPLY_TARGET_MAX_MS = Math.max(
	AI_REPLY_TARGET_MIN_MS,
	intFromEnv("AI_REPLY_TARGET_MAX_MS", 5000, {
		min: 500,
		max: 8000,
	})
);
const AI_CASUAL_REPLY_TARGET_MIN_MS = intFromEnv(
	"AI_CASUAL_REPLY_TARGET_MIN_MS",
	3000,
	{ min: 1500, max: 8000 }
);
const AI_CASUAL_REPLY_TARGET_MAX_MS = Math.max(
	AI_CASUAL_REPLY_TARGET_MIN_MS,
	intFromEnv("AI_CASUAL_REPLY_TARGET_MAX_MS", 4500, {
		min: 1500,
		max: 8000,
	})
);
const AI_BOOKING_QUOTE_TARGET_MS = intFromEnv("AI_BOOKING_QUOTE_TARGET_MS", 4000, {
	min: 500,
	max: 8000,
});
const AI_BOOKING_PROMPT_TARGET_MS = intFromEnv("AI_BOOKING_PROMPT_TARGET_MS", 3000, {
	min: 500,
	max: 8000,
});
const AI_CONFIRMATION_DISPATCH_DELAY_MS = intFromEnv(
	"AI_CONFIRMATION_DISPATCH_DELAY_MS",
	12000,
	{ min: 1000, max: 60000 }
);
const AI_POLICY_MEMO_TTL_MS = intFromEnv("AI_POLICY_MEMO_TTL_MS", 30000, {
	min: 5000,
	max: 5 * 60 * 1000,
});
const AI_TYPING_INDICATOR_DELAY_MIN_MS = intFromEnv(
	"AI_TYPING_INDICATOR_DELAY_MIN_MS",
	900,
	{ min: 0, max: 7000 }
);
const AI_TYPING_INDICATOR_DELAY_MAX_MS = Math.max(
	AI_TYPING_INDICATOR_DELAY_MIN_MS,
	intFromEnv("AI_TYPING_INDICATOR_DELAY_MAX_MS", 1400, {
		min: 0,
		max: 7000,
	})
);
const AI_PLANNING_TYPING_DELAY_MS = intFromEnv(
	"AI_PLANNING_TYPING_DELAY_MS",
	900,
	{ min: 0, max: 5000 }
);
const AI_GUEST_REPLY_QUIET_MS = intFromEnv("AI_GUEST_REPLY_QUIET_MS", 900, {
	min: 0,
	max: 5000,
});
const AI_RESERVATION_DETAIL_QUIET_MS = intFromEnv(
	"AI_RESERVATION_DETAIL_QUIET_MS",
	700,
	{ min: 0, max: 5000 }
);
const AI_RESERVATION_CHASE_QUIET_MS = intFromEnv(
	"AI_RESERVATION_CHASE_QUIET_MS",
	0,
	{ min: 0, max: 5000 }
);
const AI_GUEST_TYPING_HOLD_MS = intFromEnv("AI_GUEST_TYPING_HOLD_MS", 1200, {
	min: 500,
	max: 10000,
});
const AI_TYPING_MIN_VISIBLE_MS = intFromEnv("AI_TYPING_MIN_VISIBLE_MS", 800, {
	min: 0,
	max: 7000,
});
const QUOTE_NUDGE_PAUSE_MS = intFromEnv("AI_QUOTE_NUDGE_PAUSE_MS", 10 * 60 * 1000, {
	min: 30000,
	max: 60 * 60 * 1000,
});
const JANNAT_HANDOFF_DELAY_MIN_MS = intFromEnv(
	"AI_JANNAT_HANDOFF_DELAY_MIN_MS",
	5000,
	{ min: 0, max: 20000 }
);
const JANNAT_HANDOFF_DELAY_MAX_MS = Math.max(
	JANNAT_HANDOFF_DELAY_MIN_MS,
	intFromEnv("AI_JANNAT_HANDOFF_DELAY_MAX_MS", 8000, {
		min: 0,
		max: 20000,
	})
);

const SOFT_PIVOT_MS = 35000;
const QUOTE_SUMMARY_COOLDOWN = 45000;
const PUBLIC_DISCOUNT_PERCENT = 15;
const QUOTE_WRITE_SOFT_TIMEOUT_MS = intFromEnv(
	"AI_QUOTE_WRITE_SOFT_TIMEOUT_MS",
	1800,
	{ min: 500, max: 5000 }
);
const AI_NLU_STEP_SOFT_TIMEOUT_MS = intFromEnv(
	"AI_NLU_STEP_SOFT_TIMEOUT_MS",
	4000,
	{ min: 1500, max: 20000 }
);
const AI_REQUIRE_NATIONALITY = boolFromEnv("AI_REQUIRE_NATIONALITY", true);
const AI_INSTANT_PROGRESS_ENABLED = boolFromEnv(
	"AI_INSTANT_PROGRESS_ENABLED",
	false
);
const AI_MESSAGE_DEDUPE_WINDOW_MS = intFromEnv(
	"AI_MESSAGE_DEDUPE_WINDOW_MS",
	2 * 60 * 1000,
	{ min: 30000, max: 10 * 60 * 1000 }
);
const AI_IDLE_FOLLOWUPS_ENABLED = boolFromEnv(
	"AI_IDLE_FOLLOWUPS_ENABLED",
	true
);
const AI_IDLE_FIRST_FOLLOWUP_MS = intFromEnv(
	"AI_IDLE_FIRST_FOLLOWUP_MS",
	60 * 1000,
	{ min: 60 * 1000, max: 10 * 60 * 1000 }
);
const AI_IDLE_CLOSE_MS = intFromEnv("AI_IDLE_CLOSE_MS", 5 * 60 * 1000, {
	min: 5 * 60 * 1000,
	max: 60 * 60 * 1000,
});
const AI_POST_BOOKING_CLOSE_MS = intFromEnv(
	"AI_POST_BOOKING_CLOSE_MS",
	5000,
	{ min: 1000, max: 30000 }
);
const AI_TURN_STALL_RECOVERY_MS = intFromEnv(
	"AI_TURN_STALL_RECOVERY_MS",
	8 * 1000,
	{ min: 5 * 1000, max: 2 * 60 * 1000 }
);
const AI_TURN_LOCK_RETRY_MS = intFromEnv("AI_TURN_LOCK_RETRY_MS", 350, {
	min: 100,
	max: 3000,
});
const AI_TURN_SLOW_LOG_MS = intFromEnv("AI_TURN_SLOW_LOG_MS", 5000, {
	min: 1000,
	max: 60 * 1000,
});
const AI_DELAY_NOTICE_MS = intFromEnv("AI_DELAY_NOTICE_MS", 10000, {
	min: 8000,
	max: 30000,
});
const AI_DELAY_NOTICE_ENABLED = boolFromEnv("AI_DELAY_NOTICE_ENABLED", false);
const AI_DELAY_NOTICE_COOLDOWN_MS = intFromEnv(
	"AI_DELAY_NOTICE_COOLDOWN_MS",
	5 * 60 * 1000,
	{ min: 60000, max: 30 * 60 * 1000 }
);
const AI_PREVIOUS_GUEST_CONTEXT_ENABLED = boolFromEnv(
	"AI_PREVIOUS_GUEST_CONTEXT_ENABLED",
	false
);

function randomBetween(a, b) {
	return Math.floor(a + Math.random() * (b - a + 1));
}
function casualReplyTargetMs() {
	return randomBetween(AI_CASUAL_REPLY_TARGET_MIN_MS, AI_CASUAL_REPLY_TARGET_MAX_MS);
}
function now() {
	return Date.now();
}
function toTitle(s = "") {
	return String(s || "").replace(
		/\w\S*/g,
		(m) => m[0].toUpperCase() + m.slice(1)
	);
}
function uniqueAgentNames(names = []) {
	return [
		...new Set(
			names
				.map((name) => String(name || "").trim().replace(/\s+/g, " "))
				.filter(Boolean)
		),
	];
}
function configuredAgentPool() {
	const configured = uniqueAgentNames(
		[process.env.B2C_AI_RESPONDER_NAMES, process.env.AI_RESPONDER_NAMES]
			.flatMap((value) => String(value || "").split(","))
	);
	return configured.length >= 2 ? configured : DEFAULT_AGENT_POOL;
}
function usDate(iso) {
	if (!iso) return "";
	const d = new Date(iso + "T00:00:00");
	return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(
		d.getDate()
	).padStart(2, "0")}/${d.getFullYear()}`;
}
function stayDateDisplay(st = {}) {
	const raw = st.dateRaw || {};
	const gregorian = {
		checkinISO: st.slots?.checkinISO || null,
		checkoutISO: st.slots?.checkoutISO || null,
		checkin: usDate(st.slots?.checkinISO),
		checkout: usDate(st.slots?.checkoutISO),
	};
	const hijri =
		String(raw.calendar || "").toLowerCase() === "hijri"
			? {
					checkin: raw.checkin || "",
					checkout: raw.checkout || "",
					checkinHijri: raw.checkinHijri || null,
					checkoutHijri: raw.checkoutHijri || null,
			  }
			: null;
	return {
		calendarProvided: raw.calendar || null,
		gregorian,
		hijri,
		shouldShowBoth: Boolean(hijri),
	};
}

function mergeDateRangeIntoState(st = {}, dates = {}, { onlyIfMissing = false } = {}) {
	if (!dates?.checkinISO || !dates?.checkoutISO) return false;
	if (!st.slots) st.slots = {};
	if (onlyIfMissing && st.slots.checkinISO && st.slots.checkoutISO) {
		return false;
	}
	st.slots.checkinISO = onlyIfMissing
		? st.slots.checkinISO || dates.checkinISO
		: dates.checkinISO;
	st.slots.checkoutISO = onlyIfMissing
		? st.slots.checkoutISO || dates.checkoutISO
		: dates.checkoutISO;

	const raw = dates.raw || {};
	const calendar = raw.calendar || "gregorian";
	st.dateRaw = {
		calendar,
		checkin: raw.checkin || dates.checkinISO,
		checkout: raw.checkout || dates.checkoutISO,
	};
	if (String(calendar).toLowerCase() === "hijri") {
		if (raw.checkinHijri) st.dateRaw.checkinHijri = raw.checkinHijri;
		if (raw.checkoutHijri) st.dateRaw.checkoutHijri = raw.checkoutHijri;
	}
	return true;
}

function dateRangeKey(dates = {}) {
	if (!dates?.checkinISO || !dates?.checkoutISO) return "";
	return `${dates.checkinISO}|${dates.checkoutISO}`;
}

function currentDateRange(st = {}) {
	if (!st.slots?.checkinISO || !st.slots?.checkoutISO) return null;
	return {
		checkinISO: st.slots.checkinISO,
		checkoutISO: st.slots.checkoutISO,
		raw: st.dateRaw || null,
	};
}

function dateRangeConflictsWithState(st = {}, dates = {}) {
	const current = currentDateRange(st);
	if (!current || !dates?.checkinISO || !dates?.checkoutISO) return false;
	return dateRangeKey(current) !== dateRangeKey(dates);
}

function rememberPendingDateChange(st = {}, dates = {}, { source = "", userText = "" } = {}) {
	if (!dateRangeConflictsWithState(st, dates)) return null;
	const current = currentDateRange(st);
	const existing = st.pendingDateChange || {};
	if (
		dateRangeKey(existing.proposed || {}) === dateRangeKey(dates) &&
		dateRangeKey(existing.previous || {}) === dateRangeKey(current || {})
	) {
		return existing;
	}
	st.pendingDateChange = {
		previous: current,
		proposed: dates,
		previousWaitFor: st.waitFor || "",
		previousReviewSent: Boolean(st.reviewSent),
		previousQuoteKey: st.quote?.key || "",
		source,
		userText: String(userText || "").slice(0, 240),
		createdAt: now(),
		askedAt: 0,
	};
	return st.pendingDateChange;
}

function clearPendingDateChange(st = {}) {
	st.pendingDateChange = null;
}

function activeDateSensitiveBookingState(st = {}) {
	const waitFor = String(st.waitFor || "");
	return Boolean(
			st.quote ||
			st.reviewSent ||
			st.quoteSummarizedAt ||
			st.pendingRoomAlternative ||
			st.pendingRoomCombination ||
			[
				"proceed",
				"reviewConfirm",
				"reservation_details",
				"fullname",
				"nationality",
				"phone",
				"email_or_skip",
				"finalize",
				"large_group_confirm",
			].includes(waitFor)
	);
}

function shouldConfirmDateRangeChange(st = {}, dates = {}) {
	return (
		dateRangeConflictsWithState(st, dates) &&
		activeDateSensitiveBookingState(st)
	);
}

function resetBookingAfterDateRangeChange(st = {}) {
	st.quote = null;
	st.quoteSummarizedAt = 0;
	st.reviewSent = false;
	st.bookingNudgePausedAt = 0;
	st.pendingRoomAlternative = null;
}

function applyDateRangeToState(st = {}, dates = {}, { resetQuote = true } = {}) {
	const changed = dateRangeConflictsWithState(st, dates);
	const applied = mergeDateRangeIntoState(st, dates);
	if (applied && changed && resetQuote) resetBookingAfterDateRangeChange(st);
	if (applied) clearPendingDateChange(st);
	return applied;
}

function combinedDateRangeFromPartial(st = {}, partial = {}) {
	const current = currentDateRange(st);
	if (!current) return null;
	const proposed = {
		checkinISO: partial.checkinISO || current.checkinISO,
		checkoutISO: partial.checkoutISO || current.checkoutISO,
		raw: {
			...(st.dateRaw || {}),
			...(partial.raw || {}),
		},
	};
	if (!proposed.checkinISO || !proposed.checkoutISO) return null;
	if (proposed.checkoutISO <= proposed.checkinISO) return null;
	if (!dateRangeConflictsWithState(st, proposed)) return null;
	return proposed;
}

function applyPartialDateToState(st = {}, partial = {}) {
	if (!partial || (!partial.raw && !partial.checkinISO && !partial.checkoutISO)) {
		return false;
	}
	if (!st.slots) st.slots = {};
	const raw = partial.raw || {};
	if (raw.checkin || raw.checkout || raw.calendar || raw.checkinHijri || raw.checkoutHijri) {
		st.dateRaw = {
			...(st.dateRaw || {}),
			...(raw.calendar ? { calendar: raw.calendar } : {}),
			...(raw.checkin ? { checkin: raw.checkin } : {}),
			...(raw.checkout ? { checkout: raw.checkout } : {}),
			...(raw.checkinHijri ? { checkinHijri: raw.checkinHijri } : {}),
			...(raw.checkoutHijri ? { checkoutHijri: raw.checkoutHijri } : {}),
		};
	}
	if (partial.checkinISO) st.slots.checkinISO = partial.checkinISO;
	if (partial.checkoutISO) st.slots.checkoutISO = partial.checkoutISO;
	return true;
}

function localizedDateRangeFromDates(dates = {}, lang = "English") {
	if (!dates?.checkinISO || !dates?.checkoutISO) return "";
	const checkin = localizedGregorianDate(dates.checkinISO, lang);
	const checkout = localizedGregorianDate(dates.checkoutISO, lang);
	return `${checkin} - ${checkout}`;
}

function pendingDateChangeQuickReplies(sc = {}, st = {}) {
	const lang = languageOf(sc, st);
	const proposed = st.pendingDateChange?.proposed || {};
	const proposedText =
		proposed.checkinISO && proposed.checkoutISO
			? `${proposed.checkinISO} to ${proposed.checkoutISO}`
			: "";
	if (/arabic/i.test(lang)) {
		return [
			{
				label: "\u0627\u0633\u062a\u062e\u062f\u0645 \u0627\u0644\u062a\u0648\u0627\u0631\u064a\u062e \u0627\u0644\u062c\u062f\u064a\u062f\u0629",
				value: proposedText
					? `\u0627\u0633\u062a\u062e\u062f\u0645 \u0627\u0644\u062a\u0648\u0627\u0631\u064a\u062e \u0627\u0644\u062c\u062f\u064a\u062f\u0629 ${proposedText}`
					: "\u0627\u0633\u062a\u062e\u062f\u0645 \u0627\u0644\u062a\u0648\u0627\u0631\u064a\u062e \u0627\u0644\u062c\u062f\u064a\u062f\u0629",
				action: "confirm_date_change",
			},
			{
				label: "\u0627\u0628\u0642 \u0627\u0644\u062a\u0648\u0627\u0631\u064a\u062e \u0627\u0644\u062d\u0627\u0644\u064a\u0629",
				value: "\u0627\u0628\u0642 \u0627\u0644\u062a\u0648\u0627\u0631\u064a\u062e \u0627\u0644\u062d\u0627\u0644\u064a\u0629",
				action: "keep_existing_dates",
			},
		];
	}
	if (/spanish/i.test(lang)) {
		return [
			{
				label: "Usar nuevas fechas",
				value: proposedText ? `Usar nuevas fechas ${proposedText}` : "Usar nuevas fechas",
				action: "confirm_date_change",
			},
			{
				label: "Mantener fechas actuales",
				value: "Mantener fechas actuales",
				action: "keep_existing_dates",
			},
		];
	}
	if (/french/i.test(lang)) {
		return [
			{
				label: "Utiliser ces dates",
				value: proposedText ? `Utiliser ces dates ${proposedText}` : "Utiliser ces dates",
				action: "confirm_date_change",
			},
			{
				label: "Garder les dates actuelles",
				value: "Garder les dates actuelles",
				action: "keep_existing_dates",
			},
		];
	}
	return [
		{
			label: "Use New Dates",
			value: proposedText ? `Use new dates ${proposedText}` : "Use new dates",
			action: "confirm_date_change",
		},
		{
			label: "Keep Current Dates",
			value: "Keep current dates",
			action: "keep_existing_dates",
		},
	];
}

function pendingDateChangePromptText(sc = {}, st = {}, pending = {}) {
	const lang = languageOf(sc, st);
	const name = respectfulGuestName(sc, st);
	const current = localizedDateRangeFromDates(pending.previous, lang);
	const proposed = localizedDateRangeFromDates(pending.proposed, lang);
	if (/arabic/i.test(lang)) {
		return `${name}\u060c \u0644\u062f\u064a \u062d\u0627\u0644\u064a\u0627\u064b \u062a\u0648\u0627\u0631\u064a\u062e ${current}. \u0648\u0635\u0644\u0646\u064a \u0623\u064a\u0636\u0627\u064b \u062a\u0648\u0627\u0631\u064a\u062e \u062c\u062f\u064a\u062f\u0629 ${proposed}. \u0647\u0644 \u0623\u062d\u062f\u062b \u0627\u0644\u062d\u062c\u0632 \u0625\u0644\u0649 \u0627\u0644\u062a\u0648\u0627\u0631\u064a\u062e \u0627\u0644\u062c\u062f\u064a\u062f\u0629\u060c \u0623\u0645 \u0623\u0628\u0642\u064a \u0627\u0644\u062a\u0648\u0627\u0631\u064a\u062e \u0627\u0644\u062d\u0627\u0644\u064a\u0629\u061f`;
	}
	if (/spanish/i.test(lang)) {
		return `${name}, ahora tengo las fechas ${current}. Tambien recibi nuevas fechas: ${proposed}. Quieres que actualice esta reserva a las nuevas fechas, o mantengo las actuales?`;
	}
	if (/french/i.test(lang)) {
		return `${name}, j'ai actuellement les dates ${current}. Je viens aussi de recevoir de nouvelles dates: ${proposed}. Voulez-vous que je mette cette reservation sur les nouvelles dates, ou dois-je garder les dates actuelles ?`;
	}
	return `${name}, I currently have ${current}. I also saw new dates: ${proposed}. Should I update this booking to the new dates, or keep the current dates?`;
}

function pendingDateKeptText(sc = {}, st = {}, pending = {}) {
	const lang = languageOf(sc, st);
	const name = respectfulGuestName(sc, st);
	const current = localizedDateRangeFromDates(pending.previous || currentDateRange(st), lang);
	if (/arabic/i.test(lang)) {
		return `${name}\u060c \u062a\u0645\u0627\u0645\u060c \u0633\u0623\u0628\u0642\u064a \u0627\u0644\u062a\u0648\u0627\u0631\u064a\u062e \u0627\u0644\u062d\u0627\u0644\u064a\u0629 ${current}.`;
	}
	if (/spanish/i.test(lang)) {
		return `${name}, perfecto, mantendre las fechas actuales: ${current}.`;
	}
	if (/french/i.test(lang)) {
		return `${name}, tres bien, je garde les dates actuelles: ${current}.`;
	}
	return `${name}, no problem. I will keep the current dates: ${current}.`;
}

function pendingDateChoiceFromGuest(sc = {}, userText = "") {
	const action = lastGuestAction(sc).toLowerCase();
	if (action === "confirm_date_change") return "confirm";
	if (action === "keep_existing_dates") return "keep";
	const { lower, arabic, latinCompact } = normalizeControlText(userText);
	if (
		/\b(?:use|apply|update|change|switch)\b.{0,40}\b(?:new|these|dates?)\b/i.test(lower) ||
		/(?:usenewdates|applynewdates|updatetonewdates|change_dates|changedates|switchdates)/i.test(
			latinCompact
		) ||
		/(?:\u0627\u0633\u062a\u062e\u062f\u0645|\u063a\u064a\u0631|\u063a\u064a\u0631\u064a|\u062d\u062f\u062b|\u062d\u062f\u062b\u064a).{0,30}(?:\u0627\u0644\u062c\u062f\u064a\u062f|\u0627\u0644\u062a\u0648\u0627\u0631\u064a\u062e)/i.test(
			arabic
		)
	) {
		return "confirm";
	}
	if (
		/\b(?:keep|same|current|old|previous|do not change|dont change|no change)\b/i.test(
			lower
		) ||
		/(?:keepcurrent|samecurrent|dontchange|donotchange|keepdates)/i.test(
			latinCompact
		) ||
		/(?:\u0627\u0628\u0642|\u062e\u0644\u064a|\u0646\u0641\u0633|\u0627\u0644\u062d\u0627\u0644\u064a|\u0627\u0644\u0642\u062f\u064a\u0645|\u0628\u062f\u0648\u0646\s+\u062a\u063a\u064a\u064a\u0631)/i.test(
			arabic
		)
	) {
		return "keep";
	}
	if (confirmsText(userText)) return "confirm";
	if (declinesText(userText) || correctionText(userText)) return "keep";
	return "";
}

const ARABIC_HIJRI_MONTHS = [
	"\u0645\u062d\u0631\u0645",
	"\u0635\u0641\u0631",
	"\u0631\u0628\u064a\u0639 \u0627\u0644\u0623\u0648\u0644",
	"\u0631\u0628\u064a\u0639 \u0627\u0644\u0622\u062e\u0631",
	"\u062c\u0645\u0627\u062f\u0649 \u0627\u0644\u0623\u0648\u0644\u0649",
	"\u062c\u0645\u0627\u062f\u0649 \u0627\u0644\u0622\u062e\u0631\u0629",
	"\u0631\u062c\u0628",
	"\u0634\u0639\u0628\u0627\u0646",
	"\u0631\u0645\u0636\u0627\u0646",
	"\u0634\u0648\u0627\u0644",
	"\u0630\u0648 \u0627\u0644\u0642\u0639\u062f\u0629",
	"\u0630\u0648 \u0627\u0644\u062d\u062c\u0629",
];

function hasArabicScript(value = "") {
	return /[\u0600-\u06FF]/.test(String(value || ""));
}

function arabicDigits(value = "") {
	return String(value ?? "").replace(/\d/g, (digit) =>
		String.fromCharCode(0x0660 + Number(digit))
	);
}

function localizedHotelName(sc = {}, st = {}) {
	const lang = languageOf(sc, st);
	const other = String(st.hotel?.hotelName_OtherLanguage || "").trim();
	if (/arabic/i.test(lang) && other && hasArabicScript(other)) return other;
	return toTitle(st.hotel?.hotelName || sc.displayName2 || "Hotel");
}

function localizedRoomName(sc = {}, st = {}, quote = {}) {
	const lang = languageOf(sc, st);
	const room = quote?.room || {};
	const roomType = room.roomType || st.slots?.roomTypeKey || "";
	const hotelRoom = Array.isArray(st.hotel?.roomCountDetails)
		? st.hotel.roomCountDetails.find((item) => item?.roomType === roomType)
		: null;
	const other = String(
		room.displayName_OtherLanguage ||
			room.displayNameOther ||
			hotelRoom?.displayName_OtherLanguage ||
			hotelRoom?.displayNameOther ||
			""
	).trim();
	if (/arabic/i.test(lang) && other && hasArabicScript(other)) return other;
	return (
		room.displayName ||
		hotelRoom?.displayName ||
		room.roomType ||
		roomTypeLabel(st.slots?.roomTypeKey)
	);
}

function localizedCurrencyLabel(currency = "SAR", lang = "English") {
	const code = cleanCurrency(currency || "SAR");
	if (/arabic/i.test(lang) && code === "SAR") {
		return "\u0631\u064a\u0627\u0644 \u0633\u0639\u0648\u062f\u064a";
	}
	return code;
}

function localizedNumber(value, lang = "English") {
	const raw =
		typeof value === "number" && Number.isFinite(value)
			? Number.isInteger(value)
				? String(value)
				: String(Number(value.toFixed(2)))
			: String(value ?? "");
	return /arabic/i.test(lang) ? arabicDigits(raw) : raw;
}

function localizedMoney(value, currency = "SAR", lang = "English") {
	const amount = localizedNumber(value, lang);
	const label = localizedCurrencyLabel(currency, lang);
	return [amount, label].filter(Boolean).join(" ");
}

function arabicHijriDate(parts = null, fallback = "") {
	const month = Number(parts?.month || 0);
	const day = Number(parts?.day || 0);
	const year = Number(parts?.year || 0);
	if (month >= 1 && month <= 12 && day && year) {
		return `${arabicDigits(day)} ${ARABIC_HIJRI_MONTHS[month - 1]} ${arabicDigits(
			year
		)}\u0647\u0640`;
	}
	return arabicDigits(fallback || "");
}

function localizedGregorianDate(iso = "", lang = "English") {
	if (!iso) return "";
	if (!/arabic/i.test(lang)) return usDate(iso);
	try {
		return new Intl.DateTimeFormat("ar-EG-u-nu-arab", {
			timeZone: "UTC",
			day: "numeric",
			month: "long",
			year: "numeric",
		}).format(new Date(`${iso}T12:00:00Z`));
	} catch {
		return arabicDigits(usDate(iso));
	}
}

function localizedStayDateLines(sc = {}, st = {}) {
	const lang = languageOf(sc, st);
	const display = stayDateDisplay(st);
	const gregorianLine = `${localizedGregorianDate(
		st.slots?.checkinISO,
		lang
	)} \u2013 ${localizedGregorianDate(st.slots?.checkoutISO, lang)}`;
	if (!/arabic/i.test(lang)) {
		if (display.hijri?.checkin && display.hijri?.checkout) {
			return {
				primary: `${display.hijri.checkin} to ${display.hijri.checkout}`,
				secondary: `Gregorian: ${gregorianLine}`,
			};
		}
		return { primary: gregorianLine, secondary: "" };
	}
	if (display.hijri?.checkin || display.hijri?.checkinHijri) {
		return {
			primary: `${arabicHijriDate(
				display.hijri.checkinHijri,
				display.hijri.checkin
			)} \u2013 ${arabicHijriDate(
				display.hijri.checkoutHijri,
				display.hijri.checkout
			)}`,
			secondary: `\u0627\u0644\u0645\u064a\u0644\u0627\u062f\u064a: ${gregorianLine}`,
		};
	}
	return { primary: gregorianLine, secondary: "" };
}
function slugifyHotelName(name = "") {
	return String(name || "")
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, "")
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-");
}
function publicHotelUrl(hotelName = "") {
	return `https://jannatbooking.com/single-hotel/${slugifyHotelName(hotelName)}`;
}
function firstNumber(value) {
	const match = String(value || "").match(/\d+/);
	return match ? Number(match[0]) : Number.POSITIVE_INFINITY;
}
function languageOf(sc = {}, st = {}) {
	return st.language || preferredLanguageOf(sc) || "English";
}
function preferredLanguageOf(sc = {}) {
	const conversation = Array.isArray(sc.conversation) ? sc.conversation : [];
	for (let i = conversation.length - 1; i >= 0; i -= 1) {
		const language = String(conversation[i]?.preferredLanguage || "").trim();
		if (language) return language;
	}
	return String(sc.preferredLanguage || "").trim();
}
function preferredLanguageCodeOf(sc = {}) {
	const conversation = Array.isArray(sc.conversation) ? sc.conversation : [];
	for (let i = conversation.length - 1; i >= 0; i -= 1) {
		const languageCode = String(
			conversation[i]?.preferredLanguageCode || ""
		).trim();
		if (languageCode) return languageCode;
	}
	return String(sc.preferredLanguageCode || "").trim();
}
function activeLanguageCodeOf(sc = {}, st = {}) {
	return String(st.languageCode || preferredLanguageCodeOf(sc) || "").trim();
}
function targetLanguageLabel(sc = {}, st = {}) {
	const language = languageOf(sc, st) || "English";
	const languageCode = activeLanguageCodeOf(sc, st);
	return languageCode ? `${language} (${languageCode})` : language;
}

function detectGuestLanguageFromText(text = "") {
	const raw = String(text || "").trim();
	if (!raw || raw.length < 2) return null;

	const arabicLetters = (raw.match(/[\u0600-\u06FF]/g) || []).length;
	if (arabicLetters >= 2) {
		return { language: "Arabic", code: "ar", confidence: arabicLetters >= 8 ? 0.95 : 0.8 };
	}

	const hindiLetters = (raw.match(/[\u0900-\u097F]/g) || []).length;
	if (hindiLetters >= 2) {
		return { language: "Hindi", code: "hi", confidence: hindiLetters >= 8 ? 0.95 : 0.8 };
	}

	const lower = raw
		.toLowerCase()
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, " ");
	const wordSet = new Set((lower.match(/[a-z]+/g) || []).map((w) => w.trim()));
	const scoreWords = (words = []) =>
		words.reduce((score, word) => score + (wordSet.has(word) ? 1 : 0), 0);

	const frenchScore =
		scoreWords([
			"bonjour",
			"salut",
			"merci",
			"chambre",
			"hotel",
			"arrivee",
			"depart",
			"reservation",
			"prix",
			"nuit",
			"nuits",
			"disponible",
			"voudrais",
			"veux",
			"combien",
			"confirmer",
		]) + (/\bs[' ]?il vous plait\b|\bje voudrais\b|\bje veux\b/.test(lower) ? 2 : 0);
	const hasFrenchSignature =
		/\b(bonjour|salut|merci|chambre|arrivee|depart|prix|nuit|nuits|disponible|voudrais|veux|combien|confirmer)\b|\bs[' ]?il vous plait\b|\bje voudrais\b|\bje veux\b/.test(
			lower
		);
	if (frenchScore >= 2 && hasFrenchSignature) {
		return { language: "French", code: "fr", confidence: Math.min(0.95, 0.6 + frenchScore * 0.1) };
	}

	const spanishScore =
		scoreWords([
			"hola",
			"gracias",
			"habitacion",
			"hotel",
			"reserva",
			"precio",
			"fechas",
			"llegada",
			"salida",
			"quiero",
			"quisiera",
			"cuanto",
			"disponible",
			"confirmar",
		]) + (/\bpor favor\b|\bme gustaria\b/.test(lower) ? 2 : 0);
	if (spanishScore >= 2) {
		return { language: "Spanish", code: "es", confidence: Math.min(0.95, 0.6 + spanishScore * 0.1) };
	}

	const indonesianScore =
		scoreWords([
			"halo",
			"terima",
			"kasih",
			"kamar",
			"reservasi",
			"harga",
			"tanggal",
			"tersedia",
			"saya",
			"ingin",
			"berapa",
			"bayar",
			"pembayaran",
			"tolong",
		]) + (/\bsaya ingin\b|\bterima kasih\b/.test(lower) ? 2 : 0);
	const malayScore =
		scoreWords([
			"hai",
			"terima",
			"kasih",
			"bilik",
			"tempahan",
			"harga",
			"tarikh",
			"tersedia",
			"saya",
			"mahu",
			"berapa",
			"bayar",
			"pembayaran",
			"tolong",
			"invois",
		]) + (/\bsaya mahu\b|\bterima kasih\b/.test(lower) ? 2 : 0);
	if (indonesianScore >= 2 || malayScore >= 2) {
		if (malayScore > indonesianScore) {
			return { language: "Malay (Malaysia)", code: "ms", confidence: Math.min(0.95, 0.6 + malayScore * 0.1) };
		}
		return { language: "Indonesian", code: "id", confidence: Math.min(0.95, 0.6 + indonesianScore * 0.1) };
	}

	const englishScore =
		scoreWords([
			"hello",
			"thanks",
			"please",
			"room",
			"hotel",
			"booking",
			"reservation",
			"reserve",
			"price",
			"availability",
			"available",
			"checkin",
			"checkout",
			"confirm",
			"payment",
			"email",
			"phone",
		]) + (/\b(check[ -]?in|check[ -]?out|thank you|how much)\b/.test(lower) ? 2 : 0);
	if (englishScore >= 3) {
		return { language: "English", code: "en", confidence: Math.min(0.95, 0.55 + englishScore * 0.1) };
	}

	return null;
}

function explicitLanguageSwitchRequest(text = "") {
	const { lower, arabic, latinCompact } = normalizeControlText(text);
	if (!lower && !arabic && !latinCompact) return null;
	const compact = latinCompact;
	const wordCount = (lower.match(/[a-z\u0600-\u06ff\u0900-\u097f]+/gi) || []).length;
	const languageOptions = [
		{
			language: "Arabic",
			code: "ar",
			exact: /^(arabic|arabi|speakarabic|replyinarabic|writeinarabic|talkarabic|inarabic|bilarabi)$/i,
			phrase: /\b(?:arabic|arabi)\b/i,
			local: /(?:\u0639\u0631\u0628\u064a|\u0627\u0644\u0639\u0631\u0628\u064a\u0629|\u0628\u0627\u0644\u0639\u0631\u0628\u064a|\u0639\u0631\u0628\u0649)/i,
		},
		{
			language: "English",
			code: "en",
			exact: /^(english|speakenglish|replyinenglish|writeinenglish|talkenglish|inenglish)$/i,
			phrase: /\b(?:english|inglish)\b/i,
			local: /(?:\u0627\u0646\u062c\u0644\u064a\u0632\u064a|\u0627\u0646\u0643\u0644\u064a\u0632\u064a|\u0627\u0646\u0642\u0644\u0634)/i,
		},
		{
			language: "Spanish",
			code: "es",
			exact: /^(spanish|espanol|espanola|speakspanish|replyinspanish|writeinspanish|inspanish)$/i,
			phrase: /\b(?:spanish|espanol|espa[ñn]ol|espa[ñn]ola)\b/i,
			local: /(?:\u0627\u0633\u0628\u0627\u0646\u064a|\u0627\u0633\u0628\u0627\u0646\u064a\u0629|\u0633\u0628\u0627\u0646\u0634)/i,
		},
		{
			language: "French",
			code: "fr",
			exact: /^(french|francais|speakfrench|replyinfrench|writeinfrench|infrench)$/i,
			phrase: /\b(?:french|fran[çc]ais)\b/i,
			local: /(?:\u0641\u0631\u0646\u0633\u064a|\u0641\u0631\u0646\u0633\u064a\u0629)/i,
		},
		{
			language: "Urdu",
			code: "ur",
			exact: /^(urdu|speakurdu|replyinurdu|writeinurdu|inurdu)$/i,
			phrase: /\burdu\b/i,
			local: /(?:\u0627\u0631\u062f\u0648|\u0627\u0631\u062f\u0648\u06ba)/i,
		},
		{
			language: "Hindi",
			code: "hi",
			exact: /^(hindi|speakhindi|replyinhindi|writeinhindi|inhindi)$/i,
			phrase: /\bhindi\b/i,
			local: /(?:\u0939\u093f\u0902\u0926\u0940|\u0939\u093f\u0928\u094d\u0926\u0940|\u0647\u0646\u062f\u064a)/i,
		},
		{
			language: "Indonesian",
			code: "id",
			exact: /^(indonesian|bahasaindonesia|speakindonesian|replyinindonesian|inindonesian)$/i,
			phrase: /\b(?:indonesian|bahasa\s+indonesia)\b/i,
			local: /(?:\u0627\u0646\u062f\u0648\u0646\u064a\u0633\u064a|\u0627\u0646\u062f\u0648\u0646\u064a\u0633\u064a\u0629)/i,
		},
		{
			language: "Malay (Malaysia)",
			code: "ms",
			exact: /^(malay|bahasamelayu|malaysia|speakmalay|replyinmalay|inmalay)$/i,
			phrase: /\b(?:malay|bahasa\s+melayu|malaysia)\b/i,
			local: /(?:\u0645\u0627\u0644\u0627\u064a|\u0645\u0627\u0644\u064a\u0632\u064a)/i,
		},
	];
	const switchCue =
		wordCount <= 4 ||
		/\b(?:speak|talk|write|reply|respond|answer|switch|change|language|lang|in)\b/i.test(
			lower
		) ||
		/(?:\u062a\u0643\u0644\u0645|\u062a\u062d\u062f\u062b|\u0627\u0631\u062f|\u0631\u062f|\u0628\u0644\u063a\u0629|\u0644\u063a\u0629|\u0628\u0627\u0644)/i.test(
			arabic
		);
	for (const option of languageOptions) {
		const matched =
			option.exact.test(compact) ||
			(option.phrase.test(lower) && switchCue) ||
			(option.local.test(arabic) && switchCue);
		if (!matched) continue;
		const requestOnly =
			option.exact.test(compact) ||
			(wordCount <= 5 &&
				!/\b(?:price|availability|available|book|reserve|reservation|room|date|check|location|address|phone|payment|bus|shuttle|haram|map|directions|distance)\b/i.test(
					lower
				));
		return { language: option.language, code: option.code, confidence: 1, requestOnly };
	}
	return null;
}

function reservationDetailCollectionContext(sc = {}, st = {}) {
	if (
		[
			"reviewConfirm",
			"reservation_details",
			"fullname",
			"nationality",
			"phone",
			"email_or_skip",
			"finalize",
		].includes(st.waitFor)
	) {
		return true;
	}
	const text = lastAssistantText(sc);
	return (
		/full name[\s\S]{0,120}(?:phone|mobile)[\s\S]{0,120}nationality/i.test(
			text
		) ||
		/\u0644\u0625\u062a\u0645\u0627\u0645\s+\u0627\u0644\u062d\u062c\u0632[\s\S]{0,200}(?:\u0627\u0644\u0627\u0633\u0645\s+\u0627\u0644\u0643\u0627\u0645\u0644|\u0631\u0642\u0645\s+\u0627\u0644\u0647\u0627\u062a\u0641|\u0627\u0644\u062c\u0646\u0633\u064a\u0629)/i.test(
			text
		)
	);
}

function looksLikeNationalityDetailAnswer(text = "") {
	const value = String(text || "").trim();
	if (!value || value.length > 80) return false;
	return Boolean(explicitNationalityText(value) || nationalityHintFromText(value));
}

function shouldProtectReservationDetailLanguage(sc = {}, st = {}, text = "") {
	return (
		reservationDetailCollectionContext(sc, st) &&
		looksLikeNationalityDetailAnswer(text)
	);
}

function updateActiveLanguageFromText(sc = {}, st = {}, text = "") {
	const explicit = explicitLanguageSwitchRequest(text);
	const detected = explicit || detectGuestLanguageFromText(text);
	if (!detected || detected.confidence < 0.75) return;
	const current = String(languageOf(sc, st) || "").toLowerCase();
	const currentCode = String(activeLanguageCodeOf(sc, st) || "").toLowerCase();
	if (
		detected.language === "Arabic" &&
		(/urdu/.test(current) || currentCode === "ur")
	) {
		return;
	}
	if (
		(detected.language === "Indonesian" &&
			(/malay/.test(current) || currentCode === "ms")) ||
		(/malay/i.test(detected.language) &&
			(/indonesian/.test(current) || currentCode === "id"))
	) {
		return;
	}
	if (current !== detected.language.toLowerCase()) {
		logStep(String(sc._id || ""), "language.override", {
			from: languageOf(sc, st),
			to: detected.language,
			code: detected.code,
			confidence: detected.confidence,
		});
	}
	st.language = detected.language;
	st.languageCode = detected.code;
	st.languageOverrideAt = now();
}

function languageSwitchAcknowledgementText(sc = {}, st = {}) {
	const lang = languageOf(sc, st);
	const name = respectfulGuestName(sc, st);
	if (/arabic/i.test(lang)) {
		return `${name}\u060c \u0623\u0643\u064a\u062f\u060c \u0633\u0623\u062a\u0627\u0628\u0639 \u0645\u0639\u0643 \u0628\u0627\u0644\u0639\u0631\u0628\u064a\u0629. \u0643\u064a\u0641 \u0623\u0642\u062f\u0631 \u0623\u0633\u0627\u0639\u062f\u0643\u061f`;
	}
	if (/spanish/i.test(lang)) {
		return `${name}, claro, continuo contigo en espanol. Como puedo ayudarte?`;
	}
	if (/french/i.test(lang)) {
		return `${name}, bien sur, je continue avec vous en francais. Comment puis-je vous aider ?`;
	}
	if (/urdu/i.test(lang)) {
		return `${name}, zaroor, main Urdu mein continue karta/karti hoon. Aap ki kya help kar sakta/sakti hoon?`;
	}
	if (/hindi/i.test(lang)) {
		return `${name}, bilkul, main Hindi mein continue karta/karti hoon. Main kaise help kar sakta/sakti hoon?`;
	}
	if (/indonesian/i.test(lang)) {
		return `${name}, tentu, saya lanjutkan dalam bahasa Indonesia. Ada yang bisa saya bantu?`;
	}
	if (/malay|malaysia/i.test(lang)) {
		return `${name}, baik, saya teruskan dalam Bahasa Melayu. Apa yang boleh saya bantu?`;
	}
	return `${name}, absolutely, I will continue in English. How can I help?`;
}

function localizedHowAreYouReplyText(sc = {}, st = {}) {
	const lang = languageOf(sc, st);
	const name = respectfulGuestName(sc, st);
	const hotelName = localizedHotelName(sc, st);
	if (/arabic/i.test(lang)) {
		return `${name}، أنا بخير والحمد لله، شكرا لسؤالك. كيف أقدر أساعدك في ${hotelName} اليوم؟`;
	}
	if (/spanish/i.test(lang)) {
		return `${name}, estoy muy bien, gracias por preguntar. Como puedo ayudarte con ${hotelName} hoy?`;
	}
	if (/french/i.test(lang)) {
		return `${name}, je vais tres bien, merci de demander. Comment puis-je vous aider avec ${hotelName} aujourd'hui ?`;
	}
	if (/urdu/i.test(lang)) {
		return `${name}, main theek hoon, poochne ka shukriya. Aaj ${hotelName} ke liye main kaise help kar sakta hoon?`;
	}
	if (/hindi/i.test(lang)) {
		return `${name}, main theek hoon, poochne ke liye dhanyavaad. Aaj ${hotelName} ke liye main kaise help kar sakta hoon?`;
	}
	if (/indonesian/i.test(lang)) {
		return `${name}, saya baik, terima kasih sudah bertanya. Bagaimana saya bisa membantu dengan ${hotelName} hari ini?`;
	}
	if (/malay|malaysia/i.test(lang)) {
		return `${name}, saya baik, terima kasih kerana bertanya. Bagaimana saya boleh bantu dengan ${hotelName} hari ini?`;
	}
	return `${name}, I am doing well, thank you for asking. How can I help you with ${hotelName} today?`;
}

function localizedThanksReplyText(sc = {}, st = {}) {
	const lang = languageOf(sc, st);
	const name = respectfulGuestName(sc, st);
	const hotelName = localizedHotelName(sc, st);
	if (/arabic/i.test(lang)) {
		return `${name}، العفو. أنا هنا إذا احتجت أي مساعدة بخصوص ${hotelName}.`;
	}
	if (/spanish/i.test(lang)) {
		return `${name}, con mucho gusto. Estoy aqui si necesitas ayuda con ${hotelName}.`;
	}
	if (/french/i.test(lang)) {
		return `${name}, avec plaisir. Je reste ici si vous avez besoin d'aide avec ${hotelName}.`;
	}
	if (/urdu/i.test(lang)) {
		return `${name}, aap ka khair maqdam hai. ${hotelName} ke liye koi help chahiye ho to main yahin hoon.`;
	}
	if (/hindi/i.test(lang)) {
		return `${name}, aapka swagat hai. ${hotelName} ke liye koi help chahiye ho to main yahin hoon.`;
	}
	if (/indonesian/i.test(lang)) {
		return `${name}, sama-sama. Saya tetap di sini jika Anda membutuhkan bantuan dengan ${hotelName}.`;
	}
	if (/malay|malaysia/i.test(lang)) {
		return `${name}, sama-sama. Saya masih di sini jika anda perlukan bantuan dengan ${hotelName}.`;
	}
	return `${name}, you are most welcome. I am here whenever you need help with ${hotelName}.`;
}

function fastEnglishSmalltalkText(sc = {}, st = {}, text = "") {
	const raw = String(text || "").trim();
	if (!raw || raw.length > 140) return "";
	const { lower, arabic, latinCompact } = normalizeControlText(raw);
	const asksHowAreYou =
		/\b(?:how\s+are\s+you|how\s+r\s+u|how\s+are\s+u|how'?s\s+it\s+going|how\s+is\s+your\s+day|how\s+are\s+you\s+doing|how\s+are\s+you\s+holding\s+up|how\s+are\s+things)\b/i.test(
			raw
		) ||
		/(?:كيف\s+حالك|كيفك|اخبارك|أخبارك|ازيك|إزيك|عامل\s+ايه|عاملة\s+ايه)/i.test(
			arabic
		) ||
		/(?:howareyou|howru|keefak|kefak|keefhalak|akhbarak|ezayak)/i.test(
			latinCompact
		);
	const clearHowAreYou =
		asksHowAreYou &&
		!/\b(?:far|distance|price|rate|available|availability|book|reserve|reservation|room|date|check\s*-?\s*in|check\s*-?\s*out|map|location|address|nusuk|bus|shuttle|payment|confirmation)\b/i.test(
			lower
		) &&
		!/(?:سعر|أسعار|اسعار|حجز|غرفة|غرف|تاريخ|دخول|خروج|خريطة|موقع|نسك|باص|تأكيد|دفع)/i.test(
			arabic
		);
	if (clearHowAreYou) {
		return localizedHowAreYouReplyText(sc, st);
	}
	if (hasOperationalBookingSignal(raw)) return "";
	if (looksLikeGreetingOnly(raw)) {
		return greetingText(sc, st);
	}
	if (
		/^(?:thanks?|thank\s+you|thank\s+you\s+so\s+much|appreciate\s+it)\.?$/i.test(
			raw
		) ||
		/^(?:شكرا|شكرًا|متشكر|متشكرة|يعطيك\s+العافية|تسلم|تسلمي|جزاك\s+الله\s+خير)$/i.test(
			arabic
		)
	) {
		return localizedThanksReplyText(sc, st);
	}
	return "";
}

function casualWrittenReplyAsksForBookingField(text = "") {
	const value = String(text || "");
	if (!value.trim()) return false;
	const latin = asciiize(value).toLowerCase().replace(/\s+/g, " ").trim();
	return (
		/\b(?:what\s+is|please\s+(?:send|share|provide|add)|send|share|provide|add|i\s+(?:still\s+)?need)\b.{0,100}\b(?:nationality|country|full\s+name|phone|mobile|email|e-mail|check[\s-]?in|check[\s-]?out|checkout|dates?|room\s+type|guests?|adults?|children)\b/i.test(
			value
		) ||
		/\b(?:nationality|country)\s+or\s+country\s+name\b/i.test(value) ||
		/\b(?:cual|que|por\s+favor|envia|enviame|comparte|proporciona|necesito|necesitamos|falta|indica|dime)\b.{0,120}\b(?:nacionalidad|pais|nombre\s+completo|telefono|movil|correo|email|fechas?|entrada|salida|tipo\s+de\s+habitacion|habitacion|huespedes?|adultos?|ninos?|personas?)\b/i.test(
			latin
		) ||
		/\b(?:quel|quelle|quels|quelles|veuillez|envoyez|partagez|fournissez|besoin|faut|merci\s+de|indiquez)\b.{0,120}\b(?:nationalite|pays|nom\s+complet|telephone|mobile|email|courriel|dates?|arrivee|depart|type\s+de\s+chambre|chambre|voyageurs?|personnes?|adultes?|enfants?)\b/i.test(
			latin
		) ||
		/(?:\u0627\u0644\u062c\u0646\u0633\u064a\u0629|\u0631\u0642\u0645\s+\u0627\u0644\u0647\u0627\u062a\u0641|\u062a\u0627\u0631\u064a\u062e\s+\u0627\u0644\u0648\u0635\u0648\u0644|\u062a\u0627\u0631\u064a\u062e\s+\u0627\u0644\u0645\u063a\u0627\u062f\u0631\u0629|\u0646\u0648\u0639\s+\u0627\u0644\u063a\u0631\u0641\u0629)/i.test(
			value
		)
	);
}

function guardedCasualWrittenReply(message = "", fallback = "", options = {}) {
	if (!fallback || (!options.casual && !options.first)) return message || fallback;
	if (casualWrittenReplyAsksForBookingField(message)) return fallback;
	return message || fallback;
}

async function waitForVisibleTypingWindow(
	io,
	caseId,
	st,
	{ startedAt, targetReplyMs, typingStartedAt }
) {
	let typingOn = true;
	let visibleStartedAt = typingStartedAt || now();
	while (!st.interrupt) {
		if (Number(st.guestTypingUntil || 0) > now()) {
			if (typingOn) {
				emitTyping(io, caseId, st, false);
				typingOn = false;
			}
			while (Number(st.guestTypingUntil || 0) > now() && !st.interrupt) {
				await sleep(120);
			}
			if (st.interrupt) return false;
			emitTyping(io, caseId, st, true);
			typingOn = true;
			visibleStartedAt = now();
		}
		const minimumSendAt = Math.max(
			startedAt + targetReplyMs,
			visibleStartedAt + AI_TYPING_MIN_VISIBLE_MS
		);
		if (now() >= minimumSendAt) return true;
		await sleep(80);
	}
	return false;
}

async function sendDynamicWrittenReply(
	io,
	sc,
	st,
	userText,
	instruction,
	context = {},
	options = {}
) {
	const caseId = String(sc?._id || sc?.id || "");
	const startedAt =
		Number(st?.activeTurnGuestAt || 0) > 0 ? Number(st.activeTurnGuestAt) : now();
	const requestedTargetMs = Number(options.targetReplyMs);
	const targetReplyMs =
		Number.isFinite(requestedTargetMs) && requestedTargetMs >= 0
			? requestedTargetMs
			: options.casual
			? casualReplyTargetMs()
			: Number(st?.activeTurnReplyTargetMs || 0) > 0
			? Number(st.activeTurnReplyTargetMs)
			: randomBetween(AI_REPLY_TARGET_MIN_MS, AI_REPLY_TARGET_MAX_MS);
	const fallback =
		options.fallbackText ||
		fastEnglishSmalltalkText(sc, st, userText) ||
		greetingText(sc, st);
	let typingTimer = null;
	let preTypingVisible = false;
	let preTypingStartedAt = 0;
	if (io && caseId && options.preTyping !== false && AI_PLANNING_TYPING_DELAY_MS >= 0) {
		typingTimer = setTimeout(() => {
			if (st.interrupt) return;
			if (Number(st.guestTypingUntil || 0) > now()) return;
			emitTyping(io, caseId, st, true);
			preTypingVisible = true;
			preTypingStartedAt = now();
		}, planningTypingDelayMs(st));
		if (typeof typingTimer.unref === "function") typingTimer.unref();
	}
	let msg = "";
	try {
		msg = await write(io, sc, st, instruction, {
			latestUserMessage: userText,
			currentWaitFor: st.waitFor || "",
			pivot: nextPivot(st),
			...context,
		});
	} finally {
		if (typingTimer) clearTimeout(typingTimer);
	}
	const finalMessage = guardedCasualWrittenReply(msg, fallback, options);
	if (preTypingVisible) {
		await waitForVisibleTypingWindow(io, caseId, st, {
			startedAt,
			targetReplyMs,
			typingStartedAt: preTypingStartedAt,
		});
		emitTyping(io, caseId, st, false);
		if (st.interrupt) return false;
		return humanSend(io, sc, st, finalMessage, {
			first: Boolean(options.first),
			fast: true,
			scheduleIdle: options.scheduleIdle !== false,
			quickReplies: options.quickReplies || [],
		});
	}
	return humanSend(io, sc, st, finalMessage, {
		first: Boolean(options.first),
		targetReplyMs,
		scheduleIdle: options.scheduleIdle !== false,
		quickReplies: options.quickReplies || [],
	});
}

async function sendDynamicCasualReply(
	io,
	sc,
	st,
	userText,
	instruction,
	context = {},
	options = {}
) {
	return sendDynamicWrittenReply(io, sc, st, userText, instruction, context, {
		...options,
		casual: true,
		fallbackText:
			options.fallbackText ||
			fastEnglishSmalltalkText(sc, st, userText) ||
			greetingText(sc, st),
	});
}

async function sendDynamicEmotionalSupportReply(io, sc, st, userText = "") {
	const fallbackText = emotionalSupportReplyText(sc, st, userText);
	if (looksLikeSeriousSelfHarmText(userText)) {
		return humanSend(io, sc, st, fallbackText, {
			targetReplyMs: casualReplyTargetMs(),
		});
	}
	return sendDynamicWrittenReply(
		io,
		sc,
		st,
		userText,
		"The guest shared sadness, worry, stress, loneliness, or emotional heaviness. Reply like a warm but professional hotel CSR: acknowledge the feeling sincerely, include one short Islamic dua/prayer in the guest's active language, and offer either to listen briefly or continue helping with the stay step by step. Do not diagnose, lecture, overdo religion, or turn it into a script. Keep it to 2-3 concise sentences.",
		{ latestUserMessage: userText, fallbackText },
		{ casual: true, fallbackText }
	);
}

async function answerLanguageSwitchRequest(io, sc, st, userText = "") {
	await humanSend(io, sc, st, languageSwitchAcknowledgementText(sc, st));
	logStep(String(sc._id), "language.switch_ack", {
		language: languageOf(sc, st),
		code: activeLanguageCodeOf(sc, st),
		latestUserMessage: String(userText || "").slice(0, 160),
	});
	return true;
}

function firstNameForAddress(value = "") {
	const cleaned = String(value || "")
		.trim()
		.replace(
			/^(?:mr|mrs|ms|miss|dr|sir|madam|mister|السيد|السيدة|استاذ|أستاذ|استاذة|أستاذة|الاستاذ|الأستاذ|الاستاذة|الأستاذة)\s+/i,
			""
		)
		.replace(
			/^(?:\u0627\u0644\u0633\u064a\u062f\u0629|\u0627\u0644\u0633\u064a\u062f|\u0623\u0633\u062a\u0627\u0630\u0629|\u0627\u0633\u062a\u0627\u0630\u0629|\u0623\u0633\u062a\u0627\u0630|\u0627\u0633\u062a\u0627\u0630|\u0627\u0644\u0623\u0633\u062a\u0627\u0630\u0629|\u0627\u0644\u0627\u0633\u062a\u0627\u0630\u0629|\u0627\u0644\u0623\u0633\u062a\u0627\u0630|\u0627\u0644\u0627\u0633\u062a\u0627\u0630)\s+/i,
			""
		)
		.trim();
	return firstNameOf(cleaned || value || "Guest");
}

const GUEST_FEMALE_NAMES_LATIN = new Set([
	"marwa",
	"marwat",
	"aisha",
	"aysha",
	"ayesha",
	"mona",
	"muna",
	"maryam",
	"mariam",
	"zainab",
	"zaynab",
	"fatima",
	"fatimah",
	"sara",
	"sarah",
	"yasmin",
	"yasmine",
	"noura",
	"nora",
	"noora",
	"huda",
	"hoda",
	"hajar",
	"amina",
	"ameena",
	"asma",
	"aya",
	"eman",
	"iman",
	"salma",
	"khadija",
	"khadijah",
	"leila",
	"layla",
	"lina",
	"reem",
	"dina",
	"maha",
	"amal",
	"rawan",
	"manar",
]);
const GUEST_MALE_NAMES_LATIN = new Set([
	"ahmed",
	"mohamed",
	"muhammad",
	"mahmoud",
	"ali",
	"omar",
	"umer",
	"yusuf",
	"youssef",
	"ibrahim",
	"abdullah",
	"abdallah",
	"nasser",
	"naser",
	"khaled",
	"waleed",
	"hassan",
	"hussein",
	"mustafa",
	"mostafa",
	"karim",
	"ehab",
	"shady",
	"gamal",
	"goma",
	"gomaa",
	"gomaah",
	"ayman",
	"farouk",
	"farouq",
	"yakoot",
	"yakout",
	"amr",
	"khamis",
	"khamiss",
]);
const GUEST_FEMALE_NAMES_ARABIC = new Set([
	"\u0645\u0631\u0648\u0629",
	"\u0645\u0631\u0648\u0629\u062a",
	"\u0639\u0627\u0626\u0634\u0629",
	"\u0639\u0627\u064a\u0634\u0629",
	"\u0645\u0646\u0649",
	"\u0645\u0631\u064a\u0645",
	"\u0632\u064a\u0646\u0628",
	"\u0641\u0627\u0637\u0645\u0629",
	"\u0633\u0627\u0631\u0629",
	"\u064a\u0627\u0633\u0645\u064a\u0646",
	"\u0646\u0648\u0631\u0629",
	"\u0646\u0648\u0631\u0627",
	"\u0647\u062f\u0649",
	"\u0647\u062f\u0627",
	"\u0647\u0627\u062c\u0631",
	"\u0622\u0645\u0646\u0629",
	"\u0627\u0645\u0646\u0629",
	"\u0623\u0633\u0645\u0627\u0621",
	"\u0627\u0633\u0645\u0627\u0621",
	"\u0622\u064a\u0629",
	"\u0627\u064a\u0629",
	"\u0625\u064a\u0645\u0627\u0646",
	"\u0627\u064a\u0645\u0627\u0646",
	"\u0633\u0644\u0645\u0649",
	"\u062e\u062f\u064a\u062c\u0629",
	"\u0644\u064a\u0644\u0649",
	"\u0644\u064a\u0646\u0627",
	"\u0631\u064a\u0645",
	"\u062f\u064a\u0646\u0627",
	"\u0645\u0647\u0627",
	"\u0623\u0645\u0644",
	"\u0627\u0645\u0644",
	"\u0631\u0648\u0627\u0646",
	"\u0645\u0646\u0627\u0631",
]);
const GUEST_MALE_NAMES_ARABIC = new Set([
	"\u0623\u062d\u0645\u062f",
	"\u0627\u062d\u0645\u062f",
	"\u0645\u062d\u0645\u062f",
	"\u0645\u062d\u0645\u0648\u062f",
	"\u0639\u0644\u064a",
	"\u0639\u0645\u0631",
	"\u064a\u0648\u0633\u0641",
	"\u0625\u0628\u0631\u0627\u0647\u064a\u0645",
	"\u0627\u0628\u0631\u0627\u0647\u064a\u0645",
	"\u0639\u0628\u062f\u0627\u0644\u0644\u0647",
	"\u0639\u0628\u062f\u0627\u0644\u0647",
	"\u0646\u0627\u0635\u0631",
	"\u062e\u0627\u0644\u062f",
	"\u0648\u0644\u064a\u062f",
	"\u062d\u0633\u0646",
	"\u062d\u0633\u064a\u0646",
	"\u0645\u0635\u0637\u0641\u0649",
	"\u0643\u0631\u064a\u0645",
	"\u0625\u064a\u0647\u0627\u0628",
	"\u0627\u064a\u0647\u0627\u0628",
	"\u0634\u0627\u062f\u064a",
	"\u062c\u0645\u0627\u0644",
	"\u062c\u0645\u0639\u0629",
	"\u062c\u0645\u0639\u0647",
	"\u0623\u064a\u0645\u0646",
	"\u0627\u064a\u0645\u0646",
	"\u0641\u0627\u0631\u0648\u0642",
	"\u064a\u0627\u0642\u0648\u062a",
	"\u062e\u0645\u064a\u0633",
]);

function compactArabicName(value = "") {
	return String(value || "")
		.replace(/[\u064b-\u065f\u0670]/g, "")
		.replace(/\u0640/g, "")
		.replace(/\s+/g, "")
		.trim();
}

function inferGuestGenderFromName(value = "") {
	const raw = String(value || "").trim();
	if (!raw) return "unknown";
	if (/\b(?:mrs|ms|miss|madam|ma'am|mme|madame|sra|senora|se\u00f1ora)\b/i.test(raw)) {
		return "female";
	}
	if (
		/(?:\u0627\u0644\u0633\u064a\u062f\u0629|\u0623\u0633\u062a\u0627\u0630\u0629|\u0627\u0633\u062a\u0627\u0630\u0629|\u0627\u0644\u0623\u0633\u062a\u0627\u0630\u0629|\u0627\u0644\u0627\u0633\u062a\u0627\u0630\u0629)/.test(
			raw
		)
	) {
		return "female";
	}
	if (/\b(?:mr|sir|mister|monsieur|sr|senor|se\u00f1or)\b/i.test(raw)) {
		return "male";
	}
	if (
		/(?:\u0627\u0644\u0633\u064a\u062f|\u0623\u0633\u062a\u0627\u0630|\u0627\u0633\u062a\u0627\u0630|\u0627\u0644\u0623\u0633\u062a\u0627\u0630|\u0627\u0644\u0627\u0633\u062a\u0627\u0630)/.test(
			raw
		)
	) {
		return "male";
	}
	const firstName = firstNameForAddress(raw);
	const latinName = asciiize(firstName)
		.toLowerCase()
		.replace(/[^a-z]/g, "");
	const arabicName = compactArabicName(firstName);
	if (
		GUEST_FEMALE_NAMES_LATIN.has(latinName) ||
		GUEST_FEMALE_NAMES_ARABIC.has(arabicName)
	) {
		return "female";
	}
	if (
		GUEST_MALE_NAMES_LATIN.has(latinName) ||
		GUEST_MALE_NAMES_ARABIC.has(arabicName)
	) {
		return "male";
	}
	return "unknown";
}

function guestNameSource(sc = {}, st = {}) {
	const candidates = [
		st.slots?.name,
		st.slots?.fullName,
		sc.displayName1,
		sc.customerName,
	];
	return String(
		candidates.find((candidate) => {
			const value = String(candidate || "").trim();
			if (!value) return false;
			if (/^\d+$/.test(digitsToEnglish(value))) return false;
			if (looksLikeStayDateCandidate(value)) return false;
			if (rejectsFullNameCandidate(value)) return false;
			return true;
		}) || ""
	).trim();
}

function respectfulGuestProfile(sc = {}, st = {}) {
	const sourceName = guestNameSource(sc, st);
	const rawName = String(firstNameForAddress(sourceName)).trim();
	const gender = inferGuestGenderFromName(sourceName || rawName);
	const language = languageOf(sc, st);
	if (/arabic/i.test(language)) {
		if (!rawName || /^guest$/i.test(rawName)) {
			return {
				firstName: "",
				gender,
				address: "\u0636\u064a\u0641\u0646\u0627 \u0627\u0644\u0643\u0631\u064a\u0645",
			};
		}
		if (
			/^(?:\u0623\u0633\u062a\u0627\u0630|\u0627\u0633\u062a\u0627\u0630|\u0623\u0633\u062a\u0627\u0630\u0629|\u0627\u0644\u0623\u0633\u062a\u0627\u0630|\u0627\u0644\u0623\u0633\u062a\u0627\u0630\u0629|\u0627\u0644\u0633\u064a\u062f|\u0627\u0644\u0633\u064a\u062f\u0629)\b/i.test(
				rawName
			)
		) {
			return { firstName: rawName, gender, address: rawName };
		}
		return {
			firstName: rawName,
			gender,
			address:
				gender === "female"
					? `\u0623\u0633\u062a\u0627\u0630\u0629 ${rawName}`
					: gender === "male"
					? `\u0623\u0633\u062a\u0627\u0630 ${rawName}`
					: "\u0636\u064a\u0641\u0646\u0627 \u0627\u0644\u0643\u0631\u064a\u0645",
		};
	}
	if (!rawName || /^guest$/i.test(rawName)) {
		return { firstName: "", gender, address: "Dear Guest" };
	}
	if (/^(?:mr\.?|mrs\.?|ms\.?|miss|sir|madam|mister)\b/i.test(rawName)) {
		return { firstName: rawName, gender, address: rawName };
	}
	if (gender === "female") {
		return { firstName: rawName, gender, address: `Ms. ${rawName}` };
	}
	if (gender === "male") {
		return { firstName: rawName, gender, address: `Mr. ${rawName}` };
	}
	return { firstName: rawName || "", gender, address: "Dear Guest" };
}

function respectfulGuestName(sc = {}, st = {}) {
	return respectfulGuestProfile(sc, st).address;
}

function escapeRegexText(value = "") {
	return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function guestAddressCandidates(sc = {}, st = {}) {
	const profile = respectfulGuestProfile(sc, st);
	const sourceName = guestNameSource(sc, st);
	const firstName = String(profile.firstName || firstNameForAddress(sourceName)).trim();
	const candidates = [
		profile.address,
		firstName,
		sourceName,
		firstName ? `Mr. ${firstName}` : "",
		firstName ? `Ms. ${firstName}` : "",
		firstName ? `Mrs. ${firstName}` : "",
		firstName ? `\u0623\u0633\u062a\u0627\u0630 ${firstName}` : "",
		firstName ? `\u0623\u0633\u062a\u0627\u0630\u0629 ${firstName}` : "",
		firstName ? `\u0627\u0644\u0633\u064a\u062f ${firstName}` : "",
		firstName ? `\u0627\u0644\u0633\u064a\u062f\u0629 ${firstName}` : "",
	]
		.map((candidate) => String(candidate || "").trim())
		.filter((candidate) => candidate.length > 1);
	return [...new Set(candidates)].sort((a, b) => b.length - a.length);
}

function leadingGuestAddressMatch(text = "", sc = {}, st = {}) {
	const candidates = guestAddressCandidates(sc, st);
	if (!candidates.length) return null;
	const source = candidates.map(escapeRegexText).join("|");
	const match = String(text || "").match(
		new RegExp(`^\\s*(${source})\\s*[,،]\\s*`, "iu")
	);
	return match || null;
}

function assistantAddressedGuestRecently(sc = {}, st = {}) {
	const candidates = guestAddressCandidates(sc, st);
	if (!candidates.length) return false;
	const aiMessages = (sc.conversation || []).filter(isAiConversationMessage);
	return aiMessages.slice(-2).some((message) =>
		Boolean(leadingGuestAddressMatch(message?.message || "", sc, st))
	);
}

function importantGuestAddressContext(text = "") {
	const lower = String(text || "").toLowerCase();
	return (
		/\b(?:reservation is confirmed|booking is confirmed|confirmation number|everything is ready|complete reservation|complete booking|full name|nationality|phone number|email address|payment link|for your security|sorry|apolog|i found reservation|could not find a reservation|already closed|human|manager|escalat)\b/i.test(
			lower
		) ||
		/(?:\u0631\u0642\u0645\s+\u0627\u0644\u062a\u0623\u0643\u064a\u062f|\u0631\u0642\u0645\s+\u0627\u0644\u062a\u0627\u0643\u064a\u062f|\u062a\u0645\s+\u062a\u0623\u0643\u064a\u062f|\u062a\u0645\s+\u0627\u0644\u062a\u0623\u0643\u064a\u062f|\u0627\u0644\u062d\u062c\u0632\s+\u0645\u0624\u0643\u062f|\u0627\u0644\u0627\u0633\u0645\s+\u0627\u0644\u0643\u0627\u0645\u0644|\u0627\u0644\u062c\u0646\u0633\u064a\u0629|\u0631\u0642\u0645\s+\u0627\u0644\u0647\u0627\u062a\u0641|\u0627\u0644\u0628\u0631\u064a\u062f\s+\u0627\u0644\u0625\u0644\u0643\u062a\u0631\u0648\u0646\u064a|\u0623\u0639\u062a\u0630\u0631|\u0627\u0639\u062a\u0630\u0631|\u0622\u0633\u0641|\u0627\u0633\u0641)/i.test(
			text
		)
	);
}

function capitalizeLeadingLatin(text = "") {
	return String(text || "").replace(
		/^(\s*[*_`'"([]*)([a-z])/,
		(_, prefix, letter) => `${prefix}${letter.toUpperCase()}`
	);
}

function applyGuestAddressCadence(text = "", sc = {}, st = {}, { first = false } = {}) {
	const match = leadingGuestAddressMatch(text, sc, st);
	if (!match || first || importantGuestAddressContext(text)) return text;
	if (!assistantAddressedGuestRecently(sc, st)) return text;
	const stripped = String(text || "").slice(match[0].length).trimStart();
	return capitalizeLeadingLatin(stripped);
}

function logStep(caseId, message, payload = {}) {
	if (String(process.env.AI_AGENT_DEBUG || "").toLowerCase() !== "true") {
		return;
	}
	console.log(`[aiagent] case=${caseId} ${message}`, payload);
}

const idText = (value) => String(value?._id || value?.id || value || "").trim();

function activeHotelContextForCase(sc = {}, hotel = null) {
	return isJannatBookingSupportCase(sc, hotel) ? null : hotel;
}

async function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}
async function withSoftTimeout(promise, timeoutMs, fallbackValue) {
	let timer = null;
	try {
		return await Promise.race([
			Promise.resolve(promise).catch(() => fallbackValue),
			new Promise((resolve) => {
				timer = setTimeout(() => resolve(fallbackValue), timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
async function sleepUnlessInterrupted(st, ms, stepMs = 150) {
	for (let elapsed = 0; elapsed < ms; elapsed += stepMs) {
		if (st?.interrupt) return false;
		await sleep(Math.min(stepMs, ms - elapsed));
	}
	return !st?.interrupt;
}
async function humanPause() {
	await sleep(randomBetween(HUMAN.betweenSendsMinMs, HUMAN.betweenSendsMaxMs));
}

function isAiConversationMessage(message = {}) {
	const email = String(message?.messageBy?.customerEmail || "").toLowerCase();
	const actor = String(
		message?.sender ||
			message?.role ||
			message?.from ||
			message?.messageBy?.role ||
			message?.messageBy?.type ||
			""
	)
		.trim()
		.toLowerCase();
	return (
		message?.isAi === true ||
		message?.isSystem === true ||
		["ai", "assistant", "bot", "agent_ai", "aiagent", "system_ai"].includes(actor) ||
		email === AI_SUPPORT_EMAIL ||
		email === LEGACY_AI_SUPPORT_EMAIL
	);
}

function hasAiAssistantReply(sc = {}) {
	const conversation = Array.isArray(sc.conversation) ? sc.conversation : [];
	return conversation.some(
		(message) => !message?.isSystem && isAiConversationMessage(message)
	);
}

function isGuestConversationMessage(message = {}) {
	const actor = String(
		message?.sender ||
			message?.role ||
			message?.from ||
			message?.messageBy?.role ||
			message?.messageBy?.type ||
			""
	)
		.trim()
		.toLowerCase();
	return (
		message?.message &&
		!message?.isSystem &&
		!["admin", "csr", "employee", "hotel", "manager", "owner"].includes(actor) &&
		!isAiConversationMessage(message)
	);
}

function latestGuestMessageIndex(sc = {}) {
	const conversation = Array.isArray(sc.conversation) ? sc.conversation : [];
	for (let index = conversation.length - 1; index >= 0; index -= 1) {
		const message = conversation[index];
		if (!isGuestConversationMessage(message)) continue;
		if (isAutomatedSupportNoticeText(message.message)) continue;
		return index;
	}
	return -1;
}

function hasAiAssistantReplyAfterLatestGuest(sc = {}) {
	const conversation = Array.isArray(sc.conversation) ? sc.conversation : [];
	const latestGuestIndex = latestGuestMessageIndex(sc);
	if (latestGuestIndex < 0) return false;
	return conversation
		.slice(latestGuestIndex + 1)
		.some((message) => !message?.isSystem && isAiConversationMessage(message));
}

function aiMessageClientTag(caseId, prefix = "ai") {
	return `${prefix}:${caseId}:${Date.now()}:${Math.random()
		.toString(36)
		.slice(2, 10)}`;
}

function activeTurnKey(st = {}, userText = "") {
	return `${Number(st.activeTurnGuestAt || 0)}|${String(userText || "").trim()}`;
}

function aiDelayNoticeText(sc = {}, st = {}) {
	const lang = languageOf(sc, st);
	if (/arabic/i.test(lang)) {
		return "\u0644\u062d\u0638\u0629 \u0645\u0646 \u0641\u0636\u0644\u0643\u060c \u0623\u0631\u0627\u062c\u0639 \u0627\u0644\u062a\u0641\u0627\u0635\u064a\u0644 \u0628\u062f\u0642\u0629 \u062d\u062a\u0649 \u0623\u0639\u0637\u064a\u0643 \u0625\u062c\u0627\u0628\u0629 \u0635\u062d\u064a\u062d\u0629. \u0633\u0623\u0639\u0648\u062f \u0644\u0643 \u062e\u0644\u0627\u0644 \u0644\u062d\u0638\u0627\u062a.";
	}
	if (/spanish/i.test(lang)) {
		return "Un momento, por favor. Estoy revisando los detalles con cuidado para darte una respuesta correcta. Vuelvo contigo en unos instantes.";
	}
	if (/french/i.test(lang)) {
		return "Un instant, s'il vous plait. Je verifie les details avec soin pour vous donner une reponse correcte. Je reviens vers vous dans quelques instants.";
	}
	return "One moment please. I am reviewing the details carefully so I can give you the correct answer. I will be right with you.";
}

async function sendAiDelayNotice(io, sc, st, userText = "", caseId = "") {
	const targetCaseId = caseId || String(sc?._id || sc?.id || "");
	const latestUserText = String(userText || "").trim();
	if (!io || !targetCaseId || !st || !latestUserText) return false;
	if (st.activeTurnHadReply || st.interrupt) return false;
	const turnKey = activeTurnKey(st, latestUserText);
	if (st.delayNoticeTurnKey === turnKey) return false;
	if (
		Number(st.delayNoticeSentAt || 0) > 0 &&
		now() - Number(st.delayNoticeSentAt || 0) < AI_DELAY_NOTICE_COOLDOWN_MS
	) {
		return false;
	}
	try {
		const latestCase = (await getSupportCaseById(targetCaseId)) || sc;
		if (
			!latestCase ||
			latestCase.openedBy !== "client" ||
			latestCase.caseStatus === "closed" ||
			latestCase.aiToRespond === false
		) {
			return false;
		}
		if (lastUserText(latestCase) !== latestUserText) return false;
		if (hasAiAssistantReplyAfterLatestGuest(latestCase)) return false;
		const text = aiDelayNoticeText(latestCase, st);
		const messageData = {
			messageBy: {
				customerName: st.agentName || latestCase.aiResponderName || "Jannat Booking",
				customerEmail: AI_SUPPORT_EMAIL,
				userId: "jannat-ai-support",
			},
			message: text,
			date: new Date(),
			isAi: true,
			isSystem: true,
			clientAction: "ai_wait_notice",
			clientTag: aiMessageClientTag(targetCaseId, "ai-wait"),
		};
		const saved = await updateSupportCaseAppendIfNoRecentAiDuplicate(
			targetCaseId,
			{
				conversation: messageData,
				aiRelated: true,
			},
			{
				duplicateWindowMs: AI_MESSAGE_DEDUPE_WINDOW_MS,
				requireLatestGuestText: latestUserText,
			}
		);
		if (saved?.skipped) return false;
		st.delayNoticeTurnKey = turnKey;
		st.delayNoticeSentAt = now();
		io.to(targetCaseId).emit("receiveMessage", { ...messageData, caseId: targetCaseId });
		logStep(targetCaseId, "delay_notice.sent", {
			waitFor: st.waitFor || "",
			elapsedMs: now() - Number(st.activeTurnGuestAt || now()),
		});
		return true;
	} catch (error) {
		logStep(targetCaseId, "delay_notice.failed", {
			message: error?.message || error,
		});
		return false;
	}
}

function isAiQaSupportCase(sc = {}) {
	const markerText = [
		sc.sourceWebsite,
		sc.sourcePage,
		sc.sourceUrl,
		sc.clientName,
		sc.displayName1,
		sc.clientContact,
	]
		.filter(Boolean)
		.join(" ");
	return /\b(?:codex|jbqa|ai\s*qa|chatbot\s*qa)\b/i.test(markerText);
}

function messageTime(message = {}) {
	const time = new Date(message.date || 0).getTime();
	return Number.isFinite(time) ? time : 0;
}

function anchorMessageIndex(conversation = [], anchor = {}) {
	if (!Array.isArray(conversation) || !conversation.length) return -1;
	const clientTag = String(anchor.clientTag || "").trim();
	if (clientTag) {
		const byTag = conversation.findIndex(
			(message) => String(message?.clientTag || "") === clientTag
		);
		if (byTag >= 0) return byTag;
	}
	const text = String(anchor.text || "").trim();
	const at = Number(anchor.at || 0);
	if (!text || !at) return -1;
	let bestIndex = -1;
	let bestDelta = Number.POSITIVE_INFINITY;
	conversation.forEach((message, index) => {
		if (!isAiConversationMessage(message)) return;
		if (String(message.message || "").trim() !== text) return;
		const delta = Math.abs(messageTime(message) - at);
		if (delta < bestDelta) {
			bestDelta = delta;
			bestIndex = index;
		}
	});
	return bestDelta <= 3000 ? bestIndex : -1;
}

function guestRespondedAfterAnchor(supportCase = {}, anchor = {}) {
	const conversation = Array.isArray(supportCase.conversation)
		? supportCase.conversation
		: [];
	const index = anchorMessageIndex(conversation, anchor);
	if (index < 0) return true;
	return conversation.slice(index + 1).some(isGuestConversationMessage);
}

function shouldScheduleIdleFollowups(text = "", quickReplies = []) {
	if (!AI_IDLE_FOLLOWUPS_ENABLED) return false;
	const value = String(text || "").trim();
	if (!value || isAutomatedSupportNoticeText(value)) return false;
	if (Array.isArray(quickReplies) && quickReplies.length > 0) return true;
	if (/[?؟]/.test(value)) return true;
	return /\b(?:please\s+(?:share|send|provide|confirm|choose|select|tell)|could\s+you|would\s+you|can\s+you|let\s+me\s+know|send\s+me|share\s+your|confirm|choose|select)\b/i.test(
		value
	) || /(?:هل|ممكن|اختر|اختار|أكد|أرسل|ارسل|شارك|ابعث|ما\s+هو|كم|متى|أين)/i.test(
		value
	);
}

function reservationDetailContextReady(st = {}) {
	return Boolean(
		st?.quote ||
			(st?.hotel &&
				st?.slots?.roomTypeKey &&
				st?.slots?.checkinISO &&
				st?.slots?.checkoutISO)
	);
}

function reservationDetailWaitState(waitFor = "") {
	return [
		"reviewConfirm",
		"reservation_details",
		"fullname",
		"nationality",
		"phone",
		"email_or_skip",
		"finalize",
		"clarify",
	].includes(waitFor);
}

function bookingWaitState(st = {}) {
	if (!st) return "";
	if (reservationDetailWaitState(st.waitFor)) {
		return reservationDetailContextReady(st) ? st.waitFor : "";
	}
	if (
		[
			"dates",
			"room",
			"proceed",
			"date_change_confirm",
			"intentConfirm",
		].includes(st.waitFor)
	) {
		return st.waitFor;
	}
	if (st.slots?.roomTypeKey && !st.slots?.checkinISO && !st.slots?.checkoutISO) {
		return "dates";
	}
	if (!st.slots?.roomTypeKey && (st.hotel || st.waitFor === "clarify")) {
		return "";
	}
	return "";
}

function activeBookingContinuationText(
	sc = {},
	st = {},
	{ apology = false, contactBoundary = false, idle = false, omitName = false } = {}
) {
	const waitState = bookingWaitState(st);
	if (!waitState) return "";
	const name = respectfulGuestName(sc, st);
	const lang = languageOf(sc, st);
	const hotelName = st.hotel ? localizedHotelName(sc, st) || toTitle(st.hotel.hotelName) : "";
	const room = st.slots?.roomTypeKey
		? localizedRoomTypeLabel(st.slots.roomTypeKey, lang)
		: "";
	if (/arabic/i.test(lang)) {
		const prefix = omitName
			? ""
			: apology
			? `${name}، حقك عليّ. `
			: idle
			? `${name}، أنا هنا معك 🙂 `
			: `${name}، `;
		const contact = contactBoundary
			? "وبخصوص رقم الهاتف، لا أشارك الرقم من هنا، لكن أتابع معك مباشرة من خلال استقبال الفندق في هذه المحادثة. "
			: "";
		if (waitState === "dates") {
			if (apology) {
				return `${prefix}${contact}أقصد فقط أن الخطوة التالية هي تاريخ الوصول والمغادرة، بدون أي استعجال. طلبك واضح معي${room ? `: ${room}` : ""}${
					hotelName ? ` في ${hotelName}` : ""
				}. أرسلهما لي وسأراجع لك التوفر والسعر النهائي مباشرة.`;
			}
			return `${prefix}${contact}طلبك واضح معي${room ? `: ${room}` : ""}${
				hotelName ? ` في ${hotelName}` : ""
			}. أرسل تاريخ الوصول والمغادرة عندما تحب، وسأراجع لك التوفر والسعر.`;
		}
		if (waitState === "room") {
			return `${prefix}${contact}أرسل نوع الغرفة أو عدد الأشخاص عندما تحب، وسأرشح لك الأنسب مباشرة.`;
		}
		if (["reservation_details", "fullname", "nationality", "phone"].includes(waitState)) {
			const rows = reservationDetailPromptRows(sc, st, { retry: true });
			return `${prefix}${contact}\u0644\u0625\u062a\u0645\u0627\u0645 \u0627\u0644\u062d\u062c\u0632\u060c \u0623\u0631\u0633\u0644 \u0641\u0642\u0637 \u0627\u0644\u0628\u064a\u0627\u0646\u0627\u062a \u0627\u0644\u0646\u0627\u0642\u0635\u0629:\n${rows}`;
		}
		if (waitState === "email_or_skip") {
			return `${prefix}${contact}${optionalEmailPrompt(sc, st)}`;
		}
		if (waitState === "finalize") {
			return `${prefix}${contact}${finalReservationPrompt(sc, st)}`;
		}
		if (waitState === "proceed" || waitState === "reviewConfirm") {
			return `${prefix}${contact}العرض معي وجاهز. عندما تحب نكمل، أخبرني وسأتابع خطوة بخطوة بدون استعجال.`;
		}
		return `${prefix}${contact}أنا معك وأتابع المحادثة. أرسل التفصيلة التالية عندما تحب وسأكمل معك بدون استعجال.`;
	}
	const prefix = omitName
		? ""
		: apology
		? `${name}, you are right, sorry about that. `
		: idle
		? `${name}, no rush 🙂 `
		: `${name}, `;
	const contact = contactBoundary
		? "About the phone number, I cannot share it here, but I can continue with you directly through the hotel reception in this chat. "
		: "";
	if (waitState === "dates") {
		return `${prefix}${contact}I have your request${room ? ` for a ${room}` : ""}${
			hotelName ? ` at ${hotelName}` : ""
		}. When you are ready, send the arrival and departure dates and I will check availability and price.`;
	}
	if (waitState === "room") {
		return `${prefix}${contact}Send the room type or number of guests whenever you are ready, and I will suggest the right option.`;
	}
	if (["reservation_details", "fullname", "nationality", "phone"].includes(waitState)) {
		const rows = reservationDetailPromptRows(sc, st, { retry: true });
		return `${prefix}${contact}To complete the reservation, please send only the missing detail(s):\n${rows}`;
	}
	if (waitState === "email_or_skip") {
		return `${prefix}${contact}${optionalEmailPrompt(sc, st)}`;
	}
	if (waitState === "finalize") {
		return `${prefix}${contact}${finalReservationPrompt(sc, st)}`;
	}
	if (waitState === "proceed" || waitState === "reviewConfirm") {
		return `${prefix}${contact}I have the offer ready. When you want to continue, tell me and I will take it step by step without rushing you.`;
	}
	return `${prefix}${contact}I am following with you. Send the next detail whenever you are ready and I will continue without rushing you.`;
}

function preserveBookingWaitState(st = {}, previousWaitFor = "") {
	if (!st) return;
	if (previousWaitFor && bookingWaitState({ ...st, waitFor: previousWaitFor })) {
		st.waitFor = previousWaitFor;
		return;
	}
	const recovered = bookingWaitState(st);
	if (recovered) st.waitFor = recovered;
}

function preserveBookingWaitStateForCase(sc = {}, st = {}, previousWaitFor = "") {
	if (aiReservationReference(sc)) {
		st.waitFor = "post_booking_followup";
		st.reviewSent = false;
		return;
	}
	preserveBookingWaitState(st, previousWaitFor);
}

function idleFollowupText(sc = {}, st = {}) {
	const contextual = activeBookingContinuationText(sc, st, { idle: true });
	if (contextual) return contextual;
	const name = respectfulGuestName(sc, st);
	const lang = languageOf(sc, st);
	if (/arabic/i.test(lang)) {
		return `${name}، أنا هنا معك 🙂 عندما تحتاج أي مساعدة أرسل رسالتك وسأتابع فورًا.`;
	}
	if (/spanish/i.test(lang)) {
		return `${name}, sin prisa 🙂 Sigo aqui cuando me necesites.`;
	}
	if (/french/i.test(lang)) {
		return `${name}, aucune urgence 🙂 Je reste la si vous avez besoin de moi.`;
	}
	return `${name}, no rush 🙂 I am here when you need me.`;
}

function conversationEntryContextText(message = {}) {
	return [
		message?.message,
		message?.inquiryAbout ? `Inquiry about: ${message.inquiryAbout}` : "",
		message?.inquiryDetails ? `Inquiry details: ${message.inquiryDetails}` : "",
	]
		.filter(Boolean)
		.map((value) => String(value || "").trim())
		.filter(Boolean)
		.join("\n");
}

function conversationText(sc = {}, { guestsOnly = false } = {}) {
	const conversation = Array.isArray(sc.conversation) ? sc.conversation : [];
	return conversation
		.filter((message) =>
			guestsOnly ? isGuestConversationMessage(message) : message?.message
		)
		.map((message) => conversationEntryContextText(message))
		.filter(Boolean)
		.join("\n");
}

function normalizedRepeatedQuestionText(text = "") {
	const { arabic, lower } = normalizeControlText(text);
	return digitsToEnglish(arabic || lower)
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/https?:\/\/\S+/gi, " ")
		.replace(
			/\b(?:please|pls|kindly|sir|madam|dear|bro|thanks|thank|you|me|my|your|the|a|an|can|could|would|may|please)\b/gi,
			" "
		)
		.replace(/[^\p{L}\p{N}\u0600-\u06ff]+/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function repeatedSemanticQuestionKey(sc = {}, st = {}, text = "", lu = {}) {
	const raw = String(text || "").trim();
	if (!raw) return "";
	if (confidentialCompanyDocumentQuestionText(raw)) return "direct:confidential_document";
	if (wantsPaymentHelp(raw)) return "direct:payment_help";
	if (wantsDiscountQuestion(raw)) return "direct:discount";
	if (st.hotel && directHotelRelationshipQuestionText(raw)) {
		return "direct:hotel_relationship";
	}
	if (hotelContactDetailsQuestionText(raw) || hotelContactFollowupQuestionText(sc, raw)) {
		return "direct:hotel_contact";
	}
	if (vagueHajjInquiryText(raw)) return "direct:hajj";
	if (st.hotel && selectedHotelPolicyQuestionText(raw)) return "fact:policy";
	if (st.hotel && selectedHotelNusukQuestionText(raw)) return "fact:nusuk";
	if (st.hotel && selectedHotelBusQuestionText(raw)) return "fact:bus";
	if (st.hotel && selectedHotelDistanceQuestionText(raw)) return "fact:distance";
	if (st.hotel && selectedHotelAddressQuestionText(raw)) return "fact:location";
	if (st.hotel && selectedHotelRoomQuestionText(raw)) {
		return `room:${mapRoomToKey(raw) || "general"}`;
	}
	const amenityKey = lu?.amenity || findAmenityMatch(raw);
	if (st.hotel && amenityKey) return `amenity:${amenityKey}`;
	if (broadGeneralSupportQuestionText(raw, st, lu)) {
		return `general:${normalizedRepeatedQuestionText(raw).slice(0, 80)}`;
	}
	const normalized = normalizedRepeatedQuestionText(raw);
	return normalized.length >= 8 ? `text:${normalized.slice(0, 120)}` : "";
}

function isRepeatableGuestQuestion(sc = {}, st = {}, text = "", lu = {}) {
	const raw = String(text || "").trim();
	if (!raw || looksLikeGreetingOnly(raw)) return false;
	if (abusiveGuestText(raw) || humanHandoffReason(raw)) return false;
	if (confirmsText(raw) || declinesText(raw) || patienceText(raw)) return false;
	if (latestEmailFromText(raw)) return false;
	if (/^\s*\+?[\d\u0660-\u0669\u06f0-\u06f9][\d\u0660-\u0669\u06f0-\u06f9\s().-]{4,}\s*$/.test(raw)) {
		return false;
	}
	const semanticKey = repeatedSemanticQuestionKey(sc, st, raw, lu);
	if (semanticKey && !semanticKey.startsWith("text:")) return true;
	if (wantsNewReservationIntent(raw, lu) && !/[?\u061f]/.test(raw)) return false;
	return /[?\u061f]/.test(raw) && Boolean(semanticKey);
}

function repeatedGuestQuestionStats(sc = {}, st = {}, text = "", lu = {}) {
	if (!isRepeatableGuestQuestion(sc, st, text, lu)) {
		return { key: "", count: 0 };
	}
	const key = repeatedSemanticQuestionKey(sc, st, text, lu);
	if (!key) return { key: "", count: 0 };
	const conversation = Array.isArray(sc.conversation) ? sc.conversation : [];
	const guestMessages = conversation.filter(isGuestConversationMessage).slice(-40);
	let count = 0;
	for (const message of guestMessages) {
		const messageText = conversationEntryContextText(message);
		if (!isRepeatableGuestQuestion(sc, st, messageText, lu)) continue;
		if (repeatedSemanticQuestionKey(sc, st, messageText, lu) === key) {
			count += 1;
		}
	}
	return { key, count };
}

async function maybeEscalateRepeatedGuestQuestion(io, sc, st, userText = "", lu = {}) {
	const { key, count } = repeatedGuestQuestionStats(sc, st, userText, lu);
	if (!key || count < 3 || st.repeatedQuestionEscalatedKey === key) return false;
	st.repeatedQuestionEscalatedKey = key;
	logStep(String(sc._id || ""), "repeated_question.escalate", { key, count });
	await handoffToHuman(io, sc, st, "repeated_question");
	return true;
}

function initialInquiryText(sc = {}) {
	const firstMessage = Array.isArray(sc.conversation)
		? sc.conversation[0] || {}
		: {};
	return [
		sc.inquiryAbout || firstMessage.inquiryAbout || "",
		sc.inquiryDetails || firstMessage.inquiryDetails || "",
	]
		.filter(Boolean)
		.map((value) => String(value || "").trim())
		.filter(Boolean)
		.join("\n");
}

function cleanPhoneCandidate(text = "") {
	const digits = digitsToEnglish(text).replace(/\D/g, "");
	return digits.length >= 5 && digits.length <= 18 ? digits : "";
}

function latestEmailFromText(text = "") {
	const matches = String(text || "").match(/[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+/g);
	return matches?.length ? matches[matches.length - 1] : "";
}

function latestPhoneFromText(text = "") {
	const withoutEmails = String(text || "").replace(
		/[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+/g,
		" "
	);
	const phonePattern =
		/\+?[\d\u0660-\u0669\u06f0-\u06f9][\d\u0660-\u0669\u06f0-\u06f9 \t().-]{4,}/g;
	const matches = [...withoutEmails.matchAll(phonePattern)];
	if (!matches?.length) return "";
	for (let i = matches.length - 1; i >= 0; i -= 1) {
		const match = matches[i];
		const matchedText = match[0] || "";
		const index = Number(match.index || 0);
		const context = withoutEmails.slice(
			Math.max(0, index - 35),
			index + matchedText.length + 35
		);
		const before = withoutEmails.slice(Math.max(0, index - 18), index);
		const compactMatchRemainder = digitsToEnglish(matchedText)
			.replace(/[+\d\s().-]/g, "")
			.trim();
		const phone = cleanPhoneCandidate(matchedText);
		const obviousPhoneToken = Boolean(phone && !compactMatchRemainder);
		const phoneContext =
			/^\s*\+/.test(matchedText) ||
			/(?:\b(?:phone|mobile|whats\s*app|whatsapp|tel|telephone)\b|(?:\u062c\u0648\u0627\u0644|\u0647\u0627\u062a\u0641|\u0648\u0627\u062a\u0633))\s*[:#-]?\s*$/i.test(
				before
			);
		if (!phoneContext && !obviousPhoneToken && looksLikeStayDateCandidate(context)) continue;
		if (phone) return phone;
	}
	return "";
}

function digitsOnly(value = "") {
	return digitsToEnglish(String(value || "")).replace(/\D/g, "");
}

function confirmationLooksLikePhoneInText(text = "", confirmation = "") {
	const candidateDigits = digitsOnly(confirmation);
	if (!candidateDigits) return false;
	const phoneDigits = digitsOnly(latestPhoneFromText(text));
	if (!phoneDigits || phoneDigits !== candidateDigits) return false;
	const normalized = digitsToEnglish(String(text || ""));
	const index = normalized.indexOf(candidateDigits);
	if (index < 0) return false;
	const nearby = normalized
		.slice(Math.max(0, index - 55), index + candidateDigits.length + 35)
		.toLowerCase();
	const { lower, arabic, latinCompact } = normalizeControlText(nearby);
	return (
		hasSemanticSignal(nearby, ["phone", "whatsapp", "contact"]) ||
		/\b(?:phone|mobile|whatsapp|whats\s*app|contact|call|tel|my\s+number)\b/i.test(
			lower
		) ||
		/(?:\u0648\u0627\u062a\u0633|\u0648\u0627\u062a\u0633\u0627\u0628|\u062c\u0648\u0627\u0644|\u0647\u0627\u062a\u0641|\u062a\u0644\u064a\u0641\u0648\u0646|\u0631\u0642\u0645\u064a|\u0627\u062a\u0635\u0627\u0644)/i.test(
			arabic
		) ||
		/(?:whatsapp|mobile|phone|mynumber|contactnumber)/i.test(latinCompact)
	);
}

function shouldTreatLatestAsNewBooking(text = "", st = {}, lu = {}) {
	if (explicitlyExistingReservationIntent(text)) return false;
	const luWithoutPhoneConfirmation = { ...(lu || {}) };
	if (
		luWithoutPhoneConfirmation.confirmation &&
		confirmationLooksLikePhoneInText(text, luWithoutPhoneConfirmation.confirmation)
	) {
		luWithoutPhoneConfirmation.confirmation = null;
	}
	return (
		wantsNewReservationIntent(text, luWithoutPhoneConfirmation) ||
		roomCapacityOrTypeInquiryText(text) ||
		Boolean(mapRoomToKey(text)) ||
		Boolean(quickDateRange(text)?.checkinISO) ||
		isNewReservationFlowActive(st)
	);
}

function conversationHydrationRevision(conversation = []) {
	if (!Array.isArray(conversation) || !conversation.length) return "0";
	const last = conversation[conversation.length - 1] || {};
	const stableId =
		String(last._id || last.id || last.clientTag || last.messageId || "").trim();
	const text = String(last.message || "");
	return [
		conversation.length,
		stableId,
		messageTime(last) || 0,
		text.length,
	].join(":");
}

function looksLikeNameCandidate(text = "") {
	const value = String(text || "").trim();
	if (!value || value.length > 80) return false;
	if (latestEmailFromText(value) || cleanPhoneCandidate(value)) return false;
	if (/confirm|confirmation|book|reserve|price|date|room|\u062d\u062c\u0632|\u062a\u0627\u0631\u064a\u062e|\u063a\u0631\u0641/i.test(value)) return false;
	return /[A-Za-z\u0600-\u06FF]{2,}/.test(value);
}

function obviousReservationIdentityOrContactPayloadText(text = "") {
	const value = String(text || "").trim();
	if (!value) return false;
	if (latestEmailFromText(value)) return true;
	if (
		/(?:\b(?:full\s*name|guest\s*name|passport\s*name|my\s+name|name\s+is|nationality|country|phone|mobile|whats\s*app|whatsapp|email|e-mail|adults?|children|kids?|guests?|people|persons?|pax)\b|(?:\u0627\u0644\u0627\u0633\u0645|\u0627\u0633\u0645|\u0627\u0644\u062c\u0646\u0633\u064a\u0629|\u062c\u0646\u0633\u064a\u062a\u064a|\u062c\u0646\u0633\u064a\u062a\u0649|\u0628\u0644\u062f\u064a|\u062c\u0648\u0627\u0644|\u0647\u0627\u062a\u0641|\u0628\u0631\u064a\u062f|\u0627\u064a\u0645\u064a\u0644|\u0628\u0627\u0644\u063a|\u0628\u0627\u0644\u063a\u064a\u0646|\u0627\u0637\u0641\u0627\u0644|\u0623\u0637\u0641\u0627\u0644|\u0636\u064a\u0648\u0641))/i.test(
			value
		)
	) {
		return true;
	}
	const lines = value
		.split(/[\n\r;|]+/)
		.map((line) => line.trim())
		.filter(Boolean);
	if (lines.length < 2) return false;
	return lines.some((line) => {
		const digitLine = digitsToEnglish(line);
		const digits = digitLine.replace(/\D/g, "");
		if (digits.length < 5 || digits.length > 18) return false;
		const remainder = digitLine.replace(/[+\d\s().-]/g, "").trim();
		return !remainder;
	});
}

function hydrateKnownSlotsFromConversation(
	sc = {},
	st = {},
	{ protectLatestGuestDateChange = false } = {}
) {
	const hydrationStartedAt = now();
	let hydrationStageStartedAt = hydrationStartedAt;
	const hydrationStages = [];
	const markHydrationStage = (stage) => {
		const stageNow = now();
		hydrationStages.push({
			stage,
			elapsedMs: stageNow - hydrationStageStartedAt,
		});
		hydrationStageStartedAt = stageNow;
	};
	const conversation = Array.isArray(sc.conversation) ? sc.conversation : [];
	if (!conversation.length) {
		return;
	}
	const revision = conversationHydrationRevision(conversation);
	const needsStayRecovery =
		!st.slots?.checkinISO ||
		!st.slots?.checkoutISO ||
		!st.slots?.roomTypeKey;
	const needsIdentityRecovery =
		!st.slots?.phone ||
		(st.waitFor === "email_or_skip" && !st.slots?.email && !st.slots?.emailSkipped) ||
		(AI_REQUIRE_NATIONALITY && !hasUsableNationality(st.slots?.nationality)) ||
		!st.slots?.adultsProvided ||
		!hasUsableFullName(st.slots?.fullName || st.slots?.name || "");
	const needsSlotRecovery = needsStayRecovery || needsIdentityRecovery;
	if (st.hydratedConversationLength === conversation.length && !needsSlotRecovery) {
		return;
	}
	if (
		!needsStayRecovery &&
		st.hydratedStayConversationRevision === revision &&
		(!needsIdentityRecovery || st.hydratedIdentityConversationRevision === revision)
	) {
		return;
	}
	const before = JSON.stringify(st.slots || {});
	if (AI_REQUIRE_NATIONALITY && st.slots?.nationality && !hasUsableNationality(st.slots.nationality)) {
		st.slots.nationality = null;
	}
	const guestMessages = [];
	let latestGuestDateRange = null;
	let latestConversationDateRange = null;
	let protectedLatestGuestDateRange = null;
	const latestGuestIndex = protectLatestGuestDateChange
		? latestGuestMessageIndex(sc)
		: -1;
	let latestGuestNationality = "";
	for (let index = 0; index < conversation.length; index += 1) {
		const message = conversation[index];
		const rawMessageText = String(message?.message || "").trim();
		const messageText = rawMessageText || conversationEntryContextText(message);
		if (!messageText || message?.isSystem) continue;
		const guestMessage = isGuestConversationMessage(message);
		if (guestMessage) {
			const messageDates =
				needsStayRecovery || protectLatestGuestDateChange
					? extractDateRange(messageText)
					: { checkinISO: null, checkoutISO: null };
			if (
				messageDates.checkinISO &&
				messageDates.checkoutISO &&
				!needsExplicitPastDateClarification(messageText, messageDates)
			) {
				if (
					index === latestGuestIndex &&
					shouldConfirmDateRangeChange(st, messageDates)
				) {
					protectedLatestGuestDateRange = messageDates;
				} else {
					latestConversationDateRange = messageDates;
					latestGuestDateRange = messageDates;
				}
			}
			const messageNationality = latestNationalityHintFromText(messageText);
			if (messageNationality) latestGuestNationality = messageNationality;
		}
		if (!guestMessage) continue;
		if (messageText) guestMessages.push(messageText);
	}
	markHydrationStage("date_guest_loop");
	const guestText = guestMessages.join("\n") || conversationText(sc, { guestsOnly: true });
	const latestAssistantBeforeGuest = lastAssistantMessageBeforeLatestGuest(sc);
	const identityText = assistantMessageSuggestsReservationDetails(latestAssistantBeforeGuest)
		? lastUserText(sc)
		: guestText;
	if (latestGuestDateRange) {
		mergeDateRangeIntoState(st, latestGuestDateRange);
	} else if (latestConversationDateRange) {
		mergeDateRangeIntoState(st, latestConversationDateRange, { onlyIfMissing: true });
	}
	markHydrationStage("date_merge");
	if (protectedLatestGuestDateRange) {
		logStep(String(sc._id || ""), "slots.latest_date_change_protected", {
			current: currentDateRange(st),
			proposed: {
				checkinISO: protectedLatestGuestDateRange.checkinISO,
				checkoutISO: protectedLatestGuestDateRange.checkoutISO,
			},
			waitFor: st.waitFor || "",
		});
	}
	markHydrationStage("date_protection");
	if (needsStayRecovery) {
		applyLatestRoomSignalFromConversation(sc, st, {
			source: "slots.hydrate_room_signal",
		});
		if (
			st.slots?.checkinISO &&
			st.slots?.checkoutISO &&
			st.slots?.roomTypeKey
		) {
			st.hydratedStayConversationRevision = revision;
		}
		markHydrationStage("room_loop");
	} else {
		st.hydratedStayConversationRevision = revision;
		markHydrationStage("room_loop_skipped");
	}
	if (needsIdentityRecovery && st.hydratedIdentityConversationRevision !== revision) {
		const email = latestEmailFromText(identityText);
		if (email && !st.slots.email) st.slots.email = email;
		const phone = latestPhoneFromText(identityText);
		if (phone && !st.slots.phone) st.slots.phone = phone;
		const nationalitySource = nationalityCandidateFromText(identityText);
		const nationality =
			latestGuestNationality ||
			latestNationalityHintFromText(nationalitySource || identityText) ||
			nationalityHintFromText(nationalitySource || identityText);
		if (nationality) {
			st.slots.nationality = nationality;
		}
		markHydrationStage("guest_identity_extract");
		for (const message of conversation) {
			if (!isGuestConversationMessage(message)) continue;
			const contact = String(message?.messageBy?.customerEmail || "");
			const contactEmail = latestEmailFromText(contact);
			const contactPhone = cleanPhoneCandidate(contact);
			if (contactEmail && !st.slots.email) st.slots.email = contactEmail;
			if (contactPhone && !st.slots.phone) st.slots.phone = contactPhone;
		}
		markHydrationStage("contact_loop");
		let lastAsk = "";
		for (const message of conversation) {
			const text = String(message?.message || "");
			if (isAiConversationMessage(message)) {
				if (/full name|passport|guest name|name|\u0627\u0644\u0627\u0633\u0645|\u0627\u0633\u0645/i.test(text)) {
					lastAsk = "name";
				} else if (/nationality|\u0627\u0644\u062c\u0646\u0633\u064a\u0629|\u062c\u0646\u0633\u064a/i.test(text)) {
					lastAsk = "nationality";
				} else if (/phone|mobile|whatsapp|\u062c\u0648\u0627\u0644|\u0647\u0627\u062a\u0641|\u0648\u0627\u062a\u0633/i.test(text)) {
					lastAsk = "phone";
				} else if (/email|mail|\u0628\u0631\u064a\u062f|\u0627\u064a\u0645\u064a\u0644/i.test(text)) {
					lastAsk = "email";
				}
				continue;
			}
			if (!isGuestConversationMessage(message)) continue;
			if (likelyGuestCountText(text)) {
				applyReservationGuestCountsFromText(st, text);
			}
			if (lastAsk === "name" && !st.slots.fullName) {
				const candidate = lineNameCandidateFromText(text) || cleanFullNameCandidate(text);
				if (candidate) {
					st.slots.fullName = candidate;
					st.slots.name = candidate;
				}
			} else if (lastAsk === "phone" && !st.slots.phone) {
				const candidate = latestPhoneFromText(text);
				if (candidate) st.slots.phone = candidate;
			} else if (lastAsk === "email" && !st.slots.email) {
				const candidate = latestEmailFromText(text);
				if (candidate) st.slots.email = candidate;
				else if (emailSkipText(text)) {
					st.slots.email = "";
					st.slots.emailSkipped = true;
				}
			} else if (lastAsk === "nationality" && !hasUsableNationality(st.slots.nationality)) {
				const value = nationalityCandidateFromText(text) || asciiize(text).trim();
				const normalized = latestNationalityHintFromText(value) || nationalityHintFromText(value) || value;
				if (hasUsableNationality(normalized)) st.slots.nationality = normalized;
			}
		}
		st.hydratedIdentityConversationRevision = revision;
		markHydrationStage("detail_followup_loop");
	} else {
		markHydrationStage("guest_identity_skipped");
	}
	st.hydratedConversationLength = conversation.length;
	st.hydratedConversationRevision = revision;
	if (before !== JSON.stringify(st.slots || {})) {
		logStep(String(sc._id || ""), "slots.hydrated", { slots: st.slots });
	}
	markHydrationStage("finalize");
	const hydrationElapsedMs = now() - hydrationStartedAt;
	if (hydrationElapsedMs >= 500) {
		console.log("[aiagent] slow slots hydrate", {
			caseId: String(sc._id || ""),
			elapsedMs: hydrationElapsedMs,
			conversationLength: conversation.length,
			guestMessages: guestMessages.length,
			waitFor: st.waitFor || null,
			latestUserMessage: lastUserText(sc).slice(0, 160),
			stages: hydrationStages,
		});
	}
}

function lastAssistantMessageBeforeLatestGuest(sc = {}) {
	const conversation = Array.isArray(sc.conversation) ? sc.conversation : [];
	let sawLatestGuest = false;
	for (let index = conversation.length - 1; index >= 0; index -= 1) {
		const message = conversation[index];
		if (!sawLatestGuest) {
			if (isGuestConversationMessage(message)) {
				sawLatestGuest = true;
			}
			continue;
		}
		if (isAiConversationMessage(message)) return message;
	}
	return null;
}

function assistantMessagesBeforeLatestGuest(sc = {}) {
	const conversation = Array.isArray(sc.conversation) ? sc.conversation : [];
	const latestGuestIndex = latestGuestMessageIndex(sc);
	if (latestGuestIndex < 0) return [];
	return conversation
		.slice(0, latestGuestIndex)
		.filter((message) => !message?.isSystem && isAiConversationMessage(message));
}

function quickReplyActions(message = {}) {
	if (!message || typeof message !== "object") return [];
	return Array.isArray(message.quickReplies)
		? message.quickReplies
				.map((reply) => String(reply?.action || "").trim().toLowerCase())
				.filter(Boolean)
		: [];
}

function assistantMessageSuggestsProceed(message = {}) {
	const actions = quickReplyActions(message);
	if (
		actions.some((action) =>
			["proceed", "proceed_to_booking", "continue", "continue_booking"].includes(action)
		)
	) {
		return true;
	}
	const { lower, arabic, latinCompact } = normalizeControlText(message?.message || "");
	return (
		/would you like me to continue|shall i continue|continue to the review|continue with the reservation details|proceed to confirm|yes,\s*proceed|choose\s+["']?yes|if this works for you/i.test(
			lower
		) ||
		/(?:\u0647\u0644\s+\u062a\u0631\u063a\u0628\s+\u0627\u0646\s+\u0627\u062a\u0627\u0628\u0639|\u0647\u0644\s+\u062a\u0631\u064a\u062f\s+\u0627\u0644\u0645\u062a\u0627\u0628\u0639\u0647|\u0647\u0644\s+\u0646\u062a\u0627\u0628\u0639|\u0627\u062a\u0627\u0628\u0639\s+\u0644\u0645\u0631\u0627\u062c\u0639\u0647\s+\u0627\u0644\u062d\u062c\u0632|\u0645\u0631\u0627\u062c\u0639\u0647\s+\u0627\u0644\u062d\u062c\u0632|\u0627\u062e\u062a\u0631\s+["']?\u0646\u0639\u0645|\u0646\u0639\u0645\s*[\u060c,]\s*\u062a\u0627\u0628\u0639|\u0625\u0630\u0627\s+\u064a\u0646\u0627\u0633\u0628\u0643)/i.test(
			arabic
		) ||
		/(?:wouldyoulikemetocontinue|shallicontinue|continuetothereview|continuewiththereservationdetails|proceedtoconfirm|yesproceed|chooseyes|ifthisworksforyou|wanttocontinue)/i.test(
			latinCompact
		)
	);
}

function assistantMessageSuggestsReview(message = {}) {
	const actions = quickReplyActions(message);
	const { lower, arabic, latinCompact } = normalizeControlText(message?.message || "");
	const hasConfirmAction = actions.includes("confirm");
	const looksLikeReview =
		/reservation review|review before we finalize|type confirm to finalize|confirm to finalize|tell me what to change|everything looks correct/i.test(
			lower
		) ||
		/(?:\u0645\u0631\u0627\u062c\u0639\u0647\s+\u0633\u0631\u064a\u0639\u0647\s+\u0644\u062a\u0641\u0627\u0635\u064a\u0644\s+\u0627\u0644\u062d\u062c\u0632|\u0627\u0630\u0627\s+\u0643\u0644\s+\u0634\u064a\u0621\s+\u0635\u062d\u064a\u062d|\u0627\u062e\u062a\u0631\s+\"\u062a\u0627\u0643\u064a\u062f\"|\u0647\u0646\u0627\u0643\s+\u0634\u064a\u0621\s+\u063a\u064a\u0631\s+\u0635\u062d\u064a\u062d)/i.test(
			arabic
		) ||
		/(?:reservationreview|confirmtofinalize|everythinglookscorrect|chooseconfirm|somethingiswrong)/i.test(
			latinCompact
		);
	return hasConfirmAction || (actions.includes("correction") && looksLikeReview) || looksLikeReview;
}

function assistantMessageSuggestsEmailOrSkip(message = {}) {
	const actions = quickReplyActions(message);
	const text = String(message?.message || "");
	return (
		actions.includes("skip_email") ||
		/required details.*payment link by email|receive the confirmation and payment link by email|choose skip|pulsa omitir|cliquez sur ignorer|\u0623\u0648\s+\u0627\u0636\u063a\u0637\s+\u062a\u062e\u0637\u064a/i.test(
			text
		)
	);
}

function assistantMessageSuggestsReservationDetails(message = {}) {
	const { lower, arabic } = normalizeControlText(message?.message || "");
	return (
		/full name[\s\S]{0,160}(?:phone|mobile)[\s\S]{0,160}nationality/i.test(
			lower
		) ||
		/(?:to complete|complete the reservation|i still need|still need)[\s\S]{0,220}(?:full name|phone|nationality|guests)/i.test(
			lower
		) ||
		/(?:\u0644\u0627\u062a\u0645\u0627\u0645\s+\u0627\u0644\u062d\u062c\u0632|\u0645\u0627\s+\u0632\u0644\u062a\s+\u0627\u062d\u062a\u0627\u062c|\u0644\u0627\u0632\u0645\s+\u0627\u062d\u062a\u0627\u062c)[\s\S]{0,220}(?:\u0627\u0644\u0627\u0633\u0645\s+\u0627\u0644\u0643\u0627\u0645\u0644|\u0631\u0642\u0645\s+\u0627\u0644\u0647\u0627\u062a\u0641|\u0627\u0644\u062c\u0646\u0633\u064a\u0647|\u0639\u062f\u062f\s+\u0627\u0644\u0636\u064a\u0648\u0641)/i.test(
			arabic
		)
	);
}

function assistantMessageCanRecoverRoomType(message = {}) {
	const actions = quickReplyActions(message);
	if (
		actions.some((action) =>
			[
				"proceed",
				"proceed_to_booking",
				"continue",
				"continue_booking",
				"confirm",
				"correction",
				"place_reservation",
			].includes(action)
		)
	) {
		return true;
	}
	const { lower, arabic, latinCompact } = normalizeControlText(message?.message || "");
	return (
		assistantMessageSuggestsProceed(message) ||
		assistantMessageSuggestsReview(message) ||
		roomSelectionSignalText(message?.message || "", { assistant: true }) ||
		/total|night|nights|reservation|booking|quote/i.test(lower) ||
		/(?:\u0627\u0644\u063a\u0631\u0641\u0647|\u0627\u0644\u0641\u0646\u062f\u0642|\u0627\u0644\u0627\u062c\u0645\u0627\u0644\u064a|\u0644\u064a\u0644\u0647|\u0644\u064a\u0627\u0644\u064a|\u062d\u062c\u0632)/i.test(
			arabic
		) ||
		/(?:total|night|nights|reservation|booking|quote)/i.test(latinCompact)
	);
}

function assistantRoomQuoteContextText(message = {}) {
	const actions = quickReplyActions(message);
	if (
		actions.some((action) =>
			[
				"proceed",
				"proceed_to_booking",
				"continue",
				"continue_booking",
				"confirm",
				"correction",
				"place_reservation",
			].includes(action)
		)
	) {
		return true;
	}
	const raw = typeof message === "string" ? message : message?.message || "";
	const { lower, arabic, latinCompact } = normalizeControlText(raw);
	return (
		assistantMessageSuggestsProceed(message) ||
		assistantMessageSuggestsReview(message) ||
		/\b(?:total|night|nights|reservation|booking|quote|price|rate|availability|available|check[\s-]?in|check[\s-]?out|dates?)\b/i.test(
			lower
		) ||
		/(?:\u0627\u0644\u0627\u062c\u0645\u0627\u0644\u064a|\u0627\u0644\u0625\u062c\u0645\u0627\u0644\u064a|\u0644\u064a\u0644\u0647|\u0644\u064a\u0627\u0644\u064a|\u062d\u062c\u0632|\u0633\u0639\u0631|\u0645\u062a\u0627\u062d|\u0627\u0644\u062a\u0648\u0627\u0631\u064a\u062e|\u0627\u0644\u0648\u0635\u0648\u0644|\u0627\u0644\u0645\u063a\u0627\u062f\u0631\u0629)/i.test(
			arabic
		) ||
		/(?:total|night|nights|reservation|booking|quote|price|rate|availability|available|checkin|checkout|dates)/i.test(
			latinCompact
		)
	);
}

function roomTypeKeysMentionedBySections(text = "") {
	const raw = String(text || "");
	if (!raw.trim()) return [];
	const sections = raw
		.split(/[\n\r]+|[;,\u060c\u061b/]+|\s[-\u2013\u2014]\s/g)
		.map((part) => part.trim())
		.filter(Boolean);
	const keys = new Set();
	for (const section of sections) {
		const key = mapRoomToKey(section);
		if (key) keys.add(key);
	}
	return [...keys];
}

function assistantRoomOptionsPromptText(text = "") {
	const raw = String(text || "");
	if (!raw.trim()) return false;
	const { lower, arabic, latinCompact } = normalizeControlText(raw);
	const mentionedKeys = roomTypeKeysMentionedBySections(raw);
	if (mentionedKeys.length < 2) return false;
	return (
		generalRoomOptionsQuestionText(raw) ||
		/\b(?:which|what)\s+(?:room|type|option)\s+(?:do\s+you\s+prefer|would\s+you\s+prefer|works\s+for\s+you)\b/i.test(
			lower
		) ||
		/(?:\u0623\u064a|\u0627\u064a|\u0623\u064a\u0647|\u0627\u064a\u0647|which).{0,40}(?:\u0646\u0648\u0639|\u063a\u0631\u0641\u0629|\u063a\u0631\u0641\u0647|\u062e\u064a\u0627\u0631).{0,80}(?:\u062a\u0641\u0636\u0644|\u064a\u0646\u0627\u0633\u0628|\u062a\u062e\u062a\u0627\u0631)/i.test(
			arabic
		) ||
		/(?:whichroom|whichoption|whatroom|prefer|choose|tfdl|takhtar|ynasb)/i.test(
			latinCompact
		)
	);
}

function roomSelectionSignalText(text = "", { assistant = false } = {}) {
	const raw = String(text || "").trim();
	if (!raw) return false;
	const { lower, arabic, latinCompact } = normalizeControlText(raw);
	const hasRoomOrCapacity =
		likelyRoomTypeText(raw) ||
		Boolean(mapRoomToKey(raw)) ||
		Boolean(requestedGuestCountFromText(raw));
	const directChoice =
		/\b(?:i|we)\s+(?:want|need|prefer|choose|chose|selected|will\s+take|would\s+take|would\s+like|go\s+with)\b/i.test(
			lower
		) ||
		/\b(?:book|reserve|make\s+(?:a\s+)?reservation|take\s+(?:the|a)?|go\s+with)\b.{0,80}\b(?:room|double|triple|quad|family|quintuple|bed|guest|people|person|friend)\b/i.test(
			lower
		) ||
		/(?:\u0639\u0627\u064a\u0632|\u0639\u0627\u0648\u0632|\u0627\u0628\u063a\u0649|\u0623\u0628\u063a\u0649|\u0627\u0631\u064a\u062f|\u0623\u0631\u064a\u062f|\u0646\u062d\u062a\u0627\u062c|\u0627\u062d\u062a\u0627\u062c|\u0627\u062e\u062a\u0627\u0631|\u0627\u062e\u062a\u064a\u0627\u0631|\u0627\u062d\u062c\u0632|\u0623\u062d\u062c\u0632|\u0644\u064a\u0627\s+\u0648|\u0644\u064a\s+\u0648|\u0627\u0646\u0627\s+\u0648|\u0623\u0646\u0627\s+\u0648)/i.test(
			arabic
		) ||
		/(?:iwant|wewant|ineed|weneed|iprefer|weprefer|choose|chose|selected|bookroom|reserveroom|gowith|takearoom|meandmy|anawe|anawa|liyawe|leyawa)/i.test(
			latinCompact
		);
	const recommendation =
		/\b(?:recommend|recommended|suggest|suggested|best|better|right|suitable|ideal|fit|fits|works\s+best|most\s+comfortable)\b.{0,120}\b(?:room|double|triple|quad|family|quintuple|guest|people|beds?)\b/i.test(
			lower
		) ||
		/\b(?:room|double|triple|quad|family|quintuple|guest|people|beds?)\b.{0,120}\b(?:recommend|recommended|suggest|suggested|best|better|right|suitable|ideal|fit|fits)\b/i.test(
			lower
		) ||
		/(?:\u0627\u0631\u0634\u062d|\u0623\u0631\u0634\u062d|\u0627\u0646\u0635\u062d|\u0623\u0646\u0635\u062d|\u0627\u0646\u0633\u0628|\u0623\u0646\u0633\u0628|\u0645\u0646\u0627\u0633\u0628|\u0645\u0646\u0627\u0633\u0628\u0629|\u0627\u0641\u0636\u0644|\u0623\u0641\u0636\u0644|\u0627\u0644\u0627\u0641\u0636\u0644|\u0627\u0644\u0623\u0641\u0636\u0644|\u064a\u0646\u0627\u0633\u0628|\u062a\u0646\u0627\u0633\u0628|\u0627\u0644\u0627\u062e\u062a\u064a\u0627\u0631\s+\u0627\u0644\u0627\u0646\u0633\u0628|\u0627\u0644\u062e\u064a\u0627\u0631\s+\u0627\u0644\u0627\u0646\u0633\u0628)/i.test(
			arabic
		) ||
		/(?:recommend|recommended|suggest|suggested|bestfit|suitable|ideal|ansab|arshah|arshh|afdal)/i.test(
			latinCompact
		);
	const priorReference =
		/\b(?:didn'?t\s+you\s+say|did\s+you\s+not\s+say|you\s+(?:said|told|mentioned|recommended|suggested)|earlier|before|previously)\b.{0,120}\b(?:room|double|triple|quad|family|quintuple|bed)\b/i.test(
			lower
		) ||
		/(?:\u0645\u0634|\u0647\u0648|\u0645\u0627|\u0627\u0646\u062a|\u0627\u0646\u062a\u064a|\u0627\u0646\u062a\u0649|\u0627\u0646\u062a\u0647|\u0627\u0646\u062a\u064a\u061f)?\s*(?:\u0642\u0644\u062a|\u0642\u0648\u0644\u062a|\u0642\u0644\u062a\u064a|\u0642\u0648\u0644\u062a\u064a|\u0642\u0648\u0644\u062a\u0649|\u0630\u0643\u0631\u062a|\u0631\u0634\u062d\u062a).{0,100}(?:\u063a\u0631\u0641\u0629|\u063a\u0631\u0641\u0647|\u0645\u0632\u062f\u0648\u062c|\u062b\u0646\u0627\u0626|\u062f\u0628\u0644|\u062b\u0644\u0627\u062b|\u0631\u0628\u0627\u0639|\u062e\u0645\u0627\u0633|\u0639\u0627\u0626\u0644\u064a)/i.test(
			arabic
		) ||
		/(?:yousaid|didntyousay|didyounotsay|youtold|yourecommended|earlier|before|previously|olt|olti|oulti|kontolti)/i.test(
			latinCompact
		);
	const priceOrAvailability =
		/\b(?:price|prices|rate|rates|cost|how\s+much|quote|availability|available|check)\b/i.test(
			lower
		) ||
		/(?:\u0633\u0639\u0631|\u0627\u0633\u0639\u0627\u0631|\u0627\u0644\u0633\u0639\u0631|\u0628\u0643\u0627\u0645|\u0643\u0627\u0645|\u062a\u0643\u0644\u0641\u0647|\u062a\u0643\u0644\u0641\u0629|\u0645\u062a\u0627\u062d|\u062a\u0648\u0641\u0631|\u0627\u0644\u062a\u0648\u0641\u0631)/i.test(
			arabic
		) ||
		/(?:price|rate|cost|howmuch|quote|availability|available|bkam|bekam|kam|se3r|s3r|motah|tawafor)/i.test(
			latinCompact
		);
	return Boolean(
		hasRoomOrCapacity &&
			(directChoice ||
				recommendation ||
				priorReference ||
				priceOrAvailability ||
				(assistant && recommendation))
	);
}

function exploratoryRoomReferenceText(text = "") {
	const raw = String(text || "").trim();
	if (!raw) return false;
	const { lower, arabic, latinCompact } = normalizeControlText(raw);
	const asksMeaning =
		/\b(?:what|whats|what's|meaning|mean|explain|details?)\b.{0,80}\b(?:double|triple|quad|quadruple|family|quintuple|room|suite)\b/i.test(
			lower
		) ||
		/(?:\u0627\u064a\u0647|\u0625\u064a\u0647|\u064a\u0639\u0646\u064a|\u0645\u0639\u0646\u0649|\u0627\u0634\u0631\u062d|\u0641\u0633\u0631|\u062a\u0641\u0627\u0635\u064a\u0644).{0,80}(?:\u063a\u0631\u0641\u0629|\u063a\u0631\u0641\u0647|\u0645\u0632\u062f\u0648\u062c|\u062b\u0646\u0627\u0626|\u062f\u0628\u0644|\u062b\u0644\u0627\u062b|\u0631\u0628\u0627\u0639|\u062e\u0645\u0627\u0633|\u0639\u0627\u0626\u0644\u064a|quintuple|double|triple)/i.test(
			arabic
		) ||
		/(?:whatdoes|whatis|whats|meaningof|explain|details|ayh|eih|yani|ma3na).{0,80}(?:double|triple|quad|family|quintuple|room|ghorfa|oda)/i.test(
			latinCompact
		);
	return asksMeaning || generalRoomOptionsQuestionText(raw);
}

function roomKeyFromConversationRoomSignal(
	text = "",
	{ assistant = false, quoteContext = false } = {}
) {
	const raw = String(text || "").trim();
	if (!raw) return "";
	if (assistant && quoteContext) {
		const quoteRoomTypeKey = mapRoomToKey(raw);
		if (quoteRoomTypeKey) return quoteRoomTypeKey;
		const sectionRoomTypeKey = roomTypeKeysMentionedBySections(raw)[0] || "";
		return sectionRoomTypeKey;
	}
	const explicitRoomTypeKey = mapRoomToKey(raw);
	const earlySelectionSignal = explicitRoomTypeKey
		? roomSelectionSignalText(raw, { assistant })
		: false;
	const earlyShortExplicitRoomChoice =
		!assistant &&
		Boolean(explicitRoomTypeKey) &&
		raw.length <= 48 &&
		!exploratoryRoomReferenceText(raw) &&
		!generalRoomOptionsQuestionText(raw);
	if (explicitRoomTypeKey && (earlyShortExplicitRoomChoice || earlySelectionSignal)) {
		return explicitRoomTypeKey;
	}
	if (!(assistant && quoteContext) && reservationIdentityOrContactPayloadText(raw)) {
		return "";
	}
	if (assistant && assistantRoomOptionsPromptText(raw)) return "";
	const shortExplicitRoomChoice =
		!assistant &&
		Boolean(explicitRoomTypeKey) &&
		raw.length <= 48 &&
		!exploratoryRoomReferenceText(raw) &&
		!generalRoomOptionsQuestionText(raw);
	if (shortExplicitRoomChoice) return explicitRoomTypeKey;
	const selectionSignal = earlySelectionSignal || roomSelectionSignalText(raw, { assistant });
	if (!selectionSignal && !quoteContext) return "";
	if (!quoteContext && exploratoryRoomReferenceText(raw) && !selectionSignal) return "";
	const requestedGuestCount = requestedGuestCountFromText(raw);
	const recommendedRoomKey = recommendedRoomTypeKeyForGuestCount(requestedGuestCount);
	if (selectionSignal && recommendedRoomKey) return recommendedRoomKey;
	const roomTypeKey = explicitRoomTypeKey;
	if (roomTypeKey) return roomTypeKey;
	return selectionSignal ? recommendedRoomKey || "" : "";
}

function latestRoomSignalFromConversation(sc = {}) {
	const conversation = Array.isArray(sc.conversation) ? sc.conversation : [];
	for (let index = conversation.length - 1; index >= 0; index -= 1) {
		const message = conversation[index];
		const messageText =
			String(message?.message || "").trim() || conversationEntryContextText(message);
		if (!messageText || message?.isSystem) continue;
		const guestMessage = isGuestConversationMessage(message);
		const assistantMessage = !guestMessage && isAiConversationMessage(message);
		if (!guestMessage && !assistantMessage) continue;
		if (guestMessage && obviousReservationIdentityOrContactPayloadText(messageText)) {
			continue;
		}
		if (assistantMessage && assistantMessageSuggestsReservationDetails(message)) {
			continue;
		}
		const quoteContext = assistantMessage && assistantRoomQuoteContextText(message);
		const roomTypeKey = roomKeyFromConversationRoomSignal(messageText, {
			assistant: assistantMessage,
			quoteContext,
		});
		if (!roomTypeKey) continue;
		const signal = {
			roomTypeKey,
			index,
			source: guestMessage
				? "guest_room_signal"
				: roomSelectionSignalText(messageText, { assistant: true })
				? "assistant_room_recommendation"
				: "assistant_quote",
		};
		if (
			assistantMessage &&
			signal.source === "assistant_quote" &&
			conversation
				.slice(index + 1)
				.some((laterMessage) => {
					if (!isGuestConversationMessage(laterMessage)) return false;
					const laterText =
						String(laterMessage?.message || "").trim() ||
						conversationEntryContextText(laterMessage);
					const laterRoomTypeKey = roomKeyFromConversationRoomSignal(laterText);
					return laterRoomTypeKey && laterRoomTypeKey !== signal.roomTypeKey;
				})
		) {
			continue;
		}
		return signal;
	}
	return null;
}

function applyLatestRoomSignalFromConversation(
	sc = {},
	st = {},
	{ source = "conversation_room_signal" } = {}
) {
	const signal = latestRoomSignalFromConversation(sc);
	if (!signal?.roomTypeKey) return false;
	st.slots = st.slots || {};
	if (st.slots.roomTypeKey === signal.roomTypeKey) return false;
	const previousRoomTypeKey = st.slots.roomTypeKey || null;
	st.slots.roomTypeKey = signal.roomTypeKey;
	st.quote = null;
	st.quoteSummarizedAt = 0;
	st.reviewSent = false;
	st.pendingRoomAlternative = null;
	st.pendingRoomCombination = null;
	logStep(String(sc._id || ""), "slots.room_changed_from_conversation", {
		previousRoomTypeKey,
		roomTypeKey: signal.roomTypeKey,
		source,
		signalSource: signal.source,
		signalIndex: signal.index,
	});
	return true;
}

function assistantBookingStageFromMessage(message = {}) {
	const actions = quickReplyActions(message);
	if (actions.some((action) => action.startsWith("connect_hotel_"))) {
		return "platform_hotel_choice";
	}
	if (actions.includes("place_reservation")) return "finalize";
	if (assistantMessageSuggestsEmailOrSkip(message)) return "email_or_skip";
	if (assistantMessageSuggestsReservationDetails(message)) return "reservation_details";
	if (assistantMessageSuggestsReview(message)) return "reviewConfirm";
	if (assistantMessageSuggestsProceed(message)) return "proceed";
	return "";
}

function recoverBookingStageFromConversation(sc = {}, st = {}) {
	if (!st) return;
	if (
		sc.aiReservation?.status === "created" ||
		sc.aiReservation?.confirmationNumber ||
		sc.aiReservation?.reservationId
	) {
		st.waitFor = "post_booking_followup";
		st.reviewSent = false;
		return;
	}
	const assistantHistory = assistantMessagesBeforeLatestGuest(sc).reverse();
	const lastAssistant = assistantHistory[0] || null;
	if (!lastAssistant) return;
	const stage = assistantBookingStageFromMessage(
		assistantHistory.find((assistant) => assistantBookingStageFromMessage(assistant)) ||
			lastAssistant
	);
	if (
		[
			"proceed",
			"reviewConfirm",
			"reservation_details",
			"email_or_skip",
			"finalize",
		].includes(stage) &&
		st.hotel &&
		quoteKeyForSlots(st)
	) {
		ensureCurrentQuoteForSlots(st);
	}
	const hasRecoverableBookingContext = Boolean(
		st.reviewSent ||
			st.quote ||
			(st.hotel &&
				st.slots?.checkinISO &&
				st.slots?.checkoutISO &&
				st.slots?.roomTypeKey)
	);
	if (isReservationDetailStep(st)) {
		if (stage === "finalize") {
			st.reviewSent = true;
			st.waitFor = "finalize";
		}
		return;
	}
	if (stage === "platform_hotel_choice") {
		st.waitFor = "platform_hotel_choice";
		return;
	}
	if (stage === "finalize") {
		if (!hasRecoverableBookingContext) return;
		st.reviewSent = true;
		st.waitFor = "finalize";
		return;
	}
	if (stage === "email_or_skip") {
		if (!hasRecoverableBookingContext) return;
		st.waitFor = "email_or_skip";
		return;
	}
	if (stage === "reservation_details") {
		if (!hasRecoverableBookingContext) return;
		st.reviewSent = true;
		st.waitFor = "reservation_details";
		return;
	}
	if (stage === "reviewConfirm") {
		if (!hasRecoverableBookingContext) return;
		st.reviewSent = true;
		st.waitFor = "reviewConfirm";
		return;
	}
	if (stage === "proceed" && st.hotel && quoteKeyForSlots(st)) {
		if (!st.quote || st.quote.key !== quoteKeyForSlots(st)) {
			const quote = safePriceRoomForStay(
				st.hotel,
				{ roomType: st.slots.roomTypeKey },
				st.slots.checkinISO,
				st.slots.checkoutISO
			);
			st.quote = { key: quoteKeyForSlots(st), at: now(), data: quote };
		}
		if (st.quote?.data?.available) {
			st.waitFor = "proceed";
			return;
		}
	}

	if (!hasRecoverableBookingContext) return;
	for (const assistant of assistantHistory) {
		const text = String(assistant.message || "");
		if (
			/\u0644\u0625\u062a\u0645\u0627\u0645\s+\u0627\u0644\u062d\u062c\u0632[\s\S]{0,200}(?:\u0627\u0644\u0627\u0633\u0645\s+\u0627\u0644\u0643\u0627\u0645\u0644|\u0631\u0642\u0645\s+\u0627\u0644\u0647\u0627\u062a\u0641|\u0627\u0644\u062c\u0646\u0633\u064a\u0629)/i.test(
				text
			)
		) {
			st.reviewSent = true;
			st.waitFor = "reservation_details";
			return;
		}
		if (
			/full name[\s\S]{0,120}(?:phone|mobile)[\s\S]{0,120}nationality/i.test(
				text
			) ||
			/الاسم\s+الكامل[\s\S]{0,120}رقم\s+الهاتف[\s\S]{0,120}الجنسية/i.test(
				text
			) ||
			/لإتمام\s+الحجز[\s\S]{0,160}(?:رقم\s+الهاتف|الجنسية)/i.test(text)
		) {
			st.reviewSent = true;
			st.waitFor = "reservation_details";
			return;
		}
	}
}

function isNewReservationFlowActive(st = {}) {
	if (st.waitFor === "post_booking_followup") return false;
	const detailStageActive =
		reservationDetailWaitState(st.waitFor) && reservationDetailContextReady(st);
	return Boolean(
		st.quote ||
			st.pendingRoomAlternative ||
			st.reviewSent ||
			st.slots?.checkinISO ||
			st.slots?.checkoutISO ||
			st.slots?.roomTypeKey ||
			[
				"dates",
				"room",
				"room_alternative_confirm",
				"proceed",
			].includes(st.waitFor) ||
			detailStageActive
	);
}

function explicitlyExistingReservationIntent(text = "") {
	const value = String(text || "");
	return (
		/\b(?:my reservation|my booking|change my|update my)\b/i.test(value) ||
		/\b(?:existing|old|already have|already got|have an?|got an?)\b.{0,40}\b(?:reservation|booking)\b/i.test(
			value
		) ||
		/\b(?:reservation|booking)\b.{0,40}\b(?:existing|old|already have|already got)\b/i.test(
			value
		) ||
		/\u0639\u0646\u062f\u064a \u062d\u062c\u0632|\u062d\u062c\u0632\u064a|\u062d\u062c\u0632 \u0642\u062f\u064a\u0645|\u062d\u062c\u0632 \u0633\u0627\u0628\u0642|\u062a\u0639\u062f\u064a\u0644 \u062d\u062c\u0632/i.test(
			value
		)
	);
}

function isReservationDetailStep(st = {}) {
	return reservationDetailWaitState(st.waitFor) && reservationDetailContextReady(st);
}

function humanHandoffReason(text = "") {
	const normalized = String(text || "").toLowerCase();
	if (looksLikeReservationCancellation(text)) {
		return "reservation_cancellation";
	}
	if (
		/\b(update|change|modify|amend|edit|correct)\b/i.test(normalized) &&
		/\b(reservation|booking|dates|date|name|phone|email|nationality|payment)\b/i.test(
			normalized
		)
	) {
		return "reservation_update";
	}
	return "";
}

function looksLikeReservationCancellation(text = "") {
	const { lower, arabic, latinCompact } = normalizeControlText(text);
	const hasCancel =
		/\b(cancel|cancellation|cancelation|refund|void)\b/i.test(lower) ||
		/(?:cancelar|cancelacion|cancelaci[oó]n|anular|annuler|annulation|remboursement|reembolso)/i.test(
			lower
		) ||
		/(?:\u0627\u0644\u063a\u0627\u0621|\u0625\u0644\u063a\u0627\u0621|\u0627\u0644\u063a\u064a|\u0623\u0644\u063a\u064a|\u0627\u0644\u0644\u063a\u064a|\u0643\u0646\u0633\u0644|\u0627\u0633\u062a\u0631\u062f\u0627\u062f)/i.test(
			arabic
		) ||
		/(?:cancel|cancellation|refund|void|cancelar|anular|annuler|reembolso|remboursement|elgha|ilgha|alghi|kansel|cancelreservation|cancelbooking)/i.test(
			latinCompact
		);
	if (!hasCancel) return false;
	const hasReservationContext =
		/\b(reservation|booking|room|stay|payment|deposit|confirmation|reference|it)\b/i.test(
			lower
		) ||
		/(?:reserva|r[eé]servation|habitacion|chambre|sejour|s[eé]jour)/i.test(
			lower
		) ||
		/(?:\u062d\u062c\u0632|\u0627\u0644\u062d\u062c\u0632|\u062a\u0627\u0643\u064a\u062f|\u062a\u0623\u0643\u064a\u062f|\u063a\u0631\u0641\u0647|\u0627\u0642\u0627\u0645\u0647|\u062f\u0641\u0639)/i.test(
			arabic
		) ||
		Boolean(confirmationFromText(text));
	return hasReservationContext;
}

function publicDiscountPercent() {
	return PUBLIC_DISCOUNT_PERCENT;
}

function wantsDiscountQuestion(text = "") {
	const normalized = String(text || "").toLowerCase();
	return /discount|discounts|promo|promotion|coupon|voucher|offer|offers|deal|deals|special rate|best price|lower price|cheaper|reduce price|make it less|خصم|خصومات|تخفيض|تخفيضات|عرض|عروض|كوبون|برومو|اقل سعر|أقل سعر|ارخص|أرخص|نزل السعر|ينفع خصم|descuento|oferta|promocion|promoción|remise|reduction|réduction|promo|offre/i.test(
		normalized
	);
}

function discountDisplayContext(st = {}) {
	const quote = st.quote?.data;
	const discountPercent = publicDiscountPercent();
	const factor = 1 - discountPercent / 100;
	const perNightValues = Array.isArray(quote?.perNight)
		? quote.perNight.map((value) => Number(value)).filter((value) => value > 0)
		: [];
	const displayedPerNight =
		perNightValues.length === 1
			? perNightValues[0]
			: perNightValues.length
			? Number(
					(
						perNightValues.reduce((sum, value) => sum + value, 0) /
						perNightValues.length
					).toFixed(2)
			  )
			: null;
	const beforeDiscount =
		displayedPerNight && factor > 0
			? Number((displayedPerNight / factor).toFixed(2))
			: null;
	return {
		discountPercent,
		displayedPerNight,
		beforeDiscount,
		currency: quote?.currency || st.hotel?.currency || "SAR",
		hasQuote: Boolean(quote?.available),
	};
}

function looksLikeGreetingOnly(text = "") {
	const raw = String(text || "").trim();
	if (!raw) return false;
	const stableGreeting = raw
		.replace(/^[\s"'`]+|[\s"'`!?.\u061f\u060c,\u061b]+$/g, "")
		.trim();
	const arabicGreetingWithBlessing =
		/^(?:(?:\u0648\s*)?\u0639\u0644\u064a\u0643\u0645\s+\u0627\u0644\u0633\u0644\u0627\u0645(?:\s+\u0648\u0631\u062d\u0645\u0629\s+\u0627\u0644\u0644\u0647(?:\s+\u0648\u0628\u0631\u0643\u0627\u062a\u0647)?)?|\u0627\u0644\u0633\u0644\u0627\u0645(?:\s+\u0639\u0644\u064a\u0643\u0645)?(?:\s+\u0648\u0631\u062d\u0645\u0629\s+\u0627\u0644\u0644\u0647(?:\s+\u0648\u0628\u0631\u0643\u0627\u062a\u0647)?)?|\u0633\u0644\u0627\u0645(?:\s+\u0639\u0644\u064a\u0643\u0645)?(?:\s+\u0648\u0631\u062d\u0645\u0629\s+\u0627\u0644\u0644\u0647(?:\s+\u0648\u0628\u0631\u0643\u0627\u062a\u0647)?)?)$/i;
	if (arabicGreetingWithBlessing.test(stableGreeting)) return true;
	if (
		/^(?:\u0627\u0644\u0633\u0644\u0627\u0645(?:\s+\u0639\u0644\u064a\u0643\u0645)?|\u0633\u0644\u0627\u0645(?:\s+\u0639\u0644\u064a\u0643\u0645)?|\u0648\u0639\u0644\u064a\u0643\u0645\s+\u0627\u0644\u0633\u0644\u0627\u0645|\u0645\u0631\u062d\u0628\u0627|\u0627\u0647\u0644\u0627|\u0623\u0647\u0644\u0627|\u0623\u0647\u0644\u064a\u0646|\u0647\u0644\u0627|\u0647\u0627\u0644\u0648|\u0627\u0644\u0648|\u0623\u0644\u0648|\u0647\u0627\u064a|\u0635\u0628\u0627\u062d\s+\u0627\u0644\u062e\u064a\u0631|\u0645\u0633\u0627\u0621\s+\u0627\u0644\u062e\u064a\u0631|\u06c1\u06cc\u0644\u0648|\u0627\u0644\u0633\u0644\u0627\u0645\s+\u0639\u0644\u06cc\u06a9\u0645|\u0928\u092e\u0938\u094d\u0924\u0947|\u0905\u0938\u094d\u0938\u0932\u093e\u092e\u0941\s+\u0905\u0932\u0948\u0915\u0941\u092e)$/i.test(
			stableGreeting
		)
	) {
		return true;
	}
	const cleaned = raw.replace(/^[\s"'`]+|[\s"'`!?.؟،,؛]+$/g, "").trim();
	if (!cleaned) return false;
	const { lower, arabic, latinCompact } = normalizeControlText(cleaned);
	const latinGreeting =
		/^(?:hi|hello|hey|hi there|hello there|good morning|good evening|salaam|salam|assalamu alaikum|assalamu alaykum|assalamualaikum|assalamo alaikum|as-salamu alaikum|al salamo alaikum|al salam alaikum|hola|bonjour|salut)$/i.test(
			lower
		) ||
		/^(?:hi|hello|hey|salam|salaam|assalamualaikum|assalamualaykum|assalamualaikumwarahmatullah|hola|bonjour|salut)$/i.test(
			latinCompact
		);
	const arabicGreeting =
		/^(?:السلام(?:\s+عليكم)?|سلام(?:\s+عليكم)?|وعليكم\s+السلام|مرحبا|اهلا|أهلا|أهلين|هلا|هالو|الو|ألو|هاي|صباح\s+الخير|مساء\s+الخير)$/i.test(
			arabic
		);
	const urduHindiGreeting =
		/^(?:ہیلو|السلام\s+علیکم|नमस्ते|अस्सलामु\s+अलैकुम)$/i.test(cleaned);
	return latinGreeting || arabicGreeting || urduHindiGreeting;
}

function looksLikeFirstTurnGreetingSmalltalk(text = "") {
	const raw = String(text || "").trim();
	if (!raw) return false;
	if (looksLikeGreetingOnly(raw)) return true;
	const { lower, arabic, latinCompact } = normalizeControlText(raw);
	return (
		/\b(?:hi|hello|hey|salaam|salam|assalamu\s+alaikum|assalamu\s+alaykum|assalamualaikum|good\s+morning|good\s+evening)\b/i.test(
			lower
		) ||
		/\bhow\s*(?:are|r)\s*(?:you|u)\b/i.test(lower) ||
		/(?:\u0643\u064a\u0641\s+\u062d\u0627\u0644\u0643|\u0627\u062e\u0628\u0627\u0631\u0643|\u0623\u062e\u0628\u0627\u0631\u0643|\u0643\u064a\u0641\u0643|\u0627\u0632\u064a\u0643|\u0625\u0632\u064a\u0643|\u0627\u0644\u0633\u0644\u0627\u0645|\u0645\u0631\u062d\u0628\u0627|\u0627\u0647\u0644\u0627|\u0623\u0647\u0644\u0627)/i.test(
			arabic
		) ||
		/(?:hi|hello|hey|salam|salaam|assalamualaikum|assalamualaykum|howareyou|howru)/i.test(
			latinCompact
		)
	);
}

function islamicGreetingForLanguage(sc = {}, st = {}) {
	const lang = languageOf(sc, st);
	if (/arabic/i.test(lang)) {
		return "\u0627\u0644\u0633\u0644\u0627\u0645 \u0639\u0644\u064a\u0643\u0645";
	}
	if (/urdu/i.test(lang)) {
		return "\u0627\u0644\u0633\u0644\u0627\u0645 \u0639\u0644\u06cc\u06a9\u0645";
	}
	if (/hindi/i.test(lang)) {
		return "\u0905\u0938\u094d\u0938\u0932\u093e\u092e\u0941 \u0905\u0932\u0948\u0915\u0941\u092e";
	}
	if (/indonesian|malay/i.test(lang)) return "Assalamualaikum";
	return "Assalamu alaikum";
}

function greetingText(sc = {}, st = {}) {
	const name = firstNameForAddress(
		st.slots?.name || st.slots?.fullName || sc.displayName1 || "Guest"
	);
	const lang = languageOf(sc, st);
	const opening = islamicGreetingForLanguage(sc, st);
	if (/arabic/i.test(lang)) {
		return `${opening} ${name}\u060c \u0643\u064a\u0641 \u0623\u0642\u062f\u0631 \u0623\u0633\u0627\u0639\u062f\u0643 \u0627\u0644\u064a\u0648\u0645\u061f`;
	}
	if (/spanish/i.test(lang)) {
		return `${opening} ${name}, como puedo ayudarte hoy?`;
	}
	if (/french/i.test(lang)) {
		return `${opening} ${name}, comment puis-je vous aider aujourd'hui ?`;
	}
	if (/urdu/i.test(lang)) {
		return `${opening} ${name}\u060c \u0645\u06cc\u06ba \u0622\u067e \u06a9\u06cc \u06a9\u06cc\u0633\u06d2 \u0645\u062f\u062f \u06a9\u0631 \u0633\u06a9\u062a\u0627 \u06c1\u0648\u06ba\u061f`;
	}
	if (/hindi/i.test(lang)) {
		return `${opening} ${name}, \u092e\u0948\u0902 \u0906\u092a\u0915\u0940 \u0915\u093f\u0938 \u0924\u0930\u0939 \u092e\u0926\u0926 \u0915\u0930\u0942\u0902?`;
	}
	if (/indonesian/i.test(lang)) {
		return `${opening} ${name}, bagaimana saya bisa membantu hari ini?`;
	}
	if (/malay/i.test(lang)) {
		return `${opening} ${name}, bagaimana saya boleh membantu hari ini?`;
	}
	return `${opening} ${name}, how can I help you today?`;
}

function wantsHotelRecommendation(text = "") {
	const normalized = String(text || "").toLowerCase();
	const asksNearHaram =
		/haram|al haram|el haram|الحرم|المسجد الحرام|kaaba|makkah/i.test(normalized);
	const asksRoom =
		/double|room|hotel|غرفة|غرف|فندق|فنادق|habitación|hotel|chambre|hôtel/i.test(
			normalized
		);
	return asksNearHaram && asksRoom;
}

function wantsPriceButMissingDates(text = "", st = {}) {
	const normalized = String(text || "").toLowerCase();
	const asksPrice =
		/price|prices|rate|rates|cost|how much|سعر|اسعار|أسعار|بكام|precio|prix|قیمت/i.test(
			normalized
		);
	const asksSpanishPrice =
		/precios|cuanto cuesta|cu[aá]nto cuesta|cuesta|costo|tarifa/i.test(
			normalized
		);
	return (
		(asksPrice || asksSpanishPrice) &&
		(!st.slots?.checkinISO || !st.slots?.checkoutISO)
	);
}

function selectedHotelRoomQuestionText(text = "") {
	const normalized = String(text || "").toLowerCase();
	if (!normalized.trim()) return false;
	const { lower, arabic, latinCompact } = normalizeControlText(text);
	if (selectedHotelRoomDetailsQuestionText(text)) return true;
	if (roomCapacityOrTypeInquiryText(text)) return true;
	const mentionsRoom =
		/\b(room|rooms|bed|beds|suite|suites|people|persons|individuals|guests)\b/i.test(
			normalized
		) ||
		/غرف|غرفة|غرفه|سرير|أسرة|اسرة|اشخاص|أشخاص|افراد|أفراد/.test(normalized) ||
		/(?:ghoraf|ghuraf|odah|oda|owda|awda)/i.test(latinCompact);
	if (!mentionsRoom) return false;
	const asksRoomOptions =
		/\b(?:what|which|list|show|tell|send|share)\b[^.!?\u061f\n]*(?:room|rooms|room\s+types|options)\b/i.test(
			lower
		) ||
		/\b(?:what|which)\s+(?:kind|type|types)\s+of\s+rooms?\b/i.test(lower) ||
		/\b(?:rooms?|room\s+types?|options)\b[^.!?\u061f\n]*(?:have|offer|available|there|provide)\b/i.test(
			lower
		) ||
		/(?:\u0627\u064a\u0647|\u0625\u064a\u0647|\u0627\u064a|\u0623\u064a|\u0645\u0627|\u0645\u0627\u0647\u064a|\u0634\u0648|\u0634\u0646\u0648)[^؟\n]*(?:\u063a\u0631\u0641|\u063a\u0631\u0641\u0629|\u063a\u0631\u0641\u0647|\u0627\u0644\u063a\u0631\u0641|\u0627\u0648\u0636|\u0623\u0648\u0636)/i.test(
			arabic
		) ||
		/(?:\u0627\u0646\u0648\u0627\u0639|\u0623\u0646\u0648\u0627\u0639|\u0646\u0648\u0639|\u0627\u0644\u0627\u0646\u0648\u0627\u0639)[^؟\n]*(?:\u063a\u0631\u0641|\u0627\u0644\u063a\u0631\u0641|\u0627\u0644\u063a\u0631\u0641\u0629)/i.test(
			arabic
		) ||
		/(?:\u0639\u0646\u062f\u0643\u0645|\u0639\u0646\u062f\u0643|\u0641\u064a\u0647|\u0645\u062a\u0627\u062d|\u0645\u062a\u0648\u0641\u0631)[^؟\n]*(?:\u063a\u0631\u0641|\u063a\u0631\u0641\u0629|\u063a\u0631\u0641\u0647|\u0627\u0644\u063a\u0631\u0641)/i.test(
			arabic
		) ||
		/(?:\u0628\u062a\u0642\u062f\u0645|\u0628\u062a\u0642\u062f\u0645\u0648|\u062a\u0642\u062f\u0645|\u062a\u0648\u0641\u0631)[^؟\n]*(?:\u063a\u0631\u0641|\u0627\u0644\u063a\u0631\u0641)/i.test(
			arabic
		) ||
		/(?:eh|eih|ayh|anwa3|anwaa|whatrooms|whichrooms|roomtypes?|typesofrooms?|typesrooms?|ghoraf|ghuraf|odah|oda|owda|awda)/i.test(latinCompact);
	if (asksRoomOptions) return true;
	const hasRoomTypeOrCapacity =
		Boolean(mapRoomToKey(normalized)) ||
		Boolean(requestedGuestCountFromText(text)) ||
		/\b(?:for\s*)?(?:2|two|3|three|4|four|5|five|6|six|7|seven|8|eight|9|nine|10|ten)\b/i.test(
			normalized
		);
	if (!hasRoomTypeOrCapacity) return false;
	return (
		/[?]/.test(normalized) ||
		/\b(do you|you guys|u guys|does the hotel|does your hotel|is there|are there|any|available|availability|have|has|looking for|need|want|book|reserve)\b/i.test(
			normalized
		) ||
		/عندكم|فيه|هل|متاح|ابغى|أبغى|عايز|عاوز|احتاج/.test(normalized)
	);
}

function generalRoomOptionsQuestionText(text = "") {
	const raw = String(text || "");
	if (!raw.trim()) return false;
	const { lower, arabic, latinCompact } = normalizeControlText(raw);
	return (
		/\b(?:what|which|list|show|tell|send|share)\b[^.!?\u061f\n]*(?:room|rooms|room\s+types|options)\b/i.test(
			lower
		) ||
		/\b(?:what|which)\s+(?:kind|type|types)\s+of\s+rooms?\b/i.test(lower) ||
		/\b(?:rooms?|room\s+types?|options)\b[^.!?\u061f\n]*(?:have|offer|available|there|provide)\b/i.test(
			lower
		) ||
		/(?:\u0627\u064a\u0647|\u0625\u064a\u0647|\u0627\u064a|\u0623\u064a|\u0645\u0627|\u0645\u0627\u0647\u064a|\u0634\u0648|\u0634\u0646\u0648)[^ØŸ\n]*(?:\u063a\u0631\u0641|\u063a\u0631\u0641\u0629|\u063a\u0631\u0641\u0647|\u0627\u0644\u063a\u0631\u0641|\u0627\u0648\u0636|\u0623\u0648\u0636)/i.test(
			arabic
		) ||
		/(?:\u0627\u0646\u0648\u0627\u0639|\u0623\u0646\u0648\u0627\u0639|\u0646\u0648\u0639|\u0627\u0644\u0627\u0646\u0648\u0627\u0639)[^ØŸ\n]*(?:\u063a\u0631\u0641|\u0627\u0644\u063a\u0631\u0641|\u0627\u0644\u063a\u0631\u0641\u0629)/i.test(
			arabic
		) ||
		/(?:\u0639\u0646\u062f\u0643\u0645|\u0639\u0646\u062f\u0643|\u0641\u064a\u0647|\u0645\u062a\u0627\u062d|\u0645\u062a\u0648\u0641\u0631)[^ØŸ\n]*(?:\u063a\u0631\u0641|\u063a\u0631\u0641\u0629|\u063a\u0631\u0641\u0647|\u0627\u0644\u063a\u0631\u0641)/i.test(
			arabic
		) ||
		/(?:\u0628\u062a\u0642\u062f\u0645|\u0628\u062a\u0642\u062f\u0645\u0648|\u062a\u0642\u062f\u0645|\u062a\u0648\u0641\u0631)[^ØŸ\n]*(?:\u063a\u0631\u0641|\u0627\u0644\u063a\u0631\u0641)/i.test(
			arabic
		) ||
		/(?:anwa3|anwaa|whatrooms|whichrooms|roomtypes?|typesofrooms?|typesrooms?)/i.test(
			latinCompact
		)
	);
}

function selectedHotelRoomDetailsQuestionText(text = "") {
	const raw = String(text || "");
	if (!raw.trim()) return false;
	const { lower, arabic, latinCompact } = normalizeControlText(raw);
	const mentionsRoom =
		/\b(?:room|rooms|suite|suites|bed|beds)\b/i.test(lower) ||
		/(?:\u063a\u0631\u0641\u0629|\u063a\u0631\u0641\u0647|\u063a\u0631\u0641|\u0623\u0648\u0636\u0629|\u0627\u0648\u0636\u0629|\u0633\u0631\u064a\u0631|\u0623\u0633\u0631\u0629|\u0627\u0633\u0631\u0629)/i.test(
			arabic
		) ||
		/(?:room|suite|bed|ghorfa|ghurfa|oda|odah)/i.test(latinCompact);
	const asksDetails =
		/\b(?:amenit(?:y|ies)|features?|facilities|views?|view|description|details?|include|included|inside|size|sqm|square\s*meter|balcony|window)\b/i.test(
			lower
		) ||
		/(?:\u0645\u0631\u0627\u0641\u0642|\u0645\u0645\u064a\u0632\u0627\u062a|\u0645\u064a\u0632\u0627\u062a|\u0625\u0637\u0644\u0627\u0644\u0629|\u0627\u0637\u0644\u0627\u0644\u0629|\u0627\u0644\u0625\u0637\u0644\u0627\u0644\u0629|\u0627\u0644\u0627\u0637\u0644\u0627\u0644\u0629|\u0648\u0635\u0641|\u062a\u0641\u0627\u0635\u064a\u0644|\u062a\u0634\u0645\u0644|\u062f\u0627\u062e\u0644|\u0645\u0633\u0627\u062d\u0629|\u0628\u0644\u0643\u0648\u0646\u0629|\u0634\u0628\u0627\u0643|\u0646\u0627\u0641\u0630\u0629)/i.test(
			arabic
		) ||
		/(?:amenities|features|facilities|view|views|description|details|included|inside|roomsize|balcony|window)/i.test(
			latinCompact
		);
	return mentionsRoom && asksDetails;
}

function selectedHotelDistanceQuestionText(text = "") {
	const { lower, arabic, latinCompact } = normalizeControlText(text);
	if (!lower.trim()) return false;
	const asksDistance =
		hasSemanticSignal(text, "distance") ||
		/\b(?:how\s+far|far\s+from|distance|distancia|lejos|cerca|near|close|walking|walk|a\s+pie|caminando|car|traffic|drive|driving|en\s+voiture|a\s+pied|minutes?|mins?|berapa\s+jauh|jarak|dekat|jalan\s+kaki|menit|minit)\b/i.test(
			lower
		) ||
		/(?:\u0643\u0645\s+\u064a\u0628\u0639\u062f|\u064a\u0628\u0639\u062f|\u0628\u0639\u064a\u062f|\u0642\u0631\u064a\u0628|\u0627\u0644\u0645\u0633\u0627\u0641\u0647|\u0645\u0633\u0627\u0641\u0647|\u062f\u0642\u064a\u0642\u0647|\u062f\u0642\u0627\u064a\u0642|\u0645\u0634\u064a|\u0645\u0634\u064a\u0627|\u0633\u064a\u0627\u0631\u0647|\u0628\u0627\u0644\u0633\u064a\u0627\u0631\u0647|\u06a9\u062a\u0646\u0627\s+\u062f\u0648\u0631|\u06a9\u06cc\u062a\u0646\u0627\s+\u062f\u0648\u0631|\u0641\u0627\u0635\u0644\u06c1|\u0645\u0646\u0679)/i.test(
			arabic
		) ||
		/(?:howfar|farfrom|distance|nearharam|closeharam|walking|driving|jarak|berapajauh|kitnadoor|kitnidur)/i.test(
			latinCompact
		);
	if (!asksDistance) return false;
	const mentionsHaramOrHotel =
		/\b(?:haram|al\s*haram|el\s*haram|masjid|kaaba|kabah|kaba|hotel|your\s+hotel|the\s+hotel|it|there)\b/i.test(
			lower
		) ||
		/(?:\u0627\u0644\u062d\u0631\u0645|\u0644\u0644\u062d\u0631\u0645|\u0627\u0644\u0645\u0633\u062c\u062f\s+\u0627\u0644\u062d\u0631\u0627\u0645|\u0644\u0644\u0645\u0633\u062c\u062f\s+\u0627\u0644\u062d\u0631\u0627\u0645|\u0627\u0644\u0643\u0639\u0628\u0647|\u0627\u0644\u0643\u0639\u0628\u0629|\u0627\u0644\u0641\u0646\u062f\u0642|\u0641\u0646\u062f\u0642)/i.test(
			arabic
		) ||
		/(?:haram|masjidilharam|kaaba|kabah|kaba|hotel|funduq)/i.test(
			latinCompact
		);
	const travelModeFollowup =
		/\b(?:walking|walk|on\s+foot)\b.{0,40}\b(?:car|drive|driving|time|minutes?|mins?)\b/i.test(
			lower
		) ||
		/\b(?:car|drive|driving)\b.{0,40}\b(?:walking|walk|on\s+foot|time|minutes?|mins?)\b/i.test(
			lower
		) ||
		/(?:\u0645\u0634\u064a|\u0645\u0634\u064a\u0627).{0,40}(?:\u0633\u064a\u0627\u0631\u0647|\u0628\u0627\u0644\u0633\u064a\u0627\u0631\u0647|\u0648\u0642\u062a|\u062f\u0642\u0627\u064a\u0642)|(?:\u0633\u064a\u0627\u0631\u0647|\u0628\u0627\u0644\u0633\u064a\u0627\u0631\u0647).{0,40}(?:\u0645\u0634\u064a|\u0645\u0634\u064a\u0627|\u0648\u0642\u062a|\u062f\u0642\u0627\u064a\u0642)/i.test(
			arabic
		) ||
		/(?:walking|walk|onfoot).{0,40}(?:car|drive|driving|time|minutes|mins)|(?:car|drive|driving).{0,40}(?:walking|walk|onfoot|time|minutes|mins)/i.test(
			latinCompact
		);
	return mentionsHaramOrHotel || travelModeFollowup;
}

function selectedHotelAddressQuestionText(text = "") {
	const { lower, arabic, latinCompact } = normalizeControlText(text);
	if (!lower.trim()) return false;
	if (
		/\b(?:google\s*maps?|maps?|coordinates?|coords?|gps|pin|directions?)\b/i.test(
			lower
		) ||
		/(?:\u0627\u062d\u062f\u0627\u062b\u064a\u0627\u062a|\u0625\u062d\u062f\u0627\u062b\u064a\u0627\u062a|\u062e\u0631\u064a\u0637\u0629|\u062e\u0631\u064a\u0637\u0647|\u062e\u0631\u0627\u0626\u0637|\u062e\u0631\u0627\u064a\u0637|\u062f\u0628\u0648\u0633|\u0628\u0646)/i.test(
			arabic
		) ||
		/(?:googlemaps|googlemap|maps|map|coordinates|coords|gps|pin|directions)/i.test(
			latinCompact
		)
	) {
		return true;
	}
	const asksLocation =
		hasSemanticSignal(text, "location") ||
		/\b(?:where\s+is|where's|located|location|address|area|district|map|ubicacion|ubicaci[oó]n|direccion|direcci[oó]n|adresse|emplacement|alamat|lokasi|peta)\b/i.test(
			lower
		) ||
		/(?:\u0627\u064a\u0646|\u0641\u064a\u0646|\u0648\u064a\u0646|\u0645\u0648\u0642\u0639|\u0645\u0643\u0627\u0646|\u0639\u0646\u0648\u0627\u0646|\u0645\u0646\u0637\u0642\u0647|\u062d\u064a|\u062e\u0631\u064a\u0637\u0629|\u062e\u0631\u064a\u0637\u0647|\u062e\u0631\u0627\u0626\u0637|\u062e\u0631\u0627\u064a\u0637|\u062c\u0648\u062c\u0644\s*ماب|\u062c\u0648\u062c\u0644\s*مابس|\u06a9\u06c1\u0627\u06ba|\u06a9\u062f\u06be\u0631|\u067e\u062a\u06c1|\u092a\u0924\u093e|\u0915\u0939\u093e\u0902)/i.test(
			arabic
		) ||
		/(?:whereis|location|address|map|googlemaps|googlemap|ubicacion|direccion|adresse|alamat|lokasi|kahan|kidhar|pata)/i.test(
			latinCompact
		);
	if (!asksLocation) return false;
	const mentionsHotel =
		/\b(?:hotel|your\s+hotel|the\s+hotel|it|there)\b/i.test(lower) ||
		/(?:\u0627\u0644\u0641\u0646\u062f\u0642|\u0641\u0646\u062f\u0642|\u0647\u0648|\u0647\u0646\u0627\u0643)/i.test(
			arabic
		) ||
		/(?:hotel|funduq)/i.test(latinCompact);
	const conciseLocationRequest =
		(hasSemanticSignal(text, "location") ||
			/(?:\u062e\u0631\u064a\u0637\u0629|\u062e\u0631\u064a\u0637\u0647|\u062e\u0631\u0627\u0626\u0637|\u062e\u0631\u0627\u064a\u0637|\u062c\u0648\u062c\u0644\s*ماب|\u062c\u0648\u062c\u0644\s*مابس)/i.test(arabic) ||
			/(?:map|googlemaps|googlemap)/i.test(latinCompact)) &&
		lower.replace(/[^\w\s\u0600-\u06ff\u0900-\u097f]/g, " ").trim().split(/\s+/).filter(Boolean)
			.length <= 6 &&
		!hasSemanticSignal(text, ["payment", "confirmation", "reservation", "contact"]);
	const selectedPlaceLocationRequest =
		/\b(?:where\s+(?:exactly\s+)?is|where's|located|location|address|map|directions?)\b/i.test(
			lower
		) &&
		!/\b(?:restaurant|restaurants|food|meal|market|mall|shop|shops|pharmacy|station)\b/i.test(
			lower
		);
	return mentionsHotel || conciseLocationRequest || selectedPlaceLocationRequest;
}

function selectedHotelBusQuestionText(text = "") {
	const { lower, arabic, latinCompact } = normalizeControlText(text);
	if (!lower.trim()) return false;
	const directBus =
		hasSemanticSignal(text, "bus") ||
		/\b(?:bus|buses|shuttle|coach|haram\s+bus|bus\s+to\s+haram)\b/i.test(
			lower
		) ||
		/(?:\u0628\u0627\u0635|\u0628\u0627\u0635\u0627\u062a|\u062d\u0627\u0641\u0644\u0647|\u062d\u0627\u0641\u0644\u0627\u062a|\u0627\u062a\u0648\u0628\u064a\u0633|\u0623\u062a\u0648\u0628\u064a\u0633|\u0634\u0627\u062a\u0644|\u0628\u0633|\u0628\u0633\u06cc\u06ba|\u092c\u0938|\u0628\u0627\u0633)/i.test(
			arabic
		) ||
		/(?:buses|shuttle|coach|buskeharam|bustoharam|harambus)/i.test(
			latinCompact
		);
	const haramOrStation =
		/\b(?:haram|al\s*haram|el\s*haram|station|agyad|ajyad|shohada|shuhada)\b/i.test(
			lower
		) ||
		/(?:\u0627\u0644\u062d\u0631\u0645|\u0645\u062d\u0637\u0647|\u0627\u0644\u0634\u0647\u062f\u0627\u0621|\u0634\u0647\u062f\u0627\u0621|\u0627\u062c\u064a\u0627\u062f|\u0623\u062c\u064a\u0627\u062f)/i.test(
			arabic
		) ||
		/(?:haram|station|agyad|ajyad|shohada|shuhada)/i.test(latinCompact);
	const transportToHaram =
		/\b(?:transport|transportation|transfer)\b/i.test(lower) ||
		/(?:\u0646\u0642\u0644|\u0645\u0648\u0627\u0635\u0644\u0627\u062a)/i.test(arabic) ||
		/(?:transport|transfer|mowaslat|naql)/i.test(latinCompact);
	return directBus || (transportToHaram && haramOrStation);
}

function selectedHotelNusukQuestionText(text = "") {
	const { lower, arabic, latinCompact } = normalizeControlText(text);
	if (!lower.trim()) return false;
	const mentionsNusuk =
		/\b(?:nusuk|nusk)\b/i.test(lower) ||
		/(?:\u0646\u0633\u0643)/i.test(arabic) ||
		/(?:nusuk|nusk)/i.test(latinCompact);
	if (!mentionsNusuk) return false;
	const asksListing =
		/\b(?:listed|registered|included|available|official|platform|app|on\s+nusuk|in\s+nusuk)\b/i.test(
			lower
		) ||
		/(?:\u0647\u0644|\u0645\u062f\u0631\u062c|\u0645\u062f\u0631\u062c\u0629|\u0645\u0633\u062c\u0644|\u0645\u0633\u062c\u0644\u0629|\u0645\u0648\u062c\u0648\u062f|\u0645\u062a\u0627\u062d|\u0645\u0646\u0635\u0629|\u062a\u0637\u0628\u064a\u0642|\u0631\u0633\u0645\u064a)/i.test(
			arabic
		) ||
		/(?:listed|registered|included|available|official|platform|app|madraj|musajal)/i.test(
			latinCompact
		);
	return asksListing || /[?\u061f]/.test(String(text || ""));
}

function selectedHotelPolicyQuestionText(text = "") {
	const { lower, arabic, latinCompact } = normalizeControlText(text);
	if (!lower.trim()) return false;
	if (cancellationRefundPolicyQuestionText(text)) return true;
	const hasPolicySignalBeforeDateCheck =
		/\b(?:policy|policies|terms|conditions|rules|house rules|check[\s-]?in\b|check[\s-]?out\b|checkout\b|early check\b|late check\b|children|child|extra bed|breakfast|meal|deposit|no[\s-]?show|passport|id card|identification|smoking|pet|damage)\b/i.test(
			lower
		) ||
		/(?:\u0633\u064a\u0627\u0633\u0629|\u0633\u064a\u0627\u0633\u0627\u062a|\u0634\u0631\u0648\u0637|\u0623\u062d\u0643\u0627\u0645|\u0627\u062d\u0643\u0627\u0645|\u0642\u0648\u0627\u0639\u062f|\u062a\u0639\u0644\u064a\u0645\u0627\u062a|\u0648\u0635\u0648\u0644|\u0645\u063a\u0627\u062f\u0631\u0629|\u062f\u062e\u0648\u0644|\u062e\u0631\u0648\u062c|\u0625\u0641\u0637\u0627\u0631|\u0627\u0641\u0637\u0627\u0631|\u0648\u062c\u0628\u0627\u062a|\u0623\u0637\u0641\u0627\u0644|\u0627\u0637\u0641\u0627\u0644|\u0639\u0631\u0628\u0648\u0646|\u062a\u0623\u0645\u064a\u0646|\u062a\u0627\u0645\u064a\u0646|\u062c\u0648\u0627\u0632|\u0647\u0648\u064a\u0629|\u0647\u0648\u064a\u0647|\u062a\u062f\u062e\u064a\u0646|\u062d\u064a\u0648\u0627\u0646\u0627\u062a|\u0623\u0636\u0631\u0627\u0631|\u0627\u0636\u0631\u0627\u0631|\u0644\u0627\s*\u064a\u062d\u0636\u0631)/i.test(
			arabic
		) ||
		/(?:policy|policies|terms|conditions|houserules|checkin(?!g)|checkout|earlycheckin|latecheckout|children|extrabed|breakfast|meal|deposit|noshow|passport|idcard|smoking|pets|damage)/i.test(
			latinCompact
		);
	if (!hasPolicySignalBeforeDateCheck) return false;
	const stayDates = extractDateRange(text);
	if (stayDates?.checkinISO && stayDates?.checkoutISO) return false;
	return (
		/\b(?:policy|policies|terms|conditions|rules|house rules|check[\s-]?in\b|check[\s-]?out\b|checkout\b|early check\b|late check\b|children|child|extra bed|breakfast|meal|deposit|no[\s-]?show|passport|id card|identification|smoking|pet|damage)\b/i.test(
			lower
		) ||
		/(?:\u0633\u064a\u0627\u0633\u0629|\u0633\u064a\u0627\u0633\u0627\u062a|\u0634\u0631\u0648\u0637|\u0623\u062d\u0643\u0627\u0645|\u0627\u062d\u0643\u0627\u0645|\u0642\u0648\u0627\u0639\u062f|\u062a\u0639\u0644\u064a\u0645\u0627\u062a|\u0648\u0635\u0648\u0644|\u0645\u063a\u0627\u062f\u0631\u0629|\u062f\u062e\u0648\u0644|\u062e\u0631\u0648\u062c|\u062a\u0634\u064a\u0643\s*ا?ن|\u0625\u0641\u0637\u0627\u0631|\u0627\u0641\u0637\u0627\u0631|\u0648\u062c\u0628\u0627\u062a|\u0623\u0637\u0641\u0627\u0644|\u0627\u0637\u0641\u0627\u0644|\u0633\u0631\u064a\u0631\s+\u0625\u0636\u0627\u0641\u064a|\u0633\u0631\u064a\u0631\s+\u0627\u0636\u0627\u0641\u064a|\u0639\u0631\u0628\u0648\u0646|\u062a\u0623\u0645\u064a\u0646|\u062a\u0627\u0645\u064a\u0646|\u062c\u0648\u0627\u0632|\u0647\u0648\u064a\u0629|\u0647\u0648\u064a\u0647|\u062a\u062f\u062e\u064a\u0646|\u062d\u064a\u0648\u0627\u0646\u0627\u062a|\u0623\u0636\u0631\u0627\u0631|\u0627\u0636\u0631\u0627\u0631|\u0644\u0627\s*\u064a\u062d\u0636\u0631)/i.test(
			arabic
		) ||
		/(?:policy|policies|terms|conditions|houserules|checkin(?!g)|checkout|earlycheckin|latecheckout|children|extrabed|breakfast|meal|deposit|noshow|passport|idcard|smoking|pets|damage)/i.test(
			latinCompact
		)
	);
}

function selectedHotelFactQuestionText(text = "") {
	return (
		selectedHotelMealsQuestionText(text) ||
		selectedHotelPolicyQuestionText(text) ||
		selectedHotelNusukQuestionText(text) ||
		selectedHotelBusQuestionText(text) ||
		selectedHotelDistanceQuestionText(text) ||
		selectedHotelCoordinatesQuestionText(text) ||
		selectedHotelAddressQuestionText(text) ||
		selectedHotelLocalAreaQuestionText(text)
	);
}

function selectedHotelMealsQuestionText(text = "") {
	const { lower, arabic, latinCompact } = normalizeControlText(text);
	if (!lower.trim() && !arabic.trim() && !latinCompact) return false;
	const nearbyFood =
		/\b(?:nearby|around|close\s+by|outside|local)\b.{0,50}\b(?:restaurant|restaurants|food|eat|meal|meals)\b/i.test(
			lower
		) ||
		/\b(?:restaurant|restaurants|food|eat|meal|meals)\b.{0,50}\b(?:nearby|around|close\s+by|outside|local)\b/i.test(
			lower
		) ||
		/(?:nearby|around|outside|local)(?:restaurant|restaurants|food|eat|meal|meals)/i.test(
			latinCompact
		);
	if (nearbyFood) return false;
	return (
		/\b(?:breakfast|meal|meals|food|dining|restaurant|buffet|half\s+board|full\s+board|board)\b/i.test(
			lower
		) ||
		/(?:\u0625\u0641\u0637\u0627\u0631|\u0627\u0641\u0637\u0627\u0631|\u0641\u0637\u0648\u0631|\u0648\u062c\u0628\u0629|\u0648\u062c\u0628\u0627\u062a|\u0623\u0643\u0644|\u0627\u0643\u0644|\u0637\u0639\u0627\u0645|\u0645\u0637\u0639\u0645|\u0628\u0648\u0641\u064a\u0647)/i.test(
			arabic
		) ||
		/(?:breakfast|meal|meals|food|dining|restaurant|buffet|halfboard|fullboard|desayuno|comida|comidas|restaurante|petitdejeuner|repas|dejeuner|diner|restaurant)/i.test(
			latinCompact
		)
	);
}

function selectedHotelCoordinatesQuestionText(text = "") {
	const { lower, arabic, latinCompact } = normalizeControlText(text);
	if (!lower.trim()) return false;
	return (
		/\b(?:coordinates?|coords?|gps|pin|exact\s+(?:map|location)|google\s*maps?\s+link)\b/i.test(
			lower
		) ||
		/(?:\u0627\u062d\u062f\u0627\u062b\u064a\u0627\u062a|\u0625\u062d\u062f\u0627\u062b\u064a\u0627\u062a|\u062f\u0628\u0648\u0633|\u0645\u0648\u0642\u0639\s+\u062f\u0642\u064a\u0642)/i.test(
			arabic
		) ||
		/(?:coordinates|coords|gps|pin|exactmap|exactlocation|googlemapslink)/i.test(
			latinCompact
		)
	);
}

function selectedHotelLocalAreaQuestionText(text = "") {
	const { lower, arabic, latinCompact } = normalizeControlText(text);
	if (!lower.trim() && !arabic.trim() && !latinCompact) return false;
	if (
		/\b(?:other|another|different|alternative|compare)\s+(?:hotel|hotels|property|properties)\b/i.test(
			lower
		)
	) {
		return false;
	}
	const parentOrSeniorArabic =
		/(?:\u0648\u0627\u0644\u062f\u064a\u0646|\u0648\u0627\u0644\u062f\u064a|\u0648\u0627\u0644\u062f\u062a\u064a|\u0627\u0644\u0648\u0627\u0644\u062f|\u0627\u0644\u0648\u0627\u0644\u062f\u0629|\u0643\u0628\u0627\u0631\s+\u0627\u0644\u0633\u0646|\u0643\u0628\u064a\u0631\s+\u0627\u0644\u0633\u0646|\u0643\u0628\u064a\u0631\u0629\s+\u0627\u0644\u0633\u0646|\u0645\u0633\u0646|\u0645\u0633\u0646\u064a\u0646)/i.test(
			arabic
		);
	return (
		/\b(?:nearby|around|surrounding|area|district|landmark|restaurants?|shops?|markets?|pharmac(?:y|ies)|essential\s+services|first\s*time|umrah\s+guest|good\s+choice\s+for\s+famil(?:y|ies)|famil(?:y|ies)|parents?|elderly|seniors?|senior\s+guests?|recommend(?:ation|ed|ing)?|suggest(?:ion|ed|ing)?|suitable|parking|park\s+my\s+car|late\s+at\s+night|late\s+arrival|24\s*-?\s*hour|reception\s+help)\b/i.test(
			lower
		) ||
		parentOrSeniorArabic ||
		/(?:قريب|قريبة|قرب|حول|حوالي|بجانب|منطقة|حي|معلم|مطاعم|محلات|أسواق|اسواق|صيدليات|خدمات|اول\s+مرة|أول\s+مرة|معتمر|عمرة|تنصح|ترشح|توصي|عائلات|عائلة|اسرة|أسرة|مناسب|مواقف|موقف|باركينج|ركن|سيارتي|سيارة|وصول\s+متأخر|متأخر|بالليل|ليلا|ليلًا|24\s*ساعة|استقبال)/i.test(
			arabic
		) ||
		/(?:nearby|around|landmark|restaurants|shops|markets|pharmacy|firsttime|umrahguest|family|families|parents|elderly|senior|seniors|recommend|recommendation|suggest|suggestion|suitable|parking|latearrival|lateatnight|24hour|receptionhelp)/i.test(
			latinCompact
		)
	);
}

function hasOperationalBookingSignal(text = "") {
	const normalized = String(text || "").toLowerCase();
	if (!normalized.trim()) return false;
	return (
		hasSemanticSignal(text, ["reservation", "confirmation", "payment"]) ||
		selectedHotelFactQuestionText(normalized) ||
		selectedHotelRoomQuestionText(normalized) ||
		Boolean(mapRoomToKey(normalized)) ||
		Boolean(extractDateRange(normalized)?.checkinISO) ||
		/\b(book|reserve|reservation|availability|available|room|rooms|bed|beds|price|rate|cost|stay|check[\s-]?in\b|check[\s-]?out\b|dates?)\b/i.test(
			normalized
		) ||
		/حجز|غرفة|غرف|متاح|سعر|دخول|خروج|موعد|تاريخ/.test(normalized)
	);
}

function hasConcreteFirstTurnBookingSignal(text = "") {
	const normalized = String(text || "").toLowerCase();
	if (!normalized.trim()) return false;
	return (
		hasSemanticSignal(text, ["reservation", "confirmation", "payment"]) ||
		selectedHotelFactQuestionText(normalized) ||
		Boolean(mapRoomToKey(normalized)) ||
		Boolean(extractDateRange(normalized)?.checkinISO) ||
		/\b(?:book|reserve|reservation|availability|available|room|rooms|bed|beds|price|rate|cost|stay|check[\s-]?in\b|check[\s-]?out\b|dates?)\b/i.test(
			normalized
		)
	);
}

function wantsPaymentHelp(text = "") {
	const raw = String(text || "");
	const { lower, latinCompact } = normalizeControlText(raw);
	const locationOrMapLink =
		selectedHotelCoordinatesQuestionText(raw) ||
		selectedHotelAddressQuestionText(raw) ||
		/\b(?:google\s*maps?|maps?|map|coordinates?|coords?|gps|pin|directions?|location|address)\b/i.test(
			lower
		) ||
		/(?:googlemaps|googlemap|maps|map|coordinates|coords|gps|pin|directions|location|address)/i.test(
			latinCompact
		);
	const actualPaymentWordsLower =
		/\b(?:payment|pay|paid|card|credit\s*card|debit\s*card|mada|checkout|invoice|receipt|deposit|charge|charged|refund|bank\s*transfer|pago|pagar|paiement|payer|pembayaran|bayar|bayaran|kad|invois)\b/i.test(
			lower
		);
	const actualPaymentWordsCompact =
		/(?:payment|pay|paid|card|creditcard|debitcard|mada|checkout|invoice|receipt|deposit|charge|charged|refund|banktransfer|pago|pagar|paiement|payer|pembayaran|bayar|bayaran|kad|invois|adaigi)/i.test(
			latinCompact
		);
	const actualPaymentWords = actualPaymentWordsLower || actualPaymentWordsCompact;
	const roomOrStayRequest =
		Boolean(mapRoomToKey(raw)) ||
		(/\b(?:room|rooms|availability|available|price|rate|stay|dates?)\b/i.test(
			lower
		) &&
			/\b(?:check|book|reserve|quote|price|rate|available|availability|stay)\b/i.test(
				lower
			)) ||
		(likelyStayDateText(raw) &&
			/\b(?:room|rooms|stay|check|book|reserve|availability|available)\b/i.test(
				lower
			));
	if (roomOrStayRequest && !actualPaymentWordsLower) return false;
	if (locationOrMapLink && !actualPaymentWords) return false;
	if (hasSemanticSignal(raw, "payment")) return true;
	if (/\b(pembayaran|bayar|pautan|invois|invoice)\b/i.test(raw)) return true;
	return /payment|pay|card|link|declined|not going through|failed|دفع|بطاقة|رابط|pago|paiement|ادائیگی/i.test(
		String(text || "")
	);
}

function wantsReservationHelp(text = "") {
	const raw = String(text || "");
	if (hasSemanticSignal(raw, ["reservation", "confirmation"])) return true;
	if (/\b(reservasi|tempahan|pengesahan)\b/i.test(raw)) return true;
	return /reservation|booking|confirmation|تأكيد|حجز|reserva|réservation|بکنگ|आरक्षण/i.test(
		String(text || "")
	);
}

function hotelContactDetailsQuestionText(text = "") {
	const raw = String(text || "").trim();
	if (!raw) return false;
	const { lower, arabic, latinCompact } = normalizeControlText(raw);
	const asksContact =
		hasSemanticSignal(raw, ["phone", "whatsapp", "contact"]) ||
		/\b(?:phone|telephone|mobile|number|no\.?|whatsapp|whats\s*app|contact|call|reach)\b/i.test(
			lower
		) ||
		/(?:\u0631\u0642\u0645|\u062c\u0648\u0627\u0644|\u0647\u0627\u062a\u0641|\u062a\u0644\u064a\u0641\u0648\u0646|\u062a\u0644\u064a\u0641\u0648\u0646|\u0648\u0627\u062a\u0633|\u0648\u0627\u062a\u0633\u0627\u0628|\u0627\u062a\u0635\u0644|\u0627\u062a\u0648\u0627\u0635\u0644)/i.test(
			arabic
		);
	if (!asksContact) return false;
	const asksHotelOrStaff =
		hasSemanticSignal(raw, ["hotel", "reception"]) ||
		/\b(?:hotel|reception|front\s*desk|desk|manager|responsible|staff|support|official)\b/i.test(
			lower
		) ||
		/\b(?:your|you)\s+(?:phone|telephone|mobile|number|no\.?|whatsapp|whats\s*app|contact)\b/i.test(
			lower
		) ||
		/(?:\u0627\u0644\u0641\u0646\u062f\u0642|\u0641\u0646\u062f\u0642|\u0627\u0644\u0627\u0633\u062a\u0642\u0628\u0627\u0644|\u0627\u0633\u062a\u0642\u0628\u0627\u0644|\u0627\u0644\u0645\u0633\u0624\u0648\u0644|\u0627\u0644\u0645\u0633\u0626\u0648\u0644|\u0645\u0633\u0624\u0648\u0644|\u0645\u0633\u0626\u0648\u0644|\u0627\u0644\u0645\u062f\u064a\u0631|\u0627\u0644\u062f\u0639\u0645)/i.test(
			arabic
		) ||
		/(?:hotelphone|hotelwhatsapp|callhotel|contacthotel|managernumber|receptionnumber|responsiblenumber)/i.test(
			latinCompact
		);
	const directHotelContact =
		(hasSemanticSignal(raw, ["contact", "phone", "whatsapp"]) &&
			hasSemanticSignal(raw, "hotel")) ||
		/\b(?:call|contact|reach|speak\s+to|talk\s+to)\s+(?:the\s+)?hotel\b/i.test(
			lower
		) ||
		/(?:\u0627\u0643\u0644\u0645|\u0627\u0643\u0644\u0645|\u0627\u062a\u0648\u0627\u0635\u0644|\u0627\u062a\u0635\u0644).*?(?:\u0627\u0644\u0641\u0646\u062f\u0642|\u0641\u0646\u062f\u0642)/i.test(
			arabic
		);
	return asksHotelOrStaff || directHotelContact;
}

function genericContactNumberRequestText(text = "") {
	const raw = String(text || "").trim();
	if (!raw) return false;
	const { lower, arabic, latinCompact } = normalizeControlText(raw);
	if (/\b(?:my|mine)\s+(?:phone|telephone|mobile|number|whatsapp|contact)\b/i.test(lower)) {
		return false;
	}
	const asksContact =
		hasSemanticSignal(raw, ["phone", "whatsapp", "contact"]) ||
		/\b(?:phone|telephone|mobile|number|no\.?|whatsapp|whats\s*app|contact|call)\b/i.test(
			lower
		) ||
		/(?:\u0631\u0642\u0645|\u062c\u0648\u0627\u0644|\u0647\u0627\u062a\u0641|\u062a\u0644\u064a\u0641\u0648\u0646|\u0648\u0627\u062a\u0633|\u0648\u0627\u062a\u0633\u0627\u0628|\u0627\u062a\u0635\u0644)/i.test(
			arabic
		);
	if (!asksContact) return false;
	return (
		/\b(?:give|send|share|need|want|have|provide|please|pls|plz|again|still|just|only)\b/i.test(
			lower
		) ||
		/\b(?:phone|number|whatsapp|contact)\s+(?:please|pls|plz)\b/i.test(lower) ||
		/(?:\u0644\u0648\s*\u0633\u0645\u062d\u062a|\u0627\u0631\u0633\u0644|\u0627\u0628\u0639\u062a|\u0627\u062f\u064a\u0646\u064a|\u0623\u0639\u0637\u064a\u0646\u064a|\u0645\u062d\u062a\u0627\u062c|\u0627\u062d\u062a\u0627\u062c|\u0627\u0628\u063a\u0649|\u0623\u0628\u063a\u0649|\u0628\u0631\u0636\u0647|\u0645\u0631\u0629\s*\u062b\u0627\u0646\u064a\u0629)/i.test(
			arabic
		) ||
		/(?:giveme|sendme|share|numberplease|phoneplease|whatsappplease)/i.test(
			latinCompact
		)
	);
}

function hotelContactRequestLikeText(text = "") {
	return hotelContactDetailsQuestionText(text) || genericContactNumberRequestText(text);
}

function directHotelRelationshipQuestionText(text = "") {
	const raw = String(text || "").trim();
	if (!raw) return false;
	const { lower, arabic, latinCompact } = normalizeControlText(raw);
	const semanticDirect =
		hasSemanticSignal(raw, ["direct", "workWith"]) &&
		hasSemanticSignal(raw, ["hotel", "reception", "reservation"]);
	const english =
		semanticDirect ||
		/\b(?:are|do|does|is)\b.{0,80}\b(?:you|jannat|this\s+chat|your\s+team)\b.{0,80}\b(?:direct|directly|official|authorized|authorised|working\s+with|work\s+with|deal\s+with|connected\s+to)\b.{0,80}\b(?:hotel|reception|reservation|reservations|team)\b/i.test(
			lower
		) ||
		/\b(?:directly\s+with|working\s+directly\s+with|officially\s+with|authorized\s+by|authorised\s+by)\s+(?:the\s+)?hotel\b/i.test(
			lower
		) ||
		/(?:directhotel|workdirectlywithhotel|workingdirectlywithhotel|officialhotel|authorizedhotel|authorisedhotel)/i.test(
			latinCompact
		);
	const spanish =
		/(?:trabaja|trabajan|trabajas|trabajando|directamente|oficial|autorizado|autorizada).{0,80}(?:hotel|recepcion|reservas|equipo)/i.test(
			lower
		) ||
		/(?:hotel|recepcion|reservas|equipo).{0,80}(?:directamente|oficial|autorizado|autorizada)/i.test(
			lower
		);
	const arabicMatch =
		/(?:\u0645\u0628\u0627\u0634\u0631|\u0645\u0628\u0627\u0634\u0631\u0629|\u0631\u0633\u0645\u064a|\u0631\u0633\u0645\u064a\u0627|\u062a\u062a\u0639\u0627\u0645\u0644|\u062a\u0639\u0645\u0644|\u062a\u0634\u062a\u063a\u0644|\u0645\u062a\u0648\u0627\u0635\u0644).{0,80}(?:\u0627\u0644\u0641\u0646\u062f\u0642|\u0641\u0646\u062f\u0642|\u0627\u0644\u0627\u0633\u062a\u0642\u0628\u0627\u0644|\u0627\u0633\u062a\u0642\u0628\u0627\u0644|\u0627\u0644\u062d\u062c\u0648\u0632\u0627\u062a|\u062d\u062c\u0648\u0632\u0627\u062a)/i.test(
			arabic
		) ||
		/(?:\u0627\u0644\u0641\u0646\u062f\u0642|\u0641\u0646\u062f\u0642|\u0627\u0644\u0627\u0633\u062a\u0642\u0628\u0627\u0644|\u0627\u0633\u062a\u0642\u0628\u0627\u0644|\u0627\u0644\u062d\u062c\u0648\u0632\u0627\u062a|\u062d\u062c\u0648\u0632\u0627\u062a).{0,80}(?:\u0645\u0628\u0627\u0634\u0631|\u0645\u0628\u0627\u0634\u0631\u0629|\u0631\u0633\u0645\u064a|\u0631\u0633\u0645\u064a\u0627|\u062a\u062a\u0639\u0627\u0645\u0644|\u062a\u0639\u0645\u0644|\u062a\u0634\u062a\u063a\u0644|\u0645\u062a\u0648\u0627\u0635\u0644)/i.test(
			arabic
		);
	return english || spanish || arabicMatch;
}

function confidentialCompanyDocumentQuestionText(text = "") {
	const raw = String(text || "").trim();
	if (!raw) return false;
	const { lower, arabic, latinCompact } = normalizeControlText(raw);
	if (!hasSemanticSignal(raw, "confidentialDocument")) return false;

	const organizationContext =
		/\b(?:ein|e\.?\s*i\.?\s*n\.?|tax|vat|company|business|commercial|legal|official|registration|registered|license|licence|certificate|incorporation)\b/i.test(
			lower
		) ||
		/(?:taxid|taxnumber|vatid|vatnumber|companydocument|companydocuments|companypaper|companypapers|companypaperwork|companyregistration|businessregistration|commercialregistration|tradelicense|legaldocument|officialdocument|certificateofincorporation|numerofiscal|nif|rfc|nomorpajak|nomborcukai)/i.test(
			latinCompact
		) ||
		/(?:\u0634\u0631\u0643\u0647|\u0627\u0644\u0634\u0631\u0643\u0647|\u0633\u062c\u0644\s+\u062a\u062c\u0627\u0631\u064a|\u0631\u0642\u0645\s+\u0636\u0631\u064a\u0628\u064a|\u0627\u0644\u0631\u0642\u0645\s+\u0627\u0644\u0636\u0631\u064a\u0628\u064a|\u0636\u0631\u064a\u0628|\u0631\u062e\u0635\u0647|\u062a\u0631\u062e\u064a\u0635|\u062a\u0635\u0631\u064a\u062d|\u0631\u0633\u0645\u064a|\u0642\u0627\u0646\u0648\u0646\u064a)/i.test(
			arabic
		);
	const genericPaperwork =
		/\b(?:documents?|documentations?|papers?|paperwork)\b/i.test(lower) ||
		/(?:\u0648\u062b\u0627\u0626\u0642|\u0645\u0633\u062a\u0646\u062f\u0627\u062a|\u0627\u0648\u0631\u0627\u0642|\u062f\u0648\u0643\u064a\u0648\u0645\u0646\u062a|\u062f\u0648\u0643\u064a\u0645\u0646\u062a)/i.test(
			arabic
		);
	const bookingDocumentContext =
		hasSemanticSignal(raw, ["reservation", "confirmation"]) ||
		/\b(?:voucher|receipt|invoice|booking\s+details|reservation\s+details|confirmation\s+email|confirmation\s+link)\b/i.test(
			lower
		);
	if (bookingDocumentContext && !organizationContext) return false;

	const protectedPaperwork = organizationContext || genericPaperwork;
	if (!protectedPaperwork) return false;

	const requestish =
		hasSemanticSignal(raw, "send") ||
		/\b(?:can|could|would|may|please|give|send|show|share|provide|need|want|require|have|what\s+is|do\s+you\s+have|where\s+can|let\s+me\s+see)\b/i.test(
			lower
		) ||
		/(?:canyou|couldyou|give|send|show|share|provide|need|want|require|doyouhave|whatisthe|letmesee|enviar|mostrar|compartir|proporcionar|necesito|quiero|envoyer|montrer|partager|fournir|besoin|veux|kirim|hantar|tunjukkan|butuh|perlu)/i.test(
			latinCompact
		) ||
		/(?:\u0645\u0645\u0643\u0646|\u0627\u0639\u0637\u064a|\u0627\u0639\u0637\u064a\u0646\u064a|\u0627\u062f\u064a\u0646\u064a|\u0627\u0631\u0633\u0644|\u0627\u0628\u0639\u062a|\u0627\u0628\u0639\u062b|\u0648\u0631\u064a|\u0639\u0627\u064a\u0632|\u0627\u0628\u063a\u0649|\u0627\u0631\u064a\u062f|\u0647\u0644|\u0641\u064a|\u0639\u0646\u062f\u0643|\u0645\u0627\s+\u0647\u0648|\u0627\u064a\u0647\s+\u0647\u0648)/i.test(
			arabic
		);
	return requestish || /[?\u061f]/.test(raw);
}

function directHotelRelationshipReplyText(sc = {}, st = {}) {
	const name = respectfulGuestName(sc, st);
	const hotelName = localizedHotelName(sc, st) || toTitle(st.hotel?.hotelName || "the hotel");
	const lang = languageOf(sc, st);
	if (/arabic/i.test(lang)) {
		return `${name}\u060c \u0646\u0639\u0645 \u0633\u064a\u062f\u064a\u060c \u0623\u0646\u0627 \u0623\u0639\u0645\u0644 \u0645\u0628\u0627\u0634\u0631\u0629 \u0645\u0639 \u0641\u0631\u064a\u0642 \u0627\u0633\u062a\u0642\u0628\u0627\u0644 \u0648\u062d\u062c\u0648\u0632\u0627\u062a ${hotelName}. \u0623\u064a \u062a\u0648\u0641\u0631 \u0623\u0648 \u062a\u0641\u0627\u0635\u064a\u0644 \u062d\u062c\u0632 \u0623\u0631\u0627\u062c\u0639\u0647\u0627 \u0645\u0639 \u0641\u0631\u064a\u0642 \u0627\u0644\u0641\u0646\u062f\u0642 \u0647\u0646\u0627 \u0645\u0628\u0627\u0634\u0631\u0629.`;
	}
	if (/spanish/i.test(lang)) {
		return `Si senor, trabajo directamente con el equipo de recepcion y reservas de ${hotelName}. Puedo revisar disponibilidad y detalles de la reserva con el equipo del hotel aqui mismo.`;
	}
	if (/french/i.test(lang)) {
		return `Oui monsieur, je travaille directement avec l'equipe reception et reservations de ${hotelName}. Je peux verifier la disponibilite et les details de reservation avec l'equipe de l'hotel ici.`;
	}
	return `Yes sir, I work directly with the ${hotelName} reception and reservations team. I can check availability and reservation details with the hotel team here.`;
}

function confidentialCompanyDocumentReplyText(sc = {}, st = {}) {
	const name = respectfulGuestName(sc, st);
	const hotelName = localizedHotelName(sc, st) || toTitle(st.hotel?.hotelName || "the hotel");
	const lang = languageOf(sc, st);
	if (/arabic/i.test(lang)) {
		return `${name}\u060c \u0623\u0641\u0647\u0645 \u0637\u0644\u0628\u0643. \u0623\u0646\u0627 \u0647\u0646\u0627 \u0644\u0644\u0645\u0633\u0627\u0639\u062f\u0629 \u0643\u062f\u0639\u0645 \u0627\u0644\u0627\u0633\u062a\u0642\u0628\u0627\u0644 \u0648\u0627\u0644\u062d\u062c\u0648\u0632\u0627\u062a \u0644\u0640 ${hotelName}\u060c \u0644\u0643\u0646 \u0623\u0631\u0642\u0627\u0645 \u0627\u0644\u0636\u0631\u0627\u0626\u0628 \u0623\u0648 \u0627\u0644\u0645\u0633\u062a\u0646\u062f\u0627\u062a \u0627\u0644\u0631\u0633\u0645\u064a\u0629 \u0623\u0648 \u0623\u0648\u0631\u0627\u0642 \u0627\u0644\u062a\u0633\u062c\u064a\u0644 \u0648\u0627\u0644\u062a\u0631\u0627\u062e\u064a\u0635 \u0645\u0639\u0644\u0648\u0645\u0627\u062a \u0633\u0631\u064a\u0629 \u0648\u0644\u0627 \u064a\u062a\u0645 \u062a\u0648\u0641\u064a\u0631\u0647\u0627 \u0645\u0646 \u062e\u0644\u0627\u0644 \u062f\u0631\u062f\u0634\u0629 \u0627\u0644\u062f\u0639\u0645. \u0628\u0639\u062f \u0625\u062a\u0645\u0627\u0645 \u0627\u0644\u062d\u062c\u0632 \u0648\u0627\u0644\u0648\u0635\u0648\u0644 \u0644\u0644\u0641\u0646\u062f\u0642\u060c \u064a\u0645\u0643\u0646\u0643 \u0637\u0644\u0628 \u0627\u0644\u0645\u062f\u064a\u0631 \u0634\u062e\u0635\u064a\u0627\u060c \u0648\u0627\u0644\u0625\u062f\u0627\u0631\u0629 \u0633\u062a\u0631\u0627\u062c\u0639 \u0645\u0627 \u064a\u0645\u0643\u0646 \u0639\u0631\u0636\u0647 \u0639\u0628\u0631 \u0627\u0644\u0642\u0646\u0627\u0629 \u0627\u0644\u0631\u0633\u0645\u064a\u0629 \u0627\u0644\u0645\u0646\u0627\u0633\u0628\u0629.`;
	}
	if (/spanish/i.test(lang)) {
		return `${name}, entiendo su solicitud. Aqui puedo ayudar como soporte de recepcion y reservas de ${hotelName}, pero los EIN, numeros fiscales, documentos de registro, licencias y papeles internos de la empresa son confidenciales y no se comparten por el chat de soporte. Despues de reservar y llegar al hotel, puede pedir hablar con el gerente en persona, y la administracion revisara que se puede mostrar por el canal oficial adecuado.`;
	}
	if (/french/i.test(lang)) {
		return `${name}, je comprends votre demande. Ici, je peux vous aider comme support reception et reservations de ${hotelName}, mais les numeros fiscaux, documents d'enregistrement, licences et documents internes de l'entreprise sont confidentiels et ne sont pas fournis par le chat de support. Apres votre reservation et votre arrivee a l'hotel, vous pourrez demander a voir le responsable en personne, et la direction verifiera ce qui peut etre presente par le canal officiel approprie.`;
	}
	if (/indonesian/i.test(lang)) {
		return `${name}, saya memahami permintaannya. Di sini saya membantu sebagai dukungan resepsionis dan reservasi ${hotelName}, tetapi nomor pajak, dokumen pendaftaran, lisensi, sertifikat, dan dokumen internal perusahaan bersifat rahasia dan tidak dibagikan melalui chat dukungan. Setelah reservasi selesai dan Anda tiba di hotel, Anda dapat meminta bertemu manajer secara langsung, lalu manajemen akan meninjau apa yang dapat ditunjukkan melalui jalur resmi yang tepat.`;
	}
	if (/malay/i.test(lang)) {
		return `${name}, saya faham permintaan tuan. Di sini saya membantu sebagai sokongan penyambut tetamu dan tempahan ${hotelName}, tetapi nombor cukai, dokumen pendaftaran, lesen, sijil, dan dokumen dalaman syarikat adalah sulit dan tidak dikongsi melalui chat sokongan. Selepas tempahan dibuat dan tuan tiba di hotel, tuan boleh minta berjumpa pengurus secara langsung, dan pihak pengurusan akan menyemak apa yang boleh ditunjukkan melalui saluran rasmi yang sesuai.`;
	}
	return `${name}, I understand why you are asking. I can help here as ${hotelName} reception and reservations support, but company EIN/tax IDs, registration papers, licenses, certificates, and internal documents are confidential and are not provided through support chat. After you reserve and arrive at the hotel, you may ask the hotel manager in person; management can review what can be shown through the proper official channel.`;
}

function normalizedContactRequestText(text = "") {
	return normalizeControlText(text).lower.replace(/\s+/g, " ").trim();
}

function hotelContactConversationRequestCount(sc = {}) {
	const conversation = Array.isArray(sc.conversation) ? sc.conversation : [];
	return conversation.filter((message) => {
		if (!isGuestConversationMessage(message)) return false;
		return hotelContactRequestLikeText(conversationEntryContextText(message));
	}).length;
}

function hotelContactRequestCount(sc = {}, userText = "") {
	const conversation = Array.isArray(sc.conversation) ? sc.conversation : [];
	const latestText = normalizedContactRequestText(userText);
	let count = 0;
	let latestAlreadyCounted = false;
	const lastGuestIndex = conversation.reduce(
		(lastIndex, message, index) =>
			isGuestConversationMessage(message) ? index : lastIndex,
		-1
	);
	for (let index = 0; index < conversation.length; index += 1) {
		const message = conversation[index];
		if (!isGuestConversationMessage(message)) continue;
		const text = conversationEntryContextText(message);
		if (!hotelContactRequestLikeText(text)) continue;
		count += 1;
		if (
			latestText &&
			normalizedContactRequestText(text) === latestText &&
			index === lastGuestIndex
		) {
			latestAlreadyCounted = true;
		}
	}
	if (hotelContactRequestLikeText(userText) && !latestAlreadyCounted) count += 1;
	return count;
}

function previousHotelContactRequestCount(sc = {}, userText = "") {
	const count = hotelContactRequestCount(sc, userText);
	return Math.max(0, count - (hotelContactRequestLikeText(userText) ? 1 : 0));
}

function hotelContactFollowupQuestionText(sc = {}, userText = "") {
	return (
		genericContactNumberRequestText(userText) &&
		previousHotelContactRequestCount(sc, userText) >= 1
	);
}

function hotelContactInsistenceText(text = "") {
	const { lower, arabic, latinCompact } = normalizeControlText(text);
	return (
		/\b(?:again|still|just|only|insist|must|need\s+the\s+number|give\s+me\s+the\s+number|send\s+the\s+number|phone\s+please|number\s+please)\b/i.test(
			lower
		) ||
		/(?:\u0628\u0631\u0636\u0647|\u0644\u0627\u0632\u0645|\u0645\u0635\u0631|\u0645\u0631\u0629\s*\u062b\u0627\u0646\u064a\u0629|\u0627\u062f\u064a\u0646\u064a\s+\u0627\u0644\u0631\u0642\u0645|\u0627\u0628\u0639\u062a\s+\u0627\u0644\u0631\u0642\u0645|\u0627\u0631\u0633\u0644\s+\u0627\u0644\u0631\u0642\u0645)/i.test(
			arabic
		) ||
		/(?:again|still|justgiveme|numberplease|phoneplease|sendnumber)/i.test(
			latinCompact
		)
	);
}

function contactReplyLanguageKey(sc = {}, st = {}) {
	const target = `${languageOf(sc, st)} ${activeLanguageCodeOf(sc, st)}`.toLowerCase();
	if (/arabic|\bar\b/.test(target)) return "ar";
	if (/spanish|\bes\b/.test(target)) return "es";
	if (/french|\bfr\b/.test(target)) return "fr";
	if (/urdu|\bur\b/.test(target)) return "ur";
	if (/hindi|\bhi\b/.test(target)) return "hi";
	if (/indonesian|\bid\b/.test(target)) return "id";
	if (/malay|malaysia|\bms\b/.test(target)) return "ms";
	return "en";
}

function hotelContactReplyText(sc = {}, st = {}, options = {}) {
	const name = respectfulGuestName(sc, st);
	const phone = String(options.publicPhone || "").trim();
	const requestCount = Number(options.requestCount || 1);
	const firm = requestCount >= 2;
	const key = contactReplyLanguageKey(sc, st);
	const hotelName = st.hotel ? localizedHotelName(sc, st) || toTitle(st.hotel.hotelName) : "";
	const hotelEn = hotelName || "the hotel";
	const templates = {
		en: {
			first: `${name}, this is ${st.agentName}; I work directly with the reception of ${hotelEn}. This live chat is the safest and most credible way to reserve because reception can check live availability and keep every detail clear in one place. Send me what you need and I will handle it with you here.`,
			firm: `${name}, I understand you want the number. I am working directly with the reception of ${hotelEn}, and continuing here is the safest and most credible way to complete the reservation with live availability and clear details. Tell me what you need and I will take care of it step by step.`,
			share: `${name}, the phone/WhatsApp line I can share is ${phone}. For the smoothest reservation, please keep the details here too so reception can track availability and your request without losing context.`,
		},
		ar: {
			first: `${name}\u060c \u0645\u0639\u0643 ${st.agentName}\u060c \u0623\u0639\u0645\u0644 \u0645\u0628\u0627\u0634\u0631\u0629 \u0645\u0639 \u0627\u0633\u062a\u0642\u0628\u0627\u0644 ${hotelEn}. \u0647\u0630\u0647 \u0627\u0644\u062f\u0631\u062f\u0634\u0629 \u0647\u064a \u0627\u0644\u0637\u0631\u064a\u0642\u0629 \u0627\u0644\u0623\u0636\u0645\u0646 \u0648\u0627\u0644\u0623\u0643\u062b\u0631 \u0645\u0635\u062f\u0627\u0642\u064a\u0629 \u0644\u0625\u062a\u0645\u0627\u0645 \u0627\u0644\u062d\u062c\u0632 \u0644\u0623\u0646 \u0627\u0644\u0627\u0633\u062a\u0642\u0628\u0627\u0644 \u064a\u0631\u0627\u062c\u0639 \u0627\u0644\u062a\u0648\u0641\u0631 \u0645\u0628\u0627\u0634\u0631\u0629 \u0648\u064a\u062d\u0641\u0638 \u0643\u0644 \u0627\u0644\u062a\u0641\u0627\u0635\u064a\u0644 \u0641\u064a \u0645\u0643\u0627\u0646 \u0648\u0627\u062d\u062f. \u0627\u0643\u062a\u0628 \u0644\u064a \u0637\u0644\u0628\u0643 \u0648\u0633\u0623\u062a\u0627\u0628\u0639\u0647 \u0645\u0639\u0643 \u0647\u0646\u0627.`,
			firm: `${name}\u060c \u0623\u0641\u0647\u0645 \u0623\u0646\u0643 \u062a\u0631\u064a\u062f \u0627\u0644\u0631\u0642\u0645. \u0623\u0646\u0627 \u0623\u0639\u0645\u0644 \u0645\u0628\u0627\u0634\u0631\u0629 \u0645\u0639 \u0627\u0633\u062a\u0642\u0628\u0627\u0644 ${hotelEn}\u060c \u0648\u0625\u0643\u0645\u0627\u0644 \u0627\u0644\u062d\u062c\u0632 \u0647\u0646\u0627 \u0647\u0648 \u0627\u0644\u0623\u0636\u0645\u0646 \u0648\u0627\u0644\u0623\u0643\u062b\u0631 \u0645\u0635\u062f\u0627\u0642\u064a\u0629 \u0644\u0645\u062a\u0627\u0628\u0639\u0629 \u0627\u0644\u062a\u0648\u0641\u0631 \u0648\u0627\u0644\u062a\u0641\u0627\u0635\u064a\u0644 \u0628\u0648\u0636\u0648\u062d. \u0623\u0631\u0633\u0644 \u0644\u064a \u0627\u0644\u0645\u0637\u0644\u0648\u0628 \u0648\u0633\u0623\u062e\u062f\u0645\u0643 \u062e\u0637\u0648\u0629 \u0628\u062e\u0637\u0648\u0629.`,
			share: `${name}\u060c \u062e\u0637 \u0627\u0644\u0647\u0627\u062a\u0641/\u0648\u0627\u062a\u0633\u0627\u0628 \u0627\u0644\u0645\u062a\u0627\u062d \u0647\u0648 ${phone}. \u0648\u0645\u0639 \u0630\u0644\u0643 \u0623\u0646\u0635\u062d\u0643 \u0623\u0646 \u062a\u0628\u0642\u064a \u062a\u0641\u0627\u0635\u064a\u0644 \u0627\u0644\u062d\u062c\u0632 \u0647\u0646\u0627 \u0623\u064a\u0636\u0627 \u062d\u062a\u0649 \u064a\u0631\u0627\u062c\u0639 \u0627\u0644\u0627\u0633\u062a\u0642\u0628\u0627\u0644 \u0627\u0644\u062a\u0648\u0641\u0631 \u0648\u0637\u0644\u0628\u0643 \u0628\u062f\u0648\u0646 \u0641\u0642\u062f\u0627\u0646 \u0627\u0644\u0633\u064a\u0627\u0642.`,
		},
		es: {
			first: `${name}, soy ${st.agentName} y trabajo directamente con la recepcion de ${hotelEn}. Este chat en vivo es la forma mas segura y creible de reservar, porque recepcion puede revisar disponibilidad en vivo y mantener todos los datos claros en un solo lugar. Escribeme lo que necesitas y lo gestiono contigo aqui.`,
			firm: `${name}, entiendo que quieres el numero. Trabajo directamente con la recepcion de ${hotelEn}, y continuar aqui es la forma mas segura y creible de completar la reserva con disponibilidad en vivo y datos claros. Dime que necesitas y lo llevo paso a paso.`,
			share: `${name}, la linea de telefono/WhatsApp que puedo compartir es ${phone}. Para que la reserva sea mas fluida, mantengamos tambien los detalles aqui para que recepcion pueda seguir la disponibilidad y tu solicitud sin perder contexto.`,
		},
		fr: {
			first: `${name}, je suis ${st.agentName} et je travaille directement avec la reception de ${hotelEn}. Ce chat en direct est le moyen le plus sur et le plus credible pour reserver, car la reception peut verifier la disponibilite en direct et garder les details clairs au meme endroit. Envoyez-moi votre demande et je la traite avec vous ici.`,
			firm: `${name}, je comprends que vous souhaitez le numero. Je travaille directement avec la reception de ${hotelEn}, et continuer ici est le moyen le plus sur et le plus credible de finaliser la reservation avec disponibilite en direct et details clairs. Dites-moi ce dont vous avez besoin et je m'en occupe etape par etape.`,
			share: `${name}, la ligne telephone/WhatsApp que je peux partager est ${phone}. Pour une reservation plus fluide, gardons aussi les details ici afin que la reception suive la disponibilite et votre demande sans perdre le contexte.`,
		},
		ur: {
			first: `${name}، میں ${st.agentName} ہوں اور ${hotelEn} کی ریسیپشن کے ساتھ براہ راست کام کر رہا/رہی ہوں۔ یہ لائیو چیٹ بکنگ کا سب سے محفوظ اور معتبر طریقہ ہے، کیونکہ ریسیپشن دستیابی براہ راست چیک کرتی ہے اور تمام تفصیلات ایک ہی جگہ واضح رہتی ہیں۔ آپ اپنی ضرورت لکھ دیں، میں یہیں مدد کرتا/کرتی ہوں۔`,
			firm: `${name}، میں سمجھتا/سمجھتی ہوں کہ آپ نمبر چاہتے ہیں۔ میں ${hotelEn} کی ریسیپشن کے ساتھ براہ راست کام کر رہا/رہی ہوں، اور یہاں جاری رکھنا بکنگ مکمل کرنے کا سب سے محفوظ اور معتبر طریقہ ہے کیونکہ دستیابی اور تفصیلات براہ راست واضح رہتی ہیں۔ آپ بتائیں کیا چاہیے، میں قدم بہ قدم مدد کرتا/کرتی ہوں۔`,
			share: `${name}، فون/WhatsApp لائن جو میں شیئر کر سکتا/سکتی ہوں یہ ہے: ${phone}. بہتر ریزرویشن کے لیے تفصیلات یہاں بھی رکھیں تاکہ ریسیپشن دستیابی اور درخواست کا مکمل سیاق دیکھ سکے۔`,
		},
		hi: {
			first: `${name}, मैं ${st.agentName} हूं और ${hotelEn} की reception के साथ directly काम कर रहा/रही हूं। यह live chat reservation के लिए सबसे सुरक्षित और credible तरीका है, क्योंकि reception live availability check करती है और सभी details एक जगह साफ रहती हैं। आप अपनी जरूरत लिख दीजिए, मैं यहीं help करता/करती हूं।`,
			firm: `${name}, मैं समझ रहा/रही हूं कि आपको number चाहिए। मैं ${hotelEn} की reception के साथ directly काम कर रहा/रही हूं, और यहां continue करना reservation complete करने का सबसे सुरक्षित और credible तरीका है क्योंकि live availability और details साफ रहती हैं। बताइए आपको क्या चाहिए, मैं step by step handle कर दूंगा/दूंगी।`,
			share: `${name}, जो phone/WhatsApp line मैं share कर सकता/सकती हूं वह है ${phone}. Smooth reservation के लिए details यहां भी रखें ताकि reception availability और आपकी request का context न खोए।`,
		},
		id: {
			first: `${name}, saya ${st.agentName} dan bekerja langsung dengan reception ${hotelEn}. Live chat ini adalah cara paling aman dan paling terpercaya untuk reservasi, karena reception bisa mengecek ketersediaan live dan menjaga semua detail tetap jelas di satu tempat. Tulis kebutuhan Anda, saya bantu di sini.`,
			firm: `${name}, saya mengerti Anda ingin nomor telepon. Saya bekerja langsung dengan reception ${hotelEn}, dan melanjutkan di sini adalah cara paling aman dan terpercaya untuk menyelesaikan reservasi dengan ketersediaan live dan detail yang jelas. Beri tahu saya kebutuhan Anda, saya bantu langkah demi langkah.`,
			share: `${name}, nomor telepon/WhatsApp yang bisa saya bagikan adalah ${phone}. Untuk reservasi yang paling lancar, simpan juga detailnya di sini agar reception bisa melacak ketersediaan dan permintaan Anda tanpa kehilangan konteks.`,
		},
		ms: {
			first: `${name}, saya ${st.agentName} dan bekerja terus dengan reception ${hotelEn}. Live chat ini cara paling selamat dan paling dipercayai untuk tempahan, kerana reception boleh semak availability secara live dan simpan semua butiran dengan jelas di satu tempat. Tulis apa yang anda perlukan, saya bantu di sini.`,
			firm: `${name}, saya faham anda mahu nombor telefon. Saya bekerja terus dengan reception ${hotelEn}, dan meneruskan di sini ialah cara paling selamat dan dipercayai untuk lengkapkan tempahan dengan availability live dan butiran yang jelas. Beritahu saya apa yang diperlukan, saya bantu langkah demi langkah.`,
			share: `${name}, talian telefon/WhatsApp yang boleh saya kongsi ialah ${phone}. Untuk tempahan yang paling lancar, kekalkan juga butiran di sini supaya reception boleh ikut availability dan permintaan anda tanpa hilang konteks.`,
		},
	};
	const chosen = templates[key] || templates.en;
	return firm ? chosen.firm : chosen.first;
}

function vagueHajjInquiryText(text = "") {
	const { lower, arabic, latinCompact } = normalizeControlText(text);
	const mentionsHajj =
		/\b(?:hajj|haj|hadj|pilgrimage)\b/i.test(lower) ||
		/(?:^|[^\u0621-\u064a])(?:[\u0628\u0644\u0643\u0641\u0633\u0648]{0,3}\u0627\u0644\u062d\u062c|[\u0628\u0644\u0643\u0641\u0633\u0648]{0,3}\u062d\u062c)(?:$|[^\u0621-\u064a])/i.test(
			arabic
		) ||
		/(?:hajj|haj|hadj|pilgrimage)/i.test(latinCompact);
	if (!mentionsHajj) return false;
	const onlyHijriMonth =
		/(?:\u0630\u0648\s*\u0627\u0644\u062d\u062c\u0629|dhul\s*hijj|dhu\s*al\s*hijj)/i.test(
			lower
		) &&
		!/\b(?:package|organize|organisation|organization|category|program|permit|visa|support|work|serve|available|offer)\b/i.test(
			lower
		) &&
		!/(?:\u0628\u0627\u0643\u062c|\u0628\u0631\u0646\u0627\u0645\u062c|\u062a\u0646\u0638\u064a\u0645|\u062a\u0635\u0631\u064a\u062d|\u062a\u0623\u0634\u064a\u0631\u0629|\u0641\u0626\u0629|\u0634\u063a\u0627\u0644\u064a\u0646|\u0645\u062a\u0627\u062d)/i.test(
			arabic
		);
	return !onlyHijriMonth;
}

function likelyRoomTypeText(text = "") {
	const raw = String(text || "");
	if (!raw.trim()) return false;
	const lower = raw.toLowerCase();
	const roomOrCapacityWords =
		/\b(?:room|rooms|bed|beds|suite|suites|double|twin|king|queen|standard|triple|quad|quadruple|family|quintuple|guest|guests|adult|adults|people|persons|pax|ghorfa|ghurfa|ghoraf|ghuraf|odah|oda|owda|awda)\b/i.test(
			lower
		) ||
		/(?:\u063a\u0631\u0641\u0629|\u063a\u0631\u0641\u0647|\u063a\u0631\u0641|\u0623\u0648\u0636\u0629|\u0627\u0648\u0636\u0629|\u0633\u0631\u064a\u0631|\u0623\u0633\u0631\u0629|\u0627\u0633\u0631\u0629|\u0634\u062e\u0635|\u0627\u0634\u062e\u0627\u0635|\u0623\u0634\u062e\u0627\u0635|\u0636\u064a\u0648\u0641|\u0646\u0641\u0631|\u0628\u0627\u0644\u063a|\u062b\u0646\u0627\u0626|\u062f\u0628\u0644|\u062b\u0644\u0627\u062b|\u062b\u0644\u0627\u062b\u064a|\u0631\u0628\u0627\u0639|\u062e\u0645\u0627\u0633|\u0639\u0627\u0626\u0644\u064a)/i.test(
			raw
		);
	if (roomOrCapacityWords) return true;
	return (
		/\b(?:2|two|3|three|4|four|5|five|6|six|7|seven|8|eight|9|nine|10|ten)\b/i.test(
			lower
		) &&
		/\b(?:guest|guests|adult|adults|people|persons|pax|bed|beds|room|rooms)\b/i.test(
			lower
		)
	);
}

function roomCapacityOrTypeInquiryText(text = "") {
	const raw = String(text || "");
	if (!raw.trim()) return false;
	const { lower, arabic, latinCompact } = normalizeControlText(raw);
	const hasRoomWord =
		/\b(?:room|rooms|bed|beds|suite|suites)\b/i.test(lower) ||
		/(?:\u063a\u0631\u0641\u0629|\u063a\u0631\u0641\u0647|\u063a\u0631\u0641|\u0623\u0648\u0636\u0629|\u0627\u0648\u0636\u0629|\u0633\u0631\u064a\u0631|\u0623\u0633\u0631\u0629|\u0627\u0633\u0631\u0629)/i.test(
			arabic
		) ||
		/(?:ghorfa|ghurfa|oda|room|bed)/i.test(latinCompact);
	const hasOccupancyWord =
		/\b(?:people|persons?|guests?|adults?|pax)\b/i.test(lower) ||
		/(?:\u0627\u0634\u062e\u0627\u0635|\u0623\u0634\u062e\u0627\u0635|\u0627\u0641\u0631\u0627\u062f|\u0623\u0641\u0631\u0627\u062f|\u0636\u064a\u0648\u0641|\u0646\u0641\u0631|\u0628\u0627\u0644\u063a)/i.test(
			arabic
		);
	const requestedGuestCount = requestedGuestCountFromText(raw);
	const hasCapacityOrType =
		Boolean(mapRoomToKey(raw)) ||
		Boolean(requestedGuestCount) ||
		/\b(?:2|two|3|three|4|four|5|five|6|six|7|seven|8|eight|9|nine|10|ten)\s*(?:people|persons|guests|adults|beds?)\b/i.test(
			lower
		) ||
		/(?:\u0641\u0631\u062f|\u0627\u0641\u0631\u0627\u062f|\u0623\u0641\u0631\u0627\u062f|\u0634\u062e\u0635|\u0627\u0634\u062e\u0627\u0635|\u0623\u0634\u062e\u0627\u0635|\u062a\u0644\u062a|\u062b\u0644\u0627\u062b|\u062b\u0644\u0627\u062b\u0629|\u062b\u0644\u0627\u062b\u0647|\u0627\u0631\u0628\u0639|\u0623\u0631\u0628\u0639|\u0627\u0631\u0628\u0639\u0629|\u0631\u0628\u0627\u0639|\u062e\u0645\u0633|\u062e\u0645\u0627\u0633|\u0633\u062a|\u0633\u062a\u0629|\u0633\u062a\u0647|\u0633\u0628\u0639|\u0633\u0628\u0639\u0629|\u0633\u0628\u0639\u0647|\u062b\u0645\u0627\u0646|\u062a\u0645\u0627\u0646|\u062a\u0633\u0639|\u0639\u0634\u0631)/i.test(
			arabic
		);
	const hasBookingIntent =
		/\b(?:need|want|looking|book|reserve|help|available|availability|have|has)\b/i.test(
			lower
		) ||
		/(?:\u0639\u0627\u064a\u0632|\u0639\u0627\u0648\u0632|\u0623\u0628\u063a\u0649|\u0627\u0628\u063a\u0649|\u0623\u0631\u064a\u062f|\u0627\u0631\u064a\u062f|\u0627\u062d\u062a\u0627\u062c|\u0645\u0645\u0643\u0646|\u0633\u0627\u0639\u062f|\u0645\u062a\u0627\u062d|\u0627\u062d\u062c\u0632|\u0623\u062d\u062c\u0632)/i.test(
			arabic
		);
	return (hasRoomWord || (hasOccupancyWord && hasCapacityOrType)) && (hasCapacityOrType || hasBookingIntent);
}

function wantsNewReservationIntent(text = "", lu = {}) {
	if (lu?.intent === "reserve_room") return true;
	const raw = String(text || "");
	const hasNewReservationLanguage =
		hasSemanticSignal(raw, "newBooking") ||
		/\b(book|reserve|make\s+(?:a\s+)?reservation|new\s+(?:booking|reservation)|book\s+a\s*room|reserve\s+a\s*room|need\s+a\s*room|want\s+a\s*room)\b/i.test(
			raw
		) ||
		/(?:\u0627\u062d\u062c\u0632|\u0623\u062d\u062c\u0632|\u062d\u062c\u0632\s+\u063a\u0631\u0641|\u0627\u0628\u063a\u0649\s+\u063a\u0631\u0641|\u0623\u0628\u063a\u0649\s+\u063a\u0631\u0641|\u0627\u0631\u064a\u062f\s+\u063a\u0631\u0641|\u0623\u0631\u064a\u062f\s+\u063a\u0631\u0641)/i.test(
			raw
		) ||
		/\b(reservar|reservacion|r[e\u00e9]server)\b/i.test(raw);
	const includesStayDetails =
		Boolean(mapRoomToKey(raw)) ||
		Boolean(quickDateRange(raw)?.checkinISO) ||
		hasSemanticSignal(raw, "room") ||
		/\b(?:check[\s-]?in|check[\s-]?out|adults?|guests?|pax|room|rooms?)\b/i.test(
			raw
		) ||
		/(?:\u062f\u062e\u0648\u0644|\u062e\u0631\u0648\u062c|\u063a\u0631\u0641\u0629|\u063a\u0631\u0641|\u0628\u0627\u0644\u063a|\u0623\u0634\u062e\u0627\u0635|\u0627\u0634\u062e\u0627\u0635|\u0634\u062e\u0635\u064a\u0646|\u0644\u0634\u062e\u0635\u064a\u0646)/i.test(
			raw
		);
	if (
		(latestKnownConfirmation({}, lu) && !(hasNewReservationLanguage || includesStayDetails)) ||
		explicitlyExistingReservationIntent(raw)
	) {
		return false;
	}
	if (/\b(reservasi|tempahan|pesan\s+kamar|tempah\s+bilik)\b/i.test(raw)) {
		return true;
	}
	return hasNewReservationLanguage;
}

function isoDate(value = "") {
	const date = new Date(String(value || "").trim());
	if (Number.isNaN(date.getTime())) return null;
	return date.toISOString().slice(0, 10);
}

function monthNumberFromText(value = "") {
	const token = String(value || "")
		.toLowerCase()
		.replace(/[\u064b-\u065f\u0670]/g, "")
		.trim();
	const normalizedArabic = token
		.replace(/\u0623|\u0625|\u0622/g, "\u0627")
		.replace(/\u0649/g, "\u064a")
		.replace(/\u0629/g, "\u0647");
	const months = [
		["jan", "january", "\u064a\u0646\u0627\u064a\u0631", "\u064a\u0646\u0627\u064a\u0631\u0648"],
		["feb", "february", "\u0641\u0628\u0631\u0627\u064a\u0631"],
		["mar", "march", "\u0645\u0627\u0631\u0633"],
		["apr", "april", "\u0627\u0628\u0631\u064a\u0644"],
		["may", "\u0645\u0627\u064a\u0648"],
		["jun", "june", "\u064a\u0648\u0646\u064a\u0648", "\u064a\u0648\u0646\u064a\u0647"],
		["jul", "july", "\u064a\u0648\u0644\u064a\u0648", "\u064a\u0648\u0644\u064a\u0647"],
		["aug", "august", "\u0627\u063a\u0633\u0637\u0633", "\u0627\u0648\u063a\u0633\u0637\u0633"],
		["sep", "sept", "september", "\u0633\u0628\u062a\u0645\u0628\u0631"],
		["oct", "october", "\u0627\u0643\u062a\u0648\u0628\u0631"],
		["nov", "november", "\u0646\u0648\u0641\u0645\u0628\u0631"],
		["dec", "december", "\u062f\u064a\u0633\u0645\u0628\u0631"],
	];
	for (let index = 0; index < months.length; index += 1) {
		if (months[index].includes(token) || months[index].includes(normalizedArabic)) {
			return index + 1;
		}
	}
	return 0;
}

function buildFutureIsoDateFromParts(day, month, year = null) {
	const parsedDay = Number(day);
	const parsedMonth = Number(month);
	if (!parsedDay || !parsedMonth) return null;
	const baseYear = Number(year) || new Date().getFullYear();
	const date = new Date(Date.UTC(baseYear, parsedMonth - 1, parsedDay));
	if (
		date.getUTCDate() !== parsedDay ||
		date.getUTCMonth() !== parsedMonth - 1 ||
		date.getUTCFullYear() !== baseYear
	) {
		return null;
	}
	for (
		let guard = 0;
		guard < 8 && date.toISOString().slice(0, 10) < todayISODate();
		guard += 1
	) {
		date.setUTCFullYear(date.getUTCFullYear() + 1);
	}
	return date.toISOString().slice(0, 10);
}

function likelyStayDateText(text = "") {
	const raw = digitsToEnglish(String(text || "").toLowerCase());
	if (!raw.trim()) return false;
	if (/\b20\d{2}-\d{2}-\d{2}\b/.test(raw)) return true;
	if (/\b\d{1,2}\s*[/-]\s*\d{1,2}(?:\s*[/-]\s*(?:20)?\d{2})?\b/.test(raw)) {
		return true;
	}
	if (
		/\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i.test(
			raw
		)
	) {
		return true;
	}
	if (
		/(?:\u0645\u062d\u0631\u0645|\u0635\u0641\u0631|\u0631\u0628\u064a\u0639|\u0631\u0628\u064a\u0639\s+\u0627\u0644\u0623\u0648\u0644|\u0631\u0628\u064a\u0639\s+\u0627\u0644\u062b\u0627\u0646\u064a|\u062c\u0645\u0627\u062f|\u0631\u062c\u0628|\u0634\u0639\u0628\u0627\u0646|\u0631\u0645\u0636\u0627\u0646|\u0634\u0648\u0627\u0644|\u0630\u0648\s+\u0627\u0644\u0642\u0639\u062f\u0629|\u0630\u0648\s+\u0627\u0644\u062d\u062c\u0629|\u064a\u0646\u0627\u064a\u0631|\u0641\u0628\u0631\u0627\u064a\u0631|\u0645\u0627\u0631\u0633|\u0627\u0628\u0631\u064a\u0644|\u0623\u0628\u0631\u064a\u0644|\u0645\u0627\u064a\u0648|\u064a\u0648\u0646\u064a\u0648|\u064a\u0648\u0644\u064a\u0648|\u0627\u063a\u0633\u0637\u0633|\u0623\u063a\u0633\u0637\u0633|\u0633\u0628\u062a\u0645\u0628\u0631|\u0627\u0643\u062a\u0648\u0628\u0631|\u0623\u0643\u062a\u0648\u0628\u0631|\u0646\u0648\u0641\u0645\u0628\u0631|\u062f\u064a\u0633\u0645\u0628\u0631)/i.test(
			raw
		)
	) {
		return true;
	}
	if (
		/\b(?:check\s*-?\s*in|check\s*-?\s*out|checkout|arrival|departure|dates?|stay\s+dates?|nights?|hijri|gregorian|ramadan)\b/i.test(
			raw
		) &&
		/\d/.test(raw)
	) {
		return true;
	}
	return (
		/(?:\u062a\u0627\u0631\u064a\u062e|\u062a\u0648\u0627\u0631\u064a\u062e|\u0648\u0635\u0648\u0644|\u0645\u063a\u0627\u062f\u0631\u0629|\u062f\u062e\u0648\u0644|\u062e\u0631\u0648\u062c|\u0644\u064a\u0644\u0629|\u0644\u064a\u0627\u0644\u064a|\u0647\u062c\u0631\u064a|\u0645\u064a\u0644\u0627\u062f\u064a)/i.test(
			raw
		) && /\d/.test(raw)
	);
}

function parseSameMonthDateRange(text = "") {
	const normalized = digitsToEnglish(String(text || "").toLowerCase());
	const monthToken =
		"(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|[\u0600-\u06ff]+)";
	const rangeRegex = new RegExp(
		`(?:\\b(?:from|arrival|check\\s*-?in|date|dates|تاريخ|الوصول|من)\\b\\s*)?(\\d{1,2})\\s+${monthToken}\\s*(?:\\b(?:to|until|till|through|checkout|check\\s*-?out|departure)\\b|\\-|–|—|الى|إلى|ل|حتي|حتى|الي)\\s*(\\d{1,2})(?:\\s+${monthToken})?(?:\\s*,?\\s*(20\\d{2}))?`,
		"i"
	);
	const match = normalized.match(rangeRegex);
	if (!match) return null;
	const startDay = match[1];
	const startMonth = monthNumberFromText(match[2]);
	const endDay = match[3];
	const endMonth = monthNumberFromText(match[4]) || startMonth;
	const year = match[5] || null;
	if (!startMonth || !endMonth) return null;
	const checkinISO = buildFutureIsoDateFromParts(startDay, startMonth, year);
	let checkoutISO = buildFutureIsoDateFromParts(endDay, endMonth, year);
	if (!checkinISO || !checkoutISO) return null;
	if (checkoutISO <= checkinISO) {
		const checkout = new Date(`${checkoutISO}T00:00:00Z`);
		checkout.setUTCMonth(checkout.getUTCMonth() + 1);
		checkoutISO = checkout.toISOString().slice(0, 10);
	}
	return {
		checkinISO,
		checkoutISO,
		raw: {
			checkin: `${startDay} ${match[2]}`,
			checkout: `${endDay} ${match[4] || match[2]}`,
			calendar: "gregorian",
		},
	};
}

function parseMonthFirstDateRange(text = "") {
	const normalized = digitsToEnglish(String(text || "").toLowerCase());
	const monthToken =
		"(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|[\u0600-\u06ff]+)";
	const rangeRegex = new RegExp(
		`(?:\\b(?:from|arrival|check\\s*-?in|date|dates)\\b\\s*)?${monthToken}\\s+(\\d{1,2})(?:\\s*,?\\s*(20\\d{2}))?\\s*(?:\\b(?:to|until|till|through|thru|checkout|check\\s*-?out|departure)\\b|\\-|\\u2013|\\u2014)\\s*(?:${monthToken}\\s+)?(\\d{1,2})(?:\\s*,?\\s*(20\\d{2}))?`,
		"i"
	);
	const match = normalized.match(rangeRegex);
	if (!match) return null;
	const startMonthText = match[1];
	const startDay = match[2];
	const startYear = match[3] || null;
	const endMonthText = match[4] || startMonthText;
	const endDay = match[5];
	const endYear = match[6] || startYear || null;
	const startMonth = monthNumberFromText(startMonthText);
	const endMonth = monthNumberFromText(endMonthText) || startMonth;
	if (!startMonth || !endMonth) return null;
	const checkinISO = buildFutureIsoDateFromParts(startDay, startMonth, startYear || endYear);
	let checkoutISO = buildFutureIsoDateFromParts(endDay, endMonth, endYear || startYear);
	if (!checkinISO || !checkoutISO) return null;
	if (checkoutISO <= checkinISO) {
		const checkout = new Date(`${checkoutISO}T00:00:00Z`);
		checkout.setUTCMonth(checkout.getUTCMonth() + 1);
		checkoutISO = checkout.toISOString().slice(0, 10);
	}
	return {
		checkinISO,
		checkoutISO,
		raw: {
			checkin: `${startMonthText} ${startDay}`,
			checkout: `${endMonthText} ${endDay}`,
			calendar: "gregorian",
		},
	};
}

function adjustCheckoutAfterCheckin(checkoutISO = "", checkinISO = "") {
	if (!checkoutISO || !checkinISO || checkoutISO > checkinISO) return checkoutISO;
	const checkout = new Date(`${checkoutISO}T00:00:00Z`);
	if (Number.isNaN(checkout.getTime())) return checkoutISO;
	for (let guard = 0; guard < 8 && checkout.toISOString().slice(0, 10) <= checkinISO; guard += 1) {
		checkout.setUTCFullYear(checkout.getUTCFullYear() + 1);
	}
	return checkout.toISOString().slice(0, 10);
}

function extractSingleStayDate(text = "", st = {}) {
	const normalized = digitsToEnglish(String(text || "").toLowerCase());
	const monthToken =
		"(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|[\u0600-\u06ff]+)";
	const singleDateRegex = new RegExp(
		`(?:\\b(?:arrival|arrive|check\\s*-?in|checkout|check\\s*-?out|departure|date)\\b|\\u062a\\u0627\\u0631\\u064a\\u062e|\\u0627\\u0644\\u062f\\u062e\\u0648\\u0644|\\u0627\\u0644\\u0648\\u0635\\u0648\\u0644|\\u0627\\u0644\\u062e\\u0631\\u0648\\u062c|\\u0627\\u0644\\u0645\\u063a\\u0627\\u062f\\u0631\\u0629)?\\s*(\\d{1,2})\\s+${monthToken}(?:\\s*,?\\s*(20\\d{2}))?`,
		"i"
	);
	const match = normalized.match(singleDateRegex);
	if (!match) return { checkinISO: null, checkoutISO: null, raw: null };
	const day = match[1];
	const month = monthNumberFromText(match[2]);
	const year = match[3] || null;
	if (!month) return { checkinISO: null, checkoutISO: null, raw: null };
	const iso = buildFutureIsoDateFromParts(day, month, year);
	if (!iso) return { checkinISO: null, checkoutISO: null, raw: null };
	const matchedText = String(match[0] || "");
	const isCheckout =
		/\b(?:checkout|check\s*-?out|departure)\b/i.test(matchedText) ||
		/(?:\u0627\u0644\u062e\u0631\u0648\u062c|\u0627\u0644\u0645\u063a\u0627\u062f\u0631\u0629)/i.test(
			matchedText
		) ||
		(Boolean(st?.slots?.checkinISO) && !st?.slots?.checkoutISO);
	if (isCheckout) {
		return {
			checkinISO: null,
			checkoutISO: adjustCheckoutAfterCheckin(iso, st?.slots?.checkinISO || ""),
			raw: { checkout: `${day} ${match[2]}`, calendar: "gregorian" },
		};
	}
	return {
		checkinISO: iso,
		checkoutISO: null,
		raw: { checkin: `${day} ${match[2]}`, calendar: "gregorian" },
	};
}

function extractDateRange(text = "") {
	if (!likelyStayDateText(text)) {
		return { checkinISO: null, checkoutISO: null, raw: null };
	}
	const quick = quickDateRange(text);
	if (quick?.checkinISO && quick?.checkoutISO) {
		return quick;
	}
	const sameMonthRange = parseSameMonthDateRange(text);
	if (sameMonthRange?.checkinISO && sameMonthRange?.checkoutISO) {
		return sameMonthRange;
	}
	const monthFirstRange = parseMonthFirstDateRange(text);
	if (monthFirstRange?.checkinISO && monthFirstRange?.checkoutISO) {
		return monthFirstRange;
	}
	const raw = String(text || "");
	const isoMatches = raw.match(/\b20\d{2}-\d{2}-\d{2}\b/g);
	if (isoMatches && isoMatches.length >= 2) {
		return { checkinISO: isoMatches[0], checkoutISO: isoMatches[1] };
	}
	const monthPattern =
		"(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
	const regex = new RegExp(
		`${monthPattern}\\s+\\d{1,2}(?:,)?\\s+20\\d{2}`,
		"gi"
	);
	const matches = raw.match(regex);
	if (matches && matches.length >= 2) {
		return {
			checkinISO: isoDate(matches[0]),
			checkoutISO: isoDate(matches[1]),
		};
	}
	return { checkinISO: null, checkoutISO: null };
}

function todayISODate() {
	return new Date().toISOString().slice(0, 10);
}

function isPastDateISO(iso = "") {
	return /^\d{4}-\d{2}-\d{2}$/.test(String(iso || "")) && iso < todayISODate();
}

function explicitGregorianYearInDateInput(text = "", dates = {}) {
	const raw = [
		text,
		dates?.raw?.checkin || "",
		dates?.raw?.checkout || "",
		dates?.checkinISO || "",
		dates?.checkoutISO || "",
	]
		.filter(Boolean)
		.join(" ");
	const normalized = digitsToEnglish(raw);
	return /\b20\d{2}\b/.test(normalized);
}

function futureSameMonthDayRange(dates = {}) {
	if (!dates?.checkinISO || !dates?.checkoutISO) return null;
	let checkin = new Date(`${dates.checkinISO}T00:00:00Z`);
	let checkout = new Date(`${dates.checkoutISO}T00:00:00Z`);
	if (Number.isNaN(checkin.getTime()) || Number.isNaN(checkout.getTime())) {
		return null;
	}
	for (let guard = 0; guard < 8 && checkin.toISOString().slice(0, 10) < todayISODate(); guard += 1) {
		checkin.setUTCFullYear(checkin.getUTCFullYear() + 1);
		checkout.setUTCFullYear(checkout.getUTCFullYear() + 1);
	}
	return {
		checkinISO: checkin.toISOString().slice(0, 10),
		checkoutISO: checkout.toISOString().slice(0, 10),
	};
}

function needsExplicitPastDateClarification(text = "", dates = {}) {
	if (!dates?.checkinISO || !dates?.checkoutISO) return false;
	if (dates?.raw?.calendar === "hijri" || dates?.raw?.checkinHijri) return false;
	if (!explicitGregorianYearInDateInput(text, dates)) return false;
	return dates?.reason === "past_explicit_year" || isPastDateISO(dates.checkinISO);
}

function roomTypeLabel(roomTypeKey = "") {
	if (roomTypeKey === "singleRooms") return "single room";
	if (roomTypeKey === "doubleRooms") return "double room";
	if (roomTypeKey === "tripleRooms") return "triple room";
	if (roomTypeKey === "quadRooms") return "quad room";
	if (roomTypeKey === "familyRooms") return "family room";
	return "selected room";
}

function localizedRoomTypeLabel(roomTypeKey = "", lang = "English") {
	if (/arabic/i.test(lang)) {
		if (roomTypeKey === "singleRooms") return "\u063a\u0631\u0641\u0629 \u0641\u0631\u062f\u064a\u0629";
		if (roomTypeKey === "doubleRooms") return "\u063a\u0631\u0641\u0629 \u0645\u0632\u062f\u0648\u062c\u0629";
		if (roomTypeKey === "tripleRooms") return "\u063a\u0631\u0641\u0629 \u062b\u0644\u0627\u062b\u064a\u0629";
		if (roomTypeKey === "quadRooms") return "\u063a\u0631\u0641\u0629 \u0631\u0628\u0627\u0639\u064a\u0629";
		if (roomTypeKey === "familyRooms") return "\u063a\u0631\u0641\u0629 \u0639\u0627\u0626\u0644\u064a\u0629";
		return "\u0627\u0644\u063a\u0631\u0641\u0629 \u0627\u0644\u0645\u0637\u0644\u0648\u0628\u0629";
	}
	if (/spanish/i.test(lang)) {
		if (roomTypeKey === "singleRooms") return "habitacion individual";
		if (roomTypeKey === "doubleRooms") return "habitacion doble";
		if (roomTypeKey === "tripleRooms") return "habitacion triple";
		if (roomTypeKey === "quadRooms") return "habitacion cuadruple";
		if (roomTypeKey === "familyRooms") return "habitacion familiar";
		return "habitacion solicitada";
	}
	if (/french/i.test(lang)) {
		if (roomTypeKey === "singleRooms") return "chambre simple";
		if (roomTypeKey === "doubleRooms") return "chambre double";
		if (roomTypeKey === "tripleRooms") return "chambre triple";
		if (roomTypeKey === "quadRooms") return "chambre quadruple";
		if (roomTypeKey === "familyRooms") return "chambre familiale";
		return "chambre demandee";
	}
	return roomTypeLabel(roomTypeKey);
}

function cleanCurrency(value) {
	return String(value || "SAR").toUpperCase();
}

const safeNum = (value, fallback = 0) => {
	const number = parseFloat(value);
	return Number.isFinite(number) ? number : fallback;
};

function safeAddDays(iso, days) {
	const date = new Date(`${iso}T00:00:00Z`);
	if (Number.isNaN(date.getTime())) return null;
	date.setUTCDate(date.getUTCDate() + days);
	return date.toISOString().slice(0, 10);
}

function safeStayDates(checkinISO, checkoutISO, maxNights = 60) {
	if (!checkinISO || !checkoutISO || checkinISO >= checkoutISO) return null;
	const dates = [];
	let current = checkinISO;
	for (let guard = 0; current < checkoutISO && guard < maxNights; guard += 1) {
		dates.push(current);
		current = safeAddDays(current, 1);
		if (!current) return null;
	}
	if (!dates.length || current < checkoutISO) return null;
	return dates;
}

function safeCommissionRate(hotel = {}, room = {}) {
	const hotelCommission =
		hotel.commission !== null && hotel.commission !== undefined && hotel.commission !== ""
			? safeNum(hotel.commission, 10)
			: 10;
	const fallback = hotelCommission >= 0 ? hotelCommission : 10;
	const roomCommission =
		room.roomCommission !== null &&
		room.roomCommission !== undefined &&
		room.roomCommission !== ""
			? safeNum(room.roomCommission, fallback)
			: fallback;
	return roomCommission >= 0 ? roomCommission : fallback;
}

function safePriceRoomForStay(hotel, { roomType }, checkinISO, checkoutISO) {
	const rooms = Array.isArray(hotel?.roomCountDetails)
		? hotel.roomCountDetails
		: [];
	const room = rooms.find((item) => item?.roomType === roomType);
	if (!room) {
		return {
			available: false,
			reason: "room_not_found",
			currency: hotel?.currency || "SAR",
			room: null,
		};
	}
	const dates = safeStayDates(checkinISO, checkoutISO);
	if (!dates) {
		return {
			available: false,
			reason: "bad_dates",
			currency: hotel?.currency || "SAR",
			room,
		};
	}

	const basePrice = safeNum(room?.price?.basePrice, 0);
	const defaultCost = safeNum(room?.defaultCost, 0);
	const commissionRate = safeCommissionRate(hotel, room);
	const rateMap = new Map();
	const pricingRates = Array.isArray(room.pricingRate) ? room.pricingRate : [];
	for (const rate of pricingRates.slice(0, 10000)) {
		if (!rate?.calendarDate) continue;
		rateMap.set(String(rate.calendarDate).slice(0, 10), rate);
	}

	const pricingByDay = [];
	const perNight = [];
	for (const date of dates) {
		const rate = rateMap.get(date);
		const dayPrice = rate ? safeNum(rate.price, basePrice) : basePrice;
		const dayRoot = rate ? safeNum(rate.rootPrice, defaultCost) : defaultCost;
		const dayComm = rate
			? safeNum(rate.commissionRate, commissionRate)
			: commissionRate;
		if (rate && (safeNum(rate.price, 0) === 0 || safeNum(rate.rootPrice, 0) === 0)) {
			return {
				available: false,
				reason: "blocked",
				currency: hotel?.currency || "SAR",
				room,
				nights: dates.length,
			};
		}
		const final = dayPrice + dayRoot * (dayComm / 100);
		pricingByDay.push({
			date,
			price: Number(dayPrice.toFixed(2)),
			rootPrice: Number(dayRoot.toFixed(2)),
			commissionRate: Number(dayComm.toFixed(2)),
			totalPriceWithCommission: Number(final.toFixed(2)),
			totalPriceWithoutCommission: Number(dayPrice.toFixed(2)),
		});
		perNight.push(Number(final.toFixed(2)));
	}

	const totalWithComm = pricingByDay.reduce(
		(total, row) => total + safeNum(row.totalPriceWithCommission, 0),
		0
	);
	const hotelShouldGet = pricingByDay.reduce(
		(total, row) => total + safeNum(row.rootPrice, 0),
		0
	);
	const totalCommission = Number((totalWithComm - hotelShouldGet).toFixed(2));
	return {
		available: true,
		reason: null,
		room,
		nights: dates.length,
		currency: hotel?.currency || "SAR",
		pricingByDay,
		perNight,
		totals: {
			totalPriceWithCommission: Number(totalWithComm.toFixed(2)),
			hotelShouldGet: Number(hotelShouldGet.toFixed(2)),
			totalCommission,
		},
	};
}

const ROOM_TYPE_RECOVERY_ORDER = {
	singleRooms: ["doubleRooms", "tripleRooms", "quadRooms", "familyRooms"],
	doubleRooms: ["tripleRooms", "quadRooms", "familyRooms", "singleRooms"],
	tripleRooms: ["quadRooms", "familyRooms", "doubleRooms", "singleRooms"],
	quadRooms: ["familyRooms", "tripleRooms", "doubleRooms", "singleRooms"],
	familyRooms: ["quadRooms", "tripleRooms", "doubleRooms", "singleRooms"],
};

function roomRecoveryRank(requestedRoomType = "", candidateRoomType = "") {
	const preferred = ROOM_TYPE_RECOVERY_ORDER[requestedRoomType] || [];
	const index = preferred.indexOf(candidateRoomType);
	return index >= 0 ? index : 99;
}

function bestSameStayRoomRecoveryOption(st = {}) {
	if (!st.hotel || !st.slots?.checkinISO || !st.slots?.checkoutISO) return null;
	const requestedRoomType = st.slots.roomTypeKey || "";
	const options = listAvailableRoomsForStay(
		st.hotel,
		st.slots.checkinISO,
		st.slots.checkoutISO
	)
		.filter((option) => option.available && option.room?.roomType !== requestedRoomType)
		.map((option) => ({
			kind: "same_dates_room_type",
			roomTypeKey: option.room?.roomType || "",
			checkinISO: st.slots.checkinISO,
			checkoutISO: st.slots.checkoutISO,
			quote: {
				available: true,
				reason: null,
				room: option.room,
				nights: option.nights,
				currency: option.currency,
				totals: option.totals,
			},
			rank: roomRecoveryRank(requestedRoomType, option.room?.roomType || ""),
			total: safeNum(option?.totals?.totalPriceWithCommission, Number.MAX_SAFE_INTEGER),
		}))
		.filter((option) => option.roomTypeKey);
	options.sort((a, b) => a.rank - b.rank || a.total - b.total);
	return options[0] || null;
}

function bestCloseDateRoomRecoveryOption(st = {}) {
	if (!st.hotel || !st.slots?.roomTypeKey || !st.slots?.checkinISO || !st.slots?.checkoutISO) {
		return null;
	}
	const stayDates = safeStayDates(st.slots.checkinISO, st.slots.checkoutISO);
	if (!stayDates?.length) return null;
	const offsets = [];
	for (let days = 1; days <= 7; days += 1) {
		offsets.push(days, -days);
	}
	for (const offset of offsets) {
		const checkinISO = safeAddDays(st.slots.checkinISO, offset);
		const checkoutISO = safeAddDays(st.slots.checkoutISO, offset);
		if (!checkinISO || !checkoutISO || checkinISO < todayISODate()) continue;
		const quote = safePriceRoomForStay(
			st.hotel,
			{ roomType: st.slots.roomTypeKey },
			checkinISO,
			checkoutISO
		);
		if (quote.available) {
			return {
				kind: "same_room_close_dates",
				roomTypeKey: st.slots.roomTypeKey,
				checkinISO,
				checkoutISO,
				quote,
				offset,
			};
		}
	}
	return null;
}

function bestRoomRecoveryOption(st = {}) {
	return bestSameStayRoomRecoveryOption(st) || bestCloseDateRoomRecoveryOption(st);
}

function localizedDateRangeText(checkinISO = "", checkoutISO = "", lang = "English") {
	const checkin = localizedGregorianDate(checkinISO, lang);
	const checkout = localizedGregorianDate(checkoutISO, lang);
	if (!checkin || !checkout) return "";
	if (/arabic/i.test(lang)) return `${checkin} \u2013 ${checkout}`;
	if (/spanish/i.test(lang)) return `${checkin} al ${checkout}`;
	if (/french/i.test(lang)) return `du ${checkin} au ${checkout}`;
	return `${checkin} to ${checkout}`;
}

function roomRecoveryPendingPayload(option = {}) {
	if (!option?.roomTypeKey || !option?.checkinISO || !option?.checkoutISO) {
		return null;
	}
	return {
		kind: option.kind || "room_recovery",
		roomTypeKey: option.roomTypeKey,
		checkinISO: option.checkinISO,
		checkoutISO: option.checkoutISO,
		offeredAt: now(),
	};
}

function clearPendingRoomAlternative(st = {}) {
	st.pendingRoomAlternative = null;
}

function roomRecoveryOfferText(sc = {}, st = {}, quote = {}, option = null) {
	const lang = languageOf(sc, st);
	const name = respectfulGuestName(sc, st);
	const hotelName = localizedHotelName(sc, st);
	const requestedRoom = localizedRoomTypeLabel(st.slots?.roomTypeKey, lang);
	const requestedDates = localizedDateRangeText(
		st.slots?.checkinISO,
		st.slots?.checkoutISO,
		lang
	);
	if (!option) {
		if (/arabic/i.test(lang)) {
			return `${name}\u060c \u0644\u0627 \u0623\u0631\u0649 \u062a\u0648\u0641\u0631\u0627 \u0628\u0633\u0639\u0631 \u0645\u0624\u0643\u062f \u0644\u0640 ${requestedRoom} \u0641\u064a ${hotelName} \u0644\u0644\u062a\u0648\u0627\u0631\u064a\u062e ${requestedDates}\u060c \u0648\u0644\u0627 \u0623\u0631\u0649 \u062e\u064a\u0627\u0631\u0627 \u0642\u0631\u064a\u0628\u0627 \u0645\u062a\u0627\u062d\u0627 \u0627\u0644\u0622\u0646. \u0623\u0631\u0633\u0644 \u0644\u064a \u062a\u0648\u0627\u0631\u064a\u062e \u0642\u0631\u064a\u0628\u0629 \u0623\u0648 \u0646\u0648\u0639 \u063a\u0631\u0641\u0629 \u0622\u062e\u0631 \u0648\u0633\u0623\u0631\u0627\u062c\u0639\u0647 \u0644\u0643 \u0641\u0648\u0631\u0627.`;
		}
		if (/spanish/i.test(lang)) {
			return `${name}, no veo disponibilidad con precio confirmado para la ${requestedRoom} en ${hotelName} para ${requestedDates}, y no veo ahora una opcion cercana disponible. Enviame fechas cercanas u otro tipo de habitacion y lo reviso enseguida.`;
		}
		if (/french/i.test(lang)) {
			return `${name}, je ne vois pas de disponibilite avec prix confirme pour la ${requestedRoom} a ${hotelName} pour ${requestedDates}, et je ne vois pas d'option proche disponible maintenant. Envoyez-moi des dates proches ou un autre type de chambre et je verifierai tout de suite.`;
		}
		return `${name}, I do not see priced availability for the ${requestedRoom} at ${hotelName} for ${requestedDates}, and I do not see a close available recovery option right now. Send me one nearby date range or another room type and I will check it right away.`;
	}
	const optionRoomName = localizedRoomName(sc, st, option.quote);
	const optionDates = localizedDateRangeText(option.checkinISO, option.checkoutISO, lang);
	const total = option.quote?.totals?.totalPriceWithCommission;
	const totalText = total ? localizedMoney(total, option.quote.currency, lang) : "";
	if (option.kind === "same_dates_room_type") {
		if (/arabic/i.test(lang)) {
			const price = totalText ? ` \u0628\u0625\u062c\u0645\u0627\u0644\u064a ${totalText}` : "";
			return `${name}\u060c \u0644\u0627 \u0623\u0631\u0649 \u062a\u0648\u0641\u0631\u0627 \u0628\u0633\u0639\u0631 \u0645\u0624\u0643\u062f \u0644\u0640 ${requestedRoom} \u0641\u064a ${hotelName} \u0644\u0644\u062a\u0648\u0627\u0631\u064a\u062e ${requestedDates}. \u0627\u0644\u062e\u0628\u0631 \u0627\u0644\u062c\u064a\u062f \u0623\u0646 ${optionRoomName} \u0645\u062a\u0627\u062d\u0629 \u0644\u0646\u0641\u0633 \u0627\u0644\u062a\u0648\u0627\u0631\u064a\u062e${price}\u060c \u0648\u062a\u0645\u0646\u062d\u0643 \u0645\u0633\u0627\u062d\u0629 \u0623\u0648\u0633\u0639 \u0645\u0639 \u0646\u0641\u0633 \u0627\u0644\u0625\u0642\u0627\u0645\u0629. \u0647\u0644 \u0623\u062d\u0636\u0631 \u0644\u0643 \u0647\u0630\u0627 \u0627\u0644\u062e\u064a\u0627\u0631\u061f`;
		}
		if (/spanish/i.test(lang)) {
			const price = totalText ? ` por un total de ${totalText}` : "";
			return `${name}, no veo disponibilidad con precio confirmado para la ${requestedRoom} en ${hotelName} para ${requestedDates}. La buena noticia es que ${optionRoomName} esta disponible para las mismas fechas${price}; te da mas espacio y mantiene la misma estancia. Quieres que prepare esta opcion?`;
		}
		if (/french/i.test(lang)) {
			const price = totalText ? ` pour un total de ${totalText}` : "";
			return `${name}, je ne vois pas de disponibilite avec prix confirme pour la ${requestedRoom} a ${hotelName} pour ${requestedDates}. La bonne nouvelle: ${optionRoomName} est disponible aux memes dates${price}; cela vous donne plus d'espace tout en gardant le meme sejour. Souhaitez-vous que je prepare cette option ?`;
		}
		const price = totalText ? ` at ${totalText} total` : "";
		return `${name}, I do not see priced availability for the ${requestedRoom} at ${hotelName} for ${requestedDates}. The good news is ${optionRoomName} is available for the same dates${price}; it gives you more space and keeps your stay dates unchanged. Would you like me to prepare this option instead?`;
	}
	if (/arabic/i.test(lang)) {
		const price = totalText ? ` \u0628\u0625\u062c\u0645\u0627\u0644\u064a ${totalText}` : "";
		return `${name}\u060c \u0644\u0627 \u0623\u0631\u0649 \u062a\u0648\u0641\u0631\u0627 \u0628\u0633\u0639\u0631 \u0645\u0624\u0643\u062f \u0644\u0640 ${requestedRoom} \u0641\u064a ${hotelName} \u0644\u0644\u062a\u0648\u0627\u0631\u064a\u062e ${requestedDates}\u060c \u0648\u0644\u0627 \u0623\u0631\u0649 \u0646\u0648\u0639 \u063a\u0631\u0641\u0629 \u0622\u062e\u0631 \u0645\u062a\u0627\u062d\u0627 \u0644\u0646\u0641\u0633 \u0627\u0644\u062a\u0648\u0627\u0631\u064a\u062e. \u0623\u0642\u0631\u0628 \u062e\u064a\u0627\u0631 \u0648\u062c\u062f\u062a\u0647 \u0647\u0648 ${optionRoomName} \u0645\u0646 ${optionDates}${price}. \u0647\u0644 \u0623\u0631\u0627\u062c\u0639 \u0647\u0630\u0647 \u0627\u0644\u062a\u0648\u0627\u0631\u064a\u062e \u0644\u0643\u061f`;
	}
	if (/spanish/i.test(lang)) {
		const price = totalText ? ` por un total de ${totalText}` : "";
		return `${name}, no veo disponibilidad con precio confirmado para la ${requestedRoom} en ${hotelName} para ${requestedDates}, y no veo otro tipo de habitacion abierto para esas mismas fechas. La opcion cercana que encontre es ${optionRoomName} del ${optionDates}${price}. Quieres que revise esta fecha?`;
	}
	if (/french/i.test(lang)) {
		const price = totalText ? ` pour un total de ${totalText}` : "";
		return `${name}, je ne vois pas de disponibilite avec prix confirme pour la ${requestedRoom} a ${hotelName} pour ${requestedDates}, et je ne vois pas d'autre type de chambre disponible aux memes dates. L'option proche que j'ai trouvee est ${optionRoomName} ${optionDates}${price}. Souhaitez-vous que je verifie cette date ?`;
	}
	const price = totalText ? ` at ${totalText} total` : "";
	return `${name}, I do not see priced availability for the ${requestedRoom} at ${hotelName} for ${requestedDates}, and I do not see another room type open for those same dates. The closest option I found is ${optionRoomName} from ${optionDates}${price}. Would you like me to check this date instead?`;
}

function roomRecoveryDeclineText(sc = {}, st = {}) {
	const lang = languageOf(sc, st);
	const name = respectfulGuestName(sc, st);
	if (/arabic/i.test(lang)) {
		return `${name}\u060c \u062a\u0645\u0627\u0645. \u0623\u0631\u0633\u0644 \u0644\u064a \u0646\u0648\u0639 \u063a\u0631\u0641\u0629 \u0622\u062e\u0631 \u0623\u0648 \u062a\u0648\u0627\u0631\u064a\u062e \u0642\u0631\u064a\u0628\u0629 \u0648\u0633\u0623\u0631\u0627\u062c\u0639 \u0623\u0641\u0636\u0644 \u062d\u0644 \u0644\u0643.`;
	}
	if (/spanish/i.test(lang)) {
		return `${name}, perfecto. Enviame otro tipo de habitacion o fechas cercanas y reviso la mejor solucion para ti.`;
	}
	if (/french/i.test(lang)) {
		return `${name}, tres bien. Envoyez-moi un autre type de chambre ou des dates proches et je verifierai la meilleure solution pour vous.`;
	}
	return `${name}, no problem. Send me another room type or nearby dates and I will check the best solution for you.`;
}

function simpleQuoteText({ sc, st, quote }) {
	const name = firstNameForAddress(
		st.slots?.name || st.slots?.fullName || sc.displayName1 || "Guest"
	);
	const lang = languageOf(sc, st);
	const hotelName = localizedHotelName(sc, st);
	const roomName = localizedRoomName(sc, st, quote);
	if (/arabic/i.test(lang)) {
		if (!quote.available) {
			return `\u0623\u0633\u062a\u0627\u0630 ${name}\u060c \u0644\u0627 \u0623\u0631\u0649 \u062a\u0648\u0641\u0631\u0627 \u0628\u0633\u0639\u0631 \u0645\u0624\u0643\u062f \u0644\u0640 ${roomName} \u0641\u064a ${hotelName} \u0644\u0647\u0630\u0647 \u0627\u0644\u062a\u0648\u0627\u0631\u064a\u062e. \u0623\u0642\u062f\u0631 \u0623\u0631\u0627\u062c\u0639 \u062a\u0648\u0627\u0631\u064a\u062e \u0623\u062e\u0631\u0649 \u0623\u0648 \u0646\u0648\u0639 \u063a\u0631\u0641\u0629 \u0622\u062e\u0631.`;
		}
		return `\u0623\u0633\u062a\u0627\u0630 ${name}\u060c ${roomName} \u0641\u064a ${hotelName} \u0628\u0625\u062c\u0645\u0627\u0644\u064a ${localizedMoney(
			quote.totals.totalPriceWithCommission,
			quote.currency,
			"Arabic"
		)} \u0644\u0645\u062f\u0629 ${localizedNumber(
			quote.nights,
			"Arabic"
		)} \u0644\u064a\u0627\u0644\u064a. \u0647\u0644 \u062a\u0631\u063a\u0628 \u0623\u0646 \u0623\u062a\u0627\u0628\u0639 \u0644\u0645\u0631\u0627\u062c\u0639\u0629 \u0627\u0644\u062d\u062c\u0632\u061f`;
	}
	if (!quote.available) {
		return `${name}, I do not see priced availability for ${roomName} at ${hotelName} on those dates. I can check another date range or another room type at ${hotelName}.`;
	}
	return `${name}, ${roomName} at ${hotelName} is ${quote.totals.totalPriceWithCommission} ${cleanCurrency(
		quote.currency
	)} total for ${quote.nights} nights. Would you like me to continue with the reservation details?`;
}

function crossHotelRequestText(text = "") {
	const { lower, arabic, latinCompact } = normalizeControlText(text);
	return (
		/\b(other|another|different|alternative|nearby|compare|recommend|suggest|best|cheaper)\s+(?:hotel|hotels|property|properties)\b/i.test(
			lower
		) ||
		/\b(?:hotel|hotels|property|properties)\s+(?:nearby|alternative|alternatives|recommendation|recommendations|suggestion|suggestions|comparison)\b/i.test(
			lower
		) ||
		/(?:فنادق\s+(?:اخرى|أخرى|قريبه|قريبة|بديله|بديلة)|فندق\s+(?:اخر|آخر|ثاني|تاني|بديل)|رشح\s+فندق|اقترح\s+فندق|قارن\s+الفنادق)/i.test(
			arabic
		) ||
		/(?:otherhotel|otherhotels|anotherhotel|nearbyhotel|nearbyhotels|alternativehotel|alternativehotels|recommendhotel|suggesthotel|comparehotels|fondo2tany|fonde2tany|fandokakhar|fanadokokhra)/i.test(
			latinCompact
		)
	);
}

function selectedHotelOnlyReply(sc = {}, st = {}, userText = "") {
	const hotelName = toTitle(st.hotel?.hotelName || "this hotel");
	const name = respectfulGuestName(sc, st);
	const lang = languageOf(sc, st);
	if (/arabic/i.test(lang)) {
		return `${name}، أقدر أساعدك هنا بخصوص ${hotelName} فقط. إذا تحب، أراجع لك التوفر أو نوع غرفة أو تواريخ مختلفة في ${hotelName}.`;
	}
	if (/spanish/i.test(lang)) {
		return `${name}, en este chat solo puedo ayudarte con ${hotelName}. Puedo revisar disponibilidad, otro tipo de habitacion o fechas diferentes en ${hotelName}.`;
	}
	if (/french/i.test(lang)) {
		return `${name}, dans ce chat je peux uniquement vous aider pour ${hotelName}. Je peux verifier la disponibilite, un autre type de chambre ou d'autres dates pour ${hotelName}.`;
	}
	if (/urdu/i.test(lang)) {
		return `${name}، اس چیٹ میں میں صرف ${hotelName} کے بارے میں مدد کر سکتا ہوں۔ چاہیں تو میں ${hotelName} میں دستیابی، دوسرے کمرے کی قسم، یا مختلف تاریخیں چیک کر سکتا ہوں۔`;
	}
	if (/hindi/i.test(lang)) {
		return `${name}, इस चैट में मैं सिर्फ ${hotelName} के लिए मदद कर सकता हूं। चाहें तो मैं ${hotelName} में उपलब्धता, दूसरे कमरे का प्रकार, या अलग तारीखें देख सकता हूं।`;
	}
	return `${name}, I can help with ${hotelName} only in this chat. I can check availability, another room type, or different dates at ${hotelName}.`;
}

function selectedHotelSupportBoundaryReply(sc = {}, st = {}) {
	const hotelName = localizedHotelName(sc, st);
	const name = respectfulGuestName(sc, st);
	const lang = languageOf(sc, st);
	if (/arabic/i.test(lang)) {
		return `${name}\u060c \u0623\u0642\u062f\u0631 \u0623\u0633\u0627\u0639\u062f\u0643 \u0647\u0646\u0627 \u0628\u062e\u0635\u0648\u0635 ${hotelName} \u0641\u0642\u0637\u060c \u0648\u0644\u0627 \u0623\u0645\u0644\u0643 \u062a\u0641\u0627\u0635\u064a\u0644\u0627 \u0645\u0624\u0643\u062f\u0629 \u0639\u0646 \u0641\u0646\u0627\u062f\u0642 \u0623\u062e\u0631\u0649 \u0645\u0646 \u0647\u0630\u0647 \u0627\u0644\u062f\u0631\u062f\u0634\u0629. ${unsupportedAnswerNextStepText(sc, st)}`;
	}
	if (/spanish/i.test(lang)) {
		return `${name}, en este chat solo puedo ayudarte con ${hotelName}; no tengo detalles verificados sobre otros hoteles desde este soporte. ${unsupportedAnswerNextStepText(sc, st)}`;
	}
	if (/french/i.test(lang)) {
		return `${name}, dans ce chat je peux uniquement vous aider pour ${hotelName}; je n'ai pas d'informations verifiees sur d'autres hotels ici. ${unsupportedAnswerNextStepText(sc, st)}`;
	}
	return `${name}, I can help with ${hotelName} only in this chat, and I do not have verified details about other hotels from here. ${unsupportedAnswerNextStepText(sc, st)}`;
}

function initialHotelGreetingText(sc = {}, st = {}) {
	const name = respectfulGuestName(sc, st);
	const hotelName = toTitle(st.hotel?.hotelName || sc.displayName2 || "the hotel");
	const agentName = st.agentName || "Sara";
	const lang = languageOf(sc, st);
	const opening = islamicGreetingForLanguage(sc, st);
	if (/arabic/i.test(lang)) {
		return `${opening} ${name}\u060c \u0645\u0639\u0643 ${agentName} \u0645\u0646 \u0627\u0633\u062a\u0642\u0628\u0627\u0644 \u0648\u062d\u062c\u0648\u0632\u0627\u062a ${hotelName}. \u0643\u064a\u0641 \u0623\u0642\u062f\u0631 \u0623\u0633\u0627\u0639\u062f\u0643 \u0627\u0644\u064a\u0648\u0645\u061f`;
	}
	if (/spanish/i.test(lang)) {
		return `${opening} ${name}, soy ${agentName} de recepcion y reservas de ${hotelName}. Como puedo ayudarte hoy?`;
	}
	if (/french/i.test(lang)) {
		return `${opening} ${name}, je suis ${agentName}, reception et reservations de ${hotelName}. Comment puis-je vous aider aujourd'hui ?`;
	}
	if (/urdu/i.test(lang)) {
		return `${opening} ${name}\u060c \u0645\u06cc\u06ba ${agentName}\u060c ${hotelName} reception and reservations \u0633\u06d2 \u06c1\u0648\u06ba\u06d4 \u0645\u06cc\u06ba \u0622\u067e \u06a9\u06cc \u06a9\u06cc\u0633\u06d2 \u0645\u062f\u062f \u06a9\u0631 \u0633\u06a9\u062a\u0627 \u06c1\u0648\u06ba\u061f`;
	}
	if (/hindi/i.test(lang)) {
		return `${opening} ${name}, \u092e\u0948\u0902 ${agentName}, ${hotelName} \u0930\u093f\u0938\u0947\u092a\u094d\u0936\u0928 \u0914\u0930 \u0930\u093f\u091c\u0930\u094d\u0935\u0947\u0936\u0928\u094d\u0938 \u0938\u0947 \u0939\u0942\u0902\u0964 \u092e\u0948\u0902 \u0906\u092a\u0915\u0940 \u0915\u093f\u0938 \u0924\u0930\u0939 \u092e\u0926\u0926 \u0915\u0930\u0942\u0902?`;
	}
	if (/indonesian/i.test(lang)) {
		return `${opening} ${name}, saya ${agentName} dari resepsionis dan reservasi ${hotelName}. Bagaimana saya bisa membantu hari ini?`;
	}
	if (/malay/i.test(lang)) {
		return `${opening} ${name}, saya ${agentName} dari penerimaan dan tempahan ${hotelName}. Bagaimana saya boleh membantu hari ini?`;
	}
	return `${opening} ${name}, this is ${agentName} from ${hotelName} reception and reservations. How can I help you today?`;
}

function hotelComplaintText(text = "") {
	const { lower, arabic, latinCompact } = normalizeControlText(text);
	return (
		/\b(complain|complaint|bad experience|terrible|unsafe|dirty|unclean|rude|mistreat|overcharg|fraud|scam|not as described|no one helped|hotel problem|hotel issue|manager|staff issue)\b/i.test(
			lower
		) ||
		/(?:شكوى|اشتك|مشكلة|سيئ|وسخ|غير\s+نظيف|مو\s+نظيف|غير\s+آمن|نصب|احتيال|تعامل\s+سيئ|موظف\s+سيئ|ادارة\s+الفندق|إدارة\s+الفندق)/i.test(
			arabic
		) ||
		/(?:complain|complaint|badexperience|terrible|dirty|unclean|rude|scam|fraud|hotelproblem|hotelissue|shakwa|shakwaya|moshkela|mushkila|wese5|wasikh|naseb)/i.test(
			latinCompact
		)
	);
}

function jannatReservationHotelRedirectIntent(text = "", lu = {}, sc = {}) {
	return (
		looksLikeReservationDateUpdate(text, lu) ||
		wantsPaymentHelp(text) ||
		(explicitlyExistingReservationIntent(text) && wantsReservationHelp(text)) ||
		(Boolean(latestKnownConfirmation(sc, lu)) && wantsReservationHelp(text))
	);
}

function budgetFromText(text = "") {
	const normalized = digitsToEnglish(String(text || "").toLowerCase());
	const matches = [...normalized.matchAll(/(?:budget|around|about|max|maximum|under|up to|less than|below|حدود|ميزانية|ميزانيتي|اقصى|أقصى|تحت)?\s*(\d{2,6})(?:\s*(?:sar|riyal|riyal|ريال))?/gi)]
		.map((match) => Number(match[1]))
		.filter((value) => Number.isFinite(value) && value >= 50);
	if (!matches.length) return null;
	return Math.max(...matches);
}

function sameId(a, b) {
	const left = idText(a);
	const right = idText(b);
	return Boolean(left && right && left === right);
}

function platformOptionLine(option = {}, index = 0, hasDates = false) {
	const number = index + 1;
	const room = option.roomLabel || roomTypeLabel(option.roomTypeKey || "");
	const total =
		hasDates && Number(option.total || 0) > 0
			? ` - ${option.total} ${cleanCurrency(option.currency)} total for ${option.nights || "the stay"} nights`
			: "";
	const distance = [option.walking, option.driving].filter(Boolean).join(", ");
	return `${number}. ${option.hotelName} - ${room}${total}${
		distance ? ` - ${distance}` : ""
	}`;
}

function platformHotelOptionsFallbackText(sc = {}, st = {}, options = [], hasDates = false) {
	const lang = languageOf(sc, st);
	const name = respectfulGuestName(sc, st);
	if (!options.length) {
		if (/arabic/i.test(lang)) {
			return `${name}، لا أرى خيارات مناسبة متاحة الآن حسب التفاصيل الحالية. أرسل تواريخ أو ميزانية مختلفة وسأراجع لك أقرب خيارات مناسبة.`;
		}
		if (/spanish/i.test(lang)) {
			return `${name}, no veo opciones adecuadas disponibles ahora con esos detalles. Enviame otras fechas o presupuesto y reviso las mejores alternativas cercanas.`;
		}
		if (/french/i.test(lang)) {
			return `${name}, je ne vois pas d'options adaptees disponibles avec ces details. Envoyez d'autres dates ou un budget different et je verifierai les meilleures options proches.`;
		}
		return `${name}, I do not see a suitable available option with the current details. Send different dates or budget and I will check the closest good options.`;
	}
	const lines = options
		.slice(0, 4)
		.map((option, index) => platformOptionLine(option, index, hasDates));
	if (/arabic/i.test(lang)) {
		return [
			`${name}\u060c \u0647\u0630\u0647 \u0623\u0641\u0636\u0644 \u0627\u0644\u062e\u064a\u0627\u0631\u0627\u062a \u0627\u0644\u062a\u064a \u0648\u062c\u062f\u062a\u0647\u0627 \u0644\u0643:`,
			...lines,
			"\u062f\u0639\u0645 Jannat Booking \u064a\u0633\u0627\u0639\u062f\u0643 \u0641\u064a \u0627\u0644\u0645\u0642\u0627\u0631\u0646\u0629 \u0648\u0627\u0644\u0623\u0633\u0639\u0627\u0631\u060c \u0644\u0643\u0646 \u062a\u0623\u0643\u064a\u062f \u0627\u0644\u062d\u062c\u0632 \u0627\u0644\u0631\u0633\u0645\u064a \u0648\u0631\u0648\u0627\u0628\u0637 \u0627\u0644\u062a\u0641\u0627\u0635\u064a\u0644/\u0627\u0644\u062f\u0641\u0639 \u062a\u062a\u0645 \u0645\u0646 \u062e\u0644\u0627\u0644 \u0627\u0633\u062a\u0642\u0628\u0627\u0644 \u0648\u062d\u062c\u0648\u0632\u0627\u062a \u0627\u0644\u0641\u0646\u062f\u0642 \u0627\u0644\u0645\u062e\u062a\u0627\u0631.",
			"\u0623\u064a \u0641\u0646\u062f\u0642 \u062a\u062d\u0628 \u0623\u0646 \u0623\u0648\u0635\u0644\u0643 \u0628\u0627\u0633\u062a\u0642\u0628\u0627\u0644\u0647 \u0648\u062d\u062c\u0648\u0632\u0627\u062a\u0647\u061f",
		].join("\n");
	}
	if (/arabic/i.test(lang)) {
		return [
			`${name}، هذه أفضل الخيارات التي وجدتها لك:`,
			...lines,
			"دعم جنة بوكينج يساعدك في المقارنة والأسعار، لكن تأكيد الحجز الرسمي وروابط التفاصيل/الدفع تتم من خلال دعم الفندق المختار.",
			"أي فندق تحب أن أوصلك بدعمه؟",
		].join("\n");
	}
	if (/spanish/i.test(lang)) {
		return [
			`${name}, estas son las mejores opciones que encontre para ti:`,
			...lines,
			"Jannat Booking puede ayudarte a comparar opciones y precios, pero la confirmacion oficial y los enlaces de detalles/pago los completa la recepcion y reservas del hotel elegido.",
			"Con que hotel te gustaria que te conecte?",
		].join("\n");
	}
	if (/french/i.test(lang)) {
		return [
			`${name}, voici les meilleures options que j'ai trouvees pour vous :`,
			...lines,
			"Jannat Booking peut vous aider a comparer les options et les prix, mais la confirmation officielle et les liens details/paiement sont traites par la reception et les reservations de l'hotel choisi.",
			"A quel hotel souhaitez-vous que je vous connecte ?",
		].join("\n");
	}
	return [
		`${name}, these are the best options I found for you:`,
		...lines,
		"Jannat Booking can help compare options and pricing, but the official reservation confirmation and details/payment links are completed by the selected hotel's reception and reservations desk.",
		"Which hotel would you like me to connect you with?",
	].join("\n");
}

function ensurePlatformOptionsVisible(reply = "", sc = {}, st = {}, options = [], hasDates = false) {
	const text = String(reply || "").trim();
	if (!options.length) return text || platformHotelOptionsFallbackText(sc, st, options, hasDates);
	const visibleNames = options.filter((option) =>
		text.toLowerCase().includes(String(option.hotelName || "").toLowerCase())
	);
	if (visibleNames.length >= Math.min(2, options.length)) return text;
	return platformHotelOptionsFallbackText(sc, st, options, hasDates);
}

function transferSystemNoticeText(sc = {}, st = {}, { hotelName = "", agentName = "" } = {}) {
	const lang = languageOf(sc, st);
	if (/arabic/i.test(lang)) {
		return `\u062a\u0645 \u062a\u062d\u0648\u064a\u0644 \u0627\u0644\u0645\u062d\u0627\u062f\u062b\u0629 \u0625\u0644\u0649 \u0627\u0633\u062a\u0642\u0628\u0627\u0644 \u0648\u062d\u062c\u0648\u0632\u0627\u062a ${hotelName}. ${agentName || "\u0645\u0645\u062b\u0644 \u0627\u0644\u0641\u0646\u062f\u0642"} \u064a\u0631\u0627\u062c\u0639 \u0627\u0644\u0637\u0644\u0628 \u0627\u0644\u0622\u0646\u060c \u0648\u0633\u064a\u0639\u0648\u062f \u0644\u0643 \u0628\u0639\u062f \u0644\u062d\u0638\u0627\u062a.`;
	}
	if (/spanish/i.test(lang)) {
		return `La conversacion fue transferida a recepcion y reservas de ${hotelName}. ${agentName || "El representante del hotel"} esta revisando tu solicitud y respondera en unos momentos.`;
	}
	if (/french/i.test(lang)) {
		return `La conversation a ete transferee a la reception et aux reservations de ${hotelName}. ${agentName || "Le representant de l'hotel"} examine votre demande et repondra dans quelques instants.`;
	}
	if (/urdu/i.test(lang)) {
		return `This chat has been transferred to ${hotelName} reception and reservations. ${agentName || "The hotel representative"} is reviewing your request and will reply shortly.`;
	}
	if (/hindi/i.test(lang)) {
		return `This chat has been transferred to ${hotelName} reception and reservations. ${agentName || "The hotel representative"} is reviewing your request and will reply shortly.`;
	}
	return `This chat has been transferred to ${hotelName} reception and reservations. ${agentName || "The hotel representative"} is reviewing your request and will reply shortly.`;
}

function hotelHandoffQuoteIntroText(
	sc = {},
	st = {},
	optionOrHotel = {},
	{ hotelName = "", agentName = "" } = {}
) {
	const lang = languageOf(sc, st);
	const name = respectfulGuestName(sc, st);
	const quote = optionOrHotel?.quote || {};
	const total =
		optionOrHotel?.total || quote?.totals?.totalPriceWithCommission || "";
	const currency = cleanCurrency(optionOrHotel?.currency || quote?.currency || "SAR");
	const nights = optionOrHotel?.nights || quote?.nights || "";
	const room =
		optionOrHotel?.roomLabel ||
		quote?.room?.displayName ||
		quote?.room?.roomType ||
		roomTypeLabel(optionOrHotel?.roomTypeKey || st.slots?.roomTypeKey);
	const pricePart = total
		? `${total} ${currency}${nights ? ` total for ${nights} nights` : ""}`
		: "the selected priced option";
	const opening = islamicGreetingForLanguage(sc, st);
	if (/arabic/i.test(lang)) {
		return `${opening} ${name}\u060c \u0645\u0639\u0643 ${agentName} \u0645\u0646 \u0627\u0633\u062a\u0642\u0628\u0627\u0644 \u0648\u062d\u062c\u0648\u0632\u0627\u062a ${hotelName}. \u0648\u0635\u0644\u062a\u0646\u064a \u062a\u0641\u0627\u0635\u064a\u0644 \u0627\u0644\u062e\u064a\u0627\u0631 \u0627\u0644\u0645\u062e\u062a\u0627\u0631: ${room} \u0628\u0633\u0639\u0631 ${pricePart}. \u0647\u0644 \u062a\u0631\u063a\u0628 \u0623\u0646 \u0623\u062a\u0627\u0628\u0639 \u0625\u0644\u0649 \u0645\u0631\u0627\u062c\u0639\u0629 \u0627\u0644\u062d\u062c\u0632 \u0627\u0644\u0631\u0633\u0645\u064a\u0629\u061f`;
	}
	if (/spanish/i.test(lang)) {
		return `${opening} ${name}, soy ${agentName} de recepcion y reservas de ${hotelName}. Ya tengo la opcion seleccionada: ${room}, ${pricePart}. Quieres continuar a la revision oficial de la reserva?`;
	}
	if (/french/i.test(lang)) {
		return `${opening} ${name}, je suis ${agentName}, reception et reservations de ${hotelName}. J'ai bien l'option selectionnee: ${room}, ${pricePart}. Souhaitez-vous continuer vers la verification officielle de la reservation ?`;
	}
	if (/urdu/i.test(lang)) {
		return `${opening} ${name}\u060c \u0645\u06cc\u06ba ${agentName}\u060c ${hotelName} reception and reservations \u0633\u06d2 \u06c1\u0648\u06ba\u06d4 \u0645\u06cc\u0631\u06d2 \u067e\u0627\u0633 \u0622\u067e \u06a9\u0627 \u0645\u0646\u062a\u062e\u0628 \u0622\u067e\u0634\u0646 \u062a\u06cc\u0627\u0631 \u06c1\u06d2: ${room}, ${pricePart}. \u06a9\u06cc\u0627 \u0645\u06cc\u06ba \u0633\u0631\u06a9\u0627\u0631\u06cc \u0631\u06cc\u0632\u0631\u0648\u06cc\u0634\u0646 \u0631\u06cc\u0648\u06cc\u0648 \u06a9\u06d2 \u0644\u06cc\u06d2 \u0622\u06af\u06d2 \u0628\u0691\u06be\u0648\u06ba\u061f`;
	}
	if (/hindi/i.test(lang)) {
		return `${opening} ${name}, \u092e\u0948\u0902 ${agentName}, ${hotelName} \u0930\u093f\u0938\u0947\u092a\u094d\u0936\u0928 \u0914\u0930 \u0930\u093f\u091c\u0930\u094d\u0935\u0947\u0936\u0928\u094d\u0938 \u0938\u0947 \u0939\u0942\u0902\u0964 \u0906\u092a\u0915\u093e \u091a\u0941\u0928\u093e \u0939\u0941\u0906 \u0935\u093f\u0915\u0932\u094d\u092a \u0924\u0948\u092f\u093e\u0930 \u0939\u0948: ${room}, ${pricePart}. \u0915\u094d\u092f\u093e \u092e\u0948\u0902 \u0906\u0927\u093f\u0915\u093e\u0930\u093f\u0915 \u0930\u093f\u091c\u0930\u094d\u0935\u0947\u0936\u0928 \u0930\u093f\u0935\u094d\u092f\u0942 \u0915\u0947 \u0932\u093f\u090f \u0906\u0917\u0947 \u092c\u0922\u0942\u0902?`;
	}
	if (/indonesian/i.test(lang)) {
		return `${opening} ${name}, saya ${agentName} dari resepsionis dan reservasi ${hotelName}. Opsi pilihan Anda sudah siap: ${room}, ${pricePart}. Apakah Anda ingin lanjut ke pemeriksaan reservasi resmi?`;
	}
	if (/malay/i.test(lang)) {
		return `${opening} ${name}, saya ${agentName} dari penerimaan dan tempahan ${hotelName}. Pilihan anda sudah sedia: ${room}, ${pricePart}. Adakah anda mahu teruskan ke semakan tempahan rasmi?`;
	}
	return `${opening} ${name}, this is ${agentName} from ${hotelName} reception and reservations. I have the selected option ready: ${room}, ${pricePart}. Would you like to continue with the reservation details?`;
}

function stabilizeHotelHandoffIntro(text = "", sc = {}, st = {}, optionOrHotel = {}, meta = {}) {
	if (!optionOrHotel?.quote?.available) return text;
	const value = String(text || "").trim();
	if (
		/check-?\s*in|check-?\s*out|send.*dates|share.*dates|fechas|entrada|salida|dates?/i.test(
			value
		)
	) {
		return hotelHandoffQuoteIntroText(sc, st, optionOrHotel, meta);
	}
	return value || hotelHandoffQuoteIntroText(sc, st, optionOrHotel, meta);
}

function platformHotelOptionQuickReplies(sc = {}, st = {}) {
	const options = Array.isArray(st.platformHotelOptions)
		? st.platformHotelOptions
		: [];
	const lang = languageOf(sc, st);
	return options.slice(0, 3).map((option, index) => {
		const number = index + 1;
		let label = `Connect to ${option.hotelName}`;
		if (/arabic/i.test(lang)) label = `تواصل مع ${option.hotelName}`;
		if (/spanish/i.test(lang)) label = `Conectar con ${option.hotelName}`;
		if (/french/i.test(lang)) label = `Contacter ${option.hotelName}`;
		if (/urdu/i.test(lang)) label = `${option.hotelName} سے رابطہ`;
		if (/hindi/i.test(lang)) label = `${option.hotelName} से जोड़ें`;
		return {
			label: label.slice(0, 80),
			value: `Connect me to option ${number}: ${option.hotelName}`,
			action: `connect_hotel_${number}`,
		};
	});
}

function parsePlatformHotelChoice(text = "", options = []) {
	if (!options.length) return -1;
	const { lower, latinCompact } = normalizeControlText(text);
	const digit = lower.match(/\b([1-4])\b/);
	if (digit) {
		const index = Number(digit[1]) - 1;
		return options[index] ? index : -1;
	}
	const actionDigit = lower.match(/connect\s+me\s+to\s+option\s+([1-4])/i);
	if (actionDigit) {
		const index = Number(actionDigit[1]) - 1;
		return options[index] ? index : -1;
	}
	if (/^(yes|yes please|please|ok|okay|sure|connect|go ahead|proceed|book it|reserve it)\b/i.test(lower)) {
		return options[0] ? 0 : -1;
	}
	const compact = latinCompact || lower.replace(/[^a-z0-9]/gi, "");
	const byName = options.findIndex((option) => {
		const name = String(option.hotelName || "").toLowerCase();
		const nameCompact = name.replace(/[^a-z0-9]/gi, "");
		return (
			(name && lower.includes(name)) ||
			(nameCompact && compact.includes(nameCompact))
		);
	});
	return byName >= 0 ? byName : -1;
}

function chooseHotelHandoffAgentName(caseId = "", hotelId = "", current = "") {
	const names = [
		process.env.B2C_AI_HOTEL_HANDOFF_NAMES,
		"Sara,Aisha,Amira,Yasmin,Nadia",
	]
		.flatMap((value) => String(value || "").split(","))
		.map((name) => String(name || "").trim())
		.filter(Boolean)
		.filter((name, index, list) => list.indexOf(name) === index)
		.filter((name) => name.toLowerCase() !== String(current || "").toLowerCase());
	if (!names.length) return current || "Sara";
	const seed = `${caseId}|${hotelId}`;
	const index =
		seed.split("").reduce((acc, char) => acc + char.charCodeAt(0), 0) %
		names.length;
	return names[index];
}

function roomMatches(room = {}, roomTypeKey = "doubleRooms") {
	return (
		room &&
		room.activeRoom &&
		room.roomType === roomTypeKey &&
		Number(room.price?.basePrice || 0) > 0
	);
}

function hotelCityText(hotel = {}) {
	return [
		hotel.hotelCity,
		hotel.hotelState,
		hotel.hotelAddress,
		hotel.aboutHotel,
		hotel.aboutHotelArabic,
	]
		.filter(Boolean)
		.join(" ")
		.toLowerCase();
}

function isMakkahHotel(hotel = {}) {
	const text = hotelCityText(hotel);
	return /\b(makkah|mecca|mekkah)\b|\u0645\u0643\u0629|\u0645\u0643\u0647/.test(text);
}

function wantsMakkahNearHaram(text = "") {
	const value = String(text || "").toLowerCase();
	const mentionsMadinah =
		/\b(madinah|medina|madina)\b|\u0627\u0644\u0645\u062f\u064a\u0646\u0629|\u0645\u062f\u064a\u0646\u0629|\u0645\u062f\u064a\u0646\u0647/.test(
			value
		);
	if (mentionsMadinah) return false;
	return /\b(makkah|mecca|mekkah|al\s*haram|haram|kaaba|ka'ba|umrah)\b|\u0645\u0643\u0629|\u0645\u0643\u0647|\u0627\u0644\u062d\u0631\u0645|\u0643\u0639\u0628\u0629|\u0639\u0645\u0631\u0629/.test(
		value
	);
}

function sanitizedRoomDescription(value = "", roomTypeKey = "") {
	let text = cleanHotelFactText(value);
	if (!text) return "";
	if (["doubleRooms", "tripleRooms", "quadRooms", "familyRooms"].includes(roomTypeKey)) {
		text = text
			.replace(
				/\b(?:accommodates?|fits?|sleeps?)\s+(?:up\s+to\s+)?(?:one|two|three|four|five|six|seven|eight|nine|\d+)\s+(?:guests?|people|persons?)\s*(?:,|;|-|with|featuring)?\s*/gi,
				""
			)
			.replace(
				/\b(?:features?|featuring)\s+(?:one|two|three|four|five|six|seven|eight|nine|\d+)[-\s]*(?:cozy\s+|comfortable\s+)?beds?\s*(?:,|;|-|—)?\s*/gi,
				""
			)
			.replace(
				/\b(?:perfect|ideal|great)\s+for\s+(?:large\s+)?(?:families|groups)[^.!?]*(?:[.!?]|$)/gi,
				""
			);
	}
	return cleanHotelFactText(text);
}

function roomOptionCapacityNote(room = {}, lang = "English") {
	if (room?.roomType === "individualBed") {
		const beds = safePositiveRoomNumber(room.bedsCount);
		if (/arabic/i.test(lang)) return beds ? `غرفة مشتركة بها ${beds} أسرة` : "غرفة مشتركة";
		return beds ? `shared room with ${beds} beds` : "shared room";
	}
	return roomCapacityLabel(room?.roomType || "", lang);
}

function roomListFactsForOpenAi(options = [], lang = "English") {
	return (Array.isArray(options) ? options : []).map((room) => ({
		roomType: room.roomType,
		displayName: room.displayName || roomOptionDisplayName(room, lang),
		displayNameOther: room.displayNameOther || "",
		capacityNote: roomOptionCapacityNote(room, lang),
	}));
}

function activeHotelRoomSummaries(hotel = {}, roomTypeKey = null) {
	const rooms = Array.isArray(hotel?.roomCountDetails)
		? hotel.roomCountDetails
		: [];
	return rooms
		.filter(
			(room) =>
				room?.activeRoom &&
				(!roomTypeKey || room.roomType === roomTypeKey)
		)
		.map((room) => ({
			roomType: room.roomType,
			displayName: room.displayName || room.roomType,
			displayNameOther: room.displayName_OtherLanguage || "",
			description: compactRoomFactText(
				sanitizedRoomDescription(room.description, room.roomType),
				260
			),
			descriptionOther: compactRoomFactText(
				sanitizedRoomDescription(
					room.description_OtherLanguage,
					room.roomType
				),
				260
			),
			capacityNote: roomOptionCapacityNote(room, "English"),
			amenities: compactRoomFactList(room.amenities, 12),
			views: compactRoomFactList(room.views, 6),
			extraAmenities: compactRoomFactList(room.extraAmenities, 8),
			roomSize: compactRoomFactText(room.roomSize, 80),
			bedsCount: safePositiveRoomNumber(room.bedsCount),
			roomForGender: compactRoomFactText(room.roomForGender, 80),
			basePrice: room.price?.basePrice || 0,
			currency: hotel?.currency || "SAR",
		}));
}

function compactRoomFactText(value = "", maxLength = 260) {
	const text = cleanHotelFactText(value);
	if (!text) return "";
	if (text.length <= maxLength) return text;
	return `${text.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
}

function compactRoomFactList(values = [], limit = 12) {
	const source = Array.isArray(values) ? values : [values];
	const seen = new Set();
	const result = [];
	for (const item of source) {
		const raw =
			typeof item === "object" && item !== null
				? item.name ||
				  item.label ||
				  item.title ||
				  item.value ||
				  item.en ||
				  item.ar ||
				  item.amenity ||
				  ""
				: item;
		const text = compactRoomFactText(raw, 90);
		const key = text.toLowerCase();
		if (!text || seen.has(key)) continue;
		seen.add(key);
		result.push(text);
		if (result.length >= limit) break;
	}
	return result;
}

function safePositiveRoomNumber(value) {
	const number = Number(value);
	return Number.isFinite(number) && number > 0 ? number : "";
}

function cleanHotelFactText(value = "") {
	return String(value || "")
		.replace(/\s+/g, " ")
		.trim();
}

const AL_HARAM_LOCATION = {
	latitude: 21.422487,
	longitude: 39.826206,
};

function hotelCoordinates(hotel = {}) {
	const coordinates = Array.isArray(hotel?.location?.coordinates)
		? hotel.location.coordinates
		: [];
	const longitude = Number(coordinates[0]);
	const latitude = Number(coordinates[1]);
	const valid =
		Number.isFinite(latitude) &&
		Number.isFinite(longitude) &&
		Math.abs(latitude) <= 90 &&
		Math.abs(longitude) <= 180 &&
		!(latitude === 0 && longitude === 0);
	return valid ? { latitude, longitude } : null;
}

function hotelGoogleMapsDirectionsUrl(hotel = {}) {
	const coords = hotelCoordinates(hotel);
	if (!coords) return "";
	const origin = encodeURIComponent(`${coords.latitude},${coords.longitude}`);
	const destination = encodeURIComponent(
		`${AL_HARAM_LOCATION.latitude},${AL_HARAM_LOCATION.longitude}`
	);
	return `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${destination}&travelmode=driving`;
}

function hotelGoogleMapsLocationUrl(hotel = {}) {
	const coords = hotelCoordinates(hotel);
	if (!coords) return "";
	const query = encodeURIComponent(`${coords.latitude},${coords.longitude}`);
	return `https://www.google.com/maps/search/?api=1&query=${query}`;
}

function hotelGoogleMapsUrl(hotel = {}) {
	return hotelGoogleMapsLocationUrl(hotel);
}

function hotelGoogleMapsMarkdownLink(hotel = {}, lang = "English") {
	const url = hotelGoogleMapsUrl(hotel);
	if (!url) return "";
	let label = "Hotel location on Google Maps";
	if (/arabic/i.test(lang)) label = "\u0645\u0648\u0642\u0639 \u0627\u0644\u0641\u0646\u062f\u0642 \u0639\u0644\u0649 Google Maps";
	else if (/spanish/i.test(lang)) label = "Ubicacion del hotel en Google Maps";
	else if (/french/i.test(lang)) label = "Emplacement de l'hotel sur Google Maps";
	else if (/indonesian/i.test(lang)) label = "Lokasi hotel di Google Maps";
	else if (/malay|malaysia/i.test(lang)) label = "Lokasi hotel di Google Maps";
	return `[${label}](${url})`;
}

function buildActiveHotelFacts(sc = {}, st = {}) {
	const hotel = st.hotel || null;
	if (!hotel) return null;
	const distances = hotel.distances || {};
	const busDetails = cleanHotelFactText(hotel.busDetails);
	const mealsDetails = cleanHotelFactText(hotel.mealsDetails);
	const nusukDetails = cleanHotelFactText(hotel.isNusukText);
	const hotelPolicies = activeHotelPolicyQA(hotel.hotelPolicyQA);
	const mapsUrl = hotelGoogleMapsUrl(hotel);
	const directionsUrl = hotelGoogleMapsDirectionsUrl(hotel);
	return {
		displayName: localizedHotelName(sc, st),
		hotelName: hotel.hotelName || "",
		hotelNameOtherLanguage: hotel.hotelName_OtherLanguage || "",
		address: cleanHotelFactText(hotel.hotelAddress),
		city: cleanHotelFactText(hotel.hotelCity),
		state: cleanHotelFactText(hotel.hotelState),
		country: cleanHotelFactText(hotel.hotelCountry),
		aboutHotel: cleanHotelFactText(hotel.aboutHotel),
		aboutHotelArabic: cleanHotelFactText(hotel.aboutHotelArabic),
		distances: {
			walkingToElHaram: distances.walkingToElHaram || "",
			drivingToElHaram: distances.drivingToElHaram || "",
		},
		location: hotel.location || null,
		googleMapsLocationUrl: mapsUrl || "",
		googleMapsDrivingDirectionsUrl: directionsUrl || "",
		parkingLot: hotel.parkingLot === true,
		hasBusService: hotel.hasBusService === true,
		busDetails,
		hasMealsService: hotel.hasMealsService === true,
		mealsDetails,
		isNusuk: hotel.isNusuk === true,
		isNusukText: nusukDetails,
		hotelPolicyQA: hotelPolicies,
		activeRooms: activeHotelRoomSummaries(hotel).slice(0, 8),
	};
}

function inlineRoomOptions(options = [], lang = "") {
	return options
		.map((option) =>
			roomOptionDisplayName(option, lang)
		)
		.filter(Boolean)
		.slice(0, 5)
		.join(" / ");
}

function roomOptionDisplayName(option = {}, lang = "") {
	const useArabic = /arabic/i.test(lang);
	return String(
		useArabic && hasArabicScript(option?.displayNameOther)
			? option.displayNameOther
			: option?.displayName || option?.roomType || ""
	).trim();
}

function roomOptionsList(options = [], lang = "", limit = 6) {
	const seen = new Set();
	return (Array.isArray(options) ? options : [])
		.map((option) => roomOptionDisplayName(option, lang))
		.filter(Boolean)
		.filter((name) => {
			const key = name.toLowerCase();
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		})
		.slice(0, limit);
}

function roomOptionsBullets(options = [], lang = "") {
	return roomOptionsList(options, lang)
		.map((name) => `- ${name}`)
		.join("\n");
}

function roomOptionsListText(sc = {}, st = {}, options = []) {
	const name = respectfulGuestName(sc, st);
	const hotelName = localizedHotelName(sc, st);
	const lang = languageOf(sc, st);
	const bullets = roomOptionsBullets(options, lang);
	const hasStayDates = Boolean(st.slots?.checkinISO && st.slots?.checkoutISO);
	const dateLines = hasStayDates ? localizedStayDateLines(sc, st) : {};
	const dateText = [dateLines.primary, dateLines.secondary ? `(${dateLines.secondary})` : ""]
		.filter(Boolean)
		.join(" ");
	if (!bullets) {
		if (/arabic/i.test(lang)) {
			if (hasStayDates) {
				return `${name}\u060c \u0648\u0635\u0644\u062a\u0646\u064a \u0627\u0644\u062a\u0648\u0627\u0631\u064a\u062e: ${dateText}. \u0644\u0627 \u0623\u0631\u0649 \u0642\u0627\u0626\u0645\u0629 \u063a\u0631\u0641 \u0645\u0641\u0639\u0644\u0629 \u062d\u0627\u0644\u064a\u0627 \u0641\u064a ${hotelName}. \u0623\u0631\u0633\u0644 \u0639\u062f\u062f \u0627\u0644\u0623\u0634\u062e\u0627\u0635 \u0648\u0633\u0623\u0631\u0627\u062c\u0639 \u0644\u0643 \u0623\u0642\u0631\u0628 \u062e\u064a\u0627\u0631 \u0645\u0646\u0627\u0633\u0628.`;
			}
			return `${name}\u060c \u062d\u0642\u0643 \u0639\u0644\u064a. \u0644\u0627 \u0623\u0631\u0649 \u0642\u0627\u0626\u0645\u0629 \u063a\u0631\u0641 \u0645\u0641\u0639\u0644\u0629 \u062d\u0627\u0644\u064a\u0627 \u0641\u064a ${hotelName}. \u0623\u0631\u0633\u0644 \u0639\u062f\u062f \u0627\u0644\u0623\u0634\u062e\u0627\u0635 \u0623\u0648 \u0627\u0644\u062a\u0648\u0627\u0631\u064a\u062e \u0648\u0633\u0623\u0631\u0627\u062c\u0639 \u0644\u0643 \u0623\u0642\u0631\u0628 \u062e\u064a\u0627\u0631 \u0645\u0646\u0627\u0633\u0628.`;
		}
		if (hasStayDates) {
			return `${name}, I have the dates: ${dateText}. I do not currently see active room options listed for ${hotelName}. Send the guest count and I will check the closest suitable option.`;
		}
		return `${name}, you are right. I do not currently see active room options listed for ${hotelName}. Send the guest count or dates and I will check the closest suitable option.`;
	}
	if (/arabic/i.test(lang)) {
		if (hasStayDates) {
			return `${name}\u060c \u0648\u0635\u0644\u062a\u0646\u064a \u0627\u0644\u062a\u0648\u0627\u0631\u064a\u062e: ${dateText}. \u0623\u0646\u0648\u0627\u0639 \u0627\u0644\u063a\u0631\u0641 \u0627\u0644\u0645\u062a\u0627\u062d\u0629 \u0641\u064a ${hotelName}:\n${bullets}\n\n\u0623\u064a \u0646\u0648\u0639 \u062a\u0641\u0636\u0644 \u0644\u0623\u0631\u0627\u062c\u0639 \u0627\u0644\u0633\u0639\u0631 \u0648\u0627\u0644\u062a\u0648\u0641\u0631\u061f`;
		}
		return `${name}\u060c \u062d\u0642\u0643 \u0639\u0644\u064a. \u0623\u0646\u0648\u0627\u0639 \u0627\u0644\u063a\u0631\u0641 \u0627\u0644\u0645\u062a\u0627\u062d\u0629 \u0641\u064a ${hotelName}:\n${bullets}\n\n\u0623\u064a \u0646\u0648\u0639 \u062a\u0641\u0636\u0644\u061f \u0648\u0625\u0630\u0627 \u062a\u0631\u064a\u062f \u0627\u0644\u0633\u0639\u0631\u060c \u0623\u0631\u0633\u0644 \u062a\u0627\u0631\u064a\u062e \u0627\u0644\u0648\u0635\u0648\u0644 \u0648\u0627\u0644\u0645\u063a\u0627\u062f\u0631\u0629.`;
	}
	if (/spanish/i.test(lang)) {
		if (hasStayDates) {
			return `${name}, perfecto, ya tengo las fechas: ${dateText}. Las habitaciones disponibles en ${hotelName} son:\n${bullets}\n\nCual prefieres para revisar precio y disponibilidad?`;
		}
		return `${name}, claro. Las habitaciones disponibles en ${hotelName} son:\n${bullets}\n\nCual prefieres? Si quieres precio, enviame las fechas de entrada y salida.`;
	}
	if (/french/i.test(lang)) {
		if (hasStayDates) {
			return `${name}, parfait, j'ai bien les dates : ${dateText}. Les types de chambres disponibles a ${hotelName} sont :\n${bullets}\n\nLequel preferez-vous afin que je verifie le prix et la disponibilite ?`;
		}
		return `${name}, bien sur. Les types de chambres disponibles a ${hotelName} sont :\n${bullets}\n\nLequel preferez-vous ? Si vous souhaitez le prix, envoyez les dates d'arrivee et de depart.`;
	}
	if (/urdu/i.test(lang)) {
		if (hasStayDates) {
			return `${name}\u060c \u062c\u06cc \u0628\u0627\u0644\u06a9\u0644\u060c \u062a\u0627\u0631\u06cc\u062e\u06cc\u06ba \u0645\u0648\u0635\u0648\u0644 \u06c1\u0648 \u06af\u0626\u06cc \u06c1\u06cc\u06ba: ${dateText}. ${hotelName} \u0645\u06cc\u06ba \u062f\u0633\u062a\u06cc\u0627\u0628 \u06a9\u0645\u0631\u0648\u06ba \u06a9\u06cc \u0627\u0642\u0633\u0627\u0645:\n${bullets}\n\n\u0622\u067e \u06a9\u0648 \u06a9\u0648\u0646 \u0633\u0627 \u06a9\u0645\u0631\u06c1 \u067e\u0633\u0646\u062f \u06c1\u06d2 \u062a\u0627\u06a9\u06c1 \u0645\u06cc\u06ba \u0642\u06cc\u0645\u062a \u0627\u0648\u0631 \u062f\u0633\u062a\u06cc\u0627\u0628\u06cc \u0686\u06cc\u06a9 \u06a9\u0631 \u0633\u06a9\u0648\u06ba\u061f`;
		}
		return `${name}\u060c \u062c\u06cc \u0628\u0627\u0644\u06a9\u0644\u06d4 ${hotelName} \u0645\u06cc\u06ba \u062f\u0633\u062a\u06cc\u0627\u0628 \u06a9\u0645\u0631\u0648\u06ba \u06a9\u06cc \u0627\u0642\u0633\u0627\u0645:\n${bullets}\n\n\u0622\u067e \u06a9\u0648 \u06a9\u0648\u0646 \u0633\u0627 \u06a9\u0645\u0631\u06c1 \u067e\u0633\u0646\u062f \u06c1\u06d2\u061f \u0642\u06cc\u0645\u062a \u06a9\u06d2 \u0644\u06cc\u06d2 \u0686\u06cc\u06a9 \u0627\u0646 \u0627\u0648\u0631 \u0686\u06cc\u06a9 \u0622\u0624\u0679 \u06a9\u06cc \u062a\u0627\u0631\u06cc\u062e\u06cc\u06ba \u0628\u06be\u06cc\u062c \u062f\u06cc\u06ba\u06d4`;
	}
	if (/hindi/i.test(lang)) {
		if (hasStayDates) {
			return `${name}, bilkul, dates mil gayi hain: ${dateText}. ${hotelName} \u092e\u0947\u0902 \u0909\u092a\u0932\u092c\u094d\u0927 \u0930\u0942\u092e \u091f\u093e\u0907\u092a:\n${bullets}\n\n\u0906\u092a \u0915\u094c\u0928 \u0938\u093e \u092a\u0938\u0902\u0926 \u0915\u0930\u0947\u0902\u0917\u0947 \u0924\u093e\u0915\u093f \u092e\u0948\u0902 price aur availability check kar sakun?`;
		}
		return `${name}, bilkul. ${hotelName} \u092e\u0947\u0902 \u0909\u092a\u0932\u092c\u094d\u0927 \u0930\u0942\u092e \u091f\u093e\u0907\u092a:\n${bullets}\n\n\u0906\u092a \u0915\u094c\u0928 \u0938\u093e \u092a\u0938\u0902\u0926 \u0915\u0930\u0947\u0902\u0917\u0947? \u0915\u0940\u092e\u0924 \u091a\u093e\u0939\u093f\u090f \u0924\u094b \u091a\u0947\u0915-\u0907\u0928 \u0914\u0930 \u091a\u0947\u0915-\u0906\u0909\u091f \u0924\u093e\u0930\u0940\u0916 \u092d\u0947\u091c\u0947\u0902.`;
	}
	if (/indonesian/i.test(lang)) {
		if (hasStayDates) {
			return `${name}, baik, tanggalnya sudah saya terima: ${dateText}. Tipe kamar yang tersedia di ${hotelName}:\n${bullets}\n\nMana yang Anda pilih agar saya cek harga dan ketersediaannya?`;
		}
		return `${name}, tentu. Tipe kamar yang tersedia di ${hotelName}:\n${bullets}\n\nMana yang Anda pilih? Untuk harga, kirim tanggal check-in dan check-out.`;
	}
	if (/malay/i.test(lang)) {
		if (hasStayDates) {
			return `${name}, baik, tarikh sudah saya terima: ${dateText}. Jenis bilik yang tersedia di ${hotelName}:\n${bullets}\n\nYang mana anda pilih supaya saya semak harga dan ketersediaan?`;
		}
		return `${name}, tentu. Jenis bilik yang tersedia di ${hotelName}:\n${bullets}\n\nYang mana anda pilih? Untuk harga, hantarkan tarikh check-in dan check-out.`;
	}
	if (hasStayDates) {
		return `${name}, perfect, I have the dates: ${dateText}. The available room types at ${hotelName} are:\n${bullets}\n\nWhich one would you prefer so I can check price and availability?`;
	}
	return `${name}, of course. The available room types at ${hotelName} are:\n${bullets}\n\nWhich one would you prefer? If you want the price, send the check-in and checkout dates.`;
}

function uniqueRoomFacts(values = [], limit = 5) {
	const seen = new Set();
	const facts = [];
	for (const value of values || []) {
		const text = cleanHotelFactText(value);
		const key = text.toLowerCase();
		if (!text || seen.has(key)) continue;
		seen.add(key);
		facts.push(text);
		if (facts.length >= limit) break;
	}
	return facts;
}

function roomDetailsLabels(lang = "English") {
	if (/arabic/i.test(lang)) {
		return {
			description: "\u0627\u0644\u0648\u0635\u0641",
			amenities: "\u0627\u0644\u0645\u0631\u0627\u0641\u0642",
			views: "\u0627\u0644\u0625\u0637\u0644\u0627\u0644\u0629",
			beds: "\u0639\u062f\u062f \u0627\u0644\u0623\u0633\u0631\u0629",
			size: "\u0627\u0644\u0645\u0633\u0627\u062d\u0629",
			noDetails:
				"\u0644\u0627 \u0623\u0631\u0649 \u062a\u0641\u0627\u0635\u064a\u0644 \u0625\u0636\u0627\u0641\u064a\u0629 \u0645\u0624\u0643\u062f\u0629 \u062d\u0627\u0644\u064a\u0627",
		};
	}
	return {
		description: "Description",
		amenities: "Amenities",
		views: "Views",
		beds: "Beds",
		size: "Size",
		noDetails: "No extra room details are confirmed right now",
	};
}

function roomDetailsBullet(room = {}, lang = "English") {
	const labels = roomDetailsLabels(lang);
	const name =
		roomOptionDisplayName(room, lang) ||
		localizedRoomTypeLabel(room.roomType, lang);
	const description =
		/arabic/i.test(lang) && hasArabicScript(room.descriptionOther)
			? room.descriptionOther
			: room.description;
	const amenities = uniqueRoomFacts(
		[...(room.amenities || []), ...(room.extraAmenities || [])],
		5
	).join(", ");
	const views = uniqueRoomFacts(room.views || [], 3).join(", ");
	const facts = [];
	if (description) facts.push(`${labels.description}: ${description}`);
	if (amenities) facts.push(`${labels.amenities}: ${amenities}`);
	if (views) facts.push(`${labels.views}: ${views}`);
	if (room.bedsCount) facts.push(`${labels.beds}: ${room.bedsCount}`);
	if (room.roomSize) facts.push(`${labels.size}: ${room.roomSize}`);
	return `- ${name}: ${facts.join("; ") || labels.noDetails}`;
}

function roomDetailsNextStepText(sc = {}, st = {}, roomTypeKey = "") {
	const lang = languageOf(sc, st);
	const hasDates = Boolean(st.slots?.checkinISO && st.slots?.checkoutISO);
	if (aiReservationReference(sc)) {
		return /arabic/i.test(lang)
			? "\u0648\u0628\u0639\u062f \u0627\u0644\u062d\u062c\u0632 \u0623\u0642\u062f\u0631 \u0623\u0633\u0627\u0639\u062f\u0643 \u0641\u064a \u0623\u064a \u0633\u0624\u0627\u0644 \u0622\u062e\u0631 \u0639\u0646 \u0627\u0644\u062d\u062c\u0632\u060c \u0627\u0644\u062e\u0631\u0627\u0626\u0637\u060c Nusuk\u060c \u0623\u0648 \u0623\u064a \u062a\u0641\u0635\u064a\u0644 \u0644\u0644\u0641\u0646\u062f\u0642."
			: "After the booking, I can still help with the confirmation, maps, Nusuk, cancellation questions, or any other hotel detail.";
	}
	if (/arabic/i.test(lang)) {
		if (hasDates && roomTypeKey) {
			return "\u0625\u0630\u0627 \u0647\u0630\u0647 \u0627\u0644\u063a\u0631\u0641\u0629 \u0645\u0646\u0627\u0633\u0628\u0629\u060c \u0623\u0642\u062f\u0631 \u0623\u0631\u0627\u062c\u0639 \u0644\u0643 \u0627\u0644\u0633\u0639\u0631 \u0648\u0627\u0644\u062a\u0648\u0641\u0631 \u0639\u0644\u0649 \u062a\u0648\u0627\u0631\u064a\u062e\u0643.";
		}
		return roomTypeKey
			? "\u0625\u0630\u0627 \u0647\u0630\u0647 \u0627\u0644\u063a\u0631\u0641\u0629 \u0645\u0646\u0627\u0633\u0628\u0629\u060c \u0623\u0631\u0633\u0644 \u062a\u0627\u0631\u064a\u062e \u0627\u0644\u0648\u0635\u0648\u0644 \u0648\u0627\u0644\u0645\u063a\u0627\u062f\u0631\u0629 \u0644\u0623\u0631\u0627\u062c\u0639 \u0644\u0643 \u0627\u0644\u0633\u0639\u0631 \u0648\u0627\u0644\u062a\u0648\u0641\u0631."
			: "\u0627\u062e\u062a\u0631 \u0646\u0648\u0639 \u0627\u0644\u063a\u0631\u0641\u0629 \u0627\u0644\u0623\u0646\u0633\u0628\u060c \u0648\u0623\u0631\u0633\u0644 \u062a\u0648\u0627\u0631\u064a\u062e \u0627\u0644\u0648\u0635\u0648\u0644 \u0648\u0627\u0644\u0645\u063a\u0627\u062f\u0631\u0629 \u0644\u0623\u0631\u0627\u062c\u0639 \u0627\u0644\u0633\u0639\u0631.";
	}
	if (hasDates && roomTypeKey) {
		return "If this room works for you, I can check the price and availability for your dates.";
	}
	return roomTypeKey
		? "If this room works for you, send the check-in and checkout dates and I will check price and availability."
		: "Choose the room type that fits you best, then send the check-in and checkout dates and I will check the price.";
}

function roomDetailsSummaryText(sc = {}, st = {}, options = [], roomTypeKey = "") {
	const name = respectfulGuestName(sc, st);
	const hotelName = localizedHotelName(sc, st);
	const lang = languageOf(sc, st);
	const rooms = (Array.isArray(options) ? options : []).slice(0, roomTypeKey ? 3 : 6);
	if (!rooms.length) {
		if (/arabic/i.test(lang)) {
			return `${name}\u060c \u0644\u0627 \u0623\u0631\u0649 \u062a\u0641\u0627\u0635\u064a\u0644 \u063a\u0631\u0641 \u0645\u0641\u0639\u0644\u0629 \u062d\u0627\u0644\u064a\u0627 \u0641\u064a ${hotelName}. ${roomDetailsNextStepText(sc, st, roomTypeKey)}`;
		}
		return `${name}, I do not currently see active room details listed for ${hotelName}. ${roomDetailsNextStepText(sc, st, roomTypeKey)}`;
	}
	const bullets = rooms.map((room) => roomDetailsBullet(room, lang)).join("\n");
	if (/arabic/i.test(lang)) {
		return `${name}\u060c \u0647\u0630\u0647 \u062a\u0641\u0627\u0635\u064a\u0644 \u0627\u0644\u063a\u0631\u0641 \u0627\u0644\u0645\u062a\u0627\u062d\u0629 \u0641\u064a ${hotelName}:\n${bullets}\n\n${roomDetailsNextStepText(sc, st, roomTypeKey)}`;
	}
	return `${name}, here are the room details I can see for ${hotelName}:\n${bullets}\n\n${roomDetailsNextStepText(sc, st, roomTypeKey)}`;
}

function roomPreferenceSalesText(sc = {}, st = {}) {
	const name = respectfulGuestName(sc, st);
	const hotelName = toTitle(st.hotel?.hotelName || sc.displayName2 || "the hotel");
	const lang = languageOf(sc, st);
	const activeRooms = activeHotelRoomSummaries(st.hotel).slice(0, 6);
	const options = roomOptionsBullets(activeRooms, lang);
	if (/arabic/i.test(lang)) {
		return options
			? `${name}\u060c \u0628\u0627\u0644\u062a\u0623\u0643\u064a\u062f. \u0641\u064a ${hotelName} \u0623\u0642\u062f\u0631 \u0623\u0633\u0627\u0639\u062f\u0643 \u062a\u062e\u062a\u0627\u0631 \u0627\u0644\u063a\u0631\u0641\u0629 \u0627\u0644\u0623\u0646\u0633\u0628. \u0627\u0644\u062e\u064a\u0627\u0631\u0627\u062a \u0627\u0644\u0645\u062a\u0627\u062d\u0629:\n${options}\n\n\u0623\u064a \u0646\u0648\u0639 \u063a\u0631\u0641\u0629 \u062a\u0641\u0636\u0644 \u0644\u0644\u062d\u062c\u0632\u061f`
			: `${name}\u060c \u0628\u0627\u0644\u062a\u0623\u0643\u064a\u062f. \u0623\u0642\u062f\u0631 \u0623\u0633\u0627\u0639\u062f\u0643 \u062a\u062e\u062a\u0627\u0631 \u0627\u0644\u063a\u0631\u0641\u0629 \u0627\u0644\u0623\u0646\u0633\u0628. \u0645\u0627 \u0646\u0648\u0639 \u0627\u0644\u063a\u0631\u0641\u0629 \u0623\u0648 \u0639\u062f\u062f \u0627\u0644\u0636\u064a\u0648\u0641\u061f`;
	}
	if (/spanish/i.test(lang)) {
		return options
			? `${name}, claro. En ${hotelName} puedo ayudarte a elegir la habitacion adecuada. Tenemos estas opciones:\n${options}\n\nQue tipo de habitacion quieres reservar?`
			: `${name}, claro. Puedo ayudarte a elegir la habitacion adecuada. Que tipo de habitacion o cuantos huespedes necesitas?`;
	}
	if (/french/i.test(lang)) {
		return options
			? `${name}, bien sur. A ${hotelName}, je peux vous aider a choisir la chambre qui convient. Nous avons notamment :\n${options}\n\nQuel type de chambre souhaitez-vous reserver ?`
			: `${name}, bien sur. Je peux vous aider a choisir la chambre qui convient. Quel type de chambre ou combien de personnes faut-il prevoir ?`;
	}
	return options
		? `${name}, of course. At ${hotelName}, I can help you choose the right room. We currently have:\n${options}\n\nWhich room type would you like to book?`
		: `${name}, of course. I can help you choose the right room. Which room type or guest count should I prepare for you?`;
}

function roomCapacityLabel(roomTypeKey = "", lang = "English") {
	const isArabic = /arabic/i.test(lang);
	const labels = {
		doubleRooms: isArabic ? "\u0636\u064a\u0641\u064a\u0646" : "2 guests",
		tripleRooms: isArabic ? "\u062b\u0644\u0627\u062b\u0629 \u0636\u064a\u0648\u0641" : "3 guests",
		quadRooms: isArabic ? "\u0623\u0631\u0628\u0639\u0629 \u0636\u064a\u0648\u0641" : "4 guests",
		familyRooms: isArabic ? "\u062e\u0645\u0633\u0629 \u0636\u064a\u0648\u0641" : "5 guests",
	};
	return labels[roomTypeKey] || "";
}

function roomFitSalesIntroText(sc = {}, st = {}, roomTypeKey = "", rooms = []) {
	const name = respectfulGuestName(sc, st);
	const lang = languageOf(sc, st);
	const hotelName = localizedHotelName(sc, st);
	const roomNames =
		/arabic/i.test(lang) && roomTypeKey
			? localizedRoomTypeLabel(roomTypeKey, lang)
			: inlineRoomOptions(rooms, lang) || localizedRoomTypeLabel(roomTypeKey, lang);
	const capacity = roomCapacityLabel(roomTypeKey, lang);
	if (/arabic/i.test(lang)) {
		const fit = capacity
			? ` \u0648\u0647\u0648 \u062e\u064a\u0627\u0631 \u0645\u0646\u0627\u0633\u0628 \u0644\u0640${capacity}`
			: "";
		return `${name}\u060c \u0628\u0627\u0644\u062a\u0623\u0643\u064a\u062f \u0623\u0642\u062f\u0631 \u0623\u0633\u0627\u0639\u062f\u0643. \u0641\u064a ${hotelName} \u0639\u0646\u062f\u0646\u0627 ${roomNames}${fit}. \u0623\u0631\u0633\u0644 \u0644\u064a \u062a\u0627\u0631\u064a\u062e \u0627\u0644\u0648\u0635\u0648\u0644 \u0648\u0627\u0644\u0645\u063a\u0627\u062f\u0631\u0629 \u0644\u0623\u0631\u0627\u062c\u0639 \u0644\u0643 \u0627\u0644\u062a\u0648\u0641\u0631 \u0648\u0627\u0644\u0633\u0639\u0631 \u0628\u062f\u0642\u0629.`;
	}
	if (/spanish/i.test(lang)) {
		const fit = capacity ? ` y encaja bien para ${capacity}` : "";
		return `${name}, claro que puedo ayudarte. En ${hotelName} tenemos ${roomNames}${fit}. Enviame la fecha de llegada y salida para revisar disponibilidad y precio exactos.`;
	}
	if (/french/i.test(lang)) {
		const fit = capacity ? ` et cela convient pour ${capacity}` : "";
		return `${name}, bien sur, je peux vous aider. A ${hotelName}, nous avons ${roomNames}${fit}. Envoyez-moi les dates d'arrivee et de depart pour verifier la disponibilite et le prix exact.`;
	}
	const fit = capacity ? `, which is a suitable fit for ${capacity}` : "";
	return `${name}, of course. At ${hotelName}, we have ${roomNames}${fit}. Send me the check-in and check-out dates and I will check the exact availability and price for you.`;
}

function recommendedRoomTypeKeyForGuestCount(count = null) {
	const guests = Number(count);
	if (!Number.isFinite(guests)) return "";
	if (guests === 2) return "doubleRooms";
	if (guests === 3) return "tripleRooms";
	if (guests === 4) return "quadRooms";
	if (guests === 5) return "familyRooms";
	return "";
}

function roomGuestCountRecommendationText(
	sc = {},
	st = {},
	count = null,
	roomTypeKey = "",
	rooms = []
) {
	const name = respectfulGuestName(sc, st);
	const lang = languageOf(sc, st);
	const hotelName = localizedHotelName(sc, st);
	const roomNames = inlineRoomOptions(rooms, lang) || localizedRoomTypeLabel(roomTypeKey, lang);
	const capacity = roomCapacityLabel(roomTypeKey, lang) || `${localizedNumber(count, lang)} guests`;
	if (/arabic/i.test(lang)) {
		return `${name}\u060c \u0644\u0640${capacity} \u0623\u0631\u0634\u062d ${roomNames} \u0641\u064a ${hotelName}\u060c \u0644\u0623\u0646\u0647 \u0623\u0646\u0633\u0628 \u062e\u064a\u0627\u0631 \u0644\u0647\u0630\u0627 \u0627\u0644\u0639\u062f\u062f. \u0623\u0631\u0633\u0644 \u0644\u064a \u062a\u0627\u0631\u064a\u062e \u0627\u0644\u0648\u0635\u0648\u0644 \u0648\u0627\u0644\u0645\u063a\u0627\u062f\u0631\u0629 \u0648\u0633\u0623\u0631\u0627\u062c\u0639 \u0644\u0643 \u0627\u0644\u062a\u0648\u0641\u0631 \u0648\u0627\u0644\u0633\u0639\u0631 \u0628\u062f\u0642\u0629.`;
	}
	if (/spanish/i.test(lang)) {
		return `${name}, para ${capacity}, recomiendo ${roomNames} en ${hotelName}; es la opcion mas adecuada para ese numero de huespedes. Enviame la fecha de llegada y salida para revisar disponibilidad y precio exactos.`;
	}
	if (/french/i.test(lang)) {
		return `${name}, pour ${capacity}, je recommande ${roomNames} a ${hotelName}; c'est l'option la plus adaptee pour ce nombre de personnes. Envoyez-moi les dates d'arrivee et de depart pour verifier la disponibilite et le prix exact.`;
	}
	if (/urdu/i.test(lang)) {
		return `${name}, ${capacity} ke liye ${hotelName} mein ${roomNames} recommend karta hoon. Yeh is guest count ke liye suitable option hai. Check-in aur checkout dates bhej dein, main exact availability aur price check kar dunga.`;
	}
	if (/hindi/i.test(lang)) {
		return `${name}, ${capacity} ke liye ${hotelName} mein ${roomNames} recommend karta hoon. Yeh is guest count ke liye suitable option hai. Check-in aur checkout dates bhej dijiye, main exact availability aur price check kar dunga.`;
	}
	if (/indonesian/i.test(lang)) {
		return `${name}, untuk ${capacity}, saya merekomendasikan ${roomNames} di ${hotelName}; ini pilihan yang paling sesuai untuk jumlah tamu tersebut. Kirim tanggal check-in dan check-out agar saya cek ketersediaan dan harga pastinya.`;
	}
	if (/malay|malaysia/i.test(lang)) {
		return `${name}, untuk ${capacity}, saya cadangkan ${roomNames} di ${hotelName}; ini pilihan yang paling sesuai untuk jumlah tetamu tersebut. Hantar tarikh check-in dan check-out supaya saya boleh semak availability dan harga tepat.`;
	}
	return `${name}, for ${capacity}, I recommend ${roomNames} at ${hotelName}; it is the best fit for that guest count. Send me the check-in and check-out dates and I will check the exact availability and price for you.`;
}

function negatedGuestCountCorrectionText(text = "") {
	const raw = String(text || "");
	if (!raw.trim()) return false;
	const { lower, arabic, latinCompact } = normalizeControlText(raw);
	const mentionsCount =
		/\b(?:[2-9]|two|three|four|five|six|seven|eight|nine|ten)\s*(?:people|persons?|individuals?|guests?|adults?|pax|beds?)\b/i.test(
			lower
		) ||
		/\b(?:people|persons?|individuals?|guests?|adults?|pax|beds?)\s*(?:[2-9]|two|three|four|five|six|seven|eight|nine|ten)\b/i.test(
			lower
		);
	const challengesPriorClaim =
		mentionsCount &&
		/\b(?:doesn'?t\s+make\s+sense|does\s+not\s+make\s+sense|not\s+make\s+sense|wrong|incorrect|mistake|how\s+(?:can|is|come)|you\s+said|u\s+said|that'?s\s+not|that\s+is\s+not)\b/i.test(
			lower
		) &&
		/\b(?:room|double|single|triple|quad|family|bed|beds|accommodat|fit|fits|guests?|people|said)\b/i.test(
			lower
		);
	return (
		challengesPriorClaim ||
		/\b(?:i|we)\s+(?:never|didn'?t|did\s+not|do\s+not|don't)\s+(?:say|said|tell|mention|have|need|want|ask\s+for)[^.!?\n]{0,80}\b(?:[2-9]|two|three|four|five|six|seven|eight|nine|ten)\s*(?:people|persons?|guests?|adults?|pax|beds?)?\b/i.test(
			lower
		) ||
		/\b(?:i|we)\s+(?:am|are|'m|'re)?\s*not\s+(?:[2-9]|two|three|four|five|six|seven|eight|nine|ten)\s*(?:people|persons?|individuals?|guests?|adults?|pax)?\b/i.test(
			lower
		) ||
		/\bnot\s+(?:[2-9]|two|three|four|five|six|seven|eight|nine|ten)\s*(?:people|persons?|individuals?|guests?|adults?|pax|beds?)\b/i.test(
			lower
		) ||
		/(?:neversaid|didntsay|didnotsay|dontsay|donotsay|notsix|not6|notfive|not5)/i.test(
			latinCompact
		) ||
		/(?:\u0645\u0627|\u0645\u0634|\u0644\u0645)\s*(?:\u0642\u0644\u062a|\u0627\u0642\u0648\u0644|\u0627\u0630\u0643\u0631|\u0630\u0643\u0631\u062a|\u0637\u0644\u0628\u062a)[^ØŸ\n]{0,80}(?:[2-9]|\u0662|\u0663|\u0664|\u0665|\u0666|\u0667|\u0668|\u0669|\u0627\u062b\u0646\u064a\u0646|\u062b\u0644\u0627\u062b\u0629|\u0627\u0631\u0628\u0639\u0629|\u0623\u0631\u0628\u0639\u0629|\u062e\u0645\u0633\u0629|\u0633\u062a\u0629)/i.test(
			arabic
		)
	);
}

function requestedGuestCountFromText(text = "") {
	const raw = String(text || "");
	if (!raw.trim()) return null;
	if (negatedGuestCountCorrectionText(raw)) return null;
	if (companionPairGuestCountText(raw)) return 2;
	const normalized = normalizeNumberWordsForParsing(raw);
	const { lower, arabic, latinCompact } = normalizeControlText(normalized);
	const counts = [];
	const addCount = (value) => {
		const count = reservationDetailCount(value, { allowZero: false });
		if (count !== null && count <= 30) counts.push(count);
	};
	addCount(standaloneGuestCountFromText(raw));
	addCount(countNearTerms(normalized, GUEST_COUNT_TERMS, { allowZero: false }));
	addCount(
		countNearTerms(
			normalized,
			[
				"beds?",
				"bed",
				"\\u0633\\u0631\\u064a\\u0631",
				"\\u0627\\u0633\\u0631\\u0647",
				"\\u0627\\u0633\\u0631\\u0629",
				"\\u0623\\u0633\\u0631\\u0629",
			],
			{ allowZero: false }
		)
	);
	const patterns = [
		/\b(?:for|fits?|fit|accommodates?|accommodate|we\s+are|we're)\s+([0-9]{1,2})\b/i,
		/\b(?:room|rooms|suite|suites|booking|reservation|stay)\s+(?:for|to\s+fit|fits?)\s+([0-9]{1,2})\b/i,
		/\b([0-9]{1,2})\s*(?:people|persons?|individuals?|guests?|adults?|pax|beds?)\b/i,
		/\b(?:people|persons?|individuals?|guests?|adults?|pax|beds?)\s*[:= -]*([0-9]{1,2})\b/i,
		/(?:\u0627\u062d\u0646\u0627|\u0646\u062d\u0646|\u0639\u062f\u062f\u0646\u0627)\s*([0-9]{1,2})/i,
		/([0-9]{1,2})\s*(?:\u0627\u0634\u062e\u0627\u0635|\u0623\u0634\u062e\u0627\u0635|\u0627\u0641\u0631\u0627\u062f|\u0623\u0641\u0631\u0627\u062f|\u0636\u064a\u0648\u0641|\u0646\u0641\u0631|\u0633\u0631\u064a\u0631|\u0627\u0633\u0631\u0647|\u0627\u0633\u0631\u0629|\u0623\u0633\u0631\u0629|\u0628\u0627\u0644\u063a)/i,
		/(?:\u0627\u0634\u062e\u0627\u0635|\u0623\u0634\u062e\u0627\u0635|\u0627\u0641\u0631\u0627\u062f|\u0623\u0641\u0631\u0627\u062f|\u0636\u064a\u0648\u0641|\u0646\u0641\u0631|\u0633\u0631\u064a\u0631|\u0627\u0633\u0631\u0647|\u0627\u0633\u0631\u0629|\u0623\u0633\u0631\u0629|\u0628\u0627\u0644\u063a)\s*[:= -]*([0-9]{1,2})/i,
	];
	for (const pattern of patterns) {
		const match = lower.match(pattern) || arabic.match(pattern);
		if (match?.[1]) addCount(match[1]);
	}
	if (
		/\b(?:more\s+than|over|above)\s*5\b/i.test(lower) ||
		/(?:\u0627\u0643\u062b\u0631|\u0627\u0643\u062a\u0631|\u0627\u0632\u064a\u062f|\u0641\u0648\u0642)\s*(?:\u0645\u0646\s*)?5/i.test(
			arabic
		) ||
		/(?:morethan|over|above)5/i.test(latinCompact)
	) {
		addCount(6);
	}
	if (counts.length) return Math.max(...counts);
	return mapRoomToKey(raw) === "familyRooms" ? 5 : null;
}

function extraBedBeyondFiveRequestText(text = "") {
	const raw = String(text || "");
	if (!raw.trim()) return false;
	const normalized = normalizeNumberWordsForParsing(raw);
	const { lower, arabic, latinCompact } = normalizeControlText(normalized);
	const wantsExtraBed =
		/\b(?:add|adding|extra|additional|rollaway|spare)\s+(?:bed|beds)\b/i.test(
			lower
		) ||
		/\b(?:bed|beds)\s+(?:extra|additional|rollaway)\b/i.test(lower) ||
		/(?:\u0633\u0631\u064a\u0631\s+(?:\u0632\u064a\u0627\u062f\u0629|\u0627\u0636\u0627\u0641\u064a|\u0625\u0636\u0627\u0641\u064a)|\u0627\u0636\u0627\u0641(?:\u0629)?\s+\u0633\u0631\u064a\u0631|\u0646\u0636\u064a\u0641\s+\u0633\u0631\u064a\u0631|\u0627\u0636\u064a\u0641\s+\u0633\u0631\u064a\u0631)/i.test(
			arabic
		) ||
		/(?:extrabed|additionalbed|rollawaybed|addbed)/i.test(latinCompact);
	if (!wantsExtraBed) return false;
	const count = requestedGuestCountFromText(raw);
	return (
		count > 5 ||
		mapRoomToKey(raw) === "familyRooms" ||
		/\b(?:5|five)\s*(?:bed|beds|people|persons?|guests?)\b/i.test(lower) ||
		/(?:\u062e\u0645\u0627\u0633|\u0639\u0627\u0626\u0644\u064a|\u063a\u0631\u0641\u0629\s*5|5\s*(?:\u0633\u0631\u064a\u0631|\u0627\u0633\u0631\u0647|\u0627\u0633\u0631\u0629|\u0623\u0633\u0631\u0629))/i.test(
			arabic
		)
	);
}

function largeGroupDateAskText(sc = {}, st = {}) {
	const name = respectfulGuestName(sc, st);
	const lang = languageOf(sc, st);
	const checkin = localizedGregorianDate(st.slots?.checkinISO, lang);
	const checkout = localizedGregorianDate(st.slots?.checkoutISO, lang);
	if (/arabic/i.test(lang)) {
		if (checkin && !checkout) {
			return `ما تاريخ المغادرة حتى أراجع التوفر والسعر للتجهيز بالكامل؟`;
		}
		if (!checkin && checkout) {
			return `ما تاريخ الوصول حتى أراجع التوفر والسعر للتجهيز بالكامل؟`;
		}
		return `أرسل لي تاريخ الوصول وتاريخ المغادرة معاً، وسأراجع لك التوفر والسعر للتجهيز بالكامل.`;
	}
	if (checkin && !checkout) {
		return `What checkout date should I check for the full room setup?`;
	}
	if (!checkin && checkout) {
		return `What check-in date should I check for the full room setup?`;
	}
	return `${name}, please send both the check-in and checkout dates together and I will check the full room setup for you.`;
}

function priceLargeGroupRoomCombination(hotel = {}, checkinISO = "", checkoutISO = "") {
	const familyQuote = safePriceRoomForStay(
		hotel,
		{ roomType: "familyRooms" },
		checkinISO,
		checkoutISO
	);
	const doubleQuote = safePriceRoomForStay(
		hotel,
		{ roomType: "doubleRooms" },
		checkinISO,
		checkoutISO
	);
	const available = Boolean(familyQuote?.available && doubleQuote?.available);
	const total = available
		? Number(
				(
					safeNum(familyQuote.totals?.totalPriceWithCommission, 0) +
					safeNum(doubleQuote.totals?.totalPriceWithCommission, 0)
				).toFixed(2)
		  )
		: 0;
	return {
		available,
		familyQuote,
		doubleQuote,
		nights: familyQuote?.nights || doubleQuote?.nights || 0,
		currency:
			familyQuote?.currency || doubleQuote?.currency || hotel?.currency || "SAR",
		total,
	};
}

function largeGroupRoomRecommendationText(sc = {}, st = {}, details = {}) {
	const name = respectfulGuestName(sc, st);
	const lang = languageOf(sc, st);
	const isArabic = /arabic/i.test(lang);
	const hotelName = localizedHotelName(sc, st);
	const guestCount = Math.max(6, Number(details.guestCount || 6));
	const guestText = localizedNumber(guestCount, lang);
	const familyRooms = Array.isArray(details.familyRooms) ? details.familyRooms : [];
	const doubleRooms = Array.isArray(details.doubleRooms) ? details.doubleRooms : [];
	const hasCoreRooms = Boolean(familyRooms.length && doubleRooms.length);
	const optionLabel = (options, fallback) => {
		if (isArabic) {
			const arabicName = options
				.map((option) => String(option?.displayNameOther || "").trim())
				.find((value) => value && hasArabicScript(value));
			return arabicName || fallback;
		}
		return inlineRoomOptions(options.slice(0, 1), lang) || fallback;
	};
	const familyLabel = optionLabel(
		familyRooms,
		isArabic
			? "\u063a\u0631\u0641\u0629 \u062e\u0645\u0627\u0633\u064a\u0629 / \u0639\u0627\u0626\u0644\u064a\u0629"
			: "quintuple/family room"
	);
	const doubleLabel = optionLabel(
		doubleRooms,
		isArabic ? "\u063a\u0631\u0641\u0629 \u0645\u0632\u062f\u0648\u062c\u0629" : "double room"
	);
	const quote = details.combinationQuote || null;
	const datesKnown = Boolean(st.slots?.checkinISO && st.slots?.checkoutISO);
	const extraRoomNote =
		guestCount > 7
			? isArabic
				? ` ولأن العدد ${guestText}، قد نضيف غرفة مناسبة أخرى بعد مراجعة العدد النهائي حتى يكون الجميع مرتاحاً.`
				: ` Since the party is ${guestText}, reception may add another suitable room after checking the exact adults and children so everyone is comfortable.`
			: "";
	const compliance = isArabic
		? `ولا يمكن إضافة سرير سادس داخل غرفة واحدة؛ حسب تعليمات الفنادق في السعودية ابتداءً من 2026 لا يسمح بتجاوز 5 أسرّة في غرفة واحدة.`
		: `We also cannot add a sixth bed inside one room; under Saudi hotel compliance rules starting in 2026, a single hotel room cannot go above 5 beds.`;
	if (isArabic) {
		const setup = `${name}، لـ${guestText} ضيوف أفضل ترتيب مريح ومناسب هو ${familyLabel} لـ5 ضيوف + ${doubleLabel} إضافية. هذا يعطيكم مساحة وخصوصية أفضل بدل ضغط الجميع في غرفة واحدة. ${compliance}${extraRoomNote}`;
		if (!hasCoreRooms) {
			const review = `لا أرى حالياً الغرفة الخماسية والغرفة المزدوجة معاً مفعلة للتأكيد التلقائي في ${hotelName}، لذلك الأفضل أن يراجع الاستقبال أقرب ترتيب آمن ومريح لكم.`;
			return datesKnown
				? `${setup} ${review} سأطلب مراجعة هذا التجهيز للتواريخ المطلوبة.`
				: `${setup} ${review} ${largeGroupDateAskText(sc, st)}`;
		}
		if (datesKnown && quote?.available) {
			const totalText = localizedMoney(quote.total, quote.currency, lang);
			const nightsText = localizedNumber(quote.nights || 0, lang);
			return `${setup} للتواريخ المطلوبة في ${hotelName}، أرى هذا التجهيز بسعر إجمالي ${totalText} لمدة ${nightsText} ليلة. إذا يناسبك هذا الترتيب، سأجعل فريق الاستقبال يراجعه ويكمل الحجز لك.`;
		}
		if (datesKnown && quote && !quote.available) {
			return `${setup} للتواريخ المطلوبة لا أستطيع تأكيد الغرفتين معاً تلقائياً الآن، لكن أقدر أراجع لك أقرب ترتيب مناسب مع الاستقبال. هل عندك مرونة في التواريخ أو تفضل أن أطلب مراجعة الفريق؟`;
		}
		return `${setup} ${largeGroupDateAskText(sc, st)}`;
	}
	const setup = `${name}, for ${guestText} guests, the most comfortable professional setup is 1 ${familyLabel} for 5 guests + 1 additional ${doubleLabel}. This gives the group better space and privacy instead of squeezing everyone into one room. ${compliance}${extraRoomNote}`;
	if (!hasCoreRooms) {
		const review = `I do not currently see both the quintuple/family room and the double room active for automatic confirmation at ${hotelName}, so reception should review the closest safe and comfortable setup for you.`;
		return datesKnown
			? `${setup} ${review} I will ask reception to review this setup for the requested dates.`
			: `${setup} ${review} ${largeGroupDateAskText(sc, st)}`;
	}
	if (datesKnown && quote?.available) {
		const totalText = localizedMoney(quote.total, quote.currency, lang);
		const nightsText = localizedNumber(quote.nights || 0, lang);
		return `${setup} For the requested dates at ${hotelName}, I see this setup at ${totalText} total for ${nightsText} night${quote.nights === 1 ? "" : "s"}. If this works for you, I will have reception review and complete this two-room reservation for you.`;
	}
	if (datesKnown && quote && !quote.available) {
		return `${setup} For the requested dates, I cannot automatically confirm both rooms together right now, but I can help reception review the closest suitable setup. Do you have date flexibility, or should I ask the team to review it?`;
	}
	return `${setup} ${largeGroupDateAskText(sc, st)}`;
}

async function answerLargeGroupRoomRecommendation(
	io,
	sc,
	st,
	userText = "",
	guestCount = null
) {
	if (st.activeTurnHadReply) {
		logStep(String(sc._id), "large_group.skip_after_reply", {
			waitFor: st.waitFor,
		});
		return true;
	}
	const count =
		guestCount ||
		requestedGuestCountFromText(userText) ||
		st.pendingRoomCombination?.guestCount ||
		6;
	const familyRooms = activeHotelRoomSummaries(st.hotel, "familyRooms");
	const doubleRooms = activeHotelRoomSummaries(st.hotel, "doubleRooms");
	if (count > 0 && !st.slots.adultsProvided) {
		st.slots.adults = count;
		st.slots.adultsProvided = true;
		st.slots.children = 0;
		st.slots.childrenProvided = true;
	}
	st.slots.roomTypeKey = null;
	st.quote = null;
	st.quoteSummarizedAt = 0;
	const hasDates = Boolean(st.slots.checkinISO && st.slots.checkoutISO);
	const combinationQuote =
		hasDates && familyRooms.length && doubleRooms.length
			? priceLargeGroupRoomCombination(
					st.hotel,
					st.slots.checkinISO,
					st.slots.checkoutISO
			  )
			: null;
	st.pendingRoomCombination = {
		guestCount: count,
		primaryRoomTypeKey: "familyRooms",
		secondaryRoomTypeKey: "doubleRooms",
		checkinISO: st.slots.checkinISO || null,
		checkoutISO: st.slots.checkoutISO || null,
		quotedAt: combinationQuote?.available ? now() : 0,
		total: combinationQuote?.available ? combinationQuote.total : null,
		currency: combinationQuote?.currency || st.hotel?.currency || "SAR",
	};
	const sent = await humanSend(
		io,
		sc,
		st,
		largeGroupRoomRecommendationText(sc, st, {
			guestCount: count,
			familyRooms,
			doubleRooms,
			combinationQuote,
		})
	);
	if (!sent) return true;
	if (combinationQuote?.available) {
		st.waitFor = "large_group_confirm";
		stampAsk(st, "large_group_confirm");
	} else if (hasDates) {
		st.waitFor = "clarify";
	} else {
		st.waitFor = "dates";
		stampAsk(st, "dates");
	}
	logStep(String(sc._id), "large_group.recommendation", {
		guestCount: count,
		hasFamilyRoom: Boolean(familyRooms.length),
		hasDoubleRoom: Boolean(doubleRooms.length),
		hasDates,
		combinationAvailable: Boolean(combinationQuote?.available),
		waitFor: st.waitFor,
	});
	return true;
}

function largeGroupConfirmPromptText(sc = {}, st = {}) {
	const lang = languageOf(sc, st);
	if (/arabic/i.test(lang)) {
		return `${respectfulGuestName(sc, st)}، هل يناسبك ترتيب الغرفة الخماسية مع الغرفة المزدوجة حتى أطلب من الاستقبال مراجعته وإكماله لك؟`;
	}
	return `${respectfulGuestName(sc, st)}, does the quintuple/family room plus double room setup work for you so I can have reception review and complete it?`;
}

async function handlePendingLargeGroupCombination(io, sc, st, userText = "") {
	if (!st.pendingRoomCombination) return false;
	const dateRange = extractDateRange(userText);
	if (dateRange.checkinISO && dateRange.checkoutISO) {
		const dateMerge = await mergeDateRangeWithChangeGuard(io, sc, st, dateRange, {
			source: "large_group_combination",
			userText,
		});
		if (dateMerge.prompted) return true;
		await answerLargeGroupRoomRecommendation(
			io,
			sc,
			st,
			userText,
			st.pendingRoomCombination.guestCount
		);
		return true;
	}
	const updatedGuestCount = requestedGuestCountFromText(userText);
	if (updatedGuestCount > 5 || extraBedBeyondFiveRequestText(userText)) {
		await answerLargeGroupRoomRecommendation(
			io,
			sc,
			st,
			userText,
			updatedGuestCount > 5 ? updatedGuestCount : st.pendingRoomCombination.guestCount || 6
		);
		return true;
	}
	const singleDate = extractSingleStayDate(userText, st);
	if (singleDate?.raw) {
		const dateMerge = await mergePartialDateRangeWithChangeGuard(
			io,
			sc,
			st,
			singleDate,
			{ source: "large_group_single_date", userText }
		);
		if (dateMerge.prompted) return true;
		if (dateMerge.invalid) {
			await askForMissingStayDates(io, sc, st);
			return true;
		}
		await askForMissingStayDates(io, sc, st);
		return true;
	}
	if (confirmsText(userText)) {
		await handoffToHuman(io, sc, st, "reservation_finalize");
		return true;
	}
	if (declinesText(userText)) {
		st.pendingRoomCombination = null;
		await askRoomPreferenceForReservation(io, sc, st);
		return true;
	}
	if (st.waitFor === "large_group_confirm") {
		if (
			selectedHotelFactQuestionText(userText) ||
			wantsDiscountQuestion(userText) ||
			wantsPaymentHelp(userText) ||
			hotelContactDetailsQuestionText(userText) ||
			hotelContactFollowupQuestionText(sc, userText) ||
			(/[?\u061f]/.test(String(userText || "")) &&
				!selectedHotelRoomQuestionText(userText))
		) {
			return false;
		}
		await humanSend(io, sc, st, largeGroupConfirmPromptText(sc, st));
		stampAsk(st, "large_group_confirm");
		return true;
	}
	return false;
}

function stayDateRequestText(sc = {}, st = {}, { missing = "both" } = {}) {
	const name = respectfulGuestName(sc, st);
	const lang = languageOf(sc, st);
	const checkin = localizedGregorianDate(st.slots?.checkinISO, lang);
	const checkout = localizedGregorianDate(st.slots?.checkoutISO, lang);
	if (/arabic/i.test(lang)) {
		if (missing === "checkout" && checkin) {
			return `${name}\u060c \u062a\u0645\u0627\u0645\u060c \u0648\u0635\u0644\u0646\u064a \u062a\u0627\u0631\u064a\u062e \u0627\u0644\u0648\u0635\u0648\u0644 ${checkin}. \u0645\u0627 \u062a\u0627\u0631\u064a\u062e \u0627\u0644\u0645\u063a\u0627\u062f\u0631\u0629\u061f`;
		}
		if (missing === "checkin" && checkout) {
			return `${name}\u060c \u0648\u0635\u0644\u0646\u064a \u062a\u0627\u0631\u064a\u062e \u0627\u0644\u0645\u063a\u0627\u062f\u0631\u0629 ${checkout}. \u0645\u0627 \u062a\u0627\u0631\u064a\u062e \u0627\u0644\u0648\u0635\u0648\u0644\u061f`;
		}
		return `${name}\u060c \u0645\u0646 \u0641\u0636\u0644\u0643 \u0623\u0631\u0633\u0644 \u062a\u0627\u0631\u064a\u062e \u0627\u0644\u0648\u0635\u0648\u0644 \u0648\u062a\u0627\u0631\u064a\u062e \u0627\u0644\u0645\u063a\u0627\u062f\u0631\u0629 \u0645\u0639\u0627\u064b \u0644\u0623\u0631\u0627\u062c\u0639 \u0627\u0644\u062a\u0648\u0641\u0631 \u0648\u0627\u0644\u0633\u0639\u0631 \u0628\u062f\u0642\u0629.`;
	}
	if (/spanish/i.test(lang)) {
		if (missing === "checkout" && checkin) {
			return `${name}, perfecto, tengo la llegada para ${checkin}. Cual seria la fecha de salida?`;
		}
		if (missing === "checkin" && checkout) {
			return `${name}, tengo la salida para ${checkout}. Cual seria la fecha de llegada?`;
		}
		return `${name}, por favor enviame la fecha de llegada y la fecha de salida juntas para revisar disponibilidad y precio exacto.`;
	}
	if (/french/i.test(lang)) {
		if (missing === "checkout" && checkin) {
			return `${name}, parfait, j'ai la date d'arrivee: ${checkin}. Quelle est la date de depart ?`;
		}
		if (missing === "checkin" && checkout) {
			return `${name}, j'ai la date de depart: ${checkout}. Quelle est la date d'arrivee ?`;
		}
		return `${name}, veuillez m'envoyer la date d'arrivee et la date de depart ensemble afin que je verifie la disponibilite et le prix exact.`;
	}
	if (missing === "checkout" && checkin) {
		return `${name}, perfect, I have the check-in date as ${checkin}. What is the checkout date?`;
	}
	if (missing === "checkin" && checkout) {
		return `${name}, I have the checkout date as ${checkout}. What is the check-in date?`;
	}
	return `${name}, please send both the check-in and checkout dates together so I can check exact availability and pricing.`;
}

async function askForMissingStayDates(
	io,
	sc,
	st,
	{ fast = false, targetReplyMs = null } = {}
) {
	const missing =
		st.slots?.checkinISO && !st.slots?.checkoutISO
			? "checkout"
			: !st.slots?.checkinISO && st.slots?.checkoutISO
			? "checkin"
			: "both";
	const sent = await humanSend(io, sc, st, stayDateRequestText(sc, st, { missing }), {
		fast,
		targetReplyMs,
	});
	if (sent) stampAsk(st, "dates");
	st.waitFor = "dates";
	return sent;
}

function shouldAskRoomPreferenceFirst(userText = "", st = {}, lu = {}, decision = {}) {
	if (st.slots?.roomTypeKey) return false;
	if (explicitlyExistingReservationIntent(userText)) return false;
	if (wantsPaymentHelp(userText) || humanHandoffReason(userText)) return false;
	if (st.waitFor === "room") return true;
	if (wantsNewReservationIntent(userText, lu)) return true;
	if (
		decision?.action === "continue_booking" ||
		decision?.action === "ask_dates_for_price"
	) {
		return true;
	}
	return false;
}

async function askRoomPreferenceForReservation(
	io,
	sc,
	st,
	{ fast = false, targetReplyMs = null } = {}
) {
	const sent = await humanSend(io, sc, st, roomPreferenceSalesText(sc, st), {
		fast,
		targetReplyMs,
	});
	if (!sent) return false;
	st.waitFor = "room";
	stampAsk(st, "room");
	return true;
}

async function answerSelectedHotelRoomQuestion(
	io,
	sc,
	st,
	userText,
	roomTypeKey = null
) {
	const wantsGeneralRoomOptions = generalRoomOptionsQuestionText(userText);
	if (wantsGeneralRoomOptions) roomTypeKey = null;
	const previousWaitFor = st.waitFor || null;
	const latestDates = extractDateRange(userText);
	if (
		latestDates.checkinISO &&
		latestDates.checkoutISO &&
		!needsExplicitPastDateClarification(userText, latestDates)
	) {
		const dateMerge = await mergeDateRangeWithChangeGuard(io, sc, st, latestDates, {
			source: "selected_room_question",
			userText,
		});
		if (dateMerge.prompted) return true;
	}
	if (st.activeTurnHadReply) {
		logStep(String(sc._id), "room_question.skip_after_reply", {
			roomTypeKey,
			waitFor: st.waitFor,
		});
		return true;
	}
	const hotelName = toTitle(st.hotel?.hotelName || "the hotel");
	if (negatedGuestCountCorrectionText(userText)) {
		const activeRooms = activeHotelRoomSummaries(st.hotel).slice(0, 8);
		const fallbackText = `${respectfulGuestName(sc, st)}, you are right. I should not have assumed that guest count. The available room types at ${localizedHotelName(sc, st)} are:\n${roomOptionsBullets(activeRooms, languageOf(sc, st))}\n\nWhich room type would you prefer?`;
		const sent = await sendDynamicWrittenReply(
			io,
			sc,
			st,
			userText,
			`The guest corrected us because we wrongly assumed a guest count or repeated a capacity claim from a previous assistant message. Apologize clearly, say we should not assume that guest count, then answer helpfully by listing the active room types at "${hotelName}" from activeRoomOptions only. Do not repeat the disputed guest count. Do not mention a multi-room setup, extra beds, Saudi compliance, or dates until after the room list. Ask which room type they prefer.`,
			{
				selectedHotel: hotelName,
				activeRoomOptions: roomListFactsForOpenAi(activeRooms, languageOf(sc, st)),
				fallbackText,
				slots: st.slots,
			},
			{ fallbackText, targetReplyMs: AI_BOOKING_PROMPT_TARGET_MS }
		);
		if (sent) {
			st.waitFor = "room";
			stampAsk(st, "room");
		}
		return true;
	}
	if (selectedHotelRoomDetailsQuestionText(userText)) {
		const selectedRoomTypeKey =
			wantsGeneralRoomOptions
				? null
				: roomTypeKey || st.slots?.roomTypeKey || mapRoomToKey(userText) || null;
		const detailRooms = selectedRoomTypeKey
			? activeHotelRoomSummaries(st.hotel, selectedRoomTypeKey)
			: activeHotelRoomSummaries(st.hotel).slice(0, 6);
		const fallbackText = roomDetailsSummaryText(
			sc,
			st,
			detailRooms,
			selectedRoomTypeKey
		);
		const sent = await sendDynamicWrittenReply(
			io,
			sc,
			st,
			userText,
			`The guest asked for room details at "${hotelName}". Answer only from roomDetails and activeHotelFacts. Use the saved display names naturally, summarize the most useful details in concise hospitality wording, and do not invent amenities, views, sizes, beds, prices, or policies. If details are missing, say what is not currently shown and keep the next booking step helpful.`,
			{
				selectedHotel: hotelName,
				requestedRoomTypeKey: selectedRoomTypeKey,
				roomDetails: detailRooms,
				fallbackText,
				slots: st.slots,
			},
			{ fallbackText, targetReplyMs: AI_BOOKING_PROMPT_TARGET_MS }
		);
		if (sent) {
			if (selectedRoomTypeKey && detailRooms.length) {
				st.slots.roomTypeKey = selectedRoomTypeKey;
			}
			if (aiReservationReference(sc)) {
				st.waitFor = "post_booking_followup";
				st.reviewSent = false;
			} else {
				st.waitFor =
					previousWaitFor ||
					(selectedRoomTypeKey ? "dates" : "room");
				if (st.waitFor === "dates" || st.waitFor === "room") {
					stampAsk(st, st.waitFor);
				}
			}
		}
		logStep(String(sc._id), "selected_hotel.room_details_reply", {
			roomTypeKey: selectedRoomTypeKey || "",
			roomCount: detailRooms.length,
			waitFor: st.waitFor || "",
		});
		return true;
	}
	const requestedGuestCount = requestedGuestCountFromText(userText);
	if (requestedGuestCount > 5 || extraBedBeyondFiveRequestText(userText)) {
		return answerLargeGroupRoomRecommendation(
			io,
			sc,
			st,
			userText,
			requestedGuestCount > 5 ? requestedGuestCount : 6
		);
	}
	const matchingRooms = roomTypeKey
		? activeHotelRoomSummaries(st.hotel, roomTypeKey)
		: [];
	const activeRooms = activeHotelRoomSummaries(st.hotel).slice(0, 8);
	const recommendedRoomTypeKey = recommendedRoomTypeKeyForGuestCount(requestedGuestCount);
	if (!roomTypeKey && recommendedRoomTypeKey) {
		const recommendedRooms = activeHotelRoomSummaries(
			st.hotel,
			recommendedRoomTypeKey
		);
		if (recommendedRooms.length) {
			st.slots.roomTypeKey = recommendedRoomTypeKey;
			if (st.slots.checkinISO && st.slots.checkoutISO) {
				logStep(String(sc._id), "selected_hotel.room_fit_quote", {
					guestCount: requestedGuestCount,
					roomTypeKey: recommendedRoomTypeKey,
					checkinISO: st.slots.checkinISO,
					checkoutISO: st.slots.checkoutISO,
				});
				await shareKnownStayQuote(io, sc, st);
				return true;
			}
			const fallbackText = roomGuestCountRecommendationText(
				sc,
				st,
				requestedGuestCount,
				recommendedRoomTypeKey,
				recommendedRooms
			);
			const sent = await sendDynamicWrittenReply(
				io,
				sc,
				st,
				userText,
				`The guest gave a guest count for "${hotelName}". Recommend the matching active room type from provided recommendedRooms, explain briefly why it fits, then ask for both check-in and checkout dates if pricing is needed. Do not mention unavailable room types or other hotels.`,
				{
					selectedHotel: hotelName,
					guestCount: requestedGuestCount,
					recommendedRoomTypeKey,
					recommendedRooms,
					fallbackText,
					slots: st.slots,
				},
				{ fallbackText, targetReplyMs: AI_BOOKING_PROMPT_TARGET_MS }
			);
			if (sent) {
				st.waitFor = "dates";
				stampAsk(st, "dates");
			}
			return true;
		}
	}
	if (!roomTypeKey && activeRooms.length) {
		const fallbackText = roomOptionsListText(sc, st, activeRooms);
		const sent = await sendDynamicWrittenReply(
			io,
			sc,
			st,
			userText,
			`The guest asked what rooms are available at "${hotelName}". You MUST list every active room option in activeRoomOptions exactly once, using the saved displayName/displayNameOther naturally in the guest's language. This is a room-list question, not a specific room recommendation. Do not focus on only one room. Do not mention room descriptions, amenities, prices, guest counts, or capacity unless capacityNote is supplied. Do not invent unavailable rooms, prices, or other hotels. After the list, ask which room type they prefer; ask for dates only if they ask for price.`,
			{
				selectedHotel: hotelName,
				activeRoomOptions: roomListFactsForOpenAi(activeRooms, languageOf(sc, st)),
				fallbackText,
				slots: st.slots,
			},
			{ fallbackText, targetReplyMs: AI_BOOKING_PROMPT_TARGET_MS }
		);
		if (sent) {
			st.waitFor = "room";
			stampAsk(st, "room");
		}
		return true;
	}
	if (
		roomTypeKey &&
		matchingRooms.length &&
		st.slots.checkinISO &&
		st.slots.checkoutISO
	) {
		st.slots.roomTypeKey = roomTypeKey;
		await shareKnownStayQuote(io, sc, st);
		return true;
	}
	if (roomTypeKey && matchingRooms.length) {
		st.slots.roomTypeKey = roomTypeKey;
		const fallbackText = roomFitSalesIntroText(sc, st, roomTypeKey, matchingRooms);
		const sent = await sendDynamicWrittenReply(
			io,
			sc,
			st,
			userText,
			`The guest asked about a specific room type at "${hotelName}". Confirm the matching active room exists using matchingRooms, mention the fit/capacity if available, and ask for check-in and checkout dates together so availability and price can be checked. Keep it warm and sales-capable, but do not invent prices or other hotel options.`,
			{
				selectedHotel: hotelName,
				requestedRoomTypeKey: roomTypeKey,
				matchingRooms,
				fallbackText,
				slots: st.slots,
			},
			{ fallbackText, targetReplyMs: AI_BOOKING_PROMPT_TARGET_MS }
		);
		if (sent) {
			st.waitFor = "dates";
			stampAsk(st, "dates");
		}
		return true;
	}
	const instruction = roomTypeKey
		? matchingRooms.length
			? `The guest is asking whether the selected hotel has a room that fits their requested type/capacity. Answer only for "${hotelName}". Lead with the answer, not with a date question. Use a natural hospitality/sales tone: confirm that the matching room exists, mention why the provided matching room name fits the guest's capacity, and sound pleased to help. Mention only the matching room name(s) provided; do not list other hotels, compare hotels, link other hotels, or imply knowledge of other hotels under any circumstance. If dates are missing, ask for both arrival/check-in and departure/checkout dates together in the same sentence so availability and price can be checked. Never ask only for check-in.`
			: `The guest is asking whether the selected hotel has the requested room type. Answer only for "${hotelName}". Say you do not currently see that room type listed as active for this hotel. Ask one helpful follow-up about another room type at this hotel or different dates at this hotel. Do not mention, recommend, link, compare, or imply knowledge of any other hotel.`
		: `The guest is asking about rooms at the selected hotel. Answer only for "${hotelName}" using the provided active room options, then ask the single most useful next booking question. Never mention, recommend, link, compare, or imply knowledge of any other hotel, even if the guest asks for alternatives.`;
	const fallbackText =
		roomTypeKey && matchingRooms.length
			? roomFitSalesIntroText(sc, st, roomTypeKey, matchingRooms)
			: activeRooms.length
			? roomOptionsListText(sc, st, activeRooms)
			: roomDetailsSummaryText(sc, st, matchingRooms, roomTypeKey || "");
	const sent = await sendDynamicWrittenReply(
		io,
		sc,
		st,
		userText,
		instruction,
		{
			selectedHotel: hotelName,
			requestedRoomTypeKey: roomTypeKey,
			matchingRooms: matchingRooms.slice(0, 3),
			activeRoomOptions: matchingRooms.length
				? []
				: roomListFactsForOpenAi(activeRooms, languageOf(sc, st)),
			fallbackText,
			slots: st.slots,
		},
		{ fallbackText, targetReplyMs: AI_BOOKING_PROMPT_TARGET_MS }
	);
	if (sent) {
		if (roomTypeKey) st.slots.roomTypeKey = roomTypeKey;
		st.waitFor = roomTypeKey && matchingRooms.length ? "dates" : "room";
		if (st.waitFor) stampAsk(st, st.waitFor);
	}
	return true;
}

function cleanHotelFactValue(value) {
	if (value === null || value === undefined) return "";
	if (typeof value === "number") {
		return Number.isFinite(value) && value > 0 ? String(value) : "";
	}
	const text = cleanHotelFactText(value);
	if (!text || text === "0") return "";
	return text;
}

function formatHotelFactText(value, lang = "English") {
	const text = cleanHotelFactValue(value);
	if (!text) return "";
	if (/arabic/i.test(lang)) return arabicDigits(text);
	if (hasArabicScript(text)) return text;
	return toTitle(text);
}

function localizedMinuteDuration(numericAmount, lang = "English") {
	const amount = localizedNumber(numericAmount, lang);
	if (/arabic/i.test(lang)) {
		if (numericAmount === 1) return "\u062f\u0642\u064a\u0642\u0629 \u0648\u0627\u062d\u062f\u0629";
		if (numericAmount === 2) return "\u062f\u0642\u064a\u0642\u062a\u064a\u0646";
		if (Number.isInteger(numericAmount) && numericAmount >= 3 && numericAmount <= 10) {
			return `${amount} \u062f\u0642\u0627\u0626\u0642`;
		}
		return `${amount} \u062f\u0642\u064a\u0642\u0629`;
	}
	if (/spanish/i.test(lang)) return `${amount} ${numericAmount === 1 ? "minuto" : "minutos"}`;
	if (/french/i.test(lang)) return `${amount} ${numericAmount === 1 ? "minute" : "minutes"}`;
	if (/urdu/i.test(lang)) return `${amount} minutes`;
	if (/hindi/i.test(lang)) return `${amount} minutes`;
	if (/indonesian/i.test(lang)) return `${amount} menit`;
	if (/malay|malaysia/i.test(lang)) return `${amount} minit`;
	return `${amount} ${numericAmount === 1 ? "minute" : "minutes"}`;
}

function parseMinuteDuration(value = "") {
	const normalized = digitsToEnglish(String(value || ""))
		.replace(/\s+/g, " ")
		.trim();
	const minuteMatch = normalized.match(
		/^(?:about|around|approx\.?|approximately|nearly|\u062a\u0642\u0631\u064a\u0628\u0627|\u062d\u0648\u0627\u0644\u064a)?\s*(\d+(?:\.\d+)?)\s*(?:min|mins|minute|minutes|mns?|دقيقة|دقيقه|دقائق|دقايق)\.?\s*$/i
	);
	if (!minuteMatch) return null;
	const numericAmount = Number(minuteMatch[1]);
	if (!Number.isFinite(numericAmount) || numericAmount <= 0) return null;
	return numericAmount;
}

function formatHotelDistanceValue(value, lang = "English") {
	const text = cleanHotelFactValue(value);
	if (!text) return "";
	const normalized = digitsToEnglish(text);
	const parsedMinutes = parseMinuteDuration(text);
	const numericMinutes =
		parsedMinutes !== null
			? parsedMinutes
			: /^\d+(?:\.\d+)?$/.test(normalized)
			? Number(normalized)
			: null;
	if (Number.isFinite(numericMinutes) && numericMinutes > 0) {
		return localizedMinuteDuration(numericMinutes, lang);
	}
	const numberMatch = text.match(/^\d+(?:\.\d+)?$/);
	if (numberMatch) {
		const numericAmount = Number(numberMatch[0]);
		const amount = localizedNumber(numericAmount, lang);
		if (/arabic/i.test(lang)) {
			if (numericAmount === 1) return "\u062f\u0642\u064a\u0642\u0629 \u0648\u0627\u062d\u062f\u0629";
			if (numericAmount === 2) return "\u062f\u0642\u064a\u0642\u062a\u064a\u0646";
			if (numericAmount >= 3 && numericAmount <= 10) {
				return `${amount} \u062f\u0642\u0627\u0626\u0642`;
			}
			return `${amount} \u062f\u0642\u064a\u0642\u0629`;
		}
		if (/spanish/i.test(lang)) return `${amount} minutos`;
		if (/french/i.test(lang)) return `${amount} minutes`;
		if (/urdu/i.test(lang)) return `${amount} منٹ`;
		if (/hindi/i.test(lang)) return `${amount} मिनट`;
		if (/indonesian/i.test(lang)) return `${amount} menit`;
		if (/malay|malaysia/i.test(lang)) return `${amount} minit`;
		return `${amount} minutes`;
	}
	return /arabic/i.test(lang) ? arabicDigits(text) : text;
}

function localizedJoin(parts = [], lang = "English") {
	const values = parts.map((part) => String(part || "").trim()).filter(Boolean);
	if (!values.length) return "";
	if (values.length === 1) return values[0];
	const last = values[values.length - 1];
	if (/arabic/i.test(lang)) {
		const head = values.slice(0, -1).join("\u060c ");
		return `${head} \u0648${last}`;
	}
	const head = values.slice(0, -1).join(", ");
	let conjunction = "and";
	if (/spanish/i.test(lang)) conjunction = "y";
	else if (/french/i.test(lang)) conjunction = "et";
	else if (/urdu/i.test(lang)) conjunction = "اور";
	else if (/hindi/i.test(lang)) conjunction = "और";
	else if (/indonesian|malay|malaysia/i.test(lang)) conjunction = "dan";
	return `${head} ${conjunction} ${last}`;
}

function hotelFactAddressLine(hotel = {}, lang = "English") {
	const parts = [
		formatHotelFactText(hotel.hotelAddress, lang),
		formatHotelFactText(hotel.hotelCity, lang),
		formatHotelFactText(hotel.hotelState, lang),
		formatHotelFactText(hotel.hotelCountry, lang),
	].filter(Boolean);
	return parts.join(/arabic/i.test(lang) ? "\u060c " : ", ");
}

function hotelBusDetailLine(details = "", lang = "English") {
	const rawDetailText = cleanHotelFactText(details).replace(/[.!?\u061f\u06d4]+$/g, "");
	if (!rawDetailText) return "";
	const englishLine = rawDetailText
		.replace(/\s*\n+\s*/g, ". ")
		.replace(/\bfrom\s+hotels?\s+to\b/gi, "from the hotel to")
		.replace(/\baway\s+from\s+the\s+hotels?\b/gi, "away from the hotel")
		.replace(/\bthe\s+hotels?\b/gi, "the hotel")
		.replace(/\bAl\s+gamarat\b/gi, "Al Gamarat")
		.replace(/\bal\s+haram\b/gi, "Al Haram")
		.replace(/\b5\s+daily\s+prayers\b/gi, "five daily prayers")
		.replace(/\s{2,}/g, " ")
		.trim();
	const knownGamaratPrayerBus =
		/(?:gamarat|jamarat|jamaraat)/i.test(rawDetailText) &&
		/(?:5|five).{0,24}(?:daily\s+)?prayers?/i.test(rawDetailText);
	if (knownGamaratPrayerBus) {
		if (/arabic/i.test(lang)) {
			return "خدمة الباص تكون من الفندق إلى محطة الجمرات، وهي تبعد حوالي 500 متر، ثم يتجه الباص إلى الحرم للصلوات الخمس اليومية";
		}
		if (/spanish/i.test(lang)) {
			return "El servicio de bus sale del hotel hacia la estacion Al Gamarat, a unos 500 metros, y luego va a Al Haram para las cinco oraciones diarias";
		}
		if (/french/i.test(lang)) {
			return "Le bus part de l'hotel vers la station Al Gamarat, a environ 500 metres, puis va a Al Haram pour les cinq prieres quotidiennes";
		}
		if (/urdu/i.test(lang)) {
			return "Bus service hotel se Al Gamarat station tak hai, jo taqriban 500 meters door hai, phir bus five daily prayers ke liye Al Haram jati hai";
		}
		if (/hindi/i.test(lang)) {
			return "Bus service hotel se Al Gamarat station tak hai, jo lagbhag 500 meters door hai, phir bus five daily prayers ke liye Al Haram jati hai";
		}
		if (/indonesian/i.test(lang)) {
			return "Layanan bus berangkat dari hotel ke stasiun Al Gamarat, sekitar 500 meter dari hotel, lalu menuju Al Haram untuk lima waktu salat";
		}
		if (/malay|malaysia/i.test(lang)) {
			return "Perkhidmatan bus bergerak dari hotel ke stesen Al Gamarat, kira-kira 500 meter dari hotel, kemudian ke Al Haram untuk lima waktu solat";
		}
	}
	if (/english/i.test(lang)) return englishLine;
	if (/arabic/i.test(lang) && hasArabicScript(rawDetailText)) return rawDetailText;
	if (!/arabic/i.test(lang) && !hasArabicScript(rawDetailText)) return englishLine;
	return "";
}

function hotelFactNextStepText(sc = {}, st = {}) {
	const lang = languageOf(sc, st);
	const pivot = nextPivot(st);
	if (aiReservationReference(sc) || st.waitFor === "post_booking_followup") {
		if (/arabic/i.test(lang)) return "\u0647\u0644 \u0623\u0633\u0627\u0639\u062f\u0643 \u0641\u064a \u0623\u064a \u0634\u064a\u0621 \u0622\u062e\u0631\u061f";
		if (/spanish/i.test(lang)) return "Puedo ayudarte con algo mas?";
		if (/french/i.test(lang)) return "Puis-je vous aider avec autre chose ?";
		if (/urdu/i.test(lang)) return "Kya main aap ki kisi aur cheez mein madad kar sakta/sakti hoon?";
		if (/hindi/i.test(lang)) return "Kya main aapki kisi aur cheez mein madad kar sakta/sakti hoon?";
		if (/indonesian/i.test(lang)) return "Apakah ada hal lain yang bisa saya bantu?";
		if (/malay|malaysia/i.test(lang)) return "Ada apa-apa lagi yang boleh saya bantu?";
		return "Can I help with anything else?";
	}
	if (pivot === "proceed" && bookingNudgePaused(st)) {
		if (/arabic/i.test(lang)) return "\u0623\u0646\u0627 \u0647\u0646\u0627 \u0625\u0630\u0627 \u0627\u062d\u062a\u062c\u062a \u0623\u064a \u062a\u0641\u0627\u0635\u064a\u0644 \u0623\u062e\u0631\u0649.";
		if (/spanish/i.test(lang)) return "Estoy aqui si necesitas cualquier otro detalle.";
		if (/french/i.test(lang)) return "Je reste disponible si vous avez besoin d'un autre detail.";
		if (/urdu/i.test(lang)) return "Aap ko koi aur detail chahiye ho to main yahin hoon.";
		if (/hindi/i.test(lang)) return "Aapko koi aur detail chahiye ho to main yahin hoon.";
		if (/indonesian/i.test(lang)) return "Saya tetap di sini jika Anda membutuhkan detail lain.";
		if (/malay|malaysia/i.test(lang)) return "Saya masih di sini jika anda perlukan butiran lain.";
		return "I am here if you need any other details.";
	}
	if (/arabic/i.test(lang)) {
		if (pivot === "proceed") {
			return "\u0648\u0625\u0630\u0627 \u0627\u0644\u0645\u0648\u0642\u0639 \u0645\u0646\u0627\u0633\u0628 \u0644\u0643\u060c \u0623\u062a\u0627\u0628\u0639 \u0625\u0644\u0649 \u0645\u0631\u0627\u062c\u0639\u0629 \u0627\u0644\u062d\u062c\u0632\u061f";
		}
		if (pivot === "dates") {
			return "\u0625\u0630\u0627 \u0627\u0644\u0645\u0648\u0642\u0639 \u0645\u0646\u0627\u0633\u0628 \u0644\u0643\u060c \u0623\u0631\u0633\u0644 \u0644\u064a \u062a\u0627\u0631\u064a\u062e \u0627\u0644\u0648\u0635\u0648\u0644 \u0648\u0627\u0644\u0645\u063a\u0627\u062f\u0631\u0629 \u0644\u0623\u0631\u0627\u062c\u0639 \u0627\u0644\u062a\u0648\u0641\u0631 \u0648\u0627\u0644\u0633\u0639\u0631 \u0628\u062f\u0642\u0629.";
		}
		if (pivot === "room") {
			return "\u0625\u0630\u0627 \u0627\u0644\u0645\u0648\u0642\u0639 \u0645\u0646\u0627\u0633\u0628 \u0644\u0643\u060c \u0645\u0627 \u0646\u0648\u0639 \u0627\u0644\u063a\u0631\u0641\u0629 \u0623\u0648 \u0639\u062f\u062f \u0627\u0644\u0636\u064a\u0648\u0641 \u0627\u0644\u0630\u064a \u062a\u0641\u0636\u0644\u0647\u061f";
		}
		return "\u0647\u0644 \u0623\u0633\u0627\u0639\u062f\u0643 \u0641\u064a \u0623\u064a \u062a\u0641\u0635\u064a\u0644 \u0622\u062e\u0631 \u0644\u0644\u062d\u062c\u0632\u061f";
	}
	if (/spanish/i.test(lang)) {
		if (pivot === "proceed") return "Si la ubicacion te va bien, continuo a la revision de la reserva?";
		if (pivot === "dates") return "Si la ubicacion te va bien, enviame la fecha de llegada y salida para revisar disponibilidad y precio exactos.";
		if (pivot === "room") return "Si la ubicacion te va bien, que tipo de habitacion o cuantos huespedes necesitas?";
		return "Hay algun otro detalle de la reserva en el que pueda ayudarte?";
	}
	if (/french/i.test(lang)) {
		if (pivot === "proceed") return "Si l'emplacement vous convient, je passe a la revision de la reservation ?";
		if (pivot === "dates") return "Si l'emplacement vous convient, envoyez-moi les dates d'arrivee et de depart pour verifier la disponibilite et le prix exact.";
		if (pivot === "room") return "Si l'emplacement vous convient, quel type de chambre ou combien de personnes faut-il prevoir ?";
		return "Puis-je vous aider avec un autre detail de la reservation ?";
	}
	if (/urdu/i.test(lang)) {
		if (pivot === "proceed") return "اگر مقام آپ کے لیے مناسب ہے تو کیا میں بکنگ ریویو کے مرحلے پر آگے بڑھوں؟";
		if (pivot === "dates") return "اگر مقام مناسب ہے تو arrival اور departure dates بھیج دیں، میں availability اور exact price چیک کر دیتا/دیتی ہوں۔";
		if (pivot === "room") return "اگر مقام مناسب ہے تو آپ کس room type یا کتنے guests کے لیے بکنگ چاہتے ہیں؟";
		return "کیا بکنگ کے بارے میں کسی اور چیز میں مدد کر سکتا/سکتی ہوں؟";
	}
	if (/hindi/i.test(lang)) {
		if (pivot === "proceed") return "अगर location आपके लिए ठीक है, तो क्या मैं reservation details के साथ आगे बढ़ूं?";
		if (pivot === "dates") return "अगर location ठीक है, तो check-in और check-out dates भेज दीजिए, मैं exact availability और price check कर दूंगा/दूंगी।";
		if (pivot === "room") return "अगर location ठीक है, तो आप कौन सा room type या कितने guests के लिए booking चाहते हैं?";
		return "क्या reservation में किसी और चीज़ में help करूं?";
	}
	if (/indonesian/i.test(lang)) {
		if (pivot === "proceed") return "Jika lokasinya cocok, saya lanjutkan ke tahap review reservasi?";
		if (pivot === "dates") return "Jika lokasinya cocok, kirim tanggal check-in dan check-out agar saya cek ketersediaan dan harga pastinya.";
		if (pivot === "room") return "Jika lokasinya cocok, tipe kamar atau jumlah tamu berapa yang Anda butuhkan?";
		return "Ada detail reservasi lain yang bisa saya bantu?";
	}
	if (/malay|malaysia/i.test(lang)) {
		if (pivot === "proceed") return "Jika lokasi ini sesuai, saya teruskan ke langkah semakan tempahan?";
		if (pivot === "dates") return "Jika lokasi ini sesuai, hantar tarikh check-in dan check-out supaya saya boleh semak availability dan harga tepat.";
		if (pivot === "room") return "Jika lokasi ini sesuai, jenis bilik atau berapa tetamu yang anda perlukan?";
		return "Ada butiran tempahan lain yang boleh saya bantu?";
	}
	if (pivot === "proceed") return "If the location works for you, shall I continue with the reservation details?";
	if (pivot === "dates") return "If the location works for you, send me the check-in and check-out dates and I will check the exact availability and price.";
	if (pivot === "room") return "If the location works for you, which room type or guest count should I prepare for you?";
	return "Is there anything else I can help with for the reservation?";
}

function hotelBusServiceYesText(lang, name, details, next) {
	const detailText = hotelBusDetailLine(details, lang);
	if (/arabic/i.test(lang)) {
		return detailText
			? `${name}\u060c \u0646\u0639\u0645\u060c \u0644\u062f\u064a\u0646\u0627 \u062e\u062f\u0645\u0629 \u0628\u0627\u0635 \u0644\u0644\u0636\u064a\u0648\u0641. ${detailText}. ${next}`
			: `${name}\u060c \u0646\u0639\u0645\u060c \u0644\u062f\u064a\u0646\u0627 \u062e\u062f\u0645\u0629 \u0628\u0627\u0635 \u0644\u0644\u0636\u064a\u0648\u0641\u060c \u0648\u0633\u0623\u0633\u0627\u0639\u062f\u0643 \u0647\u0646\u0627 \u0628\u0623\u064a \u062a\u0641\u0627\u0635\u064a\u0644 \u062a\u062d\u062a\u0627\u062c\u0647\u0627 \u0644\u0644\u062d\u062c\u0632. ${next}`;
	}
	if (/spanish/i.test(lang)) {
		return detailText
			? `${name}, si, tenemos servicio de bus para los huespedes. ${detailText}. ${next}`
			: `${name}, si, tenemos servicio de bus para los huespedes y puedo ayudarte aqui con los detalles de la reserva. ${next}`;
	}
	if (/french/i.test(lang)) {
		return detailText
			? `${name}, oui, nous avons un service de bus pour les clients. ${detailText}. ${next}`
			: `${name}, oui, nous avons un service de bus pour les clients et je peux vous aider ici avec les details de la reservation. ${next}`;
	}
	if (/urdu/i.test(lang)) {
		return detailText
			? `${name}, ji haan, ham guests ke liye bus service provide karte hain. ${detailText}. ${next}`
			: `${name}, ji haan, ham guests ke liye bus service provide karte hain aur reservation details mein yahin help kar sakte hain. ${next}`;
	}
	if (/hindi/i.test(lang)) {
		return detailText
			? `${name}, ji haan, hum guests ke liye bus service provide karte hain. ${detailText}. ${next}`
			: `${name}, ji haan, hum guests ke liye bus service provide karte hain aur reservation details mein yahin help kar sakte hain. ${next}`;
	}
	if (/indonesian/i.test(lang)) {
		return detailText
			? `${name}, ya, kami menyediakan layanan bus untuk tamu. ${detailText}. ${next}`
			: `${name}, ya, kami menyediakan layanan bus untuk tamu dan saya bisa membantu detail reservasinya di sini. ${next}`;
	}
	if (/malay|malaysia/i.test(lang)) {
		return detailText
			? `${name}, ya, kami menyediakan perkhidmatan bus untuk tetamu. ${detailText}. ${next}`
			: `${name}, ya, kami menyediakan perkhidmatan bus untuk tetamu dan saya boleh bantu butiran tempahan di sini. ${next}`;
	}
	return detailText
		? `${name}, yes, we provide bus service for guests. ${detailText}. ${next}`
		: `${name}, yes, we provide bus service for guests, and I can help with the reservation details here. ${next}`;
}

function hotelBusServiceNoText(lang, name, hotelName, walking, next) {
	if (/arabic/i.test(lang)) {
		const walkingLine = walking
			? ` ${hotelName} \u064a\u0628\u0639\u062f \u0639\u0646 \u0627\u0644\u062d\u0631\u0645 \u062a\u0642\u0631\u064a\u0628\u0627 ${walking} \u0645\u0634\u064a\u0627\u060c`
			: "";
		return `${name}\u060c \u0644\u0627\u060c \u0644\u0627 \u0646\u0648\u0641\u0631 \u062d\u0627\u0644\u064a\u0627 \u062e\u062f\u0645\u0629 \u0628\u0627\u0635 \u062e\u0627\u0635\u0629.${walkingLine} \u0644\u0643\u0646 \u062a\u0648\u062c\u062f \u0628\u0627\u0635\u0627\u062a \u0639\u0627\u0645\u0629 \u0642\u0631\u064a\u0628\u0629 \u0645\u0646 \u0627\u0644\u0641\u0646\u062f\u0642 \u0648\u064a\u0645\u0643\u0646\u0647\u0627 \u0625\u064a\u0635\u0627\u0644 \u0627\u0644\u0636\u064a\u0648\u0641 \u0625\u0644\u0649 \u0627\u0644\u062d\u0631\u0645. ${next}`;
	}
	if (/spanish/i.test(lang)) {
		return `${name}, no, actualmente no ofrecemos un bus privado.${walking ? ` ${hotelName} esta a unos ${walking} caminando de Al Haram,` : ""} pero hay buses publicos cerca del hotel que pueden llevar a los huespedes a Al Haram. ${next}`;
	}
	if (/french/i.test(lang)) {
		return `${name}, non, nous ne proposons pas actuellement de bus prive.${walking ? ` ${hotelName} se trouve a environ ${walking} a pied d'Al Haram,` : ""} mais des bus publics sont disponibles pres de l'hotel et peuvent deposer les clients a Al Haram. ${next}`;
	}
	if (/urdu/i.test(lang)) {
		return `${name}, nahi, ham filhal private bus service provide nahi karte.${walking ? ` ${hotelName} Al Haram se taqriban ${walking} paidal hai,` : ""} lekin public buses hotel ke qareeb available hain aur guests ko Al Haram tak drop kar sakti hain. ${next}`;
	}
	if (/hindi/i.test(lang)) {
		return `${name}, nahi, hum filhal private bus service provide nahi karte.${walking ? ` ${hotelName} Al Haram se lagbhag ${walking} paidal hai,` : ""} lekin public buses hotel ke paas available hain aur guests ko Al Haram tak drop kar sakti hain. ${next}`;
	}
	if (/indonesian/i.test(lang)) {
		return `${name}, tidak, saat ini kami belum menyediakan layanan bus pribadi.${walking ? ` ${hotelName} sekitar ${walking} berjalan kaki dari Al Haram,` : ""} tetapi bus umum tersedia dekat hotel dan dapat mengantar tamu ke Al Haram. ${next}`;
	}
	if (/malay|malaysia/i.test(lang)) {
		return `${name}, tidak, buat masa ini kami belum menyediakan perkhidmatan bus khas.${walking ? ` ${hotelName} kira-kira ${walking} berjalan kaki dari Al Haram,` : ""} tetapi bus awam tersedia berhampiran hotel dan boleh menghantar tetamu ke Al Haram. ${next}`;
	}
	return `${name}, no, we do not currently offer a private bus service.${walking ? ` ${hotelName} is about ${walking} walking from Al Haram,` : ""} but public buses are available close to the hotel and can drop guests at Al Haram. ${next}`;
}

function hotelNusukYesText(lang, name, details, next) {
	const detailText = String(details || "").replace(/[.!?\u061f\u06d4]+$/g, "");
	if (/arabic/i.test(lang)) {
		return detailText
			? `${name}\u060c \u0646\u0639\u0645\u060c \u0627\u0644\u0641\u0646\u062f\u0642 \u0645\u062f\u0631\u062c \u0639\u0644\u0649 \u0645\u0646\u0635\u0629 \u0646\u0633\u0643. ${detailText}. ${next}`
			: `${name}\u060c \u0646\u0639\u0645\u060c \u0627\u0644\u0641\u0646\u062f\u0642 \u0645\u062f\u0631\u062c \u0639\u0644\u0649 \u0645\u0646\u0635\u0629 \u0646\u0633\u0643. ${next}`;
	}
	if (/spanish/i.test(lang)) {
		return `${name}, si, el hotel esta listado en Nusuk.${detailText ? ` ${detailText}.` : ""} ${next}`;
	}
	if (/french/i.test(lang)) {
		return `${name}, oui, l'hotel est liste sur Nusuk.${detailText ? ` ${detailText}.` : ""} ${next}`;
	}
	if (/urdu|hindi/i.test(lang)) {
		return `${name}, ji haan, hotel Nusuk par listed hai.${detailText ? ` ${detailText}.` : ""} ${next}`;
	}
	if (/indonesian/i.test(lang)) {
		return `${name}, ya, hotel ini terdaftar di Nusuk.${detailText ? ` ${detailText}.` : ""} ${next}`;
	}
	if (/malay|malaysia/i.test(lang)) {
		return `${name}, ya, hotel ini tersenarai di Nusuk.${detailText ? ` ${detailText}.` : ""} ${next}`;
	}
	return `${name}, yes, the hotel is listed on Nusuk.${detailText ? ` ${detailText}.` : ""} ${next}`;
}

function hotelNusukNoText(lang, name, next) {
	if (/arabic/i.test(lang)) {
		return `${name}\u060c \u062d\u0627\u0644\u064a\u0627 \u0644\u0627 \u064a\u0638\u0647\u0631 \u0644\u062f\u064a\u0646\u0627 \u0623\u0646 \u0627\u0644\u0641\u0646\u062f\u0642 \u0645\u062f\u0631\u062c \u0639\u0644\u0649 \u0645\u0646\u0635\u0629 \u0646\u0633\u0643. \u0648\u0623\u0642\u062f\u0631 \u0623\u0633\u0627\u0639\u062f\u0643 \u0647\u0646\u0627 \u0628\u0627\u0644\u062d\u062c\u0632 \u0628\u062e\u0637\u0648\u0627\u062a \u0648\u0627\u0636\u062d\u0629 \u0648\u0633\u0631\u064a\u0639\u0629. ${next}`;
	}
	if (/spanish/i.test(lang)) {
		return `${name}, por el momento no veo que el hotel este listado en Nusuk. Aun asi, puedo ayudarte aqui con la reserva de forma clara y rapida. ${next}`;
	}
	if (/french/i.test(lang)) {
		return `${name}, pour le moment, je ne vois pas l'hotel comme liste sur Nusuk. Je peux quand meme vous aider ici avec la reservation clairement et rapidement. ${next}`;
	}
	if (/urdu|hindi/i.test(lang)) {
		return `${name}, filhal hotel Nusuk par listed nazar nahi aa raha. Main yahin reservation mein clear aur quick help kar sakta hun. ${next}`;
	}
	if (/indonesian/i.test(lang)) {
		return `${name}, saat ini hotel belum terlihat terdaftar di Nusuk. Saya tetap bisa membantu reservasinya di sini dengan jelas dan cepat. ${next}`;
	}
	if (/malay|malaysia/i.test(lang)) {
		return `${name}, buat masa ini hotel belum kelihatan tersenarai di Nusuk. Saya masih boleh bantu tempahan di sini dengan jelas dan cepat. ${next}`;
	}
	return `${name}, at the moment I do not see the hotel marked as listed on Nusuk. I can still help you here with the reservation clearly and quickly. ${next}`;
}

function hotelLocationMapLine(lang = "English", mapLink = "") {
	if (!mapLink) return "";
	if (/arabic/i.test(lang)) {
		return `\u0647\u0630\u0627 \u0631\u0627\u0628\u0637 \u0645\u0648\u0642\u0639 \u0627\u0644\u0641\u0646\u062f\u0642 \u0639\u0644\u0649 Google Maps: ${mapLink}.`;
	}
	if (/spanish/i.test(lang)) return `Aqui tienes la ubicacion exacta del hotel en Google Maps: ${mapLink}.`;
	if (/french/i.test(lang)) return `Voici l'emplacement exact de l'hotel sur Google Maps : ${mapLink}.`;
	if (/urdu|hindi/i.test(lang)) return `Hotel ki exact Google Maps location yahan hai: ${mapLink}.`;
	if (/indonesian/i.test(lang)) return `Ini lokasi tepat hotel di Google Maps: ${mapLink}.`;
	if (/malay|malaysia/i.test(lang)) return `Ini lokasi tepat hotel di Google Maps: ${mapLink}.`;
	return `Here is the hotel's exact Google Maps location: ${mapLink}.`;
}

function hotelPolicyRows(st = {}) {
	return activeHotelPolicyQA(st.hotel?.hotelPolicyQA);
}

function hotelPolicyRowScore(row = {}, text = "") {
	const key = String(row.key || "").toLowerCase();
	const { lower, arabic, latinCompact } = normalizeControlText(text);
	if (key === "cancellation_refund" && cancellationRefundPolicyQuestionText(text)) {
		return 100;
	}
	const checks = {
		checkin_checkout:
			/\b(check[\s-]?in|check[\s-]?out|checkout|arrival|departure)\b/i.test(lower) ||
			/(?:\u0648\u0635\u0648\u0644|\u0645\u063a\u0627\u062f\u0631\u0629|\u062f\u062e\u0648\u0644|\u062e\u0631\u0648\u062c|\u062a\u0634\u064a\u0643)/i.test(arabic) ||
			/(?:checkin|checkout|arrival|departure)/i.test(latinCompact),
		early_late:
			/\b(early\s+check|late\s+check|late\s+checkout|early\s+arrival)\b/i.test(lower) ||
			/(?:\u0648\u0635\u0648\u0644\s+\u0645\u0628\u0643\u0631|\u062f\u062e\u0648\u0644\s+\u0645\u0628\u0643\u0631|\u062e\u0631\u0648\u062c\s+\u0645\u062a\u0623\u062e\u0631|\u0645\u063a\u0627\u062f\u0631\u0629\s+\u0645\u062a\u0623\u062e\u0631)/i.test(arabic) ||
			/(?:earlycheckin|latecheckout|earlyarrival)/i.test(latinCompact),
		children_extra_beds:
			/\b(children|child|kids|extra\s+bed|crib|cot)\b/i.test(lower) ||
			/(?:\u0623\u0637\u0641\u0627\u0644|\u0627\u0637\u0641\u0627\u0644|\u0637\u0641\u0644|\u0633\u0631\u064a\u0631\s+\u0625\u0636\u0627\u0641\u064a|\u0633\u0631\u064a\u0631\s+\u0627\u0636\u0627\u0641\u064a)/i.test(arabic) ||
			/(?:children|child|kids|extrabed|crib|cot)/i.test(latinCompact),
		payment_deposit:
			/\b(payment|deposit|prepay|pay\s+at\s+hotel|card|cash)\b/i.test(lower) ||
			/(?:\u062f\u0641\u0639|\u0639\u0631\u0628\u0648\u0646|\u062a\u0623\u0645\u064a\u0646|\u062a\u0627\u0645\u064a\u0646|\u0643\u0627\u0634|\u0643\u0627\u0631\u062a|\u0628\u0637\u0627\u0642\u0629|\u0628\u0637\u0627\u0642\u0647)/i.test(arabic) ||
			/(?:payment|deposit|prepay|card|cash)/i.test(latinCompact),
		no_show:
			/\b(no[\s-]?show|not\s+show|do\s+not\s+arrive|miss\s+my\s+booking)\b/i.test(lower) ||
			/(?:\u0644\u0627\s*\u064a\u062d\u0636\u0631|\u0639\u062f\u0645\s+\u0627\u0644\u062d\u0636\u0648\u0631|\u0645\u0627\s+\u062c\u064a\u062a|\u0645\u0627\s+\u062d\u0636\u0631)/i.test(arabic) ||
			/(?:noshow|notshow|missbooking)/i.test(latinCompact),
		id_documents:
			/\b(passport|id card|identification|document|visa)\b/i.test(lower) ||
			/(?:\u062c\u0648\u0627\u0632|\u0647\u0648\u064a\u0629|\u0647\u0648\u064a\u0647|\u0625\u0642\u0627\u0645\u0629|\u0627\u0642\u0627\u0645\u0629|\u0645\u0633\u062a\u0646\u062f|\u062a\u0623\u0634\u064a\u0631\u0629|\u062a\u0627\u0634\u064a\u0631\u0629)/i.test(arabic) ||
			/(?:passport|idcard|identification|document|visa)/i.test(latinCompact),
		smoking:
			/\b(smoking|smoke|cigarette)\b/i.test(lower) ||
			/(?:\u062a\u062f\u062e\u064a\u0646|\u0633\u062c\u0627\u0626\u0631|\u062f\u062e\u0627\u0646)/i.test(arabic) ||
			/(?:smoking|smoke|cigarette)/i.test(latinCompact),
		parking:
			/\b(parking|park\s+my\s+car|car\s+park)\b/i.test(lower) ||
			/(?:\u0645\u0648\u0642\u0641|\u0645\u0648\u0627\u0642\u0641|\u0628\u0627\u0631\u0643\u064a\u0646\u062c)/i.test(arabic) ||
			/(?:parking|carpark)/i.test(latinCompact),
		meals_breakfast:
			/\b(breakfast|meal|meals|restaurant|food)\b/i.test(lower) ||
			/(?:\u0625\u0641\u0637\u0627\u0631|\u0627\u0641\u0637\u0627\u0631|\u0648\u062c\u0628\u0629|\u0648\u062c\u0628\u0627\u062a|\u0645\u0637\u0639\u0645|\u0623\u0643\u0644|\u0627\u0643\u0644)/i.test(arabic) ||
			/(?:breakfast|meal|restaurant|food)/i.test(latinCompact),
		pets:
			/\b(pet|pets|cat|dog)\b/i.test(lower) ||
			/(?:\u062d\u064a\u0648\u0627\u0646|\u062d\u064a\u0648\u0627\u0646\u0627\u062a|\u0642\u0637|\u0643\u0644\u0628)/i.test(arabic) ||
			/(?:pet|pets|cat|dog)/i.test(latinCompact),
		damage_deposit:
			/\b(damage|breakage|security\s+deposit)\b/i.test(lower) ||
			/(?:\u0623\u0636\u0631\u0627\u0631|\u0627\u0636\u0631\u0627\u0631|\u062a\u0644\u0641|\u0643\u0633\u0631|\u062a\u0623\u0645\u064a\u0646|\u062a\u0627\u0645\u064a\u0646)/i.test(arabic) ||
			/(?:damage|breakage|securitydeposit)/i.test(latinCompact),
	};
	if (checks[key]) return 80;
	const normalizedText = normalizedRepeatedQuestionText(text);
	const normalizedQuestion = normalizedRepeatedQuestionText(row.question || "");
	const normalizedCategory = normalizedRepeatedQuestionText(row.category || "");
	let score = 0;
	for (const token of normalizedQuestion.split(/\s+/).filter((item) => item.length >= 4)) {
		if (normalizedText.includes(token)) score += 4;
	}
	for (const token of normalizedCategory.split(/\s+/).filter((item) => item.length >= 4)) {
		if (normalizedText.includes(token)) score += 2;
	}
	if (/\b(policy|terms|conditions|rules)\b/i.test(lower)) score += 3;
	if (/(?:\u0633\u064a\u0627\u0633\u0629|\u0634\u0631\u0648\u0637|\u0623\u062d\u0643\u0627\u0645|\u0627\u062d\u0643\u0627\u0645|\u0642\u0648\u0627\u0639\u062f)/i.test(arabic)) score += 3;
	return score;
}

function bestHotelPolicyRow(st = {}, text = "") {
	const rows = hotelPolicyRows(st);
	if (!rows.length) return null;
	if (cancellationRefundPolicyQuestionText(text)) {
		return rows.find((row) => row.key === "cancellation_refund") || rows[0];
	}
	const scored = rows
		.map((row) => ({ row, score: hotelPolicyRowScore(row, text) }))
		.filter((item) => item.score > 0)
		.sort((a, b) => b.score - a.score);
	if (scored.length) return scored[0].row;
	return null;
}

function defaultCancellationPolicyAnswerText(sc = {}, st = {}) {
	return generalCancellationPolicyMessage(sc, st, {}, "");
}

function hotelPolicyAnswerText(sc = {}, st = {}, userText = "", row = null) {
	const policyRow = row || bestHotelPolicyRow(st, userText);
	if (!policyRow?.answer) return "";
	if (policyRow.key === "cancellation_refund") {
		if (
			cleanHotelFactText(policyRow.answer) ===
			cleanHotelFactText(DEFAULT_CANCELLATION_REFUND_ANSWER)
		) {
			return defaultCancellationPolicyAnswerText(sc, st);
		}
	}
	const lang = languageOf(sc, st);
	const name = respectfulGuestName(sc, st);
	const answer = cleanHotelFactText(policyRow.answer);
	if (!answer) return "";
	if (/arabic/i.test(lang) && hasArabicScript(answer)) {
		return `${name}\u060c \u062d\u0633\u0628 \u0633\u064a\u0627\u0633\u0629 \u0648\u0634\u0631\u0648\u0637 \u0627\u0644\u0641\u0646\u062f\u0642: ${answer}`;
	}
	if (!/arabic/i.test(lang) && !hasArabicScript(answer)) {
		return `${name}, based on the hotel's terms and conditions: ${answer}`;
	}
	return "";
}

function hotelMealsSourceText(hotel = {}) {
	const candidates = [
		hotel.aboutHotel,
		hotel.aboutHotelArabic,
	]
		.map((value) => cleanHotelFactText(value))
		.filter(Boolean);
	return (
		candidates.find(
			(value) =>
				/\b(?:breakfast|meal|meals|dining|restaurant|buffet|kitchen)\b/i.test(
					value
				) ||
				/(?:\u0625\u0641\u0637\u0627\u0631|\u0627\u0641\u0637\u0627\u0631|\u0641\u0637\u0648\u0631|\u0648\u062c\u0628\u0629|\u0648\u062c\u0628\u0627\u062a|\u0645\u0637\u0639\u0645|\u0628\u0648\u0641\u064a\u0647|\u0645\u0637\u0628\u062e)/i.test(
					value
				)
		) || ""
	);
}

function selectedHotelMealsAnswerText(sc = {}, st = {}) {
	const lang = languageOf(sc, st);
	const name = respectfulGuestName(sc, st);
	const hotelName = localizedHotelName(sc, st);
	const next = hotelFactNextStepText(sc, st);
	const hotel = st.hotel || {};
	const hasExplicitMealsSetting =
		Object.prototype.hasOwnProperty.call(hotel, "hasMealsService") ||
		typeof hotel.hasMealsService === "boolean" ||
		Object.prototype.hasOwnProperty.call(hotel, "mealsDetails");
	const hasMealsService = hotel.hasMealsService === true;
	const mealsDetails = compactRoomFactText(cleanHotelFactText(hotel.mealsDetails), 220);
	if (hasMealsService) {
		if (/arabic/i.test(lang)) {
			return mealsDetails
				? `${name}\u060c \u0646\u0639\u0645\u060c ${hotelName} \u064a\u0648\u0641\u0631 \u0648\u062c\u0628\u0627\u062a \u0644\u0644\u0636\u064a\u0648\u0641. ${mealsDetails}. ${next}`
				: `${name}\u060c \u0646\u0639\u0645\u060c ${hotelName} \u064a\u0648\u0641\u0631 \u0648\u062c\u0628\u0627\u062a \u0644\u0644\u0636\u064a\u0648\u0641\u060c \u0648\u0644\u0627 \u062a\u0648\u062c\u062f \u062a\u0641\u0627\u0635\u064a\u0644 \u0625\u0636\u0627\u0641\u064a\u0629 \u0645\u062d\u062f\u062f\u0629 \u062d\u0627\u0644\u064a\u0627. ${next}`;
		}
		if (/spanish/i.test(lang)) {
			return mealsDetails
				? `${name}, si, ${hotelName} ofrece comidas para los huespedes. ${mealsDetails}. ${next}`
				: `${name}, si, ${hotelName} ofrece comidas para los huespedes, pero no hay mas detalles de comidas indicados ahora mismo. ${next}`;
		}
		if (/french/i.test(lang)) {
			return mealsDetails
				? `${name}, oui, ${hotelName} propose des repas aux clients. ${mealsDetails}. ${next}`
				: `${name}, oui, ${hotelName} propose des repas aux clients, mais aucun detail supplementaire n'est indique pour le moment. ${next}`;
		}
		return mealsDetails
			? `${name}, yes, ${hotelName} provides meals for guests. ${mealsDetails}. ${next}`
			: `${name}, yes, ${hotelName} provides meals for guests, but no extra meal details are shown right now. ${next}`;
	}
	if (hasExplicitMealsSetting) {
		if (/arabic/i.test(lang)) {
			return `${name}\u060c \u0644\u0627 \u064a\u0638\u0647\u0631 \u0644\u062f\u064a \u062d\u0627\u0644\u064a\u0627 \u0623\u0646 ${hotelName} \u064a\u0648\u0641\u0631 \u0648\u062c\u0628\u0627\u062a \u062f\u0627\u062e\u0644 \u0627\u0644\u0641\u0646\u062f\u0642. ${next}`;
		}
		if (/spanish/i.test(lang)) return `${name}, no veo comidas dentro del hotel marcadas como disponibles para ${hotelName} ahora mismo. ${next}`;
		if (/french/i.test(lang)) return `${name}, je ne vois pas de repas a l'hotel indiques comme proposes pour ${hotelName} pour le moment. ${next}`;
		return `${name}, I do not see in-hotel meals marked as provided for ${hotelName} right now. ${next}`;
	}
	const source = hotelMealsSourceText(hotel);
	const sourceBrief = compactRoomFactText(source, 220);
	const hasMealMention =
		/\b(?:breakfast|meal|meals|dining|restaurant|buffet)\b/i.test(source) ||
		/(?:\u0625\u0641\u0637\u0627\u0631|\u0627\u0641\u0637\u0627\u0631|\u0641\u0637\u0648\u0631|\u0648\u062c\u0628\u0629|\u0648\u062c\u0628\u0627\u062a|\u0645\u0637\u0639\u0645|\u0628\u0648\u0641\u064a\u0647)/i.test(
			source
		);
	const hasKitchenMention =
		/\bkitchen\b/i.test(source) || /(?:\u0645\u0637\u0628\u062e)/i.test(source);
	if (sourceBrief && hasMealMention) {
		if (/arabic/i.test(lang)) {
			return `${name}\u060c \u0627\u0644\u0645\u062a\u0627\u062d \u0644\u062f\u064a \u062d\u0627\u0644\u064a\u0627 \u0639\u0646 ${hotelName}: ${sourceBrief}. ${next}`;
		}
		if (/spanish/i.test(lang)) return `${name}, lo que tengo confirmado ahora sobre ${hotelName} es: ${sourceBrief}. ${next}`;
		if (/french/i.test(lang)) return `${name}, l'information confirmee dont je dispose pour ${hotelName} est : ${sourceBrief}. ${next}`;
		return `${name}, what I have confirmed right now for ${hotelName} is: ${sourceBrief}. ${next}`;
	}
	if (hasKitchenMention) {
		if (/arabic/i.test(lang)) {
			return `${name}\u060c \u0644\u0627 \u064a\u0638\u0647\u0631 \u0644\u062f\u064a \u062d\u0627\u0644\u064a\u0627 \u0623\u0646 ${hotelName} \u064a\u0642\u062f\u0645 \u0648\u062c\u0628\u0627\u062a \u062f\u0627\u062e\u0644 \u0627\u0644\u0641\u0646\u062f\u0642\u060c \u0644\u0643\u0646 \u0628\u064a\u0627\u0646\u0627\u062a \u0627\u0644\u0641\u0646\u062f\u0642 \u062a\u0630\u0643\u0631 \u0648\u062c\u0648\u062f \u0645\u0637\u0628\u062e \u0644\u062e\u062f\u0645\u0629 \u0627\u0644\u0636\u064a\u0648\u0641. ${next}`;
		}
		if (/spanish/i.test(lang)) return `${name}, no veo comidas dentro de ${hotelName} confirmadas ahora mismo, pero la informacion del hotel menciona una cocina para uso de los huespedes. ${next}`;
		if (/french/i.test(lang)) return `${name}, je ne vois pas de repas a l'hotel confirmes pour ${hotelName} pour le moment, mais les informations indiquent une cuisine pour les clients. ${next}`;
		return `${name}, I do not see in-hotel meals confirmed for ${hotelName} right now, but the hotel information mentions a kitchen for guest use. ${next}`;
	}
	if (/arabic/i.test(lang)) {
		return `${name}\u060c \u0644\u0627 \u064a\u0638\u0647\u0631 \u0644\u062f\u064a \u062d\u0627\u0644\u064a\u0627 \u062a\u0641\u0635\u064a\u0644 \u0645\u0624\u0643\u062f \u0639\u0646 \u0648\u062c\u0628\u0627\u062a \u062f\u0627\u062e\u0644 ${hotelName}. ${next}`;
	}
	if (/spanish/i.test(lang)) return `${name}, no veo un detalle confirmado ahora mismo sobre comidas dentro de ${hotelName}. ${next}`;
	if (/french/i.test(lang)) return `${name}, je ne vois pas de detail confirme pour les repas a ${hotelName} pour le moment. ${next}`;
	return `${name}, I do not see a confirmed in-hotel meals detail for ${hotelName} right now. ${next}`;
}

function selectedHotelLocalAreaFacts(hotel = {}) {
	const about = cleanHotelFactText(hotel.aboutHotel);
	const lower = about.toLowerCase();
	const area = /al[-\s]?aziziyah\s+north/i.test(about)
		? "Al Aziziyah North district"
		: cleanHotelFactText(hotel.hotelState || hotel.hotelCity);
	const landmark = /umm\s+al[-\s]?qura\s+university/i.test(about)
		? "behind Umm Al-Qura University"
		: "";
	const services = [];
	if (/restaurants?/i.test(about)) services.push("restaurants");
	if (/markets?/i.test(about)) services.push("markets");
	if (/pharmac(?:y|ies)/i.test(about)) services.push("pharmacies");
	return {
		about,
		area,
		landmark,
		services,
		quiet: /\bquiet\s+area\b/i.test(lower),
		reception24: /\b24\s*[- ]?\s*hour\s+reception\b/i.test(lower),
		parkingLot: hotel.parkingLot === true,
	};
}

function localizedLocalAreaServices(services = [], lang = "English") {
	const names = {
		restaurants: {
			ar: "المطاعم",
			es: "restaurantes",
			fr: "restaurants",
			ur: "restaurants",
			hi: "restaurants",
			id: "restoran",
			ms: "restoran",
			en: "restaurants",
		},
		markets: {
			ar: "الأسواق",
			es: "mercados",
			fr: "marches",
			ur: "markets",
			hi: "markets",
			id: "pasar",
			ms: "pasar",
			en: "markets",
		},
		pharmacies: {
			ar: "الصيدليات",
			es: "farmacias",
			fr: "pharmacies",
			ur: "pharmacies",
			hi: "pharmacies",
			id: "apotek",
			ms: "farmasi",
			en: "pharmacies",
		},
	};
	const code = /arabic/i.test(lang)
		? "ar"
		: /spanish/i.test(lang)
		? "es"
		: /french/i.test(lang)
		? "fr"
		: /urdu/i.test(lang)
		? "ur"
		: /hindi/i.test(lang)
		? "hi"
		: /indonesian/i.test(lang)
		? "id"
		: /malay|malaysia/i.test(lang)
		? "ms"
		: "en";
	return services.map((service) => names[service]?.[code] || service);
}

function localizedLocalAreaPlace(facts = {}, lang = "English") {
	const knownAziziyah = /al\s+aziziyah\s+north/i.test(facts.area || "");
	const knownUmmQura = /umm\s+al[-\s]?qura/i.test(facts.landmark || "");
	let area = facts.area || "Makkah";
	let landmark = facts.landmark || "";
	if (/arabic/i.test(lang)) {
		area = knownAziziyah ? "حي العزيزية الشمالية" : area;
		landmark = knownUmmQura ? "خلف جامعة أم القرى" : landmark;
	} else if (/spanish/i.test(lang)) {
		area = knownAziziyah ? "el distrito norte de Al Aziziyah" : area;
		landmark = knownUmmQura ? "detras de la Universidad Umm Al-Qura" : landmark;
	} else if (/french/i.test(lang)) {
		area = knownAziziyah ? "le quartier nord d'Al Aziziyah" : area;
		landmark = knownUmmQura ? "derriere l'Universite Umm Al-Qura" : landmark;
	} else if (/urdu/i.test(lang)) {
		area = knownAziziyah ? "Al Aziziyah North district" : area;
		landmark = knownUmmQura ? "Umm Al-Qura University ke peeche" : landmark;
	} else if (/hindi/i.test(lang)) {
		area = knownAziziyah ? "Al Aziziyah North district" : area;
		landmark = knownUmmQura ? "Umm Al-Qura University ke peeche" : landmark;
	} else if (/indonesian/i.test(lang)) {
		area = knownAziziyah ? "distrik Al Aziziyah North" : area;
		landmark = knownUmmQura ? "di belakang Universitas Umm Al-Qura" : landmark;
	} else if (/malay|malaysia/i.test(lang)) {
		area = knownAziziyah ? "daerah Al Aziziyah North" : area;
		landmark = knownUmmQura ? "di belakang Universiti Umm Al-Qura" : landmark;
	}
	return [area, landmark].filter(Boolean).join(/arabic/i.test(lang) ? "، " : ", ");
}

function localizedLocalAreaMode(value = "", mode = "walking", lang = "English") {
	if (!value) return "";
	if (/arabic/i.test(lang)) return `${value} ${mode === "walking" ? "مشيا" : "بالسيارة"}`;
	if (/spanish/i.test(lang)) return `${value} ${mode === "walking" ? "caminando" : "en coche"}`;
	if (/french/i.test(lang)) return `${value} ${mode === "walking" ? "a pied" : "en voiture"}`;
	if (/urdu/i.test(lang)) return `${value} ${mode === "walking" ? "paidal" : "gaari se"}`;
	if (/hindi/i.test(lang)) return `${value} ${mode === "walking" ? "paidal" : "gaadi se"}`;
	if (/indonesian/i.test(lang)) return `${value} ${mode === "walking" ? "berjalan kaki" : "dengan mobil"}`;
	if (/malay|malaysia/i.test(lang)) return `${value} ${mode === "walking" ? "berjalan kaki" : "dengan kereta"}`;
	return `${value} ${mode === "walking" ? "on foot" : "by car"}`;
}

function localizedLocalAreaDistanceLine(walking = "", driving = "", lang = "English") {
	if (!walking && !driving) return "";
	const joined = localizedJoin(
		[
			localizedLocalAreaMode(walking, "walking", lang),
			localizedLocalAreaMode(driving, "driving", lang),
		].filter(Boolean),
		lang
	);
	if (/arabic/i.test(lang)) return ` وهو يبعد عن الحرم حوالي ${joined} حسب الزحام.`;
	if (/spanish/i.test(lang)) return ` Esta a unos ${joined} de Al Haram, segun el trafico.`;
	if (/french/i.test(lang)) return ` Il se trouve a environ ${joined} d'Al Haram, selon la circulation.`;
	if (/urdu/i.test(lang)) return ` Al Haram se taqriban ${joined} hai, traffic ke hisaab se.`;
	if (/hindi/i.test(lang)) return ` Al Haram se lagbhag ${joined} hai, traffic ke hisaab se.`;
	if (/indonesian/i.test(lang)) return ` Jaraknya sekitar ${joined} dari Al Haram, tergantung lalu lintas.`;
	if (/malay|malaysia/i.test(lang)) return ` Jaraknya kira-kira ${joined} dari Al Haram, bergantung pada trafik.`;
	return ` It is about ${joined} from Al Haram, depending on traffic.`;
}

function localizedLocalAreaServiceLine(services = [], lang = "English") {
	if (!services.length) return "";
	const joined = localizedJoin(localizedLocalAreaServices(services, lang), lang);
	if (/arabic/i.test(lang)) return ` توضح بيانات الفندق أنه قريب من الخدمات الأساسية مثل ${joined}.`;
	if (/spanish/i.test(lang)) return ` El perfil del hotel indica que esta cerca de servicios esenciales como ${joined}.`;
	if (/french/i.test(lang)) return ` Le profil de l'hotel indique qu'il est proche de services essentiels comme ${joined}.`;
	if (/urdu/i.test(lang)) return ` Hotel profile ke mutabiq yeh ${joined} jaisi zaroori services ke qareeb hai.`;
	if (/hindi/i.test(lang)) return ` Hotel profile ke mutabiq yeh ${joined} jaisi zaroori services ke paas hai.`;
	if (/indonesian/i.test(lang)) return ` Profil hotel menyebutkan lokasinya dekat layanan penting seperti ${joined}.`;
	if (/malay|malaysia/i.test(lang)) return ` Profil hotel menyatakan lokasinya dekat dengan perkhidmatan penting seperti ${joined}.`;
	return ` The stored hotel profile says it is close to essential services such as ${joined}.`;
}

function selectedHotelLocalAreaAnswerText(sc = {}, st = {}, userText = "") {
	const hotel = st.hotel || {};
	const lang = languageOf(sc, st);
	const { lower, arabic } = normalizeControlText(userText);
	const name = respectfulGuestName(sc, st);
	const hotelName = localizedHotelName(sc, st);
	const facts = selectedHotelLocalAreaFacts(hotel);
	const walking = formatHotelDistanceValue(hotel.distances?.walkingToElHaram, lang);
	const driving = formatHotelDistanceValue(hotel.distances?.drivingToElHaram, lang);
	const mapLink = hotelGoogleMapsMarkdownLink(hotel, lang);
	const next = hotelFactNextStepText(sc, st);
	const place = localizedLocalAreaPlace(facts, lang) || "Makkah";
	const distance = localizedLocalAreaDistanceLine(walking, driving, lang);
	const serviceLine = localizedLocalAreaServiceLine(facts.services, lang);
	const asksParking =
		/\b(?:parking|park\s+my\s+car|car\s+park)\b/i.test(lower) ||
		/(?:مواقف|موقف|باركينج|ركن|سيارتي|سيارة)/i.test(arabic);
	const asksLateArrival =
		/\b(?:late\s+at\s+night|late\s+arrival|24\s*-?\s*hour|reception\s+help)\b/i.test(lower) ||
		/(?:وصول\s+متأخر|متأخر|بالليل|ليلا|ليلًا|24\s*ساعة|استقبال)/i.test(arabic);
	const asksParentOrSenior =
		/\b(?:parents?|elderly|seniors?|senior\s+guests?)\b/i.test(lower) ||
		/(?:\u0648\u0627\u0644\u062f\u064a\u0646|\u0648\u0627\u0644\u062f\u064a|\u0648\u0627\u0644\u062f\u062a\u064a|\u0627\u0644\u0648\u0627\u0644\u062f|\u0627\u0644\u0648\u0627\u0644\u062f\u0629|\u0643\u0628\u0627\u0631\s+\u0627\u0644\u0633\u0646|\u0643\u0628\u064a\u0631\s+\u0627\u0644\u0633\u0646|\u0643\u0628\u064a\u0631\u0629\s+\u0627\u0644\u0633\u0646|\u0645\u0633\u0646|\u0645\u0633\u0646\u064a\u0646)/i.test(
			arabic
		);
	const asksFamily =
		asksParentOrSenior ||
		/\b(?:famil(?:y|ies)|good\s+choice)\b/i.test(lower) ||
		/(?:عائلات|عائلة|اسرة|أسرة|مناسب)/i.test(arabic);
	const asksFirstTime =
		/\b(?:first\s*time|umrah\s+guest|recommend(?:ation|ed|ing)?|suggest(?:ion|ed|ing)?|suitable)\b/i.test(lower) ||
		/(?:اول\s+مرة|أول\s+مرة|معتمر|عمرة|تنصح|ترشح|توصي)/i.test(arabic);
	const asksLandmark =
		/\b(?:landmark|area|district)\b/i.test(lower) ||
		/(?:معلم|منطقة|حي|العزيزية|جامعة|ام\s+القرى|أم\s+القرى)/i.test(arabic);
	const asksNearby =
		/\b(?:restaurants?|shops?|markets?|pharmac(?:y|ies)|nearby|around|surrounding|essential\s+services)\b/i.test(lower) ||
		/(?:قريب|قريبة|حول|حوالي|مطاعم|محلات|اسواق|أسواق|صيدليات|خدمات)/i.test(arabic);
	if (asksParking) {
		if (/arabic/i.test(lang)) {
			return facts.parkingLot
				? `${name}، نعم، ${hotelName} مسجل لديه مواقف سيارات متاحة.${distance} ${next}`
				: `${name}، لا أرى تأكيدا لمواقف السيارات في ${hotelName} حاليا.${distance} ${next}`;
		}
		if (/spanish/i.test(lang)) return facts.parkingLot ? `${name}, si, ${hotelName} aparece con parking disponible.${distance} ${next}` : `${name}, no veo parking confirmado para ${hotelName} ahora mismo.${distance} ${next}`;
		if (/french/i.test(lang)) return facts.parkingLot ? `${name}, oui, ${hotelName} indique un parking disponible.${distance} ${next}` : `${name}, je ne vois pas de parking confirme pour ${hotelName} pour le moment.${distance} ${next}`;
		if (/urdu|hindi/i.test(lang)) return facts.parkingLot ? `${name}, ji haan, ${hotelName} mein parking available listed hai.${distance} ${next}` : `${name}, filhal ${hotelName} ke liye parking confirmed nazar nahi aa rahi.${distance} ${next}`;
		if (/indonesian/i.test(lang)) return facts.parkingLot ? `${name}, ya, ${hotelName} tercatat memiliki parkir tersedia.${distance} ${next}` : `${name}, saya belum melihat parkir terkonfirmasi untuk ${hotelName} saat ini.${distance} ${next}`;
		if (/malay|malaysia/i.test(lang)) return facts.parkingLot ? `${name}, ya, ${hotelName} disenaraikan dengan parking tersedia.${distance} ${next}` : `${name}, saya belum nampak parking disahkan untuk ${hotelName} sekarang.${distance} ${next}`;
		return facts.parkingLot
			? `${name}, yes, ${hotelName} is listed with parking available.${distance} ${next}`
			: `${name}, I do not see parking confirmed for ${hotelName} right now.${distance} ${next}`;
	}
	if (asksLateArrival) {
		if (/arabic/i.test(lang)) {
			return facts.reception24
				? `${name}، نعم، ${hotelName} يوضح وجود استقبال على مدار 24 ساعة، لذلك يمكن للاستقبال مساعدتك عند الوصول المتأخر.${distance} ${next}`
				: `${name}، لا أرى ملاحظة مؤكدة عن استقبال 24 ساعة في ${hotelName} حاليا.${distance} ${next}`;
		}
		if (/spanish/i.test(lang)) return facts.reception24 ? `${name}, si, ${hotelName} indica recepcion 24 horas, asi que recepcion deberia poder ayudar con una llegada tarde.${distance} ${next}` : `${name}, no veo una nota confirmada de recepcion 24 horas para ${hotelName} ahora mismo.${distance} ${next}`;
		if (/french/i.test(lang)) return facts.reception24 ? `${name}, oui, ${hotelName} indique une reception 24h/24, donc la reception devrait pouvoir aider pour une arrivee tardive.${distance} ${next}` : `${name}, je ne vois pas de note confirmee de reception 24h/24 pour ${hotelName} pour le moment.${distance} ${next}`;
		if (/urdu|hindi/i.test(lang)) return facts.reception24 ? `${name}, ji haan, ${hotelName} 24-hour reception listed hai, is liye late arrival par reception help kar sakti hai.${distance} ${next}` : `${name}, filhal ${hotelName} ke liye 24-hour reception confirmed note nazar nahi aa rahi.${distance} ${next}`;
		if (/indonesian/i.test(lang)) return facts.reception24 ? `${name}, ya, ${hotelName} mencantumkan resepsionis 24 jam, jadi resepsionis dapat membantu untuk kedatangan malam.${distance} ${next}` : `${name}, saya belum melihat catatan resepsionis 24 jam yang terkonfirmasi untuk ${hotelName} saat ini.${distance} ${next}`;
		if (/malay|malaysia/i.test(lang)) return facts.reception24 ? `${name}, ya, ${hotelName} menyenaraikan reception 24 jam, jadi reception boleh membantu untuk ketibaan lewat malam.${distance} ${next}` : `${name}, saya belum nampak nota reception 24 jam yang disahkan untuk ${hotelName} sekarang.${distance} ${next}`;
		return facts.reception24
			? `${name}, yes, ${hotelName} lists 24-hour reception, so reception support should be available for late arrival.${distance} ${next}`
			: `${name}, I do not see a confirmed 24-hour reception note for ${hotelName} right now.${distance} ${next}`;
	}
	if (asksFamily) {
		if (/arabic/i.test(lang)) return `${name}، ${hotelName} خيار عملي للعائلات لأنه يقع في ${place}${facts.quiet ? "، في منطقة هادئة" : ""}.${serviceLine}${distance} ${next}`;
		if (/spanish/i.test(lang)) return `${name}, ${hotelName} puede ser una opcion practica para familias porque esta en ${place}${facts.quiet ? ", en una zona tranquila" : ""}.${serviceLine}${distance} ${next}`;
		if (/french/i.test(lang)) return `${name}, ${hotelName} peut etre un choix pratique pour les familles car il se trouve dans ${place}${facts.quiet ? ", dans un quartier calme" : ""}.${serviceLine}${distance} ${next}`;
		if (/urdu|hindi/i.test(lang)) return `${name}, ${hotelName} families ke liye practical choice ho sakta hai kyunki yeh ${place} mein hai${facts.quiet ? ", quiet area mein" : ""}.${serviceLine}${distance} ${next}`;
		if (/indonesian/i.test(lang)) return `${name}, ${hotelName} bisa menjadi pilihan praktis untuk keluarga karena berada di ${place}${facts.quiet ? ", di area yang tenang" : ""}.${serviceLine}${distance} ${next}`;
		if (/malay|malaysia/i.test(lang)) return `${name}, ${hotelName} boleh menjadi pilihan praktikal untuk keluarga kerana berada di ${place}${facts.quiet ? ", di kawasan yang tenang" : ""}.${serviceLine}${distance} ${next}`;
		return `${name}, ${hotelName} can be a practical family choice because it is in ${place}${facts.quiet ? ", in a quiet area" : ""}.${serviceLine}${distance} ${next}`;
	}
	if (asksFirstTime) {
		if (/arabic/i.test(lang)) return `${name}، لأول إقامة عمرة في ${hotelName} أنصحك بحفظ رابط الخريطة${mapLink ? `: ${mapLink}` : ""}، وترتيب الذهاب للحرم بالسيارة أو خدمة الباص المتاحة، واختيار نوع الغرفة بعد تحديد التواريخ.${serviceLine}${distance} ${next}`;
		if (/spanish/i.test(lang)) return `${name}, para una primera estancia de Umrah en ${hotelName}, te recomiendo guardar el mapa${mapLink ? `: ${mapLink}` : ""}, planear los traslados al Haram en coche o con el bus disponible, y elegir el tipo de habitacion despues de confirmar las fechas.${serviceLine}${distance} ${next}`;
		if (/french/i.test(lang)) return `${name}, pour un premier sejour Omra a ${hotelName}, je vous conseille de garder le plan${mapLink ? ` : ${mapLink}` : ""}, de prevoir les trajets vers le Haram en voiture ou avec le bus disponible, puis de choisir la chambre une fois les dates claires.${serviceLine}${distance} ${next}`;
		if (/urdu|hindi/i.test(lang)) return `${name}, first-time Umrah stay ke liye ${hotelName} mein map link save rakhna useful hai${mapLink ? `: ${mapLink}` : ""}, Haram trips car ya available bus service se plan karein, aur dates clear hone ke baad room type choose karein.${serviceLine}${distance} ${next}`;
		if (/indonesian/i.test(lang)) return `${name}, untuk pengalaman Umrah pertama di ${hotelName}, sebaiknya simpan tautan peta${mapLink ? `: ${mapLink}` : ""}, rencanakan perjalanan ke Haram dengan mobil atau bus yang tersedia, lalu pilih tipe kamar setelah tanggal jelas.${serviceLine}${distance} ${next}`;
		if (/malay|malaysia/i.test(lang)) return `${name}, untuk pengalaman Umrah pertama di ${hotelName}, elok simpan pautan peta${mapLink ? `: ${mapLink}` : ""}, rancang perjalanan ke Haram dengan kereta atau bus yang tersedia, kemudian pilih jenis bilik selepas tarikh jelas.${serviceLine}${distance} ${next}`;
		return `${name}, for a first-time Umrah stay at ${hotelName}, I would keep the map link handy${mapLink ? `: ${mapLink}` : ""}, plan Haram trips by car or the available bus service, and choose the room type after your dates are clear.${serviceLine}${distance} ${next}`;
	}
	if (asksLandmark) {
		if (/arabic/i.test(lang)) return `${name}، ${hotelName} يقع في ${place}.${serviceLine}${distance}${mapLink ? ` رابط الخريطة: ${mapLink}.` : ""} ${next}`;
		if (/spanish/i.test(lang)) return `${name}, ${hotelName} esta en ${place}.${serviceLine}${distance}${mapLink ? ` Aqui esta el mapa: ${mapLink}.` : ""} ${next}`;
		if (/french/i.test(lang)) return `${name}, ${hotelName} se trouve dans ${place}.${serviceLine}${distance}${mapLink ? ` Voici le plan : ${mapLink}.` : ""} ${next}`;
		if (/urdu|hindi/i.test(lang)) return `${name}, ${hotelName} ${place} mein hai.${serviceLine}${distance}${mapLink ? ` Map link: ${mapLink}.` : ""} ${next}`;
		if (/indonesian/i.test(lang)) return `${name}, ${hotelName} berada di ${place}.${serviceLine}${distance}${mapLink ? ` Ini tautan peta: ${mapLink}.` : ""} ${next}`;
		if (/malay|malaysia/i.test(lang)) return `${name}, ${hotelName} berada di ${place}.${serviceLine}${distance}${mapLink ? ` Ini pautan peta: ${mapLink}.` : ""} ${next}`;
		return `${name}, ${hotelName} is in ${place}.${serviceLine}${distance}${mapLink ? ` Here is the map link: ${mapLink}.` : ""} ${next}`;
	}
	if (asksNearby) {
		if (/arabic/i.test(lang)) return `${name}، ${hotelName} يقع في ${place}.${serviceLine || " لا أرى أسماء مطاعم أو محلات محددة مؤكدة الآن."}${distance}${mapLink ? ` رابط الخريطة الدقيق: ${mapLink}.` : ""} ${next}`;
		if (/spanish/i.test(lang)) return `${name}, ${hotelName} esta en ${place}.${serviceLine || " No veo nombres exactos de tiendas o restaurantes confirmados ahora mismo."}${distance}${mapLink ? ` Mapa exacto: ${mapLink}.` : ""} ${next}`;
		if (/french/i.test(lang)) return `${name}, ${hotelName} se trouve dans ${place}.${serviceLine || " Je ne vois pas de noms exacts de restaurants ou boutiques confirmes pour le moment."}${distance}${mapLink ? ` Plan exact : ${mapLink}.` : ""} ${next}`;
		if (/urdu|hindi/i.test(lang)) return `${name}, ${hotelName} ${place} mein hai.${serviceLine || " Filhal exact restaurant ya shop names confirmed nazar nahi aa rahe."}${distance}${mapLink ? ` Exact map link: ${mapLink}.` : ""} ${next}`;
		if (/indonesian/i.test(lang)) return `${name}, ${hotelName} berada di ${place}.${serviceLine || " Saya belum melihat nama restoran atau toko tertentu yang terkonfirmasi saat ini."}${distance}${mapLink ? ` Tautan peta tepat: ${mapLink}.` : ""} ${next}`;
		if (/malay|malaysia/i.test(lang)) return `${name}, ${hotelName} berada di ${place}.${serviceLine || " Saya belum nampak nama restoran atau kedai tertentu yang disahkan sekarang."}${distance}${mapLink ? ` Pautan peta tepat: ${mapLink}.` : ""} ${next}`;
		return `${name}, ${hotelName} is in ${place}.${serviceLine || " I do not see exact nearby shop or restaurant names confirmed right now."}${distance}${mapLink ? ` Here is the exact map link: ${mapLink}.` : ""} ${next}`;
	}
	return "";
}

function selectedHotelFactAnswerText(sc = {}, st = {}, userText = "") {
	const hotel = st.hotel || {};
	const lang = languageOf(sc, st);
	const name = respectfulGuestName(sc, st);
	const hotelName = localizedHotelName(sc, st);
	const walking = formatHotelDistanceValue(hotel.distances?.walkingToElHaram, lang);
	const driving = formatHotelDistanceValue(hotel.distances?.drivingToElHaram, lang);
	const address = hotelFactAddressLine(hotel, lang);
	const mapLink = hotelGoogleMapsMarkdownLink(hotel, lang);
	const mapLine = hotelLocationMapLine(lang, mapLink);
	const next = hotelFactNextStepText(sc, st);
	const asksNusuk = selectedHotelNusukQuestionText(userText);
	const asksBus = selectedHotelBusQuestionText(userText);
	const asksDistance = selectedHotelDistanceQuestionText(userText);
	const asksAddress = selectedHotelAddressQuestionText(userText);
	const asksPolicy = selectedHotelPolicyQuestionText(userText);
	const asksMeals = selectedHotelMealsQuestionText(userText);
	const asksLocalArea = selectedHotelLocalAreaQuestionText(userText);
	const asksCoordinates = selectedHotelCoordinatesQuestionText(userText);
	const isNusuk = hotel.isNusuk === true;
	const nusukDetails = cleanHotelFactText(hotel.isNusukText);
	const hasBusService = hotel.hasBusService === true;
	const busDetails = cleanHotelFactText(hotel.busDetails);
	if (asksPolicy) {
		const answer = hotelPolicyAnswerText(sc, st, userText);
		if (answer) return answer;
	}
	if (asksMeals) {
		return selectedHotelMealsAnswerText(sc, st);
	}
	if (asksCoordinates && mapLine) {
		if (/arabic/i.test(lang)) {
			return `${name}\u060c \u0646\u0639\u0645\u060c \u0631\u0627\u0628\u0637 Google Maps \u064a\u0633\u062a\u062e\u062f\u0645 \u0625\u062d\u062f\u0627\u062b\u064a\u0627\u062a ${hotelName} \u0627\u0644\u0645\u062d\u0641\u0648\u0638\u0629 \u0644\u062f\u064a\u0646\u0627. ${mapLine} ${next}`;
		}
		if (/spanish/i.test(lang)) return `${name}, si, el enlace de Google Maps usa las coordenadas guardadas de ${hotelName}. ${mapLine} ${next}`;
		if (/french/i.test(lang)) return `${name}, oui, le lien Google Maps utilise les coordonnees enregistrees de ${hotelName}. ${mapLine} ${next}`;
		if (/urdu|hindi/i.test(lang)) return `${name}, ji haan, Google Maps link ${hotelName} ki saved coordinates use karta hai. ${mapLine} ${next}`;
		if (/indonesian/i.test(lang)) return `${name}, ya, tautan Google Maps memakai koordinat tersimpan untuk ${hotelName}. ${mapLine} ${next}`;
		if (/malay|malaysia/i.test(lang)) return `${name}, ya, pautan Google Maps menggunakan koordinat tersimpan untuk ${hotelName}. ${mapLine} ${next}`;
		return `${name}, yes, the Google Maps link uses the saved coordinates for ${hotelName}. ${mapLine} ${next}`;
	}
	if (asksNusuk) {
		return isNusuk
			? hotelNusukYesText(lang, name, nusukDetails, next)
			: hotelNusukNoText(lang, name, next);
	}
	if (asksBus) {
		return hasBusService
			? hotelBusServiceYesText(lang, name, busDetails, next)
			: hotelBusServiceNoText(lang, name, hotelName, walking, next);
	}
	if (asksLocalArea) {
		const answer = selectedHotelLocalAreaAnswerText(sc, st, userText);
		if (answer) return answer;
	}
	if (/arabic/i.test(lang)) {
		if (asksDistance) {
			if (walking || driving) {
				const distance = localizedJoin(
					[
						walking ? `${walking} \u0645\u0634\u064a\u0627` : "",
						driving ? `${driving} \u0628\u0627\u0644\u0633\u064a\u0627\u0631\u0629` : "",
					],
					lang
				);
				return `${name}\u060c ${hotelName} \u064a\u0628\u0639\u062f \u0639\u0646 \u0627\u0644\u062d\u0631\u0645 \u062a\u0642\u0631\u064a\u0628\u0627 ${distance} \u062d\u0633\u0628 \u0627\u0644\u0632\u062d\u0627\u0645. \u0645\u0648\u0642\u0639\u0647 \u0639\u0645\u0644\u064a \u062c\u062f\u0627 \u0644\u0636\u064a\u0648\u0641 \u0627\u0644\u0639\u0645\u0631\u0629. ${next}`;
			}
			return `${name}\u060c \u0644\u0627 \u064a\u0638\u0647\u0631 \u0644\u062f\u064a \u0631\u0642\u0645 \u062f\u0642\u064a\u0642 \u0644\u0644\u0645\u0633\u0627\u0641\u0629 \u0641\u064a \u0628\u064a\u0627\u0646\u0627\u062a ${hotelName} \u062d\u0627\u0644\u064a\u0627. ${next}`;
		}
		if (asksAddress) {
			if (address) {
				const distanceNote = walking || driving ? ` \u0648\u064a\u0628\u0639\u062f \u0639\u0646 \u0627\u0644\u062d\u0631\u0645 \u062a\u0642\u0631\u064a\u0628\u0627 ${localizedJoin([walking ? `${walking} \u0645\u0634\u064a\u0627` : "", driving ? `${driving} \u0628\u0627\u0644\u0633\u064a\u0627\u0631\u0629` : ""], lang)}.` : "";
				return `${name}\u060c \u0639\u0646\u0648\u0627\u0646 ${hotelName}: ${address}.${distanceNote}${mapLine ? ` ${mapLine}` : ""} ${next}`;
			}
			if (mapLine) return `${name}\u060c ${mapLine} ${next}`;
			return `${name}\u060c \u0644\u0627 \u064a\u0638\u0647\u0631 \u0644\u062f\u064a \u0639\u0646\u0648\u0627\u0646 \u062f\u0642\u064a\u0642 \u0645\u0643\u062a\u0648\u0628 \u0644\u0640 ${hotelName} \u062d\u0627\u0644\u064a\u0627. ${next}`;
		}
	}
	if (/spanish/i.test(lang)) {
		if (asksDistance && (walking || driving)) return `${name}, ${hotelName} esta a unos ${localizedJoin([walking ? `${walking} caminando` : "", driving ? `${driving} en coche` : ""], lang)} del Haram, segun el trafico. Es una ubicacion muy practica para huespedes de Umrah. ${next}`;
		if (asksAddress && address) return `${name}, la direccion de ${hotelName} es: ${address}.${walking || driving ? ` Esta a unos ${localizedJoin([walking ? `${walking} caminando` : "", driving ? `${driving} en coche` : ""], lang)} del Haram.` : ""}${mapLine ? ` ${mapLine}` : ""} ${next}`;
		if (asksAddress && mapLine) return `${name}, ${mapLine} ${next}`;
		return `${name}, no veo ese dato exacto confirmado en los detalles de ${hotelName} ahora mismo. ${next}`;
	}
	if (/french/i.test(lang)) {
		if (asksDistance && (walking || driving)) return `${name}, ${hotelName} se trouve a environ ${localizedJoin([walking ? `${walking} a pied` : "", driving ? `${driving} en voiture` : ""], lang)} du Haram, selon la circulation. C'est un emplacement tres pratique pour les voyageurs Omra. ${next}`;
		if (asksAddress && address) return `${name}, l'adresse de ${hotelName} est : ${address}.${walking || driving ? ` Il se trouve a environ ${localizedJoin([walking ? `${walking} a pied` : "", driving ? `${driving} en voiture` : ""], lang)} du Haram.` : ""}${mapLine ? ` ${mapLine}` : ""} ${next}`;
		if (asksAddress && mapLine) return `${name}, ${mapLine} ${next}`;
		return `${name}, je ne vois pas ce detail exact confirme dans les informations de ${hotelName} pour le moment. ${next}`;
	}
	if (/urdu/i.test(lang) && asksAddress && mapLine) {
		const addressLine = address ? `${hotelName} address: ${address}. ` : "";
		return `${name}, ${addressLine}${mapLine} ${next}`;
	}
	if (/hindi/i.test(lang) && asksAddress && mapLine) {
		const addressLine = address ? `${hotelName} address: ${address}. ` : "";
		return `${name}, ${addressLine}${mapLine} ${next}`;
	}
	if (/urdu/i.test(lang)) {
		if (asksDistance && (walking || driving)) return `${name}، ${hotelName} حرم سے تقریباً ${localizedJoin([walking ? `${walking} پیدل` : "", driving ? `${driving} گاڑی سے` : ""], lang)} دور ہے، ٹریفک کے حساب سے۔ عمرہ guests کے لیے location بہت practical ہے۔ ${next}`;
		if (asksAddress && address) return `${name}، ${hotelName} کا address: ${address}.${walking || driving ? ` حرم سے تقریباً ${localizedJoin([walking ? `${walking} پیدل` : "", driving ? `${driving} گاڑی سے` : ""], lang)} ہے۔` : ""} ${next}`;
		return `${name}، اس وقت ${hotelName} کی details میں یہ exact معلومات confirmed نظر نہیں آ رہیں۔ ${next}`;
	}
	if (/hindi/i.test(lang)) {
		if (asksDistance && (walking || driving)) return `${name}, ${hotelName} Haram से लगभग ${localizedJoin([walking ? `${walking} पैदल` : "", driving ? `${driving} गाड़ी से` : ""], lang)} दूर है, traffic के अनुसार। Umrah guests के लिए location बहुत practical है। ${next}`;
		if (asksAddress && address) return `${name}, ${hotelName} का address: ${address}.${walking || driving ? ` Haram से लगभग ${localizedJoin([walking ? `${walking} पैदल` : "", driving ? `${driving} गाड़ी से` : ""], lang)} है।` : ""} ${next}`;
		return `${name}, अभी ${hotelName} की details में यह exact जानकारी confirmed नहीं दिख रही है। ${next}`;
	}
	if (/indonesian/i.test(lang)) {
		if (asksDistance && (walking || driving)) return `${name}, ${hotelName} berjarak sekitar ${localizedJoin([walking ? `${walking} berjalan kaki` : "", driving ? `${driving} dengan mobil` : ""], lang)} dari Haram, tergantung lalu lintas. Lokasinya sangat praktis untuk tamu Umrah. ${next}`;
		if (asksAddress && address) return `${name}, alamat ${hotelName}: ${address}.${walking || driving ? ` Jaraknya sekitar ${localizedJoin([walking ? `${walking} berjalan kaki` : "", driving ? `${driving} dengan mobil` : ""], lang)} dari Haram.` : ""}${mapLine ? ` ${mapLine}` : ""} ${next}`;
		if (asksAddress && mapLine) return `${name}, ${mapLine} ${next}`;
		return `${name}, saya belum melihat detail pasti itu di data ${hotelName} saat ini. ${next}`;
	}
	if (/malay|malaysia/i.test(lang)) {
		if (asksDistance && (walking || driving)) return `${name}, ${hotelName} kira-kira ${localizedJoin([walking ? `${walking} berjalan kaki` : "", driving ? `${driving} dengan kereta` : ""], lang)} dari Haram, bergantung pada trafik. Lokasinya sangat praktikal untuk tetamu Umrah. ${next}`;
		if (asksAddress && address) return `${name}, alamat ${hotelName}: ${address}.${walking || driving ? ` Jaraknya kira-kira ${localizedJoin([walking ? `${walking} berjalan kaki` : "", driving ? `${driving} dengan kereta` : ""], lang)} dari Haram.` : ""}${mapLine ? ` ${mapLine}` : ""} ${next}`;
		if (asksAddress && mapLine) return `${name}, ${mapLine} ${next}`;
		return `${name}, saya belum nampak butiran tepat itu dalam data ${hotelName} sekarang. ${next}`;
	}
	if (asksDistance) {
		if (walking || driving) {
			return `${name}, ${hotelName} is about ${localizedJoin([walking ? `${walking} on foot` : "", driving ? `${driving} by car` : ""], lang)} from Al Haram, depending on traffic. It is a very practical location for Umrah guests. ${next}`;
		}
		return `${name}, I do not see an exact distance confirmed in ${hotelName}'s details right now. ${next}`;
	}
	if (asksAddress) {
		if (address) {
			const distanceNote = walking || driving ? ` It is about ${localizedJoin([walking ? `${walking} on foot` : "", driving ? `${driving} by car` : ""], lang)} from Al Haram.` : "";
			return `${name}, the address for ${hotelName} is: ${address}.${distanceNote}${mapLine ? ` ${mapLine}` : ""} ${next}`;
		}
		if (mapLine) return `${name}, ${mapLine} ${next}`;
		return `${name}, I do not see a precise written address in ${hotelName}'s details right now. ${next}`;
	}
	return "";
}

async function answerSelectedHotelFactQuestion(io, sc, st, userText = "") {
	const previousWaitFor = st.waitFor || null;
	const policyRow =
		!selectedHotelMealsQuestionText(userText) && selectedHotelPolicyQuestionText(userText)
		? bestHotelPolicyRow(st, userText)
		: null;
	let reply = "";
	if (policyRow) {
		reply = hotelPolicyAnswerText(sc, st, userText, policyRow);
		if (!reply && process.env.AI_LEGACY_FACT_FALLBACK === "true") {
			reply = await withSoftTimeout(
				write(
					io,
					sc,
					st,
					"The guest asked about the selected hotel's policy, terms, or house rules. Answer directly from selectedHotelPolicy only. Translate or adapt the saved answer into the guest's active response language in professional hotel-reception wording. Use hotel-native wording such as 'Based on the hotel's terms and conditions' or a direct reception answer when a source phrase is useful. Never say 'I checked', 'I found in the document', 'the record says', 'the hotel details say', or imply the answer came from an external/admin document. Do not add a link. Do not invent exceptions, deadlines, prices, or legal wording beyond the saved answer. If the saved answer does not fully answer the latest question, say exactly what is known from the saved policy and then ask one relevant follow-up.",
					{
						latestUserMessage: userText,
						selectedHotelPolicy: policyRow,
						defaultCancellationRefundPolicy: DEFAULT_CANCELLATION_REFUND_ANSWER,
						nextStep: nextPivot(st),
					}
				),
				QUOTE_WRITE_SOFT_TIMEOUT_MS,
				selectedHotelFactAnswerText(sc, st, userText)
			);
		}
	} else {
		reply = selectedHotelFactAnswerText(sc, st, userText);
	}
	if (!reply && process.env.AI_LEGACY_FACT_FALLBACK === "true") {
		const lang = languageOf(sc, st);
		const fallback = /arabic/i.test(lang)
			? `${respectfulGuestName(sc, st)}، لا يظهر لدي هذا التفصيل مؤكدا في بيانات ${localizedHotelName(sc, st)} حاليا. ${hotelFactNextStepText(sc, st)}`
			: `${respectfulGuestName(sc, st)}, I do not see that exact detail confirmed for ${localizedHotelName(sc, st)} right now. ${hotelFactNextStepText(sc, st)}`;
		reply = await withSoftTimeout(
			write(
				io,
				sc,
				st,
				"The guest asked a direct factual question about the selected hotel. Answer directly using selectedHotelFacts only, then add one warm sales sentence and one natural next booking step. Do not ask for dates before answering the fact. Do not mention Jannat Booking or any other hotel.",
				{
					latestUserMessage: userText,
					selectedHotelFacts: buildActiveHotelFacts(sc, st),
					nextStep: nextPivot(st),
				}
			),
			QUOTE_WRITE_SOFT_TIMEOUT_MS,
			fallback
		);
	}
	const factLang = languageOf(sc, st);
	const fallbackText =
		reply ||
		selectedHotelFactAnswerText(sc, st, userText) ||
		(/arabic/i.test(factLang)
			? `${respectfulGuestName(sc, st)}\u060c \u0644\u0627 \u064a\u0638\u0647\u0631 \u0644\u062f\u064a \u0647\u0630\u0627 \u0627\u0644\u062a\u0641\u0635\u064a\u0644 \u0645\u0624\u0643\u062f\u0627 \u0644\u0640 ${localizedHotelName(sc, st)} \u062d\u0627\u0644\u064a\u0627. ${hotelFactNextStepText(sc, st)}`
			: `${respectfulGuestName(sc, st)}, I do not see that exact detail confirmed for ${localizedHotelName(sc, st)} right now. ${hotelFactNextStepText(sc, st)}`);
	const postBookingFact = Boolean(aiReservationReference(sc) || st.waitFor === "post_booking_followup");
	const instruction = policyRow
		? "The guest asked about the selected hotel's policy, terms, or house rules. Answer directly from selectedHotelPolicy and fallbackText only. Rewrite into polished professional reception wording in the active language, but keep every policy fact unchanged. Never say 'I checked', 'I found', 'document', 'record', 'hotel details say', or imply an admin/source document. Do not add a link. Do not invent exceptions, deadlines, prices, refunds, or legal wording. If the saved policy only partly answers, state exactly what is known and ask one relevant follow-up."
		: postBookingFact
		? "The guest asked a direct factual question about the selected hotel after the reservation was already created. Answer directly using selectedHotelFacts and fallbackText only, then add one short professional line asking whether they need anything else. Do not ask to continue, review, create, finalize, or confirm the reservation again. Do not ask for dates before answering the fact. Do not mention Jannat Booking or any other hotel unless explicitly required by supplied context. Do not invent addresses, distances, bus schedules, meal service details, Nusuk status, policies, room facts, prices, contacts, or links."
		: "The guest asked a direct factual question about the selected hotel. Answer directly using selectedHotelFacts and fallbackText only, then add one warm hospitality/sales sentence and one natural next booking step. Do not ask for dates before answering the fact. Do not mention Jannat Booking or any other hotel unless explicitly required by supplied context. Do not invent addresses, distances, bus schedules, meal service details, Nusuk status, policies, room facts, prices, contacts, or links.";
	const sent = await sendDynamicWrittenReply(io, sc, st, userText, instruction, {
		latestUserMessage: userText,
		selectedHotel: localizedHotelName(sc, st),
		selectedHotelPolicy: policyRow || null,
		defaultCancellationRefundPolicy: DEFAULT_CANCELLATION_REFUND_ANSWER,
		selectedHotelFacts: buildActiveHotelFacts(sc, st),
		fallbackText,
		nextStep: nextPivot(st),
		postBookingFact,
	}, {
		fallbackText,
		targetReplyMs: AI_BOOKING_PROMPT_TARGET_MS,
		scheduleIdle: policyRow ? false : true,
	});
	if (!sent) return false;
	if (aiReservationReference(sc)) {
		st.waitFor = "post_booking_followup";
		st.reviewSent = false;
	} else {
		st.waitFor = previousWaitFor || nextPivot(st);
	}
	logStep(String(sc._id), "selected_hotel.fact_reply", {
		latestUserMessage: String(userText || "").slice(0, 160),
		waitFor: st.waitFor,
		hasDistance: Boolean(
			st.hotel?.distances?.walkingToElHaram ||
				st.hotel?.distances?.drivingToElHaram
		),
		hasAddress: Boolean(st.hotel?.hotelAddress),
		hasGoogleMapsLink: Boolean(hotelGoogleMapsUrl(st.hotel)),
		isNusuk: st.hotel?.isNusuk === true,
		policyKey: policyRow?.key || "",
	});
	return true;
}

async function buildHotelRecommendations({
	text,
	sc,
	st,
	requestedRoomTypeKey = null,
}) {
	if (st.hotel) {
		return selectedHotelSupportBoundaryReply(sc, st);
	}
	const roomTypeKey = /triple|ثلاث|triple/i.test(text)
		? "tripleRooms"
		: /quad|رباع|quad/i.test(text)
		? "quadRooms"
		: "doubleRooms";
	const selectedRoomTypeKey = requestedRoomTypeKey || roomTypeKey;
	const hotels = await listActivePublicHotels();
	const makkahOnly = wantsMakkahNearHaram(text);
	const scopedHotels = makkahOnly ? hotels.filter(isMakkahHotel) : hotels;
	const matches = scopedHotels
		.filter((hotel) =>
			(hotel.roomCountDetails || []).some((room) =>
				roomMatches(room, selectedRoomTypeKey)
			)
		)
		.map((hotel) => {
			const room = (hotel.roomCountDetails || []).find((item) =>
				roomMatches(item, selectedRoomTypeKey)
			);
			return {
				name: toTitle(hotel.hotelName),
				walking: hotel.distances?.walkingToElHaram || "",
				driving: hotel.distances?.drivingToElHaram || "",
				roomLabel: room?.displayName || roomTypeLabel(selectedRoomTypeKey),
				url: publicHotelUrl(hotel.hotelName),
			};
		})
		.sort(
			(a, b) =>
				firstNumber(a.walking) - firstNumber(b.walking) ||
				firstNumber(a.driving) - firstNumber(b.driving)
		)
		.slice(0, 3);

	return write(
		null,
		sc,
		st,
		"Answer the guest's hotel recommendation request using the provided active hotel matches only. If matches exist, include each hotel as a markdown link with the hotel name as the link text, preserve the provided hotel name casing, mention distance briefly when available, and ask for check-in and checkout dates if pricing is needed. If no matches exist, say you do not see matching active options right now and ask for dates or flexibility. Keep it short.",
		{
			requestedRoomType: selectedRoomTypeKey,
			activeHotelMatches: matches,
			locationScope: makkahOnly ? "makkah_near_al_haram" : "all_active_hotels",
			latestUserMessage: text,
		}
	);

	const name = firstNameForAddress(
		st.slots?.name || st.slots?.fullName || sc.displayName1 || "Guest"
	);
	const lang = languageOf(sc, st);
	if (!matches.length) {
		if (/arabic/i.test(lang)) {
			return `${name}، لا أرى غرفاً مزدوجة متاحة في الفنادق القريبة حالياً. أرسل تاريخ الدخول والخروج لأراجع لك خيارات أخرى.`;
		}
		return `${name}, I do not see double-room options near Al Haram right now. Please send check-in and checkout dates and I can check alternatives.`;
	}

	const lines = matches.map(
		(hotel) =>
			`- [${toTitle(hotel.name)}](${hotel.url})${
				hotel.walking ? ` - ${hotel.walking} walking` : ""
			}${hotel.driving ? `, ${hotel.driving} driving` : ""}`
	);
	if (/arabic/i.test(lang)) {
		return `نعم ${name}، هذه خيارات قريبة من الحرم:\n${lines.join(
			"\n"
		)}\nأرسل تاريخ الدخول والخروج لأراجع السعر.`;
	}
	if (/spanish/i.test(lang)) {
		return `Sí ${name}, estas opciones están cerca de Al Haram:\n${lines.join(
			"\n"
		)}\nEnvíame check-in y check-out para revisar precios.`;
	}
	if (/french/i.test(lang)) {
		return `Oui ${name}, voici des options proches d'Al Haram:\n${lines.join(
			"\n"
		)}\nEnvoyez les dates d'arrivée et de départ pour vérifier les prix.`;
	}
	return `Yes ${name}, good double-room options near Al Haram include:\n${lines.join(
		"\n"
	)}\nSend check-in and checkout dates and I can check prices.`;
}

async function buildJannatBookingHotelOptions({
	text,
	sc,
	st,
	requestedRoomTypeKey = null,
}) {
	const selectedRoomTypeKey =
		requestedRoomTypeKey ||
		st.slots.roomTypeKey ||
		mapRoomToKey(text) ||
		"doubleRooms";
	const hasDates = Boolean(st.slots.checkinISO && st.slots.checkoutISO);
	const budget = budgetFromText(
		[
			text,
			initialInquiryText(sc),
			recentConversationLines(sc, st).slice(-3000),
		].join("\n")
	);
	const hotels = await listActivePublicHotels();
	const makkahOnly = wantsMakkahNearHaram(
		[text, initialInquiryText(sc), recentConversationLines(sc, st).slice(-2000)]
			.filter(Boolean)
			.join("\n")
	);
	const scopedHotels = makkahOnly ? hotels.filter(isMakkahHotel) : hotels;
	const options = scopedHotels
		.filter(
			(hotel) =>
				hotel.aiToRespond === true &&
				!isJannatBookingSupportCase({ hotelId: hotel._id }, hotel)
		)
		.map((hotel) => {
			const room = (hotel.roomCountDetails || []).find((item) =>
				roomMatches(item, selectedRoomTypeKey)
			);
			if (!room) return null;
			const quote = hasDates
				? safePriceRoomForStay(
						hotel,
						{ roomType: selectedRoomTypeKey },
						st.slots.checkinISO,
						st.slots.checkoutISO
				  )
				: null;
			if (hasDates && !quote?.available) return null;
			const total = Number(quote?.totals?.totalPriceWithCommission || 0);
			const distanceScore =
				firstNumber(hotel.distances?.walkingToElHaram || "") ||
				firstNumber(hotel.distances?.drivingToElHaram || "") ||
				999;
			const budgetScore =
				budget && total
					? total <= budget
						? Math.max(0, budget - total) / 1000
						: 100 + (total - budget) / 100
					: 0;
			return {
				hotelId: idText(hotel._id),
				hotelName: toTitle(hotel.hotelName),
				roomTypeKey: selectedRoomTypeKey,
				roomLabel: room.displayName || roomTypeLabel(selectedRoomTypeKey),
				walking: hotel.distances?.walkingToElHaram || "",
				driving: hotel.distances?.drivingToElHaram || "",
				url: publicHotelUrl(hotel.hotelName),
				quote,
				total,
				currency: cleanCurrency(quote?.currency || hotel.currency || "SAR"),
				nights: quote?.nights || 0,
				_score: budgetScore + distanceScore,
			};
		})
		.filter(Boolean)
		.sort((a, b) => a._score - b._score || a.total - b.total)
		.slice(0, 4);

	st.platformHotelOptions = options;
	st.slots.roomTypeKey = selectedRoomTypeKey;

	const draftedReply = await write(
		null,
		sc,
		st,
		hasDates
			? "You are Jannat Booking concierge support. Recommend the best available hotel options from activeHotelOptions only, using totals/prices exactly as provided. Mention budget fit if budget is present. Be warm and helpful. Important: say Jannat Booking support can help compare options and pricing, but the official reservation confirmation and payment/details link must be completed by the selected hotel's reception and reservations desk. End by asking which hotel they would like to connect with."
			: "You are Jannat Booking concierge support. Recommend the active hotel options from activeHotelOptions only, focusing on fit and distance if available. Do not invent prices because stay dates are missing. Ask for check-in/check-out dates and approximate budget so you can compare properly. Mention that once they choose a hotel, that hotel's reception and reservations desk will confirm the reservation and links.",
		{
			latestUserMessage: text,
			requestedRoomType: selectedRoomTypeKey,
			checkinISO: st.slots.checkinISO,
			checkoutISO: st.slots.checkoutISO,
			budget,
			locationScope: makkahOnly ? "makkah_near_al_haram" : "all_active_hotels",
			activeHotelOptions: options.map((option) => ({
				hotelName: option.hotelName,
				roomLabel: option.roomLabel,
				walking: option.walking,
				driving: option.driving,
				total: option.total || null,
				currency: option.currency,
				nights: option.nights || null,
				url: option.url,
			})),
		}
	);
	const reply = ensurePlatformOptionsVisible(
		draftedReply,
		sc,
		st,
		options,
		hasDates
	);
	return {
		reply,
		options,
		hasDates,
	};
}

async function answerJannatBookingHotelOptions(
	io,
	sc,
	st,
	userText,
	requestedRoomTypeKey = null
) {
	const result = await buildJannatBookingHotelOptions({
		text: userText,
		sc,
		st,
		requestedRoomTypeKey,
	});
	const sent = await humanSend(io, sc, st, result.reply, {
		quickReplies: result.options.length
			? platformHotelOptionQuickReplies(sc, st)
			: [],
	});
	if (!sent) return false;
	st.waitFor = result.options.length ? "platform_hotel_choice" : "dates";
	return true;
}

async function connectJannatCaseToHotelSupport(
	io,
	sc,
	st,
	optionOrHotel,
	{ reason = "new_reservation", confirmation = "", requestedDates = null } = {}
) {
	const caseId = String(sc._id);
	const targetHotelId = idText(optionOrHotel?.hotelId || optionOrHotel?._id);
	if (!targetHotelId) return false;
	const hotel = optionOrHotel?.roomCountDetails
		? optionOrHotel
		: await getHotelById(targetHotelId);
	if (!hotel) return false;
	const hotelName = toTitle(hotel.hotelName || optionOrHotel.hotelName || "the hotel");
	const conciergeAgentName = st.agentName;
	const conciergeText = await write(
		io,
		sc,
		st,
		reason === "reservation_cancellation"
			? "Speak as Jannat Booking concierge support. Tell the guest you found the right hotel reception and reservations desk and will connect them now for the cancellation review. Reassure them that the selected hotel's team will handle the official reservation action. Keep it one warm sentence."
			: "Speak as Jannat Booking concierge support. Tell the guest you found the right hotel reception and reservations desk and will connect them now. Reassure them that the selected hotel's team will handle the official confirmation and reservation/payment/details links. Keep it one warm sentence.",
		{
			hotelName,
			reason,
			confirmation,
			requestedDates,
			selectedOption: optionOrHotel,
		}
	);
	const conciergeSent = await humanSend(
		io,
		sc,
		st,
		conciergeText ||
			`Great, I will connect you with ${hotelName} reception and reservations now so their team can handle the official confirmation and links.`
	);
	if (!conciergeSent) return false;

	const nextAgentName = chooseHotelHandoffAgentName(
		caseId,
		targetHotelId,
		st.agentName
	);
	st.hotel = hotel;
	st.agentName = nextAgentName;
	st.greeted = true;
	sc.hotelId = hotel._id || targetHotelId;
	sc.supportScope = "hotel";
	sc.aiResponderName = nextAgentName;
	if (optionOrHotel?.roomTypeKey) st.slots.roomTypeKey = optionOrHotel.roomTypeKey;
	if (optionOrHotel?.quote?.available) {
		st.quote = {
			key: quoteKeyForSlots(st),
			at: now(),
			data: optionOrHotel.quote,
		};
	}

	const updatedCase = await updateSupportCaseAppend(caseId, {
		hotelId: hotel._id || targetHotelId,
		supportScope: "hotel",
		displayName2: hotelName,
		targetUserName: hotelName,
		aiResponderName: nextAgentName,
		aiToRespond: true,
		aiRelated: true,
		aiHandoffReason: "",
		aiPausedAt: null,
	});
	if (updatedCase) {
		io.to(caseId).emit("supportCaseUpdated", updatedCase);
		io.emit("supportCaseUpdated", updatedCase);
	}

	const introInstruction =
		reason === "reservation_update"
			? "You are now the selected hotel's reception and reservations representative. Introduce yourself by first name from the hotel reception and reservations desk, acknowledge that Jannat Booking connected the guest for this reservation update, and say you will check the requested change with availability now. Keep it friendly and concise."
			: reason === "reservation_cancellation"
			? "You are now the selected hotel's reception and reservations representative. Introduce yourself by first name from the hotel reception and reservations desk, acknowledge that Jannat Booking connected the guest for a cancellation review, and say you will check the reservation policy now. Keep it friendly and concise."
			: reason === "payment_help"
			? "You are now the selected hotel's reception and reservations representative. Introduce yourself by first name from the hotel reception and reservations desk, acknowledge that Jannat Booking connected the guest for payment/reservation link help, and reassure them you will help with the official hotel link or payment question. Keep it friendly and concise."
			: reason === "reservation_support"
			? "You are now the selected hotel's reception and reservations representative. Introduce yourself by first name from the hotel reception and reservations desk, acknowledge that Jannat Booking connected the guest for their existing reservation, and ask one short question about what they need help with."
			: optionOrHotel?.quote?.available
			? "You are now the selected hotel's reception and reservations representative. Introduce yourself by first name from the hotel reception and reservations desk, acknowledge the selected priced option, and ask one yes/no question: whether to continue with the reservation details. Do not ask for dates again."
			: "You are now the selected hotel's reception and reservations representative. Introduce yourself by first name from the hotel reception and reservations desk and ask for check-in and checkout dates so you can confirm availability officially.";
	let hotelIntro = await write(io, sc, st, introInstruction, {
		hotelName,
		agentName: nextAgentName,
		selectedOption: optionOrHotel,
		confirmation,
		requestedDates,
	});
	hotelIntro = stabilizeHotelHandoffIntro(hotelIntro, sc, st, optionOrHotel, {
		hotelName,
		agentName: nextAgentName,
	});

	await sendSystemNotice(
		io,
		sc,
		transferSystemNoticeText(sc, st, {
			hotelName,
			agentName: nextAgentName,
			fromAgentName: conciergeAgentName,
		})
	);
	const handoffDelay = randomBetween(
		JANNAT_HANDOFF_DELAY_MIN_MS,
		JANNAT_HANDOFF_DELAY_MAX_MS
	);
	logStep(caseId, "jannat_handoff.delay", {
		ms: handoffDelay,
		hotelName,
		nextAgentName,
	});
	const delayCompleted = await sleepUnlessInterrupted(st, handoffDelay);
	if (!delayCompleted) {
		logStep(caseId, "jannat_handoff.interrupted", { hotelName, nextAgentName });
		return true;
	}

	const introSent = await humanSend(io, sc, st, hotelIntro, {
		quickReplies:
			reason === "new_reservation" && optionOrHotel?.quote?.available
				? proceedQuickReplies(sc, st)
				: [],
	});
	if (!introSent) return true;
	st.waitFor =
		reason === "reservation_update"
			? "reservation_update_clarify"
			: reason === "reservation_cancellation"
			? "reservation_cancellation_reference"
			: reason === "payment_help"
			? "payment_reference"
			: reason === "reservation_support"
			? "reservation_reference"
			: optionOrHotel?.quote?.available
			? "proceed"
			: "dates";
	return true;
}

async function handlePlatformHotelChoice(io, sc, st, userText) {
	const options = Array.isArray(st.platformHotelOptions)
		? st.platformHotelOptions
		: [];
	if (!options.length) {
		if (!st.slots.roomTypeKey) {
			st.slots.roomTypeKey =
				mapRoomToKey(conversationText(sc, { guestsOnly: true })) ||
				mapRoomToKey(userText) ||
				"doubleRooms";
		}
		const rebuilt = await buildJannatBookingHotelOptions({
			text: userText,
			sc,
			st,
			requestedRoomTypeKey: st.slots.roomTypeKey,
		});
		const rebuiltIndex = parsePlatformHotelChoice(
			userText,
			st.platformHotelOptions || []
		);
		if (rebuiltIndex >= 0) {
			return connectJannatCaseToHotelSupport(
				io,
				sc,
				st,
				st.platformHotelOptions[rebuiltIndex],
				{ reason: "new_reservation" }
			);
		}
		const sent = await humanSend(io, sc, st, rebuilt.reply, {
			quickReplies: rebuilt.options.length
				? platformHotelOptionQuickReplies(sc, st)
				: [],
		});
		if (sent) {
			st.waitFor = rebuilt.options.length ? "platform_hotel_choice" : "dates";
		}
		return true;
	}
	const index = parsePlatformHotelChoice(userText, options);
	if (index < 0) {
		const sent = await humanSend(
			io,
			sc,
			st,
			platformHotelOptionsFallbackText(
				sc,
				st,
				options,
				Boolean(st.slots.checkinISO && st.slots.checkoutISO)
			),
			{ quickReplies: platformHotelOptionQuickReplies(sc, st) }
		);
		if (sent) st.waitFor = "platform_hotel_choice";
		return true;
	}
	return connectJannatCaseToHotelSupport(io, sc, st, options[index], {
		reason: "new_reservation",
	});
}

async function redirectJannatReservationToHotelSupport(
	io,
	sc,
	st,
	userText,
	lu = {}
) {
	const confirmation = latestKnownConfirmation(sc, lu);
	if (!confirmation) {
		const reply = await write(
			io,
			sc,
			st,
			"The guest is asking Jannat Booking support about an existing reservation. Jannat Booking must connect them to the reservation hotel's reception and reservations desk before updates, payment links, or reservation actions. Ask for the reservation confirmation number in one reassuring sentence.",
			{ latestUserMessage: userText }
		);
		await humanSend(io, sc, st, reply);
		st.waitFor = "jannat_reservation_reference";
		return true;
	}
	const reservation = await getReservationByConfirmation(confirmation);
	if (!reservation) {
		const reply = await write(
			io,
			sc,
			st,
			"The guest sent a confirmation number but it was not found. Ask them to recheck it and send it again. Keep it short and reassuring.",
			{ confirmation, latestUserMessage: userText }
		);
		await humanSend(io, sc, st, reply);
		st.waitFor = "jannat_reservation_reference";
		return true;
	}
	const hotelId = idText(reservation.hotelId);
	const hotel = hotelId ? await getHotelById(hotelId) : null;
	if (!hotel) {
		await handoffToHuman(io, sc, st, "human_review_needed");
		return true;
	}
	const requestedDates = latestTurnDateRange(userText, lu);
	const cancellationRequested = looksLikeReservationCancellation(userText);
	const reason = cancellationRequested
		? "reservation_cancellation"
		: looksLikeReservationDateUpdate(userText, lu)
		? "reservation_update"
		: wantsPaymentHelp(userText)
		? "payment_help"
		: "reservation_support";
	await connectJannatCaseToHotelSupport(io, sc, st, hotel, {
		reason,
		confirmation,
		requestedDates,
	});
	if (
		looksLikeReservationDateUpdate(userText, lu) &&
		requestedDates.checkinISO &&
		requestedDates.checkoutISO
	) {
		return finishReservationDateUpdate(io, sc, st, {
			confirmation,
			checkinISO: requestedDates.checkinISO,
			checkoutISO: requestedDates.checkoutISO,
		});
	}
	if (cancellationRequested) {
		return handleReservationCancellationRequest(io, sc, st, userText, lu);
	}
	return true;
}

const memo = new Map();
const aiIdleTimers = new Map();

function clearAiIdleFollowups(caseId) {
	const key = String(caseId || "");
	const timer = aiIdleTimers.get(key);
	if (timer) clearTimeout(timer);
	aiIdleTimers.delete(key);
}

function setAiIdleTimer(caseId, callback, delayMs) {
	const key = String(caseId || "");
	clearAiIdleFollowups(key);
	const timer = setTimeout(callback, Math.max(0, Number(delayMs) || 0));
	if (typeof timer.unref === "function") timer.unref();
	aiIdleTimers.set(key, timer);
}

function markGuestActivity(caseId, { activityAt = now(), typingHoldMs = 0 } = {}) {
	const st = memo.get(String(caseId || ""));
	if (!st) return;
	const at = Number(activityAt || now());
	const safeAt = Number.isFinite(at) ? at : now();
	st.lastGuestActivityAt = Math.max(Number(st.lastGuestActivityAt || 0), safeAt);
	if (typingHoldMs > 0) {
		st.guestTypingUntil = Math.max(
			Number(st.guestTypingUntil || 0),
			safeAt + Number(typingHoldMs || 0)
		);
	} else {
		st.guestTypingUntil = Math.min(Number(st.guestTypingUntil || 0), safeAt);
	}
}

function idleQuietRemainingMs(st = {}, anchor = {}, quietMs = 0) {
	const requiredQuietMs = Math.max(0, Number(quietMs) || 0);
	const referenceAt = Math.max(
		Number(anchor.idleSinceAt || 0),
		Number(anchor.at || 0),
		Number(st.lastGuestActivityAt || 0),
		Number(st.guestTypingUntil || 0)
	);
	const deadline = referenceAt + requiredQuietMs;
	return Math.max(0, deadline - now());
}

function guestReplyQuietRemainingMs(
	st = {},
	latestGuestAt = 0,
	quietMs = AI_GUEST_REPLY_QUIET_MS
) {
	const guestAt = Number(latestGuestAt || 0);
	const requiredQuietMs = Math.max(0, Number(quietMs) || 0);
	const activityAt = Math.max(
		Number.isFinite(guestAt) ? guestAt : 0,
		Number(st.lastGuestActivityAt || 0)
	);
	const quietDeadline = activityAt + requiredQuietMs;
	const typingDeadline = Number(st.guestTypingUntil || 0);
	return Math.max(0, quietDeadline - now(), typingDeadline - now());
}

function planningTypingDelayMs(st = {}) {
	const guestAt =
		Number(st.activeTurnGuestAt || 0) > 0 ? Number(st.activeTurnGuestAt) : now();
	return Math.max(0, guestAt + AI_PLANNING_TYPING_DELAY_MS - now());
}

async function getIdleReadyCase(caseId, anchor) {
	const latestCase = await getSupportCaseById(caseId);
	if (!latestCase) return null;
	if (latestCase.caseStatus === "closed" || latestCase.aiToRespond === false) {
		return null;
	}
	if (guestRespondedAfterAnchor(latestCase, anchor)) return null;
	const policy = await ensureAIAllowed(latestCase.hotelId, latestCase);
	if (!policy.allowed) {
		logStep(caseId, "idle.skip", { reason: policy.reason });
		return null;
	}
	return { latestCase, hotel: policy.hotel };
}

async function runAiIdleFollowupStep(io, caseId, anchor) {
	aiIdleTimers.delete(caseId);
	try {
		const ready = await getIdleReadyCase(caseId, anchor);
		if (!ready) return;
		const st = ensureState(
			ready.latestCase,
			activeHotelContextForCase(ready.latestCase, ready.hotel)
		);
		const quietMs = AI_IDLE_FIRST_FOLLOWUP_MS;
		const remainingMs = idleQuietRemainingMs(st, anchor, quietMs);
		if (remainingMs > 0) {
			setAiIdleTimer(
				caseId,
				() => runAiIdleFollowupStep(io, caseId, anchor),
				remainingMs
			);
			logStep(caseId, "idle.defer", {
				remainingMs,
				reason: "guest_activity",
			});
			return;
		}
		const text = idleFollowupText(ready.latestCase, st);
		const sent = await humanSend(io, ready.latestCase, st, text, {
			scheduleIdle: false,
		});
		if (!sent) return;
		const elapsed = now() - Number(anchor.at || now());
		setAiIdleTimer(
			caseId,
			() => runAiIdleCloseStep(io, caseId, anchor),
			Math.max(1000, AI_IDLE_CLOSE_MS - elapsed)
		);
	} catch (error) {
		logStep(caseId, "idle.followup_failed", {
			message: error?.message || error,
		});
	}
}

async function runAiIdleCloseStep(io, caseId, anchor) {
	aiIdleTimers.delete(caseId);
	try {
		const ready = await getIdleReadyCase(caseId, anchor);
		if (!ready) return;
		const st = ensureState(
			ready.latestCase,
			activeHotelContextForCase(ready.latestCase, ready.hotel)
		);
		const remainingMs = idleQuietRemainingMs(st, anchor, AI_IDLE_CLOSE_MS);
		if (remainingMs > 0) {
			setAiIdleTimer(
				caseId,
				() => runAiIdleCloseStep(io, caseId, anchor),
				remainingMs
			);
			logStep(caseId, "idle.close_defer", {
				remainingMs,
				reason: "guest_activity",
			});
			return;
		}
		const closedCase = await closeSupportCaseForAiIdle(caseId, {
			now: new Date(),
		});
		if (!closedCase) return;
		emitAiClosedCase(io, caseId, closedCase, "ai_idle_timeout");
		memo.delete(caseId);
		logStep(caseId, "idle.closed", {});
	} catch (error) {
		logStep(caseId, "idle.close_failed", { message: error?.message || error });
	}
}

function emitAiClosedCase(io, caseId, closedCase, reason) {
	if (!io || !closedCase) return;
	io.to(caseId).emit("supportCaseUpdated", closedCase);
	io.emit("supportCaseUpdated", closedCase);
	io.emit("closeCase", {
		case: closedCase,
		closedBy: "csr",
		reason,
	});
	io.to(caseId).emit("aiPaused", { caseId, reason });
}

async function runPostBookingCloseStep(io, caseId, anchor) {
	aiIdleTimers.delete(caseId);
	try {
		const latestCase = await getSupportCaseById(caseId);
		if (
			!latestCase ||
			latestCase.caseStatus === "closed" ||
			latestCase.aiToRespond === false ||
			guestRespondedAfterAnchor(latestCase, anchor)
		) {
			return;
		}
		const closedCase = await closeSupportCaseForAiIdle(caseId, {
			now: new Date(),
			reason: "post_booking_closed",
		});
		if (!closedCase) return;
		emitAiClosedCase(io, caseId, closedCase, "post_booking_closed");
		memo.delete(caseId);
		logStep(caseId, "post_booking.closed", {});
	} catch (error) {
		logStep(caseId, "post_booking.close_failed", {
			message: error?.message || error,
		});
	}
}

function schedulePostBookingAutoClose(io, sc, st) {
	const caseId = String(sc?._id || sc?.id || "");
	if (!io || !caseId) return;
	const anchor = {
		at: now(),
		idleSinceAt: now(),
		text: st?.lastBotText || "",
	};
	setAiIdleTimer(
		caseId,
		() => runPostBookingCloseStep(io, caseId, anchor),
		AI_POST_BOOKING_CLOSE_MS
	);
	logStep(caseId, "post_booking.close_scheduled", {
		delayMs: AI_POST_BOOKING_CLOSE_MS,
	});
}

function scheduleAiIdleFollowups(io, sc, st, messageData = {}) {
	const caseId = String(sc._id || sc.id || "");
	if (!io || !caseId) return;
	if (
		!shouldScheduleIdleFollowups(
			messageData.message,
			messageData.quickReplies || []
		)
	) {
		clearAiIdleFollowups(caseId);
		return;
	}
	const anchor = {
		clientTag: messageData.clientTag || "",
		text: String(messageData.message || "").trim(),
		at: messageTime(messageData) || now(),
		idleSinceAt: messageTime(messageData) || now(),
	};
	setAiIdleTimer(
		caseId,
		() => runAiIdleFollowupStep(io, caseId, anchor),
		AI_IDLE_FIRST_FOLLOWUP_MS
	);
	logStep(caseId, "idle.scheduled", {
		firstMs: AI_IDLE_FIRST_FOLLOWUP_MS,
		finalMs: null,
		closeMs: AI_IDLE_CLOSE_MS,
	});
}

/* per case state incl. queue & preemption */
function ensureState(sc, hotel) {
	const id = String(sc._id);
	let st = memo.get(id);
	const alreadyGreeted = hasAiAssistantReply(sc);
	if (!st) {
		const agentPool = configuredAgentPool();
		const initialFullName = cleanFullNameCandidate(
			sc.displayName1 || sc.customerName || ""
		);
		st = {
			hotel,
			agentName:
				sc.aiResponderName ||
				agentPool[Math.floor(Math.random() * agentPool.length)],
			language: preferredLanguageOf(sc) || "English",
			languageCode: preferredLanguageCodeOf(sc) || "",
			languageOverrideAt: 0,
			greeted: alreadyGreeted,
			greetScheduled: alreadyGreeted,
			guestTypingUntil: 0,
			lastGuestActivityAt: 0,
			policyAllowedAt: 0,
			policyHotelId: "",
			turnInFlight: false,
			turnOwner: null,
			allowPostBookingReentry: false,
			activeTurnHadReply: false,
			interrupt: false,
			queue: [],
			sendingToken: null,
			waitFor: null, // 'intentConfirm' -> 'dates' -> 'room' -> 'proceed' -> 'reviewConfirm' -> 'fullname' -> 'nationality' -> 'phone' -> 'email_or_skip' -> 'finalize'
			lastBotText: "",
			lastBotTurnUserText: "",
			lastAskAt: {},
			quote: null,
			reviewSent: false,
			quoteSummarizedAt: 0,
			bookingNudgePausedAt: 0,
			progressSentAt: {},
			delayNoticeSentAt: 0,
			delayNoticeTurnKey: "",
			hydratedConversationLength: 0,
			pendingDateChange: null,
			pendingRoomAlternative: null,
			pendingRoomCombination: null,
			repeatedQuestionEscalatedKey: "",
			dateRaw: { calendar: null, checkin: null, checkout: null },
			smalltalkThread: { topic: null, waitingForGuest: false, lastAt: 0 },
			slots: {
				checkinISO: null,
				checkoutISO: null,
				roomTypeKey: null,
				name: firstNameForAddress(
					initialFullName || sc.displayName1 || sc.customerName || "Guest"
				),
				fullName: initialFullName || null,
				nationality: null,
				phone: null,
				email: null,
				emailSkipped: false,
				adults: 2,
				children: 0,
				adultsProvided: false,
				childrenProvided: false,
				rooms: 1,
			},
		};
		memo.set(id, st);
	} else {
		if (alreadyGreeted) {
			st.greeted = true;
			st.greetScheduled = true;
		}
		if (isJannatBookingSupportCase(sc, hotel)) st.hotel = null;
		else if (hotel) st.hotel = hotel;
		if (sc.aiResponderName) st.agentName = sc.aiResponderName;
		if (!st.languageOverrideAt) {
			st.language = preferredLanguageOf(sc) || st.language || "English";
			st.languageCode = preferredLanguageCodeOf(sc) || st.languageCode || "";
		}
	}
	return st;
}

function emitTyping(io, caseId, st, on = true) {
	io.to(caseId).emit(on ? "typing" : "stopTyping", {
		caseId,
		isAi: true,
		name: st.agentName,
	});
}

function sanitizeAssistantVoiceText(text = "", sc = {}, st = {}) {
	let out = String(text || "");
	if (!out) return out;
	const agentName = String(st?.agentName || sc?.aiResponderName || "")
		.trim()
		.toLowerCase();
	const femaleAgentNames = new Set(["hana", "aisha", "sara", "amira", "yasmin", "nadia"]);
	const femaleAgent = !agentName || femaleAgentNames.has(agentName);
	if (femaleAgent) {
		out = out
			.replace(/(?:أنا|انا)\s+موجود\s+معك/g, "أنا موجودة معك")
			.replace(/(?:أنا|انا)\s+موجود(?!ة)/g, "أنا موجودة")
			.replace(/(?:أنا|انا)\s+متابع\s+معك/g, "أنا أتابع معك")
			.replace(/(?:أنا|انا)\s+متابع(?!ة)\s+المحادثة/g, "أنا أتابع المحادثة");
	}
	return out
		.replace(/لمدة\s*[١۱1]\s+ليال[يى]/g, "لمدة ليلة واحدة")
		.replace(/[١۱1]\s+ليال[يى]/g, "ليلة واحدة");
}

/* --------- humanSend with pre‑emption (cancellable) --------- */
async function humanSend(
	io,
	sc,
	st,
	text,
	{
		first = false,
		quickReplies = [],
		scheduleIdle = true,
		fast = false,
		targetReplyMs = null,
	} = {}
) {
	text = sanitizeAssistantVoiceText(text, sc, st);
	if (!text) return false;
	const caseId = String(sc._id || sc.id || "unknown");
	const expectedTurnUserText = st.activeTurnUserText || "";
	const normalizedQuickReplies = sanitizeQuickReplies(quickReplies);

	const token = Math.random().toString(36).slice(2);
	st.sendingToken = token;
	if (st.interrupt) {
		logStep(caseId, "human.cancelled", { stage: "pre-send", token });
		return false;
	}
	if (!currentPlanStillOwnsTurn(caseId, st)) {
		logStep(caseId, "human.cancelled", {
			stage: "replaced-plan-pre-send",
			token,
		});
		return false;
	}

	const turnStartedAt =
		Number(st.activeTurnGuestAt || 0) > 0 ? Number(st.activeTurnGuestAt) : now();
	const requestedTargetMs = Number(targetReplyMs);
	const targetElapsedMs = fast
		? 0
		: Number.isFinite(requestedTargetMs) && requestedTargetMs >= 0
		? requestedTargetMs
		: Number(st.activeTurnReplyTargetMs || 0) > 0
		? Number(st.activeTurnReplyTargetMs)
		: randomBetween(AI_REPLY_TARGET_MIN_MS, AI_REPLY_TARGET_MAX_MS);
	const waitMs = Math.max(0, targetElapsedMs - (now() - turnStartedAt));
	logStep(caseId, "human.delay.target", {
		ms: waitMs,
		targetElapsedMs,
		elapsedMs: now() - turnStartedAt,
		first,
		chars: (text || "").length,
	});
	const waitStartedAt = now();
	const typingVisibleAfter = Math.max(
		waitStartedAt,
		turnStartedAt +
			randomBetween(
				AI_TYPING_INDICATOR_DELAY_MIN_MS,
				AI_TYPING_INDICATOR_DELAY_MAX_MS
			)
	);
	let typingVisible = false;
	let typingVisibleStartedAt = 0;
	const showTyping = () => {
		if (typingVisible) return;
		emitTyping(io, caseId, st, true);
		typingVisible = true;
		typingVisibleStartedAt = now();
	};
	const hideTyping = () => {
		if (!typingVisible) return;
		emitTyping(io, caseId, st, false);
		typingVisible = false;
		typingVisibleStartedAt = 0;
	};
	while (st.guestTypingUntil > now()) await sleep(300);
	while (now() - waitStartedAt < waitMs) {
		if (
			st.interrupt ||
			st.sendingToken !== token ||
			!currentPlanStillOwnsTurn(caseId, st)
		) {
			hideTyping();
			logStep(caseId, "human.cancelled", { stage: "target-wait", token });
			return false;
		}
		while (st.guestTypingUntil > now()) await sleep(300);
		if (!typingVisible && now() >= typingVisibleAfter) {
			showTyping();
		}
		await sleep(120);
	}
	if (!typingVisible && now() >= typingVisibleAfter && AI_TYPING_MIN_VISIBLE_MS > 0) {
		showTyping();
	}
	if (typingVisible && AI_TYPING_MIN_VISIBLE_MS > 0) {
		while (now() - typingVisibleStartedAt < AI_TYPING_MIN_VISIBLE_MS) {
			if (
				st.interrupt ||
				st.sendingToken !== token ||
				!currentPlanStillOwnsTurn(caseId, st)
			) {
				hideTyping();
				logStep(caseId, "human.cancelled", {
					stage: "min-typing-visible",
					token,
				});
				return false;
			}
			if (st.guestTypingUntil > now()) {
				hideTyping();
				while (st.guestTypingUntil > now()) await sleep(120);
				if (
					st.interrupt ||
					st.sendingToken !== token ||
					!currentPlanStillOwnsTurn(caseId, st)
				) {
					logStep(caseId, "human.cancelled", {
						stage: "min-typing-visible-after-guest",
						token,
					});
					return false;
				}
				showTyping();
			}
			await sleep(60);
		}
	}
	hideTyping();
	if (
		st.interrupt ||
		st.sendingToken !== token ||
		!currentPlanStillOwnsTurn(caseId, st)
	) {
		logStep(caseId, "human.cancelled", { stage: "post-type", token });
		return false;
	}

	if (
		st.lastBotText &&
		st.lastBotText.trim() === String(text).trim() &&
		(!expectedTurnUserText || st.lastBotTurnUserText === expectedTurnUserText)
	) {
		logStep(caseId, "dedupe.skip", { reason: "same_as_last" });
		return false;
	}

	let sendGateCase = null;
	const fastAtomicAppend = Boolean(fast && expectedTurnUserText);
	if (fastAtomicAppend) {
		if (!currentPlanStillOwnsTurn(caseId, st)) {
			logStep(caseId, "human.cancelled", {
				stage: "replaced-plan-before-fast-save",
				token,
			});
			return false;
		}
		sendGateCase = sc;
		text = applyGuestAddressCadence(text, sc, st, { first });
		if (
			st.lastBotText &&
			st.lastBotText.trim() === String(text).trim() &&
			(!expectedTurnUserText || st.lastBotTurnUserText === expectedTurnUserText)
		) {
			logStep(caseId, "dedupe.skip", { reason: "same_as_last_after_name_polish" });
			return false;
		}
	} else {
		try {
			if (!currentPlanStillOwnsTurn(caseId, st)) {
				logStep(caseId, "human.cancelled", {
					stage: "replaced-plan-before-policy",
					token,
				});
				return false;
			}
			const latestCase = await getSupportCaseById(caseId);
			sendGateCase = latestCase;
			const policy =
				fast && latestCase
					? {
							allowed:
								latestCase.openedBy === "client" &&
								latestCase.caseStatus === "open" &&
								latestCase.aiToRespond === true,
							reason: "fast send case gate",
					  }
					: latestCase
					? await ensureAIAllowed(latestCase.hotelId, latestCase)
					: { allowed: false, reason: "support case missing" };
			if (!policy.allowed) {
				logStep(caseId, "human.cancelled", {
					stage: "policy-before-save",
					reason: policy.reason,
				});
				return false;
			}
			const latestCustomerText = latestCase ? lastUserText(latestCase) : "";
			if (first && !expectedTurnUserText && latestCustomerText) {
				logStep(caseId, "human.cancelled", {
					stage: "stale-greeting",
					token,
					latestCustomerText,
				});
				return false;
			}
			if (
				expectedTurnUserText &&
				latestCustomerText &&
				latestCustomerText !== expectedTurnUserText
			) {
				logStep(caseId, "human.cancelled", {
					stage: "stale-turn",
					token,
					expectedTurnUserText,
					latestCustomerText,
				});
				return false;
			}
			if (
				expectedTurnUserText &&
				!st.activeTurnHadReply &&
				hasAiAssistantReplyAfterLatestGuest(latestCase)
			) {
				logStep(caseId, "human.cancelled", {
					stage: "latest-guest-already-answered",
					token,
					expectedTurnUserText,
				});
				st.activeTurnHadReply = true;
				return false;
			}
			if (!currentPlanStillOwnsTurn(caseId, st)) {
				logStep(caseId, "human.cancelled", {
					stage: "replaced-plan-after-policy",
					token,
				});
				return false;
			}
			text = applyGuestAddressCadence(text, latestCase, st, { first });
			if (
				st.lastBotText &&
				st.lastBotText.trim() === String(text).trim() &&
				(!expectedTurnUserText || st.lastBotTurnUserText === expectedTurnUserText)
			) {
				logStep(caseId, "dedupe.skip", { reason: "same_as_last_after_name_polish" });
				return false;
			}
		} catch (error) {
			logStep(caseId, "human.cancelled", {
				stage: "policy-check-failed",
				message: error?.message || error,
			});
			return false;
		}
	}

	const messageData = {
		messageBy: {
			customerName: st.agentName,
			customerEmail: AI_SUPPORT_EMAIL,
			userId: "jannat-ai-support",
		},
		message: text,
		date: new Date(),
		isAi: true,
		clientTag: aiMessageClientTag(caseId, "ai"),
	};
	if (normalizedQuickReplies.length) {
		messageData.quickReplies = normalizedQuickReplies;
	}
	if (!currentPlanStillOwnsTurn(caseId, st)) {
		logStep(caseId, "human.cancelled", {
			stage: "replaced-plan-before-save",
			token,
		});
		return false;
	}
	const saved = await updateSupportCaseAppendIfNoRecentAiDuplicate(
		caseId,
		{
			conversation: messageData,
			aiRelated: true,
		},
		{
			duplicateWindowMs: AI_MESSAGE_DEDUPE_WINDOW_MS,
			duplicateAfter: expectedTurnUserText ? turnStartedAt : null,
			requireOpenClientAi: fastAtomicAppend,
			requireLatestGuestText: fastAtomicAppend ? expectedTurnUserText : "",
			requireNoAiAfter: fastAtomicAppend ? turnStartedAt : null,
			skipDuplicateCheck: fastAtomicAppend,
		}
	);
	if (saved?.skipped) {
		logStep(caseId, "dedupe.skip", { reason: "recent_duplicate" });
		const duplicateCase = saved.updatedCase || sendGateCase;
		if (
			expectedTurnUserText &&
			duplicateCase &&
			hasAiAssistantReplyAfterLatestGuest(duplicateCase)
		) {
			st.lastBotText = text;
			st.lastBotTurnUserText = expectedTurnUserText;
			st.activeTurnHadReply = true;
		}
		return false;
	}
	io.to(caseId).emit("receiveMessage", { ...messageData, caseId });

	st.lastBotText = text;
	st.lastBotTurnUserText = expectedTurnUserText || "";
	st.activeTurnHadReply = true;
	clearUnansweredTurnRecovery(caseId);
	if (scheduleIdle) scheduleAiIdleFollowups(io, sc, st, messageData);
	return true;
}

async function sendSystemNotice(io, sc, text) {
	if (!text) return false;
	const caseId = String(sc._id || sc.id || "unknown");
	const messageData = {
		messageBy: {
			customerName: "System",
			customerEmail: AI_SUPPORT_EMAIL,
			userId: "jannat-system",
		},
		message: text,
		date: new Date(),
		isSystem: true,
		clientTag: aiMessageClientTag(caseId, "system"),
	};
	const saved = await updateSupportCaseAppendIfNoRecentAiDuplicate(
		caseId,
		{
			conversation: messageData,
			aiRelated: true,
		},
		{ duplicateWindowMs: AI_MESSAGE_DEDUPE_WINDOW_MS }
	);
	if (saved?.skipped) return false;
	io.to(caseId).emit("receiveMessage", { ...messageData, caseId });
	return true;
}

/* soft‑pivot memory */
function progressText(sc = {}, st = {}, purpose = "checking") {
	const lang = languageOf(sc, st);
	if (/arabic/i.test(lang)) {
		return purpose === "finalizing"
			? "\u062a\u0645\u0627\u0645\u060c \u0623\u0646\u0627 \u0628\u0646\u0634\u0626 \u0627\u0644\u062d\u062c\u0632 \u0627\u0644\u0622\u0646. \u0644\u062d\u0638\u0629 \u0648\u0627\u062d\u062f\u0629 \u0645\u0646 \u0641\u0636\u0644\u0643."
			: "\u062a\u0645\u0627\u0645\u060c \u0623\u0646\u0627 \u0628\u0631\u0627\u062c\u0639 \u0627\u0644\u062a\u0648\u0641\u0631 \u0648\u0627\u0644\u0633\u0639\u0631 \u0627\u0644\u0622\u0646. \u0644\u062d\u0638\u0629 \u0648\u0627\u062d\u062f\u0629 \u0645\u0646 \u0641\u0636\u0644\u0643.";
	}
	if (/spanish/i.test(lang)) {
		return purpose === "finalizing"
			? "Perfecto, estoy creando la reserva ahora. Un momento, por favor."
			: "Perfecto, estoy revisando disponibilidad y precio ahora. Un momento, por favor.";
	}
	if (/french/i.test(lang)) {
		return purpose === "finalizing"
			? "Parfait, je cree la reservation maintenant. Un instant, s'il vous plait."
			: "Parfait, je verifie la disponibilite et le prix maintenant. Un instant, s'il vous plait.";
	}
	return purpose === "finalizing"
		? "Perfect, I am creating the reservation now. One moment please."
		: "Perfect, I am checking availability and price now. One moment please.";
}

async function sendProgressMessage(
	io,
	sc,
	st,
	purpose = "checking",
	{ fast = false, targetReplyMs = null } = {}
) {
	if (!AI_INSTANT_PROGRESS_ENABLED || !io || !st) return;
	const caseId = String(sc._id || sc.id || "unknown");
	const key = `${purpose}|${st.slots?.roomTypeKey || ""}|${
		st.slots?.checkinISO || ""
	}|${st.slots?.checkoutISO || ""}`;
	if (st.progressSentAt?.[key] && now() - st.progressSentAt[key] < 30000) {
		return;
	}
	st.progressSentAt = st.progressSentAt || {};
	st.progressSentAt[key] = now();
	const text = progressText(sc, st, purpose);
	await humanSend(io, sc, st, text, {
		fast,
		targetReplyMs,
		scheduleIdle: false,
	});
}

function askedRecently(st, key, ms = SOFT_PIVOT_MS) {
	const t = now();
	const last = st.lastAskAt[key] || 0;
	if (t - last < ms) return true;
	st.lastAskAt[key] = t;
	return false;
}
function stampAsk(st, key) {
	st.lastAskAt[key] = now();
}

function pauseBookingNudge(st = {}) {
	st.bookingNudgePausedAt = now();
}

function resumeBookingNudge(st = {}) {
	st.bookingNudgePausedAt = 0;
}

function bookingNudgePaused(st = {}) {
	const pausedAt = Number(st.bookingNudgePausedAt || 0);
	return Boolean(pausedAt && now() - pausedAt < QUOTE_NUDGE_PAUSE_MS);
}

function normalizeControlText(text = "") {
	const raw = digitsToEnglish(String(text || "")).trim();
	const lower = raw.toLowerCase();
	const arabic = lower
		.replace(/[\u064b-\u065f\u0670]/g, "")
		.replace(/[\u0622\u0623\u0625\u0671]/g, "\u0627")
		.replace(/\u0649/g, "\u064a")
		.replace(/\u0629/g, "\u0647")
		.replace(/\s+/g, " ")
		.trim();
	const latinCompact = lower
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9]+/g, "");
	return { raw, lower, arabic, latinCompact };
}

function correctionText(text = "") {
	const { lower, arabic, latinCompact } = normalizeControlText(text);
	return (
		/\b(something\s+is\s+wrong|wrong|incorrect|not\s+correct|mistake|change|edit|modify|fix|correction|correct\s+it)\b/i.test(
			lower
		) ||
		/(?:\u063a\u0644\u0637|\u062e\u0637\u0627|\u062e\u0637\u0623|\u0645\u0634\s+\u0635\u062d|\u0645\u0634\s+\u0635\u062d\u064a\u062d|\u063a\u064a\u0631\s+\u0635\u062d\u064a\u062d|\u062a\u0639\u062f\u064a\u0644|\u0639\u062f\u0644|\u0627\u0635\u0644\u062d|\u0635\u062d\u062d)/i.test(
			arabic
		) ||
		/(?:somethingwrong|wrong|incorrect|notcorrect|mistake|change|edit|modify|fix|correction)/i.test(
			latinCompact
		)
	);
}

function looksLikeStayDateCandidate(value = "") {
	const raw = digitsToEnglish(String(value || "")).replace(/\s+/g, " ").trim();
	if (!raw) return false;
	const dates = quickDateRange(raw);
	if (dates?.checkinISO && dates?.checkoutISO) return true;
	const { lower, arabic, latinCompact } = normalizeControlText(raw);
	if (!/\d/.test(raw)) return false;
	return (
		/\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|ramadan|hijri|gregorian|check\s*-?\s*in|check\s*-?\s*out)\b/i.test(
			lower
		) ||
		/(?:\u0631\u0645\u0636\u0627\u0646|\u0645\u062d\u0631\u0645|\u0635\u0641\u0631|\u0631\u0628\u064a\u0639|\u062c\u0645\u0627\u062f\u0649|\u0631\u062c\u0628|\u0634\u0639\u0628\u0627\u0646|\u0634\u0648\u0627\u0644|\u0630\u0648\s+\u0627\u0644\u0642\u0639\u062f\u0629|\u0630\u0648\s+\u0627\u0644\u062d\u062c\u0629|\u064a\u0648\u0646\u064a\u0648|\u064a\u0648\u0644\u064a\u0648|\u062a\u0627\u0631\u064a\u062e|\u0648\u0635\u0648\u0644|\u062f\u062e\u0648\u0644|\u062e\u0631\u0648\u062c)/i.test(
			arabic
		) ||
		/(?:ramadan|hijri|checkin|checkout|arrival|departure)/i.test(latinCompact)
	);
}

function rejectsFullNameCandidate(value = "") {
	const { lower, arabic, latinCompact } = normalizeControlText(value);
	if (looksLikeStayDateCandidate(value)) return true;
	if (!lower) return true;
	if (emailSkipText(value)) return true;
	if (/[?؟]/.test(lower)) return true;
	if (
		/\b(?:something|wrong|incorrect|problem|issue|mistake|error|fix|change|edit|modify|cancel|phone|mobile|whatsapp|hotel|reception|manager|support|reservation|booking|confirmation|confirm|price|rate|date|room|nationality|country|email|adult|child|children|guest|person|people|pax|skip|yes|no|thanks?|thank\s+you|please|pls|could|would|can|send|give|show|details|number|hurry|quick|quickly|faster|speed|urgent)\b/i.test(
			lower
		)
	) {
		return true;
	}
	if (
		/\b(?:i\s+(?:already\s+)?(?:said|told|mentioned)|i\s+told\s+you|already\s+(?:said|told|mentioned)|me\s+and\s+my\s+(?:friend|wife|husband|brother|sister)|my\s+(?:friend|wife|husband|brother|sister)|we\s+are|we're)\b/i.test(
			lower
		)
	) {
		return true;
	}
	if (
		/(?:\u063a\u0644\u0637|\u062e\u0637\u0627|\u062e\u0637\u0623|\u0645\u0634\u0643\u0644|\u0645\u0634\u0643\u0644\u0647|\u062a\u0639\u062f\u064a\u0644|\u062a\u063a\u064a\u064a\u0631|\u0627\u0644\u0641\u0646\u062f\u0642|\u0641\u0646\u062f\u0642|\u0627\u0644\u0627\u0633\u062a\u0642\u0628\u0627\u0644|\u0627\u0633\u062a\u0642\u0628\u0627\u0644|\u062c\u0648\u0627\u0644|\u0647\u0627\u062a\u0641|\u0648\u0627\u062a\u0633|\u062d\u062c\u0632|\u0633\u0639\u0631|\u062a\u0627\u0631\u064a\u062e|\u063a\u0631\u0641|\u062c\u0646\u0633\u064a|\u0627\u064a\u0645\u064a\u0644|\u0645\u0645\u0643\u0646|\u0644\u0648\s+\u0633\u0645\u062d\u062a|\u0637\u0628|\u0628\u0633\u0631\u0639\u0647|\u0628\u0633\u0631\u0639\u0629|\u0633\u0631\u0639\u0647|\u0633\u0631\u0639\u0629|\u0627\u0644\u0633\u0631\u0639\u0647|\u0627\u0644\u0633\u0631\u0639\u0629|\u0645\u0633\u062a\u0639\u062c\u0644|\u0645\u0633\u062a\u0639\u062c\u0644\u0647|\u0627\u062f\u064a\u0646\u064a|\u0627\u062f\u064a\u0646\u0649|\u0647\u0627\u062a|\u0627\u0631\u0633\u0644|\u062a\u0641\u0627\u0635\u064a\u0644|\u0631\u0642\u0645)/i.test(
			arabic
		)
	) {
		return true;
	}
	if (
		/(?:\u0642\u0644\u062a\u0644\u0643|\u0642\u0648\u0644\u062a\u0644\u0643|\u0642\u0644\u062a\s+\u0644\u0643|\u0642\u0648\u0644\u062a\s+\u0644\u0643|\u0627\u0646\u0627\s+\u0648|\u0623\u0646\u0627\s+\u0648|\u0627\u0646\u0627\s+\u0648|\u0635\u062f\u064a\u0642\u064a|\u0635\u062f\u064a\u0642\u0649|\u0635\u0627\u062d\u0628\u064a|\u0635\u0627\u062d\u0628\u0649|\u0632\u0648\u062c\u062a\u064a|\u0632\u0648\u062c\u062a\u0649|\u0632\u0648\u062c\u064a|\u0632\u0648\u062c\u0649|\u064a\u0639\u0646\u064a|\u064a\u0639\u0646\u0649|\u0641\u0631\u062f\u064a\u0646|\u0634\u062e\u0635\u064a\u0646|\u0627\u062d\u0646\u0627|\u0646\u062d\u0646|\u0639\u062f\u062f\u0646\u0627)/i.test(
			arabic
		)
	) {
		return true;
	}
	return /(?:somethingwrong|notcorrect|wrong|incorrect|problem|issue|mistake|phone|whatsapp|hotelphone|callhotel|manager|reservation|booking|confirmation|room|date|email|nationality|please|send|give|show|details|number|hurry|quick|quickly|faster|speed|urgent|momken|mumkin|momkin|sora|sor3a|bsor3a|bser3a)/i.test(
		latinCompact
	);
}

function hasUsableFullName(value = "") {
	const name = String(value || "").replace(/\s+/g, " ").trim();
	if (!name || name.length < 4 || name.length > 90) return false;
	if (latestEmailFromText(name) || cleanPhoneCandidate(name)) return false;
	if (rejectsFullNameCandidate(name)) return false;
	if (nameCandidateLooksLikeNationality(name)) return false;
	if (
		/\b(?:guest|unknown|na|n\/a|none|null|dont\s+know|don't\s+know|not\s+sure)\b/i.test(
			name
		) ||
		/(?:\u0644\u0627\s+\u0627\u0639\u0631\u0641|\u0644\u0627\s+\u0623\u0639\u0631\u0641|\u0645\u0634\s+\u0639\u0627\u0631\u0641|\u0645\u0634\s+\u0639\u0627\u0631\u0641\u0647|\u0627\u0643\u062a\u0628\u0647\s+\u0628\u0627\u0644\u0627\u0646\u062c\u0644\u064a\u0632)/i.test(
			name
		)
	) {
		return false;
	}
	if (/^(?:test|testing)$/i.test(name)) return false;
	if (
		/confirm|confirmation|book|reserve|price|date|room|\u062d\u062c\u0632|\u062a\u0627\u0631\u064a\u062e|\u063a\u0631\u0641/i.test(
			name
		)
	) {
		return false;
	}
	const nameTokens = name
		.split(/\s+/)
		.filter((token) => /[A-Za-z\u0590-\u08FF\u0900-\u097F]{2,}/.test(token));
	const letterCount = (name.match(/[A-Za-z\u0590-\u08FF\u0900-\u097F]/g) || [])
		.length;
	return nameTokens.length >= 2 || letterCount >= 8;
}

function cleanFullNameCandidate(value = "") {
	const cleaned = digitsToEnglish(String(value || ""))
		.replace(/[<>]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return hasUsableFullName(cleaned) ? cleaned : "";
}

function nameTokenCount(value = "") {
	return String(value || "")
		.replace(/\s+/g, " ")
		.trim()
		.split(/\s+/)
		.filter((token) => /[A-Za-z\u0590-\u08FF\u0900-\u097F]{2,}/.test(token))
		.length;
}

function nameCandidateLooksLikeNationality(value = "") {
	const raw = String(value || "").replace(/\s+/g, " ").trim();
	if (!raw) return false;
	if (nationalityHintFromText(raw)) return true;
	const normalized = compactArabicName(raw);
	return [
		"\u0628\u0648\u0631\u0643\u064a\u0646\u0627\u0641\u0627\u0633\u0648",
		"\u0627\u0631\u062f\u0646\u064a",
		"\u0627\u0631\u062f\u0646\u0649",
		"\u0623\u0631\u062f\u0646\u064a",
		"\u0623\u0631\u062f\u0646\u0649",
	].includes(normalized);
}

function directNationalityAlias(value = "") {
	const compact = asciiize(value)
		.toLowerCase()
		.replace(/[.\s_-]+/g, "");
	const aliases = {
		us: "American",
		usa: "American",
		unitedstates: "American",
		unitedstatesofamerica: "American",
		uk: "British",
		gb: "British",
		greatbritain: "British",
		unitedkingdom: "British",
		uae: "Emirati",
		unitedarabemirates: "Emirati",
		ksa: "Saudi",
		saudiarabia: "Saudi",
	};
	return aliases[compact] || "";
}

function rejectsNationalityCandidate(value = "") {
	const raw = String(value || "").replace(/\s+/g, " ").trim();
	if (!raw || raw.length > 60) return true;
	if (latestEmailFromText(raw) || cleanPhoneCandidate(raw)) return true;
	if (looksLikeStayDateCandidate(raw)) return true;
	if (correctionText(raw) || guestHurryOrChaseText(raw) || reservationDetailChaseText(raw)) {
		return true;
	}
	const { lower, arabic, latinCompact } = normalizeControlText(raw);
	if (/[?؟]/.test(raw)) return true;
	if (
		/\b(?:already|earlier|before|again|told|said|mentioned|asked|you|your|sara|agent|bot|robot|wrong|fix|check|above|chat|message|question|answer)\b/i.test(
			lower
		)
	) {
		return true;
	}
	if (
		/(?:alreadytold|toldyou|saidbefore|saidit|mentionedit|checkabove|askagain|youasked|sara|agent|bot|robot|wrong|fix|message|chat)/i.test(
			latinCompact
		)
	) {
		return true;
	}
	if (
		/(?:قلتلك|قولتلك|قلت\s+لك|قولت\s+لك|ذكرت|قلت\s+قبل|سالت|سألت|تاني|مرة\s+ثانية|فوق|غلط|صحح|شات|رسالة|البوت|سارة)/i.test(
			arabic
		)
	) {
		return true;
	}
	return false;
}

function hasUsableNationality(value = "") {
	const raw = String(value || "").replace(/\s+/g, " ").trim();
	if (!raw || rejectsNationalityCandidate(raw)) return false;
	if (directNationalityAlias(raw) || nationalityHintFromText(raw)) return true;
	return /^[A-Za-z][A-Za-z\s-]{2,40}$/.test(asciiize(raw));
}

function shouldReplaceCapturedGuestName(st = {}, candidate = "", { explicit = false } = {}) {
	if (!candidate || !st?.slots) return false;
	if (nameCandidateLooksLikeNationality(candidate)) return false;
	const current = st.slots.fullName || st.slots.name || "";
	if (!hasUsableFullName(current)) return true;
	if (st.waitFor === "fullname" || explicit) return true;
	return nameTokenCount(candidate) > nameTokenCount(current);
}

function stripFieldTail(value = "") {
	return String(value || "")
		.replace(
			/(?:\b(?:phone|mobile|whatsapp|nationality|country|adults?|children|kids?|people|persons?|guests?|pax|email|telefono|tel[eé]fono|nacionalidad|pais|pa[ií]s|adultos?|ninos?|niños?|personas?|huespedes|huéspedes|correo)\b|(?:\u0627\u0644\u062c\u0646\u0633\u064a\u0629|\u062c\u0646\u0633\u064a\u062a\u064a|\u0627\u0644\u0647\u0627\u062a\u0641|\u0627\u0644\u062c\u0648\u0627\u0644|\u0627\u0644\u0628\u0631\u064a\u062f|\u0627\u064a\u0645\u064a\u0644|\u0628\u0627\u0644\u063a|\u0627\u0637\u0641\u0627\u0644|\u0623\u0637\u0641\u0627\u0644|\u0627\u0634\u062e\u0627\u0635|\u0623\u0634\u062e\u0627\u0635|\u0627\u0641\u0631\u0627\u062f|\u0623\u0641\u0631\u0627\u062f|\u0636\u064a\u0648\u0641)).*$/i,
			""
		)
		.replace(/\s+\d{1,2}\s*$/i, "")
		.replace(/^[\s:：,\-–—|]+|[\s:：,\-–—|]+$/g, "")
		.trim();
}

function explicitNameCandidateFromText(text = "") {
	const value = String(text || "");
	const patterns = [
		/(?:^|[\s,;|])(?:full\s*name|guest\s*name|passport\s*name|name)\s*[:：-]?\s*([^\n,;|]+)/i,
		/(?:^|[\s,;|])(?:nombre\s+completo|nombre\s+del\s+huesped|nombre\s+del\s+hu[eé]sped|nombre\s+en\s+pasaporte|nombre)\s*[:：-]?\s*([^\n,;|]+)/i,
		/(?:^|[\s,;،|])(?:\u0648?\u0627\u0633\u0645\u064a|\u0648?\u0627\u0633\u0645\u0649|\u0627\u0644\u0627\u0633\u0645(?:\s+\u0627\u0644\u0643\u0627\u0645\u0644)?|\u0627\u0633\u0645)\s*[:：-]?\s+([^\n,;،|]+)/i,
	];
	for (const pattern of patterns) {
		const match = value.match(pattern);
		const candidate = match
			? cleanFullNameCandidate(stripFieldTail(match[1]).replace(/^(?:is|es)\s+/i, ""))
			: "";
		if (candidate) return candidate;
	}
	return "";
}

function lineNameCandidateFromText(text = "") {
	const lines = String(text || "")
		.split(/[\n\r;|]+/)
		.map((line) => stripFieldTail(line))
		.filter(Boolean);
	for (const line of lines) {
		if (
			/\b(?:phone|mobile|nationality|country|adult|children|child|people|person|guest|pax|email|telefono|tel[eé]fono|nacionalidad|pais|pa[ií]s|adultos?|ninos?|niños?|personas?|huespedes|huéspedes|correo)\b|(?:\u0627\u0644\u062c\u0646\u0633\u064a\u0629|\u062c\u0646\u0633\u064a|\u062c\u0648\u0627\u0644|\u0647\u0627\u062a\u0641|\u0628\u0631\u064a\u062f|\u0627\u064a\u0645\u064a\u0644|\u0628\u0627\u0644\u063a|\u0627\u0637\u0641\u0627\u0644|\u0623\u0637\u0641\u0627\u0644|\u0627\u0634\u062e\u0627\u0635|\u0623\u0634\u062e\u0627\u0635|\u0627\u0641\u0631\u0627\u062f|\u0623\u0641\u0631\u0627\u062f|\u0636\u064a\u0648\u0641)/i.test(
				line
			)
		) {
			continue;
		}
		const candidate = cleanFullNameCandidate(line);
		if (candidate) return candidate;
	}
	return "";
}

const NATIONALITY_HINTS = [
	[/\b(?:american|usa|u\.s\.a\.|united\s+states|united\s+states\s+of\s+america)\b/i, "American"],
	[/\b(?:french|france)\b|\u0641\u0631\u0646\u0633\u064a|\u0641\u0631\u0646\u0633\u0649|\u0641\u0631\u0646\u0633\u064a\u0629|\u0641\u0631\u0646\u0633\u0627/i, "French"],
	[/\b(?:egyptian|egypt)\b|\u0645\u0635\u0631\u064a|\u0645\u0635\u0631\u064a\u0629|\u0645\u0635\u0631/i, "Egyptian"],
	[/\b(?:saudi|saudi\s+arabian)\b|\u0633\u0639\u0648\u062f\u064a|\u0633\u0639\u0648\u062f\u064a\u0629/i, "Saudi"],
	[/\b(?:pakistani|pakistan)\b|\u0628\u0627\u0643\u0633\u062a\u0627\u0646\u064a|\u0628\u0627\u0643\u0633\u062a\u0627\u0646\u064a\u0629/i, "Pakistani"],
	[/\b(?:indian|india)\b|\u0647\u0646\u062f\u064a|\u0647\u0646\u062f\u064a\u0629/i, "Indian"],
	[/\b(?:bangladeshi|bangladesh)\b|\u0628\u0646\u063a\u0644\u0627\u062f\u0634/i, "Bangladeshi"],
	[/\b(?:indonesian|indonesia)\b|\u0627\u0646\u062f\u0648\u0646\u064a\u0633\u064a|\u0627\u0646\u062f\u0648\u0646\u064a\u0633\u064a\u0629/i, "Indonesian"],
	[/\b(?:malaysian|malaysia)\b|\u0645\u0627\u0644\u064a\u0632\u064a|\u0645\u0627\u0644\u064a\u0632\u064a\u0629/i, "Malaysian"],
	[/\b(?:moroccan|morocco)\b|\u0645\u063a\u0631\u0628\u064a|\u0645\u063a\u0631\u0628\u064a\u0629/i, "Moroccan"],
	[/\b(?:algerian|algeria)\b|\u062c\u0632\u0627\u0626\u0631\u064a|\u062c\u0632\u0627\u0626\u0631\u064a\u0629/i, "Algerian"],
	[/\b(?:tunisian|tunisia)\b|\u062a\u0648\u0646\u0633\u064a|\u062a\u0648\u0646\u0633\u064a\u0629/i, "Tunisian"],
	[/\b(?:sudanese|sudan)\b|\u0633\u0648\u062f\u0627\u0646\u064a|\u0633\u0648\u062f\u0627\u0646\u064a\u0629/i, "Sudanese"],
	[/\b(?:iraqi|iraq)\b|\u0639\u0631\u0627\u0642\u064a|\u0639\u0631\u0627\u0642\u064a\u0629/i, "Iraqi"],
	[/\b(?:syrian|syria)\b|\u0633\u0648\u0631\u064a|\u0633\u0648\u0631\u064a\u0629/i, "Syrian"],
	[/\b(?:jordanian|jordan)\b|\u0627\u0631\u062f\u0646\u064a|\u0623\u0631\u062f\u0646\u064a|\u0627\u0631\u062f\u0646\u064a\u0629|\u0623\u0631\u062f\u0646\u064a\u0629/i, "Jordanian"],
	[/\b(?:burkinabe|burkina\s+faso)\b|\u0628\u0648\u0631\u0643\u064a\u0646\u0627\s*\u0641\u0627\u0633\u0648/i, "Burkinabe"],
	[/\b(?:palestinian|palestine)\b|\u0641\u0644\u0633\u0637\u064a\u0646\u064a|\u0641\u0644\u0633\u0637\u064a\u0646\u064a\u0629/i, "Palestinian"],
	[/\b(?:emirati|uae|united\s+arab\s+emirates)\b|\u0627\u0645\u0627\u0631\u0627\u062a\u064a|\u0625\u0645\u0627\u0631\u0627\u062a\u064a/i, "Emirati"],
	[/\b(?:kuwaiti|kuwait)\b|\u0643\u0648\u064a\u062a\u064a|\u0643\u0648\u064a\u062a\u064a\u0629/i, "Kuwaiti"],
	[/\b(?:qatari|qatar)\b|\u0642\u0637\u0631\u064a|\u0642\u0637\u0631\u064a\u0629/i, "Qatari"],
	[/\b(?:bahraini|bahrain)\b|\u0628\u062d\u0631\u064a\u0646\u064a|\u0628\u062d\u0631\u064a\u0646\u064a\u0629/i, "Bahraini"],
	[/\b(?:omani|oman)\b|\u0639\u0645\u0627\u0646\u064a|\u0639\u0645\u0627\u0646\u064a\u0629/i, "Omani"],
	[/\b(?:yemeni|yemen)\b|\u064a\u0645\u0646\u064a|\u064a\u0645\u0646\u064a\u0629/i, "Yemeni"],
	[/\b(?:turkish|turkey)\b|\u062a\u0631\u0643\u064a|\u062a\u0631\u0643\u064a\u0629/i, "Turkish"],
	[/\b(?:nigerian|nigeria)\b|\u0646\u064a\u062c\u064a\u0631\u064a|\u0646\u064a\u062c\u064a\u0631\u064a\u0629/i, "Nigerian"],
];

function nationalityHintFromText(text = "") {
	const value = String(text || "");
	const direct = directNationalityAlias(value);
	if (direct) return direct;
	const found = NATIONALITY_HINTS.find(([pattern]) => pattern.test(value));
	return found ? found[1] : "";
}

function explicitNationalityText(text = "") {
	const value = String(text || "");
	const patterns = [
		/(?:^|[\s,;|])(?:nationality|country)\s*[:：-]?\s*([^\n,;|]+)/i,
		/(?:^|[\s,;|])(?:nacionalidad|pais|pa[ií]s)\s*[:：-]?\s*([^\n,;|]+)/i,
		/(?:^|[\s,;،|])(?:\u0627\u0644\u062c\u0646\u0633\u064a\u0629|\u062c\u0646\u0633\u064a\u062a\u064a|\u062c\u0646\u0633\u064a\u062a\u0649|\u0628\u0644\u062f\u064a)\s*[:：-]?\s*([^\n,;،|]+)/i,
	];
	for (const pattern of patterns) {
		const match = value.match(pattern);
		if (match?.[1]) return stripFieldTail(match[1]);
	}
	return "";
}

function nationalityCandidateFromText(text = "") {
	const explicit = explicitNationalityText(text);
	if (explicit) return explicit;
	const lines = String(text || "")
		.split(/[\n\r;|]+/)
		.map((line) => stripFieldTail(line).replace(/^[\s:：,\-–—]+|[\s:：,\-–—]+$/g, ""))
		.map((line) => line.trim())
		.filter(Boolean);
	for (const line of lines) {
		if (line.length > 60) continue;
		if (latestEmailFromText(line) || cleanPhoneCandidate(line)) continue;
		if (looksLikeStayDateCandidate(line)) continue;
		if (likelyGuestCountText(line)) continue;
		if (nationalityHintFromText(line) || directNationalityAlias(line)) return line;
	}
	return "";
}

function latestNationalityHintFromText(text = "") {
	const raw = String(text || "").replace(/\s+/g, " ").trim();
	if (!raw) return "";
	const explicit = explicitNationalityText(raw);
	if (explicit) return nationalityHintFromText(explicit) || directNationalityAlias(explicit);
	const parts = raw
		.split(/[\n\r;|.?!؟،]+/)
		.flatMap((part) =>
			String(part || "").split(
				/\b(?:but|rather|instead)\b|(?:\u0644\u0643\u0646|\u0648\u0644\u0643\u0646|\u0628\u0633|\u0628\u0644)/i
			)
		)
		.map((part) => part.trim())
		.filter(Boolean);
	for (let index = parts.length - 1; index >= 0; index -= 1) {
		const part = parts[index];
		const { lower, arabic } = normalizeControlText(part);
		const dialectOnly =
			/(?:dialect|accent)/i.test(lower) ||
			/(?:\u0644\u0647\u062c\u0647|\u0644\u0647\u062c\u0629)/i.test(arabic);
		const nationalityChallenge =
			/\b(?:who\s+(?:said|told)\s+(?:you\s+)?(?:i\s+am|i'm|im)|why\s+did\s+you\s+say\s+i\s+am)\b/i.test(
				lower
			) ||
			/(?:\u0645\u064a\u0646|\u0645\u0646).{0,12}(?:\u0642\u0627\u0644\u0643|\u0642\u0627\u0644\s+\u0644\u0643)|(?:\u0644\u064a\u0647|\u0644\u0645\u0627\u0630\u0627).{0,18}(?:\u0642\u0644\u062a|\u0642\u0648\u0644\u062a)/i.test(
				arabic
			);
		if (nationalityChallenge) continue;
		const explicitIdentity =
			/\b(?:nationality|country|i\s*am|i'm|im)\b/i.test(lower) ||
			/(?:\u062c\u0646\u0633\u064a|\u0628\u0644\u062f\u064a|\u0628\u0644\u062f\u0649|\u0627\u0646\u0627|\u0623\u0646\u0627|\u0627\u0646\u064a|\u0625\u0646\u064a)/i.test(
				arabic
			);
		if (dialectOnly && !explicitIdentity) continue;
		const personaParts = part
			.split(/(?:\u0627\u0646\u0627|\u0623\u0646\u0627|\u0627\u0646\u064a|\u0625\u0646\u064a|\u0627\u0646\u0649|\u0625\u0646\u0649|\bi\s*am\b|\bi'm\b|\bim\b)/i)
			.map((candidate) => candidate.trim())
			.filter(Boolean);
		for (let personaIndex = personaParts.length - 1; personaIndex >= 0; personaIndex -= 1) {
			if (
				/^(?:not|no)\b/i.test(personaParts[personaIndex]) ||
				/^(?:\u0645\u0634|\u0645\u0648|\u0644\u0633\u062a|\u0644\u064a\u0633|\u0645\u0627\u0646\u064a|\u0645\u0628)\b/i.test(
					normalizeControlText(personaParts[personaIndex]).arabic
				)
			) {
				continue;
			}
			const hint =
				nationalityHintFromText(personaParts[personaIndex]) ||
				directNationalityAlias(personaParts[personaIndex]);
			if (hint) return hint;
		}
		const negatedPart =
			/\b(?:not|no)\b/i.test(lower) ||
			/(?:\u0645\u0634|\u0645\u0648|\u0644\u0633\u062a|\u0644\u064a\u0633|\u0645\u0627\u0646\u064a|\u0645\u0628)/i.test(
				arabic
			);
		if (negatedPart) continue;
		const hint = nationalityHintFromText(part) || directNationalityAlias(part);
		if (hint) return hint;
	}
	const candidate = nationalityCandidateFromText(raw);
	return nationalityHintFromText(candidate || raw) || directNationalityAlias(candidate || raw);
}

async function normalizeNationalityFromText(text = "", language = "English") {
	const explicit = explicitNationalityText(text);
	const candidate = explicit || nationalityCandidateFromText(text) || String(text || "").trim();
	if (rejectsNationalityCandidate(candidate)) return "";
	const hint = nationalityHintFromText(candidate);
	if (hint) return hint;
	if (!candidate || candidate.length > 80) return "";
	const compactCandidate = asciiize(candidate)
		.toLowerCase()
		.replace(/[.\s_-]+/g, "");
	const direct = directNationalityAlias(compactCandidate);
	if (direct) return direct;
	const asciiCandidate = asciiize(candidate).trim();
	if (/^[A-Za-z][A-Za-z\s-]{2,40}$/.test(asciiCandidate)) {
		const nat = await validateNationalityLLM(asciiCandidate, language);
		if (nat?.valid && nat.normalized) return nat.normalized;
	}
	const nat = await validateNationalityLLM(candidate, language);
	return nat?.valid && nat.normalized ? nat.normalized : "";
}

function countProvided(value) {
	return value !== null && value !== undefined && value !== "" && Number(value) >= 0;
}

function missingMandatoryReservationFields(st = {}) {
	const slots = st.slots || {};
	const missing = [];
	if (!hasUsableFullName(slots.fullName || slots.name || "")) missing.push("fullName");
	if (AI_REQUIRE_NATIONALITY && !hasUsableNationality(slots.nationality)) {
		missing.push("nationality");
	}
	if (!cleanPhoneCandidate(slots.phone || "")) missing.push("phone");
	if (!slots.adultsProvided || !countProvided(slots.adults) || Number(slots.adults) < 1) {
		missing.push("adults");
	}
	return missing;
}

function hasMandatoryReservationDetails(st = {}) {
	return missingMandatoryReservationFields(st).length === 0;
}

function ensureDefaultChildren(st = {}) {
	if (!st?.slots) return false;
	if (st.slots.childrenProvided && countProvided(st.slots.children)) return false;
	st.slots.children = 0;
	st.slots.childrenProvided = true;
	return true;
}

function localizedReservationDetailLabels(sc = {}, st = {}) {
	const lang = languageOf(sc, st);
	let labels = {
		fullName: "Full name:",
		nationality: "Nationality:",
		phone: "Phone:",
		adults: "Guests: adults, and children if any",
	};
	if (/arabic/i.test(lang)) {
		labels = {
			fullName: "\u0627\u0644\u0627\u0633\u0645 \u0627\u0644\u0643\u0627\u0645\u0644:",
			nationality: "\u0627\u0644\u062c\u0646\u0633\u064a\u0629:",
			phone: "\u0631\u0642\u0645 \u0627\u0644\u0647\u0627\u062a\u0641:",
			adults:
				"\u0639\u062f\u062f \u0627\u0644\u0636\u064a\u0648\u0641: \u0627\u0644\u0628\u0627\u0644\u063a\u064a\u0646\u060c \u0648\u0627\u0644\u0623\u0637\u0641\u0627\u0644 \u0625\u0646 \u0648\u062c\u062f\u0648\u0627",
		};
	} else if (/spanish/i.test(lang)) {
		labels = {
			fullName: "Nombre completo:",
			nationality: "Nacionalidad:",
			phone: "Telefono:",
			adults: "Huespedes: adultos, y ninos si hay",
		};
	} else if (/french/i.test(lang)) {
		labels = {
			fullName: "Nom complet:",
			nationality: "Nationalite:",
			phone: "Telephone:",
			adults: "Voyageurs: adultes, et enfants s'il y en a",
		};
	}
	return labels;
}

function localizedMissingLabels(sc = {}, st = {}) {
	const missing = missingMandatoryReservationFields(st);
	const labels = localizedReservationDetailLabels(sc, st);
	return missing.map((key) => labels[key] || key);
}

function reservationDetailPromptRows(sc = {}, st = {}, { retry = false } = {}) {
	const labels = localizedReservationDetailLabels(sc, st);
	const fields = retry
		? missingMandatoryReservationFields(st)
		: [
				"fullName",
				"phone",
				AI_REQUIRE_NATIONALITY ? "nationality" : "",
				"adults",
		  ].filter(Boolean);
	return fields.map((key) => labels[key] || `${key}:`).join("\n");
}

function mandatoryDetailsPrompt(sc = {}, st = {}, { retry = false } = {}) {
	const lang = languageOf(sc, st);
	const rows = reservationDetailPromptRows(sc, st, { retry });
	if (/arabic/i.test(lang)) {
		return retry
			? `\u0644\u0625\u062a\u0645\u0627\u0645 \u0627\u0644\u062d\u062c\u0632\u060c \u0645\u0627 \u0632\u0644\u062a \u0623\u062d\u062a\u0627\u062c:\n${rows}`
			: `\u062a\u0645\u0627\u0645. \u0644\u0625\u062a\u0645\u0627\u0645 \u0627\u0644\u062d\u062c\u0632\u060c \u0645\u0646 \u0641\u0636\u0644\u0643 \u0623\u0631\u0633\u0644:\n${rows}`;
	}
	if (/spanish/i.test(lang)) {
		return retry
			? `Para completar la reserva, todavia necesito:\n${rows}`
			: `Perfecto. Para completar la reserva, enviame:\n${rows}`;
	}
	if (/french/i.test(lang)) {
		return retry
			? `Pour finaliser la reservation, il me manque encore :\n${rows}`
			: `Parfait. Pour finaliser la reservation, envoyez:\n${rows}`;
	}
	if (/urdu/i.test(lang)) {
		return retry
			? `To complete the reservation, I still need:\n${rows}`
			: `Perfect. To complete the reservation, please send:\n${rows}`;
	}
	if (/hindi/i.test(lang)) {
		return retry
			? `To complete the reservation, I still need:\n${rows}`
			: `Perfect. To complete the reservation, please send:\n${rows}`;
	}
	return retry
		? `To complete the reservation, I still need:\n${rows}`
		: `Perfect. To complete the reservation, please send:\n${rows}`;
}

function optionalEmailPrompt(sc = {}, st = {}) {
	const lang = languageOf(sc, st);
	if (/arabic/i.test(lang)) {
		return "\u0634\u0643\u0631\u0627\u060c \u0633\u062c\u0644\u062a \u0627\u0644\u0628\u064a\u0627\u0646\u0627\u062a \u0627\u0644\u0623\u0633\u0627\u0633\u064a\u0629. \u0625\u0630\u0627 \u062a\u0631\u063a\u0628\u060c \u0623\u0631\u0633\u0644 \u0627\u0644\u0628\u0631\u064a\u062f \u0627\u0644\u0625\u0644\u0643\u062a\u0631\u0648\u0646\u064a \u0644\u0625\u0631\u0633\u0627\u0644 \u062a\u0623\u0643\u064a\u062f \u0627\u0644\u062d\u062c\u0632 \u0648\u0631\u0627\u0628\u0637 \u0627\u0644\u062f\u0641\u0639\u060c \u0623\u0648 \u0627\u0636\u063a\u0637 \u062a\u062e\u0637\u064a.";
	}
	if (/spanish/i.test(lang)) {
		return "Gracias, ya tengo los datos obligatorios. Si quieres recibir la confirmacion y el enlace de pago por email, enviame tu correo, o pulsa Omitir.";
	}
	if (/french/i.test(lang)) {
		return "Merci, j'ai bien note les informations obligatoires. Si vous souhaitez recevoir la confirmation et le lien de paiement par email, envoyez votre adresse, ou cliquez sur Ignorer.";
	}
	return "Thank you, I have the required details. If you would like to receive the confirmation and payment link by email, please share your email address, or choose Skip.";
}

function sanitizeQuickReplies(quickReplies = []) {
	if (!Array.isArray(quickReplies)) return [];
	return quickReplies
		.map((reply) => ({
			label: String(reply?.label || "").trim().slice(0, 80),
			value: String(reply?.value || reply?.label || "").trim().slice(0, 240),
			action: String(reply?.action || "").trim().slice(0, 60),
		}))
		.filter((reply) => reply.label && reply.value)
		.slice(0, 4);
}

function confirmationQuickReplies(sc = {}, st = {}) {
	const lang = languageOf(sc, st);
	if (/arabic/i.test(lang)) {
		return [
			{ label: "\u062a\u0623\u0643\u064a\u062f", value: "\u062a\u0623\u0643\u064a\u062f", action: "confirm" },
			{
				label: "\u0647\u0646\u0627\u0643 \u0634\u064a\u0621 \u063a\u064a\u0631 \u0635\u062d\u064a\u062d",
				value: "\u0647\u0646\u0627\u0643 \u0634\u064a\u0621 \u063a\u064a\u0631 \u0635\u062d\u064a\u062d",
				action: "correction",
			},
		];
	}
	if (/spanish/i.test(lang)) {
		return [
			{ label: "Confirmar", value: "Confirmar", action: "confirm" },
			{ label: "Algo esta mal", value: "Algo esta mal", action: "correction" },
		];
	}
	if (/french/i.test(lang)) {
		return [
			{ label: "Confirmer", value: "Confirmer", action: "confirm" },
			{
				label: "Quelque chose ne va pas",
				value: "Quelque chose ne va pas",
				action: "correction",
			},
		];
	}
	if (/urdu/i.test(lang)) {
		return [
			{ label: "\u062a\u0635\u062f\u064a\u0642", value: "\u062a\u0635\u062f\u064a\u0642", action: "confirm" },
			{
				label: "\u06a9\u0686\u06be \u063a\u0644\u0637 \u06c1\u06d2",
				value: "\u06a9\u0686\u06be \u063a\u0644\u0637 \u06c1\u06d2",
				action: "correction",
			},
		];
	}
	if (/hindi/i.test(lang)) {
		return [
			{ label: "\u092a\u0941\u0937\u094d\u091f\u093f", value: "\u092a\u0941\u0937\u094d\u091f\u093f", action: "confirm" },
			{
				label: "\u0915\u0941\u091b \u0917\u0932\u0924 \u0939\u0948",
				value: "\u0915\u0941\u091b \u0917\u0932\u0924 \u0939\u0948",
				action: "correction",
			},
		];
	}
	return [
		{ label: "Confirm", value: "Confirm", action: "confirm" },
		{ label: "Something is wrong", value: "Something is wrong", action: "correction" },
	];
}

function finalReservationQuickReplies(sc = {}, st = {}) {
	const lang = languageOf(sc, st);
	if (/arabic/i.test(lang)) {
		return [
			{
				label: "\u0625\u062a\u0645\u0627\u0645 \u0627\u0644\u062d\u062c\u0632",
				value: "\u0625\u062a\u0645\u0627\u0645 \u0627\u0644\u062d\u062c\u0632",
				action: "place_reservation",
			},
			{
				label: "\u0647\u0646\u0627\u0643 \u0634\u064a\u0621 \u063a\u064a\u0631 \u0635\u062d\u064a\u062d",
				value: "\u0647\u0646\u0627\u0643 \u0634\u064a\u0621 \u063a\u064a\u0631 \u0635\u062d\u064a\u062d",
				action: "correction",
			},
		];
	}
	if (/spanish/i.test(lang)) {
		return [
			{ label: "Completar reserva", value: "Completar reserva", action: "place_reservation" },
			{ label: "Algo esta mal", value: "Algo esta mal", action: "correction" },
		];
	}
	if (/french/i.test(lang)) {
		return [
			{
				label: "Finaliser la reservation",
				value: "Finaliser la reservation",
				action: "place_reservation",
			},
			{
				label: "Quelque chose ne va pas",
				value: "Quelque chose ne va pas",
				action: "correction",
			},
		];
	}
	if (/urdu/i.test(lang)) {
		return [
			{
				label: "\u0631\u06cc\u0632\u0631\u0648\u06cc\u0634\u0646 \u0628\u0646\u0627\u0626\u06cc\u06ba",
				value: "\u0631\u06cc\u0632\u0631\u0648\u06cc\u0634\u0646 \u0628\u0646\u0627\u0626\u06cc\u06ba",
				action: "place_reservation",
			},
			{
				label: "\u06a9\u0686\u06be \u063a\u0644\u0637 \u06c1\u06d2",
				value: "\u06a9\u0686\u06be \u063a\u0644\u0637 \u06c1\u06d2",
				action: "correction",
			},
		];
	}
	if (/hindi/i.test(lang)) {
		return [
			{
				label: "\u0930\u093f\u091c\u0930\u094d\u0935\u0947\u0936\u0928 \u092c\u0928\u093e\u090f\u0902",
				value: "\u0930\u093f\u091c\u0930\u094d\u0935\u0947\u0936\u0928 \u092c\u0928\u093e\u090f\u0902",
				action: "place_reservation",
			},
			{
				label: "\u0915\u0941\u091b \u0917\u0932\u0924 \u0939\u0948",
				value: "\u0915\u0941\u091b \u0917\u0932\u0924 \u0939\u0948",
				action: "correction",
			},
		];
	}
	if (/indonesian/i.test(lang)) {
		return [
			{
				label: "Selesaikan reservasi",
				value: "Selesaikan reservasi",
				action: "place_reservation",
			},
			{
				label: "Ada yang salah",
				value: "Ada yang salah",
				action: "correction",
			},
		];
	}
	if (/malay/i.test(lang)) {
		return [
			{
				label: "Lengkapkan tempahan",
				value: "Lengkapkan tempahan",
				action: "place_reservation",
			},
			{
				label: "Ada yang salah",
				value: "Ada yang salah",
				action: "correction",
			},
		];
	}
	return [
		{
			label: "Complete Reservation",
			value: "Complete Reservation",
			action: "place_reservation",
		},
		{
			label: "There's Something Wrong",
			value: "There's Something Wrong",
			action: "correction",
		},
	];
}

function finalReservationPrompt(sc = {}, st = {}) {
	const lang = languageOf(sc, st);
	const name = respectfulGuestName(sc, st);
	if (/arabic/i.test(lang)) {
		return `${name}\u060c \u0643\u0644 \u0627\u0644\u062a\u0641\u0627\u0635\u064a\u0644 \u062c\u0627\u0647\u0632\u0629 \u0627\u0644\u0622\u0646. \u0644\u0625\u0646\u0634\u0627\u0621 \u0627\u0644\u062d\u062c\u0632 \u0641\u064a \u0627\u0644\u0646\u0638\u0627\u0645\u060c \u0627\u0636\u063a\u0637 \u00ab\u0625\u062a\u0645\u0627\u0645 \u0627\u0644\u062d\u062c\u0632\u00bb. \u0648\u0625\u0630\u0627 \u0643\u0627\u0646 \u0647\u0646\u0627\u0643 \u0623\u064a \u062a\u0641\u0635\u064a\u0644 \u064a\u062d\u062a\u0627\u062c \u062a\u0639\u062f\u064a\u0644\u060c \u0627\u0636\u063a\u0637 \u00ab\u0647\u0646\u0627\u0643 \u0634\u064a\u0621 \u063a\u064a\u0631 \u0635\u062d\u064a\u062d\u00bb.`;
	}
	if (/spanish/i.test(lang)) {
		return `${name}, todo esta listo. Para completar la reserva en el sistema, elige Completar reserva. Si algun detalle necesita correccion, elige Algo esta mal.`;
	}
	if (/french/i.test(lang)) {
		return `${name}, tout est pret. Pour finaliser la reservation dans le systeme, choisissez Finaliser la reservation. Si un detail doit etre corrige, choisissez Quelque chose ne va pas.`;
	}
	if (/urdu/i.test(lang)) {
		return `${name}، سب تفصیلات تیار ہیں۔ سسٹم میں ریزرویشن بنانے کے لیے ریزرویشن بنائیں منتخب کریں۔ اگر کوئی تفصیل درست نہیں تو کچھ غلط ہے منتخب کریں۔`;
	}
	if (/hindi/i.test(lang)) {
		return `${name}, sab details tayyar hain. System mein reservation banane ke liye Reservation banaen chunein. Agar koi detail sahi nahi hai to Kuch galat hai chunein.`;
	}
	if (/indonesian/i.test(lang)) {
		return `${name}, semua detail sudah siap. Untuk menyelesaikan reservasi di sistem, pilih Selesaikan reservasi. Jika ada detail yang perlu diperbaiki, pilih Ada yang salah.`;
	}
	if (/malay/i.test(lang)) {
		return `${name}, semua butiran sudah sedia. Untuk melengkapkan tempahan dalam sistem, pilih Lengkapkan tempahan. Jika ada butiran perlu diperbetulkan, pilih Ada yang salah.`;
	}
	return `${name}, everything is ready. To complete the booking in the system, choose Complete Reservation. If anything needs fixing, choose There's Something Wrong.`;
}

function placeReservationActionSelected(sc = {}, userText = "", st = {}) {
	if (lastGuestAction(sc) === "place_reservation") return true;
	return false;
}

function emailQuickReplies(sc = {}, st = {}) {
	const lang = languageOf(sc, st);
	if (/arabic/i.test(lang)) {
		return [{ label: "\u062a\u062e\u0637\u064a", value: "\u062a\u062e\u0637\u064a \u0627\u0644\u0628\u0631\u064a\u062f", action: "skip_email" }];
	}
	if (/spanish/i.test(lang)) return [{ label: "Omitir", value: "Omitir email", action: "skip_email" }];
	if (/french/i.test(lang)) return [{ label: "Ignorer", value: "Ignorer email", action: "skip_email" }];
	if (/urdu/i.test(lang)) return [{ label: "\u0646\u0638\u0631 \u0627\u0646\u062f\u0627\u0632", value: "Skip email", action: "skip_email" }];
	if (/hindi/i.test(lang)) return [{ label: "\u091b\u094b\u0921\u0947\u0902", value: "Skip email", action: "skip_email" }];
	return [{ label: "Skip", value: "Skip email", action: "skip_email" }];
}

function emailSkipText(text = "") {
	const raw = digitsToEnglish(String(text || "")).trim();
	if (!raw || latestEmailFromText(raw)) return false;
	const asciiLower = asciiize(raw).toLowerCase().replace(/\s+/g, " ").trim();
	if (
		/^(?:skip|skip email|no|no email|none|not now|later|no thanks|without email|continue without email|omit|omitir|omitir email|sin email|sin correo|ignorer|ignorer email|sans email|pas d'?email|non|non merci)$/i.test(
			asciiLower
		)
	) {
		return true;
	}
	if (
		/\b(?:skip|no email|without email|continue without email|omit|omitir|sin email|sin correo|ignorer|sans email|pas d'?email)\b/i.test(
			asciiLower
		)
	) {
		return true;
	}
	return /^(?:\u0644\u0627|\u0644\u0627\s+\u0634\u0643\u0631\u0627|\u0644\u0627\u062d\u0642\u0627|\u062a\u062e\u0637\u064a|\u062a\u062e\u0637\u0649|\u062a\u062c\u0627\u0648\u0632)$/i.test(
		raw
	) ||
		/(?:\u062a\u062e\u0637\u064a|\u062a\u062e\u0637\u0649|\u0628\u062f\u0648\u0646\s+(?:\u0628\u0631\u064a\u062f|\u0627\u064a\u0645\u064a\u0644|\u0625\u064a\u0645\u064a\u0644)|\u0644\u0627\s+(?:\u064a\u0648\u062c\u062f\s+)?(?:\u0628\u0631\u064a\u062f|\u0627\u064a\u0645\u064a\u0644|\u0625\u064a\u0645\u064a\u0644)|(?:\u0645\u0627|\u0645\u0634)\s+(?:\u0639\u0646\u062f\u064a|\u0639\u0646\u062f\u0649)\s+(?:\u0628\u0631\u064a\u062f|\u0627\u064a\u0645\u064a\u0644|\u0625\u064a\u0645\u064a\u0644))/i.test(
			raw
		);
}

function proceedQuickReplies(sc = {}, st = {}) {
	const lang = languageOf(sc, st);
	if (/arabic/i.test(lang)) {
		return [
			{ label: "\u0646\u0639\u0645\u060c \u062a\u0627\u0628\u0639", value: "\u0646\u0639\u0645\u060c \u062a\u0627\u0628\u0639", action: "proceed" },
			{ label: "\u0644\u0627 \u0627\u0644\u0622\u0646", value: "\u0644\u0627 \u0627\u0644\u0622\u0646", action: "decline" },
		];
	}
	if (/spanish/i.test(lang)) {
		return [
			{ label: "Si, continuar", value: "Si, continuar", action: "proceed" },
			{ label: "Ahora no", value: "Ahora no", action: "decline" },
		];
	}
	if (/french/i.test(lang)) {
		return [
			{ label: "Oui, continuer", value: "Oui, continuer", action: "proceed" },
			{ label: "Pas maintenant", value: "Pas maintenant", action: "decline" },
		];
	}
	return [
		{ label: "Yes, proceed", value: "Yes, proceed", action: "proceed" },
		{ label: "Not now", value: "Not now", action: "decline" },
	];
}

function parseJsonObject(raw = "", fallback = null) {
	const text = String(raw || "").trim();
	if (!text) return fallback;
	try {
		return JSON.parse(text);
	} catch {
		const match = text.match(/\{[\s\S]*\}/);
		if (!match) return fallback;
		try {
			return JSON.parse(match[0]);
		} catch {
			return fallback;
		}
	}
}

function reservationDetailCount(value, { allowZero = false } = {}) {
	if (value === null || value === undefined || value === "") return null;
	const wordNumber = numberFromWords(value, { min: allowZero ? 0 : 1, max: 30 });
	if (wordNumber !== null) return wordNumber;
	const cleaned = normalizeNumberWordsForParsing(value).replace(/[^\d.-]/g, "");
	if (!cleaned) return null;
	const number = Number(cleaned);
	if (!Number.isFinite(number)) return null;
	const count = Math.round(number);
	const minimum = allowZero ? 0 : 1;
	if (count < minimum || count > 30) return null;
	return count;
}

const ADULT_COUNT_TERMS = [
	"adults?",
	"adultos?",
	"adultes?",
	"dewasa",
	"orang\\s+dewasa",
	"baligh",
	"bade",
	"bare",
	"baaligh",
	"\\u092c\\u0921\\u093c\\u0947",
	"\\u0628\\u0627\\u0644\\u063a",
	"\\u0628\\u0627\\u0644\\u063a(?:\\u064a\\u0646|\\u0648\\u0646)?",
	"(?:\\u0627\\u0644)?\\u0628\\u0627\\u0644\\u063a(?:\\u064a\\u0646|\\u0648\\u0646)?",
	"(?:\\u0627\\u0644)?\\u0628\\u0627\\u063a\\u064a\\u0646",
	"\\u0643\\u0628\\u0627\\u0631",
	"\\u0631\\u0627\\u0634\\u062f(?:\\u064a\\u0646|\\u0648\\u0646)?",
];

const CHILD_COUNT_TERMS = [
	"children",
	"child",
	"kids?",
	"ni[n\\u00f1]os?",
	"enfants?",
	"anak(?:\\s+anak)?",
	"kanak(?:\\s+kanak)?",
	"bachche?",
	"bache?",
	"\\u092c\\u091a\\u094d\\u091a(?:\\u0947|\\u093e)?",
	"\\u0628\\u0686(?:\\u06d2|\\u0647)?",
	"[\\u0623\\u0627]\\u0637\\u0641\\u0627\\u0644",
	"(?:\\u0627\\u0644)?[\\u0623\\u0627]\\u0637\\u0641\\u0627\\u0644",
	"\\u0637\\u0641\\u0644(?:\\u064a\\u0646|\\u0627\\u0646)?",
	"[\\u0623\\u0627]\\u0648\\u0644\\u0627\\u062f",
	"(?:\\u0627\\u0644)?[\\u0623\\u0627]\\u0648\\u0644\\u0627\\u062f",
	"\\u0635\\u063a\\u0627\\u0631",
];

const GUEST_COUNT_TERMS = [
	"people",
	"persons?",
	"individuals?",
	"guests?",
	"pax",
	"travell?ers?",
	"personas?",
	"huespedes",
	"hu\\u00e9spedes",
	"voyageurs?",
	"personnes?",
	"tamu",
	"orang",
	"tetamu",
	"mehman",
	"mehmaan",
	"\\u092e\\u0947\\u0939\\u092e\\u093e\\u0928",
	"\\u0645\\u06c1\\u0645\\u0627\\u0646",
	"[\\u0623\\u0627]\\u0634\\u062e\\u0627\\u0635",
	"[\\u0623\\u0627]\\u0641\\u0631\\u0627\\u062f",
	"\\u0636\\u064a\\u0648\\u0641",
	"\\u0646\\u0641\\u0631",
	"\\u0632\\u0648\\u0627\\u0631",
];

function likelyGuestCountText(text = "") {
	const raw = String(text || "");
	if (!raw.trim()) return false;
	const normalized = normalizeNumberWordsForParsing(raw);
	const lower = normalized.toLowerCase();
	const asciiLower = asciiize(normalized).toLowerCase().replace(/\s+/g, " ").trim();
	const hasCount =
		/[\d\u0660-\u0669\u06f0-\u06f9]/.test(normalized) ||
		numberFromWords(raw, { min: 0, max: 30 }) !== null ||
		/\b(?:one|two|three|four|five|six|seven|eight|nine|ten|zero)\b/i.test(
			lower
		) ||
		/(?:\u0648\u0627\u062d\u062f|\u0627\u062b\u0646\u064a\u0646|\u0627\u062a\u0646\u064a\u0646|\u0627\u062b\u0646\u0627\u0646|\u0627\u062a\u0646\u0627\u0646|\u0627\u062b\u0646\u062a\u064a\u0646|\u0627\u062a\u0646\u062a\u064a\u0646|\u062b\u0644\u0627\u062b|\u062b\u0644\u0627\u062b\u0629|\u062b\u0644\u0627\u062b\u0647|\u0627\u0631\u0628\u0639|\u0623\u0631\u0628\u0639|\u0627\u0631\u0628\u0639\u0629|\u062e\u0645\u0633|\u062e\u0645\u0633\u0629|\u0633\u062a|\u0633\u062a\u0629|\u0633\u0628\u0639|\u0633\u0628\u0639\u0629|\u062b\u0645\u0627\u0646|\u062a\u0645\u0627\u0646|\u062a\u0633\u0639|\u0639\u0634\u0631)/i.test(
			raw
		);
	if (!hasCount) return false;
	return (
		/\b(?:adult|adults|adultos?|adultes?|child|children|kid|kids|ninos?|enfants?|guest|guests|huespedes?|people|persons|personas?|personnes?|individuals?|pax|traveller|traveler|travelers|voyageurs?|beds?)\b/i.test(
			asciiLower
		) ||
		/(?:\u0628\u0627\u0644\u063a|\u0628\u0627\u0644\u063a\u064a\u0646|\u0637\u0641\u0644|\u0627\u0637\u0641\u0627\u0644|\u0623\u0637\u0641\u0627\u0644|\u0627\u0648\u0644\u0627\u062f|\u0623\u0648\u0644\u0627\u062f|\u0636\u064a\u0648\u0641|\u0627\u0634\u062e\u0627\u0635|\u0623\u0634\u062e\u0627\u0635|\u0627\u0641\u0631\u0627\u062f|\u0623\u0641\u0631\u0627\u062f|\u0646\u0641\u0631|\u0627\u0633\u0631\u0629|\u0623\u0633\u0631\u0629|\u0633\u0631\u064a\u0631|\u0627\u0633\u0631\u0647|\u0639\u0627\u0626\u0644\u0629|\u0639\u0627\u0626\u0644\u0647)/i.test(
			raw
		)
	);
}

function companionPairGuestCountText(text = "") {
	const raw = String(text || "");
	if (!raw.trim()) return false;
	const normalized = normalizeNumberWordsForParsing(raw);
	const { lower, arabic, latinCompact } = normalizeControlText(normalized);
	return (
		/\b(?:me|myself|i)\s+and\s+(?:my\s+)?(?:friend|wife|husband|brother|sister|mother|father)\b/i.test(
			lower
		) ||
		/\b(?:for|room\s+for|reservation\s+for|booking\s+for)\s+(?:me|myself)\s+and\s+(?:my\s+)?(?:friend|wife|husband|brother|sister|mother|father)\b/i.test(
			lower
		) ||
		/\b(?:yo|conmigo|para\s+mi|para\s+mi\s+mismo|para\s+mi\s+misma)\s+(?:y|con|[+])\s+(?:mi\s+)?(?:amigo|amiga|esposa|esposo|marido|mujer|hermano|hermana|madre|padre)\b/i.test(
			lower
		) ||
		/\b(?:somos|seremos|seriamos)\s+(?:2|dos)\b/i.test(lower) ||
		/\b(?:moi|pour\s+moi)\s+(?:et|avec|[+])\s+(?:mon|ma|mes)?\s*(?:ami|amie|epouse|femme|mari|frere|soeur|mere|pere)\b/i.test(
			lower
		) ||
		/\b(?:nous\s+sommes|on\s+est|nous\s+serons)\s+(?:2|deux)\b/i.test(lower) ||
		/(?:\u0627\u0646\u0627|\u0623\u0646\u0627|\u0644\u064a\u0627|\u0644\u064a|\u0644\u064a\u0647|\u0644\u0649)\s+(?:\u0648|[+])\s*(?:\u0635\u062f\u064a\u0642\u064a|\u0635\u062f\u064a\u0642\u0649|\u0635\u0627\u062d\u0628\u064a|\u0635\u0627\u062d\u0628\u0649|\u0632\u0648\u062c\u062a\u064a|\u0632\u0648\u062c\u062a\u0649|\u0632\u0648\u062c\u064a|\u0632\u0648\u062c\u0649|\u0627\u062e\u064a|\u0623\u062e\u064a|\u0627\u062e\u0649|\u0623\u062e\u0649|\u0627\u062e\u062a\u064a|\u0623\u062e\u062a\u064a|\u0627\u062e\u062a\u0649|\u0623\u062e\u062a\u0649)/i.test(
			arabic
		) ||
		/(?:meandmyfriend|meandfriend|myselfandfriend|yoymiamig[oa]|paramiymiamig[oa]|somos2|somosdos|moietmonami|moietmonamie|pourmoietmonami|pourmoietmonamie|noussommes2|noussommesdeux|onest2|onestdeux|ana[ow]sadiqi|ana[ow]sahbi|lia[ow]sadiqi|lia[ow]sahbi)/i.test(
			latinCompact
		)
	);
}

function standaloneGuestCountFromText(text = "") {
	const raw = String(text || "");
	if (!raw.trim()) return null;
	if (companionPairGuestCountText(raw)) return 2;
	const rawParts = raw
		.split(/[\n\r;|,،]+/)
		.map((part) => part.replace(/\s+/g, " ").trim())
		.filter(Boolean);
	for (const rawPart of rawParts) {
		if (rawPart.length > 40) continue;
		if (latestEmailFromText(rawPart) || cleanPhoneCandidate(rawPart)) continue;
		if (looksLikeStayDateCandidate(rawPart)) continue;
		if (nameCandidateLooksLikeNationality(rawPart)) continue;
		if (
			/\b(?:room|hotel|date|check\s*-?\s*in|check\s*-?\s*out|nationality|country|phone|email)\b/i.test(
				rawPart
			) ||
			/(?:\u063a\u0631\u0641\u0629|\u0641\u0646\u062f\u0642|\u062a\u0627\u0631\u064a\u062e|\u0648\u0635\u0648\u0644|\u062f\u062e\u0648\u0644|\u062e\u0631\u0648\u062c|\u062c\u0646\u0633\u064a\u0629|\u062c\u0648\u0627\u0644|\u0647\u0627\u062a\u0641|\u0628\u0631\u064a\u062f|\u0627\u064a\u0645\u064a\u0644)/i.test(
				rawPart
			)
		) {
			continue;
		}
		const hasLetters = /[A-Za-z\u0600-\u06FF\u0900-\u097F]/.test(rawPart);
		if (!hasLetters && /^\d{1,2}$/.test(rawPart)) continue;
		const count = reservationDetailCount(rawPart, { allowZero: false });
		if (count !== null && count <= 30) return count;
	}
	return null;
}

function countNearTerms(text = "", terms = [], { allowZero = false } = {}) {
	const normalized = normalizeNumberWordsForParsing(text)
		.replace(/\s+/g, " ")
		.trim();
	if (!normalized || !terms.length) return null;
	const source = terms.join("|");
	const boundary = "[^A-Za-z0-9\\u0600-\\u06FF\\u0900-\\u097F]";
	const patterns = [
		new RegExp(`(?:^|${boundary})(?:${source})[\\s:：=\\-]*([0-9]{1,2})(?=$|${boundary})`, "i"),
		new RegExp(`(?:^|${boundary})([0-9]{1,2})\\s*(?:${source})(?=$|${boundary})`, "i"),
	];
	for (const pattern of patterns) {
		const match = normalized.match(pattern);
		const count = reservationDetailCount(match?.[1], { allowZero });
		if (count !== null) return count;
	}
	return null;
}

function noChildrenText(text = "") {
	const raw = normalizeNumberWordsForParsing(text).trim();
	if (!raw) return false;
	const asciiLower = asciiize(raw).toLowerCase().replace(/\s+/g, " ").trim();
	if (
		/\b(?:no|zero|0|without|none|sin|sans|tanpa|tiada|tidak\s+ada|tak\s+ada)\s+(?:children|child|kids?|ninos?|ninos?|enfants?|anak(?:\s+anak)?|kanak(?:\s+kanak)?|bachche?|bache?)\b/i.test(
			asciiLower
		)
	) {
		return true;
	}
	return /(?:\u0628\u062f\u0648\u0646|\u0644\u0627\s+\u064a\u0648\u062c\u062f|\u0645\u0627\s+\u0641\u064a|\u0645\u0641\u064a\u0634|\u0645\u0627\u0641\u064a\u0634|\u0646\u0647\u064a\u06ba)\s+(?:[\u0623\u0627]\u0637\u0641\u0627\u0644|\u0637\u0641\u0644|\u0635\u063a\u0627\u0631|\u0628\u062c\u0647|\u0628\u0686\u06d2|\u092c\u091a\u094d\u091a(?:\u0947|\u093e)?)/i.test(
		raw
	);
}

function applyReservationGuestCountsFromText(st = {}, text = "") {
	if (!st?.slots) return false;
	const before = JSON.stringify(st.slots || {});
	const adults = countNearTerms(text, ADULT_COUNT_TERMS, { allowZero: false });
	const children = countNearTerms(text, CHILD_COUNT_TERMS, { allowZero: true });
	let guests = countNearTerms(text, GUEST_COUNT_TERMS, { allowZero: false });
	if (guests === null) {
		const normalized = normalizeNumberWordsForParsing(text)
			.replace(/\s+/g, " ")
			.trim();
		const genericGuestMatch = normalized.match(
			/(?:^|[^\p{L}\p{N}])(?:guests?|people|persons?|pax|افراد|أفراد|اشخاص|أشخاص|ضيوف|نفر)\s*[:：=-]?\s*([0-9]{1,2})(?=$|[^\p{L}\p{N}])/iu
		);
		guests = reservationDetailCount(genericGuestMatch?.[1], {
			allowZero: false,
		});
	}
	if (guests === null) {
		guests = standaloneGuestCountFromText(text);
	}
	const hasAdultCount = adults !== null;
	let hasChildrenCount = children !== null;
	if (hasAdultCount) {
		st.slots.adults = adults;
		st.slots.adultsProvided = true;
	}
	if (hasChildrenCount) {
		st.slots.children = children;
		st.slots.childrenProvided = true;
	} else if (noChildrenText(text)) {
		st.slots.children = 0;
		st.slots.childrenProvided = true;
		hasChildrenCount = true;
	}
	if (!hasAdultCount && guests !== null) {
		const knownChildren = hasChildrenCount ? Number(st.slots.children || 0) : 0;
		st.slots.adults =
			hasChildrenCount && guests > knownChildren ? guests - knownChildren : guests;
		st.slots.adultsProvided = true;
		if (!hasChildrenCount) ensureDefaultChildren(st);
	}
	if (hasAdultCount && !hasChildrenCount) ensureDefaultChildren(st);
	return before !== JSON.stringify(st.slots || {});
}

function applyFocusedNumericCountAnswer(st = {}, text = "") {
	if (!st?.slots) return false;
	const missing = missingMandatoryReservationFields(st);
	const field = missing.length === 1 ? missing[0] : "";
	if (!["adults", "children"].includes(field)) return false;
	const normalized = normalizeNumberWordsForParsing(text).trim();
	if (!/^\d{1,2}$/.test(normalized)) return false;
	const count = reservationDetailCount(normalized, { allowZero: field === "children" });
	if (count === null) return false;
	st.slots[field] = count;
	st.slots[`${field}Provided`] = true;
	return true;
}

function compactReservationSlotsForInference(st = {}) {
	const slots = st.slots || {};
	return {
		fullName: slots.fullName || slots.name || "",
		nationality: slots.nationality || "",
		phone: slots.phone || "",
		email: slots.email || "",
		emailSkipped: Boolean(slots.emailSkipped),
		adults: slots.adultsProvided ? slots.adults : null,
		adultsProvided: Boolean(slots.adultsProvided),
		children: slots.childrenProvided ? slots.children : null,
		childrenProvided: Boolean(slots.childrenProvided),
	};
}

function applyReservationDetailsInference(st = {}, inferred = {}) {
	if (!st?.slots || !inferred || typeof inferred !== "object") return false;
	const before = JSON.stringify(st.slots || {});
	const fullName = cleanFullNameCandidate(inferred.fullName || inferred.name || "");
	if (shouldReplaceCapturedGuestName(st, fullName)) {
		st.slots.fullName = fullName;
		st.slots.name = fullName;
	}
	const phone = cleanPhoneCandidate(inferred.phone || "");
	if (phone) st.slots.phone = phone;
	const email = latestEmailFromText(inferred.email || "");
	if (email) {
		st.slots.email = email;
		st.slots.emailSkipped = false;
	} else if (inferred.emailSkipped === true) {
		st.slots.email = "";
		st.slots.emailSkipped = true;
	}
	const nationality = String(inferred.nationality || "").trim();
	if (AI_REQUIRE_NATIONALITY && hasUsableNationality(nationality)) {
		st.slots.nationality = nationality;
	}
	const adults = reservationDetailCount(inferred.adults, { allowZero: false });
	let inferredAdultsProvided = false;
	if (inferred.adultsProvided === true && adults !== null) {
		st.slots.adults = adults;
		st.slots.adultsProvided = true;
		inferredAdultsProvided = true;
	}
	const children = reservationDetailCount(inferred.children, { allowZero: true });
	if (inferred.childrenProvided === true && children !== null) {
		st.slots.children = children;
		st.slots.childrenProvided = true;
	} else if (inferredAdultsProvided) {
		ensureDefaultChildren(st);
	}
	if (st.slots.fullName && !st.slots.name) st.slots.name = st.slots.fullName;
	return before !== JSON.stringify(st.slots || {});
}

async function inferReservationDetailsFromContext(sc = {}, st = {}, latestText = "", caseId = "") {
	if (!st?.slots) return null;
	const missing = missingMandatoryReservationFields(st);
	const fieldFocus = missing.length === 1 ? missing[0] : st.waitFor || "";
	const sys = [
		"Hotel reservation NLU.",
		"Interpret dialectal Arabic, Arabizi, and informal multilingual guest writing into intended meaning before extraction.",
		"Use latestGuestMessage, lastAssistantMessage, fieldFocus, currentSlots, missingMandatoryFields, and fullConversation.",
		"Do not use a keyword list or exact phrase matching; infer semantic intent from context.",
		"When fieldFocus is present, a short latest reply answers that field unless the conversation clearly contradicts it.",
		"For count fields, absence or zero meaning is value 0 with provided=true.",
		"If latestGuestMessageDigitsNormalized is a number and fieldFocus is a count field, use that number as the provided count.",
		"Children count is optional for the guest. If the guest gives only a total people/person/guest count and no child count, set adults to that count and children to 0 with childrenProvided=true.",
		"For fieldFocus=email_or_skip, if the guest semantically declines or omits optional email, set emailSkipped=true.",
		"For fieldFocus=fullName, use semantic judgment across any language. Return a fullName only when the latest message is actually a person's name; return empty for requests, hurry/chase messages, booking details requests, countries, or nationalities.",
		"Do not infer adults or children from room type alone.",
		"Never treat polite filler, hurry/chase messages, or requests like please hurry / mumkin / details / booking number as a full name.",
		"Only fill slots provided by the guest or clearly answered by the latest reply.",
		"Output compact JSON only, with all requested keys present.",
	].join(" ");
	const user = JSON.stringify(
		{
			fieldFocus,
			latestGuestMessage: String(latestText || ""),
			latestGuestMessageDigitsNormalized: normalizeNumberWordsForParsing(latestText),
			lastAssistantMessage: lastAssistantText(sc),
			missingMandatoryFields: missing,
			waitFor: st.waitFor || "",
			language: languageOf(sc, st),
			currentSlots: compactReservationSlotsForInference(st),
			fullConversation: recentConversationLines(sc, st),
			returnKeys: [
				"fullName",
				"nationality",
				"phone",
				"email",
				"emailSkipped",
				"adults",
				"adultsProvided",
				"children",
				"childrenProvided",
				"confidence",
			],
		},
		null,
		2
	);
	let raw = "";
	try {
		raw = await chat(
			[
				{ role: "system", content: sys },
				{ role: "user", content: user },
			],
			{ kind: "nlu", temperature: 0, max_tokens: 180, reasoning_effort: "none" }
		);
		const inferred = parseJsonObject(raw, null);
		if (!inferred || typeof inferred !== "object") {
			logStep(caseId || String(sc._id || ""), "reservation_details.context_parse_failed", {
				raw: String(raw || "").slice(0, 500),
				rawLength: String(raw || "").length,
			});
			return null;
		}
		const confidence = Number(inferred.confidence ?? 0.75);
		if (Number.isFinite(confidence) && confidence < 0.45) {
			logStep(caseId || String(sc._id || ""), "reservation_details.context_low_confidence", {
				inferred,
			});
			return inferred;
		}
		if (applyReservationDetailsInference(st, inferred)) {
			logStep(caseId || String(sc._id || ""), "reservation_details.context_inferred", {
				inferred,
				slots: st.slots,
			});
		}
		return inferred;
	} catch (error) {
		logStep(caseId || String(sc._id || ""), "reservation_details.context_inference_failed", {
			message: error?.message || error,
		});
		return null;
	}
}

async function captureReservationDetailsFromText(sc = {}, st = {}, text = "", caseId = "") {
	if (!st?.slots) return;
	const before = JSON.stringify(st.slots || {});
	const fullText = String(text || "");
	const phone = latestPhoneFromText(fullText);
	let directFieldCaptured = false;
	if (phone) {
		st.slots.phone = phone;
		directFieldCaptured = true;
	}
	const email = latestEmailFromText(fullText);
	let emailSkipCaptured = false;
	if (email) {
		st.slots.email = email;
		st.slots.emailSkipped = false;
		directFieldCaptured = true;
	} else if (st.waitFor === "email_or_skip" && emailSkipText(fullText)) {
		st.slots.email = "";
		st.slots.emailSkipped = true;
		emailSkipCaptured = true;
		directFieldCaptured = true;
	}
	if (emailSkipCaptured && st.waitFor === "email_or_skip") {
		if (before !== JSON.stringify(st.slots || {})) {
			logStep(caseId || String(sc._id || ""), "reservation_details.captured", {
				slots: st.slots,
			});
		}
		return;
	}
	const explicitName = explicitNameCandidateFromText(fullText);
	const lineName =
		!explicitName && st.waitFor !== "fullname" ? lineNameCandidateFromText(fullText) : "";
	const name = explicitName || lineName;
	if (shouldReplaceCapturedGuestName(st, name, { explicit: Boolean(explicitName) })) {
		st.slots.fullName = name;
		st.slots.name = name;
		directFieldCaptured = true;
	}
	const nationalitySource = nationalityCandidateFromText(fullText);
	const nationalityHint =
		latestNationalityHintFromText(nationalitySource || fullText) ||
		nationalityHintFromText(nationalitySource || fullText);
	if (AI_REQUIRE_NATIONALITY && nationalityHint) {
		st.slots.nationality = nationalityHint;
		directFieldCaptured = true;
	}
	const explicitCountFieldText =
		/\b(?:adults?|children|kids?|guests?|people|persons?|pax)\b/i.test(fullText) ||
		/(?:\u0628\u0627\u0644\u063a|\u0628\u0627\u0644\u063a\u064a\u0646|\u0627\u0637\u0641\u0627\u0644|\u0623\u0637\u0641\u0627\u0644|\u0636\u064a\u0648\u0641|\u0627\u0641\u0631\u0627\u062f|\u0623\u0641\u0631\u0627\u062f|\u0627\u0634\u062e\u0627\u0635|\u0623\u0634\u062e\u0627\u0635|\u0646\u0641\u0631)/i.test(
			fullText
		) ||
		standaloneGuestCountFromText(fullText) !== null;
	const shouldParseCounts = !directFieldCaptured || explicitCountFieldText;
	const guestCountCaptured = shouldParseCounts
		? applyReservationGuestCountsFromText(st, fullText)
		: false;
	const numericCountCaptured = shouldParseCounts
		? applyFocusedNumericCountAnswer(st, fullText)
		: false;
	if (
		!hasMandatoryReservationDetails(st) &&
		!directFieldCaptured &&
		!guestCountCaptured &&
		!numericCountCaptured &&
		!emailSkipCaptured &&
		["reservation_details", "fullname", "nationality", "phone", "email_or_skip"].includes(st.waitFor)
	) {
		await withSoftTimeout(
			inferReservationDetailsFromContext(sc, st, fullText, caseId),
			2500,
			null
		);
	}
	const hasExplicitNationalitySignal =
		Boolean(nationalitySource) || Boolean(latestNationalityHintFromText(fullText));
	if (
		AI_REQUIRE_NATIONALITY &&
		!hasUsableNationality(st.slots.nationality) &&
		(!directFieldCaptured || hasExplicitNationalitySignal)
	) {
		const nationality = await withSoftTimeout(
			normalizeNationalityFromText(nationalitySource || fullText, languageOf(sc, st)),
			2000,
			""
		);
		if (nationality) st.slots.nationality = nationality;
	}
	if (st.slots.fullName && !st.slots.name) st.slots.name = st.slots.fullName;
	if (before !== JSON.stringify(st.slots || {})) {
		logStep(caseId || String(sc._id || ""), "reservation_details.captured", {
			slots: st.slots,
		});
	}
}

function reservationIdentityOrContactPayloadText(text = "") {
	const value = String(text || "");
	if (!value.trim()) return false;
	if (obviousReservationIdentityOrContactPayloadText(value)) return true;
	if (latestPhoneFromText(value) || latestEmailFromText(value)) return true;
	if (explicitNameCandidateFromText(value)) return true;
	if (nationalityHintFromText(nationalityCandidateFromText(value) || value)) return true;
	return /\b(?:full\s*name|guest\s*name|passport\s*name|my\s+name|name\s+is|nationality|country|phone|mobile|whats\s*app|whatsapp|email|e-mail)\b/i.test(
		value
	);
}

function reservationDetailChaseText(text = "") {
	const value = String(text || "");
	if (!value.trim()) return false;
	const { lower, arabic, latinCompact } = normalizeControlText(value);
	return (
		/\b(?:please\s+)?(?:make|create|complete|finali[sz]e|finish|place|proceed\s+with)\b.{0,50}\b(?:reservation|booking)\b/i.test(
			lower
		) ||
		/\b(?:make|create|complete|finali[sz]e|finish|place)\s+(?:it|this|the)\b/i.test(
			lower
		) ||
		/(?:\u0627\u062d\u062c\u0632|\u0623\u062d\u062c\u0632|\u0627\u0643\u0645\u0644|\u0623\u0643\u0645\u0644|\u0643\u0645\u0644|\u0623\u0643\u062f|\u0627\u0643\u062f).{0,40}(?:\u0627\u0644\u062d\u062c\u0632|\u062d\u062c\u0632|\u0627\u0644\u0628\u0648\u0643\u064a\u0646\u062c)/i.test(
			arabic
		) ||
		/(?:make|create|complete|finalize|finalise|finish|place|proceed).{0,40}(?:reservation|booking)/i.test(
			latinCompact
		)
	);
}

function reservationDetailFieldPayloadText(text = "") {
	const value = String(text || "");
	if (!value.trim()) return false;
	if (latestPhoneFromText(value) || latestEmailFromText(value)) return true;
	if (explicitNameCandidateFromText(value)) return true;
	if (latestNationalityHintFromText(explicitNationalityText(value) || value)) return true;
	if (
		selectedHotelRoomQuestionText(value) ||
		selectedHotelFactQuestionText(value) ||
		cancellationRefundPolicyQuestionText(value) ||
		wantsDiscountQuestion(value) ||
		wantsPaymentHelp(value)
	) {
		return false;
	}
	if (
		/(?:\b(?:full\s*name|guest\s*name|passport\s*name|name|nationality|country|phone|mobile|whatsapp|email|adults?|children|kids?|guests?|people|persons?|pax)\b|(?:\u0627\u0644\u0627\u0633\u0645|\u0627\u0633\u0645|\u0627\u0644\u062c\u0646\u0633\u064a\u0629|\u062c\u0646\u0633\u064a\u062a\u064a|\u062c\u0646\u0633\u064a\u062a\u0649|\u0628\u0644\u062f\u064a|\u062c\u0648\u0627\u0644|\u0647\u0627\u062a\u0641|\u0628\u0631\u064a\u062f|\u0627\u064a\u0645\u064a\u0644|\u0628\u0627\u0644\u063a|\u0628\u0627\u0644\u063a\u064a\u0646|\u0627\u0637\u0641\u0627\u0644|\u0623\u0637\u0641\u0627\u0644|\u0636\u064a\u0648\u0641))/i.test(
			value
		)
	) {
		return true;
	}
	if (countNearTerms(value, ADULT_COUNT_TERMS, { allowZero: false }) !== null) return true;
	if (countNearTerms(value, CHILD_COUNT_TERMS, { allowZero: true }) !== null) return true;
	if (countNearTerms(value, GUEST_COUNT_TERMS, { allowZero: false }) !== null) return true;
	return noChildrenText(value);
}

function nextPivot(st) {
	if (st.waitFor === "intentConfirm") return "intentConfirm";
	if (!st.slots.checkinISO || !st.slots.checkoutISO) return "dates";
	if (!st.slots.roomTypeKey) return "room";
	if (
		[
			"reservation_details",
			"fullname",
			"nationality",
			"phone",
			"email_or_skip",
			"finalize",
		].includes(st.waitFor)
	) {
		return st.waitFor;
	}
	if (!st.reviewSent) return "proceed";
	if (!hasMandatoryReservationDetails(st)) return "reservation_details";
	if (!st.slots.email && !st.slots.emailSkipped) return "email_or_skip";
	return "finalize";
}

function confirmsText(text = "") {
	const raw = String(text || "");
	const { lower, arabic, latinCompact } = normalizeControlText(raw);
	if (
		/\bconfirmation\s*(?:number|no|#|reference)\b/i.test(lower) ||
		/(?:\u0631\u0642\u0645\s+\u0627\u0644\u062a\u0627\u0643\u064a\u062f|\u0631\u0642\u0645\s+\u0627\u0644\u062a\u0623\u0643\u064a\u062f)/i.test(
			arabic
		)
	) {
		return false;
	}
	const hasExplicitFinalVerb =
		/\b(?:confirm|complete|finali[sz]e|finalise|place|create|make)\b/i.test(
			lower
		);
	const detailOnlyCandidate =
		latestEmailFromText(raw) ||
		/\b(?:email|e-mail|mail|phone|mobile|whats\s*app|whatsapp|nationality|full\s+name|my\s+name|name\s+is)\b/i.test(
			lower
		);
	if (detailOnlyCandidate && !hasExplicitFinalVerb) {
		return false;
	}
	if (
		/(?:\u062a\u0645\u0627\u0645|\u0646\u0639\u0645|\u0627\u064a\u0648\u0647|\u0623\u064a\u0648\u0647|\u0627\u064a\u0648\u0627|\u0627\u062d\u062c\u0632|\u0627\u0643\u062f|\u0623\u0643\u062f|\u062a\u0627\u0643\u064a\u062f|\u062a\u0623\u0643\u064a\u062f|\u0627\u0644\u062a\u0627\u0643\u064a\u062f|\u0627\u0644\u062a\u0623\u0643\u064a\u062f|\u0645\u0648\u0627\u0641\u0642|\u0635\u062d\u064a\u062d)/i.test(
			arabic
		) ||
		/(?:confirm|confirmed|confirmation|yes|yep|yeah|ok|okay|proceed|goahead|bookit|reserveit|takeed|ta2keed|taakid|takid|t2keed|ta2kid|a2ked|aked|akid|tamam|naam|aywa|aiwa|ewa|oui|confirmer|daccord|si|sí|vale)/i.test(
			latinCompact
		)
	) {
		return true;
	}
	if (
		/(?:\u062a\u0645\u0627\u0645|\u0646\u0639\u0645|\u0627\u064a\u0648\u0647|\u0623\u064a\u0648\u0647|\u0627\u064a\u0648\u0627|\u0627\u062d\u062c\u0632|\u0627\u0643\u062f|\u0623\u0643\u062f|\u062a\u0623\u0643\u064a\u062f)/i.test(raw)
	) {
		return true;
	}
	return /\b(confirm(?:ed)?|yes|yep|yeah|ok|okay|proceed|go ahead|book it|reserve it|تمام|نعم|ايوه|أيوه|ايوا|احجز|اكد|تأكيد|confirmer|oui|d'accord|si|sí|vale)\b/i.test(
		String(text || "")
	);
}

function currentQuoteTotalMentioned(text = "", st = {}) {
	const total = Number(st.quote?.data?.totals?.totalPriceWithCommission);
	if (!Number.isFinite(total) || total <= 0) return false;
	const normalized = digitsToEnglish(String(text || "")).replace(/[,\u066c]/g, "");
	const roundedTotal = String(Math.round(total));
	return new RegExp(`(^|[^0-9])${roundedTotal}([^0-9]|$)`).test(normalized);
}

function quoteConfirmationText(text = "", st = {}) {
	const hasQuoteContext =
		st.waitFor === "proceed" || activeQuoteMatchesSlots(st) || st.quote?.data?.available;
	if (!hasQuoteContext) return false;
	if (confirmsText(text)) return true;
	const { lower, arabic, latinCompact } = normalizeControlText(text);
	const directArabic =
		/(?:\u0627\u0643\u062f|\u0627\u0643\u062f\u064a|\u0627\u0643\u062f\u0648\u0627|\u0646\u0627\u0643\u062f|\u0646\u0624\u0643\u062f|\u0646\u0648\u0643\u062f|\u062b\u0628\u062a|\u062b\u0628\u062a\u064a|\u0627\u062d\u062c\u0632|\u0627\u062d\u062c\u0632\u064a|\u0643\u0645\u0644|\u0627\u0643\u0645\u0644|\u062a\u0627\u0628\u0639|\u062a\u0627\u0628\u0639\u064a).{0,32}(?:\u0627\u0644\u062d\u062c\u0632|\u062d\u062c\u0632)/i.test(
			arabic
		) ||
		/(?:\u0627\u0644\u062d\u062c\u0632|\u062d\u062c\u0632).{0,50}(?:\u0627\u0639\u0644\u0627\u0647|\u0627\u0639\u0644\u0627|\u0641\u0648\u0642|\u0627\u0644\u0633\u0627\u0628\u0642|\u0627\u0644\u0645\u0630\u0643\u0648\u0631|\u0647\u0630\u0627|\u062f\u0647)/i.test(
			arabic
		);
	const directLatin =
		/\b(?:confirm|proceed|continue|go ahead|book|reserve|finalize)\b.{0,40}\b(?:booking|reservation|quote|above|this)\b/i.test(
			lower
		) ||
		/\b(?:can|could|may)\s+(?:i|we)\s+(?:book|reserve)\b/i.test(lower) ||
		/\b(?:i|we)\s+(?:want|would like|need)\s+to\s+(?:book|reserve)\b/i.test(
			lower
		) ||
		/\b(?:i|we)\s+(?:want|would like|need)\s+to\s+make\s+(?:a|the|this|my|our)?\s*reservation\b/i.test(
			lower
		) ||
		/\b(?:book|reserve)\s+(?:a|one|the)\s+(?:room|double|triple|quad|suite)\b/i.test(
			lower
		) ||
		/(?:confirmbooking|confirmreservation|proceedbooking|continuebooking|bookabove|bookaroom|bookone|bookoneroom|reservearoom|reserveone|reserveoneroom|canireserve|canwereserve|canibook|canwebook|iwanttoreserve|wewanttoreserve|iwanttobook|wewanttobook|iwouldliketoreserve|wewouldliketoreserve|iwouldliketobook|wewouldliketobook|iwanttomakeareservation|wewanttomakeareservation|iwanttomakethereservation|wewanttomakethereservation|iwanttomakethisreservation|wewanttomakethisreservation|makethereservation|makethisreservation|reservethis|finalizethis)/i.test(
			latinCompact
		);
	const repeatsQuotedTotal =
		currentQuoteTotalMentioned(text, st) &&
		((/(?:\u062d\u062c\u0632|\u0627\u0644\u062d\u062c\u0632).{0,80}(?:\u0627\u062c\u0645\u0627\u0644\u064a|\u0628\u0627\u062c\u0645\u0627\u0644\u064a|\u0628\u0627\u062c\u0645\u0627\u0644\u0649|\u0645\u062c\u0645\u0648\u0639|\u0631\u064a\u0627\u0644)/i.test(
			arabic
		) ||
			/\b(?:booking|reservation|quote|total)\b.{0,80}\b(?:total|sar|riyal|price)\b/i.test(
				lower
			)));
	return directArabic || directLatin || repeatsQuotedTotal;
}

function declinesText(text = "") {
	const { lower, arabic, latinCompact } = normalizeControlText(text);
	const arabicDecline =
		/(^|[\s\u060c,\u061b.!?\u061f])(?:\u0644\u0627|\u0644\u0627 \u0627\u0644\u0627\u0646|\u0644\u064a\u0633 \u0627\u0644\u0627\u0646|\u0645\u0634 \u0627\u0644\u0627\u0646|\u0645\u0634 \u062f\u0644\u0648\u0642\u062a\u064a|\u0644\u0627\u062d\u0642\u0627|\u0628\u0639\u062f\u064a\u0646)(?=$|[\s\u060c,\u061b.!?\u061f])/i.test(
			arabic
		);
	return (
		arabicDecline ||
		/\b(no|nope|not now|later|cancel|non|pas maintenant|no gracias)\b/i.test(
			lower
		) ||
		/(?:nope|notnow|later|cancel|nongracias|pasmaintenant)/i.test(
			latinCompact
		)
	);
}

function patienceText(text = "") {
	return /\b(take your time|no rush|whenever|slow down|wait|one moment|moment|براحتك|براحتك|خد وقتك|خدي وقتك|استنى|انتظر)\b/i.test(
		String(text || "")
	);
}

function guestHurryOrChaseText(text = "") {
	const { lower, arabic, latinCompact } = normalizeControlText(text);
	return (
		/\b(?:hurry|quick|quickly|faster|speed|urgent|asap|can you hurry|please hurry)\b/i.test(
			lower
		) ||
		/(?:\u0628\u0633\u0631\u0639\u0647|\u0628\u0633\u0631\u0639\u0629|\u0633\u0631\u0639\u0647|\u0633\u0631\u0639\u0629|\u0627\u0644\u0633\u0631\u0639\u0647|\u0627\u0644\u0633\u0631\u0639\u0629|\u0645\u0633\u062a\u0639\u062c\u0644|\u0645\u0633\u062a\u0639\u062c\u0644\u0647)/i.test(
			arabic
		) ||
		/(?:hurry|quickly|faster|speed|urgent|asap|sora|sor3a|bsor3a|bser3a|mosta3gel)/i.test(
			latinCompact
		)
	);
}

function guestPauseOrLaterText(text = "") {
	const raw = String(text || "").trim();
	if (!raw) return false;
	const { lower, arabic, latinCompact } = normalizeControlText(raw);
	return (
		/\b(?:talk|chat|call|continue|come\s+back)\s+later\b/i.test(lower) ||
		/^(?:later|not\s+now|maybe\s+later|another\s+time|thanks\s+anyway|thank\s+you\s+anyway|no\s+thanks)\.?$/i.test(
			lower
		) ||
		/(?:ه?كلمك|حكلمك|اكلمك|اتكلم|نتكلم|نكمل|ارجعلك|ارجع لك).{0,30}(?:بعدين|لاحقا|بعد كده|بعدها)/i.test(
			arabic
		) ||
		/(?:بعدين|لاحقا|بعد كده|مش دلوقتي|مش الان|لا الان|لا الآن|ليس الان|وقت تاني|وقت ثاني|شكرا علي اي حال|شكرا على اي حال|شكرا على اى حال|خلاص كده)/i.test(
			arabic
		) ||
		/(?:talklater|chatlater|calllater|continuelater|comebacklater|notnow|maybelater|anothertime|thanksanyway|thankyouanyway|nothanks|ba3den|baadain|meshdelwa2ty|mshdelwa2ty)/i.test(
			latinCompact
		)
	);
}

function bookingPauseReplyText(sc = {}, st = {}) {
	const name = respectfulGuestName(sc, st);
	const lang = languageOf(sc, st);
	if (/arabic/i.test(lang)) {
		return `${name}، ولا يهمك. أنا معك وقت ما تحب ترجع، وأكمل معك بهدوء بدون أي استعجال.`;
	}
	if (/spanish/i.test(lang)) {
		return `${name}, claro, no hay prisa. Estare aqui cuando quieras volver y seguimos con calma.`;
	}
	if (/french/i.test(lang)) {
		return `${name}, bien sur, aucun souci. Je reste disponible quand vous souhaitez revenir, et nous reprendrons tranquillement.`;
	}
	if (/urdu/i.test(lang)) {
		return `${name}، کوئی مسئلہ نہیں۔ جب آپ دوبارہ تیار ہوں، میں یہیں ہوں اور آرام سے مدد جاری رکھوں گا/گی۔`;
	}
	if (/hindi/i.test(lang)) {
		return `${name}, koi baat nahi. Jab aap wapas tayyar hon, main yahin hoon aur aaram se madad jaari rakhunga/rakhungi.`;
	}
	if (/indonesian/i.test(lang)) {
		return `${name}, tidak apa-apa. Saya tetap di sini saat Anda ingin kembali, dan kita lanjutkan dengan tenang.`;
	}
	if (/malay/i.test(lang)) {
		return `${name}, tidak mengapa. Saya sedia apabila anda mahu kembali, dan kita sambung dengan tenang.`;
	}
	return `${name}, no problem. I will be here whenever you want to come back, and we can continue calmly with no rush.`;
}

async function answerBookingPause(io, sc, st, userText = "") {
	pauseBookingNudge(st);
	await humanSend(io, sc, st, bookingPauseReplyText(sc, st), {
		scheduleIdle: false,
	});
	st.waitFor = st.waitFor || "clarify";
	logStep(String(sc._id), "booking_pause.reply", {
		waitFor: st.waitFor,
		latestUserMessage: String(userText || "").slice(0, 160),
	});
	return true;
}

function botExperienceComplaintText(text = "") {
	const raw = String(text || "");
	const { lower, arabic, latinCompact } = normalizeControlText(raw);
	return (
		/\b(repeat|repeating|again|too fast|typing so fast|rushing|rush|lost|confused|pay attention|i am here|i'm here|still here|already told you|i told you|you forgot|bot|robot|worst|bad cs|bad support|wrong with you|what is going on|omg|lol)\b/i.test(
			lower
		) ||
		/(?:تكرر|بتكرر|بسرعة|سريعة|مستعجل|مستعجلة|مستعجله|تايه|تايهة|تايهه|مش\s+فاهم|مش\s+فاهمة|مش\s+فاهمه|ركزي|ركز|انا\s+موجود|أنا\s+موجود|موجود\s+اهو|ايه\s+فيه|ايه\s+ده|قولتلك|قلتلك|لسه\s+قايل|شايفني\s+غبي|شايفاني\s+غبي|شايفانى\s+غبي|بتعاملني\s+كأني\s+غبي|بتعامليني\s+كأني\s+غبي|روبوت|بوت|وحش|سيئ|غلط)/i.test(
			arabic
		) ||
		/(?:toofast|rushing|rush|lost|confused|payattention|iamhere|imhere|stillhere|alreadytoldyou|itoldyou|youforgot|doyouthinkimstupid|thinkimstupid|treatingmelikestupid|entahtayeh|tayha|tayeh|ana mawgood|anamawgoud|mawgood|ehfeeh|ehda|oltlek|ultlek|bot|robot|badcs|badsupport|wrongwithyou)/i.test(
			latinCompact
		)
	);
}

function conversationRecoveryFallbackText(sc = {}, st = {}) {
	const name = respectfulGuestName(sc, st);
	const lang = languageOf(sc, st);
	if (/arabic/i.test(lang)) {
		return `${name}، حقك عليّ. أنا معك وأتابع المحادثة، ولن أستعجلك. أرسل لي النقطة التالية عندما تحب وسأكمل معك بوضوح.`;
	}
	if (/spanish/i.test(lang)) {
		return `${name}, tienes razon, disculpa. Estoy contigo y sigo el contexto; no quiero apresurarte. Enviame el siguiente detalle cuando estes listo y continuo con claridad.`;
	}
	if (/french/i.test(lang)) {
		return `${name}, vous avez raison, desole. Je suis avec vous et je garde le contexte; je ne veux pas vous presser. Envoyez-moi le prochain detail quand vous etes pret et je continue clairement.`;
	}
	return `${name}, you are right, sorry about that. I am with you and following the context; I do not want to rush you. Send the next detail whenever you are ready and I will continue clearly.`;
}

async function answerConversationRecovery(io, sc, st, userText = "") {
	const hadContactRequest = hotelContactConversationRequestCount(sc) > 0;
	const contextual = activeBookingContinuationText(sc, st, {
		apology: true,
		contactBoundary: hadContactRequest,
	});
	const reply = contextual || conversationRecoveryFallbackText(sc, st);
	await humanSend(io, sc, st, reply, { scheduleIdle: false });
	preserveBookingWaitState(st, st.waitFor);
	logStep(String(sc._id), "conversation_recovery.reply", {
		latestUserMessage: String(userText || "").slice(0, 160),
		waitFor: st.waitFor,
		hadContactRequest,
	});
	return true;
}

function abusiveGuestText(text = "") {
	const { lower, arabic, latinCompact } = normalizeControlText(text);
	return (
		/\b(fuck|fucking|shit|bullshit|bitch|bastard|asshole|idiot|stupid|moron|damn you|go to hell)\b/i.test(
			lower
		) ||
		/(?:كس\s*امك|كسمك|شرموط|شرموطة|عرص|وسخ|حقير|حمار|غبي|زباله|زبالة|يلعن|لعنة)/i.test(
			arabic
		) ||
		/(?:fuck|fucking|bullshit|asshole|bitch|bastard|damnyou|gotohell|kosomak|kosomek|sharmout|sharmota|ghaby|zebala)/i.test(
			latinCompact
		)
	);
}

function severeAbusiveGuestText(text = "") {
	const { lower, arabic, latinCompact } = normalizeControlText(text);
	return (
		/\b(fuck|fucking|shit|bullshit|bitch|bastard|asshole|damn you|go to hell)\b/i.test(
			lower
		) ||
		/(?:كس\s*امك|كسمك|شرموط|شرموطة|عرص|وسخ|حقير|زباله|زبالة|يلعن|لعنة)/i.test(
			arabic
		) ||
		/(?:fuck|fucking|bullshit|asshole|bitch|bastard|damnyou|gotohell|kosomak|kosomek|sharmout|sharmota|zebala)/i.test(
			latinCompact
		)
	);
}

function looksLikeReservationDateUpdate(text = "", lu = {}) {
	const { lower, arabic, latinCompact } = normalizeControlText(text);
	const quickDates = quickDateRange(text);
	const hasDateWords =
		/\b(date|dates|check\s*in|checkin|check-in|checkout|check\s*out|check-out|arrival|departure|extend|extension|shorten|night|nights|stay)\b/i.test(
			lower
		) ||
		/(?:تاريخ|تواريخ|الدخول|الخروج|الوصول|المغادره|المغادرة|تمديد|مدد|ليله|ليلة|اقامه|إقامة)/i.test(
			arabic
		) ||
		/(?:fecha|fechas|entrada|salida|arrivee|arrivée|depart|départ|sejour|séjour)/i.test(
			lower
		);
	const hasUpdateWords =
		/\b(update|change|modify|amend|edit|move|adjust|switch|correct)\b/i.test(
			lower
		) ||
		/(?:تعديل|عدل|غير|تغيير|غيّر|تصحيح|بدل|نقل)/i.test(arabic) ||
		/(?:update|change|modify|amend|edit|move|adjust|switch|ta3deel|taghyeer|ghayar|adel|badal|cambiar|modifier|changer)/i.test(
			latinCompact
		);
	return Boolean(
		(hasDateWords && hasUpdateWords) ||
			((lu?.dates?.checkinISO || quickDates.checkinISO) && hasUpdateWords)
	);
}

function latestTurnDateRange(text = "", lu = {}) {
	const quickDates = quickDateRange(text);
	return {
		checkinISO: lu?.dates?.checkinISO || quickDates.checkinISO || null,
		checkoutISO: lu?.dates?.checkoutISO || quickDates.checkoutISO || null,
		raw: lu?.dates?.raw || quickDates.raw || null,
	};
}

function deterministicReservationUpdateLu(text = "", sc = {}, lu = {}) {
	const dates = latestTurnDateRange(text, lu);
	const confirmation =
		lu?.confirmation || confirmationFromText(text) || latestKnownConfirmation(sc, lu);
	return {
		...(lu || {}),
		confirmation: confirmation || null,
		dates: {
			...(lu?.dates || {}),
			checkinISO: dates.checkinISO,
			checkoutISO: dates.checkoutISO,
			raw: dates.raw || lu?.dates?.raw || null,
		},
	};
}

function reservationUpdateChoiceQuickReplies(sc = {}, st = {}, options = []) {
	const lang = languageOf(sc, st);
	return options.slice(0, 3).map((_, index) => {
		const number = index + 1;
		let label = `Option ${number}`;
		if (/arabic/i.test(lang)) label = `\u0627\u0644\u062e\u064a\u0627\u0631 ${arabicDigits(number)}`;
		if (/spanish/i.test(lang)) label = `Opcion ${number}`;
		if (/french/i.test(lang)) label = `Option ${number}`;
		return {
			label,
			value: label,
			action: `reservation_update_option_${number}`,
		};
	});
}
function parseReservationUpdateOptionChoice(text = "", options = []) {
	if (!options.length) return -1;
	const { lower, arabic, latinCompact } = normalizeControlText(text);
	const digit = lower.match(/\b([1-3])\b/);
	if (digit) {
		const index = Number(digit[1]) - 1;
		return options[index] ? index : -1;
	}
	if (/\b(first|option one|option 1|one|uno|premier|premiere)\b/i.test(lower)) {
		return options[0] ? 0 : -1;
	}
	if (/\b(second|option two|option 2|two|dos|deux)\b/i.test(lower)) {
		return options[1] ? 1 : -1;
	}
	if (/\b(third|option three|option 3|three|tres|trois)\b/i.test(lower)) {
		return options[2] ? 2 : -1;
	}
	if (/(?:\u0627\u0644\u0627\u0648\u0644|\u0627\u0644\u0623\u0648\u0644|\u0627\u0648\u0644|\u0623\u0648\u0644|\u0648\u0627\u062d\u062f|\u0661|\u06f1)/i.test(arabic)) return options[0] ? 0 : -1;
	if (/(?:\u0627\u0644\u062b\u0627\u0646\u064a|\u062b\u0627\u0646\u064a|\u062a\u0627\u0646\u064a|\u0627\u062a\u0646\u064a\u0646|\u0627\u062b\u0646\u064a\u0646|\u0662|\u06f2)/i.test(arabic)) return options[1] ? 1 : -1;
	if (/(?:\u0627\u0644\u062b\u0627\u0644\u062b|\u062b\u0627\u0644\u062b|\u062a\u0627\u0644\u062a|\u062b\u0644\u0627\u062b\u0647|\u062b\u0644\u0627\u062b\u0629|\u0663|\u06f3)/i.test(arabic)) return options[2] ? 2 : -1;
	if (confirmsText(text) && options.length === 1) return 0;
	if (/(?:optionone|first|one|uno|premier)/i.test(latinCompact)) {
		return options[0] ? 0 : -1;
	}
	if (/(?:optiontwo|second|two|dos|deux)/i.test(latinCompact)) {
		return options[1] ? 1 : -1;
	}
	if (/(?:optionthree|third|three|tres|trois)/i.test(latinCompact)) {
		return options[2] ? 2 : -1;
	}
	return -1;
}

function asksAiIdentity(text = "") {
	return /\b(are you (?:a )?(?:human|bot|robot|ai)|you are (?:a )?(?:bot|robot|ai)|real person)\b|\u0627\u0646\u062a\u064a\s+\u0627\u0646\u0633\u0627\u0646|\u0627\u0646\u062a\s+\u0627\u0646\u0633\u0627\u0646|\u0631\u0648\u0628\u0648\u062a|\u0628\u0648\u062a|\u0630\u0643\u0627\u0621\s+\u0627\u0635\u0637\u0646\u0627\u0639\u064a/i.test(
		String(text || "")
	);
}

function isAutomatedSupportNoticeText(text = "") {
	const value = String(text || "").trim();
	if (!value) return false;
	return /support specialist is reviewing|representative will be with you|support team is reviewing|team is reviewing/i.test(
		value
	) || /\u0641\u0631\u064a\u0642\s+Jannat Booking\s+\u064a\u0631\u0627\u062c\u0639\s+\u0631\u0633\u0627\u0644\u062a\u0643/i.test(
		value
	);
}

function lastGuestMessage(sc = {}) {
	const convo = Array.isArray(sc.conversation) ? sc.conversation : [];
	return [...convo]
		.reverse()
		.find((m) => {
			if (!m?.message || !m?.messageBy || isAiConversationMessage(m)) return false;
			return !isAutomatedSupportNoticeText(m.message);
		});
}

function lastUserText(sc) {
	const lastUser = lastGuestMessage(sc);
	return lastUser?.message || "";
}

function lastGuestAction(sc = {}) {
	return String(lastGuestMessage(sc)?.clientAction || "").trim();
}

function lastAssistantText(sc = {}) {
	const conversation = Array.isArray(sc.conversation) ? sc.conversation : [];
	const lastAssistant = [...conversation]
		.reverse()
		.find((message) => !message?.isSystem && isAiConversationMessage(message));
	return String(lastAssistant?.message || "");
}

function hijriYearOnlyOrClarificationText(text = "") {
	const normalized = digitsToEnglish(String(text || "").toLowerCase());
	const hasExplicitYear = /\b(?:1[34]\d{2}|15\d{2})\b/.test(normalized);
	const confirmsNearestFuture =
		/\b(?:not\s+(?:another\s+)?(?:10|ten)\s+years?|not\s+in\s+(?:10|ten)\s+years?|nearest|closest|coming|upcoming|next\s+(?:one|hijri|islamic)|this\s+year|of\s+course\s+not)\b/i.test(
			normalized
		) ||
		/(?:مش\s+(?:كمان|بعد)?\s*(?:10)?\s*سن(?:ين|وات)?|اكيد\s+مش|أكيد\s+مش|اقرب|أقرب|القريب|القريبه|القريبة|السنه\s+دي|السنة\s+دي|الجاي|القادم)/i.test(
			normalized
		);
	if (!hasExplicitYear && !confirmsNearestFuture) return false;
	return !/\b(?:price|rate|availability|available|room|hotel|book|reserve|payment|confirmation)\b/i.test(
		normalized
	);
}

function assistantAskedForDateOrHijriYear(text = "") {
	return /which\s+(?:ramadan|hijri|islamic)\s+year|which\s+year|ramadan\s+year|hijri\s+year|check\s*-?\s*in|check\s*-?\s*out|dates?|month\s+is\s+required|\u0631\u0645\u0636\u0627\u0646|\u0627\u0644\u0633\u0646\u0629|\u062a\u0627\u0631\u064a\u062e|\u062a\u0648\u0627\u0631\u064a\u062e/i.test(
		String(text || "")
	);
}

function recentConversationLines(sc = {}, st = {}) {
	const conversation = Array.isArray(sc.conversation) ? sc.conversation : [];
	const aiSender = st?.hotel?.hotelName
		? `${toTitle(st.hotel.hotelName)} reception and reservations`
		: "Jannat Booking support";
	return conversation
		.map((message) => {
			const sender = isAiConversationMessage(message)
				? aiSender
				: message?.messageBy?.customerName || "Guest";
			return `${sender}: ${String(message?.message || "").slice(0, 300)}`;
		})
		.join("\n");
}

function latestGuestLanguageStyle(sc = {}, targetLanguage = "") {
	const latest = lastUserText(sc);
	const text = String(latest || "").trim();
	const target = String(targetLanguage || "").toLowerCase();
	if (!text) {
		return {
			latestGuestTextSample: "",
			likelyDifferentFromPreferred: false,
			style: "unknown",
			guidance: "No latest guest message is available.",
		};
	}
	const hasArabicScript = /[\u0600-\u06FF]/.test(text);
	const hasDevanagari = /[\u0900-\u097F]/.test(text);
	const latinLetters = (text.match(/[A-Za-z]/g) || []).length;
	const hasLatinWords = latinLetters >= 3;
	const likelyLatinOnly = hasLatinWords && !hasArabicScript && !hasDevanagari;
	const likelyArabicTarget = /arabic|ar\b/.test(target);
	const likelyHindiTarget = /hindi|hi\b/.test(target);
	const likelyUrduTarget = /urdu|ur\b/.test(target);
	const likelyRomanizedPreferredLanguage =
		(likelyArabicTarget || likelyHindiTarget || likelyUrduTarget) &&
		likelyLatinOnly;
	const likelyDifferentFromPreferred =
		(!likelyArabicTarget && !likelyHindiTarget && !likelyUrduTarget && hasArabicScript);
	const style = hasArabicScript
		? "Arabic-script or Urdu-script"
		: hasDevanagari
		? "Devanagari-script"
		: likelyLatinOnly
		? "Latin-script; may be English, romanized Arabic/Urdu/Hindi, or code-switching"
		: "mixed or unclear";
	return {
		latestGuestTextSample: text.slice(0, 260),
		likelyDifferentFromPreferred,
		style,
		guidance: likelyRomanizedPreferredLanguage
			? "Treat this as possible romanized active-language text, such as Franko Arabic/Arabizi or Urdu/Hindi in Latin characters. Answer in the active response language."
			: likelyDifferentFromPreferred
			? "If the latest guest language is clear, the active response language should already reflect it. Answer in the active response language without asking permission to switch."
			: "Keep the response in the active response language and interpret dialect, transliteration, spelling mistakes, and code-switching from context.",
	};
}

function latestKnownConfirmation(sc = {}, lu = {}) {
	if (lu?.confirmation) return lu.confirmation;
	const conversation = Array.isArray(sc.conversation) ? sc.conversation : [];
	for (let i = conversation.length - 1; i >= 0; i -= 1) {
		const text = conversationEntryContextText(conversation[i]);
		const directMatch = confirmationFromText(text);
		if (directMatch) return directMatch;
		if (
			!/confirmation|confirm|reference|booking\s*(?:no|number|#)|reservation\s*(?:no|number|#)|\u062a\u0623\u0643\u064a\u062f|\u062d\u062c\u0632|\u0645\u0631\u062c\u0639|\u0643\u0648\u0646\u0641\u064a\u0631\u0645\u064a\u0634\u0646/i.test(text) &&
			!hasSemanticSignal(text, ["confirmation", "reservation"])
		) {
			continue;
		}
		const candidates =
			text.match(/\b(?:[A-Z]{1,6}[A-Z0-9-]{3,20}|\d{5,12})\b/gi) || [];
		const match = candidates.find(
			(candidate) =>
				/\d/.test(candidate) &&
				!/^(?:20\d{2}|1[34]\d{2}|15\d{2})$/.test(candidate) &&
				!confirmationLooksLikePhoneInText(text, candidate)
		);
		if (match) return match.toUpperCase();
	}
	return null;
}

function cleanConfirmationCandidate(candidate = "") {
	const value = digitsToEnglish(String(candidate || ""))
		.trim()
		.replace(/^[^\w]+|[^\w-]+$/g, "")
		.toUpperCase();
	if (!value || !/\d/.test(value)) return null;
	if (/^20\d{2}(?:-\d{2}-\d{2})?$/.test(value)) return null;
	if (/^(?:1[34]\d{2}|15\d{2})$/.test(value)) return null;
	return value;
}

function confirmationFromText(text = "") {
	const raw = String(text || "");
	const loose = raw.match(
		/\b(?:reservation|booking|confirmation|reference)\s*(?:number|no\.?|#|id)?\s*[:#-]?\s*(\d{5,12})\b/i
	);
	if (loose) {
		const candidate = cleanConfirmationCandidate(loose[1]);
		if (candidate && !confirmationLooksLikePhoneInText(raw, candidate)) return candidate;
	}
	const patterns = [
		/(?:confirmation|confirm(?:ation)?|reference|booking|reservation|reserva|r[e\u00e9]servation)\s*(?:number|no\.?|#|id|ref|num(?:ero|\u00e9ro)?|n[u\u00fa]mero)?\s*[:#-]?\s*([A-Z0-9][A-Z0-9-]{4,21})/gi,
		/(?:\u0631\u0642\u0645\s*(?:\u0627\u0644)?(?:\u062a\u0623\u0643\u064a\u062f|\u062a\u0627\u0643\u064a\u062f|\u062d\u062c\u0632|\u0645\u0631\u062c\u0639)|\u0627\u0644?\u062d\u062c\u0632\s*\u0631\u0642\u0645|\u062a\u0623\u0643\u064a\u062f\s*\u0631\u0642\u0645|\u062a\u0627\u0643\u064a\u062f\s*\u0631\u0642\u0645)\s*[:#-]?\s*([\d\u0660-\u0669\u06f0-\u06f9A-Z-]{5,22})/gi,
	];
	for (const pattern of patterns) {
		let match = null;
		while ((match = pattern.exec(raw))) {
			const candidate = cleanConfirmationCandidate(match[1]);
			if (candidate && !confirmationLooksLikePhoneInText(raw, candidate)) return candidate;
		}
	}
	if (hasSemanticSignal(raw, ["confirmation", "reservation"])) {
		const candidates = raw.match(/\b(?:[A-Z]{1,6}[A-Z0-9-]{3,20}|\d{5,12})\b/gi) || [];
		const match = candidates.find((candidate) => {
			const cleaned = cleanConfirmationCandidate(candidate);
			return cleaned && !confirmationLooksLikePhoneInText(raw, cleaned);
		});
		if (match) return cleanConfirmationCandidate(match);
	}
	return null;
}

async function handoffToHuman(io, sc, st, reason) {
	if (reason === "reservation_cancellation") {
		return answerCancellationRefundPolicyInquiry(io, sc, st, "", {}, {
			forceCancellation: true,
		});
	}
	const caseId = String(sc._id);
	const lang = languageOf(sc, st);
	const hotelName = st.hotel?.hotelName ? toTitle(st.hotel.hotelName) : "";
	const humanTeam = hotelName
		? `the ${hotelName} reception and reservations team`
		: "the Jannat Booking support team";
	let text =
		reason === "jannat_hotel_complaint"
			? `I am truly sorry this happened. Jannat Booking management will review this immediately, and action will be taken with the hotel team as needed.`
			: reason === "reservation_cancellation"
			? `I understand you want to review cancellation or refund policy. I will answer from the hotel policy directly here.`
			: reason === "abusive_guest"
			? `${humanTeam} will continue this conversation from here.`
			: reason === "reservation_finalize_failed"
			? `I could not finalize this reservation automatically. ${humanTeam} will take over from here and review it right away.`
			: reason === "reservation_finalize"
			? `I have the booking details needed to continue. ${humanTeam} will take over from here to verify the reservation and payment details before final confirmation.`
			: reason === "repeated_question"
			? `I want to make sure this is handled correctly, so ${humanTeam} will continue from here.`
			: `I understand you want to update an existing reservation. ${humanTeam} will take over from here so the change is reviewed correctly.`;
	if (/spanish/i.test(lang)) {
		text =
			reason === "jannat_hotel_complaint"
				? "Lamento mucho lo ocurrido. La administracion de Jannat Booking revisara esto de inmediato y tomara accion con el hotel si es necesario."
				: reason === "reservation_cancellation"
				? "Entiendo que quieres revisar la politica de cancelacion o reembolso. Te respondere directamente desde la politica del hotel."
				: reason === "abusive_guest"
				? "Un especialista de soporte continuara esta conversacion desde aqui."
				: reason === "reservation_finalize_failed"
				? "No pude finalizar esta reserva automaticamente. Un especialista de soporte tomara el chat para revisarla enseguida."
				: reason === "repeated_question"
				? "Quiero asegurarme de que esto se maneje correctamente, asi que un especialista de soporte continuara desde aqui."
				: "Entiendo tu solicitud de reserva. Un especialista de soporte tomara el chat para revisarla correctamente.";
	} else if (/french/i.test(lang)) {
		text =
			reason === "jannat_hotel_complaint"
				? "Je suis vraiment desole pour cette situation. La direction de Jannat Booking va l'examiner immediatement et prendre les mesures necessaires avec l'hotel."
				: reason === "reservation_cancellation"
				? "Je comprends que vous voulez verifier la politique d'annulation ou de remboursement. Je vais repondre directement a partir de la politique de l'hotel."
				: reason === "abusive_guest"
				? "Un specialiste du support va poursuivre cette conversation ici."
				: reason === "reservation_finalize_failed"
				? "Je n'ai pas pu finaliser cette reservation automatiquement. Un specialiste du support va la verifier tout de suite."
				: reason === "repeated_question"
				? "Je veux m'assurer que cela soit traite correctement, donc un specialiste du support va prendre le relais ici."
				: "Je comprends votre demande de reservation. Un specialiste du support va prendre le relais pour la verifier correctement.";
	} else if (/arabic/i.test(lang) && reason === "reservation_finalize_failed") {
		text =
			"\u062a\u0639\u0630\u0631 \u0625\u062a\u0645\u0627\u0645 \u0647\u0630\u0627 \u0627\u0644\u062d\u062c\u0632 \u062a\u0644\u0642\u0627\u0626\u064a\u0627. \u0633\u064a\u062a\u0627\u0628\u0639 \u0645\u0639\u0643 \u0623\u062d\u062f \u0645\u062e\u062a\u0635\u064a \u0627\u0644\u062f\u0639\u0645 \u0644\u0645\u0631\u0627\u062c\u0639\u062a\u0647 \u0641\u0648\u0631\u0627.";
	} else if (/arabic/i.test(lang)) {
		text =
			reason === "reservation_cancellation"
				? "\u0641\u0647\u0645\u062a \u0623\u0646\u0643 \u062a\u0631\u064a\u062f \u0645\u0631\u0627\u062c\u0639\u0629 \u0633\u064a\u0627\u0633\u0629 \u0627\u0644\u0625\u0644\u063a\u0627\u0621 \u0623\u0648 \u0627\u0644\u0627\u0633\u062a\u0631\u062f\u0627\u062f. \u0633\u0623\u062c\u064a\u0628\u0643 \u0645\u0628\u0627\u0634\u0631\u0629 \u0645\u0646 \u0633\u064a\u0627\u0633\u0629 \u0627\u0644\u0641\u0646\u062f\u0642."
				: "فهمت طلبك. سيتابع معك أحد مختصي الدعم من هنا.";
	}
	if (/arabic/i.test(lang) && reason === "repeated_question") {
		text =
			"\u0623\u0631\u064a\u062f \u0627\u0644\u062a\u0623\u0643\u062f \u0623\u0646 \u0637\u0644\u0628\u0643 \u064a\u062a\u0645 \u062a\u0648\u0644\u064a\u0647 \u0628\u0634\u0643\u0644 \u0635\u062d\u064a\u062d\u060c \u0644\u0630\u0644\u0643 \u0633\u064a\u062a\u0627\u0628\u0639 \u0645\u0639\u0643 \u0623\u062d\u062f \u0645\u062e\u062a\u0635\u064a \u0627\u0644\u062f\u0639\u0645 \u0645\u0646 \u0647\u0646\u0627.";
	}
	try {
		const learnedText = await write(
			io,
			sc,
			st,
			reason === "abusive_guest"
				? "The latest guest message is abusive or extremely rude. Do not argue, lecture, or mirror the language. Calmly state that a human support specialist will continue the conversation. Keep it one short sentence and do not ask another question."
				: reason === "jannat_hotel_complaint"
				? "The guest is making a complaint about a hotel or hotel experience through Jannat Booking support. Show sincere empathy, reassure them that Jannat Booking management has been urgently alerted, and say action will be taken with the hotel team as needed. Keep it professional, warm, and concise. Do not ask another question."
				: reason === "repeated_question"
				? "The guest has asked the same unresolved question three or more times. Apologize briefly if needed, say a human support specialist will continue so it is handled correctly, and do not ask another question. Keep it one short sentence."
				: "Tell the guest their request will be handled by a human support specialist. Keep it one short sentence, use the active hotel reception and reservations voice when hotel context exists, and do not ask another question.",
			{ handoffReason: reason, fallbackText: text }
		);
		if (learnedText) text = learnedText;
	} catch (error) {
		logStep(caseId, "handoff.write_failed", {
			message: error?.message || error,
			reason,
		});
	}
	const messageData = {
		messageBy: {
			customerName: st.agentName,
			customerEmail: AI_SUPPORT_EMAIL,
			userId: "jannat-ai-support",
		},
		message: text,
		date: new Date(),
		isAi: true,
		clientTag: aiMessageClientTag(caseId, "ai-handoff"),
	};
	const updatedCase = await updateSupportCaseAppend(caseId, {
		conversation: messageData,
		aiRelated: true,
		aiToRespond: false,
		aiPausedAt: new Date(),
		aiHandoffReason: reason,
		escalationStatus: "active",
		escalationReason: reason || "human_review_needed",
		escalationSource: "ai",
		escalatedAt: new Date(),
		escalatedBy: null,
		escalationAddressedAt: null,
		escalationAddressedBy: null,
		escalationAddressedNote: "",
	});
	io.to(caseId).emit("receiveMessage", { ...messageData, caseId });
	st.activeTurnHadReply = true;
	io.to(caseId).emit("aiPaused", { caseId, reason });
	if (updatedCase) {
		const escalationPayload = {
			case: updatedCase,
			caseId,
			escalationStatus: "active",
		};
		io.to(caseId).emit("supportCaseUpdated", updatedCase);
		io.emit("supportCaseUpdated", updatedCase);
		io.emit("supportCaseEscalated", escalationPayload);
		io.emit("supportCaseEscalationUpdated", escalationPayload);
	}
	if (reason === "jannat_hotel_complaint") {
		waNotifyImmediateSupportEscalation({
			caseId,
			guestName: sc.displayName1 || st.slots?.name || "Guest",
			hotelName: hotelName || "Jannat Booking support",
			reason,
		}).catch((error) => {
			console.error(
				"[aiagent] support escalation WhatsApp failed:",
				error?.message || error
			);
		});
	}
}

/* small helpers for smalltalk */
function looksLikeWellnessReply(s = "") {
	const t = s.toLowerCase();
	return /(i'?m\s+(good|fine|well|okay)|doing\s+well|al.?hamd|الحمد|كويس|تمام|بخير|great|awesome)/i.test(
		t
	);
}
function looksLikeClosureAck(s = "") {
	const t = s.toLowerCase();
	return /(that'?s\s+good|good|great|nice|تمام|حلو|كويس|جميل)/i.test(t);
}

function looksLikeSeriousSelfHarmText(s = "") {
	const { lower, arabic, latinCompact } = normalizeControlText(s);
	return (
		/\b(?:kill\s+myself|suicide|end\s+my\s+life|hurt\s+myself|harm\s+myself|i\s+do\s+not\s+want\s+to\s+live|i\s+don't\s+want\s+to\s+live)\b/i.test(
			lower
		) ||
		/(?:انتحار|انتحر|اقتل نفسي|اموت نفسي|اذي نفسي|أذي نفسي|مش عايز اعيش|لا اريد ان اعيش|لا أريد أن أعيش)/i.test(
			arabic
		) ||
		/(?:killmyself|suicide|endmylife|hurtmyself|harmmyself|dontwanttolive|donotwanttolive)/i.test(
			latinCompact
		)
	);
}

function arabicGuestDistressText(arabic = "") {
	return /(?:^|\s)(?:(?:\u0648\u0627\u0644\u0644\u0647|\u0627\u0646\u0627|\u0627\u0646\u064a|\u0625\u0646\u064a|\u062d\u0627\u0633\u0633|\u062d\u0627\u0633\u0647|\u062d\u0627\u0633\u0629)\s+)?(?:\u062d\u0632\u064a\u0646|\u062d\u0632\u064a\u0646\u0647|\u062d\u0632\u064a\u0646\u0629|\u0632\u0639\u0644\u0627\u0646|\u0632\u0639\u0644\u0627\u0646\u0647|\u0632\u0639\u0644\u0627\u0646\u0629|\u0645\u0636\u0627\u064a\u0642|\u0645\u0636\u0627\u064a\u0642\u0647|\u0645\u0636\u0627\u064a\u0642\u0629|\u0645\u062a\u0636\u0627\u064a\u0642|\u0645\u062a\u0636\u0627\u064a\u0642\u0647|\u0645\u062a\u0636\u0627\u064a\u0642\u0629|\u0645\u0643\u062a\u0626\u0628|\u0645\u0643\u062a\u0626\u0628\u0647|\u0645\u0643\u062a\u0626\u0628\u0629|\u0642\u0644\u0642\u0627\u0646|\u0642\u0644\u0642\u0627\u0646\u0647|\u0642\u0644\u0642\u0627\u0646\u0629|\u0645\u0647\u0645\u0648\u0645|\u0645\u0647\u0645\u0648\u0645\u0647|\u0645\u0647\u0645\u0648\u0645\u0629|\u062a\u0639\u0628\u0627\u0646|\u062a\u0639\u0628\u0627\u0646\u0647|\u062a\u0639\u0628\u0627\u0646\u0629)(?:\s|$)/i.test(
		String(arabic || "")
	);
}

function looksLikeGuestDistressText(s = "") {
	const raw = String(s || "").trim();
	if (!raw || raw.length > 220) return false;
	const { lower, arabic, latinCompact } = normalizeControlText(raw);
	return (
		looksLikeSeriousSelfHarmText(raw) ||
		arabicGuestDistressText(arabic) ||
		/\b(?:i\s+am|i'm|im|i\s+feel|i'm\s+feeling|feeling|feel)\s+(?:(?:so|very|really|a\s+little|a\s+bit|kind\s+of|kinda|slightly|somewhat)\s+)?(?:sad|upset|down|lonely|anxious|worried|stressed|depressed|heartbroken|not\s+okay)\b/i.test(
			lower
		) ||
		/^(?:sad|upset|lonely|depressed|not\s+okay|i'm\s+sad|im\s+sad|i\s+am\s+sad)[.!?\s]*$/i.test(
			lower
		) ||
		/(?:انا|اني|إني|انا\s+حاسس|انا\s+حاسه|انا\s+حاسة|انا\s+مش)\s+(?:حزين|حزينه|حزينة|زعلان|زعلانه|زعلانة|مضايق|مضايقه|مضايقة|متضايق|متضايقه|متضايقة|مكتئب|مكتئبه|مكتئبة|قلقان|قلقانه|قلقانة|مهموم|مهمومه|مهمومة|تعبان\s+نفسيا|تعبانه\s+نفسيا|نفسيتي\s+تعبانه|مش\s+كويس|مش\s+كويسه)/i.test(
			arabic
		) ||
		/^(?:حزين|حزينه|زعلان|زعلانه|مضايق|مضايقه|متضايق|متضايقه|مكتئب|مكتئبه|قلقان|قلقانه|مهموم|مهمومه)$/i.test(
			arabic
		) ||
		/(?:imsad|iamsad|ifeelsad|feelingsad|iamupset|imupset|feelingdown|iamlonely|imlonely|anahazin|anahazina|anazaalan|anazaalana|anazah2an|anamadaye2|nafseyatetaabana)/i.test(
			latinCompact
		)
	);
}

function emotionalSupportReplyText(sc = {}, st = {}, userText = "") {
	const name = respectfulGuestName(sc, st);
	const lang = languageOf(sc, st);
	const serious = looksLikeSeriousSelfHarmText(userText);
	if (serious) {
		if (/arabic/i.test(lang)) {
			return `${name}، آسفة جدًا أنك تمر بهذا الألم. إذا كان هناك خطر عليك الآن أو قد تؤذي نفسك، اتصل بالطوارئ فورًا أو اطلب من شخص قريب يبقى معك. أسأل الله أن يحفظك ويشرح صدرك، وأنا معك هنا خطوة بخطوة.`;
		}
		if (/urdu/i.test(lang)) {
			return `${name}, mujhe afsos hai ke aap itna dard mehsoos kar rahe hain. Agar abhi khatra ho ya aap khud ko nuqsan pahuncha sakte hain, please emergency help ko call karein ya kisi qareebi shakhs ko apne sath rakhein. Allah aap ki hifazat kare; main yahan aap ke sath hoon.`;
		}
		return `${name}, I am really sorry you are feeling this much pain. If you may hurt yourself or are in immediate danger, please call local emergency help now or ask someone nearby to stay with you. May Allah protect you and ease your heart; I am here with you step by step.`;
	}
	if (/arabic/i.test(lang)) {
		return `${name}، آسفة أنك تشعر بهذا الحزن. أسأل الله أن يشرح صدرك ويبدل ضيقك سكينة وراحة. أنا معك هنا، وإذا تحب احكِ لي ما يضايقك، أو نكمل مساعدتك في الإقامة خطوة بخطوة.`;
	}
	if (/spanish/i.test(lang)) {
		return `${name}, siento mucho que te sientas triste. Que Allah alivie tu corazon y te de tranquilidad. Estoy aqui contigo; si quieres, cuentame que paso, o seguimos con tu estancia paso a paso.`;
	}
	if (/french/i.test(lang)) {
		return `${name}, je suis desolee que vous vous sentiez triste. Qu'Allah apaise votre coeur et vous donne de la tranquillite. Je suis ici avec vous; dites-moi ce qui se passe, ou je continue a vous aider pour votre sejour pas a pas.`;
	}
	if (/urdu/i.test(lang)) {
		return `${name}, mujhe afsos hai ke aap udaas mehsoos kar rahe hain. Allah aap ke dil ko sukoon de aur pareshani ko asani mein badal de. Main yahan aap ke sath hoon; chahein to batayein kya hua, ya hum stay ki help step by step jari rakhte hain.`;
	}
	if (/hindi/i.test(lang)) {
		return `${name}, mujhe afsos hai ki aap udaas mehsoos kar rahe hain. Allah aapke dil ko sukoon de aur pareshani ko asani mein badal de. Main yahin hoon; chahein to batayein kya hua, ya main stay mein step by step help karti hoon.`;
	}
	if (/indonesian/i.test(lang)) {
		return `${name}, saya ikut sedih mendengarnya. Semoga Allah menenangkan hati Anda dan mengganti rasa berat ini dengan ketenangan. Saya di sini bersama Anda; jika berkenan, ceritakan apa yang terjadi, atau saya bantu rencana menginap Anda pelan-pelan.`;
	}
	if (/malay|malaysia/i.test(lang)) {
		return `${name}, saya simpati mendengarnya. Semoga Allah lapangkan hati anda dan gantikan rasa berat ini dengan ketenangan. Saya di sini bersama anda; jika mahu, ceritakan apa yang berlaku, atau saya bantu urusan penginapan langkah demi langkah.`;
	}
	return `${name}, I am sorry you are feeling sad. May Allah ease your heart and replace this heaviness with peace. I am here with you; if it helps, tell me what happened, or I can keep helping with your stay step by step.`;
}

function compactLearningChat(chat = {}) {
	const includeExamples =
		String(process.env.AI_LEARNING_INCLUDE_EXAMPLE_TURNS || "")
			.trim()
			.toLowerCase() === "true";
	const result = {
		sourceType: chat.sourceType || chat.source || "",
		title: chat.chatTitle || "",
		hotelName: chat.hotelName || "",
		language: chat.language || "",
		keywords: Array.isArray(chat.chatKeywords)
			? chat.chatKeywords.slice(0, 10)
			: [],
		relevanceScore: chat._relevanceScore || 0,
		signalMatches: chat._learningSignalMatches || 0,
		summary: chat.summary || "",
		customerIntent: chat.customerIntent || "",
		supportResolution: chat.supportResolution || "",
		learningNotes: Array.isArray(chat.learningNotes)
			? chat.learningNotes.slice(0, 6)
			: [],
		responseGuidance: Array.isArray(chat.responseGuidance)
			? chat.responseGuidance.slice(0, 6)
			: [],
		decisionRules: Array.isArray(chat.decisionRules)
			? chat.decisionRules.slice(0, 6)
			: [],
		recommendedResponses: Array.isArray(chat.recommendedResponses)
			? chat.recommendedResponses.slice(0, 4)
			: [],
		commonQuestions: Array.isArray(chat.commonQuestions)
			? chat.commonQuestions.slice(0, 6)
			: [],
		tags: Array.isArray(chat.tags) ? chat.tags.slice(0, 8) : [],
		qualityScore: chat.qualityScore || chat.confidenceScore || 0,
	};
	if (includeExamples) {
		result.exampleTurns = Array.isArray(chat.conversation)
			? chat.conversation.slice(0, 4).map((turn) => ({
					role: turn.role || "unknown",
					message: String(turn.message || "").slice(0, 180),
			  }))
			: [];
	}
	return result;
}

function compactPreviousGuestChat(supportCase = {}, st = {}) {
	const conversation = Array.isArray(supportCase.conversation)
		? supportCase.conversation
		: [];
	const hotelName =
		supportCase.hotelId?.hotelName ||
		supportCase.displayName2 ||
		st.hotel?.hotelName ||
		"";
	const firstMessage = conversation[0] || {};
	const recentTurns = conversation
		.filter((message) => message?.message && !message?.isSystem)
		.slice(-8)
		.map((message) => ({
			role: isAiConversationMessage(message) ? "support" : "guest",
			at: message.date || null,
			message: String(message.message || "").slice(0, 260),
		}));
	return {
		hotelName,
		caseStatus: supportCase.caseStatus || "",
		escalationStatus: supportCase.escalationStatus || "none",
		handoffReason: supportCase.aiHandoffReason || "",
		preferredLanguage: supportCase.preferredLanguage || "",
		updatedAt: supportCase.updatedAt || supportCase.createdAt || null,
		inquiryAbout: firstMessage.inquiryAbout || "",
		inquiryDetails: String(firstMessage.inquiryDetails || "").slice(0, 320),
		recentTurns,
	};
}

async function loadPreviousGuestContext(sc, st) {
	if (!AI_PREVIOUS_GUEST_CONTEXT_ENABLED) {
		return [];
	}
	const cacheKey = `${String(sc._id || "")}|${(sc.conversation || []).length}`;
	if (
		st.previousGuestContext &&
		st.previousGuestContext.cacheKey === cacheKey &&
		now() - st.previousGuestContext.loadedAt < 60000
	) {
		return st.previousGuestContext.items;
	}
	try {
		const previousCases = await listPreviousGuestSupportChats({
			supportCase: sc,
			limit: 4,
		});
		const items = previousCases.map((supportCase) =>
			compactPreviousGuestChat(supportCase, st)
		);
		st.previousGuestContext = {
			cacheKey,
			loadedAt: now(),
			items,
		};
		return items;
	} catch (error) {
		logStep(String(sc._id), "previous_chats.lookup_failed", {
			message: error?.message || error,
		});
		return [];
	}
}

async function loadLearningContext(sc, st, instruction, context = {}) {
	try {
		const firstConversationTurn = Array.isArray(sc.conversation)
			? sc.conversation[0] || {}
			: {};
		const lookupText = [
			lastUserText(sc),
			recentConversationLines(sc, st).slice(-8000),
			targetLanguageLabel(sc, st),
			sc.inquiryAbout || firstConversationTurn.inquiryAbout || "",
			sc.inquiryDetails || firstConversationTurn.inquiryDetails || "",
			instruction,
			JSON.stringify({
				waitFor: st.waitFor,
				slots: st.slots,
				preferredLanguage: targetLanguageLabel(sc, st),
				context,
			}).slice(0, 2000),
		].join("\n");
		const activeHotelId = st.hotel?._id || null;
		const chats = await listRelevantTrainingChats({
			hotelId: activeHotelId,
			includeGlobal: true,
			language: targetLanguageLabel(sc, st),
			text: lookupText,
			limit: 6,
		});
		return chats.map(compactLearningChat);
	} catch (error) {
		logStep(String(sc._id), "learning.lookup_failed", {
			message: error?.message || error,
		});
		return [];
	}
}

function fallbackWriterText(sc, st, instruction = "", context = {}, respectfulAddress = "Guest") {
	const hotelName = st.hotel?.hotelName ? toTitle(st.hotel.hotelName) : "";
	const supportDesk = hotelName
		? `${hotelName} reception and reservations`
		: "Jannat Booking support";
	const text = String(instruction || "").toLowerCase();
	const lang = languageOf(sc, st);
	const isArabic = /arabic/i.test(lang);
	const isSpanish = /spanish/i.test(lang);
	const isHindi = /hindi/i.test(lang);
	const isFrench = /french/i.test(lang);
	const isUrdu = /urdu/i.test(lang);
	const isIndonesian = /indonesian/i.test(lang);
	const isMalay = /malay|malaysia/i.test(lang);
	if (context.fallbackText) {
		const fallbackText = String(context.fallbackText);
		if (
			!isArabic &&
			!isSpanish &&
			!isHindi &&
			!isFrench &&
			!isUrdu &&
			!isIndonesian &&
			!isMalay
		) {
			return fallbackText;
		}
		if (!/human|handoff|specialist|escalat|handled by/i.test(text)) {
			return fallbackText;
		}
	}
	if (context.quote) return simpleQuoteText({ sc, st, quote: context.quote });
	if (/reservation review|review before we finalize|type confirm to finalize/.test(text)) {
		const total = context.totals?.totalPriceWithCommission || context.total || "";
		const currency = cleanCurrency(context.currency || st.quote?.data?.currency || "SAR");
		const room = context.room || roomTypeLabel(st.slots?.roomTypeKey);
		const hotel = context.hotel || toTitle(st.hotel?.hotelName || "Hotel");
		const gregorian = context.gregorian || {};
		const hijri = context.dateDisplay?.hijri || {};
		const dateLine =
			hijri?.checkin && hijri?.checkout
				? `${hijri.checkin} to ${hijri.checkout} (Gregorian: ${
						gregorian.checkin || usDate(st.slots?.checkinISO)
				  } to ${gregorian.checkout || usDate(st.slots?.checkoutISO)})`
				: `${gregorian.checkin || usDate(st.slots?.checkinISO)} to ${
						gregorian.checkout || usDate(st.slots?.checkoutISO)
				  }`;
		if (isArabic) {
			const dates = localizedStayDateLines(sc, st);
			const localizedTotal = total ? localizedMoney(total, currency, "Arabic") : "";
			return [
				`${respectfulAddress}\u060c \u0647\u0630\u0647 \u0645\u0631\u0627\u062c\u0639\u0629 \u0633\u0631\u064a\u0639\u0629 \u0644\u062a\u0641\u0627\u0635\u064a\u0644 \u0627\u0644\u062d\u062c\u0632:`,
				`\u0627\u0644\u0641\u0646\u062f\u0642: ${context.hotelLocalized || hotel}`,
				`\u0627\u0644\u063a\u0631\u0641\u0629: ${context.roomLocalized || room}`,
				`\u0627\u0644\u062a\u0648\u0627\u0631\u064a\u062e: ${dates.primary || dateLine}`,
				dates.secondary || "",
				localizedTotal ? `\u0627\u0644\u0625\u062c\u0645\u0627\u0644\u064a: ${localizedTotal}` : "",
				`\u0625\u0630\u0627 \u0643\u0644 \u0634\u064a\u0621 \u0635\u062d\u064a\u062d\u060c \u0627\u062e\u062a\u0631 "\u062a\u0623\u0643\u064a\u062f". \u0648\u0625\u0630\u0627 \u0647\u0646\u0627\u0643 \u0623\u064a \u062a\u0639\u062f\u064a\u0644\u060c \u0627\u062e\u062a\u0631 "\u0647\u0646\u0627\u0643 \u0634\u064a\u0621 \u063a\u064a\u0631 \u0635\u062d\u064a\u062d".`,
			]
				.filter(Boolean)
				.join("\n");
		}
		if (isIndonesian) {
			return [
				"Ringkasan reservasi:",
				`Hotel: ${hotel}`,
				`Kamar: ${room}`,
				`Tanggal: ${dateLine}`,
				total ? `Total: ${total} ${currency}` : "",
				"Pilih Konfirmasi jika sudah benar, atau Ada yang salah jika perlu diperbaiki.",
			]
				.filter(Boolean)
				.join("\n");
		}
		if (isMalay) {
			return [
				"Ringkasan tempahan:",
				`Hotel: ${hotel}`,
				`Bilik: ${room}`,
				`Tarikh: ${dateLine}`,
				total ? `Jumlah: ${total} ${currency}` : "",
				"Pilih Sahkan jika semuanya betul, atau Ada yang salah jika perlu diperbetulkan.",
			]
				.filter(Boolean)
				.join("\n");
		}
		return [
			"Reservation review:",
			`Hotel: ${hotel}`,
			`Room: ${room}`,
			`Dates: ${dateLine}`,
			total ? `Total: ${total} ${currency}` : "",
			"Choose Confirm if everything looks correct, or Something is wrong if we need to fix anything.",
		]
			.filter(Boolean)
			.join("\n");
	}
	if (/how about you|doing well/.test(text)) {
		if (isArabic) return `أنا بخير، شكرًا ${respectfulAddress}. وأنت كيف حالك؟`;
		if (isIndonesian) return `Saya baik, terima kasih ${respectfulAddress}. Bagaimana kabar Anda?`;
		if (isMalay) return `Saya baik, terima kasih ${respectfulAddress}. Apa khabar?`;
		return `I'm doing well, thank you ${respectfulAddress}. How about you?`;
	}
	if (/full name|passport/.test(text)) {
		if (isArabic) return `${respectfulAddress}، من فضلك اكتب الاسم الكامل للحجز باللغة الإنجليزية كما في جواز السفر.`;
		if (isIndonesian) return `${respectfulAddress}, mohon tulis nama lengkap untuk reservasi sesuai paspor.`;
		if (isMalay) return `${respectfulAddress}, sila tulis nama penuh untuk tempahan seperti dalam pasport.`;
		return `${respectfulAddress}, please type the full name for the reservation as it appears in the passport.`;
	}
	if (/nationality/.test(text)) {
		if (isArabic) return `${respectfulAddress}، ما جنسية الضيف؟ من فضلك اكتب اسم الدولة/الجنسية باللغة الإنجليزية.`;
		if (isIndonesian) return `${respectfulAddress}, apa kewarganegaraan atau negara tamu?`;
		if (isMalay) return `${respectfulAddress}, apakah kewarganegaraan atau negara tetamu?`;
		return `${respectfulAddress}, what is the guest's nationality or country name?`;
	}
	if (/phone|whatsapp|reachable/.test(text)) {
		if (isArabic) return `${respectfulAddress}، من فضلك أرسل رقم جوال يمكننا التواصل عليه. واتساب مفضل لكنه ليس إلزاميًا.`;
		if (isIndonesian) return `${respectfulAddress}, mohon kirim nomor telepon yang bisa dihubungi. WhatsApp lebih baik, tetapi tidak wajib.`;
		if (isMalay) return `${respectfulAddress}, sila hantarkan nombor telefon yang boleh dihubungi. WhatsApp digalakkan, tetapi tidak wajib.`;
		return `${respectfulAddress}, please share a reachable phone number. WhatsApp is preferred, but not mandatory.`;
	}
	if (/email address|type 'skip'|type skip|email/.test(text)) {
		if (isArabic) return `${respectfulAddress}، من فضلك أرسل البريد الإلكتروني لتفاصيل الحجز، أو اكتب skip إذا تفضل المتابعة بدونه.`;
		if (isIndonesian) return `${respectfulAddress}, mohon kirim alamat email untuk detail reservasi, atau ketik skip jika ingin lanjut tanpa email.`;
		if (isMalay) return `${respectfulAddress}, sila hantarkan alamat email untuk butiran tempahan, atau taip skip jika mahu teruskan tanpa email.`;
		return `${respectfulAddress}, please share an email address for the reservation details, or type skip if you prefer to continue without one.`;
	}
	if (/greet/.test(text)) {
		const opening = islamicGreetingForLanguage(sc, st);
		if (isArabic) return `${opening} ${respectfulAddress}\u060c \u0645\u0639\u0643 ${st.agentName} \u0645\u0646 ${supportDesk}. \u0643\u064a\u0641 \u0623\u0642\u062f\u0631 \u0623\u0633\u0627\u0639\u062f\u0643 \u0627\u0644\u064a\u0648\u0645\u061f`;
		if (isSpanish) return `${opening} ${respectfulAddress}, soy ${st.agentName} de ${supportDesk}. Como puedo ayudarte hoy?`;
		if (isHindi) return `${opening} ${respectfulAddress}, \u092e\u0948\u0902 ${supportDesk} \u0938\u0947 ${st.agentName} \u0939\u0942\u0902\u0964 \u092e\u0948\u0902 \u0906\u092a\u0915\u0940 \u0915\u093f\u0938 \u0924\u0930\u0939 \u092e\u0926\u0926 \u0915\u0930\u0942\u0902?`;
		if (isFrench) return `${opening} ${respectfulAddress}, je suis ${st.agentName} de ${supportDesk}. Comment puis-je vous aider aujourd'hui ?`;
		if (isUrdu) return `${opening} ${respectfulAddress}\u060c \u0645\u06cc\u06ba ${supportDesk} \u0633\u06d2 ${st.agentName} \u06c1\u0648\u06ba\u06d4 \u0645\u06cc\u06ba \u0622\u067e \u06a9\u06cc \u06a9\u06cc\u0633\u06d2 \u0645\u062f\u062f \u06a9\u0631 \u0633\u06a9\u062a\u0627 \u06c1\u0648\u06ba\u061f`;
		if (isIndonesian) return `${opening} ${respectfulAddress}, saya ${st.agentName} dari ${supportDesk}. Bagaimana saya bisa membantu hari ini?`;
		if (isMalay) return `${opening} ${respectfulAddress}, saya ${st.agentName} dari ${supportDesk}. Bagaimana saya boleh membantu hari ini?`;
		return `${opening} ${respectfulAddress}, this is ${st.agentName} from ${supportDesk}. How can I help you today?`;
	}
	if (/date|check-in|check.?in|checkout|check-out/.test(text)) {
		if (isArabic) return `${respectfulAddress}، من فضلك أرسل تاريخ الدخول وتاريخ الخروج لأراجع التوفر.`;
		if (isSpanish) return `${respectfulAddress}, por favor enviame las fechas de check-in y check-out para revisar disponibilidad.`;
		if (isHindi) return `${respectfulAddress}, कृपया चेक-इन और चेक-आउट की तारीखें भेजें ताकि मैं उपलब्धता देख सकूं।`;
		if (isFrench) return `${respectfulAddress}, veuillez envoyer les dates d'arrivee et de depart pour que je verifie la disponibilite.`;
		if (isUrdu) return `${respectfulAddress}، براہ کرم چیک اِن اور چیک آؤٹ کی تاریخیں بھیجیں تاکہ میں دستیابی چیک کر سکوں۔`;
		if (isIndonesian) return `${respectfulAddress}, mohon kirim tanggal check-in dan check-out agar saya bisa cek ketersediaan.`;
		if (isMalay) return `${respectfulAddress}, sila hantarkan tarikh check-in dan check-out supaya saya boleh semak ketersediaan.`;
		return `${respectfulAddress}, please send your check-in and checkout dates and I can check availability.`;
	}
	if (/room type/.test(text)) {
		const examples = Array.isArray(context.roomExamples)
			? context.roomExamples.filter(Boolean).slice(0, 4)
			: [];
		if (isArabic) {
			return examples.length
				? `${respectfulAddress}، أي نوع غرفة يناسبك؟ مثلاً: ${examples.join(" / ")}.`
				: `${respectfulAddress}، ما نوع الغرفة الذي تفضله؟`;
		}
		if (isSpanish) {
			return examples.length
				? `${respectfulAddress}, que tipo de habitacion prefieres? Por ejemplo: ${examples.join(" / ")}.`
				: `${respectfulAddress}, que tipo de habitacion prefieres?`;
		}
		if (isHindi) {
			return examples.length
				? `${respectfulAddress}, आपको कौन सा रूम टाइप चाहिए? उदाहरण: ${examples.join(" / ")}.`
				: `${respectfulAddress}, आपको कौन सा रूम टाइप चाहिए?`;
		}
		if (isFrench) {
			return examples.length
				? `${respectfulAddress}, quel type de chambre preferez-vous ? Par exemple : ${examples.join(" / ")}.`
				: `${respectfulAddress}, quel type de chambre preferez-vous ?`;
		}
		if (isUrdu) {
			return examples.length
				? `${respectfulAddress}، آپ کو کون سا کمرہ چاہیے؟ مثال کے طور پر: ${examples.join(" / ")}.`
				: `${respectfulAddress}، آپ کو کون سا کمرہ چاہیے؟`;
		}
		if (isIndonesian) {
			return examples.length
				? `${respectfulAddress}, jenis kamar mana yang paling sesuai? Contoh: ${examples.join(" / ")}.`
				: `${respectfulAddress}, jenis kamar mana yang Anda inginkan?`;
		}
		if (isMalay) {
			return examples.length
				? `${respectfulAddress}, jenis bilik mana yang paling sesuai? Contoh: ${examples.join(" / ")}.`
				: `${respectfulAddress}, jenis bilik mana yang anda mahukan?`;
		}
		return examples.length
			? `${respectfulAddress}, which room type suits you best? For example: ${examples.join(" / ")}.`
			: `${respectfulAddress}, which room type would you like?`;
	}
	if (/payment/.test(text)) {
		if (isArabic) return `${respectfulAddress}، أقدر أساعدك في مشكلة الدفع. أرسل رقم التأكيد أو رابط الدفع فقط، ولا ترسل أي بيانات بطاقة.`;
		if (isSpanish) return `${respectfulAddress}, puedo ayudarte con el pago. Enviame el numero de confirmacion o el enlace de pago, pero no datos de tarjeta.`;
		if (isHindi) return `${respectfulAddress}, मैं भुगतान की समस्या में मदद कर सकता हूं। कृपया कन्फर्मेशन नंबर या पेमेंट लिंक भेजें, कार्ड की जानकारी नहीं।`;
		if (isFrench) return `${respectfulAddress}, je peux vous aider pour le paiement. Envoyez le numero de confirmation ou le lien de paiement, mais pas de donnees de carte.`;
		if (isUrdu) return `${respectfulAddress}، میں ادائیگی کے مسئلے میں مدد کر سکتا ہوں۔ براہ کرم کنفرمیشن نمبر یا پیمنٹ لنک بھیجیں، کارڈ کی معلومات نہیں۔`;
		if (isIndonesian) return `${respectfulAddress}, saya bisa membantu masalah pembayaran. Mohon kirim nomor konfirmasi atau link pembayaran, tetapi jangan kirim detail kartu.`;
		if (isMalay) return `${respectfulAddress}, saya boleh membantu isu pembayaran. Sila hantar nombor pengesahan atau pautan pembayaran, tetapi jangan hantar butiran kad.`;
		return `${respectfulAddress}, I can help with the payment issue. Please send the confirmation number or payment link, but not card details.`;
	}
	if (/reservation|confirmation/.test(text)) {
		if (isArabic) return `${respectfulAddress}، من فضلك أرسل رقم التأكيد والتغيير المطلوب في الحجز.`;
		if (isSpanish) return `${respectfulAddress}, por favor enviame el numero de confirmacion y que cambio necesitas.`;
		if (isHindi) return `${respectfulAddress}, कृपया कन्फर्मेशन नंबर और बताएं कि आप क्या बदलना चाहते हैं।`;
		if (isFrench) return `${respectfulAddress}, veuillez envoyer le numero de confirmation et le changement souhaite.`;
		if (isUrdu) return `${respectfulAddress}، براہ کرم کنفرمیشن نمبر اور مطلوبہ تبدیلی بھیجیں۔`;
		if (isIndonesian) return `${respectfulAddress}, mohon kirim nomor konfirmasi dan perubahan yang Anda inginkan.`;
		if (isMalay) return `${respectfulAddress}, sila hantarkan nombor pengesahan dan perubahan yang anda mahukan.`;
		return `${respectfulAddress}, please send the confirmation number and what you would like to update.`;
	}
	if (/human|handoff|specialist|escalat/.test(text)) {
		if (isArabic) return `${respectfulAddress}، سيتابع معك أحد مختصي الدعم من هنا.`;
		if (isSpanish) return `${respectfulAddress}, un especialista de soporte continuara contigo desde aqui.`;
		if (isHindi) return `${respectfulAddress}, अब हमारी सपोर्ट टीम का विशेषज्ञ आपकी मदद जारी रखेगा।`;
		if (isFrench) return `${respectfulAddress}, un specialiste du support va poursuivre avec vous ici.`;
		if (isUrdu) return `${respectfulAddress}، اب سپورٹ ٹیم کا ایک ماہر آپ کے ساتھ بات جاری رکھے گا۔`;
		if (isIndonesian) return `${respectfulAddress}, spesialis dukungan akan melanjutkan bantuan dari sini.`;
		if (isMalay) return `${respectfulAddress}, pakar sokongan akan meneruskan bantuan dari sini.`;
		return `${respectfulAddress}, a support specialist will continue with you from here.`;
	}
	if (isArabic) return `${respectfulAddress}، أقدر أساعدك. هل يمكنك إرسال تفاصيل أكثر؟`;
	if (isSpanish) return `${respectfulAddress}, puedo ayudarte con eso. Puedes enviarme un poco mas de detalle?`;
	if (isHindi) return `${respectfulAddress}, मैं इसमें मदद कर सकता हूं। कृपया थोड़ा और विवरण भेजें।`;
	if (isFrench) return `${respectfulAddress}, je peux vous aider. Pouvez-vous envoyer un peu plus de details ?`;
	if (isUrdu) return `${respectfulAddress}، میں مدد کر سکتا ہوں۔ براہ کرم تھوڑی مزید تفصیل بھیجیں۔`;
	if (isIndonesian) return `${respectfulAddress}, saya bisa membantu. Mohon kirim sedikit detail tambahan.`;
	if (isMalay) return `${respectfulAddress}, saya boleh membantu. Sila hantarkan sedikit butiran tambahan.`;
	return `${respectfulAddress}, I can help with that. Could you share a little more detail?`;
}

function languageMismatchLikely(answer = "", targetLanguage = "") {
	const text = String(answer || "").trim();
	const lang = String(targetLanguage || "").toLowerCase();
	if (!text || !lang) return false;
	if (/arabic|urdu/.test(lang)) return !/[\u0600-\u06FF]/.test(text);
	if (/hindi/.test(lang)) return !/[\u0900-\u097F]/.test(text);
	if (/spanish/.test(lang)) {
		const looksEnglish =
			/\b(the|please|could|would|check-in|checkout|reservation|support|payment|confirm)\b/i.test(
				text
			);
		const looksSpanish =
			/\b(hola|por favor|reserva|habitaci[oó]n|fechas|gracias|puedo|necesitas|confirmaci[oó]n|pago|soporte)\b/i.test(
				text
			);
		return looksEnglish && !looksSpanish;
	}
	if (/french/.test(lang)) {
		const looksEnglish =
			/\b(the|please|could|would|check-in|checkout|reservation|support|payment|confirm)\b/i.test(
				text
			);
		const looksFrench =
			/\b(bonjour|merci|reservation|chambre|dates|paiement|veuillez|support|confirmer)\b/i.test(
				text
			);
		return looksEnglish && !looksFrench;
	}
	if (/indonesian/.test(lang)) {
		const looksEnglish =
			/\b(the|please|could|would|check-in|checkout|reservation|support|payment|confirm)\b/i.test(
				text
			);
		const looksIndonesian =
			/\b(halo|terima kasih|kamar|tanggal|reservasi|pembayaran|mohon|bisa|silakan|konfirmasi)\b/i.test(
				text
			);
		return looksEnglish && !looksIndonesian;
	}
	if (/malay|malaysia/.test(lang)) {
		const looksEnglish =
			/\b(the|please|could|would|check-in|checkout|reservation|support|payment|confirm)\b/i.test(
				text
			);
		const looksMalay =
			/\b(halo|terima kasih|bilik|tarikh|tempahan|pembayaran|sila|boleh|pengesahan|pautan)\b/i.test(
				text
			);
		return looksEnglish && !looksMalay;
	}
	return false;
}

/* LLM writer */
async function write(io, sc, st, instruction, context = {}) {
	const guestProfile = respectfulGuestProfile(sc, st);
	const respectfulAddress = guestProfile.address;
	const hotelName = st.hotel?.hotelName ? toTitle(st.hotel.hotelName) : "";
	const activeHotelFacts = buildActiveHotelFacts(sc, st);
	const targetLanguage = languageOf(sc, st) || "English";
	const targetLanguageCode = activeLanguageCodeOf(sc, st);
	const targetLanguageText = targetLanguageCode
		? `${targetLanguage} (${targetLanguageCode})`
		: targetLanguage;
	st.language = targetLanguage;
	const languageStyle = latestGuestLanguageStyle(sc, targetLanguageText);
	const [learningContext, previousGuestContext] = await Promise.all([
		loadLearningContext(sc, st, instruction, context),
		loadPreviousGuestContext(sc, st),
	]);
	const alreadyIntroduced =
		st.greeted || Boolean(st.lastBotText) || hasAiAssistantReply(sc);
	const introRule = alreadyIntroduced
		? `You already introduced yourself earlier in this chat. Do not start with "I'm ${st.agentName}" or repeat the reception/reservations desk title unless the guest directly asks who you are.`
		: hotelName
		? `For the first greeting only, introduce yourself as ${st.agentName} from ${hotelName} reception and reservations. Do not introduce yourself as Jannat Booking or XHotelPro.`
		: `For the first greeting only, introduce yourself as ${st.agentName} from Jannat Booking support.`;
	const aiIdentityRule = hotelName
		? `If asked directly whether you are AI, say you are AI-assisted ${hotelName} reception and reservations support monitored by the hotel team; do not claim to be human.`
		: `If asked directly whether you are AI, say you are AI-assisted Jannat Booking support monitored by Jannat Booking admins; do not claim to be human.`;
	const sys = [
		hotelName
			? `You are ${st.agentName}, the reception and reservations representative for "${hotelName}".`
			: `You are ${st.agentName} from Jannat Booking support.`,
		introRule,
		hotelName
			? `In active hotel reception replies, do not mention Jannat Booking unless a supplied platform, payment, or final verification context explicitly requires it. If it must be named, write the brand exactly as "Jannat Booking"; do not translate or shorten it.`
			: `If Jannat Booking must be named, write the brand exactly as "Jannat Booking"; do not translate or shorten it.`,
		aiIdentityRule,
		hotelName
			? `Speak as the hotel's own reception and reservations desk. The guest should feel they are speaking directly with reception, not a separate middleman.`
			: `Represent Jannat Booking directly.`,
		`The guest's active response language is ${targetLanguageText}. This may override the frontend preferred language when the latest guest message is clearly in another language.`,
		`STRICT LANGUAGE RULE: Every customer-facing word in your final answer must be in ${targetLanguage}.`,
		`For the first message in a new chat, start with a readable Islamic greeting before the guest name: Arabic "\u0627\u0644\u0633\u0644\u0627\u0645 \u0639\u0644\u064a\u0643\u0645", Urdu "\u0627\u0644\u0633\u0644\u0627\u0645 \u0639\u0644\u06cc\u06a9\u0645", Hindi "\u0905\u0938\u094d\u0938\u0932\u093e\u092e\u0941 \u0905\u0932\u0948\u0915\u0941\u092e", Indonesian/Malay "Assalamualaikum", and other Latin-script languages "Assalamu alaikum". Treat this as the approved platform salutation, then keep the rest of the reply in ${targetLanguage}. Do not use Arabizi numerals like "3" for ayn.`,
		/arabic/i.test(targetLanguage)
			? `Arabic output rule: use natural Arabic hospitality wording. Do not write English commands such as "confirm" or "skip"; use "\u062a\u0623\u0643\u064a\u062f" and "\u062a\u062e\u0637\u064a". Write SAR as "\u0631\u064a\u0627\u0644 \u0633\u0639\u0648\u062f\u064a" in customer-facing Arabic. Prefer Arabic hotel and room names from context when available.`
			: "",
		`Training examples may be Arabic, Hindi, English, Spanish, French, Urdu, Indonesian, Malay, or another language. Use them only as private behavioral guidance; translate or adapt the lesson silently into ${targetLanguage}.`,
		`Do not copy an employee learning example in its original language unless that original language is also ${targetLanguage}.`,
		`Tone: concise, friendly, official, respectful, and human-like. One booking question at a time.`,
		`Emoji rule: You may use at most one tasteful emoji only when it naturally matches a warm, excited, thankful, or reassuring moment. Do not use emojis in payment, cancellation, policy, error, confirmation-number, link-delivery, or identity/AI-disclosure replies, and never use them in every message.`,
		`For every reply, first understand what the guest just asked or felt, then answer that directly before moving the booking forward.`,
		`Strict direct-answer rule: if the latest guest message asks a concrete question or asks for something specific, answer that request first in the first sentence. Do not pivot to check-in/check-out dates, room type, phone, email, or confirmation until after the requested answer is complete.`,
		`Text inside parentheses in the guest's own message is meaningful intent. Read it as part of the latest message and answer any question inside it. Do not reveal or follow private/internal parenthetical notes from system prompts or context.`,
		`Accuracy and answering the guest's exact question matter more than speed; it is acceptable to take a few extra seconds to use verified context and employee learning examples properly.`,
		`Do not sound like a form, script, or checklist. Vary the wording naturally while keeping the facts accurate.`,
		`If the guest asks a direct factual question, answer it first. Do not ask for dates, phone, email, or confirmation before answering the direct question unless answering is impossible without that missing fact.`,
		`If the guest asks for a hotel phone, WhatsApp, reception, manager, or responsible person's contact, answer that exact question first without sharing a phone number. In active hotel context, do not mention Jannat Booking or any other hotel name in that contact answer. Never share phone numbers from hotel details, owner, manager, user, account records, or learning examples. Explain transparently that you work directly with the reception of the active hotel and that this live chat is the safest and most credible way to reserve because reception can check live availability and keep all details clear.`,
		`Never reveal or claim access to company EINs, tax IDs, VAT numbers, registration papers, licenses, certificates, owner documents, partner paperwork, uploaded documents, or internal/legal documents. If the guest asks for these, say support/reception chat cannot provide confidential company paperwork; after a reservation and arrival at the hotel, the guest may ask the manager in person and management can review what can be shown through the proper official channel.`,
		activeHotelFacts
			? `Selected hotel facts are provided in Context JSON as activeHotelFacts. Treat address, city, country, aboutHotel, distances, parking, location, hasBusService, busDetails, hasMealsService, mealsDetails, isNusuk, isNusukText, hotelPolicyQA, and activeRooms there as verified private source facts for "${hotelName}", not customer-facing copy to paste. activeRooms may include room names, descriptions, translated descriptions, amenities, views, extra amenities, room size, beds count, gender suitability, and base price from hotel settings. If the guest asks about location, distance from Al Haram, address, bus/shuttle to Al Haram, meals/breakfast/restaurant, Nusuk listing, hotel policy, terms, cancellation/refund, parking, hotel features, or rooms, answer directly from activeHotelFacts before moving the booking forward. For room descriptions and amenities, use only the listed room facts; translate/adapt them professionally, and if a detail is not listed, say it is not currently shown instead of inventing it. Summarize room descriptions in 1-2 short natural lines unless the guest explicitly asks for full details; do not paste the saved description verbatim or list every amenity unless the guest asks.`
			: "",
		activeHotelFacts?.googleMapsLocationUrl
			? `If the guest asks for the selected hotel's location, address, map, or to send the location, include this exact markdown link in the reply after the address/location answer: [Hotel location on Google Maps](${activeHotelFacts.googleMapsLocationUrl}). This URL uses the hotel's exact stored coordinates. Use activeHotelFacts.googleMapsDrivingDirectionsUrl only when the guest explicitly asks for a route or directions to Al Haram. Do not invent or rewrite map coordinates.`
			: "",
		activeHotelFacts
			? `When using activeHotelFacts, write as "${hotelName}" reception. Translate and adapt raw hotel-detail text into ${targetLanguage}; clean grammar, remove duplicate yes/no wording, and make it sound like professional hotel customer service. For hotelPolicyQA, answer from the saved question/answer text only, without adding links or unsupported exceptions. If source wording is needed, prefer "Based on the hotel's terms and conditions" or equivalent in ${targetLanguage}. Do not say or imply "I checked", "I found", "document", "the schema", "records", "owner added", "registered from the hotel", "hotel details say", or any similar database/source label.`
			: "",
		activeHotelFacts
			? `If activeHotelFacts.distances has walkingToElHaram or drivingToElHaram and the guest asks how far the hotel is from Al Haram, say the walking/driving minutes directly and naturally. Do not deflect to review, dates, phone, email, or confirmation before answering the distance.`
			: "",
		activeHotelFacts
			? `If the guest asks about bus/shuttle service to Al Haram, use only activeHotelFacts.hasBusService and activeHotelFacts.busDetails. If hasBusService is true, answer yes as hotel reception and rewrite/translate busDetails naturally as our guest bus information without inventing schedules, stations, timing, or destinations. If hasBusService is false or missing, say we do not currently offer a private bus service, mention walking minutes from activeHotelFacts.distances.walkingToElHaram when available, and say public buses are available close to the hotel and can drop guests at Al Haram.`
			: "",
		activeHotelFacts
			? `If the guest asks about meals, breakfast, food, dining, buffet, or restaurant service inside the selected hotel, use only activeHotelFacts.hasMealsService and activeHotelFacts.mealsDetails before hotelPolicyQA or aboutHotel. If hasMealsService is true, answer yes and rewrite/translate mealsDetails naturally without inventing meal times, menus, inclusions, prices, or restaurant names. If hasMealsService is false or missing, say in-hotel meals are not currently shown as provided, then keep the next reservation step helpful. Do not turn a shared kitchen mention into a meal service.`
			: "",
		activeHotelFacts
			? `If the guest asks whether the selected hotel is listed, registered, or available on Nusuk, use only activeHotelFacts.isNusuk and activeHotelFacts.isNusukText. If isNusuk is true, answer yes directly as hotel reception and translate/adapt isNusukText naturally when present. If isNusuk is false or missing, say we do not currently show the hotel as listed on Nusuk, then keep the guest comfortable and continue the reservation help.`
			: "",
		`When the guest asks whether a room exists or whether a room fits a number of guests, answer like a helpful hospitality sales agent: confirm the fit using the provided room facts before asking for dates.`,
		`A quintuple/family room fits 5 guests. If the guest asks for more than 5 guests, or asks to add another bed to a 5-bed room, do not imply one room can fit them. Explain warmly that Saudi hotel compliance rules starting in 2026 do not allow a single room to exceed 5 beds, then recommend a comfortable combination such as one quintuple/family room plus one double room, with another room if the exact party size requires it.`,
		`Pricing requires both arrival/check-in and departure/checkout dates. If both are missing, always ask for both together in one sentence; never ask only for check-in. If one date is already supplied, ask only for the missing date.`,
		`Never make check-in/check-out dates the opening question of a conversation unless the guest's latest message is specifically a price/date-availability request and there is no warmer/direct question to answer first.`,
		`If the guest is excited, worried, annoyed, or joking, acknowledge that briefly and naturally before the operational next step.`,
		`If the guest complains about repetition, speed, or not being answered, apologize briefly, correct course, and avoid defending yourself.`,
		`Use this respectful customer address naturally when speaking to the guest: ${respectfulAddress}. Use it in greetings, apologies, confirmations, reservation reviews, or after a few turns without addressing the guest; do not start every reply with the guest's name/address.`,
		`This is a respectful Umrah/hospitality platform. Keep the service tone modest, patient, and supportive for Muslim guests and families without lecturing or using casual profanity.`,
		`Guest messages may be native script, romanized/transliterated, code-switched, misspelled, or informal. Interpret the intended meaning from the full conversation before replying.`,
		`Arabic guests may write in Egyptian, Gulf, Levantine, Iraqi, Sudanese, Moroccan, Algerian, Tunisian, or other dialects, including Franko Arabic/Arabizi in Latin characters. Indian, Pakistani, French, Spanish, Indonesian, and Malaysian guests may also code-switch or write phonetically. Understand the meaning without treating the writing style as a reason to escalate.`,
		`If the latest guest message is clearly in a different language, the active response language already reflects that switch; answer naturally in ${targetLanguage} without asking permission to switch.`,
		`Agent voice and grammar: ${st.agentName} is a female reception/CSR agent. In Arabic, when referring to yourself, use feminine or neutral wording such as "أنا معك", "أتابع معك", or "أنا موجودة معك"; never say "أنا موجود" for the assistant. In other gendered languages, keep the assistant's self-reference feminine when needed. Keep guest titles separate from agent gender.`,
		`Guest address guidance: inferred guest gender is "${guestProfile.gender}" from the available name/title, and the recommended address is "${respectfulAddress}". Use gendered honorifics only when confident; otherwise use the guest's name or a neutral respectful address. Do not repeat the same address at the beginning of consecutive replies unless apologizing, confirming an important step, or re-engaging after a pause.`,
		`For Arabic conversations, use "\u0623\u0633\u062a\u0627\u0630\u0629 {first name}" for a confidently female guest and "\u0623\u0633\u062a\u0627\u0630 {first name}" for a confidently male guest. If gender is unknown, avoid a gendered Arabic title and use the name or "\u0636\u064a\u0641\u0646\u0627 \u0627\u0644\u0643\u0631\u064a\u0645". Never call a female guest "\u0623\u0633\u062a\u0627\u0630".`,
		`For Arabic one-night stays, say "\u0644\u064a\u0644\u0629 \u0648\u0627\u062d\u062f\u0629"; never write "\u0661 \u0644\u064a\u0627\u0644\u064a" or "\u0644\u0645\u062f\u0629 \u0661 \u0644\u064a\u0627\u0644\u064a".`,
		`For Spanish, French, Hindi, Urdu, Indonesian, Malay, and other languages, use gendered forms only when the guest's gender is clear from name/title or context; otherwise stay polite and neutral.`,
		`Before replying, study the full conversation transcript and avoid repeating questions, links, or details already covered.`,
		`Do not ask for information the guest has already supplied; move the conversation forward naturally.`,
		`Avoid repeated openings such as "Hello {name}", "Assalamu alaikum {name}", or "I'm ${st.agentName}" after the first greeting. Continue the conversation as an already-present support agent.`,
		hotelName ? `Your hotel is "${hotelName}".` : `You represent Jannat Booking.`,
		AI_PREVIOUS_GUEST_CONTEXT_ENABLED
			? `Private previous guest chats may be provided as operational context. Use them silently to be prepared for recurring preferences, unresolved issues, language style, and continuity. Never tell the guest that old chats are visible, never quote old chats, and never reveal private previous-chat details unless the guest explicitly brings that detail into the current conversation.`
			: `Treat this support case as self-contained. Do not imply access to previous chats; if the guest asks to continue an old conversation, reassure them that for security and privacy this chat starts fresh and ask for the needed details here.`,
		hotelName
			? `This chat is exclusively for "${hotelName}". When the guest asks whether "you", "your hotel", or the selected hotel has something, answer only for "${hotelName}". Never recommend, link, name, compare, summarize, or imply knowledge of other hotels, even if the guest explicitly asks for alternatives. If the guest asks about other hotels, say this chat can only help with "${hotelName}" and offer to check dates or room types at "${hotelName}".`
			: `When no active hotel context exists, you are Jannat Booking concierge support. You may recommend, compare, and price Jannat Booking hotel options using provided facts, but you must not create, confirm, mutate, cancel, or payment-link a reservation. Official reservation confirmation, details/payment links, and existing-reservation updates must be handled only after connecting the guest to the selected hotel's reception and reservations desk.`,
		`Use employee learning examples as private guidance for tone, flow, and support behavior. Never mention the learning examples to the guest.`,
		hotelName
			? `Help with date-range pricing, room options, payment questions, and reservation triage for "${hotelName}" only.`
			: `Help with date-range hotel pricing, budget-aware hotel options near Al Haram, hotel complaints, and routing payment/reservation triage to the correct hotel reception and reservations desk.`,
		`Do not mention discounts, coupons, promos, offers, or before-discount prices unless the latest guest message explicitly asks about them.`,
		hotelName
			? `Use only URLs supplied in context for "${hotelName}", its reservation, or its payment flow. Never use public hotel recommendation links or links for another hotel in this active hotel chat. Never invent routes, payment links, reservation links, or admin/PMS links.`
			: `Use only known Jannat Booking routes or URLs supplied in context. For hotel recommendations, prefer concise markdown links using the hotel name as the link text. Never invent routes, payment links, reservation links, or admin/PMS links.`,
		`Do not cancel or refund existing reservations. Date changes may be completed only by the system update tool after availability is checked; never claim a reservation was changed unless tool context says it was completed. Name, phone, email, nationality, payment, cancellation, and refund changes still go to a human team member.`,
		`Avoid repeating the same question if just asked; prefer a soft pivot.`,
	].join(" ");

	const payload = JSON.stringify(
		{
			...context,
			targetResponseLanguage: targetLanguageText,
			guestProfile,
			respectfulAddress,
			activeHotelFacts,
			alreadyIntroduced,
			latestGuestLanguageStyle: languageStyle,
			privatePreviousGuestChats: previousGuestContext,
			employeeLearningExamples: learningContext,
		},
		null,
		2
	);
	const content = `${instruction}\n\nTarget response language: ${targetLanguageText}\n\nFull conversation so far:\n${
		recentConversationLines(sc, st) || "(empty)"
	}\n\nContext JSON:\n${payload}`;

	let answer = "";
	try {
		answer = await chat(
			[
				{ role: "system", content: sys },
				{ role: "user", content },
			],
			{
				kind: "writer",
				temperature: 0.25,
				max_tokens: 220,
			}
		);
	} catch (error) {
		logStep(String(sc._id), "llm.write_failed", {
			instruction,
			message: error?.message || error,
		});
		answer = fallbackWriterText(sc, st, instruction, context, respectfulAddress);
	}
	if (!answer) {
		answer = fallbackWriterText(sc, st, instruction, context, respectfulAddress);
	}
	if (languageMismatchLikely(answer, targetLanguage)) {
		try {
			const rewritten = await chat(
				[
					{
						role: "system",
						content: `Rewrite the assistant answer strictly in ${targetLanguage}. Preserve the meaning, hotel names, prices, dates, links, and brand names. Output only the rewritten answer.`,
					},
					{ role: "user", content: answer },
				],
				{
					kind: "writer",
					temperature: 0,
					max_tokens: 220,
				}
			);
			if (rewritten && !languageMismatchLikely(rewritten, targetLanguage)) {
				answer = rewritten;
			}
		} catch (error) {
			logStep(String(sc._id), "llm.language_rewrite_failed", {
				targetLanguage,
				message: error?.message || error,
			});
		}
	}

	logStep(String(sc._id), "llm.write", { instruction, outLen: answer.length });
	return answer;
}

function fallbackSupportDecision(userText = "", st = {}, lu = {}) {
	const handoffReason = humanHandoffReason(userText);
	if (handoffReason === "reservation_cancellation") {
		return { action: "reservation_cancellation", roomTypeKey: null, reason: handoffReason };
	}
	if (handoffReason === "reservation_update") {
		return { action: "reservation_update", roomTypeKey: null, reason: handoffReason };
	}
	if (wantsDiscountQuestion(userText)) {
		return { action: "discount_question", roomTypeKey: null, reason: "discount_keyword" };
	}
	if (confidentialCompanyDocumentQuestionText(userText)) {
		return {
			action: "general_answer",
			roomTypeKey: lu.roomTypeKey || st.slots?.roomTypeKey || null,
			scope: st.hotel ? "selected_hotel" : "platform",
			reason: "confidential_company_document_question",
		};
	}
	if (liveCurrentGeneralQuestionText(userText)) {
		return {
			action: "general_answer",
			roomTypeKey: lu.roomTypeKey || st.slots?.roomTypeKey || null,
			scope: st.hotel ? "selected_hotel" : "platform",
			reason: "live_current_general_question",
		};
	}
	if (wantsPaymentHelp(userText)) {
		return { action: "payment_help", roomTypeKey: null, reason: "payment_keyword" };
	}
	if (st.hotel && directHotelRelationshipQuestionText(userText)) {
		return {
			action: "general_answer",
			roomTypeKey: lu.roomTypeKey || st.slots?.roomTypeKey || null,
			scope: "selected_hotel",
			reason: "direct_hotel_relationship_question",
		};
	}
	if (hotelContactDetailsQuestionText(userText)) {
		return {
			action: "general_answer",
			roomTypeKey: lu.roomTypeKey || st.slots?.roomTypeKey || null,
			scope: st.hotel ? "selected_hotel" : null,
			reason: "hotel_contact_question",
		};
	}
	if (st.hotel && selectedHotelFactQuestionText(userText)) {
		return {
			action: "general_answer",
			roomTypeKey: lu.roomTypeKey || st.slots?.roomTypeKey || null,
			scope: "selected_hotel",
			reason: "selected_hotel_fact_question",
		};
	}
	if (st.hotel && selectedHotelRoomQuestionText(userText)) {
		return {
			action: "general_answer",
			roomTypeKey:
				lu.roomTypeKey || mapRoomToKey(userText) || st.slots?.roomTypeKey || null,
			scope: "selected_hotel",
			reason: "selected_hotel_room_question",
		};
	}
	if (broadGeneralSupportQuestionText(userText, st, lu) || genericOpenAiQuestionText(userText, st, lu)) {
		return {
			action: "general_answer",
			roomTypeKey: lu.roomTypeKey || st.slots?.roomTypeKey || null,
			scope: st.hotel ? "selected_hotel" : "platform",
			reason: "generic_openai_question",
		};
	}
	if (st.hotel && crossHotelRequestText(userText)) {
		return {
			action: "support_email",
			roomTypeKey: lu.roomTypeKey || st.slots?.roomTypeKey || null,
			scope: "selected_hotel",
			reason: "hotel_scope_boundary",
		};
	}
	if (
		isNewReservationFlowActive(st) &&
		wantsReservationHelp(userText) &&
		!lu?.confirmation &&
		!explicitlyExistingReservationIntent(userText)
	) {
		return {
			action: "continue_booking",
			roomTypeKey: lu.roomTypeKey || st.slots?.roomTypeKey || null,
			scope: st.hotel ? "selected_hotel" : null,
			reason: "new_reservation_flow_active",
		};
	}
	if (wantsNewReservationIntent(userText, lu)) {
		return {
			action: "continue_booking",
			roomTypeKey: lu.roomTypeKey || st.slots?.roomTypeKey || null,
			scope: st.hotel ? "selected_hotel" : null,
			reason: "new_reservation_intent",
		};
	}
	if (wantsReservationHelp(userText)) {
		return { action: "reservation_lookup", roomTypeKey: null, scope: null, reason: "reservation_keyword" };
	}
	if (!st.hotel && wantsHotelRecommendation(userText)) {
		return {
			action: "hotel_recommendation",
			roomTypeKey: lu.roomTypeKey || st.slots?.roomTypeKey || null,
			scope: "platform",
			reason: "hotel_recommendation_keyword",
		};
	}
	if (wantsPriceButMissingDates(userText, st)) {
		return {
			action: "ask_dates_for_price",
			roomTypeKey: lu.roomTypeKey || st.slots?.roomTypeKey || null,
			scope: st.hotel ? "selected_hotel" : null,
			reason: "price_missing_dates",
		};
	}
	if (
		(lu.dates?.checkinISO || st.slots?.checkinISO) &&
		(lu.dates?.checkoutISO || st.slots?.checkoutISO) &&
		(lu.roomTypeKey || st.slots?.roomTypeKey)
	) {
		return {
			action: "continue_booking",
			roomTypeKey: lu.roomTypeKey || st.slots?.roomTypeKey || null,
			scope: st.hotel ? "selected_hotel" : null,
			reason: "dates_and_room_present",
		};
	}
	if (lu.amenity) {
		return { action: "amenity_question", roomTypeKey: lu.roomTypeKey || null, scope: st.hotel ? "selected_hotel" : null, reason: "amenity_detected" };
	}
	if (lu.intent === "smalltalk" || looksLikeGreetingOnly(userText)) {
		return { action: "smalltalk", roomTypeKey: null, scope: null, reason: "smalltalk_detected" };
	}
	return { action: "other", roomTypeKey: lu.roomTypeKey || null, scope: st.hotel ? "selected_hotel" : null, reason: "fallback_decision" };
}

async function decideSupportAction({ sc, st, userText, lu }) {
	const localDecision = fallbackSupportDecision(userText, st, lu || {});
	if (
		localDecision.action !== "other" ||
		localDecision.reason === "hotel_scope_boundary"
	) {
		logStep(String(sc._id), "orchestrator.local_decision", localDecision);
		return localDecision;
	}
	const [previousGuestContext, learningContext] = await Promise.all([
		loadPreviousGuestContext(sc, st),
		loadLearningContext(
			sc,
			st,
			"Decide the next support action. Use relevant employee learning examples before choosing escalation.",
			{ latestUserMessage: userText, nlu: lu || null }
		),
	]);
	const hotelSummary = buildActiveHotelFacts(sc, st);
	const sys = [
		"You are the hotel reception and reservations chat orchestrator.",
		"Read the whole conversation and decide the next support action before any answer is written.",
		"Use all available context to avoid redundancy and to keep the chat natural in any language.",
		"Guest text may be native script, romanized/transliterated, code-switched, misspelled, or informal. Infer the intended meaning from phonetics and context instead of exact spellings.",
		"Arabic may appear as Egyptian, Gulf, Levantine, Iraqi, Sudanese, Moroccan, Algerian, Tunisian, Franko Arabic, or Arabizi. Indian and Pakistani guests may use Hinglish, Urdu/Hindi in Latin characters, or mixed scripts. Do not escalate only because the writing style is unusual.",
		AI_PREVIOUS_GUEST_CONTEXT_ENABLED
			? "Private previous guest chats may be provided. Use them only to prepare the next action; never choose an action that would disclose that history to the guest."
			: "This support case is self-contained. Do not infer facts from previous chats. If the guest asks to continue an old chat, keep the action as general_answer so the writer can explain the fresh-chat privacy boundary.",
		"Employee learning examples may be provided. Before choosing human_escalation, check whether those examples contain a reusable resolution or safe next step for this kind of question.",
		"Return ONLY valid JSON with this shape:",
		"{ action:'hotel_recommendation'|'ask_dates_for_price'|'discount_question'|'payment_help'|'reservation_update'|'reservation_cancellation'|'reservation_lookup'|'amenity_question'|'continue_booking'|'smalltalk'|'general_answer'|'support_email'|'human_escalation'|'other',",
		"roomTypeKey:null|'singleRooms'|'doubleRooms'|'tripleRooms'|'quadRooms'|'familyRooms', scope:null|'selected_hotel'|'alternative_hotels'|'platform', reason:string }",
		"Use the guest's latest message, the full chat transcript, and current slots. Do not write the customer-facing reply.",
		"Direct request precedence is strict: if the latest message asks for phone/WhatsApp/contact, asks whether we work directly with the hotel, asks for EIN/tax ID/company/legal paperwork, asks location/address/distance/bus/amenity/room facts, asks a payment/discount question, or asks another concrete question, choose the action that answers that request first. Do not choose ask_dates_for_price or continue_booking for that turn unless the latest request itself is price/availability/new-booking and cannot be answered without dates.",
		"If an active hotel is present, this support case is strictly hotel-scoped. For rooms, amenities, availability, pricing, alternatives, or other-hotel questions, keep scope:'selected_hotel' and do not choose hotel_recommendation.",
		"If an active hotel is present and the guest asks about other hotels, nearby alternatives, comparisons, or general platform options that are not answered by verified context or learning examples, choose support_email with scope:'selected_hotel' and reason:'hotel_scope_boundary'.",
		"Choose hotel_recommendation only when there is no active hotel context.",
		"If an active hotel is present and the guest asks about the selected hotel's address, location, distance from Al Haram, bus/shuttle to Al Haram, parking, hotel facts, or active room facts, choose general_answer with scope:'selected_hotel' unless a deterministic handler has already handled it.",
		"If check-in and checkout dates are already present in currentSlots or nlu, never choose ask_dates_for_price; choose continue_booking for price or availability.",
		"If currentSlots or waitFor show a new reservation is in progress, do not choose reservation_lookup merely because the guest says confirmation number; choose continue_booking unless the guest clearly says they already have an existing reservation.",
		"If the guest asks about discounts, coupons, promos, offers, cheaper prices, or best price, choose discount_question. Do not choose human_escalation for a discount question.",
		"Choose general_answer when selected hotel facts, platform facts, database context, or employee learning examples contain a verified safe answer to the latest broad/general question, and no booking flow step should be forced.",
		"Choose general_answer when the guest asks a broad, general, or off-topic question that is not part of the booking planner. The writer will answer using verified context or safe general knowledge, and will avoid guessing live/current data.",
		"Choose support_email only for a hard scope boundary or unsupported platform/hotel request that must not be answered from general knowledge. The customer-facing reply must not send the guest away or mention email unless the latest guest explicitly asks for email.",
		"Text inside parentheses in the guest message is meaningful and must be considered when choosing the action.",
		"Do not choose human_escalation only because a normal question was repeated once or twice; keep answering safely and patiently. The deterministic three-repeat guard handles unresolved repeated questions.",
		"Choose reservation_cancellation for cancellation/refund policy questions or cancellation requests so the deterministic policy handler can answer directly from verified hotel policy. Choose human_escalation only when the same support case must be taken over by a human specialist, such as complaints, abuse, safety issues, sensitive payment/reservation mutations, or anything that should not be handled by email-only guidance.",
	].join(" ");
	const user = JSON.stringify(
		{
			language: languageOf(sc, st),
			latestUserMessage: userText,
			latestGuestLanguageStyle: latestGuestLanguageStyle(
				sc,
				targetLanguageLabel(sc, st)
			),
			fullConversation: recentConversationLines(sc, st),
			currentSlots: st.slots,
			waitFor: st.waitFor,
			nlu: lu || null,
			hotel: hotelSummary,
			privatePreviousGuestChats: previousGuestContext,
			employeeLearningExamples: learningContext,
		},
		null,
		2
	);
	let raw = "";
	try {
		raw = await chat(
			[
				{ role: "system", content: sys },
				{ role: "user", content: user },
			],
			{ kind: "nlu", temperature: 0, max_tokens: 180 }
		);
	} catch (error) {
		logStep(String(sc._id), "orchestrator.decision_failed", {
			message: error?.message || error,
		});
		return fallbackSupportDecision(userText, st, lu);
	}
	try {
		const parsed = JSON.parse(raw);
		return {
			action: parsed.action || "other",
			roomTypeKey: parsed.roomTypeKey || null,
			scope: parsed.scope || null,
			reason: parsed.reason || "",
		};
	} catch {
		return fallbackSupportDecision(userText, st, lu);
	}
}

async function composeAvailabilityQuoteText(io, sc, st, quote = {}) {
	const fallback = simpleQuoteText({ sc, st, quote });
	if (!quote?.available) return fallback;
	return currentQuoteSummaryText(sc, st, quote) || fallback;
}

async function sendUnavailableRoomRecovery(io, sc, st, quote = {}) {
	const option = bestRoomRecoveryOption(st);
	const message = roomRecoveryOfferText(sc, st, quote, option);
	st.pendingRoomAlternative = roomRecoveryPendingPayload(option);
	const sent = await humanSend(io, sc, st, message, {
		quickReplies: st.pendingRoomAlternative ? proceedQuickReplies(sc, st) : [],
	});
	if (!sent) return false;
	st.reviewSent = false;
	st.quoteSummarizedAt = 0;
	st.waitFor = st.pendingRoomAlternative ? "room_alternative_confirm" : "room";
	stampAsk(st, st.pendingRoomAlternative ? "room_alternative" : "room");
	logStep(String(sc._id || ""), "room_recovery.offered", {
		kind: st.pendingRoomAlternative?.kind || "none",
		roomTypeKey: st.pendingRoomAlternative?.roomTypeKey || null,
		checkinISO: st.pendingRoomAlternative?.checkinISO || null,
		checkoutISO: st.pendingRoomAlternative?.checkoutISO || null,
	});
	return true;
}

async function shareKnownStayQuote(io, sc, st) {
	applyLatestRoomSignalFromConversation(sc, st, {
		source: "quote_guard_room_signal",
	});
	logStep(String(sc._id), "quote.start", {
		roomTypeKey: st.slots.roomTypeKey,
		checkinISO: st.slots.checkinISO,
		checkoutISO: st.slots.checkoutISO,
		hasHotel: Boolean(st.hotel),
	});
	const quote = safePriceRoomForStay(
		st.hotel,
		{ roomType: st.slots.roomTypeKey },
		st.slots.checkinISO,
		st.slots.checkoutISO
	);
	st.quote = {
		key: `${st.slots.roomTypeKey}|${st.slots.checkinISO}|${st.slots.checkoutISO}`,
		at: now(),
		data: quote,
	};
	logStep(String(sc._id), "quote.prepared", {
		available: quote.available,
		reason: quote.reason || null,
		roomTypeKey: st.slots.roomTypeKey,
	});
	if (!quote.available) {
		return sendUnavailableRoomRecovery(io, sc, st, quote);
	}
	clearPendingRoomAlternative(st);
	st.waitFor = "proceed";
	let quoteReply = await composeAvailabilityQuoteText(io, sc, st, quote);
	quoteReply = ensureHijriGregorianDatesVisible(quoteReply, sc, st);
	const sent = await humanSend(io, sc, st, quoteReply, {
		quickReplies: quote?.available ? proceedQuickReplies(sc, st) : [],
		fast: true,
	});
	if (!sent) return false;
	st.reviewSent = false;
	return true;
}

async function tryShareDirectStayQuote(io, sc, st, userText = "", caseId = "") {
	if (
		!st.hotel ||
		humanHandoffReason(userText) ||
		wantsPaymentHelp(userText) ||
		explicitlyExistingReservationIntent(userText)
	) {
		return false;
	}
	const dates = extractDateRange(userText);
	if (
		!dates?.checkinISO ||
		!dates?.checkoutISO ||
		needsExplicitPastDateClarification(userText, dates)
	) {
		return false;
	}
	const roomTypeKey = mapRoomToKey(userText) || st.slots?.roomTypeKey || null;
	if (!roomTypeKey) return false;
	updateActiveLanguageFromText(sc, st, userText);
	const dateMerge = await mergeDateRangeWithChangeGuard(io, sc, st, dates, {
		source: "direct_stay_quote",
		userText,
	});
	if (dateMerge.prompted) return true;
	const roomChanged = st.slots.roomTypeKey !== roomTypeKey;
	if (roomChanged) {
		st.slots.roomTypeKey = roomTypeKey;
		st.quote = null;
		st.quoteSummarizedAt = 0;
		st.reviewSent = false;
		clearPendingRoomAlternative(st);
	}
	applyReservationGuestCountsFromText(st, userText);
	logStep(caseId || String(sc._id || ""), "quote.direct_stay_request", {
		roomTypeKey: st.slots.roomTypeKey,
		checkinISO: st.slots.checkinISO,
		checkoutISO: st.slots.checkoutISO,
	});
	await shareKnownStayQuote(io, sc, st);
	return true;
}

async function tryStartDirectReservationFlow(io, sc, st, userText = "", caseId = "") {
	if (
		!st.hotel ||
		humanHandoffReason(userText) ||
		wantsPaymentHelp(userText) ||
		explicitlyExistingReservationIntent(userText) ||
		selectedHotelFactQuestionText(userText) ||
		!wantsNewReservationIntent(userText, {})
	) {
		return false;
	}
	updateActiveLanguageFromText(sc, st, userText);
	const dates = extractDateRange(userText);
	if (
		dates?.checkinISO &&
		dates?.checkoutISO &&
		!needsExplicitPastDateClarification(userText, dates)
	) {
		const dateMerge = await mergeDateRangeWithChangeGuard(io, sc, st, dates, {
			source: "direct_reservation_start",
			userText,
		});
		if (dateMerge.prompted) return true;
	}
	const roomTypeKey = mapRoomToKey(userText);
	if (roomTypeKey && st.slots.roomTypeKey !== roomTypeKey) {
		st.slots.roomTypeKey = roomTypeKey;
		st.quote = null;
		st.quoteSummarizedAt = 0;
		st.reviewSent = false;
		clearPendingRoomAlternative(st);
	}
	applyReservationGuestCountsFromText(st, userText);
	if (!st.slots.roomTypeKey) {
		const requestedGuestCount = requestedGuestCountFromText(userText);
		const inferredRoomTypeKey = recommendedRoomTypeKeyForGuestCount(requestedGuestCount);
		if (
			inferredRoomTypeKey &&
			activeHotelRoomSummaries(st.hotel, inferredRoomTypeKey).length
		) {
			st.slots.roomTypeKey = inferredRoomTypeKey;
			st.quote = null;
			st.quoteSummarizedAt = 0;
			st.reviewSent = false;
			clearPendingRoomAlternative(st);
			logStep(caseId || String(sc._id || ""), "reservation.direct_start_room_inferred", {
				guestCount: requestedGuestCount,
				roomTypeKey: inferredRoomTypeKey,
			});
		}
	}
	logStep(caseId || String(sc._id || ""), "reservation.direct_start", {
		waitFor: st.waitFor || "",
		roomTypeKey: st.slots.roomTypeKey || null,
		checkinISO: st.slots.checkinISO || null,
		checkoutISO: st.slots.checkoutISO || null,
	});
	if (st.slots.checkinISO && st.slots.checkoutISO && st.slots.roomTypeKey) {
		await shareKnownStayQuote(io, sc, st);
		return true;
	}
	if (!st.slots.checkinISO || !st.slots.checkoutISO) {
		await askForMissingStayDates(io, sc, st, {
			targetReplyMs: AI_BOOKING_PROMPT_TARGET_MS,
		});
		return true;
	}
	if (!st.slots.roomTypeKey) {
		await askRoomPreferenceForReservation(io, sc, st, {
			targetReplyMs: AI_BOOKING_PROMPT_TARGET_MS,
		});
		return true;
	}
	return false;
}

async function acceptPendingRoomAlternative(io, sc, st, pending = {}) {
	if (!pending?.roomTypeKey || !pending?.checkinISO || !pending?.checkoutISO) {
		clearPendingRoomAlternative(st);
		return false;
	}
	const datesChanged =
		pending.checkinISO !== st.slots?.checkinISO ||
		pending.checkoutISO !== st.slots?.checkoutISO;
	st.slots.roomTypeKey = pending.roomTypeKey;
	st.slots.checkinISO = pending.checkinISO;
	st.slots.checkoutISO = pending.checkoutISO;
	if (datesChanged) {
		st.dateRaw = { calendar: null, checkin: null, checkout: null };
	}
	st.quote = null;
	st.quoteSummarizedAt = 0;
	st.reviewSent = false;
	clearPendingRoomAlternative(st);
	return shareKnownStayQuote(io, sc, st);
}

async function handlePendingRoomAlternativeChoice(io, sc, st, userText = "") {
	const pending = st.pendingRoomAlternative || null;
	if (!pending) return false;
	const directKind = directGuestRequestKind(sc, st, userText, {});
	if (directKind) return false;
	const selectedRoomType = mapRoomToKey(userText);
	const dates = quickDateRange(userText);
	if (confirmsText(userText) || selectedRoomType === pending.roomTypeKey) {
		return acceptPendingRoomAlternative(io, sc, st, pending);
	}
	if (selectedRoomType && selectedRoomType !== pending.roomTypeKey) {
		clearPendingRoomAlternative(st);
		st.slots.roomTypeKey = selectedRoomType;
		st.quote = null;
		st.quoteSummarizedAt = 0;
		st.reviewSent = false;
		if (st.slots.checkinISO && st.slots.checkoutISO) {
			return shareKnownStayQuote(io, sc, st);
		}
		const sent = await humanSend(io, sc, st, roomFitSalesIntroText(sc, st, selectedRoomType));
		if (!sent) return false;
		st.waitFor = "dates";
		stampAsk(st, "dates");
		return true;
	}
	if (dates?.checkinISO && dates?.checkoutISO) {
		const dateMerge = await mergeDateRangeWithChangeGuard(io, sc, st, dates, {
			source: "room_alternative_dates",
			userText,
		});
		if (dateMerge.prompted) return true;
		clearPendingRoomAlternative(st);
		st.quote = null;
		st.quoteSummarizedAt = 0;
		st.reviewSent = false;
		return shareKnownStayQuote(io, sc, st);
	}
	if (declinesText(userText) || correctionText(userText)) {
		clearPendingRoomAlternative(st);
		const sent = await humanSend(io, sc, st, roomRecoveryDeclineText(sc, st));
		if (!sent) return false;
		st.waitFor = "room";
		stampAsk(st, "room");
		return true;
	}
	if (patienceText(userText)) {
		const msg = await write(
			io,
			sc,
			st,
			"Thank the guest naturally and say there is no rush. Mention that the alternative option is ready if they want it. Do not repeat every price detail.",
			{ pendingRoomAlternative: pending }
		);
		await humanSend(io, sc, st, msg);
		st.waitFor = "room_alternative_confirm";
		return true;
	}
	if (st.waitFor !== "room_alternative_confirm") return false;
	const msg = await write(
		io,
		sc,
		st,
		"The guest replied after an alternative room/date option was offered, but did not clearly accept or reject it. Ask one short yes/no question asking whether to prepare the offered option, and mention they can send another room type or nearby dates instead.",
		{ pendingRoomAlternative: pending, latestUserMessage: userText }
	);
	await humanSend(io, sc, st, msg, { quickReplies: proceedQuickReplies(sc, st) });
	return true;
}

function quoteKeyForSlots(st = {}) {
	if (!st.slots?.roomTypeKey || !st.slots?.checkinISO || !st.slots?.checkoutISO) {
		return "";
	}
	return `${st.slots.roomTypeKey}|${st.slots.checkinISO}|${st.slots.checkoutISO}`;
}

function activeQuoteMatchesSlots(st = {}) {
	const key = quoteKeyForSlots(st);
	return Boolean(key && st.quote?.key === key && st.quote?.data?.available);
}

function ensureCurrentQuoteForSlots(st = {}) {
	if (activeQuoteMatchesSlots(st)) return st.quote.data;
	if (
		!st.hotel ||
		!st.slots?.roomTypeKey ||
		!st.slots?.checkinISO ||
		!st.slots?.checkoutISO
	) {
		return null;
	}
	const quote = safePriceRoomForStay(
		st.hotel,
		{ roomType: st.slots.roomTypeKey },
		st.slots.checkinISO,
		st.slots.checkoutISO
	);
	st.quote = {
		key: quoteKeyForSlots(st),
		at: now(),
		data: quote,
	};
	return quote;
}

function repeatPriceQuestionText(text = "") {
	const { lower, arabic, latinCompact } = normalizeControlText(text);
	return (
		/\b(?:price|cost|rate|total|amount|how\s+much|how\s+many\s+riyal|sar|riyals?)\b/i.test(
			lower
		) ||
		/(?:\u0627\u0644\u0633\u0639\u0631|\u0633\u0639\u0631|\u0627\u0644\u0627\u062c\u0645\u0627\u0644\u064a|\u0627\u0644\u0625\u062c\u0645\u0627\u0644\u064a|\u0627\u0644\u0645\u062c\u0645\u0648\u0639|\u0627\u0644\u062a\u0643\u0644\u0641\u0629|\u062a\u0643\u0644\u0641\u0647|\u0628\u0643\u0627\u0645|\u0628\u0643\u0645|\u0643\u0627\u0645\s+\u0627\u0644\u0633\u0639\u0631|\u0643\u0645\s+\u0627\u0644\u0633\u0639\u0631)/i.test(
			arabic
		) ||
		/(?:priceagain|totalagain|costagain|howmuch|els3r|als3r|elsa3r|kamels3r|bkam)/i.test(
			latinCompact
		)
	);
}

function reservationDetailsSummaryQuestionText(text = "") {
	const { lower, arabic, latinCompact } = normalizeControlText(text);
	const arabicBookingWords =
		"(?:\\u062d\\u062c\\u0632(?:\\u064a|\\u0643|\\u0643\\u0645|\\u0646\\u0627)?|\\u0627\\u0644\\u062d\\u062c\\u0632|\\u0627\\u0644\\u0627\\u0642\\u0627\\u0645\\u0647|\\u0627\\u0644\\u0627\\u0642\\u0627\\u0645\\u0629|\\u0627\\u0644\\u0625\\u0642\\u0627\\u0645\\u0629)";
	return (
		/\b(?:booking|reservation|stay|quote)\s+(?:details|summary|recap)\b/i.test(
			lower
		) ||
		/\b(?:details|summary|recap)\s+(?:of|for)?\s*(?:the\s+)?(?:booking|reservation|stay|quote)\b/i.test(
			lower
		) ||
		new RegExp(
			`(?:\\u062a\\u0641\\u0627\\u0635\\u064a\\u0644|\\u0645\\u0644\\u062e\\u0635|\\u0645\\u0631\\u0627\\u062c\\u0639\\u0647).{0,30}${arabicBookingWords}|${arabicBookingWords}.{0,30}(?:\\u062a\\u0641\\u0627\\u0635\\u064a\\u0644|\\u0645\\u0644\\u062e\\u0635)`,
			"i"
		).test(
			arabic
		) ||
		/(?:bookingdetails|reservationdetails|staydetails|bookingrecap|reservationsummary|tafaseelelhagz|tfaseelelhagz|molakhaselhagz)/i.test(
			latinCompact
		) ||
		/\b(?:remember|recall)\b.{0,100}\b(?:data|details|info|information|reservation|booking|name|phone|nationality|country|dates?|room)\b/i.test(
			lower
		) ||
		/\b(?:what|which)\b.{0,60}\b(?:data|details|info|information)\b.{0,60}\b(?:have|saved|got|remember|hold|keep)\b/i.test(
			lower
		) ||
		/\b(?:what(?:'s| is)|which)\b.{0,30}\b(?:my|the)?\s*(?:nationality|country|phone|mobile|number|name|room|dates?|check[\s-]?in|check[\s-]?out)\b/i.test(
			lower
		) ||
		/(?:\u062a\u0630\u0643\u0631|\u062a\u0641\u062a\u0643\u0631|\u0641\u0627\u0643\u0631).{0,80}(?:\u062a\u0641\u0627\u0635\u064a\u0644|\u0628\u064a\u0627\u0646\u0627\u062a|\u0627\u0644\u062d\u062c\u0632|\u062d\u062c\u0632\u064a|\u0627\u0644\u0627\u0642\u0627\u0645\u0629|\u0627\u0644\u0625\u0642\u0627\u0645\u0629|\u062c\u0646\u0633\u064a\u0629|\u0627\u0633\u0645|\u0647\u0627\u062a\u0641|\u062c\u0648\u0627\u0644)/i.test(
			arabic
		) ||
		/(?:\u0645\u0627|\u0645\u0627\u0630\u0627|\u0627\u064a\u0647|\u0627\u064a|\u0625\u064a\u0647).{0,40}(?:\u062c\u0646\u0633\u064a\u062a\u064a|\u062c\u0646\u0633\u064a\u062a\u0649|\u062c\u0646\u0633\u064a\u0629|\u0631\u0642\u0645\u064a|\u0631\u0642\u0645\u0649|\u0627\u0633\u0645\u064a|\u0627\u0633\u0645\u0649|\u063a\u0631\u0641\u0629|\u062a\u0648\u0627\u0631\u064a\u062e)/i.test(
			arabic
		) ||
		/(?:remember|recall|doyouremember|whatdetails|whatdata|whatinfo|whatinformation|whatismynationality|whatsmynationality|whatcountry|whatphone|whatnumber|whatname|recuerdas|teacuerdas|quedatos|queinformacion|minacionalidad|mitelefono|montelephone|souviens|souvenez|souvenir|vousvoussouvenez|detailsdemareservation|quellesinfos|quellesdonnees|manationalite)/i.test(
			latinCompact
		)
	);
}

function reservationDetailAlreadyProvidedComplaintText(text = "") {
	const { lower, arabic, latinCompact } = normalizeControlText(text);
	return (
		/\b(?:i|we)\s+(?:already\s+)?(?:told|gave|sent|shared|provided|mentioned)\s+(?:you|it|this|that)?\b/i.test(
			lower
		) ||
		/\b(?:already\s+)?(?:gave|sent|shared|provided|mentioned)\s+(?:it|this|that|the\s+details|the\s+data)\b/i.test(
			lower
		) ||
		/\b(?:ya\s+(?:te\s+)?(?:dije|di|envie|mande|comparti)|te\s+lo\s+(?:dije|di|envie|mande)|deja\s+(?:te\s+)?(?:dije|di|envie|mande|comparti))\b/i.test(
			lower
		) ||
		/\b(?:je\s+(?:vous|te)\s+l'?ai\s+deja\s+(?:dit|donne|envoye|partage)|deja\s+(?:dit|donne|envoye|partage))\b/i.test(
			lower
		) ||
		/(?:\u0642\u0644\u062a\s+\u0644\u0643|\u0642\u0644\u062a\u0644\u0643|\u0642\u0648\u0644\u062a\s+\u0644\u0643|\u0642\u0648\u0644\u062a\u0644\u0643|\u0627\u0631\u0633\u0644\u062a|\u0623\u0631\u0633\u0644\u062a|\u0628\u0639\u062a|\u0627\u062f\u064a\u062a|\u0623\u062f\u064a\u062a|\u0630\u0643\u0631\u062a).{0,80}(?:\u0644\u0643|\u0644\u0643\u064a|\u0644\u0643\u0645|\u0642\u0628\u0644|\u0627\u0644\u062a\u0641\u0627\u0635\u064a\u0644|\u0627\u0644\u0628\u064a\u0627\u0646\u0627\u062a|\u0627\u0644\u062c\u0646\u0633\u064a\u0629|\u0631\u0642\u0645\u064a|\u0627\u0633\u0645\u064a)?/i.test(
			arabic
		) ||
		/(?:\u0642\u0644\u062a|\u0642\u0648\u0644\u062a|\u0627\u0631\u0633\u0644\u062a|\u0623\u0631\u0633\u0644\u062a|\u0628\u0639\u062a|\u0630\u0643\u0631\u062a).{0,50}(?:\u062c\u0646\u0633\u064a\u062a\u064a|\u062c\u0646\u0633\u064a\u062a\u0649|\u062c\u0646\u0633\u064a|\u0628\u064a\u0627\u0646\u0627\u062a|\u062a\u0641\u0627\u0635\u064a\u0644|\u0631\u0642\u0645\u064a|\u0631\u0642\u0645\u0649|\u0627\u0633\u0645\u064a|\u0627\u0633\u0645\u0649)/i.test(
			arabic
		) ||
		/(?:ialreadytold|alreadytoldyou|ialreadygave|ialreadysent|ialreadyshared|itoldyou|gaveyoualready|sentitalready|yatedije|yatedi|yateenvie|telodije|dejadit|dejadonne|dejaenvoye|jevoelaidejadit|jetelaidejadit)/i.test(
			latinCompact
		)
	);
}

function currentReservationMemoryRequestText(text = "") {
	return (
		reservationDetailsSummaryQuestionText(text) ||
		reservationDetailAlreadyProvidedComplaintText(text)
	);
}

function postBookingGeneralSummaryQuestionText(text = "") {
	const { lower, arabic, latinCompact } = normalizeControlText(text);
	return (
		/\b(?:summary|summarize|summarise|recap|brief recap|final recap)\b/i.test(
			lower
		) ||
		/(?:\u0645\u0644\u062e\u0635|\u062e\u0644\u0627\u0635\u0629|\u0627\u062e\u062a\u0635\u0627\u0631|\u0628\u0627\u062e\u062a\u0635\u0627\u0631|\u0631\u0627\u062c\u0639|\u0645\u0631\u0627\u062c\u0639\u0629)/i.test(
			arabic
		) ||
		/(?:summary|summarize|summarise|recap|briefrecap|finalrecap|molakhas|mokhtasar)/i.test(
			latinCompact
		)
	);
}

function bookingStayFieldQuestionText(text = "") {
	const { lower, arabic, latinCompact } = normalizeControlText(text);
	return (
		/\b(?:confirmed\s+)?(?:check[\s-]?in|check[\s-]?out|checkout|arrival|departure|dates?)\b.{0,60}\b(?:again|confirmed|reserved|booked|booking|reservation|stay|we|my)\b/i.test(
			lower
		) ||
		/\b(?:what|which|remind|repeat|tell)\b.{0,50}\b(?:room|room\s+type|check[\s-]?in|check[\s-]?out|checkout|dates?)\b/i.test(
			lower
		) ||
		/\b(?:which|what)\s+(?:room|room\s+type)\s+(?:did\s+)?(?:we|i)\s+(?:reserve|book|choose|confirm)\b/i.test(
			lower
		) ||
		/(?:\u0627\u0644\u062f\u062e\u0648\u0644|\u0627\u0644\u0648\u0635\u0648\u0644|\u0627\u0644\u062e\u0631\u0648\u062c|\u0627\u0644\u0645\u063a\u0627\u062f\u0631\u0629|\u0627\u0644\u062a\u0648\u0627\u0631\u064a\u062e|\u0627\u0644\u063a\u0631\u0641\u0629|\u0646\u0648\u0639\s+\u0627\u0644\u063a\u0631\u0641\u0629).{0,40}(?:\u062d\u062c\u0632|\u062d\u062c\u0632\u064a|\u0627\u0644\u062d\u062c\u0632|\u0645\u0624\u0643\u062f|\u0627\u0644\u062a\u0623\u0643\u064a\u062f)|(?:\u062d\u062c\u0632|\u062d\u062c\u0632\u064a|\u0627\u0644\u062d\u062c\u0632|\u0645\u0624\u0643\u062f).{0,40}(?:\u0627\u0644\u062f\u062e\u0648\u0644|\u0627\u0644\u0648\u0635\u0648\u0644|\u0627\u0644\u062e\u0631\u0648\u062c|\u0627\u0644\u0645\u063a\u0627\u062f\u0631\u0629|\u0627\u0644\u062a\u0648\u0627\u0631\u064a\u062e|\u0627\u0644\u063a\u0631\u0641\u0629|\u0646\u0648\u0639\s+\u0627\u0644\u063a\u0631\u0641\u0629)/i.test(
			arabic
		) ||
		/(?:checkindate|checkoutdate|bookingdates|reservationdates|reservedroom|bookedroom|roomtypeagain|whichroomdidwereserve|whichroomdidibook|confirmedroom)/i.test(
			latinCompact
		)
	);
}

function confirmationNumberQuestionText(text = "") {
	const { lower, arabic, latinCompact } = normalizeControlText(text);
	return (
		/\b(?:confirmation|booking|reservation|reference)\s*(?:number|no\.?|#|id|ref)\b/i.test(
			lower
		) ||
		/\b(?:number|no\.?|#|id|ref)\s+(?:for\s+)?(?:my\s+)?(?:confirmation|booking|reservation|reference)\b/i.test(
			lower
		) ||
		/(?:\u0631\u0642\u0645|\u0646\u0645\u0631\u0647|\u0646\u0645\u0631\u0629).{0,24}(?:\u0627\u0644\u062a\u0627\u0643\u064a\u062f|\u0627\u0644\u062a\u0623\u0643\u064a\u062f|\u0627\u0644\u062d\u062c\u0632|\u062d\u062c\u0632\u064a|\u062d\u062c\u0632\u0643|\u062d\u062c\u0632)/i.test(
			arabic
		) ||
		/(?:\u0627\u0644\u062d\u062c\u0632|\u062d\u062c\u0632\u064a|\u062d\u062c\u0632\u0643|\u0627\u0644\u062a\u0627\u0643\u064a\u062f|\u0627\u0644\u062a\u0623\u0643\u064a\u062f).{0,24}(?:\u0631\u0642\u0645|\u0646\u0645\u0631\u0647|\u0646\u0645\u0631\u0629)/i.test(
			arabic
		) ||
		/(?:confirmationnumber|bookingnumber|reservationnumber|bookingno|reservationno|raqmaltakid|raqmelhagz|raqmhagzy|bookingref|reservationref)/i.test(
			latinCompact
		)
	);
}

function bookingStateQuestionText(text = "") {
	return (
		repeatPriceQuestionText(text) ||
		currentReservationMemoryRequestText(text) ||
		bookingStayFieldQuestionText(text) ||
		confirmationNumberQuestionText(text)
	);
}

function localizedNightCount(nights, lang = "English") {
	const count = Number(nights || 0);
	if (!Number.isFinite(count) || count <= 0) return "";
	if (/arabic/i.test(lang)) {
		if (count === 1) return "\u0644\u064a\u0644\u0629 \u0648\u0627\u062d\u062f\u0629";
		if (count === 2) return "\u0644\u064a\u0644\u062a\u064a\u0646";
		if (Number.isInteger(count) && count >= 3 && count <= 10) {
			return `${localizedNumber(count, lang)} \u0644\u064a\u0627\u0644\u064d`;
		}
		return `${localizedNumber(count, lang)} \u0644\u064a\u0644\u0629`;
	}
	return `${localizedNumber(count, lang)} night${count === 1 ? "" : "s"}`;
}

function bookingGuestCountText(sc = {}, st = {}) {
	const lang = languageOf(sc, st);
	const adults = Number(st.slots?.adults || 0);
	const children = Number(st.slots?.children || 0);
	const hasAdults = st.slots?.adultsProvided && adults > 0;
	const hasChildren = st.slots?.childrenProvided && children > 0;
	if (!hasAdults && !hasChildren) return "";
	if (/arabic/i.test(lang)) {
		const parts = [];
		if (hasAdults) {
			parts.push(`${localizedNumber(adults, lang)} \u0628\u0627\u0644\u063a`);
		}
		if (hasChildren) {
			parts.push(`${localizedNumber(children, lang)} \u0637\u0641\u0644`);
		}
		return parts.join(" \u0648");
	}
	const parts = [];
	if (hasAdults) parts.push(`${localizedNumber(adults, lang)} adult${adults === 1 ? "" : "s"}`);
	if (hasChildren) parts.push(`${localizedNumber(children, lang)} child${children === 1 ? "" : "ren"}`);
	return parts.join(" and ");
}

function bookingNextActionText(sc = {}, st = {}) {
	const lang = languageOf(sc, st);
	const waitFor = st.waitFor || nextPivot(st);
	if (/arabic/i.test(lang)) {
		if (waitFor === "proceed") {
			return '\u0625\u0630\u0627 \u064a\u0646\u0627\u0633\u0628\u0643\u060c \u0627\u062e\u062a\u0631 "\u0646\u0639\u0645\u060c \u062a\u0627\u0628\u0639" \u0644\u0645\u0631\u0627\u062c\u0639\u0629 \u0627\u0644\u062d\u062c\u0632.';
		}
		if (waitFor === "reviewConfirm") {
			return '\u0625\u0630\u0627 \u0643\u0644 \u0634\u064a\u0621 \u0635\u062d\u064a\u062d\u060c \u0627\u062e\u062a\u0631 "\u062a\u0623\u0643\u064a\u062f".';
		}
		if (waitFor === "finalize" || (isReservationDetailStep(st) && hasMandatoryReservationDetails(st))) {
			return '\u0644\u0625\u0646\u0634\u0627\u0621 \u0627\u0644\u062d\u062c\u0632 \u0641\u064a \u0627\u0644\u0646\u0638\u0627\u0645\u060c \u0627\u062e\u062a\u0631 "\u0625\u062a\u0645\u0627\u0645 \u0627\u0644\u062d\u062c\u0632".';
		}
		if (isReservationDetailStep(st)) {
			return "\u0644\u0625\u062a\u0645\u0627\u0645 \u0627\u0644\u062d\u062c\u0632\u060c \u0623\u0631\u0633\u0644 \u0627\u0644\u0628\u064a\u0627\u0646\u0627\u062a \u0627\u0644\u0645\u062a\u0628\u0642\u064a\u0629 \u0641\u064a \u0631\u0633\u0627\u0644\u0629 \u0648\u0627\u062d\u062f\u0629.";
		}
		return "\u0647\u0644 \u0623\u062a\u0627\u0628\u0639 \u0644\u0643 \u0627\u0644\u062d\u062c\u0632\u061f";
	}
	if (waitFor === "proceed") {
		return 'If this works for you, choose "Yes, proceed" and I will review the booking.';
	}
	if (waitFor === "reviewConfirm") {
		return 'If everything is correct, choose "Confirm".';
	}
	if (waitFor === "finalize" || (isReservationDetailStep(st) && hasMandatoryReservationDetails(st))) {
		return 'To complete the booking in the system, choose "Complete Reservation".';
	}
	if (isReservationDetailStep(st)) {
		return "To complete the booking, send the remaining guest details in one message.";
	}
	return "Would you like me to continue the booking?";
}

function bookingSummaryQuickReplies(sc = {}, st = {}) {
	if (st.waitFor === "proceed" && activeQuoteMatchesSlots(st)) {
		return proceedQuickReplies(sc, st);
	}
	if (st.waitFor === "reviewConfirm") {
		return confirmationQuickReplies(sc, st);
	}
	if (st.waitFor === "finalize" || (isReservationDetailStep(st) && hasMandatoryReservationDetails(st))) {
		return finalReservationQuickReplies(sc, st);
	}
	return [];
}

function localizedNationalityDisplay(value = "", lang = "English") {
	const canonical = nationalityHintFromText(value) || String(value || "").trim();
	if (!canonical) return "";
	if (!/arabic/i.test(lang)) return canonical;
	const key = asciiize(canonical).toLowerCase().replace(/[^a-z]+/g, "");
	const arabicLabels = {
		american: "\u0623\u0645\u0631\u064a\u0643\u064a",
		french: "\u0641\u0631\u0646\u0633\u064a",
		egyptian: "\u0645\u0635\u0631\u064a",
		saudi: "\u0633\u0639\u0648\u062f\u064a",
		pakistani: "\u0628\u0627\u0643\u0633\u062a\u0627\u0646\u064a",
		indian: "\u0647\u0646\u062f\u064a",
		bangladeshi: "\u0628\u0646\u063a\u0644\u0627\u062f\u0634\u064a",
		indonesian: "\u0625\u0646\u062f\u0648\u0646\u064a\u0633\u064a",
		malaysian: "\u0645\u0627\u0644\u064a\u0632\u064a",
		moroccan: "\u0645\u063a\u0631\u0628\u064a",
		algerian: "\u062c\u0632\u0627\u0626\u0631\u064a",
		tunisian: "\u062a\u0648\u0646\u0633\u064a",
		sudanese: "\u0633\u0648\u062f\u0627\u0646\u064a",
		iraqi: "\u0639\u0631\u0627\u0642\u064a",
		syrian: "\u0633\u0648\u0631\u064a",
		jordanian: "\u0623\u0631\u062f\u0646\u064a",
		burkinabe: "\u0628\u0648\u0631\u0643\u064a\u0646\u064a",
		palestinian: "\u0641\u0644\u0633\u0637\u064a\u0646\u064a",
		emirati: "\u0625\u0645\u0627\u0631\u0627\u062a\u064a",
		kuwaiti: "\u0643\u0648\u064a\u062a\u064a",
		qatari: "\u0642\u0637\u0631\u064a",
		bahraini: "\u0628\u062d\u0631\u064a\u0646\u064a",
		omani: "\u0639\u0645\u0627\u0646\u064a",
		yemeni: "\u064a\u0645\u0646\u064a",
		turkish: "\u062a\u0631\u0643\u064a",
		nigerian: "\u0646\u064a\u062c\u064a\u0631\u064a",
	};
	return arabicLabels[key] || canonical;
}

function storedNationalityForDisplay(st = {}, lang = "English") {
	const raw = String(st.slots?.nationality || "").replace(/\s+/g, " ").trim();
	if (!hasUsableNationality(raw)) return "";
	return localizedNationalityDisplay(raw, lang);
}

function requestedReservationMemoryField(text = "") {
	const { lower, arabic, latinCompact } = normalizeControlText(text);
	if (
		/\b(?:nationality|country|nacionalidad|pais|pa[ií]s|nationalite|nationality)\b/i.test(
			lower
		) ||
		/(?:\u062c\u0646\u0633\u064a|\u062c\u0646\u0633\u064a\u0629|\u0628\u0644\u062f\u064a|\u0628\u0644\u062f\u0649)/i.test(
			arabic
		) ||
		/(?:nationality|country|nacionalidad|pais|nationalite|nationalidad|minacionalidad|manationalite)/i.test(
			latinCompact
		)
	) {
		return "nationality";
	}
	if (
		/\b(?:phone|mobile|whatsapp|number|telefono|tel[eé]fono|telephone)\b/i.test(
			lower
		) ||
		/(?:\u0647\u0627\u062a\u0641|\u062c\u0648\u0627\u0644|\u0648\u0627\u062a\u0633|\u0631\u0642\u0645)/i.test(arabic) ||
		/(?:phone|mobile|whatsapp|number|telefono|telephone|mitelefono|montelephone)/i.test(
			latinCompact
		)
	) {
		return "phone";
	}
	if (
		/\b(?:full\s*name|guest\s*name|passport\s*name|name|nombre|nom)\b/i.test(
			lower
		) ||
		/(?:\u0627\u0633\u0645|\u0627\u0644\u0627\u0633\u0645)/i.test(arabic) ||
		/(?:fullname|guestname|passportname|myname|nombre|nom|monnom)/i.test(
			latinCompact
		)
	) {
		return "fullName";
	}
	if (
		/\b(?:guest|guests|adult|adults|children|child|people|persons|pax|huespedes|voyageurs|personnes)\b/i.test(
			lower
		) ||
		/(?:\u0636\u064a\u0648\u0641|\u0627\u0634\u062e\u0627\u0635|\u0623\u0634\u062e\u0627\u0635|\u0627\u0641\u0631\u0627\u062f|\u0623\u0641\u0631\u0627\u062f|\u0628\u0627\u0644\u063a|\u0627\u0637\u0641\u0627\u0644|\u0623\u0637\u0641\u0627\u0644)/i.test(
			arabic
		) ||
		/(?:guests|adult|children|people|persons|huespedes|voyageurs|personnes)/i.test(
			latinCompact
		)
	) {
		return "guests";
	}
	if (
		/\b(?:date|dates|check[\s-]?in|check[\s-]?out|arrival|departure|fecha|fechas|arrivee|depart)\b/i.test(
			lower
		) ||
		/(?:\u062a\u0627\u0631\u064a\u062e|\u062a\u0648\u0627\u0631\u064a\u062e|\u0648\u0635\u0648\u0644|\u062f\u062e\u0648\u0644|\u062e\u0631\u0648\u062c)/i.test(
			arabic
		) ||
		/(?:date|dates|checkin|checkout|arrival|departure|fecha|fechas|arrivee|depart)/i.test(
			latinCompact
		)
	) {
		return "dates";
	}
	if (
		/\b(?:room|habitacion|chambre|bilik|kamar)\b/i.test(lower) ||
		/(?:\u063a\u0631\u0641\u0629|\u063a\u0631\u0641\u0647|\u0627\u0644\u063a\u0631\u0641\u0629|\u0627\u0644\u063a\u0631\u0641\u0647)/i.test(
			arabic
		) ||
		/(?:room|habitacion|chambre|bilik|kamar)/i.test(latinCompact)
	) {
		return "room";
	}
	if (
		/\b(?:price|total|cost|amount|rate|precio|prix|total)\b/i.test(lower) ||
		/(?:\u0633\u0639\u0631|\u0627\u0644\u0633\u0639\u0631|\u0627\u0644\u0627\u062c\u0645\u0627\u0644\u064a|\u0627\u0644\u0625\u062c\u0645\u0627\u0644\u064a|\u0627\u0644\u0645\u062c\u0645\u0648\u0639|\u062a\u0643\u0644\u0641\u0629|\u062a\u0643\u0644\u0641\u0647)/i.test(
			arabic
		) ||
		/(?:price|total|cost|amount|rate|precio|prix)/i.test(latinCompact)
	) {
		return "price";
	}
	if (
		/\b(?:email|e-mail|mail|correo)\b/i.test(lower) ||
		/(?:\u0628\u0631\u064a\u062f|\u0627\u064a\u0645\u064a\u0644|\u0625\u064a\u0645\u064a\u0644)/i.test(arabic) ||
		/(?:email|mail|correo)/i.test(latinCompact)
	) {
		return "email";
	}
	return "";
}

function currentReservationMemoryFieldLine(sc = {}, st = {}, quote = {}, field = "") {
	const lang = languageOf(sc, st);
	const labels = finalReservationReviewLabels(sc, st);
	const dates = localizedStayDateLines(sc, st);
	const total = Number(quote?.totals?.totalPriceWithCommission || 0);
	const nights = localizedNightCount(quote?.nights || 0, lang);
	const totalText =
		Number.isFinite(total) && total > 0 ? localizedMoney(total, quote.currency, lang) : "";
	const fullName = hasUsableFullName(st.slots?.fullName || st.slots?.name || "")
		? String(st.slots?.fullName || st.slots?.name || "").trim()
		: "";
	const nationality = storedNationalityForDisplay(st, lang);
	const phone = cleanPhoneCandidate(st.slots?.phone || "");
	const email = latestEmailFromText(st.slots?.email || "");
	const guestCount = bookingGuestCountText(sc, st);
	const values = {
		hotel: localizedHotelName(sc, st),
		room: localizedRoomName(sc, st, quote || {}),
		dates: dates.primary
			? `${dates.primary}${dates.secondary ? ` (${dates.secondary})` : ""}`
			: "",
		price: totalText && nights ? `${totalText} for ${nights}` : totalText,
		fullName,
		nationality,
		phone,
		email,
		guests: guestCount,
	};
	const labelByField = {
		hotel: labels.hotel,
		room: labels.room,
		dates: labels.dates,
		price: labels.total,
		fullName: labels.guestName,
		nationality: labels.nationality,
		phone: labels.phone,
		email: labels.email,
		guests: labels.guestCount,
	};
	const value = values[field] || "";
	if (!field || !labelByField[field]) return "";
	return `${labelByField[field]} ${value || labels.notProvided}`;
}

function currentReservationMemoryIntro(sc = {}, st = {}, field = "", hasFieldValue = false) {
	const lang = languageOf(sc, st);
	const name = respectfulGuestName(sc, st);
	if (/arabic/i.test(lang)) {
		if (field && hasFieldValue) return `${name}\u060c نعم، هذا هو التفصيل المحفوظ لدي الآن:`;
		if (field) return `${name}\u060c أفهمك. لا أرى هذا التفصيل محفوظا بشكل واضح حتى الآن.`;
		return `${name}\u060c نعم، هذه التفاصيل المحفوظة لدي في هذه المحادثة:`;
	}
	if (/spanish/i.test(lang)) {
		if (field && hasFieldValue) return `${name}, si, este es el dato que tengo guardado ahora:`;
		if (field) return `${name}, entiendo. No veo ese dato guardado con claridad todavia.`;
		return `${name}, si, estos son los datos que tengo guardados en este chat:`;
	}
	if (/french/i.test(lang)) {
		if (field && hasFieldValue) return `${name}, oui, voici le detail que j'ai actuellement:`;
		if (field) return `${name}, je comprends. Je ne vois pas encore ce detail clairement enregistre.`;
		return `${name}, oui, voici les details que j'ai dans cette conversation :`;
	}
	if (/indonesian/i.test(lang)) {
		if (field && hasFieldValue) return `${name}, ya, ini detail yang saya simpan sekarang:`;
		if (field) return `${name}, saya mengerti. Detail itu belum terlihat tersimpan dengan jelas.`;
		return `${name}, ya, ini detail yang saya simpan di chat ini:`;
	}
	if (/malay|malaysia/i.test(lang)) {
		if (field && hasFieldValue) return `${name}, ya, ini butiran yang saya simpan sekarang:`;
		if (field) return `${name}, saya faham. Butiran itu belum kelihatan tersimpan dengan jelas.`;
		return `${name}, ya, ini butiran yang saya simpan dalam chat ini:`;
	}
	if (field && hasFieldValue) return `${name}, yes, this is the detail I have saved right now:`;
	if (field) return `${name}, I understand. I do not have that detail saved clearly yet.`;
	return `${name}, yes, these are the details I have saved in this chat:`;
}

function currentReservationMemoryReplyText(sc = {}, st = {}, quote = {}, userText = "") {
	const lang = languageOf(sc, st);
	const labels = finalReservationReviewLabels(sc, st);
	const requestedField = requestedReservationMemoryField(userText);
	const requestedLine = requestedField
		? currentReservationMemoryFieldLine(sc, st, quote, requestedField)
		: "";
	const requestedHasValue =
		Boolean(requestedLine) && !new RegExp(`${labels.notProvided}$`, "i").test(requestedLine);
	const summaryFields = [
		"hotel",
		"room",
		"dates",
		"guests",
		"fullName",
		"nationality",
		"phone",
		"email",
		"price",
	];
	const rows = summaryFields
		.map((field) => currentReservationMemoryFieldLine(sc, st, quote, field))
		.filter((line) => line && !new RegExp(`${labels.notProvided}$`, "i").test(line));
	const missing = localizedMissingLabels(sc, st)
		.map((label) => String(label || "").replace(/:$/, ""))
		.filter(Boolean);
	const missingLine = missing.length
		? /arabic/i.test(lang)
			? `المتبقي: ${missing.join("، ")}`
			: /spanish/i.test(lang)
			? `Todavia necesito: ${missing.join(", ")}`
			: /french/i.test(lang)
			? `Il me manque encore : ${missing.join(", ")}`
			: `Still needed: ${missing.join(", ")}`
		: "";
	const next = bookingNextActionText(sc, st);
	return [
		currentReservationMemoryIntro(sc, st, requestedField, requestedHasValue),
		requestedLine,
		requestedLine && rows.length ? "" : "",
		...rows.filter((line) => line !== requestedLine),
		missingLine,
		next,
	]
		.filter((line) => line !== null && line !== undefined)
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

async function answerCurrentReservationMemoryQuestion(io, sc, st, userText = "", caseId = "") {
	if (!currentReservationMemoryRequestText(userText)) return false;
	applyLatestRoomSignalFromConversation(sc, st, {
		source: "memory_reply_room_signal",
	});
	const quote = ensureCurrentQuoteForSlots(st) || st.quote?.data || {};
	const previousWaitFor = st.waitFor || "";
	const reply = currentReservationMemoryReplyText(sc, st, quote, userText);
	const sent = await humanSend(io, sc, st, reply, {
		quickReplies: bookingSummaryQuickReplies(sc, st),
		fast: true,
		targetReplyMs: AI_BOOKING_PROMPT_TARGET_MS,
	});
	if (!sent) return false;
	st.waitFor = previousWaitFor || st.waitFor || nextPivot(st);
	logStep(caseId || String(sc._id || ""), "booking.current_memory_reply", {
		waitFor: st.waitFor || "",
		field: requestedReservationMemoryField(userText),
		missing: missingMandatoryReservationFields(st),
		latestUserMessage: String(userText || "").slice(0, 160),
	});
	return true;
}

function currentQuoteSummaryText(sc = {}, st = {}, quote = {}) {
	const lang = languageOf(sc, st);
	const name = respectfulGuestName(sc, st);
	const hotelName = localizedHotelName(sc, st);
	const roomName = localizedRoomName(sc, st, quote);
	const dates = localizedStayDateLines(sc, st);
	const total = quote?.totals?.totalPriceWithCommission;
	const nights = Number(quote?.nights || 0);
	const perNight =
		nights && total
			? Math.round((Number(total) / Math.max(1, nights)) * 100) / 100
			: null;
	const totalText = total ? localizedMoney(total, quote.currency, lang) : "";
	const nightText = localizedNightCount(nights, lang);
	const dateText = [dates.primary, dates.secondary].filter(Boolean).join(" (") +
		(dates.secondary ? ")" : "");
	const next = bookingNextActionText(sc, st);
	if (/arabic/i.test(lang)) {
		const perNightText = perNight
			? ` \u0645\u062a\u0648\u0633\u0637 \u0627\u0644\u0644\u064a\u0644\u0629 ${localizedMoney(perNight, quote.currency, lang)}.`
			: "";
		return `${name}\u060c \u0627\u0644\u0633\u0639\u0631 \u0627\u0644\u062d\u0627\u0644\u064a \u0644\u0640 ${roomName} \u0641\u064a ${hotelName}: ${totalText} \u0625\u062c\u0645\u0627\u0644\u064a\u0627 \u0644\u0645\u062f\u0629 ${nightText} (${dateText}).${perNightText} ${next}`;
	}
	const perNightText = perNight
		? ` The average is ${localizedMoney(perNight, quote.currency, lang)} per night.`
		: "";
	return `${name}, the current price for ${roomName} at ${hotelName} is ${totalText} total for ${nightText} (${dateText}).${perNightText} ${next}`;
}

function currentReservationSummaryText(sc = {}, st = {}, quote = {}) {
	const lang = languageOf(sc, st);
	const name = respectfulGuestName(sc, st);
	const hotelName = localizedHotelName(sc, st);
	const roomName = localizedRoomName(sc, st, quote);
	const dates = localizedStayDateLines(sc, st);
	const total = quote?.totals?.totalPriceWithCommission;
	const nights = localizedNightCount(quote?.nights || 0, lang);
	const totalText = total ? localizedMoney(total, quote.currency, lang) : "";
	const guestName = hasUsableFullName(st.slots?.fullName || st.slots?.name || "")
		? st.slots?.fullName || st.slots?.name || ""
		: "";
	const nationality = storedNationalityForDisplay(st, lang);
	const phone = cleanPhoneCandidate(st.slots?.phone || "");
	const guestCount = bookingGuestCountText(sc, st);
	const guestDetails = [
		guestName,
		nationality,
		phone,
		guestCount,
	].filter(Boolean);
	const missing = localizedMissingLabels(sc, st)
		.map((label) => String(label || "").replace(/:$/, ""))
		.filter(Boolean);
	const next = bookingNextActionText(sc, st);
	if (/arabic/i.test(lang)) {
		return [
			`${name}\u060c \u0645\u0644\u062e\u0635 \u0627\u0644\u062d\u062c\u0632 \u0627\u0644\u062d\u0627\u0644\u064a:`,
			`\u0627\u0644\u0641\u0646\u062f\u0642: ${hotelName}`,
			`\u0627\u0644\u063a\u0631\u0641\u0629: ${roomName}`,
			`\u0627\u0644\u062a\u0648\u0627\u0631\u064a\u062e: ${dates.primary}${dates.secondary ? ` (${dates.secondary})` : ""}`,
			nights && totalText ? `\u0627\u0644\u0633\u0639\u0631: ${totalText} \u0644\u0645\u062f\u0629 ${nights}` : "",
			guestDetails.length
				? `\u0628\u064a\u0627\u0646\u0627\u062a \u0627\u0644\u0636\u064a\u0641: ${guestDetails.join(" - ")}`
				: "",
			missing.length ? `\u0627\u0644\u0645\u062a\u0628\u0642\u064a: ${missing.join("\u060c ")}` : "",
			next,
		]
			.filter(Boolean)
			.join("\n");
	}
	return [
		`${name}, here is the current booking summary:`,
		`Hotel: ${hotelName}`,
		`Room: ${roomName}`,
		`Dates: ${dates.primary}${dates.secondary ? ` (${dates.secondary})` : ""}`,
		nights && totalText ? `Price: ${totalText} for ${nights}` : "",
		guestDetails.length ? `Guest details: ${guestDetails.join(" - ")}` : "",
		missing.length ? `Still needed: ${missing.join(", ")}` : "",
		next,
	]
		.filter(Boolean)
		.join("\n");
}

function postBookingReservationSummaryText(sc = {}, st = {}, quote = {}, ref = null) {
	const lang = languageOf(sc, st);
	const hotelName = localizedHotelName(sc, st);
	const roomName = localizedRoomName(sc, st, quote || {});
	const dates =
		st.slots?.checkinISO && st.slots?.checkoutISO
			? localizedStayDateLines(sc, st)
			: { primary: "", secondary: "" };
	const total = Number(
		quote?.totals?.totalPriceWithCommission || quote?.total || quote?.totalPrice || 0
	);
	const currency = cleanCurrency(quote?.currency || "SAR");
	const nights = localizedNightCount(quote?.nights || 0, lang);
	const totalText =
		Number.isFinite(total) && total > 0 ? localizedMoney(total, currency, lang) : "";
	const links = ref ? reservationLinks(ref) : {};
	const confirmation =
		ref?.confirmation_number || sc.aiReservation?.confirmationNumber || "";
	const guestCount = bookingGuestCountText(sc, st);
	const guestName = st.slots?.fullName || "";

	if (/arabic/i.test(lang)) {
		return [
			"\u0623\u0643\u064a\u062f\u060c \u0647\u0630\u0647 \u062a\u0641\u0627\u0635\u064a\u0644 \u062d\u062c\u0632\u0643:",
			confirmation ? `\u0631\u0642\u0645 \u0627\u0644\u062a\u0623\u0643\u064a\u062f: **${confirmation}**.` : "",
			`\u0627\u0644\u0641\u0646\u062f\u0642: ${hotelName}.`,
			roomName ? `\u0627\u0644\u063a\u0631\u0641\u0629: ${roomName}.` : "",
			dates.primary
				? `\u0627\u0644\u062a\u0648\u0627\u0631\u064a\u062e: ${dates.primary}${
						dates.secondary ? ` (${dates.secondary})` : ""
				  }.`
				: "",
			totalText
				? `\u0627\u0644\u0625\u062c\u0645\u0627\u0644\u064a: **${totalText}**${
						nights ? ` \u0644\u0645\u062f\u0629 ${nights}` : ""
				  }.`
				: "",
			guestName || guestCount
				? `\u0628\u064a\u0627\u0646\u0627\u062a \u0627\u0644\u0636\u064a\u0641: ${[
						guestName,
						guestCount,
				  ]
						.filter(Boolean)
						.join(" - ")}.`
				: "",
			links.reservationDetails
				? `[\u062a\u0641\u0627\u0635\u064a\u0644 \u0627\u0644\u062d\u062c\u0632](${links.reservationDetails})`
				: "",
			links.payment ? `[\u0631\u0627\u0628\u0637 \u0627\u0644\u062f\u0641\u0639](${links.payment})` : "",
		]
			.filter(Boolean)
			.join("\n");
	}

	return [
		"Of course. Here are your booking details:",
		confirmation ? `Confirmation number: **${confirmation}**.` : "",
		`Hotel: ${hotelName}.`,
		roomName ? `Room: ${roomName}.` : "",
		dates.primary
			? `Dates: ${dates.primary}${dates.secondary ? ` (${dates.secondary})` : ""}.`
			: "",
		totalText ? `Total: **${totalText}**${nights ? ` for ${nights}` : ""}.` : "",
		guestName || guestCount
			? `Guest details: ${[guestName, guestCount].filter(Boolean).join(" - ")}.`
			: "",
		links.reservationDetails
			? `[Reservation details](${links.reservationDetails})`
			: "",
		links.payment ? `[Payment link](${links.payment})` : "",
	]
		.filter(Boolean)
		.join("\n");
}

async function answerPostBookingStateQuestion(io, sc, st, userText = "") {
	if (
		!bookingStateQuestionText(userText) &&
		!postBookingGeneralSummaryQuestionText(userText)
	) {
		return false;
	}
	const ref = aiReservationReference(sc);
	if (!ref) return false;
	const quote = ensureCurrentQuoteForSlots(st) || {};
	await humanSend(io, sc, st, postBookingReservationSummaryText(sc, st, quote, ref), {
		fast: true,
		targetReplyMs: AI_BOOKING_PROMPT_TARGET_MS,
	});
	st.waitFor = "post_booking_followup";
	logStep(String(sc._id || ""), "post_booking.state_reply", {
		confirmation: ref.confirmation_number || "",
		hasQuote: Boolean(quote?.available),
		latestUserMessage: String(userText || "").slice(0, 160),
	});
	return true;
}

function preBookingConfirmationPendingText(sc = {}, st = {}) {
	const lang = languageOf(sc, st);
	if (/arabic/i.test(lang)) {
		return "\u0644\u0645 \u064a\u062a\u0645 \u0625\u0646\u0634\u0627\u0621 \u0627\u0644\u062d\u062c\u0632 \u0628\u0639\u062f\u060c \u0644\u0630\u0644\u0643 \u0644\u0627 \u064a\u0648\u062c\u062f \u0631\u0642\u0645 \u062a\u0623\u0643\u064a\u062f \u062d\u062a\u0649 \u0627\u0644\u0622\u0646.";
	}
	if (/spanish/i.test(lang)) {
		return "La reserva aun no esta creada, asi que todavia no hay numero de confirmacion.";
	}
	if (/french/i.test(lang)) {
		return "La reservation n'est pas encore creee, donc il n'y a pas encore de numero de confirmation.";
	}
	if (/indonesian/i.test(lang)) {
		return "Reservasi belum dibuat, jadi belum ada nomor konfirmasi.";
	}
	if (/malay|malaysia/i.test(lang)) {
		return "Tempahan belum dibuat, jadi belum ada nombor pengesahan.";
	}
	return "The reservation is not created yet, so there is no confirmation number yet.";
}

async function answerPreBookingConfirmationQuestion(
	io,
	sc,
	st,
	userText = "",
	caseId = ""
) {
	if (!confirmationNumberQuestionText(userText)) return false;
	if (aiReservationReference(sc)) return false;
	if (!isNewReservationFlowActive(st)) return false;
	const hasAllDetails = hasMandatoryReservationDetails(st);
	const followup = hasAllDetails
		? finalReservationPrompt(sc, st)
		: mandatoryDetailsPrompt(sc, st, { retry: true });
	await humanSend(io, sc, st, `${preBookingConfirmationPendingText(sc, st)}\n${followup}`, {
		fast: true,
		quickReplies: hasAllDetails ? finalReservationQuickReplies(sc, st) : [],
	});
	logStep(caseId || String(sc._id || ""), "booking.pre_confirmation_state_reply", {
		waitFor: st.waitFor || "",
		missing: missingMandatoryReservationFields(st),
	});
	return true;
}

async function answerFastBookingStateQuestion(io, sc, st, userText = "", caseId = "") {
	if (
		!st.hotel ||
		st.waitFor === "post_booking_followup" ||
		sc.aiReservation?.reservationId ||
		sc.aiReservation?.confirmationNumber
	) {
		return false;
	}
	const wantsPrice = repeatPriceQuestionText(userText);
	const wantsDetails = currentReservationMemoryRequestText(userText);
	if (!wantsPrice && !wantsDetails) return false;
	if (wantsDiscountQuestion(userText) || wantsPaymentHelp(userText)) return false;
	applyLatestRoomSignalFromConversation(sc, st, {
		source: "fast_state_room_signal",
	});
	const quote = ensureCurrentQuoteForSlots(st);
	if (!quote?.available) return false;
	const previousWaitFor = st.waitFor || null;
	const shouldAdvanceToProceed =
		!["proceed", "reviewConfirm", "finalize"].includes(previousWaitFor || "") &&
		!isReservationDetailStep(st);
	if (shouldAdvanceToProceed) st.waitFor = "proceed";
	const reply = wantsDetails
		? currentReservationSummaryText(sc, st, quote)
		: currentQuoteSummaryText(sc, st, quote);
	const sent = await humanSend(io, sc, st, reply, {
		quickReplies: bookingSummaryQuickReplies(sc, st),
		fast: true,
	});
	if (!sent) {
		st.waitFor = previousWaitFor || st.waitFor;
		return false;
	}
	if (!shouldAdvanceToProceed) {
		st.waitFor = previousWaitFor || st.waitFor || nextPivot(st);
	}
	logStep(caseId || String(sc._id || ""), "booking.fast_state_reply", {
		kind: wantsDetails ? "details" : "price",
		waitFor: st.waitFor || "",
	});
	return true;
}

function hijriGregorianDateLine(sc = {}, st = {}) {
	const display = stayDateDisplay(st);
	if (!display.hijri?.checkin || !display.hijri?.checkout) return "";
	if (/arabic/i.test(languageOf(sc, st))) {
		const dates = localizedStayDateLines(sc, st);
		return `\u0627\u0644\u062a\u0648\u0627\u0631\u064a\u062e: ${dates.primary} (${dates.secondary})`;
	}
	const gregorianLine = `${display.gregorian.checkin || display.gregorian.checkinISO} to ${
		display.gregorian.checkout || display.gregorian.checkoutISO
	}`;
	const hijriLine = `${display.hijri.checkin} to ${display.hijri.checkout}`;
	if (/arabic/i.test(languageOf(sc, st))) {
		return `التواريخ: ${hijriLine} (الميلادي: ${gregorianLine})`;
	}
	return `Dates: ${hijriLine} (Gregorian/Miladi: ${gregorianLine})`;
}

function ensureHijriGregorianDatesVisible(text = "", sc = {}, st = {}) {
	const line = hijriGregorianDateLine(sc, st);
	if (!line) return text;
	const current = String(text || "").trim();
	const haystack = current.toLowerCase();
	const hasHijri = /hijri|ah|ramadan|\u0631\u0645\u0636\u0627\u0646/.test(haystack);
	const hasGregorian =
		/gregorian|miladi|\b20\d{2}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\/20\d{2}\b|\u0645\u064a\u0644\u0627\u062f/i.test(
			current
		);
	if (hasHijri && hasGregorian) return current;
	return [current, line].filter(Boolean).join("\n");
}

function buildReservationReviewPayload(st = {}, quote = {}) {
	return {
		hotel: toTitle(st.hotel?.hotelName || "Hotel"),
		hotelLocalized: localizedHotelName({}, st),
		room: quote.room?.displayName || quote.room?.roomType || st.slots.roomTypeKey,
		roomLocalized: localizedRoomName({}, st, quote),
		roomsCount: st.slots.rooms || 1,
		currency: quote.currency,
		nights: quote.nights,
		totals: quote.totals,
		perNightAvg:
			Math.round(
				(quote.totals.totalPriceWithCommission / Math.max(1, quote.nights)) * 100
			) / 100,
		gregorian: {
			checkin: usDate(st.slots.checkinISO),
			checkout: usDate(st.slots.checkoutISO),
		},
		dateDisplay: stayDateDisplay(st),
		rawDates: st.dateRaw,
	};
}

function reservationReviewPrompt(sc = {}, st = {}) {
	if (/arabic/i.test(languageOf(sc, st))) {
		return [
			"Present a brief reservation review entirely in Arabic.",
			"Use the localized hotel and room names from context when available.",
			"If raw dates were Hijri, show the Hijri range and the matching Gregorian range.",
			"Use Arabic wording for money, e.g. \"\u0631\u064a\u0627\u0644 \u0633\u0639\u0648\u062f\u064a\", not SAR.",
			"End with Arabic only: \"\u0625\u0630\u0627 \u0643\u0644 \u0634\u064a\u0621 \u0635\u062d\u064a\u062d\u060c \u0627\u062e\u062a\u0631 \\\"\u062a\u0623\u0643\u064a\u062f\\\". \u0648\u0625\u0630\u0627 \u0647\u0646\u0627\u0643 \u0623\u064a \u062a\u0639\u062f\u064a\u0644\u060c \u0627\u062e\u062a\u0631 \\\"\u0647\u0646\u0627\u0643 \u0634\u064a\u0621 \u063a\u064a\u0631 \u0635\u062d\u064a\u062d\\\".\"",
			"Do not use the English word confirm.",
		].join(" ");
	}
	return "Present a brief 'Reservation review'. If raw dates were Hijri, show them alongside Gregorian. End with: 'Choose Confirm if everything looks correct, or Something is wrong if we need to fix anything.' Do not repeat the earlier availability message.";
}

function deterministicArabicReservationReview(sc = {}, st = {}, quote = {}) {
	if (!/arabic/i.test(languageOf(sc, st)) || !quote?.available) return "";
	const dates = localizedStayDateLines(sc, st);
	const total = quote.totals?.totalPriceWithCommission;
	const perNight =
		quote.nights && total
			? Math.round((total / Math.max(1, quote.nights)) * 100) / 100
			: null;
	const lines = [
		`${respectfulGuestName(
			sc,
			st
		)}\u060c \u0647\u0630\u0647 \u0645\u0631\u0627\u062c\u0639\u0629 \u0633\u0631\u064a\u0639\u0629 \u0644\u062a\u0641\u0627\u0635\u064a\u0644 \u0627\u0644\u062d\u062c\u0632:`,
		`\u0627\u0644\u0641\u0646\u062f\u0642: ${localizedHotelName(sc, st)}`,
		`\u0627\u0644\u063a\u0631\u0641\u0629: ${localizedRoomName(sc, st, quote)}`,
		`\u0627\u0644\u062a\u0648\u0627\u0631\u064a\u062e: ${dates.primary}`,
		dates.secondary ? dates.secondary : "",
		quote.nights
			? `\u0639\u062f\u062f \u0627\u0644\u0644\u064a\u0627\u0644\u064a: ${localizedNumber(
					quote.nights,
					"Arabic"
			  )}`
			: "",
		perNight
			? `\u0627\u0644\u0633\u0639\u0631: ${localizedMoney(
					perNight,
					quote.currency,
					"Arabic"
			  )} \u0644\u0644\u064a\u0644\u0629`
			: "",
		total
			? `\u0627\u0644\u0625\u062c\u0645\u0627\u0644\u064a: ${localizedMoney(
					total,
					quote.currency,
					"Arabic"
			  )}`
			: "",
		`\u0625\u0630\u0627 \u0643\u0644 \u0634\u064a\u0621 \u0635\u062d\u064a\u062d\u060c \u0627\u062e\u062a\u0631 "\u062a\u0623\u0643\u064a\u062f". \u0648\u0625\u0630\u0627 \u0647\u0646\u0627\u0643 \u0623\u064a \u062a\u0639\u062f\u064a\u0644\u060c \u0627\u062e\u062a\u0631 "\u0647\u0646\u0627\u0643 \u0634\u064a\u0621 \u063a\u064a\u0631 \u0635\u062d\u064a\u062d".`,
	];
	return lines.filter(Boolean).join("\n");
}

function finalReviewActionLabels(sc = {}, st = {}) {
	const replies = finalReservationQuickReplies(sc, st);
	return {
		create: replies?.[0]?.label || "Complete Reservation",
		correct: replies?.[1]?.label || "There's Something Wrong",
	};
}

function finalReservationReviewLabels(sc = {}, st = {}) {
	const lang = languageOf(sc, st);
	const actions = finalReviewActionLabels(sc, st);
	if (/arabic/i.test(lang)) {
		return {
			title: "\u0647\u0630\u0647 \u0645\u0631\u0627\u062c\u0639\u0629 \u0646\u0647\u0627\u0626\u064a\u0629 \u0645\u062e\u062a\u0635\u0631\u0629 \u0642\u0628\u0644 \u0625\u0646\u0634\u0627\u0621 \u0627\u0644\u062d\u062c\u0632:",
			hotel: "\u0627\u0644\u0641\u0646\u062f\u0642:",
			room: "\u0627\u0644\u063a\u0631\u0641\u0629:",
			dates: "\u0627\u0644\u062a\u0648\u0627\u0631\u064a\u062e:",
			nights: "\u0639\u062f\u062f \u0627\u0644\u0644\u064a\u0627\u0644\u064a:",
			guestCount: "\u0627\u0644\u0636\u064a\u0648\u0641:",
			guestName: "\u0627\u0633\u0645 \u0627\u0644\u0636\u064a\u0641:",
			nationality: "\u0627\u0644\u062c\u0646\u0633\u064a\u0629:",
			phone: "\u0627\u0644\u0647\u0627\u062a\u0641:",
			email: "\u0627\u0644\u0628\u0631\u064a\u062f:",
			perNight: "\u0627\u0644\u0633\u0639\u0631 \u0644\u0644\u064a\u0644\u0629:",
			total: "\u0627\u0644\u0625\u062c\u0645\u0627\u0644\u064a:",
			notProvided: "\u063a\u064a\u0631 \u0645\u0636\u0627\u0641",
			cta: `\u0625\u0630\u0627 \u0643\u0644 \u0634\u064a\u0621 \u0635\u062d\u064a\u062d\u060c \u0627\u062e\u062a\u0631 "${actions.create}". \u0648\u0625\u0630\u0627 \u0647\u0646\u0627\u0643 \u062a\u0639\u062f\u064a\u0644\u060c \u0627\u062e\u062a\u0631 "${actions.correct}".`,
		};
	}
	if (/spanish/i.test(lang)) {
		return {
			title: "aqui tienes la revision final antes de crear la reserva:",
			hotel: "Hotel:",
			room: "Habitacion:",
			dates: "Fechas:",
			nights: "Noches:",
			guestCount: "Huespedes:",
			guestName: "Nombre del huesped:",
			nationality: "Nacionalidad:",
			phone: "Telefono:",
			email: "Email:",
			perNight: "Precio por noche:",
			total: "Total:",
			notProvided: "no agregado",
			cta: `Si todo esta correcto, elige "${actions.create}". Si hay algo que corregir, elige "${actions.correct}".`,
		};
	}
	if (/french/i.test(lang)) {
		return {
			title: "voici la verification finale avant de creer la reservation :",
			hotel: "Hotel :",
			room: "Chambre :",
			dates: "Dates :",
			nights: "Nuits :",
			guestCount: "Voyageurs :",
			guestName: "Nom du client :",
			nationality: "Nationalite :",
			phone: "Telephone :",
			email: "Email :",
			perNight: "Prix par nuit :",
			total: "Total :",
			notProvided: "non ajoute",
			cta: `Si tout est correct, choisissez "${actions.create}". Si un detail doit etre corrige, choisissez "${actions.correct}".`,
		};
	}
	if (/indonesian/i.test(lang)) {
		return {
			title: "berikut ringkasan akhir sebelum reservasi dibuat:",
			hotel: "Hotel:",
			room: "Kamar:",
			dates: "Tanggal:",
			nights: "Malam:",
			guestCount: "Tamu:",
			guestName: "Nama tamu:",
			nationality: "Kewarganegaraan:",
			phone: "Telepon:",
			email: "Email:",
			perNight: "Harga per malam:",
			total: "Total:",
			notProvided: "tidak ditambahkan",
			cta: `Jika semuanya benar, pilih "${actions.create}". Jika ada yang perlu diperbaiki, pilih "${actions.correct}".`,
		};
	}
	if (/malay/i.test(lang)) {
		return {
			title: "ini semakan akhir sebelum tempahan dibuat:",
			hotel: "Hotel:",
			room: "Bilik:",
			dates: "Tarikh:",
			nights: "Malam:",
			guestCount: "Tetamu:",
			guestName: "Nama tetamu:",
			nationality: "Kewarganegaraan:",
			phone: "Telefon:",
			email: "Email:",
			perNight: "Harga setiap malam:",
			total: "Jumlah:",
			notProvided: "tidak ditambah",
			cta: `Jika semuanya betul, pilih "${actions.create}". Jika ada butiran perlu dibetulkan, pilih "${actions.correct}".`,
		};
	}
	return {
		title: "here is the final review before I create the reservation:",
		hotel: "Hotel:",
		room: "Room:",
		dates: "Dates:",
		nights: "Nights:",
		guestCount: "Guests:",
		guestName: "Guest name:",
		nationality: "Nationality:",
		phone: "Phone:",
		email: "Email:",
		perNight: "Price per night:",
		total: "Total:",
		notProvided: "not added",
		cta: `If everything looks correct, choose "${actions.create}". If anything needs fixing, choose "${actions.correct}".`,
	};
}

function deterministicFinalReservationReview(sc = {}, st = {}, quote = {}) {
	if (!quote?.available) return "";
	const lang = languageOf(sc, st);
	const labels = finalReservationReviewLabels(sc, st);
	const dates = localizedStayDateLines(sc, st);
	const total = quote.totals?.totalPriceWithCommission;
	const perNight =
		quote.nights && total
			? Math.round((total / Math.max(1, quote.nights)) * 100) / 100
			: null;
	const fullName = String(st.slots?.fullName || st.slots?.name || "").trim();
	const nationality = storedNationalityForDisplay(st, lang);
	const phone = String(st.slots?.phone || "").trim();
	const email = String(st.slots?.email || "").trim();
	const guestCount = bookingGuestCountText(sc, st);
	const prefix = /arabic/i.test(lang)
		? `${respectfulGuestName(sc, st)}\u060c ${labels.title}`
		: `${respectfulGuestName(sc, st)}, ${labels.title}`;
	const lines = [
		prefix,
		`${labels.hotel} ${localizedHotelName(sc, st)}`,
		`${labels.room} ${localizedRoomName(sc, st, quote)}`,
		`${labels.dates} ${dates.primary}`,
		dates.secondary ? dates.secondary : "",
		quote.nights ? `${labels.nights} ${localizedNightCount(quote.nights, lang)}` : "",
		guestCount ? `${labels.guestCount} ${guestCount}` : "",
		fullName ? `${labels.guestName} ${fullName}` : "",
		nationality ? `${labels.nationality} ${nationality}` : "",
		phone ? `${labels.phone} ${phone}` : "",
		`${labels.email} ${email || labels.notProvided}`,
		perNight ? `${labels.perNight} ${localizedMoney(perNight, quote.currency, lang)}` : "",
		total ? `${labels.total} ${localizedMoney(total, quote.currency, lang)}` : "",
		labels.cta,
	];
	return lines.filter(Boolean).join("\n");
}

async function composeReservationReviewText(io, sc, st, quote, reviewPayload) {
	const finalReview = deterministicFinalReservationReview(sc, st, quote);
	if (finalReview) return finalReview;
	const deterministic = deterministicArabicReservationReview(sc, st, quote);
	if (deterministic) return deterministic;
	if (/english/i.test(languageOf(sc, st))) {
		return ensureHijriGregorianDatesVisible(
			fallbackWriterText(
				sc,
				st,
				reservationReviewPrompt(sc, st),
				reviewPayload || buildReservationReviewPayload(st, quote),
				respectfulGuestName(sc, st)
			),
			sc,
			st
		);
	}
	let reviewText = await write(
		io,
		sc,
		st,
		reservationReviewPrompt(sc, st),
		reviewPayload || buildReservationReviewPayload(st, quote)
	);
	return ensureHijriGregorianDatesVisible(reviewText, sc, st);
}

async function sendReservationReview(
	io,
	sc,
	st,
	quote = null,
	{ fast = false, targetReplyMs = AI_BOOKING_PROMPT_TARGET_MS } = {}
) {
	applyLatestRoomSignalFromConversation(sc, st, {
		source: "review_guard_room_signal",
	});
	let q = quote || st.quote?.data;
	if (
		q?.room?.roomType &&
		st.slots?.roomTypeKey &&
		q.room.roomType !== st.slots.roomTypeKey
	) {
		q = null;
	}
	if (
		!q?.available &&
		st.hotel &&
		st.slots?.roomTypeKey &&
		st.slots?.checkinISO &&
		st.slots?.checkoutISO
	) {
		const rebuiltQuote = safePriceRoomForStay(
			st.hotel,
			{ roomType: st.slots.roomTypeKey },
			st.slots.checkinISO,
			st.slots.checkoutISO
		);
		if (rebuiltQuote?.available) {
			q = rebuiltQuote;
			st.quote = {
				key: quoteKeyForSlots(st),
				at: now(),
				data: rebuiltQuote,
			};
			logStep(String(sc._id), "review.quote_rebuilt", {
				roomTypeKey: st.slots.roomTypeKey,
				checkinISO: st.slots.checkinISO,
				checkoutISO: st.slots.checkoutISO,
			});
		}
	}
	if (!q?.available) {
		await handoffToHuman(io, sc, st, "reservation_finalize_failed");
		return true;
	}
	const reviewPayload = buildReservationReviewPayload(st, q);
	logStep(String(sc._id), "review.summaryBuilt", reviewPayload);
	const reviewText = await composeReservationReviewText(io, sc, st, q, reviewPayload);
	const sent = await humanSend(io, sc, st, reviewText, {
		quickReplies: finalReservationQuickReplies(sc, st),
		fast,
		targetReplyMs,
	});
	if (!sent) return false;
	st.reviewSent = true;
	st.waitFor = "finalize";
	st.finalReviewSentAt = now();
	stampAsk(st, "finalize");
	return true;
}

async function beginReservationDetailsAfterQuote(
	io,
	sc,
	st,
	caseId = "",
	{ fast = false } = {}
) {
	st.reviewSent = false;
	st.finalReviewSentAt = 0;
	st.waitFor = nextReservationDetailStep(st);
	logStep(caseId || String(sc._id || ""), "reservation_details.started_after_quote", {
		waitFor: st.waitFor,
		missing: missingMandatoryReservationFields(st),
	});
	if (st.waitFor === "finalize") {
		return sendReservationReview(io, sc, st, st.quote?.data, {
			fast,
			targetReplyMs: AI_BOOKING_PROMPT_TARGET_MS,
		});
	}
	await askForReservationDetail(io, sc, st, st.waitFor, {
		fast,
		targetReplyMs: AI_BOOKING_PROMPT_TARGET_MS,
	});
	return true;
}

function latestGuestAcceptedProceedAction(sc = {}, userText = "") {
	const action = lastGuestAction(sc).toLowerCase();
	if (action === "proceed") return true;
	const assistant = lastAssistantMessageBeforeLatestGuest(sc);
	return Boolean(assistantMessageSuggestsProceed(assistant) && confirmsText(userText));
}

function explicitProceedCommandText(text = "") {
	const { lower, arabic, latinCompact } = normalizeControlText(text);
	return (
		/\b(?:proceed|continue|go ahead|book it|book this|book the room|book a room|book one|book one room|book the double|reserve it|reserve this|reserve the room|reserve a room|reserve one|reserve one room|reserve the double|make a reservation|make the reservation|make this reservation|make my reservation|make our reservation|create a reservation|start the reservation|finalize|complete booking|complete reservation|confirm booking|confirm reservation)\b/i.test(
			lower
		) ||
		/\b(?:can|could|may)\s+(?:i|we)\s+(?:book|reserve)\b/i.test(
			lower
		) ||
		/\b(?:i|we)\s+(?:want|would like|need)\s+to\s+(?:book|reserve)\b/i.test(
			lower
		) ||
		/\b(?:i|we)\s+(?:want|would like|need)\s+to\s+make\s+(?:a|the|this|my|our)?\s*reservation\b/i.test(
			lower
		) ||
		/(?:\u0627\u062d\u062c\u0632|\u0627\u0643\u062f|\u0623\u0643\u062f|\u0643\u0645\u0644|\u0627\u0643\u0645\u0644|\u062a\u0627\u0628\u0639|\u062b\u0628\u062a).{0,32}(?:\u0627\u0644\u062d\u062c\u0632|\u062d\u062c\u0632|\u0627\u0644\u063a\u0631\u0641\u0629|\u0627\u0644\u063a\u0631\u0641\u0647)/i.test(
			arabic
		) ||
		/(?:goahead|bookit|bookthis|booktheroom|bookaroom|bookone|bookoneroom|reserveit|reservethis|reservetheroom|reservearoom|reserveone|reserveoneroom|canireserve|canwereserve|canibook|canwebook|iwanttoreserve|wewanttoreserve|iwanttobook|wewanttobook|iwouldliketoreserve|wewouldliketoreserve|iwouldliketobook|wewouldliketobook|iwanttomakeareservation|wewanttomakeareservation|iwanttomakethereservation|wewanttomakethereservation|iwanttomakethisreservation|wewanttomakethisreservation|makeareservation|makethereservation|makethisreservation|makemyreservation|makeourreservation|createareservation|startthereservation|finalizethis|completebooking|completereservation|confirmbooking|confirmreservation|proceedbooking|continuebooking)/i.test(
			latinCompact
		)
	);
}

function proceedReadyQuestionText(sc = {}, st = {}) {
	const lang = languageOf(sc, st);
	const name = respectfulGuestName(sc, st);
	if (/arabic/i.test(lang)) {
		return `${name}\u060c \u0627\u0644\u0633\u0639\u0631 \u0648\u0627\u0644\u062a\u0648\u0641\u0631 \u062c\u0627\u0647\u0632\u0627\u0646. \u0647\u0644 \u0623\u062a\u0627\u0628\u0639 \u0645\u0639 \u062a\u0641\u0627\u0635\u064a\u0644 \u0627\u0644\u062d\u062c\u0632\u061f`;
	}
	if (/spanish/i.test(lang)) {
		return `${name}, la cotizacion esta lista. Quieres que continue con los datos de la reserva?`;
	}
	if (/french/i.test(lang)) {
		return `${name}, le devis est pret. Souhaitez-vous que je continue avec les details de la reservation ?`;
	}
	if (/urdu|hindi/i.test(lang)) {
		return `${name}, quote ready hai. Kya main reservation details ke saath continue karun?`;
	}
	return `${name}, the quote is ready. Shall I continue with the reservation details?`;
}

function proceedStageDirectInformationRequest(sc = {}, st = {}, userText = "", lu = {}) {
	const text = String(userText || "").trim();
	if (!text) return false;
	return Boolean(
		wantsPaymentHelp(text) ||
			wantsDiscountQuestion(text) ||
			hotelContactDetailsQuestionText(text) ||
			hotelContactFollowupQuestionText(sc, text) ||
			selectedHotelFactQuestionText(text) ||
			selectedHotelRoomQuestionText(text) ||
			lu?.amenity ||
			detectAmenityQuestion(text) ||
			(st.hotel && directHotelRelationshipQuestionText(text)) ||
			(st.hotel && crossHotelRequestText(text)) ||
			broadGeneralSupportQuestionText(text, st, lu) ||
			genericOpenAiQuestionText(text, st, lu)
	);
}

async function handleProceedStageInput(
	io,
	sc,
	st,
	userText,
	lu = {},
	{ allowGeneric = true } = {}
) {
	const acceptedProceed = latestGuestAcceptedProceedAction(sc, userText);
	if (st.waitFor !== "proceed" && !acceptedProceed) return false;
	applyLatestRoomSignalFromConversation(sc, st, {
		source: "proceed_guard_room_signal",
	});
	const quote = ensureCurrentQuoteForSlots(st);
	if (!quote) return false;
	const directInfoRequest = proceedStageDirectInformationRequest(sc, st, userText, lu);
	if (!quote.available) {
		if (!directInfoRequest && (acceptedProceed || quoteConfirmationText(userText, st))) {
			return sendUnavailableRoomRecovery(io, sc, st, quote);
		}
		return false;
	}
	st.waitFor = "proceed";
	const wantsQuoteRepeat = repeatPriceQuestionText(userText);
	const wantsBookingDetails = currentReservationMemoryRequestText(userText);
	if (
		(wantsQuoteRepeat || wantsBookingDetails) &&
		!wantsDiscountQuestion(userText) &&
		!wantsPaymentHelp(userText)
	) {
		const reply = wantsBookingDetails
			? currentReservationSummaryText(sc, st, quote)
			: currentQuoteSummaryText(sc, st, quote);
		await humanSend(io, sc, st, reply, {
			quickReplies: bookingSummaryQuickReplies(sc, st),
			fast: true,
		});
		logStep(String(sc._id || ""), "proceed.fast_state_reply", {
			kind: wantsBookingDetails ? "details" : "price",
		});
		return true;
	}
	if (directInfoRequest && !explicitProceedCommandText(userText)) return false;
	if (acceptedProceed || quoteConfirmationText(userText, st)) {
		resumeBookingNudge(st);
		return beginReservationDetailsAfterQuote(io, sc, st, String(sc._id || ""), {
			fast: true,
		});
	}
	if (directInfoRequest) return false;
	if (declinesText(userText)) {
		pauseBookingNudge(st);
		const msg = await write(
			io,
			sc,
			st,
			"Acknowledge politely that there is no rush. Offer to help with different dates, another room type, or hotel details. Do not repeat the quote and do not push the reservation details step.",
			{ quote: st.quote.data, slots: st.slots }
		);
		await humanSend(io, sc, st, msg);
		return true;
	}
	if (patienceText(userText)) {
		pauseBookingNudge(st);
		const msg = await write(
			io,
			sc,
			st,
			"Thank the guest naturally and say there is no rush. Mention that the quote is ready and they can say yes when they want to continue. Do not repeat the price.",
			{ quoteReady: true, nextStep: "collect_reservation_details" }
		);
		await humanSend(io, sc, st, msg);
		return true;
	}
	if (asksAiIdentity(userText) || botExperienceComplaintText(userText)) {
		const msg = await write(
			io,
			sc,
			st,
			"Answer the guest's concern transparently and warmly. If they ask whether you are human or AI, say you are AI-assisted support monitored by the team; do not claim to be human. Apologize briefly if the speed or repetition felt unnatural. Say the quote is ready and ask whether to continue with the reservation details. Do not repeat the full quote.",
			{ quoteReady: true, nextStep: "collect_reservation_details" }
		);
		await humanSend(io, sc, st, msg);
		return true;
	}
	if (lu.intent === "smalltalk" || looksLikeGreetingOnly(userText)) {
		return handleSmalltalk(io, sc, st, lu, userText);
	}
	if (!allowGeneric) return false;
	const msg = proceedReadyQuestionText(sc, st);
	await humanSend(io, sc, st, msg, {
		quickReplies: proceedQuickReplies(sc, st),
		fast: true,
		targetReplyMs: AI_BOOKING_PROMPT_TARGET_MS,
	});
	return true;
}

function publicBaseUrl() {
	return String(
		process.env.CLIENT_URL ||
			process.env.REACT_APP_MAIN_URL_JANNAT ||
			"https://jannatbooking.com"
	).replace(/\/+$/, "");
}

function reservationLinks(reservation) {
	const publicBase = publicBaseUrl();
	const confirmation = String(reservation?.confirmation_number || "").trim();
	const id = String(reservation?._id || reservation?.id || "").trim();
	return {
		reservationDetails: confirmation
			? `${publicBase}/single-reservation/${confirmation}`
			: "",
		payment: id && confirmation ? `${publicBase}/client-payment/${id}/${confirmation}` : "",
	};
}

function aiReservationReference(sc = {}, reservation = {}) {
	const ai = sc.aiReservation || {};
	const id =
		reservation?._id ||
		reservation?.id ||
		ai.reservationId ||
		ai.reservation?._id ||
		ai.reservation?.id ||
		"";
	const confirmation =
		reservation?.confirmation_number ||
		reservation?.confirmationNumber ||
		ai.confirmationNumber ||
		ai.confirmation_number ||
		"";
	if (!id && !confirmation) return null;
	return {
		...(id ? { _id: id } : {}),
		...(confirmation ? { confirmation_number: confirmation } : {}),
	};
}

function confirmationRequestSignals(text = "") {
	const normalized = digitsToEnglish(String(text || "").toLowerCase());
	const hasConfirmationContext = hasSemanticSignal(text, ["confirmation", "reservation"]);
	const asksToSend = hasSemanticSignal(text, "send");
	const emailSignal = hasSemanticSignal(text, "email");
	const whatsappSignal = hasSemanticSignal(text, "whatsapp");
	const linkSignal = hasSemanticSignal(text, "link");
	const emailWords = "(?:email|e-mail|mail|inbox|\\u0627\\u064a\\u0645\\u064a\\u0644|\\u0625\\u064a\\u0645\\u064a\\u0644|\\u0628\\u0631\\u064a\\u062f)";
	const confirmationWords =
		"(?:confirmation|confirm|reservation|booking|invoice|receipt|voucher|\\u062a\\u0623\\u0643\\u064a\\u062f|\\u062a\\u0627\\u0643\\u064a\\u062f|\\u062d\\u062c\\u0632|\\u0641\\u0627\\u062a\\u0648\\u0631\\u0629)";
	const linkWords =
		"(?:link|url|details link|confirmation link|reservation link|\\u0631\\u0627\\u0628\\u0637)";
	const whatsappWords =
		"(?:whatsapp|whats app|wa|\\u0648\\u0627\\u062a\\u0633|\\u0648\\u0627\\u062a\\u0633\\u0627\\u0628)";
	const email = new RegExp(
		`${confirmationWords}.{0,80}${emailWords}|${emailWords}.{0,80}${confirmationWords}|\\b(?:send|resend|share|forward).{0,40}${emailWords}\\b`,
		"i"
	).test(normalized) || (emailSignal && (hasConfirmationContext || asksToSend));
	const whatsapp = new RegExp(
		`${confirmationWords}.{0,80}${whatsappWords}|${whatsappWords}.{0,80}${confirmationWords}|\\b(?:send|resend|share|forward).{0,50}${whatsappWords}\\b`,
		"i"
	).test(normalized) || (whatsappSignal && (hasConfirmationContext || asksToSend));
	const link = new RegExp(
		`${confirmationWords}.{0,80}${linkWords}|${linkWords}.{0,80}${confirmationWords}|\\b(?:send|share|show|give).{0,40}${linkWords}\\b`,
		"i"
	).test(normalized) || (linkSignal && (hasConfirmationContext || asksToSend));
	return { email, whatsapp, link };
}

function confirmationDeliverySummary(result = {}) {
	const guestEmail = result?.email?.guest || {};
	const guestWhatsApp = result?.whatsapp?.guest || {};
	return {
		email: guestEmail?.ok
			? "sent"
			: guestEmail?.skipped
			? "skipped"
			: guestEmail?.attempted === false
			? "skipped"
			: guestEmail?.error
			? "failed"
			: result?.email?.attempted
			? "not_attempted"
			: "not_requested",
		emailError: guestEmail?.error || guestEmail?.reason || "",
		whatsapp: guestWhatsApp?.sid || guestWhatsApp?.ok
			? "sent"
			: guestWhatsApp?.skipped
			? "skipped"
			: guestWhatsApp?.attempted === false
			? "skipped"
			: guestWhatsApp?.error
			? "failed"
			: result?.whatsapp?.attempted
			? "not_attempted"
			: "not_requested",
		whatsappError: guestWhatsApp?.error || guestWhatsApp?.reason || "",
	};
}

function confirmationDeliveryFallbackText(sc = {}, st = {}, details = {}) {
	const lang = languageOf(sc, st);
	const confirmation = details.confirmation || "";
	const links = details.links || {};
	const delivery = details.delivery || {};
	const label = "[Reservation Confirmation]";
	const linkLine = links.reservationDetails
		? `${label}(${links.reservationDetails})`
		: "";
	if (/arabic/i.test(lang)) {
		if (details.channel === "link") {
			return `\u0623\u0643\u064a\u062f. \u0631\u0627\u0628\u0637 \u062a\u0623\u0643\u064a\u062f \u0627\u0644\u062d\u062c\u0632: ${linkLine}${confirmation ? `\n\u0631\u0642\u0645 \u0627\u0644\u062a\u0623\u0643\u064a\u062f: **${confirmation}**.` : ""}`;
		}
		if (details.channel === "whatsapp") {
			return delivery.whatsapp === "sent"
				? "\u062a\u0645 \u0625\u0631\u0633\u0627\u0644 \u062a\u0623\u0643\u064a\u062f \u0627\u0644\u062d\u062c\u0632 \u0639\u0644\u0649 \u0648\u0627\u062a\u0633\u0627\u0628."
				: `\u062d\u0627\u0648\u0644\u062a \u0625\u0631\u0633\u0627\u0644 \u0627\u0644\u062a\u0623\u0643\u064a\u062f \u0639\u0644\u0649 \u0648\u0627\u062a\u0633\u0627\u0628\u060c \u0648\u0647\u0630\u0627 \u0631\u0627\u0628\u0637 \u0627\u0644\u062a\u0623\u0643\u064a\u062f: ${linkLine}`;
		}
		return delivery.email === "sent"
			? "\u062a\u0645 \u0625\u0631\u0633\u0627\u0644 \u062a\u0623\u0643\u064a\u062f \u0627\u0644\u062d\u062c\u0632 \u0625\u0644\u0649 \u0627\u0644\u0628\u0631\u064a\u062f \u0627\u0644\u0645\u0633\u062c\u0644. \u0645\u0646 \u0641\u0636\u0644\u0643 \u062a\u062d\u0642\u0642 \u0623\u064a\u0636\u0627 \u0645\u0646 \u0627\u0644\u0628\u0631\u064a\u062f \u063a\u064a\u0631 \u0627\u0644\u0647\u0627\u0645."
			: `\u062d\u0627\u0648\u0644\u062a \u0625\u0631\u0633\u0627\u0644 \u0627\u0644\u062a\u0623\u0643\u064a\u062f \u0628\u0627\u0644\u0628\u0631\u064a\u062f\u060c \u0648\u0647\u0630\u0627 \u0631\u0627\u0628\u0637 \u0627\u0644\u062a\u0623\u0643\u064a\u062f: ${linkLine}`;
	}
	if (details.channel === "link") {
		return `Of course. Here is your ${label}(${links.reservationDetails})${
			confirmation ? ` for confirmation **${confirmation}**.` : "."
		}`;
	}
	if (details.channel === "whatsapp") {
		return delivery.whatsapp === "sent"
			? "I sent the reservation confirmation on WhatsApp."
			: `I tried to send it on WhatsApp. Here is the ${label}(${links.reservationDetails}) as well.`;
	}
	return delivery.email === "sent"
		? "I sent the reservation confirmation to the email on the booking. Please also check spam or junk just in case."
		: `I tried to send the confirmation email. Here is the ${label}(${links.reservationDetails}) as well.`;
}

function reservationArrivalDateText(sc, st, reservation = {}) {
	const source = st.slots?.checkinISO || reservation.checkin_date || "";
	const iso =
		typeof source === "string" && /^\d{4}-\d{2}-\d{2}/.test(source)
			? source.slice(0, 10)
			: isoDate(source);
	return iso ? localizedGregorianDate(iso, languageOf(sc, st)) : "";
}

function reservationCreatedMessage(sc, st, reservation, quoteData, links) {
	const lang = languageOf(sc, st);
	const confirmation = reservation.confirmation_number;
	const currency = cleanCurrency(quoteData?.currency || "SAR");
	const total = reservation.total_amount;
	const name = respectfulGuestName(sc, st);
	const hotelName = localizedHotelName(sc, st);
	const arrivalDate = reservationArrivalDateText(sc, st, reservation);
	const totalDisplay = /arabic/i.test(lang)
		? localizedMoney(total, currency, lang)
		: `${total} ${currency}`;
	if (/arabic/i.test(lang)) {
		return [
			`${name}\u060c \u062a\u0645 \u062a\u0623\u0643\u064a\u062f \u0627\u0644\u062d\u062c\u0632 \u0628\u0646\u062c\u0627\u062d. \u0631\u0642\u0645 \u0627\u0644\u062a\u0623\u0643\u064a\u062f: **${confirmation}**.`,
			`\u0634\u0643\u0631\u0627 \u0644\u0627\u062e\u062a\u064a\u0627\u0631\u0643 **${hotelName}** \ud83c\udf38 ${arrivalDate ? `\u0646\u062a\u0637\u0644\u0639 \u0644\u0627\u0633\u062a\u0642\u0628\u0627\u0644\u0643 \u064a\u0648\u0645 **${arrivalDate}**.` : "\u0646\u062a\u0637\u0644\u0639 \u0644\u0627\u0633\u062a\u0642\u0628\u0627\u0644\u0643 \u0642\u0631\u064a\u0628\u0627."}`,
			`\u0627\u0644\u0625\u062c\u0645\u0627\u0644\u064a: **${totalDisplay}**.`,
			`[\u0627\u0636\u063a\u0637 \u0647\u0646\u0627 \u0644\u0645\u0639\u0631\u0641\u0629 \u0627\u0644\u0645\u0632\u064a\u062f \u0645\u0646 \u0627\u0644\u062a\u0641\u0627\u0635\u064a\u0644](${links.reservationDetails})`,
			`[\u0631\u0627\u0628\u0637 \u0627\u0644\u062f\u0641\u0639](${links.payment})`,
			"\u0647\u0644 \u0623\u0642\u062f\u0631 \u0623\u0633\u0627\u0639\u062f\u0643 \u0628\u0623\u064a \u0634\u064a\u0621 \u0622\u062e\u0631\u061f",
		].join("\n");
	}
	if (/spanish/i.test(lang)) {
		return [
			`${name}, la reserva esta confirmada correctamente. Numero de confirmacion: **${confirmation}**.`,
			`Gracias por elegir **${hotelName}** \ud83c\udf38 ${
				arrivalDate
					? `Esperamos recibirte el **${arrivalDate}**.`
					: "Esperamos recibirte pronto."
			}`,
			`Total: **${totalDisplay}**.`,
			`[Ver detalles de la reserva](${links.reservationDetails})`,
			`[Enlace de pago](${links.payment})`,
			"Hay algo mas en lo que pueda ayudarte?",
		].join("\n");
	}
	if (/french/i.test(lang)) {
		return [
			`${name}, la reservation est confirmee avec succes. Numero de confirmation : **${confirmation}**.`,
			`Merci d'avoir choisi **${hotelName}** \ud83c\udf38 ${
				arrivalDate
					? `Nous avons hate de vous accueillir le **${arrivalDate}**.`
					: "Nous avons hate de vous accueillir bientot."
			}`,
			`Total : **${totalDisplay}**.`,
			`[Voir les details de la reservation](${links.reservationDetails})`,
			`[Lien de paiement](${links.payment})`,
			"Puis-je vous aider avec autre chose ?",
		].join("\n");
	}
	if (/urdu/i.test(lang)) {
		return [
			`${name}، آپ کی بکنگ کامیابی سے تصدیق ہو گئی ہے۔ تصدیقی نمبر: **${confirmation}**.`,
			`**${hotelName}** منتخب کرنے کا شکریہ 🌸 ${
				arrivalDate
					? `ہم **${arrivalDate}** کو آپ کا استقبال کرنے کے منتظر ہیں۔`
					: "ہم جلد آپ کا استقبال کرنے کے منتظر ہیں۔"
			}`,
			`کل رقم: **${totalDisplay}**.`,
			`[ریزرویشن کی تفصیلات](${links.reservationDetails})`,
			`[ادائیگی کا لنک](${links.payment})`,
			"کیا میں آپ کی کسی اور چیز میں مدد کر سکتا/سکتی ہوں؟",
		].join("\n");
	}
	if (/hindi/i.test(lang)) {
		return [
			`${name}, आपकी बुकिंग सफलतापूर्वक पुष्टि हो गई है। पुष्टि संख्या: **${confirmation}**.`,
			`**${hotelName}** चुनने के लिए धन्यवाद 🌸 ${
				arrivalDate
					? `हम **${arrivalDate}** को आपका स्वागत करने के लिए उत्सुक हैं।`
					: "हम जल्द आपका स्वागत करने के लिए उत्सुक हैं।"
			}`,
			`कुल राशि: **${totalDisplay}**.`,
			`[बुकिंग विवरण](${links.reservationDetails})`,
			`[भुगतान लिंक](${links.payment})`,
			"क्या मैं आपकी किसी और चीज़ में मदद कर सकता/सकती हूं?",
		].join("\n");
	}
	if (/indonesian/i.test(lang)) {
		return [
			`${name}, reservasi Anda sudah berhasil dikonfirmasi. Nomor konfirmasi: **${confirmation}**.`,
			`Terima kasih sudah memilih **${hotelName}** \ud83c\udf38 ${
				arrivalDate
					? `Kami menantikan kedatangan Anda pada **${arrivalDate}**.`
					: "Kami menantikan kedatangan Anda segera."
			}`,
			`Total: **${totalDisplay}**.`,
			`[Detail reservasi](${links.reservationDetails})`,
			`[Link pembayaran](${links.payment})`,
			"Ada hal lain yang bisa saya bantu?",
		].join("\n");
	}
	if (/malay|malaysia/i.test(lang)) {
		return [
			`${name}, tempahan anda telah berjaya disahkan. Nombor pengesahan: **${confirmation}**.`,
			`Terima kasih kerana memilih **${hotelName}** \ud83c\udf38 ${
				arrivalDate
					? `Kami menantikan ketibaan anda pada **${arrivalDate}**.`
					: "Kami menantikan ketibaan anda tidak lama lagi."
			}`,
			`Total: **${totalDisplay}**.`,
			`[Butiran tempahan](${links.reservationDetails})`,
			`[Pautan pembayaran](${links.payment})`,
			"Ada apa-apa lagi yang boleh saya bantu?",
		].join("\n");
	}
	return [
		`${name}, your reservation is confirmed. Confirmation number: **${confirmation}**.`,
		`Thank you for choosing **${hotelName}** \ud83c\udf38 ${
			arrivalDate
				? `We look forward to welcoming you on **${arrivalDate}**.`
				: "We look forward to welcoming you soon."
		}`,
		`Total: **${totalDisplay}**.`,
		`[Please click here to find more details](${links.reservationDetails})`,
		`[Payment link](${links.payment})`,
		"Is there anything else I can help you with?",
	].join("\n");
}

function reservationUpdateOptionLine(option = {}, index = 0, lang = "English") {
	const isArabic = /arabic/i.test(lang);
	const room = option.roomName || roomTypeLabel(option.roomType || "");
	const checkin = isArabic
		? localizedGregorianDate(option.checkinISO, lang)
		: usDate(option.checkinISO);
	const checkout = isArabic
		? localizedGregorianDate(option.checkoutISO, lang)
		: usDate(option.checkoutISO);
	const currency = cleanCurrency(option.currency || "SAR");
	const total = option.total
		? isArabic
			? localizedMoney(option.total, currency, lang)
			: `${option.total} ${currency}`
		: "";
	if (isArabic) {
		return `\u0627\u0644\u062e\u064a\u0627\u0631 ${arabicDigits(index + 1)}: ${room} - ${checkin} \u0625\u0644\u0649 ${checkout}${total ? ` \u2014 ${total}` : ""}`;
	}
	return `${index + 1}. ${room}: ${checkin} - ${checkout}${total ? `, ${total}` : ""}`;
}

function reservationUpdateSuccessMessage(sc, st, result = {}) {
	const lang = languageOf(sc, st);
	const isArabic = /arabic/i.test(lang);
	const reservation = result.reservation || {};
	const links = reservationLinks(reservation);
	const name = respectfulGuestName(sc, st);
	const confirmation = reservation.confirmation_number || result.confirmation || "";
	const room =
		result.quote?.room?.displayName ||
		result.quote?.room?.roomType ||
		roomTypeLabel(result.selection?.roomType || "");
	const total = reservation.total_amount || result.quote?.totals?.totalPriceWithCommission || 0;
	const currency = cleanCurrency(result.quote?.currency || reservation.currency || "SAR");
	const dateLine = isArabic
		? `${localizedGregorianDate(result.checkinISO, lang)} - ${localizedGregorianDate(result.checkoutISO, lang)}`
		: `${usDate(result.checkinISO)} - ${usDate(result.checkoutISO)}`;
	const totalDisplay = isArabic ? localizedMoney(total, currency, lang) : `${total} ${currency}`;
	if (isArabic) {
		return [
			`${name}\u060c \u062a\u0645 \u062a\u062d\u062f\u064a\u062b \u0627\u0644\u062d\u062c\u0632 **${confirmation}** \u0625\u0644\u0649 **${dateLine}** \u0628\u0639\u062f \u0645\u0631\u0627\u062c\u0639\u0629 \u0627\u0644\u062a\u0648\u0641\u0631.`,
			`\u0627\u0644\u063a\u0631\u0641\u0629: **${room}**. \u0627\u0644\u0625\u062c\u0645\u0627\u0644\u064a \u0627\u0644\u062d\u0627\u0644\u064a: **${totalDisplay}**.`,
			"\u0627\u0644\u062d\u062c\u0632 \u0644\u0627 \u064a\u0632\u0627\u0644 \u0645\u0624\u0643\u062f\u0627 \u0644\u0643\u060c \u0648\u062a\u0645 \u0625\u0631\u0633\u0627\u0644 \u0627\u0644\u062a\u062d\u062f\u064a\u062b \u0644\u0641\u0631\u064a\u0642 \u0627\u0644\u0641\u0646\u062f\u0642 \u0644\u0644\u0645\u0631\u0627\u062c\u0639\u0629.",
			`[\u062a\u0641\u0627\u0635\u064a\u0644 \u0627\u0644\u062d\u062c\u0632](${links.reservationDetails})`,
			`[\u0631\u0627\u0628\u0637 \u0627\u0644\u062f\u0641\u0639](${links.payment})`,
		].join("\n");
	}
	if (/spanish/i.test(lang)) {
		return [
			`Listo, ${name}. Actualice la reserva **${confirmation}** a **${dateLine}** despues de revisar disponibilidad.`,
			`Habitacion: **${room}**. Total actual: **${totalDisplay}**.`,
			"La reserva sigue confirmada para ti y el equipo del hotel recibio el cambio para revision.",
			`[Reservation details](${links.reservationDetails})`,
			`[Payment link](${links.payment})`,
		].join("\n");
	}
	if (/french/i.test(lang)) {
		return [
			`C'est fait, ${name}. J'ai mis a jour la reservation **${confirmation}** pour **${dateLine}** apres verification de la disponibilite.`,
			`Chambre : **${room}**. Total actuel : **${totalDisplay}**.`,
			"La reservation reste confirmee pour vous et l'equipe de l'hotel a recu la mise a jour pour verification.",
			`[Reservation details](${links.reservationDetails})`,
			`[Payment link](${links.payment})`,
		].join("\n");
	}
	return [
		`Done, ${name}. I updated reservation **${confirmation}** to **${dateLine}** after checking availability.`,
		`Room: **${room}**. Current total: **${totalDisplay}**.`,
		"The reservation remains confirmed for you, and the hotel team has been notified to review the updated dates.",
		`[Reservation details](${links.reservationDetails})`,
		`[Payment link](${links.payment})`,
	].join("\n");
}

function reservationUpdateUnavailableMessage(sc, st, result = {}, options = []) {
	const lang = languageOf(sc, st);
	const isArabic = /arabic/i.test(lang);
	const name = respectfulGuestName(sc, st);
	const requested = result.requested || {};
	const requestedLine = isArabic
		? `${localizedGregorianDate(requested.checkinISO, lang)} - ${localizedGregorianDate(requested.checkoutISO, lang)}`
		: `${usDate(requested.checkinISO)} - ${usDate(requested.checkoutISO)}`;
	const optionLines = options
		.map((option, index) => reservationUpdateOptionLine(option, index, lang))
		.join("\n");
	if (options.length) {
		if (isArabic) {
			return [
				`${name}\u060c \u0644\u0627 \u064a\u0638\u0647\u0631 \u062a\u0648\u0641\u0631 \u0644\u0646\u0641\u0633 \u0627\u0644\u0637\u0644\u0628 \u0641\u064a **${requestedLine}**.`,
				"\u0647\u0630\u0647 \u0623\u0642\u0631\u0628 \u0627\u0644\u062e\u064a\u0627\u0631\u0627\u062a \u0627\u0644\u0645\u062a\u0627\u062d\u0629 \u0627\u0644\u062a\u064a \u0648\u062c\u062f\u062a\u0647\u0627:",
				optionLines,
				"\u0627\u062e\u062a\u0631 \u0631\u0642\u0645 \u0627\u0644\u062e\u064a\u0627\u0631 \u0627\u0644\u0645\u0646\u0627\u0633\u0628\u060c \u0623\u0648 \u0623\u0631\u0633\u0644 \u062a\u0648\u0627\u0631\u064a\u062e \u0623\u062e\u0631\u0649.",
			].join("\n");
		}
		if (/spanish/i.test(lang)) {
			return [
				`${name}, no veo disponibilidad para la misma solicitud en **${requestedLine}**.`,
				"Estas son las opciones cercanas disponibles que encontre:",
				optionLines,
				"Elige el numero de opcion que prefieres, o enviame otras fechas.",
			].join("\n");
		}
		if (/french/i.test(lang)) {
			return [
				`${name}, je ne vois pas de disponibilite pour la meme demande sur **${requestedLine}**.`,
				"Voici les options proches disponibles que j'ai trouvees :",
				optionLines,
				"Choisissez le numero de l'option souhaitee, ou envoyez d'autres dates.",
			].join("\n");
		}
		return [
			`${name}, I do not see availability for the same request on **${requestedLine}**.`,
			"These are the closest available options I found:",
			optionLines,
			"Choose the option number you prefer, or send me different dates.",
		].join("\n");
	}
	if (isArabic) {
		return `${name}\u060c \u0644\u0627 \u064a\u0638\u0647\u0631 \u062a\u0648\u0641\u0631 \u0644\u0646\u0641\u0633 \u0627\u0644\u063a\u0631\u0641\u0629 \u0641\u064a **${requestedLine}**\u060c \u0648\u0644\u0627 \u0623\u0631\u0649 \u062e\u064a\u0627\u0631\u0627 \u0642\u0631\u064a\u0628\u0627 \u062e\u0644\u0627\u0644 3 \u0623\u064a\u0627\u0645. \u0623\u0642\u062f\u0631 \u0623\u0631\u0627\u062c\u0639 \u0646\u0648\u0639 \u063a\u0631\u0641\u0629 \u0622\u062e\u0631 \u0623\u0648 \u062a\u0648\u0627\u0631\u064a\u062e \u0645\u062e\u062a\u0644\u0641\u0629 \u0625\u0630\u0627 \u0623\u0631\u0633\u0644\u062a \u0645\u0627 \u064a\u0646\u0627\u0633\u0628\u0643.`;
	}
	if (/spanish/i.test(lang)) {
		return `${name}, no veo disponibilidad para la misma habitacion en **${requestedLine}** ni una opcion cercana dentro de 3 dias. Puedo revisar otro tipo de habitacion u otras fechas si me las envias.`;
	}
	if (/french/i.test(lang)) {
		return `${name}, je ne vois pas de disponibilite pour la meme chambre sur **${requestedLine}** ni d'option proche dans les 3 jours. Je peux verifier un autre type de chambre ou d'autres dates.`;
	}
	return `${name}, I do not see same-room availability for **${requestedLine}** or a close option within 3 days. I can check another room type or different dates if you send what works for you.`;
}
async function finishReservationDateUpdate(
	io,
	sc,
	st,
	{ confirmation, checkinISO, checkoutISO, roomTypeOverride = "" }
) {
	const caseId = String(sc._id);
	await sendProgressMessage(io, sc, st, "checking");
	const result = await updateReservationDatesForCase({
		caseId,
		hotel: st.hotel,
		confirmation,
		checkinISO,
		checkoutISO,
		roomTypeOverride,
		io,
	});
	if (result.ok) {
		st.pendingReservationUpdateOptions = null;
		st.waitFor = "post_booking_followup";
		await humanSend(io, sc, st, reservationUpdateSuccessMessage(sc, st, result));
		return true;
	}
	if (result.code === "unavailable") {
		const sameRoomOptions = result.recommendations?.sameRoomCloseDates || [];
		const alternativeOptions = result.recommendations?.alternativeRooms || [];
		const options = sameRoomOptions.length ? sameRoomOptions : alternativeOptions;
		st.pendingReservationUpdateOptions = {
			confirmation,
			options,
		};
		st.waitFor = options.length ? "reservation_update_option" : "reservation_update_clarify";
		await humanSend(io, sc, st, reservationUpdateUnavailableMessage(sc, st, result, options), {
			quickReplies: reservationUpdateChoiceQuickReplies(sc, st, options),
		});
		return true;
	}
	if (result.code === "not_found") {
		const reply = await write(
			io,
			sc,
			st,
			"The guest asked to update reservation dates, but the confirmation number was not found. Ask them to recheck the confirmation number and send the new check-in/check-out dates again. Do not escalate yet.",
			{ confirmation, requestedDates: { checkinISO, checkoutISO } }
		);
		await humanSend(io, sc, st, reply);
		st.waitFor = "reservation_reference";
		return true;
	}
	if (["unsupported_status", "unsupported_room_selection", "multiple_room_types", "hotel_mismatch", "hotel_inventory_missing"].includes(result.code)) {
		await handoffToHuman(io, sc, st, "reservation_update");
		return true;
	}
	await handoffToHuman(io, sc, st, "reservation_update");
	return true;
}

async function handlePendingReservationUpdateChoice(io, sc, st, userText) {
	if (st.waitFor !== "reservation_update_option") return false;
	const pending = st.pendingReservationUpdateOptions || {};
	const options = Array.isArray(pending.options) ? pending.options : [];
	if (!options.length) {
		st.waitFor = null;
		st.pendingReservationUpdateOptions = null;
		return false;
	}
	if (declinesText(userText) || correctionText(userText)) {
		st.waitFor = "reservation_update_clarify";
		const reply = await write(
			io,
			sc,
			st,
			"The guest did not choose one of the suggested reservation update options. Ask them to send the dates or room type they prefer, and reassure them you will check availability again.",
			{ options }
		);
		await humanSend(io, sc, st, reply);
		return true;
	}
	const index = parseReservationUpdateOptionChoice(userText, options);
	if (index < 0) {
		const reply = await write(
			io,
			sc,
			st,
			"The guest replied but did not clearly choose one of the suggested reservation update options. Ask them to choose an option number or send different dates. Keep it short and helpful.",
			{ options, latestUserMessage: userText }
		);
		await humanSend(io, sc, st, reply, {
			quickReplies: reservationUpdateChoiceQuickReplies(sc, st, options),
		});
		return true;
	}
	const chosen = options[index];
	return finishReservationDateUpdate(io, sc, st, {
		confirmation: pending.confirmation,
		checkinISO: chosen.checkinISO,
		checkoutISO: chosen.checkoutISO,
		roomTypeOverride:
			chosen.kind === "alternative_room_same_dates" ? chosen.roomType : "",
	});
}

async function handleReservationUpdateRequest(
	io,
	sc,
	st,
	userText,
	lu = {},
	{ forceDateUpdate = false } = {}
) {
	if (!forceDateUpdate && !looksLikeReservationDateUpdate(userText, lu)) return false;
	const knownConfirmation =
		lu?.confirmation || confirmationFromText(userText) || latestKnownConfirmation(sc, lu);
	const requestedDates = latestTurnDateRange(userText, lu);
	if (!knownConfirmation || !requestedDates.checkinISO || !requestedDates.checkoutISO) {
		const reply = await write(
			io,
			sc,
			st,
			knownConfirmation
				? "The guest wants to update reservation dates and the confirmation number is known, but the new check-in/check-out dates are missing or unclear. Ask for both dates in one short sentence and say you will check availability."
				: "The guest wants to update reservation dates, but the confirmation number or the new check-in/check-out dates are missing. Ask for the missing confirmation number and both new dates in one concise message. Do not escalate.",
			{
				knownConfirmation,
				requestedDates,
				latestUserMessage: userText,
			}
		);
		await humanSend(io, sc, st, reply);
		st.waitFor = "reservation_update_clarify";
		return true;
	}
	return finishReservationDateUpdate(io, sc, st, {
		confirmation: knownConfirmation,
		checkinISO: requestedDates.checkinISO,
		checkoutISO: requestedDates.checkoutISO,
	});
}

function reservationPolicyConfirmationDisplay(result = {}) {
	const date = result.confirmedAt ? new Date(result.confirmedAt) : null;
	return date && !Number.isNaN(date.getTime())
		? usDate(date.toISOString().slice(0, 10))
		: "";
}

function reservationPolicyConfirmationLabel(result = {}, fallback = "") {
	return String(
		result.reservation?.confirmation_number || fallback || ""
	)
		.trim()
		.toUpperCase();
}

function cancellationReviewQuickReplies(sc = {}, st = {}) {
	return [];
}

function cancellationRefundPolicyQuestionText(text = "") {
	const { lower, arabic, latinCompact } = normalizeControlText(text);
	return (
		/\b(?:refund|refundable|return policy|cancellation policy|cancelation policy|cancellation terms|cancelation terms|can i cancel|could i cancel|is cancellation|free cancellation|money back|terms and conditions|terms)\b/i.test(
			lower
		) ||
		/\b(?:what happens if (?:i|we) cancel|if (?:i|we) (?:book|reserve|make a reservation).{0,70}\bcancel|if (?:i|we) cancel after (?:booking|reservation)|if (?:i|we) need to cancel later|need to cancel later|cancel later|refund work|refund works|how does (?:the )?refund work|how does cancellation work|cancel.{0,50}refund|refund.{0,50}cancel)\b/i.test(
			lower
		) ||
		/\b(?:if|when)\s+(?:i|we)\s+(?:need|want|have)\s+to\s+cancel\b|\bhow\s+(?:can|do)\s+(?:i|we)\s+(?:ask\s+for|get|request)\s+(?:a\s+)?refund\b/i.test(
			lower
		) ||
		/(?:\u0633\u064a\u0627\u0633\u0629\s*(?:\u0627\u0644)?(?:\u0625\u0644\u063a\u0627\u0621|\u0627\u0644\u063a\u0627\u0621|\u0627\u0633\u062a\u0631\u062f\u0627\u062f|\u0627\u0633\u062a\u0631\u062c\u0627\u0639)|\u0647\u0644.{0,18}(?:\u0627\u0633\u062a\u0631\u062f|\u0627\u0633\u062a\u0631\u062c\u0639|\u0627\u0644\u063a\u064a|\u0625\u0644\u063a\u064a|\u0627\u0644\u063a\u0627\u0621|\u0625\u0644\u063a\u0627\u0621)|\u0627\u0633\u062a\u0631\u062f\u0627\u062f|\u0627\u0633\u062a\u0631\u062c\u0627\u0639|\u0631\u062f\s+\u0627\u0644\u0645\u0628\u0644\u063a|\u0627\u0644\u0634\u0631\u0648\u0637\s+\u0648\u0627\u0644\u0623\u062d\u0643\u0627\u0645|\u0627\u0644\u0634\u0631\u0648\u0637\s+\u0648\u0627\u0644\u0627\u062d\u0643\u0627\u0645)/i.test(
			arabic
		) ||
		/(?:refundpolicy|returnpolicy|cancellationpolicy|cancelpolicy|canicancel|couldicancel|moneyback|termsandconditions)/i.test(
			latinCompact
		)
	);
}

function cancellationActionRequestText(text = "") {
	const { lower, arabic, latinCompact } = normalizeControlText(text);
	if (cancellationRefundPolicyQuestionText(text)) return false;
	return (
		/\b(?:cancel|void)\s+(?:my|the|this)?\s*(?:reservation|booking|room|stay)|\b(?:i want|i need|please|kindly)\s+to\s+cancel\b|\bplease\s+cancel\b/i.test(
			lower
		) ||
		/(?:\u0627\u0631\u064a\u062f|\u0623\u0631\u064a\u062f|\u0639\u0627\u064a\u0632|\u0628\u062f\u064a|\u0645\u0645\u0643\u0646).{0,18}(?:\u0627\u0644\u063a\u064a|\u0623\u0644\u063a\u064a|\u0625\u0644\u063a\u064a|\u0627\u0644\u063a\u0627\u0621|\u0625\u0644\u063a\u0627\u0621)|(?:\u0627\u0644\u063a\u064a|\u0623\u0644\u063a\u064a|\u0625\u0644\u063a\u064a).{0,18}(?:\u0627\u0644)?\u062d\u062c\u0632/i.test(
			arabic
		) ||
		/(?:cancelmybooking|cancelmyreservation|pleasecancel|iwanttocancel|ineedtocancel)/i.test(
			latinCompact
		)
	);
}

function cancellationPolicyQuickReplies(sc = {}, st = {}, previousWaitFor = "") {
	if (previousWaitFor === "reviewConfirm") return confirmationQuickReplies(sc, st);
	if (previousWaitFor === "proceed" || previousWaitFor === "room_alternative_confirm") {
		return proceedQuickReplies(sc, st);
	}
	if (previousWaitFor === "email_or_skip") return emailQuickReplies(sc, st);
	return [];
}

function generalCancellationPolicyMessage(sc = {}, st = {}, result = {}, confirmation = "") {
	const name = respectfulGuestName(sc, st);
	const lang = languageOf(sc, st);
	const label = reservationPolicyConfirmationLabel(result, confirmation);
	const checkin = result.checkinISO ? usDate(result.checkinISO) : "";
	const days = Number.isFinite(result.daysBeforeCheckin)
		? Number(result.daysBeforeCheckin)
		: null;
	let reservationLine = "";
	if (label && result.code && result.code !== "not_found") {
		if (/arabic/i.test(lang)) {
			reservationLine = checkin
				? `\n\nبالنسبة للحجز ${label}: تاريخ الوصول ${checkin} (${days} يوم قبل الوصول).`
				: `\n\nبالنسبة للحجز ${label}: لا أرى تاريخ وصول مؤكدًا يكفي لحساب بند الاسترداد بدقة من المحادثة.`;
		} else if (/spanish/i.test(lang)) {
			reservationLine = checkin
				? `\n\nPara la reserva ${label}: la fecha de llegada es ${checkin} (${days} dia(s) antes de la llegada).`
				: `\n\nPara la reserva ${label}: no veo una fecha de llegada confiable para calcular con exactitud la ventana de reembolso desde el chat.`;
		} else if (/french/i.test(lang)) {
			reservationLine = checkin
				? `\n\nPour la reservation ${label}: l'arrivee est le ${checkin} (${days} jour(s) avant l'arrivee).`
				: `\n\nPour la reservation ${label}: je ne vois pas de date d'arrivee fiable pour calculer exactement la fenetre de remboursement depuis le chat.`;
		} else {
			reservationLine = checkin
				? `\n\nFor reservation ${label}: check-in is ${checkin} (${days} day(s) before arrival).`
				: `\n\nFor reservation ${label}: I do not see a reliable check-in date to calculate the exact refund window from chat.`;
		}
	}
	if (/arabic/i.test(lang)) {
		return `${name}، سياسة الإلغاء والاسترداد العامة هي:\n- قبل موعد الوصول بـ 14 يومًا أو أكثر: إلغاء مجاني واسترداد كامل.\n- قبل موعد الوصول بأقل من 14 يومًا وأكثر من 3 أيام: يمكن إلغاء الحجز، ويحتفظ الفندق بقيمة ليلة واحدة فقط ويتم رد المبلغ المتبقي.\n- قبل موعد الوصول بـ 3 أيام أو أقل: لا يكون الحجز قابلًا للإلغاء أو الاسترداد حسب السياسة العامة.${reservationLine}`;
	}
	if (/spanish/i.test(lang)) {
		return `${name}, segun los terminos y condiciones del hotel, la politica general de cancelacion y reembolso es:\n- 14 dias o mas antes del check-in: cancelacion gratuita con reembolso completo.\n- Menos de 14 dias y mas de 3 dias antes del check-in: la cancelacion aun puede procesarse; el hotel conserva solo una noche y se reembolsa el importe restante.\n- 3 dias o menos antes del check-in: la reserva no es cancelable ni reembolsable bajo la politica general.${reservationLine}`;
	}
	if (/french/i.test(lang)) {
		return `${name}, selon les conditions de l'hotel, la politique generale d'annulation et de remboursement est:\n- 14 jours ou plus avant l'arrivee: annulation gratuite avec remboursement complet.\n- Moins de 14 jours et plus de 3 jours avant l'arrivee: l'annulation peut encore etre traitee; l'hotel conserve seulement une nuit et le montant restant est rembourse.\n- 3 jours ou moins avant l'arrivee: la reservation n'est ni annulable ni remboursable selon la politique generale.${reservationLine}`;
	}
	return `${name}, based on the hotel's terms and conditions, the general cancellation and refund policy is:\n- 14 days or more before check-in: free cancellation with a full refund.\n- Less than 14 days and more than 3 days before check-in: cancellation can still be processed; the hotel keeps one night only and the remaining amount is refunded.\n- 3 days or less before check-in: the reservation is non-cancellable and non-refundable under the general policy.${reservationLine}`;
}

function cancellationPolicySpecificLine(sc = {}, st = {}, result = {}, confirmation = "") {
	const lang = languageOf(sc, st);
	const label = reservationPolicyConfirmationLabel(result, confirmation);
	if (!label) return "";
	if (result.code === "not_found") return cancellationNotFoundMessage(sc, st, confirmation);
	if (["already_cancelled", "locked_status"].includes(result.code)) {
		return cancellationAlreadyClosedMessage(sc, st, result, confirmation);
	}
	if (result.code === "full_refund") {
		if (/arabic/i.test(lang)) {
			return `ينطبق على الحجز ${label} بند الإلغاء المجاني والاسترداد الكامل لأنه قبل الوصول بـ 14 يومًا أو أكثر.`;
		}
		if (/spanish/i.test(lang)) {
			return `La reserva ${label} esta dentro de la ventana de cancelacion gratuita, por lo que es elegible para cancelacion con reembolso completo.`;
		}
		if (/french/i.test(lang)) {
			return `La reservation ${label} est dans la periode d'annulation gratuite, elle est donc eligible a une annulation avec remboursement complet.`;
		}
		return `Reservation ${label} falls under the free-cancellation window, so it is eligible for cancellation with a full refund.`;
	}
	if (result.code === "one_night_fee") {
		if (/arabic/i.test(lang)) {
			return `ينطبق على الحجز ${label} بند الاسترداد الجزئي: يمكن الإلغاء، ويحتفظ الفندق بقيمة ليلة واحدة فقط ويتم رد المبلغ المتبقي.`;
		}
		if (/spanish/i.test(lang)) {
			return `La reserva ${label} esta dentro de la ventana de reembolso parcial: la cancelacion puede procesarse, el hotel conserva solo una noche y se reembolsa el importe restante.`;
		}
		if (/french/i.test(lang)) {
			return `La reservation ${label} est dans la periode de remboursement partiel: l'annulation peut etre traitee, l'hotel conserve seulement une nuit et le montant restant est rembourse.`;
		}
		return `Reservation ${label} falls under the partial-refund window: cancellation can be processed, the hotel keeps one night only, and the remaining amount is refunded.`;
	}
	if (result.code === "non_refundable") {
		if (/arabic/i.test(lang)) {
			return `الحجز ${label} داخل فترة 3 أيام أو أقل قبل الوصول، لذلك لا يكون قابلًا للإلغاء أو الاسترداد حسب السياسة العامة.`;
		}
		if (/spanish/i.test(lang)) {
			return `La reserva ${label} esta dentro de 3 dias o menos antes del check-in, por lo que no es cancelable ni reembolsable bajo la politica general.`;
		}
		if (/french/i.test(lang)) {
			return `La reservation ${label} est a 3 jours ou moins de l'arrivee, elle n'est donc ni annulable ni remboursable selon la politique generale.`;
		}
		return `Reservation ${label} is within 3 days or less of check-in, so it is non-cancellable and non-refundable under the general policy.`;
	}
	if (result.code === "missing_checkin_date") {
		if (/arabic/i.test(lang)) {
			return `أرى الحجز ${label}، لكن لا أرى تاريخ وصول موثوقًا يكفي لحساب بند الاسترداد بدقة من المحادثة.`;
		}
		if (/spanish/i.test(lang)) {
			return `Puedo ver la reserva ${label}, pero no tengo una fecha de llegada confiable para calcular con exactitud la ventana de reembolso desde el chat.`;
		}
		if (/french/i.test(lang)) {
			return `Je vois la reservation ${label}, mais je n'ai pas de date d'arrivee fiable pour calculer exactement la fenetre de remboursement depuis le chat.`;
		}
		return `I can see reservation ${label}, but I do not have a reliable check-in date to calculate the exact refund window from chat.`;
	}
	return "";
}

function cancellationPolicyFollowup(sc = {}, st = {}, options = {}) {
	const { hasConfirmation = false, previousWaitFor = "", actualCancellation = false } =
		options || {};
	const lang = languageOf(sc, st);
	if (!hasConfirmation && actualCancellation) {
		if (/arabic/i.test(lang)) {
			return "إذا كنت تقصد حجزًا محددًا، أرسل رقم تأكيد الحجز وسأوضح لك أي بند ينطبق عليه.";
		}
		if (/spanish/i.test(lang)) {
			return "Si te refieres a una reserva especifica, envia el numero de confirmacion y te dire que ventana de la politica aplica.";
		}
		if (/french/i.test(lang)) {
			return "Si vous parlez d'une reservation precise, envoyez le numero de confirmation et je vous dirai quelle periode de la politique s'applique.";
		}
		return "If you mean a specific reservation, send the confirmation number and I will tell you which policy window applies.";
	}
	if (
		["proceed", "reviewConfirm", "reservation_details", "fullname", "nationality", "phone", "email_or_skip", "finalize"].includes(
			previousWaitFor
		)
	) {
		if (/arabic/i.test(lang)) {
			return "سأُبقي تفاصيل الحجز الحالية كما هي، وعندما تكون مستعدًا نكمل من نفس الخطوة.";
		}
		if (/spanish/i.test(lang)) {
			return "Voy a mantener listos los detalles de la reserva actual y podemos continuar desde el mismo paso cuando estes listo.";
		}
		if (/french/i.test(lang)) {
			return "Je garde les details de la reservation actuelle prets, et nous pouvons reprendre a la meme etape quand vous etes pret.";
		}
		return "I will keep the current booking details ready, and we can continue from the same step whenever you are ready.";
	}
	if (!hasConfirmation) {
		if (/arabic/i.test(lang)) {
			return "إذا كان لديك حجز محدد، أرسل رقم التأكيد وتاريخ الوصول وسأوضح لك البند المناسب.";
		}
		if (/spanish/i.test(lang)) {
			return "Si tienes una reserva especifica, envia el numero de confirmacion y la fecha de llegada y aclarare la ventana aplicable.";
		}
		if (/french/i.test(lang)) {
			return "Si vous avez une reservation precise, envoyez le numero de confirmation et la date d'arrivee, et je clarifierai la periode applicable.";
		}
		return "If you have a specific reservation, send the confirmation number and check-in date and I will clarify the applicable window.";
	}
	return "";
}

async function answerCancellationRefundPolicyInquiry(
	io,
	sc,
	st,
	userText = "",
	lu = {},
	{ forceCancellation = false } = {}
) {
	const previousWaitFor = st.waitFor || "";
	const confirmation =
		lu?.confirmation || confirmationFromText(userText) || latestKnownConfirmation(sc, lu);
	const policyQuestion = cancellationRefundPolicyQuestionText(userText);
	const actualCancellation =
		cancellationActionRequestText(userText) || (forceCancellation && !policyQuestion);
	let result = null;
	if (confirmation) {
		result = await getReservationCancellationPolicyForCase({
			confirmation,
			hotel: st.hotel || null,
		});
	}

	const cancellationPolicyRow =
		bestHotelPolicyRow(st, userText) ||
		hotelPolicyRows(st).find((row) => row.key === "cancellation_refund") ||
		null;
	let policyMessage = cancellationPolicyRow
		? hotelPolicyAnswerText(sc, st, userText, cancellationPolicyRow)
		: "";
	if (!policyMessage && cancellationPolicyRow?.answer) {
		policyMessage = await write(
			io,
			sc,
			st,
			"The guest asked about cancellation or refund policy. Answer directly from selectedHotelPolicy only. Translate or adapt the saved answer into the guest's active response language in professional hotel-reception wording. Use hotel-native wording such as 'Based on the hotel's terms and conditions' or a direct reception answer when a source phrase is useful. Never say 'I checked', 'I found in the document', 'the record says', 'the hotel details say', or imply the answer came from an external/admin document. Do not add a link. Do not invent exceptions, deadlines, fees, or legal wording beyond the saved answer.",
			{
				latestUserMessage: userText,
				selectedHotelPolicy: cancellationPolicyRow,
				defaultCancellationRefundPolicy: DEFAULT_CANCELLATION_REFUND_ANSWER,
			}
		);
	}
	const parts = [
		policyMessage || generalCancellationPolicyMessage(sc, st, result || {}, confirmation),
	];
	if (result) {
		const specific = cancellationPolicySpecificLine(sc, st, result, confirmation);
		if (specific) parts.push(specific);
	}
	const followup = cancellationPolicyFollowup(sc, st, {
		hasConfirmation: Boolean(confirmation),
		previousWaitFor,
		actualCancellation,
	});
	if (followup) parts.push(followup);

	if (actualCancellation && !confirmation) {
		st.waitFor = "reservation_cancellation_reference";
	} else {
		preserveBookingWaitStateForCase(sc, st, previousWaitFor);
	}
	st.pendingReservationCancellation = confirmation
		? {
				confirmation: reservationPolicyConfirmationLabel(result || {}, confirmation),
				policyCode: result?.code || "general_policy",
				daysBeforeCheckin: result?.daysBeforeCheckin ?? null,
				checkinISO: result?.checkinISO || "",
		  }
		: null;
	await humanSend(io, sc, st, parts.filter(Boolean).join("\n\n"), {
		quickReplies: cancellationPolicyQuickReplies(sc, st, previousWaitFor),
		scheduleIdle: false,
		fast: true,
		targetReplyMs: AI_BOOKING_PROMPT_TARGET_MS,
	});
	logStep(String(sc._id), "cancellation_policy.direct_reply", {
		waitFor: st.waitFor,
		confirmation: Boolean(confirmation),
		resultCode: result?.code || "",
		actualCancellation,
		latestUserMessage: String(userText || "").slice(0, 160),
	});
	return true;
}

function cancellationReferenceMessage(sc = {}, st = {}) {
	const name = respectfulGuestName(sc, st);
	const lang = languageOf(sc, st);
	if (/arabic/i.test(lang)) {
		return `${name}\u060c \u0645\u0646 \u0641\u0636\u0644\u0643 \u0623\u0631\u0633\u0644 \u0631\u0642\u0645 \u062a\u0623\u0643\u064a\u062f \u0627\u0644\u062d\u062c\u0632 \u0648\u0633\u0623\u0648\u0636\u062d \u0644\u0643 \u0623\u064a \u0628\u0646\u062f \u0645\u0646 \u0633\u064a\u0627\u0633\u0629 \u0627\u0644\u0625\u0644\u063a\u0627\u0621 \u0648\u0627\u0644\u0627\u0633\u062a\u0631\u062f\u0627\u062f \u064a\u0646\u0637\u0628\u0642 \u0639\u0644\u064a\u0647.`;
	}
	if (/spanish/i.test(lang)) {
		return `${name}, por favor enviame el numero de confirmacion y te dire que parte de la politica de cancelacion y reembolso aplica.`;
	}
	if (/french/i.test(lang)) {
		return `${name}, veuillez m'envoyer le numero de confirmation et je vous dirai quelle partie de la politique d'annulation et de remboursement s'applique.`;
	}
	return `${name}, please send the reservation confirmation number and I will tell you which cancellation and refund policy window applies.`;
}

function cancellationNotFoundMessage(sc = {}, st = {}, confirmation = "") {
	const name = respectfulGuestName(sc, st);
	const label = String(confirmation || "").trim().toUpperCase();
	const lang = languageOf(sc, st);
	if (/arabic/i.test(lang)) {
		return `${name}\u060c \u0644\u0645 \u0623\u062c\u062f \u062d\u062c\u0632\u0627 \u0628\u0631\u0642\u0645 ${label}. \u0645\u0646 \u0641\u0636\u0644\u0643 \u062a\u0623\u0643\u062f \u0645\u0646 \u0631\u0642\u0645 \u0627\u0644\u062a\u0623\u0643\u064a\u062f \u0648\u0623\u0631\u0633\u0644\u0647 \u0645\u0631\u0629 \u0623\u062e\u0631\u0649.`;
	}
	if (/spanish/i.test(lang)) {
		return `${name}, no encontre una reserva con el numero ${label}. Por favor revisalo y enviamelo otra vez.`;
	}
	if (/french/i.test(lang)) {
		return `${name}, je n'ai pas trouve de reservation avec le numero ${label}. Veuillez le verifier et me le renvoyer.`;
	}
	return `${name}, I could not find a reservation with confirmation ${label}. Please recheck the number and send it again.`;
}

function cancellationTooOldMessage(sc = {}, st = {}, result = {}, confirmation = "") {
	const name = respectfulGuestName(sc, st);
	const label = reservationPolicyConfirmationLabel(result, confirmation);
	const confirmedDate = reservationPolicyConfirmationDisplay(result);
	const thresholdDays = Number(result.thresholdDays || 14);
	const lang = languageOf(sc, st);
	if (/arabic/i.test(lang)) {
		const dateLine = confirmedDate
			? ` \u062a\u0645 \u062a\u0623\u0643\u064a\u062f\u0647 \u0641\u064a ${confirmedDate}.`
			: "";
		return `${name}\u060c \u0648\u062c\u062f\u062a \u0627\u0644\u062d\u062c\u0632 ${label}.${dateLine} \u0627\u0644\u0623\u0647\u0645 \u0644\u0644\u0625\u0644\u063a\u0627\u0621 \u0648\u0627\u0644\u0627\u0633\u062a\u0631\u062f\u0627\u062f \u0647\u0648 \u0639\u062f\u062f \u0627\u0644\u0623\u064a\u0627\u0645 \u0642\u0628\u0644 \u062a\u0627\u0631\u064a\u062e \u0627\u0644\u0648\u0635\u0648\u0644\u060c \u0648\u0633\u0623\u0637\u0628\u0642 \u0627\u0644\u0633\u064a\u0627\u0633\u0629 \u0627\u0644\u0645\u062d\u0641\u0648\u0638\u0629 \u0644\u0644\u0641\u0646\u062f\u0642.`;
	}
	if (/spanish/i.test(lang)) {
		const dateLine = confirmedDate ? ` Fue confirmada el ${confirmedDate}.` : "";
		return `${name}, encontre la reserva ${label}.${dateLine} For cancellation and refund, the important timing is the number of days before check-in, and I will apply the hotel's saved policy.`;
	}
	if (/french/i.test(lang)) {
		const dateLine = confirmedDate ? ` Elle a ete confirmee le ${confirmedDate}.` : "";
		return `${name}, j'ai trouve la reservation ${label}.${dateLine} For cancellation and refund, the important timing is the number of days before check-in, and I will apply the hotel's saved policy.`;
	}
	const dateLine = confirmedDate ? ` It was confirmed on ${confirmedDate}.` : "";
	return `${name}, I found reservation ${label}.${dateLine} For cancellation and refund, the important timing is the number of days before check-in, and I will apply the hotel's saved policy.`;
}

function cancellationAlreadyClosedMessage(sc = {}, st = {}, result = {}, confirmation = "") {
	const name = respectfulGuestName(sc, st);
	const label = reservationPolicyConfirmationLabel(result, confirmation);
	const lang = languageOf(sc, st);
	if (/arabic/i.test(lang)) {
		return `${name}\u060c \u0623\u0631\u0649 \u0623\u0646 \u0627\u0644\u062d\u062c\u0632 ${label} \u0645\u063a\u0644\u0642 \u0623\u0648 \u0645\u0644\u063a\u0649 \u0628\u0627\u0644\u0641\u0639\u0644. \u0644\u0627 \u064a\u0645\u0643\u0646\u0646\u064a \u0627\u0639\u062a\u0628\u0627\u0631\u0647 \u062d\u062c\u0632\u0627 \u0646\u0634\u0637\u0627 \u0642\u0627\u0628\u0644\u0627 \u0644\u0644\u0625\u0644\u063a\u0627\u0621 \u0645\u0646 \u0627\u0644\u0645\u062d\u0627\u062f\u062b\u0629. \u0625\u0630\u0627 \u0643\u0627\u0646 \u0644\u062f\u064a\u0643 \u0631\u0642\u0645 \u062a\u0623\u0643\u064a\u062f \u0622\u062e\u0631 \u0623\u0648 \u062a\u0627\u0631\u064a\u062e \u0648\u0635\u0648\u0644\u060c \u0623\u0631\u0633\u0644\u0647 \u0648\u0633\u0623\u0631\u0627\u062c\u0639 \u0627\u0644\u0633\u064a\u0627\u0633\u0629 \u0627\u0644\u0645\u0646\u0627\u0633\u0628\u0629.`;
	}
	if (/spanish/i.test(lang)) {
		return `${name}, veo que la reserva ${label} ya esta cerrada o cancelada. No puedo tratarla como una reserva activa cancelable desde el chat. Si tienes otro numero de confirmacion o fecha de llegada, enviamelo y reviso la politica aplicable.`;
	}
	if (/french/i.test(lang)) {
		return `${name}, je vois que la reservation ${label} est deja fermee ou annulee. Je ne peux pas la traiter comme une reservation active annulable depuis le chat. Si vous avez un autre numero de confirmation ou une date d'arrivee, envoyez-le et je verifierai la politique applicable.`;
	}
	return `${name}, I can see reservation ${label} is already closed or cancelled. I cannot treat it as an active cancellable reservation from chat. If you have another confirmation number or check-in date, send it and I will review the applicable policy.`;
}

function cancellationPolicyClarifyMessage(sc = {}, st = {}) {
	const name = respectfulGuestName(sc, st);
	const lang = languageOf(sc, st);
	if (/arabic/i.test(lang)) {
		return `${name}\u060c \u0623\u0631\u0633\u0644 \u0631\u0642\u0645 \u0627\u0644\u062a\u0623\u0643\u064a\u062f \u0648\u062a\u0627\u0631\u064a\u062e \u0627\u0644\u0648\u0635\u0648\u0644 \u0625\u0630\u0627 \u0643\u0646\u062a \u062a\u0631\u064a\u062f \u0645\u0631\u0627\u062c\u0639\u0629 \u0627\u0644\u0628\u0646\u062f \u0627\u0644\u0645\u0646\u0627\u0633\u0628.`;
	}
	if (/spanish/i.test(lang)) {
		return `${name}, enviame el numero de confirmacion y la fecha de llegada si quieres que revise la parte aplicable de la politica.`;
	}
	if (/french/i.test(lang)) {
		return `${name}, envoyez-moi le numero de confirmation et la date d'arrivee si vous voulez que je verifie la partie applicable de la politique.`;
	}
	return `${name}, send the confirmation number and check-in date if you want me to review the applicable policy window.`;
}

function cancellationPolicyCloseMessage(sc = {}, st = {}) {
	const name = respectfulGuestName(sc, st);
	const lang = languageOf(sc, st);
	if (/arabic/i.test(lang)) {
		return `${name}\u060c \u062a\u0645\u0627\u0645. \u0623\u0646\u0627 \u0645\u0648\u062c\u0648\u062f \u0625\u0630\u0627 \u0627\u062d\u062a\u062c\u062a \u0623\u064a \u0645\u0633\u0627\u0639\u062f\u0629 \u0623\u062e\u0631\u0649 \u0628\u062e\u0635\u0648\u0635 \u0627\u0644\u062d\u062c\u0632.`;
	}
	if (/spanish/i.test(lang)) {
		return `${name}, perfecto. Estoy aqui si necesitas cualquier otra ayuda con la reserva.`;
	}
	if (/french/i.test(lang)) {
		return `${name}, tres bien. Je reste disponible si vous avez besoin d'aide pour la reservation.`;
	}
	return `${name}, understood. I am here if you need anything else with the reservation.`;
}

function cancellationInsistenceText(text = "") {
	const { lower, arabic, latinCompact } = normalizeControlText(text);
	return (
		confirmsText(text) ||
		looksLikeReservationCancellation(text) ||
		/\b(still|anyway|insist|exception|review|specialist|human|manager|agent|escalate|connect|please proceed|go ahead|refund|payment review)\b/i.test(
			lower
		) ||
		/(?:\u0644\u0627\u0632\u0645|\u0645\u0635\u0631|\u0628\u0631\u0636\u0647|\u0645\u0627\s*\u0632\u0644\u062a|\u062d\u0648\u0644|\u0648\u0635\u0644|\u0645\u062e\u062a\u0635|\u0627\u0633\u062a\u062b\u0646\u0627\u0621|\u0645\u0631\u0627\u062c\u0639\u0647|\u0627\u0633\u062a\u0631\u062f\u0627\u062f)/i.test(
			arabic
		) ||
		/(?:still|anyway|insist|exception|review|specialist|human|manager|agent|escalate|connect|goahead|refund|reembolso|remboursement|especialista|specialiste|excepcion|exception)/i.test(
			latinCompact
		)
	);
}

function declinesCancellationReviewText(text = "") {
	const { lower, arabic, latinCompact } = normalizeControlText(text);
	const explicitlyKeepReservation =
		/\b(?:do not|don't|dont|no need to|never mind|nevermind|keep|leave)\b.*\bcancel|\bcancel\b.*\b(?:do not|don't|dont|no need|never mind|nevermind)\b/i.test(
			lower
		) ||
		/(?:\u0644\u0627\s+\u062a\u0644\u063a\u064a|\u0644\u0627\s+\u0627\u0644\u063a\u064a|\u062e\u0644\u0627\u0635|\u0645\u0634\s+\u0645\u062d\u062a\u0627\u062c|\u062e\u0644\u064a\s+\u0627\u0644\u062d\u062c\u0632)/i.test(
			arabic
		) ||
		/(?:dontcancel|donotcancel|noneed|nevermind|keepreservation|leaveit)/i.test(
			latinCompact
		);
	if (explicitlyKeepReservation) return true;
	const wantsReview =
		/\b(still|anyway|insist|exception|review|specialist|human|manager|agent|escalate|connect|go ahead|refund|payment)\b/i.test(
			lower
		) ||
		/(?:\u0645\u062e\u062a\u0635|\u0627\u0633\u062a\u062b\u0646\u0627\u0621|\u0645\u0631\u0627\u062c\u0639\u0647|\u0627\u0633\u062a\u0631\u062f\u0627\u062f)/i.test(
			arabic
		);
	return declinesText(text) && !looksLikeReservationCancellation(text) && !wantsReview;
}

async function handleReservationCancellationPolicyAck(io, sc, st, userText) {
	if (st.waitFor !== "reservation_cancellation_policy_ack") return false;
	if (declinesCancellationReviewText(userText)) {
		st.pendingReservationCancellation = null;
		st.waitFor = null;
		await humanSend(io, sc, st, cancellationPolicyCloseMessage(sc, st));
		return true;
	}
	if (cancellationInsistenceText(userText) || wantsPaymentHelp(userText)) {
		st.pendingReservationCancellation = null;
		st.waitFor = null;
		return answerCancellationRefundPolicyInquiry(io, sc, st, userText, {}, {
			forceCancellation: true,
		});
	}
	if (looksLikeReservationDateUpdate(userText, {})) return false;
	st.pendingReservationCancellation = null;
	st.waitFor = null;
	return answerCancellationRefundPolicyInquiry(io, sc, st, userText, {}, {
		forceCancellation: true,
	});
}

async function handleReservationCancellationRequest(
	io,
	sc,
	st,
	userText,
	lu = {},
	{ forceCancellation = false } = {}
) {
	if (
		!forceCancellation &&
		st.waitFor !== "reservation_cancellation_reference" &&
		!looksLikeReservationCancellation(userText)
	) {
		return false;
	}
	const confirmation =
		lu?.confirmation || confirmationFromText(userText) || latestKnownConfirmation(sc, lu);
	if (!confirmation) {
		return answerCancellationRefundPolicyInquiry(io, sc, st, userText, lu, {
			forceCancellation: true,
		});
	}
	const result = await getReservationCancellationPolicyForCase({
		confirmation,
		hotel: st.hotel || null,
	});
	if (result.code === "missing_confirmation") {
		return answerCancellationRefundPolicyInquiry(io, sc, st, userText, lu, {
			forceCancellation: true,
		});
	}
	return answerCancellationRefundPolicyInquiry(io, sc, st, userText, lu, {
		forceCancellation: true,
	});
}

async function finalizeReservationForGuest(io, sc, st, caseId) {
	if (!st.hotel) {
		if (Array.isArray(st.platformHotelOptions) && st.platformHotelOptions.length) {
			st.waitFor = "platform_hotel_choice";
			await humanSend(
				io,
				sc,
				st,
				"Jannat Booking support can help you choose the best option, and the hotel reception and reservations desk will complete the official reservation and links. Please choose a hotel option so I can connect you.",
				{ quickReplies: platformHotelOptionQuickReplies(sc, st) }
			);
			return true;
		}
		await answerJannatBookingHotelOptions(io, sc, st, lastUserText(sc));
		return true;
	}
	if (st.slots?.adultsProvided) ensureDefaultChildren(st);
	if (!hasMandatoryReservationDetails(st)) {
		st.waitFor = "reservation_details";
		await askForReservationDetail(io, sc, st, st.waitFor);
		return true;
	}
	if (!st.slots.email && !st.slots.emailSkipped) st.slots.emailSkipped = true;
	await sendProgressMessage(io, sc, st, "finalizing", { fast: true });
	const quoteForCreate =
		st.quote?.data ||
		safePriceRoomForStay(
			st.hotel,
			{ roomType: st.slots.roomTypeKey },
			st.slots.checkinISO,
			st.slots.checkoutISO
		);
	if (!quoteForCreate?.available) {
		await handoffToHuman(io, sc, st, "reservation_finalize_failed");
		return true;
	}
	const reservation = await createReservationForCase({
		caseId,
		hotel: st.hotel,
		slots: {
			...st.slots,
			name: st.slots.fullName || st.slots.name,
		},
		quoteData: quoteForCreate,
		room: quoteForCreate.room,
	});
	sc.aiReservation = {
		...(sc.aiReservation || {}),
		status: "created",
		reservationId: reservation._id,
		confirmationNumber: reservation.confirmation_number || "",
	};
	const links = reservationLinks(reservation);
	const finalText = reservationCreatedMessage(
		sc,
		st,
		reservation,
		quoteForCreate,
		links
	);
	st.waitFor = "post_booking_followup";
	st.reviewSent = false;
	st.quoteSummarizedAt = 0;
	st.allowPostBookingReentry = true;
	await humanSend(io, sc, st, finalText, {
		fast: true,
		targetReplyMs: AI_BOOKING_QUOTE_TARGET_MS,
	});
	if (isAiQaSupportCase(sc)) {
		logStep(caseId, "reservation.confirmation_dispatch_skipped", {
			reason: "qa_support_case",
			confirmation: reservation.confirmation_number,
		});
		return true;
	}
	const dispatchTimer = setTimeout(() => {
		dispatchAiReservationConfirmation({
			caseId,
			reservation,
			mode: "initial",
			includeGuestEmail: Boolean(st.slots.email),
			includeInternalEmail: true,
			includeOwnerEmail: true,
			includeGuestWhatsApp: false,
			includeAdminWhatsApp: true,
			guestEmail: st.slots.email || "",
		})
			.then((delivery) => {
				logStep(caseId, "reservation.confirmation_dispatched", {
					confirmation: reservation.confirmation_number,
					status: confirmationDeliverySummary(delivery),
				});
			})
			.catch((error) => {
				logStep(caseId, "reservation.confirmation_dispatch_failed", {
					confirmation: reservation.confirmation_number,
					error: String(error?.message || error || "").slice(0, 200),
				});
			});
	}, AI_CONFIRMATION_DISPATCH_DELAY_MS);
	if (typeof dispatchTimer?.unref === "function") dispatchTimer.unref();
	return true;
}

function postBookingCloseText(sc = {}, st = {}) {
	const lang = languageOf(sc, st);
	if (/arabic/i.test(lang)) {
		return "\u0639\u0644\u0649 \u0627\u0644\u0631\u062d\u0628 \u0648\u0627\u0644\u0633\u0639\u0629. \u0623\u062a\u0645\u0646\u0649 \u0644\u0643 \u0625\u0642\u0627\u0645\u0629 \u0645\u0648\u0641\u0642\u0629.";
	}
	if (/spanish/i.test(lang)) {
		return "Con mucho gusto. Te deseo una excelente estancia.";
	}
	if (/french/i.test(lang)) {
		return "Avec plaisir. Je vous souhaite un excellent sejour.";
	}
	return "You are very welcome. I hope you have a wonderful stay.";
}

async function postBookingCloseReply(io, sc, st, userText = "") {
	if (
		botExperienceComplaintText(userText) ||
		/\b(answer\s+(?:the\s+)?questions?|can't\s+you\s+answer|can'?t\s+you\s+answer)\b/i.test(
			String(userText || "")
		)
	) {
		const lang = languageOf(sc, st);
		if (/arabic/i.test(lang)) {
			return "\u0623\u0639\u062a\u0630\u0631 \u0644\u0643\u060c \u0648\u0634\u0643\u0631\u0627 \u0644\u062a\u0646\u0628\u064a\u0647\u0643. \u062d\u062c\u0632\u0643 \u0645\u0624\u0643\u062f\u060c \u0648\u0623\u062a\u0645\u0646\u0649 \u0644\u0643 \u0625\u0642\u0627\u0645\u0629 \u0645\u0648\u0641\u0642\u0629.";
		}
		return "I am sorry about that, and thank you for the feedback. Your reservation is confirmed, and I hope you have a wonderful stay.";
	}
	return postBookingCloseText(sc, st);
}

function postBookingClarifyText(sc = {}, st = {}) {
	const lang = languageOf(sc, st);
	if (/arabic/i.test(lang)) {
		return "\u0623\u0643\u064a\u062f\u060c \u0623\u0646\u0627 \u0645\u0639\u0643. \u0645\u0627 \u0627\u0644\u0634\u064a\u0621 \u0627\u0644\u0622\u062e\u0631 \u0627\u0644\u0630\u064a \u062a\u062d\u0628 \u0623\u0633\u0627\u0639\u062f\u0643 \u0641\u064a\u0647\u061f";
	}
	if (/spanish/i.test(lang)) {
		return "Claro, estoy contigo. Que mas puedo hacer por ti?";
	}
	if (/french/i.test(lang)) {
		return "Bien sur, je suis avec vous. Que puis-je faire d'autre pour vous?";
	}
	return "Of course, I am here. What else can I help you with?";
}

function postBookingLocalRecommendationQuestionText(text = "") {
	const { lower, arabic, latinCompact } = normalizeControlText(text);
	return (
		/\b(?:(?:recommend|suggest).{0,50}(?:nearby|around|close by|food|restaurant|restaurants|shop|shops|market|markets|souq|souks|souvenir|eat|meal|meals)|nearby|around|close by|food|restaurant|restaurants|shop|shops|market|markets|souq|souks|souvenir|eat|meal|meals)\b/i.test(
			lower
		) ||
		/(?:\u0645\u0637\u0639\u0645|\u0645\u0637\u0627\u0639\u0645|\u0623\u0643\u0644|\u0627\u0643\u0644|\u0633\u0648\u0642|\u0623\u0633\u0648\u0627\u0642|\u0627\u0633\u0648\u0627\u0642|\u0645\u062d\u0644|\u0645\u062d\u0644\u0627\u062a|\u0642\u0631\u064a\u0628|(?:\u0631\u0634\u062d|\u062a\u0631\u0634\u062d).{0,30}(?:\u0645\u0637\u0639\u0645|\u0623\u0643\u0644|\u0633\u0648\u0642|\u0645\u062d\u0644|\u0642\u0631\u064a\u0628))/i.test(
			arabic
		) ||
		/(?:(?:recommend|suggest).{0,50}(?:nearby|food|restaurant|shops|markets|souks|souq|eat)|nearby|food|restaurant|shops|markets|souks|souq|eat)/i.test(
			latinCompact
		)
	);
}

function postBookingHaramTimingQuestionText(text = "") {
	const { lower, arabic, latinCompact } = normalizeControlText(text);
	return (
		/\b(?:what time|when|best time|easiest time|recommend.{0,30}time|leave.{0,30}haram|go.{0,30}haram|daily prayers|prayer time|prayers)\b/i.test(
			lower
		) && /\b(?:haram|prayer|prayers|salah|masjid)\b/i.test(lower)
	) ||
		/(?:\u0645\u062a\u0649|\u0648\u0642\u062a|\u0623\u0641\u0636\u0644\s+\u0648\u0642\u062a|\u0627\u0641\u0636\u0644\s+\u0648\u0642\u062a|\u0623\u0633\u0647\u0644\s+\u0648\u0642\u062a|\u0627\u0633\u0647\u0644\s+\u0648\u0642\u062a).{0,50}(?:\u0627\u0644\u062d\u0631\u0645|\u0627\u0644\u0635\u0644\u0627\u0629|\u0627\u0644\u0635\u0644\u0627\u0647)/i.test(
			arabic
		) ||
		/(?:whattime|besttime|easiesttime|recommendtime|leavetoharam|gotoharam|dailyprayers|prayertime)/i.test(
			latinCompact
		);
}

function postBookingHaramTimingText(sc = {}, st = {}) {
	const lang = languageOf(sc, st);
	const name = respectfulGuestName(sc, st);
	const walking = formatHotelFactText(st.hotel?.distances?.walkingToElHaram, lang);
	const driving = formatHotelFactText(st.hotel?.distances?.drivingToElHaram, lang);
	const mapsUrl = hotelGoogleMapsDirectionsUrl(st.hotel || {}) || hotelGoogleMapsUrl(st.hotel || {});
	const mapPart = mapsUrl ? ` [Hotel location on Google Maps](${mapsUrl})` : "";
	const distance = [walking ? `${walking} on foot` : "", driving ? `${driving} by car` : ""]
		.filter(Boolean)
		.join(" and ");
	if (/arabic/i.test(lang)) {
		const distanceAr = distance ? ` \u0627\u0644\u0645\u0633\u0627\u0641\u0629 \u062a\u0642\u0631\u064a\u0628\u0627 ${distance}.` : "";
		return `${name}\u060c \u0644\u0627 \u0623\u0645\u0644\u0643 \u0627\u0632\u062f\u062d\u0627\u0645\u0627 \u0645\u0628\u0627\u0634\u0631\u0627\u060c \u0644\u0643\u0646 \u0627\u0644\u0623\u0641\u0636\u0644 \u0627\u0644\u062e\u0631\u0648\u062c \u0645\u0628\u0643\u0631\u0627 \u0642\u0628\u0644 \u0645\u0648\u0639\u062f \u0627\u0644\u0635\u0644\u0627\u0629 \u062e\u0635\u0648\u0635\u0627 \u0641\u064a \u0623\u0648\u0642\u0627\u062a \u0627\u0644\u0630\u0631\u0648\u0629.${distanceAr}${mapPart ? ` ${mapPart}` : ""}`;
	}
	if (/spanish/i.test(lang)) {
		return `${name}, I do not have live crowd or traffic data, so I recommend leaving early before prayer times, especially at busy periods.${distance ? ` The hotel is about ${distance}.` : ""}${mapPart}`;
	}
	if (/french/i.test(lang)) {
		return `${name}, I do not have live crowd or traffic data, so I recommend leaving early before prayer times, especially at busy periods.${distance ? ` The hotel is about ${distance}.` : ""}${mapPart}`;
	}
	return `${name}, I do not have live crowd or traffic data, so I recommend leaving early before prayer times, especially at busy periods.${distance ? ` The hotel is about ${distance}.` : ""}${mapPart}`;
}

function postBookingLocalRecommendationText(sc = {}, st = {}) {
	const lang = languageOf(sc, st);
	const name = respectfulGuestName(sc, st);
	const hotelName = localizedHotelName(sc, st);
	const mapsUrl = hotelGoogleMapsUrl(st.hotel || {});
	const mapLink = mapsUrl ? `[Hotel location on Google Maps](${mapsUrl})` : "";
	if (/arabic/i.test(lang)) {
		const mapPart = mapLink
			? ` \u0648\u0627\u0633\u062a\u062e\u062f\u0645 \u0647\u0630\u0627 \u0627\u0644\u0631\u0627\u0628\u0637 \u0644\u0645\u0631\u0627\u062c\u0639\u0629 \u0627\u0644\u0645\u0643\u0627\u0646: ${mapLink}.`
			: "";
		return `${name}\u060c \u0644\u0627 \u0623\u0645\u0644\u0643 \u0623\u0633\u0645\u0627\u0621 \u0645\u0637\u0627\u0639\u0645 \u0623\u0648 \u0645\u062d\u0644\u0627\u062a \u0645\u0624\u0643\u062f\u0629 \u062d\u0648\u0644 ${hotelName} \u0645\u0646 \u0633\u062c\u0644 \u0627\u0644\u0641\u0646\u062f\u0642 \u062d\u0627\u0644\u064a\u0627.${mapPart} \u0639\u0646\u062f \u0627\u0644\u0648\u0635\u0648\u0644\u060c \u0627\u0644\u0627\u0633\u062a\u0642\u0628\u0627\u0644 \u064a\u0642\u062f\u0631 \u064a\u0631\u0634\u062f\u0643 \u0644\u0623\u0642\u0631\u0628 \u0627\u0644\u062e\u064a\u0627\u0631\u0627\u062a.`;
	}
	if (/spanish/i.test(lang)) {
		const mapPart = mapLink ? ` You can use ${mapLink} to check the area.` : "";
		return `${name}, I do not have verified restaurant or shop names around ${hotelName} in the hotel record right now.${mapPart} On arrival, reception can point you to the closest reliable options.`;
	}
	if (/french/i.test(lang)) {
		const mapPart = mapLink ? ` You can use ${mapLink} to check the area.` : "";
		return `${name}, I do not have verified restaurant or shop names around ${hotelName} in the hotel record right now.${mapPart} On arrival, reception can point you to the closest reliable options.`;
	}
	const mapPart = mapLink ? ` You can use ${mapLink} to check what is around the hotel.` : "";
	return `${name}, I do not have verified restaurant or shop names around ${hotelName} in the hotel record right now.${mapPart} On arrival, reception can point you to the closest reliable options.`;
}

function postBookingNusukAppointmentQuestionText(text = "") {
	const { lower, arabic, latinCompact } = normalizeControlText(text);
	const mentionsNusuk =
		/\b(?:nusuk|nusk)\b/i.test(lower) ||
		/(?:\u0646\u0633\u0643)/i.test(arabic) ||
		/(?:nusuk|nusk)/i.test(latinCompact);
	if (!mentionsNusuk) return false;
	return (
		/\b(?:rawdah|rawda|appointment|appointments?|permit|permits?|required|need|needed|umrah|hajj|ziyarah|visit)\b/i.test(
			lower
		) ||
		/(?:\u0627\u0644\u0631\u0648\u0636\u0629|\u0631\u0648\u0636\u0629|\u0645\u0648\u0639\u062f|\u0645\u0648\u0627\u0639\u064a\u062f|\u062a\u0635\u0631\u064a\u062d|\u062a\u0635\u0627\u0631\u064a\u062d|\u0645\u0637\u0644\u0648\u0628|\u0644\u0627\u0632\u0645|\u0627\u062d\u062a\u0627\u062c|\u0627\u0644\u0639\u0645\u0631\u0629|\u0639\u0645\u0631\u0629|\u0627\u0644\u062d\u062c|\u062d\u062c|\u0632\u064a\u0627\u0631\u0629)/i.test(
			arabic
		) ||
		/(?:rawdah|rawda|appointment|permit|required|need|umrah|hajj|ziyarah|visit)/i.test(
			latinCompact
		)
	);
}

function postBookingNusukAppointmentText(sc = {}, st = {}) {
	const lang = languageOf(sc, st);
	const name = respectfulGuestName(sc, st);
	const ref = aiReservationReference(sc);
	const confirmation = ref?.confirmation_number || "";
	if (/arabic/i.test(lang)) {
		const booking = confirmation
			? ` \u062d\u062c\u0632\u0643 \u0631\u0642\u0645 ${confirmation} \u0645\u0624\u0643\u062f.`
			: "";
		return `${name}\u060c \u0628\u0627\u0644\u0646\u0633\u0628\u0629 \u0644\u0646\u0633\u0643\u060c \u0627\u0644\u0623\u0641\u0636\u0644 \u0627\u0633\u062a\u062e\u062f\u0627\u0645 \u062a\u0637\u0628\u064a\u0642 Nusuk \u0627\u0644\u0631\u0633\u0645\u064a \u0644\u0645\u0648\u0627\u0639\u064a\u062f \u0627\u0644\u0631\u0648\u0636\u0629 \u0623\u0648 \u0627\u0644\u062a\u0635\u0627\u0631\u064a\u062d \u0627\u0644\u0631\u0633\u0645\u064a\u0629 \u0625\u0630\u0627 \u0643\u0627\u0646\u062a \u0645\u0637\u0644\u0648\u0628\u0629 \u0644\u0643. \u0627\u0644\u0641\u0646\u062f\u0642 \u0644\u0627 \u064a\u0635\u062f\u0631 \u0645\u0648\u0627\u0639\u064a\u062f Nusuk\u060c \u0644\u0643\u0646 \u0627\u0644\u0627\u0633\u062a\u0642\u0628\u0627\u0644 \u064a\u0642\u062f\u0631 \u064a\u0633\u0627\u0639\u062f\u0643 \u0641\u064a \u0627\u0644\u0625\u0631\u0634\u0627\u062f \u0639\u0646\u062f \u0627\u0644\u0648\u0635\u0648\u0644.${booking}`;
	}
	if (/spanish/i.test(lang)) {
		return `${name}, for Nusuk appointments or official permits such as Rawdah, please use the official Nusuk app and follow the app availability. The hotel booking${confirmation ? ` ${confirmation}` : ""} is confirmed, but the hotel does not issue Nusuk appointments.`;
	}
	if (/french/i.test(lang)) {
		return `${name}, pour les rendez-vous Nusuk ou les permis officiels comme Rawdah, utilisez l'application officielle Nusuk et suivez les disponibilites indiquees. La reservation${confirmation ? ` ${confirmation}` : ""} est confirmee, mais l'hotel ne delivre pas les rendez-vous Nusuk.`;
	}
	if (/urdu|hindi/i.test(lang)) {
		return `${name}, Nusuk appointments ya official permits jaise Rawdah ke liye official Nusuk app use karein. Hotel booking${confirmation ? ` ${confirmation}` : ""} confirmed hai, lekin hotel Nusuk appointments issue nahi karta.`;
	}
	if (/indonesian/i.test(lang)) {
		return `${name}, untuk janji temu Nusuk atau izin resmi seperti Rawdah, gunakan aplikasi resmi Nusuk dan ikuti ketersediaan di aplikasi. Reservasi hotel${confirmation ? ` ${confirmation}` : ""} sudah terkonfirmasi, tetapi hotel tidak menerbitkan janji temu Nusuk.`;
	}
	if (/malay|malaysia/i.test(lang)) {
		return `${name}, untuk janji temu Nusuk atau permit rasmi seperti Rawdah, gunakan aplikasi rasmi Nusuk dan ikut ketersediaan dalam aplikasi. Tempahan hotel${confirmation ? ` ${confirmation}` : ""} sudah disahkan, tetapi hotel tidak mengeluarkan janji temu Nusuk.`;
	}
	return `${name}, for Nusuk appointments or official permits such as Rawdah, please use the official Nusuk app and follow the availability shown there. Your hotel booking${confirmation ? ` ${confirmation}` : ""} is confirmed, but the hotel does not issue Nusuk appointments.`;
}

function postBookingPaymentHelpText(sc = {}, st = {}) {
	const lang = languageOf(sc, st);
	const name = respectfulGuestName(sc, st);
	const ref = aiReservationReference(sc);
	const links = ref ? reservationLinks(ref) : {};
	const confirmation = ref?.confirmation_number || "";
	if (/arabic/i.test(lang)) {
		const linkPart = links.payment
			? ` \u0631\u0627\u0628\u0637 \u0627\u0644\u062f\u0641\u0639: ${links.payment}`
			: "";
		return `${name}\u060c \u062d\u062c\u0632\u0643 ${confirmation ? `\u0631\u0642\u0645 ${confirmation} ` : ""}\u0645\u0624\u0643\u062f.${linkPart} \u0645\u0646 \u0641\u0636\u0644\u0643 \u0644\u0627 \u062a\u0631\u0633\u0644 \u0628\u064a\u0627\u0646\u0627\u062a \u0627\u0644\u0628\u0637\u0627\u0642\u0629 \u0641\u064a \u0627\u0644\u062f\u0631\u062f\u0634\u0629.`;
	}
	const linkPart = links.payment ? ` Payment link: ${links.payment}` : "";
	return `${name}, your reservation ${confirmation ? `${confirmation} ` : ""}is confirmed.${linkPart} Please do not send card details in chat.`;
}

function postBookingUnsupportedText(sc = {}, st = {}) {
	const lang = languageOf(sc, st);
	const name = respectfulGuestName(sc, st);
	const ref = aiReservationReference(sc);
	const confirmation = ref?.confirmation_number || "";
	if (/arabic/i.test(lang)) {
		const booking = confirmation
			? ` \u062d\u062c\u0632\u0643 \u0631\u0642\u0645 ${confirmation} \u0645\u0624\u0643\u062f.`
			: "";
		return `${name}\u060c \u0644\u0627 \u0623\u0645\u0644\u0643 \u0625\u062c\u0627\u0628\u0629 \u0645\u0624\u0643\u062f\u0629 \u0644\u0647\u0630\u0627 \u0627\u0644\u0627\u0633\u062a\u0641\u0633\u0627\u0631 \u0645\u0646 \u0628\u064a\u0627\u0646\u0627\u062a \u0627\u0644\u0641\u0646\u062f\u0642 \u062d\u0627\u0644\u064a\u0627.${booking} \u0623\u0642\u062f\u0631 \u0623\u0633\u0627\u0639\u062f\u0643 \u0641\u064a \u0631\u0642\u0645 \u0627\u0644\u062a\u0623\u0643\u064a\u062f\u060c \u0627\u0644\u062f\u0641\u0639\u060c \u0627\u0644\u062e\u0631\u064a\u0637\u0629\u060c \u0646\u0633\u0643\u060c \u0623\u0648 \u0633\u064a\u0627\u0633\u0629 \u0627\u0644\u0625\u0644\u063a\u0627\u0621.`;
	}
	const booking = confirmation ? ` Your reservation ${confirmation} is confirmed.` : "";
	return `${name}, I do not have a verified answer for that question from the hotel record right now.${booking} I can still help with the confirmation number, payment link, map, Nusuk, cancellation/refund policy, or hotel details.`;
}

function isPostBookingClosure(text = "") {
	const normalized = String(text || "").trim().toLowerCase();
	if (!normalized) return false;
	if (
		/[?؟]/.test(normalized) ||
		/\b(?:how\s+are\s+you|can\s+you|could\s+you|please\s+(?:tell|send|share|repeat|remind)|tell\s+me|what|where|when|why|how\s+(?:far|much|many|do|can|is)|is\s+there|do\s+you|does\s+the|which|summarize|summary|recap|remind|repeat)\b/i.test(
			normalized
		)
	) {
		return false;
	}
	if (
		/^(no|nope|no thanks|no thank you|nothing|that's all|that is all|all good|thanks|thank you)\b/i.test(
			normalized
		) &&
		!(
			/\b(pay|payment|link|change|update|cancel|refund|another booking|new booking|book another|reserve another)\b/i.test(
				normalized
			) && !botExperienceComplaintText(normalized)
		)
	) {
		return true;
	}
	return /^(no|no thanks|nothing|that's all|that is all|all good|thanks|thank you|\u0634\u0643\u0631\u0627|\u0634\u0643\u0631\u064b\u0627|\u0644\u0627|\u0644\u0627\s+\u0634\u0643\u0631\u0627|\u062e\u0644\u0627\u0635|(?:\u0627\u0646\u0627|\u0623\u0646\u0627|\u0627\u0646\u064a|\u0625\u0646\u064a)\s+\u062a\u0645\u0627\u0645\s*(?:\u0634\u0643\u0631\u0627|\u0634\u0643\u0631\u064b\u0627)?|\u062a\u0645\u0627\u0645\s*(?:\u0634\u0643\u0631\u0627|\u0634\u0643\u0631\u064b\u0627)?|\u0643\u062f\u0647\s+\u062a\u0645\u0627\u0645|\u0645\u0627\u0641\u064a\u0634|\u0645\u0634\s+\u0645\u062d\u062a\u0627\u062c|\u0628\u0633\s+\u0643\u062f\u0647|merci|non merci|gracias|no gracias)\.?$/i.test(
		normalized
	);
}

function isPostBookingConcreteRequest(text = "") {
	const normalized = String(text || "").trim();
	if (!normalized) return false;
	if (botExperienceComplaintText(normalized)) return false;
	return (
		bookingStateQuestionText(normalized) ||
		wantsPaymentHelp(normalized) ||
		wantsReservationHelp(normalized) ||
		selectedHotelFactQuestionText(normalized) ||
		selectedHotelRoomQuestionText(normalized) ||
		Boolean(findAmenityMatch(normalized)) ||
		/\b(can you|could you|please tell|tell me|i need|i want|where|when|how much|how do|what is|what time|is there|do you)\b/i.test(
			normalized
		)
	);
}

async function handlePostBookingDeliveryRequest(io, sc, st, userText = "") {
	const request = confirmationRequestSignals(userText);
	if (!request.email && !request.whatsapp && !request.link) return false;
	const ref = aiReservationReference(sc);
	if (!ref) return false;
	const links = reservationLinks(ref);
	const confirmation = ref.confirmation_number || "";

	let delivery = null;
	let channel = request.link ? "link" : request.email ? "email" : "whatsapp";
	if (request.email || request.whatsapp) {
		try {
			delivery = await dispatchAiReservationConfirmation({
				caseId: String(sc._id || ""),
				reservation: ref,
				mode: request.email && request.whatsapp ? "resend" : `${channel}_resend`,
				includeGuestEmail: request.email,
				includeInternalEmail: false,
				includeOwnerEmail: false,
				includeGuestWhatsApp: request.whatsapp,
				includeAdminWhatsApp: false,
				guestEmail: st.slots?.email || "",
			});
			logStep(String(sc._id), "post_booking.confirmation_delivery", {
				confirmation,
				request,
				status: confirmationDeliverySummary(delivery),
			});
		} catch (error) {
			delivery = {
				ok: false,
				links: {
					reservationConfirmation: links.reservationDetails,
					payment: links.payment,
				},
				email: request.email
					? { attempted: true, guest: { ok: false, error: "send_failed" } }
					: {},
				whatsapp: request.whatsapp
					? { attempted: true, guest: { ok: false, error: "send_failed" } }
					: {},
			};
			logStep(String(sc._id), "post_booking.confirmation_delivery_failed", {
				confirmation,
				request,
				error: String(error?.message || error || "").slice(0, 200),
			});
		}
	}

	const deliveryStatus = confirmationDeliverySummary(delivery || {});
	const linkContext = {
		reservationDetails:
			delivery?.links?.reservationConfirmation || links.reservationDetails,
		payment: delivery?.links?.payment || links.payment,
	};
	await humanSend(
		io,
		sc,
		st,
		confirmationDeliveryFallbackText(sc, st, {
			channel,
			confirmation,
			links: linkContext,
			delivery: deliveryStatus,
		}),
		{ targetReplyMs: AI_BOOKING_PROMPT_TARGET_MS }
	);
	st.waitFor = "post_booking_followup";
	return true;
}

function isVaguePositive(text = "") {
	const normalized = String(text || "").trim().toLowerCase();
	return /^(yes|yes please|yeah|yep|sure|ok|okay|\u0627\u064a\u0648\u0647|\u0623\u064a\u0648\u0647|\u0646\u0639\u0645|\u062a\u0645\u0627\u0645|\u0627\u0647|\u0622\u0647|oui|si|s\u00ed)\.?$/i.test(
		normalized
	);
}

function hajjInquiryFallbackText(sc = {}, st = {}) {
	const name = respectfulGuestName(sc, st);
	const lang = languageOf(sc, st);
	if (/arabic/i.test(lang)) {
		return `${name}\u060c \u0623\u0639\u062a\u0630\u0631 \u0644\u0644\u062e\u0644\u0637. \u0628\u062e\u0635\u0648\u0635 \u0627\u0644\u062d\u062c\u060c \u0644\u0627 \u062a\u062a\u0648\u0641\u0631 \u0644\u062f\u064a \u062a\u0641\u0627\u0635\u064a\u0644 \u0645\u0624\u0643\u062f\u0629 \u062d\u0627\u0644\u064a\u0627 \u0639\u0646 \u0627\u0644\u062a\u0646\u0638\u064a\u0645 \u0623\u0648 \u0627\u0644\u0641\u0626\u0627\u062a. ${unsupportedAnswerNextStepText(sc, st)}`;
	}
	if (/spanish/i.test(lang)) {
		return `${name}, perdona la confusion. Sobre Hajj, no tengo ahora datos verificados sobre organizacion o categorias. ${unsupportedAnswerNextStepText(sc, st)}`;
	}
	if (/french/i.test(lang)) {
		return `${name}, desole pour la confusion. Pour le Hajj, je n'ai pas actuellement d'informations verifiees sur l'organisation ou les categories. ${unsupportedAnswerNextStepText(sc, st)}`;
	}
	return `${name}, sorry for the confusion. For Hajj, I do not currently have verified details about organization or categories. ${unsupportedAnswerNextStepText(sc, st)}`;
}

async function answerVagueHajjInquiry(io, sc, st, userText = "") {
	const fallback = hajjInquiryFallbackText(sc, st);
	const reply = await write(
		io,
		sc,
		st,
		"The guest asked a broad Hajj/Haj-related question, not a payment/reference question. First check the provided hotel facts, platform context, previous guest context, and employee learning examples. If those contexts contain a verified answer to this exact Hajj question, answer it directly and briefly using only that verified context. If they do not contain a verified answer, apologize briefly, say you do not currently have confirmed details about Hajj organization/packages/categories, then use unknownAnswerNextStep to move back to the relevant hotel/reservation topic. Do not invent facts. Do not direct the guest to email or escalation. Do not repeat reservation details, quotes, confirmation numbers, or payment links. Do not ask for a payment reference or reservation number.",
		{
			latestUserMessage: userText,
			hotelName: localizedHotelName(sc, st),
			unknownAnswerNextStep: unsupportedAnswerNextStepText(sc, st),
			reservationAlreadyCreated:
				sc.aiReservation?.status === "created" ||
				Boolean(sc.aiReservation?.confirmationNumber),
		}
	);
	await humanSend(io, sc, st, stripUnsupportedEscalationText(reply, fallback));
	st.waitFor =
		sc.aiReservation?.status === "created" || sc.aiReservation?.confirmationNumber
			? "post_booking_followup"
			: "clarify";
	return true;
}

function unsupportedAnswerNextStepText(sc = {}, st = {}) {
	const lang = languageOf(sc, st);
	const hotelName = st.hotel ? localizedHotelName(sc, st) : "";
	const pivot = st?.slots ? nextPivot(st) : "dates";
	if (/arabic/i.test(lang)) {
		if (hotelName) {
			if (pivot === "room") {
				return `\u064a\u0633\u0639\u062f\u0646\u064a \u0623\u0633\u0627\u0639\u062f\u0643 \u0641\u064a ${hotelName}: \u0645\u0627 \u0646\u0648\u0639 \u0627\u0644\u063a\u0631\u0641\u0629 \u0623\u0648 \u0639\u062f\u062f \u0627\u0644\u0636\u064a\u0648\u0641 \u0627\u0644\u0630\u064a \u062a\u0641\u0636\u0644\u0647\u061f`;
			}
			if (pivot === "proceed") {
				return `\u064a\u0633\u0639\u062f\u0646\u064a \u0623\u0633\u0627\u0639\u062f\u0643 \u0641\u064a ${hotelName}. \u0647\u0644 \u0623\u062a\u0627\u0628\u0639 \u0645\u0639\u0643 \u0625\u0644\u0649 \u0645\u0631\u0627\u062c\u0639\u0629 \u0627\u0644\u062d\u062c\u0632\u061f`;
			}
			return `\u064a\u0633\u0639\u062f\u0646\u064a \u0623\u0633\u0627\u0639\u062f\u0643 \u0641\u064a ${hotelName}: \u0623\u0631\u0633\u0644 \u062a\u0627\u0631\u064a\u062e \u0627\u0644\u0648\u0635\u0648\u0644 \u0648\u0627\u0644\u0645\u063a\u0627\u062f\u0631\u0629 \u0623\u0648 \u0646\u0648\u0639 \u0627\u0644\u063a\u0631\u0641\u0629 \u0627\u0644\u0645\u0641\u0636\u0644 \u0648\u0623\u0631\u0627\u062c\u0639 \u0644\u0643 \u0623\u0641\u0636\u0644 \u062e\u064a\u0627\u0631 \u0645\u062a\u0627\u062d.`;
		}
		return "\u064a\u0633\u0639\u062f\u0646\u064a \u0623\u0633\u0627\u0639\u062f\u0643 \u0628\u062e\u064a\u0627\u0631 \u0645\u0646\u0627\u0633\u0628: \u0623\u0631\u0633\u0644 \u0627\u0644\u0645\u062f\u064a\u0646\u0629 \u0648\u0627\u0644\u062a\u0648\u0627\u0631\u064a\u062e \u0648\u0639\u062f\u062f \u0627\u0644\u0636\u064a\u0648\u0641 \u0648\u0623\u0631\u0627\u062c\u0639 \u0644\u0643 \u0623\u0641\u0636\u0644 \u0627\u0644\u062e\u064a\u0627\u0631\u0627\u062a.";
	}
	if (/spanish/i.test(lang)) {
		if (hotelName) {
			if (pivot === "room") {
				return `Con gusto puedo seguir con ${hotelName}: que tipo de habitacion o cuantos huespedes necesitas?`;
			}
			if (pivot === "proceed") {
				return `Con gusto puedo seguir con ${hotelName}. Quieres que pase a la revision de la reserva?`;
			}
			return `Con gusto puedo seguir con ${hotelName}: enviame llegada, salida o el tipo de habitacion preferido y reviso la mejor opcion disponible.`;
		}
		return "Con gusto puedo ayudarte a encontrar una buena opcion: enviame ciudad, fechas y numero de huespedes y reviso las mejores opciones.";
	}
	if (/french/i.test(lang)) {
		if (hotelName) {
			if (pivot === "room") {
				return `Je peux continuer a vous aider pour ${hotelName}: quel type de chambre ou combien de personnes faut-il prevoir ?`;
			}
			if (pivot === "proceed") {
				return `Je peux continuer a vous aider pour ${hotelName}. Souhaitez-vous que je passe a la revision de la reservation ?`;
			}
			return `Je peux continuer a vous aider pour ${hotelName}: envoyez-moi l'arrivee, le depart ou le type de chambre prefere, et je verifierai la meilleure option disponible.`;
		}
		return "Je peux vous aider a trouver une bonne option: envoyez-moi la ville, les dates et le nombre de personnes, et je verifierai les meilleures options.";
	}
	if (hotelName) {
		if (pivot === "room") {
			return `I can still help with ${hotelName}: which room type or guest count should I prepare for you?`;
		}
		if (pivot === "proceed") {
			return `I can still help with ${hotelName}. Would you like me to continue with the reservation details?`;
		}
		return `I can still help with ${hotelName}: send your check-in and checkout dates or preferred room type, and I will check the best available option.`;
	}
	return "I can still help you find a suitable hotel option: send the city, dates, and guest count, and I will check the best matches.";
}

function supportEmailFallbackText(sc = {}, st = {}) {
	const name = respectfulGuestName(sc, st);
	const hotelName = st.hotel ? localizedHotelName(sc, st) : "";
	const lang = languageOf(sc, st);
	if (/arabic/i.test(lang)) {
		return hotelName
			? `${name}\u060c \u0644\u0627 \u0623\u0645\u0644\u0643 \u0625\u062c\u0627\u0628\u0629 \u0645\u0624\u0643\u062f\u0629 \u0644\u0647\u0630\u0627 \u0627\u0644\u0627\u0633\u062a\u0641\u0633\u0627\u0631 \u0645\u0646 \u062f\u0631\u062f\u0634\u0629 ${hotelName} \u062d\u0627\u0644\u064a\u0627. ${unsupportedAnswerNextStepText(sc, st)}`
			: `${name}\u060c \u0644\u0627 \u0623\u0645\u0644\u0643 \u0625\u062c\u0627\u0628\u0629 \u0645\u0624\u0643\u062f\u0629 \u0644\u0647\u0630\u0627 \u0627\u0644\u0627\u0633\u062a\u0641\u0633\u0627\u0631 \u062d\u0627\u0644\u064a\u0627. ${unsupportedAnswerNextStepText(sc, st)}`;
	}
	if (/spanish/i.test(lang)) {
		return `${name}, no tengo una respuesta verificada para esa consulta en este chat ahora mismo. ${unsupportedAnswerNextStepText(sc, st)}`;
	}
	if (/french/i.test(lang)) {
		return `${name}, je n'ai pas de reponse verifiee pour cette question dans ce chat pour le moment. ${unsupportedAnswerNextStepText(sc, st)}`;
	}
	return `${name}, I do not have a verified answer for that question in this chat right now. ${unsupportedAnswerNextStepText(sc, st)}`;
}

function stripUnsupportedEscalationText(text = "", fallback = "") {
	const raw = String(text || "").trim();
	const safeFallback = String(fallback || "").trim();
	if (!raw) return safeFallback;
	const sentences = raw
		.split(/(?<=[.!?\u061f])\s+|\n+/)
		.map((sentence) => sentence.trim())
		.filter(Boolean);
	const kept = sentences.filter((sentence) => {
		const lower = sentence.toLowerCase();
		const arabic = sentence;
		return !(
			/\b(?:support@jannatbooking\.com|management@xhotelpro\.com)\b/i.test(
				lower
			) ||
			/\b(?:email|e-mail|contact|reach out to|write to)\s+(?:support|us|the team)\b/i.test(
				lower
			) ||
			/\b(?:support team|customer support)\b/i.test(lower) ||
			/(?:\u0631\u0627\u0633\u0644|\u062a\u0648\u0627\u0635\u0644).*(?:\u0627\u0644\u062f\u0639\u0645|\u0627\u0644\u0641\u0631\u064a\u0642)/i.test(
				arabic
			)
		);
	});
	const cleaned = kept.join(" ").trim();
	return cleaned || safeFallback;
}

function technicalRecoveryText(sc = {}, st = {}) {
	const name = respectfulGuestName(sc, st);
	const lang = languageOf(sc, st);
	if (/arabic/i.test(lang)) {
		return `${name}\u060c \u0622\u0633\u0641 \u062d\u0635\u0644 \u062a\u0623\u062e\u064a\u0631 \u062a\u0642\u0646\u064a \u0628\u0633\u064a\u0637 \u0648\u0623\u0646\u0627 \u0628\u0631\u0627\u062c\u0639 \u0637\u0644\u0628\u0643. \u0645\u0646 \u0641\u0636\u0644\u0643 \u0623\u0631\u0633\u0644 \u0622\u062e\u0631 \u0646\u0642\u0637\u0629 \u0645\u0631\u0629 \u0623\u062e\u0631\u0649 \u0648\u0633\u0623\u0643\u0645\u0644 \u0645\u0639\u0643 \u0641\u0648\u0631\u0627.`;
	}
	if (/spanish/i.test(lang)) {
		return `${name}, perdona, hubo una pequena demora tecnica mientras revisaba tu solicitud. Enviame el ultimo punto otra vez y continuo enseguida.`;
	}
	if (/french/i.test(lang)) {
		return `${name}, desole, il y a eu un petit retard technique pendant la verification. Renvoyez-moi le dernier point et je continue tout de suite.`;
	}
	return `${name}, sorry, I had a small technical delay while checking your request. Please send the last point once more and I will continue right away.`;
}

function previousChatContinuationRequestText(text = "") {
	const raw = String(text || "").trim();
	if (!raw) return false;
	const { lower, arabic, latinCompact } = normalizeControlText(raw);
	const mentionsPreviousContext =
		/\b(?:previous|prev|last|old|earlier|past|prior|yesterday|before|already|again|same)\b/i.test(
			lower
		) ||
		/(?:\u0627\u0644\u0633\u0627\u0628\u0642|\u0633\u0627\u0628\u0642|\u0627\u0644\u0645\u0627\u0636\u064a|\u0627\u062e\u0631|\u0622\u062e\u0631|\u0642\u0628\u0644|\u0645\u0646\s+\u0642\u0628\u0644|\u0627\u0645\u0628\u0627\u0631\u062d|\u0627\u0644\u0644\u064a\s+\u0642\u0644\u062a\u0647|\u0642\u0644\u062a\u0647\s+\u0642\u0628\u0644)/i.test(
			arabic
		) ||
		/(?:previous|prev|last|old|earlier|past|prior|yesterday|before|already|same|anteriores|anterior|previo|precedente|sebelumnya|sebelum|pehle|pichli|purani)/i.test(
			latinCompact
		);
	const mentionsChat =
		/\b(?:chat|conversation|case|thread|session|ticket|message|discussion|talk|request|booking|reservation)\b/i.test(
			lower
		) ||
		/(?:\u0634\u0627\u062a|\u0645\u062d\u0627\u062f\u062b\u0647|\u0645\u062d\u0627\u062f\u062b\u0629|\u0645\u0643\u0627\u0644\u0645\u0647|\u0645\u0643\u0627\u0644\u0645\u0629|\u0631\u0633\u0627\u0644\u0647|\u0631\u0633\u0627\u0644\u0629|\u0637\u0644\u0628|\u062d\u062c\u0632|\u062a\u0630\u0643\u0631\u0647|\u062a\u0630\u0643\u0631\u0629)/i.test(
			arabic
		) ||
		/(?:chat|conversation|case|thread|session|ticket|message|discussion|request|booking|reservation|conversacion|conversa|conversation|percakapan|perbualan|tempahan|reservasi)/i.test(
			latinCompact
		);
	const asksToContinue =
		/\b(?:continue|resume|complete|finish|carry\s+on|pick\s+up|start\s+from|go\s+on|proceed\s+from)\b/i.test(
			lower
		) ||
		/(?:\u0646\u0643\u0645\u0644|\u0643\u0645\u0644|\u0627\u0643\u0645\u0644|\u0623\u0643\u0645\u0644|\u0646\u062a\u0627\u0628\u0639|\u062a\u0627\u0628\u0639|\u0627\u062e\u0644\u0635|\u0643\u0645\u0644\u0647|\u0643\u0645\u0644\u0647\u0627)/i.test(
			arabic
		) ||
		/(?:continue|resume|complete|finish|carryon|pickup|startfrom|continuar|retomar|reprendre|continuer|sambung|lanjut|teruskan|jari|rakho)/i.test(
			latinCompact
		);
	const asksIfRemember =
		/\b(?:remember|recall|you\s+know|as\s+i\s+said|as\s+we\s+discussed|we\s+talked|i\s+told\s+you|sent\s+you)\b/i.test(
			lower
		) ||
		/(?:\u0641\u0627\u0643\u0631|\u062a\u0641\u062a\u0643\u0631|\u0632\u064a\s+\u0645\u0627\s+\u0642\u0644\u062a|\u0632\u064a\s+\u0645\u0627\s+\u0627\u062a\u0643\u0644\u0645\u0646\u0627|\u0643\u0646\u0627\s+\u0627\u062a\u0643\u0644\u0645\u0646\u0627|\u0628\u0639\u062a\u0644\u0643|\u0627\u0631\u0633\u0644\u062a\s+\u0644\u0643)/i.test(
			arabic
		) ||
		/(?:remember|recall|youknow|asisaid|aswediscussed|wetalked|itoldyou|sentyou|teacuerdas|recuerdas|souviens|ingat)/i.test(
			latinCompact
		);
	return (
		(mentionsPreviousContext && mentionsChat) ||
		(asksToContinue && mentionsPreviousContext) ||
		(asksIfRemember && (mentionsChat || mentionsPreviousContext))
	);
}

function previousChatBoundaryFallbackText(sc = {}, st = {}) {
	const name = respectfulGuestName(sc, st);
	const lang = languageOf(sc, st);
	const hotelName = localizedHotelName(sc, st);
	if (/arabic/i.test(lang)) {
		return `${name}\u060c \u0644\u062d\u0645\u0627\u064a\u0629 \u062e\u0635\u0648\u0635\u064a\u062a\u0643 \u0647\u0630\u0647 \u0645\u062d\u0627\u062f\u062b\u0629 \u062c\u062f\u064a\u062f\u0629 \u0648\u0623\u062a\u0639\u0627\u0645\u0644 \u0645\u0639 \u0627\u0644\u062a\u0641\u0627\u0635\u064a\u0644 \u0627\u0644\u062a\u064a \u062a\u0631\u0633\u0644\u0647\u0627 \u0647\u0646\u0627 \u0641\u0642\u0637. \u0634\u0643\u0631\u0627 \u0644\u0635\u0628\u0631\u0643\u060c \u0648\u0644\u0646 \u064a\u0633\u062a\u063a\u0631\u0642 \u0627\u0644\u0623\u0645\u0631 \u0648\u0642\u062a\u0627 \u0637\u0648\u064a\u0644\u0627. \u0623\u0631\u0633\u0644 \u0644\u064a \u0628\u0627\u062e\u062a\u0635\u0627\u0631 \u0645\u0627 \u062a\u0631\u064a\u062f \u0625\u0643\u0645\u0627\u0644\u0647${st.hotel ? ` \u0641\u064a ${hotelName}` : ""}\u060c \u0648\u0633\u0623\u062a\u0627\u0628\u0639 \u0645\u0639\u0643 \u062e\u0637\u0648\u0629 \u0628\u062e\u0637\u0648\u0629.`;
	}
	if (/spanish/i.test(lang)) {
		return `${name}, por tu seguridad y privacidad, trato este chat como una conversacion nueva y solo uso los detalles que compartas aqui. Gracias por tu paciencia; no tomara mucho tiempo. Enviame brevemente lo que deseas completar${st.hotel ? ` para ${hotelName}` : ""} y continuo contigo paso a paso.`;
	}
	if (/french/i.test(lang)) {
		return `${name}, pour votre securite et votre confidentialite, je traite ce chat comme une nouvelle conversation et j'utilise uniquement les details que vous partagez ici. Merci pour votre patience; cela ne prendra pas longtemps. Envoyez-moi brievement ce que vous souhaitez finaliser${st.hotel ? ` pour ${hotelName}` : ""} et je continue avec vous etape par etape.`;
	}
	return `${name}, for your security and privacy, I treat this as a fresh chat and only use the details you share here. Thank you for your patience; it will not take long. Send me a quick summary of what you would like to complete${st.hotel ? ` for ${hotelName}` : ""}, and I will continue with you step by step.`;
}

async function answerPreviousChatContinuationRequest(io, sc, st, userText = "") {
	const fallback = previousChatBoundaryFallbackText(sc, st);
	const reply = await write(
		io,
		sc,
		st,
		"The guest is asking to continue, resume, remember, or complete a previous chat/conversation. Reply as a professional hospitality sales/support agent. Do not claim or imply access to previous chats. Do not quote, summarize, or use previous-chat details. Say that for the guest's security and privacy this chat is handled fresh using only details shared here. Thank them warmly for patience, reassure them it is completely okay and should not take long to restart, and keep the sale/support moving. Ask for one concise current-chat summary or the next needed detail, not a long form. Use the active response language and sound warm, confident, and valuable.",
		{
			latestUserMessage: userText,
			previousChatBoundary: true,
			selectedHotel: st.hotel ? localizedHotelName(sc, st) : "",
			fallbackText: fallback,
		}
	);
	await humanSend(io, sc, st, stripGeneralBookingPivot(reply || fallback, fallback));
	st.waitFor = "clarify";
	logStep(String(sc._id), "previous_chat_boundary.reply", {
		latestUserMessage: String(userText || "").slice(0, 160),
	});
	return true;
}

function broadGeneralSupportQuestionText(text = "", st = {}, lu = {}) {
	const normalized = String(text || "").trim();
	if (!normalized) return false;
	if (looksLikeGreetingOnly(normalized) || lu?.intent === "smalltalk") return false;
	const { lower, arabic, latinCompact } = normalizeControlText(normalized);
	const broadServiceSignal =
		/\b(?:insurance|medical|visa|flight|flights|ticket|tickets|airport|transport|transfer|shuttle|tour|permit|hajj|haj|umrah|organize|organisation|organization|arrange)\b/i.test(
			lower
		) ||
		/(?:تأمين|تامين|فيزا|تأشيرة|تاشيرة|طيران|تذاكر|مطار|نقل|مواصلات|باص|جولة|تصريح|الحج|حج|العمرة|عمرة|تنظيم|ترتيب)/.test(
			arabic
		) ||
		/(?:visapackage|medicalinsurance|travelinsurance|airporttransfer|hajjpackage|umrahpackage)/i.test(
			latinCompact
		);
	const brandBookingOnly =
		/\bjannat\s*booking\b/i.test(lower) &&
		!/\b(?:my|existing|old|current|previous)\s+(?:booking|reservation)\b/i.test(
			lower
		) &&
		!/\b(?:booking|reservation)\s+(?:number|reference|id|status|confirmation|details)\b/i.test(
			lower
		) &&
		!/\b(?:confirmation|cancel|cancellation|refund|update|change|modify|amend)\b/i.test(
			lower
		);
	const reservationHelp = wantsReservationHelp(normalized) && !brandBookingOnly;
	const newReservationIntent =
		wantsNewReservationIntent(normalized, lu) && !broadServiceSignal;
	if (
		newReservationIntent ||
		wantsPriceButMissingDates(normalized, st) ||
		wantsPaymentHelp(normalized) ||
		reservationHelp ||
		wantsDiscountQuestion(normalized) ||
		humanHandoffReason(normalized) ||
		selectedHotelFactQuestionText(normalized) ||
		selectedHotelRoomQuestionText(normalized) ||
		Boolean(findAmenityMatch(normalized))
	) {
		return false;
	}
	const asksQuestion =
		/[?؟]/.test(normalized) ||
		/^(can|could|do|does|did|is|are|will|would|what|how|where|when|who|which|tell me|i want to know)\b/i.test(
			lower
		) ||
		/(?:هل|ممكن|ينفع|تقدر|اقدر|عندكم|بتوفروا|توفروا|فيه|هل\s+يوجد)/.test(
			arabic
		);
	if (!asksQuestion) return false;
	return (
		broadServiceSignal ||
		/\b(?:jannat\s*booking|jannat|platform|company|agency|program|programs|package|packages|visa|insurance|medical|flight|flights|ticket|tickets|airport|transport|transfer|shuttle|tour|permit|hajj|haj|umrah|organize|organisation|organization|arrange)\b/i.test(
			lower
		) ||
		/(?:تأمين|تامين|فيزا|تأشيرة|تاشيرة|طيران|تذاكر|مطار|نقل|مواصلات|باص|جولة|برنامج|برامج|باقة|باقات|تصريح|الحج|حج|العمرة|عمرة|تنظيم|ترتيب)/.test(
			arabic
		) ||
		/(?:jannatbooking|visapackage|medicalinsurance|travelinsurance|airporttransfer|hajjpackage|umrahpackage)/i.test(
			latinCompact
		)
	);
}

function genericOpenAiQuestionText(text = "", st = {}, lu = {}) {
	const normalized = String(text || "").trim();
	if (!normalized) return false;
	if (liveCurrentGeneralQuestionText(normalized)) return true;
	if (looksLikeGreetingOnly(normalized) || lu?.intent === "smalltalk") return false;
	const { lower, arabic, latinCompact } = normalizeControlText(normalized);
	if (
		wantsNewReservationIntent(normalized, lu) ||
		wantsPriceButMissingDates(normalized, st) ||
		wantsPaymentHelp(normalized) ||
		wantsReservationHelp(normalized) ||
		wantsDiscountQuestion(normalized) ||
		humanHandoffReason(normalized) ||
		confidentialCompanyDocumentQuestionText(normalized) ||
		cancellationRefundPolicyQuestionText(normalized) ||
		cancellationActionRequestText(normalized) ||
		hotelContactDetailsQuestionText(normalized) ||
		hotelContactFollowupQuestionText({}, normalized) ||
		selectedHotelFactQuestionText(normalized) ||
		selectedHotelRoomQuestionText(normalized) ||
		Boolean(findAmenityMatch(normalized)) ||
		looksLikeStayDateCandidate(normalized) ||
		currentReservationMemoryRequestText(normalized)
	) {
		return false;
	}
	if (st.hotel && (directHotelRelationshipQuestionText(normalized) || crossHotelRequestText(normalized))) {
		return false;
	}
	const asksQuestion =
		/[?\u061f]/.test(normalized) ||
		/^(can|could|do|does|did|is|are|am|was|were|will|would|should|what|how|where|when|who|whom|whose|which|why|tell me|i want to know|do you know|can you tell)\b/i.test(
			lower
		) ||
		/(?:^|\s)(?:\u0647\u0644|\u0645\u062a\u0649|\u0627\u0645\u062a\u0649|\u0625\u0645\u062a\u0649|\u0645\u0627|\u0645\u0627\u0630\u0627|\u0627\u064a\u0646|\u0648\u064a\u0646|\u0641\u064a\u0646|\u0643\u064a\u0641|\u0643\u0645|\u0645\u0646|\u0645\u064a\u0646|\u0627\u064a|\u0627\u064a\u0647|\u0625\u064a\u0647|\u0644\u064a\u0647|\u0644\u0645\u0627\u0630\u0627)\b/.test(
			arabic
		) ||
		/(?:whenis|whatis|whereis|whois|howmany|howmuch|whichis|doyouknow|canyoutell|emta|imta)/i.test(
			latinCompact
		);
	if (!asksQuestion) return false;
	return true;
}

function shouldUseDynamicUnplannedFallback(
	text = "",
	st = {},
	lu = {},
	supportDecision = {}
) {
	const normalized = String(text || "").trim();
	if (!normalized) return false;
	if (supportDecision?.action && supportDecision.action !== "other") return false;
	if (looksLikeGreetingOnly(normalized) || lu?.intent === "smalltalk") return false;
	if (severeAbusiveGuestText(normalized) || abusiveGuestText(normalized)) return false;
	if (
		wantsNewReservationIntent(normalized, lu) ||
		wantsPriceButMissingDates(normalized, st) ||
		wantsPaymentHelp(normalized) ||
		wantsReservationHelp(normalized) ||
		wantsHotelRecommendation(normalized) ||
		wantsDiscountQuestion(normalized) ||
		humanHandoffReason(normalized) ||
		confidentialCompanyDocumentQuestionText(normalized) ||
		cancellationRefundPolicyQuestionText(normalized) ||
		cancellationActionRequestText(normalized) ||
		hotelContactDetailsQuestionText(normalized) ||
		hotelContactFollowupQuestionText({}, normalized) ||
		selectedHotelFactQuestionText(normalized) ||
		selectedHotelRoomQuestionText(normalized) ||
		Boolean(findAmenityMatch(normalized)) ||
		looksLikeStayDateCandidate(normalized) ||
		reservationDetailFieldPayloadText(normalized) ||
		currentReservationMemoryRequestText(normalized) ||
		quickDateRange(normalized)?.checkinISO ||
		mapRoomToKey(normalized)
	) {
		return false;
	}
	if (
		(st.waitFor === "proceed" || st.waitFor === "room_alternative_confirm") &&
		(confirmsText(normalized) || declinesText(normalized))
	) {
		return false;
	}
	if (reservationDetailWaitState(st.waitFor)) return false;
	return true;
}

function stripGeneralBookingPivot(text = "", fallback = "") {
	const cleaned = String(text || "")
		.replace(
			/\s*(?:what|which|could|can|please|kindly|send|share|provide|tell)\b[^.!?؟\n]*(?:check[\s-]*in|check[\s-]*out|dates?|room\s+type|phone|email\s+address|your\s+email|confirmation\s+number|booking\s+details)[^.!?؟\n]*[.!?؟]?/gi,
			""
		)
		.replace(
			/\s*(?:ما|متى|هل|ممكن|من فضلك|ارسل|أرسل|ابعث|اكتب)[^.!?؟\n]*(?:الوصول|المغادرة|التواريخ|نوع الغرفة|رقم الهاتف|البريد|رقم التأكيد|بيانات الحجز)[^.!?؟\n]*[.!?؟]?/g,
			""
		)
		.replace(/\s{2,}/g, " ")
		.trim();
	return cleaned || String(fallback || "").trim();
}

function liveCurrentGeneralQuestionText(text = "") {
	const raw = String(text || "").trim();
	if (!raw) return false;
	const { lower, arabic, latinCompact } = normalizeControlText(raw);
	const asksQuestion =
		/[?\u061f]/.test(raw) ||
		/^(?:when|what|where|who|which|how|do\s+you\s+know|can\s+you\s+tell|tell\s+me)\b/i.test(
			lower
		) ||
		/(?:^|\s)(?:\u0645\u062a\u0649|\u0627\u0645\u062a\u0649|\u0625\u0645\u062a\u0649|\u0627\u064a\u0647|\u0625\u064a\u0647|\u0641\u064a\u0646|\u0645\u064a\u0646|\u0645\u0646|\u0643\u064a\u0641|\u0639\u0627\u0631\u0641|\u062a\u0639\u0631\u0641)\b/.test(
			arabic
		) ||
		/(?:whenis|whatis|whereis|whois|doyouknow|canyoutell|emta|imta|eih|ayh)/i.test(
			latinCompact
		);
	if (!asksQuestion) return false;
	const liveOrCurrentSignal =
		/\b(?:today|tomorrow|tonight|now|current|latest|next|schedule|fixture|game|match|kickoff|kick-off|score|sports?|football|soccer|news|weather|exchange\s*rate|currency\s*rate|stock|price\s+today|egypt\s+(?:game|match)|world\s*cup|afcon)\b/i.test(
			lower
		) ||
		/(?:\u0627\u0644\u0646\u0647\u0627\u0631\u062f\u0647|\u0627\u0644\u064a\u0648\u0645|\u0628\u0643\u0631\u0647|\u0628\u0643\u0631\u0629|\u062f\u0644\u0648\u0642\u062a\u064a|\u062d\u0627\u0644\u064a|\u0627\u0644\u062d\u0627\u0644\u064a|\u0627\u0644\u062c\u0627\u064a|\u0627\u0644\u062c\u0627\u0649|\u0627\u0644\u0642\u0627\u062f\u0645|\u0645\u0627\u062a\u0634|\u0645\u0628\u0627\u0631\u0627\u0629|\u0645\u0628\u0627\u0631\u0627\u0647|\u0643\u0648\u0631\u0629|\u0643\u0631\u0629|\u0645\u0646\u062a\u062e\u0628|\u0627\u0644\u062f\u0648\u0631\u064a|\u0643\u0627\u0633|\u0643\u0623\u0633|\u0627\u0644\u0637\u0642\u0633|\u0627\u0644\u062c\u0648|\u0627\u062e\u0628\u0627\u0631|\u0623\u062e\u0628\u0627\u0631|\u0633\u0639\u0631\s+\u0627\u0644\u0635\u0631\u0641|\u0627\u0644\u0639\u0645\u0644\u0629)/i.test(
			arabic
		) ||
		/(?:today|tomorrow|tonight|now|current|latest|next|schedule|fixture|game|match|kickoff|score|sport|football|soccer|news|weather|exchangerate|currencyrate|egyptmatch|egyptgame|matchegypt|matsh|matshegypt|mokabla|mobarah|kora|korah|montakhab)/i.test(
			latinCompact
		);
	if (!liveOrCurrentSignal) return false;
	if (
		wantsNewReservationIntent(raw, {}) ||
		wantsPaymentHelp(raw) ||
		wantsReservationHelp(raw) ||
		selectedHotelRoomQuestionText(raw) ||
		hotelContactDetailsQuestionText(raw) ||
		hotelContactFollowupQuestionText({}, raw)
	) {
		return false;
	}
	return true;
}

async function answerGeneralContextQuestion(io, sc, st, userText = "", reason = "") {
	const previousWaitFor = st.waitFor || "";
	const fallback = supportEmailFallbackText(sc, st);
	const liveCurrent = liveCurrentGeneralQuestionText(userText);
	const sent = await sendDynamicWrittenReply(
		io,
		sc,
		st,
		userText,
		`The guest asked a general, off-topic, unclear, or unplanned question. Study the full conversation transcript and answer the latest guest point directly in one or two polished professional sentences in the guest's active language. Preserve the current reservation flow without asking for details already supplied; do not use a canned/generic template, do not list a form, and do not add an unrelated booking prompt unless the latest message asks to reserve. If the question is about the selected hotel or Jannat Booking, use verified context first and do not invent missing facts. If it is stable general knowledge, answer directly in a helpful CSR voice. If it needs live/current information such as sports fixtures, game times, news, weather, prices, exchange rates, schedules, official travel rules, or today's availability outside this system, do not guess or claim live lookup; say you do not have live/current data in this chat, recommend checking the official/latest source, then gently return to hotel/reservation help only if natural. ${
			liveCurrent
				? "The latest message appears to need live/current data, so do not answer it with hotel address, distance, map, room, policy, or other hotel facts unless the guest explicitly asked for those facts."
				: ""
		} Do not direct the guest to email or escalation. Do not ask for phone, email, confirmation number, dates, or booking details unless the guest explicitly asks to reserve in the latest message.`,
		{
			hotelName: localizedHotelName(sc, st),
			reason,
			liveCurrentQuestion: liveCurrent,
			unknownAnswerDraft: fallback,
			unknownAnswerNextStep: unsupportedAnswerNextStepText(sc, st),
		},
		{
			fallbackText: fallback,
			targetReplyMs: AI_BOOKING_PROMPT_TARGET_MS,
			scheduleIdle: false,
		}
	);
	if (!sent) return false;
	if (sc.aiReservation?.status === "created" || sc.aiReservation?.confirmationNumber) {
		st.waitFor = "post_booking_followup";
	} else {
		preserveBookingWaitStateForCase(sc, st, previousWaitFor);
		if (!st.waitFor) st.waitFor = previousWaitFor || "clarify";
	}
	logStep(String(sc._id), "general_answer.reply", {
		reason,
		latestUserMessage: String(userText || "").slice(0, 160),
	});
	return true;
}

async function answerHotelContactDetailsInquiry(io, sc, st, userText = "") {
	const previousWaitFor = st.waitFor || "";
	const requestCount = hotelContactRequestCount(sc, userText);
	const phoneToShare = "";
	let reply = hotelContactReplyText(sc, st, {
		publicPhone: phoneToShare,
		requestCount,
		userText,
	});
	const continuation = activeBookingContinuationText(sc, st, {
		contactBoundary: false,
		omitName: true,
	});
	if (continuation && !reply.includes(continuation)) {
		reply = `${reply} ${continuation}`;
	}
	await humanSend(io, sc, st, reply, { scheduleIdle: false });
	st.waitFor =
		sc.aiReservation?.status === "created" || sc.aiReservation?.confirmationNumber
			? "post_booking_followup"
			: "clarify";
	preserveBookingWaitStateForCase(sc, st, previousWaitFor);
	logStep(String(sc._id), "hotel_contact.reply", {
		sharedPhone: Boolean(phoneToShare),
		sharedPublicPhone: Boolean(phoneToShare),
		requestCount,
		latestUserMessage: String(userText || "").slice(0, 160),
	});
	return true;
}

async function answerDirectHotelRelationshipInquiry(io, sc, st, userText = "") {
	const previousWaitFor = st.waitFor || "";
	await humanSend(io, sc, st, directHotelRelationshipReplyText(sc, st), {
		scheduleIdle: false,
	});
	st.waitFor =
		sc.aiReservation?.status === "created" || sc.aiReservation?.confirmationNumber
			? "post_booking_followup"
			: "clarify";
	preserveBookingWaitStateForCase(sc, st, previousWaitFor);
	logStep(String(sc._id), "hotel_direct_relationship.reply", {
		latestUserMessage: String(userText || "").slice(0, 160),
		hotelName: localizedHotelName(sc, st),
	});
	return true;
}

async function answerConfidentialCompanyDocumentInquiry(io, sc, st, userText = "") {
	const previousWaitFor = st.waitFor || "";
	await humanSend(io, sc, st, confidentialCompanyDocumentReplyText(sc, st), {
		scheduleIdle: false,
	});
	st.waitFor =
		sc.aiReservation?.status === "created" || sc.aiReservation?.confirmationNumber
			? "post_booking_followup"
			: "clarify";
	preserveBookingWaitStateForCase(sc, st, previousWaitFor);
	logStep(String(sc._id), "confidential_company_document.reply", {
		latestUserMessage: String(userText || "").slice(0, 160),
		hotelName: localizedHotelName(sc, st),
	});
	return true;
}

function directGuestRequestKind(sc = {}, st = {}, userText = "", lu = {}) {
	const text = String(userText || "").trim();
	if (!text) return "";
	if (confidentialCompanyDocumentQuestionText(text)) {
		return "confidential_company_document";
	}
	if (quoteConfirmationText(text, st)) return "";
	if (liveCurrentGeneralQuestionText(text)) return "general_support";
	if (st.hotel && selectedHotelPolicyQuestionText(text)) {
		return "selected_hotel_fact";
	}
	if (cancellationRefundPolicyQuestionText(text)) {
		return "selected_hotel_fact";
	}
	if (wantsPaymentHelp(text)) return "payment_help";
	if (wantsDiscountQuestion(text)) return "discount_question";
	if (st.hotel && directHotelRelationshipQuestionText(text)) {
		return "direct_hotel_relationship";
	}
	if (
		hotelContactDetailsQuestionText(text) ||
		hotelContactFollowupQuestionText(sc, text)
	) {
		return "hotel_contact";
	}
	if (st.hotel && crossHotelRequestText(text)) return "hotel_scope_boundary";
	if (
		st.hotel &&
		selectedHotelFactQuestionText(text) &&
		!humanHandoffReason(text) &&
		!explicitlyExistingReservationIntent(text)
	) {
		return "selected_hotel_fact";
	}
	if (
		st.hotel &&
		selectedHotelRoomQuestionText(text) &&
		!humanHandoffReason(text) &&
		!explicitlyExistingReservationIntent(text)
	) {
		return "selected_hotel_room";
	}
	if (vagueHajjInquiryText(text)) return "hajj_inquiry";
	if (st.hotel && (lu?.amenity || findAmenityMatch(text))) return "amenity_question";
	if (broadGeneralSupportQuestionText(text, st, lu)) return "general_support";
	if (genericOpenAiQuestionText(text, st, lu)) return "general_support";
	return "";
}

async function answerAmenityInquiry(io, sc, st, userText = "", lu = {}) {
	const amenityKey = lu?.amenity || findAmenityMatch(userText);
	if (!amenityKey) return false;
	const chosenRoom = (st.hotel?.roomCountDetails || []).find(
		(room) => room.roomType === st.slots.roomTypeKey
	);
	const hasOnRoom = chosenRoom ? roomHasAmenity(chosenRoom, amenityKey) : false;
	const hasOnHotel = !hasOnRoom && hotelHasAmenity(st.hotel, amenityKey);
	const amenityLabel =
		amenityKey === "wifi"
			? "Wi-Fi"
			: amenityKey === "ac"
			? "air conditioning"
			: amenityKey;
	let answerDraft = "";
	if (chosenRoom) {
		const label = chosenRoom.displayName || chosenRoom.roomType || "this room";
		answerDraft = hasOnRoom
			? `Yes, the ${label} includes ${amenityLabel}.`
			: hasOnHotel
			? `The ${label} does not list ${amenityLabel}, but it is available at the hotel.`
			: `I do not see ${amenityLabel} listed for the ${label}. If it is essential, I can double-check with the hotel team.`;
	} else {
		answerDraft = hasOnHotel
			? `Yes, ${amenityLabel} is available at the hotel.`
			: `I do not see ${amenityLabel} listed. If it is essential, I can double-check with the hotel team.`;
	}
	const reply = await write(
		io,
		sc,
		st,
		"Answer the guest's amenity question first using the provided amenity result. Do not ask for check-in/check-out dates in this reply unless the guest also explicitly asked for price or availability. Do not invent amenities.",
		{
			latestUserMessage: userText,
			amenityLabel,
			amenityAvailableOnRoom: hasOnRoom,
			amenityAvailableOnHotel: hasOnHotel,
			roomLabel: chosenRoom?.displayName || chosenRoom?.roomType || "",
			answerDraft,
		}
	);
	await humanSend(io, sc, st, reply || answerDraft);
	st.waitFor =
		sc.aiReservation?.status === "created" || sc.aiReservation?.confirmationNumber
			? "post_booking_followup"
			: st.waitFor || "clarify";
	logStep(String(sc._id), "amenity.direct_reply", {
		amenityKey,
		waitFor: st.waitFor,
	});
	return true;
}

async function tryAnswerDirectGuestRequest(io, sc, st, userText = "", lu = {}) {
	const kind = directGuestRequestKind(sc, st, userText, lu);
	if (!kind) return false;
	logStep(String(sc._id), "direct_request.guard", {
		kind,
		waitFor: st.waitFor,
		latestUserMessage: String(userText || "").slice(0, 160),
	});
	if (kind === "confidential_company_document") {
		return answerConfidentialCompanyDocumentInquiry(io, sc, st, userText);
	}
	if (kind === "payment_help") {
		if (!st.hotel) {
			await redirectJannatReservationToHotelSupport(io, sc, st, userText, lu);
			return true;
		}
		const knownConfirmation = latestKnownConfirmation(sc, lu);
		const reply = await write(
			io,
			sc,
			st,
			"The guest has a payment issue or payment-link question. Answer the latest request directly first. Ask for exactly one useful reference only if it is not already in the conversation. Never ask for check-in/check-out dates here. Never ask for card details.",
			{ latestUserMessage: userText, knownConfirmation }
		);
		await humanSend(io, sc, st, reply);
		st.waitFor = "payment_reference";
		return true;
	}
	if (kind === "discount_question") {
		await answerDiscountQuestion(io, sc, st, userText);
		return true;
	}
	if (kind === "direct_hotel_relationship") {
		return answerDirectHotelRelationshipInquiry(io, sc, st, userText);
	}
	if (kind === "hotel_contact") {
		return answerHotelContactDetailsInquiry(io, sc, st, userText);
	}
	if (kind === "hajj_inquiry") {
		return answerVagueHajjInquiry(io, sc, st, userText);
	}
	if (kind === "hotel_scope_boundary") {
		const previousWaitFor = st.waitFor || "";
		await humanSend(io, sc, st, selectedHotelSupportBoundaryReply(sc, st), {
			scheduleIdle: false,
		});
		st.waitFor = "clarify";
		preserveBookingWaitStateForCase(sc, st, previousWaitFor);
		return true;
	}
	if (kind === "selected_hotel_fact") {
		return answerSelectedHotelFactQuestion(io, sc, st, userText);
	}
	if (kind === "selected_hotel_room") {
		const requestedRoomTypeKey =
			lu?.roomTypeKey || mapRoomToKey(userText) || st.slots.roomTypeKey || null;
		return answerSelectedHotelRoomQuestion(
			io,
			sc,
			st,
			userText,
			requestedRoomTypeKey
		);
	}
	if (kind === "amenity_question") {
		return answerAmenityInquiry(io, sc, st, userText, lu);
	}
	if (kind === "general_support") {
		return answerGeneralContextQuestion(
			io,
			sc,
			st,
			userText,
			"direct_general_question"
		);
	}
	return false;
}

async function askExplicitPastDateClarification(io, sc, st, userText = "", dates = {}) {
	const suggestedDates = futureSameMonthDayRange(dates);
	const reply = await write(
		io,
		sc,
		st,
		"The guest provided an explicit Gregorian date range that is before today. Do not change the year silently and do not quote availability yet. Answer naturally that the typed dates appear to be in the past, then ask one short clarification whether they meant the same day/month in the next future year. Keep it warm and direct.",
		{
			latestUserMessage: userText,
			todayISO: todayISODate(),
			providedDates: {
				checkinISO: dates?.checkinISO || null,
				checkoutISO: dates?.checkoutISO || null,
				raw: dates?.raw || null,
			},
			suggestedDates,
		}
	);
	await humanSend(io, sc, st, reply);
	st.waitFor = "dates";
	stampAsk(st, "dates");
	logStep(String(sc._id), "dates.past_explicit_clarify", {
		checkinISO: dates?.checkinISO || null,
		checkoutISO: dates?.checkoutISO || null,
		suggestedDates,
	});
	return true;
}

async function askPendingDateChangeConfirmation(
	io,
	sc,
	st,
	dates = {},
	{ source = "", userText = "" } = {}
) {
	const pending = rememberPendingDateChange(st, dates, { source, userText });
	if (!pending) return false;
	st.waitFor = "date_change_confirm";
	stampAsk(st, "date_change_confirm");
	pending.askedAt = now();
	const sent = await humanSend(
		io,
		sc,
		st,
		pendingDateChangePromptText(sc, st, pending),
		{ quickReplies: pendingDateChangeQuickReplies(sc, st) }
	);
	logStep(String(sc._id), "dates.change_confirmation_requested", {
		source,
		current: pending.previous,
		proposed: {
			checkinISO: dates.checkinISO,
			checkoutISO: dates.checkoutISO,
		},
		sent,
	});
	return true;
}

async function mergeDateRangeWithChangeGuard(
	io,
	sc,
	st,
	dates = {},
	{ source = "", userText = "", force = false, resetQuote = true } = {}
) {
	if (!dates?.checkinISO || !dates?.checkoutISO) {
		return { applied: false, prompted: false, changed: false };
	}
	if (!force && shouldConfirmDateRangeChange(st, dates)) {
		await askPendingDateChangeConfirmation(io, sc, st, dates, {
			source,
			userText,
		});
		return { applied: false, prompted: true, changed: true };
	}
	const changed = dateRangeConflictsWithState(st, dates);
	const applied = applyDateRangeToState(st, dates, { resetQuote });
	if (applied && changed) {
		logStep(String(sc._id), "dates.changed", {
			source,
			checkinISO: dates.checkinISO,
			checkoutISO: dates.checkoutISO,
			waitFor: st.waitFor || "",
			roomTypeKey: st.slots?.roomTypeKey || null,
		});
	}
	return { applied, prompted: false, changed };
}

async function mergePartialDateRangeWithChangeGuard(
	io,
	sc,
	st,
	partial = {},
	{ source = "", userText = "", force = false, resetQuote = true } = {}
) {
	const before = currentDateRange(st);
	const proposed = combinedDateRangeFromPartial(st, partial);
	const wouldChangeCompleteRange = Boolean(
		before &&
			((partial?.checkinISO && partial.checkinISO !== before.checkinISO) ||
				(partial?.checkoutISO && partial.checkoutISO !== before.checkoutISO))
	);
	if (!proposed && wouldChangeCompleteRange) {
		logStep(String(sc._id), "dates.partial_invalid_ignored", {
			source,
			current: before,
			partial: {
				checkinISO: partial?.checkinISO || null,
				checkoutISO: partial?.checkoutISO || null,
			},
			waitFor: st.waitFor || "",
		});
		return { applied: false, prompted: false, changed: false, invalid: true };
	}
	if (!force && proposed && shouldConfirmDateRangeChange(st, proposed)) {
		await askPendingDateChangeConfirmation(io, sc, st, proposed, {
			source,
			userText,
		});
		return { applied: false, prompted: true, changed: true };
	}
	const applied = applyPartialDateToState(st, partial);
	const after = currentDateRange(st);
	const changed = Boolean(
		applied &&
			before &&
			after &&
			dateRangeKey(before) !== dateRangeKey(after)
	);
	if (applied && changed && resetQuote && activeDateSensitiveBookingState(st)) {
		resetBookingAfterDateRangeChange(st);
	}
	if (applied && changed) {
		logStep(String(sc._id), "dates.partial_changed", {
			source,
			current: after,
			waitFor: st.waitFor || "",
			roomTypeKey: st.slots?.roomTypeKey || null,
		});
	}
	return { applied, prompted: false, changed };
}

async function continueAfterConfirmedDateChange(io, sc, st, userText = "") {
	if (st.hotel && st.pendingRoomCombination) {
		await answerLargeGroupRoomRecommendation(
			io,
			sc,
			st,
			userText,
			st.pendingRoomCombination.guestCount
		);
		return true;
	}
	if (st.hotel && st.slots?.roomTypeKey && st.slots?.checkinISO && st.slots?.checkoutISO) {
		await shareKnownStayQuote(io, sc, st);
		return true;
	}
	if (!st.slots?.roomTypeKey) {
		await askRoomPreferenceForReservation(io, sc, st);
		return true;
	}
	if (!st.hotel && st.slots?.roomTypeKey && st.slots?.checkinISO && st.slots?.checkoutISO) {
		await answerJannatBookingHotelOptions(io, sc, st, userText, st.slots.roomTypeKey);
		return true;
	}
	await askForMissingStayDates(io, sc, st);
	return true;
}

async function handlePendingDateChangeChoice(io, sc, st, userText = "") {
	const pending = st.pendingDateChange || null;
	if (!pending) return false;
	if (!String(userText || "").trim()) return false;
	const choice = pendingDateChoiceFromGuest(sc, userText);
	const newDates = extractDateRange(userText);
	if (choice === "confirm") {
		const proposed =
			pending.proposed?.checkinISO && pending.proposed?.checkoutISO
				? pending.proposed
				: newDates;
		if (!proposed?.checkinISO || !proposed?.checkoutISO) {
			clearPendingDateChange(st);
			return false;
		}
		applyDateRangeToState(st, proposed);
		logStep(String(sc._id), "dates.change_confirmed", {
			checkinISO: proposed.checkinISO,
			checkoutISO: proposed.checkoutISO,
			waitFor: st.waitFor || "",
		});
		return continueAfterConfirmedDateChange(io, sc, st, userText);
	}
	if (choice === "keep") {
		const previousWaitFor = pending.previousWaitFor || "";
		const previousReviewSent = Boolean(pending.previousReviewSent);
		clearPendingDateChange(st);
		st.reviewSent = previousReviewSent;
		st.waitFor =
			previousWaitFor && previousWaitFor !== "date_change_confirm"
				? previousWaitFor
				: nextPivot(st);
		const quickReplies =
			st.waitFor === "proceed" && activeQuoteMatchesSlots(st)
				? proceedQuickReplies(sc, st)
				: st.waitFor === "reviewConfirm"
				? confirmationQuickReplies(sc, st)
				: [];
		await humanSend(io, sc, st, pendingDateKeptText(sc, st, pending), {
			quickReplies,
		});
		logStep(String(sc._id), "dates.change_kept_current", {
			waitFor: st.waitFor || "",
			current: currentDateRange(st),
		});
		return true;
	}
	if (
		newDates?.checkinISO &&
		newDates?.checkoutISO &&
		shouldConfirmDateRangeChange(st, newDates)
	) {
		await askPendingDateChangeConfirmation(io, sc, st, newDates, {
			source: "pending_followup",
			userText,
		});
		return true;
	}
	if (directGuestRequestKind(sc, st, userText, {})) return false;
	await humanSend(
		io,
		sc,
		st,
		pendingDateChangePromptText(sc, st, pending),
		{ quickReplies: pendingDateChangeQuickReplies(sc, st) }
	);
	st.waitFor = "date_change_confirm";
	stampAsk(st, "date_change_confirm");
	return true;
}

async function answerSupportEmailInquiry(io, sc, st, userText = "", reason = "") {
	return answerGeneralContextQuestion(
		io,
		sc,
		st,
		userText,
		reason || "support_email_dynamic_fallback"
	);
}

async function handlePostBookingFollowup(io, sc, st, userText) {
	if (st.waitFor !== "post_booking_followup") return false;
	if (confirmationNumberQuestionText(userText)) {
		const handledConfirmationNumber = await answerPostBookingStateQuestion(
			io,
			sc,
			st,
			userText
		);
		if (handledConfirmationNumber) return true;
	}
	const deliveryRequest = confirmationRequestSignals(userText);
	const asksDelivery =
		deliveryRequest.email || deliveryRequest.whatsapp || deliveryRequest.link;
	const handledStateQuestion = !asksDelivery
		? await answerPostBookingStateQuestion(io, sc, st, userText)
		: false;
	if (handledStateQuestion) return true;
	if (asksDelivery) {
		const handledDeliveryRequest = await handlePostBookingDeliveryRequest(
			io,
			sc,
			st,
			userText
		);
		if (handledDeliveryRequest) return true;
	}
	if (isPostBookingClosure(userText)) {
		const closeReply = await postBookingCloseReply(io, sc, st, userText);
		const sent = await humanSend(io, sc, st, closeReply, { scheduleIdle: false });
		if (sent) schedulePostBookingAutoClose(io, sc, st);
		st.waitFor = null;
		return true;
	}
	const fastSmalltalk = fastEnglishSmalltalkText(sc, st, userText);
	if (fastSmalltalk) {
		await sendDynamicCasualReply(
			io,
			sc,
			st,
			userText,
			"The guest made a casual or social comment after completing a booking. Reply warmly in a professional reception voice, answer the social line naturally, and add one soft line that you remain available for any reservation, hotel, maps, Nusuk, or payment follow-up. Do not restart the booking flow."
		);
		st.waitFor = "post_booking_followup";
		return true;
	}
	if (
		cancellationRefundPolicyQuestionText(userText) ||
		cancellationActionRequestText(userText)
	) {
		return answerCancellationRefundPolicyInquiry(io, sc, st, userText, {}, {
			forceCancellation: cancellationActionRequestText(userText),
		});
	}
	if (wantsPaymentHelp(userText)) {
		await humanSend(io, sc, st, postBookingPaymentHelpText(sc, st), {
			fast: true,
			scheduleIdle: false,
		});
		st.waitFor = "post_booking_followup";
		return true;
	}
	if (postBookingHaramTimingQuestionText(userText)) {
		await humanSend(io, sc, st, postBookingHaramTimingText(sc, st), {
			fast: true,
			scheduleIdle: false,
		});
		st.waitFor = "post_booking_followup";
		return true;
	}
	if (postBookingLocalRecommendationQuestionText(userText)) {
		await humanSend(io, sc, st, postBookingLocalRecommendationText(sc, st), {
			fast: true,
			scheduleIdle: false,
		});
		st.waitFor = "post_booking_followup";
		return true;
	}
	if (postBookingNusukAppointmentQuestionText(userText)) {
		await humanSend(io, sc, st, postBookingNusukAppointmentText(sc, st), {
			fast: true,
			scheduleIdle: false,
		});
		st.waitFor = "post_booking_followup";
		return true;
	}
	if (st.hotel && selectedHotelRoomQuestionText(userText)) {
		const handled = await answerSelectedHotelRoomQuestion(
			io,
			sc,
			st,
			userText,
			mapRoomToKey(userText) || null
		);
		if (handled) st.waitFor = "post_booking_followup";
		return handled;
	}
	if (st.hotel && selectedHotelFactQuestionText(userText)) {
		const handled = await answerSelectedHotelFactQuestion(io, sc, st, userText);
		if (handled) st.waitFor = "post_booking_followup";
		return handled;
	}
	if (st.hotel && directHotelRelationshipQuestionText(userText)) {
		const handled = await answerDirectHotelRelationshipInquiry(io, sc, st, userText);
		if (handled) st.waitFor = "post_booking_followup";
		return handled;
	}
	if (
		hotelContactDetailsQuestionText(userText) ||
		hotelContactFollowupQuestionText(sc, userText)
	) {
		const handled = await answerHotelContactDetailsInquiry(io, sc, st, userText);
		if (handled) st.waitFor = "post_booking_followup";
		return handled;
	}
	if (vagueHajjInquiryText(userText)) {
		const handled = await answerVagueHajjInquiry(io, sc, st, userText);
		if (handled) st.waitFor = "post_booking_followup";
		return handled;
	}
	if (botExperienceComplaintText(userText) && !isPostBookingConcreteRequest(userText)) {
		await humanSend(io, sc, st, await postBookingCloseReply(io, sc, st, userText));
		st.waitFor = null;
		return true;
	}
	if (isVaguePositive(userText)) {
		await humanSend(io, sc, st, postBookingClarifyText(sc, st));
		st.waitFor = "post_booking_followup";
		return true;
	}
	if (genericOpenAiQuestionText(userText, st, {})) {
		const handled = await answerGeneralContextQuestion(
			io,
			sc,
			st,
			userText,
			"post_booking_generic_question"
		);
		if (handled) {
			st.waitFor = "post_booking_followup";
			return true;
		}
	}
	if (!isPostBookingConcreteRequest(userText)) {
		await humanSend(io, sc, st, postBookingClarifyText(sc, st));
		st.waitFor = "post_booking_followup";
		return true;
	}
	const handledGeneric = await answerGeneralContextQuestion(
		io,
		sc,
		st,
		userText,
		"post_booking_unhandled_request"
	);
	st.waitFor = "post_booking_followup";
	return handledGeneric || true;
}

function nextReservationDetailStep(st = {}) {
	if (!hasMandatoryReservationDetails(st)) return "reservation_details";
	ensureDefaultChildren(st);
	if (!st.slots?.email && !st.slots?.emailSkipped) return "email_or_skip";
	return "finalize";
}

async function askForReservationDetail(
	io,
	sc,
	st,
	step,
	{ fast = false, targetReplyMs = AI_BOOKING_PROMPT_TARGET_MS } = {}
) {
	let prompt = "";
	let quickReplies = [];
	if (step === "reservation_details" || step === "fullname" || step === "nationality" || step === "phone") {
		prompt = mandatoryDetailsPrompt(sc, st, {
			retry: step !== "reservation_details",
		});
	} else if (step === "email_or_skip") {
		prompt = optionalEmailPrompt(sc, st);
		quickReplies = emailQuickReplies(sc, st);
	}
	if (!prompt) return;
	const sent = await humanSend(io, sc, st, prompt, {
		quickReplies,
		fast,
		targetReplyMs,
	});
	if (!sent) return;
	stampAsk(st, step);
}

async function handleReservationDetailPayloadFallback(io, sc, st, userText, caseId) {
	if (!reservationDetailContextReady(st)) return false;
	if (
		!reservationDetailFieldPayloadText(userText) ||
		humanHandoffReason(userText) ||
		wantsPaymentHelp(userText)
	) {
		return false;
	}
	const before = JSON.stringify(st.slots || {});
	await captureReservationDetailsFromText(sc, st, userText, caseId);
	const changed = before !== JSON.stringify(st.slots || {});
	if (!changed) return false;
	if (!hasMandatoryReservationDetails(st)) {
		st.waitFor = "reservation_details";
		await humanSend(io, sc, st, mandatoryDetailsPrompt(sc, st, { retry: true }), {
			fast: true,
			targetReplyMs: AI_BOOKING_PROMPT_TARGET_MS,
		});
		stampAsk(st, "reservation_details");
		return true;
	}
	st.waitFor = "finalize";
	await sendReservationReview(io, sc, st, st.quote?.data, {
		fast: true,
		targetReplyMs: AI_BOOKING_PROMPT_TARGET_MS,
	});
	return true;
}

async function handleReservationDetailStep(io, sc, st, userText, caseId) {
	if (!isReservationDetailStep(st)) return false;
	const guestAction = lastGuestAction(sc);
	if (currentReservationMemoryRequestText(userText)) {
		return answerCurrentReservationMemoryQuestion(io, sc, st, userText, caseId);
	}
	if (
		st.waitFor === "finalize" &&
		st.hotel &&
		selectedHotelFactQuestionText(userText) &&
		!placeReservationActionSelected(sc, userText, st) &&
		guestAction !== "correction" &&
		!correctionText(userText) &&
		!humanHandoffReason(userText) &&
		!wantsPaymentHelp(userText)
	) {
		const handledFactQuestion = await answerSelectedHotelFactQuestion(
			io,
			sc,
			st,
			userText
		);
		if (handledFactQuestion) return true;
	}
	const chaseOnlyWithCompleteDetails =
		guestHurryOrChaseText(userText) && hasMandatoryReservationDetails(st);
	const slotsBeforeCapture = JSON.stringify(st.slots || {});
	if (!chaseOnlyWithCompleteDetails && st.waitFor !== "email_or_skip") {
		await captureReservationDetailsFromText(sc, st, userText, caseId);
	}
	const slotsChangedByLatest = slotsBeforeCapture !== JSON.stringify(st.slots || {});
	for (let guard = 0; guard < 4; guard += 1) {
		if (st.waitFor === "clarify") {
			if (slotsChangedByLatest && hasMandatoryReservationDetails(st)) {
				st.waitFor = "finalize";
				st.reviewSent = false;
				await sendReservationReview(io, sc, st, st.quote?.data, {
					fast: true,
					targetReplyMs: AI_BOOKING_PROMPT_TARGET_MS,
				});
				return true;
			}
			if (!hasMandatoryReservationDetails(st)) {
				st.waitFor = "reservation_details";
				await humanSend(io, sc, st, mandatoryDetailsPrompt(sc, st, { retry: true }), {
					fast: true,
					targetReplyMs: AI_BOOKING_PROMPT_TARGET_MS,
				});
				stampAsk(st, "reservation_details");
				return true;
			}
			const ask = /arabic/i.test(languageOf(sc, st))
				? "\u0628\u0643\u0644 \u0633\u0631\u0648\u0631\u060c \u0645\u0627 \u0627\u0644\u062a\u0641\u0635\u064a\u0644 \u0627\u0644\u0630\u064a \u062a\u0631\u064a\u062f \u062a\u0639\u062f\u064a\u0644\u0647\u061f"
				: "Of course. Which detail should I correct?";
			await humanSend(io, sc, st, ask, {
				quickReplies: confirmationQuickReplies(sc, st),
				targetReplyMs: AI_BOOKING_PROMPT_TARGET_MS,
			});
			return true;
		}
		if (st.waitFor === "reviewConfirm") {
			if (guestAction === "correction" || correctionText(userText)) {
				st.waitFor = "clarify";
				st.reviewSent = false;
				const ask = /arabic/i.test(languageOf(sc, st))
					? "\u0628\u0643\u0644 \u0633\u0631\u0648\u0631\u060c \u0645\u0627 \u0627\u0644\u0634\u064a\u0621 \u0627\u0644\u0630\u064a \u062a\u0631\u064a\u062f \u062a\u0639\u062f\u064a\u0644\u0647\u061f"
					: "Of course. What would you like me to correct?";
				await humanSend(io, sc, st, ask);
				return true;
			}
			if (!confirmsText(userText)) {
				const ask = /arabic/i.test(languageOf(sc, st))
					? "\u0647\u0644 \u062a\u0624\u0643\u062f \u0627\u0644\u062a\u0641\u0627\u0635\u064a\u0644\u060c \u0623\u0645 \u0647\u0646\u0627\u0643 \u0634\u064a\u0621 \u062a\u0631\u064a\u062f \u062a\u0639\u062f\u064a\u0644\u0647\u061f"
					: "Would you like to confirm these details, or is there something you want me to change?";
				await humanSend(io, sc, st, ask, {
					quickReplies: confirmationQuickReplies(sc, st),
				});
				return true;
			}
			st.waitFor = nextReservationDetailStep(st);
			if (st.waitFor !== "finalize") {
				await askForReservationDetail(io, sc, st, st.waitFor, {
					fast: true,
					targetReplyMs: AI_BOOKING_PROMPT_TARGET_MS,
				});
				return true;
			}
		}

		if (["reservation_details", "fullname", "nationality", "phone"].includes(st.waitFor)) {
			if (hasMandatoryReservationDetails(st)) {
				st.waitFor = nextReservationDetailStep(st);
				if (st.waitFor !== "finalize") {
					await askForReservationDetail(io, sc, st, st.waitFor, {
						fast: true,
						targetReplyMs: AI_BOOKING_PROMPT_TARGET_MS,
					});
					return true;
				}
				await sendReservationReview(io, sc, st, st.quote?.data, {
					fast: true,
					targetReplyMs: AI_BOOKING_PROMPT_TARGET_MS,
				});
				return true;
			}
			await humanSend(io, sc, st, mandatoryDetailsPrompt(sc, st, { retry: true }), {
				fast: true,
				targetReplyMs: AI_BOOKING_PROMPT_TARGET_MS,
			});
			stampAsk(st, "reservation_details");
			return true;
		}

		if (st.waitFor === "email_or_skip") {
			if (st.slots.email || st.slots.emailSkipped) {
				st.waitFor = "finalize";
				continue;
			}
			const txt = String(userText).trim();
			const email = latestEmailFromText(txt);
			if (email) {
				st.slots.email = email;
				logStep(caseId, "email.captured", { email: st.slots.email });
				st.waitFor = "finalize";
				continue;
			}
			if (guestAction === "skip_email") {
				st.slots.email = "";
				st.slots.emailSkipped = true;
				logStep(caseId, "email.skipped", { source: "quick_reply" });
				st.waitFor = "finalize";
				continue;
			}
			if (emailSkipText(txt)) {
				st.slots.email = "";
				st.slots.emailSkipped = true;
				logStep(caseId, "email.skipped", { source: "typed" });
				st.waitFor = "finalize";
				continue;
			}
			await humanSend(io, sc, st, optionalEmailPrompt(sc, st), {
				quickReplies: emailQuickReplies(sc, st),
				targetReplyMs: AI_BOOKING_PROMPT_TARGET_MS,
			});
			stampAsk(st, "email_or_skip");
			return true;
		}

		if (st.waitFor === "finalize") {
			if (!placeReservationActionSelected(sc, userText, st)) {
				if (guestAction === "correction" || correctionText(userText)) {
					st.waitFor = "clarify";
					st.reviewSent = false;
					const ask = /arabic/i.test(languageOf(sc, st))
						? "\u0628\u0643\u0644 \u0633\u0631\u0648\u0631\u060c \u0645\u0627 \u0627\u0644\u062a\u0641\u0635\u064a\u0644 \u0627\u0644\u0630\u064a \u0646\u062d\u062a\u0627\u062c \u062a\u0639\u062f\u064a\u0644\u0647 \u0642\u0628\u0644 \u0625\u0646\u0634\u0627\u0621 \u0627\u0644\u062d\u062c\u0632\u061f"
						: "Of course. What should we fix before I create the reservation?";
					await humanSend(io, sc, st, ask);
					return true;
				}
				if (!st.finalReviewSentAt && st.quote?.data?.available) {
					await sendReservationReview(io, sc, st, st.quote.data, {
						targetReplyMs: AI_BOOKING_PROMPT_TARGET_MS,
					});
					return true;
				}
				await humanSend(io, sc, st, finalReservationPrompt(sc, st), {
					quickReplies: finalReservationQuickReplies(sc, st),
					targetReplyMs: AI_BOOKING_PROMPT_TARGET_MS,
				});
				stampAsk(st, "finalize");
				return true;
			}
			try {
				return await finalizeReservationForGuest(io, sc, st, caseId);
			} catch (error) {
				logStep(caseId, "reservation.create_failed", {
					message: error?.message || error,
				});
				await handoffToHuman(io, sc, st, "reservation_finalize_failed");
				return true;
			}
		}
	}
	return false;
}

async function answerDiscountQuestion(io, sc, st, userText = "") {
	const discount = discountDisplayContext(st);
	const fallbackText = discount.displayedPerNight
		? `Sir, our published prices already include a ${discount.discountPercent}% across-the-board discount and are among the best market rates. The displayed nightly rate of ${discount.displayedPerNight} ${cleanCurrency(
				discount.currency
		  )} is already after the discount; before discount it would be about ${
				discount.beforeDiscount
		  } ${cleanCurrency(discount.currency)}. There is no extra manual discount.`
		: `Sir, our published prices already include a ${discount.discountPercent}% across-the-board discount and are among the best market rates. The displayed price is already the discounted price, so there is no extra manual discount. For example, 85 SAR means it was 100 SAR before the discount.`;
	const reply = await write(
		io,
		sc,
		st,
		"The guest asked about discounts or offers. Reply professionally without escalation. Say the published/displayed prices already include a 15% across-the-board discount and are among the best market rates. Do not present a new discounted total. Do not offer an extra manual discount. If useful, explain briefly that a displayed nightly price of 85 SAR means it is already after 15% from 100 SAR. Keep the normal booking flow unchanged and answer only because the guest asked.",
		{
			latestUserMessage: userText,
			discountPolicy: discount,
			fallbackText,
		}
	);
	await humanSend(io, sc, st, reply);
}

/* ------------------- SMALLTALK ------------------- */
async function handleSmalltalk(io, sc, st, lu, userText) {
	const caseId = String(sc._id);
	const pivot = nextPivot(st);
	const subtype = lu.smalltalkType || "chitchat";
	const thread = st.smalltalkThread;
	thread.lastAt = now();
	logStep(caseId, "smalltalk.thread", {
		subtype,
		topic: thread.topic,
		waitingForGuest: thread.waitingForGuest,
	});

	if (looksLikeGuestDistressText(userText)) {
		await sendDynamicEmotionalSupportReply(io, sc, st, userText);
		thread.topic = "emotional_support";
		thread.waitingForGuest = true;
		return true;
	}

	if (looksLikeGreetingOnly(userText) && !hasOperationalBookingSignal(userText)) {
		await sendDynamicCasualReply(
			io,
			sc,
			st,
			userText,
			"Reply warmly to the guest's greeting in the active language. Use a natural short hospitality tone and ask an open 'how can I help you?' style question. Do not ask for check-in/check-out dates, room type, phone, nationality, or any booking detail in this reply.",
			{ latestUserMessage: userText, currentWaitFor: st.waitFor || "" }
		);
		thread.topic = null;
		thread.waitingForGuest = false;
		return true;
	}

	if (subtype === "how_are_you") {
		if (!thread.waitingForGuest || thread.topic !== "howru") {
			await sendDynamicCasualReply(
				io,
				sc,
				st,
				userText,
				"Say you're doing well in a natural professional CSR voice, then ask how the guest is doing. Keep it short; no booking question yet."
			);
			thread.topic = "howru";
			thread.waitingForGuest = true;
			logStep(caseId, "smalltalk.thread.update", {
				topic: thread.topic,
				waitingForGuest: thread.waitingForGuest,
			});
			return true;
		} else {
			const msg = await write(
				io,
				sc,
				st,
				"Reply that you're doing well, friendly and brief; add a soft pivot line without repeating a booking question.",
				{ pivot }
			);
			await humanSend(io, sc, st, msg);
			return true;
		}
	}

	if (
		thread.topic === "howru" &&
		thread.waitingForGuest &&
		(looksLikeWellnessReply(userText) || looksLikeClosureAck(userText))
	) {
		const openHelpPivot =
			pivot === "dates" &&
			!st.slots.roomTypeKey &&
			!hasOperationalBookingSignal(userText);
		const softPivot = askedRecently(st, pivot);
		const instr = openHelpPivot
			? "Acknowledge the guest's personal/casual reply warmly and naturally. If they mention Umrah, add a sincere short well-wish. Then ask an open question like how you can help with their stay today. Do not ask for check-in/check-out dates yet."
			: softPivot
			? "Acknowledge warmly. Add a soft pivot line (no direct repeated question)."
			: "Acknowledge warmly, then ask exactly ONE booking question for the next step (dates if missing, otherwise room type, otherwise proceed).";
		const msg = await write(io, sc, st, instr, { pivot });
		await humanSend(io, sc, st, msg);
		thread.waitingForGuest = false;
		thread.topic = null;
		logStep(caseId, "smalltalk.thread.update", {
			topic: thread.topic,
			waitingForGuest: thread.waitingForGuest,
		});
		return true;
	}

	const softPivot = askedRecently(st, pivot);
	if (softPivot) {
		const msg = await write(
			io,
			sc,
			st,
			"Reply politely to their casual message and add a soft pivot line without repeating a question.",
			{ pivot }
		);
		await humanSend(io, sc, st, msg);
	} else {
		let msg;
		if (pivot === "intentConfirm") {
			msg = await write(
				io,
				sc,
				st,
				"Ask a single yes/no: 'Just to confirm, are you looking to make a new reservation today?'",
				{}
			);
			await humanSend(io, sc, st, msg);
			stampAsk(st, "intentConfirm");
		} else if (pivot === "dates") {
			msg = await write(
				io,
				sc,
				st,
				hasOperationalBookingSignal(userText)
					? "Reply briefly to their casual line, then ask for check-in and check-out in ONE question."
					: "Reply warmly to their casual line, then ask an open question like how you can help with their stay today. Do not ask for check-in/check-out dates yet."
			);
			await humanSend(io, sc, st, msg);
			if (hasOperationalBookingSignal(userText)) stampAsk(st, "dates");
		} else if (pivot === "room") {
			const examples = (st.hotel?.roomCountDetails || [])
				.filter((r) => r.activeRoom)
				.map((r) => r.displayName || r.roomType)
				.slice(0, 4);
			msg = await write(
				io,
				sc,
				st,
				"Reply briefly, then ask which room type they prefer (offer 2–4 examples).",
				{ examples }
			);
			await humanSend(io, sc, st, msg);
			stampAsk(st, "room");
		} else if (pivot === "proceed") {
			msg = await write(
				io,
				sc,
				st,
				"Reply briefly, then ask a single yes/no if they want to proceed with the quoted room."
			);
			await humanSend(io, sc, st, msg);
			stampAsk(st, "proceed");
		} else {
			msg = await write(
				io,
				sc,
				st,
				"Reply briefly and ask them to type 'confirm' to finalize or tell you what to change."
			);
			await humanSend(io, sc, st, msg);
		}
	}
	return true;
}

async function maybeSendResponsiveSilenceFollowup(io, sc, st, userText = "", caseId = "") {
	if (!io || !st || !String(userText || "").trim()) return false;
	if (st.activeTurnHadReply || st.interrupt) return false;
	const targetCaseId = caseId || String(sc?._id || sc?.id || "");
	if (!targetCaseId) return false;
	try {
		const latestCase = (await getSupportCaseById(targetCaseId)) || sc;
		const conversation = Array.isArray(latestCase?.conversation)
			? latestCase.conversation
			: [];
		const latestAiAfterGuest = conversation.some((message) => {
			if (message?.isSystem || !isAiConversationMessage(message)) return false;
			const messageAt = new Date(message.date || 0).getTime();
			return (
				Number.isFinite(messageAt) &&
				messageAt > Number(st.activeTurnGuestAt || 0)
			);
		});
		if (latestAiAfterGuest) return false;
		const latestGuestIndex = latestGuestMessageIndex(latestCase);
		if (
			latestGuestIndex >= 0 &&
			conversation
				.slice(latestGuestIndex + 1)
				.some((message) => !message?.isSystem && isAiConversationMessage(message))
		) {
			return false;
		}
		const waitFor = st.waitFor || nextPivot(st);
		const prompt = await write(
			io,
			latestCase,
			st,
			"The guest's latest turn has not received a support reply yet. Review the conversation context and send one concise, professional follow-up in the guest's active language. Answer any direct question in latestUserMessage first using available hotel/reservation context. If there is no direct question, continue the current wait state by asking only for the missing item. Never ask for unrelated dates, room type, or confirmation if the guest asked a factual question. Do not mention delays or internal systems. Keep it short and natural.",
			{
				latestUserMessage: userText,
				waitFor,
				slots: st.slots,
				quoteReady: activeQuoteMatchesSlots(st),
				bookingNudgePaused: bookingNudgePaused(st),
				selectedHotelFacts: st.hotel ? buildActiveHotelFacts(latestCase, st) : null,
			}
		);
		const sent = await humanSend(io, latestCase, st, prompt);
		if (sent) {
			logStep(targetCaseId, "responsive_silence.followup", {
				waitFor,
				language: languageOf(latestCase, st),
			});
		}
		return sent;
	} catch (error) {
		logStep(targetCaseId, "responsive_silence.failed", {
			message: error?.message || error,
		});
		return false;
	}
}

/* ------------------- TURN PLANNER ------------------- */
const activePlanLocks = new Map();
const activePlanLockAts = new Map();
const pendingPlanRequests = new Map();
const planTurnExecutionContext = new AsyncLocalStorage();

function currentPlanStillOwnsTurn(caseId, st = {}) {
	const context = planTurnExecutionContext.getStore();
	if (!context || context.caseId !== String(caseId || "")) return true;
	return Boolean(
		st &&
			st.turnOwner === context.planLock &&
			activePlanLocks.get(context.caseId) === context.planLock
	);
}

function markPendingPlanRequest(caseId, reason = "locked") {
	const key = String(caseId || "");
	if (!key) return;
	pendingPlanRequests.set(key, { at: now(), reason });
	const st = memo.get(key);
	if (st?.turnInFlight) {
		if (st.queue.length < 1) st.queue.push(now());
		st.interrupt = true;
	}
}

async function shouldRunQueuedPlan(caseId, st = {}) {
	const sc2 = await getSupportCaseById(caseId).catch(() => null);
	if (!sc2) return { run: false, supportCase: null, reason: "missing_case" };
	const latestText = lastUserText(sc2);
	if (latestText && latestText !== st.activeTurnUserText) {
		return { run: true, supportCase: sc2, reason: "newer_customer_message" };
	}
	if (!st.activeTurnHadReply && !hasAiAssistantReplyAfterLatestGuest(sc2)) {
		return { run: true, supportCase: sc2, reason: "current_turn_unanswered" };
	}
	return { run: false, supportCase: sc2, reason: "current_turn_answered" };
}

async function planTurn(io, sc) {
	const caseId = String(sc._id);
	const turnLogStartedAt = now();
	if (activePlanLocks.has(caseId)) {
		const lockedAt = Number(activePlanLockAts.get(caseId) || 0);
		if (lockedAt && now() - lockedAt > AI_TURN_STALL_RECOVERY_MS * 2) {
			logStep(caseId, "turn.stale_lock_reset", { lockedForMs: now() - lockedAt });
			activePlanLocks.delete(caseId);
			activePlanLockAts.delete(caseId);
			const staleState = memo.get(caseId);
			if (staleState) {
				staleState.turnInFlight = false;
				staleState.turnOwner = null;
				staleState.allowPostBookingReentry = false;
				staleState.interrupt = true;
				staleState.queue = [];
			}
		} else {
			const lockedState = memo.get(caseId);
			const canReenterPostBooking =
				lockedState?.allowPostBookingReentry &&
				lockedState.waitFor === "post_booking_followup" &&
				lastUserText(sc) &&
				!hasAiAssistantReplyAfterLatestGuest(sc);
			if (canReenterPostBooking) {
				logStep(caseId, "turn.post_booking_reentry", {
					lockedForMs: now() - lockedAt,
					waitFor: lockedState.waitFor,
				});
				activePlanLocks.delete(caseId);
				activePlanLockAts.delete(caseId);
				lockedState.turnInFlight = false;
				lockedState.turnOwner = null;
				lockedState.interrupt = false;
				lockedState.queue = [];
			} else {
				markPendingPlanRequest(caseId, "active_plan_lock");
				schedulePlanTurn(io, caseId, { delayMs: AI_TURN_LOCK_RETRY_MS });
				logStep(caseId, "turn.enqueue", {
					reason: "active_plan_lock",
				});
				return;
			}
		}
	}
	const planLock = Symbol(caseId);
	activePlanLocks.set(caseId, planLock);
	activePlanLockAts.set(caseId, now());
	return planTurnExecutionContext.run({ caseId, planLock }, async () => {
	let st = null;
	let queuedFollowupCase = null;
	let queuedFollowupReason = "";
	let planningTyping = false;
	let planningTypingTimer = null;
	let delayNoticeTimer = null;
	let recoveryUserText = "";
	let ownsTurn = false;
	let deferredQuietDelayMs = null;
	let policy = null;
	let policyHotel = null;
	let hotel = null;
	try {
		const memoState = memo.get(caseId);
		const memoPolicyFresh =
			memoState?.hotel &&
			Number(memoState.policyAllowedAt || 0) > 0 &&
			now() - Number(memoState.policyAllowedAt || 0) <= AI_POLICY_MEMO_TTL_MS &&
			memoState.policyHotelId === idText(sc.hotelId) &&
			sc.openedBy === "client" &&
			sc.caseStatus === "open" &&
			sc.aiToRespond === true;
		const policyStartedAt = now();
		policy = memoPolicyFresh
			? { allowed: true, hotel: memoState.hotel, reason: "memo_policy" }
			: await ensureAIAllowed(sc.hotelId, sc);
		const policyElapsedMs = now() - policyStartedAt;
		if (policyElapsedMs >= 1000 || memoPolicyFresh) {
			logStep(caseId, "policy.checked", {
				source: memoPolicyFresh ? "memo" : "db",
				elapsedMs: policyElapsedMs,
			});
		}
		if (!policy.allowed) {
			logStep(caseId, "policy.skip", { reason: policy.reason });
			return;
		}
		policyHotel = policy.hotel || (await getHotelById(sc.hotelId));
		hotel = activeHotelContextForCase(sc, policyHotel);
		st = ensureState(sc, hotel);
		st.policyAllowedAt = now();
		st.policyHotelId = idText(sc.hotelId);
		if (st.turnInFlight) {
			logStep(caseId, "turn.enqueue", {
				reason: "in_flight",
				queued: st.queue.length + 1,
			});
			markPendingPlanRequest(caseId, "state_in_flight");
			schedulePlanTurn(io, caseId, { delayMs: AI_TURN_LOCK_RETRY_MS });
			return;
		}
		st.turnInFlight = true;
		st.turnOwner = planLock;
		st.allowPostBookingReentry = false;
		ownsTurn = true;
		st.interrupt = false;
		const schedulePlanningTyping = () => {
			const currentState = memo.get(caseId) || st;
			if (
				planningTyping ||
				!currentState.turnInFlight ||
				currentState.interrupt
			) {
				return;
			}
			const typingRemainingMs = Number(currentState.guestTypingUntil || 0) - now();
			if (typingRemainingMs > 0) {
				planningTypingTimer = setTimeout(
					schedulePlanningTyping,
					Math.min(typingRemainingMs + 50, 750)
				);
				if (typeof planningTypingTimer?.unref === "function") {
					planningTypingTimer.unref();
				}
				return;
			}
			emitTyping(io, caseId, currentState, true);
			planningTyping = true;
		};

		logStep(caseId, "context.loaded", {
			hotelId: sc.hotelId,
			hotelName: st.hotel?.hotelName || null,
			language: st.language,
			waitFor: st.waitFor,
			slots: st.slots,
		});

		const latestGuestMessage = lastGuestMessage(sc);
		const userText = latestGuestMessage?.message || "";
		recoveryUserText = userText;
		if (userText) clearAiIdleFollowups(caseId);
		st.activeTurnUserText = userText || "";
		st.activeTurnHadReply = false;
		st.activeTurnGuestAt = latestGuestMessage?.date
			? new Date(latestGuestMessage.date).getTime()
			: now();
		if (!Number.isFinite(st.activeTurnGuestAt)) st.activeTurnGuestAt = now();
		if (userText) {
			markGuestActivity(caseId, { activityAt: st.activeTurnGuestAt });
		}
		if (userText && hasAiAssistantReplyAfterLatestGuest(sc)) {
			st.activeTurnHadReply = true;
			logStep(caseId, "turn.skip", {
				reason: "latest_guest_already_answered",
			});
			return;
		}
		if (userText && AI_DELAY_NOTICE_ENABLED) {
			const delayNoticeInMs = Math.max(
				250,
				Number(st.activeTurnGuestAt || now()) + AI_DELAY_NOTICE_MS - now()
			);
			delayNoticeTimer = setTimeout(() => {
				sendAiDelayNotice(io, sc, st, userText, caseId).catch((error) => {
					logStep(caseId, "delay_notice.timer_failed", {
						message: error?.message || error,
					});
				});
			}, delayNoticeInMs);
			if (typeof delayNoticeTimer.unref === "function") {
				delayNoticeTimer.unref();
			}
		}
		if (userText) {
			const isReservationDetailChasePayload =
				isReservationDetailStep(st) &&
				!severeAbusiveGuestText(userText) &&
				reservationDetailChaseText(userText);
			const isReservationDetailPayload =
				isReservationDetailStep(st) &&
				!severeAbusiveGuestText(userText) &&
				(reservationDetailFieldPayloadText(userText) ||
					isReservationDetailChasePayload ||
					(["reviewConfirm", "finalize"].includes(st.waitFor) &&
						confirmsText(userText)));
			const isPostBookingFastPayload =
				(st.waitFor === "post_booking_followup" || aiReservationReference(sc)) &&
				!severeAbusiveGuestText(userText) &&
				(confirmationNumberQuestionText(userText) ||
					cancellationRefundPolicyQuestionText(userText) ||
					cancellationActionRequestText(userText) ||
					wantsPaymentHelp(userText) ||
					postBookingHaramTimingQuestionText(userText) ||
					postBookingLocalRecommendationQuestionText(userText) ||
					selectedHotelRoomQuestionText(userText) ||
					selectedHotelFactQuestionText(userText) ||
					isPostBookingClosure(userText));
			const quietMs = isReservationDetailChasePayload
				? AI_RESERVATION_CHASE_QUIET_MS
				: isReservationDetailPayload || isPostBookingFastPayload
				? AI_RESERVATION_DETAIL_QUIET_MS
				: AI_GUEST_REPLY_QUIET_MS;
			const quietRemainingMs = guestReplyQuietRemainingMs(
				st,
				st.activeTurnGuestAt,
				quietMs
			);
			if (quietRemainingMs > 25) {
				logStep(caseId, "turn.wait_guest_quiet", {
					remainingMs: quietRemainingMs,
					quietMs,
					isReservationDetailPayload,
					isReservationDetailChasePayload,
					isPostBookingFastPayload,
					guestTypingUntil: Number(st.guestTypingUntil || 0),
					latestGuestAgeMs: now() - Number(st.activeTurnGuestAt || now()),
				});
				deferredQuietDelayMs = quietRemainingMs + 35;
				return;
			}
		}
		if (
			userText &&
			String(userText || "").trim().length <= 140 &&
			!severeAbusiveGuestText(userText) &&
			!hasOperationalBookingSignal(userText)
		) {
			updateActiveLanguageFromText(sc, st, userText);
		}
		const immediateFastSmalltalk = st.hotel
			? fastEnglishSmalltalkText(sc, st, userText)
			: "";
		if (
			immediateFastSmalltalk &&
			!severeAbusiveGuestText(userText) &&
			!humanHandoffReason(userText) &&
			!explicitlyExistingReservationIntent(userText) &&
			!wantsPaymentHelp(userText)
		) {
			logStep(caseId, "smalltalk.fast_reply_before_hydrate", {
				waitFor: st.waitFor || "",
				latestUserMessage: String(userText || "").slice(0, 160),
			});
			await humanSend(io, sc, st, immediateFastSmalltalk, { fast: true });
			return;
		}
		if (userText) {
			hydrateKnownSlotsFromConversation(sc, st, {
				protectLatestGuestDateChange: Boolean(userText),
			});
			recoverBookingStageFromConversation(sc, st);
		}
		st.activeTurnReplyTargetMs = randomBetween(
			AI_REPLY_TARGET_MIN_MS,
			AI_REPLY_TARGET_MAX_MS
		);
		if (userText && aiReservationReference(sc)) {
			if (!severeAbusiveGuestText(userText)) {
				updateActiveLanguageFromText(sc, st, userText);
			}
			st.waitFor = "post_booking_followup";
			st.reviewSent = false;
			st.allowPostBookingReentry = true;
			const handledPostBookingFollowup = await handlePostBookingFollowup(
				io,
				sc,
				st,
				userText
			);
			if (handledPostBookingFollowup) return;
		}
		if (userText && st.waitFor === "post_booking_followup") {
			if (!severeAbusiveGuestText(userText)) {
				updateActiveLanguageFromText(sc, st, userText);
			}
			const handledPostBookingFollowup = await handlePostBookingFollowup(
				io,
				sc,
				st,
				userText
			);
			if (handledPostBookingFollowup) return;
		}
		if (
			userText &&
			looksLikeGuestDistressText(userText) &&
			!severeAbusiveGuestText(userText) &&
			!humanHandoffReason(userText) &&
			!wantsPaymentHelp(userText)
		) {
			logStep(caseId, "emotional_support.reply", {
				waitFor: st.waitFor || "",
				latestUserMessage: String(userText || "").slice(0, 160),
			});
			await sendDynamicEmotionalSupportReply(io, sc, st, userText);
			return;
		}
		if (
			userText &&
			isReservationDetailStep(st) &&
			!severeAbusiveGuestText(userText) &&
			!humanHandoffReason(userText) &&
			!wantsPaymentHelp(userText) &&
			(reservationDetailFieldPayloadText(userText) ||
				reservationDetailChaseText(userText) ||
				!directGuestRequestKind(sc, st, userText, {}))
		) {
			updateActiveLanguageFromText(sc, st, userText);
			const handledReservationDetail = await handleReservationDetailStep(
				io,
				sc,
				st,
				userText,
				caseId
			);
			if (handledReservationDetail) return;
		}
		if (userText && !severeAbusiveGuestText(userText)) {
			const handledReservationPayload =
				await handleReservationDetailPayloadFallback(io, sc, st, userText, caseId);
			if (handledReservationPayload) return;
		}
		if (userText && !severeAbusiveGuestText(userText)) {
			const immediateProceedHandled = await handleProceedStageInput(
				io,
				sc,
				st,
				userText,
				{},
				{ allowGeneric: false }
			);
			if (immediateProceedHandled) return;
		}
		const earlyFastSmalltalk = st.hotel
			? fastEnglishSmalltalkText(sc, st, userText)
			: "";
		if (
			earlyFastSmalltalk &&
			!severeAbusiveGuestText(userText) &&
			!humanHandoffReason(userText) &&
			!explicitlyExistingReservationIntent(userText) &&
			!wantsPaymentHelp(userText)
		) {
			logStep(caseId, "smalltalk.dynamic_reply_early", {
				waitFor: st.waitFor || "",
				latestUserMessage: String(userText || "").slice(0, 160),
			});
			await sendDynamicCasualReply(
				io,
				sc,
				st,
				userText,
				"Reply to this casual guest message in a warm, professional hotel CSR voice. Keep it concise and human. If it is only a greeting, thanks, or how-are-you, answer that naturally and ask an open how-can-I-help question. Do not ask for check-in/check-out dates, room type, phone, nationality, or payment details in this reply unless the guest explicitly asked for booking help."
			);
			return;
		}
		if (
			st.hotel &&
			userText &&
			selectedHotelRoomQuestionText(userText) &&
			!severeAbusiveGuestText(userText) &&
			!humanHandoffReason(userText) &&
			!explicitlyExistingReservationIntent(userText) &&
			!wantsPaymentHelp(userText)
		) {
			logStep(caseId, "selected_hotel.room_pre_reservation_start", {
				waitFor: st.waitFor || "",
				latestUserMessage: String(userText || "").slice(0, 160),
			});
			await answerSelectedHotelRoomQuestion(
				io,
				sc,
				st,
				userText,
				mapRoomToKey(userText) || st.slots?.roomTypeKey || null
			);
			return;
		}
		if (
			st.hotel &&
			userText &&
			selectedHotelFactQuestionText(userText) &&
			!severeAbusiveGuestText(userText) &&
			!humanHandoffReason(userText) &&
			(!explicitlyExistingReservationIntent(userText) ||
				cancellationRefundPolicyQuestionText(userText)) &&
			!wantsPaymentHelp(userText)
		) {
			logStep(caseId, "selected_hotel.fact_pre_reservation_start", {
				waitFor: st.waitFor || "",
				latestUserMessage: String(userText || "").slice(0, 160),
			});
			await answerSelectedHotelFactQuestion(io, sc, st, userText);
			return;
		}
		if (userText) {
			const directStayQuoteHandled = await tryShareDirectStayQuote(
				io,
				sc,
				st,
				userText,
				caseId
			);
			if (directStayQuoteHandled) return;
		}
		if (userText) {
			const directReservationStartHandled = await tryStartDirectReservationFlow(
				io,
				sc,
				st,
				userText,
				caseId
			);
			if (directReservationStartHandled) return;
		}
		const fastSmalltalk = st.hotel
			? fastEnglishSmalltalkText(sc, st, userText)
			: "";
		if (
			fastSmalltalk &&
			!severeAbusiveGuestText(userText) &&
			!humanHandoffReason(userText) &&
			!explicitlyExistingReservationIntent(userText) &&
			!wantsPaymentHelp(userText)
		) {
			logStep(caseId, "smalltalk.dynamic_reply", {
				waitFor: st.waitFor || "",
				latestUserMessage: String(userText || "").slice(0, 160),
			});
			await sendDynamicCasualReply(
				io,
				sc,
				st,
				userText,
				"Reply to this casual guest message in a warm, professional hotel CSR voice. Keep it concise and human. If it is only a greeting, thanks, or how-are-you, answer that naturally and ask an open how-can-I-help question. Do not ask for check-in/check-out dates, room type, phone, nationality, or payment details in this reply unless the guest explicitly asked for booking help."
			);
			return;
		}
		if (
			st.hotel &&
			selectedHotelRoomQuestionText(userText) &&
			!severeAbusiveGuestText(userText) &&
			!humanHandoffReason(userText) &&
			!explicitlyExistingReservationIntent(userText) &&
			!wantsPaymentHelp(userText)
		) {
			logStep(caseId, "selected_hotel.room_immediate", {
				waitFor: st.waitFor || "",
				latestUserMessage: String(userText || "").slice(0, 160),
			});
			await answerSelectedHotelRoomQuestion(
				io,
				sc,
				st,
				userText,
				mapRoomToKey(userText) || null
			);
			return;
		}
		if (
			st.hotel &&
			selectedHotelFactQuestionText(userText) &&
			!severeAbusiveGuestText(userText) &&
			!humanHandoffReason(userText) &&
			(!explicitlyExistingReservationIntent(userText) ||
				cancellationRefundPolicyQuestionText(userText)) &&
			!wantsPaymentHelp(userText)
		) {
			logStep(caseId, "selected_hotel.fact_immediate", {
				waitFor: st.waitFor || "",
				latestUserMessage: String(userText || "").slice(0, 160),
			});
			await answerSelectedHotelFactQuestion(io, sc, st, userText);
			return;
		}
		if (userText || !hasAiAssistantReply(sc)) {
			planningTypingTimer = setTimeout(
				schedulePlanningTyping,
				planningTypingDelayMs(st)
			);
			if (typeof planningTypingTimer?.unref === "function") {
				planningTypingTimer.unref();
			}
		}
		if (await handlePendingDateChangeChoice(io, sc, st, userText)) return;
		hydrateKnownSlotsFromConversation(sc, st, {
			protectLatestGuestDateChange: Boolean(userText),
		});
		recoverBookingStageFromConversation(sc, st);
		const protectReservationDetailLanguage = shouldProtectReservationDetailLanguage(
			sc,
			st,
			userText
		);
		const explicitLanguageSwitch = protectReservationDetailLanguage
			? null
			: explicitLanguageSwitchRequest(userText);
		if (!protectReservationDetailLanguage) {
			updateActiveLanguageFromText(sc, st, userText);
		}
		if (!userText) {
			if (!hasAiAssistantReply(sc) && !st.greeted && !st.greetScheduled) {
				st.greetScheduled = true;
				st.greeted = true;
				const initialInquiry = initialInquiryText(sc);
				if (previousChatContinuationRequestText(initialInquiry)) {
					await answerPreviousChatContinuationRequest(io, sc, st, initialInquiry);
					return;
				}
				if (!st.hotel && hotelComplaintText(initialInquiry)) {
					await handoffToHuman(io, sc, st, "jannat_hotel_complaint");
					return;
				}
				if (
					!st.hotel &&
					jannatReservationHotelRedirectIntent(initialInquiry, {}, sc)
				) {
					await redirectJannatReservationToHotelSupport(
						io,
						sc,
						st,
						initialInquiry,
						{}
					);
					return;
				}
				const initialUpdateLu = deterministicReservationUpdateLu(
					initialInquiry,
					sc,
					{}
				);
				if (
					st.hotel &&
					initialUpdateLu.confirmation &&
					initialUpdateLu.dates?.checkinISO &&
					initialUpdateLu.dates?.checkoutISO &&
					looksLikeReservationDateUpdate(initialInquiry, initialUpdateLu)
				) {
					const handled = await handleReservationUpdateRequest(
						io,
						sc,
						st,
						initialInquiry,
						initialUpdateLu,
						{ forceDateUpdate: true }
					);
					if (handled) return;
				}
				await sendDynamicCasualReply(
					io,
					sc,
					st,
					initialInquiry || "",
					initialInquiry
						? "The guest has just opened chat. Use the initial inquiry details only as private context, start with the approved readable Islamic greeting for the active language, greet them by first name, introduce yourself as the active assistant, using hotel reception and reservations wording when a hotel is selected, and ask how you can help today. If the context suggests a reservation, gently confirm that they may want to reserve a room. Do not open by asking for check-in/check-out dates."
						: "The guest has just opened chat but has not typed a message yet. Start with the approved readable Islamic greeting for the active language, greet them by first name, introduce yourself as the active assistant, using hotel reception and reservations wording when a hotel is selected, and ask how you can help today. Keep it one short line. Do not open by asking for check-in/check-out dates.",
					{ initialInquiry },
					{ first: true, fallbackText: initialHotelGreetingText(sc, st) }
				);
				st.waitFor = "clarify";
				return;
			}
			logStep(caseId, "turn.skip", { reason: "no_customer_message" });
			return;
		}
		if (!st.greeted && !st.greetScheduled) {
			st.greetScheduled = true;
			st.greeted = true;
			if (
				looksLikeGreetingOnly(userText) ||
				(looksLikeFirstTurnGreetingSmalltalk(userText) &&
					!hasConcreteFirstTurnBookingSignal(userText))
			) {
				await sendDynamicCasualReply(
					io,
					sc,
					st,
					userText,
					"Start with the approved readable Islamic greeting for the active language, greet the guest by first name, introduce yourself as the active assistant, using hotel reception and reservations wording when a hotel is selected, and ask how you can help today. Keep it one short line. Do not open by asking for check-in/check-out dates.",
					{ latestUserMessage: userText },
					{ first: true, fallbackText: initialHotelGreetingText(sc, st) }
				);
				st.waitFor = "clarify";
				return;
			}
		}
		if (explicitLanguageSwitch?.requestOnly) {
			await answerLanguageSwitchRequest(io, sc, st, userText);
			return;
		}
		if (previousChatContinuationRequestText(userText)) {
			await answerPreviousChatContinuationRequest(io, sc, st, userText);
			return;
		}

		hydrateKnownSlotsFromConversation(sc, st, {
			protectLatestGuestDateChange: Boolean(userText),
		});
		recoverBookingStageFromConversation(sc, st);
		if (aiReservationReference(sc) && bookingStateQuestionText(userText)) {
			const handledReservationState = await answerPostBookingStateQuestion(
				io,
				sc,
				st,
				userText
			);
			if (handledReservationState) return;
		}
		if (st.waitFor === "post_booking_followup") {
			const handled = await handlePostBookingFollowup(io, sc, st, userText);
			if (handled) return;
		}
		if (
			st.hotel &&
			selectedHotelFactQuestionText(userText) &&
			!severeAbusiveGuestText(userText) &&
			!humanHandoffReason(userText) &&
			!explicitlyExistingReservationIntent(userText) &&
			!wantsPaymentHelp(userText)
		) {
			logStep(caseId, "selected_hotel.fact_early", {
				waitFor: st.waitFor || "",
				latestUserMessage: String(userText || "").slice(0, 160),
			});
			await answerSelectedHotelFactQuestion(io, sc, st, userText);
			return;
		}
		const fastBookingStateHandled = await answerFastBookingStateQuestion(
			io,
			sc,
			st,
			userText,
			caseId
		);
		if (fastBookingStateHandled) return;
		const preBookingConfirmationHandled =
			await answerPreBookingConfirmationQuestion(io, sc, st, userText, caseId);
		if (preBookingConfirmationHandled) return;
		const earlyProceedHandled = await handleProceedStageInput(
			io,
			sc,
			st,
			userText,
			{},
			{ allowGeneric: false }
		);
		if (earlyProceedHandled) return;
		if (!severeAbusiveGuestText(userText)) {
			const earlyDirectRequestHandled = await tryAnswerDirectGuestRequest(
				io,
				sc,
				st,
				userText,
				{}
			);
			if (earlyDirectRequestHandled) return;
		}
		if (guestPauseOrLaterText(userText)) {
			await answerBookingPause(io, sc, st, userText);
			return;
		}
		if (botExperienceComplaintText(userText) && !severeAbusiveGuestText(userText)) {
			await answerConversationRecovery(io, sc, st, userText);
			return;
		}
		if (abusiveGuestText(userText)) {
			await handoffToHuman(io, sc, st, "abusive_guest");
			return;
		}
		if (await maybeEscalateRepeatedGuestQuestion(io, sc, st, userText, {})) {
			return;
		}
		if (botExperienceComplaintText(userText)) {
			await answerConversationRecovery(io, sc, st, userText);
			return;
		}
		const assistantBeforeLatestGuest = lastAssistantMessageBeforeLatestGuest(sc);
		const assistantBeforeLatestGuestActions = quickReplyActions(
			assistantBeforeLatestGuest
		);
		const assistantBeforeLatestGuestHasBookingChoice =
			assistantBeforeLatestGuestActions.includes("confirm") ||
			assistantBeforeLatestGuestActions.includes("correction") ||
			assistantBeforeLatestGuestActions.includes("proceed") ||
			assistantBeforeLatestGuestActions.some((action) =>
				action.startsWith("connect_hotel_")
			);
		if (
			st.slots.roomTypeKey &&
			st.slots.checkinISO &&
			st.slots.checkoutISO &&
			!isReservationDetailStep(st) &&
			st.waitFor !== "proceed" &&
			!assistantBeforeLatestGuestHasBookingChoice &&
			!humanHandoffReason(userText) &&
			!wantsPaymentHelp(userText) &&
			!explicitlyExistingReservationIntent(userText) &&
			(st.waitFor === "dates" ||
				(hijriYearOnlyOrClarificationText(userText) &&
					assistantAskedForDateOrHijriYear(lastAssistantText(sc))) ||
				(confirmsText(userText) &&
					assistantAskedForDateOrHijriYear(lastAssistantText(sc))))
		) {
			logStep(caseId, "dates.completed_from_context", {
				roomTypeKey: st.slots.roomTypeKey,
				checkinISO: st.slots.checkinISO,
				checkoutISO: st.slots.checkoutISO,
				waitFor: st.waitFor,
			});
			if (st.hotel) {
				await shareKnownStayQuote(io, sc, st);
			} else {
				await answerJannatBookingHotelOptions(
					io,
					sc,
					st,
					userText,
					st.slots.roomTypeKey
				);
			}
			return;
		}
		if (!st.hotel && hotelComplaintText(userText)) {
			await handoffToHuman(io, sc, st, "jannat_hotel_complaint");
			return;
		}
		if (!st.hotel && st.waitFor === "platform_hotel_choice") {
			const handled = await handlePlatformHotelChoice(io, sc, st, userText);
			if (handled) return;
		}
		if (
			!st.hotel &&
			st.waitFor === "jannat_reservation_reference" &&
			(latestKnownConfirmation(sc, {}) || wantsReservationHelp(userText))
		) {
			await redirectJannatReservationToHotelSupport(io, sc, st, userText, {});
			return;
		}
		if (st.waitFor === "reservation_cancellation_policy_ack") {
			const handled = await handleReservationCancellationPolicyAck(
				io,
				sc,
				st,
				userText
			);
			if (handled) return;
		}
		if (st.waitFor === "reservation_cancellation_reference") {
			const handled = await handleReservationCancellationRequest(
				io,
				sc,
				st,
				userText,
				{}
			);
			if (handled) return;
		}
		if (st.waitFor === "reservation_update_option") {
			const handled = await handlePendingReservationUpdateChoice(
				io,
				sc,
				st,
				userText
			);
			if (handled) return;
		}
		const directUpdateLu = deterministicReservationUpdateLu(userText, sc, {});
		if (
			st.hotel &&
			directUpdateLu.confirmation &&
			directUpdateLu.dates?.checkinISO &&
			directUpdateLu.dates?.checkoutISO &&
			looksLikeReservationDateUpdate(userText, directUpdateLu)
		) {
			if (needsExplicitPastDateClarification(userText, directUpdateLu.dates)) {
				await askExplicitPastDateClarification(
					io,
					sc,
					st,
					userText,
					directUpdateLu.dates
				);
				return;
			}
			const handled = await handleReservationUpdateRequest(
				io,
				sc,
				st,
				userText,
				directUpdateLu,
				{ forceDateUpdate: true }
			);
			if (handled) return;
		}
		if (st.pendingRoomAlternative) {
			const handled = await handlePendingRoomAlternativeChoice(
				io,
				sc,
				st,
				userText
			);
			if (handled) return;
		}
		if (st.pendingRoomCombination) {
			const handled = await handlePendingLargeGroupCombination(
				io,
				sc,
				st,
				userText
			);
			if (handled) return;
		}
		const quickTurnDates = extractDateRange(userText);
		if (needsExplicitPastDateClarification(userText, quickTurnDates)) {
			await askExplicitPastDateClarification(io, sc, st, userText, quickTurnDates);
			return;
		}
		const canUseLatestTurnDatesForBooking =
			quickTurnDates.checkinISO &&
			quickTurnDates.checkoutISO &&
			!humanHandoffReason(userText) &&
			!wantsPaymentHelp(userText) &&
			!explicitlyExistingReservationIntent(userText);
		if (canUseLatestTurnDatesForBooking) {
			const dateMerge = await mergeDateRangeWithChangeGuard(
				io,
				sc,
				st,
				quickTurnDates,
				{ source: "latest_turn_before_direct_request", userText }
			);
			if (dateMerge.prompted) return;
			logStep(caseId, "dates.merged_before_direct_request", {
				checkinISO: st.slots.checkinISO,
				checkoutISO: st.slots.checkoutISO,
				waitFor: st.waitFor || "",
				roomTypeKey: st.slots.roomTypeKey || null,
			});
		}
		const directRequestHandled = await tryAnswerDirectGuestRequest(
			io,
			sc,
			st,
			userText,
			{}
		);
		if (directRequestHandled) return;
		if (st.hotel && directHotelRelationshipQuestionText(userText)) {
			await answerDirectHotelRelationshipInquiry(io, sc, st, userText);
			return;
		}
		if (
			hotelContactDetailsQuestionText(userText) ||
			hotelContactFollowupQuestionText(sc, userText)
		) {
			await answerHotelContactDetailsInquiry(io, sc, st, userText);
			return;
		}
		if (
			st.hotel &&
			selectedHotelFactQuestionText(userText) &&
			!humanHandoffReason(userText) &&
			!wantsPaymentHelp(userText) &&
			(!explicitlyExistingReservationIntent(userText) ||
				cancellationRefundPolicyQuestionText(userText))
		) {
			await answerSelectedHotelFactQuestion(io, sc, st, userText);
			return;
		}
		if (vagueHajjInquiryText(userText)) {
			await answerVagueHajjInquiry(io, sc, st, userText);
			return;
		}
		if (isReservationDetailStep(st)) {
			const handled = await handleReservationDetailStep(
				io,
				sc,
				st,
				userText,
				caseId
			);
			if (handled) return;
		}
		const preNluProceedHandled = await handleProceedStageInput(
			io,
			sc,
			st,
			userText,
			{},
			{ allowGeneric: false }
		);
		if (preNluProceedHandled) return;
		if (
			st.hotel &&
			st.pendingRoomCombination &&
			quickTurnDates.checkinISO &&
			quickTurnDates.checkoutISO &&
			!humanHandoffReason(userText) &&
			!wantsPaymentHelp(userText) &&
			!explicitlyExistingReservationIntent(userText)
		) {
			const dateMerge = await mergeDateRangeWithChangeGuard(
				io,
				sc,
				st,
				quickTurnDates,
				{ source: "pending_combination_quick_dates", userText }
			);
			if (dateMerge.prompted) return;
			await answerLargeGroupRoomRecommendation(
				io,
				sc,
				st,
				userText,
				st.pendingRoomCombination.guestCount
			);
			return;
		}
		if (
			st.hotel &&
			st.slots.roomTypeKey &&
			quickTurnDates.checkinISO &&
			quickTurnDates.checkoutISO &&
			!humanHandoffReason(userText) &&
			!wantsPaymentHelp(userText) &&
			!explicitlyExistingReservationIntent(userText)
		) {
			const dateMerge = await mergeDateRangeWithChangeGuard(
				io,
				sc,
				st,
				quickTurnDates,
				{ source: "quick_dates_direct_quote", userText }
			);
			if (dateMerge.prompted) return;
			logStep(caseId, "quick_dates.direct_quote", {
				roomTypeKey: st.slots.roomTypeKey,
				checkinISO: st.slots.checkinISO,
				checkoutISO: st.slots.checkoutISO,
			});
			await shareKnownStayQuote(io, sc, st);
			return;
		}
		const singleTurnDate = extractSingleStayDate(userText, st);
		if (singleTurnDate?.raw) {
			const dateMerge = await mergePartialDateRangeWithChangeGuard(
				io,
				sc,
				st,
				singleTurnDate,
				{ source: "quick_single_date", userText }
			);
			if (dateMerge.prompted) return;
			if (dateMerge.invalid) {
				await askForMissingStayDates(io, sc, st);
				return;
			}
			if (
				st.hotel &&
				st.slots.roomTypeKey &&
				st.slots.checkinISO &&
				st.slots.checkoutISO &&
				!humanHandoffReason(userText) &&
				!wantsPaymentHelp(userText) &&
				!explicitlyExistingReservationIntent(userText)
			) {
				await shareKnownStayQuote(io, sc, st);
				return;
			}
			await askForMissingStayDates(io, sc, st);
			return;
		}

		// Legacy greeting branch is skipped after the first real customer turn.
		if (!st.greeted && !st.greetScheduled) {
			st.greetScheduled = true;
			st.waitFor = "intentConfirm";
			const greetOwner = st.hotel?.hotelName
				? `the ${toTitle(st.hotel.hotelName)} reception and reservations desk`
				: "Jannat Booking support";
			const greetText = await write(
				io,
				sc,
				st,
				`Start: "${islamicGreetingForLanguage(sc, st)} ${st.slots.name}." Introduce as ${st.agentName} from ${greetOwner}. Then ask: "I see you'd like to make a new reservation - is that correct?" (ONE yes/no).`
			);
			await humanSend(io, sc, st, greetText, { first: true });
			st.greeted = true;
			stampAsk(st, "intentConfirm");
			return;
		}

		const decisionLu =
			(await withSoftTimeout(
				nluStep({
					sc,
					hotel: st.hotel,
					lastUserMessage: userText,
				}),
				AI_NLU_STEP_SOFT_TIMEOUT_MS,
				{
					intent: "unknown",
					dates: quickTurnDates || {},
					roomTypeKey: mapRoomToKey(userText) || st.slots.roomTypeKey || null,
					amenity: findAmenityMatch(userText) || null,
					reason: "nlu_soft_timeout",
				}
			)) || {};
		if (
			decisionLu?.confirmation &&
			confirmationLooksLikePhoneInText(userText, decisionLu.confirmation) &&
			shouldTreatLatestAsNewBooking(userText, st, decisionLu)
		) {
			logStep(caseId, "nlu.confirmation_ignored_phone_context", {
				confirmation: decisionLu.confirmation,
			});
			decisionLu.confirmation = null;
		}
		logStep(caseId, "nlu.decision", decisionLu);
		if (needsExplicitPastDateClarification(userText, decisionLu?.dates)) {
			await askExplicitPastDateClarification(io, sc, st, userText, decisionLu.dates);
			return;
		}
		if (
			decisionLu.dates?.checkinISO &&
			decisionLu.dates?.checkoutISO &&
			!humanHandoffReason(userText) &&
			!wantsPaymentHelp(userText) &&
			!explicitlyExistingReservationIntent(userText)
		) {
			const dateMerge = await mergeDateRangeWithChangeGuard(
				io,
				sc,
				st,
				decisionLu.dates,
				{ source: "nlu_pre_direct", userText }
			);
			if (dateMerge.prompted) return;
			if (dateMerge.invalid) {
				await askForMissingStayDates(io, sc, st);
				return;
			}
		}
		const bookingFlowWasActiveBeforeNlu =
			isNewReservationFlowActive(st) ||
			Boolean(st.quote) ||
			["dates", "room", "proceed", "clarify", "intentConfirm"].includes(st.waitFor);
		const directRequestHandledAfterNlu = await tryAnswerDirectGuestRequest(
			io,
			sc,
			st,
			userText,
			decisionLu
		);
		if (directRequestHandledAfterNlu) return;

		if (
			!st.hotel &&
			jannatReservationHotelRedirectIntent(userText, decisionLu, sc)
		) {
			await redirectJannatReservationToHotelSupport(
				io,
				sc,
				st,
				userText,
				decisionLu
			);
			return;
		}

		if (needsExplicitPastDateClarification(userText, decisionLu?.dates)) {
			await askExplicitPastDateClarification(io, sc, st, userText, decisionLu.dates);
			return;
		}

		if (decisionLu.dates?.checkinISO && decisionLu.dates?.checkoutISO) {
			const dateMerge = await mergeDateRangeWithChangeGuard(
				io,
				sc,
				st,
				decisionLu.dates,
				{ source: "nlu_post_direct", userText }
			);
			if (dateMerge.prompted) return;
		} else {
			const dateMerge = await mergePartialDateRangeWithChangeGuard(
				io,
				sc,
				st,
				decisionLu.dates,
				{ source: "nlu_post_direct_partial", userText }
			);
			if (dateMerge.prompted) return;
			if (dateMerge.invalid) {
				await askForMissingStayDates(io, sc, st);
				return;
			}
		}
		if (
			st.hotel &&
			st.pendingRoomCombination &&
			st.slots.checkinISO &&
			st.slots.checkoutISO
		) {
			await answerLargeGroupRoomRecommendation(
				io,
				sc,
				st,
				userText,
				st.pendingRoomCombination.guestCount
			);
			return;
		}
		if (decisionLu.roomTypeKey) st.slots.roomTypeKey = decisionLu.roomTypeKey;

		if (
			looksLikeReservationDateUpdate(userText, decisionLu) ||
			st.waitFor === "reservation_update_clarify"
		) {
			const handled = await handleReservationUpdateRequest(
				io,
				sc,
				st,
				userText,
				decisionLu,
				{ forceDateUpdate: st.waitFor === "reservation_update_clarify" }
			);
			if (handled) return;
		}

		if (
			st.hotel &&
			selectedHotelFactQuestionText(userText) &&
			!humanHandoffReason(userText) &&
			!wantsPaymentHelp(userText) &&
			!explicitlyExistingReservationIntent(userText)
		) {
			await answerSelectedHotelFactQuestion(io, sc, st, userText);
			return;
		}

		if (
			st.hotel &&
			selectedHotelRoomQuestionText(userText) &&
			!humanHandoffReason(userText) &&
			!wantsPaymentHelp(userText) &&
			!explicitlyExistingReservationIntent(userText)
		) {
			const requestedRoomTypeKey =
				decisionLu.roomTypeKey || mapRoomToKey(userText) || st.slots.roomTypeKey || null;
			await answerSelectedHotelRoomQuestion(
				io,
				sc,
				st,
				userText,
				requestedRoomTypeKey
			);
			return;
		}

		if (!humanHandoffReason(userText) && wantsDiscountQuestion(userText)) {
			logStep(caseId, "discount.question", { source: "deterministic" });
			await answerDiscountQuestion(io, sc, st, userText);
			return;
		}

		const proceedHandled = await handleProceedStageInput(
			io,
			sc,
			st,
			userText,
			decisionLu
		);
		if (proceedHandled) return;

		const hasFreshNluDateRange = Boolean(
			decisionLu?.dates?.checkinISO && decisionLu?.dates?.checkoutISO
		);
		const readyToQuoteFromNlu =
			st.slots.checkinISO &&
			st.slots.checkoutISO &&
			st.slots.roomTypeKey &&
			(/\b(book|reserve|price|rate|availability|available|room|stay|double|triple|quad)\b/i.test(
				userText
			) ||
				(bookingFlowWasActiveBeforeNlu && hasFreshNluDateRange && st.hotel)) &&
			!humanHandoffReason(userText) &&
			!wantsPaymentHelp(userText) &&
			!wantsReservationHelp(userText);
		if (readyToQuoteFromNlu) {
			logStep(caseId, "nlu.direct_quote", {
				checkinISO: st.slots.checkinISO,
				checkoutISO: st.slots.checkoutISO,
				roomTypeKey: st.slots.roomTypeKey,
			});
			if (st.hotel) {
				await shareKnownStayQuote(io, sc, st);
			} else {
				await answerJannatBookingHotelOptions(
					io,
					sc,
					st,
					userText,
					st.slots.roomTypeKey
				);
			}
			return;
		}

		if (st.hotel && crossHotelRequestText(userText)) {
			logStep(caseId, "hotel_scope.boundary", { source: "deterministic" });
			await humanSend(io, sc, st, selectedHotelSupportBoundaryReply(sc, st));
			st.waitFor = "clarify";
			return;
		}

		const supportDecision = await decideSupportAction({
			sc,
			st,
			userText,
			lu: decisionLu,
		});
		if (
			supportDecision.action === "reservation_lookup" &&
			(isNewReservationFlowActive(st) ||
				shouldTreatLatestAsNewBooking(userText, st, decisionLu)) &&
			!explicitlyExistingReservationIntent(userText)
		) {
			supportDecision.action = "continue_booking";
			supportDecision.reason = "new_reservation_details_not_lookup";
			supportDecision.roomTypeKey =
				supportDecision.roomTypeKey ||
				decisionLu?.roomTypeKey ||
				mapRoomToKey(userText) ||
				st.slots?.roomTypeKey ||
				null;
		}
		logStep(caseId, "orchestrator.decision", supportDecision);

		const largeGroupGuestCount = requestedGuestCountFromText(userText);
		if (
			st.hotel &&
			(largeGroupGuestCount > 5 || extraBedBeyondFiveRequestText(userText)) &&
			!humanHandoffReason(userText) &&
			!wantsPaymentHelp(userText) &&
			!explicitlyExistingReservationIntent(userText)
		) {
			await answerLargeGroupRoomRecommendation(
				io,
				sc,
				st,
				userText,
				largeGroupGuestCount > 5 ? largeGroupGuestCount : 6
			);
			return;
		}

		if (supportDecision.roomTypeKey) {
			st.slots.roomTypeKey = supportDecision.roomTypeKey;
		}

		if (supportDecision.action === "general_answer") {
			if (confidentialCompanyDocumentQuestionText(userText)) {
				await answerConfidentialCompanyDocumentInquiry(io, sc, st, userText);
				return;
			}
			if (st.hotel && selectedHotelFactQuestionText(userText) && !liveCurrentGeneralQuestionText(userText)) {
				await answerSelectedHotelFactQuestion(io, sc, st, userText);
				return;
			}
			await answerGeneralContextQuestion(
				io,
				sc,
				st,
				userText,
				supportDecision.reason || "verified_general_answer"
			);
			return;
		}

		if (supportDecision.action === "support_email") {
			await answerSupportEmailInquiry(
				io,
				sc,
				st,
				userText,
				supportDecision.reason || "unsupported_general_question"
			);
			return;
		}

		if (broadGeneralSupportQuestionText(userText, st, decisionLu)) {
			await answerGeneralContextQuestion(
				io,
				sc,
				st,
				userText,
				supportDecision.reason || "unsupported_general_question"
			);
			return;
		}

		if (genericOpenAiQuestionText(userText, st, decisionLu)) {
			await answerGeneralContextQuestion(
				io,
				sc,
				st,
				userText,
				supportDecision.reason || "generic_unplanned_question"
			);
			return;
		}

		if (shouldUseDynamicUnplannedFallback(userText, st, decisionLu, supportDecision)) {
			await answerGeneralContextQuestion(
				io,
				sc,
				st,
				userText,
				supportDecision.reason || "dynamic_unplanned_fallback"
			);
			return;
		}

		if (shouldAskRoomPreferenceFirst(userText, st, decisionLu, supportDecision)) {
			await askRoomPreferenceForReservation(io, sc, st);
			return;
		}

		if (supportDecision.action === "discount_question") {
			logStep(caseId, "discount.question", { source: "decision" });
			await answerDiscountQuestion(io, sc, st, userText);
			return;
		}

		if (supportDecision.action === "reservation_cancellation") {
			const handled = await handleReservationCancellationRequest(
				io,
				sc,
				st,
				userText,
				decisionLu,
				{ forceCancellation: true }
			);
			if (handled) return;
			await answerCancellationRefundPolicyInquiry(io, sc, st, userText, decisionLu, {
				forceCancellation: true,
			});
			return;
		}

		if (supportDecision.action === "reservation_update") {
			if (!st.hotel) {
				await redirectJannatReservationToHotelSupport(
					io,
					sc,
					st,
					userText,
					decisionLu
				);
				return;
			}
			const handled = await handleReservationUpdateRequest(
				io,
				sc,
				st,
				userText,
				decisionLu
			);
			if (handled) return;
			await handoffToHuman(io, sc, st, "reservation_update");
			return;
		}

		if (supportDecision.action === "human_escalation") {
			if (
				looksLikeReservationCancellation(userText) ||
				cancellationRefundPolicyQuestionText(userText) ||
				/\b(?:cancellation|cancelation|cancel|refund)\b/i.test(
					String(supportDecision.reason || "")
				)
			) {
				await answerCancellationRefundPolicyInquiry(io, sc, st, userText, decisionLu, {
					forceCancellation: true,
				});
				return;
			}
			await handoffToHuman(
				io,
				sc,
				st,
				supportDecision.reason || "human_review_needed"
			);
			return;
		}

		if (
			supportDecision.action === "ask_dates_for_price" &&
			st.hotel &&
			st.slots.roomTypeKey &&
			(!st.slots.checkinISO || !st.slots.checkoutISO)
		) {
			await answerSelectedHotelRoomQuestion(
				io,
				sc,
				st,
				userText,
				st.slots.roomTypeKey
			);
			return;
		}

		if (supportDecision.action === "hotel_recommendation") {
			const roomTypeKey =
				supportDecision.roomTypeKey ||
				decisionLu.roomTypeKey ||
				st.slots.roomTypeKey ||
				null;
			if (st.hotel) {
				logStep(caseId, "hotel_scope.boundary", {
					source: "decision",
					reason: supportDecision.reason,
					scope: supportDecision.scope,
				});
				if (crossHotelRequestText(userText)) {
					await humanSend(io, sc, st, selectedHotelSupportBoundaryReply(sc, st));
					st.waitFor = "clarify";
					return;
				}
				await answerSelectedHotelRoomQuestion(io, sc, st, userText, roomTypeKey);
				return;
			}
			const recommendationRoomTypeKey = roomTypeKey || "doubleRooms";
			await answerJannatBookingHotelOptions(
				io,
				sc,
				st,
				userText,
				recommendationRoomTypeKey
			);
			return;
		}

		if (
			(supportDecision.action === "ask_dates_for_price" ||
				supportDecision.action === "continue_booking") &&
			st.slots.checkinISO &&
			st.slots.checkoutISO &&
			st.slots.roomTypeKey
		) {
			if (st.hotel) {
				await shareKnownStayQuote(io, sc, st);
			} else {
				await answerJannatBookingHotelOptions(
					io,
					sc,
					st,
					userText,
					st.slots.roomTypeKey
				);
			}
			return;
		}

		if (supportDecision.action === "ask_dates_for_price") {
			await askForMissingStayDates(io, sc, st);
			return;
		}

		if (supportDecision.action === "payment_help") {
			if (!st.hotel) {
				await redirectJannatReservationToHotelSupport(
					io,
					sc,
					st,
					userText,
					decisionLu
				);
				return;
			}
			const knownConfirmation = latestKnownConfirmation(sc, decisionLu);
			const reply = await write(
				io,
				sc,
				st,
				"The guest has a payment issue. Answer the latest question directly and keep it short. If a confirmation number or payment link already appears in the conversation, do not ask for it again. Never ask for card details.",
				{ latestUserMessage: userText, knownConfirmation }
			);
			await humanSend(io, sc, st, reply);
			st.waitFor = "payment_reference";
			return;
		}

		if (supportDecision.action === "reservation_lookup") {
			if (!st.hotel) {
				await redirectJannatReservationToHotelSupport(
					io,
					sc,
					st,
					userText,
					decisionLu
				);
				return;
			}
			const knownConfirmation = latestKnownConfirmation(sc, decisionLu);
			const reply = await write(
				io,
				sc,
				st,
				knownConfirmation
					? "The guest is asking about an existing reservation and the confirmation number is already known. Acknowledge the known confirmation number and ask only what they need help with. Do not ask for the confirmation number again."
					: "The guest is asking about an existing reservation. Ask for the confirmation number and one sentence about what they need. Keep it concise.",
				{ latestUserMessage: userText, knownConfirmation }
			);
			await humanSend(io, sc, st, reply);
			st.waitFor = "reservation_reference";
			return;
		}

		if (supportDecision.action === "amenity_question") {
			const amenityKey = decisionLu.amenity || findAmenityMatch(userText);
			if (amenityKey) {
				const chosenRoom = (st.hotel?.roomCountDetails || []).find(
					(room) => room.roomType === st.slots.roomTypeKey
				);
				const amenityFacts = {
					amenityKey,
					chosenRoom: chosenRoom
						? {
								displayName: chosenRoom.displayName || chosenRoom.roomType,
								hasAmenity: roomHasAmenity(chosenRoom, amenityKey),
						  }
						: null,
					hotelHasAmenity: hotelHasAmenity(st.hotel, amenityKey),
					nextStep: nextPivot(st),
				};
				const reply = await write(
					io,
					sc,
					st,
					"Answer the amenity question using the facts only, then include at most one helpful next question if needed.",
					amenityFacts
				);
				await humanSend(io, sc, st, reply);
				return;
			}
		}

		// Interpret latest user turn
		const handoffReason = humanHandoffReason(userText);
		if (handoffReason) {
			if (handoffReason === "reservation_cancellation") {
				const handled = await handleReservationCancellationRequest(
					io,
					sc,
					st,
					userText,
					decisionLu
				);
				if (handled) return;
				await answerCancellationRefundPolicyInquiry(io, sc, st, userText, decisionLu, {
					forceCancellation: true,
				});
				return;
			}
			if (handoffReason === "reservation_update") {
				if (!st.hotel) {
					await redirectJannatReservationToHotelSupport(
						io,
						sc,
						st,
						userText,
						decisionLu
					);
					return;
				}
				const handled = await handleReservationUpdateRequest(
					io,
					sc,
					st,
					userText,
					decisionLu
				);
				if (handled) return;
			}
			await handoffToHuman(io, sc, st, handoffReason);
			return;
		}
		const fallbackDirectRequestHandled = await tryAnswerDirectGuestRequest(
			io,
			sc,
			st,
			userText,
			decisionLu
		);
		if (fallbackDirectRequestHandled) return;
		if (shouldUseDynamicUnplannedFallback(userText, st, decisionLu, supportDecision)) {
			await answerGeneralContextQuestion(
				io,
				sc,
				st,
				userText,
				supportDecision.reason || "dynamic_unplanned_fallback_late"
			);
			return;
		}
		if (wantsHotelRecommendation(userText)) {
			if (st.hotel) {
				if (crossHotelRequestText(userText)) {
					logStep(caseId, "hotel_scope.boundary", { source: "keyword" });
					await humanSend(io, sc, st, selectedHotelSupportBoundaryReply(sc, st));
					st.waitFor = "clarify";
					return;
				}
				await answerSelectedHotelRoomQuestion(
					io,
					sc,
					st,
					userText,
					decisionLu.roomTypeKey || st.slots.roomTypeKey || null
				);
				return;
			}
			const roomTypeKey =
				decisionLu.roomTypeKey || mapRoomToKey(userText) || st.slots.roomTypeKey || null;
			await answerJannatBookingHotelOptions(io, sc, st, userText, roomTypeKey);
			return;
		}
		if (wantsPriceButMissingDates(userText, st)) {
			await askForMissingStayDates(io, sc, st);
			return;
		}
		if (wantsPaymentHelp(userText)) {
			if (!st.hotel) {
				await redirectJannatReservationToHotelSupport(
					io,
					sc,
					st,
					userText,
					decisionLu
				);
				return;
			}
			const knownConfirmation = latestKnownConfirmation(sc, {});
			const reply = await write(
				io,
				sc,
				st,
				"The guest has a payment issue. Give practical first-step guidance and ask for exactly one useful reference only if it is not already in the conversation. Never ask for card details.",
				{ latestUserMessage: userText, knownConfirmation }
			);
			await humanSend(io, sc, st, reply);
			st.waitFor = "payment_reference";
			return;
		}
		if (
			wantsReservationHelp(userText) &&
			!(
				isNewReservationFlowActive(st) &&
				!latestKnownConfirmation(sc, {}) &&
				!explicitlyExistingReservationIntent(userText)
			)
		) {
			if (!st.hotel) {
				await redirectJannatReservationToHotelSupport(
					io,
					sc,
					st,
					userText,
					decisionLu
				);
				return;
			}
			const knownConfirmation = latestKnownConfirmation(sc, {});
			const reply = await write(
				io,
				sc,
				st,
				"The guest is asking about an existing reservation. Ask for the missing reference or missing change detail only; do not ask again for anything already supplied. Keep it concise and professional.",
				{ latestUserMessage: userText, knownConfirmation }
			);
			await humanSend(io, sc, st, reply);
			st.waitFor = "reservation_reference";
			return;
		}
		const dateRange = extractDateRange(userText);
		if (needsExplicitPastDateClarification(userText, dateRange)) {
			await askExplicitPastDateClarification(io, sc, st, userText, dateRange);
			return;
		}
		if (
			st.hotel &&
			st.pendingRoomCombination &&
			dateRange.checkinISO &&
			dateRange.checkoutISO
		) {
			const dateMerge = await mergeDateRangeWithChangeGuard(io, sc, st, dateRange, {
				source: "fallback_combination_dates",
				userText,
			});
			if (dateMerge.prompted) return;
			await answerLargeGroupRoomRecommendation(
				io,
				sc,
				st,
				userText,
				st.pendingRoomCombination.guestCount
			);
			return;
		}
		if (
			dateRange.checkinISO &&
			dateRange.checkoutISO &&
			st.slots.roomTypeKey
		) {
			const dateMerge = await mergeDateRangeWithChangeGuard(io, sc, st, dateRange, {
				source: "fallback_direct_quote_dates",
				userText,
			});
			if (dateMerge.prompted) return;
			if (st.hotel) {
				await shareKnownStayQuote(io, sc, st);
			} else {
				await answerJannatBookingHotelOptions(
					io,
					sc,
					st,
					userText,
					st.slots.roomTypeKey
				);
			}
			return;
		}
		const singleDateFallback = extractSingleStayDate(userText, st);
		if (singleDateFallback?.raw) {
			const dateMerge = await mergePartialDateRangeWithChangeGuard(
				io,
				sc,
				st,
				singleDateFallback,
				{ source: "fallback_single_date", userText }
			);
			if (dateMerge.prompted) return;
			if (dateMerge.invalid) {
				await askForMissingStayDates(io, sc, st);
				return;
			}
			if (
				st.hotel &&
				st.slots.roomTypeKey &&
				st.slots.checkinISO &&
				st.slots.checkoutISO
			) {
				await shareKnownStayQuote(io, sc, st);
				return;
			}
			await askForMissingStayDates(io, sc, st);
			return;
		}
		const lu = decisionLu;
		logStep(caseId, "nlu.reused", lu);

		// raw dates (for hijri display) and slots
		if (lu.dates?.checkinISO && lu.dates?.checkoutISO) {
			const dateMerge = await mergeDateRangeWithChangeGuard(io, sc, st, lu.dates, {
				source: "nlu_reused",
				userText,
			});
			if (dateMerge.prompted) return;
		} else {
			const dateMerge = await mergePartialDateRangeWithChangeGuard(
				io,
				sc,
				st,
				lu.dates,
				{ source: "nlu_reused_partial", userText }
			);
			if (dateMerge.prompted) return;
			if (dateMerge.invalid) {
				await askForMissingStayDates(io, sc, st);
				return;
			}
		}
		if (lu.roomTypeKey) st.slots.roomTypeKey = lu.roomTypeKey;

		// ===== Amenity interception (e.g., "does it have WiFi?")
		const amenityKey = lu.amenity || findAmenityMatch(userText);
		if (amenityKey) {
			const chosenRoom = (st.hotel?.roomCountDetails || []).find(
				(r) => r.roomType === st.slots.roomTypeKey
			);
			const hasOnRoom = chosenRoom
				? roomHasAmenity(chosenRoom, amenityKey)
				: false;
			const hasOnHotel = !hasOnRoom && hotelHasAmenity(st.hotel, amenityKey);
			const amenityLabel =
				amenityKey === "wifi"
					? "Wi‑Fi"
					: amenityKey === "ac"
					? "air conditioning"
					: amenityKey;

			let line;
			if (chosenRoom) {
				const label =
					chosenRoom.displayName || chosenRoom.roomType || "this room";
				line = hasOnRoom
					? `Yes, the ${label} includes ${amenityLabel}.`
					: hasOnHotel
					? `The ${label} does not list ${amenityLabel}, but it is available at the hotel.`
					: `I don’t see ${amenityLabel} listed for the ${label}. If it’s essential, I can double‑check with the hotel team.`;
			} else {
				line = hasOnHotel
					? `Yes, ${amenityLabel} is available at the hotel.`
					: `I don’t see ${amenityLabel} listed. If it’s essential, I can double‑check with the hotel team.`;
			}

			// Pivot to the next required step after answering
			const pivot = nextPivot(st);
			let ask = "";
			if (pivot === "intentConfirm" && !askedRecently(st, "intentConfirm")) {
				ask = "Would you like to make a new reservation today?";
				stampAsk(st, "intentConfirm");
				st.waitFor = "intentConfirm";
			} else if (pivot === "dates" && !askedRecently(st, "dates")) {
				ask = "Could you share your preferred check‑in and check‑out dates?";
				ask = stayDateRequestText(sc, st);
				stampAsk(st, "dates");
				st.waitFor = "dates";
			} else if (pivot === "room" && !askedRecently(st, "room")) {
				const examples = (st.hotel?.roomCountDetails || [])
					.filter((r) => r.activeRoom)
					.map((r) => r.displayName || r.roomType)
					.slice(0, 4);
				ask = examples.length
					? `Which room type suits you best? For example: ${examples.join(
							" / "
					  )}.`
					: `Which room type would you like?`;
				stampAsk(st, "room");
				st.waitFor = "room";
			} else if (pivot === "proceed" && !askedRecently(st, "proceed")) {
				ask = "Would you like me to proceed with this option?";
				stampAsk(st, "proceed");
				st.waitFor = "proceed";
			}

			const reply = await write(
				io,
				sc,
				st,
				"Answer the guest's amenity question using the provided amenity result. Then, only if nextQuestion is present, add that next booking question naturally. Do not invent amenities.",
				{
					amenityLabel,
					amenityAvailableOnRoom: hasOnRoom,
					amenityAvailableOnHotel: hasOnHotel,
					roomLabel: chosenRoom?.displayName || chosenRoom?.roomType || "",
					answerDraft: line,
					nextQuestion: ask,
				}
			);
			await humanSend(io, sc, st, reply);
			return;
		}

		// month missing handling
		if (lu?.dates?.reason === "month_missing") {
			if (!askedRecently(st, "dates")) {
				const askMonth = await write(
					io,
					sc,
					st,
					"Explain kindly that the month is required. Ask once for both dates with month and year."
				);
				await humanSend(io, sc, st, askMonth);
				stampAsk(st, "dates");
			}
			st.waitFor = "dates";
			return;
		}

		// smalltalk
		if (lu.intent === "smalltalk") {
			await handleSmalltalk(io, sc, st, lu, userText);
			return;
		}

		if (shouldAskRoomPreferenceFirst(userText, st, lu, supportDecision)) {
			await askRoomPreferenceForReservation(io, sc, st);
			return;
		}

		// intent confirmation step
		if (st.waitFor === "intentConfirm") {
			if (confirmsText(userText)) {
				await askForMissingStayDates(io, sc, st);
				return;
			}
			if (/\b(yes|yep|yeah|correct|sure|تمام|نعم|ايه|أجل)\b/i.test(userText)) {
				if (!askedRecently(st, "dates")) {
					const ask = await write(
						io,
						sc,
						st,
						"Ask for check‑in and check‑out in one question. Keep it short."
					);
					await humanSend(io, sc, st, ask);
					stampAsk(st, "dates");
				}
				st.waitFor = "dates";
				return;
			} else if (declinesText(userText)) {
				const msg = await write(
					io,
					sc,
					st,
					"Acknowledge politely and ask how you can help (new reservation, existing booking, or availability). No long text."
				);
				await humanSend(io, sc, st, msg);
				return;
			} else {
				// If they answered with dates or a room phrase, the normal flow below will catch it.
			}
		}

		// need dates?
		if (!st.slots.checkinISO || !st.slots.checkoutISO) {
			await askForMissingStayDates(io, sc, st);
			return;
			const slotPromptBotTextBefore = st.lastBotText;
			if (!askedRecently(st, "dates")) {
				const ask = await write(
					io,
					sc,
					st,
					"Ask for check‑in and check‑out in one question. Keep it short."
				);
				await humanSend(io, sc, st, ask);
				stampAsk(st, "dates");
			}
			if (st.lastBotText === slotPromptBotTextBefore) {
				const followup = await write(
					io,
					sc,
					st,
					"The guest replied while the check-in/check-out dates are still missing. Respond to the latest message in context, acknowledge any room type they mentioned, and ask for check-in and check-out in one short question. Do not stay silent. Use the guest's active language.",
					{
						latestUserMessage: userText,
						knownRoomType: st.slots.roomTypeKey ? roomTypeLabel(st.slots.roomTypeKey) : "",
						slots: st.slots,
					}
				);
				await humanSend(io, sc, st, followup);
				stampAsk(st, "dates");
			}
			st.waitFor = "dates";
			return;
		}

		if (
			st.hotel &&
			st.pendingRoomCombination &&
			st.slots.checkinISO &&
			st.slots.checkoutISO
		) {
			await answerLargeGroupRoomRecommendation(
				io,
				sc,
				st,
				userText,
				st.pendingRoomCombination.guestCount
			);
			return;
		}

		// need room?
		if (!st.slots.roomTypeKey) {
			const guestCountForRoomFit = requestedGuestCountFromText(userText);
			const recommendedRoomTypeKey =
				recommendedRoomTypeKeyForGuestCount(guestCountForRoomFit);
			if (
				st.hotel &&
				st.slots.checkinISO &&
				st.slots.checkoutISO &&
				recommendedRoomTypeKey
			) {
				const recommendedRooms = activeHotelRoomSummaries(
					st.hotel,
					recommendedRoomTypeKey
				);
				if (recommendedRooms.length) {
					st.slots.roomTypeKey = recommendedRoomTypeKey;
					logStep(caseId, "room.inferred_from_guest_count", {
						guestCount: guestCountForRoomFit,
						roomTypeKey: recommendedRoomTypeKey,
						checkinISO: st.slots.checkinISO,
						checkoutISO: st.slots.checkoutISO,
					});
					await shareKnownStayQuote(io, sc, st);
					return;
				}
			}
			const slotPromptBotTextBefore = st.lastBotText;
			if (!askedRecently(st, "room")) {
				const options = (st.hotel?.roomCountDetails || [])
					.filter((r) => r.activeRoom)
					.map((r) => r.displayName || r.roomType)
					.slice(0, 4);
				const ask = await write(
					io,
					sc,
					st,
					"Ask which room type they prefer (ONE question). Offer 2–4 examples.",
					{ roomExamples: options }
				);
				await humanSend(io, sc, st, ask);
				stampAsk(st, "room");
			}
			if (st.lastBotText === slotPromptBotTextBefore) {
				const options = (st.hotel?.roomCountDetails || [])
					.filter((r) => r.activeRoom)
					.map((r) => r.displayName || r.roomType)
					.slice(0, 4);
				const followup = await write(
					io,
					sc,
					st,
					"The guest replied but the room type is still missing. Acknowledge the latest message briefly, then ask which room type they prefer in one question. Offer the provided examples if helpful. Do not stay silent. Use the guest's active language.",
					{ latestUserMessage: userText, roomExamples: options, slots: st.slots }
				);
				await humanSend(io, sc, st, followup);
				stampAsk(st, "room");
			}
			st.waitFor = "room";
			return;
		}

		if (!st.hotel) {
			await answerJannatBookingHotelOptions(
				io,
				sc,
				st,
				userText,
				st.slots.roomTypeKey
			);
			return;
		}

		if (
			st.pendingRoomCombination &&
			st.slots.checkinISO &&
			st.slots.checkoutISO
		) {
			await answerLargeGroupRoomRecommendation(
				io,
				sc,
				st,
				userText,
				st.pendingRoomCombination.guestCount
			);
			return;
		}

		// pricing
		const qKey = `${st.slots.roomTypeKey}|${st.slots.checkinISO}|${st.slots.checkoutISO}`;
		const reuse =
			st.quote && st.quote.key === qKey && now() - st.quote.at < 120000;
		let quote;
		if (!reuse) {
			quote = safePriceRoomForStay(
				st.hotel,
				{ roomType: st.slots.roomTypeKey },
				st.slots.checkinISO,
				st.slots.checkoutISO
			);
			logStep(caseId, "pricing", {
				roomType: st.slots.roomTypeKey,
				available: quote.available,
				reason: quote.reason || null,
				nights: quote.nights || 0,
				total: quote?.totals?.totalPriceWithCommission,
				currency: quote.currency,
			});
			st.quote = { key: qKey, at: now(), data: quote };
		} else {
			quote = st.quote.data;
			logStep(caseId, "pricing.skip", { reason: "cooldown", key: qKey });
		}

		if (!quote.available) {
			await sendUnavailableRoomRecovery(io, sc, st, quote);
			return;
		}

		// quote summary (cooldown)
		if (now() - st.quoteSummarizedAt > QUOTE_SUMMARY_COOLDOWN) {
			const total = quote.totals.totalPriceWithCommission;
			const nights = quote.nights;
			const perNightAvg = Math.round((total / Math.max(1, nights)) * 100) / 100;
			const display = {
				hotel: toTitle(st.hotel?.hotelName || "Hotel"),
				roomDisplay:
					quote.room?.displayName ||
					quote.room?.roomType ||
					st.slots.roomTypeKey,
				nights,
				currency: quote.currency,
				perNight: perNightAvg,
				total,
				dates: {
					checkin: usDate(st.slots.checkinISO),
					checkout: usDate(st.slots.checkoutISO),
				},
				dateDisplay: stayDateDisplay(st),
			};
			let quoteMsg = await write(
				io,
				sc,
				st,
				"Share a concise availability & price summary (no upsell). If the guest provided Hijri dates, include the Hijri range and matching Gregorian range. Then ask a single yes/no: should I continue with the reservation details?",
				display
			);
			quoteMsg = ensureHijriGregorianDatesVisible(quoteMsg, sc, st);
			const sent = await humanSend(io, sc, st, quoteMsg, {
				quickReplies: proceedQuickReplies(sc, st),
				targetReplyMs: AI_BOOKING_QUOTE_TARGET_MS,
			});
			if (!sent) return;
			st.quoteSummarizedAt = now();
		}
		st.waitFor = "proceed";

		// proceed?
		if (st.waitFor === "proceed") {
			if (confirmsText(userText)) {
				resumeBookingNudge(st);
				await beginReservationDetailsAfterQuote(io, sc, st, caseId, {
					fast: true,
				});
				return;
			}
			if (declinesText(userText)) {
				pauseBookingNudge(st);
				const msg = await write(
					io,
					sc,
					st,
					"Acknowledge politely that there is no rush. Offer to help with different dates, another room type, or hotel details. Do not repeat the quote and do not push the reservation details step."
				);
				await humanSend(io, sc, st, msg);
				return;
			}
			if (
				/\b(yes|yep|yeah|ok|okay|proceed|go ahead|confirm|تمام|نعم|ايه)\b/i.test(
					userText
				)
			) {
				resumeBookingNudge(st);
				await beginReservationDetailsAfterQuote(io, sc, st, caseId, {
					fast: true,
				});
				return;
			} else if (declinesText(userText)) {
				const msg = await write(
					io,
					sc,
					st,
					"Acknowledge politely that there is no rush. Offer to help with different dates, another room type, or hotel details. Do not repeat the quote and do not push the reservation details step."
				);
				await humanSend(io, sc, st, msg);
				return;
			} else {
				const proceedPromptBotTextBefore = st.lastBotText;
				if (!askedRecently(st, "proceed")) {
					const poke = await write(
						io,
						sc,
						st,
						"Ask a single yes/no: should I continue with the reservation details?"
					);
					await humanSend(io, sc, st, poke, {
						quickReplies: proceedQuickReplies(sc, st),
					});
					stampAsk(st, "proceed");
				}
				if (st.lastBotText === proceedPromptBotTextBefore) {
					const poke = await write(
						io,
						sc,
						st,
						"The quote is ready, but the guest did not clearly accept or decline. Acknowledge the latest message briefly and ask one short yes/no question: should you continue with the reservation details? Do not repeat the price. Do not stay silent. Use the guest's active language.",
						{ latestUserMessage: userText, quoteReady: true, slots: st.slots }
					);
					await humanSend(io, sc, st, poke, {
						quickReplies: proceedQuickReplies(sc, st),
					});
					stampAsk(st, "proceed");
				}
				return;
			}
		}

		// After review: collect mandatory guest details in one prompt, then optional email.
		if (
			[
				"reviewConfirm",
				"reservation_details",
				"fullname",
				"nationality",
				"phone",
				"email_or_skip",
				"finalize",
			].includes(st.waitFor)
		) {
			const handledDetailStep = await handleReservationDetailStep(
				io,
				sc,
				st,
				userText,
				caseId
			);
			if (handledDetailStep) return;
			return;

			if (st.waitFor === "reviewConfirm") {
				if (!confirmsText(userText)) return;
				st.waitFor = "fullname";
				const prompt = await write(
					io,
					sc,
					st,
					"Ask naturally for the guest's full name in English as it should appear on the reservation/passport. Keep it warm and ask only this one question."
				);
				await humanSend(io, sc, st, prompt);
				stampAsk(st, "fullname");
				return;
			}

			if (st.waitFor === "fullname" && !st.slots.fullName) {
				const norm = await normalizeNameLLM(userText, st.language);
				if (norm?.valid && norm.fullNameAscii) {
					st.slots.fullName = asciiize(norm.fullNameAscii).trim();
					st.slots.name = st.slots.fullName;
					logStep(caseId, "fullname.captured", {
						fullName: st.slots.fullName,
					});
					st.waitFor = "nationality";
					const askNat = await write(
						io,
						sc,
						st,
						"Ask naturally for the guest's nationality/country name in English. Keep it warm and ask only this one question."
					);
					await humanSend(io, sc, st, askNat);
					stampAsk(st, "nationality");
					return;
				}
				const askAgain = await write(
					io,
					sc,
					st,
					"Kindly ask for a valid full name in English letters. Keep it polite and brief."
				);
				await humanSend(io, sc, st, askAgain);
				stampAsk(st, "fullname");
				return;
			}

			if (st.waitFor === "nationality" && !st.slots.nationality) {
				const nat = await validateNationalityLLM(userText, st.language);
				if (nat?.valid && nat.normalized) {
					st.slots.nationality = nat.normalized;
					logStep(caseId, "nationality.captured", {
						nationality: st.slots.nationality,
					});
					st.waitFor = "phone";
					const askPhone = await write(
						io,
						sc,
						st,
						"Ask naturally for a reachable phone number. Mention WhatsApp is helpful/preferred, but do not make it sound mandatory. Ask only this one question."
					);
					await humanSend(io, sc, st, askPhone);
					stampAsk(st, "phone");
					return;
				}
				const again = await write(
					io,
					sc,
					st,
					"Politely say the nationality was not recognized and ask again for the nationality/country name in English."
				);
				await humanSend(io, sc, st, again);
				stampAsk(st, "nationality");
				return;
			}

			if (st.waitFor === "phone" && !st.slots.phone) {
				const clean = digitsToEnglish(userText).replace(/\D/g, "");
				if (clean.length >= 5) {
					st.slots.phone = clean;
					logStep(caseId, "phone.captured", { phone: st.slots.phone });
					st.waitFor = "email_or_skip";
					const askEmail = await write(
						io,
						sc,
						st,
						"Ask naturally for an email address for reservation details. Let the guest know they can type skip if they prefer not to share one. Ask only this one question."
					);
					await humanSend(io, sc, st, askEmail);
					stampAsk(st, "email_or_skip");
					return;
				}
				const again = await write(
					io,
					sc,
					st,
					"Kindly ask for a reachable phone number using digits. Keep it polite."
				);
				await humanSend(io, sc, st, again);
				stampAsk(st, "phone");
				return;
			}

			if (st.waitFor === "email_or_skip" && !st.slots.email && !st.slots.emailSkipped) {
				const txt = String(userText).trim();
				const email = latestEmailFromText(txt);
				if (email) {
					st.slots.email = email;
					logStep(caseId, "email.captured", { email: st.slots.email });
				} else {
					await inferReservationDetailsFromContext(sc, st, txt, caseId);
					if (st.slots.emailSkipped) {
						logStep(caseId, "email.skipped", { source: "context" });
					} else if (!st.slots.email) {
						const ask = await write(
							io,
							sc,
							st,
							"If that does not look like an email, ask once more briefly and say they can continue without sharing one if they prefer."
						);
						await humanSend(io, sc, st, ask);
						stampAsk(st, "email_or_skip");
						return;
					}
				}
				st.waitFor = "finalize";
			}

			if (st.waitFor === "finalize") {
				try {
					await finalizeReservationForGuest(io, sc, st, caseId);
					return;
				} catch (error) {
					logStep(caseId, "reservation.create_failed", {
						message: error?.message || error,
					});
					await handoffToHuman(io, sc, st, "reservation_finalize_failed");
					return;
				}
			}
		}

		if (st.waitFor === "reviewConfirm") {
			if (/\bconfirm(ed)?\b/i.test(userText)) {
				st.waitFor = "fullname";
			} else {
				return;
			}
		}

		if (st.waitFor === "fullname" && !st.slots.fullName) {
			const prompt = await write(
				io,
				sc,
				st,
				"Ask naturally for the guest's full name in English as it should appear on the reservation/passport. If it is for someone else, ask for that guest's full name. Keep it warm and ask only this one question."
			);
			await humanSend(io, sc, st, prompt);
			return;
		}
		if (!st.slots.fullName && st.waitFor === "fullname") {
			const norm = await normalizeNameLLM(userText, st.language);
			if (norm?.valid && norm.fullNameAscii) {
				st.slots.fullName = asciiize(norm.fullNameAscii).trim();
				logStep(caseId, "fullname.captured", { fullName: st.slots.fullName });
				st.waitFor = "nationality";
			} else {
				const askAgain = await write(
					io,
					sc,
					st,
					"Kindly ask for a valid FULL name in English (letters only). Keep it polite and brief."
				);
				await humanSend(io, sc, st, askAgain);
				return;
			}
		}

		if (st.waitFor === "nationality" && !st.slots.nationality) {
			const askNat = await write(
				io,
				sc,
				st,
				"Ask naturally for the guest's nationality/country name in English. Keep it warm and ask only this one question."
			);
			await humanSend(io, sc, st, askNat);
			return;
		}
		if (!st.slots.nationality && st.waitFor === "nationality") {
			const nat = await validateNationalityLLM(userText, st.language);
			if (nat?.valid && nat.normalized) {
				st.slots.nationality = nat.normalized;
				logStep(caseId, "nationality.captured", {
					nationality: st.slots.nationality,
				});
				st.waitFor = "phone";
			} else {
				const again = await write(
					io,
					sc,
					st,
					"Politely say that nationality wasn’t recognized and ask again (English name)."
				);
				await humanSend(io, sc, st, again);
				return;
			}
		}

		if (st.waitFor === "phone" && !st.slots.phone) {
			const askPhone = await write(
				io,
				sc,
				st,
				"Ask naturally for a reachable phone number. Mention WhatsApp is helpful/preferred, but do not make it sound mandatory. Ask only this one question."
			);
			await humanSend(io, sc, st, askPhone);
			return;
		}
		if (!st.slots.phone && st.waitFor === "phone") {
			const clean = digitsToEnglish(userText).replace(/\D/g, "");
			if (clean.length >= 5) {
				st.slots.phone = clean;
				logStep(caseId, "phone.captured", { phone: st.slots.phone });
				st.waitFor = "email_or_skip";
			} else {
				const again = await write(
					io,
					sc,
					st,
					"Kindly ask for a reachable phone number (digits only). Keep it polite."
				);
				await humanSend(io, sc, st, again);
				return;
			}
		}

		if (st.waitFor === "email_or_skip" && !st.slots.email && !st.slots.emailSkipped) {
			const txt = String(userText).trim();
			const email = latestEmailFromText(txt);
			if (email) {
				st.slots.email = email;
				logStep(caseId, "email.captured", { email: st.slots.email });
			} else {
				await inferReservationDetailsFromContext(sc, st, txt, caseId);
				if (st.slots.emailSkipped) {
					logStep(caseId, "email.skipped", { source: "context" });
				} else if (!st.slots.email) {
					const ask = await write(
						io,
						sc,
						st,
						"Ask naturally for an email address for reservation details. Let the guest know they can continue without one if they prefer. Ask only this one question."
					);
					await humanSend(io, sc, st, ask);
					stampAsk(st, "email_or_skip");
					return;
				}
			}
			st.waitFor = "finalize";
		}

		// Final reservation commits are guarded by inventory validation and pending-confirmation policy.
		if (st.waitFor === "finalize") {
			try {
				await finalizeReservationForGuest(io, sc, st, caseId);
			} catch (error) {
				logStep(caseId, "reservation.create_failed", {
					message: error?.message || error,
				});
				await handoffToHuman(io, sc, st, "reservation_finalize_failed");
			}
			return;
		}
	} catch (e) {
		logStep(caseId, "error", { message: e?.message || e });
		try {
			const latestCase = await getSupportCaseById(caseId);
			const conversation = Array.isArray(latestCase?.conversation)
				? latestCase.conversation
				: [];
			const latestAiAfterGuest = conversation.some((message) => {
				if (message?.isSystem || !isAiConversationMessage(message)) return false;
				const messageAt = new Date(message.date || 0).getTime();
				return (
					Number.isFinite(messageAt) &&
					messageAt > Number(st.activeTurnGuestAt || 0)
				);
			});
			if (recoveryUserText && !st.interrupt && !latestAiAfterGuest) {
				const recoveryCase = latestCase || sc;
				const dynamicRecovery = await withSoftTimeout(
					write(
						io,
						recoveryCase,
						st,
						"The normal handler hit a recoverable internal issue. Do not mention technical details. Study the full conversation and answer the latest guest message directly in one or two professional sentences in the guest's active language, preserving any known booking context and never asking again for details already supplied.",
						{
							latestUserMessage: recoveryUserText,
							recoveryMode: true,
						}
					),
					4500,
					""
				);
				await humanSend(
					io,
					recoveryCase,
					st,
					dynamicRecovery || technicalRecoveryText(recoveryCase, st),
					{ targetReplyMs: AI_BOOKING_PROMPT_TARGET_MS }
				);
			}
		} catch (recoveryError) {
			logStep(caseId, "error.recovery_failed", {
				message: recoveryError?.message || recoveryError,
			});
		}
	} finally {
		const st2 = memo.get(caseId);
		const turnElapsedMs = now() - turnLogStartedAt;
		if (turnElapsedMs >= AI_TURN_SLOW_LOG_MS) {
			console.log("[aiagent] slow turn", {
				caseId,
				elapsedMs: turnElapsedMs,
				waitFor: st2?.waitFor || st?.waitFor || null,
				hadReply: Boolean(st2?.activeTurnHadReply || st?.activeTurnHadReply),
				interrupted: Boolean(st2?.interrupt || st?.interrupt),
			});
		}
		if (planningTypingTimer) {
			clearTimeout(planningTypingTimer);
		}
		if (delayNoticeTimer) {
			clearTimeout(delayNoticeTimer);
		}
		if (planningTyping) {
			emitTyping(io, caseId, st2 || st, false);
		}
		if (
			deferredQuietDelayMs === null &&
			st2 &&
			recoveryUserText &&
			!st2.activeTurnHadReply &&
			!st2.interrupt
		) {
			await maybeSendResponsiveSilenceFollowup(
				io,
				sc,
				st2,
				recoveryUserText,
				caseId
			);
		}
		const stillOwnsTurn = Boolean(st2 && ownsTurn && st2.turnOwner === planLock);
		if (st2 && ownsTurn && !stillOwnsTurn) {
			logStep(caseId, "turn.owner_replaced", {
				waitFor: st2.waitFor || st?.waitFor || null,
			});
		}
		if (stillOwnsTurn) {
			st2.turnInFlight = false;
			st2.turnOwner = null;
			if (st2.queue.length > 0) {
				const queuedCount = st2.queue.length;
				st2.queue = [];
				const queued = await shouldRunQueuedPlan(caseId, st2);
				if (queued.run) {
					queuedFollowupCase = queued.supportCase;
					queuedFollowupReason = queued.reason;
					logStep(caseId, "turn.consume_queue", {
						queued: queuedCount,
						reason: queued.reason,
					});
				} else {
					logStep(caseId, "turn.drop_queue", {
						queued: queuedCount,
						reason: queued.reason,
					});
				}
			}
		}
		const pending = pendingPlanRequests.get(caseId);
		if (pending && stillOwnsTurn) {
			pendingPlanRequests.delete(caseId);
			if (!queuedFollowupCase) {
				const queued = await shouldRunQueuedPlan(caseId, st2 || st || {});
				if (queued.run) {
					queuedFollowupCase = queued.supportCase;
					queuedFollowupReason = queued.reason || pending.reason;
					logStep(caseId, "turn.consume_pending", {
						reason: queuedFollowupReason,
						pendingReason: pending.reason,
					});
				} else {
					logStep(caseId, "turn.drop_pending", {
						reason: queued.reason,
						pendingReason: pending.reason,
					});
				}
			}
		}
		if (activePlanLocks.get(caseId) === planLock) {
			activePlanLocks.delete(caseId);
			activePlanLockAts.delete(caseId);
		}
		if (deferredQuietDelayMs !== null && !queuedFollowupCase) {
			schedulePlanTurn(io, caseId, { delayMs: deferredQuietDelayMs });
			logStep(caseId, "turn.schedule_guest_quiet_followup", {
				delayMs: deferredQuietDelayMs,
			});
		}
		if (queuedFollowupCase) {
			setTimeout(() => {
				planTurn(io, queuedFollowupCase).catch((error) => {
					console.error("[aiagent] queued plan error:", error?.message || error);
				});
			}, 0);
			logStep(caseId, "turn.schedule_followup", {
				reason: queuedFollowupReason,
			});
		}
	}
	});
}

const scheduledTurns = new Map();
const unansweredTurnRecoveryTimers = new Map();
const unansweredTurnRecoveryAttempts = new Map();

function latestGuestNeedsAiReply(sc = {}) {
	if (!sc || sc.caseStatus === "closed" || sc.aiToRespond === false) return false;
	if (latestGuestMessageIndex(sc) < 0) return false;
	return !hasAiAssistantReplyAfterLatestGuest(sc);
}

function clearUnansweredTurnRecovery(caseId) {
	const key = String(caseId || "");
	if (!key) return;
	const timer = unansweredTurnRecoveryTimers.get(key);
	if (timer) clearTimeout(timer);
	unansweredTurnRecoveryTimers.delete(key);
	unansweredTurnRecoveryAttempts.delete(key);
}

function scheduleUnansweredTurnRecovery(io, caseId, delayMs = AI_TURN_STALL_RECOVERY_MS) {
	const key = String(caseId || "");
	if (!io || !key) return false;
	const existing = unansweredTurnRecoveryTimers.get(key);
	if (existing) clearTimeout(existing);
	const timer = setTimeout(() => {
		runUnansweredTurnRecovery(io, key).catch((error) => {
			console.error("[aiagent] unanswered-turn recovery error:", error?.message || error);
		});
	}, Math.max(1000, Number(delayMs) || AI_TURN_STALL_RECOVERY_MS));
	if (typeof timer.unref === "function") timer.unref();
	unansweredTurnRecoveryTimers.set(key, timer);
	return true;
}

async function runUnansweredTurnRecovery(io, caseId) {
	unansweredTurnRecoveryTimers.delete(caseId);
	const latestCase = await getSupportCaseById(caseId);
	if (!latestGuestNeedsAiReply(latestCase)) {
		unansweredTurnRecoveryAttempts.delete(caseId);
		return false;
	}
	const policy = await ensureAIAllowed(latestCase.hotelId, latestCase);
	if (!policy.allowed) {
		logStep(caseId, "turn_recovery.skip", { reason: policy.reason });
		return false;
	}
	const attempts = Number(unansweredTurnRecoveryAttempts.get(caseId) || 0) + 1;
	unansweredTurnRecoveryAttempts.set(caseId, attempts);
	const activeState = memo.get(caseId);
	if (activeState?.turnInFlight) {
		const lockedAt = Number(activePlanLockAts.get(caseId) || 0);
		const lockAgeMs = lockedAt ? now() - lockedAt : 0;
		const shouldForceRelease =
			lockAgeMs >= AI_TURN_STALL_RECOVERY_MS || attempts >= 2;
		if (!shouldForceRelease) {
			const retryDelayMs = lockedAt
				? Math.max(1000, AI_TURN_STALL_RECOVERY_MS - lockAgeMs)
				: AI_TURN_STALL_RECOVERY_MS;
			logStep(caseId, "turn_recovery.defer", {
				attempts,
				reason: "turn_in_flight",
				lockAgeMs,
				retryDelayMs,
			});
			scheduleUnansweredTurnRecovery(io, caseId, retryDelayMs);
			return false;
		}
		logStep(caseId, "turn_recovery.force_release", {
			attempts,
			lockAgeMs,
			waitFor: activeState.waitFor || null,
		});
		activeState.interrupt = true;
		activeState.turnInFlight = false;
		activeState.turnOwner = null;
		activeState.queue = [];
		activeState.sendingToken = "";
		activePlanLocks.delete(caseId);
		activePlanLockAts.delete(caseId);
	}
	logStep(caseId, "turn_recovery.run", { attempts });
	await planTurn(io, latestCase);
	const afterCase = await getSupportCaseById(caseId);
	if (attempts < 3 && latestGuestNeedsAiReply(afterCase)) {
		scheduleUnansweredTurnRecovery(io, caseId, AI_TURN_STALL_RECOVERY_MS);
	} else if (!latestGuestNeedsAiReply(afterCase)) {
		unansweredTurnRecoveryAttempts.delete(caseId);
	}
	return true;
}

function schedulePlanTurn(io, caseOrId, { delayMs = 75 } = {}) {
	const caseId = idText(caseOrId);
	if (!io || !caseId) return false;
	const existing = scheduledTurns.get(caseId);
	if (existing) clearTimeout(existing);
	const timer = setTimeout(async () => {
		scheduledTurns.delete(caseId);
		try {
			const latestCase = await getSupportCaseById(caseId);
			if (latestCase) await planTurn(io, latestCase);
		} catch (error) {
			console.error("[aiagent] scheduled plan error:", error?.message || error);
		}
	}, Math.max(0, Number(delayMs) || 0));
	if (typeof timer.unref === "function") timer.unref();
	scheduledTurns.set(caseId, timer);
	unansweredTurnRecoveryAttempts.set(caseId, 0);
	scheduleUnansweredTurnRecovery(
		io,
		caseId,
		Math.max(AI_TURN_STALL_RECOVERY_MS, Number(delayMs) || 0)
	);
	return true;
}

/* ------------------- socket wiring ------------------- */
function wireSocket(io) {
	io.on("connection", (socket) => {
		socket.on("joinRoom", async ({ caseId }) => {
			try {
				if (!caseId) return;
				socket.join(caseId);
				const sc = await getSupportCaseById(caseId);
				if (!sc) return;

				const policy = await ensureAIAllowed(sc.hotelId, sc);
				if (!policy.allowed) {
					logStep(caseId, "join.policy.skip", { reason: policy.reason });
					return;
				}
				const policyHotel = policy.hotel || (await getHotelById(sc.hotelId));
				const hotel = activeHotelContextForCase(sc, policyHotel);
				const st = ensureState(sc, hotel);
				logStep(caseId, "joined_room", {
					hotelId: sc.hotelId,
					hotelName: st.hotel?.hotelName,
				});

				if (!st.greeted && !st.greetScheduled) {
					schedulePlanTurn(io, caseId, { delayMs: 75 });
				} else if (latestGuestNeedsAiReply(sc) && !st.turnInFlight) {
					schedulePlanTurn(io, caseId, { delayMs: 75 });
					logStep(caseId, "join.schedule_unanswered_turn", {
						waitFor: st.waitFor || null,
					});
				}
			} catch (e) {
				console.error("[aiagent] joinRoom error:", e?.message || e);
			}
		});

		socket.on("typing", ({ caseId }) => {
			markGuestActivity(caseId, { typingHoldMs: AI_GUEST_TYPING_HOLD_MS });
		});

		socket.on("sendMessage", async (message) => {
			try {
				const caseId = String(message?.caseId || "");
				if (!caseId) return;
				markGuestActivity(caseId);
				const st = memo.get(caseId);
				if (st && st.turnInFlight) {
					if (st.queue.length < 1) st.queue.push(now());
					st.interrupt = true;
					logStep(caseId, "turn.enqueue", {
						reason: "in_flight",
						queued: st.queue.length,
					});
					return;
				}
				schedulePlanTurn(io, caseId, { delayMs: 75 });
			} catch (e) {
				console.error("[aiagent] sendMessage plan error:", e?.message || e);
			}
		});
	});

	console.log("[aiagent] socket-driven AI planner active.");
}

module.exports = { wireSocket, schedulePlanTurn };
