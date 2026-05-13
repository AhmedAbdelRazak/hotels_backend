const HouseKeeping = require("../models/housekeeping");
const mongoose = require("mongoose");
const Rooms = require("../models/rooms");
const User = require("../models/user");
const Reservations = require("../models/reservations");
const HotelDetails = require("../models/hotel_details");
const HousekeepingSupply = require("../models/housekeeping_supply");
const HousekeepingSupplyRequest = require("../models/housekeeping_supply_request");
const {
	buildPendingConfirmationExclusionFilter,
} = require("../services/reservationStatus");

const isFinishedStatus = (status = "") =>
	["finished", "done", "completed", "clean"].includes(
		String(status || "").toLowerCase()
	);

const isCleaningStatus = (status = "") =>
	String(status || "").toLowerCase() === "cleaning";

const userRoles = (user = {}) => [
	...new Set(
		[user.role, ...(Array.isArray(user.roles) ? user.roles : [])]
			.map(Number)
			.filter(Boolean)
	),
];

const userRoleDescriptions = (user = {}) => [
	String(user.roleDescription || "").toLowerCase(),
	...(Array.isArray(user.roleDescriptions)
		? user.roleDescriptions.map((item) => String(item || "").toLowerCase())
		: []),
];

const configuredSuperAdminIds = () =>
	[process.env.SUPER_ADMIN_ID, process.env.REACT_APP_SUPER_ADMIN_ID]
		.filter(Boolean)
		.map((id) => String(id).trim());

const isConfiguredSuperAdmin = (userOrId) => {
	const userId =
		typeof userOrId === "object" ? userOrId?._id || userOrId?.id : userOrId;
	return configuredSuperAdminIds().includes(String(userId || "").trim());
};

const canUserMarkRoomClean = (user = {}) => {
	const roles = userRoles(user);
	const descriptions = userRoleDescriptions(user);
	return (
		isConfiguredSuperAdmin(user) ||
		roles.some((role) => [1000, 2000, 4000, 5000].includes(role)) ||
		descriptions.some((role) =>
			["hotelmanager", "housekeepingmanager", "housekeeping"].includes(role)
		)
	);
};

const normalizeObjectId = (value) => {
	if (!value) return null;
	if (typeof value === "object" && value._id) return value._id;
	return value;
};

const normalizeRoomIds = (rooms = []) =>
	(Array.isArray(rooms) ? rooms : [])
		.map(normalizeObjectId)
		.filter((roomId) => mongoose.Types.ObjectId.isValid(String(roomId)))
		.map((roomId) => String(roomId));

const sameId = (a, b) => String(normalizeObjectId(a)) === String(normalizeObjectId(b));

const includesId = (list = [], targetId) =>
	Array.isArray(list) &&
	list.some((item) => sameId(item, targetId));

const getRequestUser = async (req) => {
	const userId = req.auth?._id || req.body?.actorId || req.query?.actorId;
	if (!userId || !mongoose.Types.ObjectId.isValid(String(userId))) return null;
	return User.findById(userId)
		.select(
			"_id role roles roleDescription roleDescriptions activeUser hotelIdWork belongsToId hotelsToSupport hotelIdsOwner"
		)
		.lean();
};

const canAccessHousekeepingHotel = async (user, hotelId) => {
	if (!user || user.activeUser === false) return false;
	if (!mongoose.Types.ObjectId.isValid(String(hotelId))) return false;
	if (Number(user.role) === 1000 || isConfiguredSuperAdmin(user)) return true;

	const hotel = await HotelDetails.findById(hotelId)
		.select("_id belongsTo")
		.lean();
	if (!hotel) return false;

	const hotelOwnerId = normalizeObjectId(hotel.belongsTo);
	const hotelObjectId = normalizeObjectId(hotel._id);
	const userId = normalizeObjectId(user._id);

	if (Number(user.role) === 2000 && sameId(userId, hotelOwnerId)) return true;
	if (includesId(user.hotelIdsOwner, hotelObjectId)) return true;
	if (includesId(user.hotelsToSupport, hotelObjectId)) return true;

	return (
		sameId(user.hotelIdWork, hotelObjectId) &&
		(!user.belongsToId || sameId(user.belongsToId, hotelOwnerId))
	);
};

const canManageHousekeepingHotel = async (user, hotelId) => {
	const roles = userRoles(user);
	const descriptions = userRoleDescriptions(user);
	const hasManagerRole =
		isConfiguredSuperAdmin(user) ||
		roles.some((role) => [1000, 2000, 4000].includes(role)) ||
		descriptions.some((role) =>
			["hotelmanager", "housekeepingmanager"].includes(role)
		);
	return hasManagerRole && (await canAccessHousekeepingHotel(user, hotelId));
};

const canApproveHousekeepingSupplies = async (user, hotelId) => {
	const roles = userRoles(user);
	const descriptions = userRoleDescriptions(user);
	const hasFinanceRole =
		isConfiguredSuperAdmin(user) ||
		roles.some((role) => [1000, 2000, 6000].includes(role)) ||
		descriptions.some((role) => ["finance", "accounting", "accountant"].includes(role));
	return hasFinanceRole && (await canAccessHousekeepingHotel(user, hotelId));
};

const isAssignedHousekeepingUser = (user, task) =>
	Boolean(user && task && sameId(user._id, task.assignedTo));

const emitHousekeepingUpdate = (req, hotelId, payload = {}) => {
	const io = req.app && req.app.get("io");
	const normalizedHotelId = String(normalizeObjectId(hotelId) || "");
	if (!io || !normalizedHotelId) return;
	io.to(`housekeeping:${normalizedHotelId}`).emit("housekeepingUpdated", {
		hotelId: normalizedHotelId,
		...payload,
	});
};

