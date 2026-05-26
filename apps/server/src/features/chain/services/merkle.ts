// Merkle tree for daily anchor commitments.
//
// One leaf = the canonical hash of one trace. Internal nodes = hash of
// (left || right). Odd-length levels duplicate the last node before
// pairing (standard "Bitcoin-style" Merkle).
//
// Hash function: SHA-256 via node:crypto. Whitepaper §5.2.1 names
// Blake3; we're using SHA-256 for Phase 1 to keep zero new deps — the
// chain stores only the ROOT and doesn't enforce the algorithm, so this
// is a protocol-level choice that we own. Anchor-program ecosystem
// already uses SHA-256 for discriminators, so this stays consistent.
// Migrating to Blake3 later is a one-function swap + a whitepaper edit.

import { createHash } from "node:crypto";

export const ANCHOR_HASH = "sha256";

/** Hash arbitrary bytes → 32-byte digest. */
export function hashBytes(input: Buffer): Buffer {
  return createHash(ANCHOR_HASH).update(input).digest();
}

/**
 * Compute the Merkle root over an ordered list of leaf hashes.
 *
 * Throws on empty input — `commit_daily_anchor` rejects task_count=0
 * (whitepaper §2 says empty days produce no anchor at all), so callers
 * must filter zero-leaf days BEFORE reaching this.
 *
 * Single-leaf trees return the leaf itself as the root.
 */
export function merkleRoot(leaves: Buffer[]): Buffer {
  if (leaves.length === 0) {
    throw new Error("merkleRoot: empty input — caller must filter empty days");
  }
  let level: Buffer[] = leaves.slice();
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = i + 1 < level.length ? level[i + 1] : left;
      next.push(hashBytes(Buffer.concat([left, right])));
    }
    level = next;
  }
  return level[0];
}
