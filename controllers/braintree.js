/** @format */

const braintree = require("braintree");
const Reservations = require("../models/reservations");
const HotelDetails = require("../models/hotel_details");
const fetch = require("node-fetch");
const sgMail = require("@sendgrid/mail");
require("dotenv").config();
const puppeteer = require("puppeteer");
const { paymentReceipt } = require("./assets");

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

var gateway = new braintree.BraintreeGateway({
	environment: braintree.Environment.Production, // Production Sandbox
	merchantId: process.env.BRAINTREE_MERCHANT_ID,
	publicKey: process.env.BRAINTREE_PUBLIC_KEY,
	privateKey: process.env.BRAINTREE_PRIVATE_KEY,
});

const createPdfBuffer = async (html) => {
	const browser = await puppeteer.launch({
		headless: true,
		args: [
			"--no-sandbox",
			"--disable-setuid-sandbox",
			"--disable-dev-shm-usage",
			"--disable-accelerated-2d-canvas",
			"--no-first-run",
			"--no-zygote",
			"--single-process", // <- this one doesn't works in Windows
			"--disable-gpu",
		],
	});

	const page = await browser.newPage();
	await page.setContent(html, { waitUntil: "networkidle0" });
	const pdfBuffer = await page.pdf({ format: "A4" });
	await browser.close();
	return pdfBuffer;
};

const sendEmailWithPdf = async (
	updatedReservation,
	hotelName,
	amountFromTheClient,
	transactionDetails
) => {
	// Dynamically generating HTML content for the email body and PDF
	const htmlContent = paymentReceipt(
		updatedReservation,
		hotelName,
		amountFromTheClient,
		transactionDetails
	);
	const pdfBuffer = await createPdfBuffer(htmlContent);

	const FormSubmittionEmail = {
		to: updatedReservation.customer_details.email
			? updatedReservation.customer_details.email
			: "ahmedabdelrazak20@gmail.com",
		from: "noreply@janatbooking.com",
		// cc: [
		// 	{ email: "ayed.hotels@gmail.com" },
		// 	{ email: "zaerhotel@gmail.com" },
		// 	{ email: "3yedhotel@gmail.com" },
		// 	{ email: "morazzakhamouda@gmail.com" },
		// ],
		bcc: [
			{ email: "ayed.hotels@gmail.com" },
			{ email: "zaerhotel@gmail.com" },
			{ email: "3yedhotel@gmail.com" },
			{ email: "morazzakhamouda@gmail.com" },
			{ email: "ahmed.abdelrazak@infinite-apps.com" },
		],
		subject: `Janat Booking - Reservation Confirmation`,
		html: htmlContent,
		attachments: [
			{
				content: pdfBuffer.toString("base64"),
				filename: "Payment_Receipt.pdf",
				type: "application/pdf",
				disposition: "attachment",
			},
		],
	};

	try {
		await sgMail.send(FormSubmittionEmail);
	} catch (error) {
		console.error(
			"Error sending email with PDF error.response.boyd",
			error.response.body
		);
		console.error("Error sending email with PDF", error);
		// Handle error appropriately
	}
};

exports.generateToken = (req, res) => {
	gateway.clientToken.generate({}, function (err, response) {
		if (err) {
			console.log(err, "err from braintree");
			res.status(500).send(err);
		} else {
			res.send(response);
		}
	});
};

