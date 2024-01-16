const New_Reservation = require("../models/newreservation");
const PreReservation = require("../models/prereservation");
const mongoose = require("mongoose");
const fetch = require("node-fetch");

exports.newReservationById = (req, res, next, id) => {
	New_Reservation.findById(id).exec((err, new_reservation) => {
		if (err || !new_reservation) {
			return res.status(400).json({
				error: "new_reservation was not found",
			});
		}
		req.new_reservation = new_reservation;
		next();
	});
};

exports.create = (req, res) => {
	const new_reservation = new New_Reservation(req.body);
	new_reservation.save((err, data) => {
		if (err) {
			console.log(err, "err");
			return res.status(400).json({
				error: "Cannot Create new_reservation",
			});
		}
		res.json({ data });
	});
};

exports.read = (req, res) => {
	return res.json(req.new_reservation);
};

exports.update = (req, res) => {
	console.log(req.body);
	const new_reservation = req.new_reservation;
	new_reservation.customer_details = req.body.customer_details;
	new_reservation.start_date = req.body.start_date;
	new_reservation.end_date = req.body.end_date;
	new_reservation.days_of_residence = req.body.days_of_residence;
	new_reservation.payment_status = req.body.payment_status;
	new_reservation.total_amount = req.body.total_amount;
	new_reservation.booking_source = req.body.booking_source;
	new_reservation.belongsTo = req.body.belongsTo;
	new_reservation.hotelId = req.body.hotelId;
	new_reservation.roomId = req.body.roomId;

	new_reservation.save((err, data) => {
		if (err) {
			return res.status(400).json({
				error: err,
			});
		}
		res.json(data);
	});
};

