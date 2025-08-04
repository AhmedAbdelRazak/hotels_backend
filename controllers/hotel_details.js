const HotelDetails = require("../models/hotel_details");
const mongoose = require("mongoose");
const _ = require("lodash");
const axios = require("axios");

exports.hotelDetailsById = (req, res, next, id) => {
	if (!mongoose.Types.ObjectId.isValid(id)) {
		return res.status(400).json({ error: "Invalid hotel ID" });
	}

	HotelDetails.findById(id).exec((err, hotelDetails) => {
		if (err || !hotelDetails) {
			return res.status(400).json({
				error: "Hotel details were not found",
			});
		}
		req.hotelDetails = hotelDetails;
		next();
	});
};

exports.create = (req, res) => {
	const hotelDetails = new HotelDetails(req.body);
	hotelDetails.save((err, data) => {
		if (err) {
			console.log(err, "err");
			return res.status(400).json({
				error: "Cannot create hotel details",
			});
		}
		res.json({ data });
	});
};

exports.read = (req, res) => {
	return res.json(req.hotelDetails);
};

const ensureUniqueRoomColors = (roomCountDetails) => {
	const colorMap = {};

	roomCountDetails.forEach((room) => {
		if (!colorMap[room.roomType]) {
			colorMap[room.roomType] = new Set();
		}

		// Check if roomColor already exists in the roomType group
		if (room.roomColor && colorMap[room.roomType].has(room.roomColor)) {
			// Generate a new unique color
			room.roomColor = generateUniqueDarkColor([...colorMap[room.roomType]]);
			console.log(
				`Duplicate color found for roomType ${room.roomType}. Generated new color: ${room.roomColor}`
			);
		}

		if (room.roomColor) {
			colorMap[room.roomType].add(room.roomColor);
		}
	});
};

/**
 * Constructs the fields to be updated in the HotelDetails document.
 * Merges roomCountDetails and paymentSettings while ensuring unique room colors.
 * @param {Object} hotelDetails - The existing hotel details from the database.
 * @param {Object} updateData - The incoming data to update.
 * @returns {Object} - The fields to be updated.
 */
const constructUpdatedFields = (hotelDetails, updateData, fromPage) => {
	const updatedFields = {};

	// Process roomCountDetails if provided
	if (
		updateData.roomCountDetails &&
		Array.isArray(updateData.roomCountDetails)
	) {
		// Clone existing roomCountDetails to avoid mutating the original data
		let updatedRoomCountDetails = hotelDetails.roomCountDetails.map(
			(existingRoom) => ({
				...existingRoom.toObject(), // Convert Mongoose document to plain object
			})
		);

		// Iterate over each newRoom in updateData to merge or add
		updateData.roomCountDetails.forEach((newRoom) => {
			if (fromPage === "AddNew") {
				// Check if the room already exists based on roomType and displayName
				const existingRoomIndex = updatedRoomCountDetails.findIndex(
					(room) =>
						room.roomType === newRoom.roomType &&
						room.displayName === newRoom.displayName
				);

				if (existingRoomIndex !== -1) {
					// Merge existing room with new data
					updatedRoomCountDetails[existingRoomIndex] = {
						...updatedRoomCountDetails[existingRoomIndex],
						...newRoom,
					};
				} else {
					// Ensure activeRoom is set to true by default for new rooms
					if (newRoom.activeRoom === undefined) {
						newRoom.activeRoom = true;
					}
					updatedRoomCountDetails.push(newRoom);
					console.log(`Added new room: ${JSON.stringify(newRoom)}`);
				}
			} else {
				// For non-AddNew pages, match based on _id
				if (newRoom._id) {
					const existingRoomIndex = updatedRoomCountDetails.findIndex(
						(room) => room._id.toString() === newRoom._id.toString()
					);

					if (existingRoomIndex !== -1) {
						// Merge existing room with new data
						updatedRoomCountDetails[existingRoomIndex] = {
							...updatedRoomCountDetails[existingRoomIndex],
							...newRoom,
						};
					} else {
						// If room doesn't exist, add it
						updatedRoomCountDetails.push(newRoom);
						console.log(`Added new room with _id: ${newRoom._id}`);
					}
				} else {
					console.warn(
						`Skipping room without _id on non-AddNew page: ${JSON.stringify(
							newRoom
						)}`
					);
				}
			}
		});

		// Ensure all room colors are unique within the same roomType
		ensureUniqueRoomColors(updatedRoomCountDetails);

		// Assign the updated roomCountDetails
		updatedFields.roomCountDetails = updatedRoomCountDetails;
	}

	// Merge paymentSettings if provided
	if (updateData.paymentSettings && Array.isArray(updateData.paymentSettings)) {
		updatedFields.paymentSettings = updateData.paymentSettings;
		console.log(
			`Merged paymentSettings: ${JSON.stringify(
				updateData.paymentSettings,
				null,
				2
			)}`
		);
	}

	// Process other fields (excluding roomCountDetails and paymentSettings)
	Object.keys(updateData).forEach((key) => {
		if (key !== "roomCountDetails" && key !== "paymentSettings") {
			updatedFields[key] = updateData[key];
			console.log(`Updated field ${key}: ${updateData[key]}`);
		}
	});

	return updatedFields;
};

