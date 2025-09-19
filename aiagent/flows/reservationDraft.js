/** @format */
// Build a reservation draft shaped like your schema using computed pricing
function buildDraft(state, quote) {
	const { answers, hotel } = state;
	const currency = (hotel.currency || "sar").toLowerCase();

	return {
		hotelId: String(hotel._id),
		belongsTo: String(hotel.belongsTo || ""),
		booking_source: "aiagent",
		total_rooms: 1,
		total_guests: 1,
		adults: 1,
		children: 0,
		currency,
		checkin_date: new Date(`${answers.checkin}T00:00:00.000Z`),
		checkout_date: new Date(`${answers.checkout}T00:00:00.000Z`),
		days_of_residence: quote.nights,
		customer_details: {
			name: state.profile?.name || "",
			email: answers.email || "",
			phone: answers.phone || "",
			nationality: answers.nationality || "",
			reservedBy: "AI Agent",
		},
		pickedRoomsType: [
			{
				room_type: answers.roomType,
				displayName: answers.displayName || answers.roomType,
				chosenPrice: quote.perNight.toFixed(2),
				count: 1,
				pricingByDay: quote.nightly.map((d) => ({
					date: d.date,
					price: d.price,
					rootPrice: d.rootPrice,
					commissionRate: d.commissionRate,
					totalPriceWithCommission: d.totalPriceWithCommission,
					totalPriceWithoutCommission: d.totalPriceWithoutCommission,
				})),
				totalPriceWithCommission: quote.totalWithCommission,
				hotelShouldGet: quote.rootTotal,
				roomId: [],
				bedNumber: [],
			},
		],
		total_amount: Number(quote.totalWithCommission.toFixed(2)),
		commission: Number(quote.commissionTotal.toFixed(2)),
		commissionPaid: false,
		payment: "not paid",
		paid_amount: 0,
	};
}

module.exports = { buildDraft };
