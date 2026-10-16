#!/usr/bin/env node
/**
 * Capture search results from both main and PR branches for LLM comparison
 *
 * This will:
 * 1. Run search on current branch
 * 2. Extract top 10-15 documents with their full metadata
 * 3. Save as JSON for feeding to Claude
 * 4. Save titles/URLs for manual inspection
 */

import { search } from './dist/src/lib/search.js';
import fs from 'fs';
import path from 'path';

const TEST_QUERY = 'How do I integrate SAP Forms SO10 with Adobe Document Services for document generation';

async function captureResults() {
  console.log(`
╔────────────────────────────────────────────────────────────────────╗
║  Capturing search results for LLM comparison                       ║
║  Query: "${TEST_QUERY}"                                           ║
╚────────────────────────────────────────────────────────────────────╝
  `);

  const results = await search(TEST_QUERY, { k: 20, includeOnline: true });

  const topResults = results.slice(0, 15).map((r, i) => ({
    position: i + 1,
    isWiki: r.path?.includes('/SUPPORT_CONTENT/') ? true : false,
    title: r.title || 'Untitled',
    sourceKind: r.sourceKind,
    sourceId: r.sourceId,
    url: r.path || r.id,
    score: r.finalScore,
    snippet: r.text?.substring(0, 200) || r.snippet?.substring(0, 200) || '',
  }));

  console.log(`\n📊 Results captured: ${topResults.length} documents\n`);

  // Show summary
  topResults.forEach(r => {
    const wiki = r.isWiki ? '🎯 WIKI' : '📄 OFF';
    console.log(`${String(r.position).padStart(2)}. [${wiki}] Pos ${String(r.position).padStart(2)}: ${r.title.substring(0, 60)}`);
    console.log(`     URL: ${r.url.substring(0, 80)}`);
    console.log(`     Score: ${r.score.toFixed(4)}`);
  });

  // Save for LLM
  const timestamp = new Date().toISOString();
  const branch = process.env.GIT_BRANCH || 'unknown';

  const output = {
    timestamp,
    branch,
    query: TEST_QUERY,
    totalResults: results.length,
    topResults: topResults,
    summary: {
      wikiCount: topResults.filter(r => r.isWiki).length,
      officialCount: topResults.filter(r => !r.isWiki).length,
      firstWikiPosition: topResults.findIndex(r => r.isWiki) + 1 || null
    }
  };

  const filename = `results-${branch}-${Date.now()}.json`;
  fs.writeFileSync(filename, JSON.stringify(output, null, 2));

  console.log(`\n✅ Saved to: ${filename}`);
  console.log(`\n📋 For LLM comparison, we need:`);
  console.log(`   1. results-main-*.json (current results WITHOUT PR)`);
  console.log(`   2. results-pr-*.json (results WITH PR and 0.90 weight)`);
  console.log(`\n   Then: Feed each set to Claude with:`);
  console.log(`   "Based on these documents, answer: ${TEST_QUERY}"`);
  console.log(`\n   Compare the two answers to see what value PR adds`);

  return filename;
}

captureResults().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
