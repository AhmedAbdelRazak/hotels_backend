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
			max_memory_restart: "300M",
			time: true,
			env: {
				NODE_ENV: "production",
			},
		},
	],
};
