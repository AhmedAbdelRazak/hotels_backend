const Reservations = require("../models/reservations");
const HotelDetails = require("../models/hotel_details");
const mongoose = require("mongoose");
const ObjectId = mongoose.Types.ObjectId;
const fetch = require("node-fetch");
const Rooms = require("../models/rooms");
const HouseKeeping = require("../models/housekeeping");
const AgentWallet = require("../models/agent_wallet");
const User = require("../models/user");
const xlsx = require("xlsx");
const sgMail = require("@sendgrid/mail");
const puppeteer = require("puppeteer");
const moment = require("moment-timezone");
const saudiDateTime = moment().tz("Asia/Riyadh").format();
const {
	confirmationEmail,
	reservationUpdate,
	emailPaymentLink,
	receiptPdfTemplate,
} = require("./assets");
const { sum } = require("lodash");
const { decryptWithSecret } = require("./utils");
const { emitHotelNotificationRefresh } = require("../services/notificationEvents");
const {
	ReservationPricingError,
	normalizeReservationCreationPricing,
	normalizeReservationStayPricing,
} = require("../services/reservationPricing");

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const DAY_MS = 24 * 60 * 60 * 1000;
const CANCELLED_REGEX = /cancelled|canceled/i;
const NO_SHOW_REGEX = /no[_\s-]?show/i;
const CHECKED_OUT_REGEX =
	/checked[_\s-]?out|checkedout|closed|early[_\s-]?checked[_\s-]?out/i;
const IN_HOUSE_REGEX = /house/i;
const HOUSEKEEPING_FINISHED_REGEX = /finished|done|completed|clean/i;
const NEW_RESERVATION_PROCESS_START = new Date("2026-05-08T00:00:00.000Z");
const INCOMPLETE_EXCLUDED_REGEX = new RegExp(
	`${CANCELLED_REGEX.source}|${NO_SHOW_REGEX.source}|${CHECKED_OUT_REGEX.source}|house`,
	"i"
);

const moneyNumber = (value) => {
	if (value === null || value === undefined || value === "") return 0;
	if (typeof value === "number") {
		return Number.isFinite(value) ? value : 0;
	}
	const parsed = Number(String(value).replace(/,/g, "").trim());
	return Number.isFinite(parsed) ? parsed : 0;
};

const n2 = (value) => Number(moneyNumber(value).toFixed(2));

const ASSIGNED_COMMISSION_STATUSES = new Set([
	"commission due",
	"commission paid",
	"no commission due",
]);

const PAYMENT_BREAKDOWN_ONLINE_KEYS = [
	"paid_online_via_link",
	"paid_online_via_instapay",
	"paid_no_show",
	"paid_online_jannatbooking",
	"paid_online_other_platforms",
];
const PAYMENT_BREAKDOWN_HOTEL_KEYS = [
	"paid_at_hotel_cash",
	"paid_at_hotel_card",
];
const PAYMENT_BREAKDOWN_SETTLEMENT_KEYS = ["paid_to_hotel"];
const PAYMENT_BREAKDOWN_NUMERIC_KEYS = [
	...PAYMENT_BREAKDOWN_ONLINE_KEYS,
	...PAYMENT_BREAKDOWN_HOTEL_KEYS,
	...PAYMENT_BREAKDOWN_SETTLEMENT_KEYS,
];

const sumBreakdownKeys = (breakdown = {}, keys = []) =>
	keys.reduce((sum, key) => {
		return sum + moneyNumber(breakdown?.[key]);
	}, 0);

const computeCommissionFromRooms = (pickedRoomsType = []) => {
	if (!Array.isArray(pickedRoomsType)) return 0;
	return pickedRoomsType.reduce((total, room) => {
		const count = Number(room?.count || 1) || 0;
		const pricingByDay = Array.isArray(room?.pricingByDay)
			? room.pricingByDay
			: [];
		const dayCommission = pricingByDay.reduce((sum, day) => {
			const finalPrice = Number(
				day?.totalPriceWithCommission ?? day?.price ?? day?.chosenPrice ?? 0
			);
			let rootPrice = Number(day?.rootPrice);
			if (!(Number.isFinite(rootPrice) && rootPrice > 0)) {
				rootPrice = Number(day?.totalPriceWithoutCommission ?? finalPrice);
			}
			if (!(Number.isFinite(rootPrice) && rootPrice > 0)) {
				rootPrice = finalPrice;
			}
			const diff = finalPrice - rootPrice;
			return sum + (Number.isFinite(diff) && diff > 0 ? diff : 0);
		}, 0);
		return total + dayCommission * count;
	}, 0);
};

const buildFinancialCycleSnapshot = (reservation, updates = {}, actorId = "") => {
	const existingCycle =
		reservation?.financial_cycle && typeof reservation.financial_cycle === "object"
			? reservation.financial_cycle
			: {};
	const commissionAssignmentReset = updates.__commissionAssignmentReset === true;
	const breakdown =
		updates.paid_amount_breakdown ||
		reservation?.paid_amount_breakdown ||
		{};
	const pmsCollectedAmount = n2(
		sumBreakdownKeys(breakdown, PAYMENT_BREAKDOWN_ONLINE_KEYS)
	);
	const hotelCollectedAmount = n2(
		sumBreakdownKeys(breakdown, PAYMENT_BREAKDOWN_HOTEL_KEYS)
	);
	const totalAmount = Number(updates.total_amount ?? reservation?.total_amount ?? 0);
	const storedReservationCommission = Number(reservation?.commission || 0);
	const storedCycleCommission = Number(existingCycle.commissionAmount || 0);
	const storedCommissionStatus = String(reservation?.commissionStatus || "")
		.trim()
		.toLowerCase();
	const commissionWasReviewed =
		!commissionAssignmentReset &&
		(updates.commission !== undefined ||
			updates.financial_cycle?.commissionAssigned === true ||
			reservation?.commissionData?.assigned === true ||
			existingCycle.commissionAssigned === true ||
			ASSIGNED_COMMISSION_STATUSES.has(storedCommissionStatus) ||
			storedReservationCommission > 0 ||
			storedCycleCommission > 0);
	const commissionAmount = n2(
		commissionAssignmentReset
			? 0
			: updates.commission !== undefined
			? updates.commission
			: storedReservationCommission > 0
			? storedReservationCommission
			: storedCycleCommission > 0
			? storedCycleCommission
			: computeCommissionFromRooms(updates.pickedRoomsType || reservation?.pickedRoomsType)
	);
	const moneyTransferredToHotel =
		updates.moneyTransferredToHotel ??
		reservation?.moneyTransferredToHotel ??
		false;
	const commissionPaid =
		updates.commissionPaid ?? reservation?.commissionPaid ?? false;

	let collectionModel = existingCycle.collectionModel || "pending";
	if (pmsCollectedAmount > 0 && hotelCollectedAmount > 0) {
		collectionModel = "mixed";
	} else if (pmsCollectedAmount > 0) {
		collectionModel = "pms_collected";
	} else if (hotelCollectedAmount > 0 || String(reservation?.payment || "").toLowerCase().includes("offline")) {
		collectionModel = "hotel_collected";
	}

	const hotelPayoutDue =
		collectionModel === "pms_collected" || collectionModel === "mixed"
			? Math.max(totalAmount - commissionAmount, 0)
			: 0;
	const commissionDueToPms =
		collectionModel === "hotel_collected" || collectionModel === "mixed"
			? commissionAmount
			: 0;
	const commissionSideClosed =
		!!commissionPaid || (commissionWasReviewed && commissionAmount <= 0);

	const isClosed =
		collectionModel === "pms_collected"
			? !!moneyTransferredToHotel
		: collectionModel === "hotel_collected"
			? commissionSideClosed
		: collectionModel === "mixed"
			? !!moneyTransferredToHotel && commissionSideClosed
			: false;
	const now = new Date();

	return {
		...existingCycle,
		...(updates.financial_cycle && typeof updates.financial_cycle === "object"
			? updates.financial_cycle
			: {}),
		collectionModel,
		status: isClosed ? "closed" : "open",
		commissionType: existingCycle.commissionType || "amount",
		commissionValue: commissionAmount,
		commissionAmount,
		// Zero can be a deliberate finance decision. This flag separates
		// "not reviewed yet" from "reviewed and no commission is due".
		commissionAssigned: commissionAssignmentReset ? false : commissionWasReviewed,
		commissionAssignedAt:
			commissionAssignmentReset
				? null
			: updates.commission !== undefined
				? now
				: existingCycle.commissionAssignedAt ||
				  reservation?.commissionData?.assignedAt ||
				  null,
		commissionAssignedBy:
			commissionAssignmentReset
				? null
			: updates.commission !== undefined
				? actorId || null
				: existingCycle.commissionAssignedBy ||
				  reservation?.commissionData?.assignedBy ||
				  null,
		pmsCollectedAmount,
		hotelCollectedAmount,
		hotelPayoutDue: n2(hotelPayoutDue),
		commissionDueToPms: n2(commissionDueToPms),
		closedAt: isClosed ? existingCycle.closedAt || now : null,
		closedBy: isClosed ? existingCycle.closedBy || actorId || null : null,
		notes:
			updates.financial_cycle?.notes !== undefined
				? updates.financial_cycle.notes
				: existingCycle.notes || "",
		lastUpdatedAt: now,
		lastUpdatedBy: actorId || existingCycle.lastUpdatedBy || null,
	};
};

const TRACKED_RESERVATION_FIELDS = [
	"reservation_status",
	"roomId",
	"bedNumber",
	"housedBy",
	"inhouse_date",
	"commission",
	"commissionData",
	"commissionPaid",
	"commissionStatus",
	"moneyTransferredToHotel",
	"paid_amount_breakdown",
	"paid_amount",
	"total_amount",
	"sub_total",
	"financial_cycle",
	"pendingConfirmation",
	"customer_details",
	"checkin_date",
	"checkout_date",
	"days_of_residence",
	"payment",
	"booking_source",
	"comment",
	"total_guests",
	"total_rooms",
	"pickedRoomsType",
	"pickedRoomsPricing",
	"createdByUserId",
	"createdBy",
	"orderTakeId",
	"orderTaker",
	"orderTakenAt",
	"agentWalletSnapshot",
	"agentDecisionSnapshot",
];

const SERVER_MANAGED_RESERVATION_UPDATE_FIELDS = [
	"_id",
	"id",
	"__v",
	"createdAt",
	"updatedAt",
	"adminLastUpdatedAt",
	"adminLastUpdatedBy",
	"adminChangeLog",
	"reservationAuditLog",
];

const stripServerManagedReservationUpdateFields = (payload = {}) => {
	SERVER_MANAGED_RESERVATION_UPDATE_FIELDS.forEach((field) => {
		if (Object.prototype.hasOwnProperty.call(payload, field)) {
			delete payload[field];
		}
	});
	return payload;
};

const simplifyAuditValue = (value) => {
	if (value === undefined) return undefined;
	if (value === null) return null;
	if (value instanceof Date) return value.toISOString();
	if (value && typeof value.toString === "function" && value._bsontype) {
		return value.toString();
	}
	if (Array.isArray(value)) {
		return value.map(simplifyAuditValue);
	}
	if (value && typeof value === "object") {
		if (typeof value.toObject === "function") {
			return simplifyAuditValue(value.toObject());
		}
		return Object.keys(value).reduce((acc, key) => {
			if (key === "__v") return acc;
			acc[key] = simplifyAuditValue(value[key]);
			return acc;
		}, {});
	}
	return value;
};

const buildReservationActorSnapshot = (actor = {}) => ({
	_id: actor?._id ? String(actor._id) : "",
	name: actor?.name || actor?.email || "",
	email: actor?.email || "",
	role: actor?.role || "",
	roleDescription: actor?.roleDescription || "",
});

const auditStringify = (value) => {
	const text = JSON.stringify(simplifyAuditValue(value));
	return text && text.length > 1200 ? `${text.slice(0, 1200)}...` : text;
};

const getAuditAction = (fields = []) => {
	if (
		fields.some((field) =>
			["roomId", "bedNumber", "housedBy", "inhouse_date"].includes(field)
		)
	) {
		return "housing_update";
	}
	if (
		fields.some((field) =>
			[
				"commission",
				"commissionPaid",
				"commissionStatus",
				"moneyTransferredToHotel",
				"paid_amount_breakdown",
				"paid_amount",
				"financial_cycle",
			].includes(field)
		)
	) {
		return "finance_update";
	}
	return "reservation_update";
};

const resolveReservationAuditActor = async (
	actorId = "",
	payload = {},
	options = {}
) => {
	const fallback = payload.housedBy && typeof payload.housedBy === "object"
		? payload.housedBy
		: {};
	const previewAuth = options.previewAuth || {};
	const previewMode = previewAuth?.preview === true;
	const previewActorId = previewAuth?.previewActorId;

	if (actorId && mongoose.Types.ObjectId.isValid(actorId)) {
		const actor = await User.findById(actorId)
			.select("_id name email role roleDescription")
			.lean()
			.exec();
		if (actor) {
			const actorSnapshot = {
				_id: actor._id,
				name: actor.name || actor.email || "Unknown user",
				role: actor.roleDescription || actor.role || "user",
			};
			if (
				previewMode &&
				previewActorId &&
				String(previewActorId) !== String(actor._id) &&
				mongoose.Types.ObjectId.isValid(previewActorId)
			) {
				const previewActor = await User.findById(previewActorId)
					.select("_id name email role roleDescription")
					.lean()
					.exec();
				return {
					...actorSnapshot,
					name: `-- ${actorSnapshot.name}`,
					preview: true,
					previewedBy: previewActor
						? {
								_id: previewActor._id,
								name: previewActor.name || previewActor.email || "Unknown user",
								role:
									previewActor.roleDescription ||
									previewActor.role ||
									"user",
						  }
						: {
								_id: previewActorId,
								name: "Unknown preview actor",
								role: "user",
						  },
				};
			}
			return actorSnapshot;
		}
	}

	return {
		_id:
			fallback._id && mongoose.Types.ObjectId.isValid(fallback._id)
				? fallback._id
				: undefined,
		name: fallback.name || payload.updatedByName || "System",
		role: fallback.roleDescription || fallback.role || "system",
	};
};

const buildReservationAuditEntries = (existingReservation, updatePayload, actor) => {
	const changedFields = TRACKED_RESERVATION_FIELDS.filter((field) =>
		Object.prototype.hasOwnProperty.call(updatePayload, field)
	).filter((field) => {
		const beforeValue = existingReservation.get
			? existingReservation.get(field)
			: existingReservation[field];
		return auditStringify(beforeValue) !== auditStringify(updatePayload[field]);
	});

	if (!changedFields.length) return [];

	const action = getAuditAction(changedFields);
	const now = new Date();

	return changedFields.map((field) => {
		const beforeValue = existingReservation.get
			? existingReservation.get(field)
			: existingReservation[field];
		return {
			at: now,
			action,
			field,
			by: actor,
			from: simplifyAuditValue(beforeValue),
			to: simplifyAuditValue(updatePayload[field]),
		};
	});
};

const buildReservationCreatedAuditEntry = (
	reservationData = {},
	actorFields = {}
) => {
	const actorSnapshot = actorFields.orderTaker || actorFields.createdBy || {};
	return {
		at: new Date(),
		action: "reservation_created",
		field: "reservation",
		by: {
			_id: actorFields.orderTakeId || actorFields.createdByUserId || undefined,
			name: actorSnapshot.name || actorSnapshot.email || "System",
			role: actorSnapshot.roleDescription || actorSnapshot.role || "system",
		},
		from: null,
		to: simplifyAuditValue({
			confirmation_number: reservationData.confirmation_number || "",
			hotelId: reservationData.hotelId || "",
			booking_source: reservationData.booking_source || "",
			total_amount: reservationData.total_amount || 0,
			reservation_status: reservationData.reservation_status || "",
			orderTakeId: actorFields.orderTakeId || "",
		}),
	};
};

const getSaudiDayRange = (dateStr) => {
	if (!dateStr) return null;
	const start = new Date(`${dateStr}T00:00:00+03:00`);
	if (Number.isNaN(start.getTime())) return null;
	const end = new Date(start.getTime() + DAY_MS);
	return { start, end };
};

const buildReservationListFilter = ({ selectedFilter, hotelId, dateStr }) => {
	const dynamicFilter = { hotelId: ObjectId(hotelId) };
	const dayRange = getSaudiDayRange(dateStr);
	const addDateRange = (field) => {
		if (!dayRange) return;
		dynamicFilter[field] = { $gte: dayRange.start, $lt: dayRange.end };
	};

	if (selectedFilter === "Specific Date") {
		addDateRange("checkin_date");
		dynamicFilter.reservation_status = { $not: CANCELLED_REGEX };
		return dynamicFilter;
	}

	if (selectedFilter === "Specific Date2") {
		addDateRange("checkout_date");
		dynamicFilter.reservation_status = { $not: CANCELLED_REGEX };
		return dynamicFilter;
	}

	if (selectedFilter === "no_show") {
		addDateRange("checkin_date");
		dynamicFilter.reservation_status = NO_SHOW_REGEX;
		return dynamicFilter;
	}

	switch (selectedFilter) {
		case "Today's New Reservations":
			addDateRange("booked_at");
			dynamicFilter.reservation_status = { $not: CANCELLED_REGEX };
			break;
		case "Cancelations":
			dynamicFilter.reservation_status = CANCELLED_REGEX;
			break;
		case "Today's Arrivals":
			addDateRange("checkin_date");
			dynamicFilter.reservation_status = { $not: CANCELLED_REGEX };
			break;
		case "Today's Departures":
			addDateRange("checkout_date");
			dynamicFilter.reservation_status = { $not: CANCELLED_REGEX };
			break;
		case "Incomplete reservations":
			dynamicFilter.reservation_status = { $not: INCOMPLETE_EXCLUDED_REGEX };
			break;
		case "In House":
			dynamicFilter.reservation_status = IN_HOUSE_REGEX;
			break;
		default:
			break;
	}

	return dynamicFilter;
};

const isOrderTakingAccount = (user = {}) => {
	const roles = Array.isArray(user.roles) ? user.roles.map(Number) : [];
	const descriptions = [
		String(user.roleDescription || "").toLowerCase(),
		...(Array.isArray(user.roleDescriptions)
			? user.roleDescriptions.map((item) => String(item || "").toLowerCase())
			: []),
	];
	const accessTo = Array.isArray(user.accessTo) ? user.accessTo : [];
	const hasOrderTakingScope =
		Number(user.role) === 7000 ||
		roles.includes(7000) ||
		descriptions.includes("ordertaker") ||
		accessTo.includes("ownReservations");
	const hasFullReservationScope =
		Number(user.role) === 1000 ||
		Number(user.role) === 2000 ||
		Number(user.role) === 3000 ||
		Number(user.role) === 8000 ||
		roles.includes(1000) ||
		roles.includes(2000) ||
		roles.includes(3000) ||
		roles.includes(8000) ||
		descriptions.includes("hotelmanager") ||
		descriptions.includes("reception") ||
		descriptions.includes("reservationemployee");

	return hasOrderTakingScope && !hasFullReservationScope;
};

const isOrderTakerEditableReservation = (reservation = {}) => {
	const status = String(
		reservation?.reservation_status || reservation?.state || ""
	)
		.trim()
		.toLowerCase();
	const pendingStatus = String(reservation?.pendingConfirmation?.status || "")
		.trim()
		.toLowerCase();
	const agentDecisionStatus = String(
		reservation?.agentDecisionSnapshot?.status || ""
	)
		.trim()
		.toLowerCase();

	if (["confirmed", "rejected"].includes(agentDecisionStatus)) return false;
	if (["confirmed", "rejected"].includes(pendingStatus)) return false;
	if (
		/(confirmed|inhouse|checked[_\s-]?in|checked[_\s-]?out|cancel|reject|no[_\s-]?show|relocated)/i.test(
			status
		)
	) {
		return false;
	}

	return (
		PENDING_CONFIRMATION_REGEX.test(status) ||
		pendingStatus === "pending" ||
		!status
	);
};

const getAccountRoleNumbers = (account = {}) =>
	[
		Number(account.role),
		...(Array.isArray(account.roles) ? account.roles.map(Number) : []),
	].filter(Boolean);

const getAccountRoleDescriptions = (account = {}) => [
	String(account.roleDescription || "").toLowerCase(),
	...(Array.isArray(account.roleDescriptions)
		? account.roleDescriptions.map((item) => String(item || "").toLowerCase())
		: []),
];

const accountHasRole = (account = {}, role) =>
	getAccountRoleNumbers(account).includes(Number(role));

const accountHasDescription = (account = {}, description) =>
	getAccountRoleDescriptions(account).includes(
		String(description || "").toLowerCase()
	);

const isManagerOrAdminAccount = (account = {}) =>
	isConfiguredSuperAdmin(account) ||
	accountHasRole(account, 1000) ||
	accountHasRole(account, 2000) ||
	accountHasDescription(account, "hotelmanager");

const isFinanceAccount = (account = {}) =>
	accountHasRole(account, 6000) || accountHasDescription(account, "finance");

const isReservationEmployeeAccount = (account = {}) =>
	accountHasRole(account, 8000) ||
	accountHasDescription(account, "reservationemployee");

const isFinanceOnlyAccount = (account = {}) =>
	isFinanceAccount(account) &&
	!isManagerOrAdminAccount(account) &&
	!isReservationEmployeeAccount(account);

const isReservationEmployeeOnlyAccount = (account = {}) =>
	isReservationEmployeeAccount(account) &&
	!isManagerOrAdminAccount(account) &&
	!isFinanceAccount(account);

const getPendingWorkflowScopeForActor = (actor = {}) => {
	if (isFinanceOnlyAccount(actor)) return "commission";
	if (isReservationEmployeeOnlyAccount(actor)) return "pending";
	return "all";
};

const FINANCE_ONLY_RESERVATION_UPDATE_FIELDS = new Set([
	"commission",
	"commissionData",
	"commissionPaid",
	"commissionPaidAt",
	"commissionStatus",
	"financial_cycle",
	"financeStatus",
	"moneyTransferredToHotel",
	"moneyTransferredAt",
	"paid_amount",
	"paid_amount_breakdown",
	"payment",
	"sendEmail",
	"hotel_name",
	"hotelName",
]);

const getForbiddenFinanceReservationUpdateFields = (updates = {}) =>
	Object.keys(updates).filter(
		(field) => !FINANCE_ONLY_RESERVATION_UPDATE_FIELDS.has(field)
	);

const dateOnlyKey = (value) => {
	if (!value) return "";
	if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) {
		return value.slice(0, 10);
	}
	const parsed = moment.utc(value);
	return parsed.isValid() ? parsed.format("YYYY-MM-DD") : "";
};

const buildStayDateKeys = (checkinDate, checkoutDate) => {
	const startKey = dateOnlyKey(checkinDate);
	const endKey = dateOnlyKey(checkoutDate);
	const start = moment.utc(startKey, "YYYY-MM-DD", true);
	const endExclusive = moment.utc(endKey, "YYYY-MM-DD", true);
	if (!start.isValid() || !endExclusive.isValid() || !endExclusive.isAfter(start)) {
		return [];
	}

	const days = [];
	for (
		const day = start.clone();
		day.isBefore(endExclusive, "day");
		day.add(1, "day")
	) {
		days.push(day.format("YYYY-MM-DD"));
	}
	return days;
};

const normalizeCalendarText = (value) =>
	String(value || "")
		.trim()
		.toLowerCase();

const pushRoomSelection = (target, roomType, displayName, count = 1) => {
	const normalizedType = String(roomType || "").trim();
	const normalizedDisplay = String(displayName || "").trim();
	if (!normalizedType && !normalizedDisplay) return;
	const key = `${normalizeCalendarText(normalizedType)}|${normalizeCalendarText(
		normalizedDisplay
	)}`;
	if (!target.has(key)) {
		target.set(key, {
			room_type: normalizedType,
			displayName: normalizedDisplay,
			count: Math.max(1, Number(count || 1)),
		});
		return;
	}
	const current = target.get(key);
	current.count += Math.max(1, Number(count || 1));
};

const getReservationRoomSelections = async (reservationData = {}) => {
	const selectionMap = new Map();
	const selectedRooms = Array.isArray(reservationData.pickedRoomsType)
		? reservationData.pickedRoomsType
		: Array.isArray(reservationData.pickedRoomsPricing)
		  ? reservationData.pickedRoomsPricing
		  : [];

	selectedRooms.forEach((room) => {
		pushRoomSelection(
			selectionMap,
			room?.room_type || room?.roomType,
			room?.displayName || room?.display_name,
			room?.count
		);
	});

	if (
		selectionMap.size === 0 &&
		Array.isArray(reservationData.roomId) &&
		reservationData.roomId.length > 0
	) {
		const roomIds = reservationData.roomId
			.map((roomId) => String(roomId || "").trim())
			.filter((roomId) => ObjectId.isValid(roomId));
		if (roomIds.length > 0) {
			const rooms = await Rooms.find({ _id: { $in: roomIds } })
				.select("room_type display_name displayName")
				.lean()
				.exec();
			rooms.forEach((room) => {
				pushRoomSelection(
					selectionMap,
					room?.room_type,
					room?.displayName || room?.display_name,
					1
				);
			});
		}
	}

	return Array.from(selectionMap.values());
};

const calendarRateIsBlocked = (rate = {}) => {
	if (!rate || typeof rate !== "object") return false;
	const price = Number(rate.price);
	const rootPrice = Number(rate.rootPrice);
	const color = String(rate.color || "").toLowerCase();
	return (
		(Number.isFinite(price) && price <= 0) ||
		(Number.isFinite(rootPrice) && rootPrice <= 0 && color === "black") ||
		color === "black"
	);
};

