// Judge step of the judged-pool eval. Reads tasks.json (written by pool.js) and writes
// graded judgments into judgments.json. Two ways to get the grades:
//
//   Claude route (default):  prompts  ->  judge-workflow.js (Claude Code)  ->  ingest
//   Local route (optional):  local --model <name>   (any OpenAI-compatible endpoint, e.g. Ollama)
//
//   node test/eval/judge.js estimate [--batch 10] [--max-tasks N]
//   node test/eval/judge.js prompts  [--batch 10] [--max-tasks N]      writes judge-batches/
//   node test/eval/judge.js ingest --judge-model <label> [--replies judge-batches]
//   node test/eval/judge.js local --model qwen2.5:3b [--endpoint http://localhost:11434]
//                                 [--batch 1] [--max-tasks N] [--yes]
//
// The LLM is always a swappable step between two files, so scoring never cares who judged.

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadJudgments, saveJudgments, upsert } from "./judgments.js";
import { buildPrompt, chunk, estimateTokens, loadRubric, parseReply, promptVersionOf, toEntry } from "./judge-core.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TASKS_PATH = join(__dirname, "tasks.json");
const JUDGMENTS_PATH = join(__dirname, "judgments.json");
const BATCH_DIR = join(__dirname, "judge-batches");
const DEFAULT_BATCH = 10;

const pad = (n) => String(n).padStart(3, "0");

function loadTasks(path = TASKS_PATH, rubric = loadRubric()) {
  if (!existsSync(path)) throw new Error(`${path} not found. Run pool.js first.`);
  const file = JSON.parse(readFileSync(path, "utf8"));
  const current = promptVersionOf(rubric);
  if (file.promptVersion !== current) {
    throw new Error(`tasks.json was built for ${file.promptVersion} but rubric.md is ${current}. Re-run pool.js.`);
  }
  return { ...file, promptVersion: current, rubric };
}

