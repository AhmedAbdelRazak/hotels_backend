"use strict";

const axios = require("axios");
const crypto = require("crypto");
const Reservations = require("../models/reservations");

const DEFAULT_TIMEOUT_MS = 3500;
const DEFAULT_META_GRAPH_VERSION = "v25.0";

const http = axios.create({
	timeout: clampNumber(process.env.ANALYTICS_CONVERSION_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, {
		min: 1000,
		max: 10000,
	}),
});

function clampNumber(value, fallback, { min = 0, max = 60000 } = {}) {
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.min(max, Math.max(min, parsed));
}

function enabled() {
	return String(process.env.ANALYTICS_CONVERSIONS_ENABLED || "true").toLowerCase() !==
		"false";
}

function envFirst(...names) {
	for (const name of names) {
		const value = String(process.env[name] || "").trim();
		if (value) return value;
	}
	return "";
}

function analyticsConfig() {
	return {
		gaMeasurementId: envFirst(
			"GA4_MEASUREMENT_ID",
			"GOOGLE_ANALYTICS_MEASUREMENT_ID",
			"GOOGLE_ANALYTICS_ID",
			"NEXT_PUBLIC_GOOGLE_ANALYTICS_ID",
		),
		gaApiSecret: envFirst(
			"GA4_API_SECRET",
			"GOOGLE_ANALYTICS_API_SECRET",
			"GA_API_SECRET",
		),
		metaPixelId: envFirst(
			"META_PIXEL_ID",
			"FACEBOOK_PIXEL_ID",
			"NEXT_PUBLIC_FACEBOOK_PIXEL_ID",
		),
		metaAccessToken: envFirst(
			"META_CONVERSIONS_API_TOKEN",
			"FACEBOOK_CONVERSIONS_API_TOKEN",
			"META_ACCESS_TOKEN",
		),
		metaGraphVersion: envFirst("META_GRAPH_API_VERSION", "FACEBOOK_GRAPH_API_VERSION") ||
			DEFAULT_META_GRAPH_VERSION,
		metaTestEventCode: envFirst("META_TEST_EVENT_CODE", "FACEBOOK_TEST_EVENT_CODE"),
	};
}

function hasConfiguredProvider(config = analyticsConfig()) {
	return Boolean(
		(config.gaMeasurementId && config.gaApiSecret) ||
			(config.metaPixelId && config.metaAccessToken),
	);
}

function safeString(value = "") {
	return String(value || "").trim();
}

function toNumber(value, fallback = 0) {
	const parsed = Number(String(value ?? "").replace(/,/g, ""));
	return Number.isFinite(parsed) ? parsed : fallback;
}

function toMoney(value) {
	const parsed = toNumber(value, 0);
	return Math.round(parsed * 100) / 100;
}

function sha256(value = "") {
	const normalized = safeString(value);
	if (!normalized) return "";
	return crypto.createHash("sha256").update(normalized).digest("hex");
}

function hashEmail(value = "") {
	return sha256(safeString(value).toLowerCase());
}

function hashPhone(value = "") {
	const normalized = safeString(value).replace(/[^\d+]/g, "");
	return sha256(normalized);
}

function splitName(value = "") {
	const parts = safeString(value).toLowerCase().split(/\s+/).filter(Boolean);
	return {
		first: parts[0] || "",
		last: parts.length > 1 ? parts[parts.length - 1] : "",
	};
}

function publicSiteBase() {
	return (
		envFirst("PUBLIC_SITE_URL", "CLIENT_URL", "FRONTEND_URL") ||
		"https://jannatbooking.com"
	).replace(/\/+$/, "");
}

function reservationUrl(reservation = {}) {
	const confirmation = safeString(reservation.confirmation_number);
	return confirmation
		? `${publicSiteBase()}/single-reservation/${encodeURIComponent(confirmation)}`
		: publicSiteBase();
}

function reservationId(reservation = {}) {
	return safeString(reservation._id || reservation.id || reservation.confirmation_number);
}

function eventKey(eventId = "") {
	return safeString(eventId).replace(/[^a-zA-Z0-9_:-]/g, "_").slice(0, 120);
}

function gaClientId(reservation = {}) {
	const seed =
		safeString(reservation.aiSupportCaseId) ||
		reservationId(reservation) ||
		safeString(reservation.confirmation_number) ||
		String(Date.now());
	const hash = sha256(seed);
	const first = parseInt(hash.slice(0, 8), 16) || Date.now();
	const second = parseInt(hash.slice(8, 16), 16) || Math.floor(Date.now() / 1000);
	return `${first}.${second}`;
}

