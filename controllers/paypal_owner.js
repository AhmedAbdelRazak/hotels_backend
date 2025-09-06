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

/* ─────────────── 1) Env & PayPal client ─────────────── */
const IS_PROD = /prod/i.test(process.env.NODE_ENV);
const clientId = IS_PROD
	? process.env.PAYPAL_CLIENT_ID_LIVE
	: process.env.PAYPAL_CLIENT_ID_SANDBOX;
const secretKey = IS_PROD
	? process.env.PAYPAL_SECRET_KEY_LIVE
	: process.env.PAYPAL_SECRET_KEY_SANDBOX;

if (!clientId || !secretKey) {
	// eslint-disable-next-line no-console
	console.warn("[PayPal][Owner] Missing CLIENT_ID/SECRET; routes will fail.");
}

const env = IS_PROD
	? new paypal.core.LiveEnvironment(clientId, secretKey)
	: new paypal.core.SandboxEnvironment(clientId, secretKey);
const ppClient = new paypal.core.PayPalHttpClient(env);

const PPM = IS_PROD
	? "https://api-m.paypal.com"
	: "https://api-m.sandbox.paypal.com";

// axios helper w/ mild idempotent retries
const ax = axios.create({ timeout: 12_000 });
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

function idSig(id) {
	try {
		return crypto
			.createHash("sha256")
			.update(String(id))
			.digest("hex")
			.slice(0, 8);
	} catch {
		return "na";
	}
}

/* Helper: exchange setup_token -> vault payment token.
   Uses the generic "token" envelope, then falls back for older sandboxes. */
async function exchangeSetupToVaultToken(setupTokenId) {
	try {
		const { data } = await ax.post(
			`${PPM}/v3/vault/payment-tokens`,
			{
				payment_source: {
					token: { id: String(setupTokenId), type: "SETUP_TOKEN" },
				},
			},
			{
				auth: { username: clientId, password: secretKey },
				headers: { "Content-Type": "application/json" },
			}
		);
		return data;
	} catch (err) {
		// Fallback: legacy schema some sandboxes still accept
		const isSchema =
			err?.response?.status === 400 &&
			Array.isArray(err?.response?.data?.details) &&
			err.response.data.details.some((d) =>
				/MISSING_REQUIRED_PARAMETER/i.test(String(d?.issue || ""))
			);

		if (!isSchema) throw err;

		const { data } = await ax.post(
			`${PPM}/v3/vault/payment-tokens`,
			{ setup_token_id: String(setupTokenId) },
			{
				auth: { username: clientId, password: secretKey },
				headers: { "Content-Type": "application/json" },
			}
		);
		return data;
	}
}

/* ─────────────── 2) Script client token (owner) ─────────────── */
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
		console.error("[Owner] PayPal client-token:", e?.response?.data || e);
		return res
			.status(503)
			.json({ error: "PayPal temporarily unreachable. Try again." });
	}
};

/* ─────────────── 3) Create Setup Token for card / paypal / venmo ───────────────
   Body: { payment_source: 'card' | 'paypal' | 'venmo' }
   We do NOT send PAN/CVV here; JS SDK attaches it to this setup token client-side.
*/
exports.createSetupToken = async (req, res) => {
	try {
		const src = String(req.body?.payment_source || "card").toLowerCase();
		let payment_source;

		if (src === "card") {
			payment_source = {
				card: { attributes: { verification: { method: "SCA_WHEN_REQUIRED" } } },
			};
		} else if (src === "paypal") {
			payment_source = { paypal: {} };
		} else if (src === "venmo") {
			payment_source = { venmo: {} };
		} else {
			return res.status(400).json({ message: "Unsupported payment_source." });
		}

		const { data } = await ax.post(
			`${PPM}/v3/vault/setup-tokens`,
			{ payment_source },
			{
				auth: { username: clientId, password: secretKey },
				headers: { "Content-Type": "application/json" },
			}
		);

		return res.status(200).json({ id: data?.id });
	} catch (e) {
		console.error("[Owner] create setup-token failed:", e?.response?.data || e);
		return res.status(500).json({ message: "Failed to create setup token" });
	}
};

