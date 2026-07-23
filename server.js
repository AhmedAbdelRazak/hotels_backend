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
const {
	hotelReviewJsonParser,
} = require("./services/hotelReviewJsonParser");
const {
	guestCardJsonParser,
} = require("./services/guestCardJsonParser");
const {
	ensureInboundDedupeIndex,
} = require("./services/otaInboundDedupeIndex");

const app = express();
const server = http.createServer(app);

const splitEnvList = (value = "") =>
	String(value || "")
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);

const configuredCorsOrigins = [
	"https://xhotelpro.com",
	"https://www.xhotelpro.com",
	"https://jannatbooking.com",
	"https://www.jannatbooking.com",
	"https://zadhotels.com",
	"https://www.zadhotels.com",
	"http://localhost:3000",
	"http://localhost:3001",
	"http://localhost:5173",
	...splitEnvList(process.env.CORS_ALLOWED_ORIGINS),
	...splitEnvList(process.env.SOCKET_CORS_ALLOWED_ORIGINS),
	process.env.CLIENT_URL,
	process.env.CLIENT_URL_XHOTEL,
	process.env.PUBLIC_CLIENT_URL,
	process.env.FRONTEND_URL,
	process.env.REACT_APP_MAIN_URL_JANNAT,
]
	.map((origin) => String(origin || "").replace(/\/+$/, "").toLowerCase())
	.filter(Boolean);

const configuredCorsHostSuffixes = [
	".xhotelpro.com",
	".jannatbooking.com",
	".zadhotels.com",
	...splitEnvList(process.env.CORS_ALLOWED_HOST_SUFFIXES),
	...splitEnvList(process.env.SOCKET_CORS_ALLOWED_HOST_SUFFIXES),
].map((suffix) => suffix.toLowerCase());

const allowedCorsOrigins = new Set(configuredCorsOrigins);

function isAllowedCorsOrigin(origin = "") {
	if (!origin) return true;
	try {
		const parsed = new URL(origin);
		const normalizedOrigin = parsed.origin.toLowerCase();
		const hostname = parsed.hostname.toLowerCase();
		return (
			allowedCorsOrigins.has(normalizedOrigin) ||
			configuredCorsHostSuffixes.some(
				(suffix) => hostname.endsWith(suffix) || hostname === suffix.slice(1)
			)
		);
	} catch {
		return false;
	}
}

function corsOrigin(origin, callback) {
	callback(null, isAllowedCorsOrigin(origin));
}

const corsOptions = {
	origin: corsOrigin,
	credentials: true,
};

mongoose.set("strictQuery", false);
mongoose
	.connect(process.env.DATABASE, {
		useNewUrlParser: true,
		useUnifiedTopology: true,
	})
	.then(async () => {
		console.log("MongoDB Atlas is connected");
		try {
			await ensureInboundDedupeIndex();
			console.log("Inbound email dedupe index is ready");
		} catch (error) {
			console.error("Inbound email dedupe index setup failed:", error.cause || error);
		}
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
app.use(cors(corsOptions));

// Review submissions and moderation payloads are intentionally tiny. Parse
// these paths before the legacy 50 MB parser so oversized public input is
// rejected without changing any existing PMS upload/request behavior.
app.use(
	["/api/hotel-reviews", "/api/admin/hotel-reviews"],
	hotelReviewJsonParser
);
// Guest Card email accepts one small JSON field. Reject oversized bodies before
// they reach the legacy parser used by PMS upload-heavy endpoints.
app.use(
	/^\/api\/admin\/reservations\/[^/]+\/guest-card\/email\/[^/]+\/?$/,
	guestCardJsonParser
);
app.use(express.json({ limit: "50mb" }));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));
app.get("/", (_req, res) => res.send("Hello From PMS API"));

