import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { ScribdCorpus, ScribdDocument } from "./scribd-corpus.js";
import {
  assertCorpusPathUnderRoot,
  defaultCorpusPath,
  localImportUrl,
  saveScribdCorpus,
} from "./scribd-corpus.js";

export interface ScribdConfig {
  libraryUrl: string;
  storageStatePath: string;
  corpusPath: string;
  pdfImportDir: string;
  maxDocuments: number;
  headless: boolean;
  /** Raw Cookie header value — fallback when storage state is missing. */
  sessionCookie?: string;
}

const SCRIBD_HOST_RE = /^(?:www\.)?scribd\.com$/i;
const DOC_PATH_RE = /^\/(?:document|doc|book|audiobook|podcast)\//i;
const DOC_LINK_RE =
  /https?:\/\/(?:www\.)?scribd\.com\/(?:document|doc|book|audiobook|podcast)\/[^\s"'<>]+/gi;
const MAX_COOKIE_BYTES = 16_384;
const MAX_IMPORT_FILE_BYTES = 5 * 1024 * 1024;
const MIN_EXTRACTED_TEXT = 80;

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

export function isScribdHttpUrl(url: string): boolean {
  try {
    const u = new URL(url.split("?")[0]);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    return SCRIBD_HOST_RE.test(u.hostname) && DOC_PATH_RE.test(u.pathname);
  } catch {
    return false;
  }
}

export function isScribdLibraryUrl(url: string): boolean {
  try {
    const u = new URL(url.split("?")[0]);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    return SCRIBD_HOST_RE.test(u.hostname);
  } catch {
    return false;
  }
}

export function normalizeDocUrl(url: string): string {
  try {
    const u = new URL(url.split("?")[0]);
    if (/^(?:www\.)?scribd\.com$/i.test(u.hostname)) {
      u.hostname = "www.scribd.com";
    }
    u.hash = "";
    return u.toString();
  } catch {
    return url;
  }
}

function docIdFromUrl(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 16);
}

function parseCookieHeader(
  header: string,
  domain = ".scribd.com",
): Array<{ name: string; value: string; domain: string; path: string }> {
  return header
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const eq = part.indexOf("=");
      if (eq <= 0) return null;
      let name = part.slice(0, eq).trim();
      let value = part.slice(eq + 1).trim();
      if (value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1);
      }
      if (!name) return null;
      return { name, value, domain, path: "/" };
    })
    .filter((c): c is { name: string; value: string; domain: string; path: string } => Boolean(c));
}

export function scribdConfigFromEnv(root = process.cwd()): ScribdConfig {
  const dataDir = join(root, "data", "scribd");
  const cookieFile = join(dataDir, "cookie.txt");
  let sessionCookie = process.env.SCRIBD_SESSION_COOKIE?.trim();
  if (!sessionCookie && existsSync(cookieFile)) {
    const raw = readFileSync(cookieFile, "utf8");
    if (raw.length > MAX_COOKIE_BYTES) {
      throw new Error(`SCRIBD_COOKIE_TOO_LARGE — cookie file exceeds ${MAX_COOKIE_BYTES} bytes`);
    }
    sessionCookie = raw.trim();
  }

  const libraryUrl = process.env.SCRIBD_LIBRARY_URL?.trim() || "https://www.scribd.com/home";
  if (!isScribdLibraryUrl(libraryUrl)) {
    throw new Error("SCRIBD_LIBRARY_URL_INVALID — must be an https://www.scribd.com URL");
  }

  const corpusPath = assertCorpusPathUnderRoot(
    process.env.SCRIBD_CORPUS_PATH?.trim() || defaultCorpusPath(root),
    root,
  );

  return {
    libraryUrl,
    storageStatePath:
      process.env.SCRIBD_STORAGE_STATE_PATH?.trim() || join(dataDir, "storage-state.json"),
    corpusPath,
    pdfImportDir: process.env.SCRIBD_PDF_DIR?.trim() || join(dataDir, "import"),
    maxDocuments: clampInt(Number(process.env.SCRIBD_MAX_DOCUMENTS ?? 100), 1, 500, 100),
    headless: process.env.SCRIBD_HEADLESS !== "0",
    sessionCookie,
  };
}

