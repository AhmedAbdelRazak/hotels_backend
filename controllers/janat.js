const Janat = require("../models/janat");
const HotelDetails = require("../models/hotel_details");
const mongoose = require("mongoose");
const Reservations = require("../models/reservations"); // Assuming this is your reservations model
const crypto = require("crypto"); // For hashing or encrypting card details
const User = require("../models/user");
const axios = require("axios");
const jwt = require("jsonwebtoken");

require("dotenv").config();
const fetch = require("node-fetch");
const {
	ClientConfirmationEmail,
	SendingReservationLinkEmail,
	ReservationVerificationEmail,
} = require("./assets");
const puppeteer = require("puppeteer");
const sgMail = require("@sendgrid/mail");
const {
	encryptWithSecret,
	decryptWithSecret,
	verifyToken,
} = require("./utils");

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

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

		// If no hotel is found, return a 404 response
		if (!hotel) {
			return res.status(404).json({
				message: "No hotel found for the provided slug.",
			});
		}

		// Filter the roomCountDetails array to include only active rooms
		const filteredHotel = {
			...hotel.toObject(),
			roomCountDetails: hotel.roomCountDetails.filter(
				(room) => room.activeRoom
			),
		};

		// Send the filtered hotel data as the response
		res.status(200).json(filteredHotel);
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

		// Enhanced function to parse time strings and convert them to total minutes
		const parseTimeToMinutes = (timeStr) => {
			if (!timeStr || typeof timeStr !== "string") return Infinity;

			let totalMinutes = 0;
			const dayMatch = timeStr.match(/(\d+)\s*day[s]?/i);
			const hourMatch = timeStr.match(/(\d+)\s*hour[s]?/i);
			const minMatch = timeStr.match(/(\d+)\s*min[s]?/i);

			if (dayMatch) totalMinutes += parseInt(dayMatch[1], 10) * 1440; // 1 day = 1440 minutes
			if (hourMatch) totalMinutes += parseInt(hourMatch[1], 10) * 60; // 1 hour = 60 minutes
			if (minMatch) totalMinutes += parseInt(minMatch[1], 10); // minutes

			return totalMinutes;
		};

		// Sort hotels by hotelRating (highest to lowest) and then by walkingToElHaram distance
		const sortedHotels = hotels.sort((a, b) => {
			// Parse walking times
			const aWalkingTime = parseTimeToMinutes(a.distances?.walkingToElHaram);
			const bWalkingTime = parseTimeToMinutes(b.distances?.walkingToElHaram);

			// Sort by hotelRating first (descending order), then by walking distance (ascending order)
			if (b.hotelRating !== a.hotelRating) {
				return b.hotelRating - a.hotelRating; // Descending order for hotelRating
			}
			return aWalkingTime - bWalkingTime; // Ascending order for walking distance
		});

		// Log sorted hotels for debugging
		// console.log(
		// 	"Sorted Hotels:",
		// 	sortedHotels.map((hotel) => ({
		// 		name: hotel.hotelName,
		// 		rating: hotel.hotelRating,
		// 		walkingTime: hotel.distances?.walkingToElHaram,
		// 	}))
		// );

		// Send the sorted hotels as the response
		res.status(200).json(sortedHotels);
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
		const [startDate, endDate, roomType, adults, children, destination] =
			query.split("_");

		// Log extracted parameters
		console.log("Extracted Parameters:", {
			startDate,
			endDate,
			roomType,
			adults,
			children,
			destination,
		});

		// Validate the extracted parameters
		if (!startDate || !endDate || !roomType || !adults) {
			return res.status(400).json({
				error: "Invalid query parameters.",
			});
		}

		// Define base hotel query
		let hotelQuery = {
			activateHotel: true,
			hotelPhotos: { $exists: true, $not: { $size: 0 } },
			"location.coordinates": { $ne: [0, 0] },
		};

		// Add destination filter if provided
		if (destination) {
			const standardizedDestination = destination.toLowerCase();
			hotelQuery.$or = [
				{
					hotelState: {
						$regex: new RegExp(standardizedDestination, "i"), // Match destination in hotelState
					},
				},
				{
					hotelCity: {
						$regex: new RegExp(standardizedDestination, "i"), // Match destination in hotelCity
					},
				},
			];
			// Log destination-related query
			console.log("Destination Query Condition:", hotelQuery.$or);
		}

		// Add room type filter if not "all"
		if (roomType !== "all") {
			hotelQuery["roomCountDetails.roomType"] = roomType;
			// Log room type filter
			console.log("Room Type Filter:", hotelQuery["roomCountDetails.roomType"]);
		}

		// Fetch hotels matching the base query
		let hotels = await HotelDetails.find(hotelQuery);
		// Log initial query results
		console.log("Initial Query Results:", hotels.length, "hotels found");

		// Filter out relevant room types in roomCountDetails
		const filteredHotels = hotels.map((hotel) => {
			let filteredRoomCountDetails;

			// Filter room details based on type, availability, and activeRoom
			if (roomType === "all") {
				filteredRoomCountDetails = hotel.roomCountDetails.filter(
					(room) =>
						room.activeRoom === true && // Only include active rooms
						room.photos.length > 0 &&
						room.price.basePrice > 0
				);
			} else {
				filteredRoomCountDetails = hotel.roomCountDetails.filter(
					(room) =>
						room.roomType === roomType &&
						room.activeRoom === true && // Only include active rooms
						room.photos.length > 0 &&
						room.price.basePrice > 0
				);
			}

			// Return the hotel with updated roomCountDetails
			return {
				...hotel.toObject(),
				roomCountDetails: filteredRoomCountDetails,
			};
		});

		// Remove hotels that have no matching roomCountDetails after filtering
		const result = filteredHotels.filter(
			(hotel) => hotel.roomCountDetails.length > 0
		);

		// Log filtered results
		console.log("Filtered Hotels After Room Validation:", result.length);

		// If no hotels match the criteria, return a 404
		if (!result.length) {
			console.error("No hotels found matching the criteria.");
			return res.status(404).json({
				message: "No hotels found matching the criteria.",
			});
		}

		// Enhanced function to parse time strings and convert them to total minutes
		const parseTimeToMinutes = (timeStr) => {
			if (!timeStr || typeof timeStr !== "string") return Infinity;

			let totalMinutes = 0;
			const dayMatch = timeStr.match(/(\d+)\s*day[s]?/i);
			const hourMatch = timeStr.match(/(\d+)\s*hour[s]?/i);
			const minMatch = timeStr.match(/(\d+)\s*min[s]?/i);

			if (dayMatch) totalMinutes += parseInt(dayMatch[1], 10) * 1440; // 1 day = 1440 minutes
			if (hourMatch) totalMinutes += parseInt(hourMatch[1], 10) * 60; // 1 hour = 60 minutes
			if (minMatch) totalMinutes += parseInt(minMatch[1], 10); // minutes

			return totalMinutes;
		};

		// Sort hotels by hotelRating (highest to lowest) and then by walkingToElHaram distance
		const sortedHotels = result.sort((a, b) => {
			const aWalkingTime = parseTimeToMinutes(a.distances?.walkingToElHaram);
			const bWalkingTime = parseTimeToMinutes(b.distances?.walkingToElHaram);

			// Sort by hotelRating first (descending), then by walking distance (ascending)
			if (b.hotelRating !== a.hotelRating) {
				return b.hotelRating - a.hotelRating; // Descending order for hotelRating
			}
			return aWalkingTime - bWalkingTime; // Ascending order for walking distance
		});

		// Log sorted hotels
		// console.log(
		// 	"Sorted Hotels:",
		// 	sortedHotels.map((hotel) => ({
		// 		name: hotel.hotelName,
		// 		rating: hotel.hotelRating,
		// 		walkingTime: hotel.distances?.walkingToElHaram,
		// 	}))
		// );

		// Send the sorted hotels as the response
		res.status(200).json(sortedHotels);
	} catch (error) {
		console.error("Error fetching hotels:", error);
		res.status(500).json({
			error: "An error occurred while fetching rooms.",
		});
	}
};

