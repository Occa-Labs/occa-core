// The verification contract — the single source of truth for (a) which
// roles the gate applies to and (b) the exact `<!--occa:claims-->` block
// a verified-role agent must emit.
//
// Why it lives here, used by two callers:
//   • the task-prompt renderer inlines CLAIMS_CONTRACT_PROMPT so the
//     agent sees the contract in the one window it always reads;
//   • the bounce-feedback builder reminds the agent of the same block.
// Proven 2026-05-18: agents do NOT reliably open workspace files or
// skills at task time, so "see the verifiable-claims skill" is not a
// dependable channel — the contract must travel in the prompt itself.

// Roles whose deliverables must clear the verification gate before a
// task is accepted. A news writer ships factual claims; every document
// they publish is machine-checkable.
export const VERIFIED_ROLES = new Set<string>(["news_writer"]);

export function roleRequiresVerification(role: string): boolean {
  return VERIFIED_ROLES.has(role);
}

// Inlined verbatim into the task-mode prompt for verified roles. Kept
// self-sufficient on purpose: an agent must be able to produce a valid
// block from this text alone, without opening the verifiable-claims
// skill. The skill remains the deep reference for edge cases.
export const CLAIMS_CONTRACT_PROMPT = [
  `VERIFIED CLAIMS — READ THIS BEFORE YOU WRITE.`,
  ``,
  `Does this story cite on-chain numbers — TVL, DEX volume, fees, and`,
  `the like, drawn from your DefiLlama data tools?`,
  ``,
  `  - NO (a regulation, security, funding, policy, or business piece`,
  `    with no on-chain metrics): you do NOT need a claims block. Omit`,
  `    it. Do not invent on-chain claims to satisfy a gate that does`,
  `    not apply to this story. Report from primary sources and write.`,
  ``,
  `  - YES: the <!--occa:claims--> block is MANDATORY, not optional.`,
  `    The moment you call a DefiLlama tool and put even one number`,
  `    from it into your story, you MUST emit the block. Every on-chain`,
  `    number is automatically re-fetched from its source and diffed`,
  `    against what you wrote before this task can be accepted. The gate`,
  `    is plain code, not a reviewer you can persuade. A number in the`,
  `    block that does not match the live source is REJECTED and`,
  `    bounced. A story that used DefiLlama data but ships WITHOUT a`,
  `    block is also held back — the system can see you called the`,
  `    tools. The full contract is here; open no skill file.`,
  ``,
  `The rest of this section applies only when your story has on-chain`,
  `numbers.`,
  ``,
  `Workflow — do not reorder:`,
  `  1. GATHER — call your DefiLlama data tools, read the real results.`,
  `  2. RECORD — write the <!--occa:claims--> block now, copying each`,
  `     value verbatim from the tool result you just read.`,
  `  3. WRITE — write the prose from the block. Every on-chain number`,
  `     in the prose must already exist as a row in the block.`,
  ``,
  `Rules:`,
  `  - Every value is copied verbatim from a tool result. Never type a`,
  `    number from memory, never round it, never estimate it.`,
  `  - Every on-chain number in the prose has a matching claim row.`,
  `  - "as_of" is the date in the [.... UTC] header at the top of THIS`,
  `    prompt. Never derive a date from a Unix timestamp or a payload.`,
  `  - Your reply IS the published document. Start directly with the`,
  `    deliverable's first line — its title or opening sentence. No`,
  `    preamble ("Let me put together..."), no narration of what you`,
  `    are about to do, no sign-off after the claims block.`,
  ``,
  `Block format — place ONE HTML comment at the very end of your reply:`,
  ``,
  `<!--occa:claims`,
  `{`,
  `  "as_of": "YYYY-MM-DD",`,
  `  "claims": [`,
  `    {`,
  `      "source": "defillama",`,
  `      "id": "orca_7d",`,
  `      "label": "Orca DEX 7d volume",`,
  `      "endpoint": "/overview/dexs/solana",`,
  `      "selector": "protocols[name=Orca DEX].total7d",`,
  `      "value": 2011288996`,
  `    },`,
  `    {`,
  `      "source": "defillama",`,
  `      "id": "orca_change",`,
  `      "label": "Orca DEX week-over-week change",`,
  `      "endpoint": "/overview/dexs/solana",`,
  `      "selector": "protocols[name=Orca DEX].change_7dover7d",`,
  `      "value": 53.11,`,
  `      "abs_tolerance": 2`,
  `    },`,
  `    {`,
  `      "source": "defillama",`,
  `      "id": "sol_tvl_13may",`,
  `      "label": "Solana DeFi TVL on 2026-05-13",`,
  `      "endpoint": "/v2/historicalChainTvl/Solana",`,
  `      "selector": "recent[date=2026-05-13].tvl",`,
  `      "value": 6191789723`,
  `    }`,
  `  ]`,
  `}`,
  `-->`,
  ``,
  `  - "id": short identifier, [A-Za-z0-9_.] only — no spaces, no "-".`,
  `  - Add "abs_tolerance": 2 to any percentage / change claim. Omit it`,
  `    for absolute dollar amounts (the gate allows 5% drift on those).`,
  `  - For a number you computed from other claims, use a calculated`,
  `    claim instead: { "source": "calculated", "id": "...",`,
  `    "label": "...", "expression": "id_a + id_b", "value": <result> }`,
  `    — only + and - operators, referencing other claim ids.`,
  ``,
  `Endpoint + selector reference:`,
  `  defillama__dex_overview (solana)  -> endpoint "/overview/dexs/solana"`,
  `  defillama__fees_overview (solana) -> endpoint "/overview/fees/solana"`,
  `  defillama__protocol_summary       -> endpoint "/summary/dexs/<name>"`,
  `                                       or "/summary/fees/<name>"`,
  `  defillama__chain_tvl (Solana)     -> endpoint`,
  `                                       "/v2/historicalChainTvl/Solana"`,
  `  Selectors by tool:`,
  `   - dex_overview / fees_overview / protocol_summary:`,
  `     "total7d" or "change_7dover7d" (top-level field), or`,
  `     "protocols[name=Exact Name].total7d" (array lookup; the name`,
  `     is matched exactly, including capitalization).`,
  `   - chain_tvl: the verifier sees this endpoint exactly as your`,
  `     defillama__chain_tvl tool returned it —`,
  `     { "as_of", "latest": {"date","tvl"},`,
  `       "recent": [{"date","tvl"}, ...] }. Use "latest.tvl" for the`,
  `     current TVL, or "recent[date=YYYY-MM-DD].tvl" for a specific`,
  `     day. The date is the ISO date the tool gave you — never an`,
  `     epoch number. Only days in the tool's "recent" array (the`,
  `     last 8) can be cited.`,
  ``,
  `If a prior attempt was bounced, the FEEDBACK block below names the`,
  `exact mismatch — fix those numbers (and the prose around them) and`,
  `resubmit. Do not argue with the source.`,
].join("\n");
