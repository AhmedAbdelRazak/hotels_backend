"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");

const {
	MANIFEST_COLLECTION,
	TARGETS,
	applyUpdateToDocument,
	applyPlanToScope,
	buildRecoveryPlan,
	buildExactCasFilter,
	canonicalEjsonSha256,
	canonicalEqual,
	cloneBson,
} = require("../services/recentOtaInboundRecovery20260805");
const {
	applyRepair,
	assertManifestFence,
	buildAuditMatchQuery,
	buildBackupRecordsForPlan,
	buildManifestDocument,
	buildPlanContext,
	compensateRollback,
	executeDocumentWriteWithHashReadback,
	main,
	parseArguments,
	planHash,
	rollbackRepair,
	transitionManifest,
	verifyBackupReadback,
} = require("./repairRecentOtaInbound20260805");

const objectId = (value) => new mongoose.Types.ObjectId(value);

const makePlan = () => {
	const context = buildPlanContext({
		repairAt: "2026-08-05T13:00:00.000Z",
		repairId: "unit-hotel-2038704202-a",
	});
	const originalDocument = { _id: objectId("6a7329da39b444f30248e8a1"), __v: 0, state: "ota platform review" };
	const expectedDocument = { _id: originalDocument._id, __v: 1, state: "ota platform review" };
	const auditDocument = {
		_id: objectId("6a7329d739b444f30248e89a"),
		emailHash: "a".repeat(64),
		processingStatus: "created",
	};
	const hotelDocument = {
		_id: objectId("6a40b6a1a6efe70450536038"),
		activateHotel: true,
		hotelName: "Zad Ajyad",
	};
	const documentPlan = {
		casFilter: buildExactCasFilter(originalDocument),
		casFilterHash: canonicalEjsonSha256(buildExactCasFilter(originalDocument)),
		collection: "reservations",
		documentId: String(originalDocument._id),
		expectedDocument,
		expectedHash: canonicalEjsonSha256(expectedDocument),
		originalDocument,
		originalHash: canonicalEjsonSha256(originalDocument),
		role: "hotel_assignment_reservation",
		update: { $inc: { __v: 1 } },
	};
	return {
		context,
		documentPlans: [documentPlan],
		hotelEvidence: {
			document: hotelDocument,
			hash: canonicalEjsonSha256(hotelDocument),
		},
		immutableEvidence: [{
			collection: "inboundemails",
			documentId: String(auditDocument._id),
			evidenceHash: canonicalEjsonSha256(auditDocument),
			originalDocument: auditDocument,
			originalHash: canonicalEjsonSha256(auditDocument),
			role: "source_evidence",
		}],
		operation: "recent_ota_inbound_recovery_20260805",
		targetKey: "agoda_hotel_2038704202",
	};
};

const INTEGRATION_TARGET_KEY = "trip_pricing_1433813442496171";
const INTEGRATION_REPAIR_AT = "2026-08-05T13:00:00.000Z";

const paymentBreakdown = (amount, comment) => ({
	paid_online_via_link: 0,
	paid_at_hotel_cash: 0,
	paid_at_hotel_card: 0,
	paid_to_hotel: 0,
	paid_online_jannatbooking: 0,
	paid_online_other_platforms: amount,
	paid_online_via_instapay: 0,
	paid_no_show: 0,
	payment_comments: comment,
});

const emptyProcessors = () => ({
	payment_details: { captured: false, onsite_paid_amount: 0 },
	vcc_payment: {
		source: "",
		charged: false,
		processing: false,
		charge_count: 0,
		attempts_count: 0,
		total_captured_sar: 0,
		total_captured_usd: 0,
		last_capture: {},
		attempts: [],
	},
	bofa_payment: {
		secure_acceptance: {
			status: "not_started",
			currency: "USD",
			transaction_type: "sale",
			callbacks: [],
		},
		vcc: {
			charged: false,
			processing: false,
			charge_count: 0,
			attempts_count: 0,
			failed_attempts_count: 0,
			total_captured_sar: 0,
			total_captured_usd: 0,
			last_capture: {},
			attempts: [],
		},
	},
	braintree_payment: {},
	paypal_details: {},
	moneyTransferredToHotel: false,
	commissionPaid: false,
	adminChangeLog: [],
});

