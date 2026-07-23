"use strict";

const crypto = require("crypto");
const moment = require("moment-timezone");

const DEFAULT_TIME_ZONE = "Asia/Riyadh";
const DEFAULT_MAX_USD = 100000;

const configuredSuperAdminIds = (env = process.env) =>
	[env.SUPER_ADMIN_ID, env.REACT_APP_SUPER_ADMIN_ID]
		.flatMap((value) => String(value || "").split(","))
		.map((value) => value.trim())
		.filter((value, index, values) => value && values.indexOf(value) === index);

const isConfiguredSuperAdminId = (userId, env = process.env) =>
	configuredSuperAdminIds(env).includes(String(userId || "").trim());

const validateUsdAmount = (
	rawAmount,
	rawCurrency = "USD",
	maxUsd = Number(process.env.BOFA_VCC_MAX_USD || DEFAULT_MAX_USD),
) => {
	const currency = String(rawCurrency || "USD").trim().toUpperCase();
	if (currency !== "USD") {
		return {
			ok: false,
			issue: "BOFA_VCC_USD_REQUIRED",
			message: "OTA virtual card charges must be entered and processed in USD.",
		};
	}

	const normalized =
		typeof rawAmount === "string" ? rawAmount.trim() : rawAmount;
	if (
		normalized === "" ||
		normalized == null ||
		!/^\d+(?:\.\d{1,2})?$/.test(String(normalized))
	) {
		return {
			ok: false,
			issue: "BOFA_VCC_INVALID_AMOUNT",
			message:
				"Enter a valid USD amount greater than 0 with no more than two decimal places.",
		};
	}

	const amountUsd = Number(normalized);
	const safeMax = Number.isFinite(maxUsd) && maxUsd > 0 ? maxUsd : DEFAULT_MAX_USD;
	if (!Number.isFinite(amountUsd) || amountUsd <= 0 || amountUsd > safeMax) {
		return {
			ok: false,
			issue: "BOFA_VCC_INVALID_AMOUNT",
			message: `Enter a USD amount greater than 0 and no more than $${safeMax.toFixed(
				2,
			)}.`,
		};
	}

	return { ok: true, amountUsd: Math.round(amountUsd * 100) / 100, currency };
};

const dateKeyInTimeZone = (value, timeZone = DEFAULT_TIME_ZONE) => {
	const parsed = moment(value);
	if (!parsed.isValid()) return "";
	return parsed.tz(timeZone).format("YYYY-MM-DD");
};

const checkCheckinEligibility = (
	checkinDate,
	{ now = new Date(), timeZone = process.env.BOFA_VCC_TIME_ZONE || DEFAULT_TIME_ZONE } = {},
) => {
	const checkinDateKey = dateKeyInTimeZone(checkinDate, timeZone);
	const todayDateKey = dateKeyInTimeZone(now, timeZone);
	if (!checkinDateKey) {
		return {
			ok: false,
			issue: "BOFA_VCC_CHECKIN_DATE_REQUIRED",
			message:
				"This OTA virtual card cannot be processed because the reservation check-in date is missing or invalid.",
			checkinDate: "",
			todayDate: todayDateKey,
			timeZone,
		};
	}
	if (checkinDateKey > todayDateKey) {
		return {
			ok: false,
			issue: "BOFA_VCC_CHECKIN_NOT_REACHED",
			message: `This OTA virtual card cannot be processed before check-in. Check-in is ${checkinDateKey}; today is ${todayDateKey} (${timeZone}).`,
			checkinDate: checkinDateKey,
			todayDate: todayDateKey,
			timeZone,
		};
	}
	return {
		ok: true,
		checkinDate: checkinDateKey,
		todayDate: todayDateKey,
		timeZone,
	};
};

const isLuhnValid = (value) => {
	const number = String(value || "").replace(/\D/g, "");
	if (!number || /^(\d)\1+$/.test(number)) return false;
	let sum = 0;
	let doubleDigit = false;
	for (let index = number.length - 1; index >= 0; index -= 1) {
		let digit = Number(number[index]);
		if (doubleDigit) {
			digit *= 2;
			if (digit > 9) digit -= 9;
		}
		sum += digit;
		doubleDigit = !doubleDigit;
	}
	return sum % 10 === 0;
};

const validateCard = (
	{ number, cvv, expirationMonth, expirationYear, type },
	{ now = new Date() } = {},
) => {
	const cardNumber = String(number || "").replace(/\D/g, "");
	const securityCode = String(cvv || "").replace(/\D/g, "");
	const month = Number(expirationMonth);
	const year = Number(expirationYear);
	const cardType = String(type || "").trim();

	if (cardNumber.length < 12 || cardNumber.length > 19 || !isLuhnValid(cardNumber)) {
		return {
			ok: false,
			issue: "BOFA_VCC_INVALID_CARD_NUMBER",
			message: "Enter a valid card number.",
		};
	}
	if (!cardType) {
		return {
			ok: false,
			issue: "BOFA_VCC_CARD_TYPE_REQUIRED",
			message: "The card brand could not be identified.",
		};
	}
	const expectedCvvLength = cardType === "003" ? 4 : 3;
	if (securityCode.length !== expectedCvvLength) {
		return {
			ok: false,
			issue: "BOFA_VCC_INVALID_CVV",
			message: `Enter the card's ${expectedCvvLength}-digit security code.`,
		};
	}
	if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(year)) {
		return {
			ok: false,
			issue: "BOFA_VCC_INVALID_EXPIRY",
			message: "Enter a valid card expiration date in MM/YY format.",
		};
	}
	const currentYear = now.getUTCFullYear();
	const currentMonth = now.getUTCMonth() + 1;
	if (year < currentYear || (year === currentYear && month < currentMonth)) {
		return {
			ok: false,
			issue: "BOFA_VCC_CARD_EXPIRED",
			message: "This virtual card is expired.",
		};
	}
	return { ok: true };
};

const buildMerchantTransactionId = ({ merchantId, reservationId, attemptId }) => {
	const prefix = String(merchantId || "JB")
		.replace(/[^a-zA-Z0-9]/g, "")
		.slice(-4)
		.padStart(4, "J");
	const digest = crypto
		.createHash("sha256")
		.update(`${reservationId || ""}:${attemptId || ""}`, "utf8")
		.digest("hex")
		.slice(0, 26);
	return `${prefix}${digest}`.slice(0, 30);
};

const classifyTimeoutVoidResult = ({ httpStatus, data } = {}) => {
	const statusCode = Number(httpStatus || 0);
	const payload = data && typeof data === "object" ? data : {};
	const status = String(payload.status || "").trim().toUpperCase();
	const reason = String(payload.reason || "").trim().toUpperCase();
	const transactionId = String(payload.id || "").trim();
	const canceled =
		statusCode >= 200 &&
		statusCode < 300 &&
		["VOIDED", "REVERSED"].includes(status) &&
		Boolean(transactionId);

	return {
		canceled,
		status,
		reason,
		transactionId,
		message: canceled
			? "The timed-out sale was canceled successfully by Bank of America."
			: "The timeout void was not conclusively successful. Reconcile the original transaction before retrying.",
	};
};

module.exports = {
	DEFAULT_TIME_ZONE,
	configuredSuperAdminIds,
	isConfiguredSuperAdminId,
	validateUsdAmount,
	dateKeyInTimeZone,
	checkCheckinEligibility,
	isLuhnValid,
	validateCard,
	buildMerchantTransactionId,
	classifyTimeoutVoidResult,
};
