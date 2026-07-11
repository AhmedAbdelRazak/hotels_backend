/** @format */

const fs = require("fs/promises");
const path = require("path");
const mongoose = require("mongoose");
const OpenAI = require("openai");
const { toFile } = OpenAI;

const HotelDetails = require("../models/hotel_details");
const {
	SCHEMA_VERSION,
	DEFAULT_TIMEZONE,
	assertSafeKnowledgeDocument,
	buildHotelKnowledgeDocument,
	dateKeyInTimeZone,
	sha256,
	stableSourcePayload,
} = require("./hotelOpenAiKnowledge");

const HOTEL_KNOWLEDGE_SELECT = [
	"+openaiKnowledge",
	"hotelName",
	"hotelName_OtherLanguage",
	"hotelCountry",
	"hotelState",
	"hotelCity",
	"aboutHotel",
	"aboutHotelArabic",
	"hotelAddress",
	"hotelFloors",
	"hotelPhotos",
	"distances",
	"hotelRating",
	"parkingLot",
	"hasBusService",
	"busDetails",
	"hasMealsService",
	"mealsDetails",
	"isNusuk",
	"isNusukText",
	"propertyType",
	"currency",
	"location",
	"activateHotel",
	"xHotelProActive",
	"updatedAt",
	"hotelPolicyQA",
	"roomCountDetails",
].join(" ");

const DEFAULT_INDEX_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_API_REQUEST_TIMEOUT_MS = 60 * 1000;

const safeSlug = (value) =>
	String(value || "hotel")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "") || "hotel";

const cleanText = (value) => String(value || "").trim();

const sameDateValue = (left, right) => {
	const leftTime = left ? new Date(left).getTime() : 0;
	const rightTime = right ? new Date(right).getTime() : 0;
	return leftTime === rightTime;
};

const hasOwn = (value, key) =>
	Boolean(value && Object.prototype.hasOwnProperty.call(value, key));

const isKnowledgeManaged = (knowledge = null, explicitlyManaged = false) => {
	if (explicitlyManaged) return true;
	return knowledge?.autoSyncEnabled === true;
};

const shouldEnableAutoSync = (existing = null, requestedValue) => {
	if (typeof requestedValue === "boolean") return requestedValue;
	if (hasOwn(existing, "autoSyncEnabled")) return existing.autoSyncEnabled !== false;
	return true;
};

const isPublicHotelEligible = (hotel = {}) => {
	if (hotel.activateHotel !== true || hotel.xHotelProActive === false) return false;
	if (!Array.isArray(hotel.hotelPhotos) || hotel.hotelPhotos.length === 0) return false;
	const coordinates = Array.isArray(hotel?.location?.coordinates)
		? hotel.location.coordinates.map(Number)
		: [];
	if (
		coordinates.length !== 2 ||
		!coordinates.every(Number.isFinite) ||
		(coordinates[0] === 0 && coordinates[1] === 0)
	) {
		return false;
	}
	return (Array.isArray(hotel.roomCountDetails) ? hotel.roomCountDetails : []).some(
		(room) =>
			room?.activeRoom === true &&
			Number(room?.price?.basePrice) > 0 &&
			Array.isArray(room.photos) &&
			room.photos.length > 0
	);
};

const knowledgeResources = (knowledge = null) => ({
	vectorStoreId: cleanText(knowledge?.vectorStoreId),
	fileId: cleanText(knowledge?.files?.[0]?.fileId),
});

const isNotFoundError = (error) =>
	Number(error?.status || error?.statusCode) === 404 ||
	String(error?.code || "").toLowerCase() === "not_found";

const deleteOpenAiResources = async (client, { vectorStoreId, fileId } = {}) => {
	const failures = [];
	if (vectorStoreId) {
		try {
			await client.vectorStores.delete(vectorStoreId);
		} catch (error) {
			if (!isNotFoundError(error)) {
				failures.push(`vector store cleanup failed: ${error.message}`);
			}
		}
	}
	if (fileId) {
		try {
			await client.files.delete(fileId);
		} catch (error) {
			if (!isNotFoundError(error)) {
				failures.push(`file cleanup failed: ${error.message}`);
			}
		}
	}
	return failures;
};

