/**
 * Pure, fixed-scope recovery planner for the OTA inbound incident audited on
 * 2026-08-05.  This module deliberately performs no database or network I/O.
 *
 * Every mutable document is protected by a full-document BSON-aware CAS
 * filter and canonical SHA-256 hashes.  The caller is responsible for backup,
 * fencing and durable writes; the helpers here only validate, plan, simulate,
 * and post-verify those exact documents.
 */

"use strict";

const assert = require("node:assert/strict");

const {
	applyUpdateToDocument,
	buildExactCasFilter,
	canonicalEjsonSha256,
	canonicalEqual,
	cloneBson,
	hasCaptureEvidence,
} = require("./tripHotelRunnerRepair20260805");

const OPERATION = "recent_ota_inbound_recovery_20260805";
const REPAIR_SOURCE = "recent-ota-inbound-recovery-20260805";
const MANIFEST_COLLECTION = "ota_recent_inbound_recovery_manifests";
const BACKUP_COLLECTION_PREFIX = "ota_recent_inbound_recovery_backup_";
const EXPECTED_HOTEL_ID = "6a40b6a1a6efe70450536038";
const EXPECTED_OWNER_ID = "68b74714fb50e159d48c714d";
const EXPECTED_HOTEL_NAME = "zad ajyad";

const freeze = (value) => {
	if (value && typeof value === "object") {
		Object.values(value).forEach(freeze);
		Object.freeze(value);
	}
	return value;
};

const TARGETS = freeze({
	agoda_pricing_2038722839: {
		kind: "pricing",
		mongoId: "6a7324ad39b444f30248e019",
		pmsConfirmation: "8982408795",
		otaConfirmation: "2038722839",
		otaIdentityKey: "agoda:2038722839",
		crossTransportIdentityKey: "",
		hotelId: EXPECTED_HOTEL_ID,
		ownerId: EXPECTED_OWNER_ID,
		checkinDate: "2026-08-26",
		checkoutDate: "2026-08-28",
		roomType: "familyRooms",
		roomConfigId: "6a4a84216022cd7f31729011",
		nights: 2,
		provider: "agoda",
		providerLabel: "Agoda",
		transportProvider: "agoda",
		bookingSource: "agoda",
		currency: "SAR",
		exchangeRate: 1,
		exchangeRateSource: "identity",
		amountConvertedAt: "2026-08-05T11:55:38.821Z",
		paymentInstructions:
			"Agoda prepaid reservation; net rate is provided by Agoda.",
		paymentComment: "Agoda collected by platform",
		sourceClientTotalSource: "agoda_direct_email_guest_total",
		relayWatermark: "2026-08-05T10:52:57.000Z",
		expectedVersion: 0,
		old: {
			clientSar: 112.78,
			payoutSar: 90.22,
			expenseSar: 22.56,
			rootSar: 102,
			marginSar: -11.78,
			commissionSar: 20.4,
			sourceAmount: 112.78,
			chosenPrice: 56.39,
		},
		corrected: {
			clientSource: 182.28,
			payoutSource: 112.78,
			clientSar: 182.28,
			payoutSar: 112.78,
			expenseSar: 69.5,
			rootSar: 102,
			marginSar: 10.78,
			commissionSar: 20.4,
			chosenPrice: 91.14,
		},
		daily: [
			{ date: "2026-08-26", client: 91.14, payout: 56.39, expense: 34.75, root: 51, margin: 5.39 },
			{ date: "2026-08-27", client: 91.14, payout: 56.39, expense: 34.75, root: 51, margin: 5.39 },
		],
		audits: [
			{
				id: "6a7324a939b444f30248e008",
				role: "creating_relay_evidence",
				mutable: false,
				emailHash: "c64c2fe9a2b127b38e9081dbf93d03e53628d01cd4e959c91d9e0932ba3e85de",
				textHash: "a11f8490ab6ebada5a1fc1c7f138cae2e537a4b8eeda92d89c0e59729bce3718",
				provider: "agoda",
				trustedProvider: "hotelrunner",
				sourceReceivedAt: "2026-08-05T10:52:57.000Z",
				processingStatus: "created",
				automationAction: "created",
				skipReason: "",
			},
			{
				id: "6a7324ba39b444f30248e05e",
				role: "authoritative_direct_pricing",
				mutable: true,
				emailHash: "30e91b54d6bfb8f633732a39034ab629f14dbc0b10e610872e7c260a14c2d1ec",
				textHash: "2585657d90dc27624bfd46f10553a99be234fdf28885ffa54e74e4d8839b7112",
				provider: "agoda",
				trustedProvider: "agoda",
				sourceReceivedAt: "2026-08-05T10:45:44.000Z",
				processingStatus: "needs_review",
				automationAction: "skipped",
				skipReason: "stale_ota_lifecycle_event",
			},
		],
	},
	agoda_pricing_2038686448: {
		kind: "pricing",
		mongoId: "6a733f4e39b444f3024905ff",
		pmsConfirmation: "6567634147",
		otaConfirmation: "2038686448",
		otaIdentityKey: "agoda:2038686448",
		crossTransportIdentityKey: "",
		hotelId: EXPECTED_HOTEL_ID,
		ownerId: EXPECTED_OWNER_ID,
		checkinDate: "2026-08-05",
		checkoutDate: "2026-08-06",
		roomType: "tripleRooms",
		roomConfigId: "6a40e0981a6d1850eb25c27c",
		nights: 1,
		provider: "agoda",
		providerLabel: "Agoda",
		transportProvider: "agoda",
		bookingSource: "agoda",
		currency: "SAR",
		exchangeRate: 1,
		exchangeRateSource: "identity",
		amountConvertedAt: "2026-08-05T14:30:39.677Z",
		paymentInstructions:
			"Agoda prepaid reservation; net rate is provided by Agoda.",
		paymentComment: "Agoda collected by platform",
		sourceClientTotalSource: "agoda_direct_email_guest_total",
		relayWatermark: "2026-08-05T08:24:41.000Z",
		expectedVersion: 0,
		old: {
			clientSar: 46.69,
			payoutSar: 37.35,
			expenseSar: 9.34,
			rootSar: 75,
			marginSar: -37.65,
			commissionSar: 15,
			sourceAmount: 46.69,
			chosenPrice: 46.69,
		},
		corrected: {
			clientSource: 75.46,
			payoutSource: 46.69,
			clientSar: 75.46,
			payoutSar: 46.69,
			expenseSar: 28.77,
			rootSar: 75,
			marginSar: -28.31,
			commissionSar: 15,
			chosenPrice: 75.46,
		},
		daily: [
			{ date: "2026-08-05", client: 75.46, payout: 46.69, expense: 28.77, root: 75, margin: -28.31 },
		],
		audits: [
			{
				id: "6a733f4b39b444f3024905f6",
				role: "creating_relay_evidence",
				mutable: false,
				emailHash: "badbe215a80e019aa32fccfcd99db8d8e69ccd4f78c1a5494fb3e99f60f38989",
				textHash: "3eb809289d651cf98ff93564b6e438a19e9c1a1abbb8900aa884d90074e3cd66",
				provider: "agoda",
				trustedProvider: "hotelrunner",
				sourceReceivedAt: "2026-08-05T08:24:41.000Z",
				processingStatus: "created",
				automationAction: "created",
				skipReason: "",
			},
			{
				id: "6a73490f39b444f302491651",
				role: "authoritative_direct_pricing",
				mutable: true,
				emailHash: "1ce9f8eadcea901a6f3cf9159835f70a21b5de8f1eeb5c3d9c8514787097fb6f",
				textHash: "0580f1366981287e739883319621895143bbc81066138645995a64c10200313f",
				provider: "agoda",
				trustedProvider: "agoda",
				sourceReceivedAt: "2026-08-05T08:21:24.000Z",
				processingStatus: "needs_review",
				automationAction: "skipped",
				skipReason: "stale_ota_lifecycle_event",
			},
		],
	},
	trip_pricing_1433813442496171: {
		kind: "pricing",
		mongoId: "6a73245f39b444f30248df62",
		pmsConfirmation: "7090067176",
		otaConfirmation: "1433813442496171",
		otaIdentityKey: "hotelrunner:1433813442496171",
		crossTransportIdentityKey: "trip:1433813442496171",
		hotelId: EXPECTED_HOTEL_ID,
		ownerId: EXPECTED_OWNER_ID,
		checkinDate: "2026-08-05",
		checkoutDate: "2026-08-06",
		roomType: "doubleRooms",
		roomConfigId: "6a40df5f1a6d1850eb25c183",
		nights: 1,
		provider: "trip",
		providerLabel: "Trip.com",
		transportProvider: "hotelrunner",
		bookingSource: "trip.com",
		currency: "USD",
		exchangeRate: 3.75,
		exchangeRateSource: "exchange_rate_api_cached",
		amountConvertedAt: "2026-08-05T12:11:05.622Z",
		paymentInstructions:
			"Trip.com prepaid reservation; the guest has already paid the platform.",
		paymentComment: "Trip.com collected by platform",
		sourceClientTotalSource: "trip_direct_email_final_room_rate",
		relayWatermark: "2026-08-05T10:35:47.000Z",
		expectedVersion: 0,
		old: {
			clientSar: 56.89,
			payoutSar: 45.51,
			expenseSar: 11.38,
			rootSar: 75,
			marginSar: -29.49,
			commissionSar: 15,
			sourceAmount: 15.17,
			chosenPrice: 56.89,
		},
		corrected: {
			clientSource: 16.06,
			payoutSource: 15.17,
			clientSar: 60.22,
			payoutSar: 56.89,
			expenseSar: 3.33,
			rootSar: 75,
			marginSar: -18.11,
			commissionSar: 15,
			chosenPrice: 60.22,
		},
		daily: [
			{ date: "2026-08-05", client: 60.22, payout: 56.89, expense: 3.33, root: 75, margin: -18.11 },
		],
		audits: [
			{
				id: "6a73245c39b444f30248df47",
				role: "creating_relay_evidence",
				mutable: false,
				emailHash: "be8619cf92ced4781f5b9cdb01cb75c97f1435ec7924b7495cbd6cc420c11038",
				textHash: "04088109296a15330e389b9076631d34acb1b97e62ec354ba785c97c0a9cd2cc",
				provider: "hotelrunner",
				trustedProvider: "hotelrunner",
				sourceReceivedAt: "2026-08-05T10:35:47.000Z",
				processingStatus: "created",
				automationAction: "created",
				skipReason: "",
			},
			{
				id: "6a73285939b444f30248e630",
				role: "authoritative_direct_pricing",
				mutable: true,
				emailHash: "e506d6557254601850451f894914009c2e675eb626d01bb4e8b83462057be70f",
				textHash: "dd859a2925f3322d36e7188d59f5e31b49527aef59776f74bfc1745d4cbdfb95",
				provider: "trip",
				trustedProvider: "trip",
				sourceReceivedAt: "2026-08-05T10:35:05.000Z",
				processingStatus: "needs_review",
				automationAction: "skipped",
				skipReason: "stale_ota_lifecycle_event",
			},
		],
	},
	airbnb_cancellation_hm2w4qqrt9: {
		kind: "cancellation",
		mongoId: "6a4bc6160b9a1247a9e58712",
		pmsConfirmation: "6993062423",
		otaConfirmation: "hm2w4qqrt9",
		otaIdentityKey: "airbnb:hm2w4qqrt9",
		hotelId: EXPECTED_HOTEL_ID,
		ownerId: EXPECTED_OWNER_ID,
		checkinDate: "2026-08-05",
		checkoutDate: "2026-08-09",
		cancellationSourceReceivedAt: "2026-08-05T11:54:15.000Z",
		expectedVersion: 1,
		audits: [
			{
				id: "6a4bc6110b9a1247a9e5870a",
				role: "creation_identity_and_stay_evidence",
				mutable: false,
				emailHash: "c182d6f01427902c5c410670c74acb781c2aafcf2c3242e7a5b518c22200a5c2",
				textHash: "416dc22f113b86d2a76959d7ee94e8cd7132f5823fceb80c4e4a64fe827e5dd3",
				provider: "airbnb",
				trustedProvider: "",
				receivedAt: "2026-07-06T15:13:21.918Z",
				processingStatus: "created",
				automationAction: "created",
				skipReason: "",
			},
			{
				id: "6a7324f139b444f30248e163",
				role: "authoritative_cancellation",
				mutable: true,
				emailHash: "31d218682da1c7359620ecf751a409452d12331b7b36b85642dd940c1f82be2f",
				textHash: "712d49b6e213f457ceea5dbab4c2148070e6928a5763257851598dc17a6445a9",
				provider: "airbnb",
				trustedProvider: "hotelrunner",
				sourceReceivedAt: "2026-08-05T11:54:15.000Z",
				processingStatus: "needs_review",
				automationAction: "skipped",
				skipReason: "inhouse_ota_status_regression_blocked",
			},
		],
	},
	agoda_hotel_2038703612: {
		kind: "hotel_assignment",
		mongoId: "6a73267539b444f30248e365",
		pmsConfirmation: "1206346061",
		otaConfirmation: "2038703612",
		otaIdentityKey: "agoda:2038703612",
		hotelId: EXPECTED_HOTEL_ID,
		ownerId: EXPECTED_OWNER_ID,
		checkinDate: "2026-09-06",
		checkoutDate: "2026-09-13",
		clientTotal: 369.93,
		payoutTotal: 295.94,
		expenseTotal: 73.99,
		relayWatermark: "2026-08-05T09:29:50.000Z",
		paymentInstructions:
			"Agoda prepaid reservation; net rate is provided by Agoda.",
		paymentComment: "Agoda collected by platform",
		sourceClientTotalSource: "agoda_direct_email_guest_total",
		corrected: {
			clientSource: 597.8,
			payoutSource: 369.93,
			clientSar: 597.8,
			payoutSar: 369.93,
			expenseSar: 227.87,
			rootSar: 0,
			marginSar: 0,
			commissionSar: 0,
			chosenPrice: 85.4,
			amountConvertedAt: "2026-08-05T12:30:08.601Z",
		},
		daily: [
			{ date: "2026-09-06", client: 85.4, payout: 52.85, expense: 32.55 },
			{ date: "2026-09-07", client: 85.4, payout: 52.85, expense: 32.55 },
			{ date: "2026-09-08", client: 85.4, payout: 52.85, expense: 32.55 },
			{ date: "2026-09-09", client: 85.4, payout: 52.85, expense: 32.55 },
			{ date: "2026-09-10", client: 85.4, payout: 52.85, expense: 32.55 },
			{ date: "2026-09-11", client: 85.4, payout: 52.84, expense: 32.56 },
			{ date: "2026-09-12", client: 85.4, payout: 52.84, expense: 32.56 },
		],
		nights: 7,
		roomType: "familyRooms",
		expectedVersion: 0,
		audits: [
			{
				id: "6a73267239b444f30248e34e",
				role: "creating_unmapped_reservation",
				mutable: true,
				emailHash: "ff9caf78edb572a7383530822bada2be4f487e58ea1e245c96acb53a0c269496",
				textHash: "84603d8f9d5cd591d07cca3e353867bde8b3cad534dc082c29af4c1d7e405e4f",
				provider: "agoda",
				trustedProvider: "hotelrunner",
				processingStatus: "created",
				automationAction: "created_unmapped_ota_review",
				skipReason: "",
			},
			{
				id: "6a732cd039b444f30248ed10",
				role: "authoritative_direct_pricing",
				mutable: true,
				emailHash: "ba7d8b1127918300535c19a246426e0ad7ee3caa1b7c9e23c02f2a435c29ff54",
				textHash: "77b7d9923c3cdda7a8d0fd9cbe3d318389a1d50ad32d74365d2da47ae1ca2a3e",
				provider: "agoda",
				trustedProvider: "agoda",
				sourceReceivedAt: "2026-08-05T09:28:23.000Z",
				processingStatus: "needs_review",
				automationAction: "skipped",
				skipReason: "stale_ota_lifecycle_event",
			},
		],
	},
	agoda_hotel_2038704202: {
		kind: "hotel_assignment",
		mongoId: "6a7329da39b444f30248e8a1",
		pmsConfirmation: "8668645575",
		otaConfirmation: "2038704202",
		otaIdentityKey: "agoda:2038704202",
		hotelId: EXPECTED_HOTEL_ID,
		ownerId: EXPECTED_OWNER_ID,
		checkinDate: "2026-09-08",
		checkoutDate: "2026-09-13",
		clientTotal: 266.83,
		payoutTotal: 213.46,
		expenseTotal: 53.37,
		relayWatermark: "2026-08-05T09:31:55.000Z",
		paymentInstructions:
			"Agoda prepaid reservation; net rate is provided by Agoda.",
		paymentComment: "Agoda collected by platform",
		sourceClientTotalSource: "agoda_direct_email_guest_total",
		corrected: {
			clientSource: 431.2,
			payoutSource: 266.83,
			clientSar: 431.2,
			payoutSar: 266.83,
			expenseSar: 164.37,
			rootSar: 0,
			marginSar: 0,
			commissionSar: 0,
			chosenPrice: 86.24,
			amountConvertedAt: "2026-08-05T12:36:32.080Z",
		},
		daily: [
			{ date: "2026-09-08", client: 86.24, payout: 53.37, expense: 32.87 },
			{ date: "2026-09-09", client: 86.24, payout: 53.37, expense: 32.87 },
			{ date: "2026-09-10", client: 86.24, payout: 53.37, expense: 32.87 },
			{ date: "2026-09-11", client: 86.24, payout: 53.36, expense: 32.88 },
			{ date: "2026-09-12", client: 86.24, payout: 53.36, expense: 32.88 },
		],
		nights: 5,
		roomType: "familyRooms",
		expectedVersion: 0,
		audits: [
			{
				id: "6a7329d739b444f30248e89a",
				role: "creating_unmapped_reservation",
				mutable: true,
				emailHash: "afc548c7fc44e56f282de2e43023457dd11d1f5fa0a9e56412d479da1524d20f",
				textHash: "12fa7320770a96524b7e093b628fffb8a0c53cfafc9d0a52b921fb5a67931a4b",
				provider: "agoda",
				trustedProvider: "hotelrunner",
				processingStatus: "created",
				automationAction: "created_unmapped_ota_review",
				skipReason: "",
			},
			{
				id: "6a732e4f39b444f30248eef8",
				role: "authoritative_direct_pricing",
				mutable: true,
				emailHash: "5958e2e8f164683ab757a04b646d389ecb4e7cb590f0a3d1f4598a9bef7bfedd",
				textHash: "198bedc2a08d2d707c13954edbbd439cd63da81a3d3f68b8b57d22624d1e34c5",
				provider: "agoda",
				trustedProvider: "agoda",
				sourceReceivedAt: "2026-08-05T09:30:48.000Z",
				receivedAt: "2026-08-05T12:36:31.747Z",
				processingStatus: "needs_review",
				automationAction: "skipped",
				skipReason: "stale_ota_lifecycle_event",
			},
		],
	},
	airbnb_payout: {
		kind: "audit_only",
		audits: [
			{
				id: "6a7324ac39b444f30248e014",
				role: "airbnb_payout_classification",
				mutable: true,
				emailHash: "78270af8e5e005499f76b50095f3db449efd3e7568d487ec54defdfcd3181bd2",
				textHash: "df49ce5d3739b21a3448a60bac001ae59e58d3e4a0bcfdc6e3e17689067fa7ce",
				provider: "airbnb",
				trustedProvider: "airbnb",
				processingStatus: "needs_review",
				automationAction: "skipped",
				skipReason: "confirmation_not_source_backed",
			},
		],
	},
});

