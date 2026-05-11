/** @format */

"use strict";

const mongoose = require("mongoose");
const cloudinary = require("cloudinary");
const AgentWallet = require("../models/agent_wallet");
const Reservations = require("../models/reservations");
const User = require("../models/user");
const HotelDetails = require("../models/hotel_details");

const ObjectId = mongoose.Types.ObjectId;

cloudinary.config({
	cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
	api_key: process.env.CLOUDINARY_API_KEY,
	api_secret: process.env.CLOUDINARY_API_SECRET,
});

const configuredSuperAdminIds = () =>
	[process.env.SUPER_ADMIN_ID, process.env.REACT_APP_SUPER_ADMIN_ID]
		.filter(Boolean)
		.map((id) => String(id).trim());

const normalizeId = (value) => {
	if (!value) return "";
	if (typeof value === "object") return String(value._id || value.id || "");
	return String(value);
};

const includesId = (values = [], id) =>
	(Array.isArray(values) ? values : [])
		.map(normalizeId)
		.filter(Boolean)
		.includes(String(id || ""));

const roleNumbers = (user = {}) => [
	...new Set([user.role, ...(Array.isArray(user.roles) ? user.roles : [])]
		.map(Number)
		.filter(Boolean)),
];

const roleDescriptions = (user = {}) => [
	String(user.roleDescription || "").toLowerCase(),
	...(Array.isArray(user.roleDescriptions)
		? user.roleDescriptions.map((item) => String(item || "").toLowerCase())
		: []),
];

const hasRole = (user, role) => roleNumbers(user).includes(Number(role));
const hasRoleDescription = (user, description) =>
	roleDescriptions(user).includes(String(description || "").toLowerCase());

const isSuperAdmin = (user = {}) =>
	configuredSuperAdminIds().includes(normalizeId(user._id));

const isOrderTaker = (user = {}) =>
	hasRole(user, 7000) ||
	hasRoleDescription(user, "ordertaker") ||
	(Array.isArray(user.accessTo) && user.accessTo.includes("ownReservations"));

const actorSelect =
	"_id name email companyName role roleDescription roles roleDescriptions accessTo hotelIdWork belongsToId hotelsToSupport hotelIdsOwner activeUser";

const getActor = async (req, fallbackUserId) => {
	const actorId = req.auth?._id || fallbackUserId;
	if (!actorId || !ObjectId.isValid(actorId)) return null;
	return User.findById(actorId).select(actorSelect).lean().exec();
};

const getHotel = async (hotelId) => {
	if (!ObjectId.isValid(hotelId)) return null;
	return HotelDetails.findById(hotelId)
		.select("_id hotelName belongsTo")
		.lean()
		.exec();
};

const canAccessHotelFinancials = (actor = {}, hotel = {}) => {
	if (!actor || actor.activeUser === false || !hotel?._id) return false;
	const hotelId = normalizeId(hotel._id);
	const ownerId = normalizeId(hotel.belongsTo);
	const actorId = normalizeId(actor._id);

	if (isSuperAdmin(actor) || hasRole(actor, 1000)) return true;
	if (actorId === ownerId && hasRole(actor, 2000)) return true;
	if (includesId(actor.hotelIdsOwner, hotelId)) return true;
	if (includesId(actor.hotelsToSupport, hotelId)) return true;
	if (normalizeId(actor.hotelIdWork) === hotelId) return true;

	return false;
};

const canManageHotelFinancials = (actor = {}, hotel = {}) => {
	if (!canAccessHotelFinancials(actor, hotel)) return false;
	if (isSuperAdmin(actor) || hasRole(actor, 1000)) return true;
	if (hasRole(actor, 2000) || hasRoleDescription(actor, "hotelmanager")) return true;
	if (hasRole(actor, 6000) || hasRoleDescription(actor, "finance")) return true;
	return false;
};

const canManageRole = (actor = {}) =>
	isSuperAdmin(actor) ||
	hasRole(actor, 1000) ||
	hasRole(actor, 2000) ||
	hasRoleDescription(actor, "hotelmanager") ||
	hasRole(actor, 6000) ||
	hasRoleDescription(actor, "finance");

const canReadAgentWalletRole = (actor = {}) =>
	canManageRole(actor) ||
	hasRole(actor, 8000) ||
	hasRoleDescription(actor, "reservationemployee");

const actorCanSeeAgent = (actor = {}, agentId = "") =>
	canReadAgentWalletRole(actor) ||
	normalizeId(actor._id) === normalizeId(agentId);

