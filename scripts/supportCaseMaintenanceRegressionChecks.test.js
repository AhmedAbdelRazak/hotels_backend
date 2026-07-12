const assert = require("node:assert/strict");
const test = require("node:test");

process.env.AI_TURN_STALL_RECOVERY_ENABLED = "true";
process.env.AI_TURN_RECOVERY_MAX_ATTEMPTS_PER_GUEST = "2";

const SupportCase = require("../models/supportcase");
const {
	closeIdleAiSupportCases,
	recoverUnansweredAiSupportCases,
	__test: maintenance,
} = require("../services/supportCaseMaintenance");

const supportEmail = "support@jannatbooking.com";

const queryResult = (value) => ({
	sort() {
		return this;
	},
	limit() {
		return this;
	},
	lean() {
		return this;
	},
	async exec() {
		return value;
	},
});

const systemOnlyCase = ({
	id = "restart-intro-case",
	createdAt = new Date("2026-07-12T16:00:03.413Z"),
} = {}) => ({
	_id: id,
	caseStatus: "open",
	openedBy: "client",
	aiToRespond: true,
	aiRelated: true,
	aiResponderName: "Iman",
	createdAt,
	updatedAt: createdAt,
	conversation: [
		{
			isSystem: true,
			message: "A representative will be with you shortly.",
			date: createdAt,
			messageBy: { customerEmail: supportEmail },
		},
	],
});

const ioStub = () => ({
	emit() {},
	to() {
		return { emit() {} };
	},
});

test("restart recovery atomically claims and schedules a missing initial introduction", async (t) => {
	const originalFind = SupportCase.find;
	const originalUpdateOne = SupportCase.updateOne;
	const originalFindOneAndUpdate = SupportCase.findOneAndUpdate;
	t.after(() => {
		SupportCase.find = originalFind;
		SupportCase.updateOne = originalUpdateOne;
		SupportCase.findOneAndUpdate = originalFindOneAndUpdate;
	});

	const supportCase = systemOnlyCase();
	const now = new Date("2026-07-12T16:01:00.000Z");
	let claim = null;
	const scheduled = [];
	SupportCase.find = () => queryResult([supportCase]);
	SupportCase.updateOne = (filter, update) => {
		claim = { filter, update };
		return queryResult({ modifiedCount: 1 });
	};

	const recovered = await recoverUnansweredAiSupportCases({
		now,
		staleMs: 15 * 1000,
		io: ioStub(),
		onlyUnclaimed: true,
		scheduleAiTurn(_io, caseId, options) {
			scheduled.push({ caseId: String(caseId), options });
			return true;
		},
	});

	assert.equal(recovered.scheduled, 1);
	assert.deepEqual(scheduled, [
		{ caseId: "restart-intro-case", options: { delayMs: 150 } },
	]);
	assert.equal(
		claim.update.$set.aiRecoveryGuestKey,
		`intro:${supportCase.createdAt.getTime()}`
	);
	assert.equal(claim.update.$set.aiRecoveryAttemptCount, 1);
	assert.equal(claim.update.$set.aiRecoveryLastGuestAt, null);
	assert.equal(claim.update.$set.aiRecoveryLastGuestText, "");
	assert.deepEqual(claim.filter.$or, [
		{ aiRecoveryScheduledAt: { $exists: false } },
		{ aiRecoveryScheduledAt: null },
	]);

	let closeMutationAttempted = false;
	SupportCase.find = () => queryResult([supportCase]);
	SupportCase.findOneAndUpdate = () => {
		closeMutationAttempted = true;
		return queryResult(null);
	};
	const idleResult = await closeIdleAiSupportCases({
		now: new Date("2026-07-12T16:06:00.000Z"),
		idleMs: 5 * 60 * 1000,
		io: ioStub(),
	});
	assert.equal(idleResult.closed, 0);
	assert.equal(closeMutationAttempted, false);
});

