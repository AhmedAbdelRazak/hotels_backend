/** ********************************************************************
 * controllers/paypal_owner.js  — Owner Commissions (Independent)
 * - Save hotel owner payment methods (PayPal vault: card/paypal/venmo)
 * - List pending/paid commissions (exact commission math = MoreDetails)
 * - Charge commissions via MIT (vault) -> mark paid ONLY if COMPLETED
 * - Case-insensitive status normalization (inhouse / in-house / in house)
 ********************************************************************* */

"use strict";

const paypal = require("@paypal/checkout-server-sdk");
const axios = require("axios");
const axiosRetryRaw = require("axios-retry");
const axiosRetry =
	axiosRetryRaw.default || axiosRetryRaw.axiosRetry || axiosRetryRaw;
const mongoose = require("mongoose");
const crypto = require("crypto");

const HotelDetails = require("../models/hotel_details");
const Reservations = require("../models/reservations");

/* ─────────── Env & PayPal client ─────────── */
const IS_PROD = /prod/i.test(process.env.NODE_ENV);
const clientId = IS_PROD
	? process.env.PAYPAL_CLIENT_ID_LIVE
	: process.env.PAYPAL_CLIENT_ID_SANDBOX;
const secretKey = IS_PROD
	? process.env.PAYPAL_SECRET_KEY_LIVE
	: process.env.PAYPAL_SECRET_KEY_SANDBOX;

if (!clientId || !secretKey) {
	console.warn("[PayPal][Owner] Missing CLIENT_ID/SECRET; routes will fail.");
}

const env = IS_PROD
	? new paypal.core.LiveEnvironment(clientId, secretKey)
	: new paypal.core.SandboxEnvironment(clientId, secretKey);
const ppClient = new paypal.core.PayPalHttpClient(env);

const PPM = IS_PROD
	? "https://api-m.paypal.com"
	: "https://api-m.sandbox.paypal.com";

const ax = axios.create({ timeout: 12000 });
axiosRetry(ax, {
	retries: 2,
	retryDelay: (c) => 300 * 2 ** c,
	retryCondition: (err) => {
		const m = String(err?.config?.method || "").toUpperCase();
		return (
			["GET", "HEAD", "OPTIONS"].includes(m) && axiosRetry.isRetryableError(err)
		);
	},
});

const idSig = (s) => {
	try {
		return crypto
			.createHash("sha256")
			.update(String(s))
			.digest("hex")
			.slice(0, 8);
	} catch {
		return "na";
	}
};

/* ───────── Small helpers ───────── */
function getOwnerActor(req) {
	const u = req.user || req.auth || {};
	const b = req.body || {};
	const h = req.headers || {};
	const id = u?._id || b?.ownerId || h["x-owner-id"] || undefined;
	const name = u?.name || b?.ownerName || h["x-owner-name"] || undefined;
	const role = u?.role || b?.ownerRole || h["x-owner-role"] || "owner"; // will show in logs
	return { _id: id, name, role };
}

// grouped log entry (one log object that contains all related field changes)
function chg(field, from, to) {
	return { field, from, to };
}
function groupedLog(field, changes, note, by) {
	return {
		at: new Date(),
		by: {
			_id: by?._id || null,
			name: by?.name || null,
			role: by?.role || "owner",
		},
		field, // "commission" | "transfer" (we only write "commission" here)
		changes: Array.isArray(changes) ? changes : [],
		note: note || null,
	};
}

/* ───────── PayPal vault helpers (owner) ───────── */
async function exchangeSetupToVaultToken(setupTokenId) {
	try {
		const { data } = await ax.post(
			`${PPM}/v3/vault/payment-tokens`,
			{
				payment_source: {
					token: { id: String(setupTokenId), type: "SETUP_TOKEN" },
				},
			},
			{ auth: { username: clientId, password: secretKey } }
		);
		return data;
	} catch (e) {
		const legacy =
			e?.response?.status === 400 &&
			Array.isArray(e?.response?.data?.details) &&
			e.response.data.details.some((d) =>
				/MISSING_REQUIRED_PARAMETER/i.test(String(d?.issue || ""))
			);
		if (!legacy) throw e;

		const { data } = await ax.post(
			`${PPM}/v3/vault/payment-tokens`,
			{ setup_token_id: String(setupTokenId) },
			{ auth: { username: clientId, password: secretKey } }
		);
		return data;
	}
}

/* ───────── Script client token (owner vault UIs) ───────── */
exports.generateClientToken = async (req, res) => {
	try {
		const dbg = String(req.query?.dbg || "") === "1";
		const { data, headers } = await ax.post(
			`${PPM}/v1/identity/generate-token`,
			{},
			{ auth: { username: clientId, password: secretKey } }
		);
		return res.json({
			clientToken: data.client_token,
			env: IS_PROD ? "live" : "sandbox",
			cached: false,
			diag: dbg
				? {
						isProd: IS_PROD,
						clientIdSig: idSig(clientId),
						debugId: headers?.["paypal-debug-id"] || null,
				  }
				: undefined,
		});
	} catch (e) {
		console.error("[Owner] client-token:", e?.response?.data || e);
		return res
			.status(503)
			.json({ error: "PayPal temporarily unreachable. Try again." });
	}
};

