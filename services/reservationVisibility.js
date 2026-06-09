const HOTEL_MANAGEMENT_RESERVATION_VISIBILITY_START = new Date(
	"2026-04-01T00:00:00.000Z"
);
const HOTEL_MANAGEMENT_AI_CHAT_SOURCE_LABEL = "Jannat Employee";
const HOTEL_MANAGEMENT_SOURCE_VIEW_HEADER = "x-reservation-source-view";
const HOTEL_MANAGEMENT_INTERNAL_TEXT_REGEX =
	/\b(?:admin|administrator|super\s*admin|system|system\s*admin|root|internal|ai|chatbot|lifecycle)\b|[\u0623\u0627]\u062f\u0645\u0646|\u0645\u0634\u0631\u0641|\u0646\u0638\u0627\u0645|\u062f\u0627\u062e\u0644\u064a|\u0630\u0643\u0627\u0621|\u0631\u0648\u0628\u0648\u062a/i;

const normalizeId = (value) => String(value?._id || value?.id || value || "").trim();

const configuredSuperAdminIds = () =>
	[process.env.SUPER_ADMIN_ID, process.env.REACT_APP_SUPER_ADMIN_ID]
		.flatMap((value) => String(value || "").split(","))
		.map((id) => String(id || "").trim())
		.filter(Boolean);

const roleNumbers = (actor = {}) =>
	[
		Number(actor?.role),
		...(Array.isArray(actor?.roles) ? actor.roles.map(Number) : []),
	].filter((role) => Number.isFinite(role));

const normalizeRoleDescriptionKey = (value = "") =>
	String(value || "")
		.toLowerCase()
		.replace(/[\s_-]+/g, "");

const roleDescriptions = (actor = {}) =>
	[
		actor?.roleDescription,
		...(Array.isArray(actor?.roleDescriptions) ? actor.roleDescriptions : []),
		actor?.platformEmployeeType,
	]
		.map(normalizeRoleDescriptionKey)
		.filter(Boolean);

const accessKeys = (actor = {}) =>
	(Array.isArray(actor?.accessTo) ? actor.accessTo : [])
		.map((key) => String(key || "").trim())
		.filter(Boolean);

const isConfiguredSuperAdmin = (actorOrId = {}) => {
	const id = normalizeId(actorOrId);
	return Boolean(id) && configuredSuperAdminIds().includes(id);
};

const isPlatformReservationHistoryViewer = (actor = {}) => {
	if (!actor) return false;
	if (isConfiguredSuperAdmin(actor)) return true;
	if (roleNumbers(actor).includes(1000)) return true;
	if (actor.accountScope === "platform" || actor.platformEmployee === true) {
		return true;
	}
	const descriptions = roleDescriptions(actor);
	return descriptions.some((description) =>
		[
			"superadmin",
			"platformadmin",
			"platformstaff",
			"platformemployee",
		].includes(description)
	);
};

const isPlatformReservationSourceViewer = (actor = {}) => {
	if (!actor) return false;
	if (isConfiguredSuperAdmin(actor)) return true;
	const descriptions = roleDescriptions(actor);
	if (
		descriptions.some((description) =>
			["superadmin", "platformadmin"].includes(description)
		)
	) {
		return true;
	}
	if (!roleNumbers(actor).includes(1000)) return false;
	const access = accessKeys(actor).map((key) => key.toLowerCase());
	return access.some((key) =>
		["allreservations", "hotelsreservations", "admindashboard"].includes(key)
	);
};

const canEditReservationSource = (actor = {}) => {
	if (!actor) return false;
	if (isConfiguredSuperAdmin(actor)) return true;
	if (!roleNumbers(actor).includes(1000)) return false;
	const access = accessKeys(actor).map((key) => key.toLowerCase());
	return access.some((key) =>
		["allreservations", "hotelsreservations"].includes(key)
	);
};

