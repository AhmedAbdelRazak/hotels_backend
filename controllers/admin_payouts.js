/** ********************************************************************
 * controllers/admin_payouts.js — Platform Admin Payouts/Commissions
 * Scope: whole platform (optional filter by hotel), since 2025‑06‑01 (createdAt).
 * Uses simple top‑level tracking fields inside Reservations documents.
 ********************************************************************* */

"use strict";

const mongoose = require("mongoose");
const HotelDetails = require("../models/hotel_details");
const Reservations = require("../models/reservations");

const SINCE_UTC = new Date("2025-06-01T00:00:00.000Z");

/* ───────── Helpers ───────── */
function normalizeStatus(s) {
	const t = String(s || "")
		.toLowerCase()
		.replace(/[-_\s]+/g, " ")
		.trim();
	if (t.includes("early") && t.includes("checked") && t.includes("out"))
		return "early_checked_out";
	if (t.includes("checked") && t.includes("out")) return "checked_out";
	if (t.includes("inhouse") || t === "in house" || t === "in-house")
		return "inhouse";
	return t;
}
function statusIncluded(s) {
	const n = normalizeStatus(s);
	return n === "checked_out" || n === "early_checked_out" || n === "inhouse";
}
function computeCommissionFromPickedRooms(pickedRoomsType = []) {
	if (!Array.isArray(pickedRoomsType) || pickedRoomsType.length === 0) return 0;
	return pickedRoomsType.reduce((total, room) => {
		const count = Number(room?.count || 1) || 0;
		const days = Array.isArray(room?.pricingByDay) ? room.pricingByDay : [];
		if (!days.length) return total;
		const diff = days.reduce(
			(acc, d) => acc + (Number(d?.price || 0) - Number(d?.rootPrice || 0)),
			0
		);
		return total + diff * count;
	}, 0);
}
function summarizePayment(r) {
	const pd = r?.paypal_details || {};
	const pmt = String(r?.payment || "").toLowerCase();
	const offline =
		Number(r?.payment_details?.onsite_paid_amount || 0) > 0 ||
		pmt === "paid offline";
	const legacyCaptured = !!r?.payment_details?.captured;
	const capTotal = Number(pd?.captured_total_usd || 0);
	const initialCompleted =
		(pd?.initial?.capture_status || "").toUpperCase() === "COMPLETED";
	const anyMitCompleted =
		Array.isArray(pd?.mit) &&
		pd.mit.some((c) => (c?.capture_status || "").toUpperCase() === "COMPLETED");
	const isCaptured =
		legacyCaptured ||
		capTotal > 0 ||
		initialCompleted ||
		anyMitCompleted ||
		pmt === "paid online";
	const isNotPaid =
		!isCaptured &&
		!offline &&
		(pmt === "not paid" || Number(r?.paid_amount || 0) === 0);

	let status = "Not Captured";
	if (isCaptured) status = "Captured";
	else if (offline) status = "Paid Offline";
	else if (isNotPaid) status = "Not Paid";

	const channel = isCaptured
		? "online"
		: offline || isNotPaid
		? "offline"
		: "none";
	return { status, channel };
}
function isCommissionPaid(r) {
	if (r?.commissionPaid === true) return true;
	return /commission\s*paid/i.test(String(r?.commissionStatus || ""));
}
const n2 = (v) => Number(Number(v || 0).toFixed(2));

/** Collect helper for summaries: returns gross, commission, and net */
const collect = (arr) => {
	const totalSAR = arr.reduce((a, x) => a + Number(x?.total_amount || 0), 0);
	const commissionSAR = arr.reduce(
		(a, x) => a + Number(x?.computed_commission_sar || 0),
		0
	);
	const netSAR = totalSAR - commissionSAR;
	return {
		count: arr.length,
		totalSAR,
		commissionSAR,
		netSAR,
	};
};

/* ───────── Admin actor + grouped log ───────── */
function getAdminActor(req) {
	const u = req.user || req.auth || {};
	const b = req.body || {};
	const h = req.headers || {};
	const id = u?._id || b?.adminId || h["x-admin-id"] || undefined;
	const name = u?.name || b?.adminName || h["x-admin-name"] || undefined;
	const role = u?.role || b?.adminRole || h["x-admin-role"] || "admin";
	return { _id: id, name, role };
}
const chg = (field, from, to) => ({ field, from, to });
function groupedLog(field, changes, note, by) {
	return {
		at: new Date(),
		by: {
			_id: by?._id || null,
			name: by?.name || null,
			role: by?.role || "admin",
		},
		field, // "commission" | "transfer"
		changes: Array.isArray(changes) ? changes : [],
		note: note || null,
	};
}

