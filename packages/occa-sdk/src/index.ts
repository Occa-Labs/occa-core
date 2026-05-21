// occa-sdk — OCCA on-chain protocol SDK.
//
// Scope (v0.2): Registry program v3 — three account types:
//   • CompanyAccount   (tenant)
//   • AgentIdentity    (stable agent identity, non-transferable)
//   • Deployment       (binds identity ↔ company)
// 10 instructions covering create / update / status / retire / set
// receiving address. All state-changing ix are signed by the user
// wallet (`owner`); the operator wallet sponsors fees only.
//
// Future: Treasury, Trace Anchor, Marketplace, Reputation programs.
//
// Spec: occa/docs/identity-architecture.md
//       occa/whitepaper.v0.9.md

export * from "./constants";
export * from "./pda";
export * from "./instructions";
