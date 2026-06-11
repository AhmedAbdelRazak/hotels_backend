/** @format */

const mongoose = require("mongoose");
const ZadWebsite = require("../models/zad_website");
const HotelDetails = require("../models/hotel_details");
const User = require("../models/user");

const ZAD_OWNER_EMAIL = String(
	process.env.ZAD_OWNER_EMAIL || "mrgamal@xhoteltest.com"
)
	.trim()
	.toLowerCase();

const DEFAULT_ZAD_LOGO =
	"https://res.cloudinary.com/infiniteapps/image/upload/v1781132268/zad/defaults/logo.png";

const DEFAULT_ZAD_FOOTER_IMAGE =
	"https://res.cloudinary.com/infiniteapps/image/upload/v1781132271/zad/defaults/footer-pattern.jpg";

const DEFAULT_ZAD_BANNERS = [
	{
		public_id: "zad/defaults/home-carousel-1",
		url: "https://res.cloudinary.com/infiniteapps/image/upload/v1781132268/zad/defaults/home-carousel-1.jpg",
		title: "ZAD Hotels",
		subTitle: "Classy stays, thoughtful service, and hotels selected for comfort.",
		buttonTitle: "Explore Hotels",
		pageRedirectURL: "/our-hotels",
		btnBackgroundColor: "#0a8f82",
	},
	{
		public_id: "zad/defaults/home-carousel-2",
		url: "https://res.cloudinary.com/infiniteapps/image/upload/v1781132269/zad/defaults/home-carousel-2.jpg",
		title: "Stay With Confidence",
		subTitle: "Browse available rooms and book your next stay with ease.",
		buttonTitle: "Book Now",
		pageRedirectURL: "/our-hotels",
		btnBackgroundColor: "#2557c7",
	},
	{
		public_id: "zad/defaults/home-carousel-3",
		url: "https://res.cloudinary.com/infiniteapps/image/upload/v1781132270/zad/defaults/home-carousel-3.jpg",
		title: "Designed Around Your Trip",
		subTitle: "Find the room type and hotel setting that fits your plans.",
		buttonTitle: "View Rooms",
		pageRedirectURL: "/rooms",
		btnBackgroundColor: "#7b3fb3",
	},
];

const DEFAULT_ZAD_WEBSITE_DOCUMENT = {
	siteName: "ZAD Hotels",
	siteKey: "zad",
	janatLogo: {
		public_id: "zad/defaults/logo",
		url: DEFAULT_ZAD_LOGO,
	},
	homeMainBanners: DEFAULT_ZAD_BANNERS,
	homeSecondBanner: {
		public_id: "zad-default-home-second",
		url: DEFAULT_ZAD_BANNERS[1].url,
	},
	homeThirdBanner: {
		public_id: "zad-default-home-third",
		url: DEFAULT_ZAD_BANNERS[2].url,
	},
	contactUsBanner: {
		public_id: "zad-default-contact",
		url: DEFAULT_ZAD_BANNERS[0].url,
	},
	aboutUsBanner: {
		public_id: "zad-default-about",
		url: DEFAULT_ZAD_BANNERS[1].url,
	},
	aboutUsPhoto: {
		public_id: "",
		url: "",
	},
	hotelPageBanner: {
		public_id: "zad-default-hotel-page",
		url: DEFAULT_ZAD_BANNERS[2].url,
	},
	footerBanner: {
		public_id: "zad/defaults/footer-pattern",
		url: DEFAULT_ZAD_FOOTER_IMAGE,
	},
	aboutUsEnglish:
		"<h1>ZAD Hotels</h1><p>ZAD Hotels brings together a carefully selected hotel collection with a focus on comfort, service, and smooth booking experiences.</p>",
	aboutUsArabic:
		"<h1>زاد للفنادق</h1><p>تجمع زاد للفنادق مجموعة مختارة بعناية مع تركيز على الراحة والخدمة وتجربة حجز واضحة وسلسة.</p>",
	termsAndConditionEnglish: "",
	termsAndConditionArabic: "",
	termsAndConditionEnglish_B2B: "",
	termsAndConditionArabic_B2B: "",
	privacyPolicy: "",
	privacyPolicyArabic: "",
	middleSectionEnglish: "",
	middleSectionArabic: "",
	contactEmail: "contact@zadhotels.com",
	officialEmail: "official@zadhotels.com",
	phone: "+966 54 779 3608",
	whatsappNumber: "966547793608",
	brandPalette: {
		purple: "#7b3fb3",
		metallicBlue: "#2557c7",
		metallicGreen: "#0a8f82",
		cream: "#f6f0e6",
		grey: "#667085",
		black: "#08090d",
	},
};