const getDayRange = (dateValue) => {
	if (!dateValue) return null;
	let start = new Date(`${dateValue}T00:00:00.000Z`);
	const currentYear = new Date().getUTCFullYear();
	const year = start.getUTCFullYear();
	if (
		Number.isNaN(start.getTime()) ||
		year < 2020 ||
		year > currentYear + 2
	) {
		start = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00.000Z");
	}
	const end = new Date(start);
	end.setUTCDate(end.getUTCDate() + 1);
	return { start, end };
};

const getDateRange = ({ date = "", fromDate = "", toDate = "" } = {}) => {
	if (fromDate || toDate) {
		const from = getDayRange(fromDate || toDate);
		const to = getDayRange(toDate || fromDate);
		if (!from || !to) return null;
		let start = from.start;
		let end = to.end;
		if (start > end) {
			start = to.start;
			end = from.end;
		}
		return { start, end };
	}
	return getDayRange(date);
};

const applyStatusFilter = (match, status = "") => {
	const normalized = String(status || "").toLowerCase();
	if (!normalized || normalized === "all") return;
	if (normalized === "active") {
		match.task_status = { $nin: ["finished", "done", "completed", "clean"] };
		return;
	}
	match.task_status = normalized;
};

const normalizeTaskType = (value, hasRooms = false) =>
	String(value || (hasRooms ? "room" : "general")).toLowerCase() === "general"
		? "general"
		: "room";

const normalizeGeneralAreas = (areas = []) =>
	(Array.isArray(areas) ? areas : [])
		.map((area) => String(area || "").trim().toLowerCase())
		.filter(Boolean);

const HOUSEKEEPING_SUPPLY_CATALOG = [
	{ name: "All-purpose cleaner", category: "cleaning chemicals", unit: "gallon", minimumStock: 4, estimatedUnitCost: 35 },
	{ name: "Disinfectant cleaner", category: "cleaning chemicals", unit: "gallon", minimumStock: 4, estimatedUnitCost: 42 },
	{ name: "Bathroom cleaner", category: "cleaning chemicals", unit: "gallon", minimumStock: 3, estimatedUnitCost: 38 },
	{ name: "Glass cleaner", category: "cleaning chemicals", unit: "bottle", minimumStock: 8, estimatedUnitCost: 14 },
	{ name: "Floor cleaner", category: "cleaning chemicals", unit: "gallon", minimumStock: 4, estimatedUnitCost: 33 },
	{ name: "Bleach", category: "cleaning chemicals", unit: "gallon", minimumStock: 3, estimatedUnitCost: 18 },
	{ name: "Laundry detergent", category: "laundry", unit: "box", minimumStock: 3, estimatedUnitCost: 75 },
	{ name: "Fabric softener", category: "laundry", unit: "gallon", minimumStock: 2, estimatedUnitCost: 32 },
	{ name: "Trash bags", category: "consumables", unit: "case", minimumStock: 5, estimatedUnitCost: 55 },
	{ name: "Toilet paper", category: "guest supplies", unit: "case", minimumStock: 8, estimatedUnitCost: 85 },
	{ name: "Paper towels", category: "guest supplies", unit: "case", minimumStock: 5, estimatedUnitCost: 70 },
	{ name: "Hand soap", category: "guest supplies", unit: "case", minimumStock: 4, estimatedUnitCost: 60 },
	{ name: "Guest shampoo", category: "amenities", unit: "case", minimumStock: 3, estimatedUnitCost: 95 },
	{ name: "Guest body wash", category: "amenities", unit: "case", minimumStock: 3, estimatedUnitCost: 95 },
	{ name: "Microfiber cloths", category: "tools", unit: "pack", minimumStock: 6, estimatedUnitCost: 28 },
	{ name: "Mop heads", category: "tools", unit: "piece", minimumStock: 10, estimatedUnitCost: 18 },
	{ name: "Cleaning gloves", category: "ppe", unit: "box", minimumStock: 6, estimatedUnitCost: 22 },
	{ name: "Sponges and scrub pads", category: "tools", unit: "pack", minimumStock: 8, estimatedUnitCost: 16 },
	{ name: "Air freshener", category: "guest supplies", unit: "case", minimumStock: 3, estimatedUnitCost: 48 },
];

const normalizeMoney = (value, fallback = 0) => {
	const number = Number(value);
	return Number.isFinite(number) && number >= 0 ? number : fallback;
};

const normalizeQuantity = (value) => {
	const number = Number(value);
	return Number.isFinite(number) && number > 0 ? number : 0;
};

const durationBetween = (start, end) => {
	const startDate = start ? new Date(start) : null;
	const endDate = end ? new Date(end) : null;
	if (!startDate || !endDate) return 0;
	if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
		return 0;
	}
	return Math.max(0, endDate.getTime() - startDate.getTime());
};

const HOUSED_EXCLUDED_STATUS =
	/cancelled|canceled|no[_\s-]?show|checked[_\s-]?out|checkedout|closed|early[_\s-]?checked[_\s-]?out/i;

const extractReservationRoomIds = (roomIdField) =>
	(Array.isArray(roomIdField) ? roomIdField : [roomIdField])
		.map(normalizeObjectId)
		.filter(Boolean)
		.map((roomId) => String(roomId));

