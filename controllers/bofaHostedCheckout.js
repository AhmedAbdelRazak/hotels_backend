"use strict";

const crypto = require("crypto");

const Reservations = require("../models/reservations");
const User = require("../models/user");
const HotelDetails = require("../models/hotel_details");
const { getSarConversionMeta } = require("../services/otaReservationMapper");
const {
	configuredSuperAdminIds,
	isConfiguredSuperAdminId,
	validateUsdAmount,
	checkCheckinEligibility,
} = require("../services/bofaVccPolicy");
const {
	resolveVccProvider,
	resolveServerBillingProfile,
} = require("../services/bofaVccBilling");
const {
	buildHostedCheckoutFields,
	classifyReply,
	declineDisplayMessage,
	parseReply,
	resignHostedCheckoutFields,
	resumableHostedCheckoutFields,
	resolveConfig,
	safeReplyAudit,
	validateConfig,
	verifySignature,
} = require("../services/bofaSecureAcceptance");
const {
	buildBankReferenceNumber,
	buildHostedMerchantDefinedData,
	buildReservationPaymentContext,
} = require("../services/bofaReservationContext");
const {
	getVerifiedBofaCaptureSummary,
} = require("../services/bofaCaptureSummary");
const {
	buildAbandonedSessionAudit,
	canResumeActiveHostedSession,
	canReleaseAbandonedHostedSession,
} = require("../services/bofaHostedSessionState");

const configuredMaxAttempts = Number(process.env.BOFA_VCC_MAX_ATTEMPTS || 2);
const MAX_ATTEMPTS = Number.isFinite(configuredMaxAttempts)
	? Math.max(1, Math.floor(configuredMaxAttempts))
	: 2;
const UNKNOWN_OUTCOME_WARNING =
	"The Bank of America result is not yet conclusive. Do not retry this card until the transaction is checked in Merchant Services using the saved reference.";

const clean = (value, max = 255) =>
	String(value == null ? "" : value)
		.trim()
		.slice(0, max);
const money = (value) => Number(value || 0).toFixed(2);
const round2 = (value) => Math.round(Number(value || 0) * 100) / 100;

const requireSuperAdmin = async (req) => {
	const userId = clean(req?.auth?._id, 64);
	if (!userId) {
		const error = new Error("Authentication required.");
		error.statusCode = 401;
		throw error;
	}
	if (!configuredSuperAdminIds().length) {
		const error = new Error(
			"Bank of America virtual-card access is disabled because no SUPER_ADMIN_ID is configured.",
		);
		error.statusCode = 503;
		error.issue = "BOFA_VCC_SUPER_ADMIN_NOT_CONFIGURED";
		throw error;
	}
	if (!isConfiguredSuperAdminId(userId)) {
		const error = new Error(
			"Only a configured super admin can process OTA virtual cards.",
		);
		error.statusCode = 403;
		error.issue = "BOFA_VCC_SUPER_ADMIN_REQUIRED";
		throw error;
	}
	const user = await User.findById(userId)
		.select("_id name email role activeUser")
		.lean();
	if (!user || user.activeUser === false) {
		const error = new Error("The configured super-admin account is not active.");
		error.statusCode = 403;
		error.issue = "BOFA_VCC_SUPER_ADMIN_INACTIVE";
		throw error;
	}
	return user;
};