const pricingReservationFixture = () => {
	const target = TARGETS[INTEGRATION_TARGET_KEY];
	const room = {
		room_type: target.roomType,
		displayName: "Double Room - Comfort & Relaxation",
		hotelRoomConfigId: objectId(target.roomConfigId),
		sourceRoomName: "Source double room",
		otaRoomMatchType: "explicit_capacity",
		otaRoomMatchScore: 0.98,
		chosenPrice: target.old.chosenPrice,
		count: 1,
		pricingByDay: target.daily.map((day) => ({
			date: day.date,
			price: target.old.clientSar / target.nights,
			clientPrice: target.old.clientSar / target.nights,
			mainPrice: target.old.clientSar / target.nights,
			rootPrice: day.root,
			commissionRate: 20,
			totalPriceWithCommission: target.old.clientSar / target.nights,
			totalPriceWithoutCommission: day.root,
			netAfterExpenses: target.old.payoutSar / target.nights,
			netAfterOtaExpenses: target.old.payoutSar / target.nights,
			otaExpenseAmount: target.old.expenseSar / target.nights,
			platformMargin: target.old.marginSar / target.nights,
		})),
		totalPriceWithCommission: target.old.clientSar,
		hotelShouldGet: target.old.rootSar,
	};
	const sourcePayment = {
		sourceCurrency: target.currency,
		sourceTotalGuestPaymentAmount: target.old.sourceAmount,
		totalGuestPaymentAmount: target.old.clientSar,
		currency: "SAR",
		exchangeRateToSar: target.exchangeRate,
		exchangeRateSource: "fallback_default",
		amountConvertedAt: new Date("2026-08-05T11:54:04.714Z"),
	};
	return {
		_id: objectId(target.mongoId),
		reservation_id: target.otaConfirmation,
		confirmation_number: target.pmsConfirmation,
		otaIdentityKey: target.otaIdentityKey,
		otaCrossTransportIdentityKey: target.crossTransportIdentityKey,
		booking_source: target.bookingSource,
		customer_details: {
			confirmation_number2: target.otaConfirmation,
			booking_source: target.providerLabel,
			name: "Fixture guest",
		},
		hotelId: objectId(target.hotelId),
		belongsTo: objectId(target.ownerId),
		checkin_date: new Date(`${target.checkinDate}T00:00:00.000Z`),
		checkout_date: new Date(`${target.checkoutDate}T00:00:00.000Z`),
		booked_at: new Date("2026-08-05T00:00:00.000Z"),
		roomId: [],
		pickedRoomsType: [cloneBson(room)],
		pickedRoomsPricing: [cloneBson(room)],
		total_rooms: 1,
		days_of_residence: target.nights,
		state: "ota platform review",
		reservation_status: "ota platform review",
		total_amount: target.old.clientSar,
		paid_amount: target.old.clientSar,
		paid_amount_breakdown: paymentBreakdown(target.old.clientSar, target.paymentComment),
		sub_total: target.old.rootSar,
		commission: target.old.commissionSar,
		payment: "paid online",
		financeStatus: "paid online",
		adminPricing: {
			mode: "ota_platform_sync",
			clientTotal: target.old.clientSar,
			rootTotal: target.old.rootSar,
			netAfterExpensesTotal: target.old.payoutSar,
			otaExpenseTotal: target.old.expenseSar,
			platformMarginTotal: target.old.marginSar,
			commissionAmount: target.old.commissionSar,
			defaultDeductionRate: 0.2,
			defaultDeductionApplied: true,
			source: "ota_email_create",
			provider: target.transportProvider,
			providerLabel: target.providerLabel,
			sourceCurrency: target.currency,
			sourceAmount: target.old.sourceAmount,
			sourceExchangeRateToSar: target.exchangeRate,
			sourceExchangeRateSource: "fallback_default",
		},
		ota_financial_summary: {
			show: true,
			source: "ota_email_create",
			provider: target.transportProvider,
			providerLabel: target.providerLabel,
			currency: "SAR",
			clientTotal: target.old.clientSar,
			hotelVisibleAmount: target.old.rootSar,
			netAfterExpenses: target.old.payoutSar,
			netAfterOtaExpenses: target.old.payoutSar,
			otaExpenseTotal: target.old.expenseSar,
			platformProfit: target.old.marginSar,
			commissionAmount: target.old.commissionSar,
			sourceCurrency: target.currency,
			sourceAmount: target.old.sourceAmount,
			paymentSummary: cloneBson(sourcePayment),
		},
		supplierData: {
			suppliedBookingNo: target.otaConfirmation,
			otaConfirmationNumber: target.otaConfirmation,
			platformConfirmationNumber: target.otaConfirmation,
			pmsConfirmationNumber: target.pmsConfirmation,
			supplierName: target.providerLabel,
			otaProvider: target.transportProvider,
			otaSourceAuthority: 1,
			otaAmount: target.old.sourceAmount,
			otaAmountSar: target.old.clientSar,
			otaSourceAmount: target.old.sourceAmount,
			otaSourceCurrency: target.currency,
			otaPaymentSummary: cloneBson(sourcePayment),
			otaTotalPayoutSar: target.old.payoutSar,
			otaExpenseTotalSar: target.old.expenseSar,
			otaPlatformMarginSar: target.old.marginSar,
			otaPaymentCollectionModel: "ota_collect",
			otaPaymentInstructions: "old relay instructions",
			otaLastInboundEmailId: target.audits[0].id,
			otaLastEmailAt: new Date("2026-08-05T12:00:00.000Z"),
			otaLastSourceReceivedAt: new Date(target.relayWatermark),
			otaLastEventType: "new",
		},
		otaPlatformReview: {
			status: "pending",
			source: "ota_email_create",
			inboundEmailId: target.audits[0].id,
			provider: target.transportProvider,
			providerLabel: target.providerLabel,
			confirmationNumber: target.otaConfirmation,
		},
		financial_cycle: {
			collectionModel: "pms_collected",
			status: "open",
			commissionType: "amount",
			commissionValue: target.old.commissionSar,
			commissionAmount: target.old.commissionSar,
			commissionAssigned: false,
			commissionAssignedAt: null,
			commissionAssignedBy: null,
			pmsCollectedAmount: target.old.clientSar,
			hotelCollectedAmount: 0,
			hotelPayoutDue: target.old.rootSar,
			commissionDueToPms: 0,
			closedAt: null,
			closedBy: null,
		},
		availabilitySnapshot: { captured: true, immutableMarker: INTEGRATION_TARGET_KEY },
		reservationAuditLog: [{ action: "created", at: new Date("2026-08-05T12:00:00.000Z") }],
		...emptyProcessors(),
		updatedAt: new Date("2026-08-05T12:00:00.000Z"),
		__v: target.expectedVersion,
	};
};

