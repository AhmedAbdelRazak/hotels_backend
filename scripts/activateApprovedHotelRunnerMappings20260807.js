/** @format */

"use strict";

const path = require("path");

require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const mongoose = require("mongoose");

// This release tool must never bootstrap or change indexes on the packed PMS
// database. These settings deliberately precede every controller/model import.
mongoose.set("autoIndex", false);
mongoose.set("autoCreate", false);

const HotelRunnerRoomMapping = require("../models/hotelrunner_room_mapping");
const HotelRunnerSyncState = require("../models/hotelrunner_sync_state");
const { getHotelRunnerConfig } = require("../services/hotelrunnerConfig");
const {
  loadConfiguredHotel,
  safeErrorMessage,
} = require("../services/hotelrunnerEventService");
const {
  hasCurrentRoomListProof,
  roomListVerificationWindow,
  updateHotelRunnerRoomMapping,
} = require("../controllers/hotelrunner");

const REQUIRED_APPROVAL = "owner-2026-08-07";

const APPROVED_MAPPINGS = Object.freeze(
  [
    {
      invCode: "HR:1332547",
      roomType: "doubleRooms",
      displayName: "Double Room \u2013 Comfort & Relaxation",
      localRoomConfigId: "6a40df5f1a6d1850eb25c183",
      externalName: "Comfort Double Room - AJIAD Hotel - Free Bus",
      capacity: 2,
    },
    {
      invCode: "HR:1332587",
      roomType: "tripleRooms",
      displayName: "Triple Room - Premium Comfort",
      localRoomConfigId: "6a40e0981a6d1850eb25c27c",
      externalName:
        "Comfort Triple Room - 3 beds - AJYAD Hotel- 15 Mins from Haram",
      capacity: 3,
    },
    {
      invCode: "HR:1332317",
      roomType: "quadRooms",
      displayName: "Quadruple Room \u2013 Comfort & Privacy",
      localRoomConfigId: "6a40e45a1a6d1850eb25c58b",
      externalName:
        "Comfort Family Room - 4 beds - AJYAD Hotel- 15 Mins from Haram",
      capacity: 4,
    },
    {
      invCode: "HR:1332566",
      roomType: "familyRooms",
      displayName: "Family Quintuple Room",
      localRoomConfigId: "6a40e4ec1a6d1850eb25c635",
      externalName: "Comfort Family - 5 Beds -Zad AJYAD Hotel - Free Bus",
      capacity: 5,
    },
    {
      invCode: "HR:1332585",
      roomType: "familyRooms",
      displayName: "Spacious Six-Bed Room",
      localRoomConfigId: "6a4a84216022cd7f31729011",
      externalName:
        "Comfort Family Room - 6 beds - AJYAD Hotel- 15 Mins from Haram",
      capacity: 6,
    },
  ].map((entry) => Object.freeze(entry))
);

const MASTER_MAPPING = Object.freeze({ invCode: "HR:1329539" });
const EXPECTED_INVENTORY_CODES = Object.freeze(
  [
    ...APPROVED_MAPPINGS.map((entry) => entry.invCode),
    MASTER_MAPPING.invCode,
  ].sort()
);

const clean = (value) => String(value?._id || value || "").trim();

