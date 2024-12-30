const SupportCase = require("../models/supportcase");
const mongoose = require("mongoose");
const ObjectId = mongoose.Types.ObjectId;

const twilio = require("twilio");

const orderStatusSMS = twilio(
	process.env.TWILIO_ACCOUNT_SID,
	process.env.TWILIO_AUTH_TOKEN
);

// Get all support cases
exports.getSupportCases = async (req, res) => {
	try {
		const userId = req.user._id;
		const role = req.user.role;

		let cases;
		if (role === "SuperAdmin") {
			cases = await SupportCase.find()
				.populate("supporterId")
				.populate("conversation.messageBy")
				.populate("participants.user");
		} else {
			cases = await SupportCase.find({
				"participants.user": userId,
			})
				.populate("supporterId")
				.populate("conversation.messageBy")
				.populate("participants.user");
		}

		res.status(200).json(cases);
	} catch (error) {
		res.status(400).json({ error: error.message });
	}
};

// Get a specific support case by ID
exports.getSupportCaseById = async (req, res) => {
	try {
		// Find the support case by ID without attempting to populate 'messageBy'
		const supportCase = await SupportCase.findById(req.params.id)
			.populate("supporterId") // Only populate fields that reference another model
			.populate("hotelId");

		if (!supportCase) {
			console.log("Support case not found:", req.params.id);
			return res.status(404).json({ error: "Support case not found" });
		}

		res.status(200).json(supportCase);
	} catch (error) {
		console.error("Error fetching support case:", error);
		res.status(400).json({ error: error.message });
	}
};

// Update a support case by ID
exports.updateSupportCase = async (req, res) => {
	try {
		const {
			supporterId,
			caseStatus,
			conversation,
			closedBy,
			rating,
			supporterName,
			hotelId,
		} = req.body;

		console.log(req.body, "req.body");

		const updateFields = {};
		if (supporterId) updateFields.supporterId = supporterId;
		if (caseStatus) updateFields.caseStatus = caseStatus;
		if (conversation) updateFields.$push = { conversation: conversation };
		if (closedBy) updateFields.closedBy = closedBy;
		if (rating) updateFields.rating = rating;
		if (supporterName) updateFields.supporterName = supporterName;
		if (hotelId) updateFields.hotelId = hotelId;

		if (Object.keys(updateFields).length === 0) {
			return res
				.status(400)
				.json({ error: "No valid fields provided for update" });
		}

		const updatedCase = await SupportCase.findByIdAndUpdate(
			req.params.id,
			updateFields,
			{
				new: true,
			}
		);

		if (!updatedCase) {
			return res.status(404).json({ error: "Support case not found" });
		}

		if (caseStatus === "closed") {
			req.io.emit("closeCase", { case: updatedCase, closedBy });
		} else if (conversation) {
			req.io.emit("receiveMessage", updatedCase);
		}

		res.status(200).json(updatedCase);
	} catch (error) {
		console.log(error, "error");
		res.status(400).json({ error: error.message });
	}
};

// Create a new support case with specific fields
exports.createNewSupportCase = async (req, res) => {
	try {
		const {
			customerName,
			customerEmail,
			inquiryAbout,
			inquiryDetails,
			supporterId,
			ownerId,
			hotelId,
			role,
			displayName1, // Add displayName1 from the request
			displayName2, // Add displayName2 from the request
			supporterName,
		} = req.body;

		console.log(req.body.displayName1, "displayName1");
		console.log("Received Payload:", req.body);

		if (
			!customerName ||
			!inquiryAbout ||
			!inquiryDetails ||
			!supporterId ||
			!ownerId ||
			!displayName1 || // Ensure displayName1 is provided
			!displayName2 // Ensure displayName2 is provided
		) {
			return res.status(400).json({ error: "All fields are required" });
		}

		const openedBy =
			role === 1000
				? "super admin"
				: role === 2000 || role === 3000 || role === 7000
				? "hotel owner"
				: "client";

		const conversation = [
			{
				messageBy: {
					customerName,
					customerEmail: customerEmail || "superadmin@example.com",
					userId:
						role === 1000
							? supporterId
							: role === 2000
							? ownerId
							: customerEmail,
				},
				message:
					openedBy === "client"
						? "A representative will be with you in 3 to 5 minutes"
						: `New support case created by ${
								openedBy === "super admin"
									? "Xhotelpro Adminstration"
									: openedBy
						  }`,
				inquiryAbout,
				inquiryDetails,
				seenByAdmin: role === 1000,
				seenByHotel: role === 2000,
				seenByCustomer: role === 0,
			},
		];

		const newCase = new SupportCase({
			supporterId,
			ownerId,
			hotelId,
			caseStatus: "open",
			openedBy, // Store who opened the case
			conversation,
			displayName1, // Store the display name of the case opener
			displayName2, // Store the display name of the receiver
			supporterName,
		});

		await newCase.save();

		req.io.emit("newChat", newCase);

		res.status(201).json(newCase);
	} catch (error) {
		console.error("Error creating support case:", error);
		res.status(400).json({ error: error.message });
	}
};