const baseStatus = (reservation, provider = "") => {
	const vcc = reservation?.bofa_payment?.vcc || {};
	const sa = reservation?.bofa_payment?.secure_acceptance || {};
	const failed = Number(vcc.failed_attempts_count || 0);
	const lastFailureCode = clean(vcc.last_failure_code);
	const rawLastFailureMessage = clean(vcc.last_failure_message, 600);
	const lastFailureMessage =
		lastFailureCode || rawLastFailureMessage
			? declineDisplayMessage({
					reasonCode: lastFailureCode,
					message: rawLastFailureMessage,
			  })
			: "";
	const charged = !!vcc.charged || !!reservation?.payment_details?.bofaVccCharged;
	const outcomeUnknown = !!vcc.outcome_unknown;
	return {
		alreadyCharged: charged,
		processing: !!vcc.processing,
		outcomeUnknown,
		attemptedBefore: !charged && (outcomeUnknown || failed >= MAX_ATTEMPTS),
		retryAllowed:
			!charged && !outcomeUnknown && failed > 0 && failed < MAX_ATTEMPTS,
		failedAttemptsCount: failed,
		maxAttempts: MAX_ATTEMPTS,
		lastFailureCode,
		lastFailureMessage,
		retryAttemptsRemaining: Math.max(0, MAX_ATTEMPTS - failed),
		lastAttemptAt: vcc.last_attempt_at || null,
		lastSuccessAt: vcc.last_success_at || null,
		lastFailureAt: vcc.last_failure_at || null,
		lastTransactionId: clean(vcc.last_transaction_id),
		lastRequestId: clean(vcc.last_request_id),
		lastMerchantTransactionId: clean(vcc.last_merchant_transaction_id),
		warningMessage: clean(vcc.warning_message, 600),
		capture: getVerifiedBofaCaptureSummary(reservation),
		canDiscardUnsubmittedSession: canReleaseAbandonedHostedSession(reservation),
		provider: provider || clean(vcc.source),
		secureAcceptance: {
			status: clean(sa.status) || "not_started",
			referenceNumber: clean(sa.last_reference_number, 50),
			amountUsd: round2(sa.amount_usd),
			expiresAt: sa.expires_at || null,
			lastCallbackAt: sa.last_callback_at || null,
			lastDecision: clean(sa.last_decision, 30),
			lastReasonCode: clean(sa.last_reason_code, 20),
			resumeAvailable: canResumeActiveHostedSession(reservation),
		},
	};
};

exports.abandonUnsubmittedSession = async (req, res) => {
	try {
		const actor = await requireSuperAdmin(req);
		const reservationId = clean(req.body?.reservationId, 64);
		const referenceNumber = clean(req.body?.referenceNumber, 50);
		if (!reservationId || !referenceNumber) {
			return res.status(400).json({
				success: false,
				issue: "BOFA_SA_ABANDONED_SESSION_FIELDS_REQUIRED",
				message: "reservationId and the saved Bank of America reference are required.",
			});
		}
		if (req.body?.confirmCardWasNotSubmitted !== true) {
			return res.status(400).json({
				success: false,
				issue: "BOFA_SA_ABANDONED_SESSION_CONFIRMATION_REQUIRED",
				message: "Confirm that the card was not submitted before starting a fresh form.",
			});
		}

		const reservation = await Reservations.findById(reservationId).lean();
		if (!reservation) {
			return res.status(404).json({ success: false, message: "Reservation not found." });
		}
		const provider = resolveVccProvider(reservation.booking_source);
		if (!canReleaseAbandonedHostedSession(reservation, referenceNumber)) {
			return res.status(409).json({
				success: false,
				issue: "BOFA_SA_SESSION_CANNOT_BE_DISCARDED",
				message:
					"This checkout cannot be discarded because it has bank activity, a different reference, or is no longer an expired blank form.",
				bofaStatus: baseStatus(reservation, provider),
			});
		}

		const now = new Date();
		const audit = buildAbandonedSessionAudit(reservation, {
			actorId: actor._id,
			at: now,
		});
		const updated = await Reservations.findOneAndUpdate(
			{
				_id: reservationId,
				"bofa_payment.secure_acceptance.status": "expired_unconfirmed",
				"bofa_payment.secure_acceptance.last_reference_number": referenceNumber,
				"bofa_payment.secure_acceptance.callbacks.0": { $exists: false },
				"bofa_payment.secure_acceptance.last_callback_at": { $in: [null, ""] },
				"bofa_payment.secure_acceptance.last_transaction_id": { $in: [null, ""] },
				"bofa_payment.secure_acceptance.last_request_id": { $in: [null, ""] },
				"bofa_payment.vcc.last_transaction_id": { $in: [null, ""] },
				"bofa_payment.vcc.last_request_id": { $in: [null, ""] },
				"bofa_payment.vcc.outcome_unknown": true,
				"bofa_payment.vcc.charged": { $ne: true },
				"payment_details.bofaVccCharged": { $ne: true },
			},
			{
				$set: {
					"bofa_payment.vcc.processing": false,
					"bofa_payment.vcc.outcome_unknown": false,
					"bofa_payment.vcc.warning_message": "",
					"bofa_payment.vcc.lock_token": "",
					"bofa_payment.vcc.lock_expires_at": null,
					"bofa_payment.secure_acceptance.status": "abandoned_unsubmitted",
					"bofa_payment.secure_acceptance.abandoned_at": now,
					"bofa_payment.secure_acceptance.abandoned_reason": audit.reason,
				},
				$push: {
					"bofa_payment.secure_acceptance.abandoned_sessions": {
						$each: [audit],
						$slice: -20,
					},
				},
			},
			{ new: true },
		).lean();
		if (!updated) {
			const latest = await Reservations.findById(reservationId).lean();
			return res.status(409).json({
				success: false,
				issue: "BOFA_SA_SESSION_STATE_CHANGED",
				message:
					"The Bank of America state changed while the form was being restarted. No payment state was cleared.",
				bofaStatus: latest ? baseStatus(latest, provider) : null,
			});
		}

		const status = baseStatus(updated, provider);
		return res.status(200).json({
			success: true,
			released: true,
			message: "The unsubmitted form was archived. A fresh secure form can now be started.",
			...status,
			state: status,
		});
	} catch (error) {
		return res.status(error?.statusCode || 500).json({
			success: false,
			issue: error?.issue || "BOFA_SA_ABANDONED_SESSION_FAILED",
			message: error?.message || "The unsubmitted checkout could not be archived.",
		});
	}
};

