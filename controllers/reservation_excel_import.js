const fs = require("fs");
const path = require("path");
const xlsx = require("xlsx");
const moment = require("moment");
const mongoose = require("mongoose");
const OpenAI = require("openai");
const Reservations = require("../models/reservations");
const HotelDetails = require("../models/hotel_details");
const Rooms = require("../models/rooms");
const User = require("../models/user");

const ObjectId = mongoose.Types.ObjectId;

const IMPORT_REQUIRED_ROLES = [1000, 2000, 6000, 8000];
const IMPORT_REQUIRED_DESCRIPTIONS = [
	"hotelmanager",
	"finance",
	"reservationemployee",
];
const CLOSED_STATUS_REGEX = /cancelled|canceled|no[_\s-]?show|checked[_\s-]?out|checkedout|early[_\s-]?checked[_\s-]?out/i;

const FIELD_SYNONYMS = {
	guestName: ["guest name", "guest", "name", "customer", "customer name", "visitor", "visitor name"],
	guestPhone: ["guest phone", "phone", "mobile", "telephone", "contact", "contact number"],
	guestCountry: ["guest country", "country", "nationality", "guest nationality"],
	checkinDate: ["check-in date", "checkin date", "check in date", "arrival", "arrival date", "from"],
	checkoutDate: ["check-out date", "checkout date", "check out date", "departure", "departure date", "to"],
	roomType: ["roomtype", "room type", "type", "room category", "category"],
	displayName: ["display name", "room display name", "room name", "room", "room description"],
	totalAmount: ["total amount", "total", "amount", "price", "reservation total", "gross amount"],
	agentName: ["agent name", "agent", "agency", "company", "source", "booking source"],
	commission: ["commission", "commission amount", "agent commission"],
	comment: ["comment", "comments", "notes", "note", "remarks"],
	confirmationNumber: ["confirmation", "confirmation number", "booking number", "reservation number"],
	payment: ["payment", "payment method", "payment status"],
	totalGuests: ["guests", "guest count", "total guests", "visitors"],
};

const normalizeText = (value = "") =>
	String(value || "")
		.toLowerCase()
		.trim()
		.replace(/[_-]+/g, " ")
		.replace(/[^\p{L}\p{N}\s]+/gu, " ")
		.replace(/\s+/g, " ");

const titleCase = (value = "") =>
	String(value || "")
		.trim()
		.toLowerCase()
		.replace(/\b\w/g, (char) => char.toUpperCase());

const moneyNumber = (value) => {
	if (value === null || value === undefined || value === "") return 0;
	if (typeof value === "number") return Number.isFinite(value) ? value : 0;
	const parsed = Number(String(value).replace(/[,\s]/g, "").replace(/[^\d.-]/g, ""));
	return Number.isFinite(parsed) ? parsed : 0;
};

const parseDateValue = (value) => {
	if (!value) return "";
	if (value instanceof Date && !Number.isNaN(value.getTime())) {
		return moment(value).format("YYYY-MM-DD");
	}
	if (typeof value === "number") {
		const parsedExcelDate = xlsx.SSF.parse_date_code(value);
		if (parsedExcelDate) {
			return moment({
				year: parsedExcelDate.y,
				month: parsedExcelDate.m - 1,
				day: parsedExcelDate.d,
			}).format("YYYY-MM-DD");
		}
	}
	const cleaned = String(value || "").trim();
	const parsed = moment(
		cleaned,
		[
			"YYYY-MM-DD",
			"DD/MM/YYYY",
			"MM/DD/YYYY",
			"DD-MM-YYYY",
			"MM-DD-YYYY",
			"MMM D YYYY",
			"D MMM YYYY",
		],
		true
	);
	if (parsed.isValid()) return parsed.format("YYYY-MM-DD");
	const loose = moment(cleaned);
	return loose.isValid() ? loose.format("YYYY-MM-DD") : "";
};

const fieldFromRow = (row, mapping, field) => {
	const mappedHeader = mapping?.[field];
	if (mappedHeader && Object.prototype.hasOwnProperty.call(row, mappedHeader)) {
		return row[mappedHeader];
	}
	const normalizedHeaders = Object.keys(row || {}).reduce((acc, header) => {
		acc[normalizeText(header)] = header;
		return acc;
	}, {});
	const header = (FIELD_SYNONYMS[field] || []).find(
		(candidate) => normalizedHeaders[normalizeText(candidate)]
	);
	return header ? row[normalizedHeaders[normalizeText(header)]] : "";
};

