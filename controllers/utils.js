const crypto = require("crypto");
const jwt = require("jsonwebtoken");

// AES encryption algorithm
const algorithm = "aes-256-cbc";
// Ensure the secret key length is 32 bytes
const secretKey = crypto
	.createHash("sha256")
	.update(String(process.env.JWT_SECRET2))
	.digest("base64")
	.substr(0, 32);

/**
 * Encrypts a value using AES-256-CBC.
 * @param {string} value - The value to encrypt.
 * @returns {string} - The encrypted value in the format: IV:EncryptedData.
 */
function encryptWithSecret(value) {
	if (!value) return "";

	// Generate a new IV for each encryption
	const iv = crypto.randomBytes(16);
	const cipher = crypto.createCipheriv(algorithm, Buffer.from(secretKey), iv);

	let encrypted = cipher.update(value, "utf-8", "hex");
	encrypted += cipher.final("hex");

	// Combine the IV and encrypted data, separated by a colon
	return `${iv.toString("hex")}:${encrypted}`;
}

/**
 * Decrypts an encrypted value using AES-256-CBC.
 * @param {string} encryptedValue - The encrypted value in the format: IV:EncryptedData.
 * @returns {string} - The decrypted value.
 */
function decryptWithSecret(encryptedValue) {
	if (!encryptedValue) return "";

	// Split the IV and encrypted data
	const [ivHex, encrypted] = encryptedValue.split(":");
	if (!ivHex || !encrypted) throw new Error("Invalid encrypted value format");

	const decipher = crypto.createDecipheriv(
		algorithm,
		Buffer.from(secretKey),
		Buffer.from(ivHex, "hex")
	);

	let decrypted = decipher.update(encrypted, "hex", "utf-8");
	decrypted += decipher.final("utf-8");

	return decrypted;
}

function verifyToken(token) {
	try {
		const decoded = jwt.verify(token, process.env.JWT_SECRET2);
		return { valid: true, expired: false, decoded };
	} catch (err) {
		if (err.name === "TokenExpiredError") {
			return { valid: false, expired: true };
		}
		return { valid: false, expired: false };
	}
}

module.exports = { encryptWithSecret, decryptWithSecret, verifyToken };
