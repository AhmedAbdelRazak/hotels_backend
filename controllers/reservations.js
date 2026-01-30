const Reservations = require("../models/reservations");
const HotelDetails = require("../models/hotel_details");
const mongoose = require("mongoose");
const ObjectId = mongoose.Types.ObjectId;
const fetch = require("node-fetch");
const Rooms = require("../models/rooms");
const HouseKeeping = require("../models/housekeeping");
const xlsx = require("xlsx");
const sgMail = require("@sendgrid/mail");
const puppeteer = require("puppeteer");
const moment = require("moment-timezone");
const saudiDateTime = moment().tz("Asia/Riyadh").format();
const {
	confirmationEmail,
	reservationUpdate,
	emailPaymentLink,
	receiptPdfTemplate,
} = require("./assets");
const { sum } = require("lodash");
const { decryptWithSecret } = require("./utils");

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const DAY_MS = 24 * 60 * 60 * 1000;
const CANCELLED_REGEX = /cancelled|canceled/i;
const NO_SHOW_REGEX = /no[_\s-]?show/i;
const CHECKED_OUT_REGEX =
	/checked[_\s-]?out|checkedout|closed|early[_\s-]?checked[_\s-]?out/i;
const IN_HOUSE_REGEX = /house/i;
const INCOMPLETE_EXCLUDED_REGEX = new RegExp(
	`${CANCELLED_REGEX.source}|${NO_SHOW_REGEX.source}|${CHECKED_OUT_REGEX.source}|house`,
	"i"
);

const getSaudiDayRange = (dateStr) => {
	if (!dateStr) return null;
	const start = new Date(`${dateStr}T00:00:00+03:00`);
	if (Number.isNaN(start.getTime())) return null;
	const end = new Date(start.getTime() + DAY_MS);
	return { start, end };
};

const buildReservationListFilter = ({ selectedFilter, hotelId, dateStr }) => {
	const dynamicFilter = { hotelId: ObjectId(hotelId) };
	const dayRange = getSaudiDayRange(dateStr);
	const addDateRange = (field) => {
		if (!dayRange) return;
		dynamicFilter[field] = { $gte: dayRange.start, $lt: dayRange.end };
	};

	if (selectedFilter === "Specific Date") {
		addDateRange("checkin_date");
		dynamicFilter.reservation_status = { $not: CANCELLED_REGEX };
		return dynamicFilter;
	}

	if (selectedFilter === "Specific Date2") {
		addDateRange("checkout_date");
		dynamicFilter.reservation_status = { $not: CANCELLED_REGEX };
		return dynamicFilter;
	}

	if (selectedFilter === "no_show") {
		addDateRange("checkin_date");
		dynamicFilter.reservation_status = NO_SHOW_REGEX;
		return dynamicFilter;
	}

	switch (selectedFilter) {
		case "Today's New Reservations":
			addDateRange("booked_at");
			dynamicFilter.reservation_status = { $not: CANCELLED_REGEX };
			break;
		case "Cancelations":
			dynamicFilter.reservation_status = CANCELLED_REGEX;
			break;
		case "Today's Arrivals":
			addDateRange("checkin_date");
			dynamicFilter.reservation_status = { $not: CANCELLED_REGEX };
			break;
		case "Today's Departures":
			addDateRange("checkout_date");
			dynamicFilter.reservation_status = { $not: CANCELLED_REGEX };
			break;
		case "Incomplete reservations":
			dynamicFilter.reservation_status = { $not: INCOMPLETE_EXCLUDED_REGEX };
			break;
		case "In House":
			dynamicFilter.reservation_status = IN_HOUSE_REGEX;
			break;
		default:
			break;
	}

	return dynamicFilter;
};

const buildReservationSearchMatch = (searchQuery) => {
	const trimmed = String(searchQuery || "").trim();
	if (!trimmed) return null;

	const isRoomSearch = /^r\d+$/i.test(trimmed);
	const queryValue = isRoomSearch ? trimmed.substring(1) : trimmed;
	const searchPattern = new RegExp(queryValue, "i");

	if (isRoomSearch) {
		return { "roomDetails.room_number": searchPattern };
	}

	return {
		$or: [
			{ "customer_details.name": searchPattern },
			{ "customer_details.phone": searchPattern },
			{ "customer_details.email": searchPattern },
			{ "customer_details.carLicensePlate": searchPattern },
			{ "customer_details.carColor": searchPattern },
			{ "customer_details.carModel": searchPattern },
			{ "customer_details.passport": searchPattern },
			{ "customer_details.passportExpiry": searchPattern },
			{ "customer_details.nationality": searchPattern },
			{ confirmation_number: searchPattern },
			{ reservation_id: searchPattern },
			{ reservation_status: searchPattern },
			{ booking_source: searchPattern },
			{ payment: searchPattern },
			{ "roomDetails.room_number": searchPattern },
		],
	};
};

exports.reservationById = (req, res, next, id) => {
	Reservations.findById(id).exec((err, reservations) => {
		if (err || !reservations) {
			return res.status(400).json({
				error: "reservations was not found",
			});
		}
		req.reservations = reservations;
		next();
	});
};

function generateRandomNumber() {
	let randomNumber = Math.floor(1000000000 + Math.random() * 9000000000); // Generates a 10-digit number
	return randomNumber.toString();
}

// Modified ensureUniqueNumber function to accept field name
function ensureUniqueNumber(model, fieldName, callback) {
	const randomNumber = generateRandomNumber();
	let query = {};
	query[fieldName] = randomNumber;
	model.findOne(query, (err, doc) => {
		if (err) {
			callback(err);
		} else if (doc) {
			ensureUniqueNumber(model, fieldName, callback); // Recursively generate a new number if the current one exists
		} else {
			callback(null, randomNumber);
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
			"--single-process", // <- this one doesn't works in Windows
			"--disable-gpu",
		],
	});

	const page = await browser.newPage();
	await page.setContent(html, { waitUntil: "networkidle0" });
	const pdfBuffer = await page.pdf({ format: "A4", printBackground: true });
	await browser.close();
	return pdfBuffer;
};

const sendEmailWithPdf = async (reservationData, opts = {}) => {
	// Dynamically generating HTML content for the email body and PDF
	const htmlContent = confirmationEmail(reservationData);
	const hotelForPdf =
		reservationData?.hotelId && typeof reservationData.hotelId === "object"
			? reservationData.hotelId
			: {
					hotelName: reservationData?.hotelName || "",
					suppliedBy: reservationData?.belongsTo?.name || "",
			  };
	const pdfHtml = receiptPdfTemplate(reservationData, hotelForPdf);
	const pdfBuffer = await createPdfBuffer(pdfHtml);
	const toEmail =
		opts.toEmail ||
		reservationData?.customer_details?.email ||
		"ahmedabdelrazak20@gmail.com";

	const FormSubmittionEmail = {
		to: toEmail,
		from: "noreply@jannatbooking.com",
		// cc: [
		// 	{ email: "ayed.hotels@gmail.com" },
		// 	{ email: "zaerhotel@gmail.com" },
		// 	{ email: "3yedhotel@gmail.com" },
		// 	{ email: "morazzakhamouda@gmail.com" },
		// ],
		bcc: [
			{ email: "morazzakhamouda@gmail.com" },
			{ email: "xhoteleg@gmail.com" },
			{ email: "ahmed.abdelrazak@jannatbooking.com" },
			{ email: "support@jannatbooking.com" },
		],
		subject: `Jannat Booking - Reservation Confirmation`,
		html: htmlContent,
		attachments: [
			{
				content: pdfBuffer.toString("base64"),
				filename: "Reservation_Confirmation.pdf",
				type: "application/pdf",
				disposition: "attachment",
			},
		],
	};

	try {
		await sgMail.send(FormSubmittionEmail);
	} catch (error) {
		console.error(
			"Error sending email with PDF error.response.boyd",
			error.response.body
		);
		console.error("Error sending email with PDF", error);
		// Handle error appropriately
	}
};

exports.create = async (req, res) => {
	console.log(req.body, "req.body");
	console.log(req.body.sendEmail, "req.body.sendEmail");
	console.log(req.body.hotelName, "req.body.hotelName");
	console.log(req.body.belongsTo, "req.body.belongsTo");

	const saveReservation = async (reservationData) => {
		// Check if roomId array is present and has length more than 0
		if (reservationData.roomId && reservationData.roomId.length > 0) {
			try {
				// Update cleanRoom field for all rooms in the roomId array
				await Rooms.updateMany(
					{ _id: { $in: reservationData.roomId } },
					{ $set: { cleanRoom: false } }
				);
			} catch (err) {
				console.error("Error updating Rooms cleanRoom status", err);
				// Optionally, handle the error, for example, by returning a response
				// return res.status(500).json({ error: "Error updating room status" });
			}
		}

		const reservations = new Reservations(reservationData);
		try {
			const data = await reservations.save();
			res.json({ data });
			if (req.body.sendEmail) {
				await sendEmailWithPdf(reservationData);
			}
		} catch (err) {
			console.log(err, "err");
			return res.status(400).json({
				error: "Cannot Create reservations",
			});
		}
	};

	if (!req.body.confirmation_number) {
		ensureUniqueNumber(
			Reservations,
			"confirmation_number",
			async (err, uniqueNumber) => {
				if (err) {
					return res
						.status(500)
						.json({ error: "Error checking for unique number" });
				}
				req.body.confirmation_number = uniqueNumber;
				saveReservation(req.body);
			}
		);
	} else {
		saveReservation(req.body);
	}
};

exports.sendReservationEmail = async (req, res) => {
	const reservationData = req.body; // full reservation payload
	// Fetch the reservation data based on reservationId
	// This is a placeholder, replace it with your actual data fetching logic

	if (!reservationData) {
		return res.status(404).json({ error: "Reservation not found" });
	}

	try {
		const overrideEmail = req.body?.overrideEmail || req.body?.customerEmail;
		if (overrideEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(overrideEmail)) {
			return res.status(400).json({ error: "Invalid email address" });
		}
		await sendEmailWithPdf(reservationData, {
			toEmail: overrideEmail || reservationData?.customer_details?.email,
		});
		res.json({ message: "Email sent successfully" });
	} catch (error) {
		console.error("Error sending email:", error);
		res.status(500).json({ error: "Failed to send email" });
	}
};

exports.sendPaymentLinkEmail = async (req, res) => {
	const {
		paymentLink,
		customerEmail,
		guestName,
		hotelName,
		confirmationNumber,
		totalAmount,
		paidAmount,
		currency,
		checkinDate,
		checkoutDate,
	} = req.body; // payment link + optional context

	if (!paymentLink || !customerEmail) {
		return res
			.status(400)
			.json({ error: "Missing payment link or customer email" });
	}

	const emailContent = emailPaymentLink({
		paymentLink,
		guestName,
		hotelName,
		confirmationNumber,
		totalAmount,
		paidAmount,
		currency,
		checkinDate,
		checkoutDate,
	}); // Generate the email content with the payment link

	const subjectBase = hotelName
		? `Payment Link - ${hotelName}`
		: "Reservation Payment Link";
	const subject = confirmationNumber
		? `${subjectBase} (#${confirmationNumber})`
		: subjectBase;

	const email = {
		to: customerEmail, // The customer's email address
		from: "noreply@jannatbooking.com",
		// cc: [
		// 	{ email: "ayed.hotels@gmail.com" },
		// 	{ email: "zaerhotel@gmail.com" },
		// 	{ email: "3yedhotel@gmail.com" },
		// 	{ email: "morazzakhamouda@gmail.com" },
		// ],
		bcc: [
			{ email: "morazzakhamouda@gmail.com" },
			{ email: "xhoteleg@gmail.com" },
			{ email: "ahmed.abdelrazak@jannatbooking.com" },
			{ email: "support@jannatbooking.com" },
		],
		subject,
		html: emailContent, // Use the generated HTML content
	};

	try {
		await sgMail.send(email);
		res.json({ message: "Payment link email sent successfully" });
	} catch (error) {
		console.error("Error sending payment link email:", error);
		res.status(500).json({ error: "Failed to send payment link email" });
	}
};

exports.reservationSearchAllList = async (req, res) => {
	try {
		const { searchQuery, accountId } = req.params;
		const hotelId = mongoose.Types.ObjectId(accountId);

		// Check if search query starts with 'r' followed by digits
		const isRoomSearch = /^r\d+$/i.test(searchQuery);
		let roomNumberSearchPattern;
		if (isRoomSearch) {
			// Extract the room number from the search query
			roomNumberSearchPattern = new RegExp(searchQuery.substring(1), "i");
		} else {
			// Regular search pattern for other fields
			roomNumberSearchPattern = new RegExp(searchQuery, "i");
		}

		let pipeline = [
			{ $match: { hotelId: hotelId } },
			// Lookup (populate) roomId details
			{
				$lookup: {
					from: "rooms",
					localField: "roomId",
					foreignField: "_id",
					as: "roomDetails",
				},
			},
			// Lookup (populate) belongsTo details
			{
				$lookup: {
					from: "users",
					localField: "belongsTo",
					foreignField: "_id",
					as: "belongsToDetails",
				},
			},
		];

		// Conditionally adjust the match stage based on the search type
		if (isRoomSearch) {
			// Add match stage for room number search
			pipeline.push({
				$match: {
					"roomDetails.room_number": roomNumberSearchPattern,
				},
			});
		} else {
			// Add match stage for general search
			pipeline.push({
				$match: {
					$or: [
						{ "customer_details.name": roomNumberSearchPattern },
						{ "customer_details.phone": roomNumberSearchPattern },
						{ "customer_details.email": roomNumberSearchPattern },
						{ "customer_details.carLicensePlate": roomNumberSearchPattern },
						{ "customer_details.carColor": roomNumberSearchPattern },
						{ "customer_details.carModel": roomNumberSearchPattern },
						{ "customer_details.passport": roomNumberSearchPattern },
						{ "customer_details.passportExpiry": roomNumberSearchPattern },
						{ "customer_details.nationality": roomNumberSearchPattern },
						{ confirmation_number: roomNumberSearchPattern },
						{ reservation_id: roomNumberSearchPattern },
						{ reservation_status: roomNumberSearchPattern },
						{ booking_source: roomNumberSearchPattern },
						{ payment: roomNumberSearchPattern },
						// Include room number search in general search as well
						{ "roomDetails.room_number": roomNumberSearchPattern },
					],
				},
			});
		}

		// Execute the aggregation pipeline
		const reservations = await Reservations.aggregate(pipeline);

		if (reservations.length === 0) {
			return res.status(404).json({
				error: "No reservations found matching the search criteria.",
			});
		}

		res.json(reservations);
	} catch (error) {
		console.error("Error in reservationSearchAllList:", error);
		res.status(500).send("Server error");
	}
};