const findRoomDetailForCalendar = (details = [], selection = {}) => {
	const roomType = normalizeCalendarText(selection.room_type);
	const displayName = normalizeCalendarText(selection.displayName);
	const exact = details.find(
		(detail) =>
			normalizeCalendarText(detail?.roomType || detail?.room_type) ===
				roomType &&
			normalizeCalendarText(detail?.displayName || detail?.display_name) ===
				displayName
	);
	if (exact) return exact;
	const byRoomType = details.find(
		(detail) =>
			normalizeCalendarText(detail?.roomType || detail?.room_type) === roomType
	);
	if (byRoomType) return byRoomType;
	return details.find(
		(detail) =>
			displayName &&
			normalizeCalendarText(detail?.displayName || detail?.display_name) ===
				displayName
	);
};

// Agent/order-taker reservations must respect hotel calendar blocks.
// The public booking site treats a nightly pricing row with price <= 0 as unavailable;
// this validator mirrors that rule on the PMS API so agents cannot bypass it.
const validateOrderTakerBlockedCalendar = async (reservationData = {}) => {
	const hotelId = normalizeId(reservationData.hotelId);
	if (!ObjectId.isValid(hotelId)) return { allowed: true };

	const stayDates = buildStayDateKeys(
		reservationData.checkin_date,
		reservationData.checkout_date
	);
	if (stayDates.length === 0) return { allowed: true };

	const selections = await getReservationRoomSelections(reservationData);
	if (selections.length === 0) return { allowed: true };

	const hotel = await HotelDetails.findById(hotelId)
		.select("hotelName roomCountDetails")
		.lean()
		.exec();
	const details = Array.isArray(hotel?.roomCountDetails)
		? hotel.roomCountDetails
		: [];
	const blockedRooms = [];

	selections.forEach((selection) => {
		const detail = findRoomDetailForCalendar(details, selection);
		const rates = Array.isArray(detail?.pricingRate) ? detail.pricingRate : [];
		const blockedDates = stayDates.filter((date) => {
			const rate = rates.find((item) => item?.calendarDate === date);
			return calendarRateIsBlocked(rate);
		});
		if (blockedDates.length > 0) {
			blockedRooms.push({
				room_type:
					selection.room_type || detail?.roomType || detail?.room_type || "",
				displayName:
					selection.displayName ||
					detail?.displayName ||
					detail?.display_name ||
					"",
				blockedDates,
			});
		}
	});

	if (blockedRooms.length === 0) return { allowed: true };
	const roomLabel =
		blockedRooms[0].displayName || blockedRooms[0].room_type || "Selected room";
	const dateLabel = blockedRooms[0].blockedDates.join(", ");

	return {
		allowed: false,
		agentCalendarBlocked: true,
		hotelName: hotel?.hotelName || "",
		blockedRooms,
		message: `${roomLabel} is blocked on the hotel calendar for ${dateLabel}. Agents cannot create reservations over blocked dates.`,
		messageArabic: `الغرفة ${roomLabel} محجوبة في تقويم الفندق خلال ${dateLabel}. لا يمكن للوكيل إنشاء حجز في هذه الفترة.`,
	};
};

const roomSelectionMatches = (left = {}, right = {}) => {
	const leftType = normalizeCalendarText(left.room_type || left.roomType);
	const rightType = normalizeCalendarText(right.room_type || right.roomType);
	const leftDisplay = normalizeCalendarText(
		left.displayName || left.display_name
	);
	const rightDisplay = normalizeCalendarText(
		right.displayName || right.display_name
	);
	if (leftType && rightType && leftType !== rightType) return false;
	return !leftDisplay || !rightDisplay || leftDisplay === rightDisplay;
};

const reservationCoversStayDate = (reservation = {}, dateKey = "") => {
	const checkinKey = dateOnlyKey(reservation.checkin_date);
	const checkoutKey = dateOnlyKey(reservation.checkout_date);
	return checkinKey && checkoutKey && checkinKey <= dateKey && dateKey < checkoutKey;
};

const reservationBlocksInventory = (reservation = {}) => {
	const status = String(reservation.reservation_status || reservation.state || "")
		.toLowerCase()
		.trim();
	return !/(cancel|reject|void|no[_\s-]?show|checked[_\s-]?out|checkedout)/i.test(
		status
	);
};

const validateReservationInventoryForCreate = async (
	reservationData = {},
	{ allowOverbook = false, excludeReservationId = "" } = {}
) => {
	const hotelId = String(reservationData.hotelId || "").trim();
	if (!ObjectId.isValid(hotelId)) return { allowed: true, issues: [], warnings: [] };

	const stayDates = buildStayDateKeys(
		reservationData.checkin_date,
		reservationData.checkout_date
	);
	if (!stayDates.length) return { allowed: true, issues: [], warnings: [] };

	const selections = await getReservationRoomSelections(reservationData);
	if (!selections.length) return { allowed: true, issues: [], warnings: [] };

	const hotel = await HotelDetails.findById(hotelId)
		.select("hotelName roomCountDetails")
		.lean()
		.exec();
	const details = Array.isArray(hotel?.roomCountDetails)
		? hotel.roomCountDetails
		: [];

	const reservations = await Reservations.find({
		hotelId: ObjectId(hotelId),
		checkin_date: { $lt: new Date(`${stayDates[stayDates.length - 1]}T23:59:59.999Z`) },
		checkout_date: { $gt: new Date(`${stayDates[0]}T00:00:00.000Z`) },
	})
		.select("_id checkin_date checkout_date reservation_status state pickedRoomsType pickedRoomsPricing")
		.lean()
		.exec();

	const excludedId = normalizeId(excludeReservationId);
	const activeReservations = reservations
		.filter(reservationBlocksInventory)
		.filter((reservation) => !excludedId || normalizeId(reservation._id) !== excludedId);
	const issues = [];

	for (const selection of selections) {
		const detail = findRoomDetailForCalendar(details, selection);
		const capacity = Math.max(0, Number(detail?.count || 0));
		for (const date of stayDates) {
			let reserved = 0;
			for (const reservation of activeReservations) {
				if (!reservationCoversStayDate(reservation, date)) continue;
				const reservationSelections = await getReservationRoomSelections(reservation);
				reserved += reservationSelections.reduce((sum, existingSelection) => {
					return roomSelectionMatches(selection, existingSelection)
						? sum + Math.max(1, Number(existingSelection.count || 1))
						: sum;
				}, 0);
			}
			const requested = Math.max(1, Number(selection.count || 1));
			const available = capacity - reserved;
			if (requested > available) {
				issues.push({
					code: "inventory_overbook",
					message: `${selection.displayName || selection.room_type || "Selected room"} has ${Math.max(available, 0)} available room(s) on ${date}, but ${requested} were requested.`,
					room_type: selection.room_type,
					displayName: selection.displayName,
					date,
					capacity,
					reserved,
					available: Math.max(available, 0),
					requested,
				});
			}
		}
	}

	const warnings = issues.map((issue) => ({
		...issue,
		code: "inventory_overbook_override",
		message: `${issue.message} The reservation was allowed because it was created by hotel staff.`,
	}));

	return {
		allowed: allowOverbook || issues.length === 0,
		issues,
		warnings: allowOverbook ? warnings : [],
		message:
			issues[0]?.message ||
			"Selected room type does not have enough available inventory.",
	};
};

const getReservationPricingErrorArabic = (error = {}) => {
	const roomLabel =
		error?.details?.displayName ||
		error?.details?.room_type ||
		"الغرفة المحددة";
	const dateLabel = error?.details?.date ? ` بتاريخ ${error.details.date}` : "";
	switch (error?.code) {
		case "calendar_date_blocked":
			return `${roomLabel} محجوبة في تقويم الفندق${dateLabel}. لا يمكن للوكيل الحجز على تاريخ محجوب.`;
		case "calendar_price_missing":
			return `لا يوجد سعر صالح للغرفة ${roomLabel}${dateLabel}. يرجى مراجعة تقويم الأسعار أو سعر الغرفة الأساسي.`;
		case "room_pricing_not_found":
			return "تعذر حساب سعر الغرفة المحددة. يرجى إعادة اختيار نوع الغرفة قبل الحفظ.";
		case "invalid_stay_dates":
			return "يجب أن يكون تاريخ المغادرة بعد تاريخ الوصول.";
		case "invalid_hotel_for_pricing":
			return "يجب تحديد فندق صحيح لحساب سعر الحجز.";
		case "hotel_pricing_not_found":
			return "لم يتم العثور على إعدادات أسعار الفندق.";
		default:
			return "تعذر حساب سعر الحجز. يرجى مراجعة التواريخ والغرف والمحاولة مرة أخرى.";
	}
};

const PENDING_CONFIRMATION_REGEX = /pending[\s_-]?confirmation/i;

const buildNewReservationProcessFilter = () => ({
	$or: [
		{ booked_at: { $gte: NEW_RESERVATION_PROCESS_START } },
		{
			$and: [
				{ $or: [{ booked_at: { $exists: false } }, { booked_at: null }] },
				{ createdAt: { $gte: NEW_RESERVATION_PROCESS_START } },
			],
		},
	],
});

const hasAssignedCommission = (reservation = {}) => {
	const directCommission = moneyNumber(reservation?.commission);
	const cycleCommission = moneyNumber(
		reservation?.financial_cycle?.commissionAmount
	);
	const commissionStatus = String(reservation?.commissionStatus || "")
		.trim()
		.toLowerCase();
	return (
		directCommission > 0 ||
		cycleCommission > 0 ||
		reservation?.commissionData?.assigned === true ||
		reservation?.financial_cycle?.commissionAssigned === true ||
		ASSIGNED_COMMISSION_STATUSES.has(commissionStatus)
	);
};

const buildCommissionMissingFilter = () => ({
	$and: [
		{
			$or: [
				{ commission: { $exists: false } },
				{ commission: null },
				{ commission: "" },
				{ commission: "0" },
				{ commission: { $lte: 0 } },
			],
		},
		{
			$or: [
				{ "financial_cycle.commissionAmount": { $exists: false } },
				{ "financial_cycle.commissionAmount": null },
				{ "financial_cycle.commissionAmount": "" },
				{ "financial_cycle.commissionAmount": "0" },
				{ "financial_cycle.commissionAmount": { $lte: 0 } },
			],
		},
		{ "commissionData.assigned": { $ne: true } },
		{ "financial_cycle.commissionAssigned": { $ne: true } },
		{
			$or: [
				{ commissionStatus: { $exists: false } },
				{ commissionStatus: null },
				{ commissionStatus: "" },
				{
					commissionStatus: {
						$nin: Array.from(ASSIGNED_COMMISSION_STATUSES),
					},
				},
			],
		},
	],
});

const getReservationNotificationType = (reservation = {}) => {
	const reasons = getPendingConfirmationReasons(reservation);
	if (
		reasons.includes("commission_missing") &&
		!reasons.includes("pending_confirmation") &&
		!reasons.includes("pending_rejected")
	) {
		return "commission_review";
	}
	return "pending_confirmation";
};

const buildPendingStatusFilter = () => ({
	$or: [
		{ reservation_status: PENDING_CONFIRMATION_REGEX },
		{ state: PENDING_CONFIRMATION_REGEX },
	],
});

const buildPendingConfirmationFilter = (hotelId, scope = "all") => {
	const reasonFilters =
		scope === "commission"
			? [buildCommissionMissingFilter()]
			: scope === "pending"
			? [buildPendingStatusFilter()]
			: [buildPendingStatusFilter(), buildCommissionMissingFilter()];

	return {
		hotelId: ObjectId(hotelId),
		$and: [
			buildNewReservationProcessFilter(),
			{ $or: reasonFilters },
		],
	};
};

const getPendingConfirmationReasonsForActor = (reservation = {}, actor = {}) => {
	const reasons = getPendingConfirmationReasons(reservation);
	if (isFinanceOnlyAccount(actor)) {
		return reasons.filter((reason) => reason === "commission_missing");
	}
	if (isReservationEmployeeOnlyAccount(actor)) {
		return reasons.filter((reason) => reason !== "commission_missing");
	}
	return reasons;
};

const getReservationNotificationTypeForActor = (reservation = {}, actor = {}) => {
	const reasons = getPendingConfirmationReasonsForActor(reservation, actor);
	if (
		reasons.includes("commission_missing") &&
		!reasons.includes("pending_confirmation") &&
		!reasons.includes("pending_rejected")
	) {
		return "commission_review";
	}
	return getReservationNotificationType(reservation);
};

const getPendingConfirmationReasons = (reservation = {}) => {
	const reasons = [];
	if (
		PENDING_CONFIRMATION_REGEX.test(
			String(reservation.reservation_status || reservation.state || "")
		)
	) {
		reasons.push("pending_confirmation");
	}
	if (
		String(reservation?.pendingConfirmation?.status || "").toLowerCase() ===
		"rejected"
	) {
		reasons.push("pending_rejected");
	}
	if (!hasAssignedCommission(reservation)) {
		reasons.push("commission_missing");
	}
	return reasons;
};

const sanitizeOrderTakerUpdate = (updates = {}) => {
	const allowed = {};
	const allowedCustomerFields = [
		"name",
		"phone",
		"email",
		"passport",
		"passportExpiry",
		"nationality",
		"copyNumber",
		"hasCar",
		"carLicensePlate",
		"carColor",
		"carModel",
		"carYear",
		"confirmationNumber",
	];
	const rawCustomerDetails =
		updates.customer_details || updates.customerDetails || null;

	if (rawCustomerDetails && typeof rawCustomerDetails === "object") {
		allowed.customer_details = allowedCustomerFields.reduce((acc, field) => {
			if (Object.prototype.hasOwnProperty.call(rawCustomerDetails, field)) {
				acc[field] = rawCustomerDetails[field];
			}
			return acc;
		}, {});
	}

	[
		"checkin_date",
		"checkout_date",
		"days_of_residence",
		"total_guests",
		"adults",
		"children",
		"comment",
		"booking_comment",
		"pickedRoomsType",
		"pickedRoomsPricing",
		"total_rooms",
		"sub_total",
		"total_amount",
	].forEach((field) => {
		if (Object.prototype.hasOwnProperty.call(updates, field)) {
			allowed[field] = updates[field];
		}
	});

	return allowed;
};

const normalizeId = (value) => String(value?._id || value || "").trim();

const includesId = (list = [], targetId) =>
	Array.isArray(list) &&
	list.some((item) => normalizeId(item) === normalizeId(targetId));

const isConfiguredSuperAdmin = (user) => {
	const configuredIds = [
		process.env.SUPER_ADMIN_ID,
		process.env.REACT_APP_SUPER_ADMIN_ID,
	]
		.filter(Boolean)
		.map((id) => String(id).trim());
	return configuredIds.includes(normalizeId(user));
};

const canViewReservationHotel = async (actor, hotelId) => {
	if (!actor || !ObjectId.isValid(hotelId)) return false;
	if (Number(actor.role) === 1000 || isConfiguredSuperAdmin(actor)) return true;

	const hotel = await HotelDetails.findById(hotelId)
		.select("_id belongsTo")
		.lean()
		.exec();
	if (!hotel) return false;

	const actorId = normalizeId(actor._id);
	const ownerId = normalizeId(hotel.belongsTo);
	const normalizedHotelId = normalizeId(hotel._id);

	if (Number(actor.role) === 2000 && actorId === ownerId) return true;
	if (includesId(actor.hotelIdsOwner, normalizedHotelId)) return true;
	if (includesId(actor.hotelsToSupport, normalizedHotelId)) return true;

	return (
		normalizeId(actor.hotelIdWork) === normalizedHotelId &&
		normalizeId(actor.belongsToId) === ownerId
	);
};

const canUsePendingConfirmationWorkflow = (actor = {}) => {
	const roles = [
		Number(actor.role),
		...(Array.isArray(actor.roles) ? actor.roles.map(Number) : []),
	].filter(Boolean);
	const descriptions = [
		String(actor.roleDescription || "").toLowerCase(),
		...(Array.isArray(actor.roleDescriptions)
			? actor.roleDescriptions.map((item) => String(item || "").toLowerCase())
			: []),
	];
	return (
		isConfiguredSuperAdmin(actor) ||
		[1000, 2000, 6000, 8000].some((role) => roles.includes(role)) ||
		descriptions.includes("hotelmanager") ||
		descriptions.includes("finance") ||
		descriptions.includes("reservationemployee")
	);
};

const getPendingNotificationHotelsForActor = async (actor = {}, ownerId = "") => {
	if (!actor) return [];

	const requestedOwnerId = normalizeId(ownerId);
	const actorId = normalizeId(actor._id);
	const role = Number(actor.role);

	let query = null;
	if (
		(role === 1000 || isConfiguredSuperAdmin(actor)) &&
		requestedOwnerId &&
		ObjectId.isValid(requestedOwnerId)
	) {
		query = { belongsTo: ObjectId(requestedOwnerId) };
	} else if (role === 1000 || isConfiguredSuperAdmin(actor)) {
		query = {};
	} else if (role === 2000 && !normalizeId(actor.belongsToId)) {
		const ids = [
			...(Array.isArray(actor.hotelIdsOwner) ? actor.hotelIdsOwner : []),
			...(Array.isArray(actor.hotelsToSupport) ? actor.hotelsToSupport : []),
		]
			.map(normalizeId)
			.filter((id) => id && ObjectId.isValid(id))
			.map((id) => ObjectId(id));
		query = {
			$or: [
				{ belongsTo: ObjectId(actorId) },
				...(ids.length ? [{ _id: { $in: ids } }] : []),
			],
		};
	} else {
		const ids = [
			...(Array.isArray(actor.hotelsToSupport) ? actor.hotelsToSupport : []),
			normalizeId(actor.hotelIdWork),
		]
			.map(normalizeId)
			.filter((id) => id && ObjectId.isValid(id))
			.map((id) => ObjectId(id));
		if (!ids.length) return [];
		query = { _id: { $in: ids } };
	}

	return HotelDetails.find(query)
		.select("_id hotelName belongsTo")
		.lean()
		.exec();
};

const accountLooksLikeAgent = (account = {}) => {
	const roles = [
		Number(account.role),
		...(Array.isArray(account.roles) ? account.roles.map(Number) : []),
	].filter(Boolean);
	const descriptions = [
		String(account.roleDescription || "").toLowerCase(),
		...(Array.isArray(account.roleDescriptions)
			? account.roleDescriptions.map((item) => String(item || "").toLowerCase())
			: []),
	];
	return (
		roles.includes(7000) ||
		descriptions.some((description) =>
			/(ordertaker|order taker|external agent|agent)/i.test(description)
		) ||
		(Array.isArray(account.accessTo) && account.accessTo.includes("ownReservations"))
	);
};

const buildAgentReservationOwnerClauses = (agentId) => {
	const normalizedAgentId = normalizeId(agentId);
	const clauses = [];
	if (ObjectId.isValid(normalizedAgentId)) {
		clauses.push(
			{ createdByUserId: ObjectId(normalizedAgentId) },
			{ orderTakeId: ObjectId(normalizedAgentId) }
		);
	}
	clauses.push(
		{ "createdBy._id": normalizedAgentId },
		{ "orderTaker._id": normalizedAgentId }
	);
	return clauses;
};

const reservationIsWalletDeductible = (reservation = {}) => {
	const status = String(
		reservation.reservation_status ||
			reservation.state ||
			reservation?.pendingConfirmation?.status ||
			""
	).toLowerCase();
	return !/(cancel|reject|void)/i.test(status);
};

const resolveReservationAgent = async (reservation = {}) => {
	const possibleIds = [
		normalizeId(reservation.orderTakeId),
		normalizeId(reservation.createdByUserId),
		normalizeId(reservation?.orderTaker?._id),
		normalizeId(reservation?.createdBy?._id),
	].filter(Boolean);
	const uniqueIds = [...new Set(possibleIds)];
	const snapshotCandidate = accountLooksLikeAgent(reservation.orderTaker)
		? reservation.orderTaker
		: accountLooksLikeAgent(reservation.createdBy)
		? reservation.createdBy
		: null;

	for (const possibleId of uniqueIds) {
		if (!ObjectId.isValid(possibleId)) continue;
		const agent = await User.findById(possibleId)
			.select(
				"_id name email phone companyName role roleDescription roles roleDescriptions accessTo"
			)
			.lean()
			.exec();
		if (agent && accountLooksLikeAgent(agent)) return agent;
	}

	if (snapshotCandidate && normalizeId(snapshotCandidate._id)) {
		return {
			_id: snapshotCandidate._id,
			name: snapshotCandidate.name || "",
			email: snapshotCandidate.email || "",
			phone: snapshotCandidate.phone || "",
			companyName: snapshotCandidate.companyName || "",
			role: snapshotCandidate.role || 7000,
			roleDescription: snapshotCandidate.roleDescription || "ordertaker",
		};
	}

	return null;
};

const resolveSnapshotDate = (reservation = {}) => {
	const candidates = [
		reservation.orderTakenAt,
		reservation.booked_at,
		reservation.createdAt,
		new Date(),
	];
	for (const candidate of candidates) {
		const date = candidate instanceof Date ? candidate : new Date(candidate);
		if (!Number.isNaN(date.getTime())) return date;
	}
	return new Date();
};

const getPlainAgentWalletSnapshot = (reservationOrSnapshot = {}) => {
	const snapshot =
		reservationOrSnapshot?.agentWalletSnapshot !== undefined
			? reservationOrSnapshot.agentWalletSnapshot
			: reservationOrSnapshot;
	if (snapshot && typeof snapshot.toObject === "function") {
		return snapshot.toObject();
	}
	return snapshot || {};
};

const reconcileAgentWalletSnapshotAmount = (
	snapshot = {},
	reservation = {},
	updates = {}
) => {
	if (!snapshot?.captured) return snapshot;
	const hasTotalAmount =
		Object.prototype.hasOwnProperty.call(updates, "total_amount") ||
		reservation?.total_amount !== undefined;
	if (!hasTotalAmount) return snapshot;

	const reservationAmount = n2(
		Object.prototype.hasOwnProperty.call(updates, "total_amount")
			? updates.total_amount
			: reservation.total_amount
	);
	const balanceBeforeReservation = n2(snapshot.balanceBeforeReservation);
	const commissionAmount = n2(
		updates.commission ??
			updates.financial_cycle?.commissionAmount ??
			reservation?.commission ??
			reservation?.financial_cycle?.commissionAmount ??
			snapshot.commissionAmount ??
			0
	);

	return {
		...snapshot,
		reservationAmount,
		balanceAfterReservation: n2(balanceBeforeReservation - reservationAmount),
		commissionAmount,
	};
};

const agentWalletSnapshotNeedsSync = (currentSnapshot = {}, nextSnapshot = {}) =>
	n2(currentSnapshot?.reservationAmount) !== n2(nextSnapshot?.reservationAmount) ||
	n2(currentSnapshot?.balanceAfterReservation) !==
		n2(nextSnapshot?.balanceAfterReservation) ||
	n2(currentSnapshot?.commissionAmount) !== n2(nextSnapshot?.commissionAmount);

const syncExistingAgentWalletSnapshotForUpdates = (reservation = {}, updates = {}) => {
	if (!Object.prototype.hasOwnProperty.call(updates, "total_amount")) return null;
	const existingSnapshot = getPlainAgentWalletSnapshot(reservation);
	if (!existingSnapshot?.captured) return null;
	const nextSnapshot = reconcileAgentWalletSnapshotAmount(
		existingSnapshot,
		reservation,
		updates
	);
	return agentWalletSnapshotNeedsSync(existingSnapshot, nextSnapshot)
		? nextSnapshot
		: null;
};

const buildReservationAgentWalletSnapshot = async ({
	reservation,
	actor,
	reason = "reservation_detail",
	force = false,
}) => {
	const existingSnapshot = getPlainAgentWalletSnapshot(reservation);

	if (existingSnapshot?.captured && !force) {
		return reconcileAgentWalletSnapshotAmount(existingSnapshot, reservation);
	}

	const hotelId = normalizeId(reservation?.hotelId);
	if (!hotelId || !ObjectId.isValid(hotelId)) return null;

	const agent = await resolveReservationAgent(reservation);
	const agentId = normalizeId(agent?._id);
	if (!agentId || !ObjectId.isValid(agentId)) return null;

	const snapshotAt = resolveSnapshotDate(reservation);
	const agentClauses = buildAgentReservationOwnerClauses(agentId);
	const transactionDateMatch = {
		hotelId: ObjectId(hotelId),
		agentId: ObjectId(agentId),
		status: { $ne: "void" },
		transactionDate: { $lte: snapshotAt },
	};
	const priorReservationMatch = {
		hotelId: ObjectId(hotelId),
		_id: { $ne: reservation._id },
		$and: [
			{ $or: agentClauses },
			{
				$or: [
					{ booked_at: { $lte: snapshotAt } },
					{
						$and: [
							{ $or: [{ booked_at: { $exists: false } }, { booked_at: null }] },
							{ createdAt: { $lte: snapshotAt } },
						],
					},
				],
			},
		],
	};

	const [transactions, priorReservations] = await Promise.all([
		AgentWallet.find(transactionDateMatch)
			.select("transactionType amount transactionDate status")
			.lean()
			.exec(),
		Reservations.find(priorReservationMatch)
			.select("_id total_amount reservation_status state pendingConfirmation")
			.lean()
			.exec(),
	]);

	const transactionTotals = transactions.reduce(
		(acc, transaction) => {
			const amount = n2(transaction.amount);
			if (
				transaction.transactionType === "deposit" ||
				transaction.transactionType === "refund"
			) {
				acc.credits += amount;
			} else if (transaction.transactionType === "debit") {
				acc.manualDebits += amount;
			} else {
				acc.adjustments += amount;
			}
			return acc;
		},
		{ credits: 0, adjustments: 0, manualDebits: 0 }
	);

	const priorReservationValue = priorReservations.reduce((sum, item) => {
		return reservationIsWalletDeductible(item)
			? n2(sum + moneyNumber(item.total_amount))
			: sum;
	}, 0);

	const walletAddedBeforeReservation = n2(
		transactionTotals.credits + transactionTotals.adjustments
	);
	const walletUsedBeforeReservation = n2(
		priorReservationValue + transactionTotals.manualDebits
	);
	const balanceBeforeReservation = n2(
		walletAddedBeforeReservation - walletUsedBeforeReservation
	);
	const reservationAmount = n2(reservation?.total_amount || 0);

	return {
		captured: true,
		capturedAt: new Date(),
		snapshotAt,
		capturedReason: reason,
		currency: reservation?.currency || "SAR",
		agent: {
			_id: agentId,
			name: agent.name || agent.email || "",
			email: agent.email || "",
			phone: agent.phone || "",
			companyName: agent.companyName || "",
		},
		walletAddedBeforeReservation,
		walletUsedBeforeReservation,
		priorReservationValue: n2(priorReservationValue),
		manualDebitsBeforeReservation: n2(transactionTotals.manualDebits),
		balanceBeforeReservation,
		reservationAmount,
		balanceAfterReservation: n2(balanceBeforeReservation - reservationAmount),
		commissionAmount: n2(
			reservation?.commission || reservation?.financial_cycle?.commissionAmount || 0
		),
		bookingSource: reservation?.booking_source || "",
		confirmationNumber: reservation?.confirmation_number || "",
		capturedBy: actor || null,
	};
};

