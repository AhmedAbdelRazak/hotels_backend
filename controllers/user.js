/** @format */

"use strict";

const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const User = require("../models/user");
const HotelDetails = require("../models/hotel_details");

const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

const sanitizeUserForResponse = (u) => {
	if (!u) return u;
	const obj = u.toObject ? u.toObject() : u;
	delete obj.hashed_password;
	delete obj.salt;
	return obj;
};

const validateEmailFormat = (e) => {
	if (typeof e !== "string") return false;
	// simple robust pattern; rely on unique index in DB for final authority
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());
};

const normalizeOptionalEmail = (value) => String(value || "").trim().toLowerCase();

const buildStaffPlaceholderEmail = (phoneValue, hotelValue) => {
	const phonePart = String(phoneValue || "").replace(/[^0-9]/g, "") || "staff";
	const hotelPart = String(hotelValue || "").replace(/[^a-zA-Z0-9]/g, "");
	return `staff-${hotelPart}-${phonePart}@staff.jannatbooking.local`.toLowerCase();
};

const isStaffPlaceholderEmail = (email) =>
	String(email || "").toLowerCase().endsWith("@staff.jannatbooking.local");

const sanitizeCompanyDocuments = (documents = []) =>
	(Array.isArray(documents) ? documents : [])
		.filter((document) => document && (document.fileName || document.dataUrl || document.url))
		.slice(0, 8)
		.map((document) => ({
			fileName: String(document.fileName || document.name || "Company document").slice(0, 180),
			fileType: String(document.fileType || document.type || "").slice(0, 120),
			fileSize: Number(document.fileSize || document.size || 0),
			dataUrl: String(document.dataUrl || document.url || "").slice(0, 5 * 1024 * 1024),
			uploadedAt: document.uploadedAt || new Date(),
			notes: String(document.notes || "").slice(0, 500),
		}));

const AGENT_COMMERCIAL_MODELS = new Set([
	"wallet_inventory",
	"commission_only",
	"mixed",
]);

const normalizeAgentCommercialModel = (value) => {
	const normalized = String(value || "").trim().toLowerCase();
	return AGENT_COMMERCIAL_MODELS.has(normalized)
		? normalized
		: "wallet_inventory";
};

const nonNegativeMoney = (value) => {
	const parsed = Number(String(value ?? 0).replace(/,/g, "").trim());
	return Number.isFinite(parsed) && parsed > 0 ? Number(parsed.toFixed(2)) : 0;
};

const sanitizeAgentWalletOpeningBalances = (
	balances = [],
	hotelIds = [],
	fallbackAmount = 0
) => {
	const byHotel = new Map();
	(Array.isArray(balances) ? balances : []).forEach((entry) => {
		const hotelId = String(entry?.hotelId || entry?.hotel || "").trim();
		if (!hotelId) return;
		byHotel.set(hotelId, nonNegativeMoney(entry?.amount));
	});
	return hotelIds.map((hotelId) => ({
		hotelId,
		amount: byHotel.has(hotelId)
			? byHotel.get(hotelId)
			: nonNegativeMoney(fallbackAmount),
	}));
};

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const configuredSuperAdminIds = () =>
	[process.env.SUPER_ADMIN_ID, process.env.REACT_APP_SUPER_ADMIN_ID]
		.filter(Boolean)
		.map((id) => String(id).trim());

const isConfiguredSuperAdmin = (userOrId) => {
	const userId =
		typeof userOrId === "object" ? userOrId?._id || userOrId?.id : userOrId;
	return configuredSuperAdminIds().includes(String(userId || "").trim());
};

const cleanPhoneNumber = (rawPhone) => {
	if (typeof rawPhone !== "string") throw new Error("Invalid phone number format");
	const cleaned = rawPhone.replace(/\s+/g, "");
	const phoneRegex = /^\+?[0-9]*$/;
	if (!phoneRegex.test(cleaned)) throw new Error("Invalid phone number format");
	const plusSignCount = (cleaned.match(/\+/g) || []).length;
	if (
		plusSignCount > 1 ||
		(plusSignCount === 1 && cleaned.indexOf("+") !== 0)
	) {
		throw new Error("Invalid phone number format");
	}
	return cleaned;
};

