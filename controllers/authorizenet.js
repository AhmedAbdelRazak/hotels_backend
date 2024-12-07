const { APIContracts, APIControllers } = require("authorizenet");
require("dotenv").config();

exports.createPayment = async (req, res) => {
	console.log("Request Body: ", req.body); // Debugging: Log incoming request data
	console.log("API_LOGIN_ID: ", process.env.API_LOGIN_ID); // Debugging: Log API credentials
	console.log("TRANSACTION_KEY: ", process.env.TRANSACTION_KEY);

	try {
		const { amount, cardNumber, expirationDate, cardCode, cardHolderName } =
			req.body;

		// Validate essential fields
		if (!amount || !cardNumber || !expirationDate || !cardCode) {
			return res
				.status(400)
				.json({ error: "Missing required payment details" });
		}

		// Format expirationDate into MMYY (e.g., "12/2026" -> "1226")
		const formattedExpirationDate =
			expirationDate.length === 6
				? expirationDate.slice(0, 2) + expirationDate.slice(4) // Handle "122026"
				: expirationDate.replace("/", ""); // Handle "12/2026"

		console.log("Formatted Expiration Date: ", formattedExpirationDate); // Debugging

		// Set up authentication
		const merchantAuthentication =
			new APIContracts.MerchantAuthenticationType();
		merchantAuthentication.setName(process.env.API_LOGIN_ID);
		merchantAuthentication.setTransactionKey(process.env.TRANSACTION_KEY);

		// Configure credit card details
		const creditCard = new APIContracts.CreditCardType();
		creditCard.setCardNumber(cardNumber.replace(/\s/g, "")); // Remove spaces for safety
		creditCard.setExpirationDate(formattedExpirationDate);
		creditCard.setCardCode(cardCode);

		// Link payment type to the credit card
		const paymentType = new APIContracts.PaymentType();
		paymentType.setCreditCard(creditCard);

		// Prepare transaction request
		const transactionRequest = new APIContracts.TransactionRequestType();

		// Set the transaction type (must be set first)
		transactionRequest.setTransactionType(
			APIContracts.TransactionTypeEnum.AUTH_CAPTURE_TRANSACTION // Capture payment
		);

		// Set amount
		transactionRequest.setAmount(parseFloat(amount)); // Ensure numeric amount

		// Add payment details
		transactionRequest.setPayment(paymentType);

		// Set billing information if cardHolderName is provided
		if (cardHolderName) {
			const billTo = new APIContracts.CustomerAddressType();
			billTo.setFirstName(cardHolderName.split(" ")[0] || "N/A");
			billTo.setLastName(cardHolderName.split(" ")[1] || "N/A");
			transactionRequest.setBillTo(billTo);
		}

		// Prepare the transaction request payload
		const createRequest = new APIContracts.CreateTransactionRequest();
		createRequest.setMerchantAuthentication(merchantAuthentication);
		createRequest.setTransactionRequest(transactionRequest);

		console.log(
			"Formatted Transaction Request: ",
			JSON.stringify(createRequest.getJSON(), null, 2) // Debugging: Log request data
		);

		// Execute the transaction
		const transactionResponse = await new Promise((resolve, reject) => {
			const transactionController =
				new APIControllers.CreateTransactionController(createRequest.getJSON());
			transactionController.execute(() => {
				const apiResponse = transactionController.getResponse();
				if (apiResponse && apiResponse.messages.resultCode === "Ok") {
					const response = apiResponse.getTransactionResponse();
					if (response && response.getResponseCode() === "1") {
						return resolve(response);
					} else {
						const error =
							response?.getErrors()?.[0]?.getErrorText() ||
							"Transaction failed.";
						return reject(new Error(error));
					}
				} else {
					const error =
						apiResponse?.messages?.message?.[0]?.text ||
						"Unknown error during transaction.";
					return reject(new Error(error));
				}
			});
		});

		// Handle successful transaction
		console.log("Transaction Successful: ", transactionResponse);
		return res.status(200).json({
			success: true,
			transactionId: transactionResponse.getTransId(),
			message: transactionResponse.getMessages()[0].getDescription(),
		});
	} catch (error) {
		// Handle errors gracefully
		console.error(
			"Error during transaction execution: ",
			error.message || error
		);
		return res.status(500).json({
			success: false,
			message: error.message || "An error occurred during payment processing.",
		});
	}
};
