/** @format */

const OtaCalendarJob = require("../models/ota_calendar_job");

const SUPPORTED_OTAS = ["expedia", "agoda", "airbnb", "booking"];
const SUPPORTED_OTA_LABELS = {
	expedia: "Expedia",
	agoda: "Agoda",
	airbnb: "Airbnb",
	booking: "Booking.com",
};

const DASHBOARD_URL_ENV = {
	expedia: "OTA_EXPEDIA_DASHBOARD_URL",
	agoda: "OTA_AGODA_DASHBOARD_URL",
	airbnb: "OTA_AIRBNB_DASHBOARD_URL",
	booking: "OTA_BOOKING_DASHBOARD_URL",
};

const USERNAME_ENV = {
	expedia: "OTA_EXPEDIA_USERNAME",
	agoda: "OTA_AGODA_USERNAME",
	airbnb: "OTA_AIRBNB_USERNAME",
	booking: "OTA_BOOKING_USERNAME",
};

const DEFAULT_DASHBOARD_URLS = {
	expedia: "https://apps.expediapartnercentral.com",
	agoda: "https://ycs.agoda.com",
	airbnb: "https://www.airbnb.com/hosting/listings",
	booking: "https://admin.booking.com",
};

const TOP_LEVEL_ALLOWED_KEYS = new Set([
	"hotelId",
	"roomId",
	"dateFrom",
	"dateTo",
	"timezone",
	"nightlyRateSar",
	"rootRateSar",
	"availability",
	"closed",
	"selectedOtas",
	"otaAccounts",
	"notes",
	"source",
	"confirmSupervisedOnly",
]);

const containsCredentialKey = (value, path = "") => {
	if (!value || typeof value !== "object") return false;
	return Object.entries(value).some(([key, item]) => {
		const nextPath = path ? `${path}.${key}` : key;
		if (/password|secret|token|cookie|session/i.test(nextPath)) return true;
		return item && typeof item === "object" ? containsCredentialKey(item, nextPath) : false;
	});
};

const normalizeText = (value = "") => String(value || "").trim();

const normalizeOta = (value = "") => {
	const normalized = normalizeText(value)
		.toLowerCase()
		.replace(/booking\.com/g, "booking")
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
	return normalized === "bookings" ? "booking" : normalized;
};

const dateOnly = (value = "") => {
	const raw = normalizeText(value);
	const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	return match ? raw : "";
};