/* ───────── Create setup-token for vaulting (card/paypal/venmo) ───────── */
exports.createSetupToken = async (req, res) => {
	try {
		const src = String(req.body?.payment_source || "card").toLowerCase();
		let payment_source;
		if (src === "card")
			payment_source = {
				card: { attributes: { verification: { method: "SCA_WHEN_REQUIRED" } } },
			};
		else if (src === "paypal") payment_source = { paypal: {} };
		else if (src === "venmo") payment_source = { venmo: {} };
		else
			return res.status(400).json({ message: "Unsupported payment_source." });

		const { data } = await ax.post(
			`${PPM}/v3/vault/setup-tokens`,
			{ payment_source },
			{ auth: { username: clientId, password: secretKey } }
		);
		return res.status(200).json({ id: data?.id });
	} catch (e) {
		console.error("[Owner] setup-token:", e?.response?.data || e);
		return res.status(500).json({ message: "Failed to create setup token" });
	}
};

/* ───────── Exchange setup_token -> vault & save on hotel ───────── */
exports.vaultExchangeAndSave = async (req, res) => {
	try {
		const { hotelId, setup_token, label, setDefault } = req.body || {};
		if (!hotelId || !mongoose.Types.ObjectId.isValid(hotelId)) {
			return res.status(400).json({ message: "Invalid hotelId." });
		}
		if (!setup_token)
			return res.status(400).json({ message: "setup_token is required." });

		const hotel = await HotelDetails.findById(hotelId);
		if (!hotel) return res.status(404).json({ message: "Hotel not found." });

		const tokenData = await exchangeSetupToVaultToken(setup_token);
		const ps = tokenData?.payment_source || {};
		const normalized = {
			label: "",
			vault_id: tokenData.id,
			vault_status: tokenData.status || "ACTIVE",
			vaulted_at: new Date(tokenData.create_time || Date.now()),
			method_type: "CARD",
			card_brand: null,
			card_last4: null,
			card_exp: null,
			billing_address: undefined,
			paypal_email: null,
			paypal_payer_id: null,
			venmo_username: null,
			venmo_user_id: null,
			default: !!setDefault,
			active: true,
			delete: false,
		};

		if (ps.card) {
			normalized.method_type = "CARD";
			normalized.card_brand = ps.card.brand || null;
			normalized.card_last4 = ps.card.last_digits || null;
			normalized.card_exp = ps.card.expiry || null;
			if (ps.card.billing_address)
				normalized.billing_address = ps.card.billing_address;
			normalized.label =
				label ||
				`${(ps.card.brand || "CARD").toUpperCase()} •••• ${
					ps.card.last_digits || "****"
				}`;
		} else if (ps.paypal) {
			normalized.method_type = "PAYPAL";
			const email = ps.paypal.email || ps.paypal.email_address || null;
			const payerId = ps.paypal.account_id || ps.paypal.payer_id || null;
			normalized.paypal_email = email;
			normalized.paypal_payer_id = payerId;
			normalized.label = label || `PayPal${email ? ` • ${email}` : ""}`;
		} else if (ps.venmo) {
			normalized.method_type = "VENMO";
			normalized.venmo_username =
				ps.venmo.username || ps.venmo.user_name || null;
			normalized.venmo_user_id =
				ps.venmo.account_id || ps.venmo.payer_id || ps.venmo.id || null;
			normalized.label =
				label ||
				`Venmo${
					normalized.venmo_username ? ` • @${normalized.venmo_username}` : ""
				}`;
		}

		// upsert into hotel.ownerPaymentMethods
		const arr = Array.isArray(hotel.ownerPaymentMethods)
			? hotel.ownerPaymentMethods
			: [];
		if (setDefault) arr.forEach((m) => (m.default = false));
		const existingIdx = arr.findIndex(
			(m) => String(m.vault_id) === String(normalized.vault_id)
		);
		if (existingIdx >= 0) {
			const cur = arr[existingIdx];
			Object.assign(cur, normalized, {
				default: !!setDefault || cur.default,
				active: true,
				delete: false,
			});
		} else {
			arr.push(normalized);
		}
		hotel.ownerPaymentMethods = arr;

		const saved = await hotel.save();
		return res.status(201).json({
			message: "Owner payment method saved.",
			ownerPaymentMethods: saved.ownerPaymentMethods,
		});
	} catch (e) {
		console.error("vaultExchangeAndSave:", e?.response?.data || e);
		return res.status(500).json({ message: "Failed to save owner method." });
	}
};

