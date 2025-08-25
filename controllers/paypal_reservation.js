/*********************************************************************
 *  controllers/paypal_reservation.js  •  Drop‑in replacement
 *  Jannat Booking — PayPal reservations: buttons & card fields
 *  - NO PAN/CVV storage (PayPal vault/payment tokens only)
 *  - Ledger with hard cap (limit_usd) + atomic pending guarding
 *  - Idempotent captures to prevent double charges
 *  - Verification only if the guest neither pays nor adds a card
 *********************************************************************/

"use strict";

/* ─────────────── 1) Deps & environment ─────────────── */
const paypal = require("@paypal/checkout-server-sdk");
const axios = require("axios");
const axiosRetryRaw = require("axios-retry");
const axiosRetry =
	axiosRetryRaw.default || axiosRetryRaw.axiosRetry || axiosRetryRaw;
const { v4: uuid } = require("uuid");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const puppeteer = require("puppeteer");
const sgMail = require("@sendgrid/mail");

/* Models */
const HotelDetails = require("../models/hotel_details");
const Reservations = require("../models/reservations");
const User = require("../models/user");

/* Templates + WhatsApp */
const {
	ClientConfirmationEmail,
	ReservationVerificationEmail,
	SendingReservationLinkEmailTrigger,
	paymentTriggered,
} = require("./assets");

const {
	waSendReservationConfirmation,
	waSendVerificationLink,
	waSendPaymentLink,
	waSendReservationUpdate,
	waNotifyNewReservation,
} = require("./whatsappsender");

/* Utils */
const {
	encryptWithSecret,
	decryptWithSecret,
	verifyToken,
} = require("./utils");

/* Email setup */
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

/* PayPal env/client */
const IS_PROD = /prod/i.test(process.env.NODE_ENV);
const clientId = IS_PROD
	? process.env.PAYPAL_CLIENT_ID_LIVE
	: process.env.PAYPAL_CLIENT_ID_SANDBOX;
const secretKey = IS_PROD
	? process.env.PAYPAL_SECRET_KEY_LIVE
	: process.env.PAYPAL_SECRET_KEY_SANDBOX;
if (!clientId || !secretKey) throw new Error("PayPal creds missing");

const env = IS_PROD
	? new paypal.core.LiveEnvironment(clientId, secretKey)
	: new paypal.core.SandboxEnvironment(clientId, secretKey);
const ppClient = new paypal.core.PayPalHttpClient(env);

/* Axios (REST features not in SDK) */
const ax = axios.create({ timeout: 12_000 });
axiosRetry(ax, {
	retries: 3,
	retryDelay: (c) => 400 * 2 ** c,
	// Only retry idempotent methods
	retryCondition: (err) => {
		const method = String(err?.config?.method || "").toUpperCase();
		const idempotent = ["GET", "HEAD", "OPTIONS"].includes(method);
		return idempotent && axiosRetry.isRetryableError(err);
	},
});

const PPM = IS_PROD
	? "https://api-m.paypal.com"
	: "https://api-m.sandbox.paypal.com";

/* ─────────────── 2) Helpers ─────────────── */
const toCCY = (n) => Number(n || 0).toFixed(2);
const toNum2 = (n) => Math.round(Number(n || 0) * 100) / 100; // exact cents
const safeClone = (o) => JSON.parse(JSON.stringify(o));

function sanitizeCustomerDetails(cd) {
	const o = { ...(cd || {}) };
	delete o.password;
	delete o.confirmPassword;
	return o;
}

async function getHotelAndOwner(hotelId) {
	if (!hotelId || !mongoose.Types.ObjectId.isValid(hotelId)) {
		return { hotel: null, owner: null };
	}
	const hotel = await HotelDetails.findById(hotelId)
		.populate({ path: "belongsTo", select: "_id email role name" })
		.lean()
		.exec();
	const owner = hotel && hotel.belongsTo ? hotel.belongsTo : null;
	return { hotel, owner };
}

async function sendCriticalOwnerEmail(to, subject, html) {
	if (!to) return;
	await sgMail.send({
		to,
		cc: "ahmed.abdelrazak@jannatbooking.com",
		from: "noreply@jannatbooking.com",
		subject,
		html,
	});
}

function generateRandomNumber() {
	return String(Math.floor(1000000000 + Math.random() * 9000000000));
}
function ensureUniqueNumber(model, fieldName, callback) {
	const randomNumber = generateRandomNumber();
	const query = { [fieldName]: randomNumber };
	model.findOne(query, (err, doc) => {
		if (err) callback(err);
		else if (doc) ensureUniqueNumber(model, fieldName, callback);
		else callback(null, randomNumber);
	});
}

const createPdfBuffer = async (html) => {
	const browser = await puppeteer.launch({
		headless: true,
		args: [
			"--no-sandbox",
			"--disable-setuid-sandbox",
			"--disable-dev-shm-usage",
			"--disable-accelerated-2d-canvas",
			"--no-first-run",
			"--no-zygote",
			"--single-process",
			"--disable-gpu",
		],
	});
	const page = await browser.newPage();
	await page.setContent(html, { waitUntil: "networkidle0" });
	const pdfBuffer = await page.pdf({ format: "A4" });
	await browser.close();
	return pdfBuffer;
};

async function sendEmailWithInvoice(
	reservationData,
	guestEmail,
	hotelIdOrNull
) {
	const html = ClientConfirmationEmail(reservationData);
	const pdfBuffer = await createPdfBuffer(html);

	// Guest
	await sgMail.send({
		to: guestEmail || "noreply@jannatbooking.com",
		from: "noreply@jannatbooking.com",
		subject: "Reservation Confirmation - Invoice Attached",
		html,
		attachments: [
			{
				content: pdfBuffer.toString("base64"),
				filename: "Reservation_Invoice.pdf",
				type: "application/pdf",
				disposition: "attachment",
			},
		],
	});

	// Internal
	await sgMail.send({
		to: [
			{ email: "morazzakhamouda@gmail.com" },
			{ email: "xhoteleg@gmail.com" },
			{ email: "ahmed.abdelrazak@jannatbooking.com" },
		],
		from: "noreply@jannatbooking.com",
		subject: "Reservation Confirmation - Invoice Attached",
		html,
		attachments: [
			{
				content: pdfBuffer.toString("base64"),
				filename: "Reservation_Invoice.pdf",
				type: "application/pdf",
				disposition: "attachment",
			},
		],
	});

	// Owner
	const resolvedHotelId =
		reservationData?.hotelId?._id || reservationData?.hotelId || hotelIdOrNull;
	if (resolvedHotelId && mongoose.Types.ObjectId.isValid(resolvedHotelId)) {
		const { owner } = await getHotelAndOwner(resolvedHotelId);
		const ownerEmail = owner?.email || null;
		if (ownerEmail) {
			await sendCriticalOwnerEmail(
				ownerEmail,
				"Reservation Confirmation - Invoice Attached",
				html
			);
		}
	}
}

const AUTH_OK_STATUSES = new Set([
	"CREATED",
	"AUTHORIZED",
	"PENDING",
	"PARTIALLY_CAPTURED",
]);
const isAuthStatusOk = (s) =>
	AUTH_OK_STATUSES.has(String(s || "").toUpperCase());

/* ─────────────── 3) PayPal helpers ─────────────── */
async function paypalExchangeSetupToVault(setup_token_id) {
	const { data } = await ax.post(
		`${PPM}/v3/vault/payment-tokens`,
		{ setup_token_id },
		{
			auth: { username: clientId, password: secretKey },
			headers: { "Content-Type": "application/json" },
		}
	);
	return data; // contains id (vault_id), status, payment_source.card metadata
}

async function paypalPrecheckAuthorizeVoid({
	usdAmount,
	vault_id,
	meta,
	cmid,
}) {
	const creq = new paypal.orders.OrdersCreateRequest();
	creq.headers["PayPal-Request-Id"] = `precheck-${uuid()}`;
	if (cmid) creq.headers["PayPal-Client-Metadata-Id"] = cmid;
	creq.prefer("return=representation");
	creq.requestBody({
		intent: "AUTHORIZE",
		purchase_units: [
			{
				reference_id: "default",
				invoice_id: meta.invoice_id,
				custom_id: meta.custom_id,
				description: meta.description,
				amount: {
					currency_code: "USD",
					value: toCCY(usdAmount),
					breakdown: {
						item_total: { currency_code: "USD", value: toCCY(usdAmount) },
					},
				},
				items: [
					{
						name: `Hotel Reservation — ${meta.hotelName}`,
						description: `Guest: ${meta.guestName}, Phone: ${meta.guestPhone}, ${meta.checkin} → ${meta.checkout}, Conf: ${meta.custom_id}`,
						quantity: "1",
						unit_amount: { currency_code: "USD", value: toCCY(usdAmount) },
					},
				],
			},
		],
		application_context: {
			brand_name: "Jannat Booking",
			user_action: "PAY_NOW",
			shipping_preference: "NO_SHIPPING",
		},
		payment_source: {
			token: { id: vault_id, type: "PAYMENT_METHOD_TOKEN" },
		},
	});

	const { result: order } = await ppClient.execute(creq);
	const areq = new paypal.orders.OrdersAuthorizeRequest(order.id);
	if (cmid) areq.headers["PayPal-Client-Metadata-Id"] = cmid;
	areq.requestBody({});
	const { result: authResult } = await ppClient.execute(areq);

	const auth =
		authResult?.purchase_units?.[0]?.payments?.authorizations?.[0] || {};
	if (auth?.id) {
		await ax.post(
			`${PPM}/v2/payments/authorizations/${auth.id}/void`,
			{},
			{
				auth: { username: clientId, password: secretKey },
			}
		);
	}
	return { orderId: order.id, authorization: auth };
}

