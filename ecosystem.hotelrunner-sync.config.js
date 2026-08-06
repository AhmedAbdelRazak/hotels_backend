/** @format */

module.exports = {
	apps: [
		{
			name: "hotelrunner-sync",
			script: "workers/hotelrunnerSyncWorker.js",
			cwd: __dirname,
			instances: 1,
			exec_mode: "fork",
			autorestart: true,
			restart_delay: 5000,
			kill_timeout: 15000,
			max_memory_restart: "256M",
			time: true,
			env: { NODE_ENV: "production" },
		},
	],
};
