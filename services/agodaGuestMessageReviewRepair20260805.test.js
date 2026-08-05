/** @format */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const {
	AUDITS,
	TARGET,
	buildRepairPlan,
	validateAuditSet,
	validateCurrentReservation,
	verifyRepairedDocument,
} = require("./agodaGuestMessageReviewRepair20260805");
const {
	applyRepair,
	buildBackupRecords,
	executeWriteWithHashReadback,
	parseArguments,
	readReservationAfterWrite,
	rollbackRepair,
	verifyBackupRecords,
} = require("../scripts/repairAgodaGuestMessageReview20260805");
const {
	canonicalEjsonSha256,
	cloneBson,
} = require("./tripHotelRunnerRepair20260805");

const objectId = (value) => new mongoose.Types.ObjectId(value);

const reservationFixture = () => ({
	_id: objectId(TARGET.mongoId),
	reservation_id: TARGET.otaConfirmation,
	confirmation_number: TARGET.pmsConfirmation,
	otaIdentityKey: TARGET.otaIdentityKey,
	booking_source: "agoda",
	hotelId: objectId(TARGET.hotelId),
	checkin_date: new Date(`${TARGET.checkinDate}T00:00:00.000Z`),
	checkout_date: new Date(`${TARGET.checkoutDate}T00:00:00.000Z`),
	total_amount: TARGET.guestTotalSar,
	sub_total: TARGET.hotelBaseTotalSar,
	commission: 0,
	state: "ota platform review",
	reservation_status: "ota platform review",
	pickedRoomsType: [
		{
			room_type: TARGET.roomType,
			hotelRoomConfigId: objectId(TARGET.roomConfigId),
			count: 1,
			pricingByDay: [
				{ date: "2026-08-14", clientPrice: 75.46, rootPrice: 75 },
				{ date: "2026-08-15", clientPrice: 75.46, rootPrice: 75 },
				{ date: "2026-08-16", clientPrice: 75.46, rootPrice: 75 },
			],
		},
	],
	pendingConfirmation: {
		status: "confirmed",
		confirmedAt: new Date(TARGET.confirmedAt),
		source: "ota_platform_release",
	},
	agentDecisionSnapshot: {
		status: "confirmed",
		decidedAt: new Date(TARGET.confirmedAt),
	},
	adminPricingVisibility: {
		rootOnlyForHotelManagement: true,
		source: "ota_email_update",
		appliedAt: new Date("2026-08-05T06:54:06.041Z"),
		appliedBy: null,
	},
	supplierData: {
		otaProvider: "agoda",
		otaConfirmationNumber: TARGET.otaConfirmation,
		otaTotalPayoutSar: TARGET.payoutSar,
		otaLastInboundEmailId: objectId(TARGET.offendingInboundId),
		otaLastEmailAt: new Date("2026-08-05T06:54:06.041Z"),
		otaLastEventType: "modified",
	},
	otaPlatformReview: {
		status: "pending",
		source: "ota_email_update",
		inboundEmailId: objectId(TARGET.offendingInboundId),
		provider: "agoda",
		confirmationNumber: TARGET.otaConfirmation,
		createdAt: new Date("2026-08-04T04:41:16.316Z"),
		releasedAt: new Date(TARGET.releasedAt),
		releasedBy: {
			_id: objectId("6553f1c6d06c5cea2f98a838"),
			name: "Management",
		},
		priceAtRelease: TARGET.hotelBaseTotalSar,
		lastUpdatedAt: new Date("2026-08-05T06:54:06.041Z"),
		proposedInbound: {
			inboundEmailId: objectId(TARGET.offendingInboundId),
			guest: { name: "H Gul", email: "garbage footer text" },
			room: { sourceName: "With Air Conditioning | 1" },
		},
	},
	reservationAuditLog: [
		{
			at: new Date("2026-08-04T04:58:54.098Z"),
			action: "released-to-hotel",
		},
		{
			at: new Date("2026-08-05T06:54:06.041Z"),
			action: "updated-existing-partial-from-email",
			messageId:
				"<87234350ece56b404b09ee28e5742951/d0264f0bb762fd2b410f3e416cac71b1@agoda-messaging.com>",
		},
	],
	customer_details: { name: "H Gul", confirmation_number2: TARGET.otaConfirmation },
	adminPricing: { clientTotal: TARGET.guestTotalSar, rootTotal: TARGET.hotelBaseTotalSar },
	updatedAt: new Date(TARGET.incidentUpdatedAt),
	createdAt: new Date("2026-08-04T04:41:16.422Z"),
	__v: TARGET.incidentVersion,
});

