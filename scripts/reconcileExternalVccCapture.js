/**
 * Safely records externally completed OTA virtual-card captures.
 *
 * Dry run (default):
 *   node scripts/reconcileExternalVccCapture.js --input C:\safe\evidence.json
 *   Get-Content C:\safe\evidence.json | node scripts/reconcileExternalVccCapture.js --stdin
 *
 * Apply only after reviewing a successful dry run:
 *   node scripts/reconcileExternalVccCapture.js --input C:\safe\evidence.json --apply
 *
 * The evidence schema and operational procedure are documented in:
 *   docs/ops/external-ota-vcc-capture-reconciliation.md
 */

"use strict";

require("dotenv").config();

const fs = require("node:fs/promises");
const path = require("node:path");
const mongoose = require("mongoose");

mongoose.set("strictQuery", true);

const HotelDetails = require("../models/hotel_details");
const Reservations = require("../models/reservations");
const {
	BACKUP_COLLECTION,
	EXTERNAL_CAPTURE_CHANNEL,
	buildConcurrencyFilter,
	buildExternalCaptureSet,
	hasAnyCaptureState,
	isSameCompletedCapture,
	normalizeEvidenceBatch,
	providerFromReservation,
	reservationIdentityQuery,
	splitSetAndAudit,
	stableHash,
	transactionCollisionQuery,
	verifyCompletedCapture,
	verifyProtectedReservationSnapshot,
} = require("../services/externalVccReconciliation");

const APPLY = process.argv.includes("--apply");
const STDIN = process.argv.includes("--stdin");
const inputFlagIndex = process.argv.indexOf("--input");
const inputPath = inputFlagIndex >= 0 ? process.argv[inputFlagIndex + 1] : "";

const id = (value) => String(value?._id || value || "");

const usage = () => [
	"Usage:",
	"  node scripts/reconcileExternalVccCapture.js --input <evidence.json> [--apply]",
	"  <json> | node scripts/reconcileExternalVccCapture.js --stdin [--apply]",
	"Dry-run is the default. --apply is required for any database write.",
].join("\n");

const readStdin = async () => {
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	return Buffer.concat(chunks).toString("utf8");
};

const readEvidence = async () => {
	if (STDIN === Boolean(inputPath)) {
		throw new Error(`Choose exactly one input source.\n${usage()}`);
	}
	const jsonText = STDIN
		? await readStdin()
		: await fs.readFile(path.resolve(inputPath), "utf8");
	let parsed;
	try {
		parsed = JSON.parse(jsonText);
	} catch (_error) {
		throw new Error("Evidence input is not valid JSON.");
	}
	return normalizeEvidenceBatch(parsed);
};

const moneyCents = (value) => Math.round(Number(value || 0) * 100);
const comparableText = (value) => String(value == null ? "" : value).trim();
const comparableCardType = (value) => {
	const normalized = comparableText(value).toUpperCase().replace(/[\s_-]+/g, "");
	return ["MC", "MCARD", "MASTERCARD"].includes(normalized)
		? "MASTERCARD"
		: normalized;
};
const safeIso = (value) => {
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? "" : date.toISOString();
};

const existingCaptureMatchesEvidence = (reservation, evidence) => {
	if (!isSameCompletedCapture(reservation, evidence)) return false;
	const external = reservation.paypal_details?.external_virtual_terminal || {};
	return (
		moneyCents(external.gross_amount_usd) === evidence.grossCents &&
		moneyCents(external.transaction_fee_usd) === evidence.feeCents &&
		moneyCents(external.net_amount_usd) === evidence.netCents &&
		comparableText(external.card_last4) === evidence.cardLast4 &&
		comparableCardType(external.card_type) === evidence.cardType &&
		comparableText(external.csc_result).toUpperCase() === evidence.cscResult &&
		comparableText(external.avs_result).toUpperCase() === evidence.avsResult &&
		comparableText(external.payer_name).toLowerCase() ===
			evidence.payerName.toLowerCase() &&
		Boolean(external.shipping_address_on_file) ===
			evidence.shippingAddressOnFile &&
		safeIso(external.transaction_at) === evidence.transactionAt
	);
};

const findReservation = async (evidence) => {
	const candidates = await Reservations.collection
		.find(reservationIdentityQuery(evidence.invoiceId))
		.toArray();
	if (candidates.length !== 1) {
		throw new Error(
			`Invoice ${evidence.invoiceId} matched ${candidates.length} reservation documents; exactly one is required.`,
		);
	}
	const reservation = candidates[0];
	if (String(reservation.reservation_id || "") !== evidence.invoiceId) {
		throw new Error(
			`Invoice ${evidence.invoiceId} did not equal the matched reservation's authoritative reservation_id. No update is allowed.`,
		);
	}
	return reservation;
};

const findHotelName = async (reservation) => {
	if (!reservation.hotelId) return String(reservation.hotelName || "").trim();
	const hotel = await HotelDetails.findById(reservation.hotelId)
		.select("hotelName")
		.lean();
	return String(hotel?.hotelName || reservation.hotelName || "").trim();
};

