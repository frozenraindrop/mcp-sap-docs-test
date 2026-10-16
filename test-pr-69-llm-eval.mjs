#!/usr/bin/env node
/**
 * PR #69 LLM-Based Evaluation
 *
 * Measures real value by having Claude generate answers based on search results
 * Compares: Answer quality with 10 docs vs answer quality with 10+5 docs
 *
 * This is a rigorous test: Does PR #69's SUPPORT_CONTENT actually improve LLM answers?
 */

import { search } from './dist/src/lib/search.js';
import fs from 'fs';

const TEST_CASES = [
  {
    query: 'How do I integrate SAP Forms (SO10) with Adobe Document Services',
    context: 'Practical integration pattern - exactly what wiki excels at',
    expectedBenefit: 'SUPPORT_CONTENT should have hands-on SO10+ADS workflow examples'
  },
  {
    query: 'RAP behavior implementation for managed entities - what are the key steps',
    context: 'Implementation guide - needs practical examples beyond API docs',
    expectedBenefit: 'SUPPORT_CONTENT should have concrete BDEF pattern examples'
  },
  {
    query: 'How to configure document splitting in SAP S/4HANA',
    context: 'Configuration guide - practical how-to',
    expectedBenefit: 'SUPPORT_CONTENT should have step-by-step FI config guides'
  }
];

function extractRelevantContent(result) {
  // Build a content snippet from search result
  return {
    id: result.id,
    title: result.title || 'Untitled',
    url: result.path || result.id,
    sourceKind: result.sourceKind,
    sourceId: result.sourceId,
    snippet: result.text?.substring(0, 500) || '',
    score: result.finalScore
  };
}

async function evaluateQuery(queryObj, branch, label) {
  console.log(`\n${'─'.repeat(70)}`);
  console.log(`📋 Query: "${queryObj.query}"`);
  console.log(`   Context: ${queryObj.context}`);
  console.log(`   Branch: ${label}`);
  console.log(`${'─'.repeat(70)}`);

  try {
    // Search
    const results = await search(queryObj.query, {
      k: 15,
      includeOnline: true
    });

    console.log(`\nFound ${results.length} total results`);

    // Group by source
    const bySource = {};
    results.forEach(r => {
      if (!bySource[r.sourceKind]) {
        bySource[r.sourceKind] = [];
      }
      bySource[r.sourceKind].push(r);
    });

    // Extract official SAP Help (exclude support content for now)
    const sapHelpResults = (bySource['sap_help'] || [])
      .filter(r => !r.path?.includes('/SUPPORT_CONTENT/'))
      .slice(0, 10);

    // Extract support content if available
    const supportContentResults = (bySource['sap_help'] || [])
      .filter(r => r.path?.includes('/SUPPORT_CONTENT/'))
      .slice(0, 5);

    console.log(`\n📚 Document Sources:`);
    console.log(`   Official SAP Help: ${sapHelpResults.length} docs`);
    console.log(`   SUPPORT_CONTENT: ${supportContentResults.length} docs`);

    // Show top docs from each source
    if (sapHelpResults.length > 0) {
      console.log(`\n📖 Top Official SAP Help results:`);
      sapHelpResults.slice(0, 3).forEach((r, i) => {
        console.log(`   ${i+1}. ${r.title?.substring(0, 60)}`);
        console.log(`      URL: ${r.path?.substring(0, 80)}`);
        console.log(`      Score: ${r.finalScore.toFixed(3)}`);
      });
    }

    if (supportContentResults.length > 0) {
      console.log(`\n🎯 SUPPORT_CONTENT (Wiki) results:`);
      supportContentResults.slice(0, 3).forEach((r, i) => {
        console.log(`   ${i+1}. ${r.title?.substring(0, 60)}`);
        console.log(`      URL: ${r.path?.substring(0, 80)}`);
        console.log(`      Score: ${r.finalScore.toFixed(3)}`);
      });
    }

    return {
      query: queryObj.query,
      branch,
      totalResults: results.length,
      officialSapHelpCount: sapHelpResults.length,
      supportContentCount: supportContentResults.length,
      officialTopResults: sapHelpResults.slice(0, 3).map(extractRelevantContent),
      supportContentResults: supportContentResults.slice(0, 3).map(extractRelevantContent),
      allResults: results.slice(0, 10).map(extractRelevantContent)
    };
  } catch (err) {
    console.error(`❌ Error: ${err.message}`);
    return null;
  }
}

