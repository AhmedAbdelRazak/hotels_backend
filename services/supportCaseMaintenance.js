/** @format */

const SupportCase = require("../models/supportcase");

const ONE_HOUR = 60 * 60 * 1000;
const ONE_MINUTE = 60 * 1000;

const AI_SUPPORT_EMAILS = new Set([
	"support@jannatbooking.com",
	"management@xhotelpro.com",
]);

const intFromEnv = (name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
	const parsed = parseInt(process.env[name] || "", 10);
	const value = Number.isFinite(parsed) ? parsed : fallback;
	return Math.min(max, Math.max(min, value));
};

const AI_IDLE_CLOSE_MS = intFromEnv("AI_IDLE_CLOSE_MS", 5 * ONE_MINUTE, {
	min: 5 * ONE_MINUTE,
	max: ONE_HOUR,
});

const AI_TURN_STALL_RECOVERY_MS = intFromEnv(
	"AI_TURN_STALL_RECOVERY_MS",
	25 * 1000,
	{ min: 10 * 1000, max: 2 * ONE_MINUTE }
);

const asTime = (value) => {
	const date = value ? new Date(value) : null;
	const time = date && !Number.isNaN(date.getTime()) ? date.getTime() : 0;
	return time;
};

const latestActivityAt = (supportCase = {}) => {
	const times = [supportCase.createdAt, supportCase.updatedAt].map(asTime);
	(supportCase.conversation || []).forEach((message) => {
		times.push(asTime(message.date));
	});
	return new Date(Math.max(...times.filter(Boolean), 0));
};

const isAiConversationMessage = (message = {}) => {
	const email = String(message?.messageBy?.customerEmail || "").toLowerCase();
	return (
		message?.isAi === true ||
		message?.isSystem === true ||
		AI_SUPPORT_EMAILS.has(email)
	);
};

const isGuestConversationMessage = (message = {}) =>
	Boolean(message?.message) && !isAiConversationMessage(message);

const latestGuestMessageIndex = (supportCase = {}) => {
	const conversation = Array.isArray(supportCase.conversation)
		? supportCase.conversation
		: [];
	for (let index = conversation.length - 1; index >= 0; index -= 1) {
		if (isGuestConversationMessage(conversation[index])) return index;
	}
	return -1;
};

const hasAiReplyAfterIndex = (supportCase = {}, index = -1) => {
	const conversation = Array.isArray(supportCase.conversation)
		? supportCase.conversation
		: [];
	return conversation
		.slice(Math.max(0, index + 1))
		.some((message) => !message?.isSystem && isAiConversationMessage(message));
};

const hasAiActivity = (supportCase = {}) => {
	if (supportCase.aiRelated || supportCase.aiResponderName) return true;
	const conversation = Array.isArray(supportCase.conversation)
		? supportCase.conversation
		: [];
	return conversation.some(isAiConversationMessage);
};

const latestGuestNeedsAiReply = (supportCase = {}) => {
	if (!supportCase || supportCase.caseStatus === "closed") return false;
	if (supportCase.aiToRespond === false) return false;
	const latestGuestIndex = latestGuestMessageIndex(supportCase);
	if (latestGuestIndex < 0) return false;
	return !hasAiReplyAfterIndex(supportCase, latestGuestIndex);
};

const latestGuestMessageAt = (supportCase = {}) => {
	const conversation = Array.isArray(supportCase.conversation)
		? supportCase.conversation
		: [];
	const latestGuestIndex = latestGuestMessageIndex(supportCase);
	if (latestGuestIndex < 0) return 0;
	return asTime(conversation[latestGuestIndex]?.date);
};

const aiIdleCloseReady = (supportCase = {}, cutoff) => {
	if (!hasAiActivity(supportCase)) return false;
	if (latestActivityAt(supportCase) > cutoff) return false;
	const latestGuestIndex = latestGuestMessageIndex(supportCase);
	if (latestGuestIndex < 0) return true;
	return hasAiReplyAfterIndex(supportCase, latestGuestIndex);
};

