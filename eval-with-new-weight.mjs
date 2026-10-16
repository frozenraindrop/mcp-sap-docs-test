#!/usr/bin/env node
/**
 * Real LLM Evaluation: Does weight 1.0 (vs original 0.65) actually improve answers?
 *
 * Approach:
 * 1. Get top 25 search results with current weight (1.0)
 * 2. Prepare docs for Claude to analyze
 * 3. Generate answer based on these docs
 * 4. Compare to what would happen at 0.65 weight
 */

import { search } from './dist/src/lib/search.js';

async function evaluateLLMValue() {
  const testQueries = [
    {
      q: 'How do I integrate SAP Forms (SO10) with Adobe Document Services for document generation?',
      context: 'Should benefit from practical ADS+SO10 wiki patterns'
    },
    {
      q: 'What are the key steps to implement RAP behavior definitions for a managed entity?',
      context: 'Should benefit from step-by-step BDEF implementation examples'
    },
    {
      q: 'How do I configure and check document splitting for a specific company code in S/4HANA?',
      context: 'Should benefit from FI configuration wiki guides'
    }
  ];

  console.log(`
╔──────────────────────────────────────────────────────────────────╗
║  LLM VALUE ASSESSMENT: Weight 1.0 vs 0.65                       ║
║  Does wiki content at position 20 actually improve answers?     ║
╚──────────────────────────────────────────────────────────────────╝
  `);

  for (const { q, context } of testQueries) {
    console.log(`\n${'═'.repeat(70)}`);
    console.log(`QUERY: "${q}"`);
    console.log(`Expected benefit: ${context}`);
    console.log(`${'═'.repeat(70)}`);

    const results = await search(q, { k: 25, includeOnline: true });

    // Analyze results
    const official = results.filter(r => !r.path?.includes('/SUPPORT_CONTENT/'));
    const wiki = results.filter(r => r.path?.includes('/SUPPORT_CONTENT/'));

    console.log(`\n📚 Results Breakdown:`);
    console.log(`   Official docs: ${official.length}`);
    console.log(`   Wiki (SUPPORT_CONTENT): ${wiki.length}`);

    if (wiki.length === 0) {
      console.log(`   ⚠️ No wiki content for this query`);
    } else {
      console.log(`\n   Wiki Content (now visible to LLM):`);
      wiki.forEach((r, i) => {
        const pos = results.indexOf(r) + 1;
        console.log(`   ${i+1}. Pos ${pos}: ${r.title?.substring(0, 60)}`);
      });

      console.log(`\n✅ ASSESSMENT:`);
      const firstWikiPos = results.findIndex(r => r.path?.includes('/SUPPORT_CONTENT/')) + 1;

      if (firstWikiPos <= 10) {
        console.log(`   ✅ EXCELLENT: Wiki in top 10 (position ${firstWikiPos})`);
        console.log(`   LLM will definitely use it - could significantly improve answer`);
      } else if (firstWikiPos <= 20) {
        console.log(`   ✅ GOOD: Wiki in top 20 (position ${firstWikiPos})`);
        console.log(`   LLM will likely use it - should improve answer quality`);
      } else if (firstWikiPos <= 30) {
        console.log(`   ⚠️  MARGINAL: Wiki at position ${firstWikiPos}`);
        console.log(`   LLM might use it depending on context budget`);
      } else {
        console.log(`   ❌ POOR: Wiki still buried (position ${firstWikiPos})`);
      }

      console.log(`\n   Next Step: Have Claude read these docs and compare answers`);
      console.log(`   Question: Is Answer(with wiki) better than Answer(without wiki)?`);
    }
  }

  console.log(`\n\n${'═'.repeat(70)}`);
  console.log(`📋 TO COMPLETE THE EVALUATION:`);
  console.log(`
1. For each query above, extract top 5 docs WITHOUT wiki (official only)
2. Extract top 5 docs WITH wiki (mixed)
3. Feed each set to Claude with prompt:
   "Based on these SAP documentation excerpts, answer: [QUERY]"
   Collect: Answer A (official only) and Answer B (official + wiki)

4. Compare Answer A vs Answer B:
   - Does B have concrete code examples A lacks?
   - Does B have step-by-step procedures A misses?
   - Would a developer find B significantly more helpful?

5. VERDICT:
   - If YES → Weight 1.0 is justified (wiki adds real value)
   - If NO → Maybe wiki content is just noise at any weight
   - If MAYBE → Weight 0.85-0.90 might be better balance

This is the true test of PR value.
  `);
}

evaluateLLMValue().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
