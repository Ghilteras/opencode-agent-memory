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
- **Bounded system prompt note** - A short journal-instructions note is injected while the journal is enabled
- **No data leaves the machine** - Embeddings run locally

## Requirements

- [OpenCode](https://opencode.ai/) v1.0.115 or later

## Installation

Add to your OpenCode config (`~/.config/opencode/opencode.json`):

```json
{
  "plugin": ["@ghilteras/opencode-agent-memory@0.5.0"]
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

With the journal disabled the plugin registers **no tools** and injects nothing.

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

Suggested tags appear in the system prompt as guidance.

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
- **Journal is opt-in.** You must explicitly enable it in `~/.config/opencode/agent-memory.json`; with it disabled the plugin registers no tools and injects nothing.
- **Local embeddings, no data leaves the machine.** Semantic search uses a locally cached transformers.js model; no external API calls are made for search or embedding.

## Inspiration

The journal concept is inspired by [private-journal-mcp](https://github.com/obra/private-journal-mcp) by Jesse Vincent.

## License

Originally created by Joshua David Thomas and licensed under the MIT license. Maintained by Angelo Pantano. See the [`LICENSE`](LICENSE) file for full terms.

---

opencode-agent-memory is not built by, or affiliated with, the OpenCode team.

OpenCode is ©2025 Anomaly.
