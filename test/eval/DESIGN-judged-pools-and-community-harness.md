# Design (no code yet): judged-pool measurement + standalone Community harness

> Status: design only, 2026-09-30. Nothing here is implemented.
> Scope: (1) a measurement loop that does not need golden answers, (2) a way to test the
> Community leg on its own. Everything else is parked at the bottom.

## Why

- `run-eval.js` is offline-only (`includeOnline=false`, `k=30`) and uses `golds` substring
  hits. It cannot say anything about the online legs, and "one right link" does not match
  RAG retrieval (many docs can answer; the corpus drifts).
- The pairwise LLM judge (`pairwise-eval-workflow.js`) shows the judge **only ranked ids**
  (`1. ABENBDL_DETERMINATIONS`), not titles or content. It also always presents local as A
  (positional bias, already admitted in the README). Its verdicts are tied to one A/B pair
  and cannot be reused.
- `RERANKER_ENABLED` (cross-encoder `ms-marco-MiniLM-L-6-v2`, `embeddingSearch.ts`) exists,
  is OFF by default, and has never been measured. `rerank()` also computes a per-doc score
  and discards it.

## Part 1: pooled, cached, graded judgments

Keep `run-eval.js` and its baseline as the deterministic offline gate. Add a second mode
next to it; do not replace it.

### Mechanism (TREC-style pooling)
1. For each query, collect the top-k of **every variant under test** and take the union.
2. Judge each unique `(query, doc)` once, on its own merit, grade 0-3.
3. Cache the judgment; later comparisons only judge docs not seen before.
4. Score every variant from the cache.

### Judgment record (stored in a committed JSON/JSONL file)
`{ queryId, docId, contentHash, grade, rationale, judgeModel, promptVersion, judgedAt }`
- Key: `(queryId, docId, contentHash)`. A corpus change alters the hash and forces a
  re-judge; nothing else goes stale.
- Query set stays in `eval-queries.js` (plus a separate Community set, see Part 2).

### Rubric
Four anchored grades, e.g. 0 = unrelated / different product, 1 = same area but does not
help answer, 2 = partially answers or points to the right place, 3 = directly answers.
Anchors with one example each live in the judge prompt; `promptVersion` bumps on any change.

### Judge input
Title + URL/source + the first N characters of content (hydrated identically for every
variant). Never ids alone.

### Metrics
nDCG@10, P@5, "any grade>=2 in top-k", off-topic rate (grade 0 share of top-5).
Per-query paired deltas through the bootstrap CI and sign test that `run-eval.js` already has.
**Always print judged coverage** (share of each variant's top-k that has a judgment);
unjudged docs are reported, never silently counted as irrelevant.

### Judge hygiene
- Hand-audit ~50 labels, record agreement. If agreement is poor, fix the rubric before
  trusting any number.
- Pairwise stays as a secondary check only, run in **both orders**; count a win only if
  it agrees across orders.
- Same labels later calibrate per-result confidence (fit reranker score -> P(grade>=2)).

### Shakedown experiment (no new retrieval code)
`RERANKER_ENABLED=false` vs `true` on the existing 44 queries. Proves the loop end to end
and answers the reranker question. Decision rule written before running: adopt only if the
paired nDCG@10 delta CI excludes 0 and latency (~1-3s for ~150 pairs on CPU per the code
comment) is acceptable.

### Upstream fit
Added alongside #70's harness, offline by default, judge step runs only when explicitly
invoked (it needs an LLM). No runtime or server changes. Query set is curated, never
harvested from users.

## Part 2: standalone Community harness

Goal: given a query, see what each Community strategy returns, with no server, no index,
no embeddings.

### Interface
`strategy(query, opts) -> [{ postId, rank, rawScore?, via }]` (ids only). Hydrate **all**
strategies' ids through the existing LiQL by-id path (`getCommunityPostsByIds`) so the
judge sees identically formatted content; this isolates discovery quality from formatting.
Runner is a script importing from `dist/` (`searchCommunityBestMatch` is already callable
on its own).

### Strategies
| id | what | notes |
|----|------|-------|
| A2 | current: LiQL per-term subject searches + broad search, rescored by subject term hits > kudos > recency | baseline; `minKudos` default 1 hides zero-kudos posts |
| A2b | AND-composed `MATCHES` per significant term, stopwords removed, word-boundary scoring | targets the two confirmed bugs (stopword terms, substring `.includes`) |
| A3a | SearXNG `site:community.sap.com` discovery, then current kudos/recency weighting | isolates "better candidates" from "better ordering" |
| A3b | SearXNG raw order, no custom weighting, no kudos filter | the user's "trust the engine" variant |
| A4 | the site's own Best Match ranking | **Blocked for plain HTTP**: the source comment blames AWS WAF; a direct request to the site's HTML search page on 2026-09-30 got HTTP 403 with a "Just a moment..." bot-challenge page (the vendor may differ from the comment). The LiQL API (what A2 uses) returned 200. Dropped unless a sanctioned endpoint turns up |

Backend for A3 is an open item (see below); the harness treats it as just another strategy.

### Record and replay
Snapshot each strategy's raw response with timestamp and strategy id; re-scoring reads the
snapshot, no network. Live results drift, so conclusions must be reproducible.

### Query set
Separate from the 44 doc-shaped queries: ~30-50 in Community's real shape (error messages,
symptoms, workarounds, "how do I" across ABAP/CAP/UI5/BTP). Curated, no user data.

### Report per strategy
P@5, off-topic rate, nDCG@5, unique on-topic posts found (union recall), latency,
empty/error rate. Judged through Part 1.

### Decision gate
A3 reaches runtime only if it beats A2/A2b on off-topic rate and nDCG@5 with a CI that
excludes 0, AND the operational cost is acceptable. Then only behind an optional env var
(e.g. `SEARXNG_URL`), off by default.

### Open items to verify (not assumed)
- SearXNG needs self-hosting; public instances are unreliable and upstream engines throttle
  server IPs. Check whether it runs on this machine (Zscaler).
- Check current availability and terms of alternative backends (e.g. a web-search API)
  instead of relying on memory.
- (A4 resolved: dropped, see the table.)

## Order of work
1. Judge + pool cache + coverage reporting (Part 1), audit labels.
2. Reranker on/off shakedown.
3. Community harness: A2 and A2b first (no new infrastructure), then A3 once a backend runs.

## Parked (noted, deliberately not designed)
- Per-result calibrated confidence (reranker score, leg agreement, margin) and a
  query-level "no good answer" signal; ship only after calibration on Part 1 labels.
- Opt-in local trace logging for real queries: off by default, local only, redaction,
  retention limit; decision on sharing stays with the operator (upstream privacy).
- tableA/tableB product-version routing ([candidate-probes.md](./candidate-probes.md),
  `docs/ARC-1-system-version-resolution.md`).
- CAP/UI5 online leg scope-or-skip.
- Small-model relevance gates (LAYA is ~800MB, rejected for runtime; Jev is a closed cloud API).
- Refactoring `searchLibraries`, weight tuning: low value until Part 1 exists.