exports.reservationSearch = async (req, res) => {
	try {
		const { searchQuery, accountId } = req.params;
		const hotelId = mongoose.Types.ObjectId(accountId);
		// Create a regex pattern to match the search query in a case-insensitive manner
		const searchPattern = new RegExp(searchQuery, "i");

		// Query to search across various fields
		const query = {
			hotelId: hotelId,
			$or: [
				{ "customer_details.name": searchPattern },
				{ "customer_details.phone": searchPattern },
				{ "customer_details.email": searchPattern },
				{ "customer_details.passport": searchPattern },
				{ "customer_details.passportExpiry": searchPattern },
				{ "customer_details.nationality": searchPattern },
				{ confirmation_number: searchPattern },
				{ provider_number: searchPattern },
			],
		};

		// Fetch the first matching document
		const reservation = await Reservations.findOne(query).populate("belongsTo");

		if (!reservation) {
			return res.status(404).json({
				error: "No reservation found matching the search criteria.",
			});
		}

		res.json(reservation);
	} catch (error) {
		res.status(500).send("Server error");
	}
};

// Normalize room names
function normalizeRoomName(apiRoomName) {
	return apiRoomName.split(" - ")[0].trim();
}

// Mapping function for room type
function mapRoomType(apiRoomName) {
	const normalizedRoomName = normalizeRoomName(apiRoomName);
	const roomTypeMappings = {
		// Add mappings similar to your previous implementation
	};
	return roomTypeMappings[normalizedRoomName] || normalizedRoomName;
}

// Main mapping function for Hotel Runner response to reservationsSchema
function mapHotelRunnerResponseToSchema(apiResponse) {
	const mappedRooms = apiResponse.rooms.map((room) => ({
		room_type: mapRoomType(room.name),
		chosenPrice: room.total,
		count: 1, // Assuming each room object represents one room
	}));

	return {
		reservation_id: apiResponse.hr_number,
		hr_number: apiResponse.hr_number,
		confirmation_number: apiResponse.provider_number.toString(),
		pms_number: apiResponse.pms_number,
		booking_source: apiResponse.channel_display.toLowerCase(),
		customer_details: {
			name: `${apiResponse.firstname} ${apiResponse.lastname}`,
			phone: apiResponse.address.phone,
			email: apiResponse.address.email,
			passport: apiResponse.guest_national_id,
			nationality: apiResponse.country,
		},
		state: apiResponse.state,
		reservation_status: apiResponse.state,
		total_guests: apiResponse.total_guests,
		total_rooms: apiResponse.total_rooms,
		cancel_reason: apiResponse.cancel_reason,
		booked_at: new Date(apiResponse.completed_at),
		sub_total: apiResponse.sub_total,
		extras_total: apiResponse.extras_total,
		tax_total: apiResponse.tax_total,
		total_amount: apiResponse.total,
		currency: apiResponse.currency,
		checkin_date: new Date(apiResponse.checkin_date),
		checkout_date: new Date(apiResponse.checkout_date),
		comment: apiResponse.note,
		payment: apiResponse.payment,
		payment_details: apiResponse.payment_details,
		paid_amount: apiResponse.paid_amount,
		payments: apiResponse.payments,
		pickedRoomsType: mappedRooms,
		days_of_residence: calculateDaysBetweenDates(
			apiResponse.checkin_date,
			apiResponse.checkout_date
		),
		// Assuming roomId, belongsTo, and hotelId will be set in the main function
	};
}

// Helper function for date difference
function calculateDaysBetweenDates(startDate, endDate) {
	const start = new Date(startDate);
	const end = new Date(endDate);
	return (end - start) / (1000 * 60 * 60 * 24);
}

exports.getListOfReservations = async (req, res) => {
	try {
		const { page, records, filters, hotelId, date } = req.params;
		const parsedPage = parseInt(page);
		const parsedRecords = parseInt(records);

		if (
			isNaN(parsedPage) ||
			isNaN(parsedRecords) ||
			!ObjectId.isValid(hotelId)
		) {
			return res.status(400).send("Invalid parameters");
		}

		let parsedFilters = {};
		try {
			parsedFilters = JSON.parse(filters);
		} catch (_) {
			parsedFilters = {};
		}

		const dynamicFilter = buildReservationListFilter({
			selectedFilter: parsedFilters.selectedFilter,
			hotelId,
			dateStr: date,
		});
		const searchMatch = buildReservationSearchMatch(parsedFilters.searchQuery);

		const pipeline = [{ $match: dynamicFilter }];

		if (searchMatch) {
			pipeline.push(
				{
					$lookup: {
						from: "rooms",
						localField: "roomId",
						foreignField: "_id",
						as: "roomDetails",
					},
				},
				{ $match: searchMatch }
			);
		}

		pipeline.push(
			{ $sort: { booked_at: -1 } },
			{ $skip: (parsedPage - 1) * parsedRecords },
			{ $limit: parsedRecords }
		);

		if (!searchMatch) {
			pipeline.push({
				$lookup: {
					from: "rooms",
					localField: "roomId",
					foreignField: "_id",
					as: "roomDetails",
				},
			});
		}

		const reservations = await Reservations.aggregate(pipeline);
		res.json(reservations);
	} catch (error) {
		console.error(error);
		res.status(500).send("Server error: " + error.message);
	}
};

exports.totalRecordsReservations = async (req, res) => {
	try {
		const { filters, hotelId, date } = req.params;

		if (!ObjectId.isValid(hotelId)) {
			return res.status(400).send("Invalid parameters");
		}

		let parsedFilters = {};
		try {
			parsedFilters = JSON.parse(filters);
		} catch (_) {
			parsedFilters = {};
		}
		const dynamicFilter = buildReservationListFilter({
			selectedFilter: parsedFilters.selectedFilter,
			hotelId,
			dateStr: date,
		});
		const searchMatch = buildReservationSearchMatch(parsedFilters.searchQuery);

		if (!searchMatch) {
			const total = await Reservations.countDocuments(dynamicFilter);
			return res.json({ total });
		}

		const pipeline = [
			{ $match: dynamicFilter },
			{
				$lookup: {
					from: "rooms",
					localField: "roomId",
					foreignField: "_id",
					as: "roomDetails",
				},
			},
			{ $match: searchMatch },
			{ $count: "total" },
		];

		const result = await Reservations.aggregate(pipeline);
		const total = result?.[0]?.total || 0;
		return res.json({ total });
	} catch (error) {
		console.error("Error fetching total records:", error);
		res.status(500).send("Server error");
	}
};

exports.totalCheckoutRecords = async (req, res) => {
	try {
		const { accountId, channel, startDate, endDate } = req.params;

		if (!ObjectId.isValid(accountId) || !startDate || !endDate) {
			return res.status(400).send("Invalid parameters");
		}

		const formattedStartDate = new Date(`${startDate}T00:00:00+00:00`);
		const formattedEndDate = new Date(`${endDate}T23:59:59+00:00`);

		let dynamicFilter = {
			hotelId: ObjectId(accountId),
			reservation_status: {
				$regex: "checked_out", // Use a regular expression to match the status text
				$options: "i", // Case-insensitive matching
			},
			$or: [
				{ checkout_date: { $gte: formattedStartDate, $lte: formattedEndDate } },
				{
					$and: [
						{ checkout_date: { $gte: formattedStartDate } },
						{ checkout_date: { $lte: formattedEndDate } },
					],
				},
			],
		};

		if (channel && channel !== "undefined") {
			const channelFilter = {
				booking_source: { $regex: new RegExp(channel, "i") },
			};
			const channelExists = await Reservations.findOne(channelFilter);
			if (channelExists) {
				dynamicFilter.booking_source = { $regex: new RegExp(channel, "i") };
			}
		}

		const total = await Reservations.countDocuments(dynamicFilter);

		const aggregation = await Reservations.aggregate([
			{ $match: dynamicFilter },
			{
				$group: {
					_id: null,
					total_amount: { $sum: "$total_amount" },
					commission: {
						$sum: {
							$cond: [
								{ $eq: ["$payment", "expedia collect"] },
								0,
								{
									$cond: [
										{
											$in: [
												"$booking_source",
												["jannat", "affiliate", "janat"],
											],
										},
										{ $multiply: ["$total_amount", 0.1] },
										{ $subtract: ["$total_amount", "$sub_total"] },
									],
								},
							],
						},
					},
				},
			},
		]);

		const result = {
			total: total,
			total_amount: aggregation.length > 0 ? aggregation[0].total_amount : 0,
			commission: aggregation.length > 0 ? aggregation[0].commission : 0,
		};

		res.json(result);
	} catch (error) {
		console.error("Error fetching total checkout records:", error);
		res.status(500).send("Server error");
	}
};

exports.checkedoutReport = async (req, res) => {
	try {
		const { accountId, channel, startDate, endDate, page, records } =
			req.params;
		const parsedPage = parseInt(page);
		const parsedRecords = parseInt(records);

		if (
			isNaN(parsedPage) ||
			isNaN(parsedRecords) ||
			!ObjectId.isValid(accountId) ||
			!startDate ||
			!endDate
		) {
			return res.status(400).send("Invalid parameters");
		}

		const formattedStartDate = new Date(`${startDate}T00:00:00+00:00`);
		const formattedEndDate = new Date(`${endDate}T23:59:59+00:00`);

		let dynamicFilter = {
			hotelId: ObjectId(accountId),
			reservation_status: {
				$regex: "checked_out", // Use a regular expression to match the status text
				$options: "i", // Case-insensitive matching
			},
			$or: [
				{ checkout_date: { $gte: formattedStartDate, $lte: formattedEndDate } },
				{
					$and: [
						{ checkout_date: { $gte: formattedStartDate } },
						{ checkout_date: { $lte: formattedEndDate } },
					],
				},
			],
		};

		if (channel && channel !== "undefined") {
			const channelFilter = {
				booking_source: { $regex: new RegExp(channel, "i") },
			};
			const channelExists = await Reservations.findOne(channelFilter);
			if (channelExists) {
				dynamicFilter.booking_source = { $regex: new RegExp(channel, "i") };
			}
		}

		const pipeline = [
			{ $match: dynamicFilter },
			{ $sort: { checkout_date: -1 } },
			{ $skip: (parsedPage - 1) * parsedRecords },
			{ $limit: parsedRecords },
			{
				$lookup: {
					from: "rooms",
					localField: "roomId",
					foreignField: "_id",
					as: "roomDetails",
				},
			},
		];

		const reservations = await Reservations.aggregate(pipeline);
		res.json(reservations);
	} catch (error) {
		console.error(error);
		res.status(500).send("Server error: " + error.message);
	}
};

exports.totalGeneralReservationsRecords = async (req, res) => {
	try {
		const {
			accountId,
			channel,
			startDate,
			endDate,
			dateBy,
			noshow,
			cancel,
			inhouse,
			checkedout,
			payment,
		} = req.params;

		if (
			!ObjectId.isValid(accountId) ||
			!startDate ||
			!endDate ||
			!["checkin", "checkout", "bookat"].includes(dateBy)
		) {
			return res.status(400).send("Invalid parameters");
		}

		const formattedStartDate = new Date(`${startDate}T00:00:00+00:00`);
		const formattedEndDate = new Date(`${endDate}T23:59:59+00:00`);

		let dateField =
			dateBy === "checkin"
				? "checkin_date"
				: dateBy === "checkout"
				? "checkout_date"
				: "booked_at";

		let dynamicFilter = {
			hotelId: ObjectId(accountId),
			[dateField]: { $gte: formattedStartDate, $lte: formattedEndDate },
		};

		if (channel && channel !== "undefined") {
			dynamicFilter.booking_source = { $regex: new RegExp(channel, "i") };
		}

		if (noshow === "1") {
			dynamicFilter.reservation_status = { $ne: "no_show" };
		} else if (noshow === "2") {
			dynamicFilter.reservation_status = "no_show";
		}

		if (cancel === "1") {
			dynamicFilter.reservation_status = {
				$nin: ["cancelled", "canceled", "no_show", "No_show"],
			};
		} else if (cancel === "2") {
			dynamicFilter.reservation_status = {
				$in: ["cancelled", "canceled", "no_show", "No_show"],
			};
		}

		if (inhouse === "1") {
			dynamicFilter.reservation_status = "inhouse";
		}

		if (checkedout === "1") {
			dynamicFilter.reservation_status = "checked_out";
		}

		if (payment === "true") {
			dynamicFilter.payment = "collected";
		}

		const total = await Reservations.countDocuments(dynamicFilter);

		const aggregation = await Reservations.aggregate([
			{ $match: dynamicFilter },
			{
				$group: {
					_id: null,
					total_amount: { $sum: "$total_amount" },
					commission: {
						$sum: {
							$cond: [
								{ $eq: ["$payment", "expedia collect"] },
								0,
								{
									$cond: [
										{
											$in: [
												"$booking_source",
												["janat", "affiliate", "jannat"],
											],
										},
										{ $multiply: ["$total_amount", 0.1] },
										{ $subtract: ["$total_amount", "$sub_total"] },
									],
								},
							],
						},
					},
				},
			},
		]);

		const result = {
			total: total,
			total_amount: aggregation.length > 0 ? aggregation[0].total_amount : 0,
			commission: aggregation.length > 0 ? aggregation[0].commission : 0,
		};

		res.json(result);
	} catch (error) {
		console.error("Error fetching total general reservations records:", error);
		res.status(500).send("Server error");
	}
};

