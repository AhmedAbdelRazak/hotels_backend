"use strict";

function digitsToEnglishLocal(value = "") {
	const ranges = [
		[0x0660, 0x0669],
		[0x06f0, 0x06f9],
		[0x0966, 0x096f],
		[0x09e6, 0x09ef],
		[0x0ae6, 0x0aef],
		[0x0be6, 0x0bef],
		[0x0c66, 0x0c6f],
		[0x0ce6, 0x0cef],
		[0x0d66, 0x0d6f],
		[0x0e50, 0x0e59],
		[0x0ed0, 0x0ed9],
		[0xff10, 0xff19],
	];
	return Array.from(String(value || ""))
		.map((ch) => {
			const code = ch.codePointAt(0);
			const range = ranges.find(([start, end]) => code >= start && code <= end);
			return range ? String(code - range[0]) : ch;
		})
		.join("");
}

function normalizeNumberWordSearchText(value = "") {
	return digitsToEnglishLocal(String(value || ""))
		.toLowerCase()
		.normalize("NFD")
		.replace(/[\u0300-\u036f\u064b-\u065f\u0670]/g, "")
		.replace(/[\u0622\u0623\u0625\u0671]/g, "\u0627")
		.replace(/[\u0649\u06cc]/g, "\u064a")
		.replace(/[\u0629\u06c1\u06be\u06d5]/g, "\u0647")
		.replace(/\u06a9/g, "\u0643")
		.replace(/\u06af/g, "\u0643")
		.replace(/\u0686/g, "\u062c")
		.replace(/[\u2019']/g, "")
		.replace(/\u00a0/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function escapeRegex(value = "") {
	return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function addAlias(map, value, labels = []) {
	if (!map.has(value)) map.set(value, new Set());
	for (const label of labels) {
		const normalized = normalizeNumberWordSearchText(label);
		if (normalized && normalized.length > 1) map.get(value).add(normalized);
	}
}

function buildAliases() {
	const map = new Map();
	const en = [
		"zero",
		"one",
		"two",
		"three",
		"four",
		"five",
		"six",
		"seven",
		"eight",
		"nine",
		"ten",
		"eleven",
		"twelve",
		"thirteen",
		"fourteen",
		"fifteen",
		"sixteen",
		"seventeen",
		"eighteen",
		"nineteen",
	];
	const enOrdinals = [
		"zeroth",
		"first",
		"second",
		"third",
		"fourth",
		"fifth",
		"sixth",
		"seventh",
		"eighth",
		"ninth",
		"tenth",
		"eleventh",
		"twelfth",
		"thirteenth",
		"fourteenth",
		"fifteenth",
		"sixteenth",
		"seventeenth",
		"eighteenth",
		"nineteenth",
	];
	for (let i = 0; i < en.length; i += 1) addAlias(map, i, [en[i], enOrdinals[i]]);
	addAlias(map, 20, ["twenty", "twentieth"]);
	addAlias(map, 30, ["thirty", "thirtieth"]);
	for (let i = 1; i <= 9; i += 1) {
		addAlias(map, 20 + i, [`twenty ${en[i]}`, `twenty ${enOrdinals[i]}`]);
	}
	addAlias(map, 31, ["thirty one", "thirty first"]);

	const es = {
		0: ["cero"],
		1: ["uno", "una", "un", "primero", "primera"],
		2: ["dos"],
		3: ["tres"],
		4: ["cuatro"],
		5: ["cinco"],
		6: ["seis"],
		7: ["siete"],
		8: ["ocho"],
		9: ["nueve"],
		10: ["diez"],
		11: ["once"],
		12: ["doce"],
		13: ["trece"],
		14: ["catorce"],
		15: ["quince"],
		16: ["dieciseis"],
		17: ["diecisiete"],
		18: ["dieciocho"],
		19: ["diecinueve"],
		20: ["veinte"],
		21: ["veintiuno", "veintiuna", "veintiun"],
		22: ["veintidos"],
		23: ["veintitres"],
		24: ["veinticuatro"],
		25: ["veinticinco"],
		26: ["veintiseis"],
		27: ["veintisiete"],
		28: ["veintiocho"],
		29: ["veintinueve"],
		30: ["treinta"],
		31: ["treinta y uno", "treinta y una", "treinta y un"],
	};
	for (const [value, labels] of Object.entries(es)) addAlias(map, Number(value), labels);

	const fr = {
		0: ["zero"],
		1: ["un", "une", "premier", "premiere"],
		2: ["deux", "deuxieme"],
		3: ["trois", "troisieme"],
		4: ["quatre", "quatrieme"],
		5: ["cinq", "cinquieme"],
		6: ["six", "sixieme"],
		7: ["sept", "septieme"],
		8: ["huit", "huitieme"],
		9: ["neuf", "neuvieme"],
		10: ["dix", "dixieme"],
		11: ["onze"],
		12: ["douze"],
		13: ["treize"],
		14: ["quatorze"],
		15: ["quinze"],
		16: ["seize"],
		17: ["dix sept"],
		18: ["dix huit"],
		19: ["dix neuf"],
		20: ["vingt"],
		21: ["vingt et un", "vingt et une"],
		22: ["vingt deux"],
		23: ["vingt trois"],
		24: ["vingt quatre"],
		25: ["vingt cinq"],
		26: ["vingt six"],
		27: ["vingt sept"],
		28: ["vingt huit"],
		29: ["vingt neuf"],
		30: ["trente"],
		31: ["trente et un", "trente et une"],
	};
	for (const [value, labels] of Object.entries(fr)) addAlias(map, Number(value), labels);

	const msidOnes = [
		["kosong", "nol", "sifar"],
		["satu"],
		["dua"],
		["tiga"],
		["empat"],
		["lima"],
		["enam"],
		["tujuh"],
		["delapan", "lapan"],
		["sembilan"],
	];
	for (let i = 0; i < msidOnes.length; i += 1) addAlias(map, i, msidOnes[i]);
	addAlias(map, 10, ["sepuluh"]);
	addAlias(map, 11, ["sebelas"]);
	for (let i = 2; i <= 9; i += 1) addAlias(map, 10 + i, msidOnes[i].map((w) => `${w} belas`));
	addAlias(map, 20, ["dua puluh"]);
	for (let i = 1; i <= 9; i += 1) addAlias(map, 20 + i, msidOnes[i].map((w) => `dua puluh ${w}`));
	addAlias(map, 30, ["tiga puluh"]);
	addAlias(map, 31, ["tiga puluh satu"]);

	const ar = {
		0: ["\u0635\u0641\u0631"],
		1: ["\u0648\u0627\u062d\u062f", "\u0648\u0627\u062d\u062f\u0647", "\u0627\u062d\u062f", "\u0627\u062d\u062f\u0649"],
		2: [
			"\u0627\u062b\u0646\u064a\u0646",
			"\u0627\u062b\u0646\u0627\u0646",
			"\u0627\u062a\u0646\u064a\u0646",
			"\u062a\u0646\u064a\u0646",
			"\u0644\u0627\u062b\u0646\u064a\u0646",
			"\u0644\u0627\u062b\u0646\u0627\u0646",
			"\u0644\u0627\u062a\u0646\u064a\u0646",
		],
		3: [
			"\u062b\u0644\u0627\u062b\u0647",
			"\u062b\u0644\u0627\u062b",
			"\u062a\u0644\u0627\u062a\u0647",
			"\u062a\u0644\u0627\u062a",
			"\u0644\u062b\u0644\u0627\u062b\u0647",
			"\u0644\u062b\u0644\u0627\u062b",
			"\u0644\u062a\u0644\u0627\u062a\u0647",
			"\u0644\u062a\u0644\u0627\u062a",
		],
		4: [
			"\u0627\u0631\u0628\u0639\u0647",
			"\u0627\u0631\u0628\u0639",
			"\u0644\u0627\u0631\u0628\u0639\u0647",
			"\u0644\u0627\u0631\u0628\u0639",
		],
		5: [
			"\u062e\u0645\u0633\u0647",
			"\u062e\u0645\u0633",
			"\u0644\u062e\u0645\u0633\u0647",
			"\u0644\u062e\u0645\u0633",
		],
		6: ["\u0633\u062a\u0647", "\u0633\u062a", "\u0644\u0633\u062a\u0647", "\u0644\u0633\u062a"],
		7: ["\u0633\u0628\u0639\u0647", "\u0633\u0628\u0639", "\u0644\u0633\u0628\u0639\u0647", "\u0644\u0633\u0628\u0639"],
		8: [
			"\u062b\u0645\u0627\u0646\u064a\u0647",
			"\u062b\u0645\u0627\u0646",
			"\u062a\u0645\u0627\u0646\u064a\u0647",
			"\u062a\u0645\u0627\u0646",
			"\u0644\u062b\u0645\u0627\u0646\u064a\u0647",
			"\u0644\u062b\u0645\u0627\u0646",
			"\u0644\u062a\u0645\u0627\u0646\u064a\u0647",
			"\u0644\u062a\u0645\u0627\u0646",
		],
		9: ["\u062a\u0633\u0639\u0647", "\u062a\u0633\u0639", "\u0644\u062a\u0633\u0639\u0647", "\u0644\u062a\u0633\u0639"],
		10: ["\u0639\u0634\u0631\u0647", "\u0639\u0634\u0631", "\u0644\u0639\u0634\u0631\u0647", "\u0644\u0639\u0634\u0631"],
		11: ["\u0627\u062d\u062f \u0639\u0634\u0631", "\u0627\u062d\u062f\u0649 \u0639\u0634\u0631", "\u062d\u062f\u0627\u0634\u0631"],
		12: ["\u0627\u062b\u0646\u0627 \u0639\u0634\u0631", "\u0627\u062b\u0646\u064a \u0639\u0634\u0631", "\u0627\u062a\u0646\u0627\u0634\u0631"],
		13: ["\u062b\u0644\u0627\u062b\u0647 \u0639\u0634\u0631", "\u062a\u0644\u0627\u062a\u0627\u0634\u0631"],
		14: ["\u0627\u0631\u0628\u0639\u0647 \u0639\u0634\u0631", "\u0627\u0631\u0628\u0639\u062a\u0627\u0634\u0631"],
		15: ["\u062e\u0645\u0633\u0647 \u0639\u0634\u0631", "\u062e\u0645\u0633\u062a\u0627\u0634\u0631"],
		16: ["\u0633\u062a\u0647 \u0639\u0634\u0631", "\u0633\u062a\u0627\u0634\u0631"],
		17: ["\u0633\u0628\u0639\u0647 \u0639\u0634\u0631", "\u0633\u0628\u0639\u062a\u0627\u0634\u0631"],
		18: ["\u062b\u0645\u0627\u0646\u064a\u0647 \u0639\u0634\u0631", "\u062a\u0645\u0627\u0646\u062a\u0627\u0634\u0631"],
		19: ["\u062a\u0633\u0639\u0647 \u0639\u0634\u0631", "\u062a\u0633\u0639\u062a\u0627\u0634\u0631"],
		20: ["\u0639\u0634\u0631\u064a\u0646"],
		30: ["\u062b\u0644\u0627\u062b\u064a\u0646", "\u062a\u0644\u0627\u062a\u064a\u0646"],
	};
	for (const [value, labels] of Object.entries(ar)) addAlias(map, Number(value), labels);
	for (let i = 1; i <= 9; i += 1) {
		const ones = Array.from(map.get(i) || []).filter((label) => /[\u0600-\u06ff]/.test(label));
		for (const one of ones) addAlias(map, 20 + i, [`${one} \u0648 \u0639\u0634\u0631\u064a\u0646`, `${one} \u0648\u0639\u0634\u0631\u064a\u0646`]);
	}
	addAlias(map, 31, ["\u0648\u0627\u062d\u062f \u0648 \u062b\u0644\u0627\u062b\u064a\u0646", "\u0648\u0627\u062d\u062f \u0648\u062b\u0644\u0627\u062b\u064a\u0646"]);

	const hiUr = {
		0: ["shunya", "\u0936\u0942\u0928\u094d\u092f", "\u0635\u0641\u0631"],
		1: ["ek", "\u090f\u0915", "\u0627\u064a\u0643"],
		2: ["do", "\u0926\u094b", "\u062f\u0648"],
		3: ["teen", "\u0924\u0940\u0928", "\u062a\u064a\u0646"],
		4: ["char", "chaar", "\u091a\u093e\u0930", "\u0686\u0627\u0631"],
		5: ["panch", "paanch", "\u092a\u093e\u0902\u091a", "\u067e\u0627\u0646\u0686"],
		6: ["che", "chhe", "\u091b\u0939", "\u0686\u06be"],
		7: ["saat", "\u0938\u093e\u0924", "\u0633\u0627\u062a"],
		8: ["aath", "\u0906\u0920", "\u0622\u0679\u06be"],
		9: ["nau", "\u0928\u094c", "\u0646\u0648"],
		10: ["das", "\u0926\u0938", "\u062f\u0633"],
		11: ["gyarah", "yarah", "\u0917\u094d\u092f\u093e\u0930\u0939", "\u06af\u064a\u0627\u0631\u06c1"],
		12: ["barah", "bara", "\u092c\u093e\u0930\u0939", "\u0628\u0627\u0631\u06c1"],
		13: ["terah", "\u0924\u0947\u0930\u0939", "\u062a\u064a\u0631\u06c1"],
		14: ["chaudah", "\u091a\u094c\u0926\u0939", "\u0686\u0648\u062f\u06c1"],
		15: ["pandrah", "pandra", "\u092a\u0902\u0926\u094d\u0930\u0939", "\u067e\u0646\u062f\u0631\u06c1"],
		16: ["solah", "\u0938\u094b\u0932\u0939", "\u0633\u0648\u0644\u06c1"],
		17: ["satrah", "\u0938\u0924\u094d\u0930\u0939", "\u0633\u062a\u0631\u06c1"],
		18: ["atharah", "\u0905\u0920\u093e\u0930\u0939", "\u0627\u0679\u06be\u0627\u0631\u06c1"],
		19: ["unnees", "unnis", "\u0909\u0928\u094d\u0928\u0940\u0938", "\u0627\u0646\u064a\u0633"],
		20: ["bees", "bis", "\u092c\u0940\u0938", "\u0628\u064a\u0633"],
		21: ["ikkees", "ikkis", "\u0907\u0915\u094d\u0915\u0940\u0938", "\u0627\u0643\u064a\u0633"],
		22: ["bais", "\u092c\u093e\u0908\u0938", "\u0628\u0627\u0626\u064a\u0633"],
		23: ["teis", "\u0924\u0947\u0908\u0938", "\u062a\u0626\u064a\u0633"],
		24: ["chaubis", "\u091a\u094c\u092c\u0940\u0938", "\u0686\u0648\u0628\u064a\u0633"],
		25: ["pachis", "pachees", "\u092a\u091a\u094d\u091a\u0940\u0938", "\u067e\u0686\u064a\u0633"],
		26: ["chabbis", "\u091b\u092c\u094d\u092c\u0940\u0938", "\u0686\u06be\u0628\u064a\u0633"],
		27: ["sattais", "\u0938\u0924\u094d\u0924\u093e\u0908\u0938", "\u0633\u062a\u0627\u0626\u064a\u0633"],
		28: ["atthais", "\u0905\u0920\u094d\u0920\u093e\u0908\u0938", "\u0627\u0679\u06be\u0627\u0626\u064a\u0633"],
		29: ["untees", "untis", "\u0909\u0928\u0924\u0940\u0938", "\u0627\u0646\u062a\u064a\u0633"],
		30: ["tees", "\u0924\u0940\u0938", "\u062a\u064a\u0633"],
		31: ["ikattis", "ikathees", "\u0907\u0915\u0924\u0940\u0938", "\u0627\u0643\u062a\u064a\u0633"],
	};
	for (const [value, labels] of Object.entries(hiUr)) addAlias(map, Number(value), labels);

	return Array.from(map.entries())
		.flatMap(([value, labels]) =>
			Array.from(labels).map((label) => ({ value, label }))
		)
		.sort((a, b) => b.label.length - a.label.length);
}

const NUMBER_ALIASES = buildAliases();
const TOKEN_CHARS = "A-Za-z0-9\\u0600-\\u06ff\\u0900-\\u097f";

function normalizeNumberWordsForParsing(value = "") {
	let text = normalizeNumberWordSearchText(value);
	if (!/[a-z\u0600-\u06ff\u0900-\u097f]/i.test(text)) return text;
	for (const alias of NUMBER_ALIASES) {
		const labelPattern = escapeRegex(alias.label).replace(/\s+/g, "[\\s-]+");
		const pattern = new RegExp(
			`(^|[^${TOKEN_CHARS}])${labelPattern}(?=$|[^${TOKEN_CHARS}])`,
			"gi"
		);
		text = text.replace(pattern, `$1${alias.value}`);
	}
	return text.replace(/\s+/g, " ").trim();
}

function numberFromWords(value = "", { min = 0, max = 31 } = {}) {
	const normalized = normalizeNumberWordsForParsing(value);
	if (!/^\d{1,2}$/.test(normalized)) return null;
	const number = Number(normalized);
	if (!Number.isFinite(number) || number < min || number > max) return null;
	return number;
}

module.exports = {
	normalizeNumberWordsForParsing,
	numberFromWords,
};
