/** @format */

process.env.SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "SG.test";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
	classifyOtaGuestCommunication,
} = require("./otaInboundCommunicationClassifier");
const {
	buildImportantEmailForwardDecision,
} = require("./inboundEmailForwarder");
const {
	orchestrateInboundReservationEmail,
} = require("./otaEmailOrchestrator");

test("HotelRunner direct-message notification is terminal and never forwarded", () => {
	const email = {
		from: '"Boycott" <noreply@hotelrunner.com>',
		subject: "You have a message!",
		text: [
			"Boycott sent you a direct message",
			"Write a reply",
			"https://zad-ajyad.hotelrunner.com/admin/grm/conversations?conversation_id=5855801",
			"Security and privacy are important issues to us.",
		].join("\n"),
	};
	const classification = classifyOtaGuestCommunication(email);

	assert.equal(classification.matched, true);
	assert.equal(classification.intent, "not_reservation");
	assert.equal(classification.terminalNonReservation, true);
	assert.equal(classification.suppressForwarding, true);
	assert.equal(classification.reason, "hotelrunner_guest_message");

	const decision = buildImportantEmailForwardDecision({
		email,
		normalized: { provider: "hotelrunner" },
		reconciliation: { status: "needs_review" },
	});
	assert.equal(decision.shouldForward, false);
	assert.equal(decision.suppressed, true);
	assert.equal(decision.reason, "hotelrunner_guest_message");
});

test("forwarded HotelRunner conversation links are recognized without relying on envelope sender", () => {
	const classification = classifyOtaGuestCommunication({
		from: "Reservations Desk <reservations@example.com>",
		subject: "Fwd: You have a message!",
		text: [
			"From: HotelRunner <noreply@hotelrunner.com>",
			"Subject: You have a message!",
			"https://hotel.hotelrunner.com/admin/grm/conversations?conversation_id=42",
		].join("\n"),
	});

	assert.equal(classification.matched, true);
	assert.equal(classification.provider, "hotelrunner");
});

test("generic message subjects are not suppressed without OTA evidence", () => {
	const classification = classifyOtaGuestCommunication({
		from: "notifications@example.com",
		subject: "You have a message!",
		text: "A general system notification.",
	});

	assert.equal(classification.matched, false);
	assert.equal(classification.suppressForwarding, false);
});

test("Jannat transactional copies terminate before AI without hiding forwarded OTA mail", async () => {
	for (const subject of [
		"Reservation Confirmation - Invoice Attached",
		"Payment Link - zad ajyad (#4412872960)",
	]) {
		const email = {
			from: "noreply@jannatbooking.com",
			to: "guest@example.com",
			subject,
			text: "This is an outgoing Jannat transactional copy.",
		};
		const classification = classifyOtaGuestCommunication(email);
		assert.equal(classification.matched, true, subject);
		assert.equal(classification.reason, "internal_jannat_transactional_email");

		const orchestration = await orchestrateInboundReservationEmail(email);
		assert.equal(orchestration.normalized.intent, "not_reservation", subject);
		assert.equal(orchestration.decision.usedAI, false, subject);
		assert.equal(
			orchestration.decision.skipReason,
			"internal_jannat_transactional_email",
			subject
		);
	}

	const forwardedOta = classifyOtaGuestCommunication({
		from: "support@jannatbooking.com",
		subject: "Fw: Expedia - New Booking - Arriving on 21 Dec 2026",
		text: "Expedia booking confirmation 987654321",
	});
	assert.equal(forwardedOta.matched, false);
});

test("Agoda messaging notifications are terminal but booking confirmations are not", () => {
	for (const subject of [
		"Special Request for Booking ID 2035192058",
		"Inquiry by Guest of Ubair Shahid",
		"Reply from Guest of Yahya Almalki",
	]) {
		const classification = classifyOtaGuestCommunication({
			from: "Agoda <notifications@agoda-messaging.com>",
			subject,
			text: "New message from your guest. Reply through YCS.",
		});
		assert.equal(classification.matched, true, subject);
		assert.equal(classification.intent, "not_reservation", subject);
		assert.equal(classification.suppressForwarding, true, subject);
	}

	const confirmation = classifyOtaGuestCommunication({
		from: "Agoda <no-reply@agoda.com>",
		subject: "Agoda Booking ID 2035192058 - CONFIRMED",
		text: [
			"Guest email: booking-2035192058@agoda-messaging.com",
			"Special Request: Late arrival",
		].join("\n"),
	});
	assert.equal(confirmation.matched, false);
});