exports.generalReservationsReport = async (req, res) => {
	try {
		const {
			accountId,
			channel,
			startDate,
			endDate,
			page,
			records,
			dateBy,
			noshow,
			cancel,
			inhouse,
			checkedout,
			payment,
		} = req.params;
		const parsedPage = parseInt(page);
		const parsedRecords = parseInt(records);

		if (
			isNaN(parsedPage) ||
			isNaN(parsedRecords) ||
			!ObjectId.isValid(accountId) ||
			!startDate ||
			!endDate ||
			!["checkin", "checkout", "bookat"].includes(dateBy)
		) {
			return res.status(400).send("Invalid parameters");
		}

		const formattedStartDate = new Date(`${startDate}T00:00:00+00:00`);
		const formattedEndDate = new Date(`${endDate}T23:59:59+00:00`);

		let dateField =
			dateBy === "checkin"
				? "checkin_date"
				: dateBy === "checkout"
				? "checkout_date"
				: "booked_at";

		let dynamicFilter = {
			hotelId: ObjectId(accountId),
			[dateField]: { $gte: formattedStartDate, $lte: formattedEndDate },
		};

		if (channel && channel !== "undefined") {
			dynamicFilter.booking_source = { $regex: new RegExp(channel, "i") };
		}

		if (noshow === "1") {
			dynamicFilter.reservation_status = { $ne: "no_show" };
		} else if (noshow === "2") {
			dynamicFilter.reservation_status = "no_show";
		}

		if (cancel === "1") {
			dynamicFilter.reservation_status = {
				$nin: ["cancelled", "canceled", "no_show", "No_show"],
			};
		} else if (cancel === "2") {
			dynamicFilter.reservation_status = {
				$in: ["cancelled", "canceled", "no_show", "No_show"],
			};
		}

		if (inhouse === "1") {
			dynamicFilter.reservation_status = "inhouse";
		}

		if (checkedout === "1") {
			dynamicFilter.reservation_status = "checked_out";
		}

		if (payment === "true") {
			dynamicFilter.payment = "collected";
		}

		const pipeline = [
			{ $match: dynamicFilter },
			{ $sort: { [dateField]: -1 } },
			{ $skip: (parsedPage - 1) * parsedRecords },
			{ $limit: parsedRecords },
			{
				$lookup: {
					from: "rooms",
					localField: "roomId",
					foreignField: "_id",
					as: "roomDetails",
				},
			},
			{
				$addFields: {
					roomCount: {
						$reduce: {
							input: "$pickedRoomsType",
							initialValue: 0,
							in: { $add: ["$$value", "$$this.count"] },
						},
					},
				},
			},
		];

		const reservations = await Reservations.aggregate(pipeline);
		res.json(reservations);
	} catch (error) {
		console.error(error);
		res.status(500).send("Server error: " + error.message);
	}
};

exports.reservationObjectSummary = async (req, res) => {
	try {
		const { accountId, date } = req.params;
		const formattedDate = new Date(`${date}T00:00:00+03:00`); // Use Saudi Arabia time zone

		const aggregation = await Reservations.aggregate([
			{
				$match: { hotelId: mongoose.Types.ObjectId(accountId) },
			},
			{
				$addFields: {
					// Convert dates to start of day for comparison
					bookedAtStartOfDay: {
						$dateTrunc: {
							date: "$booked_at",
							unit: "day",
							timezone: "+03:00",
						},
					},
					checkinStartOfDay: {
						$dateTrunc: {
							date: "$checkin_date",
							unit: "day",
							timezone: "+03:00",
						},
					},
					checkoutStartOfDay: {
						$dateTrunc: {
							date: "$checkout_date",
							unit: "day",
							timezone: "+03:00",
						},
					},
					// Flag to indicate non-cancelled reservations
					nonCancelled: {
						$cond: {
							if: {
								$regexMatch: {
									input: "$reservation_status",
									regex: CANCELLED_REGEX,
								},
							},
							then: false,
							else: true,
						},
					},
				},
			},
			{
				$group: {
					_id: null,
					newReservations: {
						$sum: {
							$cond: [
								{
									$and: [
										{ $eq: ["$bookedAtStartOfDay", formattedDate] },
										{ $eq: ["$nonCancelled", true] },
									],
								},
								1,
								0,
							],
						},
					},
					cancellations: {
						$sum: {
							$cond: [
								{
									$regexMatch: {
										input: "$reservation_status",
										regex: CANCELLED_REGEX,
									},
								},
								1,
								0,
							],
						},
					},
					todayArrival: {
						$sum: {
							$cond: [
								{
									$and: [
										{ $eq: ["$checkinStartOfDay", formattedDate] },
										{ $eq: ["$nonCancelled", true] },
									],
								},
								1,
								0,
							],
						},
					},
					departureToday: {
						$sum: {
							$cond: [
								{
									$and: [
										{ $eq: ["$checkoutStartOfDay", formattedDate] },
										{ $eq: ["$nonCancelled", true] },
									],
								},
								1,
								0,
							],
						},
					},
					inHouse: {
						$sum: {
							$cond: [
								{
									$regexMatch: {
										input: "$reservation_status",
										regex: IN_HOUSE_REGEX,
									},
								},
								1,
								0,
							],
						},
					},
					inComplete: {
						$sum: {
							$cond: [
								{
									$and: [
										{
											$not: {
												$regexMatch: {
													input: "$reservation_status",
													regex: INCOMPLETE_EXCLUDED_REGEX,
												},
											},
										},
									],
								},
								1,
								0,
							],
						},
					},
					allReservations: { $sum: 1 }, // Count all reservations/documents
				},
			},
		]);

		// Since aggregation always returns an array, we take the first element
		const summary =
			aggregation.length > 0
				? aggregation[0]
				: {
						newReservations: 0,
						cancellations: 0,
						todayArrival: 0,
						departureToday: 0,
						inHouse: 0,
						inComplete: 0,
						allReservations: 0,
				  };

		res.json(summary);
	} catch (error) {
		console.error("Error fetching reservation summary:", error);
		res.status(500).send("Server error");
	}
};

exports.removeDuplicates_ConfirmationNumber = async (req, res) => {
	try {
		const groupedReservations = await Reservations.aggregate([
			{
				$sort: { createdAt: -1 },
			},
			{
				$group: {
					_id: "$confirmation_number",
					docId: { $first: "$_id" },
				},
			},
		]);

		const idsToKeep = groupedReservations.map((group) => group.docId);

		await Reservations.deleteMany({ _id: { $nin: idsToKeep } });

		res.json({ message: "Duplicates removed successfully" });
	} catch (error) {
		console.error("Error in removeDuplicates_ConfirmationNumber:", error);
		res.status(500).send("Internal Server Error");
	}
};

const normalizeDisplayName = (value) => {
	if (value === null || value === undefined) return "";
	return String(value).trim();
};

exports.syncReservationRoomTypesByDisplayName = async (req, res) => {
	try {
		const { hotelId, dryRun } = req.query;
		const isDryRun = String(dryRun).toLowerCase() === "true";
		const hotelFilter = {};
		const reservationFilter = {};

		if (hotelId) {
			if (!ObjectId.isValid(hotelId)) {
				return res.status(400).json({ error: "Invalid hotelId" });
			}
			const parsedHotelId = new ObjectId(hotelId);
			hotelFilter._id = parsedHotelId;
			reservationFilter.hotelId = parsedHotelId;
		}

		const hotels = await HotelDetails.find(hotelFilter)
			.select("_id roomCountDetails.roomType roomCountDetails.displayName")
			.lean();

		if (!hotels.length) {
			return res.status(404).json({ error: "No hotels found to process" });
		}

		const roomTypeMapByHotel = new Map();
		const duplicateDisplayNames = {};

		hotels.forEach((hotel) => {
			const displayNameMap = new Map();
			const duplicates = new Set();
			(hotel.roomCountDetails || []).forEach((room) => {
				const displayName = normalizeDisplayName(room?.displayName);
				const roomType = room?.roomType;
				if (!displayName || !roomType) return;
				if (displayNameMap.has(displayName)) {
					if (displayNameMap.get(displayName) !== roomType) {
						duplicates.add(displayName);
					}
					return;
				}
				displayNameMap.set(displayName, roomType);
			});

			if (duplicates.size > 0) {
				duplicateDisplayNames[String(hotel._id)] = Array.from(duplicates);
			}

			roomTypeMapByHotel.set(String(hotel._id), displayNameMap);
		});

		const reservations = await Reservations.find(reservationFilter)
			.select("_id hotelId pickedRoomsType")
			.lean();

		let reservationsScanned = 0;
		let reservationsUpdated = 0;
		let roomsUpdated = 0;
		const bulkOps = [];

		reservations.forEach((reservation) => {
			reservationsScanned += 1;
			const hotelKey = String(reservation.hotelId || "");
			const displayNameMap = roomTypeMapByHotel.get(hotelKey);
			if (!displayNameMap || !Array.isArray(reservation.pickedRoomsType)) {
				return;
			}

			let changed = false;
			const updatedRooms = reservation.pickedRoomsType.map((room) => {
				const displayName = normalizeDisplayName(
					room?.displayName || room?.display_name
				);
				if (!displayName) return room;

				const expectedRoomType = displayNameMap.get(displayName);
				if (!expectedRoomType || expectedRoomType === room?.room_type) {
					return room;
				}

				roomsUpdated += 1;
				changed = true;
				return { ...room, room_type: expectedRoomType };
			});

			if (!changed) return;

			reservationsUpdated += 1;
			if (isDryRun) return;

			bulkOps.push({
				updateOne: {
					filter: { _id: reservation._id },
					update: { $set: { pickedRoomsType: updatedRooms } },
				},
			});
		});

		if (!isDryRun && bulkOps.length) {
			await Reservations.bulkWrite(bulkOps);
		}

		return res.json({
			success: true,
			dryRun: isDryRun,
			hotelsProcessed: hotels.length,
			reservationsScanned,
			reservationsUpdated,
			roomsUpdated,
			duplicateDisplayNames,
		});
	} catch (error) {
		console.error("Error syncing reservation room types:", error);
		return res.status(500).json({ error: "Internal Server Error" });
	}
};

exports.singleReservation = (req, res) => {
	const token = process.env.HOTEL_RUNNER_TOKEN;
	const hrId = process.env.HR_ID;
	const reservationNumber = req.params.reservationNumber;
	const hotelId = req.params.hotelId; // Assuming you are passing hotelId as a parameter
	const belongsTo = req.params.belongsTo; // Assuming you are passing belongsTo as a parameter

	const queryParams = new URLSearchParams({
		token: token,
		hr_id: hrId,
		reservation_number: reservationNumber,
		// ... other query params
	}).toString();

	const url = `https://app.hotelrunner.com/api/v2/apps/reservations?${queryParams}`;

	fetch(url)
		.then((apiResponse) => {
			if (!apiResponse.ok) {
				throw new Error(`HTTP error! status: ${apiResponse.status}`);
			}
			return apiResponse.json();
		})
		.then((data) => {
			if (!data.reservations || data.reservations.length === 0) {
				throw new Error("No reservations found");
			}
			const reservation = data.reservations[0]; // Assuming we are interested in the first reservation

			const mappedReservation = mapHotelRunnerResponseToSchema(reservation);
			mappedReservation.belongsTo = belongsTo;
			mappedReservation.hotelId = hotelId;

			// Create a new PreReservation document
			return new PreReservation(mappedReservation).save();
		})
		.then((newReservation) => {
			res.json(newReservation); // Send back the newly created PreReservation document
		})
		.catch((error) => {
			console.error("API request error:", error);
			res
				.status(500)
				.json({ error: "Error fetching and processing reservation" });
		});
};

const maskCardNumber = (cardNumber) => {
	if (!cardNumber || cardNumber.length < 4) return "Invalid Card Number";

	const lastFour = cardNumber.slice(-4);
	const maskedSection = "*".repeat(cardNumber.length - 4);
	return `${maskedSection}${lastFour}`;
};

/**
 * Retrieves a single reservation by ID, decrypts sensitive customer details,
 * masks the card number, and excludes other sensitive information from the response.
 */
exports.singleReservationById = async (req, res) => {
	try {
		// Extract reservationId from request parameters
		const { reservationId } = req.params;

		// Find the reservation by its ID and populate related fields
		const reservation = await Reservations.findById(reservationId)
			.populate({
				path: "hotelId",
				model: "HotelDetails", // Ensure this matches the name of your HotelDetails model
			})
			.populate("belongsTo") // Optionally populate other referenced fields
			.exec();

		// If reservation not found, return a 404 error
		if (!reservation) {
			return res.status(404).json({
				message: `Reservation not found with id ${reservationId}`,
			});
		}

		// Decrypt sensitive customer details
		const decryptedCardNumber = decryptWithSecret(
			reservation.customer_details.cardNumber
		);
		const decryptedCardExpiryDate = decryptWithSecret(
			reservation.customer_details.cardExpiryDate
		);

		// Mask the card number to show only the last four digits
		const maskedCardNumber = maskCardNumber(decryptedCardNumber);

		// Construct the decrypted and masked customer details
		const decryptedCustomerDetails = {
			...reservation.customer_details, // Spread existing customer details
			cardNumber: maskedCardNumber, // Masked card number
			cardExpiryDate: decryptedCardExpiryDate, // Fully decrypted expiry date
			// Exclude cardCVV and cardHolderName by not including them
		};

		// Remove sensitive fields if they exist
		// This ensures that even if they were accidentally included, they're removed
		delete decryptedCustomerDetails.cardCVV;
		delete decryptedCustomerDetails.cardHolderName;

		// Construct the final reservation object to send in the response
		const responseReservation = {
			...reservation.toObject(), // Convert Mongoose document to plain object
			customer_details: decryptedCustomerDetails, // Replace with decrypted and masked details
		};

		res.status(200).json(responseReservation);
	} catch (error) {
		// Log the error for debugging purposes
		console.error("Error fetching reservation:", error.message || error);

		// Handle specific errors related to invalid ObjectId
		if (error.kind === "ObjectId") {
			return res.status(404).json({
				message: `Reservation not found with id ${req.params.reservationId}`,
			});
		}

		// Handle generic server errors
		res.status(500).json({
			message:
				"An internal server error occurred while fetching the reservation.",
		});
	}
};