exports.getUnassignedSupportCases = async (req, res) => {
	try {
		const cases = await SupportCase.find({ supporterId: null });
		res.status(200).json(cases);
	} catch (error) {
		res.status(400).json({ error: error.message });
	}
};

exports.getUnassignedSupportCasesCount = async (req, res) => {
	try {
		const count = await SupportCase.countDocuments({ supporterId: null });
		res.status(200).json({ count });
	} catch (error) {
		console.log(error);
		res.status(400).json({ error: error.message });
	}
};

exports.getOpenSupportCases = async (req, res) => {
	try {
		const cases = await SupportCase.find({
			caseStatus: "open",
			openedBy: { $in: ["super admin", "hotel owner"] }, // Adjusting for case sensitivity
		})
			.populate("supporterId")
			.populate("hotelId");

		res.status(200).json(cases);
	} catch (error) {
		res.status(400).json({ error: error.message });
	}
};

exports.getOpenSupportCasesForHotel = async (req, res) => {
	try {
		const { hotelId } = req.params;
		console.log(hotelId, "hotelId");

		// Validate that hotelId is a valid ObjectId
		if (!mongoose.Types.ObjectId.isValid(hotelId)) {
			return res.status(400).json({ error: "Invalid hotel ID" });
		}

		// Find open support cases for the specified hotel
		const cases = await SupportCase.find({
			caseStatus: "open",
			openedBy: { $in: ["super admin", "hotel owner"] }, // Adjusting for case sensitivity
			hotelId: mongoose.Types.ObjectId(hotelId), // Ensure hotelId is treated as ObjectId
		})
			.populate("supporterId")
			.populate("hotelId");

		// Return the cases in the response
		res.status(200).json(cases);
	} catch (error) {
		// Handle any errors that occur during the query
		res.status(400).json({ error: error.message });
	}
};

exports.getOpenSupportCasesClients = async (req, res) => {
	try {
		const cases = await SupportCase.find({
			caseStatus: "open",
			openedBy: { $in: ["client"] }, // Client-related cases only
		})
			.populate("supporterId")
			.populate("hotelId");
		res.status(200).json(cases);
	} catch (error) {
		res.status(400).json({ error: error.message });
	}
};

exports.getCloseSupportCases = async (req, res) => {
	try {
		const cases = await SupportCase.find({
			caseStatus: "closed",
			openedBy: { $in: ["super admin", "hotel owner"] }, // Adjusting for case sensitivity
		})
			.populate("supporterId")
			.populate("hotelId");

		res.status(200).json(cases);
	} catch (error) {
		res.status(400).json({ error: error.message });
	}
};

exports.getCloseSupportCasesForHotel = async (req, res) => {
	try {
		const { hotelId } = req.params;

		// Validate that hotelId is a valid ObjectId
		if (!mongoose.Types.ObjectId.isValid(hotelId)) {
			return res.status(400).json({ error: "Invalid hotel ID" });
		}

		// Find open support cases for the specified hotel
		const cases = await SupportCase.find({
			caseStatus: "closed",
			openedBy: { $in: ["super admin", "hotel owner"] }, // Adjusting for case sensitivity
			hotelId: mongoose.Types.ObjectId(hotelId), // Ensure hotelId is treated as ObjectId
		})
			.populate("supporterId")
			.populate("hotelId");

		// Return the cases in the response
		res.status(200).json(cases);
	} catch (error) {
		// Handle any errors that occur during the query
		res.status(400).json({ error: error.message });
	}
};

