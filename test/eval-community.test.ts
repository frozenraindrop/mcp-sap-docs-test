import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error plain JS modules shared with the eval scripts
import { loadRunFiles, parseSearchOption, queriesFromRuns } from "./eval/pool.js";
// @ts-expect-error plain JS module
import { produceRun, toResult } from "./eval/community-produce.js";
// @ts-expect-error plain JS module
import COMMUNITY_QUERIES from "./eval/community-queries.js";

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe("pool: ready-made run support", () => {
  it("parseSearchOption parses JSON values and keeps plain text", () => {
    expect(parseSearchOption("includeOnline=true")).toEqual(["includeOnline", true]);
    expect(parseSearchOption("k=5")).toEqual(["k", 5]);
    expect(parseSearchOption('sources=["wdi5","cap"]')).toEqual(["sources", ["wdi5", "cap"]]);
    expect(parseSearchOption("abapFlavor=cloud")).toEqual(["abapFlavor", "cloud"]);
    expect(() => parseSearchOption("nonsense")).toThrow(/KEY=VALUE/);
  });

  it("queriesFromRuns returns each query once, with its text", () => {
    const runs = [
      { variant: "a", queries: [{ queryId: "q1", query: "one", results: [] }, { queryId: "q2", query: "two", results: [] }] },
      { variant: "b", queries: [{ queryId: "q1", query: "one", results: [] }] },
    ];
    expect(queriesFromRuns(runs)).toEqual([{ id: "q1", query: "one" }, { id: "q2", query: "two" }]);
  });

  it("loadRunFiles picks run files by shape and skips pool.json / texts.json / junk", () => {
    const dir = mkdtempSync(join(tmpdir(), "runs-"));
    dirs.push(dir);
    writeFileSync(join(dir, "b.json"), JSON.stringify({ variant: "b", queries: [] }));
    writeFileSync(join(dir, "a.json"), JSON.stringify({ variant: "a", queries: [] }));
    writeFileSync(join(dir, "pool.json"), JSON.stringify({ promptVersion: "x", docs: {} }));
    writeFileSync(join(dir, "texts.json"), JSON.stringify({ d1: "text" }));
    writeFileSync(join(dir, "notes.txt"), "ignore me");
    expect(loadRunFiles(dir).map((r: { variant: string }) => r.variant)).toEqual(["a", "b"]);
    expect(loadRunFiles(join(dir, "missing"))).toEqual([]);
  });
});

describe("community producer", () => {
  const queries = [{ id: "q1", query: "one" }, { id: "q2", query: "two" }, { id: "q3", query: "three" }];

  it("toResult mirrors the id scheme used by the server so fetch can hydrate it", () => {
    expect(toResult({ postId: "123", title: "T", url: "u", snippet: "s" }, 0)).toEqual({ id: "community-123", title: "T", snippet: "s", url: "u" });
    expect(toResult({ title: "T", url: "u" }, 4)).toEqual({ id: "community-4", title: "T", snippet: "", url: "u" });
  });

  it("produces a pool-compatible run, trims to k, and keeps failed queries visible", async () => {
    let clock = 0;
    const strategy = async (query: string, opts: { k: number; minKudos: number }) => {
      if (query === "two") throw new Error("HTTP 500");
      expect(opts).toMatchObject({ k: 2, minKudos: 1 });
      return [1, 2, 3].map((n) => ({ postId: `${query}-${n}`, title: `t${n}`, url: `u${n}`, snippet: "" }));
    };
    const { run, failed } = await produceRun({ strategy, name: "community-test", queries, k: 2, opts: { minKudos: 1 }, now: () => (clock += 10) });
    expect(run.variant).toBe("community-test");
    expect(run.queries.map((q: { queryId: string }) => q.queryId)).toEqual(["q1", "q2", "q3"]); // none dropped
    expect(run.queries[0].results.map((r: { id: string }) => r.id)).toEqual(["community-one-1", "community-one-2"]);
    expect(run.queries[1].results).toEqual([]);
    expect(failed).toEqual(["q2: HTTP 500"]);
    expect(run.latencyMs.p50).toBe(10);
    expect(queriesFromRuns([run])).toHaveLength(3); // what pool.js --from-runs will consume
  });

  it("the starter query set is well formed and unique", () => {
    expect(COMMUNITY_QUERIES.length).toBeGreaterThanOrEqual(10);
    expect(new Set(COMMUNITY_QUERIES.map((q: { id: string }) => q.id)).size).toBe(COMMUNITY_QUERIES.length);
    for (const q of COMMUNITY_QUERIES) expect(q.query.length).toBeGreaterThan(10);
  });
});
