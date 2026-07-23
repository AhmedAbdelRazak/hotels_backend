/** @format */

/*
 * Guest-message notifications are not reservation state changes. Keep this
 * classifier deterministic so they can be discarded before any AI or queue
 * work is started.
 */

const normalizeWhitespace = (value = "") =>
	String(value || "")
		.replace(/&nbsp;|&#160;/gi, " ")
		.replace(/\s+/g, " ")
		.trim();

const stripHtml = (value = "") =>
	String(value || "").replace(
		/<\/?(?:!doctype|html|head|body|div|p|br|table|tr|td|span|a|img|strong|b|em|i|ul|ol|li|h[1-6])\b[^>]*>/gi,
		" "
	);

const stripSubjectPrefixes = (subject = "") => {
	let value = normalizeWhitespace(subject);
	let previous = "";
	while (value && previous !== value) {
		previous = value;
		value = value.replace(/^\[external\]\s*/i, "");
		value = value.replace(/^((re|fw|fwd)\s*:\s*)+/i, "");
		value = normalizeWhitespace(value);
	}
	return value;
};

const compactUnique = (values = []) =>
	Array.from(new Set(values.map(normalizeWhitespace).filter(Boolean)));

const buildCommunicationContext = (email = {}, context = {}) => {
	const fromCandidates = compactUnique([
		email.from,
		email.originalFrom,
		...(Array.isArray(email.fromCandidates) ? email.fromCandidates : []),
		context.from,
		context.originalFrom,
		...(Array.isArray(context.fromCandidates) ? context.fromCandidates : []),
	]);
	const subjectCandidates = compactUnique([
		email.subject,
		email.originalSubject,
		...(Array.isArray(email.subjectCandidates) ? email.subjectCandidates : []),
		context.subject,
		context.originalSubject,
		...(Array.isArray(context.subjectCandidates) ? context.subjectCandidates : []),
	]).map(stripSubjectPrefixes);
	const body = normalizeWhitespace(
		stripHtml(
			[email.text, email.html, context.text, context.emailText]
				.filter(Boolean)
				.join("\n")
		)
	);
	const providerHints = compactUnique([
		email.provider,
		context.provider,
		context.providerLabel,
	]).map((value) => value.toLowerCase());

	return {
		fromCandidates,
		subjectCandidates,
		body,
		fromText: fromCandidates.join(" | "),
		subjectText: subjectCandidates.join(" | "),
		providerHints,
	};
};

const unmatchedClassification = () => ({
	matched: false,
	isGuestCommunication: false,
	terminalNonReservation: false,
	suppressForwarding: false,
	intent: "",
	classification: "",
	reason: "",
	provider: "",
	evidence: [],
});

const matchedClassification = ({ provider, reason, evidence = [] }) => ({
	matched: true,
	isGuestCommunication: true,
	terminalNonReservation: true,
	suppressForwarding: true,
	intent: "not_reservation",
	classification: "guest_communication",
	reason,
	provider,
	evidence,
});

const classifyOtaGuestCommunication = (email = {}, context = {}) => {
	const built = buildCommunicationContext(email, context);
	const { fromText, subjectCandidates, subjectText, body, providerHints } = built;
	const allText = `${fromText}\n${subjectText}\n${body}`;
	const internalJannatSender =
		/\b(?:noreply|no-reply|support)@(?:[\w-]+\.)*jannatbooking\.com\b/i.test(
			fromText
		);
	const internalJannatTransactionalSubject = subjectCandidates.some((subject) =>
		/^(?:reservation confirmation\s*-\s*invoice attached|payment link\s*-\s*.+\(?#\d+\)?)$/i.test(
			subject
		)
	);
	if (internalJannatSender && internalJannatTransactionalSubject) {
		return matchedClassification({
			provider: "jannatbooking",
			reason: "internal_jannat_transactional_email",
			evidence: ["internal_sender", "transactional_subject"],
		});
	}
	const strongReservationSubject = subjectCandidates.some((subject) =>
		/(?:\bnew\s+(?:booking|reservation)\b|\b(?:booking|reservation)(?:\s+(?:(?:id|number|#)\s*)?[a-z0-9-]{5,})?\s*(?:[-:]\s*)?(?:confirmed|confirmation)\b|\b(?:confirmed|confirmation)\s+(?:booking|reservation)\b)/i.test(
			subject,
		),
	);
	// A canonical booking-confirmation subject always wins over message snippets
	// embedded in the body (for example a guest relay address or CTA footer).
	if (strongReservationSubject) return unmatchedClassification();

	const hotelRunnerSender = /\b[\w.+-]+@(?:[\w-]+\.)*hotelrunner\.com\b/i.test(
		fromText
	);
	const hotelRunnerHint = providerHints.some((value) =>
		/^(hotelrunner|hotel runner)$/.test(value)
	);
	const hotelRunnerConversationUrl =
		/https?:\/\/(?:[\w-]+\.)*hotelrunner\.com\/admin\/grm\/conversations\b/i.test(
			allText
		);
	const hotelRunnerMessageSubject = subjectCandidates.some((subject) =>
		/^you have a message!?$/i.test(subject)
	);
	const hotelRunnerDirectMessage =
		/\bsent you (?:a )?direct message\b|\bwrite a reply\b/i.test(body);
	if (
		(hotelRunnerSender || hotelRunnerHint || hotelRunnerConversationUrl) &&
		(hotelRunnerMessageSubject || hotelRunnerDirectMessage || hotelRunnerConversationUrl)
	) {
		return matchedClassification({
			provider: "hotelrunner",
			reason: "hotelrunner_guest_message",
			evidence: [
				...(hotelRunnerMessageSubject ? ["message_subject"] : []),
				...(hotelRunnerDirectMessage ? ["direct_message_template"] : []),
				...(hotelRunnerConversationUrl ? ["conversation_link"] : []),
			],
		});
	}

	const agodaMessagingSender =
		/\b[\w.+-]+@(?:[\w-]+\.)*agoda-messaging\.com\b/i.test(fromText);
	const agodaMessageSubject = subjectCandidates.some((subject) =>
		/^(?:special request\b|inquiry\b|reply\b)/i.test(subject)
	);
	const agodaMessageTemplate =
		/\b(?:new message from|reply through ycs|message type\s*[:=]\s*message)\b/i.test(
			body
		);
	if (
		(agodaMessagingSender && (agodaMessageSubject || agodaMessageTemplate)) ||
		((agodaMessageSubject || agodaMessageTemplate) && /agoda/i.test(allText))
	) {
		return matchedClassification({
			provider: "agoda",
			reason: "agoda_guest_message",
			evidence: [
				...(agodaMessagingSender ? ["messaging_sender"] : []),
				...(agodaMessageSubject ? ["message_subject"] : []),
				...(agodaMessageTemplate ? ["message_template"] : []),
			],
		});
	}

	const airbnbSender = /\b[\w.+-]+@(?:[\w-]+\.)*airbnb\.com\b/i.test(
		fromText
	);
	const airbnbHint = providerHints.some((value) => value === "airbnb");
	const airbnbMessageSubject = subjectCandidates.some((subject) =>
		/^(?:inquiry for\b|(?:you have a )?(?:new )?(?:message|inquiry) from\b|.{1,100}\s+(?:sent|wrote) (?:you )?(?:a )?message\b|.{1,100}\s+wants to change (?:his|her|their|the) reservation\b)/i.test(
			subject
		)
	);
	const airbnbMessageTemplate =
		/\b(?:(?:new )?message from (?:your )?guest|guest.{0,80}sent you a message)\b/i.test(
			body
		);
	if (
		(airbnbSender || airbnbHint) &&
		(airbnbMessageSubject || airbnbMessageTemplate)
	) {
		return matchedClassification({
			provider: "airbnb",
			reason: "airbnb_guest_message",
			evidence: [
				...(airbnbMessageSubject ? ["message_subject"] : []),
				...(airbnbMessageTemplate ? ["message_template"] : []),
			],
		});
	}

	const bookingSender = /\b[\w.+-]+@(?:[\w-]+\.)*booking\.com\b/i.test(
		fromText
	);
	const bookingHint = providerHints.some((value) =>
		/^(booking|booking\.com)$/.test(value)
	);
	const bookingMessageSubject = subjectCandidates.some((subject) =>
		/^(?:(?:you have (?:a )?)?new\s+message\s+from\b|guest\s+message\b|message\s+from\s+(?:your\s+)?guest\b|.{1,100}\s+sent you a message\b)/i.test(
			subject
		)
	);
	const bookingMessageTemplate =
		/\b(?:message from (?:your )?guest|reply (?:to this message|via (?:the )?extranet)|open (?:the )?conversation)\b/i.test(
			body
		);
	if (
		(bookingSender || bookingHint) &&
		(bookingMessageSubject || bookingMessageTemplate)
	) {
		return matchedClassification({
			provider: "booking",
			reason: "booking_guest_message",
			evidence: [
				...(bookingMessageSubject ? ["message_subject"] : []),
				...(bookingMessageTemplate ? ["message_template"] : []),
			],
		});
	}

	const expediaSender =
		/\b[\w.+-]+@(?:[\w-]+\.)*(?:expedia|expediagroup|hotels)\.com\b/i.test(
			fromText
		);
	const expediaHint = providerHints.some((value) =>
		/^(expedia|hotels|hotels\.com)$/.test(value)
	);
	const expediaMessageSubject = subjectCandidates.some((subject) =>
		/^(?:new\s+message\s+from\b|(?:guest|traveler|traveller)\s+message\b|message\s+from\s+(?:your\s+)?(?:guest|travell?er)\b)/i.test(
			subject
		)
	);
	const expediaMessageTemplate =
		/\b(?:(?:guest|travell?er) sent you a message|reply in partner central|conversation with (?:the )?(?:guest|travell?er))\b/i.test(
			body
		);
	if (
		(expediaSender || expediaHint) &&
		(expediaMessageSubject || expediaMessageTemplate)
	) {
		const provider = /hotels(?:\.com)?/i.test(`${fromText} ${providerHints.join(" ")}`)
			? "hotels"
			: "expedia";
		return matchedClassification({
			provider,
			reason: `${provider}_guest_message`,
			evidence: [
				...(expediaMessageSubject ? ["message_subject"] : []),
				...(expediaMessageTemplate ? ["message_template"] : []),
			],
		});
	}

	const tripSender = /\b[\w.+-]+@(?:[\w-]+\.)*trip\.com\b/i.test(fromText);
	const tripHint = providerHints.some((value) =>
		/^(trip|trip\.com)$/.test(value)
	);
	const tripMessageSubject = subjectCandidates.some((subject) =>
		/^(?:(?:new\s+)?(?:guest|travell?er)\s+message\b|new\s+message\s+from\b|inquiry\s+from\s+(?:a\s+)?guest\b)/i.test(
			subject
		)
	);
	const tripMessageTemplate =
		/\b(?:guest sent you a message|reply (?:to the guest|in the extranet)|view (?:the )?conversation)\b/i.test(
			body
		);
	if ((tripSender || tripHint) && (tripMessageSubject || tripMessageTemplate)) {
		return matchedClassification({
			provider: "trip",
			reason: "trip_guest_message",
			evidence: [
				...(tripMessageSubject ? ["message_subject"] : []),
				...(tripMessageTemplate ? ["message_template"] : []),
			],
		});
	}

	return unmatchedClassification();
};

module.exports = {
	buildCommunicationContext,
	classifyOtaGuestCommunication,
	stripSubjectPrefixes,
};