/**
 * Updates the hotel details based on the provided data.
 * Handles merging of nested roomCountDetails and their pricingRate arrays.
 */
exports.updateHotelDetails = async (req, res) => {
	const hotelDetailsId = req.params.hotelId;
	const updateData = req.body;
	const fromPage = req.body.fromPage; // Extract fromPage for conditional logic

	console.log("Received updateData:", JSON.stringify(updateData, null, 2));
	console.log(
		"PaymentSettings:",
		JSON.stringify(req.body.paymentSettings, null, 2)
	);

	try {
		// Fetch the hotel details document
		const hotelDetails = await HotelDetails.findById(hotelDetailsId).exec();

		if (!hotelDetails) {
			console.warn("Hotel details not found for ID:", hotelDetailsId);
			return res.status(404).send({ error: "Hotel details not found" });
		}

		// Construct the fields to update
		const updatedFields = constructUpdatedFields(
			hotelDetails,
			updateData,
			fromPage
		);
		updatedFields.fromPage = fromPage; // Ensure fromPage is included

		console.log(
			"Constructed updatedFields:",
			JSON.stringify(updatedFields, null, 2)
		);

		// Perform the update atomically using findByIdAndUpdate
		const updatedHotelDetails = await HotelDetails.findByIdAndUpdate(
			hotelDetailsId,
			{ $set: updatedFields },
			{ new: true, runValidators: true }
		).exec();

		if (!updatedHotelDetails) {
			console.error("Failed to update hotel details for ID:", hotelDetailsId);
			return res.status(500).send({ error: "Failed to update hotel details" });
		}

		console.log("Hotel details updated successfully:", updatedHotelDetails);
		return res.json(updatedHotelDetails);
	} catch (err) {
		console.error("Error updating hotel details:", err);
		return res.status(500).send({ error: "Internal server error" });
	}
};

exports.list = (req, res) => {
	const userId = mongoose.Types.ObjectId(req.params.accountId);

	HotelDetails.find({ belongsTo: userId })
		.populate("belongsTo", "name email") // Select only necessary fields
		.exec((err, data) => {
			if (err) {
				console.log(err, "err");
				return res.status(400).json({ error: err });
			}
			res.json(data);
		});
};

exports.remove = (req, res) => {
	const hotelDetails = req.hotelDetails;

	hotelDetails.remove((err) => {
		if (err) {
			return res.status(400).json({ error: "Error while removing" });
		}
		res.json({ message: "Hotel details deleted" });
	});
};

exports.getHotelDetails = (req, res) => {
	return res.json(req.hotelDetails);
};

exports.listForAdmin = async (req, res) => {
	try {
		/* ─── 1. Parse & sanitise query params ─── */
		let { page = 1, limit = 15, status } = req.query;
		page = Math.max(parseInt(page, 10) || 1, 1);
		limit = Math.min(Math.max(parseInt(limit, 10) || 15, 1), 50);

		/* ─── 2. Build Mongo filter ─── */
		const filter = {};
		if (status === "active") filter.activateHotel = true;
		if (status === "inactive") filter.activateHotel = false;

		/* ─── 3. Run query & count in parallel ─── */
		const skip = (page - 1) * limit;

		const [hotels, total] = await Promise.all([
			HotelDetails.find(filter)
				.sort({ createdAt: -1 }) // newest first
				.skip(skip)
				.limit(limit)
				.populate("belongsTo", "_id name email") // only needed fields
				.lean(), // plain JS objects
			HotelDetails.countDocuments(filter),
		]);

		/* ─── 4. Respond ─── */
		res.json({
			total, // total matching docs
			page,
			pages: Math.ceil(total / limit),
			results: hotels.length,
			hotels,
		});
	} catch (err) {
		console.error(err);
		res.status(400).json({ error: "Failed to fetch hotel list" });
	}
};

exports.listOfHotelUser = async (req, res) => {
	try {
		const { accountId } = req.params;

		// Find all hotel details where the belongsTo field matches the accountId
		const hotels = await HotelDetails.find({ belongsTo: accountId });

		if (!hotels.length) {
			return res.status(404).json({
				message: "No hotels found for this user.",
			});
		}

		res.status(200).json(hotels);
	} catch (error) {
		console.error("Error fetching hotels:", error);
		res.status(500).json({
			error: "An error occurred while fetching the hotels.",
		});
	}
};