/* ───────── GET /admin-payouts/commissions ───────── */
exports.listAdminPayouts = async (req, res) => {
	try {
		const {
			hotelId,
			paymentChannel = "all",
			commissionPaid = "0",
			transferStatus = "all",
			page = "1",
			pageSize = "50",
		} = req.query || {};

		const findBase = { createdAt: { $gte: SINCE_UTC } };
		if (hotelId) {
			if (!mongoose.Types.ObjectId.isValid(hotelId))
				return res.status(400).json({ message: "Invalid hotelId." });
			findBase.hotelId = hotelId;
		}

		// <<< CHANGED: richer projection so FE can render last note + dates >>>
		const raw = await Reservations.find(findBase, {
			hotelId: 1,
			confirmation_number: 1,
			customer_details: 1,
			payment: 1,
			payment_details: 1,
			paypal_details: 1,
			total_amount: 1,
			paid_amount: 1,
			pickedRoomsType: 1,
			reservation_status: 1,
			checkin_date: 1,
			checkout_date: 1,
			commission: 1,
			commissionPaid: 1,
			commissionStatus: 1,
			commissionPaidAt: 1,
			moneyTransferredToHotel: 1,
			moneyTransferredAt: 1, // <<< ADDED
			commissionData: 1, // <<< ADDED (for MIT auto-note)
			adminChangeLog: { $slice: -12 }, // <<< ADDED
			adminLastUpdatedAt: 1, // <<< ADDED
			adminLastUpdatedBy: 1, // <<< ADDED
			createdAt: 1,
			updatedAt: 1, // <<< ADDED
		}).lean();

		const included = raw.filter((r) => statusIncluded(r?.reservation_status));
		const hotelIdSet = new Set(included.map((r) => String(r.hotelId)));
		const hotels = await HotelDetails.find(
			{ _id: { $in: Array.from(hotelIdSet) } },
			{ _id: 1, hotelName: 1 }
		).lean();
		const hotelMap = new Map(
			hotels.map((h) => [String(h._id), h.hotelName || "—"])
		);

		const derived = included.map((r) => {
			const pay = summarizePayment(r);
			const stored = Number(r?.commission || 0);
			const comm =
				stored > 0
					? stored
					: computeCommissionFromPickedRooms(r?.pickedRoomsType || []);
			const commissionSAR = n2(comm);
			const payoutOnlineSAR = n2(Number(r?.total_amount || 0) - commissionSAR);
			return {
				...r,
				hotelName: hotelMap.get(String(r.hotelId)) || "—",
				computed_payment_status: pay.status,
				computed_payment_channel: pay.channel,
				computed_commission_sar: commissionSAR,
				computed_online_payout_sar: payoutOnlineSAR,
				commissionPaid: isCommissionPaid(r),
				eligibleForHotelTransfer: pay.channel === "online",
			};
		});

		const isOffline = (x) =>
			x.computed_payment_channel === "offline" ||
			x.computed_payment_channel === "none";
		const pendingOffline = derived.filter(
			(x) => isOffline(x) && !x.commissionPaid
		);
		const paidOffline = derived.filter((x) => isOffline(x) && x.commissionPaid);

		const onlineAll = derived.filter(
			(x) => x.computed_payment_channel === "online"
		);
		const onlineTransferred = onlineAll.filter(
			(x) => x.moneyTransferredToHotel === true
		);
		const onlineNotTransferred = onlineAll.filter(
			(x) => x.moneyTransferredToHotel !== true
		);

		const summary = {
			pending: {
				offline: collect(pendingOffline),
				online: collect(onlineNotTransferred),
				all: collect(derived.filter((x) => !x.commissionPaid)),
			},
			paid: {
				offline: collect(paidOffline),
				online: collect(onlineTransferred),
				all: collect(derived.filter((x) => x.commissionPaid)),
				transfers: {
					transferred: onlineTransferred.length,
					notTransferred: onlineNotTransferred.length,
				},
			},
		};

		let source = [];
		if (paymentChannel === "online") {
			if (transferStatus === "transferred") source = onlineTransferred;
			else if (transferStatus === "not_transferred")
				source = onlineNotTransferred;
			else source = onlineAll;
		} else {
			const wantPaid = commissionPaid === "1";
			source = wantPaid ? paidOffline : pendingOffline;
		}

		const pg = Math.max(1, parseInt(page, 10) || 1);
		const ps = Math.min(500, Math.max(1, parseInt(pageSize, 10) || 50));
		const total = source.length;
		const start = (pg - 1) * ps;
		const items = source.slice(start, start + ps);

		res.set("Cache-Control", "no-cache, no-store, must-revalidate");
		res.set("Pragma", "no-cache");
		res.set("Expires", "0");

		return res.json({
			hotelId: hotelId || null,
			since: SINCE_UTC.toISOString(),
			paymentChannel,
			commissionPaid:
				paymentChannel === "online"
					? undefined
					: commissionPaid === "1"
					? 1
					: 0,
			transferStatus: paymentChannel === "online" ? transferStatus : undefined,
			total,
			page: pg,
			pageSize: ps,
			reservations: items,
			summary,
		});
	} catch (e) {
		console.error("listAdminPayouts:", e);
		return res.status(500).json({ message: "Failed to list admin payouts." });
	}
};