const markExpiredPendingUnknown = async (reservationId) => {
	const now = new Date();
	await Reservations.updateOne(
		{
			_id: reservationId,
			"bofa_payment.vcc.processing": true,
			"bofa_payment.vcc.charged": { $ne: true },
			"bofa_payment.vcc.lock_expires_at": { $lte: now },
			"bofa_payment.secure_acceptance.status": "pending",
		},
		{
			$set: {
				"bofa_payment.vcc.processing": false,
				"bofa_payment.vcc.outcome_unknown": true,
				"bofa_payment.vcc.warning_message": UNKNOWN_OUTCOME_WARNING,
				"bofa_payment.secure_acceptance.status": "expired_unconfirmed",
			},
		},
	);
};

const storedMaximumUsd = (reservation) => {
	const metadata = reservation?.vcc_payment?.metadata || {};
	const currency = clean(metadata.amount_to_charge_currency, 3).toUpperCase();
	return round2(
		metadata.amount_to_charge_usd ||
			(currency === "USD" ? metadata.amount_to_charge : 0),
	);
};

exports.createSession = async (req, res) => {
	let reservationId = "";
	let lockToken = "";
	try {
		const actor = await requireSuperAdmin(req);
		const config = resolveConfig();
		const configCheck = validateConfig(config);
		if (!configCheck.ok) {
			return res.status(503).json({
				success: false,
				issue: "BOFA_SA_CONFIG_MISSING",
				message:
					"Bank of America Hosted Checkout is not fully configured on the server.",
				configErrors: configCheck.errors,
			});
		}

		reservationId = clean(req.body?.reservationId, 64);
		if (!reservationId) {
			return res.status(400).json({
				success: false,
				issue: "BOFA_VCC_RESERVATION_ID_REQUIRED",
				message: "reservationId is required.",
			});
		}
		const amountValidation = validateUsdAmount(
			req.body?.usdAmount ?? req.body?.amount,
			req.body?.currency || "USD",
		);
		if (!amountValidation.ok) {
			return res.status(400).json({ success: false, ...amountValidation });
		}
		const amountUsd = amountValidation.amountUsd;
		await markExpiredPendingUnknown(reservationId);
		const reservation = await Reservations.findById(reservationId).lean();
		if (!reservation) {
			return res.status(404).json({
				success: false,
				issue: "BOFA_VCC_RESERVATION_NOT_FOUND",
				message: "Reservation not found.",
			});
		}

		const provider = resolveVccProvider(reservation.booking_source);
		const status = baseStatus(reservation, provider);
		const checkin = checkCheckinEligibility(reservation.checkin_date);
		if (!checkin.ok) {
			return res.status(409).json({ success: false, ...checkin, bofaStatus: status });
		}
		const billing = resolveServerBillingProfile(provider, {
			postalCode: req.body?.billingPostalCode,
		});
		if (!billing.ok) {
			return res.status(422).json({
				success: false,
				issue: billing.issue,
				message: billing.message,
				bofaStatus: status,
			});
		}
		if (status.alreadyCharged) {
			return res.status(409).json({
				success: false,
				issue: "BOFA_VCC_ALREADY_CHARGED",
				message: "This reservation was already charged via OTA virtual card.",
				alreadyCharged: true,
				bofaStatus: status,
			});
		}

		if (status.processing && canResumeActiveHostedSession(reservation)) {
			const sa = reservation?.bofa_payment?.secure_acceptance || {};
			const resumeAmountUsd = round2(sa.amount_usd);
			const maximumUsd = storedMaximumUsd(reservation);
			if (maximumUsd > 0 && resumeAmountUsd > maximumUsd + 0.001) {
				return res.status(409).json({
					success: false,
					issue: "BOFA_VCC_AMOUNT_EXCEEDS_SAVED_LIMIT",
					message: `The active checkout amount of $${money(
						resumeAmountUsd,
					)} USD exceeds the saved OTA virtual-card amount of $${money(
						maximumUsd,
					)} USD.`,
					maximumAmountUsd: maximumUsd,
					bofaStatus: status,
				});
			}
			const savedMetadata = sa.outbound_metadata || {};
			const merchantDefinedData = Object.fromEntries(
				Object.entries(savedMetadata).filter(([name]) =>
					/^merchant_defined_data[1-4]$/.test(name),
				),
			);
			const resumeNow = new Date();
			const resumeExpiresAt = new Date(sa.expires_at);
			const savedFields = sa.hosted_request_fields || {};
			const fields = Object.keys(savedFields).length
				? resignHostedCheckoutFields(savedFields, config.secretKey, resumeNow)
				: buildHostedCheckoutFields({
						config,
						referenceNumber: sa.last_reference_number,
						transactionUuid: sa.last_transaction_uuid,
						amountUsd: resumeAmountUsd,
						billTo: billing.billTo,
						merchantDefinedData,
					});
			const resumed = await Reservations.updateOne(
				{
					_id: reservationId,
					"bofa_payment.secure_acceptance.status": "pending",
					"bofa_payment.secure_acceptance.last_reference_number":
						sa.last_reference_number,
					"bofa_payment.secure_acceptance.last_transaction_uuid":
						sa.last_transaction_uuid,
					"bofa_payment.vcc.processing": true,
					"bofa_payment.vcc.charged": { $ne: true },
					"payment_details.bofaVccCharged": { $ne: true },
				},
				{
					$set: {
						"bofa_payment.secure_acceptance.last_signed_at": resumeNow,
						"bofa_payment.secure_acceptance.hosted_request_fields":
							resumableHostedCheckoutFields(fields),
					},
				},
			);
			if (resumed.modifiedCount !== 1) {
				return res.status(409).json({
					success: false,
					issue: "BOFA_SA_SESSION_STATE_CHANGED",
					message:
						"The Bank of America state changed while the secure form was resuming. Refresh the reservation before continuing.",
				});
			}
			return res.status(200).json({
				success: true,
				resumed: true,
				mode: "embedded_hosted_checkout",
				method: "POST",
				endpointUrl: config.endpointUrl,
				fields,
				session: {
					referenceNumber: sa.last_reference_number,
					transactionUuid: sa.last_transaction_uuid,
					amountUsd: resumeAmountUsd,
					currency: "USD",
					expiresAt: resumeExpiresAt,
					provider,
					resumed: true,
				},
			});
		}

		const maximumUsd = storedMaximumUsd(reservation);
		if (maximumUsd > 0 && amountUsd > maximumUsd + 0.001) {
			return res.status(409).json({
				success: false,
				issue: "BOFA_VCC_AMOUNT_EXCEEDS_SAVED_LIMIT",
				message: `The requested charge is $${money(
					amountUsd,
				)} USD, which exceeds the saved OTA virtual-card amount of $${money(
					maximumUsd,
				)} USD.`,
				maximumAmountUsd: maximumUsd,
				bofaStatus: status,
			});
		}
		if (status.processing || status.attemptedBefore) {
			return res.status(409).json({
				success: false,
				issue: status.processing
					? "BOFA_VCC_ALREADY_PROCESSING"
					: "BOFA_VCC_RECONCILIATION_REQUIRED",
				message: status.processing
					? "A Bank of America checkout is already in progress for this reservation."
					: status.warningMessage || UNKNOWN_OUTCOME_WARNING,
				bofaStatus: status,
			});
		}

		const now = new Date();
		const expiresAt = new Date(now.getTime() + config.sessionTtlMs);
		const transactionUuid = crypto.randomUUID();
		const referenceNumber = buildBankReferenceNumber(reservation, now.getTime());
		const hotel = reservation?.hotelId
			? await HotelDetails.findById(reservation.hotelId).select("hotelName").lean()
			: null;
		const paymentContext = buildReservationPaymentContext({
			reservation,
			hotelName: hotel?.hotelName || "",
			provider,
			referenceNumber,
			amountUsd,
			billingProfileId: billing.profileId,
			billingSource: billing.source,
		});
		const merchantDefinedData = buildHostedMerchantDefinedData(paymentContext);
		const fields = buildHostedCheckoutFields({
			config,
			referenceNumber,
			transactionUuid,
			amountUsd,
			billTo: billing.billTo,
			merchantDefinedData,
		});
		lockToken = crypto.randomUUID();
		const lock = await Reservations.findOneAndUpdate(
			{
				_id: reservationId,
				"bofa_payment.vcc.processing": { $ne: true },
				"bofa_payment.vcc.charged": { $ne: true },
				"bofa_payment.vcc.outcome_unknown": { $ne: true },
				"payment_details.bofaVccCharged": { $ne: true },
			},
			{
				$set: {
					"bofa_payment.vcc.processing": true,
					"bofa_payment.vcc.lock_token": lockToken,
					"bofa_payment.vcc.lock_expires_at": expiresAt,
					"bofa_payment.vcc.last_attempt_at": now,
					"bofa_payment.vcc.source": provider,
					"bofa_payment.vcc.warning_message": "",
					"bofa_payment.secure_acceptance.status": "pending",
					"bofa_payment.secure_acceptance.last_signed_at": now,
					"bofa_payment.secure_acceptance.last_reference_number": referenceNumber,
					"bofa_payment.secure_acceptance.last_transaction_uuid": transactionUuid,
					"bofa_payment.secure_acceptance.amount_usd": amountUsd,
					"bofa_payment.secure_acceptance.currency": "USD",
					"bofa_payment.secure_acceptance.transaction_type": "sale",
					"bofa_payment.secure_acceptance.expires_at": expiresAt,
					"bofa_payment.secure_acceptance.created_by": String(actor._id),
					"bofa_payment.secure_acceptance.request_context": paymentContext,
					"bofa_payment.secure_acceptance.outbound_metadata": {
						reference_number: referenceNumber,
						...merchantDefinedData,
					},
					"bofa_payment.secure_acceptance.hosted_request_fields":
						resumableHostedCheckoutFields(fields),
					"bofa_payment.vcc.metadata": paymentContext,
				},
			},
			{ new: true },
		);
		if (!lock) {
			return res.status(409).json({
				success: false,
				issue: "BOFA_VCC_ALREADY_PROCESSING",
				message:
					"This reservation is already processing, charged, or waiting for reconciliation.",
			});
		}

		return res.status(200).json({
			success: true,
			mode: "embedded_hosted_checkout",
			method: "POST",
			endpointUrl: config.endpointUrl,
			fields,
			session: {
				referenceNumber,
				transactionUuid,
				amountUsd,
				currency: "USD",
				expiresAt,
				provider,
			},
		});
	} catch (error) {
		if (lockToken && reservationId) {
			await Reservations.updateOne(
				{
					_id: reservationId,
					"bofa_payment.vcc.lock_token": lockToken,
					"bofa_payment.secure_acceptance.status": "pending",
				},
				{
					$set: {
						"bofa_payment.vcc.processing": false,
						"bofa_payment.vcc.lock_token": "",
						"bofa_payment.vcc.lock_expires_at": null,
						"bofa_payment.secure_acceptance.status": "session_failed",
					},
				},
			).catch(() => {});
		}
		return res.status(error?.statusCode || 500).json({
			success: false,
			issue: error?.issue || "BOFA_SA_SESSION_FAILED",
			message:
				error?.message || "Failed to create the Bank of America checkout session.",
		});
	}
};

