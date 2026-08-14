/** @format */

"use strict";

const { performance } = require("perf_hooks");

const DEFAULT_MAX_CANDIDATES = 5000;
const HARD_MAX_CANDIDATES = 5000;
const DEFAULT_MAX_SELECTED = 500;
const HARD_MAX_SELECTED = 500;
const DEFAULT_MAX_BIT_STATES = 500000;
const HARD_MAX_BIT_STATES = 500000;
const DEFAULT_POLISH_POOL_SIZE = 32;
const HARD_MAX_POLISH_POOL_SIZE = 32;
const BITSET_BLOCK_SIZE = 64;
const MAX_TARGET_CENTS = 1000000000000;

class ReconciliationClosestMatchError extends Error {
	constructor(message, code = "invalid_closest_match_request", statusCode = 400) {
		super(message);
		this.name = "ReconciliationClosestMatchError";
		this.code = code;
		this.statusCode = statusCode;
	}
}

const integerOption = (value, fallback, minimum, maximum) => {
	if (value === undefined || value === null || value === "") return fallback;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed)) return fallback;
	return Math.min(Math.max(parsed, minimum), maximum);
};

const dateSortValue = (value) => {
	if (!value) return Number.MAX_SAFE_INTEGER;
	const parsed = new Date(value).getTime();
	return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
};

const compareChronological = (left, right) =>
	left.checkinSort - right.checkinSort ||
	left.checkoutSort - right.checkoutSort ||
	left.id.localeCompare(right.id);

const normalizeCandidates = (candidates, maxCandidates) => {
	if (!Array.isArray(candidates)) {
		throw new ReconciliationClosestMatchError(
			"candidates must be an array",
			"invalid_closest_match_candidates"
		);
	}
	if (candidates.length > maxCandidates) {
		throw new ReconciliationClosestMatchError(
			`At most ${maxCandidates} reconciliation candidates can be matched at once`,
			"closest_match_candidate_limit_exceeded",
			422
		);
	}
	const seenIds = new Set();
	const normalized = candidates.map((candidate, index) => {
		if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
			throw new ReconciliationClosestMatchError(
				`Candidate ${index + 1} must be an object`,
				"invalid_closest_match_candidate"
			);
		}
		const id = String(candidate.id || "").trim();
		if (!id) {
			throw new ReconciliationClosestMatchError(
				`Candidate ${index + 1} requires an id`,
				"invalid_closest_match_candidate_id"
			);
		}
		if (seenIds.has(id)) {
			throw new ReconciliationClosestMatchError(
				`Duplicate reconciliation candidate id: ${id}`,
				"duplicate_closest_match_candidate_id"
			);
		}
		seenIds.add(id);
		const amountCents = candidate.amountCents;
		if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
			throw new ReconciliationClosestMatchError(
				`Candidate ${id} requires a positive integer amountCents`,
				"invalid_closest_match_candidate_amount"
			);
		}
		return {
			id,
			amountCents,
			checkinSort: dateSortValue(candidate.checkinDate),
			checkoutSort: dateSortValue(candidate.checkoutDate),
		};
	});
	return normalized.sort(compareChronological).map((candidate, stableIndex) => ({
		...candidate,
		stableIndex,
	}));
};

const greatestCommonDivisor = (left, right) => {
	let a = Math.abs(left);
	let b = Math.abs(right);
	while (b) {
		const remainder = a % b;
		a = b;
		b = remainder;
	}
	return a || 1;
};

const gcdOfAmounts = (candidates) => {
	let gcd = 0;
	for (const candidate of candidates) {
		gcd = greatestCommonDivisor(gcd, candidate.amountCents);
		if (gcd === 1) break;
	}
	return gcd || 1;
};

const selectedIdsInStableOrder = (candidateIndexes, candidates) =>
	Array.from(candidateIndexes)
		.sort((left, right) => left - right)
		.map((index) => candidates[index].id);

