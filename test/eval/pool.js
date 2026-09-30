// Pool builder for the judged-pool eval (see DESIGN-judged-pools-and-community-harness.md).
//
//   node test/eval/pool.js --variant reranker-off:RERANKER_ENABLED=false \
//                          --variant reranker-on:RERANKER_ENABLED=true [--k 10] [--limit 5]
//                          [--queries my-queries.js] [--search-option includeOnline=true] [--dir test/eval/runs-x]
//   node test/eval/pool.js --from-runs [--dir test/eval/runs-community]   # pool ready-made run files, no server
//
// For every variant it starts the built server (dist/) with that env, runs the eval
// queries (offline only, so results are deterministic), and saves the ranking to
// runs/<variant>.json. It then unions the top-k of all variants per query, hydrates
// each unique doc into the text the judge will see, and writes tasks.json holding
// ONLY the (query, doc) pairs with no usable cached judgment. Run it twice with no
// changes and the second tasks.json is empty.
//
// Pure helpers are exported for tests; the server/CLI part only runs when invoked directly.

import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hashContent, loadJudgments, lookup } from "./judgments.js";
import { loadRubric, promptVersionOf } from "./judge-core.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNS_DIR = join(__dirname, "runs");
const TASKS_PATH = join(__dirname, "tasks.json");
const JUDGMENTS_PATH = join(__dirname, "judgments.json");
const DEFAULT_K = 10;
const DEFAULT_MAX_CHARS = 1500;

// ── Pure helpers ─────────────────────────────────────────────────────────────

// Parse the server's formatted search summary into [{id, title, snippet, url}].
// Each result is: "⭐️ **<id>** (Score: n)", a title line, snippet text, "🔗 <url>".
export function parseResults(text) {
  const blocks = String(text || "").split(/^⭐️ \*\*/m).slice(1);
  return blocks.map((block) => {
    const id = block.slice(0, block.indexOf("**"));
    const lines = block.split("\n").slice(1);
    const urlIdx = lines.findIndex((l) => l.trim().startsWith("🔗"));
    const body = (urlIdx === -1 ? lines : lines.slice(0, urlIdx)).map((l) => l.trim()).filter(Boolean);
    const url = urlIdx === -1 ? "" : lines[urlIdx].replace(/^\s*🔗\s*/, "").trim();
    return { id, title: body[0] ?? id, snippet: body.slice(1).join(" "), url };
  });
}

// The exact text shown to the judge. Its hash is the cache key, so anything that
// changes what the judge sees (title, source, content, maxChars) re-judges.
export function renderJudgeText({ id, title, url, content, maxChars = DEFAULT_MAX_CHARS }) {
  const body = String(content ?? "").trim().slice(0, maxChars);
  return `Title: ${title}\nSource: ${id}${url ? `\nURL: ${url}` : ""}\n\n${body}`;
}

// GitHub-style heading slug: lowercase, drop punctuation, spaces to hyphens.
const slug = (h) => h.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s/g, "-");

// Return the markdown section under the heading whose slug is `fragment`, up to the next
// heading of the same or higher level (headings inside code fences are ignored).
// null if no such heading, so the caller can fall back to the search snippet.
export function extractSection(markdown, fragment) {
  const lines = String(markdown ?? "").replace(/\r\n?/g, "\n").split("\n"); // sources use CRLF; `.` won't match a trailing \r
  let inFence = false, start = -1, level = 0;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = /^(#{1,6})\s+(.*)$/.exec(lines[i]);
    if (!m) continue;
    if (start === -1) {
      if (slug(m[2]) === fragment) { start = i; level = m[1].length; }
    } else if (m[1].length <= level) {
      return lines.slice(start, i).join("\n").trim();
    }
  }
  return start === -1 ? null : lines.slice(start).join("\n").trim();
}

// runs: [{ variant, queries: [{ queryId, results: [{id, title, snippet, url}] }] }]
// Returns Map<queryId, Map<docId, {id,title,snippet,url}>>: union of each variant's top-k.
export function unionPool(runs, k = DEFAULT_K) {
  const pool = new Map();
  for (const run of runs) {
    for (const q of run.queries) {
      if (!pool.has(q.queryId)) pool.set(q.queryId, new Map());
      const docs = pool.get(q.queryId);
      for (const r of q.results.slice(0, k)) if (!docs.has(r.id)) docs.set(r.id, r);
    }
  }
  return pool;
}

