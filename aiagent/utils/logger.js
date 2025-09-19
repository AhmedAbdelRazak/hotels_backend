/** @format */
function log(ns, ...args) {
	if (process.env.NODE_ENV !== "production") {
		console.log(`[aiagent:${ns}]`, ...args);
	}
}
module.exports = { log };
