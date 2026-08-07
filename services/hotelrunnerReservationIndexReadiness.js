/** @format */

"use strict";

const Reservations = require("../models/reservations");

const REQUIRED_RESERVATION_INDEXES = Object.freeze([
	{
		name: "uniq_ota_identity_key",
		key: { otaIdentityKey: 1 },
		partialFilterExpression: {
			otaIdentityKey: { $type: "string", $gt: "" },
		},
	},
	{
		name: "uniq_ota_cross_transport_identity_key",
		key: { otaCrossTransportIdentityKey: 1 },
		partialFilterExpression: {
			otaCrossTransportIdentityKey: { $type: "string", $gt: "" },
		},
	},
]);

const stableValue = (value) => {
	if (Array.isArray(value)) return value.map(stableValue);
	if (value && typeof value === "object") {
		return Object.keys(value)
			.sort()
			.reduce((result, key) => {
				result[key] = stableValue(value[key]);
				return result;
			}, {});
	}
	return value;
};

const sameStructure = (left, right) =>
	JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));

const assertReservationIndexDefinition = (actual, expected) => {
	if (!actual) {
		const error = new Error(`Required reservation index is missing: ${expected.name}.`);
		error.code = "HOTELRUNNER_RESERVATION_INDEX_MISSING";
		throw error;
	}
	const exact =
		actual.name === expected.name &&
		actual.unique === true &&
		actual.sparse !== true &&
		actual.collation == null &&
		sameStructure(actual.key, expected.key) &&
		sameStructure(
			actual.partialFilterExpression,
			expected.partialFilterExpression
		);
	if (!exact) {
		const error = new Error(
			`Required reservation index has an unexpected definition: ${expected.name}.`
		);
		error.code = "HOTELRUNNER_RESERVATION_INDEX_MISMATCH";
		throw error;
	}
	return true;
};

const verifyHotelRunnerReservationIndexes = async ({
	ReservationModel = Reservations,
} = {}) => {
	if (!ReservationModel?.collection) {
		const error = new Error("Reservations collection is unavailable for index verification.");
		error.code = "HOTELRUNNER_RESERVATION_INDEX_UNAVAILABLE";
		throw error;
	}
	const indexes = await ReservationModel.collection.indexes();
	for (const expected of REQUIRED_RESERVATION_INDEXES) {
		const matches = indexes.filter((index) => index?.name === expected.name);
		if (matches.length === 0) {
			assertReservationIndexDefinition(undefined, expected);
		}
		if (matches.length !== 1) {
			const error = new Error(
				`Required reservation index is not unique by name: ${expected.name}.`
			);
			error.code = "HOTELRUNNER_RESERVATION_INDEX_MISMATCH";
			throw error;
		}
		assertReservationIndexDefinition(matches[0], expected);
	}
	return {
		ready: true,
		verifiedIndexes: REQUIRED_RESERVATION_INDEXES.map(({ name }) => name),
	};
};

module.exports = {
	REQUIRED_RESERVATION_INDEXES,
	assertReservationIndexDefinition,
	sameStructure,
	verifyHotelRunnerReservationIndexes,
};
