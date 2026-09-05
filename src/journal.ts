import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import * as yaml from "js-yaml";
import { z } from "zod";

import { cosineSimilarity, EMBEDDING_DIMENSION, embeddingModelName, generateEmbedding } from "./embeddings";
import { atomicWriteFile, buildFrontmatterDocument, splitFrontmatter } from "./frontmatter";

const TagSchema = z.looseObject({
  name: z.string().min(1),
  description: z.string().min(1),
});

const ConfigSchema = z.looseObject({
  cacheDir: z.string().optional(),
  journal: z
    .looseObject({
      enabled: z.boolean().optional(),
      tags: z.array(TagSchema).optional(),
    })
    .optional(),
});

export type AgentMemoryConfig = z.infer<typeof ConfigSchema>;

export async function loadConfig(
  configDir?: string,
): Promise<AgentMemoryConfig> {
  const dir = configDir ?? path.join(os.homedir(), ".config", "opencode");
  const configPath = path.join(dir, "agent-memory.json");
  try {
    const raw = await fs.readFile(configPath, "utf-8");
    const parsed = ConfigSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return {};
    return parsed.data;
  } catch {
    return {};
  }
}

export type JournalTag = {
  name: string;
  description: string;
};

const EntryFrontmatterSchema = z.looseObject({
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

      let entries: { entry: JournalEntry; score: number }[] = [];

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

      // If a text query is provided, try semantic search first
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

        // Score the entry
        let score = 0;

        if (query.text) {
          if (queryEmbedding) {
            // Semantic search
            const storedEmbedding = cached.embedding;
            if (storedEmbedding) {
              // Hard gate: dimension must match, or the embedding is stale
              // (different model) and cannot be compared with cosine.
              // A mismatched/stale embedding degrades gracefully to text match.
              if (storedEmbedding.dimension !== EMBEDDING_DIMENSION) {
                const haystack =
                  `${entry.title}\n${entry.body}`.toLowerCase();
                score = haystack.includes(query.text.toLowerCase()) ? 0.5 : 0;
              } else {
                score = cosineSimilarity(
                  queryEmbedding,
                  storedEmbedding.vector,
                );
              }
            } else {
              // No embedding stored; fall back to text match
              const haystack =
                `${entry.title}\n${entry.body}`.toLowerCase();
              score = haystack.includes(query.text.toLowerCase()) ? 0.5 : 0;
            }
          } else {
            // Text search fallback
            const haystack = `${entry.title}\n${entry.body}`.toLowerCase();
            score = haystack.includes(query.text.toLowerCase()) ? 1 : 0;
          }

          // Title-anchor floor: a query that matches the entry title (either
          // direction, case-insensitive) must not be diluted below the top
          // ranks by long-body mean pooling (see 20260905-171239-533).
          if (titleMatches(query.text, entry.title)) {
            score = Math.max(score, 0.75);
          }

          if (score <= 0) continue;
        } else {
          // No text query - chronological order (score by recency)
          score = entry.created.getTime();
        }

        entries.push({ entry, score });
      }

      const total = entries.length;

      // Sort by score descending
      entries.sort((a, b) => b.score - a.score);

      // Apply offset + limit
      entries = entries.slice(offset, offset + limit);

      return {
        entries: entries.map((e) => e.entry),
        total,
        allTags: Array.from(tagSet).sort(),
      };
    },
  };
}

export function buildJournalSystemNote(
  tags?: readonly JournalTag[],
): string {
  const tagSection =
    tags && tags.length > 0
      ? `\n\nSuggested tags:\n${tags.map((t) => `- ${t.name}: ${t.description}`).join("\n")}`
      : "";

  return `<journal_instructions>
You have access to a private journal. Use it to record thoughts, discoveries, and decisions as you work.
Tags are free-form strings — use them to classify entries however makes sense.${tagSection}

Before starting complex tasks, search the journal for relevant past context.
Journal entries are append-only: you write new entries but never edit old ones.
Use journal_search to find past entries semantically, and journal_read to read a specific entry.
The journal is global across all projects but each entry records which project it was written from.
</journal_instructions>`;
}
