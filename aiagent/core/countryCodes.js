const countries = require("i18n-iso-countries");

try {
	countries.registerLocale(require("i18n-iso-countries/langs/en.json"));
	countries.registerLocale(require("i18n-iso-countries/langs/ar.json"));
	countries.registerLocale(require("i18n-iso-countries/langs/fr.json"));
	countries.registerLocale(require("i18n-iso-countries/langs/es.json"));
} catch {
	// Locale registration is best-effort; English package data is enough for codes.
}

const ALIAS_TO_CODE = new Map(
	Object.entries({
		egyptian: "EG",
		egypt: "EG",
		masri: "EG",
		misri: "EG",
		"burkina faso": "BF",
		burkinabe: "BF",
		jordanian: "JO",
		jordan: "JO",
		saudi: "SA",
		"saudi arabian": "SA",
		india: "IN",
		indian: "IN",
		pakistan: "PK",
		pakistani: "PK",
		indonesia: "ID",
		indonesian: "ID",
		malaysia: "MY",
		malaysian: "MY",
		france: "FR",
		french: "FR",
		morocco: "MA",
		moroccan: "MA",
		algeria: "DZ",
		algerian: "DZ",
		tunisia: "TN",
		tunisian: "TN",
		sudan: "SD",
		sudanese: "SD",
		yemen: "YE",
		yemeni: "YE",
		turkey: "TR",
		turkish: "TR",
		syria: "SY",
		syrian: "SY",
		lebanon: "LB",
		lebanese: "LB",
		palestine: "PS",
		palestinian: "PS",
		america: "US",
		american: "US",
		usa: "US",
		"united states": "US",
		british: "GB",
		uk: "GB",
		"united kingdom": "GB",
		uae: "AE",
		emirati: "AE",
		oman: "OM",
		omani: "OM",
		qatar: "QA",
		qatari: "QA",
		kuwait: "KW",
		kuwaiti: "KW",
		bahrain: "BH",
		bahraini: "BH",
		iraq: "IQ",
		iraqi: "IQ",
		iran: "IR",
		iranian: "IR",
	})
);

const ARABIC_ALIAS_TO_CODE = new Map(
	Object.entries({
		"\u0645\u0635\u0631": "EG",
		"\u0645\u0635\u0631\u064a": "EG",
		"\u0645\u0635\u0631\u0649": "EG",
		"\u0645\u0635\u0631\u064a\u0629": "EG",
		"\u0628\u0648\u0631\u0643\u064a\u0646\u0627\u0641\u0627\u0633\u0648": "BF",
		"\u0628\u0648\u0631\u0643\u064a\u0646\u0627 \u0641\u0627\u0633\u0648": "BF",
		"\u0627\u0644\u0627\u0631\u062f\u0646": "JO",
		"\u0627\u0644\u0623\u0631\u062f\u0646": "JO",
		"\u0627\u0631\u062f\u0646\u064a": "JO",
		"\u0623\u0631\u062f\u0646\u064a": "JO",
		"\u0627\u0631\u062f\u0646\u064a\u0629": "JO",
		"\u0623\u0631\u062f\u0646\u064a\u0629": "JO",
		"\u0627\u0644\u0633\u0639\u0648\u062f\u064a\u0629": "SA",
		"\u0633\u0639\u0648\u062f\u064a": "SA",
		"\u0633\u0639\u0648\u062f\u064a\u0629": "SA",
		"\u0627\u0644\u0647\u0646\u062f": "IN",
		"\u0647\u0646\u062f\u064a": "IN",
		"\u0647\u0646\u062f\u064a\u0629": "IN",
		"\u0628\u0627\u0643\u0633\u062a\u0627\u0646": "PK",
		"\u0628\u0627\u0643\u0633\u062a\u0627\u0646\u064a": "PK",
		"\u0628\u0627\u0643\u0633\u062a\u0627\u0646\u064a\u0629": "PK",
		"\u0641\u0631\u0646\u0633\u0627": "FR",
		"\u0641\u0631\u0646\u0633\u064a": "FR",
		"\u0641\u0631\u0646\u0633\u064a\u0629": "FR",
		"\u0627\u0644\u0645\u063a\u0631\u0628": "MA",
		"\u0645\u063a\u0631\u0628\u064a": "MA",
		"\u0645\u063a\u0631\u0628\u064a\u0629": "MA",
		"\u0627\u0644\u062c\u0632\u0627\u0626\u0631": "DZ",
		"\u062c\u0632\u0627\u0626\u0631\u064a": "DZ",
		"\u062c\u0632\u0627\u0626\u0631\u064a\u0629": "DZ",
		"\u062a\u0648\u0646\u0633": "TN",
		"\u062a\u0648\u0646\u0633\u064a": "TN",
		"\u062a\u0648\u0646\u0633\u064a\u0629": "TN",
		"\u0627\u0644\u0633\u0648\u062f\u0627\u0646": "SD",
		"\u0633\u0648\u062f\u0627\u0646\u064a": "SD",
		"\u0633\u0648\u062f\u0627\u0646\u064a\u0629": "SD",
		"\u0627\u0644\u064a\u0645\u0646": "YE",
		"\u064a\u0645\u0646\u064a": "YE",
		"\u064a\u0645\u0646\u064a\u0629": "YE",
		"\u0627\u0644\u0627\u0645\u0627\u0631\u0627\u062a": "AE",
		"\u0627\u0644\u0625\u0645\u0627\u0631\u0627\u062a": "AE",
		"\u0627\u0645\u0627\u0631\u0627\u062a\u064a": "AE",
		"\u0625\u0645\u0627\u0631\u0627\u062a\u064a": "AE",
		"\u0639\u0645\u0627\u0646\u064a": "OM",
		"\u0639\u0645\u0627\u0646\u064a\u0629": "OM",
	})
);

