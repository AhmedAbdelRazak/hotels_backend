/** @format */

const User = require("../models/user");
const HotelDetails = require("../models/hotel_details");
const jwt = require("jsonwebtoken");
const _ = require("lodash");
const expressJwt = require("express-jwt");
const { OAuth2Client } = require("google-auth-library");
const sgMail = require("@sendgrid/mail");

sgMail.setApiKey(process.env.SENDGRID_API_KEY);
const ahmed2 = "ahmedabdelrazzak1001010@gmail.com";

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
			name,
			email,
			password,
			phone,
			hotelName,
			hotelAddress,
			hotelCountry,
			hotelState,
			hotelCity,
			propertyType,
			hotelFloors,
			hotelRooms,
			existingUser,
			accepted,
		} = req.body;

		console.log("Received request body:", req.body);

		// Utility function to clean phone number
		const cleanPhoneNumber = (phone) => {
			// Remove spaces
			let cleaned = phone.replace(/\s+/g, "");

			// Validate and clean phone number
			const phoneRegex = /^\+?[0-9]*$/;
			if (!phoneRegex.test(cleaned)) {
				throw new Error("Invalid phone number format");
			}

			// Ensure there is only one plus sign and it's at the start
			const plusSignCount = (cleaned.match(/\+/g) || []).length;
			if (
				plusSignCount > 1 ||
				(plusSignCount === 1 && cleaned.indexOf("+") !== 0)
			) {
				throw new Error("Invalid phone number format");
			}

			return cleaned;
		};

		let cleanedPhone;
		try {
			cleanedPhone = cleanPhoneNumber(phone);
		} catch (error) {
			return res.status(400).json({ error: error.message });
		}

		// If the request is from an existing user
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

			// Check for duplicate hotel name
			let hotelExist = await HotelDetails.findOne({ hotelName }).exec();
			if (hotelExist) {
				return res.status(400).json({ error: "Hotel name already exists" });
			}

			// Get the existing user
			let user = await User.findById(existingUser).exec();
			if (!user) {
				return res.status(400).json({
					error: "User not found",
				});
			}

			// Create new hotel details
			const hotelDetails = new HotelDetails({
				hotelName,
				hotelAddress,
				hotelCountry,
				hotelState,
				hotelCity,
				propertyType,
				hotelFloors: hotelFloors ? Number(hotelFloors) : 1, // Ensure hotelFloors is saved as a number
				hotelRooms: hotelRooms ? Number(hotelRooms) : 1, // Ensure hotelFloors is saved as a number
				phone: cleanedPhone,
				belongsTo: user._id,
				acceptedTermsAndConditions: accepted,
			});
			await hotelDetails.save();

			// Update hotelIdsOwner and save the user again
			user.hotelIdsOwner.push(hotelDetails._id);
			await user.save();

			return res.json({ message: `Hotel ${hotelName} was successfully added` });
		}

		// If the request is for a new user signup
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
			console.log("Missing fields:", {
				name,
				email,
				password,
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

		// Check for duplicate hotel name
		let hotelExist = await HotelDetails.findOne({ hotelName }).exec();
		if (hotelExist) {
			return res.status(400).json({ error: "Hotel name already exists" });
		}

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

		const hotelDetails = new HotelDetails({
			hotelName,
			hotelAddress,
			hotelCountry,
			hotelState,
			hotelCity,
			propertyType,
			hotelFloors: hotelFloors ? Number(hotelFloors) : 1, // Ensure hotelFloors is saved as a number
			phone: cleanedPhone,
			belongsTo: user._id,
			hotelRooms: hotelRooms,
			acceptedTermsAndConditions: accepted,
		});
		await hotelDetails.save();

		// Update hotelIdsOwner and save the user again
		user.hotelIdsOwner = [hotelDetails._id];
		await user.save();

		res.json({ message: "Signup successful" });
	} catch (error) {
		console.log("Error:", error);
		res.status(500).json({ error: "Internal Server Error" });
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
	let user = req.profile && req.auth && req.profile._id == req.auth._id;
	if (!user) {
		return res.status(403).json({
			error: "access denied",
		});
	}
	next();
};

exports.isAdmin = (req, res, next) => {
	if (req.profile.role !== 1000) {
		return res.status(403).json({
			error: "Admin resource! access denied",
		});
	}

	next();
};

exports.isHotelOwner = (req, res, next) => {
	if (
		req.profile.role !== 1000 &&
		req.profile.role !== 2000 &&
		req.profile.role !== 3000
	) {
		return res.status(403).json({
			error: "Admin resource! access denied",
		});
	}
	next();
};

exports.forgotPassword = (req, res) => {
	const { email } = req.body;

	User.findOne({ email }, (err, user) => {
		if (err || !user) {
			return res.status(400).json({
				error: "User with that email does not exist",
			});
		}

		const token = jwt.sign(
			{ _id: user._id, name: user.name },
			process.env.JWT_RESET_PASSWORD,
			{
				expiresIn: "10m",
			}
		);

		const emailData_Reset = {
			from: "noreply@tier-one.com",
			to: email,
			subject: `Password Reset link`,
			html: `
                <h1>Please use the following link to reset your password</h1>
                <p>${process.env.CLIENT_URL}/auth/password/reset/${token}</p>
                <hr />
                <p>This email may contain sensetive information</p>
                <p>${process.env.CLIENT_URL}</p>
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
		const emailData_Reset2 = {
			from: "noreply@tier-one.com",
			to: ahmed2,
			subject: `Password Reset link`,
			html: `
                <h1>user ${email} tried to reset her/his password using the below link</h1>
                <p>${process.env.CLIENT_URL}/auth/password/reset/${token}</p>
                <hr />
                <p>This email may contain sensetive information</p>
                <p>${process.env.CLIENT_URL}</p>
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

		return user.updateOne({ resetPasswordLink: token }, (err, success) => {
			if (err) {
				console.log("RESET PASSWORD LINK ERROR", err);
				return res.status(400).json({
					error: "Database connection error on user password forgot request",
				});
			} else {
				sgMail.send(emailData_Reset2);
				sgMail
					.send(emailData_Reset)
					.then((sent) => {
						console.log("SIGNUP EMAIL SENT", sent);
						return res.json({
							message: `Email has been sent to ${email}. Follow the instruction to Reset your Password`,
						});
					})
					.catch((err) => {
						console.log("SIGNUP EMAIL SENT ERROR", err);
						return res.json({
							message: err.message,
						});
					});
			}
		});
	});
};

exports.resetPassword = (req, res) => {
	const { resetPasswordLink, newPassword } = req.body;

	if (resetPasswordLink) {
		jwt.verify(
			resetPasswordLink,
			process.env.JWT_RESET_PASSWORD,
			function (err, decoded) {
				if (err) {
					return res.status(400).json({
						error: "Expired link. Try again",
					});
				}

				User.findOne({ resetPasswordLink }, (err, user) => {
					if (err || !user) {
						return res.status(400).json({
							error: "Something went wrong. Try later",
						});
					}

					const updatedFields = {
						password: newPassword,
						resetPasswordLink: "",
					};

					user = _.extend(user, updatedFields);

					user.save((err, result) => {
						if (err) {
							return res.status(400).json({
								error: "Error resetting user password",
							});
						}
						res.json({
							message: `Great! Now you can login with your new password`,
						});
					});
				});
			}
		);
	}
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
