/** @format */

"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
	REQUIRED_RESERVATION_INDEXES,
	verifyHotelRunnerReservationIndexes,
} = require("./hotelrunnerReservationIndexReadiness");

const exactIndexes = () =>
	REQUIRED_RESERVATION_INDEXES.map((index) => ({
		v: 2,
		name: index.name,
		key: { ...index.key },
		unique: true,
		partialFilterExpression: JSON.parse(
			JSON.stringify(index.partialFilterExpression)
		),
	}));

const modelWithIndexes = (indexes) => ({
	collection: { indexes: async () => indexes },
});

test("readiness accepts only both exact partial unique reservation indexes", async () => {
	const result = await verifyHotelRunnerReservationIndexes({
		ReservationModel: modelWithIndexes(exactIndexes()),
	});
	assert.deepEqual(result, {
		ready: true,
		verifiedIndexes: [
			"uniq_ota_identity_key",
			"uniq_ota_cross_transport_identity_key",
		],
	});
});

test("readiness inspects Reservations indexes without initializing or creating them", async () => {
	let initCalls = 0;
	let createIndexesCalls = 0;
	const ReservationModel = {
		collection: { indexes: async () => exactIndexes() },
		init: async () => {
			initCalls += 1;
		},
		createIndexes: async () => {
			createIndexesCalls += 1;
		},
	};

	const result = await verifyHotelRunnerReservationIndexes({ ReservationModel });
	assert.equal(result.ready, true);
	assert.equal(initCalls, 0);
	assert.equal(createIndexesCalls, 0);
});

test("readiness fails closed when either required index is absent", async () => {
	for (const missingName of REQUIRED_RESERVATION_INDEXES.map(({ name }) => name)) {
		await assert.rejects(
			() =>
				verifyHotelRunnerReservationIndexes({
					ReservationModel: modelWithIndexes(
						exactIndexes().filter((index) => index.name !== missingName)
					),
				}),
			(error) =>
				error.code === "HOTELRUNNER_RESERVATION_INDEX_MISSING" &&
				error.message.includes(missingName)
		);
	}
});

test("readiness rejects altered key, uniqueness, partial filter, sparse, or collation semantics", async () => {
	for (const mutate of [
		(index) => {
			index.key = { anotherField: 1 };
		},
		(index) => {
			index.unique = false;
		},
		(index) => {
			index.partialFilterExpression = { otaIdentityKey: { $exists: true } };
		},
		(index) => {
			index.sparse = true;
		},
		(index) => {
			index.collation = { locale: "en", strength: 2 };
		},
	]) {
		const indexes = exactIndexes();
		mutate(indexes[0]);
		await assert.rejects(
			() =>
				verifyHotelRunnerReservationIndexes({
					ReservationModel: modelWithIndexes(indexes),
				}),
			(error) =>
				error.code === "HOTELRUNNER_RESERVATION_INDEX_MISMATCH" &&
				error.message.includes("uniq_ota_identity_key")
		);
	}
});
