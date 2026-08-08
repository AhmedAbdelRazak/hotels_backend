/** @format */

"use strict";

process.env.SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "SG.test";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
	EXACT_TARGETS,
	EXPECTED_HOTEL_ID,
	REPAIR_ID,
	STANDALONE_APPLY_STRATEGY,
	TRANSACTION_APPLY_STRATEGY,
	applyDottedSet,
	applyPlan,
	loadPlan,
	loadTargetScope,
	parseArguments,
	parseProof,
	proofToken,
	protectedReservationSnapshot,
	resolveApplyStrategy,
	sha256,
} = require("./repairAgodaCommercialEnrichment20260808");
const { hashObject } = require("../services/hotelrunnerPayload");

const RELEASE_SHA = "a".repeat(40);
const PLANNED_AT = new Date("2026-08-08T23:30:00.000Z");
const OWNER_ID = "68b74714fb50e159d48c714d";

const clone = (value) => structuredClone(value);
const getPath = (document, pathText) =>
	String(pathText)
		.split(".")
		.reduce((current, key) => (current == null ? undefined : current[key]), document);

function setPath(document, pathText, value) {
	const parts = pathText.split(".");
	let current = document;
	for (const part of parts.slice(0, -1)) {
		current[part] ||= {};
		current = current[part];
	}
	current[parts.at(-1)] = clone(value);
}

function valuesEqual(left, right) {
	if (left instanceof Date || right instanceof Date) {
		return new Date(left).getTime() === new Date(right).getTime();
	}
	return hashObject(left) === hashObject(right);
}

function matches(document, filter = {}) {
	for (const [pathText, expected] of Object.entries(filter)) {
		if (pathText === "$and") {
			if (!expected.every((branch) => matches(document, branch))) return false;
			continue;
		}
		if (pathText === "$or") {
			if (!expected.some((branch) => matches(document, branch))) return false;
			continue;
		}
		if (pathText === "$expr") {
			const expectedRootKeys = expected?.$eq?.[1];
			if (Object.keys(document || {}).length !== expectedRootKeys) return false;
			continue;
		}
		const actual = getPath(document, pathText);
		if (expected && typeof expected === "object" && "$ne" in expected) {
			if (valuesEqual(actual, expected.$ne)) return false;
			continue;
		}
		if (expected === null) {
			if (actual !== null && actual !== undefined) return false;
			continue;
		}
		if (!valuesEqual(actual, expected)) return false;
	}
	return true;
}

function memoryModel(
	documents = [],
	{ mutable = false, replaceHook = null } = {}
) {
	let replaceCalls = 0;
	const model = {
		documents,
		find(filter) {
			const query = {
				select() {
					return this;
				},
				limit(value) {
					this.max = value;
					return this;
				},
				session() {
					return this;
				},
				read() {
					return this;
				},
				readConcern() {
					return this;
				},
				lean() {
					return this;
				},
				async exec() {
					return documents
						.filter((document) => matches(document, filter))
						.slice(0, this.max || documents.length)
						.map(clone);
				},
			};
			return query;
		},
		async updateOne(filter, update) {
			if (!mutable) throw new Error("unexpected immutable-model write");
			const document = documents.find((candidate) => matches(candidate, filter));
			if (!document) return { matchedCount: 0, modifiedCount: 0 };
			for (const [pathText, value] of Object.entries(update.$set || {})) {
				setPath(document, pathText, value);
			}
			for (const [pathText, value] of Object.entries(update.$inc || {})) {
				setPath(document, pathText, Number(getPath(document, pathText) || 0) + Number(value));
			}
			for (const [pathText, value] of Object.entries(update.$push || {})) {
				const values = Array.isArray(getPath(document, pathText))
					? getPath(document, pathText)
					: [];
				values.push(clone(value));
				setPath(document, pathText, values);
			}
			return { matchedCount: 1, modifiedCount: 1 };
		},
	};
	model.collection = {
		async findOne(filter) {
			const found = documents.find((candidate) => matches(candidate, filter));
			return found ? clone(found) : null;
		},
		async replaceOne(filter, replacement) {
			if (!mutable) throw new Error("unexpected immutable-model replacement");
			replaceCalls += 1;
			const index = documents.findIndex((candidate) => matches(candidate, filter));
			const commit = () => {
				if (index < 0) {
					return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
				}
				documents[index] = clone(replacement);
				return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
			};
			if (replaceHook) {
				return replaceHook({ call: replaceCalls, commit, filter, replacement });
			}
			return commit();
		},
	};
	return model;
}