exports.reservationsList = (req, res) => {
	const hotelId = mongoose.Types.ObjectId(req.params.hotelId);
	const userId = mongoose.Types.ObjectId(req.params.belongsTo);

	// Start date at the beginning of the day in UTC
	const startDate = new Date(req.params.startdate);
	startDate.setUTCHours(0, 0, 0, 0);

	// End date at the end of the day in UTC
	const endDate = new Date(req.params.enddate);
	endDate.setUTCHours(23, 59, 59, 999);

	console.log(startDate, "startDate");
	console.log(endDate, "endDate");

	let queryConditions = {
		hotelId: hotelId,
		belongsTo: userId,
		$or: [
			{ checkin_date: { $gte: startDate, $lte: endDate } },
			{ checkout_date: { $gte: startDate, $lte: endDate } },
			{
				$and: [
					{ checkin_date: { $lte: startDate } },
					{ checkout_date: { $gte: endDate } },
				],
			},
		],
		roomId: { $exists: true, $ne: [], $not: { $elemMatch: { $eq: null } } },
		reservation_status: { $not: /checked[- _]?out/i }, // Filter checked out variants
	};

	Reservations.find(queryConditions)
		.populate("belongsTo")
		.populate("roomId")
		.exec((err, data) => {
			if (err) {
				console.log(err, "err");
				return res.status(400).json({
					error: err,
				});
			}
			res.json(data);
		});
};

exports.reservationsOccupancyRange = async (req, res) => {
	try {
		const { startdate, enddate, hotelId, belongsTo } = req.params;
		if (
			!ObjectId.isValid(hotelId) ||
			!ObjectId.isValid(belongsTo) ||
			!startdate ||
			!enddate
		) {
			return res.status(400).json({ error: "Invalid parameters" });
		}

		const startDate = new Date(startdate);
		const endDate = new Date(enddate);
		if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
			return res.status(400).json({ error: "Invalid date range" });
		}
		startDate.setUTCHours(0, 0, 0, 0);
		endDate.setUTCHours(23, 59, 59, 999);

		const todayEnd = moment.tz("Asia/Riyadh").endOf("day").toDate();
		const overdueInhouseFilter = {
			reservation_status: IN_HOUSE_REGEX,
			checkin_date: { $lte: todayEnd },
			checkout_date: { $lte: todayEnd },
		};

		const queryConditions = {
			hotelId: ObjectId(hotelId),
			belongsTo: ObjectId(belongsTo),
			$or: [
				{ checkin_date: { $gte: startDate, $lte: endDate } },
				{ checkout_date: { $gte: startDate, $lte: endDate } },
				{
					$and: [
						{ checkin_date: { $lte: startDate } },
						{ checkout_date: { $gte: endDate } },
					],
				},
				overdueInhouseFilter,
			],
			roomId: { $exists: true, $ne: [], $not: { $elemMatch: { $eq: null } } },
			reservation_status: { $not: CHECKED_OUT_REGEX },
		};

		const reservations = await Reservations.find(queryConditions)
			.populate("belongsTo")
			.populate("roomId");

		return res.json(reservations);
	} catch (error) {
		console.error("Error fetching occupancy range:", error);
		return res.status(500).json({ error: "Internal server error" });
	}
};

exports.reservationsOccupancyCurrent = async (req, res) => {
	try {
		const { hotelId, belongsTo } = req.params;
		if (!ObjectId.isValid(hotelId) || !ObjectId.isValid(belongsTo)) {
			return res.status(400).json({ error: "Invalid parameters" });
		}

		const startOfDay = moment.tz("Asia/Riyadh").startOf("day").toDate();
		const endOfDay = moment.tz("Asia/Riyadh").endOf("day").toDate();

		const overdueInhouseFilter = {
			reservation_status: IN_HOUSE_REGEX,
			checkin_date: { $lte: endOfDay },
			checkout_date: { $lte: endOfDay },
		};

		const queryConditions = {
			hotelId: ObjectId(hotelId),
			belongsTo: ObjectId(belongsTo),
			roomId: { $exists: true, $ne: [], $not: { $elemMatch: { $eq: null } } },
			reservation_status: { $not: CHECKED_OUT_REGEX },
			$or: [
				{
					checkin_date: { $lte: endOfDay },
					checkout_date: { $gte: startOfDay },
				},
				overdueInhouseFilter,
			],
		};

		const reservations = await Reservations.find(queryConditions)
			.populate("belongsTo")
			.populate("roomId");

		return res.json(reservations);
	} catch (error) {
		console.error("Error fetching current occupancy:", error);
		return res.status(500).json({ error: "Internal server error" });
	}
};

exports.todaysCheckins = async (req, res) => {
	try {
		const { hotelId, belongsTo } = req.params;

		if (!ObjectId.isValid(hotelId) || !ObjectId.isValid(belongsTo)) {
			return res.status(400).json({ error: "Invalid parameters" });
		}

		const startOfDay = moment.tz("Asia/Riyadh").startOf("day").toDate();
		const endOfDay = moment.tz("Asia/Riyadh").endOf("day").toDate();

		const reservations = await Reservations.find({
			hotelId: ObjectId(hotelId),
			belongsTo: ObjectId(belongsTo),
			checkin_date: { $gte: startOfDay, $lte: endOfDay },
			reservation_status: {
				$nin: [
					"cancelled_by_guest",
					"canceled",
					"Cancelled",
					"cancelled",
					"checked_out",
					"no_show",
				],
			},
		}).sort({ checkin_date: 1 });

		return res.json(reservations);
	} catch (error) {
		console.error("Error fetching today's check-ins:", error);
		return res.status(500).json({ error: "Internal Server Error" });
	}
};

exports.reservationsList2 = (req, res) => {
	const userId = mongoose.Types.ObjectId(req.params.accountId);
	const today = new Date();
	const thirtyDaysAgo = new Date(today);
	thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

	Reservations.find({
		hotelId: userId,
		checkin_date: {
			$gte: thirtyDaysAgo, // Greater than or equal to 30 days ago
		},
	})
		.populate("belongsTo")
		.populate(
			"roomId",
			"room_number room_type room_features room_pricing floor roomColorCode"
		) // Populate room details
		.sort({ createdAt: -1 })
		.exec((err, data) => {
			if (err) {
				console.log(err, "err");
				return res.status(400).json({
					error: err,
				});
			}
			res.json(data);
		});
};

const sendEmailUpdate = async (reservationData, hotelName) => {
	// Dynamically generating HTML content for the email body and PDF
	const htmlContent = reservationUpdate(reservationData, hotelName);
	const hotelForPdf =
		reservationData?.hotelId && typeof reservationData.hotelId === "object"
			? reservationData.hotelId
			: {
					hotelName: hotelName || reservationData?.hotelName || "",
					suppliedBy: reservationData?.belongsTo?.name || "",
			  };
	const pdfHtml = receiptPdfTemplate(reservationData, hotelForPdf);
	const pdfBuffer = await createPdfBuffer(pdfHtml);

	const FormSubmittionEmail = {
		to: reservationData.customer_details.email
			? reservationData.customer_details.email
			: "ahmedabdelrazak20@gmail.com",
		from: "noreply@jannatbooking.com",
		// from: "noreply@jannatbooking.com",
		// cc: [
		// 	{ email: "ayed.hotels@gmail.com" },
		// 	{ email: "zaerhotel@gmail.com" },
		// 	{ email: "3yedhotel@gmail.com" },
		// 	{ email: "morazzakhamouda@gmail.com" },
		// ],
		bcc: [
			{ email: "morazzakhamouda@gmail.com" },
			{ email: "xhoteleg@gmail.com" },
			{ email: "ahmed.abdelrazak@jannatbooking.com" },
			{ email: "support@jannatbooking.com" },
		],
		subject: `Jannat Booking - Reservation Update`,
		html: htmlContent,
		attachments: [
			{
				content: pdfBuffer.toString("base64"),
				filename: "Reservation_Update.pdf",
				type: "application/pdf",
				disposition: "attachment",
			},
		],
	};

	try {
		await sgMail.send(FormSubmittionEmail);
	} catch (error) {
		console.error("Error sending email with PDF", error);
		// Handle error appropriately
	}
};

exports.updateReservation = async (req, res) => {
	try {
		const reservationId = req.params.reservationId;
		const updateData = req.body || {};
		const normalizedUpdateData = { ...updateData };
		const requestingUserId =
			normalizedUpdateData.requestingUserId ||
			normalizedUpdateData.updatedBy ||
			normalizedUpdateData.userId;
		delete normalizedUpdateData.requestingUserId;
		delete normalizedUpdateData.updatedBy;
		delete normalizedUpdateData.userId;
		const normalizeRoomIds = (value) => {
			if (!Array.isArray(value)) return [];
			return value
				.map((room) => {
					if (!room) return null;
					if (typeof room === "string") return room;
					if (typeof room === "object" && room._id) return room._id;
					return room;
				})
				.filter((id) => id && mongoose.Types.ObjectId.isValid(id))
				.map((id) => String(id));
		};

		console.log(
			`[UPDATE RESERVATION] Received update for ID: ${reservationId}`
		);
		console.log("Update Data:", updateData);

		// 1️⃣ Validate reservationId
		if (!mongoose.Types.ObjectId.isValid(reservationId)) {
			return res.status(400).json({ error: "Invalid reservation ID" });
		}

		// 2️⃣ Validate total_amount if provided
		if (
			normalizedUpdateData.total_amount &&
			typeof normalizedUpdateData.total_amount !== "number"
		) {
			return res.status(400).json({ error: "Invalid total amount format" });
		}

		// 3️⃣ Validate belongsTo (convert empty string to undefined)
		if (
			!normalizedUpdateData.belongsTo ||
			!mongoose.Types.ObjectId.isValid(normalizedUpdateData.belongsTo)
		) {
			delete normalizedUpdateData.belongsTo;
		}

		if (Array.isArray(normalizedUpdateData.roomId)) {
			const normalizedRoomIds = normalizeRoomIds(normalizedUpdateData.roomId);
			if (
				normalizedRoomIds.length > 0 ||
				normalizedUpdateData.roomId.length === 0
			) {
				normalizedUpdateData.roomId = normalizedRoomIds;
			} else {
				delete normalizedUpdateData.roomId;
			}
		}

		// 4️⃣ Fetch existing reservation for comparison
		const existingReservation = await Reservations.findById(reservationId);
		if (!existingReservation) {
			return res.status(404).json({ error: "Reservation not found" });
		}

		const restrictedCashUserId = "6969d80da28c78c6280171df";
		const paymentBreakdownKeys = [
			"paid_online_via_link",
			"paid_online_via_instapay",
			"paid_at_hotel_cash",
			"paid_at_hotel_card",
			"paid_to_zad",
			"paid_online_jannatbooking",
			"paid_online_other_platforms",
		];
		const computeBreakdownTotal = (breakdown) =>
			paymentBreakdownKeys.reduce((sum, key) => {
				const value = Number(breakdown?.[key] || 0);
				return sum + (Number.isFinite(value) ? value : 0);
			}, 0);

		if (String(requestingUserId || "") === restrictedCashUserId) {
			const existingCashValue = Number(
				existingReservation?.paid_amount_breakdown?.paid_at_hotel_cash || 0
			);
			if (
				existingCashValue > 0 &&
				normalizedUpdateData.paid_amount_breakdown &&
				typeof normalizedUpdateData.paid_amount_breakdown === "object"
			) {
				normalizedUpdateData.paid_amount_breakdown.paid_at_hotel_cash =
					existingCashValue;
				if (normalizedUpdateData.paid_amount !== undefined) {
					normalizedUpdateData.paid_amount = computeBreakdownTotal(
						normalizedUpdateData.paid_amount_breakdown
					);
				}
			}
		}

		// 5️⃣ Intelligent '_relocate' Increment if hotelId has changed
		if (
			normalizedUpdateData.hotelId &&
			existingReservation.hotelId.toString() !==
				normalizedUpdateData.hotelId.toString()
		) {
			const relocatePattern = /_relocate(\d*)$/;
			const match =
				existingReservation.confirmation_number.match(relocatePattern);

			if (match) {
				const count = match[1] ? parseInt(match[1], 10) + 1 : 2;
				normalizedUpdateData.confirmation_number =
					existingReservation.confirmation_number.replace(
						relocatePattern,
						`_relocate${count}`
					);
			} else {
				normalizedUpdateData.confirmation_number = `${existingReservation.confirmation_number}_relocate`;
			}

			console.log(
				`[RELOCATION] Confirmation number updated to: ${normalizedUpdateData.confirmation_number}`
			);
		} else {
			normalizedUpdateData.confirmation_number =
				existingReservation.confirmation_number;
		}

		// 6️⃣ Prepare nested fields for update using dot notation
		const customerDetails =
			normalizedUpdateData.customer_details ||
			normalizedUpdateData.customerDetails ||
			null;

		if (normalizedUpdateData.customer_details) {
			delete normalizedUpdateData.customer_details;
		}
		if (normalizedUpdateData.customerDetails) {
			delete normalizedUpdateData.customerDetails;
		}

		const hasPricingDetails = (rooms) => {
			if (!Array.isArray(rooms) || rooms.length === 0) return false;
			return rooms.every(
				(room) =>
					Array.isArray(room?.pricingByDay) &&
					room.pricingByDay.length > 0 &&
					room.pricingByDay.some(
						(day) =>
							day &&
							(day.rootPrice !== undefined ||
								day.totalPriceWithCommission !== undefined ||
								day.totalPriceWithoutCommission !== undefined)
					)
			);
		};

		if (
			Array.isArray(normalizedUpdateData.pickedRoomsType) &&
			normalizedUpdateData.pickedRoomsType.length > 0 &&
			!hasPricingDetails(normalizedUpdateData.pickedRoomsType)
		) {
			normalizedUpdateData.pickedRoomsType =
				existingReservation.pickedRoomsType;
		}

		if (
			Array.isArray(normalizedUpdateData.pickedRoomsType) &&
			normalizedUpdateData.pickedRoomsType.length === 0 &&
			Array.isArray(existingReservation.pickedRoomsType) &&
			existingReservation.pickedRoomsType.length > 0
		) {
			normalizedUpdateData.pickedRoomsType =
				existingReservation.pickedRoomsType;
		}

		if (
			Array.isArray(normalizedUpdateData.pickedRoomsPricing) &&
			normalizedUpdateData.pickedRoomsPricing.length > 0 &&
			!hasPricingDetails(normalizedUpdateData.pickedRoomsPricing)
		) {
			normalizedUpdateData.pickedRoomsPricing =
				existingReservation.pickedRoomsPricing;
		}

		if (
			Array.isArray(normalizedUpdateData.pickedRoomsPricing) &&
			normalizedUpdateData.pickedRoomsPricing.length === 0 &&
			Array.isArray(existingReservation.pickedRoomsPricing) &&
			existingReservation.pickedRoomsPricing.length > 0
		) {
			normalizedUpdateData.pickedRoomsPricing =
				existingReservation.pickedRoomsPricing;
		}

		const updatePayload = {
			...normalizedUpdateData,
		};

		if (customerDetails) {
			const existingCustomerDetails =
				typeof existingReservation.customer_details?.toObject === "function"
					? existingReservation.customer_details.toObject()
					: existingReservation.customer_details || {};

			updatePayload.customer_details = {
				...existingCustomerDetails,
				...customerDetails,
			};
		}

		// 7️⃣ Update reservation
		const updatedReservation = await Reservations.findByIdAndUpdate(
			reservationId,
			{ $set: updatePayload },
			{ new: true }
		);

		if (!updatedReservation) {
			return res.status(404).json({ error: "Failed to update reservation." });
		}

		// 8️⃣ Handle "InHouse" status updates
		if (
			normalizedUpdateData.reservation_status &&
			["inhouse", "InHouse"].includes(
				normalizedUpdateData.reservation_status.toLowerCase()
			) &&
			Array.isArray(normalizedUpdateData.roomId) &&
			normalizedUpdateData.roomId.length > 0
		) {
			try {
				await Rooms.updateMany(
					{ _id: { $in: normalizedUpdateData.roomId } },
					{ $set: { cleanRoom: false } }
				);
				console.log("[ROOM STATUS] Rooms marked as not clean.");
			} catch (err) {
				console.error("[ERROR] Failed to update room clean status:", err);
				return res
					.status(500)
					.json({ error: "Failed to update room clean status" });
			}
		}

		// 9️⃣ Handle "Checked Out" status updates
		if (
			updatedReservation.reservation_status &&
			/checked[- _]?out/.test(
				String(updatedReservation.reservation_status || "").toLowerCase()
			)
		) {
			const checkedOutRoomIds = normalizeRoomIds(
				Array.isArray(updatedReservation.roomId)
					? updatedReservation.roomId
					: []
			);
			if (checkedOutRoomIds.length > 0) {
				try {
					await Rooms.updateMany(
						{ _id: { $in: checkedOutRoomIds } },
						{ $set: { cleanRoom: false } }
					);
					console.log(
						"[ROOM STATUS] Rooms marked as not clean after checkout."
					);
				} catch (err) {
					console.error(
						"[ERROR] Failed to update room clean status after checkout:",
						err
					);
					return res
						.status(500)
						.json({ error: "Failed to update room clean status" });
				}
			}

			const existingTask = await HouseKeeping.findOne({
				confirmation_number: updatedReservation.confirmation_number,
			});

			if (!existingTask) {
				try {
					const newHouseKeepingTask = new HouseKeeping({
						taskDate: new Date(),
						confirmation_number: updatedReservation.confirmation_number,
						rooms: updatedReservation.roomId,
						hotelId: updatedReservation.hotelId,
						task_comment: "Guest Checked Out",
					});
					await newHouseKeepingTask.save();
					console.log("[HOUSEKEEPING] New task created for checked-out rooms.");
				} catch (err) {
					console.error("[ERROR] Failed to create housekeeping task:", err);
					return res
						.status(500)
						.json({ error: "Failed to create housekeeping task" });
				}
			}
		}

		// 🔟 Send update email if requested
		if (req.body.sendEmail) {
			try {
				await sendEmailUpdate(
					updatedReservation,
					updateData.hotel_name || updateData.hotelName
				);
				console.log("[EMAIL] Update email sent successfully.");
			} catch (error) {
				console.error("[ERROR] Failed to send update email:", error);
				return res.status(500).json({
					message: "Reservation updated, but failed to send email",
					error: error.toString(),
				});
			}
		}

		// ✅ Successful update response
		return res.json({
			message: "Reservation updated successfully",
			reservation: updatedReservation,
		});
	} catch (err) {
		console.error("[ERROR] General error updating reservation:", err);
		return res.status(500).json({ error: "Internal server error" });
	}
};

