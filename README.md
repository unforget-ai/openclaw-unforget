# Unforget Memory Plugin for OpenClaw

Long-term memory for your OpenClaw agents. Zero LLM on write. Zero config.

## Install

```bash
openclaw plugins install @unforget-ai/openclaw
```

Requires Python 3.12 with `unforget-embed`:

```bash
pipx install unforget-embed
```

That's it. No API keys. No Docker. No database setup.

## How It Works

- **Auto-Recall**: Before each prompt, relevant memories are retrieved and injected into context
- **Auto-Retain**: After each response, conversation turns are stored as memories
- **Forget/Remember**: Say "forget that I like pizza" or "remember my name is Kobi" — handled automatically
- **4-Channel Retrieval**: Semantic + BM25 + entity + temporal search, fused with RRF

## Usage

Just chat normally. The plugin handles everything:

```
You: My name is Alex and I like sushi
Agent: Got it — I'll remember that, Alex.

/new (new session)

You: What's my name and what food do I like?
Agent: Your name is Alex and you like sushi.

You: Forget that I like sushi
Agent: Forgotten.

/new

You: What food do I like?
Agent: You haven't told me any food preferences.
```

## Configuration

The plugin works with zero config. Optional settings in `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "@unforget-ai/openclaw": {
        "enabled": true,
        "config": {
          "orgId": "openclaw",
          "autoRetain": true,
          "autoRecall": true,
          "autoRecallTopK": 10,
          "debug": false
        }
      }
    }
  }
}
```

### External Server

If you already run Unforget or want to use your own PostgreSQL:

```json
{
  "config": {
    "apiUrl": "http://localhost:9077"
  }
}
```

## Architecture

```
OpenClaw agent
    │ hooks: before_agent_start, agent_end
    ▼
@unforget-ai/openclaw plugin (TypeScript)
    │ HTTP to localhost:9077
    ▼
unforget-embed (auto-started Python daemon)
    ├── unforget core library (4-channel retrieval)
    └── pgserver (embedded PostgreSQL + pgvector)
```

## License

Apache 2.0
