/** @format */

"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");

const HotelDetails = require("../models/hotel_details");
const HotelReview = require("../models/hotel_review");
const HotelReviewSummary = require("../models/hotel_review_summary");
const HotelReviewInvitation = require("../models/hotel_review_invitation");
const Reservations = require("../models/reservations");
const User = require("../models/user");
const {
	invalidatePublicHotelGuestReviewSummaryCache,
} = require("./janat");
const {
	buildHotelReviewVisibilityCasFilter,
	effectiveCommentVisibilityAggregationExpression,
	effectiveRatingVisibilityAggregationExpression,
	effectiveRatingVisibilityMongoFilter,
	legacyRollbackSafeReviewStatus,
	publicReviewContentAggregationExpression,
	publicReviewContentMongoFilter,
	resolveHotelReviewVisibility,
} = require("../services/hotelReviewVisibility");

const REVIEW_COMMENT_MAX = 2000;
const REVIEW_NAME_MAX = 80;
const REVIEW_CONFIRMATION_MAX = 120;
const REVIEW_TOKEN_MAX = 160;
const PUBLIC_REVIEW_LIMIT_DEFAULT = 6;
const PUBLIC_REVIEW_LIMIT_MAX = 12;
const ADMIN_REVIEW_LIMIT_DEFAULT = 20;
const ADMIN_REVIEW_LIMIT_MAX = 50;
const MAX_PAGE = 10000;
const MAX_REVIEW_REQUEST_BYTES = 32 * 1024;
const INVITATION_TOKEN_BYTES = 32;
const INVITATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,160}$/;
const REVIEW_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const REVIEW_RATE_LIMIT_MAX = 8;
const REVIEW_RATE_LIMIT_MAX_KEYS = 5000;
const FALLBACK_MUTEX_MAX_KEYS = 2000;
const FALLBACK_MUTEX_MAX_WAITERS_PER_KEY = 50;
const reviewSubmissionRateLimit = new Map();
const hotelReviewFallbackMutexes = new Map();
let reviewTransactionsUnsupported = false;

const BREAKDOWN_FIELD_BY_RATING = {
	1: "oneStar",
	2: "twoStar",
	3: "threeStar",
	4: "fourStar",
	5: "fiveStar",
};

const PUBLIC_HOTEL_SELECT = [
	"_id",
	"hotelName",
	"hotelName_OtherLanguage",
	"hotelRating",
	"activateHotel",
	"xHotelProActive",
].join(" ");

const RESERVATION_REVIEW_SELECT = [
	"_id",
	"hotelId",
	"confirmation_number",
	"customer_details.name",
	"roomId",
	"pickedRoomsType.room_type",
	"pickedRoomsType.roomType",
	"pickedRoomsType.displayName",
	"pickedRoomsType.display_name",
].join(" ");

const PUBLIC_REVIEW_SELECT = [
	"_id",
	"rating",
	"comment",
	"status",
	"ratingVisible",
	"commentVisible",
	"displayName",
	"createdAt",
	"updatedAt",
	"+verifiedStay",
].join(" ");

const ADMIN_REVIEW_SELECT = [
	"_id",
	"hotelId",
	"hotelNameSnapshot",
	"hotelSlug",
	"rating",
	"comment",
	"status",
	"ratingVisible",
	"commentVisible",
	"displayName",
	"language",
	"source",
	"createdAt",
	"updatedAt",
	"+firstName",
	"+lastName",
	"+userId",
	"+authenticatedReviewer",
	"+reservationId",
	"+invitationId",
	"+verifiedStay",
	"+verificationMethod",
	"+confirmationNumberEncrypted",
	"+confirmationNumberLookupHash",
	"+confirmationNumberMasked",
	"+roomLabel",
	"+moderation",
	"+moderationHistory",
].join(" ");

class HotelReviewHttpError extends Error {
	constructor(status, message, code = "HOTEL_REVIEW_ERROR") {
		super(message);
		this.name = "HotelReviewHttpError";
		this.status = status;
		this.code = code;
	}
}

const setNoStoreHeaders = (res) => {
	res.setHeader("Cache-Control", "no-store, max-age=0, must-revalidate");
	res.setHeader("Pragma", "no-cache");
	res.setHeader("Expires", "0");
	res.setHeader("Referrer-Policy", "no-referrer");
	res.setHeader("X-Content-Type-Options", "nosniff");
};

const stringId = (value) => String(value?._id || value?.id || value || "").trim();

const configuredSuperAdminIds = () =>
	[process.env.SUPER_ADMIN_ID, process.env.REACT_APP_SUPER_ADMIN_ID]
		.flatMap((value) => String(value || "").split(","))
		.map((value) => value.trim())
		.filter(Boolean);

const invitationActorHotelIds = (actor = {}) => {
	const candidates = [
		actor.hotelIdWork,
		...(Array.isArray(actor.hotelIdsWork) ? actor.hotelIdsWork : []),
		...(Array.isArray(actor.hotelsToSupport) ? actor.hotelsToSupport : []),
		...(Array.isArray(actor.hotelIdsOwner) ? actor.hotelIdsOwner : []),
	];
	return new Set(candidates.map(stringId).filter(Boolean));
};

const platformReservationActorRoles = (actor = {}) =>
	[actor.role, ...(Array.isArray(actor.roles) ? actor.roles : [])]
		.map(Number)
		.filter(Number.isFinite);

const canViewHotelReviewReservationDetails = (
	actor = {},
	{ superAdminIds = configuredSuperAdminIds() } = {}
) => {
	if (!actor || actor.activeUser === false) return false;
	const actorId = stringId(actor._id || actor.id);
	if (superAdminIds.map(String).includes(actorId)) return true;
	if (!platformReservationActorRoles(actor).includes(1000)) return false;
	const access = new Set(
		(Array.isArray(actor.accessTo) ? actor.accessTo : [])
			.map((value) => String(value || "").trim())
			.filter(Boolean)
	);
	return (
		access.has("JannatBookingWebsite") &&
		(access.has("AllReservations") || access.has("HotelsReservations"))
	);
};

const canViewHotelReviewReservationDetailsForHotel = (
	actor = {},
	hotelId,
	{ superAdminIds = configuredSuperAdminIds() } = {}
) => {
	if (
		!canViewHotelReviewReservationDetails(actor, { superAdminIds })
	) {
		return false;
	}
	const actorId = stringId(actor._id || actor.id);
	if (superAdminIds.map(String).includes(actorId)) return true;
	return invitationActorHotelIds(actor).has(stringId(hotelId));
};

const buildRequireHotelReviewReservationScope = ({
	ReservationModel = Reservations,
	superAdminIds = configuredSuperAdminIds(),
} = {}) => async (req, res, next) => {
	setNoStoreHeaders(res);
	try {
		const reservationId = stringId(req.params?.reservationId);
		const actor = req.profile;
		if (
			!mongoose.Types.ObjectId.isValid(reservationId) ||
			!canViewHotelReviewReservationDetails(actor, { superAdminIds })
		) {
			return res.status(404).json({ message: "Reservation not found." });
		}

		const actorId = stringId(actor._id || actor.id);
		const isSuperAdmin = superAdminIds.map(String).includes(actorId);
		if (isSuperAdmin) {
			req.hotelReviewReservationScopeVerifiedId = reservationId;
			return next();
		}

		const hotelIds = [...invitationActorHotelIds(actor)]
			.filter((id) => mongoose.Types.ObjectId.isValid(id))
			.map((id) => new mongoose.Types.ObjectId(id));
		if (!hotelIds.length) {
			return res.status(404).json({ message: "Reservation not found." });
		}

		const allowedReservation = await ReservationModel.exists({
			_id: new mongoose.Types.ObjectId(reservationId),
			hotelId: { $in: hotelIds },
		});
		if (!allowedReservation) {
			return res.status(404).json({ message: "Reservation not found." });
		}
		req.hotelReviewReservationScopeVerifiedId = reservationId;
		return next();
	} catch (error) {
		console.error("Unable to verify review reservation access:", error.message);
		return res.status(500).json({
			error: "Could not verify reservation access.",
		});
	}
};

exports.requireHotelReviewReservationScope =
	buildRequireHotelReviewReservationScope();

const canCreateReviewInvitationForHotel = (
	actor = {},
	hotelId,
	{ superAdminIds = configuredSuperAdminIds() } = {}
) => {
	const actorId = stringId(actor._id || actor.id);
	if (superAdminIds.map(String).includes(actorId)) return true;
	const access = new Set(
		(Array.isArray(actor.accessTo) ? actor.accessTo : [])
			.map((value) => String(value || "").trim())
			.filter(Boolean)
	);
	if (access.has("AllReservations") || access.has("HotelsReservations")) {
		return true;
	}
	if (!access.has("JannatBookingWebsite")) return false;
	return invitationActorHotelIds(actor).has(stringId(hotelId));
};

const parseBoundedPositiveInteger = (value, fallback, max) => {
	const parsed = Number.parseInt(String(value ?? ""), 10);
	if (!Number.isFinite(parsed) || parsed < 1) return fallback;
	return Math.min(parsed, max);
};

const parsePagination = (
	query = {},
	{ defaultLimit = PUBLIC_REVIEW_LIMIT_DEFAULT, maxLimit = PUBLIC_REVIEW_LIMIT_MAX } = {}
) => ({
	page: parseBoundedPositiveInteger(query.page, 1, MAX_PAGE),
	limit: parseBoundedPositiveInteger(query.limit, defaultLimit, maxLimit),
});

const parseStrictRating = (value) => {
	if (typeof value === "number") {
		return Number.isInteger(value) && value >= 1 && value <= 5 ? value : null;
	}
	if (typeof value === "string") {
		const normalized = value.trim();
		return /^[1-5]$/.test(normalized) ? Number(normalized) : null;
	}
	return null;
};

