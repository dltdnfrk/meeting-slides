# Meeting Slides — 제품 명세서

```yaml
schema_version: 1
doc_id: meeting-slides-product-spec-001
project: meeting-slides
status: draft
owner: hyunjun (human-approval-required)
baseline_commit: 921a01513593c0e10181cf01e535a7abe995deb3
class: new
supersedes: none
created_at: 2026-08-01
source_interview: interview_20260801_055926
source_seed: seed_071561354244
governance_standard: MUNI/Ouroboros/documentation-governance (2026-08-01 확정)
```

> **상태 안내**: 이 문서는 `draft`다. 작업트리에 미커밋 변경 18건이 있으므로
> 실행 전 별도 세션에서 G0/G1 확인이 필요하다. 이 문서는 기존 구현을 변경하지 않는다.

---

## 1. 존재 이유

회의 중에 **보고서 퀄리티의 자료를 즉각 생성**해서, 회의가 끝난 뒤
**회의록을 따로 만드는 노동을 없애는 것.**

현재 구현된 실시간 슬라이드 생성은 그 목표의 전반부다.
보고서 퀄리티 확보와 산출물 전달이 남은 격차다.

## 2. 대상 사용자와 사용 맥락

- 사용자: 회의 참석자·발표자 본인.
- 용도: 연구 목적 및 제품 R&D. 외부 판매 대상이 아니다.
- 전달 형태: 로컬 웹앱. 서버는 localhost만 바인드하고 WebSocket 업그레이드 시
  Origin을 검사한다.
- 품질 기준: 상용화 수준 그 이상.
- **포트폴리오 연결**: 산출물이 MUNI CRM의 회의 분석 입력이 된다.

## 3. 현재 상태와 목표 상태

**현재**: Bun 런타임. 마이크·오디오 파일 → whisper.cpp 한국어 전사 → 필터링 →
MeetingSession(200ms 디바운스 자막 + N문장마다 LLM 주제 전환 감지, 연속 2회 히스테리시스)
→ WebSocket으로 슬라이드·자막·히스토리 push. LLM 장애 시 로컬 규칙 폴백.
내보내기는 reveal.js 덱 HTML과 개별 standalone 슬라이드.

**실측 확인**: whisper의 tinydiarize로 화자 **전환 감지**는 있으나
소스 주석이 명시하듯 **화자 식별이 아니며 턴 번호가 드리프트**할 수 있다.

**목표**: 회의가 끝나면 검토 몇 분으로 회의록이 완결되는 상태.

## 4. 범위와 비범위

### 범위

1. 회의 메타데이터(참석자 지정 포함)
2. 결정 사항·액션 아이템·미결 사항의 후보 추출과 검토 확정
3. 회의 번들 생성 — 회의록 PDF + 기계용 JSON + 원본
4. 항목 단위 화자 귀속

### 비범위

- **이메일 발송 기능 내장.** 상용급 기준을 적용하면 발송 서버 설정·인증·실패 처리·
  재시도·전달 확인까지 모두 상용급이어야 하는데 로컬 웹앱에서 그 비용을 치를 이유가 약하다
- **CRM 데이터베이스 직접 쓰기.** 두 프로젝트는 별개 저장소이며 결합도가 지나치다
- **전사 전체의 화자 식별.** 임베딩 기반 화자 분리 도입은 현재 목표 대비 비용이 맞지 않는다
- 회의 중 실시간 화자 라벨링
- 판매용 상용 기능

## 5. 확정된 결정

### D1. 슬라이드와 회의록은 형제 산출물

슬라이드에 요소를 추가하는 문제가 아니다. 슬라이드는 회의 중 **지금 무슨 이야기를
하는가**를 보여주는 실시간 표면이고, 회의록은 회의가 끝나고 **무엇이 남았는가**를
담는 사후 산출물이다. 목적도 독자도 시점도 다르다. 결정과 액션을 실시간 슬라이드에
억지로 넣으면 슬라이드는 진행용으로 나빠지고 회의록으로도 부족해진다.
**같은 세션 데이터에서 두 번째 산출물을 생성한다.**

### D2. 회의록에만 필요한 6요소

