import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error plain JS modules shared with the eval scripts
import { buildPrompt, estimateTokens, loadRubric, parseReply, promptVersionOf, toEntry } from "./eval/judge-core.js";
// @ts-expect-error plain JS module
import { ingestReplies, runLocal, writePrompts } from "./eval/judge.js";
// @ts-expect-error plain JS module
import { lookup } from "./eval/judgments.js";

const task = (n: number) => ({ queryId: `q${n}`, query: `question ${n}`, docId: `d${n}`, contentHash: `h${n}`, via: "fetch", text: `Title: T${n}\nSource: d${n}\n\nbody ${n}` });
const batch = [task(1), task(2), task(3)];
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "judge-")); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
const reply = (items: unknown[]) => JSON.stringify({ judgments: items });

describe("judge-core", () => {
  it("rubric.md loads and promptVersion tracks its text", () => {
    const r = loadRubric();
    expect(r).toContain("Grades:");
    expect(promptVersionOf(r)).toMatch(/^rubric-[0-9a-f]{8}$/);
    expect(promptVersionOf(r)).toBe(promptVersionOf(r));
    expect(promptVersionOf(r + " edited")).not.toBe(promptVersionOf(r));
  });

  it("buildPrompt includes rubric, every item numbered, query and document text", () => {
    const p = buildPrompt("RUBRIC", batch);
    expect(p.startsWith("RUBRIC")).toBe(true);
    for (const n of [1, 2, 3]) expect(p).toContain(`### ITEM ${n}\nQUERY: question ${n}`);
    expect(p).toContain("body 3");
  });

  it("parseReply accepts clean, fenced and prose-wrapped JSON", () => {
    const good = reply([{ id: 1, grade: 3, rationale: "a" }, { id: 2, grade: 0, rationale: "b" }, { id: 3, grade: 2, rationale: "c" }]);
    for (const text of [good, "```json\n" + good + "\n```", "Sure! Here you go:\n" + good + "\nHope it helps."]) {
      const r = parseReply(text, batch);
      expect(r.problems).toEqual([]);
      expect(r.judgments.map((j: { grade: number }) => j.grade)).toEqual([3, 0, 2]);
      expect(r.judgments[0].task).toBe(batch[0]);
    }
  });

  it("parseReply reports bad grades, unknown/duplicate ids and missing items without throwing", () => {
    const r = parseReply(reply([{ id: 1, grade: 4, rationale: "" }, { id: 9, grade: 1, rationale: "" }, { id: 2, grade: 1, rationale: "x" }, { id: 2, grade: 2, rationale: "y" }]), batch);
    expect(r.judgments).toHaveLength(1);
    expect(r.judgments[0].grade).toBe(1);
    const text = r.problems.join("|");
    expect(text).toContain("invalid grade");
    expect(text).toContain("unknown item id");
    expect(text).toContain("duplicate item id 2");
    expect(text).toContain("item 1: no valid judgment");
    expect(text).toContain("item 3: no valid judgment");
    expect(parseReply("not json at all", batch).problems[0]).toMatch(/not a JSON object/);
    expect(parseReply(undefined, batch).judgments).toEqual([]);
  });

  it("parseReply truncates very long rationales", () => {
    const r = parseReply(reply([{ id: 1, grade: 1, rationale: "x".repeat(1000) }]), [task(1)]);
    expect(r.judgments[0].rationale.length).toBe(200);
  });

  it("estimateTokens grows with tasks and counts batches", () => {
    const a = estimateTokens("R".repeat(400), [task(1)], 10);
    const b = estimateTokens("R".repeat(400), batch, 2);
    expect(a.batches).toBe(1);
    expect(b.batches).toBe(2);
    expect(b.inputTokens).toBeGreaterThan(a.inputTokens);
  });

  it("toEntry maps a judgment onto a cache entry", () => {
    const e = toEntry({ task: batch[0], grade: 2, rationale: "r" }, { judgeModel: "m", promptVersion: "v", judgedAt: "t" });
    expect(e).toEqual({ queryId: "q1", docId: "d1", contentHash: "h1", grade: 2, rationale: "r", judgeModel: "m", promptVersion: "v", judgedAt: "t" });
  });
});