async function paypalPatchOrderMetadata(orderId, meta) {
	const ops = [
		{
			op: "add",
			path: "/purchase_units/@reference_id=='default'/invoice_id",
			value: meta.invoice_id,
		},
		{
			op: "add",
			path: "/purchase_units/@reference_id=='default'/custom_id",
			value: meta.custom_id,
		},
		{
			op: "add",
			path: "/purchase_units/@reference_id=='default'/description",
			value: meta.description,
		},
		{
			op: "add",
			path: "/purchase_units/@reference_id=='default'/items",
			value: [
				{
					name: `Hotel Reservation — ${meta.hotelName}`,
					description: `Guest: ${meta.guestName}, Phone: ${meta.guestPhone}, ${meta.checkin} → ${meta.checkout}, Conf: ${meta.custom_id}`,
					quantity: "1",
					unit_amount: { currency_code: "USD", value: toCCY(meta.usdAmount) },
				},
			],
		},
		{
			op: "add",
			path: "/purchase_units/@reference_id=='default'/amount/breakdown",
			value: {
				item_total: { currency_code: "USD", value: toCCY(meta.usdAmount) },
			},
		},
		{
			op: "add",
			path: "/application_context/shipping_preference",
			value: "NO_SHIPPING",
		},
	];

	await ax.patch(`${PPM}/v2/checkout/orders/${orderId}`, ops, {
		auth: { username: clientId, password: secretKey },
		headers: { "Content-Type": "application/json" },
	});
}

async function paypalCaptureApprovedOrder({ orderId, cmid, reqId }) {
	const capReq = new paypal.orders.OrdersCaptureRequest(orderId);
	if (cmid) capReq.headers["PayPal-Client-Metadata-Id"] = cmid;
	capReq.headers["PayPal-Request-Id"] = reqId || `cap-${uuid()}`;
	capReq.requestBody({});
	try {
		const { result } = await ppClient.execute(capReq);
		return result;
	} catch (err) {
		if (err?.statusCode === 422 && /ORDER_ALREADY_CAPTURED/.test(err.message)) {
			const getReq = new paypal.orders.OrdersGetRequest(orderId);
			if (cmid) getReq.headers["PayPal-Client-Metadata-Id"] = cmid;
			const { result } = await ppClient.execute(getReq);
			return result;
		}
		throw err;
	}
}

async function paypalMitCharge({
	usdAmount,
	vault_id,
	meta,
	cmid,
	previousCaptureId,
}) {
	const creq = new paypal.orders.OrdersCreateRequest();
	creq.headers["PayPal-Request-Id"] = `mit-${uuid()}`;
	if (cmid) creq.headers["PayPal-Client-Metadata-Id"] = cmid;
	creq.prefer("return=representation");
	creq.requestBody({
		intent: "CAPTURE",
		purchase_units: [
			{
				reference_id: "default",
				invoice_id: meta.invoice_id,
				custom_id: meta.custom_id,
				description: meta.description,
				amount: {
					currency_code: "USD",
					value: toCCY(usdAmount),
					breakdown: {
						item_total: { currency_code: "USD", value: toCCY(usdAmount) },
					},
				},
				items: [
					{
						name: `Hotel Reservation — ${meta.hotelName}`,
						description: `Guest: ${meta.guestName}, Phone: ${meta.guestPhone}, ${meta.checkin} → ${meta.checkout}, Conf: ${meta.custom_id}`,
						quantity: "1",
						unit_amount: { currency_code: "USD", value: toCCY(usdAmount) },
						category: "DIGITAL_GOODS",
					},
				],
			},
		],
		application_context: {
			brand_name: "Jannat Booking",
			user_action: "PAY_NOW",
			shipping_preference: "NO_SHIPPING",
		},
		payment_source: {
			token: { id: vault_id, type: "PAYMENT_METHOD_TOKEN" },
			stored_credential: {
				payment_initiator: "MERCHANT",
				payment_type: "UNSCHEDULED",
				usage: "SUBSEQUENT",
				...(previousCaptureId
					? { previous_transaction_reference: { id: previousCaptureId } }
					: {}),
			},
		},
	});

	const { result: order } = await ppClient.execute(creq);

	const capReq = new paypal.orders.OrdersCaptureRequest(order.id);
	if (cmid) capReq.headers["PayPal-Client-Metadata-Id"] = cmid;
	capReq.headers["PayPal-Request-Id"] = `mit-cap-${uuid()}`;
	capReq.requestBody({});

	try {
		const { result } = await ppClient.execute(capReq);
		return result; // normal success
	} catch (err) {
		// If the order was already captured (duplicate click / retry), treat as success:
		const raw = err?._originalError?.text || err?.message || "";
		const alreadyCaptured =
			err?.statusCode === 422 && /ORDER_ALREADY_CAPTURED/i.test(raw);
		if (alreadyCaptured) {
			const getReq = new paypal.orders.OrdersGetRequest(order.id);
			if (cmid) getReq.headers["PayPal-Client-Metadata-Id"] = cmid;
			const { result } = await ppClient.execute(getReq);
			return result; // captured result for the same order
		}
		throw err; // real failure
	}
}

/* ─────────────── 4) Data + ledger helpers ─────────────── */
async function findOrCreateUserByEmail(customerDetails, explicitUserId) {
	let user = null;
	if (customerDetails?.email) {
		user = await User.findOne({ email: customerDetails.email });
	}
	if (!user && explicitUserId) {
		user = await User.findById(explicitUserId);
	}
	if (!user) {
		user = new User({
			name: customerDetails?.name,
			email: customerDetails?.email,
			phone: customerDetails?.phone,
			password: customerDetails?.password, // hashed by model
		});
		await user.save();
	}
	return user;
}

async function buildAndSaveReservation({
	reqBody,
	confirmationNumber,
	paypalDetailsToPersist,
	paymentDetailsPatch,
}) {
	const {
		hotelId,
		customerDetails,
		belongsTo,
		checkin_date,
		checkout_date,
		days_of_residence,
		total_rooms,
		total_guests,
		adults,
		children,
		total_amount,
		booking_source,
		pickedRoomsType,
		payment,
		paid_amount,
		commission,
		commissionPaid,
		hotelName,
		advancePayment,
		convertedAmounts,
	} = reqBody;

	const bounds =
		(paypalDetailsToPersist && paypalDetailsToPersist.bounds) ||
		(convertedAmounts?.totalUSD
			? { base: "USD", limit_usd: toNum2(convertedAmounts.totalUSD) }
			: undefined);

	const r = new Reservations({
		hotelId,
		customer_details: sanitizeCustomerDetails(customerDetails),
		confirmation_number: confirmationNumber,
		belongsTo,
		checkin_date,
		checkout_date,
		days_of_residence,
		total_rooms,
		total_guests,
		adults,
		children,
		total_amount,
		booking_source,
		pickedRoomsType,
		payment,
		paid_amount: toNum2(paid_amount || 0),
		commission: toNum2(commission || 0),
		commissionPaid: !!commissionPaid,
		hotelName,
		advancePayment,
	});

	const pd = { ...(paypalDetailsToPersist || {}) };
	if (bounds) {
		pd.bounds = bounds;
		if (typeof pd.captured_total_usd !== "number") pd.captured_total_usd = 0;
		if (typeof pd.pending_total_usd !== "number") pd.pending_total_usd = 0;
	}
	if (Object.keys(pd).length) r.paypal_details = pd;

	if (paymentDetailsPatch) {
		r.payment_details = {
			...(r.payment_details || {}),
			...paymentDetailsPatch,
		};
	}

	return r.save();
}

async function reservePendingCaptureUSD({ reservationId, usdAmount }) {
	const amount = toNum2(usdAmount);

	const cond = {
		_id: reservationId,
		$expr: {
			$lte: [
				{
					$add: [
						{ $ifNull: ["$paypal_details.captured_total_usd", 0] },
						{ $ifNull: ["$paypal_details.pending_total_usd", 0] },
						amount,
					],
				},
				{ $ifNull: ["$paypal_details.bounds.limit_usd", -1] },
			],
		},
	};
	const update = { $inc: { "paypal_details.pending_total_usd": amount } };

	return Reservations.findOneAndUpdate(cond, update, { new: true });
}

async function finalizePendingCaptureUSD({
	reservationId,
	usdAmount,
	success,
	captureDoc,
}) {
	const amount = toNum2(usdAmount);
	if (success) {
		return Reservations.findByIdAndUpdate(
			reservationId,
			{
				$inc: {
					"paypal_details.pending_total_usd": -amount,
					"paypal_details.captured_total_usd": amount,
					"payment_details.chargeCount": 1,
				},
				$push: captureDoc ? { "paypal_details.mit": captureDoc } : {},
				$set: {
					"payment_details.captured": true,
					"payment_details.triggeredAmountUSD": toNum2(amount),
				},
			},
			{ new: true }
		).populate("hotelId");
	}
	// revert pending only
	return Reservations.findByIdAndUpdate(
		reservationId,
		{ $inc: { "paypal_details.pending_total_usd": -amount } },
		{ new: true }
	).populate("hotelId");
}

/* ─────────────── 5) Controllers ─────────────── */

/** 1) Client token for JS SDK Card Fields (cache 8h) */
let cachedClientToken = null;
let cachedClientTokenExp = 0;

