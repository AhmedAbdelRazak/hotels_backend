/** @format */

"use strict";

const mongoose = require("mongoose");
const User = require("../models/user");
const HotelDetails = require("../models/hotel_details");
const {
	trackAccountCreation,
	trackAccountUpdate,
} = require("../services/activityTracker");

const ObjectId = mongoose.Types.ObjectId;

const HOTEL_ROLE_BY_DESCRIPTION = {
	systemadmin: 10000,
	hotelmanager: 2000,
	reception: 3000,
	housekeepingmanager: 4000,
	housekeeping: 5000,
	finance: 6000,
	ordertaker: 7000,
	reservationemployee: 8000,
};

const DESCRIPTION_BY_HOTEL_ROLE = Object.entries(HOTEL_ROLE_BY_DESCRIPTION).reduce(
	(acc, [description, role]) => {
		acc[role] = description;
		return acc;
	},
	{}
);

const HOTEL_ROLE_NUMBERS = Object.values(HOTEL_ROLE_BY_DESCRIPTION);

const ADMIN_PANEL_ACCESS_KEYS = new Set([
	"AdminDashboard",
	"CustomerService",
	"Integrator",
	"HotelsReservations",
	"AllReservations",
	"JannatTools",
	"JannatBookingWebsite",
	"HotelReports",
	"Financials",
	"Payouts",
	"AdminAccounts",
]);

const PLATFORM_ROLE_DESCRIPTIONS = new Set([
	"platformadmin",
	"platformstaff",
	"customerservice",
	"integrator",
	"reservations",
	"reports",
	"finance",
	"content",
	"tools",
	"payouts",
	"support",
]);

const normalizeId = (value) => String(value?._id || value?.id || value || "").trim();

const configuredSuperAdminIds = () =>
	[process.env.SUPER_ADMIN_ID, process.env.REACT_APP_SUPER_ADMIN_ID]
		.flatMap((value) => String(value || "").split(","))
		.map((id) => id.trim())
		.filter(Boolean);

const isConfiguredSuperAdmin = (userOrId) => {
	const userId =
		typeof userOrId === "object" ? userOrId?._id || userOrId?.id : userOrId;
	return configuredSuperAdminIds().includes(String(userId || "").trim());
};

const roleNumbers = (user = {}) => [
	Number(user.role),
	...(Array.isArray(user.roles) ? user.roles.map(Number) : []),
];

const accessList = (user = {}) =>
	Array.isArray(user.accessTo)
		? user.accessTo.map((item) => String(item || "").trim()).filter(Boolean)
		: [];

const hasAdminAccountsAccess = (user = {}) => {
	if (isConfiguredSuperAdmin(user)) return true;
	const roles = roleNumbers(user);
	if (!roles.includes(1000)) return false;
	const access = accessList(user);
	return access.includes("AdminAccounts");
};

const canManagePlatformAccounts = (user = {}) => isConfiguredSuperAdmin(user);

const normalizeBoolean = (value) =>
	value === true || value === "true" || value === 1 || value === "1";

const cleanPhoneNumber = (rawPhone = "") => {
	const trimmed = String(rawPhone || "").replace(/\s+/g, "");
	if (!trimmed) return "";
	const phoneRegex = /^\+?[0-9]*$/;
	if (!phoneRegex.test(trimmed)) throw new Error("Invalid phone number format");
	const plusSignCount = (trimmed.match(/\+/g) || []).length;
	if (
		plusSignCount > 1 ||
		(plusSignCount === 1 && trimmed.indexOf("+") !== 0)
	) {
		throw new Error("Invalid phone number format");
	}
	return trimmed;
};

const normalizeEmail = (value = "", { required = false } = {}) => {
	const normalized = String(value || "").trim().toLowerCase();
	if (!normalized) {
		if (required) throw new Error("Email is required");
		return "";
	}
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
		throw new Error("Invalid email format");
	}
	return normalized;
};

const buildStaffPlaceholderEmail = (phoneValue, hotelValue) => {
	const phonePart = String(phoneValue || "").replace(/[^0-9]/g, "") || "staff";
	const hotelPart = String(hotelValue || "").replace(/[^a-zA-Z0-9]/g, "");
	return `staff-${hotelPart}-${phonePart}@staff.jannatbooking.local`.toLowerCase();
};

