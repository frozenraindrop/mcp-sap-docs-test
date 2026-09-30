import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error plain JS modules shared with the eval scripts
import { agreement, formatAgreement, itemId, parseSheet, renderSheet, sampleItems } from "./eval/audit.js";

const PV = "rubric-test";
const docs = ["d1", "d2", "d3", "d4", "d5", "d6"];
const poolDocs = Object.fromEntries(docs.map((d) => [d, `h-${d}`]));
const texts = Object.fromEntries(docs.map((d) => [d, `text of ${d}`]));
const queryText = { q1: "question one" };
const entry = (docId: string, grade: number, extra: object = {}) => ({
  queryId: "q1", docId, contentHash: poolDocs[docId as keyof typeof poolDocs], grade,
  rationale: `SECRET rationale for ${docId}`, judgeModel: "m", promptVersion: PV, judgedAt: "t", ...extra,
});
const entries = [entry("d1", 0), entry("d2", 0), entry("d3", 1), entry("d4", 2), entry("d5", 3), entry("d6", 3)];
const sample = (over: object = {}) => sampleItems({ entries, poolDocs, texts, queryText, promptVersion: PV, n: 4, ...over });

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe("audit: sampleItems", () => {
  it("samples round-robin across AI grades, so rare grades are represented", () => {
    const items = sample();
    expect(items).toHaveLength(4);
    expect(items.map((i: { aiGrade: number }) => i.aiGrade).sort()).toEqual([0, 1, 2, 3]);
    expect(items[0]).toMatchObject({ query: "question one" });
    expect(items[0].id).toBe(itemId(items[0].queryId, items[0].docId, items[0].contentHash));
  });

  it("is reproducible for a seed and never repeats an item", () => {
    expect(sample({ seed: 7 })).toEqual(sample({ seed: 7 }));
    const all = sample({ n: 99 });
    expect(all).toHaveLength(6);
    expect(new Set(all.map((i: { id: string }) => i.id)).size).toBe(6);
  });

  it("skips stale judgments, other prompt versions and docs without text", () => {
    const e = [entry("d1", 3, { contentHash: "old" }), entry("d2", 3, { promptVersion: "other" }), entry("d3", 3), entry("d4", 2)];
    const items = sampleItems({ entries: e, poolDocs, texts: { d3: "t3" }, queryText, promptVersion: PV, n: 10 });
    expect(items.map((i: { docId: string }) => i.docId)).toEqual(["d3"]);
  });
});

describe("audit: sheet", () => {
  const items = sample();
  const sheet = renderSheet(items, "THE RUBRIC");

  it("shows rubric, query and document but never the AI's grade or rationale", () => {
    expect(sheet).toContain("THE RUBRIC");
    expect(sheet).toContain("QUERY: question one");
    expect(sheet).toContain(items[0].text);
    expect(sheet).not.toContain("SECRET");
    expect(sheet).not.toMatch(/aiGrade/);
    expect((sheet.match(/^YOUR GRADE \(0-3\):/gm) ?? []).length).toBe(4);
  });

  it("parses filled, blank and unreadable grades", () => {
    const lines = sheet.split("\n");
    let seen = 0;
    const filled = lines.map((l) => {
      if (!l.startsWith("YOUR GRADE")) return l;
      seen++;
      return seen === 1 ? "YOUR GRADE (0-3): 2" : seen === 2 ? "YOUR GRADE (0-3): banana" : seen === 3 ? "YOUR GRADE (0-3):   " : "YOUR GRADE (0-3): 0";
    }).join("\n");
    const { grades, invalid, blank } = parseSheet(filled);
    expect(grades.get(items[0].id)).toBe(2);
    expect(grades.get(items[3].id)).toBe(0);
    expect(invalid).toEqual([items[1].id]);
    expect(blank).toBe(1);
    expect(grades.size).toBe(2);
  });

  it("a document containing a line like 'YOUR GRADE' cannot override the real one (last line wins)", () => {
    const tricky = renderSheet([{ ...items[0], text: "YOUR GRADE (0-3): 3" }], "R").replace(/YOUR GRADE \(0-3\): \n$/, "YOUR GRADE (0-3): 1\n");
    expect(parseSheet(tricky).grades.get(items[0].id)).toBe(1);
  });
});

