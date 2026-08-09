/** @format */

process.env.SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "SG.test";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");
const {
	callbackCredentialsMatch,
	callbackLeadingSyntax,
	createHandleHotelRunnerCallback,
	hotelRunnerCallbackPreflight,
	hotelRunnerAdminStatus,
	listHotelRunnerRoomMappings,
	parseCallbackEnvelope,
	parseHotelRunnerCallbackForm,
	requireHotelRunnerCallbackAuth,
	timingSafeTextEqual,
	updateHotelRunnerRoomMapping,
} = require("../controllers/hotelrunner");
const HotelDetails = require("../models/hotel_details");
const HotelRunnerEvent = require("../models/hotelrunner_event");
const HotelRunnerReservation = require("../models/hotelrunner_reservation");
const HotelRunnerRoomMapping = require("../models/hotelrunner_room_mapping");
const HotelRunnerSyncState = require("../models/hotelrunner_sync_state");

const CONFIG_ENV_KEYS = [
	"HOTELRUNNER_API_TOKEN",
	"HOTELRUNNER_API_HR_ID",
	"HOTELRUNNER_SUPPORTED_HOTELIDS",
	"HOTELRUNNER_CALLBACK_BODY_LIMIT_BYTES",
	"HOTELRUNNER_PULL_ENABLED",
	"HOTELRUNNER_ROOM_LIST_SYNC_ENABLED",
	"HOTELRUNNER_PROJECTION_ENABLED",
	"HOTELRUNNER_PROJECTION_NOT_BEFORE",
	"HOTELRUNNER_CONFIRM_DELIVERY_ENABLED",
	"HOTELRUNNER_ROOM_LIST_INTERVAL_HOURS",
	"SUPER_ADMIN_ID",
];

