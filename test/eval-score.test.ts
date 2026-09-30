import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error plain JS modules shared with the eval scripts
import { compareVariants, scoreRuns } from "./eval/score-judged.js";
// @ts-expect-error plain JS module
import { loadRubric, promptVersionOf } from "./eval/judge-core.js";

const PV = "rubric-test";
const poolDocs = { d1: "h1", d2: "h2", d3: "h3", d4: "h4", d5: "h5", d6: "h6" };
const e = (queryId: string, docId: string, grade: number, extra: object = {}) => ({
  queryId, docId, contentHash: poolDocs[docId as keyof typeof poolDocs], grade, rationale: "",
  judgeModel: "m", promptVersion: PV, judgedAt: "2026-09-30T00:00:00Z", ...extra,
});
const entries = [
  e("q1", "d1", 3), e("q1", "d2", 1), e("q1", "d3", 0), // d4 deliberately unjudged
  e("q2", "d5", 0), e("q2", "d6", 3),
];
const q = (queryId: string, ids: string[]) => ({ queryId, results: ids.map((id) => ({ id })) });
const runA = { variant: "A", latencyMs: { p50: 10, p95: 20 }, queries: [q("q1", ["d1", "d2", "d3"]), q("q2", ["d5"])] };
const runB = { variant: "B", queries: [q("q1", ["d2", "d1", "d4"]), q("q2", ["d6"])] };
const score = (over: object = {}) => scoreRuns({ runs: [runA, runB], entries, poolDocs, promptVersion: PV, k: 10, ...over });

describe("scoreRuns", () => {
  it("matches hand-computed metrics", () => {
    const [A, B] = score().variants;
    const a1 = A.queries[0], b1 = B.queries[0];
    expect(a1.grades).toEqual([3, 1, 0]);
    expect(a1.ndcg).toBeCloseTo(1, 10); // already the ideal order
    expect(a1.p5).toBeCloseTo(1 / 5, 10);
    expect(a1.off5).toBeCloseTo(1 / 5, 10); // one grade-0 in the top 5 slots
    expect(b1.grades).toEqual([1, 3, null]); // d4 has no judgment
    const l3 = Math.log2(3);
    expect(b1.ndcg).toBeCloseTo((1 + 7 / l3) / (7 + 1 / l3), 10);
    expect(b1.any5).toBe(true);
    expect(b1.off5).toBe(0); // unjudged is not counted as grade 0
  });

  it("coverage counts unjudged slots and aggregates means", () => {
    const [A, B] = score().variants;
    expect(A.agg.coverage).toBe(1);
    expect(B.agg.coverage).toBeCloseTo(3 / 4, 10); // 4 slots, d4 unjudged
    expect(A.agg.any5).toBeCloseTo(0.5, 10); // q1 true, q2 false (d5 is grade 0)
    expect(A.agg.queries).toBe(2);
    expect(A.latencyMs).toEqual({ p50: 10, p95: 20 });
  });

  it("ignores stale judgments: changed content hash or different prompt version", () => {
    const changed = score({ poolDocs: { ...poolDocs, d1: "h1-new" } }).variants[0].queries[0];
    expect(changed.grades).toEqual([null, 1, 0]);
    const other = score({ promptVersion: "rubric-other" }).variants[0];
    expect(other.agg.coverage).toBe(0);
    expect(other.queries[0].ndcg).toBe(0);
  });
});

describe("compareVariants", () => {
  it("pairs queries, reports deltas (B - A) and any>=2@5 flips", () => {
    const [A, B] = score().variants;
    const c = compareVariants(A, B);
    expect(c).toMatchObject({ a: "A", b: "B", n: 2, flips: { gain: 1, loss: 0 } });
    expect(c.flips.p).toBe(1); // a single flip can never be significant
    const b1 = B.queries[0].ndcg; // q1: B - 1 ; q2: 1 - 0
    expect(c.ndcg.point).toBeCloseTo((b1 - 1 + 1) / 2, 10);
    expect(c.ndcg.real).toBe(false); // n=2
  });

  it("is reproducible with the default seed", () => {
    const [A, B] = score().variants;
    expect(compareVariants(A, B)).toEqual(compareVariants(A, B));
  });

  it("skips queries only one variant has", () => {
    const [A, B] = score({ runs: [runA, { ...runB, queries: [runB.queries[0]] }] }).variants;
    expect(compareVariants(A, B).n).toBe(1);
  });
});

describe("score-judged CLI", () => {
  const dirs: string[] = [];
  afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

  it("warns loudly when nothing is judged, and emits valid JSON with --json", () => {
    const dir = mkdtempSync(join(tmpdir(), "score-"));
    dirs.push(dir);
    writeFileSync(join(dir, "pool.json"), JSON.stringify({ promptVersion: promptVersionOf(loadRubric()), maxChars: 1500, docs: { d1: "h1", d2: "h2" } }));
    writeFileSync(join(dir, "a.json"), JSON.stringify({ variant: "a", queries: [q("qx", ["d1", "d2"])] }));
    writeFileSync(join(dir, "b.json"), JSON.stringify({ variant: "b", queries: [q("qx", ["d2", "d1"])] }));
    const script = join(__dirname, "eval", "score-judged.js");
    const text = execFileSync("node", [script, "--runs", dir], { encoding: "utf8" });
    expect(text).toContain("only 0% of the top-10 is judged");
    expect(text).toContain("Paired: b vs a over 1 shared queries");
    const json = JSON.parse(execFileSync("node", [script, "--runs", dir, "--json"], { encoding: "utf8" }));
    expect(json.variants.map((v: { name: string }) => v.name)).toEqual(["a", "b"]);
    expect(json.comparison.n).toBe(1);
    expect(json.notes.length).toBeGreaterThan(0);
  });
});
