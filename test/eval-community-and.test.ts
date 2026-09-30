import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS module shared with the eval scripts
import { andSearch, buildAndLiqlUrl, dropOne, itemsToHits, rankItems, significantTerms, wholeWordHits } from "./eval/community-strategies.js";

const liql = (url: string) => decodeURIComponent(url.split("?q=")[1]);

describe("significantTerms", () => {
  it("drops stopwords and one-character tokens, keeps technical tokens in query order", () => {
    expect(significantTerms("CAP cds deploy to HANA fails with HDI container error")).toEqual(
      ["cap", "cds", "deploy", "hana", "fails", "hdi", "container", "error"],
    );
    expect(significantTerms("ABAP short dump TIME_OUT in report after select inside loop")).toEqual(
      ["abap", "short", "dump", "time_out", "report", "select", "loop"],
    );
    expect(significantTerms("CAP service returns 403 forbidden with XSUAA scopes and @requires")).toEqual(
      ["cap", "service", "returns", "403", "forbidden", "xsuaa", "scopes", "@requires"],
    );
  });

  it("strips surrounding punctuation, dedupes and caps the count", () => {
    expect(significantTerms('"HANA", hana! (error)')).toEqual(["hana", "error"]);
    expect(significantTerms("a b c")).toEqual([]);
    expect(significantTerms("one two three four five six seven eight nine ten").length).toBe(8);
    expect(significantTerms("")).toEqual([]);
  });
});

describe("buildAndLiqlUrl", () => {
  it("uses ONE MATCHES per field with AND inside the string (several ANDed MATCHES are rejected by LiQL)", () => {
    const q = liql(buildAndLiqlUrl(["cap", "xsuaa", "403"], 20, 1));
    expect(q).toContain("WHERE (subject MATCHES 'cap AND xsuaa AND 403' OR body MATCHES 'cap AND xsuaa AND 403')");
    expect((q.match(/MATCHES/g) ?? []).length).toBe(2); // one per field, never one per term
    expect(q).toContain("AND depth = 0 AND kudos.sum(weight) >= 1 LIMIT 20");
    expect(q).toContain("FROM messages");
  });

  it("omits the kudos clause at 0 and escapes single quotes", () => {
    const q = liql(buildAndLiqlUrl(["it's"], 5, 0));
    expect(q).toContain("MATCHES 'it\\'s'");
    expect(q).not.toContain("kudos.sum(weight) >=");
  });
});

describe("wholeWordHits and rankItems", () => {
  it("matches whole words only: 'in' is not inside 'Consuming'", () => {
    expect(wholeWordHits("Consuming OData in Datasphere", ["in"])).toBe(1); // the standalone word
    expect(wholeWordHits("Consuming OData", ["in"])).toBe(0);
    expect(wholeWordHits("SAP HANA Cloud", ["hana", "cloud", "cap"])).toBe(2);
    expect(wholeWordHits("dump TIME_OUT raised", ["time_out"])).toBe(1);
    expect(wholeWordHits("call @requires annotation", ["@requires"])).toBe(1);
    expect(wholeWordHits("sap.m.Button sample", ["sap.m.button"])).toBe(1);
  });

  it("ranks by subject term hits, then kudos, then recency", () => {
    const items = [
      { id: 1, subject: "HANA notes", kudos: { sum: { weight: 9 } }, post_time: "2020-01-01" },
      { id: 2, subject: "CAP HANA deploy", kudos: { sum: { weight: 1 } }, post_time: "2020-01-01" },
      { id: 3, subject: "HANA notes", kudos: { sum: { weight: 9 } }, post_time: "2024-01-01" },
      { id: 4, subject: "HANA notes", kudos: { sum: { weight: 2 } }, post_time: "2025-01-01" },
    ];
    expect(rankItems(items, ["cap", "hana", "deploy"]).map((i: { id: number }) => i.id)).toEqual([2, 3, 1, 4]);
  });
});

describe("andSearch (mock LiQL)", () => {
  const item = (id: number, subject = `post ${id}`) => ({ id, subject, view_href: `/t5/x/ba-p/${id}`, kudos: { sum: { weight: 1 } } });

  it("uses the full AND and stops when it finds enough", async () => {
    const urls: string[] = [];
    const execute = async (url: string) => { urls.push(url); return [item(1), item(2), item(3)]; };
    const r = await andSearch({ query: "cap xsuaa scopes", k: 3, minKudos: 1, execute });
    expect(r.level).toBe(0);
    expect(urls).toHaveLength(1);
    expect(r.items).toHaveLength(3);
  });

  it("relaxes by dropping one term at a time when the full AND is too thin, and merges unique posts", async () => {
    const urls: string[] = [];
    const execute = async (url: string) => {
      urls.push(liql(url));
      const nTerms = (/MATCHES '([^']*)' OR/.exec(liql(url))?.[1] ?? "").split(" AND ").length; // terms ANDed in the string
      if (nTerms === 3) return []; // the full AND finds nothing
      return nTerms === 2 ? [item(urls.length), item(99, "shared post")] : [];
    };
    const r = await andSearch({ query: "alpha beta gamma", k: 3, minKudos: 1, execute });
    expect(r.level).toBe(1);
    expect(urls).toHaveLength(1 + 3); // full AND + one request per dropped term
    const ids = r.items.map((i: { id: number }) => i.id);
    expect(new Set(ids).size).toBe(ids.length); // the shared post is not duplicated
    expect(ids).toContain(99);
  });

  it("returns nothing (and makes no request) for a query with no significant terms", async () => {
    let calls = 0;
    const r = await andSearch({ query: "how to do it", k: 5, minKudos: 1, execute: async () => { calls++; return []; } });
    expect(r.items).toEqual([]);
    expect(calls).toBe(0);
  });

  it("dropOne yields each (n-1)-term subset", () => {
    expect(dropOne(["a", "b", "c"])).toEqual([["b", "c"], ["a", "c"], ["a", "b"]]);
    expect(dropOne(["a"])).toEqual([]);
  });
});

describe("itemsToHits", () => {
  it("maps LiQL items to the hit shape the producer expects", () => {
    const hits = itemsToHits(
      [{ id: 42, subject: "T", view_href: "/t5/q/qaq-p/42", search_snippet: "<b>hi</b> &amp; bye", kudos: { sum: { weight: 3 } } }],
      (href: string, id: string) => `https://c.sap.com${href}?id=${id}`,
    );
    expect(hits).toEqual([{ postId: "42", title: "T", url: "https://c.sap.com/t5/q/qaq-p/42?id=42", snippet: "hi & bye", likes: 3 }]);
  });
});
