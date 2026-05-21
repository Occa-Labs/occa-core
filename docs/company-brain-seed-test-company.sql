-- Company Brain seed for "Test Company"
-- Run after migration 0006 applies. Idempotent via ON CONFLICT.
-- Replace company_id lookup if your dev DB uses a different name.

WITH co AS (
  SELECT id FROM companies WHERE name = 'Test Company' LIMIT 1
)
INSERT INTO company_brain (company_id, path, content, visibility)
SELECT co.id, v.path, v.content, v.visibility
FROM co, (VALUES
  (
    '/brain/glossary.md',
    $$# Glossary

Internal terms used across our content and product.

- **OCCA** — Open Crypto Content Agency. Our parent platform / brand.
- **Pillar piece** — long-form (>1500 words) cornerstone article that other pieces link back to.
- **Brief** — 1-paragraph scope description handed off to a writer or specialist.
- **Trace** — one execution session of an agent (single chat turn or single task dispatch).
$$,
    'all'
  ),
  (
    '/brain/do-dont.md',
    $$# Editorial Do / Don't

## Always

- Cite primary sources for any technical or numeric claim.
- Define crypto-native terms on first use; assume the reader is smart but not an insider.
- Use second person ("you") when explaining workflows; first person plural ("we") for editorial stance.
- End with a concrete takeaway or next action — not a sales pitch.

## Never

- Make ROI / yield promises ("you'll earn X%", "guaranteed returns").
- Use the rocket emoji or any "to the moon" tropes.
- Use the words: utilize, leverage, unlock, revolutionary, game-changer, synergy.
- Frame crypto adoption as inevitable. Frame as conditional.
- Speculate on regulatory outcomes — describe the rule, not what we wish it said.
$$,
    'all'
  ),
  (
    '/brain/icp.md',
    $$# Ideal Customer Profile

## Primary persona

**Crypto-native operator** running a content / research / community function at a Web3 company (DeFi protocol, L2, infra tool, NFT studio, DAO, etc.).

- **Role**: Head of Content / Marketing / Community, or solo founder doing all of it.
- **Team size**: 1-15 people, often outsourced or freelance-heavy.
- **Pain points**: editorial bandwidth, consistency across writers, brand-voice drift, scaling production without losing quality, publishing weekly without burning out.
- **Job-to-be-done**: ship credible technical content fast, while keeping editorial voice intact.

## Secondary persona

**Crypto-curious traditional brand** (fintech, SaaS, dev-tools company) wanting to enter the Web3 conversation without sounding tone-deaf.

- Often paired with an internal subject-matter expert + external writing help.
- Values translation skill (bridging Web2 audience to Web3 concepts).
$$,
    'all'
  ),
  (
    '/brain/competitors.md',
    $$# Competitor landscape

## Direct (AI agent OS)

- **Lindy** — multi-agent automation, business-process focused, no crypto specialization.
- **Crew (CrewAI)** — open framework, dev-tool not end-user OS.
- **Lutra** — workflow automation, less identity / persona depth.

## Adjacent (content production)

- **Jasper / Copy.ai** — single-agent copywriting tools, no hierarchical org structure.
- **Notion AI** — knowledge worker assistant, not agent runtime.

## Differentiation

- We treat the agent system as an *operating system*, not a chatbot or workflow tool.
- Crypto-native: brand voice + terminology specialized for Web3 from day one.
- Hierarchical agents (CEO routing, specialists executing) — competitors flatten this.
$$,
    'tier:head'
  ),
  (
    '/brain/examples.md',
    $$# Output reference examples

Pointer file — links to canonical examples of "good output" for writers and other specialists.

## Blog posts (technical)

- (placeholder) Internal example: "Account abstraction without the buzzwords" — strong technical depth, accessible framing, no forbidden words.

## Briefs (CEO → specialist)

- (placeholder) See Task #4 brief — clear scope, deadline, acceptance criteria.

Update this file as we ship pieces we'd want future agents to imitate.
$$,
    'all'
  ),
  (
    '/brain/owner-preferences.md',
    $$# Owner preferences

How the owner likes to work. Use this to calibrate tone, format, and timing in chat.

- **Communication style**: direct, low-corporate, casual English.
- **Decision style**: prefers options + reasoning over single recommendations. Will push back if you skip the why.
- **Pacing**: one phase / step at a time. Don't dump giant laundry lists.
- **Code-related preference**: ask before bigger refactors; for small fixes, just do it.
- **Pet peeves**: long-winded responses, fake urgency, business-speak.
$$,
    'ceo_only'
  )
) AS v(path, content, visibility)
ON CONFLICT (company_id, path) DO UPDATE
SET content = EXCLUDED.content,
    visibility = EXCLUDED.visibility,
    updated_at = now();
