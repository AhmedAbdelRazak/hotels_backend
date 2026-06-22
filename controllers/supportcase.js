const SupportCase = require("../models/supportcase");
const mongoose = require("mongoose");
const ObjectId = mongoose.Types.ObjectId;
const sgMail = require("@sendgrid/mail");
const { newSupportCaseEmail } = require("./assets");
const HotelDetails = require("../models/hotel_details");
const User = require("../models/user");
const {
	DEFAULT_JANNAT_SUPPORT_HOTEL_ID,
	isJannatBookingSupportCase,
} = require("../services/jannatBookingSupportScope");
const { schedulePlanTurn } = require("../aiagent/core/orchestrator");

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const twilio = require("twilio");

const supportCaseEmail = twilio(
	process.env.TWILIO_ACCOUNT_SID,
	process.env.TWILIO_AUTH_TOKEN
);

const normalizeId = (value) => String(value?._id || value?.id || value || "").trim();
const SUPPORT_CASE_HOTEL_POPULATE =
	"_id hotelName hotelName_OtherLanguage hotelCity city state country belongsTo aiToRespond distances isNusuk isNusukText";
const SUPPORT_CASE_LIST_CONVERSATION_LIMIT = 60;

const isAiAgentEnabled = () =>
	String(process.env.AI_AGENT_ENABLED || "").toLowerCase() === "true";

function scheduleAiTurnForCase(io, supportCaseOrId, { delayMs = 100 } = {}) {
	if (!isAiAgentEnabled() || !io || typeof schedulePlanTurn !== "function") {
		return;
	}
	schedulePlanTurn(io, supportCaseOrId, { delayMs });
}

const configuredSuperAdminIds = () =>
	[process.env.SUPER_ADMIN_ID, process.env.REACT_APP_SUPER_ADMIN_ID]
		.flatMap((value) => String(value || "").split(","))
		.map((id) => id.trim())
		.filter(Boolean);

const isConfiguredSuperAdmin = (user = {}) =>
	configuredSuperAdminIds().includes(normalizeId(user._id || user));

const assignedHotelIdsFromUser = (user = {}) =>
	[
		user.hotelIdWork,
		...(Array.isArray(user.hotelIdsWork) ? user.hotelIdsWork : []),
		...(Array.isArray(user.hotelsToSupport) ? user.hotelsToSupport : []),
		...(Array.isArray(user.hotelIdsOwner) ? user.hotelIdsOwner : []),
	]
		.map(normalizeId)
		.filter((id, index, arr) => id && arr.indexOf(id) === index);

const SUPPORT_CHAT_ROLES = [2000, 3000, 4000, 5000, 6000, 8000, 10000];
const SUPPORT_CHAT_ROLE_KEYS = new Set([
	"hotelmanager",
	"systemadmin",
	"system admin",
	"reception",
	"housekeepingmanager",
	"housekeeping",
	"finance",
	"reservationemployee",
]);

const userRoleNumbers = (user = {}) => [
	Number(user.role),
	...(Array.isArray(user.roles) ? user.roles.map(Number) : []),
];

const userRoleKeys = (user = {}) =>
	[
		String(user.roleDescription || "").toLowerCase(),
		...(Array.isArray(user.roleDescriptions)
			? user.roleDescriptions.map((item) => String(item || "").toLowerCase())
			: []),
	].map((item) => item.replace(/[\s_-]+/g, ""));

const isSupportChatUser = (user = {}) => {
	if (!user || user.activeUser === false || isConfiguredSuperAdmin(user)) return false;
	const roleMatch = userRoleNumbers(user).some((role) =>
		SUPPORT_CHAT_ROLES.includes(role)
	);
	const roleKeyMatch = userRoleKeys(user).some((key) =>
		SUPPORT_CHAT_ROLE_KEYS.has(key)
	);
	return roleMatch || roleKeyMatch;
};

const supportRecipientScopeHotelIds = (actor = {}) => {
	if (!actor || isConfiguredSuperAdmin(actor)) return null;
	return assignedHotelIdsFromUser(actor).filter((id) => ObjectId.isValid(id));
};

const supportChatRoleLabel = (user = {}) => {
	const roles = userRoleNumbers(user);
	const keys = userRoleKeys(user);
	if (roles.includes(10000) || keys.includes("systemadmin")) return "Hotel System Admin";
	if (roles.includes(2000) || keys.includes("hotelmanager")) {
		return normalizeId(user.belongsToId) ? "Hotel Manager" : "Hotel Owner";
	}
	if (roles.includes(3000) || keys.includes("reception")) return "Reception";
	if (roles.includes(4000) || keys.includes("housekeepingmanager")) {
		return "Housekeeping Manager";
	}
	if (roles.includes(5000) || keys.includes("housekeeping")) return "Housekeeping";
	if (roles.includes(6000) || keys.includes("finance")) return "Finance";
	if (roles.includes(8000) || keys.includes("reservationemployee")) {
		return "Reservations Officer";
	}
	return "Hotel Staff";
};

const objectIdList = (ids = []) =>
	ids.filter((id) => ObjectId.isValid(id)).map((id) => ObjectId(id));

const supportCaseScopeFilter = (req = {}) => {
	const actor = req.profile;
	if (!actor || isConfiguredSuperAdmin(actor)) return {};
	const hotelIds = assignedHotelIdsFromUser(actor).filter((id) =>
		ObjectId.isValid(id)
	);
	const visibility = [{ supporterId: ObjectId(actor._id) }];
	if (hotelIds.length) {
		visibility.push({ hotelId: { $in: hotelIds.map((id) => ObjectId(id)) } });
	}
	return { $or: visibility };
};

const withSupportCaseScope = (req, baseFilter = {}) => {
	const scopeFilter = supportCaseScopeFilter(req);
	if (!Object.keys(scopeFilter).length) return baseFilter;
	return { $and: [baseFilter, scopeFilter] };
};

const parsePaginationQuery = (query = {}) => {
	const page = Math.max(parseInt(query.page, 10) || 1, 1);
	const limit = Math.min(Math.max(parseInt(query.limit, 10) || 20, 1), 100);
	return { page, limit, skip: (page - 1) * limit };
};

const canSeeSupportCase = (req, supportCase = {}) => {
	const scopeFilter = supportCaseScopeFilter(req);
	if (!Object.keys(scopeFilter).length) return true;
	const actorId = normalizeId(req.profile?._id);
	if (normalizeId(supportCase.supporterId) === actorId) return true;
	const actorHotelIds = new Set(assignedHotelIdsFromUser(req.profile));
	return actorHotelIds.has(normalizeId(supportCase.hotelId));
};

const cleanText = (value = "", max = 8000) =>
	String(value || "")
		.replace(/\u0000/g, "")
		.trim()
		.slice(0, max);

const LOCALIZED_DIGIT_RANGES = [
	[0x0660, 0x0669],
	[0x06f0, 0x06f9],
	[0x0966, 0x096f],
	[0x09e6, 0x09ef],
	[0x0ae6, 0x0aef],
	[0x0be6, 0x0bef],
	[0x0c66, 0x0c6f],
	[0x0ce6, 0x0cef],
	[0x0d66, 0x0d6f],
	[0x0e50, 0x0e59],
	[0x0ed0, 0x0ed9],
	[0xff10, 0xff19],
];

const normalizeLocalizedDigits = (value = "") =>
	Array.from(String(value || ""))
		.map((char) => {
			const code = char.codePointAt(0);
			const range = LOCALIZED_DIGIT_RANGES.find(
				([start, end]) => code >= start && code <= end
			);
			return range ? String(code - range[0]) : char;
		})
		.join("");

const normalizeEmailOrPhone = (value = "") => {
	const normalized = cleanText(normalizeLocalizedDigits(value), 180);
	if (!normalized) return "";
	if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
		return normalized.toLowerCase();
	}
	return normalized.replace(/[^\d+]/g, "");
};

const cleanChatDisplayName = (value = "") =>
	cleanText(value, 80).replace(/\s+/g, " ");

const hasCorruptedEncoding = (value = "") =>
	/\uFFFD|\?{3,}/.test(String(value || ""));

const validateReadableTextFields = (res, fields = {}) => {
	const badField = Object.entries(fields).find(([, value]) =>
		hasCorruptedEncoding(value)
	);
	if (!badField) return true;
	res.status(400).json({
		error:
			"Unreadable text was received. Please resend the message using UTF-8 text.",
		field: badField[0],
	});
	return false;
};

const parseBooleanFlag = (value) =>
	value === true || value === "true" || value === 1 || value === "1";

const ESCALATION_STATUSES = new Set(["none", "active", "addressed"]);

const actorObjectId = (actor = {}) => {
	const id = normalizeId(actor._id);
	return ObjectId.isValid(id) ? ObjectId(id) : null;
};

const DEFAULT_B2C_AI_RESPONDER_NAMES = [
	"Aisha",
	"Hana",
	"Sara",
	"Amira",
	"Yasmin",
	"Nadia",
];
const AI_SUPPORT_MESSAGE_EMAILS = [
	"support@jannatbooking.com",
	"management@xhotelpro.com",
];
const SYSTEM_SUPPORT_CONTACTS = new Set([
	...AI_SUPPORT_MESSAGE_EMAILS,
	"noreply@jannatbooking.com",
	"guest@jannatbooking.com",
]);