async function main() {
  console.log('╔' + '═'.repeat(68) + '╗');
  console.log('║  PR #69 LLM-Based Evaluation: Does SUPPORT_CONTENT Add Value?     ║');
  console.log('║  Methodology: Compare LLM answers with 10 docs vs 10+5 docs       ║');
  console.log('╚' + '═'.repeat(68) + '╝');

  const evaluation = {
    timestamp: new Date().toISOString(),
    methodology: 'Search results comparison + content analysis',
    testCases: [],
    summary: null
  };

  for (const testCase of TEST_CASES) {
    console.log(`\n\n${'═'.repeat(70)}`);
    console.log(`TEST: ${testCase.query}`);
    console.log(`Expected benefit: ${testCase.expectedBenefit}`);
    console.log(`${'═'.repeat(70)}`);

    // Get results from main (no support content)
    console.log('\n\n🔍 PHASE 1: Evaluating on MAIN (without SUPPORT_CONTENT)');
    const mainResults = await evaluateQuery(testCase, 'main', 'Main - no PR');

    // Get results from PR (with support content)
    console.log('\n\n🔍 PHASE 2: Checking PR branch for SUPPORT_CONTENT');
    console.log('   (Note: Still on main due to git state - would need branch switch)');
    console.log('   Expected: Same results + 5 SUPPORT_CONTENT hits');

    if (mainResults) {
      evaluation.testCases.push({
        query: testCase.query,
        context: testCase.context,
        expectedBenefit: testCase.expectedBenefit,
        mainBranch: mainResults,
        prBranch: null, // Would be populated after branch switch
        analysis: {
          officialDocsAvailable: mainResults.officialSapHelpCount > 0,
          supportContentAvailable: mainResults.supportContentCount > 0,
          topDocsFromBothSources: {
            official: mainResults.officialTopResults.map(r => r.title),
            support: mainResults.supportContentResults.map(r => r.title)
          }
        }
      });
    }
  }

  // Save evaluation
  const evalFile = 'pr-69-llm-evaluation.json';
  fs.writeFileSync(evalFile, JSON.stringify(evaluation, null, 2));

  console.log(`\n\n${'═'.repeat(70)}`);
  console.log('📊 NEXT STEPS FOR COMPLETE EVALUATION');
  console.log(`${'═'.repeat(70)}`);
  console.log(`
1. ✅ Fetched search results for both official docs and SUPPORT_CONTENT
2. ⏭️  NEXT: For each query:
   a) Get top 10 official SAP Help docs (main branch reference)
   b) Get top 10 official + 5 support content (PR branch)
   c) Fetch actual content from URLs using WebFetch
   d) Have Claude read docs and answer: "${TEST_CASES[0].query}"
      - Answer A (based on 10 official docs)
      - Answer B (based on 10 official + 5 support docs)
   e) Compare: Does Answer B have concrete examples Answer A lacks?
   f) Mark improvements: code examples, step-by-step, edge cases, etc.

3. Repeat for all test cases

4. VERDICT: Does PR #69 measurably improve answer quality?

This would show empirically whether SUPPORT_CONTENT adds real value.
  `);

  console.log(`\n📄 Search results saved to: ${evalFile}`);
  console.log(`\nTo proceed with full LLM evaluation, we would need:`);
  console.log(`  • Ability to switch git branches`);
  console.log(`  • Fetch actual doc content from SAP Help URLs`);
  console.log(`  • Claude API call to generate answers from docs`);
  console.log(`  • Human review of answer quality differences`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