// Helper functions for generating and ensuring unique confirmation_number
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

const createPdfBuffer = async (html) => {
	const browser = await puppeteer.launch({
		headless: true,
		args: [
			"--no-sandbox",
			"--disable-setuid-sandbox",
			"--disable-dev-shm-usage",
			"--disable-accelerated-2d-canvas",
			"--no-first-run",
			"--no-zygote",
			"--single-process",
			"--disable-gpu",
		],
	});

	const page = await browser.newPage();
	await page.setContent(html, { waitUntil: "networkidle0" });
	const pdfBuffer = await page.pdf({ format: "A4" });
	await browser.close();
	return pdfBuffer;
};

const sendEmailWithInvoice = async (reservationData, guestEmail) => {
	try {
		console.log("Recipient Email:", guestEmail);

		// Generate the email HTML content inside this function
		const emailHtmlContent = ClientConfirmationEmail(reservationData);

		// Generate the PDF from the email content
		const pdfBuffer = await createPdfBuffer(emailHtmlContent);

		// Email setup
		const emailOptions = {
			to: guestEmail || "ahmed.abdelrazak@jannatbooking.com", // Safe fallback
			from: "noreply@jannatbooking.com",
			bcc: [
				{ email: "morazzakhamouda@gmail.com" },
				{ email: "xhoteleg@gmail.com" },
				{ email: "ahmed.abdelrazak@jannatbooking.com" },
			],
			subject: "Reservation Confirmation - Invoice Attached",
			html: emailHtmlContent,
			attachments: [
				{
					content: pdfBuffer.toString("base64"),
					filename: "Reservation_Invoice.pdf",
					type: "application/pdf",
					disposition: "attachment",
				},
			],
		};

		await sgMail.send(emailOptions);
		console.log("Invoice email sent successfully.");
	} catch (error) {
		console.error("Error sending confirmation email with PDF:", error);
	}
};

