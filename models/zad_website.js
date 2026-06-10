/** @format */

const mongoose = require("mongoose");

const DEFAULT_ZAD_LOGO =
	"https://assets.zyrosite.com/cdn-cgi/image/format=auto,w=375,fit=crop,q=95/mp8vK46zW5uZ3yrv/explore-the-world-2-mP42DVDyWaCRJJ7b.png";

const DEFAULT_ZAD_BANNERS = [
	{
		public_id: "zad-default-carousel-1",
		url: "https://assets.zyrosite.com/cdn-cgi/image/format=auto,w=1920,fit=crop/mp8vK46zW5uZ3yrv/5-WzMIMeu4V5oAMwan.jpg",
		title: "ZAD Hotels",
		subTitle: "Classy stays, thoughtful service, and hotels selected for comfort.",
		buttonTitle: "Explore Hotels",
		pageRedirectURL: "/our-hotels",
		btnBackgroundColor: "#0a8f82",
	},
	{
		public_id: "zad-default-carousel-2",
		url: "https://assets.zyrosite.com/cdn-cgi/image/format=auto,w=1920,fit=crop/mp8vK46zW5uZ3yrv/4-Wuc7ZGASK3870AYu.jpg",
		title: "Stay With Confidence",
		subTitle: "Browse available rooms and book your next stay with ease.",
		buttonTitle: "Book Now",
		pageRedirectURL: "/our-hotels",
		btnBackgroundColor: "#2557c7",
	},
	{
		public_id: "zad-default-carousel-3",
		url: "https://assets.zyrosite.com/cdn-cgi/image/format=auto,w=1920,fit=crop/mp8vK46zW5uZ3yrv/1-h2dMfVDIl5zXa555.jpg",
		title: "Designed Around Your Trip",
		subTitle: "Find the room type and hotel setting that fits your plans.",
		buttonTitle: "View Rooms",
		pageRedirectURL: "/our-hotels-rooms",
		btnBackgroundColor: "#7b3fb3",
	},
];

const zadWebsiteSchema = new mongoose.Schema(
	{
		siteName: {
			type: String,
			trim: true,
			default: "ZAD Hotels",
		},

		siteKey: {
			type: String,
			trim: true,
			default: "zad",
			index: true,
		},

		janatLogo: {
			type: Object,
			trim: true,
			default: {
				public_id: "zad-default-logo",
				url: DEFAULT_ZAD_LOGO,
			},
		},

		homeMainBanners: {
			type: Array,
			trim: true,
			default: DEFAULT_ZAD_BANNERS,
		},

		homeSecondBanner: {
			type: Object,
			trim: true,
			default: {
				public_id: "zad-default-home-second",
				url: DEFAULT_ZAD_BANNERS[1].url,
			},
		},

		homeThirdBanner: {
			type: Object,
			trim: true,
			default: {
				public_id: "zad-default-home-third",
				url: DEFAULT_ZAD_BANNERS[2].url,
			},
		},

		contactUsBanner: {
			type: Object,
			trim: true,
			default: {
				public_id: "zad-default-contact",
				url: DEFAULT_ZAD_BANNERS[0].url,
			},
		},

		aboutUsBanner: {
			type: Object,
			trim: true,
			default: {
				public_id: "zad-default-about",
				url: DEFAULT_ZAD_BANNERS[1].url,
			},
		},

		aboutUsPhoto: {
			type: Object,
			trim: true,
			default: {
				public_id: "",
				url: "",
			},
		},

		hotelPageBanner: {
			type: Object,
			trim: true,
			default: {
				public_id: "zad-default-hotel-page",
				url: DEFAULT_ZAD_BANNERS[2].url,
			},
		},

		termsAndConditionEnglish: {
			type: String,
			trim: true,
		},

		termsAndConditionArabic: {
			type: String,
			trim: true,
		},

		termsAndConditionEnglish_B2B: {
			type: String,
			trim: true,
		},

		termsAndConditionArabic_B2B: {
			type: String,
			trim: true,
		},

		aboutUsEnglish: {
			type: String,
			trim: true,
			default:
				"<h1>ZAD Hotels</h1><p>ZAD Hotels brings together a carefully selected hotel collection with a focus on comfort, service, and smooth booking experiences.</p>",
		},

		aboutUsArabic: {
			type: String,
			trim: true,
			default: "",
		},

		privacyPolicy: {
			type: String,
			trim: true,
		},

		privacyPolicyArabic: {
			type: String,
			trim: true,
		},

		middleSectionEnglish: {
			type: String,
			trim: true,
		},

		middleSectionArabic: {
			type: String,
			trim: true,
		},

		contactEmail: {
			type: String,
			trim: true,
			lowercase: true,
			default: "contact@zadhotels.com",
		},

		officialEmail: {
			type: String,
			trim: true,
			lowercase: true,
			default: "official@zadhotels.com",
		},

		phone: {
			type: String,
			trim: true,
			default: "+966 54 779 3608",
		},

		whatsappNumber: {
			type: String,
			trim: true,
			default: "966547793608",
		},

		brandPalette: {
			type: Object,
			default: {
				purple: "#7b3fb3",
				metallicBlue: "#2557c7",
				metallicGreen: "#0a8f82",
				cream: "#f6f0e6",
				grey: "#667085",
				black: "#08090d",
			},
		},
	},
	{ timestamps: true }
);

module.exports = mongoose.model("ZadWebsite", zadWebsiteSchema);

