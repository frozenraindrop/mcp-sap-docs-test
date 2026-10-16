#!/usr/bin/env node
/**
 * Diagnose: What is the SUPPORT_CONTENT search leg actually returning?
 *
 * This helps understand why PR returns FEWER wiki docs than main
 */

import { searchSapHelp } from './dist/src/lib/sapHelp.js';

async function diagnoseSearchLegs() {
  const query = 'How do I integrate SAP Forms SO10 with Adobe Document Services for document generation';

  console.log(`
╔────────────────────────────────────────────────────────────────────╗
║  Diagnosing: What does SUPPORT_CONTENT search leg return?        ║
║  Query: "${query}"                                              ║
╚────────────────────────────────────────────────────────────────────╝
  `);

  console.log(`\n📍 Search 1: Regular SAP Help (NO product filter)`);
  try {
    const regular = await searchSapHelp(query, '', '');
    console.log(`   Results: ${regular.results?.length || 0}`);
    if (regular.results?.length) {
      const supportInRegular = regular.results.filter(r =>
        r.metadata?.productId === 'SUPPORT_CONTENT' ||
        r.url?.includes('/SUPPORT_CONTENT/')
      );
      console.log(`   Support content found: ${supportInRegular.length}`);
      if (supportInRegular.length > 0) {
        console.log(`   Examples:`);
        supportInRegular.slice(0, 3).forEach(r => {
          console.log(`     - ${r.title?.substring(0, 60)}`);
          console.log(`       ${r.url?.substring(0, 80)}`);
        });
      }
    }
  } catch (err) {
    console.error(`   ❌ Error: ${err.message}`);
  }

  console.log(`\n📍 Search 2: Specific SUPPORT_CONTENT search`);
  try {
    const supportContent = await searchSapHelp(query, '1.0', 'SUPPORT_CONTENT', { relax: false });
    console.log(`   Results: ${supportContent.results?.length || 0}`);
    if (supportContent.results?.length) {
      console.log(`   Top 5 results:`);
      supportContent.results.slice(0, 5).forEach((r, i) => {
        console.log(`   ${i+1}. ${r.title?.substring(0, 60)}`);
        console.log(`      ${r.url?.substring(0, 80)}`);
      });
    } else {
      console.log(`   ⚠️ No results from SUPPORT_CONTENT search`);
      if (supportContent.error) {
        console.log(`   Error: ${supportContent.error}`);
      }
    }
  } catch (err) {
    console.error(`   ❌ Error: ${err.message}`);
  }

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`📋 ANALYSIS:`);
  console.log(`
If:
  - Regular search (no filter) returns wiki docs  → They should appear in final results
  - SUPPORT_CONTENT search returns 0 docs        → Wiki is lost because separate leg empty
  - SUPPORT_CONTENT search returns wiki docs     → Wiki should appear in final results

This explains why MAIN has wiki but PR doesn't.
  `);
}

diagnoseSearchLegs().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
