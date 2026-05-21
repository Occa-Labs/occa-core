import type { SkillFileEntry, SkillFileKind } from "@occa/shared/types";

// Default convention: "owner/repo/slug" → path "skills/<slug>" in the repo.
// Users who need a different layout pass a full GitHub tree URL.
const SKILL_DIR_CONVENTION = "skills";

export interface ParsedSkillSource {
  owner: string;
  repo: string;
  path: string; // path in repo to the skill directory (no leading/trailing slash)
  ref?: string; // branch/tag/sha — resolved to commit SHA downstream
  slug: string;
}

export class GithubSkillError extends Error {
  constructor(
    public code:
      | "invalid_source"
      | "no_skill_md"
      | "invalid_frontmatter"
      | "github_not_found"
      | "github_rate_limited"
      | "github_failed",
    message?: string,
  ) {
    super(message ?? code);
  }
}

export function parseSkillSource(input: string): ParsedSkillSource {
  const trimmed = input.trim();
  if (!trimmed) throw new GithubSkillError("invalid_source", "empty");

  // Case 2: GitHub URL — https://github.com/owner/repo/tree/ref/path/to/dir
  if (/^https?:\/\//i.test(trimmed)) {
    const url = safeUrl(trimmed);
    if (!url || url.hostname !== "github.com") {
      throw new GithubSkillError("invalid_source", "not a github.com URL");
    }
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length < 2) {
      throw new GithubSkillError("invalid_source", "missing owner/repo");
    }
    const [owner, repo, kind, ref, ...rest] = segments;
    if (kind && kind !== "tree" && kind !== "blob") {
      throw new GithubSkillError("invalid_source", "unsupported URL shape");
    }
    const path = rest.join("/");
    if (!path) {
      throw new GithubSkillError(
        "invalid_source",
        "URL must point to skill directory",
      );
    }
    const slug = rest[rest.length - 1]!;
    return {
      owner,
      repo,
      path: path.replace(/\/$/, ""),
      ref: ref || undefined,
      slug,
    };
  }

  // Case 1: "owner/repo/slug" shorthand
  const parts = trimmed.split("/").filter(Boolean);
  if (parts.length !== 3) {
    throw new GithubSkillError(
      "invalid_source",
      "shorthand must be owner/repo/slug",
    );
  }
  const [owner, repo, slug] = parts;
  return {
    owner,
    repo,
    path: `${SKILL_DIR_CONVENTION}/${slug}`,
    slug,
  };
}

function safeUrl(input: string): URL | null {
  try {
    return new URL(input);
  } catch {
    return null;
  }
}

export interface FetchedSkill {
  key: string;
  slug: string;
  name: string;
  description: string | null;
  markdown: string;
  sourceLocator: string;
  sourceRef: string; // commit SHA
  sourceOwner: string;
  sourceRepo: string;
  sourcePath: string;
  fileInventory: SkillFileEntry[];
  metadata: Record<string, unknown>;
}

export async function fetchGithubSkill(
  source: string,
  options: { forceDefaultBranch?: boolean } = {},
): Promise<FetchedSkill> {
  const parsed = parseSkillSource(source);

  // 1. Resolve ref → commit SHA. Default branch if no ref. When
  // forceDefaultBranch is set, ignore the ref baked into `source` (which
  // is typically the previously-pinned commit SHA on a refresh round-trip)
  // and resolve the repo's current default-branch HEAD instead.
  const refForResolve = options.forceDefaultBranch ? undefined : parsed.ref;
  const sha = await resolveRefToSha(parsed.owner, parsed.repo, refForResolve);

  // 2. Fetch recursive tree at sha.
  const tree = await fetchTree(parsed.owner, parsed.repo, sha);

  // 3. Filter blobs under parsed.path.
  const prefix = parsed.path.endsWith("/") ? parsed.path : `${parsed.path}/`;
  const blobs = tree.filter(
    (entry) => entry.type === "blob" && entry.path.startsWith(prefix),
  );
  if (blobs.length === 0) {
    throw new GithubSkillError(
      "github_not_found",
      `no files under ${parsed.path}`,
    );
  }

  const inventory: SkillFileEntry[] = blobs
    .map((entry) => ({
      path: entry.path.slice(prefix.length),
      kind: classify(entry.path),
    }))
    .filter((entry) => entry.path.length > 0);

  const hasSkillMd = inventory.some(
    (entry) => entry.path.toLowerCase() === "skill.md",
  );
  if (!hasSkillMd) {
    throw new GithubSkillError("no_skill_md");
  }

  // 4. Fetch SKILL.md raw content.
  const markdown = await fetchRaw(
    parsed.owner,
    parsed.repo,
    sha,
    `${parsed.path}/SKILL.md`,
  );

  // 5. Parse YAML frontmatter.
  const { name, description } = parseFrontmatter(markdown) ?? {};
  if (!name) {
    throw new GithubSkillError(
      "invalid_frontmatter",
      "SKILL.md missing `name` in frontmatter",
    );
  }

  const key = `${parsed.owner}/${parsed.repo}/${parsed.slug}`;
  const sourceLocator = `https://github.com/${parsed.owner}/${parsed.repo}/tree/${sha}/${parsed.path}`;

  return {
    key,
    slug: parsed.slug,
    name,
    description: description ?? null,
    markdown,
    sourceLocator,
    sourceRef: sha,
    sourceOwner: parsed.owner,
    sourceRepo: parsed.repo,
    sourcePath: parsed.path,
    fileInventory: inventory.sort((a, b) => a.path.localeCompare(b.path)),
    metadata: {
      importedAt: new Date().toISOString(),
    },
  };
}

