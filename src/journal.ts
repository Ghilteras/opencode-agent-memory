import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import * as yaml from "js-yaml";
import MiniSearch from "minisearch";
import { z } from "zod";

import { EMBEDDING_DIMENSION, embeddingModelName, generateEmbedding } from "./embeddings";
import { atomicWriteFile, buildFrontmatterDocument, splitFrontmatter } from "./frontmatter";

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

function hasLexicalTerms(text: string): boolean {
  return /[\p{L}\p{N}]+/u.test(text);
}

function substringMatches(
  entries: CachedEntry[],
  query: string,
): { entry: JournalEntry; score: number }[] {
  const needle = query.toLowerCase();
  return entries.flatMap(({ entry }) =>
    `${entry.title}\n${entry.body}`.toLowerCase().includes(needle)
      ? [{ entry, score: 0 }]
      : [],
  );
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

type CachedEntry = {
  entryMtimeMs: number;
  entrySize: number;
  entry: JournalEntry;
};

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
  let lexicalIndexSnapshot: { ids: string[]; index: MiniSearch } | undefined;

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

      // Keep the sidecar for compatibility with doctor, the format contract, and future consumers; search does not read it.
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

      // Collect all tags across every entry (before filtering)
      const tagSet = new Set<string>();
      let entryCacheChanged = false;

      const indexed = await Promise.all(files.map(async (file) => {
        const filePath = path.join(journalDir, file);
        try {
          const entryStat = await fs.stat(filePath);
          const cached = entryCache.get(filePath);
          if (
            cached &&
            cached.entryMtimeMs === entryStat.mtimeMs &&
            cached.entrySize === entryStat.size
          ) {
            return cached;
          }
          const entry = await readEntryFile(filePath);
          entryCacheChanged = true;
          const value: CachedEntry = {
            entryMtimeMs: entryStat.mtimeMs,
            entrySize: entryStat.size,
            entry,
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
        ranked.sort((a, b) => b.score - a.score || (a.entry.id < b.entry.id ? 1 : a.entry.id > b.entry.id ? -1 : 0));
      } else {
        const ids = filtered.map(({ entry }) => entry.id);
        const sameEntries = !entryCacheChanged && lexicalIndexSnapshot !== undefined &&
          lexicalIndexSnapshot.ids.length === ids.length &&
          ids.every((id, index) => lexicalIndexSnapshot!.ids[index] === id);
        let lexicalIndex: MiniSearch;
        if (sameEntries) {
          lexicalIndex = lexicalIndexSnapshot!.index;
        } else {
          const builtIndex = new MiniSearch({
            fields: ["title", "body"],
            storeFields: ["id"],
          });
          builtIndex.addAll(filtered.map(({ entry }) => ({
            id: entry.id,
            title: entry.title,
            body: entry.body,
          })));
          lexicalIndexSnapshot = { ids, index: builtIndex };
          lexicalIndex = builtIndex;
        }
        const byId = new Map(filtered.map(({ entry }) => [entry.id, entry]));
        const lexical = lexicalIndex.search(query.text, { combineWith: "OR" });
        if (hasLexicalTerms(query.text)) {
          ranked = lexical.flatMap((match) => {
            const entry = byId.get(String(match.id));
            return entry ? [{ entry, score: match.score }] : [];
          });
        } else {
          ranked = substringMatches(filtered, query.text);
        }
        ranked.sort((a, b) =>
          b.score - a.score ||
          b.entry.created.getTime() - a.entry.created.getTime() ||
          (a.entry.id < b.entry.id ? 1 : a.entry.id > b.entry.id ? -1 : 0),
        );
      }

      // Count lexical candidates after metadata filtering, before paging.
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
