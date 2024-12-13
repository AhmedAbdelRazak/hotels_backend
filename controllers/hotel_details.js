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

const generateUniqueDarkColor = (existingColors) => {
	let color;
	do {
		// Generate a random dark color
		color = `#${Math.floor(Math.random() * 16777215)
			.toString(16)
			.padStart(6, "0")}`;
	} while (
		existingColors.includes(color) ||
		!/^#([0-9A-F]{2}){3}$/i.test(color)
	);
	return color;
};

exports.updateHotelDetails = async (req, res) => {
	const hotelDetailsId = req.params.hotelId;
	const updateData = req.body;

	console.log(updateData, "updateData");

	// Helper function to ensure unique room colors within the same room type
	const ensureUniqueRoomColors = (roomCountDetails) => {
		const colorMap = {};

		roomCountDetails.forEach((room) => {
			if (!colorMap[room.roomType]) {
				colorMap[room.roomType] = new Set();
			}

			// If the color already exists for the room type, generate a unique color
			if (colorMap[room.roomType].has(room.roomColor)) {
				room.roomColor = generateUniqueDarkColor([...colorMap[room.roomType]]);
			}

			colorMap[room.roomType].add(room.roomColor);
		});
	};

	// Helper function to update distances to El Haram using Google Maps API
	const updateDistances = async (hotel) => {
		try {
			const elHaramCoordinates = [39.8262, 21.4225]; // Coordinates for Al-Masjid al-Haram
			const [hotelLongitude, hotelLatitude] = hotel.location.coordinates;

			const apiKey = process.env.GOOGLE_MAPS_API_KEY;

			// Construct URLs for walking and driving distance calculations
			const walkingUrl = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${hotelLatitude},${hotelLongitude}&destinations=${elHaramCoordinates[1]},${elHaramCoordinates[0]}&mode=walking&key=${apiKey}`;
			const drivingUrl = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${hotelLatitude},${hotelLongitude}&destinations=${elHaramCoordinates[1]},${elHaramCoordinates[0]}&mode=driving&key=${apiKey}`;

			// Fetch distances in parallel
			const [walkingResponse, drivingResponse] = await Promise.all([
				axios.get(walkingUrl),
				axios.get(drivingUrl),
			]);

			// Extract distance information
			const walkingElement = walkingResponse.data.rows?.[0]?.elements?.[0];
			const drivingElement = drivingResponse.data.rows?.[0]?.elements?.[0];

			hotel.distances = {
				walkingToElHaram:
					walkingElement && walkingElement.status === "OK"
						? walkingElement.duration.text
						: "N/A",
				drivingToElHaram:
					drivingElement && drivingElement.status === "OK"
						? drivingElement.duration.text
						: "N/A",
			};
		} catch (error) {
			console.error("Error updating distances:", error);
		}
	};

	// Find the hotel details by ID
	HotelDetails.findById(hotelDetailsId, async (err, hotelDetails) => {
		if (err) {
			console.error(err);
			return res.status(500).send({ error: "Internal server error" });
		}
		if (!hotelDetails) {
			return res.status(404).send({ error: "Hotel details not found" });
		}

		// Update roomCountDetails if provided
		if (
			updateData.roomCountDetails &&
			Array.isArray(updateData.roomCountDetails)
		) {
			const updatedRoomCountDetails = hotelDetails.roomCountDetails.map(
				(existingRoom) => {
					const matchingNewRoom = updateData.roomCountDetails.find(
						(newRoom) =>
							newRoom._id &&
							newRoom._id.toString() === existingRoom._id.toString()
					);

					// Merge existing room details with new data
					if (matchingNewRoom && Object.keys(matchingNewRoom).length > 0) {
						return { ...existingRoom, ...matchingNewRoom };
					}
					return existingRoom;
				}
			);

			// Add new rooms not already in the list
			updateData.roomCountDetails.forEach((newRoom) => {
				if (
					newRoom._id &&
					!updatedRoomCountDetails.some(
						(room) => room._id.toString() === newRoom._id.toString()
					)
				) {
					updatedRoomCountDetails.push(newRoom);
				}
			});

			// Ensure all room colors are unique within the same room type
			ensureUniqueRoomColors(updatedRoomCountDetails);
			hotelDetails.roomCountDetails = updatedRoomCountDetails;
			hotelDetails.markModified("roomCountDetails");
		}

		let locationUpdated = false; // Track if location coordinates have changed

		// Update other fields, checking for location changes
		Object.keys(updateData).forEach((key) => {
			if (key === "location" && updateData[key]) {
				const newCoordinates = updateData[key].coordinates;
				const oldCoordinates = hotelDetails.location.coordinates;

				// Check if coordinates have changed
				if (
					!oldCoordinates ||
					newCoordinates[0] !== oldCoordinates[0] ||
					newCoordinates[1] !== oldCoordinates[1]
				) {
					locationUpdated = true;
				}
			}

			// Sanity check: Replace all "-" with spaces in hotelName
			if (key === "hotelName" && typeof updateData[key] === "string") {
				hotelDetails[key] = updateData[key].replace(/-/g, " ");
			} else if (key !== "roomCountDetails") {
				hotelDetails[key] = updateData[key];
			}
		});

		// Trigger distance update only if location coordinates have changed
		if (locationUpdated) {
			await updateDistances(hotelDetails);
		}

		// Save the updated hotel details
		hotelDetails.save((err, updatedHotelDetails) => {
			if (err) {
				console.error(err);
				return res.status(500).send({ error: "Internal server error" });
			}
			res.json(updatedHotelDetails);
		});
	});
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

exports.listForAdmin = (req, res) => {
	HotelDetails.find()
		.populate("belongsTo", "_id name email") // Select only necessary fields
		.exec((err, data) => {
			if (err) {
				console.log(err, "err");
				return res.status(400).json({ error: err });
			}
			res.json(data);
		});
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