const getCurrentlyHousedRoomIds = async (hotelId) => {
	if (!mongoose.Types.ObjectId.isValid(String(hotelId))) return new Set();
	const start = new Date();
	start.setHours(0, 0, 0, 0);
	const end = new Date();
	end.setHours(23, 59, 59, 999);
	const reservations = await Reservations.find({
		hotelId: mongoose.Types.ObjectId(hotelId),
		checkin_date: { $lte: end },
		checkout_date: { $gte: start },
		reservation_status: { $not: HOUSED_EXCLUDED_STATUS },
		...buildPendingConfirmationExclusionFilter(),
		roomId: { $exists: true, $ne: [] },
	})
		.select("roomId")
		.lean();

	const housedRoomIds = new Set();
	reservations.forEach((reservation) => {
		extractReservationRoomIds(reservation.roomId).forEach((roomId) =>
			housedRoomIds.add(roomId)
		);
	});
	return housedRoomIds;
};

const annotateTaskRoomsWithHousedFlag = (tasks = [], housedRoomIds = new Set()) =>
	tasks.map((task) => ({
		...task,
		rooms: Array.isArray(task.rooms)
			? task.rooms.map((room) => ({
					...room,
					isCurrentlyHoused: housedRoomIds.has(String(normalizeObjectId(room))),
			  }))
			: [],
	}));

const numericValue = (value, fallback = Number.NEGATIVE_INFINITY) => {
	const directNumber = Number(value);
	if (Number.isFinite(directNumber)) return directNumber;
	const match = String(value || "").match(/\d+/);
	return match ? Number(match[0]) : fallback;
};

const roomNumberValue = (room = {}) =>
	numericValue(room.room_number || room.roomNumber || room.roomName);

const roomFloorValue = (room = {}) => {
	const explicitFloor = numericValue(room.floor);
	if (Number.isFinite(explicitFloor)) return explicitFloor;
	const roomNumber = roomNumberValue(room);
	return Number.isFinite(roomNumber) && roomNumber >= 100
		? Math.floor(roomNumber / 100)
		: Number.NEGATIVE_INFINITY;
};

const sortRoomsForHousekeeping = (rooms = []) =>
	(Array.isArray(rooms) ? [...rooms] : []).sort((a, b) => {
		const floorDiff = roomFloorValue(b) - roomFloorValue(a);
		if (floorDiff) return floorDiff;
		const roomDiff = roomNumberValue(b) - roomNumberValue(a);
		if (roomDiff) return roomDiff;
		return String(b.room_number || b.roomNumber || "").localeCompare(
			String(a.room_number || a.roomNumber || "")
		);
	});

const taskStatusPriority = (status = "") => {
	const normalized = String(status || "").toLowerCase();
	if (normalized === "cleaning") return 0;
	if (isFinishedStatus(normalized)) return 2;
	return 1;
};

const sortTasksForHousekeeping = (tasks = []) =>
	(Array.isArray(tasks) ? tasks : [])
		.map((task) => ({
			...task,
			rooms: sortRoomsForHousekeeping(task.rooms),
		}))
		.sort((a, b) => {
			const statusDiff =
				taskStatusPriority(a.task_status) - taskStatusPriority(b.task_status);
			if (statusDiff) return statusDiff;
			const aRoom = a.rooms?.[0] || {};
			const bRoom = b.rooms?.[0] || {};
			const floorDiff = roomFloorValue(bRoom) - roomFloorValue(aRoom);
			if (floorDiff) return floorDiff;
			const roomDiff = roomNumberValue(bRoom) - roomNumberValue(aRoom);
			if (roomDiff) return roomDiff;
			return new Date(b.taskDate || b.createdAt || 0) - new Date(a.taskDate || a.createdAt || 0);
		});

const buildRoomStatus = (rooms = [], existingStatuses = [], fallbackStatus = "unfinished") => {
	const existingByRoom = new Map();
	(Array.isArray(existingStatuses) ? existingStatuses : []).forEach((entry) => {
		const roomId = normalizeObjectId(entry?.room);
		if (roomId) existingByRoom.set(String(roomId), entry);
	});

	return normalizeRoomIds(rooms).map((roomId) => {
		const previous = existingByRoom.get(roomId);
		return {
			room: roomId,
			status: String(previous?.status || fallbackStatus || "unfinished").toLowerCase(),
			startedBy: previous?.startedBy || null,
			startedAt: previous?.startedAt || null,
			cleanedBy: previous?.cleanedBy || null,
			cleanedAt: previous?.cleanedAt || null,
			durationMs: previous?.durationMs || 0,
			comment: previous?.comment || "",
		};
	});
};

const syncRoomCleanFlags = async (roomStatuses = []) => {
	const statuses = Array.isArray(roomStatuses) ? roomStatuses : [];
	const now = new Date();
	await Promise.all(
		statuses
			.filter((entry) => mongoose.Types.ObjectId.isValid(String(normalizeObjectId(entry?.room))))
			.map((entry) =>
				{
					const finished = isFinishedStatus(entry.status);
					return Rooms.findByIdAndUpdate(normalizeObjectId(entry.room), {
						$set: {
							cleanRoom: finished,
							housekeepingLastCleanedAt: finished
								? entry.cleanedAt || now
								: null,
							housekeepingLastDirtyAt: finished ? null : now,
							housekeepingDirtyReason: finished ? "" : "housekeeping_task_open",
						},
					});
				}
			)
	);
};

const populateTask = (query) =>
	query
		.populate("assignedTo")
		.populate("cleanedBy")
		.populate("rooms")
		.populate("hotelId")
		.populate("roomStatus.room")
		.populate("roomStatus.cleanedBy");

