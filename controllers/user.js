/** @format */

"use strict";

const mongoose = require("mongoose");
const User = require("../models/user");

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

/* ───────────────────── Param Loaders ───────────────────── */

exports.userById = (req, res, next, id) => {
	if (!isValidObjectId(id)) {
		return res.status(400).json({ error: "Invalid user id" });
	}

	User.findById(id)
		.select(
			"_id name email phone role user points activeUser hotelsToSupport accessTo"
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
				"_id name email role activeUser employeeImage userRole userStore userBranch"
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
			"_id name email role user points activePoints likesUser activeUser employeeImage userRole history userStore userBranch"
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
		if ("activeUser" in payload && payload.activeUser != null)
			userDoc.activeUser = payload.activeUser;
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
		const staffList = await User.find({
			hotelIdWork: hotelId,
			role: 5000,
		}).select("_id name email role");
		res.json(staffList.map(sanitizeUserForResponse));
	} catch (err) {
		console.error(err);
		res.status(500).json({ error: "Error retrieving housekeeping staff list" });
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
