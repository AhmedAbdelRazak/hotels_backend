/** @format */
// aiagent/core/brain.js
const { listAvailableRoomsForStay, priceRoomForStay } = require("./selectors");

// identity
const EN = [
	"Hana",
	"Aisha",
	"Yasmin",
	"Amira",
	"Sara",
	"Layla",
	"Mariam",
	"Nadia",
];
const FR = ["Hana", "Yasmina", "Aïcha", "Leïla", "Meriem", "Nadia"];
const ES = ["Hana", "Yasmin", "Aicha", "Laila", "Miriam", "Nadia"];
const UR = ["ہنا", "عائشہ", "یاسمین", "مریم", "نادیہ"];
const HI = ["हना", "आइशा", "यास्मीन", "अमीरा", "मरीयम"];

function rand(a) {
	return a[Math.floor(Math.random() * a.length)];
}
function pickFirstName(lang) {
	if (/Arabic/.test(lang)) return "Hana";
	if (lang === "French") return rand(FR);
	if (lang === "Spanish") return rand(ES);
	if (lang === "Urdu") return rand(UR);
	if (lang === "Hindi") return rand(HI);
	return rand(EN);
}

function ensureIdentity(st, sc, hotel) {
	st.languageLabel = st.languageLabel || sc.preferredLanguage || "English";
	st.agentName = st.agentName || pickFirstName(st.languageLabel);
	st.agentEmail = st.agentEmail || "management@xhotelpro.com";
}

function firstNameOf(full = "Guest") {
	return String(full).trim().split(/\s+/)[0] || "Guest";
}

function makeGreeting(st, sc, hotel) {
	const fn = firstNameOf(sc.displayName1 || sc.customerName || "Guest");
	const hotelName =
		hotel?.hotelName && String(hotel.hotelName).trim() ? hotel.hotelName : null;
	const isAr = /Arabic/.test(st.languageLabel);

	if (isAr) {
		return hotelName
			? `السلام عليكم ${fn}. أنا ${st.agentName} من فندق ${hotelName}.`
			: `السلام عليكم ${fn}. أنا ${st.agentName} من جناّت بوكينج.`;
	}
	return hotelName
		? `As-salāmu ʿalaykum, ${fn}. I’m ${st.agentName} from ${hotelName}.`
		: `As-salāmu ʿalaykum, ${fn}. I’m ${st.agentName} from Jannat Booking.`;
}

// pricing + blocked/zero guard
function computeQuote(hotel, ctx) {
	const avail = listAvailableRoomsForStay(
		hotel,
		ctx.checkinISO,
		ctx.checkoutISO
	);
	const chosen = avail.find(
		(r) =>
			String(r.room?.roomType || "").toLowerCase() ===
			String(ctx.roomType || "").toLowerCase()
	);
	if (!chosen) return { available: false, reason: "no_match" };
	if (chosen.blocked)
		return { available: false, reason: "blocked", date: chosen.blockedOn };

	const q = priceRoomForStay(
		hotel,
		chosen.room,
		ctx.checkinISO,
		ctx.checkoutISO
	);
	const badNight =
		Array.isArray(q.perNight) && q.perNight.some((v) => !v || Number(v) <= 0);
	if (
		badNight ||
		!q.totalWithCommission ||
		Number(q.totalWithCommission) <= 0
	) {
		return { available: false, reason: "zero_price" };
	}
	return {
		available: true,
		nights: q.nights,
		currency: (hotel.currency || "sar").toUpperCase(),
		room: {
			roomType: chosen.room.roomType,
			displayName: chosen.room.displayName || chosen.room.roomType,
		},
		perNight: q.perNight,
		totalWithCommission: q.totalWithCommission,
		totalRoot: q.totalRoot,
		commission: q.commission,
	};
}

function formatQuote(ctx, q) {
	const pn = Array.isArray(q.perNight)
		? q.perNight.map((v) => Number(v).toLocaleString()).join(", ")
		: q.perNight;
	return `Great — ${q.room.displayName} for ${
		q.nights
	} night(s).\nPer-night: [${pn}], Total: ${Number(
		q.totalWithCommission
	).toLocaleString()} ${q.currency}.\nWould you like to proceed?`;
}

module.exports = {
	ensureIdentity,
	makeGreeting,
	computeQuote,
	formatQuote,
	firstNameOf,
};