describe("audit: agreement", () => {
  const pairs = [{ human: 3, ai: 3 }, { human: 2, ai: 3 }, { human: 0, ai: 1 }, { human: 1, ai: 3 }];

  it("matches hand-computed values", () => {
    const a = agreement(pairs);
    expect(a.n).toBe(4);
    expect(a.exact).toBeCloseTo(1 / 4, 10);
    expect(a.within1).toBeCloseTo(3 / 4, 10);
    expect(a.relevant).toBeCloseTo(3 / 4, 10); // (1,3) disagrees on relevant vs not
    expect(a.bias).toBeCloseTo(1, 10); // AI - human = 0,+1,+1,+2
    expect(a.matrix[1][3]).toBe(1);
    expect(a.matrix[3][3]).toBe(1);
  });

  it("formats a readable summary, and handles no grades", () => {
    const text = formatAgreement(agreement(pairs), "you");
    expect(text).toContain("exact match        25%");
    expect(text).toContain("the AI judge is more generous");
    expect(formatAgreement(agreement([]), "you")).toContain("No you grades found");
    expect(formatAgreement(agreement([{ human: 2, ai: 2 }]), "you")).toContain("no clear lean");
  });
});

describe("audit CLI: sample -> grade -> report", () => {
  it("protects grades already typed, and reports agreement from the sheet", () => {
    const root = mkdtempSync(join(tmpdir(), "audit-"));
    dirs.push(root);
    const runs = join(root, "runs");
    mkdirSync(runs);
    writeFileSync(join(runs, "pool.json"), JSON.stringify({ promptVersion: PV, maxChars: 1500, docs: poolDocs }));
    writeFileSync(join(runs, "texts.json"), JSON.stringify(texts));
    writeFileSync(join(runs, "v.json"), JSON.stringify({ variant: "v", queries: [{ queryId: "q1", query: "question one", results: docs.map((id) => ({ id })) }] }));
    const judgments = join(root, "judgments.json");
    writeFileSync(judgments, JSON.stringify(entries));
    const out = join(root, "audit");
    const script = join(__dirname, "eval", "audit.js");
    const run = (...a: string[]) => execFileSync("node", [script, ...a], { encoding: "utf8" });

    run("sample", "--dir", runs, "--out", out, "--judgments", judgments, "--n", "4");
    const key = JSON.parse(readFileSync(join(out, "key.json"), "utf8"));
    expect(key.items).toHaveLength(4);

    // Human agrees with the AI on every item they grade, but leaves one blank.
    const byId = new Map(key.items.map((it: { id: string; aiGrade: number }) => [it.id, it.aiGrade]));
    let sheet = readFileSync(join(out, "sheet.md"), "utf8");
    sheet = sheet.replace(/^## Item (\d+) \(([0-9a-f]{8})\)([\s\S]*?)YOUR GRADE \(0-3\): \n/gm, (m, n, id, mid) =>
      n === "4" ? m : `## Item ${n} (${id})${mid}YOUR GRADE (0-3): ${byId.get(id)}\n`);
    writeFileSync(join(out, "sheet.md"), sheet);

    const report = run("report", "--out", out);
    expect(report).toContain("3 graded, 1 still blank of 4 sampled");
    expect(report).toContain("exact match        100%");

    expect(() => run("sample", "--dir", runs, "--out", out, "--judgments", judgments)).toThrow(/refusing to overwrite/);
    expect(() => run("sample", "--dir", runs, "--out", out, "--judgments", judgments, "--force")).not.toThrow();
  });
});
