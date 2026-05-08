#!/usr/bin/env tsx
// HTTP smoke test for /api/workflows (Phase 5 storage + CRUD).
//
// Mints a JWT directly with JWT_SECRET, hits each endpoint against a
// running server, and asserts response shape + status. Bypasses the
// wallet-sign step but exercises the real route → service → repo → DB
// path end-to-end.
//
// Usage (from apps/server/):
//
//   pnpm dev:server        # start the server in another terminal
//   pnpm smoke:workflows   # run this script
//
// The script reads SMOKE_USER_ID + SMOKE_USER_WALLET from env, falling
// back to the first user-kind company's owner if those are not set. The
// workflows it creates are deleted at the end so the suite is safe to
// re-run.

import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { eq, and, isNull } from "drizzle-orm";
import { companies, users } from "@occa/shared/schema";
import { db } from "../src/infra/database/client";

const require = createRequire(import.meta.url);
const jwt = require("jsonwebtoken") as typeof import("jsonwebtoken");

const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3002";
// __dirname works under tsx's CJS transform; in pure ESM use
// fileURLToPath(import.meta.url) instead.
const SEED_DIR = path.resolve(
  __dirname,
  "../src/features/workflows/seeds",
);

if (!process.env.JWT_SECRET) {
  console.error(
    "JWT_SECRET not set — run via `pnpm smoke:workflows` or pass --env-file",
  );
  process.exit(2);
}

let pass = 0;
let fail = 0;
let headers: Record<string, string> = {};

function check(label: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    console.log(`  PASS  ${label}`);
    pass++;
  } else {
    console.log(`  FAIL  ${label}`);
    if (detail !== undefined) console.log("        ", detail);
    fail++;
  }
}

interface HttpResult {
  status: number;
  body: Record<string, unknown> | null;
}

async function http(
  method: string,
  routePath: string,
  body?: unknown,
): Promise<HttpResult> {
  const res = await fetch(BASE + routePath, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : null;
  } catch {
    /* not json */
  }
  return { status: res.status, body: json };
}

interface WorkflowEnvelope {
  workflow?: { id: string; yamlId: string; name: string; enabled: boolean };
  workflows?: { id: string; yamlId: string }[];
  error?: string;
  detail?: { kind?: string };
}

async function resolveTestUser(): Promise<{ userId: string; wallet: string }> {
  if (process.env.SMOKE_USER_ID && process.env.SMOKE_USER_WALLET) {
    return {
      userId: process.env.SMOKE_USER_ID,
      wallet: process.env.SMOKE_USER_WALLET,
    };
  }
  const [row] = await db
    .select({ userId: users.id, wallet: users.walletAddress })
    .from(companies)
    .innerJoin(users, eq(users.id, companies.ownerUserId))
    .where(and(eq(companies.kind, "user"), isNull(companies.deletedAt)))
    .limit(1);
  if (!row) {
    throw new Error(
      "no user-kind company found in DB; seed one or set SMOKE_USER_ID + SMOKE_USER_WALLET",
    );
  }
  return { userId: row.userId, wallet: row.wallet };
}

