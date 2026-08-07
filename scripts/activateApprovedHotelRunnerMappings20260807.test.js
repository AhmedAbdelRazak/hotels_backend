/** @format */

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  APPROVED_MAPPINGS,
  EXPECTED_INVENTORY_CODES,
  MASTER_MAPPING,
  REQUIRED_APPROVAL,
  applyActivationPlan,
  assertAppliedPostconditions,
  buildActivationPlan,
  configuredServerSuperAdminIds,
  parseArguments,
  sanitizedPlan,
} = require("./activateApprovedHotelRunnerMappings20260807");

const HOTEL_ID = "6a40b6a1a6efe70450536038";
const OWNER_ID = "6a40b6a1a6efe70450536037";
const GENERATION = "room-list-generation-approved";
const NOW = new Date("2026-08-07T02:00:00.000Z");

const objectIdAt = (offset) =>
  `64b0000000000000000000${String(offset).padStart(2, "0")}`;

const configFixture = (overrides = {}) => ({
  configured: true,
  hotelId: HOTEL_ID,
  projectionEnabled: false,
  pullEnabled: false,
  roomListSyncEnabled: false,
  confirmDeliveryEnabled: false,
  roomListIntervalHours: 24,
  ...overrides,
});

const hotelFixture = (overrides = {}) => ({
  _id: HOTEL_ID,
  hotelName: "Zad AJYAD Hotel",
  belongsTo: OWNER_ID,
  activateHotel: true,
  xHotelProActive: true,
  currency: "sar",
  roomCountDetails: APPROVED_MAPPINGS.map((approved, index) => ({
    _id: approved.localRoomConfigId,
    roomType: approved.roomType,
    displayName: approved.displayName,
    activeRoom: true,
    count: 10,
  })),
  ...overrides,
});

const mappingFixture = (
  approved,
  index,
  {
    status = "pending",
    localRoomConfigId = null,
    verifiedAt = new Date("2026-08-07T01:00:00.000Z"),
    notes = null,
    ...overrides
  } = {}
) => ({
  _id: objectIdAt(index + 1),
  hotelId: HOTEL_ID,
  invCode: approved.invCode,
  __v: index + 2,
  status,
  localRoomConfigId,
  isMaster: false,
  variantConflict: false,
  roomListVerifiedAt: verifiedAt,
  roomListSyncGeneration: GENERATION,
  roomListVerificationState: "verified",
  externalName: approved.externalName,
  notes:
    notes ||
    JSON.stringify({
      salesCurrency: "SAR",
      roomCapacity: approved.capacity,
      adultCapacity: approved.capacity,
    }),
  ...overrides,
});

const masterFixture = (overrides = {}) => ({
  _id: objectIdAt(20),
  hotelId: HOTEL_ID,
  invCode: MASTER_MAPPING.invCode,
  __v: 2,
  status: "conflict",
  localRoomConfigId: null,
  isMaster: true,
  variantConflict: false,
  roomListVerifiedAt: null,
  roomListSyncGeneration: GENERATION,
  roomListVerificationState: "conflict",
  notes: JSON.stringify({ salesCurrency: "SAR", roomCapacity: null }),
  ...overrides,
});

const mappingsFixture = () => [
  ...APPROVED_MAPPINGS.map((approved, index) =>
    mappingFixture(approved, index)
  ),
  masterFixture(),
];

const syncStateFixture = (overrides = {}) => ({
  activeRoomListSyncGeneration: GENERATION,
  leaseUntil: new Date("2026-08-07T01:30:00.000Z"),
  projectionLeaseUntil: null,
  ...overrides,
});

const buildFixturePlan = (overrides = {}) =>
  buildActivationPlan({
    config: configFixture(overrides.config),
    hotel: hotelFixture(overrides.hotel),
    mappings: overrides.mappings || mappingsFixture(),
    syncState: syncStateFixture(overrides.syncState),
    now: NOW,
  });

