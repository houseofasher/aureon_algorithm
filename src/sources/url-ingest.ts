import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { AppConfig } from "../core/config.js";
import { extractPlainText } from "../core/text-extract.js";
import { isLiveHttpUrl } from "../chat/live-data-policy.js";
import { HttpEngine } from "../engines/registry.js";
import {
  ingestDocumentsToChatDocuments,
  loadIngestDocuments,
  resolveIngestListPath,
  saveIngestDocuments,
  type IngestDocument,
} from "./corpus-index.js";

const MIN_TEXT = 80;

function docId(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 16);
}

export function parseUrlListContent(content: string): string[] {
  const urls = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const token = trimmed.split(/\s+/)[0];
    if (token) urls.add(token);
  }
  return [...urls];
}

export function parseUrlListFile(listPath: string, root = process.cwd()): string[] {
  const resolved = resolveIngestListPath(listPath, root);
  if (!existsSync(resolved)) {
    throw new Error(`INGEST_LIST_MISSING — file not found: ${listPath}`);
  }
  return parseUrlListContent(readFileSync(resolved, "utf8"));
}

export function validateIngestUrls(urls: string[]): {
  valid: string[];
  rejected: Array<{ url: string; reason: string }>;
} {
  const valid: string[] = [];
  const rejected: Array<{ url: string; reason: string }> = [];
  for (const url of urls) {
    if (!isLiveHttpUrl(url)) {
      rejected.push({ url, reason: "not_public_http_url" });
      continue;
    }
    valid.push(url);
  }
  return { valid, rejected };
}

async function fetchIngestPage(
  config: AppConfig,
  url: string,
): Promise<{ title: string; text: string } | null> {
  const engine = new HttpEngine(config);
  const result = await engine.fetch(url);
  if (result.statusCode < 200 || result.statusCode >= 400 || !result.body.length) return null;
  const text = extractPlainText(result.body.toString("utf8"));
  if (text.length < MIN_TEXT) return null;
  let title = url;
  try {
    const match = result.body.toString("utf8").match(/<title[^>]*>([^<]+)<\/title>/i);
    if (match?.[1]) title = match[1].replace(/\s+/g, " ").trim();
  } catch {
    /* keep url as title */
  }
  return { title, text };
}

export async function syncIngestUrlsForDomain(
  config: AppConfig,
  domain: string,
  urls: string[],
): Promise<{ documents: IngestDocument[]; rejected: Array<{ url: string; reason: string }> }> {
  const { valid, rejected } = validateIngestUrls(urls);
  const now = new Date().toISOString();
  const sourceId = `ingest:${domain.trim().toLowerCase()}`;
  const documents: IngestDocument[] = [];

  for (const url of valid) {
    try {
      const page = await fetchIngestPage(config, url);
      if (!page) {
        rejected.push({ url, reason: "fetch_failed_or_too_short" });
        continue;
      }
      documents.push({
        id: docId(url),
        title: page.title,
        url,
        text: page.text,
        syncedAt: now,
        sourceId,
      });
    } catch {
      rejected.push({ url, reason: "fetch_error" });
    }
  }

  if (documents.length) {
    saveIngestDocuments(domain, documents);
  }

  return { documents, rejected };
}

export function loadIngestKnowledge(domain: string, root = process.cwd()): IngestDocument[] {
  return loadIngestDocuments(domain, root);
}

export function ingestToChatDocuments(domain: string, root = process.cwd()) {
  return ingestDocumentsToChatDocuments(loadIngestDocuments(domain, root));
}
