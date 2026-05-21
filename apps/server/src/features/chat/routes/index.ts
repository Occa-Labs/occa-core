// Mount point for the chat feature. Currently a single sub-router for
// the user ↔ CEO surface; future agent-to-agent or per-agent chats can
// be added here without touching the server entrypoint.

import { Router } from "express";
import ceoChatRouter from "./chat";
import inboxRouter from "./inbox";

const chatRouter: Router = Router();
chatRouter.use("/", ceoChatRouter);
chatRouter.use("/", inboxRouter);

export default chatRouter;
