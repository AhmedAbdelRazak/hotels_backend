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

const parseAndNormalizeDate = (dateStringOrNumber) => {
	if (!isNaN(dateStringOrNumber)) {
		// Handle Excel numeric date format
		const excelEpochStart = new Date(1900, 0, 1); // Excel starts on 1900-01-01
		const parsedDate = new Date(
			excelEpochStart.getTime() + (dateStringOrNumber - 2) * 86400000
		); // Subtract 2 to handle Excel bug
		return dayjs(parsedDate).format("YYYY-MM-DD"); // Format as local date string
	}

	const possibleFormats = ["MM/DD/YYYY", "DD/MM/YYYY", "YYYY-MM-DD"];
	for (const format of possibleFormats) {
		const parsedDate = dayjs(dateStringOrNumber, format, true);
		if (parsedDate.isValid()) {
			return parsedDate.format("YYYY-MM-DD"); // Format as local date string
		}
	}

	console.warn(`Unrecognized date format: ${dateStringOrNumber}`);
	return null; // Return null for unparseable dates
};

// Define roomTypes array
const roomTypes = [
	{ value: "standardRooms", label: "Standard Rooms" },
	{ value: "singleRooms", label: "Single Rooms" },
	{ value: "doubleRooms", label: "Double Rooms" },
	{ value: "twinRooms", label: "Twin Rooms" },
	{ value: "queenRooms", label: "Queen Rooms" },
	{ value: "kingRooms", label: "King Rooms" },
	{ value: "tripleRooms", label: "Triple Rooms" },
	{ value: "quadRooms", label: "Quad Rooms" },
	{ value: "studioRooms", label: "Studio Rooms" },
	{ value: "suite", label: "Suite" },
	{ value: "masterSuite", label: "Master Suite" },
	{ value: "familyRooms", label: "Family Rooms" },
	{
		value: "individualBed",
		label: "Rooms With Individual Beds (Shared Rooms)",
	},
	// { value: "other", label: "Other" },
];

// Function to Fetch USD to SAR Conversion Rate
const getUSDToSARRate = async () => {
	try {
		const response = await fetch(
			`https://v6.exchangerate-api.com/v6/${process.env.EXCHANGE_RATE}/pair/USD/SAR/`
		);
		const data = await response.json();

		if (data.result === "success") {
			return data.conversion_rate; // USD to SAR rate
		} else {
			throw new Error("Failed to fetch USD to SAR conversion rate");
		}
	} catch (error) {
		console.error("Error fetching USD to SAR rate:", error);
		throw error;
	}
};

