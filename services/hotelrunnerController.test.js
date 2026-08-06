/** @format */

process.env.SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "SG.test";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");
const {
	callbackCredentialsMatch,
	createHandleHotelRunnerCallback,
	hotelRunnerCallbackPreflight,
	parseCallbackEnvelope,
	parseHotelRunnerCallbackForm,
	requireHotelRunnerCallbackAuth,
	timingSafeTextEqual,
	updateHotelRunnerRoomMapping,
} = require("../controllers/hotelrunner");
const HotelDetails = require("../models/hotel_details");
const HotelRunnerEvent = require("../models/hotelrunner_event");
const HotelRunnerRoomMapping = require("../models/hotelrunner_room_mapping");

const CONFIG_ENV_KEYS = [
	"HOTELRUNNER_API_TOKEN",
	"HOTELRUNNER_API_HR_ID",
	"HOTELRUNNER_SUPPORTED_HOTELIDS",
	"HOTELRUNNER_CALLBACK_BODY_LIMIT_BYTES",
];

async function withSyntheticConfig(callback) {
	const previous = Object.fromEntries(
		CONFIG_ENV_KEYS.map((key) => [key, process.env[key]])
	);
	process.env.HOTELRUNNER_API_TOKEN = "synthetic-token-not-a-real-secret";
	process.env.HOTELRUNNER_API_HR_ID = "synthetic-hr-id";
	process.env.HOTELRUNNER_SUPPORTED_HOTELIDS = "64b000000000000000000001";
	process.env.HOTELRUNNER_CALLBACK_BODY_LIMIT_BYTES = "65536";
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
		configured: true,
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
			{ ...config, configured: false }
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

test("callback envelope accepts only a bounded non-empty reservations array", () => {
	const accepted = parseCallbackEnvelope(
		JSON.stringify({ reservations: [{ message_uid: "one" }, { message_uid: "two" }] }),
		2
	);
	assert.equal(accepted.reservations.length, 2);

	for (const [data, max, code] of [
		["not json", 2, "HOTELRUNNER_INVALID_JSON"],
		["null", 2, "HOTELRUNNER_INVALID_ENVELOPE"],
		["[]", 2, "HOTELRUNNER_INVALID_ENVELOPE"],
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
		let mappingRecord = { isMaster: false, roomListVerifiedAt: null };
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
			const unverifiedResponse = responseRecorder();
			await updateHotelRunnerRoomMapping(request(), unverifiedResponse);
			assert.equal(unverifiedResponse.statusCode, 422);
			assert.match(unverifiedResponse.body.error, /room-list sync/i);
			assert.equal(updateFilter, null);

			mappingRecord = {
				isMaster: false,
				roomListVerifiedAt: new Date("2026-08-06T10:00:00.000Z"),
			};
			const verifiedResponse = responseRecorder();
			await updateHotelRunnerRoomMapping(request(), verifiedResponse);
			assert.equal(verifiedResponse.statusCode, 200);
			assert.deepEqual(updateFilter.roomListVerifiedAt, { $type: "date" });
			assert.deepEqual(updateFilter.isMaster, { $ne: true });
		} finally {
			HotelDetails.findOne = originals.hotelFindOne;
			HotelRunnerRoomMapping.findOne = originals.mappingFindOne;
			HotelRunnerRoomMapping.findOneAndUpdate =
				originals.mappingFindOneAndUpdate;
			HotelRunnerEvent.updateMany = originals.eventUpdateMany;
		}
	});
});