// ── GitHub API helpers ──────────────────────────────────────────────

const GITHUB_API = "https://api.github.com";
const GITHUB_RAW = "https://raw.githubusercontent.com";

function githubHeaders(): Headers {
  const h = new Headers();
  h.set("Accept", "application/vnd.github+json");
  h.set("User-Agent", "occa-server");
  const token = process.env.GITHUB_TOKEN;
  if (token) h.set("Authorization", `Bearer ${token}`);
  return h;
}

async function githubFetch(url: string): Promise<Response> {
  const res = await fetch(url, { headers: githubHeaders() });
  if (res.status === 404) throw new GithubSkillError("github_not_found", url);
  if (res.status === 403 || res.status === 429) {
    throw new GithubSkillError("github_rate_limited", url);
  }
  if (!res.ok) {
    throw new GithubSkillError(
      "github_failed",
      `${res.status} ${res.statusText} ${url}`,
    );
  }
  return res;
}

async function resolveRefToSha(
  owner: string,
  repo: string,
  ref: string | undefined,
): Promise<string> {
  // If ref looks like a full SHA already, use it.
  if (ref && /^[0-9a-f]{40}$/i.test(ref)) return ref.toLowerCase();

  // Fallback: look up default branch or named ref.
  if (!ref) {
    const res = await githubFetch(`${GITHUB_API}/repos/${owner}/${repo}`);
    const json = (await res.json()) as { default_branch?: string };
    ref = json.default_branch ?? "main";
  }

  const res = await githubFetch(
    `${GITHUB_API}/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`,
  );
  const json = (await res.json()) as { sha?: string };
  if (!json.sha) {
    throw new GithubSkillError("github_failed", "no sha on commit response");
  }
  return json.sha;
}

interface TreeEntry {
  path: string;
  type: "blob" | "tree";
  sha: string;
}

async function fetchTree(
  owner: string,
  repo: string,
  sha: string,
): Promise<TreeEntry[]> {
  const res = await githubFetch(
    `${GITHUB_API}/repos/${owner}/${repo}/git/trees/${sha}?recursive=1`,
  );
  const json = (await res.json()) as {
    tree?: TreeEntry[];
    truncated?: boolean;
  };
  return json.tree ?? [];
}

async function fetchRaw(
  owner: string,
  repo: string,
  sha: string,
  path: string,
): Promise<string> {
  const res = await githubFetch(
    `${GITHUB_RAW}/${owner}/${repo}/${sha}/${path}`,
  );
  return res.text();
}

// ── Helpers ─────────────────────────────────────────────────────────

function classify(path: string): SkillFileKind {
  const lower = path.toLowerCase();
  if (lower.endsWith(".md")) {
    if (lower.endsWith("skill.md")) return "markdown";
    // other markdown files = reference material
    return lower.includes("/references/") ? "reference" : "markdown";
  }
  if (
    lower.endsWith(".sh") ||
    lower.endsWith(".py") ||
    lower.endsWith(".js") ||
    lower.endsWith(".ts") ||
    lower.endsWith(".mjs")
  ) {
    return "script";
  }
  return "asset";
}

function parseFrontmatter(
  source: string,
): { name?: string; description?: string } | null {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const body = match[1];
  const result: { name?: string; description?: string } = {};
  for (const line of body.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].trim();
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key === "name") result.name = value;
    else if (key === "description") result.description = value;
  }
  return result;
}
