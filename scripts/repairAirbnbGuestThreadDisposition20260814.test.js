/** @format */

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
	PROOF_MAX_AGE_MS,
	REPAIR_ID,
	applyPlan,
	buildPlan,
	parseArguments,
	parseProof,
	proofToken,
	sha256,
} = require("./repairAirbnbGuestThreadDisposition20260814");

const PLANNED_AT = new Date("2026-08-14T02:00:00.000Z");

const clone = (value) => structuredClone(value);

function fixture() {
	const subject = "RE: Reservation for Test Listing, Sep 1–6";
	const bodyText = [
		"RESERVATION FOR TEST LISTING, SEP 1–6",
		"Reply",
		"You can also respond by replying directly to this email.",
		"The guest could not confirm the trip.",
	].join("\n");
	const bodyHtml = "<div>Reply to this Airbnb conversation.</div>";
	const falseConfirmation = "for test listing, sep 1–6";
	const target = {
		auditId: "6a7e66ea79505aeca6506d15",
		repairId: REPAIR_ID,
		provider: "airbnb",
		source: "sendgrid",
		subject,
		falseConfirmation,
		emailHash: sha256("fixture-email"),
		textHash: sha256(bodyText),
		bodyHtmlHash: sha256(bodyHtml),
		dedupeKey: `mid:${sha256("fixture-message")}`,
		version: 0,
		createdAt: "2026-08-14T00:52:58.681Z",
		updatedAt: "2026-08-14T00:53:11.132Z",
		receivedAt: "2026-08-14T00:52:58.656Z",
		processedAt: "2026-08-14T00:53:10.808Z",
	};
	const audit = {
		_id: target.auditId,
		__v: target.version,
		createdAt: new Date(target.createdAt),
		updatedAt: new Date(target.updatedAt),
		receivedAt: new Date(target.receivedAt),
		processedAt: new Date(target.processedAt),
		source: target.source,
		provider: target.provider,
		from: '"Airbnb" <express@airbnb.com>',
		subject,
		bodyText,
		bodyHtml,
		emailHash: target.emailHash,
		textHash: target.textHash,
		dedupeKey: target.dedupeKey,
		duplicateOf: null,
		confirmationNumber: falseConfirmation,
		intent: "new_reservation",
		eventType: "unknown",
		processingStatus: "needs_mapping",
		automationAction: "skipped",
		skipReason: "ota_mapping_required_no_reservation_created",
		hasReservationConnection: false,
		matchedReservationBy: [],
		reservationMongoId: null,
		hotelId: null,
		senderAuthentication: {
			authenticatedAligned: true,
			trustedProvider: "airbnb",
			fromDomain: "airbnb.com",
			method: "dkim",
			alignedDkimPassDomains: ["express.airbnb.com"],
		},
		normalizedReservation: {
			provider: "airbnb",
			intent: "new_reservation",
			eventType: "unknown",
			confirmationNumber: falseConfirmation,
			sourceSenderAuthenticated: true,
		},
		reconciliation: {
			status: "needs_mapping",
			actionTaken: "skipped",
			skipReason: "ota_mapping_required_no_reservation_created",
			reservationId: null,
		},
	};
	return { audit, target };
}

function setPath(object, dottedPath, value) {
	const parts = dottedPath.split(".");
	let cursor = object;
	for (const part of parts.slice(0, -1)) {
		if (!cursor[part] || typeof cursor[part] !== "object") cursor[part] = {};
		cursor = cursor[part];
	}
	cursor[parts.at(-1)] = clone(value);
}

function dependenciesFor(initialAudit, { reservationMatches = [] } = {}) {
	let current = clone(initialAudit);
	const calls = { findReservationMatches: 0, casArchive: [] };
	return {
		calls,
		get current() {
			return clone(current);
		},
		findArchiveById: async () => clone(current),
		findReservationMatches: async () => {
			calls.findReservationMatches += 1;
			return clone(reservationMatches);
		},
		casArchive: async (filter, update, options) => {
			calls.casArchive.push(clone({ filter, update, options }));
			for (const [path, value] of Object.entries(update.$set || {})) {
				setPath(current, path, value);
			}
			current.__v += Number(update.$inc?.__v || 0);
			current.updatedAt = new Date(PLANNED_AT);
			return { matchedCount: 1, modifiedCount: 1 };
		},
	};
}

test("CLI is dry-run by default and apply requires exact immutable approval", () => {
	assert.deepEqual(parseArguments([]), { apply: false, repairId: "", proof: "" });
	assert.throws(
		() => parseArguments(["--apply", `--repair-id=${REPAIR_ID}`]),
		/exact fresh proof/,
	);
	assert.throws(
		() => parseArguments(["--apply", "--repair-id=wrong", `--proof=${PLANNED_AT.getTime()}.${"a".repeat(64)}`]),
		/new-reservation|requires --repair-id|--apply requires/,
	);
	assert.throws(() => parseArguments(["--proof=x"]), /only with --apply/);
	assert.throws(() => parseArguments(["--unexpected"]), /Unknown argument/);
});