const checkTransactionUniqueness = async (evidence, targetReservationId) => {
	const collisions = await Reservations.collection
		.find(transactionCollisionQuery(evidence.transactionId), {
			projection: { _id: 1, reservation_id: 1 },
		})
		.toArray();
	const foreign = collisions.filter(
		(candidate) => id(candidate) !== id(targetReservationId),
	);
	if (foreign.length || collisions.length > 1) {
		throw new Error(
			`Transaction ${evidence.transactionId} is already linked to another or multiple reservations.`,
		);
	}
	return collisions.length;
};

const buildPlan = async (evidence) => {
	const reservation = await findReservation(evidence);
	const actualProvider = providerFromReservation(reservation);
	if (actualProvider !== evidence.provider) {
		throw new Error(
			`Invoice ${evidence.invoiceId} belongs to ${actualProvider || "an unknown source"}, not ${evidence.provider}.`,
		);
	}
	if (!reservation.checkin_date || !reservation.checkout_date) {
		throw new Error(
			`Invoice ${evidence.invoiceId} has incomplete stay dates and cannot be reconciled.`,
		);
	}
	const collisionCount = await checkTransactionUniqueness(
		evidence,
		reservation._id,
	);
	const alreadyRecorded = isSameCompletedCapture(reservation, evidence);
	if (alreadyRecorded && !existingCaptureMatchesEvidence(reservation, evidence)) {
		throw new Error(
			`Invoice ${evidence.invoiceId} already has this capture identity, but its saved fee, net, card suffix/type, or timestamp differs from the supplied evidence.`,
		);
	}
	if (!alreadyRecorded && hasAnyCaptureState(reservation)) {
		throw new Error(
			`Invoice ${evidence.invoiceId} already contains captured or paid money. Refusing a possible duplicate/overcharge reconciliation.`,
		);
	}
	if (!alreadyRecorded && collisionCount !== 0) {
		throw new Error(
			`Transaction ${evidence.transactionId} is already present but is not a complete matching reconciliation.`,
		);
	}
	const hotelName = await findHotelName(reservation);
	if (!hotelName) {
		throw new Error(`Invoice ${evidence.invoiceId} has no resolvable hotel name.`);
	}
	return {
		evidence,
		reservation,
		hotelName,
		alreadyRecorded,
		originalHash: stableHash(reservation),
	};
};

const reconciliationKey = (plan) =>
	`${id(plan.reservation)}:paypal_virtual_terminal:${plan.evidence.transactionId}`;

const ensureBackup = async (plan, backupCollection) => {
	const key = reconciliationKey(plan);
	const existing = await backupCollection.find({ reconciliation_key: key }).toArray();
	if (existing.length > 1) {
		throw new Error(`Multiple backups exist for ${plan.evidence.invoiceId}; manual review is required.`);
	}
	if (existing.length === 1) {
		const backup = existing[0];
		if (
			id(backup.reservation_mongo_id) !== id(plan.reservation) ||
			backup.invoice_id !== plan.evidence.invoiceId ||
			backup.transaction_id !== plan.evidence.transactionId
		) {
			throw new Error(`Existing backup identity is inconsistent for ${plan.evidence.invoiceId}.`);
		}
		return backup;
	}
	if (plan.alreadyRecorded) {
		throw new Error(
			`Invoice ${plan.evidence.invoiceId} is already reconciled but has no workflow backup. Refusing to manufacture one after the fact.`,
		);
	}
	const backup = {
		reconciliation_key: key,
		operation: "external_ota_vcc_capture_reconciliation",
		reservation_mongo_id: plan.reservation._id,
		invoice_id: plan.evidence.invoiceId,
		transaction_id: plan.evidence.transactionId,
		created_at: new Date(),
		original_document_hash: plan.originalHash,
		original_document: plan.reservation,
	};
	const result = await backupCollection.insertOne(backup);
	backup._id = result.insertedId;
	const verified = await backupCollection.findOne({ _id: result.insertedId });
	if (!verified || verified.original_document_hash !== plan.originalHash) {
		throw new Error(`Backup verification failed for ${plan.evidence.invoiceId}.`);
	}
	return verified;
};

const preflightReport = (plan) => ({
	invoiceId: plan.evidence.invoiceId,
	transactionId: plan.evidence.transactionId,
	amount: `${(plan.evidence.grossCents / 100).toFixed(2)} USD`,
	reservationMongoId: id(plan.reservation),
	provider: plan.evidence.provider,
	hotelName: plan.hotelName,
	checkinDate: new Date(plan.reservation.checkin_date).toISOString().slice(0, 10),
	checkoutDate: new Date(plan.reservation.checkout_date).toISOString().slice(0, 10),
	action: plan.alreadyRecorded
		? "existing_reconciliation_verified"
		: "would_reconcile",
	protectedFields: "unchanged",
});