const HOTEL_STAFF_ROLES = [2000, 3000, 4000, 5000, 6000, 7000, 8000];
const ROLE_BY_DESCRIPTION = {
	hotelmanager: 2000,
	reception: 3000,
	housekeepingmanager: 4000,
	housekeeping: 5000,
	finance: 6000,
	ordertaker: 7000,
	reservationemployee: 8000,
};

const USER_AUTH_SELECT =
	"_id name email phone companyName agentCommercialModel agentOpeningWalletCredit agentWalletOpeningBalances role roleDescription roles roleDescriptions activePoints activeUser employeeImage userRole userBranch userStore hotelIdWork belongsToId hotelIdsWork hotelsToSupport accessTo";

const buildAuthUserPayload = (user = {}) => ({
	_id: user._id,
	email: user.email,
	phone: user.phone,
	name: user.name,
	role: user.role,
	activePoints: user.activePoints,
	activeUser: user.activeUser,
	employeeImage: user.employeeImage,
	userRole: user.userRole,
	userBranch: user.userBranch,
	userStore: user.userStore,
	roleDescription: user.roleDescription,
	roles: user.roles,
	roleDescriptions: user.roleDescriptions,
	companyName: user.companyName,
	agentCommercialModel: user.agentCommercialModel,
	agentOpeningWalletCredit: user.agentOpeningWalletCredit,
	agentWalletOpeningBalances: user.agentWalletOpeningBalances,
	hotelIdWork: user.hotelIdWork,
	hotelIdsWork: user.hotelIdsWork,
	belongsToId: user.belongsToId,
	hotelsToSupport: user.hotelsToSupport,
	accessTo: user.accessTo,
});

const normalizeObjectIdString = (value) => String(value?._id || value || "");

const uniqueValidObjectIds = (values = []) => [
	...new Set(
		values
			.map(normalizeObjectIdString)
			.filter((value) => value && isValidObjectId(value))
	),
];

const canManageHotelStaff = async (creator, hotelId) => {
	if (!creator || creator.activeUser === false || !isValidObjectId(hotelId)) {
		return { allowed: false, error: "Access denied" };
	}

	const hotel = await HotelDetails.findById(hotelId)
		.select("_id belongsTo hotelName hotelAddress hotelCountry hotelState hotelCity")
		.lean()
		.exec();

	if (!hotel) {
		return { allowed: false, error: "Hotel was not found" };
	}

	const normalizedHotelId = String(hotel._id);
	const ownerId = String(hotel.belongsTo || "");
	const creatorId = String(creator._id || "");
	const creatorRole = Number(creator.role);
	const supportIds = Array.isArray(creator.hotelsToSupport)
		? creator.hotelsToSupport.map((h) => String(h?._id || h))
		: [];
	const ownedIds = Array.isArray(creator.hotelIdsOwner)
		? creator.hotelIdsOwner.map((h) => String(h?._id || h))
		: [];
	const roleDescriptions = [
		String(creator.roleDescription || "").toLowerCase(),
		...(Array.isArray(creator.roleDescriptions)
			? creator.roleDescriptions.map((item) => String(item || "").toLowerCase())
			: []),
	];

	const creatorOwnsHotel =
		creatorRole === 2000 &&
		(creatorId === ownerId || ownedIds.includes(normalizedHotelId));
	const creatorIsAssignedHotelManager =
		creatorRole === 2000 &&
		roleDescriptions.includes("hotelmanager") &&
		String(creator.belongsToId || ownerId) === ownerId &&
		(String(creator.hotelIdWork || "") === normalizedHotelId ||
			supportIds.includes(normalizedHotelId));
	const adminCanSupportHotel =
		isConfiguredSuperAdmin(creator) ||
		(creatorRole === 1000 &&
			(supportIds.length === 0 || supportIds.includes(normalizedHotelId)));

	return {
		allowed:
			creatorOwnsHotel || creatorIsAssignedHotelManager || adminCanSupportHotel,
		error: "You cannot manage users for this hotel",
		hotel,
		hotelId: normalizedHotelId,
		ownerId,
		creatorOwnsHotel,
		creatorIsAssignedHotelManager,
		adminCanSupportHotel,
	};
};

