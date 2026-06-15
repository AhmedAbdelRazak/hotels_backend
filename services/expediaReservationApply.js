/** @format */

const mongoose = require("mongoose");
const OtaReservationSyncJob = require("../models/ota_reservation_sync_job");
const {
	reconcileOtaReservation,
	findReservationByOtaConfirmation,
	detectConfirmationMatchFields,
	normalizeConfirmation,
	normalizeStatusToApply,
} = require("./otaReservationMapper");

const activeApplyJobs = new Set();
const WRITTEN_STATUSES = new Set([
	"created",
	"updated",
	"cancelled",
	"status_updated",
]);

const round2 = (value) => {
	const parsed = Number(value || 0);
	return Number.isFinite(parsed) ? Number(parsed.toFixed(2)) : 0;
};

const normalizeId = (value) => String(value || "").trim();

const compact = (value) => String(value || "").replace(/\s+/g, " ").trim();

const normalizePaymentCollectionModel = (value = "") => {
	const model = compact(value).toLowerCase();
	if (["expedia_collect", "expedia collect", "ota_collect", "ota collect"].includes(model)) {
		return "ota_collect";
	}
	if (["hotel_collect", "hotel collect"].includes(model)) return "hotel_collect";
	if (["virtual_card", "virtual card", "vcc"].includes(model)) return "virtual_card";
	return model || "unknown";
};

const candidateLookupValues = (candidate = {}) =>
	Array.from(
		new Set(
			[
				candidate.confirmationNumber,
				candidate.reservationId,
				candidate.hotelConfirmationNumber,
				candidate.itineraryNumber,
				...(Array.isArray(candidate.alternateConfirmationNumbers)
					? candidate.alternateConfirmationNumbers
					: []),
			]
				.map(normalizeConfirmation)
				.filter(Boolean)
		)
	);

const findExistingForCandidate = async (candidate = {}) => {
	const lookups = candidateLookupValues(candidate);
	for (const lookupValue of lookups) {
		// eslint-disable-next-line no-await-in-loop
		const existing = await findReservationByOtaConfirmation(
			lookupValue,
			"_id hotelId confirmation_number reservation_id customer_details supplierData reservation_status state"
		);
		if (existing) {
			return { existing, matchedLookupValue: lookupValue };
		}
	}
	return { existing: null, matchedLookupValue: "" };
};

const money = (...values) => {
	for (const value of values) {
		const parsed = Number(value || 0);
		if (Number.isFinite(parsed) && parsed > 0) return round2(parsed);
	}
	return 0;
};

const requiredNewCandidateFields = (candidate = {}, amountSar = 0) => {
	const missing = [];
	if (!candidateLookupValues(candidate).length) missing.push("confirmation number");
	if (!compact(candidate.guestName)) missing.push("guest name");
	if (!normalizeId(candidate.hotelId)) missing.push("hotel id");
	if (!compact(candidate.hotelName || candidate.expediaPropertyName)) {
		missing.push("hotel name");
	}
	if (!compact(candidate.roomName)) missing.push("room name");
	if (!compact(candidate.checkinDate)) missing.push("check-in date");
	if (!compact(candidate.checkoutDate)) missing.push("check-out date");
	if (!amountSar) missing.push("SAR guest total");
	return missing;
};

