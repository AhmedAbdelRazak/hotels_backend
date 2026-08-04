/** @format */

module.exports = {
	apps: [
		{
			name: "hotel-openai-sync",
			script: "workers/hotelOpenAiKnowledgeSyncWorker.js",
			cwd: __dirname,
			instances: 1,
			exec_mode: "fork",
			autorestart: true,
			restart_delay: 5000,
			kill_timeout: 330000,
			// An unchanged 11-hotel reconciliation has a measured working set of
			// roughly 350-390 MiB. Keep a bounded guard above that normal peak so
			// PM2 does not restart the worker and immediately repeat reconciliation.
			max_memory_restart: "512M",
			time: true,
			env: {
				NODE_ENV: "production",
			},
		},
	],
};
