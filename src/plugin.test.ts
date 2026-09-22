import { describe, expect, mock, test } from "bun:test";

// Mock journal module so we don't hit the real filesystem for config/journal
mock.module("./journal", () => ({
  loadConfig: async () => ({
    journal: { enabled: true },
  }),
  createJournalStore: () => ({}),
}));

// Mock embeddings to avoid model download
mock.module("./embeddings", () => ({
  warmupEmbedder: async () => {},
}));

import { MemoryPlugin } from "./plugin";
import type { PluginInput } from "@opencode-ai/plugin";

// Minimal stub: the plugin only reads `directory` from the input.
const stubInput = { directory: "/tmp/test-plugin-regression" } as unknown as PluginInput;

describe("plugin structure", () => {
  test("returns chat.message hook", async () => {
    const plugin = await MemoryPlugin(stubInput);
    expect(plugin["chat.message"]).toBeDefined();
    expect(typeof plugin["chat.message"]).toBe("function");
  });

  test("does NOT return experimental.chat.system.transform hook", async () => {
    const plugin = await MemoryPlugin(stubInput);
    expect(plugin["experimental.chat.system.transform"]).toBeUndefined();
  });

  test("registers journal tools when enabled", async () => {
    const plugin = await MemoryPlugin(stubInput);
    expect(plugin.tool).toBeDefined();
    expect(plugin.tool!["journal_write"]).toBeDefined();
    expect(plugin.tool!["journal_read"]).toBeDefined();
    expect(plugin.tool!["journal_search"]).toBeDefined();
  });
});