exports.generateClientToken = async (req, res) => {
	// Correlate client ↔ server ↔ PayPal
	const reqId = req.headers["x-request-id"] || uuid();
	const started = Date.now();

	// Optional diagnostic query params:
	// - ?dbg=1     → returns a "diag" object for client-side console
	// - ?bc=EG     → hint buyer country (for JS SDK rendering only; not persisted here)
	const dbg = req.query.dbg === "1" || req.query.debug === "1";
	const buyerCountry = String(
		req.query.bc || req.headers["x-buyer-country"] || ""
	)
		.trim()
		.toUpperCase();

	// Basic client context for logs
	const hdr = req.headers || {};
	const ua = hdr["user-agent"];
	const xff = hdr["x-forwarded-for"];
	const ip = req.ip;
	const geo =
		hdr["x-vercel-ip-country"] ||
		hdr["cf-ipcountry"] ||
		hdr["x-appengine-country"] ||
		hdr["fastly-country-code"] ||
		null;

	try {
		// Serve cached when still fresh
		if (cachedClientToken && Date.now() < cachedClientTokenExp) {
			const payload = {
				clientToken: cachedClientToken,
				cached: true,
				env: IS_PROD ? "live" : "sandbox",
			};

			if (dbg) {
				payload.diag = {
					reqId,
					mode: "cache",
					isProd: !!IS_PROD,
					ppm: PPM,
					serverNow: new Date().toISOString(),
					elapsedMs: Date.now() - started,
					ip,
					xff,
					geo,
					ua,
					buyerCountryHint: buyerCountry || null,
					cacheTtlMs: Math.max(0, cachedClientTokenExp - Date.now()),
				};
			}

			// Echo correlation headers back
			res.set("x-request-id", reqId);
			return res.json(payload);
		}

		// Generate new client-token
		const axiosRes = await ax.post(
			`${PPM}/v1/identity/generate-token`,
			{},
			{ auth: { username: clientId, password: secretKey } }
		);

		const debugId =
			axiosRes.headers?.["paypal-debug-id"] ||
			axiosRes.headers?.["paypal-debugid"] ||
			null;

		cachedClientToken = axiosRes?.data?.client_token;
		cachedClientTokenExp = Date.now() + 1000 * 60 * 60 * 8; // 8h

		// Log a compact server-side line you can grep by reqId
		console.log(
			"[PP-TOKEN][fresh]",
			JSON.stringify({
				reqId,
				isProd: !!IS_PROD,
				ppm: PPM,
				geo,
				ip,
				xff,
				ua: (ua || "").slice(0, 120),
				debugId,
				elapsedMs: Date.now() - started,
			})
		);

		const payload = {
			clientToken: cachedClientToken,
			env: IS_PROD ? "live" : "sandbox",
		};

		if (dbg) {
			payload.diag = {
				reqId,
				mode: "fresh",
				isProd: !!IS_PROD,
				ppm: PPM,
				serverNow: new Date().toISOString(),
				elapsedMs: Date.now() - started,
				ip,
				xff,
				geo,
				ua,
				buyerCountryHint: buyerCountry || null,
				paypalDebugId: debugId,
			};
		}

		// Echo correlation headers back
		res.set("x-request-id", reqId);
		if (debugId) res.set("x-paypal-debug-id", debugId);

		return res.json(payload);
	} catch (e) {
		const status = e?.response?.status || 503;
		const body = e?.response?.data || e?.message || "unknown";
		const debugId =
			e?.response?.headers?.["paypal-debug-id"] ||
			e?.response?.headers?.["paypal-debugid"] ||
			null;

		console.error(
			"[PP-TOKEN][error]",
			JSON.stringify({
				reqId,
				isProd: !!IS_PROD,
				ppm: PPM,
				status,
				debugId,
				geo,
				ip,
				xff,
				ua: (ua || "").slice(0, 120),
				err: body,
			})
		);

		res.set("x-request-id", reqId);
		if (debugId) res.set("x-paypal-debug-id", debugId);

		return res
			.status(503)
			.json({
				error: "PayPal temporarily unreachable. Try again.",
				reqId,
				debugId,
			});
	}
};

/**
 * 2) Create reservation & process PayPal (single call)
 * Flows:
 *   - Not Paid + NO card → send verification email (do NOT create reservation)
 *   - Not Paid + card (setup_token) → save vault + ledger → create reservation NOW (no verification)
 *   - Deposit Paid / Paid Online (mode: authorize|capture) → create reservation NOW
 */
