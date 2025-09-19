/** @format */
// aiagent/core/state.js
const _states = new Map();

function getOrCreateCaseState(caseId) {
	if (!_states.has(caseId)) {
		_states.set(caseId, {
			agentName: null,
			agentEmail: "management@xhotelpro.com",
			languageLabel: "English",
			greeted: false,
			greetTimer: null,
			inFlight: false,

			userTyping: false,
			userTypingLastAt: 0,

			lastAskKey: null,
			lastAskAt: 0,
			lastAiText: "",
			lastAiAt: 0,

			awaiting: null,
			farewellSent: false,
			smalltalkCount: 0,

			ctx: {
				intent: "other",
				checkinISO: null,
				checkoutISO: null,
				nights: null,
				roomType: null,
				displayName: null,
				guests: 2,
				adults: null,
				children: null,
				confirmation: null,
				reservation: null, // full doc if fetched
				quote: null,
				customerName: null,
				nationality: null,
				phone: null,
				email: null,
			},
		});
	}
	return _states.get(caseId);
}

function clearCase(caseId) {
	if (_states.has(caseId)) _states.delete(caseId);
}

module.exports = { getOrCreateCaseState, clearCase };
