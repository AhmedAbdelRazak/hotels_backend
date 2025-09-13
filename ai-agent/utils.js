// ai-agent/utils.js

function inferLanguage(userText, preferredLanguage = "en") {
	const t = (userText || "").toLowerCase();
	if (/arabic|عربي/.test(t)) return "ar";
	if (/spanish|español/.test(t)) return "es";
	if (/french|français/.test(t)) return "fr";
	if (/english|inglés|anglais/.test(t)) return "en";
	if (/urdu|اردو|pakistani/.test(t)) return "ur";
	if (/hindi|हिन्दी|indian/.test(t)) return "hi";
	return preferredLanguage || "en";
}

/** ---------- Incompleteness / multi‑question detection ---------- */
function looksIncomplete(text = "") {
	const s = String(text || "").trim();
	if (!s) return false;
	const endsWithDangling =
		/\.\.\.$/.test(s) ||
		/(?:[,،\-–—/&]|(?:\b(?:and|or|و|او|y|o|yaani)\b))\s*$/i.test(s) ||
		/[\(\[\{]$/.test(s);
	return endsWithDangling;
}
function countQuestions(text = "") {
	const m = String(text || "").match(/[?؟]/g);
	return m ? m.length : 0;
}

/** ---------- Dialect detectors ---------- */
function detectArabicDialect(text = "") {
	const t = String(text).toLowerCase();
	if (/[اأإآ]زيك|عامل ايه|بلاش|قوي|دلوقتي|تمام|مافيش|حاضر/.test(t))
		return "Egyptian";
	if (/وش|تبي|مرة|عساك|السالفة|يا رجال|زود/.test(t)) return "Gulf";
	if (/شو|قديش|لو سمحت|ليش|هلق|بدنا|تمام/.test(t)) return "Levant";
	if (/برشة|بزاف|باهي|شنوّة|يعطيك الصحة|مزّية|صباحو/.test(t)) return "Maghrebi";
	return "MSA";
}
function detectSpanishDialect(text = "") {
	const t = String(text).toLowerCase();
	if (/órale|wey|ande|mande|chido|qué onda|ahorita/.test(t)) return "Mexico";
	if (/vale|tío|vosotros|curro|colega|piso/.test(t)) return "Spain";
	if (/che|boludo|re|vos\s|laburo|quilombo/.test(t)) return "Argentina";
	if (/parce|chévere|gonorrea|qué nota|bacano/.test(t)) return "Colombia";
	if (/plata|pues|ya pues|cause|pe/.test(t)) return "Andes";
	if (/dale|mano|qué bolá|asere/.test(t)) return "Caribbean";
	return "Neutral";
}
function detectIndianRegister(text = "") {
	const raw = String(text || "");
	if (/[؀-ۿ]/.test(raw)) return "Urdu";
	if (/[ऀ-ॿ]/.test(raw)) return "Hindi";
	const t = raw.toLowerCase();
	if (
		/\byaar|acha|kal|thoda|bas|arey|arre|haan|nahi|prepone|kindly revert|do the needful|whatsapp me\b/.test(
			t
		)
	)
		return "Hinglish";
	return "Indian-English";
}

/** ---------- Micro‑intent detectors ---------- */
function isWaitingAck(text = "") {
	const t = String(text || "")
		.toLowerCase()
		.trim();
	return (
		/\b(wait|waiting|hold on|one sec|one second|give me a minute|ok i will wait|i'll wait|i will wait)\b/.test(
			t
		) ||
		/(بنتظر|منتظر|سأنتظر|رح استنى|باستنى|ثواني|لحظة)/.test(t) ||
		/\b(espero|esperando|ok espero|aguardo|aguardando)\b/.test(t) ||
		/\b(rok|ruk|ruko|intezar|intazar|wait kar|thoda ruk)\b/.test(t)
	);
}
function isThanksOnly(text = "") {
	const t = String(text || "")
		.toLowerCase()
		.trim();
	return (
		(/\b(thanks|thank you|appreciate it|awesome|great|perfect|ok thanks|ok thank you|cheers|cool)\b/.test(
			t
		) ||
			/(شكرا|شكرًا|يسلمو|ممتاز|تمام)/.test(t) ||
			/\b(gracias|mil gracias|perfecto|genial|ok gracias)\b/.test(t) ||
			/\b(shukria|shukriya|dhanyavad|thanks ji|theek hai|badiya)\b/.test(t)) &&
		!/[?؟]/.test(t)
	);
}
function isFrustration(text = "") {
	const t = String(text || "").toLowerCase();
	return (
		/\b(frustrating|annoying|why are you repeating|stop repeating|omg|ugh)\b/.test(
			t
		) ||
		/(مزعج|ليه بتكرر|ليه بتعيد|يا ريت تبطل تكرار| OMG )/.test(t) ||
		/\b(pesado|qué fastidio|me estás repitiendo)\b/.test(t)
	);
}
function isGoodbyeOrWrapUp(text = "") {
	const t = String(text || "")
		.toLowerCase()
		.trim();
	return (
		/\b(that's all|that is all|no more|bye|goodbye|talk later|done|all set|we're good)\b/.test(
			t
		) ||
		/(خلص|تم|مافي شي تاني|مع السلامة|سلام)/.test(t) ||
		/\b(listo|eso es todo|ya está|chau|adiós)\b/.test(t) ||
		/\b(bas|ho gaya|theek hai bas|chalo bye)\b/.test(t)
	);
}

/** ---------- Booking confirmation (must include booking verb) ---------- */
function isAffirmativeBooking(text = "") {
	const t = String(text || "").toLowerCase();
	const patterns = [
		// English
		/\b(book|reserve|proceed|go ahead and book|make the booking|confirm the booking|place the reservation)\b/,
		// Arabic
		/(احجز|أحجز|إحجز|ثبّت|أكد الحجز|أبغى أحجز|ابي احجز|ارغب بالحجز|خلّص الحجز)/,
		// Spanish
		/\b(reserva(r|lo)?|haz la reserva|proced(e|er)|confirmar la reserva|adelante con la reserva)\b/,
		// Urdu/Hindi/Hinglish
		/\b(book kar(do| dijiye)?|reserve kar(do| dijiye)?|proceed kar(do| dijiye)?|booking confirm( kar)?\b)/,
	];
	return patterns.some((re) => re.test(t));
}

/** ---------- Output shaping ---------- */
function splitForTwoMessages(text = "", forceTwo = false, maxChars = 900) {
	const s = String(text || "").trim();
	if (!s) return [];
	if (!forceTwo && s.length <= maxChars) return [s];

	const byPara = s
		.split(/\n{2,}/)
		.map((x) => x.trim())
		.filter(Boolean);
	if (byPara.length >= 2) {
		const first = byPara[0];
		const rest = byPara.slice(1).join("\n\n");
		if (first.length <= maxChars) return [first, rest];
	}

	const parts = s.split(/(?<=[\.\?\!؟])\s+/).filter(Boolean);
	if (parts.length <= 1) return [s];
	const out = [];
	let cur = "";
	for (const p of parts) {
		if ((cur + " " + p).trim().length > maxChars && cur) {
			out.push(cur.trim());
			cur = p;
		} else {
			cur = (cur ? cur + " " : "") + p;
		}
	}
	if (cur) out.push(cur.trim());
	return forceTwo && out.length > 2 ? [out[0], out.slice(1).join(" ")] : out;
}

/** Remove any accidental commission mentions */
function stripCommissionMentions(text = "") {
	let s = String(text || "");
	s = s.replace(/\bcommission(s)?\b/gi, "fees");
	s = s.replace(/عمولة|العمولة/gi, "الرسوم");
	s = s.replace(/\bcomisión(es)?\b/gi, "tasas");
	return s;
}

module.exports = {
	inferLanguage,
	looksIncomplete,
	countQuestions,
	detectArabicDialect,
	detectSpanishDialect,
	detectIndianRegister,
	isAffirmativeBooking,
	isWaitingAck,
	isThanksOnly,
	isFrustration,
	isGoodbyeOrWrapUp,
	splitForTwoMessages,
	stripCommissionMentions,
};
