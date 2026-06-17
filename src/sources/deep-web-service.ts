import type { ChatDocument } from "../chat/algorithm-chatbot.js";
import type { AppConfig } from "../core/config.js";
import {
  resolveDomainAccessType,
  resolveDomainAdapter,
  resolveDomainIngestList,
  resolveDomainSeeds,
  type DomainAccessType,
} from "../core/domain-seeds.js";
import {
  getAuthenticatedSource,
  listAuthenticatedSourceIds,
  type AuthenticatedLoadResult,
} from "./authenticated-source.js";
import { upsertManifestEntry } from "./corpus-index.js";
import { defaultCorpusPath } from "./scribd-corpus.js";
import {
  ingestToChatDocuments,
  loadIngestKnowledge,
  parseUrlListFile,
  syncIngestUrlsForDomain,
} from "./url-ingest.js";
import "./register-adapters.js";

export interface DeepWebLoadOptions {
  domain: string;
  forceSync?: boolean;
  /** Back-compat: merge Scribd even on public domains. */
  includeScribd?: boolean;
  config?: AppConfig;
  root?: string;
}

export interface DeepWebLoadResult {
  documents: ChatDocument[];
  accessType: DomainAccessType;
  authenticatedCount: number;
  ingestCount: number;
  synced: boolean;
  adapter?: string;
}

async function loadAuthenticatedAdapter(
  adapterId: string,
  forceSync?: boolean,
): Promise<AuthenticatedLoadResult | null> {
  const adapter = getAuthenticatedSource(adapterId);
  if (!adapter) return null;
  const result = await adapter.load({ forceSync });
  upsertManifestEntry({
    sourceId: adapterId,
    adapter: adapterId,
    documentCount: result.documents.length,
    syncedAt: result.syncedAt,
    corpusPath: defaultCorpusPath(),
  });
  return result;
}

export async function loadDeepWebKnowledge(opts: DeepWebLoadOptions): Promise<DeepWebLoadResult> {
  const domain = opts.domain.trim().toLowerCase();
  const accessType = resolveDomainAccessType(domain);
  const adapterId = resolveDomainAdapter(domain);
  const ingestList = resolveDomainIngestList(domain);
  const root = opts.root;

  const documents: ChatDocument[] = [];
  let authenticatedCount = 0;
  let ingestCount = 0;
  let synced = false;

  const mergeAuth = async (id: string) => {
    const result = await loadAuthenticatedAdapter(id, opts.forceSync);
    if (!result) return;
    documents.push(...result.documents);
    authenticatedCount += result.documents.length;
    synced = synced || result.synced;
  };

  if (accessType === "authenticated" || accessType === "hybrid") {
    if (!adapterId) {
      throw new Error(`DEEP_AUTH_ADAPTER_MISSING — domain "${domain}" requires adapter in domain-seeds.yaml`);
    }
    await mergeAuth(adapterId);
  }

  if (opts.includeScribd && adapterId !== "scribd") {
    await mergeAuth("scribd");
  }

  const wantsIngest =
    accessType === "ingest" || accessType === "hybrid" || Boolean(ingestList);

  if (wantsIngest) {
    if (opts.forceSync && opts.config && ingestList) {
      const urls = parseUrlListFile(ingestList, root);
      await syncIngestUrlsForDomain(opts.config, domain, urls);
      synced = true;
    }
    const ingestDocs = ingestToChatDocuments(domain, root);
    documents.push(...ingestDocs);
    ingestCount = ingestDocs.length;
  }

  if (accessType === "ingest" && !ingestCount && !ingestList) {
    throw new Error(
      `DEEP_INGEST_EMPTY — add ingest_list to domain-seeds.yaml and run: omnispider ingest sync -d ${domain}`,
    );
  }

  if (accessType === "authenticated" && !authenticatedCount) {
    throw new Error(
      `DEEP_AUTH_EMPTY — sync first: omnispider sources sync ${adapterId ?? "scribd"}`,
    );
  }

  return {
    documents,
    accessType,
    authenticatedCount,
    ingestCount,
    synced,
    adapter: adapterId,
  };
}

export async function syncDeepWebSource(
  sourceId: string,
  opts: { force?: boolean; config?: AppConfig; domain?: string } = {},
): Promise<{ documentCount: number; synced: boolean }> {
  const adapter = getAuthenticatedSource(sourceId);
  if (adapter) {
    const result = await adapter.load({ forceSync: opts.force ?? true });
    return { documentCount: result.documents.length, synced: result.synced };
  }

  const domain = opts.domain ?? sourceId.replace(/^ingest:/, "");
  const listPath = resolveDomainIngestList(domain);
  if (!listPath || !opts.config) {
    throw new Error(`DEEP_INGEST_SYNC — provide config and ingest_list for domain "${domain}"`);
  }
  const urls = parseUrlListFile(listPath);
  const { documents } = await syncIngestUrlsForDomain(opts.config, domain, urls);
  return { documentCount: documents.length, synced: true };
}

export function listDeepWebSources(): Array<{ id: string; kind: "authenticated" }> {
  return listAuthenticatedSourceIds().map((id) => ({ id, kind: "authenticated" as const }));
}

export function deepWebHelpForDomain(domain: string): string {
  const type = resolveDomainAccessType(domain);
  const adapter = resolveDomainAdapter(domain);
  const lines = [`Domain "${domain}" access type: ${type}`];
  if (adapter) lines.push(`  Login:  omnispider sources login ${adapter}`);
  if (adapter) lines.push(`  Sync:   omnispider sources sync ${adapter}`);
  if (resolveDomainIngestList(domain)) {
    lines.push(`  Ingest: omnispider ingest sync -d ${domain}`);
  }
  if (type === "hybrid") {
    lines.push("  Retrieval: local corpus first, then live crawl.");
  }
  if (type === "public") {
    lines.push("  Retrieval: live crawl (optionally merge deep corpus with --include-scribd).");
  }
  lines.push(`  Seeds: ${resolveDomainSeeds(domain).join(", ") || "(none — corpus-only domain)"}`);
  return lines.join("\n");
}


export { loadIngestKnowledge };