const uniqueIds = (values = []) => [
	...new Set(
		(Array.isArray(values) ? values : [values])
			.map(normalizeId)
			.filter(Boolean)
	),
];

const validObjectIds = (values = []) =>
	uniqueIds(values).filter((id) => ObjectId.isValid(id));

const toObjectIds = (values = []) => validObjectIds(values).map((id) => ObjectId(id));

const normalizeHotelIdsFromPayload = (payload = {}) =>
	uniqueIds([
		payload.hotelIdWork,
		...(Array.isArray(payload.hotelIdsWork) ? payload.hotelIdsWork : []),
		...(Array.isArray(payload.hotelsToSupport) ? payload.hotelsToSupport : []),
		...(Array.isArray(payload.hotelIdsOwner) ? payload.hotelIdsOwner : []),
	]);

const ensureHotels = async (hotelIds = []) => {
	const ids = validObjectIds(hotelIds);
	if (!ids.length || ids.length !== uniqueIds(hotelIds).length) {
		throw new Error("Please select valid hotel(s)");
	}

	const hotels = await HotelDetails.find({ _id: { $in: ids } })
		.select("_id hotelName hotelName_OtherLanguage hotelAddress belongsTo")
		.lean()
		.exec();
	if (hotels.length !== ids.length) throw new Error("One or more hotels were not found");

	const byId = new Map(hotels.map((hotel) => [normalizeId(hotel._id), hotel]));
	const orderedHotels = ids.map((id) => byId.get(id)).filter(Boolean);
	const ownerIds = uniqueIds(orderedHotels.map((hotel) => hotel.belongsTo));
	if (ownerIds.length !== 1) {
		throw new Error("Selected hotels must belong to the same owner");
	}

	return { hotels: orderedHotels, ownerId: ownerIds[0], hotelIds: ids };
};

const ensurePlatformHotels = async (hotelIds = []) => {
	const ids = validObjectIds(hotelIds);
	if (!ids.length) return { hotels: [], hotelIds: [] };
	if (ids.length !== uniqueIds(hotelIds).length) {
		throw new Error("Please select valid hotel(s)");
	}

	const hotels = await HotelDetails.find({ _id: { $in: ids } })
		.select("_id hotelName hotelName_OtherLanguage hotelAddress belongsTo")
		.lean()
		.exec();
	if (hotels.length !== ids.length) throw new Error("One or more hotels were not found");

	const byId = new Map(hotels.map((hotel) => [normalizeId(hotel._id), hotel]));
	return {
		hotels: ids.map((id) => byId.get(id)).filter(Boolean),
		hotelIds: ids,
	};
};

const assignedHotelIdsFromUser = (user = {}) =>
	uniqueIds([
		user.hotelIdWork,
		...(Array.isArray(user.hotelIdsWork) ? user.hotelIdsWork : []),
		...(Array.isArray(user.hotelsToSupport) ? user.hotelsToSupport : []),
		...(Array.isArray(user.hotelIdsOwner) ? user.hotelIdsOwner : []),
	]);

const platformEmployeeNeedsHotelScope = (user = {}) =>
	roleNumbers(user).includes(1000) && !isConfiguredSuperAdmin(user);

const assignedHotelScopeFilter = (hotelIds = []) => {
	const ids = uniqueIds(hotelIds);
	const objectIds = toObjectIds(ids);
	return {
		$or: [
			{ hotelIdWork: { $in: ids } },
			...(objectIds.length
				? [
						{ hotelIdsWork: { $in: objectIds } },
						{ hotelsToSupport: { $in: objectIds } },
						{ hotelIdsOwner: { $in: objectIds } },
				  ]
				: []),
		],
	};
};

const ensureActorCanUseHotels = (actor = {}, hotelIds = []) => {
	if (!platformEmployeeNeedsHotelScope(actor)) return;
	const assignedIds = assignedHotelIdsFromUser(actor);
	const requestedIds = uniqueIds(hotelIds);
	if (!assignedIds.length || requestedIds.some((id) => !assignedIds.includes(id))) {
		throw new Error("You can only manage accounts for hotels assigned to you");
	}
};