const unsafeControlCharacters = (value = "", multiline = false) => {
	const pattern = multiline
		? /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u
		: /[\u0000-\u001F\u007F]/u;
	return pattern.test(value);
};

const containsHtmlMarkup = (value = "") =>
	/<\s*\/?\s*[a-z][^>]*>/iu.test(String(value || ""));

const normalizeTextField = (
	value,
	{
		field,
		max,
		required = false,
		multiline = false,
		rejectHtml = true,
	} = {}
) => {
	if (value === undefined || value === null || value === "") {
		if (required) {
			throw new HotelReviewHttpError(400, `${field} is required.`, "INVALID_REVIEW");
		}
		return "";
	}
	if (typeof value !== "string") {
		throw new HotelReviewHttpError(400, `${field} must be text.`, "INVALID_REVIEW");
	}
	const normalized = value.normalize("NFKC").trim();
	if (required && !normalized) {
		throw new HotelReviewHttpError(400, `${field} is required.`, "INVALID_REVIEW");
	}
	if (normalized.length > max) {
		throw new HotelReviewHttpError(
			400,
			`${field} is too long.`,
			"INVALID_REVIEW"
		);
	}
	if (unsafeControlCharacters(normalized, multiline)) {
		throw new HotelReviewHttpError(
			400,
			`${field} contains unsupported characters.`,
			"INVALID_REVIEW"
		);
	}
	if (rejectHtml && containsHtmlMarkup(normalized)) {
		throw new HotelReviewHttpError(
			400,
			`${field} must be plain text.`,
			"INVALID_REVIEW"
		);
	}
	return normalized;
};

const normalizeLanguage = (value = "en") => {
	const language = String(value || "en")
		.trim()
		.toLowerCase()
		.split(/[-_]/)[0];
	return ["en", "ar", "fr"].includes(language) ? language : "en";
};

const normalizeConfirmationNumber = (value) =>
	normalizeTextField(value, {
		field: "Confirmation number",
		max: REVIEW_CONFIRMATION_MAX,
		required: false,
		multiline: false,
	}).toLowerCase();

const normalizeReviewToken = (value) => {
	const token = normalizeTextField(value, {
		field: "Review token",
		max: REVIEW_TOKEN_MAX,
		required: false,
		multiline: false,
		rejectHtml: true,
	});
	if (token && !INVITATION_TOKEN_PATTERN.test(token)) {
		throw new HotelReviewHttpError(
			400,
			"The review invitation is invalid or expired.",
			"INVALID_INVITATION"
		);
	}
	return token;
};

const validateReviewPayload = (payload = {}, { authenticated = false } = {}) => {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		throw new HotelReviewHttpError(400, "Invalid review request.", "INVALID_REVIEW");
	}

	const rating = parseStrictRating(payload.rating);
	if (rating === null) {
		throw new HotelReviewHttpError(
			400,
			"Please choose a whole-number rating from 1 to 5.",
			"INVALID_RATING"
		);
	}

	const comment = normalizeTextField(payload.comment, {
		field: "Comment",
		max: REVIEW_COMMENT_MAX,
		multiline: true,
	});
	const firstName = authenticated
		? ""
		: normalizeTextField(payload.firstName, {
				field: "First name",
				max: REVIEW_NAME_MAX,
				required: true,
		  });
	const lastName = authenticated
		? ""
		: normalizeTextField(payload.lastName, {
				field: "Last name",
				max: REVIEW_NAME_MAX,
				required: true,
		  });

	return {
		rating,
		comment,
		firstName,
		lastName,
		confirmationNumber: normalizeConfirmationNumber(payload.confirmationNumber),
		reviewToken: normalizeReviewToken(payload.reviewToken),
		language: normalizeLanguage(payload.language),
	};
};

const isHoneypotFilled = (payload = {}) => {
	if (!Object.prototype.hasOwnProperty.call(payload || {}, "website")) return false;
	if (typeof payload.website !== "string") return true;
	return payload.website.trim().length > 0;
};

const splitFullName = (value = "") => {
	const parts = String(value || "")
		.normalize("NFKC")
		.trim()
		.split(/\s+/u)
		.filter(Boolean);
	return {
		firstName: parts.shift() || "",
		lastName: parts.join(" "),
	};
};

const buildPublicDisplayName = (firstName = "", lastName = "") => {
	const first = String(firstName || "").trim();
	const last = String(lastName || "").trim();
	const initial = Array.from(last)[0] || "";
	return initial ? `${first} ${initial}.` : first;
};

const escapeRegex = (value = "") =>
	String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const decodedHotelSlug = (value = "") => {
	let decoded;
	try {
		decoded = decodeURIComponent(String(value || ""));
	} catch (_error) {
		throw new HotelReviewHttpError(400, "Invalid hotel slug.", "INVALID_HOTEL");
	}
	decoded = decoded
		.normalize("NFKC")
		.replace(/[_-]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (!decoded || decoded.length > 180 || unsafeControlCharacters(decoded)) {
		throw new HotelReviewHttpError(400, "Invalid hotel slug.", "INVALID_HOTEL");
	}
	return decoded;
};

const buildHotelSlugRegex = (value = "") => {
	const parts = decodedHotelSlug(value).split(" ").filter(Boolean).map(escapeRegex);
	return new RegExp(`^${parts.join("[\\s_-]+")}$`, "i");
};

const canonicalHotelSlug = (value = "") =>
	String(value || "")
		.normalize("NFKC")
		.trim()
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 220);

const findPublicHotelBySlug = async (hotelSlug) => {
	const slugRegex = buildHotelSlugRegex(hotelSlug);
	return HotelDetails.findOne({
		$or: [
			{ hotelName: { $regex: slugRegex } },
			{ hotelName_OtherLanguage: { $regex: slugRegex } },
		],
		activateHotel: true,
		xHotelProActive: { $ne: false },
	})
		.select(PUBLIC_HOTEL_SELECT)
		.lean()
		.exec();
};

const serializeHotel = (hotel = {}) => {
	const hotelName = String(hotel.hotelName || "").trim();
	const hotelSlug = canonicalHotelSlug(hotelName);
	const fallbackRating = Number(hotel.hotelRating);
	return {
		_id: stringId(hotel._id),
		hotelName,
		hotelName_OtherLanguage: String(hotel.hotelName_OtherLanguage || "").trim(),
		hotelSlug,
		hotelRating: Number.isFinite(fallbackRating) ? fallbackRating : 0,
		fallbackRating: Number.isFinite(fallbackRating) ? fallbackRating : 0,
	};
};