const TARGET_KEYS = Object.freeze(Object.keys(TARGETS));
const RESERVATION_TARGET_KEYS = Object.freeze(
	TARGET_KEYS.filter((key) => TARGETS[key].mongoId),
);
const ALL_AUDIT_IDS = Object.freeze(
	TARGET_KEYS.flatMap((key) => TARGETS[key].audits.map((audit) => audit.id)),
);

const id = (value) => String(value?._id || value || "").toLowerCase();
const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const cents = (value) => Math.round(Number(value || 0) * 100);
const round2 = (value) => Number(Number(value || 0).toFixed(2));
const dateIso = (value) => {
	if (!value) return "";
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
};
const dateKey = (value) => dateIso(value).slice(0, 10);
const normalize = (value) =>
	String(value || "")
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[^a-z0-9\u0600-\u06ff]+/g, " ")
		.trim();

const assertMoney = (actual, expected, label) =>
	assert.equal(cents(actual), cents(expected), `${label}: expected ${expected}, received ${actual}`);
const assertDate = (actual, expected, label) =>
	assert.equal(dateIso(actual), expected, `${label}: expected ${expected}, received ${dateIso(actual)}`);
const assertDateKey = (actual, expected, label) =>
	assert.equal(dateKey(actual), expected, `${label}: expected ${expected}, received ${dateKey(actual)}`);

const assertMoneyDifference = (actual, minuend, subtrahend, label) =>
	assert.equal(
		cents(actual),
		cents(minuend) - cents(subtrahend),
		`${label}: expected ${round2(Number(minuend) - Number(subtrahend))}, received ${actual}`,
	);

const validatePricingTargetConstants = (target) => {
	assert.equal(target?.kind, "pricing", "A pricing target is required.");
	assert.ok(Number.isInteger(target.nights) && target.nights > 0, "Pricing target nights must be a positive integer.");
	assert.ok(Array.isArray(target.daily), "Pricing target daily rows are required.");
	assert.equal(target.daily.length, target.nights, "Pricing target nightly row count does not match nights.");
	assert.ok(String(target.currency || "").trim(), "Pricing target currency is required.");
	assert.ok(Number(target.exchangeRate) > 0, "Pricing target exchange rate must be positive.");
	assert.ok(String(target.exchangeRateSource || "").trim(), "Pricing target exchange-rate source is required.");
	assert.ok(dateIso(target.amountConvertedAt), "Pricing target conversion timestamp must be valid.");
	const expectedClientTotalSource = {
		agoda: "agoda_direct_email_guest_total",
		trip: "trip_direct_email_final_room_rate",
	}[target.provider];
	assert.ok(expectedClientTotalSource, `Unsupported fixed pricing provider: ${target.provider}`);
	assert.equal(
		target.sourceClientTotalSource,
		expectedClientTotalSource,
		"Pricing target source-client-total provenance does not match its provider.",
	);

	const checkinAt = new Date(`${target.checkinDate}T00:00:00.000Z`);
	const checkoutAt = new Date(`${target.checkoutDate}T00:00:00.000Z`);
	assert.ok(!Number.isNaN(checkinAt.getTime()), "Pricing target check-in date must be valid.");
	assert.ok(!Number.isNaN(checkoutAt.getTime()), "Pricing target check-out date must be valid.");
	assert.equal(
		(checkoutAt.getTime() - checkinAt.getTime()) / 86400000,
		target.nights,
		"Pricing target stay dates do not match nights.",
	);

	assertMoneyDifference(target.old.expenseSar, target.old.clientSar, target.old.payoutSar, "Historical OTA expense");
	assertMoneyDifference(target.old.marginSar, target.old.payoutSar, target.old.rootSar, "Historical platform margin");
	assertMoneyDifference(target.corrected.expenseSar, target.corrected.clientSar, target.corrected.payoutSar, "Corrected OTA expense");
	assertMoneyDifference(target.corrected.marginSar, target.corrected.payoutSar, target.corrected.rootSar, "Corrected platform margin");
	assertMoney(target.old.sourceAmount * target.exchangeRate, target.old.clientSar, "Historical source amount conversion");
	assertMoney(target.corrected.clientSource * target.exchangeRate, target.corrected.clientSar, "Corrected guest-total conversion");
	assertMoney(target.corrected.payoutSource * target.exchangeRate, target.corrected.payoutSar, "Corrected payout conversion");
	assertMoney(target.old.chosenPrice, target.old.clientSar / target.nights, "Historical nightly chosen price");
	assertMoney(target.corrected.chosenPrice, target.corrected.clientSar / target.nights, "Corrected nightly chosen price");

	const totals = { client: 0, payout: 0, expense: 0, root: 0, margin: 0 };
	for (let index = 0; index < target.daily.length; index += 1) {
		const day = target.daily[index];
		const expectedDate = new Date(checkinAt.getTime() + (index * 86400000))
			.toISOString()
			.slice(0, 10);
		assert.equal(day.date, expectedDate, `Pricing target nightly date ${index} is not contiguous with check-in.`);
		assertMoneyDifference(day.expense, day.client, day.payout, `Pricing target ${day.date} OTA expense`);
		assertMoneyDifference(day.margin, day.payout, day.root, `Pricing target ${day.date} platform margin`);
		for (const field of Object.keys(totals)) totals[field] += cents(day[field]);
	}
	assert.equal(totals.client, cents(target.corrected.clientSar), "Pricing target nightly guest totals do not reconcile.");
	assert.equal(totals.payout, cents(target.corrected.payoutSar), "Pricing target nightly payouts do not reconcile.");
	assert.equal(totals.expense, cents(target.corrected.expenseSar), "Pricing target nightly OTA expenses do not reconcile.");
	assert.equal(totals.root, cents(target.corrected.rootSar), "Pricing target nightly root totals do not reconcile.");
	assert.equal(totals.margin, cents(target.corrected.marginSar), "Pricing target nightly margins do not reconcile.");
	return target;
};

const getPath = (object, path) =>
	String(path)
		.split(".")
		.reduce((current, key) => (current == null ? undefined : current[key]), object);

const unsetPath = (object, path) => {
	const keys = String(path).split(".");
	let current = object;
	for (let index = 0; index < keys.length - 1; index += 1) {
		current = current?.[keys[index]];
		if (!current || typeof current !== "object") return;
	}
	delete current[keys[keys.length - 1]];
};

const withoutPaths = (object, paths) => {
	const next = cloneBson(object);
	paths.forEach((path) => unsetPath(next, path));
	return next;
};

const appendUnique = (values, message) => {
	const next = Array.isArray(values) ? cloneBson(values) : [];
	if (!next.includes(message)) next.push(message);
	return next;
};

const requireContext = (context = {}) => {
	assert.ok(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,79}$/.test(String(context.repairId || "")), "A fixed 8-80 character repairId is required.");
	assert.ok(String(context.backupCollection || "").trim(), "backupCollection is required.");
	assert.ok(dateIso(context.repairAt), "repairAt must be a valid timestamp.");
	return context;
};

const exactDocumentPlan = ({ collection, document, update, role }) => {
	assert.ok(document && typeof document === "object", `Missing ${role} document.`);
	const originalDocument = cloneBson(document);
	const casFilter = buildExactCasFilter(originalDocument);
	const expectedDocument = applyUpdateToDocument(originalDocument, update);
	return {
		collection,
		role,
		documentId: id(originalDocument),
		originalDocument,
		originalHash: canonicalEjsonSha256(originalDocument),
		casFilter,
		casFilterHash: canonicalEjsonSha256(casFilter),
		update: cloneBson(update),
		expectedDocument,
		expectedHash: canonicalEjsonSha256(expectedDocument),
	};
};

const assertReservationAliases = (reservation, target) => {
	assert.equal(id(reservation), target.mongoId, "reservation._id");
	assert.equal(String(reservation.confirmation_number || ""), target.pmsConfirmation, "reservation.confirmation_number");
	assert.equal(String(reservation.reservation_id || "").toLowerCase(), target.otaConfirmation, "reservation.reservation_id");
	assert.equal(String(reservation.otaIdentityKey || "").toLowerCase(), target.otaIdentityKey, "reservation.otaIdentityKey");
	if (own(target, "crossTransportIdentityKey")) {
		assert.equal(String(reservation.otaCrossTransportIdentityKey || "").toLowerCase(), target.crossTransportIdentityKey, "reservation.otaCrossTransportIdentityKey");
	}
	for (const [path, expected] of [
		["customer_details.confirmation_number2", target.otaConfirmation],
		["supplierData.suppliedBookingNo", target.otaConfirmation],
		["supplierData.otaConfirmationNumber", target.otaConfirmation],
		["supplierData.platformConfirmationNumber", target.otaConfirmation],
		["supplierData.pmsConfirmationNumber", target.pmsConfirmation],
		["otaPlatformReview.confirmationNumber", target.otaConfirmation],
	]) {
		const value = getPath(reservation, path);
		assert.ok(value != null && String(value) !== "", `${path} is required.`);
		assert.equal(String(value).toLowerCase(), expected, path);
	}
	assertDateKey(reservation.checkin_date, target.checkinDate, "reservation.checkin_date");
	assertDateKey(reservation.checkout_date, target.checkoutDate, "reservation.checkout_date");
};

const assertExpectedHotel = (reservation, target) => {
	assert.equal(id(reservation.hotelId), target.hotelId, "reservation.hotelId");
	assert.equal(id(reservation.belongsTo), target.ownerId, "reservation.belongsTo");
};

const assertNoSettlementOrCapture = (reservation) => {
	assert.equal(reservation.payment_details?.captured, false, "payment_details.captured must remain false.");
	assert.equal(hasCaptureEvidence(reservation), false, "Capture, attempt, transaction, processor remainder, PayPal, VCC, or BOFA secure-state evidence exists; automated recovery is forbidden.");
	assert.equal(reservation.moneyTransferredToHotel, false, "moneyTransferredToHotel must remain false.");
	assert.equal(reservation.commissionPaid, false, "commissionPaid must remain false.");
	assert.equal(reservation.moneyTransferredAt ?? null, null, "moneyTransferredAt must be null or absent.");
	assert.equal(reservation.commissionPaidAt ?? null, null, "commissionPaidAt must be null or absent.");
	const commissionData = reservation.commissionData;
	if (commissionData && typeof commissionData === "object") {
		assertMoney(commissionData.amount, 0, "commissionData.amount");
		assert.notEqual(commissionData.paid, true, "commissionData.paid shows settlement.");
		for (const key of ["paidAt", "settledAt", "transactionId", "transaction_id", "processorReference", "transferId", "payoutId"]) {
			assert.equal(commissionData[key] ?? null, null, `commissionData.${key} shows settlement evidence.`);
		}
		assert.ok(
			["", "no commission due", "unpaid", "not paid", "pending"].includes(normalize(commissionData.status)),
			`commissionData.status is not safely unsettled: ${commissionData.status}`,
		);
	}
	if (own(reservation, "commissionStatus")) {
		assert.ok(
			["", "no commission due", "unpaid", "not paid", "pending"].includes(normalize(reservation.commissionStatus)),
			`commissionStatus is not safely unsettled: ${reservation.commissionStatus}`,
		);
	}
	assert.notEqual(String(reservation.financial_cycle?.status || "").toLowerCase(), "closed", "financial_cycle.status is closed.");
	assert.notEqual(String(reservation.financial_cycle?.status || "").toLowerCase(), "settled", "financial_cycle.status is settled.");
	assert.equal(reservation.financial_cycle?.closedAt ?? null, null, "financial_cycle.closedAt must be null or absent.");
	assert.equal(reservation.financial_cycle?.closedBy ?? null, null, "financial_cycle.closedBy must be null or absent.");
	for (const [label, value] of [
		["vcc_payment.attempts", reservation.vcc_payment?.attempts],
		["bofa_payment.vcc.attempts", reservation.bofa_payment?.vcc?.attempts],
		["bofa_payment.secure_acceptance.callbacks", reservation.bofa_payment?.secure_acceptance?.callbacks],
		["braintree_payment.attempts", reservation.braintree_payment?.attempts],
	]) {
		assert.equal(Array.isArray(value) ? value.length : 0, 0, `${label} contains processor history.`);
	}
	for (const [label, value] of [
		["vcc_payment.charge_count", reservation.vcc_payment?.charge_count],
		["vcc_payment.attempts_count", reservation.vcc_payment?.attempts_count],
		["vcc_payment.failed_attempts_count", reservation.vcc_payment?.failed_attempts_count],
		["bofa_payment.vcc.charge_count", reservation.bofa_payment?.vcc?.charge_count],
		["bofa_payment.vcc.attempts_count", reservation.bofa_payment?.vcc?.attempts_count],
		["bofa_payment.vcc.failed_attempts_count", reservation.bofa_payment?.vcc?.failed_attempts_count],
		["braintree_payment.charge_count", reservation.braintree_payment?.charge_count],
		["braintree_payment.attempts_count", reservation.braintree_payment?.attempts_count],
		["braintree_payment.failed_attempts_count", reservation.braintree_payment?.failed_attempts_count],
	]) {
		assert.equal(Number(value || 0), 0, `${label} is non-zero.`);
	}
	for (const [label, value] of [
		["vcc_payment.charged", reservation.vcc_payment?.charged],
		["vcc_payment.processing", reservation.vcc_payment?.processing],
		["bofa_payment.vcc.charged", reservation.bofa_payment?.vcc?.charged],
		["bofa_payment.vcc.processing", reservation.bofa_payment?.vcc?.processing],
		["braintree_payment.charged", reservation.braintree_payment?.charged],
		["braintree_payment.processing", reservation.braintree_payment?.processing],
	]) {
		assert.notEqual(value, true, `${label} shows capture activity.`);
	}
	for (const [label, value] of [
		["vcc_payment.total_captured_sar", reservation.vcc_payment?.total_captured_sar],
		["vcc_payment.total_captured_usd", reservation.vcc_payment?.total_captured_usd],
		["bofa_payment.vcc.total_captured_sar", reservation.bofa_payment?.vcc?.total_captured_sar],
		["bofa_payment.vcc.total_captured_usd", reservation.bofa_payment?.vcc?.total_captured_usd],
		["braintree_payment.total_captured_usd", reservation.braintree_payment?.total_captured_usd],
	]) {
		assert.equal(cents(value), 0, `${label} shows captured money.`);
	}
};

const assertOnlyExpectedOtaPayment = (reservation, target) => {
	const breakdown = reservation.paid_amount_breakdown;
	assert.ok(
		breakdown && typeof breakdown === "object" && !Array.isArray(breakdown),
		"paid_amount_breakdown must be an object.",
	);
	assertMoney(
		breakdown.paid_online_other_platforms,
		target.clientTotal,
		"paid_amount_breakdown.paid_online_other_platforms",
	);
	assert.equal(
		String(breakdown.payment_comments || ""),
		target.paymentComment,
		"paid_amount_breakdown.payment_comments",
	);
	for (const [key, value] of Object.entries(breakdown)) {
		if (["paid_online_other_platforms", "payment_comments"].includes(key)) continue;
		assert.ok(
			Number.isFinite(Number(value)),
			`paid_amount_breakdown.${key} must be a finite payment amount.`,
		);
		assertMoney(value, 0, `paid_amount_breakdown.${key}`);
	}
};

