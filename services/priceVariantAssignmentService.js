/** @format */

"use strict";

const mongoose = require("mongoose");
const PriceVariant = require("../models/price_variant");

const ObjectId = mongoose.Types.ObjectId;

const normalizeId = (value) => String(value?._id || value || "").trim();

const uniqueValidIds = (values = []) => [
	...new Set(
		(Array.isArray(values) ? values : [values])
			.map(normalizeId)
			.filter((id) => id && ObjectId.isValid(id))
	),
];

const toObjectIds = (values = []) =>
	uniqueValidIds(values).map((id) => ObjectId(id));

const assignmentKey = (priceVariantDataId = "", priceVariantItemId = "") =>
	`${normalizeId(priceVariantDataId)}:${normalizeId(priceVariantItemId)}`;

const itemById = (doc = {}, itemId = "") => {
	if (!doc || !itemId) return null;
	if (doc.pricingItems?.id) return doc.pricingItems.id(itemId);
	return (Array.isArray(doc.pricingItems) ? doc.pricingItems : []).find(
		(item) => normalizeId(item?._id) === normalizeId(itemId)
	);
};

const normalizeAssignmentInputs = (assignments = []) => {
	const byKey = new Map();
	(Array.isArray(assignments) ? assignments : []).forEach((assignment) => {
		const priceVariantDataId = normalizeId(
			assignment?.priceVariantDataId ||
				assignment?.priceVariantData ||
				assignment?.dataId
		);
		const priceVariantItemId = normalizeId(
			assignment?.priceVariantItemId ||
				assignment?.pricingItemId ||
				assignment?.itemId
		);
		if (
			!ObjectId.isValid(priceVariantDataId) ||
			!ObjectId.isValid(priceVariantItemId)
		) {
			return;
		}
		const key = assignmentKey(priceVariantDataId, priceVariantItemId);
		const hotelIds = uniqueValidIds([
			assignment?.hotelId,
			...(Array.isArray(assignment?.hotelIds) ? assignment.hotelIds : []),
		]);
		const existing = byKey.get(key);
		byKey.set(key, {
			priceVariantDataId,
			priceVariantItemId,
			hotelIds: existing
				? uniqueValidIds([...existing.hotelIds, ...hotelIds])
				: hotelIds,
		});
	});
	return [...byKey.values()];
};

const normalizePriceVariantAssignments = async ({
	assignments = [],
	hotelIds = [],
	actor = {},
} = {}) => {
	const accountHotelIds = uniqueValidIds(hotelIds);
	const requested = normalizeAssignmentInputs(assignments);
	if (!requested.length) return [];
	if (!accountHotelIds.length) {
		throw new Error("Please select at least one hotel before assigning pricing");
	}
	if (requested.length > 100) {
		throw new Error("Please assign 100 pricing options or fewer");
	}

	const dataIds = uniqueValidIds(
		requested.map((assignment) => assignment.priceVariantDataId)
	);
	const docs = await PriceVariant.find({
		_id: { $in: toObjectIds(dataIds) },
		active: { $ne: false },
		hotelIds: { $in: toObjectIds(accountHotelIds) },
	}).exec();
	const docsById = new Map(docs.map((doc) => [normalizeId(doc._id), doc]));
	const normalized = [];

	requested.forEach((assignment) => {
		const doc = docsById.get(assignment.priceVariantDataId);
		if (!doc) {
			throw new Error("Selected price variant is not available for this hotel");
		}
		const item = itemById(doc, assignment.priceVariantItemId);
		if (!item) {
			throw new Error("Selected price variant item was not found");
		}
		if (String(item.status || "open").toLowerCase() === "blocked") {
			throw new Error(`${item.name || "Selected pricing"} is blocked`);
		}
		if (!(Number(item.sellingPrice || 0) > 0)) {
			throw new Error(`${item.name || "Selected pricing"} needs a selling price`);
		}

		const docHotelIds = uniqueValidIds(doc.hotelIds);
		const sourceHotelIds = assignment.hotelIds.length
			? assignment.hotelIds
			: accountHotelIds;
		const invalidHotel = sourceHotelIds.find(
			(hotelId) =>
				!accountHotelIds.includes(hotelId) || !docHotelIds.includes(hotelId)
		);
		if (invalidHotel) {
			throw new Error("Selected price variant cannot be assigned to one of these hotels");
		}
		const scopedHotelIds = sourceHotelIds.filter(
			(hotelId) =>
				accountHotelIds.includes(hotelId) && docHotelIds.includes(hotelId)
		);
		if (!scopedHotelIds.length) {
			throw new Error("Selected price variant does not match the agent hotels");
		}

		normalized.push({
			priceVariantDataId: ObjectId(assignment.priceVariantDataId),
			priceVariantItemId: ObjectId(assignment.priceVariantItemId),
			pricingName: item.name || "",
			pricingNameOtherLanguage: item.nameOtherLanguage || "",
			hotelIds: scopedHotelIds.map((hotelId) => ObjectId(hotelId)),
			assignedAt: new Date(),
			assignedBy:
				actor?._id && ObjectId.isValid(normalizeId(actor._id))
					? ObjectId(normalizeId(actor._id))
					: null,
		});
	});

	return normalized;
};

