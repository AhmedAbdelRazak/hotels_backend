// hotels_backend/aiagent/utils/guards.js
export function askedRecently(st, key, ms = 35000) {
	if (!st) return false;
	st.lastAskAt = st.lastAskAt || {};
	const ts = st.lastAskAt[key];
	return !!ts && Date.now() - ts < ms;
}
export function stampAsk(st, key) {
	if (!st) return;
	st.lastAskAt = st.lastAskAt || {};
	st.lastAskAt[key] = Date.now();
}
