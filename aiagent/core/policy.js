/** @format */
// aiagent/core/policy.js
const { getHotelById } = require("./db");

async function ensureAIAllowed(hotelId) {
	const force =
		String(process.env.AI_FORCE_RESPOND || "").toLowerCase() === "true";
	const hotel = hotelId ? await getHotelById(hotelId) : null;

	// Allowed if forced OR hotel has aiToRespond true (default to true if absent)
	const allowed = force || (hotel ? hotel.aiToRespond !== false : true);

	return { allowed, hotel };
}

module.exports = { ensureAIAllowed };
