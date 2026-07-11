/** @format */

require("dotenv").config({ path: require("path").resolve(__dirname, "../../.env") });

const path = require("path");
const mongoose = require("mongoose");
const {
	syncHotelOpenAiVector,
} = require("../../services/hotelOpenAiVectorSync");
const { DEFAULT_TIMEZONE } = require("../../services/hotelOpenAiKnowledge");

const parseArgs = (argv) => {
	const args = {};
	for (let index = 0; index < argv.length; index += 1) {
		const item = argv[index];
		if (!item.startsWith("--")) continue;
		const key = item.slice(2);
		if (["dry-run", "force", "disable-auto-sync"].includes(key)) {
			args[key] = true;
			continue;
		}
		args[key] = argv[index + 1];
		index += 1;
	}
	return args;
};

const main = async () => {
	const args = parseArgs(process.argv.slice(2));
	const hotelId = String(args["hotel-id"] || "").trim();
	const coverageThrough = String(args["horizon-end"] || "").trim();
	const coverageFrom = String(args["horizon-start"] || "").trim();
	const timezone = String(args.timezone || DEFAULT_TIMEZONE).trim();
	if (!mongoose.isValidObjectId(hotelId)) {
		throw new Error("--hotel-id must be a valid ObjectId");
	}
	if (!/^20\d{2}-\d{2}-\d{2}$/.test(coverageThrough)) {
		throw new Error("--horizon-end must use YYYY-MM-DD");
	}
	if (coverageFrom && !/^20\d{2}-\d{2}-\d{2}$/.test(coverageFrom)) {
		throw new Error("--horizon-start must use YYYY-MM-DD");
	}
	if (!process.env.DATABASE) throw new Error("DATABASE is not configured");
	if (!args["dry-run"] && !process.env.OPENAI_API_KEY) {
		throw new Error("OPENAI_API_KEY is not configured");
	}

	await mongoose.connect(process.env.DATABASE, {
		useNewUrlParser: true,
		useUnifiedTopology: true,
	});
	const result = await syncHotelOpenAiVector({
		hotelId,
		coverageFrom,
		coverageThrough,
		timezone,
		force: Boolean(args.force),
		dryRun: Boolean(args["dry-run"]),
		autoSyncEnabled: !args["disable-auto-sync"],
		outputAudit: true,
		auditRoot: path.resolve(__dirname, "../../audits/ai-knowledge"),
	});
	console.log(JSON.stringify(result, null, 2));
};

if (require.main === module) {
	main()
		.catch((error) => {
			console.error(JSON.stringify({ status: "failed", error: error.message }, null, 2));
			process.exitCode = 1;
		})
		.finally(async () => {
			await mongoose.disconnect();
		});
}

module.exports = { main, parseArgs };
