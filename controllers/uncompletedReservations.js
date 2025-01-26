const UncompleteReservations = require("../models/Uncompleted");
const Reservations = require("../models/reservations");
const HotelDetails = require("../models/hotel_details");

exports.createNewTrackingUncompleteReservation = async (req, res) => {
	try {
		// Destructure all necessary fields from req.body
		const {
			guestAgreedOnTermsAndConditions,
			userId,
			hotelId,
			hotelName,
			belongsTo,
			customerDetails,
			paymentDetails,
			total_rooms,
			total_guests,
			adults,
			children,
			total_amount,
			payment,
			paid_amount,
			commission,
			commissionPaid,
			checkin_date,
			checkout_date,
			days_of_residence,
			booking_source,
			pickedRoomsType,
			convertedAmounts,
			rootCause,
		} = req.body;

		// Basic validations
		if (!hotelId) {
			return res.status(400).json({ message: "Hotel ID is required." });
		}

		if (!customerDetails || !customerDetails.email || !customerDetails.phone) {
			return res.status(400).json({
				message: "Both customer email and phone are required for tracking.",
			});
		}

		// Validate hotel existence
		const hotel = await HotelDetails.findOne({
			_id: hotelId,
			activateHotel: true,
			hotelPhotos: { $exists: true, $not: { $size: 0 } },
			"location.coordinates": { $ne: [0, 0] },
		});

		if (!hotel) {
			return res.status(400).json({
				message: "Invalid hotel ID provided.",
			});
		}

		// Normalize email and phone
		const normalizedEmail = customerDetails.email.toLowerCase().trim();
		const normalizedPhone = customerDetails.phone.trim();

		// Validate email format
		const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
		if (!emailRegex.test(normalizedEmail)) {
			return res.status(400).json({ message: "Invalid email format." });
		}

		// Validate phone format (E.164)
		const phoneRegex = /^\+?[1-9]\d{1,14}$/;
		if (!phoneRegex.test(normalizedPhone)) {
			return res.status(400).json({ message: "Invalid phone number format." });
		}

		// Check if pickedRoomsType exists and is an array
		if (!Array.isArray(pickedRoomsType) || pickedRoomsType.length === 0) {
			return res.status(400).json({
				message: "pickedRoomsType must be a non-empty array.",
			});
		}

		// Find existing uncomplete reservation by both email and phone and hotelId
		let uncompleteReservation = await UncompleteReservations.findOne({
			"customerDetails.email": normalizedEmail,
			"customerDetails.phone": normalizedPhone,
			hotelId: hotelId,
			reservation_status: "uncomplete",
		});

		if (uncompleteReservation) {
			// Update existing uncomplete reservation
			uncompleteReservation = await UncompleteReservations.findOneAndUpdate(
				{ _id: uncompleteReservation._id },
				{
					guestAgreedOnTermsAndConditions:
						guestAgreedOnTermsAndConditions !== undefined
							? guestAgreedOnTermsAndConditions
							: uncompleteReservation.guestAgreedOnTermsAndConditions,
					userId: userId || uncompleteReservation.userId,
					hotelName: hotelName || uncompleteReservation.hotelName,
					belongsTo: belongsTo || uncompleteReservation.belongsTo,
					customer_details: {
						...uncompleteReservation.customerDetails,
						...customerDetails,
					},
					paymentDetails:
						paymentDetails || uncompleteReservation.paymentDetails,
					total_rooms: total_rooms || uncompleteReservation.total_rooms,
					total_guests: total_guests || uncompleteReservation.total_guests,
					adults: adults || uncompleteReservation.adults,
					children: children || uncompleteReservation.children,
					total_amount: total_amount || uncompleteReservation.total_amount,
					payment: payment || uncompleteReservation.payment,
					paid_amount: paid_amount || uncompleteReservation.paid_amount,
					commission:
						commission !== undefined
							? commission
							: uncompleteReservation.commission,
					commissionPaid:
						commissionPaid !== undefined
							? commissionPaid
							: uncompleteReservation.commissionPaid,
					checkin_date: checkin_date || uncompleteReservation.checkin_date,
					checkout_date: checkout_date || uncompleteReservation.checkout_date,
					days_of_residence:
						days_of_residence || uncompleteReservation.days_of_residence,
					booking_source:
						booking_source || uncompleteReservation.booking_source,
					pickedRoomsType:
						pickedRoomsType || uncompleteReservation.pickedRoomsType,
					convertedAmounts:
						convertedAmounts || uncompleteReservation.convertedAmounts,
					rootCause: rootCause || uncompleteReservation.rootCause,
					userAgent:
						req.headers["user-agent"] || uncompleteReservation.userAgent,
					ipAddress:
						req.headers["x-forwarded-for"] ||
						req.connection.remoteAddress ||
						uncompleteReservation.ipAddress,
					lastUpdated: new Date(),
				},
				{ new: true }
			);
		} else {
			// Create new uncomplete reservation
			const newUncompleteReservation = new UncompleteReservations({
				guestAgreedOnTermsAndConditions: guestAgreedOnTermsAndConditions,
				userId: userId || null,
				hotelId,
				hotelName: hotelName || "",
				belongsTo: belongsTo || "",
				customer_details: req.body.customerDetails,
				paymentDetails: paymentDetails || {},
				total_rooms: total_rooms || 0,
				total_guests: total_guests || 0,
				adults: adults || 0,
				children: children || 0,
				total_amount: total_amount || 0,
				payment: payment || "Not Paid",
				paid_amount: paid_amount || 0,
				commission: commission !== undefined ? commission : 0,
				commissionPaid: commissionPaid || false,
				checkin_date: checkin_date || new Date(),
				checkout_date: checkout_date || new Date(),
				days_of_residence: days_of_residence || 0,
				booking_source: booking_source || "Online Jannat Booking",
				pickedRoomsType,
				convertedAmounts: convertedAmounts || {},
				rootCause: rootCause || "",
				userAgent: req.headers["user-agent"] || "",
				ipAddress:
					req.headers["x-forwarded-for"] || req.connection.remoteAddress || "",
				reservation_status: "uncomplete", // Ensure reservation_status is set
				stage: "started", // Set default stage or based on logic
			});

			uncompleteReservation = await newUncompleteReservation.save();
		}

		return res.status(200).json({
			message: "Uncomplete reservation tracked successfully.",
			data: uncompleteReservation,
		});
	} catch (error) {
		console.error("Error tracking uncomplete reservation:", error);
		res.status(500).json({
			message: "An error occurred while tracking the uncomplete reservation.",
		});
	}
};