const applyPlan = async (plan, backup, backupCollection) => {
	if (plan.alreadyRecorded) {
		verifyCompletedCapture({ reservation: plan.reservation, evidence: plan.evidence });
		return {
			...preflightReport(plan),
			action: "already_reconciled_and_verified",
			backupId: id(backup),
		};
	}

	const current = await Reservations.collection.findOne({
		_id: plan.reservation._id,
	});
	if (!current || stableHash(current) !== plan.originalHash) {
		throw new Error(
			`Invoice ${plan.evidence.invoiceId} changed after preflight. Run a new dry run before retrying.`,
		);
	}
	await checkTransactionUniqueness(plan.evidence, current._id);

	const captureSet = buildExternalCaptureSet({
		reservation: current,
		evidence: plan.evidence,
		hotelName: plan.hotelName,
		recordedAt: new Date(),
		backupId: backup._id,
	});
	const { set, audit } = splitSetAndAudit(captureSet);
	const update = await Reservations.collection.updateOne(
		buildConcurrencyFilter(current),
		{
			$set: set,
			$push: { reservationAuditLog: audit },
		},
	);
	if (update.matchedCount !== 1 || update.modifiedCount !== 1) {
		throw new Error(
			`Conditional update did not modify invoice ${plan.evidence.invoiceId}; it may have changed concurrently.`,
		);
	}

	const saved = await Reservations.collection.findOne({ _id: current._id });
	const backupCount = await backupCollection.countDocuments({
		reconciliation_key: reconciliationKey(plan),
	});
	const transactionCount = await checkTransactionUniqueness(
		plan.evidence,
		current._id,
	);
	if (backupCount !== 1) {
		throw new Error(`Expected exactly one backup for ${plan.evidence.invoiceId}.`);
	}
	if (transactionCount !== 1) {
		throw new Error(`Expected exactly one transaction owner for ${plan.evidence.invoiceId}.`);
	}
	if (!verifyProtectedReservationSnapshot(current, saved)) {
		throw new Error(
			`Protected reservation data changed while reconciling ${plan.evidence.invoiceId}. Use the backup and investigate immediately.`,
		);
	}
	const summary = verifyCompletedCapture({
		reservation: saved,
		evidence: plan.evidence,
	});
	if (!existingCaptureMatchesEvidence(saved, plan.evidence)) {
		throw new Error(`Detailed saved evidence verification failed for ${plan.evidence.invoiceId}.`);
	}
	return {
		...preflightReport(plan),
		action: "reconciled_and_verified",
		backupId: id(backup),
		captureSummary: {
			status: summary.status,
			gateway: summary.gateway,
			amount: `${Number(summary.amountUsd).toFixed(2)} ${summary.currency}`,
			reference: summary.referenceNumber,
			transactionId: summary.transactionId,
		},
	};
};

const main = async () => {
	const evidenceBatch = await readEvidence();
	const database =
		process.env.DATABASE || process.env.MONGO_URI || process.env.MONGODB_URI;
	if (!database) throw new Error("Missing DATABASE/MONGO connection string.");
	await mongoose.connect(database, { autoIndex: false });

	const plans = [];
	for (const evidence of evidenceBatch) plans.push(await buildPlan(evidence));
	if (!APPLY) {
		const hasPendingReconciliation = plans.some(
			(plan) => !plan.alreadyRecorded,
		);
		return {
			ok: true,
			mode: "dry-run",
			writesPerformed: false,
			results: plans.map(preflightReport),
			nextStep: hasPendingReconciliation
				? "Re-check the source evidence and run the identical input with --apply only if every would_reconcile row is correct."
				: "No apply is needed. Every supplied capture is already reconciled and verified.",
		};
	}

	const backupCollection = mongoose.connection.db.collection(BACKUP_COLLECTION);
	const backups = [];
	for (const plan of plans) backups.push(await ensureBackup(plan, backupCollection));

	// Recheck every target after every backup exists and before the first reservation write.
	for (const plan of plans) {
		if (plan.alreadyRecorded) continue;
		const current = await Reservations.collection.findOne({
			_id: plan.reservation._id,
		});
		if (!current || stableHash(current) !== plan.originalHash) {
			throw new Error(
				`Invoice ${plan.evidence.invoiceId} changed before apply. No reservation updates were started.`,
			);
		}
	}

	const results = [];
	for (let index = 0; index < plans.length; index += 1) {
		results.push(await applyPlan(plans[index], backups[index], backupCollection));
	}
	return {
		ok: true,
		mode: "apply",
		writesPerformed: results.some(
			(result) => result.action === "reconciled_and_verified",
		),
		results,
	};
};

const runCli = () =>
	main()
		.then((report) => {
			process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
		})
		.catch((error) => {
			process.stderr.write(
				`${JSON.stringify(
					{
						ok: false,
						mode: APPLY ? "apply" : "dry-run",
						error: String(error?.message || error),
					},
					null,
					2,
				)}\n`,
			);
			process.exitCode = 1;
		})
		.finally(async () => {
			if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
		});

if (require.main === module) runCli();

module.exports = {
	existingCaptureMatchesEvidence,
	preflightReport,
	readEvidence,
	runCli,
};