const buildAgentHotelQuery = (hotelId) => ({
	activeUser: { $ne: false },
	$and: [
		{
			$or: [
				{ role: 7000 },
				{ roles: 7000 },
				{ roleDescription: "ordertaker" },
				{ roleDescriptions: "ordertaker" },
			],
		},
		{
			$or: [
				{ hotelIdWork: String(hotelId) },
				{ hotelsToSupport: ObjectId(hotelId) },
			],
		},
	],
});

const buildAgentReservationMatch = (hotelId, agentId) => ({
	hotelId: ObjectId(hotelId),
	$or: [
		{ createdByUserId: ObjectId(agentId) },
		{ orderTakeId: ObjectId(agentId) },
		{ "createdBy._id": String(agentId) },
		{ "orderTaker._id": String(agentId) },
	],
});

const buildDateFilter = (field, startDate, endDate) => {
	const filter = {};
	if (startDate) {
		const start = new Date(startDate);
		if (!Number.isNaN(start.getTime())) filter.$gte = start;
	}
	if (endDate) {
		const end = new Date(endDate);
		if (!Number.isNaN(end.getTime())) {
			end.setHours(23, 59, 59, 999);
			filter.$lte = end;
		}
	}
	return Object.keys(filter).length ? { [field]: filter } : {};
};

const moneyNumber = (value) => {
	if (value === null || value === undefined || value === "") return 0;
	const parsed = Number(String(value).replace(/,/g, "").trim());
	return Number.isFinite(parsed) ? parsed : 0;
};

const n2 = (value) => Number(moneyNumber(value).toFixed(2));

const reservationIsDeductible = (reservation = {}) => {
	const status = String(
		reservation.reservation_status || reservation.state || ""
	).toLowerCase();
	return !/(cancelled|canceled|rejected)/i.test(status);
};

const commissionAmount = (reservation = {}) =>
	n2(
		moneyNumber(reservation.commission) ||
			moneyNumber(reservation.financial_cycle?.commissionAmount)
	);

const actorSnapshot = (actor = {}) => ({
	_id: normalizeId(actor._id),
	name: actor.name || actor.email || "",
	email: actor.email || "",
	role: actor.role || "",
});

const allowedTransactionTypes = ["deposit", "debit", "adjustment", "refund"];

const normalizeTransactionType = (value) =>
	allowedTransactionTypes.includes(String(value || "").toLowerCase())
		? String(value).toLowerCase()
		: "deposit";

const parseTransactionDate = (value) => {
	if (!value) return new Date();
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
};

const maxWalletAttachments = 8;
const maxWalletAttachmentBytes = 10 * 1024 * 1024;
const maxWalletAttachmentTotalBytes = 32 * 1024 * 1024;
const walletAttachmentTypes = new Set([
	"application/pdf",
	"image/jpeg",
	"image/jpg",
	"image/png",
	"image/webp",
]);

const cleanFileName = (value = "") =>
	String(value || "wallet-attachment")
		.replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
		.trim()
		.slice(0, 140) || "wallet-attachment";

const dataUrlMimeType = (value = "") => {
	const match = String(value).match(/^data:([^;]+);base64,/i);
	return match ? match[1].toLowerCase() : "";
};

const base64ByteSize = (value = "") => {
	const raw = String(value).split(",").pop() || "";
	const clean = raw.replace(/\s/g, "");
	return Math.ceil((clean.length * 3) / 4);
};

const normalizeExistingAttachment = (item = {}) => {
	if (!item.url || !item.public_id) return null;
	return {
		public_id: String(item.public_id || ""),
		url: String(item.url || ""),
		fileName: cleanFileName(item.fileName || "Attachment"),
		fileType: String(item.fileType || "").toLowerCase(),
		fileSize: moneyNumber(item.fileSize),
		uploadedAt: item.uploadedAt || new Date(),
		uploadedBy: item.uploadedBy || null,
	};
};

