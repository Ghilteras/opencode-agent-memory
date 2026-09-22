import { tool } from "@opencode-ai/plugin";

import type { JournalStore, JournalTag } from "./journal";

export type JournalContext = {
  directory: string;
  model: string;
  provider: string;
};

export function JournalWrite(
  store: JournalStore,
  ctx: JournalContext,
  tags?: readonly JournalTag[],
) {
  const suggestedTags =
    tags && tags.length > 0
      ? ` Suggested tags: ${tags.map((t) => t.name).join(", ")}.`
      : "";
  return tool({
    description:
      "Write a new append-only journal entry. Use this to capture insights, technical discoveries, " +
      "design decisions, observations, or reflections. " +
      "Entries are append-only: you write new entries but never edit old ones. " +
      "Tags are optional comma-separated names, e.g. \"perf, debugging\"." +
      suggestedTags,
    args: {
      title: tool.schema.string(),
      body: tool.schema.string(),
      tags: tool.schema.string().optional(),
    },
    async execute(args, toolCtx) {
      const tags = args.tags
        ? args.tags
            .split(",")
            .map((t: string) => t.trim())
            .filter(Boolean)
        : undefined;

      const entry = await store.write({
        title: args.title,
        body: args.body,
        project: ctx.directory,
        model: ctx.model,
        provider: ctx.provider,
        agent: toolCtx.agent,
        sessionId: toolCtx.sessionID,
        tags,
      });

      return `Journal entry created: ${entry.id}\n  title: ${entry.title}\n  created: ${entry.created.toISOString()}`;
    },
  });
}

export function JournalRead(store: JournalStore) {
  return tool({
    description:
      "Read a specific journal entry by its ID. Returns the full entry " +
      "including metadata and body.",
    args: {
      id: tool.schema.string(),
    },
    async execute(args) {
      const entry = await store.read(args.id);

      const meta = [
        `title: ${entry.title}`,
        `created: ${entry.created.toISOString()}`,
        entry.project ? `project: ${entry.project}` : null,
        entry.model ? `model: ${entry.model}` : null,
        entry.provider ? `provider: ${entry.provider}` : null,
        entry.agent ? `agent: ${entry.agent}` : null,
        entry.sessionId ? `session: ${entry.sessionId}` : null,
        entry.tags.length > 0
          ? `tags: ${entry.tags.join(", ")}`
          : null,
      ]
        .filter(Boolean)
        .join("\n");

      return `${meta}\n\n${entry.body}`;
    },
  });
}

export function JournalSearch(store: JournalStore) {
  return tool({
    description:
      "Search journal entries using semantic similarity. Returns matching entries " +
      "sorted by relevance. All filters are optional and combined with AND logic. " +
      "Use with no arguments to list recent entries. Use offset to paginate. " +
      "Before starting complex tasks, search the journal for relevant past context. " +
      "The journal is global across all projects but each entry records which project it was written from.",
    args: {
      text: tool.schema.string().optional(),
      project: tool.schema.string().optional(),
      tags: tool.schema.string().optional(),
      limit: tool.schema.number().int().positive().optional(),
      offset: tool.schema.number().int().nonnegative().optional(),
    },
    async execute(args) {
      const tags = args.tags
        ? args.tags
            .split(",")
            .map((t: string) => t.trim())
            .filter(Boolean)
        : undefined;

      const result = await store.search({
        text: args.text,
        project: args.project,
        tags,
        limit: args.limit,
        offset: args.offset,
      });

      if (result.entries.length === 0) {
        const tagsLine =
          result.allTags.length > 0
            ? `\nTags in use: ${result.allTags.join(", ")}`
            : "";
        return `No journal entries found.${tagsLine}`;
      }

      const offset = args.offset ?? 0;
      const header = `Found ${result.total} entries (showing ${offset + 1}–${offset + result.entries.length}):`;
      const tagsLine =
        result.allTags.length > 0
          ? `\nTags in use: ${result.allTags.join(", ")}`
          : "";

      const lines = result.entries.map((e) => {
        const tagStr =
          e.tags.length > 0
            ? ` [${e.tags.join(", ")}]`
            : "";
        return `${e.id}\n  ${e.title}${tagStr}\n  ${e.created.toISOString()}`;
      });

      return `${header}${tagsLine}\n\n${lines.join("\n\n")}`;
    },
  });
}
