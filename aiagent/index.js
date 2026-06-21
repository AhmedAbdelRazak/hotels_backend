/** @format */
// aiagent/index.js
const { attachRoutes } = require("./routes");
const { wireSocket } = require("./core/orchestrator");

let initialized = false;

function initAIAgent({ app, io }) {
	if (initialized) {
		console.log("[aiagent] already initialized; skipping duplicate wiring.");
		return;
	}
	initialized = true;
	attachRoutes(app, io);
	if (typeof wireSocket === "function") wireSocket(io);
	console.log("[aiagent] initialized.");
}

module.exports = { initAIAgent };
module.exports.default = initAIAgent;
module.exports.init = initAIAgent;
