# 8단계: 리뷰어용 인라인 코멘트 작성 (`references/pr-template.md` 참조)

**목적**: 리뷰어가 변경 맥락을 빠르게 이해하도록 설명을 덧붙인다.
**진입 게이트**: `verify.sh <이슈키> 3_delivery.review` — **전제조건만** 검사한다 (Draft PR 생성 완료, body_validation 3항목, reviewer 마커, HITL 승인). 인라인 코멘트 개수·앵커 여부는 본 단계의 **완료 조건**이므로 진입 게이트가 아니라 §완료 후 검증(`verify.sh 3_delivery.review_post`)에서 확인한다.

## 0-pre. skill_mcp 사전 로드 (필수 — 반복 실수 방지)

이 stage 는 `bitbucket_getPullRequestChanges` / `bitbucket_getPullRequestDiff` / `bitbucket_postPullRequestComment` / `bitbucket_getPR_CommentsAndAction` 등 `repos` MCP 툴을 반복 호출한다. `skill_mcp` 는 lazy-load 이므로 **첫 호출 이전에** `skill(name="bitbucket-research")` 를 먼저 로드하지 않으면 opencode 가 `MCP server "repos" not found` 로 튕긴다. 플러그인 훅이 정확한 skill 이름을 안내로 붙여주지만 한 번의 호출을 낭비하는 실수다.

| mcp_name | 반드시 먼저 로드할 skill |
|---|---|
| `repos` | `bitbucket-research` |

로드 순서: `skill(name="bitbucket-research")` → 이후 `skill_mcp(mcp_name="repos", ...)` 자유롭게 호출.

## 8-1. 커밋 단위 diff 분석 (계획 단계의 입력)

7단계 PR 의 각 커밋별 diff 를 가져와 **설명이 필요한 지점**을 식별한다.
- 비자명한 결정(왜 A 대신 B), 도메인 지식 필요부, 성능·보안·동시성 고려, 외부 의존성 상호작용, 미해결 TODO.

> `<SCRIPTS_DIR>`는 부장님이 dispatch_stage 프롬프트로 주입한 절대경로다. 이 값을 그대로 대입하여 실행한다.

```bash
BASE=$(bash <SCRIPTS_DIR>/state.sh get <이슈키> '.stages."3_delivery".substages."commit".base_sha' | tr -d '"')
HEAD=$(bash <SCRIPTS_DIR>/state.sh get <이슈키> '.stages."3_delivery".substages."commit".head_sha' | tr -d '"')
WT=$(bash <SCRIPTS_DIR>/state.sh get <이슈키> '.worktree' | tr -d '"')
git -C "$WT" rev-list "$BASE..$HEAD"   # 커밋 SHA 순차 목록 (계획 단계에 사용)
```

## 8-2. 계획 단계 — `review-comment-plan.json` 사전 산출 (LLM 사전 설계 · 필수)

**⚠️ 핵심 규약**: 커밋 단위 atomic 원칙에 맞춰 **커밋 1개당 인라인 코멘트 최소 1개** 를 작성한다. 계획 단계에서 이를 담보하지 못하면 실행 단계로 진입하지 않는다.

publisher 는 인라인 코멘트를 곧바로 posting 하기 전, 각 커밋별로 어디에 어떤 코멘트를 남길지 **먼저 계획**을 세우고 아티팩트 파일로 저장한다:

**저장 위치**:
- 물리 파일 (publisher 는 worktree cwd 실행): `<worktree>/.makdoong2-team/<이슈키>/review-comment-plan.json`
- state.json 에 기록할 상대경로: `.makdoong2-team/<이슈키>/review-comment-plan.json`

**스키마**:

```json
{
  "base_sha": "e860a1ec",
  "head_sha": "502a7387",
  "commit_count": 19,
  "plan": [
    {
      "commit_sha": "abc1234...",
      "commit_subject": "Feat: PROJ-123 - 요약",
      "changed_file": "todo/cli.py",
      "comments": [
        {
          "anchor": {"filePath": "todo/cli.py", "line": 42, "lineType": "ADDED"},
          "text_plan": "여기서 argparse 서브명령 라우팅을 선택한 이유는 ...",
          "category": "design_decision",
          "status": "pending",
          "comment_id": null
        }
      ]
    }
    /* ... 나머지 커밋 (총 commit_count 개) ... */
  ]
}
```

