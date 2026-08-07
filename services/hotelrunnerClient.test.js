/** @format */

const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const {
	HotelRunnerApiError,
	createHotelRunnerClient,
	readBodyWithLimit,
	validateBaseUrl,
} = require("./hotelrunnerClient");

const headers = (values = {}) => ({
	get(name) {
		return values[String(name).toLowerCase()] ?? null;
	},
});

function quotaModel() {
	return {
		calls: 0,
		findOneAndUpdate() {
			this.calls += 1;
			return {
				exec: async () => ({ count: 1 }),
			};
		},
	};
}

function syntheticConfig(overrides = {}) {
	return {
		configured: true,
		apiBaseUrl: "https://app.hotelrunner.com/api/v2/apps",
		token: "synthetic-token",
		hrId: "synthetic-hr-id",
		hrIdFingerprint: "synthetic-fingerprint",
		requestTimeoutMs: 25,
		quota: {
			propertyDaily: 225,
			propertyMinute: 4,
			applicationMinute: 60,
		},
		...overrides,
	};
}

test("response reader rejects a declared body above the configured maximum before consuming it", async () => {
	let iterations = 0;
	const response = {
		headers: headers({ "content-length": "6" }),
		body: {
			async *[Symbol.asyncIterator]() {
				iterations += 1;
				yield Buffer.from("123456");
			},
		},
	};

	await assert.rejects(
		readBodyWithLimit(response, 5),
		(error) => {
			assert.ok(error instanceof HotelRunnerApiError);
			assert.equal(error.code, "HOTELRUNNER_RESPONSE_TOO_LARGE");
			assert.equal(error.retryable, false);
			return true;
		}
	);
	assert.equal(iterations, 0);
});

test("response reader enforces the maximum on chunked bodies and destroys the stream", async () => {
	const body = Readable.from([Buffer.from("1234"), Buffer.from("567")]);
	const response = {
		headers: headers(),
		body,
	};

	await assert.rejects(
		readBodyWithLimit(response, 5),
		(error) => error?.code === "HOTELRUNNER_RESPONSE_TOO_LARGE"
	);
	assert.equal(body.destroyed, true);
});

test(
	"request timeout remains active while a successful response body is streaming",
	{ timeout: 1_000 },
	async () => {
		const BudgetModel = quotaModel();
		let streamDestroyed = false;
		let observedSignal = null;
		const fetchImpl = async (_url, options) => {
			observedSignal = options.signal;
			const body = {
				destroy() {
					streamDestroyed = true;
				},
				async *[Symbol.asyncIterator]() {
					yield Buffer.from('{"rooms":');
					await new Promise((resolve, reject) => {
						const timer = setTimeout(resolve, 150);
						options.signal.addEventListener(
							"abort",
							() => {
								clearTimeout(timer);
								const error = new Error("synthetic response-body abort");
								error.name = "AbortError";
								reject(error);
							},
							{ once: true }
						);
					});
					yield Buffer.from("[]}");
				},
			};
			return {
				ok: true,
				status: 200,
				headers: headers(),
				body,
			};
		};
		const client = createHotelRunnerClient({
			config: syntheticConfig(),
			hotelId: "64b000000000000000000001",
			fetchImpl,
			quotaDependencies: { BudgetModel },
		});

		await assert.rejects(client.getRooms(), (error) => {
			assert.ok(error instanceof HotelRunnerApiError);
			assert.equal(error.code, "HOTELRUNNER_API_TIMEOUT");
			assert.equal(error.retryable, true);
			return true;
		});
		assert.equal(observedSignal.aborted, true);
		assert.equal(BudgetModel.calls, 3);
		assert.equal(streamDestroyed || observedSignal.aborted, true);
	}
);

test("production credentials can only target the exact official API base", () => {
	assert.equal(
		validateBaseUrl("https://app.hotelrunner.com/api/v2/apps/"),
		"https://app.hotelrunner.com/api/v2/apps"
	);
	for (const baseUrl of [
		"http://app.hotelrunner.com/api/v2/apps",
		"https://app.hotelrunner.com.evil.test/api/v2/apps",
		"https://app.hotelrunner.com:444/api/v2/apps",
		"https://app.hotelrunner.com/api/v1/apps",
		"https://app.hotelrunner.com/api/v2/apps?token=embedded",
	]) {
		assert.throws(
			() => validateBaseUrl(baseUrl),
			(error) => error?.code === "HOTELRUNNER_API_URL_INVALID",
			baseUrl
		);
	}
});