exports.createNewReservationClient = async (req, res) => {
	try {
		const {
			hotelId,
			customerDetails,
			paymentDetails,
			belongsTo,
			userId,
			convertedAmounts,
		} = req.body;

		// Validate hotelId
		const hotel = await HotelDetails.findOne({
			_id: hotelId,
			activateHotel: true,
			hotelPhotos: { $exists: true, $not: { $size: 0 } },
			"location.coordinates": { $ne: [0, 0] },
		});

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
			return res
				.status(400)
				.json({ message: "Invalid customer details provided." });
		}

		// Check payment type
		if (req.body.payment === "Not Paid") {
			if (!email) {
				return res.status(201).json({
					message: "Reservation verified successfully.",
					data: {
						...reservationData,
						hotelName: reservationData.hotelName,
						usePassword: reservationData.usePassword,
					},
				});
			}

			// Generate a tokenized link containing the reservation data
			const tokenPayload = {
				...req.body,
			};

			// console.log(req.body, "req.body from not paid status");

			const token = jwt.sign(tokenPayload, process.env.JWT_SECRET2, {
				expiresIn: "3m", // Token expires in 3 minutes
			});

			const confirmationLink = `${process.env.CLIENT_URL}/reservation-verification?token=${token}`;

			// Send verification email
			const emailContent = ReservationVerificationEmail({
				name,
				hotelName: hotel.hotelName,
				confirmationLink,
			});

			try {
				await sgMail.send({
					to: email,
					from: "noreply@jannatbooking.com",
					bcc: [
						{ email: "morazzakhamouda@gmail.com" },
						{ email: "xhoteleg@gmail.com" },
						{ email: "ahmed.abdelrazak@jannatbooking.com" },
					],
					subject: "Verify Your Reservation",
					html: emailContent,
				});

				return res.status(200).json({
					message:
						"Verification email sent successfully. Please check your inbox.",
				});
			} catch (error) {
				console.error("Error sending verification email:", error);
				return res.status(500).json({
					message: "Failed to send verification email. Please try again later.",
				});
			}
		}

		// Process payment and create reservation for "Deposit Paid" or "Paid Online"
		const { cardNumber, cardExpiryDate, cardCVV, cardHolderName } =
			paymentDetails;

		if (!cardNumber || !cardExpiryDate || !cardCVV || !cardHolderName) {
			return res
				.status(400)
				.json({ message: "Invalid payment details provided." });
		}

		// Determine the amount in USD to process
		const amountInUSD =
			req.body.payment === "Deposit Paid"
				? convertedAmounts.depositUSD
				: convertedAmounts.totalUSD;

		const paymentResponse = await processPayment({
			amount: amountInUSD,
			cardNumber,
			expirationDate: cardExpiryDate,
			cardCode: cardCVV,
			customerDetails,
			checkinDate: req.body.checkin_date,
			checkoutDate: req.body.checkout_date,
			hotelName: hotel.hotelName,
		});

		if (!paymentResponse.success) {
			console.log("Payment failed:", paymentResponse.message);
			return res.status(400).json({
				message: paymentResponse.message || "Payment processing failed.",
			});
		}

		// Generate a unique confirmation number using ensureUniqueNumber
		let confirmationNumber = req.body.confirmation_number;

		if (!confirmationNumber) {
			confirmationNumber = await new Promise((resolve, reject) => {
				ensureUniqueNumber(
					Reservations, // The Mongoose model for reservations
					"confirmation_number", // The field in the database
					(err, uniqueNumber) => {
						if (err) {
							reject(new Error("Error generating confirmation number."));
						} else {
							resolve(uniqueNumber);
						}
					}
				);
			});
		} else {
			// Check if a reservation with the same confirmation number already exists
			const existingReservation = await Reservations.findOne({
				confirmation_number: confirmationNumber,
			});

			if (existingReservation) {
				console.log("Existing reservation found:", existingReservation);
				return res.status(400).json({
					message: "Reservation already exists. No further action required.",
				});
			}
		}

		// Assign the confirmation number to the request body for saving
		req.body.confirmation_number = confirmationNumber;

		await handleUserAndReservation(
			req,
			res,
			confirmationNumber,
			paymentResponse.response,
			convertedAmounts
		);
	} catch (error) {
		console.error("Error creating reservation:", error);
		res
			.status(500)
			.json({ message: "An error occurred while creating the reservation" });
	}
};