const writeAuditDocument = async ({ auditRoot, hotelId, filename, content }) => {
	const directory = path.resolve(auditRoot, String(hotelId));
	await fs.mkdir(directory, { recursive: true });
	const outputPath = path.join(directory, filename);
	await fs.writeFile(outputPath, content, "utf8");
	return outputPath;
};

const buildVerificationQuery = (document = {}) => {
	const hotelName = cleanText(document?.hotel?.name?.en) || cleanText(document.hotelId);
	const roomNames = (Array.isArray(document.rooms) ? document.rooms : [])
		.slice(0, 3)
		.map((room) => cleanText(room?.displayName?.en))
		.filter(Boolean)
		.join(", ");
	return [
		`Hotel facts for ${hotelName}.`,
		roomNames ? `Room types include ${roomNames}.` : "Room types and guest capacities.",
		"Return room capacities, estimated nightly pricing, availability rules, and blocked dates.",
	].join(" ");
};

const expectedKnowledgeFilter = (hotel, existing = null) => {
	const filter = { _id: hotel._id, updatedAt: hotel.updatedAt };
	const vectorStoreId = cleanText(existing?.vectorStoreId);
	if (vectorStoreId) {
		filter["openaiKnowledge.vectorStoreId"] = vectorStoreId;
	} else {
		filter.$or = [
			{ "openaiKnowledge.vectorStoreId": { $exists: false } },
			{ "openaiKnowledge.vectorStoreId": "" },
		];
	}
	if (Number.isFinite(Number(existing?.knowledgeVersion))) {
		filter["openaiKnowledge.knowledgeVersion"] = Number(existing.knowledgeVersion);
	}
	return filter;
};

const retireHotelKnowledge = async ({
	hotel,
	status,
	now,
	autoSyncEnabled,
	HotelModel = HotelDetails,
}) => {
	const existing = hotel.openaiKnowledge || null;
	if (!existing || !isKnowledgeManaged(existing)) {
		return { status: "not_managed", hotelId: String(hotel._id) };
	}
	const previousResources = knowledgeResources(existing);
	if (existing.status === status) {
		return {
			status,
			hotelId: String(hotel._id),
			unchanged: true,
			previousResources,
		};
	}
	const updated = await HotelModel.findOneAndUpdate(
		expectedKnowledgeFilter(hotel, existing),
		{
			$set: {
				"openaiKnowledge.autoSyncEnabled": autoSyncEnabled,
				"openaiKnowledge.status": status,
				"openaiKnowledge.sourceUpdatedAt": hotel.updatedAt || null,
				"openaiKnowledge.syncedAt": now,
				"openaiKnowledge.lastError": "",
			},
		},
		{ new: true, runValidators: true, timestamps: false }
	)
		.select("_id +openaiKnowledge")
		.lean();
	if (!updated) {
		throw new Error(
			"Hotel changed while its knowledge was being retired; refusing a stale update"
		);
	}
	return {
		status,
		hotelId: String(hotel._id),
		previousResources,
	};
};