function longDate(ymd) {
	return new Intl.DateTimeFormat("en-US", {
		timeZone: "UTC",
		month: "long",
		day: "numeric",
		year: "numeric",
	}).format(new Date(`${ymd}T00:00:00.000Z`));
}

function dateRange(checkin, checkout) {
	const values = [];
	for (
		let current = new Date(`${checkin}T00:00:00.000Z`);
		current < new Date(`${checkout}T00:00:00.000Z`);
		current = new Date(current.getTime() + 86_400_000)
	) {
		values.push(current.toISOString().slice(0, 10));
	}
	return values;
}

function fixture(targetInput) {
	const nightlyDates = dateRange(targetInput.checkinDate, targetInput.checkoutDate);
	const componentAmounts = targetInput.componentAmounts;
	const bodyText = [
		`Booking ID ${targetInput.otaBookingId} Reservation Information`,
		"PREPAID Booking confirmation",
		"Zyd Agyad",
		`Customer First Name SAFE Customer Last Name GUEST Country of Residence Saudi Arabia Check-in ${longDate(
			targetInput.checkinDate
		)} Check-out ${longDate(targetInput.checkoutDate)} Other Guests [RmNo.1]`,
		`Room Type No. of Rooms Occupancy No. of Extra Bed ${targetInput.parsedRoomName} 1 2 Adults 0`,
		`From - To Rates ${nightlyDates
			.map(
				(date, index) =>
					`${longDate(date)} SAR ${targetInput.dailyPayout[index].toFixed(2)}`
			)
			.join(" ")} Reference sell rate (incl. taxes & fees) SAR ${targetInput.grossTotalSar.toFixed(
			2
		)} Compensation Commission SAR -${componentAmounts[0].toFixed(
			2
		)} Agoda Growth Program SAR -${componentAmounts[1].toFixed(
			2
		)} Tax on Commission SAR -${componentAmounts[2].toFixed(
			2
		)} Targeted promotions`,
		`Net rate (incl. taxes & fees) SAR ${targetInput.payoutTotalSar.toFixed(2)}`,
	].join("\n");
	const target = { ...targetInput, bodyTextHash: sha256(bodyText) };
	const pricingByDay = nightlyDates.map((date, index) => ({
		date,
		price: target.dailyPayout[index],
		clientPrice: target.dailyPayout[index],
		mainPrice: target.dailyPayout[index],
		rootPrice: target.dailyRoot[index],
		totalPriceWithCommission: target.dailyPayout[index],
		netAfterExpenses: null,
		netAfterOtaExpenses: null,
		otaExpenseAmount: null,
		platformMargin: null,
		hotelRunnerSourcePrice: target.dailyPayout[index],
	}));
	const room = {
		room_type: target.key.includes("9730513055") ? "tripleRooms" : "quadRooms",
		displayName: target.key.includes("9730513055")
			? "Triple Room - Premium Comfort"
			: "Quadruple Room – Comfort & Privacy",
		sourceRoomName: target.sourceRoomName,
		hotelRoomConfigId: target.roomConfigId,
		localRoomConfigId: target.roomConfigId,
		count: 1,
		chosenPrice: target.payoutTotalSar / nightlyDates.length,
		totalPriceWithCommission: target.payoutTotalSar,
		hotelShouldGet: target.rootTotalSar,
		pricingByDay,
	};
	const reservation = {
		_id: target.reservationMongoId,
		__v: 0,
		updatedAt: new Date("2026-08-08T21:34:35.000Z"),
		hotelId: EXPECTED_HOTEL_ID,
		belongsTo: OWNER_ID,
		confirmation_number: target.pmsConfirmationNumber,
		reservation_id: target.otaBookingId,
		hr_number: target.hrNumber.toLowerCase(),
		otaIdentityKey: `agoda:${target.otaBookingId}`,
		otaCrossTransportIdentityKey: "",
		booking_source: "agoda",
		customer_details: {
			name: "Safe Guest",
			confirmation_number2: target.otaBookingId,
			booking_source: "Agoda",
		},
		state: "ota platform review",
		reservation_status: "ota platform review",
		checkin_date: new Date(`${target.checkinDate}T00:00:00.000Z`),
		checkout_date: new Date(`${target.checkoutDate}T00:00:00.000Z`),
		total_rooms: 1,
		total_guests: 2,
		adults: 2,
		children: 0,
		roomId: [],
		bedNumber: [],
		total_amount: target.payoutTotalSar,
		sub_total: target.rootTotalSar,
		currency: "sar",
		commission: 0,
		commission_ota: null,
		financeStatus: "not paid",
		payment: "not provided",
		paid_amount: 0,
		payment_details: { captured: false, onsite_paid_amount: 0 },
		pickedRoomsType: [clone(room)],
		pickedRoomsPricing: [clone(room)],
		adminChangeLog: [],
		reservationAuditLog: [],
		adminPricing: {
			mode: "hotelrunner_api",
			source: "hotelrunner_api",
			clientTotal: target.payoutTotalSar,
			rootTotal: target.rootTotalSar,
			netAfterExpensesTotal: null,
			otaExpenseTotal: null,
			platformMarginTotal: null,
			commissionAmount: null,
			commercialVerified: false,
			payoutFallbackReason: "hotelrunner_payout_not_provided",
		},
		ota_financial_summary: {
			show: false,
			source: "hotelrunner_api",
			clientTotal: target.payoutTotalSar,
			hotelVisibleAmount: target.rootTotalSar,
			netAfterExpenses: null,
			netAfterOtaExpenses: null,
			otaExpenseTotal: null,
			commercialVerified: false,
			payoutFallbackReason: "hotelrunner_payout_not_provided",
		},
		adminPricingVisibility: {
			rootOnlyForHotelManagement: true,
			source: "hotelrunner_api",
			appliedAt: new Date("2026-08-08T21:34:35.000Z"),
			appliedBy: null,
		},
		otaPlatformReview: {
			status: "pending",
			source: "hotelrunner_api",
			inboundEmailId: "",
			provider: "agoda",
			providerLabel: "Agoda",
			confirmationNumber: target.otaBookingId,
			createdAt: new Date("2026-08-08T21:34:35.000Z"),
			releasedAt: null,
			releasedBy: null,
			priceAtRelease: 0,
			hotelRunnerManaged: true,
			hotelRunnerLinkedAt: new Date("2026-08-08T21:34:35.000Z"),
			lastHotelRunnerUpdatedAt: new Date("2026-08-08T21:34:35.000Z"),
			hotelAssignmentRequired: false,
			hotelAssignmentStatus: "assigned",
			assignedHotelId: EXPECTED_HOTEL_ID,
			assignedHotelName: "zad ajyad",
			assignedAt: new Date("2026-08-08T21:34:35.000Z"),
			roomMappingStatus: "mapped",
			roomMappingHotelId: EXPECTED_HOTEL_ID,
			lastUpdatedAt: new Date("2026-08-08T21:34:35.000Z"),
		},
		pendingConfirmation: {
			status: "",
			rejectionReason: "",
			confirmationReason: "",
			confirmedAt: null,
			rejectedAt: null,
			lastUpdatedAt: null,
			lastUpdatedBy: null,
		},
		supplierData: {
			supplierName: "Agoda",
			suppliedBookingNo: target.otaBookingId,
			otaConfirmationNumber: target.otaBookingId,
			platformConfirmationNumber: target.otaBookingId,
			otaProvider: "agoda",
			otaAutomationPipeline: "hotelrunner-background-worker",
			otaSourceAuthority: 4,
			hotelRunner: {
				transport: "hotelrunner_api",
				reservationId: target.hotelRunnerReservationId,
				hrNumber: target.hrNumber,
				providerNumber: target.otaBookingId,
				reportedPaymentMethod: "Not provided",
			},
		},
	};
	const event = {
		_id: target.eventId,
		__v: 0,
		hotelId: EXPECTED_HOTEL_ID,
		hotelRunnerReservationId: target.hotelRunnerReservationId,
		hrNumber: target.hrNumber,
		providerNumber: target.otaBookingId,
		payloadHash: target.eventPayloadHash,
		canonicalHash: target.canonicalHash,
		status: target.eventStatus,
		integrityConflict: false,
		integrityReason: "",
		reservationMongoId: target.reservationMongoId,
		source: "push",
		payload: {},
	};
	const mirror = {
		_id: target.mirrorId,
		__v: 0,
		hotelId: EXPECTED_HOTEL_ID,
		hotelRunnerReservationId: target.hotelRunnerReservationId,
		hrNumber: target.hrNumber,
		providerNumber: target.otaBookingId,
		observedCanonicalHash: target.canonicalHash,
		appliedCanonicalHash: target.canonicalHash,
		projectionVersion: 1,
		projectionStatus: "created",
		reservationMongoId: target.reservationMongoId,
	};
	const audit = {
		_id: target.inboundEmailId,
		provider: "agoda",
		confirmationNumber: target.otaBookingId,
		from: '"agoda.com" <no-reply@agoda.com>',
		to: "reservations@example.com",
		subject: `Agoda Booking ID ${target.otaBookingId} - CONFIRMED Hotel Country: Saudi Arabia Check-in ${longDate(
			target.checkinDate
		)} / Language_English`,
		messageId: `<${target.otaBookingId}@agoda.com>`,
		bodyText,
		bodyHtml: "",
		textHash: target.bodyTextHash,
		receivedAt: new Date("2026-08-08T21:34:27.000Z"),
		senderAuthentication: {
			authenticatedAligned: true,
			trustedProvider: "agoda",
			method: "dkim",
		},
		normalizedReservation: {
			source: { receivedAt: "2026-08-08T21:34:23.000Z" },
		},
	};
	const hotel = {
		_id: EXPECTED_HOTEL_ID,
		hotelName: "zad ajyad",
		belongsTo: OWNER_ID,
		activateHotel: true,
		xHotelProActive: true,
		roomCountDetails: [
			{
				_id: target.roomConfigId,
				displayName: room.displayName,
				roomType: room.room_type,
				activeRoom: true,
			},
		],
	};
	return { target, reservation, event, mirror, audit, hotel };
}

