/** @format */

"use strict";

const express = require("express");
const router = express.Router();

const { requireSignin, isAuth } = require("../controllers/auth");
const { userById } = require("../controllers/user");
const {
	b2bChatRecipients,
	b2bChatList,
	b2bChatUnreadSummary,
	b2bChatRead,
	b2bChatStart,
	b2bChatSendMessage,
	b2bChatMarkSeen,
	b2bChatClose,
} = require("../controllers/b2b_chat");

router.get("/b2b-chat/recipients/:userId", requireSignin, isAuth, b2bChatRecipients);
router.get("/b2b-chat/chats/:userId", requireSignin, isAuth, b2bChatList);
router.get(
	"/b2b-chat/unread/:userId",
	requireSignin,
	isAuth,
	b2bChatUnreadSummary
);
router.post("/b2b-chat/start/:userId", requireSignin, isAuth, b2bChatStart);
router.get("/b2b-chat/:chatId/:userId", requireSignin, isAuth, b2bChatRead);
router.post(
	"/b2b-chat/:chatId/message/:userId",
	requireSignin,
	isAuth,
	b2bChatSendMessage
);
router.post(
	"/b2b-chat/:chatId/seen/:userId",
	requireSignin,
	isAuth,
	b2bChatMarkSeen
);
router.post(
	"/b2b-chat/:chatId/close/:userId",
	requireSignin,
	isAuth,
	b2bChatClose
);

router.param("userId", userById);

module.exports = router;