const configuredServerSuperAdminIds = (env = process.env) =>
  String(env.SUPER_ADMIN_ID || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

function fail(message, code = "HOTELRUNNER_MAPPING_ACTIVATION_BLOCKED") {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function parseArguments(argv = []) {
  let apply = false;
  let approval = "";
  for (const rawArgument of argv) {
    const argument = String(rawArgument || "").trim();
    if (argument === "--apply") {
      if (apply)
        fail(
          "--apply may be supplied only once.",
          "HOTELRUNNER_MAPPING_ARGUMENT_INVALID"
        );
      apply = true;
      continue;
    }
    if (argument.startsWith("--approval=")) {
      if (approval) {
        fail(
          "--approval may be supplied only once.",
          "HOTELRUNNER_MAPPING_ARGUMENT_INVALID"
        );
      }
      approval = argument.slice("--approval=".length);
      continue;
    }
    fail(
      "Unsupported mapping activation argument.",
      "HOTELRUNNER_MAPPING_ARGUMENT_INVALID"
    );
  }
  if (!apply && approval) {
    fail(
      "--approval is accepted only together with --apply.",
      "HOTELRUNNER_MAPPING_ARGUMENT_INVALID"
    );
  }
  if (apply && approval !== REQUIRED_APPROVAL) {
    fail(
      `Apply requires the exact reviewed approval marker: ${REQUIRED_APPROVAL}.`,
      "HOTELRUNNER_MAPPING_APPROVAL_REQUIRED"
    );
  }
  return { apply, approval };
}

function assertClosedHotelRunnerGates(config = {}) {
  if (config.configured !== true) {
    fail("HotelRunner configuration is incomplete or invalid.");
  }
  const openGates = [
    ["HOTELRUNNER_PROJECTION_ENABLED", config.projectionEnabled],
    ["HOTELRUNNER_PULL_ENABLED", config.pullEnabled],
    ["HOTELRUNNER_ROOM_LIST_SYNC_ENABLED", config.roomListSyncEnabled],
    ["HOTELRUNNER_CONFIRM_DELIVERY_ENABLED", config.confirmDeliveryEnabled],
  ]
    .filter(([, enabled]) => enabled === true)
    .map(([name]) => name);
  if (openGates.length) {
    fail(
      `HotelRunner mapping activation requires closed gates: ${openGates.join(
        ", "
      )}.`
    );
  }
  return true;
}

function parseMappingNotes(mapping = {}) {
  let parsed;
  try {
    parsed = JSON.parse(String(mapping.notes || ""));
  } catch (_error) {
    fail(`Mapping ${clean(mapping.invCode)} has invalid discovery metadata.`);
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    fail(`Mapping ${clean(mapping.invCode)} has invalid discovery metadata.`);
  }
  return parsed;
}

function activeLeasePresent(value, nowMs) {
  if (!value) return false;
  const leaseMs = new Date(value).getTime();
  return Number.isFinite(leaseMs) && leaseMs > nowMs;
}

function assertCurrentSyncState(syncState, now = new Date()) {
  const nowMs = new Date(now).getTime();
  if (!Number.isFinite(nowMs)) fail("The mapping activation clock is invalid.");
  const generation = clean(syncState?.activeRoomListSyncGeneration);
  if (!generation)
    fail("No published HotelRunner room-list generation is available.");
  if (
    activeLeasePresent(syncState?.leaseUntil, nowMs) ||
    activeLeasePresent(syncState?.projectionLeaseUntil, nowMs)
  ) {
    fail(
      "A HotelRunner database lease is active; stop the worker before mapping activation."
    );
  }
  return generation;
}

function exactActiveLocalRoom(hotel, approved) {
  const matches = (hotel?.roomCountDetails || []).filter(
    (room) =>
      room?.activeRoom !== false &&
      clean(room?._id) &&
      String(room?.roomType || "") === approved.roomType &&
      String(room?.displayName || "") === approved.displayName
  );
  if (matches.length !== 1) {
    fail(
      `${approved.invCode} requires exactly one active local ${approved.roomType} room named ${approved.displayName}; found ${matches.length}.`
    );
  }
  if (!mongoose.Types.ObjectId.isValid(clean(matches[0]._id))) {
    fail(`${approved.invCode} resolved to an invalid local room identifier.`);
  }
  if (clean(matches[0]._id) !== approved.localRoomConfigId) {
    fail(
      `${approved.invCode} resolved local room ID differs from the owner-approved room.`
    );
  }
  return matches[0];
}

function assertExactMappingSet(mappings = []) {
  if (mappings.length !== EXPECTED_INVENTORY_CODES.length) {
    fail(
      `Expected exactly ${EXPECTED_INVENTORY_CODES.length} HotelRunner mappings; found ${mappings.length}.`
    );
  }
  const codes = mappings.map((mapping) => clean(mapping?.invCode)).sort();
  if (
    codes.length !== new Set(codes).size ||
    codes.some((code, index) => code !== EXPECTED_INVENTORY_CODES[index])
  ) {
    fail(
      "HotelRunner mapping inventory differs from the six owner-reviewed codes."
    );
  }
  return true;
}

function buildActivationPlan({
  config,
  hotel,
  mappings,
  syncState,
  now = new Date(),
} = {}) {
  assertClosedHotelRunnerGates(config);
  if (!hotel || clean(hotel._id) !== clean(config.hotelId)) {
    fail(
      "The configured HotelRunner hotel does not match the loaded PMS hotel."
    );
  }
  if (
    hotel.activateHotel !== true ||
    hotel.xHotelProActive === false ||
    !hotel.belongsTo
  ) {
    fail("The configured PMS hotel is not active and owner-bound.");
  }
  if (
    String(hotel.currency || "")
      .trim()
      .toUpperCase() !== "SAR"
  ) {
    fail("The configured PMS hotel currency is not SAR.");
  }
  assertExactMappingSet(mappings);
  const generation = assertCurrentSyncState(syncState, now);
  const mappingByCode = new Map(
    mappings.map((mapping) => [clean(mapping.invCode), mapping])
  );
  const master = mappingByCode.get(MASTER_MAPPING.invCode);
  if (
    master?.isMaster !== true ||
    clean(master?.localRoomConfigId) ||
    String(master?.status || "") !== "conflict" ||
    String(master?.roomListVerificationState || "") !== "conflict" ||
    clean(master?.roomListSyncGeneration) !== generation
  ) {
    fail(
      `${MASTER_MAPPING.invCode} must remain the current conflict/unmapped master fallback.`
    );
  }

  const verificationWindow = roomListVerificationWindow(config, now);
  const plan = [];
  for (const approved of APPROVED_MAPPINGS) {
    const mapping = mappingByCode.get(approved.invCode);
    if (!mapping || !mongoose.Types.ObjectId.isValid(clean(mapping._id))) {
      fail(`${approved.invCode} does not have a valid mapping record.`);
    }
    const version = Number(mapping.__v);
    if (!Number.isInteger(version) || version < 0) {
      fail(
        `${approved.invCode} does not have a valid optimistic-concurrency version.`
      );
    }
    if (
      mapping.isMaster === true ||
      !hasCurrentRoomListProof(mapping, verificationWindow, generation)
    ) {
      fail(`${approved.invCode} lacks current, conflict-free room-list proof.`);
    }
    if (String(mapping.externalName || "") !== approved.externalName) {
      fail(
        `${approved.invCode} discovery name differs from the owner-reviewed room.`
      );
    }
    const notes = parseMappingNotes(mapping);
    if (
      String(notes.salesCurrency || "")
        .trim()
        .toUpperCase() !== "SAR"
    ) {
      fail(`${approved.invCode} discovery currency is not SAR.`);
    }
    if (Number(notes.roomCapacity) !== approved.capacity) {
      fail(
        `${approved.invCode} discovery capacity is not ${approved.capacity}.`
      );
    }
    const localRoom = exactActiveLocalRoom(hotel, approved);
    const localRoomId = clean(localRoom._id);
    const currentLocalRoomId = clean(mapping.localRoomConfigId);
    const status = String(mapping.status || "");
    if (status === "active") {
      if (currentLocalRoomId !== localRoomId) {
        fail(
          `${approved.invCode} is already active against a different local room.`
        );
      }
    } else if (status !== "pending" || currentLocalRoomId) {
      fail(
        `${approved.invCode} is neither pending/unmapped nor already active as approved.`
      );
    }
    plan.push({
      invCode: approved.invCode,
      roomType: approved.roomType,
      displayName: approved.displayName,
      capacity: approved.capacity,
      mappingId: clean(mapping._id),
      localRoomTypeId: localRoomId,
      expectedVersion: version,
      expectedPostVersion: status === "active" ? version : version + 1,
      beforeStatus: status,
      needsUpdate: status !== "active",
    });
  }
  return {
    hotelId: clean(hotel._id),
    hotelName: String(hotel.hotelName || ""),
    generation,
    masterInvCode: MASTER_MAPPING.invCode,
    mappings: plan,
  };
}

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = Number(code);
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

async function applyActivationPlan(
  plan,
  { actorId, updateMapping = updateHotelRunnerRoomMapping } = {}
) {
  if (!mongoose.Types.ObjectId.isValid(clean(actorId))) {
    fail(
      "SUPER_ADMIN_ID does not contain a valid configured actor identifier."
    );
  }
  const results = [];
  for (const mapping of plan.mappings) {
    if (mapping.needsUpdate !== true) {
      results.push({
        invCode: mapping.invCode,
        status: "active",
        version: mapping.expectedPostVersion,
        changed: false,
      });
      continue;
    }
    const req = {
      profile: { _id: clean(actorId), activeUser: true },
      auth: { _id: clean(actorId) },
      params: { mappingId: mapping.mappingId },
      body: {
        localRoomTypeId: mapping.localRoomTypeId,
        enabled: true,
        expectedVersion: mapping.expectedVersion,
      },
    };
    const res = responseRecorder();
    await updateMapping(req, res);
    if (res.statusCode !== 200) {
      const reason = String(res.body?.error || "mapping update rejected").slice(
        0,
        240
      );
      fail(
        `${mapping.invCode} activation stopped with HTTP ${res.statusCode}: ${reason}`,
        "HOTELRUNNER_MAPPING_CONTROLLER_REJECTED"
      );
    }
    if (
      clean(res.body?.mapping?._id) !== mapping.mappingId ||
      clean(res.body?.mapping?.localRoomTypeId) !== mapping.localRoomTypeId ||
      String(res.body?.mapping?.status || "") !== "active" ||
      Number(res.body?.mapping?.version) !== mapping.expectedPostVersion
    ) {
      fail(
        `${mapping.invCode} returned an unexpected post-CAS state.`,
        "HOTELRUNNER_MAPPING_POSTCONDITION_FAILED"
      );
    }
    results.push({
      invCode: mapping.invCode,
      status: "active",
      version: mapping.expectedPostVersion,
      changed: true,
    });
  }
  return results;
}

function assertAppliedPostconditions(
  plan,
  mappings = [],
  { actorId = "" } = {}
) {
  assertExactMappingSet(mappings);
  const mappingByCode = new Map(
    mappings.map((mapping) => [clean(mapping.invCode), mapping])
  );
  for (const approved of plan.mappings) {
    const mapping = mappingByCode.get(approved.invCode);
    if (
      String(mapping?.status || "") !== "active" ||
      clean(mapping?.localRoomConfigId) !== approved.localRoomTypeId ||
      Number(mapping?.__v) !== approved.expectedPostVersion
    ) {
      fail(
        `${approved.invCode} failed exact active-mapping verification.`,
        "HOTELRUNNER_MAPPING_POSTCONDITION_FAILED"
      );
    }
    if (
      approved.needsUpdate === true &&
      (clean(mapping?.updatedBy) !== clean(actorId) ||
        String(mapping?.discoveredFrom || "") !== "manual")
    ) {
      fail(
        `${approved.invCode} failed mapping audit-attribution verification.`,
        "HOTELRUNNER_MAPPING_POSTCONDITION_FAILED"
      );
    }
  }
  const master = mappingByCode.get(MASTER_MAPPING.invCode);
  if (
    master?.isMaster !== true ||
    clean(master?.localRoomConfigId) ||
    String(master?.status || "") !== "conflict"
  ) {
    fail(
      `${MASTER_MAPPING.invCode} no longer satisfies the unmapped-master invariant.`,
      "HOTELRUNNER_MAPPING_POSTCONDITION_FAILED"
    );
  }
  return true;
}

function sanitizedPlan(plan, mode) {
  return {
    mode,
    hotelName: plan.hotelName,
    inventoryCount: plan.mappings.length,
    masterFallback: {
      invCode: plan.masterInvCode,
      status: "conflict_unmapped",
    },
    mappings: plan.mappings.map((mapping) => ({
      invCode: mapping.invCode,
      roomType: mapping.roomType,
      displayName: mapping.displayName,
      capacity: mapping.capacity,
      beforeStatus: mapping.beforeStatus,
      expectedVersion: mapping.expectedVersion,
      action: mapping.needsUpdate ? "activate" : "already_active",
    })),
  };
}

async function readMappingState(config, now = new Date()) {
  const hotel = await loadConfiguredHotel(config);
  const [mappings, syncState] = await Promise.all([
    HotelRunnerRoomMapping.find({ hotelId: hotel._id }).lean().exec(),
    HotelRunnerSyncState.findOne({ hotelId: hotel._id }).lean().exec(),
  ]);
  return {
    hotel,
    mappings,
    syncState,
    plan: buildActivationPlan({ config, hotel, mappings, syncState, now }),
  };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const config = getHotelRunnerConfig();
  assertClosedHotelRunnerGates(config);
  const database =
    process.env.DATABASE || process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!database) fail("Missing DATABASE/MONGO connection string.");
  const actorId = configuredServerSuperAdminIds().find((id) =>
    mongoose.Types.ObjectId.isValid(id)
  );
  if (!actorId)
    fail(
      "SUPER_ADMIN_ID does not contain a valid configured actor identifier."
    );

  await mongoose.connect(database, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    autoIndex: false,
    autoCreate: false,
  });
  const before = await readMappingState(config);
  console.log(
    JSON.stringify(
      sanitizedPlan(before.plan, options.apply ? "apply" : "dry_run"),
      null,
      2
    )
  );
  if (!options.apply) return { mode: "dry_run", plan: before.plan };

  const results = await applyActivationPlan(before.plan, { actorId });
  const after = await readMappingState(config);
  assertAppliedPostconditions(before.plan, after.mappings, { actorId });
  console.log(
    JSON.stringify(
      {
        mode: "applied",
        inventoryCount: results.length,
        masterFallback: {
          invCode: MASTER_MAPPING.invCode,
          status: "conflict_unmapped",
        },
        mappings: results,
        vendorApiCalls: 0,
      },
      null,
      2
    )
  );
  return { mode: "applied", results };
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error("[hotelrunner-mapping-activation] stopped", {
        code: String(
          error?.code || "HOTELRUNNER_MAPPING_ACTIVATION_FAILED"
        ).slice(0, 100),
        message: safeErrorMessage(error, "Mapping activation failed."),
      });
      process.exitCode = 1;
    })
    .finally(async () => {
      if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
    });
}

module.exports = {
  APPROVED_MAPPINGS,
  EXPECTED_INVENTORY_CODES,
  MASTER_MAPPING,
  REQUIRED_APPROVAL,
  applyActivationPlan,
  assertAppliedPostconditions,
  assertClosedHotelRunnerGates,
  assertCurrentSyncState,
  assertExactMappingSet,
  buildActivationPlan,
  configuredServerSuperAdminIds,
  exactActiveLocalRoom,
  main,
  parseArguments,
  parseMappingNotes,
  responseRecorder,
  sanitizedPlan,
};
