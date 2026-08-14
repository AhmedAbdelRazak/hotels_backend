/** @format */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  MANUAL_OTA_PROVIDER_BOOKING_SOURCES,
  findManualOtaCreateConflict,
  manualOtaProviderForBookingSource,
  prepareManualOtaCreateDocument,
  resolveManualOtaCreateIdentity,
} = require("./manualOtaReservationIdentity");

const EXTERNAL_CONFIRMATION = "OTA-EXAMPLE-7001";
const PMS_CONFIRMATION = "1234507001";

test("manual OTA booking-source normalization is explicit and provider scoped", () => {
  assert.equal(manualOtaProviderForBookingSource(" Agoda "), "agoda");
  assert.equal(manualOtaProviderForBookingSource("Agoda.com"), "agoda");
  assert.equal(manualOtaProviderForBookingSource("EXPEDIA"), "expedia");
  assert.equal(manualOtaProviderForBookingSource("Expedia.com"), "expedia");
  assert.equal(manualOtaProviderForBookingSource("Airbnb"), "airbnb");
  assert.equal(manualOtaProviderForBookingSource("Airbnb.com"), "airbnb");
  assert.equal(manualOtaProviderForBookingSource("Booking.com"), "booking");
  assert.equal(manualOtaProviderForBookingSource("booking"), "booking");
  assert.equal(manualOtaProviderForBookingSource("Trip.com"), "trip");
  assert.equal(manualOtaProviderForBookingSource("Trip.com V2"), "trip");
  assert.equal(manualOtaProviderForBookingSource("Tripcomv2"), "trip");
  assert.equal(manualOtaProviderForBookingSource("Ctrip"), "trip");
  assert.equal(manualOtaProviderForBookingSource("Trivago"), "trivago");
  assert.equal(manualOtaProviderForBookingSource("hotel.com"), "hotels");
  assert.equal(manualOtaProviderForBookingSource("Hotels.com"), "hotels");
  assert.equal(manualOtaProviderForBookingSource("manual"), "");
  assert.equal(manualOtaProviderForBookingSource("janat"), "");
  assert.deepEqual(MANUAL_OTA_PROVIDER_BOOKING_SOURCES.booking, [
    "booking",
    "booking.com",
    "booking com",
    "bookingcom",
  ]);
	assert.deepEqual(MANUAL_OTA_PROVIDER_BOOKING_SOURCES.trip, [
		"trip",
		"trip.com",
		"trip com",
		"tripcom",
		"trip.com v2",
		"trip com v2",
		"trip.comv2",
		"tripcomv2",
		"ctrip",
	]);
});

test("recognized OTA creation requires only the explicit external confirmation field", () => {
  assert.throws(
    () => resolveManualOtaCreateIdentity({ booking_source: "agoda" }),
    (error) => error.code === "manual_ota_external_confirmation_required"
  );
  assert.throws(
    () =>
      resolveManualOtaCreateIdentity({
        booking_source: "agoda",
        confirmation_number: EXTERNAL_CONFIRMATION,
        customer_details: {
          confirmation_number2: EXTERNAL_CONFIRMATION,
        },
      }),
    (error) =>
      error.code === "manual_ota_identity_ambiguous" &&
      error.fields.includes("confirmation_number")
  );
  assert.throws(
    () =>
      resolveManualOtaCreateIdentity({
        booking_source: "booking.com",
        customer_details: {
          confirmation_number2: EXTERNAL_CONFIRMATION,
        },
        supplierData: {
          otaConfirmationNumber: EXTERNAL_CONFIRMATION,
          confirmationNumber: "SECOND-UNTRUSTED-ALIAS",
        },
      }),
    (error) =>
      error.code === "manual_ota_identity_ambiguous" &&
      error.fields.includes("supplierData.otaConfirmationNumber") &&
      error.fields.includes("supplierData.confirmationNumber")
  );
  assert.throws(
    () =>
      resolveManualOtaCreateIdentity({
        booking_source: "agoda",
        customer_details: {
          confirmation_number2: EXTERNAL_CONFIRMATION,
        },
        supplierData: {
          hotelRunner: { providerNumber: EXTERNAL_CONFIRMATION },
        },
      }),
    (error) =>
      error.code === "manual_ota_identity_ambiguous" &&
      error.fields.includes("supplierData.hotelRunner.providerNumber")
  );
  assert.throws(
    () =>
      resolveManualOtaCreateIdentity({
        booking_source: "agoda",
        customer_details: {
          confirmation_number2: EXTERNAL_CONFIRMATION,
          reservationId: "UNTRUSTED-ALIAS",
          hrNumber: "UNTRUSTED-HR",
        },
        customerDetails: { confirmationNumber2: "SECOND-ALIAS" },
      }),
    (error) =>
      error.code === "manual_ota_identity_ambiguous" &&
      error.fields.includes("customer_details.reservationId") &&
      error.fields.includes("customer_details.hrNumber") &&
      error.fields.includes("customerDetails.confirmationNumber2")
  );
});