const buildFallbackMapping = (headers = []) => {
	const normalized = headers.map((header) => ({
		raw: header,
		normalized: normalizeText(header),
	}));
	return Object.entries(FIELD_SYNONYMS).reduce((acc, [field, synonyms]) => {
		const match = normalized.find((header) =>
			synonyms.some((candidate) => header.normalized.includes(normalizeText(candidate)))
		);
		if (match) acc[field] = match.raw;
		return acc;
	}, {});
};

const readWorkbookRows = (filePath) => {
	const workbook = xlsx.readFile(filePath, {
		cellDates: true,
		raw: false,
	});
	const sheetName = workbook.SheetNames[0];
	if (!sheetName) return [];
	const sheet = workbook.Sheets[sheetName];
	return xlsx.utils.sheet_to_json(sheet, {
		defval: "",
		raw: false,
		dateNF: "yyyy-mm-dd",
	});
};

const getOpenAiMapping = async ({ headers, sampleRows }) => {
	const apiKey = process.env.CHATGPT_API_TOKEN || process.env.OPENAI_API_KEY;
	if (!apiKey) return {};
	try {
		const client = new OpenAI({ apiKey });
		const model =
			process.env.OPENAI_REASONING_MODEL ||
			process.env.OPENAI_MODEL_NLU ||
			"gpt-4o-mini";
		const response = await client.chat.completions.create({
			model,
			response_format: { type: "json_object" },
			messages: [
				{
					role: "system",
					content:
						"Return strict JSON only. Infer which Excel headers map to the PMS reservation import fields.",
				},
				{
					role: "user",
					content: JSON.stringify({
						targetFields: Object.keys(FIELD_SYNONYMS),
						headers,
						sampleRows: sampleRows.slice(0, 8),
						expectedResponse:
							'{ "mapping": { "guestName": "Header Name" }, "notes": [] }',
					}),
				},
			],
		});
		const content = response.choices?.[0]?.message?.content || "{}";
		const parsed = JSON.parse(content);
		return parsed?.mapping && typeof parsed.mapping === "object"
			? parsed.mapping
			: {};
	} catch (error) {
		console.error("[reservation-excel-import] OpenAI mapping failed:", error.message);
		return {};
	}
};

const normalizedRoleNumbers = (user = {}) => [
	Number(user.role),
	...(Array.isArray(user.roles) ? user.roles.map(Number) : []),
];

const normalizedRoleDescriptions = (user = {}) => [
	String(user.roleDescription || "").toLowerCase(),
	...(Array.isArray(user.roleDescriptions)
		? user.roleDescriptions.map((role) => String(role || "").toLowerCase())
		: []),
];

const isConfiguredSuperAdmin = (user) => {
	const id = String(user?._id || user || "");
	return [process.env.SUPER_ADMIN_ID, process.env.REACT_APP_SUPER_ADMIN_ID]
		.filter(Boolean)
		.map((value) => String(value).trim())
		.includes(id);
};

const canUseImportWorkflow = async (actor, hotelId) => {
	if (!actor || !ObjectId.isValid(hotelId)) return false;
	if (isConfiguredSuperAdmin(actor)) return true;
	const roles = normalizedRoleNumbers(actor);
	const descriptions = normalizedRoleDescriptions(actor);
	const hasRole =
		IMPORT_REQUIRED_ROLES.some((role) => roles.includes(role)) ||
		IMPORT_REQUIRED_DESCRIPTIONS.some((role) => descriptions.includes(role));
	if (!hasRole) return false;

	const hotel = await HotelDetails.findById(hotelId).select("_id belongsTo").lean().exec();
	if (!hotel) return false;
	const actorId = String(actor._id);
	const ownerId = String(hotel.belongsTo || "");
	const normalizedHotelId = String(hotel._id);
	if (roles.includes(1000)) return true;
	if (roles.includes(2000) && actorId === ownerId) return true;
	const supportsHotel =
		Array.isArray(actor.hotelsToSupport) &&
		actor.hotelsToSupport.some((id) => String(id) === normalizedHotelId);
	const ownsHotel =
		Array.isArray(actor.hotelIdsOwner) &&
		actor.hotelIdsOwner.some((id) => String(id) === normalizedHotelId);
	return supportsHotel || ownsHotel || String(actor.hotelIdWork || "") === normalizedHotelId;
};

