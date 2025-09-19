/** @format */
// Stable pick based on a string key (caseId)
function stablePick(arr, key) {
	let hash = 0;
	for (let i = 0; i < key.length; i++)
		hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
	return arr[hash % arr.length];
}

// Gender‑neutral, Islamic‑friendly support names (per language code)
const NAMES = {
	en: [
		"Aisha",
		"Mona",
		"Maryam",
		"Zainab",
		"Fatimah",
		"Omar",
		"Ali",
		"Yusuf",
		"Ibrahim",
	],
	ar: [
		"منى",
		"عائشة",
		"مريم",
		"زينب",
		"فاطمة",
		"أحمد",
		"علي",
		"يوسف",
		"إبراهيم",
	],
	"ar-eg": [
		"منى",
		"عائشة",
		"مريم",
		"زينب",
		"فاطمة",
		"أحمد",
		"علي",
		"يوسف",
		"إبراهيم",
	],
	"ar-sa": [
		"منى",
		"عائشة",
		"مريم",
		"زينب",
		"فاطمة",
		"عبدالله",
		"علي",
		"يوسف",
		"إبراهيم",
	],
	es: ["Aisha", "Aicha", "Mona", "Mariam", "Zainab", "Omar", "Ali", "Yusuf"],
	fr: ["Aïcha", "Mona", "Mariam", "Zaynab", "Fatima", "Omar", "Ali", "Youssef"],
	ur: ["عائشہ", "مونا", "مریم", "زینب", "فاطمہ", "عمر", "علی", "یوسف"],
	hi: ["आयशा", "मोना", "मरियम", "ज़ैनब", "फ़ातिमा", "ओमर", "अली", "यूसुफ़"],
};

function pickSupportName(langCode = "en", caseId = "") {
	const lc = (langCode || "en").toLowerCase();
	const list = NAMES[lc] || NAMES.en;
	return stablePick(list, caseId || Math.random().toString(36).slice(2));
}

module.exports = { pickSupportName };