const DEFAULT_JANNAT_SUPPORTER_ID = "6553f1c6d06c5cea2f98a838";
const contactFormRateLimit = new Map();
const CONTACT_FORM_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const CONTACT_FORM_RATE_LIMIT_MAX = 6;

const configuredJannatSupporterId = () =>
	String(
		process.env.JANNAT_BOOKING_SUPPORTER_ID ||
			process.env.JANNAT_SUPPORTER_ID ||
			process.env.REACT_APP_JANNAT_BOOKING_SUPPORTER_ID ||
			DEFAULT_JANNAT_SUPPORTER_ID
	).trim();

const requestIpKey = (req = {}) =>
	String(req.headers?.["x-forwarded-for"] || req.ip || req.connection?.remoteAddress || "")
		.split(",")[0]
		.trim()
		.slice(0, 80);

const consumeContactFormRateLimit = (req = {}) => {
	const key = requestIpKey(req);
	if (!key) return true;
	const now = Date.now();
	const record = contactFormRateLimit.get(key) || { count: 0, resetAt: now + CONTACT_FORM_RATE_LIMIT_WINDOW_MS };
	if (record.resetAt <= now) {
		contactFormRateLimit.set(key, { count: 1, resetAt: now + CONTACT_FORM_RATE_LIMIT_WINDOW_MS });
		return true;
	}
	if (record.count >= CONTACT_FORM_RATE_LIMIT_MAX) return false;
	record.count += 1;
	contactFormRateLimit.set(key, record);
	return true;
};

const formatContactInquiryDetails = ({
	message,
	email,
	phone,
	preferredContact,
	reservationReference,
	hotelName,
	sourceUrl,
	languageName,
	languageCode,
}) =>
	[
		`[Source: Jannat Booking contact page]`,
		languageName || languageCode
			? `[Preferred Language: ${languageName || ""}${languageCode ? ` (${languageCode})` : ""}]`
			: "",
		email ? `[Email: ${email}]` : "",
		phone ? `[Phone: ${phone}]` : "",
		preferredContact ? `[Preferred Contact: ${preferredContact}]` : "",
		reservationReference ? `[Reservation Reference: ${reservationReference}]` : "",
		hotelName ? `[Hotel / Destination: ${hotelName}]` : "",
		sourceUrl ? `[Page URL: ${sourceUrl}]` : "",
		"",
		message,
	]
		.filter((line) => line !== "")
		.join("\n");

const clientContactType = (contact = "") => {
	const normalized = normalizeEmailOrPhone(contact);
	if (!normalized) return "";
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ? "email" : "phone";
};

const isSystemSupportContact = (contact = "") =>
	SYSTEM_SUPPORT_CONTACTS.has(String(contact || "").toLowerCase());

const isGuestConversationEntry = (entry = {}) => {
	if (!entry || entry.isSystem || entry.isAi) return false;
	const contact = normalizeEmailOrPhone(entry.messageBy?.customerEmail);
	if (!contact || isSystemSupportContact(contact)) return false;
	if (entry.seenByCustomer === true && entry.seenByAdmin !== true) return true;
	return !normalizeId(entry.messageBy?.userId) && !entry.seenByAdmin;
};

const firstCaseInquiry = (supportCase = {}) => {
	const firstWithInquiry = Array.isArray(supportCase.conversation)
		? supportCase.conversation.find((entry) => cleanText(entry?.inquiryAbout, 120))
		: null;
	return (
		cleanText(supportCase.inquiryAbout, 120) ||
		cleanText(firstWithInquiry?.inquiryAbout, 120) ||
		""
	);
};

const clientIdentityFromCase = (supportCase = {}) => {
	const guestEntry = Array.isArray(supportCase.conversation)
		? supportCase.conversation.find(isGuestConversationEntry)
		: null;
	const contact =
		normalizeEmailOrPhone(supportCase.clientContact) ||
		normalizeEmailOrPhone(guestEntry?.messageBy?.customerEmail);
	const name =
		cleanChatDisplayName(supportCase.clientName) ||
		cleanChatDisplayName(guestEntry?.messageBy?.customerName) ||
		cleanChatDisplayName(supportCase.displayName1) ||
		"Guest";

	return {
		name,
		contact,
		contactType: clientContactType(contact),
		topic: firstCaseInquiry(supportCase),
	};
};

const sameClientCaseFilter = (req, contact = "") => {
	const normalizedContact = normalizeEmailOrPhone(contact);
	if (!normalizedContact) return null;
	return withSupportCaseScope(req, {
		openedBy: "client",
		$or: [
			{ clientContact: normalizedContact },
			{
				conversation: {
					$elemMatch: {
						"messageBy.customerEmail": normalizedContact,
						isSystem: { $ne: true },
						isAi: { $ne: true },
						seenByCustomer: true,
					},
				},
			},
		],
	});
};

const enrichClientSupportCases = async (cases = [], req = {}) => {
	const plainCases = cases.map((supportCase) =>
		typeof supportCase?.toObject === "function"
			? supportCase.toObject()
			: supportCase
	);
	const identities = plainCases.map(clientIdentityFromCase);
	const uniqueContacts = [
		...new Set(identities.map((identity) => identity.contact).filter(Boolean)),
	];
	const contactCounts = new Map();

	await Promise.all(
		uniqueContacts.map(async (contact) => {
			const filter = sameClientCaseFilter(req, contact);
			const total = filter ? await SupportCase.countDocuments(filter) : 0;
			contactCounts.set(contact, total);
		})
	);

	return plainCases.map((supportCase, index) => {
		const identity = identities[index] || {};
		const totalChatsWithSameContact = identity.contact
			? contactCounts.get(identity.contact) || 1
			: 1;
		return {
			...supportCase,
			caseTopic: identity.topic,
			caseSubject: identity.topic,
			clientProfile: {
				name: identity.name || "Guest",
				contact: identity.contact || "",
				contactType: identity.contactType || "",
				totalChatsWithSameContact,
				otherChatsWithSameContact: Math.max(totalChatsWithSameContact - 1, 0),
			},
		};
	});
};

const uniqueResponderNames = (names = []) => [
	...new Set(
		names
			.map((name) => cleanChatDisplayName(name))
			.filter(Boolean)
	),
];

const configuredB2CAiResponderNames = () => {
	const configured = uniqueResponderNames(
		[process.env.B2C_AI_RESPONDER_NAMES, process.env.AI_RESPONDER_NAMES]
			.flatMap((value) => String(value || "").split(","))
	);
	return configured.length >= 2
		? configured
		: uniqueResponderNames(DEFAULT_B2C_AI_RESPONDER_NAMES);
};

const hashText = (value = "") =>
	String(value || "")
		.split("")
		.reduce((acc, char) => (acc * 31 + char.charCodeAt(0)) % 1000003, 7);

const pickB2CAiResponderName = async ({
	customerName,
	customerEmail,
	hotelId,
	hotelName,
	preferredLanguage,
} = {}) => {
	const responderNames = configuredB2CAiResponderNames();
	if (responderNames.length === 1) return responderNames[0];

	const filter = {
		openedBy: "client",
		aiRelated: true,
		aiResponderName: { $in: responderNames },
	};
	if (hotelId && ObjectId.isValid(normalizeId(hotelId))) {
		filter.hotelId = ObjectId(normalizeId(hotelId));
	}
	const latestCase = await SupportCase.findOne(filter)
		.sort({ createdAt: -1, _id: -1 })
		.select("aiResponderName")
		.lean();
	const latestIndex = responderNames.indexOf(latestCase?.aiResponderName);
	if (latestIndex >= 0) {
		return responderNames[(latestIndex + 1) % responderNames.length];
	}

	const seed = [customerName, customerEmail, hotelId, hotelName, preferredLanguage]
		.map((part) => String(part || ""))
		.join("|");
	return responderNames[hashText(seed) % responderNames.length];
};

const isClientSupportCase = (supportCase = {}) => supportCase.openedBy === "client";

const adminUnseenClientMessageMatch = (actorId = "") => {
	const normalizedActorId = normalizeId(actorId);
	const excludedSenders = ["jannat-ai-support"];
	if (normalizedActorId) {
		excludedSenders.push(normalizedActorId);
		if (ObjectId.isValid(normalizedActorId)) {
			excludedSenders.push(ObjectId(normalizedActorId));
		}
	}

	return {
		"conversation.seenByAdmin": false,
		"conversation.isAi": { $ne: true },
		"conversation.isSystem": { $ne: true },
		"conversation.messageBy.customerEmail": {
			$nin: AI_SUPPORT_MESSAGE_EMAILS,
		},
		"conversation.messageBy.userId": { $nin: excludedSenders },
	};
};

const isAdminUnreadClientMessage = (entry = {}, actorId = "") => {
	if (!entry || entry.seenByAdmin) return false;
	if (entry.isAi || entry.isSystem) return false;
	const contact = normalizeEmailOrPhone(entry.messageBy?.customerEmail).toLowerCase();
	if (AI_SUPPORT_MESSAGE_EMAILS.includes(contact)) return false;
	const senderId = normalizeId(entry.messageBy?.userId);
	if (senderId === "jannat-ai-support") return false;
	const normalizedActorId = normalizeId(actorId);
	if (senderId && normalizedActorId && senderId === normalizedActorId) return false;
	return true;
};

