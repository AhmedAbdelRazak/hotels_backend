/** @format */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const Reservations = require("../models/reservations");
const Rooms = require("../models/rooms");
const {
	ADMIN_RESERVATION_LIST_PROJECTION,
} = require("../services/adminReservationListProjection");
const {
	ADMIN_REPORT_FINANCIAL_AMOUNT_PROJECTION,
} = require("../services/adminReportFinancialAmount");
const { paginatedReservationList } = require("../controllers/janat");
const { paidBreakdownReportAdmin } = require("../controllers/adminreports");
const {
	HOTEL_ID,
	OTA_CONFIRMATION,
	PMS_CONFIRMATION,
	auditedAgodaPricingOverrideReservation,
} = require("./fixtures/auditedOtaPricingOverrideFixture");

const clone = (value) => {
	if (value instanceof Date) return new Date(value.getTime());
	if (value instanceof mongoose.Types.ObjectId) {
		return new mongoose.Types.ObjectId(String(value));
	}
	if (Array.isArray(value)) return value.map(clone);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([key, nested]) => [key, clone(nested)]),
		);
	}
	return value;
};

const getPath = (source, dottedPath) =>
	dottedPath.split(".").reduce((cursor, key) => cursor?.[key], source);

const setPath = (target, dottedPath, value) => {
	const parts = dottedPath.split(".");
	const final = parts.pop();
	let cursor = target;
	for (const part of parts) {
		if (!cursor[part] || typeof cursor[part] !== "object") cursor[part] = {};
		cursor = cursor[part];
	}
	cursor[final] = clone(value);
};

const deletePath = (target, dottedPath) => {
	const parts = dottedPath.split(".");
	const final = parts.pop();
	const cursor = parts.reduce((value, key) => value?.[key], target);
	if (cursor && typeof cursor === "object") delete cursor[final];
};

const applyExclusionProjection = (source, projection) => {
	const projected = clone(source);
	for (const [path, include] of Object.entries(projection || {})) {
		if (include === 0) deletePath(projected, path);
	}
	return projected;
};

const applyInclusiveProjection = (source, projection) => {
	const projected = {};
	if (source?._id !== undefined) projected._id = clone(source._id);
	for (const path of String(projection || "").split(/\s+/).filter(Boolean)) {
		if (path.startsWith("-")) continue;
		const value = getPath(source, path);
		if (value !== undefined) setPath(projected, path, value);
	}
	return projected;
};

const response = () => ({
	statusCode: 200,
	payload: undefined,
	status(code) {
		this.statusCode = code;
		return this;
	},
	set() {
		return this;
	},
	json(payload) {
		this.payload = payload;
		return payload;
	},
});

test("the exact audited Agoda override reaches the compact all-reservations row and nested evidence stays private", async () => {
	const source = auditedAgodaPricingOverrideReservation();
	const originalReservationsFind = Reservations.find;
	const originalRoomsFind = Rooms.find;
	let selectedProjection;
	let loadedDocument;

	Reservations.find = () => ({
		sort() {
			return this;
		},
		select(projection) {
			selectedProjection = projection;
			return this;
		},
		populate() {
			return this;
		},
		lean() {
			loadedDocument = applyExclusionProjection(source, selectedProjection);
			return Promise.resolve([loadedDocument]);
		},
	});
	Rooms.find = () => ({
		select() {
			return this;
		},
		lean() {
			return this;
		},
		exec() {
			return Promise.resolve([]);
		},
	});

	const res = response();
	try {
		await paginatedReservationList(
			{
				query: { page: "1", limit: "15", searchQuery: PMS_CONFIRMATION },
				profile: {
					_id: new mongoose.Types.ObjectId("64d000000000000000000004"),
					role: 1000,
					roleDescription: "super admin",
				},
			},
			res,
		);
	} finally {
		Reservations.find = originalReservationsFind;
		Rooms.find = originalRoomsFind;
	}

	assert.equal(res.statusCode, 200);
	assert.deepEqual(selectedProjection, ADMIN_RESERVATION_LIST_PROJECTION);
	assert.ok(loadedDocument.supplierData.otaCommercialEvidence);
	assert.ok(loadedDocument.supplierData.hotelRunnerEmailCommercialEvidence);
	assert.equal(res.payload.totalDocuments, 1);
	assert.equal(res.payload.data.length, 1);

	const row = res.payload.data[0];
	assert.equal(row.confirmation_number, PMS_CONFIRMATION);
	assert.equal(row.confirmation_number2, OTA_CONFIRMATION);
	assert.equal(row.gross_total_amount, 481.2);
	assert.equal(row.net_total_amount, 297.68);
	assert.equal(row.financial_totals_currency, "SAR");
	assert.equal(row.gross_total_available, true);
	assert.equal(row.net_total_available, true);
	assert.equal(row.adminPricing.clientTotal, 481.2);
	assert.equal(row.adminPricing.netAfterExpensesTotal, 297.68);
	assert.equal(row.supplierData.otaCreatedFromEmail, true);
	assert.equal(row.supplierData.otaProvider, "agoda");
	assert.equal(row.supplierData.otaCommercialEvidence, undefined);
	assert.equal(row.supplierData.hotelRunnerEmailCommercialEvidence, undefined);
});