/* ───────── List / default / activate / deactivate / delete ───────── */
exports.listPaymentMethods = async (req, res) => {
	try {
		const { hotelId } = req.params;
		if (!hotelId || !mongoose.Types.ObjectId.isValid(hotelId))
			return res.status(400).json({ message: "Invalid hotelId." });
		const hotel = await HotelDetails.findById(hotelId).lean();
		if (!hotel) return res.status(404).json({ message: "Hotel not found." });
		const methods = (hotel.ownerPaymentMethods || []).filter(
			(m) => m?.delete !== true
		);
		return res.json({
			hotelId,
			count: methods.length,
			ownerPaymentMethods: methods,
		});
	} catch (e) {
		console.error("listPaymentMethods:", e);
		return res.status(500).json({ message: "Failed to list owner methods." });
	}
};

exports.setDefaultMethod = async (req, res) => {
	try {
		const { hotelId, methodId, vault_id } = req.body || {};
		if (!hotelId || !mongoose.Types.ObjectId.isValid(hotelId))
			return res.status(400).json({ message: "Invalid hotelId." });
		const hotel = await HotelDetails.findById(hotelId);
		if (!hotel) return res.status(404).json({ message: "Hotel not found." });

		const arr = Array.isArray(hotel.ownerPaymentMethods)
			? hotel.ownerPaymentMethods
			: [];
		arr.forEach((m) => (m.default = false));

		let ok = false;
		for (const m of arr) {
			if (
				(methodId && String(m._id) === String(methodId)) ||
				(vault_id && String(m.vault_id) === String(vault_id))
			) {
				m.default = true;
				m.active = true;
				m.delete = false;
				ok = true;
				break;
			}
		}
		if (!ok) return res.status(404).json({ message: "Method not found." });

		hotel.ownerPaymentMethods = arr;
		const saved = await hotel.save();
		return res.json({
			message: "Default set.",
			ownerPaymentMethods: saved.ownerPaymentMethods,
		});
	} catch (e) {
		console.error("setDefaultMethod:", e);
		return res.status(500).json({ message: "Failed to set default." });
	}
};

exports.activateMethod = async (req, res) => {
	try {
		const { hotelId, methodId } = req.body || {};
		if (!hotelId || !mongoose.Types.ObjectId.isValid(hotelId))
			return res.status(400).json({ message: "Invalid hotelId." });
		const hotel = await HotelDetails.findById(hotelId);
		if (!hotel) return res.status(404).json({ message: "Hotel not found." });

		const arr = hotel.ownerPaymentMethods || [];
		const idx = arr.findIndex((m) => String(m._id) === String(methodId));
		if (idx < 0) return res.status(404).json({ message: "Method not found." });
		arr[idx].active = true;
		arr[idx].delete = false;
		hotel.ownerPaymentMethods = arr;
		const saved = await hotel.save();
		return res.json({
			message: "Activated.",
			ownerPaymentMethods: saved.ownerPaymentMethods,
		});
	} catch (e) {
		console.error("activateMethod:", e);
		return res.status(500).json({ message: "Failed to activate method." });
	}
};

exports.deactivateMethod = async (req, res) => {
	try {
		const { hotelId, methodId } = req.body || {};
		if (!hotelId || !mongoose.Types.ObjectId.isValid(hotelId))
			return res.status(400).json({ message: "Invalid hotelId." });
		const hotel = await HotelDetails.findById(hotelId);
		if (!hotel) return res.status(404).json({ message: "Hotel not found." });

		const arr = hotel.ownerPaymentMethods || [];
		const idx = arr.findIndex((m) => String(m._id) === String(methodId));
		if (idx < 0) return res.status(404).json({ message: "Method not found." });
		arr[idx].active = false;
		if (arr[idx].default) arr[idx].default = false;
		hotel.ownerPaymentMethods = arr;
		const saved = await hotel.save();
		return res.json({
			message: "Deactivated.",
			ownerPaymentMethods: saved.ownerPaymentMethods,
		});
	} catch (e) {
		console.error("deactivateMethod:", e);
		return res.status(500).json({ message: "Failed to deactivate method." });
	}
};

exports.deleteMethod = async (req, res) => {
	try {
		const { hotelId, methodId } = req.body || {};
		if (!hotelId || !mongoose.Types.ObjectId.isValid(hotelId))
			return res.status(400).json({ message: "Invalid hotelId." });
		const hotel = await HotelDetails.findById(hotelId);
		if (!hotel) return res.status(404).json({ message: "Hotel not found." });

		const arr = hotel.ownerPaymentMethods || [];
		const idx = arr.findIndex((m) => String(m._id) === String(methodId));
		if (idx < 0) return res.status(404).json({ message: "Method not found." });
		arr[idx].delete = true;
		arr[idx].active = false;
		if (arr[idx].default) arr[idx].default = false;

		hotel.ownerPaymentMethods = arr;
		const saved = await hotel.save();
		return res.json({
			message: "Deleted (hidden).",
			ownerPaymentMethods: saved.ownerPaymentMethods,
		});
	} catch (e) {
		console.error("deleteMethod:", e);
		return res.status(500).json({ message: "Failed to delete method." });
	}
};

