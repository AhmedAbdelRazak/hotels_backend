/** @format */

const OpenAI = require("openai");
const {
	PROVIDER_LABELS,
	extractNormalizedReservation,
	htmlToText,
	normalizeWhitespace,
	normalizeConfirmation,
	parseDate,
	parseMoney,
	getSarConversionMeta,
	applyLiveSarConversion,
	redactSensitive,
	safeSnippet,
	detectReservationIntent,
	detectEventType,
	detectStatusToApply,
	detectProvider,
	resolveBookingSource,
} = require("./otaReservationMapper");

const ALLOWED_INTENTS = new Set([
	"new_reservation",
	"reservation_update",
	"reservation_status",
	"not_reservation",
	"unknown",
]);

const ALLOWED_STATUSES = new Set([
	"cancelled",
	"no_show",
	"confirmed",
	"inhouse",
	"checked_out",
	"",
]);

const providerAliases = {
	expedia: "expedia",
	"expedia group": "expedia",
	"booking.com": "booking",
	booking: "booking",
	agoda: "agoda",
	airbnb: "airbnb",
	hotelrunner: "hotelrunner",
	"hotel runner": "hotelrunner",
	"trip.com": "trip",
	trip: "trip",
};

const logOrchestrator = (stage, payload = {}) => {
	console.log(`[ota-orchestrator] ${stage}`, {
		at: new Date().toISOString(),
		...payload,
	});
};

const compactComparable = (value) =>
	normalizeWhitespace(value)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "");

const fieldAppearsInText = (value, text) => {
	const needle = compactComparable(value);
	if (!needle) return false;
	return compactComparable(text).includes(needle);
};

const normalizeProvider = (value) => {
	const key = normalizeWhitespace(value).toLowerCase();
	if (!key) return "";
	return providerAliases[key] || key.replace(/[^a-z0-9]+/g, "_");
};

const normalizeIntent = (value) => {
	const intent = normalizeWhitespace(value).toLowerCase();
	return ALLOWED_INTENTS.has(intent) ? intent : "unknown";
};

const normalizeStatus = (value) => {
	const status = normalizeWhitespace(value).toLowerCase().replace(/[\s-]+/g, "_");
	return ALLOWED_STATUSES.has(status) ? status : "";
};

const numberOrZero = (value) => {
	const parsed = Number(String(value || "").replace(/[^\d.-]/g, ""));
	return Number.isFinite(parsed) ? parsed : 0;
};

const cleanNonReservationWarnings = (warnings = []) =>
	(Array.isArray(warnings) ? warnings : []).filter(
		(warning) =>
			!/could not detect ota provider|missing reservation\/confirmation id|missing or invalid stay dates|missing hotel\/property name|missing room type\/name/i.test(
				String(warning || "")
			)
	);

const cleanStatusWarnings = (warnings = []) =>
	(Array.isArray(warnings) ? warnings : []).filter(
		(warning) =>
			!/missing or invalid stay dates|missing hotel\/property name|missing room type\/name/i.test(
				String(warning || "")
			)
	);

const CLEAR_STATUS_VALUES = new Set([
	"cancelled",
	"no_show",
	"confirmed",
	"inhouse",
	"checked_out",
]);

const getDeterministicStatusSkipReason = (heuristic = {}, emailContext = {}) => {
	const confirmationNumber = normalizeConfirmation(
		heuristic.confirmationNumber || heuristic.reservationId || ""
	);
	const eventType = normalizeWhitespace(heuristic.eventType || "").toLowerCase();
	const intent = normalizeIntent(heuristic.intent);
	const statusToApply = normalizeStatus(heuristic.statusToApply || eventType);
	const providerKnown = !!heuristic.provider && heuristic.provider !== "unknown";
	const hasStatusIntent =
		intent === "reservation_status" ||
		["cancelled", "no_show", "status"].includes(eventType);
	const hasTrustedContext =
		providerKnown ||
		emailContext.senderLooksLikeOta ||
		(emailContext.forwarded && emailContext.subjectHasStrongReservationSignal);

	if (!hasStatusIntent) return "";
	if (!confirmationNumber) return "";
	if (!CLEAR_STATUS_VALUES.has(statusToApply)) return "";
	if (!hasTrustedContext) return "";

	return "Deterministic status email: clear status, exact confirmation number, and trusted OTA/forwarded context were already extracted.";
};

