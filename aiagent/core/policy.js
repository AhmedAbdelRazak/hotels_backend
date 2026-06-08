/** @format */
// aiagent/core/policy.js
const { getHotelById, getJanatAiSettings } = require("./db");
const {
	isJannatBookingSupportCase,
} = require("../../services/jannatBookingSupportScope");

async function ensureAIAllowed(hotelId, supportCase = {}) {
	const force =
		String(process.env.AI_FORCE_RESPOND || "").toLowerCase() === "true";
	const globallyEnabled =
		force || String(process.env.AI_AGENT_ENABLED || "").toLowerCase() === "true";
	const janatAi = await getJanatAiSettings();
	const hotel = hotelId ? await getHotelById(hotelId) : null;
	const isJannatSupport = isJannatBookingSupportCase(supportCase, hotel);
	const isClientCase = supportCase?.openedBy === "client";
	const isOpenCase = !supportCase?.caseStatus || supportCase.caseStatus === "open";
	const caseAllowsAi = supportCase?.aiToRespond === true;
	const hotelAllowsAi = isJannatSupport || !hotel || hotel?.aiToRespond === true;
	const hotelOwnerActive = !hotel || hotel.activateHotel === true;
	const hotelPlatformActive = !hotel || hotel.xHotelProActive !== false;
	const hotelPublicActive = isJannatSupport || (hotelOwnerActive && hotelPlatformActive);

	let reason = "";
	if (!globallyEnabled) reason = "AI_AGENT_ENABLED is not true";
	else if (!janatAi.aiToRespond && !force)
		reason = "Jannat website AI responder is off";
	else if (!isClientCase) reason = "support case is not B2C/client-opened";
	else if (!isOpenCase) reason = "support case is not open";
	else if (!caseAllowsAi) reason = "support case aiToRespond is false";
	else if (!hotelPublicActive && !force)
		reason = "hotel owner/platform activation is not active";
	else if (!hotelAllowsAi && !force) reason = "hotel aiToRespond is false";

	const allowed =
		globallyEnabled &&
		(janatAi.aiToRespond || force) &&
		isClientCase &&
		isOpenCase &&
		caseAllowsAi &&
		(hotelPublicActive || force) &&
		(hotelAllowsAi || force);

	return { allowed, hotel, reason, janatAi };
}

module.exports = { ensureAIAllowed };
