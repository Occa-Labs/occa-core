// Reputation reads — derive an agent's reputation OFF-CHAIN by folding
// over its on-chain TraceAnchorAccounts. There is no ReputationAccount in
// Phase 1 (whitepaper §9.1 makes Reputation a read-only view): the traces
// are the authoritative, immutable, public record, so anyone can recompute
// the same numbers. This service is just a convenience aggregator.
//
// Reputation aggregates per stable AgentIdentity (TraceAnchor.agent), not
// per deployment — an identity's track record follows it across
// redeployments, which is the whole point of separating the two.

import { PublicKey } from "@solana/web3.js";
import { ACCOUNT_DISCRIMINATOR, REGISTRY_PROGRAM_ID } from "@occa/sdk";
import { getConnection } from "../../../infra/solana/connection";
import { childLogger } from "../../../lib/logger";

const log = childLogger("chain:reputation-lookup");

// Byte offset of TraceAnchorAccount.agent within the account data:
//   discriminator(8) + version(1) + task_id(32) + company(32) = 73
const TRACE_AGENT_OFFSET = 73;

class Cursor {
  constructor(
    private readonly data: Buffer,
    private offset: number,
  ) {}
  readU8(): number {
    const v = this.data.readUInt8(this.offset);
    this.offset += 1;
    return v;
  }
  readU32(): number {
    const v = this.data.readUInt32LE(this.offset);
    this.offset += 4;
    return v;
  }
  readI64(): bigint {
    const v = this.data.readBigInt64LE(this.offset);
    this.offset += 8;
    return v;
  }
  readBytesHex(n: number): string {
    const slice = this.data.subarray(this.offset, this.offset + n);
    this.offset += n;
    return slice.toString("hex");
  }
  readPubkey(): string {
    const v = new PublicKey(this.data.subarray(this.offset, this.offset + 32));
    this.offset += 32;
    return v.toBase58();
  }
  readString(): string {
    const len = this.readU32();
    const s = this.data
      .subarray(this.offset, this.offset + len)
      .toString("utf8");
    this.offset += len;
    return s;
  }
}

export interface TraceAnchorRecord {
  pda: string;
  /** Hex of the 32-byte on-chain task_id (sha256 of companyId:taskId). */
  taskId: string;
  company: string;
  agent: string;
  deployment: string;
  /** Public link to the deliverable. Empty = private / no-publish. */
  resultUri: string;
  contentHash: string;
  /** 1 = Passed (the only verdict ever anchored). */
  verdict: number;
  qualityScore: number;
  rubricVersion: number;
  evidenceHash: string;
  completedAt: number;
  committedAt: number;
  committedBy: string;
}

export interface AgentReputation {
  /** AgentIdentity PDA the reputation is keyed on. */
  agent: string;
  totalAnchored: number;
  avgQualityScore: number | null;
  lastQualityScore: number | null;
  firstAnchoredAt: number | null;
  lastAnchoredAt: number | null;
  /**
   * Per-rubric-version breakdown. Scores are only comparable WITHIN a
   * rubric version, so the aggregate avg is best read alongside this.
   */
  byRubricVersion: Record<
    number,
    { count: number; avgQualityScore: number }
  >;
  traces: TraceAnchorRecord[];
}

export function decodeTrace(pda: string, data: Buffer): TraceAnchorRecord | null {
  if (
    !data.subarray(0, 8).equals(ACCOUNT_DISCRIMINATOR.TraceAnchorAccount)
  ) {
    return null;
  }
  try {
    const c = new Cursor(data, 8);
    c.readU8(); // version
    const taskId = c.readBytesHex(32);
    const company = c.readPubkey();
    const agent = c.readPubkey();
    const deployment = c.readPubkey();
    const resultUri = c.readString();
    const contentHash = c.readBytesHex(32);
    const verdict = c.readU8();
    const qualityScore = c.readU8();
    const rubricVersion = c.readU8();
    const evidenceHash = c.readBytesHex(32);
    const completedAt = Number(c.readI64());
    const committedAt = Number(c.readI64());
    const committedBy = c.readPubkey();
    // trailing bump u8 — not needed
    return {
      pda,
      taskId,
      company,
      agent,
      deployment,
      resultUri,
      contentHash,
      verdict,
      qualityScore,
      rubricVersion,
      evidenceHash,
      completedAt,
      committedAt,
      committedBy,
    };
  } catch (err) {
    log.warn({ err, pda }, "TraceAnchorAccount decode failed");
    return null;
  }
}

/**
 * Fetch all TraceAnchorAccounts produced by one AgentIdentity. Uses a
 * memcmp on the `agent` field; getProgramAccounts is already scoped to the
 * registry program, and the discriminator is re-checked per account.
 */
export async function fetchTracesForAgent(
  agentIdentityPda: PublicKey,
): Promise<TraceAnchorRecord[]> {
  const conn = getConnection();
  const accounts = await conn.getProgramAccounts(REGISTRY_PROGRAM_ID, {
    commitment: "confirmed",
    filters: [
      { memcmp: { offset: TRACE_AGENT_OFFSET, bytes: agentIdentityPda.toBase58() } },
    ],
  });
  const out: TraceAnchorRecord[] = [];
  for (const { pubkey, account } of accounts) {
    const rec = decodeTrace(pubkey.toBase58(), account.data as Buffer);
    if (rec) out.push(rec);
  }
  return out;
}

/** Fold a set of traces into reputation aggregates. Pure. */
export function computeReputation(
  agentIdentityPda: string,
  traces: TraceAnchorRecord[],
): AgentReputation {
  const sorted = [...traces].sort((a, b) => a.completedAt - b.completedAt);
  const total = sorted.length;

  if (total === 0) {
    return {
      agent: agentIdentityPda,
      totalAnchored: 0,
      avgQualityScore: null,
      lastQualityScore: null,
      firstAnchoredAt: null,
      lastAnchoredAt: null,
      byRubricVersion: {},
      traces: [],
    };
  }

  const scoreSum = sorted.reduce((acc, t) => acc + t.qualityScore, 0);

  const byRubricVersion: Record<
    number,
    { count: number; avgQualityScore: number }
  > = {};
  const sumByVersion: Record<number, number> = {};
  for (const t of sorted) {
    const v = t.rubricVersion;
    byRubricVersion[v] = byRubricVersion[v] ?? { count: 0, avgQualityScore: 0 };
    byRubricVersion[v].count += 1;
    sumByVersion[v] = (sumByVersion[v] ?? 0) + t.qualityScore;
  }
  for (const v of Object.keys(byRubricVersion)) {
    const key = Number(v);
    byRubricVersion[key].avgQualityScore =
      Math.round((sumByVersion[key] / byRubricVersion[key].count) * 100) / 100;
  }

  return {
    agent: agentIdentityPda,
    totalAnchored: total,
    avgQualityScore: Math.round((scoreSum / total) * 100) / 100,
    lastQualityScore: sorted[total - 1].qualityScore,
    firstAnchoredAt: sorted[0].completedAt,
    lastAnchoredAt: sorted[total - 1].completedAt,
    byRubricVersion,
    traces: sorted,
  };
}

/** Convenience: fetch + compute in one call. */
export async function getAgentReputation(
  agentIdentityPda: PublicKey,
): Promise<AgentReputation> {
  const traces = await fetchTracesForAgent(agentIdentityPda);
  return computeReputation(agentIdentityPda.toBase58(), traces);
}
