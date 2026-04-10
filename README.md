# claude-peers

Let your Claude Code instances find each other and talk — across terminals, projects, and machines. Any Claude can discover the others and send messages that arrive instantly.

```
  Machine A                              Machine B
  ┌───────────────────────┐              ┌──────────────────────┐
  │ Claude "planner"      │              │ Claude "worker"      │
  │ /register planner     │              │ /register worker     │
  │ /send worker "review  │  ──broker──> │                      │
  │  the API changes"     │              │ <channel> arrives    │
  │                       │  <────────── │  instantly, responds │
  └───────────────────────┘              └──────────────────────┘
```

## Quick start (marketplace)

### 1. Install the plugin

In any Claude Code session:

```
/plugin marketplace add nice1st/claude-peers-mcp
/plugin install claude-peers
```

### 2. Set the broker URL

Add to your shell profile (`~/.zshrc`, `~/.bashrc`, etc.):

```bash
export CLAUDE_PEERS_BROKER_URL=http://<broker-host>:7899
```

Skip this if the broker is running on localhost.

### 3. Start Claude Code with the channel

```bash
claude --dangerously-load-development-channels plugin:claude-peers@nice1st/claude-peers-mcp
```

### 4. Register and start talking

```
/register planner
```

Claude registers with the alias as peer ID, starts polling and heartbeat. Then:

```
/peers                                    # list peers
/send worker "review the API changes"     # send a message
```

When done:

> Unregister from the peer network

## Quick start (plugin-dir)

For development or without marketplace:

```bash
git clone https://github.com/nice1st/claude-peers-mcp.git ~/claude-peers-mcp
```

```bash
CLAUDE_PEERS_BROKER_URL=http://<broker-host>:7899 claude --plugin-dir ~/claude-peers-mcp/plugin --dangerously-load-development-channels server:plugin:claude-peers:claude-peers
```

## Broker setup

The broker is a standalone HTTP server that routes messages between peers. Someone needs to run it.

### Local broker

```bash
git clone https://github.com/nice1st/claude-peers-mcp.git ~/claude-peers-mcp
cd ~/claude-peers-mcp
bun install
bun broker.ts
```

Listens on `0.0.0.0:7899` by default.

### Remote broker

Run the broker on a shared server accessible from multiple machines:

```bash
# Start broker (binds to all interfaces by default)
bun broker.ts

# Or bind to a specific interface
CLAUDE_PEERS_HOST=192.168.1.100 bun broker.ts
```

Ensure port 7899 is open in your firewall. Peers that miss heartbeats for 60 seconds are automatically removed.

## What Claude can do

| Tool             | What it does                                                                   |
| ---------------- | ------------------------------------------------------------------------------ |
| `register`       | Connect to broker with an alias as peer ID, start polling/heartbeat (**call this first**) |
| `unregister`     | Disconnect from broker, stop polling/heartbeat                                 |
| `list_peers`     | Find other Claude Code instances — scoped to `machine`, `directory`, or `repo` |
| `send_message`   | Send a message to another instance by ID (arrives instantly via channel push)  |
| `set_summary`    | Describe what you're working on (visible to other peers)                       |
| `check_messages` | Manually check for messages (fallback if channel push is unavailable)          |

## Skills

The plugin includes slash commands for convenience:

| Skill       | Usage                              |
| ----------- | ---------------------------------- |
| `/register` | `/register planner`                |
| `/peers`    | `/peers`                           |
| `/send`     | `/send worker review the changes`  |

## How it works

A **broker daemon** runs on a shared server with a SQLite database. Each Claude Code session has its own MCP server that connects to the broker. When Claude calls `register` with an alias, the alias becomes the peer ID — stable and reusable across sessions. The MCP server then starts polling the broker every second. Inbound messages are pushed into the session via the [claude/channel](https://code.claude.com/docs/en/channels-reference) protocol, so Claude sees them immediately — without interfering with user input.

```
                    ┌───────────────────────────┐
                    │  broker daemon            │
                    │  0.0.0.0:7899 + SQLite    │
                    └──────┬───────────────┬────┘
                           │               │
                      MCP server A    MCP server B
                      (Machine A)     (Machine B)
                           │               │
                      Claude A         Claude B
```

Peers are detected as stale if they miss heartbeats for 60 seconds (configurable).

## CLI

Inspect and interact from the command line:

```bash
cd ~/claude-peers-mcp

bun cli.ts status            # broker status + all peers
bun cli.ts peers             # list peers
bun cli.ts send <id> <msg>   # send a message into a Claude session
bun cli.ts kill-broker       # stop the broker

# Remote broker
CLAUDE_PEERS_BROKER_URL=http://remote:7899 bun cli.ts status
```

## Configuration

| Environment variable         | Default              | Description                              |
| ---------------------------- | -------------------- | ---------------------------------------- |
| `CLAUDE_PEERS_BROKER_URL`    | —                    | Full broker URL (e.g. http://remote:7899)|
| `CLAUDE_PEERS_PORT`          | `7899`               | Broker port (used when BROKER_URL not set)|
| `CLAUDE_PEERS_HOST`          | `0.0.0.0`            | Broker bind address                      |
| `CLAUDE_PEERS_DB`            | `~/.claude-peers.db` | SQLite database path                     |
| `CLAUDE_PEERS_STALE_TIMEOUT` | `60000`              | Peer staleness timeout in ms             |

## Requirements

- [Bun](https://bun.sh)
- Claude Code v2.1.80+
- claude.ai login (channels require it — API key auth won't work)
