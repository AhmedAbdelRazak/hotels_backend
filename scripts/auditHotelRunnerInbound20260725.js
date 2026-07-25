/** @format */

"use strict";

require("dotenv").config();

const mongoose = require("mongoose");

const InboundEmail = require("../models/inbound_email");
const Reservations = require("../models/reservations");
const {
	buildOtaIdentityKey,
	extractNormalizedReservation,
	requiredNewReservationMissing,
} = require("../services/otaReservationMapper");

const DETAILS = process.argv.includes("--details");
const sinceArgument = process.argv.find((argument) => argument.startsWith("--since="));
const since = sinceArgument
	? new Date(sinceArgument.slice("--since=".length))
	: new Date("2026-07-01T00:00:00.000Z");

if (Number.isNaN(since.getTime())) {
	throw new Error("--since must be a valid ISO date.");
}

const id = (value) => String(value?._id || value || "");
const ymd = (value) => {
	if (!value) return "";
	const parsed = value instanceof Date ? value : new Date(value);
	return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
};

function emailFromAudit(audit) {
	return {
		from: audit.from || "",
		to: audit.to || "",
		cc: audit.cc || "",
		bcc: audit.bcc || "",
		subject: audit.subject || "",
		text: audit.bodyText || "",
		html: audit.bodyHtml || "",
		messageId: audit.messageId || "",
		date: audit.receivedAt,
		receivedAt: audit.receivedAt,
	};
}

function summarizeEntry(entry) {
	const { audit, normalized, missing } = entry;
	return {
		auditId: id(audit._id),
		receivedAt: ymd(audit.receivedAt),
		processingStatus: audit.processingStatus || "",
		subject: audit.subject || "",
		provider: normalized.provider || "",
		bookingSource: normalized.bookingSource || "",
		confirmationNumber: normalized.confirmationNumber || "",
		guestName: normalized.guestName || "",
		hotelName: normalized.hotelName || "",
		roomName: normalized.roomName || "",
		checkinDate: normalized.checkinDate || "",
		checkoutDate: normalized.checkoutDate || "",
		bookedAt: ymd(normalized.bookedAt),
		bookedAtSourceBacked: normalized.sourcePresence?.bookedAt === true,
		sourceAmount: Number(normalized.amount || normalized.sourceAmount || 0),
		sourceCurrency: normalized.currency || normalized.sourceCurrency || "",
		totalAmountSar: Number(normalized.totalAmountSar || 0),
		adults: Number(normalized.adults || 0),
		children: Number(normalized.children || 0),
		totalGuests: Number(normalized.totalGuests || 0),
		roomCount: Number(normalized.roomCount || 0),
		paymentCollectionModel: normalized.paymentCollectionModel || "",
		missing,
	};
}

function bestEntry(left, right) {
	if (left.missing.length !== right.missing.length) {
		return left.missing.length < right.missing.length ? left : right;
	}
	const leftSourceCount = Object.values(left.normalized.sourcePresence || {}).filter(Boolean)
		.length;
	const rightSourceCount = Object.values(right.normalized.sourcePresence || {}).filter(Boolean)
		.length;
	if (leftSourceCount !== rightSourceCount) {
		return leftSourceCount > rightSourceCount ? left : right;
	}
	return new Date(left.audit.receivedAt) >= new Date(right.audit.receivedAt)
		? left
		: right;
}

async function main() {
	const database =
		process.env.DATABASE || process.env.MONGO_URI || process.env.MONGODB_URI;
	if (!database) throw new Error("Missing DATABASE/MONGO connection string.");
	await mongoose.connect(database, { autoIndex: false });

	const audits = await InboundEmail.find({
		from: /hotelrunner\.com/i,
		receivedAt: { $gte: since },
	})
		.sort({ receivedAt: 1, _id: 1 })
		.lean();

	const parsed = audits.map((audit) => {
		const normalized = extractNormalizedReservation(emailFromAudit(audit));
		return {
			audit,
			normalized,
			missing: requiredNewReservationMissing(normalized),
		};
	});
	const newReservationEntries = parsed.filter(
		(entry) =>
			entry.normalized.intent === "new_reservation" &&
			entry.normalized.eventType === "new"
	);

	const grouped = new Map();
	const identityless = [];
	for (const entry of newReservationEntries) {
		const key = buildOtaIdentityKey(
			entry.normalized.provider,
			entry.normalized.confirmationNumber
		);
		if (!key) {
			identityless.push(entry);
			continue;
		}
		const current = grouped.get(key);
		grouped.set(key, current ? bestEntry(current, entry) : entry);
	}

	const identityKeys = [...grouped.keys()];
	const reservations = identityKeys.length
		? await Reservations.find({ otaIdentityKey: { $in: identityKeys } })
				.select(
					"_id otaIdentityKey confirmation_number reservation_status hotelId customer_details.name booked_at createdAt"
				)
				.lean()
		: [];
	const reservationsByIdentity = new Map();
	for (const reservation of reservations) {
		const key = String(reservation.otaIdentityKey || "").toLowerCase();
		const current = reservationsByIdentity.get(key) || [];
		current.push(reservation);
		reservationsByIdentity.set(key, current);
	}

	const completeMissing = [];
	const incomplete = [];
	const stored = [];
	for (const [identityKey, entry] of grouped) {
		const matches = reservationsByIdentity.get(identityKey) || [];
		if (entry.missing.length) {
			incomplete.push({ identityKey, ...summarizeEntry(entry), storedCount: matches.length });
		} else if (!matches.length) {
			completeMissing.push({ identityKey, ...summarizeEntry(entry) });
		} else {
			stored.push({
				identityKey,
				...summarizeEntry(entry),
				reservationIds: matches.map((reservation) => id(reservation._id)),
				reservationStatuses: matches.map(
					(reservation) => reservation.reservation_status || ""
				),
			});
		}
	}

	const duplicateIdentityGroups = [...reservationsByIdentity.entries()]
		.filter(([, matches]) => matches.length > 1)
		.map(([identityKey, matches]) => ({
			identityKey,
			count: matches.length,
			reservationIds: matches.map((reservation) => id(reservation._id)),
		}));
	const byProvider = {};
	const byCurrency = {};
	for (const entry of grouped.values()) {
		const provider = entry.normalized.provider || "unknown";
		const currency =
			entry.normalized.currency || entry.normalized.sourceCurrency || "unknown";
		byProvider[provider] = (byProvider[provider] || 0) + 1;
		byCurrency[currency] = (byCurrency[currency] || 0) + 1;
	}

	const nonNewByEvent = {};
	for (const entry of parsed.filter((candidate) => !newReservationEntries.includes(candidate))) {
		const key = `${entry.normalized.intent || "unknown"}/${
			entry.normalized.eventType || "unknown"
		}`;
		nonNewByEvent[key] = (nonNewByEvent[key] || 0) + 1;
	}

	const report = {
		readOnly: true,
		since: since.toISOString(),
		hotelRunnerAudits: audits.length,
		newReservationAuditCopies: newReservationEntries.length,
		uniqueNewReservationIdentities: grouped.size,
		storedUniqueIdentities: stored.length,
		completeMissingCount: completeMissing.length,
		incompleteCount: incomplete.length + identityless.length,
		duplicateIdentityGroups,
		byProvider,
		byCurrency,
		nonNewByEvent,
		completeMissing,
		incomplete,
		identityless: identityless.map(summarizeEntry),
	};
	if (DETAILS) report.stored = stored;
	console.log(JSON.stringify(report, null, 2));
}

main()
	.catch((error) => {
		console.error(error);
		process.exitCode = 1;
	})
	.finally(async () => {
		if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
	});
