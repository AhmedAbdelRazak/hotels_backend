// ai-agent/openai.js
const OpenAI = require("openai");

const client = new OpenAI({
	apiKey: process.env.CHATGPT_API_TOKEN, // already in your .env
});

// Prefer GPT‑5 with fallback
const DEFAULT_MODEL = process.env.OPENAI_MODEL || "gpt-5"; // fallback in controller if needed

module.exports = { client, DEFAULT_MODEL };
