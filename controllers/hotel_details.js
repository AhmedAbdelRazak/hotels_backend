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

const hasRoomIdentity = (room = {}) => {
	const rt = typeof room.roomType === "string" ? room.roomType.trim() : "";
	const dn =
		typeof room.displayName === "string" ? room.displayName.trim() : "";
	return rt.length > 0 && dn.length > 0;
};

const normalizeIdentity = (room = {}) => {
	const out = { ...room };
	if (typeof out.roomType === "string") out.roomType = out.roomType.trim();
	if (typeof out.displayName === "string")
		out.displayName = out.displayName.trim();
	return out;
};

// Keep your existing color uniqueness behavior; only minor safety guards
const ensureUniqueRoomColors = (roomCountDetails = []) => {
	const colorMap = {};
	roomCountDetails.forEach((room) => {
		if (!room || !room.roomType) return;

		if (!colorMap[room.roomType]) {
			colorMap[room.roomType] = new Set();
		}

		const used = colorMap[room.roomType];

		// If duplicate, generate new color (assumes generateUniqueDarkColor exists in your codebase)
		if (room.roomColor && used.has(room.roomColor)) {
			const generator =
				typeof generateUniqueDarkColor === "function"
					? generateUniqueDarkColor
					: (existing = []) => {
							// simple fallback
							const rnd = () =>
								Math.floor(Math.random() * 128)
									.toString(16)
									.padStart(2, "0");
							let candidate = `#${rnd()}${rnd()}${rnd()}`;
							let tries = 0;
							const set = new Set(existing);
							while (set.has(candidate) && tries < 20) {
								candidate = `#${rnd()}${rnd()}${rnd()}`;
								tries += 1;
							}
							return candidate;
					  };
			const existing = Array.from(used);
			room.roomColor = generator(existing);
			console.log(
				`Duplicate color found for roomType ${room.roomType}. Generated new color: ${room.roomColor}`
			);
		}

		if (room.roomColor) used.add(room.roomColor);
	});
};

/**
 * Constructs the fields to be updated in the HotelDetails document.
 * Merges roomCountDetails and paymentSettings while ensuring unique room colors.
 * Critically: prevents creating a new "blank" room (must have roomType + displayName).
 */
const constructUpdatedFields = (hotelDetails, updateData, fromPage) => {
	const updatedFields = {};

	// Process roomCountDetails if provided
	if (
		updateData.roomCountDetails &&
		Array.isArray(updateData.roomCountDetails)
	) {
		// Clone existing rooms safely (Mongoose doc or plain object)
		let updatedRoomCountDetails = (hotelDetails.roomCountDetails || []).map(
			(existingRoom) =>
				typeof existingRoom?.toObject === "function"
					? existingRoom.toObject()
					: { ...existingRoom }
		);

		updateData.roomCountDetails.forEach((incoming) => {
			const newRoomRaw = incoming || {};
			const newRoom = normalizeIdentity(newRoomRaw);
			const identityOK = hasRoomIdentity(newRoom);

			if (fromPage === "AddNew") {
				// DO NOT create a room unless it has roomType + displayName
				if (!identityOK) {
					console.warn(
						`Skipping room without roomType/displayName during AddNew: ${JSON.stringify(
							newRoomRaw
						)}`
					);
					return;
				}

				// Match existing by identity (roomType + displayName)
				const existingIndex = updatedRoomCountDetails.findIndex(
					(room) =>
						(room.roomType || "").toString().trim() === newRoom.roomType &&
						(room.displayName || "").toString().trim() === newRoom.displayName
				);

				if (existingIndex !== -1) {
					// Merge
					updatedRoomCountDetails[existingIndex] = {
						...updatedRoomCountDetails[existingIndex],
						...newRoom,
					};
				} else {
					if (newRoom.activeRoom === undefined) newRoom.activeRoom = true;
					updatedRoomCountDetails.push(newRoom);
					console.log(`Added new room: ${JSON.stringify(newRoom)}`);
				}
			} else {
				// Non-AddNew: match/update by _id only (your existing behavior)
				if (newRoom._id) {
					const existingIndex = updatedRoomCountDetails.findIndex(
						(room) => room._id?.toString?.() === newRoom._id.toString()
					);

					if (existingIndex !== -1) {
						// Merge but protect identity from being blanked by accidental empty values
						const existing = updatedRoomCountDetails[existingIndex];
						const merged = { ...existing, ...newRoom };
						if (!hasRoomIdentity(newRoom)) {
							// keep existing identity if incoming lacks it
							merged.roomType = existing.roomType;
							merged.displayName = existing.displayName;
						}
						updatedRoomCountDetails[existingIndex] = merged;
					} else {
						// Only allow adding a *new* room here if it also has identity
						if (identityOK) {
							if (newRoom.activeRoom === undefined) newRoom.activeRoom = true;
							updatedRoomCountDetails.push(newRoom);
							console.log(`Added new room with _id: ${newRoom._id}`);
						} else {
							console.warn(
								`Skipping room without identity and no match by _id on non-AddNew: ${JSON.stringify(
									newRoomRaw
								)}`
							);
						}
					}
				} else {
					// No _id on non-AddNew → skip (your previous code warned too)
					console.warn(
						`Skipping room without _id on non-AddNew page: ${JSON.stringify(
							newRoomRaw
						)}`
					);
				}
			}
		});

		// Ensure all room colors are unique within the same roomType
		ensureUniqueRoomColors(updatedRoomCountDetails);

		// Assign the updated rooms
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
 * Distance calculation helper (unchanged except minor guards)
 */
const calcDistances = async (coords, hotelState = "") => {
	const [lng, lat] = coords; // hotel stores [lng, lat]
	const elHaram = [39.8262, 21.4225];
	const prophetsMosque = [39.6142, 24.4672];

	const dest = (hotelState || "").toLowerCase().includes("madinah")
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
	const fromPage = req.body.fromPage; // e.g. "AddNew"

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

exports.listForAdminAll = async (req, res) => {
	try {
		/* 1️⃣  Parse & sanitise query params (optional filters) */
		let { status, q = "" } = req.query;

		/* 2️⃣  Base filter (status) */
		const baseMatch = {};
		if (status === "active") baseMatch.activateHotel = true;
		if (status === "inactive") baseMatch.activateHotel = false;

		/* 3️⃣  Search filter (if q present) */
		const search = (typeof q === "string" ? q : "").trim();
		let searchMatch = {};
		if (search) {
			// escape regex special chars then make case‑insensitive regex
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

		/* 4️⃣  Build aggregation pipeline (same join as listForAdmin) */
		const pipeline = [
			{ $match: baseMatch },
			{
				$lookup: {
					from: "users", // collection name
					localField: "belongsTo",
					foreignField: "_id",
					as: "owner",
				},
			},
			{ $unwind: { path: "$owner", preserveNullAndEmptyArrays: true } },
		];

		if (search) pipeline.push({ $match: searchMatch });

		pipeline.push({ $sort: { createdAt: -1 } }); // newest first

		/* 5️⃣  Run the aggregation (no pagination; return all) */
		const docs = await HotelDetails.aggregate(pipeline)
			.allowDiskUse(true) // safer if dataset is large
			.exec();

		/* 6️⃣  Minimal owner projection (id, name, email) */
		const hotels = (docs || []).map((h) => {
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

		/* 7️⃣  Send (no page/pages since it's "all") */
		return res.json({
			total: hotels.length,
			results: hotels.length,
			hotels,
		});
	} catch (err) {
		console.error("listForAdminAll error:", err);
		return res.status(400).json({ error: "Failed to fetch all hotels" });
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
