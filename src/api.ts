import Fastify from "fastify";
import cors from "@fastify/cors";
import type { Role } from "./core/models.js";
import type { AppConfig } from "./core/config.js";
import { allowedDomainsFromSeeds, loadDomainSeeds, resolveDomainIngestList, resolveDomainSeeds } from "./core/domain-seeds.js";
import { resolveDeepWebConfig } from "./core/deep-web-config.js";
import { Orchestrator } from "./core/orchestrator.js";
import { buildSecurityStack } from "./security/nomad.js";
import { handleChat } from "./chat/chat-service.js";
import { pagesToLiveDocuments } from "./chat/live-data-policy.js";
import { loadScribdKnowledge } from "./sources/scribd-service.js";
import { scribdLoginHelp } from "./sources/scribd.js";
import { syncDeepWebSource, listDeepWebSources, loadDeepWebKnowledge } from "./sources/deep-web-service.js";
import {
  exportCorpusDocuments,
  loadCorpusManifest,
  searchCorpusDocuments,
} from "./sources/corpus-index.js";
import { ingestUrlsForDomain, ingestToChatDocuments } from "./sources/url-ingest.js";
import { startDeepWebScheduler } from "./sync/deep-web-scheduler.js";
import { formatReportText, runTopicLookup } from "./topic/index.js";
import { prioritizeSeedsForQuestion } from "./chat/retrieval-ranker.js";

const SECURITY_HEADERS: Record<string, string> = {
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
};