exports.getCloseSupportCasesForHotelClients = async (req, res) => {
	try {
		const { hotelId } = req.params;

		// Validate that hotelId is a valid ObjectId
		if (!mongoose.Types.ObjectId.isValid(hotelId)) {
			return res.status(400).json({ error: "Invalid hotel ID" });
		}

		// Find open support cases for the specified hotel
		const cases = await SupportCase.find({
			caseStatus: "closed",
			openedBy: { $in: ["client"] }, // Adjusting for case sensitivity
			hotelId: mongoose.Types.ObjectId(hotelId), // Ensure hotelId is treated as ObjectId
		})
			.populate("supporterId")
			.populate("hotelId");

		// Return the cases in the response
		res.status(200).json(cases);
	} catch (error) {
		// Handle any errors that occur during the query
		res.status(400).json({ error: error.message });
	}
};

exports.getCloseSupportCasesClients = async (req, res) => {
	try {
		const cases = await SupportCase.find({
			caseStatus: "closed",
			openedBy: { $in: ["client"] }, // Adjusting for case sensitivity
		})
			.populate("supporterId")
			.populate("hotelId");

		res.status(200).json(cases);
	} catch (error) {
		res.status(400).json({ error: error.message });
	}
};

//New seen and unseen logic

exports.getUnseenMessagesCountByAdmin = async (req, res) => {
	try {
		const { userId } = req.query;
		console.log("Received userId:", userId);

		// Count the unseen messages where the userId in messageBy does not match the current user
		const count = await SupportCase.aggregate([
			{ $unwind: "$conversation" },
			{
				$match: {
					"conversation.seenByAdmin": false,
					"conversation.messageBy.userId": { $ne: userId }, // Ensure messages sent by others are included
				},
			},
			{ $count: "unseenCount" },
		]);

		console.log("Unseen messages count:", count);

		const unseenCount = count.length > 0 ? count[0].unseenCount : 0;
		res.status(200).json({ count: unseenCount });
	} catch (error) {
		console.error("Error fetching unseen messages count:", error);
		res.status(400).json({ error: error.message });
	}
};

// Fetch unseen messages by Hotel Owner
exports.getUnseenMessagesCountByHotelOwner = async (req, res) => {
	try {
		const { hotelId } = req.params; // Use req.params instead of req.query

		console.log("Received hotelId:", hotelId); // Log the hotelId for debugging

		// Validate that hotelId is a valid ObjectId
		if (!mongoose.Types.ObjectId.isValid(hotelId)) {
			return res.status(400).json({ error: "Invalid hotel ID" });
		}

		// Count the unseen messages for the hotel owner
		const count = await SupportCase.aggregate([
			{ $match: { hotelId: mongoose.Types.ObjectId(hotelId) } },
			{ $unwind: "$conversation" },
			{
				$match: {
					"conversation.seenByHotel": false,
				},
			},
			{ $count: "unseenCount" },
		]);

		console.log("Unseen messages count for hotel owner:", count); // Log the count array

		const unseenCount = count.length > 0 ? count[0].unseenCount : 0;
		res.status(200).json({ count: unseenCount });
	} catch (error) {
		console.error(
			"Error fetching unseen messages count for hotel owner:",
			error
		);
		res.status(400).json({ error: error.message });
	}
};

// Fetch unseen messages by Regular Client
exports.getUnseenMessagesByClient = async (req, res) => {
	try {
		const { clientId } = req.params;

		// Validate that clientId is a valid ObjectId
		if (!mongoose.Types.ObjectId.isValid(clientId)) {
			return res.status(400).json({ error: "Invalid client ID" });
		}

		const unseenMessages = await SupportCase.find({
			"conversation.messageBy.userId": mongoose.Types.ObjectId(clientId),
			caseStatus: { $ne: "closed" },
			"conversation.seenByCustomer": false,
		}).select(
			"conversation._id conversation.messageBy conversation.message conversation.date"
		);

		res.status(200).json(unseenMessages);
	} catch (error) {
		console.error("Error fetching unseen messages for client:", error);
		res.status(400).json({ error: error.message });
	}
};

// Update seen status for Super Admin or PMS Owner
exports.updateSeenStatusForAdminOrOwner = async (req, res) => {
	try {
		const { id } = req.params;
		const role = req.user.role;

		const updateField =
			role === "SuperAdmin"
				? { "conversation.$[].seenByAdmin": true }
				: { "conversation.$[].seenByHotel": true };

		const result = await SupportCase.updateOne(
			{ _id: id, [`conversation.seenBy${role}`]: false },
			{ $set: updateField }
		);

		if (result.nModified === 0) {
			return res
				.status(404)
				.json({ error: "Support case not found or already updated" });
		}

		res.status(200).json({ message: "Seen status updated" });
	} catch (error) {
		res.status(400).json({ error: error.message });
	}
};

