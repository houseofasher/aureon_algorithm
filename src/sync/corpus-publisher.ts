import { createHmac } from "node:crypto";
import type { CorpusManifest } from "../sources/corpus-index.js";
import { resolveDeepWebConfig } from "../core/deep-web-config.js";

export interface CorpusDocumentPayload {
  id: string;
  title: string;
  url: string;
  text: string;
  sourceId: string;
  syncedAt: string;
}

export interface CorpusPublishEvent {
  event: "corpus_updated";
  sourceId: string;
  domain?: string;
  documentCount: number;
  syncedAt: string;
  documents?: CorpusDocumentPayload[];
  manifest: CorpusManifest;
}

function signBody(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

async function postJson(url: string, payload: unknown, secret?: string): Promise<void> {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "Omnispider-CorpusPublisher/1.0",
  };
  if (secret) {
    headers["X-Omnispider-Signature"] = `sha256=${signBody(body, secret)}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`webhook_http_${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

export async function publishCorpusUpdate(
  event: Omit<CorpusPublishEvent, "event">,
  opts: { includeDocuments?: boolean } = {},
): Promise<{ webhook?: boolean; deployHook?: boolean }> {
  const cfg = resolveDeepWebConfig();
  const payload: CorpusPublishEvent = {
    event: "corpus_updated",
    ...event,
    documents: opts.includeDocuments ? event.documents : undefined,
  };

  const result: { webhook?: boolean; deployHook?: boolean } = {};

  if (cfg.webhookUrl) {
    await postJson(cfg.webhookUrl, payload, cfg.webhookSecret || undefined);
    result.webhook = true;
  }

  if (cfg.frontendDeployHook) {
    await postJson(cfg.frontendDeployHook, {
      event: "corpus_updated",
      sourceId: event.sourceId,
      documentCount: event.documentCount,
      syncedAt: event.syncedAt,
    });
    result.deployHook = true;
  }

  return result;
}