const resolveReservationListActor = async (req) => {
	const actorId = req.auth?._id;
	if (!actorId || !ObjectId.isValid(actorId)) return null;
	return User.findById(actorId)
		.select(
			"_id role roleDescription roles roleDescriptions accessTo hotelIdWork belongsToId hotelsToSupport hotelIdsOwner"
		)
		.lean()
		.exec();
};

const applyOwnReservationFilter = (dynamicFilter, parsedFilters = {}, actor = null) => {
	const actorId = String(
		isOrderTakingAccount(actor)
			? actor?._id
			: parsedFilters.createdByUserId || ""
	).trim();
	if (!actorId || !ObjectId.isValid(actorId)) return dynamicFilter;
	dynamicFilter.$and = [
		...(Array.isArray(dynamicFilter.$and) ? dynamicFilter.$and : []),
		{
			$or: [
				{ createdByUserId: ObjectId(actorId) },
				{ "createdBy._id": actorId },
				{ orderTakeId: ObjectId(actorId) },
				{ "orderTaker._id": actorId },
			],
		},
	];
	return dynamicFilter;
};

const buildReservationSearchMatch = (searchQuery) => {
	const trimmed = String(searchQuery || "").trim();
	if (!trimmed) return null;

	const isRoomSearch = /^r\d+$/i.test(trimmed);
	const queryValue = isRoomSearch ? trimmed.substring(1) : trimmed;
	const searchPattern = new RegExp(queryValue, "i");

	if (isRoomSearch) {
		return { "roomDetails.room_number": searchPattern };
	}

	return {
		$or: [
			{ "customer_details.name": searchPattern },
			{ "customer_details.phone": searchPattern },
			{ "customer_details.email": searchPattern },
			{ "customer_details.carLicensePlate": searchPattern },
			{ "customer_details.carColor": searchPattern },
			{ "customer_details.carModel": searchPattern },
			{ "customer_details.passport": searchPattern },
			{ "customer_details.passportExpiry": searchPattern },
			{ "customer_details.nationality": searchPattern },
			{ confirmation_number: searchPattern },
			{ reservation_id: searchPattern },
			{ reservation_status: searchPattern },
			{ booking_source: searchPattern },
			{ payment: searchPattern },
			{ "roomDetails.room_number": searchPattern },
		],
	};
};

exports.reservationById = (req, res, next, id) => {
	Reservations.findById(id).exec((err, reservations) => {
		if (err || !reservations) {
			return res.status(400).json({
				error: "reservations was not found",
			});
		}
		req.reservations = reservations;
		next();
	});
};

function generateRandomNumber() {
	let randomNumber = Math.floor(1000000000 + Math.random() * 9000000000); // Generates a 10-digit number
	return randomNumber.toString();
}

// Modified ensureUniqueNumber function to accept field name
function ensureUniqueNumber(model, fieldName, callback) {
	const randomNumber = generateRandomNumber();
	let query = {};
	query[fieldName] = randomNumber;
	model.findOne(query, (err, doc) => {
		if (err) {
			callback(err);
		} else if (doc) {
			ensureUniqueNumber(model, fieldName, callback); // Recursively generate a new number if the current one exists
		} else {
			callback(null, randomNumber);
		}
	});
}

const createPdfBuffer = async (html) => {
	const browser = await puppeteer.launch({
		headless: true,
		args: [
			"--no-sandbox",
			"--disable-setuid-sandbox",
			"--disable-dev-shm-usage",
			"--disable-accelerated-2d-canvas",
			"--no-first-run",
			"--no-zygote",
			"--single-process", // <- this one doesn't works in Windows
			"--disable-gpu",
		],
	});

	const page = await browser.newPage();
	await page.setContent(html, { waitUntil: "networkidle0" });
	const pdfBuffer = await page.pdf({ format: "A4", printBackground: true });
	await browser.close();
	return pdfBuffer;
};

const sendEmailWithPdf = async (reservationData, opts = {}) => {
	// Dynamically generating HTML content for the email body and PDF
	const htmlContent = confirmationEmail(reservationData);
	const hotelForPdf =
		reservationData?.hotelId && typeof reservationData.hotelId === "object"
			? reservationData.hotelId
			: {
					hotelName: reservationData?.hotelName || "",
					suppliedBy: reservationData?.belongsTo?.name || "",
			  };
	const pdfHtml = receiptPdfTemplate(reservationData, hotelForPdf);
	const pdfBuffer = await createPdfBuffer(pdfHtml);
	const toEmail =
		opts.toEmail ||
		reservationData?.customer_details?.email ||
		"ahmedabdelrazak20@gmail.com";

	const FormSubmittionEmail = {
		to: toEmail,
		from: "noreply@jannatbooking.com",
		// cc: [
		// 	{ email: "ayed.hotels@gmail.com" },
		// 	{ email: "zaerhotel@gmail.com" },
		// 	{ email: "3yedhotel@gmail.com" },
		// 	{ email: "morazzakhamouda@gmail.com" },
		// ],
		bcc: [
			{ email: "morazzakhamouda@gmail.com" },
			{ email: "xhoteleg@gmail.com" },
			{ email: "ahmed.abdelrazak@jannatbooking.com" },
			{ email: "support@jannatbooking.com" },
		],
		subject: `Jannat Booking - Reservation Confirmation`,
		html: htmlContent,
		attachments: [
			{
				content: pdfBuffer.toString("base64"),
				filename: "Reservation_Confirmation.pdf",
				type: "application/pdf",
				disposition: "attachment",
			},
		],
	};

	try {
		await sgMail.send(FormSubmittionEmail);
	} catch (error) {
		console.error(
			"Error sending email with PDF error.response.boyd",
			error.response.body
		);
		console.error("Error sending email with PDF", error);
		// Handle error appropriately
	}
};

exports.create = async (req, res) => {
	const resolveCreatedBy = async () => {
		const actorId =
			req.auth?._id ||
			req.body?.requestingUserId ||
			req.body?.createdByUserId ||
			req.params?.userId;
		if (actorId && ObjectId.isValid(actorId)) {
			const actor = await User.findById(actorId)
				.select(
					"_id name email companyName role roleDescription roles roleDescriptions accessTo"
				)
				.lean()
			.exec();
			if (actor) {
				const actorSnapshot = buildReservationActorSnapshot(actor);
				const actorBookingSource = String(actor.companyName || actor.name || actor.email || "").trim();
				return {
					createdByUserId: actor._id,
					createdBy: actorSnapshot,
					orderTakeId: actor._id,
					orderTaker: actorSnapshot,
					orderTakenAt: new Date(),
					booking_source: req.body?.booking_source || actorBookingSource,
					forcePendingConfirmation: isOrderTakingAccount(actor),
				};
			}
		}
		return {};
	};

	const saveReservation = async (reservationData) => {
		const actorFields = await resolveCreatedBy();
		const { forcePendingConfirmation, ...reservationActorFields } = actorFields;
		const existingAuditLog = Array.isArray(reservationData.reservationAuditLog)
			? reservationData.reservationAuditLog
			: [];
		const reservationPayload = {
			...reservationData,
			...reservationActorFields,
		};
		const reservationWarnings = [];
		if (forcePendingConfirmation) {
			reservationPayload.reservation_status = "Pending Confirmation";
			reservationPayload.state = "Pending Confirmation";
			// Agent/order-taker reservations always start with a 0 SAR commission
			// that is intentionally not assigned yet. Hotel/finance can later
			// review it and save 0 again when no commission is due.
			reservationPayload.commission = 0;
			reservationPayload.commissionPaid = false;
			reservationPayload.commissionStatus = "";
			reservationPayload.commissionData = {
				...(reservationPayload.commissionData &&
				typeof reservationPayload.commissionData === "object"
					? reservationPayload.commissionData
					: {}),
				assigned: false,
				amount: 0,
				status: "pending hotel review",
				source: "agent_reservation",
			};
			reservationPayload.financial_cycle = {
				...(reservationPayload.financial_cycle &&
				typeof reservationPayload.financial_cycle === "object"
					? reservationPayload.financial_cycle
					: {}),
				commissionAmount: 0,
				commissionValue: 0,
				commissionAssigned: false,
				status: "open",
			};

			const calendarValidation =
				await validateOrderTakerBlockedCalendar(reservationPayload);
			if (!calendarValidation.allowed) {
				return res.status(409).json({
					error: calendarValidation.message,
					errorArabic: calendarValidation.messageArabic,
					agentCalendarBlocked: true,
					blockedCalendar: calendarValidation,
				});
			}

		}

		try {
			const pricingResult = await normalizeReservationCreationPricing(
				reservationPayload,
				{ allowBlockedCalendar: !forcePendingConfirmation }
			);
			Object.assign(reservationPayload, pricingResult.reservation);
			if (Array.isArray(pricingResult.warnings)) {
				reservationWarnings.push(...pricingResult.warnings);
			}

			const inventoryValidation = await validateReservationInventoryForCreate(
				reservationPayload,
				{ allowOverbook: !forcePendingConfirmation }
			);
			if (!inventoryValidation.allowed) {
				return res.status(409).json({
					error: inventoryValidation.message,
					errorArabic:
						"\u0644\u0627 \u062a\u0648\u062c\u062f \u063a\u0631\u0641 \u0643\u0627\u0641\u064a\u0629 \u0644\u0647\u0630\u0627 \u0627\u0644\u0646\u0648\u0639 \u0641\u064a \u0627\u0644\u062a\u0648\u0627\u0631\u064a\u062e \u0627\u0644\u0645\u062d\u062f\u062f\u0629. \u0644\u0627 \u064a\u0645\u0643\u0646 \u0644\u0644\u0648\u0643\u064a\u0644 \u062a\u062c\u0627\u0648\u0632 \u0627\u0644\u0645\u062e\u0632\u0648\u0646.",
					agentInventoryBlocked: true,
					inventory: inventoryValidation,
				});
			}
			if (Array.isArray(inventoryValidation.warnings)) {
				reservationWarnings.push(...inventoryValidation.warnings);
			}
		} catch (error) {
			if (error instanceof ReservationPricingError || error?.statusCode) {
				return res.status(error.statusCode || 400).json({
					error: error.message,
					errorArabic: getReservationPricingErrorArabic(error),
					code: error.code || "reservation_pricing_error",
					details: error.details || {},
				});
			}
			throw error;
		}

		// Check if roomId array is present and has length more than 0
		if (reservationData.roomId && reservationData.roomId.length > 0) {
			try {
				// Update cleanRoom field for all rooms in the roomId array
				await Rooms.updateMany(
					{ _id: { $in: reservationData.roomId } },
					{
						$set: {
							cleanRoom: false,
							housekeepingLastCleanedAt: null,
							housekeepingLastDirtyAt: new Date(),
							housekeepingDirtyReason: "reservation_created",
						},
					}
				);
			} catch (err) {
				console.error("Error updating Rooms cleanRoom status", err);
				// Optionally, handle the error, for example, by returning a response
				// return res.status(500).json({ error: "Error updating room status" });
			}
		}

		reservationPayload.reservationAuditLog = [
			...existingAuditLog,
			buildReservationCreatedAuditEntry(reservationPayload, reservationActorFields),
		];
		const reservations = new Reservations(reservationPayload);
		try {
			const data = await reservations.save();
			res.json({ data, warnings: reservationWarnings });
			emitHotelNotificationRefresh(req, data.hotelId, {
				type: forcePendingConfirmation ? "pending_confirmation" : "reservation_update",
				reservationId: data._id,
				ownerId: data.belongsTo,
			}).catch((error) =>
				console.error("Error emitting reservation notification:", error)
			);
			if (req.body.sendEmail) {
				await sendEmailWithPdf(reservationData);
			}
		} catch (err) {
			console.log(err, "err");
			return res.status(400).json({
				error: "Cannot Create reservations",
			});
		}
	};

	if (!req.body.confirmation_number) {
		ensureUniqueNumber(
			Reservations,
			"confirmation_number",
			async (err, uniqueNumber) => {
				if (err) {
					return res
						.status(500)
						.json({ error: "Error checking for unique number" });
				}
				req.body.confirmation_number = uniqueNumber;
				saveReservation(req.body);
			}
		);
	} else {
		saveReservation(req.body);
	}
};

exports.sendReservationEmail = async (req, res) => {
	const reservationData = req.body; // full reservation payload
	// Fetch the reservation data based on reservationId
	// This is a placeholder, replace it with your actual data fetching logic

	if (!reservationData) {
		return res.status(404).json({ error: "Reservation not found" });
	}

	try {
		const overrideEmail = req.body?.overrideEmail || req.body?.customerEmail;
		if (overrideEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(overrideEmail)) {
			return res.status(400).json({ error: "Invalid email address" });
		}
		await sendEmailWithPdf(reservationData, {
			toEmail: overrideEmail || reservationData?.customer_details?.email,
		});
		res.json({ message: "Email sent successfully" });
	} catch (error) {
		console.error("Error sending email:", error);
		res.status(500).json({ error: "Failed to send email" });
	}
};

exports.sendPaymentLinkEmail = async (req, res) => {
	const {
		paymentLink,
		customerEmail,
		guestName,
		hotelName,
		confirmationNumber,
		totalAmount,
		paidAmount,
		currency,
		checkinDate,
		checkoutDate,
	} = req.body; // payment link + optional context

	if (!paymentLink || !customerEmail) {
		return res
			.status(400)
			.json({ error: "Missing payment link or customer email" });
	}

	const emailContent = emailPaymentLink({
		paymentLink,
		guestName,
		hotelName,
		confirmationNumber,
		totalAmount,
		paidAmount,
		currency,
		checkinDate,
		checkoutDate,
	}); // Generate the email content with the payment link

	const subjectBase = hotelName
		? `Payment Link - ${hotelName}`
		: "Reservation Payment Link";
	const subject = confirmationNumber
		? `${subjectBase} (#${confirmationNumber})`
		: subjectBase;

	const email = {
		to: customerEmail, // The customer's email address
		from: "noreply@jannatbooking.com",
		// cc: [
		// 	{ email: "ayed.hotels@gmail.com" },
		// 	{ email: "zaerhotel@gmail.com" },
		// 	{ email: "3yedhotel@gmail.com" },
		// 	{ email: "morazzakhamouda@gmail.com" },
		// ],
		bcc: [
			{ email: "morazzakhamouda@gmail.com" },
			{ email: "xhoteleg@gmail.com" },
			{ email: "ahmed.abdelrazak@jannatbooking.com" },
			{ email: "support@jannatbooking.com" },
		],
		subject,
		html: emailContent, // Use the generated HTML content
	};

	try {
		await sgMail.send(email);
		res.json({ message: "Payment link email sent successfully" });
	} catch (error) {
		console.error("Error sending payment link email:", error);
		res.status(500).json({ error: "Failed to send payment link email" });
	}
};

exports.reservationSearchAllList = async (req, res) => {
	try {
		const { searchQuery, accountId } = req.params;
		const hotelId = mongoose.Types.ObjectId(accountId);

		// Check if search query starts with 'r' followed by digits
		const isRoomSearch = /^r\d+$/i.test(searchQuery);
		let roomNumberSearchPattern;
		if (isRoomSearch) {
			// Extract the room number from the search query
			roomNumberSearchPattern = new RegExp(searchQuery.substring(1), "i");
		} else {
			// Regular search pattern for other fields
			roomNumberSearchPattern = new RegExp(searchQuery, "i");
		}

		let pipeline = [
			{ $match: { hotelId: hotelId } },
			// Lookup (populate) roomId details
			{
				$lookup: {
					from: "rooms",
					localField: "roomId",
					foreignField: "_id",
					as: "roomDetails",
				},
			},
			// Lookup (populate) belongsTo details
			{
				$lookup: {
					from: "users",
					localField: "belongsTo",
					foreignField: "_id",
					as: "belongsToDetails",
				},
			},
		];

		// Conditionally adjust the match stage based on the search type
		if (isRoomSearch) {
			// Add match stage for room number search
			pipeline.push({
				$match: {
					"roomDetails.room_number": roomNumberSearchPattern,
				},
			});
		} else {
			// Add match stage for general search
			pipeline.push({
				$match: {
					$or: [
						{ "customer_details.name": roomNumberSearchPattern },
						{ "customer_details.phone": roomNumberSearchPattern },
						{ "customer_details.email": roomNumberSearchPattern },
						{ "customer_details.carLicensePlate": roomNumberSearchPattern },
						{ "customer_details.carColor": roomNumberSearchPattern },
						{ "customer_details.carModel": roomNumberSearchPattern },
						{ "customer_details.passport": roomNumberSearchPattern },
						{ "customer_details.passportExpiry": roomNumberSearchPattern },
						{ "customer_details.nationality": roomNumberSearchPattern },
						{ confirmation_number: roomNumberSearchPattern },
						{ reservation_id: roomNumberSearchPattern },
						{ reservation_status: roomNumberSearchPattern },
						{ booking_source: roomNumberSearchPattern },
						{ payment: roomNumberSearchPattern },
						// Include room number search in general search as well
						{ "roomDetails.room_number": roomNumberSearchPattern },
					],
				},
			});
		}

		// Execute the aggregation pipeline
		const reservations = await Reservations.aggregate(pipeline);

		if (reservations.length === 0) {
			return res.status(404).json({
				error: "No reservations found matching the search criteria.",
			});
		}

		res.json(reservations);
	} catch (error) {
		console.error("Error in reservationSearchAllList:", error);
		res.status(500).send("Server error");
	}
};

exports.reservationSearch = async (req, res) => {
	try {
		const { searchQuery, accountId } = req.params;
		const hotelId = mongoose.Types.ObjectId(accountId);
		// Create a regex pattern to match the search query in a case-insensitive manner
		const searchPattern = new RegExp(searchQuery, "i");

		// Query to search across various fields
		const query = {
			hotelId: hotelId,
			$or: [
				{ "customer_details.name": searchPattern },
				{ "customer_details.phone": searchPattern },
				{ "customer_details.email": searchPattern },
				{ "customer_details.passport": searchPattern },
				{ "customer_details.passportExpiry": searchPattern },
				{ "customer_details.nationality": searchPattern },
				{ confirmation_number: searchPattern },
				{ provider_number: searchPattern },
			],
		};

		// Fetch the first matching document
		const reservation = await Reservations.findOne(query).populate("belongsTo");

		if (!reservation) {
			return res.status(404).json({
				error: "No reservation found matching the search criteria.",
			});
		}

		res.json(reservation);
	} catch (error) {
		res.status(500).send("Server error");
	}
};

// Normalize room names
function normalizeRoomName(apiRoomName) {
	return apiRoomName.split(" - ")[0].trim();
}

// Mapping function for room type
function mapRoomType(apiRoomName) {
	const normalizedRoomName = normalizeRoomName(apiRoomName);
	const roomTypeMappings = {
		// Add mappings similar to your previous implementation
	};
	return roomTypeMappings[normalizedRoomName] || normalizedRoomName;
}

// Main mapping function for Hotel Runner response to reservationsSchema
function mapHotelRunnerResponseToSchema(apiResponse) {
	const mappedRooms = apiResponse.rooms.map((room) => ({
		room_type: mapRoomType(room.name),
		chosenPrice: room.total,
		count: 1, // Assuming each room object represents one room
	}));

	return {
		reservation_id: apiResponse.hr_number,
		hr_number: apiResponse.hr_number,
		confirmation_number: apiResponse.provider_number.toString(),
		pms_number: apiResponse.pms_number,
		booking_source: apiResponse.channel_display.toLowerCase(),
		customer_details: {
			name: `${apiResponse.firstname} ${apiResponse.lastname}`,
			phone: apiResponse.address.phone,
			email: apiResponse.address.email,
			passport: apiResponse.guest_national_id,
			nationality: apiResponse.country,
		},
		state: apiResponse.state,
		reservation_status: apiResponse.state,
		total_guests: apiResponse.total_guests,
		total_rooms: apiResponse.total_rooms,
		cancel_reason: apiResponse.cancel_reason,
		booked_at: new Date(apiResponse.completed_at),
		sub_total: apiResponse.sub_total,
		extras_total: apiResponse.extras_total,
		tax_total: apiResponse.tax_total,
		total_amount: apiResponse.total,
		currency: apiResponse.currency,
		checkin_date: new Date(apiResponse.checkin_date),
		checkout_date: new Date(apiResponse.checkout_date),
		comment: apiResponse.note,
		payment: apiResponse.payment,
		payment_details: apiResponse.payment_details,
		paid_amount: apiResponse.paid_amount,
		payments: apiResponse.payments,
		pickedRoomsType: mappedRooms,
		days_of_residence: calculateDaysBetweenDates(
			apiResponse.checkin_date,
			apiResponse.checkout_date
		),
		// Assuming roomId, belongsTo, and hotelId will be set in the main function
	};
}

// Helper function for date difference
function calculateDaysBetweenDates(startDate, endDate) {
	const start = new Date(startDate);
	const end = new Date(endDate);
	return (end - start) / (1000 * 60 * 60 * 24);
}

exports.getListOfReservations = async (req, res) => {
	try {
		const { page, records, filters, hotelId, date } = req.params;
		const parsedPage = parseInt(page);
		const parsedRecords = parseInt(records);

		if (
			isNaN(parsedPage) ||
			isNaN(parsedRecords) ||
			!ObjectId.isValid(hotelId)
		) {
			return res.status(400).send("Invalid parameters");
		}

		let parsedFilters = {};
		try {
			parsedFilters = JSON.parse(filters);
		} catch (_) {
			parsedFilters = {};
		}
		const actor = await resolveReservationListActor(req);
		if (!(await canViewReservationHotel(actor, hotelId))) {
			return res.status(403).json({ error: "You do not have access to this hotel" });
		}

		const dynamicFilter = buildReservationListFilter({
			selectedFilter: parsedFilters.selectedFilter,
			hotelId,
			dateStr: date,
		});
		applyOwnReservationFilter(dynamicFilter, parsedFilters, actor);
		const searchMatch = buildReservationSearchMatch(parsedFilters.searchQuery);

		const pipeline = [{ $match: dynamicFilter }];

		if (searchMatch) {
			pipeline.push(
				{
					$lookup: {
						from: "rooms",
						localField: "roomId",
						foreignField: "_id",
						as: "roomDetails",
					},
				},
				{ $match: searchMatch }
			);
		}

		pipeline.push(
			{ $sort: { booked_at: -1 } },
			{ $skip: (parsedPage - 1) * parsedRecords },
			{ $limit: parsedRecords }
		);

		if (!searchMatch) {
			pipeline.push({
				$lookup: {
					from: "rooms",
					localField: "roomId",
					foreignField: "_id",
					as: "roomDetails",
				},
			});
		}

		const reservations = await Reservations.aggregate(pipeline);
		res.json(reservations);
	} catch (error) {
		console.error(error);
		res.status(500).send("Server error: " + error.message);
	}
};

exports.totalRecordsReservations = async (req, res) => {
	try {
		const { filters, hotelId, date } = req.params;

		if (!ObjectId.isValid(hotelId)) {
			return res.status(400).send("Invalid parameters");
		}

		let parsedFilters = {};
		try {
			parsedFilters = JSON.parse(filters);
		} catch (_) {
			parsedFilters = {};
		}
		const actor = await resolveReservationListActor(req);
		if (!(await canViewReservationHotel(actor, hotelId))) {
			return res.status(403).json({ error: "You do not have access to this hotel" });
		}
		const dynamicFilter = buildReservationListFilter({
			selectedFilter: parsedFilters.selectedFilter,
			hotelId,
			dateStr: date,
		});
		applyOwnReservationFilter(dynamicFilter, parsedFilters, actor);
		const searchMatch = buildReservationSearchMatch(parsedFilters.searchQuery);

		if (!searchMatch) {
			const total = await Reservations.countDocuments(dynamicFilter);
			return res.json({ total });
		}

		const pipeline = [
			{ $match: dynamicFilter },
			{
				$lookup: {
					from: "rooms",
					localField: "roomId",
					foreignField: "_id",
					as: "roomDetails",
				},
			},
			{ $match: searchMatch },
			{ $count: "total" },
		];

		const result = await Reservations.aggregate(pipeline);
		const total = result?.[0]?.total || 0;
		return res.json({ total });
	} catch (error) {
		console.error("Error fetching total records:", error);
		res.status(500).send("Server error");
	}
};

