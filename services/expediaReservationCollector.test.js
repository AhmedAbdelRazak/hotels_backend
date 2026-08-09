/** @format */

process.env.SENDGRID_API_KEY = /^SG\./.test(process.env.SENDGRID_API_KEY || "")
	? process.env.SENDGRID_API_KEY
	: "SG.test";

const test = require("node:test");
const assert = require("node:assert/strict");
const { __private } = require("./expediaReservationCollector");

const RELEASE_SHA = "a".repeat(40);
const TREE_SHA = "b".repeat(40);
const CAPTURED_AT = "2026-08-09T06:30:00.000Z";

const releaseAttestationGit = ({ status = "", unavailable = false } = {}) => {
	const calls = [];
	const execFile = (command, args, options) => {
		calls.push({ command, args, options });
		if (unavailable) {
			throw new Error("private/repository/path and credential must not escape");
		}
		const operation = args.join(" ");
		if (operation === "rev-parse --verify HEAD") return RELEASE_SHA.toUpperCase();
		if (operation === "rev-parse --verify HEAD^{tree}") {
			return TREE_SHA.toUpperCase();
		}
		if (operation === "status --porcelain=v1 --untracked-files=no") {
			return status;
		}
		throw new Error("unexpected git operation");
	};
	return { calls, execFile };
};

test("Expedia collector captures an exact clean producer release attestation", () => {
	const git = releaseAttestationGit();
	const attestation = __private.captureProducerReleaseAttestation({
		execFile: git.execFile,
		repoRoot: "private/repository/path",
		now: () => CAPTURED_AT,
	});

	assert.deepEqual(attestation, {
		schemaVersion: 1,
		source: "git",
		releaseSha: RELEASE_SHA,
		treeSha: TREE_SHA,
		trackedWorktreeClean: true,
		evidenceEligible: true,
		status: "verified_clean",
		capturedAt: CAPTURED_AT,
	});
	assert.equal(Object.isFrozen(attestation), true);
	assert.deepEqual(
		git.calls.map((call) => call.args),
		[
			["rev-parse", "--verify", "HEAD"],
			["rev-parse", "--verify", "HEAD^{tree}"],
			["status", "--porcelain=v1", "--untracked-files=no"],
		],
		"untracked files must not affect release eligibility"
	);
	for (const call of git.calls) {
		assert.equal(call.command, "git");
		assert.deepEqual(call.options.stdio, ["ignore", "pipe", "ignore"]);
	}
	assert.doesNotMatch(JSON.stringify(attestation), /private\/repository\/path/);
});

test("Expedia collector freezes producer provenance once for the process lifetime", () => {
	let releaseSha = RELEASE_SHA;
	let treeSha = TREE_SHA;
	let gitCalls = 0;
	const provider =
		__private.createProcessProducerReleaseAttestationProvider({
			execFile: (_command, args) => {
				gitCalls += 1;
				const operation = args.join(" ");
				if (operation === "rev-parse --verify HEAD") return releaseSha;
				if (operation === "rev-parse --verify HEAD^{tree}") return treeSha;
				if (operation === "status --porcelain=v1 --untracked-files=no") {
					return "";
				}
				throw new Error("unexpected git operation");
			},
			now: () => CAPTURED_AT,
		});

	const firstJob = provider();
	releaseSha = "c".repeat(40);
	treeSha = "d".repeat(40);
	const laterJob = provider();

	assert.notEqual(firstJob, laterJob);
	assert.deepEqual(firstJob, laterJob);
	assert.equal(firstJob.releaseSha, RELEASE_SHA);
	assert.equal(firstJob.treeSha, TREE_SHA);
	assert.equal(firstJob.capturedAt, CAPTURED_AT);
	assert.equal(gitCalls, 3, "git must never be re-read for later jobs");
	assert.equal(Object.isFrozen(firstJob), true);
	assert.equal(Object.isFrozen(laterJob), true);
});