const uploadWalletAttachment = async (item = {}, actor = {}) => {
	const existing = normalizeExistingAttachment(item);
	if (existing && !item.data) return existing;

	const data = String(item.data || "");
	if (!data) return null;

	const mimeType = String(item.fileType || dataUrlMimeType(data) || "")
		.toLowerCase()
		.trim();

	if (!walletAttachmentTypes.has(mimeType)) {
		throw new Error("Only PDF and image attachments are allowed.");
	}

	const fileSize = moneyNumber(item.fileSize) || base64ByteSize(data);
	if (fileSize > maxWalletAttachmentBytes) {
		throw new Error("Each wallet attachment must be 10MB or smaller.");
	}

	const response = await cloudinary.v2.uploader.upload(data, {
		folder: "janat/wallet-attachments",
		resource_type: "auto",
		use_filename: true,
		unique_filename: true,
	});

	return {
		public_id: response.public_id,
		url: response.secure_url,
		fileName: cleanFileName(item.fileName || response.original_filename || ""),
		fileType: mimeType,
		fileSize,
		uploadedAt: new Date(),
		uploadedBy: actorSnapshot(actor),
	};
};

const buildWalletAttachments = async (items = [], actor = {}) => {
	const list = Array.isArray(items) ? items : [];
	if (list.length > maxWalletAttachments) {
		throw new Error(`You can attach up to ${maxWalletAttachments} files.`);
	}
	const totalSize = list.reduce(
		(sum, item) =>
			sum + (moneyNumber(item.fileSize) || (item.data ? base64ByteSize(item.data) : 0)),
		0
	);
	if (totalSize > maxWalletAttachmentTotalBytes) {
		throw new Error("Wallet attachments must be 32MB total or smaller.");
	}
	const attachments = await Promise.all(
		list.map((item) => uploadWalletAttachment(item, actor))
	);
	return attachments.filter(Boolean);
};

const calculateAgentWalletSummary = async ({
	agent,
	hotelId,
	startDate,
	endDate,
}) => {
	const agentId = normalizeId(agent._id);
	const walletDateFilter = buildDateFilter("transactionDate", startDate, endDate);
	const reservationDateFilter = Object.keys(
		buildDateFilter("createdAt", startDate, endDate)
	).length
		? {
				$or: [
					buildDateFilter("booked_at", startDate, endDate),
					{
						booked_at: { $in: [null, ""] },
						...buildDateFilter("createdAt", startDate, endDate),
					},
				],
		  }
		: {};

	const walletBaseMatch = {
		hotelId: ObjectId(hotelId),
		agentId: ObjectId(agentId),
		status: { $ne: "void" },
	};
	const reservationBaseMatch = buildAgentReservationMatch(hotelId, agentId);

	const [transactions, reservations, allTransactions, allReservations] =
		await Promise.all([
			AgentWallet.find({
				...walletBaseMatch,
				...walletDateFilter,
			})
			.sort({ transactionDate: -1, createdAt: -1 })
			.lean()
			.exec(),
			Reservations.find({
				...reservationBaseMatch,
				...reservationDateFilter,
			})
			.select(
				"_id confirmation_number customer_details.name booking_source booked_at createdAt checkin_date checkout_date reservation_status state total_amount commission commissionPaid financial_cycle pendingConfirmation"
			)
			.sort({ booked_at: -1, createdAt: -1 })
			.lean()
			.exec(),
			AgentWallet.find(walletBaseMatch).lean().exec(),
			Reservations.find(reservationBaseMatch)
				.select(
					"_id reservation_status state total_amount commission commissionPaid financial_cycle pendingConfirmation"
				)
				.lean()
				.exec(),
		]);

	const transactionTotals = allTransactions.reduce(
		(acc, tx) => {
			const amount = n2(tx.amount);
			if (tx.transactionType === "deposit" || tx.transactionType === "refund") {
				acc.credits += amount;
			} else if (tx.transactionType === "debit") {
				acc.manualDebits += amount;
			} else {
				acc.adjustments += amount;
			}
			return acc;
		},
		{ credits: 0, manualDebits: 0, adjustments: 0 }
	);

	const reservationTotals = allReservations.reduce(
		(acc, reservation) => {
			const amount = n2(reservation.total_amount);
			const commission = commissionAmount(reservation);
			const status = String(
				reservation.reservation_status || reservation.state || ""
			).toLowerCase();

			acc.totalReservations += 1;
			acc.totalReservationValue += amount;
			acc.totalCommission += commission;
			if (reservationIsDeductible(reservation)) {
				acc.walletDeducted += amount;
			}
			if (/pending/.test(status)) acc.pendingConfirmation += 1;
			if (reservation.commissionPaid) acc.commissionPaid += commission;
			return acc;
		},
		{
			totalReservations: 0,
			totalReservationValue: 0,
			walletDeducted: 0,
			totalCommission: 0,
			commissionPaid: 0,
			pendingConfirmation: 0,
		}
	);

	const walletAdded = n2(
		transactionTotals.credits + transactionTotals.adjustments
	);
	const walletUsed = n2(reservationTotals.walletDeducted + transactionTotals.manualDebits);
	const balance = n2(walletAdded - walletUsed);

	return {
		agent: {
			_id: agentId,
			name: agent.name || agent.email || "",
			email: agent.email || "",
			phone: agent.phone || "",
			companyName: agent.companyName || "",
		},
		walletAdded,
		walletUsed,
		balance,
		manualDebits: n2(transactionTotals.manualDebits),
		totalReservations: reservationTotals.totalReservations,
		totalReservationValue: n2(reservationTotals.totalReservationValue),
		walletDeducted: n2(reservationTotals.walletDeducted),
		totalCommission: n2(reservationTotals.totalCommission),
		commissionPaid: n2(reservationTotals.commissionPaid),
		commissionDue: n2(
			reservationTotals.totalCommission - reservationTotals.commissionPaid
		),
		pendingConfirmation: reservationTotals.pendingConfirmation,
		transactions,
		reservations,
	};
};

