# Retrieval eval harness

A fixed query set and MRR scorer for measuring search quality. Run it before and
after any ranking-sensitive change so the effect is measured, not guessed.

## Quick start

```bash
npm run build:tsc
node test/eval/run-eval.js           # compare vs baseline.json
node test/eval/run-eval.js --update  # run + overwrite baseline.json
node test/eval/run-eval.js --json    # machine-readable report on stdout
```

The runner starts `dist/src/http-server.js` itself, so it scores the currently
built `dist/`. Rebuild first if you changed index/embeddings config.

`baseline.json` is the deterministic offline snapshot for the recorded variant
and search options (`includeOnline=false`, `k=30`). The runner warns when those
settings do not match. Use `--update` only when intentionally accepting a new
baseline after rebuilding the same corpus configuration.

## What it measures

Each query carries a `golds` array — **any matching fragment counts as a hit**
(multi-gold). This avoids penalising systems that return a different but equally
valid answer. Relevance in search is a judgment call, not ground truth; the
harness measures directional improvement, not absolute recall.

| Metric | Meaning |
|--------|---------|
| `firstRelevantRank` | 1-indexed position of the first result matching any `golds` fragment; `MISS` if no gold appears in the returned list |
| `MRR` | mean reciprocal rank across all queries |
| `hit@k` | fraction of queries whose first gold lands in the top *k* (k = 1, 3, 5, 10) |
| `misses` | queries with no gold in the returned results |

The report also prints a **bootstrap 95% CI on ΔMRR** and a **sign test on
hit@3 flips**. At n = 44, most single-change deltas land within noise by design —
the harness is built to resist over-claiming. Treat MRR as directional and use
per-query MISS→hit flips and the pairwise judgment for decisions.

## Query set structure

[`eval-queries.js`](./eval-queries.js) contains 44 queries spanning ABAP, CDS,
RAP, UI5/Fiori Elements, CAP, BTP, and wdi5. Three cohorts stress different
recall levers:

- **Lexical-gap** — phrased in user language with no keyword overlap against the
  corpus. A system relying on keyword matching alone will miss these.
- **Coverage-test** — gold is a `markdown-section` chunk. These miss on any
  system that only embeds whole documents; they act as canaries for section-level
  indexing coverage.
- **Paraphrase** — gold is an embedded `markdown` doc queried in natural language.
  Measures semantic recall without keyword co-occurrence.

`golds` fragments are matched case-insensitively as substrings against the
library id/path on each `⭐️ **<id>**` result line.

## Curation guidelines

- **Add** queries from real sessions where grounding mattered.
- **Don't silently delete** a query because it scores badly — that inflates the
  average. A low score is the signal; annotate with a `note` instead.
- `pairwise-vanilla.json` is append-only — never re-run `collect-vanilla-workflow.js`
  for queries already collected (it is expensive). Add new queries only.

## Pairwise eval

`pairwise-eval-workflow.js` is a Claude Code workflow that runs an LLM-as-judge
comparison between two systems head-to-head. It requires a connected MCP session.
`pairwise-vanilla.json` contains pre-collected vanilla upstream results for all
44 queries and is the reference side of the comparison.

Both workflow scripts accept an `args` object to configure which MCP server to
call, so they work regardless of how your server is registered:

```js
// collect vanilla results from an upstream server
Workflow({ scriptPath: 'test/eval/collect-vanilla-workflow.js',
           args: { vanillaTool: 'my-upstream-server search' } })

// run pairwise eval against a local server
Workflow({ scriptPath: 'test/eval/pairwise-eval-workflow.js',
           args: { localTool: 'my-local-server search' } })
```

The value is passed directly to `ToolSearch` — use a keyword fragment (e.g.
`'my-server search'`) or an exact name (e.g. `'select:mcp__my-server__search'`).
Defaults match the naming convention used in this repo.

**Limitation:** presentation order is not swapped (local system always shown
first), which can introduce positional bias in the LLM judge. Read win margins
as directional, not definitive.
The pairwise judge also sees only the ranked document ids, not titles or text. For new
work prefer the judged-pool eval below, which shows the judge the actual content.

## Judged-pool eval (graded judgments, no gold answers)

`run-eval.js` needs a known "right" doc per query. Real retrieval has many acceptable answers and
the corpus changes, so this second mode grades what a system actually returns instead. Use
`run-eval.js` as the deterministic regression gate; use this to ask "is variant B better than A?"
when there is no single right link (ranking changes, the reranker, online legs, the Community leg).

```
collect rankings ──► pool + fetch text ──► AI judge grades 0-3 ──► cache ──► score & compare
 (pool.js or           (pool.js)            (judge.js)           (judgments.json)  (score-judged.js)
  community-produce.js)
```

Each unique (query, document) is graded once, on its own merit, against [`rubric.md`](./rubric.md).
Grades are cached by `(queryId, docId, contentHash, promptVersion)`: if a page's text or the rubric
changes, the old grade is treated as stale and only those items are re-judged, so later comparisons
cost almost nothing. Design: [`DESIGN-judged-pools-and-community-harness.md`](./DESIGN-judged-pools-and-community-harness.md).

### Quick start: compare two variants of the doc search