// Helper function to handle user creation or updating
async function handleUserAndReservation(
	req,
	res,
	confirmationNumber,
	paymentResponse,
	convertedAmounts
) {
	const { customerDetails } = req.body;

	try {
		// Check if the user already exists
		let user = await User.findOne({ email: customerDetails.email });
		if (!user && req.body.userId) {
			user = await User.findById(req.body.userId);
		}

		if (!user) {
			// Create a new user
			user = new User({
				name: customerDetails.name,
				email: customerDetails.email,
				phone: customerDetails.phone,
				password: customerDetails.password, // Ensure this is hashed in the User schema
			});

			// Save the new user
			await user.save();
			console.log("New user created:", user);
		}

		// Update the user's confirmationNumbersBooked field
		user.confirmationNumbersBooked = user.confirmationNumbersBooked || [];
		user.confirmationNumbersBooked.push(confirmationNumber);
		await user.save();
		console.log("User updated with new confirmation number:", user);

		// Save the reservation to the database
		await saveReservation(
			req,
			res,
			req.body.hotelId,
			customerDetails,
			req.body.paymentDetails,
			req.body.belongsTo,
			paymentResponse,
			convertedAmounts
		);
	} catch (error) {
		console.error("Error handling user creation/update:", error);
		res.status(500).json({
			message: "An error occurred while handling user creation/update",
		});
	}
}

// Helper function to save the reservation
async function saveReservation(
	req,
	res,
	hotelId,
	customerDetails,
	paymentDetails,
	belongsTo,
	paymentResponse,
	convertedAmounts
) {
	const enrichedPaymentDetails = {
		...paymentResponse,
		amountInSAR: req.body.paid_amount,
		amountInUSD:
			req.body.payment === "Deposit Paid"
				? convertedAmounts.depositUSD
				: convertedAmounts.totalUSD,
	};

	// Create the new reservation
	const newReservation = new Reservations({
		hotelId,
		customer_details: {
			...customerDetails,
			cardNumber: encryptWithSecret(paymentDetails.cardNumber),
			cardExpiryDate: encryptWithSecret(paymentDetails.cardExpiryDate),
			cardCVV: encryptWithSecret(paymentDetails.cardCVV),
			cardHolderName: encryptWithSecret(paymentDetails.cardHolderName),
			password: encryptWithSecret(req.body.usePassword),
			confirmPassword: encryptWithSecret(req.body.usePassword),
		},
		confirmation_number: req.body.confirmation_number,
		belongsTo,
		checkin_date: req.body.checkin_date,
		checkout_date: req.body.checkout_date,
		days_of_residence: req.body.days_of_residence,
		total_rooms: req.body.total_rooms,
		total_guests: req.body.total_guests,
		adults: req.body.adults,
		children: req.body.children,
		total_amount: req.body.total_amount,
		booking_source: req.body.booking_source,
		pickedRoomsType: req.body.pickedRoomsType,
		payment: req.body.payment,
		paid_amount: Number(req.body.paid_amount).toFixed(2),
		commission: Number(req.body.commission).toFixed(2),
		commissionPaid: req.body.commissionPaid,
		guestAgreedOnTermsAndConditions: req.body.guestAgreedOnTermsAndConditions,
		payment_details: enrichedPaymentDetails,
		hotelName: req.body.hotelName,
		hazent: req.body.usePassword,
	});

	try {
		// Save the reservation
		const savedReservation = await newReservation.save();

		// Fetch the hotel details using the `hotelId`
		const hotel = await HotelDetails.findById(hotelId).exec();

		if (!hotel) {
			return res.status(404).json({ message: "Hotel not found" });
		}

		// Generate and send the email with hotel data
		const reservationData = {
			...savedReservation.toObject(),
			hotelName: hotel.hotelName,
			hotelAddress: hotel.hotelAddress,
			hotelCity: hotel.hotelCity,
			hotelPhone: hotel.phone,
		};

		await sendEmailWithInvoice(reservationData, customerDetails.email);

		// Send success response
		res.status(201).json({
			message: "Reservation created successfully",
			data: savedReservation,
			data2: req.body,
		});
	} catch (error) {
		console.error("Error saving reservation:", error);
		res.status(500).json({
			message: "An error occurred while saving the reservation",
		});
	}
}

