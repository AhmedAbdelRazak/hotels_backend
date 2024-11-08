const Janat = require("../models/janat");
const HotelDetails = require("../models/hotel_details");
const mongoose = require("mongoose");
const Reservations = require("../models/reservations"); // Assuming this is your reservations model
const crypto = require("crypto"); // For hashing or encrypting card details

exports.createUpdateDocument = (req, res) => {
	const { documentId } = req.params;

	// Check if documentId is provided and is a valid ObjectId
	if (documentId && mongoose.Types.ObjectId.isValid(documentId)) {
		const condition = { _id: mongoose.Types.ObjectId(documentId) };
		const update = req.body;

		Janat.findOneAndUpdate(condition, update, { new: true }, (err, data) => {
			if (err) {
				console.error(err);
				return res.status(500).json({
					error: "Error in updating document",
				});
			}

			if (!data) {
				return res.status(404).json({
					message: "Document not found with the provided ID",
				});
			}

			return res.status(200).json({
				message: "Document updated successfully",
				data,
			});
		});
	} else {
		// If documentId is not provided, create a new document
		const newDocument = new Janat(req.body);

		newDocument.save((err, data) => {
			if (err) {
				console.error(err);
				return res.status(500).json({
					error: "Error in creating new document",
				});
			}

			return res.status(201).json({
				message: "New document created successfully",
				data,
			});
		});
	}
};

exports.list = (req, res) => {
	Janat.find({}).exec((err, documents) => {
		if (err) {
			return res.status(500).json({
				error: "There was an error retrieving the documents",
			});
		}
		res.json(documents);
	});
};

exports.listOfAllActiveHotels = async (req, res) => {
	try {
		const activeHotels = await HotelDetails.find({
			activateHotel: true,
			hotelPhotos: { $exists: true, $not: { $size: 0 } },
			"location.coordinates": { $ne: [0, 0] },
			roomCountDetails: {
				$elemMatch: {
					"price.basePrice": { $gt: 0 },
					photos: { $exists: true, $not: { $size: 0 } },
				},
			},
		});

		res.json(activeHotels);
	} catch (err) {
		console.error(err);
		res
			.status(500)
			.json({ error: "An error occurred while fetching active hotels." });
	}
};

exports.distinctRoomTypes = async (req, res) => {
	try {
		const activeHotels = await HotelDetails.find({
			activateHotel: true,
			hotelPhotos: { $exists: true, $not: { $size: 0 } },
			"location.coordinates": { $ne: [0, 0] },
			roomCountDetails: {
				$elemMatch: {
					"price.basePrice": { $gt: 0 },
					photos: { $exists: true, $not: { $size: 0 } },
				},
			},
		});

		// Extract distinct room types, display names, and _id
		let roomTypes = [];
		activeHotels.forEach((hotel) => {
			hotel.roomCountDetails.forEach((room) => {
				if (room.price.basePrice > 0 && room.photos.length > 1) {
					roomTypes.push({
						roomType: room.roomType,
						displayName: room.displayName,
						_id: room._id,
					});
				}
			});
		});

		// Remove duplicates
		roomTypes = roomTypes.filter(
			(value, index, self) =>
				index ===
				self.findIndex(
					(t) =>
						t.roomType === value.roomType && t.displayName === value.displayName
				)
		);

		res.json(roomTypes);
	} catch (err) {
		console.error(err);
		res
			.status(500)
			.json({ error: "An error occurred while fetching distinct room types." });
	}
};

exports.getHotelFromSlug = async (req, res) => {
	try {
		const { hotelSlug } = req.params;

		// Escape special characters in the slug for regex matching
		const escapedSlug = hotelSlug
			.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")
			.replace(/-/g, " ");

		// Find the hotel where hotelName (with spaces replaced by '-') matches hotelSlug
		const hotel = await HotelDetails.findOne({
			hotelName: {
				$regex: new RegExp(`^${escapedSlug}$`, "i"),
			},
		});

		if (!hotel) {
			return res.status(404).json({
				message: "No hotel found for the provided slug.",
			});
		}

		res.status(200).json(hotel);
	} catch (error) {
		console.error("Error fetching hotel by slug:", error);
		res.status(500).json({
			error: "An error occurred while fetching the hotel.",
		});
	}
};

