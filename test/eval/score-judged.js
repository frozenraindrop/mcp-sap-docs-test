// Scores pooled variants from cached judgments (see DESIGN-judged-pools-and-community-harness.md).
//
//   node test/eval/score-judged.js [--k 10] [--compare A B] [--json] [--seed 12345] [--runs test/eval/runs]
//
// Reads runs/<variant>.json + runs/pool.json (written by pool.js) and judgments.json. A judgment
// counts only if its content hash and prompt version are the CURRENT ones; everything else is
// "unjudged", which is reported (coverage) and never silently scored as irrelevant.
// With exactly two variants it also prints the paired comparison.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadJudgments, lookup } from "./judgments.js";
import { loadRunFiles } from "./pool.js";
import { loadRubric, promptVersionOf } from "./judge-core.js";
import { anyAtLeast, ndcg, pairedBootstrap, precisionAt, seededRng, signTestP } from "./stats.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RELEVANT = 2; // grade >= 2 counts as "relevant" for P@5 and any@5
const COVERAGE_WARN = 0.95;
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);

// runs: [{variant, latencyMs?, queries:[{queryId, results:[{id}]}]}]
// poolDocs: { docId: currentContentHash }   entries: judgment cache   -> scores per variant and query
export function scoreRuns({ runs, entries, poolDocs, promptVersion, k = 10 }) {
  const gradeOf = (queryId, docId) => {
    const contentHash = poolDocs[docId];
    if (!contentHash) return null;
    const r = lookup(entries, { queryId, docId, contentHash, promptVersion });
    return r.status === "hit" ? r.entry.grade : null;
  };

  // The pool for a query is the union of every variant's top-k: the ideal ranking for nDCG is
  // built from ALL its judged docs, so variants are measured against the same yardstick.
  const pooled = new Map(); // queryId -> Map(docId -> grade|null)
  for (const run of runs) {
    for (const q of run.queries) {
      if (!pooled.has(q.queryId)) pooled.set(q.queryId, new Map());
      for (const r of q.results.slice(0, k)) pooled.get(q.queryId).set(r.id, gradeOf(q.queryId, r.id));
    }
  }

  const variants = runs.map((run) => {
    const queries = run.queries.map((q) => {
      const grades = q.results.slice(0, k).map((r) => gradeOf(q.queryId, r.id));
      const ideal = [...pooled.get(q.queryId).values()].filter((g) => g != null);
      return {
        queryId: q.queryId,
        grades,
        ndcg: ndcg(grades, k, ideal),
        p5: precisionAt(grades, 5, RELEVANT),
        any5: anyAtLeast(grades, 5, RELEVANT),
        off5: grades.slice(0, 5).filter((g) => g === 0).length / 5,
        judged: grades.filter((g) => g != null).length,
        slots: grades.length,
      };
    });
    const slots = queries.reduce((n, q) => n + q.slots, 0);
    const judged = queries.reduce((n, q) => n + q.judged, 0);
    return {
      name: run.variant,
      latencyMs: run.latencyMs ?? null,
      queries,
      agg: {
        ndcg: mean(queries.map((q) => q.ndcg)),
        p5: mean(queries.map((q) => q.p5)),
        any5: mean(queries.map((q) => (q.any5 ? 1 : 0))),
        off5: mean(queries.map((q) => q.off5)),
        coverage: slots ? judged / slots : 0,
        queries: queries.length,
      },
    };
  });
  return { k, promptVersion, variants };
}

