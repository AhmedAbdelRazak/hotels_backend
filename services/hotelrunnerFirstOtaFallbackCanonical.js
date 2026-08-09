/** @format */

const crypto = require("crypto");

function stableValue(value, seen = new WeakSet()) {
	if (value === null || value === undefined) {
		return value === undefined ? null : value;
	}
	if (value instanceof Date) return value.toISOString();
	if (Buffer.isBuffer(value)) return value.toString("base64");
	if (typeof value === "bigint") return value.toString();
	if (typeof value !== "object") return value;
	if (typeof value.toHexString === "function") return value.toHexString();
	if (seen.has(value)) {
		const error = new Error(
			"The archived OTA reservation snapshot contains a cycle."
		);
		error.code = "HOTELRUNNER_FALLBACK_ARCHIVE_NOT_SERIALIZABLE";
		throw error;
	}
	seen.add(value);
	const result = Array.isArray(value)
		? value.map((item) => stableValue(item, seen))
		: Object.keys(value)
				.sort()
				.reduce((output, key) => {
					if (value[key] !== undefined) {
						output[key] = stableValue(value[key], seen);
					}
					return output;
				}, {});
	seen.delete(value);
	return result;
}

const stableStringify = (value) => JSON.stringify(stableValue(value));
const sha256 = (value) =>
	crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
const hashStable = (value) => sha256(stableStringify(value));

module.exports = {
	hashStable,
	sha256,
	stableStringify,
};
