const {
	getSupportCaseById,
	updateSupportCaseAppendIfNoRecentAiDuplicate,
	updateSupportCaseAiStateSnapshot,
	getHotelByIdWithPricingDates,
	getJanatAiSettings,
} = require("../core/db");
const { priceRoomForStay, listAvailableRoomsForStay } = require("../core/selectors");
const {
	isJannatBookingSupportCase,
} = require("../../services/jannatBookingSupportScope");
const { planJannatTurn } = require("./brain");
const {
	configuredMarketingHotelIds,
	configuredJannatSupportName,
	pickHotelReceptionName,
	jannatHandoffDelayMs,
	normalizeId,
} = require("./config");

const SUPPORT_EMAIL = "support@jannatbooking.com";
const DIRECT_BOOKING_DISCOUNT_RATE = 0.25;
const DIRECT_BOOKING_DISCOUNT_FACTOR = 1 - DIRECT_BOOKING_DISCOUNT_RATE;
const cleanString = (value = "", max = 1000) =>
	String(value || "")
		.replace(/\u0000/g, "")
		.trim()
		.slice(0, max);

const caseIdText = (value = "") => String(value?._id || value || "").trim();

const languageCodeFromCase = (supportCase = {}, facts = {}) =>
	cleanString(facts.languageCode || supportCase.preferredLanguageCode || "en", 20)
		.toLowerCase()
		.split(/\s+/)[0] || "en";

const isArabicCase = (supportCase = {}, facts = {}) =>
	/^ar\b/i.test(languageCodeFromCase(supportCase, facts));

function formatNumber(value, languageCode = "en") {
	const locale = /^ar\b/i.test(languageCode) ? "ar-EG" : "en-US";
	return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(
		Number(value || 0)
	);
}

function formatMoney(value = 0, currency = "SAR", languageCode = "en") {
	const amount = formatNumber(value, languageCode);
	return /^ar\b/i.test(languageCode)
		? `${amount} \u0631\u064a\u0627\u0644 \u0633\u0639\u0648\u062f\u064a`
		: `${amount} ${currency || "SAR"}`;
}

function formatDate(iso = "", languageCode = "en") {
	const date = new Date(`${validISODate(iso)}T00:00:00.000Z`);
	if (Number.isNaN(date.getTime())) return iso;
	const locale = /^ar\b/i.test(languageCode) ? "ar-EG" : "en-US";
	return new Intl.DateTimeFormat(locale, {
		day: "numeric",
		month: "long",
		year: "numeric",
		timeZone: "UTC",
	}).format(date);
}

