const fs = require("fs");
const path = require("path");
const xlsx = require("xlsx"); // Ensure the xlsx library is installed
const csvParser = require("csv-parser"); // Install csv-parser: npm install csv-parser
const moment = require("moment-timezone");
const Reservations = require("../models/reservations");
const HotelDetails = require("../models/hotel_details");
const dayjs = require("dayjs");

const calculateDaysOfResidence = (checkIn, checkOut) => {
	const checkInDate = new Date(new Date(checkIn).setHours(0, 0, 0, 0));
	const checkOutDate = new Date(new Date(checkOut).setHours(0, 0, 0, 0));
	if (isNaN(checkInDate.getTime()) || isNaN(checkOutDate.getTime())) {
		return 0; // Return 0 if dates are invalid
	}
	const diffInTime = checkOutDate.getTime() - checkInDate.getTime();
	return diffInTime / (1000 * 3600 * 24); // Difference in days
};

const generateDateRange = (startDate, endDate) => {
	const start = dayjs(startDate);
	const end = dayjs(endDate);
	const dateArray = [];
	let currentDate = start;
	while (currentDate.isBefore(end, "day")) {
		dateArray.push(currentDate.format("YYYY-MM-DD"));
		currentDate = currentDate.add(1, "day");
	}
	return dateArray;
};

const parseCSV = (filePath) => {
	return new Promise((resolve, reject) => {
		const data = [];
		fs.createReadStream(filePath)
			.pipe(csvParser())
			.on("data", (row) => {
				data.push(row);
			})
			.on("end", () => {
				resolve(data);
			})
			.on("error", (error) => {
				reject(error);
			});
	});
};

