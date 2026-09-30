// Pure pieces of the judge step (no network, no LLM): prompt building, reply parsing and
// validation, token estimate. Shared by judge.js (CLI) and judge-workflow.js (Claude route).
//
// promptVersion is derived from the rubric text, so editing rubric.md automatically makes
// every cached judgment stale; nobody has to remember to bump a version.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const RUBRIC_PATH = join(__dirname, "rubric.md");
export const MAX_RATIONALE_CHARS = 200;

export function loadRubric(path = RUBRIC_PATH) {
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n").trim();
}

export function promptVersionOf(rubricText) {
  return "rubric-" + createHash("sha1").update(rubricText).digest("hex").slice(0, 8);
}

// JSON Schema for one batch reply (used by the Claude workflow and as the contract for local models).
export const REPLY_SCHEMA = {
  type: "object",
  properties: {
    judgments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "integer" },
          grade: { type: "integer", minimum: 0, maximum: 3 },
          rationale: { type: "string" },
        },
        required: ["id", "grade", "rationale"],
      },
    },
  },
  required: ["judgments"],
};

export function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Items are numbered 1..n within the batch; the reply refers to them by that number.
export function buildPrompt(rubric, batch) {
  const items = batch
    .map((t, i) => `### ITEM ${i + 1}\nQUERY: ${t.query}\n\nDOCUMENT:\n${t.text}`)
    .join("\n\n");
  return (
    `${rubric}\n\n` +
    `Grade the ${batch.length} item(s) below. Reply with ONLY a JSON object, no other text:\n` +
    `{"judgments":[{"id":1,"grade":0,"rationale":"..."}, ...]} with exactly one entry per item.\n\n` +
    items
  );
}

// Parse a model reply for `batch`. Returns { judgments: [{task, grade, rationale}], problems: [string] }.
// Accepts fenced or prose-wrapped JSON; never throws on bad model output, it reports problems instead.
export function parseReply(text, batch) {
  const problems = [];
  let obj = null;
  const s = String(text ?? "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try { obj = JSON.parse(s.slice(start, end + 1)); } catch { /* reported below */ }
  }
  if (!obj || !Array.isArray(obj.judgments)) {
    return { judgments: [], problems: ["reply is not a JSON object with a judgments array"] };
  }
  const seen = new Set();
  const judgments = [];
  for (const j of obj.judgments) {
    const id = Number(j?.id);
    if (!Number.isInteger(id) || id < 1 || id > batch.length) { problems.push(`unknown item id ${JSON.stringify(j?.id)}`); continue; }
    if (seen.has(id)) { problems.push(`duplicate item id ${id}`); continue; }
    if (!Number.isInteger(j.grade) || j.grade < 0 || j.grade > 3) { problems.push(`item ${id}: invalid grade ${JSON.stringify(j.grade)}`); continue; }
    seen.add(id);
    judgments.push({ task: batch[id - 1], grade: j.grade, rationale: String(j.rationale ?? "").slice(0, MAX_RATIONALE_CHARS) });
  }
  for (let id = 1; id <= batch.length; id++) if (!seen.has(id)) problems.push(`item ${id}: no valid judgment`);
  return { judgments, problems };
}

// Cache entry for a parsed judgment. judgedAt is stamped by the caller (scripts run in
// environments where the clock is unavailable).
export function toEntry({ task, grade, rationale }, { judgeModel, promptVersion, judgedAt }) {
  return {
    queryId: task.queryId, docId: task.docId, contentHash: task.contentHash,
    grade, rationale, judgeModel, promptVersion, judgedAt,
  };
}

// Rough input-token estimate (chars/4). Good enough for a quota guard, not for billing.
export function estimateTokens(rubric, tasks, batchSize) {
  const batches = Math.ceil(tasks.length / Math.max(1, batchSize));
  const chars = batches * (rubric.length + 400) + tasks.reduce((n, t) => n + t.text.length + t.query.length + 40, 0);
  return { batches, inputTokens: Math.ceil(chars / 4) };
}