const emptyBreakdown = () => ({ "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 });

const serializeSummary = (summary = null) => {
	const ratingCount = Math.max(0, Number(summary?.ratingCount || 0));
	const ratingSum = Math.max(0, Number(summary?.ratingSum || 0));
	const sourceBreakdown = summary?.breakdown || {};
	const averageRating = ratingCount
		? Number((ratingSum / ratingCount).toFixed(2))
		: 0;
	return {
		ratingCount,
		ratingSum,
		averageRating,
		breakdown: {
			"1": Math.max(0, Number(sourceBreakdown.oneStar || 0)),
			"2": Math.max(0, Number(sourceBreakdown.twoStar || 0)),
			"3": Math.max(0, Number(sourceBreakdown.threeStar || 0)),
			"4": Math.max(0, Number(sourceBreakdown.fourStar || 0)),
			"5": Math.max(0, Number(sourceBreakdown.fiveStar || 0)),
		},
		hasRealRating: ratingCount > 0,
	};
};

const summaryFromAggregate = (aggregate = {}) => ({
	ratingCount: Number(aggregate.ratingCount || 0),
	ratingSum: Number(aggregate.ratingSum || 0),
	breakdown: {
		oneStar: Number(aggregate.oneStar || 0),
		twoStar: Number(aggregate.twoStar || 0),
		threeStar: Number(aggregate.threeStar || 0),
		fourStar: Number(aggregate.fourStar || 0),
		fiveStar: Number(aggregate.fiveStar || 0),
	},
});

const getHotelReviewSummary = (hotelId, session = null) => {
	const query = HotelReviewSummary.findOne({ hotelId }).lean();
	if (session) query.session(session);
	return query.exec();
};

const summaryHasValidInvariants = (summary = null) => {
	if (!summary) return false;
	const ratingCount = Number(summary.ratingCount);
	const ratingSum = Number(summary.ratingSum);
	const breakdown = summary.breakdown || {};
	const buckets = [
		Number(breakdown.oneStar),
		Number(breakdown.twoStar),
		Number(breakdown.threeStar),
		Number(breakdown.fourStar),
		Number(breakdown.fiveStar),
	];
	if (
		!Number.isInteger(ratingCount) ||
		ratingCount < 0 ||
		!Number.isInteger(ratingSum) ||
		ratingSum < 0 ||
		buckets.some((count) => !Number.isInteger(count) || count < 0)
	) {
		return false;
	}
	const bucketCount = buckets.reduce((total, count) => total + count, 0);
	const bucketSum = buckets.reduce(
		(total, count, index) => total + count * (index + 1),
		0
	);
	return bucketCount === ratingCount && bucketSum === ratingSum;
};

const reviewSummarySourceState = async (hotelId) => {
	const [latestReview, visibleRatingCount] = await Promise.all([
		HotelReview.findOne({ hotelId })
			.select("updatedAt")
			.sort({ updatedAt: -1, _id: -1 })
			.lean()
			.exec(),
		HotelReview.countDocuments({
			hotelId,
			...effectiveRatingVisibilityMongoFilter(),
		}).exec(),
	]);
	return {
		latestReview,
		visibleRatingCount,
		// Kept as an alias for callers/tests written before visibility was split.
		activeCount: visibleRatingCount,
	};
};

const summaryIsFreshForSource = (
	summary,
	{ latestReview, visibleRatingCount, activeCount } = {},
) => {
	if (!summaryHasValidInvariants(summary)) return false;
	const summaryUpdatedAt = new Date(summary.updatedAt || 0).getTime();
	const sourceUpdatedAt = new Date(latestReview?.updatedAt || 0).getTime();
	const sourceCount =
		visibleRatingCount === undefined ? activeCount : visibleRatingCount;
	return (
		Number.isFinite(summaryUpdatedAt) &&
		summaryUpdatedAt >= sourceUpdatedAt &&
		Number(summary.ratingCount) === Number(sourceCount)
	);
};

const buildSummaryCompareAndSwapFilter = (summary) => {
	const breakdown = summary?.breakdown || {};
	const filter = {
		_id: summary?._id,
		ratingCount: Number(summary?.ratingCount || 0),
		ratingSum: Number(summary?.ratingSum || 0),
		"breakdown.oneStar": Number(breakdown.oneStar || 0),
		"breakdown.twoStar": Number(breakdown.twoStar || 0),
		"breakdown.threeStar": Number(breakdown.threeStar || 0),
		"breakdown.fourStar": Number(breakdown.fourStar || 0),
		"breakdown.fiveStar": Number(breakdown.fiveStar || 0),
	};
	if (summary?.updatedAt) filter.updatedAt = summary.updatedAt;
	return filter;
};

const buildHotelReviewSummaryPipeline = (hotelId) => [
	{
		$match: {
			hotelId: mongoose.Types.ObjectId(stringId(hotelId)),
			...effectiveRatingVisibilityMongoFilter(),
		},
	},
	{
		$group: {
			_id: null,
			ratingCount: { $sum: 1 },
			ratingSum: { $sum: "$rating" },
			oneStar: { $sum: { $cond: [{ $eq: ["$rating", 1] }, 1, 0] } },
			twoStar: { $sum: { $cond: [{ $eq: ["$rating", 2] }, 1, 0] } },
			threeStar: { $sum: { $cond: [{ $eq: ["$rating", 3] }, 1, 0] } },
			fourStar: { $sum: { $cond: [{ $eq: ["$rating", 4] }, 1, 0] } },
			fiveStar: { $sum: { $cond: [{ $eq: ["$rating", 5] }, 1, 0] } },
		},
	},
];

const aggregateHotelReviewSummary = async (hotelId, session = null) => {
	const pipeline = buildHotelReviewSummaryPipeline(hotelId);
	const aggregation = HotelReview.aggregate(pipeline);
	if (session) aggregation.session(session);
	const [row] = await aggregation.exec();
	return summaryFromAggregate(row || {});
};

const ensureHotelReviewSummary = async (hotelId, session = null) => {
	const existing = await getHotelReviewSummary(hotelId, session);
	// Transactional callers deliberately trust their session-local summary. A
	// submission creates its review before applying the summary delta, so a
	// freshness rebuild inside that transaction would count the new rating twice.
	if (existing && session) return existing;
	if (existing) {
		const sourceState = await reviewSummarySourceState(hotelId);
		if (summaryIsFreshForSource(existing, sourceState)) return existing;
		return repairHotelReviewSummary(hotelId);
	}

	const values = await aggregateHotelReviewSummary(hotelId, session);

	try {
		return await HotelReviewSummary.findOneAndUpdate(
			{ hotelId },
			{
				$setOnInsert: {
					hotelId,
					ratingCount: values.ratingCount,
					ratingSum: values.ratingSum,
					breakdown: values.breakdown,
				},
			},
			{
				upsert: true,
				new: true,
				lean: true,
				session,
				setDefaultsOnInsert: false,
			}
		).exec();
	} catch (error) {
		// Two first reads can race to materialize the same per-hotel summary. Outside
		// a transaction, the unique index decides the winner and the loser simply
		// reads that winner. Transactional callers fail closed so their transaction
		// can retry or roll back as one unit.
		if (error?.code === 11000 && !session) {
			const winner = await getHotelReviewSummary(hotelId);
			if (winner) return winner;
		}
		throw error;
	}
};

const rebuildHotelReviewSummary = async (hotelId, session = null) => {
	const values = await aggregateHotelReviewSummary(hotelId, session);
	const update = {
		$set: {
			ratingCount: values.ratingCount,
			ratingSum: values.ratingSum,
			breakdown: values.breakdown,
		},
		$setOnInsert: { hotelId },
	};
	try {
		return await HotelReviewSummary.findOneAndUpdate(
			{ hotelId },
			update,
			{
				upsert: true,
				new: true,
				lean: true,
				session,
				setDefaultsOnInsert: false,
			}
		).exec();
	} catch (error) {
		if (error?.code !== 11000 || session) throw error;
		// Another writer created the summary between the aggregate and upsert.
		return HotelReviewSummary.findOneAndUpdate(
			{ hotelId },
			{ $set: update.$set },
			{ new: true, lean: true, runValidators: true }
		).exec();
	}
};

const repairHotelReviewSummary = async (hotelId) =>
	withHotelReviewFallbackMutex(hotelId, async () => {
		// Standalone writes use this same per-hotel boundary. Replica-set writes are
		// transactional, while the compare-and-swap below prevents a repair based on
		// an older aggregate from replacing a newer committed summary.
		for (let attempt = 0; attempt < 3; attempt += 1) {
			const current = await getHotelReviewSummary(hotelId);
			if (!current) return rebuildHotelReviewSummary(hotelId);

			const sourceState = await reviewSummarySourceState(hotelId);
			if (summaryIsFreshForSource(current, sourceState)) return current;

			const values = await aggregateHotelReviewSummary(hotelId);
			const repaired = await HotelReviewSummary.findOneAndUpdate(
				buildSummaryCompareAndSwapFilter(current),
				{
					$set: {
						ratingCount: values.ratingCount,
						ratingSum: values.ratingSum,
						breakdown: values.breakdown,
					},
				},
				{ new: true, lean: true, runValidators: true }
			).exec();
			if (repaired) return repaired;
		}

		throw new HotelReviewHttpError(
			503,
			"The hotel rating is being updated. Please try again.",
			"SUMMARY_CONFLICT"
		);
	});

const invalidateHotelReviewSummary = async (hotelId) => {
	await HotelReviewSummary.deleteOne({ hotelId }).exec();
};

const summaryDeltaUpdate = (rating, direction) => {
	const field = BREAKDOWN_FIELD_BY_RATING[rating];
	return {
		$inc: {
			ratingCount: direction,
			ratingSum: direction * rating,
			[`breakdown.${field}`]: direction,
		},
	};
};

const applySummaryDelta = async ({ hotelId, rating, direction, session }) => {
	const field = BREAKDOWN_FIELD_BY_RATING[rating];
	if (!field || ![1, -1].includes(direction)) {
		throw new HotelReviewHttpError(500, "Could not update the hotel rating.");
	}
	await ensureHotelReviewSummary(hotelId, session);
	const filter = { hotelId };
	if (direction < 0) {
		filter.ratingCount = { $gte: 1 };
		filter.ratingSum = { $gte: rating };
		filter[`breakdown.${field}`] = { $gte: 1 };
	}
	const summary = await HotelReviewSummary.findOneAndUpdate(
		filter,
		summaryDeltaUpdate(rating, direction),
		{
			new: true,
			lean: true,
			session,
			runValidators: true,
		}
	).exec();
	if (!summary) {
		throw new HotelReviewHttpError(
			503,
			"The rating could not be updated safely. Please try again.",
			"SUMMARY_CONFLICT"
		);
	}
	return summary;
};

const serializePublicReview = (review = {}) => {
	const visibility = resolveHotelReviewVisibility(review);
	if (!visibility.hasPublicContent) return null;
	return {
		_id: stringId(review._id),
		rating: visibility.ratingVisible ? Number(review.rating) : null,
		comment: visibility.commentVisible ? String(review.comment || "") : "",
		ratingVisible: visibility.ratingVisible,
		commentVisible: visibility.commentVisible,
		displayName: String(review.displayName || "Guest"),
		verifiedStay: review.verifiedStay === true,
		createdAt: review.createdAt || null,
		updatedAt: review.updatedAt || null,
	};
};

const buildPublicReviewListFilter = (hotelId) => ({
	hotelId,
	...publicReviewContentMongoFilter(),
});

const hashReviewToken = (token = "") =>
	crypto.createHash("sha256").update(String(token), "utf8").digest("hex");

const generateReviewToken = () => crypto.randomBytes(INVITATION_TOKEN_BYTES).toString("base64url");

const configuredReviewDataSecret = () =>
	String(
		process.env.HOTEL_REVIEW_DATA_SECRET ||
			process.env.JWT_SECRET2 ||
			process.env.JWT_SECRET ||
			""
	);

const deriveReviewEncryptionKey = (secret = configuredReviewDataSecret()) => {
	if (!secret) {
		throw new HotelReviewHttpError(
			503,
			"Review confirmation details are temporarily unavailable.",
			"REVIEW_ENCRYPTION_UNAVAILABLE"
		);
	}
	return crypto
		.createHash("sha256")
		.update(`jannat-hotel-review-data:v1:${secret}`, "utf8")
		.digest();
};

const encryptReviewSensitiveValue = (value = "", secret) => {
	if (!value) return "";
	const iv = crypto.randomBytes(12);
	const cipher = crypto.createCipheriv("aes-256-gcm", deriveReviewEncryptionKey(secret), iv);
	const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
	const tag = cipher.getAuthTag();
	return ["v1", iv.toString("base64url"), tag.toString("base64url"), encrypted.toString("base64url")].join(":");
};

const decryptReviewSensitiveValue = (value = "", secret) => {
	if (!value) return "";
	const [version, ivValue, tagValue, encryptedValue] = String(value).split(":");
	if (version !== "v1" || !ivValue || !tagValue || !encryptedValue) return "";
	try {
		const decipher = crypto.createDecipheriv(
			"aes-256-gcm",
			deriveReviewEncryptionKey(secret),
			Buffer.from(ivValue, "base64url")
		);
		decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
		return Buffer.concat([
			decipher.update(Buffer.from(encryptedValue, "base64url")),
			decipher.final(),
		]).toString("utf8");
	} catch (_error) {
		return "";
	}
};

const confirmationNumberLookupHash = (value = "", secret) => {
	const normalized = String(value || "").normalize("NFKC").trim().toLowerCase();
	if (!normalized) return "";
	return crypto
		.createHmac("sha256", deriveReviewEncryptionKey(secret))
		.update(normalized, "utf8")
		.digest("hex");
};

const maskConfirmationNumber = (value = "") => {
	const clean = String(value || "").trim();
	if (!clean) return "";
	const suffix = Array.from(clean).slice(-4).join("");
	return `••••${suffix}`;
};

const buildRoomLabel = (reservation = {}) => {
	const populatedRooms = Array.isArray(reservation.roomId)
		? reservation.roomId.filter((room) => room && typeof room === "object")
		: [];
	const roomNumbers = [
		...new Set(
			populatedRooms
				.map((room) => String(room.room_number || "").trim())
				.filter(Boolean)
		),
	];
	if (roomNumbers.length) {
		return `${roomNumbers.length > 1 ? "Rooms" : "Room"} ${roomNumbers.join(", ")}`;
	}

	const populatedTypes = populatedRooms
		.map((room) => String(room.display_name || room.room_type || "").trim())
		.filter(Boolean);
	const reservedTypes = (Array.isArray(reservation.pickedRoomsType)
		? reservation.pickedRoomsType
		: []
	)
		.map((room) =>
			String(
				room?.displayName ||
					room?.display_name ||
					room?.room_type ||
					room?.roomType ||
					""
			).trim()
		)
		.filter(Boolean);
	const roomTypes = [...new Set([...populatedTypes, ...reservedTypes])];
	return roomTypes.join(", ").slice(0, 500);
};

const buildReviewReservationContext = ({
	invitation = null,
	invitationReservation = null,
	manualReservation = null,
	submittedConfirmationNumber = "",
} = {}) => {
	const invitedStay = Boolean(invitation && invitationReservation?._id);
	const canonicalConfirmationNumber = String(
		submittedConfirmationNumber || invitationReservation?.confirmation_number || ""
	)
		.trim()
		.toLowerCase();
	return {
		// A manually entered confirmation can enrich private staff context, but it
		// is not proof of identity and never consumes the reservation's one-review
		// invitation slot.
		reservationId: invitedStay ? invitationReservation._id : null,
		invitationId: invitedStay ? invitation._id : null,
		verifiedStay: invitedStay,
		verificationMethod: invitedStay
			? "invitation"
			: manualReservation
			? "confirmation"
			: "none",
		confirmationNumberEncrypted:
			submittedConfirmationNumber && !invitedStay
				? encryptReviewSensitiveValue(canonicalConfirmationNumber)
				: "",
		confirmationNumberLookupHash: confirmationNumberLookupHash(
			canonicalConfirmationNumber
		),
		confirmationNumberMasked: maskConfirmationNumber(canonicalConfirmationNumber),
		roomLabel: buildRoomLabel(invitationReservation || manualReservation || {}),
	};
};

const reservationQueryWithRooms = (filter, session = null) => {
	const query = Reservations.findOne(filter)
		.select(RESERVATION_REVIEW_SELECT)
		.populate({
			path: "roomId",
			select: "room_number room_type display_name",
		})
		.lean();
	if (session) query.session(session);
	return query.exec();
};

const findReservationByConfirmation = (confirmationNumber, hotelId, session = null) =>
	reservationQueryWithRooms(
		{ confirmation_number: confirmationNumber, hotelId },
		session
	);

const findReservationById = (reservationId, hotelId = null, session = null) => {
	const filter = { _id: reservationId };
	if (hotelId) filter.hotelId = hotelId;
	return reservationQueryWithRooms(filter, session);
};

const loadInvitation = (token, session = null, requireUnused = true) => {
	const filter = {
		tokenHash: hashReviewToken(token),
		expiresAt: { $gt: new Date() },
		revokedAt: null,
	};
	if (requireUnused) filter.usedAt = null;
	const query = HotelReviewInvitation.findOne(filter).lean();
	if (session) query.session(session);
	return query.exec();
};

const requestBytesTooLarge = (req = {}) => {
	const value = Number(req.headers?.["content-length"] || 0);
	return Number.isFinite(value) && value > MAX_REVIEW_REQUEST_BYTES;
};

const requestRateLimitIdentity = (req = {}) => {
	const authId = stringId(req.auth?._id || req.auth?.id);
	if (authId) return `user:${authId}`;
	const forwarded = String(
		req.headers?.["cf-connecting-ip"] ||
			req.headers?.["x-real-ip"] ||
			req.headers?.["x-forwarded-for"] ||
			""
	)
		.split(",")[0]
		.trim()
		.slice(0, 80);
	const socketAddress = String(
		req.socket?.remoteAddress || req.connection?.remoteAddress || req.ip || "unknown"
	)
		.trim()
		.slice(0, 80);
	return `guest:${socketAddress}:${forwarded}`;
};

const cleanExpiredRateLimitEntries = (now) => {
	if (reviewSubmissionRateLimit.size < REVIEW_RATE_LIMIT_MAX_KEYS) return;
	for (const [key, record] of reviewSubmissionRateLimit) {
		if (record.resetAt <= now || reviewSubmissionRateLimit.size >= REVIEW_RATE_LIMIT_MAX_KEYS) {
			reviewSubmissionRateLimit.delete(key);
		}
		if (reviewSubmissionRateLimit.size < REVIEW_RATE_LIMIT_MAX_KEYS) break;
	}
};

const consumeReviewRateLimit = (req = {}) => {
	const now = Date.now();
	cleanExpiredRateLimitEntries(now);
	const identity = requestRateLimitIdentity(req);
	const key = crypto.createHash("sha256").update(identity).digest("hex");
	const record = reviewSubmissionRateLimit.get(key);
	if (!record || record.resetAt <= now) {
		reviewSubmissionRateLimit.set(key, {
			count: 1,
			resetAt: now + REVIEW_RATE_LIMIT_WINDOW_MS,
		});
		return { allowed: true, retryAfterSeconds: 0 };
	}
	if (record.count >= REVIEW_RATE_LIMIT_MAX) {
		return {
			allowed: false,
			retryAfterSeconds: Math.max(1, Math.ceil((record.resetAt - now) / 1000)),
		};
	}
	record.count += 1;
	reviewSubmissionRateLimit.set(key, record);
	return { allowed: true, retryAfterSeconds: 0 };
};

const withHotelReviewFallbackMutex = async (hotelId, work) => {
	const key = stringId(hotelId);
	if (!key || typeof work !== "function") {
		throw new HotelReviewHttpError(500, "Could not coordinate the rating update.");
	}
	let record = hotelReviewFallbackMutexes.get(key);
	if (!record) {
		if (hotelReviewFallbackMutexes.size >= FALLBACK_MUTEX_MAX_KEYS) {
			throw new HotelReviewHttpError(
				503,
				"The rating service is busy. Please try again.",
				"REVIEW_MUTEX_CAPACITY"
			);
		}
		record = { tail: Promise.resolve(), pending: 0 };
		hotelReviewFallbackMutexes.set(key, record);
	}
	if (record.pending >= FALLBACK_MUTEX_MAX_WAITERS_PER_KEY) {
		throw new HotelReviewHttpError(
			503,
			"The rating service is busy. Please try again.",
			"REVIEW_MUTEX_CAPACITY"
		);
	}

	const previous = record.tail;
	let release;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	record.tail = gate;
	record.pending += 1;
	await previous.catch(() => undefined);
	try {
		return await work();
	} finally {
		record.pending -= 1;
		release();
		if (record.pending === 0 && hotelReviewFallbackMutexes.get(key) === record) {
			hotelReviewFallbackMutexes.delete(key);
		}
	}
};

const isUnsupportedTransactionError = (error = {}) => {
	const message = String(error?.message || error?.errmsg || error?.cause?.message || "");
	return (
		/transaction numbers? (?:are|is) only allowed on a replica set member or mongos/i.test(
			message
		) ||
		/transactions? (?:are|is) not supported/i.test(message) ||
		/no replication enabled/i.test(message)
	);
};

const runReviewTransaction = async (work, fallbackWork = null) => {
	if (reviewTransactionsUnsupported && fallbackWork) {
		return fallbackWork();
	}
	let session;
	try {
		session = await mongoose.startSession();
	} catch (error) {
		if (fallbackWork && isUnsupportedTransactionError(error)) {
			reviewTransactionsUnsupported = true;
			return fallbackWork(error);
		}
		throw error;
	}
	let unsupportedError = null;
	try {
		let result;
		await session.withTransaction(
			async () => {
				result = await work(session);
			},
			{
				readConcern: { level: "snapshot" },
				writeConcern: { w: "majority" },
			}
		);
		return result;
	} catch (error) {
		if (fallbackWork && isUnsupportedTransactionError(error)) {
			reviewTransactionsUnsupported = true;
			unsupportedError = error;
		} else {
			throw error;
		}
	} finally {
		await session.endSession();
	}
	return fallbackWork(unsupportedError);
};

const sendControllerError = (res, error, context) => {
	if (error instanceof HotelReviewHttpError) {
		return res.status(error.status).json({ error: error.message, code: error.code });
	}
	if (
		error?.code === 11000 &&
		(error?.keyPattern?.reservationId ||
			/uniq_hotel_review_per_reservation/i.test(String(error?.message || "")))
	) {
		return res.status(409).json({
			error: "A review has already been submitted for this stay.",
			code: "REVIEW_ALREADY_SUBMITTED",
		});
	}
	if (error?.code === 11000) {
		console.error(`[hotel-reviews] ${context} duplicate-write conflict:`, error);
		return res.status(503).json({
			error: "The review could not be saved safely. Please try again.",
			code: "HOTEL_REVIEW_WRITE_CONFLICT",
		});
	}
	if (error?.name === "ValidationError" || error?.name === "CastError") {
		return res.status(400).json({
			error: "The review information is invalid.",
			code: "INVALID_REVIEW",
		});
	}
	console.error(`[hotel-reviews] ${context}:`, error);
	return res.status(500).json({
		error: "The review request could not be completed. Please try again.",
		code: "HOTEL_REVIEW_SERVER_ERROR",
	});
};

exports.listPublicHotelReviews = async (req, res) => {
	setNoStoreHeaders(res);
	try {
		const hotel = await findPublicHotelBySlug(req.params.hotelSlug);
		if (!hotel) {
			return res.status(404).json({ error: "Hotel not found." });
		}
		const { page, limit } = parsePagination(req.query);
		const skip = (page - 1) * limit;
		const publicContentFilter = buildPublicReviewListFilter(hotel._id);
		const [summaryDocument, reviews, publicReviewCount] = await Promise.all([
			ensureHotelReviewSummary(hotel._id, null),
			HotelReview.find(publicContentFilter)
				.select(PUBLIC_REVIEW_SELECT)
				.sort({ _id: -1 })
				.skip(skip)
				.limit(limit)
				.lean()
				.exec(),
			HotelReview.countDocuments(publicContentFilter).exec(),
		]);
		const summary = serializeSummary(summaryDocument);
		const total = Number(publicReviewCount || 0);
		const totalPages = total ? Math.ceil(total / limit) : 0;
		return res.status(200).json({
			hotel: serializeHotel(hotel),
			summary,
			reviews: reviews.map(serializePublicReview).filter(Boolean),
			pagination: {
				page,
				limit,
				total,
				totalItems: total,
				totalPages,
				hasNextPage: page < totalPages,
				hasPreviousPage: page > 1 && totalPages > 0,
			},
		});
	} catch (error) {
		return sendControllerError(res, error, "list public reviews");
	}
};

exports.submitHotelReview = async (req, res) => {
	setNoStoreHeaders(res);
	try {
		if (requestBytesTooLarge(req)) {
			throw new HotelReviewHttpError(
				413,
				"The review request is too large.",
				"REVIEW_TOO_LARGE"
			);
		}
		if (isHoneypotFilled(req.body)) {
			return res.status(200).json({
				success: true,
				review: null,
				summary: serializeSummary(null),
			});
		}
		const rateLimit = consumeReviewRateLimit(req);
		if (!rateLimit.allowed) {
			res.setHeader("Retry-After", String(rateLimit.retryAfterSeconds));
			throw new HotelReviewHttpError(
				429,
				"Too many review attempts. Please wait a few minutes and try again.",
				"REVIEW_RATE_LIMITED"
			);
		}

		const authId = stringId(req.auth?._id || req.auth?.id);
		const validated = validateReviewPayload(req.body, { authenticated: Boolean(authId) });
		const hotel = await findPublicHotelBySlug(req.params.hotelSlug);
		if (!hotel) {
			throw new HotelReviewHttpError(404, "Hotel not found.", "HOTEL_NOT_FOUND");
		}

		let reviewerUser = null;
		let firstName = validated.firstName;
		let lastName = validated.lastName;
		if (authId) {
			if (!mongoose.Types.ObjectId.isValid(authId)) {
				throw new HotelReviewHttpError(401, "Please sign in again.", "INVALID_SESSION");
			}
			reviewerUser = await User.findById(authId)
				.select("_id name activeUser")
				.lean()
				.exec();
			if (!reviewerUser || reviewerUser.activeUser === false) {
				throw new HotelReviewHttpError(401, "Please sign in again.", "INVALID_SESSION");
			}
			const accountName = splitFullName(reviewerUser.name);
			firstName = normalizeTextField(accountName.firstName, {
				field: "Account name",
				max: REVIEW_NAME_MAX,
				required: true,
			});
			lastName = normalizeTextField(accountName.lastName, {
				field: "Account name",
				max: REVIEW_NAME_MAX,
			});
		}
		// Materialize the one-document summary before the multi-document review
		// transaction. The unique index safely resolves concurrent first visitors;
		// subsequent transaction work is then free of an upsert race.
		await ensureHotelReviewSummary(hotel._id, null);

		const performSubmission = async (session = null, compensate = false) => {
			let invitation = null;
			let invitationReservation = null;
			let manualReservation = null;
			let review = null;
			try {
				if (validated.reviewToken) {
					invitation = await loadInvitation(validated.reviewToken, session, true);
					if (!invitation || stringId(invitation.hotelId) !== stringId(hotel._id)) {
						throw new HotelReviewHttpError(
							400,
							"The review invitation is invalid or expired.",
							"INVALID_INVITATION"
						);
					}
					invitationReservation = await findReservationById(
						invitation.reservationId,
						hotel._id,
						session
					);
					if (!invitationReservation) {
						throw new HotelReviewHttpError(
							400,
							"The review invitation is invalid or expired.",
							"INVALID_INVITATION"
						);
					}
					if (
						validated.confirmationNumber &&
						validated.confirmationNumber !==
							String(invitationReservation.confirmation_number || "")
								.trim()
								.toLowerCase()
					) {
						throw new HotelReviewHttpError(
							400,
							"The review invitation is invalid or expired.",
							"INVALID_INVITATION"
						);
					}
				} else if (validated.confirmationNumber) {
					manualReservation = await findReservationByConfirmation(
						validated.confirmationNumber,
						hotel._id,
						session
					);
				}

				await ensureHotelReviewSummary(hotel._id, session);
				const reservationContext = buildReviewReservationContext({
					invitation,
					invitationReservation,
					manualReservation,
					submittedConfirmationNumber: validated.confirmationNumber,
				});
				const hotelSlug = canonicalHotelSlug(hotel.hotelName);
				const reviewData = {
					hotelId: hotel._id,
					hotelNameSnapshot: String(hotel.hotelName || "Hotel"),
					hotelSlug,
					rating: validated.rating,
					comment: validated.comment,
					status: "active",
					ratingVisible: true,
					commentVisible: Boolean(validated.comment),
					displayName: buildPublicDisplayName(firstName, lastName),
					firstName,
					lastName,
					userId: reviewerUser?._id || null,
					authenticatedReviewer: Boolean(reviewerUser),
					...reservationContext,
					language: normalizeLanguage(req.body?.language || req.query?.lang || "en"),
				};
				if (session) {
					[review] = await HotelReview.create([reviewData], { session });
				} else {
					review = await HotelReview.create(reviewData);
				}

				if (invitation) {
					const claim = await HotelReviewInvitation.updateOne(
						{
							_id: invitation._id,
							usedAt: null,
							revokedAt: null,
							expiresAt: { $gt: new Date() },
						},
						{ $set: { usedAt: new Date(), usedByReviewId: review._id } },
						session ? { session } : {}
					).exec();
					if (claim.modifiedCount !== 1) {
						throw new HotelReviewHttpError(
							409,
							"A review has already been submitted for this stay.",
							"REVIEW_ALREADY_SUBMITTED"
						);
					}
					await HotelReviewInvitation.updateMany(
						{
							_id: { $ne: invitation._id },
							reservationId: invitation.reservationId,
							usedAt: null,
							revokedAt: null,
						},
						{ $set: { revokedAt: new Date() } },
						session ? { session } : {}
					).exec();
				}

				const summary = compensate
					? await rebuildHotelReviewSummary(hotel._id)
					: await applySummaryDelta({
							hotelId: hotel._id,
							rating: validated.rating,
							direction: 1,
							session,
					  });
				return { review, summary };
			} catch (error) {
				if (compensate && review?._id) {
					const compensationErrors = [];
					try {
						await HotelReview.deleteOne({ _id: review._id }).exec();
					} catch (compensationError) {
						compensationErrors.push(compensationError);
					}
					if (invitation?._id) {
						try {
							await HotelReviewInvitation.updateOne(
								{ _id: invitation._id, usedByReviewId: review._id },
								{ $set: { usedAt: null, usedByReviewId: null } }
							).exec();
						} catch (compensationError) {
							compensationErrors.push(compensationError);
						}
					}
					try {
						await rebuildHotelReviewSummary(hotel._id);
					} catch (compensationError) {
						compensationErrors.push(compensationError);
						try {
							// Removing a possibly stale materialized row makes the next
							// public/admin read rebuild from the review source of truth.
							await invalidateHotelReviewSummary(hotel._id);
						} catch (invalidationError) {
							compensationErrors.push(invalidationError);
						}
					}
					if (compensationErrors.length) {
						console.error(
							"[hotel-reviews] standalone submission compensation was incomplete:",
							compensationErrors
						);
					}
				}
				throw error;
			}
		};

		const transactionResult = await runReviewTransaction(
			(session) => performSubmission(session, false),
			() =>
				withHotelReviewFallbackMutex(hotel._id, async () => {
					await rebuildHotelReviewSummary(hotel._id);
					return performSubmission(null, true);
				})
		);
		invalidatePublicHotelGuestReviewSummaryCache();

		return res.status(201).json({
			success: true,
			review: serializePublicReview(transactionResult.review),
			summary: serializeSummary(transactionResult.summary),
		});
	} catch (error) {
		return sendControllerError(res, error, "submit review");
	}
};

const genericInvitationError = () =>
	new HotelReviewHttpError(
		404,
		"The review invitation is invalid or expired.",
		"INVALID_INVITATION"
	);

exports.resolveHotelReviewInvitation = async (req, res) => {
	setNoStoreHeaders(res);
	try {
		const token = normalizeReviewToken(req.body?.reviewToken);
		if (!token) throw genericInvitationError();
		const invitation = await loadInvitation(token, null, true);
		if (!invitation) throw genericInvitationError();
		const [reservation, hotel, existingReview] = await Promise.all([
			findReservationById(invitation.reservationId, invitation.hotelId),
			HotelDetails.findOne({
				_id: invitation.hotelId,
				activateHotel: true,
				xHotelProActive: { $ne: false },
			})
				.select(PUBLIC_HOTEL_SELECT)
				.lean()
				.exec(),
			HotelReview.exists({
				hotelId: invitation.hotelId,
				reservationId: invitation.reservationId,
			}),
		]);
		if (!reservation || !hotel || existingReview) throw genericInvitationError();
		const guestName = splitFullName(reservation.customer_details?.name);
		return res.status(200).json({
			success: true,
			prefill: {
				firstName: guestName.firstName,
				lastName: guestName.lastName,
				confirmationNumber: String(reservation.confirmation_number || ""),
				roomLabel: buildRoomLabel(reservation),
				hotelName: String(hotel.hotelName || ""),
				hotelSlug: canonicalHotelSlug(hotel.hotelName),
			},
		});
	} catch (error) {
		if (!(error instanceof HotelReviewHttpError)) {
			console.error("[hotel-reviews] invitation prefill failed safely:", error);
		}
		const generic = genericInvitationError();
		return res.status(generic.status).json({ error: generic.message, code: generic.code });
	}
};

const invitationLifetimeDays = () => {
	const configured = Number.parseInt(process.env.HOTEL_REVIEW_INVITATION_DAYS || "90", 10);
	if (!Number.isFinite(configured)) return 90;
	return Math.min(Math.max(configured, 1), 365);
};

const isExplicitInvitationReplacement = (body = {}) => body?.replace === true;

const activeReviewInvitationExistsError = () =>
	new HotelReviewHttpError(
		409,
		"An active review link already exists for this stay. Confirm replacement to invalidate the previous link.",
		"ACTIVE_REVIEW_INVITATION_EXISTS"
	);

const reviewInvitationWriteConflictError = () =>
	new HotelReviewHttpError(
		409,
		"The active review link changed while it was being replaced. Please try again.",
		"INVITATION_WRITE_CONFLICT"
	);

const configuredJannatBookingUrl = () => {
	const configured = String(
		process.env.JANNAT_BOOKING_PUBLIC_URL ||
			process.env.REACT_APP_MAIN_URL_JANNAT ||
			"https://jannatbooking.com"
	).trim();
	try {
		const parsed = new URL(configured);
		if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Invalid protocol");
		return parsed.origin;
	} catch (_error) {
		return "https://jannatbooking.com";
	}
};

const buildReviewInvitationUrl = ({
	baseUrl = configuredJannatBookingUrl(),
	hotelSlug,
	language,
	confirmationNumber,
	reviewToken,
}) => {
	const url = new URL(`/single-hotel/${encodeURIComponent(hotelSlug)}`, baseUrl);
	url.searchParams.set("lang", normalizeLanguage(language));
	url.searchParams.set("review", "1");
	const privateFragment = new URLSearchParams();
	privateFragment.set("reviewToken", String(reviewToken || ""));
	if (confirmationNumber) {
		privateFragment.set("confirmationNumber", String(confirmationNumber));
	}
	url.hash = `reviews?${privateFragment.toString()}`;
	return url.toString();
};

exports.createHotelReviewInvitation = async (req, res) => {
	setNoStoreHeaders(res);
	try {
		const { reservationId } = req.params;
		const actorId = stringId(req.auth?._id || req.auth?.id);
		if (
			!mongoose.Types.ObjectId.isValid(reservationId) ||
			!mongoose.Types.ObjectId.isValid(actorId)
		) {
			throw new HotelReviewHttpError(400, "Invalid reservation.", "INVALID_RESERVATION");
		}
		const reservation = await findReservationById(reservationId);
		if (!reservation?.hotelId) {
			throw new HotelReviewHttpError(404, "Reservation not found.", "RESERVATION_NOT_FOUND");
		}
		const hotel = await HotelDetails.findOne({
				_id: reservation.hotelId,
				activateHotel: true,
				xHotelProActive: { $ne: false },
			})
				.select(PUBLIC_HOTEL_SELECT)
				.lean()
				.exec();
		if (!hotel) {
			throw new HotelReviewHttpError(
				409,
				"This hotel is not currently available for public reviews.",
				"HOTEL_NOT_REVIEWABLE"
			);
		}
		if (!canCreateReviewInvitationForHotel(req.profile || {}, hotel._id)) {
			throw new HotelReviewHttpError(
				403,
				"You do not have access to create a review link for this hotel.",
				"INVITATION_HOTEL_ACCESS_DENIED"
			);
		}

		const language = normalizeLanguage(req.body?.language);
		const replaceExistingInvitation = isExplicitInvitationReplacement(req.body);
		const expiresAt = new Date(
			Date.now() + invitationLifetimeDays() * 24 * 60 * 60 * 1000
		);
		const issueInvitation = async (session = null, { compensate = false } = {}) => {
			const reviewQuery = HotelReview.exists({
				hotelId: reservation.hotelId,
				reservationId: reservation._id,
			});
			if (session) reviewQuery.session(session);
			if (await reviewQuery.exec()) {
				throw new HotelReviewHttpError(
					409,
					"A review has already been submitted for this stay.",
					"REVIEW_ALREADY_SUBMITTED"
				);
			}

			const now = new Date();
			const writeOptions = session ? { session } : {};
			// TTL cleanup is asynchronous. Mark already-expired links revoked so they
			// cannot block a fresh invitation while MongoDB waits to remove them.
			await HotelReviewInvitation.updateMany(
				{
					reservationId: reservation._id,
					usedAt: null,
					revokedAt: null,
					expiresAt: { $lte: now },
				},
				{ $set: { revokedAt: now } },
				writeOptions
			).exec();

			const activeInvitationQuery = HotelReviewInvitation.find({
				reservationId: reservation._id,
				usedAt: null,
				revokedAt: null,
				expiresAt: { $gt: now },
			})
				.select("_id")
				.lean();
			if (session) activeInvitationQuery.session(session);
			const activeInvitations = await activeInvitationQuery.exec();
			const activeInvitationExists = activeInvitations.length > 0;
			if (activeInvitationExists && !replaceExistingInvitation) {
				throw activeReviewInvitationExistsError();
			}
			if (replaceExistingInvitation && activeInvitationExists) {
				await HotelReviewInvitation.updateMany(
					{
						reservationId: reservation._id,
						usedAt: null,
						revokedAt: null,
						expiresAt: { $gt: now },
					},
					{ $set: { revokedAt: now } },
					writeOptions
				).exec();
			}

			let rawToken = "";
			let invitation = null;
			try {
				for (let attempt = 0; attempt < 3; attempt += 1) {
					rawToken = generateReviewToken();
					try {
						const invitationData = {
							tokenHash: hashReviewToken(rawToken),
							reservationId: reservation._id,
							hotelId: hotel._id,
							createdBy: actorId,
							language,
							expiresAt,
						};
						if (session) {
							[invitation] = await HotelReviewInvitation.create(
								[invitationData],
								{ session }
							);
						} else {
							invitation = await HotelReviewInvitation.create(invitationData);
						}
						break;
					} catch (error) {
						const tokenCollision =
							error?.code === 11000 &&
							(error?.keyPattern?.tokenHash ||
								/tokenHash/i.test(String(error?.message || "")));
						if (tokenCollision && attempt < 2) continue;
						if (tokenCollision) {
							throw new HotelReviewHttpError(
								503,
								"Could not generate a secure review link. Please try again.",
								"INVITATION_TOKEN_CONFLICT"
							);
						}
						if (error?.code === 11000) {
							throw replaceExistingInvitation
								? reviewInvitationWriteConflictError()
								: activeReviewInvitationExistsError();
						}
						throw error;
					}
				}
			} catch (error) {
				if (
					compensate &&
					replaceExistingInvitation &&
					activeInvitations.length > 0
				) {
					try {
						await HotelReviewInvitation.updateMany(
							{
								_id: { $in: activeInvitations.map(({ _id }) => _id) },
								usedAt: null,
								revokedAt: now,
							},
							{ $set: { revokedAt: null } }
						).exec();
					} catch (restoreError) {
						console.error(
							"[hotel-reviews] invitation replacement rollback failed:",
							restoreError
						);
					}
				}
				throw error;
			}
			return { rawToken, invitation };
		};

		const issued = await runReviewTransaction(
			(session) => issueInvitation(session),
			() =>
				withHotelReviewFallbackMutex(hotel._id, async () => {
					await rebuildHotelReviewSummary(hotel._id);
					return issueInvitation(null, { compensate: true });
				})
		);
		const { rawToken, invitation } = issued || {};
		if (!invitation || !rawToken) {
			throw new HotelReviewHttpError(500, "Could not create the review link.");
		}

		const reviewUrl = buildReviewInvitationUrl({
			hotelSlug: canonicalHotelSlug(hotel.hotelName),
			language,
			confirmationNumber: reservation.confirmation_number,
			reviewToken: rawToken,
		});
		return res.status(201).json({
			success: true,
			reviewUrl,
			expiresAt: invitation.expiresAt,
		});
	} catch (error) {
		return sendControllerError(res, error, "create invitation");
	}
};

const escapeAdminSearchRegex = (value = "") =>
	String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const buildAdminReviewFilters = async (query = {}) => {
	const status = String(query.status || "all").trim().toLowerCase();
	if (!["all", "active", "inactive"].includes(status)) {
		throw new HotelReviewHttpError(400, "Invalid review status.", "INVALID_FILTER");
	}
	const baseFilter = {};
	if (query.hotelId) {
		if (!mongoose.Types.ObjectId.isValid(query.hotelId)) {
			throw new HotelReviewHttpError(400, "Invalid hotel filter.", "INVALID_FILTER");
		}
		baseFilter.hotelId = mongoose.Types.ObjectId(query.hotelId);
	}
	if (query.rating !== undefined && query.rating !== "") {
		const rating = Number(query.rating);
		if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
			throw new HotelReviewHttpError(400, "Invalid rating filter.", "INVALID_FILTER");
		}
		baseFilter.rating = rating;
	}

	const search = normalizeTextField(query.search, {
		field: "Search",
		max: 120,
		multiline: false,
	});
	if (search) {
		const regex = new RegExp(escapeAdminSearchRegex(search), "i");
		const exactConfirmationHash = confirmationNumberLookupHash(search);
		const conditions = [
			{ firstName: regex },
			{ lastName: regex },
			{ displayName: regex },
			{ comment: regex },
			{ hotelNameSnapshot: regex },
			{ confirmationNumberMasked: regex },
			{ confirmationNumberLookupHash: exactConfirmationHash },
		];
		if (mongoose.Types.ObjectId.isValid(search)) {
			conditions.push({ _id: mongoose.Types.ObjectId(search) });
		}
		const reservation = await Reservations.findOne({
			confirmation_number: search.toLowerCase(),
		})
			.select("_id")
			.lean()
			.exec();
		if (reservation?._id) conditions.push({ reservationId: reservation._id });
		baseFilter.$or = conditions;
	}
	let listFilter = { ...baseFilter };
	if (status === "active") {
		listFilter = { $and: [baseFilter, publicReviewContentMongoFilter()] };
	} else if (status === "inactive") {
		listFilter = {
			$and: [baseFilter, { $nor: [publicReviewContentMongoFilter()] }],
		};
	}
	return { baseFilter, listFilter, status };
};

const serializeAdminReview = (
	review = {},
	{ includeReservationId = false } = {}
) => {
	const hotel = review.hotelId && typeof review.hotelId === "object" ? review.hotelId : null;
	const reservation =
		review.reservationId && typeof review.reservationId === "object"
			? review.reservationId
			: null;
	const confirmationNumber =
		String(reservation?.confirmation_number || "").trim() ||
		decryptReviewSensitiveValue(review.confirmationNumberEncrypted) ||
		String(review.confirmationNumberMasked || "");
	const visibility = resolveHotelReviewVisibility(review);
	return {
		_id: stringId(review._id),
		firstName: String(review.firstName || ""),
		lastName: String(review.lastName || ""),
		displayName: String(review.displayName || ""),
		confirmationNumber,
		roomLabel: String(review.roomLabel || ""),
		hotel: {
			_id: stringId(hotel?._id || review.hotelId),
			hotelName: String(hotel?.hotelName || review.hotelNameSnapshot || ""),
		},
		rating: Number(review.rating),
		comment: String(review.comment || ""),
		ratingVisible: visibility.ratingVisible,
		commentVisible: visibility.commentVisible,
		status: visibility.status,
		verifiedStay: review.verifiedStay === true,
		verificationMethod: String(review.verificationMethod || "none"),
		authenticatedReviewer: review.authenticatedReviewer === true,
		userId: stringId(review.userId) || null,
		reservationId: includeReservationId
			? stringId(reservation?._id || review.reservationId) || null
			: null,
		moderation: review.moderation || null,
		createdAt: review.createdAt || null,
		updatedAt: review.updatedAt || null,
	};
};

const adminSummaryPipeline = (baseFilter = {}) => [
	{ $match: baseFilter },
	{
		$group: {
			_id: null,
			total: { $sum: 1 },
			active: {
				$sum: {
					$cond: [publicReviewContentAggregationExpression(), 1, 0],
				},
			},
			inactive: {
				$sum: {
					$cond: [publicReviewContentAggregationExpression(), 0, 1],
				},
			},
			visibleRatingCount: {
				$sum: {
					$cond: [effectiveRatingVisibilityAggregationExpression(), 1, 0],
				},
			},
			visibleCommentCount: {
				$sum: {
					$cond: [
						effectiveCommentVisibilityAggregationExpression(),
						1,
						0,
					],
				},
			},
			activeRatingSum: {
				$sum: {
					$cond: [
						effectiveRatingVisibilityAggregationExpression(),
						"$rating",
						0,
					],
				},
			},
		},
	},
];

const serializeAdminSummary = (row = {}) => {
	const active = Number(row.active || 0);
	const visibleRatingCount = Number(row.visibleRatingCount || 0);
	const activeRatingSum = Number(row.activeRatingSum || 0);
	return {
		total: Number(row.total || 0),
		active,
		inactive: Number(row.inactive || 0),
		visibleRatingCount,
		visibleCommentCount: Number(row.visibleCommentCount || 0),
		averageRating: visibleRatingCount
			? Number((activeRatingSum / visibleRatingCount).toFixed(2))
			: 0,
	};
};

exports.listAdminHotelReviews = async (req, res) => {
	setNoStoreHeaders(res);
	try {
		const { page, limit } = parsePagination(req.query, {
			defaultLimit: ADMIN_REVIEW_LIMIT_DEFAULT,
			maxLimit: ADMIN_REVIEW_LIMIT_MAX,
		});
		const skip = (page - 1) * limit;
		const { baseFilter, listFilter } = await buildAdminReviewFilters(req.query);
		const [reviews, total, summaryRows, hotelIdRows] = await Promise.all([
			HotelReview.find(listFilter)
				.select(ADMIN_REVIEW_SELECT)
				.populate({ path: "hotelId", select: "hotelName" })
				.populate({ path: "reservationId", select: "confirmation_number" })
				.sort({ _id: -1 })
				.skip(skip)
				.limit(limit)
				.lean()
				.exec(),
			HotelReview.countDocuments(listFilter).exec(),
			HotelReview.aggregate(adminSummaryPipeline(baseFilter)).exec(),
			HotelReview.aggregate([
				{ $group: { _id: "$hotelId" } },
				{ $sort: { _id: 1 } },
				{ $limit: 500 },
			]).exec(),
		]);
		const hotelIds = hotelIdRows.map((row) => row._id).filter(Boolean);
		const hotels = hotelIds.length
			? await HotelDetails.find({ _id: { $in: hotelIds } })
					.select("_id hotelName")
					.sort({ hotelName: 1 })
					.lean()
					.exec()
			: [];
		const totalPages = total ? Math.ceil(total / limit) : 0;
		return res.status(200).json({
			reviews: reviews.map((review) =>
				serializeAdminReview(review, {
					includeReservationId:
						canViewHotelReviewReservationDetailsForHotel(
							req.profile,
							review.hotelId
						),
				})
			),
			pagination: {
				page,
				limit,
				total,
				totalItems: total,
				totalPages,
				hasNextPage: page < totalPages,
				hasPreviousPage: page > 1 && totalPages > 0,
			},
			summary: serializeAdminSummary(summaryRows[0] || {}),
			hotels: hotels.map((hotel) => ({
				_id: stringId(hotel._id),
				hotelName: String(hotel.hotelName || ""),
			})),
		});
	} catch (error) {
		return sendControllerError(res, error, "list admin reviews");
	}
};

const requestedModerationStatus = (body = {}) => {
	let value = body?.status;
	if (value === undefined && typeof body?.active === "boolean") {
		value = body.active ? "active" : "inactive";
	}
	const status = String(value || "").trim().toLowerCase();
	if (!["active", "inactive"].includes(status)) {
		throw new HotelReviewHttpError(
			400,
			"Status must be active or inactive.",
			"INVALID_STATUS"
		);
	}
	return status;
};

const requestedReviewVisibilityPatch = (body = {}) => {
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		throw new HotelReviewHttpError(
			400,
			"Invalid review visibility request.",
			"INVALID_VISIBILITY",
		);
	}
	const hasRatingVisible = Object.prototype.hasOwnProperty.call(
		body,
		"ratingVisible",
	);
	const hasCommentVisible = Object.prototype.hasOwnProperty.call(
		body,
		"commentVisible",
	);
	const hasLegacyStatus =
		Object.prototype.hasOwnProperty.call(body, "status") ||
		Object.prototype.hasOwnProperty.call(body, "active");
	if ((hasRatingVisible || hasCommentVisible) && hasLegacyStatus) {
		throw new HotelReviewHttpError(
			400,
			"Send visibility fields or legacy status, not both.",
			"INVALID_VISIBILITY",
		);
	}
	if (hasRatingVisible || hasCommentVisible) {
		if (hasRatingVisible && typeof body.ratingVisible !== "boolean") {
			throw new HotelReviewHttpError(
				400,
				"Rating visibility must be true or false.",
				"INVALID_VISIBILITY",
			);
		}
		if (hasCommentVisible && typeof body.commentVisible !== "boolean") {
			throw new HotelReviewHttpError(
				400,
				"Comment visibility must be true or false.",
				"INVALID_VISIBILITY",
			);
		}
		return {
			mode: "visibility",
			hasRatingVisible,
			hasCommentVisible,
			...(hasRatingVisible ? { ratingVisible: body.ratingVisible } : {}),
			...(hasCommentVisible ? { commentVisible: body.commentVisible } : {}),
		};
	}

	const status = requestedModerationStatus(body);
	const visible = status === "active";
	return {
		mode: "legacy-status",
		hasRatingVisible: true,
		hasCommentVisible: true,
		ratingVisible: visible,
		commentVisible: visible,
	};
};

