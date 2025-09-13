// ai-agent/state.js
// Lightweight in-memory state; you can swap to Redis later.
const sessions = new Map(); // key = caseId

function getSession(caseId) {
	if (!sessions.has(caseId)) {
		sessions.set(caseId, {
			activeLanguage: "en",
			personaName: null,
			lastAssistantMessages: [], // to prevent repetition
		});
	}
	return sessions.get(caseId);
}

function setLanguage(caseId, lang) {
	const s = getSession(caseId);
	s.activeLanguage = lang || "en";
}

function setPersona(caseId, name) {
	const s = getSession(caseId);
	s.personaName = name;
}

function rememberAssistant(caseId, text) {
	const s = getSession(caseId);
	s.lastAssistantMessages.push(text);
	if (s.lastAssistantMessages.length > 5) s.lastAssistantMessages.shift();
}

function isRepetitive(caseId, text) {
	const s = getSession(caseId);
	return s.lastAssistantMessages.some((t) => similarity(t, text) >= 0.85);
}

// simple similarity (Jaccard on words)
function similarity(a, b) {
	const A = new Set(a.toLowerCase().split(/\W+/).filter(Boolean));
	const B = new Set(b.toLowerCase().split(/\W+/).filter(Boolean));
	const inter = [...A].filter((x) => B.has(x)).length;
	const union = new Set([...A, ...B]).size || 1;
	return inter / union;
}

module.exports = {
	getSession,
	setLanguage,
	setPersona,
	rememberAssistant,
	isRepetitive,
};
