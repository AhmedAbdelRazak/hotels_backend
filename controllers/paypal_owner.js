/** controllers/paypal_owner.js
 * Secure company-card vault management (ownerPaymentMethods) for a hotel
 * - Never stores PAN/CVV — uses PayPal vault tokens only
 */

"use strict";

const axios = require("axios");
const crypto = require("crypto");
const HotelDetails = require("../models/hotel_details");

// —— PayPal ENV ————————————————————————————————————————————————
const IS_PROD = /prod/i.test(process.env.NODE_ENV);
const PPM = IS_PROD
	? "https://api-m.paypal.com"
	: "https://api-m.sandbox.paypal.com";

const CLIENT_ID = IS_PROD
	? process.env.PAYPAL_CLIENT_ID_LIVE
	: process.env.PAYPAL_CLIENT_ID_SANDBOX;

const SECRET = IS_PROD
	? process.env.PAYPAL_SECRET_KEY_LIVE
	: process.env.PAYPAL_SECRET_KEY_SANDBOX;

if (!CLIENT_ID || !SECRET) {
	// eslint-disable-next-line no-console
	console.warn(
		"[PayPal] Missing CLIENT_ID/SECRET; owner card routes will fail."
	);
}

const ax = axios.create({ timeout: 12000 });

// —— Helpers ————————————————————————————————————————————————
const toArray = (x) => (Array.isArray(x) ? x : []);
const safe = (x) => JSON.parse(JSON.stringify(x || {}));
const idem = (prefix = "req") =>
	`${prefix}:${Date.now()}:${crypto.randomBytes(6).toString("hex")}`;

function canManageHotel(req, hotelDoc) {
	try {
		const a = req.auth || {};
		if (Number(a.role) >= 2000) return true; // superadmin
		return String(hotelDoc.belongsTo) === String(a._id);
	} catch {
		return false;
	}
}

async function exchangeSetupTokenToVault(setup_token_id) {
	const { data } = await ax.post(
		`${PPM}/v3/vault/payment-tokens`,
		{ setup_token_id },
		{
			auth: { username: CLIENT_ID, password: SECRET },
			headers: { "Content-Type": "application/json" },
		}
	);
	return data; // { id, status, payment_source.card... }
}

function buildMethodDocFromVault(vault, { label, setDefault }) {
	const c = vault?.payment_source?.card || {};
	return {
		label: label || "",
		vault_id: vault?.id,
		vault_status: vault?.status || "ACTIVE",
		vaulted_at: new Date(vault?.create_time || Date.now()),
		card_brand: c.brand || null,
		card_last4: c.last_digits || null,
		card_exp: c.expiry || null, // "YYYY-MM"
		billing_address: c.billing_address || undefined,
		default: !!setDefault,
		active: true,
	};
}

// —— Controllers ————————————————————————————————————————————————

/**
 * GET /hotels/:hotelId/paypal/owner/methods
 */
exports.listOwnerPaymentMethods = async (req, res) => {
	try {
		const { hotelId } = req.params;
		const hotel = await HotelDetails.findById(hotelId).select(
			"ownerPaymentMethods belongsTo"
		);
		if (!hotel) return res.status(404).json({ message: "Hotel not found" });
		if (!canManageHotel(req, hotel))
			return res.status(403).json({ message: "Forbidden" });

		const methods = toArray(hotel.ownerPaymentMethods);

		// Default first, active first, newest first
		methods.sort((a, b) => {
			if (!!b.default - !!a.default !== 0) return !!b.default - !!a.default;
			const act = !!b.active - !!a.active;
			if (act !== 0) return act;
			return new Date(b.vaulted_at) - new Date(a.vaulted_at);
		});

		return res.json({ methods });
	} catch (e) {
		// eslint-disable-next-line no-console
		console.error("listOwnerPaymentMethods error:", e?.response?.data || e);
		return res.status(500).json({ message: "Failed to load cards" });
	}
};

/**
 * POST /hotels/:hotelId/paypal/owner/save-card
 * Body:
 *   - wallet: { setup_token, label?, setDefault? }
 *   - card:   { order_id,  label?, setDefault? }  // $50 auth precheck, save vault_id, void auth
 */