const candidateToNormalized = ({ candidate = {}, job = {}, intent, eventType, statusToApply }) => {
	const paymentSummary = candidate.paymentSummary || {};
	const amountSar = money(
		candidate.amount,
		candidate.totalAmountSar,
		paymentSummary.totalGuestPaymentAmount
	);
	const sourceAmount = money(
		candidate.sourceAmount,
		paymentSummary.sourceTotalGuestPaymentAmount,
		amountSar
	);
	const sourceCurrency =
		candidate.sourceCurrency || paymentSummary.sourceCurrency || "SAR";
	const sourceExchangeRateToSar = Number(
		candidate.exchangeRateToSar ||
			paymentSummary.exchangeRateToSar ||
			(String(sourceCurrency || "").toUpperCase() === "SAR" ? 1 : 0)
	);
	const confirmationNumber = normalizeConfirmation(
		candidate.confirmationNumber || candidate.reservationId
	);
	const paymentCollectionModel = normalizePaymentCollectionModel(
		candidate.paymentCollectionModel
	);
	const totalGuests = Math.max(
		1,
		Number(
			candidate.totalGuests ||
				Number(candidate.adults || 0) + Number(candidate.children || 0) ||
				1
		)
	);

	return {
		provider: "expedia",
		providerLabel: "Expedia",
		bookingSource: "Expedia",
		intent,
		eventType,
		statusToApply,
		reservationId: confirmationNumber,
		confirmationNumber,
		hotelId: candidate.hotelId,
		hotelName: candidate.hotelName || candidate.expediaPropertyName || "",
		hotelNameAliases: [
			candidate.hotelName,
			candidate.expediaPropertyName,
			candidate.expediaPropertyId,
		].filter(Boolean),
		roomName: candidate.roomName || "",
		checkinDate: candidate.checkinDate || "",
		checkoutDate: candidate.checkoutDate || "",
		bookedAt: candidate.bookedAt || job.createdAt || new Date(),
		amount: amountSar,
		currency: "SAR",
		totalAmountSar: amountSar,
		sourceAmount,
		sourceCurrency,
		sourceAmountHint: candidate.sourceAmountHint || candidate.amountHint || "",
		sourceExchangeRateToSar,
		sourceExchangeRateSource:
			candidate.exchangeRateSource || paymentSummary.exchangeRateSource || "",
		exchangeRateToSar: Number(
			candidate.exchangeRateToSar ||
				paymentSummary.exchangeRateToSar ||
				(sourceCurrency === "SAR" ? 1 : 0)
		),
		exchangeRateSource:
			candidate.exchangeRateSource || paymentSummary.exchangeRateSource || "",
		amountConvertedAt:
			candidate.amountConvertedAt || paymentSummary.amountConvertedAt || "",
		totalPayoutSar: money(paymentSummary.totalPayoutAmount),
		adults: Math.max(0, Number(candidate.adults || 0)),
		children: Math.max(0, Number(candidate.children || 0)),
		totalGuests,
		roomCount: Math.max(1, Number(candidate.roomCount || 1)),
		guestName: candidate.guestName || "",
		guestEmail: candidate.guestEmail || "no-email@jannatbooking.com",
		guestPhone: candidate.guestPhone || "0000",
		nationality: candidate.nationality || "",
		paidOnline: paymentCollectionModel === "ota_collect",
		paymentCollectionModel,
		paymentInstructions: [
			candidate.paymentCollectionModel || "",
			sourceAmount && sourceCurrency ? `source ${sourceCurrency} ${sourceAmount}` : "",
			paymentSummary.sourceTotalPayoutAmount
				? `payout ${sourceCurrency} ${paymentSummary.sourceTotalPayoutAmount}`
				: "",
		]
			.filter(Boolean)
			.join("; "),
		paymentSummary,
		inboundEmailId: `ota-sync:${job.jobNumber || job._id || ""}`,
		sourcePresence: {
			reservationId: true,
			confirmationNumber: true,
			bookingSource: true,
			hotelName: true,
			roomName: Boolean(candidate.roomName),
			checkinDate: Boolean(candidate.checkinDate),
			checkoutDate: Boolean(candidate.checkoutDate),
			bookedAt: Boolean(candidate.bookedAt),
			amount: amountSar > 0,
			adults: Number(candidate.adults || 0) > 0,
			children: true,
			totalGuests: totalGuests > 0,
			roomCount: true,
			guestName: Boolean(candidate.guestName),
			guestEmail: Boolean(candidate.guestEmail),
			guestPhone: Boolean(candidate.guestPhone),
			nationality: Boolean(candidate.nationality),
			paymentCollectionModel: paymentCollectionModel !== "unknown",
			paymentInstructions: true,
		},
		source: {
			from: "expedia-sync",
			subject: `Expedia reservation sync ${confirmationNumber}`,
			messageId: `ota-sync:${job.jobNumber || job._id || ""}:${confirmationNumber}`,
			textHash: "",
			safeSnippet: candidate.sourceSnippet || "",
		},
		warnings: [],
		errors: [],
	};
};

const resultEntry = ({ candidate = {}, action, status, result = {}, extra = {} }) => ({
	action,
	status,
	confirmationNumber:
		candidate.confirmationNumber || candidate.reservationId || result.confirmationNumber || "",
	expediaReservationId: candidate.reservationId || "",
	hotelConfirmationNumber: candidate.hotelConfirmationNumber || "",
	hotelId: candidate.hotelId || result.hotelId || "",
	hotelName: candidate.hotelName || candidate.expediaPropertyName || "",
	reservationId: result.reservationId || "",
	pmsConfirmationNumber: result.pmsConfirmationNumber || "",
	warnings: result.warnings || [],
	errors: result.errors || [],
	matchedReservationBy: result.matchedReservationBy || [],
	...extra,
});