/* ─────────────── 4) Exchange setup_token -> vault + persist to hotel ───────────────
   Body: { hotelId, setup_token, label?, setDefault? }
*/
exports.vaultExchangeAndSave = async (req, res) => {
	try {
		const {
			hotelId,
			setup_token,
			vaultSetupToken,
			setup_token_id,
			setupToken,
			token: tokenMaybe,
			label,
			setDefault,
		} = req.body || {};

		if (!hotelId || !mongoose.Types.ObjectId.isValid(hotelId)) {
			return res.status(400).json({ message: "Invalid hotelId." });
		}

		const setupTokenId =
			setup_token ||
			vaultSetupToken ||
			setup_token_id ||
			setupToken ||
			tokenMaybe ||
			null;

		if (!setupTokenId || typeof setupTokenId !== "string") {
			return res.status(400).json({ message: "setup_token is required." });
		}

		const hotel = await HotelDetails.findById(hotelId);
		if (!hotel) return res.status(404).json({ message: "Hotel not found." });

		// Exchange to vault token (works for card, paypal, venmo)
		let tokenData = null;
		try {
			tokenData = await exchangeSetupToVaultToken(setupTokenId);
		} catch (e) {
			console.error(
				"[Owner] Vault exchange failed:",
				e?.response?.data || e?.message || e
			);
			return res
				.status(400)
				.json({ message: "Unable to save method with PayPal." });
		}

		// Some environments omit 'status'. Treat missing status as OK (same as 'ACTIVE').
		const status = String(tokenData?.status || "ACTIVE").toUpperCase();
		if (!["ACTIVE", "APPROVED", "CREATED", "VERIFIED"].includes(status)) {
			console.warn("[Owner] Unusual vault token status: ", tokenData);
		}

		// Normalize to our schema
		const ps = tokenData?.payment_source || {};
		let method_type = "CARD";
		let normalized = {
			label: "",
			vault_id: tokenData.id,
			vault_status: tokenData.status || "ACTIVE",
			vaulted_at: new Date(tokenData.create_time || Date.now()),
			card_brand: null,
			card_last4: null,
			card_exp: null,
			billing_address: undefined,
			method_type: "CARD",
			paypal_email: null,
			paypal_payer_id: null,
			venmo_username: null,
			venmo_user_id: null,
			default: !!setDefault,
			active: true,
			delete: false,
		};

		if (ps.card) {
			method_type = "CARD";
			normalized.card_brand = ps.card.brand || null;
			normalized.card_last4 = ps.card.last_digits || null;
			normalized.card_exp = ps.card.expiry || null;
			if (ps.card.billing_address)
				normalized.billing_address = ps.card.billing_address;
			normalized.label =
				label ||
				`${ps.card.brand || "CARD"} •••• ${ps.card.last_digits || "****"}${
					ps.card.expiry ? ` • ${ps.card.expiry}` : ""
				}`;
		} else if (ps.paypal) {
			method_type = "PAYPAL";
			const email = ps.paypal.email || ps.paypal.email_address || null;
			const payerId = ps.paypal.account_id || ps.paypal.payer_id || null;
			normalized.paypal_email = email;
			normalized.paypal_payer_id = payerId;
			normalized.label = label || `PayPal${email ? ` • ${email}` : ""}`;
		} else if (ps.venmo) {
			method_type = "VENMO";
			const uname = ps.venmo.username || ps.venmo.user_name || null;
			const uid =
				ps.venmo.account_id || ps.venmo.payer_id || ps.venmo.id || null;
			normalized.venmo_username = uname;
			normalized.venmo_user_id = uid;
			normalized.label = label || `Venmo${uname ? ` • @${uname}` : ""}`;
		}
		normalized.method_type = method_type;

		// Upsert into hotel.ownerPaymentMethods
		const arr = Array.isArray(hotel.ownerPaymentMethods)
			? hotel.ownerPaymentMethods
			: [];
		const existingIdx = arr.findIndex(
			(m) => String(m.vault_id) === String(normalized.vault_id)
		);

		if (setDefault) {
			for (const m of arr) m.default = false;
		}

		if (existingIdx >= 0) {
			// Update in place (revive if was deleted/inactive)
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
	} catch (error) {
		console.error(
			"vaultExchangeAndSave error:",
			error?.response?.data || error
		);
		return res.status(500).json({ message: "Failed to save owner method." });
	}
};

/* ─────────────── 5) List / default / activate / deactivate / delete ─────────────── */

exports.listPaymentMethods = async (req, res) => {
	try {
		const { hotelId } = req.params;
		const all = String(req.query?.all || "") === "1";
		if (!hotelId || !mongoose.Types.ObjectId.isValid(hotelId)) {
			return res.status(400).json({ message: "Invalid hotelId." });
		}
		const hotel = await HotelDetails.findById(hotelId).lean();
		if (!hotel) return res.status(404).json({ message: "Hotel not found." });

		let methods = Array.isArray(hotel.ownerPaymentMethods)
			? hotel.ownerPaymentMethods
			: [];
		if (!all) methods = methods.filter((m) => m?.delete !== true);

		return res.json({
			hotelId,
			count: methods.length,
			ownerPaymentMethods: methods,
		});
	} catch (e) {
		console.error("listPaymentMethods error:", e);
		return res.status(500).json({ message: "Failed to list owner methods." });
	}
};

exports.setDefaultMethod = async (req, res) => {
	try {
		const { hotelId, methodId, vault_id } = req.body || {};
		if (!hotelId || !mongoose.Types.ObjectId.isValid(hotelId)) {
			return res.status(400).json({ message: "Invalid hotelId." });
		}
		const hotel = await HotelDetails.findById(hotelId);
		if (!hotel) return res.status(404).json({ message: "Hotel not found." });

		const arr = Array.isArray(hotel.ownerPaymentMethods)
			? hotel.ownerPaymentMethods
			: [];
		for (const m of arr) m.default = false;

		let updated = false;
		for (const m of arr) {
			if (
				(methodId && String(m._id) === String(methodId)) ||
				(vault_id && String(m.vault_id) === String(vault_id))
			) {
				m.default = true;
				m.active = true;
				m.delete = false;
				updated = true;
				break;
			}
		}
		if (!updated) return res.status(404).json({ message: "Method not found." });

		hotel.ownerPaymentMethods = arr;
		const saved = await hotel.save();
		return res.json({
			message: "Default set.",
			ownerPaymentMethods: saved.ownerPaymentMethods,
		});
	} catch (e) {
		console.error("setDefaultMethod error:", e);
		return res.status(500).json({ message: "Failed to set default method." });
	}
};

exports.activateMethod = async (req, res) => {
	try {
		const { hotelId, methodId } = req.body || {};
		if (!hotelId || !mongoose.Types.ObjectId.isValid(hotelId)) {
			return res.status(400).json({ message: "Invalid hotelId." });
		}
		const hotel = await HotelDetails.findById(hotelId);
		if (!hotel) return res.status(404).json({ message: "Hotel not found." });

		const arr = Array.isArray(hotel.ownerPaymentMethods)
			? hotel.ownerPaymentMethods
			: [];
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
		console.error("activateMethod error:", e);
		return res.status(500).json({ message: "Failed to activate method." });
	}
};

exports.deactivateMethod = async (req, res) => {
	try {
		const { hotelId, methodId } = req.body || {};
		if (!hotelId || !mongoose.Types.ObjectId.isValid(hotelId)) {
			return res.status(400).json({ message: "Invalid hotelId." });
		}
		const hotel = await HotelDetails.findById(hotelId);
		if (!hotel) return res.status(404).json({ message: "Hotel not found." });

		const arr = Array.isArray(hotel.ownerPaymentMethods)
			? hotel.ownerPaymentMethods
			: [];
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
		console.error("deactivateMethod error:", e);
		return res.status(500).json({ message: "Failed to deactivate method." });
	}
};

exports.deleteMethod = async (req, res) => {
	try {
		const { hotelId, methodId } = req.body || {};
		if (!hotelId || !mongoose.Types.ObjectId.isValid(hotelId)) {
			return res.status(400).json({ message: "Invalid hotelId." });
		}
		const hotel = await HotelDetails.findById(hotelId);
		if (!hotel) return res.status(404).json({ message: "Hotel not found." });

		const arr = Array.isArray(hotel.ownerPaymentMethods)
			? hotel.ownerPaymentMethods
			: [];
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
		console.error("deleteMethod error:", e);
		return res.status(500).json({ message: "Failed to delete method." });
	}
};

/* ─────────────── 6) Util: mirror FE payment summary (offline / not paid) ─────────────── */

function summarizePaymentServer(reservation) {
	// Mirrors your EnhancedContentTable.summarizePayment logic
	const pd = reservation?.paypal_details || {};
	const pmt = String(reservation?.payment || "").toLowerCase();
	const legacyCaptured = !!reservation?.payment_details?.captured;

	// offline if they entered some onsite amount, or payment explicitly says paid offline
	const onsiteAmt = Number(
		reservation?.payment_details?.onsite_paid_amount || 0
	);
	const payOffline = onsiteAmt > 0 || pmt === "paid offline";

	// PayPal ledger signals (same as FE)
	const capTotal = Number(pd?.captured_total_usd || 0);
	const pendingUsd = Number(pd?.pending_total_usd || 0);
	const initialCompleted =
		String(pd?.initial?.capture_status || "").toUpperCase() === "COMPLETED";
	const anyMitCompleted =
		Array.isArray(pd?.mit) &&
		pd.mit.some(
			(c) => String(c?.capture_status || "").toUpperCase() === "COMPLETED"
		);

	// Unify captured with PayPal + legacy + explicit
	const isCaptured =
		legacyCaptured ||
		capTotal > 0 ||
		initialCompleted ||
		anyMitCompleted ||
		pmt === "paid online";

	const isNotPaid = pmt === "not paid" && !isCaptured && !payOffline;

	let status = "Not Captured";
	if (isCaptured) status = "Captured";
	else if (payOffline) status = "Paid Offline";
	else if (isNotPaid) status = "Not Paid";

	// Build the same short hint you use in FE tooltip (optional)
	const pieces = [];
	if (capTotal > 0) pieces.push(`captured $${capTotal.toFixed(2)}`);
	if (pendingUsd > 0) pieces.push(`pending $${pendingUsd.toFixed(2)}`);
	const hint = pieces.length ? `PayPal: ${pieces.join(" / ")}` : "";

	return { status, hint, isCaptured, paidOffline: payOffline };
}

/* Case-insensitive test for reservation_status ∈ checked_out / early_checked_out / checked out */
function isCheckedOutFamily(status) {
	const s = String(status || "").toLowerCase();
	return (
		s === "checked_out" ||
		s === "early_checked_out" ||
		s === "checked out" || // users sometimes store with a space
		s === "checkedout" // optional safeguard if this variant ever shows up
	);
}

/**
 * GET /paypal-owner/commission/candidates
 * Query params:
 *   - hotelId (required) : ObjectId string
 *   - page (optional, default 1)
 *   - pageSize (optional, default 50, max 200)
 *   - checkoutFrom (optional ISO date) => filters by checkout_date >=
 *   - checkoutTo (optional ISO date)   => filters by checkout_date < (end-exclusive)
 *
 * Returns only the reservations whose computed payment status is "Paid Offline" or "Not Paid",
 * and whose reservation_status is one of: checked_out / early_checked_out / checked out.
 */
exports.listCommissionCandidates = async (req, res) => {
	try {
		const { hotelId } = req.query;
		let { page = 1, pageSize = 50, checkoutFrom, checkoutTo } = req.query;

		if (!hotelId || !mongoose.Types.ObjectId.isValid(hotelId)) {
			return res.status(400).json({ message: "Invalid hotelId." });
		}

		page = Math.max(1, parseInt(page, 10) || 1);
		pageSize = Math.max(1, Math.min(200, parseInt(pageSize, 10) || 50));

		// Base query: hotel + reservation_status in the "checked-out family"
		// NOTE: reservation_status is stored lowercase per schema, but we use regex for safety.
		const statusRegexes = [
			/^checked[_\s]?out$/i,
			/^early[_\s]?checked[_\s]?out$/i,
		];

		const query = {
			hotelId: new mongoose.Types.ObjectId(hotelId),
			reservation_status: { $in: statusRegexes },
		};

		// Optional date filters (by checkout_date)
		if (checkoutFrom || checkoutTo) {
			query.checkout_date = {};
			if (checkoutFrom) query.checkout_date.$gte = new Date(checkoutFrom);
			if (checkoutTo) query.checkout_date.$lt = new Date(checkoutTo);
		}

		// Pull candidates by status and hotel first, then compute payment status server-side (mirroring FE)
		// You can project only what you need; returning full docs for now.
		const raw = await Reservations.find(query).lean();

		// Compute payment status and filter down to Paid Offline or Not Paid
		const enriched = raw.map((r) => {
			const pay = summarizePaymentServer(r); // same as FE
			return {
				...r,
				computed_payment_status: pay.status,
				computed_payment_hint: pay.hint,
			};
		});

		const filtered = enriched.filter(
			(r) =>
				r.computed_payment_status === "Paid Offline" ||
				r.computed_payment_status === "Not Paid"
		);

		// Sort newest checkout first (then createdAt)
		filtered.sort((a, b) => {
			const aTime = a?.checkout_date ? new Date(a.checkout_date).getTime() : 0;
			const bTime = b?.checkout_date ? new Date(b.checkout_date).getTime() : 0;
			if (bTime !== aTime) return bTime - aTime;
			const aCreated = a?.createdAt ? new Date(a.createdAt).getTime() : 0;
			const bCreated = b?.createdAt ? new Date(b.createdAt).getTime() : 0;
			return bCreated - aCreated;
		});

		// Server-side pagination (post-filter)
		const total = filtered.length;
		const totalPages = Math.max(1, Math.ceil(total / pageSize));
		const start = (page - 1) * pageSize;
		const pageItems = filtered.slice(start, start + pageSize);

		// Light summary helpers
		const countPaidOffline = filtered.filter(
			(r) => r.computed_payment_status === "Paid Offline"
		).length;
		const countNotPaid = filtered.filter(
			(r) => r.computed_payment_status === "Not Paid"
		).length;
		const sumCommission = filtered.reduce(
			(acc, r) => acc + Number(r?.commission || 0),
			0
		);
		const sumTotalAmount = filtered.reduce(
			(acc, r) => acc + Number(r?.total_amount || 0),
			0
		);

		return res.json({
			hotelId,
			filter: {
				statuses: ["checked_out", "early_checked_out", "checked out"],
				payStatuses: ["Paid Offline", "Not Paid"],
				checkoutFrom: checkoutFrom || null,
				checkoutTo: checkoutTo || null,
			},
			pagination: {
				page,
				pageSize,
				total,
				totalPages,
			},
			summary: {
				countPaidOffline,
				countNotPaid,
				sumCommission,
				sumTotalAmount,
			},
			reservations: pageItems,
		});
	} catch (e) {
		console.error("listCommissionCandidates error:", e);
		return res
			.status(500)
			.json({ message: "Failed to list commission candidates." });
	}
};

exports.markCommissionPaid = async (req, res) => {
	try {
		const { hotelId, reservationIds, paidAt, note } = req.body || {};

		if (!hotelId || !mongoose.Types.ObjectId.isValid(hotelId)) {
			return res.status(400).json({ message: "Invalid hotelId." });
		}
		if (!Array.isArray(reservationIds) || reservationIds.length === 0) {
			return res
				.status(400)
				.json({ message: "reservationIds must be a non-empty array." });
		}

		// Load and verify candidates belong to hotel and match the business rule (checked out family + Paid Offline|Not Paid)
		const ids = reservationIds
			.filter(Boolean)
			.map((id) => new mongoose.Types.ObjectId(String(id)));

		const statusRegexes = [
			/^checked[_\s]?out$/i,
			/^early[_\s]?checked[_\s]?out$/i,
		];

		const baseCandidates = await Reservations.find({
			_id: { $in: ids },
			hotelId: new mongoose.Types.ObjectId(hotelId),
			reservation_status: { $in: statusRegexes },
		}).lean();

		const verified = baseCandidates.filter((r) => {
			const pay = summarizePaymentServer(r);
			return pay.status === "Paid Offline" || pay.status === "Not Paid";
		});

		const verifiedIds = verified.map((r) => r._id);
		const excludedIds = ids
			.map(String)
			.filter((id) => !verifiedIds.some((vi) => String(vi) === id));

		if (verifiedIds.length === 0) {
			return res.status(400).json({
				message:
					"No reservations qualified (checked-out family + Paid Offline/Not Paid).",
				excludedIds,
			});
		}

		// Update commission flags
		const update = {
			commissionPaid: true,
			commissionStatus: "commission paid",
			// If you later want to persist audit info, consider adding a 'commissionHistory' array in the schema.
			// e.g. $push: { commissionHistory: { paidAt: new Date(...), by: userId, note } }
		};

		const result = await Reservations.updateMany(
			{ _id: { $in: verifiedIds } },
			{ $set: update }
		);

		return res.json({
			message: "Commission status updated.",
			matched: result.matchedCount || result.n || 0,
			modified: result.modifiedCount || result.nModified || 0,
			updatedIds: verifiedIds.map(String),
			excludedIds, // helpful to see which requested IDs were filtered out
			paidAt: paidAt ? new Date(paidAt) : new Date(),
			note: note || null,
		});
	} catch (e) {
		console.error("markCommissionPaid error:", e);
		return res.status(500).json({ message: "Failed to mark commission paid." });
	}
};
