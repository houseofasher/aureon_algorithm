import { createHash } from "node:crypto";
import { existsSync, readFileSync, appendFileSync } from "node:fs";
import type { AppConfig } from "../core/config.js";
import { isDeepWebUncensored } from "../core/deep-web-config.js";
import { extractPlainText } from "../core/text-extract.js";
import { isLiveHttpUrl } from "../chat/live-data-policy.js";
import { HttpEngine } from "../engines/registry.js";
import {
  ingestDocumentsToChatDocuments,
  loadIngestDocuments,
  loadCorpusManifest,
  resolveIngestListPath,
  saveIngestDocuments,
  type IngestDocument,
} from "./corpus-index.js";
import { publishCorpusUpdate } from "../sync/corpus-publisher.js";
import { resolveDeepWebConfig } from "../core/deep-web-config.js";

const MIN_TEXT_DEFAULT = 80;
const MIN_TEXT_UNCENSORED = 1;

function minTextLength(): number {
  return isDeepWebUncensored() ? MIN_TEXT_UNCENSORED : MIN_TEXT_DEFAULT;
}

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
  if (text.length < minTextLength()) return null;
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
    await publishIngestUpdate(domain, documents.length, documents);
  }

  return { documents, rejected };
}

/** Append new URLs to the ingest list file (deduped). Returns URLs actually added. */
export function appendUrlsToIngestList(
  listPath: string,
  urls: string[],
  root = process.cwd(),
): string[] {
  const resolved = resolveIngestListPath(listPath, root);
  const existing = existsSync(resolved)
    ? new Set(parseUrlListContent(readFileSync(resolved, "utf8")))
    : new Set<string>();
  const added: string[] = [];
  for (const url of urls) {
    const trimmed = url.trim();
    if (!trimmed || existing.has(trimmed)) continue;
    existing.add(trimmed);
    added.push(trimmed);
    appendFileSync(resolved, `${trimmed}\n`, "utf8");
  }
  return added;
}

async function publishIngestUpdate(
  domain: string,
  documentCount: number,
  documents?: IngestDocument[],
): Promise<void> {
  const cfg = resolveDeepWebConfig();
  if (!cfg.webhookUrl && !cfg.frontendDeployHook) return;
  const sourceId = `ingest:${domain.trim().toLowerCase()}`;
  await publishCorpusUpdate(
    {
      sourceId,
      domain,
      documentCount,
      syncedAt: new Date().toISOString(),
      documents: cfg.publishFullText
        ? documents?.map((d) => ({
            id: d.id,
            title: d.title,
            url: d.url,
            text: d.text,
            sourceId: d.sourceId,
            syncedAt: d.syncedAt,
          }))
        : undefined,
      manifest: loadCorpusManifest(),
    },
    { includeDocuments: cfg.publishFullText },
  );
}

/** Fetch and merge URLs into domain corpus; auto-appends to ingest list when configured. */
export async function ingestUrlsForDomain(
  config: AppConfig,
  domain: string,
  urls: string[],
  opts: { listPath?: string; root?: string } = {},
): Promise<{ documents: IngestDocument[]; rejected: Array<{ url: string; reason: string }>; added: string[] }> {
  const root = opts.root ?? process.cwd();
  const { valid, rejected } = validateIngestUrls(urls);
  let added: string[] = [];
  if (opts.listPath) {
    added = appendUrlsToIngestList(opts.listPath, valid, root);
  }

  const existing = loadIngestDocuments(domain, root);
  const byUrl = new Map(existing.map((d) => [d.url, d]));
  const now = new Date().toISOString();
  const sourceId = `ingest:${domain.trim().toLowerCase()}`;

  for (const url of valid) {
    try {
      const page = await fetchIngestPage(config, url);
      if (!page) {
        rejected.push({ url, reason: "fetch_failed_or_too_short" });
        continue;
      }
      byUrl.set(url, {
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

  const documents = [...byUrl.values()];
  if (documents.length) {
    saveIngestDocuments(domain, documents);
    await publishIngestUpdate(domain, documents.length, documents);
  }

  return { documents, rejected, added };
}

export function loadIngestKnowledge(domain: string, root = process.cwd()): IngestDocument[] {
  return loadIngestDocuments(domain, root);
}

export function ingestToChatDocuments(domain: string, root = process.cwd()) {
  return ingestDocumentsToChatDocuments(loadIngestDocuments(domain, root));
}