const callbackEventId = (reply) =>
	crypto
		.createHash("sha256")
		.update(
			[
				reply.transactionUuid,
				reply.transactionId,
				reply.decision,
				reply.reasonCode,
			].join("|"),
			"utf8",
		)
		.digest("hex");

const processCallback = async (payload, source) => {
	const config = resolveConfig();
	const configCheck = validateConfig(config);
	if (!configCheck.ok) {
		const error = new Error("Bank of America callback verification is not configured.");
		error.statusCode = 503;
		throw error;
	}
	const signature = verifySignature(payload, config.secretKey);
	if (!signature.ok) {
		const error = new Error("The Bank of America response signature is invalid.");
		error.statusCode = 400;
		error.issue = "BOFA_SA_INVALID_SIGNATURE";
		throw error;
	}
	const reply = parseReply(payload, signature.names);
	if (!reply.validRequiredFields) {
		const error = new Error("The signed Bank of America response is incomplete.");
		error.statusCode = 400;
		error.issue = "BOFA_SA_INCOMPLETE_SIGNED_RESPONSE";
		throw error;
	}
	const reservation = await Reservations.findOne({
		"bofa_payment.secure_acceptance.last_reference_number": reply.referenceNumber,
	}).lean();
	if (!reservation) {
		const error = new Error("No reservation matches this Bank of America reference.");
		error.statusCode = 404;
		error.issue = "BOFA_SA_RESERVATION_NOT_FOUND";
		throw error;
	}
	const sa = reservation?.bofa_payment?.secure_acceptance || {};
	const expected = {
		referenceNumber: clean(sa.last_reference_number, 50),
		transactionUuid: clean(sa.last_transaction_uuid, 64),
		amountUsd: round2(sa.amount_usd),
		currency: clean(sa.currency, 3).toUpperCase(),
		transactionType: clean(sa.transaction_type, 20).toLowerCase(),
	};
	if (
		reply.referenceNumber !== expected.referenceNumber ||
		reply.transactionUuid !== expected.transactionUuid ||
		money(reply.amountUsd) !== money(expected.amountUsd) ||
		reply.currency !== expected.currency ||
		reply.transactionType !== expected.transactionType
	) {
		const error = new Error(
			"The signed Bank of America response does not match the saved checkout session.",
		);
		error.statusCode = 409;
		error.issue = "BOFA_SA_SESSION_MISMATCH";
		throw error;
	}

	const classification = classifyReply(reply);
	const eventId = callbackEventId(reply);
	if (
		(reservation?.bofa_payment?.secure_acceptance?.callbacks || []).some(
			(item) => item?.event_id === eventId,
		)
	) {
		return { duplicate: true, reply, classification };
	}
	const now = new Date();
	const safeAudit = {
		event_id: eventId,
		at: now,
		source,
		signature_valid: true,
		...safeReplyAudit(reply),
	};
	const conversion = getSarConversionMeta(reply.amountUsd, "USD");
	const amountSar = round2(conversion.totalAmountSar);
	const commonSet = {
		"bofa_payment.secure_acceptance.last_callback_at": now,
		"bofa_payment.secure_acceptance.last_callback_source": source,
		"bofa_payment.secure_acceptance.last_response_signature_valid": true,
		"bofa_payment.secure_acceptance.last_reason_code": reply.reasonCode,
		"bofa_payment.secure_acceptance.last_decision": reply.decision,
		"bofa_payment.secure_acceptance.last_transaction_id": reply.transactionId,
		"bofa_payment.secure_acceptance.last_response_payload": safeReplyAudit(reply),
		"bofa_payment.vcc.processing": false,
		"bofa_payment.vcc.lock_token": "",
		"bofa_payment.vcc.lock_expires_at": null,
		"bofa_payment.vcc.last_transaction_id": reply.transactionId,
		"bofa_payment.vcc.last_reconciliation_id": reply.reconciliationId,
	};
	const update = {
		$set: commonSet,
		$push: {
			"bofa_payment.secure_acceptance.callbacks": { $each: [safeAudit], $slice: -20 },
		},
	};
	if (classification.charged) {
		Object.assign(update.$set, {
			"bofa_payment.secure_acceptance.status": "accepted",
			"bofa_payment.vcc.charged": true,
			"bofa_payment.vcc.outcome_unknown": false,
			"bofa_payment.vcc.last_success_at": now,
			"bofa_payment.vcc.last_failure_message": "",
			"bofa_payment.vcc.last_failure_code": "",
			"bofa_payment.vcc.warning_message": "",
			"bofa_payment.vcc.last_capture": safeReplyAudit(reply),
			"payment_details.bofaVccCharged": true,
			"payment_details.bofaVccChargedAt": now,
			"payment_details.bofaVccTransactionId": reply.transactionId,
			"payment_details.bofaSaAccepted": true,
			"payment_details.bofaSaAcceptedAt": now,
		});
		update.$inc = {
			"bofa_payment.vcc.charge_count": 1,
			"bofa_payment.vcc.attempts_count": 1,
			"bofa_payment.vcc.total_captured_usd": reply.amountUsd,
			"bofa_payment.vcc.total_captured_sar": amountSar,
		};
	} else if (classification.status === "declined") {
		Object.assign(update.$set, {
			"bofa_payment.secure_acceptance.status": "declined",
			"bofa_payment.vcc.outcome_unknown": false,
			"bofa_payment.vcc.last_failure_at": now,
			"bofa_payment.vcc.last_failure_code": reply.reasonCode,
			"bofa_payment.vcc.last_failure_message": declineDisplayMessage(reply),
		});
		update.$inc = {
			"bofa_payment.vcc.attempts_count": 1,
			"bofa_payment.vcc.failed_attempts_count": 1,
		};
	} else if (classification.status === "canceled") {
		Object.assign(update.$set, {
			"bofa_payment.secure_acceptance.status": "canceled",
			"bofa_payment.vcc.outcome_unknown": false,
		});
	} else {
		Object.assign(update.$set, {
			"bofa_payment.secure_acceptance.status": classification.status,
			"bofa_payment.vcc.outcome_unknown": true,
			"bofa_payment.vcc.warning_message": UNKNOWN_OUTCOME_WARNING,
		});
	}

	const filter = {
		_id: reservation._id,
		"bofa_payment.secure_acceptance.last_reference_number": expected.referenceNumber,
		"bofa_payment.secure_acceptance.last_transaction_uuid": expected.transactionUuid,
		"bofa_payment.secure_acceptance.callbacks.event_id": { $ne: eventId },
	};
	if (classification.charged) {
		filter["bofa_payment.vcc.charged"] = { $ne: true };
		filter["payment_details.bofaVccCharged"] = { $ne: true };
	}
	const updated = await Reservations.findOneAndUpdate(filter, update, { new: true }).lean();
	if (!updated) {
		const current = await Reservations.findById(reservation._id).lean();
		const duplicate = (
			current?.bofa_payment?.secure_acceptance?.callbacks || []
		).some((item) => item?.event_id === eventId);
		if (duplicate || (classification.charged && current?.bofa_payment?.vcc?.charged)) {
			return { duplicate: true, reply, classification };
		}
		const error = new Error("The payment result could not be applied safely.");
		error.statusCode = 409;
		error.issue = "BOFA_SA_STATE_CONFLICT";
		throw error;
	}
	return { duplicate: false, reply, classification };
};

