/** @format */

const HotelDetails = require("../models/hotel_details");
const OtaReservationSyncJob = require("../models/ota_reservation_sync_job");
const {
	expandHotelNameCandidates,
	normalizeComparable,
	normalizeWhitespace,
} = require("./otaReservationMapper");

const DEFAULT_PROVIDER = "expedia";
const MAX_SYNC_DAYS = 430;

const normalizeText = (value = "") => String(value || "").trim();

const PROVIDER_CONFIG = {
	expedia: {
		value: "expedia",
		label: "Expedia",
		partnerPortalLabel: "Expedia Partner Central",
		usernameEnvKey: "OTA_EXPEDIA_USERNAME",
		passwordEnvKey: "OTA_PASSWORD",
		jobPrefix: "OTA-RES-SYNC",
	},
};

const normalizeProvider = (value = DEFAULT_PROVIDER) => {
	const provider = normalizeText(value || DEFAULT_PROVIDER).toLowerCase();
	return PROVIDER_CONFIG[provider] ? provider : "";
};

const providerConfigFor = (provider = DEFAULT_PROVIDER) =>
	PROVIDER_CONFIG[normalizeProvider(provider)] || PROVIDER_CONFIG[DEFAULT_PROVIDER];

const configuredHotelAllowlist = () =>
	String(process.env.OTA_INBOUND_EMAIL_HOTEL_IDS || "")
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);

const dateOnly = (value = "") => {
	const raw = normalizeText(value);
	return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : "";
};

const addDays = (date, count) => {
	const next = new Date(date);
	next.setUTCDate(next.getUTCDate() + count);
	return next;
};

const formatDate = (date) => date.toISOString().slice(0, 10);

const defaultDateRange = () => {
	const today = new Date();
	const utcToday = new Date(
		Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
	);
	return {
		dateFrom: formatDate(addDays(utcToday, -30)),
		dateTo: formatDate(addDays(utcToday, 365)),
	};
};

const daysBetweenInclusive = (dateFrom, dateTo) => {
	const start = new Date(`${dateFrom}T00:00:00.000Z`);
	const end = new Date(`${dateTo}T00:00:00.000Z`);
	if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 0;
	if (end < start) return 0;
	return Math.floor((end - start) / (24 * 60 * 60 * 1000)) + 1;
};

const containsCredentialKey = (value, path = "") => {
	if (!value || typeof value !== "object") return false;
	return Object.entries(value).some(([key, item]) => {
		const nextPath = path ? `${path}.${key}` : key;
		if (/password|secret|token|cookie|session/i.test(nextPath)) return true;
		return item && typeof item === "object"
			? containsCredentialKey(item, nextPath)
			: false;
	});
};

const buildJobNumber = (provider = DEFAULT_PROVIDER) => {
	const providerConfig = providerConfigFor(provider);
	const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
	const random = Math.random().toString(36).slice(2, 7).toUpperCase();
	return `${providerConfig.jobPrefix}-${stamp}-${random}`;
};

const safeAliasCandidatesForHotel = (hotel = {}) => {
	const candidates = expandHotelNameCandidates([
		hotel.hotelName,
		hotel.hotelName_OtherLanguage,
	]);
	return candidates.map((name) => ({
		name,
		matchKey: normalizeComparable(name),
	}));
};

const buildTargetHotel = (hotel = {}, allowedHotelIds = []) => {
	const hotelId = String(hotel._id || "");
	const aliases = safeAliasCandidatesForHotel(hotel);
	const activeRooms = (Array.isArray(hotel.roomCountDetails)
		? hotel.roomCountDetails
		: []
	).filter((room) => room && room.activeRoom !== false);
	return {
		hotelId,
		hotelName: normalizeWhitespace(hotel.hotelName || ""),
		hotelNameOtherLanguage: normalizeWhitespace(hotel.hotelName_OtherLanguage || ""),
		ownerId: hotel.belongsTo ? String(hotel.belongsTo) : "",
		aliases,
		matchKeys: Array.from(new Set(aliases.map((alias) => alias.matchKey))).filter(Boolean),
		activeRoomTypes: activeRooms.length,
		otaInboundAllowed:
			allowedHotelIds.length === 0 || allowedHotelIds.includes(hotelId),
	};
};