function fixtureModels(fixtures, { replaceHook = null } = {}) {
	const hotel = clone(fixtures[0].hotel);
	hotel.roomCountDetails = fixtures.flatMap((item) => item.hotel.roomCountDetails);
	return {
		ReservationModel: memoryModel(
			fixtures.map((item) => item.reservation),
			{ mutable: true, replaceHook }
		),
		EventModel: memoryModel(fixtures.map((item) => item.event)),
		MirrorModel: memoryModel(fixtures.map((item) => item.mirror)),
		InboundModel: memoryModel(fixtures.map((item) => item.audit)),
		HotelModel: memoryModel([hotel]),
	};
}

test("repair arguments require the exact release, repair id, and dry-run proof", () => {
	assert.deepEqual(parseArguments([`--release-sha=${RELEASE_SHA}`]), {
		apply: false,
		repairId: "",
		releaseSha: RELEASE_SHA,
		proof: "",
	});
	assert.throws(() => parseArguments([]), /release-sha/);
	assert.throws(
		() =>
			parseArguments([
				"--apply",
				`--release-sha=${RELEASE_SHA}`,
				`--repair-id=${REPAIR_ID}`,
			]),
		/dry-run proof/
	);
	const token = `${PLANNED_AT.getTime()}.${"b".repeat(64)}`;
	assert.equal(
		parseArguments([
			"--apply",
			`--release-sha=${RELEASE_SHA}`,
			`--repair-id=${REPAIR_ID}`,
			`--proof=${token}`,
		]).proof,
		token
	);
	assert.equal(
		parseProof(token, new Date(PLANNED_AT.getTime() + 1_000)).planHash,
		"b".repeat(64)
	);
	assert.throws(
		() => parseProof(token, new Date(PLANNED_AT.getTime() + 31 * 60_000)),
		/expired/
	);
});

