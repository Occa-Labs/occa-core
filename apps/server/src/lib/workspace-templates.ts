// Workspace file templating.
//
// Each new agent gets 8 markdown files seeded into their OpenClaw workspace.
// Templates live on disk under apps/server/src/onboarding-assets/<role>/,
// with apps/server/src/onboarding-assets/default/ as the fallback for roles
// that don't have a specific override.
//
// We render with tiny Mustache-style `{{var}}` substitution — no new deps.
// Placeholders support dot-paths into the context object (e.g.
// `{{agent.name}}` or `{{runtime.externalAgentId}}`).

import { promises as fs } from "node:fs";
import path from "node:path";
import { KNOWN_ROLES, roleLabelFor as sharedRoleLabelFor } from "@occa/shared";

export { sharedRoleLabelFor as roleLabelFor };

// The canonical 8-file set every new agent ships with. Order matters for
// BOOTSTRAP.md instructions that reference the others, but at render time we
// still produce an object keyed by filename.
export const WORKSPACE_FILENAMES = [
  "AGENTS.md",
  "SOUL.md",
  "IDENTITY.md",
  "USER.md",
  "TOOLS.md",
  "HEARTBEAT.md",
  "BOOTSTRAP.md",
  "MEMORY.md",
] as const;

export type WorkspaceFilename = (typeof WORKSPACE_FILENAMES)[number];

export interface TemplateContext {
  agent: {
    name: string;
    role: string; // slug: "ceo" | "cto" | ...
    roleLabel: string; // display: "CEO" | "Chief Strategy Officer" | ...
  };
  company: {
    name: string;
  };
  runtime: {
    externalAgentId: string;
    workspacePath: string;
    createdAt: string; // ISO timestamp
    todayIso: string; // YYYY-MM-DD, used inside HEARTBEAT.md
    apiUrl: string; // OCCA public URL agents use for callbacks
  };
}

export interface RenderedFile {
  filename: WorkspaceFilename;
  content: string;
  templateOrigin: string; // "<role>/<filename>" or "default/<filename>"
}

const ASSETS_ROOT = path.resolve(__dirname, "../onboarding-assets");

function substitute(tpl: string, ctx: TemplateContext): string {
  // Match {{ path.to.value }} with whitespace tolerance. Unknown paths are
  // left as the literal token so the markdown is still valid — anything the
  // caller didn't plumb through surfaces as an obvious `{{foo.bar}}` in the
  // output instead of silently disappearing.
  return tpl.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (match, expr: string) => {
    const parts = expr.split(".");
    let cur: unknown = ctx;
    for (const p of parts) {
      if (cur && typeof cur === "object" && p in (cur as Record<string, unknown>)) {
        cur = (cur as Record<string, unknown>)[p];
      } else {
        return match;
      }
    }
    return typeof cur === "string" ? cur : match;
  });
}

async function readIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function loadTemplate(
  roleSlug: string,
  filename: WorkspaceFilename,
): Promise<{ raw: string; origin: string } | null> {
  // Only probe the role-specific dir when the role is one we seeded with
  // overrides. Custom roles skip straight to default/ — avoids stat()-ing a
  // pile of guaranteed-missing paths.
  if (KNOWN_ROLES.has(roleSlug)) {
    const rolePath = path.join(ASSETS_ROOT, roleSlug, filename);
    const roleContent = await readIfExists(rolePath);
    if (roleContent !== null) {
      return { raw: roleContent, origin: `${roleSlug}/${filename}` };
    }
  }
  const defaultPath = path.join(ASSETS_ROOT, "default", filename);
  const defaultContent = await readIfExists(defaultPath);
  if (defaultContent !== null) {
    return { raw: defaultContent, origin: `default/${filename}` };
  }
  return null;
}

// Build the full 8-file set for a new agent. Any missing template is a
// deployment error — the caller should treat a rejected promise as "agent
// can't be seeded, roll back the create". The only template guaranteed to
// always exist is default/*; if default/<filename> is missing the repo is
// broken.
export async function renderWorkspaceFiles(
  ctx: TemplateContext,
): Promise<RenderedFile[]> {
  const out: RenderedFile[] = [];
  for (const filename of WORKSPACE_FILENAMES) {
    const loaded = await loadTemplate(ctx.agent.role, filename);
    if (!loaded) {
      throw new Error(
        `workspace template missing: no role-specific or default template for ${filename}`,
      );
    }
    out.push({
      filename,
      content: substitute(loaded.raw, ctx),
      templateOrigin: loaded.origin,
    });
  }
  return out;
}
