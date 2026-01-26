/** @format */

const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema;

const uncompletedReservationsSchema = new mongoose.Schema(
	{
		confirmation_number: {
			type: String,
			trim: true,
			lowercase: true,
			default: "",
		},
		userId: { type: ObjectId, ref: "User", default: null },
		hotelName: {
			type: String,
			trim: true,
			lowercase: true,
			default: "",
		},
		booking_source: {
			type: String, //Will be added but based on the file
			trim: true,
			lowercase: true,
			default: "",
		},
		customer_details: {
			type: Object, //This is based on the mapping you did in the 3 files, whatever doesn't exist, then leave blank
			trim: true,
			default: {
				name: "", // firstname + lastname
				phone: "", //address.phone
				email: "", //address.email
				passport: "", //guest_national_id
				passportExpiry: "",
				nationality: "", //country
				copyNumber: "",
				cardNumber: "", // Should be hashed, no access to anyone for security
				cardExpiryDate: "", // Should be hashed, no access to anyone for security
				cardCVV: "", // Should be hashed, no access to anyone for security
				cardHolderName: "", // Should be hashed, no access to anyone for security
				hasCar: "no",
				carLicensePlate: "",
				carColor: "",
				carModel: "",
				carYear: "",
			},
		},
		state: {
			type: String, // could be left as default "confirmed"
			trim: true,
			lowercase: true,
			default: "uncomplete",
		},
		reservation_status: {
			type: String, // is the status
			trim: true,
			lowercase: true,
			default: "uncomplete",
		},
		total_guests: {
			type: Number, //use the mapping
			default: 1,
		},
		adults: {
			type: Number, //use the mapping
			default: 1,
		},
		children: {
			type: Number, //use the mapping
			default: 0,
		},
		pickedRoomsPricing: {
			type: Array, //This will be discussed later
			default: [],
		},
		total_rooms: {
			type: Number,
			default: 1,
		},

		cancel_reason: {
			type: String, //if exist in any of the headers I gave you then add it
			trim: true,
			lowercase: true,
			default: "",
		},
		booked_at: {
			type: Date, //In the file in the 3 file in the headers
			trim: true,
			lowercase: true,
			default: new Date(),
		},

		total_amount: {
			type: Number, // This is important in which it should reflect the total amount the guest should pay
			trim: true,
			lowercase: true,
			default: 0,
		},
		payment: {
			type: String,
			trim: true,
			lowercase: true,
			default: "",
		},
		paid_amount: {
			type: Number,
			default: 0,
		},
		commission: {
			type: Number,
			default: 0,
		},
		commissionPaid: {
			type: Boolean,
			default: false,
		},
		convertedAmounts: {
			type: Object,
			default: {},
		},

		checkin_date: {
			type: Date,
			default: "",
		},
		checkout_date: {
			type: Date,
			default: "",
		},
		days_of_residence: {
			type: Number, //It should be calculated the difference between checkout and checkin
			default: 0,
		},

		comment: {
			type: String, //If there is a comment, then add it
			trim: true,
			lowercase: true,
			default: "",
		},

		pickedRoomsType: {
			type: Array,
			default: [
				{
					room_type: "", // "name" from rooms array
					chosenPrice: "", //"total" from the rooms array
					count: 1, // leave the default because each object in the rooms array is supposed to be only 1 room
					pricingByDay: [],
				},
			],
		},
		belongsTo: { type: ObjectId, ref: "User" }, //this will be taken care of later
		hotelId: { type: ObjectId, ref: "HotelDetails" }, //this will be taken care of later
		rootCause: {
			type: String,
			trim: true,
			lowercase: true,
			default: "",
		},

		guestAgreedOnTermsAndConditions: {
			type: Boolean,
			default: false,
		},
	},
	{ timestamps: true }
);

module.exports = mongoose.model(
	"UncompleteReservations",
	uncompletedReservationsSchema
);
