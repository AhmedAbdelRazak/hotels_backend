/*********************************************************************
 *  controllers/paypal_reservation.js  •  Drop‑in replacement (Authorize‑only at checkout)
 *  Jannat Booking — PayPal reservations: buttons & card fields
 *  - NO PAN/CVV storage (PayPal vault/payment tokens only)
 *  - Ledger with hard cap (limit_usd) + atomic pending guarding
 *  - Idempotent captures to prevent double charges
 *  - Verification only if the guest neither pays nor adds a card
 *  - Enhancements:
 *      (1) Lowercase `payment` labels everywhere ("deposit paid"|"paid online"|"not paid"|"paid offline")
 *      (2) Rich PayPal metadata (hotel / guest name/phone/email/nationality/reservedBy / dates / CNF)
 *      (3) Authorize-only at checkout (no immediate capture)
 *      (4) `paid_amount` set in SAR on authorization (deposit/full), recorded also in `payment_details.authorizationAmountSAR`
 *      (5) `payment_details.authorizationAmountUSD` saved on authorization
 *      (6) `financeStatus` normalized to lowercase ("not paid"|"authorized"|"paid")
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
const crypto = require("crypto");

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
const almostEq = (a, b) => Math.abs(toNum2(a) - toNum2(b)) < 1e-9;

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

/* Label helper: decide lowercase label */
function decidePaymentLabel({ option, expectedUsdAmount, convertedAmounts }) {
	const opt = String(option || "").toLowerCase(); // "deposit" | "full" | ""
	const dep = toNum2(convertedAmounts?.depositUSD || 0);
	const tot = toNum2(convertedAmounts?.totalUSD || 0);
	const exp = toNum2(expectedUsdAmount || 0);

	if (opt === "deposit") return "deposit paid";
	if (opt === "full") return "paid online";
	if (dep && almostEq(exp, dep)) return "deposit paid";
	if (tot && almostEq(exp, tot)) return "paid online";
	return "deposit paid";
}

/* ─────────────── 3) PayPal helpers ─────────────── */
function buildMetaBase({
	confirmationNumber,
	hotelName,
	guestName,
	guestPhone,
	guestEmail,
	guestNationality,
	reservedBy,
	checkin,
	checkout,
	usdAmount,
}) {
	const nat = guestNationality ? `, Nat: ${guestNationality}` : "";
	const rb = reservedBy ? `, By: ${reservedBy}` : "";
	return {
		invoice_id: `RSV-${confirmationNumber}`,
		custom_id: confirmationNumber,
		description: `Hotel reservation — ${hotelName} — ${checkin} → ${checkout} — Guest ${guestName} (Phone: ${guestPhone}${nat}${rb})`,
		hotelName,
		guestName,
		guestPhone,
		guestEmail,
		guestNationality,
		reservedBy,
		checkin,
		checkout,
		usdAmount,
	};
}