const compactConversationEntryForList = (entry = {}) => ({
	_id: entry._id,
	messageBy: {
		customerName: cleanChatDisplayName(entry.messageBy?.customerName),
		customerEmail: cleanText(entry.messageBy?.customerEmail, 180),
		userId: cleanText(entry.messageBy?.userId, 180),
	},
	message: cleanText(entry.message, 1200),
	date: entry.date,
	inquiryAbout: cleanText(entry.inquiryAbout, 120),
	inquiryDetails: cleanText(entry.inquiryDetails, 1200),
	seenByAdmin: entry.seenByAdmin,
	seenByHotel: entry.seenByHotel,
	seenByCustomer: entry.seenByCustomer,
	isAi: entry.isAi,
	isSystem: entry.isSystem,
	clientTag: cleanText(entry.clientTag, 120),
	clientAction: cleanText(entry.clientAction, 60),
	preferredLanguage: cleanText(entry.preferredLanguage, 80),
	preferredLanguageCode: cleanText(entry.preferredLanguageCode, 20),
	quickReplies: Array.isArray(entry.quickReplies)
		? entry.quickReplies.slice(0, 6).map((reply) => ({
				label: cleanText(reply?.label, 80),
				value: cleanText(reply?.value, 240),
				action: cleanText(reply?.action, 60),
		  }))
		: [],
});

const compactConversationForList = (conversation = []) => {
	const entries = Array.isArray(conversation) ? conversation : [];
	const selectedEntries = [
		...(entries[0] ? [entries[0]] : []),
		...entries.slice(-SUPPORT_CASE_LIST_CONVERSATION_LIMIT),
	];
	const seenKeys = new Set();
	return selectedEntries
		.filter((entry, index) => {
			const key = normalizeId(entry?._id) || `${entry?.date || ""}-${index}`;
			if (seenKeys.has(key)) return false;
			seenKeys.add(key);
			return true;
		})
		.map(compactConversationEntryForList);
};

const latestConversationDate = (conversation = [], fallback = null) => {
	const entries = Array.isArray(conversation) ? conversation : [];
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		if (entries[index]?.date) return entries[index].date;
	}
	return fallback;
};

const compactClientSupportCaseForList = (supportCase = {}, req = {}) => {
	const conversation = Array.isArray(supportCase.conversation)
		? supportCase.conversation
		: [];
	const compactConversation = compactConversationForList(conversation);
	const adminUnreadCount = conversation.filter((entry) =>
		isAdminUnreadClientMessage(entry, req.profile?._id || req.user?._id)
	).length;
	return {
		...supportCase,
		conversation: compactConversation,
		conversationCount: conversation.length,
		conversationPreview:
			compactConversation[compactConversation.length - 1] || null,
		latestConversationAt: latestConversationDate(
			conversation,
			supportCase.updatedAt || supportCase.createdAt
		),
		adminUnreadCount,
		isConversationPreview: conversation.length > compactConversation.length,
	};
};

const compactClientSupportCasesForList = (cases = [], req = {}) =>
	cases.map((supportCase) => compactClientSupportCaseForList(supportCase, req));

const isAiForceRespondEnabled = () =>
	String(process.env.AI_FORCE_RESPOND || "").toLowerCase() === "true";

const localizedClientHoldMessage = (language = "", languageCode = "") => {
	const lang = `${language} ${languageCode}`.toLowerCase();
	if (lang.includes("arabic") || /\bar\b/.test(lang)) {
		return "\u0641\u0631\u064a\u0642 Jannat Booking \u064a\u0631\u0627\u062c\u0639 \u0631\u0633\u0627\u0644\u062a\u0643 \u0627\u0644\u0622\u0646.";
	}
	if (lang.includes("hindi") || /\bhi\b/.test(lang)) {
		return "\u091c\u0928\u094d\u0928\u0924 \u092c\u0941\u0915\u093f\u0902\u0917 \u0938\u092a\u094b\u0930\u094d\u091f \u0906\u092a\u0915\u093e \u0938\u0902\u0926\u0947\u0936 \u0905\u092d\u0940 \u0926\u0947\u0916 \u0930\u0939\u093e \u0939\u0948.";
	}
	return "Jannat Booking support is reviewing your message now.";
};

const buildPublicClientConversation = (conversation = {}, supportCase = {}) => {
	if (!conversation || typeof conversation !== "object") return null;
	const conversationEntries = Array.isArray(supportCase.conversation)
		? supportCase.conversation
		: [];
	const firstGuestMessage = conversationEntries.find(isGuestConversationEntry) || {};
	const rawMessageBy = conversation.messageBy || {};
	const message = cleanText(conversation.message, 8000);
	if (!message) return null;

	return {
		messageBy: {
			customerName:
				cleanChatDisplayName(
					rawMessageBy.customerName ||
						supportCase.displayName1 ||
						firstGuestMessage.messageBy?.customerName
				) || "Guest",
			customerEmail:
				normalizeEmailOrPhone(
					rawMessageBy.customerEmail ||
						supportCase.clientContact ||
						firstGuestMessage.messageBy?.customerEmail
				) || "guest@jannatbooking.com",
			userId: cleanText(rawMessageBy.userId, 180),
		},
		message,
		date: new Date(),
		inquiryAbout:
			cleanText(conversation.inquiryAbout || firstGuestMessage.inquiryAbout, 120) ||
			"support",
		inquiryDetails: cleanText(
			conversation.inquiryDetails || firstGuestMessage.inquiryDetails,
			1200
		),
		clientTag: cleanText(conversation.clientTag, 120),
		clientAction: cleanText(conversation.clientAction, 60),
		preferredLanguage:
			cleanText(conversation.preferredLanguage || supportCase.preferredLanguage, 80) ||
			"English",
		preferredLanguageCode:
			cleanText(
				conversation.preferredLanguageCode || supportCase.preferredLanguageCode,
				20
			) || "en",
		seenByAdmin: false,
		seenByHotel: false,
		seenByCustomer: true,
	};
};

const enforceConversationSenderName = (conversation = {}, actor = {}) => {
	if (!conversation || typeof conversation !== "object") return conversation;
	const nextConversation = { ...conversation };
	const messageBy = { ...(conversation.messageBy || {}) };
	const isActorMessage =
		normalizeId(messageBy.userId) && normalizeId(messageBy.userId) === normalizeId(actor._id);

	if (isActorMessage) {
		const actorFallback =
			cleanChatDisplayName(actor.name || actor.email || "Account") || "Account";
		messageBy.customerName = isConfiguredSuperAdmin(actor)
			? cleanChatDisplayName(messageBy.customerName) || actorFallback
			: actorFallback;
	}

	if (messageBy.customerName) {
		messageBy.customerName = cleanChatDisplayName(messageBy.customerName);
	}
	if (messageBy.customerEmail) {
		messageBy.customerEmail = cleanText(messageBy.customerEmail, 180);
	}

	nextConversation.messageBy = messageBy;
	return nextConversation;
};

