---
name: groups
description: claude-peers 그룹 조회 또는 가입
---

입력: $ARGUMENTS

입력이 비어있으면 `list_groups` 도구를 호출해 활성 그룹과 인원수를 보여줘.

입력에 그룹 이름이 하나 이상 있으면 (공백/콤마로 구분) `set_groups` 도구를 호출해 해당 그룹들로 멤버십을 교체해.
파라미터: groups = 입력에서 분리한 그룹 이름 배열

예시:
- `/groups` → 전체 그룹 조회
- `/groups be fe` → set_groups(["be", "fe"])
- `/groups lobby` → lobby로 복귀