const assertUnassignedHotelFinancialCycle = (reservation, target) => {
	const cycle = reservation.financial_cycle;
	assert.ok(
		cycle && typeof cycle === "object" && !Array.isArray(cycle),
		"financial_cycle must be an object.",
	);
	assert.equal(normalize(cycle.collectionModel), "pms collected", "financial_cycle.collectionModel");
	assert.equal(normalize(cycle.status), "open", "financial_cycle.status");
	assert.equal(normalize(cycle.commissionType), "amount", "financial_cycle.commissionType");
	assertMoney(cycle.commissionValue, 0, "financial_cycle.commissionValue");
	assertMoney(cycle.commissionAmount, 0, "financial_cycle.commissionAmount");
	assert.equal(cycle.commissionAssigned, false, "financial_cycle.commissionAssigned");
	assert.equal(cycle.commissionAssignedAt ?? null, null, "financial_cycle.commissionAssignedAt");
	assert.equal(cycle.commissionAssignedBy ?? null, null, "financial_cycle.commissionAssignedBy");
	assertMoney(cycle.pmsCollectedAmount, target.clientTotal, "financial_cycle.pmsCollectedAmount");
	assertMoney(cycle.hotelCollectedAmount, 0, "financial_cycle.hotelCollectedAmount");
	assertMoney(cycle.hotelPayoutDue, target.clientTotal, "financial_cycle.hotelPayoutDue");
	assertMoney(cycle.commissionDueToPms, 0, "financial_cycle.commissionDueToPms");
};

const assertPricingFinancialCycle = (reservation, target) => {
	const cycle = reservation.financial_cycle;
	assert.ok(
		cycle && typeof cycle === "object" && !Array.isArray(cycle),
		"financial_cycle must be an object.",
	);
	assert.equal(normalize(cycle.collectionModel), "pms collected", "financial_cycle.collectionModel");
	assert.equal(normalize(cycle.status), "open", "financial_cycle.status");
	assert.equal(normalize(cycle.commissionType), "amount", "financial_cycle.commissionType");
	assertMoney(cycle.commissionValue, target.old.commissionSar, "financial_cycle.commissionValue");
	assertMoney(cycle.commissionAmount, target.old.commissionSar, "financial_cycle.commissionAmount");
	assert.equal(cycle.commissionAssigned, false, "financial_cycle.commissionAssigned");
	assert.equal(cycle.commissionAssignedAt ?? null, null, "financial_cycle.commissionAssignedAt");
	assert.equal(cycle.commissionAssignedBy ?? null, null, "financial_cycle.commissionAssignedBy");
	assertMoney(cycle.pmsCollectedAmount, target.old.clientSar, "financial_cycle.pmsCollectedAmount");
	assertMoney(cycle.hotelCollectedAmount, 0, "financial_cycle.hotelCollectedAmount");
	assertMoney(cycle.hotelPayoutDue, target.old.rootSar, "financial_cycle.hotelPayoutDue");
	assertMoney(cycle.commissionDueToPms, 0, "financial_cycle.commissionDueToPms");
	assert.equal(reservation.commissionData ?? null, null, "commissionData must remain absent before pricing recovery.");
};

const assertNoClientTotalOverride = (adminPricing, label = "adminPricing") => {
	const overrideKeys = Object.keys(adminPricing || {}).filter((key) =>
		key.startsWith("clientTotalOverride"),
	);
	assert.deepEqual(
		overrideKeys,
		[],
		`${label} contains employee client-total override metadata: ${overrideKeys.join(", ")}`,
	);
};

const validatePricingReservation = (reservation, target) => {
	assertReservationAliases(reservation, target);
	assertExpectedHotel(reservation, target);
	assert.equal(Number(reservation.__v), target.expectedVersion, "reservation.__v");
	assert.equal(normalize(reservation.booking_source), normalize(target.bookingSource), "reservation.booking_source");
	assert.equal(normalize(reservation.customer_details?.booking_source), normalize(target.providerLabel), "customer_details.booking_source");
	assert.equal(normalize(reservation.supplierData?.supplierName), normalize(target.providerLabel), "supplierData.supplierName");
	assert.equal(normalize(reservation.supplierData?.otaProvider), normalize(target.transportProvider), "supplierData.otaProvider");
	assert.equal(normalize(reservation.adminPricing?.provider), normalize(target.transportProvider), "adminPricing.provider");
	assert.equal(normalize(reservation.ota_financial_summary?.provider), normalize(target.transportProvider), "ota_financial_summary.provider");
	assert.equal(normalize(reservation.otaPlatformReview?.provider), normalize(target.transportProvider), "otaPlatformReview.provider");
	assert.equal(String(reservation.otaPlatformReview?.status || "").toLowerCase(), "pending", "otaPlatformReview.status");
	assertNoClientTotalOverride(reservation.adminPricing);
	const creatingAudit = target.audits.find((audit) => audit.role === "creating_relay_evidence");
	assert.ok(creatingAudit, `${target.otaConfirmation} requires its creating relay audit.`);
	assert.equal(String(reservation.otaPlatformReview?.inboundEmailId || ""), creatingAudit.id, "otaPlatformReview.inboundEmailId");
	assert.equal(reservation.otaPlatformReview?.lastPricingUpdatedAt ?? null, null, "otaPlatformReview.lastPricingUpdatedAt must be absent before recovery.");
	assert.equal(Number(reservation.supplierData?.otaSourceAuthority), 1, "supplierData.otaSourceAuthority");
	assert.equal(String(reservation.supplierData?.otaLastInboundEmailId || ""), creatingAudit.id, "supplierData.otaLastInboundEmailId");
	assertDate(reservation.supplierData?.otaLastSourceReceivedAt, target.relayWatermark, "supplierData.otaLastSourceReceivedAt");
	assert.equal(String(reservation.supplierData?.otaLastEventType || "").toLowerCase(), "new", "supplierData.otaLastEventType");

	assertMoney(reservation.total_amount, target.old.clientSar, "total_amount");
	assertMoney(reservation.paid_amount, target.old.clientSar, "paid_amount");
	assertOnlyExpectedOtaPayment(reservation, {
		clientTotal: target.old.clientSar,
		paymentComment: target.paymentComment,
	});
	assertMoney(reservation.sub_total, target.old.rootSar, "sub_total");
	assertMoney(reservation.commission, target.old.commissionSar, "commission");
	assertMoney(reservation.adminPricing?.clientTotal, target.old.clientSar, "adminPricing.clientTotal");
	assertMoney(reservation.adminPricing?.rootTotal, target.old.rootSar, "adminPricing.rootTotal");
	assertMoney(reservation.adminPricing?.netAfterExpensesTotal, target.old.payoutSar, "adminPricing.netAfterExpensesTotal");
	assertMoney(reservation.adminPricing?.otaExpenseTotal, target.old.expenseSar, "adminPricing.otaExpenseTotal");
	assertMoney(reservation.adminPricing?.platformMarginTotal, target.old.marginSar, "adminPricing.platformMarginTotal");
	assertMoney(reservation.adminPricing?.commissionAmount, target.old.commissionSar, "adminPricing.commissionAmount");
	assertMoney(reservation.adminPricing?.sourceAmount, target.old.sourceAmount, "adminPricing.sourceAmount");
	assert.equal(reservation.adminPricing?.defaultDeductionApplied, true, "adminPricing.defaultDeductionApplied");
	assertMoney(reservation.ota_financial_summary?.clientTotal, target.old.clientSar, "ota_financial_summary.clientTotal");
	assertMoney(reservation.ota_financial_summary?.hotelVisibleAmount, target.old.rootSar, "ota_financial_summary.hotelVisibleAmount");
	assertMoney(reservation.ota_financial_summary?.netAfterExpenses, target.old.payoutSar, "ota_financial_summary.netAfterExpenses");
	assertMoney(reservation.ota_financial_summary?.otaExpenseTotal, target.old.expenseSar, "ota_financial_summary.otaExpenseTotal");
	assertMoney(reservation.ota_financial_summary?.platformProfit, target.old.marginSar, "ota_financial_summary.platformProfit");
	assertMoney(reservation.supplierData?.otaAmount, target.old.sourceAmount, "supplierData.otaAmount");
	assertMoney(reservation.supplierData?.otaAmountSar, target.old.clientSar, "supplierData.otaAmountSar");
	assertMoney(reservation.supplierData?.otaTotalPayoutSar, target.old.payoutSar, "supplierData.otaTotalPayoutSar");
	assertMoney(reservation.supplierData?.otaExpenseTotalSar, target.old.expenseSar, "supplierData.otaExpenseTotalSar");
	assertMoney(reservation.supplierData?.otaPlatformMarginSar, target.old.marginSar, "supplierData.otaPlatformMarginSar");
	assertPricingFinancialCycle(reservation, target);

	assert.ok(canonicalEqual(reservation.pickedRoomsType, reservation.pickedRoomsPricing), "The two persisted room arrays diverged before recovery.");
	for (const [field, rooms] of [["pickedRoomsType", reservation.pickedRoomsType], ["pickedRoomsPricing", reservation.pickedRoomsPricing]]) {
		assert.equal(rooms?.length, 1, `${field} must contain exactly one room.`);
		const room = rooms[0];
		assert.equal(room.room_type, target.roomType, `${field}[0].room_type`);
		assert.equal(id(room.hotelRoomConfigId), target.roomConfigId, `${field}[0].hotelRoomConfigId`);
		assert.equal(Number(room.count), 1, `${field}[0].count`);
		assertMoney(room.chosenPrice, target.old.chosenPrice, `${field}[0].chosenPrice`);
		assertMoney(room.totalPriceWithCommission, target.old.clientSar, `${field}[0].totalPriceWithCommission`);
		assertMoney(room.hotelShouldGet, target.old.rootSar, `${field}[0].hotelShouldGet`);
		assert.equal(room.pricingByDay?.length, target.nights, `${field}[0].pricingByDay length`);
		for (let index = 0; index < target.daily.length; index += 1) {
			const current = room.pricingByDay[index];
			const expected = target.daily[index];
			assert.equal(String(current.date), expected.date, `${field}[0].pricingByDay[${index}].date`);
			assertMoney(current.clientPrice, target.old.clientSar / target.nights, `${field}[0].pricingByDay[${index}].clientPrice`);
			assertMoney(current.rootPrice, expected.root, `${field}[0].pricingByDay[${index}].rootPrice`);
			assertMoney(current.netAfterOtaExpenses, target.old.payoutSar / target.nights, `${field}[0].pricingByDay[${index}].netAfterOtaExpenses`);
			assertMoney(current.otaExpenseAmount, target.old.expenseSar / target.nights, `${field}[0].pricingByDay[${index}].otaExpenseAmount`);
			assertMoney(current.platformMargin, target.old.marginSar / target.nights, `${field}[0].pricingByDay[${index}].platformMargin`);
		}
	}
	assertNoSettlementOrCapture(reservation);
	return reservation;
};

const validateCancellationReservation = (reservation, target) => {
	assertReservationAliases(reservation, target);
	assertExpectedHotel(reservation, target);
	assert.equal(Number(reservation.__v), target.expectedVersion, "reservation.__v");
	assert.equal(normalize(reservation.booking_source), "airbnb", "reservation.booking_source");
	assert.equal(normalize(reservation.supplierData?.otaProvider), "airbnb", "supplierData.otaProvider");
	assert.ok(String(reservation.state || "").trim(), "reservation.state must be present; any lifecycle value is accepted.");
	assert.ok(String(reservation.reservation_status || "").trim(), "reservation.reservation_status must be present; any lifecycle value is accepted.");
	assertMoney(reservation.total_amount, 320, "Airbnb preserved total_amount");
	assertMoney(reservation.paid_amount, 320, "Airbnb preserved paid_amount");
	assertMoney(reservation.supplierData?.otaSourceAmount, 388.8, "Airbnb preserved source total");
	assert.equal(reservation.pickedRoomsType?.length, 1, "Airbnb reservation must retain exactly one room block.");
	assert.equal(reservation.pickedRoomsType?.[0]?.room_type, "familyRooms", "Airbnb room semantic type");
	const currentWatermark = dateIso(reservation.supplierData?.otaLastSourceReceivedAt);
	if (currentWatermark) {
		assert.ok(
			new Date(currentWatermark).getTime() <
				new Date(target.cancellationSourceReceivedAt).getTime(),
			"Cancellation recovery refuses a newer or equal supplierData.otaLastSourceReceivedAt watermark.",
		);
	}
	assertNoSettlementOrCapture(reservation);
	return reservation;
};

