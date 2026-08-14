/** @format */

"use strict";

const {
	PAYMENT_BREAKDOWN_KEYS,
} = require("./paymentReconciliation");

const PAYMENT_BREAKDOWN_ROOT = "paid_amount_breakdown";
const RECONCILIATION_BREAKDOWN_ROOT = "payment_reconciliation.breakdown";
const PAYMENT_KEY_SET = new Set(PAYMENT_BREAKDOWN_KEYS);

const isPlainObject = (value) =>
	Boolean(value && typeof value === "object" && !Array.isArray(value));

const paymentKeyForPath = (value) => {
	const path = String(value || "");
	if (!path.startsWith(`${PAYMENT_BREAKDOWN_ROOT}.`)) return "";
	const key = path.slice(PAYMENT_BREAKDOWN_ROOT.length + 1).split(".")[0];
	return PAYMENT_KEY_SET.has(key) ? key : "";
};

const addMutationPath = (plan, value) => {
	const path = String(value || "");
	if (path === PAYMENT_BREAKDOWN_ROOT) {
		plan.invalidateAll = true;
		return;
	}
	const key = paymentKeyForPath(path);
	if (key) plan.keys.add(key);
};

const inspectOperator = (plan, operator, operand) => {
	if (!isPlainObject(operand)) return;
	for (const [path, value] of Object.entries(operand)) {
		addMutationPath(plan, path);
		if (operator === "$rename" && typeof value === "string") {
			addMutationPath(plan, value);
		}
	}
};

const inspectPipelineStage = (plan, stage) => {
	if (!isPlainObject(stage)) return;
	for (const [operator, operand] of Object.entries(stage)) {
		if (operator === "$replaceRoot" || operator === "$replaceWith") {
			plan.invalidateAll = true;
			continue;
		}
		// An inclusion $project can remove paid_amount_breakdown without naming
		// it, so every pipeline projection is conservatively a root replacement.
		if (operator === "$project") {
			plan.invalidateAll = true;
			continue;
		}
		if (operator === "$unset") {
			const paths = Array.isArray(operand) ? operand : [operand];
			for (const path of paths) addMutationPath(plan, path);
			continue;
		}
		if (
			operator === "$set" ||
			operator === "$addFields"
		) {
			inspectOperator(plan, operator, operand);
		}
	}
};

/**
 * Describe which stored reconciliation snapshots an update can make stale.
 * Reading paid fields in an expression is intentionally ignored; only output
 * paths are considered. $setOnInsert is ignored because it cannot change an
 * existing reservation.
 */
const planPaymentReconciliationInvalidation = (update) => {
	const mutablePlan = { invalidateAll: false, keys: new Set() };
	if (Array.isArray(update)) {
		for (const stage of update) inspectPipelineStage(mutablePlan, stage);
	} else if (isPlainObject(update)) {
		for (const [operatorOrPath, operand] of Object.entries(update)) {
			if (operatorOrPath === "$setOnInsert") continue;
			if (operatorOrPath.startsWith("$")) {
				inspectOperator(mutablePlan, operatorOrPath, operand);
			} else {
				addMutationPath(mutablePlan, operatorOrPath);
			}
		}
	}
	return {
		invalidateAll: mutablePlan.invalidateAll,
		keys: mutablePlan.invalidateAll
			? Array.from(PAYMENT_BREAKDOWN_KEYS)
			: PAYMENT_BREAKDOWN_KEYS.filter((key) => mutablePlan.keys.has(key)),
	};
};

const planPaymentReconciliationInvalidationForModifiedPaths = (paths) => {
	const mutablePlan = { invalidateAll: false, keys: new Set() };
	for (const path of Array.isArray(paths) ? paths : []) {
		addMutationPath(mutablePlan, path);
	}
	return {
		invalidateAll: mutablePlan.invalidateAll,
		keys: mutablePlan.invalidateAll
			? Array.from(PAYMENT_BREAKDOWN_KEYS)
			: PAYMENT_BREAKDOWN_KEYS.filter((key) => mutablePlan.keys.has(key)),
	};
};