const pricingAuditFixture = (expected) => {
	const target = TARGETS[INTEGRATION_TARGET_KEY];
	const direct = expected.role === "authoritative_direct_pricing";
	const normalized = {
		provider: expected.provider,
		providerLabel: expected.provider === "trip" ? "Trip.com" : "HotelRunner",
		sourceSenderTrusted: true,
		sourceSenderAuthenticated: true,
		intent: "new_reservation",
		eventType: "new",
		statusToApply: "",
		confirmationNumber: target.otaConfirmation,
		hotelName: "Zad Ajyad",
		roomName: "Source room wording",
		checkinDate: target.checkinDate,
		checkoutDate: target.checkoutDate,
		amount: direct ? target.corrected.clientSource : target.old.sourceAmount,
		currency: target.currency,
		totalAmountSar: direct ? target.corrected.clientSar : target.old.clientSar,
		totalPayoutSar: direct ? target.corrected.payoutSar : 0,
		paymentCollectionModel: "ota_collect",
		paymentInstructions: direct ? target.paymentInstructions : "relay instructions",
		source: {
			receivedAt: new Date(expected.sourceReceivedAt),
			immutableSourceMarker: expected.id,
		},
	};
	if (direct) {
		normalized.sourceCurrency = target.currency;
		normalized.exchangeRateToSar = target.exchangeRate;
		normalized.exchangeRateSource = target.exchangeRateSource;
		normalized.amountConvertedAt = new Date(target.amountConvertedAt);
		normalized.paymentSummary = {
			sourceCurrency: target.currency,
			sourceTotalGuestPaymentAmount: target.corrected.clientSource,
			sourceTotalPayoutAmount: target.corrected.payoutSource,
			totalGuestPaymentAmount: target.corrected.clientSar,
			totalPayoutAmount: target.corrected.payoutSar,
			currency: "SAR",
			exchangeRateToSar: target.exchangeRate,
			exchangeRateSource: target.exchangeRateSource,
			amountConvertedAt: new Date(target.amountConvertedAt),
		};
	}
	const reconciliation = {
		status: expected.processingStatus,
		actionTaken: expected.automationAction,
		skipReason: expected.skipReason,
		automationComment: "Original outcome",
		warnings: [],
		errors: expected.skipReason ? ["Original review reason"] : [],
		reservationId: objectId(target.mongoId),
		hotelId: objectId(target.hotelId),
		pmsConfirmationNumber: target.pmsConfirmation,
		matchedReservationBy: direct ? ["otaIdentityKey", "reservation_id"] : [],
	};
	return {
		_id: objectId(expected.id),
		source: "sendgrid",
		provider: expected.provider,
		providerLabel: normalized.providerLabel,
		intent: normalized.intent,
		eventType: normalized.eventType,
		processingStatus: expected.processingStatus,
		automationAction: expected.automationAction,
		skipReason: expected.skipReason,
		automationComment: "Original outcome",
		hasReservationConnection: true,
		matchedReservationBy: cloneBson(reconciliation.matchedReservationBy),
		from: `${expected.provider}@example.invalid`,
		to: "ota@example.invalid",
		subject: `Fixture ${expected.id}`,
		messageId: `<${expected.id}@fixture.invalid>`,
		emailHash: expected.emailHash,
		textHash: expected.textHash,
		dedupeKey: `fixture:${expected.id}`,
		bodyText: `Immutable body ${expected.id}`,
		bodyHtml: `<p>Immutable body ${expected.id}</p>`,
		safeSnippet: `Immutable snippet ${expected.id}`,
		attachments: [],
		senderAuthentication: {
			authenticatedAligned: true,
			trustedProvider: expected.trustedProvider,
			method: expected.trustedProvider === "hotelrunner" ? "spf+dkim" : "dkim",
		},
		confirmationNumber: target.otaConfirmation,
		pmsConfirmationNumber: target.pmsConfirmation,
		hotelName: normalized.hotelName,
		roomName: normalized.roomName,
		sourceAmount: normalized.amount,
		sourceCurrency: normalized.currency,
		totalAmountSar: normalized.totalAmountSar,
		paymentCollectionModel: normalized.paymentCollectionModel,
		hotelId: objectId(target.hotelId),
		reservationMongoId: objectId(target.mongoId),
		normalizedReservation: normalized,
		emailContext: { forwarded: false, immutableContextMarker: expected.id },
		orchestratorDecision: { usedAI: false, immutableDecisionMarker: expected.id },
		reconciliation,
		forwardDecision: { shouldForward: true, immutableForwardMarker: expected.id },
		forwarding: { status: "sent", immutableForwardingMarker: expected.id },
		parseWarnings: [],
		parseErrors: [],
		reconcileWarnings: [],
		reconcileErrors: expected.skipReason ? ["Original review reason"] : [],
		receivedAt: new Date("2026-08-05T12:00:00.000Z"),
		processedAt: new Date("2026-08-05T12:00:02.000Z"),
		createdAt: new Date("2026-08-05T12:00:00.100Z"),
		updatedAt: new Date("2026-08-05T12:00:03.000Z"),
		__v: 0,
	};
};

const integrationSourceDocuments = () => {
	const target = TARGETS[INTEGRATION_TARGET_KEY];
	return {
		reservation: pricingReservationFixture(),
		audits: target.audits.map(pricingAuditFixture),
	};
};

const valueAtPath = (document, path) => String(path)
	.split(".")
	.reduce((current, key) => (current == null ? undefined : current[key]), document);