async function extractDocumentText(
  page: import("playwright").Page,
  url: string,
): Promise<{ title: string; text: string }> {
  if (!isScribdHttpUrl(url)) {
    throw new Error(`SCRIBD_URL_BLOCKED — not a Scribd document URL: ${url}`);
  }

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(2500);

  const title = (await page.title()).replace(/\s*\|\s*Scribd.*$/i, "").trim() || url;

  const text = await page.evaluate(() => {
    const sel = [".text_layer", ".outer_page", "[class*='PageContent']", "[class*='reader']", "article", "main"];
    const chunks: string[] = [];
    for (const s of sel) {
      const nodes = (
        globalThis as unknown as { document: { querySelectorAll: (q: string) => Iterable<{ innerText?: string }> } }
      ).document.querySelectorAll(s);
      for (const el of nodes) {
        const t = el.innerText?.replace(/\s+/g, " ").trim();
        if (t && t.length > 80) chunks.push(t);
      }
    }
    if (chunks.length) return [...new Set(chunks)].join("\n\n");
    return (globalThis as unknown as { document: { body: { innerText: string } } }).document.body.innerText
      .replace(/\s+/g, " ")
      .trim();
  });

  return { title, text };
}

async function collectLibraryLinks(
  page: import("playwright").Page,
  libraryUrl: string,
  maxLinks: number,
): Promise<string[]> {
  if (!isScribdLibraryUrl(libraryUrl)) {
    throw new Error(`SCRIBD_LIBRARY_URL_INVALID — ${libraryUrl}`);
  }

  await page.goto(libraryUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(3000);

  const currentUrl = page.url();
  if (/scribd\.com\/(?:login|oauth|signup)/i.test(currentUrl)) {
    throw new Error(
      "SCRIBD_AUTH_REQUIRED — export Playwright storage state while logged in (see: omnispider scribd login-help)",
    );
  }

  for (let i = 0; i < 4; i++) {
    await page.mouse.wheel(0, 2500);
    await page.waitForTimeout(800);
  }

  const found = new Set<string>();
  const html = await page.content();
  for (const match of html.matchAll(DOC_LINK_RE)) {
    const normalized = normalizeDocUrl(match[0]);
    if (isScribdHttpUrl(normalized)) found.add(normalized);
    if (found.size >= maxLinks) break;
  }

  const hrefs = await page.evaluate(() => {
    const doc = (
      globalThis as unknown as {
        document: { querySelectorAll: (q: string) => Iterable<{ href?: string }> };
      }
    ).document;
    return [...doc.querySelectorAll("a[href]")]
      .map((a) => a.href)
      .filter((h): h is string => typeof h === "string" && h.length > 0);
  });
  for (const href of hrefs) {
    const normalized = normalizeDocUrl(href);
    if (isScribdHttpUrl(normalized)) {
      found.add(normalized);
      if (found.size >= maxLinks) break;
    }
  }

  return [...found].slice(0, maxLinks);
}

function loadLocalPdfImports(dir: string): ScribdDocument[] {
  if (!existsSync(dir)) return [];
  const importRoot = resolve(dir);
  const out: ScribdDocument[] = [];
  const now = new Date().toISOString();

  for (const name of readdirSync(importRoot)) {
    const lower = name.toLowerCase();
    if (!lower.endsWith(".txt") && !lower.endsWith(".md")) continue;

    const filePath = resolve(importRoot, name);
    if (!filePath.startsWith(importRoot)) continue;

    let stat;
    try {
      stat = lstatSync(filePath);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size > MAX_IMPORT_FILE_BYTES) continue;

    const safeName = basename(filePath);
    const text = readFileSync(filePath, "utf8").trim();
    if (text.length < MIN_EXTRACTED_TEXT) continue;

    out.push({
      id: docIdFromUrl(filePath),
      title: safeName.replace(/\.(txt|md)$/i, ""),
      url: localImportUrl(safeName),
      text,
      syncedAt: now,
      source: "scribd_pdf_import",
    });
  }
  return out;
}

export async function syncScribdLibrary(config: ScribdConfig): Promise<ScribdCorpus> {
  mkdirSync(join(config.corpusPath, ".."), { recursive: true });
  mkdirSync(config.pdfImportDir, { recursive: true });

  const hasStorageState = existsSync(config.storageStatePath);
  if (!hasStorageState && !config.sessionCookie) {
    throw new Error(
      "SCRIBD_AUTH_REQUIRED — set SCRIBD_STORAGE_STATE_PATH or SCRIBD_SESSION_COOKIE for your Scribd library",
    );
  }

  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: config.headless });
  const contextOpts: Parameters<typeof browser.newContext>[0] = {
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  };
  if (hasStorageState) {
    contextOpts.storageState = config.storageStatePath;
  }

  try {
    const context = await browser.newContext(contextOpts);
    if (!hasStorageState && config.sessionCookie) {
      await context.addCookies(parseCookieHeader(config.sessionCookie));
    }

    const page = await context.newPage();
    const links = await collectLibraryLinks(page, config.libraryUrl, config.maxDocuments);

    const documents: ScribdDocument[] = [];
    const now = new Date().toISOString();

    for (const url of links) {
      try {
        const { title, text } = await extractDocumentText(page, url);
        if (text.length < MIN_EXTRACTED_TEXT) continue;
        documents.push({
          id: docIdFromUrl(url),
          title,
          url,
          text,
          syncedAt: now,
          source: "scribd_library",
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[scribd] skipped document ${url}: ${msg}`);
      }
    }

    if (hasStorageState || documents.length > 0) {
      await context.storageState({ path: config.storageStatePath }).catch(() => undefined);
    }

    const imported = loadLocalPdfImports(config.pdfImportDir);
    const corpus: ScribdCorpus = {
      syncedAt: now,
      libraryUrl: config.libraryUrl,
      documents: [...documents, ...imported],
    };

    if (!corpus.documents.length) {
      throw new Error("SCRIBD_EMPTY — no documents extracted from library or import folder");
    }

    saveScribdCorpus(corpus, config.corpusPath);
    return corpus;
  } finally {
    await browser.close();
  }
}

export function scribdLoginHelp(): string {
  return [
    "Scribd library sync requires your logged-in session.",
    "",
    "Easiest — interactive login (recommended):",
    "  npm run dev -- scribd login",
    "  (Browser opens → log in → go to scribd.com/home → session saves automatically)",
    "",
    "Then sync:",
    "  npm run dev -- scribd sync",
    "",
    "Alternative — cookie file (avoid PowerShell quoting issues):",
    "  1. DevTools → Network → refresh scribd.com/home → copy full Cookie header",
    "  2. Paste into ./data/scribd/cookie.txt (one line, no quotes)",
    "  3. npm run dev -- scribd sync",
    "",
    "Local PDF/text imports:",
    "  Drop .txt or .md exports into ./data/scribd/import/",
  ].join("\n");
}

/** Open a browser window — user logs in manually, then we save storage-state.json. */
export async function interactiveScribdLogin(config: ScribdConfig = scribdConfigFromEnv()): Promise<string> {
  mkdirSync(join(config.storageStatePath, ".."), { recursive: true });
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: false });

  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    console.log("Opening Scribd login in your browser...");
    await page.goto("https://www.scribd.com/login", { waitUntil: "domcontentloaded", timeout: 60_000 });
    console.log("");
    console.log("  1. Log in to Scribd in the browser window");
    console.log("  2. Go to https://www.scribd.com/home");
    console.log("  3. Wait — this terminal detects when you are logged in");
    console.log("");

    const deadline = Date.now() + 5 * 60_000;
    while (Date.now() < deadline) {
      const url = page.url();
      if (/scribd\.com\/(?:home|saved|library|your-account)/i.test(url) && !/login|oauth|signup/i.test(url)) {
        await page.waitForTimeout(1500);
        await context.storageState({ path: config.storageStatePath });
        console.log(`Session saved: ${config.storageStatePath}`);
        console.log("Next: npm run dev -- scribd sync");
        return config.storageStatePath;
      }
      await page.waitForTimeout(1500);
    }

    throw new Error("SCRIBD_LOGIN_TIMEOUT — log in and open scribd.com/home within 5 minutes");
  } finally {
    await browser.close();
  }
}
