#!/usr/bin/env node
/**
 * Test: Does PR #69 add NEW content or just re-rank existing content?
 *
 * Question: If main's SAP Help search already returns SUPPORT_CONTENT results,
 * does the PR's separate leg find MORE content, or just the same content?
 */

import { search } from './dist/src/lib/search.js';

async function compareContent() {
  const query = 'How do I integrate SAP Forms with Adobe Document Services';

  console.log(`Query: "${query}"\n`);
  console.log(`Testing on PR branch (with separate SUPPORT_CONTENT leg)...\n`);

  const results = await search(query, { k: 100, includeOnline: true });

  // Extract all SUPPORT_CONTENT results
  const supportContent = results.filter(r => r.path?.includes('/SUPPORT_CONTENT/'));

  console.log(`📊 SUPPORT_CONTENT Results Found:`);
  console.log(`   Total: ${supportContent.length}\n`);

  if (supportContent.length > 0) {
    console.log(`📋 URLs (check for uniqueness):`);
    supportContent.forEach((r, i) => {
      console.log(`   ${i + 1}. ${r.path}`);
    });

    // Check for duplicate URLs
    const urls = supportContent.map(r => r.path);
    const uniqueUrls = new Set(urls);

    console.log(`\n🔍 Deduplication Analysis:`);
    console.log(`   Unique URLs: ${uniqueUrls.size}`);
    console.log(`   Total results: ${supportContent.length}`);
    console.log(`   Duplicates: ${supportContent.length - uniqueUrls.size}`);

    if (supportContent.length > uniqueUrls.size) {
      console.log(`   ⚠️ Found duplicates! Same URL returned multiple times`);
      console.log(`   This suggests deduplication is NOT working properly`);
    }
  }

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`Critical Question:

Without PR: SAP Help search (no product filter) returns some SUPPORT_CONTENT
With PR: SAP Help search (no product filter) + SUPPORT_CONTENT leg (separate)

Does the PR's separate leg find MORE wiki content than was already mixed in?
Or is it just the same content with different weighting?

Answer: Check how many SUPPORT_CONTENT results appear in top 50.
  `);

  // Count position distribution
  const topN = [10, 20, 30, 50];
  for (const n of topN) {
    const inTopN = results.slice(0, n).filter(r => r.path?.includes('/SUPPORT_CONTENT/')).length;
    console.log(`   Top ${n}: ${inTopN} SUPPORT_CONTENT results`);
  }
}

compareContent().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