const buildActorSnapshot = (user = {}) => ({
	_id: String(user._id || ""),
	name: user.name || user.email || "",
	email: user.email || "",
	role: user.role || "",
	roleDescription: user.roleDescription || "",
});

const similarityScore = (left = "", right = "") => {
	const a = normalizeText(left);
	const b = normalizeText(right);
	if (!a || !b) return 0;
	if (a === b) return 1;
	if (a.includes(b) || b.includes(a)) return 0.85;
	const aWords = new Set(a.split(" "));
	const bWords = new Set(b.split(" "));
	const intersection = [...aWords].filter((word) => bWords.has(word)).length;
	return intersection / Math.max(aWords.size, bWords.size, 1);
};

const findClosest = (input, items, labelBuilder) => {
	let best = null;
	let bestScore = 0;
	items.forEach((item) => {
		const score = similarityScore(input, labelBuilder(item));
		if (score > bestScore) {
			best = item;
			bestScore = score;
		}
	});
	return { best, score: bestScore };
};

const listImportAgents = async (hotelId) => {
	return User.find({
		activeUser: { $ne: false },
		$and: [
			{
				$or: [
					{ hotelIdWork: String(hotelId) },
					{ hotelsToSupport: ObjectId(hotelId) },
					{ hotelIdsOwner: ObjectId(hotelId) },
				],
			},
			{
				$or: [
					{ role: 7000 },
					{ roles: 7000 },
					{ roleDescription: /order|agent/i },
					{ roleDescriptions: /order|agent/i },
				],
			},
		],
	})
		.select("_id name email companyName role roleDescription roles roleDescriptions hotelsToSupport hotelIdWork")
		.lean()
		.exec();
};

const agentLabel = (agent = {}) =>
	String(agent.companyName || agent.name || agent.email || "").trim();

const roomLabel = (room = {}) =>
	`${room.roomType || room.room_type || ""} ${room.displayName || room.display_name || ""}`.trim();

const listRoomOptions = (hotel = {}) => {
	const fromDetails = Array.isArray(hotel.roomCountDetails)
		? hotel.roomCountDetails
				.filter((room) => room && room.roomType)
				.map((room) => ({
					roomType: room.roomType,
					displayName: room.displayName || "",
					label: `${room.roomType}${room.displayName ? ` - ${room.displayName}` : ""}`,
				}))
		: [];
	const unique = new Map();
	fromDetails.forEach((room) => {
		unique.set(`${normalizeText(room.roomType)}|${normalizeText(room.displayName)}`, room);
	});
	return [...unique.values()];
};

const resolveAgentForRow = (row, agents, answers, questions) => {
	if (!row.agentName) return null;
	const exact = agents.find((agent) => normalizeText(agentLabel(agent)) === normalizeText(row.agentName));
	if (exact) return exact;
	const { best, score } = findClosest(row.agentName, agents, agentLabel);
	if (!best || score < 0.35) {
		row.warnings.push(`Agent "${row.agentName}" was not found in the system.`);
		return null;
	}
	const questionId = `agent:${normalizeText(row.agentName)}`;
	if (answers[questionId] === "yes") return best;
	if (answers[questionId] === "no") {
		row.warnings.push(`Agent "${row.agentName}" was not matched.`);
		return null;
	}
	questions.push({
		id: questionId,
		type: "agent_match",
		rowKey: row.key,
		message: `Agent "${row.agentName}" is not an exact match. Closest account is "${agentLabel(best)}". Should I assign matching rows to this agent?`,
		arMessage: `الوكيل "${row.agentName}" غير مطابق تماماً. أقرب حساب هو "${agentLabel(best)}". هل تريد ربط الصفوف المشابهة بهذا الوكيل؟`,
		yesLabel: "Yes, use this agent",
		noLabel: "No, leave unmatched",
	});
	return null;
};