/* ───────── GET /admin-payouts/overview ───────── (unchanged UI contract) */
exports.getAdminPayoutsOverview = async (req, res) => {
	try {
		const { hotelId } = req.query || {};
		const findBase = { createdAt: { $gte: SINCE_UTC } };
		if (hotelId) {
			if (!mongoose.Types.ObjectId.isValid(hotelId))
				return res.status(400).json({ message: "Invalid hotelId." });
			findBase.hotelId = hotelId;
		}

		const raw = await Reservations.find(findBase, {
			hotelId: 1,
			reservation_status: 1,
			total_amount: 1,
			paid_amount: 1,
			paypal_details: 1,
			payment: 1,
			payment_details: 1,
			pickedRoomsType: 1,
			commission: 1,
			commissionPaid: 1,
			commissionStatus: 1,
			moneyTransferredToHotel: 1,
			checkin_date: 1,
			checkout_date: 1,
			createdAt: 1,
		}).lean();

		const derived = raw
			.filter((r) => statusIncluded(r?.reservation_status))
			.map((r) => {
				const pay = summarizePayment(r);
				const stored = Number(r?.commission || 0);
				const commSar =
					stored > 0
						? stored
						: computeCommissionFromPickedRooms(r?.pickedRoomsType || []);
				return {
					...r,
					computed_payment_status: pay.status,
					computed_payment_channel: pay.channel,
					computed_commission_sar: n2(commSar),
					commissionPaid: isCommissionPaid(r),
					eligibleForHotelTransfer: pay.channel === "online",
				};
			});

		const sum = (arr, get) => arr.reduce((a, x) => a + Number(get(x) || 0), 0);
		const sumNet = (arr) =>
			arr.reduce(
				(a, r) =>
					a +
					(Number(r?.total_amount || 0) -
						Number(r?.computed_commission_sar || 0)),
				0
			);

		const commissionDueFromHotel = derived.filter(
			(r) =>
				(r.computed_payment_channel === "offline" ||
					r.computed_payment_channel === "none") &&
				!r.commissionPaid
		);
		const commissionPaidByHotel = derived.filter(
			(r) =>
				(r.computed_payment_channel === "offline" ||
					r.computed_payment_channel === "none") &&
				r.commissionPaid
		);
		const transfersDueToHotel = derived.filter(
			(r) => r.eligibleForHotelTransfer && r.moneyTransferredToHotel !== true
		);
		const transfersCompletedToHotel = derived.filter(
			(r) => r.eligibleForHotelTransfer && r.moneyTransferredToHotel === true
		);

		// Legacy-style sections (enriched with commission & net for online)
		const legacy = {
			commissionDueFromHotel: {
				count: commissionDueFromHotel.length,
				totalSAR: sum(commissionDueFromHotel, (r) => r.total_amount),
				commissionSAR: sum(
					commissionDueFromHotel,
					(r) => r.computed_commission_sar
				),
				netSAR: sumNet(commissionDueFromHotel),
			},
			commissionPaidByHotel: {
				count: commissionPaidByHotel.length,
				totalSAR: sum(commissionPaidByHotel, (r) => r.total_amount),
				commissionSAR: sum(
					commissionPaidByHotel,
					(r) => r.computed_commission_sar
				),
				netSAR: sumNet(commissionPaidByHotel),
			},
			transfersDueToHotel: {
				count: transfersDueToHotel.length,
				totalSAR: sum(transfersDueToHotel, (r) => r.total_amount),
				commissionSAR: sum(
					transfersDueToHotel,
					(r) => r.computed_commission_sar
				),
				netSAR: sumNet(transfersDueToHotel),
			},
			transfersCompletedToHotel: {
				count: transfersCompletedToHotel.length,
				totalSAR: sum(transfersCompletedToHotel, (r) => r.total_amount),
				commissionSAR: sum(
					transfersCompletedToHotel,
					(r) => r.computed_commission_sar
				),
				netSAR: sumNet(transfersCompletedToHotel),
			},
		};

		const pendingOnline = transfersDueToHotel;
		const paidOnline = transfersCompletedToHotel;
		const nested = {
			pending: {
				offline: legacy.commissionDueFromHotel,
				online: {
					count: pendingOnline.length,
					commissionSAR: sum(pendingOnline, (r) => r.computed_commission_sar),
					totalSAR: sum(pendingOnline, (r) => r.total_amount),
					netSAR: sumNet(pendingOnline),
				},
			},
			paid: {
				offline: legacy.commissionPaidByHotel,
				online: {
					count: paidOnline.length,
					commissionSAR: sum(paidOnline, (r) => r.computed_commission_sar),
					totalSAR: sum(paidOnline, (r) => r.total_amount),
					netSAR: sumNet(paidOnline),
				},
				transfers: {
					transferred: transfersCompletedToHotel.length,
					notTransferred: transfersDueToHotel.length,
				},
			},
		};

		const summary = { ...legacy, ...nested };

		res.set("Cache-Control", "no-cache, no-store, must-revalidate");
		res.set("Pragma", "no-cache");
		res.set("Expires", "0");
		return res.json({
			hotelId: hotelId || null,
			since: SINCE_UTC.toISOString(),
			summary,
		});
	} catch (e) {
		console.error("getAdminPayoutsOverview:", e);
		return res.status(500).json({ message: "Failed to build admin overview." });
	}
};

