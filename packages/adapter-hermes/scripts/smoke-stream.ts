// One-shot smoke test: exercises streamChatCompletion end-to-end against
// the real Hermes gateway. Run with `pnpm --filter @occa/adapter-hermes
// exec tsx scripts/smoke-stream.ts`. Prints latency, full reply, usage.
// Delete or move under test/ once a proper test runner lands.

import { streamChatCompletion } from "../src/chat-completions";

const GATEWAY = process.env.HERMES_GATEWAY ?? "https://hermes.occa.team";
const KEY =
  process.env.HERMES_KEY ??
  "f2a78a5a9398bb79cdeaf408b70b08cfd1183f65d97be6d90a5501f946d22dcf";

async function main(): Promise<void> {
  const sessionId = `occa-smoke-continuity-${Date.now()}`;
  const controller = new AbortController();

  // Turn 1: plant a fact.
  const t1Start = Date.now();
  const t1 = await streamChatCompletion({
    gatewayUrl: GATEWAY,
    apiKey: KEY,
    messages: [
      { role: "user", content: "Remember: my favorite number is 137. Reply OK." },
    ],
    sessionId,
    signal: controller.signal,
  });
  const t1Ms = Date.now() - t1Start;

  // Turn 2 (same sessionId): ask to recall.
  const t2Start = Date.now();
  const t2 = await streamChatCompletion({
    gatewayUrl: GATEWAY,
    apiKey: KEY,
    messages: [
      { role: "user", content: "What number did I tell you to remember?" },
    ],
    sessionId,
    signal: controller.signal,
  });
  const t2Ms = Date.now() - t2Start;

  console.log(
    JSON.stringify(
      {
        sessionId,
        t1: { ms: t1Ms, ok: t1.ok, reply: t1.ok ? t1.reply : t1.reason, usage: t1.ok ? t1.usage : null },
        t2: { ms: t2Ms, ok: t2.ok, reply: t2.ok ? t2.reply : t2.reason, usage: t2.ok ? t2.usage : null },
        recalled: t2.ok && t2.reply.includes("137"),
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error("smoke-stream failed:", err);
  process.exit(1);
});
