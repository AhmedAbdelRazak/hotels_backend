const Rooms = require("../models/rooms");

const STALE_CLEAN_ROOM_HOURS = 48;
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_INITIAL_DELAY_MS = 30 * 1000;

const markStaleCleanRoomsDirty = async ({ now = new Date(), logger = console } = {}) => {
	const cutoff = new Date(now.getTime() - STALE_CLEAN_ROOM_HOURS * 60 * 60 * 1000);

	const result = await Rooms.updateMany(
		{
			cleanRoom: true,
			$or: [
				{ housekeepingLastCleanedAt: { $lte: cutoff } },
				{
					housekeepingLastCleanedAt: { $exists: false },
					updatedAt: { $lte: cutoff },
				},
			],
		},
		{
			$set: {
				cleanRoom: false,
				housekeepingLastDirtyAt: now,
				housekeepingDirtyReason: "not_cleaned_48_hours",
			},
		}
	);

	const modifiedCount = result.modifiedCount ?? result.nModified ?? 0;
	if (modifiedCount > 0) {
		logger.log(
			`[housekeeping] Marked ${modifiedCount} rooms dirty because they were not cleaned in the last ${STALE_CLEAN_ROOM_HOURS} hours.`
		);
	}
	return { modifiedCount, cutoff };
};

const startHousekeepingMaintenanceJob = ({
	intervalMs = DEFAULT_INTERVAL_MS,
	initialDelayMs = DEFAULT_INITIAL_DELAY_MS,
	logger = console,
} = {}) => {
	let running = false;

	const run = async () => {
		if (running) return;
		running = true;
		try {
			await markStaleCleanRoomsDirty({ logger });
		} catch (error) {
			logger.error("[housekeeping] Maintenance job failed:", error?.message || error);
		} finally {
			running = false;
		}
	};

	const initialTimer = setTimeout(run, initialDelayMs);
	const intervalTimer = setInterval(run, intervalMs);

	return {
		run,
		stop: () => {
			clearTimeout(initialTimer);
			clearInterval(intervalTimer);
		},
	};
};

module.exports = {
	markStaleCleanRoomsDirty,
	startHousekeepingMaintenanceJob,
};