const validateUnassignedHotelReservation = (reservation, target) => {
	const creatingAudit = target.audits.find((audit) =>
		audit.role === "creating_unmapped_reservation",
	);
	assert.ok(creatingAudit, `${target.otaConfirmation} requires its creating audit.`);
	assertReservationAliases(reservation, target);
	assert.equal(id(reservation.hotelId), "", "hotelId must still be unassigned before this repair.");
	assert.equal(id(reservation.belongsTo), "", "belongsTo must still be unassigned before this repair.");
	assert.equal(Number(reservation.__v), target.expectedVersion, "reservation.__v");
	assert.equal(normalize(reservation.booking_source), "agoda", "reservation.booking_source");
	assert.equal(normalize(reservation.supplierData?.otaProvider), "agoda", "supplierData.otaProvider");
	assert.equal(String(reservation.otaPlatformReview?.status || "").toLowerCase(), "pending", "otaPlatformReview.status");
	assert.equal(reservation.otaPlatformReview?.hotelAssignmentRequired, true, "otaPlatformReview.hotelAssignmentRequired");
	assert.equal(String(reservation.otaPlatformReview?.hotelAssignmentStatus || ""), "missing", "otaPlatformReview.hotelAssignmentStatus");
	assert.equal(reservation.supplierData?.otaHotelMappingRequired, true, "supplierData.otaHotelMappingRequired");
	assertNoClientTotalOverride(reservation.adminPricing);
	assert.equal(normalize(reservation.adminPricing?.mode), "ota platform unmapped", "adminPricing.mode");
	assert.equal(reservation.adminPricing?.hotelAssignmentRequired, true, "adminPricing.hotelAssignmentRequired");
	assert.equal(reservation.adminPricing?.defaultDeductionApplied, true, "adminPricing.defaultDeductionApplied");
	assert.equal(id(reservation.adminPricing?.assignedHotelId), "", "adminPricing.assignedHotelId must be empty.");
	assert.equal(String(reservation.adminPricing?.assignedHotelName || ""), "", "adminPricing.assignedHotelName must be empty.");
	assert.equal(reservation.adminPricing?.pricingReviewRequired ?? null, null, "adminPricing.pricingReviewRequired must be absent.");
	assert.equal(String(reservation.otaPlatformReview?.inboundEmailId || ""), creatingAudit.id, "otaPlatformReview.inboundEmailId");
	assert.equal(id(reservation.otaPlatformReview?.assignedHotelId), "", "otaPlatformReview.assignedHotelId must be empty.");
	assert.equal(String(reservation.otaPlatformReview?.assignedHotelName || ""), "", "otaPlatformReview.assignedHotelName must be empty.");
	assert.equal(reservation.otaPlatformReview?.assignedAt ?? null, null, "otaPlatformReview.assignedAt must be empty.");
	assert.equal(reservation.otaPlatformReview?.assignedBy ?? null, null, "otaPlatformReview.assignedBy must be empty.");
	assert.equal(String(reservation.otaPlatformReview?.roomMappingStatus || ""), "", "otaPlatformReview.roomMappingStatus must be empty.");
	assert.equal(id(reservation.otaPlatformReview?.roomMappingHotelId), "", "otaPlatformReview.roomMappingHotelId must be empty.");
	assert.equal(reservation.otaPlatformReview?.pricingInvalidatedAt ?? null, null, "otaPlatformReview.pricingInvalidatedAt must be empty.");
	assert.equal(String(reservation.otaPlatformReview?.pricingInvalidationReason || ""), "", "otaPlatformReview.pricingInvalidationReason must be empty.");
	assert.equal(reservation.otaPlatformReview?.lastPricingUpdatedAt ?? null, null, "otaPlatformReview.lastPricingUpdatedAt must be empty.");
	// The two live unmapped Agoda records were created by the lower-authority
	// HotelRunner path before this provenance field survived persistence.  The
	// immutable creation audits prove that exact transport.  Accept only the
	// observed absent field or the later canonical value 1; an explicit 0/null,
	// a higher authority, or any other value remains a hard preflight failure.
	const supplierData = reservation.supplierData || {};
	assert.ok(
		!own(supplierData, "otaSourceAuthority") ||
			supplierData.otaSourceAuthority === 1,
		"supplierData.otaSourceAuthority must be absent or exactly 1.",
	);
	assert.equal(String(reservation.supplierData?.otaLastInboundEmailId || ""), creatingAudit.id, "supplierData.otaLastInboundEmailId");
	assert.equal(String(reservation.supplierData?.otaLastEventType || "").toLowerCase(), "new", "supplierData.otaLastEventType");
	assert.equal(id(reservation.supplierData?.otaAssignedHotelId), "", "supplierData.otaAssignedHotelId must be empty.");
	assert.equal(String(reservation.supplierData?.otaAssignedHotelName || ""), "", "supplierData.otaAssignedHotelName must be empty.");
	assert.equal(reservation.supplierData?.otaAssignedHotelAt ?? null, null, "supplierData.otaAssignedHotelAt must be empty.");
	assert.equal(reservation.supplierData?.otaAssignedHotelBy ?? null, null, "supplierData.otaAssignedHotelBy must be empty.");
	assert.equal(String(reservation.supplierData?.otaMatchedRoomName || ""), "", "supplierData.otaMatchedRoomName must be empty.");
	assert.equal(id(reservation.supplierData?.otaHotelRoomConfigId), "", "supplierData.otaHotelRoomConfigId must be empty.");
	assertMoney(reservation.supplierData?.otaRoomMatchScore, 0, "supplierData.otaRoomMatchScore");
	assert.equal(String(reservation.supplierData?.otaRoomMatchType || ""), "", "supplierData.otaRoomMatchType must be empty.");
	assert.equal(String(reservation.supplierData?.otaRoomMatchReason || ""), "", "supplierData.otaRoomMatchReason must be empty.");
	assert.equal(String(reservation.supplierData?.otaRoomMatchedByModel || ""), "", "supplierData.otaRoomMatchedByModel must be empty.");
	assert.equal(normalize(reservation.supplierData?.otaHotelName), EXPECTED_HOTEL_NAME, "supplierData.otaHotelName");
	assert.equal(normalize(reservation.otaPlatformReview?.originalHotelName), EXPECTED_HOTEL_NAME, "otaPlatformReview.originalHotelName");
	assertMoney(reservation.total_amount, target.clientTotal, "total_amount");
	assertMoney(reservation.paid_amount, target.clientTotal, "paid_amount");
	assertOnlyExpectedOtaPayment(reservation, target);
	assertMoney(reservation.adminPricing?.clientTotal, target.clientTotal, "adminPricing.clientTotal");
	assertMoney(reservation.adminPricing?.netAfterExpensesTotal, target.payoutTotal, "adminPricing.netAfterExpensesTotal");
	assertMoney(reservation.adminPricing?.otaExpenseTotal, target.expenseTotal, "adminPricing.otaExpenseTotal");
	assertMoney(reservation.ota_financial_summary?.clientTotal, target.clientTotal, "ota_financial_summary.clientTotal");
	assertMoney(reservation.ota_financial_summary?.netAfterExpenses, target.payoutTotal, "ota_financial_summary.netAfterExpenses");
	assertMoney(reservation.ota_financial_summary?.otaExpenseTotal, target.expenseTotal, "ota_financial_summary.otaExpenseTotal");
	assertMoney(reservation.supplierData?.otaSourceAmount, target.clientTotal, "supplierData.otaSourceAmount");
	assertMoney(reservation.supplierData?.otaTotalPayoutSar, target.payoutTotal, "supplierData.otaTotalPayoutSar");
	assertMoney(reservation.supplierData?.otaExpenseTotalSar, target.expenseTotal, "supplierData.otaExpenseTotalSar");
	assertDate(reservation.supplierData?.otaLastSourceReceivedAt, target.relayWatermark, "supplierData.otaLastSourceReceivedAt");
	assertUnassignedHotelFinancialCycle(reservation, target);
	for (const [label, value] of [
		["sub_total", reservation.sub_total],
		["commission", reservation.commission],
		["adminPricing.rootTotal", reservation.adminPricing?.rootTotal],
		["adminPricing.platformMarginTotal", reservation.adminPricing?.platformMarginTotal],
		["adminPricing.commissionAmount", reservation.adminPricing?.commissionAmount],
	]) assertMoney(value, 0, label);
	assert.deepEqual(reservation.roomId || [], [], "roomId must remain empty before exact hotel assignment.");
	assert.equal(reservation.pickedRoomsType?.length, 1, "Exactly one unmapped room block is required.");
	assert.equal(reservation.pickedRoomsPricing?.length, 1, "Exactly one unmapped pricing room block is required.");
	for (const [field, rooms] of [["pickedRoomsType", reservation.pickedRoomsType], ["pickedRoomsPricing", reservation.pickedRoomsPricing]]) {
		const room = rooms[0];
		assert.equal(room.room_type, target.roomType, `${field}[0].room_type`);
		assert.equal(own(room, "hotelRoomConfigId"), false, `${field}[0] must not have a hotelRoomConfigId field.`);
		assert.equal(own(room, "roomId"), false, `${field}[0] must not have a nested roomId field.`);
		assert.equal(own(room, "otaMatchedRoomName"), false, `${field}[0] must not have otaMatchedRoomName.`);
		assert.equal(own(room, "otaRoomMatchReason"), false, `${field}[0] must not have otaRoomMatchReason.`);
		assert.equal(own(room, "otaRoomMatchedByModel"), false, `${field}[0] must not have otaRoomMatchedByModel.`);
		assert.equal(String(room.otaRoomMatchType || ""), "", `${field}[0].otaRoomMatchType`);
		assertMoney(room.otaRoomMatchScore, 0, `${field}[0].otaRoomMatchScore`);
		assert.equal(room.adminPricing ?? null, null, `${field}[0].adminPricing must be absent before recovery.`);
		assertMoney(room.subTotal, 0, `${field}[0].subTotal`);
		assertMoney(room.platformMargin, 0, `${field}[0].platformMargin`);
		assert.equal(Number(room.count), 1, `${field}[0].count`);
		assert.equal(room.pricingByDay?.length, target.nights, `${field}[0].pricingByDay length`);
		assert.match(String(room.displayName || room.sourceRoomName || ""), /family|عائل/i, `${field}[0] must preserve the source family-room wording.`);
		assertMoney(room.hotelShouldGet, 0, `${field}[0].hotelShouldGet`);
		for (const day of room.pricingByDay || []) {
			assertMoney(day.rootPrice, 0, `${field} ${day.date} rootPrice`);
			assertMoney(day.totalPriceWithoutCommission, 0, `${field} ${day.date} totalPriceWithoutCommission`);
			assertMoney(day.commissionRate, 0, `${field} ${day.date} commissionRate`);
			assertMoney(day.platformMargin, 0, `${field} ${day.date} platformMargin`);
		}
	}
	assertNoSettlementOrCapture(reservation);
	return reservation;
};

const validateHotelDocument = (hotel, target) => {
	assert.ok(hotel && typeof hotel === "object", `Hotel evidence is required for ${target.otaConfirmation}.`);
	assert.equal(id(hotel), target.hotelId, "hotel._id");
	assert.equal(id(hotel.belongsTo), target.ownerId, "hotel.belongsTo");
	assert.equal(hotel.activateHotel, true, "hotel.activateHotel");
	assert.notEqual(hotel.xHotelProActive, false, "hotel.xHotelProActive");
	assert.equal(normalize(hotel.hotelName), EXPECTED_HOTEL_NAME, "hotel.hotelName");
	return hotel;
};

const validateReservationDocument = (reservation, target) => {
	assert.ok(reservation && typeof reservation === "object", `Missing reservation ${target.mongoId}.`);
	if (target.kind === "pricing") return validatePricingReservation(reservation, target);
	if (target.kind === "cancellation") return validateCancellationReservation(reservation, target);
	if (target.kind === "hotel_assignment") return validateUnassignedHotelReservation(reservation, target);
	throw new Error(`Unsupported reservation target kind: ${target.kind}`);
};

const validateAuditDocument = (audit, target, expected) => {
	assert.ok(audit && typeof audit === "object", `Missing inbound audit ${expected.id}.`);
	assert.equal(id(audit), expected.id, `${expected.id}._id`);
	assert.equal(String(audit.emailHash || ""), expected.emailHash, `${expected.id}.emailHash`);
	assert.equal(String(audit.textHash || ""), expected.textHash, `${expected.id}.textHash`);
	assert.equal(String(audit.provider || "").toLowerCase(), expected.provider, `${expected.id}.provider`);
	assert.equal(String(audit.processingStatus || "").toLowerCase(), expected.processingStatus, `${expected.id}.processingStatus`);
	assert.equal(String(audit.automationAction || "").toLowerCase(), expected.automationAction, `${expected.id}.automationAction`);
	assert.equal(String(audit.skipReason || "").toLowerCase(), expected.skipReason, `${expected.id}.skipReason`);
	assert.equal(String(audit.reconciliation?.status || "").toLowerCase(), expected.processingStatus, `${expected.id}.reconciliation.status`);
	assert.equal(String(audit.reconciliation?.actionTaken || "").toLowerCase(), expected.automationAction, `${expected.id}.reconciliation.actionTaken`);
	assert.equal(String(audit.reconciliation?.skipReason || "").toLowerCase(), expected.skipReason, `${expected.id}.reconciliation.skipReason`);
	if (expected.trustedProvider) {
		assert.equal(audit.senderAuthentication?.authenticatedAligned, true, `${expected.id} must be authenticated and aligned.`);
		assert.equal(String(audit.senderAuthentication?.trustedProvider || "").toLowerCase(), expected.trustedProvider, `${expected.id}.senderAuthentication.trustedProvider`);
		assert.equal(audit.normalizedReservation?.sourceSenderTrusted, true, `${expected.id} normalized source must be trusted.`);
		assert.equal(audit.normalizedReservation?.sourceSenderAuthenticated, true, `${expected.id} normalized source must be authenticated.`);
	}
	if (expected.sourceReceivedAt) {
		assertDate(audit.normalizedReservation?.source?.receivedAt, expected.sourceReceivedAt, `${expected.id}.normalizedReservation.source.receivedAt`);
	}
	if (expected.receivedAt) assertDate(audit.receivedAt, expected.receivedAt, `${expected.id}.receivedAt`);

	if (target.mongoId) {
		assert.equal(String(audit.confirmationNumber || "").toLowerCase(), target.otaConfirmation, `${expected.id}.confirmationNumber`);
		assert.equal(String(audit.normalizedReservation?.confirmationNumber || "").toLowerCase(), target.otaConfirmation, `${expected.id}.normalizedReservation.confirmationNumber`);
		assert.equal(String(audit.normalizedReservation?.provider || "").toLowerCase(), expected.provider, `${expected.id}.normalizedReservation.provider`);
		assert.equal(id(audit.reservationMongoId), target.mongoId, `${expected.id}.reservationMongoId`);
		assert.equal(String(audit.pmsConfirmationNumber || ""), target.pmsConfirmation, `${expected.id}.pmsConfirmationNumber`);
		assert.equal(audit.hasReservationConnection, true, `${expected.id}.hasReservationConnection`);
		assert.equal(id(audit.reconciliation?.reservationId), target.mongoId, `${expected.id}.reconciliation.reservationId`);
		assert.equal(String(audit.reconciliation?.pmsConfirmationNumber || ""), target.pmsConfirmation, `${expected.id}.reconciliation.pmsConfirmationNumber`);
		if (target.kind !== "hotel_assignment") {
			assert.equal(id(audit.reconciliation?.hotelId), target.hotelId, `${expected.id}.reconciliation.hotelId`);
		}
		if (!(target.kind === "cancellation" && expected.role === "authoritative_cancellation")) {
			assertDateKey(audit.normalizedReservation?.checkinDate, target.checkinDate, `${expected.id}.normalizedReservation.checkinDate`);
			assertDateKey(audit.normalizedReservation?.checkoutDate, target.checkoutDate, `${expected.id}.normalizedReservation.checkoutDate`);
		}
	}
	if (target.kind === "cancellation" && expected.role === "authoritative_cancellation") {
		assert.equal(audit.normalizedReservation?.intent, "reservation_status", `${expected.id}.intent`);
		assert.equal(audit.normalizedReservation?.eventType, "cancelled", `${expected.id}.eventType`);
		assert.equal(audit.normalizedReservation?.statusToApply, "cancelled", `${expected.id}.statusToApply`);
		// The status email intentionally carries no hotel/stay block; those facts
		// are anchored by the immutable creation audit and current reservation.
		assert.equal(Boolean(audit.normalizedReservation?.hotelName), false, `${expected.id} unexpectedly supplied hotel data.`);
		assert.equal(Boolean(audit.normalizedReservation?.checkinDate), false, `${expected.id} unexpectedly supplied check-in data.`);
		assert.ok(dateIso(audit.processedAt), `${expected.id}.processedAt must be a valid saved processing timestamp.`);
	}
	if (target.kind === "pricing" && expected.role === "authoritative_direct_pricing") {
		const normalized = audit.normalizedReservation || {};
		const paymentSummary = normalized.paymentSummary || {};
		assertMoney(normalized.totalAmountSar, target.corrected.clientSar, `${expected.id} direct guest total`);
		assertMoney(normalized.totalPayoutSar, target.corrected.payoutSar, `${expected.id} direct payout total`);
		assertMoney(normalized.amount, target.corrected.clientSource, `${expected.id} direct source amount`);
		assert.equal(String(normalized.currency || "").toUpperCase(), target.currency, `${expected.id}.currency`);
		assert.equal(String(normalized.sourceCurrency || "").toUpperCase(), target.currency, `${expected.id}.sourceCurrency`);
		assertMoney(normalized.exchangeRateToSar, target.exchangeRate, `${expected.id}.exchangeRateToSar`);
		assert.equal(normalized.exchangeRateSource, target.exchangeRateSource, `${expected.id}.exchangeRateSource`);
		assertDate(normalized.amountConvertedAt, target.amountConvertedAt, `${expected.id}.amountConvertedAt`);
		assert.equal(normalized.paymentCollectionModel, "ota_collect", `${expected.id}.paymentCollectionModel`);
		assert.equal(normalized.paymentInstructions, target.paymentInstructions, `${expected.id}.paymentInstructions`);
		assert.equal(String(paymentSummary.sourceCurrency || "").toUpperCase(), target.currency, `${expected.id}.paymentSummary.sourceCurrency`);
		assertMoney(paymentSummary.sourceTotalGuestPaymentAmount, target.corrected.clientSource, `${expected.id}.paymentSummary.sourceTotalGuestPaymentAmount`);
		assertMoney(paymentSummary.sourceTotalPayoutAmount, target.corrected.payoutSource, `${expected.id}.paymentSummary.sourceTotalPayoutAmount`);
		assertMoney(paymentSummary.totalGuestPaymentAmount, target.corrected.clientSar, `${expected.id}.paymentSummary.totalGuestPaymentAmount`);
		assertMoney(paymentSummary.totalPayoutAmount, target.corrected.payoutSar, `${expected.id}.paymentSummary.totalPayoutAmount`);
		assert.equal(String(paymentSummary.currency || "").toUpperCase(), "SAR", `${expected.id}.paymentSummary.currency`);
		assertMoney(paymentSummary.exchangeRateToSar, target.exchangeRate, `${expected.id}.paymentSummary.exchangeRateToSar`);
		assert.equal(paymentSummary.exchangeRateSource, target.exchangeRateSource, `${expected.id}.paymentSummary.exchangeRateSource`);
		assertDate(paymentSummary.amountConvertedAt, target.amountConvertedAt, `${expected.id}.paymentSummary.amountConvertedAt`);
	}
	if (target.kind === "pricing" && expected.role === "creating_relay_evidence") {
		assertMoney(audit.normalizedReservation?.totalAmountSar, target.old.clientSar, `${expected.id} relay guest total`);
		assertMoney(audit.normalizedReservation?.amount, target.old.sourceAmount, `${expected.id} relay source amount`);
	}
	if (target.kind === "hotel_assignment" && expected.role === "creating_unmapped_reservation") {
		assert.equal(id(audit.hotelId), "", `${expected.id}.hotelId must still be empty.`);
		assert.equal(id(audit.reconciliation?.hotelId), "", `${expected.id}.reconciliation.hotelId must still be empty.`);
		assertMoney(audit.normalizedReservation?.totalAmountSar, target.clientTotal, `${expected.id} creation guest total`);
		assert.equal(normalize(audit.normalizedReservation?.hotelName), EXPECTED_HOTEL_NAME, `${expected.id} source hotel name`);
	}
	if (target.kind === "hotel_assignment" && expected.role === "authoritative_direct_pricing") {
		assert.equal(id(audit.hotelId), "", `${expected.id}.hotelId must still be empty.`);
		assert.equal(id(audit.reconciliation?.hotelId), "", `${expected.id}.reconciliation.hotelId must still be empty.`);
		assertMoney(audit.normalizedReservation?.amount, target.corrected.clientSource, `${expected.id} direct source guest total`);
		assertMoney(audit.normalizedReservation?.totalAmountSar, target.corrected.clientSar, `${expected.id} direct guest total SAR`);
		assertMoney(audit.normalizedReservation?.totalPayoutSar, target.corrected.payoutSar, `${expected.id} direct payout total SAR`);
		assert.equal(audit.normalizedReservation?.paymentCollectionModel, "ota_collect", `${expected.id}.paymentCollectionModel`);
		assert.equal(audit.normalizedReservation?.paymentInstructions, target.paymentInstructions, `${expected.id}.paymentInstructions`);
		assertMoney(audit.normalizedReservation?.exchangeRateToSar, 1, `${expected.id}.exchangeRateToSar`);
		assert.equal(audit.normalizedReservation?.exchangeRateSource, "identity", `${expected.id}.exchangeRateSource`);
		assertDate(audit.normalizedReservation?.amountConvertedAt, target.corrected.amountConvertedAt, `${expected.id}.amountConvertedAt`);
		assertMoney(audit.normalizedReservation?.paymentSummary?.sourceTotalGuestPaymentAmount, target.corrected.clientSource, `${expected.id}.paymentSummary source guest total`);
		assertMoney(audit.normalizedReservation?.paymentSummary?.sourceTotalPayoutAmount, target.corrected.payoutSource, `${expected.id}.paymentSummary source payout`);
		assert.ok(
			[audit.normalizedReservation?.hotelName, ...(audit.normalizedReservation?.hotelNameAliases || [])]
				.some((name) => normalize(name) === EXPECTED_HOTEL_NAME),
			`${expected.id} does not carry an exact normalized Zad Ajyad alias.`,
		);
	}
	if (target.kind === "cancellation" && expected.role === "creation_identity_and_stay_evidence") {
		assertMoney(audit.normalizedReservation?.totalAmountSar, 388.8, `${expected.id} creation source guest total`);
		assert.equal(id(audit.hotelId), target.hotelId, `${expected.id}.hotelId`);
	}
	if (target.kind === "audit_only") {
		assert.equal(audit.hasReservationConnection, false, `${expected.id} must remain unlinked.`);
		assert.equal(id(audit.reservationMongoId), "", `${expected.id}.reservationMongoId must be empty.`);
		assert.equal(id(audit.hotelId), "", `${expected.id}.hotelId must be empty.`);
		assert.equal(String(audit.pmsConfirmationNumber || ""), "", `${expected.id}.pmsConfirmationNumber must be empty.`);
	}
	return audit;
};

