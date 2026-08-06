/** @format */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
	persistHotelRunnerBatch,
	persistHotelRunnerDelivery,
	safeErrorMessage,
} = require("./hotelrunnerEventService");

const rawReservation = (overrides = {}) => ({
	message_uid: "durable-event-uid-1",
	reservation_id: "hr-reservation-1",
	hr_number: "R-1",
	provider_number: "BOOKING-1",
	channel: "bookingcom",
	channel_display: "Booking.com",
	state: "confirmed",
	modified: false,
	guest: "Durable Guest",
	checkin_date: "2026-08-10",
	checkout_date: "2026-08-12",
	updated_at: "2026-08-06T10:00:00.000Z",
	total_guests: 2,
	total_rooms: 1,
	total: "200.00",
	sub_total: "200.00",
	currency: "SAR",
	rooms: [
		{
			id: "room-delivery-1",
			state: "confirmed",
			inv_code: "INV-DOUBLE",
			rate_code: "BAR",
			rate_plan_code: "ROOM_ONLY",
			name: "Double Room",
			checkin_date: "2026-08-10",
			checkout_date: "2026-08-12",
			nights: 2,
			total_guest: 2,
			total_adult: 2,
			child_ages: [],
			price: "200.00",
			total: "200.00",
			daily_prices: [
				{ date: "2026-08-10", price: "100.00" },
				{ date: "2026-08-11", price: "100.00" },
			],
		},
	],
	...overrides,
});

function createEventModel() {
	const byKey = new Map();
	let sequence = 0;
	return {
		byKey,
		findOneAndUpdate(filter, update) {
			return {
				exec: async () => {
					let event = byKey.get(filter.eventKey);
					if (!event) {
						event = {
							_id: `event-${++sequence}`,
							deliveryCount: 0,
							...(update.$setOnInsert || {}),
						};
						byKey.set(filter.eventKey, event);
					}
					Object.assign(event, update.$set || {});
					for (const [key, value] of Object.entries(update.$inc || {})) {
						event[key] = Number(event[key] || 0) + Number(value || 0);
					}
					return event;
				},
			};
		},
		updateOne(filter, update) {
			return {
				exec: async () => {
					const event = Array.from(byKey.values()).find(
						(candidate) => String(candidate._id) === String(filter._id)
					);
					if (!event) return { matchedCount: 0 };
					if (filter.status && event.status !== filter.status) {
						return { matchedCount: 0, modifiedCount: 0 };
					}
					if (filter.payloadHash && event.payloadHash !== filter.payloadHash) {
						return { matchedCount: 0, modifiedCount: 0 };
					}
					if (
						filter.integrityReason?.$in &&
						!filter.integrityReason.$in.includes(event.integrityReason ?? null)
					) {
						return { matchedCount: 0, modifiedCount: 0 };
					}
					if (
						filter["integrityConflicts.0"]?.$exists === false &&
						Array.isArray(event.integrityConflicts) &&
						event.integrityConflicts.length > 0
					) {
						return { matchedCount: 0, modifiedCount: 0 };
					}
					Object.assign(event, update.$set || {});
					for (const key of Object.keys(update.$unset || {})) delete event[key];
					for (const [key, instruction] of Object.entries(update.$push || {})) {
						if (!Array.isArray(event[key])) event[key] = [];
						const values = instruction?.$each || [instruction];
						event[key].push(...values);
						if (Number.isInteger(instruction?.$slice) && instruction.$slice < 0) {
							event[key] = event[key].slice(instruction.$slice);
						}
					}
					return { matchedCount: 1, modifiedCount: 1 };
				},
			};
		},
	};
}

test("stored and logged errors redact credentials and connection URI userinfo", () => {
	const message = safeErrorMessage(
		new Error(
			"mongodb://database-user:database-password@db.internal/pms token=api-secret hr_id=property-secret"
		)
	);
	assert.equal(message.includes("database-user"), false);
	assert.equal(message.includes("database-password"), false);
	assert.equal(message.includes("api-secret"), false);
	assert.equal(message.includes("property-secret"), false);
	assert.match(message, /\[REDACTED\]/);
});

