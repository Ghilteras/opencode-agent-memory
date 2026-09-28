import { afterEach, expect, mock, test } from "bun:test";

mock.module("./journal", () => ({
  loadConfig: async () => ({ config: { journal: { enabled: false } }, status: "ok", configPath: "/tmp/disabled/agent-memory.json" }),
  createJournalStore: () => ({}),
}));
mock.module("./embeddings", () => ({ warmupEmbedder: async () => {} }));
import plugin from "./plugin";

afterEach(() => mock.restore());

test("explicit opt-out registers no tools and emits no warning", async () => {
  const definitions: unknown[] = [];
  const warn = console.warn;
  let warnings = 0;
  console.warn = () => { warnings++; };
  try {
    await plugin.setup({
      location: { directory: "/tmp" },
      session: { hook: async () => {} },
      tool: { transform: async (callback: (editor: { add: (tool: unknown) => void }) => void) => callback({ add: (tool) => definitions.push(tool) }) },
    } as any);
    expect(definitions).toEqual([]);
    expect(warnings).toBe(0);
  } finally { console.warn = warn; }
});