const matchesCondition = (actual, condition) => {
	if (condition && typeof condition === "object" && !Array.isArray(condition)) {
		const operatorKeys = Object.keys(condition).filter((key) => key.startsWith("$"));
		if (operatorKeys.length) {
			for (const operator of operatorKeys) {
				if (operator === "$in") {
					if (!condition.$in.some((candidate) => canonicalEqual(actual, candidate))) return false;
				} else if (operator === "$exists") {
					if ((actual !== undefined) !== Boolean(condition.$exists)) return false;
				} else if (operator === "$ne") {
					if (canonicalEqual(actual, condition.$ne)) return false;
				} else {
					throw new Error(`Unsupported fake Mongo operator ${operator}`);
				}
			}
			return true;
		}
	}
	return canonicalEqual(actual, condition);
};

const matchesFilter = (document, filter = {}) => {
	if (!document) return false;
	for (const [path, condition] of Object.entries(filter || {})) {
		if (path === "$and") {
			if (!condition.every((entry) => matchesFilter(document, entry))) return false;
			continue;
		}
		if (path === "$or") {
			if (!condition.some((entry) => matchesFilter(document, entry))) return false;
			continue;
		}
		if (path === "$expr") {
			const operands = condition?.$eq || [];
			const expectedSize = operands[1];
			if (operands[0]?.$size?.$objectToArray !== "$$ROOT" || Object.keys(document).length !== expectedSize) {
				return false;
			}
			continue;
		}
		if (!matchesCondition(valueAtPath(document, path), condition)) return false;
	}
	return true;
};

class FakeCursor {
	constructor(documents, db, options) {
		this.documents = documents;
		this.db = db;
		this.options = options;
		this.sortSpec = null;
	}

	sort(spec) {
		this.sortSpec = spec;
		return this;
	}

	async toArray() {
		this.db.readOptions.push(cloneBson(this.options || {}));
		const values = this.documents.map(cloneBson);
		if (this.sortSpec) {
			const entries = Object.entries(this.sortSpec);
			values.sort((left, right) => {
				for (const [path, direction] of entries) {
					const a = valueAtPath(left, path);
					const b = valueAtPath(right, path);
					const av = a instanceof Date ? a.getTime() : String(a ?? "");
					const bv = b instanceof Date ? b.getTime() : String(b ?? "");
					if (av < bv) return -1 * direction;
					if (av > bv) return 1 * direction;
				}
				return 0;
			});
		}
		return values;
	}
}

class FakeCollection {
	constructor(db, name) {
		this.db = db;
		this.name = name;
		this.documents = new Map();
	}

	key(value) {
		return String(value?._id || value);
	}

	seed(documents = []) {
		for (const document of documents) {
			this.documents.set(this.key(document), cloneBson(document));
		}
	}

	all() {
		return [...this.documents.values()].map(cloneBson);
	}

	set(document) {
		this.documents.set(this.key(document), cloneBson(document));
	}

	async findOne(filter, options = {}) {
		this.db.readOptions.push(cloneBson(options));
		const hook = await this.db.invoke("beforeFindOne", {
			collection: this.name,
			filter: cloneBson(filter),
		});
		if (hook?.throw) throw hook.throw;
		const found = [...this.documents.values()].find((document) => matchesFilter(document, filter));
		return found ? cloneBson(found) : null;
	}

	find(filter, options = {}) {
		const found = [...this.documents.values()].filter((document) => matchesFilter(document, filter));
		return new FakeCursor(found, this.db, options);
	}

	async insertOne(document, options = {}) {
		return this.write("insertOne", document, options, async () => {
			const key = this.key(document);
			if (this.documents.has(key)) {
				const error = new Error("duplicate key");
				error.code = 11000;
				throw error;
			}
			this.set(document);
			return { acknowledged: true, insertedId: document._id };
		});
	}

	async insertMany(documents, options = {}) {
		return this.write("insertMany", documents, options, async () => {
			for (const document of documents) {
				if (this.documents.has(this.key(document))) throw new Error("duplicate key");
			}
			for (const document of documents) this.set(document);
			return { acknowledged: true, insertedCount: documents.length };
		});
	}

	async updateOne(filter, update, options = {}) {
		return this.write("updateOne", { filter, update }, options, async (hook) => {
			if (hook?.reject) return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
			const current = [...this.documents.values()].find((document) => matchesFilter(document, filter));
			if (!current) return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
			this.set(applyUpdateToDocument(current, update));
			return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
		});
	}

	async replaceOne(filter, replacement, options = {}) {
		return this.write("replaceOne", { filter, replacement }, options, async (hook) => {
			if (hook?.reject) return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
			const current = [...this.documents.values()].find((document) => matchesFilter(document, filter));
			if (!current) return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
			this.documents.delete(this.key(current));
			this.set(replacement);
			return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
		});
	}

	async write(kind, payload, options, commit) {
		this.db.writeOptions.push(cloneBson(options || {}));
		this.db.writeEvents.push({ collection: this.name, kind });
		const hook = await this.db.invoke("beforeWrite", {
			collection: this.name,
			kind,
			payload: cloneBson(payload),
			writeIndex: this.db.writeEvents.length - 1,
		});
		if (hook?.throwBefore) throw hook.throwBefore;
		const result = await commit(hook);
		await this.db.invoke("afterWrite", {
			collection: this.name,
			kind,
			payload: cloneBson(payload),
			result: cloneBson(result),
		});
		if (hook?.throwAfterCommit) throw hook.throwAfterCommit;
		return result;
	}
}

