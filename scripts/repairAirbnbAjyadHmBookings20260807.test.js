/** @format */

"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
	REPAIR_ID,
	TARGETS,
	assertExpectedProjection,
	hmzCorrectionSet,
	parseArguments,
} = require("./repairAirbnbAjyadHmBookings20260807");

function projectedReservation(target) {
	const pricingByDay = target.dailyRoots.map((rootPrice, index) => ({
		date: `2026-08-${String(index + 1).padStart(2, "0")}`,
		rootPrice,
		commissionRate: 0,
	}));
	const room = {
		hotelRoomConfigId: target.roomId,
		room_type: target.roomType,
		hotelShouldGet: target.rootTotal,
		pricingByDay,
	};
	return {
		hotelId: "6a40b6a1a6efe70450536038",
		total_amount: target.guestTotal,
		sub_total: target.rootTotal,
		commission: 0,
		commission_ota: target.otaCommission,
		checkin_date: target.checkin,
		checkout_date: target.checkout,
		pickedRoomsType: [room],
		pickedRoomsPricing: [JSON.parse(JSON.stringify(room))],
		adminPricing: { rootTotal: target.rootTotal, commissionAmount: 0 },
		ota_financial_summary: {
			hotelVisibleAmount: target.rootTotal,
			commissionAmount: 0,
		},
		financial_cycle: {
			commissionValue: 0,
			commissionAmount: 0,
			hotelPayoutDue: target.rootTotal,
		},
		supplierData: {
			otaHotelRoomConfigId: target.roomId,
			otaCommissionSar: target.otaCommission,
			otaCommissionSource: "airbnb_host_service_fee",
			otaCommissionSourceBacked: true,
		},
	};
}

test("repair CLI is dry-run by default and apply requires both immutable interlocks", () => {
	assert.deepEqual(parseArguments([]), { apply: false, repairId: "", planHash: "" });
	assert.throws(() => parseArguments(["--apply"]), /--repair-id/);
	assert.throws(
		() =>
			parseArguments([
				"--apply",
				"--repair-id",
				REPAIR_ID,
				"--plan-hash",
				"bad",
			]),
		/plan hash/
	);
});

test("both exact target projections require separate zero legacy and explicit OTA commissions", () => {
	for (const [code, target] of Object.entries(TARGETS)) {
		assert.doesNotThrow(() =>
			assertExpectedProjection(projectedReservation(target), code, target)
		);
		const wrong = projectedReservation(target);
		wrong.commission = target.otaCommission;
		assert.throws(() => assertExpectedProjection(wrong, code, target));
	}
});

test("Safwan correction changes only the scoped commercial bundle and records post-release provenance", () => {
	const target = TARGETS.hmzdmhqqre;
	const before = {
		adminPricing: { mode: "ota_review", rootTotal: 0, employeeFlag: "keep" },
		ota_financial_summary: { clientTotal: target.guestTotal, hotelVisibleAmount: 0 },
		financial_cycle: { status: "open", hotelPayoutDue: 0, notes: "keep" },
	};
	const built = projectedReservation(target);
	built.adminPricing.platformMarginTotal = -103.12;
	built.ota_financial_summary.platformProfit = -103.12;
	built.supplierData.otaMatchedRoomName = "Triple Room - Premium Comfort";
	built.supplierData.otaSourceRoomName = "COMFORT TRIPLE ROOM - AJYAD HOTEL - FREE BUS";
	built.supplierData.otaRoomMatchScore = 1;
	built.supplierData.otaRoomMatchType = "explicit_room_semantic";
	const at = new Date("2026-08-07T21:00:00.000Z");
	const set = hmzCorrectionSet(before, built, at);

	assert.equal(set.sub_total, 375);
	assert.equal(set.commission, 0);
	assert.equal(set.commission_ota, 49.87);
	assert.equal(set.adminPricing.employeeFlag, "keep");
	assert.equal(set.financial_cycle.notes, "keep");
	assert.equal(set.financial_cycle.hotelPayoutDue, 375);
	assert.equal(set["supplierData.otaHotelRoomConfigId"], target.roomId);
	assert.equal(
		set["otaPlatformReview.postReleasePricingCorrection"].repairId,
		REPAIR_ID
	);
	for (const protectedPath of [
		"state",
		"reservation_status",
		"pendingConfirmation",
		"roomId",
	]) {
		assert.equal(Object.prototype.hasOwnProperty.call(set, protectedPath), false);
	}
});