exports.getListOfHotels = async (req, res) => {
	try {
		// Find all hotels where:
		// 1. hotelPhotos exist and is not empty
		// 2. activateHotel is true
		// 3. location coordinates are not [0, 0]
		const hotels = await HotelDetails.find({
			hotelPhotos: { $exists: true, $not: { $size: 0 } },
			activateHotel: true,
			"location.coordinates": { $ne: [0, 0] },
		});

		if (!hotels.length) {
			return res.status(404).json({
				message: "No hotels found with the specified criteria.",
			});
		}

		res.status(200).json(hotels);
	} catch (error) {
		console.error("Error fetching hotels:", error);
		res.status(500).json({
			error: "An error occurred while fetching hotels.",
		});
	}
};

exports.gettingRoomListFromQuery = async (req, res) => {
	try {
		const { query } = req.params;

		// Extract parameters from the query string
		// Assuming the query format is: startDate_endDate_roomType_adults_children_destination
		const [startDate, endDate, roomType, adults, children, destination] =
			query.split("_");

		// Validate the extracted parameters
		if (!startDate || !endDate || !roomType || !adults) {
			return res.status(400).json({
				error: "Invalid query parameters.",
			});
		}

		// Standardize certain destination names to handle variations
		const standardizedDestination = destination
			? destination.toLowerCase().replace(/madina[h]?/i, "madina")
			: null;

		// Define base hotel query to fetch only hotels that:
		// 1. Have hotelPhotos and is not empty.
		// 2. Are active (activateHotel is true).
		// 3. Have valid location coordinates (not [0, 0]).
		let hotelQuery = {
			activateHotel: true,
			hotelPhotos: { $exists: true, $not: { $size: 0 } },
			"location.coordinates": { $ne: [0, 0] },
		};

		// If destination is provided, add a case-insensitive, partial match on hotelState
		if (standardizedDestination) {
			hotelQuery.hotelState = {
				$regex: new RegExp(standardizedDestination, "i"),
			};
		}

		// If roomType is "all", don't filter by room type
		if (roomType !== "all") {
			// Add roomType filtering to the query
			hotelQuery["roomCountDetails.roomType"] = roomType;
		}

		// Fetch hotels matching the base query
		let hotels = await HotelDetails.find(hotelQuery);

		// Filter out only the relevant room types in roomCountDetails
		const filteredHotels = hotels.map((hotel) => {
			let filteredRoomCountDetails;

			if (roomType === "all") {
				// For "all", return all rooms that have photos and a base price greater than 0
				filteredRoomCountDetails = hotel.roomCountDetails.filter(
					(room) => room.photos.length > 0 && room.price.basePrice > 0
				);
			} else {
				// Otherwise, filter by the specific room type
				filteredRoomCountDetails = hotel.roomCountDetails.filter(
					(room) =>
						room.roomType === roomType &&
						room.photos.length > 0 &&
						room.price.basePrice > 0
				);
			}

			return {
				...hotel.toObject(),
				roomCountDetails: filteredRoomCountDetails,
			};
		});

		// Remove hotels that have no matching roomCountDetails after filtering
		const result = filteredHotels.filter(
			(hotel) => hotel.roomCountDetails.length > 0
		);

		// If no hotels match the criteria, return a 404
		if (!result.length) {
			return res.status(404).json({
				message: "No hotels found matching the criteria.",
			});
		}

		// Send the filtered hotels as the response
		res.status(200).json(result);
	} catch (error) {
		console.error("Error fetching hotels:", error);
		res.status(500).json({
			error: "An error occurred while fetching rooms.",
		});
	}
};

// Helper functions for generating and ensuring unique confirmation_number
function generateRandomNumber() {
	let randomNumber = Math.floor(1000000000 + Math.random() * 9000000000); // Generates a 10-digit number
	return randomNumber.toString();
}

function ensureUniqueNumber(model, fieldName, callback) {
	const randomNumber = generateRandomNumber();
	let query = {};
	query[fieldName] = randomNumber;

	model.findOne(query, (err, doc) => {
		if (err) {
			callback(err);
		} else if (doc) {
			// If number already exists, generate a new one
			ensureUniqueNumber(model, fieldName, callback);
		} else {
			callback(null, randomNumber); // Return unique number
		}
	});
}