const markTaskRoomsByStatus = async (rooms = [], status = "") => {
	const roomIds = (Array.isArray(rooms) ? rooms : [])
		.map(normalizeObjectId)
		.filter((roomId) => mongoose.Types.ObjectId.isValid(roomId));
	if (!roomIds.length) return;

	const finished = isFinishedStatus(status);
	const now = new Date();
	await Rooms.updateMany(
		{ _id: { $in: roomIds.map((roomId) => mongoose.Types.ObjectId(roomId)) } },
		{
			$set: {
				cleanRoom: finished,
				housekeepingLastCleanedAt: finished ? now : null,
				housekeepingLastDirtyAt: finished ? null : now,
				housekeepingDirtyReason: finished ? "" : "housekeeping_task_open",
			},
		}
	);
};

exports.create = async (req, res) => {
	try {
		const hotelId = req.params.hotelId || req.body.hotelId;
		const actor = await getRequestUser(req);
		if (!(await canManageHousekeepingHotel(actor, hotelId))) {
			return res.status(403).json({
				error: "You are not allowed to create housekeeping tasks for this hotel.",
			});
		}

		const status = String(req.body.task_status || "unfinished").toLowerCase();
		const now = new Date();
		const selectedRooms = normalizeRoomIds(req.body.rooms);
		const taskType = normalizeTaskType(
			req.body.taskType || req.body.taskKind,
			selectedRooms.length > 0
		);
		const generalAreas = normalizeGeneralAreas(req.body.generalAreas);
		const customTask = String(req.body.customTask || "").trim();
		const taskComment = String(req.body.task_comment || "").trim();

		if (taskType === "room" && !selectedRooms.length) {
			return res.status(400).json({
				error: "Please choose at least one room for a room cleaning task.",
			});
		}

		if (
			taskType === "general" &&
			!generalAreas.length &&
			!customTask &&
			!taskComment
		) {
			return res.status(400).json({
				error: "Please choose a general cleaning area or add a task comment.",
			});
		}

		if (
			taskType === "general" &&
			generalAreas.includes("other") &&
			!customTask &&
			!taskComment
		) {
			return res.status(400).json({
				error: "Please add a clear comment for custom housekeeping work.",
			});
		}

		const taskGroups =
			taskType === "room"
				? selectedRooms.map((roomId) => ({ rooms: [roomId], areas: [] }))
				: (generalAreas.length ? generalAreas : ["custom"]).map((area) => ({
						rooms: [],
						areas: area === "custom" ? [] : [area],
				  }));
		const tasksToCreate = taskGroups.map(({ rooms, areas }) => ({
			...req.body,
			taskType,
			generalAreas: taskType === "general" ? areas : [],
			customTask:
				taskType === "general" && (!areas.length || areas.includes("other"))
					? customTask || taskComment
					: "",
			confirmation_number:
				req.body.confirmation_number ||
				(taskType === "general" ? "general task" : "manual task"),
			hotelId,
			rooms,
			task_status: status,
			cleaningStartedAt: isCleaningStatus(status) ? now : null,
			completedAt: isFinishedStatus(status) ? now : null,
			cleaningDurationMs: 0,
			roomStatus: buildRoomStatus(rooms, [], status).map((entry) => ({
				...entry,
				startedBy: isCleaningStatus(status)
					? actor?._id || req.body.assignedBy || null
					: null,
				startedAt: isCleaningStatus(status) ? now : null,
				cleanedBy: isFinishedStatus(status)
					? actor?._id || req.body.assignedBy || null
					: null,
				cleanedAt: isFinishedStatus(status) ? now : null,
			})),
			statusHistory: [
				{
					status,
					changedBy: actor?._id || req.body.assignedBy || null,
					comment: req.body.task_comment || "",
				},
			],
		}));
		const data = await HouseKeeping.insertMany(tasksToCreate);
		if (taskType === "room") {
			await markTaskRoomsByStatus(
				data.flatMap((task) => (Array.isArray(task.rooms) ? task.rooms : [])),
				status
			);
		}
		emitHousekeepingUpdate(req, hotelId, {
			action: "created",
			taskIds: data.map((task) => String(task._id)),
		});
		res.json({ data, created: data.length });
	} catch (err) {
		console.log(err, "err");
		return res.status(400).json({
			error: "Cannot Create houseKeeping",
		});
	}
};