function cleanObject(value = {}) {
	return Object.fromEntries(
		Object.entries(value).filter(([, entry]) => {
			if (entry === undefined || entry === null || entry === "") return false;
			if (Array.isArray(entry) && !entry.length) return false;
			return true;
		}),
	);
}

function roomItems(reservation = {}) {
	const picked = Array.isArray(reservation.pickedRoomsType)
		? reservation.pickedRoomsType
		: Array.isArray(reservation.pickedRoomsPricing)
		? reservation.pickedRoomsPricing
		: [];
	const items = picked
		.map((room, index) => {
			const itemName =
				safeString(room.displayName) ||
				safeString(room.roomType) ||
				safeString(room.room_type) ||
				"Hotel room";
			const price =
				toMoney(room.totalPriceWithCommission) ||
				toMoney(room.chosenPrice) ||
				toMoney(reservation.total_amount);
			return cleanObject({
				item_id:
					safeString(room.room_type) ||
					safeString(room.roomType) ||
					`${reservationId(reservation)}-${index + 1}`,
				item_name: itemName,
				item_category: safeString(reservation.hotelName) || "Hotel reservation",
				quantity: toNumber(room.count, 1) || 1,
				price,
			});
		})
		.filter((item) => item.item_name || item.item_id);

	if (items.length) return items;
	return [
		cleanObject({
			item_id: safeString(reservation.hotelId?._id || reservation.hotelId) || reservationId(reservation),
			item_name: safeString(reservation.hotelName) || "Hotel reservation",
			item_category: "Hotel reservation",
			quantity: toNumber(reservation.total_rooms, 1) || 1,
			price: toMoney(reservation.total_amount),
		}),
	];
}

function metaContents(items = []) {
	return items.map((item) =>
		cleanObject({
			id: item.item_id || item.item_name,
			quantity: item.quantity || 1,
			item_price: item.price,
		}),
	);
}

function metaUserData(reservation = {}, context = {}) {
	const guest = reservation.customer_details || {};
	const names = splitName(guest.name);
	return cleanObject({
		em: hashEmail(guest.email),
		ph: hashPhone(guest.phone),
		fn: names.first ? sha256(names.first) : "",
		ln: names.last ? sha256(names.last) : "",
		client_user_agent: safeString(context.clientUserAgent),
	});
}

function metaActionSource(context = {}) {
	const source = safeString(context.source || context.checkoutContext).toLowerCase();
	if (/ai_chat|chat/.test(source)) return "chat";
	if (/post_stay|mit_capture|authorization_capture/.test(source)) {
		return "system_generated";
	}
	return "website";
}

function baseEventContext(reservation = {}, context = {}) {
	const items = roomItems(reservation);
	const sourceUrl = safeString(context.eventSourceUrl) || reservationUrl(reservation);
	const hotelName =
		safeString(reservation.hotelName) ||
		safeString(reservation.hotelId?.hotelName) ||
		"Hotel reservation";
	const totalRooms = toNumber(reservation.total_rooms, items.length || 1) || items.length || 1;
	return {
		items,
		sourceUrl,
		hotelName,
		totalRooms,
		checkoutContext: safeString(context.checkoutContext || context.source),
	};
}

function reservationConfirmedSpec(reservation = {}, context = {}) {
	const base = baseEventContext(reservation, context);
	const value = toMoney(context.valueSar || reservation.total_amount);
	const eventId =
		safeString(context.eventId) ||
		`jb_reservation_confirmed_${reservationId(reservation)}`;
	return {
		storageKey: eventKey(eventId),
		eventId,
		gaName: "generate_lead",
		metaName: "Lead",
		value,
		currency: "SAR",
		eventSourceUrl: base.sourceUrl,
		clientUserAgent: safeString(context.clientUserAgent),
		gaParams: cleanObject({
			currency: "SAR",
			value,
			event_id: eventId,
			transaction_id: safeString(reservation.confirmation_number) || reservationId(reservation),
			lead_source: safeString(context.source) || "reservation_confirmed",
			booking_source: safeString(reservation.booking_source),
			hotel_id: safeString(reservation.hotelId?._id || reservation.hotelId),
			hotel_name: base.hotelName,
			checkout_context: base.checkoutContext,
			total_rooms: base.totalRooms,
			items: base.items,
		}),
		metaCustomData: cleanObject({
			currency: "SAR",
			value,
			content_name: base.hotelName,
			content_type: "hotel_reservation",
			content_ids: base.items.map((item) => item.item_id).filter(Boolean),
			contents: metaContents(base.items),
			num_items: base.totalRooms,
			order_id: safeString(reservation.confirmation_number) || reservationId(reservation),
			status: "reservation_confirmed",
			booking_source: safeString(reservation.booking_source),
			source: safeString(context.source) || "reservation_confirmed",
		}),
	};
}

