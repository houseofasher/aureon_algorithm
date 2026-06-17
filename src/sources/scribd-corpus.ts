import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import type { ChatDocument } from "../chat/algorithm-chatbot.js";

export const SCRIBD_LOCAL_IMPORT_URL_PREFIX = "scribd-import://local/";

const scribdDocumentSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  url: z.string().min(1),
  text: z.string(),
  syncedAt: z.string().datetime(),
  source: z.enum(["scribd_library", "scribd_pdf_import"]),
});

const scribdCorpusSchema = z.object({
  syncedAt: z.string().datetime(),
  libraryUrl: z.string().url(),
  documents: z.array(scribdDocumentSchema),
});

export type ScribdDocument = z.infer<typeof scribdDocumentSchema>;

export interface ScribdCorpus {
  syncedAt: string;
  libraryUrl: string;
  documents: ScribdDocument[];
}

export function defaultCorpusPath(root = process.cwd()): string {
  return join(root, "data", "scribd", "corpus.json");
}

export function localImportUrl(filename: string): string {
  return `${SCRIBD_LOCAL_IMPORT_URL_PREFIX}${encodeURIComponent(filename)}`;
}

export function isLocalImportUrl(url: string): boolean {
  return url.startsWith(SCRIBD_LOCAL_IMPORT_URL_PREFIX);
}

export function loadScribdCorpus(path = defaultCorpusPath()): ScribdCorpus | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    const corpus = scribdCorpusSchema.parse(parsed);
    if (!corpus.documents.length) return null;
    return corpus;
  } catch {
    return null;
  }
}

export function saveScribdCorpus(corpus: ScribdCorpus, path = defaultCorpusPath()): void {
  scribdCorpusSchema.parse(corpus);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(corpus, null, 2), "utf8");
  renameSync(tmp, path);
}

export function scribdDocumentsToChatDocuments(docs: ScribdDocument[]): ChatDocument[] {
  const minLen = 80;
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

export function isCorpusStale(corpus: ScribdCorpus, ttlHours: number): boolean {
  if (!Number.isFinite(ttlHours) || ttlHours <= 0) return false;
  const syncedMs = Date.parse(corpus.syncedAt);
  if (!Number.isFinite(syncedMs)) return true;
  const ageMs = Date.now() - syncedMs;
  return ageMs > ttlHours * 3600_000;
}

/** Ensure corpus path resolves under the project data directory. */
export function assertCorpusPathUnderRoot(corpusPath: string, root = process.cwd()): string {
  const resolved = resolve(corpusPath);
  const dataRoot = resolve(root, "data");
  if (!resolved.startsWith(dataRoot)) {
    throw new Error(`SCRIBD_PATH_BLOCKED — corpus path must stay under ${dataRoot}`);
  }
  return resolved;
}
