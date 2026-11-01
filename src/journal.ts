import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import * as yaml from "js-yaml";
import MiniSearch from "minisearch";
import { z } from "zod";

import { cosineSimilarity, EMBEDDING_DIMENSION, embeddingModelName, generateEmbedding } from "./embeddings";
import { atomicWriteFile, buildFrontmatterDocument, splitFrontmatter } from "./frontmatter";

// Initial hypothesis, not a calibrated semantic relevance boundary.
const SEMANTIC_ADMISSION_FLOOR = 0.45;
const RRF_K = 60;

const TagSchema = z.looseObject({
  name: z.string().min(1),
  description: z.string().min(1),
});

const ConfigSchema = z.looseObject({
  cacheDir: z.string().optional(),
  journal: z
    .object({
      enabled: z.boolean().optional(),
      tags: z.array(TagSchema).optional(),
    }).strict()
    .optional(),
});

export type AgentMemoryConfig = z.infer<typeof ConfigSchema>;

export type ConfigLoadStatus =
  | "ok"
  | "missing"
  | "unreadable"
  | "malformed"
  | "invalid";

export type LoadedConfig = {
  config: AgentMemoryConfig;
  status: ConfigLoadStatus;
  configPath: string;
  reason?: string;
};

export async function loadConfig(
  configDir?: string,
): Promise<LoadedConfig> {
  const dir = configDir ?? path.join(os.homedir(), ".config", "opencode");
  const configPath = path.resolve(dir, "agent-memory.json");

  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf-8");
  } catch (error) {
    const code = error instanceof Error && "code" in error
      ? String(error.code)
      : "unknown error";
    if (code === "ENOENT") {
      return {
        config: {},
        status: "missing",
        configPath,
        reason: "file is missing",
      };
    }
    return {
      config: {},
      status: "unreadable",
      configPath,
      reason: `read failed (${code})`,
    };
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {
      config: {},
      status: "malformed",
      configPath,
      reason: "malformed JSON",
    };
  }

  const parsed = ConfigSchema.safeParse(value);
  if (!parsed.success) {
    return {
      config: {},
      status: "invalid",
      configPath,
      reason: "schema validation failed",
    };
  }

  return { config: parsed.data, status: "ok", configPath };
}

export type JournalTag = {
  name: string;
  description: string;
};

export const EntryFrontmatterSchema = z.looseObject({
  title: z.string().min(1),
  project: z.string().optional(),
  model: z.string().optional(),
  provider: z.string().optional(),
  agent: z.string().optional(),
  session_id: z.string().optional(),
  created: z.string().optional(),
  tags: z.array(z.string().min(1)).optional(),
});

export type JournalEntry = {
  id: string;
  title: string;
  project: string;
  model: string;
  provider: string;
  agent: string;
  sessionId: string;
  created: Date;
  tags: string[];
  body: string;
  filePath: string;
};

function entryFilename(date: Date): string {
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  return [
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`,
    "-",
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`,
    "-",
    `${pad(date.getUTCMilliseconds(), 3)}`,
    ".md",
  ].join("");
}

function embeddingPath(entryPath: string): string {
  return entryPath.replace(/\.md$/, ".embedding");
}

function titleMatches(queryText: string, title: string): boolean {
  const q = queryText.trim().toLowerCase();
  if (!q) return false;
  const t = title.trim().toLowerCase();
  return t.includes(q) || q.includes(t);
}

async function readEntryFile(filePath: string): Promise<JournalEntry> {
  const raw = await fs.readFile(filePath, "utf-8");
  const { frontmatterText, body } = splitFrontmatter(raw);

  if (!frontmatterText) {
    throw new Error(`Journal entry missing frontmatter: ${filePath}`);
  }

  const loaded = yaml.load(frontmatterText);
  const parsed = EntryFrontmatterSchema.safeParse(loaded);
  if (!parsed.success) {
    throw new Error(`Invalid journal frontmatter in ${filePath}: ${parsed.error.message}`);
  }

  const fm = parsed.data;
  const id = path.basename(filePath, ".md");

  return {
    id,
    title: fm.title,
    project: fm.project ?? "",
    model: fm.model ?? "",
    provider: fm.provider ?? "",
    agent: fm.agent ?? "",
    sessionId: fm.session_id ?? "",
    created: fm.created ? new Date(fm.created) : new Date(),
    tags: fm.tags ?? [],
    body: body.trim(),
    filePath,
  };
}

type ParsedEmbedding =
  | { vector: number[]; model: string; dimension: number }
  | undefined;

type CachedEntry = {
  entryMtimeMs: number;
  entrySize: number;
  embMtimeMs: number;
  embSize: number;
  entry: JournalEntry;
  embedding: ParsedEmbedding;
};

