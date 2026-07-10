/** @format */

const argv = process.argv.slice(2);

process.env.AI_SKIP_RESERVATION_CONFIRMATION_DISPATCH = "true";
process.env.SUPPORT_CASE_EMAIL_NOTIFICATIONS_ENABLED = "false";
process.env.AI_AGENT_WORKER_PROCESS = "true";
process.env.AI_PLAN_USE_WORKER = "false";
process.env.WHATSAPP_DRY_RUN = "true";
process.env.AI_AGENT_ENABLED = process.env.AI_AGENT_ENABLED || "true";

require("dotenv").config();

const mongoose = require("mongoose");
mongoose.set("strictQuery", false);

const SupportCase = require("../models/supportcase");
const Reservations = require("../models/reservations");
const Hotel = require("../models/hotel_details");
const orchestrator = require("../aiagent/core/orchestrator");

const SUPPORT_EMAIL = "support@jannatbooking.com";
const DEFAULT_AJYAD_ID = "6a40b6a1a6efe70450536038";
const QUIET_WAIT_MS = Number(process.env.AI_GUEST_REPLY_QUIET_MS || 3150);
const PUBLIC_WHATSAPP = "+1 (909) 222-3374";
const PUBLIC_WHATSAPP_LINK = "https://wa.me/19092223374";
const PAID_RECEPTION_PHONE = "+966541981804";

const args = Object.fromEntries(
	argv
		.filter((item) => item.startsWith("--") && item.includes("="))
		.map((item) => {
			const [key, ...rest] = item.slice(2).split("=");
			return [key, rest.join("=")];
		})
);

const marker =
	args.marker ||
	process.env.LIVE_EXISTING_RESERVATION_QA_MARKER ||
	`codex-existing-reservation-${Date.now()}`;
const keepData = argv.includes("--keep");
const confirmation =
	args.confirmation ||
	`89${String(Date.now()).slice(-8)}`;

const silentRoom = { emit() {} };
const silentIo = {
	__aiWorkerNoDirectEmit: true,
	to() {
		return silentRoom;
	},
	emit() {},
	on() {},
};

const runState = {
	caseIds: [],
	reservationIds: [],
};

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeDigits(value = "") {
	const arabicDigits = "\u0660\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668\u0669";
	const persianDigits = "\u06f0\u06f1\u06f2\u06f3\u06f4\u06f5\u06f6\u06f7\u06f8\u06f9";
	return String(value || "")
		.replace(/[\u0660-\u0669]/g, (digit) => String(arabicDigits.indexOf(digit)))
		.replace(/[\u06f0-\u06f9]/g, (digit) => String(persianDigits.indexOf(digit)))
		.replace(/[\u066b\u066c]/g, ".");
}

function cleanText(value = "") {
	return normalizeDigits(value).replace(/\s+/g, " ").trim();
}

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

function assertMatches(value = "", pattern, message = "") {
	assert(pattern.test(cleanText(value)), message || `Expected ${pattern} in ${value}`);
}

function assertNotMatches(value = "", pattern, message = "") {
	assert(!pattern.test(cleanText(value)), message || `Did not expect ${pattern} in ${value}`);
}

function latestAi(sc = {}) {
	const messages = (sc.conversation || []).filter((entry) => entry.isAi === true);
	return messages[messages.length - 1] || null;
}

async function loadAjyadHotel() {
	const byId = await Hotel.findById(DEFAULT_AJYAD_ID).lean();
	if (byId?._id) return byId;
	const byName = await Hotel.findOne({
		$or: [{ hotelName: /zad\s+a[jg]yad/i }, { hotelName_OtherLanguage: /\u0632\u0627\u062f\s*\u0623?\u062c\u064a\u0627\u062f|\u0627\u062c\u064a\u0627\u062f|\u0623\u062c\u064a\u0627\u062f/i }],
	}).lean();
	assert(byName?._id, "Could not load Zad Ajyad hotel");
	return byName;
}