const getManageableStaffHotelIds = async (creator, permission) => {
	const ownerHotels = await HotelDetails.find({ belongsTo: permission.ownerId })
		.select("_id")
		.lean()
		.exec();
	const ownerHotelIds = ownerHotels.map((hotel) => String(hotel._id));
	const creatorRole = Number(creator.role);
	const creatorId = String(creator._id || "");
	const creatorOwnedIds = Array.isArray(creator.hotelIdsOwner)
		? creator.hotelIdsOwner.map(normalizeObjectIdString)
		: [];

	if (
		creatorRole === 1000 ||
		isConfiguredSuperAdmin(creator) ||
		creatorId === permission.ownerId ||
		creatorOwnedIds.some((id) => ownerHotelIds.includes(id))
	) {
		return ownerHotelIds;
	}

	const creatorScopedIds = uniqueValidObjectIds([
		creator.hotelIdWork,
		...(Array.isArray(creator.hotelsToSupport)
			? creator.hotelsToSupport
			: []),
	]);
	return ownerHotelIds.filter((id) => creatorScopedIds.includes(id));
};

/* ───────────────────── Param Loaders ───────────────────── */

exports.userById = (req, res, next, id) => {
	if (!isValidObjectId(id)) {
		return res.status(400).json({ error: "Invalid user id" });
	}

	User.findById(id)
		.select(
			"_id name email emailIsPlaceholder phone companyName agentCommercialModel agentOpeningWalletCredit agentWalletOpeningBalances role roleDescription roles roleDescriptions activeUser hotelIdWork belongsToId hotelIdsOwner hotelsToSupport accessTo"
		)
		.populate("hotelsToSupport")
		.exec((err, user) => {
			if (err || !user) {
				return res.status(400).json({ error: "User not found" });
			}
			req.profile = user; // acting user (admin or self)
			next();
		});
};

exports.updatedUserId = async (req, res, next, id) => {
	if (!isValidObjectId(id)) {
		return res.status(400).json({ error: "Invalid target user id" });
	}
	try {
		const target = await User.findById(id)
			.select(
				"_id name email emailIsPlaceholder phone companyName agentCommercialModel agentOpeningWalletCredit agentWalletOpeningBalances role roleDescription roles roleDescriptions activeUser employeeImage hotelIdWork belongsToId hotelsToSupport accessTo userRole userStore userBranch"
			)
			.exec();
		if (!target) {
			return res.status(400).json({ error: "Target user not found" });
		}
		req.updatedUserByAdmin = target; // target to be updated by admin
		next();
	} catch (err) {
		return res.status(400).json({ error: "Error loading target user" });
	}
};

/* ───────────────────── Regular endpoints ───────────────────── */

exports.read = (req, res) => {
	const safe = sanitizeUserForResponse(req.profile);
	return res.json(safe);
};

exports.remove = (req, res) => {
	// NOTE: this uses req.user in your original code, but your param loader sets req.profile.
	// Keep it as-is if other middleware attaches req.user; otherwise switch to req.profile.
	const user = req.user || req.profile;
	if (!user) return res.status(400).json({ error: "User not loaded" });

	user.remove((err, deletedUser) => {
		if (err) {
			return res.status(400).json({ error: "Failed to delete user" });
		}
		res.json({ message: "User was successfully deleted" });
	});
};

exports.allUsersList = (req, res) => {
	User.find()
		.select(
			"_id name email phone role roleDescription hotelIdWork belongsToId user points activePoints likesUser activeUser employeeImage userRole history userStore userBranch"
		)
		.exec((err, users) => {
			if (err) return res.status(400).json({ error: "Users not found" });
			res.json(users.map(sanitizeUserForResponse));
		});
};