// Payment processing function
async function processPayment({
	amount,
	cardNumber,
	expirationDate,
	cardCode,
	customerDetails,
	checkinDate,
	checkoutDate,
	hotelName,
}) {
	try {
		// Select the correct credentials and endpoint
		const isProduction = process.env.AUTHORIZE_NET_ENV === "production";

		console.log(customerDetails, "customerDetails from process payment");

		const apiLoginId = isProduction
			? process.env.API_LOGIN_ID
			: process.env.API_LOGIN_ID_SANDBOX;

		const transactionKey = isProduction
			? process.env.TRANSACTION_KEY
			: process.env.TRANSACTION_KEY_SANDBOX;

		const endpoint = isProduction
			? "https://api.authorize.net/xml/v1/request.api"
			: "https://apitest.authorize.net/xml/v1/request.api";

		// Remove spaces from the card number
		const sanitizedCardNumber = cardNumber.replace(/\s+/g, "");
		const formattedAmount = parseFloat(amount).toFixed(2);

		console.log("Using API Endpoint:", endpoint);
		console.log("API Login ID:", apiLoginId);

		// Construct the payload
		const payload = {
			createTransactionRequest: {
				merchantAuthentication: {
					name: apiLoginId,
					transactionKey: transactionKey,
				},
				transactionRequest: {
					transactionType: "authCaptureTransaction",
					amount: formattedAmount,
					payment: {
						creditCard: {
							cardNumber: sanitizedCardNumber,
							expirationDate: expirationDate,
							cardCode: cardCode,
						},
					},
					billTo: {
						firstName: customerDetails.name.split(" ")[0] || "",
						lastName: customerDetails.name.split(" ")[1] || "",
						address: customerDetails.address || "N/A",
						city: customerDetails.city || "N/A",
						state: customerDetails.state || "N/A",
						zip: customerDetails.postalCode || "00000",
						country: customerDetails.nationality || "US",
						email: customerDetails.email || "",
					},
					userFields: {
						userField: [
							{ name: "checkin_date", value: checkinDate },
							{ name: "checkout_date", value: checkoutDate },
							{ name: "hotel_name", value: hotelName },
						],
					},
				},
			},
		};

		// Send the request to Authorize.Net
		const response = await axios.post(endpoint, payload, {
			headers: { "Content-Type": "application/json" },
		});

		const responseData = response.data;

		// Check for a successful transaction
		if (
			responseData.messages.resultCode === "Ok" &&
			responseData.transactionResponse &&
			responseData.transactionResponse.messages
		) {
			return {
				success: true,
				transactionId: responseData.transactionResponse.transId,
				message: responseData.transactionResponse.messages[0].description,
				response: responseData,
			};
		} else {
			// Handle errors
			const errorText =
				responseData.transactionResponse?.errors?.[0]?.errorText ||
				responseData.messages.message[0].text ||
				"Transaction failed.";
			return { success: false, message: errorText };
		}
	} catch (error) {
		// Log and handle general errors
		console.error("Payment Processing Error:", error.message || error);
		return { success: false, message: "Payment processing error." };
	}
}

exports.verifyReservationToken = async (req, res) => {
	try {
		const { token } = req.body;

		if (!token) {
			return res.status(400).json({
				message: "No token provided. Please try reserving again.",
			});
		}

		// Verify the token
		const { valid, expired, decoded } = verifyToken(token);

		if (!valid) {
			if (expired) {
				return res.status(401).json({
					message:
						"The reservation link has expired. Please try reserving again.",
				});
			}
			return res.status(400).json({
				message: "Invalid token. Please try reserving again.",
			});
		}

		// Token is valid, extract the reservation data
		let reservationData = decoded;

		// Parse the check-in date from the reservation data
		const checkinDate = new Date(reservationData.checkin_date);

		// Check for exact duplicate reservations (same customer details and exact check-in date)
		const exactDuplicate = await Reservations.findOne({
			"customer_details.name": reservationData.customerDetails.name,
			"customer_details.email": reservationData.customerDetails.email,
			"customer_details.phone": reservationData.customerDetails.phone,
			checkin_date: reservationData.checkin_date,
		});

		if (exactDuplicate) {
			console.log("Exact duplicate found:", exactDuplicate);
			return res.status(400).json({
				message:
					"It looks like we have duplicate reservations. Please contact customer service in the chat.",
			});
		}

		// Check for partial duplicate reservations within the same or next month (based on check-in date)
		const startOfSameMonth = new Date(
			checkinDate.getFullYear(),
			checkinDate.getMonth(),
			1
		); // Start of the same month
		const endOfNextMonth = new Date(
			checkinDate.getFullYear(),
			checkinDate.getMonth() + 2, // Move to the next month
			0 // Last day of the next month
		);

		// Find reservations with overlapping check-in dates within the same or next month, and matching customer details
		const partialDuplicate = await Reservations.findOne({
			"customer_details.name": reservationData.customerDetails.name,
			"customer_details.email": reservationData.customerDetails.email,
			"customer_details.phone": reservationData.customerDetails.phone,
			checkin_date: {
				$gte: startOfSameMonth,
				$lt: endOfNextMonth,
			},
		});

		if (partialDuplicate) {
			console.log("Partial duplicate found:", partialDuplicate);
			return res.status(400).json({
				message:
					"It looks like we have duplicate reservations. Please contact customer service in the chat.",
			});
		}

		// Check for duplicate reservations based on email OR phone within the same month of createdAt
		const today = new Date();
		const thirtyDaysAgo = new Date(today);
		thirtyDaysAgo.setDate(today.getDate() - 30); // Go back 30 days

		const duplicateByEmailOrPhone = await Reservations.findOne({
			$or: [
				{ "customer_details.email": reservationData.customerDetails.email },
				{ "customer_details.phone": reservationData.customerDetails.phone },
			],
			createdAt: {
				$gte: thirtyDaysAgo, // Created within the last 30 days
				$lte: today, // Created up to today
			},
		});

		if (duplicateByEmailOrPhone) {
			console.log(
				"Duplicate by email or phone found:",
				duplicateByEmailOrPhone
			);
			return res.status(400).json({
				message:
					"A similar reservation has been made recently. Please contact customer service in the chat.",
			});
		}

		// Ensure a unique confirmation number
		let confirmationNumber = reservationData.confirmation_number;

		if (!confirmationNumber) {
			confirmationNumber = await new Promise((resolve, reject) => {
				ensureUniqueNumber(
					Reservations,
					"confirmation_number",
					(err, uniqueNumber) => {
						if (err) {
							reject(new Error("Error generating confirmation number."));
						} else {
							resolve(uniqueNumber);
						}
					}
				);
			});
			reservationData.confirmation_number = confirmationNumber;
		} else {
			// Check if a reservation with the same confirmation number already exists
			const existingReservation = await Reservations.findOne({
				confirmation_number: confirmationNumber,
			});

			if (existingReservation) {
				console.log("Existing reservation found:", existingReservation);
				return res.status(400).json({
					message: "Reservation already exists. No further action required.",
				});
			}
		}

		// Override payment details with empty values for "Not Paid" reservations
		reservationData.paymentDetails = {
			cardNumber: "",
			cardExpiryDate: "",
			cardCVV: "",
			cardHolderName: "",
		};

		reservationData.paid_amount = 0;
		reservationData.payment = "Not Paid";
		reservationData.commission = 0;
		reservationData.commissionPaid = false;

		// Call the handleUserAndReservation function to create the user and reservation document
		req.body = reservationData;

		console.log(reservationData, "reservationData from not paid status");

		await handleUserAndReservation(
			req,
			res,
			confirmationNumber,
			{}, // No payment response for "Not Paid"
			reservationData.convertedAmounts
		);
	} catch (error) {
		console.error("Error verifying reservation token:", error);
		return res.status(500).json({
			message: "An error occurred while verifying the reservation token.",
		});
	}
};