const applyNewCandidate = async ({ candidate, job }) => {
	const statusToApply = normalizeStatusToApply(
		candidate.statusToApply || candidate.statusRaw || "confirmed"
	);
	if (["cancelled", "no_show"].includes(statusToApply)) {
		return resultEntry({
			candidate,
			action: "skipped_cancelled_new_candidate",
			status: "skipped",
			extra: {
				skipReason: "Cancelled/no-show Expedia reservations are not created when no PMS document exists.",
			},
		});
	}

	const amountSar = money(
		candidate.amount,
		candidate.totalAmountSar,
		candidate.paymentSummary?.totalGuestPaymentAmount
	);
	const missing = requiredNewCandidateFields(candidate, amountSar);
	if (missing.length) {
		return resultEntry({
			candidate,
			action: "needs_review_missing_required_fields",
			status: "needs_review",
			extra: {
				errors: [`Missing required field(s): ${missing.join(", ")}.`],
			},
		});
	}

	const { existing, matchedLookupValue } = await findExistingForCandidate(candidate);
	if (existing) {
		return resultEntry({
			candidate,
			action: "duplicate_recheck_skipped",
			status: "duplicate_reservation",
			result: {
				reservationId: existing._id,
				hotelId: existing.hotelId,
				pmsConfirmationNumber: existing.confirmation_number,
				matchedReservationBy: detectConfirmationMatchFields(
					existing,
					matchedLookupValue
				),
			},
			extra: {
				skipReason: "A PMS reservation matched during pre-create recheck.",
				matchedLookupValue,
			},
		});
	}

	const normalized = candidateToNormalized({
		candidate,
		job,
		intent: "new_reservation",
		eventType: "created",
		statusToApply: "confirmed",
	});
	const result = await reconcileOtaReservation(normalized);
	return resultEntry({
		candidate,
		action: result.status === "created" ? "created_new_reservation" : "not_created",
		status: result.status,
		result,
	});
};

const applyStatusCandidate = async ({ candidate, job }) => {
	const statusToApply = normalizeStatusToApply(
		candidate.statusToApply || candidate.incomingStatus || candidate.statusRaw
	);
	if (!["cancelled", "no_show"].includes(statusToApply)) {
		return resultEntry({
			candidate,
			action: "skipped_non_terminal_status",
			status: "skipped",
			extra: {
				skipReason: "Only cancelled/no-show status changes are auto-applied.",
			},
		});
	}

	const { existing, matchedLookupValue } = await findExistingForCandidate(candidate);
	if (!existing) {
		return resultEntry({
			candidate,
			action: "needs_review_status_no_match",
			status: "needs_review",
			extra: {
				errors: ["Status change did not match an existing PMS reservation."],
			},
		});
	}

	const currentStatus = compact(
		existing.reservation_status || existing.state || ""
	).toLowerCase();
	if (currentStatus === statusToApply) {
		return resultEntry({
			candidate,
			action: "status_already_applied",
			status: "skipped",
			result: {
				reservationId: existing._id,
				hotelId: existing.hotelId,
				pmsConfirmationNumber: existing.confirmation_number,
				matchedReservationBy: detectConfirmationMatchFields(
					existing,
					matchedLookupValue
				),
			},
			extra: {
				skipReason: "PMS reservation already has the incoming Expedia status.",
				matchedLookupValue,
			},
		});
	}

	const normalized = candidateToNormalized({
		candidate: {
			...candidate,
			hotelId: candidate.hotelId || existing.hotelId,
		},
		job,
		intent: "reservation_status",
		eventType: statusToApply,
		statusToApply,
	});
	const result = await reconcileOtaReservation(normalized);
	return resultEntry({
		candidate,
		action: ["cancelled", "status_updated"].includes(result.status)
			? "updated_status"
			: "status_not_updated",
		status: result.status,
		result,
		extra: { matchedLookupValue },
	});
};

const summarizeApplyResults = (results = {}) => {
	const created = results.created || [];
	const statusUpdated = results.statusUpdated || [];
	const duplicateSkipped = results.duplicateSkipped || [];
	const skipped = results.skipped || [];
	const needsReview = results.needsReview || [];
	const failed = results.failed || [];
	return {
		created: created.length,
		statusUpdated: statusUpdated.length,
		duplicateSkipped: duplicateSkipped.length,
		skipped: skipped.length,
		needsReview: needsReview.length,
		failed: failed.length,
		appliedWrites: created.length + statusUpdated.length,
	};
};

