import { describe, it, expect } from "vitest";
import {
  isCorpusStale,
  isLocalImportUrl,
  localImportUrl,
  scribdDocumentsToChatDocuments,
  type ScribdCorpus,
} from "../src/sources/scribd-corpus.js";
import { isScribdDomain } from "../src/sources/scribd-service.js";
import { isScribdHttpUrl, isScribdLibraryUrl, normalizeDocUrl } from "../src/sources/scribd.js";

describe("scribd corpus", () => {
  it("detects scribd domain slug", () => {
    expect(isScribdDomain("scribd")).toBe(true);
    expect(isScribdDomain("computer_science")).toBe(false);
  });

  it("converts synced docs to live chat documents", () => {
    const docs = scribdDocumentsToChatDocuments([
      {
        id: "abc",
        title: "Introduction to Algorithms",
        url: "https://www.scribd.com/document/123/intro",
        text: "An algorithm is a finite sequence of rigorous instructions, typically used to solve a class of specific problems or to perform a computation.",
        syncedAt: "2026-06-07T12:00:00.000Z",
        source: "scribd_library",
      },
    ]);
    expect(docs).toHaveLength(1);
    expect(docs[0].source).toBe("live");
    expect(docs[0].url).toContain("scribd.com");
  });

  it("marks corpus stale after ttl", () => {
    const corpus: ScribdCorpus = {
      syncedAt: new Date(Date.now() - 48 * 3600_000).toISOString(),
      libraryUrl: "https://www.scribd.com/home",
      documents: [
        {
          id: "x",
          title: "Cached",
          url: "https://www.scribd.com/document/1/x",
          text: "A".repeat(80),
          syncedAt: new Date(Date.now() - 48 * 3600_000).toISOString(),
          source: "scribd_library",
        },
      ],
    };
    expect(isCorpusStale(corpus, 24)).toBe(true);
    expect(isCorpusStale(corpus, 0)).toBe(false);
  });

  it("treats invalid syncedAt as stale", () => {
    const corpus: ScribdCorpus = {
      syncedAt: "not-a-date",
      libraryUrl: "https://www.scribd.com/home",
      documents: [
        {
          id: "x",
          title: "Cached",
          url: "https://www.scribd.com/document/1/x",
          text: "A".repeat(80),
          syncedAt: "2026-06-07T12:00:00.000Z",
          source: "scribd_library",
        },
      ],
    };
    expect(isCorpusStale(corpus, 24)).toBe(true);
  });

  it("uses non-http scheme for local imports", () => {
    const url = localImportUrl("notes.md");
    expect(isLocalImportUrl(url)).toBe(true);
    expect(isScribdHttpUrl(url)).toBe(false);
  });

  it("validates scribd document and library urls", () => {
    expect(isScribdHttpUrl("https://www.scribd.com/document/123/intro")).toBe(true);
    expect(isScribdHttpUrl("https://evil.com/document/123")).toBe(false);
    expect(isScribdLibraryUrl("https://www.scribd.com/home")).toBe(true);
    expect(isScribdLibraryUrl("https://example.com/home")).toBe(false);
  });

  it("normalizes document urls by stripping query and hash", () => {
    expect(normalizeDocUrl("https://scribd.com/document/1/x?ref=home#section")).toBe(
      "https://www.scribd.com/document/1/x",
    );
  });
});
