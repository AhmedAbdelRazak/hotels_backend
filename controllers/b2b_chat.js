/** @format */

"use strict";

const mongoose = require("mongoose");
const B2BChat = require("../models/b2b_chat");
const User = require("../models/user");
const HotelDetails = require("../models/hotel_details");

const ObjectId = mongoose.Types.ObjectId;

const CHAT_USER_SELECT =
	"_id name email companyName role roleDescription roles roleDescriptions activeUser hotelIdWork hotelIdsWork hotelIdsOwner hotelsToSupport belongsToId accessTo agentApproval";

const CHAT_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const MAX_ATTACHMENT_COUNT = 6;
const MAX_ATTACHMENT_DATA_URL = 7 * 1024 * 1024;
const B2B_UNREAD_CACHE_TTL_MS = 5000;
const B2B_UNREAD_CACHE_MAX = 500;
const b2bUnreadSummaryCache = new Map();

const normalizeId = (value) => {
	if (!value) return "";
	if (typeof value === "object") return String(value._id || value.id || "");
	return String(value);
};

const uniqueIds = (values = []) => [
	...new Set(
		(Array.isArray(values) ? values : [values])
			.map(normalizeId)
			.filter(Boolean)
	),
];

const validIds = (values = []) =>
	uniqueIds(values).filter((id) => ObjectId.isValid(id));

const toObjectIds = (values = []) => validIds(values).map((id) => ObjectId(id));

const normalizeRoleKey = (value = "") =>
	String(value || "")
		.toLowerCase()
		.replace(/[\s_-]+/g, "");

const roleNumbers = (user = {}) => [
	Number(user.role),
	...(Array.isArray(user.roles) ? user.roles.map(Number) : []),
];

const roleDescriptionKeys = (user = {}) => [
	normalizeRoleKey(user.roleDescription),
	...(Array.isArray(user.roleDescriptions)
		? user.roleDescriptions.map(normalizeRoleKey)
		: []),
].filter(Boolean);

const hasRole = (user = {}, role) => roleNumbers(user).includes(Number(role));

const hasRoleKey = (user = {}, key) =>
	roleDescriptionKeys(user).includes(normalizeRoleKey(key));

const configuredSuperAdminIds = () =>
	[process.env.SUPER_ADMIN_ID, process.env.REACT_APP_SUPER_ADMIN_ID]
		.flatMap((value) => String(value || "").split(","))
		.map((id) => String(id).trim())
		.filter(Boolean);

const isConfiguredSuperAdmin = (user = {}) =>
	configuredSuperAdminIds().includes(normalizeId(user._id || user));

const isPlatformSuperAdmin = (user = {}) => isConfiguredSuperAdmin(user);

const accessList = (user = {}) =>
	Array.isArray(user.accessTo)
		? user.accessTo.map((item) => String(item || "").trim()).filter(Boolean)
		: [];

const hasAnyAccess = (user = {}, keys = []) => {
	const granted = accessList(user);
	return keys.some((key) => granted.includes(key));
};

const isSystemAdmin = (user = {}) =>
	hasRole(user, 10000) ||
	hasRoleKey(user, "systemadmin") ||
	hasRoleKey(user, "system admin");

const isOwnerAccount = (user = {}) =>
	hasRole(user, 2000) && !normalizeId(user.belongsToId);

const isHotelManager = (user = {}) =>
	hasRoleKey(user, "hotelmanager") ||
	(hasRole(user, 2000) && normalizeId(user.belongsToId));

const isFinanceUser = (user = {}) => hasRole(user, 6000) || hasRoleKey(user, "finance");

const isReservationUser = (user = {}) =>
	hasRole(user, 8000) || hasRoleKey(user, "reservationemployee");

const hasStaffOrAdminRole = (user = {}) =>
	isPlatformSuperAdmin(user) ||
	canSupportAssignedHotelChats(user) ||
	isSystemAdmin(user) ||
	isOwnerAccount(user) ||
	isHotelManager(user) ||
	isFinanceUser(user) ||
	isReservationUser(user) ||
	roleNumbers(user).some((role) => [3000, 4000, 5000].includes(role)) ||
	hasRoleKey(user, "reception") ||
	hasRoleKey(user, "housekeeping") ||
	hasRoleKey(user, "housekeepingmanager");

const isAgentUser = (user = {}) =>
	hasRole(user, 7000) ||
	hasRoleKey(user, "ordertaker") ||
	(Array.isArray(user.accessTo) &&
		user.accessTo.includes("ownReservations") &&
		!hasStaffOrAdminRole(user));

