// Claude route of the judge step. Run from Claude Code AFTER `node test/eval/judge.js prompts`:
//
//   Workflow({ scriptPath: 'test/eval/judge-workflow.js',
//              args: { dir: 'test/eval/judge-batches', batches: 2 } })
//   // optional: model (default 'haiku'), effort (default 'low')
//   then: node test/eval/judge.js ingest --judge-model <the model you used>
//
// Workflow scripts have no file or Node access, so each agent reads its own batch prompt
// file and writes its own reply file; ingest validates everything afterwards, so a sloppy
// reply costs one re-run of that batch, never a corrupt cache. One agent per batch: pick
// `--batch` in `judge.js prompts` so the agent count stays small.

export const meta = {
  name: 'judge-batches',
  description: 'Grade pooled search results (0-3) per test/eval/rubric.md; one agent per prompt batch',
  phases: [{ title: 'Judge', detail: 'one agent per batch; pinned model and effort' }],
}

const dir = String(args?.dir ?? 'test/eval/judge-batches').replace(/[\\/]+$/, '')
const batches = Number(args?.batches)
if (!Number.isInteger(batches) || batches < 1) throw new Error('args.batches (number of batch prompt files) is required')
const model = args?.model ?? 'haiku'
const effort = args?.effort ?? 'low'

const pad = (n) => String(n).padStart(3, '0')
const DONE = {
  type: 'object',
  properties: { batch: { type: 'integer' }, written: { type: 'boolean' } },
  required: ['batch', 'written'],
}

phase('Judge')
const results = await parallel(
  Array.from({ length: batches }, (_, i) => () => {
    const n = pad(i + 1)
    return agent(
      `Read the file ${dir}/batch-${n}.prompt.txt and follow the instructions in it exactly. ` +
        `Then write ONLY the JSON object it asks for (no code fence, no commentary) to ${dir}/batch-${n}.reply.txt, ` +
        `overwriting that file. Do not read or write any other file. Return {batch: ${i + 1}, written: true} when done.`,
      { label: `judge:${n}`, phase: 'Judge', schema: DONE, model, effort },
    )
  }),
)

const ok = results.filter((r) => r && r.written).length
log(`${ok}/${batches} batches written (model=${model}, effort=${effort})`)
return { model, effort, batches, written: ok }
