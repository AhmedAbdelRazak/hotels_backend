/** @format */
const express = require("express");
const { ensureAIAllowed } = require("./core/policy");
const {
	getSupportCaseById,
	getHotelById,
	getReservationByConfirmation,
} = require("./core/db");
const { getOrCreateCaseState, clearCase } = require("./core/state");
const {
	listAvailableRoomsForStay,
	priceRoomForStay,
} = require("./core/selectors");
const { pushReservationLinks } = require("./core/actions");

/**
 * GET /api/aiagent/health
 * GET /api/aiagent/state/:caseId
 * POST /api/aiagent/clear/:caseId
 * GET /api/aiagent/preview-quote?caseId&checkin&checkout&roomType&displayName
 * GET /api/aiagent/reservation-by-confirmation/:cn
 * POST /api/aiagent/send-links/:caseId   {reservationId, confirmation}
 * POST /api/aiagent/mock-create/:caseId
 */
function attachRoutes(app, io) {
	const router = express.Router();

	router.get("/health", async (_req, res) => {
		return res.json({
			ok: true,
			openai: !!process.env.OPENAI_API_KEY,
			model: process.env.OPENAI_MODEL || null,
		});
	});

	router.get("/state/:caseId", async (req, res) => {
		try {
			const caseId = req.params.caseId;
			const sc = await getSupportCaseById(caseId);
			if (!sc)
				return res.status(404).json({ ok: false, error: "case_not_found" });

			const state = getOrCreateCaseState(caseId);
			const { allowed, hotel } = await ensureAIAllowed(sc.hotelId);
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
			const { caseId, checkin, checkout, roomType, displayName } = req.query;
			if (!caseId || !checkin || !checkout || !roomType) {
				return res.status(400).json({ ok: false, error: "missing_params" });
			}
			const sc = await getSupportCaseById(caseId);
			if (!sc)
				return res.status(404).json({ ok: false, error: "case_not_found" });

			const hotel = await getHotelById(sc.hotelId);
			if (!hotel)
				return res.status(404).json({ ok: false, error: "hotel_not_found" });

			const rooms = listAvailableRoomsForStay(hotel, checkin, checkout);
			const chosen =
				rooms.find(
					(r) =>
						r.room?.roomType === roomType &&
						(displayName ? r.room?.displayName === displayName : true)
				) || rooms.find((r) => r.room?.roomType === roomType);

			if (!chosen)
				return res.json({
					ok: true,
					available: false,
					reason: "no_room_match",
				});
			if (chosen.blocked)
				return res.json({
					ok: true,
					available: false,
					reason: "blocked",
					date: chosen.blockedOn,
				});

			const quote = priceRoomForStay(hotel, chosen.room, checkin, checkout);
			const zero =
				Array.isArray(quote.perNight) &&
				quote.perNight.some((v) => !v || Number(v) <= 0);
			if (
				zero ||
				!quote.totalWithCommission ||
				Number(quote.totalWithCommission) <= 0
			) {
				return res.json({ ok: true, available: false, reason: "zero_price" });
			}

			return res.json({
				ok: true,
				available: true,
				nights: quote.nights,
				currency: (hotel.currency || "sar").toUpperCase(),
				room: {
					roomType: chosen.room.roomType,
					displayName: chosen.room.displayName || chosen.room.roomType,
				},
				perNight: quote.perNight,
				totalWithCommission: quote.totalWithCommission,
				totalRoot: quote.totalRoot,
				commission: quote.commission,
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