exports.update = async (req, res) => {
	try {
		const { name, email, password } = req.body;

		const user = await User.findById(req.profile._id);
		if (!user) return res.status(400).json({ error: "User not found" });

		// Update name only if provided (allow partial updates)
		if (typeof name !== "undefined") {
			if (!String(name).trim()) {
				return res.status(400).json({ error: "Name cannot be empty" });
			}
			user.name = String(name).trim();
		}

		// Update email only if provided (format + case‑insensitive uniqueness)
		if (typeof email !== "undefined") {
			const trimmed = String(email).trim();
			const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
			if (!valid)
				return res.status(400).json({ error: "Invalid email format" });

			const duplicate = await User.findOne({
				_id: { $ne: user._id },
				email: { $regex: new RegExp("^" + trimmed + "$", "i") },
			}).select("_id");
			if (duplicate) {
				return res
					.status(400)
					.json({ error: "Email already in use by another account" });
			}
			user.email = trimmed;
		}

		// Update password only if provided
		if (typeof password !== "undefined" && password !== "") {
			if (String(password).length < 6) {
				return res
					.status(400)
					.json({ error: "Password should be min 6 characters long" });
			}
			user.password = String(password);
		}

		// If nothing was provided, just respond with current user
		if (
			typeof name === "undefined" &&
			typeof email === "undefined" &&
			(typeof password === "undefined" || password === "")
		) {
			return res.json({
				_id: user._id,
				name: user.name,
				email: user.email,
				role: user.role,
				activeUser: user.activeUser,
			});
		}

		const saved = await user.save();
		const safe = saved.toObject ? saved.toObject() : saved;
		delete safe.hashed_password;
		delete safe.salt;
		return res.json(safe);
	} catch (err) {
		console.error("Self-update error:", err);
		return res.status(400).json({ error: "User update failed" });
	}
};

/* ───────────────────── Admin update target user ─────────────────────
   PUT /user/:updatedUserId/:userId
   - requireSignin, isAuth, isAdmin
   - Supports partial updates: name, email, password (+ legacy fields)
   - Email uniqueness is enforced (case-insensitive)
   - Password optional; if provided, must be 6+ chars
--------------------------------------------------------------------- */
exports.updateUserByAdmin = async (req, res) => {
	try {
		const target = req.updatedUserByAdmin;
		if (!target) {
			// Back-compat: allow body.userId or params.updatedUserId
			const targetId =
				req.params.updatedUserId || req.body.userId || req.params.userId;
			if (!isValidObjectId(targetId)) {
				return res.status(400).json({ error: "Invalid target user id" });
			}
			const found = await User.findById(targetId).exec();
			if (!found) return res.status(400).json({ error: "User not found" });
			req.updatedUserByAdmin = found;
		}

		const userDoc = req.updatedUserByAdmin;
		const payload = req.body || {};

		/* --- name --- */
		if ("name" in payload) {
			if (!payload.name) {
				return res.status(400).json({ error: "Name is required" });
			}
			userDoc.name = payload.name;
		}

		/* --- email --- */
		if ("email" in payload) {
			if (!payload.email) {
				return res.status(400).json({ error: "Email is required" });
			}
			if (!validateEmailFormat(payload.email)) {
				return res.status(400).json({ error: "Invalid email format" });
			}

			// case-insensitive uniqueness check
			const existing = await User.findOne({
				_id: { $ne: userDoc._id },
				email: { $regex: new RegExp("^" + payload.email + "$", "i") },
			}).select("_id email");
			if (existing) {
				return res
					.status(400)
					.json({ error: "Email already in use by another account" });
			}

			userDoc.email = payload.email.trim();
		}

		/* --- password --- */
		if (payload.password != null && payload.password !== "") {
			if (payload.password.length < 6) {
				return res
					.status(400)
					.json({ error: "Password should be min 6 characters long" });
			}
			userDoc.password = payload.password; // schema will hash
		}

		/* --- Legacy fields kept for backward compatibility --- */
		if ("role" in payload && payload.role != null) userDoc.role = payload.role;
		if ("roleDescription" in payload)
			userDoc.roleDescription = payload.roleDescription || "";
		if ("activeUser" in payload && payload.activeUser != null)
			userDoc.activeUser = payload.activeUser;
		if ("hotelIdWork" in payload) userDoc.hotelIdWork = payload.hotelIdWork || "";
		if ("belongsToId" in payload) userDoc.belongsToId = payload.belongsToId || "";
		if ("accessTo" in payload && Array.isArray(payload.accessTo))
			userDoc.accessTo = payload.accessTo;
		const userRoleDescriptions = [
			String(userDoc.roleDescription || "").toLowerCase(),
			...(Array.isArray(userDoc.roleDescriptions)
				? userDoc.roleDescriptions.map((item) => String(item || "").toLowerCase())
				: []),
		];
		if (userRoleDescriptions.includes("reservationemployee")) {
			userDoc.accessTo = [
				...new Set([
					...(Array.isArray(userDoc.accessTo) ? userDoc.accessTo : []),
					"settings",
				]),
			];
		}
		if ("hotelsToSupport" in payload && Array.isArray(payload.hotelsToSupport))
			userDoc.hotelsToSupport = payload.hotelsToSupport;
		if ("employeeImage" in payload)
			userDoc.employeeImage = payload.employeeImage;
		if ("userRole" in payload) userDoc.userRole = payload.userRole;
		if ("userStore" in payload) userDoc.userStore = payload.userStore;
		if ("userBranch" in payload) userDoc.userBranch = payload.userBranch;

		const saved = await userDoc.save();
		return res.json(sanitizeUserForResponse(saved));
	} catch (err) {
		console.error("updateUserByAdmin error:", err);
		return res.status(400).json({ error: "User update failed" });
	}
};

