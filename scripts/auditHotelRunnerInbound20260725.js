/** @format */

"use strict";

require("dotenv").config();

const mongoose = require("mongoose");

const InboundEmail = require("../models/inbound_email");
const Reservations = require("../models/reservations");
const {
	buildOtaIdentityKey,
	extractNormalizedReservation,
	normalizeComparable,
	normalizeConfirmation,
	requiredNewReservationMissing,
} = require("../services/otaReservationMapper");

const DETAILS = process.argv.includes("--details");
const RESERVATION_SUBJECTS = process.argv.includes("--reservation-subjects");
const sinceArgument = process.argv.find((argument) => argument.startsWith("--since="));
const skipArgument = process.argv.find((argument) => argument.startsWith("--skip="));
const limitArgument = process.argv.find((argument) => argument.startsWith("--limit="));
const since = sinceArgument
	? new Date(sinceArgument.slice("--since=".length))
	: new Date("2026-07-01T00:00:00.000Z");
const skip = Math.max(0, Number(skipArgument?.slice("--skip=".length) || 0));
const limit = Math.max(0, Number(limitArgument?.slice("--limit=".length) || 0));

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
		requiresManualReview: normalized.requiresManualReview === true,
		warnings: normalized.warnings || [],
		errors: normalized.errors || [],
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

function reservationConfirmationValues(reservation = {}) {
	const values = [
		reservation.reservation_id,
		reservation.customer_details?.confirmation_number2,
		reservation.supplierData?.suppliedBookingNo,
		reservation.supplierData?.otaConfirmationNumber,
		reservation.supplierData?.platformConfirmationNumber,
	];
	const identityKey = String(reservation.otaIdentityKey || "");
	if (identityKey.includes(":")) values.push(identityKey.slice(identityKey.indexOf(":") + 1));
	return new Set(values.map(normalizeConfirmation).filter(Boolean));
}

function reservationProviderValues(reservation = {}) {
	return new Set(
		[
			reservation.supplierData?.otaProvider,
			reservation.otaPlatformReview?.provider,
			reservation.supplierData?.supplierName,
			reservation.booking_source,
			reservation.customer_details?.booking_source,
		]
			.map((value) => normalizeComparable(value).replace(/\s+/g, ""))
			.filter(Boolean)
	);
}

function reservationMatchesEntry(reservation, entry) {
	const confirmation = normalizeConfirmation(entry.normalized.confirmationNumber);
	const provider = normalizeComparable(entry.normalized.provider).replace(/\s+/g, "");
	const providerLabel = normalizeComparable(entry.normalized.providerLabel).replace(/\s+/g, "");
	const confirmationMatches = reservationConfirmationValues(reservation).has(confirmation);
	const providers = reservationProviderValues(reservation);
	return confirmationMatches && (providers.has(provider) || providers.has(providerLabel));
}

function canonicalSarIssues(reservation = {}) {
	const issues = [];
	if (String(reservation.currency || "SAR").toUpperCase() !== "SAR") {
		issues.push(`root currency is ${reservation.currency || "blank"}`);
	}
	const financialCurrency = reservation.ota_financial_summary?.currency;
	if (financialCurrency && String(financialCurrency).toUpperCase() !== "SAR") {
		issues.push(`OTA financial summary currency is ${financialCurrency}`);
	}
	for (const [field, value] of Object.entries({
		total_amount: reservation.total_amount,
		sub_total: reservation.sub_total,
		paid_amount: reservation.paid_amount,
		commission: reservation.commission,
	})) {
		if (!Number.isFinite(Number(value || 0))) issues.push(`${field} is not numeric`);
	}
	return issues;
}

async function main() {
	const database =
		process.env.DATABASE || process.env.MONGO_URI || process.env.MONGODB_URI;
	if (!database) throw new Error("Missing DATABASE/MONGO connection string.");
	await mongoose.connect(database, { autoIndex: false });

	const auditFilter = {
		from: /hotelrunner\.com/i,
		receivedAt: { $gte: since },
		...(RESERVATION_SUBJECTS
			? { subject: /(?:new|updated?|cancel(?:led|ation)?|modified?)\s+reservation|reservation\s+(?:new|updated?|cancel(?:led|ation)?|modified?)|حجز\s+جديد|تحديث\s+الحجز|إلغاء\s+الحجز/i }
			: {}),
	};
	const totalMatchingAudits = await InboundEmail.countDocuments(auditFilter);
	let auditQuery = InboundEmail.find(auditFilter)
		.sort({ receivedAt: 1, _id: 1 })
		.skip(skip);
	if (limit) auditQuery = auditQuery.limit(limit);
	const audits = await auditQuery.lean();

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
	const confirmationValues = Array.from(
		new Set(
			[...grouped.values()]
				.flatMap((entry) => {
					const raw = String(entry.normalized.confirmationNumber || "");
					const normalized = normalizeConfirmation(raw);
					return [raw, raw.toLowerCase(), raw.toUpperCase(), normalized];
				})
				.filter(Boolean)
		)
	);
	const reservations = identityKeys.length
		? await Reservations.find({
				$or: [
					{ otaIdentityKey: { $in: identityKeys } },
					{ reservation_id: { $in: confirmationValues } },
					{ "customer_details.confirmation_number2": { $in: confirmationValues } },
					{ "supplierData.suppliedBookingNo": { $in: confirmationValues } },
					{ "supplierData.otaConfirmationNumber": { $in: confirmationValues } },
					{ "supplierData.platformConfirmationNumber": { $in: confirmationValues } },
				],
			})
				.select(
					"_id otaIdentityKey reservation_id confirmation_number reservation_status hotelId customer_details booking_source booked_at createdAt currency total_amount sub_total paid_amount commission supplierData otaPlatformReview ota_financial_summary"
				)
				.lean()
		: [];
	const reservationsByIdentity = new Map();
	for (const [identityKey, entry] of grouped) {
		reservationsByIdentity.set(
			identityKey,
			reservations.filter((reservation) => reservationMatchesEntry(reservation, entry))
		);
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
				canonicalIdentityPresent: matches.every(
					(reservation) =>
						String(reservation.otaIdentityKey || "").toLowerCase() === identityKey
				),
				canonicalSarIssues: matches.flatMap((reservation) =>
					canonicalSarIssues(reservation).map((issue) => ({
						reservationId: id(reservation._id),
						issue,
					}))
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
		reservationSubjectsOnly: RESERVATION_SUBJECTS,
		totalMatchingAudits,
		skip,
		limit: limit || null,
		hotelRunnerAudits: audits.length,
		newReservationAuditCopies: newReservationEntries.length,
		uniqueNewReservationIdentities: grouped.size,
		storedUniqueIdentities: stored.length,
		completeMissingCount: completeMissing.length,
		incompleteCount: incomplete.length + identityless.length,
		duplicateIdentityGroups,
		storedWithoutCanonicalIdentityCount: stored.filter(
			(entry) => !entry.canonicalIdentityPresent
		).length,
		canonicalSarIssueCount: stored.reduce(
			(total, entry) => total + entry.canonicalSarIssues.length,
			0
		),
		canonicalSarIssues: stored
			.filter((entry) => entry.canonicalSarIssues.length)
			.map((entry) => ({
				identityKey: entry.identityKey,
				issues: entry.canonicalSarIssues,
			})),
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