test("Expedia collector records tracked dirty state without leaking status paths", () => {
	const git = releaseAttestationGit({
		status: " M private/tracked/file.js credential-sentinel",
	});
	const attestation = __private.captureProducerReleaseAttestation({
		execFile: git.execFile,
		now: () => CAPTURED_AT,
	});

	assert.equal(attestation.releaseSha, RELEASE_SHA);
	assert.equal(attestation.treeSha, TREE_SHA);
	assert.equal(attestation.trackedWorktreeClean, false);
	assert.equal(attestation.evidenceEligible, false);
	assert.equal(attestation.status, "tracked_worktree_dirty");
	assert.doesNotMatch(
		JSON.stringify(attestation),
		/private\/tracked\/file|credential-sentinel/
	);
});

test("Expedia collector marks unavailable git provenance ineligible without faking hashes", () => {
	const git = releaseAttestationGit({ unavailable: true });
	const attestation = __private.captureProducerReleaseAttestation({
		execFile: git.execFile,
		now: () => CAPTURED_AT,
	});

	assert.deepEqual(attestation, {
		schemaVersion: 1,
		source: "git",
		releaseSha: "",
		treeSha: "",
		trackedWorktreeClean: false,
		evidenceEligible: false,
		status: "unavailable",
		capturedAt: CAPTURED_AT,
	});
	assert.doesNotMatch(
		JSON.stringify(attestation),
		/private\/repository\/path|credential/
	);
});

test("queued and finished audit projections preserve one immutable attestation", () => {
	const git = releaseAttestationGit();
	const attestation = __private.captureProducerReleaseAttestation({
		execFile: git.execFile,
		now: () => CAPTURED_AT,
	});
	const queued = __private.withProducerReleaseAttestation(
		{ action: "collector_queued", readOnly: true },
		attestation
	);
	const finished = __private.withProducerReleaseAttestation(
		{ action: "collector_finished", readOnly: true },
		attestation
	);
	const jobCopy = __private.cloneProducerReleaseAttestation(attestation);

	assert.notEqual(
		queued.producerReleaseAttestation,
		finished.producerReleaseAttestation
	);
	assert.deepEqual(queued.producerReleaseAttestation, jobCopy);
	assert.deepEqual(finished.producerReleaseAttestation, jobCopy);
	assert.equal(Object.isFrozen(queued.producerReleaseAttestation), true);
	assert.equal(Object.isFrozen(finished.producerReleaseAttestation), true);
});

test("collector scheduling waits for the queued state and leaves no active start on failure", async () => {
	const events = [];
	let releaseQueuedState;
	const queuedStateGate = new Promise((resolve) => {
		releaseQueuedState = resolve;
	});
	const queued = __private.persistQueuedStateBeforeScheduling({
		persistQueuedState: async () => {
			events.push("queue_write_started");
			await queuedStateGate;
			events.push("queue_write_committed");
			return { status: "queued" };
		},
		activateCollector: () => events.push("collector_activated"),
		scheduleCollector: () => events.push("collector_scheduled"),
		deactivateCollector: () => events.push("collector_deactivated"),
	});

	await Promise.resolve();
	assert.deepEqual(events, ["queue_write_started"]);
	releaseQueuedState();
	assert.deepEqual(await queued, { status: "queued" });
	assert.deepEqual(events, [
		"queue_write_started",
		"queue_write_committed",
		"collector_activated",
		"collector_scheduled",
	]);

	const failedEvents = [];
	await assert.rejects(
		__private.persistQueuedStateBeforeScheduling({
			persistQueuedState: async () => {
				failedEvents.push("queue_write_failed");
				throw new Error("queue write failed");
			},
			activateCollector: () => failedEvents.push("collector_activated"),
			scheduleCollector: () => failedEvents.push("collector_scheduled"),
			deactivateCollector: () => failedEvents.push("collector_deactivated"),
		}),
		/queue write failed/
	);
	assert.deepEqual(failedEvents, ["queue_write_failed"]);

	const missingEvents = [];
	await assert.rejects(
		__private.persistQueuedStateBeforeScheduling({
			persistQueuedState: async () => null,
			activateCollector: () => missingEvents.push("collector_activated"),
			scheduleCollector: () => missingEvents.push("collector_scheduled"),
			deactivateCollector: () => missingEvents.push("collector_deactivated"),
		}),
		/queued state was not persisted/
	);
	assert.deepEqual(missingEvents, []);
});

