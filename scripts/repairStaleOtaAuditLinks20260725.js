/** @format */

"use strict";

require("dotenv").config();

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const mongoose = require("mongoose");
const InboundEmail = require("../models/inbound_email");
const {
	detectConfirmationMatchFields,
	extractNormalizedReservation,
	findReservationByOtaConfirmation,
	normalizeConfirmation,
} = require("../services/otaReservationMapper");

const APPLY = process.argv.includes("--apply");
const INCIDENT_START = new Date("2026-07-01T00:00:00.000Z");
const SUPPORTED_PROVIDERS = [
	"expedia",
	"booking",
	"agoda",
	"hotels",
	"airbnb",
	"hotelrunner",
	"trip",
];
const HISTORIC_SOURCE_ERROR =
	"Reservation confirmation number is not source-backed.";

const id = (value) => String(value || "");

function reparseAudit(audit) {
	return extractNormalizedReservation({
		inboundEmailId: id(audit._id),
		from: audit.from,
		to: audit.to,
		cc: audit.cc,
		bcc: audit.bcc,
		subject: audit.subject,
		text: audit.bodyText,
		html: audit.bodyHtml,
		receivedAt: audit.receivedAt,
	});
}

function safePlanSummary(plan) {
	return {
		auditId: id(plan.audit._id),
		provider: plan.audit.provider,
		confirmationNumber: plan.audit.confirmationNumber,
		processingStatus: plan.audit.processingStatus,
		reservationId: id(plan.reservation._id),
		pmsConfirmationNumber: plan.reservation.confirmation_number,
		hotelId: id(plan.reservation.hotelId),
		matchedReservationBy: plan.matchedReservationBy,
	};
}

function snapshotPath(stage) {
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const directory = path.resolve(__dirname, "..", "deploy-backups");
	fs.mkdirSync(directory, { recursive: true });
	return path.join(directory, `ota-audit-links-20260725-${stamp}-${stage}.json`);
}

function writeSnapshot(stage, value) {
	const outputPath = snapshotPath(stage);
	fs.writeFileSync(outputPath, JSON.stringify(value, null, 2), "utf8");
	return outputPath;
}

async function buildPlans() {
	const audits = await InboundEmail.find({
		receivedAt: { $gte: INCIDENT_START },
		provider: { $in: SUPPORTED_PROVIDERS },
		confirmationNumber: { $type: "string", $ne: "" },
		$or: [
			{ reservationMongoId: null },
			{ reservationMongoId: { $exists: false } },
			{ hasReservationConnection: { $ne: true } },
		],
	})
		.sort({ receivedAt: 1, _id: 1 })
		.lean();

	const plans = [];
	for (const audit of audits) {
		// Exact provider + confirmation identity is required before any audit link.
		// eslint-disable-next-line no-await-in-loop
		const reservation = await findReservationByOtaConfirmation(
			audit.confirmationNumber,
			audit.provider
		);
		if (!reservation) continue;

		const reparsed = reparseAudit(audit);
		assert.equal(
			reparsed.provider,
			audit.provider,
			`provider changed while reparsing audit ${id(audit._id)}`
		);
		assert.equal(
			normalizeConfirmation(reparsed.confirmationNumber),
			normalizeConfirmation(audit.confirmationNumber),
			`confirmation changed while reparsing audit ${id(audit._id)}`
		);
		assert.equal(
			reparsed.sourcePresence?.confirmationNumber,
			true,
			`confirmation is still not source-backed for audit ${id(audit._id)}`
		);

		const matchedReservationBy = detectConfirmationMatchFields(
			reservation,
			audit.confirmationNumber,
			audit.provider
		);
		assert.ok(
			matchedReservationBy.length,
			`reservation identity fields did not match audit ${id(audit._id)}`
		);
		plans.push({ audit, reparsed, reservation, matchedReservationBy });
	}
	return plans;
}

