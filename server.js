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
const {
	startSupportCaseMaintenanceJob,
} = require("./services/supportCaseMaintenance");

const app = express();
const server = http.createServer(app);

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
		startSupportCaseMaintenanceJob({
			getIo: () => app.get("io"),
			getScheduleAiTurn: () => app.get("scheduleAiPlanTurn"),
		});
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

// AI agent is opt-in and guarded again at case/hotel level.
if (String(process.env.AI_AGENT_ENABLED || "").toLowerCase() === "true") {
	const aiagentMod = require("./aiagent/index.js"); // explicit path to avoid aiagent.js conflicts
	const initAIAgent =
		aiagentMod.initAIAgent || aiagentMod.default || aiagentMod.init || aiagentMod;
	if (typeof initAIAgent !== "function") {
		throw new Error(
			"[aiagent] initAIAgent export not found. Check aiagent/index.js"
		);
	}
	initAIAgent({ app, io });
} else {
	console.log("[aiagent] disabled; set AI_AGENT_ENABLED=true to enable B2C AI support.");
}

// API routes
readdirSync("./routes").map((r) => app.use("/api", require(`./routes/${r}`)));

app.use((err, _req, res, next) => {
	if (!err || err.name !== "UnauthorizedError") return next(err);
	const isExpired =
		err.code === "invalid_token" &&
		(err.inner?.name === "TokenExpiredError" ||
			/jwt expired/i.test(err.message || err.inner?.message || ""));
	return res.status(401).json({
		error: isExpired ? "Session expired. Please sign in again." : "Unauthorized",
		code: isExpired ? "TOKEN_EXPIRED" : "UNAUTHORIZED",
	});
});

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
	socket.on("joinPlatformNotifications", () => {
		socket.join("platform-notifications");
	});
	socket.on("leavePlatformNotifications", () => {
		socket.leave("platform-notifications");
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

const conversationIndexFromPath = (path = "") => {
	const match = String(path || "").match(/^conversation\.(\d+)$/);
	if (!match) return -1;
	const index = Number(match[1]);
	return Number.isFinite(index) ? index : -1;
};

const latestConversationFromUpdate = async (change, caseId) => {
	const updatedFields = change.updateDescription?.updatedFields || {};
	const directConversationUpdates = Object.entries(updatedFields)
		.map(([path, value]) => ({
			index: conversationIndexFromPath(path),
			value,
		}))
		.filter(
			(item) =>
				item.index >= 0 &&
				item.value &&
				typeof item.value === "object" &&
				!Array.isArray(item.value)
		)
		.sort((a, b) => a.index - b.index);

	if (directConversationUpdates.length) {
		return directConversationUpdates[directConversationUpdates.length - 1].value;
	}

	if (Array.isArray(updatedFields.conversation)) {
		return updatedFields.conversation[updatedFields.conversation.length - 1] || null;
	}

	const touchedConversation = Object.keys(updatedFields).some(
		(path) => path === "conversation" || path.startsWith("conversation.")
	);
	if (!touchedConversation || !caseId) return null;

	const latest = await SupportCase.findById(caseId)
		.select({ conversation: { $slice: -1 } })
		.lean()
		.exec();
	return Array.isArray(latest?.conversation) ? latest.conversation[0] : null;
};

const conversationAlreadyEmittedDirectly = (message = {}) =>
	Boolean(
		message.clientTag &&
			(message.isAi ||
				message.isSystem ||
				/jannat-(?:ai-support|system)/i.test(
					String(message.messageBy?.userId || "")
				))
	);

const changedCaseStatus = (change = {}) => {
	const updatedFields = change.updateDescription?.updatedFields || {};
	if (!Object.prototype.hasOwnProperty.call(updatedFields, "caseStatus")) {
		return "";
	}
	return String(updatedFields.caseStatus || "").toLowerCase();
};

const emitClosedCaseSnapshot = async (caseId) => {
	if (!caseId) return false;
	const supportCase = await SupportCase.findById(caseId).lean().exec();
	if (!supportCase || supportCase.caseStatus !== "closed") return false;
	const payload = {
		case: supportCase,
		caseId,
		caseStatus: "closed",
		closedAt: supportCase.closedAt || new Date(),
		closedBy: supportCase.closedBy || "csr",
		reason: supportCase.aiHandoffReason || "case_closed",
	};
	io.emit("supportCaseUpdated", supportCase);
	io.emit("closeCase", payload);
	io.to(caseId).emit("aiPaused", {
		caseId,
		reason: payload.reason,
	});
	return true;
};

// Re-broadcast last conversation line whenever a case is updated
try {
	if (typeof SupportCase.watch === "function") {
		const stream = SupportCase.watch([
			{ $match: { operationType: { $in: ["update", "insert"] } } },
		]);
		stream.on("change", async (ch) => {
			const doc = ch.fullDocument;
			const caseId =
				(ch.documentKey?._id && String(ch.documentKey._id)) ||
				(doc?._id && String(doc._id));
			if (!caseId) return;
			if (ch.operationType === "insert" && doc) {
				io.to(caseId).emit("newChat", { caseId, case: doc });
				return;
			}
			try {
				if (changedCaseStatus(ch) === "closed") {
					await emitClosedCaseSnapshot(caseId);
					return;
				}
				const last = await latestConversationFromUpdate(ch, caseId);
				if (!last || conversationAlreadyEmittedDirectly(last)) return;
				io.to(caseId).emit("receiveMessage", { ...last, caseId });
				io.to(caseId).emit("stopTyping", { caseId });
			} catch (error) {
				console.error("[socket] change stream update error:", error?.message || error);
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