exports.totalCheckoutRecords = async (req, res) => {
	try {
		const { accountId, channel, startDate, endDate } = req.params;

		if (!ObjectId.isValid(accountId) || !startDate || !endDate) {
			return res.status(400).send("Invalid parameters");
		}

		const formattedStartDate = new Date(`${startDate}T00:00:00+00:00`);
		const formattedEndDate = new Date(`${endDate}T23:59:59+00:00`);

		let dynamicFilter = {
			hotelId: ObjectId(accountId),
			reservation_status: {
				$regex: "checked_out", // Use a regular expression to match the status text
				$options: "i", // Case-insensitive matching
			},
			$or: [
				{ checkout_date: { $gte: formattedStartDate, $lte: formattedEndDate } },
				{
					$and: [
						{ checkout_date: { $gte: formattedStartDate } },
						{ checkout_date: { $lte: formattedEndDate } },
					],
				},
			],
		};

		if (channel && channel !== "undefined") {
			const channelFilter = {
				booking_source: { $regex: new RegExp(channel, "i") },
			};
			const channelExists = await Reservations.findOne(channelFilter);
			if (channelExists) {
				dynamicFilter.booking_source = { $regex: new RegExp(channel, "i") };
			}
		}

		const total = await Reservations.countDocuments(dynamicFilter);

		const aggregation = await Reservations.aggregate([
			{ $match: dynamicFilter },
			{
				$group: {
					_id: null,
					total_amount: { $sum: "$total_amount" },
					commission: {
						$sum: {
							$cond: [
								{ $eq: ["$payment", "expedia collect"] },
								0,
								{
									$cond: [
										{
											$in: [
												"$booking_source",
												["jannat", "affiliate", "janat"],
											],
										},
										{ $multiply: ["$total_amount", 0.1] },
										{ $subtract: ["$total_amount", "$sub_total"] },
									],
								},
							],
						},
					},
				},
			},
		]);

		const result = {
			total: total,
			total_amount: aggregation.length > 0 ? aggregation[0].total_amount : 0,
			commission: aggregation.length > 0 ? aggregation[0].commission : 0,
		};

		res.json(result);
	} catch (error) {
		console.error("Error fetching total checkout records:", error);
		res.status(500).send("Server error");
	}
};

exports.checkedoutReport = async (req, res) => {
	try {
		const { accountId, channel, startDate, endDate, page, records } =
			req.params;
		const parsedPage = parseInt(page);
		const parsedRecords = parseInt(records);

		if (
			isNaN(parsedPage) ||
			isNaN(parsedRecords) ||
			!ObjectId.isValid(accountId) ||
			!startDate ||
			!endDate
		) {
			return res.status(400).send("Invalid parameters");
		}

		const formattedStartDate = new Date(`${startDate}T00:00:00+00:00`);
		const formattedEndDate = new Date(`${endDate}T23:59:59+00:00`);

		let dynamicFilter = {
			hotelId: ObjectId(accountId),
			reservation_status: {
				$regex: "checked_out", // Use a regular expression to match the status text
				$options: "i", // Case-insensitive matching
			},
			$or: [
				{ checkout_date: { $gte: formattedStartDate, $lte: formattedEndDate } },
				{
					$and: [
						{ checkout_date: { $gte: formattedStartDate } },
						{ checkout_date: { $lte: formattedEndDate } },
					],
				},
			],
		};

		if (channel && channel !== "undefined") {
			const channelFilter = {
				booking_source: { $regex: new RegExp(channel, "i") },
			};
			const channelExists = await Reservations.findOne(channelFilter);
			if (channelExists) {
				dynamicFilter.booking_source = { $regex: new RegExp(channel, "i") };
			}
		}

		const pipeline = [
			{ $match: dynamicFilter },
			{ $sort: { checkout_date: -1 } },
			{ $skip: (parsedPage - 1) * parsedRecords },
			{ $limit: parsedRecords },
			{
				$lookup: {
					from: "rooms",
					localField: "roomId",
					foreignField: "_id",
					as: "roomDetails",
				},
			},
		];

		const reservations = await Reservations.aggregate(pipeline);
		res.json(reservations);
	} catch (error) {
		console.error(error);
		res.status(500).send("Server error: " + error.message);
	}
};

exports.totalGeneralReservationsRecords = async (req, res) => {
	try {
		const {
			accountId,
			channel,
			startDate,
			endDate,
			dateBy,
			noshow,
			cancel,
			inhouse,
			checkedout,
			payment,
		} = req.params;

		if (
			!ObjectId.isValid(accountId) ||
			!startDate ||
			!endDate ||
			!["checkin", "checkout", "bookat"].includes(dateBy)
		) {
			return res.status(400).send("Invalid parameters");
		}

		const formattedStartDate = new Date(`${startDate}T00:00:00+00:00`);
		const formattedEndDate = new Date(`${endDate}T23:59:59+00:00`);

		let dateField =
			dateBy === "checkin"
				? "checkin_date"
				: dateBy === "checkout"
				? "checkout_date"
				: "booked_at";

		let dynamicFilter = {
			hotelId: ObjectId(accountId),
			[dateField]: { $gte: formattedStartDate, $lte: formattedEndDate },
		};

		if (channel && channel !== "undefined") {
			dynamicFilter.booking_source = { $regex: new RegExp(channel, "i") };
		}

		if (noshow === "1") {
			dynamicFilter.reservation_status = { $ne: "no_show" };
		} else if (noshow === "2") {
			dynamicFilter.reservation_status = "no_show";
		}

		if (cancel === "1") {
			dynamicFilter.reservation_status = {
				$nin: ["cancelled", "canceled", "no_show", "No_show"],
			};
		} else if (cancel === "2") {
			dynamicFilter.reservation_status = {
				$in: ["cancelled", "canceled", "no_show", "No_show"],
			};
		}

		if (inhouse === "1") {
			dynamicFilter.reservation_status = "inhouse";
		}

		if (checkedout === "1") {
			dynamicFilter.reservation_status = "checked_out";
		}

		if (payment === "true") {
			dynamicFilter.payment = "collected";
		}

		const total = await Reservations.countDocuments(dynamicFilter);

		const aggregation = await Reservations.aggregate([
			{ $match: dynamicFilter },
			{
				$group: {
					_id: null,
					total_amount: { $sum: "$total_amount" },
					commission: {
						$sum: {
							$cond: [
								{ $eq: ["$payment", "expedia collect"] },
								0,
								{
									$cond: [
										{
											$in: [
												"$booking_source",
												["janat", "affiliate", "jannat"],
											],
										},
										{ $multiply: ["$total_amount", 0.1] },
										{ $subtract: ["$total_amount", "$sub_total"] },
									],
								},
							],
						},
					},
				},
			},
		]);

		const result = {
			total: total,
			total_amount: aggregation.length > 0 ? aggregation[0].total_amount : 0,
			commission: aggregation.length > 0 ? aggregation[0].commission : 0,
		};

		res.json(result);
	} catch (error) {
		console.error("Error fetching total general reservations records:", error);
		res.status(500).send("Server error");
	}
};

exports.generalReservationsReport = async (req, res) => {
	try {
		const {
			accountId,
			channel,
			startDate,
			endDate,
			page,
			records,
			dateBy,
			noshow,
			cancel,
			inhouse,
			checkedout,
			payment,
		} = req.params;
		const parsedPage = parseInt(page);
		const parsedRecords = parseInt(records);

		if (
			isNaN(parsedPage) ||
			isNaN(parsedRecords) ||
			!ObjectId.isValid(accountId) ||
			!startDate ||
			!endDate ||
			!["checkin", "checkout", "bookat"].includes(dateBy)
		) {
			return res.status(400).send("Invalid parameters");
		}

		const formattedStartDate = new Date(`${startDate}T00:00:00+00:00`);
		const formattedEndDate = new Date(`${endDate}T23:59:59+00:00`);

		let dateField =
			dateBy === "checkin"
				? "checkin_date"
				: dateBy === "checkout"
				? "checkout_date"
				: "booked_at";

		let dynamicFilter = {
			hotelId: ObjectId(accountId),
			[dateField]: { $gte: formattedStartDate, $lte: formattedEndDate },
		};

		if (channel && channel !== "undefined") {
			dynamicFilter.booking_source = { $regex: new RegExp(channel, "i") };
		}

		if (noshow === "1") {
			dynamicFilter.reservation_status = { $ne: "no_show" };
		} else if (noshow === "2") {
			dynamicFilter.reservation_status = "no_show";
		}

		if (cancel === "1") {
			dynamicFilter.reservation_status = {
				$nin: ["cancelled", "canceled", "no_show", "No_show"],
			};
		} else if (cancel === "2") {
			dynamicFilter.reservation_status = {
				$in: ["cancelled", "canceled", "no_show", "No_show"],
			};
		}

		if (inhouse === "1") {
			dynamicFilter.reservation_status = "inhouse";
		}

		if (checkedout === "1") {
			dynamicFilter.reservation_status = "checked_out";
		}

		if (payment === "true") {
			dynamicFilter.payment = "collected";
		}

		const pipeline = [
			{ $match: dynamicFilter },
			{ $sort: { [dateField]: -1 } },
			{ $skip: (parsedPage - 1) * parsedRecords },
			{ $limit: parsedRecords },
			{
				$lookup: {
					from: "rooms",
					localField: "roomId",
					foreignField: "_id",
					as: "roomDetails",
				},
			},
			{
				$addFields: {
					roomCount: {
						$reduce: {
							input: "$pickedRoomsType",
							initialValue: 0,
							in: { $add: ["$$value", "$$this.count"] },
						},
					},
				},
			},
		];

		const reservations = await Reservations.aggregate(pipeline);
		res.json(reservations);
	} catch (error) {
		console.error(error);
		res.status(500).send("Server error: " + error.message);
	}
};

exports.reservationObjectSummary = async (req, res) => {
	try {
		const { accountId, date } = req.params;
		const { createdByUserId = "" } = req.query || {};
		const formattedDate = new Date(`${date}T00:00:00+03:00`); // Use Saudi Arabia time zone
		const matchStage = { hotelId: mongoose.Types.ObjectId(accountId) };

		if (createdByUserId && ObjectId.isValid(createdByUserId)) {
			const actorId = String(createdByUserId);
			matchStage.$or = [
				{ createdByUserId: ObjectId(actorId) },
				{ "createdBy._id": actorId },
				{ orderTakeId: ObjectId(actorId) },
				{ "orderTaker._id": actorId },
			];
		}

		const aggregation = await Reservations.aggregate([
			{
				$match: matchStage,
			},
			{
				$addFields: {
					// Convert dates to start of day for comparison
					bookedAtStartOfDay: {
						$dateTrunc: {
							date: "$booked_at",
							unit: "day",
							timezone: "+03:00",
						},
					},
					checkinStartOfDay: {
						$dateTrunc: {
							date: "$checkin_date",
							unit: "day",
							timezone: "+03:00",
						},
					},
					checkoutStartOfDay: {
						$dateTrunc: {
							date: "$checkout_date",
							unit: "day",
							timezone: "+03:00",
						},
					},
					// Flag to indicate non-cancelled reservations
					nonCancelled: {
						$cond: {
							if: {
								$regexMatch: {
									input: "$reservation_status",
									regex: CANCELLED_REGEX,
								},
							},
							then: false,
							else: true,
						},
					},
				},
			},
			{
				$group: {
					_id: null,
					newReservations: {
						$sum: {
							$cond: [
								{
									$and: [
										{ $eq: ["$bookedAtStartOfDay", formattedDate] },
										{ $eq: ["$nonCancelled", true] },
									],
								},
								1,
								0,
							],
						},
					},
					cancellations: {
						$sum: {
							$cond: [
								{
									$regexMatch: {
										input: "$reservation_status",
										regex: CANCELLED_REGEX,
									},
								},
								1,
								0,
							],
						},
					},
					todayArrival: {
						$sum: {
							$cond: [
								{
									$and: [
										{ $eq: ["$checkinStartOfDay", formattedDate] },
										{ $eq: ["$nonCancelled", true] },
									],
								},
								1,
								0,
							],
						},
					},
					departureToday: {
						$sum: {
							$cond: [
								{
									$and: [
										{ $eq: ["$checkoutStartOfDay", formattedDate] },
										{ $eq: ["$nonCancelled", true] },
									],
								},
								1,
								0,
							],
						},
					},
					inHouse: {
						$sum: {
							$cond: [
								{
									$regexMatch: {
										input: "$reservation_status",
										regex: IN_HOUSE_REGEX,
									},
								},
								1,
								0,
							],
						},
					},
					inComplete: {
						$sum: {
							$cond: [
								{
									$and: [
										{
											$not: {
												$regexMatch: {
													input: "$reservation_status",
													regex: INCOMPLETE_EXCLUDED_REGEX,
												},
											},
										},
									],
								},
								1,
								0,
							],
						},
					},
					allReservations: { $sum: 1 }, // Count all reservations/documents
				},
			},
		]);

		// Since aggregation always returns an array, we take the first element
		const summary =
			aggregation.length > 0
				? aggregation[0]
				: {
						newReservations: 0,
						cancellations: 0,
						todayArrival: 0,
						departureToday: 0,
						inHouse: 0,
						inComplete: 0,
						allReservations: 0,
				  };

		res.json(summary);
	} catch (error) {
		console.error("Error fetching reservation summary:", error);
		res.status(500).send("Server error");
	}
};

exports.removeDuplicates_ConfirmationNumber = async (req, res) => {
	try {
		const groupedReservations = await Reservations.aggregate([
			{
				$sort: { createdAt: -1 },
			},
			{
				$group: {
					_id: "$confirmation_number",
					docId: { $first: "$_id" },
				},
			},
		]);

		const idsToKeep = groupedReservations.map((group) => group.docId);

		await Reservations.deleteMany({ _id: { $nin: idsToKeep } });

		res.json({ message: "Duplicates removed successfully" });
	} catch (error) {
		console.error("Error in removeDuplicates_ConfirmationNumber:", error);
		res.status(500).send("Internal Server Error");
	}
};

const normalizeDisplayName = (value) => {
	if (value === null || value === undefined) return "";
	return String(value).trim();
};

exports.syncReservationRoomTypesByDisplayName = async (req, res) => {
	try {
		const { hotelId, dryRun } = req.query;
		const isDryRun = String(dryRun).toLowerCase() === "true";
		const hotelFilter = {};
		const reservationFilter = {};

		if (hotelId) {
			if (!ObjectId.isValid(hotelId)) {
				return res.status(400).json({ error: "Invalid hotelId" });
			}
			const parsedHotelId = new ObjectId(hotelId);
			hotelFilter._id = parsedHotelId;
			reservationFilter.hotelId = parsedHotelId;
		}

		const hotels = await HotelDetails.find(hotelFilter)
			.select("_id roomCountDetails.roomType roomCountDetails.displayName")
			.lean();

		if (!hotels.length) {
			return res.status(404).json({ error: "No hotels found to process" });
		}

		const roomTypeMapByHotel = new Map();
		const duplicateDisplayNames = {};

		hotels.forEach((hotel) => {
			const displayNameMap = new Map();
			const duplicates = new Set();
			(hotel.roomCountDetails || []).forEach((room) => {
				const displayName = normalizeDisplayName(room?.displayName);
				const roomType = room?.roomType;
				if (!displayName || !roomType) return;
				if (displayNameMap.has(displayName)) {
					if (displayNameMap.get(displayName) !== roomType) {
						duplicates.add(displayName);
					}
					return;
				}
				displayNameMap.set(displayName, roomType);
			});

			if (duplicates.size > 0) {
				duplicateDisplayNames[String(hotel._id)] = Array.from(duplicates);
			}

			roomTypeMapByHotel.set(String(hotel._id), displayNameMap);
		});

		const reservations = await Reservations.find(reservationFilter)
			.select("_id hotelId pickedRoomsType")
			.lean();

		let reservationsScanned = 0;
		let reservationsUpdated = 0;
		let roomsUpdated = 0;
		const bulkOps = [];

		reservations.forEach((reservation) => {
			reservationsScanned += 1;
			const hotelKey = String(reservation.hotelId || "");
			const displayNameMap = roomTypeMapByHotel.get(hotelKey);
			if (!displayNameMap || !Array.isArray(reservation.pickedRoomsType)) {
				return;
			}

			let changed = false;
			const updatedRooms = reservation.pickedRoomsType.map((room) => {
				const displayName = normalizeDisplayName(
					room?.displayName || room?.display_name
				);
				if (!displayName) return room;

				const expectedRoomType = displayNameMap.get(displayName);
				if (!expectedRoomType || expectedRoomType === room?.room_type) {
					return room;
				}

				roomsUpdated += 1;
				changed = true;
				return { ...room, room_type: expectedRoomType };
			});

			if (!changed) return;

			reservationsUpdated += 1;
			if (isDryRun) return;

			bulkOps.push({
				updateOne: {
					filter: { _id: reservation._id },
					update: { $set: { pickedRoomsType: updatedRooms } },
				},
			});
		});

		if (!isDryRun && bulkOps.length) {
			await Reservations.bulkWrite(bulkOps);
		}

		return res.json({
			success: true,
			dryRun: isDryRun,
			hotelsProcessed: hotels.length,
			reservationsScanned,
			reservationsUpdated,
			roomsUpdated,
			duplicateDisplayNames,
		});
	} catch (error) {
		console.error("Error syncing reservation room types:", error);
		return res.status(500).json({ error: "Internal Server Error" });
	}
};

exports.singleReservation = (req, res) => {
	const token = process.env.HOTEL_RUNNER_TOKEN;
	const hrId = process.env.HR_ID;
	const reservationNumber = req.params.reservationNumber;
	const hotelId = req.params.hotelId; // Assuming you are passing hotelId as a parameter
	const belongsTo = req.params.belongsTo; // Assuming you are passing belongsTo as a parameter

	const queryParams = new URLSearchParams({
		token: token,
		hr_id: hrId,
		reservation_number: reservationNumber,
		// ... other query params
	}).toString();

	const url = `https://app.hotelrunner.com/api/v2/apps/reservations?${queryParams}`;

	fetch(url)
		.then((apiResponse) => {
			if (!apiResponse.ok) {
				throw new Error(`HTTP error! status: ${apiResponse.status}`);
			}
			return apiResponse.json();
		})
		.then((data) => {
			if (!data.reservations || data.reservations.length === 0) {
				throw new Error("No reservations found");
			}
			const reservation = data.reservations[0]; // Assuming we are interested in the first reservation

			const mappedReservation = mapHotelRunnerResponseToSchema(reservation);
			mappedReservation.belongsTo = belongsTo;
			mappedReservation.hotelId = hotelId;

			// Create a new PreReservation document
			return new PreReservation(mappedReservation).save();
		})
		.then((newReservation) => {
			res.json(newReservation); // Send back the newly created PreReservation document
		})
		.catch((error) => {
			console.error("API request error:", error);
			res
				.status(500)
				.json({ error: "Error fetching and processing reservation" });
		});
};

const maskCardNumber = (cardNumber) => {
	if (!cardNumber || cardNumber.length < 4) return "Invalid Card Number";

	const lastFour = cardNumber.slice(-4);
	const maskedSection = "*".repeat(cardNumber.length - 4);
	return `${maskedSection}${lastFour}`;
};

/**
 * Retrieves a single reservation by ID, decrypts sensitive customer details,
 * masks the card number, and excludes other sensitive information from the response.
 */
exports.singleReservationById = async (req, res) => {
	try {
		// Extract reservationId from request parameters
		const { reservationId } = req.params;

		// Find the reservation by its ID and populate related fields
		const reservation = await Reservations.findById(reservationId)
			.populate({
				path: "hotelId",
				model: "HotelDetails", // Ensure this matches the name of your HotelDetails model
			})
			.populate("belongsTo") // Optionally populate other referenced fields
			.exec();

		// If reservation not found, return a 404 error
		if (!reservation) {
			return res.status(404).json({
				message: `Reservation not found with id ${reservationId}`,
			});
		}

		// Decrypt sensitive customer details
		const decryptedCardNumber = decryptWithSecret(
			reservation.customer_details.cardNumber
		);
		const decryptedCardExpiryDate = decryptWithSecret(
			reservation.customer_details.cardExpiryDate
		);

		// Mask the card number to show only the last four digits
		const maskedCardNumber = maskCardNumber(decryptedCardNumber);

		// Construct the decrypted and masked customer details
		const decryptedCustomerDetails = {
			...reservation.customer_details, // Spread existing customer details
			cardNumber: maskedCardNumber, // Masked card number
			cardExpiryDate: decryptedCardExpiryDate, // Fully decrypted expiry date
			// Exclude cardCVV and cardHolderName by not including them
		};

		// Remove sensitive fields if they exist
		// This ensures that even if they were accidentally included, they're removed
		delete decryptedCustomerDetails.cardCVV;
		delete decryptedCustomerDetails.cardHolderName;

		// Construct the final reservation object to send in the response
		const responseReservation = {
			...reservation.toObject(), // Convert Mongoose document to plain object
			customer_details: decryptedCustomerDetails, // Replace with decrypted and masked details
		};

		res.status(200).json(responseReservation);
	} catch (error) {
		// Log the error for debugging purposes
		console.error("Error fetching reservation:", error.message || error);

		// Handle specific errors related to invalid ObjectId
		if (error.kind === "ObjectId") {
			return res.status(404).json({
				message: `Reservation not found with id ${req.params.reservationId}`,
			});
		}

		// Handle generic server errors
		res.status(500).json({
			message:
				"An internal server error occurred while fetching the reservation.",
		});
	}
};

exports.openFinanceCycleNotifications = async (req, res) => {
	try {
		const { hotelId } = req.params;
		if (!mongoose.Types.ObjectId.isValid(hotelId)) {
			return res.status(400).json({ error: "Invalid hotel id" });
		}

		const today = moment().tz("Asia/Riyadh").startOf("day").toDate();
		const openRows = await Reservations.find(
			{
				hotelId,
				checkin_date: { $gte: today },
				reservation_status: {
					$not: new RegExp(
						`${CANCELLED_REGEX.source}|${NO_SHOW_REGEX.source}`,
						"i"
					),
				},
			},
			{
				confirmation_number: 1,
				customer_details: 1,
				checkin_date: 1,
				checkout_date: 1,
				total_amount: 1,
				paid_amount_breakdown: 1,
				payment: 1,
				commission: 1,
				commissionPaid: 1,
				moneyTransferredToHotel: 1,
				pickedRoomsType: 1,
				financial_cycle: 1,
				reservation_status: 1,
			}
		)
			.sort({ checkin_date: 1 })
			.limit(100)
			.lean();

		const reservations = openRows
			.map((reservation) => {
				const financialCycle = buildFinancialCycleSnapshot(reservation, {}, "");
				return { ...reservation, financial_cycle: financialCycle };
			})
			.filter((reservation) => reservation.financial_cycle?.status !== "closed");

		return res.json({ count: reservations.length, reservations });
	} catch (error) {
		console.error("openFinanceCycleNotifications:", error);
		return res
			.status(500)
			.json({ error: "Error retrieving open finance notifications" });
	}
};

exports.reservationsList = (req, res) => {
	const hotelId = mongoose.Types.ObjectId(req.params.hotelId);
	const userId = mongoose.Types.ObjectId(req.params.belongsTo);

	// Start date at the beginning of the day in UTC
	const startDate = new Date(req.params.startdate);
	startDate.setUTCHours(0, 0, 0, 0);

	// End date at the end of the day in UTC
	const endDate = new Date(req.params.enddate);
	endDate.setUTCHours(23, 59, 59, 999);

	console.log(startDate, "startDate");
	console.log(endDate, "endDate");

	let queryConditions = {
		hotelId: hotelId,
		belongsTo: userId,
		$or: [
			{ checkin_date: { $gte: startDate, $lte: endDate } },
			{ checkout_date: { $gte: startDate, $lte: endDate } },
			{
				$and: [
					{ checkin_date: { $lte: startDate } },
					{ checkout_date: { $gte: endDate } },
				],
			},
		],
		roomId: { $exists: true, $ne: [], $not: { $elemMatch: { $eq: null } } },
		reservation_status: { $not: /checked[- _]?out/i }, // Filter checked out variants
	};

	Reservations.find(queryConditions)
		.populate("belongsTo")
		.populate("roomId")
		.exec((err, data) => {
			if (err) {
				console.log(err, "err");
				return res.status(400).json({
					error: err,
				});
			}
			res.json(data);
		});
};

exports.reservationsOccupancyRange = async (req, res) => {
	try {
		const { startdate, enddate, hotelId, belongsTo } = req.params;
		if (
			!ObjectId.isValid(hotelId) ||
			!ObjectId.isValid(belongsTo) ||
			!startdate ||
			!enddate
		) {
			return res.status(400).json({ error: "Invalid parameters" });
		}

		const startDate = new Date(startdate);
		const endDate = new Date(enddate);
		if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
			return res.status(400).json({ error: "Invalid date range" });
		}
		startDate.setUTCHours(0, 0, 0, 0);
		endDate.setUTCHours(23, 59, 59, 999);

		const todayEnd = moment.tz("Asia/Riyadh").endOf("day").toDate();
		const overdueInhouseFilter = {
			reservation_status: IN_HOUSE_REGEX,
			checkin_date: { $lte: todayEnd },
			checkout_date: { $lte: todayEnd },
		};

		const queryConditions = {
			hotelId: ObjectId(hotelId),
			belongsTo: ObjectId(belongsTo),
			$or: [
				{ checkin_date: { $gte: startDate, $lte: endDate } },
				{ checkout_date: { $gte: startDate, $lte: endDate } },
				{
					$and: [
						{ checkin_date: { $lte: startDate } },
						{ checkout_date: { $gte: endDate } },
					],
				},
				overdueInhouseFilter,
			],
			roomId: { $exists: true, $ne: [], $not: { $elemMatch: { $eq: null } } },
			reservation_status: { $not: CHECKED_OUT_REGEX },
		};

		const reservations = await Reservations.find(queryConditions)
			.populate("belongsTo")
			.populate("roomId");

		return res.json(reservations);
	} catch (error) {
		console.error("Error fetching occupancy range:", error);
		return res.status(500).json({ error: "Internal server error" });
	}
};

