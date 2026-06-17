import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

/** How a domain slug resolves to retrieval — not every deep-web source is login-gated. */
export type DomainAccessType = "public" | "authenticated" | "hybrid" | "ingest";

export interface DomainSeedEntry {
  seeds: string[];
  type?: DomainAccessType;
  /** Registered authenticated adapter id (e.g. scribd). */
  adapter?: string;
  /** Path to newline-delimited URL list for unlisted-but-public pages. */
  ingestList?: string;
}

export type DomainSeedsConfig = Record<string, DomainSeedEntry>;

let cached: DomainSeedsConfig | null = null;

function configPath(): string {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  return join(root, "config", "domain-seeds.yaml");
}

function normalizeEntry(raw: unknown): DomainSeedEntry {
  const r = (raw ?? {}) as Record<string, unknown>;
  const seeds = Array.isArray(r.seeds) ? r.seeds.map(String).filter(Boolean) : [];
  const typeRaw = String(r.type ?? "public").toLowerCase();
  const type: DomainAccessType =
    typeRaw === "authenticated" || typeRaw === "hybrid" || typeRaw === "ingest"
      ? typeRaw
      : "public";
  const ingestRaw = r.ingest_list ?? r.ingestList;
  return {
    seeds,
    type,
    adapter: r.adapter ? String(r.adapter) : undefined,
    ingestList: ingestRaw ? String(ingestRaw) : undefined,
  };
}

function normalizeConfig(raw: unknown): DomainSeedsConfig {
  if (!raw || typeof raw !== "object") return {};
  const out: DomainSeedsConfig = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    out[key] = normalizeEntry(value);
  }
  return out;
}

export function loadDomainSeeds(force = false): DomainSeedsConfig {
  if (cached && !force) return cached;
  const path = configPath();
  if (!existsSync(path)) {
    cached = {};
    return cached;
  }
  const raw = yaml.load(readFileSync(path, "utf8"));
  cached = normalizeConfig(raw);
  return cached;
}

function resolveEntryKey(domain: string): string | null {
  const config = loadDomainSeeds();
  const normalized = domain.trim().toLowerCase();
  if (!normalized) return null;
  if (config[normalized]) return normalized;

  const parts = normalized.split(".").filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    const key = parts[i];
    if (config[key]) return key;
  }
  return null;
}

export function resolveDomainEntry(domain: string): DomainSeedEntry {
  const config = loadDomainSeeds();
  const key = resolveEntryKey(domain);
  if (key && config[key]) return config[key];
  return config.default ?? { seeds: [], type: "public" };
}

export function resolveDomainAccessType(domain: string): DomainAccessType {
  return resolveDomainEntry(domain).type ?? "public";
}

export function resolveDomainAdapter(domain: string): string | undefined {
  return resolveDomainEntry(domain).adapter;
}

export function resolveDomainIngestList(domain: string): string | undefined {
  return resolveDomainEntry(domain).ingestList;
}

/** Resolve Aureon domain slug or dotted path to whitelisted seed URLs. */
export function resolveDomainSeeds(domain: string): string[] {
  return resolveDomainEntry(domain).seeds ?? [];
}

/** True when domain must not use public crawl as primary retrieval. */
export function isCorpusOnlyDomain(domain?: string): boolean {
  if (!domain?.trim()) return false;
  const type = resolveDomainAccessType(domain);
  return type === "authenticated" || type === "ingest";
}

/** Hostnames derived from seed URLs — used as crawl allowlist. */
export function allowedDomainsFromSeeds(seeds: string[]): string[] {
  const hosts = new Set<string>();
  for (const seed of seeds) {
    try {
      hosts.add(new URL(seed).hostname.replace(/^www\./, ""));
    } catch {
      /* skip invalid */
    }
  }
  return [...hosts];
}

/** Crawl seeds for a domain — empty for authenticated-only slugs (prevents futile login-wall crawls). */
export function crawlSeedsForDomain(domain: string): string[] {
  const type = resolveDomainAccessType(domain);
  if (type === "authenticated" || type === "ingest") return [];
  return resolveDomainSeeds(domain);
}

export function isScribdDomain(domain?: string): boolean {
  if (!domain?.trim()) return false;
  return resolveDomainAccessType(domain) === "authenticated" && resolveDomainAdapter(domain) === "scribd";
}