test("matched payment evidence carries the PMS identity and exact trusted property conversion", async () => {
	const evidence = {
		trusted: true,
		verified: true,
		sourceCurrency: "USD",
		propertyCurrency: "SAR",
		rate: 3.75,
		provenance: {
			provider: "exchange_rate_api",
			sourceType: "trusted_exchange_evidence",
			sourceHash: "c".repeat(64),
			sourceTimestamp: "2026-08-09T00:00:00.000Z",
			sourceId: "exchange-rate-api-usd-sar-" + "c".repeat(24),
		},
		privateCredential: "must-not-copy",
	};
	const candidate = {
		confirmationNumber: "2530158461",
		reservationId: "expedia-provider-id",
		paymentCollectionModel: "expedia_collect",
		currency: "SAR",
		propertyCurrency: "SAR",
		propertyConversionVerified: true,
		sourceCurrency: "USD",
		sourceAmount: 146.46,
		exchangeRateToSar: 3.75,
		exchangeRateSource: "exchange_rate_api",
		amountConvertedAt: "2026-08-09T06:00:00.000Z",
		currencyConversionEvidence: evidence,
		paymentSummary: {
			propertyCurrency: "SAR",
			propertyConversionVerified: true,
			sourceCurrency: "USD",
			sourceTotalGuestPaymentAmount: 146.46,
			sourceTotalPayoutAmount: 112.92,
			sourceTotalPayoutCurrency: "USD",
			totalGuestPaymentAmount: 549.23,
			totalPayoutAmount: 423.45,
		},
	};
	const classification = await __private.classifyCandidate(candidate, {
		findReservation: async () => ({
			_id: "matched-pms-reservation-id",
			confirmation_number: "pms-confirmation",
			reservation_status: "confirmed",
		}),
	});
	const projection = __private.paymentSignalProjection(classification.item);

	assert.equal(classification.bucket, "matchedExisting");
	assert.equal(projection.confirmationNumber, "2530158461");
	assert.equal(projection.reservationId, "matched-pms-reservation-id");
	assert.equal(projection.currency, "SAR");
	assert.equal(projection.propertyCurrency, "SAR");
	assert.equal(projection.propertyConversionVerified, true);
	assert.equal(projection.sourceCurrency, "USD");
	assert.equal(projection.sourceAmount, 146.46);
	assert.equal(projection.exchangeRateToSar, 3.75);
	assert.equal(projection.exchangeRateSource, "exchange_rate_api");
	assert.equal(projection.amountConvertedAt, "2026-08-09T06:00:00.000Z");
	assert.equal(projection.totalGuestPaymentAmount, 549.23);
	assert.equal(projection.sourceTotalGuestPaymentAmount, 146.46);
	assert.equal(projection.totalPayoutAmount, 423.45);
	assert.equal(projection.sourceTotalPayoutAmount, 112.92);
	assert.equal(projection.sourceTotalPayoutCurrency, "USD");
	assert.deepEqual(projection.currencyConversionEvidence, {
		trusted: true,
		verified: true,
		sourceCurrency: "USD",
		propertyCurrency: "SAR",
		rate: 3.75,
		provenance: evidence.provenance,
	});
	assert.doesNotMatch(JSON.stringify(projection), /must-not-copy/);
});

test("Expedia collector reads commercial detail for an existing PMS match", () => {
	assert.equal(
		__private.shouldFetchExpediaReservationDetails({
			bucket: "matchedExisting",
		}),
		true
	);
	assert.equal(
		__private.shouldFetchExpediaReservationDetails({ bucket: "conflicts" }),
		false
	);
});

test("Expedia collector preserves source money and rejects fallback FX as canonical", () => {
	const candidate = __private.normalizeCandidateMoneyToSar({
		sourceCurrency: "USD",
		sourceAmount: 146.46,
		paymentSummary: {
			sourceCurrency: "USD",
			sourceTotalGuestPaymentAmount: 146.46,
			sourceTotalPayoutAmount: 112.92,
		},
	});

	assert.equal(candidate.sourceAmount, 146.46);
	assert.equal(candidate.sourceCurrency, "USD");
	assert.equal(candidate.exchangeRateSource, "missing");
	assert.equal(candidate.propertyConversionVerified, false);
	assert.equal(candidate.totalAmountSar, null);
	assert.equal(candidate.amount, null);
	assert.equal(candidate.currency, "USD");
	assert.equal(candidate.paymentSummary.sourceTotalPayoutAmount, 112.92);
	assert.equal(candidate.paymentSummary.totalGuestPaymentAmount, null);
	assert.equal(candidate.paymentSummary.totalPayoutAmount, null);
});

