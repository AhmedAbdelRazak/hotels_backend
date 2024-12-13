/** @format */

const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema;

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
		subscribed: {
			type: Boolean,
			default: false,
		},
		acceptedTermsAndConditions: {
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

		belongsTo: { type: ObjectId, ref: "User" },
	},
	{ timestamps: true }
);

module.exports = mongoose.model("HotelDetails", hotel_detailsSchema);