const PUBLIC_HOTEL_CACHE_TTL_MS = 60 * 1000;
const PUBLIC_HOTEL_CACHE_MAX_KEYS = 80;
const zadPublicCache = new Map();

const PUBLIC_HOTEL_LIST_SELECT = [
	"hotelName",
	"hotelName_OtherLanguage",
	"hotelCountry",
	"hotelState",
	"hotelCity",
	"hotelAddress",
	"distances",
	"hotelPhotos",
	"hotelRating",
	"location",
	"commission",
	"guestPaymentAcceptance",
	"belongsTo",
	"roomCountDetails._id",
	"roomCountDetails.roomType",
	"roomCountDetails.count",
	"roomCountDetails.price",
	"roomCountDetails.photos",
	"roomCountDetails.displayName",
	"roomCountDetails.displayName_OtherLanguage",
	"roomCountDetails.description",
	"roomCountDetails.description_OtherLanguage",
	"roomCountDetails.amenities",
	"roomCountDetails.views",
	"roomCountDetails.extraAmenities",
	"roomCountDetails.roomColor",
	"roomCountDetails.activeRoom",
	"roomCountDetails.refundPolicyDays",
	"roomCountDetails.roomSize",
	"roomCountDetails.defaultCost",
	"roomCountDetails.roomCommission",
	"roomCountDetails.bedsCount",
	"roomCountDetails.roomForGender",
].join(" ");

const PUBLIC_HOTEL_QUERY_SELECT = `${PUBLIC_HOTEL_LIST_SELECT} roomCountDetails.pricingRate`;
const PUBLIC_HOTEL_DEALS_SELECT = `${PUBLIC_HOTEL_LIST_SELECT} roomCountDetails.offers roomCountDetails.monthly`;

const normalizeId = (value) => String(value?._id || value?.id || value || "").trim();

const validObjectId = (value) => mongoose.Types.ObjectId.isValid(normalizeId(value));

const toObjectId = (value) => mongoose.Types.ObjectId(normalizeId(value));

const uniqueIds = (values = []) => [
	...new Set(
		(Array.isArray(values) ? values : [values])
			.map(normalizeId)
			.filter((id) => id && mongoose.Types.ObjectId.isValid(id))
	),
];

const configuredSuperAdminIds = () =>
	[process.env.SUPER_ADMIN_ID, process.env.REACT_APP_SUPER_ADMIN_ID]
		.flatMap((value) => String(value || "").split(","))
		.map((id) => id.trim())
		.filter(Boolean);

const isConfiguredSuperAdmin = (user = {}) =>
	configuredSuperAdminIds().includes(normalizeId(user._id || user));

const parseTimeToMinutes = (timeStr) => {
	if (!timeStr || typeof timeStr !== "string") return Infinity;
	let totalMinutes = 0;
	const dayMatch = timeStr.match(/(\d+)\s*day[s]?/i);
	const hourMatch = timeStr.match(/(\d+)\s*hour[s]?/i);
	const minMatch = timeStr.match(/(\d+)\s*min[s]?/i);
	if (dayMatch) totalMinutes += parseInt(dayMatch[1], 10) * 1440;
	if (hourMatch) totalMinutes += parseInt(hourMatch[1], 10) * 60;
	if (minMatch) totalMinutes += parseInt(minMatch[1], 10);
	return totalMinutes;
};

const sortPublicHotels = (hotels = []) =>
	[...hotels].sort((a, b) => {
		if ((b.hotelRating || 0) !== (a.hotelRating || 0)) {
			return (b.hotelRating || 0) - (a.hotelRating || 0);
		}
		return (
			parseTimeToMinutes(a.distances?.walkingToElHaram) -
			parseTimeToMinutes(b.distances?.walkingToElHaram)
		);
	});

const compactArray = (value = [], limit = 8) =>
	Array.isArray(value) ? value.filter(Boolean).slice(0, limit) : [];