const accountHotelIds = (account = {}) =>
	uniqueIds([
		account.hotelIdWork,
		...(Array.isArray(account.hotelIdsWork) ? account.hotelIdsWork : []),
		...(Array.isArray(account.hotelsToSupport) ? account.hotelsToSupport : []),
		...(Array.isArray(account.hotelIdsOwner) ? account.hotelIdsOwner : []),
	]);

const ensureActorCanManageAccount = (actor = {}, account = {}) => {
	if (!platformEmployeeNeedsHotelScope(actor)) return;
	const assignedIds = assignedHotelIdsFromUser(actor);
	const targetIds = accountHotelIds(account);
	const canSeeTarget = targetIds.some((id) => assignedIds.includes(id));
	if (!assignedIds.length || !canSeeTarget) {
		throw new Error("You can only manage accounts for hotels assigned to you");
	}
};

const normalizeHotelRoleDescriptions = (payload = {}) => {
	const incoming = [
		...(Array.isArray(payload.roleDescriptions) ? payload.roleDescriptions : []),
		payload.roleDescription,
		...(Array.isArray(payload.roles)
			? payload.roles.map((role) => DESCRIPTION_BY_HOTEL_ROLE[Number(role)])
			: []),
		payload.role ? DESCRIPTION_BY_HOTEL_ROLE[Number(payload.role)] : "",
	]
		.map((item) => String(item || "").trim().toLowerCase())
		.filter(Boolean);

	const descriptions = [...new Set(incoming.length ? incoming : ["reception"])];
	const invalid = descriptions.find((description) => !HOTEL_ROLE_BY_DESCRIPTION[description]);
	if (invalid) throw new Error("Please select a valid hotel role");

	const primary = descriptions.includes("systemadmin")
		? "systemadmin"
		: descriptions.includes("hotelmanager")
		? "hotelmanager"
		: descriptions[0];

	return {
		roleDescription: primary,
		role: HOTEL_ROLE_BY_DESCRIPTION[primary],
		roleDescriptions: descriptions,
		roles: descriptions.map((description) => HOTEL_ROLE_BY_DESCRIPTION[description]),
	};
};

const normalizeHotelAccess = (roleDescriptions = [], accessTo = []) => {
	const requested = Array.isArray(accessTo)
		? accessTo.map((item) => String(item || "").trim()).filter(Boolean)
		: [];
	const merged = [...requested];

	if (roleDescriptions.includes("systemadmin")) {
		merged.push(
			"overall",
			"dashboard",
			"reservations",
			"newReservation",
			"reports",
			"finance",
			"housekeeping",
			"settings"
		);
	}
	if (roleDescriptions.includes("reservationemployee")) merged.push("settings");
	if (roleDescriptions.includes("ordertaker")) {
		merged.push("newReservation", "ownReservations");
	}

	return [...new Set(merged)];
};

const normalizeAdminAccess = (accessTo = []) => {
	const cleaned = (Array.isArray(accessTo) ? accessTo : [])
		.map((item) => String(item || "").trim())
		.filter((item) => ADMIN_PANEL_ACCESS_KEYS.has(item));
	return [...new Set(cleaned.length ? cleaned : ["AdminDashboard"])];
};

const normalizePlatformRoleDescription = (value = "") => {
	const normalized = String(value || "platformstaff")
		.trim()
		.toLowerCase()
		.replace(/[\s_-]+/g, "");
	return PLATFORM_ROLE_DESCRIPTIONS.has(normalized) ? normalized : "platformstaff";
};

const duplicateQuery = ({ email, phone, excludeId = "" }) => {
	const checks = [];
	if (email) checks.push({ email: { $regex: new RegExp(`^${escapeRegExp(email)}$`, "i") } });
	if (phone) checks.push({ phone });
	if (!checks.length) return null;
	return {
		...(excludeId ? { _id: { $ne: excludeId } } : {}),
		$or: checks,
	};
};

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const ensureNoDuplicate = async ({ email, phone, excludeId = "" }) => {
	const query = duplicateQuery({ email, phone, excludeId });
	if (!query) return;
	const existing = await User.findOne(query).select("_id").lean().exec();
	if (existing) {
		throw new Error("User already exists, please try a different email/phone");
	}
};

