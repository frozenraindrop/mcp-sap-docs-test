# Implementation plan: judged pools (Part 1 of the design)

> Status: plan for review, 2026-09-30. Nothing implemented. Implements **Part 1** of
> [DESIGN-judged-pools-and-community-harness.md](./DESIGN-judged-pools-and-community-harness.md)
> plus the reranker on/off shakedown. The Community harness (Part 2) is a separate plan.
> Suggested branch: new one off updated `main`, e.g. `eval-judged-pools`.

## Principles
- **Core is deterministic and offline.** Only the judge step needs an LLM, and it is a
  pluggable boundary (file in, file out). Everything else is unit-testable without one.
- **Reuse, don't copy.** `bootstrapDeltaMRR`, `signTestP`, `percentile` are private in
  `run-eval.js`; extract them, don't duplicate.
- **Leave `run-eval.js` behaviour and `baseline.json` untouched** (maintainer asked for one
  stable offline gate in #70).
- **No server/runtime changes.** Test tooling only.

## Files (all under `test/eval/`)

| File | Role |
|------|------|
| `stats.js` (new) | Extracted `percentile`, bootstrap, `signTestP`, plus a generic paired-delta bootstrap (mean of per-query deltas, not MRR-specific). `run-eval.js` imports from it. |
| `pool.js` (new) | Builds pools: runs variants, unions top-k per query, hydrates content, emits tasks. |
| `judgments.js` (new) | Load/save/lookup of the judgment cache; key and staleness rules. |
| `score-judged.js` (new) | CLI: reads pools + cache, prints per-variant metrics, paired deltas, judged coverage. |
| `judge.js` (new) | Judge CLI: reads `tasks.json`, writes judgments. `--backend workflow` (default, Claude) or `--backend local` (OpenAI-compatible HTTP endpoint, e.g. Ollama). The only LLM step. |
| `judge-workflow.js` (new) | Claude Code Workflow (same style as `pairwise-eval-workflow.js`) used by the default backend. |
| `judgments.json` (new, committed, append-mostly) | The cache. |
| `rubric.md` (new) | Grade anchors + examples; its version string is the `promptVersion`. |
| `test/eval-judged.test.ts` (new) | vitest: cache keying, staleness, metrics, coverage, using a tiny fixture. |

## Steps

### Step 0. Prep
- Merge/fast-forward `main` first (done locally 2026-09-30). Create the branch from it.
- Refresh the repowise index after the merge so caller lookups are current.

### Step 1. Extract stats (pure refactor)
- Move the stats helpers from `run-eval.js` to `stats.js`; import them back.
- Add `pairedBootstrap(deltas)` (same algorithm, metric-agnostic) and `ndcg(grades, k)`,
  `precisionAt(grades, k, minGrade)`, `anyAtLeast(grades, k, minGrade)`.
- **Check:** `node test/eval/run-eval.js` output is unchanged against `baseline.json`
  (only the random bootstrap CI endpoints may differ in the last digit; fix the seed or
  compare point estimates).

### Step 2. Judgment cache (`judgments.js`, `judgments.json`)
- Record: `{ queryId, docId, contentHash, grade, rationale, judgeModel, promptVersion, judgedAt }`.
- Key: `(queryId, docId, contentHash)`. `contentHash` = sha1 of the exact text shown to
  the judge (title + source + truncated content), so a change in what the judge would see
  invalidates it.
- Lookup returns `{hit, stale}`; stale = same query+doc, different hash or older
  `promptVersion`. Stale entries are kept for audit but not used for scoring.
- Stable JSON (sorted keys/entries) so diffs are reviewable.

### Step 3. Pool builder (`pool.js`)
- Input: a list of **variants**, each = `{ name, env, searchOptions }` (e.g.
  `reranker-off: {RERANKER_ENABLED: "false"}`, `reranker-on: {RERANKER_ENABLED: "true"}`),
  a query set (default `eval-queries.js`), and `k` (pool depth, default 10).
- For each variant: start the server via the existing `startServerHttp`/`waitForStatus`/
  `stopServer` helpers with that env, run the queries with `includeOnline:false` (offline
  is deterministic; online is a separate run, see Out of scope), record the ranked ids
  (existing `parseRankedIds`).
- Save each variant's ranking to `runs/<variant>.json` (gitignored; the raw run artifact).
- Union ids per query; hydrate each unique id into judge text via the server's `fetch`
  tool, truncated to N chars (start N = 1500); record title and source. First task in this
  step: inspect what `search` already prints per result (snippet?) and only fall back to
  `fetch` if it is insufficient.
- Emit `tasks.json`: only the `(queryId, docId)` pairs with **no valid cached judgment**.
- **Check:** running pool twice with no changes emits zero tasks the second time.
- **Implemented (2026-09-30), deviations from the above:**
  - Hydration is in-process: `fetchLibraryDocumentation(id)` imported from `dist/src/lib/localDocs.js`
    (same code as the server's offline `fetch`), falling back to the snippet the search output already
    prints (title + ~500 chars + URL). Each task records `via: fetch|snippet`. It therefore needs `dist/`
    built, `dist/data` (index) AND `sources/` populated in the tree it runs from: `fetch` reads the source
    files, not the index.
  - Variants are given as `--variant name:KEY=VAL,KEY2=VAL2` (repeatable); `startServerHttp(extraEnv)`
    in `test/_utils/httpClient.js` gained an optional env argument. Other flags: `--k`, `--limit`,
    `--max-chars`, `--prompt-version` (default `v1` until the rubric file exists).
  - Each run file records git sha, an index hash (sha1 of `dist/data/docs.sqlite`) and p50/p95 latency.
  - Guard: the CLI warns loudly if two variants rank every query identically (flag not taking effect).

### Step 4. Rubric + judge step (`rubric.md`, `judge-workflow.js`)
- `rubric.md`: four anchored grades (0 unrelated/other product, 1 same area but not
  helpful, 2 partially answers or points to the right place, 3 directly answers), one short
  example each, and an instruction to judge the document on its own merit, not relative to
  other results. Judge sees query + hydrated text, never the rank or variant name.
- `judge-workflow.js`: batches tasks (~10 per agent, same pattern as the existing
  workflows), schema `{queryId, docId, grade, rationale}`, writes `judgments.json` entries
  with `judgeModel` and `promptVersion`.
- Shuffle task order per batch so position in the batch doesn't correlate with variant.
- **Backends (`judge.js --backend`):**
  - `workflow` (default): Claude via `judge-workflow.js`.
  - `local` (optional): POST to an OpenAI-compatible `/v1/chat/completions` (default
    `http://localhost:11434`, override with `--endpoint`, pick model with `--model`). Uses
    the endpoint's JSON-schema constrained output if available; otherwise validates and
    retries once. Records model name (and digest when the server exposes it) in `judgeModel`.
  - Both write the same `judgments.json` entries, so scoring never cares which judged.
- **Quota guard (all backends):** before judging, print pending-task count and an input-token
  estimate, require confirmation (or `--yes`), and honor `--max-tasks N`. The cache makes
  judging a one-time cost per (query, doc, hash).
- **Calibration:** `--calibrate N` judges N already-local-judged items again with Claude and
  reports exact / within-1 agreement. Needed before trusting a local judge for bulk work.
- **Check:** dry-run on 5 tasks per backend; output validates against the schema.
- **Implemented (2026-09-30), deviations from the above:**
  - Files: `rubric.md`, `judge-core.js` (prompt, reply parsing/validation, token estimate),
    `judge.js` (commands `estimate`, `prompts`, `ingest`, `local`), `judge-workflow.js` (Claude route).
  - `promptVersion` = `rubric-<sha1 of rubric.md, 8 chars>`: editing the rubric automatically stales every
    cached judgment; `pool.js` uses the same value and `judge.js` refuses tasks built for another rubric.
  - Claude route = `judge.js prompts` -> `judge-workflow.js` -> `judge.js ingest --judge-model <label>`.
    Workflow scripts have no file/Node access, so each agent reads its own `batch-NNN.prompt.txt` and writes
    `batch-NNN.reply.txt`; ingest does all validation. `agent()` accepts `model` and `effort`, so the judge
    model IS pinnable (script defaults: `haiku`, `low`); keep batches per run small.
  - `prompts` deletes old `batch-*` files first (a leftover reply would otherwise answer a new batch with the
    same number). `ingest` needs `--judge-model` so the cache records what really judged.
  - `local` = OpenAI-compatible `/v1/chat/completions`, `temperature 0`, JSON mode, one retry per unusable
    batch, cache saved after every batch. Tested against a mock server only; not yet run against a real Ollama.
  - NOT done yet: `--calibrate N`, and `judge-workflow.js` has been syntax-reviewed only (the sample run used
    the Agent tool with the same instructions and model). Run it once before relying on it.
  - Sample-run finding: section ids (`file#heading`) fetched the start of the whole file, so the judge saw a table
    of contents. `pool.js` now extracts the section under the matching heading (`extractSection`; source files use
    CRLF, which broke the first version). Judgments for those docs changed (2->3, 1->3) and the cache re-queued
    exactly those 3, leaving the other 17 cached.

### Step 5. Scoring (`score-judged.js`)
- Reads `runs/*.json` + cache; for each variant, per query: grades of top-k (unjudged =
  absent, not 0).
- Prints per variant: nDCG@10, P@5 (grade>=2), any>=2@5, off-topic rate (grade 0 in top 5),
  **judged coverage** (judged / top-k slots). If coverage < 95%, print a loud warning and
  suggest re-running pool+judge.
- Paired comparison of two named variants: per-query delta of nDCG@10, bootstrap CI, sign
  test on queries that flipped across the any>=2@5 threshold.
- `--json` output for machine use, same convention as `run-eval.js`.
- **Implemented (2026-09-30):** `score-judged.js` (CLI; pure `scoreRuns` / `compareVariants` exported).
  - `pool.js` now also writes `runs/pool.json` (`{promptVersion, maxChars, docs:{docId: currentContentHash}}`):
    the scorer needs every pooled doc's CURRENT hash to tell usable judgments from stale ones.
  - nDCG's ideal ranking is built from all judged docs in the query's pool (union over variants), so variants
    share one yardstick. Unjudged slots: no gain, never counted as grade 0 (off-topic@5 counts only judged zeros).
  - Paired comparison (B - A): bootstrap CI on nDCG@k and P@5 plus sign test on any>=2@5 flips. Bootstrap uses a
    seeded RNG (`--seed`, default 12345) so output is reproducible.
  - Reading it: P@5 / any@5 measure WHICH docs are in the top 5, nDCG measures ORDER; a pure reordering moves
    only nDCG. With n=4 queries the CI is an illustration, not evidence.

### Step 6. Label audit (manual, gates trust)
- Script option `--sample 50`: prints a random 50 judged items (query, text, grade,
  rationale) for the user to grade blind; records agreement (exact and within-1) in
  `judgments-audit.json`. If exact agreement is low, revise `rubric.md`, bump
  `promptVersion`, re-judge. Do not draw conclusions before this passes.

### Steps 6 and 8, and the Community-ready pool: implemented (2026-09-30)
- **Step 6, `audit.js`:** `sample` (balanced across AI grades, seeded) writes `audit/sheet.md` (rubric + query +
  document, AI grade hidden) and `audit/key.json`; `report` gives exact / within-1 / relevant(>=2) agreement,
  mean bias and a confusion matrix; partial grading works and `sample` refuses to overwrite typed grades.
  Second-opinion mode: `ai-prompts` + `report --ai-replies` has a different model regrade the same sample.
  Needs `runs/texts.json` (what the judge saw), which `pool.js` now writes. Not yet run on real data.
- **Community-ready pool:** `pool.js --from-runs [--dir d]` pools ready-made run files without a server;
  `--queries`, `--search-option KEY=VALUE` and `--dir` added. `community-produce.js --strategy current` writes
  a run file straight from the Community code (strategies registry; AND-fix / SearXNG to be added) and
  `community-queries.js` is a 12-query starter set. Verified live: 3 queries x 5 results produced and all 15
  posts hydrated via fetch. Judging them was deliberately not run (quota).
- **Step 8:** README section added to `test/eval/README.md`.
- **A2b (`--strategy and`, `community-strategies.js`):** implemented as a candidate in the harness. The design's
  "AND-compose one MATCHES clause per term" was WRONG: LiQL returns HTTP 400 (code 604) for several ANDed MATCHES.
  What works is the AND operator inside one MATCHES string, in the production `(subject ... OR body ...)` shape.
  Falls back to "drop one term" ANDs when fewer than k posts are found; same kudos filter and ranking rule as
  `current`, so differences isolate the matching. First pooled result (3 queries, haiku judge, unaudited):
  nDCG@5 0.75 vs 0.58, off-topic@5 7% vs 20%, P@5 equal; recall is thinner (one query returned only 2 posts).

### Step 7. Shakedown: reranker on/off
- Decision rule (write into the PR description **before** running): adopt the reranker only
  if the paired nDCG@10 delta CI excludes 0 **and** added latency is acceptable (code
  comment claims ~1-3s per ~150 pairs on CPU; measure real p50/p95 per query in the run).
- **Prerequisites discovered while building Step 3 (2026-09-30):**
  1. The reranker and hybrid search exist only in PR #71 code, NOT in upstream `main`. On a
     `main`-based tree `RERANKER_ENABLED` does nothing. Run the shakedown from a scratch tree that
     contains both this tooling and #71 (e.g. merge `parent-document-followup` into a throwaway branch).
  2. The index must contain the `embeddings` table. The index found in the working tree had none
     (only `docs` FTS tables), so semantic recall and rerank never engage. Rebuild with
     `build:index` then `build:embeddings` (10-20 min) on the tree under test.
  3. Verify the flag takes effect before judging anything: rankings must differ between variants and
     reranker-on p50 latency must be visibly higher (seconds, not ~70 ms). The pool CLI's
     identical-rankings warning is the tripwire.
  The tooling PR is independent of #71 and can go upstream on its own; only the experiment needs both.
- Run pool -> judge -> score; record the result and the coverage in the PR. A null result
  is a valid outcome and closes the question.

### Step 8. Docs
- Short section in `test/eval/README.md`: when to use judged mode vs `run-eval.js`, how to
  add a variant, cost note (first run judges ~N docs; later comparisons only new ones), and
  the known limits (LLM judge, coverage, n=44).

## Tests (`test/eval-judged.test.ts`, vitest, no network, no LLM)
- Cache key/staleness: changed hash -> stale; changed promptVersion -> stale; unchanged -> hit.
- Metrics on a fixed tiny grade matrix: nDCG, P@5, any>=2, off-topic rate hand-computed.
- Coverage: unjudged slots reduce coverage and are not counted as grade 0.
- Pool union/emit: second run emits zero tasks.
- Register in `package.json` test scripts following the existing `test:url-generation` style.

## Risks / open questions
- **Claude quota.** The Workflow route may not let us pin model or effort (unverified), so
  the quota guard, `--max-tasks` and the cache are the controls. Contributors without
  Claude Code can use `--backend local` or score from the committed cache.
- **Local judge on this laptop (Ryzen 5 7530U, integrated Radeon, 16 GB / ~14 usable).**
  Expect CPU-only inference; GPU offload on the iGPU is unlikely to help (unverified).
  Realistic: a ~3-4B model at 4-bit (~2-3 GB) as an overnight batch; a 7-8B model (~5 GB)
  fits in RAM but would be several times slower. These are estimates, not measurements:
  measure seconds per item on 10 tasks before committing to a full run. Keep judge output
  short (grade + one-line rationale) to bound generation time. Small models will judge
  ABAP/SAP relevance worse, hence `--calibrate` and the hand audit.
- **Hydration fidelity.** `fetch` returns full pages; truncating to N chars may cut the
  answer for long pages. Start with N=1500, check a sample in the audit, adjust.
- **Query-set size.** 44 queries gives wide CIs; the shakedown may come out inconclusive.
  That is informative, not a failure.
- **Determinism.** Offline ranking is deterministic only with identical index/embeddings;
  record `git sha` and index hash in each `runs/*.json`.
- **Commit size.** `judgments.json` grows with variants; expect a few thousand entries.
  Acceptable as a committed file; revisit if it passes ~1 MB.

## Out of scope (separate plans)
- Online legs (SAP Help, Community) in pooled eval; Community harness (Part 2).
- Confidence calibration, trace logging, routing, CAP/UI5 scoping (see Parked in the design).
- Changing `baseline.json` or the `run-eval.js` gate.

## Suggested PR slicing
1. Step 1 alone (pure refactor, reviewable in minutes).
2. Steps 2-6 + tests + README (the tooling).
3. Step 7 result as a separate small PR or an issue comment (the finding, not code).
