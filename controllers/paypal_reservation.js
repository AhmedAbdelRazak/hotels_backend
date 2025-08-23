/*********************************************************************
 *  controllers/paypal_reservation.js  •  Aug‑2025
 *  PayPal for Hotel Reservations — vault + metadata + capture ledger
 *  - NO PAN/CVV storage; uses PayPal vault/payment tokens.
 *  - Adds a capture ledger with hard cap (limit_usd) + atomic guarding.
 *********************************************************************/

"use strict";

/* ───────────────────────── 1) Deps & environment ───────────────────────── */
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

/* Templates + WhatsApp (re‑use from your codebase) */
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

/* Utils (re‑use from your codebase) */
const {
	encryptWithSecret,
	decryptWithSecret,
	verifyToken,
} = require("./utils");

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

/* Axios for REST endpoints not covered by SDK (vault, PATCH, void) */
const ax = axios.create({ timeout: 12_000 });
axiosRetry(ax, { retries: 3, retryDelay: (c) => 400 * 2 ** c });
const PPM = IS_PROD
	? "https://api-m.paypal.com"
	: "https://api-m.sandbox.paypal.com";

/* ───────────────────────── 2) Helpers ──────────────────────────────────── */
const toCCY = (n) => Number(n || 0).toFixed(2);
const toNum2 = (n) => Math.round(Number(n || 0) * 100) / 100; // exact cents
const nowIso = () => new Date().toISOString();
const safeClone = (o) => JSON.parse(JSON.stringify(o));

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

/* ───────────────────────── 3) PayPal helpers ───────────────────────────── */
/** Exchange a Setup Token → permanent vault payment token */
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

/** Create an order (AUTHORIZE) using a vault token, then VOID (credit check) */
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
			{ auth: { username: clientId, password: secretKey } }
		);
	}
	return { orderId: order.id, authorization: auth };
}

/** Patch client‑created order to contain hotel metadata + NO_SHIPPING */
async function paypalPatchOrderMetadata(orderId, meta) {
	const ops = [
		{
			op: "replace",
			path: "/purchase_units/@reference_id=='default'/invoice_id",
			value: meta.invoice_id,
		},
		{
			op: "replace",
			path: "/purchase_units/@reference_id=='default'/custom_id",
			value: meta.custom_id,
		},
		{
			op: "replace",
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
			op: "replace",
			path: "/application_context/shipping_preference",
			value: "NO_SHIPPING",
		},
	];

	await ax.patch(`${PPM}/v2/checkout/orders/${orderId}`, ops, {
		auth: { username: clientId, password: secretKey },
		headers: { "Content-Type": "application/json" },
	});
}

/** Capture an approved order (wallet or card) */
async function paypalCaptureApprovedOrder({ orderId, cmid }) {
	const capReq = new paypal.orders.OrdersCaptureRequest(orderId);
	if (cmid) capReq.headers["PayPal-Client-Metadata-Id"] = cmid;
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

/** MIT (merchant‑initiated) order using a vault token */
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
				previous_transaction_reference: previousCaptureId
					? { id: previousCaptureId }
					: undefined,
			},
		},
	});

	const { result: order } = await ppClient.execute(creq);

	const capReq = new paypal.orders.OrdersCaptureRequest(order.id);
	if (cmid) capReq.headers["PayPal-Client-Metadata-Id"] = cmid;
	capReq.requestBody({});
	const { result } = await ppClient.execute(capReq);
	return result;
}

