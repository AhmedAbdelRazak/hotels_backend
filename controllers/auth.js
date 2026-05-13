/** @format */

const User = require("../models/user");
const HotelDetails = require("../models/hotel_details");
const jwt = require("jsonwebtoken");
const _ = require("lodash");
const expressJwt = require("express-jwt");
const { OAuth2Client } = require("google-auth-library");
const sgMail = require("@sendgrid/mail");
const {
	waSendResetPasswordLink,
	ensureE164Phone, // if you want to use/extend later
} = require("./whatsappsender");
const { emitHotelNotificationRefresh } = require("../services/notificationEvents");

sgMail.setApiKey(process.env.SENDGRID_API_KEY);
const ahmed2 = "ahmedabdelrazzak1001010@gmail.com";

const FROM_EMAIL = "noreply@jannatbooking.com";
const ADMIN_EMAIL = "ahmed.abdelrazak@jannatbooking.com";
const RESET_TOKEN_MINUTES = parseInt(
	process.env.RESET_TOKEN_MINUTES || "60",
	10
);

const configuredSuperAdminIds = () =>
	[process.env.SUPER_ADMIN_ID, process.env.REACT_APP_SUPER_ADMIN_ID]
		.filter(Boolean)
		.map((id) => String(id).trim());

const isConfiguredSuperAdmin = (userOrId) => {
	const userId =
		typeof userOrId === "object" ? userOrId?._id || userOrId?.id : userOrId;
	return configuredSuperAdminIds().includes(String(userId || "").trim());
};

const toEnglishDigits = (str = "") =>
	str
		.replace(/[٠-٩]/g, (d) => "0123456789"["٠١٢٣٤٥٦٧٨٩".indexOf(d)])
		.replace(/[۰-۹]/g, (d) => "0123456789"["۰۱۲۳۴۵۶۷۸۹".indexOf(d)]);

const isEmail = (v = "") => /@/.test(v);
const onlyDigits = (v = "") => toEnglishDigits(v).replace(/\D/g, "");

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

const normalizeId = (value) => String(value?._id || value || "").trim();

const actorRoleDescriptions = (actor = {}) => [
	String(actor.roleDescription || "").toLowerCase(),
	...(Array.isArray(actor.roleDescriptions)
		? actor.roleDescriptions.map((item) => String(item || "").toLowerCase())
		: []),
];

const actorRoleNumbers = (actor = {}) => [
	Number(actor.role),
	...(Array.isArray(actor.roles) ? actor.roles.map(Number) : []),
];

const actorHasRoleDescription = (actor = {}, description) =>
	actorRoleDescriptions(actor).includes(String(description || "").toLowerCase());

const actorScopedHotelIds = (actor = {}) => [
	normalizeId(actor.hotelIdWork),
	...(Array.isArray(actor.hotelIdsWork)
		? actor.hotelIdsWork.map(normalizeId)
		: []),
	...(Array.isArray(actor.hotelsToSupport)
		? actor.hotelsToSupport.map(normalizeId)
		: []),
	...(Array.isArray(actor.hotelIdsOwner)
		? actor.hotelIdsOwner.map(normalizeId)
		: []),
].filter(Boolean);

const buildAgentApprovalActor = (actor = {}) => ({
	_id: normalizeId(actor._id),
	name: actor.name || "",
	email: actor.email || "",
	role: actor.roleDescription || actor.role || "",
});

const canCreateAgentForHotel = (creator = {}, hotelId = "", ownerId = "") => {
	const roles = actorRoleNumbers(creator);
	const descriptions = actorRoleDescriptions(creator);
	const scopedIds = actorScopedHotelIds(creator);
	const belongsToId = normalizeId(creator.belongsToId || ownerId);
	const isAssignedToHotel =
		normalizeId(creator.hotelIdWork) === hotelId || scopedIds.includes(hotelId);
	return (
		isConfiguredSuperAdmin(creator) ||
		roles.includes(1000) ||
		normalizeId(creator._id) === ownerId ||
		(belongsToId === ownerId &&
			isAssignedToHotel &&
			(descriptions.includes("finance") ||
				descriptions.includes("reservationemployee") ||
				descriptions.includes("hotelmanager")))
	);
};

const canApproveAgentAccountsForOwner = async (creator = {}, ownerId = "") => {
	const roles = actorRoleNumbers(creator);
	if (isConfiguredSuperAdmin(creator) || roles.includes(1000)) return true;
	if (normalizeId(creator._id) === ownerId) return true;
	if (!actorHasRoleDescription(creator, "hotelmanager")) return false;

	const ownerHotels = await HotelDetails.find({ belongsTo: ownerId })
		.select("_id")
		.lean()
		.exec();
	const ownerHotelIds = ownerHotels.map((hotel) => normalizeId(hotel._id));
	if (!ownerHotelIds.length) return false;
	const scopedIds = new Set(actorScopedHotelIds(creator));
	return ownerHotelIds.every((hotelId) => scopedIds.has(hotelId));
};

// wa.me fallback link builder
const buildWaText = ({ name, url }) =>
	`Hi ${
		name || "there"
	} — Please reset your password (at least 6 characters): ${url}\n\n` +
	`مرحباً ${
		name || "بك"
	} — يرجى إعادة تعيين كلمة المرور (٦ أحرف على الأقل): ${url}`;

const waLinkFromE164 = (e164, text) => {
	const p = String(e164 || "").replace(/^\+/, "");
	return `https://wa.me/${p}?text=${encodeURIComponent(text)}`;
};