**`status` 필드 값**:

| 값 | 의미 |
|---|---|
| `"pending"` | 아직 posting 안 됨 (초기값) |
| `"posted"` | Bitbucket에 posting 성공 |
| `"failed"` | posting 시도했으나 실패 |

**`comment_id` 필드**: posting 성공 후 Bitbucket 응답에서 받은 comment ID. 재조회·삭제 시 활용.

**계획 산출 절차**:

1. `bitbucket_getPullRequestChanges` 로 변경 파일 목록 파악, `bitbucket_getPullRequestDiff` 로 파일별 diff·라인 번호 확보.
2. `git rev-list "$BASE..$HEAD"` 로 얻은 각 커밋별로 diff 를 분석하여 §8-1 기준에 해당하는 지점을 최소 1개 이상 뽑는다.
3. 커밋의 변경 파일이 자명하고 설명거리가 정말 없다면, 그 커밋이 **왜 필요한지 / 어떤 변경 원칙을 따랐는지** 를 설명하는 코멘트라도 반드시 1개 이상 계획한다. 스킵 금지.
4. 위 스키마를 만족하는 JSON 을 Write 툴로 저장.
5. `.plan_path` 마커 기록 — **반드시 상대경로만 저장한다** (절대경로 저장 시 다른 cwd 에서 gate·verifier 가 파일 존재 검증 시 hang 유발 가능):
   ```bash
   bash <SCRIPTS_DIR>/state.sh set <이슈키> \
     '.stages."3_delivery".substages."review".plan_path' \
     '".makdoong2-team/<이슈키>/review-comment-plan.json"'
   ```

**자체 검증** (계획 저장 직후) — 상대경로를 `state.sh root()` 로 절대경로 해석하여 안전하게 접근:

```bash
# 상대경로 저장 원칙에 따라 root() 기반 해석
PLAN_REL=$(bash <SCRIPTS_DIR>/state.sh get <이슈키> \
  '.stages."3_delivery".substages."review".plan_path' | tr -d '"')
ROOT=$(bash <SCRIPTS_DIR>/state.sh root)
if [[ "$PLAN_REL" == /* ]]; then
  # legacy 절대경로 수용 (마이그레이션 스니펫이 다음 dispatch_stage 재진입 시 정규화)
  PLAN="$PLAN_REL"
else
  PLAN="$ROOT/$PLAN_REL"
fi

CC=$(bash <SCRIPTS_DIR>/state.sh get <이슈키> \
  '.stages."3_delivery".substages."commit".atomic_review.count_commits')
PLAN_CC=$(jq '.commit_count' "$PLAN")
[ "$CC" = "$PLAN_CC" ] || { echo "commit_count 불일치: state=$CC plan=$PLAN_CC"; exit 1; }
UNDER=$(jq '[.plan[] | select((.comments | length) < 1)] | length' "$PLAN")
[ "$UNDER" = "0" ] || { echo "커밋 $UNDER 개에 계획된 코멘트가 0개 — 재계획 필요"; exit 1; }
```

하나라도 실패하면 §8-2 로 복귀해 계획을 재작성한다. 계획 없이 §8-3 로 진입 금지.

## 8-3. 실행 단계 — 인라인 코멘트 posting

계획대로 `bitbucket_postPullRequestComment` 를 호출한다.

### 8-3-0. 기존 posting 상태 확인 (재진입 중복 방지 · 필수)

**⚠️ 재진입 방어**: review substage 에 재진입(REJECTED 재작업, 세션 resume)하는 경우 plan.json 각 comment 의 **`status` 필드**를 우선 확인해 이미 posting 완료된 코멘트를 skip 한다. 이 단계를 건너뛰면 동일 위치에 동일 코멘트가 중복 게시된다.

**plan.json status 기반 skip 규칙** (posting 루프 내부에서 comment 단위로 적용):

| `comment.status` 값 | 처리 |
|---|---|
| `"posted"` | ✅ 이미 완료 → **skip** (posting 없음) |
| `"pending"` | ▶️ posting 진행 |
| `"failed"` | ▶️ 재시도 (posting 진행) |