const paidAggregate = Object.freeze({
	totalAmount: 481.2,
	paidAmount: 490.9,
	paid_online_via_link: 0,
	paid_at_hotel_cash: 0,
	paid_at_hotel_card: 0,
	paid_to_hotel: 0,
	paid_online_jannatbooking: 0,
	paid_online_other_platforms: 490.9,
	paid_online_via_instapay: 0,
	paid_no_show: 0,
});

test("paid report uses audited gross/net scorecards through its declared projection while the OTA payment ledger is unchanged", async () => {
	const source = auditedAgodaPricingOverrideReservation();
	const originals = {
		countDocuments: Reservations.countDocuments,
		find: Reservations.find,
		aggregate: Reservations.aggregate,
	};
	const financialProjections = [];

	Reservations.countDocuments = async () => 1;
	Reservations.find = () => {
		let selectedProjection = null;
		return {
			sort() {
				return this;
			},
			skip() {
				return this;
			},
			limit() {
				return this;
			},
			populate() {
				return this;
			},
			select(projection) {
				selectedProjection = projection;
				financialProjections.push(projection);
				return this;
			},
			lean: async () => [
				selectedProjection
					? applyInclusiveProjection(source, selectedProjection)
					: clone(source),
			],
		};
	};
	Reservations.aggregate = async () => [{ ...paidAggregate }];

	const load = async (totalMode) => {
		const res = response();
		await paidBreakdownReportAdmin(
			{
				query: { hotelId: HOTEL_ID, totalMode },
				profile: { role: 8000 },
			},
			res,
		);
		assert.equal(res.statusCode, 200);
		return res.payload;
	};

	let gross;
	let net;
	try {
		gross = await load("gross");
		net = await load("net");
	} finally {
		Reservations.countDocuments = originals.countDocuments;
		Reservations.find = originals.find;
		Reservations.aggregate = originals.aggregate;
	}

	assert.deepEqual(financialProjections, [
		ADMIN_REPORT_FINANCIAL_AMOUNT_PROJECTION,
		ADMIN_REPORT_FINANCIAL_AMOUNT_PROJECTION,
	]);
	for (const projection of financialProjections) {
		assert.match(projection, /\botaPlatformReview\b/);
		assert.match(projection, /\bpickedRoomsPricing\b/);
		assert.match(projection, /supplierData\.otaCommercialEvidence\b/);
		assert.match(
			projection,
			/supplierData\.hotelRunnerEmailCommercialEvidence\b/,
		);
	}

	assert.equal(gross.scorecards.totalAmount, 481.2);
	assert.equal(net.scorecards.totalAmount, 297.68);
	assert.equal(gross.scorecards.financialIncludedCount, 1);
	assert.equal(net.scorecards.financialIncludedCount, 1);
	assert.deepEqual(gross.scorecards.financialMetadata, {
		netFallback: 0,
		unavailable: 0,
		foreignCurrency: 0,
	});
	assert.deepEqual(net.scorecards.financialMetadata, {
		netFallback: 0,
		unavailable: 0,
		foreignCurrency: 0,
	});

	const grossRow = gross.data[0];
	const netRow = net.data[0];
	for (const row of [grossRow, netRow]) {
		assert.equal(row.confirmation_number, PMS_CONFIRMATION);
		assert.equal(row.gross_total_amount, 481.2);
		assert.equal(row.net_total_amount, 297.68);
		assert.equal(row.gross_total_available, true);
		assert.equal(row.net_total_available, true);
		assert.equal(row.paid_breakdown_total, 490.9);
		assert.equal(row.paid_amount_breakdown.paid_online_other_platforms, 490.9);
	}
	assert.equal(grossRow.report_total_amount, 481.2);
	assert.equal(netRow.report_total_amount, 297.68);
	assert.equal(grossRow.report_total_net_fallback, false);
	assert.equal(netRow.report_total_net_fallback, false);

	assert.equal(gross.scorecards.paidAmount, 490.9);
	assert.equal(net.scorecards.paidAmount, 490.9);
	assert.deepEqual(
		gross.scorecards.breakdownTotals,
		net.scorecards.breakdownTotals,
	);
	assert.equal(
		gross.scorecards.breakdownTotals.paid_online_other_platforms,
		490.9,
	);
	assert.deepEqual(grossRow.paid_amount_breakdown, netRow.paid_amount_breakdown);
});
