const hotelRunnerReservationExpression = () => ({
	$or: [
		{ $eq: ["$adminPricing.mode", "hotelrunner_api"] },
		{
			$eq: [
				"$supplierData.hotelRunner.transport",
				"hotelrunner_api",
			],
		},
		{
			$eq: [
				"$supplierData.otaAutomationPipeline",
				"hotelrunner-background-worker",
			],
		},
		{
			$ne: [
				{ $ifNull: ["$supplierData.hotelRunner.reservationId", ""] },
				"",
			],
		},
		{
			$ne: [
				{ $ifNull: ["$supplierData.hotelRunner.hrNumber", ""] },
				"",
			],
		},
		{
			$ne: [
				{ $ifNull: ["$supplierData.hotelRunner.pricing", null] },
				null,
			],
		},
	],
});

const buildHotelRunnerReservationExpression = () =>
	hotelRunnerReservationExpression();

const convertedMoneyExpression = (field) => ({
	$convert: {
		input: field,
		to: "double",
		onError: null,
		onNull: null,
	},
});

const nullableMoneyExpression = (field) => {
	const converted = convertedMoneyExpression(field);
	return {
		$cond: [
			{
				$and: [
					{
						$in: [
							{ $type: field },
							["double", "int", "long", "decimal", "string"],
						],
					},
					{ $ne: [converted, null] },
					{ $eq: [converted, converted] },
					{ $gte: [converted, 0] },
					{ $lte: [converted, Number.MAX_VALUE] },
				],
			},
			converted,
			null,
		],
	};
};

const verifiedMetricExpressions = (sources = []) => {
	const entries = sources.flatMap((source) =>
		(source.fields || []).map((field) => {
			const value = nullableMoneyExpression(field);
			const verified = { $eq: [source.verifiedField, true] };
			const explicitlyPresent = {
				$ne: [{ $ifNull: [field, null] }, null],
			};
			return { value, verified, explicitlyPresent };
		})
	);
	const verifiedValues = entries.map((entry) => ({
		$cond: [entry.verified, entry.value, null],
	}));
	const presentValues = {
		$filter: {
			input: verifiedValues,
			as: "hotelRunnerVerifiedAmount",
			cond: { $ne: ["$$hotelRunnerVerifiedAmount", null] },
		},
	};
	const invalidEvidence = entries.length
		? {
				$or: entries.map((entry) => ({
					$and: [
						entry.verified,
						entry.explicitlyPresent,
						{ $eq: [entry.value, null] },
					],
				})),
		  }
		: false;
	const distinctRoundedValues = {
		$setUnion: [
			{
				$map: {
					input: presentValues,
					as: "hotelRunnerVerifiedAmount",
					in: { $round: ["$$hotelRunnerVerifiedAmount", 2] },
				},
			},
			[],
		],
	};
	const available = {
		$and: [
			{ $gt: [{ $size: presentValues }, 0] },
			{ $eq: [{ $size: distinctRoundedValues }, 1] },
			{ $not: [invalidEvidence] },
		],
	};

	return {
		available,
		value: {
			$cond: [
				available,
				{ $round: [{ $arrayElemAt: [presentValues, 0] }, 2] },
				0,
			],
		},
	};
};

const HOTELRUNNER_PROFIT_METRIC_SOURCES = {
	netAfterExpenses: [
		{
			verifiedField: "$adminPricing.commercialVerified",
			fields: ["$adminPricing.netAfterExpensesTotal"],
		},
		{
			verifiedField: "$ota_financial_summary.commercialVerified",
			fields: [
				"$ota_financial_summary.netAfterExpenses",
				"$ota_financial_summary.netAfterOtaExpenses",
			],
		},
		{
			verifiedField: "$otaFinancialSummary.commercialVerified",
			fields: [
				"$otaFinancialSummary.netAfterExpenses",
				"$otaFinancialSummary.netAfterOtaExpenses",
			],
		},
	],
	otaExpense: [
		{
			verifiedField: "$adminPricing.commercialVerified",
			fields: ["$adminPricing.otaExpenseTotal"],
		},
		{
			verifiedField: "$ota_financial_summary.commercialVerified",
			fields: ["$ota_financial_summary.otaExpenseTotal"],
		},
		{
			verifiedField: "$otaFinancialSummary.commercialVerified",
			fields: ["$otaFinancialSummary.otaExpenseTotal"],
		},
	],
	commission: [
		{
			verifiedField: "$adminPricing.commercialVerified",
			fields: ["$adminPricing.commissionAmount"],
		},
		{
			verifiedField: "$ota_financial_summary.commercialVerified",
			fields: ["$ota_financial_summary.commissionAmount"],
		},
		{
			verifiedField: "$otaFinancialSummary.commercialVerified",
			fields: ["$otaFinancialSummary.commissionAmount"],
		},
	],
	platformMargin: [
		{
			verifiedField: "$adminPricing.commercialVerified",
			fields: ["$adminPricing.platformMarginTotal"],
		},
		{
			verifiedField: "$ota_financial_summary.commercialVerified",
			fields: ["$ota_financial_summary.platformProfit"],
		},
		{
			verifiedField: "$otaFinancialSummary.commercialVerified",
			fields: ["$otaFinancialSummary.platformProfit"],
		},
	],
};

