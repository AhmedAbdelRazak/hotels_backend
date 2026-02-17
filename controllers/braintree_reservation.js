/** @format */
"use strict";

const braintree = require("braintree");
const Reservations = require("../models/reservations");
const HotelDetails = require("../models/hotel_details");
const Rooms = require("../models/rooms");

const VCC_PROMPT_WARNING_MESSAGE =
	"This reservation was prompted once before, please reach out to Ahmed Admin for more details";
const VCC_RETRY_AVAILABLE_MESSAGE =
	"One VCC attempt failed before. One final retry is still allowed.";
const VCC_ROOM_UNASSIGNED_CONFIRM_MESSAGE =
	"Are you sure you want to proceed without assigning a room to the reservation?";
const VCC_MAX_ATTEMPTS = Math.max(
	1,
	Number(process.env.BRAINTREE_VCC_MAX_ATTEMPTS || 2),
);

const toNum2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const toCCY = (n) => Number(n || 0).toFixed(2);
const toISODate = (value) => {
	if (!value) return "";
	const d = new Date(value);
	if (Number.isNaN(d.getTime())) return "";
	return d.toISOString().slice(0, 10);
};

const normalizeReservationStatus = (status) =>
	String(status || "")
		.trim()
		.toLowerCase()
		.replace(/\s+/g, "_");

const isCancelledOrNoShow = (status) => {
	const normalized = normalizeReservationStatus(status);
	return normalized.includes("cancel") || /no[_-]?show/.test(normalized);
};

const splitCardholderName = (value) => {
	const raw = String(value || "")
		.trim()
		.replace(/\s+/g, " ");
	if (!raw) return { firstName: "Virtual", lastName: "Card" };
	const chunks = raw.split(" ");
	if (chunks.length === 1) return { firstName: chunks[0], lastName: "Card" };
	return {
		firstName: chunks.slice(0, -1).join(" "),
		lastName: chunks[chunks.length - 1],
	};
};

const resolveProviderKey = (bookingSource) => {
	const normalized = String(bookingSource || "").toLowerCase();
	if (normalized.includes("expedia")) return "expedia";
	if (normalized.includes("agoda")) return "agoda";
	if (normalized.includes("booking")) return "booking";
	return "";
};

const resolveProviderCardholderName = (providerKey) => {
	if (providerKey === "expedia") return "Expedia Virtual Card";
	if (providerKey === "agoda") return "Agoda Virtual Card";
	if (providerKey === "booking") return "Booking.com Virtual Card";
	return "Virtual Card";
};

const createDefaultBraintreePaymentState = () => ({
	source: "",
	charged: false,
	processing: false,
	charge_count: 0,
	attempts_count: 0,
	failed_attempts_count: 0,
	blocked_after_failure: false,
	total_captured_usd: 0,
	last_attempt_at: null,
	last_success_at: null,
	last_failure_at: null,
	last_failure_message: "",
	last_failure_code: "",
	last_transaction_id: "",
	last_status: "",
	last_processor_response_code: "",
	last_processor_response_text: "",
	last_gateway_rejection_reason: "",
	warning_message: "",
	last_capture: {},
	metadata: {},
	attempts: [],
});

const normalizeBraintreePaymentState = (state) => {
	const base = createDefaultBraintreePaymentState();
	const next = {
		...base,
		...(state && typeof state === "object" ? state : {}),
	};
	next.attempts = Array.isArray(state?.attempts) ? state.attempts : [];
	next.metadata =
		state && typeof state.metadata === "object" && state.metadata
			? state.metadata
			: {};
	return next;
};

const buildStatusFromBraintreeState = (state) => {
	const normalized = normalizeBraintreePaymentState(state);
	const failedAttemptsCount = Number(normalized.failed_attempts_count || 0);
	const alreadyCharged = !!normalized.charged;
	const attemptedBefore =
		!alreadyCharged && failedAttemptsCount >= Number(VCC_MAX_ATTEMPTS);
	const retryAllowed =
		!alreadyCharged &&
		failedAttemptsCount > 0 &&
		failedAttemptsCount < Number(VCC_MAX_ATTEMPTS);

	return {
		alreadyCharged,
		failedAttemptsCount,
		attemptedBefore,
		retryAllowed,
		lastFailureMessage: normalized.last_failure_message || "",
		warningMessage:
			normalized.warning_message ||
			(retryAllowed ? VCC_RETRY_AVAILABLE_MESSAGE : VCC_PROMPT_WARNING_MESSAGE),
		chargedAt: normalized.last_success_at || null,
		lastAttemptAt: normalized.last_attempt_at || null,
		lastTransactionId: normalized.last_transaction_id || "",
		provider: normalized.source || "",
		maxAttempts: Number(VCC_MAX_ATTEMPTS),
	};
};