const syncHotelOpenAiVector = async ({
	hotelId,
	coverageFrom = "",
	coverageThrough = "",
	timezone = DEFAULT_TIMEZONE,
	force = false,
	dryRun = false,
	requireManaged = false,
	explicitlyManaged = false,
	autoSyncEnabled,
	outputAudit = false,
	auditRoot = path.resolve(__dirname, "../audits/ai-knowledge"),
	client = null,
	HotelModel = HotelDetails,
	now = new Date(),
	logger = console,
	onPublished = null,
	indexTimeoutMs = Number(process.env.HOTEL_OPENAI_KNOWLEDGE_INDEX_TIMEOUT_MS) ||
		DEFAULT_INDEX_TIMEOUT_MS,
} = {}) => {
	const cleanHotelId = cleanText(hotelId);
	if (!mongoose.isValidObjectId(cleanHotelId)) {
		throw new Error("hotelId must be a valid ObjectId");
	}
	const hotel = await HotelModel.findById(cleanHotelId)
		.select(HOTEL_KNOWLEDGE_SELECT)
		.lean();
	if (!hotel) {
		return { status: "missing", hotelId: cleanHotelId };
	}
	const existing = hotel.openaiKnowledge || null;
	if (requireManaged && !isKnowledgeManaged(existing, explicitlyManaged)) {
		return { status: "not_managed", hotelId: cleanHotelId };
	}
	const resolvedAutoSyncEnabled = shouldEnableAutoSync(existing, autoSyncEnabled);
	if (!isPublicHotelEligible(hotel)) {
		if (dryRun) {
			return {
				status: "dry_run",
				action: "retire",
				hotelId: cleanHotelId,
				previousResources: knowledgeResources(existing),
			};
		}
		return retireHotelKnowledge({
			hotel,
			status: "retired",
			now,
			autoSyncEnabled: resolvedAutoSyncEnabled,
			HotelModel,
		});
	}

	const resolvedCoverageFrom = cleanText(coverageFrom) || dateKeyInTimeZone(now, timezone);
	const resolvedCoverageThrough =
		cleanText(coverageThrough) || cleanText(existing?.coverageThrough);
	if (!/^20\d{2}-\d{2}-\d{2}$/.test(resolvedCoverageThrough)) {
		throw new Error(
			"A YYYY-MM-DD coverageThrough is required for a managed hotel knowledge vector"
		);
	}
	if (resolvedCoverageFrom > resolvedCoverageThrough) {
		if (dryRun) {
			return {
				status: "dry_run",
				action: "expire",
				hotelId: cleanHotelId,
				previousResources: knowledgeResources(existing),
			};
		}
		return retireHotelKnowledge({
			hotel,
			status: "expired",
			now,
			autoSyncEnabled: resolvedAutoSyncEnabled,
			HotelModel,
		});
	}

	const knowledgeVersion = Math.max(1, Number(existing?.knowledgeVersion || 0) + 1);
	const generatedAt = new Date(now);
	const document = buildHotelKnowledgeDocument({
		hotel,
		coverageFrom: resolvedCoverageFrom,
		coverageThrough: resolvedCoverageThrough,
		generatedAt,
		knowledgeVersion,
		timezone,
	});
	assertSafeKnowledgeDocument(document);
	const sourceSha256 = sha256(JSON.stringify(stableSourcePayload(document)));
	if (
		!force &&
		existing?.status === "ready" &&
		cleanText(existing?.vectorStoreId) &&
		existing?.sourceSha256 === sourceSha256
	) {
		const metadataNeedsRefresh =
			existing.autoSyncEnabled !== resolvedAutoSyncEnabled ||
			!sameDateValue(existing.sourceUpdatedAt, hotel.updatedAt) ||
			Boolean(cleanText(existing.lastError));
		if (!dryRun && metadataNeedsRefresh) {
			await HotelModel.findOneAndUpdate(
				expectedKnowledgeFilter(hotel, existing),
				{
					$set: {
						"openaiKnowledge.autoSyncEnabled": resolvedAutoSyncEnabled,
						"openaiKnowledge.sourceUpdatedAt": hotel.updatedAt || null,
						"openaiKnowledge.syncedAt": now,
						"openaiKnowledge.lastError": "",
					},
				},
				{ timestamps: false }
			).lean();
		}
		return {
			status: "unchanged",
			hotelId: cleanHotelId,
			vectorStoreId: existing.vectorStoreId,
			fileId: cleanText(existing?.files?.[0]?.fileId),
			vectorStoreFileId: cleanText(existing?.files?.[0]?.vectorStoreFileId),
			knowledgeVersion: existing.knowledgeVersion,
			sourceSha256,
			metadataRefreshed: !dryRun && metadataNeedsRefresh,
		};
	}

	const filename = `${safeSlug(hotel.hotelName)}-${cleanHotelId}-knowledge-v${knowledgeVersion}.json`;
	const content = `${JSON.stringify(document, null, 2)}\n`;
	const documentSha256 = sha256(content);
	let outputPath = "";
	if (outputAudit) {
		outputPath = await writeAuditDocument({
			auditRoot,
			hotelId: cleanHotelId,
			filename,
			content,
		});
	}
	if (dryRun) {
		return {
			status: "dry_run",
			hotelId: cleanHotelId,
			knowledgeVersion,
			coverageFrom: resolvedCoverageFrom,
			coverageThrough: resolvedCoverageThrough,
			roomCount: document.rooms.length,
			outputPath,
			sourceSha256,
			documentSha256,
			bytes: Buffer.byteLength(content),
		};
	}

	const openAiClient =
		client ||
		new OpenAI({
			apiKey: process.env.OPENAI_API_KEY,
			timeout:
				Number(process.env.HOTEL_OPENAI_KNOWLEDGE_API_TIMEOUT_MS) ||
				DEFAULT_API_REQUEST_TIMEOUT_MS,
			maxRetries: 2,
		});
	let vectorStore = null;
	let uploadedFile = null;
	let published = false;
	let publishAttempted = false;
	let publishOutcomeKnown = false;
	try {
		const vectorStoreName = `Jannat Booking - ${hotel.hotelName} - ${cleanHotelId} - v${knowledgeVersion}`;
		vectorStore = await openAiClient.vectorStores.create({
			name: vectorStoreName,
			metadata: {
				hotel_id: cleanHotelId,
				document_type: "hotel_knowledge",
				knowledge_version: String(knowledgeVersion),
			},
		});
		uploadedFile = await openAiClient.files.create({
			file: await toFile(Buffer.from(content, "utf8"), filename, {
				type: "application/json",
			}),
			purpose: "assistants",
		});
		const indexAbortController = new AbortController();
		const indexTimer = setTimeout(
			() => indexAbortController.abort(),
			Math.max(30_000, Number(indexTimeoutMs) || DEFAULT_INDEX_TIMEOUT_MS)
		);
		if (typeof indexTimer.unref === "function") indexTimer.unref();
		let vectorStoreFile;
		try {
			vectorStoreFile = await openAiClient.vectorStores.files.createAndPoll(
				vectorStore.id,
				{
					file_id: uploadedFile.id,
					attributes: {
						hotel_id: cleanHotelId,
						document_type: "hotel_knowledge",
						knowledge_version: knowledgeVersion,
						coverage_from: resolvedCoverageFrom,
						coverage_through: resolvedCoverageThrough,
						source_sha256: sourceSha256,
					},
					chunking_strategy: {
						type: "static",
						static: {
							max_chunk_size_tokens: 4096,
							chunk_overlap_tokens: 256,
						},
					},
				},
				{ pollIntervalMs: 1000, signal: indexAbortController.signal }
			);
		} catch (error) {
			if (indexAbortController.signal.aborted) {
				throw new Error("OpenAI vector indexing exceeded the configured time limit");
			}
			throw error;
		} finally {
			clearTimeout(indexTimer);
		}
		if (vectorStoreFile.status !== "completed") {
			throw new Error(
				`OpenAI indexing did not complete: ${vectorStoreFile.status} ${
					vectorStoreFile.last_error?.message || ""
				}`.trim()
			);
		}

		const searchResults = await openAiClient.vectorStores.search(vectorStore.id, {
			query: buildVerificationQuery(document),
			max_num_results: 5,
			rewrite_query: true,
		});
		if (!Array.isArray(searchResults.data) || searchResults.data.length === 0) {
			throw new Error("OpenAI vector search verification returned no results");
		}

		const indexedAt = new Date();
		const metadata = {
			provider: "openai",
			autoSyncEnabled: resolvedAutoSyncEnabled,
			vectorStoreId: vectorStore.id,
			vectorStoreName,
			files: [
				{
					documentKey: "hotel_knowledge",
					fileId: uploadedFile.id,
					vectorStoreFileId: vectorStoreFile.id,
					filename,
					sha256: documentSha256,
					status: vectorStoreFile.status,
				},
			],
			sourceSha256,
			documentSha256,
			schemaVersion: SCHEMA_VERSION,
			knowledgeVersion,
			status: "ready",
			coverageFrom: resolvedCoverageFrom,
			coverageThrough: resolvedCoverageThrough,
			sourceUpdatedAt: hotel.updatedAt || null,
			generatedAt,
			indexedAt,
			syncedAt: indexedAt,
			lastError: "",
		};
		publishAttempted = true;
		const updatedHotel = await HotelModel.findOneAndUpdate(
			expectedKnowledgeFilter(hotel, existing),
			{ $set: { openaiKnowledge: metadata } },
			{ new: true, runValidators: true, timestamps: false }
		)
			.select("_id hotelName +openaiKnowledge")
			.lean();
		publishOutcomeKnown = true;
		if (!updatedHotel) {
			throw new Error(
				"Hotel or active knowledge version changed while indexing; refusing to publish a stale vector"
			);
		}
		published = true;

		let postPublishError = "";
		if (typeof onPublished === "function") {
			try {
				await onPublished({ hotel: updatedHotel, metadata });
			} catch (error) {
				postPublishError = cleanText(error?.message || error);
				logger.error(
					"[hotel-openai-sync] post-publish hook failed:",
					postPublishError
				);
			}
		}

		return {
			status: "ready",
			hotelId: cleanHotelId,
			hotelName: updatedHotel.hotelName,
			vectorStoreId: vectorStore.id,
			fileId: uploadedFile.id,
			vectorStoreFileId: vectorStoreFile.id,
			knowledgeVersion,
			coverageFrom: resolvedCoverageFrom,
			coverageThrough: resolvedCoverageThrough,
			outputPath,
			sourceSha256,
			documentSha256,
			bytes: Buffer.byteLength(content),
			indexedStatus: vectorStoreFile.status,
			verificationResultCount: searchResults.data.length,
			previousResources: knowledgeResources(existing),
			postPublishError,
		};
	} catch (error) {
		if (!published && publishAttempted && !publishOutcomeKnown && vectorStore?.id) {
			try {
				const activatedHotel = await HotelModel.findById(cleanHotelId)
					.select("_id +openaiKnowledge")
					.lean();
				publishOutcomeKnown = true;
				published = activatedHotel?.openaiKnowledge?.vectorStoreId === vectorStore.id;
			} catch (_confirmationError) {
				// A delayed cleanup job will re-check the active pointer before deletion.
			}
		}
		if (!published) {
			if (publishAttempted && !publishOutcomeKnown) {
				error.candidateResources = {
					vectorStoreId: vectorStore?.id,
					fileId: uploadedFile?.id,
				};
			} else {
				const cleanupFailures = await deleteOpenAiResources(openAiClient, {
					vectorStoreId: vectorStore?.id,
					fileId: uploadedFile?.id,
				});
				if (cleanupFailures.length) {
					error.candidateResources = {
						vectorStoreId: vectorStore?.id,
						fileId: uploadedFile?.id,
					};
					error.message = `${error.message}; ${cleanupFailures.join("; ")}`;
				}
			}
		}
		throw error;
	}
};

module.exports = {
	HOTEL_KNOWLEDGE_SELECT,
	DEFAULT_INDEX_TIMEOUT_MS,
	DEFAULT_API_REQUEST_TIMEOUT_MS,
	buildVerificationQuery,
	deleteOpenAiResources,
	isKnowledgeManaged,
	isPublicHotelEligible,
	knowledgeResources,
	syncHotelOpenAiVector,
};
