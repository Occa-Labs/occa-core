// Domain schemas for Company Brain CRUD. Visibility values mirror the
// load-context filter — keep them in sync if you add new tiers.

import { z } from "zod";

export const BRAIN_VISIBILITIES = ["all", "ceo_only", "tier:head"] as const;
export type BrainVisibility = (typeof BRAIN_VISIBILITIES)[number];

// Path discipline: lead with `/brain/`, end with `.md`, no spaces or
// double-slashes. Keeps both UI display + server query consistent and
// gives the agent a predictable namespace via the memory tool later.
const PATH_REGEX = /^\/brain\/[a-z0-9][a-z0-9-]*\.md$/i;

export const createBrainFileBody = z.object({
  path: z
    .string()
    .min(1)
    .max(120)
    .regex(PATH_REGEX, {
      message: "Path must be /brain/<slug>.md (lowercase letters, digits, hyphens)",
    }),
  content: z.string().min(1).max(50_000),
  visibility: z.enum(BRAIN_VISIBILITIES).default("all"),
});
export type CreateBrainFileBody = z.infer<typeof createBrainFileBody>;

export const updateBrainFileBody = z.object({
  content: z.string().min(1).max(50_000).optional(),
  visibility: z.enum(BRAIN_VISIBILITIES).optional(),
});
export type UpdateBrainFileBody = z.infer<typeof updateBrainFileBody>;
