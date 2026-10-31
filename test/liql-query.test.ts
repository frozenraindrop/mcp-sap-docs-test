/**
 * buildLiqlSearchUrl pastes user input into a LiQL string. Verified against the live API:
 * a quote is escaped by doubling it (it''s -> 200), while the old backslash form (it\'s) was a 400
 * because a backslash is a plain character in LiQL.
 */
import { describe, it, expect } from "vitest";
import { buildLiqlSearchUrl } from "../src/lib/communityBestMatch.js";

const liql = (url: string) => decodeURIComponent(new URL(url).searchParams.get("q")!);

describe("buildLiqlSearchUrl", () => {
  it("doubles a single quote so it cannot end the string", () => {
    expect(liql(buildLiqlSearchUrl("what's new", 20, true))).toContain("MATCHES 'what''s new'");
  });

  it("leaves a backslash alone and still doubles the quote after it", () => {
    expect(liql(buildLiqlSearchUrl("a\' OR 1", 20, true))).toContain("MATCHES 'a\'' OR 1'");
  });

  it("ignores a non-numeric minKudos and limit instead of pasting them", () => {
    const q = liql(buildLiqlSearchUrl("x", "5 OR 1=1" as never, true, "1 OR 1=1" as never));
    expect(q).not.toContain("OR 1=1");
    expect(q).toContain("LIMIT 20");
    expect(q).not.toContain(">=");
  });

  it("keeps a numeric minKudos", () => {
    expect(liql(buildLiqlSearchUrl("x", 20, true, 3))).toContain("kudos.sum(weight) >= 3");
  });
});
