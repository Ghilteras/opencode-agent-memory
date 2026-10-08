import { Plugin } from "@opencode/plugin";
import { createJournalStore, loadConfig } from "./journal";
import { JournalRead, JournalSearch, JournalWrite } from "./tools";
import type { JournalContext } from "./tools";
import { warmupEmbedder } from "./embeddings";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { splitFrontmatter } from "./frontmatter";

const INDEX_NOTICE = "Project journal index (MEMORY.md) exceeds the injection cap; read the file at the repository root directly for the pointer list.";
const INDEX_WRAPPER = "This is the project's journal-pointer index (MEMORY.md at the repository root). Retrieve entries with journal_search/journal_read; older lines remain relevant.";
const MAX_INDEX_WORDS = 330;
const MAX_INDEX_BYTES = 8192;

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
    // Location.Info.directory is the project directory (there is no separate root field).
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

    await ctx.session.hook("context", async (input) => {
      contexts.set(input.sessionID, {
        directory,
        model: input.model.id,
        provider: input.model.providerID,
      });
      try {
        const source = await fs.readFile(path.join(directory, "MEMORY.md"), "utf8");
        const body = splitFrontmatter(source).body;
        if (body.trim().length === 0) return;
        const rendered = `${INDEX_WRAPPER}\n\n${body}`;
        const words = body.trim().split(/\s+/).length;
        input.system.push({ type: "text", text: words <= MAX_INDEX_WORDS && Buffer.byteLength(rendered, "utf8") <= MAX_INDEX_BYTES ? rendered : INDEX_NOTICE });
      } catch {
        // Missing and unreadable project indexes are intentionally silent.
      }
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
