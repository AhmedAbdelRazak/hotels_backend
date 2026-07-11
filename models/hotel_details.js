/** @format */

const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema;
const {
	makeDefaultHotelPolicyQA,
} = require("../services/hotelPolicyQa");

const WalletSchema = new mongoose.Schema(
	{
		balance_sar: { type: Number, default: 0 }, // remainder after last reconciliation snapshot
		lastComputedAt: { type: Date },
		// Optional future-proof ledger:
		ledger: {
			type: [
				{
					at: { type: Date, default: Date.now },
					type: {
						type: String,
						enum: [
							"online_payout",
							"offline_commission",
							"reconcile_in",
							"reconcile_out",
							"adjustment",
						],
					},
					reservationId: {
						type: mongoose.Schema.Types.ObjectId,
						ref: "Reservations",
					},
					confirmation_number: String,
					amount_sar: Number,
					batchKey: String,
					note: String,
				},
			],
			default: [],
			select: false, // keep payloads slim unless explicitly selected
		},
	},
	{ _id: false }
);

const OpenAiKnowledgeFileSchema = new mongoose.Schema(
	{
		documentKey: { type: String, default: "" },
		fileId: { type: String, default: "" },
		vectorStoreFileId: { type: String, default: "" },
		filename: { type: String, default: "" },
		sha256: { type: String, default: "" },
		status: { type: String, default: "" },
	},
	{ _id: false }
);

const OpenAiKnowledgeSchema = new mongoose.Schema(
	{
		provider: { type: String, default: "openai" },
		autoSyncEnabled: { type: Boolean, default: false },
		vectorStoreId: { type: String, default: "" },
		vectorStoreName: { type: String, default: "" },
		files: { type: [OpenAiKnowledgeFileSchema], default: [] },
		sourceSha256: { type: String, default: "" },
		documentSha256: { type: String, default: "" },
		schemaVersion: { type: Number, default: 1 },
		knowledgeVersion: { type: Number, default: 1 },
		status: {
			type: String,
			enum: ["pending", "indexing", "ready", "failed", "retired", "expired"],
			default: "pending",
		},
		coverageFrom: { type: String, default: "" },
		coverageThrough: { type: String, default: "" },
		sourceUpdatedAt: { type: Date },
		generatedAt: { type: Date },
		indexedAt: { type: Date },
		syncedAt: { type: Date },
		lastError: { type: String, default: "" },
	},
	{ _id: false }
);