```bash
npm run build:tsc
node test/eval/pool.js --variant base: --variant other:SOME_FLAG=true --k 10   # runs/ + tasks.json
node test/eval/judge.js estimate                   # how many items, rough token cost
node test/eval/judge.js prompts --batch 10         # writes judge-batches/
# Claude route: in Claude Code, run the workflow (model/effort are pinned, default haiku/low):
#   Workflow({ scriptPath: 'test/eval/judge-workflow.js', args: { dir: 'test/eval/judge-batches', batches: <N> } })
# Local route instead (any OpenAI-compatible endpoint, e.g. Ollama): no Claude quota used
#   node test/eval/judge.js local --model <name> [--endpoint http://localhost:11434]
node test/eval/judge.js ingest --judge-model <model-used>
node test/eval/score-judged.js                     # per-variant table + paired comparison
```

`pool.js` needs `dist/` built, an index in `dist/data` and the `sources/` folders present (fetching
text reads the source files). Variants are `name:KEY=VALUE,...` environment settings for the server;
`--search-option KEY=VALUE` passes search options (for example `includeOnline=true`, which makes
results drift between runs, so run both variants back to back), `--queries file.js` swaps the query
set, `--dir` keeps an experiment's files separate. `score-judged.js` reads every run file in its
folder, so use `--dir`/`--runs` (or delete `runs/`) between unrelated experiments.

### Testing the SAP Community leg on its own

No server, index or embeddings needed. A strategy writes a run file, then the same chain applies:

```bash
npm run build:tsc
node test/eval/community-produce.js --strategy current --k 10     # needs network; uses community-queries.js
node test/eval/pool.js --from-runs --dir test/eval/runs-community
node test/eval/judge.js prompts && ... && node test/eval/judge.js ingest --judge-model <model>
node test/eval/score-judged.js --runs test/eval/runs-community
```

Strategies so far: `current` (today's behaviour), `and` (every significant term required, see
`community-strategies.js`) and `searxng` (`--searxng-url`; engine order, see `community-searxng.js`; public
instances proved unusable, it needs a self-hosted instance with working engines). Add more (SearXNG, ...) to `STRATEGIES` in `community-produce.js`, run each with
its own `--name`, and `score-judged.js --compare A B` compares them. `community-queries.js` is only a 12-query
starter set: extend it before trusting any difference. (The site's own "Best Match" page is not an
option: plain HTTP requests to its HTML search page get a 403 bot-challenge page.)

### Reading the output

| Column | Meaning |
|--------|---------|
| `nDCG@k` | Quality of the **order**, against the best order possible from everything judged for that query |
| `P@5 (>=2)`, `any>=2@5` | Share of the top 5 that is relevant / whether at least one relevant doc is in the top 5 (set membership, not order) |
| `off-topic@5` | Share of the top 5 graded 0 (only judged items count) |
| `coverage` | Share of the top-k that has a current judgment. **Below 95% the script warns; run the pending tasks first.** Unjudged items are never counted as irrelevant. |

The paired comparison gives a bootstrap 95% CI on the nDCG and P@5 deltas and a sign test on queries
that gained or lost a relevant top-5 doc. As with `run-eval.js`, "within noise" is a normal answer at
this query-set size.

### Can the judge be trusted? Audit it

The AI judge is only useful if it agrees with a person. `audit.js` samples judged items (balanced
across grades), writes a sheet with the AI's grades hidden, and reports agreement:

```bash
node test/eval/audit.js sample --n 50          # audit/sheet.md to grade, audit/key.json = answers
# type a digit 0-3 after each "YOUR GRADE (0-3):"; blank = skip; partial grading is fine
node test/eval/audit.js report                 # exact / within-1 / relevant agreement, bias, confusion matrix
# no time? have a DIFFERENT, stronger model regrade the same sample:
node test/eval/audit.js ai-prompts && ...      # write audit/ai-batches/batch-NNN.reply.txt
node test/eval/audit.js report --ai-replies test/eval/audit/ai-batches
```

Two AIs agreeing is weaker evidence than a person agreeing; quote which one you used. `sample` refuses
to overwrite a sheet that already contains your grades (`--force` to discard them).

### Files and cost notes

| File | Role |
|------|------|
| `pool.js`, `community-produce.js` | Collect rankings; union, fetch text, list only ungraded pairs in `tasks.json` |
| `judge.js`, `judge-core.js`, `judge-workflow.js`, `rubric.md` | Prompts, reply validation, Claude workflow / local backend, marking guide |
| `judgments.json` (committed) | The grade cache. Edit `rubric.md` and every entry becomes stale automatically |
| `score-judged.js`, `stats.js` | Metrics, paired bootstrap, sign test |
| `runs*/`, `tasks.json`, `judge-batches/`, `audit/` | Generated; git-ignored |

- Judging uses the cheapest pinned model by default, and the cache means each item is graded once.
  `judge.js estimate` / `--max-tasks` show and cap the work before anything is sent.
- Queries and page text go to whichever model judges them. Use curated queries (like the starter
  sets here), never raw user queries.
- Known limits: LLM judging is imperfect (audit it); nDCG depends on what has been judged for a query,
  so only compare variants pooled together; and a 12 to 44 query set gives wide intervals.
