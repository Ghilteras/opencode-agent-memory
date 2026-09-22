import { describe, expect, mock, test } from "bun:test";

// Mock journal module with journal DISABLED — the control path.
mock.module("./journal", () => ({
  loadConfig: async () => ({
    journal: { enabled: false },
  }),
  createJournalStore: () => ({}),
}));

// Mock embeddings to avoid model download
mock.module("./embeddings", () => ({
  warmupEmbedder: async () => {},
}));

import { MemoryPlugin } from "./plugin";
import type { PluginInput } from "@opencode-ai/plugin";

const stubInput = { directory: "/tmp/test-plugin-disabled" } as unknown as PluginInput;

describe("plugin disabled path", () => {
  test("registers zero tools when journal is disabled", async () => {
    const plugin = await MemoryPlugin(stubInput);
    // tool should be undefined or an empty object
    if (plugin.tool) {
      expect(Object.keys(plugin.tool)).toHaveLength(0);
    } else {
      expect(plugin.tool).toBeUndefined();
    }
  });

  test("produces no guidance text when disabled", async () => {
    const plugin = await MemoryPlugin(stubInput);
    // There should be no system transform hook injecting guidance
    expect(plugin["experimental.chat.system.transform"]).toBeUndefined();
    // Tool definitions (if any exist as empty object) must not contain
    // any description with journal guidance keywords
    if (plugin.tool) {
      for (const def of Object.values(plugin.tool)) {
        const desc = (def as { description?: string }).description ?? "";
        expect(desc).not.toMatch(/append-only|journal|search.*entry/i);
      }
    }
  });

  test("chat.message hook is still present when disabled", async () => {
    const plugin = await MemoryPlugin(stubInput);
    // The chat.message hook updates model/provider context — it should
    // still be present even when journal is disabled.
    expect(plugin["chat.message"]).toBeDefined();
    expect(typeof plugin["chat.message"]).toBe("function");
  });
});