exports.agentWalletSummary = async (req, res) => {
	try {
		const { hotelId, userId } = req.params;
		const { agentId = "", startDate = "", endDate = "" } = req.query || {};

		const [actor, hotel] = await Promise.all([
			getActor(req, userId),
			getHotel(hotelId),
		]);
		if (!actor || !hotel || !canAccessHotelFinancials(actor, hotel)) {
			return res.status(403).json({ error: "Access denied" });
		}

		const requestedAgentId = normalizeId(agentId);
		let agents = [];
		if (isOrderTaker(actor) && !canManageRole(actor)) {
			agents = [actor];
		} else if (requestedAgentId) {
			if (!ObjectId.isValid(requestedAgentId)) {
				return res.status(400).json({ error: "Invalid agent id" });
			}
			const agent = await User.findOne({
				_id: ObjectId(requestedAgentId),
				...buildAgentHotelQuery(hotelId),
			})
				.select("_id name email phone companyName")
				.lean()
				.exec();
			if (!agent || !actorCanSeeAgent(actor, requestedAgentId)) {
				return res.status(403).json({ error: "Agent access denied" });
			}
			agents = [agent];
		} else {
			agents = await User.find(buildAgentHotelQuery(hotelId))
				.select("_id name email phone companyName")
				.sort({ companyName: 1, name: 1 })
				.lean()
				.exec();
		}

		const summaries = await Promise.all(
			agents.map((agent) =>
				calculateAgentWalletSummary({ agent, hotelId, startDate, endDate })
			)
		);

		const totals = summaries.reduce(
			(acc, item) => {
				acc.walletAdded += item.walletAdded;
				acc.walletUsed += item.walletUsed;
				acc.balance += item.balance;
				acc.totalReservations += item.totalReservations;
				acc.totalReservationValue += item.totalReservationValue;
				acc.totalCommission += item.totalCommission;
				acc.commissionDue += item.commissionDue;
				acc.pendingConfirmation += item.pendingConfirmation;
				return acc;
			},
			{
				walletAdded: 0,
				walletUsed: 0,
				balance: 0,
				totalReservations: 0,
				totalReservationValue: 0,
				totalCommission: 0,
				commissionDue: 0,
				pendingConfirmation: 0,
			}
		);

		Object.keys(totals).forEach((key) => {
			if (typeof totals[key] === "number") totals[key] = n2(totals[key]);
		});

		return res.json({
			hotel: {
				_id: normalizeId(hotel._id),
				hotelName: hotel.hotelName || "",
			},
			agents: summaries,
			totals,
			canManage: canManageHotelFinancials(actor, hotel),
		});
	} catch (error) {
		console.error("agentWalletSummary error:", error);
		return res.status(500).json({ error: error.message });
	}
};

