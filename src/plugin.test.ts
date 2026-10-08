import { afterEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as realEmbeddings from "./embeddings";

// These tests run in their own bun process (package.json "test:plugin") with
// HOME pointed at a throwaway fixture directory, so the real loadConfig and
// createJournalStore exercise real fixture files. Refuse to run against the
// real home directory. Only the model-loading surface of ./embeddings is
// stubbed, spreading the real module so other exports keep real values.
if (process.env.HOME === undefined || !process.env.HOME.startsWith("/tmp/")) {
  throw new Error("plugin tests require HOME pointed at a /tmp fixture directory; run via `bun run test:plugin`");
}

const fixtureHome = process.env.HOME;
const configDir = path.join(fixtureHome, ".config", "opencode");
const configPath = path.join(configDir, "agent-memory.json");
const journalDir = path.join(configDir, "journal");

mock.module("./embeddings", () => ({
  ...realEmbeddings,
  generateEmbedding: async () => Array.from({ length: 384 }, (_, i) => Math.sin(i) * 0.5),
  warmupEmbedder: async () => {},
}));

import plugin from "./plugin";

// value === undefined creates a DIRECTORY at the config path (unreadable);
// a string is written raw (malformed JSON); an object is JSON-encoded.
async function writeConfig(value: unknown): Promise<void> {
  await fs.mkdir(configDir, { recursive: true });
  if (value === undefined) {
    await fs.mkdir(configPath, { recursive: true });
  } else if (typeof value === "string") {
    await fs.writeFile(configPath, value, "utf-8");
  } else {
    await fs.writeFile(configPath, JSON.stringify(value), "utf-8");
  }
}

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

afterEach(async () => {
  await fs.rm(configDir, { recursive: true, force: true });
});

describe("v2 plugin registration", () => {
  test("has a stable id and default-registers exactly the three journal tools", async () => {
    expect(plugin.id).toBe("opencode-agent-memory");
    await fs.rm(configDir, { recursive: true, force: true }); // absent config: default-on journal tools
    const h = harness();
    await h.start();
    expect([...h.definitions.keys()].sort()).toEqual(["journal_read", "journal_search", "journal_write"]);
  });

  test("registered write description suggests configured tag names without their descriptions", async () => {
    await writeConfig({ journal: { tags: [
      { name: "owner_approved", description: "Use for a choice made and its rationale." },
      { name: "incident_followup", description: "Use for investigation notes and findings." },
    ] } });
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
    await writeConfig({ journal: { enabled: false } });
    const h = harness(); await h.start();
    expect([...h.definitions.keys()]).toEqual([]);
  });

  test("invalid journal typo fails closed and warns", async () => {
    await writeConfig({ journal: { enabled_: false } });
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args);
    try {
      const h = harness(); await h.start();
      expect([...h.definitions.keys()]).toEqual([]);
      expect(warnings).toEqual([[`[agent-memory] journal config ${configPath}: schema validation failed; journal tools will NOT be registered`]]);
    } finally { console.warn = originalWarn; }
  });

  test("fails closed on unreadable config", async () => {
    await writeConfig(undefined);
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args);
    try {
      const h = harness(); await h.start();
      expect([...h.definitions.keys()]).toEqual([]);
      expect(warnings).toEqual([[`[agent-memory] journal config ${configPath}: read failed (EISDIR); journal tools will NOT be registered`]]);
    } finally { console.warn = originalWarn; }
  });

  test("fails closed on malformed config", async () => {
    await writeConfig("not json{{{");
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args);
    try {
      const h = harness(); await h.start();
      expect([...h.definitions.keys()]).toEqual([]);
      expect(warnings).toEqual([[`[agent-memory] journal config ${configPath}: malformed JSON; journal tools will NOT be registered`]]);
    } finally { console.warn = originalWarn; }
  });

  test("fails closed on invalid config", async () => {
    await writeConfig({ journal: { enabled: "yes" } });
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args);
    try {
      const h = harness(); await h.start();
      expect([...h.definitions.keys()]).toEqual([]);
      expect(warnings).toEqual([[`[agent-memory] journal config ${configPath}: schema validation failed; journal tools will NOT be registered`]]);
    } finally { console.warn = originalWarn; }
  });

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
    const files = (await fs.readdir(journalDir)).filter((f) => f.endsWith(".md"));
    expect(files).toHaveLength(1);
    const text = await fs.readFile(path.join(journalDir, files[0]!), "utf-8");
    expect(text).toContain("model: model-b");
    expect(text).toContain("provider: provider-b");
    expect(text).toContain("session_id: session-b");
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
    try { await writeConfig({ journal: { enabled: false } }); const h = harness(directory); await h.start(); expect(h.contextHook()).toBeUndefined(); }
    finally { await fs.rm(directory, { recursive: true, force: true }); }
  });
});