const buildReviewVisibilityTransition = (review = {}, patch = {}) => {
	const current = resolveHotelReviewVisibility(review);
	const requestedRatingVisible = patch.hasRatingVisible
		? patch.ratingVisible
		: current.ratingVisible;
	const requestedCommentVisible = patch.hasCommentVisible
		? patch.commentVisible
		: current.commentConfiguredVisible;
	const next = {
		ratingVisible: requestedRatingVisible === true,
		// A blank comment can never be public, even when a caller asks to show it.
		commentVisible: requestedCommentVisible === true && current.hasComment,
	};
	next.status = legacyRollbackSafeReviewStatus({
		...next,
		hasComment: current.hasComment,
	});
	const normalizesBlankComment =
		!current.hasComment && review.commentVisible !== false;
	return {
		current,
		next,
		changed:
			current.ratingVisible !== next.ratingVisible ||
			current.commentVisible !== next.commentVisible ||
			String(review.status || "") !== next.status ||
			normalizesBlankComment,
		ratingVisibilityChanged:
			current.ratingVisible !== next.ratingVisible,
		normalizesBlankComment,
	};
};

const visibilityTransitionMatchesReview = (transition, review = {}) => {
	if (!transition?.next) return false;
	const current = resolveHotelReviewVisibility(review);
	return (
		current.ratingVisible === transition.next.ratingVisible &&
		current.commentVisible === transition.next.commentVisible &&
		String(review.status || "") === transition.next.status &&
		(!transition.normalizesBlankComment || review.commentVisible === false)
	);
};