exports.createAgentWalletTransaction = async (req, res) => {
	try {
		const { hotelId, userId } = req.params;
		const body = req.body || {};
		const [actor, hotel] = await Promise.all([
			getActor(req, userId),
			getHotel(hotelId),
		]);

		if (!actor || !hotel || !canManageHotelFinancials(actor, hotel)) {
			return res.status(403).json({ error: "Access denied" });
		}

		const agentId = normalizeId(body.agentId);
		if (!ObjectId.isValid(agentId)) {
			return res.status(400).json({ error: "Valid agent is required" });
		}

		const agent = await User.findOne({
			_id: ObjectId(agentId),
			...buildAgentHotelQuery(hotelId),
		})
			.select("_id name email phone companyName")
			.lean()
			.exec();
		if (!agent) {
			return res.status(404).json({ error: "Agent was not found for this hotel" });
		}

		const amount = n2(body.amount);
		if (!amount) {
			return res.status(400).json({ error: "Amount is required" });
		}

		let attachments = [];
		try {
			attachments = await buildWalletAttachments(body.attachments, actor);
		} catch (uploadError) {
			return res.status(400).json({ error: uploadError.message });
		}

		const transaction = await AgentWallet.create({
			hotelId: ObjectId(hotelId),
			ownerId: ObjectId.isValid(normalizeId(hotel.belongsTo))
				? ObjectId(normalizeId(hotel.belongsTo))
				: null,
			agentId: ObjectId(agentId),
			transactionType: normalizeTransactionType(body.transactionType),
			amount,
			currency: "SAR",
			note: String(body.note || "").trim(),
			reference: String(body.reference || "").trim(),
			transactionDate: parseTransactionDate(body.transactionDate),
			attachments,
			createdBy: actorSnapshot(actor),
		});

		const summary = await calculateAgentWalletSummary({
			agent,
			hotelId,
			startDate: body.startDate || "",
			endDate: body.endDate || "",
		});

		return res.json({ transaction, summary });
	} catch (error) {
		console.error("createAgentWalletTransaction error:", error);
		return res.status(500).json({ error: error.message });
	}
};

exports.updateAgentWalletTransaction = async (req, res) => {
	try {
		const { hotelId, userId, transactionId } = req.params;
		const body = req.body || {};

		const [actor, hotel] = await Promise.all([
			getActor(req, userId),
			getHotel(hotelId),
		]);

		if (!actor || !hotel || !canManageHotelFinancials(actor, hotel)) {
			return res.status(403).json({ error: "Access denied" });
		}

		if (!ObjectId.isValid(transactionId)) {
			return res.status(400).json({ error: "Invalid transaction id" });
		}

		const transaction = await AgentWallet.findOne({
			_id: ObjectId(transactionId),
			hotelId: ObjectId(hotelId),
			status: { $ne: "void" },
		}).exec();

		if (!transaction) {
			return res.status(404).json({ error: "Wallet transaction was not found" });
		}

		if (transaction.reservationId) {
			return res
				.status(400)
				.json({ error: "Reservation wallet deductions cannot be edited here" });
		}

		const amount = n2(body.amount);
		if (!amount) {
			return res.status(400).json({ error: "Amount is required" });
		}

		let attachments = [];
		try {
			attachments = await buildWalletAttachments(body.attachments, actor);
		} catch (uploadError) {
			return res.status(400).json({ error: uploadError.message });
		}

		transaction.transactionType = normalizeTransactionType(body.transactionType);
		transaction.amount = amount;
		transaction.note = String(body.note || "").trim();
		transaction.reference = String(body.reference || "").trim();
		transaction.transactionDate = parseTransactionDate(body.transactionDate);
		transaction.attachments = attachments;
		transaction.updatedBy = actorSnapshot(actor);

		await transaction.save();

		return res.json({ transaction });
	} catch (error) {
		console.error("updateAgentWalletTransaction error:", error);
		return res.status(500).json({ error: error.message });
	}
};

exports.voidAgentWalletTransaction = async (req, res) => {
	try {
		const { hotelId, userId, transactionId } = req.params;
		const [actor, hotel] = await Promise.all([
			getActor(req, userId),
			getHotel(hotelId),
		]);

		if (!actor || !hotel || !canManageHotelFinancials(actor, hotel)) {
			return res.status(403).json({ error: "Access denied" });
		}

		if (!ObjectId.isValid(transactionId)) {
			return res.status(400).json({ error: "Invalid transaction id" });
		}

		const transaction = await AgentWallet.findOne({
			_id: ObjectId(transactionId),
			hotelId: ObjectId(hotelId),
			status: { $ne: "void" },
		}).exec();

		if (!transaction) {
			return res.status(404).json({ error: "Wallet transaction was not found" });
		}

		if (transaction.reservationId) {
			return res
				.status(400)
				.json({ error: "Reservation wallet deductions cannot be deleted here" });
		}

		transaction.status = "void";
		transaction.voidedAt = new Date();
		transaction.voidedBy = actorSnapshot(actor);
		await transaction.save();

		return res.json({ deleted: true, transactionId });
	} catch (error) {
		console.error("voidAgentWalletTransaction error:", error);
		return res.status(500).json({ error: error.message });
	}
};
