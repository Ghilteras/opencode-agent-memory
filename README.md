# opencode-agent-memory

> The maintained public home is
> [`Ghilteras/opencode-agent-memory`](https://github.com/Ghilteras/opencode-agent-memory);
> the public npm package is [`@ghilteras/opencode-agent-memory`](https://www.npmjs.com/package/@ghilteras/opencode-agent-memory).
>
> Originally created by Joshua David Thomas and licensed under the MIT license. Attribution preserved below; see License section.

A journal-only memory plugin for [OpenCode](https://opencode.ai): an append-only, tagged journal with local semantic search.

## Experimental

This plugin is experimental. It gives the agent one durable, self-maintained surface: a private journal. Entries are append-only - the agent writes new entries but never edits old ones.

Think of it as a searchable sidecar to `AGENTS.md`. OpenCode supports [rules](https://opencode.ai/docs/rules/) via `AGENTS.md` and custom instruction files; those remain the place for eager, always-in-context facts. The journal is for everything else: insights, discoveries, decisions, and observations worth finding later, not carrying every turn.

## Features

- **Append-only journal** - Entries survive across sessions and context compaction
- **Local semantic search** - Find entries by meaning, not just keywords
- **Metadata on every entry** - Project, model, provider, agent, session, timestamp, tags
- **Guidance in tool descriptions** - Journal usage guidance lives in the descriptions of the journal tools, so an agent sees it only when it is allowed to call them
- **No data leaves the machine** - Embeddings run locally

## Requirements

- [OpenCode](https://opencode.ai/) v1.0.115 or later

## Installation

Add to your OpenCode config (`~/.config/opencode/opencode.json`):

```json
{
  "plugin": ["@ghilteras/opencode-agent-memory@0.5.2"]
}
```

OpenCode fetches unpinned plugins from npm on each startup; pinned versions are cached and require a manual version bump to update.

## Journal

The journal is **opt-in**. Enable it in `~/.config/opencode/agent-memory.json`:

```json
{
  "journal": {
    "enabled": true
  }
}
```

The plugin does **not** regenerate `agent-memory.json` if it is deleted; its loss otherwise silently disables the journal, which is why the fault warning exists.

- Intentional disable (`"enabled": false`) is silent by design and registers **no tools**.
- A missing, unreadable, malformed, or schema-invalid config logs `[agent-memory] journal config <resolved path>: <reason>; journal tools will NOT be registered` and registers **no tools**.

### Tools

When the journal is enabled, the agent gets 3 tools:

| Tool | Description |
|------|-------------|
| `journal_write` | Write a new append-only entry (title, body, optional tags) |
| `journal_search` | Search entries semantically, filter by project or tags, with pagination |
| `journal_read` | Read a specific journal entry by ID |

### Entry format

Entries are markdown files with YAML frontmatter in `~/.config/opencode/journal/`. Each entry records its project, model, provider, agent, session, creation time, and tags, followed by the body:

```markdown
---
title: "Reasoning-pruner wiring"
created: 2026-09-21T18:16:11.300Z
project: /home/angelo/homelab-config
model: deepseek-v4.1-flash
provider: opencode-go
agent: executor
session_id: ses_...
tags: [plugin, wiring]
---

Body text...
```

### Semantic search

Search uses local embeddings ([paraphrase-multilingual-MiniLM-L12-v2](https://huggingface.co/Xenova/paraphrase-multilingual-MiniLM-L12-v2), 384d, multilingual EN/IT) - no data leaves your machine. An `.embedding` sidecar is written next to each entry in a versioned format (`{ v: 2, model, dimension, vector }`). The search gate is a **dimension** check: an entry whose recorded `dimension` differs from the plugin's expected dimension is not cosine-compared - it falls back to text matching instead of failing the search. Legacy bare-array embeddings from v0.3.x remain readable.

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
  "cacheDir": "/home/angelo/.cache/opencode/memory-model",
  "journal": {
    "enabled": true
  }
}
```

## Upgrading from 0.4.x

Memory blocks and their tools (`memory_list`, `memory_set`, `memory_replace`) are **removed**. Blocks are no longer read, written, or injected into the system prompt; the plugin ships only the journal.

Existing `~/.config/opencode/memory/` and `.opencode/memory/` directories are **not deleted** by the upgrade, but they are no longer read or written. Move anything still needed to `MEMORY.md` / `AGENTS.md` / `TOOLS.md`, or record it as a journal entry.

## Compatibility & Troubleshooting

- **Requires OpenCode v1.0.115+.**
- **Restart after config changes.** Plugin config changes require a full OpenCode restart to take effect; editing the config file alone is not sufficient.
- **Journal is opt-in.** You must explicitly enable it in `~/.config/opencode/agent-memory.json`; intentional disablement is silent, while a missing, unreadable, malformed, or schema-invalid config logs a warning and registers no tools.
- **Local embeddings, no data leaves the machine.** Semantic search uses a locally cached transformers.js model; no external API calls are made for search or embedding.
- **Known limitation (since 0.5.1): guidance-in-descriptions depends on an unverified premise.** 0.5.1 moved journal guidance from the injected system-prompt note into the three journal tool descriptions, so only agents allowed to call those tools should see it. That relies on opencode omitting a permission-denied tool from the definitions sent to the model. This is **unverified**: a `tool.definition` probe on the isolated instance fires before permission filtering, so it cannot confirm what the model actually receives. If the premise does not hold, an agent denied `journal_*` may still read the description text; `deny` still blocks execution, so there is no capability escalation and no data disclosure — the blast radius is the three tools' description strings.

## Inspiration

The journal concept is inspired by [private-journal-mcp](https://github.com/obra/private-journal-mcp) by Jesse Vincent.

## License

Originally created by Joshua David Thomas and licensed under the MIT license. Maintained by Angelo Pantano. See the [`LICENSE`](LICENSE) file for full terms.

---

opencode-agent-memory is not built by, or affiliated with, the OpenCode team.

OpenCode is ©2025 Anomaly.