```bash
# plan.json 로드 및 미완료 코멘트 추출
PLAN_PATH="<plan.json 절대경로>"  # §8-2에서 기록한 plan_path 마커로 해석
PENDING_COUNT=$(jq '[.plan[].comments[] | select(.status != "posted")] | length' "$PLAN_PATH")
echo "미완료 코멘트: $PENDING_COUNT 개"
```

- `PENDING_COUNT == 0` → 전량 posting 완료. §8-4 로 직행.
- `PENDING_COUNT > 0` → 미완료 코멘트만 §8-3-1 로 진행.

> **보조 확인**: `comments_per_commit` 마커도 동시에 확인해 두 source 간 불일치 감지 가능. 불일치 시 plan.json status 를 **진실의 원천(source of truth)**으로 사용한다.

### 8-3-1. 인라인 코멘트 필수 파라미터 (엄수)

`bitbucket_postPullRequestComment` 호출 시 다음 3개를 **반드시** 함께 전달한다. 하나라도 누락 시 코멘트는 top-level 대화로 저장되어 인라인 목적을 상실한다.

| 파라미터 | 값 | 설명 |
|---|---|---|
| `filePath` | 코멘트 대상 파일 경로 | 예: `src/cache/ProductCache.scala`. 빈 값·생략 금지 |
| `line` | 앵커 라인 번호 | diff 상의 실제 라인. 여러 라인 범위면 마지막 라인 |
| `lineType` | `ADDED` \| `REMOVED` \| `CONTEXT` | 신규/수정은 `ADDED`, 삭제는 `REMOVED`, 문맥은 `CONTEXT` |
| `startLine` | 선택 | 다중 라인 범위의 시작 라인 |
| `startLineType` | 선택 | `startLine` 의 라인 타입 |

톤은 자연어·일상어 중심, 전문 용어는 그대로, 필요 시 마크다운.

**❌ 금지 (top-level 저장됨)**:
```json
{"projectKey": "...", "repositorySlug": "...", "pullRequestId": "...", "text": "..."}
```

**✅ 필수 (파일+라인 앵커)**:
```json
{"projectKey": "...", "repositorySlug": "...", "pullRequestId": "...",
 "text": "...", "filePath": "conf/application.conf", "line": 42, "lineType": "ADDED"}
```

각 코멘트 posting 직후 응답의 `anchor` 또는 `commentAnchor` 필드가 `filePath`·`line` 을 포함하는지 확인한다. 앵커가 없다면 top-level 저장이므로 즉시 삭제 또는 재작성.

### 8-3-2. posting 성공 후 plan.json 상태 갱신 + per-commit 집계 (필수)

**각 comment posting 직후** 두 가지를 즉시 수행한다. 세션이 중간에 끊겨도 재진입 시 중복 게시를 막기 위해 **즉시(동기적으로)** 갱신해야 한다.

#### ① plan.json comment status 갱신 (source of truth)

posting 성공 시:
```python
# posting 응답에서 comment ID 추출
response = skill_mcp(mcp_name="repos", tool_name="postPullRequestComment", arguments={...})
comment_id = response["id"]  # Bitbucket comment ID

# plan.json의 해당 comment 업데이트
# Write 툴로 plan.json을 읽어 해당 comment의 status/comment_id 수정 후 재저장
# jq를 활용한 in-place 갱신 예시:
```
```bash
PLAN_PATH="<plan.json 절대경로>"
COMMIT_IDX=<plan.plan[] 배열에서 해당 커밋 인덱스>
COMMENT_IDX=<해당 comments[] 배열 인덱스>
COMMENT_ID=<Bitbucket 응답 comment ID>

# status → "posted", comment_id 기록
jq --argjson ci "$COMMIT_IDX" --argjson cj "$COMMENT_IDX" \
   --argjson id "$COMMENT_ID" \
   '.plan[$ci].comments[$cj].status = "posted" | .plan[$ci].comments[$cj].comment_id = $id' \
   "$PLAN_PATH" > "${PLAN_PATH}.tmp" && mv "${PLAN_PATH}.tmp" "$PLAN_PATH"
```

posting 실패 시:
```bash
jq --argjson ci "$COMMIT_IDX" --argjson cj "$COMMENT_IDX" \
   '.plan[$ci].comments[$cj].status = "failed"' \
   "$PLAN_PATH" > "${PLAN_PATH}.tmp" && mv "${PLAN_PATH}.tmp" "$PLAN_PATH"
```

