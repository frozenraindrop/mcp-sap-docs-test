#!/usr/bin/env node
/**
 * Direct test of search results with SUPPORT_CONTENT integration
 * Run on PR branch to verify support content enrichment works
 */

import { search } from './dist/src/lib/search.js';

const TEST_QUERIES = [
  'Adobe Document Services',
  'SO10 Adobe forms',
  'document splitting company code',
  'RAP behavior implementation',
  'BDEF CDS managed'
];

async function testSearch() {
  console.log('🔍 Testing unified search with SUPPORT_CONTENT layer (PR #69)\n');

  for (const query of TEST_QUERIES) {
    console.log(`\n${'─'.repeat(70)}`);
    console.log(`Query: "${query}"`);
    console.log(`${'─'.repeat(70)}`);

    try {
      const results = await search(query, {
        k: 10,
        includeOnline: true
      });

      console.log(`\nTotal results: ${results.length}`);

      // Group by source
      const bySource = {};
      results.forEach(r => {
        if (!bySource[r.sourceKind]) {
          bySource[r.sourceKind] = [];
        }
        bySource[r.sourceKind].push(r);
      });

      // Check for SAP Help results
      const sapHelpResults = bySource['sap_help'] || [];
      console.log(`SAP Help results: ${sapHelpResults.length}`);

      if (sapHelpResults.length > 0) {
        console.log('\nTop 3 SAP Help results:');
        sapHelpResults.slice(0, 3).forEach((r, i) => {
          const sourceInfo = r.sourceId === 'sap-help' ? '(official)' :
                           r.sourceId?.includes('support') ? '(support content)' : '';
          console.log(`  ${i+1}. ${r.title} ${sourceInfo}`);
          console.log(`     Score: ${r.finalScore.toFixed(2)}`);
          console.log(`     URL: ${r.path}`);
        });
      }

      // Check for support content indicators
      const supportContentResults = sapHelpResults.filter(r =>
        r.path?.includes('/SUPPORT_CONTENT/') ||
        r.sourceId?.includes('support') ||
        r.title?.toLowerCase().includes('support')
      );

      if (supportContentResults.length > 0) {
        console.log(`\n✅ Found ${supportContentResults.length} potential SUPPORT_CONTENT hit(s)`);
        supportContentResults.forEach(r => {
          console.log(`   - ${r.title}`);
        });
      }

    } catch (err) {
      console.error(`❌ Error: ${err.message}`);
    }
  }

  console.log(`\n${'═'.repeat(70)}`);
  console.log('Test complete');
  console.log(`${'═'.repeat(70)}`);
}

testSearch().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
