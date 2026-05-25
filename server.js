/** @format */
const express = require("express");
const mongoose = require("mongoose");
const morgan = require("morgan");
const cors = require("cors");
const { readdirSync } = require("fs");
const path = require("path");
require("dotenv").config();
const http = require("http");
const socketIo = require("socket.io");
const {
	startHousekeepingMaintenanceJob,
} = require("./services/housekeepingMaintenance");
const {
	startB2BChatMaintenanceJob,
} = require("./services/b2bChatMaintenance");

const app = express();
const server = http.createServer(app);
//IMPORTANT TO ASK YOUR FRIEND => ANY RESERVATION ACROSS THE BOARD SHOULD INCLUDE THE ROOMID WHICH IS THE COMBNINATION OF DISPLAYNAME & ROOMTYPE.
//THIS ID IS IMPORTANT, BECAUSE IF THE SETTINGS OF DISPLAYNAME CHANGED, THEN THE OCCUPANCY REPORT SHOULD CONSIDER THE ID FIRST THEN DISPLAYNAME SECOND
// IF ROOMID DOESN'T EXIST IN THE DOCUMENT OF RESERVATION.
mongoose.set("strictQuery", false);
mongoose
	.connect(process.env.DATABASE, {
		useNewUrlParser: true,
		useUnifiedTopology: true,
	})
	.then(() => {
		console.log("MongoDB Atlas is connected");
		startHousekeepingMaintenanceJob();
		startB2BChatMaintenanceJob();
	})
	.catch((err) => console.log("DB Connection Error: ", err));

// Middlewares
app.use(morgan("dev"));
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));
app.get("/", (_req, res) => res.send("Hello From PMS API"));

// Socket.IO
const io = socketIo(server, {
	cors: {
		origin: "*",
		methods: ["GET", "POST"],
		allowedHeaders: ["Authorization"],
		credentials: true,
	},
	transports: ["websocket", "polling"],
	pingTimeout: 25000,
	pingInterval: 20000,
});
app.set("io", io);

// // AI agent
// const aiagentMod = require("./aiagent/index.js"); // explicit path to avoid aiagent.js conflicts
// const initAIAgent =
// 	aiagentMod.initAIAgent || aiagentMod.default || aiagentMod.init || aiagentMod;
// if (typeof initAIAgent !== "function") {
// 	throw new Error(
// 		"[aiagent] initAIAgent export not found. Check aiagent/index.js"
// 	);
// }
// initAIAgent({ app, io });

// API routes
readdirSync("./routes").map((r) => app.use("/api", require(`./routes/${r}`)));

const port = process.env.PORT || 8080;
server.listen(port, () => console.log(`Server is running on port ${port}`));

/* ===== room-scoped relays + DB watcher for late-joiners ===== */
const SupportCase = require("./models/supportcase");

io.on("connection", (socket) => {
	socket.on("joinRoom", ({ caseId }) => caseId && socket.join(caseId));
	socket.on("leaveRoom", ({ caseId }) => caseId && socket.leave(caseId));
	socket.on("joinHousekeeping", ({ hotelId } = {}) => {
		if (hotelId) socket.join(`housekeeping:${hotelId}`);
	});
	socket.on("leaveHousekeeping", ({ hotelId } = {}) => {
		if (hotelId) socket.leave(`housekeeping:${hotelId}`);
	});
	socket.on("joinHotelNotifications", ({ hotelId } = {}) => {
		if (hotelId) socket.join(`hotel-notifications:${hotelId}`);
	});
	socket.on("leaveHotelNotifications", ({ hotelId } = {}) => {
		if (hotelId) socket.leave(`hotel-notifications:${hotelId}`);
	});
	socket.on("joinOwnerNotifications", ({ ownerId } = {}) => {
		if (ownerId) socket.join(`owner-notifications:${ownerId}`);
	});
	socket.on("leaveOwnerNotifications", ({ ownerId } = {}) => {
		if (ownerId) socket.leave(`owner-notifications:${ownerId}`);
	});
	socket.on("joinB2BChat", ({ chatId } = {}) => {
		if (chatId) socket.join(`b2b-chat:${chatId}`);
	});
	socket.on("leaveB2BChat", ({ chatId } = {}) => {
		if (chatId) socket.leave(`b2b-chat:${chatId}`);
	});
	socket.on("joinB2BUser", ({ userId } = {}) => {
		if (userId) socket.join(`b2b-user:${userId}`);
	});
	socket.on("leaveB2BUser", ({ userId } = {}) => {
		if (userId) socket.leave(`b2b-user:${userId}`);
	});
	socket.on("joinB2BHotel", ({ hotelId } = {}) => {
		if (hotelId) socket.join(`b2b-hotel:${hotelId}`);
	});
	socket.on("leaveB2BHotel", ({ hotelId } = {}) => {
		if (hotelId) socket.leave(`b2b-hotel:${hotelId}`);
	});
	socket.on("joinB2BPlatform", () => {
		socket.join("b2b-platform");
	});
	socket.on("leaveB2BPlatform", () => {
		socket.leave("b2b-platform");
	});
	socket.on("b2bTyping", (data = {}) => {
		const chatId = data?.chatId;
		if (chatId) {
			socket.to(`b2b-chat:${chatId}`).emit("b2bTyping", data);
		}
	});
	socket.on("b2bStopTyping", (data = {}) => {
		const chatId = data?.chatId;
		if (chatId) {
			socket.to(`b2b-chat:${chatId}`).emit("b2bStopTyping", data);
		}
	});

	socket.on("typing", (data = {}) => {
		const room = data?.caseId;
		if (room) io.to(room).emit("typing", { ...data, isAi: false });
	});
	socket.on("stopTyping", (data = {}) => {
		const room = data?.caseId;
		if (room) io.to(room).emit("stopTyping", { ...data, isAi: false });
	});

	// Echo guest message to room immediately; AI will also reply to same room
	socket.on("sendMessage", (message) => {
		const room = message?.caseId;
		if (room) io.to(room).emit("receiveMessage", message);
	});
});

// Re-broadcast last conversation line whenever a case is updated
try {
	if (typeof SupportCase.watch === "function") {
		const stream = SupportCase.watch(
			[{ $match: { operationType: { $in: ["update", "insert"] } } }],
			{ fullDocument: "updateLookup" }
		);
		stream.on("change", (ch) => {
			const doc = ch.fullDocument;
			const caseId = doc?._id && String(doc._id);
			if (!caseId) return;
			if (ch.operationType === "insert") {
				io.to(caseId).emit("newChat", { caseId, case: doc });
				return;
			}
			const updated = ch.updateDescription?.updatedFields || {};
			const touched = Object.keys(updated).some((k) =>
				k.startsWith("conversation.")
			);
			if (!touched) return;
			const last =
				Array.isArray(doc.conversation) &&
				doc.conversation[doc.conversation.length - 1];
			if (last) {
				io.to(caseId).emit("receiveMessage", { ...last, caseId });
				io.to(caseId).emit("stopTyping", { caseId });
			}
		});
		stream.on("error", (e) =>
			console.error("[socket] change stream error:", e?.message || e)
		);
		console.log(
			"[socket] DB watcher broadcasting conversation updates enabled."
		);
	}
} catch (e) {
	console.log("[socket] Change streams not available:", e?.message || e);
}
