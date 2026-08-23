# HANDOFF — meeting-slides (TIRO 운영자 UI 재구축 + PPT 엔진 리서치)

- 작성 시점: 2026-08-10
- 작성 세션: senpi (PI_SESSION_ID=019fe3d9-f100-77a0-9fbb-bb1e5bb32ae9)
- 목적: 다른 세션에서 이 프로젝트를 재개할 때 재조사 비용 없이 바로 이어갈 수 있게 하는 상태 스냅샷
- 정본 경로: `/Users/hyunjun/Documents/MUNI/meeting-slides`
- GitHub 원격: `https://github.com/dltdnfrk/meeting-slides.git` (branch `main`)

> 이 문서는 스냅샷입니다. 재개 세션은 아래 "재검증 명령"부터 실제로 실행해서 상태가
> 그대로인지 먼저 확인하세요. 특히 git 상태·포트·앱 프로세스는 시간이 지나면 바뀔 수 있습니다.

---

## 0. TL;DR

- 이번 세션에서 독립된 두 작업(Workstream A, B)을 진행했고, **A는 완료·커밋·푸시까지 끝났습니다.**
- **Workstream A** — TIRO 참고 UI/UX 리서치 → 운영자 화면 전면 재구축 → Apple 느낌의 플로팅 글래스로
  진화 → style-gallery 조회 후 "Operational Liquid Glass"로 확정. 커밋 `a1ed25f`로 GitHub `main`에
  푸시 완료 (`HEAD == origin/main`, ahead/behind 0/0). 독립 Visual QA 최종 **PASS** (Critical/Major 0).
- **Workstream B** — PPT/덱 생성 엔진 고도화 울트라디베이트 리서치. 목표(goal)는 "complete" 상태이고
  모든 산출물(한국어 보고서 PDF/DOCX/HTML, 12장 임원 결정 덱 PDF/PPTX/PNG)이 이미 만들어져 있고
  QA도 PASS 했습니다. **단, 이 산출물을 사용자에게 최종 요약·전달했는지는 이번 세션 기록으로
  확인되지 않았습니다.** 다음 세션이 가장 먼저 확인해야 할 항목입니다 (§4의 "미확인 사항" 참고).
