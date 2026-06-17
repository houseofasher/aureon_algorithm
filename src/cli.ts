#!/usr/bin/env node
import { Command } from "commander";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { loadConfig } from "./core/config.js";
import { Orchestrator } from "./core/orchestrator.js";
import { buildSecurityStack, ApiKeyRegistry } from "./security/nomad.js";
import {
  formatReportText,
  runTopicLookup,
} from "./topic/index.js";
import {
  saveIntelligenceReport,
  defaultReportPaths,
} from "./topic/intelligence.js";
import { ArchiveEngine } from "./engines/registry.js";
import { startApi } from "./api.js";
import { handleChat, resetChatSessions } from "./chat/chat-service.js";
import { createInterface } from "node:readline/promises";
import { loadScribdKnowledge } from "./sources/scribd-service.js";
import { scribdLoginHelp, interactiveScribdLogin } from "./sources/scribd.js";
import {
  deepWebHelpForDomain,
  listDeepWebSources,
  syncDeepWebSource,
} from "./sources/deep-web-service.js";
import { getAuthenticatedSource } from "./sources/authenticated-source.js";
import { parseUrlListContent, validateIngestUrls } from "./sources/url-ingest.js";
import { loadDomainSeeds, resolveDomainAccessType } from "./core/domain-seeds.js";

const program = new Command();

program
  .name("omnispider")
  .description("Omnispider — all-in-one web spider orchestrator (TypeScript)")
  .version("1.0.0");

program
  .command("crawl")
  .description("Start a crawl job")
  .argument("<seeds...>", "Seed URLs")
  .option("-d, --depth <n>", "Max depth", "3")
  .option("-m, --max-pages <n>", "Max pages", "500")
  .option("--no-archive", "Skip Wayback Machine")
  .option("--no-sitemap", "Skip sitemap discovery")
  .option("--js", "Force JS rendering")
  .option("-c, --config <path>", "Config YAML path")
  .action(async (seeds: string[], opts) => {
    const config = loadConfig(opts.config);
    const security = config.security.enabled ? buildSecurityStack(config) : null;
    const orchestrator = new Orchestrator(config, security);
    orchestrator.init();
    try {
      const job = await orchestrator.submitJob({
        seeds,
        maxDepth: Number(opts.depth),
        maxPages: Number(opts.maxPages),
        includeArchive: opts.archive !== false,
        includeSitemaps: opts.sitemap !== false,
        jsRendering: !!opts.js,
      });
      console.log(`Job ${job.id} started — seeds: ${seeds.join(", ")}`);
      while (true) {
        const current = orchestrator.getJob(job.id);
        if (current && ["completed", "failed", "cancelled"].includes(current.status)) {
          console.log(
            `Job ${job.id} ${current.status}: ${current.pagesCrawled} pages, ${current.pagesFailed} failed`,
          );
          if (current.error) console.log(`Error: ${current.error}`);
          break;
        }
        await sleep(1000);
      }
    } finally {
      orchestrator.shutdown();
    }
  });

program
  .command("lookup")
  .description(
    "Search a topic → crawl connected pages → gather data → repeat until no links left → intelligence report",
  )
  .argument("<topic>", "Topic query (person, place, keywords)")
  .option("-s, --seed <url...>", "Direct seed URLs (recommended for people lookup)")
  .option("-d, --depth <n>", "Max link hops from each page", "8")
  .option("-m, --max-pages <n>", "Safety cap on pages (0 = config max)", "0")
  .option("--min-relevance <n>", "Min relevance to include in report", "0.08")
  .option("--no-archive", "Skip Wayback historical pass")
  .option("--no-exhaustive", "Stop early instead of draining all connected links")
  .option("--mode <mode>", "Search type: people (human), knowledge (domain), auto (detect)", "auto")
  .option("--no-linked-persons", "Skip spawning agents for co-residents / household members")
  .option("--max-linked-persons <n>", "Max co-resident agent lookups (default 3)", "3")
  .option("--json <path>", "JSON intelligence file (default: data/reports/<topic>-intelligence.json)")
  .option("--report <path>", "Markdown intelligence file (default: data/reports/<topic>-intelligence.md)")
  .option("-c, --config <path>", "Config path")
  .action(async (topic: string, opts) => {
    const config = loadConfig(opts.config);
    const security = config.security.enabled ? buildSecurityStack(config) : null;
    const defaults = defaultReportPaths(topic);
    const maxPages = Number(opts.maxPages);

    const report = await runTopicLookup(config, security, {
      topic,
      extraSeeds: opts.seed ?? [],
      maxDepth: Number(opts.depth),
      maxPages: maxPages === 0 ? 0 : maxPages,
      minRelevance: Number(opts.minRelevance),
      exhaustive: opts.exhaustive !== false,
      includeArchive: opts.archive !== false,
      searchMode: opts.mode as "people" | "knowledge" | "auto",
      linkedDepth: opts.linkedPersons === false ? 0 : 1,
      maxLinkedPersons: Number(opts.maxLinkedPersons),
      onProgress: (msg) => console.error(`[omnispider] ${msg}`),
    });

    console.log(formatReportText(report));

    const jsonPath = resolve(opts.json ?? defaults.json);
    const mdPath = resolve(opts.report ?? defaults.markdown);
    saveIntelligenceReport(report, jsonPath, mdPath);
    console.log(`\nIntelligence files written:`);
    console.log(`  JSON:     ${jsonPath}`);
    console.log(`  Markdown: ${mdPath}`);
    console.log(`  Sources:  ${report.sourceLinks.length} URLs crawled, ${report.relevantPages} with extracted data`);
    console.log(`  Type:     ${report.searchMode} search (${report.searchModeReason})`);
  });