exports.processPayment = (req, res) => {
	let nonceFromTheClient = req.body.paymentMethodNonce;
	let hotelName = req.body.hotelName;
	let amountFromTheClient = parseFloat(req.body.amount).toFixed(2); // Ensure amount is in a valid format
	let amountFromTheClientInSAR = parseFloat(req.body.amountInSAR).toFixed(2); // Ensure amount is in a valid format
	let reservationId = req.params.reservationId; // Get reservationId from request parameters

	let merchantAccountId = "infiniteapps_instant"; // Merchant account ID for transactions in USD

	gateway.transaction.sale(
		{
			amount: amountFromTheClient,
			merchantAccountId: merchantAccountId, // Specify the merchant account ID
			paymentMethodNonce: nonceFromTheClient,
			options: {
				submitForSettlement: true,
			},
		},
		(error, result) => {
			if (error) {
				console.error("Braintree error:", error);
				return res.status(500).json({
					success: false,
					error: "An error occurred processing your payment.",
				});
			}

			if (result.success) {
				const transactionDetails = {
					transactionId: result.transaction.id,
					amount: result.transaction.amount,
					currency: result.transaction.currencyIsoCode,
					status: result.transaction.status,
					paymentMethodToken: result.transaction.creditCard
						? result.transaction.creditCard.token
						: undefined,
					createdAt: result.transaction.createdAt,
				};

				Reservations.findByIdAndUpdate(
					reservationId,
					{
						$set: {
							payment_details: transactionDetails,
							paid_amount: amountFromTheClientInSAR,
							payment: "Paid (Affiliate)",
						},
					},
					{ new: true },
					(err, updatedReservation) => {
						if (err) {
							console.error("Database update error:", err);
							return res.status(500).json({
								success: false,
								error: "Failed to update reservation with payment details.",
							});
						}

						res.json({
							success: true, // Explicitly indicate success for clarity
							message:
								"Payment processed and reservation updated successfully.",
							updatedReservation: {
								id: updatedReservation._id,
								paymentDetails: transactionDetails,
							},
						});

						sendEmailWithPdf(
							updatedReservation,
							hotelName,
							amountFromTheClientInSAR,
							transactionDetails
						);
					}
				);
			} else {
				console.error(
					"Braintree transaction failed:",
					JSON.stringify(result, null, 4)
				);
				const detailedErrors = extractBraintreeErrors(result.errors);
				console.error("Detailed validation errors:", detailedErrors);
				res.status(400).json({
					success: false, // Explicitly indicate failure
					error: "Payment was not successful.",
					details: detailedErrors,
				});
			}
		}
	);
};

exports.processPayment_SAR = (req, res) => {
	let nonceFromTheClient = req.body.paymentMethodNonce;
	let hotelName = req.body.hotelName;
	let amountFromTheClient = parseFloat(req.body.amount).toFixed(2); // Ensure amount is in a valid format
	let amountFromTheClientInSAR = parseFloat(req.body.amountInSAR).toFixed(2); // Ensure amount is in a valid format
	let reservationId = req.params.reservationId; // Get reservationId from request parameters
	let chosenCurrency = req.body.chosenCurrency;
	let merchantAccountId =
		chosenCurrency === "SAR" ? "infiniteapps_SAR" : "infiniteapps_instant"; // Merchant account ID for transactions in USD

	console.log(chosenCurrency, "chosenCurrencychosenCurrencychosenCurrency");
	console.log(amountFromTheClient, "amountFromTheClientamountFromTheClient");
	console.log(req.body.confirmation_number, "req.body.confirmation_number");
	console.log(req.body.name, "req.body.name");
	console.log(req.body.passport, "req.body.passport");
	console.log(req.body.nationality, "req.body.nationality");
	console.log(req.body.phone, "req.body.phone");

	gateway.transaction.sale(
		{
			amount: amountFromTheClient,
			merchantAccountId: merchantAccountId, // Specify the merchant account ID
			paymentMethodNonce: nonceFromTheClient,
			creditCard: {
				cardholderName: req.body.name,
			},
			customFields: {
				confirmation_number: req.body.confirmation_number,
				passport: req.body.passport,
				nationality: req.body.nationality,
				phone: req.body.phone,
			},
			options: {
				submitForSettlement: true,
			},
		},
		(error, result) => {
			if (error) {
				console.error("Braintree error:", error);
				return res.status(500).json({
					success: false,
					error: "An error occurred processing your payment.",
				});
			}

			if (result.success) {
				const transactionDetails = {
					transactionId: result.transaction.id,
					amount: result.transaction.amount,
					currency: result.transaction.currencyIsoCode,
					status: result.transaction.status,
					paymentMethodToken: result.transaction.creditCard
						? result.transaction.creditCard.token
						: undefined,
					createdAt: result.transaction.createdAt,
				};

				Reservations.findByIdAndUpdate(
					reservationId,
					{
						$set: {
							payment_details: transactionDetails,
							paid_amount: amountFromTheClientInSAR,
							payment: "collected",
						},
					},
					{ new: true },
					(err, updatedReservation) => {
						if (err) {
							console.error("Database update error:", err);
							return res.status(500).json({
								success: false,
								error: "Failed to update reservation with payment details.",
							});
						}

						res.json({
							success: true, // Explicitly indicate success for clarity
							message:
								"Payment processed and reservation updated successfully.",
							updatedReservation: {
								id: updatedReservation._id,
								paymentDetails: transactionDetails,
							},
						});

						// sendEmailWithPdf(
						// 	updatedReservation,
						// 	hotelName,
						// 	amountFromTheClientInSAR,
						// 	transactionDetails
						// );
					}
				);
			} else {
				console.error(
					"Braintree transaction failed:",
					JSON.stringify(result, null, 4)
				);
				const detailedErrors = extractBraintreeErrors(result.errors);
				console.error("Detailed validation errors:", detailedErrors);
				res.status(400).json({
					success: false, // Explicitly indicate failure
					error: "Payment was not successful.",
					details: detailedErrors,
				});
			}
		}
	);
};