/* ───────── Finance helpers ───────── */
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
// alias to fix earlier call-sites
const statusMatchesIncluded = statusIncluded;

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

	// hotel collected cash/pos
	const onsiteSar = Number(r?.payment_details?.onsite_paid_amount || 0);
	const offline = onsiteSar > 0 || pmt === "paid offline";

	// any signal of online capture
	const legacyCaptured = !!r?.payment_details?.captured;
	const breakdown = r?.paid_amount_breakdown || {};
	const breakdownCaptured = Object.keys(breakdown).some((key) => {
		if (key === "payment_comments") return false;
		return Number(breakdown[key]) > 0;
	});
	const capTotal = Number(pd?.captured_total_usd || 0);
	const initialCompleted =
		(pd?.initial?.capture_status || "").toUpperCase() === "COMPLETED";
	const anyMitCompleted =
		Array.isArray(pd?.mit) &&
		pd.mit.some((c) => (c?.capture_status || "").toUpperCase() === "COMPLETED");
	const paidOnlineKeyword = pmt === "paid online";

	const isCaptured =
		legacyCaptured ||
		breakdownCaptured ||
		capTotal > 0 ||
		initialCompleted ||
		anyMitCompleted ||
		paidOnlineKeyword;

	// Explicit "not paid" → for commission we treat this as "hotel side" (offline-like)
	const isNotPaid =
		!isCaptured &&
		!offline &&
		(pmt === "not paid" || Number(r?.paid_amount || 0) === 0);

	let status = "Not Captured";
	if (isCaptured) status = "Captured";
	else if (offline) status = "Paid Offline";
	else if (isNotPaid) status = "Not Paid";

	// *** Key change: NOT PAID is bucketed with OFFLINE for commissions ***
	const channel = isCaptured
		? "online"
		: offline || isNotPaid
		? "offline"
		: "none";

	return { status, channel };
}

function isCommissionPaid(r) {
	if (r?.commissionPaid === true) return true;
	const cs = String(r?.commissionStatus || "");
	return /commission\s*paid/i.test(cs);
}

/* ───────── Commissions listing (for tables/tiles) ───────── */
exports.listHotelCommissions = async (req, res) => {
	try {
		const {
			hotelId,
			commissionPaid = "0",
			paymentChannel = "all",
			page = "1",
			pageSize = "50",
			transferStatus = "all", // NEW: for paymentChannel=online (transferred | not_transferred | all)
		} = req.query || {};

		if (!hotelId || !mongoose.Types.ObjectId.isValid(hotelId)) {
			return res.status(400).json({ message: "Invalid hotelId." });
		}

		// <<< CHANGED: richer projection so UI can show notes/last updated & USD >>>
		const raw = await Reservations.find(
			{ hotelId },
			{
				confirmation_number: 1,
				customer_details: 1,
				payment: 1,
				payment_details: 1,
				paid_amount_breakdown: 1,
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
				commissionData: 1, // <<< ADDED (for USD + manual note)
				adminChangeLog: { $slice: -12 }, // <<< ADDED (latest log items only)
				adminLastUpdatedAt: 1, // <<< ADDED
				adminLastUpdatedBy: 1, // <<< ADDED
				createdAt: 1,
				updatedAt: 1, // <<< ADDED
			}
		).lean();

		const derived = raw
			.filter((r) => statusIncluded(r?.reservation_status))
			.map((r) => {
				const pay = summarizePayment(r);
				const stored = Number(r?.commission || 0);
				const comm =
					Number.isFinite(stored) && stored > 0
						? stored
						: computeCommissionFromPickedRooms(r?.pickedRoomsType || []);
				const commissionSAR = Number(Number(comm).toFixed(2));
				const payoutOnlineSAR = Number(
					Number(Number(r?.total_amount || 0) - commissionSAR).toFixed(2)
				);

				return {
					...r,
					computed_payment_status: pay.status, // "Captured" | "Paid Offline" | "Not Paid"
					computed_payment_channel: pay.channel, // "online" | "offline" | "none"
					computed_commission_sar: commissionSAR,
					computed_online_payout_sar: payoutOnlineSAR, // total - commission (for online lists)
					commissionPaid: isCommissionPaid(r),
					eligibleForHotelTransfer: pay.channel === "online", // **no dependency on paid_amount**
				};
			});

		// ---- Buckets -------------------------------------------------------
		const offlinePredicate = (r) =>
			r.computed_payment_channel === "offline" ||
			r.computed_payment_channel === "none";

		const pendingOffline = derived.filter(
			(r) => offlinePredicate(r) && !r.commissionPaid
		);
		const paidOffline = derived.filter(
			(r) => offlinePredicate(r) && r.commissionPaid
		);

		const onlineAll = derived.filter(
			(r) => r.computed_payment_channel === "online"
		);
		const onlineTransferred = onlineAll.filter(
			(r) => r.moneyTransferredToHotel === true
		);
		const onlineNotTransferred = onlineAll.filter(
			(r) => r.moneyTransferredToHotel !== true
		);

		// ---- Summary helpers -----------------------------------------------
		const collect = (arr) => ({
			count: arr.length,
			totalSAR: arr.reduce((a, x) => a + Number(x?.total_amount || 0), 0),
			commissionSAR: arr.reduce(
				(a, x) => a + Number(x?.computed_commission_sar || 0),
				0
			),
		});

		const summary = {
			pending: {
				offline: collect(pendingOffline),
				online: collect(onlineNotTransferred),
				all: collect(derived.filter((r) => !r.commissionPaid)),
			},
			paid: {
				offline: collect(paidOffline),
				online: collect(onlineTransferred),
				all: collect(derived.filter((r) => r.commissionPaid)),
				transfers: {
					transferred: onlineTransferred.length,
					notTransferred: onlineNotTransferred.length,
				},
			},
		};

		// ---- Output list (supports both OFFLINE and ONLINE modes) ----------
		const pg = Math.max(1, parseInt(page, 10) || 1);
		const ps = Math.min(500, Math.max(1, parseInt(pageSize, 10) || 50));
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

		const total = source.length;
		const start = (pg - 1) * ps;
		const items = source.slice(start, start + ps);

		res.set("Cache-Control", "no-cache, no-store, must-revalidate");
		res.set("Pragma", "no-cache");
		res.set("Expires", "0");

		return res.json({
			hotelId,
			commissionPaid:
				paymentChannel === "online"
					? undefined
					: commissionPaid === "1"
					? 1
					: 0,
			paymentChannel,
			transferStatus: paymentChannel === "online" ? transferStatus : undefined,
			total,
			page: pg,
			pageSize: ps,
			reservations: items,
			summary,
		});
	} catch (e) {
		console.error("listHotelCommissions:", e);
		return res.status(500).json({ message: "Failed to list commissions." });
	}
};