exports.agodaDataDump = async (req, res) => {
	try {
		const accountId = req.params.accountId;
		const userId = req.params.belongsTo;

		// Log the incoming request parameters

		if (!req.file || !req.file.path) {
			console.error("No file uploaded");
			return res.status(400).json({ error: "No file uploaded" });
		}

		const filePath = req.file.path; // Path to uploaded file

		const fileExtension = path
			.extname(req.file.originalname || "")
			.toLowerCase();
		console.log("File Extension:", fileExtension);

		let data = [];

		if (fileExtension === ".xlsx" || fileExtension === ".xls") {
			// Handle Excel files
			const workbook = xlsx.readFile(filePath);
			const sheetName = workbook.SheetNames[0];
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
			// console.log("CSV Headers:", Object.keys(data[0]));
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

			// Normalize and validate all dates
			const checkInDate = parseAndNormalizeDate(item["staydatefrom"]);
			const checkOutDate = parseAndNormalizeDate(item["staydateto"]);
			const bookedDate = parseAndNormalizeDate(item["bookeddate"]);

			if (!checkInDate || !checkOutDate || !bookedDate) {
				console.error("Invalid date format detected. Skipping record:", {
					checkInDate: item["staydatefrom"],
					checkOutDate: item["staydateto"],
					bookedDate: item["bookeddate"],
				});
				continue; // Skip this record if dates are invalid
			}

			console.log("Processed Dates:", {
				checkInDate,
				checkOutDate,
				bookedDate,
			});

			const daysOfResidence = calculateDaysOfResidence(
				checkInDate,
				checkOutDate
			);
			console.log("Days of Residence:", daysOfResidence);

			const dateRange = generateDateRange(checkInDate, checkOutDate);

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
			// Build the pricingByDay array
			const pricingByDayTemplate = dateRange.map((date) => {
				// Standardize the date for comparison
				const standardizedDate = dayjs(date).format("YYYY-MM-DD");

				// Find the matching pricing rate for the given date
				const pricingRate = roomDetails.pricingRate.find(
					(rate) =>
						dayjs(rate.calendarDate).format("YYYY-MM-DD") === standardizedDate
				);

				// Fallback logic for rootPrice
				let rootPrice = 0;
				if (pricingRate) {
					rootPrice = parseFloat(
						pricingRate.rootPrice || pricingRate.price || 0
					);
				} else if (roomDetails.defaultCost) {
					rootPrice = parseFloat(roomDetails.defaultCost);
				} else if (roomDetails.price?.basePrice) {
					rootPrice = parseFloat(roomDetails.price.basePrice);
				} else {
					console.warn(
						`No pricing or default cost found for room: ${roomDetails.displayName} on date: ${standardizedDate}`
					);
				}

				// Calculate price and commission
				const price = totalAmount / (daysOfResidence * roomCount);
				const commissionRate =
					1 -
					Number(item["total_inclusive_rate"] || 0) / Number(totalAmount || 1);

				return {
					date: standardizedDate,
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

			console.log("Original Date: staydatefrom", item["staydatefrom"]);
			console.log(
				"Parsed Date (String) staydateto:",
				parseAndNormalizeDate(item["staydateto"])
			);
			console.log("Final MongoDB Date: checkInDate", checkInDate);
			console.log("Final MongoDB Date: checkOutDate", checkOutDate);

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
				booked_at: bookedDate, // Use normalized date
				sub_total: item["total_inclusive_rate"],
				total_rooms: roomCount,
				total_amount: totalAmount.toFixed(2),
				currency: item["currency"],
				checkin_date: checkInDate, // Use normalized date
				checkout_date: checkOutDate, // Use normalized date
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
				// console.log("Creating new reservation:", itemNumber);
				await Reservations.create(document);
				console.log("Saving to MongoDB:", {
					checkin_date: checkInDate,
					checkout_date: checkOutDate,
				});
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

exports.expediaDataDump = async (req, res) => {
	try {
		const accountId = req.params.accountId;
		const userId = req.params.belongsTo;

		// Validate file upload
		if (!req.file || !req.file.path) {
			console.error("No file uploaded");
			return res.status(400).json({ error: "No file uploaded" });
		}

		const filePath = req.file.path;
		const fileExtension = path
			.extname(req.file.originalname || "")
			.toLowerCase();
		console.log("File Extension:", fileExtension);

		let data = [];

		// Parse the uploaded file based on its extension
		if (fileExtension === ".xlsx" || fileExtension === ".xls") {
			const workbook = xlsx.readFile(filePath);
			const sheetName = workbook.SheetNames[0];
			const sheet = workbook.Sheets[sheetName];
			data = xlsx.utils.sheet_to_json(sheet);
		} else if (fileExtension === ".csv") {
			console.log("Processing CSV file...");
			data = await parseCSV(filePath);
		} else {
			console.error("Unsupported file format:", fileExtension);
			return res.status(400).json({ error: "Unsupported file format" });
		}

		console.log("Parsed Data Length:", data.length);

		if (data.length === 0) {
			console.error("File contains no data");
			return res.status(400).json({ error: "File contains no data" });
		}

		// Fetch hotel details
		const hotelDetails = await HotelDetails.findById(accountId).lean();
		if (!hotelDetails) {
			console.error("Hotel details not found for ID:", accountId);
			return res.status(404).json({ error: "Hotel details not found" });
		}

		console.log("Hotel Details Loaded");

		// Fetch USD to SAR conversion rate
		const usdToSarRate = await getUSDToSARRate();
		console.log(`USD to SAR Conversion Rate: ${usdToSarRate}`);

		// Normalize keys for easier handling
		const normalizeKeys = (obj) => {
			const normalized = {};
			for (const key of Object.keys(obj)) {
				normalized[key.trim().toLowerCase()] = obj[key];
			}
			return normalized;
		};

		for (let item of data) {
			item = normalizeKeys(item);

			// Debugging logs
			console.log("Processed Item Keys:", Object.keys(item));
			console.log("Guest Name:", item["guest"]);

			const reservationId = item["reservation id"]?.toString().trim();
			const confirmationNumber =
				item["confirmation #"]?.toString().trim() || reservationId;

			if (!confirmationNumber) {
				console.warn(
					"Skipping record with missing Reservation ID and Confirmation #"
				);
				continue;
			}

			console.log("Processing item:", confirmationNumber);

			const totalAmountUSD = Number(item["booking amount"] || 0);
			const totalAmountSAR = totalAmountUSD * usdToSarRate;

			console.log("Total Amount (USD):", totalAmountUSD);
			console.log("Total Amount (SAR):", totalAmountSAR.toFixed(2));

			const checkInDate = parseAndNormalizeDate(item["check-in"]);
			const checkOutDate = parseAndNormalizeDate(item["check-out"]);
			const bookedDate = parseAndNormalizeDate(item["booked"]);

			if (!checkInDate || !checkOutDate || !bookedDate) {
				console.error("Invalid date format detected. Skipping record:", {
					checkInDate: item["check-in"],
					checkOutDate: item["check-out"],
					bookedDate: item["booked"],
				});
				continue;
			}

			console.log("Processed Dates:", {
				checkInDate,
				checkOutDate,
				bookedDate,
			});

			const daysOfResidence = calculateDaysOfResidence(
				checkInDate,
				checkOutDate
			);
			console.log("Days of Residence:", daysOfResidence);

			if (daysOfResidence <= 0) {
				console.warn(
					"Skipping record with non-positive days of residence:",
					confirmationNumber
				);
				continue;
			}

			const dateRange = generateDateRange(checkInDate, checkOutDate);
			console.log("Date Range:", dateRange);

			// **Room Type Mapping Logic Starts Here**

			// Extract the 'room' field from the item
			const roomField = item["room"];
			if (!roomField) {
				console.warn(`Missing 'Room' field in record: ${confirmationNumber}`);
				continue;
			}

			// Initialize mappedRoomType as null
			let mappedRoomType = null;

			// Iterate through roomTypes to find a matching room type
			for (const roomType of roomTypes) {
				const roomTypeKeyword = roomType.label.split(" ")[0].toLowerCase(); // First word in label
				if (roomField.toLowerCase().includes(roomTypeKeyword)) {
					mappedRoomType = roomType.value;
					break; // Stop at the first match
				}
			}

			if (!mappedRoomType) {
				console.warn(
					`Room type mapping not found for room: ${roomField} in record: ${confirmationNumber}`
				);
				continue; // Skip this record if no mapping is found
			}

			// Find the corresponding roomDetails from hotelDetails.roomCountDetails
			const roomDetails = hotelDetails.roomCountDetails.find(
				(room) => room.roomType === mappedRoomType
			);

			if (!roomDetails) {
				console.warn(
					`Room details not found for roomType: ${mappedRoomType} in record: ${confirmationNumber}`
				);
				continue; // Skip if roomDetails are not found
			}

			console.log("Room Details Found:", roomDetails.displayName);

			// **Room Type Mapping Logic Ends Here**

			// Assuming each room in the Expedia data represents one room count
			const roomCount = 1;

			// Calculate commission in SAR
			const commissionRate = 0.15;
			const commissionAmountSAR = totalAmountSAR * commissionRate;

			// Build the pricingByDay array with correct calculations in SAR
			const pricingByDayTemplate = dateRange.map((date) => {
				const standardizedDate = dayjs(date).format("YYYY-MM-DD");

				const pricingRate = roomDetails.pricingRate.find(
					(rate) =>
						dayjs(rate.calendarDate).format("YYYY-MM-DD") === standardizedDate
				);

				let rootPriceUSD = 0;
				if (pricingRate && parseFloat(pricingRate.rootPrice) > 0) {
					rootPriceUSD = parseFloat(pricingRate.rootPrice);
				} else if (
					roomDetails.defaultCost &&
					parseFloat(roomDetails.defaultCost) > 0
				) {
					rootPriceUSD = parseFloat(roomDetails.defaultCost);
				} else if (
					roomDetails.price &&
					roomDetails.price.basePrice &&
					parseFloat(roomDetails.price.basePrice) > 0
				) {
					rootPriceUSD = parseFloat(roomDetails.price.basePrice);
				} else {
					console.warn(
						`No pricing or default cost found for room: ${roomDetails.displayName} on date: ${standardizedDate}`
					);
				}

				const rootPriceSAR = rootPriceUSD * usdToSarRate;

				const priceSAR = (totalAmountSAR / daysOfResidence / roomCount).toFixed(
					2
				);
				const totalPriceWithCommissionSAR = priceSAR; // As per requirement
				const totalPriceWithoutCommissionSAR = (
					(totalAmountSAR - commissionAmountSAR) /
					daysOfResidence /
					roomCount
				).toFixed(2);

				return {
					date: standardizedDate,
					price: priceSAR,
					rootPrice: rootPriceSAR.toFixed(2),
					commissionRate: (commissionRate * 100).toFixed(2) + "%",
					totalPriceWithCommission: totalPriceWithCommissionSAR,
					totalPriceWithoutCommission: totalPriceWithoutCommissionSAR,
				};
			});

			// Construct the pickedRoomsType array with accurate pricing in SAR
			const pickedRoomsType = [
				{
					room_type: roomDetails.roomType,
					displayName: roomDetails.displayName,
					chosenPrice: (totalAmountSAR / daysOfResidence / roomCount).toFixed(
						2
					),
					count: roomCount,
					pricingByDay: pricingByDayTemplate,
				},
			];

			console.log("Picked Rooms Type:", pickedRoomsType);

			// Map payment type
			const paymentType = item["payment type"]?.toLowerCase();
			const payment =
				paymentType === "expedia collect"
					? "Paid Online"
					: paymentType === "hotel collect"
					? "Not Paid"
					: "Not Paid";

			// Adjust reservation status
			let reservationStatus = item["status"]?.toLowerCase();
			if (reservationStatus === "prestay") {
				reservationStatus = "confirmed";
			} else if (reservationStatus.includes("cancelled")) {
				reservationStatus = "cancelled";
			} else if (reservationStatus.includes("show")) {
				reservationStatus = "no_show";
			}

			const document = {
				confirmation_number: confirmationNumber,
				booking_source: "online jannat booking", // Consistent Booking Source
				customer_details: {
					name: item["guest"],
					nationality: "", // Assuming nationality is not provided in Expedia data
					phone: "", // Assuming phone is not provided in Expedia data
					email: "", // Assuming email is not provided in Expedia data
				},
				state: "Expedia",
				reservation_status: reservationStatus || "confirmed",
				total_guests: 0, // Assuming guest count is not provided; adjust as needed
				cancel_reason: "", // Assuming cancel reason is not provided; adjust as needed
				booked_at: bookedDate,
				sub_total: totalAmountSAR,
				total_rooms: roomCount,
				total_amount: totalAmountSAR.toFixed(2),
				currency: "SAR", // Converted to SAR
				checkin_date: checkInDate,
				checkout_date: checkOutDate,
				days_of_residence: daysOfResidence,
				comment: "", // Assuming comments are not provided; adjust as needed
				commission: commissionAmountSAR.toFixed(2), // 15% commission in SAR
				payment: payment,
				pickedRoomsType,
				hotelId: accountId,
				belongsTo: userId,
				paid_amount: payment === "Paid Online" ? totalAmountSAR.toFixed(2) : 0,
			};

			// Debugging log for the document
			console.log("Document to be saved:", document);

			// Check if the reservation already exists
			const existingReservation = await Reservations.findOne({
				confirmation_number: confirmationNumber,
				booking_source: "online expedia booking", // Ensure consistency
			});

			if (existingReservation) {
				if (reservationStatus === "cancelled") {
					console.log(
						"Updating existing reservation as cancelled:",
						confirmationNumber
					);
					await Reservations.updateOne(
						{ confirmation_number: confirmationNumber },
						{ $set: { ...document } }
					);
				} else {
					console.log(
						"Duplicate reservation found and not cancelled. Skipping:",
						confirmationNumber
					);
					continue; // Skip duplicates unless they are cancelled
				}
			} else {
				await Reservations.create(document);
				console.log("Saving to MongoDB:", {
					checkin_date: checkInDate,
					checkout_date: checkOutDate,
				});
			}
		}

		res.status(200).json({
			message: "Expedia data has been updated and uploaded successfully.",
		});
	} catch (error) {
		console.error("Error in expediaDataDump:", error);
		res.status(500).json({ error: "Internal Server Error" });
	}
};