exports.deleteDataSource = async (req, res) => {
	try {
		// Extract the source from the request parameters
		const source = req.params.source;

		// Use the deleteMany function to remove all documents matching the source
		const deletionResult = await Reservations.deleteMany({
			booking_source: source,
		});

		// deletionResult.deletedCount will contain the number of documents removed
		res.status(200).json({
			message: `${deletionResult.deletedCount} documents were deleted successfully.`,
		});
	} catch (error) {
		// If an error occurs, log it and return a server error response
		console.error("Error in deleteDataSource:", error);
		res.status(500).json({ error: "Internal Server Error" });
	}
};
//{hotelId: ObjectId('65b640a1f33023933c22eba3')}
exports.deleteByHotelId = async (req, res) => {
	try {
		// Extract the source from the request parameters
		const hotelId = mongoose.Types.ObjectId(req.params.hotelId);

		// Use the deleteMany function to remove all documents matching the source
		const deletionResult = await Reservations.deleteMany({
			hotelId: hotelId,
		});

		// deletionResult.deletedCount will contain the number of documents removed
		res.status(200).json({
			message: `${deletionResult.deletedCount} documents were deleted successfully.`,
		});
	} catch (error) {
		// If an error occurs, log it and return a server error response
		console.error("Error in deleteByHotelId:", error);
		res.status(500).json({ error: "Internal Server Error" });
	}
};

exports.summaryBySource = async () => {
	try {
		const summary = await Reservations.aggregate([
			{
				$group: {
					_id: "$booking_source", // Group by booking_source
					total_amount: { $sum: "$total_amount" }, // Sum of total_amount for each group
					sub_total: { $sum: "$sub_total" }, // Sum of total_amount for each group
					reservation_count: { $sum: 1 }, // Count of reservations for each group
				},
			},
			{
				$project: {
					_id: 0, // Exclude _id from results
					booking_source: "$_id", // Rename _id to booking_source
					total_amount: 1, // Include total_amount
					sub_amount: 1, // Include sub_amount
					reservation_count: 1, // Include reservation_count
				},
			},
		]);

		return summary;
	} catch (error) {
		console.error("Error in summaryBySource:", error);
		throw error;
	}
};

// Helper function to calculate days of residence
const calculateDaysOfResidence = (checkIn, checkOut) => {
	const checkInDate = new Date(new Date(checkIn).setHours(0, 0, 0, 0));
	const checkOutDate = new Date(new Date(checkOut).setHours(0, 0, 0, 0));

	if (isNaN(checkInDate.getTime()) || isNaN(checkOutDate.getTime())) {
		return 0; // Return 0 if dates are invalid
	}

	const diffInTime = checkOutDate.getTime() - checkInDate.getTime();
	const diffInDays = diffInTime / (1000 * 3600 * 24);
	return diffInDays; // Return the difference in days
};

exports.agodaDataDump = async (req, res) => {
	try {
		const accountId = req.params.accountId;
		const userId = req.params.belongsTo;

		const filePath = req.file.path; // The path to the uploaded file
		const workbook = xlsx.readFile(filePath);
		const sheetName = workbook.SheetNames[0];
		const sheet = workbook.Sheets[sheetName];
		const data = xlsx.utils.sheet_to_json(sheet); // Convert the sheet data to JSON

		for (const item of data) {
			const itemNumber = item["BookingIDExternal_reference_ID"]
				?.toString()
				.trim();
			if (!itemNumber) continue; // Skip if there's no book number

			// Calculate totalAmount by checking if ReferenceSellInclusive is provided and not zero
			let totalAmount;
			if (Number(item.ReferenceSellInclusive) > 0) {
				totalAmount = Number(item.ReferenceSellInclusive);
			} else {
				// If ReferenceSellInclusive is 0, undefined, or not a number, add Total_inclusive_rate and Commission
				totalAmount =
					Number(item.Total_inclusive_rate || 0) + Number(item.Commission || 0);
			}

			const daysOfResidence = calculateDaysOfResidence(
				item.StayDateFrom,
				item.StayDateTo
			);

			// Assuming each record is for one room, adjust accordingly if you have more details
			const pickedRoomsType = [
				{
					room_type: item.RoomType,
					chosenPrice: (daysOfResidence > 0
						? totalAmount / daysOfResidence
						: 0
					).toFixed(2),
					count: 1,
				},
			];

			// Parse the date using moment, and convert it to the Saudi Arabia timezone
			const bookedAtSaudi = moment.tz(item.BookedDate, "Asia/Riyadh").toDate();
			const checkInDateSaudi = moment
				.tz(item.StayDateFrom, "Asia/Riyadh")
				.toDate();
			const checkOutDateSaudi = moment
				.tz(item.StayDateTo, "Asia/Riyadh")
				.toDate();

			// Prepare the document based on your mapping, including any necessary calculations
			const document = {
				confirmation_number: item.BookingIDExternal_reference_ID,
				booking_source: "agoda",
				customer_details: {
					name: item.Customer_Name, // Concatenated first name and last name if available
					nationality: item.Customer_Nationality,
					phone: item.Customer_Phone || "",
					email: item.Customer_Email || "",
				},
				state: item.Status ? item.Status : "confirmed",
				reservation_status: item.Status.toLowerCase().includes("cancelled")
					? "cancelled"
					: item.Status.toLowerCase().includes("show")
					? "no_show"
					: item.Status,
				total_guests: item.No_of_adult + (item.No_of_children || 0),
				cancel_reason: item.CancellationPolicyDescription || "",
				booked_at: bookedAtSaudi,
				sub_total: item.Total_inclusive_rate,
				total_rooms: 1,
				total_amount: totalAmount.toFixed(2),
				currency: item.Currency,
				checkin_date: checkInDateSaudi,
				checkout_date: checkOutDateSaudi,
				days_of_residence: daysOfResidence,
				comment: item.Special_Request || "",
				commision: Number(
					Number(totalAmount) - Number(item.Total_inclusive_rate)
				).toFixed(2), // Note the misspelling of 'commission' here
				payment: item.PaymentModel.toLowerCase(),
				pickedRoomsType,
				hotelId: accountId,
				belongsTo: userId,
				paid_amount:
					item.PaymentModel.toLowerCase() === "agoda collect"
						? totalAmount.toFixed(2)
						: 0,
			};

			const existingReservation = await Reservations.findOne({
				confirmation_number: itemNumber,
				booking_source: "agoda",
			});

			if (existingReservation) {
				const payment_details = existingReservation.payment_details;
				const payment = existingReservation.payment;
				const paid_amount = existingReservation.paid_amount;

				const {
					customer_details,
					state,
					hotelId,
					belongsTo,
					...documentWithoutCustomerDetails
				} = document;
				await Reservations.updateOne(
					{ confirmation_number: itemNumber },
					{
						$set: {
							...documentWithoutCustomerDetails,
							reservation_status:
								document.reservation_status === "cancelled"
									? "cancelled"
									: document.reservation_status === "no_show"
									? "no_show"
									: existingReservation.reservation_status,
							// Include payment_details in the update to retain it
							payment_details: payment_details,
							payment: payment,
							paid_amount: paid_amount,
						},
					}
				);
			} else {
				try {
					await Reservations.create(document);
				} catch (error) {
					if (error.code === 11000) {
						// Check for duplicate key error
						// console.log(
						// 	`Skipping duplicate document for confirmation_number: ${itemNumber}`
						// );
						continue; // Skip to the next item
					} else {
						throw error; // Rethrow if it's not a duplicate key error
					}
				}
			}
		}

		res.status(200).json({
			message: "Data has been updated and uploaded successfully.",
		});
	} catch (error) {
		console.error("Error in agodaDataDump:", error);
		res.status(500).json({ error: "Internal Server Error" });
	}
};

const parseDate = (dateInput, country) => {
	if (typeof dateInput === "number") {
		// If dateInput is an Excel serial date number, parse it accordingly
		// Excel's base date is December 30, 1899
		const excelEpoch = new Date(1899, 11, 30);
		const parsedDate = new Date(excelEpoch.getTime() + dateInput * 86400000);
		const offset = parsedDate.getTimezoneOffset();
		return new Date(parsedDate.getTime() - offset * 60000);
	} else if (typeof dateInput === "string" && dateInput.includes("T")) {
		// If dateInput is an ISO 8601 string with time, convert directly to Saudi time zone
		return moment.tz(dateInput, "Asia/Riyadh").toDate();
	} else if (typeof dateInput === "string") {
		// If dateInput is a date string without time, determine format and create date
		const parts = dateInput.split(/[-/]/);
		const date =
			country === "US"
				? new Date(parts[2], parts[0] - 1, parts[1])
				: new Date(parts[2], parts[1] - 1, parts[0]);
		// Convert the date to Saudi time zone
		return moment.tz(date, "Asia/Riyadh").toDate();
	}
	// Return null if input is unrecognized
	return null;
};

