/** @format */

const fetch = require("node-fetch");
const {
	reserveHotelRunnerApiCall,
} = require("./hotelrunnerApiQuota");

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

class HotelRunnerApiError extends Error {
	constructor(message, options = {}) {
		super(message);
		this.name = "HotelRunnerApiError";
		this.code = options.code || "HOTELRUNNER_API_ERROR";
		this.status = options.status || 0;
		this.retryAfterMs = options.retryAfterMs || 0;
		this.retryable = options.retryable !== false;
		this.credentialFault = options.credentialFault === true;
	}
}

function retryAfterMs(value = "") {
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
	const date = new Date(value);
	return Number.isFinite(date.getTime()) ? Math.max(0, date.getTime() - Date.now()) : 0;
}

async function readBodyWithLimit(response, maxBytes = MAX_RESPONSE_BYTES) {
	const declaredLength = Number(response.headers.get("content-length") || 0);
	if (declaredLength > maxBytes) {
		throw new HotelRunnerApiError("HotelRunner response exceeded the safe size limit.", {
			code: "HOTELRUNNER_RESPONSE_TOO_LARGE",
			retryable: false,
		});
	}
	const chunks = [];
	let size = 0;
	for await (const chunk of response.body) {
		size += chunk.length;
		if (size > maxBytes) {
			response.body.destroy();
			throw new HotelRunnerApiError(
				"HotelRunner response exceeded the safe size limit.",
				{ code: "HOTELRUNNER_RESPONSE_TOO_LARGE", retryable: false }
			);
		}
		chunks.push(chunk);
	}
	return Buffer.concat(chunks).toString("utf8");
}

function validateBaseUrl(baseUrl) {
	const parsed = new URL(baseUrl);
	const localTest =
		process.env.NODE_ENV === "test" &&
		["localhost", "127.0.0.1"].includes(parsed.hostname);
	const officialProductionBase =
		parsed.protocol === "https:" &&
		parsed.hostname.toLowerCase() === "app.hotelrunner.com" &&
		(!parsed.port || parsed.port === "443") &&
		parsed.pathname.replace(/\/+$/, "") === "/api/v2/apps";
	if (
		(!officialProductionBase && !localTest) ||
		parsed.username ||
		parsed.password ||
		parsed.search ||
		parsed.hash
	) {
		throw new HotelRunnerApiError("HotelRunner API base URL is not approved.", {
			code: "HOTELRUNNER_API_URL_INVALID",
			retryable: false,
		});
	}
	return parsed.toString().replace(/\/+$/, "");
}

function createHotelRunnerClient({ config, hotelId, fetchImpl = fetch, quotaDependencies } = {}) {
	if (!config?.configured) {
		throw new HotelRunnerApiError("HotelRunner API is not configured.", {
			code: "HOTELRUNNER_CONFIG_INVALID",
			retryable: false,
		});
	}
	const baseUrl = validateBaseUrl(config.apiBaseUrl);

	async function request(path, { method = "GET", query = {} } = {}) {
		await reserveHotelRunnerApiCall(
			{
				hotelId,
				hrIdFingerprint: config.hrIdFingerprint,
				quota: config.quota,
			},
			quotaDependencies
		);
		const url = new URL(`${baseUrl}/${String(path).replace(/^\/+/, "")}`);
		url.searchParams.set("token", config.token);
		url.searchParams.set("hr_id", config.hrId);
		for (const [key, value] of Object.entries(query)) {
			if (value !== undefined && value !== null && value !== "") {
				url.searchParams.set(key, String(value));
			}
		}
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
		try {
			const response = await fetchImpl(url.toString(), {
				method,
				headers: { Accept: "application/json" },
				signal: controller.signal,
				redirect: "error",
			});
			if (!response.ok) {
				if (typeof response.body?.destroy === "function") response.body.destroy();
				const credentialFault = [401, 403].includes(response.status);
				throw new HotelRunnerApiError("HotelRunner API returned an error response.", {
					code:
						response.status === 429
							? "HOTELRUNNER_API_RATE_LIMITED"
							: credentialFault
								? "HOTELRUNNER_API_CREDENTIAL_REJECTED"
								: "HOTELRUNNER_API_HTTP_ERROR",
					status: response.status,
					retryAfterMs: retryAfterMs(response.headers.get("retry-after") || ""),
					retryable:
						response.status === 408 ||
						response.status === 429 ||
						response.status >= 500,
					credentialFault,
				});
			}
			const text = await readBodyWithLimit(response);
			let body;
			try {
				body = text ? JSON.parse(text) : {};
			} catch {
				throw new HotelRunnerApiError("HotelRunner returned an invalid response.", {
					code: "HOTELRUNNER_API_INVALID_JSON",
					status: response.status,
				});
			}
			return body;
		} catch (error) {
			if (error instanceof HotelRunnerApiError) throw error;
			throw new HotelRunnerApiError("HotelRunner API request did not complete.", {
				code:
					error?.name === "AbortError"
						? "HOTELRUNNER_API_TIMEOUT"
						: "HOTELRUNNER_API_NETWORK_ERROR",
			});
		} finally {
			clearTimeout(timer);
		}
	}

	return {
		async retrieveReservations(options = {}) {
			const undelivered = options.undelivered !== false;
			if (undelivered && options.page !== undefined) {
				throw new HotelRunnerApiError(
					"HotelRunner page cannot be used with undelivered reservations.",
					{ code: "HOTELRUNNER_PULL_OPTIONS_INVALID", retryable: false }
				);
			}
			if (options.modified === true && options.booked === true) {
				throw new HotelRunnerApiError(
					"HotelRunner modified and booked filters must be requested separately.",
					{ code: "HOTELRUNNER_PULL_OPTIONS_INVALID", retryable: false }
				);
			}
			return request("reservations", {
				query: {
					undelivered,
					per_page: options.perPage || 50,
					page: undelivered ? undefined : options.page || 1,
					from_date: options.fromDate,
					from_last_update_date: options.fromLastUpdateDate,
					modified: options.modified === true ? true : undefined,
					booked: options.booked === true ? true : undefined,
					reservation_number: options.reservationNumber,
				},
			});
		},
		async getRooms() {
			return request("rooms");
		},
		async confirmDelivery({ messageUid, pmsNumber } = {}) {
			if (!String(messageUid || "").trim()) {
				throw new HotelRunnerApiError("HotelRunner message UID is required.", {
					code: "HOTELRUNNER_CONFIRM_OPTIONS_INVALID",
					retryable: false,
				});
			}
			const body = await request("reservations/~", {
				method: "PUT",
				query: { message_uid: messageUid, pms_number: pmsNumber },
			});
			if (body?.status !== "ok") {
				throw new HotelRunnerApiError(
					"HotelRunner did not confirm reservation delivery.",
					{ code: "HOTELRUNNER_CONFIRM_REJECTED" }
				);
			}
			return body;
		},
		request,
	};
}

module.exports = {
	HotelRunnerApiError,
	MAX_RESPONSE_BYTES,
	createHotelRunnerClient,
	readBodyWithLimit,
	retryAfterMs,
	validateBaseUrl,
};
