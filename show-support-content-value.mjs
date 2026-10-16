#!/usr/bin/env node
/**
 * Show SUPPORT_CONTENT wiki entries that PR #69 would add
 * Evaluates: Are these docs actually valuable?
 */

import { search } from './dist/src/lib/search.js';

const EVALUATION_QUERIES = [
  'How do I integrate SAP Forms (SO10) with Adobe Document Services',
  'RAP behavior implementation for managed entities',
  'How to configure document splitting in SAP S/4HANA',
  'Best practices for CDS view design',
  'BDEF behavior definition patterns'
];

async function evaluateValue() {
  console.log(`
╔─────────────────────────────────────────────────────────────────────╗
║  RIGOROUS VALUE ASSESSMENT: What docs does PR #69 actually add?    ║
║  Question: Are those SUPPORT_CONTENT wiki entries actually useful? ║
╚─────────────────────────────────────────────────────────────────────╝
  `);

  for (const query of EVALUATION_QUERIES) {
    console.log(`\n${'═'.repeat(75)}`);
    console.log(`QUERY: "${query}"`);
    console.log(`${'═'.repeat(75)}`);

    try {
      const results = await search(query, { k: 20, includeOnline: true });

      // Separate official from support content
      const official = [];
      const supportContent = [];

      results.forEach(r => {
        if (r.path?.includes('/SUPPORT_CONTENT/')) {
          supportContent.push(r);
        } else if (r.sourceKind === 'sap_help') {
          official.push(r);
        }
      });

      console.log(`\n📊 Results breakdown:`);
      console.log(`   Official SAP Help: ${official.length} docs`);
      console.log(`   SUPPORT_CONTENT (Wiki): ${supportContent.length} docs`);

      if (supportContent.length > 0) {
        console.log(`\n🎯 SUPPORT_CONTENT ENTRIES (the value proposition):`);
        supportContent.slice(0, 5).forEach((r, i) => {
          console.log(`\n   ${i + 1}. ${r.title || 'Untitled'}`);
          console.log(`      URL: ${r.path}`);
          console.log(`      Score: ${r.finalScore.toFixed(4)}`);

          // Try to infer if this is wiki-like content
          const isLikelyWiki =
            r.title?.includes('How to') ||
            r.title?.includes('Guide') ||
            r.title?.includes('Example') ||
            r.title?.includes('Tutorial') ||
            r.title?.includes('Best Practice') ||
            r.path?.includes('wiki');

          if (isLikelyWiki) {
            console.log(`      ✅ Looks like practical wiki content (how-to/guide/example)`);
          } else {
            console.log(`      ⓘ Unclear - need to check content`);
          }
        });

        console.log(`\n📋 EVALUATION QUESTION:`);
        console.log(`   Without PR: Developer gets ${official.length} official SAP docs`);
        console.log(`   With PR: Developer gets ${official.length} + ${supportContent.length} docs (${official.length + supportContent.length} total)`);
        console.log(`\n   Does the WIKI content help answer the query better?`);
        console.log(`   Can we measure: Is the answer more complete/practical?`);

      } else {
        console.log(`\n⚠️  No SUPPORT_CONTENT for this query`);
        console.log(`   This suggests: Either (a) wiki doesn't cover this topic, or`);
        console.log(`                  (b) official docs are better ranked`);
      }

    } catch (err) {
      console.error(`   ❌ Error: ${err.message}`);
    }
  }

  console.log(`\n\n${'═'.repeat(75)}`);
  console.log(`NEXT STEP: Rigorous LLM Evaluation`);
  console.log(`${'═'.repeat(75)}`);
  console.log(`
To truly assess value, we would:

1. Pick one SUPPORT_CONTENT hit (e.g., the "SO10 + ADS" integration wiki page)

2. Have Claude read JUST the official SAP docs and answer:
   "How do I integrate SAP Forms with Adobe Document Services?"
   → Answer A (from 10 official docs)

3. Then have Claude read official docs + that SUPPORT_CONTENT wiki:
   "How do I integrate SAP Forms with Adobe Document Services?"
   → Answer B (from 10 official + 1 wiki doc)

4. Compare:
   - Does Answer B include concrete code/config examples Answer A lacks?
   - Does Answer B have step-by-step instructions A doesn't?
   - Does Answer B address edge cases/gotchas A misses?
   - Would a developer find B significantly more helpful?

5. If YES to above → PR adds real value
   If NO → PR is just more docs that don't materially improve answers

This is how we'd know for certain whether SUPPORT_CONTENT enrichment is worthwhile.
  `);
}

evaluateValue().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