test("fresh proof parsing rejects stale and future review tokens", () => {
	const token = `${PLANNED_AT.getTime()}.${"a".repeat(64)}`;
	assert.equal(parseProof(token, new Date(PLANNED_AT.getTime() + 1)).scopeHash, "a".repeat(64));
	assert.throws(
		() => parseProof(token, new Date(PLANNED_AT.getTime() + PROOF_MAX_AGE_MS + 1)),
		/expired/,
	);
	assert.throws(() => parseProof(token, new Date(PLANNED_AT.getTime() - 5_001)), /future/);
});

test("plan proves the authenticated terminal classifier and zero Reservation matches", async () => {
	const { audit, target } = fixture();
	const dependencies = dependenciesFor(audit);
	const plan = await buildPlan(PLANNED_AT, dependencies, target);
	assert.equal(plan.classification.reason, "airbnb_guest_message");
	assert.equal(plan.classification.intent, "not_reservation");
	assert.deepEqual(plan.classification.evidence, [
		"authenticated_airbnb_sender",
		"reservation_thread_reply_subject_without_identity",
	]);
	assert.equal(plan.reservationMatchCount, 0);
	assert.equal(plan.proof, proofToken(plan));
	assert.match(plan.proof, /^\d{13}\.[a-f0-9]{64}$/);
	assert.equal(dependencies.calls.casArchive.length, 0, "dry plan must not write");
	const reservationLinkPaths = plan.reservationQuery.$or
		.flatMap((clause) => Object.keys(clause))
		.filter((path) => path.toLowerCase().includes("inboundemailid"));
	assert.deepEqual(reservationLinkPaths, [
		"supplierData.otaInboundEmailId",
		"supplierData.otaLastInboundEmailId",
		"supplierData.otaCommercialEvidence.inboundEmailId",
		"otaPlatformReview.inboundEmailId",
		"otaPlatformReview.proposedInbound.inboundEmailId",
	]);
});

test("preflight fails closed for a linked or identity-matched Reservation", async () => {
	const { audit, target } = fixture();
	await assert.rejects(
		buildPlan(
			PLANNED_AT,
			dependenciesFor(audit, { reservationMatches: [{ _id: "reservation" }] }),
			target,
		),
		(error) => error.code === "AIRBNB_DISPOSITION_RESERVATION_MATCHED",
	);
	const linked = clone(audit);
	linked.reservationMongoId = "6a7e6ab079505aeca6507358";
	linked.hasReservationConnection = true;
	await assert.rejects(
		buildPlan(PLANNED_AT, dependenciesFor(linked), target),
		(error) => error.code === "AIRBNB_DISPOSITION_RESERVATION_LINKED",
	);
});

test("preflight fails closed if source bodies/hashes or classifier evidence changes", async () => {
	const { audit, target } = fixture();
	const bodyChanged = clone(audit);
	bodyChanged.bodyText += " changed";
	await assert.rejects(
		buildPlan(PLANNED_AT, dependenciesFor(bodyChanged), target),
		(error) => error.code === "AIRBNB_DISPOSITION_BODY_CHANGED",
	);
	const lifecycleMail = clone(audit);
	lifecycleMail.bodyText += "\nConfirmation code HM2D9NPR35";
	lifecycleMail.textHash = sha256(lifecycleMail.bodyText);
	const lifecycleTarget = { ...target, textHash: lifecycleMail.textHash };
	await assert.rejects(
		buildPlan(PLANNED_AT, dependenciesFor(lifecycleMail), lifecycleTarget),
		(error) => error.code === "AIRBNB_DISPOSITION_CLASSIFIER_NOT_PROVEN",
	);
});

test("apply performs one exact archive CAS, preserves bodies, and never writes Reservations", async () => {
	const { audit, target } = fixture();
	const dependencies = dependenciesFor(audit);
	const plan = await buildPlan(PLANNED_AT, dependencies, target);
	const beforeText = audit.bodyText;
	const beforeHtml = audit.bodyHtml;
	const result = await applyPlan(plan, dependencies, target);
	assert.equal(result.reservationMutationCount, 0);
	assert.equal(dependencies.calls.casArchive.length, 1);
	assert.equal(dependencies.calls.findReservationMatches, 2, "pre/post absence proof required");
	const { filter, update, options } = dependencies.calls.casArchive[0];
	assert.equal(filter._id, target.auditId);
	assert.equal(filter.__v, 0);
	assert.equal(filter.emailHash, target.emailHash);
	assert.equal(filter.textHash, target.textHash);
	assert.equal(filter.subject, target.subject);
	assert.equal(filter.bodyText, beforeText);
	assert.equal(filter.bodyHtml, beforeHtml);
	assert.equal(filter.processingStatus, "needs_mapping");
	assert.equal(filter.reservationMongoId, null);
	assert.equal(filter["senderAuthentication.authenticatedAligned"], true);
	assert.deepEqual(update.$inc, { __v: 1 });
	assert.equal(update.$set.intent, "not_reservation");
	assert.equal(update.$set.processingStatus, "not_reservation");
	assert.equal(update.$set.skipReason, "airbnb_guest_message");
	assert.equal(update.$set["normalizedReservation.intent"], "not_reservation");
	assert.equal(update.$set["reconciliation.status"], "not_reservation");
	assert.equal(update.$set["reconciliation.dispositionRepair"].reservationMutationCount, 0);
	assert.equal(
		update.$set["reconciliation.dispositionRepair"].bodyTextHash,
		target.textHash,
	);
	assert.equal(
		update.$set["reconciliation.dispositionRepair"].bodyHtmlHash,
		target.bodyHtmlHash,
	);
	assert.equal(update.$unset, undefined);
	assert.equal(Object.keys(update.$set).some((key) => /^body(?:Text|Html)$/.test(key)), false);
	assert.deepEqual(options.writeConcern, { w: "majority" });
	assert.equal(dependencies.current.bodyText, beforeText);
	assert.equal(dependencies.current.bodyHtml, beforeHtml);
	assert.equal(dependencies.current.confirmationNumber, target.falseConfirmation);
	assert.equal(dependencies.current.processedAt.toISOString(), target.processedAt);
});