exports.getSupportChatRecipients = async (req, res) => {
	try {
		const scopedHotelIds = supportRecipientScopeHotelIds(req.profile);
		if (Array.isArray(scopedHotelIds) && !scopedHotelIds.length) {
			return res.json({ recipients: [] });
		}

		const scopedHotelObjectIds = Array.isArray(scopedHotelIds)
			? objectIdList(scopedHotelIds)
			: [];
		const hotelScopeQuery = Array.isArray(scopedHotelIds)
			? { _id: { $in: scopedHotelObjectIds } }
			: {};

		const hotels = await HotelDetails.find(hotelScopeQuery)
			.select("_id hotelName hotelName_OtherLanguage belongsTo")
			.lean()
			.exec();
		const hotelsById = new Map(hotels.map((hotel) => [normalizeId(hotel._id), hotel]));
		const ownedHotelIdsByOwner = new Map();
		hotels.forEach((hotel) => {
			const ownerId = normalizeId(hotel.belongsTo);
			if (!ownerId) return;
			if (!ownedHotelIdsByOwner.has(ownerId)) ownedHotelIdsByOwner.set(ownerId, []);
			ownedHotelIdsByOwner.get(ownerId).push(normalizeId(hotel._id));
		});

		const scopedOwnerIds = [...ownedHotelIdsByOwner.keys()].filter((id) =>
			ObjectId.isValid(id)
		);
		const hotelRelationFilter = Array.isArray(scopedHotelIds)
			? {
					$or: [
						{ hotelIdWork: { $in: scopedHotelIds } },
						{ hotelIdsWork: { $in: scopedHotelObjectIds } },
						{ hotelsToSupport: { $in: scopedHotelObjectIds } },
						{ hotelIdsOwner: { $in: scopedHotelObjectIds } },
						...(scopedOwnerIds.length
							? [{ _id: { $in: objectIdList(scopedOwnerIds) } }]
							: []),
					],
			  }
			: {};

		const users = await User.find({
			...hotelRelationFilter,
			activeUser: { $ne: false },
			_id: {
				$nin: objectIdList(configuredSuperAdminIds()),
				...(req.profile?._id ? { $ne: ObjectId(req.profile._id) } : {}),
			},
			$or: [
				{ role: { $in: SUPPORT_CHAT_ROLES } },
				{ roles: { $in: SUPPORT_CHAT_ROLES } },
				{ roleDescription: { $in: [...SUPPORT_CHAT_ROLE_KEYS] } },
				{ roleDescriptions: { $in: [...SUPPORT_CHAT_ROLE_KEYS] } },
			],
		})
			.select(
				"_id name email companyName role roles roleDescription roleDescriptions activeUser hotelIdWork hotelIdsWork hotelsToSupport hotelIdsOwner belongsToId"
			)
			.lean()
			.exec();

		const recipients = users
			.filter(isSupportChatUser)
			.map((user) => {
				const ownedHotelIds = ownedHotelIdsByOwner.get(normalizeId(user._id)) || [];
				const directHotelIds = assignedHotelIdsFromUser(user);
				const hotelIds = [
					...new Set([...ownedHotelIds, ...directHotelIds]),
				].filter((id) => hotelsById.has(id));
				if (!hotelIds.length) return null;
				const recipientHotels = hotelIds.map((id) => {
					const hotel = hotelsById.get(id);
					return {
						_id: normalizeId(hotel._id),
						hotelName: hotel.hotelName || hotel.hotelName_OtherLanguage || "Hotel",
						hotelName_OtherLanguage: hotel.hotelName_OtherLanguage || "",
						belongsTo: normalizeId(hotel.belongsTo),
					};
				});
				return {
					_id: normalizeId(user._id),
					name: user.name || user.companyName || user.email || "Hotel user",
					email: user.email || "",
					companyName: user.companyName || "",
					role: Number(user.role || 0),
					roleDescription: user.roleDescription || "",
					roleLabel: supportChatRoleLabel(user),
					hotels: recipientHotels,
					hotelIds: recipientHotels.map((hotel) => hotel._id),
				};
			})
			.filter(Boolean)
			.sort((a, b) => {
				if (a.roleLabel !== b.roleLabel) return a.roleLabel.localeCompare(b.roleLabel);
				return a.name.localeCompare(b.name);
			});

		return res.json({ recipients });
	} catch (error) {
		console.error("getSupportChatRecipients error:", error);
		return res.status(500).json({ error: "Could not load support chat recipients" });
	}
};

// Get all support cases
exports.getSupportCases = async (req, res) => {
	try {
		const userId = req.user._id;
		const role = req.user.role;

		let cases;
		if (role === "SuperAdmin") {
			cases = await SupportCase.find()
				.populate("supporterId")
				.populate("conversation.messageBy")
				.populate("participants.user");
		} else {
			cases = await SupportCase.find({
				"participants.user": userId,
			})
				.populate("supporterId")
				.populate("conversation.messageBy")
				.populate("participants.user");
		}

		res.status(200).json(cases);
	} catch (error) {
		res.status(400).json({ error: error.message });
	}
};

// Get a specific support case by ID
exports.getSupportCaseById = async (req, res) => {
	try {
		// Find the support case by ID without attempting to populate 'messageBy'
		const supportCase = await SupportCase.findById(req.params.id)
			.populate("supporterId") // Only populate fields that reference another model
			.populate("hotelId", SUPPORT_CASE_HOTEL_POPULATE);

		if (!supportCase) {
			console.log("Support case not found:", req.params.id);
			return res.status(404).json({ error: "Support case not found" });
		}
		if (!canSeeSupportCase(req, supportCase)) {
			return res.status(403).json({ error: "Support case access denied" });
		}

		res.status(200).json(supportCase);
	} catch (error) {
		console.error("Error fetching support case:", error);
		res.status(400).json({ error: error.message });
	}
};

// Update a support case by ID
exports.updateSupportCase = async (req, res) => {
	try {
		const {
			supporterId,
			caseStatus,
			conversation,
			closedBy,
			rating,
			supporterName,
			hotelId,
			aiToRespond,
			inquiryAbout,
			inquiryDetails,
			escalationStatus,
			escalationReason,
			escalationSource,
			escalationAddressedNote,
		} = req.body;

		console.log(req.body, "req.body");
		if (
			!validateReadableTextFields(res, {
				inquiryAbout,
				inquiryDetails,
				supporterName,
				conversationMessage: conversation?.message,
				conversationSender: conversation?.messageBy?.customerName,
			})
		) {
			return;
		}

		const currentCase = await SupportCase.findById(req.params.id).lean();
		if (!currentCase) {
			return res.status(404).json({ error: "Support case not found" });
		}
		if (!canSeeSupportCase(req, currentCase)) {
			return res.status(403).json({ error: "Support case access denied" });
		}

		const setFields = {};
		if (supporterId) setFields.supporterId = supporterId;
		if (caseStatus) {
			setFields.caseStatus = caseStatus;
			if (caseStatus === "closed") {
				setFields.closedAt = new Date();
				if (isClientSupportCase(currentCase)) {
					setFields.aiToRespond = false;
					setFields.aiPausedAt = new Date();
					setFields.aiHandoffReason = "case_closed";
					if (currentCase.escalationStatus === "active") {
						setFields.escalationStatus = "addressed";
						setFields.escalationAddressedAt = new Date();
						setFields.escalationAddressedBy = actorObjectId(req.profile);
						setFields.escalationAddressedNote = "Case closed";
					}
				}
			}
			if (caseStatus === "open") setFields.closedAt = null;
		}
		if (closedBy) setFields.closedBy = closedBy;
		if (rating) setFields.rating = rating;
		if (supporterName) setFields.supporterName = supporterName;
		if (hotelId) setFields.hotelId = hotelId;
		if (Object.prototype.hasOwnProperty.call(req.body, "escalationStatus")) {
			if (!isClientSupportCase(currentCase)) {
				return res
					.status(400)
					.json({ error: "Escalation status can only be used on B2C cases" });
			}
			const nextEscalationStatus = cleanText(escalationStatus, 40).toLowerCase();
			if (!ESCALATION_STATUSES.has(nextEscalationStatus)) {
				return res.status(400).json({ error: "Invalid escalation status" });
			}
			const nowDate = new Date();
			const cleanReason =
				cleanText(escalationReason || currentCase.aiHandoffReason, 240) ||
				"human_review_needed";
			setFields.escalationStatus = nextEscalationStatus;

			if (nextEscalationStatus === "active") {
				setFields.escalationReason = cleanReason;
				setFields.escalationSource =
					cleanText(escalationSource, 30) || "admin";
				setFields.escalatedAt = nowDate;
				setFields.escalatedBy = actorObjectId(req.profile);
				setFields.escalationAddressedAt = null;
				setFields.escalationAddressedBy = null;
				setFields.escalationAddressedNote = "";
				setFields.aiToRespond = false;
				setFields.aiPausedAt = nowDate;
				setFields.aiHandoffReason = cleanReason;
			}

			if (nextEscalationStatus === "addressed") {
				setFields.escalationAddressedAt = nowDate;
				setFields.escalationAddressedBy = actorObjectId(req.profile);
				setFields.escalationAddressedNote = cleanText(
					escalationAddressedNote,
					500
				);
			}

			if (nextEscalationStatus === "none") {
				setFields.escalationReason = "";
				setFields.escalationSource = "";
				setFields.escalatedAt = null;
				setFields.escalatedBy = null;
				setFields.escalationAddressedAt = null;
				setFields.escalationAddressedBy = null;
				setFields.escalationAddressedNote = "";
			}
		}
		if (Object.prototype.hasOwnProperty.call(req.body, "aiToRespond")) {
			if (!isClientSupportCase(currentCase)) {
				return res
					.status(400)
					.json({ error: "AI responder can only be controlled on B2C cases" });
			}
			const nextAiToRespond = parseBooleanFlag(aiToRespond);
			setFields.aiToRespond = nextAiToRespond;
			setFields.aiPausedAt = nextAiToRespond ? null : new Date();
			setFields.aiHandoffReason = nextAiToRespond ? "" : "manual_admin_toggle";
			if (nextAiToRespond) {
				setFields.escalationStatus = "none";
				setFields.escalationReason = "";
				setFields.escalationSource = "";
				setFields.escalatedAt = null;
				setFields.escalatedBy = null;
				setFields.escalationAddressedAt = null;
				setFields.escalationAddressedBy = null;
				setFields.escalationAddressedNote = "";
			}
		}
		setFields.updatedAt = new Date();

		if (!conversation && Object.keys(setFields).length === 1) {
			return res
				.status(400)
				.json({ error: "No valid fields provided for update" });
		}

		const safeConversation = conversation
			? enforceConversationSenderName(conversation, req.profile)
			: null;
		const actorId = normalizeId(req.profile?._id);
		const actorSentMessage =
			safeConversation &&
			actorId &&
			normalizeId(safeConversation.messageBy?.userId) === actorId;
		if (actorSentMessage && isClientSupportCase(currentCase)) {
			setFields.aiToRespond = false;
			setFields.aiPausedAt = new Date();
			setFields.aiHandoffReason = "human_admin_message";
			setFields.humanTakeoverAt = new Date();
			setFields.humanTakeoverBy = req.profile._id;
		}

		const updateDoc = safeConversation
			? {
					$set: setFields,
					$unset: { aiRecoveryScheduledAt: "" },
					$push: { conversation: safeConversation },
			  }
			: { $set: setFields };

		const updatedCase = await SupportCase.findByIdAndUpdate(req.params.id, updateDoc, {
			new: true,
		});

		if (!updatedCase) {
			return res.status(404).json({ error: "Support case not found" });
		}

		if (caseStatus === "closed") {
			req.io.emit("closeCase", { case: updatedCase, closedBy });
		} else if (safeConversation) {
			req.io.emit("receiveMessage", updatedCase);
		}
		req.io.to(String(updatedCase._id)).emit("supportCaseUpdated", updatedCase);
		req.io.emit("supportCaseUpdated", updatedCase);
		const previousEscalationStatus = currentCase.escalationStatus || "none";
		const nextEscalationStatus = updatedCase.escalationStatus || "none";
		if (previousEscalationStatus !== nextEscalationStatus) {
			const escalationPayload = {
				case: updatedCase,
				caseId: String(updatedCase._id),
				escalationStatus: nextEscalationStatus,
			};
			if (nextEscalationStatus === "active") {
				req.io.emit("supportCaseEscalated", escalationPayload);
			}
			if (nextEscalationStatus === "addressed") {
				req.io.emit("supportCaseEscalationAddressed", escalationPayload);
			}
			req.io.emit("supportCaseEscalationUpdated", escalationPayload);
		}
		if (currentCase.aiToRespond && updatedCase.aiToRespond === false) {
			req.io.to(String(updatedCase._id)).emit("aiPaused", {
				caseId: String(updatedCase._id),
				reason: updatedCase.aiHandoffReason || "human_takeover",
				agentName:
					req.profile?.name || req.profile?.email || updatedCase.supporterName || "Jannat Booking",
			});
		}

		res.status(200).json(updatedCase);
	} catch (error) {
		console.log(error, "error");
		res.status(400).json({ error: error.message });
	}
};