const resolveRoomForRow = (row, roomOptions, answers, questions) => {
	if (!row.roomType && !row.displayName) return null;
	const exact = roomOptions.find(
		(room) =>
			normalizeText(room.roomType) === normalizeText(row.roomType) &&
			(!row.displayName || normalizeText(room.displayName) === normalizeText(row.displayName))
	);
	if (exact) return exact;
	const { best, score } = findClosest(`${row.roomType} ${row.displayName}`, roomOptions, roomLabel);
	if (!best || score < 0.32) {
		row.errors.push("Room type/display name could not be matched to this hotel.");
		return null;
	}
	const questionId = `room:${row.key}`;
	if (answers[questionId] === "yes") return best;
	if (answers[questionId] === "no") {
		row.errors.push("Room match was rejected.");
		return null;
	}
	questions.push({
		id: questionId,
		type: "room_match",
		rowKey: row.key,
		message: `Room "${row.roomType} ${row.displayName}" is not exact. Closest hotel room is "${best.label}". Use it?`,
		arMessage: `الغرفة "${row.roomType} ${row.displayName}" غير مطابقة. أقرب نوع هو "${best.label}". هل تريد استخدامه؟`,
		yesLabel: "Yes, use this room",
		noLabel: "No",
	});
	return null;
};

const getExistingReservedCount = async ({ hotelId, checkinDate, checkoutDate, roomType, displayName }) => {
	if (!checkinDate || !checkoutDate || !roomType) return 0;
	const reservations = await Reservations.find({
		hotelId: ObjectId(hotelId),
		reservation_status: { $not: CLOSED_STATUS_REGEX },
		checkin_date: { $lt: new Date(checkoutDate) },
		checkout_date: { $gt: new Date(checkinDate) },
	})
		.select("pickedRoomsType")
		.lean()
		.exec();
	return reservations.reduce((total, reservation) => {
		return (
			total +
			(Array.isArray(reservation.pickedRoomsType) ? reservation.pickedRoomsType : []).reduce(
				(sum, room) => {
					const sameType = normalizeText(room.room_type) === normalizeText(roomType);
					const sameDisplay =
						!displayName ||
						!room.displayName ||
						normalizeText(room.displayName) === normalizeText(displayName);
					return sameType && sameDisplay ? sum + (Number(room.count) || 1) : sum;
				},
				0
			)
		);
	}, 0);
};

const attachAvailabilityWarnings = async ({ rows, hotelId, answers, questions }) => {
	const provisional = {};
	for (const row of rows) {
		if (row.errors.length || !row.roomType || !row.checkinDate || !row.checkoutDate) continue;
		const roomMatch = {
			hotelId: ObjectId(hotelId),
			room_type: row.roomType,
			activeRoom: { $ne: false },
			active: { $ne: false },
		};
		if (row.displayName) roomMatch.display_name = row.displayName;
		const totalRooms = await Rooms.countDocuments(roomMatch);
		const existingCount = await getExistingReservedCount({
			hotelId,
			checkinDate: row.checkinDate,
			checkoutDate: row.checkoutDate,
			roomType: row.roomType,
			displayName: row.displayName,
		});
		const key = [
			normalizeText(row.roomType),
			normalizeText(row.displayName),
			row.checkinDate,
			row.checkoutDate,
		].join("|");
		const alreadyInUpload = provisional[key] || 0;
		const available = totalRooms - existingCount - alreadyInUpload;
		row.availableRooms = available;
		if (available <= 0) {
			const questionId = `overbooking:${row.key}`;
			if (answers[questionId] === "yes") {
				row.warnings.push("Overbooking was approved by the employee.");
			} else if (answers[questionId] === "no") {
				row.errors.push("Overbooking was rejected.");
			} else {
				questions.push({
					id: questionId,
					type: "overbooking",
					rowKey: row.key,
					message: `This row may overbook ${row.roomType}${row.displayName ? ` - ${row.displayName}` : ""} for ${row.checkinDate} to ${row.checkoutDate}. Proceed?`,
					arMessage: `قد يتسبب هذا الصف في حجز زائد لـ ${row.roomType}${row.displayName ? ` - ${row.displayName}` : ""} من ${row.checkinDate} إلى ${row.checkoutDate}. هل تريد المتابعة؟`,
					yesLabel: "Proceed",
					noLabel: "Do not import this row",
				});
			}
		}
		provisional[key] = alreadyInUpload + 1;
	}
};