1. 회의 메타데이터(일시·참석자·목적·안건·진행 시간)
2. **결정 사항** — 회의록의 존재 이유이며 지금 완전히 없다
3. **액션 아이템** — 담당자와 기한이 붙어야 의미가 있다
4. 미결 사항과 다음 안건 — 없으면 같은 논의가 반복된다
5. 발언 귀속 — 액션 아이템의 담당자 지정에 필수
6. 언급된 참조 자료

현재 슬라이드가 담는 것은 주제별 요약과 전사 원문뿐이며, 위 6가지 중 어느 것도
구조화된 형태로는 없다.

### D3. 근거 없는 항목은 생성하지 않는다

결정·액션·미결은 LLM이 후보로 추출하되 **각 항목은 전사의 어느 구간에서 나왔는지를
가리켜야 한다.** 근거 구간을 제시할 수 없는 항목은 생성하지 않는다.
이것이 없으면 회의에서 실제로 나오지 않은 결정이 회의록에 남고,
회의록은 신뢰할 수 없는 문서가 된다.

### D4. 노동 제거 = 검토만 하면 되는 상태

목표는 완전 자동 생성이 아니다. 완전 자동은 틀린 결정이 섞여도 알 수 없어 신뢰할 수 없고,
완전 수동은 없애려던 노동이 그대로 남는다. **회의 중 후보를 누적해 두었다가 종료 시점에
검토 화면을 띄운다.** 이 검토가 몇 분 안에 끝나면 회의록 노동은 실질적으로 사라진다.

### D5. 참석자 지정이 열쇠

회의 시작 시 참석자를 지정한다. 이유가 셋이다.
① 회의록 메타데이터가 채워진다
② **화자 후보 집합이 한정되어 화자 식별 문제가 크게 쉬워진다.** 전환 감지만 되는
현재 상태에서도 후보가 3명이면 몇 번의 라벨로 귀속이 가능하다
③ 참석자를 CRM의 사람 엔터티에서 선택하면 산출물에 이미 사람 식별자가 붙어 나오므로
CRM의 사람 기준 정리가 추가 매칭 없이 성립한다

### D6. 산출물은 회의 번들 — 목적지가 둘이다

하나의 형식으로 둘 다 만족시키려 하면 둘 다 나빠진다.

1. **사람용 회의록 PDF** — 전달·보관이 확실하고 레이아웃이 고정된다.
   슬라이드 덱(가로형 발표물)과 다른 세로형 문서이며 둘 다 남긴다
2. **기계용 JSON** — 참석자 식별자, 결정, 액션(담당자·기한), 미결, 발언 귀속,
   각 항목의 근거 구간 참조. **CRM으로 넘어가는 실체**
3. **원본** — 전사 원문과 오디오 참조. 추출 결과의 근거이므로 보존

**회의록 PDF의 구조 = 보고서 퀄리티의 실질적 기준**:
**첫 페이지가 결정 사항과 액션 아이템만으로 완결**되어야 한다.
첫 장만 읽어도 무엇이 정해졌고 누가 무엇을 하는지 알 수 있어야 한다.
논의 요약·발언 귀속·전사 원문은 뒤에 붙는 부록이다.
**강제하는 것은 분량이 아니라 이 구조다.**

### D7. CRM 연결은 업로드로 — 경계를 지킨다

CRM이 이미 업로드 기반 인제스트 파이프라인을 갖기로 확정했으므로,
번들을 CRM에 업로드하는 흐름이면 충분하다. 별도 통합 API가 필요 없고
양쪽 프로젝트 경계가 그대로 유지된다.

### D8. 화자 라벨링은 항목 단위로만

실시간 라벨링은 배제한다. 사용자는 회의에 참여 중인 당사자이며,
라벨링은 회의 진행을 방해해 **이 제품의 존재 이유에 정면으로 반한다.**

사후 전체 라벨링도 답이 아니다. 없애려던 노동을 다른 형태로 되살린다.

**목표에서 역산한 해법**: 회의록이 요구하는 것은 각 문장을 누가 말했는가가 아니라
**누가 무엇을 하기로 했는가**다. 따라서 라벨링 대상을 전사 전체가 아니라
**추출된 항목**으로 한정한다. 검토 화면에서 각 항목의 담당자·발언자를
참석자 명단에서 선택한다(자유 입력이 아닌 드롭다운). 항목이 5~10개면 수십 초다.