exports.getUserAndReservationData = async (req, res) => {
	try {
		const userId = req.params.userId;

		// Fetch user data
		const user = await User.findById(userId);

		if (!user) {
			return res.status(404).json({ error: "User not found" });
		}

		// Fetch reservations using confirmationNumbersBooked in user data
		const reservations = await Reservations.find({
			confirmation_number: { $in: user.confirmationNumbersBooked },
		}).populate("hotelId"); // Ensure hotelId is populated for reference

		// Loop through reservations to add images to pickedRoomsType
		for (let reservation of reservations) {
			if (reservation.hotelId) {
				// Fetch hotel details
				const hotelDetails = await HotelDetails.findById(reservation.hotelId);

				if (hotelDetails) {
					// Add images to pickedRoomsType
					reservation.pickedRoomsType = reservation.pickedRoomsType.map(
						(room) => {
							const matchingRoom = hotelDetails.roomCountDetails.find(
								(detail) =>
									detail.displayName === room.displayName &&
									detail.roomType === room.room_type
							);

							if (matchingRoom && matchingRoom.photos.length > 0) {
								room.image = matchingRoom.photos[0].url; // Assign the first image URL
							} else {
								room.image = "/default-room.jpg"; // Fallback image
							}

							return room;
						}
					);
				}
			}
		}

		res.json({
			user: {
				_id: user._id,
				name: user.name,
				email: user.email,
			},
			reservations,
		});
	} catch (error) {
		console.error("Error fetching user and reservation data:", error);
		res.status(500).json({ error: "An error occurred while fetching data" });
	}
};

exports.getHotelDetailsById = async (req, res) => {
	try {
		// Extract hotelId from request parameters
		const { hotelId } = req.params;

		// Validate the hotelId
		if (!mongoose.Types.ObjectId.isValid(hotelId)) {
			return res.status(400).json({
				error: "Invalid hotel ID provided",
			});
		}

		// Fetch the hotel details from the database
		const hotel = await HotelDetails.findById(hotelId);

		// Check if hotel exists
		if (!hotel) {
			return res.status(404).json({
				message: "Hotel not found",
			});
		}

		// Return hotel details as the response
		res.status(200).json(hotel);
	} catch (error) {
		console.error("Error fetching hotel details:", error);
		res.status(500).json({
			error: "An error occurred while fetching the hotel details",
		});
	}
};

