/** @format */

"use strict";

require("dotenv").config();

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const mongoose = require("mongoose");
const InboundEmail = require("../models/inbound_email");
const Reservations = require("../models/reservations");
const {
	buildOtaIdentityKey,
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
const SYSTEM_ACTOR = {
	name: "OTA audit-link repair 2026-07-25",
	email: "system@jannatbooking.com",
	role: "system",
};

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

function plausibleProviderConfirmation(provider, confirmationNumber) {
	const value = normalizeConfirmation(confirmationNumber);
	if (!value || value.length < 6 || value.length > 30) return false;
	if (["agoda", "expedia"].includes(provider)) return /^\d{8,18}$/.test(value);
	if (provider === "airbnb") return /^hm[a-z0-9]{6,20}$/i.test(value);
	return /^[a-z0-9][a-z0-9-]{5,29}$/i.test(value);
}

function safePlanSummary(plan) {
	return {
		auditId: id(plan.audit._id),
		provider: plan.audit.provider,
		previousConfirmationNumber: plan.audit.confirmationNumber,
		confirmationNumber: plan.confirmationNumber,
		processingStatus: plan.audit.processingStatus,
		reservationId: id(plan.reservation._id),
		previousReservationId: id(plan.previousReservationMongoId),
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
	const unconnectedAudits = await InboundEmail.find({
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
	const connectedAudits = await InboundEmail.find({
		provider: { $in: SUPPORTED_PROVIDERS },
		confirmationNumber: { $type: "string", $ne: "" },
		hasReservationConnection: true,
		reservationMongoId: { $ne: null },
	})
		.sort({ receivedAt: 1, _id: 1 })
		.lean();
	const connectedReservationIds = Array.from(
		new Set(connectedAudits.map((audit) => id(audit.reservationMongoId)).filter(Boolean))
	);
	const liveLinkedReservations = connectedReservationIds.length
		? await Reservations.find({ _id: { $in: connectedReservationIds } })
				.select("_id")
				.lean()
		: [];
	const liveLinkedIds = new Set(
		liveLinkedReservations.map((reservation) => id(reservation._id))
	);
	const staleAudits = connectedAudits.filter(
		(audit) => !liveLinkedIds.has(id(audit.reservationMongoId))
	);
	const audits = Array.from(
		new Map(
			[...unconnectedAudits, ...staleAudits].map((audit) => [id(audit._id), audit])
		).values()
	);

	const plans = [];
	const identityPlansByReservation = new Map();
	for (const audit of audits) {
		const reparsed = reparseAudit(audit);
		if (
			reparsed.provider !== audit.provider ||
			reparsed.sourcePresence?.confirmationNumber !== true
		) {
			continue;
		}
		const confirmationNumber = normalizeConfirmation(
			reparsed.confirmationNumber
		);
		if (!plausibleProviderConfirmation(audit.provider, confirmationNumber)) {
			continue;
		}
		const storedConfirmationNumber = normalizeConfirmation(
			audit.confirmationNumber
		);
		if (confirmationNumber !== storedConfirmationNumber) {
			if (plausibleProviderConfirmation(audit.provider, storedConfirmationNumber)) {
				continue;
			}
		}
		// Exact provider + confirmation identity is required before any audit link.
		// eslint-disable-next-line no-await-in-loop
		const reservation = await findReservationByOtaConfirmation(
			confirmationNumber,
			audit.provider
		);
		if (!reservation) continue;

		const matchedReservationBy = detectConfirmationMatchFields(
			reservation,
			confirmationNumber,
			audit.provider
		);
		assert.ok(
			matchedReservationBy.length,
			`reservation identity fields did not match audit ${id(audit._id)}`
		);
		const otaIdentityKey = buildOtaIdentityKey(
			audit.provider,
			confirmationNumber
		);
		assert.ok(otaIdentityKey, `canonical identity missing for audit ${id(audit._id)}`);
		const previousIdentityKey = String(reservation.otaIdentityKey || "").toLowerCase();
		if (previousIdentityKey !== otaIdentityKey) {
			assert.ok(
				!previousIdentityKey ||
					previousIdentityKey === confirmationNumber,
				`reservation ${id(reservation._id)} has a conflicting OTA identity`
			);
			// eslint-disable-next-line no-await-in-loop
			const competingOwner = await Reservations.findOne({
				_id: { $ne: reservation._id },
				otaIdentityKey,
			})
				.select("_id")
				.lean();
			assert.equal(
				competingOwner,
				null,
				`canonical identity ${otaIdentityKey} already has another owner`
			);
			identityPlansByReservation.set(id(reservation._id), {
				reservation,
				previousIdentityKey,
				otaIdentityKey,
				evidenceAuditIds: [
					...(identityPlansByReservation.get(id(reservation._id))?.evidenceAuditIds || []),
					id(audit._id),
				],
			});
		}
		plans.push({
			audit,
			reparsed,
			reservation,
			matchedReservationBy,
			confirmationNumber,
			previousReservationMongoId: audit.reservationMongoId || null,
		});
	}
	const plannedAuditIds = new Set(plans.map((plan) => id(plan.audit._id)));
	const unresolvedStaleAudits = staleAudits
		.filter((audit) => !plannedAuditIds.has(id(audit._id)))
		.map((audit) => ({
			auditId: id(audit._id),
			provider: audit.provider,
			confirmationNumber: audit.confirmationNumber,
			processingStatus: audit.processingStatus,
			previousReservationId: id(audit.reservationMongoId),
			subject: audit.subject,
			reason: "no exact existing reservation matched the stored provider and confirmation",
		}));
	return {
		plans,
		identityPlans: [...identityPlansByReservation.values()],
		staleAuditCount: staleAudits.length,
		unresolvedStaleAudits,
	};
}

function connectionUpdate(plan, now) {
	const set = {
		hasReservationConnection: true,
		matchedReservationBy: plan.matchedReservationBy,
		confirmationNumber: plan.confirmationNumber,
		reservationMongoId: plan.reservation._id,
		hotelId: plan.reservation.hotelId || null,
		pmsConfirmationNumber: plan.reservation.confirmation_number || "",
		normalizedReservation: plan.reparsed,
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
	const staleLinkFilter = plan.previousReservationMongoId
		? {
				hasReservationConnection: true,
				reservationMongoId: plan.previousReservationMongoId,
		  }
		: null;
	const result = await InboundEmail.updateOne(
		{
			_id: plan.audit._id,
			provider: plan.audit.provider,
			confirmationNumber: plan.audit.confirmationNumber,
			$or: [
				{ reservationMongoId: null },
				{ reservationMongoId: { $exists: false } },
				...(staleLinkFilter ? [staleLinkFilter] : []),
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

	const { plans, identityPlans, staleAuditCount, unresolvedStaleAudits } =
		await buildPlans();
	console.log(
		JSON.stringify(
			{
				mode: APPLY ? "apply" : "dry-run",
				exactSourceBackedLinks: plans.length,
				staleAuditLinks: staleAuditCount,
				unresolvedStaleAudits,
				canonicalIdentitiesToAdd: identityPlans.length,
				identityPlans: identityPlans.map((plan) => ({
					reservationId: id(plan.reservation._id),
					previousIdentityKey: plan.previousIdentityKey,
					otaIdentityKey: plan.otaIdentityKey,
					evidenceAuditIds: plan.evidenceAuditIds,
				})),
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
		reservations: identityPlans.map((plan) => plan.reservation),
	});
	console.log(`Before snapshot: ${beforeSnapshot}`);

	for (const plan of identityPlans) {
		const identityFilter = plan.previousIdentityKey
			? { otaIdentityKey: plan.previousIdentityKey }
			: {
					$or: [
						{ otaIdentityKey: { $exists: false } },
						{ otaIdentityKey: null },
						{ otaIdentityKey: "" },
					],
			  };
		// eslint-disable-next-line no-await-in-loop
		const identityResult = await Reservations.updateOne(
			{
				_id: plan.reservation._id,
				__v: Number(plan.reservation.__v || 0),
				...identityFilter,
			},
			{
				$set: { otaIdentityKey: plan.otaIdentityKey },
				$inc: { __v: 1 },
				$push: {
					reservationAuditLog: {
						at: new Date(),
						source: "ota-audit-link-repair",
						action: "canonical-ota-identity-added",
						by: SYSTEM_ACTOR,
						from: { otaIdentityKey: plan.previousIdentityKey },
						to: { otaIdentityKey: plan.otaIdentityKey },
						evidenceAuditIds: plan.evidenceAuditIds,
					},
				},
			}
		);
		if (identityResult.modifiedCount !== 1) {
			// eslint-disable-next-line no-await-in-loop
			const current = await Reservations.findById(plan.reservation._id)
				.select("otaIdentityKey")
				.lean();
			assert.equal(
				current?.otaIdentityKey,
				plan.otaIdentityKey,
				"reservation identity was concurrently changed"
			);
		}
	}

	for (const plan of plans) {
		// Every update uses an immutable audit _id and exact stored OTA identity.
		// eslint-disable-next-line no-await-in-loop
		await applyPlan(plan);
	}

	const afterAudits = await InboundEmail.find({ _id: { $in: auditIds } }).lean();
	const afterReservations = identityPlans.length
		? await Reservations.find({
				_id: { $in: identityPlans.map((plan) => plan.reservation._id) },
		  }).lean()
		: [];
	for (const plan of plans) {
		const audit = afterAudits.find((candidate) => id(candidate._id) === id(plan.audit._id));
		assert.equal(audit?.hasReservationConnection, true, "linked flag missing");
		assert.equal(
			id(audit?.reservationMongoId),
			id(plan.reservation._id),
			"linked reservation mismatch"
		);
	}
	for (const plan of identityPlans) {
		const reservation = afterReservations.find(
			(candidate) => id(candidate._id) === id(plan.reservation._id)
		);
		assert.equal(
			reservation?.otaIdentityKey,
			plan.otaIdentityKey,
			"canonical reservation identity missing after repair"
		);
	}
	const afterSnapshot = writeSnapshot("after", {
		createdAt: new Date(),
		beforeSnapshot,
		audits: afterAudits,
		reservations: afterReservations,
	});
	console.log(`After snapshot: ${afterSnapshot}`);
	console.log(
		JSON.stringify(
			{
				success: true,
				linkedAudits: plans.length,
				canonicalIdentitiesAdded: identityPlans.length,
			},
			null,
			2
		)
	);
}

main()
	.catch((error) => {
		console.error(error);
		process.exitCode = 1;
	})
	.finally(async () => {
		if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
	});