const hotelFilter = () => ({
	$and: [
		{
			$or: [
				{ role: { $in: HOTEL_ROLE_NUMBERS } },
				{ roles: { $in: HOTEL_ROLE_NUMBERS } },
				{ hotelIdWork: { $nin: ["", null] } },
				{ hotelIdsWork: { $exists: true, $ne: [] } },
				{ hotelsToSupport: { $exists: true, $ne: [] } },
				{ hotelIdsOwner: { $exists: true, $ne: [] } },
			],
		},
		{ accountScope: { $ne: "platform" } },
		{ platformEmployee: { $ne: true } },
		{ role: { $ne: 1000 } },
		{ roles: { $nin: [1000] } },
		{ roleDescription: { $nin: [...PLATFORM_ROLE_DESCRIPTIONS] } },
		{ roleDescriptions: { $nin: [...PLATFORM_ROLE_DESCRIPTIONS] } },
	],
});

const platformFilter = () => ({
	$or: [
		{ accountScope: "platform" },
		{ platformEmployee: true },
		{ roleDescription: { $in: [...PLATFORM_ROLE_DESCRIPTIONS] } },
		{ roleDescriptions: { $in: [...PLATFORM_ROLE_DESCRIPTIONS] } },
		{ role: 1000 },
		{ roles: 1000 },
	],
});

const accountLooksPlatform = (account = {}) => {
	const descriptions = [
		String(account.roleDescription || "").toLowerCase(),
		...(Array.isArray(account.roleDescriptions)
			? account.roleDescriptions.map((item) => String(item || "").toLowerCase())
			: []),
	];
	return (
		account.accountScope === "platform" ||
		account.platformEmployee === true ||
		roleNumbers(account).includes(1000) ||
		descriptions.some((description) => PLATFORM_ROLE_DESCRIPTIONS.has(description))
	);
};

const firstPlatformRoleDescription = (account = {}) => {
	const descriptions = [
		String(account.platformEmployeeType || "").toLowerCase(),
		String(account.roleDescription || "").toLowerCase(),
		...(Array.isArray(account.roleDescriptions)
			? account.roleDescriptions.map((item) => String(item || "").toLowerCase())
			: []),
	];
	return (
		descriptions.find((description) =>
			PLATFORM_ROLE_DESCRIPTIONS.has(description)
		) || "platformstaff"
	);
};

const sanitizeAccount = (account = {}) => {
	const plain =
		typeof account.toObject === "function" ? account.toObject() : { ...account };
	delete plain.hashed_password;
	delete plain.salt;
	if (accountLooksPlatform(plain)) {
		const platformRole = firstPlatformRoleDescription(plain);
		plain.accountScope = "platform";
		plain.platformEmployee = true;
		plain.platformEmployeeType = platformRole;
		if (!plain.roleDescription || Number(plain.roleDescription) === 1000) {
			plain.roleDescription = platformRole;
		}
		if (
			!Array.isArray(plain.roleDescriptions) ||
			!plain.roleDescriptions.length ||
			plain.roleDescriptions.every((role) => Number(role) === 1000)
		) {
			plain.roleDescriptions = [platformRole];
		}
	} else {
		plain.accountScope = "hotel";
		plain.platformEmployee = false;
		plain.platformEmployeeType = "";
	}
	return plain;
};

const sanitizedHotels = (hotels = []) =>
	hotels.map((hotel) => ({
		_id: hotel._id,
		hotelName: hotel.hotelName,
		hotelName_OtherLanguage: hotel.hotelName_OtherLanguage,
		belongsTo: hotel.belongsTo,
	}));