const isB2BAccount = (user = {}) => {
	if (
		isPlatformSuperAdmin(user) ||
		canSupportAssignedHotelChats(user) ||
		isSystemAdmin(user) ||
		isAgentUser(user)
	)
		return true;
	return roleNumbers(user).some((role) =>
		[2000, 3000, 4000, 5000, 6000, 8000, 10000].includes(role)
	);
};

const canInitiateAgentChat = (user = {}) =>
	isPlatformSuperAdmin(user) ||
	canSupportAssignedHotelChats(user) ||
	isOwnerAccount(user) ||
	isSystemAdmin(user) ||
	isHotelManager(user) ||
	isFinanceUser(user) ||
	isReservationUser(user);

const canManageHotelChats = (user = {}) =>
	isPlatformSuperAdmin(user) ||
	canSupportAssignedHotelChats(user) ||
	isOwnerAccount(user) ||
	isSystemAdmin(user);

const assignedHotelIdsFromUser = (user = {}) =>
	validIds([
		user.hotelIdWork,
		...(Array.isArray(user.hotelIdsWork) ? user.hotelIdsWork : []),
		...(Array.isArray(user.hotelsToSupport) ? user.hotelsToSupport : []),
		...(Array.isArray(user.hotelIdsOwner) ? user.hotelIdsOwner : []),
	]);

const canSupportAssignedHotelChats = (user = {}) =>
	hasRole(user, 1000) &&
	!isPlatformSuperAdmin(user) &&
	assignedHotelIdsFromUser(user).length > 0 &&
	hasAnyAccess(user, ["CustomerService", "HotelsReservations", "AllReservations"]);

const intersectIds = (left = [], right = []) => {
	const rightSet = new Set(right.map(String));
	return uniqueIds(left).filter((id) => rightSet.has(String(id)));
};

const cleanText = (value = "", max = 8000) =>
	String(value || "")
		.replace(/\u0000/g, "")
		.trim()
		.slice(0, max);

const getShortCache = (cache, key) => {
	const entry = cache.get(key);
	if (!entry) return null;
	if (entry.expiresAt <= Date.now()) {
		cache.delete(key);
		return null;
	}
	return entry.value;
};

const setShortCache = (cache, key, value, ttlMs, maxEntries) => {
	if (cache.size >= maxEntries) {
		const firstKey = cache.keys().next().value;
		if (firstKey) cache.delete(firstKey);
	}
	cache.set(key, { value, expiresAt: Date.now() + ttlMs });
};

const cleanChatDisplayName = (value = "") =>
	cleanText(value, 80).replace(/\s+/g, " ");

const messageSenderNameForActor = (actor = {}, requestedName = "") => {
	if (isPlatformSuperAdmin(actor)) {
		const alias = cleanChatDisplayName(requestedName);
		if (alias) return alias;
	}
	return cleanChatDisplayName(actor.name || actor.email || "Account") || "Account";
};

const ROLE_LABEL_BY_KEY = {
	systemadmin: "Hotel System Admin",
	hotelmanager: "Hotel Manager",
	reception: "Front Desk Reception",
	housekeepingmanager: "Housekeeping Manager",
	housekeeping: "Housekeeping",
	finance: "Finance",
	ordertaker: "Agent",
	reservationemployee: "Reservations Officer",
	superadmin: "Super Admin",
};

const ROLE_LABEL_BY_NUMBER = {
	1000: "Super Admin",
	10000: "Hotel System Admin",
	2000: "Hotel Manager",
	3000: "Front Desk Reception",
	4000: "Housekeeping Manager",
	5000: "Housekeeping",
	6000: "Finance",
	7000: "Agent",
	8000: "Reservations Officer",
};

const titleForUser = (user = {}) => {
	if (isPlatformSuperAdmin(user)) return "Super Admin";
	if (isSystemAdmin(user)) return "Hotel System Admin";
	if (isOwnerAccount(user)) return "Owner";
	if (isAgentUser(user)) return "Agent";
	const roleKey = roleDescriptionKeys(user).find((key) => ROLE_LABEL_BY_KEY[key]);
	if (roleKey) return ROLE_LABEL_BY_KEY[roleKey];
	const numericRole = Number(user.role || 0);
	return ROLE_LABEL_BY_NUMBER[numericRole] || "Staff";
};

const participantTypeForUser = (user = {}) => {
	if (isAgentUser(user)) return "agent";
	if (isPlatformSuperAdmin(user) || isSystemAdmin(user) || isOwnerAccount(user))
		return "admin";
	return "staff";
};

const loadHotelsByIds = async (hotelIds = []) => {
	const ids = validIds(hotelIds);
	if (!ids.length) return [];
	return HotelDetails.find({ _id: { $in: toObjectIds(ids) } })
		.select("_id hotelName belongsTo")
		.populate("belongsTo", "_id name email")
		.lean()
		.exec();
};