exports.createNewReservationClient = async (req, res) => {
	try {
		const { hotelId, customerDetails, paymentDetails, belongsTo } = req.body;
		console.log(req.body, "req.bodyreq.bodyreq.body");
		// Validate hotelId
		const hotel = await HotelDetails.findOne({
			_id: hotelId,
			activateHotel: true,
			hotelPhotos: { $exists: true, $not: { $size: 0 } },
			"location.coordinates": { $ne: [0, 0] },
		});

		// Check if hotel exists and is active
		if (!hotel) {
			return res.status(400).json({
				message:
					"Error occurred, please contact Jannat Booking Customer Support In The Chat",
			});
		}

		// Validate customer details
		const { name, phone, email, passport, passportExpiry, nationality } =
			customerDetails;
		if (
			!name ||
			!phone ||
			!email ||
			!passport ||
			!passportExpiry ||
			!nationality
		) {
			return res.status(400).json({
				message: "Invalid customer details provided.",
			});
		}

		// Validate and hash/encrypt card details
		const { cardNumber, cardExpiryDate, cardCVV, cardHolderName } =
			paymentDetails;
		if (!cardNumber || !cardExpiryDate || !cardCVV || !cardHolderName) {
			return res.status(400).json({
				message: "Invalid payment details provided.",
			});
		}

		// Hash the card details (you can choose to encrypt them instead)
		const hashCardNumber = crypto
			.createHash("sha256")
			.update(cardNumber)
			.digest("hex");
		const hashCardExpiryDate = crypto
			.createHash("sha256")
			.update(cardExpiryDate)
			.digest("hex");
		const hashCardCVV = crypto
			.createHash("sha256")
			.update(cardCVV)
			.digest("hex");
		const hashCardHolderName = crypto
			.createHash("sha256")
			.update(cardHolderName)
			.digest("hex");

		// Generate a unique confirmation_number if not already provided
		if (!req.body.confirmation_number) {
			ensureUniqueNumber(
				Reservations,
				"confirmation_number",
				async (err, uniqueNumber) => {
					if (err) {
						return res
							.status(500)
							.json({ message: "Error generating confirmation number." });
					}
					req.body.confirmation_number = uniqueNumber;

					// Call function to save the reservation
					await saveReservation(
						req,
						res,
						hotelId,
						customerDetails,
						paymentDetails,
						belongsTo
					);
				}
			);
		} else {
			// If confirmation_number is provided, just save the reservation
			await saveReservation(
				req,
				res,
				hotelId,
				customerDetails,
				paymentDetails,
				belongsTo
			);
		}
	} catch (error) {
		console.error("Error creating reservation:", error);
		res.status(500).json({
			message: "An error occurred while creating the reservation",
		});
	}
};

// Helper function to save the reservation
async function saveReservation(
	req,
	res,
	hotelId,
	customerDetails,
	paymentDetails,
	belongsTo
) {
	// Create the new reservation
	const newReservation = new Reservations({
		hotelId,
		customer_details: {
			...customerDetails,
			cardNumber: crypto
				.createHash("sha256")
				.update(paymentDetails.cardNumber)
				.digest("hex"),
			cardExpiryDate: crypto
				.createHash("sha256")
				.update(paymentDetails.cardExpiryDate)
				.digest("hex"),
			cardCVV: crypto
				.createHash("sha256")
				.update(paymentDetails.cardCVV)
				.digest("hex"),
			cardHolderName: crypto
				.createHash("sha256")
				.update(paymentDetails.cardHolderName)
				.digest("hex"),
		},
		confirmation_number: req.body.confirmation_number,
		belongsTo, // Ensure this is correctly populated
		checkin_date: req.body.checkin_date,
		checkout_date: req.body.checkout_date,
		days_of_residence: req.body.days_of_residence,
		total_rooms: req.body.total_rooms,
		total_guests: req.body.total_guests,
		adults: req.body.adults,
		children: req.body.children,
		total_amount: req.body.total_amount,
		booking_source: req.body.booking_source,
		pickedRoomsType: req.body.pickedRoomsType, // Ensure rooms are correctly saved
		payment: req.body.payment, // Ensure payment status is saved
	});

	// Save the reservation to the database
	try {
		const savedReservation = await newReservation.save();
		res.status(201).json({
			message: "Reservation created successfully",
			data: savedReservation,
		});
	} catch (error) {
		console.error("Error saving reservation:", error);
		res.status(500).json({
			message: "An error occurred while saving the reservation",
		});
	}
}
