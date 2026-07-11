/** @format */

const mongoose = require("mongoose");

const cleanText = (value) => String(value || "").trim();

const configuredHotelIds = () =>
	new Set(
		cleanText(process.env.HOTEL_OPENAI_KNOWLEDGE_HOTEL_IDS)
			.split(",")
			.map(cleanText)
			.filter((value) => mongoose.isValidObjectId(value))
	);

const debounceMs = () => {
	const parsed = Number.parseInt(
		String(process.env.HOTEL_OPENAI_KNOWLEDGE_DEBOUNCE_MS || ""),
		10
	);
	return Number.isFinite(parsed) ? Math.min(60_000, Math.max(1000, parsed)) : 8000;
};

const resourceSnapshot = (knowledge = {}) => ({
	vectorStoreId: cleanText(knowledge.vectorStoreId),
	fileId: cleanText(knowledge.files?.[0]?.fileId),
});

const requestHotelOpenAiKnowledgeSync = async ({
	hotelId,
	reason = "hotel_details_post_commit",
	paths = [],
} = {}) => {
	const id = cleanText(hotelId);
	if (!mongoose.isValidObjectId(id)) return { status: "ignored_invalid_id" };
	// Lazy imports keep HotelDetails model initialization free of circular requires.
	const HotelDetails = require("../models/hotel_details");
	const {
		enqueueHotelKnowledgeSync,
	} = require("./hotelOpenAiKnowledgeSyncWorker");
	const hotel = await HotelDetails.findById(id)
		.select("_id updatedAt +openaiKnowledge")
		.lean();
	if (!hotel) return { status: "ignored_missing" };
	if (
		hotel.openaiKnowledge?.autoSyncEnabled !== true &&
		!configuredHotelIds().has(id)
	) {
		return { status: "ignored_unmanaged" };
	}
	const job = await enqueueHotelKnowledgeSync({
		hotelId: id,
		reason,
		paths,
		hotelUpdatedAt: hotel.updatedAt || null,
		resources: resourceSnapshot(hotel.openaiKnowledge),
		debounceMs: debounceMs(),
		resetFailures: true,
	});
	return { status: job ? "queued" : "ignored", hotelId: id };
};

const requestManagedHotelOpenAiKnowledgeReconciliation = async ({
	reason = "hotel_details_broad_post_commit",
	paths = [],
} = {}) => {
	const HotelDetails = require("../models/hotel_details");
	const hotels = await HotelDetails.find({
		$or: [
			{ "openaiKnowledge.autoSyncEnabled": true },
			...(configuredHotelIds().size
				? [{ _id: { $in: [...configuredHotelIds()] } }]
				: []),
		],
	})
		.select("_id")
		.lean();
	await Promise.all(
		hotels.map((hotel) =>
			requestHotelOpenAiKnowledgeSync({ hotelId: hotel._id, reason, paths })
		)
	);
	return { status: "queued", count: hotels.length };
};

const requestHotelOpenAiKnowledgeSyncSafely = (payload, logger = console) => {
	setImmediate(() => {
		requestHotelOpenAiKnowledgeSync(payload).catch((error) =>
			logger.error(
				"[hotel-openai-sync] post-commit enqueue failed safely:",
				error?.message || error
			)
		);
	});
};

const requestManagedHotelOpenAiKnowledgeReconciliationSafely = (
	payload,
	logger = console
) => {
	setImmediate(() => {
		requestManagedHotelOpenAiKnowledgeReconciliation(payload).catch((error) =>
			logger.error(
				"[hotel-openai-sync] broad post-commit enqueue failed safely:",
				error?.message || error
			)
		);
	});
};

module.exports = {
	requestHotelOpenAiKnowledgeSync,
	requestHotelOpenAiKnowledgeSyncSafely,
	requestManagedHotelOpenAiKnowledgeReconciliation,
	requestManagedHotelOpenAiKnowledgeReconciliationSafely,
};
