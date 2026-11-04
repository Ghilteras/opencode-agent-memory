# opencode-agent-memory

> The maintained public home is
> [`Ghilteras/opencode-agent-memory`](https://github.com/Ghilteras/opencode-agent-memory);
> the public npm package is [`@ghilteras/opencode-agent-memory`](https://www.npmjs.com/package/@ghilteras/opencode-agent-memory).
>
> Originally created by Joshua David Thomas and licensed under the MIT license. Attribution preserved below; see License section.

A journal-only memory plugin for [OpenCode](https://opencode.ai): a tagged journal with local lexical search.

## Entry-loss fix (2.4.1)

Version 2.4.0 could silently overwrite an existing journal entry when two writes generated the same millisecond filename, violating the advertised append-only guarantee. Entries are now preserved using IDs such as `20261104-123456-789-1`; treat IDs as opaque strings. Previously overwritten entries are **not** recovered by upgrading, and journal diagnostics cannot detect content that was overwritten — recovery requires a backup or another surviving copy. Journal storage now requires filesystem hard-link support; on an unsupported filesystem a write fails loudly instead of overwriting an existing entry.

## Experimental

This plugin is experimental. It gives the agent one durable, self-maintained surface: a private journal. New entries are appended without replacing existing files; the agent does not edit old entries.

Think of it as a searchable sidecar to `AGENTS.md`. OpenCode supports [rules](https://opencode.ai/docs/rules/) via `AGENTS.md` and custom instruction files; those remain the place for eager, always-in-context facts. The journal is for everything else: insights, discoveries, decisions, and observations worth finding later, not carrying every turn.

## Features

- **Append-only journal** - Entries survive across sessions and context compaction; storage requires filesystem hard-link support
- **Local lexical search** - Find candidate entries by matching query words in titles and bodies
- **Metadata on every entry** - Project, model, provider, agent, session, timestamp, tags
- **Guidance in tool descriptions** - Journal usage guidance lives in the descriptions of the journal tools, so an agent sees it only when it is allowed to call them
- **By default, no data leaves your machine** - Embeddings run locally; optional LLM reranking sends selected journal content only when explicitly enabled and configured.

## Requirements

- [OpenCode](https://opencode.ai/) **v2** — this version uses the OpenCode v2 plugin API and does **not** run on v1

## Installation

Add to your OpenCode config (`~/.config/opencode/opencode.json`):

```json
{
  "plugins": ["@ghilteras/opencode-agent-memory@2.4.1"]
}
```

Note OpenCode **v2** reads the `plugins` key (v1 used `plugin`). OpenCode fetches unpinned plugins from npm on each startup; pinned versions are cached and require a manual version bump to update.

## Journal

The journal is **on by default** — the three tools are registered with no configuration required.

To turn it off, set `enabled: false` in `~/.config/opencode/agent-memory.json`:

```json
{
  "journal": {
    "enabled": false
  }
}
```

- An explicit disable (`"enabled": false`) is silent by design and registers **no tools**.
- A config that exists but is unreadable, malformed, or schema-invalid **fails closed**: it logs `[agent-memory] journal config <resolved path>: <reason>; journal tools will NOT be registered` and registers **no tools**.
- An **absent** config means the default: the tools register. (This changed in 1.0.0 — an absent config used to disable the journal.)

### Tools

The agent gets 3 tools:

| Tool | Description |
|------|-------------|
| `journal_write` | Write a new entry without replacing existing files (title, body, optional tags; requires filesystem hard-link support) |
| `journal_search` | Find lexical candidates by matching query words in titles and bodies; filter by project or tags, with pagination |
| `journal_read` | Read a specific journal entry by ID |

### Entry format

Entries are markdown files with YAML frontmatter in `~/.config/opencode/journal/`. Each entry records its project, model, provider, agent, session, creation time, and tags, followed by the body:

```markdown
---
title: "Reasoning-pruner wiring"
created: 2026-09-21T18:16:11.300Z
project: /path/to/project
model: deepseek-v4.1-flash
provider: opencode-go
agent: executor
session_id: ses_...
tags: [plugin, wiring]
---

Body text...
```

### Text search

Text search runs one MiniSearch BM25+ pass over title and body. Query terms are OR-matched, with native score order and a deterministic tie-break by creation time and ID. This is keyword matching, not a claim of semantic relevance: results are candidates for the agent to inspect. Matching works across languages by matching literal words, not by meaning. When a query has no tokenizable terms (for example, `!!!`), search falls back to case-insensitive exact-substring matching over title and body. The retained index is reused while the ordered candidate-entry ID list is unchanged, avoiding repeated index construction. Embedding sidecars are still written in the versioned `{ v: 2, model, dimension, vector }` format for compatibility, but search does not read them.

### Optional LLM reranking

Optional LLM reranking fuses the BM25 order with a listwise ranking of the BM25 top-50 candidates using reciprocal rank fusion (RRF, k=10). In a 30-task pilot, Hit@5 increased from 0.500 to 0.700, Hit@10 from 0.667 to 0.767, and MRR@10 from 0.321 to 0.528. A shuffled-candidate control also achieved Hit@5 of 0.700, and the direction of improvement survived pessimistic relevance judgments. The result was not statistically significant (p=0.070, n=30); this is preliminary evidence, not a guaranteed improvement. The pilot used one cloud call per query, costing approximately US$0.001 and taking about 2–3 seconds. Results, cost, and latency depend on the model, provider, and journal; these pilot measurements are not a benchmark of every supported configuration or a production service guarantee. This pilot was not an independent evaluation and does not establish a generalizable quality improvement.

#### Provider quirks

Some gateways require extra request headers. Reasoning models must be told not to reason so they return the requested labels within the completion budget. For the OpenCode inference gateway, use a stable UUID generated once:

```json
{
  "enabled": true,
  "baseURL": "https://opencode.ai/inference/go/openai/v1",
  "model": "deepseek-v4.1-flash",
  "request": {
    "headers": { "x-opencode-session": "<a stable UUID you generate once>" },
    "body": { "reasoning_effort": "none" }
  }
}
```

Without `reasoning_effort: "none"`, a reasoning model spends the entire completion budget and returns empty content; the plugin then falls back to BM25.

Reranking is off by default. Without explicit enablement, journal search remains local and credential-free, with no reranking network requests. When enabled, each eligible search sends your query and the titles and excerpts of up to 50 filtered journal candidates to the HTTPS endpoint you configure. Titles and excerpts are limited to 200 Unicode code points; sensitive information appearing in those fields is not automatically redacted. The plugin does not send journal paths, entry IDs, metadata, session history, or unrelated entries, and does not silently reuse OpenCode credentials. Your configured endpoint receives the dedicated API credential and processes journal content under its own policies. Reranking makes at most one request per search; failures return BM25 without retry. Requests may remain billable after timeout or cancellation.

Configure reranking in `~/.config/opencode/agent-memory-rerank.json`, alongside `agent-memory.json`:

```json
{ "enabled": true, "baseURL": "https://your-provider.example/v1", "model": "your-model-id" }
```

Set `AGENT_MEMORY_RERANK_API_KEY` in the environment of the process that runs OpenCode. The credential does not belong in the config file: do not use `OPENAI_API_KEY` or OpenCode credentials.

Constraints and pagination:

- HTTPS only; plaintext `http` is rejected, including for localhost.
- One request per search, with a 10-second deadline, request and response limits of 65,536 bytes each, 512 completion tokens by default (overridable via `request.body`), and no retries. A slow provider can make a search take up to about 10 seconds before timeout fallback.
- `request.body` may add or override any scalar field except `model`, `messages`, and `stream` (up to 10 fields; for example `reasoning_effort`, `temperature`, or `max_tokens`). The plugin always sends `max_tokens` (512 by default), so a provider that requires `max_completion_tokens` instead of `max_tokens` cannot be used.
- Only the first 50 candidates can move; `total` is unchanged. A page is reranked only when it fits entirely inside that top-50 window; other pages keep plain BM25 order.
- Searches without non-whitespace `text` are never reranked.
- Enabled ordering is **not reproducible** across calls, so offset pagination is a slice of each call's ranking, not a stable snapshot.

On failure, the result falls back to the ordinary BM25 page without retry, preserving its candidate count (`total`). The diagnostic is returned in the tool result's `metadata.ranking` field (not as a top-level field): an invalid reranking configuration reports `status: "fallback"` and `reason: "invalid_config"`; disabled or missing reranking configuration remains silent and adds no `metadata`. Other failure reason codes are `missing_credential`, `timeout`, `transport_error`, `http_error`, `malformed_body`, `malformed_labels`, `budget_exceeded` (request/response size or completion-token limit), and `aborted` (the search was cancelled). Searches skipped without a reranking request report `no_query`, `insufficient_candidates`, or `outside_window` in `metadata.ranking`.

### Suggested tags

Tags are free-form strings - the agent can use any tag, not just the suggested ones. You can suggest tags to guide its classification:

```json
{
  "journal": {
    "enabled": true,
    "tags": [
      { "name": "perf", "description": "Performance optimization work" },
      { "name": "debugging", "description": "Debugging sessions and findings" }
    ]
  }
}
```

Suggested tag **names** (not their descriptions) appear in the `journal_write` tool description as guidance.

### cacheDir

By default the transformers.js model cache lives in the default location (`~/.cache/huggingface`). Relocate it with `cacheDir` at the top level of `~/.config/opencode/agent-memory.json`:

```json
{
  "cacheDir": "~/.cache/opencode/memory-model",
  "journal": {
    "enabled": true
  }
}
```

## Upgrading to 1.0.0

**This release requires OpenCode v2.** The plugin was ported from the v1 plugin API to the v2 plugin API and will not load on v1. The config key is now `plugins` (v1 used `plugin`).

Two behaviour changes:

- **The journal tools are registered by default.** Previously you had to opt in through `agent-memory.json`; now an absent config means the tools are on, and you turn them off with `"enabled": false`.
- **Storage is unchanged.** Existing entries under `~/.config/opencode/journal/` and their `.embedding` sidecars stay readable; nothing is migrated or rewritten.

## Upgrading to lexical candidate search

- Text search now ranks entries with lexical OR matching: a candidate may match any query term in its title or body.
- Results are candidates, not relevance claims. `Found N` reports the candidate count before pagination and will usually be large.
- A punctuation-only query falls back to case-insensitive substring matching over title and body.

## Upgrading from 0.4.x

Memory blocks and their tools (`memory_list`, `memory_set`, `memory_replace`) are **removed**. Blocks are no longer read, written, or injected into the system prompt; the plugin ships only the journal.

Existing `~/.config/opencode/memory/` and `.opencode/memory/` directories are **not deleted** by the upgrade, but they are no longer read or written. Move anything still needed to `MEMORY.md` / `AGENTS.md` / `TOOLS.md`, or record it as a journal entry.

## Compatibility & Troubleshooting

- **Requires OpenCode v2.** This release uses the OpenCode v2 plugin API and does not run on v1.
- **Config changes.** `agent-memory.json` (journal configuration) is loaded when the plugin initializes, so changes require restarting OpenCode. `agent-memory-rerank.json` is read for each search, so reranking config changes take effect on the next search without a restart.
- **Journal is on by default.** Turn it off with `"enabled": false`; an explicit disable is silent, while a config that exists but is unreadable, malformed, or schema-invalid logs a warning and registers no tools (fail-closed).
- **Embedding sidecars remain compatible.** They are written locally for the existing format contract, diagnostics, and future consumers; text search is lexical and does not read embeddings.
- **Known limitation (since 0.5.1): guidance-in-descriptions depends on an unverified premise.** 0.5.1 moved journal guidance from the injected system-prompt note into the three journal tool descriptions, so only agents allowed to call those tools should see it. That relies on opencode omitting a permission-denied tool from the definitions sent to the model. This is **unverified**: a `tool.definition` probe on the isolated instance fires before permission filtering, so it cannot confirm what the model actually receives. If the premise does not hold, an agent denied `journal_*` may still read the description text; `deny` still blocks execution, so there is no capability escalation and no data disclosure — the blast radius is the three tools' description strings.

## Inspiration

The journal concept is inspired by [private-journal-mcp](https://github.com/obra/private-journal-mcp) by Jesse Vincent.

## License

Originally created by Joshua David Thomas and licensed under the MIT license. Maintained by Angelo Pantano. See the [`LICENSE`](LICENSE) file for full terms.

---

opencode-agent-memory is not built by, or affiliated with, the OpenCode team.

OpenCode is ©2025 Anomaly.
# Journal diagnostics

Run `bun run journal:doctor [config-dir]` to inspect flat journal Markdown files
and their `.embedding` sidecars without repairing or changing them. The optional
directory is the OpenCode state/config directory (the journal is read from its
`journal/` subdirectory); without it, the default is `~/.config/opencode`.
The command prints a deterministic JSON report and exits 0 for a complete scan
without errors, 1 for validation errors, or 2 for an incomplete scan/root error.
