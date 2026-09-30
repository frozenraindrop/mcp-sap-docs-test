import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS modules shared with the eval scripts
import { buildTasks, extractSection, identicalRankings, parseResults, parseVariant, renderJudgeText, unionPool } from "./eval/pool.js";
// @ts-expect-error plain JS module
import { hashContent, upsert } from "./eval/judgments.js";

// Trimmed from real server output (format: id line, title, snippet, URL, "Use in fetch").
const SEARCH_TEXT = `Found 2 results for 'rap validation':

⭐️ **/abap-docs-standard/ABENBDL_VALIDATIONS** (Score: 0.05)
   ABENBDL_VALIDATIONS

\`validation ValName on save\` A [RAP validation](ABENRAP_VALIDATION_GLOSRY.html) checks
   the consistency of instances.
   🔗 https://help.sap.com/doc/abapdocu_latest_index_htm/latest/en-US/ABENBDL_VALIDATIONS.html
   Use in fetch

⭐️ **/abap-docs-standard/ABENBDL_DETERMINATIONS** (Score: 0.04)
   ABENBDL_DETERMINATIONS

Determinations modify data.
   🔗 https://help.sap.com/doc/abapdocu_latest_index_htm/latest/en-US/ABENBDL_DETERMINATIONS.html
   Use in fetch
`;

const res = (id: string) => ({ id, title: id, snippet: "s", url: "" });
const run = (variant: string, perQuery: Record<string, string[]>) => ({
  variant,
  queries: Object.entries(perQuery).map(([queryId, ids]) => ({ queryId, results: ids.map(res) })),
});

describe("pool: parseResults", () => {
  it("parses id, title, snippet and url from the real output shape", () => {
    const r = parseResults(SEARCH_TEXT);
    expect(r.map((x: { id: string }) => x.id)).toEqual([
      "/abap-docs-standard/ABENBDL_VALIDATIONS",
      "/abap-docs-standard/ABENBDL_DETERMINATIONS",
    ]);
    expect(r[0].title).toBe("ABENBDL_VALIDATIONS");
    expect(r[0].snippet).toContain("RAP validation");
    expect(r[0].snippet).toContain("consistency of instances"); // multi-line snippet joined
    expect(r[0].snippet).not.toContain("Use in fetch");
    expect(r[0].url).toBe("https://help.sap.com/doc/abapdocu_latest_index_htm/latest/en-US/ABENBDL_VALIDATIONS.html");
  });

  it("returns [] for empty or result-less text", () => {
    expect(parseResults("")).toEqual([]);
    expect(parseResults("No results found")).toEqual([]);
    expect(parseResults(undefined)).toEqual([]);
  });
});

describe("pool: renderJudgeText", () => {
  it("includes title, source, url and truncates content to maxChars", () => {
    const t = renderJudgeText({ id: "d1", title: "T", url: "http://u", content: "x".repeat(50), maxChars: 10 });
    expect(t).toBe("Title: T\nSource: d1\nURL: http://u\n\n" + "x".repeat(10));
  });

  it("omits the URL line when absent and tolerates missing content", () => {
    expect(renderJudgeText({ id: "d1", title: "T", url: "", content: null })).toBe("Title: T\nSource: d1\n\n");
  });

  it("changing maxChars changes the text (and so the cache key)", () => {
    const a = renderJudgeText({ id: "d", title: "T", content: "y".repeat(100), maxChars: 10 });
    const b = renderJudgeText({ id: "d", title: "T", content: "y".repeat(100), maxChars: 20 });
    expect(hashContent(a)).not.toBe(hashContent(b));
  });
});

describe("pool: unionPool", () => {
  it("unions each variant's top-k per query and dedups", () => {
    const pool = unionPool(
      [run("a", { q1: ["d1", "d2", "d3"] }), run("b", { q1: ["d2", "d4", "d5"], q2: ["d9"] })],
      2,
    );
    expect([...pool.get("q1").keys()].sort()).toEqual(["d1", "d2", "d4"]); // d3, d5 are beyond k=2
    expect([...pool.get("q2").keys()]).toEqual(["d9"]);
  });
});