test("the release manifest is exactly the five approved Zad Ajyad mappings and master", () => {
  assert.deepEqual(
    APPROVED_MAPPINGS.map(
      ({
        invCode,
        roomType,
        displayName,
        localRoomConfigId,
        externalName,
        capacity,
      }) => [
        invCode,
        roomType,
        displayName,
        localRoomConfigId,
        externalName,
        capacity,
      ]
    ),
    [
      [
        "HR:1332547",
        "doubleRooms",
        "Double Room \u2013 Comfort & Relaxation",
        "6a40df5f1a6d1850eb25c183",
        "Comfort Double Room - AJIAD Hotel - Free Bus",
        2,
      ],
      [
        "HR:1332587",
        "tripleRooms",
        "Triple Room - Premium Comfort",
        "6a40e0981a6d1850eb25c27c",
        "Comfort Triple Room - 3 beds - AJYAD Hotel- 15 Mins from Haram",
        3,
      ],
      [
        "HR:1332317",
        "quadRooms",
        "Quadruple Room \u2013 Comfort & Privacy",
        "6a40e45a1a6d1850eb25c58b",
        "Comfort Family Room - 4 beds - AJYAD Hotel- 15 Mins from Haram",
        4,
      ],
      [
        "HR:1332566",
        "familyRooms",
        "Family Quintuple Room",
        "6a40e4ec1a6d1850eb25c635",
        "Comfort Family - 5 Beds -Zad AJYAD Hotel - Free Bus",
        5,
      ],
      [
        "HR:1332585",
        "familyRooms",
        "Spacious Six-Bed Room",
        "6a4a84216022cd7f31729011",
        "Comfort Family Room - 6 beds - AJYAD Hotel- 15 Mins from Haram",
        6,
      ],
    ]
  );
  assert.equal(MASTER_MAPPING.invCode, "HR:1329539");
  assert.deepEqual(EXPECTED_INVENTORY_CODES, [
    "HR:1329539",
    "HR:1332317",
    "HR:1332547",
    "HR:1332566",
    "HR:1332585",
    "HR:1332587",
  ]);
});

test("CLI is dry-run by default and apply requires the exact owner approval", () => {
  assert.deepEqual(parseArguments([]), { apply: false, approval: "" });
  assert.deepEqual(
    parseArguments(["--apply", `--approval=${REQUIRED_APPROVAL}`]),
    { apply: true, approval: REQUIRED_APPROVAL }
  );
  assert.throws(
    () => parseArguments(["--apply"]),
    /exact reviewed approval marker/i
  );
  assert.throws(
    () => parseArguments(["--apply", "--approval=owner-wrong"]),
    /exact reviewed approval marker/i
  );
  assert.throws(
    () => parseArguments([`--approval=${REQUIRED_APPROVAL}`]),
    /only together with --apply/i
  );
  assert.throws(() => parseArguments(["--mapping=anything"]), /unsupported/i);
  try {
    parseArguments(["--token=must-not-appear"]);
    assert.fail("unsupported secret-like arguments must fail");
  } catch (error) {
    assert.doesNotMatch(error.message, /must-not-appear/);
  }
});

test("the CLI accepts actor identity only from server-side SUPER_ADMIN_ID", () => {
  assert.deepEqual(
    configuredServerSuperAdminIds({
      SUPER_ADMIN_ID: ` ${OWNER_ID},${objectIdAt(60)} `,
      REACT_APP_SUPER_ADMIN_ID: objectIdAt(61),
    }),
    [OWNER_ID, objectIdAt(60)]
  );
  assert.deepEqual(
    configuredServerSuperAdminIds({ REACT_APP_SUPER_ADMIN_ID: objectIdAt(61) }),
    []
  );
});

test("Mongoose implicit writes are disabled before controller/model imports and no vendor client is loaded", () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, "activateApprovedHotelRunnerMappings20260807.js"),
    "utf8"
  );
  const autoIndexAt = source.indexOf('mongoose.set("autoIndex", false)');
  const autoCreateAt = source.indexOf('mongoose.set("autoCreate", false)');
  const firstModelAt = source.indexOf('require("../models/');
  const controllerAt = source.indexOf('require("../controllers/hotelrunner")');
  assert.ok(autoIndexAt > 0 && autoIndexAt < firstModelAt);
  assert.ok(autoCreateAt > 0 && autoCreateAt < firstModelAt);
  assert.ok(autoIndexAt < controllerAt && autoCreateAt < controllerAt);
  assert.doesNotMatch(
    source,
    /require\([^)]*(?:hotelrunnerClient|hotelrunnerWorker|node-fetch|axios)/i
  );
});

test("preflight resolves exact active local rooms and current verified mapping proof", () => {
  const plan = buildFixturePlan();
  assert.equal(plan.hotelId, HOTEL_ID);
  assert.equal(plan.generation, GENERATION);
  assert.equal(plan.masterInvCode, MASTER_MAPPING.invCode);
  assert.equal(plan.mappings.length, 5);
  assert.deepEqual(
    plan.mappings.map((mapping) => ({
      invCode: mapping.invCode,
      roomType: mapping.roomType,
      displayName: mapping.displayName,
      capacity: mapping.capacity,
      beforeStatus: mapping.beforeStatus,
    })),
    APPROVED_MAPPINGS.map(
      ({
        externalName: _externalName,
        localRoomConfigId: _localRoomConfigId,
        ...approved
      }) => ({
        ...approved,
        beforeStatus: "pending",
      })
    )
  );
  assert.equal(
    sanitizedPlan(plan, "dry_run").masterFallback.status,
    "conflict_unmapped"
  );
  assert.equal(
    JSON.stringify(sanitizedPlan(plan, "dry_run")).includes(HOTEL_ID),
    false
  );
});

