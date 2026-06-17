import type { AuthenticatedSourceAdapter } from "./authenticated-source.js";
import { loadScribdKnowledge } from "./scribd-service.js";
import { interactiveScribdLogin } from "./scribd.js";

export const scribdAdapter: AuthenticatedSourceAdapter = {
  id: "scribd",
  login: async () => {
    await interactiveScribdLogin();
  },
  load: (opts) => loadScribdKnowledge({ forceSync: opts?.forceSync }).then((r) => ({
    documents: r.documents,
    synced: r.synced,
    syncedAt: r.corpus.syncedAt,
    meta: { libraryUrl: r.corpus.libraryUrl },
  })),
};