const hotelNameMapFromHotels = (hotels = []) => {
	const map = new Map();
	hotels.forEach((hotel) => {
		map.set(normalizeId(hotel._id), hotel.hotelName || "Hotel");
	});
	return map;
};

const loadActorHotelScope = async (actor = {}) => {
	if (isPlatformSuperAdmin(actor)) {
		const hotels = await HotelDetails.find({})
			.select("_id hotelName belongsTo")
			.populate("belongsTo", "_id name email")
			.lean()
			.exec();
		return {
			all: true,
			hotelIds: hotels.map((hotel) => normalizeId(hotel._id)).filter(Boolean),
			hotels,
		};
	}

	let hotelIds = assignedHotelIdsFromUser(actor);
	if (isSystemAdmin(actor)) {
		const ownerId = normalizeId(actor.belongsToId) || normalizeId(actor._id);
		const ownedHotels = ownerId
			? await HotelDetails.find({ belongsTo: ownerId })
					.select("_id hotelName belongsTo")
					.populate("belongsTo", "_id name email")
					.lean()
					.exec()
			: [];
		hotelIds = uniqueIds([
			...hotelIds,
			...ownedHotels.map((hotel) => normalizeId(hotel._id)),
		]);
		if (ownedHotels.length) return { all: false, hotelIds, hotels: ownedHotels };
	}
	if (isOwnerAccount(actor)) {
		const ownedHotels = await HotelDetails.find({ belongsTo: actor._id })
			.select("_id hotelName belongsTo")
			.populate("belongsTo", "_id name email")
			.lean()
			.exec();
		hotelIds = uniqueIds([
			...hotelIds,
			...ownedHotels.map((hotel) => normalizeId(hotel._id)),
		]);
		return { all: false, hotelIds, hotels: ownedHotels };
	}

	const hotels = await loadHotelsByIds(hotelIds);
	return { all: false, hotelIds, hotels };
};

const candidateHotelIds = (candidate = {}, scopeHotels = []) => {
	let hotelIds = assignedHotelIdsFromUser(candidate);
	if (isOwnerAccount(candidate)) {
		const ownedInScope = scopeHotels
			.filter((hotel) => normalizeId(hotel.belongsTo) === normalizeId(candidate._id))
			.map((hotel) => normalizeId(hotel._id));
		hotelIds = uniqueIds([...hotelIds, ...ownedInScope]);
	}
	return hotelIds;
};

const recipientAllowed = (actor = {}, candidate = {}) => {
	if (!isB2BAccount(candidate)) return false;
	if (normalizeId(actor._id) === normalizeId(candidate._id)) return false;
	if (isPlatformSuperAdmin(candidate) && !isPlatformSuperAdmin(actor)) {
		return false;
	}

	const actorIsAgent = isAgentUser(actor);
	const candidateIsAgent = isAgentUser(candidate);

	if (actorIsAgent) {
		return !candidateIsAgent && canInitiateAgentChat(candidate);
	}
	if (candidateIsAgent) {
		return canInitiateAgentChat(actor);
	}
	return true;
};

const buildRecipientQuery = (actor = {}, scope = {}) => {
	const base = {
		_id: { $ne: ObjectId(normalizeId(actor._id)) },
		activeUser: { $ne: false },
	};
	if (scope.all) return base;

	const hotelIds = validIds(scope.hotelIds);
	if (!hotelIds.length) return null;
	const hotelObjectIds = toObjectIds(hotelIds);
	const ownerIds = validIds(
		(scope.hotels || []).map((hotel) => normalizeId(hotel.belongsTo))
	);

	return {
		...base,
		$or: [
			{ hotelIdWork: { $in: hotelIds } },
			{ hotelIdsWork: { $in: hotelObjectIds } },
			{ hotelsToSupport: { $in: hotelObjectIds } },
			{ hotelIdsOwner: { $in: hotelObjectIds } },
			...(ownerIds.length ? [{ _id: { $in: toObjectIds(ownerIds) } }] : []),
		],
	};
};

