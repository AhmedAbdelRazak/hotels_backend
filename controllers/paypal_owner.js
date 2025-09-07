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
	const capTotal = Number(pd?.captured_total_usd || 0);
	const initialCompleted =
		(pd?.initial?.capture_status || "").toUpperCase() === "COMPLETED";
	const anyMitCompleted =
		Array.isArray(pd?.mit) &&
		pd.mit.some((c) => (c?.capture_status || "").toUpperCase() === "COMPLETED");
	const paidOnlineKeyword = pmt === "paid online";

	const isCaptured =
		legacyCaptured ||
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
		} = req.query || {};

		if (!hotelId || !mongoose.Types.ObjectId.isValid(hotelId)) {
			return res.status(400).json({ message: "Invalid hotelId." });
		}

		const raw = await Reservations.find(
			{ hotelId },
			{
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
				createdAt: 1,
			}
		).lean();

		const derived = raw
			.filter((r) => statusIncluded(r?.reservation_status))
			.map((r) => {
				const pay = summarizePayment(r);
				// Prefer stored commission (SAR); fallback to recompute
				const stored = Number(r?.commission || 0);
				const comm =
					Number.isFinite(stored) && stored > 0
						? stored
						: computeCommissionFromPickedRooms(r?.pickedRoomsType || []);
				const eligTransfer =
					pay.channel === "online" &&
					Number(r?.paid_amount || 0) >= Number(r?.total_amount || 0);
				return {
					...r,
					computed_payment_status: pay.status,
					computed_payment_channel: pay.channel,
					computed_commission_sar: Number(Number(comm).toFixed(2)),
					commissionPaid: isCommissionPaid(r),
					eligibleForHotelTransfer: eligTransfer,
				};
			});

		const wantPaid = commissionPaid === "1";

		let filtered = derived.filter((r) => r.commissionPaid === wantPaid);
		if (paymentChannel === "online") {
			filtered = filtered.filter(
				(r) => r.computed_payment_channel === "online"
			);
		}
		if (paymentChannel === "offline") {
			// offline bucket includes "not paid" as offline-like for commissions
			filtered = filtered.filter(
				(r) =>
					r.computed_payment_channel === "offline" ||
					r.computed_payment_channel === "none" // legacy/edge, just in case
			);
		}

		const collect = (arr) => ({
			count: arr.length,
			totalSAR: arr.reduce((a, x) => a + Number(x?.total_amount || 0), 0),
			commissionSAR: arr.reduce(
				(a, x) => a + Number(x?.computed_commission_sar || 0),
				0
			),
		});

		const pendingAll = derived.filter((r) => !r.commissionPaid);
		const paidAll = derived.filter((r) => r.commissionPaid);

		const pOnline = pendingAll.filter(
			(r) => r.computed_payment_channel === "online"
		);
		// offline = true offline + "not paid" (offline-like)
		const pOffline = pendingAll.filter(
			(r) =>
				r.computed_payment_channel === "offline" ||
				r.computed_payment_channel === "none"
		);
		const paidOnline = paidAll.filter(
			(r) => r.computed_payment_channel === "online"
		);
		const paidOffline = paidAll.filter(
			(r) =>
				r.computed_payment_channel === "offline" ||
				r.computed_payment_channel === "none"
		);

		const transfers = {
			transferred: paidOnline.filter((r) => r.moneyTransferredToHotel === true)
				.length,
			notTransferred: paidOnline.filter(
				(r) => r.moneyTransferredToHotel !== true
			).length,
		};

		const summary = {
			pending: {
				all: collect(pendingAll),
				online: collect(pOnline),
				offline: collect(pOffline),
			},
			paid: {
				all: collect(paidAll),
				online: collect(paidOnline),
				offline: collect(paidOffline),
				transfers,
			},
		};

		const pg = Math.max(1, parseInt(page, 10) || 1);
		const ps = Math.min(500, Math.max(1, parseInt(pageSize, 10) || 50));
		const total = filtered.length;
		const start = (pg - 1) * ps;
		const items = filtered.slice(start, start + ps);

		res.set("Cache-Control", "no-cache, no-store, must-revalidate");
		res.set("Pragma", "no-cache");
		res.set("Expires", "0");

		return res.json({
			hotelId,
			commissionPaid: wantPaid ? 1 : 0,
			paymentChannel,
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

		const now = new Date();
		const result = await Reservations.updateMany(
			{ _id: { $in: ids }, hotelId },
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
				},
			}
		);
		return res.json({
			ok: true,
			matched: result.matchedCount || result.nModified || 0,
		});
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
				paypal_details: 1,
				commissionPaid: 1,
				commissionStatus: 1,
				total_amount: 1,
				paid_amount: 1,
				createdAt: 1,
			}
		).lean();

		// Normalize + filter to "offline & not yet paid & status included"
		const statusIncluded = (s) => {
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
		};
		const isIncluded = (s) => {
			const n = statusIncluded(s);
			return (
				n === "checked_out" || n === "early_checked_out" || n === "inhouse"
			);
		};

		const computeCommissionFromPickedRooms = (pickedRoomsType = []) => {
			if (!Array.isArray(pickedRoomsType) || pickedRoomsType.length === 0)
				return 0;
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
		};
		const summarizePayment = (r) => {
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
				pd.mit.some(
					(c) => (c?.capture_status || "").toUpperCase() === "COMPLETED"
				);
			const isCaptured =
				legacyCaptured ||
				capTotal > 0 ||
				initialCompleted ||
				anyMitCompleted ||
				pmt === "paid online";
			return { channel: isCaptured ? "online" : offline ? "offline" : "none" };
		};
		const isCommissionPaid = (r) =>
			r?.commissionPaid === true ||
			/commission\s*paid/i.test(String(r?.commissionStatus || ""));

		const deriv = raw
			.filter((r) => isIncluded(r?.reservation_status))
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
		const batchKey = `COMMBATCH-${orderId}`;
		const totalSar = targets.reduce(
			(a, t) => a + Number(t.commissionSAR || 0),
			0
		);
		const usdPerItem = rawCents.map(fromCents).map(Number);
		const totalUsd = Number(fromCents(sumCents));

		for (let i = 0; i < targets.length; i++) {
			const t = targets[i];
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

			await Reservations.updateOne(
				{ _id: t._id, hotelId },
				{
					$set: {
						commissionPaid: true,
						commissionStatus: "commission paid",
						commissionPaidAt: now,
						"commissionData.last": entry,
					},
					$push: { "commissionData.history": entry },
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
				const fullOnline =
					pay.channel === "online" &&
					Number(r?.paid_amount || 0) >= Number(r?.total_amount || 0);
				return {
					...r,
					computed_payment_status: pay.status,
					computed_payment_channel: pay.channel,
					computed_commission_sar: Number(Number(commSar).toFixed(2)),
					commissionPaid: isCommissionPaid(r),
					eligibleForHotelTransfer: fullOnline,
				};
			});

		const sum = (arr, get) => arr.reduce((a, x) => a + Number(get(x) || 0), 0);

		// offline = true offline + not-paid (offline-like)
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

		// keep legacy keys for the current UI, but include not‑paid in offline
		const legacy = {
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
				totalSAR: sum(transfersDueToHotel, (r) => r.total_amount),
			},
			transfersCompletedToHotel: {
				count: transfersCompletedToHotel.length,
				totalSAR: sum(transfersCompletedToHotel, (r) => r.total_amount),
			},
		};

		// plus the nested structure you already use elsewhere
		const pendingOnline = derived.filter(
			(r) => r.computed_payment_channel === "online" && !r.commissionPaid
		);
		const paidOnline = derived.filter(
			(r) => r.computed_payment_channel === "online" && r.commissionPaid
		);
		const nested = {
			pending: {
				offline: legacy.commissionDueFromHotel,
				online: {
					count: pendingOnline.length,
					commissionSAR: sum(pendingOnline, (r) => r.computed_commission_sar),
					totalSAR: sum(pendingOnline, (r) => r.total_amount),
				},
			},
			paid: {
				offline: legacy.commissionPaidByHotel,
				online: {
					count: paidOnline.length,
					commissionSAR: sum(paidOnline, (r) => r.computed_commission_sar),
					totalSAR: sum(paidOnline, (r) => r.total_amount),
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
		return res.json({ hotelId, summary });
	} catch (e) {
		console.error("getHotelFinanceOverview:", e);
		return res.status(500).json({ message: "Failed to build overview." });
	}
};
