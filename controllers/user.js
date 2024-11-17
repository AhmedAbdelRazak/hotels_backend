/** @format */

const User = require("../models/user");
const mongoose = require("mongoose");

exports.userById = (req, res, next, id) => {
	console.log(id, "id");
	User.findById(id)
		.select(
			"_id name email phone role user points activePoints likesUser activeUser employeeImage userRole history userStore userBranch"
		)
		// .populate(
		// 	"likesUser",
		// 	"_id productName description ratings views viewsCount",
		// )
		.exec((err, user) => {
			if (err || !user) {
				console.log(err);
				return res.status(400).json({
					error: "user not found yad",
				});
			}
			req.profile = user;
			next();
		});
};

exports.updatedUserId = (req, res, next, id) => {
	User.findById(id)
		.select(
			"_id name email phone role user points activePoints likesUser activeUser employeeImage userRole history userStore userBranch"
		)

		.exec((err, userNeedsUpdate) => {
			console.log(err, "user not found yad");
			if (err || !userNeedsUpdate) {
				return res.status(400).json({
					error: "user not found yad",
				});
			}
			req.updatedUserByAdmin = userNeedsUpdate;
			next();
		});
};

exports.read = (req, res) => {
	req.profile.hashed_password = undefined;
	req.profile.salt = undefined;
	return res.json(req.profile);
};

exports.remove = (req, res) => {
	let user = req.user;
	user.remove((err, deletedUser) => {
		if (err) {
			return res.status(400).json({
				error: errorHandler(err),
			});
		}
		res.json({
			manage: "User was successfully deleted",
		});
	});
};

exports.allUsersList = (req, res) => {
	User.find()
		.select(
			"_id name email role user points activePoints likesUser activeUser employeeImage userRole history userStore userBranch"
		)
		.exec((err, users) => {
			if (err) {
				return res.status(400).json({
					error: "users not found",
				});
			}
			res.json(users);
		});
};

exports.update = (req, res) => {
	// console.log('UPDATE USER - req.user', req.user, 'UPDATE DATA', req.body);
	const { name, password } = req.body;

	User.findOne({ _id: req.profile._id }, (err, user) => {
		if (err || !user) {
			return res.status(400).json({
				error: "User not found",
			});
		}
		if (!name) {
			return res.status(400).json({
				error: "Name is required",
			});
		} else {
			user.name = name;
		}

		if (password) {
			if (password.length < 6) {
				return res.status(400).json({
					error: "Password should be min 6 characters long",
				});
			} else {
				user.password = password;
			}
		}

		user.save((err, updatedUser) => {
			if (err) {
				console.log("USER UPDATE ERROR", err);
				return res.status(400).json({
					error: "User update failed",
				});
			}
			updatedUser.hashed_password = undefined;
			updatedUser.salt = undefined;
			res.json(updatedUser);
		});
	});
};

exports.updateUserByAdmin = (req, res) => {
	const {
		name,
		password,
		role,
		activeUser,
		employeeImage,
		email,
		userRole,
		userStore,
		userBranch,
	} = req.body.updatedUserByAdmin;

	User.findOne({ _id: req.body.updatedUserByAdmin.userId }, (err, user) => {
		if (err || !user) {
			return res.status(400).json({
				error: "User not found",
			});
		}
		if (!name) {
			return res.status(400).json({
				error: "Name is required",
			});
		} else {
			user.name = name;
		}

		if (password) {
			if (password.length < 6) {
				return res.status(400).json({
					error: "Password should be min 6 characters long",
				});
			} else {
				user.password = password;
			}
		}

		if (!role) {
			return res.status(400).json({
				error: "Role is required",
			});
		} else {
			user.role = role;
		}

		if (!email) {
			return res.status(400).json({
				error: "Email is required",
			});
		} else {
			user.email = email;
		}

		if (!activeUser) {
			return res.status(400).json({
				error: "activeUser is required",
			});
		} else {
			user.activeUser = activeUser;
		}

		if (!employeeImage) {
			return res.status(400).json({
				error: "employeeImage is required",
			});
		} else {
			user.employeeImage = employeeImage;
		}

		if (!userRole) {
			return res.status(400).json({
				error: "User Role Is Required",
			});
		} else {
			user.userRole = userRole;
		}

		if (!userStore) {
			return res.status(400).json({
				error: "User Store Is Required",
			});
		} else {
			user.userStore = userStore;
		}

		if (!userBranch) {
			return res.status(400).json({
				error: "User Store Is Required",
			});
		} else {
			user.userBranch = userBranch;
		}

		user.save((err, updatedUser) => {
			if (err) {
				console.log("USER UPDATE ERROR", err);
				return res.status(400).json({
					error: "User update failed",
				});
			}
			updatedUser.hashed_password = undefined;
			updatedUser.salt = undefined;
			res.json(updatedUser);
		});
	});
};

exports.getSingleUser = (req, res) => {
	const { accountId } = req.params; // Get accountId from URL parameters
	const belongsTo = mongoose.Types.ObjectId(accountId);

	User.findOne({ _id: belongsTo })
		.populate("hotelIdsOwner") // Populate the hotelIdsOwner field
		.exec((err, user) => {
			if (err || !user) {
				return res.status(400).json({
					error: "User not found",
				});
			}
			// Optional: Remove sensitive information from user object
			user.hashed_password = undefined;
			user.salt = undefined;

			res.json(user); // Send the user data as a response
		});
};

exports.houseKeepingStaff = async (req, res) => {
	const { hotelId } = req.params;

	try {
		const staffList = await User.find({
			hotelIdWork: hotelId,
			role: 5000,
		}).select("_id name email role"); // You can adjust the fields you want to select

		res.json(staffList);
	} catch (err) {
		console.error(err);
		res.status(500).json({
			error: "Error retrieving housekeeping staff list",
		});
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
			if (err) {
				return res.status(400).json({
					error: "Users not found",
				});
			}
			res.json(users);
		});
};