exports.getHotelDistancesFromElHaram = async (req, res) => {
	try {
		const elHaramCoordinates = [39.8262, 21.4225]; // Coordinates for Al-Masjid al-Haram (longitude, latitude)

		// Find all hotels with valid coordinates (not [0, 0])
		const hotels = await HotelDetails.find({
			"location.coordinates": { $ne: [0, 0] },
		});

		if (hotels.length === 0) {
			return res
				.status(200)
				.json({ message: "No hotels with valid coordinates found" });
		}

		const apiKey = process.env.GOOGLE_MAPS_API_KEY; // Ensure your API key is set in environment variables

		// Iterate over each hotel and calculate distances
		for (let hotel of hotels) {
			// Clear existing distances
			hotel.distances = {};

			const [hotelLongitude, hotelLatitude] = hotel.location.coordinates;

			// Construct API URLs for walking and driving
			const walkingUrl = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${hotelLatitude},${hotelLongitude}&destinations=${elHaramCoordinates[1]},${elHaramCoordinates[0]}&mode=walking&key=${apiKey}`;
			const drivingUrl = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${hotelLatitude},${hotelLongitude}&destinations=${elHaramCoordinates[1]},${elHaramCoordinates[0]}&mode=driving&key=${apiKey}`;

			// Make API calls for walking and driving distances
			const walkingResponse = await axios.get(walkingUrl);
			const drivingResponse = await axios.get(drivingUrl);

			const walkingData = walkingResponse.data;
			const drivingData = drivingResponse.data;

			// Extract distance information from API responses
			const walkingElement = walkingData.rows?.[0]?.elements?.[0];
			const drivingElement = drivingData.rows?.[0]?.elements?.[0];

			// Update hotel distances based on API response
			if (walkingElement && walkingElement.status === "OK") {
				hotel.distances.walkingToElHaram = walkingElement.duration.text;
			} else {
				hotel.distances.walkingToElHaram = "N/A";
			}

			if (drivingElement && drivingElement.status === "OK") {
				hotel.distances.drivingToElHaram = drivingElement.duration.text;
			} else {
				hotel.distances.drivingToElHaram = "N/A";
			}

			// Save the updated hotel information
			await hotel.save();
		}

		// Respond with success message
		res.status(200).json({
			message: "Distances recalculated and updated successfully for all hotels",
		});
	} catch (error) {
		console.error("Error updating hotel distances:", error);
		res
			.status(500)
			.json({ error: "An error occurred while recalculating hotel distances" });
	}
};

exports.gettingCurrencyConversion = (req, res) => {
	const amountInSAR = req.params.saudimoney; // Expect a comma-separated string, e.g., "59.50,595.00"

	// Split the amounts for conversion
	const amounts = amountInSAR.split(",").map((amount) => parseFloat(amount));

	// Validate input
	if (!amounts.length || amounts.some((amount) => isNaN(amount))) {
		return res.status(400).json({ error: "Invalid amount(s) provided" });
	}

	// Base API URL
	const baseUrl = `https://v6.exchangerate-api.com/v6/${process.env.EXCHANGE_RATE}/pair/SAR/USD/`;

	// Fetch conversions for all amounts
	Promise.all(
		amounts.map((amount) =>
			fetch(`${baseUrl}${amount}`)
				.then((response) => response.json())
				.then((data) => {
					if (data.result === "success") {
						return {
							amountInSAR: amount,
							conversionRate: data.conversion_rate,
							amountInUSD: data.conversion_result,
						};
					} else {
						throw new Error("Currency conversion failed");
					}
				})
		)
	)
		.then((results) => {
			res.json(results); // Respond with the converted results
		})
		.catch((error) => {
			res.status(500).json({ error: error.message });
		});
};

exports.getCurrencyRates = async (req, res) => {
	try {
		const baseUrl = `https://v6.exchangerate-api.com/v6/${process.env.EXCHANGE_RATE}/pair/SAR/`;

		// Fetch conversion rates for USD and EUR
		const [usdResponse, eurResponse] = await Promise.all([
			fetch(`${baseUrl}USD`),
			fetch(`${baseUrl}EUR`),
		]);

		// Parse JSON responses
		const usdData = await usdResponse.json();
		const eurData = await eurResponse.json();

		// Check for successful responses
		if (usdData.result !== "success" || eurData.result !== "success") {
			return res.status(500).json({ error: "Failed to fetch currency rates" });
		}

		// Construct rates object
		const rates = {
			SAR_USD: usdData.conversion_rate,
			SAR_EUR: eurData.conversion_rate,
		};

		// Respond with rates
		res.json(rates);
	} catch (error) {
		console.error("Error fetching currency rates:", error);
		res.status(500).json({ error: "An error occurred while fetching rates" });
	}
};

