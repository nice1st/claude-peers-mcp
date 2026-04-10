---
name: register
description: claude-peers 네트워크에 alias로 등록
---

입력: $ARGUMENTS

입력이 비어있으면 "사용법: /register <alias> (예: /register planner)" 를 출력하고 종료해.

입력을 alias로 사용하여 claude-peers MCP 서버의 `register` 도구를 호출해.
파라미터: alias = 입력값

등록 성공하면 `set_summary` 도구로 현재 작업 내용을 설정해.
