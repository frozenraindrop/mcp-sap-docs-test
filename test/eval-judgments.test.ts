import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error plain JS module shared with the eval scripts
import { hashContent, loadJudgments, lookup, normalizeEntry, saveJudgments, serialize, upsert } from "./eval/judgments.js";

const base = {
  queryId: "q1",
  docId: "ABENBDL_DETERMINATIONS",
  contentHash: "h1",
  grade: 3,
  rationale: "directly answers",
  judgeModel: "claude-x",
  promptVersion: "v1",
  judgedAt: "2026-09-30T10:00:00Z",
};
const key = { queryId: "q1", docId: "ABENBDL_DETERMINATIONS", contentHash: "h1", promptVersion: "v1" };

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("judgment cache", () => {
  it("hashContent is deterministic and sensitive to any change", () => {
    expect(hashContent("abc")).toBe(hashContent("abc"));
    expect(hashContent("abc")).not.toBe(hashContent("abd"));
    expect(hashContent("abc")).toMatch(/^[0-9a-f]{40}$/);
  });

  it("lookup: hit, miss, and stale by hash or by promptVersion", () => {
    const entries = [normalizeEntry(base)];
    expect(lookup(entries, key).status).toBe("hit");
    expect(lookup(entries, { ...key, docId: "OTHER" }).status).toBe("miss");
    expect(lookup(entries, { ...key, queryId: "q2" }).status).toBe("miss");
    const changedContent = lookup(entries, { ...key, contentHash: "h2" });
    expect(changedContent.status).toBe("stale");
    expect(changedContent.entry.grade).toBe(3); // kept for audit, but not a hit
    expect(lookup(entries, { ...key, promptVersion: "v2" }).status).toBe("stale");
  });

  it("lookup: an entry matching the current hash wins over older stale ones", () => {
    const entries = [
      normalizeEntry({ ...base, contentHash: "old", grade: 0, judgedAt: "2026-09-01T00:00:00Z" }),
      normalizeEntry({ ...base, grade: 2, judgedAt: "2026-09-30T00:00:00Z" }),
    ];
    const r = lookup(entries, key);
    expect(r.status).toBe("hit");
    expect(r.entry.grade).toBe(2);
  });

  it("upsert replaces the same slot and keeps other hashes/versions", () => {
    let entries = upsert([], base);
    entries = upsert(entries, { ...base, grade: 1 }); // same slot -> replaced
    expect(entries).toHaveLength(1);
    expect(entries[0].grade).toBe(1);
    entries = upsert(entries, { ...base, contentHash: "h2" }); // new hash -> appended
    entries = upsert(entries, { ...base, promptVersion: "v2" }); // new prompt -> appended
    expect(entries).toHaveLength(3);
    const input: unknown[] = [];
    upsert(input, base);
    expect(input).toHaveLength(0); // input not mutated
  });

  it("normalizeEntry rejects bad grades and missing fields", () => {
    expect(() => normalizeEntry({ ...base, grade: 4 })).toThrow(/0-3/);
    expect(() => normalizeEntry({ ...base, grade: 1.5 })).toThrow(/0-3/);
    expect(() => normalizeEntry({ ...base, grade: "2" })).toThrow(/0-3/);
    expect(() => normalizeEntry({ ...base, docId: undefined })).toThrow(/docId/);
    expect(normalizeEntry({ ...base, rationale: "" }).rationale).toBe(""); // empty rationale is allowed
  });

  it("serialize is order-independent, one entry per line, canonical key order", () => {
    const a = { ...base, docId: "A" };
    const b = { ...base, docId: "B" };
    expect(serialize([b, a])).toBe(serialize([a, b]));
    const text = serialize([b, a]);
    expect(text.split("\n").filter((l) => l.startsWith("  {"))).toHaveLength(2);
    expect(text.indexOf('"docId":"A"')).toBeLessThan(text.indexOf('"docId":"B"'));
    expect(text.startsWith('[\n  {"queryId":"q1","docId":"A","contentHash"')).toBe(true);
    expect(serialize([])).toBe("[]\n");
  });

  it("save/load round-trips and a missing file loads as empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "judg-"));
    dirs.push(dir);
    const file = join(dir, "judgments.json");
    expect(loadJudgments(file)).toEqual([]);
    saveJudgments(file, [base, { ...base, docId: "A" }]);
    const loaded = loadJudgments(file);
    expect(loaded.map((e: { docId: string }) => e.docId)).toEqual(["A", "ABENBDL_DETERMINATIONS"]);
    saveJudgments(file, loaded);
    expect(readFileSync(file, "utf8")).toBe(serialize(loaded)); // idempotent
    writeFileSync(file, '{"not":"an array"}');
    expect(() => loadJudgments(file)).toThrow(/array/);
  });

  it("the committed judgments.json is valid", () => {
    expect(() => loadJudgments(join(__dirname, "eval", "judgments.json"))).not.toThrow();
  });
});
