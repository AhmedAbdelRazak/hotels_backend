/** @format */

const express = require("express");
const router = express.Router();

const { requireSignin, isAuth } = require("../controllers/auth");
const { userById } = require("../controllers/user");

const {
	expenseById,
	createExpense,
	readExpense,
	listExpenses,
	listExpenseHotels,
	financialReport,
	updateExpense,
	removeExpense,
} = require("../controllers/expenses");

router.post("/expenses/create/:userId", requireSignin, isAuth, createExpense);
router.get("/expenses/list/:userId", requireSignin, isAuth, listExpenses);
router.get("/expenses/hotels/:userId", requireSignin, isAuth, listExpenseHotels);
router.get(
	"/expenses/financial-report/:userId",
	requireSignin,
	isAuth,
	financialReport
);
router.get("/expenses/:expenseId/:userId", requireSignin, isAuth, readExpense);
router.put("/expenses/:expenseId/:userId", requireSignin, isAuth, updateExpense);
router.delete(
	"/expenses/:expenseId/:userId",
	requireSignin,
	isAuth,
	removeExpense
);

router.param("userId", userById);
router.param("expenseId", expenseById);

module.exports = router;
