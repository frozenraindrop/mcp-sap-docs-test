// Label audit: how far can the AI judge be trusted? Samples judged items, lets a human (or a second
// AI model) regrade them blind, and reports agreement. See IMPLEMENTATION-PLAN-judged-pools.md, Step 6.
//
//   node test/eval/audit.js sample [--n 50] [--seed 12345] [--dir test/eval/runs] [--out test/eval/audit] [--force]
//                                  [--judgments path/to/judgments.json]
//       -> audit/sheet.md (grade this: AI grades hidden)  +  audit/key.json (answers; don't open before grading)
//   node test/eval/audit.js report [--out test/eval/audit]                  human grades in sheet.md vs the judge
//   node test/eval/audit.js ai-prompts [--out ...] [--batch 10]             prompts for a second AI grader
//   node test/eval/audit.js report --ai-replies test/eval/audit/ai-batches  second AI vs the judge
//
// Partial grading is fine: leave GRADE blank to skip an item, come back later, run `report` any time.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadJudgments } from "./judgments.js";
import { loadRubric, parseReply } from "./judge-core.js";
import { writePrompts } from "./judge.js";
import { loadRunFiles } from "./pool.js";
import { seededRng } from "./stats.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GRADE_LINE = /^YOUR GRADE \(0-3\):[ \t]*(.*)$/gm;
const ITEM_HEAD = /^## Item \d+ \(([0-9a-f]{8})\)[ \t]*$/m;

export const itemId = (queryId, docId, contentHash) =>
  createHash("sha1").update(`${queryId}\u0000${docId}\u0000${contentHash}`).digest("hex").slice(0, 8);

// Usable judgments (current hash + prompt version, text available), sampled round-robin across the AI's
// grades so the rare 0s and 3s are not drowned out by the common middle grades. Seeded, reproducible.
export function sampleItems({ entries, poolDocs, texts, queryText, promptVersion, n = 50, seed = 12345 }) {
  const rng = seededRng(seed);
  const byGrade = new Map();
  for (const e of entries) {
    if (e.promptVersion !== promptVersion || poolDocs[e.docId] !== e.contentHash || !texts[e.docId]) continue;
    if (!byGrade.has(e.grade)) byGrade.set(e.grade, []);
    byGrade.get(e.grade).push(e);
  }
  for (const list of byGrade.values()) {
    list.sort((a, b) => (a.queryId + a.docId < b.queryId + b.docId ? -1 : 1));
    for (let i = list.length - 1; i > 0; i--) { const j = (rng() * (i + 1)) | 0; [list[i], list[j]] = [list[j], list[i]]; }
  }
  const picked = [];
  const grades = [...byGrade.keys()].sort();
  while (picked.length < n && grades.some((g) => byGrade.get(g).length)) {
    for (const g of grades) if (picked.length < n && byGrade.get(g).length) picked.push(byGrade.get(g).shift());
  }
  // Shuffle the final order so the sheet does not run 0,1,2,3,0,1,2,3.
  for (let i = picked.length - 1; i > 0; i--) { const j = (rng() * (i + 1)) | 0; [picked[i], picked[j]] = [picked[j], picked[i]]; }
  return picked.map((e) => ({
    id: itemId(e.queryId, e.docId, e.contentHash),
    queryId: e.queryId, docId: e.docId, contentHash: e.contentHash, aiGrade: e.grade,
    query: queryText[e.queryId] ?? "", text: texts[e.docId],
  }));
}

// The sheet shows the rubric, the query and the document; never the AI's grade or rationale.
export function renderSheet(items, rubric) {
  const head = `# Label audit: grade each item 0-3\n\nUse this marking guide (the AI judge used the same one). Type the digit after ` +
    `"YOUR GRADE (0-3):". Leave it blank to skip an item. Partial grading is fine.\n\n~~~text\n${rubric}\n~~~\n`;
  const body = items.map((it, i) =>
    `\n---\n\n## Item ${i + 1} (${it.id})\n\nQUERY: ${it.query}\n\n~~~~text\n${it.text}\n~~~~\n\nYOUR GRADE (0-3): \n`).join("");
  return head + body;
}