const buildReviewModerationAudit = ({
	sourceReview = {},
	transition = {},
	reason = "",
	actorId = null,
	changedAt = new Date(),
} = {}) => ({
	moderation: {
		reason,
		changedBy: actorId,
		changedAt,
		ratingVisible: transition.next?.ratingVisible,
		commentVisible: transition.next?.commentVisible,
	},
	history: {
		fromStatus: sourceReview.status,
		toStatus: transition.next?.status,
		fromRatingVisible: transition.current?.ratingVisible,
		toRatingVisible: transition.next?.ratingVisible,
		fromCommentVisible: transition.current?.commentVisible,
		toCommentVisible: transition.next?.commentVisible,
		reason,
		changedBy: actorId,
		changedAt,
	},
});

const touchHotelReviewSummary = async (hotelId, session = null) => {
	const summary = await HotelReviewSummary.findOneAndUpdate(
		{ hotelId },
		{ $set: { updatedAt: new Date() } },
		{
			new: true,
			lean: true,
			runValidators: true,
			...(session ? { session } : {}),
		},
	).exec();
	if (!summary) {
		throw new HotelReviewHttpError(
			503,
			"The rating could not be updated safely. Please try again.",
			"SUMMARY_CONFLICT",
		);
	}
	return summary;
};

const findAdminReviewById = (reviewId) =>
	HotelReview.findById(reviewId)
		.select(ADMIN_REVIEW_SELECT)
		.populate({ path: "hotelId", select: "hotelName" })
		.populate({ path: "reservationId", select: "confirmation_number" })
		.lean()
		.exec();