/* ───────────────────── Extra endpoints you already have ───────────────────── */

exports.getSingleUser = (req, res) => {
	const { accountId } = req.params;
	if (!isValidObjectId(accountId)) {
		return res.status(400).json({ error: "Invalid account id" });
	}
	const belongsTo = mongoose.Types.ObjectId(accountId);

	User.findOne({ _id: belongsTo })
		.populate("hotelIdsOwner")
		.exec((err, user) => {
			if (err || !user) {
				return res.status(400).json({ error: "User not found" });
			}
			res.json(sanitizeUserForResponse(user));
		});
};

exports.houseKeepingStaff = async (req, res) => {
	const { hotelId } = req.params;
	if (!isValidObjectId(hotelId)) {
		return res.status(400).json({ error: "Invalid hotel id" });
	}
	try {
		const actor = req.auth?._id
			? await User.findById(req.auth._id).lean().exec()
			: null;
		const permission = await canManageHotelStaff(actor, hotelId);
		if (!permission.allowed) {
			return res.status(403).json({ error: permission.error });
		}

		const staffList = await User.find({
			$and: [
				{
					$or: [{ hotelIdWork: hotelId }, { hotelsToSupport: hotelId }],
				},
				{
					$or: [
						{ role: 5000 },
						{ roles: 5000 },
						{ roleDescription: "housekeeping" },
						{ roleDescriptions: "housekeeping" },
					],
				},
			],
		}).select("_id name email role");
		res.json(staffList.map(sanitizeUserForResponse));
	} catch (err) {
		console.error(err);
		res.status(500).json({ error: "Error retrieving housekeeping staff list" });
	}
};

exports.listHotelStaffUsers = async (req, res) => {
	try {
		const { hotelId } = req.params;
		const permission = await canManageHotelStaff(req.profile, hotelId);
		if (!permission.allowed) {
			return res.status(403).json({ error: permission.error });
		}

		const staffList = await User.find({
			belongsToId: permission.ownerId,
			$and: [
				{
					$or: [
						{ hotelIdWork: permission.hotelId },
						{ hotelsToSupport: permission.hotelId },
					],
				},
				{
					$or: [
						{ role: { $in: HOTEL_STAFF_ROLES } },
						{ roles: { $in: HOTEL_STAFF_ROLES } },
					],
				},
			],
		})
			.select(
				"_id name email emailIsPlaceholder phone companyName companyOfficialName companyEin companyDocuments agentCommercialModel agentOpeningWalletCredit agentWalletOpeningBalances role roleDescription roles roleDescriptions activeUser hotelIdWork belongsToId hotelsToSupport accessTo createdAt updatedAt"
			)
			.populate("hotelsToSupport", "_id hotelName")
			.sort({ role: 1, name: 1 })
			.exec();

		return res.json(staffList.map(sanitizeUserForResponse));
	} catch (err) {
		console.error("listHotelStaffUsers error:", err);
		return res.status(500).json({ error: "Error retrieving hotel staff list" });
	}
};

