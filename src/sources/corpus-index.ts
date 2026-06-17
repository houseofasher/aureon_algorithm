import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import type { ChatDocument } from "../chat/algorithm-chatbot.js";
import { isDeepWebUncensored } from "../core/deep-web-config.js";

const manifestEntrySchema = z.object({
  sourceId: z.string(),
  adapter: z.string().optional(),
  domain: z.string().optional(),
  documentCount: z.number().int().nonnegative(),
  syncedAt: z.string(),
  corpusPath: z.string(),
});

const manifestSchema = z.object({
  updatedAt: z.string(),
  sources: z.array(manifestEntrySchema),
});

export type CorpusManifestEntry = z.infer<typeof manifestEntrySchema>;
export type CorpusManifest = z.infer<typeof manifestSchema>;

export function corpusRoot(root = process.cwd()): string {
  return join(root, "data", "corpus");
}

export function manifestPath(root = process.cwd()): string {
  return join(corpusRoot(root), "manifest.json");
}

export function ingestCorpusPath(domain: string, root = process.cwd()): string {
  const safe = domain.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "_");
  return join(corpusRoot(root), "ingest", `${safe}.json`);
}

export function loadCorpusManifest(root = process.cwd()): CorpusManifest {
  const path = manifestPath(root);
  if (!existsSync(path)) {
    return { updatedAt: new Date(0).toISOString(), sources: [] };
  }
  try {
    return manifestSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return { updatedAt: new Date(0).toISOString(), sources: [] };
  }
}

export function upsertManifestEntry(
  entry: CorpusManifestEntry,
  root = process.cwd(),
): CorpusManifest {
  const manifest = loadCorpusManifest(root);
  const sources = manifest.sources.filter((s) => s.sourceId !== entry.sourceId);
  sources.push(entry);
  const next: CorpusManifest = {
    updatedAt: new Date().toISOString(),
    sources,
  };
  saveCorpusManifest(next, root);
  return next;
}

export function saveCorpusManifest(manifest: CorpusManifest, root = process.cwd()): void {
  manifestSchema.parse(manifest);
  const path = manifestPath(root);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(manifest, null, 2), "utf8");
  renameSync(tmp, path);
}

const ingestDocSchema = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string(),
  text: z.string(),
  syncedAt: z.string(),
});

export type IngestDocument = z.infer<typeof ingestDocSchema> & { sourceId: string };

export function loadIngestDocuments(domain: string, root = process.cwd()): IngestDocument[] {
  const path = ingestCorpusPath(domain, root);
  if (!existsSync(path)) return [];
  try {
    const parsed = z.array(ingestDocSchema).parse(JSON.parse(readFileSync(path, "utf8")));
    const sourceId = `ingest:${domain.trim().toLowerCase()}`;
    return parsed.map((d) => ({ ...d, sourceId }));
  } catch {
    return [];
  }
}

export function saveIngestDocuments(
  domain: string,
  docs: Array<z.infer<typeof ingestDocSchema>>,
  root = process.cwd(),
): void {
  const path = ingestCorpusPath(domain, root);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(docs, null, 2), "utf8");
  renameSync(tmp, path);
  upsertManifestEntry({
    sourceId: `ingest:${domain.trim().toLowerCase()}`,
    domain: domain.trim().toLowerCase(),
    documentCount: docs.length,
    syncedAt: docs[0]?.syncedAt ?? new Date().toISOString(),
    corpusPath: path,
  }, root);
}

export function ingestDocumentsToChatDocuments(docs: IngestDocument[]): ChatDocument[] {
  const minLen = isDeepWebUncensored() ? 1 : 80;
  return docs
    .filter((d) => d.text.length >= minLen)
    .map((d) => ({
      text: d.text,
      url: d.url,
      title: d.title,
      source: "deep" as const,
      fetchedAt: d.syncedAt,
    }));
}

export interface ExportedCorpusDocument {
  id: string;
  title: string;
  url: string;
  text: string;
  sourceId: string;
  fetchedAt: string;
}

export function exportCorpusDocuments(domain?: string, root = process.cwd()): ExportedCorpusDocument[] {
  const out: ExportedCorpusDocument[] = [];
  if (domain) {
    for (const d of loadIngestDocuments(domain, root)) {
      out.push({
        id: d.id,
        title: d.title,
        url: d.url,
        text: d.text,
        sourceId: d.sourceId,
        fetchedAt: d.syncedAt,
      });
    }
    return out;
  }

  const manifest = loadCorpusManifest(root);
  for (const entry of manifest.sources) {
    if (entry.domain) {
      out.push(...exportCorpusDocuments(entry.domain, root));
    }
  }
  return out;
}

export function loadAllIngestDomains(root = process.cwd()): string[] {
  const manifest = loadCorpusManifest(root);
  return [...new Set(manifest.sources.map((s) => s.domain).filter(Boolean) as string[])];
}

/** Simple keyword overlap search across manifest-backed corpora. */
export function searchCorpusDocuments(
  query: string,
  documents: ChatDocument[],
  limit = 50,
): ChatDocument[] {
  const terms = query
    .toLowerCase()
    .split(/\W+/)
    .filter((t) => t.length > 2);
  if (!terms.length) return documents.slice(0, limit);

  const scored = documents.map((doc) => {
    const hay = `${doc.title} ${doc.text}`.toLowerCase();
    const score = terms.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0);
    return { doc, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.doc);
}

export function resolveIngestListPath(listPath: string, root = process.cwd()): string {
  const resolved = resolve(root, listPath);
  const configRoot = resolve(root, "config");
  const dataRoot = resolve(root, "data");
  if (!resolved.startsWith(configRoot) && !resolved.startsWith(dataRoot)) {
    throw new Error(`INGEST_LIST_BLOCKED — list must stay under config/ or data/: ${listPath}`);
  }
  return resolved;
}