exports.getPublicClientSupportCaseById = async (req, res) => {
	try {
		const supportCase = await SupportCase.findOne({
			_id: req.params.id,
			openedBy: "client",
		})
			.populate(
				"hotelId",
				"_id hotelName hotelName_OtherLanguage hotelCity city state country belongsTo aiToRespond distances isNusuk isNusukText"
			)
			.lean()
			.exec();

		if (!supportCase) {
			return res.status(404).json({ error: "Support case not found" });
		}

		res.status(200).json(supportCase);
	} catch (error) {
		console.error("Error fetching public client support case:", error);
		res.status(400).json({ error: error.message });
	}
};

exports.updatePublicClientSupportCase = async (req, res) => {
	try {
		const currentCase = await SupportCase.findOne({
			_id: req.params.id,
			openedBy: "client",
		}).lean();

		if (!currentCase) {
			return res.status(404).json({ error: "Support case not found" });
		}
		if (currentCase.caseStatus === "closed" && req.body.conversation) {
			return res.status(409).json({
				error: "This support case is closed. Please start a new chat.",
				code: "SUPPORT_CASE_CLOSED",
			});
		}

		const setFields = { updatedAt: new Date() };
		if (
			!validateReadableTextFields(res, {
				conversationMessage: req.body.conversation?.message,
				conversationSender: req.body.conversation?.messageBy?.customerName,
				conversationInquiryAbout: req.body.conversation?.inquiryAbout,
				conversationInquiryDetails: req.body.conversation?.inquiryDetails,
			})
		) {
			return;
		}
		const safeConversation = req.body.conversation
			? buildPublicClientConversation(req.body.conversation, currentCase)
			: null;
		if (safeConversation?.preferredLanguage) {
			setFields.preferredLanguage = safeConversation.preferredLanguage;
		}
		if (safeConversation?.preferredLanguageCode) {
			setFields.preferredLanguageCode = safeConversation.preferredLanguageCode;
		}
		if (safeConversation) {
			const safeContact = normalizeEmailOrPhone(
				safeConversation.messageBy?.customerEmail
			);
			if (safeContact && !isSystemSupportContact(safeContact)) {
				setFields.clientName =
					cleanChatDisplayName(safeConversation.messageBy?.customerName) ||
					currentCase.clientName ||
					currentCase.displayName1 ||
					"Guest";
				setFields.clientContact = safeContact;
				setFields.clientContactType = clientContactType(safeContact);
			}
		}

		if (req.body.caseStatus === "closed") {
			setFields.caseStatus = "closed";
			setFields.closedAt = new Date();
			setFields.closedBy = "client";
			setFields.aiToRespond = false;
			setFields.aiPausedAt = new Date();
			setFields.aiHandoffReason = "client_closed_case";
			if (currentCase.escalationStatus === "active") {
				setFields.escalationStatus = "addressed";
				setFields.escalationAddressedAt = new Date();
				setFields.escalationAddressedBy = null;
				setFields.escalationAddressedNote = "Client closed case";
			}
		}

		if (Object.prototype.hasOwnProperty.call(req.body, "rating")) {
			const rating = Number(req.body.rating);
			if (Number.isFinite(rating) && rating >= 1 && rating <= 5) {
				setFields.rating = rating;
			}
		}

		if (!safeConversation && Object.keys(setFields).length === 1) {
			return res
				.status(400)
				.json({ error: "No valid fields provided for update" });
		}

		const unsetFields = {};
		if (safeConversation || req.body.caseStatus === "closed") {
			unsetFields.aiRecoveryScheduledAt = "";
		}
		const updateDoc = safeConversation
			? {
					$set: setFields,
					...(Object.keys(unsetFields).length ? { $unset: unsetFields } : {}),
					$push: { conversation: safeConversation },
			  }
			: {
					$set: setFields,
					...(Object.keys(unsetFields).length ? { $unset: unsetFields } : {}),
			  };

		const updatedCase = await SupportCase.findByIdAndUpdate(
			req.params.id,
			updateDoc,
			{ new: true }
		)
			.populate(
				"hotelId",
				"_id hotelName hotelName_OtherLanguage hotelCity city state country belongsTo aiToRespond distances isNusuk isNusukText"
			)
			.lean()
			.exec();

		if (!updatedCase) {
			return res.status(404).json({ error: "Support case not found" });
		}

		if (req.body.caseStatus === "closed") {
			req.io.emit("closeCase", { case: updatedCase, closedBy: "client" });
		} else if (safeConversation) {
			req.io.to(String(updatedCase._id)).emit("receiveMessage", {
				...safeConversation,
				caseId: String(updatedCase._id),
			});
		}
		if (currentCase.aiToRespond && updatedCase.aiToRespond === false) {
			req.io.to(String(updatedCase._id)).emit("aiPaused", {
				caseId: String(updatedCase._id),
				reason: updatedCase.aiHandoffReason || "client_closed_case",
			});
		}
		if (
			safeConversation &&
			updatedCase.aiToRespond !== false &&
			updatedCase.caseStatus !== "closed"
		) {
			scheduleAiTurnForCase(req.io, updatedCase._id, { delayMs: 100 });
		}

		res.status(200).json(updatedCase);
	} catch (error) {
		console.error("Error updating public client support case:", error);
		res.status(400).json({ error: error.message });
	}
};