async function createCase(hotel) {
	const doc = await SupportCase.create({
		createdAt: new Date(),
		updatedAt: new Date(),
		supporterName: "Jannat Booking QA",
		targetUserName: hotel.hotelName || "Zad Ajyad",
		targetUserRole: "hotel",
		caseStatus: "open",
		hotelId: hotel._id,
		openedBy: "client",
		preferredLanguage: "Arabic",
		preferredLanguageCode: "ar",
		supportScope: "hotel",
		sourceWebsite: "codex-existing-reservation-live-qa",
		sourcePage: marker,
		sourceUrl: `https://xhotelpro.com/codex-existing-reservation-live-qa/${marker}`,
		clientName: "Guest Service QA",
		clientContact: `${marker}@example.com`.toLowerCase(),
		clientContactType: "email",
		displayName1: "Guest Service QA",
		displayName2: hotel.hotelName || "Zad Ajyad",
		aiRelated: true,
		aiToRespond: true,
		aiResponderName: "\u0639\u0627\u0626\u0634\u0629",
		conversation: [
			{
				messageBy: {
					customerName: "Jannat Booking",
					customerEmail: SUPPORT_EMAIL,
					userId: "jannat-system",
				},
				message: `QA handoff for ${marker}.`,
				date: new Date(),
				inquiryAbout: marker,
				inquiryDetails: marker,
				seenByAdmin: true,
				seenByHotel: true,
				seenByCustomer: true,
				isSystem: true,
				clientTag: marker,
			},
		],
	});
	runState.caseIds.push(String(doc._id));
	return doc.toObject();
}

async function createPaidReservation(hotel) {
	await Reservations.deleteOne({ confirmation_number: confirmation });
	const reservation = await Reservations.create({
		confirmation_number: confirmation,
		reservation_id: `qa-${marker}`,
		booking_source: "jannatbooking_ssr",
		aiSupportCaseId: marker,
		aiReservationFingerprint: marker,
		hotelId: hotel._id,
		state: "confirmed",
		reservation_status: "confirmed",
		customer_details: {
			name: "Mohamed Gaber QA",
			phone: "0562621775",
			email: `${marker}@example.com`.toLowerCase(),
			nationality: "EG",
			aiSupportCaseId: marker,
		},
		total_guests: 2,
		adults: 2,
		children: 0,
		total_rooms: 1,
		pickedRoomsPricing: [
			{
				room_type: "Double Room",
				roomTypeKey: "doubleRooms",
				count: 1,
				chosenPrice: 525,
			},
		],
		pickedRoomsType: [
			{
				room_type: "Double Room",
				roomTypeKey: "doubleRooms",
				count: 1,
				chosenPrice: 525,
			},
		],
		checkin_date: new Date("2026-07-27T00:00:00.000Z"),
		checkout_date: new Date("2026-08-03T00:00:00.000Z"),
		days_of_residence: 7,
		total_amount: 525,
		sub_total: 525,
		currency: "SAR",
		payment: "paypal",
		financeStatus: "partially paid",
		paid_amount: 78.75,
		paid_amount_breakdown: {
			paid_online_via_link: 78.75,
			paid_at_hotel_cash: 0,
			paid_at_hotel_card: 0,
			paid_to_hotel: 0,
			paid_online_jannatbooking: 0,
			paid_online_other_platforms: 0,
			paid_online_via_instapay: 0,
			paid_no_show: 0,
			payment_comments: marker,
		},
		payment_details: {
			provider: "paypal",
			status: "completed",
			paypalReviewPending: false,
		},
		paypal_details: {
			status: "COMPLETED",
			pending_review_captures: [],
		},
		comment: marker,
		booking_comment: marker,
	});
	runState.reservationIds.push(String(reservation._id));
	return reservation.toObject();
}

async function appendGuest(caseId, message) {
	const entry = {
		messageBy: {
			customerName: "Guest Service QA",
			customerEmail: `${marker}@example.com`.toLowerCase(),
			userId: "",
		},
		message: String(message || ""),
		date: new Date(),
		inquiryAbout: marker,
		inquiryDetails: marker,
		seenByAdmin: false,
		seenByHotel: false,
		seenByCustomer: true,
		isAi: false,
		isSystem: false,
		clientTag: marker,
	};
	await SupportCase.findByIdAndUpdate(caseId, {
		$push: { conversation: entry },
		$set: {
			updatedAt: new Date(),
			aiToRespond: true,
			aiPausedAt: null,
			aiHandoffReason: "",
			caseStatus: "open",
		},
	});
	return entry;
}

