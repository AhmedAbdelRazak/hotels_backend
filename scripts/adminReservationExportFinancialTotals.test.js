/** @format */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const Reservations = require("../models/reservations");
const {
	buildAuthenticatedProviderCommercialEvidence,
} = require("../services/otaCommercialEvidence");
const {
	exportToExcel,
	reservationExecutiveSummary,
} = require("../controllers/adminreports");

const ASSIGNED_HOTEL_ID = "64a000000000000000000001";
const OTHER_HOTEL_ID = "64b000000000000000000002";

const makeResponse = () => ({
	statusCode: 200,
	body: null,
	status(code) {
		this.statusCode = code;
		return this;
	},
	json(body) {
		this.body = body;
		return this;
	},
});

const buildReservation = ({
	hotelId = ASSIGNED_HOTEL_ID,
	hotelName = "Test Hotel",
	confirmationNumber = "7637630965",
} = {}) => {
	const evidence = buildAuthenticatedProviderCommercialEvidence({
		provider: "agoda",
		authenticatedProvider: "agoda",
		sourceAuthenticated: true,
		sourceTrusted: true,
		sourceType: "authenticated_provider_portal",
		sourceCurrency: "SAR",
		propertyCurrency: "SAR",
		bookingBasis: "reservation_total",
		sourceHash: "a".repeat(64),
		sourceTimestamp: "2026-08-09T12:00:00.000Z",
		sourceId: "agoda-export-1",
		guestGross: { verified: true, amount: 148.96 },
		hotelPayout: { verified: true, amount: 92.18 },
	});
	return {
		confirmation_number: confirmationNumber,
		booking_source: "agoda",
		customer_details: { name: "OTA Guest", phone: "+966500000000" },
		hotelId: {
			_id: new mongoose.Types.ObjectId(hotelId),
			hotelName,
		},
		reservation_status: "confirmed",
		payment: "paid online",
		payment_details: { captured: true, onsite_paid_amount: 0 },
		paid_amount_breakdown: {},
		checkin_date: new Date("2026-08-10T00:00:00.000Z"),
		checkout_date: new Date("2026-08-11T00:00:00.000Z"),
		createdAt: new Date("2026-08-09T00:00:00.000Z"),
		total_amount: 148.96,
		paid_amount: 75,
		pickedRoomsType: [{ room_type: "doubleRooms", count: 2 }],
		adminPricing: {
			mode: "hotelrunner_api",
			propertyCurrency: "SAR",
			clientTotal: 148.96,
			rootTotal: 75,
			netAfterExpensesTotal: 92.18,
			otaExpenseTotal: 56.78,
			commercialVerified: false,
		},
		ota_financial_summary: {
			clientTotal: 148.96,
			netAfterExpenses: 92.18,
			commercialVerified: false,
		},
		adminPricingVisibility: {
			rootOnlyForHotelManagement: true,
		},
		supplierData: {
			otaProvider: "agoda",
			otaCommercialEvidenceStaleReason: "",
			otaCommercialEvidence: evidence,
			hotelRunner: { transport: "hotelrunner_api" },
		},
	};
};

const hotelIdScopesFromFilter = (filter = {}) => {
	const scopes = [];
	const visit = (value) => {
		if (!value || typeof value !== "object") return;
		if (value.hotelId?.$in && Array.isArray(value.hotelId.$in)) {
			scopes.push(new Set(value.hotelId.$in.map((id) => String(id))));
		}
		Object.entries(value).forEach(([key, nested]) => {
			if (key !== "hotelId") visit(nested);
		});
	};
	visit(filter);
	return scopes;
};

const reservationMatchesHotelScopes = (reservation, filter) => {
	const hotelId = String(reservation?.hotelId?._id || reservation?.hotelId || "");
	return hotelIdScopesFromFilter(filter).every((scope) => scope.has(hotelId));
};