// Socket.IO
const io = socketIo(server, {
	cors: {
		origin: corsOrigin,
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

const SUPPORT_CASE_ROOM_CACHE_TTL_MS = 5 * 60 * 1000;
const supportCaseRoomCache = new Map();

const objectIdText = (value = "") => {
	const text = String(value || "").trim();
	if (!mongoose.Types.ObjectId.isValid(text)) return "";
	return text;
};

async function supportCaseRoomExists(caseId = "") {
	const cleanCaseId = objectIdText(caseId);
	if (!cleanCaseId) return false;
	const cached = supportCaseRoomCache.get(cleanCaseId);
	if (cached && cached.expiresAt > Date.now()) return cached.exists;
	const exists = Boolean(
		await SupportCase.exists({ _id: cleanCaseId }).catch(() => null)
	);
	supportCaseRoomCache.set(cleanCaseId, {
		exists,
		expiresAt: Date.now() + SUPPORT_CASE_ROOM_CACHE_TTL_MS,
	});
	return exists;
}

async function joinSupportCaseRoom(socket, caseId = "") {
	const cleanCaseId = objectIdText(caseId);
	if (!cleanCaseId) return;
	if (await supportCaseRoomExists(cleanCaseId)) {
		socket.join(cleanCaseId);
	}
}

function leaveSupportCaseRoom(socket, caseId = "") {
	const cleanCaseId = objectIdText(caseId);
	if (cleanCaseId) socket.leave(cleanCaseId);
}

function joinObjectScopedRoom(socket, prefix = "", id = "") {
	const cleanId = objectIdText(id);
	if (prefix && cleanId) socket.join(`${prefix}:${cleanId}`);
}

function leaveObjectScopedRoom(socket, prefix = "", id = "") {
	const cleanId = objectIdText(id);
	if (prefix && cleanId) socket.leave(`${prefix}:${cleanId}`);
}

io.on("connection", (socket) => {
	socket.on("joinRoom", ({ caseId } = {}) => {
		joinSupportCaseRoom(socket, caseId).catch((error) =>
			console.error("[socket] joinRoom failed:", error?.message || error)
		);
	});
	socket.on("leaveRoom", ({ caseId } = {}) => leaveSupportCaseRoom(socket, caseId));
	socket.on("joinHousekeeping", ({ hotelId } = {}) => {
		joinObjectScopedRoom(socket, "housekeeping", hotelId);
	});
	socket.on("leaveHousekeeping", ({ hotelId } = {}) => {
		leaveObjectScopedRoom(socket, "housekeeping", hotelId);
	});
	socket.on("joinHotelNotifications", ({ hotelId } = {}) => {
		joinObjectScopedRoom(socket, "hotel-notifications", hotelId);
	});
	socket.on("leaveHotelNotifications", ({ hotelId } = {}) => {
		leaveObjectScopedRoom(socket, "hotel-notifications", hotelId);
	});
	socket.on("joinOwnerNotifications", ({ ownerId } = {}) => {
		joinObjectScopedRoom(socket, "owner-notifications", ownerId);
	});
	socket.on("leaveOwnerNotifications", ({ ownerId } = {}) => {
		leaveObjectScopedRoom(socket, "owner-notifications", ownerId);
	});
	socket.on("joinPlatformNotifications", () => {
		socket.join("platform-notifications");
	});
	socket.on("leavePlatformNotifications", () => {
		socket.leave("platform-notifications");
	});
	socket.on("joinB2BChat", ({ chatId } = {}) => {
		joinObjectScopedRoom(socket, "b2b-chat", chatId);
	});
	socket.on("leaveB2BChat", ({ chatId } = {}) => {
		leaveObjectScopedRoom(socket, "b2b-chat", chatId);
	});
	socket.on("joinB2BUser", ({ userId } = {}) => {
		joinObjectScopedRoom(socket, "b2b-user", userId);
	});
	socket.on("leaveB2BUser", ({ userId } = {}) => {
		leaveObjectScopedRoom(socket, "b2b-user", userId);
	});
	socket.on("joinB2BHotel", ({ hotelId } = {}) => {
		joinObjectScopedRoom(socket, "b2b-hotel", hotelId);
	});
	socket.on("leaveB2BHotel", ({ hotelId } = {}) => {
		leaveObjectScopedRoom(socket, "b2b-hotel", hotelId);
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

	socket.on("typing", async (data = {}) => {
		const room = objectIdText(data?.caseId);
		if (room && (await supportCaseRoomExists(room))) {
			io.to(room).emit("typing", { ...data, caseId: room, isAi: false });
		}
	});
	socket.on("stopTyping", async (data = {}) => {
		const room = objectIdText(data?.caseId);
		if (room && (await supportCaseRoomExists(room))) {
			io.to(room).emit("stopTyping", { ...data, caseId: room, isAi: false });
		}
	});

	// Echo guest message to room immediately; AI will also reply to same room
	socket.on("sendMessage", async (message = {}) => {
		const room = objectIdText(message?.caseId);
		if (room && (await supportCaseRoomExists(room))) {
			io.to(room).emit("receiveMessage", { ...message, caseId: room });
		}
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
			!String(message.clientTag || "").startsWith("ai_worker_") &&
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