const pushApplyEntry = (results, entry) => {
	if (entry.status === "created") {
		results.created.push(entry);
		return;
	}
	if (
		["cancelled", "status_updated", "updated"].includes(entry.status) &&
		entry.action === "updated_status"
	) {
		results.statusUpdated.push(entry);
		return;
	}
	if (entry.status === "duplicate_reservation") {
		results.duplicateSkipped.push(entry);
		return;
	}
	if (entry.status === "needs_review" || entry.status === "needs_mapping") {
		results.needsReview.push(entry);
		return;
	}
	if (WRITTEN_STATUSES.has(entry.status)) {
		results.statusUpdated.push(entry);
		return;
	}
	results.skipped.push(entry);
};

const applyExpediaReservationSyncJob = async ({ jobId, actor }) => {
	const key = normalizeId(jobId);
	if (!mongoose.Types.ObjectId.isValid(key)) {
		return { ok: false, statusCode: 400, error: "Invalid OTA sync job id." };
	}
	if (activeApplyJobs.has(key)) {
		const job = await OtaReservationSyncJob.findById(key).lean().exec();
		return {
			ok: false,
			statusCode: 409,
			error: "This OTA sync job is already applying.",
			job,
		};
	}

	activeApplyJobs.add(key);
	const startedAt = new Date();
	try {
		const job = await OtaReservationSyncJob.findOneAndUpdate(
			{ _id: key, status: "preview_ready" },
			{
				$set: {
					status: "applying",
					applyResults: {
						startedAt,
						status: "applying",
						readOnlyPreviewRequired: true,
					},
				},
				$push: {
					auditLog: {
						at: startedAt,
						action: "apply_started",
						by: actor?._id || actor?.id || "",
						writePolicy:
							"create new confirmed reservations; apply cancelled/no-show status changes only",
					},
				},
			},
			{ new: true }
		)
			.lean()
			.exec();

		if (!job) {
			const existingJob = await OtaReservationSyncJob.findById(key).lean().exec();
			return {
				ok: false,
				statusCode: 409,
				error:
					existingJob?.status === "applied"
						? "This OTA sync job was already applied."
						: "Only preview_ready OTA sync jobs can be applied.",
				job: existingJob,
			};
		}

		const buckets = job.previewBuckets || {};
		const results = {
			startedAt,
			created: [],
			statusUpdated: [],
			duplicateSkipped: [],
			skipped: [],
			needsReview: [],
			failed: [],
		};

		const newCandidates = Array.isArray(buckets.newReservations)
			? buckets.newReservations
			: [];
		for (const candidate of newCandidates) {
			try {
				// eslint-disable-next-line no-await-in-loop
				const entry = await applyNewCandidate({ candidate, job });
				pushApplyEntry(results, entry);
			} catch (error) {
				results.failed.push(
					resultEntry({
						candidate,
						action: "create_failed",
						status: "failed",
						extra: { errors: [error.message || String(error)] },
					})
				);
			}
		}

		const statusCandidates = Array.isArray(buckets.statusChanged)
			? buckets.statusChanged
			: [];
		for (const candidate of statusCandidates) {
			try {
				// eslint-disable-next-line no-await-in-loop
				const entry = await applyStatusCandidate({ candidate, job });
				pushApplyEntry(results, entry);
			} catch (error) {
				results.failed.push(
					resultEntry({
						candidate,
						action: "status_update_failed",
						status: "failed",
						extra: { errors: [error.message || String(error)] },
					})
				);
			}
		}

		const summary = summarizeApplyResults(results);
		const finalStatus =
			summary.failed || summary.needsReview ? "apply_needs_review" : "applied";
		results.finishedAt = new Date();
		results.status = finalStatus;
		results.summary = summary;

		const updatedJob = await OtaReservationSyncJob.findByIdAndUpdate(
			key,
			{
				$set: {
					status: finalStatus,
					applyResults: results,
					resultSummary: {
						...(job.resultSummary || {}),
						appliedWrites: summary.appliedWrites,
						applyCreated: summary.created,
						applyStatusUpdated: summary.statusUpdated,
						applyDuplicateSkipped: summary.duplicateSkipped,
						applySkipped: summary.skipped,
						applyNeedsReview: summary.needsReview,
						applyFailed: summary.failed,
					},
					"collectorState.status": finalStatus,
					"collectorState.appliedAt": results.finishedAt,
					"collectorState.appliedWrites": summary.appliedWrites,
				},
				$push: {
					auditLog: {
						at: results.finishedAt,
						action: "apply_finished",
						by: actor?._id || actor?.id || "",
						status: finalStatus,
						summary,
					},
				},
			},
			{ new: true }
		)
			.lean()
			.exec();

		return { ok: true, statusCode: 200, job: updatedJob, summary };
	} finally {
		activeApplyJobs.delete(key);
	}
};

module.exports = {
	applyExpediaReservationSyncJob,
	normalizePaymentCollectionModel,
	candidateLookupValues,
};
