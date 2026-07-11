/** @format */
const express = require("express");
const { ensureAIAllowed } = require("./core/policy");
const {
	getSupportCaseById,
	getHotelByIdWithPricingDates,
	getReservationByConfirmation,
} = require("./core/db");
const { getOrCreateCaseState, clearCase } = require("./core/state");
const {
	listAvailableRoomsForStay,
	priceRoomForStay,
	canonicalRoomTypeKey,
	eachDate,
	roomSellableInventory,
} = require("./core/selectors");
const { pushReservationLinks } = require("./core/actions");
const {
	pickChatbotOpenAIModel,
	pickChatbotReasoningEffort,
} = require("../services/openaiModelConfig");
const { getChatbotOpenAIRuntimeConfig } = require("./core/openai");

/**
 * GET /api/aiagent/health
 * GET /api/aiagent/state/:caseId
 * POST /api/aiagent/clear/:caseId
	 * GET /api/aiagent/preview-quote?caseId&checkin&checkout&roomType&displayName&roomId&rooms
 * GET /api/aiagent/reservation-by-confirmation/:cn
 * POST /api/aiagent/send-links/:caseId   {reservationId, confirmation}
 * POST /api/aiagent/mock-create/:caseId
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
				state,
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
			if (chosen.reason === "blocked")
				return res.json({
					ok: true,
					available: false,
					reason: "blocked",
					date: chosen.blockedOn,
				});
			if (chosen.available === false)
				return res.json({
					ok: true,
					available: false,
					reason: chosen.reason || "not_available",
				});
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
			const unitTotal =
				quote.totals?.totalPriceWithCommission || quote.totalWithCommission || 0;
			const unitRoot = quote.totals?.hotelShouldGet || quote.totalRoot || 0;
			const unitCommission =
				quote.totals?.totalCommission || quote.commission || 0;
			const totalWithCommission = Number((unitTotal * requestedRooms).toFixed(2));
			const totalRoot = Number((unitRoot * requestedRooms).toFixed(2));
			const commission = Number((unitCommission * requestedRooms).toFixed(2));
			const zero =
				Array.isArray(quote.perNight) &&
				quote.perNight.some((v) => !v || Number(v) <= 0);
			if (
				zero ||
				!totalWithCommission ||
				Number(totalWithCommission) <= 0
			) {
				return res.json({ ok: true, available: false, reason: "zero_price" });
			}

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
				totalWithCommission,
				totalRoot,
				commission,
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

	// DEBUG: send your own ids to deliver the two links
	router.post("/send-links/:caseId", async (req, res) => {
		try {
			const { reservationId, confirmation } = req.body || {};
			if (!reservationId || !confirmation)
				return res.status(400).json({ ok: false, error: "missing_params" });
			const caseId = req.params.caseId;
			const sc = await getSupportCaseById(caseId);
			if (!sc)
				return res.status(404).json({ ok: false, error: "case_not_found" });

			const st = getOrCreateCaseState(caseId);
			await pushReservationLinks(io, caseId, st, {
				reservationId,
				confirmation,
			});
			res.json({ ok: true });
		} catch (e) {
			console.error("[aiagent] send-links error:", e?.message || e);
			res.status(500).json({ ok: false, error: "server_error" });
		}
	});

	// DEBUG: fabricate ids then send links
	router.post("/mock-create/:caseId", async (req, res) => {
		try {
			const caseId = req.params.caseId;
			const sc = await getSupportCaseById(caseId);
			if (!sc)
				return res.status(404).json({ ok: false, error: "case_not_found" });
			const st = getOrCreateCaseState(caseId);

			const reservationId = `R${Date.now().toString(36)}`;
			const confirmation = `JB${Math.random()
				.toString(36)
				.slice(2, 8)
				.toUpperCase()}`;
			await pushReservationLinks(io, caseId, st, {
				reservationId,
				confirmation,
			});

			res.json({ ok: true, reservationId, confirmation });
		} catch (e) {
			console.error("[aiagent] mock-create error:", e?.message || e);
			res.status(500).json({ ok: false, error: "server_error" });
		}
	});

	app.use("/api/aiagent", router);
}

module.exports = { attachRoutes };