test("same delivery UID is idempotent and a changed payload is quarantined", async () => {
	const EventModel = createEventModel();
	const context = {
		config: {
			hrIdFingerprint: "synthetic-property-fingerprint",
			callbackMaxReservations: 100,
		},
		hotel: { _id: "64b000000000000000000001" },
		rawReservation: rawReservation(),
		source: "push",
	};
	const first = await persistHotelRunnerDelivery(
		{ ...context, receivedAt: new Date("2026-08-06T10:01:00.000Z") },
		{ EventModel }
	);
	const duplicate = await persistHotelRunnerDelivery(
		{ ...context, receivedAt: new Date("2026-08-06T10:02:00.000Z") },
		{ EventModel }
	);
	assert.equal(first.duplicate, false);
	assert.equal(duplicate.duplicate, true);
	assert.equal(EventModel.byKey.size, 1);
	assert.equal(Array.from(EventModel.byKey.values())[0].deliveryCount, 2);

	const conflict = await persistHotelRunnerDelivery(
		{
			...context,
			rawReservation: rawReservation({ note: "different payload, same UID" }),
			receivedAt: new Date("2026-08-06T10:03:00.000Z"),
		},
		{ EventModel }
	);
	const stored = Array.from(EventModel.byKey.values())[0];
	assert.equal(conflict.integrityConflict, true);
	assert.equal(stored.status, "quarantined");
	assert.equal(stored.integrityReason, "message_uid_payload_conflict");
	assert.equal(stored.integrityConflicts.length, 1);

	const originalAfterConflict = await persistHotelRunnerDelivery(
		{ ...context, receivedAt: new Date("2026-08-06T10:04:00.000Z") },
		{ EventModel }
	);
	assert.equal(originalAfterConflict.status, "quarantined");
	assert.equal(originalAfterConflict.revived, false);
	assert.equal(stored.status, "quarantined");
	assert.equal(EventModel.byKey.size, 1);
});

test("exact redelivery revives a failed event but never creates another row", async () => {
	const EventModel = createEventModel();
	const context = {
		config: {
			hrIdFingerprint: "synthetic-property-fingerprint",
			callbackMaxReservations: 100,
		},
		hotel: { _id: "64b000000000000000000001" },
		rawReservation: rawReservation(),
		source: "push",
	};
	await persistHotelRunnerDelivery(
		{ ...context, receivedAt: new Date("2026-08-06T10:01:00.000Z") },
		{ EventModel }
	);
	const stored = Array.from(EventModel.byKey.values())[0];
	Object.assign(stored, {
		status: "failed",
		attempts: 8,
		processedAt: new Date("2026-08-06T10:02:00.000Z"),
		finalRecoveryAttempted: true,
		finalRecoveryClaimedAt: new Date("2026-08-06T10:02:00.000Z"),
		leaseOwner: "expired-worker",
		leaseUntil: new Date("2026-08-06T10:03:00.000Z"),
		errorCode: "SYNTHETIC_TRANSIENT_FAILURE",
		errorMessage: "synthetic transient failure",
	});

	const redelivery = await persistHotelRunnerDelivery(
		{ ...context, receivedAt: new Date("2026-08-06T10:04:00.000Z") },
		{ EventModel }
	);
	assert.equal(redelivery.duplicate, true);
	assert.equal(redelivery.revived, true);
	assert.equal(redelivery.status, "pending");
	assert.equal(EventModel.byKey.size, 1);
	assert.equal(stored.status, "pending");
	assert.equal(stored.attempts, 0);
	assert.equal(stored.processedAt, null);
	assert.equal(stored.finalRecoveryAttempted, false);
	assert.equal(stored.errorCode, "");
	assert.equal(Object.hasOwn(stored, "leaseOwner"), false);
});

test("a partially stored callback batch is safe to retry without duplicate events", async () => {
	const EventModel = createEventModel();
	const originalFindOneAndUpdate = EventModel.findOneAndUpdate.bind(EventModel);
	let failSecondDeliveryOnce = true;
	EventModel.findOneAndUpdate = (filter, update) => {
		if (
			failSecondDeliveryOnce &&
			update?.$setOnInsert?.messageUid === "durable-event-uid-2"
		) {
			return {
				exec: async () => {
					failSecondDeliveryOnce = false;
					throw new Error("synthetic mid-batch storage interruption");
				},
			};
		}
		return originalFindOneAndUpdate(filter, update);
	};
	const batch = {
		config: {
			hrIdFingerprint: "synthetic-property-fingerprint",
			callbackMaxReservations: 100,
		},
		hotel: { _id: "64b000000000000000000001" },
		reservations: [
			rawReservation(),
			rawReservation({
				message_uid: "durable-event-uid-2",
				reservation_id: "hr-reservation-2",
				hr_number: "R-2",
				provider_number: "BOOKING-2",
			}),
		],
		source: "push",
		receivedAt: new Date("2026-08-06T10:04:00.000Z"),
	};
	await assert.rejects(
		persistHotelRunnerBatch(batch, {
			EventModel,
			skipIndexInitialization: true,
		}),
		/synthetic mid-batch storage interruption/
	);
	assert.equal(EventModel.byKey.size, 1);

	const retryResults = await persistHotelRunnerBatch(batch, {
		EventModel,
		skipIndexInitialization: true,
	});
	assert.equal(retryResults.length, 2);
	assert.equal(retryResults[0].duplicate, true);
	assert.equal(retryResults[1].duplicate, false);
	assert.equal(EventModel.byKey.size, 2);
	const deliveryCounts = Array.from(EventModel.byKey.values())
		.map((event) => event.deliveryCount)
		.sort((left, right) => left - right);
	assert.deepEqual(deliveryCounts, [1, 2]);
});
