const Janat = require("../models/janat");
const HotelDetails = require("../models/hotel_details");
const mongoose = require("mongoose");
const Reservations = require("../models/reservations"); // Assuming this is your reservations model
const crypto = require("crypto"); // For hashing or encrypting card details
const User = require("../models/user");
const axios = require("axios");
const jwt = require("jsonwebtoken");
const CustomerList = require("../models/customerlist");

require("dotenv").config();
const fetch = require("node-fetch");
const {
	ClientConfirmationEmail,
	SendingReservationLinkEmail,
	ReservationVerificationEmail,
	SendingReservationLinkEmailTrigger,
	paymentTriggered,
} = require("./assets");
const {
	ensureE164Phone,
	waSendReservationConfirmation,
	waSendVerificationLink,
	waSendPaymentLink,
	waSendReservationUpdate,
	waNotifyNewReservation,
} = require("./whatsappsender");

const puppeteer = require("puppeteer");
const sgMail = require("@sendgrid/mail");
const {
	encryptWithSecret,
	decryptWithSecret,
	verifyToken,
} = require("./utils");

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

async function getHotelAndOwner(hotelId) {
	if (!hotelId || !mongoose.Types.ObjectId.isValid(hotelId)) {
		return { hotel: null, owner: null };
	}

	const hotel = await HotelDetails.findById(hotelId)
		.populate({ path: "belongsTo", select: "_id email role name" })
		.lean()
		.exec();

	const owner = hotel && hotel.belongsTo ? hotel.belongsTo : null;
	return { hotel, owner };
}

/**
 * Send a critical email directly to the hotel owner (not BCC).
 * If sending fails, throws an error so the caller can log/handle if needed.
 */
async function sendCriticalOwnerEmail(to, subject, html) {
	if (!to) return;
	await sgMail.send({
		to,
		cc: "ahmed.abdelrazak@jannatbooking.com",
		from: "noreply@jannatbooking.com",
		subject,
		html,
	});
}

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