function escapePriceMarkup(value = "") {
	return String(value || "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function originalAmountBeforeDirectDiscount(discountedValue = 0) {
	const discounted = Number(discountedValue || 0);
	if (!Number.isFinite(discounted) || discounted <= 0) return 0;
	return Number((discounted / DIRECT_BOOKING_DISCOUNT_FACTOR).toFixed(2));
}

function directBookingDiscountText(languageCode = "en") {
	const percent = formatNumber(DIRECT_BOOKING_DISCOUNT_RATE * 100, languageCode);
	return /^ar\b/i.test(languageCode)
		? `\u062e\u0635\u0645 ${percent}\u066a \u0644\u0644\u062d\u062c\u0632 \u0627\u0644\u0645\u0628\u0627\u0634\u0631`
		: `${percent}% direct-booking discount`;
}

function discountedPriceInline(value = 0, currency = "SAR", languageCode = "en") {
	const discounted = Number(value || 0);
	if (!Number.isFinite(discounted) || discounted <= 0) {
		return formatMoney(value, currency, languageCode);
	}
	const original = originalAmountBeforeDirectDiscount(discounted);
	return [
		`<s class="message-price-old">${escapePriceMarkup(
			formatMoney(original, currency, languageCode)
		)}</s>`,
		`<strong class="message-price-new">${escapePriceMarkup(
			formatMoney(discounted, currency, languageCode)
		)}</strong>`,
		`<span class="message-price-badge">${escapePriceMarkup(
			directBookingDiscountText(languageCode)
		)}</span>`,
	].join(" ");
}

function discountedPriceLine(label = "", value = 0, currency = "SAR", languageCode = "en") {
	return `${label}: ${discountedPriceInline(value, currency, languageCode)}`;
}

function validISODate(value = "") {
	const text = String(value || "").slice(0, 10);
	if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return "";
	const date = new Date(`${text}T00:00:00.000Z`);
	if (Number.isNaN(date.getTime())) return "";
	return date.toISOString().slice(0, 10);
}

function addDaysISO(iso = "", days = 0) {
	const date = new Date(`${iso}T00:00:00.000Z`);
	if (Number.isNaN(date.getTime())) return "";
	date.setUTCDate(date.getUTCDate() + Number(days || 0));
	return date.toISOString().slice(0, 10);
}

function hotelBusinessTimezone(hotel = {}) {
	return cleanString(
		hotel.timezone || hotel.timeZone || hotel.hotelTimezone || process.env.HOTEL_BOOKING_TIMEZONE,
		80
	) || "Asia/Riyadh";
}

function businessTodayISO(hotel = {}) {
	try {
		const parts = new Intl.DateTimeFormat("en-CA", {
			timeZone: hotelBusinessTimezone(hotel),
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
		}).formatToParts(new Date());
		const get = (type) => parts.find((part) => part.type === type)?.value || "";
		const year = get("year");
		const month = get("month");
		const day = get("day");
		if (year && month && day) return `${year}-${month}-${day}`;
	} catch {
		// Fall through to UTC if the configured timezone is invalid.
	}
	return new Date().toISOString().slice(0, 10);
}

function invalidStayRangeReason(facts = {}, hotel = {}) {
	const checkinISO = validISODate(facts.checkinISO);
	const checkoutISO = validISODate(facts.checkoutISO);
	if (!checkinISO && !checkoutISO) return "";
	if (checkinISO && checkoutISO && checkoutISO <= checkinISO) return "bad_range";
	if (checkinISO && checkinISO <= businessTodayISO(hotel)) return "same_day_or_past";
	return "";
}

function eachStayDate(checkinISO = "", checkoutISO = "") {
	const start = validISODate(checkinISO);
	const end = validISODate(checkoutISO);
	if (!start || !end || start >= end) return [];
	const dates = [];
	let cursor = start;
	while (cursor < end && dates.length < 60) {
		dates.push(cursor);
		cursor = addDaysISO(cursor, 1);
	}
	return cursor === end ? dates : [];
}

function normalizeRoomSelections(value = []) {
	return (Array.isArray(value) ? value : [])
		.map((selection) => ({
			roomTypeKey: cleanString(selection?.roomTypeKey, 40),
			count: Math.max(1, Number(selection?.count || 1) || 1),
		}))
		.filter((selection) => selection.roomTypeKey)
		.slice(0, 6);
}

function requestedSelectionsFromFacts(facts = {}) {
	const selections = normalizeRoomSelections(facts.roomSelections);
	if (selections.length) return selections;
	if (facts.roomTypeKey) {
		return [
			{
				roomTypeKey: cleanString(facts.roomTypeKey, 40),
				count: Math.max(1, Number(facts.rooms || 1) || 1),
			},
		];
	}
	return [];
}

function roomTypeLabel(roomTypeKey = "", ar = false) {
	const labels = {
		singleRooms: ar ? "غرفة مفردة" : "Single Room",
		doubleRooms: ar ? "غرفة مزدوجة" : "Double Room",
		twinRooms: ar ? "غرفة توأم" : "Twin Room",
		tripleRooms: ar ? "غرفة ثلاثية" : "Triple Room",
		quadRooms: ar ? "غرفة رباعية" : "Quad Room",
		familyRooms: ar ? "غرفة عائلية" : "Family Room",
		suite: ar ? "جناح" : "Suite",
	};
	return labels[roomTypeKey] || cleanString(roomTypeKey, 60);
}

function hasStayRange(facts = {}) {
	return Boolean(validISODate(facts.checkinISO) && validISODate(facts.checkoutISO));
}

function stayDatesForFacts(facts = {}) {
	return hasStayRange(facts) ? eachStayDate(facts.checkinISO, facts.checkoutISO) : [];
}

async function loadCandidateHotels(facts = {}) {
	const ids = configuredMarketingHotelIds();
	const dates = stayDatesForFacts(facts);
	const hotels = [];
	for (const id of ids) {
		const hotel = await getHotelByIdWithPricingDates(id, dates).catch((error) => {
			console.error("[jannatSupport] failed to load hotel candidate:", {
				hotelId: id,
				error: error?.message || error,
			});
			return null;
		});
		if (hotel?._id) hotels.push(hotel);
	}
	return hotels;
}

function hotelHasRequestedAvailability(hotel = {}, facts = {}) {
	if (!hotel?._id) return false;
	if (!hasStayRange(facts)) return true;
	const selections = requestedSelectionsFromFacts(facts);
	if (!selections.length) {
		return listAvailableRoomsForStay(hotel, facts.checkinISO, facts.checkoutISO).some(
			(option) => option.available
		);
	}
	return selections.every((selection) => {
		const quote = priceRoomForStay(
			hotel,
			{ roomType: selection.roomTypeKey },
			facts.checkinISO,
			facts.checkoutISO
		);
		return Boolean(quote?.available);
	});
}

function roomDisplayLabel(room = {}, roomTypeKey = "", ar = false) {
	const english = cleanString(room.displayName, 160);
	const localized = cleanString(room.displayName_OtherLanguage, 160);
	if (ar) return localized || english || roomTypeLabel(roomTypeKey, ar);
	return english || localized || roomTypeLabel(roomTypeKey, ar);
}

function quoteRoomLinesText(quote = {}, fallbackRoomTypeKey = "", ar = false) {
	const lines = Array.isArray(quote.rooms) ? quote.rooms : [];
	if (lines.length) {
		return lines
			.map((line) => {
				const label = roomDisplayLabel(
					line.room || line.quote?.room || {},
					line.roomTypeKey || line.roomType || fallbackRoomTypeKey,
					ar
				);
				return `${line.count || 1} x ${label}`;
			})
			.join(" + ");
	}
	return roomDisplayLabel(quote.room, fallbackRoomTypeKey, ar);
}

function buildQuoteForFacts(hotel = {}, facts = {}) {
	if (!hotel?._id || !hasStayRange(facts)) return null;
	const selections = requestedSelectionsFromFacts(facts);
	if (!selections.length) return null;
	const quoteLines = [];
	const unavailableLines = [];
	for (const selection of selections) {
		const roomTypeKey = selection.roomTypeKey || "";
		const count = Math.max(1, Number(selection.count || 1) || 1);
		const quote = priceRoomForStay(
			hotel,
			{ roomType: roomTypeKey },
			facts.checkinISO,
			facts.checkoutISO
		);
		if (!quote?.available) {
			unavailableLines.push({
				roomTypeKey,
				count,
				code: quote?.reason || "not_available",
				firstUnavailableDate: quote?.firstBlockedDate || "",
			});
			continue;
		}
		quoteLines.push({
			roomTypeKey,
			count,
			quote,
			room: quote.room,
			oneRoomTotal: Number(quote.totals?.totalPriceWithCommission || 0),
		});
	}
	if (unavailableLines.length) {
		return {
			available: false,
			code: unavailableLines[0]?.code || "not_available",
			checkinISO: facts.checkinISO,
			checkoutISO: facts.checkoutISO,
			roomSelections: selections,
			roomTypeKey: selections.length === 1 ? selections[0].roomTypeKey : facts.roomTypeKey || "",
			currency: hotel.currency || "SAR",
			unavailableSelections: unavailableLines,
			firstUnavailableDate:
				unavailableLines.find((line) => line.firstUnavailableDate)?.firstUnavailableDate || "",
		};
	}
	const rooms = quoteLines.reduce((total, line) => total + line.count, 0);
	const total = Number(
		quoteLines
			.reduce((sum, line) => sum + line.oneRoomTotal * line.count, 0)
			.toFixed(2)
	);
	const firstQuote = quoteLines[0]?.quote || {};
	const nights = firstQuote.nights || eachStayDate(facts.checkinISO, facts.checkoutISO).length || 1;
	return {
		available: true,
		checkinISO: facts.checkinISO,
		checkoutISO: facts.checkoutISO,
		roomTypeKey: quoteLines[0]?.roomTypeKey || facts.roomTypeKey || "",
		roomSelections: selections,
		roomLabel: quoteRoomLinesText({ rooms: quoteLines }, facts.roomTypeKey, false),
		nights,
		totalRooms: rooms,
		roomCount: rooms,
		rooms: quoteLines.map((line) => ({
			roomTypeKey: line.roomTypeKey,
			count: line.count,
			room: line.room,
			quote: line.quote,
		})),
		currency: (firstQuote.currency || hotel.currency || "SAR").toUpperCase(),
		total,
		averagePerNight: nights ? Number((total / nights).toFixed(2)) : total,
		totals: {
			totalPriceWithCommission: total,
		},
	};
}

function chooseTargetHotel({ plan = {}, candidateHotels = [], facts = {} } = {}) {
	if (!candidateHotels.length) return null;
	const byId = new Map(candidateHotels.map((hotel) => [normalizeId(hotel._id), hotel]));
	const planned = byId.get(normalizeId(plan.targetHotelId));
	let ordered = planned
		? [planned, ...candidateHotels.filter((hotel) => normalizeId(hotel._id) !== normalizeId(planned._id))]
		: candidateHotels;
	const recoveryFromHotelId = normalizeId(facts.jannatUnavailableRecoveryFromHotelId);
	if (recoveryFromHotelId && ordered.length > 1) {
		ordered = ordered.filter((hotel) => normalizeId(hotel._id) !== recoveryFromHotelId);
	}
	if (hasStayRange(facts)) {
		return ordered.find((hotel) => hotelHasRequestedAvailability(hotel, facts)) || null;
	}
	return planned || candidateHotels[0];
}

function mergeKnownFacts(supportCase = {}, facts = {}) {
	const snapshot = supportCase.aiStateSnapshot || {};
	const known = snapshot.known && typeof snapshot.known === "object" ? snapshot.known : {};
	const languageCode = languageCodeFromCase(supportCase, facts);
	return {
		...known,
		...facts,
		languageCode,
		languageName: facts.languageName || supportCase.preferredLanguage || known.languageName || "",
		jannatPlatformTransfer: true,
		jannatPlatformTransferAt: new Date().toISOString(),
	};
}

function hotelDisplayName(hotel = {}, ar = false) {
	return cleanString(
		ar && hotel.hotelName_OtherLanguage ? hotel.hotelName_OtherLanguage : hotel.hotelName,
		120
	);
}

function transferMessage({ supportCase, hotel, facts = {}, availabilityChecked = false } = {}) {
	const ar = isArabicCase(supportCase, facts);
	const name = hotelDisplayName(hotel, ar) || (ar ? "الفندق" : "the hotel");
	if (ar) {
		const prefix = availabilityChecked
			? "راجعت الفندق الأنسب حسب التفاصيل المتاحة،"
			: "تمام،";
		return `${prefix} سأوصلك الآن باستقبال ${name}. سأمرر لهم التفاصيل التي ذكرتها حتى يكملوا معك من نفس النقطة بإذن الله.`;
	}
	const prefix = availabilityChecked
		? "I checked the best hotel match from the available details,"
		: "Perfect,";
	return `${prefix} I will connect you now with ${name} reception. I will pass along the details you already shared so they can continue from here.`;
}

function noHotelConfiguredMessage(supportCase = {}, facts = {}) {
	return isArabicCase(supportCase, facts)
		? "أعتذر، لا يظهر لدي فريق فندق متاح للتحويل الآن. سأبقي المحادثة مع دعم جنات بوكينج حتى يراجعها الفريق."
		: "I am sorry, I do not see an available hotel team to transfer to right now. I will keep this with Jannat Booking support for team review.";
}

function noAlternativeHotelAvailableMessage(supportCase = {}, facts = {}) {
	return isArabicCase(supportCase, facts)
		? "أفهمك. راجعت الفنادق المتاحة لدينا لنفس التواريخ، ولا يظهر الآن خيار مؤكد مناسب للتحويل المباشر. سأبقي الطلب مع فريق جنات بوكينج لمراجعة أي إمكانية يدوية أو بديل مناسب والتواصل معك."
		: "I understand. I checked the available Jannat Booking hotel options for the same dates, and I do not see a confirmed suitable hotel for direct transfer right now. I will keep this with Jannat Booking support so the team can review any manual possibility or suitable alternative and follow up with you.";
}

function invalidStayRangeMessage(supportCase = {}, facts = {}, hotel = {}) {
	const ar = isArabicCase(supportCase, facts);
	const minDate = addDaysISO(businessTodayISO(hotel), 1);
	const reason = invalidStayRangeReason(facts, hotel);
	if (ar) {
		if (reason === "bad_range") {
			return `أحتاج تاريخ مغادرة بعد تاريخ الوصول حتى أراجع الترشيح بشكل صحيح. لو تكرمت أرسل تاريخ الوصول والمغادرة مرة أخرى، وأقرب تاريخ وصول يمكن ترتيبه عبر المحادثة هو ${minDate}.`;
		}
		return `للتوضيح، لا يمكن ترتيب حجز دخول اليوم أو تاريخ سابق عبر المحادثة. أقرب تاريخ وصول يمكن مراجعته هو ${minDate}. أرسل لي تاريخ الوصول والمغادرة المناسبين وسأرشح لك الفندق الأنسب مباشرة.`;
	}
	if (reason === "bad_range") {
		return `I need a checkout date after the check-in date before I recommend a hotel. Please send the check-in and checkout again. The earliest check-in I can review through chat is ${minDate}.`;
	}
	return `Just to clarify, same-day or past check-in dates cannot be arranged through chat. The earliest check-in I can review is ${minDate}. Send me the suitable check-in and checkout dates, and I will recommend the best hotel option.`;
}

function latestGuestEntry(supportCase = {}) {
	const conversation = Array.isArray(supportCase.conversation)
		? supportCase.conversation
		: [];
	for (let index = conversation.length - 1; index >= 0; index -= 1) {
		const entry = conversation[index] || {};
		if (entry.isAi || entry.isSystem) continue;
		const email = String(entry.messageBy?.customerEmail || "").trim().toLowerCase();
		const userId = String(entry.messageBy?.userId || "").trim().toLowerCase();
		if (
			email === "support@jannatbooking.com" ||
			email === "management@xhotelpro.com" ||
			userId === "jannat-ai-support" ||
			userId === "jannat-system" ||
			userId === "system"
		) {
			continue;
		}
		return entry;
	}
	return null;
}

function previousJannatRecommendation(supportCase = {}) {
	const latestGuest = latestGuestEntry(supportCase);
	const conversation = Array.isArray(supportCase.conversation)
		? supportCase.conversation
		: [];
	let start = conversation.length - 1;
	if (latestGuest) {
		const latestGuestId = String(latestGuest._id || "");
		const latestGuestTag = String(latestGuest.clientTag || "");
		const found = conversation.findIndex((entry) => {
			if (latestGuestId && String(entry?._id || "") === latestGuestId) return true;
			if (latestGuestTag && String(entry?.clientTag || "") === latestGuestTag) return true;
			return entry === latestGuest;
		});
		if (found >= 0) start = found - 1;
	}
	for (let index = start; index >= 0; index -= 1) {
		const entry = conversation[index] || {};
		const action = cleanString(entry.clientAction, 80).toLowerCase();
		if (
			action === "jannat_hotel_recommendation" ||
			action === "jannat_alternative_recommendation"
		) {
			return entry;
		}
	}
	return null;
}

function guestConfirmsTransfer(entry = {}) {
	const action = cleanString(entry.clientAction, 80).toLowerCase();
	if (action === "jannat_connect_reception") return true;
	const text = cleanString(entry.message, 300).toLowerCase();
	return /^(yes|yes please|connect me|continue|go ahead|ok|okay|sure|proceed|نعم|ايوا|ايوه|اه|تمام|تابع|كملي|كمّل|وصلني|حوّلني|حولني|اكمل|كمل|موافق)[\s!.،]*$/i.test(
		text
	);
}

function guestRequestsOtherOptions(entry = {}) {
	const action = cleanString(entry.clientAction, 80).toLowerCase();
	if (action === "jannat_show_options") return true;
	const text = cleanString(entry.message, 400).toLowerCase();
	return /(?:other option|other hotel|another hotel|alternatives|show options|different hotel|خيارات|اختيارات|فندق آخر|فندق اخر|بديل|بدائل|غيره|غيرها)/i.test(
		text
	);
}

function guestWantsChangeDetails(entry = {}) {
	return cleanString(entry.clientAction, 80).toLowerCase() === "jannat_change_details";
}

function guestLikelyWantsPricingOrBooking(supportCase = {}) {
	const text = (Array.isArray(supportCase.conversation) ? supportCase.conversation : [])
		.filter((entry) => !entry?.isAi && !entry?.isSystem)
		.map((entry) => cleanString(entry.message, 800))
		.join(" ")
		.toLowerCase();
	return /(?:book|booking|reserve|reservation|price|rate|cost|availability|available|check[ -]?in|checkout|room|night|dates?|\u062d\u062c\u0632|\u0627\u062d\u062c\u0632|\u0633\u0639\u0631|\u0628\u0643\u0627\u0645|\u0643\u0645|\u062a\u0643\u0644\u0641\u0629|\u0645\u062a\u0627\u062d|\u0645\u062a\u0648\u0641\u0631|\u062a\u0648\u0641\u0631|\u062f\u062e\u0648\u0644|\u062e\u0631\u0648\u062c|\u063a\u0631\u0641\u0629|\u063a\u0631\u0641|\u0644\u064a\u0644\u0629|\u062a\u0627\u0631\u064a\u062e|\u062a\u0648\u0627\u0631\u064a\u062e)/iu.test(
		text
	);
}

function missingPricingFacts(facts = {}) {
	const missing = [];
	if (!validISODate(facts.checkinISO) || !validISODate(facts.checkoutISO)) {
		missing.push("dates");
	}
	if (!requestedSelectionsFromFacts(facts).length) {
		missing.push("room_or_guests");
	}
	return missing;
}

function missingPricingDetailsMessage(supportCase = {}, facts = {}) {
	const ar = isArabicCase(supportCase, facts);
	const missing = missingPricingFacts(facts);
	const hasDates = !missing.includes("dates");
	const hasRoom = !missing.includes("room_or_guests");
	if (ar) {
		if (hasDates && !hasRoom) {
			return "\u062a\u0645\u0627\u0645\u060c \u0648\u0635\u0644\u062a \u062a\u0648\u0627\u0631\u064a\u062e \u0627\u0644\u062f\u062e\u0648\u0644 \u0648\u0627\u0644\u062e\u0631\u0648\u062c. \u0623\u0631\u0633\u0644 \u0644\u064a \u0641\u0642\u0637 \u0646\u0648\u0639 \u0627\u0644\u063a\u0631\u0641\u0629 \u0623\u0648 \u0639\u062f\u062f \u0627\u0644\u0636\u064a\u0648\u0641\u060c \u0648\u0633\u0623\u0639\u0631\u0636 \u0644\u0643 \u0627\u0644\u0633\u0639\u0631 \u0627\u0644\u0645\u062a\u0627\u062d \u0645\u0628\u0627\u0634\u0631\u0629 \u0642\u0628\u0644 \u0627\u0644\u062a\u062d\u0648\u064a\u0644.";
		}
		if (!hasDates && hasRoom) {
			return "\u062a\u0645\u0627\u0645\u060c \u0623\u0631\u0633\u0644 \u0644\u064a \u0641\u0642\u0637 \u062a\u0627\u0631\u064a\u062e \u0627\u0644\u062f\u062e\u0648\u0644 \u0648\u062a\u0627\u0631\u064a\u062e \u0627\u0644\u062e\u0631\u0648\u062c\u060c \u0648\u0633\u0623\u0631\u0627\u062c\u0639 \u0644\u0643 \u0627\u0644\u063a\u0631\u0641\u0629 \u0648\u0627\u0644\u0633\u0639\u0631 \u0642\u0628\u0644 \u0623\u0646 \u0623\u0648\u0635\u0644\u0643 \u0628\u0627\u0644\u0627\u0633\u062a\u0642\u0628\u0627\u0644.";
		}
		return "\u0623\u0643\u064a\u062f\u060c \u0642\u0628\u0644 \u0623\u0648\u0635\u0644\u0643 \u0628\u0627\u0644\u0627\u0633\u062a\u0642\u0628\u0627\u0644 \u0623\u0631\u0633\u0644 \u0644\u064a \u062a\u0627\u0631\u064a\u062e \u0627\u0644\u062f\u062e\u0648\u0644 \u0648\u0627\u0644\u062e\u0631\u0648\u062c \u0648\u0646\u0648\u0639 \u0627\u0644\u063a\u0631\u0641\u0629 \u0623\u0648 \u0639\u062f\u062f \u0627\u0644\u0636\u064a\u0648\u0641\u060c \u0648\u0633\u0623\u0631\u0627\u062c\u0639 \u0644\u0643 \u0627\u0644\u0633\u0639\u0631 \u0648\u0627\u0644\u062a\u0648\u0641\u0631 \u0628\u0623\u0642\u0644 \u0623\u0633\u0626\u0644\u0629 \u0645\u0645\u0643\u0646\u0629.";
	}
	if (hasDates && !hasRoom) {
		return "Perfect, I have the check-in and check-out dates. Send me only the room type or number of guests, and I will show the available price before connecting you with reception.";
	}
	if (!hasDates && hasRoom) {
		return "Perfect, send me only the check-in and check-out dates, and I will review the room and price before connecting you with reception.";
	}
	return "Of course. Before I connect you with reception, send me the check-in date, check-out date, and room type or number of guests so I can review the price and availability with fewer questions.";
}

function changeDetailsMessage(supportCase = {}, facts = {}) {
	return isArabicCase(supportCase, facts)
		? "أكيد، اكتب لي التواريخ أو عدد الضيوف أو نوع الغرفة الجديد، وسأراجع لك الترشيح مرة أخرى قبل تحويلك للاستقبال."
		: "Of course. Send me the updated dates, guests, or room type, and I will review the recommendation again before connecting you with reception.";
}

function recommendationQuickReplies(supportCase = {}, facts = {}) {
	const ar = isArabicCase(supportCase, facts);
	return ar
		? [
				{
					label: "نعم، وصلني بالاستقبال",
					value: "نعم، وصلني بالاستقبال",
					action: "jannat_connect_reception",
				},
				{
					label: "أريد خيارات أخرى",
					value: "أريد خيارات أخرى",
					action: "jannat_show_options",
				},
				{
					label: "أعدل التفاصيل",
					value: "أريد تعديل التفاصيل",
					action: "jannat_change_details",
				},
		  ]
		: [
				{
					label: "Connect me",
					value: "Connect me to reception",
					action: "jannat_connect_reception",
				},
				{
					label: "Other options",
					value: "Show me other options",
					action: "jannat_show_options",
				},
				{
					label: "Change details",
					value: "I want to change details",
					action: "jannat_change_details",
				},
		  ];
}

function hotelStrengthLine(hotel = {}, ar = false) {
	const name = hotelDisplayName(hotel, ar) || (ar ? "الفندق" : "the hotel");
	const nameKey = `${hotel.hotelName || ""} ${hotel.hotelName_OtherLanguage || ""}`.toLowerCase();
	if (/zad\s*ajyad|zad\s*agyad|ajyad|\u0623\u062c\u064a\u0627\u062f|\u0627\u062c\u064a\u0627\u062f/.test(nameKey)) {
		return ar
			? `${name} خيار قوي جدًا لأنه في منطقة أجياد الحيوية، حوله مطاعم وخدمات كثيرة، وقريب من الحرم بحوالي 15 دقيقة مشيًا للضيوف القادرين صحيًا، مع وصول سريع بالسيارة حسب الزحام.`
			: `${name} is a very strong option in the lively Ajyad area, with many restaurants and services around it, and it is about a 15-minute walk to Al Haram for guests who are comfortably able to walk, with quick car access depending on traffic.`;
	}
	const walking = cleanString(hotel.distances?.walkingToElHaram, 80);
	const driving = cleanString(hotel.distances?.drivingToElHaram, 80);
	if (walking || driving || hotel.distances) {
		const walkingText = walking || (ar ? "15 دقيقة" : "15 minutes");
		const drivingText = driving || (ar ? "2 دقيقة" : "2 minutes");
		return ar
			? `${name} موقعه استراتيجي للحرم: حوالي ${walkingText} مشيا و${drivingText} بالسيارة حسب الزحام.`
			: `${name} is a strong Al Haram access option: about ${walkingText} walking and ${drivingText} by car depending on traffic.`;
	}
	if (hotel.hasMealsService === true) {
		return ar
			? `${name} خيار مريح لأن بيانات الفندق تعرض خدمة وجبات للضيوف.`
			: `${name} is convenient because hotel facts include meal service for guests.`;
	}
	if (hotel.hasBusService === true) {
		return ar
			? `${name} خيار مريح لأن بيانات الفندق تعرض خدمة نقل للضيوف.`
			: `${name} is convenient because hotel facts include guest transport service.`;
	}
	return ar
		? `${name} من الفنادق المناسبة التي نرشحها عبر جنات بوكينج حسب البيانات المتاحة.`
		: `${name} is one of the suitable hotels we recommend through Jannat Booking from the available hotel data.`;
}

function factSummaryLine(facts = {}, ar = false) {
	const parts = [];
	if (validISODate(facts.checkinISO) && validISODate(facts.checkoutISO)) {
		parts.push(
			ar
				? `${facts.checkinISO} إلى ${facts.checkoutISO}`
				: `${facts.checkinISO} to ${facts.checkoutISO}`
		);
	}
	const selections = requestedSelectionsFromFacts(facts);
	if (selections.length) {
		parts.push(
			selections
				.map((selection) => `${selection.count} x ${roomTypeLabel(selection.roomTypeKey, ar)}`)
				.join(" + ")
		);
	}
	const adults = Number(facts.adults || 0);
	const children = Number(facts.children || 0);
	if (adults || children) {
		parts.push(
			ar
				? `${adults || 0} بالغ${children ? ` و${children} طفل` : ""}`
				: `${adults || 0} adult${adults === 1 ? "" : "s"}${
						children ? ` and ${children} child${children === 1 ? "" : "ren"}` : ""
				  }`
		);
	}
	return parts.join(ar ? "، " : ", ");
}

function recommendationQuoteLines(quote = null, facts = {}, ar = false) {
	if (!quote) return [];
	const languageCode = ar ? "ar" : "en";
	if (!quote.available) {
		const firstUnavailable = validISODate(quote.firstUnavailableDate);
		if (ar) {
			return [
				"- \u0627\u0644\u062a\u0648\u0641\u0631: \u0644\u0627 \u064a\u0638\u0647\u0631 \u062a\u0648\u0641\u0631 \u0645\u0624\u0643\u062f \u0644\u0647\u0630\u0627 \u0627\u0644\u0627\u062e\u062a\u064a\u0627\u0631 \u062d\u0627\u0644\u064a\u064b\u0627.",
				firstUnavailable
					? `- \u0623\u0648\u0644 \u062a\u0627\u0631\u064a\u062e \u063a\u064a\u0631 \u0645\u062a\u0627\u062d: ${formatDate(firstUnavailable, languageCode)}`
					: "",
			].filter(Boolean);
		}
		return [
			"- Availability: this selection is not showing confirmed availability right now.",
			firstUnavailable
				? `- First unavailable date: ${formatDate(firstUnavailable, languageCode)}`
				: "",
		].filter(Boolean);
	}
	const roomLine = quoteRoomLinesText(quote, quote.roomTypeKey || facts.roomTypeKey, ar);
	const checkinISO = validISODate(quote.checkinISO || facts.checkinISO);
	const checkoutISO = validISODate(quote.checkoutISO || facts.checkoutISO);
	const lines = [];
	if (roomLine) {
		lines.push(ar ? `- \u0627\u0644\u063a\u0631\u0641: ${roomLine}` : `- Rooms: ${roomLine}`);
	}
	if (checkinISO && checkoutISO) {
		lines.push(
			ar
				? `- \u0627\u0644\u062a\u0648\u0627\u0631\u064a\u062e: ${formatDate(checkinISO, languageCode)} - ${formatDate(checkoutISO, languageCode)}`
				: `- Dates: ${formatDate(checkinISO, languageCode)} - ${formatDate(checkoutISO, languageCode)}`
		);
	}
	if (quote.nights) {
		lines.push(
			ar
				? `- \u0639\u062f\u062f \u0627\u0644\u0644\u064a\u0627\u0644\u064a: ${formatNumber(quote.nights, languageCode)}`
				: `- Nights: ${formatNumber(quote.nights, languageCode)}`
		);
	}
	if (quote.averagePerNight) {
		lines.push(
			`- ${discountedPriceLine(
				ar ? "\u0627\u0644\u0633\u0639\u0631 \u0644\u0644\u064a\u0644\u0629" : "Rate per night",
				quote.averagePerNight,
				quote.currency || "SAR",
				languageCode
			)}`
		);
	}
	if (quote.total) {
		lines.push(
			`- ${discountedPriceLine(
				ar ? "\u0627\u0644\u0625\u062c\u0645\u0627\u0644\u064a" : "Total",
				quote.total,
				quote.currency || "SAR",
				languageCode
			)}`
		);
	}
	lines.push(
		ar
			? "- \u0627\u0644\u0639\u0631\u0636 \u0627\u0644\u062d\u0627\u0644\u064a: \u0627\u0644\u0633\u0639\u0631 \u064a\u0634\u0645\u0644 \u062e\u0635\u0645 25\u066a \u0644\u0644\u062d\u062c\u0632 \u0627\u0644\u0645\u0628\u0627\u0634\u0631 \u0639\u0628\u0631 \u0627\u0644\u0627\u0633\u062a\u0642\u0628\u0627\u0644."
			: "- Current offer: this price includes the 25% direct-booking discount through reception."
	);
	return lines;
}

function recommendationMessage({
	supportCase,
	hotel,
	facts = {},
	isFallback = false,
	availabilityChecked = false,
	priorityUnavailable = false,
	quote = null,
} = {}) {
	const ar = isArabicCase(supportCase, facts);
	const name = hotelDisplayName(hotel, ar) || (ar ? "الفندق" : "the hotel");
	const factsLine = factSummaryLine(facts, ar);
	const quoteLines = recommendationQuoteLines(quote, facts, ar);
	const recovery = Boolean(facts.jannatUnavailableRecoveryTransfer);
	if (ar) {
		const intro = priorityUnavailable
			? "راجعت خيارنا الأول للتفاصيل التي ذكرتها، ويبدو أنه غير مناسب لهذه التواريخ/التفاصيل. البديل الأفضل الآن:"
			: recovery
			? "أهلًا بك، معك دعم جنات بوكينج. راجعنا التوفر لنفس التفاصيل، وترشيحنا الأفضل الآن:"
			: "أرشح لك أولاً هذا الفندق عبر جنات بوكينج:";
		const availability = availabilityChecked
			? "راجعت التوفر حسب التفاصيل المتاحة قبل التحويل."
			: "لو تحب، أوصلك بالاستقبال ليراجعوا التوفر والسعر النهائي مباشرة.";
		return [
			intro,
			`- الفندق: ${name}`,
			`- سبب الترشيح: ${hotelStrengthLine(hotel, ar)}`,
			factsLine ? `- التفاصيل التي سأمررها: ${factsLine}` : "",
			...quoteLines,
			`${availability} هل تحب أوصلك باستقبال الفندق الآن؟`,
		]
			.filter(Boolean)
			.join("\n");
	}
	const intro = priorityUnavailable
		? "I checked our first-choice hotel for the details you shared, and it does not look suitable for those dates/details. The best backup now is:"
		: recovery
		? "Jannat Booking support is with you now. I reviewed the same details for availability, and my best recommendation is:"
		: "My first recommendation from Jannat Booking is:";
	const availability = availabilityChecked
		? "I checked availability against the details available before handing you over."
		: "If you like, I can connect you with reception so they can check the final availability and price directly.";
	return [
		intro,
		`- Hotel: ${name}`,
		`- Why this one: ${hotelStrengthLine(hotel, ar)}`,
		factsLine ? `- Details I will pass along: ${factsLine}` : "",
		...quoteLines,
		`${availability} Would you like me to connect you with reception now?`,
	]
		.filter(Boolean)
		.join("\n");
}

function jannatMessageData(supportCase = {}, text = "", action = "jannat_support_reply") {
	const languageCode = languageCodeFromCase(supportCase);
	return {
		messageBy: {
			customerName: configuredJannatSupportName(languageCode),
			customerEmail: SUPPORT_EMAIL,
			userId: "jannat-system",
		},
		message: cleanString(text, 3000),
		date: new Date(),
		inquiryAbout: "jannat_support",
		inquiryDetails: cleanString(text, 300),
		seenByAdmin: false,
		seenByHotel: false,
		seenByCustomer: false,
		isAi: true,
		isSystem: true,
		clientTag: `jannat-system-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		clientAction: action,
		preferredLanguage: supportCase.preferredLanguage || "",
		preferredLanguageCode: languageCode,
		quickReplies: [],
	};
}

async function appendJannatMessage(io, supportCase = {}, text = "", options = {}) {
	const caseId = caseIdText(supportCase);
	if (!caseId || !cleanString(text)) return supportCase;
	const messageData = jannatMessageData(
		supportCase,
		text,
		options.clientAction || "jannat_support_reply"
	);
	if (Array.isArray(options.quickReplies)) {
		messageData.quickReplies = options.quickReplies.slice(0, 3);
	}
	const fields = {
		conversation: messageData,
		aiRelated: true,
		aiToRespond: options.keepAiEnabled === false ? false : true,
		...(options.caseFields || {}),
	};
	const saved = await updateSupportCaseAppendIfNoRecentAiDuplicate(caseId, fields, {
		requireOpenClientAi: true,
		duplicateWindowMs: 30000,
	});
	const updatedCase = saved?.updatedCase || (await getSupportCaseById(caseId));
	if (io && updatedCase) {
		io.to(caseId).emit("receiveMessage", { ...messageData, caseId });
		io.to(caseId).emit("supportCaseUpdated", updatedCase);
		io.emit("supportCaseUpdated", updatedCase);
		io.to(caseId).emit("stopTyping", { caseId, isAi: true });
	}
	return updatedCase;
}

async function emitTyping(io, supportCase = {}, isTyping = true, name = "") {
	const caseId = caseIdText(supportCase);
	if (!io || !caseId) return;
	io.to(caseId).emit(isTyping ? "typing" : "stopTyping", {
		caseId,
		isAi: true,
		name: name || configuredJannatSupportName(languageCodeFromCase(supportCase)),
	});
}

async function transferToHotel({
	io,
	supportCase,
	hotel,
	facts = {},
	scheduleHotelTurn,
	availabilityChecked = false,
} = {}) {
	const caseId = caseIdText(supportCase);
	if (!caseId || !hotel?._id) return supportCase;
	const ar = isArabicCase(supportCase, facts);
	const known = mergeKnownFacts(supportCase, facts);
	const ownerId = normalizeId(hotel.belongsTo);
	const nextResponderName = pickHotelReceptionName({
		seed: `${caseId}:${normalizeId(hotel._id)}:${supportCase.clientContact || ""}`,
		avoid: supportCase.aiResponderName || "",
	});
	const nextSnapshot = {
		...(supportCase.aiStateSnapshot || {}),
		version: 3,
		updatedAt: new Date(),
		known,
		jannatSupport: {
			transferredAt: new Date(),
			fromHotelId: normalizeId(supportCase.hotelId),
			toHotelId: normalizeId(hotel._id),
			toHotelName: hotel.hotelName || "",
			reason: "platform_support_to_hotel_reception",
		},
	};
	const updated = await appendJannatMessage(
		io,
		supportCase,
		transferMessage({ supportCase, hotel, facts, availabilityChecked }),
		{
			clientAction: "jannat_hotel_transfer",
			caseFields: {
				hotelId: hotel._id,
				displayName2: hotel.hotelName || supportCase.displayName2 || "Hotel",
				targetUserId: ownerId || null,
				targetUserName: hotel.hotelName || "",
				targetUserRole: "Reception",
				supporterId: ownerId || supportCase.supporterId || null,
				ownerId: ownerId || supportCase.ownerId || null,
				supporterName: hotel.hotelName || supportCase.supporterName || "",
				supportScope: "hotel",
				aiResponderName: nextResponderName,
				aiPausedAt: null,
				aiHandoffReason: "",
				aiStateSnapshot: nextSnapshot,
			},
		}
	);
	await updateSupportCaseAiStateSnapshot(caseId, nextSnapshot).catch((error) => {
		console.error("[jannatSupport] snapshot save failed:", error?.message || error);
	});
	if (typeof scheduleHotelTurn === "function") {
		const delayMs = jannatHandoffDelayMs();
		setTimeout(() => {
			scheduleHotelTurn(caseId, {
				delayMs: 0,
				reason: "jannat_support_transfer_to_hotel",
			});
		}, delayMs).unref?.();
		if (io) {
			io.to(caseId).emit("typing", {
				caseId,
				isAi: true,
				name: ar ? nextResponderName : nextResponderName,
			});
		}
	}
	return updated;
}

async function maybeHandleJannatSupportTurn({
	io,
	supportCase,
	scheduleHotelTurn,
} = {}) {
	let sc = supportCase;
	const caseId = caseIdText(sc);
	if (caseId && !sc?.aiStateSnapshot) {
		sc = (await getSupportCaseById(caseId)) || sc;
	}
	if (!sc || sc.openedBy !== "client" || sc.caseStatus === "closed" || sc.aiToRespond === false) {
		return { handled: false, supportCase: sc };
	}
	if (!isJannatBookingSupportCase(sc)) {
		return { handled: false, supportCase: sc };
	}
	const globallyEnabled =
		String(process.env.AI_AGENT_ENABLED || "").toLowerCase() === "true" ||
		String(process.env.AI_FORCE_RESPOND || "").toLowerCase() === "true";
	if (!globallyEnabled) return { handled: true, supportCase: sc };
	const janatAi = await getJanatAiSettings().catch(() => ({ aiToRespond: true }));
	if (janatAi.aiToRespond === false && String(process.env.AI_FORCE_RESPOND || "").toLowerCase() !== "true") {
		return { handled: true, supportCase: sc };
	}

	await emitTyping(io, sc, true);
	const fallbackFacts = sc.aiStateSnapshot?.known || {};
	const candidateHotels = await loadCandidateHotels(fallbackFacts);
	if (!candidateHotels.length) {
		const updated = await appendJannatMessage(io, sc, noHotelConfiguredMessage(sc), {
			clientAction: "jannat_no_hotel_configured",
			keepAiEnabled: false,
			caseFields: {
				aiPausedAt: new Date(),
				aiHandoffReason: "jannat_support_no_marketing_hotels_configured",
				escalationStatus: "active",
				escalationReason: "jannat_support_no_marketing_hotels_configured",
				escalationSource: "ai",
				escalatedAt: new Date(),
			},
		});
		await emitTyping(io, updated || sc, false);
		return { handled: true, supportCase: updated || sc };
	}

	const plan = await planJannatTurn({ supportCase: sc, candidateHotels });
	const facts = mergeKnownFacts(sc, plan.facts || {});
	const hotelsForFacts = await loadCandidateHotels(facts);
	const hotels = hotelsForFacts.length ? hotelsForFacts : candidateHotels;
	const primaryHotel = hotels[0] || candidateHotels[0] || {};
	if (invalidStayRangeReason(facts, primaryHotel)) {
		const nextSnapshot = {
			...(sc.aiStateSnapshot || {}),
			version: 3,
			updatedAt: new Date(),
			known: facts,
			jannatSupport: {
				...(sc.aiStateSnapshot?.jannatSupport || {}),
				lastPlanAt: new Date(),
				action: "awaiting_future_dates",
				reason: invalidStayRangeReason(facts, primaryHotel),
				minCheckinISO: addDaysISO(businessTodayISO(primaryHotel), 1),
			},
		};
		const updated = await appendJannatMessage(
			io,
			sc,
			invalidStayRangeMessage(sc, facts, primaryHotel),
			{
				clientAction: "jannat_future_dates_required",
				caseFields: { aiStateSnapshot: nextSnapshot },
			}
		);
		await updateSupportCaseAiStateSnapshot(caseId, nextSnapshot).catch((error) => {
			console.error("[jannatSupport] future date snapshot save failed:", error?.message || error);
		});
		await emitTyping(io, updated || sc, false);
		return { handled: true, supportCase: updated || sc };
	}
	const latestGuest = latestGuestEntry(sc);
	const previousRecommendation = previousJannatRecommendation(sc);
	const recommendedHotelId = normalizeId(
		sc.aiStateSnapshot?.jannatSupport?.recommendedHotelId
	);
	const hotelsById = new Map(hotels.map((hotel) => [normalizeId(hotel._id), hotel]));
	const previouslyRecommendedHotel = hotelsById.get(recommendedHotelId);
	if (previousRecommendation && latestGuest && guestConfirmsTransfer(latestGuest)) {
		const targetHotel =
			previouslyRecommendedHotel ||
			chooseTargetHotel({ plan, candidateHotels: hotels, facts });
		if (targetHotel?._id) {
			const updated = await transferToHotel({
				io,
				supportCase: sc,
				hotel: targetHotel,
				facts,
				scheduleHotelTurn,
				availabilityChecked: hasStayRange(facts),
			});
			await emitTyping(io, updated || sc, false);
			return { handled: true, supportCase: updated || sc };
		}
	}
	if (plan.action !== "transfer_to_hotel") {
		const updated = await appendJannatMessage(io, sc, plan.reply || noHotelConfiguredMessage(sc, facts), {
			clientAction: "jannat_platform_reply",
			caseFields: {
				aiStateSnapshot: {
					...(sc.aiStateSnapshot || {}),
					version: 3,
					updatedAt: new Date(),
					known: facts,
					jannatSupport: {
						lastPlanAt: new Date(),
						action: plan.action,
						reason: plan.reason || "",
					},
				},
			},
		});
		await emitTyping(io, updated || sc, false);
		return { handled: true, supportCase: updated || sc };
	}
	if (latestGuest && guestWantsChangeDetails(latestGuest)) {
		const nextSnapshot = {
			...(sc.aiStateSnapshot || {}),
			version: 3,
			updatedAt: new Date(),
			known: facts,
			jannatSupport: {
				...(sc.aiStateSnapshot?.jannatSupport || {}),
				lastPlanAt: new Date(),
				action: "awaiting_changed_details",
			},
		};
		const updated = await appendJannatMessage(io, sc, changeDetailsMessage(sc, facts), {
			clientAction: "jannat_change_details_prompt",
			caseFields: { aiStateSnapshot: nextSnapshot },
		});
		await updateSupportCaseAiStateSnapshot(caseId, nextSnapshot).catch((error) => {
			console.error("[jannatSupport] change details snapshot save failed:", error?.message || error);
		});
		await emitTyping(io, updated || sc, false);
		return { handled: true, supportCase: updated || sc };
	}
	if (guestLikelyWantsPricingOrBooking(sc) && missingPricingFacts(facts).length) {
		const nextSnapshot = {
			...(sc.aiStateSnapshot || {}),
			version: 3,
			updatedAt: new Date(),
			known: facts,
			jannatSupport: {
				...(sc.aiStateSnapshot?.jannatSupport || {}),
				lastPlanAt: new Date(),
				action: "collect_pricing_details",
				reason: "pricing_details_missing_before_handoff",
				missing: missingPricingFacts(facts),
			},
		};
		const updated = await appendJannatMessage(io, sc, missingPricingDetailsMessage(sc, facts), {
			clientAction: "jannat_collect_pricing_details",
			caseFields: { aiStateSnapshot: nextSnapshot },
		});
		await updateSupportCaseAiStateSnapshot(caseId, nextSnapshot).catch((error) => {
			console.error("[jannatSupport] pricing detail snapshot save failed:", error?.message || error);
		});
		await emitTyping(io, updated || sc, false);
		return { handled: true, supportCase: updated || sc };
	}

	const firstRecommendedHotel = chooseTargetHotel({ plan, candidateHotels: hotels, facts });
	const wantsOtherOptions = latestGuest && guestRequestsOtherOptions(latestGuest);
	const recoveryFromHotelId = normalizeId(facts.jannatUnavailableRecoveryFromHotelId);
	const alternativeHotels = wantsOtherOptions
		? hotels.filter(
				(hotel) =>
					normalizeId(hotel._id) !== normalizeId(firstRecommendedHotel?._id) &&
					(!recoveryFromHotelId || normalizeId(hotel._id) !== recoveryFromHotelId) &&
					hotelHasRequestedAvailability(hotel, facts)
		  )
		: [];
	const targetHotel = alternativeHotels[0] || firstRecommendedHotel;
	if (!targetHotel?._id) {
		const recovery = Boolean(facts.jannatUnavailableRecoveryTransfer);
		const updated = await appendJannatMessage(
			io,
			sc,
			recovery ? noAlternativeHotelAvailableMessage(sc, facts) : noHotelConfiguredMessage(sc, facts),
			{
				clientAction: recovery
					? "jannat_no_available_alternative"
					: "jannat_no_target_hotel",
				keepAiEnabled: false,
				caseFields: recovery
					? {
							aiPausedAt: new Date(),
							aiHandoffReason: "jannat_no_available_alternative",
							escalationStatus: "active",
							escalationReason: "jannat_no_available_alternative",
							escalationSource: "ai",
							escalatedAt: new Date(),
					  }
					: {},
			}
		);
		await emitTyping(io, updated || sc, false);
		return { handled: true, supportCase: updated || sc };
	}
	const availabilityChecked = hasStayRange(facts);
	const recommendationQuote = buildQuoteForFacts(targetHotel, facts);
	const recommendationFacts = recommendationQuote
		? { ...facts, quote: recommendationQuote }
		: facts;
	const priorityHotel = hotels[0] || null;
	const priorityUnavailable =
		Boolean(priorityHotel?._id) &&
		normalizeId(priorityHotel._id) !== normalizeId(targetHotel._id) &&
		hasStayRange(facts) &&
		!hotelHasRequestedAvailability(priorityHotel, facts);
	const nextSnapshot = {
		...(sc.aiStateSnapshot || {}),
		version: 3,
		updatedAt: new Date(),
		known: recommendationFacts,
		jannatSupport: {
			...(sc.aiStateSnapshot?.jannatSupport || {}),
			lastPlanAt: new Date(),
			action: wantsOtherOptions
				? "alternative_recommendation"
				: "hotel_recommendation",
			reason: plan.reason || "",
			recommendedHotelId: normalizeId(targetHotel._id),
			recommendedHotelName: targetHotel.hotelName || "",
			priorityHotelId: normalizeId(priorityHotel?._id),
			priorityUnavailable,
		},
	};
	const updated = await appendJannatMessage(
		io,
		sc,
		recommendationMessage({
			supportCase: sc,
			hotel: targetHotel,
			facts: recommendationFacts,
			availabilityChecked,
			priorityUnavailable,
			quote: recommendationQuote,
		}),
		{
			clientAction: wantsOtherOptions
				? "jannat_alternative_recommendation"
				: "jannat_hotel_recommendation",
			quickReplies: recommendationQuickReplies(sc, facts),
			caseFields: {
				aiStateSnapshot: nextSnapshot,
			},
		}
	);
	await updateSupportCaseAiStateSnapshot(caseId, nextSnapshot).catch((error) => {
		console.error("[jannatSupport] recommendation snapshot save failed:", error?.message || error);
	});
	await emitTyping(io, updated || sc, false);
	return { handled: true, supportCase: updated || sc };
}

module.exports = {
	maybeHandleJannatSupportTurn,
	__test: {
		chooseTargetHotel,
		hotelHasRequestedAvailability,
		buildQuoteForFacts,
		recommendationMessage,
		recommendationQuoteLines,
		guestLikelyWantsPricingOrBooking,
		missingPricingFacts,
		missingPricingDetailsMessage,
		mergeKnownFacts,
		requestedSelectionsFromFacts,
		eachStayDate,
		invalidStayRangeReason,
		businessTodayISO,
		roomTypeLabel,
	},
};