const normalizeSourceKey = (value = "") =>
	String(value || "")
		.toLowerCase()
		.replace(/[\s_-]+/g, "")
		.trim();

const isAiChatReservationSource = (value = "") => {
	const key = normalizeSourceKey(value);
	return (
		key === "aichat" ||
		key === "aiagent" ||
		key === "aibot" ||
		key === "chatbot" ||
		key.includes("aichat") ||
		key.includes("aiagent") ||
		key.includes("aibot") ||
		key.includes("chatbot")
	);
};

const hotelManagementBookingSourceLabel = (value = "") =>
	isAiChatReservationSource(value)
		? HOTEL_MANAGEMENT_AI_CHAT_SOURCE_LABEL
		: value;

const shouldMaskHotelManagementInternalText = (value = "") =>
	HOTEL_MANAGEMENT_INTERNAL_TEXT_REGEX.test(String(value || ""));

const maskHotelManagementInternalText = (value = "") => {
	const text = String(value || "").trim();
	if (!text) return "";
	return shouldMaskHotelManagementInternalText(text)
		? HOTEL_MANAGEMENT_AI_CHAT_SOURCE_LABEL
		: text;
};

const hasHotelManagementSourceViewHeader = (req = {}) => {
	const headers = req.headers || {};
	const value =
		headers[HOTEL_MANAGEMENT_SOURCE_VIEW_HEADER] ||
		headers["X-Reservation-Source-View"] ||
		req.get?.(HOTEL_MANAGEMENT_SOURCE_VIEW_HEADER);
	return normalizeSourceKey(value) === "hotelmanagement";
};

const plainActorForContext = (actor = null) => {
	if (!actor || typeof actor !== "object") return {};
	if (typeof actor.toObject === "function") return actor.toObject();
	if (actor._doc && typeof actor._doc === "object") return { ...actor._doc };
	return { ...actor };
};

const withHotelManagementSourceViewContext = (actor = null, req = {}) => {
	if (!hasHotelManagementSourceViewHeader(req)) return actor;
	const safeActor = plainActorForContext(actor);
	return { ...safeActor, __hotelManagementSourceView: true };
};

const shouldMaskHotelManagementReservationSource = (actor = {}) =>
	Boolean(actor?.__hotelManagementSourceView) ||
	!isPlatformReservationSourceViewer(actor);

const maskReservationSourceForHotelManagement = (reservation = {}) => {
	if (!reservation || typeof reservation !== "object") return reservation;
	const plain =
		typeof reservation.toObject === "function"
			? reservation.toObject()
			: reservation;
	const next = { ...plain };

	if (isAiChatReservationSource(next.booking_source)) {
		next.booking_source = HOTEL_MANAGEMENT_AI_CHAT_SOURCE_LABEL;
	}
	if (isAiChatReservationSource(next.bookingSource)) {
		next.bookingSource = HOTEL_MANAGEMENT_AI_CHAT_SOURCE_LABEL;
	}
	if (
		next.financial_cycle &&
		typeof next.financial_cycle === "object" &&
		isAiChatReservationSource(next.financial_cycle.sourceName)
	) {
		next.financial_cycle = {
			...next.financial_cycle,
			sourceName: HOTEL_MANAGEMENT_AI_CHAT_SOURCE_LABEL,
		};
	}

	return next;
};

const maskReservationSourcesForHotelManagement = (reservations = []) =>
	Array.isArray(reservations)
		? reservations.map(maskReservationSourceForHotelManagement)
		: maskReservationSourceForHotelManagement(reservations);

const bookingSourceRowKey = (row = {}) =>
	["booking_source", "source", "_id"].find((key) => {
		const value = row?.[key];
		return typeof value === "string" && value.trim();
	});

const mergeNumericFields = (target = {}, source = {}) => {
	Object.entries(source || {}).forEach(([key, value]) => {
		if (typeof value === "number" && Number.isFinite(value)) {
			target[key] = Number(target[key] || 0) + value;
		}
	});
	return target;
};

