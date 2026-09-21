import type { Plugin, ToolDefinition } from "@opencode-ai/plugin";

import {
  buildJournalSystemNote,
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
  let journalSystemNote = "";

  if (journalEnabled) {
    const journalStore = createJournalStore(undefined, config.cacheDir);
    // Warmup the embedder in the background; pass configured cacheDir so the
    // first-init-wins singleton caches to the correct directory.
    void warmupEmbedder(config.cacheDir).catch(() => {});
    journalTools = {
      journal_write: JournalWrite(journalStore, journalCtx),
      journal_read: JournalRead(journalStore),
      journal_search: JournalSearch(journalStore),
    };
    journalSystemNote = buildJournalSystemNote(config.journal?.tags);
  }

  return {
    "chat.message": async (input, _output) => {
      if (input.model) {
        journalCtx.model = input.model.modelID;
        journalCtx.provider = input.model.providerID;
      }
    },

    "experimental.chat.system.transform": async (_input, output) => {
      // Inject journal instructions unconditionally when enabled.
      // Previous versions returned early when no memory blocks were present,
      // which also skipped the journal note — a regression-class bug that
      // silently disabled the journal entirely once blocks were removed.
      if (journalSystemNote) {
        output.system.push(journalSystemNote);
      }
    },

    tool: {
      ...journalTools,
    },
  };
};