/* ───────── PATCH /admin-payouts/commission-status ───────── */
exports.updateCommissionStatus = async (req, res) => {
	try {
		const { reservationId, commissionPaid, note } = req.body || {};
		if (!mongoose.Types.ObjectId.isValid(reservationId))
			return res.status(400).json({ message: "Invalid reservationId." });
		if (typeof commissionPaid !== "boolean")
			return res.status(400).json({ message: "commissionPaid is required." });

		const by = getAdminActor(req);
		const r = await Reservations.findById(reservationId).lean();
		if (!r) return res.status(404).json({ message: "Reservation not found." });

		const prevPaid = !!r.commissionPaid;
		const nextPaid = !!commissionPaid;
		if (prevPaid === nextPaid) {
			return res.json({ ok: true, unchanged: true, reservationId });
		}

		const now = new Date();
		const nextStatus = nextPaid ? "commission paid" : "commission due";
		const nextPaidAt = nextPaid ? now : null;

		const changes = [
			chg("commissionPaid", prevPaid, nextPaid),
			chg("commissionStatus", r.commissionStatus || null, nextStatus),
			chg("commissionPaidAt", r.commissionPaidAt || null, nextPaidAt),
		];
		const logEntry = groupedLog("commission", changes, note, by);

		await Reservations.updateOne(
			{ _id: reservationId },
			{
				$set: {
					commissionPaid: nextPaid,
					commissionStatus: nextStatus,
					commissionPaidAt: nextPaidAt,
					adminLastUpdatedAt: now,
					adminLastUpdatedBy: {
						_id: by?._id,
						name: by?.name,
						role: by?.role || "admin",
					},
				},
				$push: { adminChangeLog: logEntry },
			}
		);

		return res.json({
			ok: true,
			reservationId,
			changes: {
				commissionPaid: nextPaid,
				commissionStatus: nextStatus,
				commissionPaidAt: nextPaidAt,
			},
		});
	} catch (e) {
		console.error("updateCommissionStatus:", e);
		return res
			.status(500)
			.json({ message: "Failed to update commission status." });
	}
};