const auditsFixture = () =>
	AUDITS.map((expected) => ({
		_id: objectId(expected.id),
		provider: expected.provider,
		automationAction: expected.automationAction,
		skipReason: expected.skipReason,
		emailHash: expected.emailHash,
		textHash: expected.textHash,
		receivedAt: new Date(expected.receivedAt),
		processedAt: new Date(expected.processedAt),
		duplicateOf: expected.duplicateOf ? objectId(expected.duplicateOf) : null,
		confirmationNumber: TARGET.otaConfirmation,
		pmsConfirmationNumber: TARGET.pmsConfirmation,
		reservationMongoId: objectId(TARGET.mongoId),
	}));

const contextFixture = () => ({
	repairId: "agoda-20260805-unit-test",
	backupCollection: "ota_agoda_message_repair_backup_agoda-20260805-unit-test",
	repairAt: new Date("2026-08-05T08:00:00.000Z"),
	backupAt: new Date("2026-08-05T07:59:59.000Z"),
});

const sameValue = (left, right) => String(left ?? "") === String(right ?? "");
const matchesSimpleFilter = (document, filter = {}) =>
	Object.entries(filter).every(([key, value]) => sameValue(document?.[key], value));

const memoryCollection = (initialDocuments = [], { afterUpdate } = {}) => {
	const documents = new Map(
		initialDocuments.map((document) => [String(document._id), cloneBson(document)]),
	);
	return {
		documents,
		async findOne(filter = {}) {
			const found = [...documents.values()].find((document) =>
				matchesSimpleFilter(document, filter),
			);
			return found ? cloneBson(found) : null;
		},
		find() {
			return {
				sort() {
					return this;
				},
				async toArray() {
					return [...documents.values()].map(cloneBson);
				},
			};
		},
		async insertOne(document) {
			const key = String(document._id);
			if (documents.has(key)) {
				const error = new Error("duplicate key");
				error.code = 11000;
				throw error;
			}
			documents.set(key, cloneBson(document));
			return { insertedId: document._id };
		},
		async insertMany(nextDocuments) {
			for (const document of nextDocuments) {
				documents.set(String(document._id), cloneBson(document));
			}
			return { insertedCount: nextDocuments.length };
		},
		async updateOne(filter, update) {
			const entry = [...documents.entries()].find(([, document]) =>
				matchesSimpleFilter(document, filter),
			);
			if (!entry) return { matchedCount: 0, modifiedCount: 0 };
			const [key, document] = entry;
			Object.assign(document, cloneBson(update.$set || {}));
			documents.set(key, document);
			if (afterUpdate) await afterUpdate({ filter, update, document });
			return { matchedCount: 1, modifiedCount: 1 };
		},
	};
};

const maintenanceHarness = ({
	reservationWriteLostAck = false,
	rollbackWriteLostAck = false,
	manifestLostAckState = "",
} = {}) => {
	const reservation = reservationFixture();
	const audits = auditsFixture();
	const context = contextFixture();
	const plan = buildRepairPlan({ reservation, audits, context });
	let storedReservation = cloneBson(reservation);
	let updateLostAckPending = reservationWriteLostAck;
	let rollbackLostAckPending = rollbackWriteLostAck;
	let manifestLostAckPending = !!manifestLostAckState;
	const reservationCollection = {
		async findOne() {
			return cloneBson(storedReservation);
		},
		async updateOne() {
			assert.equal(canonicalEjsonSha256(storedReservation), plan.originalHash);
			storedReservation = cloneBson(plan.expectedDocument);
			if (updateLostAckPending) {
				updateLostAckPending = false;
				throw new Error("simulated reservation update acknowledgement loss");
			}
			return { matchedCount: 1, modifiedCount: 1 };
		},
		async replaceOne(_filter, replacement) {
			storedReservation = cloneBson(replacement);
			if (rollbackLostAckPending) {
				rollbackLostAckPending = false;
				throw new Error("simulated reservation replacement acknowledgement loss");
			}
			return { matchedCount: 1, modifiedCount: 1 };
		},
	};
	const inboundCollection = memoryCollection(audits);
	const manifestCollection = memoryCollection([], {
		afterUpdate: ({ update }) => {
			if (
				manifestLostAckPending &&
				update.$set?.state === manifestLostAckState
			) {
				manifestLostAckPending = false;
				throw new Error(`simulated ${manifestLostAckState} manifest acknowledgement loss`);
			}
		},
	});
	const collectionsByName = new Map([
		["ota_agoda_message_repair_manifests", manifestCollection],
	]);
	const db = {
		listCollections({ name }) {
			return {
				async toArray() {
					return collectionsByName.has(name) ? [{ name }] : [];
				},
			};
		},
		async createCollection(name) {
			assert.equal(collectionsByName.has(name), false);
			collectionsByName.set(name, memoryCollection());
		},
		collection(name) {
			const collection = collectionsByName.get(name);
			assert.ok(collection, `Missing memory collection ${name}`);
			return collection;
		},
	};
	return {
		audits,
		collections: {
			reservationCollection,
			inboundCollection,
			manifestCollection,
		},
		context,
		db,
		manifestCollection,
		plan,
		storedReservation: () => cloneBson(storedReservation),
	};
};