const buildHotelRunnerProfitAggregationFields = () => {
	const net = verifiedMetricExpressions(
		HOTELRUNNER_PROFIT_METRIC_SOURCES.netAfterExpenses
	);
	const expense = verifiedMetricExpressions(
		HOTELRUNNER_PROFIT_METRIC_SOURCES.otaExpense
	);
	const commission = verifiedMetricExpressions(
		HOTELRUNNER_PROFIT_METRIC_SOURCES.commission
	);
	const platformMargin = verifiedMetricExpressions(
		HOTELRUNNER_PROFIT_METRIC_SOURCES.platformMargin
	);
	return {
		profitIsHotelRunner: hotelRunnerReservationExpression(),
		profitHotelRunnerNetAvailable: net.available,
		profitHotelRunnerNet: net.value,
		profitHotelRunnerOtaExpenseAvailable: expense.available,
		profitHotelRunnerOtaExpense: expense.value,
		profitHotelRunnerCommissionAvailable: commission.available,
		profitHotelRunnerCommission: commission.value,
		profitHotelRunnerPlatformMarginAvailable: platformMargin.available,
		profitHotelRunnerPlatformMargin: platformMargin.value,
	};
};

const hotelRunnerExpenseMetricExpressions = () =>
	verifiedMetricExpressions(HOTELRUNNER_PROFIT_METRIC_SOURCES.otaExpense);

const firstVerifiedOtaExpenseExpression = () =>
	hotelRunnerExpenseMetricExpressions().value;

const verifiedHotelRunnerExpenseAvailableExpression = () => ({
	$and: [
		hotelRunnerReservationExpression(),
		hotelRunnerExpenseMetricExpressions().available,
	],
});

const verifiedHotelRunnerNetAvailableExpression = () => {
	const net = verifiedMetricExpressions(
		HOTELRUNNER_PROFIT_METRIC_SOURCES.netAfterExpenses
	);
	return {
		$and: [hotelRunnerReservationExpression(), net.available],
	};
};

const firstVerifiedHotelRunnerNetExpression = () =>
	verifiedMetricExpressions(
		HOTELRUNNER_PROFIT_METRIC_SOURCES.netAfterExpenses
	).value;

const buildHotelRunnerSafeCommissionExpression = (legacyExpression) => ({
	$cond: [
		hotelRunnerReservationExpression(),
		{
			$cond: [
				verifiedHotelRunnerExpenseAvailableExpression(),
				firstVerifiedOtaExpenseExpression(),
				0,
			],
		},
		legacyExpression,
	],
});

const buildHotelRunnerUnverifiedExpenseCountExpression = () => ({
	$cond: [
		{
			$and: [
				hotelRunnerReservationExpression(),
				{ $not: [verifiedHotelRunnerExpenseAvailableExpression()] },
			],
		},
		1,
		0,
	],
});

const buildHotelRunnerSafeNetExpression = (legacyExpression) => ({
	$cond: [
		hotelRunnerReservationExpression(),
		{
			$cond: [
				verifiedHotelRunnerNetAvailableExpression(),
				firstVerifiedHotelRunnerNetExpression(),
				0,
			],
		},
		legacyExpression,
	],
});

const buildHotelRunnerUnverifiedNetCountExpression = () => ({
	$cond: [
		{
			$and: [
				hotelRunnerReservationExpression(),
				{ $not: [verifiedHotelRunnerNetAvailableExpression()] },
			],
		},
		1,
		0,
	],
});

const cleanText = (value) => String(value == null ? "" : value).trim();
const finiteMoneyOrNull = (value) => {
	if (
		value === null ||
		value === undefined ||
		value === "" ||
		typeof value === "boolean" ||
		(typeof value !== "number" && typeof value !== "string")
	) {
		return null;
	}
	const normalized =
		typeof value === "string" ? value.replace(/,/g, "").trim() : value;
	if (normalized === "") return null;
	const amount = Number(normalized);
	return Number.isFinite(amount) && amount >= 0
		? Number(amount.toFixed(2))
		: null;
};

