const DEFAULT_JANNAT_SUPPORT_VIRTUAL_HOTEL_IDS = [
	"674cf8997e3780f1f838d458",
	"66b6d8698ca02cb39522b85b",
];

const DEFAULT_JANNAT_SUPPORTER_ID = "6553f1c6d06c5cea2f98a838";

const normalizeId = (value) =>
	String(value?._id || value?.id || value || "")
		.trim()
		.toLowerCase();

const splitIds = (...values) =>
	values
		.flatMap((value) => String(value || "").split(","))
		.map(normalizeId)
		.filter(Boolean);

const uniqueIds = (ids = []) => {
	const seen = new Set();
	const next = [];
	ids.forEach((id) => {
		const normalized = normalizeId(id);
		if (!normalized || seen.has(normalized)) return;
		seen.add(normalized);
		next.push(normalized);
	});
	return next;
};

const configuredVirtualHotelIds = () =>
	uniqueIds([
		...DEFAULT_JANNAT_SUPPORT_VIRTUAL_HOTEL_IDS,
		...splitIds(
			process.env.JANNATSUPPORT_VIRTUAL_HOTEL_IDS,
			process.env.JANNAT_BOOKING_SUPPORT_HOTEL_ID,
			process.env.REACT_APP_JANNAT_BOOKING_SUPPORT_HOTEL_ID,
			process.env.NEXT_PUBLIC_JANNAT_BOOKING_SUPPORT_HOTEL_ID,
			process.env.JANNAT_SUPPORT_HOTEL_IDS
		),
	]);

const configuredPriorityHotelId = () =>
	normalizeId(
		process.env.JANNATSUPPORT_PRIORITY ||
			process.env.JANNAT_SUPPORT_PRIORITY_HOTEL_ID ||
			process.env.JANNAT_BOOKING_PRIORITY_HOTEL_ID
	);

const configuredMarketingHotelIds = () => {
	const priority = configuredPriorityHotelId();
	return uniqueIds([
		priority,
		...splitIds(
			process.env.JANNATSUPPORT_HOTELS_FOR_MARKETING,
			process.env.JANNAT_SUPPORT_HOTELS_FOR_MARKETING,
			process.env.JANNAT_BOOKING_MARKETING_HOTEL_IDS
		),
	]).filter((id) => id && !configuredVirtualHotelIds().includes(id));
};

const configuredJannatSupporterId = () =>
	normalizeId(
		process.env.JANNAT_BOOKING_SUPPORTER_ID ||
			process.env.JANNAT_SUPPORTER_ID ||
			process.env.REACT_APP_JANNAT_BOOKING_SUPPORTER_ID ||
			DEFAULT_JANNAT_SUPPORTER_ID
	);

const jannatHandoffDelayMs = () => {
	const value = parseInt(process.env.JANNATSUPPORT_HOTEL_HANDOFF_DELAY_MS || "", 10);
	if (!Number.isFinite(value)) return 6500;
	return Math.max(1500, Math.min(value, 15000));
};

const configuredJannatSupportName = (languageCode = "") =>
	/^ar\b/i.test(String(languageCode || ""))
		? "دعم جنات بوكينج"
		: "Jannat Support";

const configuredHotelReceptionNames = () => {
	const values = String(
		process.env.B2C_AI_RESPONDER_NAMES || process.env.AI_RESPONDER_NAMES || ""
	)
		.split(",")
		.map((value) => String(value || "").trim())
		.filter(Boolean);
	return values.length
		? values
		: [
				"Aisha",
				"Hana",
				"Amira",
				"Zainab",
				"Safiya",
				"Lina",
				"Samira",
				"Rania",
		  ];
};

const pickHotelReceptionName = ({ seed = "", avoid = "" } = {}) => {
	const names = configuredHotelReceptionNames();
	const avoidKey = String(avoid || "").trim().toLowerCase();
	const candidates =
		names.length > 1
			? names.filter((name) => name.toLowerCase() !== avoidKey)
			: names;
	const source = candidates.length ? candidates : names;
	const hash = String(seed || "")
		.split("")
		.reduce((acc, char) => (acc * 31 + char.charCodeAt(0)) % 1000003, 7);
	return source[hash % source.length] || "Jannat Booking";
};

module.exports = {
	DEFAULT_JANNAT_SUPPORT_VIRTUAL_HOTEL_IDS,
	configuredVirtualHotelIds,
	configuredPriorityHotelId,
	configuredMarketingHotelIds,
	configuredJannatSupporterId,
	configuredJannatSupportName,
	pickHotelReceptionName,
	jannatHandoffDelayMs,
	normalizeId,
	uniqueIds,
};
