// aiagent/core/nlu.js
const { chat } = require("./openai");

/* ---------------- helpers ---------------- */
function firstNameOf(name = "") {
	const s = String(name || "").trim();
	if (!s) return "Guest";
	return s.split(/\s+/)[0];
}

const ROOM_SYNONYMS = [
	{
		key: "doubleRooms",
		terms: [
			"double",
			"standard",
			"king",
			"queen",
			"twin",
			"\u063a\u0631\u0641\u0629 \u0645\u0632\u062f\u0648\u062c\u0629",
			"\u0645\u0632\u062f\u0648\u062c\u0629",
			"\u062b\u0646\u0627\u0626\u064a\u0629",
			"\u062f\u0628\u0644",
			"غرفة مزدوجة",
			"ثنائية",
		],
	},
	{
		key: "tripleRooms",
		terms: [
			"triple",
			"3 bed",
			"3 beds",
			"three bed",
			"three beds",
			"3 people",
			"three people",
			"3 persons",
			"three persons",
			"3 individuals",
			"three individuals",
			"room for 3",
			"rooms for 3",
			"room for three",
			"rooms for three",
			"ثلاثية",
		],
	},
	{
		key: "quadRooms",
		terms: [
			"quad",
			"4 bed",
			"4 beds",
			"four bed",
			"four beds",
			"4 people",
			"four people",
			"4 persons",
			"four persons",
			"4 individuals",
			"four individuals",
			"room for 4",
			"rooms for 4",
			"room for four",
			"rooms for four",
			"رباعية",
		],
	},
	{
		key: "familyRooms",
		terms: [
			"family",
			"quintuple",
			"5 bed",
			"5 beds",
			"five bed",
			"five beds",
			"5 people",
			"five people",
			"5 persons",
			"five persons",
			"room for 5",
			"rooms for 5",
			"room for five",
			"rooms for five",
			"خماسية",
		],
	},
];

ROOM_SYNONYMS.push(
	{
		key: "tripleRooms",
		terms: [
			"\u063a\u0631\u0641\u0629 \u062b\u0644\u0627\u062b\u064a\u0629",
			"\u062b\u0644\u0627\u062b\u064a\u0629",
			"\u062a\u0644\u0627\u062a\u0629",
			"\u062a\u0644\u062a",
		],
	},
	{
		key: "quadRooms",
		terms: [
			"\u063a\u0631\u0641\u0629 \u0631\u0628\u0627\u0639\u064a\u0629",
			"\u0631\u0628\u0627\u0639\u064a\u0629",
		],
	},
	{
		key: "familyRooms",
		terms: ["\u0639\u0627\u0626\u0644\u064a\u0629", "\u063a\u0631\u0641\u0629 \u0639\u0627\u0626\u0644\u064a\u0629"],
	}
);

