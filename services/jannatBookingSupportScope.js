const {
	DEFAULT_JANNAT_SUPPORT_VIRTUAL_HOTEL_IDS,
	configuredVirtualHotelIds,
	configuredPriorityHotelId,
	configuredMarketingHotelIds,
} = require("../aiagent/jannatSupport/config");

const DEFAULT_JANNAT_SUPPORT_HOTEL_ID = DEFAULT_JANNAT_SUPPORT_VIRTUAL_HOTEL_IDS[0];

const normalizeId = (value) =>
	String(value?._id || value?.id || value || "")
		.trim()
		.toLowerCase();

const configuredJannatSupportHotelIds = () =>
	configuredVirtualHotelIds();

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
	DEFAULT_JANNAT_SUPPORT_VIRTUAL_HOTEL_IDS,
	configuredJannatSupportHotelIds,
	configuredJannatPriorityHotelId: configuredPriorityHotelId,
	configuredJannatMarketingHotelIds: configuredMarketingHotelIds,
	isJannatSupportHotelId,
	isJannatSupportHotelName,
	isJannatBookingSupportCase,
};