exports.listAdminAccounts = async (req, res) => {
	try {
		if (!hasAdminAccountsAccess(req.profile)) {
			return res.status(403).json({ error: "Admin accounts access denied" });
		}

		const canSeePlatform = canManagePlatformAccounts(req.profile);
		const mustApplyHotelScope = platformEmployeeNeedsHotelScope(req.profile);
		const scopedHotelIds = platformEmployeeNeedsHotelScope(req.profile)
			? assignedHotelIdsFromUser(req.profile)
			: [];
		const requestedScope = String(req.query.scope || "hotel").toLowerCase();
		const scope =
			requestedScope === "platform" && !canSeePlatform
				? "hotel"
				: ["hotel", "platform", "all"].includes(requestedScope)
				? requestedScope
				: "hotel";

		const page = Math.max(Number(req.query.page || 1), 1);
		const limit = Math.min(Math.max(Number(req.query.limit || 25), 1), 100);
		const filters = [];
		const configuredAdminObjectIds = configuredSuperAdminIds()
			.filter((id) => ObjectId.isValid(id))
			.map((id) => ObjectId(id));
		if (configuredAdminObjectIds.length) {
			filters.push({ _id: { $nin: configuredAdminObjectIds } });
		}

		if (scope === "hotel") filters.push(hotelFilter());
		if (scope === "platform") filters.push(platformFilter());
		if (scope === "all") filters.push({ $or: [hotelFilter(), platformFilter()] });
		if (mustApplyHotelScope) {
			if (!scopedHotelIds.length) {
				filters.push({ _id: null });
			} else {
				filters.push(assignedHotelScopeFilter(scopedHotelIds));
			}
		}

		const hotelId = normalizeId(req.query.hotelId);
		if (hotelId && ObjectId.isValid(hotelId)) {
			if (scopedHotelIds.length && !scopedHotelIds.includes(hotelId)) {
				filters.push({ _id: null });
			}
			const hotelObjectId = ObjectId(hotelId);
			filters.push({
				$or: [
					{ hotelIdWork: hotelId },
					{ hotelIdsWork: hotelObjectId },
					{ hotelsToSupport: hotelObjectId },
					{ hotelIdsOwner: hotelObjectId },
				],
			});
		}

		const status = String(req.query.status || "").toLowerCase();
		if (status === "active") filters.push({ activeUser: { $ne: false } });
		if (status === "inactive") filters.push({ activeUser: false });

		const role = String(req.query.role || "").trim().toLowerCase();
		if (role) {
			const roleNumber = Number(role);
			filters.push({
				$or: [
					...(Number.isFinite(roleNumber) && roleNumber > 0
						? [{ role: roleNumber }, { roles: roleNumber }]
						: []),
					{ roleDescription: role },
					{ roleDescriptions: role },
				],
			});
		}

		const search = String(req.query.search || "").trim();
		if (search) {
			const regex = new RegExp(escapeRegExp(search), "i");
			filters.push({
				$or: [
					{ name: regex },
					{ email: regex },
					{ phone: regex },
					{ companyName: regex },
					{ roleDescription: regex },
				],
			});
		}

		const query = filters.length ? { $and: filters } : {};
		const [accounts, total, hotels] = await Promise.all([
			User.find(query)
				.select(
					"_id name email emailIsPlaceholder phone companyName companyOfficialName agentCommercialModel agentPayoutDetails role roleDescription roles roleDescriptions activeUser hotelIdWork hotelIdsWork belongsToId hotelIdsOwner hotelsToSupport accessTo accountScope platformEmployee platformEmployeeType createdAt updatedAt"
				)
				.populate("hotelIdsWork", "_id hotelName hotelName_OtherLanguage belongsTo")
				.populate("hotelsToSupport", "_id hotelName hotelName_OtherLanguage belongsTo")
				.populate("hotelIdsOwner", "_id hotelName hotelName_OtherLanguage belongsTo")
				.sort({ accountScope: -1, role: 1, name: 1 })
				.skip((page - 1) * limit)
				.limit(limit)
				.exec(),
			User.countDocuments(query),
			HotelDetails.find(
				mustApplyHotelScope
					? scopedHotelIds.length
						? { _id: { $in: toObjectIds(scopedHotelIds) } }
						: { _id: null }
					: {}
			)
				.select("_id hotelName hotelName_OtherLanguage belongsTo")
				.sort({ hotelName: 1 })
				.lean()
				.exec(),
		]);

		return res.json({
			accounts: accounts.map(sanitizeAccount),
			hotels: sanitizedHotels(hotels),
			page,
			limit,
			total,
			pages: Math.max(Math.ceil(total / limit), 1),
			scope,
			canManagePlatform: canSeePlatform,
		});
	} catch (error) {
		console.error("listAdminAccounts error:", error);
		return res.status(500).json({ error: "Error retrieving admin accounts" });
	}
};