async function sendTurn(caseId, message) {
	await appendGuest(caseId, message);
	await sleep(QUIET_WAIT_MS);
	const startedAt = Date.now();
	await orchestrator.__worker.planTurn(silentIo, caseId);
	const durationMs = Date.now() - startedAt;
	const sc = await SupportCase.findById(caseId).lean();
	const ai = latestAi(sc);
	assert(ai?.message, `No AI reply for case ${caseId}`);
	console.log(`TURN ${sc.conversation.filter((entry) => !entry.isAi && !entry.isSystem).length} action=${ai.clientAction || ""} durationMs=${durationMs}`);
	console.log(cleanText(ai.message).slice(0, 600));
	return { sc, ai, durationMs };
}

async function cleanup() {
	const caseIds = [...new Set(runState.caseIds)];
	const reservationIds = [...new Set(runState.reservationIds)];
	const markerRegex = new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
	const reservations = await Reservations.find({
		$or: [
			{ _id: { $in: reservationIds } },
			{ confirmation_number: confirmation },
			{ aiSupportCaseId: marker },
			{ aiReservationFingerprint: marker },
			{ comment: markerRegex },
			{ booking_comment: markerRegex },
			{ "customer_details.email": markerRegex },
		],
	}).select("_id").lean();
	if (reservations.length > 10) {
		throw new Error(`Refusing cleanup for ${marker}: matched ${reservations.length} reservations`);
	}
	if (reservations.length) await Reservations.deleteMany({ _id: { $in: reservations.map((row) => row._id) } });
	if (caseIds.length) await SupportCase.deleteMany({ _id: { $in: caseIds } });
	const remainingCases = caseIds.length ? await SupportCase.countDocuments({ _id: { $in: caseIds } }) : 0;
	const remainingReservations = await Reservations.countDocuments({ confirmation_number: confirmation });
	console.log(
		`CLEANUP marker=${marker} casesDeleted=${caseIds.length} reservationsDeleted=${reservations.length} remainingCases=${remainingCases} remainingReservations=${remainingReservations}`
	);
}

