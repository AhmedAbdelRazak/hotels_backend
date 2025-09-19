/** @format */
// Tiny FAQ using hotel doc (distances, kitchens, WiFi, etc.)
function faqAnswerIfAny(state, text, L) {
	const t = text.toLowerCase();
	const h = state.hotel || {};
	const distances = h.distances || {};
	const hasWifi = hasAmenity(state, "WiFi");
	const hasKitchen =
		/two kitchens|مطبخ|kitchen/i.test(h.aboutHotel || "") ||
		hasAmenity(state, "Kitchen");

	if (/haram|من الحرم|distance.*haram|far.*haram|كم.*الحرم/.test(t)) {
		const walking = distances.walkingToElHaram || "";
		const driving = distances.drivingToElHaram || "";
		return L.t("faq_distance_haram", { walking, driving });
	}
	if (/wifi|واي فاي|انترنت/.test(t)) {
		return L.t("faq_wifi", { hasWifi });
	}
	if (/kitchen|مطبخ/.test(t)) {
		return L.t("faq_kitchen", { hasKitchen });
	}
	if (/parking|موقف/.test(t)) {
		const val = h.parkingLot === true;
		return L.t("faq_parking", { available: val });
	}
	return null;
}

function hasAmenity(state, name) {
	const rcd = Array.isArray(state.hotel?.roomCountDetails)
		? state.hotel.roomCountDetails
		: [];
	return rcd.some((r) => (r.amenities || []).includes(name));
}

module.exports = { faqAnswerIfAny };