const runExport = async (
	originalUrl,
	options = {}
) => {
	const profile = options.profile || {
		_id: "64d000000000000000000004",
		role: 7000,
	};
	const auth = options.auth || { _id: profile._id };
	const headers = options.headers || {};
	const sourceReservations = options.sourceReservations || [buildReservation()];
	const originalFind = Reservations.find;
	let capturedFilter = null;
	Reservations.find = (filter) => ({
		populate() {
			capturedFilter = filter;
			return this;
		},
		lean() {
			return Promise.resolve(
				sourceReservations.filter((reservation) =>
					reservationMatchesHotelScopes(reservation, filter)
				)
			);
		},
	});
	const req = {
		params: { userId: "64d000000000000000000004" },
		query: {},
		profile,
		auth,
		headers,
		originalUrl,
	};
	const res = makeResponse();
	try {
		await exportToExcel(req, res);
	} finally {
		Reservations.find = originalFind;
	}
	assert.equal(res.statusCode, 200);
	return { rows: res.body, capturedFilter };
};

test("platform admin Excel data uses the same verified gross and net totals as the table", async () => {
	const { rows } = await runExport(
		"/api/adminreports/export-to-excel/64d000000000000000000004"
	);
	assert.equal(rows.length, 1);
	const row = rows[0];
	assert.equal(row.gross_total_amount, 148.96);
	assert.equal(row.net_total_amount, 92.18);
	assert.equal(row.total_amount, 148.96, "admin export keeps the guest gross total");
	assert.equal(row.financial_totals_currency, "SAR");
	assert.equal(row.gross_total_available, true);
	assert.equal(row.net_total_available, true);
	assert.equal(row.booking_source, "agoda");
	assert.equal(row.room_count, 2);
	assert.equal(row.paid_amount, 75, "paid remains an independent collection field");
});

test("shared hotel-management export endpoint does not expose platform OTA totals", async () => {
	const { rows, capturedFilter } = await runExport(
		"/api/hotel-adminreports/export-to-excel/64d000000000000000000004",
		{
			profile: {
				_id: "64e000000000000000000005",
				role: 2000,
				roleDescription: "hotelmanager",
				hotelIdsOwner: [ASSIGNED_HOTEL_ID],
			},
			auth: { _id: "64e000000000000000000005" },
			headers: {},
			sourceReservations: [
				buildReservation({
					hotelId: ASSIGNED_HOTEL_ID,
					confirmationNumber: "ASSIGNED-HOTEL-RESERVATION",
				}),
				buildReservation({
					hotelId: OTHER_HOTEL_ID,
					hotelName: "Other Hotel",
					confirmationNumber: "OTHER-HOTEL-RESERVATION",
				}),
			],
		}
	);
	assert.equal(rows.length, 1);
	const row = rows[0];
	assert.equal(row.confirmation_number, "ASSIGNED-HOTEL-RESERVATION");
	assert.equal(row.total_amount, 75, "hotel export uses the root-visible total");
	assert.equal(Object.hasOwn(row, "gross_total_amount"), true);
	assert.equal(Object.hasOwn(row, "net_total_amount"), true);
	assert.equal(row.gross_total_amount, null);
	assert.equal(row.net_total_amount, null);
	assert.equal(row.financial_totals_currency, null);
	assert.equal(row.gross_total_available, false);
	assert.equal(row.net_total_available, false);
	const serializedFilter = JSON.stringify(capturedFilter);
	assert.match(serializedFilter, new RegExp(ASSIGNED_HOTEL_ID));
	assert.doesNotMatch(serializedFilter, new RegExp(OTHER_HOTEL_ID));
});

test("hotel-management export fails closed when the authenticated actor has no hotel assignment", async () => {
	const { rows, capturedFilter } = await runExport(
		"/api/hotel-adminreports/export-to-excel/64e000000000000000000005",
		{
			profile: {
				_id: "64e000000000000000000005",
				role: 2000,
				roleDescription: "hotelmanager",
			},
			auth: { _id: "64e000000000000000000005" },
		}
	);

	assert.deepEqual(rows, []);
	assert.equal(
		hotelIdScopesFromFilter(capturedFilter).some((scope) => scope.size === 0),
		true,
		"an unassigned hotel actor must be constrained by an empty hotel scope"
	);
});