const hotel_detailsSchema = new mongoose.Schema(
	{
		hotelName: {
			type: String,
			trim: true,
			lowercase: true,
			required: true,
		},
		hotelName_OtherLanguage: {
			type: String,
			trim: true,
			lowercase: true,
			default: "",
		},
		hotelCountry: {
			type: String,
			trim: true,
			lowercase: true,
			default: "",
		},
		hotelState: {
			type: String,
			trim: true,
			lowercase: true,
			default: "",
		},
		hotelCity: {
			type: String,
			trim: true,
			lowercase: true,
			default: "",
		},
		aboutHotel: {
			type: String,
			trim: true,
			lowercase: true,
			default: "",
		},

		aboutHotelArabic: {
			type: String,
			trim: true,
			lowercase: true,
			default: "",
		},

		phone: {
			type: String,
			trim: true,
			lowercase: true,
			default: "",
		},
		hotelAddress: {
			type: String,
			trim: true,
			lowercase: true,
			default: "",
		},
		hotelFloors: {
			// How many floors in the hotel
			type: Number,
		},
		hotelRooms: {
			type: Number,
		},
		overallRoomsCount: {
			type: Number,
		},
		distances: {
			type: Object,
			trim: true,
			lowercase: true,
			default: {
				walkingToElHaram: 0, //In Minutes
				drivingToElHaram: 0, //In Minutes
			},
		},
		roomCountDetails: {
			type: [
				{
					roomType: String, // E.g., "standardRooms"
					count: Number,
					price: { basePrice: Number },
					photos: Array,
					displayName: String,
					displayName_OtherLanguage: String,
					description: String,
					description_OtherLanguage: String,
					amenities: Array,
					views: Array,
					extraAmenities: Array,
					pricedExtras: Array,
					pricingRate: Array,
					agentInventory: Array,
					agentPricingRate: Array,
					roomColor: String,
					activeRoom: Boolean,
					commisionIncluded: Boolean,
					refundPolicyDays: Number,
					roomSize: {
						type: Number,
						default: "",
					},
					defaultCost: {
						type: Number,
						default: "",
					},
					roomCommission: {
						type: Number,
						default: 10,
					},
					bedsCount: {
						type: Number,
						default: 1,
					},
					roomForGender: {
						type: String,
						default: "Unisex",
					},
					offers: [
						{
							offerName: String,
							offerFrom: Date,
							offerTo: Date,
							offerPrice: Number,
							offerRootPrice: Number,
						},
					],
					monthly: [
						{
							monthName: String,
							monthFrom: Date,
							monthTo: Date,
							monthFromHijri: String,
							monthToHijri: String,
							monthPrice: Number,
							monthRootPrice: Number,
						},
					],
				},
			],
		},

		hotelPhotos: {
			type: Array,
			default: [],
		},
		hotelRating: {
			type: Number,
			default: 3.5,
		},
		parkingLot: {
			type: Boolean,
			default: true,
		},
		hasBusService: {
			type: Boolean,
			default: false,
		},
		busDetails: {
			type: String,
			trim: true,
			default: "",
		},
		hasMealsService: {
			type: Boolean,
			default: false,
		},
		mealsDetails: {
			type: String,
			trim: true,
			default: "",
		},
		isNusuk: {
			type: Boolean,
			default: false,
		},
		isNusukText: {
			type: String,
			trim: true,
			default: "",
		},
		hotelPolicyQA: {
			type: [
				{
					key: {
						type: String,
						trim: true,
						default: "",
					},
					category: {
						type: String,
						trim: true,
						default: "",
					},
					question: {
						type: String,
						trim: true,
						default: "",
					},
					answer: {
						type: String,
						trim: true,
						default: "",
					},
					mandatory: {
						type: Boolean,
						default: false,
					},
					active: {
						type: Boolean,
						default: false,
					},
					sortOrder: {
						type: Number,
						default: 999,
					},
				},
			],
			default: makeDefaultHotelPolicyQA,
		},
		subscribed: {
			type: Boolean,
			default: false,
		},
		acceptedTermsAndConditions: {
			type: Boolean,
			default: false,
		},
		wholeSaleHotel: {
			type: Boolean,
			default: false,
		},
		subscriptionToken: {
			type: String,
			default: "unavailable",
		},
		subscriptionId: {
			type: String,
			default: "unavailable",
		},
		stripe_account_id: {
			type: String,
			default: "",
		},
		propertyType: {
			type: Object,
			default: "hotel",
			lowercase: true,
		},
		pictures_testing: {
			type: Boolean,
			default: false,
		},
		location_testing: {
			type: Boolean,
			default: false,
		},
		rooms_pricing_testing: {
			type: Boolean,
			default: false,
		},
		activateHotel: {
			type: Boolean,
			default: false,
		},
		xHotelProActive: {
			type: Boolean,
			default: true,
		},
		aiToRespond: {
			type: Boolean,
			default: false,
		},
		// Internal OpenAI retrieval resources for this hotel. Never expose through
		// public hotel payloads; services that need it must explicitly select it.
		openaiKnowledge: {
			type: OpenAiKnowledgeSchema,
			select: false,
			default: undefined,
		},
		currency: {
			type: String, //Blank
			trim: true,
			lowercase: true,
			default: "SAR",
		},

		location: {
			type: {
				type: String,
				enum: ["Point"], // 'location.type' must be 'Point'
				required: true,
				default: "Point",
			},
			coordinates: {
				type: [Number],
				required: true,
				default: [0, 0], // Default to coordinates [longitude, latitude]
			},
		},
		hotelRunnerToken: {
			type: String, //Blank
			trim: true,
			lowercase: true,
			default: "",
		},
		commission: {
			type: Number,
			trim: true,
			lowercase: true,
			default: 10,
		},

		guestPaymentAcceptance: {
			type: Object,
			trim: true,
			lowercase: true,
			default: {
				acceptDeposit: true,
				acceptPayWholeAmount: true,
				acceptReserveNowPayInHotel: false,
			},
		},

		paymentSettings: {
			type: [
				{
					accountType: {
						type: String,
						default: "Business",
					},
					accountCountry: String,
					accountAddress: String,
					accountCity: String,
					accountPostalCode: String,
					accountName: String,
					accountNumber: String,
					routingNumber: String,
					swiftCode: String,
					bankHeadQuarterCountry: String,
					bankHeadQuarterAddress: String,
					bankHeadQuarterCity: String,
					bankHeadQuarterPostalCode: String,
					bankName: String,
					nameOfAccountOwner: String,
					accountNickName: {
						type: String,
						default: "",
					},
				},
			],
		},

		ownerPaymentMethods: {
			type: [
				{
					label: { type: String, default: "" }, // UI label
					vault_id: { type: String, required: true }, // PayPal token id
					vault_status: { type: String, default: "ACTIVE" },
					vaulted_at: { type: Date, default: Date.now },
					card_brand: { type: String, default: null }, // e.g. 'VISA'
					card_last4: { type: String, default: null }, // e.g. '1234'
					card_exp: { type: String, default: null }, // e.g. '2027-12'
					billing_address: { type: Object, default: undefined },
					default: { type: Boolean, default: false }, // default for MIT
					active: { type: Boolean, default: true }, // soft delete
					delete: { type: Boolean, default: false }, // soft delete
					method_type: {
						type: String,
						enum: ["CARD", "PAYPAL", "VENMO"],
						default: "CARD",
					},
					paypal_email: { type: String, default: null },
					paypal_payer_id: { type: String, default: null },
					venmo_username: { type: String, default: null },
					venmo_user_id: { type: String, default: null },
				},
			],
			default: [],
		},

		belongsTo: { type: ObjectId, ref: "User" },

		platform_wallet: { type: WalletSchema, default: () => ({}) }, // hotel owes platform
		hotel_wallet: { type: WalletSchema, default: () => ({}) }, // platform owes hotel
	},
	{ timestamps: true }
);

