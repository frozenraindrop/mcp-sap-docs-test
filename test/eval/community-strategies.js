// Candidate Community retrieval strategies for the eval harness (see community-produce.js).
//
// A2b, "and": require ALL significant query terms in the LiQL query itself (the AND operator inside a
// single MATCHES string), instead of the current OR-per-term + post-hoc rescoring. Everything else matches the current
// strategy (kudos filter, rank by subject term hits > kudos > recency) so a difference in the
// judged numbers comes from the AND matching and the term hygiene, not from a different ranking rule.
//
// This is a CANDIDATE implementation living in the harness on purpose: if it wins the judged
// comparison it moves into src/lib/communityBestMatch.ts and this file becomes a thin wrapper.
//
// Stopwords: searchDb.ts has a 26-word list, but it is tuned for doc FTS, is not exported, and
// misses words that appear in natural-language Community questions ("after", "inside", "as", ...).
// Hoist and share one list if this graduates into src.

const COMMUNITY_BASE = "https://community.sap.com";
const LIQL_BASE = `${COMMUNITY_BASE}/api/2.0/search`;
const MAX_TERMS = 8;

const STOPWORDS = new Set([
  "a", "an", "the", "to", "in", "on", "for", "and", "or", "of", "with", "from", "by", "at", "as", "into", "onto",
  "how", "what", "why", "when", "where", "which", "who", "whom", "does", "do", "did", "is", "are", "was", "were", "be",
  "can", "could", "should", "would", "will", "it", "its", "this", "that", "these", "those", "my", "our", "your",
  "not", "no", "after", "before", "inside", "within", "about", "using", "use", "via", "get", "gets", "getting", "i", "we",
]);

// Lowercased significant terms, in query order: technical tokens (TIME_OUT, @requires, sap.m.Button)
// survive, stopwords and one-character tokens go, duplicates collapse, capped at MAX_TERMS.
export function significantTerms(query, maxTerms = MAX_TERMS) {
  const seen = new Set();
  const out = [];
  for (const raw of String(query).toLowerCase().split(/\s+/)) {
    const t = raw.replace(/^[^\p{L}\p{N}_@#]+|[^\p{L}\p{N}_]+$/gu, "");
    if (t.length < 2 || STOPWORDS.has(t) || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length === maxTerms) break;
  }
  return out;
}

// ONE MATCHES per field whose search string joins the terms with AND. Verified against the live API
// (2026-09-30): several ANDed MATCHES clauses are rejected (HTTP 400, code 604), but the AND operator
// inside one string works ('hana AND hdi' -> 20/20 subjects contain both words; plain 'hana hdi' -> 0/20).
// Cost: "all terms in the subject, or all terms in the body"; a term split across the two fields is missed.
// Topic-level posts only (depth = 0).
export function buildAndLiqlUrl(terms, limit = 20, minKudos = 0) {
  const phrase = terms.map((t) => t.replace(/'/g, "\\'")).join(" AND ");
  const where = `(subject MATCHES '${phrase}' OR body MATCHES '${phrase}')`;
  const kudos = minKudos > 0 ? ` AND kudos.sum(weight) >= ${minKudos}` : "";
  const liql = `SELECT id, subject, search_snippet, post_time, view_href, kudos.sum(weight) FROM messages WHERE ${where} AND depth = 0${kudos} LIMIT ${limit}`;
  return `${LIQL_BASE}?q=${encodeURIComponent(liql)}`;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// How many terms occur in `text` as whole words ("in" does not match "Consuming").
export function wholeWordHits(text, terms) {
  const lower = String(text ?? "").toLowerCase();
  let hits = 0;
  for (const t of terms) {
    if (new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRe(t)}($|[^\\p{L}\\p{N}_])`, "u").test(lower)) hits++;
  }
  return hits;
}

// Same ordering rule as the current strategy: subject term hits > kudos > recency.
export function rankItems(items, terms) {
  return items
    .map((item) => ({
      item,
      hits: wholeWordHits(item.subject, terms),
      kudos: item.kudos?.sum?.weight ?? 0,
      time: item.post_time ? new Date(item.post_time).getTime() : 0,
    }))
    .sort((a, b) => b.hits - a.hits || b.kudos - a.kudos || b.time - a.time)
    .map((x) => x.item);
}

// All term lists of size n-1 (each term dropped once). Used when the full AND returns too few posts.
export function dropOne(terms) {
  return terms.length < 2 ? [] : terms.map((_, i) => terms.filter((__, j) => j !== i));
}

const stripTags = (html = "") =>
  html.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

// Hits shaped like communityBestMatch's BestMatchHit: { postId, title, url, snippet, likes }.
export function itemsToHits(items, normalizeUrl) {
  return items.map((item) => ({
    postId: String(item.id ?? ""),
    title: item.subject || "",
    url: normalizeUrl(item.view_href || "", String(item.id ?? "")),
    snippet: item.search_snippet ? stripTags(item.search_snippet).slice(0, 500) : undefined,
    likes: item.kudos?.sum?.weight ?? undefined,
  }));
}

// AND over all significant terms; if that finds fewer than `k` unique posts, also try every
// "one term dropped" AND and merge. `execute(url) -> items[]` is injected (network in production).
// Returns { items, level } where level 0 = full AND, 1 = relaxed by one term.
export async function andSearch({ query, k, minKudos, execute }) {
  const terms = significantTerms(query);
  if (terms.length === 0) return { items: [], level: 0, terms };
  const limit = Math.max(k * 2, 20);
  const byId = new Map();
  const add = (items) => items.forEach((it) => byId.has(String(it.id)) || byId.set(String(it.id), it));

  add(await execute(buildAndLiqlUrl(terms, limit, minKudos)));
  let level = 0;
  if (byId.size < k) {
    level = 1;
    const relaxed = await Promise.all(dropOne(terms).map((ts) => execute(buildAndLiqlUrl(ts, limit, minKudos))));
    relaxed.forEach(add);
  }
  return { items: rankItems([...byId.values()], terms).slice(0, k), level, terms };
}

// Production wiring: real HTTP and the real URL normaliser from the built code.
export async function searchCommunityAnd(query, { k, minKudos }) {
  const { pathToFileURL } = await import("node:url");
  const { resolve } = await import("node:path");
  const { normalizeCommunityUrl } = await import(pathToFileURL(resolve("dist/src/lib/communityBestMatch.js")).href);
  const execute = async (url) => {
    const res = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "SAP-Docs-MCP-eval/1.0" } });
    if (!res.ok) throw new Error(`LiQL HTTP ${res.status}`);
    const data = await res.json();
    return data.status === "success" ? (data.data?.items ?? []) : [];
  };
  const { items, level, terms } = await andSearch({ query, k, minKudos, execute });
  console.log(`  [and] terms=${terms.join(",")} level=${level} results=${items.length}`);
  return itemsToHits(items, normalizeCommunityUrl);
}