// Paired comparison B vs A over the queries both variants have (delta = B - A).
export function compareVariants(a, b, rng = seededRng()) {
  const byId = new Map(a.queries.map((q) => [q.queryId, q]));
  const pairs = b.queries.filter((q) => byId.has(q.queryId)).map((qb) => [byId.get(qb.queryId), qb]);
  const ci = (vals) => {
    const c = pairedBootstrap(vals, 10000, rng);
    return c && { ...c, real: c.lo > 0 || c.hi < 0 };
  };
  let gain = 0, loss = 0;
  for (const [qa, qb] of pairs) {
    if (qb.any5 && !qa.any5) gain++;
    else if (!qb.any5 && qa.any5) loss++;
  }
  return {
    a: a.name, b: b.name, n: pairs.length,
    ndcg: ci(pairs.map(([qa, qb]) => qb.ndcg - qa.ndcg)),
    p5: ci(pairs.map(([qa, qb]) => qb.p5 - qa.p5)),
    flips: { gain, loss, p: signTestP(gain, loss) },
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
const f3 = (x) => (Number.isNaN(x) ? "  n/a" : x.toFixed(3));
const pct = (x) => (x * 100).toFixed(0).padStart(3) + "%";
const sgn = (x) => (x >= 0 ? "+" : "") + x.toFixed(3);

function report(result, cmp, notes) {
  const { k, promptVersion, variants } = result;
  const lines = [`\nJudged-pool scoring: ${variants[0]?.agg.queries ?? 0} queries, depth k=${k}, ${promptVersion}`];
  notes.forEach((n) => lines.push(`⚠️  ${n}`));
  const w = Math.max(18, ...variants.map((v) => v.name.length + 2)); // name column fits the longest variant
  lines.push("variant".padEnd(w) + `nDCG@${k}`.padEnd(10) + "P@5(>=2)".padEnd(10) + "any>=2@5".padEnd(10) + "off-topic@5".padEnd(13) + "coverage".padEnd(10) + "latency p50/p95");
  for (const v of variants) {
    const l = v.latencyMs ? `${v.latencyMs.p50}/${v.latencyMs.p95} ms` : "n/a";
    lines.push(v.name.padEnd(w) + f3(v.agg.ndcg).padEnd(10) + f3(v.agg.p5).padEnd(10) + pct(v.agg.any5).padEnd(10) + pct(v.agg.off5).padEnd(13) + pct(v.agg.coverage).padEnd(10) + l);
  }
  if (cmp) {
    const tag = (c) => (c.real ? "real" : "within noise");
    lines.push(`\nPaired: ${cmp.b} vs ${cmp.a} over ${cmp.n} shared queries (delta = ${cmp.b} - ${cmp.a})`);
    if (cmp.ndcg) lines.push(`  nDCG@${k}    ${sgn(cmp.ndcg.point)}  95% CI [${sgn(cmp.ndcg.lo)}, ${sgn(cmp.ndcg.hi)}]  ${tag(cmp.ndcg)}`);
    if (cmp.p5) lines.push(`  P@5(>=2)   ${sgn(cmp.p5.point)}  95% CI [${sgn(cmp.p5.lo)}, ${sgn(cmp.p5.hi)}]  ${tag(cmp.p5)}`);
    lines.push(`  any>=2@5 flips  +${cmp.flips.gain} / -${cmp.flips.loss}  sign test p=${cmp.flips.p.toFixed(3)}  ${cmp.flips.p < 0.05 ? "real" : "within noise"}`);
  }
  return lines.join("\n");
}

function flag(args, name, n = 1) {
  const i = args.indexOf(name);
  return i === -1 ? undefined : n === 1 ? args[i + 1] : args.slice(i + 1, i + 1 + n);
}

function main() {
  const args = process.argv.slice(2);
  const runsDir = resolve(flag(args, "--runs") ?? join(__dirname, "runs"));
  const k = Number(flag(args, "--k") ?? 10);
  const seed = Number(flag(args, "--seed") ?? 12345);
  const poolPath = join(runsDir, "pool.json");
  if (!existsSync(poolPath)) throw new Error(`${poolPath} not found. Run pool.js first.`);
  const pool = JSON.parse(readFileSync(poolPath, "utf8"));
  const runs = loadRunFiles(runsDir);
  if (runs.length === 0) throw new Error(`no run files in ${runsDir}`);

  const notes = [];
  const current = promptVersionOf(loadRubric());
  if (pool.promptVersion !== current) notes.push(`runs were pooled for ${pool.promptVersion} but rubric.md is ${current}; re-run pool.js and judge the new tasks.`);

  const result = scoreRuns({ runs, entries: loadJudgments(join(__dirname, "judgments.json")), poolDocs: pool.docs, promptVersion: pool.promptVersion, k });
  for (const v of result.variants) {
    if (v.agg.coverage < COVERAGE_WARN) notes.push(`${v.name}: only ${pct(v.agg.coverage).trim()} of the top-${k} is judged; run judge.js on the pending tasks before trusting these numbers.`);
  }

  let cmp = null;
  const pair = flag(args, "--compare", 2);
  const by = new Map(result.variants.map((v) => [v.name, v]));
  if (pair) {
    if (!by.has(pair[0]) || !by.has(pair[1])) throw new Error(`--compare needs two of: ${[...by.keys()].join(", ")}`);
    cmp = compareVariants(by.get(pair[0]), by.get(pair[1]), seededRng(seed));
  } else if (result.variants.length === 2) {
    cmp = compareVariants(result.variants[0], result.variants[1], seededRng(seed));
  }

  if (args.includes("--json")) {
    process.stdout.write(JSON.stringify({ ...result, comparison: cmp, notes }, null, 2) + "\n");
  } else {
    console.log(report(result, cmp, notes));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (err) { console.error("Fatal:", err.message); process.exit(1); }
}