exports.reservationsOccupancyCurrent = async (req, res) => {
	try {
		const { hotelId, belongsTo } = req.params;
		if (!ObjectId.isValid(hotelId) || !ObjectId.isValid(belongsTo)) {
			return res.status(400).json({ error: "Invalid parameters" });
		}

		const startOfDay = moment.tz("Asia/Riyadh").startOf("day").toDate();
		const endOfDay = moment.tz("Asia/Riyadh").endOf("day").toDate();

		const overdueInhouseFilter = {
			reservation_status: IN_HOUSE_REGEX,
			checkin_date: { $lte: endOfDay },
			checkout_date: { $lte: endOfDay },
		};

		const queryConditions = {
			hotelId: ObjectId(hotelId),
			belongsTo: ObjectId(belongsTo),
			roomId: { $exists: true, $ne: [], $not: { $elemMatch: { $eq: null } } },
			reservation_status: { $not: CHECKED_OUT_REGEX },
			$or: [
				{
					checkin_date: { $lte: endOfDay },
					checkout_date: { $gte: startOfDay },
				},
				overdueInhouseFilter,
			],
		};

		const reservations = await Reservations.find(queryConditions)
			.populate("belongsTo")
			.populate("roomId");

		return res.json(reservations);
	} catch (error) {
		console.error("Error fetching current occupancy:", error);
		return res.status(500).json({ error: "Internal server error" });
	}
};

exports.reservationsOccupancySummary = async (req, res) => {
	try {
		const { hotelId, belongsTo } = req.params;
		if (!ObjectId.isValid(hotelId) || !ObjectId.isValid(belongsTo)) {
			return res.status(400).json({ error: "Invalid parameters" });
		}

		const startOfDay = moment.tz("Asia/Riyadh").startOf("day").toDate();
		const endOfDay = moment.tz("Asia/Riyadh").endOf("day").toDate();

		const overdueInhouseFilter = {
			reservation_status: IN_HOUSE_REGEX,
			checkin_date: { $lte: endOfDay },
			checkout_date: { $lte: endOfDay },
		};

		const queryConditions = {
			hotelId: ObjectId(hotelId),
			belongsTo: ObjectId(belongsTo),
			roomId: { $exists: true, $ne: [], $not: { $elemMatch: { $eq: null } } },
			reservation_status: { $not: CHECKED_OUT_REGEX },
			$or: [
				{
					checkin_date: { $lte: endOfDay },
					checkout_date: { $gte: startOfDay },
				},
				overdueInhouseFilter,
			],
		};

		const [rooms, reservations, cleaningTasks] = await Promise.all([
			Rooms.find({ hotelId: ObjectId(hotelId) })
				.select(
					"_id room_number room_type display_name floor bedsNumber cleanRoom active activeRoom housekeepingLastCleanedAt housekeepingLastDirtyAt housekeepingDirtyReason"
				)
				.lean(),
			Reservations.find(queryConditions)
				.select("roomId bedNumber reservation_status")
				.lean(),
			HouseKeeping.find({
				hotelId: ObjectId(hotelId),
				task_status: { $not: /finished|done|completed/i },
			})
				.select("rooms roomStatus task_status")
				.lean(),
		]);

		const roomIdSet = new Set(
			(Array.isArray(rooms) ? rooms : []).map((room) => String(room._id))
		);

		const normalizeRoomIds = (roomIdField) => {
			const rawIds = Array.isArray(roomIdField) ? roomIdField : [roomIdField];
			return rawIds
				.map((room) => {
					if (!room) return null;
					if (typeof room === "string" || typeof room === "number") {
						return String(room);
					}
					if (typeof room === "object") {
						return (
							room._id ||
							room.id ||
							room.roomId ||
							room.room_id ||
							room.room_number ||
							null
						);
					}
					return null;
				})
				.filter(Boolean)
				.map((id) => String(id));
		};

		const isReservationActive = (reservation) => {
			const status = String(reservation?.reservation_status || "");
			if (!status) return true;
			return !CHECKED_OUT_REGEX.test(status);
		};

		const activeReservations = (Array.isArray(reservations) ? reservations : [])
			.filter(isReservationActive)
			.map((reservation) => ({
				roomIds: normalizeRoomIds(reservation.roomId),
				bedNumbers: Array.isArray(reservation.bedNumber)
					? reservation.bedNumber
					: [],
			}));

		const bookedBedsByRoom = new Map();
		const wildcardBeds = [];

		activeReservations.forEach((reservation) => {
			if (!Array.isArray(reservation.bedNumbers)) return;
			if (reservation.bedNumbers.length === 0) return;

			if (!reservation.roomIds || reservation.roomIds.length === 0) {
				wildcardBeds.push(...reservation.bedNumbers);
				return;
			}

			reservation.roomIds.forEach((roomId) => {
				if (!roomIdSet.has(roomId)) return;
				if (!bookedBedsByRoom.has(roomId)) {
					bookedBedsByRoom.set(roomId, []);
				}
				bookedBedsByRoom.get(roomId).push(...reservation.bedNumbers);
			});
		});

		const occupiedRoomIds = new Set();
		activeReservations.forEach((reservation) => {
			if (!reservation.roomIds || reservation.roomIds.length === 0) return;
			reservation.roomIds.forEach((roomId) => {
				if (!roomIdSet.has(roomId)) return;
				occupiedRoomIds.add(roomId);
			});
		});

		const cleaningRoomIds = new Set();
		(Array.isArray(cleaningTasks) ? cleaningTasks : []).forEach((task) => {
			if (Array.isArray(task.roomStatus) && task.roomStatus.length > 0) {
				task.roomStatus.forEach((entry) => {
					const roomId = entry?.room ? String(entry.room) : "";
					if (
						roomIdSet.has(roomId) &&
						!HOUSEKEEPING_FINISHED_REGEX.test(String(entry?.status || ""))
					) {
						cleaningRoomIds.add(roomId);
					}
				});
				return;
			}
			if (!Array.isArray(task.rooms)) return;
			task.rooms.forEach((roomId) => {
				if (!roomId) return;
				const normalized = String(roomId);
				if (roomIdSet.has(normalized)) {
					cleaningRoomIds.add(normalized);
				}
			});
		});

		let occupied = 0;
		let vacant = 0;
		let clean = 0;
		let dirty = 0;
		let outOfService = 0;
		const roomsByStatus = {
			occupied: [],
			vacant: [],
			clean: [],
			dirty: [],
			cleaning: [],
			outOfService: [],
		};

		const formatRoomForStatus = (room, flags = {}) => ({
			_id: String(room?._id || ""),
			room_number: room?.room_number || "",
			room_type: room?.room_type || "",
			display_name: room?.display_name || "",
			floor: room?.floor ?? "",
			cleanRoom: !!room?.cleanRoom,
			active: room?.active !== false,
			activeRoom: room?.activeRoom !== false,
			housekeepingLastCleanedAt: room?.housekeepingLastCleanedAt || null,
			housekeepingLastDirtyAt: room?.housekeepingLastDirtyAt || null,
			housekeepingDirtyReason: room?.housekeepingDirtyReason || "",
			...flags,
		});

		(Array.isArray(rooms) ? rooms : []).forEach((room) => {
			const roomId = String(room._id);
			const isBedRoom = room?.room_type === "individualBed";
			let isBooked = false;

			if (isBedRoom) {
				const beds = Array.isArray(room?.bedsNumber) ? room.bedsNumber : [];
				if (beds.length > 0) {
					const bookedBeds = new Set([
						...(bookedBedsByRoom.get(roomId) || []),
						...wildcardBeds,
					]);
					isBooked = beds.every((bed) => bookedBeds.has(bed));
				}
			} else {
				isBooked = occupiedRoomIds.has(roomId);
			}

			const isCleaning = cleaningRoomIds.has(roomId);
			const isOutOfService = room?.active === false || room?.activeRoom === false;
			const roomStatusDetails = formatRoomForStatus(room, {
				isBooked,
				isCleaning,
				isOutOfService,
			});

			if (isBooked) occupied += 1;
			else vacant += 1;

			if (isBooked) roomsByStatus.occupied.push(roomStatusDetails);
			else roomsByStatus.vacant.push(roomStatusDetails);

			if (room?.cleanRoom) clean += 1;
			else dirty += 1;

			if (room?.cleanRoom) roomsByStatus.clean.push(roomStatusDetails);
			else roomsByStatus.dirty.push(roomStatusDetails);

			if (isCleaning) roomsByStatus.cleaning.push(roomStatusDetails);

			if (isOutOfService) outOfService += 1;
			if (isOutOfService) roomsByStatus.outOfService.push(roomStatusDetails);
		});

		return res.json({
			ok: true,
			hotelId,
			summary: {
				occupied,
				vacant,
				clean,
				dirty,
				cleaning: cleaningRoomIds.size,
				outOfService,
				totalRooms: Array.isArray(rooms) ? rooms.length : 0,
			},
			roomsByStatus,
			asOf: {
				timezone: "Asia/Riyadh",
				startOfDay,
				endOfDay,
			},
		});
	} catch (error) {
		console.error("Error fetching occupancy summary:", error);
		return res.status(500).json({ error: "Internal server error" });
	}
};

exports.todaysCheckins = async (req, res) => {
	try {
		const { hotelId, belongsTo } = req.params;

		if (!ObjectId.isValid(hotelId) || !ObjectId.isValid(belongsTo)) {
			return res.status(400).json({ error: "Invalid parameters" });
		}

		const startOfDay = moment.tz("Asia/Riyadh").startOf("day").toDate();
		const endOfDay = moment.tz("Asia/Riyadh").endOf("day").toDate();

		const reservations = await Reservations.find({
			hotelId: ObjectId(hotelId),
			belongsTo: ObjectId(belongsTo),
			checkin_date: { $gte: startOfDay, $lte: endOfDay },
			reservation_status: {
				$nin: [
					"cancelled_by_guest",
					"canceled",
					"Cancelled",
					"cancelled",
					"checked_out",
					"no_show",
				],
			},
		}).sort({ checkin_date: 1 });

		return res.json(reservations);
	} catch (error) {
		console.error("Error fetching today's check-ins:", error);
		return res.status(500).json({ error: "Internal Server Error" });
	}
};

exports.reservationsList2 = (req, res) => {
	const userId = mongoose.Types.ObjectId(req.params.accountId);
	const today = new Date();
	const thirtyDaysAgo = new Date(today);
	thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

	Reservations.find({
		hotelId: userId,
		checkin_date: {
			$gte: thirtyDaysAgo, // Greater than or equal to 30 days ago
		},
	})
		.populate("belongsTo")
		.populate(
			"roomId",
			"room_number room_type room_features room_pricing floor roomColorCode"
		) // Populate room details
		.sort({ createdAt: -1 })
		.exec((err, data) => {
			if (err) {
				console.log(err, "err");
				return res.status(400).json({
					error: err,
				});
			}
			res.json(data);
		});
};

const sendEmailUpdate = async (reservationData, hotelName) => {
	// Dynamically generating HTML content for the email body and PDF
	const htmlContent = reservationUpdate(reservationData, hotelName);
	const hotelForPdf =
		reservationData?.hotelId && typeof reservationData.hotelId === "object"
			? reservationData.hotelId
			: {
					hotelName: hotelName || reservationData?.hotelName || "",
					suppliedBy: reservationData?.belongsTo?.name || "",
			  };
	const pdfHtml = receiptPdfTemplate(reservationData, hotelForPdf);
	const pdfBuffer = await createPdfBuffer(pdfHtml);

	const FormSubmittionEmail = {
		to: reservationData.customer_details.email
			? reservationData.customer_details.email
			: "ahmedabdelrazak20@gmail.com",
		from: "noreply@jannatbooking.com",
		// from: "noreply@jannatbooking.com",
		// cc: [
		// 	{ email: "ayed.hotels@gmail.com" },
		// 	{ email: "zaerhotel@gmail.com" },
		// 	{ email: "3yedhotel@gmail.com" },
		// 	{ email: "morazzakhamouda@gmail.com" },
		// ],
		bcc: [
			{ email: "morazzakhamouda@gmail.com" },
			{ email: "xhoteleg@gmail.com" },
			{ email: "ahmed.abdelrazak@jannatbooking.com" },
			{ email: "support@jannatbooking.com" },
		],
		subject: `Jannat Booking - Reservation Update`,
		html: htmlContent,
		attachments: [
			{
				content: pdfBuffer.toString("base64"),
				filename: "Reservation_Update.pdf",
				type: "application/pdf",
				disposition: "attachment",
			},
		],
	};

	try {
		await sgMail.send(FormSubmittionEmail);
	} catch (error) {
		console.error("Error sending email with PDF", error);
		// Handle error appropriately
	}
};

exports.updateReservation = async (req, res) => {
	try {
		const reservationId = req.params.reservationId;
		const updateData = req.body || {};
		let normalizedUpdateData = { ...updateData };
		const previewAuditFromPayload =
			normalizedUpdateData.__previewAudit === true &&
			normalizedUpdateData.__previewAuditActorId &&
			mongoose.Types.ObjectId.isValid(normalizedUpdateData.__previewAuditActorId)
				? {
						preview: true,
						previewActorId: normalizedUpdateData.__previewAuditActorId,
						_id: normalizedUpdateData.requestingUserId,
				  }
				: null;
		delete normalizedUpdateData.__previewAudit;
		delete normalizedUpdateData.__previewAuditActorId;
		const authenticatedActorId = req.auth?._id || "";
		const requestingUserId = req.auth?.preview
			? authenticatedActorId
			: authenticatedActorId ||
			  normalizedUpdateData.requestingUserId ||
			  normalizedUpdateData.updatedBy ||
			  normalizedUpdateData.userId;
		delete normalizedUpdateData.requestingUserId;
		delete normalizedUpdateData.updatedBy;
		delete normalizedUpdateData.userId;
		stripServerManagedReservationUpdateFields(normalizedUpdateData);
		const normalizeRoomIds = (value) => {
			if (!Array.isArray(value)) return [];
			return value
				.map((room) => {
					if (!room) return null;
					if (typeof room === "string") return room;
					if (typeof room === "object" && room._id) return room._id;
					return room;
				})
				.filter((id) => id && mongoose.Types.ObjectId.isValid(id))
				.map((id) => String(id));
		};

		console.log(
			`[UPDATE RESERVATION] Received update for ID: ${reservationId}`
		);
		console.log("Update Data:", updateData);

		// 1️⃣ Validate reservationId
		if (!mongoose.Types.ObjectId.isValid(reservationId)) {
			return res.status(400).json({ error: "Invalid reservation ID" });
		}

		// 2️⃣ Validate total_amount if provided
		if (
			normalizedUpdateData.total_amount &&
			typeof normalizedUpdateData.total_amount !== "number"
		) {
			return res.status(400).json({ error: "Invalid total amount format" });
		}

		// 3️⃣ Validate belongsTo (convert empty string to undefined)
		if (
			!normalizedUpdateData.belongsTo ||
			!mongoose.Types.ObjectId.isValid(normalizedUpdateData.belongsTo)
		) {
			delete normalizedUpdateData.belongsTo;
		}

		if (Array.isArray(normalizedUpdateData.roomId)) {
			const normalizedRoomIds = normalizeRoomIds(normalizedUpdateData.roomId);
			if (
				normalizedRoomIds.length > 0 ||
				normalizedUpdateData.roomId.length === 0
			) {
				normalizedUpdateData.roomId = normalizedRoomIds;
			} else {
				delete normalizedUpdateData.roomId;
			}
		}

		// 4️⃣ Fetch existing reservation for comparison
		const existingReservation = await Reservations.findById(reservationId);
		if (!existingReservation) {
			return res.status(404).json({ error: "Reservation not found" });
		}
		const auditActor = await resolveReservationAuditActor(
			requestingUserId,
			updateData,
			{ previewAuth: req.auth || previewAuditFromPayload }
		);
		const requestingActor =
			requestingUserId && mongoose.Types.ObjectId.isValid(requestingUserId)
				? await User.findById(requestingUserId)
						.select(
							"_id role roleDescription roles roleDescriptions accessTo"
						)
						.lean()
						.exec()
				: null;
		const orderTakerBasicEditOnly = isOrderTakingAccount(requestingActor || {});
		if (orderTakerBasicEditOnly) {
			const reservationOwnerIds = [
				existingReservation.createdByUserId,
				existingReservation.orderTakeId,
				existingReservation.createdBy?._id,
				existingReservation.orderTaker?._id,
			]
				.map(normalizeId)
				.filter(Boolean);
			if (
				requestingUserId &&
				reservationOwnerIds.length > 0 &&
				!reservationOwnerIds.includes(normalizeId(requestingUserId))
			) {
				return res.status(403).json({
					error: "Agents can only update reservations created by their own account.",
					errorArabic:
						"يمكن للوكلاء تحديث الحجوزات التي تم إنشاؤها من حسابهم فقط.",
					code: "agent_reservation_owner_mismatch",
				});
			}
		}
		if (
			orderTakerBasicEditOnly &&
			!isOrderTakerEditableReservation(existingReservation)
		) {
			return res.status(403).json({
				error:
					"This reservation is already confirmed or closed. Only hotel staff can update it now.",
				errorArabic:
					"تم تأكيد هذا الحجز أو إغلاقه بالفعل. يمكن لموظفي الفندق فقط تحديثه الآن.",
				code: "agent_confirmed_reservation_locked",
			});
		}
		if (orderTakerBasicEditOnly) {
			normalizedUpdateData = sanitizeOrderTakerUpdate(normalizedUpdateData);
		}
		if (requestingActor && isFinanceOnlyAccount(requestingActor)) {
			const forbiddenFinanceFields =
				getForbiddenFinanceReservationUpdateFields(normalizedUpdateData);
			if (forbiddenFinanceFields.length) {
				return res.status(403).json({
					error:
						"Finance users can update commission and payment cycle fields only.",
					forbiddenFields: forbiddenFinanceFields,
				});
			}
		}

		const restrictedCashUserId = "6969d80da28c78c6280171df";
		const normalizePaymentBreakdown = (breakdown = {}) => {
			const existingBreakdown =
				existingReservation?.paid_amount_breakdown &&
				typeof existingReservation.paid_amount_breakdown.toObject === "function"
					? existingReservation.paid_amount_breakdown.toObject()
					: existingReservation?.paid_amount_breakdown || {};
			const normalized = { ...existingBreakdown, ...breakdown };
			if (
				normalized.paid_to_zad !== undefined &&
				normalized.paid_to_hotel === undefined
			) {
				normalized.paid_to_hotel = normalized.paid_to_zad;
			}
			delete normalized.paid_to_zad;

			PAYMENT_BREAKDOWN_NUMERIC_KEYS.forEach((key) => {
				normalized[key] = n2(normalized[key]);
			});
			normalized.payment_comments =
				typeof normalized.payment_comments === "string"
					? normalized.payment_comments
					: "";
			return normalized;
		};
		const computeBreakdownTotal = (breakdown) =>
			n2(sumBreakdownKeys(breakdown, PAYMENT_BREAKDOWN_NUMERIC_KEYS));

		if (
			normalizedUpdateData.paid_amount_breakdown &&
			typeof normalizedUpdateData.paid_amount_breakdown === "object"
		) {
			normalizedUpdateData.paid_amount_breakdown = normalizePaymentBreakdown(
				normalizedUpdateData.paid_amount_breakdown
			);
			// Payment breakdown is the source of truth. Whenever it is edited,
			// paid_amount is overwritten by the exact server-computed breakdown total.
			normalizedUpdateData.paid_amount = computeBreakdownTotal(
				normalizedUpdateData.paid_amount_breakdown
			);
		}

		if (String(requestingUserId || "") === restrictedCashUserId) {
			const existingCashValue = moneyNumber(
				existingReservation?.paid_amount_breakdown?.paid_at_hotel_cash || 0
			);
			if (
				existingCashValue > 0 &&
				normalizedUpdateData.paid_amount_breakdown &&
				typeof normalizedUpdateData.paid_amount_breakdown === "object"
			) {
				normalizedUpdateData.paid_amount_breakdown.paid_at_hotel_cash =
					existingCashValue;
				if (normalizedUpdateData.paid_amount !== undefined) {
					normalizedUpdateData.paid_amount = computeBreakdownTotal(
						normalizedUpdateData.paid_amount_breakdown
					);
				}
			}
		}

		// 5️⃣ Intelligent '_relocate' Increment if hotelId has changed
		if (
			normalizedUpdateData.hotelId &&
			existingReservation.hotelId.toString() !==
				normalizedUpdateData.hotelId.toString()
		) {
			const relocatePattern = /_relocate(\d*)$/;
			const match =
				existingReservation.confirmation_number.match(relocatePattern);

			if (match) {
				const count = match[1] ? parseInt(match[1], 10) + 1 : 2;
				normalizedUpdateData.confirmation_number =
					existingReservation.confirmation_number.replace(
						relocatePattern,
						`_relocate${count}`
					);
			} else {
				normalizedUpdateData.confirmation_number = `${existingReservation.confirmation_number}_relocate`;
			}

			console.log(
				`[RELOCATION] Confirmation number updated to: ${normalizedUpdateData.confirmation_number}`
			);
		} else {
			normalizedUpdateData.confirmation_number =
				existingReservation.confirmation_number;
		}

		// 6️⃣ Prepare nested fields for update using dot notation
		const customerDetails =
			normalizedUpdateData.customer_details ||
			normalizedUpdateData.customerDetails ||
			null;

		if (normalizedUpdateData.customer_details) {
			delete normalizedUpdateData.customer_details;
		}
		if (normalizedUpdateData.customerDetails) {
			delete normalizedUpdateData.customerDetails;
		}

		normalizedUpdateData = await normalizeReservationStayPricing(
			existingReservation,
			normalizedUpdateData
		);

		if (orderTakerBasicEditOnly) {
			const existingPlain =
				typeof existingReservation.toObject === "function"
					? existingReservation.toObject()
					: existingReservation;
			const mergedReservationForCalendar = {
				...existingPlain,
				...normalizedUpdateData,
			};
			if (customerDetails) {
				mergedReservationForCalendar.customer_details = {
					...(existingPlain.customer_details || {}),
					...customerDetails,
				};
			}

			const calendarValidation = await validateOrderTakerBlockedCalendar(
				mergedReservationForCalendar
			);
			if (!calendarValidation.allowed) {
				return res.status(409).json({
					error: calendarValidation.message,
					errorArabic: calendarValidation.messageArabic,
					agentCalendarBlocked: true,
					blockedCalendar: calendarValidation,
				});
			}

			const agentInventorySensitiveChanged = [
				"checkin_date",
				"checkout_date",
				"pickedRoomsType",
				"pickedRoomsPricing",
				"total_rooms",
			].some(
				(field) =>
					Object.prototype.hasOwnProperty.call(normalizedUpdateData, field) &&
					auditStringify(normalizedUpdateData[field]) !==
						auditStringify(existingPlain[field])
			);
			if (agentInventorySensitiveChanged) {
				const inventoryValidation = await validateReservationInventoryForCreate(
					mergedReservationForCalendar,
					{ allowOverbook: false, excludeReservationId: reservationId }
				);
				if (!inventoryValidation.allowed) {
					return res.status(409).json({
						error: inventoryValidation.message,
						errorArabic:
							"\u0644\u0627 \u062a\u0648\u062c\u062f \u063a\u0631\u0641 \u0643\u0627\u0641\u064a\u0629 \u0644\u0647\u0630\u0627 \u0627\u0644\u0646\u0648\u0639 \u0641\u064a \u0627\u0644\u062a\u0648\u0627\u0631\u064a\u062e \u0627\u0644\u0645\u062d\u062f\u062f\u0629. \u0644\u0627 \u064a\u0645\u0643\u0646 \u0644\u0644\u0648\u0643\u064a\u0644 \u062a\u062c\u0627\u0648\u0632 \u0627\u0644\u0645\u062e\u0632\u0648\u0646.",
						agentInventoryBlocked: true,
						inventory: inventoryValidation,
					});
				}
			}
		}

		const updateFieldChanged = (field) => {
			if (!Object.prototype.hasOwnProperty.call(normalizedUpdateData, field)) {
				return false;
			}
			const beforeValue = existingReservation.get
				? existingReservation.get(field)
				: existingReservation[field];
			return auditStringify(beforeValue) !== auditStringify(normalizedUpdateData[field]);
		};

		const touchesFinancialCycle = [
			"commission",
			"commissionPaid",
			"moneyTransferredToHotel",
			"paid_amount_breakdown",
			"paid_amount",
			"total_amount",
			"financial_cycle",
		].some(updateFieldChanged);

		if (touchesFinancialCycle) {
			normalizedUpdateData.financial_cycle = buildFinancialCycleSnapshot(
				existingReservation,
				normalizedUpdateData,
				requestingUserId
			);
		}
		delete normalizedUpdateData.__commissionAssignmentReset;

		const updatePayload = {
			...normalizedUpdateData,
		};

		if (customerDetails) {
			const existingCustomerDetails =
				typeof existingReservation.customer_details?.toObject === "function"
					? existingReservation.customer_details.toObject()
					: existingReservation.customer_details || {};

			updatePayload.customer_details = {
				...existingCustomerDetails,
				...customerDetails,
			};
		}

		// 7️⃣ Update reservation
		const syncedAgentWalletSnapshot = syncExistingAgentWalletSnapshotForUpdates(
			existingReservation,
			updatePayload
		);
		if (syncedAgentWalletSnapshot) {
			updatePayload.agentWalletSnapshot = syncedAgentWalletSnapshot;
		}

		const auditEntries = buildReservationAuditEntries(
			existingReservation,
			updatePayload,
			auditActor
		);
		const updateOperation = { $set: updatePayload };

		if (auditEntries.length) {
			updateOperation.$set.adminLastUpdatedAt = new Date();
			updateOperation.$set.adminLastUpdatedBy = auditActor;
			updateOperation.$push = {
				adminChangeLog: { $each: auditEntries },
				reservationAuditLog: { $each: auditEntries },
			};
		}

		const updatedReservation = await Reservations.findByIdAndUpdate(
			reservationId,
			updateOperation,
			{ new: true }
		);

		if (!updatedReservation) {
			return res.status(404).json({ error: "Failed to update reservation." });
		}

		// 8️⃣ Handle "InHouse" status updates
		if (
			normalizedUpdateData.reservation_status &&
			["inhouse", "InHouse"].includes(
				normalizedUpdateData.reservation_status.toLowerCase()
			) &&
			Array.isArray(normalizedUpdateData.roomId) &&
			normalizedUpdateData.roomId.length > 0
		) {
			try {
				await Rooms.updateMany(
					{ _id: { $in: normalizedUpdateData.roomId } },
					{
						$set: {
							cleanRoom: false,
							housekeepingLastCleanedAt: null,
							housekeepingLastDirtyAt: new Date(),
							housekeepingDirtyReason: "guest_in_house",
						},
					}
				);
				console.log("[ROOM STATUS] Rooms marked as not clean.");
			} catch (err) {
				console.error("[ERROR] Failed to update room clean status:", err);
				return res
					.status(500)
					.json({ error: "Failed to update room clean status" });
			}
		}

		// 9️⃣ Handle "Checked Out" status updates
		if (
			updatedReservation.reservation_status &&
			/checked[- _]?out/.test(
				String(updatedReservation.reservation_status || "").toLowerCase()
			)
		) {
			const checkedOutRoomIds = normalizeRoomIds(
				Array.isArray(updatedReservation.roomId)
					? updatedReservation.roomId
					: []
			);
			if (checkedOutRoomIds.length > 0) {
				try {
					await Rooms.updateMany(
						{ _id: { $in: checkedOutRoomIds } },
						{
							$set: {
								cleanRoom: false,
								housekeepingLastCleanedAt: null,
								housekeepingLastDirtyAt: new Date(),
								housekeepingDirtyReason: "guest_checked_out",
							},
						}
					);
					console.log(
						"[ROOM STATUS] Rooms marked as not clean after checkout."
					);
				} catch (err) {
					console.error(
						"[ERROR] Failed to update room clean status after checkout:",
						err
					);
					return res
						.status(500)
						.json({ error: "Failed to update room clean status" });
				}
			}

			const existingTask = await HouseKeeping.findOne({
				confirmation_number: updatedReservation.confirmation_number,
			});

			if (!existingTask) {
				try {
					const newHouseKeepingTask = new HouseKeeping({
						taskDate: new Date(),
						confirmation_number: updatedReservation.confirmation_number,
						rooms: updatedReservation.roomId,
						hotelId: updatedReservation.hotelId,
						task_comment: "Guest Checked Out",
					});
					await newHouseKeepingTask.save();
					console.log("[HOUSEKEEPING] New task created for checked-out rooms.");
				} catch (err) {
					console.error("[ERROR] Failed to create housekeeping task:", err);
					return res
						.status(500)
						.json({ error: "Failed to create housekeeping task" });
				}
			}
		}

		// 🔟 Send update email if requested
		if (req.body.sendEmail) {
			try {
				await sendEmailUpdate(
					updatedReservation,
					updateData.hotel_name || updateData.hotelName
				);
				console.log("[EMAIL] Update email sent successfully.");
			} catch (error) {
				console.error("[ERROR] Failed to send update email:", error);
				return res.status(500).json({
					message: "Reservation updated, but failed to send email",
					error: error.toString(),
				});
			}
		}

		// ✅ Successful update response
		const shouldRefreshPendingNotifications =
			touchesFinancialCycle ||
			[
				"reservation_status",
				"state",
				"pendingConfirmation",
				"commissionData",
				"commissionStatus",
				"commissionPaid",
			].some((key) => Object.prototype.hasOwnProperty.call(updatePayload, key));

		if (shouldRefreshPendingNotifications) {
			emitHotelNotificationRefresh(req, updatedReservation.hotelId, {
				type: getReservationNotificationType(updatedReservation),
				reservationId: updatedReservation._id,
				ownerId: updatedReservation.belongsTo,
			}).catch((error) =>
				console.error("Error emitting reservation notification:", error)
			);
		}

		return res.json({
			message: "Reservation updated successfully",
			reservation: updatedReservation,
		});
	} catch (err) {
		if (err instanceof ReservationPricingError || err?.statusCode) {
			console.warn("[RESERVATION PRICING] Update rejected:", {
				reservationId: req.params.reservationId,
				code: err.code || "reservation_pricing_error",
				message: err.message,
				details: err.details || {},
			});
			return res.status(err.statusCode || 400).json({
				error: err.message,
				errorArabic: getReservationPricingErrorArabic(err),
				code: err.code || "reservation_pricing_error",
				details: err.details || {},
			});
		}
		console.error("[ERROR] General error updating reservation:", err);
		return res.status(500).json({ error: "Internal server error" });
	}
};