/* ───────── Manual marking (for bank transfers) ───────── */
exports.markCommissionsPaid = async (req, res) => {
	try {
		const { hotelId, reservationIds, note } = req.body || {};
		if (!hotelId || !mongoose.Types.ObjectId.isValid(hotelId))
			return res.status(400).json({ message: "Invalid hotelId." });
		const ids = Array.isArray(reservationIds)
			? reservationIds.filter((x) => mongoose.Types.ObjectId.isValid(x))
			: [];
		if (!ids.length)
			return res.status(400).json({ message: "No reservations provided." });

		// <<< CHANGED: update *per reservation* so we can append a proper grouped log
		const by = getOwnerActor(req);
		const now = new Date();
		const docs = await Reservations.find(
			{ _id: { $in: ids }, hotelId },
			{
				commissionPaid: 1,
				commissionStatus: 1,
				commissionPaidAt: 1,
			}
		).lean();

		let updated = 0;
		for (const r of docs) {
			const changes = [
				chg("commissionPaid", !!r.commissionPaid, true),
				chg("commissionStatus", r.commissionStatus || null, "commission paid"),
				chg("commissionPaidAt", r.commissionPaidAt || null, now),
			];

			const logEntry = groupedLog("commission", changes, note || null, by);

			const resu = await Reservations.updateOne(
				{ _id: r._id, hotelId },
				{
					$set: {
						commissionPaid: true,
						commissionStatus: "commission paid",
						commissionPaidAt: now,
						"commissionData.manual": {
							by: "manual-mark",
							note: note || null,
							at: now,
						},
						adminLastUpdatedAt: now, // so UI has a stable fallback date
						adminLastUpdatedBy: {
							_id: by?._id || null,
							name: by?.name || null,
							role: by?.role || "owner",
						},
					},
					$push: { adminChangeLog: logEntry },
				}
			);
			if (resu?.modifiedCount || resu?.nModified) updated += 1;
		}

		return res.json({ ok: true, matched: docs.length, modified: updated });
	} catch (e) {
		console.error("markCommissionsPaid:", e);
		return res.status(500).json({ message: "Failed to mark commission paid." });
	}
};