exports.saveOwnerCard = async (req, res) => {
	const MIN_AUTH_USD = 50.0;

	try {
		const { hotelId } = req.params;
		const { setup_token, order_id, label, setDefault } = req.body || {};

		if (!setup_token && !order_id) {
			return res
				.status(400)
				.json({ message: "setup_token or order_id is required" });
		}

		const hotel = await HotelDetails.findById(hotelId).select(
			"ownerPaymentMethods belongsTo"
		);
		if (!hotel) return res.status(404).json({ message: "Hotel not found" });
		if (!canManageHotel(req, hotel))
			return res.status(403).json({ message: "Forbidden" });

		let methods = toArray(hotel.ownerPaymentMethods);
		let methodDoc = null;

		// ——— A) WALLET (PayPal/Venmo): exchange setup_token -> vault
		if (setup_token) {
			const vault = await exchangeSetupTokenToVault(setup_token);
			const vault_id = vault?.id;
			if (!vault_id)
				return res.status(400).json({ message: "Vault exchange failed" });
			methodDoc = buildMethodDocFromVault(vault, {
				label: label || "PayPal",
				setDefault,
			});
		}

		// ——— B) CARD FIELDS with order_id: AUTH $50 -> extract vault -> VOID
		if (order_id) {
			// 1) GET order — verify amount ≥ $50
			const getOrder = await ax.get(`${PPM}/v2/checkout/orders/${order_id}`, {
				auth: { username: CLIENT_ID, password: SECRET },
			});
			const order = getOrder.data;
			const pu = Array.isArray(order?.purchase_units)
				? order.purchase_units[0]
				: null;
			const orderAmount = Number(pu?.amount?.value || 0);
			if (!orderAmount || orderAmount + 1e-9 < MIN_AUTH_USD) {
				return res.status(400).json({
					message: `Order amount must be at least $${MIN_AUTH_USD.toFixed(2)}`,
				});
			}

			// 2) AUTHORIZE the order
			const authRes = await ax.post(
				`${PPM}/v2/checkout/orders/${order_id}/authorize`,
				{},
				{
					auth: { username: CLIENT_ID, password: SECRET },
					headers: { "PayPal-Request-Id": idem("auth") },
				}
			);
			const authorized = authRes.data;
			const auth =
				authorized?.purchase_units?.[0]?.payments?.authorizations?.[0] || null;
			const status = String(auth?.status || "").toUpperCase();
			if (
				!auth?.id ||
				!["CREATED", "AUTHORIZED", "PENDING", "PARTIALLY_CAPTURED"].includes(
					status
				)
			) {
				return res.status(402).json({ message: "Authorization failed" });
			}

			// 3) Extract vault metadata (Card Fields with store_in_vault=ON_SUCCESS)
			const srcCard = authorized?.payment_source?.card || {};
			const vault_id = srcCard?.attributes?.vault?.id || null;
			if (!vault_id) {
				return res
					.status(400)
					.json({ message: "No vault token returned by PayPal" });
			}

			methodDoc = {
				label: label || "",
				vault_id,
				vault_status: "ACTIVE",
				vaulted_at: new Date(),
				card_brand: srcCard?.brand || null,
				card_last4: srcCard?.last_digits || null,
				card_exp: srcCard?.expiry || null,
				billing_address: srcCard?.billing_address || undefined,
				default: !!setDefault,
				active: true,
			};

			// 4) VOID the authorization (we're only pre‑checking funds)
			try {
				await ax.post(
					`${PPM}/v2/payments/authorizations/${auth.id}/void`,
					{},
					{ auth: { username: CLIENT_ID, password: SECRET } }
				);
			} catch (voidErr) {
				// eslint-disable-next-line no-console
				console.warn(
					"Auth void warning:",
					voidErr?.response?.data || voidErr?.message || voidErr
				);
			}
		}

		// ——— Upsert in DB
		const idx = methods.findIndex(
			(m) => String(m.vault_id) === String(methodDoc.vault_id)
		);
		if (idx >= 0) {
			const prev = methods[idx];
			methods[idx] = {
				...safe(prev),
				...methodDoc,
				vaulted_at: prev.vaulted_at || methodDoc.vaulted_at,
				active: true,
			};
		} else {
			methods.push(methodDoc);
		}

		// Default handling
		if (methodDoc.default) {
			for (let i = 0; i < methods.length; i += 1) {
				methods[i].default =
					String(methods[i].vault_id) === String(methodDoc.vault_id);
			}
		} else if (!methods.some((m) => m.default === true)) {
			const firstActive = methods.find((m) => m.active !== false);
			if (firstActive) firstActive.default = true;
		}

		hotel.ownerPaymentMethods = methods;
		await hotel.save();

		return res.status(201).json({ methods: hotel.ownerPaymentMethods });
	} catch (e) {
		// eslint-disable-next-line no-console
		console.error("saveOwnerCard error:", e?.response?.data || e);
		return res.status(500).json({ message: "Failed to save card" });
	}
};