test("preflight fails closed on any open HotelRunner gate", () => {
  for (const key of [
    "projectionEnabled",
    "pullEnabled",
    "roomListSyncEnabled",
    "confirmDeliveryEnabled",
  ]) {
    assert.throws(
      () => buildFixturePlan({ config: { [key]: true } }),
      /requires closed gates/i,
      key
    );
  }
});

test("preflight rejects unexpected inventory and a mapped or non-conflict master", () => {
  const unexpected = mappingsFixture();
  unexpected[0] = { ...unexpected[0], invCode: "HR:unexpected" };
  assert.throws(
    () => buildFixturePlan({ mappings: unexpected }),
    /inventory differs/i
  );

  const mappedMaster = mappingsFixture();
  mappedMaster[5] = {
    ...mappedMaster[5],
    status: "active",
    localRoomConfigId: objectIdAt(30),
  };
  assert.throws(
    () => buildFixturePlan({ mappings: mappedMaster }),
    /conflict\/unmapped master fallback/i
  );
});

test("preflight rejects stale/unpublished proof, non-SAR currency, and wrong capacity", () => {
  const stale = mappingsFixture();
  stale[0] = {
    ...stale[0],
    roomListVerifiedAt: new Date("2026-08-03T00:00:00.000Z"),
  };
  assert.throws(
    () => buildFixturePlan({ mappings: stale }),
    /lacks current, conflict-free/i
  );

  const unpublished = mappingsFixture();
  unpublished[0] = {
    ...unpublished[0],
    roomListSyncGeneration: "older-generation",
  };
  assert.throws(
    () => buildFixturePlan({ mappings: unpublished }),
    /lacks current, conflict-free/i
  );

  const usd = mappingsFixture();
  usd[0] = {
    ...usd[0],
    notes: JSON.stringify({ salesCurrency: "USD", roomCapacity: 2 }),
  };
  assert.throws(
    () => buildFixturePlan({ mappings: usd }),
    /currency is not SAR/i
  );

  const wrongCapacity = mappingsFixture();
  wrongCapacity[0] = {
    ...wrongCapacity[0],
    notes: JSON.stringify({ salesCurrency: "SAR", roomCapacity: 3 }),
  };
  assert.throws(
    () => buildFixturePlan({ mappings: wrongCapacity }),
    /capacity is not 2/i
  );
});

test("preflight pins the exact owner-reviewed HotelRunner external names", () => {
  const renamed = mappingsFixture();
  renamed[0] = { ...renamed[0], externalName: "Another room" };
  assert.throws(
    () => buildFixturePlan({ mappings: renamed }),
    /discovery name differs from the owner-reviewed room/i
  );
});

test("preflight requires one exact active local room and no active database lease", () => {
  const duplicateRoom = hotelFixture();
  duplicateRoom.roomCountDetails = [
    ...duplicateRoom.roomCountDetails,
    { ...duplicateRoom.roomCountDetails[0], _id: objectIdAt(50) },
  ];
  assert.throws(
    () => buildFixturePlan({ hotel: duplicateRoom }),
    /requires exactly one active local/i
  );
  assert.throws(
    () =>
      buildFixturePlan({
        syncState: {
          projectionLeaseUntil: new Date("2026-08-07T02:05:00.000Z"),
        },
      }),
    /database lease is active/i
  );
});

test("preflight pins the exact owner-approved local room config ObjectId", () => {
  const wrongIdHotel = hotelFixture();
  wrongIdHotel.roomCountDetails = wrongIdHotel.roomCountDetails.map(
    (room, index) => (index === 0 ? { ...room, _id: objectIdAt(58) } : room)
  );
  assert.throws(
    () => buildFixturePlan({ hotel: wrongIdHotel }),
    /local room ID differs from the owner-approved room/i
  );
});

test("already-active rows are accepted only when their exact approved local room matches", () => {
  const hotel = hotelFixture();
  const mappings = mappingsFixture();
  mappings[0] = {
    ...mappings[0],
    status: "active",
    localRoomConfigId: hotel.roomCountDetails[0]._id,
  };
  assert.equal(
    buildFixturePlan({ hotel, mappings }).mappings[0].beforeStatus,
    "active"
  );
  mappings[0] = {
    ...mappings[0],
    localRoomConfigId: hotel.roomCountDetails[1]._id,
  };
  assert.throws(
    () => buildFixturePlan({ hotel, mappings }),
    /already active against a different local room/i
  );
});