exports.deleteDataSource = async (req, res) => {
	try {
		// Extract the source from the request parameters
		const source = req.params.source;

		// Use the deleteMany function to remove all documents matching the source
		const deletionResult = await Reservations.deleteMany({
			booking_source: source,
		});

		// deletionResult.deletedCount will contain the number of documents removed
		res.status(200).json({
			message: `${deletionResult.deletedCount} documents were deleted successfully.`,
		});
	} catch (error) {
		// If an error occurs, log it and return a server error response
		console.error("Error in deleteDataSource:", error);
		res.status(500).json({ error: "Internal Server Error" });
	}
};
//{hotelId: ObjectId('65b640a1f33023933c22eba3')}
exports.deleteByHotelId = async (req, res) => {
	try {
		// Extract the source from the request parameters
		const hotelId = mongoose.Types.ObjectId(req.params.hotelId);

		// Use the deleteMany function to remove all documents matching the source
		const deletionResult = await Reservations.deleteMany({
			hotelId: hotelId,
		});

		// deletionResult.deletedCount will contain the number of documents removed
		res.status(200).json({
			message: `${deletionResult.deletedCount} documents were deleted successfully.`,
		});
	} catch (error) {
		// If an error occurs, log it and return a server error response
		console.error("Error in deleteByHotelId:", error);
		res.status(500).json({ error: "Internal Server Error" });
	}
};

exports.summaryBySource = async () => {
	try {
		const summary = await Reservations.aggregate([
			{
				$group: {
					_id: "$booking_source", // Group by booking_source
					total_amount: { $sum: "$total_amount" }, // Sum of total_amount for each group
					sub_total: { $sum: "$sub_total" }, // Sum of total_amount for each group
					reservation_count: { $sum: 1 }, // Count of reservations for each group
				},
			},
			{
				$project: {
					_id: 0, // Exclude _id from results
					booking_source: "$_id", // Rename _id to booking_source
					total_amount: 1, // Include total_amount
					sub_amount: 1, // Include sub_amount
					reservation_count: 1, // Include reservation_count
				},
			},
		]);

		return summary;
	} catch (error) {
		console.error("Error in summaryBySource:", error);
		throw error;
	}
};

// Helper function to calculate days of residence
const calculateDaysOfResidence = (checkIn, checkOut) => {
	const checkInDate = new Date(new Date(checkIn).setHours(0, 0, 0, 0));
	const checkOutDate = new Date(new Date(checkOut).setHours(0, 0, 0, 0));

	if (isNaN(checkInDate.getTime()) || isNaN(checkOutDate.getTime())) {
		return 0; // Return 0 if dates are invalid
	}

	const diffInTime = checkOutDate.getTime() - checkInDate.getTime();
	const diffInDays = diffInTime / (1000 * 3600 * 24);
	return diffInDays; // Return the difference in days
};

exports.agodaDataDump = async (req, res) => {
	try {
		const accountId = req.params.accountId;
		const userId = req.params.belongsTo;

		const filePath = req.file.path; // The path to the uploaded file
		const workbook = xlsx.readFile(filePath);
		const sheetName = workbook.SheetNames[0];
		const sheet = workbook.Sheets[sheetName];
		const data = xlsx.utils.sheet_to_json(sheet); // Convert the sheet data to JSON

		for (const item of data) {
			const itemNumber = item["BookingIDExternal_reference_ID"]
				?.toString()
				.trim();
			if (!itemNumber) continue; // Skip if there's no book number

			// Calculate totalAmount by checking if ReferenceSellInclusive is provided and not zero
			let totalAmount;
			if (Number(item.ReferenceSellInclusive) > 0) {
				totalAmount = Number(item.ReferenceSellInclusive);
			} else {
				// If ReferenceSellInclusive is 0, undefined, or not a number, add Total_inclusive_rate and Commission
				totalAmount =
					Number(item.Total_inclusive_rate || 0) + Number(item.Commission || 0);
			}

			const daysOfResidence = calculateDaysOfResidence(
				item.StayDateFrom,
				item.StayDateTo
			);

			// Assuming each record is for one room, adjust accordingly if you have more details
			const pickedRoomsType = [
				{
					room_type: item.RoomType,
					chosenPrice: (daysOfResidence > 0
						? totalAmount / daysOfResidence
						: 0
					).toFixed(2),
					count: 1,
				},
			];

			// Parse the date using moment, and convert it to the Saudi Arabia timezone
			const bookedAtSaudi = moment.tz(item.BookedDate, "Asia/Riyadh").toDate();
			const checkInDateSaudi = moment
				.tz(item.StayDateFrom, "Asia/Riyadh")
				.toDate();
			const checkOutDateSaudi = moment
				.tz(item.StayDateTo, "Asia/Riyadh")
				.toDate();

			// Prepare the document based on your mapping, including any necessary calculations
			const document = {
				confirmation_number: item.BookingIDExternal_reference_ID,
				booking_source: "agoda",
				customer_details: {
					name: item.Customer_Name, // Concatenated first name and last name if available
					nationality: item.Customer_Nationality,
					phone: item.Customer_Phone || "",
					email: item.Customer_Email || "",
				},
				state: item.Status ? item.Status : "confirmed",
				reservation_status: item.Status.toLowerCase().includes("cancelled")
					? "cancelled"
					: item.Status.toLowerCase().includes("show")
					? "no_show"
					: item.Status,
				total_guests: item.No_of_adult + (item.No_of_children || 0),
				cancel_reason: item.CancellationPolicyDescription || "",
				booked_at: bookedAtSaudi,
				sub_total: item.Total_inclusive_rate,
				total_rooms: 1,
				total_amount: totalAmount.toFixed(2),
				currency: item.Currency,
				checkin_date: checkInDateSaudi,
				checkout_date: checkOutDateSaudi,
				days_of_residence: daysOfResidence,
				comment: item.Special_Request || "",
				commision: Number(
					Number(totalAmount) - Number(item.Total_inclusive_rate)
				).toFixed(2), // Note the misspelling of 'commission' here
				payment: item.PaymentModel.toLowerCase(),
				pickedRoomsType,
				hotelId: accountId,
				belongsTo: userId,
				paid_amount:
					item.PaymentModel.toLowerCase() === "agoda collect"
						? totalAmount.toFixed(2)
						: 0,
			};

			const existingReservation = await Reservations.findOne({
				confirmation_number: itemNumber,
				booking_source: "agoda",
			});

			if (existingReservation) {
				const payment_details = existingReservation.payment_details;
				const payment = existingReservation.payment;
				const paid_amount = existingReservation.paid_amount;

				const {
					customer_details,
					state,
					hotelId,
					belongsTo,
					...documentWithoutCustomerDetails
				} = document;
				await Reservations.updateOne(
					{ confirmation_number: itemNumber },
					{
						$set: {
							...documentWithoutCustomerDetails,
							reservation_status:
								document.reservation_status === "cancelled"
									? "cancelled"
									: document.reservation_status === "no_show"
									? "no_show"
									: existingReservation.reservation_status,
							// Include payment_details in the update to retain it
							payment_details: payment_details,
							payment: payment,
							paid_amount: paid_amount,
						},
					}
				);
			} else {
				try {
					await Reservations.create(document);
				} catch (error) {
					if (error.code === 11000) {
						// Check for duplicate key error
						// console.log(
						// 	`Skipping duplicate document for confirmation_number: ${itemNumber}`
						// );
						continue; // Skip to the next item
					} else {
						throw error; // Rethrow if it's not a duplicate key error
					}
				}
			}
		}

		res.status(200).json({
			message: "Data has been updated and uploaded successfully.",
		});
	} catch (error) {
		console.error("Error in agodaDataDump:", error);
		res.status(500).json({ error: "Internal Server Error" });
	}
};

const parseDate = (dateInput, country) => {
	if (typeof dateInput === "number") {
		// If dateInput is an Excel serial date number, parse it accordingly
		// Excel's base date is December 30, 1899
		const excelEpoch = new Date(1899, 11, 30);
		const parsedDate = new Date(excelEpoch.getTime() + dateInput * 86400000);
		const offset = parsedDate.getTimezoneOffset();
		return new Date(parsedDate.getTime() - offset * 60000);
	} else if (typeof dateInput === "string" && dateInput.includes("T")) {
		// If dateInput is an ISO 8601 string with time, convert directly to Saudi time zone
		return moment.tz(dateInput, "Asia/Riyadh").toDate();
	} else if (typeof dateInput === "string") {
		// If dateInput is a date string without time, determine format and create date
		const parts = dateInput.split(/[-/]/);
		const date =
			country === "US"
				? new Date(parts[2], parts[0] - 1, parts[1])
				: new Date(parts[2], parts[1] - 1, parts[0]);
		// Convert the date to Saudi time zone
		return moment.tz(date, "Asia/Riyadh").toDate();
	}
	// Return null if input is unrecognized
	return null;
};

exports.expediaDataDump = async (req, res) => {
	try {
		const accountId = req.params.accountId;
		const userId = req.params.belongsTo;
		const country = req.params.country;
		const filePath = req.file.path; // The path to the uploaded file
		const workbook = xlsx.readFile(filePath);
		const sheetName = workbook.SheetNames[0];
		const sheet = workbook.Sheets[sheetName];
		const data = xlsx.utils.sheet_to_json(sheet); // Convert the sheet data to JSON

		const calculateDaysOfResidence = (checkIn, checkOut) => {
			const checkInDate = new Date(checkIn);
			const checkOutDate = new Date(checkOut);

			// Validate if both dates are valid
			if (isNaN(checkInDate.getTime()) || isNaN(checkOutDate.getTime())) {
				return 0; // Return a default value (e.g., 0) if dates are invalid
			}

			return (checkOutDate - checkInDate) / (1000 * 3600 * 24); // Calculating difference in days
		};

		for (const item of data) {
			const itemNumber = item["Confirmation #"]?.toString().trim()
				? item["Confirmation #"]?.toString().trim()
				: item["Reservation ID"]?.toString().trim();
			if (!itemNumber) continue; // Skip if there's no book number

			const daysOfResidence = calculateDaysOfResidence(
				parseDate(item["Check-in"], country),
				parseDate(item["Check-out"], country)
			);

			const pickedRoomsType = [
				{
					room_type: item["Room"],
					chosenPrice:
						(Number(item["Booking amount"]) / daysOfResidence).toFixed(2) || 0,
					count: 1,
				},
			];

			const bookedAt = parseDate(item["Booked"], country);
			const checkInDate = parseDate(item["Check-in"], country);
			const checkOutDate = parseDate(item["Check-out"], country);

			// console.log(item, "item");

			// Check for valid dates before proceeding
			if (!bookedAt || !checkInDate || !checkOutDate) {
				console.error(`Invalid date found in record: ${JSON.stringify(item)}`);
				continue; // Skip this item if dates are invalid
			}

			// Prepare the document based on your mapping, including any necessary calculations
			const document = {
				confirmation_number: item["Confirmation #"] || item["Reservation ID"],
				booking_source: "expedia",
				customer_details: {
					name: item.Guest || "", // Assuming 'Guest' contains the full name
				},
				state: item.Status ? item.Status : "confirmed",
				reservation_status: item.Status.toLowerCase().includes("cancelled")
					? "cancelled"
					: item.Status.toLowerCase().includes("show")
					? "no_show"
					: item.Status,
				total_guests: item.total_guests || 1, // Total number of guests
				total_rooms: item["rooms"], // The number of items in the group
				booked_at: bookedAt,
				checkin_date: checkInDate,
				checkout_date: checkOutDate,
				sub_total: item["Booking amount"],
				total_amount: item["Booking amount"],
				currency: "SAR", // Adjust as needed
				days_of_residence: daysOfResidence,
				comment: item["Special Request"] || "",
				booking_comment: item["Special Request"] || "", // Replace with the actual column name if different
				payment: item["Payment type"].toLowerCase(),
				pickedRoomsType,
				commision: item.Commission, // Ensure this field exists in your schema
				hotelId: accountId,
				belongsTo: userId,
				paid_amount:
					item["Payment type"].toLowerCase() === "expedia collect"
						? item["Booking amount"]
						: 0,
			};

			const existingReservation = await Reservations.findOne(
				{
					confirmation_number: itemNumber,
					booking_source: "expedia",
				},
				{ upsert: true, new: true }
			);

			if (existingReservation) {
				const payment_details = existingReservation.payment_details;
				const payment = existingReservation.payment;
				const paid_amount = existingReservation.paid_amount;

				const {
					customer_details,
					state,
					hotelId,
					belongsTo,
					...documentWithoutCustomerDetails
				} = document;
				await Reservations.updateOne(
					{ confirmation_number: itemNumber },
					{
						$set: {
							...documentWithoutCustomerDetails,
							reservation_status:
								document.reservation_status === "cancelled"
									? "cancelled"
									: document.reservation_status === "no_show"
									? "no_show"
									: existingReservation.reservation_status,
							// Include payment_details in the update to retain it
							payment_details: payment_details,
							payment: payment,
							paid_amount: paid_amount,
						},
					}
				);
			} else {
				try {
					await Reservations.create(document);
				} catch (error) {
					if (error.code === 11000) {
						// Check for duplicate key error
						// console.log(
						// 	`Skipping duplicate document for confirmation_number: ${itemNumber}`
						// );
						continue; // Skip to the next item
					} else {
						throw error; // Rethrow if it's not a duplicate key error
					}
				}
			}
		}
		res.status(200).json({
			message: "Data has been updated and uploaded successfully.",
		});
	} catch (error) {
		console.error("Error in expediaDataDump:", error);
		res.status(500).json({ error: "Internal Server Error" });
	}
};

exports.airbnb = async (req, res) => {
	try {
		const accountId = req.params.accountId;
		const userId = req.params.belongsTo;
		const country = req.params.country;
		const filePath = req.file.path; // The path to the uploaded file
		const workbook = xlsx.readFile(filePath);
		const sheetName = workbook.SheetNames[0];
		const sheet = workbook.Sheets[sheetName];
		const data = xlsx.utils.sheet_to_json(sheet); // Convert the sheet data to JSON

		const calculateDaysOfResidence = (checkIn, checkOut) => {
			const checkInDate = new Date(checkIn);
			const checkOutDate = new Date(checkOut);

			// Validate if both dates are valid
			if (isNaN(checkInDate.getTime()) || isNaN(checkOutDate.getTime())) {
				return 0; // Return a default value (e.g., 0) if dates are invalid
			}

			return (checkOutDate - checkInDate) / (1000 * 3600 * 24); // Calculating difference in days
		};

		const parseEarnings = (earningsString) => {
			// This regular expression matches optional currency symbols and extracts digits, commas, and decimal points
			const matches = earningsString.match(/[\d,]+\.?\d*/);
			if (matches) {
				// Remove commas before parsing as a float
				const numberWithoutCommas = matches[0].replace(/,/g, "");
				return parseFloat(numberWithoutCommas);
			} else {
				return 0; // Return 0 if no matching numeric part is found
			}
		};

		for (const item of data) {
			const itemNumber = item["Confirmation code"]?.toString().trim();
			if (!itemNumber) continue; // Skip if there's no book number

			let roomType = ""; // Determine roomType based on `item` details
			const peoplePerRoom =
				item["# of adults"] + item["# of children"] + item["# of infants"];
			// Example logic to determine roomType
			if (peoplePerRoom <= 1) {
				roomType = "Single Room";
			} else if (peoplePerRoom <= 2) {
				roomType = "Double Room";
			} else if (peoplePerRoom === 3) {
				roomType = "Triple Room";
			} else if (peoplePerRoom === 4) {
				roomType = "Quad Room";
			} else {
				roomType = "Family Room";
			} // Add more conditions as per your logic

			const pickedRoomsType = [
				{
					room_type: roomType,
					chosenPrice:
						Number(
							parseEarnings(item.Earnings) / Number(item["# of nights"])
						).toFixed(2) || 0,
					count: 1, // Assuming each record is for one room. Adjust accordingly if you have more details.
				},
			];

			// Use the parseDate function for date fields
			const bookedAt = parseDate(item["Booked"]);
			const checkInDate = parseDate(item["Start date"], country);
			const checkOutDate = parseDate(item["End date"], country);

			// console.log(item, "item");

			// Check for valid dates before proceeding
			if (!bookedAt || !checkInDate || !checkOutDate) {
				console.error(`Invalid date found in record: ${JSON.stringify(item)}`);
				continue; // Skip this item if dates are invalid
			}

			// Prepare the document based on your mapping, including any necessary calculations
			const document = {
				confirmation_number: item["Confirmation code"],
				booking_source: "airbnb",
				customer_details: {
					name: item["Guest name"] || "", // Assuming 'Guest' contains the full name
					phone: item["Contact"] || "", // Assuming 'Guest' contains the full name
				},
				state: item.Status ? item.Status : "confirmed",
				reservation_status:
					item.Status.toLowerCase().includes("cancelled") ||
					item.Status.toLowerCase().includes("canceled")
						? "cancelled"
						: item.Status.toLowerCase().includes("show")
						? "no_show"
						: item.Status,
				total_guests:
					item["# of adults"] + item["# of children"] + item["# of infants"] ||
					1, // Total number of guests
				total_rooms: 1, // The number of items in the group
				booked_at: bookedAt,
				checkin_date: checkInDate,
				checkout_date: checkOutDate,
				sub_total: parseEarnings(item.Earnings),
				total_amount: parseEarnings(item.Earnings),
				currency: "SAR", // Adjust as needed
				days_of_residence: item["# of nights"] + 1,
				comment: item["Listing"] || "",
				booking_comment: item["Listing"] || "", // Replace with the actual column name if different
				payment: item["Payment type"],
				pickedRoomsType,
				commision: item.Commission ? item.Commission : 0, // Ensure this field exists in your schema
				hotelId: accountId,
				belongsTo: userId,
				paid_amount: parseEarnings(item.Earnings),
			};

			const existingReservation = await Reservations.findOne({
				confirmation_number: itemNumber,
				booking_source: "airbnb",
			});

			if (existingReservation) {
				const payment_details = existingReservation.payment_details;
				const payment = existingReservation.payment;
				const paid_amount = existingReservation.paid_amount;

				const {
					customer_details,
					state,
					hotelId,
					belongsTo,
					...documentWithoutCustomerDetails
				} = document;
				await Reservations.updateOne(
					{ confirmation_number: itemNumber },
					{
						$set: {
							...documentWithoutCustomerDetails,
							reservation_status:
								document.reservation_status === "cancelled"
									? "cancelled"
									: document.reservation_status === "no_show"
									? "no_show"
									: existingReservation.reservation_status,
							// Include payment_details in the update to retain it
							payment_details: payment_details,
							payment: payment,
							paid_amount: paid_amount,
						},
					}
				);
			} else {
				try {
					await Reservations.create(document);
				} catch (error) {
					if (error.code === 11000) {
						// Check for duplicate key error
						// console.log(
						// 	`Skipping duplicate document for confirmation_number: ${itemNumber}`
						// );
						continue; // Skip to the next item
					} else {
						throw error; // Rethrow if it's not a duplicate key error
					}
				}
			}
		}
		res.status(200).json({
			message: "Data has been updated and uploaded successfully.",
		});
	} catch (error) {
		console.error("Error in expediaDataDump:", error);
		res.status(500).json({ error: "Internal Server Error" });
	}
};