test("Agoda guest-message repair restores only proven workflow state", () => {
	const before = reservationFixture();
	const audits = auditsFixture();
	const context = contextFixture();
	const plan = buildRepairPlan({ reservation: before, audits, context });

	assert.equal(plan.expectedDocument.state, "confirmed");
	assert.equal(plan.expectedDocument.reservation_status, "confirmed");
	assert.equal(plan.expectedDocument.otaPlatformReview.status, "released");
	assert.equal(plan.expectedDocument.otaPlatformReview.proposedInbound, undefined);
	assert.equal(plan.expectedDocument.total_amount, TARGET.guestTotalSar);
	assert.equal(plan.expectedDocument.sub_total, TARGET.hotelBaseTotalSar);
	assert.equal(plan.expectedDocument.hotelId.toString(), TARGET.hotelId);
	assert.equal(
		plan.expectedDocument.pickedRoomsType[0].hotelRoomConfigId.toString(),
		TARGET.roomConfigId,
	);
	assert.equal(plan.expectedDocument.checkin_date.toISOString().slice(0, 10), TARGET.checkinDate);
	assert.equal(plan.expectedDocument.checkout_date.toISOString().slice(0, 10), TARGET.checkoutDate);
	assert.equal(plan.expectedDocument.__v, TARGET.incidentVersion + 1);
	assert.doesNotThrow(() =>
		verifyRepairedDocument({ before, after: plan.expectedDocument, context }),
	);
});

test("Agoda repair fails closed on identity, room, price, state, or audit drift", () => {
	for (const mutate of [
		(reservation) => (reservation.confirmation_number = "wrong"),
		(reservation) => (reservation.reservation_id = "wrong"),
		(reservation) => (reservation.hotelId = objectId("68da202900a070e8123c27c4")),
		(reservation) => (reservation.pickedRoomsType[0].room_type = "doubleRooms"),
		(reservation) => (reservation.total_amount = 1),
		(reservation) => (reservation.state = "confirmed"),
		(reservation) => (reservation.updatedAt = new Date("2026-08-05T06:54:07.000Z")),
	]) {
		const reservation = reservationFixture();
		mutate(reservation);
		assert.throws(() => validateCurrentReservation(reservation));
	}

	const changedAudit = auditsFixture();
	changedAudit[2].textHash = "0".repeat(64);
	assert.throws(() => validateAuditSet(changedAudit));
	assert.throws(() => validateAuditSet([...auditsFixture(), cloneBson(auditsFixture()[0])]));
});

test("Agoda repair backup contains one full reservation and four unchanged audits", () => {
	const reservation = reservationFixture();
	const audits = auditsFixture();
	const context = contextFixture();
	const plan = buildRepairPlan({ reservation, audits, context });
	const records = buildBackupRecords({ plan, audits, context });
	assert.equal(records.length, 5);
	assert.doesNotThrow(() => verifyBackupRecords({ records, context }));

	const corrupted = cloneBson(records);
	corrupted[1].originalDocument.textHash = "0".repeat(64);
	assert.throws(() => verifyBackupRecords({ records: corrupted, context }));
});

test("Agoda repair CLI requires every write interlock and never reuses implicit IDs", () => {
	assert.deepEqual(parseArguments([]), {
		apply: false,
		rollback: false,
		maintenanceWindow: false,
		repairId: "",
	});
	assert.throws(() => parseArguments(["--apply"]));
	assert.throws(() =>
		parseArguments(["--apply", "--repair-id", "agoda-test-1"]),
	);
	assert.deepEqual(
		parseArguments([
			"--apply",
			"--maintenance-window",
			"--repair-id",
			"agoda-test-1",
		]),
		{
			apply: true,
			rollback: false,
			maintenanceWindow: true,
			repairId: "agoda-test-1",
		},
	);
	assert.deepEqual(
		parseArguments(["--rollback", "--repair-id", "agoda-test-1"]),
		{
			apply: false,
			rollback: true,
			maintenanceWindow: false,
			repairId: "agoda-test-1",
		},
	);
	assert.throws(() => parseArguments(["--maintenance-window"]));
	assert.throws(() => parseArguments(["--unknown"]));
});

