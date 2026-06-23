/** @format */
// aiagent/index.js
const { attachRoutes } = require("./routes");
const { attachCaseWatcher } = require("./core/watcher");
const { wireSocket } = require("./core/orchestrator");

function initAIAgent({ app, io }) {
	attachRoutes(app, io);
	if (typeof wireSocket === "function") wireSocket(io);
	attachCaseWatcher(io);
	console.log("[aiagent] initialized.");
}

module.exports = { initAIAgent };
module.exports.default = initAIAgent;
module.exports.init = initAIAgent;
