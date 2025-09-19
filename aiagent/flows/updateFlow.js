/** @format */
function formatReservationSummary(res) {
	const name = res?.customer_details?.name || "";
	const cn = res?.confirmation_number || "";
	const inDate = res?.checkin_date
		? new Date(res.checkin_date).toISOString().slice(0, 10)
		: "";
	const outDate = res?.checkout_date
		? new Date(res.checkout_date).toISOString().slice(0, 10)
		: "";
	const room =
		res?.pickedRoomsType?.[0]?.displayName ||
		res?.pickedRoomsType?.[0]?.room_type ||
		"";
	return { name, cn, inDate, outDate, room };
}

module.exports = { formatReservationSummary };