const compactPricingRate = (pricingRate = [], startDate, endDate) => {
	if (!Array.isArray(pricingRate)) return [];
	if (!startDate || !endDate) return [];

	return pricingRate
		.filter((rate) => {
			const dateKey = String(rate?.calendarDate || "").slice(0, 10);
			return dateKey && dateKey >= startDate && dateKey < endDate;
		})
		.map((rate) => ({
			calendarDate: rate.calendarDate,
			room_type: rate.room_type,
			price: rate.price,
			rootPrice: rate.rootPrice,
			commissionRate: rate.commissionRate,
			color: rate.color,
		}));
};

const isPublicRoomVisible = (room = {}, roomType = "all") => {
	const matchesRoomType = roomType === "all" || room.roomType === roomType;
	return (
		matchesRoomType &&
		room.activeRoom === true &&
		Number(room?.price?.basePrice || 0) > 0 &&
		Array.isArray(room.photos) &&
		room.photos.length > 0
	);
};

const compactPublicRoom = (
	room = {},
	{ includePricingRate = false, startDate, endDate } = {}
) => ({
	_id: room._id,
	roomType: room.roomType,
	count: room.count,
	price: room.price || { basePrice: 0 },
	photos: compactArray(room.photos, 8),
	displayName: room.displayName,
	displayName_OtherLanguage: room.displayName_OtherLanguage,
	description: room.description,
	description_OtherLanguage: room.description_OtherLanguage,
	amenities: compactArray(room.amenities, 40),
	views: compactArray(room.views, 20),
	extraAmenities: compactArray(room.extraAmenities, 20),
	pricingRate: includePricingRate
		? compactPricingRate(room.pricingRate, startDate, endDate)
		: [],
	roomColor: room.roomColor,
	activeRoom: room.activeRoom,
	refundPolicyDays: room.refundPolicyDays,
	roomSize: room.roomSize,
	defaultCost: room.defaultCost,
	roomCommission: room.roomCommission,
	bedsCount: room.bedsCount,
	roomForGender: room.roomForGender,
});

const compactPublicHotel = (
	hotel = {},
	{ includePricingRate = false, startDate, endDate, roomType = "all" } = {}
) => ({
	_id: hotel._id,
	hotelName: hotel.hotelName,
	hotelName_OtherLanguage: hotel.hotelName_OtherLanguage,
	hotelCountry: hotel.hotelCountry,
	hotelState: hotel.hotelState,
	hotelCity: hotel.hotelCity,
	hotelAddress: hotel.hotelAddress,
	distances: hotel.distances,
	hotelPhotos: compactArray(hotel.hotelPhotos, 8),
	hotelRating: hotel.hotelRating,
	location: hotel.location,
	commission: hotel.commission,
	guestPaymentAcceptance: hotel.guestPaymentAcceptance,
	belongsTo: hotel.belongsTo,
	roomCountDetails: compactArray(hotel.roomCountDetails, 80)
		.filter((room) => isPublicRoomVisible(room, roomType))
		.map((room) =>
			compactPublicRoom(room, {
				includePricingRate,
				startDate,
				endDate,
			})
		),
});

const stripAgentRoomOverrides = (hotel = {}) => {
	const plain =
		hotel && typeof hotel.toObject === "function" ? hotel.toObject() : { ...hotel };
	if (!Array.isArray(plain.roomCountDetails)) return plain;
	plain.roomCountDetails = plain.roomCountDetails.map((room = {}) => {
		const nextRoom =
			room && typeof room.toObject === "function" ? room.toObject() : { ...room };
		delete nextRoom.agentInventory;
		delete nextRoom.agentPricingRate;
		return nextRoom;
	});
	return plain;
};

const cacheGet = (key) => {
	const hit = zadPublicCache.get(key);
	if (!hit) return null;
	if (Date.now() > hit.expiresAt) {
		zadPublicCache.delete(key);
		return null;
	}
	return hit.value;
};

const cacheSet = (key, value) => {
	if (zadPublicCache.size >= PUBLIC_HOTEL_CACHE_MAX_KEYS) {
		const oldestKey = zadPublicCache.keys().next().value;
		if (oldestKey) zadPublicCache.delete(oldestKey);
	}
	zadPublicCache.set(key, {
		value,
		expiresAt: Date.now() + PUBLIC_HOTEL_CACHE_TTL_MS,
	});
};