// True when two runs rank the top-k identically for every shared query. Two variants
// that are supposed to differ but do are almost always a flag that never took effect
// (wrong tree, missing index data, env not reaching the server).
export function identicalRankings(runA, runB, k = DEFAULT_K) {
  const byId = new Map(runB.queries.map((q) => [q.queryId, q]));
  let compared = 0;
  for (const qa of runA.queries) {
    const qb = byId.get(qa.queryId);
    if (!qb) continue;
    compared++;
    const ia = qa.results.slice(0, k).map((r) => r.id).join("|");
    const ib = qb.results.slice(0, k).map((r) => r.id).join("|");
    if (ia !== ib) return false;
  }
  return compared > 0;
}

// hydrated: Map<docId, { text, via }>  (text = renderJudgeText output)
// Returns one task per pooled (query, doc) without a usable cached judgment.
export function buildTasks({ pool, queries, hydrated, entries, promptVersion }) {
  const queryText = new Map(queries.map((q) => [q.id, q.query]));
  const tasks = [];
  for (const [queryId, docs] of pool) {
    for (const docId of docs.keys()) {
      const h = hydrated.get(docId);
      if (!h) continue; // could not be hydrated at all; reported by the CLI, not judged blind
      const contentHash = hashContent(h.text);
      if (lookup(entries, { queryId, docId, contentHash, promptVersion }).status === "hit") continue;
      tasks.push({ queryId, query: queryText.get(queryId) ?? "", docId, contentHash, via: h.via, text: h.text });
    }
  }
  return tasks.sort((a, b) => (a.queryId + a.docId < b.queryId + b.docId ? -1 : 1));
}

// "name:KEY=VAL,KEY2=VAL2" -> { name, env }
export function parseVariant(spec) {
  const [name, rest = ""] = spec.split(/:(.*)/s);
  const env = {};
  for (const pair of rest.split(",").filter(Boolean)) {
    const eq = pair.indexOf("=");
    if (eq < 1) throw new Error(`bad variant env "${pair}" in "${spec}" (expected KEY=VAL)`);
    env[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  if (!name) throw new Error(`variant needs a name: "${spec}"`);
  return { name, env };
}

// "KEY=VALUE" -> [KEY, parsed]; VALUE is parsed as JSON when possible (true, 5, ["a"]), else kept as text.
export function parseSearchOption(spec) {
  const eq = spec.indexOf("=");
  if (eq < 1) throw new Error(`bad --search-option "${spec}" (expected KEY=VALUE)`);
  const raw = spec.slice(eq + 1);
  let value = raw;
  try { value = JSON.parse(raw); } catch { /* plain text */ }
  return [spec.slice(0, eq), value];
}

// Unique [{id, query}] across runs, so tasks carry the query text whatever produced the runs.
export function queriesFromRuns(runs) {
  const seen = new Map();
  for (const run of runs) for (const q of run.queries) if (!seen.has(q.queryId)) seen.set(q.queryId, { id: q.queryId, query: q.query ?? "" });
  return [...seen.values()];
}

// Every run file in `dir` (shape: has a `queries` array); pool.json / texts.json are skipped by shape.
export function loadRunFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")))
    .filter((r) => Array.isArray(r?.queries));
}

// ── CLI (server + filesystem) ────────────────────────────────────────────────

function sha1OfFile(path) {
  return new Promise((res, rej) => {
    const h = createHash("sha1");
    createReadStream(path).on("data", (d) => h.update(d)).on("end", () => res(h.digest("hex"))).on("error", rej);
  });
}

function argValues(args, flag) {
  return args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));
}

async function collectViaServer({ variants, queries, k, searchOptions, runsDir }) {
  const { startServerHttp, waitForStatus, stopServer, search } = await import("../_utils/httpClient.js");
  const sqlite = join(process.cwd(), "dist", "data", "docs.sqlite");
  const indexHash = existsSync(sqlite) ? await sha1OfFile(sqlite) : "unknown";
  let gitCommit = "unknown";
  try { gitCommit = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim(); } catch { /* not a git checkout */ }

  const runs = [];
  for (const v of variants) {
    console.log(`▶ variant "${v.name}" env=${JSON.stringify(v.env)}`);
    const server = startServerHttp(v.env);
    const out = [];
    const latencies = [];
    try {
      await waitForStatus();
      for (const q of queries) {
        const t0 = Date.now();
        const text = await search(q.query, { includeOnline: false, ...searchOptions, k });
        latencies.push(Date.now() - t0);
        out.push({ queryId: q.id, query: q.query, results: parseResults(text) });
      }
    } finally {
      await stopServer(server);
    }
    latencies.sort((a, b) => a - b);
    const run = {
      variant: v.name, env: v.env, searchOptions: { includeOnline: false, ...searchOptions, k },
      gitCommit, indexHash, k, createdAt: new Date().toISOString(),
      latencyMs: { p50: latencies[Math.floor(latencies.length * 0.5)], p95: latencies[Math.floor(latencies.length * 0.95)] },
      queries: out,
    };
    writeFileSync(join(runsDir, `${v.name}.json`), JSON.stringify(run, null, 2) + "\n");
    runs.push(run);
    console.log(`  ${out.length} queries, latency p50=${run.latencyMs.p50}ms p95=${run.latencyMs.p95}ms`);
  }
  return runs;
}