exports.agodaDataDump = async (req, res) => {
	try {
		const accountId = req.params.accountId;
		const userId = req.params.belongsTo;

		// Log the incoming request parameters
		console.log("Account ID:", accountId);
		console.log("User ID:", userId);

		if (!req.file || !req.file.path) {
			console.error("No file uploaded");
			return res.status(400).json({ error: "No file uploaded" });
		}

		const filePath = req.file.path; // Path to uploaded file
		console.log("File Path:", filePath);

		const fileExtension = path
			.extname(req.file.originalname || "")
			.toLowerCase();
		console.log("File Extension:", fileExtension);

		let data = [];

		if (fileExtension === ".xlsx" || fileExtension === ".xls") {
			console.log("Processing Excel file...");
			// Handle Excel files
			const workbook = xlsx.readFile(filePath);
			const sheetName = workbook.SheetNames[0];
			console.log("Excel Sheet Name:", sheetName);
			const sheet = workbook.Sheets[sheetName];
			data = xlsx.utils.sheet_to_json(sheet);
		} else if (fileExtension === ".csv") {
			console.log("Processing CSV file...");
			// Handle CSV files
			data = await parseCSV(filePath);
		} else {
			// Unsupported file type
			console.error("Unsupported file format:", fileExtension);
			return res.status(400).json({ error: "Unsupported file format" });
		}

		console.log("Parsed Data Length:", data.length);
		if (data.length > 0) {
			console.log("CSV Headers:", Object.keys(data[0]));
		}

		if (data.length === 0) {
			console.error("File contains no data");
			return res.status(400).json({ error: "File contains no data" });
		}

		const hotelDetails = await HotelDetails.findById(accountId).lean();
		if (!hotelDetails) {
			console.error("Hotel details not found for ID:", accountId);
			return res.status(404).json({ error: "Hotel details not found" });
		}

		console.log("Hotel Details Loaded");

		// Normalize keys for easier handling
		const normalizeKeys = (obj) => {
			const normalized = {};
			for (const key of Object.keys(obj)) {
				normalized[key.trim().toLowerCase()] = obj[key];
			}
			return normalized;
		};

		for (let item of data) {
			item = normalizeKeys(item); // Normalize the item keys
			console.log("Normalized Item:", item);

			const itemNumber = item["bookingidexternal_reference_id"]
				?.toString()
				.trim();
			if (!itemNumber) {
				console.warn(
					"Skipping record with missing BookingIDExternal_reference_ID"
				);
				continue;
			}

			console.log("Processing item:", itemNumber);

			const totalAmount =
				Number(item["referencesellinclusive"]) > 0
					? Number(item["referencesellinclusive"])
					: Number(item["total_inclusive_rate"] || 0) +
					  Number(item["commission"] || 0);

			console.log("Total Amount Calculated:", totalAmount);

			const daysOfResidence = calculateDaysOfResidence(
				item["staydatefrom"],
				item["staydateto"]
			);
			console.log("Days of Residence:", daysOfResidence);

			const dateRange = generateDateRange(
				item["staydatefrom"],
				item["staydateto"]
			);
			console.log("Date Range:", dateRange);

			const roomDetails = hotelDetails.roomCountDetails.find(
				(room) =>
					room.displayName.toLowerCase() ===
					item["room name"]?.toLowerCase().trim()
			);

			if (!roomDetails) {
				console.warn(
					`Room details not found for displayName: ${item["room name"]}`
				);
				continue;
			}

			console.log("Room Details Found:", roomDetails.displayName);

			const roomCount = parseInt(item["room count"] || 1, 10);

			// Build the pricingByDay array
			const pricingByDayTemplate = dateRange.map((date) => {
				const pricingRate = roomDetails.pricingRate.find(
					(rate) => dayjs(rate.date).format("YYYY-MM-DD") === date
				);

				let rootPrice = 0;
				if (pricingRate) {
					rootPrice = pricingRate.basePrice || 0;
				} else if (roomDetails.defaultCost) {
					rootPrice = roomDetails.defaultCost;
				} else if (roomDetails.price?.basePrice) {
					rootPrice = roomDetails.price.basePrice;
				} else {
					console.warn(
						`No pricing or default cost found for room: ${item["room name"]}`
					);
				}

				const price = totalAmount / (daysOfResidence * roomCount);
				const commissionRate =
					1 -
					Number(item["total_inclusive_rate"] || 0) / Number(totalAmount || 1);

				return {
					date,
					price: price.toFixed(2),
					rootPrice: rootPrice.toFixed(2),
					commissionRate: commissionRate.toFixed(2),
					totalPriceWithCommission: price.toFixed(2),
					totalPriceWithoutCommission: (
						price -
						rootPrice * commissionRate
					).toFixed(2),
				};
			});

			const pickedRoomsType = Array.from({ length: roomCount }, () => ({
				room_type: roomDetails.roomType,
				displayName: roomDetails.displayName,
				chosenPrice: (totalAmount / daysOfResidence / roomCount).toFixed(2),
				count: 1,
				pricingByDay: pricingByDayTemplate,
			}));

			console.log("Picked Rooms Type:", pickedRoomsType);

			const document = {
				confirmation_number: itemNumber,
				booking_source: "online jannat booking",
				customer_details: {
					name: item["customer_name"],
					nationality: item["customer_nationality"],
					phone: item["customer_phone"] || "",
					email: item["customer_email"] || "",
				},
				state: "Agoda",
				reservation_status: item["status"].toLowerCase().includes("cancelled")
					? "cancelled"
					: item["status"].toLowerCase().includes("show")
					? "no_show"
					: item["status"],
				total_guests:
					Number(item["no_of_adult"] || 0) +
					Number(item["no_of_children"] || 0),
				cancel_reason: item["cancellationpolicydescription"] || "",
				booked_at: moment.tz(item["bookeddate"], "Asia/Riyadh").toDate(),
				sub_total: item["total_inclusive_rate"],
				total_rooms: roomCount,
				total_amount: totalAmount.toFixed(2),
				currency: item["currency"],
				checkin_date: moment.tz(item["staydatefrom"], "Asia/Riyadh").toDate(),
				checkout_date: moment.tz(item["staydateto"], "Asia/Riyadh").toDate(),
				days_of_residence: daysOfResidence,
				comment: item["special_request"] || "",
				commission: Number(
					totalAmount - Number(item["total_inclusive_rate"])
				).toFixed(2),
				payment:
					item["paymentmodel"].toLowerCase() === "agoda collect"
						? "Paid Online"
						: "Not Paid",
				pickedRoomsType,
				hotelId: accountId,
				belongsTo: userId,
				paid_amount:
					item["paymentmodel"].toLowerCase() === "agoda collect"
						? totalAmount.toFixed(2)
						: 0,
			};

			console.log("Document to Save:", document);

			const existingReservation = await Reservations.findOne({
				confirmation_number: itemNumber,
				booking_source: "online jannat booking",
			});

			if (existingReservation) {
				console.log("Updating existing reservation:", itemNumber);
				await Reservations.updateOne(
					{ confirmation_number: itemNumber },
					{ $set: { ...document } }
				);
			} else {
				console.log("Creating new reservation:", itemNumber);
				await Reservations.create(document);
			}
		}

		res
			.status(200)
			.json({ message: "Data has been updated and uploaded successfully." });
	} catch (error) {
		console.error("Error in agodaDataDump:", error);
		res.status(500).json({ error: "Internal Server Error" });
	}
};
