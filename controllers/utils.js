const crypto = require("crypto");

const algorithm = "aes-256-cbc"; // AES encryption algorithm
const secretKey = process.env.JWT_SECRET2; // Use JWT_SECRET2
const iv = crypto.randomBytes(16); // Initialization vector (IV)

/**
 * Encrypts a value using AES-256-CBC.
 * @param {string} value - The value to encrypt.
 * @returns {string} - The encrypted value in base64 format.
 */
function encryptWithSecret(value) {
	if (!value) return "";
	const cipher = crypto.createCipheriv(algorithm, Buffer.from(secretKey), iv);
	let encrypted = cipher.update(value, "utf-8", "hex");
	encrypted += cipher.final("hex");
	return `${iv.toString("hex")}:${encrypted}`; // Return IV + Encrypted string
}

/**
 * Decrypts an encrypted value using AES-256-CBC.
 * @param {string} encryptedValue - The encrypted value in base64 format.
 * @returns {string} - The decrypted value.
 */
function decryptWithSecret(encryptedValue) {
	if (!encryptedValue) return "";
	const [ivHex, encrypted] = encryptedValue.split(":");
	const decipher = crypto.createDecipheriv(
		algorithm,
		Buffer.from(secretKey),
		Buffer.from(ivHex, "hex")
	);
	let decrypted = decipher.update(encrypted, "hex", "utf-8");
	decrypted += decipher.final("utf-8");
	return decrypted;
}

module.exports = { encryptWithSecret, decryptWithSecret };