전사 전체의 화자 귀속은 부가 기능으로 두되, **데이터 모델은 발화 단위 귀속을
나중에 담을 수 있게 설계**한다. CRM이 특정 사람과의 대화 이력을 볼 때 필요해질 수 있다.

### D9. 전사 엔진 — 공용 라이브러리를 만들지 않는다

whisper.cpp는 시스템에 설치된 외부 실행 파일이고 모델도 공유 가능하다.
두 프로젝트가 각각 호출하는 것은 중복이 아니라 **이미 공유하고 있는 상태**이며,
각자 갖는 것은 얇은 래퍼뿐이다. 공용 모듈을 만들면 저장소 간 의존성·버전 동기화·
경계 붕괴 비용이 이득보다 크다.

**진짜 요구사항은 전사 결과의 정본성이다.**
같은 녹음을 두 곳에서 전사하면 결과가 미세하게 달라질 수 있고,
그러면 회의록의 근거 구간과 CRM의 근거 구간이 어긋나 근거 링크 원칙이 깨진다.

1. 전사 결과는 한 번 생성되면 **그것이 정본**이다. 번들에 전사가 있으면 CRM은
   재전사하지 않는다. 원본 오디오만 들어온 경우에만 CRM이 전사한다
2. 근거 구간 참조는 전사 정본의 좌표로 표현되며 양쪽이 같은 좌표를 가리킨다
3. 재전사가 필요하면 덮어쓰지 않고 **새 버전**으로 남긴다
4. 같은 회의가 두 경로로 들어오면 CRM이 원본 해시로 감지한다

## 6. 수락기준

| ID | 수락기준 | verification_method |
|---|---|---|
| AC-01 | 회의 시작 시 참석자를 지정할 수 있고, 지정된 참석자가 회의록 메타데이터와 화자 후보 집합과 항목 담당자 드롭다운의 원천이 된다 | `automated_test` |
| AC-02 | 결정·액션·미결 후보가 전사에서 추출되며, 각 항목이 전사 구간을 근거로 가리킨다. 근거를 제시할 수 없는 항목은 생성되지 않는다 | `automated_test` |
| AC-03 | 회의 종료 시 검토 화면이 후보를 제시하고, 사용자가 확인·수정·확정하며, 각 항목의 담당자·발언자를 참석자 명단에서 선택할 수 있다 | `manual_review` |
| AC-04 | 회의 번들이 생성된다 — 회의록 PDF(첫 페이지가 결정·액션만으로 완결), 기계용 JSON, 원본(전사·오디오) 참조. 슬라이드 덱도 함께 남는다 | `artifact_inspection` |
| AC-05 | 전사 결과가 정본으로 보존되고 근거 구간 좌표가 회의록과 JSON에서 일치한다. 재전사 시 기존 전사를 덮어쓰지 않고 새 버전으로 남긴다 | `automated_test` |
| AC-06 | 회의 종결 판정: 사람이 후보를 검토해 확정했고, 두 산출물과 원본이 생성됐고, 원본과 산출물의 연결이 기록된 상태 | `manual_review` + `artifact_inspection` |

**공통 증거 요구 4속성**: `target_commit`, 불변 `evidence_ref`, `verified_by`, `verified_at`.
`manual_review`는 자동화 불가 사유와 `expires_at` 추가.

> **회의 종결의 정의**: 파일이 생성됐다고 종결이 아니다.
> CRM 전달은 선택 단계이며 종결 조건에 넣지 않는다 — 모든 회의가 영업 맥락은 아니다.

## 7. 미결정 사항

1. CRM으로 넘기는 JSON의 구체적 필드 스키마
2. 녹음 원본의 보존 기간
3. 회의 중 발언자 지정 버튼 같은 선택적 장치 — 초기 범위 제외, 나중에 재검토

## 8. 관련 문서와 추적

- 인터뷰: `interview_20260801_055926` (제품 요구사항, ambiguity 0.147)
- 인터뷰: `interview_20260801_022007` (미추적 변경 보존·정리, ambiguity 0.074)
- Seed: `seed_071561354244`
- 포트폴리오: `MUNI/Ouroboros/documentation-governance/PRODUCT_DEFINITIONS_DRAFT.md`

**작업트리 주의**: 미커밋 변경 18건이 있다. transcript overlay 작업은 실행 ledger 기준
완료되었고 QA 3개 레인이 통과했으나 커밋되지 않았다(HEAD 921a0151 스탬프).
정리 절차는 `interview_20260801_022007`에서 확정한 귀속 3등급·서명 게이트를 따른다.