const stripSubjectPrefixes = (subject = "") => {
	let value = normalizeWhitespace(subject);
	let previous = "";
	while (value && previous !== value) {
		previous = value;
		value = value.replace(/^(\[external\]\s*)?((re|fw|fwd)\s*:\s*)+/i, "");
		value = value.replace(/^\[external\]\s*/i, "");
		value = normalizeWhitespace(value);
	}
	return value;
};

const uniqueStrings = (items = []) =>
	Array.from(
		new Set(
			items
				.map((item) => normalizeWhitespace(item))
				.filter(Boolean)
		)
	);

const extractForwardedHeaderBlocks = (text = "") => {
	const lines = String(text || "")
		.replace(/\r/g, "")
		.split("\n")
		.map((line) => normalizeWhitespace(line))
		.filter(Boolean);
	const blocks = [];
	let current = null;

	const pushCurrent = () => {
		if (current && (current.from || current.subject || current.to)) {
			blocks.push(current);
		}
		current = null;
	};

	lines.forEach((line) => {
		if (
			/^(begin forwarded message|[-\s]*forwarded message[-\s]*|[-\s]*original message[-\s]*)/i.test(
				line
			)
		) {
			pushCurrent();
			current = {};
			return;
		}

		const match = line.match(/^(from|sent|date|to|cc|subject):\s*(.+)$/i);
		if (!match) return;
		const key = match[1].toLowerCase() === "date" ? "sent" : match[1].toLowerCase();
		const value = normalizeWhitespace(match[2]);
		if (key === "from" && current && (current.from || current.subject)) {
			pushCurrent();
			current = {};
		}
		if (!current) current = {};
		current[key] = value;
	});
	pushCurrent();

	return blocks.slice(0, 5);
};

const buildRedactedEmailText = (email = {}) => {
	return redactSensitive(
		normalizeWhitespace(
			`${email.subject || ""}\n${email.text || ""}\n${htmlToText(
				email.html || ""
			)}`
		)
	);
};