const normalizeRows = ({ rawRows, mapping }) =>
	rawRows
		.map((row, index) => {
			const checkinDate = parseDateValue(fieldFromRow(row, mapping, "checkinDate"));
			const checkoutDate = parseDateValue(fieldFromRow(row, mapping, "checkoutDate"));
			const normalized = {
				key: `row-${index + 1}`,
				rowNumber: index + 1,
				guestName: String(fieldFromRow(row, mapping, "guestName") || "").trim(),
				guestPhone: String(fieldFromRow(row, mapping, "guestPhone") || "").trim(),
				guestCountry: String(fieldFromRow(row, mapping, "guestCountry") || "").trim(),
				checkinDate,
				checkoutDate,
				roomType: String(fieldFromRow(row, mapping, "roomType") || "").trim(),
				displayName: String(fieldFromRow(row, mapping, "displayName") || "").trim(),
				totalAmount: moneyNumber(fieldFromRow(row, mapping, "totalAmount")),
				agentName: String(fieldFromRow(row, mapping, "agentName") || "").trim(),
				commissionRaw: fieldFromRow(row, mapping, "commission"),
				commission: fieldFromRow(row, mapping, "commission") === "" ? "" : moneyNumber(fieldFromRow(row, mapping, "commission")),
				comment: String(fieldFromRow(row, mapping, "comment") || "").trim(),
				confirmationNumber: String(fieldFromRow(row, mapping, "confirmationNumber") || "").trim(),
				payment: String(fieldFromRow(row, mapping, "payment") || "not paid").trim() || "not paid",
				totalGuests: Number(fieldFromRow(row, mapping, "totalGuests") || 1) || 1,
				errors: [],
				warnings: [],
			};
			if (!normalized.guestName) normalized.errors.push("Guest name is missing.");
			if (!normalized.guestPhone) normalized.warnings.push("Guest phone is missing.");
			if (!normalized.checkinDate) normalized.errors.push("Check-in date is missing or invalid.");
			if (!normalized.checkoutDate) normalized.errors.push("Check-out date is missing or invalid.");
			if (
				normalized.checkinDate &&
				normalized.checkoutDate &&
				!moment(normalized.checkoutDate).isAfter(moment(normalized.checkinDate))
			) {
				normalized.errors.push("Check-out must be after check-in.");
			}
			if (!normalized.roomType && !normalized.displayName) {
				normalized.errors.push("Room type or display name is missing.");
			}
			if (!normalized.totalAmount) normalized.warnings.push("Total amount is zero or missing.");
			return normalized;
		})
		.filter((row) =>
			Object.keys(row).some((key) => !["key", "rowNumber", "errors", "warnings"].includes(key) && row[key])
		);

const delayIfConfigured = async (questions = []) => {
	const ms = Math.min(Number(process.env.AI_AGENT_REPLY_DELAY_MS || 0) || 0, 3000);
	if (!questions.length || ms <= 0) return;
	await new Promise((resolve) => setTimeout(resolve, ms));
};

