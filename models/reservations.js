/** @format */

const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema;

const reservationsSchema = new mongoose.Schema(
	{
		reservation_id: {
			type: String, //Could be left blank
			trim: true,
			lowercase: true,
			default: "",
		},

		hr_number: {
			type: String, //Could be left blank
			trim: true,
			lowercase: true,
			default: "",
		},

		confirmation_number: {
			type: String, //Exist in the file
			trim: true,
			lowercase: true,
			required: true,
			unique: true,
		},
		pms_number: {
			type: String, //could be left blank
			trim: true,
			lowercase: true,
			default: "",
		},
		booking_source: {
			type: String, //Will be added but based on the file
			trim: true,
			lowercase: true,
			default: "",
		},
		customer_details: {
			type: Object, //This is based on the mapping you did in the 3 files, whatever doesn't exist, then leave blank
			trim: true,
			default: {
				name: "", // firstname + lastname
				phone: "", //address.phone
				email: "", //address.email
				passport: "", //guest_national_id
				passportExpiry: "",
				nationality: "", //country
				copyNumber: "",
				cardNumber: "", // Should be hashed, no access to anyone for security
				cardExpiryDate: "", // Should be hashed, no access to anyone for security
				cardCVV: "", // Should be hashed, no access to anyone for security
				cardHolderName: "", // Should be hashed, no access to anyone for security
				hasCar: "no",
				carLicensePlate: "",
				carColor: "",
				carModel: "",
				carYear: "",
			},
		},
		state: {
			type: String, // could be left as default "confirmed"
			trim: true,
			lowercase: true,
			default: "confirmed",
		},
		reservation_status: {
			type: String, // is the status
			trim: true,
			lowercase: true,
			default: "confirmed",
		},
		total_guests: {
			type: Number, //use the mapping
			default: 1,
		},
		adults: {
			type: Number, //use the mapping
			default: 1,
		},
		children: {
			type: Number, //use the mapping
			default: 0,
		},
		pickedRoomsPricing: {
			type: Array, //This will be discussed later
			default: [],
		},
		total_rooms: {
			type: Number,
			default: 1,
		},

		cancel_reason: {
			type: String, //if exist in any of the headers I gave you then add it
			trim: true,
			lowercase: true,
			default: "",
		},
		booked_at: {
			type: Date, //In the file in the 3 file in the headers
			trim: true,
			lowercase: true,
			default: new Date(),
		},

		inhouse_date: {
			type: Date, //This could be left blank
			trim: true,
			lowercase: true,
			default: "",
		},

		sub_total: {
			type: Number, //Those can be added based on the file headers I gave you
			trim: true,
			lowercase: true,
			default: 0,
		},
		extras_total: {
			type: Number,
			trim: true,
			lowercase: true,
			default: 0,
		},

		tax_total: {
			type: Number,
			trim: true,
			lowercase: true,
			default: 0,
		},
		total_amount: {
			type: Number, // This is important in which it should reflect the total amount the guest should pay
			trim: true,
			lowercase: true,
			default: 0,
		},
		paypal_details: {
			type: Object, //Could be left blank for now
		},
		currency: {
			type: String, //Blank
			trim: true,
			lowercase: true,
			default: "SAR",
		},
		checkin_date: {
			type: Date,
			default: "",
		},
		checkout_date: {
			type: Date,
			default: "",
		},
		days_of_residence: {
			type: Number, //It should be calculated the difference between checkout and checkin
			default: 0,
		},

		comment: {
			type: String, //If there is a comment, then add it
			trim: true,
			lowercase: true,
			default: "",
		},

		financeStatus: {
			type: String,
			trim: true,
			lowercase: true,
			default: "not paid",
		},

		payment: {
			type: String, //PaymentModel, Payment type,
			trim: true,
			lowercase: true,
			default: "",
		},
		payment_details: {
			type: Object, //Could be left blank for now
			trim: true,
			lowercase: true,
		},
		vcc_payment: {
			type: Object,
			default: {
				source: "",
				charged: false,
				processing: false,
				charge_count: 0,
				attempts_count: 0,
				failed_attempts_count: 0,
				blocked_after_failure: false,
				total_captured_usd: 0,
				total_captured_sar: 0,
				last_attempt_at: null,
				last_success_at: null,
				last_failure_at: null,
				last_failure_message: "",
				last_failure_code: "",
				warning_message: "",
				last_capture: {},
				metadata: {},
				attempts: [],
			},
		},
		braintree_payment: {
			type: Object,
			default: {
				source: "",
				charged: false,
				processing: false,
				charge_count: 0,
				attempts_count: 0,
				failed_attempts_count: 0,
				blocked_after_failure: false,
				total_captured_usd: 0,
				last_attempt_at: null,
				last_success_at: null,
				last_failure_at: null,
				last_failure_message: "",
				last_failure_code: "",
				last_transaction_id: "",
				last_status: "",
				last_processor_response_code: "",
				last_processor_response_text: "",
				last_gateway_rejection_reason: "",
				warning_message: "",
				last_capture: {},
				metadata: {},
				attempts: [],
			},
		},
		bofa_payment: {
			type: Object,
			default: {
				secure_acceptance: {
					last_signed_at: null,
					last_reference_number: "",
					last_transaction_uuid: "",
					last_callback_at: null,
					last_callback_source: "",
					last_response_signature_valid: null,
					last_request_id: "",
					last_transaction_id: "",
					last_reason_code: "",
					last_decision: "",
					last_response_payload: {},
					callbacks: [],
				},
				vcc: {
					source: "",
					charged: false,
					processing: false,
					charge_count: 0,
					attempts_count: 0,
					failed_attempts_count: 0,
					blocked_after_failure: false,
					total_captured_usd: 0,
					total_captured_sar: 0,
					last_attempt_at: null,
					last_success_at: null,
					last_failure_at: null,
					last_failure_message: "",
					last_failure_code: "",
					last_failure_http_status: null,
					last_request_id: "",
					last_transaction_id: "",
					last_reconciliation_id: "",
					last_processor_response_code: "",
					last_processor_response_details: "",
					warning_message: "",
					last_capture: {},
					metadata: {},
					attempts: [],
				},
			},
		},
		paid_amount: {
			type: Number, //Could be left as default
			trim: true,
			lowercase: true,
			default: 0,
		},

		paid_amount_breakdown: {
			type: Object, //Could be left as default
			default: {
				paid_online_via_link: 0,
				paid_at_hotel_cash: 0,
				paid_at_hotel_card: 0,
				paid_to_hotel: 0,
				paid_online_jannatbooking: 0,
				paid_online_other_platforms: 0,
				paid_online_via_instapay: 0,
				paid_no_show: 0,
				payment_comments: "",
			},
		},

		commission: {
			type: Number,
			default: 0,
		},

		commissionPaid: {
			type: Boolean,
			default: false,
		},

		commissionStatus: {
			type: String,
		},

		commissionData: {
			type: Object,
		},
		commissionPaidAt: { type: Date },

		commissionAgentApproval: {
			type: Object,
			default: {
				required: false,
				status: "not_required",
				requestedAt: null,
				requestedBy: null,
				approvedAt: null,
				approvedBy: null,
				rejectedAt: null,
				rejectedBy: null,
				rejectionReason: "",
				lastUpdatedAt: null,
				lastUpdatedBy: null,
			},
		},

		pendingConfirmation: {
			type: Object,
			default: {
				status: "",
				rejectionReason: "",
				confirmationReason: "",
				confirmedAt: null,
				rejectedAt: null,
				lastUpdatedAt: null,
				lastUpdatedBy: null,
			},
		},

		agentWalletSnapshot: {
			type: Object,
			default: {
				// Captures the agent wallet at reservation time so reservation details
				// never change just because the agent wallet changes later.
				captured: false,
				capturedAt: null,
				snapshotAt: null,
				capturedReason: "",
				currency: "SAR",
				agent: {
					_id: "",
					name: "",
					email: "",
					phone: "",
					companyName: "",
				},
				walletAddedBeforeReservation: 0,
				walletUsedBeforeReservation: 0,
				priorReservationValue: 0,
				manualDebitsBeforeReservation: 0,
				balanceBeforeReservation: 0,
				reservationAmount: 0,
				balanceAfterReservation: 0,
				commissionAmount: 0,
				bookingSource: "",
				confirmationNumber: "",
				capturedBy: null,
			},
		},

		agentDecisionSnapshot: {
			type: Object,
			default: {
				// Last confirmation decision shown in reservation details.
				status: "",
				reason: "",
				decidedAt: null,
				decidedBy: null,
			},
		},

		financial_cycle: {
			type: Object,
			default: {
				// PMS reconciliation snapshot for this reservation.
				// If the PMS collected the money, moneyTransferredToHotel closes the cycle.
				// If the hotel collected the money, commissionPaid closes the cycle.
				collectionModel: "pending",
				status: "open",
				commissionType: "amount",
				commissionValue: 0,
				commissionAmount: 0,
				// true means finance reviewed commission, even when amount is 0.
				commissionAssigned: false,
				commissionAssignedAt: null,
				commissionAssignedBy: null,
				pmsCollectedAmount: 0,
				hotelCollectedAmount: 0,
				hotelPayoutDue: 0,
				commissionDueToPms: 0,
				closedAt: null,
				closedBy: null,
				notes: "",
				lastUpdatedAt: null,
				lastUpdatedBy: null,
			},
		},

		pickedRoomsType: {
			type: Array,
			default: [
				{
					room_type: "", // "name" from rooms array
					chosenPrice: "", //"total" from the rooms array
					count: 1, // leave the default because each object in the rooms array is supposed to be only 1 room
					pricingByDay: [],
				},
			],
		},
		roomId: [{ type: ObjectId, ref: "Rooms", default: null }], //This could be left
		bedNumber: {
			type: Array, //If the guest chose to rent only a bed in a room
			trim: true,
			lowercase: true,
			default: [],
		},
		belongsTo: { type: ObjectId, ref: "User" }, //this will be taken care of later
		hotelId: { type: ObjectId, ref: "HotelDetails" }, //this will be taken care of later
		housedBy: {
			type: Object,
			default: {
				name: "",
			},
		},
		createdByUserId: {
			type: ObjectId,
			ref: "User",
			default: null,
		},
		createdBy: {
			type: Object,
			default: {
				_id: "",
				name: "",
				email: "",
				role: "",
				roleDescription: "",
			},
		},
		// Tracks the PMS user who originally took/created the reservation.
		orderTakeId: {
			type: ObjectId,
			ref: "User",
			default: null,
		},
		orderTaker: {
			type: Object,
			default: {
				_id: "",
				name: "",
				email: "",
				role: "",
				roleDescription: "",
			},
		},
		orderTakenAt: { type: Date, default: null },
		moneyTransferredToHotel: {
			type: Boolean,
			default: false,
		},

		guestAgreedOnTermsAndConditions: {
			type: Boolean,
			default: false,
		},
		affiliateReservation: {
			type: Boolean,
			default: false,
		},
		affiliateData: {
			type: Object,
			trim: true,
			lowercase: true,
			default: {
				name: "",
				phone: "",
			},
		},

		supplierData: {
			type: Object,
			trim: true,
			lowercase: true,
			default: {
				supplierName: "",
				suppliedBookingNo: "",
			},
		},
		advancePayment: {
			type: Object,
			trim: true,
			lowercase: true,
			default: {
				paymentPercentage: "",
				finalAdvancePayment: "",
			},
		},
		wholeSaleReservation: {
			type: Boolean,
			default: false,
		},

		moneyTransferredAt: { type: Date, default: null },

		// Who/when last changed any payout/commission toggle
		adminLastUpdatedAt: { type: Date, default: null },
		adminLastUpdatedBy: {
			_id: { type: ObjectId, ref: "User" },
			name: { type: String },
			role: { type: String, default: "admin" },
		},

		// Append-only journal of changes to payout/commission fields
		// Each entry: { at, by: {_id,name,role}, field, from, to, note }
		adminChangeLog: { type: Array, default: [] },

		// General PMS reservation tracker. This records housing, finance,
		// commission, and manual reservation edits for auditability.
		reservationAuditLog: { type: Array, default: [] },
	},
	{ timestamps: true },
);

reservationsSchema.index({ reservation_id: 1 }, { sparse: true });
reservationsSchema.index(
	{ "customer_details.confirmation_number2": 1 },
	{ sparse: true },
);
reservationsSchema.index(
	{ "supplierData.suppliedBookingNo": 1 },
	{ sparse: true },
);
reservationsSchema.index(
	{ "supplierData.otaConfirmationNumber": 1 },
	{ sparse: true },
);
reservationsSchema.index(
	{ "supplierData.platformConfirmationNumber": 1 },
	{ sparse: true },
);

module.exports = mongoose.model("Reservations", reservationsSchema);
