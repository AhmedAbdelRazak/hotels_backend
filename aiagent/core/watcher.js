/** @format */
// aiagent/core/watcher.js
const {
	getSupportCaseById,
	getHotelById,
	appendConversation,
	getReservationByConfirmation,
} = require("./db");
const { ensureAIAllowed } = require("./policy");
const { getOrCreateCaseState } = require("./state");
const { absorbNlu, isISODate, isPast } = require("./nlu");
const { planNext, sampleDisplayNames } = require("./planner");
const {
	ensureIdentity,
	makeGreeting,
	computeQuote,
	formatQuote,
} = require("./brain");
const {
	sendAiText,
	waitForSilence,
	createReservationForCase,
	pushReservationLinks,
	closeCasePolitely,
} = require("./actions");
const { validateNationalityLLM, bestRoomTypeMatch } = require("./validators");

function containsFarewell(text) {
	return /\b(bye|goodbye|see you|no thank you|no thanks|that's all|that is all|i'm done|not interested|cancel|later)\b/i.test(
		text || ""
	);
}

async function scheduleGreeting(io, caseId) {
	const st = getOrCreateCaseState(caseId);
	if (st.greeted) return;

	try {
		const sc = await getSupportCaseById(caseId);
		if (!sc) return;
		let { allowed, hotel } = await ensureAIAllowed(sc.hotelId);
		if (!hotel) hotel = await getHotelById(sc.hotelId); // always fetch full hotel for name

		ensureIdentity(st, sc, hotel);

		// Seed intent/slots from inquiryDetails
		if (sc.inquiryDetails)
			await absorbNlu(st, sc.inquiryDetails, sc.preferredLanguage || "English");
		if (!st.ctx.intent && sc.inquiryAbout) st.ctx.intent = "new_reservation";

		clearTimeout(st.greetTimer);
		st.greetTimer = setTimeout(async () => {
			await waitForSilence(st);
			const greet = makeGreeting(st, sc, hotel);
			await sendAiText(io, caseId, st, greet, st.languageLabel, {
				minDelayMs: 500,
			});

			if (
				(st.ctx.intent || sc.inquiryAbout) === "new_reservation" ||
				sc.inquiryAbout === "reserve_room"
			) {
				await sendAiText(
					io,
					caseId,
					st,
					"I understand you’d like a new reservation. Please share your check‑in and check‑out dates.",
					st.languageLabel,
					{ minDelayMs: 600 }
				);
				st.awaiting = "ask_dates";
			} else if (st.ctx.intent === "reservation_inquiry") {
				await sendAiText(
					io,
					caseId,
					st,
					"I understand this is about an existing reservation. Please share your confirmation number.",
					st.languageLabel,
					{ minDelayMs: 600 }
				);
				st.awaiting = "clarify";
			} else {
				await sendAiText(
					io,
					caseId,
					st,
					"How may I help you today?",
					st.languageLabel,
					{ minDelayMs: 600 }
				);
				st.awaiting = "clarify";
			}

			st.greeted = true;
		}, 5000);
	} catch (e) {
		console.error("[aiagent] scheduleGreeting error:", e?.message || e);
	}
}