exports.createReservationAndProcess = async (req, res) => {
	try {
		const body = req.body || {};
		const { sentFrom, payment, hotelId, customerDetails, convertedAmounts } =
			body;

		// Validate hotel
		const hotel = await HotelDetails.findOne({
			_id: hotelId,
			activateHotel: true,
			hotelPhotos: { $exists: true, $not: { $size: 0 } },
			"location.coordinates": { $ne: [0, 0] },
		});
		if (!hotel) {
			return res.status(400).json({
				message:
					"Error occurred, please contact Jannat Booking Customer Support In The Chat",
			});
		}
		const { owner } = await getHotelAndOwner(hotelId);
		const ownerEmail = owner?.email || null;

		// Employee or Paid Offline (no PayPal)
		if (
			sentFrom === "employee" ||
			String(payment).toLowerCase() === "paid offline"
		) {
			const confirmationNumber = await new Promise((resolve, reject) => {
				ensureUniqueNumber(Reservations, "confirmation_number", (err, unique) =>
					err ? reject(err) : resolve(unique)
				);
			});

			const saved = await buildAndSaveReservation({
				reqBody: { ...body, hotelName: hotel.hotelName },
				confirmationNumber,
			});

			const resvData = {
				...saved.toObject(),
				hotelName: hotel.hotelName,
				hotelAddress: hotel.hotelAddress,
				hotelCity: hotel.hotelCity,
				hotelPhone: hotel.phone,
			};

			await sendEmailWithInvoice(
				resvData,
				body?.customerDetails?.email,
				body.belongsTo
			);
			try {
				await waSendReservationConfirmation(saved);
			} catch (_) {}
			try {
				await waNotifyNewReservation(saved);
			} catch (_) {}

			return res
				.status(201)
				.json({ message: "Reservation created successfully", data: saved });
		}

		// Client path validation
		const { name, phone, email, passport, passportExpiry, nationality } =
			customerDetails || {};
		if (
			!name ||
			!phone ||
			!email ||
			!passport ||
			!passportExpiry ||
			!nationality
		) {
			return res
				.status(400)
				.json({ message: "Invalid customer details provided." });
		}

		const pp = body.paypal || {};
		const pmtLower = String(payment || "").toLowerCase();
		const wantAuthorize = String(pp.mode || "").toLowerCase() === "authorize";

		/* ── A) NOT PAID ───────────────────────────────────────────────────── */
		if (pmtLower === "not paid") {
			const hasCard = !!pp.setup_token; // guest added card in Card Fields (vault on server)

			// A1) Not paid and NO CARD → verification (do NOT create reservation)
			if (!hasCard) {
				// Stable confirmation number (carried into JWT)
				const confirmationNumber = await new Promise((resolve, reject) => {
					ensureUniqueNumber(
						Reservations,
						"confirmation_number",
						(err, unique) => (err ? reject(err) : resolve(unique))
					);
				});

				const tokenPayload = {
					sentFrom: "client",
					payment: "Not Paid",
					hotelId,
					hotelName: hotel.hotelName,
					belongsTo: body.belongsTo,
					customerDetails,
					checkin_date: body.checkin_date,
					checkout_date: body.checkout_date,
					days_of_residence: body.days_of_residence,
					total_rooms: body.total_rooms,
					total_guests: body.total_guests,
					adults: body.adults,
					children: body.children,
					total_amount: body.total_amount,
					booking_source: body.booking_source,
					pickedRoomsType: body.pickedRoomsType,
					convertedAmounts,
					paid_amount: 0,
					commission: 0,
					commissionPaid: false,
					confirmation_number: confirmationNumber,
				};

				const token = jwt.sign(tokenPayload, process.env.JWT_SECRET2, {
					expiresIn: "3d",
				});
				const verificationLinkEmail = `${process.env.CLIENT_URL}/reservation-verification?token=${token}`;
				const verificationLinkWA = `${process.env.CLIENT_URL}/reservation-verification`; // short link for WA

				const emailContent = ReservationVerificationEmail({
					name,
					hotelName: hotel.hotelName,
					confirmationLink: verificationLinkEmail,
				});
				await sgMail.send({
					to: email,
					from: "noreply@jannatbooking.com",
					subject: "Verify Your Reservation",
					html: emailContent,
					bcc: [
						"morazzakhamouda@gmail.com",
						"xhoteleg@gmail.com",
						"ahmed.abdelrazak@jannatbooking.com",
					],
				});

				if (ownerEmail) {
					await sendCriticalOwnerEmail(
						ownerEmail,
						`Reservation Verification Initiated — ${hotel.hotelName}`,
						emailContent
					);
				}
				try {
					await waSendVerificationLink(
						{ customer_details: { name, phone, nationality } },
						verificationLinkWA
					);
				} catch (_) {}

				return res.status(200).json({
					message:
						"Verification email sent successfully. Please check your inbox.",
					confirmation_number: confirmationNumber,
				});
			}

			// A2) Not paid but CARD PRESENT → exchange to vault, set ledger, create reservation NOW
			let persist = {};
			try {
				const tokenData = await paypalExchangeSetupToVault(pp.setup_token);
				persist.vault_id = tokenData.id;
				persist.vault_status = tokenData.status || "ACTIVE";
				persist.vaulted_at = new Date(tokenData.create_time || Date.now());
				persist.card_brand = tokenData.payment_source?.card?.brand || null;
				persist.card_last4 =
					tokenData.payment_source?.card?.last_digits || null;
				persist.card_exp = tokenData.payment_source?.card?.expiry || null;
				persist.billing_address =
					tokenData.payment_source?.card?.billing_address || undefined;
			} catch (e) {
				console.error("Vault exchange failed:", e?.response?.data || e);
				return res
					.status(400)
					.json({ message: "Unable to save card with PayPal." });
			}

			if (convertedAmounts?.totalUSD) {
				persist.bounds = {
					base: "USD",
					limit_usd: toNum2(convertedAmounts.totalUSD),
				};
				persist.captured_total_usd = 0;
				persist.pending_total_usd = 0;
			}

			// (Optional) precheck small auth+void — fail with 402 and DO NOT create reservation
			if (pp.precheck?.do && pp.precheck?.amountUSD && persist.vault_id) {
				const confirmationNumber = await new Promise((resolve, reject) => {
					ensureUniqueNumber(
						Reservations,
						"confirmation_number",
						(err, unique) => (err ? reject(err) : resolve(unique))
					);
				});
				const meta = {
					invoice_id: `RSV-${confirmationNumber}`,
					custom_id: confirmationNumber,
					description: `Hotel reservation precheck — ${hotel.hotelName} — ${body.checkin_date} → ${body.checkout_date} — Guest ${name} (${phone})`,
					hotelName: hotel.hotelName,
					guestName: name,
					guestPhone: phone,
					checkin: body.checkin_date,
					checkout: body.checkout_date,
					usdAmount: pp.precheck.amountUSD,
				};
				try {
					await paypalPrecheckAuthorizeVoid({
						usdAmount: pp.precheck.amountUSD,
						vault_id: persist.vault_id,
						meta,
						cmid: pp.cmid,
					});
				} catch (e) {
					console.error("Precheck auth+void failed:", e?.response?.data || e);
					return res.status(402).json({
						message: "Card verification failed for the requested amount.",
					});
				}
			}

			const confirmationNumber = await new Promise((resolve, reject) => {
				ensureUniqueNumber(Reservations, "confirmation_number", (err, unique) =>
					err ? reject(err) : resolve(unique)
				);
			});

			const user = await findOrCreateUserByEmail(customerDetails, body.userId);
			if (user) {
				user.confirmationNumbersBooked = user.confirmationNumbersBooked || [];
				user.confirmationNumbersBooked.push(confirmationNumber);
				await user.save();
			}

			const saved = await buildAndSaveReservation({
				reqBody: { ...body, hotelName: hotel.hotelName, payment: "Not Paid" },
				confirmationNumber,
				paypalDetailsToPersist: persist,
				paymentDetailsPatch: { captured: false, chargeCount: 0 },
			});

			const resvData = {
				...saved.toObject(),
				hotelName: hotel.hotelName,
				hotelAddress: hotel.hotelAddress,
				hotelCity: hotel.hotelCity,
				hotelPhone: hotel.phone,
			};
			await sendEmailWithInvoice(
				resvData,
				customerDetails.email,
				body.belongsTo
			);
			try {
				await waSendReservationConfirmation(saved);
			} catch (_) {}
			try {
				await waNotifyNewReservation(saved);
			} catch (_) {}

			return res
				.status(201)
				.json({ message: "Reservation created successfully", data: saved });
		}

		/* ── B) DEPOSIT / FULL (authorize or capture) ───────────────────── */
		if (["deposit paid", "paid online"].includes(pmtLower)) {
			if (!pp.order_id) {
				return res.status(400).json({
					message:
						"Missing approved PayPal order_id. Create/approve the order on the client, then call this endpoint.",
				});
			}

			const confirmationNumber = await new Promise((resolve, reject) => {
				ensureUniqueNumber(Reservations, "confirmation_number", (err, unique) =>
					err ? reject(err) : resolve(unique)
				);
			});

			const expectedUsdAmount =
				pmtLower === "deposit paid"
					? toCCY(body?.convertedAmounts?.depositUSD || 0)
					: toCCY(body?.convertedAmounts?.totalUSD || 0);

			if (
				pp.expectedUsdAmount &&
				toCCY(pp.expectedUsdAmount) !== expectedUsdAmount
			) {
				return res.status(400).json({
					message:
						"Mismatch between expectedUsdAmount and convertedAmounts supplied by the frontend.",
				});
			}

			const meta = {
				invoice_id: `RSV-${confirmationNumber}`,
				custom_id: confirmationNumber,
				description: `Hotel reservation — ${hotel.hotelName} — ${body.checkin_date} → ${body.checkout_date} — Guest ${name} (${phone})`,
				hotelName: hotel.hotelName,
				guestName: name,
				guestPhone: phone,
				checkin: body.checkin_date,
				checkout: body.checkout_date,
				usdAmount: expectedUsdAmount,
			};

			// Verify order amount (GET)
			const getRes = await ax.get(`${PPM}/v2/checkout/orders/${pp.order_id}`, {
				auth: { username: clientId, password: secretKey },
			});
			const order = getRes.data;
			const pu = order?.purchase_units?.[0];
			const orderAmount = pu?.amount?.value;
			if (toCCY(orderAmount) !== expectedUsdAmount) {
				return res.status(400).json({
					message: `The PayPal order amount (${orderAmount}) does not match the expected amount (${expectedUsdAmount}).`,
				});
			}

			// Metadata patch (invoice/custom/description)
			try {
				await paypalPatchOrderMetadata(pp.order_id, meta);
			} catch (e) {
				console.warn("PATCH metadata:", e?.response?.data || e);
			}

			let paypalDetails = null;

			if (wantAuthorize) {
				// ─────────────────────── AUTHORIZE now (no funds captured)
				let authResult;
				try {
					const authReq = new paypal.orders.OrdersAuthorizeRequest(pp.order_id);
					if (pp.cmid) authReq.headers["PayPal-Client-Metadata-Id"] = pp.cmid;
					authReq.headers["PayPal-Request-Id"] = `auth-${uuid()}`;
					authReq.requestBody({});
					const { result } = await ppClient.execute(authReq);
					authResult = result;
				} catch (err) {
					const raw = err?._originalError?.text || err?.message || "";
					const alreadyAuth =
						err?.statusCode === 422 &&
						(/ORDER_ALREADY_AUTHORIZED/i.test(raw) ||
							/UNPROCESSABLE_ENTITY/i.test(raw));

					// If it isn't "already authorized", treat as real failure.
					if (!alreadyAuth) {
						const deniedLike =
							err?.statusCode === 422 &&
							(/AUTHORIZATION_DENIED|INSTRUMENT_DECLINED|DECLINED/i.test(raw) ||
								(Array.isArray(err?.response?.data?.details) &&
									err.response.data.details.some((d) =>
										/DENIED|DECLINED/i.test(String(d?.issue || ""))
									)));
						return res.status(deniedLike ? 402 : 500).json({
							message: deniedLike
								? "Card authorization was declined by issuer."
								: "Failed to authorize payment.",
						});
					}

					// Fetch the order state if PayPal says it's already authorized
					const getReq = new paypal.orders.OrdersGetRequest(pp.order_id);
					if (pp.cmid) getReq.headers["PayPal-Client-Metadata-Id"] = pp.cmid;
					const { result } = await ppClient.execute(getReq);
					authResult = result;
				}

				const auth =
					authResult?.purchase_units?.[0]?.payments?.authorizations?.[0] || {};
				const authStatus = String(auth?.status || "").toUpperCase();

				// **HARD GUARD**: if auth isn't OK (DENIED/VOIDED/etc), DO NOT create a reservation.
				if (!auth?.id || !isAuthStatusOk(authStatus)) {
					return res.status(402).json({
						message: `Card authorization ${
							authStatus || "FAILED"
						}. Reservation was not created. Please try a different card or pay via link.`,
						details: { status: auth?.status || null, id: auth?.id || null },
					});
				}

				const srcCard = authResult?.payment_source?.card || {};
				const vaultId =
					authResult?.payment_source?.card?.attributes?.vault?.id || null;

				paypalDetails = {
					bounds: {
						base: "USD",
						limit_usd: toNum2(
							body?.convertedAmounts?.totalUSD || auth?.amount?.value || 0
						),
					},
					captured_total_usd: 0,
					pending_total_usd: 0,
					initial: {
						intent: "AUTHORIZE",
						order_id: authResult.id,
						authorization_id: auth.id,
						authorization_status: auth.status,
						amount: auth?.amount?.value,
						currency: auth?.amount?.currency_code,
						expiration_time: auth?.expiration_time || null,
						network_transaction_reference:
							auth?.network_transaction_reference || null,
						invoice_id: meta.invoice_id,
						cmid: pp.cmid || null,
						raw: JSON.parse(JSON.stringify(authResult)),
					},
				};
				if (vaultId) {
					paypalDetails.vault_id = vaultId;
					paypalDetails.vault_status = "ACTIVE";
					paypalDetails.vaulted_at = new Date();
					paypalDetails.card_brand = srcCard.brand || null;
					paypalDetails.card_last4 = srcCard.last_digits || null;
					paypalDetails.card_exp = srcCard.expiry || null;
					if (srcCard.billing_address)
						paypalDetails.billing_address = srcCard.billing_address;
				}

				// Create user + reservation ONLY AFTER a good auth
				const user = await findOrCreateUserByEmail(
					customerDetails,
					body.userId
				);
				if (user) {
					user.confirmationNumbersBooked = user.confirmationNumbersBooked || [];
					user.confirmationNumbersBooked.push(confirmationNumber);
					await user.save();
				}

				const saved = await buildAndSaveReservation({
					reqBody: { ...body, hotelName: hotel.hotelName },
					confirmationNumber,
					paypalDetailsToPersist: paypalDetails,
					paymentDetailsPatch: {
						captured: false,
						authorizationId: auth.id,
						authorizationAmountUSD: toNum2(auth?.amount?.value || 0),
						chargeCount: 0,
					},
				});

				const resvData = {
					...saved.toObject(),
					hotelName: hotel.hotelName,
					hotelAddress: hotel.hotelAddress,
					hotelCity: hotel.hotelCity,
					hotelPhone: hotel.phone,
				};
				await sendEmailWithInvoice(
					resvData,
					customerDetails.email,
					body.belongsTo
				);
				try {
					await waSendReservationConfirmation(saved);
				} catch (_) {}
				try {
					await waNotifyNewReservation(saved);
				} catch (_) {}

				return res.status(201).json({
					message:
						"Reservation created successfully (authorized; no funds captured).",
					data: saved,
				});
			}

			// ─────────────────────── CAPTURE now (deposit/full)
			const result = await paypalCaptureApprovedOrder({
				orderId: pp.order_id,
				cmid: pp.cmid,
				reqId: `cap-create-${uuid()}`,
			});
			const cap = result?.purchase_units?.[0]?.payments?.captures?.[0] || {};
			if (cap?.status !== "COMPLETED") {
				return res
					.status(402)
					.json({ message: "Payment was not completed.", details: cap });
			}

			const vaultId =
				result?.payment_source?.card?.attributes?.vault?.id || null;
			const capAmount = toNum2(cap?.amount?.value || expectedUsdAmount);

			paypalDetails = {
				bounds: {
					base: "USD",
					limit_usd: toNum2(body?.convertedAmounts?.totalUSD || capAmount),
				},
				captured_total_usd: capAmount,
				pending_total_usd: 0,
				initial: {
					order_id: result.id,
					capture_id: cap.id,
					capture_status: cap.status,
					amount: cap.amount?.value,
					currency: cap.amount?.currency_code,
					seller_protection: cap?.seller_protection?.status || "UNKNOWN",
					network_transaction_reference:
						cap?.network_transaction_reference || null,
					cmid: pp.cmid || null,
					raw: safeClone(result),
					created_at: new Date(cap?.create_time || Date.now()),
				},
			};
			if (vaultId) {
				paypalDetails.vault_id = vaultId;
				paypalDetails.vault_status = "ACTIVE";
				paypalDetails.vaulted_at = new Date();
				paypalDetails.card_brand = result?.payment_source?.card?.brand || null;
				paypalDetails.card_last4 =
					result?.payment_source?.card?.last_digits || null;
				paypalDetails.card_exp = result?.payment_source?.card?.expiry || null;
				paypalDetails.billing_address =
					result?.payment_source?.card?.billing_address || undefined;
			}

			const user = await findOrCreateUserByEmail(customerDetails, body.userId);
			if (user) {
				user.confirmationNumbersBooked = user.confirmationNumbersBooked || [];
				user.confirmationNumbersBooked.push(confirmationNumber);
				await user.save();
			}

			const paymentDetailsPatch = {
				captured: true,
				triggeredAmountUSD: toNum2(capAmount),
				triggeredAmountSAR: toNum2(body.paid_amount || 0),
				finalCaptureTransactionId: cap.id,
				chargeCount: 1,
			};

			const saved = await buildAndSaveReservation({
				reqBody: { ...body, hotelName: hotel.hotelName },
				confirmationNumber,
				paypalDetailsToPersist: paypalDetails,
				paymentDetailsPatch,
			});

			const resvData = {
				...saved.toObject(),
				hotelName: hotel.hotelName,
				hotelAddress: hotel.hotelAddress,
				hotelCity: hotel.hotelCity,
				hotelPhone: hotel.phone,
			};
			await sendEmailWithInvoice(
				resvData,
				customerDetails.email,
				body.belongsTo
			);
			try {
				await waSendReservationConfirmation(saved);
			} catch (_) {}
			try {
				await waNotifyNewReservation(saved);
			} catch (_) {}

			return res
				.status(201)
				.json({ message: "Reservation created successfully", data: saved });
		}

		return res.status(400).json({
			message:
				"Unsupported flow. Use Not Paid / Deposit Paid / Paid Online / Paid Offline, or sentFrom=employee.",
		});
	} catch (error) {
		console.error(
			"createReservationAndProcess error:",
			error?.response?.data || error
		);
		return res.status(500).json({
			message: "Failed to create reservation.",
			error: String(error?.message || error),
		});
	}
};