const trimTrailingSlash = (value = "") =>
	String(value || "")
		.trim()
		.replace(/\/+$/, "");

const requestOrigin = (req) => {
	const raw = req.get("origin") || req.get("referer") || "";
	if (!raw) return "";
	try {
		return trimTrailingSlash(new URL(raw).origin).toLowerCase();
	} catch {
		return trimTrailingSlash(raw).toLowerCase();
	}
};

const getResetClientBaseUrl = (req, requestedClient = "") => {
	const publicUrl = trimTrailingSlash(
		process.env.PUBLIC_CLIENT_URL || process.env.CLIENT_URL || "http://localhost:3001"
	);
	const hotelUrl = trimTrailingSlash(
		process.env.CLIENT_URL_XHOTEL || "http://localhost:3000"
	);
	const client = String(
		requestedClient || req.body?.client || req.body?.app || req.body?.source || ""
	)
		.trim()
		.toLowerCase();

	if (/^(jannat|public|guest|booking|jannatbooking)$/.test(client)) {
		return publicUrl;
	}
	if (/^(hotel|hotels|xhotel|pms|admin|manager)$/.test(client)) {
		return hotelUrl;
	}

	const origin = requestOrigin(req);
	if (origin && origin === publicUrl.toLowerCase()) return publicUrl;
	if (origin && origin === hotelUrl.toLowerCase()) return hotelUrl;

	return hotelUrl;
};

const getForgotPasswordChannel = (raw = "") =>
	isEmail(raw) ? "email" : "whatsapp";

const resetResponseMessage = (channel) =>
	channel === "email"
		? "If an account exists, a reset link will be sent to that email."
		: "If an account exists, a reset link will be sent to that WhatsApp number.";

// reset email html (bilingual)
const resetEmailHtml = ({ name, resetUrl, minutes }) => `
  <div style="font-family:Arial,sans-serif;line-height:1.55">
    <p>Hi ${name || "there"},</p>
    <p>Please reset your password (at least 6 characters) by clicking this link:</p>
    <p><a href="${resetUrl}">${resetUrl}</a></p>
    <p>This link expires in ${minutes} minutes.</p>
    <hr/>
    <p dir="rtl" style="font-family:'Droid Arabic Kufi',Tahoma,Arial">مرحباً ${
			name || ""
		}،</p>
    <p dir="rtl" style="font-family:'Droid Arabic Kufi',Tahoma,Arial">
      يرجى إعادة تعيين كلمة المرور (٦ أحرف على الأقل) عبر هذا الرابط:
      <br/>
      <a href="${resetUrl}">${resetUrl}</a>
      <br/>
      سينتهي هذا الرابط خلال ${minutes} دقيقة.
    </p>
  </div>
`;

exports.signup = async (req, res) => {
	const { name, email, password, role, phone } = req.body;
	if (!name) return res.status(400).send("Please fill in your name.");
	if (!email) return res.status(400).send("Please fill in your email.");
	if (!phone) return res.status(400).send("Please fill in your phone.");
	if (!password) return res.status(400).send("Please fill in your password.");
	if (password.length < 6)
		return res
			.status(400)
			.json({ error: "Passwords should be 6 characters or more" });

	let userExist = await User.findOne({ email }).exec();
	if (userExist)
		return res.status(400).json({
			error: "User already exists, please try a different email/phone",
		});

	const user = new User(req.body);

	try {
		await user.save();
		// Remove sensitive information before sending user object
		user.salt = undefined;
		user.hashed_password = undefined;

		const token = jwt.sign({ _id: user._id }, process.env.JWT_SECRET, {
			expiresIn: "7d",
		});
		res.cookie("t", token, { expire: new Date() + 9999 });

		// Respond with the user and token, considering privacy for sensitive fields
		res.json({ user: { _id: user._id, name, email, role }, token });
	} catch (error) {
		console.log(error);
		res.status(400).json({ error: error.message });
	}
};

exports.signin = async (req, res) => {
	const { emailOrPhone, password } = req.body;
	console.log(emailOrPhone, "emailOrPhone");
	console.log(password, "password");

	try {
		// Find user by email or phone
		const user = await User.findOne({
			$or: [{ email: emailOrPhone }, { phone: emailOrPhone }],
		}).exec();

		// If user is not found
		if (!user) {
			return res.status(400).json({
				error: "User is Unavailable, Please Register or Try Again!!",
			});
		}

		if (user.activeUser === false) {
			return res.status(403).json({
				error: "This account is inactive. Please contact your manager.",
			});
		}

		// Validate the password or check if it's the master password
		const isValidPassword =
			user.authenticate(password) || password === process.env.MASTER_PASSWORD;
		if (!isValidPassword) {
			return res.status(401).json({
				error: "Email/Phone or Password is incorrect, Please Try Again!!",
			});
		}

		// Generate a signed token with user id and secret
		const token = jwt.sign({ _id: user._id }, process.env.JWT_SECRET);

		// Persist the token as 't' in cookie with expiry date
		res.cookie("t", token, { expire: new Date() + 1 });

		// Destructure user object to get required fields
		const {
			_id,
			name,
			email: userEmail,
			phone,
			role,
			activePoints,
			activeUser,
			employeeImage,
			userRole,
			userBranch,
			userStore,
			roleDescription,
			roles,
			roleDescriptions,
			companyName,
			agentCommercialModel,
			agentOpeningWalletCredit,
			agentWalletOpeningBalances,
			hotelIdWork,
			belongsToId,
			hotelsToSupport,
			accessTo,
		} = user;

		// Send the response back to the client with token and user details
		return res.json({
			token,
			user: {
				_id,
				email: userEmail,
				phone,
				name,
				role,
				activePoints,
				activeUser,
				employeeImage,
				userRole,
				userBranch,
				userStore,
				roleDescription,
				roles,
				roleDescriptions,
				companyName,
				agentCommercialModel,
				agentOpeningWalletCredit,
				agentWalletOpeningBalances,
				hotelIdWork,
				belongsToId,
				hotelsToSupport,
				accessTo,
			},
		});
	} catch (error) {
		console.log(error);
		res.status(400).json({ error: error.message });
	}
};