exports.bookingDataDump = async (req, res) => {
	try {
		const accountId = req.params.accountId;
		const userId = req.params.belongsTo;
		const filePath = req.file.path; // The path to the uploaded file
		const workbook = xlsx.readFile(filePath);
		const sheetName = workbook.SheetNames[0];
		const sheet = workbook.Sheets[sheetName];
		let data = xlsx.utils.sheet_to_json(sheet); // Convert the sheet data to JSON

		// Convert keys of each item in data to lowercase
		data = data.map((item) => {
			const newItem = {};
			for (const key in item) {
				if (item.hasOwnProperty(key) && key) {
					newItem[key.toLowerCase()] = item[key];
				}
			}
			return newItem;
		});

		const calculateDaysOfResidence = (checkIn, checkOut) => {
			const checkInDate = new Date(new Date(checkIn).setHours(0, 0, 0, 0));
			const checkOutDate = new Date(new Date(checkOut).setHours(0, 0, 0, 0));

			if (isNaN(checkInDate.getTime()) || isNaN(checkOutDate.getTime())) {
				return 0; // Return 0 if dates are invalid
			}

			const diffInTime = checkOutDate.getTime() - checkInDate.getTime();
			const diffInDays = diffInTime / (1000 * 3600 * 24);
			return diffInDays; // Return the difference in days
		};

		const parseDate = (dateString) => {
			const date = new Date(dateString);
			return isNaN(date.getTime()) ? null : date;
		};

		const parsePrice = (priceString) => {
			// Check if the priceString is not undefined and is a string
			if (typeof priceString === "string" || priceString instanceof String) {
				return parseFloat(priceString.replace(/[^\d.-]/g, ""));
			}
			return 0; // Return 0 or some default value if the priceString is not a valid string
		};

		const parseDateToSaudiTimezone = (dateString) => {
			// Parse the date using moment and convert it to the Asia/Riyadh timezone
			return moment.tz(dateString, "Asia/Riyadh").format();
		};

		for (const item of data) {
			const itemNumber = item["book number"]?.toString().trim();
			if (!itemNumber) continue; // Skip if there's no book number

			const daysOfResidence = calculateDaysOfResidence(
				item["check-in"],
				item["check-out"]
			);

			const price =
				accountId === "658c7c02f848bc6562f5c5cc"
					? (Number(parsePrice(item.price)) +
							Number(parsePrice(item.price)) * 0.1 +
							Number(parsePrice(item["commission amount"]))) /
					  Number(item["rooms"])
					: (Number(parsePrice(item.price)) +
							Number(parsePrice(item["commission amount"]))) /
					  Number(item["rooms"]);

			const chosenPrice =
				daysOfResidence > 0 ? Number(price / daysOfResidence).toFixed(2) : 0;

			const peoplePerRoom = item.persons
				? item.persons
				: item.people / item.rooms;
			// Assuming item['rooms'] gives the number of rooms or you have a way to determine roomType from `item`
			let roomType = ""; // Determine roomType based on `item` details
			// Example logic to determine roomType
			if (peoplePerRoom <= 1) {
				roomType = "Single Room";
			} else if (peoplePerRoom <= 2) {
				roomType = "Double Room";
			} else if (peoplePerRoom === 3) {
				roomType = "Triple Room";
			} else if (peoplePerRoom === 4) {
				roomType = "Quad Room";
			} else {
				roomType = "Family Room";
			} // Add more conditions as per your logic

			// Initialize the pickedRoomsType array
			const pickedRoomsType = [];

			// Populate the pickedRoomsType array based on the room count
			for (let i = 0; i < Number(item["rooms"]); i++) {
				pickedRoomsType.push({
					room_type: roomType,
					chosenPrice: chosenPrice,
					count: 1, // Each object represents 1 room
				});
			}

			// ... Inside your transform logic
			const totalAmount = Number(parsePrice(item.price || 0)).toFixed(2); // Provide a default string if Price is undefined

			const commission = parsePrice(item["commission amount"] || 0); // Provide a default string if Commission Amount is undefined

			// Use the parseDate function for date fields
			const bookedAt = parseDateToSaudiTimezone(item["booked on"]);
			const checkInDate = parseDate(item["check-in"]);
			const checkOutDate = parseDate(item["check-out"]);

			// Check for valid dates before proceeding
			if (!bookedAt || !checkInDate || !checkOutDate) {
				console.error(`Invalid date found in record: ${JSON.stringify(item)}`);
				continue; // Skip this item if dates are invalid
			}

			// Prepare the document based on your mapping, including any necessary calculations
			const document = {
				confirmation_number: item["book number"] || "",
				booking_source: "booking.com",
				customer_details: {
					name: item["guest name(s)"] || "", // Assuming 'Guest Name(s)' contains the full name
				},
				state: item.status ? item.status : "confirmed",
				reservation_status: item.status.toLowerCase().includes("cancelled")
					? "cancelled"
					: item.status.toLowerCase().includes("show") ||
					  item.status.toLowerCase().includes("no_show")
					? "no_show"
					: item.status,
				total_guests: item.people || 1, // Total number of guests
				total_rooms: item["rooms"], // The number of items in the group
				booked_at: bookedAt,
				checkin_date: checkInDate,
				checkout_date: checkOutDate,
				sub_total: totalAmount,
				total_amount:
					accountId === "658c7c02f848bc6562f5c5cc"
						? Number(totalAmount) +
						  Number(commission) +
						  Number(totalAmount) * 0.1
						: Number(totalAmount) + Number(commission),

				currency: "SAR", // Adjust as needed
				days_of_residence: daysOfResidence,
				comment: item.remarks || "",
				booking_comment: item.remarks || "",
				payment: item["payment status"] ? item["payment status"] : "Not Paid",
				pickedRoomsType,
				commission: commission, // Ensure this field exists in your schema
				hotelId: accountId,
				belongsTo: userId,
			};

			const existingReservation = await Reservations.findOne({
				confirmation_number: itemNumber,
				booking_source: "booking.com",
			});

			if (existingReservation) {
				const payment_details = existingReservation.payment_details;
				const payment = existingReservation.payment;
				const paid_amount = existingReservation.paid_amount;

				const {
					customer_details,
					state,
					hotelId,
					belongsTo,
					...documentWithoutCustomerDetails
				} = document;
				await Reservations.updateOne(
					{ confirmation_number: itemNumber },
					{
						$set: {
							...documentWithoutCustomerDetails,
							reservation_status:
								document.reservation_status === "cancelled"
									? "cancelled"
									: document.reservation_status === "no_show"
									? "no_show"
									: existingReservation.reservation_status,
							// Include payment_details in the update to retain it
							payment_details: payment_details,
							payment: payment,
							paid_amount: paid_amount,
						},
					}
				);
			} else {
				try {
					await Reservations.create(document);
				} catch (error) {
					if (error.code === 11000) {
						// Check for duplicate key error
						// console.log(
						// 	`Skipping duplicate document for confirmation_number: ${itemNumber}`
						// );
						continue; // Skip to the next item
					} else {
						throw error; // Rethrow if it's not a duplicate key error
					}
				}
			}
		}

		res.status(200).json({
			message: "Data has been updated and uploaded successfully.",
		});
	} catch (error) {
		console.error("Error in bookingDataDump:", error);
		res.status(500).json({ error: "Internal Server Error" });
	}
};

exports.janatDataDump = async (req, res) => {
	try {
		const accountId = req.params.accountId;
		const userId = req.params.belongsTo;
		const filePath = req.file.path; // The path to the uploaded file
		const workbook = xlsx.readFile(filePath);
		const sheetName = workbook.SheetNames[0];
		const sheet = workbook.Sheets[sheetName];
		let data = xlsx.utils.sheet_to_json(sheet); // Convert the sheet data to JSON

		// Convert keys of each item in data to lowercase
		data = data.map((item) => {
			const newItem = {};
			for (const key in item) {
				if (item.hasOwnProperty(key) && key) {
					newItem[key.toLowerCase()] = item[key];
				}
			}
			return newItem;
		});

		const calculateDaysOfResidence = (checkIn, checkOut) => {
			const checkInDate = new Date(new Date(checkIn).setHours(0, 0, 0, 0));
			const checkOutDate = new Date(new Date(checkOut).setHours(0, 0, 0, 0));

			if (isNaN(checkInDate.getTime()) || isNaN(checkOutDate.getTime())) {
				return 0; // Return 0 if dates are invalid
			}

			const diffInTime = checkOutDate.getTime() - checkInDate.getTime();
			const diffInDays = diffInTime / (1000 * 3600 * 24);
			return diffInDays; // Return the difference in days
		};

		const parseDate = (dateString) => {
			const date = new Date(dateString);
			return isNaN(date.getTime()) ? null : date;
		};

		const parsePrice = (priceString) => {
			// Check if the priceString is not undefined and is a string
			if (typeof priceString === "string" || priceString instanceof String) {
				return parseFloat(priceString.replace(/[^\d.-]/g, ""));
			}
			return 0; // Return 0 or some default value if the priceString is not a valid string
		};

		const parseDateToSaudiTimezone = (dateString) => {
			// Parse the date using moment and convert it to the Asia/Riyadh timezone
			return moment.tz(dateString, "Asia/Riyadh").format();
		};

		for (const item of data) {
			const itemNumber = item["book number"]?.toString().trim();
			if (!itemNumber) continue; // Skip if there's no book number

			const daysOfResidence = calculateDaysOfResidence(
				item["check-in"],
				item["check-out"]
			);

			const price =
				(Number(parsePrice(item.price)) +
					// Number(parsePrice(item.price)) * 0.1 +
					Number(parsePrice(item["commission amount"]))) /
				Number(item["rooms"]);

			const chosenPrice =
				daysOfResidence > 0 ? Number(price / daysOfResidence).toFixed(2) : 0;

			const peoplePerRoom = item.persons
				? item.persons
				: item.people / item.rooms;
			// Assuming item['rooms'] gives the number of rooms or you have a way to determine roomType from `item`
			let roomType = ""; // Determine roomType based on `item` details
			// Example logic to determine roomType
			if (peoplePerRoom <= 1) {
				roomType = "Single Room";
			} else if (peoplePerRoom <= 2) {
				roomType = "Double Room";
			} else if (peoplePerRoom === 3) {
				roomType = "Triple Room";
			} else if (peoplePerRoom === 4) {
				roomType = "Quad Room";
			} else {
				roomType = "Family Room";
			} // Add more conditions as per your logic

			// Initialize the pickedRoomsType array
			// const pickedRoomsType = [];

			// Initialize the pickedRoomsType array and populate based on the split unit types
			const unitTypes = item["unit type"].split(",").map((type) => type.trim());
			const roomCount = parseInt(item["rooms"]); // Parse the room count from the item

			// Initialize the pickedRoomsType array and populate based on room count
			const pickedRoomsType = [];

			// Loop through the number of rooms and push the room types to the pickedRoomsType array
			for (let i = 0; i < roomCount; i++) {
				unitTypes.forEach((roomType) => {
					pickedRoomsType.push({
						room_type: roomType,
						chosenPrice: chosenPrice,
						count: 1, // Each object represents 1 room of this type
					});
				});
			}

			// ... Inside your transform logic
			const totalAmount = Number(parsePrice(item.price || 0)).toFixed(2); // Provide a default string if Price is undefined

			const commission = parsePrice(item["commission amount"] || 0); // Provide a default string if Commission Amount is undefined
			// Use the parseDate function for date fields
			const bookedAt = parseDateToSaudiTimezone(item["booked on"]);
			const checkInDate = parseDate(item["check-in"]);
			const checkOutDate = parseDate(item["check-out"]);

			// Check for valid dates before proceeding
			if (!bookedAt || !checkInDate || !checkOutDate) {
				console.error(`Invalid date found in record: ${JSON.stringify(item)}`);
				continue; // Skip this item if dates are invalid
			}

			const commisionUpdate = Number(
				(Number(totalAmount) + Number(commission)) * 0.1
			).toFixed(2);

			// Prepare the document based on your mapping, including any necessary calculations
			const document = {
				confirmation_number: item["book number"] || "",
				booking_source: "jannat",
				customer_details: {
					name: item["guest name(s)"] || "", // Assuming 'Guest Name(s)' contains the full name
				},
				state: item.status ? item.status : "confirmed",
				reservation_status: item.status.toLowerCase().includes("cancelled")
					? "cancelled"
					: item.status.toLowerCase().includes("show")
					? "no_show"
					: item.status,
				total_guests: item.people || 1, // Total number of guests
				total_rooms: item["rooms"], // The number of items in the group
				booked_at: bookedAt,
				checkin_date: checkInDate,
				checkout_date: checkOutDate,
				sub_total: totalAmount,
				total_amount: Number(totalAmount) + Number(commission),
				currency: "SAR", // Adjust as needed
				days_of_residence: daysOfResidence,
				comment: item.remarks || "",
				booking_comment: item.remarks || "",
				payment: item["payment status"] ? item["payment status"] : "Not Paid",
				pickedRoomsType,
				commission: commisionUpdate, // Ensure this field exists in your schema
				hotelId: accountId,
				belongsTo: userId,
			};

			const existingReservation = await Reservations.findOne({
				confirmation_number: itemNumber,
				booking_source: "jannat",
			});

			if (existingReservation) {
				const payment_details = existingReservation.payment_details;
				const payment = existingReservation.payment;
				const paid_amount = existingReservation.paid_amount;

				const {
					customer_details,
					state,
					hotelId,
					belongsTo,
					...documentWithoutCustomerDetails
				} = document;
				await Reservations.updateOne(
					{ confirmation_number: itemNumber },
					{
						$set: {
							...documentWithoutCustomerDetails,
							reservation_status:
								document.reservation_status === "cancelled"
									? "cancelled"
									: document.reservation_status === "no_show"
									? "no_show"
									: existingReservation.reservation_status,
							// Include payment_details in the update to retain it
							payment_details: payment_details,
							payment: payment,
							paid_amount: paid_amount,
						},
					}
				);
			} else {
				try {
					await Reservations.create(document);
				} catch (error) {
					if (error.code === 11000) {
						// Check for duplicate key error
						// console.log(
						// 	`Skipping duplicate document for confirmation_number: ${itemNumber}`
						// );
						continue; // Skip to the next item
					} else {
						throw error; // Rethrow if it's not a duplicate key error
					}
				}
			}
		}

		res.status(200).json({
			message: "Data has been updated and uploaded successfully.",
		});
	} catch (error) {
		console.error("Error in bookingDataDump:", error);
		res.status(500).json({ error: "Internal Server Error" });
	}
};

// Reports

exports.dateReport = async (req, res) => {
	const { date, hotelId, userMainId } = req.params;
	const startOfDay = new Date(`${date}T00:00:00Z`);
	const endOfDay = new Date(`${date}T23:59:59Z`);

	try {
		const reservations = await Reservations.find({
			belongsTo: mongoose.Types.ObjectId(userMainId),
			hotelId: mongoose.Types.ObjectId(hotelId),
			$or: [
				{
					$and: [
						{ booked_at: { $ne: null, $ne: "" } }, // Ensure booked_at is not null
						{ booked_at: { $gte: startOfDay, $lte: endOfDay } },
					],
				},
				{
					$and: [
						{ checkin_date: { $ne: null, $ne: "" } }, // Ensure checkin_date is not null
						{ checkin_date: { $gte: startOfDay, $lte: endOfDay } },
					],
				},
			],
		});

		return res.json(reservations);
	} catch (error) {
		console.error(error);
		return res
			.status(500)
			.json({ error: "Internal server error", details: error.message });
	}
};

exports.dayoverday = async (req, res) => {
	try {
		const { hotelId, userMainId } = req.params;

		const today = new Date();
		today.setHours(0, 0, 0, 0);
		today.setDate(today.getDate() + 2); // This ensures that "today" includes all bookings for the current day.
		const past25Days = new Date(today);
		past25Days.setDate(past25Days.getDate() - 25); // This sets the start date to 25 days before "today".

		const matchCondition = {
			hotelId: ObjectId(hotelId),
			belongsTo: ObjectId(userMainId),
			checkout_date: {
				$gte: past25Days,
				$lte: today,
			},
			$expr: {
				$ne: [
					{ $dateToString: { format: "%Y-%m-%d", date: "$checkout_date" } },
					"2024-03-15",
				],
			},
		};

		const aggregation = await Reservations.aggregate([
			{ $match: matchCondition },
			{
				$addFields: {
					isCancelled: {
						$regexMatch: {
							input: "$reservation_status",
							regex: /cancelled/,
							options: "i",
						},
					},
					isInProgress: {
						$and: [
							{
								$not: [
									{
										$regexMatch: {
											input: "$reservation_status",
											regex: /cancelled|checkedout|checkout|no_show/,
											options: "i",
										},
									},
								],
							},
							{
								$or: [
									{ $eq: [{ $size: "$roomId" }, 0] },
									{ $eq: ["$roomId", null] },
								],
							},
						],
					},
				},
			},
			{
				$group: {
					_id: {
						$dateToString: { format: "%Y-%m-%d", date: "$checkout_date" },
					}, // Use checkout_date here
					totalReservations: { $sum: 1 },
					totalAmount: { $sum: "$sub_total" },
					cancelledReservations: { $sum: { $cond: ["$isCancelled", 1, 0] } },
					cancelledAmount: {
						$sum: { $cond: ["$isCancelled", "$sub_total", 0] },
					},
					inProgressReservations: { $sum: { $cond: ["$isInProgress", 1, 0] } },
					inProgressAmount: {
						$sum: { $cond: ["$isInProgress", "$sub_total", 0] },
					},
				},
			},
			{ $sort: { _id: 1 } }, // Sort by the _id field which is now the formatted checkout_date
		]);

		res.json(aggregation);
	} catch (error) {
		res.status(500).send(error);
	}
};

exports.monthovermonth = async (req, res) => {
	try {
		const { hotelId, userMainId } = req.params;

		const matchCondition = {
			hotelId: ObjectId(hotelId),
			belongsTo: ObjectId(userMainId),
		};

		// Get the current month and year
		const currentMonth = new Date().getMonth() + 3; // +1 because getMonth() returns 0-11
		const currentYear = new Date().getFullYear();

		const aggregation = await Reservations.aggregate([
			{ $match: matchCondition },
			{
				$addFields: {
					monthYear: {
						$concat: [
							{
								$arrayElemAt: [
									[
										"January",
										"February",
										"March",
										"April",
										"May",
										"June",
										"July",
										"August",
										"September",
										"October",
										"November",
										"December",
									],
									{ $subtract: [{ $month: "$checkout_date" }, 1] },
								],
							},
							", ",
							{ $toString: { $year: "$checkout_date" } },
						],
					},
					bookedMonth: { $month: "$checkout_date" },
					bookedYear: { $year: "$checkout_date" },
					isCancelled: {
						$regexMatch: {
							input: "$reservation_status",
							regex: /cancelled/,
							options: "i",
						},
					},
					isInProgress: {
						$and: [
							{
								$not: [
									{
										$regexMatch: {
											input: "$reservation_status",
											regex: /cancelled|checkedout|checkout|no_show/,
											options: "i",
										},
									},
								],
							},
							{
								$or: [
									{ $eq: [{ $size: "$roomId" }, 0] },
									{ $eq: ["$roomId", null] },
								],
							},
						],
					},
				},
			},
			{
				$match: {
					$or: [
						{ bookedYear: { $lt: currentYear } },
						{
							$and: [
								{ bookedYear: currentYear },
								{ bookedMonth: { $lte: currentMonth } },
							],
						},
					],
				},
			},
			{
				$group: {
					_id: "$monthYear",
					year: { $first: "$bookedYear" },
					month: { $first: "$bookedMonth" },
					totalReservations: { $sum: 1 },
					totalAmount: { $sum: "$sub_total" },
					cancelledReservations: { $sum: { $cond: ["$isCancelled", 1, 0] } },
					cancelledAmount: {
						$sum: { $cond: ["$isCancelled", "$sub_total", 0] },
					},
					inProgressReservations: { $sum: { $cond: ["$isInProgress", 1, 0] } },
					inProgressAmount: {
						$sum: { $cond: ["$isInProgress", "$sub_total", 0] },
					},
				},
			},
			{
				$sort: {
					year: 1,
					month: 1,
				},
			},
			{ $limit: 12 }, // Limit to the latest 12 months
		]);

		res.json(aggregation);
	} catch (error) {
		res.status(500).send(error);
	}
};

exports.bookingSource = async (req, res) => {
	try {
		const { hotelId, userMainId } = req.params;

		const matchCondition = {
			hotelId: ObjectId(hotelId),
			belongsTo: ObjectId(userMainId),
		};

		const aggregation = await Reservations.aggregate([
			{ $match: matchCondition },
			{
				$addFields: {
					isCancelled: {
						$regexMatch: {
							input: "$reservation_status",
							regex: /cancelled/,
							options: "i",
						},
					},
					isInProgress: {
						$and: [
							{
								$not: [
									{
										$regexMatch: {
											input: "$reservation_status",
											regex: /cancelled|checkedout|checkout|no_show/,
											options: "i",
										},
									},
								],
							},
							{
								$or: [
									{ $eq: [{ $size: "$roomId" }, 0] },
									{ $eq: ["$roomId", null] },
								],
							},
						],
					},
				},
			},
			{
				$group: {
					_id: "$booking_source",
					totalReservations: { $sum: 1 },
					totalAmount: { $sum: "$sub_total" },
					cancelledReservations: { $sum: { $cond: ["$isCancelled", 1, 0] } },
					cancelledAmount: {
						$sum: { $cond: ["$isCancelled", "$sub_total", 0] },
					},
					inProgressReservations: { $sum: { $cond: ["$isInProgress", 1, 0] } },
					inProgressAmount: {
						$sum: { $cond: ["$isInProgress", "$sub_total", 0] },
					},
				},
			},
			{ $sort: { _id: 1 } },
		]);

		res.json(aggregation);
	} catch (error) {
		res.status(500).send(error);
	}
};

exports.reservationstatus = async (req, res) => {
	try {
		const { hotelId, userMainId } = req.params;

		const matchCondition = {
			hotelId: ObjectId(hotelId),
			belongsTo: ObjectId(userMainId),
		};

		const aggregation = await Reservations.aggregate([
			{ $match: matchCondition },
			{
				$addFields: {
					groupedStatus: {
						$switch: {
							branches: [
								{
									case: {
										$regexMatch: {
											input: "$reservation_status",
											regex: /cancelled/,
										},
									},
									then: "cancelled",
								},
								{
									case: { $in: ["$reservation_status", ["confirmed", "ok"]] },
									then: "confirmed",
								},
							],
							default: "$reservation_status",
						},
					},
				},
			},
			{
				$group: {
					_id: "$groupedStatus",
					totalReservations: { $sum: 1 },
					totalAmount: { $sum: "$sub_total" },
					cancelledAmount: {
						$sum: {
							$cond: [
								{ $eq: ["$groupedStatus", "cancelled"] },
								"$sub_total",
								0,
							],
						},
					},
					inProgressReservations: {
						$sum: {
							$cond: [
								{
									$or: [
										{ $eq: [{ $size: "$roomId" }, 0] },
										{ $eq: ["$roomId", null] },
									],
								},
								1,
								0,
							],
						},
					},
				},
			},
			{ $sort: { _id: 1 } },
		]);

		res.json(aggregation);
	} catch (error) {
		res.status(500).send(error);
	}
};

exports.CheckedOutReservations = async (req, res) => {
	try {
		const { page, records, hotelId } = req.params;
		const parsedPage = parseInt(page);
		const parsedRecords = parseInt(records);

		if (
			isNaN(parsedPage) ||
			isNaN(parsedRecords) ||
			!ObjectId.isValid(hotelId)
		) {
			return res.status(400).send("Invalid parameters");
		}

		let dynamicFilter = {
			hotelId: ObjectId(hotelId),
			reservation_status: "checked_out",
			"roomId.0": { $exists: true }, // Ensure at least one roomId exists
		};

		// Calculate dates for the filter: 2 days ago to 2 days in advance
		const today = new Date();
		const twoDaysAgo = new Date(today);
		twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
		const twoDaysInAdvance = new Date(today);
		twoDaysInAdvance.setDate(twoDaysInAdvance.getDate() + 2);

		// Filter for checkout_date to include dates from 2 days ago up to 2 days in advance
		dynamicFilter.checkout_date = {
			$gte: twoDaysAgo,
			$lte: twoDaysInAdvance,
		};

		const pipeline = [
			{ $match: dynamicFilter },
			{ $sort: { booked_at: -1 } },
			{ $skip: (parsedPage - 1) * parsedRecords },
			{ $limit: parsedRecords },
			{
				$lookup: {
					from: "rooms",
					localField: "roomId",
					foreignField: "_id",
					as: "roomDetails",
				},
			},
		];

		const reservations = await Reservations.aggregate(pipeline);
		res.json(reservations);
	} catch (error) {
		console.error(error);
		res.status(500).send("Server error: " + error.message);
	}
};

exports.pendingPaymentReservations = async (req, res) => {
	try {
		const { page, records, hotelId } = req.params;
		const parsedPage = parseInt(page);
		const parsedRecords = parseInt(records);

		if (
			isNaN(parsedPage) ||
			isNaN(parsedRecords) ||
			!ObjectId.isValid(hotelId)
		) {
			return res.status(400).send("Invalid parameters");
		}

		let dynamicFilter = {
			hotelId: ObjectId(hotelId),
			booking_source: { $in: ["janat", "affiliate", "manual", "jannat"] },
			reservation_status: { $in: ["checked_out"] },
			financeStatus: { $in: ["not moved", "not paid", "", undefined] },
		};

		// Calculate dates for the filter: 2 days ago to 2 days in advance
		const today = new Date();
		const twoDaysAgo = new Date(today);
		twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
		const twoDaysInAdvance = new Date(today);
		twoDaysInAdvance.setDate(twoDaysInAdvance.getDate() + 2);

		const pipeline = [
			{ $match: dynamicFilter },
			{ $sort: { booked_at: -1 } },
			{ $skip: (parsedPage - 1) * parsedRecords },
			{ $limit: parsedRecords },
			{
				$lookup: {
					from: "rooms",
					localField: "roomId",
					foreignField: "_id",
					as: "roomDetails",
				},
			},
		];

		const reservations = await Reservations.aggregate(pipeline);
		res.json(reservations);
	} catch (error) {
		console.error(error);
		res.status(500).send("Server error: " + error.message);
	}
};

exports.commissionPaidReservations = async (req, res) => {
	try {
		const { page, records, hotelId } = req.params;
		const parsedPage = parseInt(page);
		const parsedRecords = parseInt(records);

		if (
			isNaN(parsedPage) ||
			isNaN(parsedRecords) ||
			!ObjectId.isValid(hotelId)
		) {
			return res.status(400).send("Invalid parameters");
		}

		let dynamicFilter = {
			hotelId: ObjectId(hotelId),
			booking_source: { $in: ["janat", "affiliate", "manual", "jannat"] },
			reservation_status: { $in: ["checked_out"] },
			financeStatus: { $in: ["paid"] },
		};

		// Calculate dates for the filter: 2 days ago to 2 days in advance
		const today = new Date();
		const twoDaysAgo = new Date(today);
		twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
		const twoDaysInAdvance = new Date(today);
		twoDaysInAdvance.setDate(twoDaysInAdvance.getDate() + 2);

		const pipeline = [
			{ $match: dynamicFilter },
			{ $sort: { booked_at: -1 } },
			{ $skip: (parsedPage - 1) * parsedRecords },
			{ $limit: parsedRecords },
			{
				$lookup: {
					from: "rooms",
					localField: "roomId",
					foreignField: "_id",
					as: "roomDetails",
				},
			},
		];

		const reservations = await Reservations.aggregate(pipeline);
		res.json(reservations);
	} catch (error) {
		console.error(error);
		res.status(500).send("Server error: " + error.message);
	}
};