// Create a new support case with specific fields
exports.createNewSupportCase = async (req, res) => {
	try {
		const {
			customerName,
			customerEmail,
			inquiryAbout,
			inquiryDetails,
			supporterId,
			ownerId,
			hotelId,
			role,
			displayName1, // Add displayName1 from the request
			displayName2, // Add displayName2 from the request
			supporterName,
			targetUserId,
			targetUserName,
			targetUserRole,
			preferredLanguage,
			preferredLanguageCode,
			supportScope,
			sourceWebsite,
			sourcePage,
			sourceUrl,
			initialClientMessage,
			initialClientTag,
		} = req.body;

		if (
			!validateReadableTextFields(res, {
				customerName,
				customerEmail,
				inquiryAbout,
				inquiryDetails,
				initialClientMessage,
				displayName1,
				displayName2,
				supporterName,
				targetUserName,
			})
		) {
			return;
		}

		// Basic validation
		if (
			!customerName ||
			!inquiryAbout ||
			!inquiryDetails ||
			!supporterId ||
			!ownerId ||
			!displayName1 || // Ensure displayName1 is provided
			!displayName2 // Ensure displayName2 is provided
		) {
			return res.status(400).json({ error: "All fields are required" });
		}
		const normalizedCustomerEmail = normalizeEmailOrPhone(customerEmail);

		// Determine who opened the case (super admin, hotel owner, or client)
		const openedBy =
			role === 1000
				? "super admin"
				: role === 2000 || role === 3000 || role === 7000
				? "hotel owner"
				: "client";

		let hotelName = "Unknown Hotel";
		let hotelDoc = null;
		if (hotelId && mongoose.Types.ObjectId.isValid(hotelId)) {
			hotelDoc = await HotelDetails.findById(hotelId).select(
				"hotelName aiToRespond"
			);
			if (hotelDoc && hotelDoc.hotelName) {
				hotelName = hotelDoc.hotelName;
			}
		}
		const isJannatSupportCase = isJannatBookingSupportCase(
			{
				hotelId,
				supportScope,
				displayName2,
				hotelName,
			},
			hotelDoc
		);
		const aiEnabledForClient =
			openedBy === "client" &&
			(isJannatSupportCase ||
				Boolean(hotelDoc?.aiToRespond) ||
				isAiForceRespondEnabled());
		const aiResponderName = aiEnabledForClient
			? await pickB2CAiResponderName({
					customerName,
					customerEmail: normalizedCustomerEmail || customerEmail,
					hotelId,
					hotelName,
					preferredLanguage,
			  })
			: "";

		// First conversation entry
		const conversation = [
			{
				messageBy:
					openedBy === "client"
						? {
								customerName: "Jannat Booking",
								customerEmail: "support@jannatbooking.com",
								userId: "jannat-system",
						  }
						: {
								customerName,
								customerEmail:
									normalizedCustomerEmail ||
									customerEmail ||
									"superadmin@example.com",
								userId:
									role === 1000
										? supporterId
										: role === 2000
										? ownerId
										: normalizedCustomerEmail || customerEmail,
						  },
				message:
					openedBy === "client"
						? localizedClientHoldMessage(
								preferredLanguage,
								preferredLanguageCode
						  )
						: `New support case created by ${
								openedBy === "super admin"
									? "Xhotelpro Administration"
									: openedBy
						  }`,
				inquiryAbout,
				inquiryDetails,
				seenByAdmin: openedBy === "client" ? true : role === 1000,
				seenByHotel: role === 2000,
				seenByCustomer: role === 0,
				isSystem: openedBy === "client",
				preferredLanguage: preferredLanguage || "English",
				preferredLanguageCode: preferredLanguageCode || "en",
			},
		];

		const cleanInitialClientMessage = cleanText(initialClientMessage, 8000);
		if (openedBy === "client" && cleanInitialClientMessage) {
			conversation.push({
				messageBy: {
					customerName: cleanChatDisplayName(customerName) || "Guest",
					customerEmail:
						normalizedCustomerEmail || customerEmail || "guest@jannatbooking.com",
					userId: normalizedCustomerEmail || customerEmail || "",
				},
				message: cleanInitialClientMessage,
				inquiryAbout,
				inquiryDetails,
				seenByAdmin: false,
				seenByHotel: false,
				seenByCustomer: true,
				clientTag: cleanText(initialClientTag, 120),
				preferredLanguage: preferredLanguage || "English",
				preferredLanguageCode: preferredLanguageCode || "en",
			});
		}

		// Build the support case doc
		const newCase = new SupportCase({
			supporterId,
			ownerId,
			hotelId,
			targetUserId: ObjectId.isValid(normalizeId(targetUserId))
				? ObjectId(normalizeId(targetUserId))
				: null,
			targetUserName: targetUserName || displayName2 || "",
			targetUserRole: targetUserRole || "",
			caseStatus: "open",
			openedBy, // Store who opened the case
			conversation,
			displayName1, // Store the display name of the case opener
			displayName2, // Store the display name of the receiver
			supporterName,
			clientName: cleanChatDisplayName(customerName),
			clientContact: normalizedCustomerEmail || "",
			clientContactType: clientContactType(normalizedCustomerEmail),
			preferredLanguage: preferredLanguage || "English",
			preferredLanguageCode: preferredLanguageCode || "en",
			supportScope: isJannatSupportCase ? "jannat_booking" : "hotel",
			sourceWebsite: cleanText(sourceWebsite || req.body.supportOrigin || "", 80),
			sourcePage: cleanText(sourcePage || "", 240),
			sourceUrl: cleanText(sourceUrl || "", 500),
			aiToRespond: aiEnabledForClient,
			aiResponderName,
			aiRelated: aiEnabledForClient,
		});

		// Save to DB
		await newCase.save();

		// Emit Socket.IO event for new chat
		req.io.emit("newChat", newCase);
		if (aiEnabledForClient) {
			scheduleAiTurnForCase(req.io, newCase._id, { delayMs: 150 });
		}

		// 2) Generate the HTML from your email template
		const emailHtml = newSupportCaseEmail(newCase, hotelName);

		// 3) Send email as a best-effort notification only. The chat case is
		// already saved, so provider/network issues must not make clients retry.
		try {
			await sgMail.send({
				from: "noreply@jannatbooking.com",
				to: [
					"morazzakhamouda@gmail.com",
					"xhoteleg@gmail.com",
					"ahmed.abdelrazak@jannatbooking.com",
					"support@jannatbooking.com",
				],
				subject: `New Support Case | ${hotelName}`,
				html: emailHtml,
			});
		} catch (emailError) {
			console.error(
				"Support case email notification failed:",
				emailError?.message || emailError
			);
		}

		// Finally, respond with the new case
		return res.status(201).json(newCase);
	} catch (error) {
		console.error("Error creating support case:", error);
		return res.status(400).json({ error: error.message });
	}
};

exports.createContactSupportCase = async (req, res) => {
	try {
		const {
			fullName,
			name,
			email,
			phone,
			preferredContact,
			inquiryAbout,
			message,
			reservationReference,
			hotelName,
			language,
			languageCode,
			sourceUrl,
			website,
		} = req.body || {};

		if (cleanText(website, 240)) {
			return res.status(200).json({ success: true });
		}

		if (!consumeContactFormRateLimit(req)) {
			return res.status(429).json({
				error: "Too many contact requests. Please wait a few minutes and try again.",
			});
		}

		const customerName = cleanChatDisplayName(fullName || name);
		const cleanEmail = cleanText(email, 180).toLowerCase();
		const cleanPhone = normalizeEmailOrPhone(phone);
		const contactValue = cleanEmail || cleanPhone;
		const cleanMessage = cleanText(message, 5000);
		const topic = cleanText(inquiryAbout || "general_support", 80);
		const preferredLanguageCode = cleanText(languageCode, 10) || "en";
		const preferredLanguage =
			cleanText(language, 40) || (preferredLanguageCode === "ar" ? "Arabic" : "English");

		if (!validateReadableTextFields(res, {
			customerName,
			cleanEmail,
			cleanPhone,
			topic,
			cleanMessage,
			reservationReference,
			hotelName,
		})) {
			return;
		}

		if (!customerName || !contactValue || !cleanMessage) {
			return res.status(400).json({
				error: "Please add your name, email or phone, and message.",
			});
		}

		if (cleanEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
			return res.status(400).json({ error: "Please add a valid email address." });
		}

		if (!cleanEmail && cleanPhone.replace(/[^\d]/g, "").length < 7) {
			return res.status(400).json({ error: "Please add a valid phone number." });
		}

		const supportId = configuredJannatSupporterId();
		const supportHotelId =
			cleanText(process.env.JANNAT_BOOKING_SUPPORT_HOTEL_ID, 80) ||
			DEFAULT_JANNAT_SUPPORT_HOTEL_ID;
		const cleanReservationReference = cleanText(reservationReference, 80);
		const cleanHotelName = cleanText(hotelName, 160);
		const cleanPreferredContact = cleanText(preferredContact, 40);
		const details = formatContactInquiryDetails({
			message: cleanMessage,
			email: cleanEmail,
			phone: cleanPhone,
			preferredContact: cleanPreferredContact,
			reservationReference: cleanReservationReference,
			hotelName: cleanHotelName,
			sourceUrl: cleanText(sourceUrl, 500),
			languageName: preferredLanguage,
			languageCode: preferredLanguageCode,
		});

		req.body = {
			customerName,
			customerEmail: contactValue,
			inquiryAbout: topic,
			inquiryDetails: details,
			initialClientMessage: cleanMessage,
			initialClientTag: `contact-form-${Date.now()}`,
			supporterId: supportId,
			ownerId: supportId,
			hotelId: supportHotelId,
			role: 0,
			displayName1: customerName,
			displayName2: "Jannat Booking",
			supporterName: "Jannat Booking Support",
			targetUserId: supportId,
			targetUserName: "Jannat Booking Support",
			targetUserRole: "CustomerService",
			preferredLanguage,
			preferredLanguageCode,
			supportScope: "jannat_booking",
			sourceWebsite: "jannatbooking_ssr",
			sourcePage: "contact_page",
			sourceUrl: cleanText(sourceUrl, 500),
		};

		return exports.createNewSupportCase(req, res);
	} catch (error) {
		console.error("Error creating contact support case:", error);
		return res.status(400).json({ error: error.message });
	}
};

exports.getUnassignedSupportCases = async (req, res) => {
	try {
		const cases = await SupportCase.find({ supporterId: null });
		res.status(200).json(cases);
	} catch (error) {
		res.status(400).json({ error: error.message });
	}
};

exports.getUnassignedSupportCasesCount = async (req, res) => {
	try {
		const count = await SupportCase.countDocuments({ supporterId: null });
		res.status(200).json({ count });
	} catch (error) {
		console.log(error);
		res.status(400).json({ error: error.message });
	}
};

