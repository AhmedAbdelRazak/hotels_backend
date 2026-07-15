const hasUsableOwnValue = (source, field) => {
	if (!source || typeof source !== "object") return false;
	if (!Object.prototype.hasOwnProperty.call(source, field)) return false;
	const value = source[field];
	if (value === null || value === undefined) return false;
	return typeof value !== "string" || value.trim() !== "";
};

const compactAdminPricingForReservationList = (adminPricing = {}) => {
	const source =
		adminPricing && typeof adminPricing === "object" ? adminPricing : {};
	const hasNetAfterExpenses = hasUsableOwnValue(
		source,
		"netAfterExpensesTotal",
	);
	const hasCalculatedPricingMode =
		/^(admin_three_price$|ota(?:_|$)|platform(?:_|$))/i.test(
			String(source.mode || "").trim(),
		);
	const netAfterExpensesTotal = hasNetAfterExpenses
		? source.netAfterExpensesTotal
		: null;
	const normalizedNetAfterExpenses =
		typeof netAfterExpensesTotal === "string"
			? netAfterExpensesTotal.replace(/,/g, "").trim()
			: netAfterExpensesTotal;
	const numericNetAfterExpenses =
		typeof normalizedNetAfterExpenses === "number" ||
		typeof normalizedNetAfterExpenses === "string"
			? Number(normalizedNetAfterExpenses)
			: null;
	const isUnmarkedSchemaDefaultZero =
		netAfterExpensesTotal !== null &&
		Number.isFinite(numericNetAfterExpenses) &&
		numericNetAfterExpenses === 0 &&
		!hasCalculatedPricingMode;

	return {
		mode: source.mode || "",
		clientTotal: source.clientTotal || 0,
		rootTotal: source.rootTotal || 0,
		platformMarginTotal: source.platformMarginTotal || 0,
		otaExpenseTotal: source.otaExpenseTotal || 0,
		// Missing and unmarked schema-default zero mean "not calculated".
		// Only modes whose writers calculate net pricing can prove a real zero.
		netAfterExpensesTotal: isUnmarkedSchemaDefaultZero
			? null
			: netAfterExpensesTotal,
	};
};

module.exports = { compactAdminPricingForReservationList };
