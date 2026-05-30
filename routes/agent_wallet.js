/** @format */

"use strict";

const express = require("express");
const router = express.Router();
const { requireSignin } = require("../controllers/auth");
const {
	agentWalletSummary,
	agentTodoList,
	createAgentWalletClaim,
	createAgentWalletTransaction,
	reviewAgentWalletClaim,
	updateAgentWalletTransaction,
	voidAgentWalletTransaction,
} = require("../controllers/agent_wallet");

router.get(
	"/agent-wallet/summary/:userId",
	requireSignin,
	agentWalletSummary
);

router.get(
	"/agent-wallet/summary/:hotelId/:userId",
	requireSignin,
	agentWalletSummary
);

router.get(
	"/agent-wallet/todos/:userId",
	requireSignin,
	agentTodoList
);

router.get(
	"/agent-wallet/todos/:hotelId/:userId",
	requireSignin,
	agentTodoList
);

router.post(
	"/agent-wallet/claims/:userId",
	requireSignin,
	createAgentWalletClaim
);

router.post(
	"/agent-wallet/claims/:hotelId/:userId",
	requireSignin,
	createAgentWalletClaim
);

router.put(
	"/agent-wallet/claims/:userId/:transactionId/review",
	requireSignin,
	reviewAgentWalletClaim
);

router.put(
	"/agent-wallet/claims/:hotelId/:userId/:transactionId/review",
	requireSignin,
	reviewAgentWalletClaim
);

router.post(
	"/agent-wallet/transactions/:userId",
	requireSignin,
	createAgentWalletTransaction
);

router.post(
	"/agent-wallet/transactions/:hotelId/:userId",
	requireSignin,
	createAgentWalletTransaction
);

router.put(
	"/agent-wallet/transactions/:userId/:transactionId",
	requireSignin,
	updateAgentWalletTransaction
);

router.put(
	"/agent-wallet/transactions/:hotelId/:userId/:transactionId",
	requireSignin,
	updateAgentWalletTransaction
);

router.delete(
	"/agent-wallet/transactions/:userId/:transactionId",
	requireSignin,
	voidAgentWalletTransaction
);

router.delete(
	"/agent-wallet/transactions/:hotelId/:userId/:transactionId",
	requireSignin,
	voidAgentWalletTransaction
);

module.exports = router;
