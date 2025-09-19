/** @format */
const LAST = new Map();
const WINDOW_MS = 800; // ms

function okToReply(caseId) {
	const now = Date.now();
	const last = LAST.get(caseId) || 0;
	if (now - last < WINDOW_MS) return false;
	LAST.set(caseId, now);
	return true;
}

module.exports = { okToReply };
