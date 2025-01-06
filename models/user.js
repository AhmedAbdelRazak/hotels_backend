/** @format */

const mongoose = require("mongoose");
const crypto = require("crypto");
const { v1: uuidv1 } = require("uuid");
const { ObjectId } = mongoose.Schema;

const userSchema = new mongoose.Schema(
	{
		name: {
			type: String,
			trim: true,
			required: true,
			maxlength: [32, "Too long"],
		},
		email: {
			type: String,
			trim: true,
			required: true,
			unique: true,
			lowercase: true,
		},
		hashed_password: {
			type: String,
			required: true,
		},
		hotelName: {
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

		phone: {
			type: String,
			trim: true,
			lowercase: true,
		},

		hotelAddress: {
			type: String,
			trim: true,
			lowercase: true,
			default: "",
		},

		salt: String,

		employeeImage: String,

		role: {
			type: Number,
			default: 0,
		},

		roleDescription: {
			type: String,
			trim: true,
			lowercase: true,
			default: "",
		},

		resetPasswordLink: {
			type: String,
			default: "",
		},

		activeUser: {
			type: Boolean,
			default: true,
		},

		hotelIdWork: {
			type: String,
			lowercase: true,
			trim: true,
			default: "",
		},

		belongsToId: {
			type: String,
			lowercase: true,
			trim: true,
			default: "",
		},

		confirmationNumbersBooked: {
			type: Array,
			lowercase: true,
			trim: true,
			default: [],
		},

		subscribed: {
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

		hotelIdsOwner: [{ type: ObjectId, ref: "HotelDetails", default: null }],
	},
	{ timestamps: true }
);

// virtual field
userSchema
	.virtual("password")
	.set(function (password) {
		this._password = password;
		this.salt = uuidv1();
		this.hashed_password = this.encryptPassword(password);
	})
	.get(function () {
		return this._password;
	});

userSchema.methods = {
	authenticate: function (plainText) {
		return this.encryptPassword(plainText) === this.hashed_password;
	},

	encryptPassword: function (password) {
		if (!password) return "";
		try {
			return crypto
				.createHmac("sha1", this.salt)
				.update(password)
				.digest("hex");
		} catch (err) {
			return "";
		}
	},
};

module.exports = mongoose.model("User", userSchema);
