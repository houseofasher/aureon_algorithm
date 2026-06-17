import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { publishCorpusUpdate } from "../src/sync/corpus-publisher.js";
import { setDeepWebYamlConfig } from "../src/core/deep-web-config.js";

describe("corpus publisher", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    setDeepWebYamlConfig({});
    delete process.env.CORPUS_WEBHOOK_URL;
    delete process.env.CORPUS_WEBHOOK_SECRET;
    delete process.env.FRONTEND_DEPLOY_HOOK_URL;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts signed payload to webhook", async () => {
    process.env.CORPUS_WEBHOOK_URL = "https://frontend.example/api/corpus/webhook";
    process.env.CORPUS_WEBHOOK_SECRET = "test-secret";

    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));

    await publishCorpusUpdate(
      {
        sourceId: "ingest:unlisted_public",
        domain: "unlisted_public",
        documentCount: 2,
        syncedAt: "2026-01-01T00:00:00.000Z",
        manifest: { updatedAt: "2026-01-01T00:00:00.000Z", sources: [] },
      },
      { includeDocuments: false },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = String(init.body);
    const sig = (init.headers as Record<string, string>)["X-Omnispider-Signature"];
    expect(sig).toBe(`sha256=${createHmac("sha256", "test-secret").update(body).digest("hex")}`);
  });
});
