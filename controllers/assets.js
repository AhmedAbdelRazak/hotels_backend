const moment = require("moment-timezone");

const confirmationEmail = (reservationData) => {
	const customerDetails = reservationData.customer_details || {};
	const pickedRoomsType = Array.isArray(reservationData.pickedRoomsType)
		? reservationData.pickedRoomsType
		: [];
	// Convert dates to Saudi Arabia time zone
	const checkinDateSaudi = moment(reservationData.checkin_date)
		.tz("Asia/Riyadh")
		.format("dddd, MMMM Do YYYY");
	const checkoutDateSaudi = moment(reservationData.checkout_date)
		.tz("Asia/Riyadh")
		.format("dddd, MMMM Do YYYY");
	const bookedAtSaudi = moment(reservationData.booked_at)
		.tz("Asia/Riyadh")
		.format("dddd, MMMM Do YYYY");

	const checkinDate = moment(reservationData.checkin_date).tz("Asia/Riyadh");
	const checkoutDate = moment(reservationData.checkout_date).tz("Asia/Riyadh");

	const nightsOfResidence = checkoutDate.diff(checkinDate, "days");
	const totalAmount = Number(reservationData.total_amount || 0);
	const paidAmount = Number(reservationData.paid_amount || 0);
	const baseUrl = (
		process.env.PUBLIC_CLIENT_URL ||
		process.env.CLIENT_URL ||
		""
	).replace(/\/$/, "");
	const confirmationLink = `${baseUrl}/single-reservation/${reservationData.confirmation_number || ""}`;
	const paymentLink =
		reservationData?._id && reservationData?.confirmation_number
			? `${baseUrl}/client-payment/${reservationData._id}/${reservationData.confirmation_number}`
			: "";
	const shouldShowPaymentLink = paidAmount < totalAmount && !!paymentLink;

	const email = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Reservation Confirmation</title>
        <style>
            body { font-family: Arial, sans-serif; margin: 0; padding: 0; background-color: #f2f4f8; }
            .container { background-color: #fff; width: 100%; max-width: 700px; margin: 24px auto; padding: 24px; border-radius: 10px; box-shadow: 0 4px 10px rgba(0,0,0,0.06); }
            .header { background: #1e2332; color: #ffffff; padding: 18px; text-align: center; border-radius: 8px; }
            .content { padding: 18px 6px; text-align: left; color: #1f2937; line-height: 1.6; }
            .footer { text-align: center; font-size: 0.9rem; color: #6b7280; margin-top: 16px; }
            .roomType { font-weight: bold; text-transform: capitalize; }
            table { width: 100%; border-collapse: collapse; margin-top: 12px; }
            th, td { border: 1px solid #e5e7eb; padding: 8px; text-align: left; }
            th { background-color: #1e2332; color: #ffffff; }
            h2 { font-weight: bold; font-size: 1.4rem; margin-bottom: 6px; }
            strong { font-weight: bold; }
            .confirmation { font-size: 1rem; font-weight: bold; }
            .muted { color: #6b7280; font-size: 0.9rem; }
            .button-wrap { text-align: center; margin: 16px 0 8px; }
            .button {
                display: inline-block;
                background: #0f172a;
                color: #ffffff !important;
                text-decoration: none;
                padding: 10px 18px;
                border-radius: 6px;
                font-weight: 700;
            }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <h1>Reservation Confirmation</h1>
            </div>
            <div>
                <h2>${(reservationData.hotelName || "Jannat Booking").toUpperCase()} Hotel</h2>
            </div>
            <div class="content">
            <p class="confirmation"><strong>Confirmation Number:</strong> ${
							reservationData.confirmation_number
						}</p>
                <p><strong>Guest Name:</strong> ${customerDetails.name || "N/A"}</p>
                <p><strong>Reservation Status:</strong> ${
									reservationData.reservation_status || "N/A"
								}</p>
                <p><strong>Country:</strong> ${customerDetails.nationality || "N/A"}</p>
                <table>
                    <tr>
                        <th>Room Type</th>
                        <td class="roomType">${pickedRoomsType
													.map((room) => room.room_type)
													.join(", ")}</td>
                    </tr>
                    <tr>
                        <th>Room Count</th>
                        <td class="roomType">${pickedRoomsType.reduce(
													(sum, item) => sum + (item.count || 0),
													0
												)}</td>
                    </tr>
                    <tr>
                        <th>Check-in Date</th>
                        <td>${checkinDateSaudi}</td>
                    </tr>
                    <tr>
                        <th>Check-out Date</th>
                        <td>${checkoutDateSaudi}</td>
                    </tr>
                    <tr>
                        <th>Nights Of Residence</th>
                        <td>${nightsOfResidence} Nights</td>
                    </tr>
                    <tr>
                        <th>Guest Count</th>
                        <td>${reservationData.total_guests}</td>
                    </tr>
                    <tr>
                        <th>Payment Status</th>
                        <td>${reservationData.payment}</td>
                    </tr>
                    <tr>
                    <th>Paid Amount</th>
                    <td>${paidAmount.toLocaleString()}</td>
                    </tr>

                    <tr>
                        <th>Order Total</th>
                        <td>${totalAmount.toLocaleString()} SAR</td>
                    </tr>
                    <tr>
                     <th>Amount Due</th>
                    <td>${Number(
											Number(totalAmount) - Number(paidAmount)
										).toLocaleString()} SAR</td>
                    </tr>
                </table>
                <p class="muted"><strong>Booking Date:</strong> ${bookedAtSaudi}</p>
                <div class="button-wrap">
                    <a class="button" href="${confirmationLink}" target="_blank" rel="noopener noreferrer">
                        View Your Reservation
                    </a>
                </div>
                <p class="muted" style="text-align:center; margin: 6px 0 12px;">
                    Receipt link: <a href="${confirmationLink}" target="_blank" rel="noopener noreferrer">${confirmationLink}</a>
                </p>
                ${
									shouldShowPaymentLink
										? `
                <div class="button-wrap">
                    <a class="button" href="${paymentLink}" target="_blank" rel="noopener noreferrer">
                        Complete Your Payment
                    </a>
                </div>
                <p class="muted" style="text-align:center; margin: 6px 0 12px;">
                    Payment link: <a href="${paymentLink}" target="_blank" rel="noopener noreferrer">${paymentLink}</a>
                </p>
                `
										: ""
								}
            </div>
            <div class="footer">
                <p>Thank you for booking with Jannat Booking.</p>
                <p>If you have any questions, contact support@jannatbooking.com</p>
            </div>
        </div>
    </body>
    </html>
    `;

	return email;
};

const reservationUpdate = (reservationData, hotelName) => {
	const customerDetails = reservationData.customer_details || {};
	const pickedRoomsType = Array.isArray(reservationData.pickedRoomsType)
		? reservationData.pickedRoomsType
		: [];
	// Convert dates to Saudi Arabia time zone
	const checkinDateSaudi = moment(reservationData.checkin_date)
		.tz("Asia/Riyadh")
		.format("dddd, MMMM Do YYYY");
	const checkoutDateSaudi = moment(reservationData.checkout_date)
		.tz("Asia/Riyadh")
		.format("dddd, MMMM Do YYYY");
	const bookedAtSaudi = moment(reservationData.booked_at)
		.tz("Asia/Riyadh")
		.format("dddd, MMMM Do YYYY");

	const checkinDate = moment(reservationData.checkin_date).tz("Asia/Riyadh");
	const checkoutDate = moment(reservationData.checkout_date).tz("Asia/Riyadh");

	const nightsOfResidence = checkoutDate.diff(checkinDate, "days");

	const email = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Reservation Confirmation Update</title>
        <style>
            body { font-family: Arial, sans-serif; margin: 0; padding: 0; background-color: #f2f4f8; }
            .container { background-color: #fff; width: 100%; max-width: 700px; margin: 24px auto; padding: 24px; border-radius: 10px; box-shadow: 0 4px 10px rgba(0,0,0,0.06); }
            .header { background: #1e2332; color: #ffffff; padding: 18px; text-align: center; border-radius: 8px; }
            .content { padding: 18px 6px; text-align: left; color: #1f2937; line-height: 1.6; }
            .footer { text-align: center; font-size: 0.9rem; color: #6b7280; margin-top: 16px; }
            .roomType { font-weight: bold; text-transform: capitalize; }
            table { width: 100%; border-collapse: collapse; margin-top: 12px; }
            th, td { border: 1px solid #e5e7eb; padding: 8px; text-align: left; }
            th { background-color: #1e2332; color: #ffffff; }
            h2 { font-weight: bold; font-size: 1.4rem; margin-bottom: 6px; }
            strong { font-weight: bold; }
            .confirmation { font-size: 1rem; font-weight: bold; }
            .muted { color: #6b7280; font-size: 0.9rem; }
        </style>
    </head>
    <body>
    <div class="container">
        <div class="header">
            <h1>Reservation Update</h1>
        </div>
        <div>
            <h2>${String(hotelName || "Jannat Booking").toUpperCase()} Hotel</h2>
        </div>
        <div class="content">
        <p class="confirmation"><strong>Confirmation Number:</strong> ${
					reservationData.confirmation_number
				}</p>
            <p><strong>Guest Name:</strong> ${customerDetails.name || "N/A"}</p>
          
                        <p><strong>Reservation Status:</strong> ${
													reservationData.reservation_status
												}</p>
            <p><strong>Country:</strong> ${customerDetails.nationality || "N/A"}</p>
            <table>
                <tr>
                    <th>Room Type</th>
                    <td class="roomType">${pickedRoomsType
											.map((room) => room.room_type)
											.join(", ")}</td>
                </tr>
               
                <tr>
                <th>Room Count</th>
                <td class="roomType">${pickedRoomsType.reduce(
									(sum, item) => sum + (item.count || 0),
									0
								)}</td>
                </tr>
                
                <tr>
                <th>Check-in Date</th>
                <td>${checkinDateSaudi}</td>
            </tr>
            <tr>
                <th>Check-out Date</th>
                <td>${checkoutDateSaudi}</td>
            </tr>
                <tr>
                <th>Nights Of Residence</th>
                <td>${nightsOfResidence} Nights</td>
                </tr>
            <tr>
                <th>Guest Count</th>
                <td>${reservationData.total_guests}</td>
            </tr>
            <tr>
                <th>Payment Status</th>
                <td>${reservationData.payment}</td>
            </tr>
            <th>Paid Amount</th>
            <td>${reservationData.paid_amount}</td>
            </tr>
                <tr>
                    <th>Order Total</th>
                    <td>${reservationData.total_amount.toLocaleString()} SAR</td>
                </tr>
                <tr>
                <th>Amount Due</th>
               <td>${Number(
									Number(reservationData.total_amount) -
										Number(reservationData.paid_amount)
								).toLocaleString()} SAR</td>
               </tr>
            </table>
            <p class="muted"><strong>Booking Date:</strong> ${bookedAtSaudi}</p>
        </div>
        <div class="footer">
            <p>Thank you for choosing Jannat Booking.</p>
            <p>If you have any questions, contact support@jannatbooking.com</p>
        </div>
    </div>
    </body>
    </html>
    `;

	return email;
};

const emailPaymentLink = (paymentLinkOrPayload, maybePayload = {}) => {
	const payload =
		typeof paymentLinkOrPayload === "string"
			? { paymentLink: paymentLinkOrPayload, ...maybePayload }
			: paymentLinkOrPayload || {};

	const {
		paymentLink,
		guestName,
		hotelName,
		confirmationNumber,
		totalAmount,
		paidAmount,
		currency = "SAR",
		checkinDate,
		checkoutDate,
	} = payload;

	const safeNumber = (v) => {
		const n = Number(v);
		return Number.isFinite(n) ? n : 0;
	};
	const formatMoney = (v) => safeNumber(v).toLocaleString();
	const dueAmount =
		safeNumber(totalAmount) > 0
			? Math.max(safeNumber(totalAmount) - safeNumber(paidAmount), 0)
			: null;
	const firstName = String(guestName || "Guest").trim().split(" ")[0] || "Guest";
	const formatDate = (d) =>
		d ? moment(d).tz("Asia/Riyadh").format("dddd, MMMM Do YYYY") : "N/A";

	const email = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Reservation Payment Link</title>
        <style>
            body { font-family: Arial, sans-serif; margin: 0; padding: 0; background-color: #f2f4f8; }
            .container { background-color: #ffffff; width: 100%; max-width: 700px; margin: 24px auto; padding: 24px; border-radius: 10px; box-shadow: 0 4px 10px rgba(0,0,0,0.06); }
            .header { background: #1e2332; color: #ffffff; padding: 18px; text-align: center; border-radius: 8px; }
            .content { padding: 18px 6px; color: #1f2937; line-height: 1.6; }
            .title { font-size: 1.4rem; font-weight: 700; margin: 0; }
            .subtitle { font-size: 0.95rem; opacity: 0.9; margin-top: 6px; }
            .summary { margin: 16px 0; padding: 14px; background: #f8fafc; border-radius: 8px; border: 1px solid #e5e7eb; }
            .summary p { margin: 6px 0; }
            .button-wrap { text-align: center; margin: 22px 0 8px; }
            .button { display: inline-block; background: #0f172a; color: #ffffff !important; text-decoration: none; padding: 12px 22px; border-radius: 6px; font-weight: 700; }
            .muted { color: #6b7280; font-size: 0.9rem; }
            .footer { text-align: center; font-size: 0.85rem; color: #6b7280; margin-top: 18px; }
            .link { color: #2563eb; word-break: break-all; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <div class="title">Secure Payment Link</div>
                <div class="subtitle">Jannat Booking</div>
            </div>
            <div class="content">
                <p>Hi ${firstName},</p>
                <p>Thank you for choosing Jannat Booking. Please use the secure link below to complete your payment.</p>

                <div class="summary">
                    <p><strong>Hotel:</strong> ${hotelName || "N/A"}</p>
                    <p><strong>Confirmation #:</strong> ${confirmationNumber || "N/A"}</p>
                    <p><strong>Check-in:</strong> ${formatDate(checkinDate)}</p>
                    <p><strong>Check-out:</strong> ${formatDate(checkoutDate)}</p>
                    ${
											safeNumber(totalAmount) > 0
												? `<p><strong>Total Amount:</strong> ${formatMoney(
														totalAmount,
													)} ${currency}</p>`
												: ""
										}
                    ${
											dueAmount != null
												? `<p><strong>Amount Due:</strong> ${formatMoney(
														dueAmount,
													)} ${currency}</p>`
												: ""
										}
                </div>

                <div class="button-wrap">
                    <a class="button" href="${paymentLink}" target="_blank" rel="noopener noreferrer">
                        Pay Securely
                    </a>
                </div>

                <p class="muted">If the button does not work, copy and paste this link into your browser:</p>
                <p class="link">${paymentLink}</p>
            </div>
            <div class="footer">
                If you have any questions, contact us at support@jannatbooking.com
            </div>
        </div>
    </body>
    </html>
`;

	return email;
};

const paymentReceipt = (
	updatedReservation,
	hotelName,
	amountFromTheClient,
	transactionDetails
) => {
	// Convert dates to Saudi Arabia time zone
	const checkinDateSaudi = moment(updatedReservation.checkin_date)
		.tz("Asia/Riyadh")
		.format("dddd, MMMM Do YYYY");
	const checkoutDateSaudi = moment(updatedReservation.checkout_date)
		.tz("Asia/Riyadh")
		.format("dddd, MMMM Do YYYY");
	const bookedAtSaudi = moment(updatedReservation.booked_at)
		.tz("Asia/Riyadh")
		.format("dddd, MMMM Do YYYY");

	const checkinDate = moment(reservationData.checkin_date).tz("Asia/Riyadh");
	const checkoutDate = moment(reservationData.checkout_date).tz("Asia/Riyadh");

	const nightsOfResidence = checkoutDate.diff(checkinDate, "days");

	const email = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Reservation Confirmation Update</title>
        <style>
            body { font-family: Arial, sans-serif; margin: 0; padding: 0; background-color: #c5ddf6; }
            .container { background-color: #fff; width: 100%; max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background: #1e2332; color: white; padding: 10px; text-align: center; }
            .content { padding-right: 20px; padding-left: 20px; text-align: left; }
            .footer { background: #ddd; padding: 10px; text-align: center; font-size: 14px; font-weight: bold; }
            .roomType { font-weight: bold; text-transform: capitalize; }
            table { width: 100%; border-collapse: collapse; }
            th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
            th { background-color: #1e2332; color: white; }
            h2 { font-weight: bold; font-size: 1.5rem; }
            strong { font-weight: bold; }
            .confirmation {
                font-size: 1rem;
                font-weight: bold;
            }
            h3 { font-weight: bold; font-size: 1.3rem; }
            h4 { font-weight: bold; font-size: 1.1rem; }

        </style>
    </head>
    <body>
    <div class="container">
        <div class="header">
            <h1>Reservation Payment Receipt</h1>
        </div>
        <div>
            <h2>${hotelName.toUpperCase()} Hotel</h2>
        </div>
        <h3>Thank you for your payment!</h3>
        <h4>Your Payment Receipt #: ${transactionDetails.transactionId}</h4>

        <div class="content">
        <p class="confirmation"><strong>Confirmation Number:</strong> ${
					updatedReservation.confirmation_number
				}</p>
            <p><strong>Guest Name:</strong> ${
							updatedReservation.customer_details.name
						}</p>
          
                        <p><strong>Reservation Status:</strong> ${
													updatedReservation.reservation_status
												}</p>
            <p><strong>Country:</strong> ${
							updatedReservation.customer_details.nationality
						}</p>
            <table>
                <tr>
                    <th>Room Type</th>
                    <td class="roomType">${updatedReservation.pickedRoomsType
											.map((room) => room.room_type)
											.join(", ")}</td>
                </tr>
               
                <tr>
                <th>Room Count</th>
                <td class="roomType">${updatedReservation.pickedRoomsType.reduce(
									(sum, item) => sum + (item.count || 0),
									0
								)}</td>
                </tr>
                
                <tr>
                <th>Check-in Date</th>
                <td>${checkinDateSaudi}</td>
            </tr>
            <tr>
                <th>Check-out Date</th>
                <td>${checkoutDateSaudi}</td>
            </tr>
                <tr>
                <th>Nights Of Residence</th>
                <td>${nightsOfResidence} Nights</td>
            </tr>
            <tr>
                <th>Guest Count</th>
                <td>${updatedReservation.total_guests}</td>
            </tr>
            <tr>
                <th>Payment Status</th>
                <td>PAID</td>
            </tr>
                <tr>
                    <th>Order Total</th>
                    <td>${Number(amountFromTheClient).toLocaleString()} SAR</td>
                </tr>
            </table>
            <p><strong>Booking Date:</strong> ${bookedAtSaudi}</p>
        </div>
        <div class="footer">
            <p>Thank you for booking with us!</p>
        </div>
    </div>
</body>
    </html>
`;

	return email;
};

const ClientConfirmationEmail = (reservationData) => {
	const customerDetails = reservationData.customer_details || {};
	const pickedRoomsType = reservationData.pickedRoomsType || [];
	const hotelName = reservationData.hotelName || "Unknown Hotel";

	// Capitalize hotelName
	const formattedHotelName = hotelName
		.toLowerCase()
		.replace(/\b\w/g, (char) => char.toUpperCase());

	// Format dates with timezone
	const checkinDate = moment(reservationData.checkin_date)
		.tz("Asia/Riyadh")
		.format("dddd, MMMM Do YYYY");
	const checkoutDate = moment(reservationData.checkout_date)
		.tz("Asia/Riyadh")
		.format("dddd, MMMM Do YYYY");
	const createdAt = moment(reservationData.createdAt)
		.tz("Asia/Riyadh")
		.format("dddd, MMMM Do YYYY");

	// Calculate the number of nights
	const nightsOfResidence =
		reservationData.checkin_date && reservationData.checkout_date
			? moment(reservationData.checkout_date).diff(
					moment(reservationData.checkin_date),
					"days"
			  )
			: "N/A";

	// Calculate Total Sum (roomPrice * nights)
	const totalAmount = pickedRoomsType.reduce((sum, room) => {
		const roomTotal =
			(Number(room.chosenPrice) || 0) *
			(nightsOfResidence !== "N/A" ? nightsOfResidence : 1);
		return sum + roomTotal;
	}, 0);

	const paidAmountValue = Number(reservationData.paid_amount || 0);
	const reservationTotalValue = Number(reservationData.total_amount || 0);
	const paidAmount = paidAmountValue.toFixed(2);
	const reservationTotalAmount = reservationTotalValue.toFixed(2);
	const amountDue = Number(
		Number(reservationTotalAmount) - Number(paidAmount)
	).toFixed(2);
	const baseUrl = (
		process.env.PUBLIC_CLIENT_URL ||
		process.env.CLIENT_URL ||
		""
	).replace(/\/$/, "");
	const confirmationLink = `${baseUrl}/single-reservation/${reservationData.confirmation_number || ""}`;
	const paymentLink =
		reservationData?._id && reservationData?.confirmation_number
			? `${baseUrl}/client-payment/${reservationData._id}/${reservationData.confirmation_number}`
			: "";
	const shouldShowPaymentLink =
		!!paymentLink && paidAmountValue < reservationTotalValue;

	const email = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Reservation Confirmation</title>
        <style>
            body {
                font-family: Arial, sans-serif;
                margin: 0;
                padding: 0;
                background-color: #f2f4f8;
            }
            .container {
                background-color: #ffffff;
                max-width: 700px;
                margin: 30px auto;
                padding: 20px;
                border-radius: 8px;
                box-shadow: 0 4px 8px rgba(0, 0, 0, 0.1);
                overflow: hidden;
            }
            .header {
                background-color: #1e2332;
                color: #ffffff;
                text-align: center;
                padding: 20px;
                font-size: 1.8rem;
                font-weight: bold;
                text-transform: uppercase;
            }
            .content {
                padding: 20px;
                line-height: 1.6;
                color: #333333;
            }
            .content h2 {
                color: #1e2332;
                margin-bottom: 10px;
            }
            .content p {
                margin: 10px 0;
            }
            table {
                width: 100%;
                border-collapse: collapse;
                margin: 20px 0;
            }
            th, td {
                padding: 10px;
                border: 1px solid #ddd;
                text-align: left;
            }
            th {
                background-color: #1e2332;
                color: #ffffff;
            }
            .total-row {
                background-color: #f2f2f2;
                font-weight: bold;
            }
            .footer {
                background-color: #20212c;
                color: #ffffff;
                text-align: center;
                padding: 15px;
                font-size: 0.9rem;
                margin-top: 20px;
            }
            .footer a {
                color: #ffc107;
                text-decoration: none;
                font-weight: bold;
            }
            .footer a:hover {
                text-decoration: underline;
            }
            .button {
                display: inline-block;
                background: #0f172a;
                color: #ffffff !important;
                text-decoration: none;
                padding: 10px 18px;
                border-radius: 6px;
                font-weight: 700;
            }
            .button-wrap {
                text-align: center;
                margin: 18px 0 6px;
            }
            @media (max-width: 768px) {
                .content {
                    padding: 15px;
                }
                table, th, td {
                    font-size: 0.9rem;
                }
                .header {
                    font-size: 1.5rem;
                }
            }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                Reservation Confirmation
            </div>
            <div class="content">
               <h2>Hi ${
									customerDetails.name?.split(" ")[0] || "Valued Guest"
								},</h2>
                <p>Thank you for booking with <a href="https://jannatbooking.com" style="color: #007bff; text-decoration: none;">JannatBooking.com</a>.</p>

                <p><strong>Hotel Name:</strong> ${formattedHotelName}</p>
                <p><strong>Reservation Confirmation #:</strong> ${
									reservationData.confirmation_number || "N/A"
								}</p>
                <p><strong>Reserved On:</strong> ${createdAt}</p>

                <h3>Reservation Details:</h3>
                <p><strong>Check-in Date:</strong> ${checkinDate}</p>
                <p><strong>Check-out Date:</strong> ${checkoutDate}</p>
                <p><strong>Number of Nights:</strong> ${nightsOfResidence} Night(s)</p>

                <table>
                    <thead>
                        <tr>
                            <th>Room Type</th>
                            <th>Room Name</th>
                            <th>Room Price (Per Night)</th>
                            <th>Total Amount</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${pickedRoomsType
													.map((room) => {
														const roomTotal =
															(Number(room.chosenPrice) || 0) *
															(nightsOfResidence !== "N/A"
																? nightsOfResidence
																: 1);
														return `
                                <tr>
                                    <td>${room.room_type || "N/A"}</td>
                                    <td>${room.displayName || "N/A"}</td>
                                    <td>${room.chosenPrice || 0} SAR</td>
                                    <td>${roomTotal.toLocaleString()} SAR</td>
                                </tr>`;
													})
													.join("")}
                        <tr class="total-row">
                            <td colspan="3">Total</td>
                            <td>${totalAmount.toLocaleString()} SAR</td>
                        </tr>
                    </tbody>
                </table>

                 <h3>Payment Details:</h3>
                <p><strong>Paid Amount:</strong> ${paidAmount} SAR</p>
                <p><strong>Total Amount:</strong> ${reservationTotalAmount} SAR</p>
                <p><strong>Amount Due:</strong> ${amountDue} SAR</p>

                <div class="button-wrap">
                    <a class="button" href="${confirmationLink}" target="_blank" rel="noopener noreferrer">
                        View Your Reservation
                    </a>
                </div>
                <p style="font-size: 0.9rem; color: #6b7280; text-align:center; margin: 6px 0 12px;">
                    Receipt link: <a href="${confirmationLink}" target="_blank" rel="noopener noreferrer">${confirmationLink}</a>
                </p>
                ${
									shouldShowPaymentLink
										? `
                <div class="button-wrap">
                    <a class="button" href="${paymentLink}" target="_blank" rel="noopener noreferrer">
                        Complete Your Payment
                    </a>
                </div>
                <p style="font-size: 0.9rem; color: #6b7280; text-align:center; margin: 6px 0 12px;">
                    Payment link: <a href="${paymentLink}" target="_blank" rel="noopener noreferrer">${paymentLink}</a>
                </p>
                `
										: ""
								}
                <p style="font-size: 0.9rem; color: #6b7280; text-align:center;">
                    Your PDF invoice is attached for your records.
                </p>
            </div>
            <div class="footer">
                <p>For more details, visit your <a href="https://jannatbooking.com/dashboard">dashboard</a>.</p>
                <p>If you have any inquiries, <a href="https://jannatbooking.com/single-hotel/${formattedHotelName
									.replace(/\s+/g, "-")
									.toLowerCase()}">chat with the hotel</a>.</p>
            </div>
        </div>
    </body>
    </html>
    `;

	return email;
};

const receiptPdfTemplate = (reservationData = {}, hotelInfo = {}) => {
	const safeNumber = (value) => {
		const num = Number(value);
		return Number.isFinite(num) ? num : 0;
	};

	const escapeHtml = (value) => {
		if (value === null || value === undefined) return "";
		return String(value)
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/\"/g, "&quot;")
			.replace(/'/g, "&#39;");
	};

	const bookingDate = new Date(
		reservationData?.createdAt || Date.now()
	).toLocaleDateString("en-US");

	const totalAmount = safeNumber(reservationData?.total_amount);
	const paidAmountAuthorized = safeNumber(reservationData?.paid_amount);
	const paidAmountOffline = safeNumber(
		reservationData?.payment_details?.onsite_paid_amount
	);
	const totalPaid = paidAmountAuthorized + paidAmountOffline;

	const paymentStatus = String(reservationData?.payment || "").toLowerCase();
	const isNotCapturedStatus =
		paymentStatus === "credit/ debit" ||
		paymentStatus === "credit/debit" ||
		paymentStatus === "credit / debit" ||
		paymentStatus === "not captured";

	const toCents = (n) => Math.round(Number(n || 0) * 100);
	const isFullyPaid =
		toCents(totalPaid) >= toCents(totalAmount) && totalPaid > 0;
	const isNotPaid = toCents(totalPaid) === 0 && paymentStatus === "not paid";
	const depositPercentage =
		totalAmount > 0 ? ((totalPaid / totalAmount) * 100).toFixed(0) : "0";

	const calculateNights = (checkin, checkout) => {
		const start = new Date(checkin);
		const end = new Date(checkout);
		let nights = Math.ceil((end - start) / (1000 * 60 * 60 * 24));
		return nights < 1 ? 1 : nights;
	};

	const nights = calculateNights(
		reservationData?.checkin_date,
		reservationData?.checkout_date
	);

	const hotelName =
		hotelInfo?.hotelName ||
		reservationData?.hotelName ||
		reservationData?.hotelId?.hotelName ||
		"N/A";
	const supplierName =
		reservationData?.supplierData?.supplierName ||
		hotelInfo?.suppliedBy ||
		hotelInfo?.belongsTo?.name ||
		reservationData?.hotelId?.belongsTo?.name ||
		reservationData?.belongsTo?.name ||
		"N/A";
	const supplierBookingNo =
		reservationData?.supplierData?.suppliedBookingNo ||
		reservationData?.confirmation_number ||
		"N/A";
	const bookingNo = reservationData?.confirmation_number || "N/A";

	const roomRows = Array.isArray(reservationData?.pickedRoomsType)
		? reservationData.pickedRoomsType
				.map((room) => {
					const chosenPrice = safeNumber(room?.chosenPrice);
					const firstDay =
						Array.isArray(room?.pricingByDay) && room.pricingByDay.length
							? room.pricingByDay[0]
							: null;
					const rootPrice = firstDay ? safeNumber(firstDay.rootPrice) : 0;
					const rate = chosenPrice > 0 ? chosenPrice : rootPrice;
					const totalPrice = rate * safeNumber(room?.count) * nights;

					return `
            <tr>
              <td>${escapeHtml(hotelName)}</td>
              <td>${escapeHtml(room?.displayName || "N/A")}</td>
              <td>${safeNumber(room?.count) || "0"}</td>
              <td>N/T</td>
              <td>${nights}</td>
              <td>${rate > 0 ? `${rate} SAR` : "N/A"}</td>
              <td>${totalPrice > 0 ? `${totalPrice.toFixed(2)} SAR` : "N/A"}</td>
            </tr>
          `;
				})
				.join("")
		: "";

	const safeRoomRows =
		roomRows ||
		`
      <tr>
        <td>${escapeHtml(hotelName)}</td>
        <td>N/A</td>
        <td>0</td>
        <td>N/T</td>
        <td>${nights}</td>
        <td>N/A</td>
        <td>N/A</td>
      </tr>
    `;

	const paymentHeaderText =
		paidAmountOffline > 0
			? "Paid Offline"
			: isFullyPaid
				? "Paid Amount"
				: isNotPaid
					? "Not Paid"
					: isNotCapturedStatus
						? "Authorized (Not Captured)"
						: `${depositPercentage}% Deposit`;

	const paymentHeaderValue =
		paidAmountOffline > 0
			? totalAmount > 0
				? `${Number((totalPaid / totalAmount) * 100).toFixed(2)}%`
				: "0.00%"
			: isFullyPaid
				? `${totalPaid.toFixed(2)} SAR`
				: isNotPaid
					? "Not Paid"
					: isNotCapturedStatus
						? `${paidAmountAuthorized.toFixed(2)} SAR`
						: `${depositPercentage}% Deposit`;

	const paymentMethodText =
		paidAmountOffline > 0
			? "Paid Offline"
			: isFullyPaid
				? "Paid in Full"
				: isNotPaid
					? "Not Paid"
					: isNotCapturedStatus
						? "Authorized (Not Captured)"
						: `${depositPercentage}% Deposit`;

	const remaining = Math.max(
		0,
		Number((totalAmount - totalPaid).toFixed(2))
	);

	return `
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Booking Receipt</title>
        <style>
          body {
            margin: 0;
            padding: 0;
            background: #ffffff;
            font-family: Arial, Helvetica, sans-serif;
          }
          .receipt-wrapper {
            padding: 20px;
            border: 1px solid #ccc;
            max-width: 800px;
            margin: auto;
            text-transform: capitalize;
          }
          .header1 {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 8px 0;
            background-color: #d9d9d9;
          }
          .header1 .left {
            flex: 1;
          }
          .header1 .center {
            flex: 1;
            text-align: center;
          }
          .header1 .right {
            color: #777;
            flex: 1;
            text-align: right;
            font-size: 20px;
            font-weight: bold;
            padding-right: 7px;
            align-self: flex-end;
            padding-top: 35px;
          }
          .header2,
          .header3 {
            text-align: center;
            padding: 8px 0;
          }
          .header2 {
            background-color: rgb(243, 195, 146);
          }
          .header3 {
            background-color: #ccc;
            margin-top: 10px;
          }
          .logo {
            font-size: 32px;
            font-weight: bold;
            color: #777;
          }
          .logo span {
            font-size: 14px;
            color: rgb(241, 131, 21);
          }
          .info-boxes {
            display: flex;
            justify-content: space-between;
            margin-top: 20px;
            gap: 16px;
          }
          .info-box {
            border: 1px solid #000;
            padding: 10px;
            width: 48%;
            text-align: center;
            word-break: break-word;
          }
          .supplier-info .editable-supplier {
            font-style: italic;
          }
          table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 20px;
          }
          .room-details-table td {
            font-size: 11px;
          }
          th,
          td {
            border: 1px solid #000;
            padding: 8px;
            text-align: center;
          }
          td {
            font-size: 11.5px;
          }
          th {
            background-color: rgb(243, 195, 146);
            color: #fff;
          }
          .summary {
            border: 1px solid #000;
            padding: 10px;
            text-align: right;
          }
          .footer {
            text-align: center;
            margin-top: 30px;
          }
          a {
            color: #007bff;
            text-decoration: none;
          }
        </style>
      </head>
      <body>
        <div class="receipt-wrapper">
          <div class="header1">
            <div class="left"></div>
            <div class="center logo">
              JANNAT <span>Booking.com</span>
            </div>
            <div class="right">Booking Receipt</div>
          </div>
          <div class="header2">
            <div class="hotel-name">Hotel: ${escapeHtml(hotelName)}</div>
          </div>
          <div class="header3">
            <div class="booking-info">
              <div>
                <strong>Booking No:</strong> ${escapeHtml(bookingNo)}
                ${
									bookingNo === supplierBookingNo
										? ""
										: ` / ${escapeHtml(supplierBookingNo)}`
								}
              </div>
              <div>
                <strong>Booking Date:</strong> ${escapeHtml(bookingDate)}
              </div>
            </div>
          </div>

          <div class="info-boxes">
            <div class="info-box">
              <strong>Guest Name</strong>
              <div>${escapeHtml(reservationData?.customer_details?.name || "N/A")}</div>
              <div>${escapeHtml(reservationData?.customer_details?.nationality || "N/A")}</div>
            </div>
            <div class="info-box">
              <strong>${escapeHtml(paymentHeaderText)}</strong>
              <div>${escapeHtml(paymentHeaderValue)}</div>
            </div>
          </div>

          <div class="supplier-info mt-2">
            <div class="editable-supplier">
              <strong>Supplied By:</strong> ${escapeHtml(supplierName)}
            </div>
            <div>
              <strong>Supplier Booking No:</strong> ${escapeHtml(
									supplierBookingNo
								)}
            </div>
          </div>

          <table class="details-table">
            <thead>
              <tr>
                <th>Check In</th>
                <th>Check Out</th>
                <th>Booking Status</th>
                <th>Guests</th>
                <th>Booking Source</th>
                <th>Payment Method</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>${escapeHtml(
									new Date(reservationData?.checkin_date).toLocaleDateString(
										"en-US"
									)
								)}</td>
                <td>${escapeHtml(
									new Date(reservationData?.checkout_date).toLocaleDateString(
										"en-US"
									)
								)}</td>
                <td>${escapeHtml(reservationData?.reservation_status || "Confirmed")}</td>
                <td>${escapeHtml(reservationData?.total_guests ?? "")}</td>
                <td>${escapeHtml(reservationData?.booking_source || "Jannatbooking.com")}</td>
                <td>${escapeHtml(paymentMethodText)}</td>
              </tr>
            </tbody>
          </table>

          <table class="room-details-table">
            <thead>
              <tr>
                <th>Hotel</th>
                <th>Room Type</th>
                <th>Qty</th>
                <th>Extras</th>
                <th>Nights</th>
                <th>Rate</th>
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              ${safeRoomRows}
            </tbody>
          </table>

          <div class="summary">
            <div>
              <strong>Net Accommodation Charge:</strong> ${totalAmount.toFixed(2)} SAR
            </div>
            ${
							isFullyPaid
								? `<div><strong>Paid Amount:</strong> ${totalPaid.toFixed(
										2
								  )} SAR</div>`
								: paidAmountOffline > 0 && paidAmountAuthorized === 0
									? `<div><strong>Paid Amount Onsite:</strong> ${paidAmountOffline.toFixed(
											2
									  )} SAR</div>`
									: isNotPaid
										? `<div><strong>Payment Status:</strong> Not Paid</div>`
										: isNotCapturedStatus && paidAmountAuthorized > 0
											? `<div><strong>Authorized (Not Captured):</strong> ${paidAmountAuthorized.toFixed(
													2
											  )} SAR</div>`
											: paidAmountAuthorized > 0
												? `<div><strong>Deposit:</strong> ${paidAmountAuthorized.toFixed(
														2
												  )} SAR</div>`
												: ""
						}
            <div>
              <strong>Total To Be Collected:</strong> ${remaining.toFixed(2)} SAR
            </div>
          </div>

          <div class="footer">
            Many Thanks for staying with us at
            <strong>${escapeHtml(hotelName)}</strong> Hotel.
            <br />
            For better rates next time, please check
            <a href="https://jannatbooking.com">jannatbooking.com</a>
          </div>
        </div>
      </body>
    </html>
  `;
};

const SendingReservationLinkEmail = ({
	hotelName,
	name,
	agentName,
	depositPercentage,
	wholeAmount,
	confirmationLink,
}) => {
	const hotelNameAdjusted = hotelName || "Jannat Booking";
	const formattedHotelName = hotelNameAdjusted
		.toLowerCase()
		.replace(/\b\w/g, (char) => char.toUpperCase());

	const email = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Reservation Confirmation Link</title>
        <style>
            body {
                font-family: Arial, sans-serif;
                margin: 0;
                padding: 0;
                background-color: #f2f4f8;
            }
            .email-container {
                background-color: #ffffff;
                max-width: 700px;
                margin: 30px auto;
                padding: 20px;
                border-radius: 8px;
                box-shadow: 0 4px 8px rgba(0, 0, 0, 0.1);
            }
            table {
                width: 100%;
                border-collapse: collapse;
                margin: 0;
                padding: 0;
            }
            .header {
                background: #1e2332;
                color: #ffffff;
                text-align: center;
                padding: 20px;
                font-size: 1.8rem;
                font-weight: bold;
            }
            .content {
                padding: 20px;
                color: #333333;
                line-height: 1.6;
            }
            .content h2 {
                color: #20212c;
                margin-bottom: 10px;
            }
            .button-container {
                text-align: center;
                margin: 30px 0;
            }
            .button {
                font-size: 2rem;
                background: #005900; /* Dark green */
                color: #ffffff; /* White font */
                text-decoration: none;
                padding: 20px 40px;
                border-radius: 8px;
                font-weight: bold;
                border: none;
                box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);
                display: inline-block;
                transition: all 0.3s ease-in-out;
            }

            .button a {
                color: #f9f9f9;
                text-decoration: none;
                font-weight: bold;
                font-size: 2rem;
            }


            .button:hover {
                background: #004f00; /* Slightly darker green for hover effect */
                box-shadow: 0 6px 10px rgba(0, 0, 0, 0.3);
            }
            @media only screen and (max-width: 600px) {
                .button {
                    font-size: 1.5rem; /* Smaller font size for small screens */
                    padding: 10px 20px;
                }

                 .button a {
                    color: #f9f9f9;
                    text-decoration: none;
                    font-weight: bold;
                    font-size: 1.5rem;
            }
            }
            @media only screen and (min-width: 601px) {
                .button {
                    font-size: 1.7rem; /* Larger font size for bigger screens */
                    padding: 20px 40px; /* Bigger padding for better emphasis */
                }
            }
            .footer {
                background: #1e2332;
                color: #ffffff;
                text-align: center;
                padding: 15px;
                font-size: 0.9rem;
            }
            .footer a {
                color: #ffc107;
                text-decoration: none;
                font-weight: bold;
            }
        </style>
    </head>
    <body>
        <div class="email-container">
            <table>
                <!-- Header Section -->
                <tr>
                    <td class="header">
                        ${formattedHotelName} | Reservation Confirmation Link
                    </td>
                </tr>
                <!-- Content Section -->
                <tr>
                    <td class="content">
                        <h2>Hi ${name?.split(" ")[0] || "Valued Guest"},</h2>
                        <p>You recently requested a reservation through ${
													agentName || "our agent"
												}. Please review the details and confirm your reservation using the link below:</p>
                        <p>
                            <strong>Note:</strong> You can pay a deposit of ${depositPercentage}% 
                            (${(
															(wholeAmount * depositPercentage) /
															100
														).toFixed(
															2
														)} SAR) or the full amount of ${wholeAmount.toFixed(
		2
	)} SAR.
                        </p>
                        <div class="button-container">
                            <a href="${confirmationLink}" target="_blank" class="button" style="color: #f9f9f9; font-size:1.5rem;">
                                Confirm Reservation
                            </a>
                        </div>
                    </td>
                </tr>
                <!-- Footer Section -->
                <tr>
                    <td class="footer">
                        <p>If you have any inquiries, please <a href="https://jannatbooking.com">contact us</a>.</p>
                        <p>Best Regards,<br>Jannat Booking Administration</p>
                        <p>Email: support@jannatbooking.com</p>
                        <p>PO Box 322, Crestline</p>
                    </td>
                </tr>
            </table>
        </div>
    </body>
    </html>
  `;

	return email;
};

const SendingReservationLinkEmailTrigger = ({
	hotelName,
	name,
	confirmationLink,
	amountInSAR,
	totalAmountSAR, // New parameter
}) => {
	const hotelNameAdjusted = hotelName || "Jannat Booking";
	const formattedHotelName = hotelNameAdjusted
		.toLowerCase()
		.replace(/\b\w/g, (char) => char.toUpperCase());

	const email = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Reservation Confirmation and Payment</title>
        <style>
            body {
                font-family: Arial, sans-serif;
                margin: 0;
                padding: 0;
                background-color: #f2f4f8;
            }
            .email-container {
                background-color: #ffffff;
                max-width: 700px;
                margin: 30px auto;
                padding: 20px;
                border-radius: 8px;
                box-shadow: 0 4px 8px rgba(0, 0, 0, 0.1);
            }
            table {
                width: 100%;
                border-collapse: collapse;
                margin: 0;
                padding: 0;
            }
            .header {
                background: #1e2332;
                color: #ffffff;
                text-align: center;
                padding: 20px;
                font-size: 1.8rem;
                font-weight: bold;
            }
            .content {
                padding: 20px;
                color: #333333;
                line-height: 1.6;
            }
            .content h2 {
                color: #20212c;
                margin-bottom: 10px;
            }
            .content p {
                margin-bottom: 15px;
            }
            .button-container {
                text-align: center;
                margin: 30px 0;
            }
            .button {
                font-size: 2rem;
                background: #005900; /* Dark green */
                color: #ffffff; /* White font */
                text-decoration: none;
                padding: 20px 40px;
                border-radius: 8px;
                font-weight: bold;
                border: none;
                box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);
                display: inline-block;
                transition: all 0.3s ease-in-out;
            }

            .button a {
                color: #f9f9f9;
                text-decoration: none;
                font-weight: bold;
                font-size: 2rem;
            }


            .button:hover {
                background: #004f00; /* Slightly darker green for hover effect */
                box-shadow: 0 6px 10px rgba(0, 0, 0, 0.3);
            }
            @media only screen and (max-width: 600px) {
                .button {
                    font-size: 1.5rem; /* Smaller font size for small screens */
                    padding: 10px 20px;
                }

                 .button a {
                    color: #f9f9f9;
                    text-decoration: none;
                    font-weight: bold;
                    font-size: 1.5rem;
            }
            }
            @media only screen and (min-width: 601px) {
                .button {
                    font-size: 1.7rem; /* Larger font size for bigger screens */
                    padding: 20px 40px; /* Bigger padding for better emphasis */
                }
            }
            .footer {
                background: #1e2332;
                color: #ffffff;
                text-align: center;
                padding: 15px;
                font-size: 0.9rem;
            }
            .footer a {
                color: #ffc107;
                text-decoration: none;
                font-weight: bold;
            }
        </style>
    </head>
    <body>
        <div class="email-container">
            <table>
                <!-- Header Section -->
                <tr>
                    <td class="header">
                        ${formattedHotelName} | Reservation Confirmation and Payment
                    </td>
                </tr>
                <!-- Content Section -->
                <tr>
                    <td class="content">
                        <h2>Dear ${name?.split(" ")[0] || "Valued Guest"},</h2>
                        <p>Thank you for choosing ${formattedHotelName} for your stay. We are pleased to confirm your reservation.</p>
                        <p><strong>Reservation Details:</strong></p>
                        <ul>
                            <li><strong>Total Reservation Amount:</strong> ${totalAmountSAR} SAR</li>
                            <li><strong>Amount Due:</strong> ${amountInSAR} SAR</li>
                        </ul>
                        <p>Please proceed to confirm your payment by clicking the button below. This will redirect you to our secure payment page where you can complete the transaction.</p>
                        <div class="button-container">
                            <a href="${confirmationLink}" target="_blank" class="button">
                                Proceed To Confirm Payment
                            </a>
                        </div>
                        <p>If you have any questions or need assistance, feel free to contact our support team.</p>
                        <p>We look forward to hosting you!</p>
                    </td>
                </tr>
                <!-- Footer Section -->
                <tr>
                    <td class="footer">
                        <p>If you have any inquiries, please <a href="https://jannatbooking.com">contact us</a>.</p>
                        <p>Best Regards,<br>${formattedHotelName} Administration</p>
                        <p>Email: support@jannatbooking.com</p>
                        <p>PO Box 322, Crestline</p>
                    </td>
                </tr>
            </table>
        </div>
    </body>
    </html>
    `;

	return email;
};

const paymentTriggered = (reservationData) => {
	// Extract guest's first name
	const guestName =
		reservationData.customer_details.name.split(" ")[0] || "Guest";

	// Extract confirmation number
	const confirmationNumber = reservationData.confirmation_number || "N/A";

	// Extract the amount captured in this payment (triggeredAmountSAR)
	const amountCapturedThisPayment = Number(
		reservationData.payment_details.triggeredAmountSAR || 0
	).toFixed(2);

	// Extract the total paid amount so far
	const totalPaidAmount = Number(reservationData.paid_amount || 0).toFixed(2);

	// Extract the reservation total amount
	const reservationTotalAmount = Number(
		reservationData.total_amount || 0
	).toFixed(2);

	// Calculate the amount due
	const amountDue = (
		Number(reservationData.total_amount || 0) -
		Number(reservationData.paid_amount || 0)
	).toFixed(2);

	// Safely access hotelName
	const hotelName = (
		reservationData.hotelName ||
		(reservationData.hotelId && reservationData.hotelId.hotelName) ||
		"JANNAT BOOKING"
	).toUpperCase();

	// Construct the email HTML content
	const email = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Payment Confirmation</title>
        <style>
            body {
                font-family: Arial, sans-serif;
                margin: 0;
                padding: 0;
                background-color: #f2f4f8;
            }
            .container {
                background-color: #ffffff;
                max-width: 600px;
                margin: 30px auto;
                padding: 20px;
                border-radius: 8px;
                box-shadow: 0 4px 8px rgba(0, 0, 0, 0.1);
            }
            .header {
                background-color: #1e2332;
                color: #ffffff;
                text-align: center;
                padding: 15px;
                border-radius: 8px 8px 0 0;
            }
            .content {
                padding: 20px;
                color: #333333;
                line-height: 1.6;
            }
            .content h2 {
                color: #1e2332;
                margin-bottom: 10px;
            }
            .content p {
                margin-bottom: 15px;
            }
            .details-table {
                width: 100%;
                border-collapse: collapse;
                margin: 20px 0;
            }
            .details-table th, .details-table td {
                border: 1px solid #dddddd;
                padding: 10px;
                text-align: left;
            }
            .details-table th {
                background-color: #1e2332;
                color: #ffffff;
            }
            .footer {
                background-color: #1e2332;
                color: #ffffff;
                text-align: center;
                padding: 15px;
                border-radius: 0 0 8px 8px;
                font-size: 0.9rem;
            }
            .footer a {
                color: #ffc107;
                text-decoration: none;
                font-weight: bold;
            }
            @media (max-width: 600px) {
                .container {
                    padding: 15px;
                }
                .header, .footer {
                    padding: 10px;
                }
                .content {
                    padding: 15px;
                }
                .details-table th, .details-table td {
                    padding: 8px;
                }
            }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <h1>${hotelName}</h1>
            </div>
            <div class="content">
                <h2>Hi ${guestName},</h2>
                <p>Thank you for choosing Jannat Booking!</p>
                <p>Your payment of <strong>${amountCapturedThisPayment} SAR</strong> was successfully captured for your reservation <strong>#${confirmationNumber}</strong>.</p>
                
                <h3>Payment Details:</h3>
                <table class="details-table">
                    <tr>
                        <th>Amount Captured This Payment</th>
                        <td>${amountCapturedThisPayment} SAR</td>
                    </tr>
                    <tr>
                        <th>Total Paid Amount</th>
                        <td>${totalPaidAmount} SAR</td>
                    </tr>
                    <tr>
                        <th>Reservation Total Amount</th>
                        <td>${reservationTotalAmount} SAR</td>
                    </tr>
                    <tr>
                        <th>Amount Due</th>
                        <td>${amountDue} SAR</td>
                    </tr>
                </table>
                
                <p>We look forward to hosting you. If you have any questions or need further assistance, feel free to reach out to our support team.</p>
                <p>Enjoy your stay!</p>
            </div>
            <div class="footer">
                <p>Best Regards,<br>Jannat Booking Administration</p>
                <p>Email: support@jannatbooking.com</p>
                <p>PO Box 322, Crestline</p>
            </div>
        </div>
    </body>
    </html>
    `;

	return email;
};

const ReservationVerificationEmail = ({
	name,
	hotelName,
	confirmationLink,
}) => {
	const formattedHotelName = hotelName || "Jannat Booking";

	const email = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Reservation Verification</title>
          <style>
              body {
                  font-family: Arial, sans-serif;
                  margin: 0;
                  padding: 0;
                  background-color: #f2f4f8;
              }
              .email-container {
                  background-color: #ffffff;
                  max-width: 700px;
                  margin: 30px auto;
                  padding: 20px;
                  border-radius: 8px;
                  box-shadow: 0 4px 8px rgba(0, 0, 0, 0.1);
              }
              table {
                  width: 100%;
                  border-collapse: collapse;
                  margin: 0;
                  padding: 0;
              }
              .header {
                  background: #1e2332;
                  color: #ffffff;
                  text-align: center;
                  padding: 20px;
                  font-size: 1.8rem;
                  font-weight: bold;
              }
              .content {
                  padding: 20px;
                  color: #333333;
                  line-height: 1.6;
              }
              .content h2 {
                  color: #20212c;
                  margin-bottom: 10px;
              }
              .button-container {
                  text-align: center;
                  margin: 30px 0;
              }
              .button {
                  font-size: 2rem;
                  background: #005900; /* Dark green */
                  color: #ffffff; /* White font */
                  text-decoration: none;
                  padding: 20px 40px;
                  border-radius: 8px;
                  font-weight: bold;
                  border: none;
                  box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);
                  display: inline-block;
                  transition: all 0.3s ease-in-out;
              }
  
              .button a {
                  color: #f9f9f9;
                  text-decoration: none;
                  font-weight: bold;
                  font-size: 2rem;
              }
  
              .button:hover {
                  background: #004f00; /* Slightly darker green for hover effect */
                  box-shadow: 0 6px 10px rgba(0, 0, 0, 0.3);
              }


               .button {
                font-size: 2rem;
                background: #005900; /* Dark green */
                color: #ffffff; /* White font */
                text-decoration: none;
                padding: 20px 40px;
                border-radius: 8px;
                font-weight: bold;
                border: none;
                box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);
                display: inline-block;
                transition: all 0.3s ease-in-out;
            }

            .button a {
                color: #f9f9f9;
                text-decoration: none;
                font-weight: bold;
                font-size: 2rem;
            }


            .button:hover {
                background: #004f00; /* Slightly darker green for hover effect */
                box-shadow: 0 6px 10px rgba(0, 0, 0, 0.3);
            }


              @media only screen and (max-width: 600px) {
                  .button {
                      font-size: 1.5rem; /* Smaller font size for small screens */
                      padding: 10px 20px;
                  }
  
                   .button a {
                      color: #f9f9f9;
                      text-decoration: none;
                      font-weight: bold;
                      font-size: 1.5rem;
                   }
              }
              @media only screen and (min-width: 601px) {
                  .button {
                      font-size: 1.7rem; /* Larger font size for bigger screens */
                      padding: 20px 40px; /* Bigger padding for better emphasis */
                  }
              }
              .footer {
                  background: #1e2332;
                  color: #ffffff;
                  text-align: center;
                  padding: 15px;
                  font-size: 0.9rem;
              }
              .footer a {
                  color: #ffc107;
                  text-decoration: none;
                  font-weight: bold;
              }
          </style>
      </head>
      <body>
          <div class="email-container">
              <table>
                  <!-- Header Section -->
                  <tr>
                      <td class="header">
                          ${formattedHotelName} | Reservation Verification
                      </td>
                  </tr>
                  <!-- Content Section -->
                  <tr>
                      <td class="content">
                          <h2>Hi ${name?.split(" ")[0] || "Valued Guest"},</h2>
                          <p>
                              Please click the button below to verify and confirm your reservation with the hotel <strong>${formattedHotelName}</strong>.
                          </p>
                          <div class="button-container">
                              <a href="${confirmationLink}" target="_blank" class="button" style="color: #f9f9f9; font-size:1.5rem;">
                                  Confirm Reservation
                              </a>
                          </div>
                      </td>
                  </tr>
                  <!-- Footer Section -->
                  <tr>
                      <td class="footer">
                          <p>If you have any inquiries, please <a href="https://jannatbooking.com">contact us</a>.</p>
                          <p>Best Regards,<br>Jannat Booking Administration</p>
                          <p>Email: support@jannatbooking.com</p>
                          <p>PO Box 322, Crestline</p>
                      </td>
                  </tr>
              </table>
          </div>
      </body>
      </html>
    `;

	return email;
};

function newSupportCaseEmail(supportCase, hotelName) {
	// Convert creation date to Saudi time (if relevant):
	// (If you prefer local times or want to show exactly when it was opened.)
	const createdAtSaudi = supportCase.createdAt
		? moment(supportCase.createdAt)
				.tz("Asia/Riyadh")
				.format("dddd, MMMM Do YYYY, h:mm A")
		: moment().tz("Asia/Riyadh").format("dddd, MMMM Do YYYY, h:mm A");

	// Extract first conversation entry to show top-level inquiry details
	const firstMessage = supportCase?.conversation?.[0] || {};

	// Safe fallback if no inquiry details found
	const inquiryAbout = firstMessage.inquiryAbout || "N/A";
	const inquiryDetails = firstMessage.inquiryDetails || "N/A";

	// The openedBy field (e.g., "client", "hotel owner", "super admin")
	const openedBy = supportCase.openedBy || "Unknown";

	// Display names from the schema (the person opening the case, the “receiver,” etc.)
	const displayName1 = supportCase.displayName1 || "N/A";
	const displayName2 = supportCase.displayName2 || "N/A";

	return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
        <title>New Support Case</title>
        <style>
          body {
            font-family: Arial, sans-serif;
            margin: 0; 
            padding: 0; 
            background-color: #f2f4f8;
          }
          .container {
            background-color: #ffffff;
            width: 100%;
            max-width: 700px;
            margin: 30px auto;
            padding: 20px;
            border-radius: 8px;
            box-shadow: 0 4px 8px rgba(0,0,0,0.1);
          }
          .header {
            background: linear-gradient(90deg, #20212c, #1e2332);
            color: #ffffff;
            text-align: center;
            padding: 20px;
          }
          .header h1 {
            margin: 0;
            font-size: 1.8rem;
          }
          .content {
            padding: 20px;
            color: #333333;
            line-height: 1.6;
          }
          .footer {
            background: #1e2332;
            color: #ffffff;
            text-align: center;
            padding: 15px;
            font-size: 0.9rem;
            margin-top: 20px;
          }
          .footer a {
            color: #ffc107;
            text-decoration: none;
            font-weight: bold;
          }
          .footer a:hover {
            text-decoration: underline;
          }
          .button-container {
            text-align: center;
            margin: 25px 0;
          }
          .button {
            font-size: 1.1rem;
            background: #005900;
            color: #ffffff;
            text-decoration: none;
            padding: 10px 25px;
            border-radius: 6px;
            font-weight: bold;
            border: none;
            transition: background 0.3s ease-in-out;
            display: inline-block;
          }
          .button:hover {
            background: #004f00;
          }
          table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 15px;
          }
          th, td {
            border: 1px solid #dddddd;
            padding: 10px;
            text-align: left;
          }
          th {
            background-color: #20212c;
            color: #ffffff;
          }
          @media (max-width: 768px) {
            .header h1 {
              font-size: 1.5rem;
            }
            .button {
              font-size: 1rem;
            }
          }
        </style>
      </head>
      <body>
        <div class="container">
          <!-- Header -->
          <div class="header">
            <h1>New Support Case</h1>
          </div>
  
          <!-- Content -->
          <div class="content">
            <p>Hi Jannat Booking Admins,</p>
            <p>There's a new support case opened for <strong>${hotelName}</strong>.</p>
            <p>
              Below are some details regarding this case:
            </p>
  
            <table>
              <tr>
                <th>Case ID</th>
                <td>${supportCase._id}</td>
              </tr>
              <tr>
                <th>Created At (Saudi Time)</th>
                <td>${createdAtSaudi}</td>
              </tr>
              <tr>
                <th>Opened By</th>
                <td>${openedBy}</td>
              </tr>
              <tr>
                <th>Display Name 1</th>
                <td>${displayName1}</td>
              </tr>
             
              <tr>
                <th>Inquiry About</th>
                <td>${inquiryAbout}</td>
              </tr>
              <tr>
                <th>Inquiry Details</th>
                <td>${inquiryDetails}</td>
              </tr>
            </table>
  
            <div class="button-container">
              <a 
                href="https://xhotelpro.com/admin/customer-service?tab=active-client-cases" 
                class="button"
                target="_blank"
                rel="noopener noreferrer"
              >
                View Support Cases
              </a>
            </div>
  
            <p>
              Please log in to your admin panel to review and respond to this new case.
            </p>
          </div>
  
          <!-- Footer -->
          <div class="footer">
            <p>
              &copy; ${new Date().getFullYear()} Jannat Booking. 
              Need help? <a href="https://jannatbooking.com">Contact us</a>
            </p>
          </div>
        </div>
      </body>
      </html>
    `;
}

module.exports = {
	confirmationEmail,
	reservationUpdate,
	emailPaymentLink,
	paymentReceipt,
	ClientConfirmationEmail,
	receiptPdfTemplate,
	SendingReservationLinkEmail,
	ReservationVerificationEmail,
	newSupportCaseEmail,
	SendingReservationLinkEmailTrigger,
	paymentTriggered,
};