class FakeDb {
	constructor(seed = {}, hooks = {}) {
		this.collections = new Map();
		this.hooks = hooks;
		this.readOptions = [];
		this.writeOptions = [];
		this.writeEvents = [];
		this.createdCollections = [];
		for (const [name, documents] of Object.entries(seed)) {
			this.collection(name).seed(documents);
		}
	}

	collection(name) {
		if (!this.collections.has(name)) this.collections.set(name, new FakeCollection(this, name));
		return this.collections.get(name);
	}

	async invoke(name, event) {
		if (typeof this.hooks[name] !== "function") return null;
		return this.hooks[name](event, this);
	}

	listCollections(filter = {}) {
		const values = [...this.collections.keys()]
			.filter((name) => !filter.name || name === filter.name)
			.map((name) => ({ name }));
		return { toArray: async () => values.map(cloneBson) };
	}

	async createCollection(name, options = {}) {
		this.writeOptions.push(cloneBson(options));
		this.writeEvents.push({ collection: name, kind: "createCollection" });
		if (this.collections.has(name)) throw new Error(`collection ${name} already exists`);
		this.collections.set(name, new FakeCollection(this, name));
		this.createdCollections.push(name);
		return this.collection(name);
	}
}

const integrationDb = (hooks = {}) => {
	const source = integrationSourceDocuments();
	return new FakeDb({
		reservations: [source.reservation],
		inboundemails: source.audits,
		hoteldetails: [],
	}, hooks);
};

const applyArgs = (repairId, apply = true) => ({
	apply,
	help: false,
	repairId,
	rollback: false,
	targetKey: INTEGRATION_TARGET_KEY,
});

const rollbackArgs = (repairId, apply = true) => ({
	...applyArgs(repairId, apply),
	rollback: true,
});

const mutableDocumentHashes = (db) => ({
	reservation: canonicalEjsonSha256(db.collection("reservations").all()[0]),
	audits: db.collection("inboundemails").all()
		.map((document) => [String(document._id), canonicalEjsonSha256(document)])
		.sort(([left], [right]) => left.localeCompare(right)),
});

const integrationPlan = (repairId) => {
	const source = integrationSourceDocuments();
	const context = buildPlanContext({ repairAt: INTEGRATION_REPAIR_AT, repairId });
	return {
		context,
		plan: buildRecoveryPlan({
			audits: source.audits,
			context,
			hotel: null,
			reservation: source.reservation,
			targetKey: INTEGRATION_TARGET_KEY,
		}),
		source,
	};
};

const cleanApply = async (repairId, hooks = {}) => {
	const db = integrationDb(hooks);
	const prepared = integrationPlan(repairId);
	const result = await applyRepair({
		args: applyArgs(repairId),
		clock: () => INTEGRATION_REPAIR_AT,
		db,
	});
	return { db, result, ...prepared };
};

test("arguments are dry-run by default and require exactly one known target", () => {
	const args = parseArguments(["--target", "agoda_hotel_2038704202"]);
	assert.equal(args.apply, false);
	assert.equal(args.rollback, false);
	assert.equal(args.targetKey, "agoda_hotel_2038704202");
	assert.throws(() => parseArguments([]), /explicit --target/);
	assert.throws(
		() => parseArguments(["--target", "agoda_hotel_2038704202", "--target", "agoda_hotel_2038703612"]),
		/only once/,
	);
	assert.throws(
		() => parseArguments(["--target", "agoda_hotel_2038704202", "--apply"]),
		/requires a globally unique --repair-id/,
	);
	assert.throws(() => parseArguments(["--target", "all"]), /Unknown recovery target/);
});

test("apply and rollback accept only an explicit validated repair ID", () => {
	const apply = parseArguments([
		"--target", "agoda_hotel_2038703612",
		"--apply",
		"--repair-id", "hotel-3612-20260805-a",
	]);
	assert.equal(apply.apply, true);
	assert.equal(apply.repairId, "hotel-3612-20260805-a");
	const rollback = parseArguments([
		"--target", "agoda_hotel_2038703612",
		"--rollback",
		"--repair-id", "hotel-3612-20260805-a",
	]);
	assert.equal(rollback.apply, false);
	assert.equal(rollback.rollback, true);
	assert.throws(
		() => parseArguments(["--target", "agoda_hotel_2038703612", "--rollback"]),
		/requires the original --repair-id/,
	);
});

test("audit query includes exact IDs, content hashes, duplicate links, reservation, PMS, and OTA identities", () => {
	const query = buildAuditMatchQuery("agoda_hotel_2038704202");
	const serialized = JSON.stringify(query);
	for (const required of [
		"6a7329d739b444f30248e89a",
		"afc548c7fc44e56f282de2e43023457dd11d1f5fa0a9e56412d479da1524d20f",
		"duplicateOf",
		"reservationMongoId",
		"pmsConfirmationNumber",
		"8668645575",
		"confirmationNumber",
		"2038704202",
	]) assert.match(serialized, new RegExp(required));
});

test("Agoda 2038686448 runner scope is bound to its two exact audits and reservation identities", () => {
	const args = parseArguments(["--target", "agoda_pricing_2038686448"]);
	assert.equal(args.targetKey, "agoda_pricing_2038686448");
	assert.equal(args.apply, false);
	const serialized = JSON.stringify(buildAuditMatchQuery(args.targetKey));
	for (const required of [
		"6a733f4b39b444f3024905f6",
		"6a73490f39b444f302491651",
		"badbe215a80e019aa32fccfcd99db8d8e69ccd4f78c1a5494fb3e99f60f38989",
		"1ce9f8eadcea901a6f3cf9159835f70a21b5de8f1eeb5c3d9c8514787097fb6f",
		"6a733f4e39b444f3024905ff",
		"6567634147",
		"2038686448",
	]) assert.match(serialized, new RegExp(required));
});

