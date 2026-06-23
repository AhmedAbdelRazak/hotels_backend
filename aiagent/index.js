/** @format */
// aiagent/index.js
const { attachRoutes } = require("./routes");
const { wireSocket, schedulePlanTurn } = require("./core/orchestrator_rebuilt");

let initialized = false;

function initAIAgent({ app, io }) {
	if (initialized) {
		console.log("[aiagent] already initialized; skipping duplicate wiring.");
		return;
	}
	initialized = true;
	if (app && typeof app.set === "function" && typeof schedulePlanTurn === "function") {
		app.set("scheduleAiPlanTurn", schedulePlanTurn);
	}
	attachRoutes(app, io);
	if (typeof wireSocket === "function") wireSocket(io);
	console.log("[aiagent] initialized.");
}

module.exports = { initAIAgent };
module.exports.default = initAIAgent;
module.exports.init = initAIAgent;