/**
 * 3) MIT (post‑stay) charge using saved vault token — with hard cap
 * Body: { reservationId, usdAmount, cmid?, sarAmount? }
 */
exports.mitChargeReservation = async (req, res) => {
	try {
		const { reservationId, usdAmount, cmid, sarAmount } = req.body || {};
		const amt = Math.round(Number(usdAmount || 0) * 100) / 100;
		if (!reservationId || !amt || amt <= 0) {
			return res.status(400).json({
				message: "reservationId and a positive usdAmount are required.",
			});
		}

		const r = await Reservations.findById(reservationId).populate("hotelId");
		if (!r) return res.status(404).json({ message: "Reservation not found." });

		const limit = r?.paypal_details?.bounds?.limit_usd;
		const capturedSoFar = Number(r?.paypal_details?.captured_total_usd || 0);
		const pendingSoFar = Number(r?.paypal_details?.pending_total_usd || 0);

		if (typeof limit !== "number" || limit <= 0) {
			return res
				.status(400)
				.json({ message: "Capture limit is missing on this reservation." });
		}

		const remainingUsd =
			Math.round((limit - capturedSoFar - pendingSoFar) * 100) / 100;
		if (amt > remainingUsd + 1e-9) {
			return res.status(400).json({
				message: `Capture exceeds remaining balance. Remaining USD: ${remainingUsd.toFixed(
					2
				)}`,
			});
		}

		// Decide the path BEFORE we reserve "pending"
		const authId = r?.paypal_details?.initial?.authorization_id || null;
		const authAmt = Number(r?.paypal_details?.initial?.amount || 0);
		const authStatus = String(
			r?.paypal_details?.initial?.authorization_status || ""
		).toUpperCase();
		const vault_id = r?.paypal_details?.vault_id || null;

		const AUTH_OK_STATUSES = new Set([
			"CREATED",
			"AUTHORIZED",
			"PENDING",
			"PARTIALLY_CAPTURED",
		]);
		let path = null;

		if (authId && authAmt > 0 && AUTH_OK_STATUSES.has(authStatus)) {
			const remainingAuth = Math.max(0, authAmt - capturedSoFar);
			if (amt <= remainingAuth + 1e-9) path = "AUTH_CAPTURE";
		}

		if (!path && vault_id) path = "MIT";

		if (!path) {
			const why =
				authId && authStatus === "DENIED"
					? "The original authorization was DENIED by the card issuer"
					: "No valid authorization to capture and no saved PayPal vault token";
			return res.status(400).json({
				message: `${why}. Ask the guest to pay via link (new PayPal order) or add a card (vault) and try again.`,
			});
		}

		// Reserve pending only now that we know a path exists
		const reserved = await reservePendingCaptureUSD({
			reservationId,
			usdAmount: amt,
		});
		if (!reserved) {
			const stillRemaining = (
				limit -
				(capturedSoFar + (r?.paypal_details?.pending_total_usd || 0))
			).toFixed(2);
			return res.status(400).json({
				message: `Capture exceeds remaining balance. Remaining USD: ${stillRemaining}`,
			});
		}

		// Build meta once
		const confirmation = r.confirmation_number;
		const meta = {
			invoice_id: `RSV-${confirmation}-${Date.now()}`,
			custom_id: confirmation,
			description: `Post‑stay charge — ${
				r.hotelName || r.hotelId?.hotelName || "Hotel"
			} — ${r.checkin_date} → ${r.checkout_date} — Guest ${
				r.customer_details?.name
			} (${r.customer_details?.phone || ""})`,
			hotelName: r.hotelName || r.hotelId?.hotelName || "Hotel",
			guestName: r.customer_details?.name || "Guest",
			guestPhone: r.customer_details?.phone || "",
			checkin: r.checkin_date,
			checkout: r.checkout_date,
			usdAmount: amt,
		};

		const PPM2 = IS_PROD
			? "https://api-m.paypal.com"
			: "https://api-m.sandbox.paypal.com";
		const clientId2 = IS_PROD
			? process.env.PAYPAL_CLIENT_ID_LIVE
			: process.env.PAYPAL_CLIENT_ID_SANDBOX;
		const secretKey2 = IS_PROD
			? process.env.PAYPAL_SECRET_KEY_LIVE
			: process.env.PAYPAL_SECRET_KEY_SANDBOX;

		let resultCapture = null;

		if (path === "AUTH_CAPTURE") {
			try {
				const remainingAuth = Math.max(0, authAmt - capturedSoFar);
				const final_capture = Math.abs(amt - remainingAuth) < 1e-9;
				const body = {
					amount: { currency_code: "USD", value: amt.toFixed(2) },
					invoice_id: meta.invoice_id,
					final_capture,
				};
				const idemKey = `authcap:${reservationId}:${amt.toFixed(
					2
				)}:${confirmation}`;
				const { data } = await ax.post(
					`${PPM2}/v2/payments/authorizations/${authId}/capture`,
					body,
					{
						auth: { username: clientId2, password: secretKey2 },
						headers: { "PayPal-Request-Id": idemKey },
					}
				);
				resultCapture = {
					purchase_units: [
						{
							payments: {
								captures: [
									{
										id: data?.id,
										status: data?.status,
										amount: data?.amount,
										seller_protection: data?.seller_protection,
										network_transaction_reference:
											data?.network_transaction_reference,
										create_time: data?.create_time,
									},
								],
							},
						},
					],
					id: data?.supplementary_data?.related_ids?.order_id || null,
					_via: "AUTH_CAPTURE",
				};
			} catch (capAuthErr) {
				// Common cases: AUTHORIZATION_DENIED, AUTHORIZATION_VOIDED, AMOUNT_EXCEEDS_AUTHORIZED_AMOUNT
				console.warn(
					"Authorization capture failed; will attempt MIT fallback if possible.",
					capAuthErr?.response?.data || capAuthErr
				);
				resultCapture = null;
				// No implicit switch to MIT unless we have a vault
				if (!vault_id) {
					await finalizePendingCaptureUSD({
						reservationId,
						usdAmount: amt,
						success: false,
					});
					const code = capAuthErr?.response?.data?.details?.[0]?.issue;
					return res.status(402).json({
						message: `Authorization capture failed${
							code ? ` (${code})` : ""
						}. Use link-pay or save a card to vault and retry.`,
					});
				}
				path = "MIT"; // fallback only if vault exists
			}
		}

		if (!resultCapture && path === "MIT") {
			const previousCaptureId = r?.paypal_details?.initial?.capture_id || null;
			const mitRes = await paypalMitCharge({
				usdAmount: amt,
				vault_id,
				meta,
				cmid,
				previousCaptureId,
			});
			resultCapture = { ...mitRes, _via: "MIT" };
		}

		const cap =
			resultCapture?.purchase_units?.[0]?.payments?.captures?.[0] || {};
		if (cap?.status !== "COMPLETED") {
			await finalizePendingCaptureUSD({
				reservationId,
				usdAmount: amt,
				success: false,
			});
			return res.status(402).json({
				message: "Charge not completed.",
				details: cap,
				path: resultCapture?._via || "UNKNOWN",
			});
		}

		const capturedUsd =
			Math.round(Number(cap?.amount?.value || amt) * 100) / 100;

		const mitCaptureDoc = {
			order_id: resultCapture.id || null,
			capture_id: cap.id,
			capture_status: cap.status,
			amount: cap?.amount?.value || null,
			currency: cap?.amount?.currency_code || null,
			seller_protection: cap?.seller_protection?.status || "UNKNOWN",
			network_transaction_reference: cap?.network_transaction_reference || null,
			created_at: new Date(cap?.create_time || Date.now()),
			raw: JSON.parse(JSON.stringify(resultCapture)),
			via: resultCapture?._via || "UNKNOWN",
		};

		let updated = await finalizePendingCaptureUSD({
			reservationId,
			usdAmount: capturedUsd,
			success: true,
			captureDoc: mitCaptureDoc,
		});

		const sarInc = Number.isFinite(Number(sarAmount))
			? Math.round(Number(sarAmount) * 100) / 100
			: 0;
		const setOps = {
			"payment_details.finalCaptureTransactionId": cap.id,
			// finalizePendingCaptureUSD set captured=true, triggeredAmountUSD=capturedUsd, chargeCount+1
			...(sarInc > 0 ? { "payment_details.triggeredAmountSAR": sarInc } : {}),
		};

		updated = await Reservations.findByIdAndUpdate(
			reservationId,
			{
				...(sarInc > 0 ? { $inc: { paid_amount: sarInc } } : {}),
				$set: setOps,
			},
			{ new: true }
		).populate("hotelId");

		try {
			await sgMail.send({
				to: updated.customer_details.email,
				from: "noreply@jannatbooking.com",
				subject: "Payment Confirmation - Jannat Booking",
				html: paymentTriggered(updated),
			});
			await sgMail.send({
				to: [
					{ email: "morazzakhamouda@gmail.com" },
					{ email: "xhoteleg@gmail.com" },
					{ email: "ahmed.abdelrazak@jannatbooking.com" },
				],
				from: "noreply@jannatbooking.com",
				subject: "Payment Confirmation - Jannat Booking",
				html: paymentTriggered(updated),
			});
		} catch (_) {}

		return res.status(200).json({
			message:
				resultCapture?._via === "AUTH_CAPTURE"
					? "Authorization captured."
					: "MIT charge completed.",
			transactionId: cap.id,
			reservation: updated,
			path: resultCapture?._via,
		});
	} catch (error) {
		console.error(
			"mitChargeReservation error:",
			error?.response?.data || error
		);
		return res
			.status(500)
			.json({ message: "Failed to capture post‑stay payment." });
	}
};

