/** @format */

const crypto = require("crypto");
const {
	hashStable,
} = require("./hotelrunnerFirstOtaFallbackCanonical");
const {
	validateHotelRunnerFallbackCreationAuthorization,
} = require("./hotelrunnerFallbackIngressGate");

const clean = (value) => String(value ?? "").trim();

function buildHotelRunnerFirstFallbackCreationMarker(boundary = {}) {
	const proof = boundary.confirmedEmptyProof || {};
	const creationAuthorization = boundary.creationAuthorization;
	const checkedAt = new Date(proof.checkedAt || "");
	const expiresAt = new Date(proof.expiresAt || "");
	if (
		boundary.mode !== "confirmed_empty_email_fallback" ||
		!clean(boundary.fallbackJobId) ||
		!clean(boundary.hotelId) ||
		!clean(boundary.provider) ||
		!clean(boundary.confirmationNumber) ||
		!clean(boundary.identityKey) ||
		!clean(boundary.inboundEmailId) ||
		!validateHotelRunnerFallbackCreationAuthorization(
			creationAuthorization,
			boundary
		) ||
		!Number.isFinite(checkedAt.getTime()) ||
		!Number.isFinite(expiresAt.getTime())
	) {
		return null;
	}
	return {
		version: 1,
		mode: "confirmed_empty_email_fallback",
		fallbackJobId: clean(boundary.fallbackJobId),
		hotelId: clean(boundary.hotelId).toLowerCase(),
		provider: clean(boundary.provider).toLowerCase(),
		confirmationNumber: clean(boundary.confirmationNumber).toLowerCase(),
		identityKey: clean(boundary.identityKey).toLowerCase(),
		inboundEmailId: clean(boundary.inboundEmailId).toLowerCase(),
		inboundEmailHash: clean(boundary.inboundEmailHash).toLowerCase(),
		normalizedReservationHash: clean(
			boundary.normalizedReservationHash
		).toLowerCase(),
		resolvedHotelProofHash: clean(boundary.resolvedHotelProofHash).toLowerCase(),
		archiveFingerprint: clean(boundary.archiveFingerprint).toLowerCase(),
		hrIdFingerprint: clean(boundary.hrIdFingerprint).toLowerCase(),
		lookupConfirmationNumber: clean(boundary.lookupConfirmationNumber),
		lookupConfirmationHash: clean(boundary.lookupConfirmationHash).toLowerCase(),
		confirmedEmptyProof: creationAuthorization.proof,
		creationAuthorization,
	};
}

function equalStableValue(left, right) {
	let leftHash = "";
	let rightHash = "";
	try {
		leftHash = hashStable(left);
		rightHash = hashStable(right);
	} catch (_error) {
		return false;
	}
	if (
		!/^[a-f0-9]{64}$/.test(leftHash) ||
		!/^[a-f0-9]{64}$/.test(rightHash)
	) {
		return false;
	}
	const leftBuffer = Buffer.from(leftHash, "hex");
	const rightBuffer = Buffer.from(rightHash, "hex");
	return (
		leftBuffer.length === rightBuffer.length &&
		crypto.timingSafeEqual(leftBuffer, rightBuffer)
	);
}

function reservationHasExactHotelRunnerFirstFallbackCreationMarker(
	reservation,
	boundary
) {
	const expected = buildHotelRunnerFirstFallbackCreationMarker(boundary);
	const actual = reservation?.supplierData?.hotelRunnerFirstFallbackCreation;
	return Boolean(
		expected &&
		actual &&
		typeof actual === "object" &&
		!Array.isArray(actual) &&
		equalStableValue(actual, expected)
	);
}

function applyHotelRunnerFirstFallbackCreationMarker(document, boundary) {
	const marker = buildHotelRunnerFirstFallbackCreationMarker(boundary);
	if (!marker || !document || typeof document !== "object") return false;
	document.supplierData = {
		...(document.supplierData || {}),
		hotelRunnerFirstFallbackCreation: marker,
	};
	return true;
}

module.exports = {
	applyHotelRunnerFirstFallbackCreationMarker,
	buildHotelRunnerFirstFallbackCreationMarker,
	reservationHasExactHotelRunnerFirstFallbackCreationMarker,
};