exports.list = (req, res) => {
	const userId = mongoose.Types.ObjectId(req.params.accountId);
	const today = new Date();
	const thirtyDaysAgo = new Date(today);
	thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

	New_Reservation.find({
		belongsTo: userId,
		start_date: {
			$gte: thirtyDaysAgo, // Greater than or equal to 30 days ago
		},
	})
		.populate("belongsTo")
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

exports.list2 = (req, res) => {
	const userId = mongoose.Types.ObjectId(req.params.accountId);
	const today = new Date();
	const thirtyDaysAgo = new Date(today);
	thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

	New_Reservation.find({
		belongsTo: userId,
		start_date: {
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

exports.remove = (req, res) => {
	const new_reservation = req.new_reservation;

	new_reservation.remove((err, data) => {
		if (err) {
			return res.status(400).json({
				err: "error while removing",
			});
		}
		res.json({ message: "new_reservation deleted" });
	});
};

exports.listForAdmin = (req, res) => {
	New_Reservation.find()
		.populate("belongsTo")
		.exec((err, data) => {
			if (err) {
				return res.status(400).json({
					error: err,
				});
			}
			res.json(data);
		});
};

// Normalize room names
function normalizeRoomName(apiRoomName) {
	// Example: Remove anything after a dash or other patterns
	return apiRoomName.split(" - ")[0].trim();
}

// Mapping function
function mapRoomType(apiRoomName) {
	const normalizedRoomName = normalizeRoomName(apiRoomName);

	// Define mappings from normalized API room names to your schema's room_type names
	const roomTypeMappings = {
		"Double Room": "doubleRooms",
		"Triple Room": "tripleRooms",
		Suite: "suite",
		"Quad Room": "quadRooms",
		"Family Room": "familyRooms",
	};

	return roomTypeMappings[normalizedRoomName] || "unknown"; // Default to 'unknown' if no mapping found
}

function mapHotelRunnerResponseToSchema(apiResponse) {
	const reservation = apiResponse; // Assuming we are working with the first reservation

	const mappedRooms = reservation.rooms.map((room) => ({
		room_type: mapRoomType(room.name),
		chosenPrice: room.total,
		count: 1,
	}));

	const mappedReservation = {
		customer_details: {
			name: `${reservation.firstname} ${reservation.lastname}`,
			phone: reservation.address.phone,
			email: reservation.address.email,
			passport: reservation.guest_national_id,
			nationality: reservation.country,
		},
		start_date: new Date(reservation.checkin_date),
		end_date: new Date(reservation.checkout_date),
		days_of_residence: calculateDaysBetweenDates(
			reservation.checkin_date,
			reservation.checkout_date
		),
		total_amount: reservation.total,
		booking_source: reservation.channel_display.toLowerCase(),
		booking_comment: reservation.note,
		provider_number: reservation.provider_number,
		confirmation_number: reservation.reservation_id.toString(),
		pickedRoomsType: mappedRooms,
	};

	return mappedReservation;
}

// Helper functions
function calculateDaysBetweenDates(startDate, endDate) {
	const start = new Date(startDate);
	const end = new Date(endDate);
	return (end - start) / (1000 * 60 * 60 * 24); // Convert milliseconds to days
}

// API call and MongoDB interaction
exports.listOfAllReservationSummary = (req, res) => {
	const token = process.env.HOTEL_RUNNER_TOKEN;
	const hrId = process.env.HR_ID;
	const hotelId = req.params.hotelId;
	const belongsTo = req.params.belongsTo;

	// Calculate the date 30 days prior to today
	const thirtyDaysAgo = new Date();
	thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
	const fromDate = thirtyDaysAgo.toISOString().split("T")[0];

	const queryParams = new URLSearchParams({
		token: token,
		hr_id: hrId,
		undelivered: "false", // Assuming 'false' will include all reservations
		modified: "false", // Assuming 'false' will not filter out unmodified reservations
		per_page: "200", // Example: Adjust as needed based on the maximum allowed by the
		from_date: fromDate, // Fetch reservations created after this date
		// booked: "true", // Fetch only new reservations
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
			// Check if reservations array is present and not empty
			if (!data.reservations || data.reservations.length === 0) {
				throw new Error("No reservations found");
			}

			// Process each reservation
			const reservationPromises = data.reservations.map((reservation) => {
				const mappedReservation = mapHotelRunnerResponseToSchema(reservation);
				mappedReservation.belongsTo = belongsTo;
				mappedReservation.hotelId = hotelId;

				// Check if a reservation with the same confirmation_number or provider_number exists
				return PreReservation.findOne({
					$or: [
						{ confirmation_number: mappedReservation.confirmation_number },
						{ provider_number: mappedReservation.provider_number },
					],
				}).then((existingReservation) => {
					if (!existingReservation) {
						// If no existing reservation, create a new one
						return new PreReservation(mappedReservation).save();
					}
				});
			});

			// Wait for all reservations to be processed
			return Promise.all(reservationPromises);
		})
		.then(() => {
			res.json({ message: "Reservations processed successfully" });
		})
		.catch((error) => {
			console.error("API request error:", error);
			res
				.status(500)
				.json({ error: "Error fetching and processing reservations" });
		});
};

// exports.listOfAllReservationSummaryBasic = (req, res) => {
// 	const token = process.env.HOTEL_RUNNER_TOKEN;
// 	const hrId = process.env.HR_ID;

// 	const queryParams = new URLSearchParams({
// 		token: token,
// 		hr_id: hrId,
// 		undelivered: "false", // Assuming 'false' will include all reservations
// 		modified: "false", // Assuming 'false' will not filter out unmodified reservations
// 		per_page: "1", // Example: Adjust as needed based on the maximum allowed by the API
// 		// You can add more parameters here as required.
// 	}).toString();

// 	const url = `https://app.hotelrunner.com/api/v2/apps/reservations?${queryParams}`;

// 	fetch(url)
// 		.then((apiResponse) => {
// 			if (!apiResponse.ok) {
// 				throw new Error(`HTTP error! status: ${apiResponse.status}`);
// 			}
// 			return apiResponse.json();
// 		})
// 		.then((data) => {
// 			res.json(data); // Send back the data received from the HotelRunner API
// 		})
// 		.catch((error) => {
// 			console.error("API request error:", error);
// 			res.status(500).json({ error: "Error fetching reservations" });
// 		});
// };
