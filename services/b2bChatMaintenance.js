/** @format */

const B2BChat = require("../models/b2b_chat");

const TEN_MINUTES = 10 * 60 * 1000;

const runB2BChatMaintenance = async () => {
	try {
		await B2BChat.closeInactiveChats();
	} catch (error) {
		console.error("[b2b-chat] maintenance failed:", error?.message || error);
	}
};

const startB2BChatMaintenanceJob = () => {
	runB2BChatMaintenance();
	const timer = setInterval(runB2BChatMaintenance, TEN_MINUTES);
	if (typeof timer.unref === "function") timer.unref();
	return timer;
};

module.exports = {
	runB2BChatMaintenance,
	startB2BChatMaintenanceJob,
};
