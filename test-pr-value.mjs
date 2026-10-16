#!/usr/bin/env node

/**
 * Test harness to evaluate PR #69 impact
 * Compares search results before and after Support Content integration
 */

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const TEST_QUERIES = [
  {
    query: 'Adobe Document Services',
    context: 'Should find SUPPORT_CONTENT topics on ADS'
  },
  {
    query: 'SO10 Adobe Document Services',
    context: 'How to use standard SO10 in ADS (likely wiki content)'
  },
  {
    query: 'document splitting company code',
    context: 'Financial accounting wiki topic (check if active in system)'
  },
  {
    query: 'RAP behavior implementation example',
    context: 'Practical ABAP RAP examples (likely strong in wiki)'
  },
  {
    query: 'BDEF CDS view',
    context: 'Behavior definition practical guide'
  }
];

function runCommand(cmd, args, cwd = process.cwd()) {
  console.log(`\n$ ${cmd} ${args.join(' ')}`);
  const result = spawnSync(cmd, args, {
    cwd,
    stdio: 'pipe',
    encoding: 'utf-8'
  });

  if (result.error) {
    console.error(`❌ Command failed: ${result.error.message}`);
    return null;
  }

  if (result.status !== 0) {
    console.error(`❌ Exit code ${result.status}`);
    console.error(result.stderr);
    return null;
  }

  return result.stdout;
}

function buildAndTest(branch, label) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`📦 Testing on: ${label}`);
  console.log(`${'='.repeat(70)}`);

  // Checkout branch
  console.log(`\n🔄 Checking out ${branch}...`);
  const checkoutResult = spawnSync('git', ['checkout', branch], {
    cwd: process.cwd(),
    stdio: 'inherit'
  });

  if (checkoutResult.status !== 0) {
    console.error(`❌ Failed to checkout ${branch}`);
    return null;
  }

  // Build
  console.log(`\n📚 Building...`);
  const buildResult = runCommand('npm', ['run', 'build:tsc']);
  if (!buildResult) return null;

  // Run queries via the search module
  console.log(`\n🔍 Running test queries...`);
  const results = {};

  for (const { query, context } of TEST_QUERIES) {
    console.log(`\n   Query: "${query}"`);
    console.log(`   Context: ${context}`);

    // Use direct Node.js import to test search
    try {
      const searchModule = await import('./dist/src/lib/search.js');
      const queryResults = await searchModule.search(query, {
        k: 10,
        includeOnline: true
      });

      results[query] = queryResults.map(r => ({
        id: r.id,
        title: r.title,
        sourceKind: r.sourceKind,
        sourceId: r.sourceId,
        finalScore: r.finalScore
      }));

      console.log(`   ✅ Got ${queryResults.length} results`);

      // Show any support content hits
      const supportHits = queryResults.filter(r =>
        r.sourceKind === 'sap_help' &&
        (r.sourceId?.includes('support') || r.id?.includes('support'))
      );
      if (supportHits.length > 0) {
        console.log(`   📌 Support content hits: ${supportHits.length}`);
      }
    } catch (err) {
      console.error(`   ❌ Query failed: ${err.message}`);
      results[query] = null;
    }
  }

  return results;
}

async function main() {
  console.log('PR #69 Value Assessment - Comparative Testing');
  console.log('=' .repeat(70));

  const mainResults = await buildAndTest('main', 'Main branch (WITHOUT PR #69)');
  const prResults = await buildAndTest('pr-69-test', 'PR #69 branch (WITH Support Content)');

  // Return to main
  spawnSync('git', ['checkout', 'main'], { stdio: 'inherit' });

  if (!mainResults || !prResults) {
    console.error('\n❌ Testing failed');
    process.exit(1);
  }

  // Compare results
  console.log(`\n${'='.repeat(70)}`);
  console.log('📊 COMPARISON: Main vs PR #69');
  console.log(`${'='.repeat(70)}`);

  for (const query of TEST_QUERIES) {
    const mainHits = mainResults[query.query] || [];
    const prHits = prResults[query.query] || [];

    console.log(`\n📝 Query: "${query.query}"`);
    console.log(`   Main: ${mainHits.length} results`);
    console.log(`   PR #69: ${prHits.length} results`);

    const newResults = prHits.length - mainHits.length;
    if (newResults > 0) {
      console.log(`   ✅ PR adds ${newResults} new results`);

      // Show new results
      const newIds = new Set(prHits.map(r => r.id));
      mainHits.forEach(r => newIds.delete(r.id));

      if (newIds.size > 0) {
        const newRResults = prHits.filter(r => newIds.has(r.id));
        newRResults.slice(0, 3).forEach(r => {
          console.log(`      • ${r.title} (${r.sourceId})`);
        });
      }
    } else if (newResults < 0) {
      console.log(`   ⚠️ PR returns fewer results (${newResults})`);
    } else {
      console.log(`   ℹ️ Same number of results`);
    }
  }

  // Save detailed results
  const reportPath = 'pr-69-comparison-results.json';
  fs.writeFileSync(reportPath, JSON.stringify({
    testDate: new Date().toISOString(),
    mainResults,
    prResults,
    summary: {
      totalQueries: TEST_QUERIES.length,
      improvedQueries: TEST_QUERIES.filter(q =>
        (prResults[q.query]?.length || 0) > (mainResults[q.query]?.length || 0)
      ).length
    }
  }, null, 2));

  console.log(`\n📄 Full results saved to: ${reportPath}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