function paymentCapturedSpec(reservation = {}, context = {}) {
	const base = baseEventContext(reservation, context);
	const captureId = safeString(context.captureId || context.transactionId);
	const transactionId = [
		safeString(reservation.confirmation_number) || reservationId(reservation),
		captureId,
	]
		.filter(Boolean)
		.join("-");
	const eventId =
		safeString(context.eventId) ||
		`jb_payment_captured_${transactionId || reservationId(reservation)}`;
	const value = toMoney(
		context.amountSar ||
			context.valueSar ||
			reservation.payment_details?.triggeredAmountSAR ||
			reservation.paid_amount ||
			reservation.total_amount,
	);
	return {
		storageKey: eventKey(eventId),
		eventId,
		gaName: "purchase",
		metaName: "Purchase",
		value,
		currency: "SAR",
		eventSourceUrl: base.sourceUrl,
		clientUserAgent: safeString(context.clientUserAgent),
		gaParams: cleanObject({
			transaction_id: transactionId || reservationId(reservation),
			currency: "SAR",
			value,
			event_id: eventId,
			payment_type: safeString(context.paymentType || reservation.payment),
			checkout_context: base.checkoutContext || "payment_capture",
			hotel_id: safeString(reservation.hotelId?._id || reservation.hotelId),
			hotel_name: base.hotelName,
			items: base.items,
		}),
		metaCustomData: cleanObject({
			currency: "SAR",
			value,
			content_name: base.hotelName,
			content_type: "hotel_reservation_payment",
			content_ids: base.items.map((item) => item.item_id).filter(Boolean),
			contents: metaContents(base.items),
			num_items: base.totalRooms,
			order_id: transactionId || reservationId(reservation),
			status: "payment_captured",
			payment_type: safeString(context.paymentType || reservation.payment),
			source: safeString(context.source) || "payment_capture",
		}),
	};
}

async function claimDispatchSlot(reservation, spec) {
	const id = reservationId(reservation);
	if (!id || !reservation._id) return true;
	const path = `analyticsDispatch.events.${spec.storageKey}`;
	const claimed = await Reservations.findOneAndUpdate(
		{
			_id: reservation._id,
			$or: [
				{ [`${path}.sentAt`]: { $exists: false } },
				{ [`${path}.sentAt`]: null },
			],
			$and: [
				{
					$or: [
						{ [`${path}.inFlightAt`]: { $exists: false } },
						{ [`${path}.inFlightAt`]: null },
					],
				},
			],
		},
		{
			$set: {
				[`${path}.eventId`]: spec.eventId,
				[`${path}.eventName`]: spec.gaName,
				[`${path}.metaEventName`]: spec.metaName,
				[`${path}.attemptedAt`]: new Date(),
				[`${path}.inFlightAt`]: new Date(),
				[`${path}.value`]: spec.value,
				[`${path}.currency`]: spec.currency,
			},
		},
		{ new: false },
	).exec();
	return Boolean(claimed);
}

async function updateDispatchStatus(reservation, spec, status = {}) {
	if (!reservation?._id) return;
	const path = `analyticsDispatch.events.${spec.storageKey}`;
	const setOps = cleanObject({
		[`${path}.ga4Status`]: status.ga4Status,
		[`${path}.metaStatus`]: status.metaStatus,
		[`${path}.lastError`]: status.lastError,
		[`${path}.lastTriedAt`]: new Date(),
		...(status.sent ? { [`${path}.sentAt`]: new Date() } : {}),
	});
	await Reservations.updateOne(
		{ _id: reservation._id },
		{
			$set: setOps,
			$unset: { [`${path}.inFlightAt`]: "" },
		},
	).exec();
}

async function sendGa4(config, reservation, spec) {
	if (!config.gaMeasurementId || !config.gaApiSecret) {
		return { skipped: true, status: "not_configured" };
	}
	const url =
		`https://www.google-analytics.com/mp/collect?measurement_id=${encodeURIComponent(
			config.gaMeasurementId,
		)}&api_secret=${encodeURIComponent(config.gaApiSecret)}`;
	const payload = {
		client_id: gaClientId(reservation),
		events: [
			{
				name: spec.gaName,
				params: spec.gaParams,
			},
		],
	};
	const response = await http.post(url, payload, {
		headers: { "Content-Type": "application/json" },
		validateStatus: (status) => status >= 200 && status < 300,
	});
	return { status: String(response.status || "sent") };
}

