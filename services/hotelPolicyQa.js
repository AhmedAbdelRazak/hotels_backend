const DEFAULT_CANCELLATION_REFUND_ANSWER =
	"Cancellation is free with a full refund when requested 14 days or more before check-in. When requested less than 14 days but more than 3 days before check-in, cancellation can still be processed; the hotel keeps one night only and the remaining amount is refunded. Within 3 days or less before check-in, the reservation is non-cancellable and non-refundable under the general policy.";

const DEFAULT_HOTEL_POLICY_QA = [
	{
		key: "cancellation_refund",
		category: "Cancellation and refunds",
		question: "What is the cancellation and refund policy?",
		answer: DEFAULT_CANCELLATION_REFUND_ANSWER,
		mandatory: true,
		active: true,
		sortOrder: 10,
	},
	{
		key: "checkin_checkout",
		category: "Arrival and departure",
		question: "What are the check-in and check-out times?",
		answer: "",
		mandatory: false,
		active: false,
		sortOrder: 20,
	},
	{
		key: "early_late",
		category: "Arrival and departure",
		question: "Is early check-in or late check-out available?",
		answer: "",
		mandatory: false,
		active: false,
		sortOrder: 30,
	},
	{
		key: "children_extra_beds",
		category: "Guests and rooms",
		question: "What is the children and extra-bed policy?",
		answer: "",
		mandatory: false,
		active: false,
		sortOrder: 40,
	},
	{
		key: "payment_deposit",
		category: "Payment",
		question: "What payment or deposit rules should guests know?",
		answer: "",
		mandatory: false,
		active: false,
		sortOrder: 50,
	},
	{
		key: "no_show",
		category: "Cancellation and refunds",
		question: "What happens if the guest does not show up?",
		answer: "",
		mandatory: false,
		active: false,
		sortOrder: 60,
	},
	{
		key: "id_documents",
		category: "Guest documents",
		question: "What ID, passport, or booking documents are required?",
		answer: "",
		mandatory: false,
		active: false,
		sortOrder: 70,
	},
	{
		key: "smoking",
		category: "House rules",
		question: "What is the smoking policy?",
		answer: "",
		mandatory: false,
		active: false,
		sortOrder: 80,
	},
	{
		key: "parking",
		category: "Facilities",
		question: "What is the parking policy?",
		answer: "",
		mandatory: false,
		active: false,
		sortOrder: 90,
	},
	{
		key: "meals_breakfast",
		category: "Facilities",
		question: "What meal or breakfast rules should guests know?",
		answer: "",
		mandatory: false,
		active: false,
		sortOrder: 100,
	},
	{
		key: "pets",
		category: "House rules",
		question: "Are pets allowed?",
		answer: "",
		mandatory: false,
		active: false,
		sortOrder: 110,
	},
	{
		key: "damage_deposit",
		category: "House rules",
		question: "Is there a damage deposit or damage policy?",
		answer: "",
		mandatory: false,
		active: false,
		sortOrder: 120,
	},
];

const DEFAULT_POLICY_BY_KEY = DEFAULT_HOTEL_POLICY_QA.reduce((acc, row) => {
	acc[row.key] = row;
	return acc;
}, {});

function cleanPolicyText(value = "", max = 2000) {
	return String(value || "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, max);
}

function normalizePolicyKey(value = "", fallback = "") {
	const key = String(value || fallback || "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 80);
	return key || "custom_policy";
}

function clonePolicy(row = {}) {
	return {
		key: normalizePolicyKey(row.key),
		category: cleanPolicyText(row.category, 120),
		question: cleanPolicyText(row.question, 240),
		answer: cleanPolicyText(row.answer, 3000),
		mandatory: row.mandatory === true,
		active: row.active === true,
		sortOrder: Number.isFinite(Number(row.sortOrder)) ? Number(row.sortOrder) : 999,
	};
}

function makeDefaultHotelPolicyQA() {
	return DEFAULT_HOTEL_POLICY_QA.map(clonePolicy);
}

function sanitizeHotelPolicyQA(input = [], { includeSuggested = true } = {}) {
	const byKey = new Map();
	const sourceRows = Array.isArray(input) ? input : [];

	for (const row of sourceRows) {
		const incoming = clonePolicy(row || {});
		const defaultRow = DEFAULT_POLICY_BY_KEY[incoming.key] || {};
		const key = incoming.key || defaultRow.key;
		if (!key) continue;
		const merged = clonePolicy({
			...defaultRow,
			...incoming,
			key,
			mandatory: defaultRow.mandatory === true || incoming.mandatory === true,
			active:
				defaultRow.mandatory === true
					? true
					: incoming.active === true && Boolean(incoming.answer || incoming.question),
			question: incoming.question || defaultRow.question,
			answer:
				defaultRow.mandatory === true
					? incoming.answer || defaultRow.answer
					: incoming.answer,
		});
		if (!merged.question && !merged.answer && !merged.mandatory) continue;
		byKey.set(key, merged);
	}

	for (const defaultRow of DEFAULT_HOTEL_POLICY_QA) {
		if (!includeSuggested && !defaultRow.mandatory) continue;
		if (!byKey.has(defaultRow.key)) byKey.set(defaultRow.key, clonePolicy(defaultRow));
	}

	return [...byKey.values()]
		.map((row, index) => ({
			...row,
			sortOrder: Number.isFinite(Number(row.sortOrder))
				? Number(row.sortOrder)
				: 900 + index,
		}))
		.sort((a, b) => a.sortOrder - b.sortOrder)
		.slice(0, 30);
}

function activeHotelPolicyQA(input = []) {
	return sanitizeHotelPolicyQA(input, { includeSuggested: false }).filter(
		(row) => row.mandatory || (row.active && row.answer)
	);
}

module.exports = {
	DEFAULT_CANCELLATION_REFUND_ANSWER,
	DEFAULT_HOTEL_POLICY_QA,
	makeDefaultHotelPolicyQA,
	sanitizeHotelPolicyQA,
	activeHotelPolicyQA,
	normalizePolicyKey,
};