#### ② per-commit 집계 마커 갱신 (state.json)

plan.json 갱신 후 `comments_per_commit` 매핑도 최신 상태로 재집계한다. 규칙: **모든 커밋 SHA 가 키로 존재해야 하고 값은 모두 >= 1**.

```bash
# plan.json 에서 커밋별 "posted" 개수 재집계
CPC=$(jq -r '[.plan[] | {key: .commit_sha, value: ([.comments[] | select(.status == "posted")] | length)}] | from_entries' "$PLAN_PATH")
TOTAL=$(jq -r '[.plan[].comments[] | select(.status == "posted")] | length' "$PLAN_PATH")

bash <SCRIPTS_DIR>/state.sh set <이슈키> \
  '.stages."3_delivery".substages."review".comments_per_commit' "$CPC"
bash <SCRIPTS_DIR>/state.sh set <이슈키> \
  '.stages."3_delivery".substages."review".comments' "$TOTAL"
```

## 8-4. 인라인 앵커 재검증 (자기선언 근거)

모든 posting 완료 후 `bitbucket_getPR_CommentsAndAction` 으로 PR 의 모든 코멘트를 재조회한다.

- 각 코멘트가 `anchor` 또는 `commentAnchor` 를 가지며 `filePath`·`line` 포함 → OK
- 하나라도 없으면 top-level → 삭제 또는 재작성 후 재조회 반복

전량 인라인임을 확인한 뒤에만 마커 갱신:

```bash
bash <SCRIPTS_DIR>/state.sh set <이슈키> \
  '.stages."3_delivery".substages."review".all_comments_inline' 'true'
```

## 8-5. 최종 자가 검증 (Pre-Completion Checklist)

| 항목 | 확인 |
|---|---|
| 1 | 모든 커밋의 비자명 결정 지점이 식별되었다 |
| 2 | 인라인 코멘트가 **개별 일반(live) 코멘트**로 작성되었다 (Draft 리뷰 묶음 X) |
| 3 | 성능·보안·동시성 고려 지점에 설명이 충분하다 |
| 4 | 미해결 TODO / 알려진 한계가 함께 명시되었다 |
| 5 | PR URL 과 작성한 코멘트 개수가 정확히 집계되었다 |
| 6 | **모든 코멘트가 filePath+line+lineType 을 가진 인라인 코멘트다** |
| 7 | **커밋 1개당 코멘트 >= 1** (`comments_per_commit` 의 모든 값 >= 1) |

```bash
bash <SCRIPTS_DIR>/state.sh set <이슈키> '.stages."3_delivery".substages."review".self_check' \
  '{"decision_points_identified": true, "comments_live_not_draft": true, "nonfunc_explained": true, "todos_noted": true, "metrics_accurate": true, "all_comments_inline": true, "one_comment_per_commit": true}'
```

## 8-6. 완료 후 검증 (post-verify · 필수)

publisher 는 `.done=true` 를 기록하기 **직전** 완료 조건 재검증을 실행한다.

```bash
bash <SCRIPTS_DIR>/state.sh set <이슈키> '.stages."3_delivery".substages."review".done' 'true'
bash <SCRIPTS_DIR>/../gates/stage8-post-review-verify.sh <이슈키>
```

검사 대상:
- `review-comment-plan.json` 존재 + JSON parse 성공
- `plan.commit_count == atomic_review.count_commits`
- 계획된 모든 커밋의 `comments` 배열 길이 >= 1
- `comments_per_commit` 항목 수 == `count_commits`, 모든 값 >= 1
- `comments` 총합 == `comments_per_commit` 값들의 합
- `all_comments_inline == true`
- `review.done == true`

post-verify 실패 시:
1. stderr 의 `MAKDOONG2-POSTGATE BLOCKED` 사유를 읽는다
2. 부족한 커밋에 인라인 코멘트를 추가 posting → `comments_per_commit` / `comments` 재집계
3. `.done` 을 다시 `true` 로 설정하고 post-verify 재실행
4. 통과할 때까지 반복

## 8-7. 최종 보고

PR URL, 작성 코멘트 총개수, per-commit 분포, 남은 할 일 (예: "Draft→Ready 전환은 수동 필요") 을 보고한다. 보고 후 워크플로우를 종료한다.
