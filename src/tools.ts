import type { JournalStore, JournalTag } from "./journal";

export type JournalContext = {
  directory: string;
  model: string;
  provider: string;
};

const MAX_TAGS_TO_LIST = 20;

function formatTagsInUse(allTags: readonly string[]): string {
  if (allTags.length === 0) return "";
  if (allTags.length > MAX_TAGS_TO_LIST) return `\nTags in use: ${allTags.length} (filter with tags=...)`;
  return `\nTags in use: ${allTags.join(", ")}`;
}

type JsonSchema = {
  type: "object";
  properties: Record<string, { type: string; description?: string; minimum?: number }>;
  required?: string[];
  additionalProperties: false;
};
type ToolDefinition = {
  name: string;
  description: string;
  input: JsonSchema;
  execute(input: Record<string, unknown>, context: { agent: string; sessionID: string }): Promise<{ content: string }>;
};

export function JournalWrite(store: JournalStore, ctx: JournalContext, tags?: readonly JournalTag[]): ToolDefinition {
  const suggestedTags = tags?.length ? ` Suggested tags: ${tags.map((tag) => tag.name).join(", ")}.` : "";
  return {
    name: "journal_write",
    description: "Write a new append-only journal entry. Use this to capture insights, technical discoveries, design decisions, observations, or reflections. Entries are append-only: you write new entries but never edit old ones. Tags are optional comma-separated names, e.g. \"perf, debugging\"." + suggestedTags,
    input: {
      type: "object",
      properties: {
        title: { type: "string", description: "Entry title" },
        body: { type: "string", description: "Entry body" },
        tags: { type: "string", description: "Optional comma-separated tag names" },
      },
      required: ["title", "body"],
      additionalProperties: false,
    },
    async execute(input, toolCtx) {
      const title = input.title as string;
      const body = input.body as string;
      const tags = typeof input.tags === "string" ? input.tags.split(",").map((tag) => tag.trim()).filter(Boolean) : undefined;
      const entry = await store.write({ title, body, project: ctx.directory, model: ctx.model, provider: ctx.provider, agent: toolCtx.agent, sessionId: toolCtx.sessionID, tags });
      return { content: `Journal entry created: ${entry.id}\n  title: ${entry.title}\n  created: ${entry.created.toISOString()}` };
    },
  };
}

export function JournalRead(store: JournalStore): ToolDefinition {
  return {
    name: "journal_read",
    description: "Read a specific journal entry by its ID. Returns the full entry including metadata and body.",
    input: { type: "object", properties: { id: { type: "string", description: "Journal entry ID" } }, required: ["id"], additionalProperties: false },
    async execute(input) {
      const entry = await store.read(input.id as string);
      const meta = [
        `title: ${entry.title}`, `created: ${entry.created.toISOString()}`,
        entry.project ? `project: ${entry.project}` : null,
        entry.model ? `model: ${entry.model}` : null,
        entry.provider ? `provider: ${entry.provider}` : null,
        entry.agent ? `agent: ${entry.agent}` : null,
        entry.sessionId ? `session: ${entry.sessionId}` : null,
        entry.tags.length ? `tags: ${entry.tags.join(", ")}` : null,
      ].filter(Boolean).join("\n");
      return { content: `${meta}\n\n${entry.body}` };
    },
  };
}

export function JournalSearch(store: JournalStore): ToolDefinition {
  return {
    name: "journal_search",
    description: "Search journal entries using semantic similarity. Returns matching entries sorted by relevance. All filters are optional and combined with AND logic. Use with no arguments to list recent entries. Use offset to paginate. Before starting complex tasks, search the journal for relevant past context. The journal is global across all projects but each entry records which project it was written from.",
    input: {
      type: "object",
      properties: {
        text: { type: "string", description: "Semantic search text" },
        project: { type: "string", description: "Filter by project directory" },
        tags: { type: "string", description: "Comma-separated tags; all must match" },
        limit: { type: "integer", minimum: 1, description: "Maximum entries to return" },
        offset: { type: "integer", minimum: 0, description: "Number of entries to skip" },
      },
      additionalProperties: false,
    },
    async execute(input) {
      const result = await store.search({
        text: input.text as string | undefined,
        project: input.project as string | undefined,
        tags: typeof input.tags === "string" ? input.tags.split(",").map((tag) => tag.trim()).filter(Boolean) : undefined,
        limit: input.limit as number | undefined,
        offset: input.offset as number | undefined,
      });
      const tagsLine = formatTagsInUse(result.allTags);
      if (!result.entries.length) return { content: `No journal entries found.${tagsLine}` };
      const offset = (input.offset as number | undefined) ?? 0;
      const header = `Found ${result.total} entries (showing ${offset + 1}–${offset + result.entries.length}):`;
      const lines = result.entries.map((entry) => `${entry.id}\n  ${entry.title}${entry.tags.length ? ` [${entry.tags.join(", ")}]` : ""}\n  ${entry.created.toISOString()}`);
      return { content: `${header}${tagsLine}\n\n${lines.join("\n\n")}` };
    },
  };
}