const resolveBraintreeMode = () => {
	const explicit = String(process.env.BRAINTREE_ENV || "")
		.trim()
		.toLowerCase();
	if (explicit === "sandbox" || explicit === "production") return explicit;
	return /prod/i.test(String(process.env.NODE_ENV || "")) ? "production" : "sandbox";
};

const resolveBraintreeCredentials = () => {
	const mode = resolveBraintreeMode();
	const isSandbox = mode !== "production";
	const merchantId = isSandbox
		? process.env.BRAINTREE_MERCHANT_ID_TEST || process.env.BRAINTREE_MERCHANT_ID
		: process.env.BRAINTREE_MERCHANT_ID;
	const publicKey = isSandbox
		? process.env.BRAINTREE_PUBLIC_KEY_TEST || process.env.BRAINTREE_PUBLIC_KEY
		: process.env.BRAINTREE_PUBLIC_KEY;
	const privateKey = isSandbox
		? process.env.BRAINTREE_PRIVATE_KEY_TEST || process.env.BRAINTREE_PRIVATE_KEY
		: process.env.BRAINTREE_PRIVATE_KEY;
	const merchantAccountId = isSandbox
		? process.env.BRAINTREE_MERCHANT_ACCOUNT_ID_TEST ||
		  process.env.BRAINTREE_MERCHANT_ACCOUNT_ID
		: process.env.BRAINTREE_MERCHANT_ACCOUNT_ID;

	const missing = [];
	if (!merchantId) missing.push("merchantId");
	if (!publicKey) missing.push("publicKey");
	if (!privateKey) missing.push("privateKey");

	return {
		mode,
		isSandbox,
		merchantId: String(merchantId || "").trim(),
		publicKey: String(publicKey || "").trim(),
		privateKey: String(privateKey || "").trim(),
		merchantAccountId: merchantAccountId
			? String(merchantAccountId).trim()
			: "",
		missing,
	};
};

const resolveBraintreeTokenizationKey = (config) => {
	const isSandbox = !!config?.isSandbox;
	const key = isSandbox
		? process.env.BRAINTREE_TOKENIZATION_KEY_TEST ||
		  process.env.BRAINTREE_TOKENIZATION_KEY
		: process.env.BRAINTREE_TOKENIZATION_KEY_LIVE ||
		  process.env.BRAINTREE_TOKENIZATION_KEY;
	return String(key || "").trim();
};

const getBraintreeGateway = () => {
	const config = resolveBraintreeCredentials();
	if (config.missing.length) {
		const error = new Error(
			`Braintree credentials are not configured (${config.missing.join(", ")}).`,
		);
		error.statusCode = 500;
		error.issue = "BRAINTREE_CONFIG_MISSING";
		throw error;
	}
	return {
		config,
		gateway: new braintree.BraintreeGateway({
			environment:
				config.mode === "production"
					? braintree.Environment.Production
					: braintree.Environment.Sandbox,
			merchantId: config.merchantId,
			publicKey: config.publicKey,
			privateKey: config.privateKey,
		}),
	};
};

const generateClientToken = (gateway) =>
	new Promise((resolve, reject) => {
		gateway.clientToken.generate({}, (error, response) => {
			if (error) return reject(error);
			return resolve(response);
		});
	});

const saleTransaction = (gateway, payload) =>
	new Promise((resolve, reject) => {
		gateway.transaction.sale(payload, (error, result) => {
			if (error) return reject(error);
			return resolve(result);
		});
	});

const extractBraintreeErrors = (errors) => {
	const list = [];
	if (!errors || typeof errors.deepErrors !== "function") return list;
	for (const deepError of errors.deepErrors()) {
		list.push({
			code: deepError.code,
			message: deepError.message,
			attribute: deepError.attribute || "",
		});
	}
	return list;
};