test("database topology selects a transaction only when the server supports one", async () => {
	assert.equal(
		await resolveApplyStrategy({
			command: async () => ({ isWritablePrimary: true, setName: "rs0" }),
		}),
		TRANSACTION_APPLY_STRATEGY
	);
	assert.equal(
		await resolveApplyStrategy({
			command: async () => ({ isWritablePrimary: true }),
		}),
		STANDALONE_APPLY_STRATEGY
	);
	await assert.rejects(
		() =>
			resolveApplyStrategy({
				command: async () => ({ isWritablePrimary: false }),
			}),
		/writable primary/
	);
});

test("the two exact stored Agoda shapes produce only the approved commercial updates", async () => {
	for (const baseTarget of EXACT_TARGETS) {
		const item = fixture(baseTarget);
		const scope = await loadTargetScope(item.target, item.hotel, {
			evidenceAppliedAt: PLANNED_AT,
			releaseSha: RELEASE_SHA,
			models: fixtureModels([item]),
		});
		assert.equal(scope.state, "ready");
		assert.equal(scope.set.total_amount, item.target.grossTotalSar);
		assert.equal(scope.set.commission, 0);
		assert.equal(scope.set.commission_ota, item.target.otaCommissionSar);
		assert.equal(
			scope.set["adminPricing.otaExpenseTotal"],
			item.target.otaExpenseTotalSar
		);
		assert.equal(
			hashObject(protectedReservationSnapshot(item.reservation)),
			hashObject(
				protectedReservationSnapshot(applyDottedSet(item.reservation, scope.set))
			)
		);
	}
});

