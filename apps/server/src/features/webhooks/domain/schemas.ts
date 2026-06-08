// Request validation for the company-webhook CRUD surface. A webhook is a
// connection: name + target URL + signing secret. Routing (which task fires
// which webhook) is deliberately not configured here — that moves to a
// reviewable workflow step. The DB filter columns stay at their empty default.

import { z } from "zod";
import { LIMITS } from "../../../lib/limits";
import type {
  CreateWebhookRequest,
  UpdateWebhookRequest,
} from "@occa/shared/types";

const urlSchema = z
  .string()
  .trim()
  .url()
  .max(LIMITS.URL)
  .refine((u) => u.startsWith("http://") || u.startsWith("https://"), {
    message: "must be an http(s) URL",
  });

const nameSchema = z.string().trim().min(1).max(LIMITS.NAME);
const secretSchema = z.string().min(1).max(LIMITS.WEBHOOK_SECRET);

export const createWebhookBody = z.object({
  name: nameSchema,
  targetUrl: urlSchema,
  secret: secretSchema,
  enabled: z.boolean().optional(),
}) satisfies z.ZodType<CreateWebhookRequest>;

export const updateWebhookBody = z.object({
  name: nameSchema.optional(),
  targetUrl: urlSchema.optional(),
  secret: secretSchema.optional(),
  enabled: z.boolean().optional(),
}) satisfies z.ZodType<UpdateWebhookRequest>;