async function main() {
	const database = process.env.DATABASE || process.env.MONGO_URI || process.env.MONGODB_URI;
	if (!database) throw new Error("Missing DATABASE/MONGO connection string");
	if (!orchestrator.__worker?.planTurn) throw new Error("Missing orchestrator worker export");
	await mongoose.connect(database, { useNewUrlParser: true, useUnifiedTopology: true });

	const hotel = await loadAjyadHotel();
	await createPaidReservation(hotel);
	const sc = await createCase(hotel);
	const caseId = String(sc._id);

	console.log(`LIVE_EXISTING_RESERVATION_QA_START marker=${marker} confirmation=${confirmation}`);

	let result = await sendTurn(
		caseId,
		"\u0644\u0648 \u0633\u0645\u062d\u062a\u064a \u0627\u0646\u0627 \u062f\u0641\u0639\u062a \u0639\u0631\u0628\u0648\u0646 \u062d\u062c\u0632 \u062f\u062e\u0648\u0644 27/7 \u062e\u0631\u0648\u062c 3/8"
	);
	assertMatches(result.ai.message, /confirmation|name|dates|\u0631\u0642\u0645|\u062a\u0623\u0643\u064a\u062f|\u0627\u0633\u0645|\u062a\u0627\u0631\u064a\u062e/i, "first reply should ask for safe lookup details");
	assertNotMatches(result.ai.message, /nationality|adult|child|\u062c\u0646\u0633\u064a\u0629|\u0628\u0627\u0644\u063a|\u0637\u0641\u0644/i, "first reply must not ask normal booking fields");
	assertNotMatches(result.ai.message, /966541981804|0541981804/, "first reply leaked Saudi reception number");

	result = await sendTurn(caseId, confirmation);
	assertMatches(result.ai.message, new RegExp(confirmation), "lookup should mention confirmation");
	assertMatches(result.ai.message, /78\.75|78,75|\u0667\u0668/, "lookup should reassure confirmed paid deposit");
	assertMatches(result.ai.message, /446\.25|446,25|\u0664\u0664\u0666/, "lookup should mention remaining balance");
	assertNotMatches(result.ai.message, /pending|review|double|twice|duplicat|\u0645\u0639\u0644\u0642|\u0645\u0631\u0627\u062c\u0639\u0629|\u0645\u0631\u062a\u064a\u0646|\u0645\u0643\u0631\u0631/i, "no-pending lookup must not mention pending or double payment");
	assertNotMatches(result.ai.message, /client-payment|payment link|\u0631\u0627\u0628\u0637\s+\u0627\u0644\u062f\u0641\u0639/i, "lookup should not push payment link unless asked");
	assertNotMatches(result.ai.message, /966541981804|0541981804/, "lookup leaked Saudi reception number");

	result = await sendTurn(
		caseId,
		"\u0643\u0627\u0645 \u0627\u0644\u0628\u0627\u0642\u064a \u0644\u0644\u062f\u0641\u0639 \u0628\u0627\u0644\u0641\u0646\u062f\u0642"
	);
	assertMatches(result.ai.message, /446\.25|446,25|\u0664\u0664\u0666/, "remaining-balance turn should answer remaining amount");
	assertNotMatches(result.ai.message, /pending|review|double|twice|duplicat|\u0645\u0639\u0644\u0642|\u0645\u0631\u0627\u062c\u0639\u0629|\u0645\u0631\u062a\u064a\u0646|\u0645\u0643\u0631\u0631/i, "remaining-balance turn must not mention pending/double");

	result = await sendTurn(
		caseId,
		"\u0631\u0642\u0645 \u062c\u0648\u0627\u0644 \u0644\u0644\u062a\u0648\u0627\u0635\u0644 \u0639\u0646\u062f \u0627\u0644\u0648\u0635\u0648\u0644 \u0648\u0644\u0648 \u0633\u0645\u062d\u062a\u064a \u0645\u0648\u0642\u0641 \u0627\u0644\u0628\u0627\u0635\u0627\u062a \u0641\u064a \u0645\u0643\u0629"
	);
	assert(result.ai.message.includes(PUBLIC_WHATSAPP), "contact turn should give public 909 number first");
	assert(result.ai.message.includes(PUBLIC_WHATSAPP_LINK), "contact turn should include WhatsApp link");
	assertMatches(result.ai.message, /bus|transport|shuttle|martyrs|shuhada|\u0628\u0627\u0635|\u0645\u0648\u0642\u0641|\u0627\u0644\u0634\u0647\u062f\u0627\u0621/i, "contact+bus turn should answer bus fact");
	assertNotMatches(result.ai.message, /966541981804|0541981804/, "contact turn must not give Saudi reception first");

	result = await sendTurn(
		caseId,
		"\u0644\u0627\u060c \u0645\u062d\u062a\u0627\u062c \u0631\u0642\u0645 \u0627\u0644\u0631\u064a\u0633\u064a\u0628\u0634\u0646 \u0627\u0644\u0633\u0639\u0648\u062f\u064a \u0636\u0631\u0648\u0631\u064a"
	);
	assertMatches(result.ai.message, /966541981804|0541981804/, "paid guest who insists after 909 should get Saudi reception number");
	assertNotMatches(result.ai.message, /3001|8955\d{6}|525/, "paid reception reply should stay contact-only");

	console.log(`LIVE_EXISTING_RESERVATION_QA_PASS marker=${marker} confirmation=${confirmation}`);
}

main()
	.catch((error) => {
		console.error(`LIVE_EXISTING_RESERVATION_QA_FAIL marker=${marker}`, error?.stack || error);
		process.exitCode = 1;
	})
	.finally(async () => {
		try {
			if (!keepData) await cleanup();
			else console.log(`CLEANUP_SKIPPED marker=${marker}`);
		} catch (error) {
			console.error(`LIVE_EXISTING_RESERVATION_QA_CLEANUP_FAIL marker=${marker}`, error?.stack || error);
			process.exitCode = 1;
		}
		try {
			await mongoose.disconnect();
		} catch {
			// Let process exit release the connection.
		}
	});