test("one proof-gated transaction repairs exactly two reservations and leaves all envelopes untouched", async () => {
	const fixtures = EXACT_TARGETS.map(fixture);
	const targets = fixtures.map((item) => item.target);
	const models = fixtureModels(fixtures);
	const beforeEnvelopes = hashObject({
		events: models.EventModel.documents,
		mirrors: models.MirrorModel.documents,
		audits: models.InboundModel.documents,
	});
	const plan = await loadPlan({
		evidenceAppliedAt: PLANNED_AT,
		releaseSha: RELEASE_SHA,
		models,
		targets,
	});
	assert.equal(plan.state, "ready");
	assert.match(proofToken(plan), /^\d{13}\.[a-f0-9]{64}$/);
	const transactionOptions = [];
	const result = await applyPlan(plan, {
		models,
		targets,
		startSession: async () => ({
			async withTransaction(work, options) {
				transactionOptions.push(options);
				return work();
			},
			async endSession() {},
		}),
	});
	assert.equal(result.state, "applied");
	assert.equal(result.changed, 2);
	assert.equal(result.vendorApiCalls, 0);
	assert.equal(transactionOptions[0].readConcern.level, "snapshot");
	assert.equal(transactionOptions[0].writeConcern.w, "majority");
	for (const reservation of models.ReservationModel.documents) {
		const target = targets.find((item) => item.reservationMongoId === reservation._id);
		assert.equal(reservation.__v, 1);
		assert.equal(reservation.total_amount, target.grossTotalSar);
		assert.equal(reservation.commission, 0);
		assert.equal(reservation.commission_ota, target.otaCommissionSar);
		assert.equal(
			reservation.reservationAuditLog.at(-1).repairId,
			REPAIR_ID
		);
	}
	assert.equal(
		hashObject({
			events: models.EventModel.documents,
			mirrors: models.MirrorModel.documents,
			audits: models.InboundModel.documents,
		}),
		beforeEnvelopes
	);
});