exports.previewReservationExcelImport = async (req, res) => {
	let filePath = req.file?.path;
	try {
		const { userId, hotelId } = req.params;
		const actor = await User.findById(req.auth?._id || userId)
			.select("_id name email role roleDescription roles roleDescriptions hotelsToSupport hotelIdsOwner hotelIdWork belongsToId activeUser")
			.lean()
			.exec();
		if (!actor || actor.activeUser === false) {
			return res.status(403).json({ error: "Access denied" });
		}
		const allowed = await canUseImportWorkflow(actor, hotelId);
		if (!allowed) return res.status(403).json({ error: "Access denied" });
		if (!req.file) return res.status(400).json({ error: "Please upload an Excel file." });

		const hotel = await HotelDetails.findById(hotelId)
			.select("_id hotelName belongsTo roomCountDetails commission")
			.lean()
			.exec();
		if (!hotel) return res.status(404).json({ error: "Hotel was not found." });

		const rawRows = readWorkbookRows(filePath);
		const headers = Object.keys(rawRows[0] || {});
		const fallbackMapping = buildFallbackMapping(headers);
		const aiMapping = await getOpenAiMapping({ headers, sampleRows: rawRows });
		const mapping = { ...fallbackMapping, ...aiMapping };
		const answers = JSON.parse(req.body.answers || "{}");
		const questions = [];
		const agents = await listImportAgents(hotelId);
		const roomOptions = listRoomOptions(hotel);

		const rows = normalizeRows({ rawRows, mapping }).slice(0, 1000);
		rows.forEach((row) => {
			const room = resolveRoomForRow(row, roomOptions, answers, questions);
			if (room) {
				row.roomType = room.roomType;
				row.displayName = room.displayName || row.displayName;
			}
			const agent = resolveAgentForRow(row, agents, answers, questions);
			if (agent) {
				row.agentId = String(agent._id);
				row.agentName = agentLabel(agent);
				row.agentCompanyName = agent.companyName || "";
			}
			row.bookingSource = row.agentCompanyName || row.agentName || "Excel Upload";
		});
		await attachAvailabilityWarnings({ rows, hotelId, answers, questions });
		await delayIfConfigured(questions);

		res.json({
			rows,
			questions,
			mapping,
			canCommit: rows.length > 0 && rows.every((row) => !row.errors.length) && !questions.length,
			message: questions.length
				? "Please answer the AI clarification questions before importing."
				: "Excel is ready for final review.",
		});
	} catch (error) {
		console.error("[reservation-excel-import] preview failed:", error);
		res.status(500).json({ error: "Could not preview Excel import." });
	} finally {
		if (filePath) fs.unlink(filePath, () => {});
	}
};

const generateConfirmationNumber = async () => {
	for (let attempt = 0; attempt < 10; attempt += 1) {
		const number = String(Math.floor(1000000000 + Math.random() * 9000000000));
		const exists = await Reservations.exists({ confirmation_number: number });
		if (!exists) return number;
	}
	return `${Date.now()}`.slice(-10);
};

const buildPricingByDay = ({ checkinDate, checkoutDate, totalAmount }) => {
	const start = moment(checkinDate).startOf("day");
	const end = moment(checkoutDate).startOf("day");
	const nights = Math.max(end.diff(start, "days"), 1);
	const nightly = Number((moneyNumber(totalAmount) / nights).toFixed(2));
	const rows = [];
	for (let index = 0; index < nights; index += 1) {
		rows.push({
			date: start.clone().add(index, "days").format("YYYY-MM-DD"),
			price: nightly,
			rootPrice: nightly,
			totalPriceWithCommission: nightly,
			totalPriceWithoutCommission: nightly,
		});
	}
	return rows;
};

