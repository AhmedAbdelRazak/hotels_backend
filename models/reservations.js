/** @format */

const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema;

const reservationsSchema = new mongoose.Schema(
	{
		reservation_id: {
			type: String, //Could be left blank
			trim: true,
			lowercase: true,
			default: "",
		},

		hr_number: {
			type: String, //Could be left blank
			trim: true,
			lowercase: true,
			default: "",
		},

		confirmation_number: {
			type: String, //Exist in the file
			trim: true,
			lowercase: true,
			required: true,
			unique: true,
		},
		pms_number: {
			type: String, //could be left blank
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
			default: "confirmed",
		},
		reservation_status: {
			type: String, // is the status
			trim: true,
			lowercase: true,
			default: "confirmed",
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

		inhouse_date: {
			type: Date, //This could be left blank
			trim: true,
			lowercase: true,
			default: "",
		},

		sub_total: {
			type: Number, //Those can be added based on the file headers I gave you
			trim: true,
			lowercase: true,
			default: 0,
		},
		extras_total: {
			type: Number,
			trim: true,
			lowercase: true,
			default: 0,
		},

		tax_total: {
			type: Number,
			trim: true,
			lowercase: true,
			default: 0,
		},
		total_amount: {
			type: Number, // This is important in which it should reflect the total amount the guest should pay
			trim: true,
			lowercase: true,
			default: 0,
		},
		currency: {
			type: String, //Blank
			trim: true,
			lowercase: true,
			default: "SAR",
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

		financeStatus: {
			type: String,
			trim: true,
			lowercase: true,
			default: "not paid",
		},

		payment: {
			type: String, //PaymentModel, Payment type,
			trim: true,
			lowercase: true,
			default: "",
		},
		payment_details: {
			type: Object, //Could be left blank for now
			trim: true,
			lowercase: true,
		},
		paid_amount: {
			type: Number, //Could be left as default
			trim: true,
			lowercase: true,
			default: 0,
		},

		commission: {
			type: Number,
			default: 0,
		},

		payments: {
			type: Object,
			trim: true,
			lowercase: true, //Could be left
			default: {
				state: "checkout",
				amount: "0",
				currency: "SAR",
				exchanged_amount: "0.0",
				exchange_currency: "SAR",
				exchange_rate: "0.0",
				paid_at: null,
				payment_method_name: "Cash",
				payment_method: "cash",
				installment: null,
				response_code: null,
			},
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
		roomId: [{ type: ObjectId, ref: "Rooms", default: null }], //This could be left
		bedNumber: {
			type: Array, //If the guest chose to rent only a bed in a room
			trim: true,
			lowercase: true,
			default: [],
		},
		belongsTo: { type: ObjectId, ref: "User" }, //this will be taken care of later
		hotelId: { type: ObjectId, ref: "HotelDetails" }, //this will be taken care of later
		housedBy: {
			type: Object,
			default: {
				name: "",
			},
		},
		moneyTransferredToHotel: {
			type: Boolean,
			default: false,
		},

		guestAgreedOnTermsAndConditions: {
			type: Boolean,
			default: false,
		},
	},
	{ timestamps: true }
);

module.exports = mongoose.model("Reservations", reservationsSchema);
