import type { ChatDocument } from "../chat/algorithm-chatbot.js";
import {
  isCorpusStale,
  loadScribdCorpus,
  scribdDocumentsToChatDocuments,
  type ScribdCorpus,
} from "./scribd-corpus.js";
import { scribdConfigFromEnv, syncScribdLibrary, type ScribdConfig } from "./scribd.js";

export interface ScribdLoadOptions {
  forceSync?: boolean;
  config?: ScribdConfig;
  syncTtlHours?: number;
}

export interface ScribdLoadResult {
  corpus: ScribdCorpus;
  documents: ChatDocument[];
  synced: boolean;
}

let syncInFlight: Promise<ScribdCorpus> | null = null;

function resolveSyncTtlHours(raw: number | undefined): number {
  const value = raw ?? Number(process.env.SCRIBD_SYNC_TTL_HOURS ?? 24);
  if (!Number.isFinite(value)) return 24;
  return Math.max(0, value);
}

export async function loadScribdKnowledge(opts: ScribdLoadOptions = {}): Promise<ScribdLoadResult> {
  const config = opts.config ?? scribdConfigFromEnv();
  const ttl = resolveSyncTtlHours(opts.syncTtlHours);
  let corpus = loadScribdCorpus(config.corpusPath);
  let synced = false;

  const needsSync = !corpus || opts.forceSync || (corpus && isCorpusStale(corpus, ttl));
  if (needsSync) {
    try {
      if (!syncInFlight) {
        syncInFlight = syncScribdLibrary(config).finally(() => {
          syncInFlight = null;
        });
      }
      corpus = await syncInFlight;
      synced = true;
    } catch (err) {
      if (corpus) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[scribd] sync failed, using cached corpus: ${msg}`);
      } else {
        throw err;
      }
    }
  }

  if (!corpus) {
    throw new Error("SCRIBD_EMPTY — sync your library first: omnispider scribd sync");
  }

  return {
    corpus,
    documents: scribdDocumentsToChatDocuments(corpus.documents),
    synced,
  };
}