exports.createAdminHotelStaffAccount = async (req, res) => {
	try {
		if (!hasAdminAccountsAccess(req.profile)) {
			return res.status(403).json({ error: "Admin accounts access denied" });
		}

		const payload = req.body || {};
		const hotelIds = normalizeHotelIdsFromPayload(payload);
		ensureActorCanUseHotels(req.profile, hotelIds);
		const { hotels, ownerId, hotelIds: validHotelIds } = await ensureHotels(hotelIds);
		const primaryHotel = hotels[0];
		const roleInfo = normalizeHotelRoleDescriptions(payload);
		const name = String(payload.name || "").trim();
		const password = String(payload.password || "");
		const phone = cleanPhoneNumber(payload.phone || "");
		const email = normalizeEmail(payload.email || "", { required: false });

		if (!name || !password || !phone) {
			return res.status(400).json({ error: "Name, password, phone, and hotel are required" });
		}
		if (password.length < 6) {
			return res.status(400).json({ error: "Password should be 6 characters or more" });
		}
		await ensureNoDuplicate({ email, phone });

		const isSystemAdmin = roleInfo.roleDescriptions.includes("systemadmin");
		const staffEmail = email || buildStaffPlaceholderEmail(phone, validHotelIds[0]);
		const staffUser = new User({
			name,
			email: staffEmail,
			emailIsPlaceholder: !email,
			password,
			phone,
			role: roleInfo.role,
			roleDescription: roleInfo.roleDescription,
			roles: roleInfo.roles,
			roleDescriptions: roleInfo.roleDescriptions,
			hotelName: primaryHotel.hotelName || "",
			hotelAddress: primaryHotel.hotelAddress || "",
			hotelIdWork: validHotelIds[0],
			hotelIdsWork: validHotelIds,
			hotelsToSupport: validHotelIds,
			hotelIdsOwner: isSystemAdmin ? validHotelIds : [],
			belongsToId: isSystemAdmin ? "" : ownerId,
			activeUser: "activeUser" in payload ? normalizeBoolean(payload.activeUser) : true,
			accessTo: normalizeHotelAccess(roleInfo.roleDescriptions, payload.accessTo),
			accountScope: "hotel",
			platformEmployee: false,
			platformEmployeeType: "",
			createdByAdmin: req.profile?._id || null,
		});

		await staffUser.save();
		await trackAccountCreation({
			req,
			actor: req.profile,
			account: staffUser,
			source: "admin_accounts_hotel_staff_create",
			hotelId: validHotelIds[0],
			ownerId,
			hotelIds: validHotelIds,
			ownerIds: [ownerId],
		});

		return res.json({
			message: "Hotel staff account created successfully",
			account: sanitizeAccount(staffUser),
		});
	} catch (error) {
		console.error("createAdminHotelStaffAccount error:", error);
		return res.status(400).json({ error: error.message || "Hotel staff account creation failed" });
	}
};