async function paypalExchangeSetupToVault(setup_token_id) {
	const { data } = await ax.post(
		`${PPM}/v3/vault/payment-tokens`,
		{ setup_token_id },
		{
			auth: { username: clientId, password: secretKey },
			headers: { "Content-Type": "application/json" },
		}
	);
	return data;
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
						description: `Guest: ${meta.guestName}, Phone: ${
							meta.guestPhone
						}, Email: ${meta.guestEmail || "n/a"}, Nat: ${
							meta.guestNationality || "n/a"
						}, By: ${meta.reservedBy || "n/a"}, ${meta.checkin} → ${
							meta.checkout
						}, Conf: ${meta.custom_id}`,
						quantity: "1",
						unit_amount: { currency_code: "USD", value: toCCY(usdAmount) },
						category: "DIGITAL_GOODS",
						sku: `CNF-${meta.custom_id}`,
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
			{ auth: { username: clientId, password: secretKey } }
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
					description: `Guest: ${meta.guestName}, Phone: ${
						meta.guestPhone
					}, Email: ${meta.guestEmail || "n/a"}, Nat: ${
						meta.guestNationality || "n/a"
					}, By: ${meta.reservedBy || "n/a"}, ${meta.checkin} → ${
						meta.checkout
					}, Conf: ${meta.custom_id}`,
					quantity: "1",
					unit_amount: { currency_code: "USD", value: toCCY(meta.usdAmount) },
					category: "DIGITAL_GOODS",
					sku: `CNF-${meta.custom_id}`,
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
						description: `Guest: ${meta.guestName}, Phone: ${
							meta.guestPhone
						}, Email: ${meta.guestEmail || "n/a"}, Nat: ${
							meta.guestNationality || "n/a"
						}, By: ${meta.reservedBy || "n/a"}, ${meta.checkin} → ${
							meta.checkout
						}, Conf: ${meta.custom_id}`,
						quantity: "1",
						unit_amount: { currency_code: "USD", value: toCCY(usdAmount) },
						category: "DIGITAL_GOODS",
						sku: `CNF-${meta.custom_id}`,
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
		const raw = err?._originalError?.text || err?.message || "";
		const alreadyCaptured =
			err?.statusCode === 422 && /ORDER_ALREADY_CAPTURED/i.test(raw);
		if (alreadyCaptured) {
			const getReq = new paypal.orders.OrdersGetRequest(order.id);
			if (cmid) getReq.headers["PayPal-Client-Metadata-Id"] = cmid;
			const { result } = await ppClient.execute(getReq);
			return result;
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
		financeStatus, // lowercase please
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
		paid_amount: toNum2(paid_amount || 0), // <-- SAR
		commission: toNum2(commission || 0),
		commissionPaid: !!commissionPaid,
		hotelName,
		advancePayment,
		...(financeStatus ? { financeStatus } : {}),
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
					"payment_details.triggeredAmountUSD": toNum2(amount), // USD captured
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

// helper to avoid leaking secrets
function idSig(id) {
	return crypto
		.createHash("sha256")
		.update(String(id))
		.digest("hex")
		.slice(0, 8);
}

exports.generateClientToken = async (req, res) => {
	try {
		const dbg = String(req.query?.dbg || "") === "1";
		const bc = (req.query?.bc || "").toUpperCase() || null;

		if (cachedClientToken && Date.now() < cachedClientTokenExp) {
			return res.json({
				clientToken: cachedClientToken,
				env: IS_PROD ? "live" : "sandbox",
				cached: true,
				diag: dbg
					? {
							isProd: IS_PROD,
							buyerCountryHint: bc,
							clientIdSig: idSig(clientId), // signature only
					  }
					: undefined,
			});
		}

		const t0 = Date.now();
		const { data, headers } = await ax.post(
			`${PPM}/v1/identity/generate-token`,
			{},
			{ auth: { username: clientId, password: secretKey } }
		);

		cachedClientToken = data.client_token;
		cachedClientTokenExp = Date.now() + 1000 * 60 * 60 * 8;

		return res.json({
			clientToken: cachedClientToken,
			env: IS_PROD ? "live" : "sandbox",
			diag: dbg
				? {
						isProd: IS_PROD,
						buyerCountryHint: bc,
						clientIdSig: idSig(clientId),
						debugId: headers?.["paypal-debug-id"] || null,
						elapsedMs: Date.now() - t0,
				  }
				: undefined,
		});
	} catch (e) {
		console.error("PayPal client-token:", e?.response?.data || e);
		return res
			.status(503)
			.json({ error: "PayPal temporarily unreachable. Try again." });
	}
};

/**
 * 2) Create reservation & process PayPal (single call)
 * Flows:
 *   - Not Paid + NO card → send verification email (do NOT create reservation)
 *   - Not Paid + card (setup_token) → save vault + ledger → create reservation NOW (no verification)
 *   - Deposit Paid / Paid Online (AUTHORIZE ONLY) → create reservation NOW
 */
exports.createReservationAndProcess = async (req, res) => {
	try {
		const body = req.body || {};
		const {
			sentFrom,
			payment,
			hotelId,
			customerDetails,
			convertedAmounts,
			option, // "deposit" | "full"
		} = body;

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

		// Employee or Paid Offline (unchanged)
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
				reqBody: {
					...body,
					hotelName: hotel.hotelName,
					payment: "paid offline",
					financeStatus: "paid",
				},
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

		// Client details validation (unchanged)
		const {
			name,
			phone,
			email,
			passport,
			passportExpiry,
			nationality,
			reservedBy,
		} = customerDetails || {};
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

		/* ── A) NOT PAID (unchanged logic) ───────────────────────────────── */
		if (pmtLower === "not paid") {
			const hasCard = !!pp.setup_token;

			// A1) not paid + NO card → verification only (unchanged)
			if (!hasCard) {
				const confirmationNumber = await new Promise((resolve, reject) => {
					ensureUniqueNumber(
						Reservations,
						"confirmation_number",
						(err, unique) => (err ? reject(err) : resolve(unique))
					);
				});

				const tokenPayload = {
					sentFrom: "client",
					payment: "not paid",
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
				const verificationLinkWA = `${process.env.CLIENT_URL}/reservation-verification`;

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

			// A2) not paid + CARD → vault + create now (unchanged)
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

			// Optional precheck
			if (pp.precheck?.do && pp.precheck?.amountUSD && persist.vault_id) {
				const confirmationNumber = await new Promise((resolve, reject) => {
					ensureUniqueNumber(
						Reservations,
						"confirmation_number",
						(err, unique) => (err ? reject(err) : resolve(unique))
					);
				});
				const meta = buildMetaBase({
					confirmationNumber,
					hotelName: hotel.hotelName,
					guestName: name,
					guestPhone: phone,
					guestEmail: email,
					guestNationality: nationality,
					reservedBy,
					checkin: body.checkin_date,
					checkout: body.checkout_date,
					usdAmount: pp.precheck.amountUSD,
				});
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
				reqBody: {
					...body,
					hotelName: hotel.hotelName,
					payment: "not paid",
					commissionPaid: false,
					financeStatus: "not paid",
					paid_amount: 0,
				},
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

		/* ── B) DEPOSIT / FULL (AUTHORIZE ONLY) — enhanced to ensure future charge ── */
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

			// Build meta & patch order
			const meta = buildMetaBase({
				confirmationNumber,
				hotelName: hotel.hotelName,
				guestName: name,
				guestPhone: phone,
				guestEmail: email,
				guestNationality: nationality,
				reservedBy,
				checkin: body.checkin_date,
				checkout: body.checkout_date,
				usdAmount: expectedUsdAmount,
			});

			// Verify amount (GET)
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

			try {
				await paypalPatchOrderMetadata(pp.order_id, meta);
			} catch (e) {
				console.warn("PATCH metadata:", e?.response?.data || e);
			}

			// AUTHORIZE (no capture)
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
					const deniedLike =
						err?.statusCode === 422 &&
						(/AUTHORIZATION_DENIED|INSTRUMENT_DECLINED|DECLINED/i.test(raw) ||
							(Array.isArray(err?.response?.data?.details) &&
								err.response.data.details.some((d) =>
									/DENIED|DECLINED/i.test(String(d?.issue || ""))
								)));
					return res.status(deniedLike ? 402 : 500).json({
						message: deniedLike
							? "The authorization was declined by the card issuer. No reservation was created. Please try a different card, pay via link (new PayPal order), or add a card (vault) and try again."
							: "Failed to authorize payment.",
					});
				}
				const getReq = new paypal.orders.OrdersGetRequest(pp.order_id);
				if (pp.cmid) getReq.headers["PayPal-Client-Metadata-Id"] = pp.cmid;
				const { result } = await ppClient.execute(getReq);
				authResult = result;
			}

			const auth =
				authResult?.purchase_units?.[0]?.payments?.authorizations?.[0] || {};
			const authStatus = String(auth?.status || "").toUpperCase();

			if (!auth?.id || !isAuthStatusOk(authStatus)) {
				return res.status(402).json({
					message:
						"The authorization was declined by the card issuer. No reservation was created.",
					details: { status: auth?.status || null, id: auth?.id || null },
				});
			}

			const srcCard = authResult?.payment_source?.card || {};
			let vaultId =
				authResult?.payment_source?.card?.attributes?.vault?.id || null;

			// 🔐 NEW: if guest used PayPal wallet (no card vault) but frontend also sent a setup_token, exchange it now
			if (!vaultId && pp.setup_token) {
				try {
					const tokenData = await paypalExchangeSetupToVault(pp.setup_token);
					vaultId = tokenData.id;
					// augment srcCard-like info for persistence
					srcCard.brand =
						tokenData.payment_source?.card?.brand || srcCard.brand;
					srcCard.last_digits =
						tokenData.payment_source?.card?.last_digits || srcCard.last_digits;
					srcCard.expiry =
						tokenData.payment_source?.card?.expiry || srcCard.expiry;
					if (tokenData.payment_source?.card?.billing_address) {
						srcCard.billing_address =
							tokenData.payment_source.card.billing_address;
					}
				} catch (e) {
					console.warn(
						"Optional vault exchange failed (wallet used):",
						e?.response?.data || e
					);
				}
			}

			// Lowercase payment label
			const finalPayment = decidePaymentLabel({
				option,
				expectedUsdAmount: pp.expectedUsdAmount || expectedUsdAmount,
				convertedAmounts: body?.convertedAmounts || {},
			});

			// SAR amount to store on authorization (as you wanted)
			const paidSar = toNum2(
				Number(body?.paid_amount ?? 0) || Number(body?.sarAmount ?? 0)
			);

			const user = await findOrCreateUserByEmail(customerDetails, body.userId);
			if (user) {
				user.confirmationNumbersBooked = user.confirmationNumbersBooked || [];
				user.confirmationNumbersBooked.push(confirmationNumber);
				await user.save();
			}

			// Compute long‑lead & store actionable flags if no vault
			const now = Date.now();
			const checkinMs = new Date(body.checkin_date).getTime();
			const longLeadDays = Math.max(
				0,
				Math.round((checkinMs - now) / (1000 * 60 * 60 * 24))
			);
			const longLeadNoVault = longLeadDays > 26 && !vaultId; // > ~26 days ≈ beyond PayPal reauth window

			const paypalDetails = {
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
				...(longLeadNoVault
					? {
							flags: { long_lead_no_vault: true },
							actions_required: ["attach_vault"],
					  }
					: {}),
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

			const saved = await buildAndSaveReservation({
				reqBody: {
					...body,
					hotelName: hotel.hotelName,
					payment: finalPayment,
					commissionPaid: true,
					financeStatus: "authorized",
					paid_amount: paidSar,
				},
				confirmationNumber,
				paypalDetailsToPersist: paypalDetails,
				paymentDetailsPatch: {
					captured: false,
					authorizationId: auth.id,
					authorizationAmountUSD: toNum2(auth?.amount?.value || 0),
					authorizationAmountSAR: paidSar,
					authorizationExpiresAt: auth?.expiration_time
						? new Date(auth.expiration_time)
						: null, // NEW
					needsVault: !!longLeadNoVault, // NEW
					longLeadDays: longLeadDays, // NEW
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
 *
 * Enhancements:
 *  - If original authorization is EXPIRED and there is NO vault, we automatically try
 *    PayPal REAUTHORIZE (within PayPal's allowed window) and then CAPTURE.
 *  - If reauthorize fails, we return 402 with a clear, actionable message.
 *  - MIT fallback still engages when a vault_id exists.
 *  - Unique invoice_id per capture; correct chargeCount; audit fields.
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

		/* ── Ledger pre-checks ───────────────────────────────────────────── */
		const limitUsd = Number(r?.paypal_details?.bounds?.limit_usd || 0);
		const capturedSoFar = Number(r?.paypal_details?.captured_total_usd || 0);
		const pendingSoFar = Number(r?.paypal_details?.pending_total_usd || 0);
		if (!limitUsd || limitUsd <= 0) {
			return res
				.status(400)
				.json({ message: "Capture limit is missing on this reservation." });
		}
		const remainingLedger =
			Math.round((limitUsd - capturedSoFar - pendingSoFar) * 100) / 100;
		if (amt > remainingLedger + 1e-9) {
			return res.status(400).json({
				message: `Capture exceeds remaining balance. Remaining USD: ${remainingLedger.toFixed(
					2
				)}`,
			});
		}

		/* ── Decide path (add REAUTHORIZE when needed) ───────────────────── */
		let authId = r?.paypal_details?.initial?.authorization_id || null;
		const authAmt = Number(r?.paypal_details?.initial?.amount || 0);
		let authStatus = String(
			r?.paypal_details?.initial?.authorization_status || ""
		).toUpperCase();
		const expIso = r?.paypal_details?.initial?.expiration_time || null;
		const expMs = expIso ? new Date(expIso).getTime() : null;
		const isExpired = !!(expMs && Date.now() >= expMs);
		const vault_id = r?.paypal_details?.vault_id || null;

		const AUTH_OK_STATUSES2 = new Set([
			"CREATED",
			"AUTHORIZED",
			"PENDING",
			"PARTIALLY_CAPTURED",
		]);

		const remainingAuth = Math.max(0, authAmt - capturedSoFar);
		let path = null; // "AUTH_CAPTURE" | "MIT" | "REAUTH_THEN_CAPTURE"
		let pathReason = "";

		if (
			!isExpired &&
			authId &&
			authAmt > 0 &&
			AUTH_OK_STATUSES2.has(authStatus)
		) {
			if (amt <= remainingAuth + 1e-9) {
				path = "AUTH_CAPTURE";
			} else if (vault_id) {
				path = "MIT";
				pathReason = "amount exceeds remaining authorization";
			} else {
				pathReason = `amount (${toCCY(
					amt
				)}) exceeds remaining authorization (${toCCY(
					remainingAuth
				)}) and no vaulted card`;
			}
		} else if (isExpired) {
			if (vault_id) {
				path = "MIT";
				pathReason = "authorization expired";
			} else if (amt <= authAmt + 1e-9) {
				// No vault, but within original auth amount → try REAUTHORIZE
				path = "REAUTH_THEN_CAPTURE";
				pathReason = "authorization expired (auto reauthorize)";
			} else {
				pathReason =
					"authorization expired, capture exceeds authorized amount, and no vaulted card";
			}
		} else if (vault_id) {
			path = "MIT";
			pathReason = "no valid authorization to capture";
		} else {
			pathReason = "no valid authorization to capture and no vaulted card";
		}

		if (!path) {
			return res.status(402).json({
				message: `Unable to charge: ${pathReason}. Ask the guest to pay via link (new PayPal order) or add a card (vault) and retry.`,
				code: isExpired ? "AUTHORIZATION_EXPIRED" : "NO_CAPTURE_PATH",
			});
		}

		/* ── Reserve "pending" (atomic ledger guard) ─────────────────────── */
		const reserved = await reservePendingCaptureUSD({
			reservationId,
			usdAmount: amt,
		});
		if (!reserved) {
			const stillRemaining = (
				limitUsd -
				(capturedSoFar + (r?.paypal_details?.pending_total_usd || 0))
			).toFixed(2);
			return res.status(400).json({
				message: `Capture exceeds remaining balance. Remaining USD: ${stillRemaining}`,
			});
		}

		/* ── Metadata + unique invoice_id ────────────────────────────────── */
		const conf = r.confirmation_number;
		const meta = buildMetaBase({
			confirmationNumber: conf,
			hotelName: r.hotelName || r.hotelId?.hotelName || "Hotel",
			guestName: r.customer_details?.name || "Guest",
			guestPhone: r.customer_details?.phone || "",
			guestEmail: r.customer_details?.email || "",
			guestNationality: r.customer_details?.nationality || "",
			reservedBy: r.customer_details?.reservedBy || "",
			checkin: r.checkin_date,
			checkout: r.checkout_date,
			usdAmount: amt,
		});
		meta.invoice_id = `RSV-${conf}-${Date.now()}`; // avoid DUPLICATE_INVOICE_ID

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

		/* ── Optional step: REAUTHORIZE then AUTH_CAPTURE ─────────────────── */
		if (path === "REAUTH_THEN_CAPTURE") {
			try {
				const idemReauth = `reauth:${reservationId}:${authId}:${toCCY(
					authAmt
				)}`;
				// Reauthorize for the remaining authorized amount (not greater than original)
				const { data: reauth } = await ax.post(
					`${PPM2}/v2/payments/authorizations/${authId}/reauthorize`,
					{
						amount: {
							currency_code: "USD",
							value: toCCY(Math.min(authAmt, remainingAuth || authAmt)),
						},
					},
					{
						auth: { username: clientId2, password: secretKey2 },
						headers: { "PayPal-Request-Id": idemReauth },
					}
				);

				// Update reservation with the NEW authorization details
				authId = reauth?.id || authId;
				authStatus = String(reauth?.status || "").toUpperCase();

				await Reservations.findByIdAndUpdate(
					reservationId,
					{
						$set: {
							"paypal_details.initial.authorization_id": authId,
							"paypal_details.initial.authorization_status":
								reauth?.status || "AUTHORIZED",
							"paypal_details.initial.expiration_time":
								reauth?.expiration_time || null,
						},
						$push: {
							"paypal_details.reauth_history": {
								at: new Date(),
								old: r?.paypal_details?.initial?.authorization_id || null,
								new: reauth?.id || null,
								status: reauth?.status || null,
								expiration_time: reauth?.expiration_time || null,
							},
						},
					},
					{ new: true }
				);

				// After successful reauth, proceed as normal AUTH_CAPTURE
				path = "AUTH_CAPTURE";
				pathReason = "reauthorized successfully";
			} catch (reauthErr) {
				await finalizePendingCaptureUSD({
					reservationId,
					usdAmount: amt,
					success: false,
				});
				const code =
					reauthErr?.response?.data?.details?.[0]?.issue ||
					"AUTHORIZATION_REAUTHORIZE_FAILED";
				return res.status(402).json({
					message:
						"Authorization is expired and could not be reauthorized. Use link-pay (new PayPal order) or add a card (vault) and retry.",
					code,
				});
			}
		}

		/* ── Path A: capture against (valid or reauthorized) authorization ── */
		if (path === "AUTH_CAPTURE") {
			try {
				const final_capture =
					Math.abs(Math.max(0, authAmt - capturedSoFar) - amt) < 1e-9;
				const idemKey = `authcap:${reservationId}:${toCCY(amt)}:${conf}`;
				const body = {
					amount: { currency_code: "USD", value: toCCY(amt) },
					invoice_id: meta.invoice_id,
					final_capture,
				};
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
				// If this still fails and we do have a vault token, fall back to MIT
				const issue =
					capAuthErr?.response?.data?.details?.[0]?.issue ||
					"AUTH_CAPTURE_FAILED";
				const expiredLike = /AUTHORIZATION_EXPIRED/i.test(issue);
				const invalidLike = /INVALID_RESOURCE_ID/i.test(issue);

				console.warn(
					"Authorization capture failed; inspecting.",
					capAuthErr?.response?.data || capAuthErr
				);

				if (vault_id && (expiredLike || invalidLike)) {
					// fall back to MIT if possible
					path = "MIT";
				} else {
					await finalizePendingCaptureUSD({
						reservationId,
						usdAmount: amt,
						success: false,
					});
					return res.status(402).json({
						message: expiredLike
							? "Authorization has expired. Use link-pay or add a card to vault and retry."
							: invalidLike
							? "Authorization ID is invalid or no longer available. Use link-pay or add a card to vault and retry."
							: "Authorization capture failed.",
						code: issue,
					});
				}
			}
		}

		/* ── Path B: MIT charge via vaulted card ──────────────────────────── */
		if (!resultCapture && path === "MIT") {
			const previousCaptureId = r?.paypal_details?.initial?.capture_id || null;
			try {
				const mitRes = await paypalMitCharge({
					usdAmount: amt,
					vault_id,
					meta,
					cmid,
					previousCaptureId,
				});
				resultCapture = { ...mitRes, _via: "MIT" };
			} catch (mitErr) {
				await finalizePendingCaptureUSD({
					reservationId,
					usdAmount: amt,
					success: false,
				});
				const issue =
					mitErr?.response?.data?.details?.[0]?.issue || "MIT_FAILED";
				return res.status(402).json({
					message: "MIT charge failed.",
					code: issue,
				});
			}
		}

		/* ── Validate capture result ─────────────────────────────────────── */
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

		const captureDoc = {
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
			invoice_id: meta.invoice_id,
		};

		// 1) finalize ledger (chargeCount++ inside)
		let updated = await finalizePendingCaptureUSD({
			reservationId,
			usdAmount: capturedUsd,
			success: true,
			captureDoc,
		});

		// 2) SAR increment + audit fields
		const sarInc = Number.isFinite(Number(sarAmount))
			? Math.round(Number(sarAmount) * 100) / 100
			: 0;
		const setAfter = {
			"payment_details.finalCaptureTransactionId": cap.id,
			"payment_details.lastChargeVia": resultCapture?._via || "UNKNOWN",
			"payment_details.lastChargeAt": new Date(),
		};
		if (sarInc > 0) {
			setAfter["payment_details.triggeredAmountSAR"] = sarInc;
		}

		updated = await Reservations.findByIdAndUpdate(
			reservationId,
			{
				...(sarInc > 0 ? { $inc: { paid_amount: sarInc } } : {}),
				$set: setAfter,
			},
			{ new: true }
		).populate("hotelId");

		// 3) normalize payment/finance based on ledger
		const capLimit = toNum2(updated?.paypal_details?.bounds?.limit_usd || 0);
		const newCapturedTotal = toNum2(
			updated?.paypal_details?.captured_total_usd || 0
		);
		const fullyPaid = newCapturedTotal >= capLimit - 1e-9;

		updated = await Reservations.findByIdAndUpdate(
			reservationId,
			{
				$set: {
					payment: fullyPaid ? "paid online" : "deposit paid",
					commissionPaid: true,
					financeStatus: fullyPaid ? "paid" : "authorized",
				},
			},
			{ new: true }
		).populate("hotelId");

		/* ── Receipt emails (best effort) ─────────────────────────────────── */
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
					: resultCapture?._via === "MIT"
					? "MIT charge completed."
					: "Payment captured.",
			transactionId: cap.id,
			reservation: updated,
			path: resultCapture?._via,
			reason: pathReason || undefined,
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
			guestEmail,
			guestNationality,
			reservedBy,
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

		const meta = buildMetaBase({
			confirmationNumber,
			hotelName: hotel.hotelName,
			guestName,
			guestPhone,
			guestEmail: guestEmail || "",
			guestNationality: guestNationality || "",
			reservedBy: reservedBy || "",
			checkin: checkin_date,
			checkout: checkout_date,
			usdAmount,
		});

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
 *
 * Enhancements:
 *  - Robust metadata (unique invoice_id), patch & retry on DUPLICATE_INVOICE_ID.
 *  - Correct chargeCount (no double increments).
 *  - Saves vault_id when the PayPal order exposes it (card + store_in_vault).
 *  - Sets bounds if missing on first capture (so later MIT works reliably).
 *  - Adds audit: payment_details.lastChargeVia + lastChargeAt.
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
		usdAmount,
		hotelName,
		guestName,
		guestPhone,
		guestEmail,
		guestNationality,
		reservedBy,
		checkin,
		checkout,
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
			{
				op: "add",
				path: "/purchase_units/@reference_id=='default'/items",
				value: [
					{
						name: `Hotel Reservation — ${hotelName}`,
						description: `Guest: ${guestName}, Phone: ${guestPhone}, Email: ${
							guestEmail || "n/a"
						}, Nat: ${guestNationality || "n/a"}, By: ${
							reservedBy || "n/a"
						}, ${checkin} → ${checkout}, Conf: ${custom_id}`,
						quantity: "1",
						unit_amount: { currency_code: "USD", value: toCCY(usdAmount) },
						category: "DIGITAL_GOODS",
						sku: `CNF-${custom_id}`,
					},
				],
			},
			{
				op: "add",
				path: "/purchase_units/@reference_id=='default'/amount/breakdown",
				value: {
					item_total: { currency_code: "USD", value: toCCY(usdAmount) },
				},
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

		// Find reservation by _id or confirmation_number
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

		// Verify order amount
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

		// Unique invoice id for this link-pay attempt
		const uniqueInvoiceId = buildUniqueInvoiceId(
			reservation.confirmation_number,
			existingCount
		);

		const description = `Hotel reservation — ${hotelName} — ${
			reservation.checkin_date
		} → ${reservation.checkout_date} — Guest ${guest.name} (${
			guest.phone || ""
		})`;

		// Patch invoice/custom/description for human-readable dashboard
		try {
			await patchOrderInvoiceAndDescription({
				orderId: pp.order_id,
				invoice_id: uniqueInvoiceId,
				custom_id: reservation.confirmation_number,
				description,
				auth: { PPM: PPM2, clientId: clientId2, secretKey: secretKey2 },
				usdAmount,
				hotelName,
				guestName: guest.name,
				guestPhone: guest.phone,
				guestEmail: guest.email,
				guestNationality: guest.nationality,
				reservedBy: guest.reservedBy,
				checkin: reservation.checkin_date,
				checkout: reservation.checkout_date,
			});
		} catch (e) {
			console.warn(
				"PATCH metadata (non-fatal):",
				e?.response?.data || e?.message || e
			);
		}

		const mode = (pp.mode || "").toLowerCase();

		/* ───────────────────────────────────────────────────────────────────
		 * A) AUTHORIZE NOW (preferred to keep state "authorized")
		 * ─────────────────────────────────────────────────────────────────── */
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
					const deniedLike =
						err?.statusCode === 422 &&
						(/AUTHORIZATION_DENIED|INSTRUMENT_DECLINED|DECLINED/i.test(raw) ||
							(Array.isArray(err?.response?.data?.details) &&
								err.response.data.details.some((d) =>
									/DENIED|DECLINED/i.test(String(d?.issue || ""))
								)));
					return res.status(deniedLike ? 402 : 500).json({
						message: deniedLike
							? "The authorization was declined by the card issuer. Please try a different card or capture a smaller amount."
							: "Failed to authorize payment.",
					});
				}
				// If already authorized, fetch the order to read the authorization object
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

			// Persist vault attributes when present
			const srcCard = authResult?.payment_source?.card || {};
			const vaultId =
				authResult?.payment_source?.card?.attributes?.vault?.id ||
				reservation?.paypal_details?.vault_id ||
				null;

			const finalPayment = decidePaymentLabel({
				option,
				expectedUsdAmount: pp.expectedUsdAmount,
				convertedAmounts,
			});

			const paidSar = toNum2(Number(sarAmount || 0));

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
				"payment_details.authorizationAmountSAR": paidSar,

				payment: finalPayment,
				commissionPaid: true,
				financeStatus: "authorized",
				paid_amount: paidSar,
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

		/* ───────────────────────────────────────────────────────────────────
		 * B) CAPTURE NOW — Backoffice capture (preferred when funds are due)
		 * ─────────────────────────────────────────────────────────────────── */
		// Determine the ledger limit (must exist for pending guard)
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

		// Reserve "pending" (atomic guard)
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

			// Refresh invoice_id and retry once
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
					usdAmount,
					hotelName,
					guestName: guest.name,
					guestPhone: guest.phone,
					guestEmail: guest.email,
					guestNationality: guest.nationality,
					reservedBy: guest.reservedBy,
					checkin: reservation.checkin_date,
					checkout: reservation.checkout_date,
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

		// Persist vault if present on the captured order (rare, but possible)
		const psCard = capResult?.payment_source?.card || null;
		const vaultIdFromCap = psCard?.attributes?.vault?.id || null;

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
			via: "LINK_CAPTURE",
		};

		// 1) finalize ledger (chargeCount++ inside helper)
		let updated = await finalizePendingCaptureUSD({
			reservationId: reservation._id,
			usdAmount: capAmount,
			success: true,
			captureDoc: commonCaptureDoc,
		});

		// 2) Ensure bounds exist after first capture (if they were missing)
		const needBounds =
			!updated?.paypal_details?.bounds ||
			typeof updated?.paypal_details?.bounds?.limit_usd !== "number";
		if (needBounds) {
			updated = await Reservations.findByIdAndUpdate(
				reservation._id,
				{
					$set: {
						"paypal_details.bounds.base": "USD",
						"paypal_details.bounds.limit_usd": toNum2(limit),
					},
				},
				{ new: true }
			);
		}

		// 3) SAR increment + audit + optional vault persistence
		const setAfter = {
			"payment_details.captured": true,
			"payment_details.triggeredAmountUSD": toNum2(capAmount),
			"payment_details.finalCaptureTransactionId": cap.id,
			"payment_details.lastChargeVia": "LINK_CAPTURE",
			"payment_details.lastChargeAt": new Date(),
			...(typeof sarAmount !== "undefined"
				? { "payment_details.triggeredAmountSAR": toNum2(sarAmount) }
				: {}),
		};

		const incAfter =
			typeof sarAmount !== "undefined"
				? { paid_amount: Math.round(Number(sarAmount) * 100) / 100 }
				: null;

		if (vaultIdFromCap) {
			setAfter["paypal_details.vault_id"] = vaultIdFromCap;
			setAfter["paypal_details.vault_status"] = "ACTIVE";
			setAfter["paypal_details.vaulted_at"] = new Date();
			setAfter["paypal_details.card_brand"] = psCard?.brand || null;
			setAfter["paypal_details.card_last4"] = psCard?.last_digits || null;
			setAfter["paypal_details.card_exp"] = psCard?.expiry || null;
			if (psCard?.billing_address) {
				setAfter["paypal_details.billing_address"] = psCard.billing_address;
			}
		}

		updated = await Reservations.findByIdAndUpdate(
			reservation._id,
			{
				...(incAfter ? { $inc: incAfter } : {}),
				$set: setAfter,
			},
			{ new: true }
		).populate("hotelId");

		// 4) Normalize labels based on ledger vs. limit
		const newCapturedTotal = toNum2(
			updated?.paypal_details?.captured_total_usd || 0
		);
		const fullyPaid = newCapturedTotal >= toNum2(limit) - 1e-9;

		updated = await Reservations.findByIdAndUpdate(
			reservation._id,
			{
				$set: {
					payment: fullyPaid ? "paid online" : "deposit paid",
					commissionPaid: true,
					financeStatus: fullyPaid ? "paid" : "authorized",
				},
			},
			{ new: true }
		).populate("hotelId");

		// 5) Send receipts (best effort)
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

		// Idempotency
		const existing = await Reservations.findOne({
			confirmation_number: decoded.confirmation_number,
		}).populate("hotelId");
		if (existing) {
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

		// Duplicates
		const reservationData = decoded;
		const checkinDate = new Date(reservationData.checkin_date);

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

		// Unique confirmation
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

		// “Not Paid” verification path
		reservationData.paymentDetails = {
			cardNumber: "",
			cardExpiryDate: "",
			cardCVV: "",
			cardHolderName: "",
		};
		reservationData.paid_amount = 0;
		reservationData.payment = "not paid";
		reservationData.commission = 0;
		reservationData.commissionPaid = false;

		const saved = await buildAndSaveReservation({
			reqBody: {
				...reservationData,
				paypal_details: undefined,
				financeStatus: "not paid",
			},
			confirmationNumber,
			paypalDetailsToPersist: reservationData.paypal_details, // normally undefined
		});

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
		const { reservationId, setup_token, precheckUSD } = req.body || {};
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
			"payment_details.needsVault": false, // cleared once vaulted
			"payment_details.vaultAttachedAt": new Date(), // NEW audit
		};
		if (tokenData.payment_source?.card?.billing_address) {
			setOps["paypal_details.billing_address"] =
				tokenData.payment_source.card.billing_address;
		}

		let updated = await Reservations.findByIdAndUpdate(
			reservationId,
			{ $set: setOps },
			{ new: true }
		).populate("hotelId");

		// Optional: tiny precheck (auth+void) to ensure card is OK
		if (precheckUSD && Number(precheckUSD) > 0) {
			try {
				const meta = buildMetaBase({
					confirmationNumber: updated.confirmation_number,
					hotelName: updated.hotelName || updated.hotelId?.hotelName || "Hotel",
					guestName: updated.customer_details?.name || "Guest",
					guestPhone: updated.customer_details?.phone || "",
					guestEmail: updated.customer_details?.email || "",
					guestNationality: updated.customer_details?.nationality || "",
					reservedBy: updated.customer_details?.reservedBy || "",
					checkin: updated.checkin_date,
					checkout: updated.checkout_date,
					usdAmount: Number(precheckUSD),
				});
				await paypalPrecheckAuthorizeVoid({
					usdAmount: Number(precheckUSD),
					vault_id: tokenData.id,
					meta,
					cmid: null,
				});
				updated = await Reservations.findByIdAndUpdate(
					reservationId,
					{
						$set: {
							"payment_details.precheckUSD": toNum2(precheckUSD),
							"payment_details.precheckAt": new Date(),
						},
					},
					{ new: true }
				).populate("hotelId");
			} catch (e) {
				console.warn("attachVault precheck failed:", e?.response?.data || e);
			}
		}

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
