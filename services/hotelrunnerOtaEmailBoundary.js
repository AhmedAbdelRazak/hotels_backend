/** @format */

const normalizeMarker = (value) =>
	String(value || "")
		.trim()
		.toLowerCase()
		.replace(/[\s-]+/g, "_");

/**
 * Returns true only after the local reservation itself has been projected by
 * the authenticated HotelRunner worker.
 *
 * Hotel-level configuration is intentionally not enough. Some reservations at
 * a HotelRunner-connected property can arrive only through an OTA mailbox (for
 * example, a listing/account that is not connected to HotelRunner). Those
 * emails must continue through the normal local ingestion path. Once a direct
 * projection has stamped the reservation, lower-authority lifecycle emails may
 * be retained for audit without overwriting the API-owned lifecycle state.
 */
function hasDirectHotelRunnerProjection(reservation = {}) {
	const supplier = reservation?.supplierData || {};
	const transport = normalizeMarker(supplier.hotelRunner?.transport);
	const pipeline = normalizeMarker(supplier.otaAutomationPipeline);
	const reservationId = String(supplier.hotelRunner?.reservationId || "").trim();
	return Boolean(
		transport === "hotelrunner_api" &&
			reservationId &&
			Number(supplier.otaSourceAuthority || 0) >= 4 &&
			pipeline === "hotelrunner_background_worker"
	);
}

module.exports = {
	hasDirectHotelRunnerProjection,
	normalizeMarker,
};