function clean(value = "") {
	return String(value || "")
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^\p{L}\p{N}\s]/gu, " ")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
}

function cleanArabic(value = "") {
	return String(value || "")
		.replace(/[\u064b-\u065f\u0670]/g, "")
		.replace(/\u0640/g, "")
		.replace(/[^\u0600-\u06FF\s]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function codeIfValid(value = "") {
	const code = String(value || "").trim().toUpperCase();
	if (/^[A-Z]{2}$/.test(code) && countries.isValid(code)) return code;
	if (/^[A-Z]{3}$/.test(code)) {
		const alpha2 = countries.alpha3ToAlpha2(code);
		if (alpha2 && countries.isValid(alpha2)) return alpha2;
	}
	return "";
}

const COUNTRY_NAME_LOOKUP = (() => {
	const lookup = new Map();
	for (const lang of ["en", "ar", "fr", "es"]) {
		const names = countries.getNames(lang, { select: "official" }) || {};
		Object.entries(names).forEach(([code, name]) => {
			const normalized = clean(name);
			if (normalized && !lookup.has(normalized)) lookup.set(normalized, code);
			const normalizedArabic = cleanArabic(name);
			if (normalizedArabic && !lookup.has(normalizedArabic)) {
				lookup.set(normalizedArabic, code);
			}
		});
	}
	return lookup;
})();

function normalizeCountryCode(value = "", fallback = "") {
	const direct = codeIfValid(value) || codeIfValid(fallback);
	if (direct) return direct;

	const candidates = [value, fallback].filter(Boolean);
	for (const candidate of candidates) {
		const text = String(candidate || "").trim();
		for (const lang of ["en", "ar", "fr", "es"]) {
			const code = countries.getAlpha2Code(text, lang);
			if (code && countries.isValid(code)) return code;
		}
		const normalized = clean(text);
		if (normalized && ALIAS_TO_CODE.has(normalized)) {
			return ALIAS_TO_CODE.get(normalized);
		}
		if (normalized && COUNTRY_NAME_LOOKUP.has(normalized)) {
			return COUNTRY_NAME_LOOKUP.get(normalized);
		}
		const arabic = cleanArabic(text);
		if (arabic && ARABIC_ALIAS_TO_CODE.has(arabic)) {
			return ARABIC_ALIAS_TO_CODE.get(arabic);
		}
		if (arabic && COUNTRY_NAME_LOOKUP.has(arabic)) {
			return COUNTRY_NAME_LOOKUP.get(arabic);
		}
	}
	return "";
}

function countryNameFromCode(code = "") {
	const safeCode = codeIfValid(code);
	return safeCode ? countries.getName(safeCode, "en") || safeCode : "";
}

module.exports = {
	normalizeCountryCode,
	countryNameFromCode,
};
