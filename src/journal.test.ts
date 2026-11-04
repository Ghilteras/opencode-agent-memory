import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as realEmbeddings from "./embeddings";
import { writeFileNoReplace } from "./frontmatter";
import NativeMiniSearch from "minisearch";

let embeddingGenerationCalls = 0;
let lexicalIndexConstructions = 0;

class CountingMiniSearch extends (NativeMiniSearch as any) {
  constructor(...args: any[]) {
    super(...args);
    lexicalIndexConstructions++;
  }
}

mock.module("minisearch", () => ({ default: CountingMiniSearch }));

// Mock the embeddings module to avoid downloading a real model in tests.
// Spread the real module so every export not overridden here keeps its real
// value regardless of test-file discovery order.
mock.module("./embeddings", () => ({
  ...realEmbeddings,
  generateEmbedding: async () => {
    embeddingGenerationCalls++;
    return Array.from({ length: 8 }, (_, i) => i / 8);
  },
  EMBEDDING_DIMENSION: 8,
  embeddingModelName: () => "test-model",
}));

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join("/tmp/", "opencode-journal-"));
}

// Bind the journal module AFTER the embeddings mock registration (above) via
// dynamic import, so the store uses the fake embeddings regardless of bun's
// module-mock rewiring semantics; a static import would be hoisted above it.
let createJournalStore!: (typeof import("./journal"))["createJournalStore"];
let loadConfig!: (typeof import("./journal"))["loadConfig"];

beforeAll(async () => {
  ({ createJournalStore, loadConfig } = await import("./journal"));
});

describe("loadConfig", () => {
  test("classifies a missing file and returns an empty config", async () => {
    const dir = await mkTmpDir();
    const loaded = await loadConfig(dir);
    expect(loaded.status).toBe("missing");
    expect(loaded.config).toEqual({});
  });

  test("classifies an unreadable file and returns an empty config", async () => {
    const dir = await mkTmpDir();
    await fs.mkdir(path.join(dir, "agent-memory.json"));
    const loaded = await loadConfig(dir);
    expect(loaded.status).toBe("unreadable");
    expect(loaded.config).toEqual({});
  });

  test("classifies malformed JSON and returns an empty config", async () => {
    const dir = await mkTmpDir();
    await fs.writeFile(path.join(dir, "agent-memory.json"), "not json{{{");
    const loaded = await loadConfig(dir);
    expect(loaded.status).toBe("malformed");
    expect(loaded.config).toEqual({});
  });

  test("classifies schema-invalid JSON and returns an empty config", async () => {
    const dir = await mkTmpDir();
    await fs.writeFile(
      path.join(dir, "agent-memory.json"),
      JSON.stringify({ journal: { enabled: "yes" } }),
    );
    const loaded = await loadConfig(dir);
    expect(loaded.status).toBe("invalid");
    expect(loaded.config).toEqual({});
  });

  test("rejects an unrecognized journal key instead of silently enabling", async () => {
    const dir = await mkTmpDir();
    await fs.writeFile(path.join(dir, "agent-memory.json"), JSON.stringify({ journal: { enabled_: false } }));
    const loaded = await loadConfig(dir);
    expect(loaded.status).toBe("invalid");
    expect(loaded.config).toEqual({});
  });

  test("classifies valid disabled config without changing it", async () => {
    const dir = await mkTmpDir();
    await fs.writeFile(
      path.join(dir, "agent-memory.json"),
      JSON.stringify({ journal: { enabled: false } }),
    );
    const loaded = await loadConfig(dir);
    expect(loaded.status).toBe("ok");
    expect(loaded.config).toEqual({ journal: { enabled: false } });
  });

  test("classifies valid enabled config without changing it", async () => {
    const dir = await mkTmpDir();
    await fs.writeFile(
      path.join(dir, "agent-memory.json"),
      JSON.stringify({ journal: { enabled: true } }),
    );
    const loaded = await loadConfig(dir);
    expect(loaded.status).toBe("ok");
    expect(loaded.config).toEqual({ journal: { enabled: true } });
  });

  test("returns custom tags from config", async () => {
    const dir = await mkTmpDir();
    await fs.writeFile(
      path.join(dir, "agent-memory.json"),
      JSON.stringify({
        journal: {
          enabled: true,
          tags: [
            { name: "perf", description: "Performance optimization work" },
            { name: "debug", description: "Debugging sessions" },
          ],
        },
      }),
    );
    const loaded = await loadConfig(dir);
    expect(loaded.config.journal?.tags).toEqual([
      { name: "perf", description: "Performance optimization work" },
      { name: "debug", description: "Debugging sessions" },
    ]);
  });
});