exports.updateHotelReviewStatus = async (req, res) => {
	setNoStoreHeaders(res);
	try {
		const { reviewId } = req.params;
		const actorId = stringId(req.auth?._id || req.auth?.id);
		if (
			!mongoose.Types.ObjectId.isValid(reviewId) ||
			!mongoose.Types.ObjectId.isValid(actorId)
		) {
			throw new HotelReviewHttpError(400, "Invalid review.", "INVALID_REVIEW");
		}
		const visibilityPatch = requestedReviewVisibilityPatch(req.body);
		const reason = normalizeTextField(req.body?.reason, {
			field: "Moderation reason",
			max: 500,
			multiline: true,
		});

		const performModeration = async (session = null, compensate = false) => {
			let sourceReview = null;
			let transition = null;
			try {
				const reviewQuery = HotelReview.findById(reviewId)
					.select(
						"_id hotelId rating comment status ratingVisible commentVisible",
					)
					.lean();
				if (session) reviewQuery.session(session);
				sourceReview = await reviewQuery.exec();
				if (!sourceReview) {
					throw new HotelReviewHttpError(
						404,
						"Review not found.",
						"REVIEW_NOT_FOUND"
					);
				}
				await ensureHotelReviewSummary(sourceReview.hotelId, session);
				transition = buildReviewVisibilityTransition(
					sourceReview,
					visibilityPatch,
				);
				if (!transition.changed) {
					return {
						summary: await getHotelReviewSummary(sourceReview.hotelId, session),
						visibilityChanged: false,
					};
				}

				const changedAt = new Date();
				const audit = buildReviewModerationAudit({
					sourceReview,
					transition,
					reason,
					actorId,
					changedAt,
				});
				const updated = await HotelReview.findOneAndUpdate(
					buildHotelReviewVisibilityCasFilter(sourceReview),
					{
						$set: {
							status: transition.next.status,
							ratingVisible: transition.next.ratingVisible,
							commentVisible: transition.next.commentVisible,
							moderation: audit.moderation,
						},
						$push: {
							moderationHistory: {
								$each: [
									audit.history,
								],
								$slice: -50,
							},
						},
					},
					{
						new: true,
						runValidators: true,
						...(session ? { session } : {}),
					}
				).exec();
				if (!updated) {
					throw new HotelReviewHttpError(
						409,
						"The review visibility changed while it was being updated. Please try again.",
						"REVIEW_VISIBILITY_CONFLICT"
					);
				}
				let summary;
				if (compensate) {
					summary = await rebuildHotelReviewSummary(sourceReview.hotelId);
				} else if (transition.ratingVisibilityChanged) {
					summary = await applySummaryDelta({
						hotelId: sourceReview.hotelId,
						rating: sourceReview.rating,
						direction: transition.next.ratingVisible ? 1 : -1,
						session,
					});
				} else {
					// Comment-only moderation still advances the summary timestamp so a
					// subsequent freshness check does not perform a needless rebuild.
					summary = await touchHotelReviewSummary(
						sourceReview.hotelId,
						session,
					);
				}
				return { summary, visibilityChanged: true };
			} catch (error) {
				if (compensate && sourceReview?._id && transition) {
					// On a standalone topology, the stored visibility is the source of
					// truth. If its write landed but the summary update failed or was uncertain,
					// rebuild the materialized summary and treat the idempotent outcome as
					// successful only after that reconciliation completes.
					const current = await HotelReview.findById(sourceReview._id)
						.select(
							"_id hotelId comment status ratingVisible commentVisible",
						)
						.lean()
						.exec();
					if (visibilityTransitionMatchesReview(transition, current)) {
						try {
							const summary = await rebuildHotelReviewSummary(current.hotelId);
							return {
								summary,
								reconciled: true,
								visibilityChanged: true,
							};
						} catch (reconciliationError) {
							console.error(
								"[hotel-reviews] standalone moderation reconciliation failed:",
								reconciliationError
							);
							try {
								await invalidateHotelReviewSummary(current.hotelId);
							} catch (invalidationError) {
								console.error(
									"[hotel-reviews] stale summary invalidation failed:",
									invalidationError
								);
							}
						}
					}
				}
				throw error;
			}
		};

		const transactionResult = await runReviewTransaction(
			(session) => performModeration(session, false),
			async () => {
				const fallbackReview = await HotelReview.findById(reviewId)
					.select("_id hotelId")
					.lean()
					.exec();
				if (!fallbackReview?.hotelId) {
					return performModeration(null, true);
				}
				return withHotelReviewFallbackMutex(fallbackReview.hotelId, async () => {
					await rebuildHotelReviewSummary(fallbackReview.hotelId);
					return performModeration(null, true);
				});
			}
		);
		if (transactionResult.visibilityChanged) {
			invalidatePublicHotelGuestReviewSummaryCache();
		}

		const review = await findAdminReviewById(reviewId);
		if (!review) {
			throw new HotelReviewHttpError(404, "Review not found.", "REVIEW_NOT_FOUND");
		}
		return res.status(200).json({
			success: true,
			review: serializeAdminReview(review, {
				includeReservationId:
					canViewHotelReviewReservationDetailsForHotel(
						req.profile,
						review.hotelId
					),
			}),
			summary: serializeSummary(transactionResult.summary),
		});
	} catch (error) {
		// A failed moderation may still have an ambiguous commit outcome after a
		// standalone write or driver-level commit failure. This endpoint is admin
		// only, so clearing just the review-bearing caches is a safe fail-closed step.
		invalidatePublicHotelGuestReviewSummaryCache();
		return sendControllerError(res, error, "moderate review");
	}
};