exports.expediaDataDump = async (req, res) => {
	try {
		const accountId = req.params.accountId;
		const userId = req.params.belongsTo;
		const country = req.params.country;
		const filePath = req.file.path; // The path to the uploaded file
		const workbook = xlsx.readFile(filePath);
		const sheetName = workbook.SheetNames[0];
		const sheet = workbook.Sheets[sheetName];
		const data = xlsx.utils.sheet_to_json(sheet); // Convert the sheet data to JSON

		const calculateDaysOfResidence = (checkIn, checkOut) => {
			const checkInDate = new Date(checkIn);
			const checkOutDate = new Date(checkOut);

			// Validate if both dates are valid
			if (isNaN(checkInDate.getTime()) || isNaN(checkOutDate.getTime())) {
				return 0; // Return a default value (e.g., 0) if dates are invalid
			}

			return (checkOutDate - checkInDate) / (1000 * 3600 * 24); // Calculating difference in days
		};

		for (const item of data) {
			const itemNumber = item["Confirmation #"]?.toString().trim()
				? item["Confirmation #"]?.toString().trim()
				: item["Reservation ID"]?.toString().trim();
			if (!itemNumber) continue; // Skip if there's no book number

			const daysOfResidence = calculateDaysOfResidence(
				parseDate(item["Check-in"], country),
				parseDate(item["Check-out"], country)
			);

			const pickedRoomsType = [
				{
					room_type: item["Room"],
					chosenPrice:
						(Number(item["Booking amount"]) / daysOfResidence).toFixed(2) || 0,
					count: 1,
				},
			];

			const bookedAt = parseDate(item["Booked"], country);
			const checkInDate = parseDate(item["Check-in"], country);
			const checkOutDate = parseDate(item["Check-out"], country);

			// console.log(item, "item");

			// Check for valid dates before proceeding
			if (!bookedAt || !checkInDate || !checkOutDate) {
				console.error(`Invalid date found in record: ${JSON.stringify(item)}`);
				continue; // Skip this item if dates are invalid
			}

			// Prepare the document based on your mapping, including any necessary calculations
			const document = {
				confirmation_number: item["Confirmation #"] || item["Reservation ID"],
				booking_source: "expedia",
				customer_details: {
					name: item.Guest || "", // Assuming 'Guest' contains the full name
				},
				state: item.Status ? item.Status : "confirmed",
				reservation_status: item.Status.toLowerCase().includes("cancelled")
					? "cancelled"
					: item.Status.toLowerCase().includes("show")
					? "no_show"
					: item.Status,
				total_guests: item.total_guests || 1, // Total number of guests
				total_rooms: item["rooms"], // The number of items in the group
				booked_at: bookedAt,
				checkin_date: checkInDate,
				checkout_date: checkOutDate,
				sub_total: item["Booking amount"],
				total_amount: item["Booking amount"],
				currency: "SAR", // Adjust as needed
				days_of_residence: daysOfResidence,
				comment: item["Special Request"] || "",
				booking_comment: item["Special Request"] || "", // Replace with the actual column name if different
				payment: item["Payment type"].toLowerCase(),
				pickedRoomsType,
				commision: item.Commission, // Ensure this field exists in your schema
				hotelId: accountId,
				belongsTo: userId,
				paid_amount:
					item["Payment type"].toLowerCase() === "expedia collect"
						? item["Booking amount"]
						: 0,
			};

			const existingReservation = await Reservations.findOne(
				{
					confirmation_number: itemNumber,
					booking_source: "expedia",
				},
				{ upsert: true, new: true }
			);

			if (existingReservation) {
				const payment_details = existingReservation.payment_details;
				const payment = existingReservation.payment;
				const paid_amount = existingReservation.paid_amount;

				const {
					customer_details,
					state,
					hotelId,
					belongsTo,
					...documentWithoutCustomerDetails
				} = document;
				await Reservations.updateOne(
					{ confirmation_number: itemNumber },
					{
						$set: {
							...documentWithoutCustomerDetails,
							reservation_status:
								document.reservation_status === "cancelled"
									? "cancelled"
									: document.reservation_status === "no_show"
									? "no_show"
									: existingReservation.reservation_status,
							// Include payment_details in the update to retain it
							payment_details: payment_details,
							payment: payment,
							paid_amount: paid_amount,
						},
					}
				);
			} else {
				try {
					await Reservations.create(document);
				} catch (error) {
					if (error.code === 11000) {
						// Check for duplicate key error
						// console.log(
						// 	`Skipping duplicate document for confirmation_number: ${itemNumber}`
						// );
						continue; // Skip to the next item
					} else {
						throw error; // Rethrow if it's not a duplicate key error
					}
				}
			}
		}
		res.status(200).json({
			message: "Data has been updated and uploaded successfully.",
		});
	} catch (error) {
		console.error("Error in expediaDataDump:", error);
		res.status(500).json({ error: "Internal Server Error" });
	}
};

exports.airbnb = async (req, res) => {
	try {
		const accountId = req.params.accountId;
		const userId = req.params.belongsTo;
		const country = req.params.country;
		const filePath = req.file.path; // The path to the uploaded file
		const workbook = xlsx.readFile(filePath);
		const sheetName = workbook.SheetNames[0];
		const sheet = workbook.Sheets[sheetName];
		const data = xlsx.utils.sheet_to_json(sheet); // Convert the sheet data to JSON

		const calculateDaysOfResidence = (checkIn, checkOut) => {
			const checkInDate = new Date(checkIn);
			const checkOutDate = new Date(checkOut);

			// Validate if both dates are valid
			if (isNaN(checkInDate.getTime()) || isNaN(checkOutDate.getTime())) {
				return 0; // Return a default value (e.g., 0) if dates are invalid
			}

			return (checkOutDate - checkInDate) / (1000 * 3600 * 24); // Calculating difference in days
		};

		const parseEarnings = (earningsString) => {
			// This regular expression matches optional currency symbols and extracts digits, commas, and decimal points
			const matches = earningsString.match(/[\d,]+\.?\d*/);
			if (matches) {
				// Remove commas before parsing as a float
				const numberWithoutCommas = matches[0].replace(/,/g, "");
				return parseFloat(numberWithoutCommas);
			} else {
				return 0; // Return 0 if no matching numeric part is found
			}
		};

		for (const item of data) {
			const itemNumber = item["Confirmation code"]?.toString().trim();
			if (!itemNumber) continue; // Skip if there's no book number

			let roomType = ""; // Determine roomType based on `item` details
			const peoplePerRoom =
				item["# of adults"] + item["# of children"] + item["# of infants"];
			// Example logic to determine roomType
			if (peoplePerRoom <= 1) {
				roomType = "Single Room";
			} else if (peoplePerRoom <= 2) {
				roomType = "Double Room";
			} else if (peoplePerRoom === 3) {
				roomType = "Triple Room";
			} else if (peoplePerRoom === 4) {
				roomType = "Quad Room";
			} else {
				roomType = "Family Room";
			} // Add more conditions as per your logic

			const pickedRoomsType = [
				{
					room_type: roomType,
					chosenPrice:
						Number(
							parseEarnings(item.Earnings) / Number(item["# of nights"])
						).toFixed(2) || 0,
					count: 1, // Assuming each record is for one room. Adjust accordingly if you have more details.
				},
			];

			// Use the parseDate function for date fields
			const bookedAt = parseDate(item["Booked"]);
			const checkInDate = parseDate(item["Start date"], country);
			const checkOutDate = parseDate(item["End date"], country);

			// console.log(item, "item");

			// Check for valid dates before proceeding
			if (!bookedAt || !checkInDate || !checkOutDate) {
				console.error(`Invalid date found in record: ${JSON.stringify(item)}`);
				continue; // Skip this item if dates are invalid
			}

			// Prepare the document based on your mapping, including any necessary calculations
			const document = {
				confirmation_number: item["Confirmation code"],
				booking_source: "airbnb",
				customer_details: {
					name: item["Guest name"] || "", // Assuming 'Guest' contains the full name
					phone: item["Contact"] || "", // Assuming 'Guest' contains the full name
				},
				state: item.Status ? item.Status : "confirmed",
				reservation_status:
					item.Status.toLowerCase().includes("cancelled") ||
					item.Status.toLowerCase().includes("canceled")
						? "cancelled"
						: item.Status.toLowerCase().includes("show")
						? "no_show"
						: item.Status,
				total_guests:
					item["# of adults"] + item["# of children"] + item["# of infants"] ||
					1, // Total number of guests
				total_rooms: 1, // The number of items in the group
				booked_at: bookedAt,
				checkin_date: checkInDate,
				checkout_date: checkOutDate,
				sub_total: parseEarnings(item.Earnings),
				total_amount: parseEarnings(item.Earnings),
				currency: "SAR", // Adjust as needed
				days_of_residence: item["# of nights"] + 1,
				comment: item["Listing"] || "",
				booking_comment: item["Listing"] || "", // Replace with the actual column name if different
				payment: item["Payment type"],
				pickedRoomsType,
				commision: item.Commission ? item.Commission : 0, // Ensure this field exists in your schema
				hotelId: accountId,
				belongsTo: userId,
				paid_amount: parseEarnings(item.Earnings),
			};

			const existingReservation = await Reservations.findOne({
				confirmation_number: itemNumber,
				booking_source: "airbnb",
			});

			if (existingReservation) {
				const payment_details = existingReservation.payment_details;
				const payment = existingReservation.payment;
				const paid_amount = existingReservation.paid_amount;

				const {
					customer_details,
					state,
					hotelId,
					belongsTo,
					...documentWithoutCustomerDetails
				} = document;
				await Reservations.updateOne(
					{ confirmation_number: itemNumber },
					{
						$set: {
							...documentWithoutCustomerDetails,
							reservation_status:
								document.reservation_status === "cancelled"
									? "cancelled"
									: document.reservation_status === "no_show"
									? "no_show"
									: existingReservation.reservation_status,
							// Include payment_details in the update to retain it
							payment_details: payment_details,
							payment: payment,
							paid_amount: paid_amount,
						},
					}
				);
			} else {
				try {
					await Reservations.create(document);
				} catch (error) {
					if (error.code === 11000) {
						// Check for duplicate key error
						// console.log(
						// 	`Skipping duplicate document for confirmation_number: ${itemNumber}`
						// );
						continue; // Skip to the next item
					} else {
						throw error; // Rethrow if it's not a duplicate key error
					}
				}
			}
		}
		res.status(200).json({
			message: "Data has been updated and uploaded successfully.",
		});
	} catch (error) {
		console.error("Error in expediaDataDump:", error);
		res.status(500).json({ error: "Internal Server Error" });
	}
};

exports.bookingDataDump = async (req, res) => {
	try {
		const accountId = req.params.accountId;
		const userId = req.params.belongsTo;
		const filePath = req.file.path; // The path to the uploaded file
		const workbook = xlsx.readFile(filePath);
		const sheetName = workbook.SheetNames[0];
		const sheet = workbook.Sheets[sheetName];
		let data = xlsx.utils.sheet_to_json(sheet); // Convert the sheet data to JSON

		// Convert keys of each item in data to lowercase
		data = data.map((item) => {
			const newItem = {};
			for (const key in item) {
				if (item.hasOwnProperty(key) && key) {
					newItem[key.toLowerCase()] = item[key];
				}
			}
			return newItem;
		});

		const calculateDaysOfResidence = (checkIn, checkOut) => {
			const checkInDate = new Date(new Date(checkIn).setHours(0, 0, 0, 0));
			const checkOutDate = new Date(new Date(checkOut).setHours(0, 0, 0, 0));

			if (isNaN(checkInDate.getTime()) || isNaN(checkOutDate.getTime())) {
				return 0; // Return 0 if dates are invalid
			}

			const diffInTime = checkOutDate.getTime() - checkInDate.getTime();
			const diffInDays = diffInTime / (1000 * 3600 * 24);
			return diffInDays; // Return the difference in days
		};

		const parseDate = (dateString) => {
			const date = new Date(dateString);
			return isNaN(date.getTime()) ? null : date;
		};

		const parsePrice = (priceString) => {
			// Check if the priceString is not undefined and is a string
			if (typeof priceString === "string" || priceString instanceof String) {
				return parseFloat(priceString.replace(/[^\d.-]/g, ""));
			}
			return 0; // Return 0 or some default value if the priceString is not a valid string
		};

		const parseDateToSaudiTimezone = (dateString) => {
			// Parse the date using moment and convert it to the Asia/Riyadh timezone
			return moment.tz(dateString, "Asia/Riyadh").format();
		};

		for (const item of data) {
			const itemNumber = item["book number"]?.toString().trim();
			if (!itemNumber) continue; // Skip if there's no book number

			const daysOfResidence = calculateDaysOfResidence(
				item["check-in"],
				item["check-out"]
			);

			const price =
				accountId === "658c7c02f848bc6562f5c5cc"
					? (Number(parsePrice(item.price)) +
							Number(parsePrice(item.price)) * 0.1 +
							Number(parsePrice(item["commission amount"]))) /
					  Number(item["rooms"])
					: (Number(parsePrice(item.price)) +
							Number(parsePrice(item["commission amount"]))) /
					  Number(item["rooms"]);

			const chosenPrice =
				daysOfResidence > 0 ? Number(price / daysOfResidence).toFixed(2) : 0;

			const peoplePerRoom = item.persons
				? item.persons
				: item.people / item.rooms;
			// Assuming item['rooms'] gives the number of rooms or you have a way to determine roomType from `item`
			let roomType = ""; // Determine roomType based on `item` details
			// Example logic to determine roomType
			if (peoplePerRoom <= 1) {
				roomType = "Single Room";
			} else if (peoplePerRoom <= 2) {
				roomType = "Double Room";
			} else if (peoplePerRoom === 3) {
				roomType = "Triple Room";
			} else if (peoplePerRoom === 4) {
				roomType = "Quad Room";
			} else {
				roomType = "Family Room";
			} // Add more conditions as per your logic

			// Initialize the pickedRoomsType array
			const pickedRoomsType = [];

			// Populate the pickedRoomsType array based on the room count
			for (let i = 0; i < Number(item["rooms"]); i++) {
				pickedRoomsType.push({
					room_type: roomType,
					chosenPrice: chosenPrice,
					count: 1, // Each object represents 1 room
				});
			}

			// ... Inside your transform logic
			const totalAmount = Number(parsePrice(item.price || 0)).toFixed(2); // Provide a default string if Price is undefined

			const commission = parsePrice(item["commission amount"] || 0); // Provide a default string if Commission Amount is undefined

			// Use the parseDate function for date fields
			const bookedAt = parseDateToSaudiTimezone(item["booked on"]);
			const checkInDate = parseDate(item["check-in"]);
			const checkOutDate = parseDate(item["check-out"]);

			// Check for valid dates before proceeding
			if (!bookedAt || !checkInDate || !checkOutDate) {
				console.error(`Invalid date found in record: ${JSON.stringify(item)}`);
				continue; // Skip this item if dates are invalid
			}

			// Prepare the document based on your mapping, including any necessary calculations
			const document = {
				confirmation_number: item["book number"] || "",
				booking_source: "booking.com",
				customer_details: {
					name: item["guest name(s)"] || "", // Assuming 'Guest Name(s)' contains the full name
				},
				state: item.status ? item.status : "confirmed",
				reservation_status: item.status.toLowerCase().includes("cancelled")
					? "cancelled"
					: item.status.toLowerCase().includes("show") ||
					  item.status.toLowerCase().includes("no_show")
					? "no_show"
					: item.status,
				total_guests: item.people || 1, // Total number of guests
				total_rooms: item["rooms"], // The number of items in the group
				booked_at: bookedAt,
				checkin_date: checkInDate,
				checkout_date: checkOutDate,
				sub_total: totalAmount,
				total_amount:
					accountId === "658c7c02f848bc6562f5c5cc"
						? Number(totalAmount) +
						  Number(commission) +
						  Number(totalAmount) * 0.1
						: Number(totalAmount) + Number(commission),

				currency: "SAR", // Adjust as needed
				days_of_residence: daysOfResidence,
				comment: item.remarks || "",
				booking_comment: item.remarks || "",
				payment: item["payment status"] ? item["payment status"] : "Not Paid",
				pickedRoomsType,
				commission: commission, // Ensure this field exists in your schema
				hotelId: accountId,
				belongsTo: userId,
			};

			const existingReservation = await Reservations.findOne({
				confirmation_number: itemNumber,
				booking_source: "booking.com",
			});

			if (existingReservation) {
				const payment_details = existingReservation.payment_details;
				const payment = existingReservation.payment;
				const paid_amount = existingReservation.paid_amount;

				const {
					customer_details,
					state,
					hotelId,
					belongsTo,
					...documentWithoutCustomerDetails
				} = document;
				await Reservations.updateOne(
					{ confirmation_number: itemNumber },
					{
						$set: {
							...documentWithoutCustomerDetails,
							reservation_status:
								document.reservation_status === "cancelled"
									? "cancelled"
									: document.reservation_status === "no_show"
									? "no_show"
									: existingReservation.reservation_status,
							// Include payment_details in the update to retain it
							payment_details: payment_details,
							payment: payment,
							paid_amount: paid_amount,
						},
					}
				);
			} else {
				try {
					await Reservations.create(document);
				} catch (error) {
					if (error.code === 11000) {
						// Check for duplicate key error
						// console.log(
						// 	`Skipping duplicate document for confirmation_number: ${itemNumber}`
						// );
						continue; // Skip to the next item
					} else {
						throw error; // Rethrow if it's not a duplicate key error
					}
				}
			}
		}

		res.status(200).json({
			message: "Data has been updated and uploaded successfully.",
		});
	} catch (error) {
		console.error("Error in bookingDataDump:", error);
		res.status(500).json({ error: "Internal Server Error" });
	}
};