const extractRoomNumbersForReservation = async (reservation) => {
	const set = new Set();
	const add = (value) => {
		const raw = String(value || "").trim();
		if (raw) set.add(raw);
	};

	(Array.isArray(reservation?.roomDetails) ? reservation.roomDetails : []).forEach(
		(room) => add(room?.room_number || room?.roomNumber || room?.number),
	);
	(Array.isArray(reservation?.room_numbers) ? reservation.room_numbers : []).forEach(
		add,
	);
	(Array.isArray(reservation?.bedNumber) ? reservation.bedNumber : []).forEach(add);

	const roomIds = [];
	(Array.isArray(reservation?.roomId) ? reservation.roomId : []).forEach((entry) => {
		if (!entry) return;
		if (typeof entry === "object") {
			add(entry.room_number || entry.roomNumber || entry.number);
			const id = entry._id || entry.id;
			if (id) roomIds.push(String(id));
			return;
		}
		roomIds.push(String(entry));
	});

	if (roomIds.length) {
		const foundRooms = await Rooms.find({ _id: { $in: roomIds } })
			.select("room_number")
			.lean();
		(foundRooms || []).forEach((room) => add(room?.room_number));
	}

	return Array.from(set);
};

const buildReservationMetadata = ({ reservation, hotelName, roomNumbers }) => {
	const guestName =
		reservation?.customer_details?.fullName ||
		reservation?.customer_details?.name ||
		"";
	const confirmationNumber = reservation?.confirmation_number || "";
	const confirmationNumber2 =
		reservation?.customer_details?.confirmation_number2 || "";
	const reservationStatus = normalizeReservationStatus(
		reservation?.reservation_status,
	);
	const cancelledOrNoShow = isCancelledOrNoShow(reservationStatus);

	return {
		provider: resolveProviderKey(reservation?.booking_source || ""),
		bookingSource: reservation?.booking_source || "",
		guestName,
		confirmationNumber,
		confirmationNumber2,
		checkinDate: toISODate(reservation?.checkin_date),
		checkoutDate: toISODate(reservation?.checkout_date),
		hotelName: hotelName || "",
		reservationStatus,
		guestHousedInRoom: roomNumbers.join(", "),
		cancellationContext: cancelledOrNoShow
			? "cancelled_or_no_show"
			: "active_or_completed_stay",
	};
};

const sanitizeGatewayConfig = (config) => ({
	mode: config.mode,
	isSandbox: !!config.isSandbox,
	merchantAccountId: config.merchantAccountId || null,
});

exports.generateBraintreeVccClientToken = async (_req, res) => {
	try {
		const { config, gateway } = getBraintreeGateway();
		const tokenData = await generateClientToken(gateway);
		const tokenizationKey = resolveBraintreeTokenizationKey(config);
		return res.status(200).json({
			success: true,
			env: config.mode,
			clientToken: tokenData?.clientToken || "",
			tokenizationKey,
			gateway: sanitizeGatewayConfig(config),
		});
	} catch (error) {
		console.error("generateBraintreeVccClientToken error:", error);
		return res.status(error?.statusCode || 500).json({
			success: false,
			issue: error?.issue || "BRAINTREE_CLIENT_TOKEN_FAILED",
			message:
				error?.message ||
				"Failed to initialize Braintree for virtual card processing.",
		});
	}
};

exports.getReservationBraintreeVccStatus = async (req, res) => {
	try {
		const reservationId = String(req.params?.reservationId || "").trim();
		if (!reservationId) {
			return res.status(400).json({
				success: false,
				message: "reservationId is required.",
			});
		}
		const reservation = await Reservations.findById(reservationId).lean();
		if (!reservation) {
			return res.status(404).json({
				success: false,
				message: "Reservation not found.",
			});
		}

		const state = normalizeBraintreePaymentState(reservation?.braintree_payment);
		const status = buildStatusFromBraintreeState(state);
		return res.status(200).json({
			success: true,
			...status,
			state,
		});
	} catch (error) {
		console.error("getReservationBraintreeVccStatus error:", error);
		return res.status(500).json({
			success: false,
			message: "Failed to fetch Braintree VCC status.",
		});
	}
};

