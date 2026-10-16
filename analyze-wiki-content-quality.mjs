#!/usr/bin/env node
/**
 * Analyze: Is wiki content actually useful to LLMs?
 *
 * Assessment criteria:
 * 1. Standalone text content (not just links)
 * 2. Presence of code examples (valuable)
 * 3. Heavy link dependency (problematic)
 * 4. Image dependency (not multimodal)
 * 5. Auth-gated content (inaccessible)
 */

import { search } from './dist/src/lib/search.js';

async function analyzeWikiQuality() {
  const query = 'How do I integrate SAP Forms SO10 with Adobe Document Services for document generation';

  console.log(`
╔────────────────────────────────────────────────────────────────────╗
║  Wiki Content Quality Assessment                                  ║
║  Question: Is wiki actually USEFUL to LLMs, or just links?       ║
╚────────────────────────────────────────────────────────────────────╝
  `);

  const results = await search(query, { k: 50, includeOnline: true });
  const wiki = results.filter(r => r.path?.includes('/SUPPORT_CONTENT/'));

  console.log(`\n📊 Found ${wiki.length} wiki documents\n`);

  if (wiki.length === 0) {
    console.log('No wiki content to analyze.');
    return;
  }

  // Analyze each wiki doc
  wiki.forEach((r, i) => {
    console.log(`${'─'.repeat(70)}`);
    console.log(`${i + 1}. ${r.title || 'Untitled'}`);
    console.log(`   URL: ${r.path?.substring(0, 80)}`);
    console.log(`   Score: ${r.finalScore.toFixed(4)}`);

    const snippet = r.text || r.snippet || '';

    // Assessment
    console.log(`\n   📋 Content Analysis:`);

    // Check for standalone content
    const hasText = snippet.length > 200;
    const hasCode = /code|example|snippet|javascript|typescript|abap|sql|select|create|function/i.test(snippet);
    const hasLinks = /<a href|https?:\/\/|OSS|note|SAP Note|\[.*\]\(/i.test(snippet);
    const hasImages = /<img|image|image:|\[image\]|image>/i.test(snippet);
    const hasAuthGated = /credentials?|password|login|authentication required|oss note|SAP Note/i.test(snippet);

    console.log(`   • Standalone text: ${hasText ? '✅ YES' : '❌ NO'} (${snippet.length} chars)`);
    console.log(`   • Code examples: ${hasCode ? '✅ YES' : '⚠️ NO'}`);
    console.log(`   • Heavy links: ${hasLinks ? '⚠️ YES (problematic)' : '✅ NO'}`);
    console.log(`   • Images: ${hasImages ? '❌ YES (not multimodal)' : '✅ NO'}`);
    console.log(`   • Auth-gated (OSS): ${hasAuthGated ? '❌ YES (inaccessible)' : '✅ NO'}`);

    // Sample
    console.log(`\n   📄 Content sample (first 200 chars):`);
    console.log(`   "${snippet.substring(0, 200)}..."`);
  });

  // Summary
  console.log(`\n${'═'.repeat(70)}`);
  console.log('📊 QUALITY SUMMARY\n');

  const hasStandaloneContent = wiki.some(r => (r.text || r.snippet || '').length > 200);
  const hasCodeExamples = wiki.some(r => /code|example|snippet/i.test(r.text || r.snippet || ''));
  const heavyLinks = wiki.filter(r => /<a href|OSS/i.test(r.text || r.snippet || '')).length;
  const imageHeavy = wiki.filter(r => /<img|image>/i.test(r.text || r.snippet || '')).length;

  console.log(`Useful standalone content: ${hasStandaloneContent ? '✅ Some' : '❌ None'}`);
  console.log(`Code/examples: ${hasCodeExamples ? '✅ Present' : '❌ Missing'}`);
  console.log(`Heavy link dependency: ${heavyLinks}/${wiki.length} pages (${heavyLinks > 0 ? '⚠️ PROBLEMATIC' : '✅ OK'})`);
  console.log(`Image dependency: ${imageHeavy}/${wiki.length} pages (${imageHeavy > 0 ? '❌ NOT USEFUL' : '✅ OK'})`);

  console.log(`\n📋 CONCLUSION:`);
  console.log(`
The critical question: If a wiki page is 70% links and 30% intro text,
is it useful to an LLM that can't follow those links?

Answer: Usually NO. The value is in the ACTUAL CONTENT, not pointers to it.

Recommendation: Audit the wiki corpus to filter OUT:
  1. Pages that are mostly navigation/links
  2. Pages that heavily reference auth-gated OSS notes
  3. Pages that are image-dependent

If most wiki pages fail these quality checks, the separate search leg
adds noise rather than value - even if properly weighted.
  `);
}

analyzeWikiQuality().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
