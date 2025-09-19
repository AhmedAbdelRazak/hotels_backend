/** @format */
const STR = require("./strings");

// Fallback display name; real name is injected per case via names.js
function defaultAgentName(code) {
	switch ((code || "").toLowerCase()) {
		case "ar":
		case "ar-eg":
		case "ar-sa":
		case "ar-blend":
			return "مُنى | دعم العملاء";
		case "es":
			return "Aisha | Soporte";
		case "fr":
			return "Aïcha | Support Client";
		case "ur":
			return "عائشہ | کسٹمر سپورٹ";
		case "hi":
			return "आयशा | ग्राहक सहायता";
		default:
			return "Aisha | Customer Support";
	}
}

function chooseLanguageVariant(state) {
	const pref = state.preferredLanguage || "English";
	const code = (state.preferredLanguageCode || "en").toLowerCase();
	const nationality = state.answers?.nationality || "";

	let pack;
	if (/Arabic/.test(pref) || code === "ar") {
		if (nationality === "EG") pack = STR["ar-eg"];
		else if (nationality === "SA") pack = STR["ar-sa"];
		else pack = STR["ar-blend"];
	} else {
		pack = STR[code] || STR["en"];
	}

	// leave a default; watcher will override with a stable, language-aware name per caseId
	pack.agentName = state.agentName || defaultAgentName(pack.code || code);
	return pack;
}

module.exports = { chooseLanguageVariant };