export async function startApi(config: AppConfig, host: string, port: number): Promise<void> {
  const security = config.security.enabled ? buildSecurityStack(config) : null;
  const orchestrator = new Orchestrator(config, security);
  orchestrator.init();

  const app = Fastify({ logger: true });

  const deepCfg = resolveDeepWebConfig();
  await app.register(cors, {
    origin: deepCfg.corsOrigins.length ? deepCfg.corsOrigins : true,
    methods: ["GET", "POST", "OPTIONS"],
  });

  app.addHook("onSend", async (_req, reply) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) reply.header(k, v);
  });

  app.addHook("preHandler", async (req, reply) => {
    const path = req.url.split("?")[0];
    if (path === "/health" || path === "/organism/vitals") return;

    if (!security) return;
    if (!security.rateLimiter.tryAcquire()) {
      return reply.code(429).send({ error: "RATE_LIMITED" });
    }
    reply.raw.on("finish", () => security.rateLimiter.release());

    if (!security.vitalGuard.isVital()) {
      return reply.code(503).send({ error: "ORGANISM_LOCKDOWN" });
    }

    const clientIp = req.ip;
    if (!security.allowlist.isAllowed(clientIp)) {
      return reply.code(403).send({ error: "CLIENT_NOT_ALLOWLISTED" });
    }

    if (security.auth.requireAuth && !config.security.devMode) {
      const auth = req.headers.authorization;
      if (!auth?.startsWith("Bearer ")) return reply.code(401).send({ error: "UNAUTHORIZED" });
      const principal = security.auth.verifyToken(auth.slice(7).trim());
      if (!principal) return reply.code(401).send({ error: "UNAUTHORIZED" });
      (req as { principal?: unknown }).principal = principal;
    }

    if (!security.rbac.authorize((req as { principal?: { roles: Role[] } | null }).principal ?? null, req.method, path)) {
      if (!config.security.devMode || security.auth.requireAuth) {
        return reply.code(403).send({ error: "FORBIDDEN" });
      }
    }
  });

  app.get("/health", async () => ({
    status: "ok",
    service: "omnispider",
    version: "1.0.0",
    security: "nomad_cyber",
    organismVital: security?.vitalGuard.isVital() ?? true,
  }));

  app.get("/organism/vitals", async () => security?.vitalGuard.getVitalsReport() ?? {});

  app.post<{ Body: { topic: string; seeds?: string[]; maxDepth?: number; maxPages?: number; exhaustive?: boolean } }>(
    "/v1/lookup",
    async (req, reply) => {
      const { topic, seeds, maxDepth, maxPages, exhaustive } = req.body ?? {};
      if (!topic) return reply.code(400).send({ error: "topic required" });
      const report = await runTopicLookup(config, security, {
        topic,
        extraSeeds: seeds ?? [],
        maxDepth: maxDepth ?? 5,
        maxPages: maxPages ?? 500,
        exhaustive: exhaustive !== false,
        includeArchive: true,
      });
      return { report, text: formatReportText(report) };
    },
  );

  app.get("/v1/domain-seeds", async () => loadDomainSeeds());

  app.get<{ Params: { domain: string } }>("/v1/domain-seeds/:domain", async (req, reply) => {
    const seeds = resolveDomainSeeds(req.params.domain);
    if (!seeds.length) return reply.code(404).send({ error: "No seeds for domain" });
    return { domain: req.params.domain, seeds, allowedDomains: allowedDomainsFromSeeds(seeds) };
  });

  app.post<{ Body: Record<string, unknown> }>("/v1/jobs", async (req, reply) => {
    const body = req.body ?? {};
    const seeds = body.seeds as string[] | undefined;
    if (!seeds?.length) return reply.code(400).send({ error: "seeds required" });
    try {
      const job = await orchestrator.submitJob({
        seeds,
        maxDepth: (body.maxDepth as number) ?? 3,
        maxPages: (body.maxPages as number) ?? 100,
        includeArchive: body.includeArchive !== false,
        includeSitemaps: body.includeSitemaps !== false,
        jsRendering: !!body.jsRendering,
        topic: (body.topic as string) ?? null,
        topicFollowRelated: !!body.topic,
        allowedDomains: (body.allowedDomains as string[] | null) ?? allowedDomainsFromSeeds(seeds),
      });
      return reply.code(202).send(job);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /** Algorithm chatbot — always crawls live web; never test files or archive snapshots. */
  app.post<{ Body: Record<string, unknown> }>("/api/chat", async (req, reply) => {
    const body = req.body ?? {};
    const message = String(body.message ?? body.question ?? "").trim();
    if (!message) return reply.code(400).send({ error: "message required" });
    const domain = String(body.domain ?? "").trim();
    const seeds = Array.isArray(body.seeds) ? (body.seeds as string[]) : undefined;
    if (!domain && !seeds?.length) {
      return reply.code(400).send({ error: "domain or seeds required — chat always uses live crawl data" });
    }
    try {
      const result = await handleChat(config, orchestrator, {
        message,
        sessionId: body.sessionId ? String(body.sessionId) : undefined,
        domain: domain || undefined,
        seeds,
        maxDepth: body.maxDepth != null ? Number(body.maxDepth) : undefined,
        maxPages: body.maxPages != null ? Number(body.maxPages) : undefined,
        timeoutMs: body.timeoutMs != null ? Number(body.timeoutMs) : undefined,
        includeScribd: body.includeScribd === true,
        forceScribdSync: body.forceScribdSync === true,
      });
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith("CRAWL_INCOMPLETE:")) {
        return reply.code(504).send({ error: "CRAWL_INCOMPLETE", status: msg.split(":")[1] });
      }
      if (msg.startsWith("SCRIBD_") || msg.startsWith("DEEP_")) {
        return reply.code(msg.includes("AUTH") ? 401 : 400).send({
          error: msg.split(" — ")[0],
          detail: msg,
          help: scribdLoginHelp(),
        });
      }
      if (msg.startsWith("LIVE_") || msg.startsWith("BLOCKED_")) {
        return reply.code(400).send({ error: msg.split(" — ")[0], detail: msg });
      }
      return reply.code(400).send({ error: msg });
    }
  });

  /** Sync personal Scribd library (https://www.scribd.com/home) into local corpus. */
  app.post<{ Body: Record<string, unknown> }>("/api/scribd/sync", async (req, reply) => {
    try {
      const result = await loadScribdKnowledge({ forceSync: req.body?.forceSync === true });
      return {
        synced: result.synced,
        documentCount: result.documents.length,
        syncedAt: result.corpus.syncedAt,
        libraryUrl: result.corpus.libraryUrl,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(msg.includes("AUTH") ? 401 : 400).send({
        error: msg.split(" — ")[0],
        detail: msg,
        help: scribdLoginHelp(),
      });
    }
  });

  app.get("/api/sources", async () => ({
    authenticated: listDeepWebSources(),
    manifest: loadCorpusManifest(),
  }));

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    "/api/sources/:id/sync",
    async (req, reply) => {
      try {
        const result = await syncDeepWebSource(req.params.id, {
          force: req.body?.forceSync === true,
          config,
        });
        return { ...result, manifest: loadCorpusManifest() };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.code(400).send({ error: msg.split(" — ")[0], detail: msg });
      }
    },
  );

  app.post<{ Body: Record<string, unknown> }>("/api/ingest/sync", async (req, reply) => {
    const domain = String(req.body?.domain ?? "").trim();
    if (!domain) return reply.code(400).send({ error: "domain required" });
    try {
      const result = await syncDeepWebSource(`ingest:${domain}`, {
        force: true,
        config,
        domain,
      });
      return { domain, ...result, manifest: loadCorpusManifest() };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: msg.split(" — ")[0], detail: msg });
    }
  });

  /** Auto-add unindexed URLs: fetch, persist to corpus + ingest list, push to frontend webhook. */
  app.post<{ Body: Record<string, unknown> }>("/api/ingest/urls", async (req, reply) => {
    const domain = String(req.body?.domain ?? "unlisted_public").trim();
    const urls = Array.isArray(req.body?.urls) ? (req.body.urls as string[]) : [];
    if (!urls.length) return reply.code(400).send({ error: "urls required" });
    try {
      const listPath = resolveDomainIngestList(domain);
      const result = await ingestUrlsForDomain(config, domain, urls, {
        listPath: listPath ?? undefined,
      });
      return {
        domain,
        documentCount: result.documents.length,
        addedToList: result.added,
        rejected: result.rejected,
        manifest: loadCorpusManifest(),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: msg.split(" — ")[0], detail: msg });
    }
  });

  app.get<{ Querystring: { domain?: string; q?: string; limit?: string } }>(
    "/api/corpus/documents",
    async (req) => {
      const domain = req.query.domain?.trim();
      const limit = Number(req.query.limit ?? 100);
      let docs = exportCorpusDocuments(domain);
      if (req.query.q?.trim()) {
        const ranked = searchCorpusDocuments(
          req.query.q,
          docs.map((d) => ({
            text: d.text,
            url: d.url,
            title: d.title,
            source: "deep" as const,
            fetchedAt: d.fetchedAt,
          })),
          limit,
        );
        const byUrl = new Map(docs.map((d) => [d.url, d]));
        docs = ranked.map((r) => byUrl.get(r.url)).filter((d): d is NonNullable<typeof d> => Boolean(d));
      } else {
        docs = docs.slice(0, limit);
      }
      return {
        domain: domain ?? null,
        uncensored: deepCfg.uncensored,
        count: docs.length,
        documents: docs,
      };
    },
  );

  app.get<{ Querystring: { domain?: string } }>("/api/corpus/export", async (req) => {
    const domain = req.query.domain?.trim();
    const documents = exportCorpusDocuments(domain);
    return {
      exportedAt: new Date().toISOString(),
      domain: domain ?? null,
      uncensored: deepCfg.uncensored,
      documentCount: documents.length,
      manifest: loadCorpusManifest(),
      documents,
    };
  });

  /** Aureon bridge — topic + domain resolves whitelisted seeds; live web pages only. */
  app.post<{ Body: Record<string, unknown> }>("/api/crawl", async (req, reply) => {
    const body = req.body ?? {};
    const topic = String(body.topic ?? body.question ?? "").trim();
    const domain = String(body.domain ?? "").trim();
    if (!topic) return reply.code(400).send({ error: "topic required" });
    const seeds = prioritizeSeedsForQuestion(
      (body.seeds as string[] | undefined)?.filter(Boolean) ??
        (domain ? resolveDomainSeeds(domain) : []),
      topic,
    );
    if (!seeds.length) {
      return reply.code(400).send({ error: "seeds required (provide seeds or domain)" });
    }
    const timeoutMs = Number(body.timeoutMs ?? 120_000);
    const pollMs = Number(body.pollMs ?? 1500);
    const maxDepth = Number(body.maxDepth ?? 2);
    const maxPages = Number(body.maxPages ?? 25);
    try {
      const job = await orchestrator.submitJob({
        seeds,
        maxDepth,
        maxPages,
        includeArchive: false,
        includeSitemaps: false,
        jsRendering: !!body.jsRendering,
        topic,
        topicFollowRelated: false,
        allowedDomains: allowedDomainsFromSeeds(seeds),
      });
      const finished = await orchestrator.waitForJob(job.id, { timeoutMs, pollMs });
      if (!finished || finished.status !== "completed") {
        return reply.code(504).send({
          error: "CRAWL_INCOMPLETE",
          jobId: job.id,
          status: finished?.status ?? "unknown",
        });
      }
      const pages = orchestrator.listPagesWithText(
        job.id,
        Number(body.pageLimit ?? 50),
        0,
      );
      const allowed = allowedDomainsFromSeeds(seeds);
      const livePages = pagesToLiveDocuments(pages, allowed);
      const liveDocuments = livePages.map((p) => ({
        text: p.text,
        url: p.url,
        title: p.title,
        source: "live" as const,
        fetchedAt: p.fetchedAt,
      }));

      let deepDocuments: Array<{
        text: string;
        url: string;
        title: string;
        source: "deep";
        fetchedAt?: string;
      }> = [];
      if (domain) {
        try {
          const deep = await loadDeepWebKnowledge({ domain, config });
          deepDocuments = deep.documents.map((d) => ({
            text: d.text,
            url: d.url,
            title: d.title,
            source: "deep" as const,
            fetchedAt: d.fetchedAt,
          }));
        } catch {
          /* deep corpus optional for hybrid/public domains */
        }
      } else if (body.includeDeepWeb === true) {
        deepDocuments = ingestToChatDocuments("unlisted_public").map((d) => ({
          ...d,
          source: "deep" as const,
        }));
      }

      const documents = [...deepDocuments, ...liveDocuments];
      return {
        jobId: job.id,
        domain: domain || null,
        topic,
        livePageCount: liveDocuments.length,
        deepWebDocumentCount: deepDocuments.length,
        documents,
      };
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/v1/jobs", async () => orchestrator.listJobs());
  app.get<{ Params: { id: string } }>("/v1/jobs/:id", async (req, reply) => {
    const job = orchestrator.getJob(req.params.id);
    if (!job) return reply.code(404).send({ error: "Job not found" });
    return job;
  });
  app.get<{ Params: { id: string }; Querystring: { limit?: string; offset?: string; includeText?: string } }>(
    "/v1/jobs/:id/pages",
    async (req) => {
      const limit = Number(req.query.limit ?? 100);
      const offset = Number(req.query.offset ?? 0);
      if (req.query.includeText === "1" || req.query.includeText === "true") {
        return orchestrator.listPagesWithText(req.params.id, limit, offset);
      }
      return orchestrator.listPages(req.params.id, limit, offset);
    },
  );

  app.get<{ Params: { id: string }; Querystring: { limit?: string; offset?: string; includeText?: string } }>(
    "/api/jobs/:id/pages",
    async (req) => {
      const limit = Number(req.query.limit ?? 100);
      const offset = Number(req.query.offset ?? 0);
      if (req.query.includeText === "1" || req.query.includeText === "true") {
        return orchestrator.listPagesWithText(req.params.id, limit, offset);
      }
      return orchestrator.listPages(req.params.id, limit, offset);
    },
  );

  app.get("/v1/audit", async () => {
    if (!security) return { events: [] };
    const { valid, errors } = security.audit.verifyChain();
    return { chainValid: valid, chainErrors: errors, events: security.audit.query(100) };
  });

  if (security && config.security.enabled) {
    setInterval(() => security.vitalGuard.pulseCheck(), config.security.organismPulseSeconds * 1000);
  }

  startDeepWebScheduler(config);

  await app.listen({ host, port });
  console.log(`Omnispider API listening on http://${host}:${port}`);
}