## 9. 다음 단계

1. 미커밋 변경 정리(별도 절차, 서명 게이트)
2. 이 문서의 `canonical` 승격 — 사람 승인 + G0/G1
3. **PDF 산출물 전달이 핵심 경로**다 — 후보 작업이 아니라 목표 달성의 필수 요소

## 커밋 지침 — 경로를 명시해서 스테이징할 것

이 문서와 `docs/ouroboros-seed.yaml`은 2026-08-01에 생성된 **미추적 신규 파일**이다.
Git 명령은 실행하지 않았으므로 커밋 여부는 이 프로젝트 세션에서 결정한다.

**반드시 경로를 명시해서 스테이징한다:**

```bash
git add docs/PRODUCT_SPEC.md docs/ouroboros-seed.yaml
```

**`git add -A`, `git add .`, `git add docs/`를 쓰지 않는다.**
현재 이 저장소의 작업트리 상태는 10개 수정, 8개 미추적이며, `docs/` 안에 다른 미추적 항목 1개가 있다.
일괄 스테이징하면 소유자와 완료 상태가 확인되지 않은 기존 변경까지 함께 커밋되어,
2026-08-01에 확정한 귀속·서명 게이트를 건너뛰게 된다.

기존 미커밋 변경의 처리 절차는 별도로 확정되어 있다 — 귀속 3등급
(ledger 지목 / 증거 2개 수렴 추론 / ownership-unknown), 등급별 허용 행위,
동일 세션 묶음 일괄 서명과 개별 서명 예외. 상세는
`MUNI/Ouroboros/documentation-governance/SESSION_HANDOFF.md` 참조.

---

## 부록 A — Ouroboros Seed