test("Expedia collector materializes trusted USD commercial roles in SAR and reuses immutable cached provenance", async () => {
	const credential = "test-exchange-rate-api-credential";
	const cache = new Map();
	const fetchedAt = "2026-08-09T06:00:00.000Z";
	const sourceTimestamp = "2026-08-09T00:00:00.000Z";
	let currentTime = Date.parse(fetchedAt);
	let fetchCalls = 0;
	const conversionOptions = {
		apiKey: credential,
		cache,
		now: () => currentTime,
		fetchImpl: async (url) => {
			fetchCalls += 1;
			assert.match(url, /\/pair\/USD\/SAR\/$/);
			return {
				ok: true,
				async json() {
					return {
						result: "success",
						base_code: "USD",
						target_code: "SAR",
						conversion_rate: 3.75,
						time_last_update_unix: Date.parse(sourceTimestamp) / 1000,
					};
				},
			};
		},
	};
	const sourceCandidate = {
		sourceCurrency: "USD",
		sourceAmount: 146.46,
		paymentSummary: {
			sourceCurrency: "USD",
			sourceTotalGuestPaymentAmount: 146.46,
			sourceTotalPayoutAmount: 112.92,
		},
	};

	const converted = await __private.applyTrustedCandidateSarConversion(sourceCandidate, conversionOptions);
	assert.equal(fetchCalls, 1);
	assert.equal(converted.sourceCurrency, "USD");
	assert.equal(converted.sourceAmount, 146.46);
	assert.equal(converted.propertyCurrency, "SAR");
	assert.equal(converted.propertyConversionVerified, true);
	assert.equal(converted.totalAmountSar, 549.23);
	assert.equal(converted.amount, 549.23);
	assert.equal(converted.currency, "SAR");
	assert.equal(converted.totalPayoutSar, 423.45);
	assert.equal(converted.paymentSummary.sourceTotalPayoutAmount, 112.92);
	assert.equal(converted.paymentSummary.totalGuestPaymentAmount, 549.23);
	assert.equal(converted.paymentSummary.totalPayoutAmount, 423.45);
	assert.equal(converted.paymentSummary.currency, "SAR");
	assert.equal(converted.amountConvertedAt, fetchedAt);
	assert.equal(converted.currencyConversionEvidence.rate, 3.75);
	assert.equal(converted.currencyConversionEvidence.provenance.sourceTimestamp, sourceTimestamp);
	assert.equal(converted.currencyConversionEvidence.provenance.sourceType, "trusted_exchange_evidence");
	assert.equal(converted.currencyConversionEvidence.provenance.provider, "exchange_rate_api");
	assert.match(converted.currencyConversionEvidence.provenance.sourceHash, /^[a-f0-9]{64}$/);
	assert.doesNotMatch(JSON.stringify(converted.currencyConversionEvidence), new RegExp(credential));

	let poisonedCacheReads = 0;
	const cachedEntry = cache.get("USD");
	Object.defineProperty(cachedEntry, "injectedCredential", {
		enumerable: true,
		get() {
			poisonedCacheReads += 1;
			return credential;
		},
	});
	Object.defineProperty(
		cachedEntry.currencyConversionEvidence,
		"injectedCredential",
		{
			enumerable: true,
			get() {
				poisonedCacheReads += 1;
				return credential;
			},
		}
	);

	currentTime += 60_000;
	const cached = await __private.applyTrustedCandidateSarConversion(sourceCandidate, conversionOptions);
	assert.equal(fetchCalls, 1, "the second conversion must use the cache");
	assert.equal(
		poisonedCacheReads,
		0,
		"cache hits must emit only the normalized validated evidence fields"
	);
	assert.equal(cached.exchangeRateSource, "exchange_rate_api_cached");
	assert.equal(cached.amountConvertedAt, fetchedAt);
	assert.deepEqual(
		cached.currencyConversionEvidence,
		converted.currencyConversionEvidence,
		"a cache hit must retain the original immutable evidence"
	);
});