test("a standalone primary repairs both reservations with serialized full-document CAS", async () => {
	const fixtures = EXACT_TARGETS.map(fixture);
	const targets = fixtures.map((item) => item.target);
	const models = fixtureModels(fixtures);
	const beforeEnvelopes = hashObject({
		events: models.EventModel.documents,
		mirrors: models.MirrorModel.documents,
		audits: models.InboundModel.documents,
	});
	const plan = await loadPlan({
		evidenceAppliedAt: PLANNED_AT,
		releaseSha: RELEASE_SHA,
		applyStrategy: STANDALONE_APPLY_STRATEGY,
		models,
		targets,
	});
	const result = await applyPlan(plan, { models, targets });
	assert.equal(result.state, "applied");
	assert.equal(result.changed, 2);
	assert.equal(result.acknowledgementsRecovered, 0);
	for (const reservation of models.ReservationModel.documents) {
		const target = targets.find(
			(item) => item.reservationMongoId === reservation._id
		);
		assert.equal(reservation.__v, 1);
		assert.equal(reservation.total_amount, target.grossTotalSar);
		assert.equal(reservation.commission_ota, target.otaCommissionSar);
		assert.equal(
			reservation.reservationAuditLog.at(-1).applyStrategy,
			STANDALONE_APPLY_STRATEGY
		);
	}
	assert.equal(
		hashObject({
			events: models.EventModel.documents,
			mirrors: models.MirrorModel.documents,
			audits: models.InboundModel.documents,
		}),
		beforeEnvelopes
	);
});

test("standalone CAS resolves a committed write whose acknowledgement was lost", async () => {
	const fixtures = EXACT_TARGETS.map(fixture);
	const targets = fixtures.map((item) => item.target);
	const models = fixtureModels(fixtures, {
		replaceHook: ({ call, commit }) => {
			const result = commit();
			if (call === 1) throw new Error("simulated lost acknowledgement");
			return result;
		},
	});
	const plan = await loadPlan({
		evidenceAppliedAt: PLANNED_AT,
		releaseSha: RELEASE_SHA,
		applyStrategy: STANDALONE_APPLY_STRATEGY,
		models,
		targets,
	});
	const result = await applyPlan(plan, { models, targets });
	assert.equal(result.state, "applied");
	assert.equal(result.changed, 2);
	assert.equal(result.acknowledgementsRecovered, 1);
});

test("standalone second-write rejection compensates the first exact reservation", async () => {
	const fixtures = EXACT_TARGETS.map(fixture);
	const targets = fixtures.map((item) => item.target);
	const originalHash = hashObject(fixtures.map((item) => item.reservation));
	const models = fixtureModels(fixtures, {
		replaceHook: ({ call, commit }) =>
			call === 2
				? { acknowledged: true, matchedCount: 0, modifiedCount: 0 }
				: commit(),
	});
	const plan = await loadPlan({
		evidenceAppliedAt: PLANNED_AT,
		releaseSha: RELEASE_SHA,
		applyStrategy: STANDALONE_APPLY_STRATEGY,
		models,
		targets,
	});
	await assert.rejects(
		() => applyPlan(plan, { models, targets }),
		(error) =>
			error?.code === "AGODA_REPAIR_COMPENSATED" &&
			/both exact originals/.test(error.message)
	);
	assert.equal(hashObject(models.ReservationModel.documents), originalHash);
});

test("scope is permanently two targets and the script has no vendor or reservation-create path", () => {
	assert.equal(EXACT_TARGETS.length, 2);
	assert.equal(EXACT_TARGETS[0].otaBookingId, "687715051");
	assert.equal(EXACT_TARGETS[1].requestedIdentifier, "9730513055");
	assert.equal(EXACT_TARGETS[1].pmsConfirmationNumber, "9730513055");
	assert.equal(EXACT_TARGETS[1].otaBookingId, "687702587");
	const source = fs.readFileSync(
		path.join(__dirname, "repairAgodaCommercialEnrichment20260808.js"),
		"utf8"
	);
	assert.doesNotMatch(
		source,
		/HotelRunnerClient|createHotelRunnerClient|retrieveHotelRunnerReservations|confirmHotelRunnerDelivery|axios|https\.request|fetch\s*\(/
	);
	assert.doesNotMatch(source, /Reservations\.create|insertOne|insertMany/);
});
