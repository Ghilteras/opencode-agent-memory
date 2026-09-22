import type { Plugin, ToolDefinition } from "@opencode-ai/plugin";

import {
  createJournalStore,
  loadConfig,
} from "./journal";
import {
  JournalRead,
  JournalSearch,
  JournalWrite,
} from "./tools";
import type { JournalContext } from "./tools";
import { warmupEmbedder } from "./embeddings";

export const MemoryPlugin: Plugin = async ({ directory }) => {
  // Journal: opt-in via ~/.config/opencode/agent-memory.json
  const config = await loadConfig();
  const journalEnabled = config.journal?.enabled === true;

  // Mutable state updated by chat.message hook
  const journalCtx: JournalContext = {
    directory,
    model: "",
    provider: "",
  };

  let journalTools: Record<string, ToolDefinition> = {};

  if (journalEnabled) {
    const journalStore = createJournalStore(undefined, config.cacheDir);
    // Warmup the embedder in the background; pass configured cacheDir so the
    // first-init-wins singleton caches to the correct directory.
    void warmupEmbedder(config.cacheDir).catch(() => {});
    journalTools = {
      journal_write: JournalWrite(journalStore, journalCtx, config.journal?.tags),
      journal_read: JournalRead(journalStore),
      journal_search: JournalSearch(journalStore),
    };
  }

  return {
    "chat.message": async (input, _output) => {
      if (input.model) {
        journalCtx.model = input.model.modelID;
        journalCtx.provider = input.model.providerID;
      }
    },

    tool: {
      ...journalTools,
    },
  };
};