test("authenticated Expedia detail gross replaces stale row money before trusted FX", async () => {
	const rowCandidate = __private.normalizeCandidateMoneyToSar({
		confirmationNumber: "2530158461",
		reservationId: "2530158461",
		sourceCurrency: "USD",
		sourceAmount: 112.92,
		amount: 112.92,
		paymentSummary: {
			sourceCurrency: "USD",
			sourceTotalGuestPaymentAmount: 112.92,
		},
	});
	const detail = __private.parseExpediaReservationDetailText(
		[
			"Reservation # 2530158461",
			"Payment details",
			"Total guest payment USD 146.46",
			"Your total payout USD 112.92",
			"Amount to charge Expedia Group USD 112.92",
			"Expedia Collect",
		].join("\n"),
		rowCandidate
	);
	assert.equal(__private.hasTrustedExpediaDetailGross(rowCandidate), false);
	assert.equal(detail.detailCommercialEvidence.guestGrossExplicit, true);
	const merged = __private.mergeDetailCandidate({
		candidate: rowCandidate,
		detail,
	});

	assert.equal(merged.sourceCurrency, "USD");
	assert.equal(merged.sourceAmount, 146.46);
	assert.equal(merged.paymentSummary.sourceTotalGuestPaymentAmount, 146.46);
	assert.equal(merged.paymentSummary.sourceTotalPayoutAmount, 112.92);
	assert.equal(merged.commercialEvidenceConflict, false);
	assert.deepEqual(merged.commercialEvidenceConflicts, []);
	assert.equal(__private.hasTrustedExpediaDetailGross(merged), true);

	const converted = await __private.applyTrustedCandidateSarConversion(merged, {
		apiKey: "test-credential",
		cache: new Map(),
		now: () => Date.parse("2026-08-09T06:00:00.000Z"),
		fetchImpl: async () => ({
			ok: true,
			async json() {
				return {
					result: "success",
					base_code: "USD",
					target_code: "SAR",
					conversion_rate: 3.75,
					time_last_update_unix: Date.parse("2026-08-09T00:00:00.000Z") / 1000,
				};
			},
		}),
	});
	assert.equal(converted.sourceAmount, 146.46);
	assert.equal(converted.paymentSummary.sourceTotalPayoutAmount, 112.92);
	assert.equal(converted.totalAmountSar, 549.23);
	assert.equal(converted.totalPayoutSar, 423.45);
});

test("detail merges retain prior conflicts and fail closed on malformed contracts", () => {
	const retained = __private.mergeDetailCandidate({
		candidate: {
			commercialEvidenceConflict: true,
			commercialEvidenceConflicts: ["prior_detail_conflict"],
		},
		detail: {
			commercialEvidenceConflict: false,
			commercialEvidenceConflicts: [],
		},
	});

	assert.equal(retained.commercialEvidenceConflict, true);
	assert.deepEqual(retained.commercialEvidenceConflicts, [
		"prior_detail_conflict",
	]);

	const unioned = __private.mergeDetailCandidate({
		candidate: retained,
		detail: {
			commercialEvidenceConflict: true,
			commercialEvidenceConflicts: [
				"new_detail_conflict",
				"prior_detail_conflict",
			],
		},
	});

	assert.equal(unioned.commercialEvidenceConflict, true);
	assert.deepEqual(unioned.commercialEvidenceConflicts, [
		"new_detail_conflict",
		"prior_detail_conflict",
	]);

	for (const detail of [
		{},
		{ commercialEvidenceConflict: false },
		{
			commercialEvidenceConflict: false,
			commercialEvidenceConflicts: null,
		},
		{
			commercialEvidenceConflict: false,
			commercialEvidenceConflicts: ["inconsistent_false_with_reason"],
		},
		{
			commercialEvidenceConflict: true,
			commercialEvidenceConflicts: [],
		},
	]) {
		const malformed = __private.mergeDetailCandidate({ detail });
		assert.equal(malformed.commercialEvidenceConflict, true);
		assert.ok(
			malformed.commercialEvidenceConflicts.includes(
				"invalid_commercial_evidence_contract"
			)
		);
	}
	const malformedPrior = __private.mergeDetailCandidate({
		candidate: {
			commercialEvidenceConflict: false,
			commercialEvidenceConflicts: null,
		},
		detail: {
			commercialEvidenceConflict: false,
			commercialEvidenceConflicts: [],
		},
	});
	assert.equal(malformedPrior.commercialEvidenceConflict, true);
	assert.ok(
		malformedPrior.commercialEvidenceConflicts.includes(
			"invalid_commercial_evidence_contract"
		)
	);
});

