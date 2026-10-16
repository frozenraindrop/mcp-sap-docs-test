#!/usr/bin/env node
/**
 * Test: Can SAP Help elasticsearch accept multiple products in a single query?
 *
 * If yes: product=SAP_S4HANA_ON-PREMISE,SUPPORT_CONTENT would give both results
 * If no: Need separate API calls
 */

import { searchSapHelp } from './dist/src/lib/sapHelp.js';

async function testMultipleProducts() {
  const query = 'Adobe Document Services';

  console.log(`
╔────────────────────────────────────────────────────────────────────╗
║  Test: Can SAP Help API accept multiple products at once?         ║
║  Query: "${query}"                                               ║
╚────────────────────────────────────────────────────────────────────╝
  `);

  console.log(`\n1️⃣  Single product filter (SAP_S4HANA_ON-PREMISE):`);
  try {
    const s4hResult = await searchSapHelp(query, '', 'SAP_S4HANA_ON-PREMISE');
    console.log(`   ✅ Results: ${s4hResult.results?.length || 0}`);
    const s4hProducts = s4hResult.results?.map(r => r.metadata?.productId).filter(Boolean);
    console.log(`   Products: ${[...new Set(s4hProducts)].join(', ')}`);
  } catch (err) {
    console.error(`   ❌ Error: ${err.message}`);
  }

  console.log(`\n2️⃣  Attempt: Multiple products (comma-separated):`);
  try {
    const multiResult = await searchSapHelp(query, '', 'SAP_S4HANA_ON-PREMISE,SUPPORT_CONTENT');
    console.log(`   ✅ Results: ${multiResult.results?.length || 0}`);
    if (multiResult.results?.length) {
      const products = [...new Set(multiResult.results.map(r => r.metadata?.productId).filter(Boolean))];
      console.log(`   Products: ${products.join(', ')}`);
      console.log(`   Contains S/4HANA: ${products.includes('SAP_S4HANA_ON-PREMISE') ? '✅' : '❌'}`);
      console.log(`   Contains SUPPORT_CONTENT: ${products.includes('SUPPORT_CONTENT') ? '✅' : '❌'}`);
    }
  } catch (err) {
    console.error(`   ❌ Error: ${err.message}`);
  }

  console.log(`\n3️⃣  SUPPORT_CONTENT only (control):`);
  try {
    const scResult = await searchSapHelp(query, '1.0', 'SUPPORT_CONTENT', { relax: false });
    console.log(`   ✅ Results: ${scResult.results?.length || 0}`);
    const scProducts = scResult.results?.map(r => r.metadata?.productId).filter(Boolean);
    console.log(`   Products: ${[...new Set(scProducts)].join(', ')}`);
  } catch (err) {
    console.error(`   ❌ Error: ${err.message}`);
  }

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`\n📋 ANALYSIS:`);
  console.log(`
If test 2️⃣ (comma-separated) returns results from BOTH products:
  ✅ API supports multiple products in one call
  ✅ Could use: searchSapHelp(query, version, 'SAP_S4HANA,SUPPORT_CONTENT')
  ✅ No need for separate search leg
  ✅ Much simpler implementation

If test 2️⃣ fails or returns only one product:
  ❌ API doesn't support comma-separated products
  ❌ Need separate calls (current approach)
  ✅ But separate leg should be conditional (only when product filter applied)
  `);
}

testMultipleProducts().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
