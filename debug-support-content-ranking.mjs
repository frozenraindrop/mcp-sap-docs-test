#!/usr/bin/env node
/**
 * Debug: Where do SUPPORT_CONTENT results rank in final results?
 * Are they visible to LLMs or buried too deep?
 */

import { search } from './dist/src/lib/search.js';

async function debugRanking() {
  const query = 'How do I integrate SAP Forms with Adobe Document Services';

  console.log(`Query: "${query}"\n`);
  console.log(`Searching with k=50 (to see ranking depth)...\n`);

  const results = await search(query, { k: 50, includeOnline: true });

  console.log(`Total results: ${results.length}\n`);

  // Show all results with source kind
  results.forEach((r, i) => {
    const isSupport = r.path?.includes('/SUPPORT_CONTENT/') ? '🎯 SUPPORT' : '📄 Official';
    const source = r.sourceKind === 'sap_help' ? 'SAP Help' :
                   r.sourceKind === 'sap_community' ? 'Community' : r.sourceKind;

    console.log(`${(i + 1).toString().padStart(2)}. [${isSupport}] [${source}]`);
    console.log(`    Title: ${r.title?.substring(0, 70)}`);
    console.log(`    Score: ${r.finalScore.toFixed(4)}`);
    if (r.debug) {
      console.log(`    Debug: RRF=${r.debug.rrfScore?.toFixed(4)}, Boost=${r.debug.boost?.toFixed(2)}`);
    }
  });

  // Statistics
  const supportCount = results.filter(r => r.path?.includes('/SUPPORT_CONTENT/')).length;
  const firstSupportIndex = results.findIndex(r => r.path?.includes('/SUPPORT_CONTENT/'));

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`📊 SUPPORT_CONTENT Ranking Analysis:`);
  console.log(`   Total in top 50: ${supportCount}`);
  console.log(`   First appearance: Position ${firstSupportIndex >= 0 ? firstSupportIndex + 1 : 'NOT FOUND'}`);
  console.log(`\n🎯 VISIBILITY ASSESSMENT:`);

  if (firstSupportIndex === -1) {
    console.log(`   ❌ CRITICAL: No SUPPORT_CONTENT in top 50 results`);
    console.log(`   Impact: LLM will NEVER see wiki content (completely buried by official docs)`);
    console.log(`   Conclusion: PR adds zero practical value for this query`);
  } else if (firstSupportIndex < 10) {
    console.log(`   ✅ GOOD: SUPPORT_CONTENT visible in top 10 (LLM will see it)`);
    console.log(`   Impact: PR could meaningfully enhance answers`);
  } else if (firstSupportIndex < 20) {
    console.log(`   ⚠️  MARGINAL: SUPPORT_CONTENT at position ${firstSupportIndex + 1}`);
    console.log(`   Impact: LLM might not see it (depends on context window)`);
  } else {
    console.log(`   ❌ POOR: SUPPORT_CONTENT at position ${firstSupportIndex + 1}  `);
    console.log(`   Impact: Essentially invisible to LLM processing`);
  }
}

debugRanking().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
