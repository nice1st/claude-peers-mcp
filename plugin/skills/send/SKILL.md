---
name: send
description: claude-peers 네트워크의 특정 세션에 메시지 전송
---

입력: $ARGUMENTS

입력이 비어있으면 "사용법: /send <peer-id> <메시지>" 를 출력하고 종료해.

입력에서 첫 번째 단어를 peer ID로, 나머지를 메시지로 분리해서
claude-peers MCP 서버의 `send_message` 도구를 호출해.
파라미터:
- to_id: 첫 번째 단어 (peer ID)
- message: 나머지 전부 (메시지 내용)