const validateAuditSet = (audits, target) => {
	assert.ok(Array.isArray(audits), "audits must be an array.");
	assert.equal(audits.length, target.audits.length, `Exactly ${target.audits.length} audit documents are required for this target; newer or unknown matching audits must abort preflight.`);
	const byId = new Map(audits.map((audit) => [id(audit), audit]));
	assert.equal(byId.size, target.audits.length, "Audit IDs must be unique.");
	for (const expected of target.audits) validateAuditDocument(byId.get(expected.id), target, expected);
	return byId;
};

const correctedPricingRoom = (room, target) => {
	const next = cloneBson(room);
	next.chosenPrice = target.corrected.chosenPrice;
	next.totalPriceWithCommission = target.corrected.clientSar;
	next.hotelShouldGet = target.corrected.rootSar;
	next.pricingByDay = target.daily.map((expected, index) => {
		const day = cloneBson(room.pricingByDay[index]);
		assert.equal(String(day.date), expected.date, `pricingByDay[${index}].date`);
		return {
			...day,
			price: expected.client,
			clientPrice: expected.client,
			mainPrice: expected.client,
			rootPrice: expected.root,
			totalPriceWithCommission: expected.client,
			totalPriceWithoutCommission: expected.root,
			netAfterExpenses: expected.payout,
			netAfterOtaExpenses: expected.payout,
			otaExpenseAmount: expected.expense,
			platformMargin: expected.margin,
		};
	});
	return next;
};

const correctedPaymentSummary = (target) => ({
	sourceCurrency: target.currency,
	sourceTotalGuestPaymentAmount: target.corrected.clientSource,
	sourceTotalPayoutAmount: target.corrected.payoutSource,
	totalGuestPaymentAmount: target.corrected.clientSar,
	totalPayoutAmount: target.corrected.payoutSar,
	currency: "SAR",
	exchangeRateToSar: target.exchangeRate,
	exchangeRateSource: target.exchangeRateSource,
	amountConvertedAt: new Date(target.amountConvertedAt),
});

const buildRepairAuditLogEntry = ({ targetKey, target, context, action }) => ({
	at: new Date(context.repairAt),
	source: REPAIR_SOURCE,
	action,
	repairId: context.repairId,
	backupCollection: context.backupCollection,
	reservationId: target.otaConfirmation,
	pmsConfirmationNumber: target.pmsConfirmation,
	evidenceAuditIds: target.audits.map((audit) => audit.id),
	targetKey,
});

const pricingProtectedSnapshot = (reservation) => ({
	identity: {
		_id: reservation._id,
		confirmation_number: reservation.confirmation_number,
		reservation_id: reservation.reservation_id,
		otaIdentityKey: reservation.otaIdentityKey,
		otaCrossTransportIdentityKey: reservation.otaCrossTransportIdentityKey,
		hotelId: reservation.hotelId,
		belongsTo: reservation.belongsTo,
		customerConfirmation: reservation.customer_details?.confirmation_number2,
		supplierConfirmations: {
			suppliedBookingNo: reservation.supplierData?.suppliedBookingNo,
			otaConfirmationNumber: reservation.supplierData?.otaConfirmationNumber,
			platformConfirmationNumber: reservation.supplierData?.platformConfirmationNumber,
			pmsConfirmationNumber: reservation.supplierData?.pmsConfirmationNumber,
		},
		checkin_date: reservation.checkin_date,
		checkout_date: reservation.checkout_date,
		booked_at: reservation.booked_at,
		days_of_residence: reservation.days_of_residence,
		total_rooms: reservation.total_rooms,
		roomId: reservation.roomId,
		availabilitySnapshot: reservation.availabilitySnapshot,
	},
	rootAndCommission: {
		sub_total: reservation.sub_total,
		commission: reservation.commission,
		adminRoot: reservation.adminPricing?.rootTotal,
		adminCommission: reservation.adminPricing?.commissionAmount,
		cycleHotelPayoutDue: reservation.financial_cycle?.hotelPayoutDue,
		cycleCommissionValue: reservation.financial_cycle?.commissionValue,
		cycleCommissionAmount: reservation.financial_cycle?.commissionAmount,
		cycleCommissionAssigned: reservation.financial_cycle?.commissionAssigned,
	},
	roomIdentityAndRoot: (reservation.pickedRoomsType || []).map((room) => ({
		room_type: room.room_type,
		displayName: room.displayName,
		hotelRoomConfigId: room.hotelRoomConfigId,
		sourceRoomName: room.sourceRoomName,
		otaRoomMatchType: room.otaRoomMatchType,
		otaRoomMatchScore: room.otaRoomMatchScore,
		count: room.count,
		rootRows: (room.pricingByDay || []).map((day) => ({
			date: day.date,
			rootPrice: day.rootPrice,
			totalPriceWithoutCommission: day.totalPriceWithoutCommission,
			commissionRate: day.commissionRate,
		})),
	})),
	processorAndSettlement: {
		payment_details: reservation.payment_details,
		vcc_payment: reservation.vcc_payment,
		bofa_payment: reservation.bofa_payment,
		braintree_payment: reservation.braintree_payment,
		paypal_details: reservation.paypal_details,
		moneyTransferredToHotel: reservation.moneyTransferredToHotel,
		commissionPaid: reservation.commissionPaid,
		moneyTransferredAt: reservation.moneyTransferredAt,
		commissionPaidAt: reservation.commissionPaidAt,
		commissionData: reservation.commissionData,
		commissionStatus: reservation.commissionStatus,
		adminChangeLog: reservation.adminChangeLog,
	},
});

const buildPricingUpdate = ({ reservation, targetKey, target, directAudit, context }) => {
	const rooms = reservation.pickedRoomsType.map((room) => correctedPricingRoom(room, target));
	const pricingRooms = reservation.pickedRoomsPricing.map((room) => correctedPricingRoom(room, target));
	assert.ok(canonicalEqual(rooms, pricingRooms), "Corrected persisted room arrays diverged.");
	const paymentSummary = correctedPaymentSummary(target);
	const adminPricing = {
		...cloneBson(reservation.adminPricing || {}),
		clientTotal: target.corrected.clientSar,
		rootTotal: target.corrected.rootSar,
		netAfterExpensesTotal: target.corrected.payoutSar,
		otaExpenseTotal: target.corrected.expenseSar,
		platformMarginTotal: target.corrected.marginSar,
		commissionAmount: target.corrected.commissionSar,
		defaultDeductionApplied: false,
		provider: target.transportProvider,
		providerLabel: target.providerLabel,
		sourceCurrency: target.currency,
		sourceAmount: target.corrected.clientSource,
		sourceExchangeRateToSar: target.exchangeRate,
		sourceExchangeRateSource: target.exchangeRateSource,
		exchangeRateToSar: target.exchangeRate,
		exchangeRateSource: target.exchangeRateSource,
		amountConvertedAt: new Date(target.amountConvertedAt),
		sourceClientTotalSar: target.corrected.clientSar,
		sourceClientTotalSource: target.sourceClientTotalSource,
		sourceClientTotalLockedAt: new Date(context.repairAt),
		payoutFallbackReason: "",
	};
	const supplierData = {
		...cloneBson(reservation.supplierData || {}),
		supplierName: target.providerLabel,
		otaProvider: target.transportProvider,
		otaSourceAuthority: 3,
		otaAmount: target.corrected.clientSource,
		otaAmountSar: target.corrected.clientSar,
		otaSourceCurrency: target.currency,
		otaSourceAmount: target.corrected.clientSource,
		otaSourceExchangeRateToSar: target.exchangeRate,
		otaSourceExchangeRateSource: target.exchangeRateSource,
		otaPaymentSummary: paymentSummary,
		otaPayoutFallbackReason: "",
		otaTotalPayoutSar: target.corrected.payoutSar,
		otaExpenseTotalSar: target.corrected.expenseSar,
		otaPlatformMarginSar: target.corrected.marginSar,
		otaExchangeRateToSar: target.exchangeRate,
		otaExchangeRateSource: target.exchangeRateSource,
		otaAmountConvertedAt: new Date(target.amountConvertedAt),
		otaPaymentCollectionModel: "ota_collect",
		otaPaymentInstructions: target.paymentInstructions,
		otaLastInboundEmailId: directAudit.id,
		otaLastEmailAt: new Date(context.repairAt),
		// The direct source predates the relay within the bounded skew.  The
		// higher-authority facts are applied without moving the ordering watermark
		// backwards.
		otaLastSourceReceivedAt: new Date(target.relayWatermark),
		otaLastEventType: "new",
	};
	const financialSummary = {
		...cloneBson(reservation.ota_financial_summary || {}),
		show: true,
		provider: target.transportProvider,
		providerLabel: target.providerLabel,
		currency: "SAR",
		clientTotal: target.corrected.clientSar,
		hotelVisibleAmount: target.corrected.rootSar,
		netAfterExpenses: target.corrected.payoutSar,
		netAfterOtaExpenses: target.corrected.payoutSar,
		otaExpenseTotal: target.corrected.expenseSar,
		platformProfit: target.corrected.marginSar,
		commissionAmount: target.corrected.commissionSar,
		sourceCurrency: target.currency,
		sourceAmount: target.corrected.clientSource,
		sourceExchangeRateToSar: target.exchangeRate,
		sourceExchangeRateSource: target.exchangeRateSource,
		paymentSummary,
		payoutFallbackReason: "",
	};
	const paidBreakdown = {
		...cloneBson(reservation.paid_amount_breakdown || {}),
		paid_online_other_platforms: target.corrected.clientSar,
		payment_comments: target.paymentComment,
	};
	const financialCycle = {
		...cloneBson(reservation.financial_cycle || {}),
		pmsCollectedAmount: target.corrected.clientSar,
		hotelPayoutDue: target.corrected.rootSar,
		lastUpdatedAt: new Date(context.repairAt),
	};
	const review = {
		...cloneBson(reservation.otaPlatformReview || {}),
		status: "pending",
		provider: target.transportProvider,
		providerLabel: target.providerLabel,
		inboundEmailId: directAudit.id,
		lastPricingUpdatedAt: new Date(context.repairAt),
		lastUpdatedAt: new Date(context.repairAt),
	};
	return {
		$set: {
			booking_source: target.bookingSource,
			"customer_details.booking_source": target.providerLabel,
			pickedRoomsType: rooms,
			pickedRoomsPricing: pricingRooms,
			total_amount: target.corrected.clientSar,
			paid_amount: target.corrected.clientSar,
			paid_amount_breakdown: paidBreakdown,
			adminPricing,
			ota_financial_summary: financialSummary,
			supplierData,
			otaPlatformReview: review,
			financial_cycle: financialCycle,
			updatedAt: new Date(context.repairAt),
			reservationAuditLog: [
				...(Array.isArray(reservation.reservationAuditLog) ? cloneBson(reservation.reservationAuditLog) : []),
				buildRepairAuditLogEntry({ targetKey, target, context, action: "authoritative-direct-ota-pricing-correction" }),
			],
		},
		$inc: { __v: 1 },
	};
};

const CANCELLATION_MUTABLE_PATHS = Object.freeze([
	"state",
	"reservation_status",
	"cancel_reason",
	"pendingConfirmation.status",
	"pendingConfirmation.rejectionReason",
	"pendingConfirmation.confirmationReason",
	"pendingConfirmation.confirmedAt",
	"pendingConfirmation.rejectedAt",
	"pendingConfirmation.cancelledAt",
	"pendingConfirmation.noShowAt",
	"pendingConfirmation.lastUpdatedAt",
	"pendingConfirmation.lastUpdatedBy",
	"pendingConfirmation.source",
	"agentDecisionSnapshot.status",
	"agentDecisionSnapshot.reason",
	"agentDecisionSnapshot.decidedAt",
	"agentDecisionSnapshot.decidedBy",
	"agentDecisionSnapshot.source",
	"otaPlatformReview.status",
	"otaPlatformReview.closedAt",
	"otaPlatformReview.closedReason",
	"otaPlatformReview.lastUpdatedAt",
	"supplierData.otaLastInboundEmailId",
	"supplierData.otaLastEmailAt",
	"supplierData.otaLastSourceReceivedAt",
	"supplierData.otaLastEventType",
	"reservationAuditLog",
	"updatedAt",
	"__v",
]);

const cancellationProtectedSnapshot = (reservation) =>
	withoutPaths(reservation, CANCELLATION_MUTABLE_PATHS);

const buildCancellationUpdate = ({ reservation, targetKey, target, cancellationAudit, context }) => {
	const processedAt = dateIso(cancellationAudit?.processedAt);
	assert.ok(processedAt, "The authoritative cancellation audit requires a valid saved processedAt timestamp.");
	const at = new Date(processedAt);
	const repairAt = new Date(context.repairAt);
	const actor = { name: "OTA inbound automation", role: "system" };
	return {
		$set: {
			state: "cancelled",
			reservation_status: "cancelled",
			cancel_reason: "Airbnb status email",
			pendingConfirmation: {
				...cloneBson(reservation.pendingConfirmation || {}),
				status: "cancelled",
				rejectionReason: "Airbnb cancellation email received.",
				confirmationReason: "",
				confirmedAt: null,
				rejectedAt: null,
				cancelledAt: at,
				noShowAt: null,
				lastUpdatedAt: at,
				lastUpdatedBy: actor,
				source: "ota_email_status",
			},
			agentDecisionSnapshot: {
				...cloneBson(reservation.agentDecisionSnapshot || {}),
				status: "cancelled",
				reason: "Airbnb status email",
				decidedAt: at,
				decidedBy: actor,
				source: "ota_email_status",
			},
			"otaPlatformReview.status": "closed",
			"otaPlatformReview.closedAt": at,
			"otaPlatformReview.closedReason": "ota_status_cancelled",
			"otaPlatformReview.lastUpdatedAt": at,
			"supplierData.otaLastInboundEmailId": id(cancellationAudit),
			"supplierData.otaLastEmailAt": at,
			"supplierData.otaLastSourceReceivedAt": new Date(cancellationAudit.normalizedReservation.source.receivedAt),
			"supplierData.otaLastEventType": "cancelled",
			reservationAuditLog: [
				...(Array.isArray(reservation.reservationAuditLog) ? cloneBson(reservation.reservationAuditLog) : []),
				buildRepairAuditLogEntry({ targetKey, target, context, action: "authoritative-ota-cancellation" }),
			],
			updatedAt: repairAt,
		},
		$inc: { __v: 1 },
	};
};

const HOTEL_ASSIGNMENT_MUTABLE_PATHS = Object.freeze([
	"hotelId",
	"belongsTo",
	"roomId",
	"pickedRoomsType",
	"pickedRoomsPricing",
	"total_amount",
	"paid_amount",
	"paid_amount_breakdown",
	"sub_total",
	"commission",
	"adminPricing",
	"ota_financial_summary",
	"otaPlatformReview",
	"supplierData",
	"financial_cycle",
	"reservationAuditLog",
	"updatedAt",
	"__v",
]);

const hotelAssignmentProtectedSnapshot = (reservation) =>
	withoutPaths(reservation, HOTEL_ASSIGNMENT_MUTABLE_PATHS);

const unmappedRoom = (room, target) => {
	const next = cloneBson(room);
	delete next.hotelRoomConfigId;
	delete next.roomId;
	delete next.otaMatchedRoomName;
	delete next.otaRoomMatchReason;
	delete next.otaRoomMatchedByModel;
	next.otaRoomMatchType = "";
	next.otaRoomMatchScore = 0;
	next.chosenPrice = target.corrected.chosenPrice;
	next.totalPriceWithCommission = target.corrected.clientSar;
	next.hotelShouldGet = 0;
	if (own(next, "subTotal")) next.subTotal = 0;
	if (own(next, "platformMargin")) next.platformMargin = 0;
	if (next.adminPricing && typeof next.adminPricing === "object") {
		next.adminPricing = {
			...next.adminPricing,
			clientTotal: target.corrected.clientSar,
			rootTotal: 0,
			netAfterExpensesTotal: target.corrected.payoutSar,
			otaExpenseTotal: target.corrected.expenseSar,
			platformMarginTotal: 0,
			commissionAmount: 0,
		};
	}
	assert.equal(next.pricingByDay?.length, target.daily.length, "Unmapped room nightly row count changed.");
	next.pricingByDay = target.daily.map((expected, index) => {
		const day = cloneBson(next.pricingByDay[index]);
		assert.equal(String(day.date), expected.date, `Unmapped pricingByDay[${index}].date`);
		return {
			...day,
			price: expected.client,
			clientPrice: expected.client,
			mainPrice: expected.client,
			rootPrice: 0,
			commissionRate: 0,
			totalPriceWithCommission: expected.client,
			totalPriceWithoutCommission: 0,
			netAfterExpenses: expected.payout,
			netAfterOtaExpenses: expected.payout,
			otaExpenseAmount: expected.expense,
			platformMargin: 0,
			platformMarginRate: 0,
		};
	});
	return next;
};