exports.merchantCallback = async (req, res) => {
	try {
		const result = await processCallback(req.body || {}, "merchant_post");
		return res.status(200).json({
			success: true,
			received: true,
			duplicate: result.duplicate,
		});
	} catch (error) {
		return res.status(error?.statusCode || 500).json({
			success: false,
			received: false,
			issue: error?.issue || "BOFA_SA_CALLBACK_FAILED",
			message: error?.message || "Failed to verify the payment result.",
		});
	}
};

const htmlEscape = (value) =>
	String(value || "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");

exports.customerCallback = async (req, res) => {
	try {
		const result = await processCallback(req.body || {}, "customer_response");
		const config = resolveConfig();
		const status = result.classification.charged
			? "Payment approved"
			: result.classification.status === "declined"
				? "Payment declined"
				: result.classification.status === "canceled"
					? "Payment canceled"
					: "Payment result pending review";
		res.set({
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "no-store",
			"Content-Security-Policy": `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors ${config.appOrigin}`,
		});
		return res.status(200).send(`<!doctype html><html lang="en" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${htmlEscape(
			status,
		)}</title><style>body{font-family:Arial,sans-serif;margin:0;padding:32px;color:#172033;background:#fff}h1{font-size:22px}</style></head><body><h1>${htmlEscape(
			status,
		)}</h1><p>You can return to the reservation window.</p><script>try{window.parent.postMessage({type:"BOFA_HOSTED_CHECKOUT_RESULT",status:${JSON.stringify(
			result.classification.status,
		)}},${JSON.stringify(config.appOrigin)})}catch(e){}</script></body></html>`);
	} catch (error) {
		return res.status(error?.statusCode || 500).send("Payment result could not be verified.");
	}
};