/**
 * 4) Standalone credit precheck (auth+void)
 */
exports.creditPrecheck = async (req, res) => {
	try {
		const {
			setup_token,
			vault_id: maybeVault,
			usdAmount,
			hotelId,
			guestName,
			guestPhone,
			checkin_date,
			checkout_date,
			cmid,
		} = req.body || {};

		if (
			!usdAmount ||
			!hotelId ||
			!guestName ||
			!checkin_date ||
			!checkout_date
		) {
			return res.status(400).json({
				message:
					"usdAmount, hotelId, guestName, checkin_date, checkout_date are required.",
			});
		}

		const hotel = await HotelDetails.findById(hotelId);
		if (!hotel) return res.status(404).json({ message: "Hotel not found." });

		let vault_id = maybeVault;
		if (!vault_id && setup_token) {
			const tokenData = await paypalExchangeSetupToVault(setup_token);
			vault_id = tokenData.id;
		}
		if (!vault_id) {
			return res
				.status(400)
				.json({ message: "A setup_token or vault_id is required." });
		}

		const confirmationNumber = await new Promise((resolve, reject) => {
			ensureUniqueNumber(Reservations, "confirmation_number", (err, unique) =>
				err ? reject(err) : resolve(unique)
			);
		});

		const meta = {
			invoice_id: `RSV-${confirmationNumber}`,
			custom_id: confirmationNumber,
			description: `Hotel reservation precheck — ${
				hotel.hotelName
			} — ${checkin_date} → ${checkout_date} — Guest ${guestName} (${
				guestPhone || ""
			})`,
			hotelName: hotel.hotelName,
			guestName,
			guestPhone: guestPhone || "",
			checkin: checkin_date,
			checkout: checkout_date,
			usdAmount,
		};

		await paypalPrecheckAuthorizeVoid({ usdAmount, vault_id, meta, cmid });

		return res.status(200).json({ ok: true, message: "Credit precheck OK." });
	} catch (error) {
		console.error("creditPrecheck error:", error?.response?.data || error);
		return res
			.status(402)
			.json({ ok: false, message: "Credit precheck failed." });
	}
};

/**
 * 5) Exchange setup_token → vault token
 */
exports.vaultExchange = async (req, res) => {
	try {
		const { setup_token } = req.body || {};
		if (!setup_token)
			return res.status(400).json({ message: "setup_token is required." });
		const data = await paypalExchangeSetupToVault(setup_token);
		return res.status(200).json({ vault: data });
	} catch (error) {
		console.error("vaultExchange error:", error?.response?.data || error);
		return res.status(500).json({ message: "Failed to save card." });
	}
};

/**
 * 6) Update capture limit (when stay changes)
 */
exports.updateCaptureLimit = async (req, res) => {
	try {
		const { reservationId, newLimitUsd } = req.body || {};
		const newLimit = toNum2(newLimitUsd);
		if (!reservationId || !newLimit || newLimit <= 0) {
			return res.status(400).json({
				message: "reservationId and positive newLimitUsd are required.",
			});
		}

		const r = await Reservations.findById(reservationId);
		if (!r) return res.status(404).json({ message: "Reservation not found." });

		const captured = r?.paypal_details?.captured_total_usd || 0;
		if (newLimit < captured) {
			return res.status(400).json({
				message: `New limit (${toCCY(
					newLimit
				)}) is below captured total (${toCCY(captured)}).`,
			});
		}

		const historyEntry = {
			at: new Date(),
			old: r?.paypal_details?.bounds?.limit_usd || null,
			new: newLimit,
		};

		const updated = await Reservations.findByIdAndUpdate(
			reservationId,
			{
				$set: {
					"paypal_details.bounds.base": "USD",
					"paypal_details.bounds.limit_usd": newLimit,
				},
				$push: { "paypal_details.bounds_history": historyEntry },
			},
			{ new: true }
		);

		return res.status(200).json({ ok: true, reservation: updated });
	} catch (error) {
		console.error("updateCaptureLimit error:", error?.response?.data || error);
		return res.status(500).json({ message: "Failed to update capture limit." });
	}
};

/**
 * 7) Inspect PayPal ledger for a reservation
 */
exports.getLedger = async (req, res) => {
	try {
		const { reservationId } = req.params;
		const r = await Reservations.findById(reservationId).lean();
		if (!r) return res.status(404).json({ message: "Reservation not found." });
		const pd = r.paypal_details || {};
		return res.status(200).json({
			confirmation_number: r.confirmation_number,
			bounds: pd.bounds || null,
			captured_total_usd: pd.captured_total_usd || 0,
			pending_total_usd: pd.pending_total_usd || 0,
			initial: pd.initial || null,
			mit_count: Array.isArray(pd.mit) ? pd.mit.length : 0,
			mit: pd.mit || [],
		});
	} catch (error) {
		console.error("getLedger error:", error);
		return res.status(500).json({ message: "Failed to fetch ledger." });
	}
};

/**
 * 8) Webhook handler (optional)
 */
exports.webhook = async (req, res) => {
	try {
		const { event_type: type, resource } = req.body || {};

		// Optional signature verification
		try {
			const webhookId = IS_PROD
				? process.env.PAYPAL_WEBHOOK_ID_LIVE
				: process.env.PAYPAL_WEBHOOK_ID_SANDBOX;
			if (webhookId) {
				const headers = req.headers || {};
				const verifyPayload = {
					transmission_id: headers["paypal-transmission-id"],
					transmission_time: headers["paypal-transmission-time"],
					cert_url: headers["paypal-cert-url"],
					auth_algo: headers["paypal-auth-algo"],
					transmission_sig: headers["paypal-transmission-sig"],
					webhook_id: webhookId,
					webhook_event: req.body,
				};

				const { data: verify } = await ax.post(
					`${PPM}/v1/notifications/verify-webhook-signature`,
					verifyPayload,
					{ auth: { username: clientId, password: secretKey } }
				);

				if (verify?.verification_status !== "SUCCESS") {
					console.warn("PayPal webhook verification failed:", verify);
				}
			} else {
				console.warn(
					"[PayPal] WEBHOOK_ID not configured; skipping signature verification."
				);
			}
		} catch (vErr) {
			console.error(
				"[PayPal] Webhook verification error:",
				vErr?.response?.data || vErr
			);
		}

		if (type === "PAYMENT.CAPTURE.COMPLETED") {
			const orderId = resource?.supplementary_data?.related_ids?.order_id;
			const captureId = resource?.id;
			console.log("Webhook CAPTURE completed:", { orderId, captureId });
			// optional: reconcile to ledger here
		}
		if (type === "VAULT.PAYMENT-TOKEN.CREATED") {
			console.log("Webhook vault token created:", resource?.id);
		}
		return res.json({ received: true });
	} catch (e) {
		console.error("Webhook error:", e);
		return res.status(500).json({ error: "Webhook failed" });
	}
};

/**
 * 9) Link‑pay (authorize or capture) against existing reservation
 * Body: { reservationKey, option: "deposit" | "full", convertedAmounts, sarAmount?, paypal: { order_id, expectedUsdAmount, cmid?, mode?: "authorize"|"capture" } }
 */