async function main() {
  const args = process.argv.slice(2);
  const fromRuns = args.includes("--from-runs");
  const variants = argValues(args, "--variant").map(parseVariant);
  if (!fromRuns && variants.length === 0) throw new Error("need --variant name:KEY=VAL (e.g. base:) or --from-runs to pool ready-made run files");
  const k = Number(argValues(args, "--k")[0] ?? DEFAULT_K);
  const maxChars = Number(argValues(args, "--max-chars")[0] ?? DEFAULT_MAX_CHARS);
  const limit = Number(argValues(args, "--limit")[0] ?? Infinity);
  const promptVersion = argValues(args, "--prompt-version")[0] ?? promptVersionOf(loadRubric());
  const runsDir = resolve(argValues(args, "--dir")[0] ?? RUNS_DIR);
  const searchOptions = Object.fromEntries(argValues(args, "--search-option").map(parseSearchOption));
  mkdirSync(runsDir, { recursive: true });

  let runs;
  if (fromRuns) {
    runs = loadRunFiles(runsDir);
    if (runs.length === 0) throw new Error(`no run files in ${runsDir}`);
    console.log(`Pooling ${runs.length} ready-made run(s) from ${runsDir}: ${runs.map((r) => r.variant).join(", ")}`);
  } else {
    const queryFile = argValues(args, "--queries")[0];
    const { default: all } = await import(queryFile ? pathToFileURL(resolve(queryFile)).href : "./eval-queries.js");
    runs = await collectViaServer({ variants, queries: all.slice(0, limit), k, searchOptions, runsDir });
  }
  const queries = queriesFromRuns(runs);

  for (let i = 0; i < runs.length; i++) {
    for (let j = i + 1; j < runs.length; j++) {
      if (identicalRankings(runs[i], runs[j], k)) {
        console.warn(`⚠️  Variants "${runs[i].variant}" and "${runs[j].variant}" ranked EVERY query identically. ` +
          `If they should differ, the flag is not taking effect (wrong code tree? index missing embeddings? env not applied?).`);
      }
    }
  }

  // Hydrate each unique doc once (same doc text for every query and variant).
  const pool = unionPool(runs, k);
  const meta = new Map();
  for (const docs of pool.values()) for (const d of docs.values()) if (!meta.has(d.id)) meta.set(d.id, d);
  const { fetchLibraryDocumentation } = await import(pathToFileURL(resolve("dist/src/lib/localDocs.js")).href);
  const hydrated = new Map();
  let fromFetch = 0, fromSnippet = 0;
  for (const d of meta.values()) {
    let content = null;
    try { content = await fetchLibraryDocumentation(d.id); } catch { /* fall back to the search snippet */ }
    // Section ids ("file#heading") fetch the whole file; show the judge just that section.
    if (content && d.id.includes("#")) content = extractSection(content, d.id.slice(d.id.indexOf("#") + 1));
    const via = content ? "fetch" : "snippet";
    if (content) fromFetch++; else fromSnippet++;
    hydrated.set(d.id, { via, text: renderJudgeText({ ...d, content: content || d.snippet, maxChars }) });
  }

  // The scorer needs each pooled doc's CURRENT content hash to tell usable judgments from stale ones
  // (tasks.json only lists the pairs still to judge). texts.json keeps what the judge saw, for the audit.
  const docs = Object.fromEntries([...hydrated].map(([id, h]) => [id, hashContent(h.text)]));
  writeFileSync(join(runsDir, "pool.json"), JSON.stringify({ promptVersion, maxChars, docs }, null, 2) + "\n");
  writeFileSync(join(runsDir, "texts.json"), JSON.stringify(Object.fromEntries([...hydrated].map(([id, h]) => [id, h.text])), null, 2) + "\n");

  const entries = loadJudgments(JUDGMENTS_PATH);
  const tasks = buildTasks({ pool, queries, hydrated, entries, promptVersion });
  writeFileSync(TASKS_PATH, JSON.stringify({ promptVersion, maxChars, tasks }, null, 2) + "\n");

  const slots = [...pool.values()].reduce((n, d) => n + d.size, 0);
  console.log(`\nPool: ${meta.size} unique docs, ${slots} (query, doc) pairs across ${pool.size} queries`);
  console.log(`Hydration: ${fromFetch} via fetch, ${fromSnippet} via search snippet only`);
  console.log(`Tasks to judge: ${tasks.length} (${slots - tasks.length} already cached) -> ${TASKS_PATH}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