exports.processPaymentWithCommission = (req, res) => {
	let nonceFromTheClient = req.body.paymentMethodNonce;
	let hotelName = req.body.hotelName;
	let amountFromTheClient = parseFloat(req.body.amount).toFixed(2); // Ensure amount is in a valid format
	let reservationIds = req.body.reservationIds; // Get reservationIds from request body

	let merchantAccountId = "infiniteapps_instant"; // Merchant account ID for transactions in USD

	gateway.transaction.sale(
		{
			amount: amountFromTheClient,
			merchantAccountId: merchantAccountId, // Specify the merchant account ID
			paymentMethodNonce: nonceFromTheClient,
			options: {
				submitForSettlement: true,
			},
		},
		(error, result) => {
			if (error) {
				console.error("Braintree error:", error);
				return res.status(500).json({
					success: false,
					error: "An error occurred processing your payment.",
				});
			}

			if (result.success) {
				const transactionDetails = {
					transactionId: result.transaction.id,
					amount: result.transaction.amount,
					currency: result.transaction.currencyIsoCode,
					status: result.transaction.status,
					paymentMethodToken: result.transaction.creditCard
						? result.transaction.creditCard.token
						: undefined,
					createdAt: result.transaction.createdAt,
				};

				// Update multiple reservations based on reservationIds
				Reservations.updateMany(
					{ _id: { $in: reservationIds } },
					{
						$set: {
							payment_details: transactionDetails,
							paid_amount: amountFromTheClient,
							payment: "Paid",
							financeStatus: "paid", // Set financeStatus to "paid"
						},
					},
					{ new: true },
					(err, updatedReservations) => {
						if (err) {
							console.error("Database update error:", err);
							return res.status(500).json({
								success: false,
								error: "Failed to update reservations with payment details.",
							});
						}

						res.json({
							success: true, // Explicitly indicate success for clarity
							message:
								"Payment processed and reservations updated successfully.",
							updatedReservationsCount: updatedReservations.nModified, // Number of modified reservations
						});

						// Optionally, send emails with PDFs for each updated reservation
						// reservationIds.forEach((reservationId) => {
						//     const updatedReservation = updatedReservations.find((res) => res._id.toString() === reservationId);
						//     sendEmailWithPdf(updatedReservation, hotelName, amountFromTheClient, transactionDetails);
						// });
					}
				);
			} else {
				console.error(
					"Braintree transaction failed:",
					JSON.stringify(result, null, 4)
				);
				const detailedErrors = extractBraintreeErrors(result.errors);
				console.error("Detailed validation errors:", detailedErrors);
				res.status(400).json({
					success: false, // Explicitly indicate failure
					error: "Payment was not successful.",
					details: detailedErrors,
				});
			}
		}
	);
};

function extractBraintreeErrors(errors) {
	const errorMessages = [];
	if (errors && errors.deepErrors) {
		for (const deepError of errors.deepErrors()) {
			errorMessages.push({
				code: deepError.code,
				message: deepError.message,
			});
		}
	}
	return errorMessages;
}

exports.processSubscription = (req, res) => {
	console.log(
		req.body,
		"this is req.body for subscription from braintreeController"
	);

	let nonceFromTheClient = req.body.paymentMethodNonce;
	let amountFromTheClient = req.body.amount;
	let hotelId = req.body.hotelId; // Assuming you pass the hotel ID in the request body

	// charge
	gateway.customer.create(
		{
			id: req.body.customerId,
			email: req.body.email,
		},
		(err) => {
			if (err) return res.status(500).send(err);
			gateway.paymentMethod.create(
				{
					customerId: req.body.customerId,
					paymentMethodNonce: nonceFromTheClient,
				},
				(err, result) => {
					if (err) return res.status(500).send(err);
					gateway.subscription.create(
						{
							paymentMethodToken: result.paymentMethod.token,
							planId: req.body.planId,
							price: amountFromTheClient,
							trialDuration: req.body.trialDuration,
							trialDurationUnit: req.body.trialDurationUnit,
						},
						(err, result) => {
							console.log(err, "from processing the subscription");
							if (err) return res.status(500).send(err);

							console.log(result, "result.subscription From Subscription");

							// Update HotelDetails document
							HotelDetails.findByIdAndUpdate(
								hotelId,
								{
									subscribed: true,
									subscriptionToken: result.subscription.paymentMethodToken,
									subscriptionId: result.subscription.id,
								},
								{ new: true },
								(err, updatedHotel) => {
									if (err) return res.status(500).send(err);

									res.status(201).json({
										result: "success",
										subscription: result.subscription,
										updatedHotel: updatedHotel,
									});
								}
							);
						}
					);
				}
			);
		}
	);
};

