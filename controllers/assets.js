const moment = require("moment-timezone");

const confirmationEmail = (reservationData) => {
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
        <title>Reservation Confirmation</title>
        <style>
            body { font-family: Arial, sans-serif; margin: 0; padding: 0; background-color: #c5ddf6; }
            .container { background-color: #fff; width: 100%; max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background: #ff6f61; color: white; padding: 10px; text-align: center; }
            .content { padding-right: 20px; padding-left: 20px; text-align: left; }
            .footer { background: #ddd; padding: 10px; text-align: center; font-size: 14px; font-weight: bold; }
            .roomType { font-weight: bold; text-transform: capitalize; }
            table { width: 100%; border-collapse: collapse; }
            th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
            th { background-color: #ff6f61; color: white; }
            h2 { font-weight: bold; font-size: 1.5rem; }
            strong { font-weight: bold; }
            .confirmation {
                font-size: 1rem;
                font-weight: bold;
            }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <h1>New Reservation</h1>
            </div>
            <div>
                <h2>${reservationData.hotelName.toUpperCase()} Hotel</h2>
            </div>
            <div class="content">
            <p class="confirmation"><strong>Confirmation Number:</strong> ${
							reservationData.confirmation_number
						}</p>
                <p><strong>Guest Name:</strong> ${
									reservationData.customer_details.name
								}</p>
                <p><strong>Reservation Status:</strong> ${
									reservationData.reservation_status
								}</p>
                <p><strong>Country:</strong> ${
									reservationData.customer_details.nationality
								}</p>
                <table>
                    <tr>
                        <th>Room Type</th>
                        <td class="roomType">${reservationData.pickedRoomsType
													.map((room) => room.room_type)
													.join(", ")}</td>
                    </tr>
                    <tr>
                        <th>Room Count</th>
                        <td class="roomType">${reservationData.pickedRoomsType.reduce(
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
										).toLocaleString()}</td>
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

const reservationUpdate = (reservationData, hotelName) => {
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
            body { font-family: Arial, sans-serif; margin: 0; padding: 0; background-color: #c5ddf6; }
            .container { background-color: #fff; width: 100%; max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background: #ff6f61; color: white; padding: 10px; text-align: center; }
            .content { padding-right: 20px; padding-left: 20px; text-align: left; }
            .footer { background: #ddd; padding: 10px; text-align: center; font-size: 14px; font-weight: bold; }
            .roomType { font-weight: bold; text-transform: capitalize; }
            table { width: 100%; border-collapse: collapse; }
            th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
            th { background-color: #ff6f61; color: white; }
            h2 { font-weight: bold; font-size: 1.5rem; }
            strong { font-weight: bold; }
            .confirmation {
                font-size: 1rem;
                font-weight: bold;
            }
        </style>
    </head>
    <body>
    <div class="container">
        <div class="header">
            <h1>Reservation Update</h1>
        </div>
        <div>
            <h2>${hotelName.toUpperCase()} Hotel</h2>
        </div>
        <div class="content">
        <p class="confirmation"><strong>Confirmation Number:</strong> ${
					reservationData.confirmation_number
				}</p>
            <p><strong>Guest Name:</strong> ${
							reservationData.customer_details.name
						}</p>
          
                        <p><strong>Reservation Status:</strong> ${
													reservationData.reservation_status
												}</p>
            <p><strong>Country:</strong> ${
							reservationData.customer_details.nationality
						}</p>
            <table>
                <tr>
                    <th>Room Type</th>
                    <td class="roomType">${reservationData.pickedRoomsType
											.map((room) => room.room_type)
											.join(", ")}</td>
                </tr>
               
                <tr>
                <th>Room Count</th>
                <td class="roomType">${reservationData.pickedRoomsType.reduce(
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
								).toLocaleString()}</td>
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

const emailPaymentLink = (paymentLink) => {
	const email = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Reservation Confirmation</title>
        <style>
            body { font-family: Arial, sans-serif; margin: 0; padding: 0; background-color: #c5ddf6; }
            .container { background-color: #fff; width: 100%; max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background: #ff6f61; color: white; padding: 10px; text-align: center; margin-top:50px; margin-bottom:50px; }
            .content { padding-right: 20px; padding-left: 20px; text-align: left; }
            .footer { background: #ddd; padding: 10px; text-align: center; font-size: 14px; font-weight: bold; }
            .roomType { font-weight: bold; text-transform: capitalize; }
            table { width: 100%; border-collapse: collapse; }
            th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
            th { background-color: #ff6f61; color: white; }
            h2 { font-weight: bold; font-size: 1.5rem; }
            strong { font-weight: bold; }
            .confirmation {
                font-size: 1rem;
                font-weight: bold;
            }
            p {
                font-size: 1.2rem;
                font-weight: bold;
            }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <h1>Your Payment Link</h1>
            </div>
            <div class="content">
                <p>Please click <a href="${paymentLink}" target="_blank" rel="noopener noreferrer">here</a> to pay:</p>
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
            .header { background: #ff6f61; color: white; padding: 10px; text-align: center; }
            .content { padding-right: 20px; padding-left: 20px; text-align: left; }
            .footer { background: #ddd; padding: 10px; text-align: center; font-size: 14px; font-weight: bold; }
            .roomType { font-weight: bold; text-transform: capitalize; }
            table { width: 100%; border-collapse: collapse; }
            th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
            th { background-color: #ff6f61; color: white; }
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

	const paidAmount = Number(reservationData.paid_amount).toFixed(2);
	const reservationTotalAmount = Number(reservationData.total_amount).toFixed(
		2
	);
	const amountDue = Number(
		Number(reservationTotalAmount) - Number(paidAmount)
	).toFixed(2);

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
                background: linear-gradient(90deg, #20212c, #1e2332);
                color: #ffffff;
                text-align: center;
                padding: 20px;
                font-size: 1.8rem;
                font-weight: bold;
            }
            .content {
                padding: 20px;
                line-height: 1.6;
                color: #333333;
            }
            .content h2 {
                color: #20212c;
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
                border: 1px solid #dddddd;
                text-align: left;
            }
            th {
                background-color: #20212c;
                color: #ffffff;
            }
            .total-row {
                background-color: #f2f2f2;
                font-weight: bold;
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
            @media (max-width: 768px) {
                .content {
                    padding: 15px;
                }
                table, th, td {
                    font-size: 0.9rem;
                    text-transform: capitalize;
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
                <h2>Hi ${customerDetails.name || "Valued Guest"},</h2>
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

module.exports = {
	confirmationEmail,
	reservationUpdate,
	emailPaymentLink,
	paymentReceipt,
	ClientConfirmationEmail,
};