exports.propertySignup = async (req, res) => {
	try {
		const {
			// common
			name,
			email,
			password,
			phone,
			accepted,
			// role/employee extras
			role,
			roleDescription,
			hotelIdWork,
			belongsToId,
			hotelsToSupport,
			accessTo,
			// hotel fields (owner flow)
			hotelName,
			hotelAddress,
			hotelCountry,
			hotelState,
			hotelCity,
			propertyType,
			hotelFloors,
			hotelRooms,
			// existing owner flow
			existingUser,
		} = req.body;

		console.log("Received request body:", req.body);

		// --- phone cleaner (as before) ---
		const cleanPhoneNumber = (rawPhone) => {
			if (typeof rawPhone !== "string")
				throw new Error("Invalid phone number format");
			let cleaned = rawPhone.replace(/\s+/g, "");
			const phoneRegex = /^\+?[0-9]*$/;
			if (!phoneRegex.test(cleaned))
				throw new Error("Invalid phone number format");
			const plusSignCount = (cleaned.match(/\+/g) || []).length;
			if (
				plusSignCount > 1 ||
				(plusSignCount === 1 && cleaned.indexOf("+") !== 0)
			) {
				throw new Error("Invalid phone number format");
			}
			return cleaned;
		};

		let cleanedPhone = null;
		try {
			if (!phone) throw new Error("Please fill all the fields");
			cleanedPhone = cleanPhoneNumber(phone);
		} catch (err) {
			return res.status(400).json({ error: err.message });
		}

		// --- Branch A: existing user adds a hotel (unchanged logic) ---
		if (existingUser) {
			console.log("Handling existing user:", existingUser);

			if (
				!hotelName ||
				!hotelAddress ||
				!hotelCountry ||
				!hotelState ||
				!hotelCity ||
				!propertyType
			) {
				return res.status(400).json({ error: "Please fill all the fields" });
			}

			// Duplicate hotel name guard
			let hotelExist = await HotelDetails.findOne({ hotelName }).exec();
			if (hotelExist) {
				return res.status(400).json({ error: "Hotel name already exists" });
			}

			// Get existing user
			let user = await User.findById(existingUser).exec();
			if (!user) {
				return res.status(400).json({ error: "User not found" });
			}

			// Create hotel details
			const hotelDetails = new HotelDetails({
				hotelName,
				hotelAddress,
				hotelCountry,
				hotelState,
				hotelCity,
				propertyType,
				hotelFloors: hotelFloors ? Number(hotelFloors) : 1,
				hotelRooms: hotelRooms ? Number(hotelRooms) : 1,
				phone: cleanedPhone,
				belongsTo: user._id,
				acceptedTermsAndConditions: accepted,
			});
			await hotelDetails.save();

			// Attach to owner list
			user.hotelIdsOwner.push(hotelDetails._id);
			await user.save();

			return res.json({ message: `Hotel ${hotelName} was successfully added` });
		}

		// --- Determine normalized role (default to owner flow = 2000) ---
		const normalizedRole = Number(role) || 2000;

		// --- Branch B: HOTEL STAFF signup from a hotel manager dashboard ---
		// Keeps staff tied to one hotel while preserving the existing owner signup flow.
		const hotelStaffRoles = [3000, 4000, 5000, 6000];
		const isAdditionalHotelManager =
			normalizedRole === 2000 && String(roleDescription || "") === "hotelmanager";
		const isHotelStaffRequest =
			(hotelStaffRoles.includes(normalizedRole) || isAdditionalHotelManager) &&
			hotelIdWork &&
			belongsToId;
		if (isHotelStaffRequest) {
			return res.status(403).json({
				error:
					"Please create hotel staff from an authenticated hotel dashboard.",
			});
		}
		if (
			(hotelStaffRoles.includes(normalizedRole) || isAdditionalHotelManager) &&
			hotelIdWork &&
			belongsToId
		) {
			if (!name || !email || !password || !cleanedPhone) {
				return res.status(400).json({ error: "Please fill all the fields" });
			}
			if (String(password).length < 6) {
				return res
					.status(400)
					.json({ error: "Passwords should be 6 characters or more" });
			}

			const userExist = await User.findOne({
				$or: [{ email }, { phone: cleanedPhone }],
			}).exec();
			if (userExist) {
				return res.status(400).json({
					error: "User already exists, please try a different email/phone",
				});
			}

			const hotel = await HotelDetails.findById(hotelIdWork)
				.select("_id belongsTo hotelName hotelAddress hotelCountry hotelState hotelCity")
				.lean()
				.exec();
			if (!hotel) {
				return res.status(400).json({ error: "Hotel was not found" });
			}
			if (String(hotel.belongsTo || "") !== String(belongsToId || "")) {
				return res
					.status(403)
					.json({ error: "This employee cannot be attached to this hotel" });
			}

			const staffUser = new User({
				name,
				email,
				password,
				phone: cleanedPhone,
				role: normalizedRole,
				roleDescription: roleDescription || "",
				hotelName: hotelName || hotel.hotelName || "",
				hotelAddress: hotelAddress || hotel.hotelAddress || "",
				hotelCountry: hotelCountry || hotel.hotelCountry || "",
				hotelState: hotelState || hotel.hotelState || "",
				hotelCity: hotelCity || hotel.hotelCity || "",
				hotelIdWork,
				belongsToId,
				activeUser: true,
				acceptedTermsAndConditions: accepted,
			});

			await staffUser.save();

			return res.json({
				message: "Hotel staff account created successfully",
				userId: staffUser._id,
			});
		}

		// --- Branch B: EMPLOYEE signup (role === 1000) ---
		if (normalizedRole === 1000) {
			console.log("Handling employee user signup (role 1000)");

			if (!name || !email || !password || !cleanedPhone) {
				console.log("Missing fields (employee):", {
					name,
					email,
					hasPassword: !!password,
					phone: cleanedPhone,
				});
				return res.status(400).json({ error: "Please fill all the fields" });
			}
			if (String(password).length < 6) {
				return res
					.status(400)
					.json({ error: "Passwords should be 6 characters or more" });
			}

			// Guard against duplicate email/phone
			const userExist = await User.findOne({
				$or: [{ email }, { phone: cleanedPhone }],
			}).exec();
			if (userExist) {
				return res.status(400).json({
					error: "User already exists, please try a different email/phone",
				});
			}

			// (Optional) sanity-check referenced hotel IDs; keep only valid ones, but do not fail
			let supportIds = Array.isArray(hotelsToSupport)
				? [...new Set(hotelsToSupport)]
				: [];
			if (supportIds.length) {
				try {
					const existing = await HotelDetails.find({ _id: { $in: supportIds } })
						.select("_id")
						.lean()
						.exec();
					const existingIds = new Set(existing.map((h) => String(h._id)));
					supportIds = supportIds.filter((id) => existingIds.has(String(id)));
				} catch (e) {
					// If validation query fails, just fall back to provided list to avoid blocking signup
				}
			}

			// Create employee user WITHOUT hotelDetails / hotelIdsOwner
			const user = new User({
				name,
				email,
				password,
				phone: cleanedPhone,
				role: 1000,
				acceptedTermsAndConditions: accepted,
				// 🔽 Adjust field names if your schema differs
				hotelsToSupport: supportIds,
				accessTo: Array.isArray(accessTo) ? accessTo : [],
			});

			await user.save();

			return res.json({
				message: "Employee signup successful",
				userId: user._id,
			});
		}

		// --- Branch C: NEW HOTEL OWNER signup (role 2000: unchanged behavior) ---
		console.log("Handling new user signup");
		if (
			!name ||
			!email ||
			!password ||
			!cleanedPhone ||
			!hotelName ||
			!hotelAddress ||
			!hotelCountry ||
			!hotelState ||
			!hotelCity ||
			!propertyType
		) {
			console.log("Missing fields (owner):", {
				name,
				email,
				hasPassword: !!password,
				phone: cleanedPhone,
				hotelName,
				hotelAddress,
				hotelCountry,
				hotelState,
				hotelCity,
				propertyType,
				hotelFloors,
			});
			return res.status(400).json({ error: "Please fill all the fields" });
		}

		let userExist = await User.findOne({ email }).exec();
		if (userExist) {
			return res.status(400).json({
				error: "User already exists, please try a different email/phone",
			});
		}

		// Duplicate hotel name guard
		let hotelExist = await HotelDetails.findOne({ hotelName }).exec();
		if (hotelExist) {
			return res.status(400).json({ error: "Hotel name already exists" });
		}

		// Create owner user
		const user = new User({
			name,
			email,
			password,
			phone: cleanedPhone,
			hotelName,
			hotelAddress,
			hotelCountry,
			propertyType,
			role: 2000,
			acceptedTermsAndConditions: accepted,
		});
		await user.save();

		// Create hotel details and link to owner
		const hotelDetails = new HotelDetails({
			hotelName,
			hotelAddress,
			hotelCountry,
			hotelState,
			hotelCity,
			propertyType,
			hotelFloors: hotelFloors ? Number(hotelFloors) : 1,
			hotelRooms: hotelRooms ? Number(hotelRooms) : 1,
			phone: cleanedPhone,
			belongsTo: user._id,
			acceptedTermsAndConditions: accepted,
		});
		await hotelDetails.save();

		user.hotelIdsOwner = [hotelDetails._id];
		await user.save();

		return res.json({ message: "Signup successful" });
	} catch (error) {
		console.log("Error:", error);
		return res.status(500).json({ error: "Internal Server Error" });
	}
};

