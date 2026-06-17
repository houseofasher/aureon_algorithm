import type { ChatDocument } from "../chat/algorithm-chatbot.js";

export interface AuthenticatedLoadResult {
  documents: ChatDocument[];
  synced: boolean;
  syncedAt: string;
  meta?: Record<string, unknown>;
}

/** Login-gated sources (Scribd, etc.) — sync into local corpus, never public crawl. */
export interface AuthenticatedSourceAdapter {
  id: string;
  login(): Promise<void>;
  load(opts?: { forceSync?: boolean }): Promise<AuthenticatedLoadResult>;
}

const registry = new Map<string, AuthenticatedSourceAdapter>();

export function registerAuthenticatedSource(adapter: AuthenticatedSourceAdapter): void {
  registry.set(adapter.id, adapter);
}

export function getAuthenticatedSource(id: string): AuthenticatedSourceAdapter | null {
  return registry.get(id) ?? null;
}

export function listAuthenticatedSourceIds(): string[] {
  return [...registry.keys()];
}
