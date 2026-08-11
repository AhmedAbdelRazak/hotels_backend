/** @format */

"use strict";

function decimalMoneyParts(value) {
	const source = typeof value === "string" ? value.trim() : String(value);
	const match = source.match(/^([+-]?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i);
	if (!match) return null;
	const exponent = Number(match[4] || 0);
	if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 100) return null;
	const fraction = match[3] || "";
	const digits = `${match[2]}${fraction}`.replace(/^0+(?=\d)/, "");
	return {
		coefficient: BigInt(`${match[1] === "-" ? "-" : ""}${digits || "0"}`),
		scale: fraction.length - exponent,
	};
}

function roundedDecimalInteger(parts, targetScale) {
	if (!parts || !Number.isSafeInteger(targetScale)) return null;
	const shift = targetScale - parts.scale;
	let result;
	if (shift >= 0) {
		result = parts.coefficient * 10n ** BigInt(shift);
	} else {
		const divisor = 10n ** BigInt(-shift);
		const negative = parts.coefficient < 0n;
		const absolute = negative ? -parts.coefficient : parts.coefficient;
		const quotient = absolute / divisor;
		const remainder = absolute % divisor;
		const rounded = remainder * 2n >= divisor ? quotient + 1n : quotient;
		result = negative ? -rounded : rounded;
	}
	if (
		result > BigInt(Number.MAX_SAFE_INTEGER) ||
		result < BigInt(Number.MIN_SAFE_INTEGER)
	) {
		return null;
	}
	return Number(result);
}

function decimalMoneyCents(value) {
	return roundedDecimalInteger(decimalMoneyParts(value), 2);
}

function multipliedMoneyCents(left, right) {
	// Parse each operand before multiplication so a binary floating product
	// cannot move an exact decimal half-cent to the opposite rounding side.
	const leftParts = decimalMoneyParts(left);
	const rightParts = decimalMoneyParts(right);
	if (!leftParts || !rightParts) return null;
	return roundedDecimalInteger(
		{
			coefficient: leftParts.coefficient * rightParts.coefficient,
			scale: leftParts.scale + rightParts.scale,
		},
		2
	);
}

function roundedMoneyProduct(left, right) {
	const cents = multipliedMoneyCents(left, right);
	return Number.isSafeInteger(cents) ? cents / 100 : null;
}

module.exports = {
	decimalMoneyCents,
	multipliedMoneyCents,
	roundedMoneyProduct,
};