exports.createHotelStaffUser = async (req, res) => {
	try {
		const {
			name,
			email,
			password,
			phone,
			role,
			roleDescription,
			roles,
			roleDescriptions,
			hotelIdWork,
			hotelIdsWork,
			accessTo,
			companyName,
			companyOfficialName,
			companyEin,
			companyDocuments,
			agentCommercialModel,
			agentOpeningWalletCredit,
			agentWalletOpeningBalances,
		} = req.body;

		const cleanPhoneNumber = (rawPhone) => {
			if (typeof rawPhone !== "string")
				throw new Error("Invalid phone number format");
			const cleaned = rawPhone.replace(/\s+/g, "");
			const phoneRegex = /^\+?[0-9]*$/;
			if (!phoneRegex.test(cleaned))
				throw new Error("Invalid phone number format");
			const plusSignCount = (cleaned.match(/\+/g) || []).length;
			if (
				plusSignCount > 1 ||
				(plusSignCount === 1 && cleaned.indexOf("+") !== 0)
			) {
				throw new Error("Invalid phone number format");
			}
			return cleaned;
		};
		const normalizeOptionalEmail = (value) => {
			const normalized = String(value || "").trim().toLowerCase();
			if (!normalized) return "";
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

		const requestedHotelIds = [
			...(Array.isArray(hotelIdsWork) ? hotelIdsWork : []),
			...(Array.isArray(req.body.hotelsToSupport)
				? req.body.hotelsToSupport
				: []),
			hotelIdWork,
		]
			.map((id) => String(id || "").trim())
			.filter(Boolean);
		const uniqueHotelIds = [...new Set(requestedHotelIds)];

		if (!name || !password || !phone || uniqueHotelIds.length === 0) {
			return res.status(400).json({ error: "Please fill all the fields" });
		}
		if (String(password).length < 6) {
			return res
				.status(400)
				.json({ error: "Passwords should be 6 characters or more" });
		}

		const roleByDescription = {
			hotelmanager: 2000,
			reception: 3000,
			housekeepingmanager: 4000,
			housekeeping: 5000,
			finance: 6000,
			ordertaker: 7000,
			reservationemployee: 8000,
		};
		const descriptionByRole = Object.entries(roleByDescription).reduce(
			(acc, [description, roleNumber]) => {
				acc[roleNumber] = description;
				return acc;
			},
			{}
		);
		const incomingDescriptions = [
			...(Array.isArray(roleDescriptions) ? roleDescriptions : []),
			roleDescription,
			...(Array.isArray(roles)
				? roles.map((roleNumber) => descriptionByRole[Number(roleNumber)])
				: []),
		]
			.map((item) => String(item || "").trim().toLowerCase())
			.filter(Boolean);
		const normalizedRoleDescriptions = [
			...new Set(incomingDescriptions.length ? incomingDescriptions : ["reception"]),
		];
		const isAgentOnlyAccount =
			normalizedRoleDescriptions.length === 1 &&
			normalizedRoleDescriptions.includes("ordertaker");
		const invalidRole = normalizedRoleDescriptions.find(
			(description) => !roleByDescription[description]
		);

		if (invalidRole) {
			return res.status(400).json({ error: "Please select a valid role" });
		}
		const normalizedRoles = normalizedRoleDescriptions.map(
			(description) => roleByDescription[description]
		);
		const primaryRoleDescription = normalizedRoleDescriptions.includes("hotelmanager")
			? "hotelmanager"
			: normalizedRoleDescriptions[0];
		const normalizedRole = roleByDescription[primaryRoleDescription] || Number(role) || 3000;

		const creator = req.profile;
		if (!creator || creator.activeUser === false) {
			return res.status(403).json({ error: "Account is inactive" });
		}

		const hotels = await HotelDetails.find({ _id: { $in: uniqueHotelIds } })
			.select("_id belongsTo hotelName hotelAddress hotelCountry hotelState hotelCity")
			.lean()
			.exec();
		if (hotels.length !== uniqueHotelIds.length) {
			return res.status(400).json({ error: "Hotel was not found" });
		}

		const hotelsById = new Map(hotels.map((hotel) => [String(hotel._id), hotel]));
		const orderedHotels = uniqueHotelIds.map((id) => hotelsById.get(id)).filter(Boolean);
		const primaryHotel = orderedHotels[0];
		const hotelId = String(primaryHotel._id);
		const ownerId = String(primaryHotel.belongsTo || "");
		const creatorId = String(creator._id || "");
		const creatorRole = Number(creator.role);
		const supportIds = Array.isArray(creator.hotelsToSupport)
			? creator.hotelsToSupport.map((h) => String(h?._id || h))
			: [];
		const ownedIds = Array.isArray(creator.hotelIdsOwner)
			? creator.hotelIdsOwner.map((h) => String(h?._id || h))
			: [];
		const creatorRoleDescriptions = [
			String(creator.roleDescription || "").toLowerCase(),
			...(Array.isArray(creator.roleDescriptions)
				? creator.roleDescriptions.map((item) => String(item || "").toLowerCase())
				: []),
		];
		const creatorRoleNumbers = [
			Number(creator.role),
			...(Array.isArray(creator.roles) ? creator.roles.map(Number) : []),
		];
		const creatorIsAgentAccountRequester =
			creatorRoleNumbers.includes(6000) ||
			creatorRoleNumbers.includes(8000) ||
			creatorRoleDescriptions.includes("finance") ||
			creatorRoleDescriptions.includes("reservationemployee");

		if (creatorIsAgentAccountRequester && !isAgentOnlyAccount) {
			return res.status(403).json({
				error:
					"Finance and reservation users can create external agent accounts only.",
			});
		}

		const canCreateForEveryHotel = orderedHotels.every((hotel) => {
			const currentHotelId = String(hotel._id);
			const currentOwnerId = String(hotel.belongsTo || "");
			const creatorOwnsHotel =
				creatorRole === 2000 &&
				(creatorId === currentOwnerId || ownedIds.includes(currentHotelId));
			const creatorIsAssignedHotelManager =
				creatorRole === 2000 &&
				creatorRoleDescriptions.includes("hotelmanager") &&
				String(creator.belongsToId || currentOwnerId) === currentOwnerId &&
				(String(creator.hotelIdWork || "") === currentHotelId ||
					supportIds.includes(currentHotelId));
			const adminCanSupportHotel =
				isConfiguredSuperAdmin(creator) ||
				(creatorRole === 1000 &&
					(supportIds.length === 0 || supportIds.includes(currentHotelId)));
			const canCreateAgentForThisHotel =
				isAgentOnlyAccount &&
				canCreateAgentForHotel(creator, currentHotelId, currentOwnerId);

			return (
				creatorOwnsHotel ||
				creatorIsAssignedHotelManager ||
				adminCanSupportHotel ||
				canCreateAgentForThisHotel
			);
		});

		if (!canCreateForEveryHotel) {
			return res
				.status(403)
				.json({ error: "You cannot create users for one or more selected hotels" });
		}

		const cleanedPhone = cleanPhoneNumber(phone);
		const normalizedEmail = normalizeOptionalEmail(email);
		const duplicateChecks = [{ phone: cleanedPhone }];
		if (normalizedEmail) duplicateChecks.push({ email: normalizedEmail });
		const userExist = await User.findOne({ $or: duplicateChecks }).exec();
		if (userExist) {
			return res.status(400).json({
				error: "User already exists, please try a different email/phone",
			});
		}
		const staffEmail =
			normalizedEmail || buildStaffPlaceholderEmail(cleanedPhone, hotelId);
		const normalizedAccessTo = [
			...new Set([
				...(isAgentOnlyAccount
					? ["newReservation", "ownReservations"]
					: Array.isArray(accessTo)
					? accessTo.map((item) => String(item || "").trim()).filter(Boolean)
					: []),
				...(normalizedRoleDescriptions.includes("reservationemployee")
					? ["settings"]
					: []),
			]),
		];
		const creatorCanApproveAgent = isAgentOnlyAccount
			? await canApproveAgentAccountsForOwner(creator, ownerId)
			: false;
		const pendingAgentApproval = isAgentOnlyAccount && !creatorCanApproveAgent;
		const agentApprovalActor = buildAgentApprovalActor(creator);

		const staffUser = new User({
			name,
			email: staffEmail,
			emailIsPlaceholder: !normalizedEmail,
			password,
			phone: cleanedPhone,
			role: normalizedRole,
			roleDescription: primaryRoleDescription,
			roles: normalizedRoles,
			roleDescriptions: normalizedRoleDescriptions,
			companyName: String(companyName || "").trim(),
			companyOfficialName: String(companyOfficialName || "").trim(),
			companyEin: String(companyEin || "").trim(),
			companyDocuments: sanitizeCompanyDocuments(companyDocuments),
			agentCommercialModel: normalizeAgentCommercialModel(agentCommercialModel),
			agentOpeningWalletCredit: nonNegativeMoney(agentOpeningWalletCredit),
			agentWalletOpeningBalances: sanitizeAgentWalletOpeningBalances(
				agentWalletOpeningBalances,
				uniqueHotelIds,
				agentOpeningWalletCredit
			),
			hotelName: primaryHotel.hotelName || "",
			hotelAddress: primaryHotel.hotelAddress || "",
			hotelCountry: primaryHotel.hotelCountry || "",
			hotelState: primaryHotel.hotelState || "",
			hotelCity: primaryHotel.hotelCity || "",
			hotelIdWork: hotelId,
			belongsToId: ownerId,
			hotelsToSupport: uniqueHotelIds,
			activeUser: pendingAgentApproval ? false : true,
			agentApproval: isAgentOnlyAccount
				? {
						status: pendingAgentApproval ? "pending" : "approved",
						requestedAt: new Date(),
						requestedBy: agentApprovalActor,
						approvedAt: pendingAgentApproval ? null : new Date(),
						approvedBy: pendingAgentApproval ? null : agentApprovalActor,
						rejectedAt: null,
						rejectedBy: null,
						rejectionReason: "",
						lastUpdatedAt: new Date(),
						lastUpdatedBy: agentApprovalActor,
				  }
				: {
						status: "approved",
						requestedAt: null,
						requestedBy: null,
						approvedAt: null,
						approvedBy: null,
						rejectedAt: null,
						rejectedBy: null,
						rejectionReason: "",
						lastUpdatedAt: null,
						lastUpdatedBy: null,
				  },
			accessTo: normalizedAccessTo,
		});

		await staffUser.save();
		if (pendingAgentApproval) {
			await emitHotelNotificationRefresh(req, hotelId, {
				type: "agent_account_pending",
				ownerId,
				agentId: staffUser._id,
			});
		}

		return res.json({
			message: pendingAgentApproval
				? "External agent account submitted for hotel director approval"
				: "Hotel staff account created successfully",
			pendingApproval: pendingAgentApproval,
			userId: staffUser._id,
		});
	} catch (error) {
		console.log("Create hotel staff error:", error);
		return res.status(400).json({ error: error.message || "Hotel staff signup failed" });
	}
};

exports.signout = (req, res) => {
	res.clearCookie("t");
	res.json({ message: "User Signed Out" });
};

exports.requireSignin = expressJwt({
	secret: process.env.JWT_SECRET,
	userProperty: "auth",
	algorithms: ["HS256"],
});

exports.isAuth = (req, res, next) => {
	const sameUser = req.profile && req.auth && req.profile._id == req.auth._id;
	if (sameUser) return next();

	// quick DB look‑up – executed only for mismatch
	User.findById(req.auth._id)
		.select("_id role")
		.exec((err, u) => {
			if (err || !u || (u.role !== 1000 && !isConfiguredSuperAdmin(u))) {
				return res.status(403).json({ error: "access denied" });
			}
			next(); // platform admin – let him through
		});
};

exports.isAdmin = (req, res, next) => {
	if (req.profile.role !== 1000 && !isConfiguredSuperAdmin(req.profile)) {
		return res.status(403).json({
			error: "Admin resource! access denied",
		});
	}

	next();
};

exports.isHotelOwner = (req, res, next) => {
	const roleNumbers = [
		Number(req.profile?.role),
		...(Array.isArray(req.profile?.roles)
			? req.profile.roles.map((role) => Number(role))
			: []),
	].filter(Boolean);
	const roleDescriptions = [
		String(req.profile?.roleDescription || "").toLowerCase(),
		...(Array.isArray(req.profile?.roleDescriptions)
			? req.profile.roleDescriptions.map((role) =>
					String(role || "").toLowerCase()
			  )
			: []),
	];
	const canManageHotelSettings =
		roleNumbers.some((role) => [1000, 2000, 3000, 8000].includes(role)) ||
		["hotelmanager", "reception", "reservationemployee"].some((role) =>
			roleDescriptions.includes(role)
		);

	if (
		!canManageHotelSettings &&
		!isConfiguredSuperAdmin(req.profile)
	) {
		return res.status(403).json({
			error: "Admin resource! access denied",
		});
	}
	next();
};

exports.forgotPassword = async (req, res) => {
	try {
		const { emailOrPhone, email, phone, client } = req.body;
		const raw = (emailOrPhone || email || phone || "").trim();
		if (!raw)
			return res.status(400).json({ error: "Please provide email or phone." });
		const channel = getForgotPasswordChannel(raw);
		const neutralMessage = resetResponseMessage(channel);

		// 1) Locate the user (email exact OR phone in a few common formats)
		let user = null;
		if (channel === "email") {
			user = await User.findOne({ email: raw.toLowerCase() }).exec();
		} else {
			const digits = onlyDigits(raw);
			if (!digits) {
				return res
					.status(400)
					.json({ error: "Please provide a valid email or phone." });
			}
			const candidates = [digits, `+${digits}`];
			for (const c of candidates) {
				user = await User.findOne({ phone: c }).exec();
				if (user) break;
			}
			// Final light attempt: if DB stores without + or leading country, try last 10 digits
			if (!user && digits.length >= 10) {
				const last10 = digits.slice(-10);
				user = await User.findOne({ phone: new RegExp(`${last10}$`) }).exec();
			}
		}

		// 2) Always return a neutral message to client to avoid enumeration
		//    But only actually send WA/email if the user exists.
		if (!user) {
			return res.json({
				message: neutralMessage,
				via: {
					requested: channel,
					emailUser: channel === "email" ? "unknown" : "not_requested",
					whatsapp: channel === "whatsapp" ? "unknown" : "not_requested",
				},
			});
		}

		// 3) Build and store a short-lived token
		const token = jwt.sign(
			{ _id: user._id, name: user.name },
			process.env.JWT_RESET_PASSWORD,
			{ expiresIn: `${RESET_TOKEN_MINUTES}m` }
		);
		user.resetPasswordLink = token;
		await user.save();

		const resetClientBaseUrl = getResetClientBaseUrl(req, client);
		const resetUrl = `${resetClientBaseUrl}/auth/password/reset/${token}`;

		// 4) Prepare emails (user + admin)
		const emailToUser = {
			to: user.email,
			from: FROM_EMAIL,
			subject: "Password Reset | إعادة تعيين كلمة المرور",
			html: resetEmailHtml({
				name: user.name,
				resetUrl,
				minutes: RESET_TOKEN_MINUTES,
			}),
		};

		const emailToAdmin = {
			to: ADMIN_EMAIL,
			from: FROM_EMAIL,
			subject: "Password reset requested",
			html: `
        <div style="font-family:Arial,sans-serif">
          <p>A password reset was requested.</p>
          <p><strong>User:</strong> ${user.name}</p>
          <p><strong>Email:</strong> ${user.email || "-"}</p>
          <p><strong>Phone:</strong> ${user.phone || "-"}</p>
          <p><strong>Requested delivery:</strong> ${channel}</p>
          <p><strong>Reset client:</strong> ${resetClientBaseUrl}</p>
        </div>
      `,
		};

		// 5) Attempt WhatsApp only when the user typed a phone number.
		let wa = null;
		let wa_link = null;
		if (channel === "whatsapp") {
			try {
				wa = await waSendResetPasswordLink(user, resetUrl);
				if (wa?.skipped) {
					// Build a wa.me fallback if Twilio cannot send directly.
					let e164 = null;
					try {
						e164 = await ensureE164Phone({
							nationality: user?.hotelCountry || user?.nationality || null,
							rawPhone: user?.phone,
							fallbackRegion: "SA",
						});
					} catch {}
					if (e164)
						wa_link = waLinkFromE164(
							e164,
							buildWaText({ name: user.name, url: resetUrl })
						);
				}
			} catch (e) {
				let e164 = null;
				try {
					e164 = await ensureE164Phone({
						nationality: user?.hotelCountry || user?.nationality || null,
						rawPhone: user?.phone,
						fallbackRegion: "SA",
					});
				} catch {}
				if (e164)
					wa_link = waLinkFromE164(
						e164,
						buildWaText({ name: user.name, url: resetUrl })
					);
			}
		}

		// 6) Send emails (do not fail the whole flow if one email fails)
		const emailResults = { user: null, admin: null };
		try {
			if (channel === "email" && user.email && !user.emailIsPlaceholder) {
				emailResults.user = await sgMail.send(emailToUser);
			}
		} catch (e) {
			console.log("SENDGRID user email error:", e?.message || e);
		}
		try {
			emailResults.admin = await sgMail.send(emailToAdmin);
		} catch (e) {
			console.log("SENDGRID admin email error:", e?.message || e);
		}

		// 7) Respond success; include wa_link if we built a fallback
		return res.json({
			message: neutralMessage,
			via: {
				requested: channel,
				whatsapp:
					channel === "whatsapp"
						? wa?.sid
							? "sent"
							: wa?.skipped
							? "skipped"
							: wa_link
							? "wa_link"
							: "unknown"
						: "not_requested",
				emailUser:
					channel === "email"
						? user.email && !user.emailIsPlaceholder
							? "attempted"
							: "no_email_on_file"
						: "not_requested",
				emailAdmin: "attempted",
			},
			wa_link, // optional – frontend may show a button "Open WhatsApp"
		});
	} catch (error) {
		console.log("forgotPassword error:", error);
		return res.status(500).json({ error: "Internal Server Error" });
	}
};

exports.resetPassword = (req, res) => {
	const { resetPasswordLink, newPassword } = req.body;

	if (!resetPasswordLink || !newPassword) {
		return res.status(400).json({ error: "Missing token or new password." });
	}
	if (String(newPassword).length < 6) {
		return res
			.status(400)
			.json({ error: "Password must be at least 6 characters." });
	}

	jwt.verify(
		resetPasswordLink,
		process.env.JWT_RESET_PASSWORD,
		function (err, decoded) {
			if (err) {
				return res.status(400).json({
					error: "Expired or invalid link. Please request a new one.",
				});
			}

			User.findOne({ resetPasswordLink }, async (err, user) => {
				if (err || !user) {
					return res.status(400).json({
						error: "Invalid reset request. Please try again.",
					});
				}

				try {
					user.password = newPassword; // virtual setter hashes
					user.resetPasswordLink = "";
					await user.save();
					return res.json({
						message:
							"Great! Your password has been updated. You can now sign in.",
					});
				} catch (e) {
					return res
						.status(400)
						.json({ error: "Error resetting user password." });
				}
			});
		}
	);
};

const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
exports.googleLogin = (req, res) => {
	const { idToken } = req.body;

	client
		.verifyIdToken({ idToken, audience: process.env.GOOGLE_CLIENT_ID })
		.then((response) => {
			// console.log('GOOGLE LOGIN RESPONSE',response)
			const { email_verified, name, email } = response.payload;
			if (email_verified) {
				User.findOne({ email }).exec((err, user) => {
					if (user) {
						const token = jwt.sign({ _id: user._id }, process.env.JWT_SECRET, {
							expiresIn: "7d",
						});
						const { _id, email, name, role } = user;
						return res.json({
							token,
							user: { _id, email, name, role },
						});
					} else {
						let password = email + process.env.JWT_SECRET;
						user = new User({ name, email, password });
						user.save((err, data) => {
							if (err) {
								console.log("ERROR GOOGLE LOGIN ON USER SAVE", err);
								return res.status(400).json({
									error: "User signup failed with google",
								});
							}
							const token = jwt.sign(
								{ _id: data._id },
								process.env.JWT_SECRET,
								{ expiresIn: "7d" }
							);
							const { _id, email, name, role } = data;
							return res.json({
								token,
								user: { _id, email, name, role },
							});
						});
						const welcomingEmail = {
							to: user.email,
							from: "noreply@tier-one.com",
							subject: `Welcome to Tier One Barber & Beauty`,
							html: `
          Hi ${user.name},
            <div>Thank you for shopping with <a href="www.Tier One Barber.com/all-products"> Tier One Barber & Beauty</a>.</div>
            <h4> Our support team will always be avaiable for you if you have any inquiries or need assistance!!
            </h4>
             <br />
             Kind and Best Regards,  <br />
             Tier One Barber & Beauty support team <br />
             Contact Email: info@tier-one.com <br />
             Phone#: (951) 503-6818 <br />
             Landline#: (951) 497-3555 <br />
             Address:  4096 N. Sierra Way San Bernardino, 92407  <br />
             &nbsp;&nbsp;<img src="https://Tier One Barber.com/api/product/photo5/5efff6005275b89938abe066" alt="Tier One Barber" style=width:50px; height:50px />
             <p>
             <strong>Tier One Barber & Beauty</strong>  
              </p>

        `,
						};
						sgMail.send(welcomingEmail);
						const GoodNews = {
							to: ahmed2,
							from: "noreply@tier-one.com",
							subject: `Great News!!!!`,
							html: `
          Hello Tier One Barber & Beauty team,
            <h3> Congratulations!! Another user has joined our Tier One Barber & Beauty community (name: ${user.name}, email: ${user.email})</h3>
            <h5> Please try to do your best to contact him/her to ask for advise on how the service was using Tier One Barber & Beauty.
            </h5>
             <br />
             
            Kind and Best Regards,  <br />
             Tier One Barber & Beauty support team <br />
             Contact Email: info@tier-one.com <br />
             Phone#: (951) 503-6818 <br />
             Landline#: (951) 497-3555 <br />
             Address:  4096 N. Sierra Way San Bernardino, 92407  <br />
             &nbsp;&nbsp;<img src="https://Tier One Barber.com/api/product/photo5/5efff6005275b89938abe066" alt="Tier One Barber" style=width:50px; height:50px />
             <p>
             <strong>Tier One Barber & Beauty</strong>  
              </p>

        `,
						};
						sgMail.send(GoodNews);
					}
				});
			} else {
				return res.status(400).json({
					error: "Google login failed. Try again",
				});
			}
		});
};
