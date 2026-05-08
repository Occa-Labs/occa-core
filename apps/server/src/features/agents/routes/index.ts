// Agents API surface — mount point. Sub-routers split by resource so a
// 1700-LOC monolith doesn't keep growing. Each file is independently
// reviewable; this composer just stitches them together under the same
// `/api/agents` prefix that `index.ts` already wires up.
//
// Mount order matters. `self-actions.ts` owns `/me/approvals` and MUST
// be registered before `lifecycle.ts` — otherwise Express would treat
// "me" as an `:id` param and 404 (or worse, look it up as an agent UUID
// owned by the caller).

import { Router } from "express";
import selfActionsRouter from "./self-actions";
import agentActionsRouter from "./agent-actions";
import chatRouter from "./chat";
import skillSyncsRouter from "./skill-syncs";
import tracesRouter from "./traces";
import tokensRouter from "./tokens";
import lifecycleRouter from "./lifecycle";

const router: Router = Router();

// /me/* — agent-token authenticated, must precede /:id-prefixed routes.
router.use(selfActionsRouter);
router.use(agentActionsRouter);

// /:id-scoped — order between these doesn't matter (paths are distinct).
router.use(chatRouter);
router.use(skillSyncsRouter);
router.use(tracesRouter);
router.use(tokensRouter);

// Lifecycle owns the bare `/` endpoint plus generic `/:id` so it
// registers last — keeps wildcard `:id` matchers from intercepting
// child paths defined in earlier routers.
router.use(lifecycleRouter);

export default router;