test("API requests refuse redirects so query credentials cannot cross hosts", async () => {
	let requestOptions = null;
	const client = createHotelRunnerClient({
		config: syntheticConfig({ requestTimeoutMs: 500 }),
		hotelId: "64b000000000000000000001",
		quotaDependencies: { BudgetModel: quotaModel() },
		fetchImpl: async (_url, options) => {
			requestOptions = options;
			return {
				ok: true,
				status: 200,
				headers: headers(),
				body: Readable.from([Buffer.from('{"rooms":[]}')]),
			};
		},
	});
	await client.getRooms();
	assert.equal(requestOptions.redirect, "error");
});

test("client rejects a chunked oversized response without parsing or retrying it", async () => {
	const BudgetModel = quotaModel();
	let bodyDestroyed = false;
	const body = {
		destroy() {
			bodyDestroyed = true;
		},
		async *[Symbol.asyncIterator]() {
			yield Buffer.alloc(1024 * 1024, 0x20);
			yield Buffer.alloc(1024 * 1024 + 1, 0x20);
		},
	};
	const client = createHotelRunnerClient({
		config: syntheticConfig({ requestTimeoutMs: 500 }),
		hotelId: "64b000000000000000000001",
		quotaDependencies: { BudgetModel },
		fetchImpl: async () => ({
			ok: true,
			status: 200,
			headers: headers(),
			body,
		}),
	});

	await assert.rejects(client.getRooms(), (error) => {
		assert.equal(error.code, "HOTELRUNNER_RESPONSE_TOO_LARGE");
		assert.equal(error.retryable, false);
		return true;
	});
	assert.equal(bodyDestroyed, true);
	assert.equal(BudgetModel.calls, 3);
});

test("empty or HTML credential errors are classified before JSON parsing", async () => {
	for (const [status, bodyText] of [
		[401, ""],
		[403, "<html>forbidden</html>"],
	]) {
		const client = createHotelRunnerClient({
			config: syntheticConfig({ requestTimeoutMs: 500 }),
			hotelId: "64b000000000000000000001",
			quotaDependencies: { BudgetModel: quotaModel() },
			fetchImpl: async () => ({
				ok: false,
				status,
				headers: headers(),
				body: Readable.from([Buffer.from(bodyText)]),
			}),
		});
		await assert.rejects(client.getRooms(), (error) => {
			assert.equal(error.code, "HOTELRUNNER_API_CREDENTIAL_REJECTED");
			assert.equal(error.status, status);
			assert.equal(error.retryable, false);
			assert.equal(error.credentialFault, true);
			return true;
		});
	}
});

test("an HTML server error remains retryable instead of becoming invalid JSON", async () => {
	const client = createHotelRunnerClient({
		config: syntheticConfig({ requestTimeoutMs: 500 }),
		hotelId: "64b000000000000000000001",
		quotaDependencies: { BudgetModel: quotaModel() },
		fetchImpl: async () => ({
			ok: false,
			status: 500,
			headers: headers(),
			body: Readable.from([Buffer.from("<html>temporary</html>")]),
		}),
	});
	await assert.rejects(client.getRooms(), (error) => {
		assert.equal(error.code, "HOTELRUNNER_API_HTTP_ERROR");
		assert.equal(error.status, 500);
		assert.equal(error.retryable, true);
		assert.equal(error.credentialFault, false);
		return true;
	});
});

test("delivery confirmation fails before quota or network access unless explicitly enabled", async () => {
	const BudgetModel = quotaModel();
	let fetchCalls = 0;
	const client = createHotelRunnerClient({
		config: syntheticConfig({ confirmDeliveryEnabled: false }),
		hotelId: "64b000000000000000000001",
		quotaDependencies: { BudgetModel },
		fetchImpl: async () => {
			fetchCalls += 1;
			throw new Error("disabled confirmation must not reach the network");
		},
	});

	await assert.rejects(
		client.confirmDelivery({ messageUid: "synthetic-message", pmsNumber: "PMS-1" }),
		(error) => {
			assert.equal(error.code, "HOTELRUNNER_CONFIRM_DELIVERY_DISABLED");
			assert.equal(error.retryable, false);
			return true;
		}
	);
	assert.equal(BudgetModel.calls, 0);
	assert.equal(fetchCalls, 0);
});