const compareStableSelections = (left = [], right = []) => {
	const length = Math.min(left.length, right.length);
	for (let index = 0; index < length; index += 1) {
		if (left[index] !== right[index]) return left[index] - right[index];
	}
	return left.length - right.length;
};

const betterProposal = (current, candidate, targetCents) => {
	if (!candidate || !candidate.selectedIndexes?.length) return current;
	if (!current || !current.selectedIndexes?.length) return candidate;
	const currentDistance = Math.abs(current.matchedCents - targetCents);
	const candidateDistance = Math.abs(candidate.matchedCents - targetCents);
	if (candidateDistance !== currentDistance) {
		return candidateDistance < currentDistance ? candidate : current;
	}
	const currentUnder = current.matchedCents <= targetCents;
	const candidateUnder = candidate.matchedCents <= targetCents;
	if (currentUnder !== candidateUnder) return candidateUnder ? candidate : current;
	if (candidate.selectedIndexes.length !== current.selectedIndexes.length) {
		return candidate.selectedIndexes.length < current.selectedIndexes.length
			? candidate
			: current;
	}
	return compareStableSelections(
		candidate.selectedIndexes,
		current.selectedIndexes
	) < 0
		? candidate
		: current;
};

const proposalFromIndexes = (indexes, candidates) => {
	const selectedIndexes = Array.from(new Set(indexes)).sort(
		(left, right) => left - right
	);
	let matchedCents = 0;
	for (const index of selectedIndexes) {
		matchedCents += candidates[index].amountCents;
		if (!Number.isSafeInteger(matchedCents)) {
			throw new ReconciliationClosestMatchError(
				"The matched reconciliation amount exceeds the safe integer range",
				"closest_match_amount_out_of_range",
				422
			);
		}
	}
	return {
		selectedIndexes,
		selectedIds: selectedIdsInStableOrder(selectedIndexes, candidates),
		matchedCents,
	};
};

const exactTwoSumProposal = (candidates, targetCents) => {
	const earliestByAmount = new Map();
	let best = null;
	for (const candidate of candidates) {
		const complement = targetCents - candidate.amountCents;
		const earlier = earliestByAmount.get(complement);
		if (earlier) {
			best = betterProposal(
				best,
				proposalFromIndexes(
					[earlier.stableIndex, candidate.stableIndex],
					candidates
				),
				targetCents
			);
		}
		// Candidates are already chronological/id sorted. Retaining the first
		// row for an amount makes equal two-row matches deterministic.
		if (!earliestByAmount.has(candidate.amountCents)) {
			earliestByAmount.set(candidate.amountCents, candidate);
		}
	}
	return best;
};

const bitIsSet = (bits, index) =>
	index >= 0 && ((bits >> BigInt(index)) & 1n) === 1n;

const nearestReachableIndexes = (bits, targetCoordinate, upper, limit = 3) => {
	const indexes = [];
	const floorTarget = Math.min(Math.max(Math.floor(targetCoordinate), 0), upper);
	const ceilingTarget = Math.min(Math.max(Math.ceil(targetCoordinate), 0), upper);
	for (let distance = 0; indexes.length < limit && distance <= upper; distance += 1) {
		const lower = floorTarget - distance;
		if (lower > 0 && bitIsSet(bits, lower) && !indexes.includes(lower)) {
			indexes.push(lower);
		}
		const upperIndex = ceilingTarget + distance;
		if (
			upperIndex > 0 &&
			upperIndex <= upper &&
			bitIsSet(bits, upperIndex) &&
			!indexes.includes(upperIndex)
		) {
			indexes.push(upperIndex);
		}
	}
	return indexes;
};

const weightForMode = (amountCents, unitCents, mode) => {
	const scaled = amountCents / unitCents;
	if (mode === "ceil") return Math.max(1, Math.ceil(scaled));
	if (mode === "round") return Math.max(1, Math.round(scaled));
	return Math.max(1, Math.floor(scaled));
};