describe("judge.js: prompts -> replies -> ingest", () => {
  const tasksFile = { promptVersion: "rubric-test", rubric: "RUBRIC", tasks: batch };

  it("writePrompts respects batch size and max-tasks, and ingest round-trips into the cache", () => {
    const dir = tmp();
    expect(writePrompts({ tasksFile, batchSize: 2, dir })).toEqual({ batches: 2, tasks: 3 });
    expect(writePrompts({ tasksFile, batchSize: 2, maxTasks: 1, dir })).toEqual({ batches: 1, tasks: 1 });
    writePrompts({ tasksFile, batchSize: 2, dir });
    writeFileSync(join(dir, "batch-001.reply.txt"), reply([{ id: 1, grade: 3, rationale: "a" }, { id: 2, grade: 1, rationale: "b" }]));
    // batch 2 has no reply yet
    const { entries, report } = ingestReplies({ dir, judgeModel: "haiku", judgedAt: "2026-09-30T00:00:00Z", entries: [] });
    expect(report).toMatchObject({ ingested: 2, missingReplies: 1, problems: [] });
    const hit = lookup(entries, { queryId: "q1", docId: "d1", contentHash: "h1", promptVersion: "rubric-test" });
    expect(hit.status).toBe("hit");
    expect(hit.entry).toMatchObject({ grade: 3, judgeModel: "haiku" });
    expect(lookup(entries, { queryId: "q3", docId: "d3", contentHash: "h3", promptVersion: "rubric-test" }).status).toBe("miss");
  });

  it("writePrompts clears replies and prompts left over from an earlier round", () => {
    const dir = tmp();
    writePrompts({ tasksFile, batchSize: 1, dir }); // 3 batches
    writeFileSync(join(dir, "batch-001.reply.txt"), reply([{ id: 1, grade: 3, rationale: "old round" }]));
    writeFileSync(join(dir, "batch-003.reply.txt"), reply([{ id: 1, grade: 3, rationale: "old round" }]));
    writeFileSync(join(dir, "notes.txt"), "keep me");
    writePrompts({ tasksFile: { ...tasksFile, tasks: [task(9)] }, batchSize: 1, dir }); // 1 new batch
    const { entries, report } = ingestReplies({ dir, judgeModel: "m", judgedAt: "t", entries: [] });
    expect(entries).toEqual([]); // the old batch-001 reply must not answer the new batch 001
    expect(report).toMatchObject({ ingested: 0, missingReplies: 1 });
    expect(readFileSync(join(dir, "notes.txt"), "utf8")).toBe("keep me"); // unrelated files untouched
  });

  it("ingest keeps good items and reports the bad ones", () => {
    const dir = tmp();
    writePrompts({ tasksFile, batchSize: 3, dir });
    writeFileSync(join(dir, "batch-001.reply.txt"), reply([{ id: 1, grade: 2, rationale: "" }, { id: 2, grade: 7, rationale: "" }]));
    const { entries, report } = ingestReplies({ dir, judgeModel: "m", judgedAt: "t", entries: [] });
    expect(entries).toHaveLength(1);
    expect(report.problems.join("|")).toContain("invalid grade");
    expect(readFileSync(join(dir, "manifest.json"), "utf8")).toContain("rubric-test");
  });
});

describe("judge.js: local backend (mock OpenAI-compatible server)", () => {
  async function withServer(handler: (body: any, n: number) => string, fn: (endpoint: string) => Promise<void>) {
    let calls = 0;
    const server = createServer((req, res) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        const content = handler(JSON.parse(data), ++calls);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ choices: [{ message: { content } }] }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try { await fn(`http://127.0.0.1:${(server.address() as any).port}`); } finally { server.close(); }
  }
  const tasksFile = { promptVersion: "rubric-test", rubric: "RUBRIC", tasks: batch };

  it("judges each batch and records the model name", async () => {
    await withServer(
      (body) => { expect(body.model).toBe("tiny"); expect(body.temperature).toBe(0); return reply([{ id: 1, grade: 2, rationale: "ok" }]); },
      async (endpoint) => {
        const saved: number[] = [];
        const { entries, report } = await runLocal({ tasksFile, endpoint, model: "tiny", batchSize: 1, entries: [], judgedAt: "t", onBatch: (e: unknown[]) => saved.push(e.length) });
        expect(report).toMatchObject({ ingested: 3, problems: [] });
        expect(saved).toEqual([1, 2, 3]); // progress saved after every batch
        expect(entries.every((e: { judgeModel: string }) => e.judgeModel === "tiny")).toBe(true);
      },
    );
  });

  it("retries a batch once when the first reply is unusable", async () => {
    await withServer(
      (_b, n) => (n === 1 ? "I cannot help with that" : reply([{ id: 1, grade: 1, rationale: "second try" }])),
      async (endpoint) => {
        const { report, entries } = await runLocal({ tasksFile, endpoint, model: "tiny", batchSize: 1, maxTasks: 1, entries: [], judgedAt: "t" });
        expect(report.ingested).toBe(1);
        expect(report.problems).toEqual([]);
        expect(entries[0].rationale).toBe("second try");
      },
    );
  });

  it("reports problems (and keeps going) if the retry also fails", async () => {
    await withServer(() => "nope", async (endpoint) => {
      const { report } = await runLocal({ tasksFile, endpoint, model: "tiny", batchSize: 1, maxTasks: 1, entries: [], judgedAt: "t" });
      expect(report.ingested).toBe(0);
      expect(report.problems.length).toBeGreaterThan(0);
    });
  });
});