const parseDateUtc = (value = "") => {
	const date = dateOnly(value);
	if (!date) return null;
	const parsed = new Date(`${date}T00:00:00.000Z`);
	return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const addDays = (date, count) => {
	const next = new Date(date);
	next.setUTCDate(next.getUTCDate() + count);
	return next;
};

const formatDate = (date) => date.toISOString().slice(0, 10);

const enumerateDates = (dateFrom, dateTo) => {
	const start = parseDateUtc(dateFrom);
	const end = parseDateUtc(dateTo);
	if (!start || !end || start > end) return [];
	const days = [];
	let cursor = start;
	while (cursor <= end) {
		days.push(formatDate(cursor));
		cursor = addDays(cursor, 1);
		if (days.length > 370) break;
	}
	return days;
};

const numberOrNull = (value) => {
	if (value === "" || value === null || value === undefined) return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
};

const nonNegativeIntegerOrNull = (value) => {
	const parsed = numberOrNull(value);
	if (parsed === null) return null;
	return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
};

const getOtaUsername = (ota, otaAccounts = {}) => {
	const payloadValue = normalizeText(otaAccounts?.[ota]?.username || otaAccounts?.[ota]);
	if (payloadValue) {
		return {
			username: payloadValue,
			usernameSource: "payload",
		};
	}
	const envKey = USERNAME_ENV[ota];
	const envValue = normalizeText(process.env[envKey] || "");
	return {
		username: envValue,
		usernameSource: envValue ? envKey : "",
	};
};

const buildCredentialSummary = (selectedOtas, otaAccounts = {}) => {
	const passwordConfigured = Boolean(process.env.OTA_PASSWORD);
	const byOta = selectedOtas.map((ota) => {
		const username = getOtaUsername(ota, otaAccounts);
		return {
			ota,
			label: SUPPORTED_OTA_LABELS[ota],
			username: username.username,
			usernameConfigured: Boolean(username.username),
			usernameSource: username.usernameSource,
			passwordEnvKey: "OTA_PASSWORD",
			passwordConfigured,
		};
	});
	return {
		passwordEnvKey: "OTA_PASSWORD",
		passwordConfigured,
		byOta,
		missing: byOta
			.filter((item) => !item.usernameConfigured || !item.passwordConfigured)
			.map((item) => ({
				ota: item.ota,
				label: item.label,
				usernameMissing: !item.usernameConfigured,
				passwordMissing: !item.passwordConfigured,
			})),
	};
};

const dashboardUrlForOta = (ota) =>
	normalizeText(process.env[DASHBOARD_URL_ENV[ota]] || "") ||
	DEFAULT_DASHBOARD_URLS[ota] ||
	"";

const buildCalendarDays = ({
	dateFrom,
	dateTo,
	nightlyRateSar,
	rootRateSar,
	availability,
	closed,
}) =>
	enumerateDates(dateFrom, dateTo).map((date) => ({
		date,
		nightlyRateSar: closed ? null : nightlyRateSar,
		rootRateSar: closed ? null : rootRateSar,
		availability: closed ? 0 : availability,
		closed: !!closed,
	}));

const buildOtaTasks = ({
	selectedOtas,
	hotel,
	room,
	dateFrom,
	dateTo,
	nightlyRateSar,
	rootRateSar,
	availability,
	closed,
	credentialSummary,
}) =>
	selectedOtas.map((ota) => {
		const credential = credentialSummary.byOta.find((item) => item.ota === ota) || {};
		return {
			ota,
			label: SUPPORTED_OTA_LABELS[ota],
			status:
				credential.usernameConfigured && credential.passwordConfigured
					? "ready_for_supervised_execution"
					: "needs_credentials",
			executionMode: "supervised_manual",
			dashboardUrl: dashboardUrlForOta(ota),
			credentialRef: {
				username: credential.username || "",
				usernameSource: credential.usernameSource || "",
				passwordEnvKey: "OTA_PASSWORD",
				passwordConfigured: !!credential.passwordConfigured,
			},
			calendarOnly: true,
			requiresHumanVerification: true,
			manualSubmitRequired: true,
			target: {
				hotelId: String(hotel?._id || ""),
				hotelName: hotel?.hotelName || "",
				roomId: String(room?._id || ""),
				roomType: room?.roomType || "",
				roomDisplayName: room?.displayName || room?.roomType || "",
				dateFrom,
				dateTo,
				nightlyRateSar: closed ? null : nightlyRateSar,
				rootRateSar: closed ? null : rootRateSar,
				availability: closed ? 0 : availability,
				closed: !!closed,
			},
			steps: [
				"open_provider_dashboard",
				"human_completes_login_mfa_or_captcha_when_prompted",
				"navigate_to_calendar_rates_and_availability",
				"select_property_room_and_rate_plan",
				"apply_date_range",
				"apply_rate_and_availability_only",
				"human_reviews_final_provider_screen",
				"human_submits_or_cancels",
			],
		};
	});

const validatePayloadShape = (payload = {}) => {
	const unknownKeys = Object.keys(payload || {}).filter(
		(key) => !TOP_LEVEL_ALLOWED_KEYS.has(key)
	);
	if (unknownKeys.length) {
		return `Unsupported field(s) for OTA calendar update: ${unknownKeys.join(", ")}.`;
	}
	if (containsCredentialKey(payload)) {
		return "Do not send passwords, tokens, cookies, or session data to this endpoint. Use OTA_PASSWORD in the server environment.";
	}
	return "";
};

const buildJobNumber = () => {
	const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
	const random = Math.random().toString(36).slice(2, 7).toUpperCase();
	return `OTA-CAL-${stamp}-${random}`;
};

const prepareOtaCalendarJob = async ({ actor, hotel, room, payload }) => {
	const shapeError = validatePayloadShape(payload);
	if (shapeError) {
		return { ok: false, statusCode: 400, error: shapeError };
	}
	if (payload.confirmSupervisedOnly !== true) {
		return {
			ok: false,
			statusCode: 400,
			error:
				"OTA calendar jobs must be explicitly confirmed as supervised-only.",
		};
	}

	const selectedOtas = Array.from(
		new Set((Array.isArray(payload.selectedOtas) ? payload.selectedOtas : [])
			.map(normalizeOta)
			.filter(Boolean))
	);
	const unsupported = selectedOtas.filter((ota) => !SUPPORTED_OTAS.includes(ota));
	if (!selectedOtas.length) {
		return { ok: false, statusCode: 400, error: "Select at least one OTA." };
	}
	if (unsupported.length) {
		return {
			ok: false,
			statusCode: 400,
			error: `Unsupported OTA(s): ${unsupported.join(", ")}.`,
		};
	}

	const dateFrom = dateOnly(payload.dateFrom);
	const dateTo = dateOnly(payload.dateTo);
	const days = enumerateDates(dateFrom, dateTo);
	if (!dateFrom || !dateTo || !days.length) {
		return {
			ok: false,
			statusCode: 400,
			error: "A valid dateFrom/dateTo range is required in YYYY-MM-DD format.",
		};
	}
	if (days.length > 370) {
		return {
			ok: false,
			statusCode: 400,
			error: "OTA calendar jobs are limited to 370 days per request.",
		};
	}

	const closed = payload.closed === true || String(payload.closed).toLowerCase() === "true";
	const nightlyRateSar = numberOrNull(payload.nightlyRateSar);
	const rootRateSar = numberOrNull(payload.rootRateSar);
	const availability = nonNegativeIntegerOrNull(payload.availability);

	if (!closed && !(nightlyRateSar > 0)) {
		return {
			ok: false,
			statusCode: 400,
			error: "nightlyRateSar must be greater than zero unless the range is closed.",
		};
	}
	if (!closed && availability === null) {
		return {
			ok: false,
			statusCode: 400,
			error: "availability must be a non-negative whole number.",
		};
	}

	const credentialSummary = buildCredentialSummary(
		selectedOtas,
		payload.otaAccounts || {}
	);
	const calendarDays = buildCalendarDays({
		dateFrom,
		dateTo,
		nightlyRateSar,
		rootRateSar,
		availability,
		closed,
	});
	const otaTasks = buildOtaTasks({
		selectedOtas,
		hotel,
		room,
		dateFrom,
		dateTo,
		nightlyRateSar,
		rootRateSar,
		availability,
		closed,
		credentialSummary,
	});
	const missingCredentials = credentialSummary.missing.length > 0;
	const job = await OtaCalendarJob.create({
		jobNumber: buildJobNumber(),
		status: missingCredentials ? "needs_credentials" : "prepared",
		executionMode: "supervised_manual",
		operation: "calendar_availability_update",
		createdBy: actor._id,
		hotelId: hotel._id,
		roomId: String(room._id),
		roomType: room.roomType || "",
		roomDisplayName: room.displayName || room.roomType || "",
		dateFrom,
		dateTo,
		timezone: normalizeText(payload.timezone || "Asia/Riyadh"),
		nightlyRateSar: closed ? null : nightlyRateSar,
		rootRateSar: closed ? null : rootRateSar,
		availability: closed ? 0 : availability,
		closed,
		totalNights: calendarDays.length,
		selectedOtas,
		otaTasks,
		calendarDays,
		credentialSummary,
		automationPolicy: {
			allowedOperation: "calendar_availability_update",
			calendarOnly: true,
			rateAndAvailabilityOnly: true,
			noReservationAccess: true,
			noGuestDataAccess: true,
			noPaymentAccess: true,
			noPasswordInPayload: true,
			passwordEnvKey: "OTA_PASSWORD",
			noCaptchaBypass: true,
			humanVerificationRequired: true,
			manualSubmitRequired: true,
			officialApiPreferredWhenAvailable: true,
		},
		manualVerification: {
			required: true,
			emailForwardingExpected: true,
			emailForwardingDestination:
				process.env.OTA_INBOUND_FORWARD_TO ||
				process.env.OTA_SECURITY_FORWARD_TO ||
				"ahmed.abdelrazak@jannatbooking.com",
		},
		orchestratorPlan: {
			summary: closed
				? `Prepare OTA calendar closure for ${hotel.hotelName} / ${room.displayName || room.roomType} from ${dateFrom} to ${dateTo}.`
				: `Prepare OTA calendar rate ${nightlyRateSar} SAR and availability ${availability} for ${hotel.hotelName} / ${room.displayName || room.roomType} from ${dateFrom} to ${dateTo}.`,
			providers: otaTasks,
			nextStep: missingCredentials
				? "Configure missing OTA username(s) and OTA_PASSWORD before supervised execution."
				: "Open a supervised OTA session and let a human complete login, captcha, MFA, review, and final submission.",
		},
		payloadSnapshot: {
			hotelId: String(hotel._id),
			roomId: String(room._id),
			dateFrom,
			dateTo,
			nightlyRateSar: closed ? null : nightlyRateSar,
			rootRateSar: closed ? null : rootRateSar,
			availability: closed ? 0 : availability,
			closed,
			selectedOtas,
			source: payload.source || "hotel_settings_calendar",
		},
		notes: normalizeText(payload.notes || "").slice(0, 1000),
		auditLog: [
			{
				at: new Date(),
				action: "prepared",
				actorId: actor._id,
				executionMode: "supervised_manual",
				selectedOtas,
			},
		],
	});

	return { ok: true, job };
};

module.exports = {
	SUPPORTED_OTAS,
	SUPPORTED_OTA_LABELS,
	prepareOtaCalendarJob,
};