// ── prompts: write one prompt file per batch plus a manifest ─────────────────
export function writePrompts({ tasksFile, batchSize = DEFAULT_BATCH, maxTasks = Infinity, dir = BATCH_DIR }) {
  const tasks = tasksFile.tasks.slice(0, maxTasks);
  const batches = chunk(tasks, batchSize);
  mkdirSync(dir, { recursive: true });
  // A leftover batch-001.reply.txt from an earlier round would be ingested as the answer to
  // the NEW batch 001 (same number, different items), so start from an empty directory.
  for (const f of readdirSync(dir)) if (/^batch-\d+\.(prompt|reply)\.txt$/.test(f) || f === "manifest.json") unlinkSync(join(dir, f));
  batches.forEach((b, i) => writeFileSync(join(dir, `batch-${pad(i + 1)}.prompt.txt`), buildPrompt(tasksFile.rubric, b)));
  const manifest = {
    promptVersion: tasksFile.promptVersion,
    batches: batches.map((b) => b.map(({ queryId, docId, contentHash }) => ({ queryId, docId, contentHash }))),
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return { batches: batches.length, tasks: tasks.length };
}

// ── ingest: parse batch-NNN.reply.txt files, validate, upsert into the cache ─
export function ingestReplies({ dir = BATCH_DIR, judgeModel, judgedAt, entries }) {
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  let out = entries;
  const report = { ingested: 0, missingReplies: 0, problems: [] };
  manifest.batches.forEach((batch, i) => {
    const file = join(dir, `batch-${pad(i + 1)}.reply.txt`);
    if (!existsSync(file)) { report.missingReplies++; return; }
    const { judgments, problems } = parseReply(readFileSync(file, "utf8"), batch);
    problems.forEach((p) => report.problems.push(`batch ${pad(i + 1)}: ${p}`));
    for (const j of judgments) {
      out = upsert(out, toEntry(j, { judgeModel, promptVersion: manifest.promptVersion, judgedAt }));
      report.ingested++;
    }
  });
  return { entries: out, report };
}

// ── local: call an OpenAI-compatible endpoint ────────────────────────────────
async function askLocal({ endpoint, model, prompt, fetchImpl = fetch }) {
  const res = await fetchImpl(`${endpoint.replace(/\/$/, "")}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model, stream: false, temperature: 0,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`local judge HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  return body?.choices?.[0]?.message?.content ?? "";
}

// Judges tasks one batch at a time; retries a batch once if its reply is unusable.
// `onBatch(entries)` is called after every batch so progress survives an interruption.
export async function runLocal({ tasksFile, endpoint, model, batchSize = 1, maxTasks = Infinity, entries, judgedAt, fetchImpl, onBatch }) {
  let out = entries;
  const report = { ingested: 0, problems: [] };
  for (const [i, batch] of chunk(tasksFile.tasks.slice(0, maxTasks), batchSize).entries()) {
    const prompt = buildPrompt(tasksFile.rubric, batch);
    let parsed = parseReply(await askLocal({ endpoint, model, prompt, fetchImpl }), batch);
    if (parsed.problems.length) parsed = parseReply(await askLocal({ endpoint, model, prompt, fetchImpl }), batch); // one retry
    parsed.problems.forEach((p) => report.problems.push(`batch ${pad(i + 1)}: ${p}`));
    for (const j of parsed.judgments) {
      out = upsert(out, toEntry(j, { judgeModel: model, promptVersion: tasksFile.promptVersion, judgedAt }));
      report.ingested++;
    }
    onBatch?.(out);
  }
  return { entries: out, report };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
const flag = (args, f) => { const i = args.indexOf(f); return i === -1 ? undefined : args[i + 1]; };

async function confirm(question) {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(question + " [y/N] ")).trim().toLowerCase();
  rl.close();
  return a === "y" || a === "yes";
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const batchSize = Number(flag(args, "--batch") ?? (cmd === "local" ? 1 : DEFAULT_BATCH));
  const maxTasks = Number(flag(args, "--max-tasks") ?? Infinity);

  if (cmd === "estimate" || cmd === "prompts" || cmd === "local") {
    const tasksFile = loadTasks();
    const tasks = tasksFile.tasks.slice(0, maxTasks);
    const est = estimateTokens(tasksFile.rubric, tasks, batchSize);
    console.log(`${tasks.length} task(s) to judge in ${est.batches} batch(es), about ${est.inputTokens.toLocaleString()} input tokens (rough chars/4 estimate).`);
    if (cmd === "estimate") return;
    if (cmd === "prompts") {
      const r = writePrompts({ tasksFile, batchSize, maxTasks });
      console.log(`Wrote ${r.batches} prompt file(s) + manifest.json to ${BATCH_DIR}`);
      console.log("Next: run judge-workflow.js (or any model) to produce batch-NNN.reply.txt, then: judge.js ingest --judge-model <label>");
      return;
    }
    const model = flag(args, "--model");
    if (!model) throw new Error("local needs --model <name>");
    const endpoint = flag(args, "--endpoint") ?? "http://localhost:11434";
    if (!args.includes("--yes") && !(await confirm(`Judge with local model "${model}" at ${endpoint}?`))) {
      console.log("Aborted (pass --yes to skip the prompt).");
      return;
    }
    const { entries, report } = await runLocal({
      tasksFile, endpoint, model, batchSize, maxTasks,
      entries: loadJudgments(JUDGMENTS_PATH), judgedAt: new Date().toISOString(),
      onBatch: (e) => saveJudgments(JUDGMENTS_PATH, e),
    });
    saveJudgments(JUDGMENTS_PATH, entries);
    console.log(`Ingested ${report.ingested}; ${report.problems.length} problem(s).`);
    report.problems.slice(0, 10).forEach((p) => console.log("  " + p));
    return;
  }

  if (cmd === "ingest") {
    const judgeModel = flag(args, "--judge-model");
    if (!judgeModel) throw new Error("ingest needs --judge-model <label> (what actually judged, e.g. claude-haiku-4-5)");
    const dir = resolve(flag(args, "--replies") ?? BATCH_DIR);
    const { entries, report } = ingestReplies({ dir, judgeModel, judgedAt: new Date().toISOString(), entries: loadJudgments(JUDGMENTS_PATH) });
    saveJudgments(JUDGMENTS_PATH, entries);
    console.log(`Ingested ${report.ingested} judgment(s); ${report.missingReplies} batch(es) without a reply; ${report.problems.length} problem(s).`);
    report.problems.slice(0, 10).forEach((p) => console.log("  " + p));
    return;
  }

  console.log("usage: judge.js estimate|prompts|ingest|local  (see header comment)");
  process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error("Fatal:", err.message); process.exit(1); });
}