const firstVerifiedMetric = (sources = []) => {
	const amounts = [];
	for (const source of sources) {
		if (source?.verified !== true) continue;
		for (const candidate of source.values || []) {
			if (candidate === null || candidate === undefined) continue;
			const amount = finiteMoneyOrNull(candidate);
			if (amount === null) return { available: false, amount: null };
			amounts.push(amount);
		}
	}
	if (!amounts.length) return { available: false, amount: null };
	const distinctAmounts = new Set(amounts.map((amount) => amount.toFixed(2)));
	if (distinctAmounts.size !== 1) {
		return { available: false, amount: null };
	}
	return { available: true, amount: amounts[0] };
};

const isHotelRunnerReservation = (reservation = {}) => {
	const hotelRunner = reservation?.supplierData?.hotelRunner;
	return (
		cleanText(reservation?.adminPricing?.mode) === "hotelrunner_api" ||
		cleanText(hotelRunner?.transport) === "hotelrunner_api" ||
		cleanText(reservation?.supplierData?.otaAutomationPipeline) ===
			"hotelrunner-background-worker" ||
		(Boolean(hotelRunner) &&
			(typeof hotelRunner === "object") &&
			(Boolean(cleanText(hotelRunner.reservationId)) ||
				Boolean(cleanText(hotelRunner.hrNumber)) ||
				Boolean(hotelRunner.pricing && typeof hotelRunner.pricing === "object")))
	);
};

const verifiedHotelRunnerOtaExpense = (reservation = {}) => {
	if (!isHotelRunnerReservation(reservation)) {
		return { isHotelRunner: false, available: false, amount: null };
	}
	const adminPricing = reservation?.adminPricing || {};
	const snakeSummary = reservation?.ota_financial_summary || {};
	const camelSummary = reservation?.otaFinancialSummary || {};
	const metric = firstVerifiedMetric([
		{
			verified: adminPricing.commercialVerified,
			values: [adminPricing.otaExpenseTotal],
		},
		{
			verified: snakeSummary.commercialVerified,
			values: [snakeSummary.otaExpenseTotal],
		},
		{
			verified: camelSummary.commercialVerified,
			values: [camelSummary.otaExpenseTotal],
		},
	]);
	return { isHotelRunner: true, ...metric };
};

const verifiedHotelRunnerProfitMetrics = (reservation = {}) => {
	if (!isHotelRunnerReservation(reservation)) {
		return { isHotelRunner: false };
	}
	const adminPricing = reservation?.adminPricing || {};
	const snakeSummary = reservation?.ota_financial_summary || {};
	const camelSummary = reservation?.otaFinancialSummary || {};
	const sources = (adminValues, snakeValues, camelValues) => [
		{
			verified: adminPricing.commercialVerified,
			values: adminValues,
		},
		{
			verified: snakeSummary.commercialVerified,
			values: snakeValues,
		},
		{
			verified: camelSummary.commercialVerified,
			values: camelValues,
		},
	];
	const netAfterExpenses = firstVerifiedMetric(
		sources(
			[adminPricing.netAfterExpensesTotal],
			[
				snakeSummary.netAfterExpenses,
				snakeSummary.netAfterOtaExpenses,
			],
			[
				camelSummary.netAfterExpenses,
				camelSummary.netAfterOtaExpenses,
			]
		)
	);
	const otaExpense = firstVerifiedMetric(
		sources(
			[adminPricing.otaExpenseTotal],
			[snakeSummary.otaExpenseTotal],
			[camelSummary.otaExpenseTotal]
		)
	);
	const commission = firstVerifiedMetric(
		sources(
			[adminPricing.commissionAmount],
			[snakeSummary.commissionAmount],
			[camelSummary.commissionAmount]
		)
	);
	const platformMargin = firstVerifiedMetric(
		sources(
			[adminPricing.platformMarginTotal],
			[snakeSummary.platformProfit],
			[camelSummary.platformProfit]
		)
	);
	const profitAvailable = commission.available && platformMargin.available;
	return {
		isHotelRunner: true,
		netAfterExpenses,
		otaExpense,
		commission,
		platformMargin,
		profit: {
			available: profitAvailable,
			amount: profitAvailable
				? commission.amount + platformMargin.amount
				: null,
		},
	};
};

module.exports = {
	buildHotelRunnerReservationExpression,
	buildHotelRunnerProfitAggregationFields,
	buildHotelRunnerSafeCommissionExpression,
	buildHotelRunnerSafeNetExpression,
	buildHotelRunnerUnverifiedExpenseCountExpression,
	buildHotelRunnerUnverifiedNetCountExpression,
	isHotelRunnerReservation,
	verifiedHotelRunnerProfitMetrics,
	verifiedHotelRunnerOtaExpense,
};
