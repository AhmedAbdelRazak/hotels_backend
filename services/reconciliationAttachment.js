/** @format */

"use strict";

const cloudinary = require("cloudinary");
const multer = require("multer");

const MAX_RECONCILIATION_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_RECONCILIATION_PAYLOAD_BYTES = 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set([
	"application/pdf",
	"image/jpeg",
	"image/png",
	"image/webp",
]);

cloudinary.config({
	cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
	api_key: process.env.CLOUDINARY_API_KEY,
	api_secret: process.env.CLOUDINARY_API_SECRET,
});

class ReconciliationAttachmentError extends Error {
	constructor(message, code = "invalid_reconciliation_attachment", statusCode = 400) {
		super(message);
		this.name = "ReconciliationAttachmentError";
		this.code = code;
		this.statusCode = statusCode;
	}
}

const normalizedMimeType = (value = "") => {
	const mimeType = String(value || "").trim().toLowerCase();
	return mimeType === "image/jpg" ? "image/jpeg" : mimeType;
};

const bufferStartsWith = (buffer, signature, offset = 0) =>
	Buffer.isBuffer(buffer) &&
	buffer.length >= offset + signature.length &&
	signature.every((byte, index) => buffer[offset + index] === byte);

const detectAttachmentMimeType = (buffer) => {
	if (!Buffer.isBuffer(buffer) || !buffer.length) return "";
	if (bufferStartsWith(buffer, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
		return "application/pdf";
	}
	if (bufferStartsWith(buffer, [0xff, 0xd8, 0xff])) return "image/jpeg";
	if (
		bufferStartsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
	) {
		return "image/png";
	}
	if (
		bufferStartsWith(buffer, [0x52, 0x49, 0x46, 0x46]) &&
		bufferStartsWith(buffer, [0x57, 0x45, 0x42, 0x50], 8)
	) {
		return "image/webp";
	}
	return "";
};

const sanitizeAttachmentName = (value = "") =>
	String(value || "reconciliation-attachment")
		.replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
		.replace(/[\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069]/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 160) || "reconciliation-attachment";

const validateReconciliationAttachment = (file) => {
	if (!file) return null;
	if (!Buffer.isBuffer(file.buffer) || !file.buffer.length) {
		throw new ReconciliationAttachmentError(
			"The reconciliation attachment is empty",
			"empty_reconciliation_attachment"
		);
	}
	if (file.buffer.length > MAX_RECONCILIATION_ATTACHMENT_BYTES) {
		throw new ReconciliationAttachmentError(
			"The reconciliation attachment must be 10MB or smaller",
			"reconciliation_attachment_too_large",
			413
		);
	}
	const declaredMimeType = normalizedMimeType(file.mimetype);
	const detectedMimeType = detectAttachmentMimeType(file.buffer);
	if (
		!ALLOWED_MIME_TYPES.has(declaredMimeType) ||
		!detectedMimeType ||
		detectedMimeType !== declaredMimeType
	) {
		throw new ReconciliationAttachmentError(
			"Only genuine PDF, JPEG, PNG, or WebP attachments are allowed",
			"invalid_reconciliation_attachment_type"
		);
	}
	return {
		buffer: file.buffer,
		bytes: file.buffer.length,
		mimeType: detectedMimeType,
		originalName: sanitizeAttachmentName(file.originalname),
	};
};

const multerParser = multer({
	storage: multer.memoryStorage(),
	limits: {
		files: 1,
		fileSize: MAX_RECONCILIATION_ATTACHMENT_BYTES,
		fields: 1,
		fieldSize: MAX_RECONCILIATION_PAYLOAD_BYTES,
		parts: 2,
	},
});

const parseReconciliationAttachment = (req, res, next) =>
	multerParser.single("attachment")(req, res, (error) => {
		if (!error) return next();
		const tooLarge = error.code === "LIMIT_FILE_SIZE";
		return res.status(tooLarge ? 413 : 400).json({
			code: tooLarge
				? "reconciliation_attachment_too_large"
				: "invalid_reconciliation_multipart",
			error: tooLarge
				? "The reconciliation attachment must be 10MB or smaller"
				: "The reconciliation multipart request is invalid",
		});
	});

const uploadStream = (buffer, options) =>
	new Promise((resolve, reject) => {
		const stream = cloudinary.v2.uploader.upload_stream(
			options,
			(error, result) => (error ? reject(error) : resolve(result))
		);
		stream.end(buffer);
	});

const uploadReconciliationAttachment = async (file) => {
	const validated = validateReconciliationAttachment(file);
	if (!validated) return null;
	const uploaded = await uploadStream(validated.buffer, {
		folder: "janat/reconciliation-attachments",
		resource_type: "auto",
		type: "authenticated",
		use_filename: false,
		unique_filename: true,
	});
	if (!uploaded?.public_id || !uploaded?.resource_type) {
		throw new ReconciliationAttachmentError(
			"The reconciliation attachment could not be stored",
			"reconciliation_attachment_upload_failed",
			502
		);
	}
	return {
		publicId: String(uploaded.public_id),
		resourceType: String(uploaded.resource_type),
		format: String(uploaded.format || ""),
		version: Number.isFinite(Number(uploaded.version))
			? Number(uploaded.version)
			: null,
		bytes: validated.bytes,
		originalName: validated.originalName,
		mimeType: validated.mimeType,
		uploadedAt: new Date(),
	};
};

const removeReconciliationAttachment = async (attachment) => {
	if (!attachment?.publicId) return false;
	try {
		await cloudinary.v2.uploader.destroy(String(attachment.publicId), {
			resource_type: String(attachment.resourceType || "image"),
			type: "authenticated",
			invalidate: true,
		});
		return true;
	} catch (error) {
		console.error(
			"[RECONCILIATION] Failed to clean up attachment:",
			error?.message || error
		);
		return false;
	}
};

module.exports = {
	ALLOWED_MIME_TYPES,
	MAX_RECONCILIATION_ATTACHMENT_BYTES,
	MAX_RECONCILIATION_PAYLOAD_BYTES,
	ReconciliationAttachmentError,
	detectAttachmentMimeType,
	parseReconciliationAttachment,
	removeReconciliationAttachment,
	sanitizeAttachmentName,
	uploadReconciliationAttachment,
	validateReconciliationAttachment,
};
