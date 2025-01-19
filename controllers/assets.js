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
										).toLocaleString()} SAR</td>
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
								).toLocaleString()} SAR</td>
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
                background-color: #ff6f61;
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
                color: #ff6f61;
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
                background-color: #ff6f61;
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
	SendingReservationLinkEmail,
	ReservationVerificationEmail,
	newSupportCaseEmail,
};
