// ai-agent/controller.js
const { client, DEFAULT_MODEL } = require("./openai");
const { buildSystemPrompt } = require("./prompt");
const SupportCase = require("../models/supportcase");
const HotelDetails = require("../models/hotel_details");
const {
	inferLanguage,
	looksIncomplete,
	countQuestions,
	isAffirmativeBooking,
	splitForTwoMessages,
} = require("./utils");

/** minimal local tool set: we rely on index.js for richer flows; keep this slim */
const toolSchemas = []; // no external tools here; this controller keeps a plain answer
const resolvers = {};

async function callModel({
	hotel,
	caseId,
	activeLanguage,
	personaName,
	messages,
}) {
	const response = await client.responses.create({
		model: DEFAULT_MODEL,
		input: [
			{
				role: "system",
				content: buildSystemPrompt({ hotel, activeLanguage, personaName }),
			},
			...messages,
		],
		tools: toolSchemas,
		tool_choice: "auto",
	});
	return response;
}
function renderAssistantText(resp) {
	const final = resp?.output_text || "";
	return final.trim();
}

// Persist inbound message
async function persistInbound({ caseId, fromUser }) {
	await SupportCase.findByIdAndUpdate(caseId, {
		$push: {
			conversation: {
				messageBy: {
					customerName: fromUser.name || "Guest",
					customerEmail: fromUser.email || "guest@example.com",
					userId: fromUser.userId || "guest",
				},
				message: fromUser.text,
				inquiryAbout: fromUser.inquiryAbout || "general",
				inquiryDetails: fromUser.inquiryDetails || "",
				seenByAdmin: false,
				seenByHotel: false,
				seenByCustomer: true,
			},
		},
	});
}
// Persist assistant reply
async function persistAssistant({ caseId, personaName, text }) {
	await SupportCase.findByIdAndUpdate(caseId, {
		$push: {
			conversation: {
				messageBy: {
					customerName: `${personaName || "Reception"} (AI)`,
					customerEmail: "ai@jannatbooking.com",
					userId: "ai-agent",
				},
				message: text,
				inquiryAbout: "agent_reply",
				inquiryDetails: "",
				seenByAdmin: true,
				seenByHotel: true,
				seenByCustomer: false,
			},
		},
	});
}

async function handleMessage(io, socket, payload) {
	try {
		const {
			caseId,
			preferredLanguage = "en",
			text,
			user = { name: "Guest", email: "guest@example.com", userId: "guest" },
			hotelId,
			context = {},
		} = payload;

		if (!caseId || !text) return;

		const supportCase = await SupportCase.findById(caseId)
			.populate("hotelId")
			.lean();
		const hotel = hotelId
			? await HotelDetails.findById(hotelId).lean()
			: supportCase?.hotelId || null;
		if (!hotel || hotel.aiToRespond === false) {
			io.to(caseId).emit("aiPaused", { caseId });
			return;
		}

		const activeLanguage = inferLanguage(text, preferredLanguage);
		io.to(caseId).emit("typing", { by: "ai", caseId });
		await persistInbound({
			caseId,
			fromUser: { ...user, text, inquiryAbout: context.intent || "general" },
		});

		// wait briefly if message seems incomplete
		if (looksIncomplete(text)) await new Promise((r) => setTimeout(r, 1500));

		const recent = (supportCase?.conversation || []).slice(-12).map((m) => ({
			role: m?.messageBy?.userId === "ai-agent" ? "assistant" : "user",
			content: m.message,
		}));
		const messages = [...recent, { role: "user", content: text }];

		const resp = await callModel({
			hotel,
			caseId,
			activeLanguage,
			personaName: null,
			messages,
		});
		const answer = renderAssistantText(resp) || "…";

		const chunks = splitForTwoMessages(
			answer,
			countQuestions(text) >= 2 || answer.length > 900,
			900
		);

		// gate check again
		const freshHotel = await HotelDetails.findById(hotel._id).lean();
		if (!freshHotel || freshHotel.aiToRespond === false) {
			io.to(caseId).emit("aiPaused", { caseId });
			return;
		}

		// send chunk 1
		await persistAssistant({
			caseId,
			personaName: "Reception",
			text: chunks[0],
		});
		io.to(caseId).emit("receiveMessage", {
			_id: caseId,
			caseStatus: supportCase?.caseStatus || "open",
			openedBy: supportCase?.openedBy,
			hotelId: hotel?._id || null,
			conversation: [],
			aiMessage: chunks[0],
			language: activeLanguage,
		});

		// send chunk 2 if exists
		if (chunks[1]) {
			await new Promise((r) => setTimeout(r, 700));
			await persistAssistant({
				caseId,
				personaName: "Reception",
				text: chunks[1],
			});
			io.to(caseId).emit("receiveMessage", {
				_id: caseId,
				caseStatus: supportCase?.caseStatus || "open",
				openedBy: supportCase?.openedBy,
				hotelId: hotel?._id || null,
				conversation: [],
				aiMessage: chunks[1],
				language: activeLanguage,
			});
		}

		io.to(caseId).emit("stopTyping", { by: "ai", caseId });
	} catch (err) {
		console.error("[AI] handleMessage error:", err);
		io.to(payload.caseId).emit("stopTyping", {
			by: "ai",
			caseId: payload.caseId,
		});
	}
}

module.exports = { handleMessage };
