---
description: Use Bun instead of Node.js, npm, pnpm, or vite.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

# claude-peers

Peer discovery and messaging MCP channel for Claude Code instances.

## Architecture

레포 루트는 브로커 + 마켓플레이스, `plugin/`은 사용자에게 배포되는 플러그인.

### 레포 루트 (브로커/운영)
- `broker.ts` — HTTP daemon (0.0.0.0:7899). 피어를 메모리 Map으로 관리, SSE로 메시지 push.
- `broker-handlers.ts` — broker 핸들러 로직 (테스트 분리용).
- `shared/types.ts` — broker API DTO.
- `.claude-plugin/marketplace.json` — 마켓플레이스 매니페스트 (`source: "./plugin"`).

### plugin/ (플러그인 배포)
- `plugin/server.ts` — MCP stdio server. broker에 HTTP로 통신.
- `plugin/shared/types.ts` — broker API DTO (복사본).
- `plugin/.claude-plugin/plugin.json` — 플러그인 매니페스트 + mcpServers 정의.
- `plugin/skills/` — `/register`, `/peers`, `/groups` 슬래시 커맨드. 메시지 전송은 MCP `send_message` 도구 직접 호출.

## Workflow

```
1. 브로커 실행:          bun broker.ts (리모트 서버)
2. 플러그인 설치:        마켓플레이스 또는 git clone → --plugin-dir
3. 세션 시작 (마켓플레이스):
   claude --dangerously-load-development-channels plugin:claude-peers@claude-peers-mcp
4. 세션 시작 (plugin-dir):
   claude --plugin-dir ~/claude-peers-mcp/plugin
     --dangerously-load-development-channels server:plugin:claude-peers:claude-peers
5. 등록:                 /register <alias>
6. 메시지 송수신:        send_message 도구 직접 호출 (to_id, message, [skill])
7. 종료:                 unregister
```

## Tools

| Tool | Description |
|------|-------------|
| `register` | Register with broker + open SSE connection (CALL FIRST). Auto-joins `lobby` group |
| `unregister` | Unregister + close SSE connection |
| `list_peers` | List peers sharing at least one group with you |
| `list_groups` | List all active groups with peer counts |
| `set_groups` | Replace your group memberships (array of names) |
| `send_message` | Send message to peer (requires shared group; otherwise `Peer not found`) |
| `set_summary` | Set work summary (visible to peers) |

## Running

```bash
bun broker.ts                              # 브로커 실행
curl http://localhost:7899/health          # 상태 확인
pkill -f 'bun broker.ts'                   # 브로커 종료
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_PEERS_BROKER_URL` | — | Remote broker URL (overrides port) |
| `CLAUDE_PEERS_PORT` | `7899` | Broker port |
| `CLAUDE_PEERS_HOST` | `0.0.0.0` | Broker bind address |

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

## 버전 관리 (커밋 전 필수)

코드 변경을 커밋하기 전, 아래 5곳 버전을 **반드시 확인하고 동기화**한다. 하나라도 누락되면 플러그인 업데이트가 인식되지 않는다.

- `package.json`
- `plugin/package.json`
- `plugin/.claude-plugin/plugin.json`
- `.claude-plugin/marketplace.json`
- `plugin/server.ts` (`new Server({ name, version })`)

기능 추가/수정 = minor or patch bump. 확인 명령:

```bash
grep -E '"version"|version:' package.json plugin/package.json plugin/.claude-plugin/plugin.json .claude-plugin/marketplace.json plugin/server.ts
```
