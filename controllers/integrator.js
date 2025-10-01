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
	// Add bidi marks removal: \u200E (LRM), \u200F (RLM), and \u202A–\u202E
	const sanitizeKey = (k) =>
		String(k)
			.replace(/^\uFEFF/, "") // BOM at start
			.replace(/[\u200B-\u200D\u2060]/g, "") // zero-widths (ZWSP/ZWJ/ZWNJ/WORD JOINER)
			.replace(/[\u200E\u200F\u202A-\u202E]/g, "") // LRM/RLM & bidi embeddings
			.replace(/\u00A0/g, " ") // NBSP → space
			.replace(/[._-]+/g, " ") // ., _, - → space
			.replace(/\s+/g, " ") // collapse spaces
			.trim()
			.toLowerCase();

	const sanitizeValue = (v) => {
		if (v === null || v === undefined) return v;
		let s = String(v);
		s = s
			.replace(/^\uFEFF/, "")
			.replace(/[\u200B-\u200D\u2060]/g, "")
			.replace(/[\u200E\u200F\u202A-\u202E]/g, "")
			.replace(/\u00A0/g, " ")
			.trim();
		return s;
	};

	return new Promise((resolve, reject) => {
		const rows = [];
		fs.createReadStream(filePath)
			.pipe(
				csvParser({
					mapHeaders: ({ header }) => sanitizeKey(header),
					mapValues: ({ value }) => sanitizeValue(value),
				})
			)
			.on("data", (row) => rows.push(row))
			.on("end", () => resolve(rows))
			.on("error", (error) => reject(error));
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

		if (fileExtension === ".xlsx" || fileExtension === ".xls") {
			const workbook = xlsx.readFile(filePath);
			const sheetName = workbook.SheetNames[0];
			const sheet = workbook.Sheets[sheetName];
			data = xlsx.utils.sheet_to_json(sheet);
		} else if (fileExtension === ".csv") {
			console.log("Processing CSV file...");
			// Uses the hardened parseCSV above
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

		// ---- Helpers (same sanitizer used by parseCSV) ----
		const USD_TO_SAR = 3.75;

		const sanitizeKey = (k) =>
			String(k)
				.replace(/^\uFEFF/, "")
				.replace(/[\u200B-\u200D\u2060]/g, "")
				.replace(/[\u200E\u200F\u202A-\u202E]/g, "") // <— add this
				.replace(/\u00A0/g, " ")
				.replace(/[._-]+/g, " ")
				.replace(/\s+/g, " ")
				.trim()
				.toLowerCase();

		const sanitizeValue = (v) => {
			if (v === null || v === undefined) return v;
			let s = String(v);
			s = s
				.replace(/^\uFEFF/, "")
				.replace(/[\u200B-\u200D\u2060]/g, "")
				.replace(/[\u200E\u200F\u202A-\u202E]/g, "") // <— add this
				.replace(/\u00A0/g, " ")
				.trim();
			return s;
		};

		// Normalize a row's keys + trim values (safe for XLSX and CSV)
		const normalizeRow = (obj) => {
			const out = {};
			for (const rawKey of Object.keys(obj)) {
				out[sanitizeKey(rawKey)] = sanitizeValue(obj[rawKey]);
			}
			return out;
		};

		// Pick first non-empty among synonyms
		const pick = (row, candidates) => {
			for (const c of candidates) {
				const key = sanitizeKey(c);
				if (row[key] !== undefined && row[key] !== null) {
					const s = String(row[key]).trim();
					if (s !== "") return s;
				}
			}
			return "";
		};

		const n = (v) => {
			if (v === null || v === undefined) return 0;
			const num = parseFloat(String(v).replace(/[^\d.-]/g, ""));
			return isNaN(num) ? 0 : num;
		};

		const parseDateExpedia = (value) => {
			// Try your existing parser first
			const d = parseAndNormalizeDate(value);
			if (d) return d;
			// ISO fallback (e.g., 2025-09-30T15:10:00-07:00)
			const isoTry = dayjs(value);
			if (isoTry.isValid()) return isoTry.format("YYYY-MM-DD");
			return null;
		};

		const mapExpediaRoomType = (roomNameRaw) => {
			if (!roomNameRaw) return null;
			const s = String(roomNameRaw).toLowerCase();
			if (s.includes("master") && s.includes("suite")) return "masterSuite";
			if (s.includes("quadruple") || s.includes("quad")) return "quadRooms";
			if (s.includes("triple")) return "tripleRooms";
			if (s.includes("twin")) return "twinRooms";
			if (s.includes("double")) return "doubleRooms";
			if (s.includes("single")) return "singleRooms";
			if (s.includes("king")) return "kingRooms";
			if (s.includes("queen")) return "queenRooms";
			if (s.includes("family")) return "familyRooms";
			if (s.includes("studio")) return "studioRooms";
			if (s.includes("suite")) return "suite";
			if (s.includes("standard")) return "standardRooms";
			if (s.includes("shared") || s.includes("individual"))
				return "individualBed";
			return null;
		};

		const resolveRootPriceForDate = (roomDetails, ymd) => {
			const pr = roomDetails.pricingRate?.find(
				(rate) => dayjs(rate.calendarDate).format("YYYY-MM-DD") === ymd
			);
			let rootPrice = 0;
			if (pr) {
				rootPrice = n(pr.rootPrice || pr.price);
			} else if (roomDetails.defaultCost) {
				rootPrice = n(roomDetails.defaultCost);
			} else if (roomDetails.price?.basePrice) {
				rootPrice = n(roomDetails.price.basePrice);
			}
			return rootPrice;
		};

		for (const raw of data) {
			// For XLSX path we still normalize; for CSV path headers are already sanitized
			const row = normalizeRow(raw);

			// ---- Field extraction with synonyms (rock‑solid) ----
			const confirmationNumber =
				pick(row, [
					"confirmation #",
					"confirmation number",
					"confirmation",
					"itinerary number",
				]) ||
				pick(row, ["reservation id", "reservationid", "booking id", "res id"]);

			if (!confirmationNumber) {
				console.warn(
					"Skipping record with missing Reservation ID / Confirmation #"
				);
				continue;
			}

			const bookingAmountUSD = n(
				pick(row, ["booking amount", "amount", "total amount", "charge amount"])
			);
			const totalAmountSAR = Number((bookingAmountUSD * USD_TO_SAR).toFixed(2));

			const checkInDate = parseDateExpedia(
				pick(row, [
					"check-in",
					"check in",
					"arrival",
					"arrival date",
					"start date",
				])
			);
			const checkOutDate = parseDateExpedia(
				pick(row, [
					"check-out",
					"check out",
					"departure",
					"departure date",
					"end date",
				])
			);
			const bookedDate = parseDateExpedia(
				pick(row, ["booked", "booked date", "created", "created date"])
			);

			if (!checkInDate || !checkOutDate || !bookedDate) {
				console.error("Invalid date(s). Skipping record:", {
					checkIn: row["check in"] ?? row["check-in"],
					checkOut: row["check out"] ?? row["check-out"],
					booked: row["booked"],
				});
				continue;
			}

			const daysOfResidence = calculateDaysOfResidence(
				checkInDate,
				checkOutDate
			);
			if (daysOfResidence <= 0) {
				console.warn("Non-positive nights; skipping:", confirmationNumber);
				continue;
			}

			const dateRange = generateDateRange(checkInDate, checkOutDate);

			const roomField =
				pick(row, [
					"room",
					"room type",
					"room name",
					"accommodation",
					"unit",
					"unit type",
				]) || "";
			if (!roomField) {
				console.warn(`Missing 'Room' for record: ${confirmationNumber}`);
				continue;
			}

			const mappedRoomType = mapExpediaRoomType(roomField);
			let roomDetails =
				(mappedRoomType &&
					hotelDetails.roomCountDetails.find(
						(r) => r.roomType === mappedRoomType
					)) ||
				hotelDetails.roomCountDetails.find(
					(r) =>
						(r.displayName || "").toLowerCase().trim() ===
						roomField.toLowerCase().trim()
				) ||
				hotelDetails.roomCountDetails.find((r) =>
					roomField.toLowerCase().includes((r.displayName || "").toLowerCase())
				);

			if (!roomDetails) {
				console.warn(
					`Room details not found for "${roomField}" (mapped: ${mappedRoomType}). Skipping ${confirmationNumber}.`
				);
				continue;
			}

			const roomCount = Math.max(
				1,
				n(pick(row, ["room count", "rooms", "quantity"])) || 1
			);

			// ---- Build root-price timeline (per room) ----
			const initialPricingByDay = dateRange.map((ymd) => {
				const rootPrice = resolveRootPriceForDate(roomDetails, ymd);
				return { date: ymd, rootPrice: Number(rootPrice.toFixed(2)) };
			});

			const sumRootPricePerRoom = initialPricingByDay.reduce(
				(acc, d) => acc + d.rootPrice,
				0
			);
			const sumRootPriceAllRooms = Number(
				(sumRootPricePerRoom * roomCount).toFixed(2)
			);

			let commissionAmountSAR = Number(
				(totalAmountSAR - sumRootPriceAllRooms).toFixed(2)
			);
			if (commissionAmountSAR < 0) commissionAmountSAR = 0;
			const commissionRate =
				totalAmountSAR > 0
					? Number((commissionAmountSAR / totalAmountSAR).toFixed(4))
					: 0;

			const pricePerDayPerRoom = Number(
				(totalAmountSAR / daysOfResidence / roomCount).toFixed(2)
			);

			const pricingByDayTemplate = dateRange.map((ymd) => {
				const rootForDay =
					initialPricingByDay.find((d) => d.date === ymd)?.rootPrice || 0;
				const totalPriceWithoutCommission = Number(
					(pricePerDayPerRoom - rootForDay * commissionRate).toFixed(2)
				);
				return {
					date: ymd,
					price: pricePerDayPerRoom.toFixed(2),
					rootPrice: rootForDay.toFixed(2),
					commissionRate: commissionRate.toFixed(2),
					totalPriceWithCommission: pricePerDayPerRoom.toFixed(2),
					totalPriceWithoutCommission: totalPriceWithoutCommission.toFixed(2),
				};
			});

			const pickedRoomsType = Array.from({ length: roomCount }, () => ({
				room_type: roomDetails.roomType,
				displayName: roomDetails.displayName,
				chosenPrice: pricePerDayPerRoom.toFixed(2),
				count: 1,
				pricingByDay: pricingByDayTemplate,
			}));

			// ---- Guest details (bulletproof) ----
			let guestName =
				pick(row, [
					"guest",
					"guest name",
					"primary guest",
					"lead guest",
					"traveler",
					"traveler name",
					"name",
				]) || "";

			if (!guestName) {
				const first = pick(row, ["first name", "first"]);
				const last = pick(row, ["last name", "last"]);
				if (first || last) guestName = `${first} ${last}`.trim();
			}

			const email = pick(row, [
				"email",
				"guest email",
				"e-mail",
				"guest e-mail",
			]);
			const phone = pick(row, [
				"phone",
				"guest phone",
				"telephone",
				"guest telephone",
				"mobile",
			]);
			const nationality = pick(row, [
				"nationality",
				"guest nationality",
				"country",
			]);

			// ---- Payment / status ----
			const paymentType = (
				pick(row, ["payment type", "payment model", "payment"]) || ""
			).toLowerCase();
			const payment = paymentType.includes("expedia collect")
				? "Paid Online"
				: paymentType.includes("hotel collect")
				? "Not Paid"
				: "Not Paid";

			let reservationStatus = (
				pick(row, ["status", "reservation status"]) || ""
			).toLowerCase();
			if (reservationStatus === "prestay" || reservationStatus === "pre-stay") {
				reservationStatus = "confirmed";
			} else if (reservationStatus.includes("cancel")) {
				reservationStatus = "cancelled";
			} else if (reservationStatus.includes("show")) {
				reservationStatus = "no_show";
			}

			const document = {
				confirmation_number: confirmationNumber,
				booking_source: "online jannat booking",
				customer_details: {
					name: guestName || "", // <— now reliably populated
					nationality: nationality || "",
					phone: phone || "",
					email: email || "",
				},
				state: "Expedia",
				reservation_status: reservationStatus || "confirmed",
				total_guests:
					(n(pick(row, ["no_of_adult", "adults", "adult"])) || 0) +
					(n(pick(row, ["no_of_children", "children", "child"])) || 0),
				cancel_reason: "",
				booked_at: bookedDate,
				sub_total: sumRootPriceAllRooms.toFixed(2),
				total_rooms: roomCount,
				total_amount: totalAmountSAR.toFixed(2),
				currency: "SAR",
				checkin_date: checkInDate,
				checkout_date: checkOutDate,
				days_of_residence: daysOfResidence,
				comment: "",
				financeStatus: payment,
				payment: payment,
				paid_amount: payment === "Paid Online" ? totalAmountSAR.toFixed(2) : 0,
				commission: commissionAmountSAR.toFixed(2),
				pickedRoomsType,
				hotelId: accountId,
				belongsTo: userId,
			};

			const existing = await Reservations.findOne({
				confirmation_number: confirmationNumber,
				booking_source: "online jannat booking",
			});

			if (existing) {
				await Reservations.updateOne(
					{
						confirmation_number: confirmationNumber,
						booking_source: "online jannat booking",
					},
					{ $set: { ...document } }
				);
				console.log("Updated existing reservation:", confirmationNumber);
			} else {
				await Reservations.create(document);
				console.log("Created reservation:", confirmationNumber);
			}
		}

		res.status(200).json({
			message:
				"Expedia data has been updated and uploaded successfully (USD→SAR @3.75).",
		});
	} catch (error) {
		console.error("Error in expediaDataDump:", error);
		res.status(500).json({ error: "Internal Server Error" });
	}
};