const loadAllowedRecipients = async (actor = {}) => {
	const scope = await loadActorHotelScope(actor);
	const query = buildRecipientQuery(actor, scope);
	if (!query) return { recipients: [], scope };

	const candidates = await User.find(query)
		.select(CHAT_USER_SELECT)
		.populate("hotelIdsWork", "_id hotelName")
		.populate("hotelIdsOwner", "_id hotelName")
		.populate("hotelsToSupport", "_id hotelName")
		.lean()
		.exec();
	const hotelNameMap = hotelNameMapFromHotels(scope.hotels);

	const recipients = candidates
		.map((candidate) => {
			const rawHotelIds = candidateHotelIds(candidate, scope.hotels);
			const sharedHotelIds = scope.all
				? rawHotelIds
				: intersectIds(rawHotelIds, scope.hotelIds);
			if (!scope.all && !sharedHotelIds.length) return null;
			if (scope.all && !rawHotelIds.length && !isPlatformSuperAdmin(candidate)) {
				return null;
			}
			if (!recipientAllowed(actor, candidate)) return null;
			const hotelIds = scope.all ? rawHotelIds : sharedHotelIds;
			return {
				_id: normalizeId(candidate._id),
				name: candidate.name || candidate.companyName || candidate.email || "Account",
				email: candidate.email || "",
				companyName: candidate.companyName || "",
				role: Number(candidate.role || 0),
				roleDescription: candidate.roleDescription || "",
				type: participantTypeForUser(candidate),
				roleLabel: titleForUser(candidate),
				hotelIds,
				hotelNames: hotelIds.map((id) => hotelNameMap.get(id)).filter(Boolean),
			};
		})
		.filter(Boolean)
		.sort((a, b) => {
			if (a.type !== b.type) return a.type.localeCompare(b.type);
			return a.name.localeCompare(b.name);
		});

	return { recipients, scope };
};

const buildParticipantSnapshot = (user = {}, hotelIds = []) => ({
	userId: ObjectId(normalizeId(user._id)),
	name: user.name || user.companyName || user.email || "Account",
	email: user.email || "",
	role: Number(user.role || 0),
	roleDescription: user.roleDescription || "",
	participantType: participantTypeForUser(user),
	hotelIds: toObjectIds(hotelIds),
	lastSeenAt: null,
});

const participantIsTeamSide = (participant = {}) =>
	String(participant.participantType || "staff") !== "agent";

const chatHasAgentSide = (chat = {}) =>
	String(chat.scope || "").toLowerCase() === "agent" ||
	(chat.participants || []).some(
		(participant) => String(participant.participantType || "") === "agent"
	);

const participantTypeForChatUser = (chat = {}, userId = "") => {
	const normalizedUserId = normalizeId(userId);
	const participant = (chat.participants || []).find(
		(item) => normalizeId(item.userId) === normalizedUserId
	);
	return participant?.participantType || "";
};

const actorIsTeamSideForChat = (chat = {}, actor = {}) => {
	if (!chatHasAgentSide(chat)) return false;
	const actorId = normalizeId(actor._id || actor);
	if (!actorId) return false;
	const participantType = participantTypeForChatUser(chat, actorId);
	if (participantType) return participantType !== "agent";
	return !isAgentUser(actor);
};

const teamParticipantIdsForChat = (chat = {}) =>
	uniqueIds(
		(chat.participants || [])
			.filter(participantIsTeamSide)
			.map((participant) => normalizeId(participant.userId))
	);

const messageSenderIsTeamSide = (chat = {}, message = {}) => {
	const senderId = normalizeId(message.senderId);
	if (!senderId) return false;
	const participantType = participantTypeForChatUser(chat, senderId);
	if (participantType) return participantType !== "agent";
	const senderRole = normalizeRoleKey(message.senderRole || "");
	if (senderRole === "agent" || senderRole === "ordertaker") return false;
	return Boolean(senderRole);
};

const messageSeenByAnyTeamParticipant = (chat = {}, message = {}) => {
	const teamIds = new Set(teamParticipantIdsForChat(chat));
	if (!teamIds.size) return false;
	return (message.seenBy || []).some((item) =>
		teamIds.has(normalizeId(item.userId))
	);
};

const addSeenByUser = (message = {}, userId = "", seenAt = new Date()) => {
	const normalizedUserId = normalizeId(userId);
	if (!normalizedUserId) return;
	const exists = (message.seenBy || []).some(
		(item) => normalizeId(item.userId) === normalizedUserId
	);
	if (!exists) message.seenBy.push({ userId: normalizedUserId, seenAt });
};

const serializeMessage = (message = {}) => ({
	_id: normalizeId(message._id),
	senderId: normalizeId(message.senderId),
	senderName: message.senderName || "",
	senderRole: message.senderRole || "",
	body: message.body || "",
	attachments: Array.isArray(message.attachments) ? message.attachments : [],
	seenBy: (message.seenBy || []).map((item) => ({
		userId: normalizeId(item.userId),
		seenAt: item.seenAt,
	})),
	createdAt: message.createdAt,
});