async function withSyntheticConfig(callback) {
	const previous = Object.fromEntries(
		CONFIG_ENV_KEYS.map((key) => [key, process.env[key]])
	);
	process.env.HOTELRUNNER_API_TOKEN = "synthetic-token-not-a-real-secret";
	process.env.HOTELRUNNER_API_HR_ID = "synthetic-hr-id";
	process.env.HOTELRUNNER_SUPPORTED_HOTELIDS = "64b000000000000000000001";
	process.env.HOTELRUNNER_CALLBACK_BODY_LIMIT_BYTES = "65536";
	process.env.HOTELRUNNER_PULL_ENABLED = "false";
	process.env.HOTELRUNNER_ROOM_LIST_SYNC_ENABLED = "false";
	process.env.HOTELRUNNER_PROJECTION_ENABLED = "false";
	delete process.env.HOTELRUNNER_PROJECTION_NOT_BEFORE;
	process.env.HOTELRUNNER_CONFIRM_DELIVERY_ENABLED = "false";
	process.env.HOTELRUNNER_ROOM_LIST_INTERVAL_HOURS = "24";
	process.env.SUPER_ADMIN_ID = "64b000000000000000000002";
	try {
		return await callback();
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

function responseRecorder() {
	return {
		statusCode: 200,
		headers: {},
		body: undefined,
		status(code) {
			this.statusCode = code;
			return this;
		},
		set(name, value) {
			this.headers[String(name).toLowerCase()] = String(value);
			return this;
		},
		json(body) {
			this.body = body;
			return this;
		},
	};
}

function requestFor({
	method = "POST",
	query = {},
	contentType = "application/x-www-form-urlencoded",
	contentLength = "100",
} = {}) {
	const headers = {
		"content-type": contentType,
		"content-length": contentLength,
	};
	return {
		method,
		query,
		get(name) {
			return headers[String(name).toLowerCase()];
		},
	};
}

function startLocalServer(app) {
	return new Promise((resolve, reject) => {
		const server = http.createServer(app);
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve(server));
	});
}

function stopLocalServer(server) {
	return new Promise((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
	});
}

function postToLocalServer(server, { contentType, body }) {
	return new Promise((resolve, reject) => {
		const address = server.address();
		const request = http.request(
			{
				host: "127.0.0.1",
				port: address.port,
				path:
					"/api/hotelrunner/callback?token=" +
					encodeURIComponent("synthetic-token-not-a-real-secret") +
					"&hr_id=" +
					encodeURIComponent("synthetic-hr-id"),
				method: "POST",
				headers: {
					"content-type": contentType,
					"content-length": Buffer.byteLength(body),
				},
			},
			(response) => {
				let responseBody = "";
				response.setEncoding("utf8");
				response.on("data", (chunk) => {
					responseBody += chunk;
				});
				response.on("end", () => {
					resolve({
						statusCode: response.statusCode,
						body: JSON.parse(responseBody),
					});
				});
			}
		);
		request.once("error", reject);
		request.end(body);
	});
}

test("callback credential comparison is exact, fail-closed, and rejects multi-value queries", () => {
	const config = {
		callbackConfigured: true,
		token: "token-with-case-A",
		hrId: "hr-id-001",
	};

	assert.equal(
		callbackCredentialsMatch(
			{ token: "token-with-case-A", hr_id: "hr-id-001" },
			config
		),
		true
	);
	for (const query of [
		{ token: "token-with-case-a", hr_id: "hr-id-001" },
		{ token: "token-with-case-A ", hr_id: "hr-id-001" },
		{ token: "token-with-case-A", hr_id: "HR-ID-001" },
		{ token: ["token-with-case-A"], hr_id: "hr-id-001" },
		{ token: "token-with-case-A", hr_id: ["hr-id-001"] },
		{ token: "", hr_id: "hr-id-001" },
	]) {
		assert.equal(callbackCredentialsMatch(query, config), false);
	}
	assert.equal(
		callbackCredentialsMatch(
			{ token: "token-with-case-A", hr_id: "hr-id-001" },
			{ ...config, callbackConfigured: false }
		),
		false
	);
});

test("timing-safe text equality supports unequal lengths without throwing", () => {
	assert.equal(timingSafeTextEqual("same-value", "same-value"), true);
	assert.equal(timingSafeTextEqual("short", "a much longer value"), false);
	assert.equal(timingSafeTextEqual("hotelrunner", "HotelRunner"), false);
	assert.equal(timingSafeTextEqual("", ""), true);
});

test("callback diagnostics classify syntax without retaining payload values", () => {
	assert.equal(callbackLeadingSyntax('{"reservations":[]}'), "json_object");
	assert.equal(callbackLeadingSyntax('[{"message_uid":"secret-value"}]'), "json_array");
	assert.equal(callbackLeadingSyntax('"{\\"reservations\\":[]}"'), "json_string");
	assert.equal(callbackLeadingSyntax("<OTA_HotelResNotifRQ/>"), "xml");
	assert.equal(callbackLeadingSyntax("%7B%22reservations%22%3A%5B%5D%7D"), "percent_encoded_json_object");
	assert.equal(callbackLeadingSyntax("%3COTA_HotelResNotifRQ%2F%3E"), "percent_encoded_xml");
	assert.equal(callbackLeadingSyntax(""), "empty");
});

test("callback envelope accepts bounded documented and safe form-serialization variants", () => {
	const one = {
		reservation_id: 123,
		hr_number: "R123",
		message_uid: "one",
	};
	const accepted = parseCallbackEnvelope(
		JSON.stringify({ reservations: [one, { ...one, message_uid: "two" }] }),
		2
	);
	assert.equal(accepted.reservations.length, 2);
	assert.deepEqual(
		parseCallbackEnvelope(JSON.stringify(JSON.stringify({ reservations: [one] })), 2)
			.reservations,
		[one]
	);
	assert.deepEqual(
		parseCallbackEnvelope(`\uFEFF${JSON.stringify({ reservations: [one] })}`, 2)
			.reservations,
		[one]
	);
	assert.deepEqual(
		parseCallbackEnvelope(encodeURIComponent(JSON.stringify({ reservations: [one] })), 2)
			.reservations,
		[one]
	);
	assert.deepEqual(
		parseCallbackEnvelope(JSON.stringify({ reservations: JSON.stringify([one]) }), 2)
			.reservations,
		[one]
	);
	assert.deepEqual(parseCallbackEnvelope(JSON.stringify([one]), 2).reservations, [one]);
	assert.deepEqual(parseCallbackEnvelope(JSON.stringify(one), 2).reservations, [one]);
	assert.deepEqual(
		parseCallbackEnvelope(JSON.stringify({ reservation: one }), 2).reservations,
		[one]
	);

	for (const [data, max, code] of [
		["not json", 2, "HOTELRUNNER_INVALID_JSON"],
		["null", 2, "HOTELRUNNER_INVALID_ENVELOPE"],
		["[]", 2, "HOTELRUNNER_INVALID_RESERVATIONS"],
		[JSON.stringify([{ arbitrary: "object" }]), 2, "HOTELRUNNER_INVALID_ENVELOPE"],
		[JSON.stringify({}), 2, "HOTELRUNNER_INVALID_RESERVATIONS"],
		[JSON.stringify({ reservations: [] }), 2, "HOTELRUNNER_INVALID_RESERVATIONS"],
		[
			JSON.stringify({ reservations: [{ message_uid: "one" }, { message_uid: "two" }] }),
			1,
			"HOTELRUNNER_INVALID_RESERVATIONS",
		],
	]) {
		assert.throws(
			() => parseCallbackEnvelope(data, max),
			(error) => error?.code === code,
			code
		);
	}
});

test("callback acknowledges only after the whole delivery is durably stored", async () => {
	let releasePersistence;
	const persisted = new Promise((resolve) => {
		releasePersistence = resolve;
	});
	let markPersistenceStarted;
	const persistenceStarted = new Promise((resolve) => {
		markPersistenceStarted = resolve;
	});
	const receivedAt = new Date("2026-08-06T12:00:00.000Z");
	let persistInput = null;
	const handler = createHandleHotelRunnerCallback({
		loadHotel: async () => ({ _id: "64b000000000000000000001" }),
		persistBatch: async (input) => {
			persistInput = input;
			markPersistenceStarted();
			await persisted;
		},
		now: () => receivedAt,
	});
	const response = responseRecorder();
	const pending = handler(
		{
			hotelRunnerConfig: { callbackMaxReservations: 10 },
			body: {
				data: JSON.stringify({ reservations: [{ message_uid: "durable-1" }] }),
			},
		},
		response
	);
	await persistenceStarted;
	assert.equal(response.body, undefined);
	assert.equal(persistInput.source, "push");
	assert.equal(persistInput.receivedAt, receivedAt);

	releasePersistence();
	await pending;
	assert.equal(response.statusCode, 200);
	assert.deepEqual(response.body, { status: "ok" });
});

test("callback returns retryable failure instead of acknowledging a storage error", async () => {
	const failure = new Error("synthetic durable storage failure");
	failure.code = "SYNTHETIC_STORAGE_FAILURE";
	const handler = createHandleHotelRunnerCallback({
		loadHotel: async () => ({ _id: "64b000000000000000000001" }),
		persistBatch: async () => {
			throw failure;
		},
	});
	const response = responseRecorder();
	const originalConsoleError = console.error;
	console.error = () => {};
	try {
		await handler(
			{
				hotelRunnerConfig: { callbackMaxReservations: 10 },
				body: {
					data: JSON.stringify({ reservations: [{ message_uid: "durable-2" }] }),
				},
			},
			response
		);
	} finally {
		console.error = originalConsoleError;
	}
	assert.equal(response.statusCode, 503);
	assert.equal(response.headers["retry-after"], "60");
	assert.deepEqual(response.body, { error: "Callback could not be stored." });
});

test("callback authentication attaches only validated server-side configuration", async () => {
	await withSyntheticConfig(async () => {
		const acceptedRequest = requestFor({
			query: {
				token: "synthetic-token-not-a-real-secret",
				hr_id: "synthetic-hr-id",
			},
		});
		const acceptedResponse = responseRecorder();
		let nextCalls = 0;
		requireHotelRunnerCallbackAuth(acceptedRequest, acceptedResponse, () => {
			nextCalls += 1;
		});
		assert.equal(nextCalls, 1);
		assert.equal(acceptedResponse.body, undefined);
		assert.equal(acceptedRequest.hotelRunnerConfig.configured, true);

		const rejectedResponse = responseRecorder();
		requireHotelRunnerCallbackAuth(
			requestFor({ query: { token: "wrong", hr_id: "synthetic-hr-id" } }),
			rejectedResponse,
			() => assert.fail("invalid callback credentials must not call next")
		);
		assert.equal(rejectedResponse.statusCode, 401);
		assert.deepEqual(rejectedResponse.body, { error: "Unauthorized" });
	});
});

test("callback preflight authenticates before accepting form media types and enforces size", async () => {
	await withSyntheticConfig(async () => {
		const query = {
			token: "synthetic-token-not-a-real-secret",
			hr_id: "synthetic-hr-id",
		};
		for (const contentType of [
			"application/x-www-form-urlencoded; charset=utf-8",
			"multipart/form-data; boundary=synthetic",
		]) {
			const request = requestFor({ query, contentType });
			const response = responseRecorder();
			let nextCalls = 0;
			hotelRunnerCallbackPreflight(request, response, () => {
				nextCalls += 1;
			});
			assert.equal(nextCalls, 1, contentType);
			assert.equal(request.hotelRunnerPreflightAuthenticated, true);
		}

		const jsonResponse = responseRecorder();
		hotelRunnerCallbackPreflight(
			requestFor({ query, contentType: "application/json" }),
			jsonResponse,
			() => assert.fail("JSON callbacks must be rejected before body parsing")
		);
		assert.equal(jsonResponse.statusCode, 415);

		const oversizedResponse = responseRecorder();
		hotelRunnerCallbackPreflight(
			requestFor({ query, contentLength: "65537" }),
			oversizedResponse,
			() => assert.fail("oversized callbacks must not reach a body parser")
		);
		assert.equal(oversizedResponse.statusCode, 413);
	});
});

test("real callback middleware parses HotelRunner urlencoded and multipart data forms", async () => {
	await withSyntheticConfig(async () => {
		const app = express();
		app.use("/api/hotelrunner/callback", hotelRunnerCallbackPreflight);
		app.post(
			"/api/hotelrunner/callback",
			parseHotelRunnerCallbackForm,
			(req, res) => res.status(200).json({ data: req.body.data })
		);
		const server = await startLocalServer(app);
		const callbackData = JSON.stringify({
			reservations: [{ message_uid: "real-form-parser-1" }],
		});
		try {
			const urlencoded = await postToLocalServer(server, {
				contentType: "application/x-www-form-urlencoded; charset=utf-8",
				body: `data=${encodeURIComponent(callbackData)}`,
			});
			assert.equal(urlencoded.statusCode, 200);
			assert.equal(urlencoded.body.data, callbackData);

			const boundary = "hotelrunner-test-boundary";
			const multipartBody = [
				`--${boundary}`,
				'Content-Disposition: form-data; name="data"',
				"",
				callbackData,
				`--${boundary}--`,
				"",
			].join("\r\n");
			const multipart = await postToLocalServer(server, {
				contentType: `multipart/form-data; boundary=${boundary}`,
				body: multipartBody,
			});
			assert.equal(multipart.statusCode, 200);
			assert.equal(multipart.body.data, callbackData);
		} finally {
			await stopLocalServer(server);
		}
	});
});

test("an unconfigured callback returns retryable unavailability without revealing configuration", async () => {
	await withSyntheticConfig(async () => {
		delete process.env.HOTELRUNNER_API_TOKEN;
		const response = responseRecorder();
		requireHotelRunnerCallbackAuth(
			requestFor({ query: { token: "anything", hr_id: "synthetic-hr-id" } }),
			response,
			() => assert.fail("unconfigured callback must fail closed")
		);
		assert.equal(response.statusCode, 503);
		assert.equal(response.headers["retry-after"], "300");
		assert.deepEqual(response.body, {
			error: "Integration is temporarily unavailable.",
		});
		assert.equal(JSON.stringify(response.body).includes("HOTELRUNNER"), false);
	});
});

test("worker-only configuration errors do not make an authentic callback unavailable", async () => {
	await withSyntheticConfig(async () => {
		process.env.HOTELRUNNER_PROJECTION_ENABLED = "tru";
		const response = responseRecorder();
		let called = false;
		requireHotelRunnerCallbackAuth(
			requestFor({
				query: {
					token: "synthetic-token-not-a-real-secret",
					hr_id: "synthetic-hr-id",
				},
			}),
			response,
			() => {
				called = true;
			},
		);
		assert.equal(called, true);
		assert.equal(response.body, undefined);
	});
});

test("admin status counts only cutoff-eligible push events and archives every complement", async () => {
	await withSyntheticConfig(async () => {
		const cutoff = new Date("2026-08-06T12:00:00.000Z");
		process.env.HOTELRUNNER_PROJECTION_NOT_BEFORE = cutoff.toISOString();
		const hotelId = "64b000000000000000000001";
		const ownerId = "64b000000000000000000002";
		const originals = {
			hotelFindOne: HotelDetails.findOne,
			eventAggregate: HotelRunnerEvent.aggregate,
			eventFindOne: HotelRunnerEvent.findOne,
			eventCountDocuments: HotelRunnerEvent.countDocuments,
			reservationAggregate: HotelRunnerReservation.aggregate,
			syncStateFindOne: HotelRunnerSyncState.findOne,
		};
		const query = (value) => ({
			sort() {
				return this;
			},
			select() {
				return this;
			},
			lean() {
				return this;
			},
			exec() {
				return Promise.resolve(value);
			},
			then(resolve, reject) {
				return Promise.resolve(value).then(resolve, reject);
			},
		});
		let eligibleMatch = null;
		let noneligibleMatch = null;
		const eventSelections = [];
		HotelDetails.findOne = () =>
			query({
				_id: hotelId,
				belongsTo: ownerId,
				activateHotel: true,
				xHotelProActive: true,
				roomCountDetails: [],
			});
		HotelRunnerEvent.aggregate = (pipeline) => {
			eligibleMatch = pipeline[0].$match;
			return Promise.resolve([{ _id: "pending", count: 2 }]);
		};
		HotelRunnerReservation.aggregate = () => Promise.resolve([]);
		HotelRunnerEvent.findOne = () => {
			const eventQuery = query(null);
			eventQuery.select = (fields) => {
				eventSelections.push(fields);
				return eventQuery;
			};
			return eventQuery;
		};
		HotelRunnerEvent.countDocuments = (filter) => {
			noneligibleMatch = filter;
			return Promise.resolve(5);
		};
		HotelRunnerSyncState.findOne = () => query(null);
		try {
			const response = responseRecorder();
			await hotelRunnerAdminStatus(
				{ profile: { _id: ownerId, activeUser: true } },
				response
			);
			assert.equal(response.statusCode, 200);
			const eligibility = eligibleMatch.$and[0];
			const push = eligibility.$or.find((branch) => branch.source === "push");
			const targeted = eligibility.$or.find((branch) => branch.source?.$in);
			assert.equal(push.source, "push");
			assert.equal(push.receivedAt.$gte.toISOString(), cutoff.toISOString());
			assert.equal(
				push.sourceUpdatedAt.$gte.toISOString(),
				cutoff.toISOString()
			);
			assert.deepEqual(targeted.source, { $in: ["pull", "push"] });
			assert.equal(
				targeted[
					"result.hotelRunnerFirstFallbackTargetedLookup.projectable"
				],
				true
			);
			assert.equal(String(noneligibleMatch.hotelId), hotelId);
			assert.deepEqual(noneligibleMatch.$nor, [eligibility]);
			assert.equal(response.body.queue.pending, 2);
			assert.equal(response.body.archive.preActivationEventCount, 5);
			assert.deepEqual(eventSelections, [
				"receivedAt status source integrityConflict integrityConflictCount",
				"processedAt status source integrityConflict integrityConflictCount",
			]);
		} finally {
			HotelDetails.findOne = originals.hotelFindOne;
			HotelRunnerEvent.aggregate = originals.eventAggregate;
			HotelRunnerEvent.findOne = originals.eventFindOne;
			HotelRunnerEvent.countDocuments = originals.eventCountDocuments;
			HotelRunnerReservation.aggregate = originals.reservationAggregate;
			HotelRunnerSyncState.findOne = originals.syncStateFindOne;
		}
	});
});

test("admin status fails health when the live worker release does not match the backend checkout", async () => {
	await withSyntheticConfig(async () => {
		process.env.HOTELRUNNER_PROJECTION_ENABLED = "true";
		process.env.HOTELRUNNER_PROJECTION_NOT_BEFORE =
			"2026-08-09T15:00:00.000Z";
		const hotelId = "64b000000000000000000001";
		const ownerId = "64b000000000000000000002";
		const originals = {
			hotelFindOne: HotelDetails.findOne,
			eventAggregate: HotelRunnerEvent.aggregate,
			eventFindOne: HotelRunnerEvent.findOne,
			eventCountDocuments: HotelRunnerEvent.countDocuments,
			reservationAggregate: HotelRunnerReservation.aggregate,
			syncStateFindOne: HotelRunnerSyncState.findOne,
		};
		const query = (value) => ({
			sort() {
				return this;
			},
			select() {
				return this;
			},
			lean() {
				return this;
			},
			exec: async () => value,
			then(resolve, reject) {
				return Promise.resolve(value).then(resolve, reject);
			},
		});
		HotelDetails.findOne = () =>
			query({
				_id: hotelId,
				belongsTo: ownerId,
				activateHotel: true,
				xHotelProActive: true,
				roomCountDetails: [],
			});
		HotelRunnerEvent.aggregate = () => Promise.resolve([]);
		HotelRunnerReservation.aggregate = () => Promise.resolve([]);
		HotelRunnerEvent.findOne = () => query(null);
		HotelRunnerEvent.countDocuments = () => Promise.resolve(0);
		HotelRunnerSyncState.findOne = () =>
			query({
				status: "idle",
				workerReleaseSha: "0".repeat(40),
				workerReleaseTreeSha: "1".repeat(40),
				workerInstanceId: "stale-worker",
				workerStartedAt: new Date(Date.now() - 10_000),
				workerHeartbeatAt: new Date(),
			});
		try {
			const response = responseRecorder();
			await hotelRunnerAdminStatus(
				{ profile: { _id: ownerId, activeUser: true } },
				response
			);
			assert.equal(response.statusCode, 503);
			assert.equal(response.body.revisionHealth.status, "unhealthy");
			assert.equal(
				response.body.revisionHealth.alerts.includes(
					"worker_backend_revision_mismatch"
				),
				true
			);
			assert.equal(response.body.worker.instanceId, "stale-worker");
			assert.equal(response.body.worker.releaseSha, "0".repeat(40));
		} finally {
			HotelDetails.findOne = originals.hotelFindOne;
			HotelRunnerEvent.aggregate = originals.eventAggregate;
			HotelRunnerEvent.findOne = originals.eventFindOne;
			HotelRunnerEvent.countDocuments = originals.eventCountDocuments;
			HotelRunnerReservation.aggregate = originals.reservationAggregate;
			HotelRunnerSyncState.findOne = originals.syncStateFindOne;
		}
	});
});

test("admin mapping activation requires room-list proof and repeats that proof in the CAS", async () => {
	await withSyntheticConfig(async () => {
		const hotelId = "64b000000000000000000001";
		const ownerId = "64b000000000000000000002";
		const mappingId = "64b000000000000000000003";
		const localRoomTypeId = "64b000000000000000000004";
		const originals = {
			hotelFindOne: HotelDetails.findOne,
			mappingFindOne: HotelRunnerRoomMapping.findOne,
			mappingFindOneAndUpdate: HotelRunnerRoomMapping.findOneAndUpdate,
			eventUpdateMany: HotelRunnerEvent.updateMany,
			syncStateFindOne: HotelRunnerSyncState.findOne,
		};
		const query = (value) => ({
			select() {
				return this;
			},
			lean() {
				return this;
			},
			exec: async () => value,
			then(resolve, reject) {
				return Promise.resolve(value).then(resolve, reject);
			},
		});
		const hotel = {
			_id: hotelId,
			belongsTo: ownerId,
			activateHotel: true,
			xHotelProActive: true,
			roomCountDetails: [
				{ _id: localRoomTypeId, roomType: "doubleRooms", activeRoom: true },
			],
		};
		HotelDetails.findOne = () => query(hotel);
		let activeGeneration = "";
		HotelRunnerSyncState.findOne = () =>
			query({ activeRoomListSyncGeneration: activeGeneration });
		let mappingRecord = {
			isMaster: false,
			variantConflict: false,
			roomListVerifiedAt: null,
			roomListSyncGeneration: "",
			roomListVerificationState: "unverified",
		};
		HotelRunnerRoomMapping.findOne = () => query(mappingRecord);
		let updateFilter = null;
		HotelRunnerRoomMapping.findOneAndUpdate = (filter) => {
			updateFilter = filter;
			return query({
				_id: mappingId,
				localRoomConfigId: localRoomTypeId,
				status: "active",
				__v: 4,
			});
		};
		HotelRunnerEvent.updateMany = () => ({ exec: async () => ({ matchedCount: 0 }) });

		const request = () => ({
			profile: { _id: ownerId, activeUser: true },
			auth: { _id: ownerId },
			params: { mappingId },
			body: { localRoomTypeId, enabled: true, expectedVersion: 3 },
		});
		try {
			process.env.SUPER_ADMIN_ID = "64b000000000000000000099";
			const ordinaryOwnerResponse = responseRecorder();
			await updateHotelRunnerRoomMapping(request(), ordinaryOwnerResponse);
			assert.equal(ordinaryOwnerResponse.statusCode, 403);
			assert.equal(updateFilter, null);
			process.env.SUPER_ADMIN_ID = ownerId;

			process.env.HOTELRUNNER_PROJECTION_ENABLED = "true";
			process.env.HOTELRUNNER_PROJECTION_NOT_BEFORE =
				"2026-08-06T23:45:12Z";
			const activeProjectionResponse = responseRecorder();
			await updateHotelRunnerRoomMapping(
				request(),
				activeProjectionResponse
			);
			assert.equal(activeProjectionResponse.statusCode, 409);
			assert.equal(
				activeProjectionResponse.body.code,
				"hotelrunner_mapping_projection_active"
			);
			assert.equal(updateFilter, null);
			process.env.HOTELRUNNER_PROJECTION_ENABLED = "false";
			delete process.env.HOTELRUNNER_PROJECTION_NOT_BEFORE;

			const unverifiedResponse = responseRecorder();
			await updateHotelRunnerRoomMapping(request(), unverifiedResponse);
			assert.equal(unverifiedResponse.statusCode, 422);
			assert.match(unverifiedResponse.body.error, /room-list sync/i);
			assert.equal(updateFilter, null);

			mappingRecord = {
				isMaster: false,
				variantConflict: false,
				roomListVerifiedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
				roomListSyncGeneration: "stale-room-list-generation",
				roomListVerificationState: "verified",
			};
			activeGeneration = "stale-room-list-generation";
			const staleResponse = responseRecorder();
			await updateHotelRunnerRoomMapping(request(), staleResponse);
			assert.equal(staleResponse.statusCode, 422);
			assert.equal(updateFilter, null);

			mappingRecord = {
				isMaster: false,
				variantConflict: true,
				roomListVerifiedAt: new Date(),
				roomListSyncGeneration: "conflicting-room-list-generation",
				roomListVerificationState: "verified",
			};
			activeGeneration = "conflicting-room-list-generation";
			const conflictResponse = responseRecorder();
			await updateHotelRunnerRoomMapping(request(), conflictResponse);
			assert.equal(conflictResponse.statusCode, 422);
			assert.equal(updateFilter, null);

			mappingRecord = {
				isMaster: false,
				variantConflict: false,
				roomListVerifiedAt: new Date(),
				roomListSyncGeneration: "room-list-generation-1",
				roomListVerificationState: "verified",
			};
			activeGeneration = "different-published-generation";
			const unpublishedResponse = responseRecorder();
			await updateHotelRunnerRoomMapping(request(), unpublishedResponse);
			assert.equal(unpublishedResponse.statusCode, 422);
			assert.equal(updateFilter, null);

			activeGeneration = "room-list-generation-1";
			const verifiedResponse = responseRecorder();
			await updateHotelRunnerRoomMapping(request(), verifiedResponse);
			assert.equal(verifiedResponse.statusCode, 200);
			assert.ok(updateFilter.roomListVerifiedAt.$gte instanceof Date);
			assert.ok(updateFilter.roomListVerifiedAt.$lte instanceof Date);
			assert.equal(
				updateFilter.roomListSyncGeneration,
				"room-list-generation-1"
			);
			assert.equal(updateFilter.roomListVerificationState, "verified");
			assert.deepEqual(updateFilter.variantConflict, { $ne: true });
			assert.deepEqual(updateFilter.isMaster, { $ne: true });
		} finally {
			HotelDetails.findOne = originals.hotelFindOne;
			HotelRunnerRoomMapping.findOne = originals.mappingFindOne;
			HotelRunnerRoomMapping.findOneAndUpdate =
				originals.mappingFindOneAndUpdate;
			HotelRunnerEvent.updateMany = originals.eventUpdateMany;
			HotelRunnerSyncState.findOne = originals.syncStateFindOne;
		}
	});
});

test("admin mapping list marks only fresh conflict-free generation proof verified", async () => {
	await withSyntheticConfig(async () => {
		const hotelId = "64b000000000000000000001";
		const ownerId = "64b000000000000000000002";
		const originals = {
			hotelFindOne: HotelDetails.findOne,
			mappingFind: HotelRunnerRoomMapping.find,
			syncStateFindOne: HotelRunnerSyncState.findOne,
		};
		const query = (value) => ({
			select() {
				return this;
			},
			sort() {
				return this;
			},
			lean() {
				return this;
			},
			exec: async () => value,
			then(resolve, reject) {
				return Promise.resolve(value).then(resolve, reject);
			},
		});
		const now = Date.now();
		HotelDetails.findOne = () =>
			query({
				_id: hotelId,
				belongsTo: ownerId,
				activateHotel: true,
				xHotelProActive: true,
				roomCountDetails: [],
			});
		HotelRunnerSyncState.findOne = () =>
			query({ activeRoomListSyncGeneration: "generation-fresh" });
		HotelRunnerRoomMapping.find = () =>
			query([
				{
					_id: "64b000000000000000000011",
					invCode: "FRESH",
					status: "pending",
					roomListVerifiedAt: new Date(now - 60 * 60 * 1000),
					roomListSyncGeneration: "generation-fresh",
					roomListVerificationState: "verified",
					variantConflict: false,
				},
				{
					_id: "64b000000000000000000012",
					invCode: "STALE",
					status: "pending",
					roomListVerifiedAt: new Date(now - 8 * 24 * 60 * 60 * 1000),
					roomListSyncGeneration: "generation-stale",
					roomListVerificationState: "verified",
					variantConflict: false,
				},
				{
					_id: "64b000000000000000000013",
					invCode: "CONFLICT",
					status: "conflict",
					roomListVerifiedAt: new Date(now - 60 * 60 * 1000),
					roomListSyncGeneration: "generation-conflict",
					roomListVerificationState: "verified",
					variantConflict: true,
				},
				{
					_id: "64b000000000000000000014",
					invCode: "UNPUBLISHED",
					status: "pending",
					roomListVerifiedAt: new Date(now - 60 * 60 * 1000),
					roomListSyncGeneration: "generation-unpublished",
					roomListVerificationState: "verified",
					variantConflict: false,
				},
			]);
		try {
			const response = responseRecorder();
			await listHotelRunnerRoomMappings(
				{ profile: { _id: ownerId, activeUser: true } },
				response
			);
			assert.equal(response.statusCode, 200);
			assert.equal(response.body.mappings[0].roomListVerified, true);
			assert.equal(response.body.mappings[1].roomListVerified, false);
			assert.equal(response.body.mappings[2].roomListVerified, false);
			assert.equal(response.body.mappings[2].variantConflict, true);
			assert.equal(response.body.mappings[3].roomListVerified, false);
		} finally {
			HotelDetails.findOne = originals.hotelFindOne;
			HotelRunnerRoomMapping.find = originals.mappingFind;
			HotelRunnerSyncState.findOne = originals.syncStateFindOne;
		}
	});
});