test("lost acknowledgement is hash-verified once and a rerun is an exact zero-write no-op", async () => {
	const { audit, target } = fixture();
	const dependencies = dependenciesFor(audit);
	const originalCas = dependencies.casArchive;
	dependencies.casArchive = async (...args) => {
		await originalCas(...args);
		throw new Error("simulated lost acknowledgement");
	};
	const firstPlan = await buildPlan(PLANNED_AT, dependencies, target);
	const recovered = await applyPlan(firstPlan, dependencies, target);
	assert.equal(recovered.action, "lost_ack_recovered");
	assert.equal(dependencies.calls.casArchive.length, 1);

	const rerunAt = new Date(PLANNED_AT.getTime() + 60_000);
	const rerunPlan = await buildPlan(rerunAt, dependencies, target);
	assert.equal(rerunPlan.action, "already_applied_noop");
	assert.equal(rerunPlan.set["reconciliation.dispositionRepair"].repairId, REPAIR_ID);
	assert.equal(
		new Date(
			rerunPlan.set["reconciliation.dispositionRepair"].appliedAt,
		).toISOString(),
		PLANNED_AT.toISOString(),
	);
	const rerun = await applyPlan(rerunPlan, dependencies, target);
	assert.equal(rerun.action, "already_applied_noop");
	assert.equal(dependencies.calls.casArchive.length, 1, "rerun must not issue a second CAS");
	assert.equal(dependencies.current.bodyText, audit.bodyText);
	assert.equal(dependencies.current.bodyHtml, audit.bodyHtml);
});

test("already-applied recognition rejects marker, body, or disposition drift", async () => {
	const { audit, target } = fixture();
	const dependencies = dependenciesFor(audit);
	const plan = await buildPlan(PLANNED_AT, dependencies, target);
	await applyPlan(plan, dependencies, target);

	for (const [label, mutate] of [
		[
			"marker",
			(current) => {
				current.reconciliation.dispositionRepair.bodyHtmlHash = "0".repeat(64);
			},
		],
		["body", (current) => (current.bodyHtml = "changed")],
		["disposition", (current) => (current.processingStatus = "needs_review")],
	]) {
		const tampered = clone(dependencies.current);
		mutate(tampered);
		await assert.rejects(
			buildPlan(
				new Date(PLANNED_AT.getTime() + 60_000),
				dependenciesFor(tampered),
				target,
			),
			(error) =>
				[
					"AIRBNB_DISPOSITION_APPLIED_STATE_INVALID",
					"AIRBNB_DISPOSITION_BODY_CHANGED",
				].includes(error.code),
			label,
		);
	}
});

test("a lost archive CAS fails without attempting a second mutation", async () => {
	const { audit, target } = fixture();
	const dependencies = dependenciesFor(audit);
	dependencies.casArchive = async () => {
		dependencies.calls.casArchive.push({});
		return { matchedCount: 0, modifiedCount: 0 };
	};
	const plan = await buildPlan(PLANNED_AT, dependencies, target);
	await assert.rejects(
		applyPlan(plan, dependencies, target),
		(error) => error.code === "AIRBNB_DISPOSITION_CAS_LOST",
	);
	assert.equal(dependencies.calls.casArchive.length, 1);
});

test("the utility contains no Reservation mutation surface", () => {
	const source = fs.readFileSync(
		path.join(__dirname, "repairAirbnbGuestThreadDisposition20260814.js"),
		"utf8",
	);
	assert.doesNotMatch(
		source,
		/Reservations\s*\.\s*(?:updateOne|updateMany|findOneAndUpdate|replaceOne|deleteOne|deleteMany|create|insertMany|bulkWrite)\s*\(/,
	);
	assert.match(source, /Reservations\.find\(query\)\.select\("_id"\)\.limit\(2\)/);
});
