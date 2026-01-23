/** @format */

const express = require("express");
const router = express.Router();
const { requireSignin, isAuth, isHotelOwner } = require("../controllers/auth");
const { userById } = require("../controllers/user");
const multer = require("multer");
const upload = multer({ dest: "uploads/" });

const {
	create,
	reservationById,
	removeDuplicates_ConfirmationNumber,
	reservationSearch,
	getListOfReservations,
	totalRecordsReservations,
	singleReservation,
	reservationSearchAllList,
	reservationsList,
	reservationsList2,
	todaysCheckins,
	reservationsOccupancyRange,
	reservationsOccupancyCurrent,
	updateReservation,
	agodaDataDump,
	expediaDataDump,
	bookingDataDump,
	deleteDataSource,
	summaryBySource,
	dateReport,
	dayoverday,
	monthovermonth,
	bookingSource,
	reservationstatus,
	sendReservationEmail,
	airbnb,
	deleteByHotelId,
	singleReservationById,
	sendPaymentLinkEmail,
	reservationObjectSummary,
	CheckedOutReservations,
	janatDataDump,
	checkedoutReport,
	totalCheckoutRecords,
	totalGeneralReservationsRecords,
	generalReservationsReport,
	pendingPaymentReservations,
	commissionPaidReservations,
	ownerReport,
	ownerReservationToDate,
	CollectedReservations,
	aggregateCollectedReservations,
	syncReservationRoomTypesByDisplayName,
} = require("../controllers/reservations");

router.post("/reservations/create/:userId/:hotelId", requireSignin, create);

router.get(
	"/reservations/list/:page/:records/:filters/:hotelId/:date",
	getListOfReservations
);

router.get(
	"/checkedout-reservations/list/:page/:records/:hotelId",
	CheckedOutReservations
);

router.get(
	"/collected-reservations/list/:status/:page/:records/:hotelId",
	CollectedReservations
);

router.get(
	"/aggregated-collected-reservations/list/:status/:page/:records/:hotelId",
	aggregateCollectedReservations
);

router.get(
	"/reservations/get-total-records/:page/:records/:filters/:hotelId/:date",
	totalRecordsReservations
);

router.get(
	"/reservations/search/all-list/:searchQuery/:accountId",
	reservationSearchAllList
);
router.get("/reservations/search/:searchQuery/:accountId", reservationSearch);

router.get(
	"/reservations/remove-duplicates",
	removeDuplicates_ConfirmationNumber
);
router.post(
	"/reservations/sync-room-types-by-display-name",
	syncReservationRoomTypesByDisplayName
);

router.get(
	"/reservations/single-reservation/:reservationNumber/:hotelId/:belongsTo",
	singleReservation
);

router.get(
	"/reservations/single-reservation/:reservationId",
	singleReservationById
);

router.get(
	"/reservations/checkins-today/:hotelId/:belongsTo",
	todaysCheckins
);

router.get(
	"/reservations/occupancy/current/:hotelId/:belongsTo",
	reservationsOccupancyCurrent
);
router.get(
	"/reservations/occupancy/range/:startdate/:enddate/:hotelId/:belongsTo",
	reservationsOccupancyRange
);

router.get(
	"/reservations/:startdate/:enddate/:hotelId/:belongsTo",
	reservationsList
);
router.get(
	"/reservations/todate/ahowan/yaba/:date/:hotelId/:userMainId",
	dateReport
);

router.delete("/reservations/delete/:source", deleteDataSource);
router.delete("/reservations-deletion/:hotelId", deleteByHotelId);
router.get("/reservations/summary-by-source", summaryBySource);

router.post(
	"/reservations/agoda-data-dump/:accountId/:belongsTo",
	upload.single("file"),
	agodaDataDump
);
router.post(
	"/reservations/expedia-data-dump/:accountId/:belongsTo/:country",
	upload.single("file"),
	expediaDataDump
);
router.post(
	"/reservations/airbnb-data-dump/:accountId/:belongsTo/:country",
	upload.single("file"),
	airbnb
);
router.post(
	"/reservations/booking-data-dump/:accountId/:belongsTo",
	upload.single("file"),
	bookingDataDump
);

router.post(
	"/reservations/janat-data-dump/:accountId/:belongsTo",
	upload.single("file"),
	janatDataDump
);

router.get("/reservations2/:accountId", reservationsList2);
router.put("/reservation-update/:reservationId", updateReservation);
router.post("/send-reservation-email", sendReservationEmail);
router.post("/send-payment-link-email", sendPaymentLinkEmail);
router.get("/reservations-summary/:accountId/:date", reservationObjectSummary);

router.get(
	"/reservations-summary-checkedout/:accountId/:channel/:startDate/:endDate",
	totalCheckoutRecords
);
router.get(
	"/reservations-checkedout/:page/:records/:accountId/:channel/:startDate/:endDate",
	checkedoutReport
);

router.get(
	"/reservations-pending/:page/:records/:hotelId",
	pendingPaymentReservations
);

router.get(
	"/reservations-paid-commission/:page/:records/:hotelId",
	commissionPaidReservations
);

router.get(
	"/general-report-reservations/list/:accountId/:channel/:startDate/:endDate/:dateBy/:noshow/:cancel/:inhouse/:checkedout/:payment",
	totalGeneralReservationsRecords
);
router.get(
	"/reservations-general-report/:page/:records/:accountId/:channel/:startDate/:endDate/:dateBy/:noshow/:cancel/:inhouse/:checkedout/:payment",
	generalReservationsReport
);

//Reports
router.get("/dayoverday/:hotelId/:userMainId", dayoverday);
router.get("/monthovermonth/:hotelId/:userMainId", monthovermonth);
router.get("/bookingsource/:hotelId/:userMainId", bookingSource);
router.get("/reservationstatus/:hotelId/:userMainId", reservationstatus);
router.get("/owner-aggregation/:month/:hotelIds", ownerReport);
router.get("/owner-reservation-date/:hotelIds/:date", ownerReservationToDate);

router.param("userId", userById);
router.param("reservationId", reservationById);

module.exports = router;