exports.createAdminPlatformStaffAccount = async (req, res) => {
	try {
		if (!canManagePlatformAccounts(req.profile)) {
			return res.status(403).json({ error: "Only configured super admins can create platform employees" });
		}

		const payload = req.body || {};
		const name = String(payload.name || "").trim();
		const password = String(payload.password || "");
		const email = normalizeEmail(payload.email || "", { required: true });
		const phone = cleanPhoneNumber(payload.phone || "");
		const platformRole = normalizePlatformRoleDescription(payload.roleDescription);
		const platformHotelIds = normalizeHotelIdsFromPayload(payload);
		const { hotels, hotelIds } = await ensurePlatformHotels(platformHotelIds);
		const primaryHotel = hotels[0] || null;

		if (!name || !password) {
			return res.status(400).json({ error: "Name, email, and password are required" });
		}
		if (password.length < 6) {
			return res.status(400).json({ error: "Password should be 6 characters or more" });
		}
		await ensureNoDuplicate({ email, phone });

		const staffUser = new User({
			name,
			email,
			emailIsPlaceholder: false,
			password,
			phone,
			role: 1000,
			roleDescription: platformRole,
			roles: [1000],
			roleDescriptions: [platformRole],
			activeUser: "activeUser" in payload ? normalizeBoolean(payload.activeUser) : true,
			accessTo: normalizeAdminAccess(payload.accessTo),
			accountScope: "platform",
			platformEmployee: true,
			platformEmployeeType: platformRole,
			hotelName: primaryHotel?.hotelName || "",
			hotelAddress: primaryHotel?.hotelAddress || "",
			hotelIdWork: hotelIds[0] || "",
			hotelIdsWork: hotelIds,
			hotelsToSupport: hotelIds,
			hotelIdsOwner: [],
			belongsToId: "",
			createdByAdmin: req.profile?._id || null,
		});

		await staffUser.save();
		await trackAccountCreation({
			req,
			actor: req.profile,
			account: staffUser,
			source: "admin_accounts_platform_staff_create",
			hotelId: hotelIds[0] || null,
			hotelIds,
			ownerIds: uniqueIds(hotels.map((hotel) => hotel.belongsTo)),
		});

		return res.json({
			message: "Platform employee account created successfully",
			account: sanitizeAccount(staffUser),
		});
	} catch (error) {
		console.error("createAdminPlatformStaffAccount error:", error);
		return res.status(400).json({ error: error.message || "Platform employee account creation failed" });
	}
};