exports.updateHouseKeepingTask = async (req, res) => {
	const taskId = req.params.taskId;
	const updateData = { ...req.body };

	try {
		const existingTask = await HouseKeeping.findById(taskId);
		if (!existingTask) {
			return res.status(404).send({ error: "task not found" });
		}

		const authActor = await getRequestUser(req);
		const fallbackActorId =
			updateData.cleanedBy || updateData.actorId || updateData.assignedBy || null;
		const actorId = normalizeObjectId(authActor?._id || fallbackActorId);
		const actor =
			authActor ||
			(actorId && mongoose.Types.ObjectId.isValid(String(actorId))
				? await User.findById(actorId)
						.select(
							"_id role roles roleDescription roleDescriptions activeUser hotelIdWork belongsToId hotelsToSupport hotelIdsOwner"
						)
						.lean()
				: null);
		const actorCanManage = await canManageHousekeepingHotel(
			actor,
			existingTask.hotelId
		);
		const actorCanUseAssignedTask =
			canUserMarkRoomClean(actor) &&
			isAssignedHousekeepingUser(actor, existingTask) &&
			(await canAccessHousekeepingHotel(actor, existingTask.hotelId));
		const roomIdToClean =
			updateData.cleanRoomId ||
			updateData.roomIdToClean ||
			updateData.cleanedRoomId ||
			null;

		if (roomIdToClean) {
			if (!mongoose.Types.ObjectId.isValid(String(roomIdToClean))) {
				return res.status(400).json({ error: "Invalid room selected." });
			}

			if (!actorId || !mongoose.Types.ObjectId.isValid(String(actorId))) {
				return res.status(403).json({ error: "A valid cleaner is required." });
			}
			if (
				!actor ||
				actor.activeUser === false ||
				(!actorCanManage && !actorCanUseAssignedTask)
			) {
				return res.status(403).json({
					error: "This user is not allowed to mark rooms as clean.",
				});
			}

			const assignedRoomIds = normalizeRoomIds(existingTask.rooms);
			if (!assignedRoomIds.includes(String(roomIdToClean))) {
				return res
					.status(400)
					.json({ error: "Room is not assigned to this housekeeping task." });
			}

			const now = new Date();
			const nextRoomStatus = buildRoomStatus(
				existingTask.rooms,
				existingTask.roomStatus,
				existingTask.task_status
			).map((entry) => {
				if (!sameId(entry.room, roomIdToClean)) return entry;
				const startedAt =
					entry.startedAt || existingTask.cleaningStartedAt || now;
				return {
							...entry,
							status: "finished",
							startedBy: entry.startedBy || actorId || null,
							startedAt,
							cleanedBy: actorId || null,
							cleanedAt: now,
							durationMs: durationBetween(startedAt, now),
							comment: updateData.roomCleanComment || updateData.task_comment || "",
					  };
			});
			const allRoomsFinished =
				nextRoomStatus.length > 0 &&
				nextRoomStatus.every((entry) => isFinishedStatus(entry.status));
			const nextStatus = allRoomsFinished ? "finished" : "cleaning";
			const taskStartedAt =
				existingTask.cleaningStartedAt ||
				nextRoomStatus.find((entry) => entry.startedAt)?.startedAt ||
				now;

			existingTask.roomStatus = nextRoomStatus;
			existingTask.task_status = nextStatus;
			existingTask.cleaningStartedAt = taskStartedAt;
			existingTask.cleanedBy = allRoomsFinished
				? actorId || existingTask.cleanedBy || null
				: existingTask.cleanedBy;
			existingTask.cleaningDate = allRoomsFinished ? now : existingTask.cleaningDate;
			existingTask.completedAt = allRoomsFinished ? now : null;
			existingTask.cleaningDurationMs = allRoomsFinished
				? durationBetween(taskStartedAt, now)
				: existingTask.cleaningDurationMs || 0;
			if (updateData.task_comment !== undefined) {
				existingTask.task_comment = updateData.task_comment;
			}
			existingTask.statusHistory.push({
				status: nextStatus,
				changedBy: actorId,
				changedAt: now,
				comment: updateData.roomCleanComment || "Room marked clean",
				room: roomIdToClean,
			});

			await existingTask.save();
			await syncRoomCleanFlags(nextRoomStatus);
			emitHousekeepingUpdate(req, existingTask.hotelId, {
				action: "updated",
				taskId: String(existingTask._id),
			});

			const populatedTask = await populateTask(HouseKeeping.findById(taskId));
			return res.json(populatedTask);
		}

		if (updateData.task_status) {
			updateData.task_status = String(updateData.task_status).toLowerCase();
		}

		const nextStatus = updateData.task_status || existingTask.task_status;
		if (updateData.task_status) {
			const existingHasRooms = normalizeRoomIds(existingTask.rooms).length > 0;
			const cleanerMayStartOwnTask =
				actorCanUseAssignedTask && isCleaningStatus(nextStatus);
			const cleanerMayFinishOwnGeneralTask =
				actorCanUseAssignedTask &&
				!existingHasRooms &&
				isFinishedStatus(nextStatus) &&
				isCleaningStatus(existingTask.task_status);
			if (
				!actorCanManage &&
				!cleanerMayStartOwnTask &&
				!cleanerMayFinishOwnGeneralTask
			) {
				return res.status(403).json({
					error: "You are not allowed to update this housekeeping task.",
				});
			}
		} else if (!actorCanManage) {
			return res.status(403).json({
				error: "You are not allowed to update this housekeeping task.",
			});
		}
		const now = new Date();
		if (isFinishedStatus(nextStatus)) {
			updateData.cleanedBy = updateData.cleanedBy || actorId || existingTask.cleanedBy;
			updateData.cleaningStartedAt = existingTask.cleaningStartedAt || now;
			updateData.cleaningDate = now;
			updateData.completedAt = now;
			updateData.cleaningDurationMs = durationBetween(
				updateData.cleaningStartedAt,
				now
			);
		} else if (isCleaningStatus(nextStatus)) {
			updateData.cleaningStartedAt = existingTask.cleaningStartedAt || now;
			updateData.completedAt = null;
			updateData.cleaningDurationMs = 0;
		} else {
			updateData.cleanedBy = null;
			updateData.cleaningDate = null;
			updateData.cleaningStartedAt = null;
			updateData.completedAt = null;
			updateData.cleaningDurationMs = 0;
		}

		const historyEntry = {
			statusHistory: {
				status: nextStatus,
				changedBy: actorId,
				comment: updateData.task_comment || existingTask.task_comment || "",
				changedAt: new Date(),
			},
		};

		const nextRooms =
			normalizeTaskType(
				updateData.taskType || existingTask.taskType,
				Array.isArray(updateData.rooms) && updateData.rooms.length
			) === "general"
				? []
				: Array.isArray(updateData.rooms) && updateData.rooms.length
				? updateData.rooms
				: existingTask.rooms;
		if (updateData.taskType) {
			updateData.taskType = normalizeTaskType(updateData.taskType, nextRooms.length > 0);
		}
		if (updateData.generalAreas) {
			updateData.generalAreas = normalizeGeneralAreas(updateData.generalAreas);
		}
		const nextTaskType = normalizeTaskType(
			updateData.taskType || existingTask.taskType,
			nextRooms.length > 0
		);
		const nextGeneralAreas =
			updateData.generalAreas !== undefined
				? updateData.generalAreas
				: existingTask.generalAreas || [];
		const nextCustomTask =
			updateData.customTask !== undefined
				? String(updateData.customTask || "").trim()
				: existingTask.customTask || "";
		const nextTaskComment =
			updateData.task_comment !== undefined
				? String(updateData.task_comment || "").trim()
				: existingTask.task_comment || "";
		if (
			nextTaskType === "general" &&
			nextGeneralAreas.includes("other") &&
			!nextCustomTask &&
			!nextTaskComment
		) {
			return res.status(400).json({
				error: "Please add a clear comment for custom housekeeping work.",
			});
		}
		if (nextTaskType === "room") {
			updateData.generalAreas = [];
			updateData.customTask = "";
		}
		updateData.rooms = nextRooms;
		let nextRoomStatus = buildRoomStatus(
			nextRooms,
			existingTask.roomStatus,
			nextStatus
		);
		if (updateData.task_status) {
			nextRoomStatus = nextRoomStatus.map((entry) => {
				if (isFinishedStatus(nextStatus)) {
					const startedAt =
						entry.startedAt || existingTask.cleaningStartedAt || now;
					return {
						...entry,
						status: "finished",
						startedBy: entry.startedBy || actorId || null,
						startedAt,
						cleanedBy: actorId || updateData.cleanedBy || existingTask.cleanedBy,
						cleanedAt: now,
						durationMs: durationBetween(startedAt, now),
					};
				}
				if (nextStatus === "cleaning") {
					return isFinishedStatus(entry.status)
						? entry
						: {
								...entry,
								status: "cleaning",
								startedBy: entry.startedBy || actorId || null,
								startedAt: entry.startedAt || updateData.cleaningStartedAt || now,
						  };
				}
				return {
					...entry,
					status: "unfinished",
					startedBy: null,
					startedAt: null,
					cleanedBy: null,
					cleanedAt: null,
					durationMs: 0,
				};
			});
		}
		updateData.roomStatus = nextRoomStatus;

		const setData = { ...updateData };
		delete setData.actorId;
		delete setData.cleanRoomId;
		delete setData.roomIdToClean;
		delete setData.cleanedRoomId;
		delete setData.roomCleanComment;

		const updateHouseKeeping = await populateTask(HouseKeeping.findByIdAndUpdate(
			taskId,
			{ $set: setData, $push: historyEntry },
			{ new: true }
		));

		if (Array.isArray(updateHouseKeeping.roomStatus)) {
			await syncRoomCleanFlags(updateHouseKeeping.roomStatus);
		} else {
			await markTaskRoomsByStatus(updateHouseKeeping.rooms, nextStatus);
		}
		emitHousekeepingUpdate(req, updateHouseKeeping.hotelId, {
			action: "updated",
			taskId: String(updateHouseKeeping._id),
		});
		res.json(updateHouseKeeping);
	} catch (err) {
		console.error(err);
		return res.status(500).send({ error: "Internal server error" });
	}
};