// Update seen status for Regular Client
exports.updateSeenStatusForClient = async (req, res) => {
	try {
		const { id } = req.params;

		const result = await SupportCase.updateOne(
			{ _id: id, "conversation.seenByCustomer": false },
			{ $set: { "conversation.$[].seenByCustomer": true } }
		);

		if (result.nModified === 0) {
			return res
				.status(404)
				.json({ error: "Support case not found or already updated" });
		}

		res.status(200).json({ message: "Seen status updated" });
	} catch (error) {
		res.status(400).json({ error: error.message });
	}
};

// Mark all messages as seen by Super Admin
exports.markAllMessagesAsSeenByAdmin = async (req, res) => {
	try {
		const { id } = req.params; // id refers to the support case ID
		const { userId } = req.body; // userId is the admin's ID

		// Update the conversation messages that are not seen by the admin
		const result = await SupportCase.updateOne(
			{ _id: ObjectId(id), "conversation.seenByAdmin": false }, // Match only unseen messages
			{ $set: { "conversation.$[elem].seenByAdmin": true } }, // Mark them as seen
			{
				arrayFilters: [
					{
						"elem.messageBy.userId": { $ne: ObjectId(userId) }, // Exclude the admin's own messages
						"elem.seenByAdmin": false, // Only update if not seen by admin yet
					},
				],
			}
		);

		// If no messages were updated, return a 404 response
		if (result.matchedCount === 0) {
			return res
				.status(404)
				.json({ error: "No unseen messages found or already updated" });
		}

		// Emit the real-time socket event to the specific room (support case ID)
		req.app.get("io").to(id).emit("messageSeen", { caseId: id, userId });

		// Return success response
		res.status(200).json({ message: "All messages marked as seen by Admin" });
	} catch (error) {
		// Handle and log any errors
		console.error("Error:", error);
		res.status(400).json({ error: error.message });
	}
};

exports.markAllMessagesAsSeenByHotels = async (req, res) => {
	try {
		const { id } = req.params;
		const { userId } = req.body;

		console.log(userId, "userId");
		console.log(id, "caseId");

		// Attempt the update
		const result = await SupportCase.updateOne(
			{ _id: ObjectId(id) },
			{ $set: { "conversation.$[elem].seenByHotel": true } },
			{
				arrayFilters: [
					{
						"elem.messageBy.userId": { $exists: true, $ne: ObjectId(userId) },
					},
				],
			}
		);

		if (result.matchedCount === 0) {
			return res
				.status(404)
				.json({ error: "Support case not found or already updated" });
		}

		res
			.status(200)
			.json({ message: "All relevant messages marked as seen by Hotel" });
	} catch (error) {
		console.error("Error:", error);
		res.status(400).json({ error: error.message });
	}
};

exports.markEverythingAsSeen = async (req, res) => {
	try {
		// Update all messages across all cases to be marked as seen
		const result = await SupportCase.updateMany(
			{}, // No filter, meaning all support cases will be updated
			{
				$set: {
					"conversation.$[].seenByAdmin": true,
					"conversation.$[].seenByHotel": true,
					"conversation.$[].seenByCustomer": true,
				},
			}
		);

		// Return a success response
		res.status(200).json({
			message: "All messages in all cases marked as seen",
			updatedCases: result.modifiedCount,
		});
	} catch (error) {
		console.error("Error marking everything as seen:", error);
		res.status(500).json({ error: error.message });
	}
};

exports.deleteMessageFromConversation = async (req, res) => {
	try {
		const { caseId, messageId } = req.params;

		// Validate IDs
		if (
			!mongoose.Types.ObjectId.isValid(caseId) ||
			!mongoose.Types.ObjectId.isValid(messageId)
		) {
			return res.status(400).json({ error: "Invalid case ID or message ID" });
		}

		// Find the support case and remove the specific message
		const updatedCase = await SupportCase.findByIdAndUpdate(
			caseId,
			{
				$pull: { conversation: { _id: messageId } }, // Remove the message with the specific _id
			},
			{ new: true } // Return the updated document
		);

		if (!updatedCase) {
			return res
				.status(404)
				.json({ error: "Support case or message not found" });
		}

		// Emit `messageDeleted` event to all clients in the room
		req.io.to(caseId).emit("messageDeleted", { caseId, messageId });

		res
			.status(200)
			.json({ message: "Message deleted successfully", updatedCase });
	} catch (error) {
		console.error("Error deleting message:", error);
		res.status(500).json({ error: error.message });
	}
};