const buildEmailContext = (email = {}) => {
	const emailText = buildRedactedEmailText(email);
	const forwardedHeaders = extractForwardedHeaderBlocks(emailText);
	const envelopeSubject = normalizeWhitespace(email.subject || "");
	const normalizedSubject = stripSubjectPrefixes(envelopeSubject);
	const forwardedSubjects = forwardedHeaders.map((block) =>
		stripSubjectPrefixes(block.subject || "")
	);
	const forwardedFrom = forwardedHeaders.map((block) => block.from || "");
	const subjectCandidates = uniqueStrings([
		envelopeSubject,
		normalizedSubject,
		...forwardedSubjects,
	]);
	const fromCandidates = uniqueStrings([email.from || "", ...forwardedFrom]);
	const subjectForClassification = subjectCandidates.join(" | ");
	const fromForClassification = fromCandidates.join(" | ");
	const provider = detectProvider({
		from: fromForClassification,
		to: email.to || "",
		subject: subjectForClassification,
		text: emailText,
	});
	const eventType = detectEventType({
		subject: subjectForClassification,
		text: emailText,
	});
	const statusToApply = detectStatusToApply({
		subject: subjectForClassification,
		text: emailText,
	});
	const subjectHasStrongReservationSignal =
		/(new reservation|new booking|reservation confirmation|booking confirmation|confirmation\s*(#|number)?|modified|modification|updated|cancelled|canceled|cancellation|cancelation|reservation status|booking status|no[-\s]?show)/i.test(
			subjectForClassification
		);
	const subjectHasWeakReservationSignal =
		/(reservation|booking|status|heads?\s*up|arrival|guest|check[\s-]?in|check[\s-]?out)/i.test(
			subjectForClassification
		);
	const senderLooksLikeOta = provider !== "unknown";

	return {
		envelopeFrom: normalizeWhitespace(email.from || ""),
		envelopeTo: normalizeWhitespace(email.to || ""),
		envelopeSubject,
		normalizedSubject,
		forwardedHeaders,
		forwarded: forwardedHeaders.length > 0,
		originalFrom: normalizeWhitespace(forwardedHeaders[0]?.from || email.from || ""),
		originalSubject: normalizeWhitespace(
			forwardedHeaders[0]?.subject || normalizedSubject || envelopeSubject
		),
		subjectCandidates,
		fromCandidates,
		subjectForClassification,
		fromForClassification,
		provider,
		eventType,
		statusToApply,
		subjectHasStrongReservationSignal,
		subjectHasWeakReservationSignal,
		senderLooksLikeOta,
	};
};

const applyEmailContextToHeuristic = (heuristic = {}, emailContext = {}, emailText = "") => {
	const merged = {
		...heuristic,
		sourcePresence: { ...(heuristic.sourcePresence || {}) },
		warnings: [...(heuristic.warnings || [])],
		errors: [...(heuristic.errors || [])],
	};

	if ((!merged.provider || merged.provider === "unknown") && emailContext.provider) {
		merged.provider = emailContext.provider;
		merged.providerLabel = PROVIDER_LABELS[emailContext.provider] || emailContext.provider;
	}
	if ((!merged.eventType || merged.eventType === "unknown") && emailContext.eventType) {
		merged.eventType = emailContext.eventType;
	}
	if (
		!merged.statusToApply &&
		emailContext.statusToApply &&
		["cancelled", "no_show", "status"].includes(merged.eventType)
	) {
		merged.statusToApply = emailContext.statusToApply;
	}

	merged.intent = detectReservationIntent({
		subject: emailContext.subjectForClassification || "",
		text: emailText,
		eventType: merged.eventType,
		reservationId: merged.confirmationNumber,
		checkinDate: merged.checkinDate,
		checkoutDate: merged.checkoutDate,
		hotelName: merged.hotelName,
	});

	const hasActionableFields =
		!!merged.confirmationNumber ||
		(!!merged.guestName && !!merged.checkinDate && !!merged.checkoutDate) ||
		(!!merged.hotelName && !!merged.checkinDate && !!merged.checkoutDate);
	if (
		merged.intent === "unknown" &&
		!hasActionableFields &&
		!emailContext.senderLooksLikeOta &&
		!emailContext.subjectHasStrongReservationSignal
	) {
		merged.intent = "not_reservation";
	}
	if (
		merged.intent === "not_reservation" &&
		(emailContext.senderLooksLikeOta || emailContext.subjectHasStrongReservationSignal) &&
		hasActionableFields
	) {
		merged.intent = detectReservationIntent({
			subject: emailContext.subjectForClassification || "",
			text: emailText,
			eventType: merged.eventType,
			reservationId: merged.confirmationNumber,
			checkinDate: merged.checkinDate,
			checkoutDate: merged.checkoutDate,
			hotelName: merged.hotelName,
		});
	}
	if (emailContext.forwarded) {
		merged.warnings.push("Email appears to be forwarded; original sender/subject were included in the decision.");
	}

	return merged;
};

const getOpenAiClient = () => {
	const apiKey = process.env.CHATGPT_API_TOKEN || process.env.OPENAI_API_KEY;
	return apiKey ? new OpenAI({ apiKey }) : null;
};

const askOpenAiForDecision = async (email, heuristic, emailContext) => {
	const deterministicStatusReason = getDeterministicStatusSkipReason(
		heuristic,
		emailContext
	);
	if (deterministicStatusReason) {
		logOrchestrator("ai.skipped", {
			reason: deterministicStatusReason,
			intent: heuristic.intent,
			provider: heuristic.provider,
			eventType: heuristic.eventType,
			statusToApply: heuristic.statusToApply || "",
			confirmationNumber: heuristic.confirmationNumber,
		});
		return {
			usedAI: false,
			skipped: true,
			reason: deterministicStatusReason,
		};
	}

	const client = getOpenAiClient();
	if (!client) {
		logOrchestrator("ai.skipped", {
			reason: "OPENAI_API_KEY/CHATGPT_API_TOKEN is not configured.",
			intent: heuristic.intent,
			provider: heuristic.provider,
			confirmationNumber: heuristic.confirmationNumber,
		});
		return {
			usedAI: false,
			skipped: true,
			reason: "OPENAI_API_KEY/CHATGPT_API_TOKEN is not configured.",
		};
	}

	const model =
		process.env.OPENAI_REASONING_MODEL ||
		process.env.OPENAI_MODEL_NLU ||
		"gpt-4o-mini";
	const body = buildRedactedEmailText(email).slice(0, 8000);

	try {
		logOrchestrator("ai.start", {
			model,
			provider: heuristic.provider,
			intent: heuristic.intent,
			confirmationNumber: heuristic.confirmationNumber,
			originalFrom: emailContext.originalFrom,
			originalSubject: emailContext.originalSubject,
		});
		const response = await client.chat.completions.create(
			{
				model,
				response_format: { type: "json_object" },
				messages: [
					{
						role: "system",
						content:
							"Return strict JSON only. You are a very strict PMS reservation email classifier and extractor. Never invent a field. If a field is not clearly present, return an empty string. Status changes must only be applied when a confirmation number is present. For hotel names, preserve the exact hotel text from the email and optionally return hotelNameAliases containing only spelling/transliteration variants that can be derived from that same text, such as removing generic brand/location words, el/al spelling, apostrophes, Arabizi digits, or extra OTA/location descriptors. Do not guess a PMS hotel that is not present in the email.",
					},
					{
						role: "user",
						content: JSON.stringify({
							task:
								"Decide whether this inbound email is a reservation, reservation update, reservation status email, or not a reservation.",
							hotelMatchingGuidance: [
								"Hotel names may be partial or noisy compared with PMS names.",
								"Treat common brand prefixes, missing prefixes, extra locality/property words, apostrophes, and Arabic transliteration differences as alias candidates.",
								"Examples of patterns to reason about dynamically: 'Al Magd' may refer to a PMS hotel named with a brand prefix plus a close transliteration; 'Zad Al Sukaraya Al Masha3er' may refer to the Mashaer hotel even with an extra descriptor.",
								"Return the exact email hotelName plus derived hotelNameAliases only; final PMS matching is done separately against the allowed hotel list.",
							],
							allowedIntents: [...ALLOWED_INTENTS],
							allowedStatuses: [...ALLOWED_STATUSES],
							requiredForNewReservation: [
								"confirmationNumber",
								"guestName",
								"checkinDate",
								"checkoutDate",
								"hotelName",
							],
							email: {
								envelopeFrom: emailContext.envelopeFrom || email.from || "",
								envelopeTo: emailContext.envelopeTo || email.to || "",
								envelopeSubject: emailContext.envelopeSubject || email.subject || "",
								normalizedSubject: emailContext.normalizedSubject || "",
								originalFrom: emailContext.originalFrom || "",
								originalSubject: emailContext.originalSubject || "",
								fromCandidates: emailContext.fromCandidates || [],
								subjectCandidates: emailContext.subjectCandidates || [],
								forwardedHeaders: emailContext.forwardedHeaders || [],
								body,
							},
							heuristic,
							expectedResponse: {
								intent: "new_reservation",
								confidence: 0.9,
								provider: "Expedia",
								eventType: "new",
								statusToApply: "",
								confirmationNumber: "",
								guestName: "",
								guestEmail: "",
								guestPhone: "",
								nationality: "",
								hotelName: "",
								hotelNameAliases: [],
								roomName: "",
								checkinDate: "YYYY-MM-DD",
								checkoutDate: "YYYY-MM-DD",
								bookedAt: "YYYY-MM-DD",
								totalGuests: 1,
								adults: 1,
								children: 0,
								roomCount: 1,
								totalAmount: 0,
								currency: "SAR",
								reasons: [],
								warnings: [],
							},
						}),
					},
				],
			},
			{ timeout: 15000 }
		);
		const content = response.choices?.[0]?.message?.content || "{}";
		const parsed = JSON.parse(content);
		logOrchestrator("ai.done", {
			model,
			intent: parsed?.intent || "",
			confidence: parsed?.confidence || 0,
			provider: parsed?.provider || "",
			eventType: parsed?.eventType || "",
			statusToApply: parsed?.statusToApply || "",
			confirmationNumber: normalizeConfirmation(parsed?.confirmationNumber || ""),
		});
		return {
			usedAI: true,
			model,
			decision: parsed && typeof parsed === "object" ? parsed : {},
		};
	} catch (error) {
		console.error("[ota-email-orchestrator] OpenAI decision failed:", error.message);
		logOrchestrator("ai.error", {
			model,
			error: error.message,
		});
		return {
			usedAI: false,
			model,
			error: error.message,
		};
	}
};

const pickAiString = (decision, key) => normalizeWhitespace(decision?.[key] || "");

const mergeAiDecision = ({ heuristic, aiResult, emailText, email, emailContext }) => {
	const decision = aiResult?.decision || {};
	const merged = {
		...heuristic,
		sourcePresence: { ...(heuristic.sourcePresence || {}) },
		warnings: [...(heuristic.warnings || [])],
		errors: [...(heuristic.errors || [])],
	};
	const markPresent = (field) => {
		merged.sourcePresence[field] = true;
	};

	const aiIntent = normalizeIntent(decision.intent);
	const aiConfidence = Number(decision.confidence || 0);
	if (
		aiIntent &&
		aiConfidence >= 0.55 &&
		["unknown", "not_reservation"].includes(merged.intent)
	) {
		merged.intent = aiIntent;
	}
	if (aiIntent === "not_reservation" && aiConfidence >= 0.85) {
		merged.intent = "not_reservation";
	}

	const provider = normalizeProvider(pickAiString(decision, "provider"));
	if ((!merged.provider || merged.provider === "unknown") && provider) {
		merged.provider = provider;
		merged.providerLabel = PROVIDER_LABELS[provider] || pickAiString(decision, "provider");
	}

	const eventType = normalizeWhitespace(decision.eventType || "").toLowerCase();
	if ((!merged.eventType || merged.eventType === "unknown") && eventType) {
		merged.eventType = eventType;
	}

	const statusToApply = normalizeStatus(decision.statusToApply);
	if (
		!merged.statusToApply &&
		statusToApply &&
		(aiIntent === "reservation_status" ||
			["cancelled", "no_show", "status"].includes(merged.eventType))
	) {
		merged.statusToApply = statusToApply;
	}

	const confirmationNumber = normalizeConfirmation(
		pickAiString(decision, "confirmationNumber")
	);
	if (
		!merged.confirmationNumber &&
		confirmationNumber &&
		fieldAppearsInText(confirmationNumber, emailText)
	) {
		merged.confirmationNumber = confirmationNumber;
		merged.reservationId = confirmationNumber;
		markPresent("confirmationNumber");
		markPresent("reservationId");
	}

	const fillString = (targetKey, aiKey = targetKey, requireAppears = false) => {
		if (merged[targetKey]) return;
		const value = pickAiString(decision, aiKey);
		if (!value) return;
		if (requireAppears && !fieldAppearsInText(value, emailText)) return;
		merged[targetKey] = value;
		markPresent(targetKey);
	};

	fillString("guestName", "guestName");
	fillString("guestEmail", "guestEmail", true);
	fillString("guestPhone", "guestPhone");
	fillString("nationality", "nationality");
	fillString("hotelName", "hotelName");
	fillString("roomName", "roomName");
	if (Array.isArray(decision.hotelNameAliases)) {
		merged.hotelNameAliases = decision.hotelNameAliases
			.map((item) => normalizeWhitespace(item))
			.filter((item) => item && fieldAppearsInText(item, emailText));
	}

	const checkinDate = parseDate(decision.checkinDate);
	const checkoutDate = parseDate(decision.checkoutDate);
	const bookedAt = parseDate(decision.bookedAt);
	if (!merged.checkinDate && checkinDate) {
		merged.checkinDate = checkinDate;
		markPresent("checkinDate");
	}
	if (!merged.checkoutDate && checkoutDate) {
		merged.checkoutDate = checkoutDate;
		markPresent("checkoutDate");
	}
	if (!merged.bookedAt && bookedAt) {
		merged.bookedAt = bookedAt;
		markPresent("bookedAt");
	}

	if (!merged.totalGuests && numberOrZero(decision.totalGuests)) {
		merged.totalGuests = numberOrZero(decision.totalGuests);
		markPresent("totalGuests");
	}
	if (!merged.adults && numberOrZero(decision.adults)) {
		merged.adults = numberOrZero(decision.adults);
		markPresent("adults");
	}
	if (!merged.children && numberOrZero(decision.children)) {
		merged.children = numberOrZero(decision.children);
		markPresent("children");
	}
	if (!merged.roomCount && numberOrZero(decision.roomCount)) {
		merged.roomCount = numberOrZero(decision.roomCount);
		markPresent("roomCount");
	}

	if (!merged.amount && numberOrZero(decision.totalAmount)) {
		merged.amount = numberOrZero(decision.totalAmount);
		merged.currency = normalizeWhitespace(decision.currency || merged.currency || "");
		const conversion = getSarConversionMeta(merged.amount, merged.currency);
		merged.totalAmountSar = conversion.totalAmountSar;
		merged.exchangeRateToSar = conversion.exchangeRateToSar;
		merged.exchangeRateSource = conversion.exchangeRateSource;
		merged.amountConvertedAt = conversion.convertedAt;
		markPresent("amount");
	} else if (!merged.amount && pickAiString(decision, "totalAmount")) {
		const parsedMoney = parseMoney(pickAiString(decision, "totalAmount"));
		if (parsedMoney.amount) {
			merged.amount = parsedMoney.amount;
			merged.currency = parsedMoney.currency || merged.currency;
			const conversion = getSarConversionMeta(merged.amount, merged.currency);
			merged.totalAmountSar = conversion.totalAmountSar;
			merged.exchangeRateToSar = conversion.exchangeRateToSar;
			merged.exchangeRateSource = conversion.exchangeRateSource;
			merged.amountConvertedAt = conversion.convertedAt;
			markPresent("amount");
		}
	}

	const detectedEventType = detectEventType({
		subject: emailContext.subjectForClassification || email.subject,
		text: emailText,
	});
	const detectedStatus = detectStatusToApply({
		subject: emailContext.subjectForClassification || email.subject,
		text: emailText,
	});
	if (!merged.eventType || merged.eventType === "unknown") {
		merged.eventType = detectedEventType;
	}
	if (
		!merged.statusToApply &&
		detectedStatus &&
		["cancelled", "no_show", "status"].includes(merged.eventType)
	) {
		merged.statusToApply = detectedStatus;
	}

	const recalculatedIntent = detectReservationIntent({
		subject: emailContext.subjectForClassification || email.subject,
		text: emailText,
		eventType: merged.eventType,
		reservationId: merged.confirmationNumber,
		checkinDate: merged.checkinDate,
		checkoutDate: merged.checkoutDate,
		hotelName: merged.hotelName,
	});
	if (!(merged.intent === "not_reservation" && recalculatedIntent === "unknown")) {
		merged.intent = recalculatedIntent;
	}
	if (merged.intent === "not_reservation") {
		merged.warnings = cleanNonReservationWarnings(merged.warnings);
	} else if (merged.intent === "reservation_status") {
		merged.warnings = cleanStatusWarnings(merged.warnings);
	}
	if (!merged.bookingSource) {
		merged.bookingSource = resolveBookingSource({
			provider: merged.provider,
			providerLabel: merged.providerLabel,
			from: emailContext.fromForClassification || email.from || "",
			subject: emailContext.subjectForClassification || email.subject || "",
		});
	}

	const aiWarnings = Array.isArray(decision.warnings) ? decision.warnings : [];
	aiWarnings
		.map((warning) => normalizeWhitespace(warning))
		.filter(Boolean)
		.forEach((warning) => merged.warnings.push(`AI: ${warning}`));

	return {
		normalized: merged,
		decision: {
			usedAI: !!aiResult?.usedAI,
			model: aiResult?.model || "",
			skipped: !!aiResult?.skipped,
			skipReason: aiResult?.reason || "",
			error: aiResult?.error || "",
			intent: merged.intent,
			confidence: aiConfidence || 0,
			provider: merged.provider,
			eventType: merged.eventType,
			statusToApply: merged.statusToApply || "",
			reasons: Array.isArray(decision.reasons) ? decision.reasons : [],
			warnings: aiWarnings,
			requiredFields: {
				confirmationNumber: !!merged.confirmationNumber,
				guestName: !!merged.guestName,
				checkinDate: !!merged.checkinDate,
				checkoutDate: !!merged.checkoutDate,
				hotelName: !!merged.hotelName,
			},
			emailContext,
		},
	};
};

const orchestrateInboundReservationEmail = async (email = {}) => {
	logOrchestrator("start", {
		envelopeFrom: email.from || "",
		envelopeTo: email.to || "",
		envelopeSubject: email.subject || "",
	});

	const emailText = buildRedactedEmailText(email);
	const emailContext = buildEmailContext(email);
	logOrchestrator("context.built", {
		forwarded: emailContext.forwarded,
		originalFrom: emailContext.originalFrom,
		originalSubject: emailContext.originalSubject,
		providerFromEnvelope: emailContext.provider,
		eventTypeFromEnvelope: emailContext.eventType,
		statusToApplyFromEnvelope: emailContext.statusToApply || "",
		subjectCandidates: emailContext.subjectCandidates,
		fromCandidates: emailContext.fromCandidates,
	});

	const heuristicEmail = {
		...email,
		from: emailContext.fromForClassification || email.from || "",
		subject: emailContext.subjectForClassification || email.subject || "",
	};
	let heuristic = applyEmailContextToHeuristic(
		extractNormalizedReservation(heuristicEmail),
		emailContext,
		emailText
	);
	heuristic = await applyLiveSarConversion(heuristic);
	logOrchestrator("heuristic.extracted", {
		provider: heuristic.provider,
		intent: heuristic.intent,
		eventType: heuristic.eventType,
		statusToApply: heuristic.statusToApply || "",
		confirmationNumber: heuristic.confirmationNumber,
		hotelName: heuristic.hotelName,
		roomName: heuristic.roomName,
		checkinDate: heuristic.checkinDate,
		checkoutDate: heuristic.checkoutDate,
		guestNamePresent: !!heuristic.guestName,
		totalAmountSar: heuristic.totalAmountSar,
		warnings: heuristic.warnings || [],
		errors: heuristic.errors || [],
	});

	const aiResult = await askOpenAiForDecision(email, heuristic, emailContext);
	const merged = mergeAiDecision({
		heuristic,
		aiResult,
		emailText,
		email,
		emailContext,
	});
	merged.normalized = await applyLiveSarConversion(merged.normalized);
	logOrchestrator("decision.final", {
		provider: merged.normalized.provider,
		intent: merged.normalized.intent,
		eventType: merged.normalized.eventType,
		statusToApply: merged.normalized.statusToApply || "",
		confirmationNumber: merged.normalized.confirmationNumber,
		hotelName: merged.normalized.hotelName,
		roomName: merged.normalized.roomName,
		checkinDate: merged.normalized.checkinDate,
		checkoutDate: merged.normalized.checkoutDate,
		usedAI: !!merged.decision?.usedAI,
		aiSkipped: !!merged.decision?.skipped,
		aiSkipReason: merged.decision?.skipReason || "",
		warnings: merged.normalized.warnings || [],
		errors: merged.normalized.errors || [],
	});

	return {
		...merged,
		emailContext,
		emailText,
		safeSnippet: safeSnippet(emailText, 800),
	};
};

module.exports = {
	orchestrateInboundReservationEmail,
	buildRedactedEmailText,
	buildEmailContext,
};
