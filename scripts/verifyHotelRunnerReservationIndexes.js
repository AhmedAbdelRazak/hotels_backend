/** @format */

"use strict";

require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });

const mongoose = require("mongoose");

// This command is an observation-only production gate. Disable Mongoose's
// implicit collection/index creation before importing the Reservations model
// through the readiness service.
mongoose.set("autoIndex", false);
mongoose.set("autoCreate", false);

const {
	verifyHotelRunnerReservationIndexes,
} = require("../services/hotelrunnerReservationIndexReadiness");
const { safeErrorMessage } = require("../services/hotelrunnerEventService");

const main = async () => {
	if (!process.env.DATABASE) throw new Error("DATABASE is not configured");
	mongoose.set("strictQuery", false);
	await mongoose.connect(process.env.DATABASE, {
		useNewUrlParser: true,
		useUnifiedTopology: true,
		autoIndex: false,
		autoCreate: false,
	});
	try {
		const result = await verifyHotelRunnerReservationIndexes();
		console.log(
			`HotelRunner reservation index readiness passed (${result.verifiedIndexes.join(
				", "
			)}).`
		);
	} finally {
		await mongoose.disconnect();
	}
};

if (require.main === module) {
	main().catch(async (error) => {
		console.error("HotelRunner reservation index readiness failed", {
			code: String(error?.code || "HOTELRUNNER_RESERVATION_INDEX_VERIFY_FAILED").slice(
				0,
				100
			),
			message: safeErrorMessage(error, "Index verification failed"),
		});
		process.exitCode = 1;
		if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
	});
}

module.exports = { main };