async function loadEmbedding(entryPath: string): Promise<ParsedEmbedding> {
  const ePath = embeddingPath(entryPath);
  try {
    const raw = await fs.readFile(ePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      // Legacy v1 (bare array from all-MiniLM-L6-v2)
      return {
        vector: parsed as number[],
        model: "unknown-legacy",
        dimension: parsed.length,
      };
    }
    if (parsed && typeof parsed === "object" && parsed.v === 2) {
      const vector = Array.isArray(parsed.vector)
        ? parsed.vector
        : undefined;
      if (
        vector &&
        vector.length === (parsed.dimension as number) &&
        vector.length > 0
      ) {
        return {
          vector,
          model: parsed.model as string,
          dimension: parsed.dimension as number,
        };
      }
      return undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

const SAFE_ID = /^[a-zA-Z0-9_-]+$/;

function validateId(id: string): string {
  const trimmed = id.trim();
  if (!SAFE_ID.test(trimmed)) {
    throw new Error(`Invalid journal entry ID: "${id}"`);
  }
  return trimmed;
}

export type JournalStore = {
  write(entry: {
    title: string;
    body: string;
    project?: string;
    model?: string;
    provider?: string;
    agent?: string;
    sessionId?: string;
    tags?: string[];
  }): Promise<JournalEntry>;

  read(id: string): Promise<JournalEntry>;

  search(query: {
    text?: string;
    project?: string;
    tags?: string[];
    limit?: number;
    offset?: number;
  }): Promise<{ entries: JournalEntry[]; total: number; allTags: string[] }>;
};

export function createJournalStore(configDir?: string, cacheDir?: string): JournalStore {
  const journalDir = path.join(
    configDir ?? path.join(os.homedir(), ".config", "opencode"),
    "journal",
  );

  // Per-store cache: each store instance owns its entries, so stores with
  // different (including nested or ephemeral) journal directories never
  // interfere and no foreign keys can accumulate.
  const entryCache = new Map<string, CachedEntry>();

  return {
    async write(entry) {
      await fs.mkdir(journalDir, { recursive: true });

      const created = new Date();
      const filename = entryFilename(created);
      const filePath = path.join(journalDir, filename);

      const frontmatter: Record<string, unknown> = {
        title: entry.title,
        created: created.toISOString(),
      };

      if (entry.project) frontmatter.project = entry.project;
      if (entry.model) frontmatter.model = entry.model;
      if (entry.provider) frontmatter.provider = entry.provider;
      if (entry.agent) frontmatter.agent = entry.agent;
      if (entry.sessionId) frontmatter.session_id = entry.sessionId;
      if (entry.tags && entry.tags.length > 0) frontmatter.tags = entry.tags;

      const content = buildFrontmatterDocument(frontmatter, entry.body);
      await atomicWriteFile(filePath, content);

      // Generate and save embedding for semantic search
      const searchableText = `${entry.title}\n${entry.body}`;
      try {
        const embedding = await generateEmbedding(searchableText, cacheDir);
        await fs.writeFile(
          embeddingPath(filePath),
          JSON.stringify({
            v: 2, // schema version for the embedding file
            model: embeddingModelName(), // the embedding model that produced it
            dimension: EMBEDDING_DIMENSION,
            vector: embedding, // the actual float array
          }),
          "utf-8",
        );
      } catch {
        // Embedding generation can fail (e.g. model download issue).
        // The entry is still saved; text search remains available.
      }

      return {
        id: path.basename(filePath, ".md"),
        title: entry.title,
        project: entry.project ?? "",
        model: entry.model ?? "",
        provider: entry.provider ?? "",
        agent: entry.agent ?? "",
        sessionId: entry.sessionId ?? "",
        created,
        tags: entry.tags ?? [],
        body: entry.body,
        filePath,
      };
    },

    async read(id) {
      const safeId = validateId(id);
      const filePath = path.join(journalDir, `${safeId}.md`);

      try {
        await fs.access(filePath);
      } catch {
        throw new Error(`Journal entry not found: ${safeId}`);
      }

      return readEntryFile(filePath);
    },

    async search(query) {
      const limit = Math.min(Math.max(query.limit ?? 20, 1), 50);
      const offset = Math.max(query.offset ?? 0, 0);

      // Read all entry files
      let files: string[];
      try {
        const dirEntries = await fs.readdir(journalDir, {
          withFileTypes: true,
        });
        files = dirEntries
          .filter((e) => e.isFile() && e.name.endsWith(".md"))
          .map((e) => e.name)
          .sort()
          .reverse(); // Newest first
      } catch {
        return { entries: [], total: 0, allTags: [] };
      }

      // Prune cache entries for files that no longer exist
      const alive = new Set(files.map((f) => path.join(journalDir, f)));
      for (const key of entryCache.keys()) {
        if (!alive.has(key)) entryCache.delete(key);
      }

      // Textless searches intentionally avoid both embedding generation and
      // construction of an ephemeral lexical index.
      let queryEmbedding: number[] | undefined;
      if (query.text) {
        try {
          queryEmbedding = await generateEmbedding(query.text, cacheDir);
        } catch {
          // Fall back to text search if embedding fails
        }
      }

      // Collect all tags across every entry (before filtering)
      const tagSet = new Set<string>();

      const indexed = await Promise.all(files.map(async (file) => {
        const filePath = path.join(journalDir, file);
        try {
          const ePath = embeddingPath(filePath);
          const [entryStat, embStat] = await Promise.all([
            fs.stat(filePath),
            fs.stat(ePath).catch(() => ({ mtimeMs: -1, size: -1 } as const)),
          ]);
          const cached = entryCache.get(filePath);
          if (
            cached &&
            cached.entryMtimeMs === entryStat.mtimeMs &&
            cached.entrySize === entryStat.size &&
            cached.embMtimeMs === embStat.mtimeMs &&
            cached.embSize === embStat.size
          ) {
            return cached;
          }
          const [entry, embedding] = await Promise.all([
            readEntryFile(filePath),
            loadEmbedding(filePath),
          ]);
          const value: CachedEntry = {
            entryMtimeMs: entryStat.mtimeMs,
            entrySize: entryStat.size,
            embMtimeMs: embStat.mtimeMs,
            embSize: embStat.size,
            entry,
            embedding,
          };
          entryCache.set(filePath, value);
          return value;
        } catch {
          return undefined;
        }
      }));

      const filtered: CachedEntry[] = [];
      for (const cached of indexed) {
        if (!cached) continue;
        const { entry } = cached;

        // Collect tags before applying filters
        for (const tag of entry.tags) {
          tagSet.add(tag);
        }

        // Apply metadata filters (AND logic)
        if (query.project && entry.project !== query.project) {
          continue;
        }
        if (query.tags && query.tags.length > 0) {
          const entryTagNames = entry.tags.map((t) => t.toLowerCase());
          const allTagsMatch = query.tags.every((t) =>
            entryTagNames.includes(t.toLowerCase()),
          );
          if (!allTagsMatch) continue;
        }

        filtered.push(cached);
      }

      let ranked: { entry: JournalEntry; score: number }[];
      if (!query.text) {
        ranked = filtered.map(({ entry }) => ({
          entry,
          score: entry.created.getTime(),
        }));
        ranked.sort((a, b) =>
          b.score - a.score || b.entry.id.localeCompare(a.entry.id),
        );
      } else {
        const semantic: { entry: JournalEntry; cosine: number }[] = [];
        const fallbackIds = new Set<string>();
        for (const cached of filtered) {
          const { entry, embedding } = cached;
          const haystack = `${entry.title}\n${entry.body}`.toLowerCase();
          const exactSubstringMatch = haystack.includes(query.text.toLowerCase());
          const titleMatch = titleMatches(query.text, entry.title);
          const usableEmbedding = embedding?.dimension === EMBEDDING_DIMENSION &&
            embedding.vector.length === EMBEDDING_DIMENSION &&
            embedding.vector.every(Number.isFinite);

          if (queryEmbedding && usableEmbedding) {
            const cosine = cosineSimilarity(queryEmbedding, embedding.vector);
            if (cosine >= SEMANTIC_ADMISSION_FLOOR) semantic.push({ entry, cosine });
          } else if (exactSubstringMatch || titleMatch) {
            // Preserve legacy fallback membership without treating its
            // synthetic score as a cosine similarity.
            fallbackIds.add(entry.id);
          }

          // Title and exact-substring admission are independent of the cosine
          // floor, including when a valid sidecar exists.
          if (titleMatch || ((!usableEmbedding || !queryEmbedding) && exactSubstringMatch)) {
            fallbackIds.add(entry.id);
          }
        }

        semantic.sort((a, b) =>
          b.cosine - a.cosine ||
          b.entry.created.getTime() - a.entry.created.getTime() ||
          b.entry.id.localeCompare(a.entry.id),
        );

        const lexicalIndex = new MiniSearch({
          fields: ["title", "body"],
          storeFields: ["id"],
        });
        lexicalIndex.addAll(filtered.map(({ entry }) => ({
          id: entry.id,
          title: entry.title,
          body: entry.body,
        })));
        const lexical = lexicalIndex.search(query.text, { combineWith: "AND" });

        const fused = new Map<string, number>();
        semantic.forEach(({ entry }, index) => {
          fused.set(entry.id, (fused.get(entry.id) ?? 0) + 1 / (RRF_K + index + 1));
        });
        lexical.forEach((match, index) => {
          const id = String(match.id);
          fused.set(id, (fused.get(id) ?? 0) + 1 / (RRF_K + index + 1));
        });

        const byId = new Map(filtered.map(({ entry }) => [entry.id, entry]));
        const admittedIds = new Set([...fused.keys(), ...fallbackIds]);
        ranked = [];
        for (const id of admittedIds) {
          const entry = byId.get(id);
          if (!entry) continue;
          ranked.push({ entry, score: fused.get(id) ?? 0 });
        }
        ranked.sort((a, b) =>
          b.score - a.score ||
          b.entry.created.getTime() - a.entry.created.getTime() ||
          b.entry.id.localeCompare(a.entry.id),
        );
      }

      // Count unique metadata- and relevance-admitted entries before paging.
      const total = ranked.length;

      // Apply offset + limit
      ranked = ranked.slice(offset, offset + limit);

      return {
        entries: ranked.map((e) => e.entry),
        total,
        allTags: Array.from(tagSet).sort(),
      };
    },
  };
}