const aiCaseFilter = (cutoff) => ({
	caseStatus: "open",
	openedBy: "client",
	aiToRespond: true,
	conversation: { $exists: true, $ne: [] },
	$or: [
		{ aiRelated: true },
		{ aiResponderName: { $exists: true, $ne: "" } },
		{ "conversation.isAi": true },
		{ "conversation.isSystem": true },
		{ "conversation.messageBy.customerEmail": { $in: [...AI_SUPPORT_EMAILS] } },
	],
	$and: [
		{
			$or: [
				{ updatedAt: { $lte: cutoff } },
				{ updatedAt: { $exists: false } },
			],
		},
	],
});

const emitAutoClosedCase = (
	io,
	updatedCase,
	previousEscalationStatus = "none",
	reason = "inactive_timeout"
) => {
	if (!io || !updatedCase?._id) return;
	const caseId = String(updatedCase._id);
	io.to(caseId).emit("supportCaseUpdated", updatedCase);
	io.emit("supportCaseUpdated", updatedCase);
	io.emit("closeCase", {
		case: updatedCase,
		closedBy: "csr",
		reason,
	});
	io.to(caseId).emit("aiPaused", { caseId, reason });

	if (previousEscalationStatus === "active") {
		const escalationPayload = {
			case: updatedCase,
			caseId,
			escalationStatus: updatedCase.escalationStatus || "addressed",
		};
		io.emit("supportCaseEscalationAddressed", escalationPayload);
		io.emit("supportCaseEscalationUpdated", escalationPayload);
	}
};

const closeInactiveB2CClientSupportCases = async ({
	now = new Date(),
	inactiveMs = ONE_HOUR,
	limit = 100,
	io = null,
} = {}) => {
	const cutoff = new Date(now.getTime() - inactiveMs);
	const candidates = await SupportCase.find({
		caseStatus: "open",
		openedBy: "client",
		$or: [
			{ updatedAt: { $lte: cutoff } },
			{ updatedAt: { $exists: false } },
		],
	})
		.sort({ updatedAt: 1, createdAt: 1, _id: 1 })
		.limit(limit)
		.lean()
		.exec();

	let closed = 0;
	for (const supportCase of candidates) {
		const lastActivityAt = latestActivityAt(supportCase);
		if (lastActivityAt > cutoff) continue;

		const previousEscalationStatus = supportCase.escalationStatus || "none";
		const setFields = {
			caseStatus: "closed",
			closedAt: now,
			closedBy: "csr",
			updatedAt: now,
			aiToRespond: false,
			aiPausedAt: now,
			aiHandoffReason: "inactive_timeout",
		};

		if (previousEscalationStatus === "active") {
			setFields.escalationStatus = "addressed";
			setFields.escalationAddressedAt = now;
			setFields.escalationAddressedBy = null;
			setFields.escalationAddressedNote = "Closed after 1 hour of inactivity";
		}

		const updatedCase = await SupportCase.findOneAndUpdate(
			{
				_id: supportCase._id,
				caseStatus: "open",
				openedBy: "client",
			},
			{ $set: setFields },
			{ new: true }
		).exec();

		if (!updatedCase) continue;
		closed += 1;
		emitAutoClosedCase(io, updatedCase, previousEscalationStatus);
	}

	return { closed, cutoff };
};