exports.listOfAllActiveHotelsMonthlyAndOffers = async (req, res) => {
	try {
		// Optional switches: default off to preserve existing behavior
		const validOnly =
			String(req.query.validOnly || "false").toLowerCase() === "true";
		const requireActiveRoom =
			String(req.query.activeRoom || "false").toLowerCase() === "true";

		// Base query: same gates as listOfAllActiveHotels + require rooms that have offers or monthly
		const hotels = await HotelDetails.find({
			activateHotel: true,
			hotelPhotos: { $exists: true, $not: { $size: 0 } },
			"location.coordinates": { $ne: [0, 0] },
			roomCountDetails: {
				$elemMatch: {
					"price.basePrice": { $gt: 0 },
					// ensure room has photos
					"photos.0": { $exists: true },
					// require either offers or monthly to exist
					$or: [
						{ "offers.0": { $exists: true } },
						{ "monthly.0": { $exists: true } },
					],
				},
			},
		})
			.lean()
			.exec();

		const now = new Date();

		const filtered = hotels
			.map((hotel) => {
				const onlyRoomsWithDeals = (hotel.roomCountDetails || [])
					.filter((room) => {
						// keep same gates as your base list
						if (requireActiveRoom && room.activeRoom !== true) return false;
						const hasBasePrice = room?.price?.basePrice > 0;
						const hasPhotos =
							Array.isArray(room.photos) && room.photos.length > 0;
						if (!hasBasePrice || !hasPhotos) return false;

						const offersAll = Array.isArray(room.offers) ? room.offers : [];
						const monthlyAll = Array.isArray(room.monthly) ? room.monthly : [];

						const offers = validOnly
							? offersAll.filter((o) => {
									const from = new Date(o.offerFrom);
									const to = new Date(o.offerTo);
									return !isNaN(from) && !isNaN(to) && from <= now && now <= to;
							  })
							: offersAll;

						const monthly = validOnly
							? monthlyAll.filter((m) => {
									const from = new Date(m.monthFrom);
									const to = new Date(m.monthTo);
									return !isNaN(from) && !isNaN(to) && from <= now && now <= to;
							  })
							: monthlyAll;

						// must have at least one qualifying offer/monthly
						return offers.length > 0 || monthly.length > 0;
					})
					.map((room) => {
						if (!validOnly) return room;

						// when validOnly=true, trim the arrays to only valid ranges
						const offersAll = Array.isArray(room.offers) ? room.offers : [];
						const monthlyAll = Array.isArray(room.monthly) ? room.monthly : [];

						const offers = offersAll.filter((o) => {
							const from = new Date(o.offerFrom);
							const to = new Date(o.offerTo);
							return !isNaN(from) && !isNaN(to) && from <= now && now <= to;
						});
						const monthly = monthlyAll.filter((m) => {
							const from = new Date(m.monthFrom);
							const to = new Date(m.monthTo);
							return !isNaN(from) && !isNaN(to) && from <= now && now <= to;
						});

						return { ...room, offers, monthly };
					});

				return { ...hotel, roomCountDetails: onlyRoomsWithDeals };
			})
			// only keep hotels that still have at least one qualifying room
			.filter((h) => (h.roomCountDetails || []).length > 0);

		return res.status(200).json(filtered);
	} catch (err) {
		console.error("Error fetching hotels with monthly/offers:", err);
		return res.status(500).json({
			error:
				"An error occurred while fetching active hotels with monthly/offers.",
		});
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

exports.sendEmailForTriggeringPayment = async (req, res) => {
	try {
		console.log("Received Request Body:", req.body);
		const { userId } = req.params;
		const { reservationId, amountInSAR } = req.body;

		if (!reservationId || !amountInSAR) {
			return res
				.status(400)
				.json({ message: "Reservation ID and amount in SAR are required." });
		}
		if (isNaN(amountInSAR) || Number(amountInSAR) <= 0) {
			return res
				.status(400)
				.json({ message: "Amount in SAR must be a positive number." });
		}

		const reservation = await Reservations.findById(reservationId)
			.populate("hotelId")
			.exec();

		if (!reservation) {
			return res.status(404).json({ message: "Reservation not found." });
		}

		const hotelName = reservation.hotelId?.hotelName || "Jannat Booking";
		const guestName = reservation.customer_details?.name || "Valued Guest";
		const confirmationNumber = reservation.confirmation_number;
		const totalAmountSAR = reservation.total_amount;

		if (!confirmationNumber) {
			return res.status(400).json({
				message: "Confirmation number is missing in the reservation.",
			});
		}

		const confirmationLink = `${process.env.CLIENT_URL}/client-payment-triggering/${reservationId}/${confirmationNumber}/${amountInSAR}`;

		const emailHtmlContent = SendingReservationLinkEmailTrigger({
			hotelName,
			name: guestName,
			confirmationLink,
			amountInSAR,
			totalAmountSAR,
		});

		const emailOptions = {
			to: reservation.customer_details.email,
			from: "noreply@jannatbooking.com",
			subject: "Payment Confirmation Required - Jannat Booking",
			html: emailHtmlContent,
		};

		const emailOptions2 = {
			to: [
				{ email: "morazzakhamouda@gmail.com" },
				{ email: "xhoteleg@gmail.com" },
				{ email: "ahmed.abdelrazak@jannatbooking.com" },
			],
			from: "noreply@jannatbooking.com",
			subject: "Payment Confirmation Required - Jannat Booking",
			html: emailHtmlContent,
		};

		await sgMail.send(emailOptions);
		await sgMail.send(emailOptions2);

		// ---- WhatsApp: payment link to guest ----
		try {
			await waSendPaymentLink(reservation, confirmationLink);
		} catch (waErr) {
			console.error(
				"[WA] sendEmailForTriggeringPayment:",
				waErr?.message || waErr
			);
		}

		return res
			.status(200)
			.json({ message: "Confirmation email sent successfully." });
	} catch (error) {
		console.error("Error sending confirmation email:", error);
		if (error.response && error.response.body && error.response.body.errors) {
			const sgErrors = error.response.body.errors
				.map((err) => err.message)
				.join(" ");
			return res.status(500).json({ message: `SendGrid Error: ${sgErrors}` });
		}
		return res
			.status(500)
			.json({ message: "Failed to send confirmation email." });
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

const sendEmailWithInvoice = async (
	reservationData,
	guestEmail,
	hotelIdOrNull
) => {
	try {
		const html = ClientConfirmationEmail(reservationData);

		// Generate attached PDF invoice
		const pdfBuffer = await createPdfBuffer(html);

		// 1) Send to Guest
		await sgMail.send({
			to: guestEmail || "ahmed.abdelrazak20@gmail.com", // fallback
			from: "noreply@jannatbooking.com",
			subject: "Reservation Confirmation - Invoice Attached",
			html,
			attachments: [
				{
					content: pdfBuffer.toString("base64"),
					filename: "Reservation_Invoice.pdf",
					type: "application/pdf",
					disposition: "attachment",
				},
			],
		});

		// 2) Send to Internal Staff
		await sgMail.send({
			to: [
				{ email: "morazzakhamouda@gmail.com" },
				{ email: "xhoteleg@gmail.com" },
				{ email: "ahmed.abdelrazak@jannatbooking.com" },
			],
			from: "noreply@jannatbooking.com",
			subject: "Reservation Confirmation - Invoice Attached",
			html,
			attachments: [
				{
					content: pdfBuffer.toString("base64"),
					filename: "Reservation_Invoice.pdf",
					type: "application/pdf",
					disposition: "attachment",
				},
			],
		});

		// 3) Send **separately** to the Hotel Owner (guaranteed via populate)
		const resolvedHotelId =
			reservationData?.hotelId?._id ||
			reservationData?.hotelId ||
			hotelIdOrNull;

		if (resolvedHotelId && mongoose.Types.ObjectId.isValid(resolvedHotelId)) {
			const { owner } = await getHotelAndOwner(resolvedHotelId);
			const ownerEmail = owner?.email || null;

			if (ownerEmail) {
				await sendCriticalOwnerEmail(
					ownerEmail,
					"Reservation Confirmation - Invoice Attached",
					html
				);
			}
		}

		console.log("Invoice email(s) sent successfully (guest, staff, owner).");
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

		const { owner } = await getHotelAndOwner(hotelId);
		const ownerEmail = owner?.email || null;

		const { name, phone, email, passport, passportExpiry, nationality } =
			customerDetails || {};
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

		// ========== Not Paid => send verification ==========
		if (req.body.payment === "Not Paid") {
			if (!email) {
				return res.status(201).json({
					message: "Reservation verified successfully.",
					data: {
						...req.body,
						hotelName: hotel.hotelName,
						usePassword: req.body.usePassword,
					},
				});
			}

			const tokenPayload = { ...req.body };
			const token = jwt.sign(tokenPayload, process.env.JWT_SECRET2, {
				expiresIn: "3d",
			});

			const confirmationLink = `${process.env.CLIENT_URL}/reservation-verification?token=${token}`;

			const emailContent = ReservationVerificationEmail({
				name,
				hotelName: hotel.hotelName,
				confirmationLink,
			});

			const bccList = [
				"morazzakhamouda@gmail.com",
				"xhoteleg@gmail.com",
				"ahmed.abdelrazak@jannatbooking.com",
			];

			try {
				// Guest email
				await sgMail.send({
					to: email,
					from: "noreply@jannatbooking.com",
					subject: "Verify Your Reservation",
					html: emailContent,
					bcc: bccList,
				});

				// Owner email (separate)
				if (ownerEmail) {
					await sendCriticalOwnerEmail(
						ownerEmail,
						`Reservation Verification Initiated — ${hotel.hotelName}`,
						emailContent
					);
				}

				// ---- WhatsApp: verification link to guest ----
				try {
					await waSendVerificationLink(
						{ customer_details: { name, phone, nationality } },
						confirmationLink
					);
				} catch (waErr) {
					console.error(
						"[WA] createNewReservationClient (Not Paid):",
						waErr?.message || waErr
					);
				}

				return res.status(200).json({
					message:
						"Verification email sent successfully. Please check your inbox.",
				});
			} catch (error) {
				console.error("Error sending verification emails:", error);
				return res.status(500).json({
					message: "Failed to send verification email. Please try again later.",
				});
			}
		}

		// ========== Deposit Paid / Paid Online ==========
		const { cardNumber, cardExpiryDate, cardCVV, cardHolderName } =
			paymentDetails || {};
		if (!cardNumber || !cardExpiryDate || !cardCVV || !cardHolderName) {
			return res
				.status(400)
				.json({ message: "Invalid payment details provided." });
		}

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
			return res.status(400).json({
				message: paymentResponse.message || "Payment processing failed.",
			});
		}

		let confirmationNumber = req.body.confirmation_number;
		if (!confirmationNumber) {
			confirmationNumber = await new Promise((resolve, reject) => {
				ensureUniqueNumber(
					Reservations,
					"confirmation_number",
					(err, unique) => {
						if (err) reject(new Error("Error generating confirmation number."));
						else resolve(unique);
					}
				);
			});
		} else {
			const existingReservation = await Reservations.findOne({
				confirmation_number: confirmationNumber,
			});
			if (existingReservation) {
				return res.status(400).json({
					message: "Reservation already exists. No further action required.",
				});
			}
		}

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
			transId: encryptWithSecret(paymentResponse.transId),
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
		const savedReservation = await newReservation.save();

		const hotel = await HotelDetails.findById(hotelId).exec();
		if (!hotel) {
			return res.status(404).json({ message: "Hotel not found" });
		}

		const reservationData = {
			...savedReservation.toObject(),
			hotelName: hotel.hotelName,
			hotelAddress: hotel.hotelAddress,
			hotelCity: hotel.hotelCity,
			hotelPhone: hotel.phone,
		};

		await sendEmailWithInvoice(
			reservationData,
			customerDetails.email,
			belongsTo
		);

		// ---- WhatsApp: Confirmation to guest + admin notifications ----
		try {
			await waSendReservationConfirmation(savedReservation);
		} catch (waErr) {
			console.error(
				"[WA] saveReservation guest confirmation:",
				waErr?.message || waErr
			);
		}
		try {
			await waNotifyNewReservation(savedReservation);
		} catch (waErr) {
			console.error(
				"[WA] saveReservation owner/platform notify:",
				waErr?.message || waErr
			);
		}

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
		const isProduction = process.env.AUTHORIZE_NET_ENV === "production";

		const apiLoginId = isProduction
			? process.env.API_LOGIN_ID
			: process.env.API_LOGIN_ID_SANDBOX;

		const transactionKey = isProduction
			? process.env.TRANSACTION_KEY
			: process.env.TRANSACTION_KEY_SANDBOX;

		const endpoint = isProduction
			? "https://api.authorize.net/xml/v1/request.api"
			: "https://apitest.authorize.net/xml/v1/request.api";

		console.log(`Environment: ${isProduction ? "Production" : "Sandbox"}`);
		console.log(`Using Endpoint: ${endpoint}`);
		console.log(`API Login ID: ${apiLoginId}`);

		// Sanitize card details
		const sanitizedCardNumber = cardNumber.replace(/\s+/g, "");
		const formattedAmount = parseFloat(amount).toFixed(2);

		// Step 1: Authorize Only (authOnlyTransaction)
		const authorizationPayload = {
			createTransactionRequest: {
				merchantAuthentication: {
					name: apiLoginId,
					transactionKey: transactionKey,
				},
				transactionRequest: {
					transactionType: "authOnlyTransaction", // Authorize only, no immediate capture
					// amount: formattedAmount,
					amount: "0.10",
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

		console.log(
			"Authorization Payload:",
			JSON.stringify(authorizationPayload, null, 2)
		);

		const authorizationResponse = await axios.post(
			endpoint,
			authorizationPayload,
			{
				headers: { "Content-Type": "application/json" },
			}
		);

		const authorizationData = authorizationResponse.data;

		if (
			authorizationData.messages.resultCode === "Ok" &&
			authorizationData.transactionResponse &&
			authorizationData.transactionResponse.responseCode === "1"
		) {
			console.log(
				"Authorization successful:",
				authorizationData.transactionResponse.transId
			);

			// Save the transaction ID for future capture
			const transactionId = authorizationData.transactionResponse.transId;

			return {
				success: true,
				transactionId, // Save this for later capture
				message: "Payment authorized successfully.",
				response: authorizationData,
			};
		} else {
			const errorText =
				authorizationData.transactionResponse?.errors?.[0]?.errorText ||
				authorizationData.messages.message[0].text ||
				"Authorization failed.";
			console.error("Authorization Error:", errorText);
			return { success: false, message: errorText };
		}
	} catch (error) {
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
		const prophetsMosqueCoordinates = [39.6142, 24.4672]; // Coordinates for Al-Masjid an-Nabawi (longitude, latitude)

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

			// Determine which coordinates to use based on the hotelState
			const destinationCoordinates =
				hotel.hotelState && hotel.hotelState.toLowerCase().includes("madinah")
					? prophetsMosqueCoordinates
					: elHaramCoordinates;

			// Construct API URLs for walking and driving
			const walkingUrl = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${hotelLatitude},${hotelLongitude}&destinations=${destinationCoordinates[1]},${destinationCoordinates[0]}&mode=walking&key=${apiKey}`;
			const drivingUrl = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${hotelLatitude},${hotelLongitude}&destinations=${destinationCoordinates[1]},${destinationCoordinates[0]}&mode=driving&key=${apiKey}`;

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
		// 1) Extract query parameters for pagination & filter
		const {
			page = 1,
			limit = 100,
			filterType = "",
			searchQuery = "",
		} = req.query;

		const pageNumber = parseInt(page, 10) || 1;
		const pageSize = parseInt(limit, 10) || 100;

		// 2) Base filter: booking_source (case-insensitive)
		const baseFilter = {
			$or: [
				{ booking_source: { $regex: /^online jannat booking$/i } },
				{ booking_source: { $regex: /^generated link$/i } },
				{ booking_source: { $regex: /^jannat employee$/i } },
			],
		};

		// ---- Helpers ----
		const toNum = (v) => {
			const n = Number(v);
			return Number.isFinite(n) ? n : 0;
		};
		const isSameDay = (a, b) => {
			const da = new Date(a);
			const db = new Date(b);
			if (!da || isNaN(da.getTime()) || !db || isNaN(db.getTime()))
				return false;
			return (
				da.getFullYear() === db.getFullYear() &&
				da.getMonth() === db.getMonth() &&
				da.getDate() === db.getDate()
			);
		};

		// 3) First, fetch ALL matching docs (no skip/limit).
		// Note: payment_details is an embedded object (not a ref), so no populate needed for it.
		const allDocs = await Reservations.find(baseFilter)
			.sort({ createdAt: -1 })
			.populate("belongsTo")
			.populate("hotelId")
			.lean();

		// 4) Format each doc to compute payment_status (PayPal-aware)
		const capturedConfirmationNumbers = ["2944008828"]; // your manual override

		function formatReservation(doc) {
			const customer_details = doc?.customer_details || {};
			const hotelObj = doc?.hotelId || {};
			const payment_details = doc?.payment_details || {};
			const paypal_details = doc?.paypal_details || {};

			const paymentStr = (doc?.payment || "").toLowerCase();

			// Legacy & offline
			const legacyCaptured = !!payment_details.captured;
			const paidOffline =
				toNum(payment_details.onsite_paid_amount) > 0 ||
				paymentStr === "paid offline";

			// PayPal capture signals
			const capturedTotals = [
				paypal_details.captured_total_sar,
				paypal_details.captured_total_usd,
				paypal_details.captured_total,
			]
				.map(toNum)
				.filter((n) => n > 0);
			const hasCapturedTotal = capturedTotals.length > 0;

			const initialCompleted =
				(paypal_details?.initial?.capture_status || "").toUpperCase() ===
					"COMPLETED" ||
				(paypal_details?.initial?.status || "").toUpperCase() === "COMPLETED";

			const anyMitCompleted =
				Array.isArray(paypal_details?.mit) &&
				paypal_details.mit.some(
					(m) =>
						(m?.capture_status || m?.status || "").toUpperCase() === "COMPLETED"
				);

			const anyCapturesCompleted =
				Array.isArray(paypal_details?.captures) &&
				paypal_details.captures.some(
					(c) =>
						(c?.capture_status || c?.status || "").toUpperCase() === "COMPLETED"
				);

			// Manual override still honored
			const manualOverrideCaptured = capturedConfirmationNumbers.includes(
				String(doc.confirmation_number || "")
			);

			// Final capture decision (settled)
			const isCaptured =
				manualOverrideCaptured ||
				legacyCaptured ||
				hasCapturedTotal ||
				initialCompleted ||
				anyMitCompleted ||
				anyCapturesCompleted ||
				paymentStr === "paid online"; // defensive compatibility

			// Payment status with your same labels
			let payment_status = "Not Captured";
			if (isCaptured) {
				payment_status = "Captured";
			} else if (paidOffline) {
				payment_status = "Paid Offline";
			} else if (paymentStr === "not paid") {
				payment_status = "Not Paid";
			}

			// "Triggered" = auth attempted, capturing in progress, or captured
			const isPaymentTriggered =
				!!payment_details.capturing ||
				!!paypal_details?.initial?.auth_id ||
				!!paypal_details?.initial?.authorization_id ||
				!!paypal_details?.initial?.authorized ||
				isCaptured;

			const today = new Date();
			const isCheckinToday = isSameDay(doc.checkin_date, today);
			const isCheckoutToday = isSameDay(doc.checkout_date, today);

			return {
				...doc,
				customer_name: customer_details.name || "N/A",
				customer_phone: customer_details.phone || "N/A",
				hotel_name: hotelObj?.hotelName || "Unknown Hotel",
				createdAt: doc.createdAt || null,
				payment_status,
				isCheckinToday,
				isCheckoutToday,
				isPaymentTriggered,
			};
		}

		const formattedDocs = allDocs.map(formatReservation);

		// 5) filterType logic (+ Paid Offline)
		function passesFilter(r) {
			if (["checkinToday", "checkoutToday", "notPaid"].includes(filterType)) {
				if ((r.reservation_status || "").toLowerCase() === "cancelled") {
					return false;
				}
			}

			switch (filterType) {
				case "checkinToday":
					return r.isCheckinToday;
				case "checkoutToday":
					return r.isCheckoutToday;
				case "paymentTriggered":
					return r.isPaymentTriggered;
				case "paymentNotTriggered":
					return !r.isPaymentTriggered;
				case "notPaid":
					return (r.payment_status || "").toLowerCase() === "not paid";
				case "notCaptured":
					return (r.payment_status || "").toLowerCase() === "not captured";
				case "captured":
					return (r.payment_status || "").toLowerCase() === "captured";
				case "paidOffline":
					return (r.payment_status || "").toLowerCase() === "paid offline";
				case "cancelled":
					return (r.reservation_status || "").toLowerCase() === "cancelled";
				case "notCancelled":
					return (r.reservation_status || "").toLowerCase() !== "cancelled";
				default:
					return true;
			}
		}

		let filteredDocs = formattedDocs.filter(passesFilter);

		// -------------------- Search --------------------
		const searchQ = (searchQuery || "").trim().toLowerCase();
		if (searchQ) {
			filteredDocs = filteredDocs.filter((r) => {
				const cnum = String(r.confirmation_number || "").toLowerCase();
				const phone = String(r.customer_phone || "").toLowerCase();
				const name = String(r.customer_name || "").toLowerCase();
				const hname = String(r.hotel_name || "").toLowerCase();

				return (
					cnum.includes(searchQ) ||
					phone.includes(searchQ) ||
					name.includes(searchQ) ||
					hname.includes(searchQ)
				);
			});
		}
		// -------------------------------------------------

		// The total AFTER filter + search
		const totalDocuments = filteredDocs.length;

		// 6) Do skip/limit for final pagination
		const startIndex = (pageNumber - 1) * pageSize;
		const endIndex = startIndex + pageSize;
		const finalDocs = filteredDocs.slice(startIndex, endIndex);

		// 7) Scorecards logic on "filteredDocs" (unchanged)
		function isToday(date) {
			const today = new Date();
			return (
				date.getDate() === today.getDate() &&
				date.getMonth() === today.getMonth() &&
				date.getFullYear() === today.getFullYear()
			);
		}
		function isYesterday(date) {
			const today = new Date();
			const yesterday = new Date(today);
			yesterday.setDate(today.getDate() - 1);
			return (
				date.getDate() === yesterday.getDate() &&
				date.getMonth() === yesterday.getMonth() &&
				date.getFullYear() === yesterday.getFullYear()
			);
		}
		function isThisWeek(date) {
			const now = new Date();
			const startOfWeek = new Date(now);
			startOfWeek.setDate(now.getDate() - now.getDay());
			startOfWeek.setHours(0, 0, 0, 0);

			const endOfWeek = new Date(startOfWeek);
			endOfWeek.setDate(startOfWeek.getDate() + 6);
			endOfWeek.setHours(23, 59, 59, 999);

			return date >= startOfWeek && date <= endOfWeek;
		}
		function isLastWeek(date) {
			const now = new Date();
			const startOfThisWeek = new Date(now);
			startOfThisWeek.setDate(now.getDate() - now.getDay());
			startOfThisWeek.setHours(0, 0, 0, 0);

			const endOfLastWeek = new Date(startOfThisWeek.getTime() - 1);

			const startOfLastWeek = new Date(startOfThisWeek);
			startOfLastWeek.setDate(startOfThisWeek.getDate() - 7);
			startOfLastWeek.setHours(0, 0, 0, 0);

			return date >= startOfLastWeek && date <= endOfLastWeek;
		}
		function safeNumber(val) {
			const parsed = Number(val);
			return isNaN(parsed) ? 0 : parsed;
		}
		function computeReservationCommission(reservation) {
			if (!reservation || !reservation.pickedRoomsType) return 0;
			const hotelName = reservation.hotelId?.hotelName?.toLowerCase() || "";
			const totalAmount = safeNumber(reservation.total_amount);

			if (hotelName === "sahet al hegaz") {
				return 0.1 * totalAmount;
			}

			let totalCommission = 0;
			reservation.pickedRoomsType.forEach((room) => {
				if (!room.pricingByDay) return;
				room.pricingByDay.forEach((day) => {
					const rootPrice = safeNumber(day.rootPrice);
					const rawRate = safeNumber(day.commissionRate);
					const finalRate = rawRate < 1 ? rawRate : rawRate / 100;
					const totalPriceWithoutComm = safeNumber(
						day.totalPriceWithoutCommission
					);

					const dayCommission =
						rootPrice * finalRate + (totalPriceWithoutComm - rootPrice);

					totalCommission += dayCommission * safeNumber(room.count);
				});
			});
			return totalCommission;
		}

		const allReservations = filteredDocs;

		// For row1
		const todayReservations = allReservations.filter((r) =>
			isToday(new Date(r.createdAt))
		).length;
		const yesterdayReservations = allReservations.filter((r) =>
			isYesterday(new Date(r.createdAt))
		).length;
		const todayRatio =
			yesterdayReservations > 0
				? ((todayReservations - yesterdayReservations) /
						yesterdayReservations) *
				  100
				: todayReservations * 100;

		const weeklyReservations = allReservations.filter((r) =>
			isThisWeek(new Date(r.createdAt))
		).length;
		const lastWeekReservations = allReservations.filter((r) =>
			isLastWeek(new Date(r.createdAt))
		).length;
		const weeklyRatio =
			lastWeekReservations > 0
				? ((weeklyReservations - lastWeekReservations) / lastWeekReservations) *
				  100
				: weeklyReservations * 100;

		const hotelCounts = allReservations.reduce((acc, r) => {
			const name = r.hotelId?.hotelName || "Unknown Hotel";
			acc[name] = (acc[name] || 0) + 1;
			return acc;
		}, {});
		const topHotels = Object.entries(hotelCounts)
			.map(([name, reservations]) => ({ name, reservations }))
			.sort((a, b) => b.reservations - a.reservations)
			.slice(0, 3);
		const totalFilteredReservations = allReservations.length;

		// Row2 => exclude cancelled
		const nonCancelled = allReservations.filter(
			(r) => (r.reservation_status || "").toLowerCase() !== "cancelled"
		);

		const todayCommission = nonCancelled
			.filter((r) => isToday(new Date(r.createdAt)))
			.reduce((sum, r) => sum + computeReservationCommission(r), 0);
		const yesterdayCommission = nonCancelled
			.filter((r) => isYesterday(new Date(r.createdAt)))
			.reduce((sum, r) => sum + computeReservationCommission(r), 0);
		const todayCommissionRatio =
			yesterdayCommission > 0
				? ((todayCommission - yesterdayCommission) / yesterdayCommission) * 100
				: todayCommission * 100;

		const weeklyCommission = nonCancelled
			.filter((r) => isThisWeek(new Date(r.createdAt)))
			.reduce((sum, r) => sum + computeReservationCommission(r), 0);
		const lastWeekCommission = nonCancelled
			.filter((r) => isLastWeek(new Date(r.createdAt)))
			.reduce((sum, r) => sum + computeReservationCommission(r), 0);
		const weeklyCommissionRatio =
			lastWeekCommission > 0
				? ((weeklyCommission - lastWeekCommission) / lastWeekCommission) * 100
				: weeklyCommission * 100;

		const hotelCommissions = nonCancelled.reduce((acc, r) => {
			const name = r.hotelId?.hotelName || "Unknown Hotel";
			const c = computeReservationCommission(r);
			acc[name] = (acc[name] || 0) + c;
			return acc;
		}, {});
		const topHotelsByCommission = Object.entries(hotelCommissions)
			.map(([name, commission]) => ({ name, commission }))
			.sort((a, b) => b.commission - a.commission)
			.slice(0, 3);

		const overallCommission = nonCancelled.reduce(
			(acc, r) => acc + computeReservationCommission(r),
			0
		);

		const scorecards = {
			// Row 1
			todayReservations,
			yesterdayReservations,
			todayRatio,
			weeklyReservations,
			lastWeekReservations,
			weeklyRatio,
			topHotels,
			totalReservations: totalFilteredReservations,

			// Row 2
			todayCommission,
			yesterdayCommission,
			todayCommissionRatio,
			weeklyCommission,
			lastWeekCommission,
			weeklyCommissionRatio,
			topHotelsByCommission,
			overallCommission,
		};

		// Return response
		return res.status(200).json({
			success: true,
			data: finalDocs, // after filter+search + skip/limit
			totalDocuments,
			currentPage: pageNumber,
			totalPages: Math.ceil(totalDocuments / pageSize),
			scorecards,
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
			belongsTo,
		} = req.body;

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

		const parsedTotalAmount = parseFloat(totalAmount);
		const parsedTotalCommission = parseFloat(totalCommission);
		const parsedDepositAmount = (
			parsedTotalAmount *
			(depositPercentage / 100)
		).toFixed(2);

		const emailHtmlContent = SendingReservationLinkEmail({
			hotelName,
			name,
			agentName,
			depositPercentage,
			wholeAmount: parsedTotalAmount,
			confirmationLink: generatedLink,
		});

		const emailOptions = {
			to: email,
			from: "noreply@jannatbooking.com",
			subject: `${hotelName} | Reservation Confirmation Link`,
			html: emailHtmlContent,
		};

		const emailOptions2 = {
			to: [
				{ email: "morazzakhamouda@gmail.com" },
				{ email: "xhoteleg@gmail.com" },
				{ email: "ahmed.abdelrazak@jannatbooking.com" },
			],
			from: "noreply@jannatbooking.com",
			subject: `${hotelName} | Reservation Confirmation Link`,
			html: emailHtmlContent,
		};

		await sgMail.send(emailOptions);
		await sgMail.send(emailOptions2);

		// if belongsTo role=2000 then also notify them by email (existing behavior)
		if (belongsTo) {
			let belongsToId =
				typeof belongsTo === "object" && belongsTo._id
					? belongsTo._id
					: belongsTo;
			if (belongsToId && mongoose.Types.ObjectId.isValid(belongsToId)) {
				const belongsToUser = await User.findById(belongsToId);
				if (belongsToUser && belongsToUser.role === 2000) {
					await sgMail.send({
						to: belongsToUser.email,
						from: "noreply@jannatbooking.com",
						subject: `${hotelName} | Reservation Confirmation Link`,
						html: emailHtmlContent,
					});
				}
			}
		}

		// ---- WhatsApp: payment link to guest ----
		try {
			await waSendPaymentLink(
				{ customer_details: { name, email, phone, nationality } },
				generatedLink
			);
		} catch (waErr) {
			console.error(
				"[WA] sendingEmailForPaymentLink:",
				waErr?.message || waErr
			);
		}

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

exports.updatingTokenizedId = async (req, res) => {
	try {
		const { reservationId, newTokenId } = req.body;

		// Validate input
		if (!reservationId || !newTokenId) {
			return res.status(400).json({
				message:
					"Invalid input. Reservation ID and new tokenized ID are required.",
			});
		}

		// Find the reservation by ID
		const reservation = await Reservations.findById(reservationId);
		if (!reservation) {
			return res.status(404).json({
				message: "Reservation not found.",
			});
		}

		// Encrypt the new tokenized ID
		const encryptedTokenId = encryptWithSecret(newTokenId);

		// Update the tokenized ID in the reservation
		reservation.customer_details.tokenId = encryptedTokenId;
		await reservation.save();

		res.status(200).json({
			message: "Tokenized ID updated successfully.",
			data: reservation,
		});
	} catch (error) {
		console.error("Error updating tokenized ID:", error);
		res.status(500).json({
			message: "An error occurred while updating the tokenized ID.",
		});
	}
};

const sendPaymentTriggeredEmail = async (reservationData) => {
	try {
		const emailHtmlContent = paymentTriggered(reservationData);

		const msg = {
			to: reservationData.customer_details.email, // Guest's email
			from: "noreply@jannatbooking.com", // Your verified sender
			subject: "Payment Confirmation - Jannat Booking",
			html: emailHtmlContent,
		};

		const msg2 = {
			to: [
				{ email: "morazzakhamouda@gmail.com" },
				{ email: "xhoteleg@gmail.com" },
				{ email: "ahmed.abdelrazak@jannatbooking.com" },
			],
			from: "noreply@jannatbooking.com", // Your verified sender
			subject: "Payment Confirmation - Jannat Booking",
			html: emailHtmlContent,
		};

		await sgMail.send(msg);
		await sgMail.send(msg2);
		console.log("Payment confirmation email sent successfully.");
	} catch (error) {
		console.error("Error sending payment confirmation email:", error);
		if (error.response) {
			console.error(error.response.body);
		}
	}
};

exports.triggeringSpecificTokenizedIdToCharge = async (req, res) => {
	try {
		console.log("==== START: triggeringSpecificTokenizedIdToCharge ====");

		// Print environment to confirm
		console.log("AUTHORIZE_NET_ENV =", process.env.AUTHORIZE_NET_ENV);

		// Log partial keys (for debugging):
		console.log(
			"API_LOGIN_ID starts with = ",
			(process.env.API_LOGIN_ID || "").slice(0, 6)
		);
		console.log(
			"TRANSACTION_KEY starts with = ",
			(process.env.TRANSACTION_KEY || "").slice(0, 6)
		);

		const { reservationId, amount, paymentOption, customUSD, amountSAR } =
			req.body;

		console.log("Received request to capture payment:");
		console.log("  Reservation ID:", reservationId);
		console.log("  Amount (USD):", amount);
		console.log("  Amount (SAR):", amountSAR);
		console.log("  Payment Option:", paymentOption);
		console.log("  customUSD:", customUSD);

		// 1) Basic input validation
		if (!reservationId || amount === undefined) {
			console.log("Invalid input. Missing reservationId or amount.");
			return res.status(400).json({
				message: "Invalid input. Reservation ID and amount are required.",
			});
		}

		// 2) Find the reservation
		console.log("Looking up reservation in DB by ID =", reservationId);
		const reservation = await Reservations.findById(reservationId).populate(
			"hotelId"
		);
		if (!reservation) {
			console.log("Reservation not found in DB.");
			return res.status(404).json({ message: "Reservation not found." });
		}
		console.log("Reservation found:", reservation._id);

		// 3) Retrieve transId from reservation.payment_details
		let transId = reservation.payment_details?.transactionResponse?.transId;
		console.log("Extracted transId from reservation =", transId);

		// 4) Decrypt card details
		console.log("Decrypting card details now...");
		let cardNumber = decryptWithSecret(reservation.customer_details.cardNumber);
		const cardExpiryDate = decryptWithSecret(
			reservation.customer_details.cardExpiryDate
		);
		const cardCVV = decryptWithSecret(reservation.customer_details.cardCVV);

		if (!cardNumber || !cardExpiryDate || !cardCVV) {
			console.log(
				"Decrypted card details are missing or invalid. Returning 400."
			);
			return res
				.status(400)
				.json({ message: "Decrypted card details are missing or invalid." });
		}

		// Remove spaces from card number
		cardNumber = cardNumber.replace(/\s+/g, "");

		// 5) Setup Authorize.Net environment
		const isProduction = process.env.AUTHORIZE_NET_ENV === "production";
		const apiLoginId = isProduction
			? process.env.API_LOGIN_ID
			: process.env.API_LOGIN_ID_SANDBOX;
		const transactionKey = isProduction
			? process.env.TRANSACTION_KEY
			: process.env.TRANSACTION_KEY_SANDBOX;
		const endpoint = isProduction
			? "https://api.authorize.net/xml/v1/request.api"
			: "https://apitest.authorize.net/xml/v1/request.api";

		console.log("Authorize.Net environment => isProduction =", isProduction);
		console.log("Authorize.Net endpoint =", endpoint);

		// ===============================================
		// 6) Attempt priorAuthCapture IF we have transId
		// ===============================================
		let skipPriorAuthCapture = false;

		if (!transId) {
			console.log(
				"No transId found in payment_details => skipping priorAuthCaptureTransaction."
			);
			skipPriorAuthCapture = true;
		} else {
			// We have a transId, let's try priorAuthCaptureTransaction
			const capturePayload = {
				createTransactionRequest: {
					merchantAuthentication: {
						name: apiLoginId,
						transactionKey: transactionKey,
					},
					transactionRequest: {
						transactionType: "priorAuthCaptureTransaction",
						refTransId: transId,
					},
				},
			};

			console.log("=== priorAuthCapture Payload ===");
			console.log(JSON.stringify(capturePayload, null, 2));

			let captureData;
			try {
				console.log("Sending priorAuthCapture request to Authorize.Net...");
				const captureResponse = await axios.post(endpoint, capturePayload, {
					headers: { "Content-Type": "application/json" },
				});
				captureData = captureResponse.data;
				console.log(
					"priorAuthCapture Response Data =",
					JSON.stringify(captureData, null, 2)
				);

				if (
					captureData.messages.resultCode !== "Ok" ||
					!captureData.transactionResponse ||
					captureData.transactionResponse.responseCode !== "1"
				) {
					const captureError =
						captureData.transactionResponse?.errors?.[0]?.errorText ||
						captureData.messages.message[0].text ||
						"Failed to capture the previously authorized amount.";
					console.error("Capture Error: ", captureError);

					// If "The transaction cannot be found" => skip priorAuthCapture
					if (captureError.includes("The transaction cannot be found")) {
						console.warn(
							"Transaction not found in Authorize.Net. Skipping priorAuthCapture and proceeding to authCaptureTransaction."
						);
						skipPriorAuthCapture = true;
					} else {
						// For other errors, return the error
						console.log("Returning 400 from priorAuthCapture error...");
						return res.status(400).json({ message: captureError });
					}
				} else {
					console.log("priorAuthCapture Succeeded for refTransId =", transId);
				}
			} catch (error) {
				console.error("Capture Request Error =>", error.message);
				if (error.response) {
					console.error("Capture Request Error Response:", error.response.data);
				}
				return res.status(500).json({
					message:
						"An error occurred while communicating with Authorize.Net during capture.",
				});
			}
		}

		// ===============================================
		// 7) Step 2: authCaptureTransaction for final amount
		// ===============================================
		const formattedAmount = parseFloat(amount).toFixed(2);
		console.log(
			"Preparing authCaptureTransaction with finalAmount (USD) =",
			formattedAmount
		);

		const paymentPayload = {
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
							cardNumber,
							expirationDate: cardExpiryDate, // "MM/YY" or "MM/YYYY"
							cardCode: cardCVV,
						},
					},
					order: {
						invoiceNumber: reservation.confirmation_number || "N/A",
						description: "Reservation final payment",
					},
					billTo: {
						firstName: reservation.customer_details.name.split(" ")[0] || "",
						lastName: reservation.customer_details.name.split(" ")[1] || "",
						address: reservation.customer_details.address || "N/A",
						city: reservation.customer_details.city || "N/A",
						state: reservation.customer_details.state || "N/A",
						zip: reservation.customer_details.postalCode || "00000",
						country: reservation.customer_details.nationality || "US",
						email: reservation.customer_details.email || "",
					},
				},
			},
		};

		console.log("=== authCapture Payload ===");
		console.log(JSON.stringify(paymentPayload, null, 2));

		let paymentData;
		try {
			console.log("Sending authCaptureTransaction request to Authorize.Net...");
			const paymentResponse = await axios.post(endpoint, paymentPayload, {
				headers: { "Content-Type": "application/json" },
			});
			paymentData = paymentResponse.data;
			console.log(
				"authCaptureTransaction Response Data =",
				JSON.stringify(paymentData, null, 2)
			);

			// 8) Check if payment is successful
			if (
				paymentData.messages.resultCode === "Ok" &&
				paymentData.transactionResponse &&
				paymentData.transactionResponse.responseCode === "1"
			) {
				console.log("Authorize.Net Payment captured successfully!");

				// Payment captured in USD with "amount"
				let updatedPaidAmount;
				if (
					reservation.payment_details &&
					reservation.payment_details.captured
				) {
					// Payment was previously captured, accumulate the new payment.
					const alreadyPaid = Number(reservation.paid_amount) || 0;
					const newlyPaid = Number(amountSAR) || 0;
					updatedPaidAmount = alreadyPaid + newlyPaid;
				} else {
					// First time capture: set paid_amount to the new amount
					updatedPaidAmount = Number(amountSAR) || 0;
				}

				console.log("updatedPaidAmount (SAR) =", updatedPaidAmount);

				// 9) Update the reservation in DB
				const updatedReservation = await Reservations.findOneAndUpdate(
					{ _id: reservationId },
					{
						$set: {
							"payment_details.capturing": true,
							"payment_details.finalCaptureTransactionId":
								paymentData.transactionResponse.transId,
							"payment_details.captured": true,
							"payment_details.triggeredAmountUSD": formattedAmount,
							"payment_details.triggeredAmountSAR":
								Number(amountSAR).toFixed(2),
							paid_amount: updatedPaidAmount,
						},
						$inc: {
							"payment_details.chargeCount": 1,
						},
					},
					{ new: true }
				).populate("hotelId");

				console.log("Reservation updated in DB =>", updatedReservation._id);

				// 10) Send paymentTriggered email
				console.log("Sending paymentTriggeredEmail...");
				await sendPaymentTriggeredEmail(updatedReservation);

				console.log("==== SUCCESS: Payment captured. Returning 200... ====");
				return res.status(200).json({
					message: "Payment captured successfully.",
					transactionId: paymentData.transactionResponse.transId,
					reservation: updatedReservation,
				});
			} else {
				// Payment capture failed at gateway
				const paymentError =
					paymentData.transactionResponse?.errors?.[0]?.errorText ||
					paymentData.messages.message[0].text ||
					"Payment capture failed.";
				console.log("Payment capture failed =>", paymentError);
				return res.status(400).json({ message: paymentError });
			}
		} catch (error) {
			console.error("Payment Request Error =>", error.message);
			if (error.response) {
				console.error("Payment Request Error Response:", error.response.data);
			}
			return res.status(500).json({
				message:
					"An error occurred while communicating with Authorize.Net during payment.",
			});
		}
	} catch (error) {
		console.error("General Error capturing payment:", error);
		return res.status(500).json({
			message: "An error occurred while capturing the payment.",
		});
	}
};

exports.getRoomByIds = async (req, res) => {
	try {
		const { roomIds } = req.body; // Array of room IDs passed in the request body

		if (!roomIds || !Array.isArray(roomIds)) {
			return res.status(400).json({
				error: "Invalid request. 'roomIds' should be an array.",
			});
		}

		// Find hotels that contain the room IDs in their roomCountDetails
		const hotels = await HotelDetails.find({
			"roomCountDetails._id": { $in: roomIds }, // Match rooms by their ID
		});

		if (!hotels || hotels.length === 0) {
			return res.status(404).json({
				error: "No rooms found for the provided IDs.",
			});
		}

		// Extract the matched rooms and attach hotelName and hotelId
		const matchedRooms = [];
		hotels.forEach((hotel) => {
			const rooms = hotel.roomCountDetails.filter((room) =>
				roomIds.includes(room._id.toString())
			);
			rooms.forEach((room) => {
				matchedRooms.push({
					...room.toObject(), // Convert Mongoose document to plain JavaScript object
					hotelName: hotel.hotelName, // Add hotel name
					hotelId: hotel._id, // Add hotel ID
				});
			});
		});

		res.status(200).json({
			success: true,
			rooms: matchedRooms, // Return the enhanced room details
		});
	} catch (error) {
		console.error("Error fetching rooms by IDs:", error);
		res.status(500).json({
			error: "An error occurred while fetching rooms by IDs.",
		});
	}
};

exports.createNewReservationClient2 = async (req, res) => {
	try {
		const {
			sentFrom,
			hotelId,
			customerDetails,
			pickedRoomsType,
			total_amount,
			commission,
			total_rooms,
			total_guests,
			adults,
			children,
			checkin_date,
			checkout_date,
			days_of_residence,
			belongsTo,
			booking_source,
			hotel_name,
			payment,
			paid_amount,
			commissionPaid,
			advancePayment,
		} = req.body;

		// 1) Employee direct creation
		if (sentFrom === "employee") {
			const confirmationNumber = await new Promise((resolve, reject) => {
				ensureUniqueNumber(
					Reservations,
					"confirmation_number",
					(err, unique) => {
						if (err) reject(new Error("Error generating confirmation number."));
						else resolve(unique);
					}
				);
			});

			const reservation = new Reservations({
				hotelId,
				customer_details: customerDetails,
				confirmation_number: confirmationNumber,
				belongsTo,
				checkin_date,
				checkout_date,
				days_of_residence,
				total_rooms,
				total_guests,
				adults,
				children,
				total_amount,
				commission,
				payment,
				paid_amount,
				commissionPaid,
				booking_source,
				hotelName: hotel_name,
				pickedRoomsType,
				advancePayment,
			});

			const savedReservation = await reservation.save();
			const hotel = await HotelDetails.findById(hotelId).exec();
			if (!hotel) {
				return res.status(404).json({ message: "Hotel not found" });
			}

			const reservationData = {
				...savedReservation.toObject(),
				hotelName: hotel.hotelName,
				hotelAddress: hotel.hotelAddress,
				hotelCity: hotel.hotelCity,
				hotelPhone: hotel.phone,
			};

			const emailHtmlContent = ClientConfirmationEmail(reservationData);
			const pdfBuffer = await createPdfBuffer(emailHtmlContent);

			await sgMail.send({
				to: customerDetails.email || "noreply@jannatbooking.com",
				from: "noreply@jannatbooking.com",
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
			});

			await sgMail.send({
				to: [
					"morazzakhamouda@gmail.com",
					"xhoteleg@gmail.com",
					"ahmed.abdelrazak@jannatbooking.com",
				],
				from: "noreply@jannatbooking.com",
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
			});

			if (belongsTo) {
				let belongsToId =
					typeof belongsTo === "object" && belongsTo._id
						? belongsTo._id
						: belongsTo;
				if (belongsToId && mongoose.Types.ObjectId.isValid(belongsToId)) {
					const belongsToUser = await User.findById(belongsToId);
					if (belongsToUser && belongsToUser.role === 2000) {
						await sgMail.send({
							to: belongsToUser.email,
							from: "noreply@jannatbooking.com",
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
						});
					}
				}
			}

			// ---- WhatsApp: Confirmation to guest + admin notifications ----
			try {
				await waSendReservationConfirmation(savedReservation);
			} catch (waErr) {
				console.error(
					"[WA] createNewReservationClient2 (employee) guest:",
					waErr?.message || waErr
				);
			}
			try {
				await waNotifyNewReservation(savedReservation);
			} catch (waErr) {
				console.error(
					"[WA] createNewReservationClient2 (employee) notify:",
					waErr?.message || waErr
				);
			}

			return res.status(201).json({
				message: "Reservation created successfully",
				data: savedReservation,
			});
		}

		// 2) Non-employee path (Not Paid → verification link)
		const { name, phone, email, passport, passportExpiry, nationality } =
			customerDetails;

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

		if (payment === "Not Paid") {
			const tokenPayload = { ...req.body };
			const token = jwt.sign(tokenPayload, process.env.JWT_SECRET2, {
				expiresIn: "3d",
			});
			const confirmationLink = `${process.env.CLIENT_URL}/reservation-verification?token=${token}`;

			const emailContent = ReservationVerificationEmail({
				name,
				hotelName: hotel.hotelName,
				confirmationLink,
			});

			await sgMail.send({
				to: email,
				from: "noreply@jannatbooking.com",
				subject: "Verify Your Reservation",
				html: emailContent,
			});

			await sgMail.send({
				to: [
					"morazzakhamouda@gmail.com",
					"xhoteleg@gmail.com",
					"ahmed.abdelrazak@jannatbooking.com",
				],
				from: "noreply@jannatbooking.com",
				subject: "Verify Your Reservation",
				html: emailContent,
			});

			if (belongsTo) {
				let belongsToId =
					typeof belongsTo === "object" && belongsTo._id
						? belongsTo._id
						: belongsTo;
				if (belongsToId && mongoose.Types.ObjectId.isValid(belongsToId)) {
					const belongsToUser = await User.findById(belongsToId);
					if (belongsToUser && belongsToUser.role === 2000) {
						await sgMail.send({
							to: belongsToUser.email,
							from: "noreply@jannatbooking.com",
							subject: "Verify Your Reservation",
							html: emailContent,
						});
					}
				}
			}

			// ---- WhatsApp: verification link to guest ----
			try {
				await waSendVerificationLink(
					{ customer_details: { name, phone, nationality } },
					confirmationLink
				);
			} catch (waErr) {
				console.error(
					"[WA] createNewReservationClient2 (Not Paid):",
					waErr?.message || waErr
				);
			}

			return res.status(200).json({
				message:
					"Verification email sent successfully. Please check your inbox.",
			});
		}

		// otherwise, mirror payment path from your other controller if needed
		return res
			.status(400)
			.json({ message: "Unsupported flow in this endpoint." });
	} catch (error) {
		console.error("Error creating reservation:", error);
		res
			.status(500)
			.json({ message: "An error occurred while creating the reservation" });
	}
};

// Payment processing function for payments from a link
async function processPaymentFromLink({
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
		const isProduction = process.env.AUTHORIZE_NET_ENV === "production";

		const apiLoginId = isProduction
			? process.env.API_LOGIN_ID
			: process.env.API_LOGIN_ID_SANDBOX;

		const transactionKey = isProduction
			? process.env.TRANSACTION_KEY
			: process.env.TRANSACTION_KEY_SANDBOX;

		const endpoint = isProduction
			? "https://api.authorize.net/xml/v1/request.api"
			: "https://apitest.authorize.net/xml/v1/request.api";

		// Sanitize card details
		const sanitizedCardNumber = cardNumber.replace(/\s+/g, "");
		const formattedAmount = parseFloat(amount).toFixed(2);

		// Prepare payload for payment authorization
		const authorizationPayload = {
			createTransactionRequest: {
				merchantAuthentication: {
					name: apiLoginId,
					transactionKey: transactionKey,
				},
				transactionRequest: {
					transactionType: "authOnlyTransaction", // Authorize only, no immediate capture
					amount: "0.10",
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

		// Send request to payment gateway
		const authorizationResponse = await axios.post(
			endpoint,
			authorizationPayload,
			{
				headers: { "Content-Type": "application/json" },
			}
		);

		const authorizationData = authorizationResponse.data;

		// Check if payment is authorized successfully
		if (
			authorizationData.messages.resultCode === "Ok" &&
			authorizationData.transactionResponse &&
			authorizationData.transactionResponse.responseCode === "1"
		) {
			const transactionId = authorizationData.transactionResponse.transId;

			return {
				success: true,
				transactionId,
				message: "Payment authorized successfully.",
				response: authorizationData,
			};
		} else {
			const errorText =
				authorizationData.transactionResponse?.errors?.[0]?.errorText ||
				authorizationData.messages.message[0].text ||
				"Authorization failed.";
			return { success: false, message: errorText };
		}
	} catch (error) {
		return { success: false, message: "Payment processing error." };
	}
}

// Function to update reservation details
exports.updateReservationDetails = async (req, res) => {
	const reservationId = req.params.reservationId;
	const updateData = req.body;

	try {
		const reservation = await Reservations.findById(reservationId).exec();
		if (!reservation) {
			return res.status(404).send({ error: "Reservation not found" });
		}

		if (updateData.paymentDetails) {
			const { amount, cardNumber, cardExpiryDate, cardCVV, cardHolderName } =
				updateData.paymentDetails;

			if (
				!amount ||
				!cardNumber ||
				!cardExpiryDate ||
				!cardCVV ||
				!cardHolderName
			) {
				return res
					.status(400)
					.send({ error: "Incomplete payment details provided." });
			}

			const paymentResponse = await processPaymentFromLink({
				amount,
				cardNumber,
				expirationDate: cardExpiryDate,
				cardCode: cardCVV,
				customerDetails: reservation.customer_details,
				checkinDate: reservation.checkin_date,
				checkoutDate: reservation.checkout_date,
				hotelName: reservation.hotelName || "Hotel",
			});

			if (!paymentResponse.success) {
				return res.status(400).send({
					error: paymentResponse.message || "Payment processing failed.",
				});
			}

			reservation.payment_details = {
				...reservation.payment_details,
				amountInUSD: amount,
				...paymentResponse.response,
			};
			reservation.payment = "Paid Online";
			reservation.paid_amount = amount;
		}

		if (updateData.customer_details) {
			const { cardNumber, cardExpiryDate, cardCVV, cardHolderName } =
				updateData.customer_details;

			if (cardNumber && cardExpiryDate && cardCVV && cardHolderName) {
				updateData.customer_details.cardNumber = encryptWithSecret(cardNumber);
				updateData.customer_details.cardExpiryDate =
					encryptWithSecret(cardExpiryDate);
				updateData.customer_details.cardCVV = encryptWithSecret(cardCVV);
				updateData.customer_details.cardHolderName =
					encryptWithSecret(cardHolderName);
			}

			reservation.customer_details = {
				...reservation.customer_details,
				...updateData.customer_details,
			};
			reservation.markModified("customer_details");
		}

		if (
			updateData.pickedRoomsType &&
			Array.isArray(updateData.pickedRoomsType)
		) {
			const ensureUniqueRoomPricing = (pickedRoomsType) => {
				const uniquePricing = {};
				pickedRoomsType.forEach((room) => {
					if (!uniquePricing[room.room_type]) {
						uniquePricing[room.room_type] = new Set();
					}
					if (uniquePricing[room.room_type].has(room.chosenPrice)) {
						room.chosenPrice = parseFloat(room.chosenPrice) + 1;
					}
					uniquePricing[room.room_type].add(room.chosenPrice);
				});
			};

			const updatedPickedRoomsType = reservation.pickedRoomsType.map(
				(existingRoom) => {
					const matchingNewRoom = updateData.pickedRoomsType.find(
						(newRoom) =>
							newRoom.room_type === existingRoom.room_type &&
							newRoom.chosenPrice === existingRoom.chosenPrice
					);

					if (matchingNewRoom && Object.keys(matchingNewRoom).length > 0) {
						return { ...existingRoom, ...matchingNewRoom };
					}
					return existingRoom;
				}
			);

			updateData.pickedRoomsType.forEach((newRoom) => {
				if (
					newRoom.room_type &&
					newRoom.chosenPrice &&
					!updatedPickedRoomsType.some(
						(room) =>
							room.room_type === newRoom.room_type &&
							room.chosenPrice === newRoom.chosenPrice
					)
				) {
					updatedPickedRoomsType.push(newRoom);
				}
			});

			ensureUniqueRoomPricing(updatedPickedRoomsType);

			reservation.pickedRoomsType = updatedPickedRoomsType;
			reservation.markModified("pickedRoomsType");
		}

		Object.keys(updateData).forEach((key) => {
			if (
				key !== "pickedRoomsType" &&
				key !== "customer_details" &&
				key !== "paymentDetails"
			) {
				reservation[key] = updateData[key];
			}
		});

		const updatedReservation = await reservation.save();

		const hotel = await HotelDetails.findById(reservation.hotelId).exec();
		const emailData = {
			...updatedReservation.toObject(),
			hotelName: hotel?.hotelName || "Hotel",
			hotelAddress: hotel?.hotelAddress || "",
			hotelCity: hotel?.hotelCity || "",
			hotelPhone: hotel?.phone || "",
		};

		await sendEmailWithInvoice(
			emailData,
			reservation.customer_details?.email,
			reservation.belongsTo
		);

		// ---- WhatsApp: reservation update ----
		try {
			const link = `${process.env.CLIENT_URL}/single-reservations/${updatedReservation.confirmation_number}`;
			const text = `Your reservation was updated. View details: ${link}`;
			await waSendReservationUpdate(updatedReservation, text);
		} catch (waErr) {
			console.error("[WA] updateReservationDetails:", waErr?.message || waErr);
		}

		res.status(200).json({
			message: "Reservation updated successfully.",
			data: updatedReservation,
		});
	} catch (error) {
		console.error("Error updating reservation:", error);
		res
			.status(500)
			.send({ error: "An error occurred while updating reservation." });
	}
};

// Convert Arabic numerals to English numerals (basic mapping)
function convertArabicToEnglishNumerals(str) {
	if (!str) return "";
	const map = {
		"٠": "0",
		"١": "1",
		"٢": "2",
		"٣": "3",
		"٤": "4",
		"٥": "5",
		"٦": "6",
		"٧": "7",
		"٨": "8",
		"٩": "9",
	};
	return str
		.split("")
		.map((char) => (map[char] ? map[char] : char))
		.join("");
}

// Minimal check: must contain "@" and ".com"
function isEmailValid(email) {
	if (!email) return false;
	return email.includes("@") && email.includes(".com");
}

// Phone validation rules:
//  1) Convert Arabic numerals to English
//  2) Remove '+', spaces, and all non-digit chars
//  3) Resulting digit string length >= 5 => valid
function isPhoneValid(rawPhone) {
	if (!rawPhone) return false;
	// Convert Arabic digits to English
	let converted = convertArabicToEnglishNumerals(rawPhone);
	// Remove all non-digits
	// E.g., remove +, spaces, parentheses, hyphens, etc.
	let digitsOnly = converted.replace(/\D/g, "");
	return digitsOnly.length >= 5;
}

// Remove duplicates by email
function removeDuplicatesByEmail(records) {
	const seen = new Set();
	return records.filter((record) => {
		// If there's no email, treat it as unique every time
		if (!record.email) return true;
		if (seen.has(record.email)) {
			return false;
		}
		seen.add(record.email);
		return true;
	});
}

exports.compileCustomerList = async (req, res) => {
	try {
		// 1) Clear out the existing CustomerList in hotels DB
		await CustomerList.deleteMany({});

		let allCustomers = [];

		// =============== gq_b2b / orders ==================
		{
			const gqB2BConn = mongoose.createConnection(process.env.GQB2B, {
				useNewUrlParser: true,
				useUnifiedTopology: true,
			});
			const Order = gqB2BConn.model(
				"Order",
				new mongoose.Schema({}, { strict: false }),
				"orders"
			);

			const gqB2BOrders = await Order.find({});
			const gqB2BCustomers = gqB2BOrders
				.map((doc) => {
					const c = doc.customerDetails || {};
					const rawPhone = c.phone || "";
					const rawEmail = c.email || "";

					const emailCheck = isEmailValid(rawEmail);
					const phoneCheck = isPhoneValid(rawPhone);

					// Skip if both false
					if (!emailCheck && !phoneCheck) return null;

					return {
						name: c.fullName || "",
						email: rawEmail,
						phone: rawPhone,
						country: "Egypt",
						database: "gq_b2b",
						schema: "orders",
						email_phone: {
							phoneCheck,
							emailCheck,
						},
					};
				})
				.filter(Boolean);

			allCustomers.push(...gqB2BCustomers);
			await gqB2BConn.close();
		}

		// =============== hairbrush / users (Egypt) ==================
		{
			const hairbrushConn = mongoose.createConnection(process.env.HAIRBRUSH, {
				useNewUrlParser: true,
				useUnifiedTopology: true,
			});
			const HairbrushUser = hairbrushConn.model(
				"User",
				new mongoose.Schema({}, { strict: false }),
				"users"
			);

			const hairbrushUsers = await HairbrushUser.find({});
			const hairbrushCustomers = hairbrushUsers
				.map((doc) => {
					const rawPhone = doc.phone || "";
					const rawEmail = doc.email || "";

					const emailCheck = isEmailValid(rawEmail);
					const phoneCheck = isPhoneValid(rawPhone);

					if (!emailCheck && !phoneCheck) return null;

					return {
						name: doc.name || "",
						email: rawEmail,
						phone: rawPhone,
						country: "Egypt",
						database: "hairbrush",
						schema: "users",
						email_phone: {
							phoneCheck,
							emailCheck,
						},
					};
				})
				.filter(Boolean);

			allCustomers.push(...hairbrushCustomers);
			await hairbrushConn.close();
		}

		// =============== janat_ecommerce / users (US) ===============
		{
			const janatConn = mongoose.createConnection(process.env.JANATECOMMERCE, {
				useNewUrlParser: true,
				useUnifiedTopology: true,
			});
			const JanatUser = janatConn.model(
				"User",
				new mongoose.Schema({}, { strict: false }),
				"users"
			);

			const janatUsers = await JanatUser.find({});
			const janatCustomers = janatUsers
				.map((doc) => {
					const rawPhone = doc.phone || "";
					const rawEmail = doc.email || "";

					const emailCheck = isEmailValid(rawEmail);
					const phoneCheck = isPhoneValid(rawPhone);

					if (!emailCheck && !phoneCheck) return null;

					return {
						name: doc.name || "",
						email: rawEmail,
						phone: rawPhone,
						country: "US",
						database: "janat_ecommerce",
						schema: "users",
						email_phone: {
							phoneCheck,
							emailCheck,
						},
					};
				})
				.filter(Boolean);

			allCustomers.push(...janatCustomers);
			await janatConn.close();
		}

		// =============== khan_khadija / reservations (Egypt) ========
		{
			const khanConn = mongoose.createConnection(process.env.KHANKHADIJA, {
				useNewUrlParser: true,
				useUnifiedTopology: true,
			});
			const Reservation = khanConn.model(
				"Reservation",
				new mongoose.Schema({}, { strict: false }),
				"reservations"
			);

			const khanReservations = await Reservation.find({});
			const khanCustomers = khanReservations
				.map((doc) => {
					const rawPhone = doc.phoneNumber ? String(doc.phoneNumber) : "";
					const rawEmail = doc.scheduledByUserEmail || "";

					const emailCheck = isEmailValid(rawEmail);
					const phoneCheck = isPhoneValid(rawPhone);

					if (!emailCheck && !phoneCheck) return null;

					return {
						name: doc.fullName || "",
						email: rawEmail,
						phone: rawPhone,
						country: "Egypt",
						database: "khan_khadija",
						schema: "reservations",
						email_phone: {
							phoneCheck,
							emailCheck,
						},
					};
				})
				.filter(Boolean);

			allCustomers.push(...khanCustomers);
			await khanConn.close();
		}

		// =============== palacios_towing / callingorders (US) =======
		{
			const palaciosConn = mongoose.createConnection(process.env.PALACIOS, {
				useNewUrlParser: true,
				useUnifiedTopology: true,
			});
			const CallingOrder = palaciosConn.model(
				"CallingOrder",
				new mongoose.Schema({}, { strict: false }),
				"callingorders"
			);

			const palaciosOrders = await CallingOrder.find({});
			const palaciosCustomers = palaciosOrders
				.map((doc) => {
					const rawPhone = doc.phoneNumber ? String(doc.phoneNumber) : "";
					// No email in this schema => force blank
					const rawEmail = "";

					const emailCheck = isEmailValid(rawEmail); // will be false
					const phoneCheck = isPhoneValid(rawPhone);

					if (!emailCheck && !phoneCheck) return null;

					return {
						name: doc.fullName || "",
						email: rawEmail,
						phone: rawPhone,
						country: "US",
						database: "palacios_towing",
						schema: "callingorders",
						email_phone: {
							phoneCheck,
							emailCheck,
						},
					};
				})
				.filter(Boolean);

			allCustomers.push(...palaciosCustomers);
			await palaciosConn.close();
		}

		// =============== hotels DB data (reservations + users) ===============
		{
			const hotelsConn = mongoose.createConnection(process.env.DATABASE, {
				useNewUrlParser: true,
				useUnifiedTopology: true,
			});

			// 1) "reservations"
			const Reservation = hotelsConn.model(
				"Reservation",
				new mongoose.Schema({}, { strict: false }),
				"reservations"
			);
			const hotelsReservations = await Reservation.find({});
			const hotelsResCustomers = hotelsReservations
				.map((doc) => {
					const c = doc.customer_details || {};
					const rawPhone = c.phone || "";
					const rawEmail = c.email || "";

					const emailCheck = isEmailValid(rawEmail);
					const phoneCheck = isPhoneValid(rawPhone);

					if (!emailCheck && !phoneCheck) return null;

					return {
						name: c.name || "",
						email: rawEmail,
						phone: rawPhone,
						country: c.nationality || "",
						database: "hotels",
						schema: "reservations",
						email_phone: {
							phoneCheck,
							emailCheck,
						},
					};
				})
				.filter(Boolean);

			// 2) "users" – where role === 0
			const User = hotelsConn.model(
				"User",
				new mongoose.Schema({}, { strict: false }),
				"users"
			);
			const hotelUsers = await User.find({ role: 0 });
			const hotelsUserCustomers = hotelUsers
				.map((doc) => {
					const rawPhone = doc.phone || "";
					const rawEmail = doc.email || "";

					const emailCheck = isEmailValid(rawEmail);
					const phoneCheck = isPhoneValid(rawPhone);

					if (!emailCheck && !phoneCheck) return null;

					return {
						name: doc.name || "",
						email: rawEmail,
						phone: rawPhone,
						country: doc.country || "",
						database: "hotels",
						schema: "users",
						email_phone: {
							phoneCheck,
							emailCheck,
						},
					};
				})
				.filter(Boolean);

			allCustomers.push(...hotelsResCustomers, ...hotelsUserCustomers);
			await hotelsConn.close();
		}

		// 3) Remove duplicates by email
		//    - If there's no email, treat each as unique
		const uniqueCustomers = removeDuplicatesByEmail(allCustomers);

		// 4) Insert into CustomerList
		await CustomerList.insertMany(uniqueCustomers);

		return res.json({
			success: true,
			totalCollected: allCustomers.length,
			totalUnique: uniqueCustomers.length,
			message: "CustomerList compiled successfully",
		});
	} catch (error) {
		console.error("Error in compileCustomerList:", error);
		return res.status(400).json({
			success: false,
			error: error.message,
		});
	}
};

function sanitizeReservationForPublicInvoice(doc) {
	if (!doc) return null;

	// Clone shallowly so we can delete sensitive keys
	const r = { ...doc };

	// Never expose card/credential fields on a public invoice endpoint
	if (r.customer_details) {
		delete r.customer_details.cardNumber;
		delete r.customer_details.cardExpiryDate;
		delete r.customer_details.cardCVV;
		delete r.customer_details.cardHolderName;
		delete r.customer_details.password;
		delete r.customer_details.confirmPassword;
		delete r.customer_details.transId;
		delete r.customer_details.tokenId;
	}

	// Payment gateway payloads can be very noisy; keep only what you actually display
	if (r.payment_details) {
		r.payment_details = {
			onsite_paid_amount: r.payment_details.onsite_paid_amount || 0,
			captured: !!r.payment_details.captured,
		};
	}

	return r;
}

exports.getSingleReservationInvoice = async (req, res) => {
	try {
		const { confirmation } = req.params;
		if (!confirmation || String(confirmation).trim().length === 0) {
			return res
				.status(400)
				.json({ message: "Missing or invalid confirmation number." });
		}

		// Find ONE reservation by confirmation_number
		const reservation = await Reservations.findOne({
			confirmation_number: String(confirmation).trim(),
		})
			.populate({
				path: "hotelId",
				select: "hotelName hotelAddress hotelCity phone belongsTo",
				populate: { path: "belongsTo", select: "name" },
			})
			.lean()
			.exec();

		if (!reservation) {
			return res.status(404).json({ message: "Reservation not found." });
		}

		// Build a minimal hotel “view model”
		const hotel = reservation.hotelId
			? {
					_id: reservation.hotelId._id,
					hotelName: reservation.hotelId.hotelName || "Hotel",
					hotelAddress: reservation.hotelId.hotelAddress || "",
					hotelCity: reservation.hotelId.hotelCity || "",
					phone: reservation.hotelId.phone || "",
					suppliedBy: reservation.hotelId.belongsTo?.name || null, // optional display
			  }
			: null;

		// Sanitize reservation for public invoice
		const safeReservation = sanitizeReservationForPublicInvoice(reservation);

		return res.status(200).json({
			success: true,
			reservation: safeReservation,
			hotel,
		});
	} catch (err) {
		console.error("getSingleReservationInvoice error:", err);
		return res.status(500).json({ message: "Failed to fetch reservation." });
	}
};

/**
 * GET /api/single-reservation/:confirmation/pdf
 * Streams a PDF invoice using your existing email HTML template + Puppeteer.
 */
exports.getSingleReservationInvoicePdf = async (req, res) => {
	try {
		const { confirmation } = req.params;
		if (!confirmation || String(confirmation).trim().length === 0) {
			return res
				.status(400)
				.json({ message: "Missing or invalid confirmation number." });
		}

		const reservation = await Reservations.findOne({
			confirmation_number: String(confirmation).trim(),
		})
			.populate({ path: "hotelId" })
			.lean()
			.exec();

		if (!reservation) {
			return res.status(404).json({ message: "Reservation not found." });
		}

		// Build the same shape you used when sending the email invoice
		const hotel = reservation.hotelId || {};
		const reservationData = {
			...reservation,
			hotelName: hotel.hotelName || "Hotel",
			hotelAddress: hotel.hotelAddress || "",
			hotelCity: hotel.hotelCity || "",
			hotelPhone: hotel.phone || "",
		};

		const html = ClientConfirmationEmail(reservationData);
		const pdfBuffer = await createPdfBuffer(html);

		res.setHeader("Content-Type", "application/pdf");
		res.setHeader(
			"Content-Disposition",
			`attachment; filename="Jannat_Invoice_${confirmation}.pdf"`
		);
		return res.status(200).send(pdfBuffer);
	} catch (err) {
		console.error("getSingleReservationInvoicePdf error:", err);
		return res.status(500).json({ message: "Failed to generate PDF." });
	}
};

exports.sendWhatsAppReservationConfirmation = async (req, res) => {
	try {
		const { reservationId } = req.params;
		const notifyAdmins =
			String(req.query.notifyAdmins || "false").toLowerCase() === "true";

		console.log("[WA] manual confirmation: start", {
			reservationId,
			notifyAdmins,
		});

		let reservation = null;

		// If the caller sends the whole reservation (optional), use it directly
		if (req.body && req.body.reservation) {
			reservation = req.body.reservation;
			console.log("[WA] manual confirmation: using reservation from body");
		}

		// Otherwise, find by ObjectId or by confirmation_number
		if (!reservation) {
			if (mongoose.Types.ObjectId.isValid(reservationId)) {
				reservation = await Reservations.findById(reservationId).exec();
			}
			if (!reservation) {
				reservation = await Reservations.findOne({
					confirmation_number: reservationId,
				}).exec();
			}
		}

		if (!reservation) {
			console.log("[WA] manual confirmation: reservation not found");
			return res.status(404).json({
				ok: false,
				message: "Reservation not found.",
			});
		}

		// Send the standard confirmation via WhatsApp (uses template + clickable link)
		const wa = await waSendReservationConfirmation(reservation);

		if (wa?.skipped) {
			console.log("[WA] manual confirmation: skipped", wa);
			return res.status(400).json({
				ok: false,
				message: wa?.reason || "Failed to queue WhatsApp message.",
				wa,
			});
		}

		let notify = null;
		if (notifyAdmins) {
			try {
				notify = await waNotifyNewReservation(reservation);
			} catch (e) {
				console.error(
					"[WA] manual confirmation: notifyAdmins failed",
					e?.message || e
				);
			}
		}

		console.log("[WA] manual confirmation: queued", {
			to: wa?.to,
			sid: wa?.sid,
			status: wa?.status,
			notifyAdmins: !!notifyAdmins,
		});

		return res.status(200).json({
			ok: true,
			message: "WhatsApp confirmation queued.",
			wa,
			notify,
		});
	} catch (err) {
		console.error("[WA] manual confirmation: error", err?.message || err);
		return res.status(500).json({
			ok: false,
			message: "Failed to send WhatsApp confirmation.",
			error: err?.message || String(err),
		});
	}
};