test("platform role 1000 keeps its assigned-hotel scope on the admin export route", async () => {
	const { rows, capturedFilter } = await runExport(
		"/api/adminreports/export-to-excel/64f000000000000000000006",
		{
			profile: {
				_id: "64f000000000000000000006",
				role: 1000,
				roleDescription: "platform staff",
				hotelsToSupport: [ASSIGNED_HOTEL_ID],
			},
			auth: { _id: "64f000000000000000000006" },
			sourceReservations: [
				buildReservation({
					hotelId: ASSIGNED_HOTEL_ID,
					confirmationNumber: "PLATFORM-ASSIGNED",
				}),
				buildReservation({
					hotelId: OTHER_HOTEL_ID,
					confirmationNumber: "PLATFORM-OTHER",
				}),
			],
		}
	);

	assert.equal(rows.length, 1);
	assert.equal(rows[0].confirmation_number, "PLATFORM-ASSIGNED");
	const serializedFilter = JSON.stringify(capturedFilter);
	assert.match(serializedFilter, new RegExp(ASSIGNED_HOTEL_ID));
	assert.doesNotMatch(serializedFilter, new RegExp(OTHER_HOTEL_ID));
});

test("mixed-role platform staff cannot bypass assigned-hotel scope", async () => {
	const { rows, capturedFilter } = await runExport(
		"/api/adminreports/export-to-excel/650000000000000000000007",
		{
			profile: {
				_id: "650000000000000000000007",
				role: 2000,
				roles: [1000],
				roleDescription: "hotelmanager",
				hotelsToSupport: [ASSIGNED_HOTEL_ID],
			},
			auth: { _id: "650000000000000000000007" },
			sourceReservations: [
				buildReservation({
					hotelId: ASSIGNED_HOTEL_ID,
					confirmationNumber: "MIXED-ROLE-ASSIGNED",
				}),
				buildReservation({
					hotelId: OTHER_HOTEL_ID,
					confirmationNumber: "MIXED-ROLE-OTHER",
				}),
			],
		}
	);

	assert.equal(rows.length, 1);
	assert.equal(rows[0].confirmation_number, "MIXED-ROLE-ASSIGNED");
	const serializedFilter = JSON.stringify(capturedFilter);
	assert.match(serializedFilter, new RegExp(ASSIGNED_HOTEL_ID));
	assert.doesNotMatch(serializedFilter, new RegExp(OTHER_HOTEL_ID));
});

test("executive summary loads every bounded field required to verify legacy OTA totals", async () => {
	const originalFind = Reservations.find;
	let selectedFields = "";
	Reservations.find = () => ({
		select(fields) {
			selectedFields = fields;
			return this;
		},
		populate() {
			return this;
		},
		sort() {
			return this;
		},
		maxTimeMS() {
			return this;
		},
		lean() {
			return Promise.resolve([]);
		},
	});
	const req = {
		query: { day: "today" },
		profile: { _id: "650000000000000000000008", role: 8000 },
		auth: { _id: "650000000000000000000008" },
	};
	const res = makeResponse();
	try {
		await reservationExecutiveSummary(req, res);
	} finally {
		Reservations.find = originalFind;
	}

	assert.equal(res.statusCode, 200);
	const selectedFieldSet = new Set(selectedFields.split(/\s+/).filter(Boolean));
	for (const field of [
		"adminPricing",
		"ota_financial_summary",
		"supplierData.otaCommercialEvidence",
		"supplierData.otaCommercialEvidenceStaleReason",
		"supplierData.hotelRunnerEmailCommercialEvidence",
		"supplierData.hotelRunner.transport",
		"supplierData.otaPaymentSummary",
		"supplierData.otaAmountSar",
		"pickedRoomsPricing",
		"pickedRoomsType",
		"commission_ota",
		"otaIdentityKey",
		"otaCrossTransportIdentityKey",
	]) {
		assert.equal(selectedFieldSet.has(field), true, `${field} must be selected`);
	}
});