/**
 * POST /hotels/:hotelId/paypal/owner/methods/:vaultId/default
 */
exports.setOwnerDefaultCard = async (req, res) => {
	try {
		const { hotelId, vaultId } = req.params;
		const hotel = await HotelDetails.findById(hotelId).select(
			"ownerPaymentMethods belongsTo"
		);
		if (!hotel) return res.status(404).json({ message: "Hotel not found" });
		if (!canManageHotel(req, hotel))
			return res.status(403).json({ message: "Forbidden" });

		const methods = toArray(hotel.ownerPaymentMethods);
		let found = false;
		methods.forEach((m) => {
			if (String(m.vault_id) === String(vaultId) && m.active !== false) {
				m.default = true;
				found = true;
			} else {
				m.default = false;
			}
		});
		if (!found)
			return res.status(404).json({ message: "Card not found or inactive" });

		hotel.ownerPaymentMethods = methods;
		await hotel.save();
		return res.json({ methods: hotel.ownerPaymentMethods });
	} catch (e) {
		// eslint-disable-next-line no-console
		console.error("setOwnerDefaultCard error:", e?.response?.data || e);
		return res.status(500).json({ message: "Failed to set default card" });
	}
};

/**
 * DELETE /hotels/:hotelId/paypal/owner/methods/:vaultId
 */
exports.removeOwnerCard = async (req, res) => {
	try {
		const { hotelId, vaultId } = req.params;
		const hotel = await HotelDetails.findById(hotelId).select(
			"ownerPaymentMethods belongsTo"
		);
		if (!hotel) return res.status(404).json({ message: "Hotel not found" });
		if (!canManageHotel(req, hotel))
			return res.status(403).json({ message: "Forbidden" });

		const methods = toArray(hotel.ownerPaymentMethods);
		const idx = methods.findIndex(
			(m) => String(m.vault_id) === String(vaultId)
		);
		if (idx < 0) return res.status(404).json({ message: "Card not found" });

		const wasDefault = !!methods[idx].default;
		methods[idx].active = false;
		methods[idx].default = false;

		if (wasDefault) {
			const nextActive = methods.find(
				(m, i) => i !== idx && m.active !== false
			);
			if (nextActive) nextActive.default = true;
		}

		hotel.ownerPaymentMethods = methods;
		await hotel.save();

		return res.json({ methods: hotel.ownerPaymentMethods });
	} catch (e) {
		// eslint-disable-next-line no-console
		console.error("removeOwnerCard error:", e?.response?.data || e);
		return res.status(500).json({ message: "Failed to remove card" });
	}
};

/**
 * GET /paypal/token-generated
 * Client token for PayPal JS SDK (buttons + card-fields). Cached 8h.
 */
let cachedToken = null;
let cachedExp = 0;
exports.generateClientToken = async (req, res) => {
	try {
		if (cachedToken && Date.now() < cachedExp) {
			return res.json({
				clientToken: cachedToken,
				env: IS_PROD ? "live" : "sandbox",
			});
		}
		const { data } = await ax.post(
			`${PPM}/v1/identity/generate-token`,
			{},
			{ auth: { username: CLIENT_ID, password: SECRET } }
		);
		cachedToken = data?.client_token || null;
		cachedExp = Date.now() + 1000 * 60 * 60 * 8; // 8h
		if (!cachedToken)
			return res.status(503).json({ message: "No client token" });
		return res.json({
			clientToken: cachedToken,
			env: IS_PROD ? "live" : "sandbox",
		});
	} catch (e) {
		// eslint-disable-next-line no-console
		console.error("generateClientToken error:", e?.response?.data || e);
		return res
			.status(503)
			.json({ message: "Unable to get PayPal client token" });
	}
};