/* ───────── PATCH /admin-payouts/transfer-status ───────── */
exports.updateTransferStatus = async (req, res) => {
	try {
		const { reservationId, moneyTransferredToHotel, note } = req.body || {};
		if (!mongoose.Types.ObjectId.isValid(reservationId))
			return res.status(400).json({ message: "Invalid reservationId." });
		if (typeof moneyTransferredToHotel !== "boolean")
			return res
				.status(400)
				.json({ message: "moneyTransferredToHotel is required." });

		const by = getAdminActor(req);
		const r = await Reservations.findById(reservationId).lean();
		if (!r) return res.status(404).json({ message: "Reservation not found." });

		const prevTr = !!r.moneyTransferredToHotel;
		const nextTr = !!moneyTransferredToHotel;
		if (prevTr === nextTr) {
			return res.json({ ok: true, unchanged: true, reservationId });
		}

		const now = new Date();
		const nextTrAt = nextTr ? now : null;

		const changes = [
			chg("moneyTransferredToHotel", prevTr, nextTr),
			chg("moneyTransferredAt", r.moneyTransferredAt || null, nextTrAt),
		];
		const logEntry = groupedLog("transfer", changes, note, by);

		await Reservations.updateOne(
			{ _id: reservationId },
			{
				$set: {
					moneyTransferredToHotel: nextTr,
					moneyTransferredAt: nextTrAt,
					adminLastUpdatedAt: now,
					adminLastUpdatedBy: {
						_id: by?._id,
						name: by?.name,
						role: by?.role || "admin",
					},
				},
				$push: { adminChangeLog: logEntry },
			}
		);

		return res.json({
			ok: true,
			reservationId,
			changes: {
				moneyTransferredToHotel: nextTr,
				moneyTransferredAt: nextTrAt,
			},
		});
	} catch (e) {
		console.error("updateTransferStatus:", e);
		return res
			.status(500)
			.json({ message: "Failed to update transfer status." });
	}
};

/* ───────── PATCH /admin-payouts/update-reservation ─────────
   Combined updater.
   Body: { reservationId, commissionPaid?: boolean, moneyTransferredToHotel?: boolean, note? }
*/
exports.updateReservationPayoutFlags = async (req, res) => {
	try {
		const { reservationId, commissionPaid, moneyTransferredToHotel, note } =
			req.body || {};
		if (!mongoose.Types.ObjectId.isValid(reservationId))
			return res.status(400).json({ message: "Invalid reservationId." });

		const by = getAdminActor(req);
		const r = await Reservations.findById(reservationId).lean();
		if (!r) return res.status(404).json({ message: "Reservation not found." });

		const now = new Date();
		const $set = {};
		const logs = [];

		// Commission toggle
		if (typeof commissionPaid === "boolean") {
			const prevPaid = !!r.commissionPaid;
			const nextPaid = !!commissionPaid;
			if (prevPaid !== nextPaid) {
				const nextStatus = nextPaid ? "commission paid" : "commission due";
				const nextPaidAt = nextPaid ? now : null;
				$set.commissionPaid = nextPaid;
				$set.commissionStatus = nextStatus;
				$set.commissionPaidAt = nextPaidAt;

				logs.push(
					groupedLog(
						"commission",
						[
							chg("commissionPaid", prevPaid, nextPaid),
							chg("commissionStatus", r.commissionStatus || null, nextStatus),
							chg("commissionPaidAt", r.commissionPaidAt || null, nextPaidAt),
						],
						note,
						by
					)
				);
			}
		}

		// Transfer toggle
		if (typeof moneyTransferredToHotel === "boolean") {
			const prevTr = !!r.moneyTransferredToHotel;
			const nextTr = !!moneyTransferredToHotel;
			if (prevTr !== nextTr) {
				const nextTrAt = nextTr ? now : null;
				$set.moneyTransferredToHotel = nextTr;
				$set.moneyTransferredAt = nextTrAt;

				logs.push(
					groupedLog(
						"transfer",
						[
							chg("moneyTransferredToHotel", prevTr, nextTr),
							chg("moneyTransferredAt", r.moneyTransferredAt || null, nextTrAt),
						],
						note,
						by
					)
				);
			}
		}

		if (logs.length === 0) {
			return res.json({ ok: true, unchanged: true, reservationId });
		}

		$set.adminLastUpdatedAt = now;
		$set.adminLastUpdatedBy = {
			_id: by?._id,
			name: by?.name,
			role: by?.role || "admin",
		};

		await Reservations.updateOne(
			{ _id: reservationId },
			{ $set, $push: { adminChangeLog: { $each: logs } } }
		);

		return res.json({ ok: true, reservationId });
	} catch (e) {
		console.error("updateReservationPayoutFlags:", e);
		return res.status(500).json({ message: "Failed to update reservation." });
	}
};

/* ───────── GET /admin-payouts/hotels-lite ───────── */
exports.listHotelsLite = async (req, res) => {
	try {
		const hotels = await HotelDetails.find({}, { _id: 1, hotelName: 1 })
			.sort({ hotelName: 1 })
			.limit(2000)
			.lean();
		return res.json({
			count: hotels.length,
			hotels: hotels.map((h) => ({
				_id: String(h._id),
				hotelName: h.hotelName || "—",
			})),
		});
	} catch (e) {
		console.error("listHotelsLite:", e);
		return res.status(500).json({ message: "Failed to list hotels." });
	}
};