/* ───────────────────────── 4) Data + ledger helpers ────────────────────── */
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
	paypalDetailsToPersist, // object
	paymentDetailsPatch, // for your existing payment_details UI
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
		convertedAmounts, // { depositUSD, totalUSD }
	} = reqBody;

	// ensure ledger bounds if totalUSD provided
	const bounds =
		(paypalDetailsToPersist && paypalDetailsToPersist.bounds) ||
		(convertedAmounts?.totalUSD
			? { base: "USD", limit_usd: toNum2(convertedAmounts.totalUSD) }
			: undefined);

	const r = new Reservations({
		hotelId,
		customer_details: {
			...customerDetails,
			// DO NOT store card data
		},
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
		paid_amount: Number(paid_amount || 0).toFixed(2),
		commission: Number(commission || 0).toFixed(2),
		commissionPaid: !!commissionPaid,
		hotelName,
		advancePayment,
	});

	// compose paypal_details
	const pd = { ...(paypalDetailsToPersist || {}) };
	if (bounds) {
		pd.bounds = bounds; // base USD, limit_usd
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

/** Atomically reserve "pending" capture room to avoid races */
async function reservePendingCaptureUSD({ reservationId, usdAmount }) {
	const amount = toNum2(usdAmount);

	// Require a cap limit; and ensure captured + pending + new <= limit
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
				{ $ifNull: ["$paypal_details.bounds.limit_usd", -1] }, // -1 => will fail if not set
			],
		},
	};

	const update = {
		$inc: { "paypal_details.pending_total_usd": amount },
	};

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
					"payment_details.triggeredAmountUSD": toCCY(amount),
				},
			},
			{ new: true }
		).populate("hotelId");
	} else {
		// revert pending only
		return Reservations.findByIdAndUpdate(
			reservationId,
			{ $inc: { "paypal_details.pending_total_usd": -amount } },
			{ new: true }
		).populate("hotelId");
	}
}

/* ───────────────────────── 5) ROUTES: Controllers ──────────────────────── */

/** 1) Client token for JS SDK Card Fields (cache 8h) */
let cachedClientToken = null;
let cachedClientTokenExp = 0;
exports.generateClientToken = async (_req, res) => {
	try {
		if (cachedClientToken && Date.now() < cachedClientTokenExp) {
			return res.json({ clientToken: cachedClientToken, cached: true });
		}
		const { data } = await ax.post(
			`${PPM}/v1/identity/generate-token`,
			{},
			{ auth: { username: clientId, password: secretKey } }
		);
		cachedClientToken = data.client_token;
		cachedClientTokenExp = Date.now() + 1000 * 60 * 60 * 8;
		res.json({ clientToken: cachedClientToken });
	} catch (e) {
		console.error("PayPal client-token:", e?.response?.data || e);
		res
			.status(503)
			.json({ error: "PayPal temporarily unreachable. Try again." });
	}
};

/**
 * 2) Create reservation & process PayPal (single call)
 *  - Supports:
 *    Not Paid  (vault + optional precheck + verification email)
 *    Deposit   (capture now, set cap=full amount, captured=deposit)
 *    Paid Online (capture now, set cap=full amount, captured=full)
 *
 * Body:
 * {
 *   sentFrom: "client" | "employee",
 *   payment: "Not Paid" | "Deposit Paid" | "Paid Online" | "Paid Offline",
 *   hotelId, customerDetails, belongsTo, checkin_date, checkout_date, ...,
 *   total_amount, pickedRoomsType, booking_source, hotelName,
 *   convertedAmounts: { depositUSD, totalUSD },
 *
 *   paypal: For Not Paid:
 *     { setup_token?, precheck?: { do?: true, amountUSD?: "xx.xx" }, cmid? }
 *   paypal: For capture now:
 *     { order_id: "...", expectedUsdAmount: "xx.xx", cmid? }
 * }
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
			hotelName,
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
			} catch (e) {}
			try {
				await waNotifyNewReservation(saved);
			} catch (e) {}

			return res
				.status(201)
				.json({ message: "Reservation created successfully", data: saved });
		}

		// Client path
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

		// Not Paid (vault + precheck + verification email)
		if (String(payment).toLowerCase() === "not paid") {
			const pp = body.paypal || {};
			const persist = {};

			if (pp.setup_token) {
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
			}

			// attach cap limit into token (used later when reservation is created)
			if (convertedAmounts?.totalUSD) {
				persist.bounds = {
					base: "USD",
					limit_usd: toNum2(convertedAmounts.totalUSD),
				};
				persist.captured_total_usd = 0;
				persist.pending_total_usd = 0;
			}

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

			const tokenPayload = {
				...body,
				hotelName: hotel.hotelName,
				payment: "Not Paid",
				paid_amount: 0,
				commission: 0,
				commissionPaid: false,
				paypal_details: Object.keys(persist).length ? persist : undefined,
			};
			const token = jwt.sign(tokenPayload, process.env.JWT_SECRET2, {
				expiresIn: "3d",
			});
			const link = `${process.env.CLIENT_URL}/reservation-verification?token=${token}`;

			const emailContent = ReservationVerificationEmail({
				name,
				hotelName: hotel.hotelName,
				confirmationLink: link,
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
					link
				);
			} catch (e) {}

			return res.status(200).json({
				message:
					"Verification email sent successfully. Please check your inbox.",
			});
		}

		// Capture now: Deposit or Full
		if (
			["deposit paid", "paid online"].includes(String(payment).toLowerCase())
		) {
			const pp = body.paypal || {};
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
				String(payment).toLowerCase() === "deposit paid"
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

			// Verify order amount
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

			// Patch metadata (NO_SHIPPING, hotel info)
			try {
				await paypalPatchOrderMetadata(pp.order_id, meta);
			} catch (e) {
				console.warn("PATCH metadata:", e?.response?.data || e);
			}

			// Capture
			const result = await paypalCaptureApprovedOrder({
				orderId: pp.order_id,
				cmid: pp.cmid,
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

			// paypal_details initial + ledger
			const paypalDetails = {
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

			// Create or find user, attach confirmation
			const user = await findOrCreateUserByEmail(customerDetails, body.userId);
			if (user) {
				user.confirmationNumbersBooked = user.confirmationNumbersBooked || [];
				user.confirmationNumbersBooked.push(confirmationNumber);
				await user.save();
			}

			// Patch legacy payment_details for UI
			const paymentDetailsPatch = {
				captured: true,
				triggeredAmountUSD: toCCY(capAmount),
				triggeredAmountSAR: Number(body.paid_amount || 0).toFixed(2),
				finalCaptureTransactionId: cap.id,
				chargeCount: 1,
			};

			// Save reservation (full doc)
			const saved = await buildAndSaveReservation({
				reqBody: { ...body, hotelName: hotel.hotelName },
				confirmationNumber,
				paypalDetailsToPersist: paypalDetails,
				paymentDetailsPatch,
			});

			// Emails + WA
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
			} catch (e) {}
			try {
				await waNotifyNewReservation(saved);
			} catch (e) {}

			return res.status(201).json({
				message: "Reservation created successfully",
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
 *  - Enforces: captured_total_usd + pending + usdAmount <= bounds.limit_usd
 *  - Atomic reservation of "pending" amount prevents race conditions.
 */
