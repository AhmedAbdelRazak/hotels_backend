// aiagent/core/orchestrator.js
const {
	getSupportCaseById,
	updateSupportCaseAppend,
	getHotelById,
} = require("./db");

const {
	listAvailableRoomsForStay,
	priceRoomForStay,
	roomHasAmenity,
	hotelHasAmenity,
	findAmenityMatch,
} = require("./selectors");

const {
	nluStep,
	firstNameOf,
	validateNationalityLLM,
	normalizeNameLLM,
	asciiize,
	digitsToEnglish,
	detectAmenityQuestion,
} = require("./nlu");

const { chat } = require("./openai");
const { createReservationForCase, postReservationLinks } = require("./actions");

const AGENT_POOL = ["Hana", "Aisha", "Sara", "Amira", "Yasmin", "Nadia"];

const HUMAN = {
	greetThinkMs: 5000,
	thinkMinMs: 2000,
	thinkMaxMs: 2600,
	typeCharMinMs: 48,
	typeCharMaxMs: 60,
	typeClampMinMs: 2200,
	typeClampMaxMs: 7000,
	betweenSendsMinMs: 1700,
	betweenSendsMaxMs: 2200,
};

const SOFT_PIVOT_MS = 35000;
const QUOTE_SUMMARY_COOLDOWN = 45000;

