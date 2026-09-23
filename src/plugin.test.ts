import { describe, expect, mock, test } from "bun:test";
import type { LoadedConfig } from "./journal";

let loadedConfig: LoadedConfig = {
  config: { journal: { enabled: true } },
  status: "ok" as const,
  configPath: "/tmp/test-plugin/agent-memory.json",
};

// Mock journal module so we don't hit the real filesystem for config/journal
mock.module("./journal", () => ({
  loadConfig: async () => loadedConfig,
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

type FaultStatus = Exclude<LoadedConfig["status"], "ok">;

const faultCases: Array<{
  status: FaultStatus;
  reason: string;
  config: LoadedConfig["config"];
}> = [
  { status: "missing", reason: "file is missing", config: {} },
  { status: "unreadable", reason: "read failed (EACCES)", config: {} },
  { status: "malformed", reason: "malformed JSON", config: {} },
  {
    // A non-ok status must win even if the mocked config is truthy.
    status: "invalid",
    reason: "schema validation failed",
    config: { journal: { enabled: true } },
  },
];

const okCases: Array<{
  name: string;
  config: LoadedConfig["config"];
  expectedToolCount: number;
}> = [
  {
    name: "enabled",
    config: { journal: { enabled: true } },
    expectedToolCount: 3,
  },
  {
    name: "disabled",
    config: { journal: { enabled: false } },
    expectedToolCount: 0,
  },
];

function resetLoadedConfig(): void {
  loadedConfig = {
    config: { journal: { enabled: true } },
    status: "ok",
    configPath: "/tmp/test-plugin/agent-memory.json",
  };
}

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

  for (const testCase of faultCases) {
    test(`warns and disables tools for ${testCase.status} config`, async () => {
      loadedConfig = {
        config: testCase.config,
        status: testCase.status,
        configPath: "/tmp/test-plugin/agent-memory.json",
        reason: testCase.reason,
      };
      const originalWarn = console.warn;
      const warnings: unknown[][] = [];
      console.warn = (...args: unknown[]) => warnings.push(args);

      try {
        const plugin = await MemoryPlugin(stubInput);
        expect(Object.keys(plugin.tool ?? {})).toHaveLength(0);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]?.[0]).toBe(
          `[agent-memory] journal config /tmp/test-plugin/agent-memory.json: ${testCase.reason}; journal tools will NOT be registered`,
        );
      } finally {
        console.warn = originalWarn;
        resetLoadedConfig();
      }
    });
  }

  for (const testCase of okCases) {
    test(`does not warn for valid ${testCase.name} config`, async () => {
      loadedConfig = {
        config: testCase.config,
        status: "ok",
        configPath: "/tmp/test-plugin/agent-memory.json",
      };
      const originalWarn = console.warn;
      const warnings: unknown[][] = [];
      console.warn = (...args: unknown[]) => warnings.push(args);

      try {
        const plugin = await MemoryPlugin(stubInput);
        expect(Object.keys(plugin.tool ?? {})).toHaveLength(testCase.expectedToolCount);
        expect(warnings).toHaveLength(0);
      } finally {
        console.warn = originalWarn;
        resetLoadedConfig();
      }
    });
  }
});
