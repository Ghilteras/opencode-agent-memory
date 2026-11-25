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
const INDEX_PARTIAL_NOTICE = (omitted: number, total: number) =>
  `[memory index truncated: ${omitted} of ${total} entries omitted; use journal_search for older pointers]`;
const FRESHNESS_TIMEOUT_MS = 1500;
const freshnessChecked = new Set<string>();

// The harness injects AGENTS.md/TOOLS.md/MEMORY.md from the session directory; a worktree whose
// committed copy of those files differs from origin/main silently injects stale rules. Compares
// CONTENT, not commit count: a squash-landed branch with identical files must stay silent. One
// bounded check per session, silent on every unknown (not a repo, no origin/main, git missing, timeout).
async function stalenessWarning(directory: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(
      ["git", "-C", directory, "diff", "--quiet", "HEAD", "origin/main", "--", "AGENTS.md", "TOOLS.md", "MEMORY.md"],
      { stdout: "ignore", stderr: "ignore" },
    );
    const timer = setTimeout(() => { try { proc.kill(); } catch {} }, FRESHNESS_TIMEOUT_MS);
    const code = await proc.exited;
    clearTimeout(timer);
    // 0 = identical, 1 = differ, anything else (no origin/main, not a repo, git missing) = unknown.
    if (code !== 1) return null;
    return "⚠️ The injected files (AGENTS.md/TOOLS.md/MEMORY.md) differ from origin/main in this directory: if you did not change them deliberately, fetch and rebase — the rules you are reading may be stale.";
  } catch {
    return null;
  }
}

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

    function renderIndex(body: string): string {
      const records = body
        .split(/\n-{3,}\n/)
        .map((record) => record.trim())
        .filter((record) => record.length > 0);
      if (records.length === 0) return "";
      const fits = (recordsText: string, rendered: string) => {
        const trimmed = recordsText.trim();
        const words = trimmed ? trimmed.split(/\s+/).length : 0;
        return words <= MAX_INDEX_WORDS && Buffer.byteLength(rendered, "utf8") <= MAX_INDEX_BYTES;
      };
      const assemble = (kept: string[]) => `${INDEX_WRAPPER}\n\n${kept.join("\n\n---\n\n")}`;
      if (fits(records.join("\n\n---\n\n"), assemble(records))) return assemble(records);
      // Whole records only, in authored order: an oversized entry is skipped, never cut, and the
      // newest entries that fit are kept so a single bloated record cannot black out the index.
      const kept: string[] = [];
      let omitted = 0;
      for (const record of records) {
        const candidate = [...kept, record];
        if (fits(candidate.join("\n\n---\n\n"), assemble(candidate))) kept.push(record);
        else omitted += 1;
      }
      if (kept.length === 0) return INDEX_NOTICE;
      // The partial notice is appended AFTER the caps are satisfied, so re-check the whole string.
      // If the notice pushes it over, drop the last kept record (counting it as omitted) instead of
      // falling back to the zero-pointer notice: an index that fits must never black out because of
      // the sentence explaining what was omitted.
      const selected = [...kept];
      while (selected.length > 0) {
        const omittedNow = records.length - selected.length;
        const rendered = `${assemble(selected)}\n\n${INDEX_PARTIAL_NOTICE(omittedNow, records.length)}`;
        if (Buffer.byteLength(rendered, "utf8") <= MAX_INDEX_BYTES) return rendered;
        selected.pop();
      }
      return INDEX_NOTICE;
    }

    await ctx.session.hook("context", async (input) => {
      contexts.set(input.sessionID, {
        directory,
        model: input.model.id,
        provider: input.model.providerID,
      });
      if (!freshnessChecked.has(input.sessionID)) {
        freshnessChecked.add(input.sessionID);
        const warning = await stalenessWarning(directory);
        if (warning) input.system.push({ type: "text", text: warning });
      }
      try {
        const source = await fs.readFile(path.join(directory, "MEMORY.md"), "utf8");
        const body = splitFrontmatter(source).body;
        if (body.trim().length === 0) return;
        const rendered = renderIndex(body);
        if (rendered.length === 0) return;
        input.system.push({ type: "text", text: rendered });
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