const buildHotelAssignmentUpdate = ({ reservation, targetKey, target, hotel, context }) => {
	const at = new Date(context.repairAt);
	const assignedHotelName = String(hotel.hotelName || hotel.hotelName_OtherLanguage || "").trim();
	const actor = { name: "OTA inbound exact hotel resolver", role: "system" };
	const directAudit = target.audits.find((audit) => audit.role === "authoritative_direct_pricing");
	assert.ok(directAudit, `${targetKey} requires an authoritative direct pricing audit.`);
	const rooms = (reservation.pickedRoomsType || []).map((room) => unmappedRoom(room, target));
	const pricingRooms = (reservation.pickedRoomsPricing || []).map((room) => unmappedRoom(room, target));
	assert.ok(canonicalEqual(rooms, pricingRooms), "Unmapped room arrays must remain identical.");
	const paymentSummary = {
		sourceCurrency: "SAR",
		sourceTotalGuestPaymentAmount: target.corrected.clientSource,
		sourceTotalPayoutAmount: target.corrected.payoutSource,
		totalGuestPaymentAmount: target.corrected.clientSar,
		totalPayoutAmount: target.corrected.payoutSar,
		currency: "SAR",
		exchangeRateToSar: 1,
		exchangeRateSource: "identity",
		amountConvertedAt: new Date(target.corrected.amountConvertedAt),
	};
	return {
		$set: {
			hotelId: cloneBson(hotel._id),
			belongsTo: cloneBson(hotel.belongsTo),
			roomId: [],
			pickedRoomsType: rooms,
			pickedRoomsPricing: pricingRooms,
			total_amount: target.corrected.clientSar,
			paid_amount: target.corrected.clientSar,
			paid_amount_breakdown: {
				...cloneBson(reservation.paid_amount_breakdown || {}),
				paid_online_other_platforms: target.corrected.clientSar,
				payment_comments: target.paymentComment,
			},
			sub_total: 0,
			commission: 0,
			adminPricing: {
				...cloneBson(reservation.adminPricing || {}),
				mode: "ota_assignment_pending_pricing",
				clientTotal: target.corrected.clientSar,
				rootTotal: 0,
				netAfterExpensesTotal: target.corrected.payoutSar,
				otaExpenseTotal: target.corrected.expenseSar,
				platformMarginTotal: 0,
				commissionAmount: 0,
				defaultDeductionApplied: false,
				provider: "agoda",
				providerLabel: "Agoda",
				sourceCurrency: "SAR",
				sourceAmount: target.corrected.clientSource,
				sourceExchangeRateToSar: 1,
				sourceExchangeRateSource: "identity",
				exchangeRateToSar: 1,
				exchangeRateSource: "identity",
				amountConvertedAt: new Date(target.corrected.amountConvertedAt),
				sourceClientTotalSar: target.corrected.clientSar,
				sourceClientTotalSource: target.sourceClientTotalSource,
				sourceClientTotalLockedAt: at,
				payoutFallbackReason: "",
				pricingReviewRequired: true,
				hotelAssignmentRequired: false,
				assignedHotelId: target.hotelId,
				assignedHotelName,
			},
			ota_financial_summary: {
				...cloneBson(reservation.ota_financial_summary || {}),
				show: true,
				provider: "agoda",
				providerLabel: "Agoda",
				currency: "SAR",
				clientTotal: target.corrected.clientSar,
				hotelVisibleAmount: 0,
				netAfterExpenses: target.corrected.payoutSar,
				netAfterOtaExpenses: target.corrected.payoutSar,
				otaExpenseTotal: target.corrected.expenseSar,
				platformProfit: 0,
				commissionAmount: 0,
				sourceCurrency: "SAR",
				sourceAmount: target.corrected.clientSource,
				sourceExchangeRateToSar: 1,
				sourceExchangeRateSource: "identity",
				paymentSummary,
				payoutFallbackReason: "",
			},
			otaPlatformReview: {
				...cloneBson(reservation.otaPlatformReview || {}),
				status: "pending",
				hotelAssignmentRequired: false,
				hotelAssignmentStatus: "assigned",
				assignedHotelId: target.hotelId,
				assignedHotelName,
				assignedAt: at,
				assignedBy: actor,
				roomMappingStatus: "unreviewed",
				roomMappingHotelId: "",
				pricingInvalidatedAt: at,
				pricingInvalidationReason: "exact_hotel_assignment_requires_room_pricing_review",
				inboundEmailId: directAudit.id,
				lastPricingUpdatedAt: at,
				lastUpdatedAt: at,
			},
			supplierData: {
				...cloneBson(reservation.supplierData || {}),
				supplierName: "Agoda",
				otaProvider: "agoda",
				otaSourceAuthority: 3,
				otaAmount: target.corrected.clientSource,
				otaAmountSar: target.corrected.clientSar,
				otaSourceCurrency: "SAR",
				otaSourceAmount: target.corrected.clientSource,
				otaSourceExchangeRateToSar: 1,
				otaSourceExchangeRateSource: "identity",
				otaPaymentSummary: paymentSummary,
				otaPayoutFallbackReason: "",
				otaTotalPayoutSar: target.corrected.payoutSar,
				otaExpenseTotalSar: target.corrected.expenseSar,
				otaPlatformMarginSar: 0,
				otaExchangeRateToSar: 1,
				otaExchangeRateSource: "identity",
				otaAmountConvertedAt: new Date(target.corrected.amountConvertedAt),
				otaPaymentCollectionModel: "ota_collect",
				otaPaymentInstructions: target.paymentInstructions,
				otaLastInboundEmailId: directAudit.id,
				otaLastEmailAt: at,
				otaLastSourceReceivedAt: new Date(target.relayWatermark),
				otaLastEventType: "new",
				otaHotelMappingRequired: false,
				otaAssignedHotelId: target.hotelId,
				otaAssignedHotelName: assignedHotelName,
				otaAssignedHotelAt: at,
				otaAssignedHotelBy: actor,
				otaMatchedRoomName: "",
				otaHotelRoomConfigId: null,
				otaRoomMatchScore: 0,
				otaRoomMatchType: "",
				otaRoomMatchReason: "",
				otaRoomMatchedByModel: "",
			},
			financial_cycle: {
				...cloneBson(reservation.financial_cycle || {}),
				collectionModel: "pms_collected",
				status: "open",
				commissionType: "amount",
				commissionValue: 0,
				commissionAmount: 0,
				commissionAssigned: false,
				pmsCollectedAmount: target.corrected.clientSar,
				hotelCollectedAmount: 0,
				hotelPayoutDue: 0,
				commissionDueToPms: 0,
				lastUpdatedAt: at,
			},
			reservationAuditLog: [
				...(Array.isArray(reservation.reservationAuditLog) ? cloneBson(reservation.reservationAuditLog) : []),
				buildRepairAuditLogEntry({ targetKey, target, context, action: "exact-hotel-assigned-room-unmapped" }),
			],
			updatedAt: at,
		},
		$inc: { __v: 1 },
	};
};

const AUDIT_MUTABLE_PATHS = Object.freeze([
	"processingStatus",
	"automationAction",
	"skipReason",
	"automationComment",
	"hotelId",
	"reservationMongoId",
	"pmsConfirmationNumber",
	"hasReservationConnection",
	"reconciliation",
	"reconcileWarnings",
	"reconcileErrors",
	"updatedAt",
]);

const auditEvidenceSnapshot = (audit) => ({
	_id: audit._id,
	source: audit.source,
	provider: audit.provider,
	providerLabel: audit.providerLabel,
	intent: audit.intent,
	eventType: audit.eventType,
	from: audit.from,
	to: audit.to,
	cc: audit.cc,
	bcc: audit.bcc,
	subject: audit.subject,
	messageId: audit.messageId,
	emailHash: audit.emailHash,
	textHash: audit.textHash,
	dedupeKey: audit.dedupeKey,
	duplicateOf: audit.duplicateOf,
	bodyText: audit.bodyText,
	bodyHtml: audit.bodyHtml,
	safeSnippet: audit.safeSnippet,
	attachments: audit.attachments,
	senderAuthentication: audit.senderAuthentication,
	confirmationNumber: audit.confirmationNumber,
	hotelName: audit.hotelName,
	roomName: audit.roomName,
	sourceAmount: audit.sourceAmount,
	sourceCurrency: audit.sourceCurrency,
	totalAmountSar: audit.totalAmountSar,
	exchangeRateToSar: audit.exchangeRateToSar,
	exchangeRateSource: audit.exchangeRateSource,
	paymentCollectionModel: audit.paymentCollectionModel,
	normalizedReservation: audit.normalizedReservation,
	emailContext: audit.emailContext,
	orchestratorDecision: audit.orchestratorDecision,
	forwardDecision: audit.forwardDecision,
	forwarding: audit.forwarding,
	airbnbWhatsappNotification: audit.airbnbWhatsappNotification,
	parseWarnings: audit.parseWarnings,
	parseErrors: audit.parseErrors,
	receivedAt: audit.receivedAt,
	processedAt: audit.processedAt,
	createdAt: audit.createdAt,
	__v: audit.__v,
});

const auditProtectedSnapshot = (audit) => ({
	evidence: auditEvidenceSnapshot(audit),
	rest: withoutPaths(audit, AUDIT_MUTABLE_PATHS),
});

const auditRecoveryMetadata = ({ targetKey, context, evidenceAuditIds }) => ({
	operation: OPERATION,
	targetKey,
	repairId: context.repairId,
	backupCollection: context.backupCollection,
	repairedAt: new Date(context.repairAt),
	evidenceAuditIds,
});

const buildAuditUpdate = ({ audit, expected, targetKey, target, reservation, hotel, context }) => {
	const at = new Date(context.repairAt);
	const evidenceAuditIds = target.audits.map((item) => item.id);
	const recovery = auditRecoveryMetadata({ targetKey, context, evidenceAuditIds });
	const originalReconciliation = cloneBson(audit.reconciliation || {});
	if (target.kind === "pricing") {
		const note = "Recovered from the exact authenticated direct OTA commercial evidence; the later relay ordering watermark was preserved.";
		return {
			$set: {
				processingStatus: "updated",
				automationAction: "updated",
				skipReason: "",
				automationComment: note,
				reconcileWarnings: appendUnique(audit.reconcileWarnings, note),
				reconcileErrors: [],
				reconciliation: {
					...originalReconciliation,
					status: "updated",
					actionTaken: "updated",
					skipReason: "",
					automationComment: note,
					warnings: appendUnique(originalReconciliation.warnings, note),
					errors: [],
					reservationId: cloneBson(reservation._id),
					hotelId: cloneBson(reservation.hotelId),
					pmsConfirmationNumber: target.pmsConfirmation,
					otaPlatformReviewStatus: "pending",
					recovery,
				},
				updatedAt: at,
			},
		};
	}
	if (target.kind === "cancellation") {
		const note = "Authenticated Airbnb cancellation applied to the exact reservation; cancellation is authoritative over its prior lifecycle status.";
		return {
			$set: {
				processingStatus: "cancelled",
				automationAction: "updated",
				skipReason: "",
				automationComment: note,
				reconcileWarnings: appendUnique(audit.reconcileWarnings, note),
				reconcileErrors: [],
				reconciliation: {
					...originalReconciliation,
					status: "cancelled",
					actionTaken: "updated",
					skipReason: "",
					automationComment: note,
					warnings: appendUnique(originalReconciliation.warnings, note),
					errors: [],
					reservationId: cloneBson(reservation._id),
					hotelId: cloneBson(reservation.hotelId),
					pmsConfirmationNumber: target.pmsConfirmation,
					otaPlatformReviewStatus: "closed",
					recovery,
				},
				updatedAt: at,
			},
		};
	}
	if (target.kind === "hotel_assignment") {
		const directPricing = expected.role === "authoritative_direct_pricing";
		const note = directPricing
			? "Authenticated direct Agoda commercial totals applied to the exact Zad Ajyad reservation; the family room, root price, and commission remain deliberately unmapped for review."
			: "Exact active Zad Ajyad hotel selected from source-backed hotel evidence; the family room and pricing remain deliberately unmapped for review.";
		return {
			$set: {
				...(directPricing
					? {
						processingStatus: "updated",
						automationAction: "updated",
						skipReason: "",
					}
					: {}),
				hotelId: cloneBson(hotel._id),
				automationComment: note,
				reconcileWarnings: appendUnique(audit.reconcileWarnings, note),
				reconciliation: {
					...originalReconciliation,
					...(directPricing
						? {
							status: "updated",
							actionTaken: "updated",
							skipReason: "",
							errors: [],
						}
						: {}),
					automationComment: note,
					warnings: appendUnique(originalReconciliation.warnings, note),
					hotelId: cloneBson(hotel._id),
					pmsConfirmationNumber: target.pmsConfirmation,
					otaPlatformReviewStatus: "pending",
					hotelAssignmentStatus: "assigned",
					roomMappingStatus: "unreviewed",
					recovery,
				},
				...(directPricing ? { reconcileErrors: [] } : {}),
				updatedAt: at,
			},
		};
	}
	if (target.kind === "audit_only") {
		const note = "Authenticated Airbnb payout-sent notification classified deterministically as finance correspondence, not a reservation.";
		return {
			$set: {
				processingStatus: "not_reservation",
				automationAction: "skipped",
				skipReason: "airbnb_payout_notification",
				automationComment: note,
				reconcileWarnings: [],
				reconcileErrors: [],
				reconciliation: {
					...originalReconciliation,
					status: "not_reservation",
					actionTaken: "skipped",
					skipReason: "airbnb_payout_notification",
					automationComment: note,
					warnings: [],
					errors: [],
					recovery,
				},
				updatedAt: at,
			},
		};
	}
	throw new Error(`Unsupported audit target kind: ${target.kind}`);
};