exports.chargeReservationViaBraintreeVcc = async (req, res) => {
	const now = new Date();
	let reservation = null;
	try {
		const reservationId = String(req.body?.reservationId || "").trim();
		const paymentMethodNonce = String(req.body?.paymentMethodNonce || "").trim();
		const usdAmount = toNum2(req.body?.usdAmount);
		const proceedWithoutRoom = !!req.body?.proceedWithoutRoom;
		const postalCode = String(
			req.body?.billingAddress?.postal_code ||
				req.body?.billingAddress?.postalCode ||
				"",
		)
			.toUpperCase()
			.trim();

		if (!reservationId) {
			return res.status(400).json({
				success: false,
				issue: "VCC_RESERVATION_ID_REQUIRED",
				message: "reservationId is required.",
			});
		}
		if (!paymentMethodNonce) {
			return res.status(400).json({
				success: false,
				issue: "VCC_PAYMENT_NONCE_REQUIRED",
				message: "paymentMethodNonce is required.",
			});
		}
		if (!(usdAmount > 0)) {
			return res.status(400).json({
				success: false,
				issue: "VCC_INVALID_AMOUNT",
				message: "Please provide a valid USD amount.",
			});
		}

		reservation = await Reservations.findById(reservationId);
		if (!reservation) {
			return res.status(404).json({
				success: false,
				issue: "VCC_RESERVATION_NOT_FOUND",
				message: "Reservation not found.",
			});
		}

		const roomNumbers = await extractRoomNumbersForReservation(reservation);
		const reservationStatus = normalizeReservationStatus(
			reservation?.reservation_status,
		);
		const cancelledOrNoShow = isCancelledOrNoShow(reservationStatus);
		if (!cancelledOrNoShow && roomNumbers.length === 0 && !proceedWithoutRoom) {
			return res.status(409).json({
				success: false,
				issue: "VCC_ROOM_CONFIRM_REQUIRED",
				message:
					"Room assignment is missing for this reservation. Confirm you want to proceed without a room assignment.",
				confirmationMessage: VCC_ROOM_UNASSIGNED_CONFIRM_MESSAGE,
			});
		}

		const btState = normalizeBraintreePaymentState(reservation.braintree_payment);
		const currentStatus = buildStatusFromBraintreeState(btState);
		if (currentStatus.alreadyCharged) {
			return res.status(409).json({
				success: false,
				issue: "VCC_ALREADY_CHARGED",
				message: "This reservation was already charged via VCC.",
				alreadyCharged: true,
				braintreeStatus: currentStatus,
			});
		}
		if (currentStatus.attemptedBefore) {
			return res.status(409).json({
				success: false,
				issue: "VCC_ATTEMPTS_EXHAUSTED",
				message:
					currentStatus.warningMessage || VCC_PROMPT_WARNING_MESSAGE,
				attemptedBefore: true,
				braintreeStatus: currentStatus,
			});
		}

		const { config, gateway } = getBraintreeGateway();
		const providerKey = resolveProviderKey(reservation?.booking_source || "");
		const cardholderName = String(
			req.body?.cardholderName || resolveProviderCardholderName(providerKey),
		)
			.trim()
			.replace(/\s+/g, " ");
		const { firstName, lastName } = splitCardholderName(cardholderName);

		const hotel = reservation?.hotelId
			? await HotelDetails.findById(reservation.hotelId).select("hotelName").lean()
			: null;
		const metadata = buildReservationMetadata({
			reservation,
			hotelName: hotel?.hotelName || "",
			roomNumbers,
		});

		const orderId = `BTVCC-${String(
			metadata.confirmationNumber || reservation._id,
		).slice(0, 24)}-${Date.now()}`;
		const salePayload = {
			amount: toCCY(usdAmount),
			paymentMethodNonce,
			orderId: orderId.slice(0, 255),
			customer: {
				firstName,
				lastName,
			},
			options: {
				submitForSettlement: true,
			},
		};
		if (config.merchantAccountId) {
			salePayload.merchantAccountId = config.merchantAccountId;
		}
		if (postalCode) {
			salePayload.billing = {
				postalCode,
			};
		}

		btState.processing = true;
		btState.source = metadata.provider || metadata.bookingSource || "ota";
		btState.last_attempt_at = now;
		btState.metadata = metadata;
		await reservation.save();

		const result = await saleTransaction(gateway, salePayload);
		const transaction = result?.transaction || {};
		const attemptBase = {
			at: new Date(),
			provider: metadata.provider || metadata.bookingSource || "ota",
			amount_usd: usdAmount,
			order_id: salePayload.orderId,
			postal_code: postalCode || "",
			cardholder_name: cardholderName,
		};

		btState.processing = false;
		btState.attempts_count = Number(btState.attempts_count || 0) + 1;
		btState.last_attempt_at = now;

		if (result?.success) {
			btState.charged = true;
			btState.charge_count = Number(btState.charge_count || 0) + 1;
			btState.blocked_after_failure = false;
			btState.total_captured_usd = toNum2(
				Number(btState.total_captured_usd || 0) + usdAmount,
			);
			btState.last_success_at = new Date();
			btState.last_failure_at = null;
			btState.last_failure_message = "";
			btState.last_failure_code = "";
			btState.last_transaction_id = transaction?.id || "";
			btState.last_status = transaction?.status || "";
			btState.last_processor_response_code =
				transaction?.processorResponseCode || "";
			btState.last_processor_response_text =
				transaction?.processorResponseText || "";
			btState.last_gateway_rejection_reason =
				transaction?.gatewayRejectionReason || "";
			btState.warning_message = "";
			btState.last_capture = {
				id: transaction?.id || "",
				status: transaction?.status || "",
				amount: transaction?.amount || toCCY(usdAmount),
				currency: transaction?.currencyIsoCode || "USD",
				orderId: transaction?.orderId || salePayload.orderId,
				processorResponseCode: transaction?.processorResponseCode || "",
				processorResponseText: transaction?.processorResponseText || "",
				gatewayRejectionReason: transaction?.gatewayRejectionReason || "",
				avsErrorResponseCode: transaction?.avsErrorResponseCode || "",
				avsPostalCodeResponseCode:
					transaction?.avsPostalCodeResponseCode || "",
				cvvResponseCode: transaction?.cvvResponseCode || "",
				createdAt: transaction?.createdAt || new Date(),
			};

			const successAttempt = {
				...attemptBase,
				success: true,
				message: `Braintree VCC charge completed (status: ${
					transaction?.status || "submitted_for_settlement"
				}).`,
				transaction_id: transaction?.id || "",
				transaction_status: transaction?.status || "",
				processor_response_code: transaction?.processorResponseCode || "",
				processor_response_text: transaction?.processorResponseText || "",
				card_last4: transaction?.creditCard?.last4 || "",
				card_expiry: transaction?.creditCard?.expirationDate || "",
				card_brand: transaction?.creditCard?.cardType || "",
			};
			btState.attempts.push(successAttempt);

			reservation.braintree_payment = btState;
			reservation.payment_details = {
				...(reservation.payment_details || {}),
				braintreeVccCharged: true,
				braintreeVccChargeAt: new Date(),
				braintreeVccTransactionId: transaction?.id || "",
				lastBraintreeVccFailureAt: null,
				lastBraintreeVccFailureMessage: "",
			};
			await reservation.save();

			return res.status(200).json({
				success: true,
				message: "VCC payment completed via Braintree.",
				transaction: {
					id: transaction?.id || "",
					status: transaction?.status || "",
					amount: transaction?.amount || toCCY(usdAmount),
					currency: transaction?.currencyIsoCode || "USD",
					orderId: transaction?.orderId || salePayload.orderId,
					processorResponseCode: transaction?.processorResponseCode || "",
					processorResponseText: transaction?.processorResponseText || "",
					gatewayRejectionReason: transaction?.gatewayRejectionReason || "",
				},
				braintreeStatus: buildStatusFromBraintreeState(btState),
				reservation,
			});
		}

		const errors = extractBraintreeErrors(result?.errors);
		const failureMessage =
			result?.message ||
			transaction?.processorResponseText ||
			"Braintree could not process this virtual card.";
		const failureCode =
			transaction?.processorResponseCode ||
			transaction?.gatewayRejectionReason ||
			(errors[0] && errors[0].code) ||
			"BRAINTREE_VCC_DECLINED";

		btState.charged = false;
		btState.failed_attempts_count = Number(btState.failed_attempts_count || 0) + 1;
		btState.last_failure_at = new Date();
		btState.last_failure_message = failureMessage;
		btState.last_failure_code = String(failureCode);
		btState.last_status = transaction?.status || "";
		btState.last_transaction_id = transaction?.id || "";
		btState.last_processor_response_code =
			transaction?.processorResponseCode || "";
		btState.last_processor_response_text =
			transaction?.processorResponseText || "";
		btState.last_gateway_rejection_reason =
			transaction?.gatewayRejectionReason || "";
		btState.blocked_after_failure =
			btState.failed_attempts_count >= Number(VCC_MAX_ATTEMPTS);
		btState.warning_message = btState.blocked_after_failure
			? VCC_PROMPT_WARNING_MESSAGE
			: VCC_RETRY_AVAILABLE_MESSAGE;

		btState.attempts.push({
			...attemptBase,
			success: false,
			message: failureMessage,
			error_code: String(failureCode),
			transaction_id: transaction?.id || "",
			transaction_status: transaction?.status || "",
			processor_response_code: transaction?.processorResponseCode || "",
			processor_response_text: transaction?.processorResponseText || "",
			gateway_rejection_reason: transaction?.gatewayRejectionReason || "",
			errors,
		});

		reservation.braintree_payment = btState;
		reservation.payment_details = {
			...(reservation.payment_details || {}),
			braintreeVccCharged: false,
			lastBraintreeVccFailureAt: btState.last_failure_at,
			lastBraintreeVccFailureMessage: failureMessage,
		};
		await reservation.save();

		return res.status(402).json({
			success: false,
			issue: "VCC_CAPTURE_DECLINED",
			message: failureMessage,
			errors,
			transaction: {
				id: transaction?.id || "",
				status: transaction?.status || "",
				amount: transaction?.amount || toCCY(usdAmount),
				currency: transaction?.currencyIsoCode || "USD",
				orderId: transaction?.orderId || salePayload.orderId,
				processorResponseCode: transaction?.processorResponseCode || "",
				processorResponseText: transaction?.processorResponseText || "",
				gatewayRejectionReason: transaction?.gatewayRejectionReason || "",
			},
			braintreeStatus: buildStatusFromBraintreeState(btState),
			reservation,
		});
	} catch (error) {
		console.error("chargeReservationViaBraintreeVcc error:", error);
		if (reservation) {
			try {
				const btState = normalizeBraintreePaymentState(reservation.braintree_payment);
				btState.processing = false;
				btState.attempts_count = Number(btState.attempts_count || 0) + 1;
				btState.failed_attempts_count = Number(btState.failed_attempts_count || 0) + 1;
				btState.last_attempt_at = new Date();
				btState.last_failure_at = new Date();
				btState.last_failure_code = String(
					error?.issue || error?.type || "BRAINTREE_VCC_CHARGE_FAILED",
				);
				btState.last_failure_message =
					error?.message || "Braintree could not process this virtual card.";
				btState.blocked_after_failure =
					btState.failed_attempts_count >= Number(VCC_MAX_ATTEMPTS);
				btState.warning_message = btState.blocked_after_failure
					? VCC_PROMPT_WARNING_MESSAGE
					: VCC_RETRY_AVAILABLE_MESSAGE;
				btState.attempts.push({
					at: new Date(),
					success: false,
					provider: btState.source || "ota",
					message: btState.last_failure_message,
					error_code: btState.last_failure_code,
				});
				reservation.braintree_payment = btState;
				reservation.payment_details = {
					...(reservation.payment_details || {}),
					braintreeVccCharged: false,
					lastBraintreeVccFailureAt: btState.last_failure_at,
					lastBraintreeVccFailureMessage: btState.last_failure_message,
				};
				await reservation.save();
			} catch (persistError) {
				console.error(
					"chargeReservationViaBraintreeVcc persist error:",
					persistError,
				);
			}
		}

		return res.status(error?.statusCode || 500).json({
			success: false,
			issue: error?.issue || "BRAINTREE_VCC_CHARGE_FAILED",
			message:
				error?.message || "Braintree could not process this virtual card.",
		});
	}
};
