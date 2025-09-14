/** @format */

const express = require("express");
const mongoose = require("mongoose");
const morgan = require("morgan");
const cors = require("cors");
const { readdirSync } = require("fs");
require("dotenv").config();
const http = require("http");
const socketIo = require("socket.io");
const cron = require("node-cron");
const axios = require("axios");

// Initialize Express app
const app = express();
const server = http.createServer(app);

// Database connection
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

app.get("/", (req, res) => {
	res.send("Hello From PMS API");
});

// Create the io instance
const io = socketIo(server, {
	cors: {
		origin: "*",
		methods: ["GET", "POST"],
		allowedHeaders: ["Authorization"],
		credentials: true,
	},
});

//Confirmation link on update is important

// Pass the io instance to the app
app.set("io", io);
const { initAIAgent } = require("./ai-agent");
initAIAgent({ app, io });

// Route middlewares
readdirSync("./routes").map((r) => app.use("/api", require(`./routes/${r}`)));

// Schedule task to run every 15 minutes (example task, replace with your logic)
//I will adjust later but this is important
// cron.schedule("*/15 * * * *", async () => {
// 	try {
// 		console.log("Running scheduled task");
// 		// Replace with your actual scheduled task logic
// 		const response = await axios.get("http://localhost:8080/api/get-some-data");
// 		console.log("Task completed successfully");
// 	} catch (error) {
// 		console.error("Error during scheduled task:", error);
// 	}
// });

// Server port configuration
const port = process.env.PORT || 8080;

server.listen(port, () => {
	console.log(`Server is running on port ${port}`);
});

// Socket.io event handling
io.on("connection", (socket) => {
	console.log("A user connected:", socket.id);

	// Join a specific room
	socket.on("joinRoom", ({ caseId }) => {
		if (caseId) {
			socket.join(caseId); // Join the room with the given caseId
			console.log(`Socket ${socket.id} joined room: ${caseId}`);
		}
	});

	// Leave the room when a user disconnects
	socket.on("leaveRoom", ({ caseId }) => {
		if (caseId) {
			socket.leave(caseId); // Leave the room with the given caseId
			console.log(`Socket ${socket.id} left room: ${caseId}`);
		}
	});

	socket.on("sendMessage", (message) => {
		console.log("Message received: ", message);
		io.emit("receiveMessage", message);
	});

	socket.on("typing", (data) => {
		io.emit("typing", data);
	});

	socket.on("stopTyping", (data) => {
		io.emit("stopTyping", data);
	});

	socket.on("newChat", (data) => {
		// Emit the new chat with relevant data to filter on the frontend
		io.emit("newChat", {
			_id: data._id,
			caseStatus: data.caseStatus,
			openedBy: data.openedBy, // Include openedBy to filter on the frontend
			hotelId: data.hotelId,
			conversation: data.conversation,
			// ...otherData, // Any other data you need
		});
	});

	socket.on("disconnect", (reason) => {
		console.log(`A user disconnected: ${reason}`);
	});

	socket.on("deleteMessage", ({ caseId, messageId }) => {
		console.log(`Message deleted in case ${caseId}: ${messageId}`);

		// Notify all clients in the specific case room
		io.to(caseId).emit("messageDeleted", { caseId, messageId });
	});

	socket.on("connect_error", (error) => {
		console.error(`Connection error: ${error.message}`);
	});
});