exports.janatDataDump = async (req, res) => {
	try {
		const accountId = req.params.accountId;
		const userId = req.params.belongsTo;
		const filePath = req.file.path; // The path to the uploaded file
		const workbook = xlsx.readFile(filePath);
		const sheetName = workbook.SheetNames[0];
		const sheet = workbook.Sheets[sheetName];
		let data = xlsx.utils.sheet_to_json(sheet); // Convert the sheet data to JSON

		// Convert keys of each item in data to lowercase
		data = data.map((item) => {
			const newItem = {};
			for (const key in item) {
				if (item.hasOwnProperty(key) && key) {
					newItem[key.toLowerCase()] = item[key];
				}
			}
			return newItem;
		});

		const calculateDaysOfResidence = (checkIn, checkOut) => {
			const checkInDate = new Date(new Date(checkIn).setHours(0, 0, 0, 0));
			const checkOutDate = new Date(new Date(checkOut).setHours(0, 0, 0, 0));

			if (isNaN(checkInDate.getTime()) || isNaN(checkOutDate.getTime())) {
				return 0; // Return 0 if dates are invalid
			}

			const diffInTime = checkOutDate.getTime() - checkInDate.getTime();
			const diffInDays = diffInTime / (1000 * 3600 * 24);
			return diffInDays; // Return the difference in days
		};

		const parseDate = (dateString) => {
			const date = new Date(dateString);
			return isNaN(date.getTime()) ? null : date;
		};

		const parsePrice = (priceString) => {
			// Check if the priceString is not undefined and is a string
			if (typeof priceString === "string" || priceString instanceof String) {
				return parseFloat(priceString.replace(/[^\d.-]/g, ""));
			}
			return 0; // Return 0 or some default value if the priceString is not a valid string
		};

		const parseDateToSaudiTimezone = (dateString) => {
			// Parse the date using moment and convert it to the Asia/Riyadh timezone
			return moment.tz(dateString, "Asia/Riyadh").format();
		};

		for (const item of data) {
			const itemNumber = item["book number"]?.toString().trim();
			if (!itemNumber) continue; // Skip if there's no book number

			const daysOfResidence = calculateDaysOfResidence(
				item["check-in"],
				item["check-out"]
			);

			const price =
				(Number(parsePrice(item.price)) +
					// Number(parsePrice(item.price)) * 0.1 +
					Number(parsePrice(item["commission amount"]))) /
				Number(item["rooms"]);

			const chosenPrice =
				daysOfResidence > 0 ? Number(price / daysOfResidence).toFixed(2) : 0;

			const peoplePerRoom = item.persons
				? item.persons
				: item.people / item.rooms;
			// Assuming item['rooms'] gives the number of rooms or you have a way to determine roomType from `item`
			let roomType = ""; // Determine roomType based on `item` details
			// Example logic to determine roomType
			if (peoplePerRoom <= 1) {
				roomType = "Single Room";
			} else if (peoplePerRoom <= 2) {
				roomType = "Double Room";
			} else if (peoplePerRoom === 3) {
				roomType = "Triple Room";
			} else if (peoplePerRoom === 4) {
				roomType = "Quad Room";
			} else {
				roomType = "Family Room";
			} // Add more conditions as per your logic

			// Initialize the pickedRoomsType array
			// const pickedRoomsType = [];

			// Initialize the pickedRoomsType array and populate based on the split unit types
			const unitTypes = item["unit type"].split(",").map((type) => type.trim());
			const roomCount = parseInt(item["rooms"]); // Parse the room count from the item

			// Initialize the pickedRoomsType array and populate based on room count
			const pickedRoomsType = [];

			// Loop through the number of rooms and push the room types to the pickedRoomsType array
			for (let i = 0; i < roomCount; i++) {
				unitTypes.forEach((roomType) => {
					pickedRoomsType.push({
						room_type: roomType,
						chosenPrice: chosenPrice,
						count: 1, // Each object represents 1 room of this type
					});
				});
			}

			// ... Inside your transform logic
			const totalAmount = Number(parsePrice(item.price || 0)).toFixed(2); // Provide a default string if Price is undefined

			const commission = parsePrice(item["commission amount"] || 0); // Provide a default string if Commission Amount is undefined
			// Use the parseDate function for date fields
			const bookedAt = parseDateToSaudiTimezone(item["booked on"]);
			const checkInDate = parseDate(item["check-in"]);
			const checkOutDate = parseDate(item["check-out"]);

			// Check for valid dates before proceeding
			if (!bookedAt || !checkInDate || !checkOutDate) {
				console.error(`Invalid date found in record: ${JSON.stringify(item)}`);
				continue; // Skip this item if dates are invalid
			}

			const commisionUpdate = Number(
				(Number(totalAmount) + Number(commission)) * 0.1
			).toFixed(2);

			// Prepare the document based on your mapping, including any necessary calculations
			const document = {
				confirmation_number: item["book number"] || "",
				booking_source: "jannat",
				customer_details: {
					name: item["guest name(s)"] || "", // Assuming 'Guest Name(s)' contains the full name
				},
				state: item.status ? item.status : "confirmed",
				reservation_status: item.status.toLowerCase().includes("cancelled")
					? "cancelled"
					: item.status.toLowerCase().includes("show")
					? "no_show"
					: item.status,
				total_guests: item.people || 1, // Total number of guests
				total_rooms: item["rooms"], // The number of items in the group
				booked_at: bookedAt,
				checkin_date: checkInDate,
				checkout_date: checkOutDate,
				sub_total: totalAmount,
				total_amount: Number(totalAmount) + Number(commission),
				currency: "SAR", // Adjust as needed
				days_of_residence: daysOfResidence,
				comment: item.remarks || "",
				booking_comment: item.remarks || "",
				payment: item["payment status"] ? item["payment status"] : "Not Paid",
				pickedRoomsType,
				commission: commisionUpdate, // Ensure this field exists in your schema
				hotelId: accountId,
				belongsTo: userId,
			};

			const existingReservation = await Reservations.findOne({
				confirmation_number: itemNumber,
				booking_source: "jannat",
			});

			if (existingReservation) {
				const payment_details = existingReservation.payment_details;
				const payment = existingReservation.payment;
				const paid_amount = existingReservation.paid_amount;

				const {
					customer_details,
					state,
					hotelId,
					belongsTo,
					...documentWithoutCustomerDetails
				} = document;
				await Reservations.updateOne(
					{ confirmation_number: itemNumber },
					{
						$set: {
							...documentWithoutCustomerDetails,
							reservation_status:
								document.reservation_status === "cancelled"
									? "cancelled"
									: document.reservation_status === "no_show"
									? "no_show"
									: existingReservation.reservation_status,
							// Include payment_details in the update to retain it
							payment_details: payment_details,
							payment: payment,
							paid_amount: paid_amount,
						},
					}
				);
			} else {
				try {
					await Reservations.create(document);
				} catch (error) {
					if (error.code === 11000) {
						// Check for duplicate key error
						// console.log(
						// 	`Skipping duplicate document for confirmation_number: ${itemNumber}`
						// );
						continue; // Skip to the next item
					} else {
						throw error; // Rethrow if it's not a duplicate key error
					}
				}
			}
		}

		res.status(200).json({
			message: "Data has been updated and uploaded successfully.",
		});
	} catch (error) {
		console.error("Error in bookingDataDump:", error);
		res.status(500).json({ error: "Internal Server Error" });
	}
};

// Reports

exports.dateReport = async (req, res) => {
	const { date, hotelId, userMainId } = req.params;
	const startOfDay = new Date(`${date}T00:00:00Z`);
	const endOfDay = new Date(`${date}T23:59:59Z`);

	try {
		const reservations = await Reservations.find({
			belongsTo: mongoose.Types.ObjectId(userMainId),
			hotelId: mongoose.Types.ObjectId(hotelId),
			$or: [
				{
					$and: [
						{ booked_at: { $ne: null, $ne: "" } }, // Ensure booked_at is not null
						{ booked_at: { $gte: startOfDay, $lte: endOfDay } },
					],
				},
				{
					$and: [
						{ checkin_date: { $ne: null, $ne: "" } }, // Ensure checkin_date is not null
						{ checkin_date: { $gte: startOfDay, $lte: endOfDay } },
					],
				},
			],
		});

		return res.json(reservations);
	} catch (error) {
		console.error(error);
		return res
			.status(500)
			.json({ error: "Internal server error", details: error.message });
	}
};

exports.dayoverday = async (req, res) => {
	try {
		const { hotelId, userMainId } = req.params;

		const today = new Date();
		today.setHours(0, 0, 0, 0);
		today.setDate(today.getDate() + 2); // This ensures that "today" includes all bookings for the current day.
		const past25Days = new Date(today);
		past25Days.setDate(past25Days.getDate() - 25); // This sets the start date to 25 days before "today".

		const matchCondition = {
			hotelId: ObjectId(hotelId),
			belongsTo: ObjectId(userMainId),
			checkout_date: {
				$gte: past25Days,
				$lte: today,
			},
			$expr: {
				$ne: [
					{ $dateToString: { format: "%Y-%m-%d", date: "$checkout_date" } },
					"2024-03-15",
				],
			},
		};

		const aggregation = await Reservations.aggregate([
			{ $match: matchCondition },
			{
				$addFields: {
					isCancelled: {
						$regexMatch: {
							input: "$reservation_status",
							regex: /cancelled/,
							options: "i",
						},
					},
					isInProgress: {
						$and: [
							{
								$not: [
									{
										$regexMatch: {
											input: "$reservation_status",
											regex: /cancelled|checkedout|checkout|no_show/,
											options: "i",
										},
									},
								],
							},
							{
								$or: [
									{ $eq: [{ $size: "$roomId" }, 0] },
									{ $eq: ["$roomId", null] },
								],
							},
						],
					},
				},
			},
			{
				$group: {
					_id: {
						$dateToString: { format: "%Y-%m-%d", date: "$checkout_date" },
					}, // Use checkout_date here
					totalReservations: { $sum: 1 },
					totalAmount: { $sum: "$sub_total" },
					cancelledReservations: { $sum: { $cond: ["$isCancelled", 1, 0] } },
					cancelledAmount: {
						$sum: { $cond: ["$isCancelled", "$sub_total", 0] },
					},
					inProgressReservations: { $sum: { $cond: ["$isInProgress", 1, 0] } },
					inProgressAmount: {
						$sum: { $cond: ["$isInProgress", "$sub_total", 0] },
					},
				},
			},
			{ $sort: { _id: 1 } }, // Sort by the _id field which is now the formatted checkout_date
		]);

		res.json(aggregation);
	} catch (error) {
		res.status(500).send(error);
	}
};

exports.monthovermonth = async (req, res) => {
	try {
		const { hotelId, userMainId } = req.params;

		const matchCondition = {
			hotelId: ObjectId(hotelId),
			belongsTo: ObjectId(userMainId),
		};

		// Get the current month and year
		const currentMonth = new Date().getMonth() + 3; // +1 because getMonth() returns 0-11
		const currentYear = new Date().getFullYear();

		const aggregation = await Reservations.aggregate([
			{ $match: matchCondition },
			{
				$addFields: {
					monthYear: {
						$concat: [
							{
								$arrayElemAt: [
									[
										"January",
										"February",
										"March",
										"April",
										"May",
										"June",
										"July",
										"August",
										"September",
										"October",
										"November",
										"December",
									],
									{ $subtract: [{ $month: "$checkout_date" }, 1] },
								],
							},
							", ",
							{ $toString: { $year: "$checkout_date" } },
						],
					},
					bookedMonth: { $month: "$checkout_date" },
					bookedYear: { $year: "$checkout_date" },
					isCancelled: {
						$regexMatch: {
							input: "$reservation_status",
							regex: /cancelled/,
							options: "i",
						},
					},
					isInProgress: {
						$and: [
							{
								$not: [
									{
										$regexMatch: {
											input: "$reservation_status",
											regex: /cancelled|checkedout|checkout|no_show/,
											options: "i",
										},
									},
								],
							},
							{
								$or: [
									{ $eq: [{ $size: "$roomId" }, 0] },
									{ $eq: ["$roomId", null] },
								],
							},
						],
					},
				},
			},
			{
				$match: {
					$or: [
						{ bookedYear: { $lt: currentYear } },
						{
							$and: [
								{ bookedYear: currentYear },
								{ bookedMonth: { $lte: currentMonth } },
							],
						},
					],
				},
			},
			{
				$group: {
					_id: "$monthYear",
					year: { $first: "$bookedYear" },
					month: { $first: "$bookedMonth" },
					totalReservations: { $sum: 1 },
					totalAmount: { $sum: "$sub_total" },
					cancelledReservations: { $sum: { $cond: ["$isCancelled", 1, 0] } },
					cancelledAmount: {
						$sum: { $cond: ["$isCancelled", "$sub_total", 0] },
					},
					inProgressReservations: { $sum: { $cond: ["$isInProgress", 1, 0] } },
					inProgressAmount: {
						$sum: { $cond: ["$isInProgress", "$sub_total", 0] },
					},
				},
			},
			{
				$sort: {
					year: 1,
					month: 1,
				},
			},
			{ $limit: 12 }, // Limit to the latest 12 months
		]);

		res.json(aggregation);
	} catch (error) {
		res.status(500).send(error);
	}
};