test("backup set permanently includes mutable, immutable, and full hotel evidence", () => {
	const plan = makePlan();
	const records = buildBackupRecordsForPlan({
		backupAt: "2026-08-05T13:00:00.000Z",
		backupCollection: plan.context.backupCollection,
		plan,
		repairId: plan.context.repairId,
	});
	assert.equal(records.length, 3);
	assert.deepEqual(
		records.map((record) => record.sourceCollection).sort(),
		["hoteldetails", "inboundemails", "reservations"],
	);
	verifyBackupReadback({
		backupCollection: plan.context.backupCollection,
		plannedRecords: records,
		readback: records.map(cloneBson),
		repairId: plan.context.repairId,
	});
	const changed = records.map(cloneBson);
	changed[0].originalDocument.state = "changed";
	assert.throws(() => verifyBackupReadback({
		backupCollection: plan.context.backupCollection,
		plannedRecords: records,
		readback: changed,
		repairId: plan.context.repairId,
	}), /canonical original hash|hash readback/);
});

test("manifest binds one target, exact plan hash, permanent backup hashes, and owner token", () => {
	const plan = makePlan();
	const records = buildBackupRecordsForPlan({
		backupAt: "2026-08-05T13:00:00.000Z",
		backupCollection: plan.context.backupCollection,
		plan,
		repairId: plan.context.repairId,
	});
	const manifest = buildManifestDocument({
		applyToken: "owner-token",
		backupAt: "2026-08-05T13:00:00.000Z",
		plan,
		records,
	});
	assert.equal(manifest.targetKey, plan.targetKey);
	assert.equal(manifest.state, "initializing");
	assert.equal(manifest.applyToken, "owner-token");
	assert.equal(manifest.planHash, planHash(plan));
	assert.equal(manifest.backupRecordCount, 3);
	assert.equal(Object.keys(manifest.backupRecordHashes).length, 3);
});

test("lost write acknowledgement resolves with exactly one primary read and no retry", async () => {
	const plan = makePlan();
	const documentPlan = plan.documentPlans[0];
	let reads = 0;
	let writes = 0;
	const db = {
		collection(name) {
			assert.equal(name, "reservations");
			return {
				async findOne() {
					reads += 1;
					return cloneBson(documentPlan.expectedDocument);
				},
			};
		},
	};
	const result = await executeDocumentWriteWithHashReadback({
		afterHash: documentPlan.expectedHash,
		beforeHash: documentPlan.originalHash,
		db,
		documentPlan,
		async write() {
			writes += 1;
			throw new Error("simulated acknowledgement loss");
		},
	});
	assert.equal(result.state, "after");
	assert.equal(result.acknowledgementLost, true);
	assert.equal(writes, 1);
	assert.equal(reads, 1);
});

test("ambiguous write state is rejected after one read and never retried", async () => {
	const plan = makePlan();
	const documentPlan = plan.documentPlans[0];
	let reads = 0;
	let writes = 0;
	const db = {
		collection() {
			return {
				async findOne() {
					reads += 1;
					return { _id: objectId(documentPlan.documentId), state: "unknown", __v: 99 };
				},
			};
		},
	};
	await assert.rejects(
		executeDocumentWriteWithHashReadback({
			afterHash: documentPlan.expectedHash,
			beforeHash: documentPlan.originalHash,
			db,
			documentPlan,
			async write() {
				writes += 1;
				return { acknowledged: true, matchedCount: 1 };
			},
		}),
		/ambiguous/,
	);
	assert.equal(writes, 1);
	assert.equal(reads, 1);
});

test("pure plan simulation helper remains database-free", () => {
	assert.equal(typeof applyPlanToScope, "function");
});

test("native fake database cleanly applies two mutable documents with permanent backup and majority semantics", async () => {
	const repairId = "runner-clean-apply-20260805-a";
	const source = integrationSourceDocuments();
	const context = buildPlanContext({ repairAt: INTEGRATION_REPAIR_AT, repairId });
	const plan = buildRecoveryPlan({
		audits: source.audits,
		context,
		hotel: null,
		reservation: source.reservation,
		targetKey: INTEGRATION_TARGET_KEY,
	});
	assert.equal(plan.documentPlans.length, 2);
	const db = integrationDb();
	const result = await applyRepair({
		args: applyArgs(repairId),
		clock: () => INTEGRATION_REPAIR_AT,
		db,
	});
	assert.equal(result.state, "applied");
	assert.equal(db.collection(MANIFEST_COLLECTION).all()[0].state, "applied");
	assert.equal(db.collection(context.backupCollection).all().length, 3);
	for (const documentPlan of plan.documentPlans) {
		const live = db.collection(documentPlan.collection).all()
			.find((document) => String(document._id) === documentPlan.documentId);
		assert.equal(canonicalEjsonSha256(live), documentPlan.expectedHash);
	}
	assert.ok(db.readOptions.length > 0);
	assert.ok(db.readOptions.every((options) =>
		options.readPreference === "primary"
		&& options.readConcern?.level === "majority"));
	assert.ok(db.writeOptions.length > 0);
	assert.ok(db.writeOptions.every((options) => options.writeConcern?.w === "majority"));
	assert.equal(db.writeEvents.some((event) => /delete|drop|inventory|notify|ai/i.test(event.kind)), false);
});

