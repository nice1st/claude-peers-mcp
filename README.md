# claude-peers

Let your Claude Code instances find each other and talk. When you're running multiple sessions across different projects, any Claude can discover the others and send messages that arrive instantly.

```
  Terminal 1 (poker-engine)          Terminal 2 (eel)
  ┌───────────────────────┐          ┌──────────────────────┐
  │ Claude A              │          │ Claude B             │
  │ "register"            │          │ "register"           │
  │ "send a message to    │  ──────> │                      │
  │  peer xyz: what files │          │ <channel> arrives    │
  │  are you editing?"    │  <────── │  instantly, Claude B │
  │                       │          │  responds            │
  └───────────────────────┘          └──────────────────────┘
```

## Quick start

### 1. Install

```bash
git clone https://github.com/nice1st/claude-peers-mcp.git ~/claude-peers-mcp
cd ~/claude-peers-mcp
bun install
```

### 2. Start the broker

The broker is a standalone process. Start it before any Claude sessions:

```bash
bun ~/claude-peers-mcp/broker.ts
```

It runs on `localhost:7899` with SQLite. Keep it running in a dedicated terminal or run it in the background.

### 3. Register the MCP server

This makes claude-peers available in every Claude Code session:

```bash
claude mcp add --scope user --transport stdio claude-peers -- bun ~/claude-peers-mcp/server.ts
```

### 4. Run Claude Code with the channel

```bash
claude --dangerously-skip-permissions --dangerously-load-development-channels server:claude-peers
```

### 5. Register and start talking

In the Claude session, tell Claude:

> Register with the peer network as "planner"

Claude calls the `register` tool with an alias (e.g. `planner`, `worker-a`). **The alias becomes the peer ID** — it's reusable and stable across sessions. Claude starts polling and heartbeat automatically after registering.

Then in another terminal, start a second session and register it with a different alias:

> Register with the peer network as "worker"

> List all peers on this machine

> Send a message to peer planner: "what are you working on?"

The other Claude receives it immediately and responds.

When done, tell Claude:

> Unregister from the peer network

This stops polling and heartbeat cleanly.

## What Claude can do

| Tool             | What it does                                                                   |
| ---------------- | ------------------------------------------------------------------------------ |
| `register`       | Connect to broker with an alias as peer ID, start polling/heartbeat (**call this first**) |
| `unregister`     | Disconnect from broker, stop polling/heartbeat                                 |
| `list_peers`     | Find other Claude Code instances — scoped to `machine`, `directory`, or `repo` |
| `send_message`   | Send a message to another instance by ID (arrives instantly via channel push)  |
| `set_summary`    | Describe what you're working on (visible to other peers)                       |
| `check_messages` | Manually check for messages (fallback if channel push is unavailable)          |

## How it works

A **broker daemon** runs separately with a SQLite database. Each Claude Code session has its own MCP server that connects to the broker. When Claude calls `register` with an alias, the alias becomes the peer ID — stable and reusable across sessions. The MCP server then starts polling the broker every second. Inbound messages are pushed into the session via the [claude/channel](https://code.claude.com/docs/en/channels-reference) protocol, so Claude sees them immediately — without interfering with user input.

```
                    ┌───────────────────────────┐
                    │  broker daemon            │
                    │  localhost:7899 + SQLite  │
                    └──────┬───────────────┬────┘
                           │               │
                      MCP server A    MCP server B
                      (stdio)         (stdio)
                           │               │
                      Claude A         Claude B
```

The broker must be started separately. Claude controls registration and polling via tools.

## CLI

Inspect and interact from the command line:

```bash
cd ~/claude-peers-mcp

bun cli.ts status            # broker status + all peers
bun cli.ts peers             # list peers
bun cli.ts send <id> <msg>   # send a message into a Claude session
bun cli.ts kill-broker       # stop the broker
```

## Configuration

| Environment variable       | Default              | Description                                 |
| -------------------------- | -------------------- | ------------------------------------------- |
| `CLAUDE_PEERS_BROKER_URL`  | —                    | Full broker URL (e.g. http://remote:7899)   |
| `CLAUDE_PEERS_PORT`        | `7899`               | Broker port (used when BROKER_URL not set)  |
| `CLAUDE_PEERS_DB`          | `~/.claude-peers.db` | SQLite database path                        |

### Remote broker

To use a remote broker, set `CLAUDE_PEERS_BROKER_URL`:

```bash
CLAUDE_PEERS_BROKER_URL=http://192.168.1.100:7899 claude --dangerously-load-development-channels server:claude-peers
```

## Requirements

- [Bun](https://bun.sh)
- Claude Code v2.1.80+
- claude.ai login (channels require it — API key auth won't work)