exports.linkPayReservation = async (req, res) => {
	const buildUniqueInvoiceId = (confNumber, existingCount) => {
		const seq = (existingCount || 0) + 1;
		const tail = Date.now().toString(36).slice(-6).toUpperCase();
		return `RSV-${confNumber}-${seq}-${tail}`.slice(0, 127);
	};

	async function patchOrderInvoiceAndDescription({
		orderId,
		invoice_id,
		custom_id,
		description,
		auth,
	}) {
		const ops = [
			{
				op: "add",
				path: "/purchase_units/@reference_id=='default'/invoice_id",
				value: invoice_id,
			},
			{
				op: "add",
				path: "/purchase_units/@reference_id=='default'/custom_id",
				value: custom_id,
			},
			{
				op: "add",
				path: "/purchase_units/@reference_id=='default'/description",
				value: description,
			},
		];
		await ax.patch(`${auth.PPM}/v2/checkout/orders/${orderId}`, ops, {
			auth: { username: auth.clientId, password: auth.secretKey },
			headers: { "Content-Type": "application/json" },
		});
	}

	try {
		const {
			reservationKey,
			option,
			convertedAmounts,
			sarAmount,
			paypal: pp,
		} = req.body || {};

		if (!reservationKey || !option || !pp?.order_id || !pp?.expectedUsdAmount) {
			return res.status(400).json({ message: "Missing required fields." });
		}

		let reservation = null;
		if (mongoose.Types.ObjectId.isValid(reservationKey)) {
			reservation = await Reservations.findById(reservationKey).populate(
				"hotelId"
			);
		}
		if (!reservation) {
			reservation = await Reservations.findOne({
				confirmation_number: String(reservationKey),
			}).populate("hotelId");
		}
		if (!reservation)
			return res.status(404).json({ message: "Reservation not found." });

		const usdAmount =
			String(option).toLowerCase() === "deposit"
				? convertedAmounts?.depositUSD
				: convertedAmounts?.totalUSD;
		if (!usdAmount)
			return res.status(400).json({ message: "Converted USD amount missing." });

		const PPM2 = IS_PROD
			? "https://api-m.paypal.com"
			: "https://api-m.sandbox.paypal.com";
		const clientId2 = IS_PROD
			? process.env.PAYPAL_CLIENT_ID_LIVE
			: process.env.PAYPAL_CLIENT_ID_SANDBOX;
		const secretKey2 = IS_PROD
			? process.env.PAYPAL_SECRET_KEY_LIVE
			: process.env.PAYPAL_SECRET_KEY_SANDBOX;

		const getRes = await ax.get(`${PPM2}/v2/checkout/orders/${pp.order_id}`, {
			auth: { username: clientId2, password: secretKey2 },
		});
		const order = getRes.data;
		const pu = order?.purchase_units?.[0];
		const orderAmount = pu?.amount?.value;

		if (
			Number(orderAmount).toFixed(2) !== Number(pp.expectedUsdAmount).toFixed(2)
		) {
			return res.status(400).json({
				message: `PayPal order amount (${orderAmount}) does not match expected (${pp.expectedUsdAmount}).`,
			});
		}

		const hotelName =
			reservation.hotelName || reservation.hotelId?.hotelName || "Hotel";
		const guest = reservation.customer_details || {};
		const existingCount =
			(reservation?.paypal_details?.initial ? 1 : 0) +
			(Array.isArray(reservation?.paypal_details?.mit)
				? reservation.paypal_details.mit.length
				: 0);

		const uniqueInvoiceId = buildUniqueInvoiceId(
			reservation.confirmation_number,
			existingCount
		);
		const description = `Hotel reservation — ${hotelName} — ${
			reservation.checkin_date
		} → ${reservation.checkout_date} — Guest ${guest.name} (${
			guest.phone || ""
		})`;

		try {
			await patchOrderInvoiceAndDescription({
				orderId: pp.order_id,
				invoice_id: uniqueInvoiceId,
				custom_id: reservation.confirmation_number,
				description,
				auth: { PPM: PPM2, clientId: clientId2, secretKey: secretKey2 },
			});
		} catch (e) {
			console.warn(
				"PATCH metadata (non-fatal):",
				e?.response?.data || e?.message || e
			);
		}

		const mode = (pp.mode || "").toLowerCase();

		/* A) AUTHORIZE NOW */
		if (mode === "authorize") {
			let authResult;

			try {
				const authReq = new paypal.orders.OrdersAuthorizeRequest(pp.order_id);
				if (pp.cmid) authReq.headers["PayPal-Client-Metadata-Id"] = pp.cmid;
				authReq.headers["PayPal-Request-Id"] = `auth-${uuid()}`;
				authReq.requestBody({});
				const { result } = await ppClient.execute(authReq);
				authResult = result;
			} catch (err) {
				const raw = err?._originalError?.text || err?.message || "";
				const alreadyAuth =
					err?.statusCode === 422 &&
					(/ORDER_ALREADY_AUTHORIZED/i.test(raw) ||
						/UNPROCESSABLE_ENTITY/i.test(raw));
				if (!alreadyAuth) {
					console.error("Authorize error:", err?.response?.data || err);
					return res
						.status(500)
						.json({ message: "Failed to authorize payment." });
				}
				const getReq = new paypal.orders.OrdersGetRequest(pp.order_id);
				if (pp.cmid) getReq.headers["PayPal-Client-Metadata-Id"] = pp.cmid;
				const { result } = await ppClient.execute(getReq);
				authResult = result;
			}

			const auth =
				authResult?.purchase_units?.[0]?.payments?.authorizations?.[0] || {};
			if (!auth?.id) {
				return res.status(402).json({
					message: "Authorization was not created.",
					details: authResult,
				});
			}

			const srcCard = authResult?.payment_source?.card || {};
			const vaultId =
				authResult?.payment_source?.card?.attributes?.vault?.id ||
				reservation?.paypal_details?.vault_id ||
				null;

			const setOps = {
				"paypal_details.bounds.base": "USD",
				"paypal_details.bounds.limit_usd": toNum2(
					convertedAmounts?.totalUSD || usdAmount
				),
				"paypal_details.captured_total_usd":
					reservation?.paypal_details?.captured_total_usd || 0,
				"paypal_details.pending_total_usd":
					reservation?.paypal_details?.pending_total_usd || 0,
				"paypal_details.initial.intent": "AUTHORIZE",
				"paypal_details.initial.order_id": authResult.id,
				"paypal_details.initial.authorization_id": auth.id,
				"paypal_details.initial.authorization_status": auth.status,
				"paypal_details.initial.amount": auth?.amount?.value,
				"paypal_details.initial.currency": auth?.amount?.currency_code,
				"paypal_details.initial.expiration_time": auth?.expiration_time || null,
				"paypal_details.initial.network_transaction_reference":
					auth?.network_transaction_reference || null,
				"paypal_details.initial.invoice_id": uniqueInvoiceId,
				"paypal_details.initial.cmid": pp.cmid || null,
				"paypal_details.initial.raw": JSON.parse(JSON.stringify(authResult)),
				"payment_details.captured": false,
				"payment_details.authorizationId": auth.id,
				"payment_details.authorizationAmountUSD": toNum2(
					auth?.amount?.value || 0
				),
			};

			if (vaultId) {
				setOps["paypal_details.vault_id"] = vaultId;
				setOps["paypal_details.vault_status"] = "ACTIVE";
				setOps["paypal_details.vaulted_at"] = new Date();
				setOps["paypal_details.card_brand"] =
					srcCard.brand || reservation?.paypal_details?.card_brand || null;
				setOps["paypal_details.card_last4"] =
					srcCard.last_digits ||
					reservation?.paypal_details?.card_last4 ||
					null;
				setOps["paypal_details.card_exp"] =
					srcCard.expiry || reservation?.paypal_details?.card_exp || null;
				if (srcCard.billing_address)
					setOps["paypal_details.billing_address"] = srcCard.billing_address;
			}

			const updated = await Reservations.findByIdAndUpdate(
				reservation._id,
				{ $set: setOps },
				{ new: true }
			).populate("hotelId");

			return res.status(200).json({
				message: "Payment authorized (no funds captured).",
				reservation: updated,
				authorizationId: auth.id,
			});
		}

		/* B) CAPTURE NOW */
		const limit =
			reservation?.paypal_details?.bounds?.limit_usd ??
			(convertedAmounts?.totalUSD ? toNum2(convertedAmounts.totalUSD) : null);

		if (!limit || limit <= 0) {
			return res
				.status(400)
				.json({ message: "Reservation capture limit is not set." });
		}

		const capturedSoFar = toNum2(
			reservation?.paypal_details?.captured_total_usd || 0
		);
		const newCapture = toNum2(usdAmount);

		if (capturedSoFar + newCapture > limit + 1e-9) {
			const remaining = (limit - capturedSoFar).toFixed(2);
			return res.status(400).json({
				message: `Capture exceeds remaining balance. Remaining USD: ${remaining}`,
			});
		}

		const pendingReserved = await reservePendingCaptureUSD({
			reservationId: reservation._id,
			usdAmount: newCapture,
		});
		if (!pendingReserved) {
			const remaining = (
				limit -
				(capturedSoFar + (reservation?.paypal_details?.pending_total_usd || 0))
			).toFixed(2);
			return res.status(400).json({
				message: `Capture exceeds remaining balance. Remaining USD: ${remaining}`,
			});
		}

		const reqId = `link-cap-${uuid()}`;
		async function tryCaptureOnce() {
			return paypalCaptureApprovedOrder({
				orderId: pp.order_id,
				cmid: pp.cmid,
				reqId,
			});
		}

		let capResult;
		try {
			capResult = await tryCaptureOnce();
		} catch (err) {
			const raw = err?._originalError?.text || err?.message || "";
			const isDupInv =
				err?.statusCode === 422 && /DUPLICATE_INVOICE_ID/i.test(raw);
			if (!isDupInv) {
				await finalizePendingCaptureUSD({
					reservationId: reservation._id,
					usdAmount: newCapture,
					success: false,
				});
				throw err;
			}
			const freshInvoiceId = buildUniqueInvoiceId(
				reservation.confirmation_number,
				existingCount + 1
			);
			try {
				await patchOrderInvoiceAndDescription({
					orderId: pp.order_id,
					invoice_id: freshInvoiceId,
					custom_id: reservation.confirmation_number,
					description,
					auth: { PPM: PPM2, clientId: clientId2, secretKey: secretKey2 },
				});
			} catch (_) {}
			capResult = await tryCaptureOnce();
		}

		const cap = capResult?.purchase_units?.[0]?.payments?.captures?.[0] || {};
		if (cap?.status !== "COMPLETED") {
			await finalizePendingCaptureUSD({
				reservationId: reservation._id,
				usdAmount: newCapture,
				success: false,
			});
			return res
				.status(402)
				.json({ message: "Payment was not completed.", details: cap });
		}

		const capAmount = toNum2(cap?.amount?.value || newCapture);

		const commonCaptureDoc = {
			order_id: capResult.id,
			capture_id: cap.id,
			capture_status: cap.status,
			amount: cap.amount?.value,
			currency: cap.amount?.currency_code,
			seller_protection: cap?.seller_protection?.status || "UNKNOWN",
			network_transaction_reference: cap?.network_transaction_reference || null,
			cmid: pp.cmid || null,
			invoice_id: uniqueInvoiceId,
			raw: JSON.parse(JSON.stringify(capResult)),
			created_at: new Date(cap?.create_time || Date.now()),
		};

		let updated = await finalizePendingCaptureUSD({
			reservationId: reservation._id,
			usdAmount: capAmount,
			success: true,
			captureDoc: commonCaptureDoc,
		});

		if (sarAmount) {
			updated = await Reservations.findByIdAndUpdate(
				reservation._id,
				{ $inc: { paid_amount: Math.round(Number(sarAmount) * 100) / 100 } },
				{ new: true }
			).populate("hotelId");
		}

		const newCapturedTotal = toNum2(
			updated?.paypal_details?.captured_total_usd || 0
		);
		const fullyPaid = newCapturedTotal >= limit - 1e-9;

		const setOps2 = {
			"payment_details.captured": true,
			"payment_details.triggeredAmountUSD": toNum2(capAmount),
			"payment_details.finalCaptureTransactionId": cap.id,
			payment: fullyPaid ? "Paid Online" : "Deposit Paid",
			commissionPaid: true,
		};
		if (sarAmount)
			setOps2["payment_details.triggeredAmountSAR"] = toNum2(sarAmount);

		updated = await Reservations.findByIdAndUpdate(
			reservation._id,
			{ $set: setOps2, $inc: { "payment_details.chargeCount": 1 } },
			{ new: true }
		).populate("hotelId");

		try {
			const hotelDoc = updated.hotelId || {};
			const invoiceModel = {
				...updated.toObject(),
				hotelName: updated.hotelName || hotelDoc.hotelName || "Hotel",
				hotelAddress: hotelDoc.hotelAddress || "",
				hotelCity: hotelDoc.hotelCity || "",
				hotelPhone: hotelDoc.phone || "",
			};
			await sendEmailWithInvoice(
				invoiceModel,
				updated.customer_details?.email,
				updated.belongsTo
			);
			await waSendReservationConfirmation(updated);
			await waNotifyNewReservation(updated);
		} catch (_) {}

		return res.status(200).json({
			message: "Payment captured and reservation updated.",
			reservation: updated,
			transactionId: cap.id,
		});
	} catch (error) {
		console.error("linkPayReservation error:", error?.response?.data || error);
		return res.status(500).json({ message: "Failed to process link payment." });
	}
};

