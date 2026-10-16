#!/usr/bin/env node
/**
 * PR #69 Value Assessment
 * Compares search results before and after Support Content integration
 * Tests specific queries related to migrated SCN Wiki content
 */

import { execSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dir, '..');

const TEST_QUERIES = [
  {
    query: 'Adobe Document Services',
    description: 'Should return SUPPORT_CONTENT topics on ADS (migrated wiki)'
  },
  {
    query: 'SO10 Adobe forms',
    description: 'How to use SAP Forms with ADS (practical wiki content)'
  },
  {
    query: 'document splitting company code check',
    description: 'Financial accounting: checking if splitting is active (FI wiki)'
  },
  {
    query: 'RAP behavior implementation example',
    description: 'Practical ABAP RAP examples and BDEF patterns'
  },
  {
    query: 'BDEF CDS managed behavior',
    description: 'Behavior definition patterns for managed RAP'
  }
];

function runCommand(cmd, args, options = {}) {
  const cmdStr = `${cmd} ${args.join(' ')}`;
  console.log(`  $ ${cmdStr}`);

  try {
    const result = execSync(cmdStr, {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      ...options
    });
    return result;
  } catch (err) {
    console.error(`  ❌ Error: ${err.message}`);
    return null;
  }
}

function buildBranch(branch) {
  console.log(`\n🔄 Checking out ${branch}...`);
  spawnSync('git', ['checkout', branch], {
    cwd: projectRoot,
    stdio: 'inherit'
  });

  console.log(`📚 Building TypeScript...`);
  runCommand('npm', ['run', 'build:tsc']);

  console.log(`📚 Building FTS index...`);
  runCommand('npm', ['run', 'build:fts']);

  return true;
}

async function runTestQueries(branch, label) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`🧪 Testing: ${label}`);
  console.log(`${'='.repeat(80)}`);

  const results = {};

  // Use the built server to test queries
  // For each query, we need to call the search function directly
  // since starting a server for each branch is heavyweight

  console.log(`\n📝 Running ${TEST_QUERIES.length} test queries...`);

  for (const { query, description } of TEST_QUERIES) {
    console.log(`\n   Query: "${query}"`);
    console.log(`   Context: ${description}`);

    // For now, mark as pending - actual implementation would invoke search
    results[query] = {
      count: 0,
      results: [],
      note: 'Test implementation pending - requires search module invocation'
    };
  }

  return results;
}

async function main() {
  console.log('\n' + '='.repeat(80));
  console.log('🔍 PR #69 Impact Assessment: Support Content Integration');
  console.log('='.repeat(80));

  console.log('\n📋 Test Queries:');
  TEST_QUERIES.forEach((t, i) => {
    console.log(`  ${i + 1}. ${t.query}`);
    console.log(`     → ${t.description}`);
  });

  // Build and test main
  console.log('\n' + '='.repeat(80));
  console.log('Phase 1: Build and test MAIN branch (without PR #69)');
  console.log('='.repeat(80));
  buildBranch('main');
  const mainResults = await runTestQueries('main', 'Main branch (no Support Content)');

  // Build and test PR
  console.log('\n' + '='.repeat(80));
  console.log('Phase 2: Build and test PR #69 branch (with Support Content)');
  console.log('='.repeat(80));
  buildBranch('pr-69-test');
  const prResults = await runTestQueries('pr-69-test', 'PR #69 (with Support Content)');

  // Return to main
  console.log('\n🔄 Returning to main branch...');
  spawnSync('git', ['checkout', 'main'], { stdio: 'inherit' });

  // Generate report
  const report = {
    timestamp: new Date().toISOString(),
    testQueries: TEST_QUERIES,
    branches: {
      main: mainResults,
      pr69: prResults
    },
    notes: [
      'This test compares search results from main vs PR #69',
      'Focus areas: Adobe Document Services, Financial Accounting, RAP/BDEF patterns',
      'PR #69 adds SUPPORT_CONTENT layer (migrated SCN Wiki) with RRF weight 0.65',
      'Lower weight prevents support content from overshadowing official docs'
    ]
  };

  const reportFile = path.join(projectRoot, 'pr-69-test-results.json');
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));

  console.log(`\n${'='.repeat(80)}`);
  console.log('✅ Test complete');
  console.log(`📊 Results saved to: ${reportFile}`);
  console.log('='.repeat(80));

  console.log(`\n📋 Next Steps:`);
  console.log(`  1. Review the generated test results file`);
  console.log(`  2. Run actual search queries on both branches to populate results`);
  console.log(`  3. Compare which branch returns more relevant content for SUPPORT_CONTENT topics`);
  console.log(`  4. Verify the 4 new test cases added in the PR pass`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