```yaml
goal: From a real-time meeting session, generate a report-quality meeting minutes
  PDF and a CRM-ready structured data bundle through an AI-propose / human-confirm
  review workflow, eliminating post-meeting minute-writing labor to a few minutes
  of candidate review.
task_type: code
brownfield_context:
  project_type: brownfield
  context_references:
  - path: /Users/hyunjun/Documents/MUNI/meeting-slides
    role: primary
    summary: Existing Meeting Slides codebase with Bun runtime, whisper.cpp real-time
      transcription with tinydiarize turn markers, LLM topic-block detection with
      hysteresis, WebSocket push to browser, reveal.js slide deck and standalone HTML
      export, shared theme stylesheet, and LLM-failure local-rule-based fallback
  existing_patterns:
  - LLM extraction with local rule-based fallback on LLM failure
  - WebSocket push to browser for real-time subtitle and slide updates
  - Hysteresis-based topic block transition requiring two consecutive LLM judgments
  - Shared theme stylesheet for standalone document rendering
  - Origin-checked WebSocket upgrade on localhost-only binding
  - 200ms debounced subtitle display
  - reveal.js deck HTML and standalone slide file export with co-located theme CSS
  existing_dependencies:
  - Bun
  - whisper.cpp with tinydiarize
  - reveal.js
  - WebSocket
  - Shared theme stylesheet
constraints:
- Runtime is Bun; local web app binding localhost only with Origin-checked WebSocket
- Each extracted item (decision, action item, open issue) must reference its source
  transcript segment; items without a verifiable source segment are never generated
- No real-time speaker labeling; all attribution is post-meeting review via dropdown
  from pre-registered attendee list
- Speaker attribution scope is item-level (decisions and action items), not utterance-level;
  data model must accommodate future utterance-level extension without schema migration
- Meeting Slides never writes to CRM database; handoff is an exportable bundle ingested
  through CRM's existing upload pipeline
- Transcript is canonical once generated; downstream consumers (including CRM) must
  not re-transcribe when a canonical transcript is present in the bundle
- No email sending, no shared code library with CRM, no direct CRM integration API,
  no real-time labeling buttons in initial scope
- Commercial-grade robustness, data integrity, security, privacy, failure handling,
  UX, and performance; no multi-tenancy, billing, or marketing features
- Slide deck (landscape, real-time presentation) and meeting minutes (portrait, post-meeting
  document) are sibling artifacts from the same session data — never merged into one
acceptance_criteria:
- description: User registers attendees at meeting start from a known set; attendee
    list populates meeting metadata and constrains all subsequent speaker-attribution
    selections to a closed candidate set
  semantic_ac_key: ac_3fc90ec2184992de
- description: At meeting end, a review screen presents LLM-extracted decision, action-item,
    and open-item candidates each linked to its source transcript segment; user confirms,
    edits, assigns attendees via dropdown, and finalizes within minutes
  semantic_ac_key: ac_2939e14bffab74b0
- description: After review confirmation, a portrait-layout meeting minutes PDF is
    generated where the first page is self-contained with all decisions and action
    items; discussion summary, speaker attributions, referenced materials, and transcript
    appendix follow on subsequent pages
  semantic_ac_key: ac_90e049b42573fcc3
- description: An atomic meeting bundle is exported containing the minutes PDF, a
    structured JSON file (attendee identifiers, decisions, action items with assignee
    and deadline, open items, and source transcript coordinate references), and the
    raw canonical transcript; the JSON is consumable by CRM's upload-based ingest
    pipeline without re-transcription
  semantic_ac_key: ac_17d4aaae6ebbea50
ontology_schema:
  name: MeetingSession
  description: A meeting session from attendee registration through real-time transcription
    to post-meeting review confirmation and artifact export
  fields:
  - name: session_id
    type: string
    description: Unique meeting session identifier
    required: true
  - name: meeting_date
    type: string
    description: ISO 8601 datetime of the meeting
    required: true
  - name: attendees
    type: array
    description: Registered attendees with display name and optional CRM person entity
      ID
    required: true
  - name: purpose
    type: string
    description: Meeting purpose and agenda items
    required: true
  - name: duration_seconds
    type: number
    description: Total meeting duration in seconds
    required: true
  - name: transcript
    type: object
    description: Canonical transcription containing timestamped segments with speaker-turn
      markers
    required: true
  - name: decisions
    type: array
    description: Confirmed decision items each with description, source segment reference,
      and attribution
    required: true
  - name: action_items
    type: array
    description: Confirmed action items each with description, assignee attendee reference,
      deadline, and source segment reference
    required: true
  - name: open_items
    type: array
    description: Unresolved items carried to next meeting with description and source
      segment reference
    required: true
  - name: referenced_materials
    type: array
    description: Documents, figures, links, or data mentioned during the meeting
    required: true
  - name: review_status
    type: string
    description: Review workflow state — draft or confirmed
    required: true
  - name: artifacts
    type: object
    description: Generated output paths for PDF, JSON, transcript, and slide deck
    required: true
evaluation_principles:
- name: source_traceability
  description: Every extracted decision, action item, and open item links to a specific
    transcript segment; items without verifiable provenance are excluded
  weight: 0.3
- name: review_efficiency
  description: Post-meeting review reduces minute-writing labor to a few minutes of
    candidate confirmation, not manual reconstruction
  weight: 0.25
- name: first_page_completeness
  description: PDF first page contains all decisions and action items without requiring
    the reader to turn pages for the executive summary
  weight: 0.2
- name: crm_interoperability
  description: JSON bundle is directly consumable by CRM ingest pipeline with attendee
    identifiers and canonical transcript coordinates
  weight: 0.15
- name: attribution_accuracy
  description: Item-level speaker and assignee attribution is correct after human
    review against the closed attendee set
  weight: 0.1
exit_conditions:
- name: meeting_concluded
  description: All review and generation steps are complete
  criteria: Review status is confirmed, minutes PDF and structured JSON and canonical
    transcript all exist, every extracted item has a source segment reference, and
    the slide deck is preserved as a sibling artifact
- name: bundle_exportable
  description: Meeting bundle is ready for external consumption or CRM upload
  criteria: PDF, JSON, and canonical transcript are co-located in a single atomic
    bundle directory
- name: review_cancelled
  description: User abandons review without confirming
  criteria: Extracted candidates and transcript are preserved for later review but
    no final minutes PDF or JSON is generated; session is not marked concluded
metadata:
  seed_id: seed_071561354244
  version: 1.0.0
  created_at: '2026-08-01T07:03:09.286760Z'
  ambiguity_score: 0.147
  interview_id: interview_20260801_055926
  parent_seed_id: null
  generation_mode: normal
  degraded: false
  unresolved_slots: []
  recovery_reason: null```
