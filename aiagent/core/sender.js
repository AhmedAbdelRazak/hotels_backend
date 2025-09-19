// hotels_backend/aiagent/core/sender.js
// Humanized sending with realistic “think” + “typing” delays.

export async function humanSend(io, sc, st, text, { first = false } = {}) {
	const caseId = String(sc._id || sc.id || "unknown");

	// 1) thinking delay
	const thinkMs = first ? 5000 : 1800 + Math.floor(Math.random() * 400); // 1.8–2.2s
	io.log?.(`[aiagent] case=${caseId} human.delay.think`, {
		ms: thinkMs,
		first,
	});
	await sleep(thinkMs);

	// 2) typing delay ~ human chat speed (70–85ms per char, 1.2s–7s clamp)
	const chars = (text || "").length;
	const charMs = 70 + Math.floor(Math.random() * 15);
	const typeMs = Math.min(7000, Math.max(1200, chars * charMs));
	io.log?.(`[aiagent] case=${caseId} human.delay.type`, {
		chars,
		charMs,
		typeMs,
	});
	await sleep(typeMs);

	// 3) persist message
	await io.send(text);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fallback default export for legacy imports
export default { humanSend };