/* ─────────────────  PAY: charge offline commissions (USD, MIT via vault) ─────────────────
   POST /paypal-owner/commissions/charge
   Body: { hotelId: string, reservationIds: string[], sarToUsdRate?: number }
*/
exports.chargeOwnerCommissions = async (req, res) => {
	try {
		const { hotelId, reservationIds, sarToUsdRate } = req.body || {};

		if (!hotelId || !mongoose.Types.ObjectId.isValid(hotelId)) {
			return res.status(400).json({ message: "Invalid hotelId." });
		}
		const ids = Array.isArray(reservationIds)
			? reservationIds.filter((x) => mongoose.Types.ObjectId.isValid(x))
			: [];
		if (!ids.length) {
			return res.status(400).json({ message: "No reservations provided." });
		}

		const hotel = await HotelDetails.findById(hotelId).lean();
		if (!hotel) return res.status(404).json({ message: "Hotel not found." });

		// pick a valid owner method (default -> first active)
		const methods = Array.isArray(hotel.ownerPaymentMethods)
			? hotel.ownerPaymentMethods.filter(
					(m) => m?.delete !== true && m?.active !== false
			  )
			: [];
		const payMethod = methods.find((m) => m.default) || methods[0];
		if (!payMethod || !payMethod.vault_id) {
			return res
				.status(400)
				.json({ message: "No active owner payment method." });
		}

		// Fetch candidates
		const raw = await Reservations.find(
			{ _id: { $in: ids }, hotelId },
			{
				confirmation_number: 1,
				customer_details: 1,
				reservation_status: 1,
				pickedRoomsType: 1,
				payment: 1,
				payment_details: 1,
				paid_amount_breakdown: 1,
				paypal_details: 1,
				commissionPaid: 1,
				commissionStatus: 1,
				commissionPaidAt: 1, // <<< ADDED (for accurate 'from' in changes)
				total_amount: 1,
				paid_amount: 1,
				createdAt: 1,
			}
		).lean();

		const rawMap = new Map(raw.map((d) => [String(d._id), d])); // <<< ADDED

		const deriv = raw
			.filter((r) => statusIncluded(r?.reservation_status))
			.map((r) => {
				const comm = computeCommissionFromPickedRooms(r?.pickedRoomsType || []);
				const pay = summarizePayment(r);
				return {
					...r,
					commissionSAR: Math.max(0, Number(comm.toFixed(2))),
					channel: pay.channel,
					alreadyPaid: isCommissionPaid(r),
				};
			});

		const targets = deriv.filter(
			(r) =>
				(r.channel === "offline" || r.channel === "none") &&
				!r.alreadyPaid &&
				r.commissionSAR > 0
		);
		if (!targets.length) {
			return res
				.status(400)
				.json({ message: "No eligible offline commissions." });
		}

		// ---------- Conversion & rounding (cent-accurate) ----------
		const rate = Number(sarToUsdRate) > 0 ? Number(sarToUsdRate) : 0; // USD per SAR
		if (!rate)
			return res.status(400).json({ message: "Missing sarToUsdRate." });

		const toCents = (n) => Math.round(Number(n) * 100);
		const fromCents = (c) => (Number(c) / 100).toFixed(2);

		const rawCents = targets.map((t) => toCents(t.commissionSAR * rate));
		let sumCents = rawCents.reduce((a, x) => a + x, 0);
		for (let i = 0; i < rawCents.length; i++) {
			if (rawCents[i] === 0) {
				rawCents[i] = 1; // ensure at least 1¢
				sumCents += 1;
			}
		}

		const items = targets.map((t, idx) => ({
			name: `Commission • ${(
				t.confirmation_number || String(t._id).slice(-6)
			).toString()}`.slice(0, 127),
			quantity: "1",
			sku: String(t._id),
			category: "DIGITAL_GOODS",
			unit_amount: { currency_code: "USD", value: fromCents(rawCents[idx]) },
		}));
		const itemTotal = fromCents(sumCents);

		// ---------- Create order ----------
		const reqId = `comm-${Date.now()}-${Math.random()
			.toString(36)
			.slice(2, 8)}`;
		const createPayload = {
			intent: "CAPTURE",
			purchase_units: [
				{
					reference_id: "commission",
					description: `Commission batch (${targets.length} reservations)`,
					invoice_id: `COM-${String(hotelId).slice(-6)}-${Date.now()}`,
					custom_id: `hotel:${hotelId}`,
					amount: {
						currency_code: "USD",
						value: itemTotal,
						breakdown: {
							item_total: { currency_code: "USD", value: itemTotal },
						},
					},
					items,
				},
			],
			payment_source: {
				token: { id: String(payMethod.vault_id), type: "PAYMENT_METHOD_TOKEN" },
			},
			application_context: {
				shipping_preference: "NO_SHIPPING",
				user_action: "PAY_NOW",
			},
		};

		const created = await ax.post(`${PPM}/v2/checkout/orders`, createPayload, {
			auth: { username: clientId, password: secretKey },
			headers: {
				"Content-Type": "application/json",
				"PayPal-Request-Id": reqId,
				Prefer: "return=representation",
			},
		});

		const orderId = created?.data?.id;
		if (!orderId) {
			console.error("[Owner][charge] create failed:", created?.data);
			return res
				.status(502)
				.json({ message: "Failed to create PayPal order." });
		}

		// Helpers to detect/return a capture object
		const pickCapture = (orderObj) =>
			orderObj?.purchase_units?.[0]?.payments?.captures?.[0] || null;
		const fetchOrder = async (id) => {
			const { data } = await ax.get(`${PPM}/v2/checkout/orders/${id}`, {
				auth: { username: clientId, password: secretKey },
			});
			return data || {};
		};

		// ---- 1) Sometimes create already returns COMPLETED with a capture
		let capObj = null;
		let orderSnapshot = created?.data || {};
		if (String(orderSnapshot?.status || "").toUpperCase() === "COMPLETED") {
			capObj = pickCapture(orderSnapshot);
		}

		// ---- 2) Try confirm (safe). Then re-fetch to check if capture happened.
		if (!capObj) {
			try {
				await ax.post(
					`${PPM}/v2/checkout/orders/${orderId}/confirm`,
					{
						payment_source: {
							token: {
								id: String(payMethod.vault_id),
								type: "PAYMENT_METHOD_TOKEN",
							},
						},
					},
					{ auth: { username: clientId, password: secretKey } }
				);
			} catch (e) {
				if (e?.response?.status && e.response.status >= 500) throw e; // only bubble 5xx
			}
			try {
				orderSnapshot = await fetchOrder(orderId);
				if (String(orderSnapshot?.status || "").toUpperCase() === "COMPLETED") {
					capObj = pickCapture(orderSnapshot);
				}
			} catch {
				/* ignore */
			}
		}

		// ---- 3) If still not captured, call capture (idempotent), tolerate ORDER_ALREADY_CAPTURED
		if (!capObj) {
			try {
				const capRes = await ax.post(
					`${PPM}/v2/checkout/orders/${orderId}/capture`,
					{},
					{
						auth: { username: clientId, password: secretKey },
						headers: {
							Prefer: "return=representation",
							"PayPal-Request-Id": `cap-${reqId}`,
						},
					}
				);
				const capData = capRes?.data || {};
				capObj = pickCapture(capData) || {
					id: capData?.id,
					status: capData?.status,
				};
			} catch (e) {
				const already =
					Array.isArray(e?.response?.data?.details) &&
					e.response.data.details.some(
						(d) => d?.issue === "ORDER_ALREADY_CAPTURED"
					);
				if (already) {
					// Pull the capture from the order and proceed as success
					const ord = await fetchOrder(orderId);
					capObj = pickCapture(ord) || {
						id: orderId,
						status: ord?.status || "COMPLETED",
					};
				} else {
					throw e;
				}
			}
		}

		const capStatus = String(capObj?.status || "").toUpperCase();
		const settled = capStatus === "COMPLETED";
		if (!settled) {
			return res.status(502).json({
				message: "Payment not settled",
				capture: { id: capObj?.id || orderId, status: capStatus || "UNKNOWN" },
			});
		}

		// ---------- DB updates per reservation ----------
		const now = new Date();
		const by = getOwnerActor(req); // <<< ADDED
		const batchKey = `COMMBATCH-${orderId}`;
		const totalSar = targets.reduce(
			(a, t) => a + Number(t.commissionSAR || 0),
			0
		);
		const usdPerItem = rawCents.map(fromCents).map(Number);
		const totalUsd = Number(fromCents(sumCents));

		for (let i = 0; i < targets.length; i++) {
			const t = targets[i];
			const prev = rawMap.get(String(t._id)) || {};
			const changes = [
				chg("commissionPaid", !!prev.commissionPaid, true),
				chg(
					"commissionStatus",
					prev.commissionStatus || null,
					"commission paid"
				),
				chg("commissionPaidAt", prev.commissionPaidAt || null, now),
			];

			const entry = {
				batchKey,
				hotelId,
				at: now,
				method: {
					type: payMethod.method_type || "CARD",
					label: payMethod.label || "",
					vault_id: payMethod.vault_id,
					vault_status: payMethod.vault_status || "",
				},
				sar: {
					amountForReservation: Number(Number(t.commissionSAR).toFixed(2)),
					totalForBatch: Number(totalSar.toFixed(2)),
					currency: "SAR",
				},
				usd: {
					amountForReservation: Number(Number(usdPerItem[i]).toFixed(2)),
					totalForBatch: Number(totalUsd.toFixed(2)),
					rateSarToUsd: Number(Number(rate).toFixed(6)),
					currency: "USD",
				},
				paypal: {
					orderId,
					captureId: capObj?.id || null,
					status: capStatus || "COMPLETED",
				},
			};

			// Human-friendly default note so UI has something meaningful
			const autoNote = `Paid via ${payMethod.method_type || "CARD"} • ${
				payMethod.label || ""
			} • batch ${batchKey}`.trim();

			await Reservations.updateOne(
				{ _id: t._id, hotelId },
				{
					$set: {
						commissionPaid: true,
						commissionStatus: "commission paid",
						commissionPaidAt: now,
						"commissionData.last": entry,
						adminLastUpdatedAt: now,
						adminLastUpdatedBy: {
							_id: by?._id || null,
							name: by?.name || null,
							role: by?.role || "owner",
						},
					},
					$push: {
						"commissionData.history": entry,
						adminChangeLog: groupedLog("commission", changes, autoNote, by), // <<< ADDED
					},
				}
			);
		}

		return res.json({
			ok: true,
			capture: { id: capObj?.id || orderId, status: capStatus },
			batch: {
				key: batchKey,
				count: targets.length,
				totalSar: Number(totalSar.toFixed(2)),
				totalUsd: Number(totalUsd.toFixed(2)),
			},
			reservationsUpdated: targets.map((t) => t._id),
		});
	} catch (e) {
		const msg = e?.response?.data?.message || e?.message || "Charge failed";
		console.error("chargeHotelCommissions:", e?.response?.data || e);
		return res.status(500).json({ message: msg });
	}
};