describe("pool: buildTasks", () => {
  const queries = [{ id: "q1", query: "question one" }];
  const pool = unionPool([run("a", { q1: ["d1", "d2"] })], 10);
  const hydrated = new Map([
    ["d1", { via: "fetch", text: "text one" }],
    ["d2", { via: "snippet", text: "text two" }],
  ]);
  const entry = (docId: string, text: string, promptVersion = "v1") => ({
    queryId: "q1", docId, contentHash: hashContent(text), grade: 2, rationale: "",
    judgeModel: "m", promptVersion, judgedAt: "2026-09-30T00:00:00Z",
  });

  it("emits a task for every uncached pair", () => {
    const tasks = buildTasks({ pool, queries, hydrated, entries: [], promptVersion: "v1" });
    expect(tasks.map((t: { docId: string }) => t.docId)).toEqual(["d1", "d2"]);
    expect(tasks[0]).toMatchObject({ queryId: "q1", query: "question one", via: "fetch", text: "text one" });
    expect(tasks[0].contentHash).toBe(hashContent("text one"));
  });

  it("skips cached pairs; a second run after judging emits zero tasks", () => {
    let entries: unknown[] = [];
    entries = upsert(entries, entry("d1", "text one"));
    entries = upsert(entries, entry("d2", "text two"));
    expect(buildTasks({ pool, queries, hydrated, entries, promptVersion: "v1" })).toEqual([]);
  });

  it("re-emits when content or promptVersion changed (stale), not when unrelated", () => {
    const entries = [entry("d1", "OLD text one"), entry("d2", "text two", "v0")];
    const tasks = buildTasks({ pool, queries, hydrated, entries, promptVersion: "v1" });
    expect(tasks.map((t: { docId: string }) => t.docId)).toEqual(["d1", "d2"]);
  });

  it("does not judge docs that could not be hydrated", () => {
    const partial = new Map([["d1", { via: "fetch", text: "text one" }]]);
    const tasks = buildTasks({ pool, queries, hydrated: partial, entries: [], promptVersion: "v1" });
    expect(tasks.map((t: { docId: string }) => t.docId)).toEqual(["d1"]);
  });
});

describe("pool: parseVariant", () => {
  it("parses name and env pairs", () => {
    expect(parseVariant("on:RERANKER_ENABLED=true,X=1")).toEqual({ name: "on", env: { RERANKER_ENABLED: "true", X: "1" } });
    expect(parseVariant("base")).toEqual({ name: "base", env: {} });
    expect(parseVariant("base:")).toEqual({ name: "base", env: {} });
  });

  it("rejects malformed env", () => {
    expect(() => parseVariant("a:NOEQUALS")).toThrow(/KEY=VAL/);
  });
});

describe("pool: identicalRankings", () => {
  it("is true only when every shared query ranks the same top-k", () => {
    const a = run("a", { q1: ["d1", "d2", "d3"], q2: ["d4"] });
    expect(identicalRankings(a, run("b", { q1: ["d1", "d2", "d3"], q2: ["d4"] }), 3)).toBe(true);
    expect(identicalRankings(a, run("b", { q1: ["d2", "d1", "d3"], q2: ["d4"] }), 3)).toBe(false);
    expect(identicalRankings(a, run("b", { q1: ["d1", "d2", "dX"], q2: ["d4"] }), 2)).toBe(true); // beyond k ignored
  });

  it("is false when nothing is comparable", () => {
    expect(identicalRankings(run("a", { q1: ["d1"] }), run("b", { q9: ["d1"] }), 3)).toBe(false);
  });
});

describe("pool: extractSection", () => {
  const lines = [
    "# Doc", "- [Intro](#intro)", "", "## Intro", "intro text", "",
    "## Compressing and Decompressing Binary Data", "gzip text", "```abap", "# not a heading", "```",
    "### Sub point", "sub text", "", "## Next Topic", "other text",
  ];
  const md = lines.join("\n");

  it("returns the section up to the next heading of the same or higher level", () => {
    const s = extractSection(md, "compressing-and-decompressing-binary-data");
    expect(s.startsWith("## Compressing and Decompressing Binary Data")).toBe(true);
    expect(s).toContain("gzip text");
    expect(s).toContain("### Sub point"); // deeper headings stay inside the section
    expect(s).toContain("# not a heading"); // fenced lines are not headings
    expect(s).not.toContain("Next Topic");
    expect(s).not.toContain("intro text");
  });

  it("works on CRLF files (the real sources use \r\n)", () => {
    const s = extractSection(lines.join("\r\n"), "compressing-and-decompressing-binary-data");
    expect(s).not.toBeNull();
    expect(s).toContain("gzip text");
    expect(s).not.toContain("\r");
    expect(s).not.toContain("Next Topic");
  });

  it("runs to the end for the last section and returns null for an unknown fragment", () => {
    expect(extractSection(md, "next-topic")).toBe("## Next Topic\nother text");
    expect(extractSection(md, "does-not-exist")).toBeNull();
    expect(extractSection("", "x")).toBeNull();
  });

  it("slugs punctuation like GitHub (drops it, keeps hyphens)", () => {
    expect(extractSection("## Step 1: Set-up (v2)\nbody", "step-1-set-up-v2")).toBe("## Step 1: Set-up (v2)\nbody");
  });
});