exports.commitReservationExcelImport = async (req, res) => {
	try {
		const { userId, hotelId } = req.params;
		const actor = await User.findById(req.auth?._id || userId)
			.select("_id name email role roleDescription roles roleDescriptions hotelsToSupport hotelIdsOwner hotelIdWork belongsToId activeUser")
			.lean()
			.exec();
		if (!actor || actor.activeUser === false) {
			return res.status(403).json({ error: "Access denied" });
		}
		const allowed = await canUseImportWorkflow(actor, hotelId);
		if (!allowed) return res.status(403).json({ error: "Access denied" });

		const hotel = await HotelDetails.findById(hotelId).select("_id hotelName belongsTo").lean().exec();
		if (!hotel) return res.status(404).json({ error: "Hotel was not found." });

		const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
		if (!rows.length) return res.status(400).json({ error: "No rows were provided." });

		const actorSnapshot = buildActorSnapshot(actor);
		const created = [];
		const errors = [];

		for (const row of rows) {
			if (Array.isArray(row.errors) && row.errors.length) {
				errors.push({ rowNumber: row.rowNumber, error: row.errors.join(" ") });
				continue;
			}
			try {
				const confirmationNumber =
					String(row.confirmationNumber || "").trim() ||
					(await generateConfirmationNumber());
				const agent = row.agentId && ObjectId.isValid(row.agentId)
					? await User.findById(row.agentId)
							.select("_id name email companyName role roleDescription")
							.lean()
							.exec()
					: null;
				const orderTakerSnapshot = agent ? buildActorSnapshot(agent) : actorSnapshot;
				const nights = Math.max(
					moment(row.checkoutDate).startOf("day").diff(moment(row.checkinDate).startOf("day"), "days"),
					1
				);
				const daysOfResidence = nights + 1;
				const commissionProvided =
					row.commission !== "" &&
					row.commission !== null &&
					row.commission !== undefined;
				const commissionAmount = commissionProvided ? moneyNumber(row.commission) : 0;
				const pricingByDay = buildPricingByDay({
					checkinDate: row.checkinDate,
					checkoutDate: row.checkoutDate,
					totalAmount: row.totalAmount,
				});
				const bookingSource =
					row.bookingSource ||
					row.agentCompanyName ||
					row.agentName ||
					"Excel Upload";
				const reservation = new Reservations({
					confirmation_number: confirmationNumber,
					customer_details: {
						name: row.guestName || "Guest",
						phone: row.guestPhone || "",
						email: row.guestEmail || "",
						nationality: row.guestCountry || "",
					},
					checkin_date: new Date(row.checkinDate),
					checkout_date: new Date(row.checkoutDate),
					days_of_residence: daysOfResidence,
					total_guests: Number(row.totalGuests || 1) || 1,
					adults: Number(row.totalGuests || 1) || 1,
					total_rooms: 1,
					total_amount: moneyNumber(row.totalAmount),
					sub_total: moneyNumber(row.totalAmount),
					payment: row.payment || "not paid",
					financeStatus: row.payment || "not paid",
					booking_source: bookingSource,
					comment: row.comment || "",
					state: "Pending Confirmation",
					reservation_status: "Pending Confirmation",
					pendingConfirmation: {
						status: "pending",
						rejectionReason: "",
						createdFromExcelAt: new Date(),
						lastUpdatedAt: new Date(),
						lastUpdatedBy: actor._id,
					},
					commission: commissionAmount,
					commissionPaid: false,
					commissionStatus: commissionProvided
						? commissionAmount > 0
							? "commission due"
							: "no commission due"
						: "",
					commissionData: {
						assigned: commissionProvided,
						assignedAt: commissionProvided ? new Date() : null,
						assignedBy: commissionProvided ? actor._id : null,
						source: "excel_import",
					},
					financial_cycle: {
						collectionModel: "pending",
						status: "open",
						commissionType: "amount",
						commissionValue: commissionAmount,
						commissionAmount,
						commissionAssigned: commissionProvided,
						commissionAssignedAt: commissionProvided ? new Date() : null,
						commissionAssignedBy: commissionProvided ? actor._id : null,
						pmsCollectedAmount: 0,
						hotelCollectedAmount: 0,
						hotelPayoutDue: 0,
						commissionDueToPms: commissionAmount,
						closedAt: null,
						closedBy: null,
						notes: "Created from Excel import.",
						lastUpdatedAt: new Date(),
						lastUpdatedBy: actor._id,
					},
					pickedRoomsType: [
						{
							room_type: row.roomType,
							displayName: row.displayName || "",
							chosenPrice: moneyNumber(row.totalAmount),
							count: 1,
							pricingByDay,
						},
					],
					pickedRoomsPricing: pricingByDay,
					belongsTo: hotel.belongsTo,
					hotelId: hotel._id,
					createdByUserId: actor._id,
					createdBy: actorSnapshot,
					orderTakeId: agent?._id || actor._id,
					orderTaker: orderTakerSnapshot,
					orderTakenAt: new Date(),
					reservationAuditLog: [
						{
							at: new Date(),
							action: "excel_import_created",
							by: actorSnapshot,
							note:
								"Reservation was created from AI-assisted Excel import and set to Pending Confirmation.",
						},
					],
				});
				const saved = await reservation.save();
				created.push({
					_id: saved._id,
					confirmation_number: saved.confirmation_number,
					guestName: saved.customer_details?.name || "",
				});
			} catch (error) {
				errors.push({
					rowNumber: row.rowNumber,
					error: error.code === 11000
						? "Duplicate confirmation number."
						: error.message || "Could not create reservation.",
				});
			}
		}

		res.json({
			created,
			errors,
			message: `${created.length} reservations imported.`,
		});
	} catch (error) {
		console.error("[reservation-excel-import] commit failed:", error);
		res.status(500).json({ error: "Could not import reservations." });
	}
};