test("recognized OTA creation allocates PMS identity and preserves every external alias", async () => {
  const original = {
    booking_source: "Booking.com",
    hotelId: "hotel-1",
    customer_details: {
      name: "Example Guest",
      confirmation_number2: EXTERNAL_CONFIRMATION,
    },
  };
  const result = await prepareManualOtaCreateDocument({
    document: original,
    generateConfirmation: async (attempts, reserved) => {
      assert.equal(attempts, 25);
      assert.deepEqual(reserved, [
        EXTERNAL_CONFIRMATION,
        "booking:ota-example-7001",
      ]);
      return PMS_CONFIRMATION;
    },
  });

  assert.equal(result.identity.provider, "booking");
  assert.equal(result.document.confirmation_number, PMS_CONFIRMATION);
  assert.equal(result.document.pms_number, PMS_CONFIRMATION);
  assert.equal(result.document.reservation_id, EXTERNAL_CONFIRMATION);
  assert.equal(result.document.otaIdentityKey, "booking:ota-example-7001");
  assert.equal(
    result.document.customer_details.confirmation_number2,
    EXTERNAL_CONFIRMATION
  );
  assert.equal(result.document.supplierData.otaProvider, "booking");
  assert.equal(
    result.document.supplierData.otaConfirmationNumber,
    EXTERNAL_CONFIRMATION
  );
  assert.equal(
    result.document.supplierData.pmsConfirmationNumber,
    PMS_CONFIRMATION
  );
  assert.equal(original.confirmation_number, undefined);
  assert.equal(original.customer_details.name, "Example Guest");
});

test("Trip, Trivago, and Hotel.com receive stable namespaces through full preparation", async () => {
  for (const fixture of [
	{
		source: "trip.com",
		provider: "trip",
		identityKey: "trip:ota-example-7001",
		supplierName: "Trip.com",
	},
    {
      source: "trivago",
      provider: "trivago",
      identityKey: "trivago:ota-example-7001",
      supplierName: "Trivago",
    },
    {
      source: "hotel.com",
      provider: "hotels",
      identityKey: "hotels:ota-example-7001",
      supplierName: "Hotels.com",
    },
  ]) {
    // eslint-disable-next-line no-await-in-loop
    const result = await prepareManualOtaCreateDocument({
      document: {
        booking_source: fixture.source,
        customer_details: {
          confirmation_number2: EXTERNAL_CONFIRMATION,
        },
      },
      generateConfirmation: async () => PMS_CONFIRMATION,
    });
    assert.equal(result.identity.provider, fixture.provider);
    assert.equal(result.document.otaIdentityKey, fixture.identityKey);
    assert.equal(
      result.document.supplierData.supplierName,
      fixture.supplierName
    );
    assert.equal(result.document.confirmation_number, PMS_CONFIRMATION);
    assert.notEqual(
      result.document.confirmation_number,
      result.document.customer_details.confirmation_number2
    );
  }
});

test("non-OTA creation preserves caller canonical behavior and never allocates", async () => {
  const manual = {
    booking_source: "manual",
    confirmation_number: "MANUAL-CONF-1",
    customer_details: { name: "Example Guest" },
  };
  let allocatorCalls = 0;
  const result = await prepareManualOtaCreateDocument({
    document: manual,
    generateConfirmation: async () => {
      allocatorCalls += 1;
      return PMS_CONFIRMATION;
    },
  });

  assert.equal(result.identity, null);
  assert.equal(result.document, manual);
  assert.equal(result.document.confirmation_number, "MANUAL-CONF-1");
  assert.equal(allocatorCalls, 0);
});

test("manual OTA conflict detection finds an exact global provider identity", async () => {
  let findCalls = 0;
  const existing = { _id: "existing-ota" };
  const ReservationModel = {
    find(filter) {
      findCalls += 1;
      const results = filter.otaIdentityKey ? [existing] : [];
      return {
        limit: () => ({ exec: async () => results }),
      };
    },
  };
  const identity = resolveManualOtaCreateIdentity({
    booking_source: "expedia",
    customer_details: { confirmation_number2: EXTERNAL_CONFIRMATION },
  });
  const conflict = await findManualOtaCreateConflict({
    document: {
      booking_source: "expedia",
      hotelId: "hotel-1",
    },
    identity,
    ReservationModel,
  });

  assert.equal(findCalls, 2);
  assert.equal(conflict, existing);
});

test("generic create controller wires OTA preparation, conflict check, and final invariant", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../controllers/reservations.js"),
    "utf8"
  );
  assert.match(source, /prepareManualOtaCreateDocument\(\{/);
  assert.match(source, /findManualOtaCreateConflict\(\{/);
  assert.match(
    source,
    /assertReservationPmsConfirmationDistinct\(reservationPayload\)[\s\S]+?reservations\.save\(\)/
  );
});
