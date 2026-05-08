// Composes the routers that belong to the `tasks` feature.
//
// Two distinct mounts at top-level:
//   * `/api/tasks` — user JWT (CRUD + user-side comments)
//   * `/api/agents` — agent token (agent-side comments at /me/:id)
//
// Exporting both as named exports lets the server entrypoint mount
// each one under the correct prefix without merging mount semantics.

import tasksRouter from "./tasks";
import taskCommentsRouter from "./task-comments";
import taskEventsRouter from "./task-events";
import taskArchiveRouter from "./task-archive";
import agentTaskCommentsRouter from "./agent-task-comments";
import { Router } from "express";

// Combined user-JWT router for /api/tasks.
const tasksFeatureRouter: Router = Router();
tasksFeatureRouter.use(tasksRouter);
tasksFeatureRouter.use(taskCommentsRouter);
tasksFeatureRouter.use(taskEventsRouter);
tasksFeatureRouter.use(taskArchiveRouter);

export { tasksFeatureRouter, agentTaskCommentsRouter };
export default tasksFeatureRouter;