exports.list = async (req, res) => {
	const hotelId = mongoose.Types.ObjectId(req.params.hotelId);
	const page = parseInt(req.params.page) || 1;
	const records = parseInt(req.params.records) || 10;
	const { assignedTo = "", status = "", date = "", fromDate = "", toDate = "" } = req.query || {};
	const match = { hotelId };
	const dayRange = getDateRange({ date, fromDate, toDate });
	if (assignedTo && mongoose.Types.ObjectId.isValid(assignedTo)) {
		match.assignedTo = mongoose.Types.ObjectId(assignedTo);
	}
	applyStatusFilter(match, status);
	if (dayRange) {
		match.taskDate = { $gte: dayRange.start, $lt: dayRange.end };
	}

	try {
		const actor = await getRequestUser(req);
		if (!(await canManageHousekeepingHotel(actor, hotelId))) {
			return res.status(403).json({
				error: "You are not allowed to view housekeeping tasks for this hotel.",
			});
		}

		const houseKeepingTasks = await populateTask(
			HouseKeeping.find(match).sort({ taskDate: -1, createdAt: -1 })
		).lean();

		const housedRoomIds = await getCurrentlyHousedRoomIds(hotelId);
		const tasksWithHousedFlag = annotateTaskRoomsWithHousedFlag(
			houseKeepingTasks,
			housedRoomIds
		);
		const normalizedTasks = sortTasksForHousekeeping(
			tasksWithHousedFlag.map((task) => ({
				...task,
				cleanedBy: task.cleanedBy || { name: "Not Cleaned" },
				assignedTo: task.assignedTo || { name: "Not Assigned" },
			}))
		);
		const totalCount = normalizedTasks.length;

		res.json({
			data: normalizedTasks.slice((page - 1) * records, page * records),
			total: totalCount,
			currentPage: page,
			totalPages: Math.ceil(totalCount / records),
		});
	} catch (err) {
		console.log(err, "err");
		return res.status(400).json({
			error: "Error retrieving housekeeping list",
		});
	}
};

