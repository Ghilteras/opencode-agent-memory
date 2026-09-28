import { Plugin } from "@opencode/plugin";
import { createJournalStore, loadConfig } from "./journal";
import { JournalRead, JournalSearch, JournalWrite } from "./tools";
import type { JournalContext } from "./tools";
import { warmupEmbedder } from "./embeddings";

export default Plugin.define({
  id: "opencode-agent-memory",
  async setup(ctx) {
    const loadedConfig = await loadConfig();
    const { config } = loadedConfig;
    const configUsable = loadedConfig.status === "ok" || loadedConfig.status === "missing";
    if (!configUsable) {
      console.warn(`[agent-memory] journal config ${loadedConfig.configPath}: ${loadedConfig.reason ?? loadedConfig.status}; journal tools will NOT be registered`);
      return;
    }

    if (config.journal?.enabled === false) return;

    const journalStore = createJournalStore(undefined, config.cacheDir);
    void warmupEmbedder(config.cacheDir).catch(() => {});
    const contexts = new Map<string, JournalContext>();
    const directory = ctx.location.directory;
    const tools = [
      JournalWrite(journalStore, {
        directory,
        get model() { return ""; },
        get provider() { return ""; },
      }, config.journal?.tags),
      JournalRead(journalStore),
      JournalSearch(journalStore),
    ];

    // Register a per-session capture; a write resolves its own session's model.
    const writeTool = tools[0]!;
    writeTool.execute = async (input, toolCtx) => {
      const sessionContext = contexts.get(toolCtx.sessionID);
      const modelContext: JournalContext = {
        directory,
        model: sessionContext?.model ?? "",
        provider: sessionContext?.provider ?? "",
      };
      const contextual = JournalWrite(journalStore, modelContext, config.journal?.tags);
      return contextual.execute(input, toolCtx);
    };

    await ctx.session.hook("context", (input) => {
      contexts.set(input.sessionID, {
        directory,
        model: input.model.id,
        provider: input.model.providerID,
      });
    });
    await ctx.tool.transform((editor) => {
      // Transforms may be replayed; avoid duplicate registrations by effective tool name.
      const registered = new Set(editor.list().map((tool) => tool.name));
      for (const tool of tools) {
        if (!registered.has(tool.name)) editor.add(tool as never);
      }
    });
  },
});