const unreadCountForActor = (chat = {}, actor = {}) => {
	const actorId = normalizeId(actor._id || actor);
	if (!actorId) return 0;
	const actorIsTeamSide = actorIsTeamSideForChat(chat, actor);

	return (chat.messages || []).reduce((count, message) => {
		if (normalizeId(message.senderId) === actorId) return count;
		if (actorIsTeamSide) {
			if (messageSenderIsTeamSide(chat, message)) return count;
			return messageSeenByAnyTeamParticipant(chat, message) ? count : count + 1;
		}
		const seen = (message.seenBy || []).some(
			(item) => normalizeId(item.userId) === actorId
		);
		return seen ? count : count + 1;
	}, 0);
};

const serializeChat = (chat = {}, actor = {}, { includeMessages = false } = {}) => {
	const actorId = normalizeId(actor._id);
	const messages = Array.isArray(chat.messages) ? chat.messages : [];
	const last = messages[messages.length - 1];
	const base = {
		_id: normalizeId(chat._id),
		subject: chat.subject || "",
		scope: chat.scope || "internal",
		status: chat.status || "active",
		hotelIds: (chat.hotelIds || []).map(normalizeId).filter(Boolean),
		participantIds: (chat.participantIds || []).map(normalizeId).filter(Boolean),
		participants: (chat.participants || []).map((participant) => ({
			userId: normalizeId(participant.userId),
			name: participant.name || "",
			email: participant.email || "",
			role: participant.role || 0,
			roleDescription: participant.roleDescription || "",
			participantType: participant.participantType || "staff",
			hotelIds: (participant.hotelIds || []).map(normalizeId).filter(Boolean),
			lastSeenAt: participant.lastSeenAt,
		})),
		createdBy: normalizeId(chat.createdBy),
		createdAt: chat.createdAt,
		updatedAt: chat.updatedAt,
		lastActivityAt: chat.lastActivityAt,
		closedAt: chat.closedAt,
		closedBy: normalizeId(chat.closedBy),
		closedReason: chat.closedReason || "",
		unreadCount: actorId ? unreadCountForActor(chat, actor) : 0,
		lastMessage: last ? serializeMessage(last) : null,
		messageCount: messages.length,
	};
	if (includeMessages) {
		base.messages = messages.map(serializeMessage);
	}
	return base;
};

const canViewChat = async (actor = {}, chat = {}) => {
	const actorId = normalizeId(actor._id);
	const participantIds = (chat.participantIds || []).map(normalizeId);
	if (participantIds.includes(actorId)) return true;
	if (isPlatformSuperAdmin(actor)) return true;
	if (!canManageHotelChats(actor)) return false;

	const scope = await loadActorHotelScope(actor);
	if (scope.all) return true;
	const chatHotelIds = (chat.hotelIds || []).map(normalizeId);
	return intersectIds(scope.hotelIds, chatHotelIds).length > 0;
};

const visibleChatQueryForActor = async (actor = {}, status = "active") => {
	const query = { status };
	if (isPlatformSuperAdmin(actor)) return query;

	const actorId = ObjectId(normalizeId(actor._id));
	const visibility = [{ participantIds: actorId }];
	if (canManageHotelChats(actor)) {
		const scope = await loadActorHotelScope(actor);
		if (scope.hotelIds.length) {
			visibility.push({ hotelIds: { $in: toObjectIds(scope.hotelIds) } });
		}
	}
	return { ...query, $or: visibility };
};

const ensureActorParticipant = async (chat = {}, actor = {}) => {
	const actorId = normalizeId(actor._id);
	if (!actorId) return false;
	const participantIds = (chat.participantIds || []).map(normalizeId);
	if (participantIds.includes(actorId)) return false;
	const scope = await loadActorHotelScope(actor);
	const chatHotelIds = (chat.hotelIds || []).map(normalizeId);
	const sharedHotelIds = scope.all
		? chatHotelIds
		: intersectIds(scope.hotelIds, chatHotelIds);
	chat.participantIds.push(actor._id);
	chat.participants.push(buildParticipantSnapshot(actor, sharedHotelIds));
	return true;
};

const markSeenOnChat = (chat = {}, actor = {}) => {
	const actorId = normalizeId(actor._id);
	if (!actorId) return;
	const now = new Date();
	const seenUserIds = new Set([actorId]);
	if (actorIsTeamSideForChat(chat, actor)) {
		teamParticipantIdsForChat(chat).forEach((userId) => seenUserIds.add(userId));
	}
	(chat.participants || []).forEach((participant) => {
		if (seenUserIds.has(normalizeId(participant.userId))) {
			participant.lastSeenAt = now;
		}
	});
	(chat.messages || []).forEach((message) => {
		seenUserIds.forEach((userId) => addSeenByUser(message, userId, now));
	});
};