exports.getStatus = async (req, res) => {
	try {
		await requireSuperAdmin(req);
		const reservationId = clean(req.params?.reservationId, 64);
		if (!reservationId) {
			return res.status(400).json({ success: false, message: "reservationId is required." });
		}
		await markExpiredPendingUnknown(reservationId);
		const reservation = await Reservations.findById(reservationId).lean();
		if (!reservation) {
			return res.status(404).json({ success: false, message: "Reservation not found." });
		}
		const provider = resolveVccProvider(reservation.booking_source);
		const status = baseStatus(reservation, provider);
		return res.status(200).json({ success: true, ...status, state: status });
	} catch (error) {
		return res.status(error?.statusCode || 500).json({
			success: false,
			issue: error?.issue || "BOFA_VCC_STATUS_FAILED",
			message: error?.message || "Failed to fetch the virtual-card status.",
		});
	}
};

exports.getHealth = async (req, res) => {
	try {
		await requireSuperAdmin(req);
		const config = resolveConfig();
		const check = validateConfig(config);
		return res.status(200).json({
			success: true,
			timestamp: new Date().toISOString(),
			integration: "Bank of America Secure Acceptance Hosted Checkout",
			mode: "embedded",
			environment: config.environment,
			endpointHost: new URL(config.endpointUrl).host,
			readyForCharge: check.ok,
			checks: check,
			config: {
				profileConfigured: !!config.profileId,
				accessKeyConfigured: !!config.accessKey,
				secretConfigured: !!config.secretKey,
				appOrigin: config.appOrigin,
			},
		});
	} catch (error) {
		return res.status(error?.statusCode || 500).json({
			success: false,
			issue: error?.issue || "BOFA_SA_HEALTH_FAILED",
			message: error?.message || "Failed to check Bank of America configuration.",
		});
	}
};

exports.healthCallback = (source) => (_req, res) =>
	res.status(200).json({ ok: true, source });