exports.bookingSource = async (req, res) => {
	try {
		const { hotelId, userMainId } = req.params;

		const matchCondition = {
			hotelId: ObjectId(hotelId),
			belongsTo: ObjectId(userMainId),
		};

		const aggregation = await Reservations.aggregate([
			{ $match: matchCondition },
			{
				$addFields: {
					isCancelled: {
						$regexMatch: {
							input: "$reservation_status",
							regex: /cancelled/,
							options: "i",
						},
					},
					isInProgress: {
						$and: [
							{
								$not: [
									{
										$regexMatch: {
											input: "$reservation_status",
											regex: /cancelled|checkedout|checkout|no_show/,
											options: "i",
										},
									},
								],
							},
							{
								$or: [
									{ $eq: [{ $size: "$roomId" }, 0] },
									{ $eq: ["$roomId", null] },
								],
							},
						],
					},
				},
			},
			{
				$group: {
					_id: "$booking_source",
					totalReservations: { $sum: 1 },
					totalAmount: { $sum: "$sub_total" },
					cancelledReservations: { $sum: { $cond: ["$isCancelled", 1, 0] } },
					cancelledAmount: {
						$sum: { $cond: ["$isCancelled", "$sub_total", 0] },
					},
					inProgressReservations: { $sum: { $cond: ["$isInProgress", 1, 0] } },
					inProgressAmount: {
						$sum: { $cond: ["$isInProgress", "$sub_total", 0] },
					},
				},
			},
			{ $sort: { _id: 1 } },
		]);

		res.json(aggregation);
	} catch (error) {
		res.status(500).send(error);
	}
};

exports.reservationstatus = async (req, res) => {
	try {
		const { hotelId, userMainId } = req.params;

		const matchCondition = {
			hotelId: ObjectId(hotelId),
			belongsTo: ObjectId(userMainId),
		};

		const aggregation = await Reservations.aggregate([
			{ $match: matchCondition },
			{
				$addFields: {
					groupedStatus: {
						$switch: {
							branches: [
								{
									case: {
										$regexMatch: {
											input: "$reservation_status",
											regex: /cancelled/,
										},
									},
									then: "cancelled",
								},
								{
									case: { $in: ["$reservation_status", ["confirmed", "ok"]] },
									then: "confirmed",
								},
							],
							default: "$reservation_status",
						},
					},
				},
			},
			{
				$group: {
					_id: "$groupedStatus",
					totalReservations: { $sum: 1 },
					totalAmount: { $sum: "$sub_total" },
					cancelledAmount: {
						$sum: {
							$cond: [
								{ $eq: ["$groupedStatus", "cancelled"] },
								"$sub_total",
								0,
							],
						},
					},
					inProgressReservations: {
						$sum: {
							$cond: [
								{
									$or: [
										{ $eq: [{ $size: "$roomId" }, 0] },
										{ $eq: ["$roomId", null] },
									],
								},
								1,
								0,
							],
						},
					},
				},
			},
			{ $sort: { _id: 1 } },
		]);

		res.json(aggregation);
	} catch (error) {
		res.status(500).send(error);
	}
};

exports.CheckedOutReservations = async (req, res) => {
	try {
		const { page, records, hotelId } = req.params;
		const parsedPage = parseInt(page);
		const parsedRecords = parseInt(records);

		if (
			isNaN(parsedPage) ||
			isNaN(parsedRecords) ||
			!ObjectId.isValid(hotelId)
		) {
			return res.status(400).send("Invalid parameters");
		}

		let dynamicFilter = {
			hotelId: ObjectId(hotelId),
			reservation_status: "checked_out",
			"roomId.0": { $exists: true }, // Ensure at least one roomId exists
		};

		// Calculate dates for the filter: 2 days ago to 2 days in advance
		const today = new Date();
		const twoDaysAgo = new Date(today);
		twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
		const twoDaysInAdvance = new Date(today);
		twoDaysInAdvance.setDate(twoDaysInAdvance.getDate() + 2);

		// Filter for checkout_date to include dates from 2 days ago up to 2 days in advance
		dynamicFilter.checkout_date = {
			$gte: twoDaysAgo,
			$lte: twoDaysInAdvance,
		};

		const pipeline = [
			{ $match: dynamicFilter },
			{ $sort: { booked_at: -1 } },
			{ $skip: (parsedPage - 1) * parsedRecords },
			{ $limit: parsedRecords },
			{
				$lookup: {
					from: "rooms",
					localField: "roomId",
					foreignField: "_id",
					as: "roomDetails",
				},
			},
		];

		const reservations = await Reservations.aggregate(pipeline);
		res.json(reservations);
	} catch (error) {
		console.error(error);
		res.status(500).send("Server error: " + error.message);
	}
};

exports.pendingPaymentReservations = async (req, res) => {
	try {
		const { page, records, hotelId } = req.params;
		const parsedPage = parseInt(page);
		const parsedRecords = parseInt(records);

		if (
			isNaN(parsedPage) ||
			isNaN(parsedRecords) ||
			!ObjectId.isValid(hotelId)
		) {
			return res.status(400).send("Invalid parameters");
		}

		let dynamicFilter = {
			hotelId: ObjectId(hotelId),
			booking_source: { $in: ["janat", "affiliate", "manual", "jannat"] },
			reservation_status: { $in: ["checked_out"] },
			financeStatus: { $in: ["not moved", "not paid", "", undefined] },
		};

		// Calculate dates for the filter: 2 days ago to 2 days in advance
		const today = new Date();
		const twoDaysAgo = new Date(today);
		twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
		const twoDaysInAdvance = new Date(today);
		twoDaysInAdvance.setDate(twoDaysInAdvance.getDate() + 2);

		const pipeline = [
			{ $match: dynamicFilter },
			{ $sort: { booked_at: -1 } },
			{ $skip: (parsedPage - 1) * parsedRecords },
			{ $limit: parsedRecords },
			{
				$lookup: {
					from: "rooms",
					localField: "roomId",
					foreignField: "_id",
					as: "roomDetails",
				},
			},
		];

		const reservations = await Reservations.aggregate(pipeline);
		res.json(reservations);
	} catch (error) {
		console.error(error);
		res.status(500).send("Server error: " + error.message);
	}
};

exports.commissionPaidReservations = async (req, res) => {
	try {
		const { page, records, hotelId } = req.params;
		const parsedPage = parseInt(page);
		const parsedRecords = parseInt(records);

		if (
			isNaN(parsedPage) ||
			isNaN(parsedRecords) ||
			!ObjectId.isValid(hotelId)
		) {
			return res.status(400).send("Invalid parameters");
		}

		let dynamicFilter = {
			hotelId: ObjectId(hotelId),
			booking_source: { $in: ["janat", "affiliate", "manual", "jannat"] },
			reservation_status: { $in: ["checked_out"] },
			financeStatus: { $in: ["paid"] },
		};

		// Calculate dates for the filter: 2 days ago to 2 days in advance
		const today = new Date();
		const twoDaysAgo = new Date(today);
		twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
		const twoDaysInAdvance = new Date(today);
		twoDaysInAdvance.setDate(twoDaysInAdvance.getDate() + 2);

		const pipeline = [
			{ $match: dynamicFilter },
			{ $sort: { booked_at: -1 } },
			{ $skip: (parsedPage - 1) * parsedRecords },
			{ $limit: parsedRecords },
			{
				$lookup: {
					from: "rooms",
					localField: "roomId",
					foreignField: "_id",
					as: "roomDetails",
				},
			},
		];

		const reservations = await Reservations.aggregate(pipeline);
		res.json(reservations);
	} catch (error) {
		console.error(error);
		res.status(500).send("Server error: " + error.message);
	}
};

const monthNames = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
];

exports.ownerReport = async (req, res) => {
	try {
		const { month, hotelIds } = req.params;
		const monthNumber = monthNames.indexOf(month) + 1; // Convert month name to month number
		if (monthNumber === 0) {
			throw new Error("Invalid month name");
		}
		const year = new Date().getFullYear();
		const startDate = new Date(Date.UTC(year, monthNumber - 1, 1));
		const endDate = new Date(Date.UTC(year, monthNumber, 0));

		const hotelIdsArray = hotelIds
			.split("-")
			.map((id) => mongoose.Types.ObjectId(id));

		const aggregateResult = await Reservations.aggregate([
			{
				$match: {
					hotelId: { $in: hotelIdsArray },
					checkout_date: { $gte: startDate, $lte: endDate },
					reservation_status: { $nin: ["cancelled", "canceled", "no_show"] },
				},
			},
			{
				$lookup: {
					from: "hoteldetails", // Ensure this is the correct collection name
					localField: "hotelId",
					foreignField: "_id",
					as: "hotelInfo",
				},
			},
			{ $unwind: { path: "$hotelInfo", preserveNullAndEmptyArrays: true } },
			{
				$group: {
					_id: {
						hotelName: "$hotelInfo.hotelName",
						booking_source: "$booking_source",
					},
					totalBookings: { $sum: 1 },
					total_amount: { $sum: "$total_amount" },
					sub_total: { $sum: "$sub_total" },
					commission: { $sum: "$commission" },
					totalBookingsHoused: {
						$sum: {
							$cond: [
								{
									$regexMatch: {
										input: "$reservation_status",
										regex: /checked_out/,
									},
								},
								1,
								0,
							],
						},
					},
					total_amountHoused: {
						$sum: {
							$cond: [
								{
									$regexMatch: {
										input: "$reservation_status",
										regex: /checked_out/,
									},
								},
								"$total_amount",
								0,
							],
						},
					},
					totalNights: {
						$sum: {
							$subtract: [
								{ $dayOfYear: "$checkout_date" },
								{ $dayOfYear: "$checkin_date" },
							],
						},
					},
				},
			},
			{
				$project: {
					hotelName: "$_id.hotelName",
					booking_source: "$_id.booking_source",
					totalBookings: 1,
					total_amount: 1,
					sub_total: 1,
					commission: 1,
					totalBookingsHoused: 1,
					total_amountHoused: 1,
					totalNights: 1, // Include the totalNights in the projection
					_id: 0,
				},
			},
		]);

		res.json(aggregateResult);
	} catch (error) {
		console.error(error);
		res.status(500).send("Server error: " + error.message);
	}
};

exports.ownerReservationToDate = async (req, res) => {
	try {
		const { hotelIds, date } = req.params;

		// Convert hotelIds string to array of ObjectIds
		const hotelIdsArray = hotelIds
			.split("-")
			.map((id) => mongoose.Types.ObjectId(id));

		// Convert date string to Date object and adjust for Saudi Arabia timezone
		const checkinDate = new Date(date + "T00:00:00+03:00"); // Assuming 'date' is in 'yyyy-mm-dd' format

		const reservations = await Reservations.find({
			hotelId: { $in: hotelIdsArray },
			checkin_date: {
				$gte: checkinDate,
				$lt: new Date(checkinDate.getTime() + 86400000), // Add 24 hours to get the end of the day
			},
			reservation_status: { $nin: ["cancelled", "canceled", "no_show"] },
		}).populate("hotelId", "hotelName"); // Assuming you want to include the hotel name in the response

		res.json(reservations);
	} catch (error) {
		console.error(error);
		res.status(500).send("Server error: " + error.message);
	}
};

exports.CollectedReservations = async (req, res) => {
	try {
		const { page, records, hotelId, status } = req.params;
		const parsedPage = parseInt(page);
		const parsedRecords = parseInt(records);

		if (
			isNaN(parsedPage) ||
			isNaN(parsedRecords) ||
			!ObjectId.isValid(hotelId)
		) {
			return res.status(400).send("Invalid parameters");
		}

		let dynamicFilter = {
			hotelId: ObjectId(hotelId),
			payment: "collected", // Filter for payment field to be "collected"
		};

		// Add reservation_status to the filter if the status is not "all"
		if (status !== "all") {
			dynamicFilter.reservation_status = status;
		}

		const pipeline = [
			{ $match: dynamicFilter },
			{ $sort: { booked_at: -1 } },
			{ $skip: (parsedPage - 1) * parsedRecords },
			{ $limit: parsedRecords },
			{
				$lookup: {
					from: "rooms",
					localField: "roomId",
					foreignField: "_id",
					as: "roomDetails",
				},
			},
		];

		const reservations = await Reservations.aggregate(pipeline);
		res.json(reservations);
	} catch (error) {
		console.error(error);
		res.status(500).send("Server error: " + error.message);
	}
};

exports.aggregateCollectedReservations = async (req, res) => {
	try {
		const { page, records, hotelId, status } = req.params;
		const parsedPage = parseInt(page);
		const parsedRecords = parseInt(records);

		if (
			isNaN(parsedPage) ||
			isNaN(parsedRecords) ||
			!ObjectId.isValid(hotelId)
		) {
			return res.status(400).send("Invalid parameters");
		}

		let dynamicFilter = {
			hotelId: ObjectId(hotelId),
			payment: "collected", // Filter for payment field to be "collected"
		};

		// Add reservation_status to the filter if the status is not "all"
		if (status !== "all") {
			dynamicFilter.reservation_status = status;
		}

		const pipeline = [
			{ $match: dynamicFilter },
			{
				$group: {
					_id: null,
					total_reservation: { $sum: 1 },
					total_amount: { $sum: "$total_amount" },
					actual_amount: { $sum: "$sub_total" },
				},
			},
			{
				$project: {
					_id: 0,
					total_reservation: 1,
					total_amount: 1,
					actual_amount: 1,
					commission: { $subtract: ["$total_amount", "$actual_amount"] },
				},
			},
		];

		const result = await Reservations.aggregate(pipeline);
		res.json(result[0]);
	} catch (error) {
		console.error(error);
		res.status(500).send("Server error: " + error.message);
	}
};
