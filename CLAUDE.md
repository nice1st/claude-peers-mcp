---
description: Use Bun instead of Node.js, npm, pnpm, or vite.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

# claude-peers

Peer discovery and messaging MCP channel for Claude Code instances.

## Architecture

- `broker.ts` — HTTP daemon (0.0.0.0:7899) + SQLite. 리모트 머신에서 별도 실행. heartbeat 타임아웃으로 stale peer 정리.
- `server.ts` — MCP stdio server. 플러그인으로 배포됨. broker에 HTTP로 통신. Claude가 `register` 도구 호출 후 동작.
- `shared/types.ts` — broker API 공유 타입.
- `cli.ts` — broker 상태 조회 CLI. `CLAUDE_PEERS_BROKER_URL` 지원.
- `.claude-plugin/` — Claude Code 플러그인 매니페스트 (marketplace + plugin).
- `skills/` — `/register`, `/peers`, `/send` 슬래시 커맨드.

## Workflow

```
1. 브로커 실행:          bun broker.ts (리모트 서버)
2. 플러그인 설치:        /plugin marketplace add nice1st/claude-peers-mcp
                         /plugin install claude-peers
3. 세션 시작:            claude --channels plugin:claude-peers@nice1st/claude-peers-mcp
4. 등록:                 /register <alias>
5. 메시지 송수신:        /send <peer-id> <message>
6. 종료:                 unregister
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
# Broker (리모트 서버)
bun broker.ts

# CLI
CLAUDE_PEERS_BROKER_URL=http://remote:7899 bun cli.ts status
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_PEERS_BROKER_URL` | — | Remote broker URL (overrides port) |
| `CLAUDE_PEERS_PORT` | `7899` | Broker port |
| `CLAUDE_PEERS_HOST` | `0.0.0.0` | Broker bind address |
| `CLAUDE_PEERS_DB` | `~/.claude-peers.db` | SQLite database path |
| `CLAUDE_PEERS_STALE_TIMEOUT` | `60000` | Peer staleness timeout (ms) |

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
