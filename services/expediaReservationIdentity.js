/** @format */

const {
	normalizeConfirmation,
	normalizeWhitespace,
} = require("./otaReservationMapper");

const RELIABLE_HOTEL_CONFIRMATION_SOURCES = new Set([
	"row_confirmation_cell",
	"detail_hotel_confirmation_code",
]);

const RELIABLE_ITINERARY_SOURCES = new Set(["detail_itinerary_number"]);

const normalizeLine = (value) => String(value || "").replace(/\s+/g, " ").trim();

const escapeRegex = (value = "") =>
	String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const isMongoObjectIdLike = (value = "") => /^[a-f0-9]{24}$/i.test(String(value || ""));

const valueAppearsNearLabel = ({
	text = "",
	value = "",
	labelPattern,
	maxLookahead = 5,
}) => {
	const normalizedValue = normalizeConfirmation(value);
	if (!normalizedValue || !text || !labelPattern) return false;
	const valuePattern = new RegExp(`\\b${escapeRegex(normalizedValue)}\\b`, "i");
	const lines = String(text || "")
		.split(/\r?\n/)
		.map(normalizeLine)
		.filter(Boolean);

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (!labelPattern.test(line)) continue;
		if (valuePattern.test(line)) return true;
		for (
			let valueIndex = index + 1;
			valueIndex < Math.min(lines.length, index + 1 + maxLookahead);
			valueIndex += 1
		) {
			if (labelPattern.test(lines[valueIndex])) break;
			if (valuePattern.test(lines[valueIndex])) return true;
		}
	}

	const compactText = normalizeWhitespace(text);
	const labelMatch = labelPattern.exec(compactText);
	if (!labelMatch) return false;
	const nearby = compactText.slice(
		labelMatch.index,
		labelMatch.index + labelMatch[0].length + 180
	);
	return valuePattern.test(nearby);
};

const candidateEvidenceText = (candidate = {}) =>
	[
		candidate.sourceSnippet,
		candidate.paymentSectionSnippet,
		candidate.detailSnippet,
	]
		.filter(Boolean)
		.join("\n");

const isReliableExpediaHotelConfirmation = (candidate = {}, value = "") => {
	const normalized = normalizeConfirmation(value);
	if (!normalized) return false;
	if (RELIABLE_HOTEL_CONFIRMATION_SOURCES.has(candidate.hotelConfirmationNumberSource)) {
		return true;
	}
	return valueAppearsNearLabel({
		text: candidateEvidenceText(candidate),
		value: normalized,
		labelPattern: /^(?:hotel\s+confirmation(?:\s+code)?|confirmation\s+code)\b/i,
	});
};

const isReliableExpediaItineraryNumber = (candidate = {}, value = "") => {
	const normalized = normalizeConfirmation(value);
	if (!normalized) return false;
	if (RELIABLE_ITINERARY_SOURCES.has(candidate.itineraryNumberSource)) return true;
	return valueAppearsNearLabel({
		text: candidateEvidenceText(candidate),
		value: normalized,
		labelPattern: /^itinerary\s+number\b/i,
		maxLookahead: 3,
	});
};

const addLookupValue = (values, value) => {
	const normalized = normalizeConfirmation(value);
	if (!normalized || isMongoObjectIdLike(normalized)) return;
	if (!values.includes(normalized)) values.push(normalized);
};

const getExpediaCandidateLookupValues = (candidate = {}) => {
	const values = [];
	addLookupValue(values, candidate.confirmationNumber);
	addLookupValue(values, candidate.reservationId);

	const hotelConfirmationNumber = normalizeConfirmation(
		candidate.hotelConfirmationNumber
	);
	if (
		hotelConfirmationNumber &&
		isReliableExpediaHotelConfirmation(candidate, hotelConfirmationNumber)
	) {
		addLookupValue(values, hotelConfirmationNumber);
	}

	const itineraryNumber = normalizeConfirmation(candidate.itineraryNumber);
	if (itineraryNumber && isReliableExpediaItineraryNumber(candidate, itineraryNumber)) {
		addLookupValue(values, itineraryNumber);
	}

	for (const alternate of Array.isArray(candidate.alternateConfirmationNumbers)
		? candidate.alternateConfirmationNumbers
		: []) {
		const normalized = normalizeConfirmation(alternate);
		if (!normalized) continue;
		if (normalized === hotelConfirmationNumber) {
			if (isReliableExpediaHotelConfirmation(candidate, normalized)) {
				addLookupValue(values, normalized);
			}
			continue;
		}
		if (normalized === itineraryNumber) {
			if (isReliableExpediaItineraryNumber(candidate, normalized)) {
				addLookupValue(values, normalized);
			}
			continue;
		}
		if (
			normalized === normalizeConfirmation(candidate.confirmationNumber) ||
			normalized === normalizeConfirmation(candidate.reservationId)
		) {
			addLookupValue(values, normalized);
		}
	}

	return values;
};

module.exports = {
	getExpediaCandidateLookupValues,
	isReliableExpediaHotelConfirmation,
	isReliableExpediaItineraryNumber,
};