test("Agoda repair resolves a committed write whose acknowledgement was lost", async () => {
	const before = reservationFixture();
	const plan = buildRepairPlan({
		reservation: before,
		audits: auditsFixture(),
		context: contextFixture(),
	});
	let stored = cloneBson(before);
	const reservationCollection = {
		async findOne() {
			return cloneBson(stored);
		},
	};
	const result = await executeWriteWithHashReadback({
		reservationCollection,
		write: async () => {
			stored = cloneBson(plan.expectedDocument);
			throw new Error("simulated lost acknowledgement after commit");
		},
		beforeHash: plan.originalHash,
		afterHash: plan.expectedHash,
	});
	assert.equal(result.state, "after");
	assert.equal(result.acknowledgementLost, true);
	assert.equal(result.observedHash, plan.expectedHash);
});

test("Agoda repair distinguishes a rejected write from an ambiguous third state", async () => {
	const before = reservationFixture();
	const plan = buildRepairPlan({
		reservation: before,
		audits: auditsFixture(),
		context: contextFixture(),
	});
	let stored = cloneBson(before);
	const reservationCollection = {
		async findOne() {
			return cloneBson(stored);
		},
	};
	await assert.rejects(
		executeWriteWithHashReadback({
			reservationCollection,
			write: async () => {
				throw new Error("simulated clean rejection");
			},
			beforeHash: plan.originalHash,
			afterHash: plan.expectedHash,
		}),
		(error) => error.writeResolution === "before",
	);

	stored = cloneBson(before);
	stored.state = "unexpected concurrent state";
	assert.notEqual(canonicalEjsonSha256(stored), plan.originalHash);
	assert.notEqual(canonicalEjsonSha256(stored), plan.expectedHash);
	await assert.rejects(
		executeWriteWithHashReadback({
			reservationCollection,
			write: async () => {
				throw new Error("simulated ambiguous acknowledgement");
			},
			beforeHash: plan.originalHash,
			afterHash: plan.expectedHash,
		}),
		(error) => error.writeResolution === "unexpected",
	);
});

test("Agoda repair retries primary-majority readback after transient failures", async () => {
	const expected = reservationFixture();
	let attempts = 0;
	const reservationCollection = {
		async findOne() {
			attempts += 1;
			if (attempts < 3) throw new Error(`transient read ${attempts}`);
			return cloneBson(expected);
		},
	};
	const result = await readReservationAfterWrite({ reservationCollection });
	assert.equal(result._id.toString(), TARGET.mongoId);
	assert.equal(attempts, 3);
});

test("Agoda apply finalizes safely after reservation and manifest lost acknowledgements", async () => {
	for (const fault of [
		{ reservationWriteLostAck: true },
		{ manifestLostAckState: "applied" },
	]) {
		const harness = maintenanceHarness(fault);
		const result = await applyRepair({
			db: harness.db,
			collections: harness.collections,
			plan: harness.plan,
			audits: harness.audits,
			context: harness.context,
		});
		assert.equal(result.ok, true);
		assert.equal(result.writesPerformed, true);
		assert.equal(
			canonicalEjsonSha256(harness.storedReservation()),
			harness.plan.expectedHash,
		);
		const manifest = await harness.manifestCollection.findOne({
			_id: harness.context.repairId,
		});
		assert.equal(manifest.state, "applied");
		assert.equal(manifest.verifiedHash, harness.plan.expectedHash);
		assert.equal(
			harness.db.collection(harness.context.backupCollection).documents.size,
			5,
		);
	}
});

test("Agoda rollback finalizes safely after replacement and manifest lost acknowledgements", async () => {
	const harness = maintenanceHarness({
		rollbackWriteLostAck: true,
		manifestLostAckState: "rolled_back",
	});
	await applyRepair({
		db: harness.db,
		collections: harness.collections,
		plan: harness.plan,
		audits: harness.audits,
		context: harness.context,
	});
	const result = await rollbackRepair({
		db: harness.db,
		collections: harness.collections,
		args: {
			apply: true,
			rollback: true,
			maintenanceWindow: true,
			repairId: harness.context.repairId,
		},
	});
	assert.equal(result.ok, true);
	assert.equal(result.writesPerformed, true);
	assert.equal(
		canonicalEjsonSha256(harness.storedReservation()),
		harness.plan.originalHash,
	);
	const manifest = await harness.manifestCollection.findOne({
		_id: harness.context.repairId,
	});
	assert.equal(manifest.state, "rolled_back");
	assert.equal(manifest.verifiedOriginalHash, harness.plan.originalHash);
});