test("second-document CAS rejection exactly compensates the first write and retains the backup", async () => {
	const repairId = "runner-cas-compensation-20260805-a";
	let rejected = false;
	const db = integrationDb({
		beforeWrite({ collection, kind }) {
			if (!rejected && collection === "inboundemails" && kind === "updateOne") {
				rejected = true;
				return { reject: true };
			}
			return null;
		},
	});
	const before = mutableDocumentHashes(db);
	await assert.rejects(
		applyRepair({ args: applyArgs(repairId), clock: () => INTEGRATION_REPAIR_AT, db }),
		(error) => error.recoveryState === "compensated",
	);
	assert.deepEqual(mutableDocumentHashes(db), before);
	const context = buildPlanContext({ repairAt: INTEGRATION_REPAIR_AT, repairId });
	assert.equal(db.collection(context.backupCollection).all().length, 3);
	assert.equal(db.collection(MANIFEST_COLLECTION).all()[0].state, "compensated");
});

test("a committed reservation write with a lost acknowledgement is hash-resolved without retry", async () => {
	const repairId = "runner-apply-ack-loss-20260805-a";
	let injected = false;
	const { db, result } = await cleanApply(repairId, {
		beforeWrite({ collection, kind }) {
			if (!injected && collection === "reservations" && kind === "updateOne") {
				injected = true;
				return { throwAfterCommit: new Error("simulated reservation acknowledgement loss") };
			}
			return null;
		},
	});
	assert.equal(result.state, "applied");
	assert.equal(
		db.writeEvents.filter((event) => event.collection === "reservations" && event.kind === "updateOne").length,
		1,
	);
});

test("a concurrent third state is never overwritten during apply compensation", async () => {
	const repairId = "runner-third-state-20260805-a";
	let rejected = false;
	const db = integrationDb({
		beforeWrite({ collection, kind }, liveDb) {
			if (!rejected && collection === "inboundemails" && kind === "updateOne") {
				rejected = true;
				const reservation = liveDb.collection("reservations").all()[0];
				reservation.concurrentManualMarker = "must-survive";
				liveDb.collection("reservations").set(reservation);
				return { reject: true };
			}
			return null;
		},
	});
	await assert.rejects(
		applyRepair({ args: applyArgs(repairId), clock: () => INTEGRATION_REPAIR_AT, db }),
		(error) => /CAS did not match/.test(error.message)
			&& /neither the exact original nor exact repaired/.test(error.recoveryError || ""),
	);
	assert.equal(db.collection("reservations").all()[0].concurrentManualMarker, "must-survive");
	assert.equal(db.collection(MANIFEST_COLLECTION).all()[0].state, "manual_intervention_required");
});

test("manifest immutable-identity fence loss stops the next write", async () => {
	const repairId = "runner-manifest-fence-loss-20260805-a";
	let tampered = false;
	const db = integrationDb({
		afterWrite({ collection, kind }, liveDb) {
			if (!tampered && collection === "reservations" && kind === "updateOne") {
				tampered = true;
				const manifest = liveDb.collection(MANIFEST_COLLECTION).all()[0];
				manifest.planHash = "0".repeat(64);
				liveDb.collection(MANIFEST_COLLECTION).set(manifest);
			}
		},
	});
	await assert.rejects(
		applyRepair({ args: applyArgs(repairId), clock: () => INTEGRATION_REPAIR_AT, db }),
		(error) => /immutable planHash changed/.test(error.message)
			&& /manifest ownership changed/.test(error.recoveryError || ""),
	);
	assert.equal(
		db.writeEvents.filter((event) => event.collection === "inboundemails" && event.kind === "updateOne").length,
		0,
	);
});

test("unknown identity-linked inbound audit aborts preflight before every write", async () => {
	const repairId = "runner-unknown-audit-20260805-a";
	const db = integrationDb();
	const target = TARGETS[INTEGRATION_TARGET_KEY];
	const unknown = cloneBson(db.collection("inboundemails").all()[1]);
	unknown._id = objectId("6a73285939b444f30248e631");
	unknown.emailHash = "1".repeat(64);
	unknown.textHash = "2".repeat(64);
	unknown.confirmationNumber = target.otaConfirmation;
	db.collection("inboundemails").set(unknown);
	await assert.rejects(
		applyRepair({ args: applyArgs(repairId), clock: () => INTEGRATION_REPAIR_AT, db }),
		/unknown identity-linked inbound audit/,
	);
	assert.equal(db.writeEvents.length, 0);
});

test("dry-run builds and verifies the exact plan with zero writes", async () => {
	const repairId = "runner-dry-run-20260805-a";
	const db = integrationDb();
	const before = mutableDocumentHashes(db);
	const result = await applyRepair({
		args: applyArgs(repairId, false),
		clock: () => INTEGRATION_REPAIR_AT,
		db,
	});
	assert.equal(result.state, "dry_run_ready");
	assert.equal(result.writesPerformed, false);
	assert.equal(db.writeEvents.length, 0);
	assert.deepEqual(mutableDocumentHashes(db), before);
});

