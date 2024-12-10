const axios = require("axios");
require("dotenv").config();

exports.createPayment = async (req, res) => {
	const {
		amount,
		cardNumber,
		expirationDate,
		cardCode,
		customerDetails,
		checkinDate,
		checkoutDate,
		hotelName,
	} = req.body;

	try {
		// Construct payload with additional fields
		const payload = {
			createTransactionRequest: {
				merchantAuthentication: {
					name: process.env.API_LOGIN_ID_SANDBOX,
					transactionKey: process.env.TRANSACTION_KEY_SANDBOX,
				},
				transactionRequest: {
					transactionType: "authCaptureTransaction", // Must come first
					amount: amount.toString(),
					payment: {
						creditCard: {
							cardNumber: cardNumber,
							expirationDate: expirationDate,
							cardCode: cardCode,
						},
					},
					// Billing information
					billTo: {
						firstName: customerDetails.name.split(" ")[0] || "",
						lastName: customerDetails.name.split(" ")[1] || "",
						address: customerDetails.address || "N/A",
						city: customerDetails.city || "N/A",
						state: customerDetails.state || "N/A",
						zip: customerDetails.postalCode || "00000",
						country: customerDetails.country || "US",
						email: customerDetails.email || "",
					},
					// Shipping information
					shipTo: {
						firstName: customerDetails.name.split(" ")[0] || "",
						lastName: customerDetails.name.split(" ")[1] || "",
						address: customerDetails.address || "N/A",
						city: customerDetails.city || "N/A",
						state: customerDetails.state || "N/A",
						zip: customerDetails.postalCode || "00000",
						country: customerDetails.country || "US",
					},
					// Include custom data in userFields
					userFields: {
						userField: [
							{
								name: "checkin_date",
								value: checkinDate,
							},
							{
								name: "checkout_date",
								value: checkoutDate,
							},
							{
								name: "hotel_name",
								value: hotelName,
							},
						],
					},
					// Optional order details (useful for human-readable info)
					order: {
						invoiceNumber: `INV-${Date.now()}`, // Unique invoice number
						description: `Hotel Reservation at ${hotelName} from ${checkinDate} to ${checkoutDate}`,
					},
				},
			},
		};

		console.log("Request Payload:", JSON.stringify(payload, null, 2)); // Debugging

		// Send the request manually using axios
		const response = await axios.post(
			"https://apitest.authorize.net/xml/v1/request.api",
			payload,
			{
				headers: {
					"Content-Type": "application/json",
				},
			}
		);

		const responseData = response.data;
		console.log("Raw API Response:", JSON.stringify(responseData, null, 2));

		if (
			responseData.messages.resultCode === "Ok" &&
			responseData.transactionResponse &&
			responseData.transactionResponse.messages
		) {
			// Success
			return res.status(200).json({
				success: true,
				transactionId: responseData.transactionResponse.transId,
				message: responseData.transactionResponse.messages[0].description,
			});
		} else {
			// Failure
			const errorText =
				responseData.transactionResponse?.errors?.[0]?.errorText ||
				responseData.messages.message[0].text ||
				"Transaction failed.";
			console.error("Error Details:", errorText);
			return res.status(400).json({ success: false, message: errorText });
		}
	} catch (error) {
		console.error("Execution Error:", error.message || error);
		return res
			.status(500)
			.json({ success: false, message: error.message || "Unexpected error." });
	}
};
