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

exports.updateHotelDetails = (req, res) => {
	const hotelDetailsId = req.params.hotelId;
	const updateData = req.body;

	console.log(updateData, "updateData");

	const ensureUniqueRoomColors = (roomCountDetails) => {
		const colorMap = {};

		roomCountDetails.forEach((room) => {
			if (!colorMap[room.roomType]) {
				colorMap[room.roomType] = new Set();
			}

			// Check if roomColor already exists in the roomType group
			if (colorMap[room.roomType].has(room.roomColor)) {
				// Generate a new unique color
				room.roomColor = generateUniqueDarkColor([...colorMap[room.roomType]]);
			}

			colorMap[room.roomType].add(room.roomColor);
		});
	};

	if (req.body.fromPage === "AddNew") {
		// Existing AddNew logic remains the same
		HotelDetails.findById(hotelDetailsId, (err, hotelDetails) => {
			if (err) {
				console.error(err);
				return res.status(500).send({ error: "Internal server error" });
			}
			if (!hotelDetails) {
				return res.status(404).send({ error: "Hotel details not found" });
			}

			if (
				updateData.roomCountDetails &&
				Array.isArray(updateData.roomCountDetails)
			) {
				const updatedRoomCountDetails = hotelDetails.roomCountDetails.map(
					(existingRoom) => {
						const matchingNewRoom = updateData.roomCountDetails.find(
							(newRoom) =>
								newRoom.roomType === existingRoom.roomType &&
								newRoom.displayName === existingRoom.displayName
						);

						if (matchingNewRoom && Object.keys(matchingNewRoom).length > 0) {
							return { ...existingRoom, ...matchingNewRoom };
						}
						return existingRoom;
					}
				);

				// Add new rooms that don't exist in the current list
				updateData.roomCountDetails.forEach((newRoom) => {
					if (
						newRoom.roomType &&
						newRoom.displayName &&
						Object.keys(newRoom).length > 0
					) {
						const existingRoom = updatedRoomCountDetails.find(
							(room) =>
								room.roomType === newRoom.roomType &&
								room.displayName === newRoom.displayName
						);
						if (!existingRoom) {
							// Ensure that activeRoom is set to true by default for new rooms
							if (newRoom.activeRoom === undefined) {
								newRoom.activeRoom = true;
							}
							updatedRoomCountDetails.push(newRoom);
						}
					}
				});

				// Ensure all room colors are unique within the same roomType
				ensureUniqueRoomColors(updatedRoomCountDetails);

				hotelDetails.roomCountDetails = updatedRoomCountDetails;
				hotelDetails.markModified("roomCountDetails");
			}

			// Update other fields (excluding roomCountDetails)
			Object.keys(updateData).forEach((key) => {
				if (key !== "roomCountDetails") {
					hotelDetails[key] = updateData[key];
				}
			});

			hotelDetails.save((err, updatedHotelDetails) => {
				if (err) {
					console.error(err);
					return res.status(500).send({ error: "Internal server error" });
				}
				res.json(updatedHotelDetails);
			});
		});
	} else {
		console.log("Req.Body:", req.body);

		// New logic to handle updates considering the _id
		HotelDetails.findById(hotelDetailsId, (err, hotelDetails) => {
			if (err) {
				console.error("Error finding hotel details:", err);
				return res.status(500).send({ error: "Internal server error" });
			}
			if (!hotelDetails) {
				return res.status(404).send({ error: "Hotel details not found" });
			}

			if (
				updateData.roomCountDetails &&
				Array.isArray(updateData.roomCountDetails)
			) {
				const updatedRoomCountDetails = hotelDetails.roomCountDetails.map(
					(existingRoom) => {
						const matchingNewRoom = updateData.roomCountDetails.find(
							(newRoom) =>
								newRoom._id.toString() === existingRoom._id.toString()
						);

						if (matchingNewRoom && Object.keys(matchingNewRoom).length > 0) {
							return { ...existingRoom, ...matchingNewRoom };
						}
						return existingRoom;
					}
				);

				// Add new rooms that don't exist in the current list
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

				// Ensure all room colors are unique within the same roomType
				ensureUniqueRoomColors(updatedRoomCountDetails);

				// Assign the updated room count details
				hotelDetails.roomCountDetails = updatedRoomCountDetails;
				hotelDetails.markModified("roomCountDetails");
			}

			// Update other fields (excluding roomCountDetails)
			Object.keys(updateData).forEach((key) => {
				if (key !== "roomCountDetails") {
					hotelDetails[key] = updateData[key];
				}
			});

			hotelDetails.save((err, updatedHotelDetails) => {
				if (err) {
					console.error("Error saving hotel details:", err);
					return res.status(500).send({ error: "Internal server error" });
				}
				console.log("Hotel details updated successfully:", updatedHotelDetails);
				res.json(updatedHotelDetails);
			});
		});
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