/* ───────── Overview (totals for tiles) ───────── */
exports.getHotelFinanceOverview = async (req, res) => {
	try {
		const { hotelId } = req.query || {};
		if (!hotelId || !mongoose.Types.ObjectId.isValid(hotelId))
			return res.status(400).json({ message: "Invalid hotelId." });

		const raw = await Reservations.find(
			{ hotelId },
			{
				confirmation_number: 1,
				customer_details: 1,
				reservation_status: 1,
				total_amount: 1,
				paid_amount: 1,
				paypal_details: 1,
				payment: 1,
				payment_details: 1,
				paid_amount_breakdown: 1,
				pickedRoomsType: 1,
				commission: 1,
				commissionPaid: 1,
				commissionStatus: 1,
				moneyTransferredToHotel: 1,
				checkin_date: 1,
				checkout_date: 1,
				createdAt: 1,
			}
		).lean();

		const derived = raw
			.filter((r) => statusIncluded(r?.reservation_status))
			.map((r) => {
				const pay = summarizePayment(r);
				const stored = Number(r?.commission || 0);
				const commSar =
					Number.isFinite(stored) && stored > 0
						? stored
						: computeCommissionFromPickedRooms(r?.pickedRoomsType || []);
				return {
					...r,
					computed_payment_status: pay.status,
					computed_payment_channel: pay.channel,
					computed_commission_sar: Number(Number(commSar).toFixed(2)),
					commissionPaid: isCommissionPaid(r),
					// **Important change:** "eligible" = any ONLINE capture/keyword
					eligibleForHotelTransfer: pay.channel === "online",
				};
			});

		const sum = (arr, get) => arr.reduce((a, x) => a + Number(get(x) || 0), 0);

		// OFFLINE bucket (same fields; unchanged)
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

		// ONLINE transfers
		const transfersDueToHotel = derived.filter(
			(r) => r.eligibleForHotelTransfer && r.moneyTransferredToHotel !== true
		);
		const transfersCompletedToHotel = derived.filter(
			(r) => r.eligibleForHotelTransfer && r.moneyTransferredToHotel === true
		);

		const summary = {
			commissionDueFromHotel: {
				count: commissionDueFromHotel.length,
				totalSAR: sum(commissionDueFromHotel, (r) => r.total_amount),
				commissionSAR: sum(
					commissionDueFromHotel,
					(r) => r.computed_commission_sar
				),
			},
			commissionPaidByHotel: {
				count: commissionPaidByHotel.length,
				totalSAR: sum(commissionPaidByHotel, (r) => r.total_amount),
				commissionSAR: sum(
					commissionPaidByHotel,
					(r) => r.computed_commission_sar
				),
			},
			transfersDueToHotel: {
				count: transfersDueToHotel.length,
				totalSAR: sum(transfersDueToHotel, (r) => r.total_amount), // Gross
				commissionSAR: sum(
					transfersDueToHotel,
					(r) => r.computed_commission_sar
				),
				netSAR: transfersDueToHotel.reduce(
					(a, r) =>
						a +
						(Number(r?.total_amount || 0) -
							Number(r?.computed_commission_sar || 0)),
					0
				),
			},
			transfersCompletedToHotel: {
				count: transfersCompletedToHotel.length,
				totalSAR: sum(transfersCompletedToHotel, (r) => r.total_amount), // Gross
				commissionSAR: sum(
					transfersCompletedToHotel,
					(r) => r.computed_commission_sar
				),
				netSAR: transfersCompletedToHotel.reduce(
					(a, r) =>
						a +
						(Number(r?.total_amount || 0) -
							Number(r?.computed_commission_sar || 0)),
					0
				),
			},
		};

		res.set("Cache-Control", "no-cache, no-store, must-revalidate");
		res.set("Pragma", "no-cache");
		res.set("Expires", "0");
		return res.json({ hotelId, summary });
	} catch (e) {
		console.error("getHotelFinanceOverview:", e);
		return res.status(500).json({ message: "Failed to build overview." });
	}
};
