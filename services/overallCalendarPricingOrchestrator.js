"use strict";

const crypto = require("crypto");

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DATES = 370;
const MAX_ROWS = 25000;

const normalizeId = (value) => String(value?._id || value || "").trim();

const toDateKey = (value) => {
	if (!value) return "";
	if (typeof value === "string" && DATE_RE.test(value.slice(0, 10))) {
		return value.slice(0, 10);
	}
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString().slice(0, 10);
};

const money = (value, fallback = 0) => {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 ? Number(parsed.toFixed(2)) : fallback;
};

const percent = (value, fallback = 0) => {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed < 0) return fallback;
	return Number(parsed.toFixed(2));
};

const uniqueDates = (dates = []) =>
	[
		...new Set(
			(Array.isArray(dates) ? dates : [])
				.map(toDateKey)
				.filter(Boolean)
				.sort()
		),
	];

const colorForPlan = ({ sellingPrice = 0, commissionPercent = 0, scope = "general" }) => {
	const seed = `${scope}:${sellingPrice}:${commissionPercent}`;
	const hash = crypto.createHash("md5").update(seed).digest("hex");
	const hue = parseInt(hash.slice(0, 2), 16) % 360;
	return `hsl(${hue}, 72%, 42%)`;
};

const agentSnapshot = (agent = {}) => ({
	agentId: normalizeId(agent._id || agent.agentId),
	agentName: agent.name || agent.email || "",
	agentEmail: agent.email || "",
	companyName: agent.companyName || agent.companyOfficialName || "",
});

const buildPricingPlan = ({
	scope = "general",
	dates = [],
	sellingPrice,
	commissionPercent,
	status = "open",
	calendarType = "hijri",
	source = "overall-calendar-pricing",
}) => {
	const normalizedDates = uniqueDates(dates);
	if (!normalizedDates.length) {
		return { ok: false, error: "Please select at least one date" };
	}
	if (normalizedDates.length > MAX_DATES) {
		return {
			ok: false,
			error: `Please select ${MAX_DATES} days or fewer at once`,
		};
	}

	const blocked = ["blocked", "closed", "restricted"].includes(
		String(status || "").toLowerCase()
	);
	const finalSellingPrice = blocked ? 0 : money(sellingPrice, 0);
	const finalCommissionPercent = blocked ? 0 : percent(commissionPercent, 0);
	if (!blocked && !(finalSellingPrice > 0)) {
		return { ok: false, error: "Selling price is required" };
	}
	const computedRootPrice = blocked
		? 0
		: money(finalSellingPrice - finalSellingPrice * (finalCommissionPercent / 100), 0);
	const color = blocked
		? "black"
		: colorForPlan({
				sellingPrice: finalSellingPrice,
				commissionPercent: finalCommissionPercent,
				scope,
		  });

	return {
		ok: true,
		scope,
		dates: normalizedDates,
		blocked,
		sellingPrice: finalSellingPrice,
		commissionPercent: finalCommissionPercent,
		rootPrice: computedRootPrice,
		commissionRateForPms: 0,
		color,
		calendarType: calendarType === "gregorian" ? "gregorian" : "hijri",
		source,
	};
};

const buildGeneralRow = (plan, room = {}, calendarDate) => ({
	calendarDate,
	room_type: room.roomType || room.room_type || "",
	displayName: room.displayName || room.display_name || "",
	price: plan.sellingPrice,
	rootPrice: plan.rootPrice,
	commissionRate: plan.commissionRateForPms,
	sellingPrice: plan.sellingPrice,
	commissionPercent: plan.commissionPercent,
	color: plan.color,
	calendarType: plan.calendarType,
	source: plan.source,
	...(plan.priceVariantDataId
		? { priceVariantDataId: normalizeId(plan.priceVariantDataId) }
		: {}),
	...(plan.priceVariantItemId
		? { priceVariantItemId: normalizeId(plan.priceVariantItemId) }
		: {}),
	...(plan.priceVariantName ? { priceVariantName: plan.priceVariantName } : {}),
	...(plan.priceVariantNameOtherLanguage
		? { priceVariantNameOtherLanguage: plan.priceVariantNameOtherLanguage }
		: {}),
	...(plan.blocked
		? {
				status: "blocked",
				blocked: true,
		  }
		: {}),
});

const buildAgentRow = (plan, room = {}, calendarDate, agent = {}) => ({
	...agentSnapshot(agent),
	...buildGeneralRow(plan, room, calendarDate),
});

const ensurePlanSize = ({ dates = [], roomCount = 0, agentCount = 1 }) => {
	const rows = dates.length * Math.max(roomCount, 1) * Math.max(agentCount, 1);
	if (rows > MAX_ROWS) {
		return {
			ok: false,
			error: `This would update ${rows} rows. Please split it into smaller batches.`,
		};
	}
	return { ok: true, rows };
};

module.exports = {
	buildAgentRow,
	buildGeneralRow,
	buildPricingPlan,
	ensurePlanSize,
	normalizeId,
	toDateKey,
};
