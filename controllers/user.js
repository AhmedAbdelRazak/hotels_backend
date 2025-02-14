/** @format */

const User = require("../models/user");
const mongoose = require("mongoose");

exports.userById = (req, res, next, id) => {
	console.log(id, "id");
	User.findById(id)
		.select(
			"_id name email phone role user points activeUser hotelsToSupport accessTo"
		)
		.populate("hotelsToSupport")
		// .populate("hotelsToSupport", "_id hotelName hotelCountry hotelCity hotelAddress")
		.exec((err, user) => {
			if (err || !user) {
				console.log(err);
				return res.status(400).json({
					error: "User not found",
				});
			}
			req.profile = user; // Attach the user with populated hotelsToSupport to the request
			console.log("Passed UserById");
			next();
		});
};

exports.updatedUserId = async (req, res, next, id) => {
	console.log(id, "idididididididid"); // This shows 675bb6a5fffa21f9bd44feba

	try {
		// 1) Quick debug findOne
		const testString = await User.findOne({ _id: id }); // if ID is stored as string
		console.log("testString =>", testString);

		// 2) The standard findById
		const userNeedsUpdate = await User.findById(id)
			.select("_id name email hotelIdsOwner")
			.exec();

		console.log("userNeedsUpdate =>", userNeedsUpdate);
		if (!userNeedsUpdate) {
			return res.status(400).json({ error: "user not found yad" });
		}
		req.updatedUserByAdmin = userNeedsUpdate;
		console.log("Passed updatedUserId");

		next();
	} catch (err) {
		console.log("err =>", err);
		return res.status(400).json({ error: "some error" });
	}
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
	// The admin-supplied data
	const updateData = req.body || {};
	// The userId we want to update
	// e.g. if you store it as `updateData.userId`
	const userIdToUpdate = updateData.userId;

	// 1) Find the target user
	User.findOne({ _id: userIdToUpdate }, (err, user) => {
		if (err || !user) {
			return res.status(400).json({ error: "User not found" });
		}

		// 2) For each possible field, update if present in updateData

		// name
		if ("name" in updateData) {
			if (!updateData.name) {
				return res.status(400).json({ error: "Name is required" });
			}
			user.name = updateData.name;
		}

		// password
		if ("password" in updateData) {
			if (!updateData.password) {
				return res.status(400).json({ error: "Password is required" });
			}
			if (updateData.password.length < 6) {
				return res.status(400).json({
					error: "Password should be min 6 characters long",
				});
			}
			user.password = updateData.password;
		}

		// role
		if ("role" in updateData) {
			if (!updateData.role) {
				return res.status(400).json({ error: "Role is required" });
			}
			user.role = updateData.role;
		}

		// email
		if ("email" in updateData) {
			if (!updateData.email) {
				return res.status(400).json({ error: "Email is required" });
			}
			user.email = updateData.email;
		}

		// activeUser
		if ("activeUser" in updateData) {
			// If you want it mandatory if provided:
			// if (!updateData.activeUser) {
			//   return res.status(400).json({ error: "activeUser is required" });
			// }
			user.activeUser = updateData.activeUser;
		}

		// employeeImage
		if ("employeeImage" in updateData) {
			user.employeeImage = updateData.employeeImage;
		}

		// userRole
		if ("userRole" in updateData) {
			user.userRole = updateData.userRole;
		}

		// userStore
		if ("userStore" in updateData) {
			user.userStore = updateData.userStore;
		}

		// userBranch
		if ("userBranch" in updateData) {
			user.userBranch = updateData.userBranch;
		}

		// 3) Save the updated user
		user.save((err, updatedUser) => {
			if (err) {
				console.log("USER UPDATE ERROR", err);
				return res.status(400).json({ error: "User update failed" });
			}
			updatedUser.hashed_password = undefined;
			updatedUser.salt = undefined;
			return res.json(updatedUser);
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