test("already-claimed startup turns are not charged a duplicate recovery attempt", async (t) => {
	const originalFind = SupportCase.find;
	const originalUpdateOne = SupportCase.updateOne;
	t.after(() => {
		SupportCase.find = originalFind;
		SupportCase.updateOne = originalUpdateOne;
	});

	const supportCase = {
		...systemOnlyCase({ id: "claimed-intro-case" }),
		aiRecoveryScheduledAt: new Date("2026-07-12T16:00:45.000Z"),
		aiRecoveryGuestKey: "intro:1783872003413",
		aiRecoveryAttemptCount: 1,
	};
	let updateAttempted = false;
	SupportCase.find = () => queryResult([supportCase]);
	SupportCase.updateOne = () => {
		updateAttempted = true;
		return queryResult({ modifiedCount: 1 });
	};
	let scheduleCount = 0;
	const recovered = await recoverUnansweredAiSupportCases({
		now: new Date("2026-07-12T16:01:00.000Z"),
		staleMs: 15 * 1000,
		io: ioStub(),
		onlyUnclaimed: true,
		claimBefore: new Date("2026-07-12T16:00:40.000Z"),
		scheduleAiTurn() {
			scheduleCount += 1;
			return true;
		},
	});
	assert.equal(recovered.scheduled, 0);
	assert.equal(scheduleCount, 0);
	assert.equal(updateAttempted, false);

	const oldProcessClaim = {
		...supportCase,
		_id: "old-process-claimed-intro-case",
		aiRecoveryScheduledAt: new Date("2026-07-12T16:00:30.000Z"),
	};
	let oldClaimFilter = null;
	SupportCase.find = () => queryResult([oldProcessClaim]);
	SupportCase.updateOne = (filter) => {
		oldClaimFilter = filter;
		return queryResult({ modifiedCount: 1 });
	};
	const recoveredOldClaim = await recoverUnansweredAiSupportCases({
		now: new Date("2026-07-12T16:01:00.000Z"),
		staleMs: 15 * 1000,
		io: ioStub(),
		onlyUnclaimed: true,
		claimBefore: new Date("2026-07-12T16:00:40.000Z"),
		scheduleAiTurn() {
			return true;
		},
	});
	assert.equal(recoveredOldClaim.scheduled, 1);
	assert.deepEqual(oldClaimFilter.$or[2], {
		aiRecoveryScheduledAt: { $lt: new Date("2026-07-12T16:00:40.000Z") },
	});
});

test("answered introductions still close normally and guest recovery caps remain unchanged", async (t) => {
	const originalFind = SupportCase.find;
	const originalUpdateOne = SupportCase.updateOne;
	const originalFindOneAndUpdate = SupportCase.findOneAndUpdate;
	t.after(() => {
		SupportCase.find = originalFind;
		SupportCase.updateOne = originalUpdateOne;
		SupportCase.findOneAndUpdate = originalFindOneAndUpdate;
	});

	const answered = systemOnlyCase({ id: "answered-intro-case" });
	answered.conversation.push({
		isAi: true,
		isSystem: false,
		message: "This is Iman from reservations. How may I help?",
		date: new Date("2026-07-12T16:00:20.000Z"),
		messageBy: { customerEmail: supportEmail },
	});
	answered.updatedAt = answered.conversation[1].date;
	SupportCase.find = () => queryResult([answered]);
	SupportCase.findOneAndUpdate = () =>
		queryResult({ ...answered, caseStatus: "closed" });
	const idleResult = await closeIdleAiSupportCases({
		now: new Date("2026-07-12T16:06:00.000Z"),
		idleMs: 5 * 60 * 1000,
		io: ioStub(),
	});
	assert.equal(idleResult.closed, 1);

	const guestAt = new Date("2026-07-12T16:00:30.000Z");
	const capped = systemOnlyCase({ id: "capped-guest-case" });
	capped.conversation.push({
		message: "I need a room",
		date: guestAt,
		messageBy: { customerEmail: "guest@example.com" },
	});
	capped.updatedAt = guestAt;
	const pending = maintenance.pendingAiTurnForRecovery(capped);
	capped.aiRecoveryScheduledAt = new Date("2026-07-12T16:00:40.000Z");
	capped.aiRecoveryGuestKey = pending.recoveryKey;
	capped.aiRecoveryAttemptCount = 2;
	let capUpdate = null;
	SupportCase.find = () => queryResult([capped]);
	SupportCase.updateOne = (filter, update) => {
		capUpdate = { filter, update };
		return queryResult({ modifiedCount: 1 });
	};
	let scheduleCount = 0;
	const recoveryResult = await recoverUnansweredAiSupportCases({
		now: new Date("2026-07-12T16:01:00.000Z"),
		staleMs: 15 * 1000,
		io: ioStub(),
		scheduleAiTurn() {
			scheduleCount += 1;
			return true;
		},
	});
	assert.equal(recoveryResult.capped, 1);
	assert.equal(scheduleCount, 0);
	assert.equal(capUpdate.update.$set.aiRecoveryCapGuestKey, pending.recoveryKey);
});