function randomBetween(a, b) {
	return Math.floor(a + Math.random() * (b - a + 1));
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
function usDate(iso) {
	if (!iso) return "";
	const d = new Date(iso + "T00:00:00");
	return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(
		d.getDate()
	).padStart(2, "0")}/${d.getFullYear()}`;
}

function logStep(caseId, message, payload = {}) {
	console.log(`[aiagent] case=${caseId} ${message}`, payload);
}
async function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}
async function humanPause() {
	await sleep(randomBetween(HUMAN.betweenSendsMinMs, HUMAN.betweenSendsMaxMs));
}

const memo = new Map();

/* per case state incl. queue & preemption */
function ensureState(sc, hotel) {
	const id = String(sc._id);
	let st = memo.get(id);
	if (!st) {
		st = {
			hotel,
			agentName: AGENT_POOL[Math.floor(Math.random() * AGENT_POOL.length)],
			language: sc.preferredLanguage || "English",
			greeted: false,
			greetScheduled: false,
			guestTypingUntil: 0,
			turnInFlight: false,
			interrupt: false,
			queue: [],
			sendingToken: null,
			waitFor: null, // 'intentConfirm' -> 'dates' -> 'room' -> 'proceed' -> 'reviewConfirm' -> 'fullname' -> 'nationality' -> 'phone' -> 'email_or_skip' -> 'finalize'
			lastBotText: "",
			lastAskAt: {},
			quote: null,
			reviewSent: false,
			quoteSummarizedAt: 0,
			dateRaw: { calendar: null, checkin: null, checkout: null },
			smalltalkThread: { topic: null, waitingForGuest: false, lastAt: 0 },
			slots: {
				checkinISO: null,
				checkoutISO: null,
				roomTypeKey: null,
				name: firstNameOf(sc.displayName1 || sc.customerName || "Guest"),
				fullName: null,
				nationality: null,
				phone: null,
				email: null,
				rooms: 1,
			},
		};
		memo.set(id, st);
	} else {
		if (hotel) st.hotel = hotel;
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

/* --------- humanSend with pre‑emption (cancellable) --------- */
async function humanSend(io, sc, st, text, { first = false } = {}) {
	if (!text) return;
	const caseId = String(sc._id || sc.id || "unknown");

	const token = Math.random().toString(36).slice(2);
	st.sendingToken = token;
	st.interrupt = false;

	const think = first
		? HUMAN.greetThinkMs
		: randomBetween(HUMAN.thinkMinMs, HUMAN.thinkMaxMs);
	logStep(caseId, "human.delay.think", { ms: think, first });
	for (let t = 0; t < think; t += 150) {
		if (st.interrupt || st.sendingToken !== token) {
			logStep(caseId, "human.cancelled", { stage: "think", token });
			return;
		}
		while (st.guestTypingUntil > now()) await sleep(300);
		await sleep(150);
	}

	const charMs = randomBetween(HUMAN.typeCharMinMs, HUMAN.typeCharMaxMs);
	let typeMs = Math.min(
		HUMAN.typeClampMaxMs,
		Math.max(HUMAN.typeClampMinMs, (text || "").length * charMs)
	);
	logStep(caseId, "human.delay.type", {
		chars: (text || "").length,
		charMs,
		typeMs,
	});
	while (st.guestTypingUntil > now()) await sleep(300);
	emitTyping(io, caseId, st, true);
	for (let t = 0; t < typeMs; t += 120) {
		if (st.interrupt || st.sendingToken !== token) {
			emitTyping(io, caseId, st, false);
			logStep(caseId, "human.cancelled", { stage: "typing", token });
			return;
		}
		await sleep(120);
	}
	emitTyping(io, caseId, st, false);
	if (st.interrupt || st.sendingToken !== token) {
		logStep(caseId, "human.cancelled", { stage: "post-type", token });
		return;
	}

	if (st.lastBotText && st.lastBotText.trim() === String(text).trim()) {
		logStep(caseId, "dedupe.skip", { reason: "same_as_last" });
		return;
	}

	const messageData = {
		messageBy: {
			customerName: st.agentName,
			customerEmail: "management@xhotelpro.com",
		},
		message: text,
		date: new Date(),
		isAi: true,
	};
	await updateSupportCaseAppend(caseId, {
		conversation: messageData,
		aiRelated: true,
	});
	io.to(caseId).emit("receiveMessage", { ...messageData, caseId });

	st.lastBotText = text;
}

/* soft‑pivot memory */
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

function nextPivot(st) {
	if (st.waitFor === "intentConfirm") return "intentConfirm";
	if (!st.slots.checkinISO || !st.slots.checkoutISO) return "dates";
	if (!st.slots.roomTypeKey) return "room";
	if (!st.reviewSent) return "proceed";
	if (!st.slots.fullName) return "fullname";
	if (!st.slots.nationality) return "nationality";
	if (!st.slots.phone) return "phone";
	if (!st.slots.email) return "email_or_skip";
	return "finalize";
}

function lastUserText(sc) {
	const convo = Array.isArray(sc.conversation) ? sc.conversation : [];
	const lastUser = [...convo]
		.reverse()
		.find(
			(m) =>
				m?.message &&
				m?.messageBy &&
				m.messageBy.customerEmail !== "management@xhotelpro.com"
		);
	return lastUser?.message || "";
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

/* LLM writer */
async function write(io, sc, st, instruction, context = {}) {
	const sys = [
		`You are ${st.agentName}, a warm and efficient hotel booking assistant.`,
		`Write in ${st.language}.`,
		`Tone: concise, friendly, human-like. One booking question at a time.`,
		`Use the guest's first name (${st.slots.name}).`,
		st.hotel?.hotelName
			? `Your hotel is "${toTitle(st.hotel.hotelName)}".`
			: `You represent Jannat Booking.`,
		`Avoid repeating the same question if just asked; prefer a soft pivot.`,
	].join(" ");

	const payload = JSON.stringify(context, null, 2);
	const content = `${instruction}\n\nContext JSON:\n${payload}`;

	const answer = await chat(
		[
			{ role: "system", content: sys },
			{ role: "user", content },
		],
		{
			kind: "writer",
			temperature: 0.25,
			max_tokens: 240,
		}
	);

	logStep(String(sc._id), "llm.write", { instruction, outLen: answer.length });
	return answer;
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

	if (subtype === "how_are_you") {
		if (!thread.waitingForGuest || thread.topic !== "howru") {
			const msg = await write(
				io,
				sc,
				st,
				"Say you’re doing well (natural phrasing), then ask “How about you?”. Keep it short; no booking question yet."
			);
			await humanSend(io, sc, st, msg);
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
		const softPivot = askedRecently(st, pivot);
		const instr = softPivot
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
				"Reply briefly to their casual line, then ask for check‑in and check‑out in ONE question."
			);
			await humanSend(io, sc, st, msg);
			stampAsk(st, "dates");
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

/* ------------------- TURN PLANNER ------------------- */
async function planTurn(io, sc) {
	const caseId = String(sc._id);
	const hotel = await getHotelById(sc.hotelId);
	const st = ensureState(sc, hotel);
	if (st.turnInFlight) {
		logStep(caseId, "turn.enqueue", {
			reason: "in_flight",
			queued: st.queue.length + 1,
		});
		st.queue.push(now());
		st.interrupt = true;
		return;
	}
	st.turnInFlight = true;

	try {
		logStep(caseId, "context.loaded", {
			hotelId: sc.hotelId,
			hotelName: st.hotel?.hotelName || null,
			language: st.language,
			waitFor: st.waitFor,
			slots: st.slots,
		});

		// Greeting: greet + intent confirmation FIRST
		if (!st.greeted && !st.greetScheduled) {
			st.greetScheduled = true;
			st.waitFor = "intentConfirm";
			const greetText = await write(
				io,
				sc,
				st,
				`Start: "As‑salāmu ʿalaykum, ${st.slots.name}." Introduce as ${
					st.agentName
				} from ${toTitle(
					st.hotel?.hotelName || "Jannat Booking"
				)}. Then ask: "I see you'd like to make a new reservation — is that correct?" (ONE yes/no).`
			);
			await humanSend(io, sc, st, greetText, { first: true });
			st.greeted = true;
			stampAsk(st, "intentConfirm");
			return;
		}

		// Interpret latest user turn
		const userText = lastUserText(sc);
		const lu = await nluStep({
			sc,
			hotel: st.hotel,
			lastUserMessage: userText,
		});
		logStep(caseId, "nlu", lu);

		// raw dates (for hijri display)
		if (lu?.dates?.raw) {
			if (lu.dates.raw.checkin) st.dateRaw.checkin = lu.dates.raw.checkin;
			if (lu.dates.raw.checkout) st.dateRaw.checkout = lu.dates.raw.checkout;
			if (lu.dates.raw.calendar) st.dateRaw.calendar = lu.dates.raw.calendar;
		}

		// merge slots
		if (lu.dates?.checkinISO) st.slots.checkinISO = lu.dates.checkinISO;
		if (lu.dates?.checkoutISO) st.slots.checkoutISO = lu.dates.checkoutISO;
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

			await humanSend(io, sc, st, ask ? `${line} ${ask}` : line);
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

		// intent confirmation step
		if (st.waitFor === "intentConfirm") {
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
			} else if (/\b(no|nope|not now|later|cancel|لا)\b/i.test(userText)) {
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
		}

		// need room?
		if (!st.slots.roomTypeKey) {
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
			st.waitFor = "room";
			return;
		}

		// pricing
		const qKey = `${st.slots.roomTypeKey}|${st.slots.checkinISO}|${st.slots.checkoutISO}`;
		const reuse =
			st.quote && st.quote.key === qKey && now() - st.quote.at < 120000;
		let quote;
		if (!reuse) {
			quote = priceRoomForStay(
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
			const alternatives = listAvailableRoomsForStay(
				st.hotel,
				st.slots.checkinISO,
				st.slots.checkoutISO
			)
				.filter((r) => r.available)
				.map((r) => ({
					roomType: r.room?.roomType,
					displayName: r.room?.displayName || r.room?.roomType,
					total: r?.totals?.totalPriceWithCommission,
					currency: r.currency,
				}))
				.slice(0, 3);

			if (!askedRecently(st, "alt")) {
				const msg = await write(
					io,
					sc,
					st,
					quote.reason === "blocked"
						? "Explain that this room is blocked (zero price rule) for these dates. Offer up to 3 alternatives with totals."
						: "Explain no priced inventory for these dates; offer up to 3 alternatives with totals.",
					{ alternatives, reason: quote.reason || "no_price" }
				);
				await humanSend(io, sc, st, msg);
				await humanPause();
				const askAlt = await write(
					io,
					sc,
					st,
					"Ask ONE question only: change dates or choose a different room type?"
				);
				await humanSend(io, sc, st, askAlt);
				stampAsk(st, "room");
			}
			st.waitFor = "room";
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
			};
			const quoteMsg = await write(
				io,
				sc,
				st,
				"Share a concise availability & price summary (no upsell). Then ask a single yes/no: proceed to confirm?",
				display
			);
			await humanSend(io, sc, st, quoteMsg);
			st.quoteSummarizedAt = now();
		}
		st.waitFor = "proceed";

		// proceed?
		if (st.waitFor === "proceed") {
			if (
				/\b(yes|yep|yeah|ok|okay|proceed|go ahead|confirm|تمام|نعم|ايه)\b/i.test(
					userText
				)
			) {
				// Review
				const q = st.quote?.data || quote;
				const reviewPayload = {
					hotel: toTitle(st.hotel?.hotelName || "Hotel"),
					room: q.room?.displayName || q.room?.roomType || st.slots.roomTypeKey,
					roomsCount: st.slots.rooms || 1,
					currency: q.currency,
					nights: q.nights,
					totals: q.totals,
					perNightAvg:
						Math.round(
							(q.totals.totalPriceWithCommission / Math.max(1, q.nights)) * 100
						) / 100,
					gregorian: {
						checkin: usDate(st.slots.checkinISO),
						checkout: usDate(st.slots.checkoutISO),
					},
					rawDates: st.dateRaw,
				};
				logStep(caseId, "review.summaryBuilt", reviewPayload);
				const reviewText = await write(
					io,
					sc,
					st,
					"Present a brief 'Review before we finalize'. If raw dates were Hijri, show them alongside Gregorian. End with: 'Type “confirm” to finalize, or tell me what to change.'",
					reviewPayload
				);
				await humanSend(io, sc, st, reviewText);
				st.reviewSent = true;
				st.waitFor = "reviewConfirm";
				return;
			} else if (/\b(no|nope|not now|later|cancel|لا)\b/i.test(userText)) {
				const msg = await write(
					io,
					sc,
					st,
					"Acknowledge politely and offer to notify when availability changes, or help with other dates."
				);
				await humanSend(io, sc, st, msg);
				return;
			} else {
				if (!askedRecently(st, "proceed")) {
					const poke = await write(
						io,
						sc,
						st,
						"Ask a single yes/no: would you like to proceed to confirm?"
					);
					await humanSend(io, sc, st, poke);
					stampAsk(st, "proceed");
				}
				return;
			}
		}

		// After review: collect details (full name → nationality → phone → email)
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
				"Ask ONE question: 'Is the reservation under your full name (as in passport)? If yes, please type your full name in English. If for someone else, share their full name in English.'"
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
				"Ask ONE question: 'What is the guest's nationality?' (English name)."
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
				"Ask ONE question for a phone number (WhatsApp preferred, but not mandatory)."
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

		if (st.waitFor === "email_or_skip" && !st.slots.email) {
			const askEmail = await write(
				io,
				sc,
				st,
				"Ask ONE question for an email address (do NOT say optional). If they resist, accept continuing without email."
			);
			await humanSend(io, sc, st, askEmail);
			return;
		}
		if (!st.slots.email && st.waitFor === "email_or_skip") {
			const txt = String(userText).trim();
			if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(txt)) {
				st.slots.email = txt;
				logStep(caseId, "email.captured", { email: st.slots.email });
			} else if (/\b(no|skip|don'?t have|later)\b/i.test(txt)) {
				st.slots.email = null;
			} else {
				const ask = await write(
					io,
					sc,
					st,
					"If that doesn't look like an email, ask once more briefly; accept 'skip' if they prefer."
				);
				await humanSend(io, sc, st, ask);
				return;
			}
			st.waitFor = "finalize";
		}

		// finalize: create reservation (full name saved; first name only used in chat)
		if (st.waitFor === "finalize") {
			const q = st.quote?.data;
			const creation = await createReservationForCase({
				sc,
				hotel: st.hotel,
				quote: q,
				slots: {
					checkinISO: st.slots.checkinISO,
					checkoutISO: st.slots.checkoutISO,
					roomTypeKey: st.slots.roomTypeKey,
					fullName: st.slots.fullName,
					phone: st.slots.phone,
					email: st.slots.email,
					nationality: st.slots.nationality,
				},
			});

			logStep(caseId, "reservation.created", {
				reservationId: creation?._id,
				confirmation: creation?.confirmation_number,
			});

			const summary = await write(
				io,
				sc,
				st,
				"Confirm creation in one concise sentence including hotel name and dates. Do not add links here."
			);
			await humanSend(io, sc, st, summary);
			await humanPause();

			await postReservationLinks(io, sc, creation, st.agentName);
			return;
		}
	} catch (e) {
		logStep(caseId, "error", { message: e?.message || e });
	} finally {
		const st2 = memo.get(caseId);
		if (st2) {
			st2.turnInFlight = false;
			if (st2.queue.length > 0) {
				st2.queue = [];
				logStep(caseId, "turn.consume_queue", {});
				getSupportCaseById(caseId)
					.then((sc2) => sc2 && planTurn(io, sc2))
					.catch(() => {});
			}
		}
	}
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

				const hotel = await getHotelById(sc.hotelId);
				const st = ensureState(sc, hotel);
				logStep(caseId, "joined_room", {
					hotelId: sc.hotelId,
					hotelName: st.hotel?.hotelName,
				});

				if (!st.greeted && !st.greetScheduled) planTurn(io, sc);
			} catch (e) {
				console.error("[aiagent] joinRoom error:", e?.message || e);
			}
		});

		socket.on("typing", ({ caseId }) => {
			const st = memo.get(String(caseId));
			if (st) st.guestTypingUntil = now() + 1500;
		});

		socket.on("sendMessage", async (message) => {
			try {
				const caseId = String(message?.caseId || "");
				if (!caseId) return;
				const st = memo.get(caseId);
				if (st && st.turnInFlight) {
					st.queue.push(now());
					st.interrupt = true;
					logStep(caseId, "turn.enqueue", {
						reason: "in_flight",
						queued: st.queue.length,
					});
					return;
				}
				const sc = await getSupportCaseById(caseId);
				if (!sc) return;
				await planTurn(io, sc);
			} catch (e) {
				console.error("[aiagent] sendMessage plan error:", e?.message || e);
			}
		});
	});

	console.log("[aiagent] socket-driven AI planner active.");
}

module.exports = { wireSocket };