const setPublicHotelCacheHeaders = (res) => {
	res.setHeader("Cache-Control", "public, max-age=60, s-maxage=120");
};

const sendCachedJson = async (_req, res, cacheKey, loader) => {
	setPublicHotelCacheHeaders(res);
	const cached = cacheGet(cacheKey);
	if (cached) return res.status(200).json(cached);
	const value = await loader();
	cacheSet(cacheKey, value);
	return res.status(200).json(value);
};

const escapeRegex = (value = "") =>
	String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const buildHotelSlugRegex = (slug = "") => {
	const decoded = decodeURIComponent(slug || "")
		.replace(/[_-]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	const parts = decoded.split(" ").filter(Boolean).map(escapeRegex);
	return parts.length ? new RegExp(`^${parts.join("[\\s_-]+")}$`, "i") : null;
};

const mergeWebsiteDefaults = (doc = {}) => {
	const source =
		doc && typeof doc.toObject === "function" ? doc.toObject() : { ...doc };
	const merged = {
		...DEFAULT_ZAD_WEBSITE_DOCUMENT,
		...source,
		janatLogo: source.janatLogo?.url
			? source.janatLogo
			: DEFAULT_ZAD_WEBSITE_DOCUMENT.janatLogo,
		homeMainBanners:
			Array.isArray(source.homeMainBanners) && source.homeMainBanners.length
				? source.homeMainBanners
				: DEFAULT_ZAD_WEBSITE_DOCUMENT.homeMainBanners,
		homeSecondBanner: source.homeSecondBanner?.url
			? source.homeSecondBanner
			: DEFAULT_ZAD_WEBSITE_DOCUMENT.homeSecondBanner,
		homeThirdBanner: source.homeThirdBanner?.url
			? source.homeThirdBanner
			: DEFAULT_ZAD_WEBSITE_DOCUMENT.homeThirdBanner,
		contactUsBanner: source.contactUsBanner?.url
			? source.contactUsBanner
			: DEFAULT_ZAD_WEBSITE_DOCUMENT.contactUsBanner,
		aboutUsBanner: source.aboutUsBanner?.url
			? source.aboutUsBanner
			: DEFAULT_ZAD_WEBSITE_DOCUMENT.aboutUsBanner,
		hotelPageBanner: source.hotelPageBanner?.url
			? source.hotelPageBanner
			: DEFAULT_ZAD_WEBSITE_DOCUMENT.hotelPageBanner,
		footerBanner: source.footerBanner?.url
			? source.footerBanner
			: DEFAULT_ZAD_WEBSITE_DOCUMENT.footerBanner,
	};
	return merged;
};

const sanitizeZadWebsiteUpdate = (body = {}) => {
	const allowedFields = new Set([
		"siteName",
		"siteKey",
		"janatLogo",
		"homeMainBanners",
		"homeSecondBanner",
		"homeThirdBanner",
		"contactUsBanner",
		"aboutUsBanner",
		"aboutUsPhoto",
		"hotelPageBanner",
		"footerBanner",
		"termsAndConditionEnglish",
		"termsAndConditionArabic",
		"termsAndConditionEnglish_B2B",
		"termsAndConditionArabic_B2B",
		"aboutUsEnglish",
		"aboutUsArabic",
		"privacyPolicy",
		"privacyPolicyArabic",
		"middleSectionEnglish",
		"middleSectionArabic",
		"contactEmail",
		"officialEmail",
		"phone",
		"whatsappNumber",
		"brandPalette",
	]);
	return Object.fromEntries(
		Object.entries(body || {}).filter(([key]) => allowedFields.has(key))
	);
};

const actorCanManageZadWebsite = (actor = {}) =>
	actor?.activeUser !== false &&
	(isConfiguredSuperAdmin(actor) ||
		String(actor.email || "").trim().toLowerCase() === ZAD_OWNER_EMAIL);

const getZadOwner = async () =>
	User.findOne({ email: ZAD_OWNER_EMAIL })
		.select(
			"_id email activeUser hotelIdWork hotelIdsWork hotelsToSupport hotelIdsOwner belongsToId"
		)
		.lean()
		.exec();

const getZadHotelIds = async () => {
	const owner = await getZadOwner();
	if (!owner?._id) return [];

	const candidateIds = uniqueIds([
		owner.hotelIdWork,
		...(Array.isArray(owner.hotelIdsWork) ? owner.hotelIdsWork : []),
		...(Array.isArray(owner.hotelsToSupport) ? owner.hotelsToSupport : []),
		...(Array.isArray(owner.hotelIdsOwner) ? owner.hotelIdsOwner : []),
	]);

	const ownerIds = uniqueIds([owner._id, owner.belongsToId]).map(toObjectId);
	const ownedIds = ownerIds.length
		? await HotelDetails.find({ belongsTo: { $in: ownerIds } }).distinct("_id")
		: [];

	return uniqueIds([...candidateIds, ...ownedIds]);
};

const buildZadPublicHotelFilter = async ({ requireRoomGate = true } = {}) => {
	const hotelIds = await getZadHotelIds();
	const objectIds = hotelIds.map(toObjectId);
	const baseFilter = {
		_id: { $in: objectIds },
		activateHotel: true,
		xHotelProActive: { $ne: false },
		hotelPhotos: { $exists: true, $not: { $size: 0 } },
		"location.coordinates": { $ne: [0, 0] },
	};

	if (requireRoomGate) {
		baseFilter.roomCountDetails = {
			$elemMatch: {
				activeRoom: true,
				"price.basePrice": { $gt: 0 },
				photos: { $exists: true, $not: { $size: 0 } },
			},
		};
	}

	return baseFilter;
};

const withDestinationFilter = (baseFilter = {}, destination = "") => {
	const cleanDestination = decodeURIComponent(String(destination || ""))
		.replace(/[-_]+/g, " ")
		.trim();
	if (!cleanDestination || cleanDestination.toLowerCase() === "all") {
		return baseFilter;
	}
	const destinationRegex = new RegExp(escapeRegex(cleanDestination), "i");
	return {
		...baseFilter,
		$or: [
			{ hotelState: { $regex: destinationRegex } },
			{ hotelCity: { $regex: destinationRegex } },
			{ hotelCountry: { $regex: destinationRegex } },
			{ hotelAddress: { $regex: destinationRegex } },
		],
	};
};

exports.listZadWebsiteDocuments = async (_req, res) => {
	try {
		const documents = await ZadWebsite.find({ siteKey: "zad" })
			.sort({ createdAt: 1 })
			.lean()
			.exec();
		const normalized = documents.length
			? documents.map(mergeWebsiteDefaults)
			: [DEFAULT_ZAD_WEBSITE_DOCUMENT];
		return res.status(200).json(normalized);
	} catch (error) {
		console.error("Zad website list error:", error);
		return res.status(500).json({
			error: "There was an error retrieving the Zad website document.",
		});
	}
};

exports.createUpdateZadWebsiteDocument = async (req, res) => {
	try {
		if (!actorCanManageZadWebsite(req.profile)) {
			return res.status(403).json({
				error: "Only the Zad website owner or platform admin can update this website.",
			});
		}

		const { documentId } = req.params;
		const updateBody = {
			...sanitizeZadWebsiteUpdate(req.body),
			siteKey: "zad",
		};

		let data;
		if (documentId && validObjectId(documentId)) {
			data = await ZadWebsite.findOneAndUpdate(
				{ _id: toObjectId(documentId), siteKey: "zad" },
				updateBody,
				{ new: true }
			).exec();
			if (!data) {
				return res.status(404).json({
					message: "Zad website document was not found with the provided ID.",
				});
			}
		} else {
			const existing = await ZadWebsite.findOne({ siteKey: "zad" }).exec();
			if (existing) {
				data = await ZadWebsite.findOneAndUpdate(
					{ _id: existing._id },
					updateBody,
					{ new: true }
				).exec();
			} else {
				data = await new ZadWebsite(updateBody).save();
			}
		}

		return res.status(200).json({
			message: "Zad website document saved successfully.",
			data: mergeWebsiteDefaults(data),
		});
	} catch (error) {
		console.error("Zad website save error:", error);
		return res.status(500).json({
			error: "Error saving Zad website document.",
		});
	}
};

exports.listOfAllActiveZadHotels = async (req, res) => {
	try {
		return sendCachedJson(req, res, "zad:active-hotels", async () => {
			const activeHotels = await HotelDetails.find(
				await buildZadPublicHotelFilter()
			)
				.select(PUBLIC_HOTEL_LIST_SELECT)
				.lean()
				.exec();

			return sortPublicHotels(
				activeHotels
					.map((hotel) => compactPublicHotel(hotel))
					.filter((hotel) => hotel.roomCountDetails.length > 0)
			);
		});
	} catch (error) {
		console.error("Zad active hotels error:", error);
		return res
			.status(500)
			.json({ error: "An error occurred while fetching Zad active hotels." });
	}
};

exports.getZadListOfHotels = async (req, res) => {
	try {
		return sendCachedJson(req, res, "zad:active-hotel-list", async () => {
			const hotels = await HotelDetails.find(await buildZadPublicHotelFilter())
				.select(PUBLIC_HOTEL_LIST_SELECT)
				.lean()
				.exec();

			const publicHotels = sortPublicHotels(
				hotels
					.map((hotel) => compactPublicHotel(hotel))
					.filter((hotel) => hotel.roomCountDetails.length > 0)
			);

			if (!publicHotels.length) {
				const error = new Error("No Zad hotels found with the specified criteria.");
				error.statusCode = 404;
				throw error;
			}
			return publicHotels;
		});
	} catch (error) {
		if (error.statusCode === 404) {
			return res.status(404).json({ message: error.message });
		}
		console.error("Zad hotel list error:", error);
		return res
			.status(500)
			.json({ error: "An error occurred while fetching Zad hotels." });
	}
};

exports.distinctZadRoomTypes = async (req, res) => {
	try {
		return sendCachedJson(req, res, "zad:distinct-rooms", async () => {
			const activeHotels = await HotelDetails.find(
				await buildZadPublicHotelFilter()
			)
				.select(
					"roomCountDetails._id roomCountDetails.roomType roomCountDetails.displayName roomCountDetails.price roomCountDetails.photos roomCountDetails.activeRoom"
				)
				.lean()
				.exec();

			const seen = new Set();
			const roomTypes = [];
			activeHotels.forEach((hotel) => {
				(hotel.roomCountDetails || []).forEach((room) => {
					if (!isPublicRoomVisible(room)) return;
					const key = `${room.roomType || ""}:${room.displayName || ""}`;
					if (seen.has(key)) return;
					seen.add(key);
					roomTypes.push({
						roomType: room.roomType,
						displayName: room.displayName,
						_id: room._id,
					});
				});
			});
			return roomTypes;
		});
	} catch (error) {
		console.error("Zad distinct room types error:", error);
		return res
			.status(500)
			.json({ error: "An error occurred while fetching Zad room types." });
	}
};

exports.getZadHotelFromSlug = async (req, res) => {
	try {
		const slugParam = req.params.hotelSlug || req.params.hotelNameSlug;
		if (!slugParam) {
			return res.status(400).json({ error: "Missing hotel slug." });
		}

		const slugRegex = buildHotelSlugRegex(slugParam);
		if (!slugRegex) {
			return res.status(400).json({ error: "Invalid hotel slug." });
		}

		const baseFilter = await buildZadPublicHotelFilter({ requireRoomGate: false });
		const hotel = await HotelDetails.findOne({
			...baseFilter,
			$or: [
				{ hotelName: { $regex: slugRegex } },
				{ hotelName_OtherLanguage: { $regex: slugRegex } },
			],
		})
			.lean()
			.exec();

		if (!hotel) {
			return res.status(404).json({
				message: "No active Zad hotel found for the provided slug.",
			});
		}

		const filteredRooms = Array.isArray(hotel.roomCountDetails)
			? hotel.roomCountDetails.filter((room) => room && room.activeRoom)
			: [];

		return res.status(200).json(
			stripAgentRoomOverrides({
				...hotel,
				roomCountDetails: filteredRooms,
			})
		);
	} catch (error) {
		console.error("Zad single hotel error:", error);
		return res.status(500).json({
			error: "An error occurred while fetching the Zad hotel.",
		});
	}
};

exports.gettingZadRoomListFromQuery = async (req, res) => {
	try {
		const { query } = req.params;
		const [startDate, endDate, roomType = "all", adults, _children, destination] =
			String(query || "").split("_");

		if (!startDate || !endDate || !roomType || !adults) {
			return res.status(400).json({ error: "Invalid query parameters." });
		}

		return sendCachedJson(req, res, `zad:room-query-list:${query}`, async () => {
			const baseFilter = withDestinationFilter(
				await buildZadPublicHotelFilter({ requireRoomGate: false }),
				destination
			);

			const hotels = await HotelDetails.find(baseFilter)
				.select(PUBLIC_HOTEL_QUERY_SELECT)
				.lean()
				.exec();

			return sortPublicHotels(
				hotels
					.map((hotel) =>
						compactPublicHotel(hotel, {
							includePricingRate: true,
							startDate,
							endDate,
							roomType,
						})
					)
					.filter((hotel) => hotel.roomCountDetails.length > 0)
			);
		});
	} catch (error) {
		console.error("Zad room query error:", error);
		return res.status(500).json({
			error: "An error occurred while fetching Zad room query results.",
		});
	}
};

const safeNumber = (value) =>
	Number.isFinite(Number(value)) ? Number(value) : Infinity;

const isActiveOrUpcoming = (from, to, now = new Date()) => {
	const f = from ? new Date(from) : null;
	const t = to ? new Date(to) : null;
	if (f && isNaN(f)) return false;
	if (t && isNaN(t)) return false;
	if (t && t < now) return false;
	if (f && f >= now) return true;
	if (t && t >= now) return true;
	return false;
};

exports.listOfAllActiveZadHotelsMonthlyAndOffers = async (_req, res) => {
	try {
		setPublicHotelCacheHeaders(res);
		const baseFilter = await buildZadPublicHotelFilter({ requireRoomGate: false });
		const hotels = await HotelDetails.find({
			...baseFilter,
			roomCountDetails: {
				$elemMatch: {
					activeRoom: true,
					"price.basePrice": { $gt: 0 },
					photos: { $exists: true, $not: { $size: 0 } },
					$or: [
						{ "offers.0": { $exists: true } },
						{ "monthly.0": { $exists: true } },
					],
				},
			},
		})
			.select(PUBLIC_HOTEL_DEALS_SELECT)
			.lean()
			.exec();

		const now = new Date();
		const filtered = hotels
			.map((hotel) => {
				const trimmedRooms = (hotel.roomCountDetails || [])
					.filter((room) => isPublicRoomVisible(room))
					.map((room) => {
						const offers = (Array.isArray(room.offers) ? room.offers : [])
							.filter((offer) =>
								isActiveOrUpcoming(
									offer.offerFrom || offer.from || offer.validFrom,
									offer.offerTo || offer.to || offer.validTo,
									now
								)
							)
							.sort(
								(a, b) =>
									safeNumber(a.offerPrice ?? a.price) -
									safeNumber(b.offerPrice ?? b.price)
							);
						const monthly = (Array.isArray(room.monthly) ? room.monthly : [])
							.filter((month) =>
								isActiveOrUpcoming(
									month.monthFrom || month.from || month.validFrom,
									month.monthTo || month.to || month.validTo,
									now
								)
							)
							.sort(
								(a, b) =>
									safeNumber(a.monthPrice ?? a.price ?? a.rate) -
									safeNumber(b.monthPrice ?? b.price ?? b.rate)
							);
						return { ...room, offers, monthly };
					})
					.filter((room) => room.offers.length || room.monthly.length);

				return { ...hotel, roomCountDetails: trimmedRooms };
			})
			.filter((hotel) => hotel.roomCountDetails.length > 0)
			.map(stripAgentRoomOverrides);

		return res.status(200).json(sortPublicHotels(filtered));
	} catch (error) {
		console.error("Zad hotels with deals error:", error);
		return res.status(500).json({
			error:
				"An error occurred while fetching active Zad hotels with monthly/offers.",
		});
	}
};

exports.getZadScopeHealth = async (_req, res) => {
	try {
		const owner = await getZadOwner();
		const hotelIds = await getZadHotelIds();
		return res.status(200).json({
			ok: true,
			ownerEmail: ZAD_OWNER_EMAIL,
			ownerFound: Boolean(owner?._id),
			hotelCount: hotelIds.length,
			hotelIds,
		});
	} catch (error) {
		console.error("Zad scope health error:", error);
		return res.status(500).json({
			ok: false,
			error: "Unable to verify Zad hotel scope.",
		});
	}
};