const pathConflictsWith = (path, target) =>
	path === target ||
	path.startsWith(`${target}.`) ||
	target.startsWith(`${path}.`);

const normalizeClassicUpdate = (update) => {
	const normalized = {};
	const implicitSet = {};
	for (const [path, value] of Object.entries(isPlainObject(update) ? update : {})) {
		if (path.startsWith("$")) {
			normalized[path] = isPlainObject(value) ? { ...value } : value;
		} else {
			implicitSet[path] = value;
		}
	}
	if (Object.keys(implicitSet).length) {
		normalized.$set = {
			...(isPlainObject(normalized.$set) ? normalized.$set : {}),
			...implicitSet,
		};
	}
	return normalized;
};

const removeConflictingReconciliationMutations = (update, targets) => {
	for (const [operator, operand] of Object.entries(update)) {
		if (!operator.startsWith("$") || !isPlainObject(operand)) continue;
		const nextOperand = { ...operand };
		for (const path of Object.keys(nextOperand)) {
			const destination =
				operator === "$rename" && typeof nextOperand[path] === "string"
					? nextOperand[path]
					: "";
			if (
				targets.some(
					(target) =>
						pathConflictsWith(path, target) ||
						(destination && pathConflictsWith(destination, target))
				)
			) {
				delete nextOperand[path];
			}
		}
		if (Object.keys(nextOperand).length) update[operator] = nextOperand;
		else delete update[operator];
	}
};

const withClassicInvalidation = (update, plan) => {
	const next = normalizeClassicUpdate(update);
	const targets = plan.invalidateAll
		? [RECONCILIATION_BREAKDOWN_ROOT]
		: plan.keys.map(
				(key) => `${RECONCILIATION_BREAKDOWN_ROOT}.${key}`
		  );
	removeConflictingReconciliationMutations(next, targets);

	if (plan.invalidateAll) {
		next.$set = {
			...(isPlainObject(next.$set) ? next.$set : {}),
			[RECONCILIATION_BREAKDOWN_ROOT]: {},
		};
	} else if (plan.keys.length) {
		next.$unset = {
			...(isPlainObject(next.$unset) ? next.$unset : {}),
			...Object.fromEntries(
				plan.keys.map((key) => [
					`${RECONCILIATION_BREAKDOWN_ROOT}.${key}`,
					1,
				])
			),
		};
	}
	return next;
};

const withReplacementInvalidation = (replacement, plan) => {
	if (!isPlainObject(replacement) || (!plan.invalidateAll && !plan.keys.length)) {
		return replacement;
	}
	return {
		...replacement,
		payment_reconciliation: {
			breakdown: {},
			lastUpdatedAt: null,
			lastUpdatedBy: null,
			lastBatchId: "",
		},
	};
};

/**
 * Return an update with atomic reconciliation invalidation appended. The
 * caller's audit-log operators and unrelated reconciliation categories remain
 * untouched.
 */
const withPaymentReconciliationInvalidation = (
	update,
	{ replacement = false } = {}
) => {
	const plan = replacement
		? {
				invalidateAll: true,
				keys: Array.from(PAYMENT_BREAKDOWN_KEYS),
			  }
		: planPaymentReconciliationInvalidation(update);
	if (!plan.invalidateAll && !plan.keys.length) return update;
	if (replacement) return withReplacementInvalidation(update, plan);
	if (Array.isArray(update)) {
		return [
			...update,
			plan.invalidateAll
				? { $set: { [RECONCILIATION_BREAKDOWN_ROOT]: {} } }
				: {
						$unset: plan.keys.map(
							(key) => `${RECONCILIATION_BREAKDOWN_ROOT}.${key}`
						),
				  },
		];
	}
	return withClassicInvalidation(update, plan);
};

module.exports = {
	PAYMENT_BREAKDOWN_ROOT,
	RECONCILIATION_BREAKDOWN_ROOT,
	paymentKeyForPath,
	planPaymentReconciliationInvalidation,
	planPaymentReconciliationInvalidationForModifiedPaths,
	withPaymentReconciliationInvalidation,
};
