import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as realEmbeddings from "./embeddings";
import NativeMiniSearch from "minisearch";

let failEmbeddingGeneration = false;
let embeddingGenerationCalls = 0;
let embeddingOverride: number[] | undefined;
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
  generateEmbedding: async (text: string) => {
    embeddingGenerationCalls++;
    if (failEmbeddingGeneration) throw new Error("injected embedding failure");
    if (embeddingOverride) return [...embeddingOverride];
    // Deterministic fake embedding based on text content
    const hash = Array.from(text).reduce(
      (acc, c) => ((acc << 5) - acc + c.charCodeAt(0)) | 0,
      0,
    );
    return Array.from({ length: 8 }, (_, i) => Math.sin(hash + i));
  },
  EMBEDDING_DIMENSION: 8,
  embeddingModelName: () => "test-model",
  cosineSimilarity: (a: number[], b: number[]) => {
    if (a.length !== b.length)
      throw new Error(
        `Embedding dimension mismatch: ${a.length} vs ${b.length}`,
      );
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      const ai = a[i]!;
      const bi = b[i]!;
      dot += ai * bi;
      normA += ai * ai;
      normB += bi * bi;
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  },
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
    failEmbeddingGeneration = false;
    embeddingGenerationCalls = 0;
    embeddingOverride = undefined;
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

  test("search by text uses semantic matching", async () => {
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

    // With mock embeddings, text search falls through to semantic matching
    const result = await store.search({ text: "Rust performance" });
    // Should find at least the matching entry
    expect(result.total).toBeGreaterThan(0);
  });

  test("title query surfaces long-body entry despite diluted embedding", async () => {
    tmpDir = await mkTmpDir();
    const store = createJournalStore(tmpDir);
    const entry = await store.write({
      title: "Agent-memory release delivery channel",
      body: "Unrelated topics include coastal erosion, orbital mechanics, ceramic glazing, " +
        "database indexing, ancient trade routes, orchard irrigation, keyboard switches, " +
        "bird migration, public transit planning, and archival paper chemistry. These notes " +
        "continue across varied subjects so the long body dilutes its mean-pooled embedding. " +
        "Further unrelated details cover weather instruments, typography, fermentation, " +
        "geology, woodworking, astronomy, logistics, and museum conservation. The entry is " +
        "deliberately verbose and semantically unrelated to a fresh exact-title query, while " +
        "its title remains the searchable anchor for this regression case.",
    });

    // The deterministic mock embeddings produce an unrelated query vector here;
    // Independent title-match admission guarantees presence regardless of cosine score.
    const result = await store.search({ text: "Agent-memory release delivery channel" });
    expect(result.entries.some((candidate) => candidate.id === entry.id)).toBe(true);
  });

  test("search skips stale-dimension embedding and falls back to text match", async () => {
    tmpDir = await mkTmpDir();
    const store = createJournalStore(tmpDir);

    const entry = await store.write({
      title: "Stale dims entry",
      body: "unique-stale-dim-content",
    });

    // First search: caches the entry with the correct mock embedding.
    await store.search({ text: "unique-stale-dim-content" });

    // Simulate a v2 embedding with a WRONG dimension (e.g. from a 768d model).
    // Search must not throw: it should skip the embedding and fall back to
    // text matching for this entry.
    const embeddingFile = entry.filePath.replace(/\.md$/, ".embedding");
    await fs.writeFile(
      embeddingFile,
      JSON.stringify({
        v: 2,
        model: "some-768d-model",
        dimension: 768,
        vector: Array.from({ length: 768 }, () => 0.1),
      }),
      "utf-8",
    );

    // Query whose embedding would collide with the stale one if cosine were
    // attempted (dimension mismatch would throw inside cosineSimilarity).
    const result = await store.search({ text: "unique-stale-dim-content" });
    const titles = result.entries.map((e) => e.title);
    expect(titles).toContain("Stale dims entry");
    // No throw above is the assertion: mismatched dimension degrades to text.
  });

  test("sidecar rewrite after cache warm is picked up by second search", async () => {
    tmpDir = await mkTmpDir();
    const store = createJournalStore(tmpDir);

    const entry = await store.write({
      title: "Sidecar invalidation",
      body: "unique-sidecar-invalidation-content",
    });

    // First search: caches the entry + correct sidecar fingerprint.
    const r1 = await store.search({ text: "unique-sidecar-invalidation-content" });
    expect(r1.entries.some((e) => e.title === "Sidecar invalidation")).toBe(true);

    // Rewrite the sidecar with a wrong-dimension embedding (simulating
    // sidecar regeneration without touching the .md).
    const embeddingFile = entry.filePath.replace(/\.md$/, ".embedding");
    await fs.writeFile(
      embeddingFile,
      JSON.stringify({
        v: 2,
        model: "some-768d-model",
        dimension: 768,
        vector: Array.from({ length: 768 }, () => 0.1),
      }),
      "utf-8",
    );

    // Second search must invalidate the cache (sidecar mtime changed) and
    // pick up the stale-dimension embedding, falling back to text match.
    const r2 = await store.search({ text: "unique-sidecar-invalidation-content" });
    expect(r2.entries.some((e) => e.title === "Sidecar invalidation")).toBe(true);
  });

  test("sidecar deleted between searches falls back to text match", async () => {
    tmpDir = await mkTmpDir();
    const store = createJournalStore(tmpDir);

    const entry = await store.write({
      title: "Sidecar deleted entry",
      body: "unique-sidecar-deleted-content",
    });

    // Warm the cache chronologically (loads and caches the sidecar
    // fingerprint) without depending on a synthetic semantic score.
    const r1 = await store.search({});
    expect(r1.entries.some((e) => e.title === "Sidecar deleted entry")).toBe(true);

    // Delete the sidecar file.
    const embeddingFile = entry.filePath.replace(/\.md$/, ".embedding");
    await fs.unlink(embeddingFile);

    // Second search: cache miss (sidecar gone), falls back to exact text
    // matching rather than using the stale cached embedding.
    const r2 = await store.search({ text: "unique-sidecar-deleted-content" });
    const found = r2.entries.find((e) => e.title === "Sidecar deleted entry");
    expect(found).toBeDefined();
    // Admission comes from the exact-substring fallback, not cosine.
  });

  test("search skips corrupt v2 embedding (empty vector) without throwing", async () => {
    tmpDir = await mkTmpDir();
    const store = createJournalStore(tmpDir);

    const entry = await store.write({
      title: "Corrupt embedding entry",
      body: "unique-corrupt-embedding-content",
    });

    // Simulate a corrupt-but-well-formed v2 embedding: dimension claims 384
    // but the vector is empty. Search must NOT throw — it should skip the
    // embedding and fall back to text matching for this entry.
    const embeddingFile = entry.filePath.replace(/\.md$/, ".embedding");
    await fs.writeFile(
      embeddingFile,
      JSON.stringify({ v: 2, model: "some-model", dimension: 8, vector: [] }),
      "utf-8",
    );

    const result = await store.search({ text: "unique-corrupt-embedding-content" });
    const titles = result.entries.map((e) => e.title);
    expect(titles).toContain("Corrupt embedding entry");
    // No throw above is the assertion: corrupt v2 embedding degrades to text.
  });

  test("search skips corrupt v2 embedding (missing vector) without throwing", async () => {
    tmpDir = await mkTmpDir();
    const store = createJournalStore(tmpDir);

    const entry = await store.write({
      title: "Missing vector entry",
      body: "unique-missing-vector-content",
    });

    // v2 file that omits the vector field entirely. Search must not throw.
    const embeddingFile = entry.filePath.replace(/\.md$/, ".embedding");
    await fs.writeFile(
      embeddingFile,
      JSON.stringify({ v: 2, model: "some-model", dimension: 8 }),
      "utf-8",
    );

    const result = await store.search({ text: "unique-missing-vector-content" });
    const titles = result.entries.map((e) => e.title);
    expect(titles).toContain("Missing vector entry");
  });

  test("legacy bare-array embedding is still usable for semantic search", async () => {
    tmpDir = await mkTmpDir();
    const store = createJournalStore(tmpDir);

    const entry = await store.write({
      title: "Legacy embedding",
      body: "legacy-vector-body",
    });

    // Overwrite with a legacy v1 bare-array embedding (from all-MiniLM-L6-v2,
    // which also produces 8-dim vectors under the test mock). Use the same
    // mock formula as generateEmbedding so the cosine is positive and the
    // entry is actually matched via semantic search.
    const hash = Array.from("legacy-vector-body").reduce(
      (acc, c) => ((acc << 5) - acc + c.charCodeAt(0)) | 0,
      0,
    );
    const legacyVector = Array.from(
      { length: 8 },
      (_, i) => Math.sin(hash + i),
    );
    const embeddingFile = entry.filePath.replace(/\.md$/, ".embedding");
    await fs.writeFile(
      embeddingFile,
      JSON.stringify(legacyVector),
      "utf-8",
    );

    // Legacy array must be treated as { vector, model: "unknown-legacy",
    // dimension: length }; with a matching dimension it stays usable.
    const result = await store.search({ text: "legacy-vector-body" });
    const titles = result.entries.map((e) => e.title);
    expect(titles).toContain("Legacy embedding");
  });

  test("rejects semantic matches below the initial cosine admission floor", async () => {
    tmpDir = await mkTmpDir();
    const store = createJournalStore(tmpDir);
    const entry = await store.write({ title: "Unrelated note", body: "nothing relevant" });
    const query = "floor rejection phrase";
    const hash = Array.from(query).reduce((acc, c) => ((acc << 5) - acc + c.charCodeAt(0)) | 0, 0);
    const vector = Array.from({ length: 8 }, (_, i) => Math.sin(hash + i));
    await fs.writeFile(entry.filePath.replace(/\.md$/, ".embedding"), JSON.stringify({ v: 2, model: "test-model", dimension: 8, vector: vector.map((v) => -v) }));

    const result = await store.search({ text: query });
    expect(result.total).toBe(0);
    expect(result.entries).toEqual([]);
  });

  test("pins interior semantic cosines on both sides of the admission boundary", async () => {
    tmpDir = await mkTmpDir();
    const store = createJournalStore(tmpDir);
    const low = await store.write({ title: "Low unrelated", body: "no query tokens here" });
    const high = await store.write({ title: "High unrelated", body: "still no query tokens" });
    const query = "interior cosine query";
    embeddingOverride = [1, 0, 0, 0, 0, 0, 0, 0];
    const vectorFor = (cosine: number) => [cosine, Math.sqrt(1 - cosine * cosine), 0, 0, 0, 0, 0, 0];
    await fs.writeFile(low.filePath.replace(/\.md$/, ".embedding"), JSON.stringify({ v: 2, model: "test-model", dimension: 8, vector: vectorFor(0.30) }));
    await fs.writeFile(high.filePath.replace(/\.md$/, ".embedding"), JSON.stringify({ v: 2, model: "test-model", dimension: 8, vector: vectorFor(0.60) }));

    const result = await store.search({ text: query });
    expect(result.total).toBe(1);
    expect(result.entries.map((entry) => entry.id)).toEqual([high.id]);
  });

  test("lexical matching rescues a rare exact token despite a weak embedding", async () => {
    tmpDir = await mkTmpDir();
    const store = createJournalStore(tmpDir);
    const entry = await store.write({ title: "Unrelated note", body: "The rarelexicaltoken appears here." });
    const query = "rarelexicaltoken";
    const hash = Array.from(query).reduce((acc, c) => ((acc << 5) - acc + c.charCodeAt(0)) | 0, 0);
    const vector = Array.from({ length: 8 }, (_, i) => Math.sin(hash + i));
    await fs.writeFile(entry.filePath.replace(/\.md$/, ".embedding"), JSON.stringify({ v: 2, model: "test-model", dimension: 8, vector: vector.map((v) => -v) }));

    const result = await store.search({ text: query });
    expect(result.total).toBe(1);
    expect(result.entries.map((e) => e.id)).toEqual([entry.id]);
  });

  test("embedding failure keeps exact-substring and title fallback admission", async () => {
    tmpDir = await mkTmpDir();
    const store = createJournalStore(tmpDir);
    const entry = await store.write({ title: "Fallback anchor", body: "A unique fallback phrase is preserved." });
    failEmbeddingGeneration = true;

    const result = await store.search({ text: "unique fallback phrase" });
    expect(result.total).toBe(1);
    expect(result.entries[0]!.id).toBe(entry.id);
  });

  test("embedding failure admits a title match when lexical matching cannot", async () => {
    tmpDir = await mkTmpDir();
    const store = createJournalStore(tmpDir);
    const entry = await store.write({ title: "Anchor", body: "Body contains unrelated words only." });
    await fs.unlink(entry.filePath.replace(/\.md$/, ".embedding"));
    failEmbeddingGeneration = true;

    const result = await store.search({ text: "Anchor phrase" });
    expect(result.total).toBe(1);
    expect(result.entries.map((candidate) => candidate.id)).toEqual([entry.id]);
  });

  test("RRF sums a dual-channel rank-2 hit above a semantic-only rank-1 hit", async () => {
    tmpDir = await mkTmpDir();
    const store = createJournalStore(tmpDir);
    const dual = await store.write({ title: "Dual document", body: "contains rarefusiontoken" });
    await new Promise((r) => setTimeout(r, 5));
    const semanticOnly = await store.write({ title: "Semantic document", body: "no lexical match here" });
    embeddingOverride = [1, 0, 0, 0, 0, 0, 0, 0];
    const vector = (cosine: number) => [cosine, Math.sqrt(1 - cosine * cosine), 0, 0, 0, 0, 0, 0];
    await fs.writeFile(dual.filePath.replace(/\.md$/, ".embedding"), JSON.stringify({ v: 2, model: "test-model", dimension: 8, vector: vector(0.8) }));
    await fs.writeFile(semanticOnly.filePath.replace(/\.md$/, ".embedding"), JSON.stringify({ v: 2, model: "test-model", dimension: 8, vector: vector(1) }));

    const indexesBeforeSearch = lexicalIndexConstructions;
    const result = await store.search({ text: "rarefusiontoken" });
    expect(result.entries.map((entry) => entry.id)).toEqual([dual.id, semanticOnly.id]);
    expect(lexicalIndexConstructions).toBe(indexesBeforeSearch + 1);
  });

  test("fusion returns unique matches and stable pagination across identical calls", async () => {
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

  test("fallback-only score ties order by created descending, then id descending", async () => {
    tmpDir = await mkTmpDir();
    const store = createJournalStore(tmpDir);
    const older = await store.write({ title: "!!!", body: "older" });
    await new Promise((r) => setTimeout(r, 5));
    const newer = await store.write({ title: "!!!", body: "newer" });
    const olderRaw = await fs.readFile(older.filePath, "utf-8");
    const newerRaw = await fs.readFile(newer.filePath, "utf-8");
    const olderCreated = olderRaw.match(/^created: (.+)$/m)![1]!;
    await fs.writeFile(newer.filePath, newerRaw.replace(/^created: .+$/m, `created: ${olderCreated}`));

    const result = await store.search({ text: "!!!" });
    const tiedCreated = new Date(olderCreated.replace(/^'|'$/g, "")).toISOString();
    expect(result.entries.map((e) => e.created.toISOString())).toEqual([tiedCreated, tiedCreated]);
    expect(result.entries.map((e) => e.id)).toEqual([newer.id, older.id]);
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