- 프로덕션 코드(server.ts, src/*)에는 이번 세션에서 낸 변경이 **전혀 없습니다** — 사용자가 명시적으로
  요청한 대로 UI(public/*)와 문서(DESIGN.md)만 건드렸습니다.
- 저장소에는 **이번 세션과 무관한, 의도적으로 건드리지 않은 dirty 변경**(Alibaba LLM 프로바이더 제거
  작업, 12개 파일)이 그대로 남아 있습니다. 사용자가 원 요청에서 명시적으로 "건드리지 말 것"이라고
  지정한 영역이니 **커밋/스테이징/되돌리기 금지** — 사용자가 별도로 이어가는 작업입니다.
- macOS 앱(`Meeting Slides.app`)은 빌드·서명·실행·실제 Chromium QA까지 끝났지만, **이 세션이 끝나는
  시점엔 실행 중이 아닙니다** (포트 리스너 없음). 재실행 방법은 §5.

---

## 1. 프로젝트 경계 규칙 (MUNI 컨테이너)

`/Users/hyunjun/Documents/MUNI`는 여러 독립 프로젝트를 모아 둔 컨테이너일 뿐, 그 자체는 Git 저장소가
아닙니다. 반드시 아래를 지키세요.

- 이 프로젝트의 정본 작업 경로는 `/Users/hyunjun/Documents/MUNI/meeting-slides` 하나뿐입니다.
- `MUNI` 루트에서 git/개발 명령을 실행하지 마세요.
- 작업 시작 전 `pwd -P`, `git rev-parse --show-toplevel`, `git remote get-url origin`이 이 프로젝트와
  일치하는지 확인하세요.
- 다른 형제 프로젝트(muni-lab, muni-crm, ontologylab, hwpx-public-document 등)의 경로·브랜치·
  프로세스·포트를 재사용하지 마세요. (실제로 이번 세션에서 8787/8788 포트가 `muni-lab`와 별개
  프로세스에 점유되어 있었습니다 — §5 참고.)

---

## 2. 저장소 현재 상태 (검증 시각: 이 세션 종료 직전)

### 재검증 명령 (다른 세션에서 가장 먼저 실행)

```bash
cd /Users/hyunjun/Documents/MUNI/meeting-slides
pwd -P
git rev-parse --show-toplevel
git remote get-url origin
git branch --show-current
git log -6 --pretty=format:'%h %s'
git status --short
git diff --stat
git rev-list --left-right --count HEAD...origin/main
```

### 마지막으로 확인된 값

- `HEAD` = `origin/main` = `a1ed25f95980980cd958044b90e739ac45e8280d` (`style(ui): apply operational liquid glass`)
- ahead/behind vs `origin/main`: **0 / 0** — 로컬에 있던 모든 커밋이 이미 푸시됨.
- 최근 로그 (최신순): `a1ed25f` → `2348260 feat(stt): add transcribe.cpp backend` → `cf0a968 style(ui): apply Apple glass to floating panels` → `f1b90aa feat(app): ...` → `109c4fe fix(test): ...` → `55f2cb6 docs(evidence): ...`

### `git status --short` (Modified — 이번 세션과 무관, 손대지 말 것)

```
 M .env.example
 M README.md
 M public/app.js
 M server.ts
 M src/app-settings.ts
 M src/config.ts
 M src/llm.ts
 M src/minutes.ts
 M src/provider-adapters.ts
 M src/providers.ts
 M tests/app-settings.test.ts
 M tests/providers.test.ts
```

이 12개 파일은 **Alibaba GLM(Token Plan) LLM 프로바이더를 제거하는 별도 작업**의 diff입니다
(`alibaba` provider id, `ALIBABA_TOKEN_PLAN_*` env, 관련 문서 문구 제거). 이번 세션이 시작되기 전부터
이미 dirty했고, 원 사용자 요청에 "기존 더티 변경(server.ts alibaba hunk 등)... 건드리지 말 것"이라는
명시적 제약이 있었습니다. **커밋하지도, 스테이징하지도, `git checkout`으로 되돌리지도 마세요.**
사용자가 이 작업을 이어가고 싶다면 명시적으로 요청할 것입니다.

### `git status --short` (Untracked)

```
?? .omo/evidence/style-gallery-baseline/
?? .omo/evidence/style-gallery-final/
?? .omo/evidence/style-gallery-panels/
?? .omo/evidence/tiro-operator/
?? .omo/evidence/tiro-reference/
?? .omo/plans/tiro-operator-rebuild.md
?? .omo/ulw-loop/
?? .omo/ulw-research/
?? models/
?? HANDOFF.md   (이 문서)
```

- `models/`는 `.gitignore`의 `models/**/*.bin` 규칙으로 whisper ggml 모델 바이너리가 커밋 대상에서
  빠지는 디렉터리입니다 (정상).
- 나머지는 이번 세션(및 그 이전 TIRO 단계)에서 만든 증거·리서치·계획 스크래치 파일입니다.
  `.gitignore`에 `.omo/senpi-task/`, `.omo/aside-tests/`, `.omo/boulder.json`,
  `.omo/start-work/...`만 제외 규칙이 있고, `.omo/evidence/`, `.omo/plans/`, `.omo/ulw-loop/`,
  `.omo/ulw-research/`는 제외 대상이 아니라서 untracked로 보입니다. 커밋 관례상 이런 작업용 증거는
  보통 리포에 커밋하지 않습니다 — 사용자가 원하지 않는 한 그대로 두세요.

---

## 3. Workstream A — TIRO 참고 운영자 UI 전면 재구축 (완료·커밋·푸시됨)

### 배경 및 진화 과정

1. `tiro.ooo` 런타임 UI를 실브라우저(agent-browser)로 추출해 리서치 (`/tmp/tiro_res/`,
   `.omo/evidence/tiro-reference/`).
2. DESIGN.md Section 9(Operator Surface)를 먼저 갱신한 뒤 셸/워크스페이스/중앙 슬라이드/설정을
   재구축. 플로팅 필 도크, 녹음↔파형 morph, 이중언어(말한/쓴)+번역 토글, 3-way 출력 전환,
   범위 화자변경/Enter분절/인용 점프, disabled-with-reason 패턴을 이식.
3. 사용자가 "예전 cart 팀처럼 플로팅, 애플의 투명 디자인"으로 방향을 틀면서 폰트도 실제 제품에
   많이 쓰이는 폰트(Inter + Pretendard)로 교체.
4. 마지막으로 사용자가 설치된 style-gallery(UI/UX 스타일 데이터베이스)를 조회해서 고도화하라고
   요청 → **Liquid Glass**를 골라 기존 zinc/coral 팔레트·정보 밀도에 맞춘
   **"Operational Liquid Glass"**로 확정 (DESIGN.md Section 9에 스타일 결정·거부 사유 명문화).

### 지켜진 제약 (전부 검증됨)

| 제약 | 상태 |
| --- | --- |
| 슬라이드 초안은 `#current-slide`/`#stage-pane`에만 추가 | 유지 |
| DOM ID (`#current-slide`, `#session-list`, `#transcript-stream` 등) | 유지 |
| WS action/message contract | 유지 |
| `style.css` 토큰 (`--z950`~`--z100`, `--live #e85d4c`, `--glass-bg`/`--glass-blur`) | 유지 |
| `workspace-shell.css` 5-col 그리드 + 1180/900 브레이크포인트 | 유지 |
| TIRO 색 그대로 복사 금지 | 준수 — 기존 zinc/coral만 사용 |
| server.ts / models/ / .omo/ulw-research 미변경 | 준수 |

### 최종 변경 파일 (커밋 `a1ed25f`, 8 files changed, +2110/-94)

| 파일 | 변경 |
| --- | --- |
| `DESIGN.md` | +308/-55 — Section 9 전면 갱신 (TIRO 계약 + style-gallery 결정) |
| `public/index.html` | +111/-18 — 커맨드바, 캡처 필, 전사 언어/도구, 폰트 링크 등 |
| `public/operational-liquid.css` | 신규 861줄 — Liquid Glass 레이어 (style.css/workspace-shell.css 뒤에 로드) |
| `public/operator-surface.js` | 신규 21줄 |
| `public/style.css` | +627/-11 |
| `public/workspace-shell.css` | +61/-8 |
| `tests/public-operator-surface.test.ts` | 신규 209줄 |
| `tests/public-workspace.test.ts` | +6/-5 |

폰트: Google Fonts Inter + jsdelivr Pretendard Variable + 기존 JetBrains Mono(터미널/모노용).
TIRO 원본의 Gmarket Sans/Noto Sans KR 조합은 제거됨.

DESIGN.md Section 9는 파일 153번째 줄부터 파일 끝까지입니다 (다음 섹션 없음 — 마지막 섹션).
스타일 계층 규칙(둥근 사각형 남발 금지, capsule vs rectangle 구분, 반응형 터미널 컨트롤 규칙,
disabled-reason 대비 규칙, reduced-motion 처리)이 전부 여기 명문화되어 있으니 UI를 더 손댈 때는
이 섹션을 먼저 읽으세요.

### 검증 내역 (전부 실행·확인됨)

- `bunx tsc --noEmit` — 통과
- 전체 public UI 테스트 스위트 — 통과 (정확한 개별 테스트 총 개수는 세션 로그에 남지 않음;
  재확인하려면 `bun test` 실행)
- `tests/public-operator-surface.test.ts` — **7 pass / 0 fail / 17 expectations**
- `git diff --check` — 통과 (공백 오류 없음)
- 실제 Chromium(Playwright, headless) 1280/768/375 — 문서 가로 오버플로 0, 잘린 한글 텍스트 0,
  partial 커맨드 0
- 설정 시트 + 참석자 시트 데스크톱/모바일 수동 QA 완료
- **실제 WebSocket 기반 녹음→파형 morph 검증** (하네스로 `capture` 메시지 발사):
  - 375px: `.capture-pill` 크기 128×50 → 247×50으로 확장, waveform `display:flex`,
    라벨 "녹음 중지", `aria-pressed="true"`, 타이머 `00:00` 정상
  - 1280px: pill 중심 이동 **0.008px**, 인접 컨트롤(output-switcher, dock context, commandbar)
    이동 **0px** — no-layout-shift 보장 확인
- **독립 Visual QA** (별도 리뷰어 에이전트, task id `st_019fe6b5`, category
  `visual-engineering`/claude-opus-5):
  - 1차 판정: **REVISE** — Major 2건 (375 rail 터미널 어포던스가 8px 스텁으로 잘림 / 모바일 설정
    시트에서 "모델" 라벨이 고립됨)
  - 두 건 모두 수정 후 재검토 → **최종 판정: PASS**, Critical 0 / Major 0
  - 잔존 Minor 2건 + Nit 1건은 전부 비차단(cosmetic/판단 영역): 전사 워크벤치 밀도, 설정 배경 dimming
    강도, sticky `→` 화살표의 정지 상태 라벨(아이콘만 있음 — `aria-label` 존재 여부는 스크린샷으로
    확인 불가하니 코드로 재확인 권장)
  - **주의**: `task_id=st_019fe6b5`는 이전 세션에 종속된 child session입니다. 새 세션에서
    `task_output`으로 다시 조회되지 않을 수 있습니다 — 위 요약이 사실상 유일한 기록입니다.
- 리뷰어가 스크린샷 기반이라 커버하지 못한 잔존 리스크(recording-state morph, populated states)는
  리뷰 종료 후 이 세션이 직접 실제 WebSocket 하네스로 recording-state morph를 추가 검증해서 닫았습니다
  (위 "실제 WebSocket 기반 morph 검증" 항목). **populated `#current-slide`/`#transcript-stream`
  상태와 스플리터 드래그 상호작용은 여전히 미검증**입니다 (§6 참고).

### 증거 파일 위치

```
.omo/evidence/style-gallery-baseline/{1280,768,375}.png
.omo/evidence/style-gallery-final/{1280,768,375}.png
.omo/evidence/style-gallery-final/{1280,375}-capturing.png   # 실제 녹음 morph 스크린샷
.omo/evidence/style-gallery-panels/settings-1280.png
.omo/evidence/style-gallery-panels/settings-375.png
.omo/evidence/style-gallery-panels/attendees-375.png
.omo/evidence/tiro-operator/     # TIRO 단계 증거
.omo/evidence/tiro-reference/    # TIRO 리서치 원본 증거
```

(v1/v2/v3 중간 스크린샷 폴더는 정리 과정에서 이미 삭제됨 — 존재하면 이상 신호.)

---

## 4. Workstream B — PPT 생성 엔진 고도화 울트라디베이트 리서치 (기술적으로 완료, 전달 여부 미확인)

### 목표(goal) 상태

`get_goal` 조회 결과: `status: "complete"`, 약 196만 토큰, 약 64분(3838초) 소요.
Objective 원문: "In /Users/hyunjun/Documents/MUNI/meeting-slides, conduct an exhaustive ultradebate
research program on how to advance the PPT/deck generation engine... Do not modify production
implementation unless the user later explicitly asks." — **프로덕션 코드는 실제로 변경되지 않았음을
git diff로 확인함** (server.ts/src/*의 diff는 전부 무관한 Alibaba 제거 작업뿐).

### ⚠️ 다음 세션이 가장 먼저 확인해야 할 것

이 세션의 대화 기록상, 리서치 산출물(SYNTHESIS.md, 한국어 보고서, 12장 임원 덱)이 **사용자에게
최종 요약·전달되었다는 확인 메시지가 보이지 않습니다.** 리서치가 마무리되던 시점 직후 사용자의
다음 메시지는 "style-gallery 사용해서 ui/ux 고도화 가보자"로 화제가 전환되었습니다. 즉:

- 산출물은 전부 존재하고 QA도 PASS 했습니다 (기술적으로 "완료").
- 그러나 사용자가 이 결과를 **검토했는지, 승인했는지는 불명확**합니다.
- 새 세션은 아래 파일 경로를 사용자에게 요약·제시하고, Slide 12에 나온 "지금 승인할 세 가지"에
  대한 의사결정을 받는 것이 리서치 스레드의 자연스러운 다음 단계입니다.

### 작업 디렉터리

`.omo/ulw-research/20260809-205918/` (이번 세션 스레드).
별도로 `.omo/ulw-research/20260809-065345/`도 존재하는데 이는 **주제가 다른 이전 리서치**
(STT/ASR 모델 지형 조사, `final-report.md` 등 자체 완결)입니다 — 이번 핸드오프의 대상이 아니지만
참고용으로 남아 있습니다.

### 핵심 산출물

```
.omo/ulw-research/20260809-205918/
├── SYNTHESIS.md                 # 503줄 — 최종 통합 결론/보고서 원본 (가장 먼저 읽을 파일)
├── claim-graph.md               # 45줄 — 검증된/기각된 주장 그래프
├── debate-log.md                # 30줄 — 8팀원 + 13개 독립 레인 교차비평 로그
├── verification-economics.md    # 클레임별 실행 검증 방법/결과 표
├── observation-manifest.md / sources-ledger.md / journal.md(160줄) 등
├── outputs/
│   ├── ppt-engine-strategy.md / .html / .docx / .pdf   # 한국어 본문 보고서 (pdf 686KB)
│   ├── ppt-engine-executive-deck.pdf                   # 12장 덱 PDF (8.36MB)
│   ├── ppt-engine-executive-deck.experimental.pptx     # 12장 덱 PPTX (2.97MB, "experimental" 명명 — 리서치 자체 결론상 PPTX 왕복이 아직 불완전하기 때문)
│   ├── executive-deck-png/slide-01..12.png             # 슬라이드별 PNG
│   └── evaluation-economics-scorecard.md
└── executive-deck/              # 덱 소스 (slide-01..12.html, deck.css, slide-outline.md, qa/pass-a-visual.md, qa/pass-b-content.md — 둘 다 PASS)
```

### 결론 요약 (SYNTHESIS.md 발췌)

**"Conditional GO for an evidence-gated prototype; NO-GO for production claims."**

권고 파이프라인 (7단계): 불변 `transcriptVersionId` 스냅샷 → factual narrative item에 근거
`EvidenceCard`(연속 seq 범위, verbatim quote, date/version, uncertainty, counterevidence) 부착 →
human-approved `StoryOutline` 파일럿(강제 승인은 아직 아님) → 승인된 beat를 독립 컴파일 →
`SceneDeck`엔 실제 cross-target invariant(provenance/story role/design token/fit policy)만 남기고
백엔드가 자체 측정·시맨틱 소유 → PptxGenJS pinned 버전을 provisional baseline + 재현된 API gap만
named OOXML escape hatch로 보완 → 구조 gate → source gate → fit/layout gate → native PowerPoint
acceptance → cross-host/render gate 순서로 검증.

새 성공 지표 제안(아직 프로덕션 지표 아님, A/B 필요): K0(첫 산출물 채택/폐기율), K1(제시→승인까지
실사용자 리뷰/편집 시간), K2(추가 수정 없이 승인되는 비율).

**현재 엔진 실태 지도** (코드 레벨로 직접 확인된 사실):

- 3개의 publication path가 공존: Live MeetingCard(저지연) / Production scene compile
  (`compileNarrativeDeck`→`NarrativeDeck`→`composeNarrativeDeck`, LLM 2회 실패시
  `fallbackNarrative`) / **고아 상태인 `DeckOutline` compile 경로** — 2회 실패시 throw, 서버가 이
  action을 import하지 않아 실제로는 도달 불가능.
- narrative/scene 스키마에 전사 출처 좌표가 없음 (prompt의 "전사에 근거하라"는 기계적 게이트가 아님).
- `scene_json`은 `as SceneDeck` 캐스트로만 읽힘 — 런타임 검증 없음.
- scene vocabulary가 text/rect/ellipse/line 4종뿐.
- HTML(Pretendard + keep-all + clip) vs PPTX(Apple SD Gothic Neo + bare `normAutofit`) — 줄바꿈/
  overflow 결과가 서로 다름. **`normAutofit`에 `fontScale`이 없어 결정론적 축소를 보장하지 않음을
  실제 실행으로 반증**.
- 레이아웃이 100×56.25 매직넘버에 고정, 텍스트 측정 로직 없음.
- PPTX 테스트가 ZIP/XML/텍스트 존재만 검사 — 실제 fidelity 미검증.
- **PDF만 visual/design 게이트를 통과**하고 PNG/PPTX는 게이트를 우회함. PPTX 액션은 서버에 있지만
  현재 UI에 클라이언트 발신 버튼이 없음.

**실행으로 검증된 사실 (주장이 아니라 실제로 돌려본 결과)**:

| 검증 항목 | 결과 |
| --- | --- |
| 패키지/구조 게이트 | PASS |
| LibreOffice 격리 왕복 (텍스트/도형 개수) | PASS |
| PowerPoint Mac 네이티브 수락 실행 | 한 프로브에서 GUI 싱글턴 점유로 BLOCKED (미결) |
| PowerPoint Mac CJK 핏 프로브 | overflow 재현됨 |
| 크로스플랫폼 CJK 렌더링 (일본어/중국어) | **FAIL** |
| Chrome 클리핑 측정치 | 6.44px, 210.85px |
| bare `normAutofit`의 `fontScale` 존재 여부 | 없음 — 결정론적 축소 미보장 (통념 반증) |

**12장 임원 덱 QA**: `slides-grab validate` 0 errors/0 warnings, Pass A(System Contract) PASS,
Pass B(Audience Impact/Readability) PASS — 둘 다 Critical 0, blocking 0.

**Slide 12 "지금 승인할 세 가지"** (아직 사용자 승인 대기 상태로 추정): locked corpus,
PowerPoint/CJK acceptance 테스트, thin-review A/B. 프로덕션 롤아웃은 보류 권고.

---

## 5. macOS 앱 빌드 & 실행 ("웹앱에서 테스트해보게 앱 아이콘에 빌드해" 요청 대응)

### 무엇을 했는지

- 기존 스크립트 `scripts/build-app.sh`를 그대로 사용 (새로 만들지 않음). 이 스크립트는 Swift로 작은
  네이티브 런처를 컴파일해서(**WKWebView/Electron/Tauri 아님** — `bun run server.ts`를 실행하고
  OS 기본 브라우저로 `http://localhost:<port>`를 여는 방식) `~/Applications/Meeting Slides.app`에
  ad-hoc 코드사인으로 설치하고, 프로젝트 루트에 `Meeting Slides.app` 심링크를 겁니다
  (둘 다 `.gitignore`에 있어 git엔 안 보임).
- 기본 포트 8787은 **다른 프로젝트(muni-lab)의 python 프로세스**가, 8788은 **무관한
  cc-retry-proxy node 프로세스**가 점유 중이었습니다. 그래서 이 프로젝트의 로컬(`.gitignore`된)
  `.env`의 `HTTP_PORT`를 확인 당시 비어있던 **8789**로 바꾸고 재빌드했습니다.
- `open "$HOME/Applications/Meeting Slides.app"`로 실행 → `http://localhost:8789/` 서빙 확인.
- **실제 Chromium(Playwright, headless)으로 검증**: 최신 Operational Liquid CSS 로드됨,
  WebSocket 연결됨("AI 모델에 연결되었습니다"), 설정 패널 열기/닫기 정상, 출력 전환(`전체 전사`)
  정상, 문서 가로 오버플로 0, 페이지 에러/네트워크 실패 0.

### 지금 상태 — 실행 중이 아님

세션 종료 직전 확인 결과 `pgrep -alf '/Meeting Slides.app/Contents/MacOS/meeting-slides'`가
아무 프로세스도 찾지 못했고 8789 포트 리스너도 없습니다. **정상적인 종료**로 보이며(사용자가 앱을
닫았거나 세션이 넘어가며 자연 종료), 코드 결함은 아닙니다.

### 재실행 방법

```bash
# 1. 포트 가용성 먼저 재확인 (8787/8788/8789가 이번에도 비어있다는 보장 없음)
lsof -nP -iTCP:8787 -sTCP:LISTEN
lsof -nP -iTCP:8788 -sTCP:LISTEN
lsof -nP -iTCP:8789 -sTCP:LISTEN

# 2. 필요하면 .env의 HTTP_PORT를 빈 포트로 바꾸고 재빌드 (포트는 .env에서 서버 시작 시 읽음 —
#    바이너리에 박혀있지 않음. .env만 바꿔도 되고, 앱을 다시 빌드할 필요는 원래 없음)
#    단, 이미 설치된 앱을 그대로 쓴다면 .env만 바꾸면 충분합니다.

# 3. 실행
open "$HOME/Applications/Meeting Slides.app"

# 4. 준비 로그 확인 (준비완료/실패 신호)
tail -f "$HOME/Library/Logs/Meeting Slides/launcher.log"
```

`bash scripts/build-app.sh`는 소스(`macos/launcher.swift`, `public/*`)가 바뀌었을 때만 다시 실행하면
됩니다. 이번 세션에서 프로덕션 코드는 안 바꿨으니 **재빌드가 필수는 아니고, 재실행만 하면 됩니다.**

---

## 6. 알려진 이슈 / 잔존 리스크 (전체 워크스트림 통합)

1. **Biome LSP 미설치** — Workstream A 진행 중 CSS/HTML LSP 진단을 못 돌렸음. 실제 Chromium 렌더링+
   테스트 + tsc로 대체 검증함. 필요하면 `lsp-setup` 스킬로 설치 가능.
2. 1280px에서 `/favicon.ico` 404가 한 번 관찰됨 — cosmetic, `public/`에 파비콘 파일이 아예 없음.
   기능적 영향 없음, 고치지 않음.
3. **Populated 상태 미검증** — `#current-slide`/`#transcript-stream`에 실제 콘텐츠가 채워진 상태와
   스플리터 드래그 상호작용은 이번 세션의 모든 QA 패스에서 idle/empty 상태만 캡처됨. recording-state
   morph는 이후 실제 WS 하네스로 닫혔지만(§3), populated states는 여전히 열려 있음.
4. sticky rail `→`("더 보기") 어포던스의 `aria-label` 존재 여부 — 리뷰어가 스크린샷으로는 판단 불가.
   코드(`public/index.html`)에서 직접 확인 권장.
5. **Workstream B**: PowerPoint 네이티브 수락 테스트가 한 프로브에서 점유된 GUI 싱글턴 때문에
   미결(BLOCKED)로 끝남 — clean host에서 재실행 필요. "PowerPoint가 덱을 받아들인다"는 아직 양방향
   증명이 안 됨.
6. **Workstream B**: 일본어/중국어 CJK 렌더링이 테스트된 프로브에서 실제로 FAIL함 — 리서치가 발견한
   결함이며 이번 세션에서 고치지 않음(제약상 프로덕션 코드 불변).
7. 로컬 포트 드리프트 — 8787/8788이 이 macOS 사용자 세션에서 다른 프로젝트에 점유되어 있었음.
   `.env`의 `HTTP_PORT`는 gitignore된 로컬 설정이라 다시 바뀔 수 있음.
8. 이번 세션과 무관한 dirty 변경(Alibaba 제거, 12개 파일)이 워킹트리에 그대로 있음 — 사용자 지시
   없이 커밋/스테이징/되돌리기 금지.
9. `.omo/plans/meeting-minutes-bundle 2.md`처럼 Finder 스타일 중복("파일 2.ext")이 pre-existing으로
   존재 — `.gitignore`의 `* 2.*` 규칙으로 이미 git에서 제외됨, 무해하지만 원하면 정리 가능.

---

## 7. 다음 세션 추천 액션

1. **가장 먼저**: §2의 재검증 명령을 실행해서 이 문서가 여전히 유효한지 확인.
2. **Workstream B 의사결정**: 사용자가 PPT 엔진 리서치 결과를 검토했는지 확인. 안 했다면
   `SYNTHESIS.md` 요약 또는 `outputs/ppt-engine-strategy.pdf` / `outputs/ppt-engine-executive-deck.pdf`
   경로를 제시하고, Slide 12의 "지금 승인할 세 가지"(locked corpus / PowerPoint·CJK acceptance /
   thin-review A/B)에 대한 결정을 받는 게 자연스러운 다음 단계.
3. **Workstream A 잔여 폴리시(선택적, 차단 아님)**: populated 상태 스크린샷, 스플리터 드래그 증거,
   sticky 화살표 `aria-label` 재확인. 사용자가 요청하지 않는 한 우선순위 낮음 — 이미 독립 QA PASS함.
4. **앱 재테스트가 필요하면**: §5의 재실행 절차대로 포트 확인 후 `open`.
5. **Alibaba 제거 dirty 파일**: 사용자가 명시적으로 묻기 전엔 건드리지 말 것.

---

## 8. 참고 파일 인덱스

| 목적 | 경로 |
| --- | --- |
| 디자인 시스템 전체 | `DESIGN.md` (Section 9 = 운영자 UI 계약, 153번째 줄~파일 끝) |
| TIRO 재구축 계획 | `.omo/plans/tiro-operator-rebuild.md` |
| 운영자 UI 런타임 로직 | `public/operator-surface.js` |
| Liquid Glass 레이어 | `public/operational-liquid.css` |
| 운영자 UI 테스트 | `tests/public-operator-surface.test.ts`, `tests/public-workspace.test.ts` |
| UI 증거 스크린샷 | `.omo/evidence/style-gallery-*/`, `.omo/evidence/tiro-*/` |
| PPT 엔진 리서치 최종 결론 | `.omo/ulw-research/20260809-205918/SYNTHESIS.md` |
| PPT 엔진 한국어 보고서 | `.omo/ulw-research/20260809-205918/outputs/ppt-engine-strategy.{md,html,docx,pdf}` |
| PPT 엔진 임원 덱 | `.omo/ulw-research/20260809-205918/outputs/ppt-engine-executive-deck.pdf` / `.experimental.pptx` |
| PPT 엔진 리서치 작업 로그 | `.omo/ulw-research/20260809-205918/journal.md` |
| (무관) 이전 STT/ASR 리서치 | `.omo/ulw-research/20260809-065345/final-report.md` |
| macOS 앱 빌드 스크립트 | `scripts/build-app.sh`, `macos/launcher.swift` |
| 앱 런처 로그 | `~/Library/Logs/Meeting Slides/launcher.log` |
| 프로젝트 경계 규칙 | `/Users/hyunjun/Documents/MUNI/PROJECTS.md` |

---

*이 문서는 세션 연속성을 위한 스냅샷이며 커밋 대상이 아닙니다 (다른 `.omo/*` 산출물과 동일하게
untracked로 둡니다). 사용자가 커밋을 원하면 명시적으로 요청할 것입니다.*
