import { randomUUID } from "node:crypto";
import type { AppConfig } from "../core/config.js";
import {
  allowedDomainsFromSeeds,
  crawlSeedsForDomain,
  isCorpusOnlyDomain,
  resolveDomainAccessType,
  resolveDomainSeeds,
} from "../core/domain-seeds.js";
import type { Orchestrator } from "../core/orchestrator.js";
import {
  createSession,
  respondAlgorithm,
  type ChatDocument,
  type ChatReply,
  type ChatSession,
} from "./algorithm-chatbot.js";
import { prioritizeSeedsForQuestion } from "./retrieval-ranker.js";
import { assertLiveSeeds, pagesToLiveDocuments } from "./live-data-policy.js";
import { deepWebHelpForDomain, loadDeepWebKnowledge } from "../sources/deep-web-service.js";

const sessions = new Map<string, ChatSession>();

export interface ChatRequest {
  message: string;
  sessionId?: string;
  domain?: string;
  seeds?: string[];
  maxDepth?: number;
  maxPages?: number;
  timeoutMs?: number;
  /** Merge authenticated deep-web corpus (e.g. Scribd) into public-domain chat. */
  includeScribd?: boolean;
  forceScribdSync?: boolean;
}

export interface ChatResponse extends ChatReply {
  sessionId: string;
  crawled: boolean;
  jobId?: string;
  livePageCount: number;
  deepWebDocumentCount?: number;
  deepWebSynced?: boolean;
  /** @deprecated */ scribdDocumentCount?: number;
  /** @deprecated */ scribdSynced?: boolean;
}

function getOrCreateSession(sessionId?: string): ChatSession {
  if (sessionId && sessions.has(sessionId)) {
    return sessions.get(sessionId)!;
  }
  const session = createSession(sessionId ?? randomUUID());
  sessions.set(session.id, session);
  return session;
}

function resolveLiveSeeds(req: ChatRequest): string[] {
  const seeds =
    req.seeds?.filter(Boolean) ??
    (req.domain?.trim() ? crawlSeedsForDomain(req.domain) : []);
  return assertLiveSeeds(seeds);
}

async function crawlLiveDocuments(
  orchestrator: Orchestrator,
  req: ChatRequest,
): Promise<{ documents: ChatDocument[]; jobId?: string; seeds: string[] }> {
  const topic = req.message.trim();
  const seeds = prioritizeSeedsForQuestion(resolveLiveSeeds(req), topic);

  const timeoutMs = req.timeoutMs ?? 120_000;
  const pollMs = 1500;
  const job = await orchestrator.submitJob({
    seeds,
    maxDepth: req.maxDepth ?? 2,
    maxPages: req.maxPages ?? 15,
    includeArchive: false,
    includeSitemaps: false,
    jsRendering: false,
    topic,
    topicFollowRelated: false,
    allowedDomains: allowedDomainsFromSeeds(seeds),
  });

  const finished = await orchestrator.waitForJob(job.id, { timeoutMs, pollMs });
  if (!finished || finished.status !== "completed") {
    throw new Error(`CRAWL_INCOMPLETE:${finished?.status ?? "unknown"}`);
  }

  const pages = orchestrator.listPagesWithText(job.id, req.maxPages ?? 15, 0);
  const allowed = allowedDomainsFromSeeds(seeds);
  const documents = pagesToLiveDocuments(pages, allowed);
  if (!documents.length) {
    throw new Error("LIVE_DATA_REQUIRED — crawl completed but no live web pages were retrieved");
  }

  return { documents, jobId: job.id, seeds };
}

async function resolveChatDocuments(
  config: AppConfig,
  orchestrator: Orchestrator,
  req: ChatRequest,
): Promise<{
  documents: ChatDocument[];
  seeds: string[];
  jobId?: string;
  deepWebDocumentCount: number;
  deepWebSynced: boolean;
  crawled: boolean;
}> {
  const domain = req.domain?.trim() ?? "";
  const accessType = domain ? resolveDomainAccessType(domain) : "public";
  const corpusOnly = isCorpusOnlyDomain(domain);
  const wantsDeep =
    corpusOnly ||
    accessType === "hybrid" ||
    req.includeScribd === true;

  let deepDocs: ChatDocument[] = [];
  let deepSynced = false;

  if (wantsDeep && domain) {
    try {
      const deep = await loadDeepWebKnowledge({
        domain,
        forceSync: req.forceScribdSync,
        includeScribd: req.includeScribd,
        config,
      });
      deepDocs = deep.documents;
      deepSynced = deep.synced;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (corpusOnly) {
        throw new Error(`${msg}\n\n${deepWebHelpForDomain(domain)}`);
      }
      console.warn(`[deep-web] optional corpus skipped: ${msg}`);
    }
  }

  if (corpusOnly) {
    if (!deepDocs.length) {
      throw new Error(`DEEP_CORPUS_EMPTY — no deep-web corpus for domain "${domain}"`);
    }
    return {
      documents: deepDocs,
      seeds: resolveDomainSeeds(domain).length
        ? [resolveDomainSeeds(domain)[0]]
        : [`deep-web://${domain}`],
      deepWebDocumentCount: deepDocs.length,
      deepWebSynced: deepSynced,
      crawled: false,
    };
  }

  let crawledDocs: ChatDocument[] = [];
  let jobId: string | undefined;
  let seeds: string[] = resolveLiveSeeds(req);

  try {
    const crawled = await crawlLiveDocuments(orchestrator, req);
    crawledDocs = crawled.documents;
    jobId = crawled.jobId;
    seeds = crawled.seeds;
  } catch (err) {
    if (accessType === "hybrid" && deepDocs.length) {
      console.warn(`[deep-web] hybrid crawl failed, using corpus only: ${err instanceof Error ? err.message : err}`);
    } else {
      throw err;
    }
  }

  const documents = [...deepDocs, ...crawledDocs];
  if (!documents.length) {
    throw new Error("LIVE_DATA_REQUIRED — no documents from deep corpus or live crawl");
  }

  return {
    documents,
    seeds,
    jobId,
    deepWebDocumentCount: deepDocs.length,
    deepWebSynced: deepSynced,
    crawled: crawledDocs.length > 0,
  };
}

export async function handleChat(
  config: AppConfig,
  orchestrator: Orchestrator,
  req: ChatRequest,
): Promise<ChatResponse> {
  const message = req.message.trim();
  if (!message) throw new Error("message required");

  const session = getOrCreateSession(req.sessionId);
  const resolved = await resolveChatDocuments(config, orchestrator, req);

  const reply = respondAlgorithm(session, message, resolved.documents, resolved.seeds);
  sessions.set(reply.session.id, reply.session);

  return {
    ...reply,
    sessionId: reply.session.id,
    crawled: resolved.crawled,
    jobId: resolved.jobId,
    livePageCount: resolved.documents.length,
    deepWebDocumentCount: resolved.deepWebDocumentCount,
    deepWebSynced: resolved.deepWebSynced,
    scribdDocumentCount: resolved.deepWebDocumentCount,
    scribdSynced: resolved.deepWebSynced,
  };
}

/** Test helper — clear in-memory sessions. */
export function resetChatSessions(): void {
  sessions.clear();
}
