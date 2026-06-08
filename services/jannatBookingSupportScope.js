const DEFAULT_JANNAT_SUPPORT_HOTEL_ID = "674cf8997e3780f1f838d458";

const normalizeId = (value) =>
	String(value?._id || value?.id || value || "")
		.trim()
		.toLowerCase();

const configuredJannatSupportHotelIds = () =>
	[
		DEFAULT_JANNAT_SUPPORT_HOTEL_ID,
		process.env.JANNAT_BOOKING_SUPPORT_HOTEL_ID,
		process.env.REACT_APP_JANNAT_BOOKING_SUPPORT_HOTEL_ID,
		process.env.JANNAT_SUPPORT_HOTEL_IDS,
	]
		.flatMap((value) => String(value || "").split(","))
		.map(normalizeId)
		.filter(Boolean);

const isJannatSupportHotelId = (hotelId) =>
	configuredJannatSupportHotelIds().includes(normalizeId(hotelId));

const isJannatSupportHotelName = (name = "") =>
	/\bjannat\s+booking\b/i.test(String(name || ""));

const supportScopeValue = (supportCase = {}) =>
	String(
		supportCase.supportScope ||
			supportCase.caseScope ||
			supportCase.chatScope ||
			supportCase.supportType ||
			""
	)
		.trim()
		.toLowerCase();

const isJannatBookingSupportCase = (supportCase = {}, hotel = null) => {
	const scope = supportScopeValue(supportCase);
	if (["jannat_booking", "jannat-booking", "platform", "platform_support"].includes(scope)) {
		return true;
	}
	const hotelId = normalizeId(
		supportCase.hotelId || supportCase.hotel || supportCase.selectedHotelId
	);
	if (hotelId && isJannatSupportHotelId(hotelId)) return true;
	return isJannatSupportHotelName(
		hotel?.hotelName ||
			hotel?.name ||
			supportCase.displayName2 ||
			supportCase.hotelName ||
			""
	);
};

module.exports = {
	DEFAULT_JANNAT_SUPPORT_HOTEL_ID,
	configuredJannatSupportHotelIds,
	isJannatSupportHotelId,
	isJannatSupportHotelName,
	isJannatBookingSupportCase,
};