exports.gettingBraintreeDataById = (req, res) => {
	// console.log(req.body, "from getting data in braintree");
	gateway.subscription.find(req.params.planId, (err, result) => {
		if (err) return res.status(500).send(error);
		res.status(201).json({
			result: "success",
			result: result,
		});
	});
};

exports.processSubscriptionUpdate = (req, res) => {
	// console.log(
	// 	req.body,
	// 	req.params.subId,
	// 	"this is req.body for subscription update braintree",
	// );

	let nonceFromTheClient = req.body.paymentMethodNonce;
	let amountFromTheClient = req.body.amount;
	// charge
	gateway.paymentMethod.create(
		{
			customerId: req.body.customerId,
			paymentMethodNonce: nonceFromTheClient,
		},
		(err, result) => {
			if (err) return res.status(500).send(error);
			gateway.subscription.update(
				req.params.subId,
				{
					paymentMethodToken: result.paymentMethod.token,
					planId: req.body.planId,
					// planId: "quarterly_plan",
					price: amountFromTheClient,
					// price: "180.00",
				},
				(err, result) => {
					if (err) return res.status(500).send(error);
					console.log(result.subscription, "result.subscription");
					res.status(201).json({
						result: "success",
						subscription: result.subscription,
					});
					console.log("result Only", result, "result Only");
				}
			);
		}
	);
};

exports.gettingBraintreeDataById_Admin = (req, res) => {
	// console.log(req.body, "from getting data in braintree");

	gateway.subscription.find(req.params.planId, (err, result) => {
		if (err) return res.status(500).send(error);
		res.status(201).json({
			result: "success",
			result: result,
		});
	});
};

exports.gettingCurrencyConversion = (req, res) => {
	// Retrieve the amount in SAR from the request parameters
	const amountInSAR = req.params.saudimoney;

	// Construct the API URL using the provided documentation format
	const apiUrl = `https://v6.exchangerate-api.com/v6/${process.env.EXCHANGE_RATE}/pair/SAR/USD/${amountInSAR}`;

	// Make the API request
	fetch(apiUrl)
		.then((response) => response.json()) // Parsing the JSON response body
		.then((data) => {
			// Check if the API call was successful
			if (data.result === "success") {
				// Calculate the amount in USD
				const amountInUSD = data.conversion_result;

				// Construct the response object
				const responseObject = {
					USD: 1, // Assuming 1 USD to USD conversion rate
					SAR: data.conversion_rate, // The conversion rate from SAR to USD
					amountInSAR: amountInSAR, // The original amount in SAR
					amountInUSD: amountInUSD, // The converted amount in USD
				};

				// Send the response object
				res.json(responseObject);
			} else {
				// Handle the case where the API response is not successful
				res.status(500).json({ error: "Failed to convert currency" });
			}
		})
		.catch((error) => {
			// Handle any errors that occur during the API request
			res.status(500).json({ error: error.message });
		});
};

exports.updateSubscriptionCard = (req, res) => {
	let paymentMethodToken = req.body.paymentMethodToken;
	let subscriptionId = req.body.subscriptionId;

	console.log(subscriptionId, "subscriptionIssssssssssssssd");

	gateway.paymentMethod.update(
		paymentMethodToken,
		{
			paymentMethodNonce: req.body.paymentMethodNonce,
		},
		function (err, result) {
			if (err) {
				res.status(500).json(err);
			} else {
				gateway.subscription.update(
					subscriptionId,
					{
						paymentMethodToken: result.paymentMethod.token,
					},
					function (err, result) {
						if (err) {
							res.status(500).json(err);
						} else {
							res.json(result);
						}
					}
				);
			}
		}
	);
};

exports.getSubscriptionData = (req, res) => {
	const { subscriptionId } = req.params;

	gateway.subscription.find(subscriptionId, (err, subscription) => {
		if (err) {
			console.error("error retrieving subscription", err);
			res.status(500).send(err);
		} else {
			res.send(subscription);
		}
	});
};

exports.getStoredPaymentData = (req, res) => {
	let paymentMethodToken = req.params.token;

	gateway.paymentMethod.find(paymentMethodToken, function (err, paymentMethod) {
		if (err) {
			console.log(err, "error retrieving payment method");
			res.status(500).json(err);
		} else {
			res.json({
				last4: paymentMethod.last4,
				cardType: paymentMethod.cardType,
				expirationDate: paymentMethod.expirationDate,
			});
		}
	});
};