describe("journal store", () => {
  let tmpDir: string;

  afterEach(async () => {
    embeddingGenerationCalls = 0;
    lexicalIndexConstructions = 0;
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("write creates entry file with correct metadata", async () => {
    tmpDir = await mkTmpDir();
    const store = createJournalStore(tmpDir);

    const entry = await store.write({
      title: "Test insight",
      body: "Discovered an interesting pattern.",
      project: "/home/user/project",
      model: "claude-opus-4-6",
      provider: "anthropic",
      tags: ["testing"],
    });

    expect(entry.title).toBe("Test insight");
    expect(entry.project).toBe("/home/user/project");
    expect(entry.model).toBe("claude-opus-4-6");
    expect(entry.provider).toBe("anthropic");
    expect(entry.tags).toEqual(["testing"]);
    expect(entry.body).toBe("Discovered an interesting pattern.");
    expect(entry.id).toMatch(/^\d{8}-\d{6}-\d{3}$/);

    // Verify file exists
    const raw = await fs.readFile(entry.filePath, "utf-8");
    expect(raw).toContain("title: Test insight");
  });

  test("same-millisecond writes preserve both append-only entries", async () => {
    tmpDir = await mkTmpDir();
    const store = createJournalStore(tmpDir);
    const RealDate = Date;
    const fixedTime = new RealDate("2026-11-04T12:34:56.789Z").getTime();
    globalThis.Date = class extends RealDate {
      constructor(value?: string | number | Date) {
        if (arguments.length === 0) super(fixedTime);
        else super(value as string | number);
      }
    } as DateConstructor;

    try {
      const first = await store.write({ title: "First collision", body: "First collision body" });
      const second = await store.write({ title: "Second collision", body: "Second collision body" });
      const files = (await fs.readdir(path.join(tmpDir, "journal"))).filter((name) => name.endsWith(".md"));

      expect(files).toHaveLength(2);
      expect(second.id).not.toBe(first.id);
      expect(second.id).toEndWith("-1");
      const contents = await Promise.all(files.map((name) => fs.readFile(path.join(tmpDir, "journal", name), "utf-8")));
      expect(contents.some((content) => content.includes("First collision body"))).toBe(true);
      expect(contents.some((content) => content.includes("Second collision body"))).toBe(true);
    } finally {
      globalThis.Date = RealDate;
    }
  });

  test("concurrent processes preserve every journal entry", async () => {
    tmpDir = await mkTmpDir();
    const moduleUrl = new URL("./journal.ts", import.meta.url).href;
    const children = Array.from({ length: 20 }, (_, index) => {
      const script = `
        const { createJournalStore } = await import(${JSON.stringify(moduleUrl)});
        await createJournalStore(${JSON.stringify(tmpDir)}).write({ title: "Writer ${index}", body: "Concurrent body ${index}" });
      `;
      return Bun.spawn([process.execPath, "-e", script], {
        env: { ...process.env, HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" },
        stdout: "pipe",
        stderr: "pipe",
      });
    });
    const results = await Promise.all(children.map(async (child) => ({
      code: await child.exited,
      stdout: await new Response(child.stdout).text(),
      stderr: await new Response(child.stderr).text(),
    })));
    expect(results.map(({ code }) => code)).toEqual(Array(20).fill(0));

    const files = (await fs.readdir(path.join(tmpDir, "journal"))).filter((name) => name.endsWith(".md"));
    expect(files).toHaveLength(20);
    const contents = await Promise.all(files.map((name) => fs.readFile(path.join(tmpDir, "journal", name), "utf-8")));
    for (let index = 0; index < 20; index++) {
      expect(contents.some((content) => content.includes(`Concurrent body ${index}`))).toBe(true);
    }
  }, 30_000);

  test("a same-millisecond collision invalidates a warmed lexical index", async () => {
    tmpDir = await mkTmpDir();
    const store = createJournalStore(tmpDir);
    const RealDate = Date;
    const fixedTime = new RealDate("2026-11-04T12:34:56.789Z").getTime();
    globalThis.Date = class extends RealDate {
      constructor(value?: string | number | Date) {
        if (arguments.length === 0) super(fixedTime);
        else super(value as string | number);
      }
    } as DateConstructor;

    try {
      await store.write({ title: "Initial", body: "initialonlytoken" });
      await store.search({ text: "initialonlytoken" });
      await store.write({ title: "New collision", body: "collisiononlytoken" });
      const files = (await fs.readdir(path.join(tmpDir, "journal"))).filter((name) => name.endsWith(".md"));
      expect(files).toHaveLength(2);

      const initialResult = await store.search({ text: "initialonlytoken" });
      expect(initialResult.entries.map(({ body }) => body)).toContain("initialonlytoken");
      const result = await store.search({ text: "collisiononlytoken" });
      expect(result.entries.map(({ body }) => body)).toEqual(["collisiononlytoken"]);
    } finally {
      globalThis.Date = RealDate;
    }
  });

  test("failed temporary-file creation leaves no temp file", async () => {
    tmpDir = await mkTmpDir();
    const blocker = path.join(tmpDir, "not-a-directory");
    await fs.writeFile(blocker, "file");

    await expect(writeFileNoReplace(path.join(blocker, "child"), "entry.md", "body")).rejects.toThrow();
    expect((await fs.readdir(tmpDir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  }, 20_000);

  test("suffixed collision id passes validation and reads the second entry", async () => {
    tmpDir = await mkTmpDir();
    const store = createJournalStore(tmpDir);
    const RealDate = Date;
    const fixedTime = new RealDate("2026-11-04T12:34:56.789Z").getTime();
    globalThis.Date = class extends RealDate {
      constructor(value?: string | number | Date) {
        if (arguments.length === 0) super(fixedTime);
        else super(value as string | number);
      }
    } as DateConstructor;

    try {
      await store.write({ title: "First collision", body: "First collision body" });
      const second = await store.write({ title: "Second collision", body: "Second collision body" });
      expect(second.id).toEndWith("-1");
      const read = await store.read(second.id);
      expect(read.title).toBe("Second collision");
      expect(read.body).toBe("Second collision body");
    } finally {
      globalThis.Date = RealDate;
    }
  });

  test("write generates chronological filenames", async () => {
    tmpDir = await mkTmpDir();
    const store = createJournalStore(tmpDir);

    const e1 = await store.write({ title: "First", body: "First entry" });
    // Small delay to ensure different timestamp
    await new Promise((r) => setTimeout(r, 5));
    const e2 = await store.write({ title: "Second", body: "Second entry" });

    expect(e2.id > e1.id).toBe(true);
  });

  test("write saves embedding file alongside entry", async () => {
    tmpDir = await mkTmpDir();
    const store = createJournalStore(tmpDir);

    const entry = await store.write({
      title: "Embedding test",
      body: "This should get an embedding.",
    });

    const embeddingFile = entry.filePath.replace(/\.md$/, ".embedding");
    const raw = await fs.readFile(embeddingFile, "utf-8");
    const embedding = JSON.parse(raw);
    // v0.4.0: versioned embedding object, not a bare array
    expect(embedding.v).toBe(2);
    expect(embedding.model).toBe("test-model");
    expect(embedding.dimension).toBe(8);
    expect(Array.isArray(embedding.vector)).toBe(true);
    expect(embedding.vector.length).toBeGreaterThan(0);
  });

  test("read returns full entry by id", async () => {
    tmpDir = await mkTmpDir();
    const store = createJournalStore(tmpDir);

    const written = await store.write({
      title: "Read test",
      body: "Read me back.",
      tags: ["test", "read"],
    });

    const read = await store.read(written.id);
    expect(read.title).toBe("Read test");
    expect(read.body).toBe("Read me back.");
    expect(read.tags).toEqual(["test", "read"]);
  });

  test("read throws for nonexistent id", async () => {
    tmpDir = await mkTmpDir();
    const store = createJournalStore(tmpDir);

    expect(store.read("99990101-000000-000")).rejects.toThrow(
      "Journal entry not found",
    );
  });

  test("read rejects path traversal", async () => {
    tmpDir = await mkTmpDir();
    const store = createJournalStore(tmpDir);

    expect(store.read("../../../etc/passwd")).rejects.toThrow(
      "Invalid journal entry ID",
    );
  });

  test("search with no filters returns recent entries", async () => {
    tmpDir = await mkTmpDir();
    const store = createJournalStore(tmpDir);

    await store.write({ title: "Entry 1", body: "First" });
    await new Promise((r) => setTimeout(r, 5));
    await store.write({ title: "Entry 2", body: "Second" });
    await new Promise((r) => setTimeout(r, 5));
    await store.write({ title: "Entry 3", body: "Third" });

    const result = await store.search({});
    expect(result.total).toBe(3);
    expect(result.entries.length).toBe(3);
    // Newest first (by recency score)
    expect(result.entries[0]!.title).toBe("Entry 3");
    expect(result.entries[2]!.title).toBe("Entry 1");
  });

  test("search filters by tags", async () => {
    tmpDir = await mkTmpDir();
    const store = createJournalStore(tmpDir);

    await store.write({
      title: "Tagged",
      body: "...",
      tags: ["rust", "perf"],
    });
    await new Promise((r) => setTimeout(r, 5));
    await store.write({
      title: "Other",
      body: "...",
      tags: ["python"],
    });

    const result = await store.search({ tags: ["rust"] });
    expect(result.total).toBe(1);
    expect(result.entries[0]!.title).toBe("Tagged");
  });

  test("search filters by project", async () => {
    tmpDir = await mkTmpDir();
    const store = createJournalStore(tmpDir);

    await store.write({ title: "Project A", body: "...", project: "/proj/a" });
    await new Promise((r) => setTimeout(r, 5));
    await store.write({ title: "Project B", body: "...", project: "/proj/b" });

    const result = await store.search({ project: "/proj/a" });
    expect(result.total).toBe(1);
    expect(result.entries[0]!.title).toBe("Project A");
  });

  test("search combines filters with AND logic", async () => {
    tmpDir = await mkTmpDir();
    const store = createJournalStore(tmpDir);

    await store.write({
      title: "Match",
      body: "...",
      tags: ["rust"],
      project: "/proj/a",
    });
    await new Promise((r) => setTimeout(r, 5));
    await store.write({
      title: "Wrong tags",
      body: "...",
      tags: ["python"],
      project: "/proj/a",
    });
    await new Promise((r) => setTimeout(r, 5));
    await store.write({
      title: "Wrong project",
      body: "...",
      tags: ["rust"],
      project: "/proj/b",
    });

    const result = await store.search({
      tags: ["rust"],
      project: "/proj/a",
    });
    expect(result.total).toBe(1);
    expect(result.entries[0]!.title).toBe("Match");
  });

  test("search respects limit", async () => {
    tmpDir = await mkTmpDir();
    const store = createJournalStore(tmpDir);

    for (let i = 0; i < 5; i++) {
      await store.write({ title: `Entry ${i}`, body: `Body ${i}` });
      await new Promise((r) => setTimeout(r, 5));
    }

    const result = await store.search({ limit: 2 });
    expect(result.entries.length).toBe(2);
    expect(result.total).toBe(5);
  });

  test("search supports offset pagination", async () => {
    tmpDir = await mkTmpDir();
    const store = createJournalStore(tmpDir);

    for (let i = 0; i < 5; i++) {
      await store.write({ title: `Entry ${i}`, body: `Body ${i}` });
      await new Promise((r) => setTimeout(r, 5));
    }

    const page1 = await store.search({ limit: 2, offset: 0 });
    expect(page1.entries.length).toBe(2);
    expect(page1.total).toBe(5);
    // Newest first
    expect(page1.entries[0]!.title).toBe("Entry 4");
    expect(page1.entries[1]!.title).toBe("Entry 3");

    const page2 = await store.search({ limit: 2, offset: 2 });
    expect(page2.entries.length).toBe(2);
    expect(page2.total).toBe(5);
    expect(page2.entries[0]!.title).toBe("Entry 2");
    expect(page2.entries[1]!.title).toBe("Entry 1");

    const page3 = await store.search({ limit: 2, offset: 4 });
    expect(page3.entries.length).toBe(1);
    expect(page3.entries[0]!.title).toBe("Entry 0");

    // Past the end
    const page4 = await store.search({ limit: 2, offset: 10 });
    expect(page4.entries.length).toBe(0);
    expect(page4.total).toBe(5);
  });

  test("search handles empty journal directory", async () => {
    tmpDir = await mkTmpDir();
    const store = createJournalStore(tmpDir);

    const result = await store.search({});
    expect(result.entries.length).toBe(0);
    expect(result.total).toBe(0);
    expect(result.allTags).toEqual([]);
  });

  test("search returns allTags from all entries regardless of filters", async () => {
    tmpDir = await mkTmpDir();
    const store = createJournalStore(tmpDir);

    await store.write({
      title: "Rust work",
      body: "...",
      tags: ["rust", "perf"],
    });
    await new Promise((r) => setTimeout(r, 5));
    await store.write({
      title: "Python work",
      body: "...",
      tags: ["python", "testing"],
    });

    // Filter to only rust tag — allTags should still include all tags
    const result = await store.search({ tags: ["rust"] });
    expect(result.total).toBe(1);
    expect(result.allTags).toEqual(["perf", "python", "rust", "testing"]);
  });

  test("search allTags deduplicates across entries", async () => {
    tmpDir = await mkTmpDir();
    const store = createJournalStore(tmpDir);

    await store.write({ title: "A", body: "...", tags: ["rust", "perf"] });
    await new Promise((r) => setTimeout(r, 5));
    await store.write({ title: "B", body: "...", tags: ["rust", "debugging"] });

    const result = await store.search({});
    expect(result.allTags).toEqual(["debugging", "perf", "rust"]);
  });

  test("search by text uses lexical OR matching", async () => {
    tmpDir = await mkTmpDir();
    const store = createJournalStore(tmpDir);

    await store.write({
      title: "Rust performance",
      body: "Optimized the hot loop using SIMD instructions.",
    });
    await new Promise((r) => setTimeout(r, 5));
    await store.write({
      title: "Python testing",
      body: "Set up pytest with coverage reporting.",
    });

    const result = await store.search({ text: "Rust absentterm" });
    expect(result.entries.map((entry) => entry.title)).toEqual(["Rust performance"]);
  });

  test("title query matches terms from the title", async () => {
    tmpDir = await mkTmpDir();
    const store = createJournalStore(tmpDir);
    const entry = await store.write({
      title: "Agent-memory release delivery channel",
      body: "Unrelated topics include coastal erosion, orbital mechanics, ceramic glazing, " +
        "database indexing, ancient trade routes, orchard irrigation, keyboard switches, " +
        "bird migration, public transit planning, and archival paper chemistry. These notes " +
        "continue across varied subjects in this deliberately long journal entry. " +
        "Further unrelated details cover weather instruments, typography, fermentation, " +
        "geology, woodworking, astronomy, logistics, and museum conservation. The entry is " +
        "deliberately verbose and does not repeat the title terms in its body, while " +
        "its title remains the searchable anchor for this regression case.",
    });

    const result = await store.search({ text: "Agent-memory release delivery channel" });
    expect(result.entries.some((candidate) => candidate.id === entry.id)).toBe(true);
  });

  test("lexical matching finds a rare exact token", async () => {
    tmpDir = await mkTmpDir();
    const store = createJournalStore(tmpDir);
    const entry = await store.write({ title: "Unrelated note", body: "The rarelexicaltoken appears here." });
    const query = "rarelexicaltoken";

    const result = await store.search({ text: query });
    expect(result.total).toBe(1);
    expect(result.entries.map((e) => e.id)).toEqual([entry.id]);
  });

  test("OR matching returns unique matches and stable pagination across identical calls", async () => {
    tmpDir = await mkTmpDir();
    const store = createJournalStore(tmpDir);
    for (let i = 0; i < 4; i++) {
      await store.write({ title: `Stable ${i}`, body: "sharedtoken searchable" });
      await new Promise((r) => setTimeout(r, 5));
    }

    const first = await store.search({ text: "sharedtoken", limit: 2 });
    const second = await store.search({ text: "sharedtoken", limit: 2 });
    expect(first.total).toBe(4);
    expect(second.total).toBe(4);
    expect(first.entries.map((e) => e.id)).toEqual(second.entries.map((e) => e.id));
    const next = await store.search({ text: "sharedtoken", limit: 2, offset: 2 });
    expect([...first.entries, ...next.entries].map((e) => e.id)).toHaveLength(4);
    expect(new Set([...first.entries, ...next.entries].map((e) => e.id)).size).toBe(4);
  });

  test("identical text searches reuse the lexical index snapshot", async () => {
    tmpDir = await mkTmpDir();
    const store = createJournalStore(tmpDir);
    await store.write({ title: "Cache token", body: "repeated searchable material" });
    const before = lexicalIndexConstructions;
    await store.search({ text: "cache" });
    expect(lexicalIndexConstructions).toBe(before + 1);
    await store.search({ text: "cache" });
    expect(lexicalIndexConstructions).toBe(before + 1);
  });

  test("adding an entry rebuilds the index and makes it searchable", async () => {
    tmpDir = await mkTmpDir();
    const store = createJournalStore(tmpDir);
    await store.write({ title: "Before", body: "ordinary content" });
    const before = lexicalIndexConstructions;
    await store.search({ text: "newlyaddedtoken" });
    await store.write({ title: "New entry", body: "newlyaddedtoken appears here" });
    const result = await store.search({ text: "newlyaddedtoken" });
    expect(lexicalIndexConstructions).toBe(before + 2);
    expect(result.entries.map((entry) => entry.title)).toEqual(["New entry"]);
  });

  test("editing entry bytes invalidates the index through the entry stat cache", async () => {
    tmpDir = await mkTmpDir();
    const store = createJournalStore(tmpDir);
    const entry = await store.write({ title: "Editable", body: "old unique phrase" });
    await store.search({ text: "old" });
    const before = lexicalIndexConstructions;
    const original = await fs.readFile(entry.filePath, "utf-8");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await fs.writeFile(entry.filePath, original.replace("old unique phrase", "replacementtoken with more bytes"));
    const oldResult = await store.search({ text: "old" });
    const newResult = await store.search({ text: "replacementtoken" });
    expect(lexicalIndexConstructions).toBe(before + 1);
    expect(oldResult.total).toBe(0);
    expect(newResult.entries.map((candidate) => candidate.id)).toEqual([entry.id]);
  });

  test("a metadata filter changing membership rebuilds the lexical index", async () => {
    tmpDir = await mkTmpDir();
    const store = createJournalStore(tmpDir);
    await store.write({ title: "Alpha", body: "sharedfiltertoken", project: "/proj/a" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.write({ title: "Beta", body: "sharedfiltertoken", project: "/proj/b" });
    const before = lexicalIndexConstructions;
    const a = await store.search({ text: "sharedfiltertoken", project: "/proj/a" });
    const b = await store.search({ text: "sharedfiltertoken", project: "/proj/b" });
    expect(lexicalIndexConstructions).toBe(before + 2);
    expect(a.entries.map((entry) => entry.title)).toEqual(["Alpha"]);
    expect(b.entries.map((entry) => entry.title)).toEqual(["Beta"]);
  });

  test("interleaved searches with different filters retain their own index", async () => {
    tmpDir = await mkTmpDir();
    const store = createJournalStore(tmpDir);
    const a = await store.write({ title: "Filtered A", body: "shared interleaved token", project: "/proj/a" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const b = await store.write({ title: "Filtered B", body: "shared interleaved token", project: "/proj/b" });
    const [resultA, resultB] = await Promise.all([
      store.search({ text: "interleaved", project: "/proj/a" }),
      store.search({ text: "interleaved", project: "/proj/b" }),
    ]);
    expect(resultA.entries.map((entry) => entry.id)).toEqual([a.id]);
    expect(resultB.entries.map((entry) => entry.id)).toEqual([b.id]);
    expect(resultA.total).toBe(1);
    expect(resultB.total).toBe(1);
  });

  test("OR rankings and totals match an uncached MiniSearch fixture", async () => {
    tmpDir = await mkTmpDir();
    const store = createJournalStore(tmpDir);
    const docs = [
      ["Alpha systems", "blue green systems reliability"],
      ["Green garden", "green plants bloom in spring"],
      ["Blue ocean", "blue water and marine life"],
      ["Reliable storage", "systems store durable records"],
      ["Spring systems", "green systems launch in spring"],
      ["Marine records", "ocean blue records and data"],
      ["Durable garden", "plants grow with reliable soil"],
      ["Data storage", "durable systems for data"],
      ["Blooming ocean", "spring marine bloom"],
      ["Record reliability", "reliable records stay durable"],
    ];
    const entries = [] as Awaited<ReturnType<typeof store.write>>[];
    for (const [title, body] of docs) {
      entries.push(await store.write({ title: title!, body: body! }));
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const queries = ["green systems", "blue records", "durable reliable", "spring ocean", "plants data"];
    for (const text of queries) {
      const uncached = new NativeMiniSearch({ fields: ["title", "body"], storeFields: ["id"] });
      uncached.addAll(entries.map((entry) => ({ id: entry.id, title: entry.title, body: entry.body })));
      const expected = uncached.search(text, { combineWith: "OR" })
        .map((match) => ({ entry: entries.find((entry) => entry.id === String(match.id))!, score: match.score }))
        .sort((a, b) => b.score - a.score || b.entry.created.getTime() - a.entry.created.getTime() || (a.entry.id < b.entry.id ? 1 : a.entry.id > b.entry.id ? -1 : 0));
      const actual = await store.search({ text });
      expect({ ids: actual.entries.map((entry) => entry.id), total: actual.total }).toEqual({
        ids: expected.map(({ entry }) => entry.id),
        total: expected.length,
      });
    }
  });

  test("punctuation-only query falls back to case-insensitive title/body substring matches", async () => {
    tmpDir = await mkTmpDir();
    const store = createJournalStore(tmpDir);
    const titleMatch = await store.write({ title: "!!!", body: "older" });
    await new Promise((r) => setTimeout(r, 5));
    const bodyMatch = await store.write({ title: "Other", body: "A marker !!! appears here." });
    await new Promise((r) => setTimeout(r, 5));
    await store.write({ title: "No match", body: "ordinary text" });
    const result = await store.search({ text: "!!!" });
    expect(result.total).toBe(2);
    expect(result.entries.map((entry) => entry.id)).toEqual([bodyMatch.id, titleMatch.id]);
  });

  test("text search does not generate embeddings", async () => {
    tmpDir = await mkTmpDir();
    const store = createJournalStore(tmpDir);
    const entry = await store.write({ title: "Keyword note", body: "the lexicalneedle is here" });
    const callsBeforeSearch = embeddingGenerationCalls;

    const result = await store.search({ text: "lexicalneedle" });
    expect(result.entries.map((candidate) => candidate.id)).toEqual([entry.id]);
    expect(embeddingGenerationCalls - callsBeforeSearch).toBe(0);
  });

  test("text search matches query terms with OR and orders score, creation time, then id descending", async () => {
    tmpDir = await mkTmpDir();
    const store = createJournalStore(tmpDir);
    const low = await store.write({ title: "Tie", body: "alpha" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const highId = await store.write({ title: "Tie", body: "alpha" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const newest = await store.write({ title: "Tie", body: "beta alpha" });
    const tiedCreated = "2026-01-01T00:00:00.000Z";
    for (const entry of [low, highId]) {
      const original = await fs.readFile(entry.filePath, "utf-8");
      await fs.writeFile(entry.filePath, original.replace(/^created: .+$/m, `created: '${tiedCreated}'`));
    }

    const result = await store.search({ text: "alpha beta" });
    expect(result.entries.map((entry) => entry.id)).toEqual([newest.id, highId.id, low.id]);
    expect(result.total).toBe(3);
  });

  test("search without text remains chronological and does not generate embeddings", async () => {
    tmpDir = await mkTmpDir();
    const store = createJournalStore(tmpDir);
    await store.write({ title: "Older", body: "first" });
    await new Promise((r) => setTimeout(r, 5));
    await store.write({ title: "Newer", body: "second" });
    const callsBeforeSearch = embeddingGenerationCalls;
    const indexesBeforeSearch = lexicalIndexConstructions;

    const result = await store.search({});
    expect(result.entries.map((entry) => entry.title)).toEqual(["Newer", "Older"]);
    expect(embeddingGenerationCalls).toBe(callsBeforeSearch);
    expect(lexicalIndexConstructions).toBe(indexesBeforeSearch);
  });
});
