/** @format */
const { sendAgentMessage } = require("./sender");
const { getOrCreateCaseState } = require("./state");
const { ensureAIAllowed } = require("./policy");

// One pending message per caseId to avoid overlaps
const PENDING = new Map();

/**
 * Schedule a reply with:
 *  - minDelayMs (default 1.5s)
 *  - if user is typing or typed in last 800ms, postpone until silent
 *  - stop after maxWaitMs (default 30s)
 */
function scheduleReply({
	io,
	caseId,
	message,
	name,
	minDelayMs = 1500,
	maxWaitMs = 30000,
}) {
	if (!caseId || !message) return;

	const run = async () => {
		const s = getOrCreateCaseState(caseId);
		// Always re-check policy before sending
		const { allowed } = await ensureAIAllowed(s.hotelId);
		if (!allowed) {
			PENDING.delete(caseId);
			return;
		}

		const now = Date.now();
		const lastType = s.typing?.lastAt || 0;
		const isTyping = !!s.typing?.userTyping || now - lastType < 800;
		if (isTyping) {
			const meta = PENDING.get(caseId) || { start: now };
			if (now - (meta.start || now) > maxWaitMs) {
				PENDING.delete(caseId);
				return; // give up silently
			}
			const id = setTimeout(run, 800);
			PENDING.set(caseId, { ...meta, timer: id });
			return;
		}

		PENDING.delete(caseId);
		await sendAgentMessage({ io, caseId, message, name });
	};

	const prev = PENDING.get(caseId);
	if (prev?.timer) clearTimeout(prev.timer);

	const id = setTimeout(run, minDelayMs);
	PENDING.set(caseId, { start: Date.now(), timer: id });
}

module.exports = { scheduleReply };