test("clean rollback reconstructs only from the permanent backup and restores exact originals", async () => {
	const repairId = "runner-clean-rollback-20260805-a";
	const { db, plan, source } = await cleanApply(repairId);
	const result = await rollbackRepair({ db, args: rollbackArgs(repairId) });
	assert.equal(result.state, "rolled_back");
	assert.equal(canonicalEjsonSha256(db.collection("reservations").all()[0]), canonicalEjsonSha256(source.reservation));
	for (const audit of source.audits) {
		const live = db.collection("inboundemails").all().find((candidate) => String(candidate._id) === String(audit._id));
		assert.equal(canonicalEjsonSha256(live), canonicalEjsonSha256(audit));
	}
	assert.equal(db.collection(MANIFEST_COLLECTION).all()[0].state, "rolled_back");
	assert.equal(db.collection(plan.context.backupCollection).all().length, 3);
});

test("partial rollback CAS failure compensates back to the complete repaired state", async () => {
	const repairId = "runner-partial-rollback-20260805-a";
	const applied = await cleanApply(repairId);
	let rejected = false;
	applied.db.hooks.beforeWrite = ({ collection, kind }) => {
		if (!rejected && collection === "reservations" && kind === "replaceOne") {
			rejected = true;
			return { reject: true };
		}
		return null;
	};
	await assert.rejects(
		rollbackRepair({ db: applied.db, args: rollbackArgs(repairId) }),
		(error) => error.recoveryState === "applied",
	);
	for (const documentPlan of applied.plan.documentPlans) {
		const live = applied.db.collection(documentPlan.collection).all()
			.find((document) => String(document._id) === documentPlan.documentId);
		assert.equal(canonicalEjsonSha256(live), documentPlan.expectedHash);
	}
	const manifest = applied.db.collection(MANIFEST_COLLECTION).all()[0];
	assert.equal(manifest.state, "applied");
	assert.equal(Object.hasOwn(manifest, "rollbackToken"), false);
});

test("a committed rollback document write with lost acknowledgement is not retried", async () => {
	const repairId = "runner-rollback-write-ack-loss-20260805-a";
	const applied = await cleanApply(repairId);
	let injected = false;
	applied.db.hooks.beforeWrite = ({ collection, kind }) => {
		if (!injected && collection === "inboundemails" && kind === "replaceOne") {
			injected = true;
			return { throwAfterCommit: new Error("simulated rollback document acknowledgement loss") };
		}
		return null;
	};
	const result = await rollbackRepair({ db: applied.db, args: rollbackArgs(repairId) });
	assert.equal(result.state, "rolled_back");
	assert.equal(
		applied.db.writeEvents.filter((event) => event.collection === "inboundemails" && event.kind === "replaceOne").length,
		1,
	);
});

test("lost final rollback transition acknowledgement recovers from exact rolled_back state", async () => {
	const repairId = "runner-final-rollback-ack-loss-20260805-a";
	const applied = await cleanApply(repairId);
	let failNextManifestRead = false;
	let injected = false;
	applied.db.hooks.beforeWrite = ({ collection, kind, payload }) => {
		if (
			!injected
			&& collection === MANIFEST_COLLECTION
			&& kind === "updateOne"
			&& payload.update?.$set?.state === "rolled_back"
		) {
			injected = true;
			failNextManifestRead = true;
			return { throwAfterCommit: new Error("simulated final rollback acknowledgement loss") };
		}
		return null;
	};
	applied.db.hooks.beforeFindOne = ({ collection }, liveDb) => {
		if (
			failNextManifestRead
			&& collection === MANIFEST_COLLECTION
			&& liveDb.collection(MANIFEST_COLLECTION).all()[0]?.state === "rolled_back"
		) {
			failNextManifestRead = false;
			return { throw: new Error("simulated first readback loss") };
		}
		return null;
	};
	const result = await rollbackRepair({ db: applied.db, args: rollbackArgs(repairId) });
	assert.equal(result.state, "rolled_back");
	assert.equal(result.acknowledgementRecovered, true);
	assert.equal(applied.db.collection(MANIFEST_COLLECTION).all()[0].state, "rolled_back");
});

test("tampered manifest or backup is rejected before rollback writes", async () => {
	{
		const repairId = "runner-tampered-manifest-20260805-a";
		const { db } = await cleanApply(repairId);
		const manifest = db.collection(MANIFEST_COLLECTION).all()[0];
		manifest.backupRecordHashes = { ...manifest.backupRecordHashes, forged: "0".repeat(64) };
		db.collection(MANIFEST_COLLECTION).set(manifest);
		const writesBefore = db.writeEvents.length;
		await assert.rejects(rollbackRepair({ db, args: rollbackArgs(repairId) }), /Backup record hashes differ/);
		assert.equal(db.writeEvents.length, writesBefore);
	}
	{
		const repairId = "runner-tampered-backup-20260805-a";
		const { context, db } = await cleanApply(repairId);
		const backup = db.collection(context.backupCollection).all()[0];
		backup.originalDocument.tampered = true;
		db.collection(context.backupCollection).set(backup);
		const writesBefore = db.writeEvents.length;
		await assert.rejects(rollbackRepair({ db, args: rollbackArgs(repairId) }), /canonical original hash|Backup record hashes differ/);
		assert.equal(db.writeEvents.length, writesBefore);
	}
});

test("main disconnects an owned injected connection after a verified dry run", async () => {
	const db = integrationDb();
	let connects = 0;
	let disconnects = 0;
	const result = await main(["--target", INTEGRATION_TARGET_KEY], {
		async connectDatabase() {
			connects += 1;
			return db;
		},
		async disconnect() {
			disconnects += 1;
		},
		clock: () => INTEGRATION_REPAIR_AT,
	});
	assert.equal(result.state, "dry_run_ready");
	assert.equal(connects, 1);
	assert.equal(disconnects, 1);
	assert.equal(db.writeEvents.length, 0);
});