const maskBookingSourceSummaryRowsForHotelManagement = (rows = []) => {
	if (!Array.isArray(rows)) return rows;
	const merged = new Map();
	rows.forEach((row = {}) => {
		const key = bookingSourceRowKey(row);
		if (!key) return;
		const maskedSource = hotelManagementBookingSourceLabel(row[key]) || row[key];
		const mapKey = normalizeSourceKey(maskedSource) || maskedSource;
		const nextRow = { ...row, [key]: maskedSource };
		if (nextRow.booking_source) nextRow.booking_source = maskedSource;
		if (nextRow.source) nextRow.source = maskedSource;
		if (typeof nextRow._id === "string") nextRow._id = maskedSource;

		if (!merged.has(mapKey)) {
			merged.set(mapKey, nextRow);
			return;
		}

		const existing = merged.get(mapKey);
		mergeNumericFields(existing, nextRow);
		if (nextRow.totalsByStatus && typeof nextRow.totalsByStatus === "object") {
			existing.totalsByStatus = { ...(existing.totalsByStatus || {}) };
			Object.entries(nextRow.totalsByStatus).forEach(([status, amount]) => {
				const numericAmount = Number(amount);
				if (Number.isFinite(numericAmount)) {
					existing.totalsByStatus[status] =
						Number(existing.totalsByStatus[status] || 0) + numericAmount;
				}
			});
		}
	});
	return Array.from(merged.values());
};

const reservationTakenOnOrAfterHotelManagementCutoffFilter = () => ({
	$or: [
		{ booked_at: { $gte: HOTEL_MANAGEMENT_RESERVATION_VISIBILITY_START } },
		{
			$and: [
				{ $or: [{ booked_at: { $exists: false } }, { booked_at: null }] },
				{ createdAt: { $gte: HOTEL_MANAGEMENT_RESERVATION_VISIBILITY_START } },
			],
		},
	],
});

const hotelManagementReservationVisibilityFilterForActor = (actor = {}) =>
	isPlatformReservationHistoryViewer(actor)
		? null
		: reservationTakenOnOrAfterHotelManagementCutoffFilter();

const withHotelManagementReservationVisibility = (filter = {}, actor = {}) => {
	const visibilityFilter = hotelManagementReservationVisibilityFilterForActor(actor);
	if (!visibilityFilter) return filter;
	return { $and: [filter || {}, visibilityFilter] };
};

const addHotelManagementReservationVisibilityToFilter = (filter = {}, actor = {}) => {
	const visibilityFilter = hotelManagementReservationVisibilityFilterForActor(actor);
	if (!visibilityFilter || !filter || typeof filter !== "object") return filter;
	filter.$and = [
		...(Array.isArray(filter.$and) ? filter.$and : []),
		visibilityFilter,
	];
	return filter;
};

module.exports = {
	HOTEL_MANAGEMENT_RESERVATION_VISIBILITY_START,
	HOTEL_MANAGEMENT_AI_CHAT_SOURCE_LABEL,
	addHotelManagementReservationVisibilityToFilter,
	hasHotelManagementSourceViewHeader,
	hotelManagementBookingSourceLabel,
	hotelManagementReservationVisibilityFilterForActor,
	maskHotelManagementInternalText,
	canEditReservationSource,
	isAiChatReservationSource,
	isPlatformReservationHistoryViewer,
	isPlatformReservationSourceViewer,
	maskBookingSourceSummaryRowsForHotelManagement,
	maskReservationSourceForHotelManagement,
	maskReservationSourcesForHotelManagement,
	reservationTakenOnOrAfterHotelManagementCutoffFilter,
	shouldMaskHotelManagementReservationSource,
	shouldMaskHotelManagementInternalText,
	withHotelManagementSourceViewContext,
	withHotelManagementReservationVisibility,
};