const sanitizeAttachments = (attachments = []) => {
	const list = Array.isArray(attachments) ? attachments : [];
	return list.slice(0, MAX_ATTACHMENT_COUNT).map((attachment) => {
		const type = cleanText(attachment.type || "", 160);
		const dataUrl = String(attachment.dataUrl || "").slice(
			0,
			MAX_ATTACHMENT_DATA_URL
		);
		return {
			name: cleanText(attachment.name || "attachment", 180) || "attachment",
			type,
			size: Math.max(0, Number(attachment.size || 0) || 0),
			kind: type.startsWith("image/") || dataUrl.startsWith("data:image/")
				? "image"
				: "file",
			dataUrl,
			uploadedAt: new Date(),
		};
	});
};

const emitChatUpdate = async (req, chat, event = "updated") => {
	const io = req.app && req.app.get("io");
	if (!io || !chat?._id) return;
	const payload = {
		event,
		chatId: normalizeId(chat._id),
		actorId: normalizeId(req?.profile?._id || req?.auth?._id),
		chat: serializeChat(chat, {}, { includeMessages: false }),
	};
	const rooms = new Set([`b2b-chat:${chat._id}`, "b2b-platform"]);
	(chat.participantIds || []).forEach((userId) => {
		rooms.add(`b2b-user:${normalizeId(userId)}`);
	});
	(chat.hotelIds || []).forEach((hotelId) => {
		rooms.add(`b2b-hotel:${normalizeId(hotelId)}`);
	});

	try {
		const hotels = await HotelDetails.find({
			_id: { $in: toObjectIds(chat.hotelIds || []) },
		})
			.select("belongsTo")
			.lean()
			.exec();
		hotels.forEach((hotel) => {
			const ownerId = normalizeId(hotel.belongsTo);
			if (ownerId) rooms.add(`b2b-user:${ownerId}`);
		});
	} catch (error) {
		// Socket delivery should stay best-effort; HTTP requests must not fail here.
	}

	let target = io;
	rooms.forEach((room) => {
		if (room) target = target.to(room);
	});
	target.emit("b2bChatUpdated", payload);
};

let inactiveChatCloseLastRunAt = 0;
let inactiveChatClosePromise = null;
const INACTIVE_CHAT_CLOSE_INTERVAL_MS = 10 * 60 * 1000;

const ensureInactiveChatsClosed = () => {
	const currentTime = Date.now();
	if (inactiveChatClosePromise) return inactiveChatClosePromise;
	if (currentTime - inactiveChatCloseLastRunAt < INACTIVE_CHAT_CLOSE_INTERVAL_MS) {
		return Promise.resolve({ closed: 0, skipped: true });
	}
	inactiveChatCloseLastRunAt = currentTime;
	inactiveChatClosePromise = B2BChat.closeInactiveChats({
		inactiveMs: CHAT_TIMEOUT_MS,
	}).finally(() => {
		inactiveChatClosePromise = null;
	});
	return inactiveChatClosePromise;
};

exports.b2bChatRecipients = async (req, res) => {
	try {
		await ensureInactiveChatsClosed();
		const { recipients } = await loadAllowedRecipients(req.profile);
		return res.json({ recipients });
	} catch (error) {
		console.error("b2bChatRecipients error:", error);
		return res.status(500).json({ error: "Could not load chat recipients" });
	}
};

exports.b2bChatList = async (req, res) => {
	try {
		await ensureInactiveChatsClosed();
		const actor = req.profile;
		const status =
			String(req.query?.status || "active").toLowerCase() === "closed"
				? "closed"
				: "active";
		const query = await visibleChatQueryForActor(actor, status);

		const chats = await B2BChat.find(query)
			.sort({ lastActivityAt: -1, updatedAt: -1 })
			.limit(200)
			.exec();

		return res.json({
			chats: chats.map((chat) => serializeChat(chat, actor)),
		});
	} catch (error) {
		console.error("b2bChatList error:", error);
		return res.status(500).json({ error: "Could not load chats" });
	}
};