const agentSnapshot = (agent = {}, hotelIds = [], actor = {}) => ({
	agentId: ObjectId(normalizeId(agent._id)),
	agentName: agent.name || agent.email || "",
	agentEmail: agent.email || "",
	companyName: agent.companyName || agent.companyOfficialName || "",
	hotelIds: toObjectIds(hotelIds),
	assignedAt: new Date(),
	assignedBy:
		actor?._id && ObjectId.isValid(normalizeId(actor._id))
			? ObjectId(normalizeId(actor._id))
			: null,
});

const syncPriceVariantAssignmentsForAgent = async ({
	agent = {},
	assignments = [],
	previousAssignments = [],
	actor = {},
} = {}) => {
	const agentId = normalizeId(agent._id);
	if (!agentId || !ObjectId.isValid(agentId)) return { updatedDocs: 0 };

	const normalizedAssignments = normalizeAssignmentInputs(assignments);
	const previous = normalizeAssignmentInputs(previousAssignments);
	const affectedDataIds = uniqueValidIds([
		...normalizedAssignments.map((assignment) => assignment.priceVariantDataId),
		...previous.map((assignment) => assignment.priceVariantDataId),
	]);
	if (!affectedDataIds.length) return { updatedDocs: 0 };

	const docs = await PriceVariant.find({
		_id: { $in: toObjectIds(affectedDataIds) },
	}).exec();
	const nextByDataId = new Map();
	normalizedAssignments.forEach((assignment) => {
		const list = nextByDataId.get(assignment.priceVariantDataId) || [];
		list.push(assignment);
		nextByDataId.set(assignment.priceVariantDataId, list);
	});

	let updatedDocs = 0;
	for (const doc of docs) {
		let changed = false;
		(Array.isArray(doc.pricingItems) ? doc.pricingItems : []).forEach((item) => {
			const current = Array.isArray(item.assignedAgents)
				? item.assignedAgents
				: [];
			const next = current.filter(
				(assignment) => normalizeId(assignment.agentId) !== agentId
			);
			if (next.length !== current.length) {
				item.assignedAgents = next;
				changed = true;
			}
		});

		(nextByDataId.get(normalizeId(doc._id)) || []).forEach((assignment) => {
			const item = itemById(doc, assignment.priceVariantItemId);
			if (!item) return;
			item.assignedAgents = [
				...(Array.isArray(item.assignedAgents) ? item.assignedAgents : []),
				agentSnapshot(agent, assignment.hotelIds, actor),
			];
			changed = true;
		});

		if (changed) {
			doc.markModified("pricingItems");
			await doc.save();
			updatedDocs += 1;
		}
	}

	return { updatedDocs };
};

module.exports = {
	assignmentKey,
	normalizePriceVariantAssignments,
	syncPriceVariantAssignmentsForAgent,
	uniqueValidIds,
};