program
  .command("archive")
  .description("List Wayback Machine snapshots for a URL")
  .argument("<url>", "URL to look up")
  .option("-c, --config <path>", "Config path")
  .action(async (url: string, opts) => {
    const config = loadConfig(opts.config);
    const archive = new ArchiveEngine(config);
    const snapshots = await archive.listSnapshots(url);
    if (!snapshots.length) {
      console.log("No snapshots found.");
      return;
    }
    for (const ts of snapshots) console.log(`${ts}  ${archive.waybackUrl(ts, url)}`);
  });

program
  .command("chat")
  .description("Algorithm chatbot — live web, deep-web corpus, or hybrid")
  .requiredOption("-d, --domain <slug>", "Domain slug (scribd, unlisted_public, or taxonomy slug)")
  .option("-s, --seed <url...>", "Override with explicit https seed URLs")
  .option("--include-scribd", "Merge synced Scribd library into any domain crawl")
  .option("--force-scribd-sync", "Refresh Scribd library before chat")
  .option("-c, --config <path>", "Config path")
  .action(async (opts) => {
    const config = loadConfig(opts.config);
    const security = config.security.enabled ? buildSecurityStack(config) : null;
    const orchestrator = new Orchestrator(config, security);
    orchestrator.init();
    resetChatSessions();

    console.log("Omnispider algorithm chatbot (live web only)");
    console.log("Corpus is always freshly crawled — never test files or local reports.\n");

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let sessionId: string | undefined;

    try {
      while (true) {
        const message = (await rl.question("You: ")).trim();
        if (!message) continue;
        if (/^(quit|exit|bye)$/i.test(message)) {
          console.log("Bot: Goodbye. It was good talking with you.");
          break;
        }

        try {
          const result = await handleChat(config, orchestrator, {
            message,
            sessionId,
            domain: opts.domain,
            seeds: opts.seed,
            includeScribd: !!opts.includeScribd,
            forceScribdSync: !!opts.forceScribdSync,
          });
          sessionId = result.sessionId;
          console.log(`Bot [${result.mode}]: ${result.reply}`);
          if (result.sources.length) {
            console.log(`     Source: ${result.sources[0].title} — ${result.sources[0].url}`);
          }
          const deepNote =
            result.deepWebDocumentCount != null && result.deepWebDocumentCount > 0
              ? ` | Deep corpus: ${result.deepWebDocumentCount}${result.deepWebSynced ? " (synced)" : ""}`
              : "";
          console.log(`     Corpus: ${result.livePageCount}${deepNote} | ${result.disclaimer}\n`);
        } catch (err) {
          console.error(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        }
      }
    } finally {
      rl.close();
      orchestrator.shutdown();
    }
  });

const scribd = program.command("scribd").description("Scribd library sync (https://www.scribd.com/home)");

scribd
  .command("login")
  .description("Open browser to log in to Scribd and save session (easiest setup)")
  .action(async () => {
    try {
      await interactiveScribdLogin();
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

scribd
  .command("sync")
  .description("Sync your logged-in Scribd library and PDF/text imports into ./data/scribd/corpus.json")
  .option("--force", "Force refresh even if corpus is fresh")
  .action(async (opts) => {
    try {
      const result = await loadScribdKnowledge({ forceSync: !!opts.force });
      console.log(`Scribd sync complete: ${result.documents.length} documents`);
      console.log(`  Library: ${result.corpus.libraryUrl}`);
      console.log(`  Corpus:  ./data/scribd/corpus.json`);
      console.log(`  Imports: ./data/scribd/import/ (.txt / .md)`);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      console.error("\n" + scribdLoginHelp());
      process.exit(1);
    }
  });

scribd
  .command("login-help")
  .description("Show how to connect your Scribd account")
  .action(() => {
    console.log(scribdLoginHelp());
  });

const sources = program.command("sources").description("Deep-web authenticated source registry");

sources
  .command("list")
  .description("List registered authenticated sources and domain access types")
  .action(() => {
    loadDomainSeeds(true);
    console.log("Authenticated adapters:");
    for (const s of listDeepWebSources()) {
      console.log(`  - ${s.id}`);
    }
    console.log("\nDomain access types (see config/domain-seeds.yaml):");
    for (const id of ["scribd", "unlisted_public", "computer_science"]) {
      console.log(`  ${id}: ${resolveDomainAccessType(id)}`);
    }
  });

sources
  .command("login")
  .argument("<adapter>", "Adapter id (e.g. scribd)")
  .description("Interactive login for an authenticated source")
  .action(async (adapter: string) => {
    const a = getAuthenticatedSource(adapter);
    if (!a) {
      console.error(`Unknown adapter: ${adapter}`);
      process.exit(1);
    }
    await a.login();
  });

sources
  .command("sync")
  .argument("<adapter>", "Adapter id (e.g. scribd)")
  .option("--force", "Force refresh")
  .description("Sync an authenticated source into local corpus")
  .action(async (adapter: string, opts) => {
    try {
      const config = loadConfig();
      const result = await syncDeepWebSource(adapter, { force: !!opts.force, config });
      console.log(`Sync complete: ${result.documentCount} documents (synced=${result.synced})`);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

sources
  .command("info")
  .requiredOption("-d, --domain <slug>", "Domain slug")
  .description("Show deep-web retrieval plan for a domain")
  .action((opts) => {
    loadDomainSeeds(true);
    console.log(deepWebHelpForDomain(opts.domain));
  });

const ingest = program.command("ingest").description("Sync user-provided URL lists (unlisted public deep web)");

ingest
  .command("sync")
  .requiredOption("-d, --domain <slug>", "Domain slug with ingest_list in domain-seeds.yaml")
  .option("-c, --config <path>", "Config path")
  .description("Fetch URLs from ingest_list into local corpus")
  .action(async (opts) => {
    const config = loadConfig(opts.config);
    try {
      const result = await syncDeepWebSource(`ingest:${opts.domain}`, {
        force: true,
        config,
        domain: opts.domain,
      });
      console.log(`Ingest sync: ${result.documentCount} documents`);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

ingest
  .command("validate")
  .argument("<file>", "Newline-delimited URL list")
  .description("Validate URLs before adding to an ingest list")
  .action((file: string) => {
    const urls = parseUrlListContent(readFileSync(file, "utf8"));
    const { valid, rejected } = validateIngestUrls(urls);
    console.log(`Valid: ${valid.length}, Rejected: ${rejected.length}`);
    for (const r of rejected.slice(0, 10)) {
      console.log(`  ${r.url} — ${r.reason}`);
    }
  });

program
  .command("serve")
  .description("Start REST API server")
  .option("--host <host>", "Bind host")
  .option("--port <port>", "Bind port")
  .option("-c, --config <path>", "Config path")
  .action(async (opts) => {
    const config = loadConfig(opts.config);
    const host = opts.host ?? config.api.host;
    const port = Number(opts.port ?? config.api.port);
    await startApi(config, host, port);
  });

const security = program.command("security").description("Nomad Cyber security utilities");

security
  .command("generate-key")
  .option("-r, --role <role>", "viewer|operator|admin|sovereign", "operator")
  .action((opts) => {
    const { raw, configEntry } = ApiKeyRegistry.generateKey(opts.role);
    console.log(`API Key (save now — shown once):\n  ${raw}\n`);
    console.log(`Add to config/default.yaml under security.api_keys:\n  - "${configEntry}"`);
  });

security
  .command("vitals")
  .option("-c, --config <path>", "Config path")
  .action((opts) => {
    const config = loadConfig(opts.config);
    const stack = buildSecurityStack(config);
    const report = stack.vitalGuard.getVitalsReport();
    console.log(JSON.stringify(report, null, 2));
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