exports.b2bChatUnreadSummary = async (req, res) => {
	try {
		const actor = req.profile;
		const cacheKey =
			normalizeId(req.params.userId) ||
			normalizeId(req.auth?._id) ||
			normalizeId(actor?._id);
		const cached = getShortCache(b2bUnreadSummaryCache, cacheKey);
		if (cached) return res.json(cached);

		await ensureInactiveChatsClosed();
		const query = await visibleChatQueryForActor(actor, "active");
		const actorObjectId = ObjectId(normalizeId(actor._id));

		const chats = await B2BChat.aggregate([
			{ $match: query },
			{
				$addFields: {
					teamIds: {
						$map: {
							input: {
								$filter: {
									input: { $ifNull: ["$participants", []] },
									as: "participant",
									cond: {
										$ne: [
											{
												$ifNull: [
													"$$participant.participantType",
													"staff",
												],
											},
											"agent",
										],
									},
								},
							},
							as: "participant",
							in: "$$participant.userId",
						},
					},
				},
			},
			{
				$project: {
					scope: 1,
					participants: 1,
					directUnreadCount: {
						$size: {
							$filter: {
								input: { $ifNull: ["$messages", []] },
								as: "message",
								cond: {
									$and: [
										{ $ne: ["$$message.senderId", actorObjectId] },
										{
											$not: [
												{
													$in: [
														actorObjectId,
														{
															$map: {
																input: {
																	$ifNull: [
																		"$$message.seenBy",
																		[],
																	],
																},
																as: "seen",
																in: "$$seen.userId",
															},
														},
													],
												},
											],
										},
									],
								},
							},
						},
					},
					teamUnreadCount: {
						$size: {
							$filter: {
								input: { $ifNull: ["$messages", []] },
								as: "message",
								cond: {
									$and: [
										{ $not: [{ $in: ["$$message.senderId", "$teamIds"] }] },
										{
											$eq: [
												{
													$size: {
														$setIntersection: [
															"$teamIds",
															{
																$map: {
																	input: {
																		$ifNull: [
																			"$$message.seenBy",
																			[],
																		],
																	},
																	as: "seen",
																	in: "$$seen.userId",
																},
															},
														],
													},
												},
												0,
											],
										},
									],
								},
							},
						},
					},
				},
			},
		]).exec();

		let unreadMessages = 0;
		let unreadChats = 0;
		chats.forEach((chat) => {
			const count = actorIsTeamSideForChat(chat, actor)
				? Number(chat.teamUnreadCount || 0)
				: Number(chat.directUnreadCount || 0);
			if (count > 0) {
				unreadChats += 1;
				unreadMessages += count;
			}
		});

		const payload = {
			unreadChats,
			unreadMessages,
			activeChats: chats.length,
		};
		setShortCache(
			b2bUnreadSummaryCache,
			cacheKey,
			payload,
			B2B_UNREAD_CACHE_TTL_MS,
			B2B_UNREAD_CACHE_MAX
		);
		return res.json(payload);
	} catch (error) {
		console.error("b2bChatUnreadSummary error:", error);
		return res.status(500).json({ error: "Could not load chat notifications" });
	}
};

exports.b2bChatRead = async (req, res) => {
	try {
		await ensureInactiveChatsClosed();
		const chat = await B2BChat.findById(req.params.chatId).exec();
		if (!chat) return res.status(404).json({ error: "Chat not found" });
		if (!(await canViewChat(req.profile, chat))) {
			return res.status(403).json({ error: "You cannot view this chat" });
		}
		return res.json({ chat: serializeChat(chat, req.profile, { includeMessages: true }) });
	} catch (error) {
		console.error("b2bChatRead error:", error);
		return res.status(500).json({ error: "Could not load chat" });
	}
};

exports.b2bChatStart = async (req, res) => {
	try {
		await ensureInactiveChatsClosed();
		const actor = req.profile;
		const requestedIds = validIds(req.body?.participantIds || req.body?.recipientIds || []);
		if (!requestedIds.length) {
			return res.status(400).json({ error: "Please choose at least one recipient" });
		}

		const { recipients, scope } = await loadAllowedRecipients(actor);
		const allowedMap = new Map(recipients.map((recipient) => [recipient._id, recipient]));
		const blocked = requestedIds.filter((id) => !allowedMap.has(id));
		if (blocked.length) {
			return res.status(403).json({ error: "One or more recipients are not allowed" });
		}

		const participantIds = uniqueIds([normalizeId(actor._id), ...requestedIds]);
		const recipientUsers = await User.find({ _id: { $in: toObjectIds(requestedIds) } })
			.select(CHAT_USER_SELECT)
			.lean()
			.exec();
		const userById = new Map(
			[actor.toObject ? actor.toObject() : actor, ...recipientUsers].map((user) => [
				normalizeId(user._id),
				user,
			])
		);
		const recipientHotelIds = requestedIds.flatMap(
			(id) => allowedMap.get(id)?.hotelIds || []
		);
		const actorHotelIds = scope.all ? recipientHotelIds : scope.hotelIds;
		let chatHotelIds = scope.all
			? uniqueIds(recipientHotelIds)
			: intersectIds(actorHotelIds, recipientHotelIds);
		if (!chatHotelIds.length && scope.all) chatHotelIds = uniqueIds(recipientHotelIds);
		if (!chatHotelIds.length && !isPlatformSuperAdmin(actor)) {
			return res.status(400).json({ error: "No shared hotel was found for this chat" });
		}

		const existing = await B2BChat.findOne({
			status: "active",
			participantIds: { $all: toObjectIds(participantIds), $size: participantIds.length },
		}).exec();
		if (existing) {
			return res.json({
				chat: serializeChat(existing, actor, { includeMessages: true }),
				reused: true,
			});
		}

		const participants = participantIds.map((id) => {
			const user = userById.get(id) || {};
			const recipient = allowedMap.get(id);
			const hotelIds =
				id === normalizeId(actor._id)
					? chatHotelIds
					: intersectIds(recipient?.hotelIds || assignedHotelIdsFromUser(user), chatHotelIds);
			return buildParticipantSnapshot(user, hotelIds.length ? hotelIds : chatHotelIds);
		});
		const hasAgent = participants.some((participant) => participant.participantType === "agent");
		const chat = await B2BChat.create({
			subject: cleanText(req.body?.subject || "", 140),
			scope: hasAgent ? "agent" : "internal",
			status: "active",
			hotelIds: toObjectIds(chatHotelIds),
			participantIds: toObjectIds(participantIds),
			participants,
			createdBy: actor._id,
			lastActivityAt: new Date(),
		});

		await emitChatUpdate(req, chat, "created");
		return res.status(201).json({
			chat: serializeChat(chat, actor, { includeMessages: true }),
		});
	} catch (error) {
		console.error("b2bChatStart error:", error);
		return res.status(500).json({ error: "Could not start chat" });
	}
};

