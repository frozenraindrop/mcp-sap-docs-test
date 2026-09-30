// Shared statistics helpers for the retrieval eval tools (run-eval.js and the
// judged-pool scorer). Pure functions, no I/O.

export function percentile(sorted, p) {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[idx];
}

// Paired bootstrap 95% CI on the mean of per-query deltas (any metric). Resamples
// the paired queries with replacement B times; the CI is the 2.5/97.5 percentiles
// of the resampled means. `rng` is injectable so tests can be deterministic.
export function pairedBootstrap(deltas, B = 10000, rng = Math.random) {
  const n = deltas.length;
  if (n === 0) return null;
  const means = new Array(B);
  for (let b = 0; b < B; b++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += deltas[(rng() * n) | 0];
    means[b] = sum / n;
  }
  means.sort((a, b) => a - b);
  const point = deltas.reduce((s, d) => s + d, 0) / n;
  return { point, lo: percentile(means, 0.025), hi: percentile(means, 0.975), n };
}

// Two-sided sign test p-value: P(|flips| as lopsided as observed) under p=0.5.
export function signTestP(gain, loss) {
  const n = gain + loss;
  if (n === 0) return 1;
  const lo = Math.min(gain, loss);
  // Sum the two symmetric binomial tails: 2 * Σ_{i=0..lo} C(n,i) (0.5)^n, capped at 1.
  let logC = 0; // log C(n,0) = 0
  let tail = Math.exp(-n * Math.LN2); // C(n,0) * 0.5^n
  for (let i = 1; i <= lo; i++) {
    logC += Math.log((n - i + 1) / i); // C(n,i) from C(n,i-1)
    tail += Math.exp(logC - n * Math.LN2);
  }
  return Math.min(1, 2 * tail);
}

// ── Graded-relevance metrics ─────────────────────────────────────────────────
// `grades` is the judged grade of each ranked result, best rank first. A slot
// that has no judgment is `null`/`undefined`: it adds no gain and never counts as
// relevant, but it is not treated as grade 0 either (report judged coverage
// separately so unjudged slots stay visible).

const gain = (g) => (g == null ? 0 : 2 ** g - 1);

function dcg(grades, k) {
  let s = 0;
  for (let i = 0; i < Math.min(k, grades.length); i++) s += gain(grades[i]) / Math.log2(i + 2);
  return s;
}

// nDCG@k with exponential gain (2^grade - 1). `idealGrades` is every known grade
// for the query (the whole pool); defaults to `grades`. Returns 0 when nothing in
// the ideal list has gain, so a query with no relevant doc scores 0, not NaN.
export function ndcg(grades, k, idealGrades = grades) {
  const ideal = idealGrades.filter((g) => g != null).sort((a, b) => b - a);
  const denom = dcg(ideal, k);
  return denom === 0 ? 0 : dcg(grades, k) / denom;
}

// Share of the top-k slots with grade >= minGrade. The denominator is k, so
// unjudged slots pull it down; check judged coverage before reading it.
export function precisionAt(grades, k, minGrade) {
  let hits = 0;
  for (let i = 0; i < Math.min(k, grades.length); i++) if (grades[i] != null && grades[i] >= minGrade) hits++;
  return hits / k;
}

// True if any of the top-k has grade >= minGrade.
export function anyAtLeast(grades, k, minGrade) {
  for (let i = 0; i < Math.min(k, grades.length); i++) if (grades[i] != null && grades[i] >= minGrade) return true;
  return false;
}