test("Airbnb guest conversation subjects are terminal but confirmations are not", () => {
	for (const subject of [
		"Sahad wants to change their reservation",
		"Inquiry for Double Room near Haram",
		"Fatima sent you a message",
	]) {
		const classification = classifyOtaGuestCommunication({
			from: "Airbnb <automated@airbnb.com>",
			subject: `Fwd: ${subject}`,
		});
		assert.equal(classification.matched, true, subject);
		assert.equal(classification.reason, "airbnb_guest_message", subject);
	}

	const confirmation = classifyOtaGuestCommunication({
		from: "Airbnb <automated@airbnb.com>",
		subject: "Reservation confirmed - HM12345678",
		text: "Your guest Jane sent you a message after booking.",
	});
	assert.equal(confirmation.matched, false);
});

test("Booking, Expedia, Hotels.com, and Trip guest messages are terminal", () => {
	for (const sample of [
		{
			provider: "booking",
			from: "Booking.com <messages@booking.com>",
			subject: "You have a new message from Khalil",
			text: "Reply to this message via the Extranet.",
		},
		{
			provider: "expedia",
			from: "Expedia Partner Central <notifications@expedia.com>",
			subject: "Traveler message",
			text: "A traveler sent you a message. Reply in Partner Central.",
		},
		{
			provider: "hotels",
			from: "Hotels.com <messages@hotels.com>",
			subject: "Guest message",
			text: "Conversation with the guest.",
		},
		{
			provider: "trip",
			from: "Trip.com <messages@trip.com>",
			subject: "New guest message",
			text: "View the conversation and reply to the guest.",
		},
	]) {
		const classification = classifyOtaGuestCommunication(sample);
		assert.equal(classification.matched, true, sample.provider);
		assert.equal(classification.provider, sample.provider, sample.provider);
		assert.equal(classification.terminalNonReservation, true, sample.provider);
		assert.equal(classification.suppressForwarding, true, sample.provider);
	}
});

test("reservation confirmation subjects override provider message footers", () => {
	for (const sample of [
		{
			from: "Booking.com <messages@booking.com>",
			subject: "New reservation confirmed - 12345678",
			text: "Reply to this message via the Extranet.",
		},
		{
			from: "Expedia <notifications@expedia.com>",
			subject: "Reservation 98765432 confirmed",
			text: "A traveler sent you a message.",
		},
		{
			from: "Trip.com <notifications@trip.com>",
			subject: "Booking confirmed - 24681357",
			text: "View the conversation.",
		},
	]) {
		assert.equal(classifyOtaGuestCommunication(sample).matched, false, sample.subject);
	}
});

test("bare important and urgent words do not create action-required forwards", () => {
	for (const text of [
		"Security and privacy are important issues to us.",
		"This notice is urgent, please retain it for your records.",
	]) {
		const decision = buildImportantEmailForwardDecision({
			email: {
				from: "noreply@hotelrunner.com",
				subject: "General notice",
				text,
			},
			normalized: { provider: "hotelrunner" },
			reconciliation: { status: "not_reservation" },
		});
		assert.equal(decision.shouldForward, false, text);
		assert.deepEqual(decision.categories, [], text);
	}
});

test("specific OTA action-required phrases still forward", () => {
	const decision = buildImportantEmailForwardDecision({
		email: {
			from: "noreply@hotelrunner.com",
			subject: "Action required: complete property verification",
		},
		normalized: { provider: "hotelrunner" },
		reconciliation: { status: "not_reservation" },
	});

	assert.equal(decision.shouldForward, true);
	assert.equal(decision.reason, "verification_email");
	assert.ok(decision.categories.includes("ota_action_required"));
});

test("explicit orchestration suppression wins over actionable status and terms", () => {
	const decision = buildImportantEmailForwardDecision({
		email: {
			from: "mailer@example.com",
			subject: "Action required",
		},
		normalized: {
			provider: "agoda",
			suppressForwarding: true,
			communicationClassification: {
				reason: "agoda_guest_message",
				suppressForwarding: true,
			},
		},
		reconciliation: { status: "failed" },
	});

	assert.equal(decision.shouldForward, false);
	assert.equal(decision.suppressed, true);
	assert.equal(decision.reason, "agoda_guest_message");
});

test("orchestrator terminates known guest messages before invoking AI", async () => {
	const result = await orchestrateInboundReservationEmail({
		from: '"HotelRunner" <noreply@hotelrunner.com>',
		subject: "You have a message!",
		text: [
			"A guest sent you a direct message",
			"Write a reply",
			"https://zad-ajyad.hotelrunner.com/admin/grm/conversations?conversation_id=5855801",
		].join("\n"),
	});

	assert.equal(result.normalized.intent, "not_reservation");
	assert.equal(result.normalized.terminalNonReservation, true);
	assert.equal(result.normalized.suppressForwarding, true);
	assert.equal(result.decision.usedAI, false);
	assert.equal(result.decision.skipped, true);
	assert.equal(result.decision.skipReason, "hotelrunner_guest_message");
});
