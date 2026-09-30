import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS module shared with the eval scripts
import { parseSearxResults, searxngSearch } from "./eval/community-searxng.js";

const r = (url: string, title = "t") => ({ url, title, content: `snippet of ${title}` });
const POST = (n: number, kind = "qaq-p") => `https://community.sap.com/t5/technology-q-a/some-slug/${kind}/${n}`;

describe("parseSearxResults", () => {
  it("keeps only community post permalinks, in the engine's order, unique by post id", () => {
    const hits = parseSearxResults({
      results: [
        r("https://stackoverflow.com/questions/1", "so"),
        r(POST(111), "first"),
        r("https://community.sap.com/t5/technology-q-a/bd-p/technology-questions", "board page"), // no post id
        r("https://community.sap.com/t5/user/viewprofilepage/user-id/5", "profile"),
        r(`${POST(222, "ba-p")}?utm=x`, "blog"),
        r(POST(111), "duplicate of first"),
        r("https://community.sap.com/t5/technology-q-a/x/m-p/333#M1", "reply permalink"),
      ],
    });
    expect(hits.map((h: { postId: string }) => h.postId)).toEqual(["111", "222", "333"]);
    expect(hits[0]).toMatchObject({ title: "first", snippet: "snippet of first" });
  });

  it("tolerates empty or malformed responses", () => {
    expect(parseSearxResults(undefined)).toEqual([]);
    expect(parseSearxResults({})).toEqual([]);
    expect(parseSearxResults({ results: [{}] })).toEqual([]);
  });
});

describe("searxngSearch", () => {
  const pages = (...perPage: object[][]) => {
    const urls: string[] = [];
    const getJson = async (url: string) => { urls.push(decodeURIComponent(url)); return { results: perPage[urls.length - 1] ?? [] }; };
    return { urls, getJson };
  };
  const sleeps: number[] = [];
  const sleep = async (ms: number) => { sleeps.push(ms); };

  it("restricts the query to the site and asks for JSON", async () => {
    const { urls, getJson } = pages([r(POST(1))]);
    await searxngSearch({ query: "cap xsuaa 403", k: 1, baseUrl: "https://s.example/", getJson, sleep });
    expect(urls[0]).toBe("https://s.example/search?q=site:community.sap.com cap xsuaa 403&format=json&language=en&pageno=1");
  });

  it("pages (with a pause) until k unique posts, then stops and trims to k", async () => {
    sleeps.length = 0;
    const { urls, getJson } = pages([r(POST(1)), r("https://example.com/x")], [r(POST(2)), r(POST(1))], [r(POST(3)), r(POST(4))]);
    const hits = await searxngSearch({ query: "q", k: 3, baseUrl: "https://s.example", getJson, sleep, pauseMs: 100 });
    expect(hits.map((h: { postId: string }) => h.postId)).toEqual(["1", "2", "3"]);
    expect(urls).toHaveLength(3);
    expect(sleeps).toEqual([100, 100]); // a pause before every page after the first
  });

  it("stops at an empty page and at maxPages", async () => {
    const empty = pages([r(POST(1))], []);
    expect(await searxngSearch({ query: "q", k: 5, baseUrl: "https://s.example", getJson: empty.getJson, sleep })).toHaveLength(1);
    expect(empty.urls).toHaveLength(2);
    const endless = pages([r(POST(1))], [r(POST(2))], [r(POST(3))], [r(POST(4))]);
    const hits = await searxngSearch({ query: "q", k: 99, baseUrl: "https://s.example", getJson: endless.getJson, sleep, maxPages: 2 });
    expect(hits).toHaveLength(2);
    expect(endless.urls).toHaveLength(2);
  });

  it("propagates request errors (a 429 must show up as a failed query, never be retried around)", async () => {
    const getJson = async () => { throw new Error("SearXNG HTTP 429"); };
    await expect(searxngSearch({ query: "q", k: 3, baseUrl: "https://s.example", getJson, sleep })).rejects.toThrow("429");
  });
});