function escapeRoomTerm(value = "") {
	return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function roomTermMatches(text = "", term = "") {
	const low = String(text || "").toLowerCase();
	const raw = String(term || "").toLowerCase().trim();
	if (!raw) return false;
	if (/^[a-z0-9\s-]+$/.test(raw)) {
		const pattern = escapeRoomTerm(raw).replace(/[\s-]+/g, "[\\s-]+");
		return new RegExp(`(^|[^a-z0-9])${pattern}([^a-z0-9]|$)`).test(low);
	}
	return low.includes(raw);
}

function mapRoomToKey(text = "") {
	const low = text.toLowerCase();
	for (const r of ROOM_SYNONYMS) {
		if (r.terms.some((t) => roomTermMatches(low, t))) return r.key;
	}
	return null;
}

const MONTHS = {
	jan: 1,
	january: 1,
	feb: 2,
	february: 2,
	mar: 3,
	march: 3,
	apr: 4,
	april: 4,
	may: 5,
	jun: 6,
	june: 6,
	jul: 7,
	july: 7,
	aug: 8,
	august: 8,
	sep: 9,
	september: 9,
	oct: 10,
	october: 10,
	nov: 11,
	november: 11,
	dec: 12,
	december: 12,
	ene: 1,
	enero: 1,
	febrero: 2,
	marzo: 3,
	abr: 4,
	abril: 4,
	mayo: 5,
	junio: 6,
	julio: 7,
	agosto: 8,
	septiembre: 9,
	setiembre: 9,
	octubre: 10,
	noviembre: 11,
	diciembre: 12,
	janv: 1,
	janvier: 1,
	fev: 2,
	fevr: 2,
	fevrier: 2,
	mars: 3,
	avril: 4,
	mai: 5,
	juin: 6,
	juillet: 7,
	aout: 8,
	sept: 9,
	septembre: 9,
	octobre: 10,
	novembre: 11,
	decembre: 12,
	"\u064a\u0646\u0627\u064a\u0631": 1,
	"\u0641\u0628\u0631\u0627\u064a\u0631": 2,
	"\u0645\u0627\u0631\u0633": 3,
	"\u0627\u0628\u0631\u064a\u0644": 4,
	"\u0623\u0628\u0631\u064a\u0644": 4,
	"\u0645\u0627\u064a\u0648": 5,
	"\u064a\u0648\u0646\u064a\u0648": 6,
	"\u064a\u0648\u0644\u064a\u0648": 7,
	"\u0627\u063a\u0633\u0637\u0633": 8,
	"\u0623\u063a\u0633\u0637\u0633": 8,
	"\u0633\u0628\u062a\u0645\u0628\u0631": 9,
	"\u0627\u0643\u062a\u0648\u0628\u0631": 10,
	"\u0623\u0643\u062a\u0648\u0628\u0631": 10,
	"\u0646\u0648\u0641\u0645\u0628\u0631": 11,
	"\u062f\u064a\u0633\u0645\u0628\u0631": 12,
};

const HIJRI_MONTH_LABELS = [
	["muharram", "muharam", "\u0645\u062d\u0631\u0645"],
	["safar", "\u0635\u0641\u0631"],
	[
		"rabi al awal",
		"rabi al awwal",
		"rabi awal",
		"rabi 1",
		"\u0631\u0628\u064a\u0639 \u0627\u0644\u0627\u0648\u0644",
		"\u0631\u0628\u064a\u0639 \u0627\u0648\u0644",
		"\u0631\u0628\u064a\u0639 1",
	],
	[
		"rabi al thani",
		"rabi thani",
		"rabi 2",
		"\u0631\u0628\u064a\u0639 \u0627\u0644\u062b\u0627\u0646\u064a",
		"\u0631\u0628\u064a\u0639 \u062b\u0627\u0646\u064a",
		"\u0631\u0628\u064a\u0639 2",
	],
	[
		"jumada al awal",
		"jumada al awwal",
		"jumada awal",
		"jumada 1",
		"\u062c\u0645\u0627\u062f\u0649 \u0627\u0644\u0627\u0648\u0644\u0649",
		"\u062c\u0645\u0627\u062f\u0649 \u0627\u0644\u0627\u0648\u0644",
		"\u062c\u0645\u0627\u062f\u0649 \u0627\u0648\u0644",
	],
	[
		"jumada al thani",
		"jumada thani",
		"jumada al akhira",
		"jumada 2",
		"\u062c\u0645\u0627\u062f\u0649 \u0627\u0644\u062b\u0627\u0646\u064a",
		"\u062c\u0645\u0627\u062f\u0649 \u062b\u0627\u0646\u064a",
		"\u062c\u0645\u0627\u062f\u0649 \u0627\u0644\u0627\u062e\u0631\u0629",
	],
	["rajab", "\u0631\u062c\u0628"],
	["shaaban", "shaban", "shaban", "\u0634\u0639\u0628\u0627\u0646"],
	["ramadan", "ramadhan", "\u0631\u0645\u0636\u0627\u0646"],
	["shawwal", "\u0634\u0648\u0627\u0644"],
	[
		"dhu al qadah",
		"dhul qadah",
		"dhu al qidah",
		"dhul qidah",
		"\u0630\u0648 \u0627\u0644\u0642\u0639\u062f\u0629",
		"\u0630\u0648 \u0627\u0644\u0642\u0639\u062f\u0647",
		"\u0630\u0648\u0627\u0644\u0642\u0639\u062f\u0629",
		"\u0630\u0648\u0627\u0644\u0642\u0639\u062f\u0647",
	],
	[
		"dhu al hijjah",
		"dhul hijjah",
		"dhu al hija",
		"dhul hija",
		"\u0630\u0648 \u0627\u0644\u062d\u062c\u0629",
		"\u0630\u0648 \u0627\u0644\u062d\u062c\u0647",
		"\u0630\u0648\u0627\u0644\u062d\u062c\u0629",
		"\u0630\u0648\u0627\u0644\u062d\u062c\u0647",
	],
];

const HIJRI_MONTHS = HIJRI_MONTH_LABELS.flatMap((labels, index) =>
	labels.map((label) => ({ label, month: index + 1 }))
);

function normalizeArabicSearchText(value = "") {
	return digitsToEnglish(String(value || ""))
		.toLowerCase()
		.normalize("NFD")
		.replace(/[\u0300-\u036f\u064b-\u065f\u0670]/g, "")
		.replace(/[\u0622\u0623\u0625\u0671]/g, "\u0627")
		.replace(/\u0649/g, "\u064a")
		.replace(/\u0629/g, "\u0647")
		.replace(/[_,.;:()[\]{}]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function normalizeHijriLabel(label = "") {
	return normalizeArabicSearchText(label)
		.replace(/\bal[-\s]*/g, "al ")
		.replace(/[-_/]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function escapeRegex(value = "") {
	return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hijriLabelRegex(label = "") {
	return normalizeHijriLabel(label)
		.split(/\s+/)
		.map(escapeRegex)
		.join("\\s+");
}

const HIJRI_MONTH_REGEX_PART = Array.from(
	new Set(HIJRI_MONTHS.map((entry) => hijriLabelRegex(entry.label)).filter(Boolean))
)
	.sort((a, b) => b.length - a.length)
	.join("|");

function hijriMonthFromText(value = "") {
	const normalized = normalizeHijriLabel(value);
	for (const entry of HIJRI_MONTHS) {
		const label = normalizeHijriLabel(entry.label);
		if (normalized === label || normalized.includes(label)) return entry.month;
	}
	return null;
}

function hijriDisplay(month, day, year) {
	const label = HIJRI_MONTH_LABELS[Number(month) - 1]?.[0] || `month ${month}`;
	return `${Number(day)} ${label} ${Number(year)} AH`;
}

function hijriToJulianDay(year, month, day) {
	const y = Number(year);
	const m = Number(month);
	const d = Number(day);
	return (
		Math.floor((11 * y + 3) / 30) +
		354 * y +
		30 * m -
		Math.floor((m - 1) / 2) +
		d +
		1948440 -
		385
	);
}

function julianDayToGregorianISO(julianDay) {
	let l = Math.floor(julianDay) + 68569;
	const n = Math.floor((4 * l) / 146097);
	l -= Math.floor((146097 * n + 3) / 4);
	const i = Math.floor((4000 * (l + 1)) / 1461001);
	l = l - Math.floor((1461 * i) / 4) + 31;
	const j = Math.floor((80 * l) / 2447);
	const day = l - Math.floor((2447 * j) / 80);
	l = Math.floor(j / 11);
	const month = j + 2 - 12 * l;
	const year = 100 * (n - 49) + i + l;
	return isoFromParts(year, month, day);
}

function isoAddDays(iso, offset) {
	const d = new Date(`${iso}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + offset);
	return d.toISOString().slice(0, 10);
}

function intlHijriParts(iso) {
	try {
		const date = new Date(`${iso}T12:00:00Z`);
		const formatter = new Intl.DateTimeFormat("en-u-ca-islamic-umalqura", {
			timeZone: "UTC",
			day: "numeric",
			month: "numeric",
			year: "numeric",
		});
		const parts = formatter.formatToParts(date);
		const get = (type) =>
			Number(String(parts.find((part) => part.type === type)?.value || "").replace(/\D/g, ""));
		const year = get("year");
		const month = get("month");
		const day = get("day");
		return year && month && day ? { year, month, day } : null;
	} catch {
		return null;
	}
}

function hijriToGregorianISO(year, month, day) {
	const y = Number(year);
	const m = Number(month);
	const d = Number(day);
	if (!y || !m || !d || m < 1 || m > 12 || d < 1 || d > 30) return null;

	const civilISO = julianDayToGregorianISO(hijriToJulianDay(y, m, d));
	if (!civilISO) return null;

	for (let offset = -7; offset <= 7; offset += 1) {
		const candidate = isoAddDays(civilISO, offset);
		const parts = intlHijriParts(candidate);
		if (parts && parts.year === y && parts.month === m && parts.day === d) {
			return candidate;
		}
	}
	return civilISO;
}

function todayISO() {
	return new Date().toISOString().slice(0, 10);
}

function nextHijriYearForMonthDay(month, day, baseISO = todayISO()) {
	const current = intlHijriParts(baseISO);
	if (!current) return null;
	let year = current.year;
	let candidate = hijriToGregorianISO(year, month, day);
	while (candidate && candidate < baseISO && year < current.year + 3) {
		year += 1;
		candidate = hijriToGregorianISO(year, month, day);
	}
	return candidate ? year : null;
}

function quickHijriDateRangeNoYear(text = "") {
	const raw = normalizeArabicSearchText(text);
	if (
		/\b(last|past|previous)\b|\u0641\u0627\u062a|\u0627\u0644\u0645\u0627\u0636\u064a|\u0627\u0644\u0644\u064a \u0641\u0627\u062a|\u0627\u0644\u0649 \u0641\u0627\u062a/.test(
			raw
		)
	) {
		return { checkinISO: null, checkoutISO: null, raw: null };
	}
	const dayPart = "(\\d{1,2})";
	const connector =
		"(?:-|to|until|through|till|from|\\u0627\\u0644\\u0649|\\u0627\\u0644\\u064a|\\u062d\\u062a\\u0649|\\u0644)";
	const sharedMonthNoYear = new RegExp(
		`${dayPart}\\s+${connector}\\s+${dayPart}\\s+(${HIJRI_MONTH_REGEX_PART})`,
		"i"
	);
	const match = raw.match(sharedMonthNoYear);
	let month = null;
	let checkinDay = null;
	let checkoutDay = null;
	if (match) {
		month = hijriMonthFromText(match[3]);
		checkinDay = Number(match[1]);
		checkoutDay = Number(match[2]);
	} else {
		const fullNoYear = new RegExp(
			`${dayPart}\\s+(${HIJRI_MONTH_REGEX_PART})`,
			"gi"
		);
		const found = [];
		let foundMatch = null;
		while ((foundMatch = fullNoYear.exec(raw))) {
			const foundMonth = hijriMonthFromText(foundMatch[2]);
			const foundDay = Number(foundMatch[1]);
			if (foundMonth && foundDay) found.push({ month: foundMonth, day: foundDay });
		}
		if (found.length >= 2 && found[0].month === found[1].month) {
			month = found[0].month;
			checkinDay = found[0].day;
			checkoutDay = found[1].day;
		}
	}
	if (!month || !checkinDay || !checkoutDay) {
		return { checkinISO: null, checkoutISO: null, raw: null };
	}
	if (!month || !checkinDay || !checkoutDay || checkoutDay <= checkinDay) {
		return { checkinISO: null, checkoutISO: null, raw: null };
	}
	const year = nextHijriYearForMonthDay(month, checkinDay);
	if (!year) return { checkinISO: null, checkoutISO: null, raw: null };
	const checkinISO = hijriToGregorianISO(year, month, checkinDay);
	const checkoutISO = hijriToGregorianISO(year, month, checkoutDay);
	if (!checkinISO || !checkoutISO || checkoutISO <= checkinISO) {
		return { checkinISO: null, checkoutISO: null, raw: null };
	}
	return {
		checkinISO,
		checkoutISO,
		raw: {
			calendar: "hijri",
			checkin: hijriDisplay(month, checkinDay, year),
			checkout: hijriDisplay(month, checkoutDay, year),
			checkinHijri: { year, month, day: checkinDay },
			checkoutHijri: { year, month, day: checkoutDay },
		},
	};
}

function quickHijriDateRange(text = "") {
	if (!HIJRI_MONTH_REGEX_PART) {
		return { checkinISO: null, checkoutISO: null, raw: null };
	}
	const raw = normalizeArabicSearchText(text);
	const hasExplicitHijriYear = /\b(?:1[34]\d{2}|15\d{2})\b/.test(raw);
	if (!hasExplicitHijriYear) {
		const noYear = quickHijriDateRangeNoYear(raw);
		if (noYear.checkinISO && noYear.checkoutISO) return noYear;
	}
	const yearPart = "(1[34]\\d{2}|15\\d{2})";
	const dayPart = "(\\d{1,2})";
	const connector = "(?:-|to|until|through|till|from|الى|الي|حتى|ل)";

	const connectorUnicode =
		"(?:-|to|until|through|till|from|\\u0627\\u0644\\u0649|\\u0627\\u0644\\u064a|\\u062d\\u062a\\u0649|\\u0644)";
	const sharedMonth = new RegExp(
		`${dayPart}\\s+${connectorUnicode}\\s+${dayPart}\\s+(${HIJRI_MONTH_REGEX_PART})\\s+${yearPart}`,
		"i"
	);
	let match = raw.match(sharedMonth);
	if (match) {
		const month = hijriMonthFromText(match[3]);
		const year = Number(match[4]);
		const checkinDay = Number(match[1]);
		const checkoutDay = Number(match[2]);
		const checkinISO = hijriToGregorianISO(year, month, checkinDay);
		const checkoutISO = hijriToGregorianISO(year, month, checkoutDay);
		if (checkinISO && checkoutISO && checkoutISO > checkinISO) {
			return {
				checkinISO,
				checkoutISO,
				raw: {
					calendar: "hijri",
					checkin: hijriDisplay(month, checkinDay, year),
					checkout: hijriDisplay(month, checkoutDay, year),
					checkinHijri: { year, month, day: checkinDay },
					checkoutHijri: { year, month, day: checkoutDay },
				},
			};
		}
	}

	const fullDate = new RegExp(
		`${dayPart}\\s+(${HIJRI_MONTH_REGEX_PART})\\s+${yearPart}`,
		"gi"
	);
	const found = [];
	while ((match = fullDate.exec(raw))) {
		const month = hijriMonthFromText(match[2]);
		const day = Number(match[1]);
		const year = Number(match[3]);
		const iso = hijriToGregorianISO(year, month, day);
		if (iso) found.push({ iso, year, month, day });
	}

	if (found.length < 2) {
		const monthDayYear = new RegExp(
			`(${HIJRI_MONTH_REGEX_PART})\\s+${dayPart}\\s*,?\\s+${yearPart}`,
			"gi"
		);
		while ((match = monthDayYear.exec(raw))) {
			const month = hijriMonthFromText(match[1]);
			const day = Number(match[2]);
			const year = Number(match[3]);
			const iso = hijriToGregorianISO(year, month, day);
			if (iso) found.push({ iso, year, month, day });
		}
	}

	if (found.length >= 2 && found[1].iso > found[0].iso) {
		return {
			checkinISO: found[0].iso,
			checkoutISO: found[1].iso,
			raw: {
				calendar: "hijri",
				checkin: hijriDisplay(found[0].month, found[0].day, found[0].year),
				checkout: hijriDisplay(found[1].month, found[1].day, found[1].year),
				checkinHijri: {
					year: found[0].year,
					month: found[0].month,
					day: found[0].day,
				},
				checkoutHijri: {
					year: found[1].year,
					month: found[1].month,
					day: found[1].day,
				},
			},
		};
	}
	return { checkinISO: null, checkoutISO: null, raw: null };
}

function isoFromParts(year, month, day) {
	const y = Number(year);
	const m = Number(month);
	const d = Number(day);
	const date = new Date(Date.UTC(y, m - 1, d));
	if (
		date.getUTCFullYear() !== y ||
		date.getUTCMonth() !== m - 1 ||
		date.getUTCDate() !== d
	) {
		return null;
	}
	return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function escapeDateRegex(value = "") {
	return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeDateSearchText(value = "") {
	return digitsToEnglish(String(value || ""))
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/\u00a0/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function todayISO() {
	return new Date().toISOString().slice(0, 10);
}

function isoYear(iso = "") {
	const match = String(iso || "").match(/^(\d{4})-/);
	return match ? Number(match[1]) : new Date().getUTCFullYear();
}

function inferFutureISO({ day, month, year = null }, anchorYear = null) {
	const explicitYear = Number(year || 0);
	if (explicitYear) return isoFromParts(explicitYear, month, day);
	const currentYear = Number(anchorYear || new Date().getUTCFullYear());
	let iso = isoFromParts(currentYear, month, day);
	if (!iso) return null;
	if (iso < todayISO()) {
		iso = isoFromParts(currentYear + 1, month, day);
	}
	return iso;
}

function normalizeGregorianMonthRange(parts = []) {
	if (!Array.isArray(parts) || parts.length < 2) return null;
	const first = parts[0];
	const second = parts[1];
	const checkinISO = inferFutureISO(first);
	if (!checkinISO) return null;
	const checkoutAnchorYear = second.year ? null : isoYear(checkinISO);
	let checkoutISO = inferFutureISO(second, checkoutAnchorYear);
	if (!checkoutISO) return null;
	while (checkoutISO <= checkinISO) {
		const nextYear = isoYear(checkoutISO) + 1;
		checkoutISO = isoFromParts(nextYear, second.month, second.day);
		if (!checkoutISO) return null;
	}
	return {
		checkinISO,
		checkoutISO,
		raw: {
			checkin: checkinISO,
			checkout: checkoutISO,
			calendar: "gregorian",
		},
	};
}

function quickGregorianMonthDateRange(text = "") {
	const raw = normalizeDateSearchText(text);
	const monthNames = Object.keys(MONTHS)
		.sort((a, b) => b.length - a.length)
		.map(escapeDateRegex)
		.join("|");
	const boundary = "[^A-Za-z0-9\\u0600-\\u06FF]";
	const matches = [];
	const pushMatch = (index, day, monthName, year) => {
		const normalizedMonth = normalizeDateSearchText(monthName).toLowerCase();
		const month = MONTHS[normalizedMonth];
		const dayNumber = Number(day);
		if (!month || !dayNumber) return;
		matches.push({
			index,
			day: dayNumber,
			month,
			year: year ? Number(year) : null,
		});
	};

	const dayMonth = new RegExp(
		`(^|${boundary})(?:from\\s+|du\\s+|de\\s+|del\\s+|al\\s+|au\\s+|le\\s+|el\\s+|\\u0645\\u0646\\s+|\\u0627\\u0644\\u0649\\s+|\\u0625\\u0644\\u0649\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:of\\s+|de\\s+|du\\s+)?(${monthNames})(?:\\s*,?\\s*(20\\d{2}))?(?=$|${boundary})`,
		"gi"
	);
	let match = null;
	while ((match = dayMonth.exec(raw))) {
		pushMatch(match.index, match[2], match[3], match[4]);
	}

	const monthDay = new RegExp(
		`(^|${boundary})(${monthNames})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:\\s*,?\\s*(20\\d{2}))?(?=$|${boundary})`,
		"gi"
	);
	while ((match = monthDay.exec(raw))) {
		pushMatch(match.index, match[3], match[2], match[4]);
	}

	const ordered = matches
		.sort((a, b) => a.index - b.index)
		.filter((item, index, list) => {
			const prev = list[index - 1];
			return (
				!prev ||
				prev.index !== item.index ||
				prev.day !== item.day ||
				prev.month !== item.month
			);
		});

	return normalizeGregorianMonthRange(ordered);
}

function quickArabicGregorianMonthDateRange(text = "") {
	const raw = normalizeArabicSearchText(text);
	if (!/[\u0600-\u06FF]/.test(raw)) return null;
	const monthLookup = new Map(
		Object.keys(MONTHS)
			.filter((key) => /[\u0600-\u06FF]/.test(key))
			.map((key) => [normalizeArabicSearchText(key), MONTHS[key]])
	);
	const monthNames = [...monthLookup.keys()]
		.sort((a, b) => b.length - a.length)
		.map(escapeDateRegex)
		.join("|");
	if (!monthNames) return null;
	const matches = [];
	const re = new RegExp(
		`(?:^|\\s)(?:\\u0645\\u0646\\s+|\\u0627\\u0644\\u0649\\s+)?(\\d{1,2})\\s+(${monthNames})(?:\\s+(20\\d{2}))?`,
		"g"
	);
	let match = null;
	while ((match = re.exec(raw))) {
		const month = monthLookup.get(match[2]);
		const day = Number(match[1]);
		if (!month || !day) continue;
		matches.push({
			index: match.index,
			day,
			month,
			year: match[3] ? Number(match[3]) : null,
		});
	}
	return normalizeGregorianMonthRange(matches);
}

function quickDateRange(text = "") {
	const raw = digitsToEnglish(String(text || ""));
	const hijri = quickHijriDateRange(raw);
	if (hijri.checkinISO && hijri.checkoutISO) return hijri;
	const isoMatches = raw.match(/\b20\d{2}-\d{2}-\d{2}\b/g);
	if (isoMatches?.length >= 2) {
		return {
			checkinISO: isoMatches[0],
			checkoutISO: isoMatches[1],
			raw: {
				checkin: isoMatches[0],
				checkout: isoMatches[1],
				calendar: "gregorian",
			},
		};
	}
	const monthRange = quickGregorianMonthDateRange(raw);
	if (monthRange?.checkinISO && monthRange?.checkoutISO) return monthRange;
	const arabicMonthRange = quickArabicGregorianMonthDateRange(raw);
	if (arabicMonthRange?.checkinISO && arabicMonthRange?.checkoutISO) {
		return arabicMonthRange;
	}
	return { checkinISO: null, checkoutISO: null, raw: null };
}

function asciiize(s = "") {
	return String(s)
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^\x20-\x7E]/g, "");
}
function digitsToEnglish(s = "") {
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
	return Array.from(String(s || ""))
		.map((ch) => {
			const code = ch.codePointAt(0);
			const range = ranges.find(([start, end]) => code >= start && code <= end);
			return range ? String(code - range[0]) : ch;
		})
		.join("");
}

function isPastISO(iso) {
	if (!iso) return false;
	const d = new Date(iso);
	const today = new Date();
	today.setHours(0, 0, 0, 0);
	return d < today;
}
function bumpDatesToFuture({ checkinISO, checkoutISO }) {
	if (!checkinISO) return { checkinISO, checkoutISO };
	let ci = new Date(checkinISO);
	let co = checkoutISO ? new Date(checkoutISO) : null;
	const today = new Date();
	today.setHours(0, 0, 0, 0);

	// keep the same month/day; bump year until not in the past
	while (ci < today) {
		ci.setFullYear(ci.getFullYear() + 1);
		if (co) co.setFullYear(co.getFullYear() + 1);
	}
	if (co && co <= ci) {
		const nights = Math.max(
			1,
			Math.round(
				(new Date(checkoutISO) - new Date(checkinISO)) / (24 * 3600 * 1000)
			)
		);
		co = new Date(ci.getTime() + nights * 24 * 3600 * 1000);
	}
	const toISO = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
	return { checkinISO: toISO(ci), checkoutISO: toISO(co) };
}

/* ---------------- quick smalltalk (multi‑lingual) ---------------- */
function quickSmalltalkType(text = "") {
	const t = text.trim().toLowerCase();
	if (/(how\s*(are|r)\s*(you|u))(?:\s*today)?/.test(t)) return "how_are_you";
	if (/(?:\u0643\u064a\u0641\s+\u062d\u0627\u0644\u0643|\u0627\u062e\u0628\u0627\u0631\u0643|\u0623\u062e\u0628\u0627\u0631\u0643|\u0639\u0627\u0645\u0644\s+\u0627\u064a\u0647|\u0639\u0627\u0645\u0644\u0629\s+\u0627\u064a\u0647|\u0643\u064a\u0641\u0643|\u0627\u0632\u064a\u0643|\u0625\u0632\u064a\u0643)/.test(t)) return "how_are_you";
	if (/^(hi|hello|hey|السلام|مرحبا|اهلا|أهلاً)\b/.test(t)) return "greet";
	if (
		/(how\s*(are|r)\s*(you|u))(?:\s*today)?|كيف حالك|اخبارك|عامل ايه|كيفك/.test(
			t
		)
	)
		return "how_are_you";
	if (/(are\s*you\s*there|you still there|لسه|فينك|موجود)/.test(t))
		return "are_you_there";
	if (/\b(thanks|thank you|شكرا|شكرًا)\b/.test(t)) return "thanks";
	if (/\b(bye|goodbye|see you|مع السلامة|وداعا)\b/.test(t)) return "farewell";
	if (/^(wow|lol|لول|واو)\b/.test(t)) return "wow";
	if (/^(nice|cool|great|تمام|حلو|كويس|جميل)\b/.test(t)) return "chitchat";
	return null;
}

/* ---------------- amenity detection (multi‑lingual) ---------------- */
function detectAmenityQuestion(text = "") {
	const t = String(text).toLowerCase();
	const amenity =
		/\b(wi[\-\s]?fi|wifi|wireless|انترنت|إنترنت|واي\s?فاي)\b/.test(t)
			? "wifi"
			: /\b(parking|garage|موقف|مواقف)\b/.test(t)
			? "parking"
			: /\b(breakfast|افطار|فطور)\b/.test(t)
			? "breakfast"
			: /\b(air\s*conditioning|a\.?c\.?|ac|تكييف)\b/.test(t)
			? "ac"
			: null;

	// Is it a question / request?
	const isQuestion =
		/\?|^do(es)?\b|^is\b|^are\b|available|include|have|فيه|هل/i.test(text);
	return amenity && isQuestion ? amenity : null;
}

/* ---------------- LLM classification fallback ---------------- */
async function detectIntentLLM({
	text,
	preferredLanguage = "English",
	inquiryAbout,
	hotel,
}) {
	const activeRoomOptions = Array.isArray(hotel?.roomCountDetails)
		? hotel.roomCountDetails
				.filter((room) => room?.activeRoom)
				.map((room) => ({
					roomType: room.roomType,
					displayName: room.displayName || room.roomType,
					basePrice: room.price?.basePrice || 0,
				}))
				.slice(0, 12)
		: [];
	const sys = [
		"Classify hotel chat messages.",
		"Guest text may be native script, romanized/transliterated, code-switched, misspelled, or informal. Infer the intended meaning from phonetics, language hint, ticket context, and hotel context instead of exact spellings.",
		"Examples of writing styles include Franko Arabic/Arabizi, Algerian/Moroccan/Tunisian/Egyptian/Gulf Arabic dialects, Hinglish, Urdu or Hindi in Latin characters, Spanish or French without accents, and mixed English with another language.",
		"Do not classify a message as other just because the language is dialectal, romanized, or mixed-script; infer the hotel-support intent when possible.",
		"Return ONLY JSON:",
		"{ intent:'reserve_room'|'reservation_lookup'|'smalltalk'|'confirm_check'|'other',",
		"  smalltalkType:null|'greet'|'how_are_you'|'thanks'|'are_you_there'|'farewell'|'wow'|'chitchat',",
		"  dates:{ checkin:string|null, checkout:string|null, calendar:'gregorian'|'hijri'|null }|null,",
		"  roomText:string|null, roomTypeKey:null|'singleRooms'|'doubleRooms'|'tripleRooms'|'quadRooms'|'familyRooms',",
		"  amenity:null|'wifi'|'parking'|'breakfast'|'ac', confirmation:string|null }",
		"Prefer roomTypeKey from meaning, not exact words, for any language.",
		"Use active hotel room options as context when available, but never invent a room type that is not implied by the guest.",
	].join(" ");

	const user = [
		`Language hint: ${preferredLanguage}`,
		inquiryAbout ? `Ticket inquiryAbout: ${inquiryAbout}` : "",
		activeRoomOptions.length
			? `Active hotel room options: ${JSON.stringify(activeRoomOptions)}`
			: "",
		`Message: """${text}"""`,
	].join("\n");

	const raw = await chat(
		[
			{ role: "system", content: sys },
			{ role: "user", content: user },
		],
		{ kind: "nlu", temperature: 0, max_tokens: 220 }
	);

	try {
		return JSON.parse(raw);
	} catch {
		return {
			intent: "other",
			smalltalkType: null,
			dates: null,
			roomText: null,
			amenity: null,
			confirmation: null,
		};
	}
}

/* ---------------- LLM date normalization ---------------- */
async function normalizeDatesLLM({
	checkin,
	checkout,
	preferredLanguage = "English",
}) {
	if (!checkin && !checkout)
		return { checkinISO: null, checkoutISO: null, reason: null };

	const today = new Date().toISOString().slice(0, 10);
	const sys = [
		"Convert input dates to Gregorian ISO (YYYY-MM-DD). Input may be Hijri or Gregorian, any language.",
		"IMPORTANT: If the month is missing for either date, DO NOT infer—return null and set reason:'month_missing'.",
		"If year is missing but month exists, prefer the nearest FUTURE year.",
		"Ensure check-in < check-out; else leave null.",
		"Return ONLY JSON: { checkinISO:string|null, checkoutISO:string|null, reason:null|'month_missing' }",
	].join(" ");

	const user = [
		`Language: ${preferredLanguage}`,
		`todayISO: ${today}`,
		`checkin_raw: ${checkin || ""}`,
		`checkout_raw: ${checkout || ""}`,
	].join("\n");

	const raw = await chat(
		[
			{ role: "system", content: sys },
			{ role: "user", content: user },
		],
		{ kind: "nlu", temperature: 0, max_tokens: 160 }
	);

	let data = null;
	try {
		data = JSON.parse(raw);
	} catch {
		data = null;
	}
	if (!data) return { checkinISO: null, checkoutISO: null, reason: null };

	if (!data.reason && isPastISO(data.checkinISO))
		data = { ...data, ...bumpDatesToFuture(data) };
	return data;
}

/* ---------------- nationality + name helpers ---------------- */
async function validateNationalityLLM(text, language = "English") {
	let raw = "";
	try {
		raw = await chat(
			[
				{
					role: "system",
					content:
						"Validate nationalities/demonyms in ANY language. Return ONLY JSON: { valid:boolean, normalized:string|null, country:string|null }. 'normalized' MUST be English (Latin).",
				},
				{
					role: "user",
					content: `Language hint: ${language}\nNationality text: """${text}"""\nReturn ONLY JSON.`,
				},
			],
			{ kind: "nlu", temperature: 0, max_tokens: 80 }
		);
	} catch {
		return { valid: false, normalized: null, country: null };
	}
	try {
		return JSON.parse(raw);
	} catch {
		return { valid: false, normalized: null, country: null };
	}
}

async function normalizeNameLLM(text, language = "English") {
	let raw = "";
	try {
		raw = await chat(
			[
				{
					role: "system",
					content:
						"Normalize a person's FULL NAME. If text is in Arabic/other script, transliterate to ASCII Latin. Reject gibberish. Return ONLY JSON: { valid:boolean, fullNameAscii:string|null, first:string|null, last:string|null }.",
				},
				{
					role: "user",
					content: `Language hint: ${language}\nName text: """${text}"""\nReturn ONLY JSON.`,
				},
			],
			{ kind: "nlu", temperature: 0, max_tokens: 80 }
		);
	} catch {
		return { valid: false, fullNameAscii: null, first: null, last: null };
	}
	try {
		return JSON.parse(raw);
	} catch {
		return { valid: false, fullNameAscii: null, first: null, last: null };
	}
}

/* ---------------- main NLU step ---------------- */
async function nluStep({ sc, hotel, lastUserMessage }) {
	const preferredLanguage = sc?.preferredLanguage || "English";
	const inquiryAbout = sc?.inquiryAbout || null;
	const text = String(lastUserMessage || "");

	// smalltalk fast‑path
	const hint = quickSmalltalkType(text);
	if (hint) {
		return {
			intent: "smalltalk",
			smalltalkType: hint,
			roomTypeKey: null,
			dates: {
				checkinISO: null,
				checkoutISO: null,
				checkinPast: false,
				checkoutPast: false,
				raw: { checkin: null, checkout: null, calendar: null },
			},
			confirmation: null,
			firstName: firstNameOf(sc?.displayName1 || sc?.customerName || "Guest"),
			amenity: detectAmenityQuestion(text), // allow amenity while in smalltalk
		};
	}

	const quickRoomTypeKey = mapRoomToKey(text);
	const quickDates = quickDateRange(text);
	const looksLikeBooking =
		/\b(book|reserve|reservation|price|rate|availability|available|room|stay)\b/i.test(
			text
		) ||
		Boolean(quickRoomTypeKey);
	if (
		looksLikeBooking &&
		quickRoomTypeKey &&
		quickDates.checkinISO &&
		quickDates.checkoutISO
	) {
		return {
			intent: "reserve_room",
			smalltalkType: null,
			roomTypeKey: quickRoomTypeKey,
			dates: {
				checkinISO: quickDates.checkinISO,
				checkoutISO: quickDates.checkoutISO,
				reason: null,
				checkinPast: isPastISO(quickDates.checkinISO),
				checkoutPast: isPastISO(quickDates.checkoutISO),
				raw: {
					checkin: quickDates.raw?.checkin || quickDates.checkinISO,
					checkout: quickDates.raw?.checkout || quickDates.checkoutISO,
					calendar: quickDates.raw?.calendar || "gregorian",
					...(quickDates.raw?.checkinHijri
						? { checkinHijri: quickDates.raw.checkinHijri }
						: {}),
					...(quickDates.raw?.checkoutHijri
						? { checkoutHijri: quickDates.raw.checkoutHijri }
						: {}),
				},
			},
			confirmation: null,
			firstName: firstNameOf(sc?.displayName1 || sc?.customerName || "Guest"),
			amenity: detectAmenityQuestion(text),
		};
	}

	let lu = null;
	try {
		lu = await detectIntentLLM({ text, preferredLanguage, inquiryAbout, hotel });
	} catch (error) {
		console.log("[aiagent] nlu.detect_failed", {
			message: error?.message || error,
		});
		lu = {
			intent: "other",
			smalltalkType: null,
			dates: null,
			roomText: null,
			amenity: detectAmenityQuestion(text),
			confirmation: null,
		};
	}
	const roomKey =
		lu?.roomTypeKey ||
		(lu?.roomText ? mapRoomToKey(lu.roomText) : null) ||
		quickRoomTypeKey;

	let iso = { checkinISO: null, checkoutISO: null, reason: null };
	try {
		iso = await normalizeDatesLLM({
			checkin: lu?.dates?.checkin || null,
			checkout: lu?.dates?.checkout || null,
			preferredLanguage,
		});
	} catch (error) {
		console.log("[aiagent] nlu.date_failed", {
			message: error?.message || error,
		});
	}

	const mergedCheckinISO = quickDates.checkinISO || iso?.checkinISO || null;
	const mergedCheckoutISO = quickDates.checkoutISO || iso?.checkoutISO || null;
	const dates = {
		checkinISO: mergedCheckinISO,
		checkoutISO: mergedCheckoutISO,
		reason: iso?.reason || null,
		checkinPast: isPastISO(mergedCheckinISO),
		checkoutPast: isPastISO(mergedCheckoutISO),
		raw: {
			checkin: quickDates.raw?.checkin || lu?.dates?.checkin || null,
			checkout: quickDates.raw?.checkout || lu?.dates?.checkout || null,
			calendar: quickDates.raw?.calendar || lu?.dates?.calendar || null,
			...(quickDates.raw?.checkinHijri
				? { checkinHijri: quickDates.raw.checkinHijri }
				: {}),
			...(quickDates.raw?.checkoutHijri
				? { checkoutHijri: quickDates.raw.checkoutHijri }
				: {}),
		},
	};

	return {
		intent: lu.intent || "other",
		smalltalkType: lu.smalltalkType || null,
		roomTypeKey: roomKey,
		dates,
		confirmation: lu.confirmation || null,
		firstName: firstNameOf(sc?.displayName1 || sc?.customerName || "Guest"),
		amenity: lu.amenity || detectAmenityQuestion(text),
	};
}

module.exports = {
	firstNameOf,
	nluStep,
	mapRoomToKey,
	validateNationalityLLM,
	normalizeNameLLM,
	asciiize,
	digitsToEnglish,
	detectAmenityQuestion,
	quickDateRange,
	quickHijriDateRange,
	hijriToGregorianISO,
};
