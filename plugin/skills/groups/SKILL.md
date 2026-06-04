---
name: groups
description: claude-peers 그룹 조회 또는 가입
---

입력: $ARGUMENTS

입력이 비어있으면 `list_groups` 도구를 호출해 활성 그룹과 인원수를 보여줘.

입력에 그룹 이름이 하나 이상 있으면 (공백/콤마로 구분) `set_groups` 도구를 호출해 해당 그룹들로 멤버십을 교체해.
파라미터: groups = 입력에서 분리한 그룹 이름 배열

`set_groups`는 기존 그룹을 전부 교체하므로, 머신 그룹(같은 머신 세션 발견용)을 유지하려면 함께 넣어야 해. 머신 그룹 이름은 `list_peers`/`list_groups`로 확인.

예시:
- `/groups` → 전체 그룹 조회
- `/groups be fe` → set_groups(["be", "fe"]) (머신 그룹에서 나감)
- `/groups my-machine shared` → 머신 그룹 유지하며 shared 합류