exports.previewHotelStaffDashboard = async (req, res) => {
	try {
		const { hotelId, staffId } = req.params;
		const permission = await canManageHotelStaff(req.profile, hotelId);
		if (!permission.allowed) {
			return res.status(403).json({ error: permission.error });
		}
		if (!isValidObjectId(staffId)) {
			return res.status(400).json({ error: "Invalid staff id" });
		}

		const staffUser = await User.findById(staffId)
			.select(USER_AUTH_SELECT)
			.lean()
			.exec();
		if (!staffUser) {
			return res.status(400).json({ error: "Staff user was not found" });
		}
		if (staffUser.activeUser === false) {
			return res.status(403).json({ error: "This account is inactive." });
		}
		if (Number(staffUser.role) === 1000 || isConfiguredSuperAdmin(staffUser)) {
			return res
				.status(403)
				.json({ error: "Admin accounts cannot be previewed from here." });
		}

		const staffHotelIds = uniqueValidObjectIds([
			staffUser.hotelIdWork,
			...(Array.isArray(staffUser.hotelIdsWork) ? staffUser.hotelIdsWork : []),
			...(Array.isArray(staffUser.hotelsToSupport)
				? staffUser.hotelsToSupport
				: []),
		]);
		const staffRoles = [
			Number(staffUser.role),
			...(Array.isArray(staffUser.roles)
				? staffUser.roles.map((role) => Number(role))
				: []),
		];
		if (
			!staffHotelIds.includes(permission.hotelId) ||
			String(staffUser.belongsToId || "") !== permission.ownerId ||
			!staffRoles.some((role) => HOTEL_STAFF_ROLES.includes(role))
		) {
			return res.status(403).json({
				error: "This account is not scoped to the selected hotel.",
			});
		}

		const previewUser = {
			...staffUser,
			hotelIdWork: permission.hotelId,
			belongsToId: permission.ownerId,
		};
		const token = jwt.sign(
			{
				_id: staffUser._id,
				preview: true,
				previewActorId: req.profile?._id,
			},
			process.env.JWT_SECRET,
			{ expiresIn: "2h" }
		);

		return res.json({
			token,
			user: buildAuthUserPayload(previewUser),
			preview: {
				actorId: req.profile?._id,
				actorName: req.profile?.name || "",
				targetUserId: staffUser._id,
				targetName: staffUser.name || staffUser.email || "",
				hotelId: permission.hotelId,
				hotelName: permission.hotel?.hotelName || "",
				ownerId: permission.ownerId,
			},
		});
	} catch (err) {
		console.error("previewHotelStaffDashboard error:", err);
		return res.status(500).json({ error: "Unable to start account preview" });
	}
};

