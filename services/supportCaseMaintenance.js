/** @format */

const SupportCase = require("../models/supportcase");

const ONE_HOUR = 60 * 60 * 1000;
const ONE_MINUTE = 60 * 1000;

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

const emitAutoClosedCase = (io, updatedCase, previousEscalationStatus = "none") => {
	if (!io || !updatedCase?._id) return;
	const caseId = String(updatedCase._id);
	io.to(caseId).emit("supportCaseUpdated", updatedCase);
	io.emit("supportCaseUpdated", updatedCase);
	io.emit("closeCase", {
		case: updatedCase,
		closedBy: "csr",
		reason: "inactive_timeout",
	});
	io.to(caseId).emit("aiPaused", { caseId, reason: "inactive_timeout" });

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

const startSupportCaseMaintenanceJob = ({ getIo } = {}) => {
	const run = async () => {
		try {
			await closeInactiveB2CClientSupportCases({
				io: typeof getIo === "function" ? getIo() : null,
			});
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
	startSupportCaseMaintenanceJob,
};