exports.mitChargeReservation = async (req, res) => {
	try {
		const { reservationId, usdAmount, cmid, sarAmount } = req.body || {};
		const amt = toNum2(usdAmount);
		if (!reservationId || !amt || amt <= 0) {
			return res.status(400).json({
				message: "reservationId and a positive usdAmount are required.",
			});
		}

		const reservation = await Reservations.findById(reservationId).populate(
			"hotelId"
		);
		if (!reservation)
			return res.status(404).json({ message: "Reservation not found." });

		const vault_id = reservation?.paypal_details?.vault_id;
		const limit = reservation?.paypal_details?.bounds?.limit_usd;
		const capturedSoFar = reservation?.paypal_details?.captured_total_usd || 0;

		if (!vault_id) {
			return res.status(400).json({
				message: "No saved PayPal payment token on this reservation.",
			});
		}
		if (typeof limit !== "number" || limit <= 0) {
			return res
				.status(400)
				.json({ message: "Capture limit is missing on this reservation." });
		}

		// Atomically reserve "pending" amount against limit
		const reserved = await reservePendingCaptureUSD({
			reservationId,
			usdAmount: amt,
		});
		if (!reserved) {
			const remaining = toCCY(
				limit -
					(capturedSoFar +
						(reservation?.paypal_details?.pending_total_usd || 0))
			);
			return res.status(400).json({
				message: `Capture exceeds remaining balance. Remaining USD: ${remaining}`,
			});
		}

		const confirmation = reservation.confirmation_number;
		const meta = {
			invoice_id: `RSV-${confirmation}-${Date.now()}`,
			custom_id: confirmation,
			description: `Post‑stay charge — ${
				reservation.hotelName || reservation.hotelId?.hotelName || "Hotel"
			} — ${reservation.checkin_date} → ${reservation.checkout_date} — Guest ${
				reservation.customer_details?.name
			} (${reservation.customer_details?.phone})`,
			hotelName:
				reservation.hotelName || reservation.hotelId?.hotelName || "Hotel",
			guestName: reservation.customer_details?.name || "Guest",
			guestPhone: reservation.customer_details?.phone || "",
			checkin: reservation.checkin_date,
			checkout: reservation.checkout_date,
			usdAmount: amt,
		};

		const previousCaptureId =
			reservation?.paypal_details?.initial?.capture_id || null;

		// Execute MIT capture
		let result;
		try {
			result = await paypalMitCharge({
				usdAmount: amt,
				vault_id,
				meta,
				cmid,
				previousCaptureId,
			});
		} catch (ppErr) {
			await finalizePendingCaptureUSD({
				reservationId,
				usdAmount: amt,
				success: false,
			});
			return res.status(502).json({
				message: "PayPal capture failed.",
				details: String(ppErr?.message || ppErr),
			});
		}

		const cap = result?.purchase_units?.[0]?.payments?.captures?.[0] || {};
		if (cap?.status !== "COMPLETED") {
			await finalizePendingCaptureUSD({
				reservationId,
				usdAmount: amt,
				success: false,
			});
			return res
				.status(402)
				.json({ message: "MIT charge not completed.", details: cap });
		}

		// Build capture doc for ledger
		const mitCaptureDoc = {
			order_id: result.id,
			capture_id: cap.id,
			capture_status: cap.status,
			amount: cap?.amount?.value,
			currency: cap?.amount?.currency_code,
			seller_protection: cap?.seller_protection?.status || "UNKNOWN",
			network_transaction_reference: cap?.network_transaction_reference || null,
			created_at: new Date(cap?.create_time || Date.now()),
			raw: safeClone(result),
		};

		// Finalize: decrement pending, increment captured, push capture
		let updated = await finalizePendingCaptureUSD({
			reservationId,
			usdAmount: amt,
			success: true,
			captureDoc: mitCaptureDoc,
		});

		// Optionally maintain your SAR paid_amount for UI if provided
		if (sarAmount) {
			updated = await Reservations.findByIdAndUpdate(
				reservationId,
				{ $inc: { paid_amount: toNum2(sarAmount) } },
				{ new: true }
			).populate("hotelId");
		}

		// Optional: send paymentTriggered email
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
			message: "MIT charge completed.",
			transactionId: cap.id,
			reservation: updated,
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
 * 4) (Optional) Standalone credit precheck (auth+void)
 * Body: { setup_token? , vault_id?, usdAmount, hotelId, guestName, guestPhone, checkin_date, checkout_date, cmid? }
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
 * 5) (Optional) Exchange setup_token → vault token
 * Body: { setup_token }
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
 * 6) (Optional) Update capture limit (when stay changes)
 * Body: { reservationId, newLimitUsd }
 *  - Will NOT allow reducing below already captured_total_usd.
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
 * 7) (Optional) Inspect PayPal ledger for a reservation
 * GET /.../ledger/:reservationId
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
		if (type === "PAYMENT.CAPTURE.COMPLETED") {
			const orderId = resource?.supplementary_data?.related_ids?.order_id;
			const captureId = resource?.id;
			console.log("Webhook CAPTURE completed:", { orderId, captureId });
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

exports.linkPayReservation = async (req, res) => {
	const toNum2 = (n) => Math.round(Number(n || 0) * 100) / 100;

	// Build a unique invoice id per capture (short, safe, ≤127 chars)
	function buildUniqueInvoiceId(confNumber, existingCount) {
		const seq = (existingCount || 0) + 1;
		const tail = Date.now().toString(36).slice(-6).toUpperCase(); // very short time salt
		return `RSV-${confNumber}-${seq}-${tail}`.slice(0, 127);
	}

	// Safely patch only patchable fields on the order
	async function patchOrderInvoiceAndDescription({
		orderId,
		invoice_id,
		custom_id,
		description,
		auth,
	}) {
		const ops = [
			{
				op: "replace",
				path: "/purchase_units/@reference_id=='default'/invoice_id",
				value: invoice_id,
			},
			{
				op: "replace",
				path: "/purchase_units/@reference_id=='default'/custom_id",
				value: custom_id,
			},
			{
				op: "replace",
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
		const { reservationKey, option, convertedAmounts, sarAmount, paypal } =
			req.body || {};
		if (
			!reservationKey ||
			!option ||
			!paypal?.order_id ||
			!paypal?.expectedUsdAmount
		) {
			return res.status(400).json({ message: "Missing required fields." });
		}

		// 1) Find reservation by _id or confirmation_number
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

		// 2) Decide amount to capture (USD) + enforce cap
		const usdAmount =
			String(option).toLowerCase() === "deposit"
				? convertedAmounts?.depositUSD
				: convertedAmounts?.totalUSD;
		if (!usdAmount)
			return res.status(400).json({ message: "Converted USD amount missing." });

		const limit =
			reservation?.paypal_details?.bounds?.limit_usd ??
			(convertedAmounts?.totalUSD ? toNum2(convertedAmounts.totalUSD) : null);
		if (!limit || limit <= 0)
			return res
				.status(400)
				.json({ message: "Reservation capture limit is not set." });

		const capturedSoFar = toNum2(
			reservation?.paypal_details?.captured_total_usd || 0
		);
		const newCapture = toNum2(usdAmount);
		if (capturedSoFar + newCapture > limit + 1e-9) {
			const remaining = toNum2(limit - capturedSoFar).toFixed(2);
			return res.status(400).json({
				message: `Capture exceeds remaining balance. Remaining USD: ${remaining}`,
			});
		}

		// 3) Verify order amount
		const PPM = /prod/i.test(process.env.NODE_ENV)
			? "https://api-m.paypal.com"
			: "https://api-m.sandbox.paypal.com";
		const clientId = /prod/i.test(process.env.NODE_ENV)
			? process.env.PAYPAL_CLIENT_ID_LIVE
			: process.env.PAYPAL_CLIENT_ID_SANDBOX;
		const secretKey = /prod/i.test(process.env.NODE_ENV)
			? process.env.PAYPAL_SECRET_KEY_LIVE
			: process.env.PAYPAL_SECRET_KEY_SANDBOX;

		const getRes = await ax.get(
			`${PPM}/v2/checkout/orders/${paypal.order_id}`,
			{
				auth: { username: clientId, password: secretKey },
			}
		);
		const order = getRes.data;
		const pu = order?.purchase_units?.[0];
		const orderAmount = pu?.amount?.value;
		if (
			Number(orderAmount).toFixed(2) !==
			Number(paypal.expectedUsdAmount).toFixed(2)
		) {
			return res.status(400).json({
				message: `PayPal order amount (${orderAmount}) does not match expected (${paypal.expectedUsdAmount}).`,
			});
		}

		// 4) Patch invoice_id to a unique value for THIS capture (and update custom_id/description)
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
				orderId: paypal.order_id,
				invoice_id: uniqueInvoiceId,
				custom_id: reservation.confirmation_number,
				description,
				auth: { PPM, clientId, secretKey },
			});
		} catch (e) {
			// Non‑fatal: continue to capture. (If PayPal rejected a field, capture can still succeed.)
			console.warn(
				"PATCH metadata (non-fatal):",
				e?.response?.data || e?.message || e
			);
		}

		// 5) Capture (retry once if DUPLICATE_INVOICE_ID still occurs)
		async function tryCaptureOnce() {
			return paypalCaptureApprovedOrder({
				orderId: paypal.order_id,
				cmid: paypal.cmid,
			});
		}

		let capResult;
		try {
			capResult = await tryCaptureOnce();
		} catch (err) {
			const raw = err?._originalError?.text || err?.message || "";
			const isDupInv =
				err?.statusCode === 422 && /DUPLICATE_INVOICE_ID/i.test(raw);
			if (!isDupInv) throw err;

			// Re‑patch with a fresh unique invoice id, then retry capture once
			const freshInvoiceId = buildUniqueInvoiceId(
				reservation.confirmation_number,
				existingCount + 1
			);
			try {
				await patchOrderInvoiceAndDescription({
					orderId: paypal.order_id,
					invoice_id: freshInvoiceId,
					custom_id: reservation.confirmation_number,
					description,
					auth: { PPM, clientId, secretKey },
				});
			} catch (_) {
				// even if patch fails again, attempt capture once more
			}
			capResult = await tryCaptureOnce();
		}

		const cap = capResult?.purchase_units?.[0]?.payments?.captures?.[0] || {};
		if (cap?.status !== "COMPLETED") {
			return res
				.status(402)
				.json({ message: "Payment was not completed.", details: cap });
		}

		const capAmount = toNum2(cap?.amount?.value || usdAmount);
		const vaultId =
			capResult?.payment_source?.card?.attributes?.vault?.id || null;

		// 6) Update reservation (conflict‑free child updates only)
		const setOps = {};
		const pushOps = {};
		const incOps = {};

		// Ensure bounds & pending field exist
		if (!reservation.paypal_details?.bounds) {
			setOps["paypal_details.bounds"] = { base: "USD", limit_usd: limit };
		}
		if (typeof reservation?.paypal_details?.pending_total_usd !== "number") {
			setOps["paypal_details.pending_total_usd"] = 0;
		}

		const isFirstCapture =
			!reservation.paypal_details || !reservation.paypal_details.initial;

		const commonCaptureDoc = {
			order_id: capResult.id,
			capture_id: cap.id,
			capture_status: cap.status,
			amount: cap.amount?.value,
			currency: cap.amount?.currency_code,
			seller_protection: cap?.seller_protection?.status || "UNKNOWN",
			network_transaction_reference: cap?.network_transaction_reference || null,
			cmid: paypal.cmid || null,
			invoice_id: pu?.invoice_id || uniqueInvoiceId, // record which invoice we ended up with
			raw: JSON.parse(JSON.stringify(capResult)),
			created_at: new Date(cap?.create_time || Date.now()),
		};

		if (isFirstCapture) {
			setOps["paypal_details.initial"] = commonCaptureDoc;
			setOps["paypal_details.captured_total_usd"] = capAmount; // first capture uses $set
		} else {
			pushOps["paypal_details.mit"] = commonCaptureDoc; // subsequent captures
			incOps["paypal_details.captured_total_usd"] = capAmount;
		}

		if (vaultId) {
			setOps["paypal_details.vault_id"] = vaultId;
			setOps["paypal_details.vault_status"] = "ACTIVE";
			setOps["paypal_details.vaulted_at"] = new Date();
			setOps["paypal_details.card_brand"] =
				capResult?.payment_source?.card?.brand || null;
			setOps["paypal_details.card_last4"] =
				capResult?.payment_source?.card?.last_digits || null;
			setOps["paypal_details.card_exp"] =
				capResult?.payment_source?.card?.expiry || null;
			setOps["paypal_details.billing_address"] =
				capResult?.payment_source?.card?.billing_address || undefined;
		}

		// Legacy UI fields
		incOps["payment_details.chargeCount"] = 1;
		setOps["payment_details.captured"] = true;
		setOps["payment_details.triggeredAmountUSD"] = capAmount.toFixed(2);
		if (sarAmount)
			setOps["payment_details.triggeredAmountSAR"] =
				toNum2(sarAmount).toFixed(2);
		setOps["payment_details.finalCaptureTransactionId"] = cap.id;

		const newCaptured = toNum2(capturedSoFar + capAmount);
		const fullyPaid = newCaptured >= limit - 1e-9;
		setOps["payment"] = fullyPaid ? "Paid Online" : "Deposit Paid";
		setOps["commissionPaid"] = true;
		if (sarAmount) incOps["paid_amount"] = toNum2(sarAmount);

		const updateDoc = {
			...(Object.keys(setOps).length ? { $set: setOps } : {}),
			...(Object.keys(incOps).length ? { $inc: incOps } : {}),
			...(Object.keys(pushOps).length ? { $push: pushOps } : {}),
		};

		const updated = await Reservations.findByIdAndUpdate(
			reservation._id,
			updateDoc,
			{ new: true }
		).populate("hotelId");

		// 7) Notify
		const hotel = updated.hotelId || {};
		const invoiceModel = {
			...updated.toObject(),
			hotelName: updated.hotelName || hotel.hotelName || "Hotel",
			hotelAddress: hotel.hotelAddress || "",
			hotelCity: hotel.hotelCity || "",
			hotelPhone: hotel.phone || "",
		};
		try {
			await sendEmailWithInvoice(
				invoiceModel,
				updated.customer_details?.email,
				updated.belongsTo
			);
		} catch (_) {}
		try {
			await waSendReservationConfirmation(updated);
		} catch (_) {}
		try {
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

exports.createPayPalOrder = async (req, res) => {
	try {
		const body = req.body || {};
		// Accept either a full purchase_units array or a simple amount
		let purchase_units = body.purchase_units;
		if (!Array.isArray(purchase_units)) {
			const amt = Number(body.usdAmount || 0);
			if (!amt)
				return res.status(400).json({ message: "usdAmount is required." });
			purchase_units = [
				{
					reference_id: "default",
					amount: { currency_code: "USD", value: toCCY(amt) },
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
		});

		const { result } = await ppClient.execute(request);
		return res.status(200).json({ id: result.id });
	} catch (e) {
		console.error("createPayPalOrder error:", e?.response?.data || e);
		return res.status(500).json({ message: "Failed to create PayPal order" });
	}
};
