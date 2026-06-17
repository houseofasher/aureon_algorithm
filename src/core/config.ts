import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { setDeepWebYamlConfig, type DeepWebConfig } from "./deep-web-config.js";

export interface AppConfig {
  orchestrator: {
    maxConcurrency: number;
    maxDepth: number;
    maxPagesPerJob: number;
    requestTimeoutSeconds: number;
    retryAttempts: number;
    userAgent: string;
  };
  policy: {
    respectRobotsTxt: boolean;
    rateLimitPerHost: number;
    allowedSchemes: string[];
    followExternalLinks: boolean;
    blockedDomains: string[];
  };
  engines: {
    default: EngineTypeName;
    routing: Record<string, string>;
    playwright: { headless: boolean; waitUntil: string };
    splash: { baseUrl: string };
    katana: { binary: string; extraArgs: string[] };
  };
  discovery: {
    sitemap: boolean;
    robots: boolean;
    linkExtraction: boolean;
    globalSeeds: string[];
    ccTldSeeds: boolean;
  };
  archive: {
    enabled: boolean;
    waybackCdxUrl: string;
    waybackRenderUrl: string;
    commonCrawlIndex: string;
    maxSnapshotsPerUrl: number;
  };
  storage: {
    databasePath: string;
    contentDir: string;
    storeHtml: boolean;
    storeMetadata: boolean;
  };
  api: { host: string; port: number };
  security: SecurityConfig;
  vendors: { path: string };
  deepWeb?: DeepWebConfig;
}

export type EngineTypeName = string;

export interface SecurityConfig {
  enabled: boolean;
  devMode: boolean;
  requireAuth: boolean;
  requireClientAllowlist: boolean;
  clientAllowlist: string[];
  apiKeys: string[];
  auditLogDir: string;
  auditChainKey: string;
  maxConnections: number;
  maxRequestsPerMinute: number;
  maxRequestsPerClientPerMinute: number;
  maxBodyBytes: number;
  replayMaxClockSkewMs: number;
  replayNonceTtlMs: number;
  blockPrivateIps: boolean;
  blockLinkLocal: boolean;
  organismPulseSeconds: number;
}

const DEFAULT_CONFIG: AppConfig = {
  orchestrator: {
    maxConcurrency: 16,
    maxDepth: 5,
    maxPagesPerJob: 10000,
    requestTimeoutSeconds: 30,
    retryAttempts: 3,
    userAgent: "Omnispider/1.0 (+https://github.com/houseofasher/web-crawlers)",
  },
  policy: {
    respectRobotsTxt: true,
    rateLimitPerHost: 2.0,
    allowedSchemes: ["http", "https"],
    followExternalLinks: true,
    blockedDomains: [],
  },
  engines: {
    default: "http",
    routing: {
      js_heavy: "playwright",
      archive: "archive",
      fast_discovery: "katana",
      forms: "mechanical",
    },
    playwright: { headless: true, waitUntil: "networkidle" },
    splash: { baseUrl: "http://127.0.0.1:8050" },
    katana: { binary: "katana", extraArgs: ["-silent", "-nc"] },
  },
  discovery: {
    sitemap: true,
    robots: true,
    linkExtraction: true,
    globalSeeds: [],
    ccTldSeeds: false,
  },
  archive: {
    enabled: true,
    waybackCdxUrl: "https://web.archive.org/cdx/search/cdx",
    waybackRenderUrl: "https://web.archive.org/web",
    commonCrawlIndex: "https://index.commoncrawl.org/collinfo.json",
    maxSnapshotsPerUrl: 10,
  },
  storage: {
    databasePath: "./data/omnispider.db",
    contentDir: "./data/content",
    storeHtml: true,
    storeMetadata: true,
  },
  api: { host: "127.0.0.1", port: 8080 },
  security: {
    enabled: true,
    devMode: true,
    requireAuth: false,
    requireClientAllowlist: false,
    clientAllowlist: [],
    apiKeys: [],
    auditLogDir: "./data/audit",
    auditChainKey: "",
    maxConnections: 64,
    maxRequestsPerMinute: 120,
    maxRequestsPerClientPerMinute: 60,
    maxBodyBytes: 1048576,
    replayMaxClockSkewMs: 60000,
    replayNonceTtlMs: 120000,
    blockPrivateIps: true,
    blockLinkLocal: true,
    organismPulseSeconds: 30,
  },
  vendors: { path: "./vendors" },
};

function snakeToCamel(key: string): string {
  return key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

function transformKeys(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(transformKeys);
  if (obj && typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      out[snakeToCamel(k)] = transformKeys(v);
    }
    return out;
  }
  return obj;
}

export function loadConfig(configPath?: string): AppConfig {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const path = configPath ?? join(root, "config", "default.yaml");
  if (!existsSync(path)) return structuredClone(DEFAULT_CONFIG);
  const raw = yaml.load(readFileSync(path, "utf8")) as Record<string, unknown>;
  const transformed = transformKeys(raw) as Partial<AppConfig>;
  const merged = { ...DEFAULT_CONFIG, ...transformed } as AppConfig;
  if (merged.deepWeb) setDeepWebYamlConfig(merged.deepWeb);
  return merged;
}
