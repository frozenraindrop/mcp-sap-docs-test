import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS module shared with the eval scripts
import { anyAtLeast, ndcg, pairedBootstrap, percentile, precisionAt, signTestP } from "./eval/stats.js";

// Small deterministic LCG so bootstrap results are reproducible.
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

describe("eval stats", () => {
  it("percentile picks nearest rank and handles empty input", () => {
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(percentile([], 0.5)).toBeNaN();
  });

  it("signTestP matches hand-computed binomial values", () => {
    expect(signTestP(0, 0)).toBe(1);
    expect(signTestP(5, 5)).toBe(1);
    expect(signTestP(10, 0)).toBeCloseTo(2 / 1024, 10); // 2 * 0.5^10
    expect(signTestP(0, 10)).toBeCloseTo(2 / 1024, 10); // symmetric
    expect(signTestP(4, 1)).toBeCloseTo(0.375, 10); // 2 * (1+5)/32
  });

  it("pairedBootstrap returns point estimate, brackets it, and is reproducible", () => {
    expect(pairedBootstrap([])).toBeNull();
    const deltas = [0.5, 0.3, -0.1, 0.4, 0.2, 0, 0.6, 0.1];
    const a = pairedBootstrap(deltas, 2000, lcg(1));
    const b = pairedBootstrap(deltas, 2000, lcg(1));
    expect(a).toEqual(b);
    expect(a.n).toBe(8);
    expect(a.point).toBeCloseTo(2.0 / 8, 10);
    expect(a.lo).toBeLessThanOrEqual(a.point);
    expect(a.hi).toBeGreaterThanOrEqual(a.point);
    expect(a.lo).toBeGreaterThan(0); // mostly positive deltas -> CI excludes 0
  });

  it("pairedBootstrap CI straddles 0 for symmetric noise", () => {
    const ci = pairedBootstrap([0.2, -0.2, 0.1, -0.1, 0.3, -0.3], 2000, lcg(7));
    expect(ci.lo).toBeLessThan(0);
    expect(ci.hi).toBeGreaterThan(0);
  });

  it("ndcg is 1 for ideal order and lower for a worse order", () => {
    expect(ndcg([3, 2, 1, 0], 4)).toBeCloseTo(1, 10);
    const worse = ndcg([0, 1, 2, 3], 4, [3, 2, 1, 0]);
    expect(worse).toBeGreaterThan(0);
    expect(worse).toBeLessThan(1);
  });

  it("ndcg hand-computed: [2,3] against ideal [3,2]", () => {
    // gains 3,7 ; DCG = 3/log2(2) + 7/log2(3) ; ideal = 7/1 + 3/log2(3)
    const dcg = 3 + 7 / Math.log2(3);
    const ideal = 7 + 3 / Math.log2(3);
    expect(ndcg([2, 3], 2)).toBeCloseTo(dcg / ideal, 10);
  });

  it("ndcg treats unjudged slots as no gain and is 0 when nothing is relevant", () => {
    expect(ndcg([null, 3], 2, [3])).toBeCloseTo(7 / Math.log2(3) / 7, 10);
    expect(ndcg([0, 0], 2)).toBe(0);
    expect(ndcg([], 5)).toBe(0);
  });

  it("precisionAt and anyAtLeast honour k, threshold and unjudged slots", () => {
    const g = [3, 0, 2, null, 1];
    expect(precisionAt(g, 5, 2)).toBeCloseTo(2 / 5, 10);
    expect(precisionAt(g, 3, 2)).toBeCloseTo(2 / 3, 10);
    expect(precisionAt([3], 5, 2)).toBeCloseTo(1 / 5, 10); // denominator stays k
    expect(anyAtLeast(g, 2, 2)).toBe(true);
    expect(anyAtLeast([0, 1, null], 3, 2)).toBe(false);
    expect(anyAtLeast([0, 0, 3], 2, 2)).toBe(false); // the 3 is beyond k
  });
});