test("the legacy status alias cannot enable delivery confirmation by itself", async () => {
	const client = createHotelRunnerClient({
		config: syntheticConfig({
			confirmDeliveryEnabled: false,
			confirmPulledDeliveryEnabled: true,
		}),
		hotelId: "64b000000000000000000001",
		quotaDependencies: { BudgetModel: quotaModel() },
	});
	await assert.rejects(
		client.confirmDelivery({ messageUid: "synthetic-message" }),
		(error) => error?.code === "HOTELRUNNER_CONFIRM_DELIVERY_DISABLED"
	);
});

test("delivery confirmation also remains off while PMS projection is disabled", async () => {
	const BudgetModel = quotaModel();
	const client = createHotelRunnerClient({
		config: syntheticConfig({
			confirmDeliveryEnabled: true,
			projectionEnabled: false,
		}),
		hotelId: "64b000000000000000000001",
		quotaDependencies: { BudgetModel },
	});
	await assert.rejects(
		client.confirmDelivery({
			messageUid: "synthetic-message",
			pmsNumber: "PMS-1",
		}),
		(error) => error?.code === "HOTELRUNNER_CONFIRM_DELIVERY_DISABLED"
	);
	assert.equal(BudgetModel.calls, 0);
});

test("delivery confirmation requires the persisted PMS reservation number", async () => {
	const BudgetModel = quotaModel();
	const client = createHotelRunnerClient({
		config: syntheticConfig({
			confirmDeliveryEnabled: true,
			projectionEnabled: true,
		}),
		hotelId: "64b000000000000000000001",
		quotaDependencies: { BudgetModel },
	});
	await assert.rejects(
		client.confirmDelivery({ messageUid: "synthetic-message" }),
		(error) => error?.code === "HOTELRUNNER_CONFIRM_OPTIONS_INVALID"
	);
	assert.equal(BudgetModel.calls, 0);
});

test("enabled delivery confirmation uses the dedicated mutation path", async () => {
	const BudgetModel = quotaModel();
	let observed = null;
	const client = createHotelRunnerClient({
		config: syntheticConfig({
			confirmDeliveryEnabled: true,
			projectionEnabled: true,
			requestTimeoutMs: 500,
		}),
		hotelId: "64b000000000000000000001",
		quotaDependencies: { BudgetModel },
		fetchImpl: async (url, options) => {
			observed = { url: new URL(url), options };
			return {
				ok: true,
				status: 200,
				headers: headers(),
				body: Readable.from([Buffer.from('{"status":"ok"}')]),
			};
		},
	});

	assert.deepEqual(
		await client.confirmDelivery({
			messageUid: "synthetic-message",
			pmsNumber: "PMS-1",
		}),
		{ status: "ok" }
	);
	assert.equal(observed.options.method, "PUT");
	assert.equal(observed.url.pathname, "/api/v2/apps/reservations/~");
	assert.equal(observed.url.searchParams.get("message_uid"), "synthetic-message");
	assert.equal(observed.url.searchParams.get("pms_number"), "PMS-1");
	assert.equal(BudgetModel.calls, 3);
});

test("public raw requests cannot bypass the delivery-confirmation mutation gate", async () => {
	const BudgetModel = quotaModel();
	let fetchCalls = 0;
	const client = createHotelRunnerClient({
		config: syntheticConfig({ confirmDeliveryEnabled: true }),
		hotelId: "64b000000000000000000001",
		quotaDependencies: { BudgetModel },
		fetchImpl: async () => {
			fetchCalls += 1;
			throw new Error("raw mutation must not reach the network");
		},
	});

	await assert.rejects(
		client.request("reservations/~", {
			method: "PUT",
			query: { message_uid: "synthetic-message" },
		}),
		(error) => error?.code === "HOTELRUNNER_RAW_MUTATION_FORBIDDEN"
	);
	assert.equal(BudgetModel.calls, 0);
	assert.equal(fetchCalls, 0);
});
