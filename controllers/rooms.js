const Rooms = require("../models/rooms");
const mongoose = require("mongoose");
const fetch = require("node-fetch");
const Reservations = require("../models/reservations");

exports.roomById = (req, res, next, id) => {
	Rooms.findById(id).exec((err, room) => {
		if (err || !room) {
			return res.status(400).json({
				error: "room was not found",
			});
		}
		req.room = room;
		next();
	});
};

exports.create = (req, res) => {
	// Destructure room_number and hotelId from the request body
	const { room_number, hotelId } = req.body;

	// Define the condition for finding the existing room
	const condition = { room_number, hotelId: mongoose.Types.ObjectId(hotelId) };

	// Define the update operation
	const update = req.body;

	// Set the options to upsert and return the new document
	const options = { new: true, upsert: true, setDefaultsOnInsert: true };

	Rooms.findOneAndUpdate(condition, update, options, (err, data) => {
		if (err) {
			console.error(err, "Error in creating/updating room");
			return res.status(400).json({
				error: "Cannot create/update room",
			});
		}
		// If the operation is an insert, upsert returns the document before insert, check for data
		if (!data) {
			return res
				.status(201)
				.json({ message: "Room created successfully", data: update });
		}
		// If the operation is an update, upsert returns the updated document
		res.json({ message: "Room updated successfully", data });
	});
};

exports.read = (req, res) => {
	return res.json(req.room);
};

exports.update = (req, res) => {
	console.log(req.body);
	const room = req.room;
	room.room_number = req.body.room_number;
	room.room_type = req.body.room_type;
	room.room_features = req.body.room_features;
	room.room_pricing = req.body.room_pricing;
	room.floor = req.body.floor;
	room.roomColorCode = req.body.roomColorCode;
	room.belongsTo = req.body.belongsTo;
	room.hotelId = req.body.hotelId;

	room.save((err, data) => {
		if (err) {
			return res.status(400).json({
				error: err,
			});
		}
		res.json(data);
	});
};

exports.deleteRooms = (req, res) => {
	const { hotelId } = req.params;

	// Check if hotelId is a valid ObjectId
	if (!mongoose.Types.ObjectId.isValid(hotelId)) {
		return res.status(400).json({
			error: "Invalid hotelId",
		});
	}

	Rooms.deleteMany(
		{ hotelId: mongoose.Types.ObjectId(hotelId) },
		(err, result) => {
			if (err) {
				console.error("Error deleting rooms:", err);
				return res.status(400).json({
					error: "Error occurred while deleting rooms",
				});
			}
			if (result.deletedCount === 0) {
				return res.status(404).json({
					message: "No rooms found with the given hotelId",
				});
			}
			res.json({
				message: `${result.deletedCount} rooms were successfully deleted`,
			});
		}
	);
};