Object.defineProperty(module.exports, "__test", {
	value: {
		HotelReviewHttpError,
		adminSummaryPipeline,
		buildHotelSlugRegex,
		buildHotelReviewSummaryPipeline,
		buildAdminReviewFilters,
		buildPublicReviewListFilter,
		buildReviewModerationAudit,
		buildReviewVisibilityTransition,
		buildSummaryCompareAndSwapFilter,
		buildPublicDisplayName,
		buildReviewReservationContext,
		buildReviewInvitationUrl,
		buildRequireHotelReviewReservationScope,
		buildRoomLabel,
		activeReviewInvitationExistsError,
		canCreateReviewInvitationForHotel,
		canViewHotelReviewReservationDetails,
		canViewHotelReviewReservationDetailsForHotel,
		canonicalHotelSlug,
		confirmationNumberLookupHash,
		containsHtmlMarkup,
		decryptReviewSensitiveValue,
		emptyBreakdown,
		encryptReviewSensitiveValue,
		hashReviewToken,
		isUnsupportedTransactionError,
		isExplicitInvitationReplacement,
		maskConfirmationNumber,
		normalizeConfirmationNumber,
		parsePagination,
		parseStrictRating,
		requestedModerationStatus,
		requestedReviewVisibilityPatch,
		reviewInvitationWriteConflictError,
		resetTransactionSupportCache: () => {
			reviewTransactionsUnsupported = false;
		},
		runReviewTransaction,
		serializeAdminReview,
		serializeAdminSummary,
		serializePublicReview,
		serializeSummary,
		splitFullName,
		summaryDeltaUpdate,
		summaryHasValidInvariants,
		summaryIsFreshForSource,
		validateReviewPayload,
		visibilityTransitionMatchesReview,
		withHotelReviewFallbackMutex,
	},
	enumerable: false,
});