exports.pendingConfirmationReservations = async (req, res) => {
	try {
		const { page = 1, records = 50, hotelId, userId } = req.params;
		const search = String(req.query?.search || "").trim();
		const parsedPage = Math.max(parseInt(page, 10) || 1, 1);
		const parsedRecords = Math.min(
			Math.max(parseInt(records, 10) || 50, 1),
			500
		);

		if (!ObjectId.isValid(hotelId)) {
			return res.status(400).json({ error: "Invalid hotel ID" });
		}

		const actorId = req.auth?._id || userId;
		const actor =
			actorId && ObjectId.isValid(actorId)
				? await User.findById(actorId)
						.select(
							"_id role roleDescription roles roleDescriptions accessTo hotelIdWork belongsToId hotelsToSupport hotelIdsOwner"
						)
						.lean()
						.exec()
				: null;

		if (!actor) {
			return res.status(401).json({ error: "Valid user is required" });
		}
		if (!(await canViewReservationHotel(actor, hotelId))) {
			return res.status(403).json({ error: "Access denied" });
		}
		if (!canUsePendingConfirmationWorkflow(actor)) {
			return res.status(403).json({
				error: "This account cannot view pending confirmation reservations",
			});
		}

		const workflowScope = getPendingWorkflowScopeForActor(actor);
		const dynamicFilter = buildPendingConfirmationFilter(hotelId, workflowScope);
		if (search) {
			const searchMatch = buildReservationSearchMatch(search);
			if (searchMatch) {
				dynamicFilter.$and = [
					...(Array.isArray(dynamicFilter.$and) ? dynamicFilter.$and : []),
					searchMatch,
				];
			}
		}

		const pipelineBase = [
			{ $match: dynamicFilter },
			{
				$lookup: {
					from: "rooms",
					localField: "roomId",
					foreignField: "_id",
					as: "roomDetails",
				},
			},
			{
				$addFields: {
					bookingSortDate: {
						$ifNull: ["$booked_at", "$createdAt"],
					},
				},
			},
			{ $sort: { bookingSortDate: 1, createdAt: 1 } },
		];

		const [rows, total] = await Promise.all([
			Reservations.aggregate([
				...pipelineBase,
				{ $skip: (parsedPage - 1) * parsedRecords },
				{ $limit: parsedRecords },
			]),
			Reservations.countDocuments(dynamicFilter),
		]);

		res.json({
			total,
			page: parsedPage,
			records: parsedRecords,
			data: rows.map((reservation) => ({
				...reservation,
				pendingReasons: getPendingConfirmationReasonsForActor(
					reservation,
					actor
				),
			})),
		});
	} catch (error) {
		console.error("Error fetching pending confirmation reservations:", error);
		res.status(500).json({ error: "Server error: " + error.message });
	}
};

exports.pendingConfirmationNotificationFeed = async (req, res) => {
	try {
		const { userId } = req.params;
		const hotelId = normalizeId(req.query?.hotelId);
		const ownerId = normalizeId(req.query?.ownerId);
		const limit = Math.min(
			Math.max(parseInt(req.query?.limit, 10) || 8, 1),
			25
		);
		const actorId = req.auth?._id || userId;

		if (!actorId || !ObjectId.isValid(actorId)) {
			return res.status(401).json({ error: "Valid user is required" });
		}

		const actor = await User.findById(actorId)
			.select(
				"_id role roleDescription roles roleDescriptions accessTo hotelIdWork belongsToId hotelsToSupport hotelIdsOwner activeUser"
			)
			.lean()
			.exec();

		if (!actor || actor.activeUser === false) {
			return res.status(401).json({ error: "Valid active user is required" });
		}
		if (isOrderTakingAccount(actor)) {
			let hotels = [];
			if (hotelId) {
				if (!ObjectId.isValid(hotelId)) {
					return res.status(400).json({ error: "Invalid hotel ID" });
				}
				if (!(await canViewReservationHotel(actor, hotelId))) {
					return res.status(403).json({ error: "Access denied" });
				}
				const hotel = await HotelDetails.findById(hotelId)
					.select("_id hotelName belongsTo")
					.lean()
					.exec();
				hotels = hotel ? [hotel] : [];
			} else {
				hotels = await getPendingNotificationHotelsForActor(actor, ownerId);
			}

			const hotelIds = hotels
				.map((hotel) => normalizeId(hotel?._id))
				.filter((id) => ObjectId.isValid(id));
			if (!hotelIds.length) {
				return res.json({ total: 0, data: [] });
			}

			const hotelMap = hotels.reduce((acc, hotel) => {
				const id = normalizeId(hotel?._id);
				if (id) {
					acc[id] = {
						hotelName: hotel.hotelName || "",
						hotelOwnerId: normalizeId(hotel.belongsTo),
					};
				}
				return acc;
			}, {});

			const agentOwnReservationClause = {
				$or: [
					{ orderTakeId: ObjectId(normalizeId(actor._id)) },
					{ createdByUserId: ObjectId(normalizeId(actor._id)) },
				],
			};
			const agentDecisionQuery = {
				hotelId: { $in: hotelIds.map((id) => ObjectId(id)) },
				$and: [
					agentOwnReservationClause,
					buildNewReservationProcessFilter(),
					{
						$or: [
							{ reservation_status: PENDING_CONFIRMATION_REGEX },
							{ state: PENDING_CONFIRMATION_REGEX },
							{
								"agentDecisionSnapshot.status": {
									$in: ["confirmed", "rejected"],
								},
							},
							{
								"pendingConfirmation.status": {
									$in: ["confirmed", "rejected"],
								},
							},
							buildCommissionMissingFilter(),
						],
					},
				],
			};
			const [rows, total] = await Promise.all([
				Reservations.find(agentDecisionQuery)
					.select(
						"_id hotelId confirmation_number customer_details booking_source booked_at createdAt checkin_date checkout_date reservation_status state total_amount commission commissionData commissionStatus financial_cycle agentDecisionSnapshot pendingConfirmation"
					)
					.sort({ updatedAt: -1, createdAt: -1 })
					.limit(limit)
					.lean()
					.exec(),
				Reservations.countDocuments(agentDecisionQuery),
			]);

			return res.json({
				total,
				data: rows.map((reservation) => {
					const currentHotelId = normalizeId(reservation.hotelId);
					const hotel = hotelMap[currentHotelId] || {};
					const decision =
						reservation.agentDecisionSnapshot ||
						reservation.pendingConfirmation ||
						{};
					const decisionStatus = String(decision.status || "").toLowerCase();
					const isDecision = ["confirmed", "rejected"].includes(decisionStatus);
					const pendingReasons = isDecision
						? []
						: getPendingConfirmationReasons(reservation);
					return {
						_id: reservation._id,
						notificationType: isDecision
							? "agent_decision"
							: pendingReasons.includes("commission_missing") &&
							  !pendingReasons.includes("pending_confirmation")
							? "commission_review"
							: "agent_review",
						hotelId: currentHotelId,
						hotelName: hotel.hotelName || "",
						hotelOwnerId: hotel.hotelOwnerId || ownerId || "",
						confirmation_number: reservation.confirmation_number,
						guestName: reservation.customer_details?.name || "",
						booking_source: reservation.booking_source || "",
						booked_at: reservation.booked_at || reservation.createdAt,
						checkin_date: reservation.checkin_date,
						checkout_date: reservation.checkout_date,
						reservation_status:
							reservation.reservation_status || reservation.state || "",
						total_amount: reservation.total_amount || 0,
						pendingReasons,
						decisionStatus: decision.status || "",
						decisionReason:
							decision.reason ||
							decision.rejectionReason ||
							decision.confirmationReason ||
							"",
					};
				}),
			});
		}
		if (!canUsePendingConfirmationWorkflow(actor)) {
			return res.json({ total: 0, data: [] });
		}

		let hotels = [];
		if (hotelId) {
			if (!ObjectId.isValid(hotelId)) {
				return res.status(400).json({ error: "Invalid hotel ID" });
			}
			if (!(await canViewReservationHotel(actor, hotelId))) {
				return res.status(403).json({ error: "Access denied" });
			}
			const hotel = await HotelDetails.findById(hotelId)
				.select("_id hotelName belongsTo")
				.lean()
				.exec();
			hotels = hotel ? [hotel] : [];
		} else {
			hotels = await getPendingNotificationHotelsForActor(actor, ownerId);
		}

		const hotelIds = hotels
			.map((hotel) => normalizeId(hotel?._id))
			.filter((id) => ObjectId.isValid(id));

		if (!hotelIds.length) {
			return res.json({ total: 0, data: [] });
		}

		const hotelMap = hotels.reduce((acc, hotel) => {
			const id = normalizeId(hotel?._id);
			if (id) {
				acc[id] = {
					hotelName: hotel.hotelName || "",
					hotelOwnerId: normalizeId(hotel.belongsTo),
				};
			}
			return acc;
		}, {});

		const workflowScope = getPendingWorkflowScopeForActor(actor);
		const filters = hotelIds.map((id) =>
			buildPendingConfirmationFilter(id, workflowScope)
		);
		const query = filters.length === 1 ? filters[0] : { $or: filters };
		const [rows, total] = await Promise.all([
			Reservations.find(query)
				.select(
					"_id hotelId confirmation_number customer_details booking_source booked_at createdAt checkin_date checkout_date reservation_status state total_amount commission commissionData commissionStatus financial_cycle pendingConfirmation"
				)
				.sort({ booked_at: 1, createdAt: 1 })
				.limit(limit)
				.lean()
				.exec(),
			Reservations.countDocuments(query),
		]);

		return res.json({
			total,
			data: rows.map((reservation) => {
				const currentHotelId = normalizeId(reservation.hotelId);
				const hotel = hotelMap[currentHotelId] || {};
				const pendingReasons = getPendingConfirmationReasonsForActor(
					reservation,
					actor
				);
				return {
					_id: reservation._id,
					notificationType: getReservationNotificationTypeForActor(
						reservation,
						actor
					),
					hotelId: currentHotelId,
					hotelName: hotel.hotelName || "",
					hotelOwnerId: hotel.hotelOwnerId || ownerId || "",
					confirmation_number: reservation.confirmation_number,
					guestName: reservation.customer_details?.name || "",
					guestPhone: reservation.customer_details?.phone || "",
					booking_source: reservation.booking_source || "",
					booked_at: reservation.booked_at || reservation.createdAt,
					checkin_date: reservation.checkin_date,
					checkout_date: reservation.checkout_date,
					reservation_status:
						reservation.reservation_status || reservation.state || "",
					total_amount: reservation.total_amount || 0,
					pendingReasons,
				};
			}),
		});
	} catch (error) {
		console.error("Error fetching pending confirmation notifications:", error);
		return res.status(500).json({ error: "Server error: " + error.message });
	}
};

exports.updatePendingConfirmationReservation = async (req, res) => {
	try {
		const { reservationId, userId } = req.params;
		const body = req.body || {};
		const actorId = req.auth?._id || body.userId || userId;

		if (!ObjectId.isValid(reservationId)) {
			return res.status(400).json({ error: "Invalid reservation ID" });
		}
		if (!actorId || !ObjectId.isValid(actorId)) {
			return res.status(401).json({ error: "Valid user is required" });
		}

		const [reservation, actor] = await Promise.all([
			Reservations.findById(reservationId),
			User.findById(actorId)
				.select(
					"_id name email role roleDescription roles roleDescriptions accessTo hotelIdWork belongsToId hotelsToSupport hotelIdsOwner"
				)
				.lean()
				.exec(),
		]);

		if (!reservation) {
			return res.status(404).json({ error: "Reservation not found" });
		}
		if (!actor || !(await canViewReservationHotel(actor, reservation.hotelId))) {
			return res.status(403).json({ error: "Access denied" });
		}
		if (!canUsePendingConfirmationWorkflow(actor)) {
			return res.status(403).json({
				error: "This account cannot confirm or financially reconcile reservations",
			});
		}
		if (isOrderTakingAccount(actor)) {
			return res.status(403).json({
				error: "External agents cannot confirm or financially reconcile reservations",
			});
		}

		const processDate = reservation.booked_at || reservation.createdAt;
		if (!processDate || new Date(processDate) < NEW_RESERVATION_PROCESS_START) {
			return res.status(400).json({
				error: "This confirmation workflow only applies to new-process reservations",
			});
		}

		const action = String(body.action || "").toLowerCase();
		const financeFieldsProvided = [
			"commission",
			"commissionPaid",
			"commissionStatus",
		].some((field) => Object.prototype.hasOwnProperty.call(body, field));
		const isFinanceAction = action === "finance" || (!action && financeFieldsProvided);
		if (isFinanceOnlyAccount(actor) && !isFinanceAction) {
			return res.status(403).json({
				error: "Finance users can only assign or reconcile reservation commission.",
			});
		}
		if (isReservationEmployeeOnlyAccount(actor) && isFinanceAction) {
			return res.status(403).json({
				error: "Reservation employees can confirm reservations, but commission review is handled by finance or management.",
			});
		}
		const now = new Date();
		const auditActor = await resolveReservationAuditActor(actorId, body, {
			previewAuth: req.auth,
		});
		const confirmationReason = String(
			body.confirmationReason || body.reason || ""
		).trim();
		const existingPending =
			reservation.pendingConfirmation &&
			typeof reservation.pendingConfirmation.toObject === "function"
				? reservation.pendingConfirmation.toObject()
				: reservation.pendingConfirmation || {};
		const updatePayload = {};

		if (body.commission !== undefined) {
			updatePayload.commission = n2(body.commission);
			const existingCommissionData =
				reservation.commissionData &&
				typeof reservation.commissionData.toObject === "function"
					? reservation.commissionData.toObject()
					: reservation.commissionData || {};
			updatePayload.commissionData = {
				...existingCommissionData,
				// A 0 SAR commission is valid when finance reviewed it and decided
				// no commission is due for this source/reservation.
				assigned: true,
				amount: updatePayload.commission,
				status:
					body.commissionStatus ||
					existingCommissionData.status ||
					reservation.commissionStatus ||
					"commission due",
				assignedAt: now,
				assignedBy: auditActor,
			};
		}
		if (body.commissionPaid !== undefined) {
			updatePayload.commissionPaid = !!body.commissionPaid;
			if (updatePayload.commissionPaid && !reservation.commissionPaid) {
				updatePayload.commissionPaidAt = now;
			}
		}
		if (body.commissionStatus !== undefined) {
			updatePayload.commissionStatus = String(body.commissionStatus || "").trim();
		} else if (body.commissionPaid !== undefined) {
			updatePayload.commissionStatus = updatePayload.commissionPaid
				? "commission paid"
				: "commission due";
		}

		if (action === "confirm") {
			updatePayload.reservation_status = "Confirmed";
			updatePayload.state = "Confirmed";
			updatePayload.pendingConfirmation = {
				...existingPending,
				status: "confirmed",
				rejectionReason: "",
				confirmationReason,
				confirmedAt: now,
				rejectedAt: null,
				lastUpdatedAt: now,
				lastUpdatedBy: auditActor,
			};
			updatePayload.agentDecisionSnapshot = {
				status: "confirmed",
				reason: confirmationReason,
				decidedAt: now,
				decidedBy: auditActor,
			};
		}

		if (["pending", "revert", "revert_to_pending"].includes(action)) {
			updatePayload.reservation_status = "Pending Confirmation";
			updatePayload.state = "Pending Confirmation";
			updatePayload.pendingConfirmation = {
				...existingPending,
				status: "pending",
				rejectionReason: "",
				confirmationReason: "",
				confirmedAt: null,
				rejectedAt: null,
				revertedAt: now,
				lastUpdatedAt: now,
				lastUpdatedBy: auditActor,
			};
			updatePayload.agentDecisionSnapshot = {
				status: "pending",
				reason: confirmationReason,
				decidedAt: now,
				decidedBy: auditActor,
			};
		}

		if (action === "reject") {
			const rejectionReason = String(
				body.rejectionReason || body.rejectionComment || body.comment || ""
			).trim();
			if (!rejectionReason) {
				return res
					.status(400)
					.json({ error: "Rejection reason is required" });
			}
			updatePayload.reservation_status = "Rejected";
			updatePayload.state = "Rejected";
			updatePayload.pendingConfirmation = {
				...existingPending,
				status: "rejected",
				rejectionReason,
				confirmationReason: "",
				confirmedAt: null,
				rejectedAt: now,
				lastUpdatedAt: now,
				lastUpdatedBy: auditActor,
			};
			updatePayload.agentDecisionSnapshot = {
				status: "rejected",
				reason: rejectionReason,
				decidedAt: now,
				decidedBy: auditActor,
			};
		}

		const touchesFinancialCycle = [
			"commission",
			"commissionData",
			"commissionPaid",
			"commissionStatus",
		].some((key) => Object.prototype.hasOwnProperty.call(updatePayload, key));

		if (touchesFinancialCycle) {
			updatePayload.financial_cycle = buildFinancialCycleSnapshot(
				reservation,
				updatePayload,
				actorId
			);
		}

		if (["confirm", "reject", "pending", "revert", "revert_to_pending"].includes(action)) {
			const walletSnapshot = await buildReservationAgentWalletSnapshot({
				reservation,
				actor: auditActor,
				reason: `pending_confirmation_${action || "update"}`,
			});
			if (walletSnapshot) {
				updatePayload.agentWalletSnapshot = walletSnapshot;
			}
		}

		if (!Object.keys(updatePayload).length) {
			return res.status(400).json({ error: "No update was provided" });
		}

		const auditEntries = buildReservationAuditEntries(
			reservation,
			updatePayload,
			auditActor
		);
		const updateOperation = {
			$set: {
				...updatePayload,
				adminLastUpdatedAt: now,
				adminLastUpdatedBy: auditActor,
			},
		};
		if (auditEntries.length) {
			updateOperation.$push = {
				adminChangeLog: { $each: auditEntries },
				reservationAuditLog: { $each: auditEntries },
			};
		}

		const updatedReservation = await Reservations.findByIdAndUpdate(
			reservationId,
			updateOperation,
			{ new: true }
		)
			.populate("roomId", "room_number room_type displayName")
			.lean()
			.exec();

		emitHotelNotificationRefresh(req, updatedReservation.hotelId, {
			type: "pending_confirmation",
			reservationId: updatedReservation._id,
			ownerId: updatedReservation.belongsTo,
		}).catch((error) =>
			console.error("Error emitting reservation notification:", error)
		);

		return res.json({
			...updatedReservation,
			pendingReasons: getPendingConfirmationReasonsForActor(
				updatedReservation,
				actor
			),
		});
	} catch (error) {
		console.error("Error updating pending confirmation reservation:", error);
		return res.status(500).json({ error: "Server error: " + error.message });
	}
};

exports.reservationAgentWalletSnapshot = async (req, res) => {
	try {
		const { reservationId, userId } = req.params;
		const actorId = req.auth?._id || userId;

		if (!ObjectId.isValid(reservationId)) {
			return res.status(400).json({ error: "Invalid reservation ID" });
		}
		if (!actorId || !ObjectId.isValid(actorId)) {
			return res.status(401).json({ error: "Valid user is required" });
		}

		const [reservation, actor] = await Promise.all([
			Reservations.findById(reservationId),
			User.findById(actorId)
				.select(
					"_id name email role roleDescription roles roleDescriptions accessTo hotelIdWork belongsToId hotelsToSupport hotelIdsOwner activeUser"
				)
				.lean()
				.exec(),
		]);

		if (!reservation) {
			return res.status(404).json({ error: "Reservation not found" });
		}
		if (
			!actor ||
			actor.activeUser === false ||
			!(await canViewReservationHotel(actor, reservation.hotelId)) ||
			!canUsePendingConfirmationWorkflow(actor)
		) {
			return res.status(403).json({ error: "Access denied" });
		}

		const agent = await resolveReservationAgent(reservation);
		if (!agent) {
			return res.json({ isAgentReservation: false, snapshot: null });
		}

		const existingSnapshot = getPlainAgentWalletSnapshot(reservation);
		const snapshot = existingSnapshot?.captured
			? reconcileAgentWalletSnapshotAmount(existingSnapshot, reservation)
			: await buildReservationAgentWalletSnapshot({
					reservation,
					actor: buildReservationActorSnapshot(actor),
					reason: "reservation_detail_backfill",
			  });

		if (
			snapshot &&
			(!existingSnapshot?.captured ||
				agentWalletSnapshotNeedsSync(existingSnapshot, snapshot))
		) {
			// Silent backfill/sync for older or repriced reservations. The wallet
			// before-balance stays fixed, while the reservation amount follows edits.
			await Reservations.findByIdAndUpdate(reservationId, {
				$set: { agentWalletSnapshot: snapshot },
			}).exec();
		}

		return res.json({
			isAgentReservation: true,
			snapshot,
		});
	} catch (error) {
		console.error("Error reading reservation agent wallet snapshot:", error);
		return res.status(500).json({ error: "Server error: " + error.message });
	}
};

const monthNames = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
];

exports.ownerReport = async (req, res) => {
	try {
		const { month, hotelIds } = req.params;
		const monthNumber = monthNames.indexOf(month) + 1; // Convert month name to month number
		if (monthNumber === 0) {
			throw new Error("Invalid month name");
		}
		const year = new Date().getFullYear();
		const startDate = new Date(Date.UTC(year, monthNumber - 1, 1));
		const endDate = new Date(Date.UTC(year, monthNumber, 0));

		const hotelIdsArray = hotelIds
			.split("-")
			.map((id) => mongoose.Types.ObjectId(id));

		const aggregateResult = await Reservations.aggregate([
			{
				$match: {
					hotelId: { $in: hotelIdsArray },
					checkout_date: { $gte: startDate, $lte: endDate },
					reservation_status: { $nin: ["cancelled", "canceled", "no_show"] },
				},
			},
			{
				$lookup: {
					from: "hoteldetails", // Ensure this is the correct collection name
					localField: "hotelId",
					foreignField: "_id",
					as: "hotelInfo",
				},
			},
			{ $unwind: { path: "$hotelInfo", preserveNullAndEmptyArrays: true } },
			{
				$group: {
					_id: {
						hotelName: "$hotelInfo.hotelName",
						booking_source: "$booking_source",
					},
					totalBookings: { $sum: 1 },
					total_amount: { $sum: "$total_amount" },
					sub_total: { $sum: "$sub_total" },
					commission: { $sum: "$commission" },
					totalBookingsHoused: {
						$sum: {
							$cond: [
								{
									$regexMatch: {
										input: "$reservation_status",
										regex: /checked_out/,
									},
								},
								1,
								0,
							],
						},
					},
					total_amountHoused: {
						$sum: {
							$cond: [
								{
									$regexMatch: {
										input: "$reservation_status",
										regex: /checked_out/,
									},
								},
								"$total_amount",
								0,
							],
						},
					},
					totalNights: {
						$sum: {
							$subtract: [
								{ $dayOfYear: "$checkout_date" },
								{ $dayOfYear: "$checkin_date" },
							],
						},
					},
				},
			},
			{
				$project: {
					hotelName: "$_id.hotelName",
					booking_source: "$_id.booking_source",
					totalBookings: 1,
					total_amount: 1,
					sub_total: 1,
					commission: 1,
					totalBookingsHoused: 1,
					total_amountHoused: 1,
					totalNights: 1, // Include the totalNights in the projection
					_id: 0,
				},
			},
		]);

		res.json(aggregateResult);
	} catch (error) {
		console.error(error);
		res.status(500).send("Server error: " + error.message);
	}
};

exports.ownerReservationToDate = async (req, res) => {
	try {
		const { hotelIds, date } = req.params;

		// Convert hotelIds string to array of ObjectIds
		const hotelIdsArray = hotelIds
			.split("-")
			.map((id) => mongoose.Types.ObjectId(id));

		// Convert date string to Date object and adjust for Saudi Arabia timezone
		const checkinDate = new Date(date + "T00:00:00+03:00"); // Assuming 'date' is in 'yyyy-mm-dd' format

		const reservations = await Reservations.find({
			hotelId: { $in: hotelIdsArray },
			checkin_date: {
				$gte: checkinDate,
				$lt: new Date(checkinDate.getTime() + 86400000), // Add 24 hours to get the end of the day
			},
			reservation_status: { $nin: ["cancelled", "canceled", "no_show"] },
		}).populate("hotelId", "hotelName"); // Assuming you want to include the hotel name in the response

		res.json(reservations);
	} catch (error) {
		console.error(error);
		res.status(500).send("Server error: " + error.message);
	}
};

exports.CollectedReservations = async (req, res) => {
	try {
		const { page, records, hotelId, status } = req.params;
		const parsedPage = parseInt(page);
		const parsedRecords = parseInt(records);

		if (
			isNaN(parsedPage) ||
			isNaN(parsedRecords) ||
			!ObjectId.isValid(hotelId)
		) {
			return res.status(400).send("Invalid parameters");
		}

		let dynamicFilter = {
			hotelId: ObjectId(hotelId),
			payment: "collected", // Filter for payment field to be "collected"
		};

		// Add reservation_status to the filter if the status is not "all"
		if (status !== "all") {
			dynamicFilter.reservation_status = status;
		}

		const pipeline = [
			{ $match: dynamicFilter },
			{ $sort: { booked_at: -1 } },
			{ $skip: (parsedPage - 1) * parsedRecords },
			{ $limit: parsedRecords },
			{
				$lookup: {
					from: "rooms",
					localField: "roomId",
					foreignField: "_id",
					as: "roomDetails",
				},
			},
		];

		const reservations = await Reservations.aggregate(pipeline);
		res.json(reservations);
	} catch (error) {
		console.error(error);
		res.status(500).send("Server error: " + error.message);
	}
};

exports.aggregateCollectedReservations = async (req, res) => {
	try {
		const { page, records, hotelId, status } = req.params;
		const parsedPage = parseInt(page);
		const parsedRecords = parseInt(records);

		if (
			isNaN(parsedPage) ||
			isNaN(parsedRecords) ||
			!ObjectId.isValid(hotelId)
		) {
			return res.status(400).send("Invalid parameters");
		}

		let dynamicFilter = {
			hotelId: ObjectId(hotelId),
			payment: "collected", // Filter for payment field to be "collected"
		};

		// Add reservation_status to the filter if the status is not "all"
		if (status !== "all") {
			dynamicFilter.reservation_status = status;
		}

		const pipeline = [
			{ $match: dynamicFilter },
			{
				$group: {
					_id: null,
					total_reservation: { $sum: 1 },
					total_amount: { $sum: "$total_amount" },
					actual_amount: { $sum: "$sub_total" },
				},
			},
			{
				$project: {
					_id: 0,
					total_reservation: 1,
					total_amount: 1,
					actual_amount: 1,
					commission: { $subtract: ["$total_amount", "$actual_amount"] },
				},
			},
		];

		const result = await Reservations.aggregate(pipeline);
		res.json(result[0]);
	} catch (error) {
		console.error(error);
		res.status(500).send("Server error: " + error.message);
	}
};