function connectionUpdate(plan, now) {
	const set = {
		hasReservationConnection: true,
		matchedReservationBy: plan.matchedReservationBy,
		reservationMongoId: plan.reservation._id,
		hotelId: plan.reservation.hotelId || null,
		pmsConfirmationNumber: plan.reservation.confirmation_number || "",
		"normalizedReservation.sourcePresence.confirmationNumber": true,
		processedAt: now,
	};

	if (
		plan.audit.processingStatus === "needs_review" &&
		plan.audit.reconciliation?.skipReason === "confirmation_not_source_backed"
	) {
		const remainingErrors = [
			...(plan.audit.reconciliation?.errors || []),
		].filter((error) => error !== HISTORIC_SOURCE_ERROR);
		const remainingReconcileErrors = [...(plan.audit.reconcileErrors || [])].filter(
			(error) => error !== HISTORIC_SOURCE_ERROR
		);
		assert.deepEqual(
			remainingErrors,
			[],
			`unexpected reconciliation errors on audit ${id(plan.audit._id)}`
		);
		assert.deepEqual(
			remainingReconcileErrors,
			[],
			`unexpected top-level reconcile errors on audit ${id(plan.audit._id)}`
		);
		set["reconciliation.actionTaken"] = "linked_existing_reservation";
		set["reconciliation.skipReason"] = "historic_review_preserved_after_exact_link";
		set["reconciliation.automationComment"] =
			"The corrected deterministic parser verified the OTA confirmation and linked the exact existing reservation. The historic review and forwarding decision were preserved.";
		set["reconciliation.errors"] = [];
		set.reconcileErrors = [];
	}
	return set;
}

async function applyPlan(plan) {
	const now = new Date();
	const result = await InboundEmail.updateOne(
		{
			_id: plan.audit._id,
			provider: plan.audit.provider,
			confirmationNumber: plan.audit.confirmationNumber,
			$or: [
				{ reservationMongoId: null },
				{ reservationMongoId: { $exists: false } },
				{
					$and: [
						{ hasReservationConnection: { $ne: true } },
						{ reservationMongoId: plan.reservation._id },
					],
				},
			],
		},
		{ $set: connectionUpdate(plan, now) }
	);
	if (result.modifiedCount === 1) return;

	const current = await InboundEmail.findById(plan.audit._id)
		.select("hasReservationConnection reservationMongoId")
		.lean();
	assert.equal(current?.hasReservationConnection, true, "audit was not linked");
	assert.equal(
		id(current?.reservationMongoId),
		id(plan.reservation._id),
		"audit was concurrently linked to a different reservation"
	);
}

async function main() {
	const database =
		process.env.DATABASE || process.env.MONGO_URI || process.env.MONGODB_URI;
	if (!database) throw new Error("Missing DATABASE/MONGO connection string.");
	await mongoose.connect(database, { autoIndex: false });

	const plans = await buildPlans();
	console.log(
		JSON.stringify(
			{
				mode: APPLY ? "apply" : "dry-run",
				exactSourceBackedLinks: plans.length,
				audits: plans.map(safePlanSummary),
			},
			null,
			2
		)
	);
	if (!APPLY || !plans.length) return;

	const auditIds = plans.map((plan) => plan.audit._id);
	const beforeSnapshot = writeSnapshot("before", {
		createdAt: new Date(),
		audits: await InboundEmail.find({ _id: { $in: auditIds } }).lean(),
	});
	console.log(`Before snapshot: ${beforeSnapshot}`);

	for (const plan of plans) {
		// Every update uses an immutable audit _id and exact stored OTA identity.
		// eslint-disable-next-line no-await-in-loop
		await applyPlan(plan);
	}

	const afterAudits = await InboundEmail.find({ _id: { $in: auditIds } }).lean();
	for (const plan of plans) {
		const audit = afterAudits.find((candidate) => id(candidate._id) === id(plan.audit._id));
		assert.equal(audit?.hasReservationConnection, true, "linked flag missing");
		assert.equal(
			id(audit?.reservationMongoId),
			id(plan.reservation._id),
			"linked reservation mismatch"
		);
	}
	const afterSnapshot = writeSnapshot("after", {
		createdAt: new Date(),
		beforeSnapshot,
		audits: afterAudits,
	});
	console.log(`After snapshot: ${afterSnapshot}`);
	console.log(JSON.stringify({ success: true, linkedAudits: plans.length }, null, 2));
}

main()
	.catch((error) => {
		console.error(error);
		process.exitCode = 1;
	})
	.finally(async () => {
		if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
	});