exports.getOpenSupportCases = async (req, res) => {
	try {
		const cases = await SupportCase.find(withSupportCaseScope(req, {
			caseStatus: "open",
			openedBy: { $in: ["super admin", "hotel owner"] }, // Adjusting for case sensitivity
		}))
			.populate("supporterId")
			.populate("hotelId", SUPPORT_CASE_HOTEL_POPULATE);

		res.status(200).json(cases);
	} catch (error) {
		res.status(400).json({ error: error.message });
	}
};

exports.getOpenSupportCasesForHotel = async (req, res) => {
	try {
		const { hotelId } = req.params;
		console.log(hotelId, "hotelId");

		// Validate that hotelId is a valid ObjectId
		if (!mongoose.Types.ObjectId.isValid(hotelId)) {
			return res.status(400).json({ error: "Invalid hotel ID" });
		}

		// Find open support cases for the specified hotel
		const cases = await SupportCase.find({
			caseStatus: "open",
			openedBy: { $in: ["super admin", "hotel owner"] }, // Adjusting for case sensitivity
			hotelId: mongoose.Types.ObjectId(hotelId), // Ensure hotelId is treated as ObjectId
		})
			.populate("supporterId")
			.populate("hotelId", SUPPORT_CASE_HOTEL_POPULATE);

		// Return the cases in the response
		res.status(200).json(cases);
	} catch (error) {
		// Handle any errors that occur during the query
		res.status(400).json({ error: error.message });
	}
};

exports.getOpenSupportCasesClients = async (req, res) => {
	try {
		const cases = await SupportCase.find(withSupportCaseScope(req, {
			caseStatus: "open",
			openedBy: { $in: ["client"] }, // Client-related cases only
		}))
			.populate("supporterId")
			.populate("hotelId", SUPPORT_CASE_HOTEL_POPULATE)
			.lean()
			.exec();
		const enrichedCases = await enrichClientSupportCases(cases, req);
		res.status(200).json(compactClientSupportCasesForList(enrichedCases, req));
	} catch (error) {
		res.status(400).json({ error: error.message });
	}
};

exports.getEscalatedSupportCasesClients = async (req, res) => {
	try {
		const cases = await SupportCase.find(withSupportCaseScope(req, {
			caseStatus: "open",
			openedBy: { $in: ["client"] },
			escalationStatus: "active",
		}))
			.sort({ escalatedAt: -1, updatedAt: -1, createdAt: -1, _id: -1 })
			.populate("supporterId")
			.populate("hotelId", SUPPORT_CASE_HOTEL_POPULATE)
			.lean()
			.exec();
		const enrichedCases = await enrichClientSupportCases(cases, req);
		res.status(200).json(compactClientSupportCasesForList(enrichedCases, req));
	} catch (error) {
		res.status(400).json({ error: error.message });
	}
};

exports.getCloseSupportCases = async (req, res) => {
	try {
		const cases = await SupportCase.find(withSupportCaseScope(req, {
			caseStatus: "closed",
			openedBy: { $in: ["super admin", "hotel owner"] }, // Adjusting for case sensitivity
		}))
			.populate("supporterId")
			.populate("hotelId", SUPPORT_CASE_HOTEL_POPULATE);

		res.status(200).json(cases);
	} catch (error) {
		res.status(400).json({ error: error.message });
	}
};

exports.getCloseSupportCasesForHotel = async (req, res) => {
	try {
		const { hotelId } = req.params;

		// Validate that hotelId is a valid ObjectId
		if (!mongoose.Types.ObjectId.isValid(hotelId)) {
			return res.status(400).json({ error: "Invalid hotel ID" });
		}

		// Find open support cases for the specified hotel
		const cases = await SupportCase.find({
			caseStatus: "closed",
			openedBy: { $in: ["super admin", "hotel owner"] }, // Adjusting for case sensitivity
			hotelId: mongoose.Types.ObjectId(hotelId), // Ensure hotelId is treated as ObjectId
		})
			.populate("supporterId")
			.populate("hotelId", SUPPORT_CASE_HOTEL_POPULATE)
			.lean()
			.exec();

		// Return the cases in the response
		res.status(200).json(await enrichClientSupportCases(cases, req));
	} catch (error) {
		// Handle any errors that occur during the query
		res.status(400).json({ error: error.message });
	}
};

exports.getCloseSupportCasesForHotelClients = async (req, res) => {
	try {
		const { hotelId } = req.params;

		// Validate that hotelId is a valid ObjectId
		if (!mongoose.Types.ObjectId.isValid(hotelId)) {
			return res.status(400).json({ error: "Invalid hotel ID" });
		}

		// Find open support cases for the specified hotel
		const cases = await SupportCase.find({
			caseStatus: "closed",
			openedBy: { $in: ["client"] }, // Adjusting for case sensitivity
			hotelId: mongoose.Types.ObjectId(hotelId), // Ensure hotelId is treated as ObjectId
		})
			.populate("supporterId")
			.populate("hotelId", SUPPORT_CASE_HOTEL_POPULATE);

		// Return the cases in the response
		const enrichedCases = await enrichClientSupportCases(cases, req);
		res.status(200).json(compactClientSupportCasesForList(enrichedCases, req));
	} catch (error) {
		// Handle any errors that occur during the query
		res.status(400).json({ error: error.message });
	}
};

exports.getCloseSupportCasesClients = async (req, res) => {
	try {
		const { page, limit, skip } = parsePaginationQuery(req.query);
		const filter = withSupportCaseScope(req, {
			caseStatus: "closed",
			openedBy: { $in: ["client"] }, // Adjusting for case sensitivity
		});
		const [cases, total] = await Promise.all([
			SupportCase.find(filter)
				.sort({ closedAt: -1, updatedAt: -1, createdAt: -1, _id: -1 })
				.skip(skip)
				.limit(limit)
				.populate("supporterId")
				.populate("hotelId", SUPPORT_CASE_HOTEL_POPULATE)
				.lean()
				.exec(),
			SupportCase.countDocuments(filter),
		]);

		res.status(200).json({
			cases: compactClientSupportCasesForList(
				await enrichClientSupportCases(cases, req),
				req
			),
			page,
			limit,
			total,
			pages: Math.max(Math.ceil(total / limit), 1),
			sort: "newest",
		});
	} catch (error) {
		res.status(400).json({ error: error.message });
	}
};

//New seen and unseen logic

exports.getUnseenMessagesCountByAdmin = async (req, res) => {
	try {
		const { userId } = req.query;
		console.log("Received userId:", userId);

		// Count the unseen messages where the userId in messageBy does not match the current user
		const scopeFilter = supportCaseScopeFilter(req);
		const count = await SupportCase.aggregate([
			{
				$match: {
					...scopeFilter,
					caseStatus: { $ne: "closed" },
				},
			},
			{ $unwind: "$conversation" },
			{
				$match: adminUnseenClientMessageMatch(userId),
			},
			{ $count: "unseenCount" },
		]);

		console.log("Unseen messages count:", count);

		const unseenCount = count.length > 0 ? count[0].unseenCount : 0;
		res.status(200).json({ count: unseenCount });
	} catch (error) {
		console.error("Error fetching unseen messages count:", error);
		res.status(400).json({ error: error.message });
	}
};

exports.getSupportCaseNotificationSummary = async (req, res) => {
	try {
		const actorId = normalizeId(req.auth?._id || req.params.userId);
		if (!actorId || !ObjectId.isValid(actorId)) {
			return res.status(401).json({ error: "Valid user is required" });
		}
		const actor = req.profile;
		if (!actor || actor.activeUser === false) {
			return res.status(401).json({ error: "Valid active user is required" });
		}

		const scopeFilter = supportCaseScopeFilter(req);
		const scoped = (filter = {}) =>
			Object.keys(scopeFilter).length ? { $and: [filter, scopeFilter] } : filter;

		const unseenMessageMatch = adminUnseenClientMessageMatch(actorId);

		const [
			openCases,
			openClientCases,
			openHotelCases,
			activeEscalatedClientCases,
			unseenMessages,
			unseenCases,
		] = await Promise.all([
				SupportCase.countDocuments(scoped({ caseStatus: "open" })),
				SupportCase.countDocuments(
					scoped({ caseStatus: "open", openedBy: "client" })
				),
				SupportCase.countDocuments(
					scoped({
						caseStatus: "open",
						openedBy: { $in: ["super admin", "hotel owner"] },
					})
				),
				SupportCase.countDocuments(
					scoped({
						caseStatus: "open",
						openedBy: "client",
						escalationStatus: "active",
					})
				),
				SupportCase.aggregate([
					...(Object.keys(scopeFilter).length ? [{ $match: scopeFilter }] : []),
					{ $match: { caseStatus: { $ne: "closed" } } },
					{ $unwind: "$conversation" },
					{ $match: unseenMessageMatch },
					{ $count: "count" },
				]),
				SupportCase.aggregate([
					...(Object.keys(scopeFilter).length ? [{ $match: scopeFilter }] : []),
					{ $match: { caseStatus: { $ne: "closed" } } },
					{ $unwind: "$conversation" },
					{ $match: unseenMessageMatch },
					{ $group: { _id: "$_id" } },
					{ $count: "count" },
				]),
			]);

		return res.json({
			openCases,
			openClientCases,
			openHotelCases,
			activeEscalatedClientCases,
			unseenMessages: Number(unseenMessages?.[0]?.count || 0),
			unseenCases: Number(unseenCases?.[0]?.count || 0),
		});
	} catch (error) {
		console.error("getSupportCaseNotificationSummary error:", error);
		return res.status(500).json({ error: "Could not load support notifications" });
	}
};

