// Producer for the SAP Community leg: runs a Community retrieval strategy on its own (no server,
// no index, no embeddings) and writes a run file in the same shape pool.js produces, so the rest of
// the chain (pool --from-runs -> judge -> score-judged) is reused unchanged.
//
//   node test/eval/community-produce.js --strategy current [--min-kudos 1] [--k 10] [--limit 5]
//        [--queries test/eval/community-queries.js] [--name community-current] [--dir test/eval/runs-community]
//        [--searxng-url https://instance]   (strategy searxng only)
//   node test/eval/pool.js --from-runs --dir test/eval/runs-community
//
// Needs `npm run build:tsc` first (imports dist/) and network access to community.sap.com.
// Add new strategies (AND-fix, SearXNG, ...) to STRATEGIES; each is (query, opts) -> hits.

import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// A strategy returns BestMatchHit-like objects: { postId?, title, url, snippet? } in ranked order.
export const STRATEGIES = {
  // What the MCP does today: per-term subject LiQL searches + broad search, rescored by term hits > kudos > recency.
  current: async (query, { k, minKudos }) => {
    const { searchCommunityBestMatch } = await import(pathToFileURL(resolve("dist/src/lib/communityBestMatch.js")).href);
    return searchCommunityBestMatch(query, { limit: k, minKudos, includeBlogs: true, userAgent: "SAP-Docs-MCP-eval/1.0" });
  },
  // A2b: AND-composed LiQL MATCHES per significant term (see community-strategies.js).
  and: async (query, opts) => (await import("./community-strategies.js")).searchCommunityAnd(query, opts),
  // A3b: SearXNG discovery (engine order, no weighting); needs --searxng-url or SEARXNG_URL (see community-searxng.js).
  searxng: async (query, opts) => (await import("./community-searxng.js")).searchCommunitySearxng(query, opts),
};

// Same id scheme as searchCommunity() in localDocs.ts, so fetchLibraryDocumentation can hydrate it.
export const toResult = (hit, i) => ({ id: `community-${hit.postId ?? i}`, title: hit.title, snippet: hit.snippet ?? "", url: hit.url });

// Run `strategy` over `queries`; `now` is injectable for tests. Failed queries are kept with no results
// (and reported) so one flaky request cannot silently shrink the query set.
export async function produceRun({ strategy, name, queries, k, opts, now = () => Date.now() }) {
  const out = [];
  const latencies = [];
  const failed = [];
  for (const q of queries) {
    const t0 = now();
    let hits = [];
    try { hits = await strategy(q.query, { k, ...opts }); } catch (err) { failed.push(`${q.id}: ${err.message}`); }
    latencies.push(now() - t0);
    out.push({ queryId: q.id, query: q.query, results: hits.slice(0, k).map(toResult) });
  }
  latencies.sort((a, b) => a - b);
  return {
    run: {
      variant: name, searchOptions: { k, ...opts },
      k, latencyMs: { p50: latencies[Math.floor(latencies.length * 0.5)], p95: latencies[Math.floor(latencies.length * 0.95)] },
      queries: out,
    },
    failed,
  };
}

const flag = (args, f) => { const i = args.indexOf(f); return i === -1 ? undefined : args[i + 1]; };

async function main() {
  const args = process.argv.slice(2);
  const strategyName = flag(args, "--strategy") ?? "current";
  const strategy = STRATEGIES[strategyName];
  if (!strategy) throw new Error(`unknown --strategy "${strategyName}" (have: ${Object.keys(STRATEGIES).join(", ")})`);
  const k = Number(flag(args, "--k") ?? 10);
  const minKudos = Number(flag(args, "--min-kudos") ?? 1);
  const limit = Number(flag(args, "--limit") ?? Infinity);
  const name = flag(args, "--name") ?? `community-${strategyName}`;
  const dir = resolve(flag(args, "--dir") ?? join(fileURLToPath(new URL(".", import.meta.url)), "runs-community"));
  const queryFile = flag(args, "--queries");
  const { default: all } = await import(queryFile ? pathToFileURL(resolve(queryFile)).href : "./community-queries.js");

  let gitCommit = "unknown";
  try { gitCommit = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim(); } catch { /* not a git checkout */ }

  console.log(`▶ ${name}: strategy=${strategyName} minKudos=${minKudos} k=${k} over ${Math.min(limit, all.length)} queries`);
  const searxngUrl = flag(args, "--searxng-url");
  const { run, failed } = await produceRun({ strategy, name, queries: all.slice(0, limit), k, opts: { minKudos, ...(searxngUrl && { searxngUrl }) } });
  run.strategy = strategyName;
  run.gitCommit = gitCommit;
  run.createdAt = new Date().toISOString();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(run, null, 2) + "\n");

  const counts = run.queries.map((q) => q.results.length);
  console.log(`  results per query: ${counts.join(", ")}  (latency p50=${run.latencyMs.p50}ms p95=${run.latencyMs.p95}ms)`);
  failed.forEach((f) => console.warn(`  ⚠️  failed ${f}`));
  console.log(`Wrote ${join(dir, `${name}.json`)}\nNext: node test/eval/pool.js --from-runs --dir ${dir}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error("Fatal:", err.message); process.exit(1); });
}