const verifyCorrectedPricing = ({ before, after, target, context, directAudit }) => {
	assert.ok(canonicalEqual(pricingProtectedSnapshot(before), pricingProtectedSnapshot(after)), "Pricing repair changed protected identity, hotel, stay, room-root, capture, inventory, or settlement facts.");
	assert.equal(Number(after.__v), Number(before.__v) + 1, "repaired reservation.__v");
	assertDate(after.updatedAt, dateIso(context.repairAt), "repaired reservation.updatedAt");
	assert.equal(normalize(after.booking_source), normalize(target.bookingSource), "repaired booking_source");
	assert.equal(normalize(after.customer_details?.booking_source), normalize(target.providerLabel), "repaired customer booking_source");
	assert.equal(normalize(after.supplierData?.supplierName), normalize(target.providerLabel), "repaired supplierName");
	assert.equal(normalize(after.supplierData?.otaProvider), normalize(target.transportProvider), "preserved canonical transport provider");
	assert.equal(normalize(after.adminPricing?.provider), normalize(target.transportProvider), "preserved admin transport provider");
	assert.equal(normalize(after.ota_financial_summary?.provider), normalize(target.transportProvider), "preserved financial transport provider");
	assert.equal(normalize(after.otaPlatformReview?.provider), normalize(target.transportProvider), "preserved review transport provider");
	assert.equal(after.otaPlatformReview?.status, "pending", "review must remain pending");
	assert.equal(Number(after.supplierData?.otaSourceAuthority), 3, "otaSourceAuthority");
	assert.equal(String(after.supplierData?.otaLastInboundEmailId), directAudit.id, "otaLastInboundEmailId");
	assertDate(after.supplierData?.otaLastSourceReceivedAt, target.relayWatermark, "monotonic relay watermark");
	assertMoney(after.total_amount, target.corrected.clientSar, "repaired total_amount");
	assertMoney(after.paid_amount, target.corrected.clientSar, "repaired paid_amount");
	assertMoney(after.paid_amount_breakdown?.paid_online_other_platforms, target.corrected.clientSar, "repaired payment bucket");
	assertMoney(after.adminPricing?.clientTotal, target.corrected.clientSar, "admin clientTotal");
	assertMoney(after.adminPricing?.rootTotal, target.corrected.rootSar, "admin rootTotal");
	assertMoney(after.adminPricing?.netAfterExpensesTotal, target.corrected.payoutSar, "admin payout");
	assertMoney(after.adminPricing?.otaExpenseTotal, target.corrected.expenseSar, "admin OTA expense");
	assertMoney(after.adminPricing?.platformMarginTotal, target.corrected.marginSar, "admin platform margin");
	assertMoney(after.adminPricing?.commissionAmount, target.corrected.commissionSar, "admin commission");
	assertMoney(after.adminPricing?.sourceAmount, target.corrected.clientSource, "admin source guest total");
	assert.equal(after.adminPricing?.defaultDeductionApplied, false, "direct payout must replace fallback deduction");
	assertNoClientTotalOverride(after.adminPricing, "repaired adminPricing");
	assert.equal(after.adminPricing?.sourceClientTotalSource, target.sourceClientTotalSource, "sourceClientTotalSource");
	assertMoney(after.ota_financial_summary?.clientTotal, target.corrected.clientSar, "financial guest total");
	assertMoney(after.ota_financial_summary?.netAfterExpenses, target.corrected.payoutSar, "financial payout");
	assertMoney(after.ota_financial_summary?.otaExpenseTotal, target.corrected.expenseSar, "financial expense");
	assertMoney(after.ota_financial_summary?.platformProfit, target.corrected.marginSar, "financial margin");
	assertMoney(after.supplierData?.otaPaymentSummary?.sourceTotalGuestPaymentAmount, target.corrected.clientSource, "supplier source guest total");
	assertMoney(after.supplierData?.otaPaymentSummary?.sourceTotalPayoutAmount, target.corrected.payoutSource, "supplier source payout");
	assertMoney(after.supplierData?.otaPaymentSummary?.totalPayoutAmount, target.corrected.payoutSar, "supplier payout SAR");
	assert.equal(after.supplierData?.otaPaymentInstructions, target.paymentInstructions, "payment instructions");
	assertMoney(after.financial_cycle?.pmsCollectedAmount, target.corrected.clientSar, "financial-cycle PMS collected amount");
	assertMoney(after.financial_cycle?.hotelPayoutDue, target.corrected.rootSar, "financial-cycle hotel root due");
	assert.equal(normalize(after.financial_cycle?.collectionModel), "pms collected", "financial-cycle collection model");
	assert.equal(normalize(after.financial_cycle?.status), "open", "financial-cycle status");
	assert.equal(normalize(after.financial_cycle?.commissionType), "amount", "financial-cycle commission type");
	assertMoney(after.financial_cycle?.commissionValue, target.corrected.commissionSar, "financial-cycle commission value");
	assertMoney(after.financial_cycle?.commissionAmount, target.corrected.commissionSar, "financial-cycle commission amount");
	assert.equal(after.financial_cycle?.commissionAssigned, false, "financial-cycle commission assigned");
	assert.equal(after.financial_cycle?.commissionAssignedAt ?? null, null, "financial-cycle commission assigned at");
	assert.equal(after.financial_cycle?.commissionAssignedBy ?? null, null, "financial-cycle commission assigned by");
	assertMoney(after.financial_cycle?.hotelCollectedAmount, 0, "financial-cycle hotel collected amount");
	assertMoney(after.financial_cycle?.commissionDueToPms, 0, "financial-cycle commission due to PMS");
	assert.equal(after.commissionData ?? null, null, "commissionData must remain absent after pricing recovery.");
	assertOnlyExpectedOtaPayment(after, {
		clientTotal: target.corrected.clientSar,
		paymentComment: target.paymentComment,
	});
	assert.ok(canonicalEqual(after.pickedRoomsType, after.pickedRoomsPricing), "Corrected room arrays diverged.");
	let clientCents = 0;
	let payoutCents = 0;
	let expenseCents = 0;
	let marginCents = 0;
	for (let index = 0; index < target.daily.length; index += 1) {
		const day = after.pickedRoomsType[0].pricingByDay[index];
		const expected = target.daily[index];
		assert.equal(day.date, expected.date, `repaired day ${index} date`);
		assertMoney(day.clientPrice, expected.client, `repaired day ${index} client`);
		assertMoney(day.netAfterOtaExpenses, expected.payout, `repaired day ${index} payout`);
		assertMoney(day.otaExpenseAmount, expected.expense, `repaired day ${index} expense`);
		assertMoney(day.rootPrice, expected.root, `repaired day ${index} root`);
		assertMoney(day.platformMargin, expected.margin, `repaired day ${index} margin`);
		clientCents += cents(day.clientPrice);
		payoutCents += cents(day.netAfterOtaExpenses);
		expenseCents += cents(day.otaExpenseAmount);
		marginCents += cents(day.platformMargin);
	}
	assert.equal(clientCents, cents(target.corrected.clientSar), "Nightly client total does not reconcile.");
	assert.equal(payoutCents, cents(target.corrected.payoutSar), "Nightly payout total does not reconcile.");
	assert.equal(expenseCents, cents(target.corrected.expenseSar), "Nightly expense total does not reconcile.");
	assert.equal(marginCents, cents(target.corrected.marginSar), "Nightly margin total does not reconcile.");
	assertNoSettlementOrCapture(after);
	return true;
};

const verifyCancellation = ({ before, after, target, context, cancellationAudit }) => {
	const processedAt = dateIso(cancellationAudit?.processedAt);
	assert.ok(processedAt, "The authoritative cancellation audit requires a valid saved processedAt timestamp.");
	const sourceReceivedAt = dateIso(cancellationAudit?.normalizedReservation?.source?.receivedAt);
	assert.ok(sourceReceivedAt, "The authoritative cancellation audit requires a valid source receivedAt timestamp.");
	assert.ok(canonicalEqual(cancellationProtectedSnapshot(before), cancellationProtectedSnapshot(after)), "Cancellation repair changed commercial, room, payment, capture, settlement, hotel, identity, or stay data.");
	assert.equal(after.state, "cancelled", "state");
	assert.equal(after.reservation_status, "cancelled", "reservation_status");
	assert.equal(after.cancel_reason, "Airbnb status email", "cancel_reason");
	assert.equal(after.pendingConfirmation?.status, "cancelled", "pendingConfirmation.status");
	assert.equal(after.pendingConfirmation?.source, "ota_email_status", "pendingConfirmation.source");
	assert.equal(after.pendingConfirmation?.confirmedAt, null, "pendingConfirmation.confirmedAt");
	assertDate(after.pendingConfirmation?.cancelledAt, processedAt, "pendingConfirmation.cancelledAt");
	assertDate(after.pendingConfirmation?.lastUpdatedAt, processedAt, "pendingConfirmation.lastUpdatedAt");
	assert.equal(after.agentDecisionSnapshot?.status, "cancelled", "agentDecisionSnapshot.status");
	assert.equal(after.agentDecisionSnapshot?.source, "ota_email_status", "agentDecisionSnapshot.source");
	assertDate(after.agentDecisionSnapshot?.decidedAt, processedAt, "agentDecisionSnapshot.decidedAt");
	assert.equal(after.otaPlatformReview?.status, "closed", "otaPlatformReview.status");
	assert.equal(after.otaPlatformReview?.closedReason, "ota_status_cancelled", "otaPlatformReview.closedReason");
	assertDate(after.otaPlatformReview?.closedAt, processedAt, "otaPlatformReview.closedAt");
	assertDate(after.otaPlatformReview?.lastUpdatedAt, processedAt, "otaPlatformReview.lastUpdatedAt");
	assert.equal(after.supplierData?.otaLastInboundEmailId, id(cancellationAudit), "otaLastInboundEmailId");
	assertDate(after.supplierData?.otaLastEmailAt, processedAt, "otaLastEmailAt");
	assertDate(after.supplierData?.otaLastSourceReceivedAt, sourceReceivedAt, "cancellation source watermark");
	assert.equal(after.supplierData?.otaLastEventType, "cancelled", "otaLastEventType");
	assert.equal(Number(after.__v), Number(before.__v) + 1, "reservation.__v");
	assertDate(after.updatedAt, dateIso(context.repairAt), "reservation.updatedAt");
	return true;
};

const hasRoomConfiguration = (reservation) =>
	[...(reservation.pickedRoomsType || []), ...(reservation.pickedRoomsPricing || [])]
		.some((room) => id(room.hotelRoomConfigId) || id(room.roomId));

const verifyHotelAssignment = ({ before, after, target, hotel, context }) => {
	assert.ok(canonicalEqual(hotelAssignmentProtectedSnapshot(before), hotelAssignmentProtectedSnapshot(after)), "Hotel assignment and direct pricing correction changed protected guest, stay, payment method, capture, settlement, or availability facts.");
	assert.equal(id(after.hotelId), target.hotelId, "assigned hotelId");
	assert.equal(id(after.belongsTo), target.ownerId, "assigned belongsTo");
	assert.deepEqual(after.roomId, [], "roomId must remain empty");
	assert.equal(hasRoomConfiguration(after), false, "Exact hotel assignment must not invent a room/config mapping.");
	assertMoney(after.total_amount, target.corrected.clientSar, "direct client total");
	assertMoney(after.paid_amount, target.corrected.clientSar, "direct paid amount");
	assertMoney(after.paid_amount_breakdown?.paid_online_other_platforms, target.corrected.clientSar, "direct paid-online bucket");
	assertMoney(after.adminPricing?.clientTotal, target.corrected.clientSar, "admin direct client total");
	assertMoney(after.adminPricing?.netAfterExpensesTotal, target.corrected.payoutSar, "admin direct payout total");
	assertMoney(after.adminPricing?.otaExpenseTotal, target.corrected.expenseSar, "admin direct OTA expense total");
	assertMoney(after.sub_total, 0, "sub_total");
	assertMoney(after.commission, 0, "commission");
	assertMoney(after.adminPricing?.rootTotal, 0, "admin rootTotal");
	assertMoney(after.adminPricing?.platformMarginTotal, 0, "admin platformMarginTotal");
	assertMoney(after.adminPricing?.commissionAmount, 0, "admin commissionAmount");
	assert.equal(after.adminPricing?.mode, "ota_assignment_pending_pricing", "adminPricing.mode");
	assert.equal(after.adminPricing?.pricingReviewRequired, true, "adminPricing.pricingReviewRequired");
	assert.equal(after.adminPricing?.hotelAssignmentRequired, false, "adminPricing.hotelAssignmentRequired");
	assert.equal(after.adminPricing?.defaultDeductionApplied, false, "adminPricing.defaultDeductionApplied");
	assertNoClientTotalOverride(after.adminPricing, "repaired adminPricing");
	assertMoney(after.adminPricing?.sourceAmount, target.corrected.clientSource, "admin sourceAmount");
	assert.equal(after.adminPricing?.sourceClientTotalSource, target.sourceClientTotalSource, "admin sourceClientTotalSource");
	assertMoney(after.ota_financial_summary?.clientTotal, target.corrected.clientSar, "financial guest total");
	assertMoney(after.ota_financial_summary?.netAfterExpenses, target.corrected.payoutSar, "financial payout total");
	assertMoney(after.ota_financial_summary?.otaExpenseTotal, target.corrected.expenseSar, "financial expense total");
	assertMoney(after.ota_financial_summary?.hotelVisibleAmount, 0, "financial hotel-visible amount");
	assertMoney(after.ota_financial_summary?.platformProfit, 0, "financial platform margin");
	assert.equal(after.otaPlatformReview?.status, "pending", "otaPlatformReview.status");
	assert.equal(after.otaPlatformReview?.hotelAssignmentRequired, false, "otaPlatformReview.hotelAssignmentRequired");
	assert.equal(after.otaPlatformReview?.hotelAssignmentStatus, "assigned", "otaPlatformReview.hotelAssignmentStatus");
	assert.equal(after.otaPlatformReview?.roomMappingStatus, "unreviewed", "otaPlatformReview.roomMappingStatus");
	assert.equal(after.supplierData?.otaHotelMappingRequired, false, "supplierData.otaHotelMappingRequired");
	assert.equal(after.supplierData?.otaHotelRoomConfigId, null, "supplierData.otaHotelRoomConfigId");
	assert.equal(after.supplierData?.otaRoomMatchScore, 0, "supplierData.otaRoomMatchScore");
	assert.equal(after.supplierData?.otaRoomMatchType, "", "supplierData.otaRoomMatchType");
	assert.equal(normalize(after.supplierData?.otaAssignedHotelName), normalize(hotel.hotelName), "assigned hotel name");
	assert.equal(Number(after.supplierData?.otaSourceAuthority), 3, "supplierData.otaSourceAuthority");
	assertMoney(after.supplierData?.otaAmount, target.corrected.clientSource, "supplier otaAmount");
	assertMoney(after.supplierData?.otaAmountSar, target.corrected.clientSar, "supplier otaAmountSar");
	assertMoney(after.supplierData?.otaPaymentSummary?.sourceTotalPayoutAmount, target.corrected.payoutSource, "supplier source payout");
	assertMoney(after.supplierData?.otaTotalPayoutSar, target.corrected.payoutSar, "supplier payout SAR");
	assertMoney(after.supplierData?.otaExpenseTotalSar, target.corrected.expenseSar, "supplier expense SAR");
	assertMoney(after.supplierData?.otaPlatformMarginSar, 0, "supplier platform margin");
	assert.equal(after.supplierData?.otaPaymentInstructions, target.paymentInstructions, "supplier payment instructions");
	assertDate(after.supplierData?.otaLastSourceReceivedAt, target.relayWatermark, "monotonic relay watermark");
	assert.equal(after.supplierData?.otaLastInboundEmailId, target.audits.find((audit) => audit.role === "authoritative_direct_pricing").id, "supplier direct inbound audit ID");
	assertMoney(after.financial_cycle?.pmsCollectedAmount, target.corrected.clientSar, "financial-cycle PMS collected amount");
	assertMoney(after.financial_cycle?.hotelPayoutDue, 0, "financial-cycle blocked hotel payout due");
	assert.equal(normalize(after.financial_cycle?.collectionModel), "pms collected", "financial-cycle collection model");
	assert.equal(normalize(after.financial_cycle?.status), "open", "financial-cycle status");
	assert.equal(normalize(after.financial_cycle?.commissionType), "amount", "financial-cycle commission type");
	assertMoney(after.financial_cycle?.commissionValue, 0, "financial-cycle commission value");
	assertMoney(after.financial_cycle?.commissionAmount, 0, "financial-cycle commission amount");
	assert.equal(after.financial_cycle?.commissionAssigned, false, "financial-cycle commission assigned");
	assert.equal(after.financial_cycle?.commissionAssignedAt ?? null, null, "financial-cycle commission assigned at");
	assert.equal(after.financial_cycle?.commissionAssignedBy ?? null, null, "financial-cycle commission assigned by");
	assertMoney(after.financial_cycle?.hotelCollectedAmount, 0, "financial-cycle hotel collected amount");
	assertMoney(after.financial_cycle?.commissionDueToPms, 0, "financial-cycle commission due to PMS");
	assertOnlyExpectedOtaPayment(after, {
		...target,
		clientTotal: target.corrected.clientSar,
	});
	assert.ok(canonicalEqual(before.availabilitySnapshot, after.availabilitySnapshot), "availabilitySnapshot changed.");
	assert.equal(Number(after.__v), Number(before.__v) + 1, "reservation.__v");
	assertDate(after.updatedAt, dateIso(context.repairAt), "reservation.updatedAt");
	let clientTotal = 0;
	let payoutTotal = 0;
	let expenseTotal = 0;
	for (const rooms of [after.pickedRoomsType, after.pickedRoomsPricing]) {
		for (const room of rooms || []) {
			assert.equal(room.room_type, "familyRooms", "source family room semantic changed");
			assert.equal(room.displayName, before.pickedRoomsType[0].displayName, "source room wording changed");
			assertMoney(room.chosenPrice, target.corrected.chosenPrice, "room chosenPrice");
			assertMoney(room.totalPriceWithCommission, target.corrected.clientSar, "room client total");
			for (let index = 0; index < (room.pricingByDay || []).length; index += 1) {
				const day = room.pricingByDay[index];
				const expected = target.daily[index];
				assert.equal(day.date, expected.date, `day ${index} date`);
				assertMoney(day.clientPrice, expected.client, `${day.date} clientPrice`);
				assertMoney(day.netAfterOtaExpenses, expected.payout, `${day.date} payout`);
				assertMoney(day.otaExpenseAmount, expected.expense, `${day.date} OTA expense`);
				assertMoney(day.rootPrice, 0, `${day.date} rootPrice`);
				assertMoney(day.totalPriceWithoutCommission, 0, `${day.date} totalPriceWithoutCommission`);
				assertMoney(day.commissionRate, 0, `${day.date} commissionRate`);
				assertMoney(day.platformMargin, 0, `${day.date} platformMargin`);
				if (rooms === after.pickedRoomsType) {
					clientTotal += cents(day.clientPrice);
					payoutTotal += cents(day.netAfterOtaExpenses);
					expenseTotal += cents(day.otaExpenseAmount);
				}
			}
		}
	}
	assert.equal(clientTotal, cents(target.corrected.clientSar), "Nightly direct client total does not reconcile.");
	assert.equal(payoutTotal, cents(target.corrected.payoutSar), "Nightly direct payout total does not reconcile.");
	assert.equal(expenseTotal, cents(target.corrected.expenseSar), "Nightly direct expense total does not reconcile.");
	assertNoSettlementOrCapture(after);
	return true;
};