exports.updateHotelStaffUser = async (req, res) => {
	try {
		const { hotelId, staffId } = req.params;
		const permission = await canManageHotelStaff(req.profile, hotelId);
		if (!permission.allowed) {
			return res.status(403).json({ error: permission.error });
		}
		if (!isValidObjectId(staffId)) {
			return res.status(400).json({ error: "Invalid staff id" });
		}

		const staffUser = await User.findById(staffId).exec();
		if (!staffUser) {
			return res.status(400).json({ error: "Staff user was not found" });
		}

		const staffHotelIds = uniqueValidObjectIds([
			staffUser.hotelIdWork,
			...(Array.isArray(staffUser.hotelsToSupport)
				? staffUser.hotelsToSupport
				: []),
		]);
		const staffRoles = [
			Number(staffUser.role),
			...(Array.isArray(staffUser.roles)
				? staffUser.roles.map((role) => Number(role))
				: []),
		];
		if (
			!staffHotelIds.includes(permission.hotelId) ||
			String(staffUser.belongsToId || "") !== permission.ownerId ||
			!staffRoles.some((role) => HOTEL_STAFF_ROLES.includes(role))
		) {
			return res
				.status(403)
				.json({ error: "This staff account does not belong to this hotel" });
		}

		const payload = req.body || {};

		if ("name" in payload) {
			if (!String(payload.name || "").trim()) {
				return res.status(400).json({ error: "Name is required" });
			}
			staffUser.name = String(payload.name).trim();
		}

		if ("email" in payload) {
			const email = normalizeOptionalEmail(payload.email);
			if (email) {
				if (!validateEmailFormat(email)) {
					return res.status(400).json({ error: "Invalid email format" });
				}
				const duplicateEmail = await User.findOne({
					_id: { $ne: staffUser._id },
					email: { $regex: new RegExp("^" + escapeRegExp(email) + "$", "i") },
				}).select("_id");
				if (duplicateEmail) {
					return res.status(400).json({ error: "Email already in use" });
				}
				staffUser.email = email;
				staffUser.emailIsPlaceholder = false;
			} else {
				staffUser.email = buildStaffPlaceholderEmail(
					staffUser.phone || payload.phone || "",
					permission.hotelId
				);
				staffUser.emailIsPlaceholder = true;
			}
		}

		if ("phone" in payload) {
			const phone = cleanPhoneNumber(payload.phone || "");
			const duplicatePhone = await User.findOne({
				_id: { $ne: staffUser._id },
				phone,
			}).select("_id");
			if (duplicatePhone) {
				return res.status(400).json({ error: "Phone already in use" });
			}
			staffUser.phone = phone;
			if (staffUser.emailIsPlaceholder || isStaffPlaceholderEmail(staffUser.email)) {
				staffUser.email = buildStaffPlaceholderEmail(phone, permission.hotelId);
				staffUser.emailIsPlaceholder = true;
			}
		}

		if ("companyName" in payload) {
			staffUser.companyName = String(payload.companyName || "").trim();
		}

		if ("companyOfficialName" in payload) {
			staffUser.companyOfficialName = String(payload.companyOfficialName || "").trim();
		}

		if ("companyEin" in payload) {
			staffUser.companyEin = String(payload.companyEin || "").trim();
		}

		if ("companyDocuments" in payload) {
			staffUser.companyDocuments = sanitizeCompanyDocuments(payload.companyDocuments);
		}

		if ("agentCommercialModel" in payload) {
			staffUser.agentCommercialModel = normalizeAgentCommercialModel(
				payload.agentCommercialModel
			);
		}

		if ("agentOpeningWalletCredit" in payload) {
			staffUser.agentOpeningWalletCredit = nonNegativeMoney(
				payload.agentOpeningWalletCredit
			);
		}

		if ("agentWalletOpeningBalances" in payload && Array.isArray(payload.agentWalletOpeningBalances)) {
			const currentHotelIds = uniqueValidObjectIds([
				staffUser.hotelIdWork,
				...(Array.isArray(staffUser.hotelsToSupport)
					? staffUser.hotelsToSupport
					: []),
			]);
			staffUser.agentWalletOpeningBalances = sanitizeAgentWalletOpeningBalances(
				payload.agentWalletOpeningBalances,
				currentHotelIds.length ? currentHotelIds : [permission.hotelId],
				payload.agentOpeningWalletCredit ?? staffUser.agentOpeningWalletCredit
			);
		}

		if ("roleDescription" in payload || "role" in payload) {
			const normalizedRoleDescription = String(
				payload.roleDescription || staffUser.roleDescription || ""
			)
				.trim()
				.toLowerCase();
			const nextRole =
				Number(payload.role) ||
				ROLE_BY_DESCRIPTION[normalizedRoleDescription] ||
				Number(staffUser.role);

			if (!ROLE_BY_DESCRIPTION[normalizedRoleDescription]) {
				return res.status(400).json({ error: "Please select a valid role" });
			}
			if (ROLE_BY_DESCRIPTION[normalizedRoleDescription] !== nextRole) {
				return res
					.status(400)
					.json({ error: "Role does not match department" });
			}

			staffUser.role = nextRole;
			staffUser.roleDescription = normalizedRoleDescription;
		}

		if ("roleDescriptions" in payload && Array.isArray(payload.roleDescriptions)) {
			const normalizedRoleDescriptions = [
				...new Set(
					payload.roleDescriptions
						.map((item) => String(item || "").trim().toLowerCase())
						.filter((item) => ROLE_BY_DESCRIPTION[item])
				),
			];
			if (!normalizedRoleDescriptions.length) {
				return res.status(400).json({ error: "Please select a valid role" });
			}
			staffUser.roleDescriptions = normalizedRoleDescriptions;
			staffUser.roles = normalizedRoleDescriptions.map(
				(item) => ROLE_BY_DESCRIPTION[item]
			);
			if (!normalizedRoleDescriptions.includes(staffUser.roleDescription)) {
				staffUser.roleDescription = normalizedRoleDescriptions[0];
				staffUser.role = ROLE_BY_DESCRIPTION[normalizedRoleDescriptions[0]];
			}
		}

		if ("activeUser" in payload) {
			staffUser.activeUser = Boolean(payload.activeUser);
		}

		if (payload.password != null && payload.password !== "") {
			if (String(payload.password).length < 6) {
				return res
					.status(400)
					.json({ error: "Password should be min 6 characters long" });
			}
			staffUser.password = String(payload.password);
		}

		if ("accessTo" in payload && Array.isArray(payload.accessTo)) {
			staffUser.accessTo = payload.accessTo;
		}
		const staffRoleDescriptions = [
			String(staffUser.roleDescription || "").toLowerCase(),
			...(Array.isArray(staffUser.roleDescriptions)
				? staffUser.roleDescriptions.map((item) => String(item || "").toLowerCase())
				: []),
		];
		if (staffRoleDescriptions.includes("reservationemployee")) {
			staffUser.accessTo = [
				...new Set([
					...(Array.isArray(staffUser.accessTo) ? staffUser.accessTo : []),
					"settings",
				]),
			];
		}

		const hasHotelScopePayload =
			"hotelIdWork" in payload ||
			"hotelIdsWork" in payload ||
			"hotelsToSupport" in payload;

		if (hasHotelScopePayload) {
			const requestedHotelIds = uniqueValidObjectIds([
				payload.hotelIdWork,
				...(Array.isArray(payload.hotelIdsWork) ? payload.hotelIdsWork : []),
				...(Array.isArray(payload.hotelsToSupport)
					? payload.hotelsToSupport
					: []),
			]);
			if (!requestedHotelIds.length) {
				return res
					.status(400)
					.json({ error: "Please select at least one hotel" });
			}

			const manageableHotelIds = await getManageableStaffHotelIds(
				req.profile,
				permission
			);
			const invalidHotel = requestedHotelIds.some(
				(id) => !manageableHotelIds.includes(id)
			);
			if (invalidHotel) {
				return res
					.status(403)
					.json({ error: "You cannot assign this account to that hotel" });
			}

			staffUser.hotelIdWork = requestedHotelIds[0];
			staffUser.hotelsToSupport = requestedHotelIds;
			if (
				"agentWalletOpeningBalances" in payload ||
				"agentOpeningWalletCredit" in payload
			) {
				staffUser.agentWalletOpeningBalances = sanitizeAgentWalletOpeningBalances(
					payload.agentWalletOpeningBalances,
					requestedHotelIds,
					payload.agentOpeningWalletCredit ?? staffUser.agentOpeningWalletCredit
				);
			}
		} else if (!staffUser.hotelIdWork) {
			staffUser.hotelIdWork = permission.hotelId;
		}

		if (!Array.isArray(staffUser.hotelsToSupport) || !staffUser.hotelsToSupport.length) {
			staffUser.hotelsToSupport = [staffUser.hotelIdWork || permission.hotelId];
		}
		staffUser.belongsToId = permission.ownerId;

		const saved = await staffUser.save();
		return res.json(sanitizeUserForResponse(saved));
	} catch (err) {
		console.error("updateHotelStaffUser error:", err);
		return res
			.status(400)
			.json({ error: err.message || "Hotel staff update failed" });
	}
};

exports.allHotelAccounts = (req, res) => {
	User.find({ role: 2000 })
		.select(
			"_id name email role points activePoints likesUser activeUser employeeImage userRole history userStore userBranch hotelIdsOwner"
		)
		.populate(
			"hotelIdsOwner",
			"_id hotelName hotelCountry hotelState hotelCity hotelAddress"
		)
		.exec((err, users) => {
			if (err) return res.status(400).json({ error: "Users not found" });
			res.json(users.map(sanitizeUserForResponse));
		});
};