exports.b2bChatSendMessage = async (req, res) => {
	try {
		await ensureInactiveChatsClosed();
		const actor = req.profile;
		const chat = await B2BChat.findById(req.params.chatId).exec();
		if (!chat) return res.status(404).json({ error: "Chat not found" });
		if (chat.status !== "active") {
			return res.status(400).json({ error: "This chat is already closed" });
		}
		if (!(await canViewChat(actor, chat))) {
			return res.status(403).json({ error: "You cannot send to this chat" });
		}

		const body = cleanText(req.body?.body || req.body?.message || "", 8000);
		const attachments = sanitizeAttachments(req.body?.attachments || []);
		if (!body && !attachments.length) {
			return res.status(400).json({ error: "Please write a message or attach a file" });
		}

		await ensureActorParticipant(chat, actor);

		const message = {
			senderId: actor._id,
			senderName: messageSenderNameForActor(
				actor,
				req.body?.chatDisplayName || req.body?.senderName || ""
			),
			senderRole: titleForUser(actor),
			body,
			attachments,
			seenBy: [{ userId: actor._id, seenAt: new Date() }],
			createdAt: new Date(),
		};
		chat.messages.push(message);
		chat.lastActivityAt = new Date();
		markSeenOnChat(chat, actor);
		await chat.save();
		await emitChatUpdate(req, chat, "message");

		return res.json({ chat: serializeChat(chat, actor, { includeMessages: true }) });
	} catch (error) {
		console.error("b2bChatSendMessage error:", error);
		return res.status(500).json({ error: "Could not send message" });
	}
};

exports.b2bChatMarkSeen = async (req, res) => {
	try {
		await ensureInactiveChatsClosed();
		const chat = await B2BChat.findById(req.params.chatId).exec();
		if (!chat) return res.status(404).json({ error: "Chat not found" });
		if (!(await canViewChat(req.profile, chat))) {
			return res.status(403).json({ error: "You cannot view this chat" });
		}
		await ensureActorParticipant(chat, req.profile);
		if (unreadCountForActor(chat, req.profile) <= 0) {
			return res.json({ chat: serializeChat(chat, req.profile, { includeMessages: true }) });
		}
		markSeenOnChat(chat, req.profile);
		await chat.save();
		await emitChatUpdate(req, chat, "seen");
		return res.json({ chat: serializeChat(chat, req.profile, { includeMessages: true }) });
	} catch (error) {
		console.error("b2bChatMarkSeen error:", error);
		return res.status(500).json({ error: "Could not mark chat as seen" });
	}
};

exports.b2bChatClose = async (req, res) => {
	try {
		const chat = await B2BChat.findById(req.params.chatId).exec();
		if (!chat) return res.status(404).json({ error: "Chat not found" });
		if (!(await canViewChat(req.profile, chat))) {
			return res.status(403).json({ error: "You cannot close this chat" });
		}
		if (chat.status !== "closed") {
			markSeenOnChat(chat, req.profile);
			chat.status = "closed";
			chat.closedAt = new Date();
			chat.closedBy = req.profile._id;
			chat.closedReason = cleanText(req.body?.reason || "manual", 120);
			await chat.save();
			await emitChatUpdate(req, chat, "closed");
		}
		return res.json({ chat: serializeChat(chat, req.profile, { includeMessages: true }) });
	} catch (error) {
		console.error("b2bChatClose error:", error);
		return res.status(500).json({ error: "Could not close chat" });
	}
};
