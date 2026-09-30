// Judgment cache for the judged-pool eval (see DESIGN-judged-pools-and-community-harness.md).
//
// One entry = one LLM grade for one (query, doc) as the judge saw it:
//   { queryId, docId, contentHash, grade, rationale, judgeModel, promptVersion, judgedAt }
//
// An entry is USABLE only if its contentHash and promptVersion both match what the
// caller has now. Otherwise it is "stale": kept on disk for audit, never scored.
// Pure functions plus load/save; no LLM, no network.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

// Canonical field order: keeps every saved line identical in shape, so diffs are small.
const FIELDS = ["queryId", "docId", "contentHash", "grade", "rationale", "judgeModel", "promptVersion", "judgedAt"];

// Hash of the exact text the judge is shown (title + source + truncated content).
export function hashContent(text) {
  return createHash("sha1").update(String(text)).digest("hex");
}

// Throws on a malformed entry; returns it in canonical field order.
export function normalizeEntry(e) {
  for (const f of FIELDS) {
    if (e?.[f] === undefined || e[f] === null || e[f] === "") {
      if (f === "rationale") continue; // a rationale may be empty
      throw new Error(`judgment entry missing "${f}": ${JSON.stringify(e)}`);
    }
  }
  if (!Number.isInteger(e.grade) || e.grade < 0 || e.grade > 3) {
    throw new Error(`judgment grade must be an integer 0-3, got ${JSON.stringify(e.grade)}`);
  }
  const out = {};
  for (const f of FIELDS) out[f] = f === "rationale" ? String(e[f] ?? "") : e[f];
  return out;
}

const sameSlot = (a, b) =>
  a.queryId === b.queryId && a.docId === b.docId && a.contentHash === b.contentHash && a.promptVersion === b.promptVersion;

// Add an entry, replacing any existing one for the same (query, doc, hash, promptVersion).
// Returns a new array; the input is not modified.
export function upsert(entries, entry) {
  const e = normalizeEntry(entry);
  return [...entries.filter((x) => !sameSlot(x, e)), e];
}

// { status: "hit" | "stale" | "miss", entry? }
//  hit   - an entry matches hash AND promptVersion (newest wins if several)
//  stale - the query+doc was judged before, but under a different hash or promptVersion
//  miss  - never judged
export function lookup(entries, { queryId, docId, contentHash, promptVersion }) {
  let stale = null;
  let hit = null;
  for (const x of entries) {
    if (x.queryId !== queryId || x.docId !== docId) continue;
    if (x.contentHash === contentHash && x.promptVersion === promptVersion) {
      if (!hit || x.judgedAt > hit.judgedAt) hit = x;
    } else if (!stale || x.judgedAt > stale.judgedAt) {
      stale = x;
    }
  }
  if (hit) return { status: "hit", entry: hit };
  if (stale) return { status: "stale", entry: stale };
  return { status: "miss" };
}

// Sorted, one entry per line, so committed diffs show exactly which judgments changed.
export function serialize(entries) {
  const sorted = entries
    .map(normalizeEntry)
    .sort((a, b) => FIELDS.slice(0, 3).concat("promptVersion").reduce((r, f) => r || (a[f] < b[f] ? -1 : a[f] > b[f] ? 1 : 0), 0));
  if (sorted.length === 0) return "[]\n";
  return "[\n" + sorted.map((e) => "  " + JSON.stringify(e)).join(",\n") + "\n]\n";
}

export function loadJudgments(path) {
  if (!existsSync(path)) return [];
  const data = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(data)) throw new Error(`${path} must contain a JSON array`);
  return data.map(normalizeEntry);
}

export function saveJudgments(path, entries) {
  writeFileSync(path, serialize(entries));
}
