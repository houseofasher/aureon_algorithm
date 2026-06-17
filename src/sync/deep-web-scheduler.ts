import type { AppConfig } from "../core/config.js";
import { resolveDeepWebConfig } from "../core/deep-web-config.js";
import { listDeepWebDomains, resolveDomainAdapter } from "../core/domain-seeds.js";
import { syncDeepWebSource } from "../sources/deep-web-service.js";
import { listAuthenticatedSourceIds } from "../sources/authenticated-source.js";
import { publishCorpusUpdate } from "./corpus-publisher.js";
import {
  exportCorpusDocuments,
  loadCorpusManifest,
  type CorpusManifest,
} from "../sources/corpus-index.js";

export interface DeepWebSyncResult {
  domain: string;
  sourceId: string;
  documentCount: number;
  synced: boolean;
  error?: string;
}

export interface DeepWebSyncAllResult {
  syncedAt: string;
  results: DeepWebSyncResult[];
  manifest: CorpusManifest;
  published: boolean;
}

async function publishAfterSync(
  sourceId: string,
  domain: string | undefined,
  documentCount: number,
): Promise<void> {
  const cfg = resolveDeepWebConfig();
  if (!cfg.webhookUrl && !cfg.frontendDeployHook) return;

  const docs = cfg.publishFullText ? exportCorpusDocuments(domain) : undefined;
  await publishCorpusUpdate(
    {
      sourceId,
      domain,
      documentCount,
      syncedAt: new Date().toISOString(),
      documents: docs?.map((d) => ({
        id: d.id ?? d.url,
        title: d.title,
        url: d.url,
        text: d.text,
        sourceId: d.sourceId ?? sourceId,
        syncedAt: d.fetchedAt ?? new Date().toISOString(),
      })),
      manifest: loadCorpusManifest(),
    },
    { includeDocuments: cfg.publishFullText },
  );
}

export async function syncAllDeepWebSources(config: AppConfig): Promise<DeepWebSyncAllResult> {
  const results: DeepWebSyncResult[] = [];
  let published = false;

  for (const { domain, accessType } of listDeepWebDomains()) {
    if (accessType === "public") continue;

    const sourceId =
      accessType === "authenticated"
        ? resolveDomainAdapter(domain) ?? domain
        : `ingest:${domain}`;

    try {
      const result = await syncDeepWebSource(sourceId, {
        force: true,
        config,
        domain: accessType === "ingest" || accessType === "hybrid" ? domain : undefined,
      });
      results.push({
        domain,
        sourceId,
        documentCount: result.documentCount,
        synced: result.synced,
      });
      if (result.documentCount > 0) {
        await publishAfterSync(sourceId, domain, result.documentCount);
        published = true;
      }
    } catch (err) {
      results.push({
        domain,
        sourceId,
        documentCount: 0,
        synced: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  for (const adapterId of listAuthenticatedSourceIds()) {
    if (results.some((r) => r.sourceId === adapterId)) continue;
    try {
      const result = await syncDeepWebSource(adapterId, { force: true, config });
      results.push({
        domain: adapterId,
        sourceId: adapterId,
        documentCount: result.documentCount,
        synced: result.synced,
      });
      if (result.documentCount > 0) {
        await publishAfterSync(adapterId, adapterId, result.documentCount);
        published = true;
      }
    } catch (err) {
      results.push({
        domain: adapterId,
        sourceId: adapterId,
        documentCount: 0,
        synced: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    syncedAt: new Date().toISOString(),
    results,
    manifest: loadCorpusManifest(),
    published,
  };
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startDeepWebScheduler(config: AppConfig): void {
  const cfg = resolveDeepWebConfig();
  if (!cfg.autoSync) return;

  const intervalMs = cfg.syncIntervalHours * 3600_000;

  const run = () => {
    syncAllDeepWebSources(config).catch((err) => {
      console.error("[deep-web] scheduled sync failed:", err instanceof Error ? err.message : err);
    });
  };

  run();
  if (timer) clearInterval(timer);
  timer = setInterval(run, intervalMs);
  console.log(`[deep-web] auto-sync enabled every ${cfg.syncIntervalHours}h`);
}

export function stopDeepWebScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
