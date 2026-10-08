import { afterEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { LoadedConfig, JournalEntry } from "./journal";

let loadedConfig: LoadedConfig = { config: {}, status: "missing", configPath: "/tmp/test/agent-memory.json", reason: "file is missing" };
const writes: Array<Record<string, unknown>> = [];
mock.module("./journal", () => ({
  loadConfig: async () => loadedConfig,
  createJournalStore: () => ({
    write: async (entry: Record<string, unknown>) => {
      writes.push(entry);
      return { id: "id-1", title: entry.title, created: new Date("2026-01-01T00:00:00.000Z") } as JournalEntry;
    },
    read: async () => { throw new Error("unused"); },
    search: async () => ({ entries: [], total: 0, allTags: [] }),
  }),
}));
mock.module("./embeddings", () => ({ warmupEmbedder: async () => {} }));

import plugin from "./plugin";

function harness(directory = "/tmp/project") {
  const definitions = new Map<string, any>();
  let contextHook: ((event: any) => void) | undefined;
  let transform: ((editor: { add: (definition: any) => void; list: () => any[] }) => void) | undefined;
  const context = {
    location: { directory },
    session: { hook: async (name: string, callback: (event: any) => void) => { expect(name).toBe("context"); contextHook = callback; } },
    tool: { transform: async (callback: typeof transform) => { transform = callback; callback!({ add: (definition) => definitions.set(definition.name, definition), list: () => [...definitions.values()] }); } },
  } as any;
  return { definitions, contextHook: () => contextHook, replay: () => transform!({ add: (definition) => definitions.set(definition.name, definition), list: () => [...definitions.values()] }), start: () => plugin.setup(context) };
}

afterEach(() => {
  loadedConfig = { config: {}, status: "missing", configPath: "/tmp/test/agent-memory.json", reason: "file is missing" };
  writes.length = 0;
});

describe("v2 plugin registration", () => {
  test("has a stable id and default-registers exactly the three journal tools", async () => {
    expect(plugin.id).toBe("opencode-agent-memory");
    const h = harness();
    await h.start();
    expect([...h.definitions.keys()].sort()).toEqual(["journal_read", "journal_search", "journal_write"]);
  });

  test("registered write description suggests configured tag names without their descriptions", async () => {
    loadedConfig = {
      config: {
        journal: {
          tags: [
            { name: "owner_approved", description: "Use for a choice made and its rationale." },
            { name: "incident_followup", description: "Use for investigation notes and findings." },
          ],
        },
      },
      status: "ok",
      configPath: "/tmp/test/agent-memory.json",
    };

    const h = harness();
    await h.start();
    const description = h.definitions.get("journal_write").description as string;

    expect(description).toContain("Suggested tags: owner_approved, incident_followup.");
    expect(description).not.toContain("Use for a choice made and its rationale.");
    expect(description).not.toContain("Use for investigation notes and findings.");
  });

  test("transform replay does not duplicate tool registration", async () => {
    const h = harness(); await h.start();
    h.replay();
    expect([...h.definitions.keys()].sort()).toEqual(["journal_read", "journal_search", "journal_write"]);
  });

  test("explicit false opts out without tools", async () => {
    loadedConfig = { config: { journal: { enabled: false } }, status: "ok", configPath: "/tmp/test/agent-memory.json" };
    const h = harness(); await h.start();
    expect([...h.definitions.keys()]).toEqual([]);
  });

  test("invalid journal typo fails closed and warns", async () => {
    loadedConfig = { config: {}, status: "invalid", configPath: "/tmp/test/agent-memory.json", reason: "schema validation failed" };
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args);
    try {
      const h = harness(); await h.start();
      expect([...h.definitions.keys()]).toEqual([]);
      expect(warnings).toEqual([["[agent-memory] journal config /tmp/test/agent-memory.json: schema validation failed; journal tools will NOT be registered"]]);
    } finally { console.warn = originalWarn; }
  });

  for (const status of ["unreadable", "malformed", "invalid"] as const) {
    test(`fails closed on ${status} config`, async () => {
      loadedConfig = { config: { journal: { enabled: true } }, status, configPath: "/tmp/test/agent-memory.json", reason: "bad config" };
      const warnings: unknown[][] = [];
      const originalWarn = console.warn;
      console.warn = (...args) => warnings.push(args);
      try {
        const h = harness(); await h.start();
        expect([...h.definitions.keys()]).toEqual([]);
        expect(warnings).toEqual([["[agent-memory] journal config /tmp/test/agent-memory.json: bad config; journal tools will NOT be registered"]]);
      } finally { console.warn = originalWarn; }
    });
  }

  test("default absent config emits no warning", async () => {
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args);
    try { const h = harness(); await h.start(); expect(warnings).toEqual([]); }
    finally { console.warn = originalWarn; }
  });

  test("captures model/provider per session for interleaved context events", async () => {
    const h = harness(); await h.start();
    const hook = h.contextHook()!;
    hook({ sessionID: "session-a", model: { id: "model-a", providerID: "provider-a" } });
    hook({ sessionID: "session-b", model: { id: "model-b", providerID: "provider-b" } });
    hook({ sessionID: "session-a", model: { id: "model-a2", providerID: "provider-a2" } });
    await h.definitions.get("journal_write").execute({ title: "Title", body: "Body" }, { agent: "agent", sessionID: "session-b" });
    expect(writes[0]).toMatchObject({ model: "model-b", provider: "provider-b", sessionId: "session-b" });
  });
});