async function main(): Promise<void> {
  const { userId, wallet } = await resolveTestUser();
  console.log(`smoke user: ${userId} (${wallet.slice(0, 8)}…)`);

  const token = jwt.sign(
    { userId, walletAddress: wallet },
    process.env.JWT_SECRET!,
    { expiresIn: "1h" },
  );

  headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  const blogYaml = await readFile(
    `${SEED_DIR}/blog-post-pipeline.yaml`,
    "utf8",
  );
  const researchYaml = await readFile(
    `${SEED_DIR}/research-pipeline.yaml`,
    "utf8",
  );

  let createdBlogId: string | null = null;
  let createdResearchId: string | null = null;

  try {
    console.log("\n--- 1. GET /api/workflows (initial list) ---");
    const r1 = await http("GET", "/api/workflows");
    check("status 200", r1.status === 200, r1);
    const initialList = (r1.body as WorkflowEnvelope).workflows ?? [];
    check("response has workflows array", Array.isArray(initialList));
    console.log(`  initial workflow count: ${initialList.length}`);
    for (const w of initialList) {
      if (
        w.yamlId === "blog-post-pipeline" ||
        w.yamlId === "blog-post-pipeline-v2" ||
        w.yamlId === "research-pipeline"
      ) {
        await http("DELETE", `/api/workflows/${w.id}`);
      }
    }
    const r1b = await http("GET", "/api/workflows");
    const baseCount = ((r1b.body as WorkflowEnvelope).workflows ?? []).length;

    console.log("\n--- 2. POST blog-post-pipeline (create) ---");
    const r2 = await http("POST", "/api/workflows", { yamlText: blogYaml });
    const r2b = r2.body as WorkflowEnvelope;
    check("status 201", r2.status === 201, r2);
    check(
      "yamlId === blog-post-pipeline",
      r2b.workflow?.yamlId === "blog-post-pipeline",
    );
    check("name matches", r2b.workflow?.name === "Blog Post Production");
    check("enabled defaults to true", r2b.workflow?.enabled === true);
    createdBlogId = r2b.workflow?.id ?? null;

    console.log("\n--- 3. POST research-pipeline (create) ---");
    const r3 = await http("POST", "/api/workflows", { yamlText: researchYaml });
    const r3b = r3.body as WorkflowEnvelope;
    check("status 201", r3.status === 201, r3);
    check(
      "yamlId === research-pipeline",
      r3b.workflow?.yamlId === "research-pipeline",
    );
    createdResearchId = r3b.workflow?.id ?? null;

    console.log("\n--- 4. POST duplicate blog-post-pipeline (conflict) ---");
    const r4 = await http("POST", "/api/workflows", { yamlText: blogYaml });
    const r4b = r4.body as WorkflowEnvelope;
    check("status 409", r4.status === 409, r4);
    check(
      "error code workflow_id_conflict",
      r4b.error === "workflow_id_conflict",
    );

    console.log("\n--- 5. POST invalid YAML schema (422) ---");
    const r5 = await http("POST", "/api/workflows", {
      yamlText: "id: bad\nname: Bad\ntrigger:\n  when: not.a.real.event",
    });
    const r5b = r5.body as WorkflowEnvelope;
    check("status 422", r5.status === 422, r5);
    check(
      "error code workflow_yaml_invalid",
      r5b.error === "workflow_yaml_invalid",
    );
    check(
      "detail kind === schema",
      r5b.detail?.kind === "schema",
      r5b.detail,
    );

    console.log("\n--- 6. POST malformed YAML syntax (422) ---");
    const r6 = await http("POST", "/api/workflows", {
      yamlText: "id: oops\n  bad:\n   indent: [unclosed",
    });
    const r6b = r6.body as WorkflowEnvelope;
    check("status 422", r6.status === 422, r6);
    check(
      "detail kind yaml_syntax",
      r6b.detail?.kind === "yaml_syntax",
      r6b.detail,
    );

    console.log("\n--- 7. GET /api/workflows (list with 2 entries) ---");
    const r7 = await http("GET", "/api/workflows");
    const r7b = r7.body as WorkflowEnvelope;
    check("status 200", r7.status === 200);
    check(
      `count = baseCount + 2 (got ${r7b.workflows?.length})`,
      r7b.workflows?.length === baseCount + 2,
    );

    console.log("\n--- 8. GET /api/workflows/:id ---");
    const r8 = await http("GET", `/api/workflows/${createdBlogId}`);
    const r8b = r8.body as WorkflowEnvelope;
    check("status 200", r8.status === 200);
    check("yamlId matches", r8b.workflow?.yamlId === "blog-post-pipeline");

    console.log("\n--- 9. PATCH disable ---");
    const r9 = await http("PATCH", `/api/workflows/${createdBlogId}`, {
      enabled: false,
    });
    const r9b = r9.body as WorkflowEnvelope;
    check("status 200", r9.status === 200);
    check("enabled === false", r9b.workflow?.enabled === false);

    console.log("\n--- 10. PATCH yamlText (rename to blog-post-pipeline-v2) ---");
    const renamedYaml = blogYaml.replace(
      "id: blog-post-pipeline",
      "id: blog-post-pipeline-v2",
    );
    const r10 = await http("PATCH", `/api/workflows/${createdBlogId}`, {
      yamlText: renamedYaml,
    });
    const r10b = r10.body as WorkflowEnvelope;
    check("status 200", r10.status === 200);
    check(
      "yamlId === blog-post-pipeline-v2",
      r10b.workflow?.yamlId === "blog-post-pipeline-v2",
    );
    check(
      "enabled stays false (atomic with rename)",
      r10b.workflow?.enabled === false,
    );

    console.log("\n--- 11. DELETE blog row ---");
    const r11 = await http("DELETE", `/api/workflows/${createdBlogId}`);
    check("status 204", r11.status === 204, r11);
    const deletedBlogId = createdBlogId;
    createdBlogId = null;

    console.log("\n--- 12. GET deleted row → 404 ---");
    const r12 = await http("GET", `/api/workflows/${deletedBlogId}`);
    const r12b = r12.body as WorkflowEnvelope;
    check("status 404", r12.status === 404);
    check(
      "error code workflow_not_found",
      r12b.error === "workflow_not_found",
    );

    console.log("\n--- 13. DELETE research row (cleanup) ---");
    const r13 = await http("DELETE", `/api/workflows/${createdResearchId}`);
    check("status 204", r13.status === 204);
    createdResearchId = null;

    console.log("\n--- 14. GET no-token → 401 ---");
    const noAuth = await fetch(`${BASE}/api/workflows`);
    check("status 401", noAuth.status === 401);
  } finally {
    for (const id of [createdBlogId, createdResearchId]) {
      if (id) await http("DELETE", `/api/workflows/${id}`).catch(() => {});
    }
    await db.$client.end();
  }
}

main()
  .then(() => {
    console.log(`\n=== ${pass} passed, ${fail} failed ===`);
    process.exit(fail === 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error("smoke test crashed:", err);
    process.exit(1);
  });
