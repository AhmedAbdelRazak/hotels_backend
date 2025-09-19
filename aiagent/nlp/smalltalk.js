/** @format */
function respondSmallTalk(text, L) {
	const t = text.toLowerCase();

	if (/السلام عليكم|salam|assalamu/.test(t)) {
		return L.t("salam_reply");
	}
	if (/how are you|عامل ايه|ازيك|كيف حالك|كيفك|كيف الحال/.test(t)) {
		return L.t("how_are_you_reply");
	}
	if (/thanks|thank you|شكرا|متشكر/.test(t)) {
		return L.t("welcome_reply");
	}
	return null;
}

module.exports = { respondSmallTalk };
