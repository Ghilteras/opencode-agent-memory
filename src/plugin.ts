import type { Plugin, ToolDefinition } from "@opencode-ai/plugin";

import {
  buildJournalSystemNote,
  createJournalStore,
  loadConfig,
} from "./journal";
import { createMemoryStore } from "./memory";
import { renderMemoryBlocks } from "./prompt";
import {
  JournalRead,
  JournalSearch,
  JournalWrite,
  MemoryList,
  MemoryReplace,
  MemorySet,
} from "./tools";
import type { JournalContext } from "./tools";

export const MemoryPlugin: Plugin = async ({ directory }) => {
  const store = createMemoryStore(directory);
  await store.ensureSeed();

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
      const blocks = await store.listBlocks("all");
      const xml = renderMemoryBlocks(blocks);
      if (!xml) return;

      // Append memory blocks at the END of the system prompt (stable tail).
      // On opencode 1.18.x the hook receives a 1-element array, so splice(1) and push are byte-identical;
      // push is correct under both current and future (V2 runner) array shapes and keeps the static
      // provider/instructions prefix cacheable.
      output.system.push(xml);

      // Append journal instructions at the end (preserves memory block cache)
      if (journalSystemNote) {
        output.system.push(journalSystemNote);
      }
    },

    tool: {
      memory_list: MemoryList(store),
      memory_set: MemorySet(store),
      memory_replace: MemoryReplace(store),
      ...journalTools,
    },
  };
};