exports.updateAdminAccount = async (req, res) => {
	try {
		if (!hasAdminAccountsAccess(req.profile)) {
			return res.status(403).json({ error: "Admin accounts access denied" });
		}

		const accountId = normalizeId(req.params.accountId);
		if (!ObjectId.isValid(accountId)) {
			return res.status(400).json({ error: "Invalid account id" });
		}

		const account = await User.findById(accountId).exec();
		if (!account) return res.status(404).json({ error: "Account was not found" });
		if (isConfiguredSuperAdmin(account)) {
			return res.status(403).json({ error: "Configured super admin accounts cannot be updated here" });
		}
		ensureActorCanManageAccount(req.profile, account);

		const payload = req.body || {};
		const nextScope = String(payload.accountScope || account.accountScope || "").toLowerCase();
		const targetIsPlatform =
			nextScope === "platform" || accountLooksPlatform(account) || payload.platformEmployee === true;
		if (targetIsPlatform && !canManagePlatformAccounts(req.profile)) {
			return res.status(403).json({ error: "Only configured super admins can update platform employees" });
		}

		const before = account.toObject({ depopulate: true });

		if ("name" in payload) {
			const name = String(payload.name || "").trim();
			if (!name) return res.status(400).json({ error: "Name is required" });
			account.name = name;
		}

		const emailProvided = "email" in payload;
		const phoneProvided = "phone" in payload;
		const nextPhone = phoneProvided ? cleanPhoneNumber(payload.phone || "") : account.phone || "";
		const nextEmail = emailProvided
			? normalizeEmail(payload.email || "", { required: targetIsPlatform })
			: account.email || "";
		await ensureNoDuplicate({
			email: nextEmail,
			phone: nextPhone,
			excludeId: accountId,
		});

		if (phoneProvided) account.phone = nextPhone;
		if (emailProvided) {
			if (nextEmail) {
				account.email = nextEmail;
				account.emailIsPlaceholder = false;
			} else {
				const hotelId = normalizeId(account.hotelIdWork) || normalizeId(payload.hotelIdWork);
				account.email = buildStaffPlaceholderEmail(nextPhone || account.phone, hotelId);
				account.emailIsPlaceholder = true;
			}
		}

		if (payload.password != null && payload.password !== "") {
			const password = String(payload.password);
			if (password.length < 6) {
				return res.status(400).json({ error: "Password should be 6 characters or more" });
			}
			account.password = password;
		}
		if ("activeUser" in payload) account.activeUser = normalizeBoolean(payload.activeUser);

		if (targetIsPlatform) {
			const platformRole = normalizePlatformRoleDescription(
				payload.roleDescription || account.roleDescription
			);
			account.role = 1000;
			account.roleDescription = platformRole;
			account.roles = [1000];
			account.roleDescriptions = [platformRole];
			account.accessTo = normalizeAdminAccess(
				"accessTo" in payload ? payload.accessTo : account.accessTo
			);
			account.accountScope = "platform";
			account.platformEmployee = true;
			account.platformEmployeeType = platformRole;
			if (
				"hotelIdWork" in payload ||
				"hotelIdsWork" in payload ||
				"hotelsToSupport" in payload ||
				"hotelIdsOwner" in payload
			) {
				const platformHotelIds = normalizeHotelIdsFromPayload(payload);
				const { hotels, hotelIds } = await ensurePlatformHotels(platformHotelIds);
				const primaryHotel = hotels[0] || null;
				account.hotelName = primaryHotel?.hotelName || "";
				account.hotelAddress = primaryHotel?.hotelAddress || "";
				account.hotelIdWork = hotelIds[0] || "";
				account.hotelIdsWork = hotelIds;
				account.hotelsToSupport = hotelIds;
			}
			account.hotelIdsOwner = [];
			account.belongsToId = "";
		} else {
			const roleInfo =
				"roleDescription" in payload || "roleDescriptions" in payload || "role" in payload
					? normalizeHotelRoleDescriptions(payload)
					: normalizeHotelRoleDescriptions(account);
			account.role = roleInfo.role;
			account.roleDescription = roleInfo.roleDescription;
			account.roles = roleInfo.roles;
			account.roleDescriptions = roleInfo.roleDescriptions;
			account.accessTo = normalizeHotelAccess(
				roleInfo.roleDescriptions,
				"accessTo" in payload ? payload.accessTo : account.accessTo
			);

			if (
				"hotelIdWork" in payload ||
				"hotelIdsWork" in payload ||
				"hotelsToSupport" in payload ||
				"hotelIdsOwner" in payload
			) {
				const hotelIds = normalizeHotelIdsFromPayload(payload);
				ensureActorCanUseHotels(req.profile, hotelIds);
				const { hotels, ownerId, hotelIds: validHotelIds } = await ensureHotels(hotelIds);
				const primaryHotel = hotels[0];
				const isSystemAdmin = roleInfo.roleDescriptions.includes("systemadmin");
				account.hotelName = primaryHotel.hotelName || account.hotelName || "";
				account.hotelAddress = primaryHotel.hotelAddress || account.hotelAddress || "";
				account.hotelIdWork = validHotelIds[0];
				account.hotelIdsWork = validHotelIds;
				account.hotelsToSupport = validHotelIds;
				account.hotelIdsOwner = isSystemAdmin ? validHotelIds : [];
				account.belongsToId = isSystemAdmin ? "" : ownerId;
			}
			account.accountScope = "hotel";
			account.platformEmployee = false;
			account.platformEmployeeType = "";
		}

		account.updatedByAdmin = req.profile?._id || null;
		const saved = await account.save();

		await trackAccountUpdate({
			req,
			actor: req.profile,
			accountBefore: before,
			accountAfter: saved,
			source: targetIsPlatform
				? "admin_accounts_platform_staff_update"
				: "admin_accounts_hotel_staff_update",
			hotelIds: uniqueIds([
				saved.hotelIdWork,
				...(Array.isArray(saved.hotelIdsWork) ? saved.hotelIdsWork : []),
				...(Array.isArray(saved.hotelsToSupport) ? saved.hotelsToSupport : []),
				...(Array.isArray(saved.hotelIdsOwner) ? saved.hotelIdsOwner : []),
			]),
			ownerIds: uniqueIds([saved.belongsToId]),
		});

		return res.json({
			message: "Account updated successfully",
			account: sanitizeAccount(saved),
		});
	} catch (error) {
		console.error("updateAdminAccount error:", error);
		return res.status(400).json({ error: error.message || "Account update failed" });
	}
};
