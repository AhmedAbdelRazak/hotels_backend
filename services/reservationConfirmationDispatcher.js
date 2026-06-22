"use strict";

const mongoose = require("mongoose");
const puppeteer = require("puppeteer");
const sgMail = require("@sendgrid/mail");
const HotelDetails = require("../models/hotel_details");
const {
	ClientConfirmationEmail,
	receiptPdfTemplate,
} = require("../controllers/assets");
const {
	waSendReservationConfirmation,
	waNotifyNewReservation,
} = require("../controllers/whatsappsender");

if (process.env.SENDGRID_API_KEY) {
	sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

const INTERNAL_NOTIFICATION_EMAILS = [
	"morazzakhamouda@gmail.com",
	"xhoteleg@gmail.com",
	"ahmed.abdelrazak@jannatbooking.com",
	"support@jannatbooking.com",
];

const normalizeEmail = (value) =>
	typeof value === "string" ? value.trim().toLowerCase() : "";

const isLikelyEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

const uniqueValidEmails = (emails = []) => {
	const seen = new Set();
	const result = [];
	emails.forEach((email) => {
		const normalized = normalizeEmail(email);
		if (!isLikelyEmail(normalized) || seen.has(normalized)) return;
		seen.add(normalized);
		result.push(normalized);
	});
	return result;
};

const publicClientBaseUrl = () =>
	String(
		process.env.PUBLIC_CLIENT_URL ||
			process.env.CLIENT_URL ||
			process.env.REACT_APP_MAIN_URL_JANNAT ||
			"https://jannatbooking.com"
	).replace(/\/+$/, "");

const reservationPublicLinks = (reservation = {}) => {
	const base = publicClientBaseUrl();
	const confirmation = String(reservation.confirmation_number || "").trim();
	const id = String(reservation._id || "").trim();
	return {
		reservationConfirmation: confirmation
			? `${base}/single-reservation/${confirmation}`
			: "",
		payment: id && confirmation ? `${base}/client-payment/${id}/${confirmation}` : "",
	};
};

const rawPdfTimeoutMs = parseInt(process.env.PDF_GENERATION_TIMEOUT_MS || "12000", 10);
const PDF_GENERATION_TIMEOUT_MS = Math.min(
	30000,
	Math.max(3000, Number.isFinite(rawPdfTimeoutMs) ? rawPdfTimeoutMs : 12000)
);

const withTimeout = (task, timeoutMs, label = "operation") => {
	let timer = null;
	return Promise.race([
		Promise.resolve().then(task),
		new Promise((_, reject) => {
			timer = setTimeout(() => {
				reject(new Error(`${label} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
		}),
	]).finally(() => {
		if (timer) clearTimeout(timer);
	});
};

async function createPdfBuffer(html) {
	const browser = await puppeteer.launch({
		headless: "new",
		args: [
			"--no-sandbox",
			"--disable-setuid-sandbox",
			"--disable-dev-shm-usage",
			"--disable-accelerated-2d-canvas",
			"--no-first-run",
			"--no-zygote",
			"--disable-gpu",
		],
	});
	try {
		const page = await browser.newPage();
		try {
			return await withTimeout(
				async () => {
					await page.setContent(html, {
						waitUntil: "domcontentloaded",
						timeout: PDF_GENERATION_TIMEOUT_MS,
					});
					return page.pdf({ format: "A4", printBackground: true });
				},
				PDF_GENERATION_TIMEOUT_MS,
				"PDF generation"
			);
		} finally {
			await page.close().catch(() => {});
		}
	} finally {
		await browser.close().catch(() => {});
	}
}

async function hydrateReservationForConfirmation(reservation = {}) {
	const doc =
		typeof reservation?.toObject === "function"
			? reservation.toObject()
			: { ...(reservation || {}) };
	const hotelId = doc.hotelId?._id || doc.hotelId;
	let hotel =
		doc.hotelId && typeof doc.hotelId === "object" && doc.hotelId.hotelName
			? doc.hotelId
			: null;
	if (!hotel && hotelId && mongoose.Types.ObjectId.isValid(String(hotelId))) {
		hotel = await HotelDetails.findById(hotelId)
			.select("hotelName hotelAddress hotelCity phone belongsTo suppliedBy")
			.lean()
			.exec()
			.catch(() => null);
	}
	return {
		...doc,
		hotelName: doc.hotelName || hotel?.hotelName || "Hotel",
		hotelAddress: doc.hotelAddress || hotel?.hotelAddress || "",
		hotelCity: doc.hotelCity || hotel?.hotelCity || "",
		hotelPhone: doc.hotelPhone || hotel?.phone || "",
	};
}

async function sendEmailSafe(payload, label) {
	const to = payload?.to || "";
	try {
		const result = await sgMail.send(payload);
		const response = Array.isArray(result) ? result[0] : result;
		return {
			ok: true,
			to,
			label,
			statusCode: response?.statusCode || null,
		};
	} catch (error) {
		console.error("[reservation-confirmation] email send failed", {
			label,
			to,
			error: error?.response?.body || error?.message || error,
		});
		return {
			ok: false,
			to,
			label,
			error: String(error?.message || error || "").slice(0, 240),
		};
	}
}

async function sendOwnerEmailIfAvailable(baseEmail, reservationData = {}) {
	const hotelId = reservationData?.hotelId?._id || reservationData?.hotelId;
	if (!hotelId || !mongoose.Types.ObjectId.isValid(String(hotelId))) {
		return { attempted: false, skipped: true, reason: "missing_hotel_id" };
	}
	const hotel = await HotelDetails.findById(hotelId)
		.populate({ path: "belongsTo", select: "_id email" })
		.select("belongsTo")
		.lean()
		.exec()
		.catch(() => null);
	const ownerEmail = normalizeEmail(hotel?.belongsTo?.email);
	if (!isLikelyEmail(ownerEmail)) {
		return { attempted: false, skipped: true, reason: "missing_owner_email" };
	}
	return sendEmailSafe(
		{
			...baseEmail,
			to: ownerEmail,
			cc: "ahmed.abdelrazak@jannatbooking.com",
		},
		"owner confirmation"
	);
}

async function buildConfirmationEmail(reservationData = {}, { includePdf = true } = {}) {
	const html = ClientConfirmationEmail(reservationData);
	const hotelForPdf =
		reservationData?.hotelId && typeof reservationData.hotelId === "object"
			? reservationData.hotelId
			: {
					hotelName: reservationData?.hotelName || "",
					suppliedBy: reservationData?.belongsTo?.name || "",
			  };
	let pdfBuffer = null;
	let pdfError = "";
	if (includePdf) {
		const pdfHtml = receiptPdfTemplate(reservationData, hotelForPdf);
		try {
			pdfBuffer = await createPdfBuffer(pdfHtml);
		} catch (error) {
			pdfError = String(error?.message || error || "").slice(0, 240);
			console.error(
				"[reservation-confirmation] PDF generation failed:",
				error?.message || error
			);
		}
	}
	const attachments = pdfBuffer
		? [
				{
					content: pdfBuffer.toString("base64"),
					filename: "Reservation_Invoice.pdf",
					type: "application/pdf",
					disposition: "attachment",
				},
		  ]
		: undefined;
	return {
		baseEmail: {
			from: "noreply@jannatbooking.com",
			subject: "Reservation Confirmation - Invoice Attached",
			html,
			...(attachments ? { attachments } : {}),
		},
		pdf: pdfBuffer
			? { ok: true, attached: true }
			: includePdf
			? { ok: false, attached: false, error: pdfError }
			: { ok: true, attached: false, skipped: true, reason: "pdf_not_requested" },
	};
}

async function dispatchReservationConfirmation(reservation, options = {}) {
	const {
		guestEmail,
		includeGuestEmail = true,
		includeInternalEmail = true,
		includeOwnerEmail = true,
		includeGuestWhatsApp = true,
		includeAdminWhatsApp = true,
		includePdf = true,
	} = options;
	const reservationData = await hydrateReservationForConfirmation(reservation);
	const links = reservationPublicLinks(reservationData);
	const result = {
		ok: true,
		links,
		email: {
			attempted: false,
			pdf: null,
			guest: null,
			internal: null,
			owner: null,
		},
		whatsapp: {
			attempted: false,
			guest: null,
			admin: null,
		},
	};

	if (includeGuestEmail || includeInternalEmail || includeOwnerEmail) {
		result.email.attempted = true;
		const { baseEmail, pdf } = await buildConfirmationEmail(reservationData, {
			includePdf,
		});
		result.email.pdf = pdf;

		if (includeGuestEmail) {
			const target = normalizeEmail(
				guestEmail || reservationData?.customer_details?.email || ""
			);
			result.email.guest = isLikelyEmail(target)
				? await sendEmailSafe({ ...baseEmail, to: target }, "guest confirmation")
				: {
						attempted: false,
						skipped: true,
						reason: "invalid_or_missing_guest_email",
				  };
		}

		if (includeInternalEmail) {
			const internalEmails = uniqueValidEmails(INTERNAL_NOTIFICATION_EMAILS);
			const sent = await Promise.all(
				internalEmails.map((email) =>
					sendEmailSafe(
						{ ...baseEmail, to: email },
						`staff confirmation (${email})`
					)
				)
			);
			result.email.internal = {
				attempted: internalEmails.length > 0,
				sent: sent.filter((item) => item.ok).length,
				failed: sent.filter((item) => !item.ok).length,
			};
		}

		if (includeOwnerEmail) {
			result.email.owner = await sendOwnerEmailIfAvailable(
				baseEmail,
				reservationData
			);
		}
	}

	if (includeGuestWhatsApp) {
		result.whatsapp.attempted = true;
		try {
			result.whatsapp.guest = await waSendReservationConfirmation(
				reservationData
			);
		} catch (error) {
			console.error("[reservation-confirmation] WhatsApp guest send failed", {
				confirmation: reservationData?.confirmation_number,
				error: error?.message || error,
			});
			result.whatsapp.guest = {
				ok: false,
				error: String(error?.message || error || "").slice(0, 240),
			};
		}
	}

	if (includeAdminWhatsApp) {
		try {
			result.whatsapp.admin = await waNotifyNewReservation(reservationData);
		} catch (error) {
			console.error("[reservation-confirmation] WhatsApp admin notify failed", {
				confirmation: reservationData?.confirmation_number,
				error: error?.message || error,
			});
			result.whatsapp.admin = {
				ok: false,
				error: String(error?.message || error || "").slice(0, 240),
			};
		}
	}

	result.ok = Boolean(
		result.email.guest?.ok ||
			result.email.internal?.sent ||
			result.email.owner?.ok ||
			result.whatsapp.guest?.sid ||
			result.whatsapp.guest?.ok ||
			result.whatsapp.guest?.skipped ||
			result.whatsapp.admin?.sid ||
			result.whatsapp.admin?.ok
	);
	return result;
}

module.exports = {
	dispatchReservationConfirmation,
	reservationPublicLinks,
};