/**
 * 10) Helper to create PayPal orders (server)
 */
exports.createPayPalOrder = async (req, res) => {
	try {
		const body = req.body || {};
		let purchase_units = body.purchase_units;
		if (!Array.isArray(purchase_units)) {
			const amt = Number(body.usdAmount || 0);
			if (!amt)
				return res.status(400).json({ message: "usdAmount is required." });
			purchase_units = [
				{
					reference_id: "default",
					amount: { currency_code: "USD", value: Number(amt).toFixed(2) },
				},
			];
		}

		const request = new paypal.orders.OrdersCreateRequest();
		request.prefer("return=representation");
		request.requestBody({
			intent: body.intent || "CAPTURE",
			purchase_units,
			application_context: body.application_context || {
				user_action: "PAY_NOW",
				shipping_preference: "NO_SHIPPING",
				brand_name: "Jannat Booking",
			},
			...(body.payment_source ? { payment_source: body.payment_source } : {}),
		});

		const { result } = await ppClient.execute(request);
		return res.status(200).json({ id: result.id });
	} catch (e) {
		console.error("createPayPalOrder error:", e?.response?.data || e);
		return res.status(500).json({ message: "Failed to create PayPal order" });
	}
};

/**
 * 11) Verification endpoint (create reservation from email JWT)
 *  - Mirrors your janat.js duplicate checks
 */
exports.verifyReservationAndCreate = async (req, res) => {
	try {
		const token = req.body?.token || req.query?.token;
		if (!token) return res.status(400).json({ message: "Missing token." });

		let decoded;
		try {
			decoded = jwt.verify(token, process.env.JWT_SECRET2);
		} catch (e) {
			return res.status(400).json({ message: "Invalid or expired token." });
		}

		// Idempotency: if already created with this confirmation number, return it
		const existing = await Reservations.findOne({
			confirmation_number: decoded.confirmation_number,
		}).populate("hotelId");
		if (existing) {
			// Build FE-friendly data2 mirror (as some UIs expect data2)
			const exObj = existing.toObject();
			if (exObj.customer_details) delete exObj.customer_details.password;
			const data2 = { ...exObj, customerDetails: exObj.customer_details };
			delete data2.customer_details;
			return res.status(200).json({
				message: "Reservation already verified.",
				data: existing,
				data2,
			});
		}

		// ---- Duplicate checks (similar to janat.js) ----
		const reservationData = decoded;
		const checkinDate = new Date(reservationData.checkin_date);

		// Exact duplicate (same name/email/phone + same checkin_date)
		const exactDuplicate = await Reservations.findOne({
			"customer_details.name": reservationData.customerDetails.name,
			"customer_details.email": reservationData.customerDetails.email,
			"customer_details.phone": reservationData.customerDetails.phone,
			checkin_date: reservationData.checkin_date,
		});
		if (exactDuplicate) {
			return res.status(400).json({
				message:
					"It looks like we have duplicate reservations. Please contact customer service in the chat.",
			});
		}

		// Partial duplicate: same or next month window of check-in
		const startOfSameMonth = new Date(
			checkinDate.getFullYear(),
			checkinDate.getMonth(),
			1
		);
		const endOfNextMonth = new Date(
			checkinDate.getFullYear(),
			checkinDate.getMonth() + 2,
			0
		);
		const partialDuplicate = await Reservations.findOne({
			"customer_details.name": reservationData.customerDetails.name,
			"customer_details.email": reservationData.customerDetails.email,
			"customer_details.phone": reservationData.customerDetails.phone,
			checkin_date: { $gte: startOfSameMonth, $lt: endOfNextMonth },
		});
		if (partialDuplicate) {
			return res.status(400).json({
				message:
					"It looks like we have duplicate reservations. Please contact customer service in the chat.",
			});
		}

		// Duplicate by email/phone in last 30 days
		const today = new Date();
		const thirtyDaysAgo = new Date(today);
		thirtyDaysAgo.setDate(today.getDate() - 30);
		const duplicateByEmailOrPhone = await Reservations.findOne({
			$or: [
				{ "customer_details.email": reservationData.customerDetails.email },
				{ "customer_details.phone": reservationData.customerDetails.phone },
			],
			createdAt: { $gte: thirtyDaysAgo, $lte: today },
		});
		if (duplicateByEmailOrPhone) {
			return res.status(400).json({
				message:
					"A similar reservation has been made recently. Please contact customer service in the chat.",
			});
		}

		// Ensure confirmation number is unique (regenerate if necessary)
		let confirmationNumber = reservationData.confirmation_number;
		if (!confirmationNumber) {
			confirmationNumber = await new Promise((resolve, reject) => {
				ensureUniqueNumber(Reservations, "confirmation_number", (err, unique) =>
					err ? reject(err) : resolve(unique)
				);
			});
			reservationData.confirmation_number = confirmationNumber;
		} else {
			const existingReservation = await Reservations.findOne({
				confirmation_number: confirmationNumber,
			});
			if (existingReservation) {
				return res.status(400).json({
					message: "Reservation already exists. No further action required.",
				});
			}
		}

		// “Not Paid” verification path: do not include card data; set zeros
		reservationData.paymentDetails = {
			cardNumber: "",
			cardExpiryDate: "",
			cardCVV: "",
			cardHolderName: "",
		};
		reservationData.paid_amount = 0;
		reservationData.payment = "Not Paid";
		reservationData.commission = 0;
		reservationData.commissionPaid = false;

		// Persist reservation
		const saved = await buildAndSaveReservation({
			reqBody: { ...reservationData, paypal_details: undefined },
			confirmationNumber,
			paypalDetailsToPersist: reservationData.paypal_details, // normally undefined in “no card” verification
		});

		// Email + WA
		const hotel = await HotelDetails.findById(saved.hotelId).lean();
		const resvData = {
			...saved.toObject(),
			hotelName: saved.hotelName || hotel?.hotelName || "Hotel",
			hotelAddress: hotel?.hotelAddress || "",
			hotelCity: hotel?.hotelCity || "",
			hotelPhone: hotel?.phone || "",
		};
		await sendEmailWithInvoice(
			resvData,
			saved.customer_details?.email,
			saved.belongsTo
		);
		try {
			await waSendReservationConfirmation(saved);
		} catch (_) {}
		try {
			await waNotifyNewReservation(saved);
		} catch (_) {}

		// Build data2 mirror for FE that expects camelCase
		const savedObj = saved.toObject();
		if (savedObj.customer_details) delete savedObj.customer_details.password;
		const data2 = { ...savedObj, customerDetails: savedObj.customer_details };
		delete data2.customer_details;

		return res.status(201).json({
			message: "Reservation verified and created.",
			data: saved,
			data2,
		});
	} catch (err) {
		console.error(
			"verifyReservationAndCreate error:",
			err?.response?.data || err
		);
		return res.status(500).json({ message: "Verification failed." });
	}
};

/**
 * 12) OPTIONAL: attach a vault to an existing reservation
 */
exports.attachVaultToReservation = async (req, res) => {
	try {
		const { reservationId, setup_token } = req.body || {};
		if (!reservationId || !setup_token) {
			return res
				.status(400)
				.json({ message: "reservationId and setup_token are required." });
		}

		const r = await Reservations.findById(reservationId);
		if (!r) return res.status(404).json({ message: "Reservation not found." });

		const tokenData = await paypalExchangeSetupToVault(setup_token);

		const setOps = {
			"paypal_details.vault_id": tokenData.id,
			"paypal_details.vault_status": tokenData.status || "ACTIVE",
			"paypal_details.vaulted_at": new Date(
				tokenData.create_time || Date.now()
			),
			"paypal_details.card_brand":
				tokenData.payment_source?.card?.brand || null,
			"paypal_details.card_last4":
				tokenData.payment_source?.card?.last_digits || null,
			"paypal_details.card_exp": tokenData.payment_source?.card?.expiry || null,
		};
		if (tokenData.payment_source?.card?.billing_address) {
			setOps["paypal_details.billing_address"] =
				tokenData.payment_source.card.billing_address;
		}

		const updated = await Reservations.findByIdAndUpdate(
			reservationId,
			{ $set: setOps },
			{ new: true }
		);

		return res.status(200).json({
			ok: true,
			message: "Vault token attached to reservation.",
			reservation: updated,
		});
	} catch (error) {
		console.error(
			"attachVaultToReservation error:",
			error?.response?.data || error
		);
		return res.status(500).json({ message: "Failed to attach vault token." });
	}
};