// -> { grades: Map(id -> 0..3), invalid: [id], blank: number }
export function parseSheet(markdown) {
  const grades = new Map();
  const invalid = [];
  let blank = 0;
  const parts = String(markdown).split(/^(?=## Item \d+ \()/m).slice(1);
  for (const part of parts) {
    const id = ITEM_HEAD.exec(part)?.[1];
    if (!id) continue;
    const matches = [...part.matchAll(GRADE_LINE)];
    const raw = matches.length ? matches[matches.length - 1][1].trim() : "";
    if (raw === "") blank++;
    else if (/^[0-3]$/.test(raw)) grades.set(id, Number(raw));
    else invalid.push(id);
  }
  return { grades, invalid, blank };
}

// pairs: [{ human, ai }] -> agreement summary. `human` is whoever regraded (a person or a second model).
export function agreement(pairs) {
  const n = pairs.length;
  const matrix = Array.from({ length: 4 }, () => [0, 0, 0, 0]); // matrix[human][ai]
  let exact = 0, within1 = 0, rel = 0, diff = 0;
  for (const { human, ai } of pairs) {
    matrix[human][ai]++;
    if (human === ai) exact++;
    if (Math.abs(human - ai) <= 1) within1++;
    if ((human >= 2) === (ai >= 2)) rel++;
    diff += ai - human;
  }
  const r = (x) => (n ? x / n : NaN);
  return { n, exact: r(exact), within1: r(within1), relevant: r(rel), bias: r(diff), matrix };
}

export function formatAgreement(a, who) {
  if (!a.n) return `No ${who} grades found yet.`;
  const p = (x) => (x * 100).toFixed(0) + "%";
  const bias = a.bias > 0.15 ? "the AI judge is more generous" : a.bias < -0.15 ? "the AI judge is stricter" : "no clear lean";
  const rows = a.matrix.map((row, h) => `  ${who} ${h} | ${row.map((c) => String(c).padStart(3)).join(" ")}`);
  return [
    `Agreement between ${who} and the AI judge on ${a.n} item(s):`,
    `  exact match        ${p(a.exact)}`,
    `  within one grade   ${p(a.within1)}`,
    `  relevant (>=2) agree ${p(a.relevant)}   <- decides P@5 / any>=2@5`,
    `  mean(AI - ${who})  ${a.bias >= 0 ? "+" : ""}${a.bias.toFixed(2)}   (${bias})`,
    `Confusion matrix (rows = ${who}, columns = AI grade 0 1 2 3):`,
    ...rows,
  ].join("\n");
}

// ── CLI ──────────────────────────────────────────────────────────────────────
const flag = (args, f) => { const i = args.indexOf(f); return i === -1 ? undefined : args[i + 1]; };

function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const out = resolve(flag(args, "--out") ?? join(__dirname, "audit"));
  const sheetPath = join(out, "sheet.md");
  const keyPath = join(out, "key.json");

  if (cmd === "sample") {
    const dir = resolve(flag(args, "--dir") ?? join(__dirname, "runs"));
    const poolPath = join(dir, "pool.json"), textsPath = join(dir, "texts.json");
    if (!existsSync(poolPath) || !existsSync(textsPath)) throw new Error(`${dir} needs pool.json and texts.json (run pool.js first)`);
    if (existsSync(sheetPath) && !args.includes("--force")) {
      const { grades } = parseSheet(readFileSync(sheetPath, "utf8"));
      if (grades.size) throw new Error(`${sheetPath} already holds ${grades.size} of your grades; refusing to overwrite (use --force to discard them).`);
    }
    const pool = JSON.parse(readFileSync(poolPath, "utf8"));
    const queryText = {};
    for (const r of loadRunFiles(dir)) for (const q of r.queries) queryText[q.queryId] = q.query;
    const items = sampleItems({
      entries: loadJudgments(resolve(flag(args, "--judgments") ?? join(__dirname, "judgments.json"))), poolDocs: pool.docs,
      texts: JSON.parse(readFileSync(textsPath, "utf8")), queryText, promptVersion: pool.promptVersion,
      n: Number(flag(args, "--n") ?? 50), seed: Number(flag(args, "--seed") ?? 12345),
    });
    if (!items.length) throw new Error("no judged items to sample (judge some pooled docs first)");
    mkdirSync(out, { recursive: true });
    writeFileSync(sheetPath, renderSheet(items, loadRubric()));
    writeFileSync(keyPath, JSON.stringify({ promptVersion: pool.promptVersion, items }, null, 2) + "\n");
    console.log(`Sampled ${items.length} item(s).\nGrade them in: ${sheetPath}\nThen run: node test/eval/audit.js report\n(Don't open key.json first: it holds the AI's grades.)`);
    return;
  }

  if (!existsSync(keyPath)) throw new Error(`${keyPath} not found. Run: audit.js sample`);
  const key = JSON.parse(readFileSync(keyPath, "utf8"));

  if (cmd === "ai-prompts") {
    const tasksFile = { promptVersion: key.promptVersion, rubric: loadRubric(), tasks: key.items };
    const dir = join(out, "ai-batches");
    const r = writePrompts({ tasksFile, batchSize: Number(flag(args, "--batch") ?? 10), dir });
    console.log(`Wrote ${r.batches} prompt file(s) for ${r.tasks} item(s) to ${dir}.\nHave a DIFFERENT (ideally stronger) model write batch-NNN.reply.txt for each, then: audit.js report --ai-replies ${dir}`);
    return;
  }

  if (cmd === "report") {
    const repliesDir = flag(args, "--ai-replies");
    let pairs = [];
    let who = "you", note = "";
    if (repliesDir) {
      who = "2nd AI";
      const dir = resolve(repliesDir);
      const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
      const byTriple = new Map(key.items.map((it) => [`${it.queryId}\u0000${it.docId}\u0000${it.contentHash}`, it]));
      manifest.batches.forEach((batch, i) => {
        const file = join(dir, `batch-${String(i + 1).padStart(3, "0")}.reply.txt`);
        if (!existsSync(file)) return;
        const { judgments, problems } = parseReply(readFileSync(file, "utf8"), batch);
        problems.forEach((p) => console.warn(`  batch ${i + 1}: ${p}`));
        for (const j of judgments) {
          const it = byTriple.get(`${j.task.queryId}\u0000${j.task.docId}\u0000${j.task.contentHash}`);
          if (it) pairs.push({ human: j.grade, ai: it.aiGrade });
        }
      });
    } else {
      if (!existsSync(sheetPath)) throw new Error(`${sheetPath} not found. Run: audit.js sample`);
      const { grades, invalid, blank } = parseSheet(readFileSync(sheetPath, "utf8"));
      const byId = new Map(key.items.map((it) => [it.id, it]));
      for (const [id, g] of grades) if (byId.has(id)) pairs.push({ human: g, ai: byId.get(id).aiGrade });
      note = `${grades.size} graded, ${blank} still blank of ${key.items.length} sampled` + (invalid.length ? `; ${invalid.length} unreadable (use a digit 0-3): ${invalid.join(", ")}` : "");
    }
    if (note) console.log(note);
    console.log(formatAgreement(agreement(pairs), who));
    return;
  }

  console.log("usage: audit.js sample | report | ai-prompts   (see header comment)");
  process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (err) { console.error("Fatal:", err.message); process.exit(1); }
}