exports.gettingByReservationId = async (req, res) => {
	try {
		// Extract reservationId from request parameters
		const { reservationId } = req.params;

		// Find the reservation by confirmation_number
		const reservation = await Reservations.findOne({
			confirmation_number: reservationId,
		});

		// If reservation not found, return a 404 error
		if (!reservation) {
			return res
				.status(404)
				.json({ message: "Reservation not found. Please check the ID." });
		}

		// Decrypt card information
		const decryptedReservation = {
			...reservation.toObject(),
			customer_details: {
				...reservation.customer_details,
				cardNumber: decryptWithSecret(reservation.customer_details.cardNumber),
				cardExpiryDate: decryptWithSecret(
					reservation.customer_details.cardExpiryDate
				),
				cardCVV: decryptWithSecret(reservation.customer_details.cardCVV),
				cardHolderName: decryptWithSecret(
					reservation.customer_details.cardHolderName
				),
			},
		};

		// Return the reservation with decrypted details
		return res.status(200).json(decryptedReservation);
	} catch (error) {
		// Log the error and send a 500 response
		console.error("Error fetching reservation:", error.message || error);
		return res.status(500).json({
			message:
				"An internal server error occurred while fetching the reservation.",
		});
	}
};

exports.paginatedReservationList = async (req, res) => {
	try {
		// Extract query parameters for pagination
		const { page = 1, limit = 100 } = req.query;

		// Convert page and limit to integers
		const pageNumber = parseInt(page, 10);
		const pageSize = parseInt(limit, 10);

		// Define case-insensitive filters for booking_source
		const filter = {
			$or: [
				{ booking_source: { $regex: /^online jannat booking$/i } }, // Match "online jannat booking" (case-insensitive)
				{ booking_source: { $regex: /^generated link$/i } }, // Match "Generated Link" (case-insensitive)
			],
		};

		// Count total documents for pagination
		const totalDocuments = await Reservations.countDocuments(filter);

		// Fetch paginated reservations, sorted by createdAt (newest first)
		const reservations = await Reservations.find(filter)
			.sort({ createdAt: -1 }) // Sort newest to oldest
			.skip((pageNumber - 1) * pageSize) // Pagination offset
			.limit(pageSize) // Limit results to page size
			.populate("belongsTo") // Populate belongsTo (User model), selecting only name and email
			.populate("hotelId"); // Populate hotelId (HotelDetails model), selecting only name and address

		// Return response with reservations and total count
		return res.status(200).json({
			success: true,
			data: reservations,
			totalDocuments, // Total document count for frontend pagination
			currentPage: pageNumber,
			totalPages: Math.ceil(totalDocuments / pageSize),
		});
	} catch (error) {
		console.error("Error fetching paginated reservations:", error.message);
		return res.status(500).json({
			success: false,
			message: "An error occurred while fetching reservations",
		});
	}
};

exports.sendingEmailForPaymentLink = async (req, res) => {
	try {
		const {
			hotelName,
			name,
			email,
			phone,
			nationality,
			checkInDate,
			checkOutDate,
			numberOfNights,
			adults,
			children,
			totalAmount,
			totalCommission,
			generatedLink,
			selectedRooms,
			agentName,
			depositPercentage,
		} = req.body;
		console.log(req.body, "req.bodyreq.body");
		// Validate required fields
		if (
			!hotelName ||
			!name ||
			!email ||
			!checkInDate ||
			!checkOutDate ||
			!numberOfNights ||
			!totalAmount ||
			!generatedLink
		) {
			return res
				.status(400)
				.json({ error: "Missing required email parameters." });
		}

		// Parse numeric fields
		const parsedTotalAmount = parseFloat(totalAmount);
		const parsedTotalCommission = parseFloat(totalCommission);
		const parsedDepositAmount = (
			parsedTotalAmount *
			(depositPercentage / 100)
		).toFixed(2);

		// Generate email content
		const emailHtmlContent = SendingReservationLinkEmail({
			hotelName,
			name,
			agentName,
			depositPercentage,
			wholeAmount: parsedTotalAmount,
			confirmationLink: generatedLink,
		});

		// Send email using SendGrid
		const emailOptions = {
			to: email,
			from: "noreply@jannatbooking.com",
			bcc: [
				{ email: "morazzakhamouda@gmail.com" },
				{ email: "xhoteleg@gmail.com" },
				{ email: "ahmed.abdelrazak@jannatbooking.com" },
			],
			subject: `${hotelName} | Reservation Confirmation Link`,
			html: emailHtmlContent,
		};

		await sgMail.send(emailOptions);

		// Log email payload for debugging
		console.log("Email sent with the following details:", {
			hotelName,
			name,
			email,
			phone,
			nationality,
			checkInDate,
			checkOutDate,
			numberOfNights,
			adults,
			children,
			totalAmount: parsedTotalAmount,
			totalCommission: parsedTotalCommission,
			depositAmount: parsedDepositAmount,
			generatedLink,
			selectedRooms,
			agentName,
		});

		res.status(200).json({ message: "Email sent successfully." });
	} catch (error) {
		console.error("Error sending email for payment link:", error);
		res
			.status(500)
			.json({ error: "An error occurred while sending the email." });
	}
};