test("Expedia collector fails closed to USD source evidence on FX outage or pair mismatch", async () => {
	let stalledBodyAbortObserved = 0;
	const sourceCandidate = {
		sourceCurrency: "USD",
		sourceAmount: 146.46,
		paymentSummary: {
			sourceCurrency: "USD",
			sourceTotalGuestPaymentAmount: 146.46,
			sourceTotalPayoutAmount: 112.92,
		},
	};
	const cases = [
		{
			label: "outage",
			fetchImpl: async () => {
				throw new Error("simulated FX outage");
			},
		},
		{
			label: "stalled response body",
			fetchImpl: async (_url, options = {}) => {
				options.signal?.addEventListener("abort", () => {
					stalledBodyAbortObserved += 1;
				});
				return {
					ok: true,
					json: () => new Promise(() => {}),
				};
			},
			after() {
				assert.equal(stalledBodyAbortObserved, 1);
			},
		},
		{
			label: "pair mismatch",
			fetchImpl: async () => ({
				ok: true,
				async json() {
					return {
						result: "success",
						base_code: "EUR",
						target_code: "SAR",
						conversion_rate: 3.75,
						time_last_update_unix: Date.parse("2026-08-09T00:00:00Z") / 1000,
					};
				},
			}),
		},
		{
			label: "stale service timestamp",
			fetchImpl: async () => ({
				ok: true,
				async json() {
					return {
						result: "success",
						base_code: "USD",
						target_code: "SAR",
						conversion_rate: 3.75,
						time_last_update_unix: Date.parse("2026-08-01T00:00:00Z") / 1000,
					};
				},
			}),
		},
		{
			label: "future service timestamp",
			fetchImpl: async () => ({
				ok: true,
				async json() {
					return {
						result: "success",
						base_code: "USD",
						target_code: "SAR",
						conversion_rate: 3.75,
						time_last_update_unix: Date.parse("2026-08-09T06:06:00Z") / 1000,
					};
				},
			}),
		},
		{
			label: "missing service timestamp",
			fetchImpl: async () => ({
				ok: true,
				async json() {
					return {
						result: "success",
						base_code: "USD",
						target_code: "SAR",
						conversion_rate: 3.75,
					};
				},
			}),
		},
		{
			label: "non-finite service timestamp",
			fetchImpl: async () => ({
				ok: true,
				async json() {
					return {
						result: "success",
						base_code: "USD",
						target_code: "SAR",
						conversion_rate: 3.75,
						time_last_update_unix: "not-a-timestamp",
					};
				},
			}),
		},
	];

	for (const fixture of cases) {
		let watchdog;
		let candidate;
		try {
			candidate = await Promise.race([
				__private.applyTrustedCandidateSarConversion(sourceCandidate, {
					apiKey: "test-credential",
					cache: new Map(),
					now: () => Date.parse("2026-08-09T06:00:00.000Z"),
					fetchImpl: fixture.fetchImpl,
					timeoutMs: 50,
				}),
				new Promise((_, reject) => {
					watchdog = setTimeout(
						() => reject(new Error(`FX fail-closed watchdog: ${fixture.label}`)),
						500
					);
				}),
			]);
		} finally {
			clearTimeout(watchdog);
		}
		fixture.after?.();
		assert.equal(candidate.sourceCurrency, "USD", fixture.label);
		assert.equal(candidate.sourceAmount, 146.46, fixture.label);
		assert.equal(candidate.paymentSummary.sourceTotalPayoutAmount, 112.92, fixture.label);
		assert.equal(candidate.propertyConversionVerified, false, fixture.label);
		assert.equal(candidate.totalAmountSar, null, fixture.label);
		assert.equal(candidate.amount, null, fixture.label);
		assert.equal(candidate.currency, "SAR", fixture.label);
		assert.equal(candidate.totalPayoutSar, null, fixture.label);
		assert.equal(candidate.paymentSummary.totalGuestPaymentAmount, null, fixture.label);
		assert.equal(candidate.paymentSummary.totalPayoutAmount, null, fixture.label);
		assert.equal(candidate.currencyConversionEvidence, undefined, fixture.label);
	}
});