const reconstructBitsetSelection = ({
	work,
	weights,
	checkpoints,
	targetIndex,
	upper,
	mask,
}) => {
	let remaining = targetIndex;
	const selected = [];
	const blockCount = Math.ceil(work.length / BITSET_BLOCK_SIZE);
	for (let block = blockCount - 1; block >= 0; block -= 1) {
		const start = block * BITSET_BLOCK_SIZE;
		const end = Math.min(work.length, start + BITSET_BLOCK_SIZE);
		let bits = checkpoints[block];
		const before = [];
		for (let index = start; index < end; index += 1) {
			before.push(bits);
			const weight = weights[index];
			if (weight <= upper) {
				bits = (bits | (bits << BigInt(weight))) & mask;
			}
		}
		for (let index = end - 1; index >= start; index -= 1) {
			const previousBits = before[index - start];
			const weight = weights[index];
			// Skipping a later chronological row whenever possible gives a stable,
			// deterministic preference to earlier rows and ids.
			if (bitIsSet(previousBits, remaining)) continue;
			if (
				weight <= remaining &&
				bitIsSet(previousBits, remaining - weight)
			) {
				selected.push(work[index].stableIndex);
				remaining -= weight;
				continue;
			}
			throw new ReconciliationClosestMatchError(
				"Could not reconstruct the bounded closest-match proposal",
				"closest_match_reconstruction_failed",
				500
			);
		}
	}
	if (remaining !== 0) {
		throw new ReconciliationClosestMatchError(
			"Closest-match reconstruction did not reach its origin",
			"closest_match_reconstruction_failed",
			500
		);
	}
	return selected;
};

const bitsetSeedProposals = ({
	candidates,
	work,
	targetCents,
	unitCents,
	upper,
	modes,
	maxSelected,
}) => {
	const proposals = [];
	let selectionLimitExceeded = false;
	const mask = (1n << BigInt(upper + 1)) - 1n;
	for (const mode of modes) {
		const weights = work.map((candidate) =>
			weightForMode(candidate.amountCents, unitCents, mode)
		);
		let bits = 1n;
		const checkpoints = [bits];
		for (let index = 0; index < work.length; index += 1) {
			const weight = weights[index];
			if (weight <= upper) {
				bits = (bits | (bits << BigInt(weight))) & mask;
			}
			if (
				(index + 1) % BITSET_BLOCK_SIZE === 0 ||
				index === work.length - 1
			) {
				checkpoints.push(bits);
			}
		}
		const targetCoordinate = targetCents / unitCents;
		for (const targetIndex of nearestReachableIndexes(
			bits,
			targetCoordinate,
			upper,
			3
		)) {
			const indexes = reconstructBitsetSelection({
				work,
				weights,
				checkpoints,
				targetIndex,
				upper,
				mask,
			});
			if (indexes.length > maxSelected) {
				selectionLimitExceeded = true;
				continue;
			}
			proposals.push(proposalFromIndexes(indexes, candidates));
		}
	}
	return { proposals, selectionLimitExceeded };
};

const uniqueCandidates = (candidateGroups, limit) => {
	const selected = [];
	const seen = new Set();
	for (const group of candidateGroups) {
		for (const candidate of group) {
			if (seen.has(candidate.stableIndex)) continue;
			seen.add(candidate.stableIndex);
			selected.push(candidate);
			if (selected.length >= limit) return selected;
		}
	}
	return selected;
};

const fallbackCandidatePools = (work, targetCents, maxSelected) => {
	if (work.length <= maxSelected) return [];
	const chronological = [...work];
	const byLargest = [...work].sort(
		(left, right) =>
			right.amountCents - left.amountCents ||
			compareChronological(left, right)
	);
	const bySmallest = [...work].sort(
		(left, right) =>
			left.amountCents - right.amountCents ||
			compareChronological(left, right)
	);
	const expectedAmount = targetCents / maxSelected;
	const byExpectedAmount = [...work].sort(
		(left, right) =>
			Math.abs(left.amountCents - expectedAmount) -
				Math.abs(right.amountCents - expectedAmount) ||
			compareChronological(left, right)
	);
	const half = Math.floor(maxSelected / 2);
	return [
		byLargest.slice(0, maxSelected),
		chronological.slice(0, maxSelected),
		byExpectedAmount.slice(0, maxSelected),
		uniqueCandidates(
			[byLargest.slice(0, half), bySmallest, chronological],
			maxSelected
		),
	];
};

