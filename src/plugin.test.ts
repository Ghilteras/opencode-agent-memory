import { describe, expect, mock, test } from "bun:test";

// Mock journal module so we don't hit the real filesystem for config/journal
const JOURNAL_NOTE = `<journal_instructions>
You have access to a private journal.
</journal_instructions>`;

mock.module("./journal", () => ({
  loadConfig: async () => ({
    journal: { enabled: true },
  }),
  createJournalStore: () => ({}),
  buildJournalSystemNote: () => JOURNAL_NOTE,
}));

// Mock embeddings to avoid model download
mock.module("./embeddings", () => ({
  warmupEmbedder: async () => {},
}));

import { MemoryPlugin } from "./plugin";
import type { PluginInput } from "@opencode-ai/plugin";

// Minimal stub: the plugin only reads `directory` from the input.
const stubInput = { directory: "/tmp/test-plugin-regression" } as unknown as PluginInput;

describe("plugin transform hook — journal regression", () => {
  test("journal system note is injected when enabled and no blocks present", async () => {
    const plugin = await MemoryPlugin(stubInput);

    const transform = plugin["experimental.chat.system.transform"];
    expect(transform).toBeDefined();

    const output = { system: [] as string[] };
    // The chat.message hook expects a model param; the transform hook does not use it.
    // Pass a minimal mock for the transform signature.
    await (transform as Function)({}, output);

    // The journal note MUST be present — this is the core regression check.
    // With the old early-return (`if (!xml) return;`), when renderMemoryBlocks
    // returned "" (no blocks), the entire transform returned before pushing
    // journalSystemNote, silently disabling the journal.
    expect(output.system).toContain(JOURNAL_NOTE);
  });

  test("journal system note is pushed exactly once", async () => {
    const plugin = await MemoryPlugin(stubInput);

    const transform = plugin["experimental.chat.system.transform"];
    const output = { system: [] as string[] };
    await (transform as Function)({}, output);

    const count = output.system.filter((s) => s === JOURNAL_NOTE).length;
    expect(count).toBe(1);
  });

  test("empty system array is populated (not left untouched)", async () => {
    const plugin = await MemoryPlugin(stubInput);

    const transform = plugin["experimental.chat.system.transform"];
    const output = { system: [] as string[] };
    await (transform as Function)({}, output);

    expect(output.system.length).toBeGreaterThan(0);
  });
});