// Fetch unseen messages by Hotel Owner
exports.getUnseenMessagesCountByHotelOwner = async (req, res) => {
	try {
		const { hotelId } = req.params; // Use req.params instead of req.query

		console.log("Received hotelId:", hotelId); // Log the hotelId for debugging

		// Validate that hotelId is a valid ObjectId
		if (!mongoose.Types.ObjectId.isValid(hotelId)) {
			return res.status(400).json({ error: "Invalid hotel ID" });
		}

		// Count the unseen messages for the hotel owner
		const count = await SupportCase.aggregate([
			{
				$match: {
					hotelId: mongoose.Types.ObjectId(hotelId),
					caseStatus: { $ne: "closed" },
				},
			},
			{ $unwind: "$conversation" },
			{
				$match: {
					"conversation.seenByHotel": false,
				},
			},
			{ $count: "unseenCount" },
		]);

		console.log("Unseen messages count for hotel owner:", count); // Log the count array

		const unseenCount = count.length > 0 ? count[0].unseenCount : 0;
		res.status(200).json({ count: unseenCount });
	} catch (error) {
		console.error(
			"Error fetching unseen messages count for hotel owner:",
			error
		);
		res.status(400).json({ error: error.message });
	}
};

// Fetch unseen messages by Regular Client
exports.getUnseenMessagesByClient = async (req, res) => {
	try {
		const { clientId } = req.params;

		// Validate that clientId is a valid ObjectId
		if (!mongoose.Types.ObjectId.isValid(clientId)) {
			return res.status(400).json({ error: "Invalid client ID" });
		}

		const unseenMessages = await SupportCase.find({
			"conversation.messageBy.userId": mongoose.Types.ObjectId(clientId),
			caseStatus: { $ne: "closed" },
			"conversation.seenByCustomer": false,
		}).select(
			"conversation._id conversation.messageBy conversation.message conversation.date"
		);

		res.status(200).json(unseenMessages);
	} catch (error) {
		console.error("Error fetching unseen messages for client:", error);
		res.status(400).json({ error: error.message });
	}
};

exports.getUnseenMessagesCountByCustomerCase = async (req, res) => {
	try {
		const { caseId } = req.params;
		if (!mongoose.Types.ObjectId.isValid(caseId)) {
			return res.status(200).json({ count: 0 });
		}

		const supportCase = await SupportCase.findOne({
			_id: ObjectId(caseId),
			openedBy: "client",
		})
			.select("clientContact conversation caseStatus")
			.lean();

		if (!supportCase || supportCase.caseStatus === "closed") {
			return res.status(200).json({ count: 0 });
		}

		const clientContact = normalizeEmailOrPhone(supportCase.clientContact);
		const count = (supportCase.conversation || []).filter((entry) => {
			if (!entry || entry.seenByCustomer === true) return false;
			if (entry.isSystem) return false;
			const senderContact = normalizeEmailOrPhone(entry.messageBy?.customerEmail);
			return !clientContact || senderContact !== clientContact;
		}).length;

		return res.status(200).json({ count });
	} catch (error) {
		console.error("Error fetching customer unseen messages count:", error);
		return res.status(200).json({ count: 0 });
	}
};

// Update seen status for Super Admin or PMS Owner
exports.updateSeenStatusForAdminOrOwner = async (req, res) => {
	try {
		const { id } = req.params;
		const role = req.user.role;

		const updateField =
			role === "SuperAdmin"
				? { "conversation.$[].seenByAdmin": true }
				: { "conversation.$[].seenByHotel": true };

		const result = await SupportCase.updateOne(
			{ _id: id, [`conversation.seenBy${role}`]: false },
			{ $set: updateField }
		);

		if (result.nModified === 0) {
			return res
				.status(404)
				.json({ error: "Support case not found or already updated" });
		}

		res.status(200).json({ message: "Seen status updated" });
	} catch (error) {
		res.status(400).json({ error: error.message });
	}
};

// Update seen status for Regular Client
exports.updateSeenStatusForClient = async (req, res) => {
	try {
		const { id } = req.params;

		const result = await SupportCase.updateOne(
			{ _id: id, "conversation.seenByCustomer": false },
			{ $set: { "conversation.$[].seenByCustomer": true } }
		);

		if (result.nModified === 0) {
			return res
				.status(404)
				.json({ error: "Support case not found or already updated" });
		}

		res.status(200).json({ message: "Seen status updated" });
	} catch (error) {
		res.status(400).json({ error: error.message });
	}
};

// Mark all messages as seen by Super Admin
exports.markAllMessagesAsSeenByAdmin = async (req, res) => {
	try {
		const { id } = req.params; // id refers to the support case ID
		const { userId } = req.body; // userId is the admin's ID
		const currentCase = await SupportCase.findById(id).lean();
		if (!currentCase) {
			return res.status(404).json({ error: "Support case not found" });
		}
		if (!canSeeSupportCase(req, currentCase)) {
			return res.status(403).json({ error: "Support case access denied" });
		}

		// Update the conversation messages that are not seen by the admin
		const result = await SupportCase.updateOne(
			{ _id: ObjectId(id), "conversation.seenByAdmin": false }, // Match only unseen messages
			{ $set: { "conversation.$[elem].seenByAdmin": true } }, // Mark them as seen
			{
				arrayFilters: [
					{
						"elem.messageBy.userId": { $ne: ObjectId(userId) }, // Exclude the admin's own messages
						"elem.seenByAdmin": false, // Only update if not seen by admin yet
					},
				],
			}
		);

		const modifiedCount = result.modifiedCount || result.nModified || 0;
		if (modifiedCount === 0) {
			return res.status(200).json({
				message: "No unseen messages pending for Admin",
				alreadySeen: true,
			});
		}

		// Emit the real-time socket event to the specific room (support case ID)
		req.app.get("io").to(id).emit("messageSeen", { caseId: id, userId });

		// Return success response
		res.status(200).json({ message: "All messages marked as seen by Admin" });
	} catch (error) {
		// Handle and log any errors
		console.error("Error:", error);
		res.status(400).json({ error: error.message });
	}
};

exports.markAllMessagesAsSeenByHotels = async (req, res) => {
	try {
		const { id } = req.params;
		const { userId } = req.body;

		console.log(userId, "userId");
		console.log(id, "caseId");

		// Attempt the update
		const result = await SupportCase.updateOne(
			{ _id: ObjectId(id) },
			{ $set: { "conversation.$[elem].seenByHotel": true } },
			{
				arrayFilters: [
					{
						"elem.messageBy.userId": { $exists: true, $ne: ObjectId(userId) },
					},
				],
			}
		);

		if (result.matchedCount === 0) {
			return res
				.status(404)
				.json({ error: "Support case not found or already updated" });
		}

		res
			.status(200)
			.json({ message: "All relevant messages marked as seen by Hotel" });
	} catch (error) {
		console.error("Error:", error);
		res.status(400).json({ error: error.message });
	}
};

exports.markEverythingAsSeen = async (req, res) => {
	try {
		const scopeFilter = supportCaseScopeFilter(req);
		// Update all messages across all cases to be marked as seen
		const result = await SupportCase.updateMany(
			scopeFilter,
			{
				$set: {
					"conversation.$[].seenByAdmin": true,
					"conversation.$[].seenByHotel": true,
					"conversation.$[].seenByCustomer": true,
				},
			}
		);

		// Return a success response
		res.status(200).json({
			message: "All messages in all cases marked as seen",
			updatedCases: result.modifiedCount,
		});
	} catch (error) {
		console.error("Error marking everything as seen:", error);
		res.status(500).json({ error: error.message });
	}
};

exports.deleteMessageFromConversation = async (req, res) => {
	try {
		const { caseId, messageId } = req.params;

		// Validate IDs
		if (
			!mongoose.Types.ObjectId.isValid(caseId) ||
			!mongoose.Types.ObjectId.isValid(messageId)
		) {
			return res.status(400).json({ error: "Invalid case ID or message ID" });
		}

		// Find the support case and remove the specific message
		const currentCase = await SupportCase.findById(caseId).lean();
		if (!currentCase) {
			return res
				.status(404)
				.json({ error: "Support case or message not found" });
		}
		if (!canSeeSupportCase(req, currentCase)) {
			return res.status(403).json({ error: "Support case access denied" });
		}

		const updatedCase = await SupportCase.findByIdAndUpdate(
			caseId,
			{
				$pull: { conversation: { _id: messageId } }, // Remove the message with the specific _id
			},
			{ new: true } // Return the updated document
		);

		if (!updatedCase) {
			return res
				.status(404)
				.json({ error: "Support case or message not found" });
		}

		// Emit `messageDeleted` event to all clients in the room
		req.io.to(caseId).emit("messageDeleted", { caseId, messageId });

		res
			.status(200)
			.json({ message: "Message deleted successfully", updatedCase });
	} catch (error) {
		console.error("Error deleting message:", error);
		res.status(500).json({ error: error.message });
	}
};