const enumerateHalf = (candidates) => {
	const totalMasks = 1 << candidates.length;
	const entries = new Array(totalMasks);
	entries[0] = { sum: 0, count: 0, mask: 0 };
	for (let mask = 1; mask < totalMasks; mask += 1) {
		const leastBit = mask & -mask;
		const bitIndex = 31 - Math.clz32(leastBit);
		const previous = entries[mask ^ leastBit];
		entries[mask] = {
			sum: previous.sum + candidates[bitIndex].amountCents,
			count: previous.count + 1,
			mask,
		};
	}
	return entries;
};

const compareMasksChronologically = (leftMask, rightMask, candidateCount) => {
	if (leftMask === rightMask) return 0;
	const leftIndexes = [];
	const rightIndexes = [];
	for (let index = 0; index < candidateCount; index += 1) {
		if (leftMask & (1 << index)) leftIndexes.push(index);
		if (rightMask & (1 << index)) rightIndexes.push(index);
	}
	return compareStableSelections(leftIndexes, rightIndexes);
};

const polishProposal = ({
	proposal,
	candidates,
	targetCents,
	poolSize,
	maxSelected,
}) => {
	if (!proposal?.selectedIndexes?.length || proposal.matchedCents === targetCents) {
		return proposal;
	}
	const selectedSet = new Set(proposal.selectedIndexes);
	const selected = candidates.filter((candidate) =>
		selectedSet.has(candidate.stableIndex)
	);
	const unselected = candidates.filter(
		(candidate) => !selectedSet.has(candidate.stableIndex)
	);
	const delta = Math.abs(targetCents - proposal.matchedCents);
	const byAscending = (items) =>
		[...items].sort(
			(left, right) =>
				left.amountCents - right.amountCents ||
				compareChronological(left, right)
		);
	const byDescending = (items) =>
		[...items].sort(
			(left, right) =>
				right.amountCents - left.amountCents ||
				compareChronological(left, right)
		);
	const byDelta = (items) =>
		[...items].sort(
			(left, right) =>
				Math.abs(left.amountCents - delta) -
					Math.abs(right.amountCents - delta) ||
				compareChronological(left, right)
		);
	const selectedLimit = Math.min(Math.floor(poolSize / 2), selected.length);
	const unselectedLimit = Math.min(poolSize - selectedLimit, unselected.length);
	const removable = uniqueCandidates(
		[
			byAscending(selected).slice(0, Math.ceil(selectedLimit / 2)),
			byDescending(selected).slice(0, Math.ceil(selectedLimit / 4)),
			byDelta(selected),
		],
		selectedLimit
	);
	const addable = uniqueCandidates(
		[
			byAscending(unselected).slice(0, Math.ceil(unselectedLimit / 2)),
			byDelta(unselected),
			byDescending(unselected),
		],
		unselectedLimit
	);
	const pool = [...removable, ...addable];
	if (!pool.length || pool.length > HARD_MAX_POLISH_POOL_SIZE) return proposal;
	const removableSet = new Set(
		removable.map((candidate) => candidate.stableIndex)
	);
	const frozen = selected.filter(
		(candidate) => !removableSet.has(candidate.stableIndex)
	);
	const baseCents = frozen.reduce(
		(total, candidate) => total + candidate.amountCents,
		0
	);
	const midpoint = Math.floor(pool.length / 2);
	const left = pool.slice(0, midpoint);
	const right = pool.slice(midpoint);
	const leftEntries = enumerateHalf(left);
	const rightEntries = enumerateHalf(right).sort(
		(a, b) =>
			a.sum - b.sum ||
			a.count - b.count ||
			compareMasksChronologically(a.mask, b.mask, right.length)
	);
	const distinctRight = [];
	for (const entry of rightEntries) {
		const previous = distinctRight[distinctRight.length - 1];
		if (!previous || previous.sum !== entry.sum) distinctRight.push(entry);
	}
	let best = proposal;
	for (const leftEntry of leftEntries) {
		const desiredRight = targetCents - baseCents - leftEntry.sum;
		let low = 0;
		let high = distinctRight.length;
		while (low < high) {
			const middle = (low + high) >> 1;
			if (distinctRight[middle].sum < desiredRight) low = middle + 1;
			else high = middle;
		}
		for (const rightIndex of [low - 1, low]) {
			if (rightIndex < 0 || rightIndex >= distinctRight.length) continue;
			const rightEntry = distinctRight[rightIndex];
			const selectedCount =
				frozen.length + leftEntry.count + rightEntry.count;
			if (selectedCount <= 0 || selectedCount > maxSelected) continue;
			const indexes = frozen.map((candidate) => candidate.stableIndex);
			for (let bitIndex = 0; bitIndex < left.length; bitIndex += 1) {
				if (leftEntry.mask & (1 << bitIndex)) {
					indexes.push(left[bitIndex].stableIndex);
				}
			}
			for (let bitIndex = 0; bitIndex < right.length; bitIndex += 1) {
				if (rightEntry.mask & (1 << bitIndex)) {
					indexes.push(right[bitIndex].stableIndex);
				}
			}
			best = betterProposal(
				best,
				proposalFromIndexes(indexes, candidates),
				targetCents
			);
		}
	}
	return best;
};

