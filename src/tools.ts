import type { JournalStore, JournalTag } from "./journal";
import { loadRerankConfig } from "./rerank-config";
import { buildCandidates, buildRequestBody, fuseRanks, RERANK_K, RERANK_WINDOW } from "./rerank";
import { requestRerank } from "./rerank-transport";
import type { RerankFailureReason } from "./rerank-transport";

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
  execute(input: Record<string, unknown>, context: { agent: string; sessionID: string }): Promise<{ content: string; ranking?: JournalRanking }>;
};
type JournalRanking =
  | { method: "bm25+llm-rrf"; status: "applied"; candidateCount: number; labelCount: number; k: 10 }
  | { method: "bm25"; status: "fallback"; reason: RerankFailureReason }
  | { method: "bm25"; status: "skipped"; reason: "no_query" | "insufficient_candidates" | "outside_window" };
type RerankDependencies = {
  loadConfig?: typeof loadRerankConfig;
  request?: typeof requestRerank;
  env?: (name: string) => string | undefined;
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

export function JournalSearch(store: JournalStore, deps: RerankDependencies = {}): ToolDefinition {
  const loadConfig = deps.loadConfig ?? loadRerankConfig;
  const request = deps.request ?? requestRerank;
  const getEnv = deps.env ?? ((name: string) => process.env[name]);
  return {
    name: "journal_search",
    description: "Find candidate journal entries by lexical OR matching query words in titles and bodies. Candidates are not relevance claims. All filters are optional and combined with AND logic. Use with no arguments to list recent entries. Use offset to paginate. Before starting complex tasks, search the journal for relevant past context. The journal is global across all projects but each entry records which project it was written from.",
    input: {
      type: "object",
      properties: {
        text: { type: "string", description: "Query words for lexical candidate matching in titles and bodies" },
        project: { type: "string", description: "Filter by project directory" },
        tags: { type: "string", description: "Comma-separated tags; all must match" },
        limit: { type: "integer", minimum: 1, description: "Maximum entries to return" },
        offset: { type: "integer", minimum: 0, description: "Number of entries to skip" },
      },
      additionalProperties: false,
    },
    async execute(input) {
      const query = {
        text: input.text as string | undefined,
        project: input.project as string | undefined,
        tags: typeof input.tags === "string" ? input.tags.split(",").map((tag) => tag.trim()).filter(Boolean) : undefined,
        limit: input.limit as number | undefined,
        offset: input.offset as number | undefined,
      };
      const offset = query.offset ?? 0;
      const limit = query.limit ?? 20;
      const config = await loadConfig();
      let result: Awaited<ReturnType<JournalStore["search"]>>;
      let ranking: JournalRanking | undefined;

      if (config.status !== "enabled") {
        result = await store.search(query);
      } else {
        const [ordinary, window] = await Promise.all([
          store.search(query),
          store.search({ ...query, limit: RERANK_WINDOW, offset: 0 }),
        ]);
        result = ordinary;
        if (!query.text?.trim()) {
          ranking = { method: "bm25", status: "skipped", reason: "no_query" };
        } else if (window.entries.length < 2) {
          ranking = { method: "bm25", status: "skipped", reason: "insufficient_candidates" };
        } else if (offset + limit > window.entries.length) {
          ranking = { method: "bm25", status: "skipped", reason: "outside_window" };
        } else {
          const candidates = buildCandidates(window.entries);
          const count = Math.min(10, window.entries.length);
          try {
            const outcome = await request({
              baseURL: config.config.baseURL,
              apiKey: getEnv("AGENT_MEMORY_RERANK_API_KEY") ?? "",
              body: buildRequestBody({ model: config.config.model, query: query.text ?? "", candidates, count }),
              candidates,
              count,
            });
            if (!outcome.ok) {
              ranking = { method: "bm25", status: "fallback", reason: outcome.reason };
            } else {
              const fusedLabels = fuseRanks(candidates, outcome.labels, RERANK_K);
              const byLabel = new Map(candidates.map((candidate, index) => [candidate.label, window.entries[index]!]));
              const fused = fusedLabels.map((label) => byLabel.get(label)!);
              result = { ...ordinary, entries: fused.slice(offset, offset + limit) };
              ranking = { method: "bm25+llm-rrf", status: "applied", candidateCount: window.entries.length, labelCount: outcome.labels.length, k: RERANK_K };
            }
          } catch {
            ranking = { method: "bm25", status: "fallback", reason: "transport_error" };
          }
        }
      }
      const tagsLine = formatTagsInUse(result.allTags);
      const content = !result.entries.length
        ? `No journal entries found.${tagsLine}`
        : (() => {
          const header = `Found ${result.total} candidate entries (showing ${offset + 1}–${offset + result.entries.length}):`;
          const lines = result.entries.map((entry) => `${entry.id}\n  ${entry.title}${entry.tags.length ? ` [${entry.tags.join(", ")}]` : ""}\n  ${entry.created.toISOString()}`);
          return `${header}${tagsLine}\n\n${lines.join("\n\n")}`;
        })();
      return ranking ? { content, ranking } : { content };
    },
  };
}