test("Expedia collector preserves an absent payout as null instead of zero evidence", () => {
	const candidate = __private.normalizeCandidateMoneyToSar({
		sourceCurrency: "USD",
		sourceAmount: 146.46,
		paymentSummary: {
			sourceCurrency: "USD",
			sourceTotalGuestPaymentAmount: 146.46,
		},
	});

	assert.equal(candidate.paymentSummary.sourceTotalPayoutAmount, null);
	assert.equal(candidate.paymentSummary.totalPayoutAmount, null);
});

test("Expedia collector never assumes SAR when source currency is absent", () => {
	const candidate = __private.normalizeCandidateMoneyToSar({
		sourceAmount: 146.46,
		paymentSummary: { sourceTotalGuestPaymentAmount: 146.46 },
	});

	assert.equal(candidate.sourceCurrency, "");
	assert.equal(candidate.exchangeRateSource, "missing_source_currency");
	assert.equal(candidate.propertyConversionVerified, false);
	assert.equal(candidate.totalAmountSar, null);
	assert.equal(candidate.paymentSummary.totalGuestPaymentAmount, null);
});

test("Expedia collector materializes same-currency SAR amounts", () => {
	const candidate = __private.normalizeCandidateMoneyToSar({
		sourceCurrency: "SAR",
		sourceAmount: 100.01,
		paymentSummary: {
			sourceCurrency: "SAR",
			sourceTotalGuestPaymentAmount: 100.01,
			sourceTotalPayoutAmount: 85.01,
		},
	});

	assert.equal(candidate.propertyConversionVerified, true);
	assert.equal(candidate.totalAmountSar, 100.01);
	assert.equal(candidate.paymentSummary.totalPayoutAmount, 85.01);
});

test("Expedia detail aliases must agree before payout evidence is usable", async () => {
	const detail = __private.parseExpediaReservationDetailText(
		[
			"Reservation # 2530158461",
			"Payment details",
			"Total guest payment USD 146.46",
			"Your total payout USD 112.92",
			"Amount to charge Expedia Group USD 111.92",
			"Expedia Collect",
		].join("\n"),
		{
			confirmationNumber: "2530158461",
			currency: "USD",
			checkinDate: "2026-10-05",
			checkoutDate: "2026-10-11",
		}
	);

	assert.equal(detail.commercialEvidenceConflict, true);
	assert.deepEqual(detail.commercialEvidenceConflicts, [
		"conflicting_payout_aliases",
	]);
	const classification = await __private.classifyCandidate(detail, {
		findReservation: async () => ({
			_id: "reservation-1",
			confirmation_number: "7255791395",
		}),
	});
	assert.equal(classification.bucket, "needsReview");
	assert.equal(
		classification.item.actionPreview,
		"commercial_evidence_conflict_no_write"
	);
});

test("Expedia collector classifies an existing reservation with a provider-scoped lookup", async () => {
	const calls = [];
	const existing = {
		_id: "reservation-2",
		hotelId: "hotel-2",
		confirmation_number: "pms-456",
		otaIdentityKey: "expedia:exp-456",
		reservation_id: "exp-456",
		reservation_status: "confirmed",
		customer_details: {
			confirmation_number2: "exp-456",
		},
		supplierData: {
			otaProvider: "expedia",
			otaConfirmationNumber: "exp-456",
			platformConfirmationNumber: "exp-456",
		},
	};

	const classification = await __private.classifyCandidate(
		{
			confirmationNumber: "EXP-456",
			statusToApply: "cancelled",
			statusRaw: "Cancelled",
		},
		{
			findReservation: async (...args) => {
				calls.push(args);
				return existing;
			},
		}
	);

	assert.equal(calls.length, 1);
	assert.equal(calls[0][0], "exp-456");
	assert.equal(calls[0][1], "expedia");
	assert.match(calls[0][2], /confirmation_number/);
	assert.equal(classification.bucket, "statusChanged");
	assert.equal(classification.item.matchedLookupValue, "exp-456");
	assert.ok(classification.item.matchedReservationBy.includes("otaIdentityKey"));
	assert.ok(
		classification.item.matchedReservationBy.includes(
			"supplierData.otaConfirmationNumber"
		)
	);
});