const resultFromProposal = ({
	proposal,
	targetCents,
	candidateCount,
	optimalityGuaranteed,
	resolutionCents,
	elapsedMs,
	selectionLimitExceeded,
}) => {
	const differenceCents = proposal.matchedCents - targetCents;
	return {
		selectedIds: proposal.selectedIds,
		matchedCents: proposal.matchedCents,
		differenceCents,
		direction:
			differenceCents === 0
				? "exact"
				: differenceCents < 0
				? "under"
				: "over",
		exactMatch: differenceCents === 0,
		// This guarantee concerns the closest amount only. Fewer rows and
		// chronology/id are deterministic tie-breakers, but the bounded DP does
		// not claim a global minimum-cardinality proof for every equal sum.
		optimalityGuaranteed:
			Boolean(optimalityGuaranteed) || differenceCents === 0,
		resolutionCents,
		candidateCount,
		selectedCount: proposal.selectedIndexes.length,
		elapsedMs,
		timedOut: false,
		selectionLimitExceeded: Boolean(selectionLimitExceeded),
	};
};

const findClosestReconciliationMatch = (
	candidates,
	targetCents,
	options = {}
) => {
	const startedAt = performance.now();
	if (
		!Number.isSafeInteger(targetCents) ||
		targetCents <= 0 ||
		targetCents > MAX_TARGET_CENTS
	) {
		throw new ReconciliationClosestMatchError(
			`targetCents must be a positive safe integer no greater than ${MAX_TARGET_CENTS}`,
			"invalid_closest_match_target"
		);
	}
	const maxCandidates = integerOption(
		options.maxCandidates,
		DEFAULT_MAX_CANDIDATES,
		1,
		HARD_MAX_CANDIDATES
	);
	const maxSelected = integerOption(
		options.maxSelectedCount ?? options.maxSelected,
		DEFAULT_MAX_SELECTED,
		1,
		HARD_MAX_SELECTED
	);
	const maxBitStates = integerOption(
		options.maxBitStates,
		DEFAULT_MAX_BIT_STATES,
		100,
		HARD_MAX_BIT_STATES
	);
	const poolSize = integerOption(
		options.polishPoolSize,
		DEFAULT_POLISH_POOL_SIZE,
		0,
		HARD_MAX_POLISH_POOL_SIZE
	);
	const normalized = normalizeCandidates(candidates, maxCandidates);
	if (!normalized.length) {
		throw new ReconciliationClosestMatchError(
			"No waiting reconciliation candidates are available in this range",
			"closest_match_candidates_empty",
			422
		);
	}

	let best = null;
	for (const candidate of normalized) {
		best = betterProposal(
			best,
			proposalFromIndexes([candidate.stableIndex], normalized),
			targetCents
		);
	}
	if (best.matchedCents === targetCents) {
		return resultFromProposal({
			proposal: best,
			targetCents,
			candidateCount: normalized.length,
			optimalityGuaranteed: true,
			resolutionCents: 1,
			elapsedMs: Number((performance.now() - startedAt).toFixed(3)),
			selectionLimitExceeded: false,
		});
	}
	const exactPair = exactTwoSumProposal(normalized, targetCents);
	best = betterProposal(best, exactPair, targetCents);
	if (best.matchedCents === targetCents) {
		return resultFromProposal({
			proposal: best,
			targetCents,
			candidateCount: normalized.length,
			optimalityGuaranteed: true,
			resolutionCents: 1,
			elapsedMs: Number((performance.now() - startedAt).toFixed(3)),
			selectionLimitExceeded: false,
		});
	}

	const upperAmountCents = targetCents * 2;
	const work = normalized.filter(
		(candidate) => candidate.amountCents <= upperAmountCents
	);
	let exactSearch = false;
	let resolutionCents = 1;
	let selectionLimitExceeded = false;
	if (work.length) {
		const amountGcd = gcdOfAmounts(work);
		const compressedUpper = Math.floor(upperAmountCents / amountGcd);
		const scale = Math.max(1, Math.ceil(compressedUpper / maxBitStates));
		resolutionCents = amountGcd * scale;
		exactSearch = scale === 1;
		const upper = Math.max(
			1,
			Math.min(
				maxBitStates,
				Math.floor(upperAmountCents / resolutionCents)
			)
		);
		const modes = exactSearch ? ["floor"] : ["floor", "round", "ceil"];
		const primary = bitsetSeedProposals({
			candidates: normalized,
			work,
			targetCents,
			unitCents: resolutionCents,
			upper,
			modes,
			maxSelected,
		});
		selectionLimitExceeded = primary.selectionLimitExceeded;
		for (const proposal of primary.proposals) {
			best = betterProposal(best, proposal, targetCents);
		}

		if (selectionLimitExceeded || best.selectedIndexes.length > maxSelected) {
			for (const pool of fallbackCandidatePools(
				work,
				targetCents,
				maxSelected
			)) {
				const fallback = bitsetSeedProposals({
					candidates: normalized,
					work: pool,
					targetCents,
					unitCents: resolutionCents,
					upper,
					modes,
					maxSelected,
				});
				for (const proposal of fallback.proposals) {
					best = betterProposal(best, proposal, targetCents);
				}
			}
		}
	}

	if (best.selectedIndexes.length > maxSelected) {
		throw new ReconciliationClosestMatchError(
			`The closest proposal exceeds the ${maxSelected}-reservation update limit`,
			"closest_match_selection_limit_exceeded",
			422
		);
	}
	best = polishProposal({
		proposal: best,
		candidates: normalized,
		targetCents,
		poolSize,
		maxSelected,
	});
	if (
		best.matchedCents === targetCents &&
		best.selectedIndexes.length <= maxSelected
	) {
		selectionLimitExceeded = false;
	}
	return resultFromProposal({
		proposal: best,
		targetCents,
		candidateCount: normalized.length,
		optimalityGuaranteed: exactSearch && !selectionLimitExceeded,
		resolutionCents,
		elapsedMs: Number((performance.now() - startedAt).toFixed(3)),
		selectionLimitExceeded,
	});
};

module.exports = {
	DEFAULT_MAX_BIT_STATES,
	DEFAULT_MAX_CANDIDATES,
	DEFAULT_MAX_SELECTED,
	HARD_MAX_BIT_STATES,
	HARD_MAX_CANDIDATES,
	HARD_MAX_SELECTED,
	MAX_TARGET_CENTS,
	ReconciliationClosestMatchError,
	findClosestReconciliationMatch,
};