exports.list = (req, res) => {
	const hotelId = mongoose.Types.ObjectId(req.params.accountId);
	const belongsTo = mongoose.Types.ObjectId(req.params.mainUserId);

	Rooms.find({ hotelId: hotelId, belongsTo: belongsTo })
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

exports.remove = (req, res) => {
	const room = req.room;

	room.remove((err, data) => {
		if (err) {
			return res.status(400).json({
				err: "error while removing",
			});
		}
		res.json({ message: "room deleted" });
	});
};

exports.listForAdmin = (req, res) => {
	Rooms.find()
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

exports.listOfRoomsSummary = async (req, res) => {
	try {
		const { checkin, checkout } = req.params;
		const startDate = new Date(checkin);
		const endDate = new Date(checkout);

		// Aggregate total rooms by type, including room pricing
		const totalRoomsByType = await Rooms.aggregate([
			{
				$group: {
					_id: "$room_type",
					totalRooms: { $sum: 1 },
					roomPricing: { $first: "$room_pricing" },
				},
			},
		]);

		// Find overlapping new reservations
		const overlappingNewReservations = await Reservations.aggregate([
			{
				$match: {
					$or: [
						{ checkin_date: { $lte: endDate, $gte: startDate } },
						{ checkout_date: { $lte: endDate, $gte: startDate } },
						{ checkin_date: { $lte: startDate }, end_date: { $gte: endDate } },
					],
				},
			},
			{ $unwind: "$roomId" },
			{
				$lookup: {
					from: "rooms",
					localField: "roomId",
					foreignField: "_id",
					as: "roomDetails",
				},
			},
			{ $unwind: "$roomDetails" },
			{
				$group: {
					_id: "$roomDetails.room_type",
					bookedCount: { $sum: 1 },
				},
			},
		]);

		// Find overlapping pre-reservations
		// Aggregate pickedRoomsType to get the total count for each room_type
		const overlappingPreReservations = await Reservations.aggregate([
			{
				$match: {
					overallBookingStatus: "Confirmed", // Add this condition
					checkin_date: { $lte: endDate },
					checkout_date: { $gte: startDate },
				},
			},
			{ $unwind: "$pickedRoomsType" },
			{
				$group: {
					_id: "$pickedRoomsType.room_type",
					reservedCount: { $sum: "$pickedRoomsType.count" },
				},
			},
		]);

		// Calculate booked, available, reserved rooms, and include room pricing
		let summary = totalRoomsByType.map((roomType) => {
			let bookedRoomEntry = overlappingNewReservations.find(
				(bnr) => bnr._id === roomType._id
			);
			let bookedCount = bookedRoomEntry ? bookedRoomEntry.bookedCount : 0;

			// Find the reserved count for this room type
			let reservedRoomEntry = overlappingPreReservations.find(
				(pr) => pr._id === roomType._id
			);
			let reservedCount = reservedRoomEntry
				? reservedRoomEntry.reservedCount
				: 0;

			return {
				room_type: roomType._id,
				room_price: roomType.roomPricing,
				available: roomType.totalRooms - bookedCount - reservedCount,
				occupiedRooms: bookedCount,
				reservedRooms: reservedCount,
				totalRooms: roomType.totalRooms,
			};
		});

		res.json(summary);
	} catch (error) {
		res.status(500).send("Server error");
	}
};

exports.hotelRunnerRoomList = async (req, res) => {
	const token = process.env.HOTEL_RUNNER_TOKEN;
	const hrId = process.env.HR_ID;

	const url = `https://app.hotelrunner.com/api/v2/apps/rooms?token=${token}&hr_id=${hrId}`;

	try {
		const response = await fetch(url);
		const data = await response.json();

		if (response.ok) {
			res.json(data.rooms);
		} else {
			throw new Error(`HTTP error! status: ${response.status}`);
		}
	} catch (error) {
		console.error("Error fetching room list:", error);
		res.status(500).json({ error: "Error fetching room list" });
	}
};

exports.getDistinctRoomTypes = async (req, res) => {
	try {
		const distinctRoomTypes = await Rooms.distinct("room_type");
		res.json(distinctRoomTypes);
	} catch (error) {
		console.error("Error fetching distinct room types:", error);
		res.status(500).json({ error: "Error fetching distinct room types" });
	}
};

exports.getDistinctRoomTypesFromReservations = async (req, res) => {
	try {
		const distinctRoomTypes = await Reservations.aggregate([
			{ $unwind: "$pickedRoomsType" },
			{ $group: { _id: "$pickedRoomsType.room_type" } },
			{ $project: { roomType: "$_id", _id: 0 } },
		]);

		const roomTypes = distinctRoomTypes
			.map((item) => item.roomType)
			.filter((type) => type !== "");

		res.json(roomTypes);
	} catch (error) {
		console.error(
			"Error fetching distinct room types from reservations:",
			error
		);
		res
			.status(500)
			.json({ error: "Error fetching distinct room types from reservations" });
	}
};

exports.getDistinctHotelRunnerRooms = async (req, res) => {
	const token = process.env.HOTEL_RUNNER_TOKEN;
	const hrId = process.env.HR_ID;

	const url = `https://app.hotelrunner.com/api/v2/apps/rooms?token=${token}&hr_id=${hrId}`;

	try {
		const response = await fetch(url);
		const data = await response.json();

		if (response.ok && data.rooms) {
			const roomTypesAndCodes = data.rooms.map((room) => ({
				roomType: room.name,
				roomCode: room.rate_code,
			}));

			// Remove duplicates if any
			const uniqueRoomTypesAndCodes = Array.from(
				new Set(roomTypesAndCodes.map(JSON.stringify))
			).map(JSON.parse);

			res.json(uniqueRoomTypesAndCodes);
		} else {
			throw new Error(`HTTP error! status: ${response.status}`);
		}
	} catch (error) {
		console.error("Error fetching room types and codes:", error);
		res.status(500).json({ error: "Error fetching room types and codes" });
	}
};

exports.reservedRoomsSummary = async (req, res) => {
	const { startdate, enddate, belongsTo, accountId } = req.params;
	const belongsToId = mongoose.Types.ObjectId(belongsTo);
	const accound_id = mongoose.Types.ObjectId(accountId);

	try {
		// Aggregate to count the reserved rooms within the specified date range
		const reservedRooms = await Reservations.aggregate([
			{
				$match: {
					belongsTo: belongsToId,
					hotelId: accound_id,
					$or: [{ roomId: { $eq: [] } }, { roomId: { $eq: [null] } }],
					checkin_date: { $gte: new Date(startdate) },
					checkout_date: { $lte: new Date(enddate) },
				},
			},
			{ $unwind: "$pickedRoomsType" },
			{
				$addFields: {
					simplifiedRoomType: {
						$switch: {
							branches: [
								{
									case: {
										$regexMatch: {
											input: { $toLower: "$pickedRoomsType.room_type" },
											regex: "quadrooms|quadruple",
										},
									},
									then: "quadRooms",
								},
								{
									case: {
										$regexMatch: {
											input: { $toLower: "$pickedRoomsType.room_type" },
											regex: "triplerooms|triple",
										},
									},
									then: "tripleRooms",
								},
								{
									case: {
										$regexMatch: {
											input: { $toLower: "$pickedRoomsType.room_type" },
											regex: "doublerooms|double",
										},
									},
									then: "doubleRooms",
								},
								{
									case: {
										$regexMatch: {
											input: { $toLower: "$pickedRoomsType.room_type" },
											regex: "suite",
										},
									},
									then: "suite",
								},
								{
									case: {
										$regexMatch: {
											input: { $toLower: "$pickedRoomsType.room_type" },
											regex: "familyrooms|family",
										},
									},
									then: "familyRooms",
								},
							],
							default: "$pickedRoomsType.room_type",
						},
					},
				},
			},
			{
				$group: {
					_id: "$simplifiedRoomType",
					reserved: { $sum: 1 },
				},
			},
		]);

		const occupiedRooms = await Reservations.aggregate([
			{
				$match: {
					belongsTo: belongsToId,
					hotelId: accound_id,
					roomId: { $not: { $size: 0 } },
					checkin_date: { $gte: new Date(startdate) },
					checkout_date: { $lte: new Date(enddate) },
				},
			},
			{ $unwind: "$pickedRoomsType" },
			{
				$addFields: {
					simplifiedRoomType: {
						$switch: {
							branches: [
								{
									case: {
										$regexMatch: {
											input: { $toLower: "$pickedRoomsType.room_type" },
											regex: "quadrooms|quadruple",
										},
									},
									then: "quadRooms",
								},
								{
									case: {
										$regexMatch: {
											input: { $toLower: "$pickedRoomsType.room_type" },
											regex: "triplerooms|triple",
										},
									},
									then: "tripleRooms",
								},
								{
									case: {
										$regexMatch: {
											input: { $toLower: "$pickedRoomsType.room_type" },
											regex: "doublerooms|double",
										},
									},
									then: "doubleRooms",
								},
								{
									case: {
										$regexMatch: {
											input: { $toLower: "$pickedRoomsType.room_type" },
											regex: "suite",
										},
									},
									then: "suite",
								},
								{
									case: {
										$regexMatch: {
											input: { $toLower: "$pickedRoomsType.room_type" },
											regex: "familyrooms|family",
										},
									},
									then: "familyRooms",
								},
							],
							default: "$pickedRoomsType.room_type",
						},
					},
				},
			},
			{
				$group: {
					_id: "$simplifiedRoomType",
					occupied: { $sum: "$pickedRoomsType.count" }, // Summing the count of rooms
				},
			},
		]);

		// const debugRooms = await Reservations.aggregate([
		// 	// ... Replicate your existing match, unwind, and addFields stages ...
		// 	{
		// 		$project: {
		// 			simplifiedRoomType: 1,
		// 			originalRoomType: "$pickedRoomsType.room_type",
		// 		},
		// 	},
		// ]);

		// Get the total number of rooms from the Rooms schema
		const totalRooms = await Rooms.aggregate([
			{
				$match: {
					belongsTo: belongsToId,
					hotelId: accound_id,
				},
			},
			{
				$group: {
					_id: "$room_type",
					total_available: { $sum: 1 },
				},
			},
		]);

		console.log(occupiedRooms, "occupiedRooms");

		// Merging reserved and occupied counts with total rooms
		const summary = totalRooms.map((room) => {
			const reservedRoom = reservedRooms.find((r) => r._id === room._id) || {
				reserved: 0,
			};
			const occupiedRoom = occupiedRooms.find((r) => r._id === room._id) || {
				occupied: 0,
			};
			return {
				room_type: room._id,
				total_available: room.total_available,
				reserved: reservedRoom.reserved,
				occupied: occupiedRoom.occupied,
				available:
					room.total_available - reservedRoom.reserved - occupiedRoom.occupied,
				start_date: startdate,
				end_date: enddate,
			};
		});
		res.json(summary);
	} catch (error) {
		console.error("Error in reservedRoomsSummary:", error);
		res.status(500).send("Error fetching reserved rooms summary");
	}
};

// Helper function to generate date range
const generateDateRange = (startDate, days) => {
	return Array.from({ length: days }, (_, index) => {
		const date = new Date(startDate);
		date.setDate(startDate.getDate() + index);
		return date;
	});
};

// Main function to get room inventory over time, refactored for dynamic date handling
exports.roomsInventorySummary = async (req, res) => {
	const { belongsTo, accountId } = req.params;
	const belongsToId = mongoose.Types.ObjectId(belongsTo);
	const account_Id = mongoose.Types.ObjectId(accountId);
	const startDate = new Date();
	const dateRange = generateDateRange(startDate, 50);

	try {
		const totalRoomsByType = await getTotalRoomsByType(belongsToId, account_Id);

		let inventorySummary = [];

		for (let date of dateRange) {
			const dailyInventory = await calculateDailyInventory(
				date,
				belongsToId,
				account_Id,
				totalRoomsByType
			);
			inventorySummary.push(...dailyInventory);
		}

		// Flatten the array of arrays into a single array
		inventorySummary = inventorySummary.flat();

		res.json(inventorySummary);
	} catch (error) {
		console.error("Error in roomsInventorySummary:", error);
		res.status(500).send("Error fetching rooms inventory summary");
	}
};

// Aggregates total rooms by type
async function getTotalRoomsByType(belongsToId, accountId) {
	return Rooms.aggregate([
		{
			$match: {
				belongsTo: belongsToId,
				hotelId: accountId,
			},
		},
		{
			$group: {
				_id: "$room_type",
				total: { $sum: 1 },
			},
		},
	]);
}

async function calculateDailyInventory(
	date,
	belongsToId,
	accountId,
	totalRoomsByType
) {
	const inventoryForDate = await Promise.all(
		totalRoomsByType.map(async (roomType) => {
			// Fetch reservations that are active for 'date' and not cancelled
			const overlappingReservations = await Reservations.find({
				belongsTo: belongsToId,
				hotelId: accountId,
				reservation_status: { $nin: ["cancelled", "no_show"] }, // Exclude both cancelled and no_show statuses
				checkin_date: { $lte: date },
				checkout_date: { $gt: date },
			});

			let totalReserved = 0;
			let totalOccupied = 0;

			// Process each reservation to calculate totalReserved and totalOccupied
			for (const reservation of overlappingReservations) {
				const isOccupied =
					reservation.roomId &&
					reservation.roomId.length > 0 &&
					!reservation.roomId.includes(null);

				// Calculate reserved based on pickedRoomsType and mapRoomType function
				const matchedRoomTypes = reservation.pickedRoomsType.filter(
					(prt) => mapRoomType(prt.room_type) === roomType._id
				);

				matchedRoomTypes.forEach((matchedRoomType) => {
					if (isOccupied) {
						// Increment totalOccupied based on the count in matchedRoomType
						totalOccupied += matchedRoomType.count;
					} else {
						// Increment totalReserved based on the count in matchedRoomType
						totalReserved += matchedRoomType.count;
					}
				});
			}

			return {
				date: date.toISOString().split("T")[0],
				room_type: roomType._id,
				total_rooms: roomType.total,
				total_rooms_available: roomType.total - totalReserved - totalOccupied,
				total_rooms_reserved: totalReserved,
				total_rooms_occupied: totalOccupied,
			};
		})
	);

	return inventoryForDate;
}

// Updated definition of the mapRoomType function with a type check
function mapRoomType(roomType) {
	// Check if roomType is a string before proceeding
	if (typeof roomType !== "string") {
		// console.warn("mapRoomType called with non-string argument:", roomType);
		return roomType; // Return as is or handle differently as needed
	}

	const lowerCaseRoomType = roomType.toLowerCase();
	if (lowerCaseRoomType.includes("double")) return "doubleRooms";
	if (lowerCaseRoomType.includes("triple")) return "tripleRooms";
	if (lowerCaseRoomType.includes("quad")) return "quadRooms";
	if (lowerCaseRoomType.includes("family")) return "familyRooms";
	// Default case if no specific mapping found
	return "otherRooms"; // Consider handling unexpected room types explicitly
}