describe("project journal index injection", () => {
  const event = () => ({ sessionID: "s", model: { id: "m", providerID: "p" }, system: [] as Array<{ type: "text"; text: string }> });
  async function project(body?: string) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "memory-index-"));
    if (body !== undefined) await fs.writeFile(path.join(directory, "MEMORY.md"), body);
    return directory;
  }

  test("injects a byte-stable rendered index at exact word fit", async () => {
    const directory = await project(Array(330).fill("pointer").join(" "));
    try {
      const h = harness(directory); await h.start();
      const first = event(); const second = event();
      await h.contextHook()!(first); await h.contextHook()!(second);
      expect(first.system).toEqual(second.system);
      expect(first.system).toHaveLength(1);
      expect(first.system[0]!.text).toBe(`This is the project's journal-pointer index (MEMORY.md at the repository root). Retrieve entries with journal_search/journal_read; older lines remain relevant.\n\n${Array(330).fill("pointer").join(" ")}`);
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  });

  test("331 words injects only the fixed notice", async () => {
    const directory = await project(Array(331).fill("pointer").join(" "));
    try { const h = harness(directory); await h.start(); const e = event(); await h.contextHook()!(e); expect(e.system).toEqual([{ type: "text", text: "Project journal index (MEMORY.md) exceeds the injection cap; read the file at the repository root directly for the pointer list." }]); }
    finally { await fs.rm(directory, { recursive: true, force: true }); }
  });

  test("empty, missing, and unreadable indexes inject nothing", async () => {
    const empty = await project("  \n\t");
    const missing = await project();
    const unreadable = path.join(os.tmpdir(), `memory-index-file-${Date.now()}`);
    await fs.writeFile(unreadable, "not a directory");
    try {
      for (const directory of [empty, missing, unreadable]) {
        const h = harness(directory); await h.start(); const e = event(); await h.contextHook()!(e); expect(e.system).toEqual([]);
      }
    } finally {
      await fs.rm(empty, { recursive: true, force: true });
      await fs.rm(missing, { recursive: true, force: true });
      await fs.rm(unreadable, { force: true });
    }
  });

  test("strips frontmatter; enforces UTF-8 byte cap for long Unicode tokens", async () => {
    const directory = await project(`---\ntitle: hidden\n---\nvisible pointer`);
    try { const h = harness(directory); await h.start(); const e = event(); await h.contextHook()!(e); expect(e.system[0]!.text).toContain("\n\nvisible pointer"); expect(e.system[0]!.text).not.toContain("hidden"); }
    finally { await fs.rm(directory, { recursive: true, force: true }); }
    const large = await project("界".repeat(8192));
    try { const h = harness(large); await h.start(); const e = event(); await h.contextHook()!(e); expect(e.system[0]!.text).toBe("Project journal index (MEMORY.md) exceeds the injection cap; read the file at the repository root directly for the pointer list."); }
    finally { await fs.rm(large, { recursive: true, force: true }); }
  });

  test("disabled journal registers no hook or injection", async () => {
    const directory = await project("pointer");
    try { loadedConfig = { config: { journal: { enabled: false } }, status: "ok", configPath: "/tmp/test/agent-memory.json" }; const h = harness(directory); await h.start(); expect(h.contextHook()).toBeUndefined(); }
    finally { await fs.rm(directory, { recursive: true, force: true }); }
  });
});
