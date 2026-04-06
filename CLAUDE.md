---
description: Use Bun instead of Node.js, npm, pnpm, or vite.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

# claude-peers

Peer discovery and messaging MCP channel for Claude Code instances.

## Architecture

- `broker.ts` — Singleton HTTP daemon (localhost:7899 or remote) + SQLite. **Must be started separately.**
- `server.ts` — MCP stdio server, one per Claude Code instance. Connects to broker, exposes tools, pushes channel notifications. **Does NOT auto-register.** Claude must call `register` tool first.
- `shared/types.ts` — Shared TypeScript types for broker API.
- `cli.ts` — CLI utility for inspecting broker state.

## Workflow

```
1. Start broker separately:     bun broker.ts
2. Start Claude Code session:   claude --dangerously-load-development-channels server:claude-peers
3. Claude calls register tool:  registers with broker, starts polling/heartbeat
4. Claude sends/receives messages via channel push
5. Claude calls unregister:     stops polling/heartbeat, disconnects
```

## Tools

| Tool | Description |
|------|-------------|
| `register` | Register with broker + start polling/heartbeat (CALL FIRST) |
| `unregister` | Unregister + stop polling/heartbeat |
| `list_peers` | Discover other Claude Code instances |
| `send_message` | Send message to another instance by ID |
| `set_summary` | Set work summary (visible to peers) |
| `check_messages` | Manual message check (fallback) |

## Running

```bash
# 1. Start broker (separate process)
bun broker.ts

# 2. Start Claude Code with channel
claude --dangerously-load-development-channels server:claude-peers

# CLI:
bun cli.ts status
bun cli.ts peers
bun cli.ts send <peer-id> <message>
bun cli.ts kill-broker
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_PEERS_BROKER_URL` | — | Remote broker URL (overrides port) |
| `CLAUDE_PEERS_PORT` | `7899` | Broker port (localhost) |
| `CLAUDE_PEERS_DB` | `~/.claude-peers.db` | SQLite database path |

## Bun

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.
