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
const calcDistances = async (coords, hotelState = "") => {
	const [lng, lat] = coords; // hotel stores [lng, lat]
	const elHaram = [39.8262, 21.4225];
	const prophetsMosque = [39.6142, 24.4672];

	// pick destination
	const dest = hotelState.toLowerCase().includes("madinah")
		? prophetsMosque
		: elHaram;

	const apiKey = process.env.GOOGLE_MAPS_API_KEY;
	if (!apiKey) {
		console.warn("GOOGLE_MAPS_API_KEY missing; skipping live distance call.");
		return { walkingToElHaram: "N/A", drivingToElHaram: "N/A" };
	}

	const makeURL = (mode) =>
		`https://maps.googleapis.com/maps/api/distancematrix/json?origins=${lat},${lng}&destinations=${dest[1]},${dest[0]}&mode=${mode}&key=${apiKey}`;

	try {
		const [walkResp, driveResp] = await Promise.all([
			axios.get(makeURL("walking")),
			axios.get(makeURL("driving")),
		]);

		const walkEl = walkResp.data?.rows?.[0]?.elements?.[0];
		const driveEl = driveResp.data?.rows?.[0]?.elements?.[0];

		return {
			walkingToElHaram:
				walkEl && walkEl.status === "OK" ? walkEl.duration.text : "N/A",
			drivingToElHaram:
				driveEl && driveEl.status === "OK" ? driveEl.duration.text : "N/A",
		};
	} catch (err) {
		console.error("Distance API error:", err.message || err);
		return { walkingToElHaram: "N/A", drivingToElHaram: "N/A" };
	}
};

/* ────────────────── UPDATE HANDLER ────────────────── */

exports.updateHotelDetails = async (req, res) => {
	const hotelDetailsId = req.params.hotelId;
	const updateData = req.body;
	const fromPage = req.body.fromPage; // e.g. “AddNew”

	try {
		/* 1. Fetch existing doc */
		const hotelDetails = await HotelDetails.findById(hotelDetailsId).exec();
		if (!hotelDetails)
			return res.status(404).json({ error: "Hotel details not found" });

		/* 2. Merge incoming data with helper */
		const updatedFields = constructUpdatedFields(
			hotelDetails,
			updateData,
			fromPage
		);
		updatedFields.fromPage = fromPage;

		/* 3. Detect coordinate change */
		const newCoords = updateData?.location?.coordinates;
		const oldCoords = hotelDetails.location?.coordinates;
		const coordsChanged =
			Array.isArray(newCoords) &&
			newCoords.length === 2 &&
			(!oldCoords ||
				oldCoords[0] !== newCoords[0] ||
				oldCoords[1] !== newCoords[1]);

		if (coordsChanged) {
			/* 3a. Compute fresh distances */
			const distances = await calcDistances(
				newCoords,
				updateData.hotelState ||
					updatedFields.hotelState ||
					hotelDetails.hotelState
			);

			/* 3b. Attach to update payload */
			updatedFields.distances = distances;
			console.log(
				`Distances recalculated for hotel ${hotelDetailsId}:`,
				distances
			);
		}

		/* 4. Persist */
		const newDoc = await HotelDetails.findByIdAndUpdate(
			hotelDetailsId,
			{ $set: updatedFields },
			{ new: true, runValidators: true }
		).exec();

		if (!newDoc)
			return res.status(500).json({ error: "Failed to update hotel details" });

		return res.json(newDoc);
	} catch (err) {
		console.error("updateHotelDetails error:", err);
		return res.status(500).json({ error: "Internal server error" });
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
		/* 1️⃣  Parse & sanitise query params */
		let { page = 1, limit = 15, status, q = "" } = req.query;

		page = Math.max(parseInt(page, 10) || 1, 1);
		limit = Math.min(Math.max(parseInt(limit, 10) || 15, 1), 50);
		const skip = (page - 1) * limit;

		/* 2️⃣  Base filter (status) */
		const baseMatch = {};
		if (status === "active") baseMatch.activateHotel = true;
		if (status === "inactive") baseMatch.activateHotel = false;

		/* 3️⃣  Search filter (if q present) */
		const search = q.trim();
		let searchMatch = {};
		if (search) {
			/* escape regex special chars then make case‑insensitive regex */
			const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const regex = new RegExp(escaped, "i");

			searchMatch = {
				$or: [
					{ hotelName: regex },
					{ hotelCountry: regex },
					{ hotelCity: regex },
					{ hotelAddress: regex },
					{ phone: regex },
					{ "owner.name": regex },
					{ "owner.email": regex },
				],
			};
		}

		/* 4️⃣  Build aggregation pipeline */
		const pipeline = [
			{ $match: baseMatch },
			/* join User collection to access owner name/email -------------------- */
			{
				$lookup: {
					from: "users", // <== collection name
					localField: "belongsTo",
					foreignField: "_id",
					as: "owner",
				},
			},
			{ $unwind: { path: "$owner", preserveNullAndEmptyArrays: true } },
		];

		if (search) pipeline.push({ $match: searchMatch });

		pipeline.push(
			{ $sort: { createdAt: -1 } }, // newest first
			{
				/* facet = run two pipelines in parallel: paginated data + total count */
				$facet: {
					data: [{ $skip: skip }, { $limit: limit }],
					totalCount: [{ $count: "count" }],
				},
			}
		);

		/* 5️⃣  Run the aggregation */
		const result = await HotelDetails.aggregate(pipeline).exec();
		const hotels = result[0]?.data || [];
		const total =
			result[0]?.totalCount?.length > 0 ? result[0].totalCount[0].count : 0;

		/* 6️⃣  Minimal owner projection (id, name, email) */
		const cleaned = hotels.map((h) => {
			if (h.owner) {
				h.belongsTo = {
					_id: h.owner._id,
					name: h.owner.name,
					email: h.owner.email,
				};
			}
			delete h.owner;
			return h;
		});

		/* 7️⃣  Send */
		return res.json({
			total,
			page,
			pages: Math.ceil(total / limit),
			results: cleaned.length,
			hotels: cleaned,
		});
	} catch (err) {
		console.error("listForAdmin error:", err);
		return res.status(400).json({ error: "Failed to fetch hotel list" });
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
