#!/usr/bin/env node
/**
 * Critical test: Same query at different weights
 * Does raising weight from 0.65 → 0.90 → 1.0 bring wiki back into top 15?
 */

import { search } from './dist/src/lib/search.js';

const QUERY = 'How do I integrate SAP Forms SO10 with Adobe Document Services for document generation';

async function testQuery() {
  console.log(`
╔────────────────────────────────────────────────────────────────────╗
║  CRITICAL TEST: Does weight increase rescue buried wiki?          ║
║  Same query, different weights                                    ║
║  Query: "${QUERY}"                                                ║
╚────────────────────────────────────────────────────────────────────╝
  `);

  const results = await search(QUERY, { k: 25, includeOnline: true });

  // Find wiki in results
  const wiki = results.filter(r => r.path?.includes('/SUPPORT_CONTENT/'));
  const firstWikiPos = results.findIndex(r => r.path?.includes('/SUPPORT_CONTENT/')) + 1 || null;

  console.log(`\n📊 RESULTS WITH CURRENT WEIGHT:`);
  console.log(`   Total wiki docs: ${wiki.length}`);
  console.log(`   Wiki in top 15: ${results.slice(0, 15).filter(r => r.path?.includes('/SUPPORT_CONTENT/')).length}`);
  console.log(`   Wiki in top 25: ${wiki.length}`);
  console.log(`   First wiki position: ${firstWikiPos}`);

  if (wiki.length > 0) {
    console.log(`\n   Wiki documents found:`);
    wiki.forEach(r => {
      const pos = results.indexOf(r) + 1;
      console.log(`   Pos ${pos}: ${r.title?.substring(0, 60)}`);
    });

    console.log(`\n✅ Wiki IS present at elevated weight`);
    if (firstWikiPos <= 15) {
      console.log(`   ✅ Wiki visible in top 15 - THIS SOLVES THE PROBLEM`);
    } else if (firstWikiPos <= 25) {
      console.log(`   ⚠️  Wiki visible in top 25 - borderline for LLM`);
    }
  } else {
    console.log(`\n❌ NO wiki documents found even at elevated weight`);
    console.log(`   This means weight increase does NOT solve the problem`);
  }

  // Compare to MAIN behavior
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`MAIN behavior reference:`);
  console.log(`   Wiki at positions: 6-7 (VISIBLE TO LLM)`);
  console.log(`\nPR behavior at current weight:`);
  if (firstWikiPos) {
    console.log(`   Wiki at positions: ${firstWikiPos} (${firstWikiPos <= 15 ? '✅ VISIBLE' : '❌ HIDDEN'})`);
  } else {
    console.log(`   Wiki: NOT FOUND`);
  }
}

testQuery().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
