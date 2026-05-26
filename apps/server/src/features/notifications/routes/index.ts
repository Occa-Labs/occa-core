import { Router, type Request, type Response } from "express";
import { ERROR_CODES } from "@occa/shared/error-codes";
import { StatusCodes } from "http-status-codes";
import type {
  ListNotificationsResponse,
  NotificationActionResponse,
} from "@occa/shared/types";
import { requireAuth } from "../../../middleware/auth";
import { toNotificationDTO } from "../domain/dto";
import { listQuery } from "../domain/schemas";
import {
  dismiss,
  findByIdForUser,
  listForUser,
  markAllReadForUser,
  markRead,
  unreadCountForUser,
} from "../repositories/notifications";

const router: Router = Router();

// GET /api/notifications?unread=1&limit=50
router.get("/", requireAuth, async (req: Request, res: Response) => {
  const q = listQuery.safeParse(req.query);
  if (!q.success) {
    res
      .status(StatusCodes.BAD_REQUEST)
      .json({ error: ERROR_CODES.INVALID_QUERY });
    return;
  }
  const userId = req.user!.userId;
  const [rows, unreadCount] = await Promise.all([
    listForUser(userId, q.data),
    unreadCountForUser(userId),
  ]);
  const body: ListNotificationsResponse = {
    notifications: rows.map(toNotificationDTO),
    unreadCount,
  };
  res.json(body);
});

// POST /api/notifications/:id/read
router.post("/:id/read", requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const row = await findByIdForUser(req.params.id, userId);
  if (!row) {
    res
      .status(StatusCodes.NOT_FOUND)
      .json({ error: ERROR_CODES.NOTIFICATION_NOT_FOUND });
    return;
  }
  // Idempotent — re-marking is a no-op flip back to existing readAt.
  const updated = row.readAt ? row : await markRead(row.id);
  const body: NotificationActionResponse = {
    notification: toNotificationDTO(updated),
  };
  res.json(body);
});

// POST /api/notifications/:id/dismiss
router.post(
  "/:id/dismiss",
  requireAuth,
  async (req: Request, res: Response) => {
    const userId = req.user!.userId;
    const row = await findByIdForUser(req.params.id, userId);
    if (!row) {
      res
        .status(StatusCodes.NOT_FOUND)
        .json({ error: ERROR_CODES.NOTIFICATION_NOT_FOUND });
      return;
    }
    const updated = row.dismissedAt ? row : await dismiss(row.id);
    const body: NotificationActionResponse = {
      notification: toNotificationDTO(updated),
    };
    res.json(body);
  },
);

// POST /api/notifications/read-all — mark every unread notification read
router.post("/read-all", requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const updated = await markAllReadForUser(userId);
  res.json({ updated });
});

export default router;