exports.totalDocumentCount = async (req, res) => {
	const hotelId = mongoose.Types.ObjectId(req.params.hotelId);
	const { assignedTo = "", status = "", date = "", fromDate = "", toDate = "" } = req.query || {};
	const match = { hotelId };
	const dayRange = getDateRange({ date, fromDate, toDate });
	if (assignedTo && mongoose.Types.ObjectId.isValid(assignedTo)) {
		match.assignedTo = mongoose.Types.ObjectId(assignedTo);
	}
	applyStatusFilter(match, status);
	if (dayRange) {
		match.taskDate = { $gte: dayRange.start, $lt: dayRange.end };
	}
	try {
		const actor = await getRequestUser(req);
		if (!(await canManageHousekeepingHotel(actor, hotelId))) {
			return res.status(403).json({
				error: "You are not allowed to view housekeeping tasks for this hotel.",
			});
		}

		const totalCount = await HouseKeeping.countDocuments(match);
		res.json({
			totalDocuments: totalCount,
		});
	} catch (err) {
		console.log(err, "err");
		res.status(400).json({
			error: "Error retrieving total document count",
		});
	}
};

exports.remove = (req, res) => {
	const houseKeeping = req.houseKeeping;
	const hotelId = houseKeeping?.hotelId;

	houseKeeping.remove((err, data) => {
		if (err) {
			return res.status(400).json({
				err: "error while removing",
			});
		}
		emitHousekeepingUpdate(req, hotelId, {
			action: "removed",
			taskId: String(data?._id || houseKeeping?._id || ""),
		});
		res.json({ message: "houseKeeping deleted" });
	});
};

exports.listOfTasksForEmployee = async (req, res) => {
	const userId = req.params.userId;
	const {
		hotelId = "",
		date = "",
		fromDate = "",
		toDate = "",
		status = "",
		includeFinished = "true",
	} = req.query || {};
	const match = {
		assignedTo: userId,
	};
	if (hotelId && mongoose.Types.ObjectId.isValid(hotelId)) {
		match.hotelId = hotelId;
	}
	const dayRange = getDateRange({ date, fromDate, toDate });
	if (dayRange) {
		match.taskDate = { $gte: dayRange.start, $lt: dayRange.end };
	}
	if (String(includeFinished).toLowerCase() !== "true") {
		match.task_status = { $nin: ["finished", "done", "completed", "clean"] };
	}
	applyStatusFilter(match, status);

	try {
		const actor = await getRequestUser(req);
		const isSelf = actor && sameId(actor._id, userId);
		const actorCanManageTargetHotel =
			hotelId && (await canManageHousekeepingHotel(actor, hotelId));
		const actorCanViewOwnHotel =
			isSelf &&
			(!hotelId || (await canAccessHousekeepingHotel(actor, hotelId)));
		if (!actorCanManageTargetHotel && !actorCanViewOwnHotel) {
			return res.status(403).json({
				error: "You are not allowed to view these housekeeping tasks.",
			});
		}

		const tasks = await populateTask(HouseKeeping.find(match))
			.sort({ taskDate: -1, createdAt: -1 })
			.lean();
		const housedRoomIds = await getCurrentlyHousedRoomIds(hotelId);

		res.json(
			sortTasksForHousekeeping(annotateTaskRoomsWithHousedFlag(tasks, housedRoomIds))
		);
	} catch (err) {
		console.error(err);
		res.status(500).json({
			error: "Error retrieving tasks for employee",
		});
	}
};

const populateSupplyRequest = (query) =>
	query
		.populate("requestedBy", "name email phone role roleDescription")
		.populate("financeReviewedBy", "name email phone role roleDescription")
		.populate("receivedBy", "name email phone role roleDescription");

exports.listHousekeepingSupplies = async (req, res) => {
	try {
		const { hotelId } = req.params;
		const actor = await getRequestUser(req);
		if (!(await canAccessHousekeepingHotel(actor, hotelId))) {
			return res.status(403).json({
				error: "You are not allowed to view supplies for this hotel.",
			});
		}
		const includeInactive = String(req.query.includeInactive || "").toLowerCase() === "true";
		const itemMatch = { hotelId };
		if (!includeInactive) itemMatch.isActive = { $ne: false };
		const [items, requests] = await Promise.all([
			HousekeepingSupply.find(itemMatch).sort({ category: 1, name: 1 }).lean(),
			populateSupplyRequest(
				HousekeepingSupplyRequest.find({ hotelId }).sort({
					status: 1,
					createdAt: -1,
				})
			).lean(),
		]);
		res.json({
			items,
			requests,
			recommended: HOUSEKEEPING_SUPPLY_CATALOG,
		});
	} catch (err) {
		console.error(err);
		res.status(500).json({ error: "Error loading housekeeping supplies." });
	}
};