const verifyAuditOutcome = ({ before, after, target, expected, context }) => {
	assert.ok(canonicalEqual(auditProtectedSnapshot(before), auditProtectedSnapshot(after)), `${expected.id} raw/normalized/authentication/forwarding evidence changed.`);
	assert.equal(after.emailHash, expected.emailHash, `${expected.id}.emailHash`);
	assert.equal(after.textHash, expected.textHash, `${expected.id}.textHash`);
	assertDate(after.updatedAt, dateIso(context.repairAt), `${expected.id}.updatedAt`);
	if (target.kind === "pricing") {
		assert.equal(after.processingStatus, "updated", `${expected.id}.processingStatus`);
		assert.equal(after.automationAction, "updated", `${expected.id}.automationAction`);
		assert.equal(after.skipReason, "", `${expected.id}.skipReason`);
		assert.equal(after.reconciliation?.status, "updated", `${expected.id}.reconciliation.status`);
	}
	if (target.kind === "cancellation") {
		assert.equal(after.processingStatus, "cancelled", `${expected.id}.processingStatus`);
		assert.equal(after.automationAction, "updated", `${expected.id}.automationAction`);
		assert.equal(after.skipReason, "", `${expected.id}.skipReason`);
		assert.equal(after.reconciliation?.status, "cancelled", `${expected.id}.reconciliation.status`);
	}
	if (target.kind === "hotel_assignment") {
		if (expected.role === "authoritative_direct_pricing") {
			assert.equal(after.processingStatus, "updated", `${expected.id}.processingStatus`);
			assert.equal(after.automationAction, "updated", `${expected.id}.automationAction`);
			assert.equal(after.skipReason, "", `${expected.id}.skipReason`);
			assert.equal(after.reconciliation?.status, "updated", `${expected.id}.reconciliation.status`);
		} else {
			assert.equal(after.processingStatus, before.processingStatus, `${expected.id}.processingStatus must stay created`);
			assert.equal(after.automationAction, before.automationAction, `${expected.id}.automationAction must remain its creation action`);
		}
		assert.equal(id(after.hotelId), target.hotelId, `${expected.id}.hotelId`);
		assert.equal(id(after.reconciliation?.hotelId), target.hotelId, `${expected.id}.reconciliation.hotelId`);
		assert.equal(after.reconciliation?.roomMappingStatus, "unreviewed", `${expected.id}.roomMappingStatus`);
	}
	if (target.kind === "audit_only") {
		assert.equal(after.processingStatus, "not_reservation", `${expected.id}.processingStatus`);
		assert.equal(after.automationAction, "skipped", `${expected.id}.automationAction`);
		assert.equal(after.skipReason, "airbnb_payout_notification", `${expected.id}.skipReason`);
		assert.equal(after.reconciliation?.status, "not_reservation", `${expected.id}.reconciliation.status`);
		assert.equal(after.hasReservationConnection, false, `${expected.id}.hasReservationConnection`);
		assert.equal(id(after.reservationMongoId), "", `${expected.id}.reservationMongoId`);
	}
	assert.equal(after.reconciliation?.recovery?.operation, OPERATION, `${expected.id}.recovery.operation`);
	return true;
};

const getTarget = (targetKey) => {
	const target = TARGETS[String(targetKey || "")];
	assert.ok(target, `Unknown recovery target: ${targetKey}`);
	return target;
};

const targetAuditScope = (targetKey) => {
	const target = getTarget(targetKey);
	return cloneBson({
		targetKey,
		auditIds: target.audits.map((audit) => audit.id),
		reservationMongoId: target.mongoId || "",
		pmsConfirmation: target.pmsConfirmation || "",
		otaConfirmation: target.otaConfirmation || "",
		providers: [...new Set(target.audits.map((audit) => audit.provider))],
		// A database caller must query all identity/link alternatives below and
		// reject any returned document whose ID is not in auditIds.
		matchPaths: target.mongoId
			? [
				"_id",
				"reservationMongoId",
				"confirmationNumber",
				"pmsConfirmationNumber",
				"normalizedReservation.confirmationNumber",
			]
			: ["_id"],
	});
};

const validateTargetScope = ({ targetKey, reservation = null, audits = [], hotel = null }) => {
	const target = getTarget(targetKey);
	if (target.kind === "pricing") validatePricingTargetConstants(target);
	const auditById = validateAuditSet(audits, target);
	if (target.mongoId) validateReservationDocument(reservation, target);
	else assert.equal(reservation, null, `${targetKey} is audit-only and cannot receive a reservation.`);
	if (target.kind === "hotel_assignment") validateHotelDocument(hotel, target);
	return { target, auditById };
};

const buildRecoveryPlan = ({ targetKey, reservation = null, audits = [], hotel = null, context = {} }) => {
	requireContext(context);
	const { target, auditById } = validateTargetScope({ targetKey, reservation, audits, hotel });
	let reservationPlan = null;
	if (target.mongoId) {
		let update;
		if (target.kind === "pricing") {
			const direct = target.audits.find((audit) => audit.role === "authoritative_direct_pricing");
			update = buildPricingUpdate({ reservation, targetKey, target, directAudit: direct, context });
		} else if (target.kind === "cancellation") {
			const cancellation = target.audits.find((audit) => audit.role === "authoritative_cancellation");
			update = buildCancellationUpdate({
				reservation,
				targetKey,
				target,
				cancellationAudit: auditById.get(cancellation.id),
				context,
			});
		} else if (target.kind === "hotel_assignment") {
			update = buildHotelAssignmentUpdate({ reservation, targetKey, target, hotel, context });
		}
		reservationPlan = exactDocumentPlan({
			collection: "reservations",
			document: reservation,
			update,
			role: `${target.kind}_reservation`,
		});
	}

	const auditPlans = [];
	const immutableEvidence = [];
	for (const expected of target.audits) {
		const audit = auditById.get(expected.id);
		if (!expected.mutable) {
			immutableEvidence.push({
				collection: "inboundemails",
				role: expected.role,
				documentId: expected.id,
				originalDocument: cloneBson(audit),
				originalHash: canonicalEjsonSha256(audit),
				evidenceHash: canonicalEjsonSha256(auditEvidenceSnapshot(audit)),
			});
			continue;
		}
		const update = buildAuditUpdate({ audit, expected, targetKey, target, reservation, hotel, context });
		auditPlans.push(exactDocumentPlan({
			collection: "inboundemails",
			document: audit,
			update,
			role: expected.role,
		}));
	}

	const documentPlans = [reservationPlan, ...auditPlans].filter(Boolean);
	const plan = {
		operation: OPERATION,
		targetKey,
		target,
		context: cloneBson(context),
		reservationPlan,
		auditPlans,
		documentPlans,
		immutableEvidence,
		evidenceDocuments: immutableEvidence.map((entry) => cloneBson(entry.originalDocument)),
		evidenceHashes: immutableEvidence.map((entry) => entry.originalHash),
		hotelEvidence: hotel ? {
			document: cloneBson(hotel),
			hash: canonicalEjsonSha256(hotel),
		} : null,
		summary: {
			mutableDocuments: documentPlans.length,
			immutableEvidenceDocuments: immutableEvidence.length,
			reservationDocuments: reservationPlan ? 1 : 0,
			inboundAuditDocuments: target.audits.length,
		},
	};
	verifyRecoveryPlan(plan);
	return plan;
};

function verifyRecoveryPlan(plan) {
	assert.equal(plan?.operation, OPERATION, "Recovery plan operation changed.");
	const target = getTarget(plan.targetKey);
	requireContext(plan.context);
	assert.equal(plan.documentPlans?.length, plan.summary?.mutableDocuments, "documentPlans count changed.");
	for (const documentPlan of plan.documentPlans || []) {
		assert.equal(canonicalEjsonSha256(documentPlan.originalDocument), documentPlan.originalHash, `${documentPlan.role} original hash`);
		assert.equal(canonicalEjsonSha256(documentPlan.casFilter), documentPlan.casFilterHash, `${documentPlan.role} CAS hash`);
		assert.ok(canonicalEqual(documentPlan.casFilter, buildExactCasFilter(documentPlan.originalDocument)), `${documentPlan.role} is not protected by a full-document CAS filter.`);
		const reapplied = applyUpdateToDocument(documentPlan.originalDocument, documentPlan.update);
		assert.ok(canonicalEqual(reapplied, documentPlan.expectedDocument), `${documentPlan.role} expected document is not the deterministic result of its update.`);
		assert.equal(canonicalEjsonSha256(documentPlan.expectedDocument), documentPlan.expectedHash, `${documentPlan.role} expected hash`);
	}
	if (plan.reservationPlan) {
		const before = plan.reservationPlan.originalDocument;
		const after = plan.reservationPlan.expectedDocument;
		if (target.kind === "pricing") {
			verifyCorrectedPricing({ before, after, target, context: plan.context, directAudit: target.audits.find((audit) => audit.role === "authoritative_direct_pricing") });
		} else if (target.kind === "cancellation") {
			const cancellationExpected = target.audits.find((audit) => audit.role === "authoritative_cancellation");
			const cancellationPlan = plan.auditPlans.find((auditPlan) => auditPlan.documentId === cancellationExpected.id);
			assert.ok(cancellationPlan, "The authoritative cancellation audit plan is missing.");
			verifyCancellation({
				before,
				after,
				target,
				context: plan.context,
				cancellationAudit: cancellationPlan.originalDocument,
			});
		} else if (target.kind === "hotel_assignment") {
			verifyHotelAssignment({ before, after, target, hotel: plan.hotelEvidence.document, context: plan.context });
		}
	}
	for (const auditPlan of plan.auditPlans || []) {
		const expected = target.audits.find((audit) => audit.id === auditPlan.documentId);
		assert.ok(expected?.mutable, `${auditPlan.documentId} is not a mutable audit for ${plan.targetKey}.`);
		verifyAuditOutcome({ before: auditPlan.originalDocument, after: auditPlan.expectedDocument, target, expected, context: plan.context });
	}
	for (const evidence of plan.immutableEvidence || []) {
		assert.equal(canonicalEjsonSha256(evidence.originalDocument), evidence.originalHash, `${evidence.documentId} immutable evidence hash`);
		assert.equal(canonicalEjsonSha256(auditEvidenceSnapshot(evidence.originalDocument)), evidence.evidenceHash, `${evidence.documentId} immutable raw evidence hash`);
	}
	return true;
}

const findScopeDocument = (scope, collection, documentId) => {
	const source = collection === "reservations" ? scope?.reservations : scope?.audits;
	if (source instanceof Map) return source.get(documentId) || source.get(String(documentId));
	return (Array.isArray(source) ? source : []).find((document) => id(document) === documentId);
};

const verifyRepairedTarget = ({ plan, scope }) => {
	verifyRecoveryPlan(plan);
	for (const documentPlan of plan.documentPlans) {
		const actual = findScopeDocument(scope, documentPlan.collection, documentPlan.documentId);
		assert.ok(actual, `Missing applied ${documentPlan.collection}/${documentPlan.documentId}.`);
		assert.equal(canonicalEjsonSha256(actual), documentPlan.expectedHash, `${documentPlan.collection}/${documentPlan.documentId} post-state hash`);
	}
	for (const evidence of plan.immutableEvidence) {
		const actual = findScopeDocument(scope, evidence.collection, evidence.documentId);
		assert.ok(actual, `Missing immutable evidence ${evidence.documentId}.`);
		assert.equal(canonicalEjsonSha256(actual), evidence.originalHash, `${evidence.documentId} immutable evidence changed`);
	}
	if (plan.hotelEvidence) {
		assert.equal(canonicalEjsonSha256(plan.hotelEvidence.document), plan.hotelEvidence.hash, "Hotel evidence changed inside the plan.");
	}
	return true;
};

const verifyAppliedTarget = verifyRepairedTarget;

const mapScope = (values) => {
	const result = new Map();
	for (const value of values || []) result.set(id(value), cloneBson(value));
	return result;
};

const applyPlanToScope = ({ plan, scope }) => {
	verifyRecoveryPlan(plan);
	const reservations = mapScope(scope?.reservations);
	const audits = mapScope(scope?.audits);
	for (const documentPlan of plan.documentPlans) {
		const values = documentPlan.collection === "reservations" ? reservations : audits;
		const current = values.get(documentPlan.documentId);
		assert.ok(current, `Missing ${documentPlan.collection}/${documentPlan.documentId}.`);
		assert.equal(canonicalEjsonSha256(current), documentPlan.originalHash, `${documentPlan.collection}/${documentPlan.documentId} CAS pre-state mismatch`);
		values.set(documentPlan.documentId, cloneBson(documentPlan.expectedDocument));
	}
	for (const evidence of plan.immutableEvidence) {
		const current = audits.get(evidence.documentId);
		assert.ok(current, `Missing immutable audit ${evidence.documentId}.`);
		assert.equal(canonicalEjsonSha256(current), evidence.originalHash, `${evidence.documentId} immutable evidence pre-state mismatch`);
	}
	const result = {
		reservations: [...reservations.values()],
		audits: [...audits.values()],
	};
	verifyRepairedTarget({ plan, scope: result });
	return result;
};

const classifyPlanScope = ({ plan, scope }) =>
	plan.documentPlans.map((documentPlan) => {
		const current = findScopeDocument(scope, documentPlan.collection, documentPlan.documentId);
		const currentHash = current ? canonicalEjsonSha256(current) : "";
		return {
			collection: documentPlan.collection,
			documentId: documentPlan.documentId,
			role: documentPlan.role,
			state:
				currentHash === documentPlan.originalHash
					? "original"
					: currentHash === documentPlan.expectedHash
						? "repaired"
						: "changed_or_missing",
			currentHash,
		};
	});

const buildRecoveryPlans = ({ reservations = [], audits = [], hotels = [], context = {} }) => {
	requireContext(context);
	assert.equal(reservations.length, RESERVATION_TARGET_KEYS.length, `Exactly ${RESERVATION_TARGET_KEYS.length} reservations are required.`);
	assert.equal(audits.length, ALL_AUDIT_IDS.length, `Exactly ${ALL_AUDIT_IDS.length} fixed-scope inbound audits are required; unknown matching audits must abort.`);
	const reservationById = new Map(reservations.map((reservation) => [id(reservation), reservation]));
	const auditById = new Map(audits.map((audit) => [id(audit), audit]));
	assert.equal(reservationById.size, RESERVATION_TARGET_KEYS.length, "Reservation IDs must be unique.");
	assert.equal(auditById.size, ALL_AUDIT_IDS.length, "Audit IDs must be unique.");
	assert.deepEqual([...auditById.keys()].sort(), [...ALL_AUDIT_IDS].sort(), "Inbound audit scope contains a missing or unknown document.");
	const hotel = (hotels || []).find((candidate) => id(candidate) === EXPECTED_HOTEL_ID) || null;
	return TARGET_KEYS.map((targetKey) => {
		const target = TARGETS[targetKey];
		return buildRecoveryPlan({
			targetKey,
			reservation: target.mongoId ? reservationById.get(target.mongoId) : null,
			audits: target.audits.map((expected) => auditById.get(expected.id)),
			hotel: target.kind === "hotel_assignment" ? hotel : null,
			context,
		});
	});
};

const buildBackupCollectionName = (repairId) => {
	assert.ok(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,79}$/.test(String(repairId || "")), "Invalid repairId for backup collection.");
	return `${BACKUP_COLLECTION_PREFIX}${String(repairId).replace(/[^A-Za-z0-9_]+/g, "_")}`.slice(0, 120);
};

const buildBackupRecords = ({ plans, repairId, backupCollection, backupAt }) => {
	assert.ok(Array.isArray(plans) && plans.length > 0, "At least one recovery plan is required.");
	assert.equal(buildBackupCollectionName(repairId), backupCollection, "backupCollection does not match repairId.");
	assert.ok(dateIso(backupAt), "backupAt must be valid.");
	const records = [];
	const seen = new Set();
	for (const plan of plans) {
		for (const entry of [...plan.documentPlans, ...plan.immutableEvidence]) {
			const key = `${entry.collection}:${entry.documentId}`;
			assert.equal(seen.has(key), false, `Duplicate backup source ${key}.`);
			seen.add(key);
			const originalDocument = cloneBson(entry.originalDocument);
			records.push({
				_id: `${repairId}:${entry.collection}:${entry.documentId}`,
				operation: OPERATION,
				repairId,
				backupCollection,
				backupAt: new Date(backupAt),
				targetKey: plan.targetKey,
				sourceCollection: entry.collection,
				sourceDocumentId: entry.documentId,
				role: entry.role,
				originalDocument,
				originalHash: canonicalEjsonSha256(originalDocument),
			});
		}
	}
	verifyBackupRecords({ records, repairId, backupCollection });
	return records;
};

const verifyBackupRecords = ({ records, repairId, backupCollection }) => {
	assert.ok(Array.isArray(records) && records.length > 0, "Backup records are required.");
	const ids = new Set();
	for (const record of records) {
		assert.equal(record.operation, OPERATION, "backup operation");
		assert.equal(record.repairId, repairId, "backup repairId");
		assert.equal(record.backupCollection, backupCollection, "backup collection");
		assert.equal(ids.has(record._id), false, `Duplicate backup record ${record._id}.`);
		ids.add(record._id);
		assert.equal(canonicalEjsonSha256(record.originalDocument), record.originalHash, `${record._id} canonical original hash`);
	}
	return true;
};

module.exports = {
	ALL_AUDIT_IDS,
	BACKUP_COLLECTION_PREFIX,
	EXPECTED_HOTEL_ID,
	EXPECTED_HOTEL_NAME,
	EXPECTED_OWNER_ID,
	MANIFEST_COLLECTION,
	OPERATION,
	REPAIR_SOURCE,
	RESERVATION_TARGET_KEYS,
	TARGET_KEYS,
	TARGETS,
	applyPlanToScope,
	applyUpdateToDocument,
	auditEvidenceSnapshot,
	buildBackupCollectionName,
	buildBackupRecords,
	buildExactCasFilter,
	buildRecoveryPlan,
	buildRecoveryPlans,
	canonicalEjsonSha256,
	canonicalEqual,
	classifyPlanScope,
	cloneBson,
	getTarget,
	hasRoomConfiguration,
	id,
	targetAuditScope,
	validateAuditDocument,
	validateAuditSet,
	validatePricingTargetConstants,
	validateReservationDocument,
	validateTargetScope,
	verifyAppliedTarget,
	verifyBackupRecords,
	verifyRecoveryPlan,
	verifyRepairedTarget,
};
