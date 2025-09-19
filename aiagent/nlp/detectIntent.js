/** @format */
// Very light intent detection for chat control
function parseUserMessage(text, L) {
	const t = text.toLowerCase();

	if (/how are you|كيف حالك|عامل ايه|ازيك|كيفك|كيف الحال/.test(t)) {
		return { type: "SMALL_TALK", subtype: "HOW_ARE_YOU" };
	}
	if (/thanks|thank you|شكرا|متشكر/.test(t)) {
		return { type: "SMALL_TALK", subtype: "THANKS" };
	}
	if (/salam|assalamu|السلام عليكم/.test(t)) {
		return { type: "SMALL_TALK", subtype: "SALAM" };
	}
	if (/\?|what|how|where|متى|كم|أين|كيف/.test(t)) {
		return { type: "QUESTION" };
	}
	return { type: "STATEMENT" };
}

module.exports = { parseUserMessage };