const closeIdleAiSupportCases = async ({
	now = new Date(),
	idleMs = AI_IDLE_CLOSE_MS,
	limit = 100,
	io = null,
} = {}) => {
	const cutoff = new Date(now.getTime() - idleMs);
	const candidates = await SupportCase.find(aiCaseFilter(cutoff))
		.select(
			"_id caseStatus openedBy aiToRespond aiRelated aiResponderName escalationStatus createdAt updatedAt conversation"
		)
		.sort({ updatedAt: 1, createdAt: 1, _id: 1 })
		.limit(limit)
		.lean()
		.exec();

	let closed = 0;
	for (const supportCase of candidates) {
		if (!aiIdleCloseReady(supportCase, cutoff)) continue;

		const previousEscalationStatus = supportCase.escalationStatus || "none";
		const setFields = {
			caseStatus: "closed",
			closedAt: now,
			closedBy: "csr",
			updatedAt: now,
			aiToRespond: false,
			aiPausedAt: now,
			aiHandoffReason: "ai_idle_timeout",
			"conversation.$[].seenByAdmin": true,
			"conversation.$[].seenByHotel": true,
			"conversation.$[].seenByCustomer": true,
		};

		if (previousEscalationStatus === "active") {
			setFields.escalationStatus = "addressed";
			setFields.escalationAddressedAt = now;
			setFields.escalationAddressedBy = null;
			setFields.escalationAddressedNote = "Closed after AI idle timeout";
		}

		const updatedCase = await SupportCase.findOneAndUpdate(
			{
				_id: supportCase._id,
				caseStatus: "open",
				openedBy: "client",
				aiToRespond: true,
			},
			{ $set: setFields },
			{ new: true }
		).exec();

		if (!updatedCase) continue;
		closed += 1;
		emitAutoClosedCase(io, updatedCase, previousEscalationStatus, "ai_idle_timeout");
	}

	return { closed, cutoff };
};

const recoverUnansweredAiSupportCases = async ({
	now = new Date(),
	staleMs = AI_TURN_STALL_RECOVERY_MS,
	limit = 100,
	io = null,
	scheduleAiTurn = null,
} = {}) => {
	if (!io || typeof scheduleAiTurn !== "function") {
		return { scheduled: 0, cutoff: new Date(now.getTime() - staleMs) };
	}
	const cutoff = new Date(now.getTime() - staleMs);
	const candidates = await SupportCase.find(aiCaseFilter(cutoff))
		.select(
			"_id hotelId caseStatus openedBy aiToRespond aiRelated aiResponderName createdAt updatedAt conversation"
		)
		.sort({ updatedAt: 1, createdAt: 1, _id: 1 })
		.limit(limit)
		.lean()
		.exec();

	let scheduled = 0;
	for (const supportCase of candidates) {
		if (!latestGuestNeedsAiReply(supportCase)) continue;
		const guestAt = latestGuestMessageAt(supportCase);
		if (!guestAt || guestAt > cutoff.getTime()) continue;
		if (!hasAiActivity(supportCase)) continue;
		const didSchedule = scheduleAiTurn(io, supportCase._id, { delayMs: 150 });
		if (didSchedule) scheduled += 1;
	}

	return { scheduled, cutoff };
};

const startSupportCaseMaintenanceJob = ({ getIo, getScheduleAiTurn } = {}) => {
	const run = async () => {
		try {
			const io = typeof getIo === "function" ? getIo() : null;
			const scheduleAiTurn =
				typeof getScheduleAiTurn === "function" ? getScheduleAiTurn() : null;
			const recovered = await recoverUnansweredAiSupportCases({
				io,
				scheduleAiTurn,
			});
			const idleClosed = await closeIdleAiSupportCases({ io });
			await closeInactiveB2CClientSupportCases({
				io,
			});
			if (recovered.scheduled || idleClosed.closed) {
				console.log("[support-case] ai maintenance", {
					recovered: recovered.scheduled,
					idleClosed: idleClosed.closed,
				});
			}
		} catch (error) {
			console.error("[support-case] maintenance failed:", error?.message || error);
		}
	};

	run();
	const timer = setInterval(run, ONE_MINUTE);
	if (typeof timer.unref === "function") timer.unref();
	return timer;
};

module.exports = {
	closeInactiveB2CClientSupportCases,
	closeIdleAiSupportCases,
	recoverUnansweredAiSupportCases,
	startSupportCaseMaintenanceJob,
};