async function sendMeta(config, reservation, spec, context = {}) {
	if (!config.metaPixelId || !config.metaAccessToken) {
		return { skipped: true, status: "not_configured" };
	}
	const version = safeString(config.metaGraphVersion).replace(/^\/+/, "");
	const url = `https://graph.facebook.com/${version}/${encodeURIComponent(
		config.metaPixelId,
	)}/events`;
	const event = cleanObject({
		event_name: spec.metaName,
		event_time: Math.floor(Date.now() / 1000),
		event_id: spec.eventId,
		action_source: metaActionSource(context),
		event_source_url: spec.eventSourceUrl,
		user_data: metaUserData(reservation, {
			...context,
			clientUserAgent: spec.clientUserAgent,
		}),
		custom_data: spec.metaCustomData,
	});
	const payload = cleanObject({
		data: [event],
		test_event_code: config.metaTestEventCode,
	});
	const response = await http.post(url, payload, {
		params: { access_token: config.metaAccessToken },
		headers: { "Content-Type": "application/json" },
		validateStatus: (status) => status >= 200 && status < 300,
	});
	return {
		status:
			response.data?.events_received !== undefined
				? `received:${response.data.events_received}`
				: String(response.status || "sent"),
	};
}

async function dispatchConversion(reservation, spec, context = {}) {
	if (!enabled()) return { skipped: true, reason: "disabled" };
	const config = analyticsConfig();
	if (!hasConfiguredProvider(config)) {
		return { skipped: true, reason: "not_configured" };
	}
	const claimed = await claimDispatchSlot(reservation, spec);
	if (!claimed) return { skipped: true, reason: "already_sent_or_in_flight" };

	const status = {};
	const errors = [];
	try {
		try {
			const ga = await sendGa4(config, reservation, spec);
			status.ga4Status = ga.status;
		} catch (error) {
			status.ga4Status = "failed";
			errors.push(`ga4:${error?.response?.status || error?.message || error}`);
		}

		try {
			const meta = await sendMeta(config, reservation, spec, context);
			status.metaStatus = meta.status;
		} catch (error) {
			status.metaStatus = "failed";
			const metaError =
				error?.response?.data?.error?.message ||
				error?.response?.status ||
				error?.message ||
				error;
			errors.push(`meta:${metaError}`);
		}

		status.lastError = errors.join("; ").slice(0, 500);
		status.sent = errors.length === 0;
		await updateDispatchStatus(reservation, spec, status);
		if (errors.length) {
			console.warn("[analytics] conversion dispatch warning", {
				reservationId: reservationId(reservation),
				eventId: spec.eventId,
				error: status.lastError,
			});
		}
		return { ok: errors.length === 0, ...status };
	} catch (error) {
		await updateDispatchStatus(reservation, spec, {
			lastError: String(error?.message || error || "").slice(0, 500),
			ga4Status: status.ga4Status || "unknown",
			metaStatus: status.metaStatus || "unknown",
			sent: false,
		});
		console.warn("[analytics] conversion dispatch failed", {
			reservationId: reservationId(reservation),
			eventId: spec.eventId,
			error: error?.message || error,
		});
		return { ok: false, error };
	}
}

function schedule(run) {
	const wrapped = () => {
		Promise.resolve()
			.then(run)
			.catch((error) => {
				console.warn("[analytics] scheduled conversion failed", error?.message || error);
			});
	};
	if (typeof setImmediate === "function") {
		setImmediate(wrapped);
		return;
	}
	setTimeout(wrapped, 0);
}

function scheduleReservationConfirmedConversion(reservation, context = {}) {
	if (!reservation) return;
	schedule(() =>
		dispatchConversion(
			reservation,
			reservationConfirmedSpec(reservation, context),
			context,
		),
	);
}

function schedulePaymentCapturedConversion(reservation, context = {}) {
	if (!reservation) return;
	schedule(() =>
		dispatchConversion(
			reservation,
			paymentCapturedSpec(reservation, context),
			context,
		),
	);
}

module.exports = {
	scheduleReservationConfirmedConversion,
	schedulePaymentCapturedConversion,
	analyticsConfig,
	hasConfiguredProvider,
};
