/** @format */
const { mergeCaseState, getOrCreateCaseState } = require("../core/state");
const { normalizeDate, isValidRange } = require("../utils/date");

const ORDER = [
	"checkin",
	"checkout",
	"roomType",
	"confirmName",
	"phone",
	"nationality",
	"email",
];

function currentMissing(state) {
	for (const key of ORDER) {
		if (!state.answers[key]) return key;
	}
	return null;
}

function readyToQuote(stateOrCaseId) {
	const s =
		typeof stateOrCaseId === "string"
			? getOrCreateCaseState(stateOrCaseId)
			: stateOrCaseId;
	return !!(s.answers.checkin && s.answers.checkout && s.answers.roomType);
}

function stepUpdateIfAnswered({ caseId, extracted, parsed }) {
	const s = getOrCreateCaseState(caseId);
	const ans = { ...s.answers };

	if (extracted.checkin) ans.checkin = normalizeDate(extracted.checkin);
	if (extracted.checkout) ans.checkout = normalizeDate(extracted.checkout);
	if (ans.checkin && ans.checkout && !isValidRange(ans.checkin, ans.checkout))
		delete ans.checkout;

	if (extracted.roomType) {
		ans.roomType = extracted.roomType;
		if (extracted.displayName) ans.displayName = extracted.displayName;
	}

	if (!ans.confirmName) {
		const raw = parsed?.raw || "";
		if (/\b(yes|y|ayo|ايوه|ايوة|نعم|تمام|ok)\b/i.test(raw))
			ans.confirmName = true;
		if (/\b(no|n|la|لا|مش|مو)\b/i.test(raw)) ans.confirmName = false;
	}

	if (extracted.phone) ans.phone = extracted.phone;
	if (extracted.nationality) ans.nationality = extracted.nationality;
	if (extracted.email) ans.email = extracted.email;

	return mergeCaseState(caseId, { answers: ans });
}

async function nextPromptFor({ caseId, lang, forceNext }) {
	const s = getOrCreateCaseState(caseId);
	const L = lang || { t: (x) => x };
	const missing = forceNext || currentMissing(s);

	let step = missing || "confirm";
	mergeCaseState(caseId, { step });

	switch (missing) {
		case "checkin":
			return L.t("ask_checkin");
		case "checkout":
			return L.t("ask_checkout");
		case "roomType": {
			const options = (s.hotel?.roomCountDetails || [])
				.filter((r) => r?.activeRoom !== false)
				.map((r) => `• ${r.displayName || r.roomType} (${r.roomType})`)
				.join("\n");
			return L.t("ask_room_type", { options });
		}
		case "confirmName": {
			const name = s.profile?.name || "";
			if (!name || !/\s/.test(name)) return L.t("ask_full_name");
			return L.t("ask_name_confirm", { name });
		}
		case "phone":
			return L.t("ask_phone");
		case "nationality":
			return L.t("ask_nationality");
		case "email":
			return L.t("ask_email");
		default: {
			// confirm phase
			mergeCaseState(caseId, { step: "confirm" });
			return L.t("confirm_all", {
				dates: `${s.answers.checkin} → ${s.answers.checkout}`,
				room: s.answers.displayName || s.answers.roomType || "",
				name: s.profile?.name || "",
				phone: s.answers.phone || "",
				nationality: s.answers.nationality || "",
				email: s.answers.email || "",
			});
		}
	}
}

module.exports = { stepUpdateIfAnswered, nextPromptFor, readyToQuote };