exports.upsertHousekeepingSupplyItem = async (req, res) => {
	try {
		const { hotelId } = req.params;
		const actor = await getRequestUser(req);
		if (!(await canManageHousekeepingHotel(actor, hotelId))) {
			return res.status(403).json({
				error: "You are not allowed to manage supplies for this hotel.",
			});
		}
		const name = String(req.body.name || "").trim();
		if (!name) return res.status(400).json({ error: "Supply name is required." });
		const payload = {
			hotelId,
			name,
			category: String(req.body.category || "cleaning").trim().toLowerCase(),
			unit: String(req.body.unit || "unit").trim(),
			currentStock: normalizeMoney(req.body.currentStock),
			minimumStock: normalizeMoney(req.body.minimumStock),
			estimatedUnitCost: normalizeMoney(req.body.estimatedUnitCost),
			lastPurchasePrice: normalizeMoney(req.body.lastPurchasePrice),
			supplier: String(req.body.supplier || "").trim(),
			notes: String(req.body.notes || "").trim(),
			isActive: req.body.isActive !== false,
			updatedBy: actor?._id,
		};
		const itemId = req.body.itemId || req.params.itemId;
		const query =
			itemId && mongoose.Types.ObjectId.isValid(String(itemId))
				? { _id: itemId, hotelId }
				: { hotelId, name };
		const item = await HousekeepingSupply.findOneAndUpdate(
			query,
			{ $set: payload, $setOnInsert: { createdBy: actor?._id } },
			{ new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
		).lean();
		emitHousekeepingUpdate(req, hotelId, { action: "suppliesUpdated" });
		res.json({ item });
	} catch (err) {
		console.error(err);
		res.status(500).json({ error: "Error saving housekeeping supply item." });
	}
};

exports.createHousekeepingSupplyRequest = async (req, res) => {
	try {
		const { hotelId } = req.params;
		const actor = await getRequestUser(req);
		if (!(await canManageHousekeepingHotel(actor, hotelId))) {
			return res.status(403).json({
				error: "You are not allowed to request supplies for this hotel.",
			});
		}
		const rawItems = Array.isArray(req.body.items) ? req.body.items : [];
		const items = rawItems
			.map((item) => {
				const quantity = normalizeQuantity(item.quantity);
				const estimatedUnitCost = normalizeMoney(item.estimatedUnitCost);
				const name = String(item.name || "").trim();
				if (!name || !quantity) return null;
				return {
					supplyId:
						item.supplyId && mongoose.Types.ObjectId.isValid(String(item.supplyId))
							? item.supplyId
							: undefined,
					name,
					category: String(item.category || "cleaning").trim().toLowerCase(),
					quantity,
					unit: String(item.unit || "unit").trim(),
					estimatedUnitCost,
					estimatedTotal: Number((quantity * estimatedUnitCost).toFixed(2)),
				};
			})
			.filter(Boolean);
		if (!items.length) {
			return res.status(400).json({
				error: "Please add at least one supply item with quantity.",
			});
		}
		const request = await HousekeepingSupplyRequest.create({
			hotelId,
			items,
			totalEstimatedCost: Number(
				items.reduce((sum, item) => sum + item.estimatedTotal, 0).toFixed(2)
			),
			vendor: String(req.body.vendor || "").trim(),
			priority: String(req.body.priority || "normal").toLowerCase() === "urgent" ? "urgent" : "normal",
			requestNotes: String(req.body.requestNotes || "").trim(),
			requestedBy: actor?._id,
		});
		emitHousekeepingUpdate(req, hotelId, { action: "suppliesUpdated" });
		res.json({ request });
	} catch (err) {
		console.error(err);
		res.status(500).json({ error: "Error creating housekeeping supply request." });
	}
};

exports.updateHousekeepingSupplyRequest = async (req, res) => {
	try {
		const { requestId } = req.params;
		if (!mongoose.Types.ObjectId.isValid(String(requestId))) {
			return res.status(400).json({ error: "Invalid supply request id." });
		}
		const request = await HousekeepingSupplyRequest.findById(requestId);
		if (!request) return res.status(404).json({ error: "Supply request not found." });
		const actor = await getRequestUser(req);
		const hotelId = request.hotelId;
		const action = String(req.body.action || req.body.status || "").toLowerCase();
		const canManage = await canManageHousekeepingHotel(actor, hotelId);
		const canFinance = await canApproveHousekeepingSupplies(actor, hotelId);
		if (["approved", "approve", "rejected", "reject"].includes(action)) {
			if (!canFinance) {
				return res.status(403).json({
					error: "Finance approval is required for this supply request.",
				});
			}
			request.status = action.startsWith("reject") ? "rejected" : "approved";
			request.financeReviewedBy = actor?._id;
			request.financeReviewedAt = new Date();
			request.financeNotes = String(req.body.financeNotes || request.financeNotes || "").trim();
		} else if (["purchased", "received", "cancelled"].includes(action)) {
			if (!canManage) {
				return res.status(403).json({
					error: "You are not allowed to update this supply request.",
				});
			}
			if (action === "received" && !["approved", "purchased", "received"].includes(request.status)) {
				return res.status(400).json({
					error: "Finance must approve the request before receiving supplies.",
				});
			}
			request.status = action;
			request.actualCost = normalizeMoney(req.body.actualCost, request.actualCost);
			request.receivingNotes = String(req.body.receivingNotes || request.receivingNotes || "").trim();
			if (action === "received") {
				request.receivedBy = actor?._id;
				request.receivedAt = new Date();
				await Promise.all(
					request.items.map((item) =>
						HousekeepingSupply.findOneAndUpdate(
							{ hotelId, name: item.name },
							{
								$inc: { currentStock: item.quantity },
								$set: {
									category: item.category,
									unit: item.unit,
									lastPurchasePrice: item.estimatedUnitCost,
									estimatedUnitCost: item.estimatedUnitCost,
									updatedBy: actor?._id,
								},
								$setOnInsert: {
									minimumStock: 0,
									createdBy: actor?._id,
								},
							},
							{ upsert: true, new: true, setDefaultsOnInsert: true }
						)
					)
				);
			}
		} else {
			return res.status(400).json({ error: "Unsupported supply request action." });
		}
		await request.save();
		emitHousekeepingUpdate(req, hotelId, { action: "suppliesUpdated" });
		const populated = await populateSupplyRequest(
			HousekeepingSupplyRequest.findById(request._id)
		).lean();
		res.json({ request: populated });
	} catch (err) {
		console.error(err);
		res.status(500).json({ error: "Error updating housekeeping supply request." });
	}
};