const buildCredentialSummary = (provider = DEFAULT_PROVIDER) => {
	const providerConfig = providerConfigFor(provider);
	const username = normalizeText(
		process.env[providerConfig.usernameEnvKey] || ""
	);
	const passwordConfigured = Boolean(
		normalizeText(process.env[providerConfig.passwordEnvKey] || "")
	);
	const missing = [];
	if (!username) missing.push(providerConfig.usernameEnvKey);
	if (!passwordConfigured) missing.push(providerConfig.passwordEnvKey);
	return {
		provider: providerConfig.value,
		providerLabel: providerConfig.label,
		usernameConfigured: Boolean(username),
		usernameSource: username ? providerConfig.usernameEnvKey : "",
		passwordEnvKey: providerConfig.passwordEnvKey,
		passwordConfigured,
		missing,
	};
};

const loadActiveHotels = async () =>
	HotelDetails.find({
		activateHotel: true,
		xHotelProActive: { $ne: false },
	})
		.select(
			"_id hotelName hotelName_OtherLanguage belongsTo activateHotel xHotelProActive roomCountDetails"
		)
		.sort({ hotelName: 1 })
		.lean()
		.exec();

const prepareOtaReservationSyncJob = async ({ actor, payload = {} }) => {
	if (containsCredentialKey(payload)) {
		return {
			ok: false,
			statusCode: 400,
			error:
				"Do not send passwords, tokens, cookies, or session data to this endpoint. Use server environment credentials only.",
		};
	}

	const provider = normalizeProvider(payload.provider || DEFAULT_PROVIDER);
	if (!provider) {
		return {
			ok: false,
			statusCode: 400,
			error: "Unsupported OTA reservation sync provider.",
		};
	}
	const providerConfig = providerConfigFor(provider);

	const defaults = defaultDateRange();
	const dateFrom = dateOnly(payload.dateFrom) || defaults.dateFrom;
	const dateTo = dateOnly(payload.dateTo) || defaults.dateTo;
	const totalDays = daysBetweenInclusive(dateFrom, dateTo);
	if (!dateFrom || !dateTo || totalDays <= 0) {
		return {
			ok: false,
			statusCode: 400,
			error: "A valid dateFrom/dateTo range is required in YYYY-MM-DD format.",
		};
	}
	if (totalDays > MAX_SYNC_DAYS) {
		return {
			ok: false,
			statusCode: 400,
			error: `OTA reservation sync preview is limited to ${MAX_SYNC_DAYS} days per job.`,
		};
	}

	const hotels = await loadActiveHotels();
	if (!hotels.length) {
		return {
			ok: false,
			statusCode: 409,
			error: "No active hotels are available for OTA reservation sync.",
		};
	}

	const allowedHotelIds = configuredHotelAllowlist();
	const allActiveTargetHotels = hotels.map((hotel) =>
		buildTargetHotel(hotel, allowedHotelIds)
	);
	const targetHotels = allowedHotelIds.length
		? allActiveTargetHotels.filter((hotel) => hotel.otaInboundAllowed)
		: allActiveTargetHotels;
	const skippedActiveHotels = allowedHotelIds.length
		? allActiveTargetHotels.filter((hotel) => !hotel.otaInboundAllowed)
		: [];
	const activeHotelIds = new Set(
		allActiveTargetHotels.map((hotel) => hotel.hotelId).filter(Boolean)
	);
	const unmatchedAllowlistIds = allowedHotelIds.filter(
		(hotelId) => !activeHotelIds.has(hotelId)
	);
	if (!targetHotels.length) {
		return {
			ok: false,
			statusCode: 409,
			error:
				"OTA reservation sync allowlist is configured, but none of the allowed hotels are active.",
		};
	}
	const credentialSummary = buildCredentialSummary(provider);
	const missingCredentials = credentialSummary.missing.length > 0;
	const missingEnvText = credentialSummary.missing.join(" and ");
	const notes = normalizeText(payload.notes || "").slice(0, 1000);

	const job = await OtaReservationSyncJob.create({
		jobNumber: buildJobNumber(provider),
		status: missingCredentials ? "needs_credentials" : "prepared",
		provider,
		operation: "reservation_sync_preview",
		executionMode: "supervised_read_only",
		createdBy: actor._id,
		dateFrom,
		dateTo,
		timezone: normalizeText(payload.timezone || "Asia/Riyadh"),
		hotelCount: targetHotels.length,
		targetHotels,
		credentialSummary,
		syncPolicy: {
			readOnly: true,
			previewOnly: true,
			noReservationWrites: true,
			noPricingOverwrite: true,
			noFinanceOverwrite: true,
			noHotelAssignmentOverwrite: true,
			noPasswordInPayload: true,
			usernameEnvKey: providerConfig.usernameEnvKey,
			passwordEnvKey: providerConfig.passwordEnvKey,
			noCaptchaBypass: true,
			humanLoginRequired: true,
			manualMfaRequired: true,
			officialApiPreferredWhenAvailable: true,
			reconcileContract:
				"Collector output must pass through the OTA reconciliation layer; existing reservations preserve PMS pricing and finance fields.",
		},
		collectorPlan: {
			summary: `Prepare read-only OTA reservation sync preview for ${targetHotels.length} target hotel(s), ${dateFrom} to ${dateTo}. Provider: ${providerConfig.label}.`,
			provider: providerConfig.partnerPortalLabel,
			providerKey: provider,
			providerLabel: providerConfig.label,
			scope: allowedHotelIds.length
				? "ota_inbound_allowlist"
				: "all_active_hotels",
			activeHotelCount: allActiveTargetHotels.length,
			configuredAllowlistCount: allowedHotelIds.length,
			skippedActiveHotelCount: skippedActiveHotels.length,
			totalDays,
			steps: [
				`Open a supervised ${providerConfig.partnerPortalLabel} browser session.`,
				`Human owner completes login, MFA, and any ${providerConfig.label} verification.`,
				"Read reservation list/details for every active PMS hotel in this job.",
				`Normalize ${providerConfig.label} property names through the same OTA inbound alias candidates.`,
				`Match existing PMS reservations by ${providerConfig.label} confirmation/supplier fields before considering any create.`,
				"Return preview buckets only: new, matched existing, status changed, conflicts, needs review.",
				"Do not write reservations, pricing, finance cycle, hotel assignment, cookies, or credentials in this job.",
			],
			nextStep: missingCredentials
				? `Configure ${missingEnvText} on the server for ${providerConfig.label}, then prepare or run the supervised read-only collector.`
				: "Run the supervised read-only collector, then review the preview buckets before any apply step exists.",
			warnings: [
				...(skippedActiveHotels.length
					? [
							`${skippedActiveHotels.length} active hotel(s) were skipped because they are outside OTA_INBOUND_EMAIL_HOTEL_IDS: ${skippedActiveHotels
								.map((hotel) => hotel.hotelName)
								.filter(Boolean)
								.join(", ")}.`,
					  ]
					: []),
				...(unmatchedAllowlistIds.length
					? [
							`${unmatchedAllowlistIds.length} OTA_INBOUND_EMAIL_HOTEL_IDS value(s) do not currently match an active hotel.`,
					  ]
					: []),
			],
		},
		payloadSnapshot: {
			source: normalizeText(payload.source || "admin_all_reservations"),
			dateFrom,
			dateTo,
			timezone: normalizeText(payload.timezone || "Asia/Riyadh"),
			provider,
			allActiveHotels: allowedHotelIds.length === 0,
			otaInboundAllowlistApplied: allowedHotelIds.length > 0,
			activeHotelCount: allActiveTargetHotels.length,
			configuredAllowlistCount: allowedHotelIds.length,
			skippedActiveHotelCount: skippedActiveHotels.length,
		},
		resultSummary: {
			newReservations: 0,
			matchedExisting: 0,
			statusChanged: 0,
			conflicts: 0,
			needsReview: 0,
			appliedWrites: 0,
		},
		notes,
		auditLog: [
			{
				at: new Date(),
				action: "prepared",
				by: actor._id,
				readOnly: true,
				provider,
				hotelCount: targetHotels.length,
				activeHotelCount: allActiveTargetHotels.length,
				otaInboundAllowlistApplied: allowedHotelIds.length > 0,
				dateFrom,
				dateTo,
			},
		],
	});

	return { ok: true, job };
};

module.exports = {
	prepareOtaReservationSyncJob,
	prepareExpediaReservationSyncJob: prepareOtaReservationSyncJob,
	SUPPORTED_OTA_SYNC_PROVIDERS: Object.keys(PROVIDER_CONFIG),
	MAX_SYNC_DAYS,
};
