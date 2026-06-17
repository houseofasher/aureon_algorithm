import { describe, it, expect } from "vitest";
import {
  crawlSeedsForDomain,
  isScribdDomain,
  loadDomainSeeds,
  resolveDomainAccessType,
  resolveDomainEntry,
} from "../src/core/domain-seeds.js";
import { parseUrlListContent, validateIngestUrls } from "../src/sources/url-ingest.js";
import { listDeepWebSources } from "../src/sources/deep-web-service.js";
import { loadCorpusManifest } from "../src/sources/corpus-index.js";

describe("deep-web domain routing", () => {
  it("assigns access types from domain-seeds.yaml", () => {
    loadDomainSeeds(true);
    expect(resolveDomainAccessType("scribd")).toBe("authenticated");
    expect(resolveDomainAccessType("unlisted_public")).toBe("ingest");
    expect(resolveDomainAccessType("computer_science")).toBe("public");
  });

  it("blocks public crawl seeds for corpus-only domains", () => {
    loadDomainSeeds(true);
    expect(crawlSeedsForDomain("scribd")).toEqual([]);
    expect(crawlSeedsForDomain("unlisted_public")).toEqual([]);
    expect(crawlSeedsForDomain("computer_science").length).toBeGreaterThan(0);
  });

  it("detects scribd via adapter metadata", () => {
    loadDomainSeeds(true);
    expect(isScribdDomain("scribd")).toBe(true);
    expect(isScribdDomain("computer_science")).toBe(false);
  });

  it("resolves ingest_list on ingest domains", () => {
    loadDomainSeeds(true);
    const entry = resolveDomainEntry("unlisted_public");
    expect(entry.ingestList).toContain("url-lists");
  });
});

describe("url ingest", () => {
  it("parses and validates url lists", () => {
    const urls = parseUrlListContent("# comment\nhttps://www.britannica.com/topic/test\n\n");
    expect(urls).toEqual(["https://www.britannica.com/topic/test"]);
    const { valid, rejected } = validateIngestUrls([
      "https://www.britannica.com/topic/x",
      "file:///etc/passwd",
    ]);
    expect(valid).toHaveLength(1);
    expect(rejected).toHaveLength(1);
  });
});

describe("deep-web registry", () => {
  it("registers scribd adapter", () => {
    const ids = listDeepWebSources().map((s) => s.id);
    expect(ids).toContain("scribd");
  });

  it("loads empty corpus manifest by default", () => {
    const m = loadCorpusManifest();
    expect(m.sources).toBeInstanceOf(Array);
  });
});