exports.listOfActualUncompleteReservation = async (req, res) => {
	try {
		// Step 1: Fetch all uncomplete reservations with status "uncomplete"
		const uncompleteReservations = await UncompleteReservations.find({
			reservation_status: "uncomplete",
		}).populate("hotelId", "hotelName"); // Populate hotelName from HotelDetails

		if (!uncompleteReservations.length) {
			return res.status(200).json({
				message: "No uncomplete reservations found.",
				data: [],
			});
		}

		// Step 2: Identify reservations missing both email and phone
		const reservationsToDelete = uncompleteReservations.filter(
			(reservation) => {
				const email = reservation.customer_details.email?.trim();
				const phone = reservation.customer_details.phone?.trim();
				return !email && !phone; // Both email and phone are missing
			}
		);

		// Step 3: Delete invalid reservations from the database
		if (reservationsToDelete.length > 0) {
			const idsToDelete = reservationsToDelete.map((resv) => resv._id);
			await UncompleteReservations.deleteMany({ _id: { $in: idsToDelete } });
			console.log(
				`Deleted ${idsToDelete.length} invalid uncomplete reservations.`
			);
		}

		// Step 4: Fetch the updated list after deletion
		const updatedUncompleteReservations = await UncompleteReservations.find({
			reservation_status: "uncomplete",
		}).populate("hotelId", "hotelName");

		// Step 5: Retain only reservations with either email or phone present
		const validReservations = updatedUncompleteReservations.filter(
			(reservation) => {
				const email = reservation.customer_details.email?.trim();
				const phone = reservation.customer_details.phone?.trim();
				return email || phone; // Either email or phone is present
			}
		);

		if (!validReservations.length) {
			return res.status(200).json({
				message: "No valid uncomplete reservations found after cleanup.",
				data: [],
			});
		}

		// Step 6: Remove duplicate reservations based on email and phone, keeping the latest
		const uniqueMap = new Map(); // Key: `${email}|${phone}`, Value: reservation

		validReservations.forEach((reservation) => {
			const email = reservation.customer_details.email
				? reservation.customer_details.email.toLowerCase().trim()
				: "";
			const phone = reservation.customer_details.phone
				? reservation.customer_details.phone.trim()
				: "";
			const key = `${email}|${phone}`;

			if (!uniqueMap.has(key)) {
				uniqueMap.set(key, reservation);
			} else {
				// Compare 'updatedAt' to keep the latest reservation
				const existingReservation = uniqueMap.get(key);
				if (reservation.updatedAt > existingReservation.updatedAt) {
					uniqueMap.set(key, reservation);
				}
			}
		});

		const uniqueReservations = Array.from(uniqueMap.values());

		// Step 7: Fetch existing reservations from the 'Reservations' collection by email or phone
		const emails = uniqueReservations
			.filter((resv) => resv.customer_details.email)
			.map((resv) => resv.customer_details.email.toLowerCase().trim());

		const phoneNumbers = uniqueReservations
			.filter((resv) => resv.customer_details.phone)
			.map((resv) => resv.customer_details.phone.trim());

		const existingReservations = await Reservations.find({
			$or: [
				{ "customer_details.email": { $in: emails } },
				{ "customer_details.phone": { $in: phoneNumbers } },
			],
		}).select(
			"customer_details.email customer_details.phone confirmation_number"
		);

		// Create sets for quick lookup (case-insensitive for emails)
		const existingEmailsSet = new Set(
			existingReservations
				.map((resv) => resv.customer_details.email?.toLowerCase().trim())
				.filter((email) => email)
		);
		const existingPhonesSet = new Set(
			existingReservations
				.map((resv) => resv.customer_details.phone?.trim())
				.filter((phone) => phone)
		);

		// Step 8: Exclude reservations that have their email or phone in existing Reservations
		const actualUncompleteReservations = uniqueReservations.filter(
			(reservation) => {
				const email = reservation.customer_details.email
					? reservation.customer_details.email.toLowerCase().trim()
					: "";
				const phone = reservation.customer_details.phone
					? reservation.customer_details.phone.trim()
					: "";

				// Exclude if email exists OR phone exists in Reservations
				return (
					email &&
					!existingEmailsSet.has(email) &&
					phone &&
					!existingPhonesSet.has(phone)
				);
			}
		);

		return res.status(200).json({
			message: "List of actual uncomplete reservations retrieved successfully.",
			data: actualUncompleteReservations,
		});
	} catch (error) {
		console.error("Error listing uncomplete reservations:", error);
		res.status(500).json({
			message: "An error occurred while listing uncomplete reservations.",
		});
	}
};