async function scheduleReply(io, caseId, lastUserMsg) {
	const st = getOrCreateCaseState(caseId);
	if (st.inFlight) return;
	st.inFlight = true;

	try {
		const sc = await getSupportCaseById(caseId);
		if (!sc) return;
		let { allowed, hotel } = await ensureAIAllowed(sc.hotelId);
		if (!hotel) hotel = await getHotelById(sc.hotelId);
		ensureIdentity(st, sc, hotel);

		const userText = String(lastUserMsg?.message || "");
		const caseConvo = Array.isArray(sc.conversation) ? sc.conversation : [];

		if (containsFarewell(userText)) {
			await closeCasePolitely(io, sc, st);
			st.inFlight = false;
			return;
		}

		// NLU update (multi‑lang + Hijri aware)
		if (userText) await absorbNlu(st, userText, st.languageLabel);

		// If guest provided a confirmation, fetch once
		if (st.ctx.confirmation && !st.ctx.reservation) {
			try {
				const r = await getReservationByConfirmation(st.ctx.confirmation);
				if (r) st.ctx.reservation = r;
			} catch {}
		}

		// Map free-text room names to roomType keys if possible
		if (st.ctx.roomType && hotel) {
			const maybeKey = bestRoomTypeMatch(hotel, st.ctx.roomType);
			if (maybeKey) st.ctx.roomType = maybeKey;
		}

		// Guard: past dates
		if (st.ctx.checkinISO && st.ctx.checkoutISO) {
			if (isPast(st.ctx.checkoutISO)) {
				await sendAiText(
					io,
					caseId,
					st,
					"Those dates appear to be in the past. Could you share a future check‑in and check‑out date?",
					st.languageLabel
				);
				st.awaiting = "ask_dates";
				st.inFlight = false;
				return;
			}
		}

		// Ask the planner
		const plan = await planNext({
			st,
			sc,
			hotel,
			conversation: caseConvo,
			userText,
		});
		const patch = plan?.ctx_patch || {};
		for (const k of Object.keys(patch)) {
			if (k === "roomType" && !st.ctx.roomType && patch[k])
				st.ctx.roomType = patch[k];
			else if (k === "checkinISO" && !st.ctx.checkinISO && patch[k])
				st.ctx.checkinISO = patch[k];
			else if (k === "checkoutISO" && !st.ctx.checkoutISO && patch[k])
				st.ctx.checkoutISO = patch[k];
			else if (k === "customerName" && !st.ctx.customerName && patch[k])
				st.ctx.customerName = patch[k];
			else if (k === "nationality" && !st.ctx.nationality && patch[k])
				st.ctx.nationality = patch[k];
			else if (k === "phone" && !st.ctx.phone && patch[k])
				st.ctx.phone = patch[k];
			else if (k === "email" && !st.ctx.email && patch[k])
				st.ctx.email = patch[k];
		}

		let next = plan?.next_action || "clarify";
		let text = String(plan?.response || "").trim();

		// Flow guards
		if (!st.ctx.checkinISO || !st.ctx.checkoutISO) next = "ask_dates";
		else if (!st.ctx.roomType && next === "quote") next = "ask_room_type";

		// Frequently asked: "what room types do you have?"
		if (
			/what.*room.*type|types.*have|room options/i.test(userText) &&
			(!st.ctx.roomType || next === "answer_room_types")
		) {
			const ex = sampleDisplayNames(hotel);
			const suffix = ex.length
				? `Here are a few options: ${ex.join(" / ")}. Which would you like?`
				: "Which room type would you like?";
			text = suffix;
			next = "ask_room_type";
		}

		// Quote when ready
		if (next === "quote") {
			const q = computeQuote(hotel, st.ctx);
			if (!q.available) {
				if (q.reason === "blocked")
					text =
						"Those dates are blocked or unavailable for the selected room. Would you like to try different dates or a different room type?";
				else
					text =
						"I’m not seeing any priced inventory for those dates. Would you like to adjust the dates or room type?";
			} else {
				st.ctx.quote = q;
				text = formatQuote(st.ctx, q);
				st.awaiting = "ask_confirm_proceed";
				await sendAiText(io, caseId, st, text, st.languageLabel); // send quote
				st.inFlight = false;
				return;
			}
		}

		// Before moving beyond nationality, validate it if present
		if (
			(next === "ask_phone" ||
				next === "ask_email" ||
				next === "final_summary" ||
				next === "create_reservation") &&
			st.ctx.nationality &&
			!st.ctx.nationalityValid
		) {
			const val = await validateNationalityLLM(
				st.ctx.nationality,
				st.languageLabel
			);
			if (!val.valid || !val.normalized) {
				await sendAiText(
					io,
					caseId,
					st,
					`I couldn’t find the nationality “${st.ctx.nationality}” in our system. Could you re‑type your nationality (e.g., Egyptian, Saudi, Pakistani)?`,
					st.languageLabel
				);
				st.awaiting = "ask_nationality";
				st.inFlight = false;
				return;
			}
			st.ctx.nationality = val.normalized;
			st.ctx.nationalityValid = true;
		}

		// Create reservation
		if (next === "create_reservation") {
			await sendAiText(io, caseId, st, "Confirming now…", st.languageLabel);
			const res = await createReservationForCase({ sc, st, hotel });
			if (res?.ok) {
				await pushReservationLinks(io, caseId, st, {
					reservationId: res.reservationId,
					confirmation: res.confirmation,
				});
			} else {
				await sendAiText(
					io,
					caseId,
					st,
					"I couldn’t finalize this automatically. A colleague will follow up shortly.",
					st.languageLabel
				);
			}
			st.inFlight = false;
			return;
		}

		// Smalltalk: brief → pivot
		if (
			next === "smalltalk_ack_and_ask_next" ||
			st.ctx.intent === "smalltalk"
		) {
			if (!st.ctx.checkinISO || !st.ctx.checkoutISO) {
				text =
					"Alhamdulillah, I’m well — how are you? When would you like to check in and check out?";
				st.awaiting = "ask_dates";
			} else if (!st.ctx.roomType) {
				const ex = sampleDisplayNames(hotel);
				const suffix = ex.length
					? `Which room type suits you best? For example: ${ex.join(" / ")}.`
					: "Which room type suits you best?";
				text = `Alhamdulillah, thanks for asking. ${suffix}`;
				st.awaiting = "ask_room_type";
			}
		}

		await sendAiText(
			io,
			caseId,
			st,
			text || "Could you please clarify?",
			st.languageLabel
		);
	} catch (e) {
		console.error("[aiagent] scheduleReply error:", e?.message || e);
	} finally {
		st.inFlight = false;
	}
}

function attachCaseWatcher(_io) {
	console.log("[aiagent] socket-driven AI planner active.");
}

module.exports = { attachCaseWatcher, scheduleGreeting, scheduleReply };
