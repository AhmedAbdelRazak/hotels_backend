/** @format */
const express = require("express");
const mongoose = require("mongoose");
const morgan = require("morgan");
const cors = require("cors");
const { readdirSync } = require("fs");
require("dotenv").config();
const http = require("http");
const socketIo = require("socket.io");

const app = express();
const server = http.createServer(app);

// Mongo
mongoose.set("strictQuery", false);
mongoose
	.connect(process.env.DATABASE, {
		useNewUrlParser: true,
		useUnifiedTopology: true,
	})
	.then(() => console.log("MongoDB Atlas is connected"))
	.catch((err) => console.log("DB Connection Error: ", err));

// Middlewares
app.use(morgan("dev"));
app.use(cors());
app.use(express.json({ limit: "50mb" }));
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

// AI agent
const aiagentMod = require("./aiagent/index.js"); // explicit path to avoid aiagent.js conflicts
const initAIAgent =
	aiagentMod.initAIAgent || aiagentMod.default || aiagentMod.init || aiagentMod;
if (typeof initAIAgent !== "function") {
	throw new Error(
		"[aiagent] initAIAgent export not found. Check aiagent/index.js"
	);
}
initAIAgent({ app, io });

// API routes
readdirSync("./routes").map((r) => app.use("/api", require(`./routes/${r}`)));

const port = process.env.PORT || 8080;
server.listen(port, () => console.log(`Server is running on port ${port}`));

/* ===== room-scoped relays + DB watcher for late-joiners ===== */
const SupportCase = require("./models/supportcase");

io.on("connection", (socket) => {
	socket.on("joinRoom", ({ caseId }) => caseId && socket.join(caseId));
	socket.on("leaveRoom", ({ caseId }) => caseId && socket.leave(caseId));

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
