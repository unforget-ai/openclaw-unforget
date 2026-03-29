# Unforget Memory Plugin for OpenClaw

Long-term memory for your OpenClaw agents. Zero LLM on write. Zero config.

## Install

```bash
npm install @unforget-ai/openclaw
```

## Setup

Add to your OpenClaw plugin config:

```json
{
  "unforget-memory": {}
}
```

That's it. No API keys. No Docker. No database setup.

On first use, the plugin auto-starts an embedded PostgreSQL + Unforget server via `unforget-embed`.

## How It Works

- **Auto-Recall**: Before each prompt, relevant memories are retrieved and injected into context
- **Auto-Retain**: After each response, important conversation turns are stored as memories
- **4-Channel Retrieval**: Semantic + BM25 + entity + temporal search, fused with RRF

## Configuration

```json
{
  "unforget-memory": {
    "autoRetain": true,
    "autoRecall": true,
    "autoRecallTopK": 10,
    "orgId": "my-org",
    "agentId": "my-agent"
  }
}
```

### External Server

If you already run Unforget or want to use your own PostgreSQL:

```json
{
  "unforget-memory": {
    "apiUrl": "http://localhost:9077"
  }
}
```

## Requirements

For embedded mode (default):
- Python 3.11+ with `pip install unforget-embed`
- Or `uvx` (Python package runner)

The plugin tries these in order:
1. `uvx unforget-embed` (auto-installs from PyPI)
2. `unforget-embed` (if pip-installed)
3. `python -m unforget_embed.cli` (fallback)

## License

Apache 2.0
