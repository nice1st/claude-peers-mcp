# claude-peers

> Forked from [louislva/claude-peers-mcp](https://github.com/louislva/claude-peers-mcp) — real-time messaging between Claude Code instances across machines via channel protocol (MCP plugin)

여러 머신의 Claude Code 인스턴스가 서로를 발견하고 메시지를 주고받을 수 있는 MCP 채널 플러그인.

**원본 대비 주요 개선:**
- **리모트 브로커** — 다른 머신에서 broker에 접속 가능 (0.0.0.0 바인딩, heartbeat 기반 stale peer 정리)
- **플러그인 배포** — `plugin/` 서브디렉토리로 분리. 마켓플레이스 또는 `--plugin-dir`로 설치
- **스킬 포함** — `/register`, `/peers`, `/send` 슬래시 커맨드 내장

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

## 피어 사용자 가이드

### 요구사항

- [Bun](https://bun.sh) — `curl -fsSL https://bun.sh/install | bash`
- [Claude Code](https://claude.ai/code) v2.1.80+
- claude.ai 로그인 (채널은 API key 인증 불가)

### 마켓플레이스 설치

```
/plugin marketplace add nice1st/claude-peers-mcp
/plugin install claude-peers
```

### broker URL 설정

쉘 프로필(`~/.zshrc`, `~/.bashrc` 등)에 추가:

```bash
export CLAUDE_PEERS_BROKER_URL=http://<broker-host>:7899
```

localhost broker를 사용하면 생략 가능.

### 세션 시작

```bash
claude --dangerously-load-development-channels plugin:claude-peers@claude-peers-mcp
```

### 등록 및 사용

```
/register planner                             # 피어 등록
/peers                                        # 피어 목록 조회
/send worker "API 변경사항 리뷰해줘"            # 메시지 전송
```

작업 종료 시 `unregister` 호출.

### plugin-dir 방식 (개발용)

마켓플레이스 없이 직접 로드:

```bash
git clone https://github.com/nice1st/claude-peers-mcp.git ~/claude-peers-mcp
```

```bash
CLAUDE_PEERS_BROKER_URL=http://<broker-host>:7899 claude --plugin-dir ~/claude-peers-mcp/plugin --dangerously-load-development-channels server:plugin:claude-peers:claude-peers
```

## 브로커 운영 가이드

broker는 피어 간 메시지를 중계하는 HTTP 서버. 누군가 실행해야 함.

```bash
git clone https://github.com/nice1st/claude-peers-mcp.git ~/claude-peers-mcp
cd ~/claude-peers-mcp
bun install
bun broker.ts
```

`0.0.0.0:7899`에 바인딩. 방화벽에서 7899 포트 개방 필요. 60초간 heartbeat 없는 피어는 자동 제거.

특정 인터페이스에 바인딩:

```bash
CLAUDE_PEERS_HOST=192.168.1.100 bun broker.ts
```

### CLI

```bash
bun cli.ts status            # 브로커 상태 + 피어 목록
bun cli.ts peers             # 피어 목록
bun cli.ts send <id> <msg>   # 메시지 전송
bun cli.ts kill-broker       # 브로커 종료

# 리모트 브로커 조회
CLAUDE_PEERS_BROKER_URL=http://remote:7899 bun cli.ts status
```

## 도구 및 스킬

| 도구 | 설명 |
|------|------|
| `register` | broker에 alias로 등록, 폴링/heartbeat 시작 (**먼저 호출**) |
| `unregister` | 등록 해제, 폴링/heartbeat 중지 |
| `list_peers` | 다른 Claude Code 인스턴스 조회 (scope: machine/directory/repo) |
| `send_message` | ID로 다른 인스턴스에 메시지 전송 |
| `set_summary` | 작업 요약 설정 (다른 피어에게 표시) |
| `check_messages` | 수동 메시지 확인 (폴백) |

| 스킬 | 사용법 |
|------|--------|
| `/register` | `/register planner` |
| `/peers` | `/peers` |
| `/send` | `/send worker 리뷰해줘` |

## 동작 원리

**broker**가 SQLite DB와 함께 실행. 각 Claude Code 세션의 MCP 서버가 broker에 HTTP로 통신. `register` 호출 시 alias가 피어 ID가 됨 (세션 간 재사용 가능). MCP 서버가 1초마다 broker를 폴링하고, 수신 메시지를 [claude/channel](https://code.claude.com/docs/en/channels-reference) 프로토콜로 Claude에 즉시 push.

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

## 환경변수

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `CLAUDE_PEERS_BROKER_URL` | — | broker URL (예: http://remote:7899) |
| `CLAUDE_PEERS_PORT` | `7899` | broker 포트 (BROKER_URL 미설정 시 사용) |
| `CLAUDE_PEERS_HOST` | `0.0.0.0` | broker 바인딩 주소 |
| `CLAUDE_PEERS_DB` | `~/.claude-peers.db` | SQLite DB 경로 |
| `CLAUDE_PEERS_STALE_TIMEOUT` | `60000` | 피어 stale 타임아웃 (ms) |

---

원본: [louislva/claude-peers-mcp](https://github.com/louislva/claude-peers-mcp)
