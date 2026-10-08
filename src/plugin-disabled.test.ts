import { expect, mock, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as realEmbeddings from "./embeddings";

if (process.env.HOME === undefined || !process.env.HOME.startsWith("/tmp/")) {
  throw new Error("plugin tests require HOME pointed at a /tmp fixture directory; run via `bun run test:plugin`");
}

const configDir = path.join(process.env.HOME, ".config", "opencode");

mock.module("./embeddings", () => ({
  ...realEmbeddings,
  generateEmbedding: async () => Array.from({ length: 384 }, (_, i) => Math.sin(i) * 0.5),
  warmupEmbedder: async () => {},
}));

import plugin from "./plugin";

test("explicit opt-out registers no tools and emits no warning", async () => {
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(path.join(configDir, "agent-memory.json"), JSON.stringify({ journal: { enabled: false } }), "utf-8");
  const definitions: unknown[] = [];
  const warn = console.warn;
  let warnings = 0;
  console.warn = () => { warnings++; };
  try {
    await plugin.setup({
      location: { directory: "/tmp" },
      session: { hook: async () => {} },
      tool: { transform: async (callback: (editor: { add: (tool: unknown) => void; list: () => unknown[] }) => void) => callback({ add: (tool) => definitions.push(tool), list: () => [] }) },
    } as any);
    expect(definitions).toEqual([]);
    expect(warnings).toBe(0);
  } finally {
    console.warn = warn;
    await fs.rm(configDir, { recursive: true, force: true });
  }
});
