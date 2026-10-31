/**
 * SAP Help and SAP Community requests must carry a timeout signal, so a stalled
 * upstream aborts the call instead of hanging the tool. fetch is stubbed with a
 * request that never answers and only ends when its signal aborts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const hangUntilAborted = (_url: unknown, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
  });

describe("outbound timeouts", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("SAP_HELP_TIMEOUT_MS", "50");
    vi.stubEnv("SAP_COMMUNITY_TIMEOUT_MS", "50");
    vi.stubGlobal("fetch", vi.fn(hangUntilAborted));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("SAP Community post fetch gives up and returns no posts", async () => {
    const { getCommunityPostsByIds } = await import("../src/lib/communityBestMatch.js");
    const started = Date.now();
    await expect(getCommunityPostsByIds(["1"])).resolves.toEqual({});
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("SAP Community search rejects instead of hanging when every request stalls", async () => {
    const { searchCommunityBestMatch } = await import("../src/lib/communityBestMatch.js");
    await expect(searchCommunityBestMatch("rap draft")).rejects.toThrow();
  });

  it("SAP Community search keeps the results of the requests that succeed", async () => {
    // The first request answers; the remaining ones stall until they time out.
    const ok = { ok: true, json: async () => ({ status: "success", data: { items: [
      { id: 7, subject: "RAP draft", view_href: "/t5/x/ba-p/7", post_time: "2026-01-01T00:00:00Z" },
    ] } }) } as Response;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(ok).mockImplementation(hangUntilAborted));
    const { searchCommunityBestMatch } = await import("../src/lib/communityBestMatch.js");
    const hits = await searchCommunityBestMatch("rap draft");
    expect(hits).toHaveLength(1);
  });

  it("SAP Help search does not hang", async () => {
    const { searchSapHelp } = await import("../src/lib/sapHelp.js");
    const started = Date.now();
    await searchSapHelp("rap draft", "latest").catch(() => {});
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
