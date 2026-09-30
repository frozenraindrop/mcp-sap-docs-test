// A3b: SAP Community discovery through a SearXNG metasearch instance, taking the engine's order as-is
// (no kudos/recency weighting, no kudos filter) with the query restricted by `site:community.sap.com`.
// Post text is still fetched by id through the LiQL API when the pool step hydrates it.
//
//   node test/eval/community-produce.js --strategy searxng --searxng-url https://search.example.org
//   (or set SEARXNG_URL)
//
// Be a good citizen on PUBLIC instances: low volume, a pause between requests, an honest User-Agent, and no
// attempt to get around an instance's rate limiter (a 429/403 is reported as a failed query, never retried
// through workarounds). Public instances come and go and their upstream engines are often rate-limited
// themselves, so results are not stable over time: the run file is the snapshot to re-score from.

const SITE = "site:community.sap.com";
// Post permalinks only (blog, Q&A thread, reply); board/tag/profile pages carry no post id. Mirrors the
// strict part of extractPostId in src/lib/communityBestMatch.ts.
const POST_URL = /^https?:\/\/community\.sap\.com\/.*\/(?:ba-p|td-p|qaq-p|qaa-p|m-p)\/(\d+)/;

// SearXNG JSON -> [{ postId, title, url, snippet }] in the engine's order, community posts only, unique.
export function parseSearxResults(json) {
  const seen = new Set();
  const hits = [];
  for (const r of json?.results ?? []) {
    const m = POST_URL.exec(r.url ?? "");
    if (!m || seen.has(m[1])) continue;
    seen.add(m[1]);
    hits.push({ postId: m[1], title: r.title ?? "", url: r.url, snippet: (r.content ?? "").slice(0, 500) });
  }
  return hits;
}

// Pages through results until `k` unique community posts are found, a page comes back empty, or maxPages.
// `getJson(url)` and `sleep(ms)` are injected (real HTTP / timers in production).
export async function searxngSearch({ query, k, baseUrl, getJson, sleep, maxPages = 3, pauseMs = 2500 }) {
  const base = baseUrl.replace(/\/$/, "");
  const byId = new Map();
  for (let page = 1; page <= maxPages && byId.size < k; page++) {
    if (page > 1) await sleep(pauseMs);
    const url = `${base}/search?q=${encodeURIComponent(`${SITE} ${query}`)}&format=json&language=en&pageno=${page}`;
    const json = await getJson(url);
    if (!(json?.results ?? []).length) break; // no more pages
    for (const h of parseSearxResults(json)) if (!byId.has(h.postId)) byId.set(h.postId, h);
  }
  return [...byId.values()].slice(0, k);
}

// Production wiring.
export async function searchCommunitySearxng(query, opts) {
  const baseUrl = opts.searxngUrl ?? process.env.SEARXNG_URL;
  if (!baseUrl) throw new Error("searxng strategy needs --searxng-url or SEARXNG_URL");
  const getJson = async (url) => {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "SAP-Docs-MCP-eval/1.0 (research; low volume)" },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`SearXNG HTTP ${res.status}`);
    if (!(res.headers.get("content-type") ?? "").includes("json")) throw new Error("SearXNG did not return JSON (format=json disabled?)");
    return res.json();
  };
  const hits = await searxngSearch({ query, k: opts.k, baseUrl, getJson, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });
  console.log(`  [searxng] ${hits.length} community post(s) for "${query.slice(0, 50)}"`);
  return hits;
}