const hotelKnowledgeUpdatePaths = (update = {}) => {
	if (Array.isArray(update)) return [];
	const paths = [];
	Object.entries(update || {}).forEach(([key, value]) => {
		if (key.startsWith("$") && value && typeof value === "object") {
			paths.push(...Object.keys(value));
			return;
		}
		paths.push(key);
	});
	return [...new Set(paths.filter(Boolean))];
};

const hotelKnowledgeMetadataOnly = (paths = []) =>
	paths.length > 0 &&
	paths.every(
		(path) =>
			path === "updatedAt" ||
			path === "__v" ||
			path === "openaiKnowledge" ||
			path.startsWith("openaiKnowledge.")
	);

const exactHotelIdsFromFilter = (filter = {}, result = null) => {
	const values = [];
	const rawId = filter?._id;
	if (rawId && typeof rawId === "object" && Array.isArray(rawId.$in)) {
		values.push(...rawId.$in);
	} else if (rawId) {
		values.push(rawId);
	}
	if (result?._id) values.push(result._id);
	return [
		...new Set(
			values
				.map((value) => String(value || "").trim())
				.filter((value) => mongoose.isValidObjectId(value))
		),
	];
};

const safelyNotifyHotelKnowledgeUpdate = ({ hotelIds, reason, paths }) => {
	try {
		const {
			requestHotelOpenAiKnowledgeSyncSafely,
			requestManagedHotelOpenAiKnowledgeReconciliationSafely,
		} = require("../services/hotelOpenAiKnowledgeSyncTrigger");
		if (hotelIds.length) {
			hotelIds.forEach((hotelId) =>
				requestHotelOpenAiKnowledgeSyncSafely({ hotelId, reason, paths })
			);
		return;
		}
		requestManagedHotelOpenAiKnowledgeReconciliationSafely({ reason, paths });
	} catch (error) {
		// This notification occurs only after Mongo committed the hotel update. It
		// must never turn a successful PMS write into an HTTP failure.
		console.error(
			"[hotel-openai-sync] post-commit notifier failed safely:",
			error?.message || error
		);
	}
};

hotel_detailsSchema.post("save", function notifyKnowledgeAfterSave(document) {
	const paths = typeof document?.modifiedPaths === "function" ? document.modifiedPaths() : [];
	if (hotelKnowledgeMetadataOnly(paths)) return;
	safelyNotifyHotelKnowledgeUpdate({
		hotelIds: exactHotelIdsFromFilter({}, document),
		reason: "mongoose_post_save",
		paths,
	});
});

const notifyKnowledgeAfterQueryUpdate = function notifyKnowledgeAfterQueryUpdate(result) {
	if (this.getOptions?.().skipHotelOpenAiKnowledgeSync === true) return;
	const paths = hotelKnowledgeUpdatePaths(this.getUpdate?.() || {});
	if (hotelKnowledgeMetadataOnly(paths)) return;
	safelyNotifyHotelKnowledgeUpdate({
		hotelIds: exactHotelIdsFromFilter(this.getFilter?.() || {}, result),
		reason: `mongoose_post_${this.op || "update"}`,
		paths,
	});
};

hotel_detailsSchema.post("findOneAndUpdate", notifyKnowledgeAfterQueryUpdate);
hotel_detailsSchema.post("updateOne", notifyKnowledgeAfterQueryUpdate);
hotel_detailsSchema.post("updateMany", notifyKnowledgeAfterQueryUpdate);
hotel_detailsSchema.post("replaceOne", notifyKnowledgeAfterQueryUpdate);

const HotelDetails = mongoose.model("HotelDetails", hotel_detailsSchema);
Object.defineProperty(HotelDetails, "__knowledgeSyncTest", {
	value: {
		exactHotelIdsFromFilter,
		hotelKnowledgeMetadataOnly,
		hotelKnowledgeUpdatePaths,
	},
	enumerable: false,
});

module.exports = HotelDetails;