test("apply calls the existing controller contract sequentially with exact versions", async () => {
  const plan = buildFixturePlan();
  const calls = [];
  const results = await applyActivationPlan(plan, {
    actorId: OWNER_ID,
    updateMapping: async (req, res) => {
      calls.push({ params: req.params, body: req.body, actor: req.auth._id });
      return res.json({
        mapping: {
          _id: req.params.mappingId,
          localRoomTypeId: req.body.localRoomTypeId,
          status: "active",
          version: req.body.expectedVersion + 1,
        },
      });
    },
  });
  assert.equal(calls.length, 5);
  assert.equal(results.length, 5);
  for (let index = 0; index < calls.length; index += 1) {
    assert.deepEqual(calls[index], {
      params: { mappingId: plan.mappings[index].mappingId },
      body: {
        localRoomTypeId: plan.mappings[index].localRoomTypeId,
        enabled: true,
        expectedVersion: plan.mappings[index].expectedVersion,
      },
      actor: OWNER_ID,
    });
  }
});

test("apply is a zero-write rerun when every mapping is already active exactly", async () => {
  const hotel = hotelFixture();
  const mappings = mappingsFixture();
  for (const [index, localRoom] of hotel.roomCountDetails.entries()) {
    mappings[index] = {
      ...mappings[index],
      status: "active",
      localRoomConfigId: localRoom._id,
    };
  }
  const plan = buildFixturePlan({ hotel, mappings });
  let calls = 0;
  const results = await applyActivationPlan(plan, {
    actorId: OWNER_ID,
    updateMapping: async () => {
      calls += 1;
    },
  });
  assert.equal(calls, 0);
  assert.equal(results.length, 5);
  assert.equal(
    results.every((result) => result.changed === false),
    true
  );
  assert.equal(assertAppliedPostconditions(plan, mappings), true);
});

test("apply skips a prior exact success and activates only the remaining pending rows", async () => {
  const hotel = hotelFixture();
  const mappings = mappingsFixture();
  mappings[0] = {
    ...mappings[0],
    status: "active",
    localRoomConfigId: hotel.roomCountDetails[0]._id,
  };
  const plan = buildFixturePlan({ hotel, mappings });
  const calledCodes = [];
  const results = await applyActivationPlan(plan, {
    actorId: OWNER_ID,
    updateMapping: async (req, res) => {
      const target = plan.mappings.find(
        (mapping) => mapping.mappingId === req.params.mappingId
      );
      calledCodes.push(target.invCode);
      return res.json({
        mapping: {
          _id: target.mappingId,
          localRoomTypeId: target.localRoomTypeId,
          status: "active",
          version: target.expectedPostVersion,
        },
      });
    },
  });
  assert.deepEqual(
    calledCodes,
    plan.mappings.slice(1).map(({ invCode }) => invCode)
  );
  assert.equal(results[0].changed, false);
  assert.equal(
    results.slice(1).every((result) => result.changed === true),
    true
  );
});

test("apply stops immediately when the controller rejects a CAS", async () => {
  const plan = buildFixturePlan();
  let calls = 0;
  await assert.rejects(
    () =>
      applyActivationPlan(plan, {
        actorId: OWNER_ID,
        updateMapping: async (_req, res) => {
          calls += 1;
          if (calls === 2) {
            return res.status(409).json({ error: "This mapping changed." });
          }
          const mapping = plan.mappings[calls - 1];
          return res.json({
            mapping: {
              _id: mapping.mappingId,
              localRoomTypeId: mapping.localRoomTypeId,
              status: "active",
              version: mapping.expectedVersion + 1,
            },
          });
        },
      }),
    /HR:1332587 activation stopped with HTTP 409/i
  );
  assert.equal(calls, 2);
});

test("postcondition verification requires every exact active target and unmapped master", () => {
  const plan = buildFixturePlan();
  const after = mappingsFixture();
  for (const [index, target] of plan.mappings.entries()) {
    after[index] = {
      ...after[index],
      status: "active",
      localRoomConfigId: target.localRoomTypeId,
      __v: target.expectedPostVersion,
      updatedBy: OWNER_ID,
      discoveredFrom: "manual",
    };
  }
  assert.equal(
    assertAppliedPostconditions(plan, after, { actorId: OWNER_ID }),
    true
  );
  const wrong = after.map((mapping) => ({ ...mapping }));
  wrong[2].localRoomConfigId = objectIdAt(59);
  assert.throws(
    () => assertAppliedPostconditions(plan, wrong, { actorId: OWNER_ID }),
    /failed exact active-mapping verification/i
  );
  const wrongActor = after.map((mapping) => ({ ...mapping }));
  wrongActor[0].updatedBy = objectIdAt(59);
  assert.throws(
    () => assertAppliedPostconditions(plan, wrongActor, { actorId: OWNER_ID }),
    /audit-attribution verification/i
  );
});
