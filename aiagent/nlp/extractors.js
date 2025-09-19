/** @format */
const { normalizeDate, betweenISO } = require("../utils/date");

function extractDates(text) {
	// very basic ISO/arabic digits acceptance
	const re = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g;
	const out = [];
	let m;
	while ((m = re.exec(text)))
		out.push(normalizeDate(`${m[1]}-${m[2]}-${m[3]}`));
	if (out.length >= 2) {
		const [a, b] = out;
		return { checkin: betweenISO(a, b)[0], checkout: betweenISO(a, b)[1] };
	}
	return {};
}

function extractPhone(text) {
	const digits = text.replace(/[^\d]/g, "");
	if (digits.length >= 8 && digits.length <= 15) return digits;
	return null;
}

function extractEmail(text) {
	const re = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[A-Za-z]{2,}/;
	const m = text.match(re);
	return m ? m[0] : null;
}

// Nationality ISO2 detection (very light)
function extractNationality(text) {
	// Examples: "I'm Egyptian", "nationality DZ", "Saudi", "Pakistani"
	const map = {
		egypt: "EG",
		egyptian: "EG",
		مصر: "EG",
		saudi: "SA",
		"saudi arabia": "SA",
		سعودي: "SA",
		السعودية: "SA",
		dz: "DZ",
		algeria: "DZ",
		جزائر: "DZ",
		pk: "PK",
		pakistan: "PK",
		in: "IN",
		india: "IN",
		bd: "BD",
		bangladesh: "BD",
		ma: "MA",
		morocco: "MA",
		مغرب: "MA",
		jo: "JO",
		jordan: "JO",
		ae: "AE",
		uae: "AE",
		tr: "TR",
		turkey: "TR",
	};
	const lowered = text.toLowerCase();
	for (const k of Object.keys(map)) {
		if (lowered.includes(k)) return map[k];
	}
	return null;
}

function extractRoomType(text, hotel) {
	const rcd = Array.isArray(hotel?.roomCountDetails)
		? hotel.roomCountDetails
		: [];
	let best = null;
	for (const r of rcd) {
		const hints = [r.roomType, r.displayName]
			.filter(Boolean)
			.map((s) => String(s).toLowerCase());
		if (hints.some((h) => text.toLowerCase().includes(h))) {
			best = { roomType: r.roomType, displayName: r.displayName || "" };
			break;
		}
		// friendly synonyms
		const synonyms = {
			singleRooms: ["single", "فردي", "سنجل"],
			doubleRooms: ["double", "دابل", "ثنائية", "اثنين"],
			twinRooms: ["twin", "توين", "سريرين"],
			tripleRooms: ["triple", "ثلاثية", "ثلاث"],
			quadRooms: ["quad", "رباعية", "أربع"],
		};
		for (const [key, list] of Object.entries(synonyms)) {
			if (list.some((w) => text.toLowerCase().includes(w))) {
				const match = rcd.find((x) => x.roomType === key);
				if (match)
					return {
						roomType: match.roomType,
						displayName: match.displayName || "",
					};
			}
		}
	}
	return best;
}

function applyExtractors(text, state, L) {
	const dates = extractDates(text);
	const phone = extractPhone(text);
	const email = extractEmail(text);
	const nat = extractNationality(text);
	const room = extractRoomType(text, state.hotel);

	return { ...dates, phone, email, nationality: nat, ...room };
}

module.exports = { applyExtractors };
