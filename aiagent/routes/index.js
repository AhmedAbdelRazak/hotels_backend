/** @format */
const express = require("express");
const { ensureAIAllowed } = require("../core/policy");
const {
	getSupportCaseById,
	getHotelByIdWithPricingDates,
	getReservationByConfirmation,
} = require("../core/db");
const { getOrCreateCaseState, clearCase } = require("../core/state");
const {
	listAvailableRoomsForStay,
	priceRoomForStay,
	canonicalRoomTypeKey,
	eachDate,
	roomSellableInventory,
} = require("../core/selectors");
const {
	pickChatbotOpenAIModel,
	pickChatbotReasoningEffort,
} = require("../../services/openaiModelConfig");
const { getChatbotOpenAIRuntimeConfig } = require("../core/openai");

/**
 * GET /api/aiagent/health
 * GET /api/aiagent/state/:caseId
 * POST /api/aiagent/clear/:caseId
	 * GET /api/aiagent/preview-quote?caseId&checkin=YYYY-MM-DD&checkout=YYYY-MM-DD&roomType=doubleRooms&displayName=optional&roomId=optional&rooms=1
 * GET /api/aiagent/reservation-by-confirmation/:cn
 */
function attachRoutes(app, io) {
	const router = express.Router();

	router.get("/health", async (_req, res) => {
		const runtime = getChatbotOpenAIRuntimeConfig();
		return res.json({
			ok: true,
			openai: !!process.env.OPENAI_API_KEY,
			model: pickChatbotOpenAIModel("default"),
			reasoningModel: pickChatbotOpenAIModel("reasoning"),
			analysisModel: pickChatbotOpenAIModel("analysis"),
			nluModel: pickChatbotOpenAIModel("nlu"),
			writerModel: pickChatbotOpenAIModel("writer"),
			reasoningEffort: pickChatbotReasoningEffort("reasoning"),
			writerReasoningEffort: pickChatbotReasoningEffort("writer"),
			nluReasoningEffort: pickChatbotReasoningEffort("nlu"),
			analysisReasoningEffort: pickChatbotReasoningEffort("analysis"),
			responsesEnabled: runtime.responsesEnabled,
			responseContinuationEnabled: runtime.responseContinuationEnabled,
			retrieval: runtime.fileSearch,
			outputTokens: runtime.outputTokens,
		});
	});

	router.get("/state/:caseId", async (req, res) => {
		try {
			const caseId = req.params.caseId;
			const sc = await getSupportCaseById(caseId);
			if (!sc)
				return res.status(404).json({ ok: false, error: "case_not_found" });

			const state = getOrCreateCaseState(caseId);
			const { allowed, hotel } = await ensureAIAllowed(sc.hotelId, sc);
			const convo = Array.isArray(sc.conversation)
				? sc.conversation.slice(-20)
				: [];

			return res.json({
				ok: true,
				aiAllowed: allowed,
				hotel: hotel
					? {
							_id: hotel._id,
							name: hotel.hotelName,
							aiToRespond: hotel.aiToRespond,
					  }
					: null,
				case: {
					_id: sc._id,
					hotelId: sc.hotelId,
					inquiryAbout: sc.inquiryAbout,
					customerName: sc.displayName1 || sc.customerName,
					preferredLanguage: sc.preferredLanguage,
					preferredLanguageCode: sc.preferredLanguageCode,
				},
				state, // in-memory AI state for this case
				conversation: convo,
			});
		} catch (e) {
			console.error("[aiagent] debug state error:", e?.message || e);
			res.status(500).json({ ok: false, error: "server_error" });
		}
	});

	router.post("/clear/:caseId", async (req, res) => {
		try {
			clearCase(req.params.caseId);
			res.json({ ok: true });
		} catch (e) {
			res.status(500).json({ ok: false });
		}
	});

	router.get("/preview-quote", async (req, res) => {
		try {
			const { caseId, checkin, checkout, roomType, displayName, roomId } = req.query;
			if (!caseId || !checkin || !checkout || (!roomType && !roomId)) {
				return res.status(400).json({ ok: false, error: "missing_params" });
			}
			const dates = eachDate(checkin, checkout);
			if (!dates.length) {
				return res.status(400).json({ ok: false, error: "bad_dates" });
			}
			const requestedRooms = Math.max(
				1,
				Math.floor(Number(req.query.rooms || 1) || 1)
			);
			const sc = await getSupportCaseById(caseId);
			if (!sc)
				return res.status(404).json({ ok: false, error: "case_not_found" });

			const hotel = await getHotelByIdWithPricingDates(sc.hotelId, dates);
			if (!hotel)
				return res.status(404).json({ ok: false, error: "hotel_not_found" });

			const rooms = listAvailableRoomsForStay(hotel, checkin, checkout);
			const roomIdText = String(roomId || "").trim();
			const requestedType = String(roomType || "").trim();
			const chosen =
				(roomIdText
					? rooms.find((r) => String(r.room?._id || "") === roomIdText)
					: null) ||
				rooms.find(
					(r) =>
						(!requestedType || canonicalRoomTypeKey(r.room) === requestedType) &&
						(displayName ? r.room?.displayName === displayName : true)
				) ||
				rooms.find(
					(r) => !requestedType || canonicalRoomTypeKey(r.room) === requestedType
				);

			if (!chosen)
				return res.json({
					ok: true,
					available: false,
					reason: "no_room_match",
				});
			if (chosen.available === false) {
				return res.json({
					ok: true,
					available: false,
					reason: chosen.reason || "not_available",
					date: chosen.blockedOn,
				});
			}
			const physicalRooms = roomSellableInventory(chosen.room);
			if (requestedRooms > physicalRooms) {
				return res.json({
					ok: true,
					available: false,
					reason: "physical_inventory_exceeded",
					requestedRooms,
					physicalRooms,
				});
			}

			const quote = priceRoomForStay(hotel, chosen.room, checkin, checkout);
			if (!quote.available) {
				return res.json({
					ok: true,
					available: false,
					reason: quote.reason || "not_available",
					date: quote.firstBlockedDate || undefined,
				});
			}
			const unitTotal = Number(quote.totals?.totalPriceWithCommission || 0);
			const unitRoot = Number(quote.totals?.hotelShouldGet || 0);
			const unitCommission = Number(quote.totals?.totalCommission || 0);
			return res.json({
				ok: true,
				available: true,
				nights: quote.nights,
				currency: (hotel.currency || "sar").toUpperCase(),
				room: {
					roomId: String(chosen.room._id || ""),
					roomType: canonicalRoomTypeKey(chosen.room),
					sourcePmsRoomType: chosen.room.roomType,
					displayName: chosen.room.displayName || chosen.room.roomType,
					physicalRooms,
				},
				rooms: requestedRooms,
				perNight: quote.perNight,
				unitTotalWithCommission: Number(unitTotal.toFixed(2)),
				totalWithCommission: Number((unitTotal * requestedRooms).toFixed(2)),
				totalRoot: Number((unitRoot * requestedRooms).toFixed(2)),
				commission: Number((unitCommission * requestedRooms).toFixed(2)),
			});
		} catch (e) {
			console.error("[aiagent] preview-quote error:", e?.message || e);
			res.status(500).json({ ok: false, error: "server_error" });
		}
	});

	router.get("/reservation-by-confirmation/:cn", async (req, res) => {
		try {
			const cn = String(req.params.cn || "").trim();
			if (!cn)
				return res
					.status(400)
					.json({ ok: false, error: "missing_confirmation" });
			const r = await getReservationByConfirmation(cn);
			if (!r) return res.status(404).json({ ok: false, error: "not_found" });
			res.json({ ok: true, reservation: r });
		} catch (e) {
			res.status(500).json({ ok: false, error: "server_error" });
		}
	});

	app.use("/api/aiagent", router);
}

module.exports = { attachRoutes };
