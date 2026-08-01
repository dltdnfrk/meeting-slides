# meeting-minutes-bundle - Work Plan

## TL;DR (For humans)
<!-- Fill this LAST, after the detailed plan below is written, so it summarizes the REAL plan. -->

**What you'll get:** 회의가 끝나면 몇 분 안에 후보를 검토·확정하는 화면이 뜨고, 확정하면 결정·액션이 첫 페이지에 완결된 세로형 회의록 PDF, CRM에 바로 넘길 수 있는 구조화 JSON, 전사 정본, 그리고 기존 가로형 슬라이드 덱이 한 번에 생성됩니다.

**Why this approach:** 회의록은 슬라이드와 형제 산출물이라 같은 세션 데이터의 두 번째 렌더 경로로 만듭니다(실시간 슬라이드 파이프라인은 건드리지 않음). 결정·액션 추출은 회의 종료 시 전사 전체를 한 번에 처리해 정확도를 높이고, 각 후보는 전사 버전에 귀속된 seq 구간을 근거로 가리켜 재전사에도 좌표가 깨지지 않습니다. LLM 장애 시엔 명시적 어미만 복사하는 정밀 규칙 폴백이 작동합니다.

**What it will NOT do:** 이메일 발송, CRM DB 직접 쓰기, 실시간 화자 라벨링, 전사 전체 화자 식별, 미커밋 변경 정리(별도 서명 게이트 절차), 상용화 부가 기능은 하지 않습니다.

**Effort:** XL
**Risk:** Medium - 추출 품질(긴 전사 청킹)·세로 PDF 첫 페이지 오버플로·라이브 마이크 원본 오디오 보존(해시 위해)이 주 드라이버
**Decisions to sanity-check:** 근거 좌표를 (전사버전ID, seq구간)으로; 회의록 PDF를 slides-grab이 아닌 별도 chromium 인쇄 경로로; 추출을 회의 종료 시 일괄(스트리밍 아님); LLM 장애 시 정밀 규칙 폴백(추측/요약 금지, 명시 어미만 verbatim 복사).

Your next move: 승인하면 `$start-work meeting-minutes-bundle`로 실행 세션에서 시작. 또는 고정밀(momus) 리뷰 먼저. Full execution detail follows below.

> TL;DR (machine): XL, Medium — 회의록 PDF+JSON 번들+전사 정본+형제 덱, 14 구현 투두 + F1-F4 최종검증.

## Scope
### Must have
- D1 형제 산출물: 회의록은 같은 MeetingSession 데이터의 두 번째 렌더 경로; 실시간 슬라이드 파이프라인 무변경
- D2 회의록 6요소: 메타데이터, 결정, 액션(담당자·기한), 미결/다음안건, 발언 귀속, 참조 자료
- D3 근거 구간: 각 결정·액션·미결 후보가 전사 버전에 귀속된 seq 구간 `(transcript_version_id, start_seq, end_seq)`을 가리키고, 근거 없는 항목은 생성 금지(엄격 파서가 거부)
- D4 검토만 하면 되는 상태: 회의 종료 시 검토 화면 → 확인·수정·확정
- D5 참석자 지정: 회의 시작 시 로컬 참석자 입력(이름 + optional crm_person_entity_id) → 메타·화자후보집합·드롭다운 원천; 복합 FK가 명단 밖 귀속을 DB 수준에서 거부
- D6 회의 번들: 세로 회의록 PDF(첫 페이지 결정·액션만으로 완결) + 기계용 JSON + 원본(전사·오디오 참조) + 가로 덱 형제
- D7 CRM 업로드: 번들 JSON은 CRM 업로드 인제스트로 소비; Meeting Slides는 CRM DB에 쓰지 않음
- D8 항목 단위 화자 귀속: 드롭다운(참석자 명단에서 선택, 자유입력 아님); 데이터 모델은 발화 단위 귀속을 나중에 담을 수 있게 설계(`transcript_line_attributions` 별도 테이블, 정본 텍스트 무변경)
- D9 전사 정본성: 전사는 한 번 생성되면 정본; 재전사 시 덮어쓰지 않고 새 버전; 원본 오디오 sha256로 같은 회의 중복 감지
- AC-01..AC-06 전부 (verification_method 명시된 대로)

### Must NOT have (guardrails, anti-slop, scope boundaries)
- 이메일 발송(내장), CRM DB 직접 쓰기, CRM과 공용 코드 모듈, CRM 직접 통합 API
- 실시간 화자 라벨링, 발화 단위 전체 화자 귀속(데이터 모델만 수용, 구현 안 함)
- 전사 전체 화자 식별/임베딩 diarization
- 상용 멀티테넨시/과금/마케팅
- 미커밋 변경 19건 정리 — 별도 서명 게이트 절차(interview_20260801_022007); 이 계획은 깨끗한 baseline을 전제로 하며 정리를 수행하지 않음
- 범위를 MVP/v1/phase-1로 축소하지 않음(전체 범위가 기본)
- 슬라이드 덱(가로)과 회의록(세로)을 하나로 합치지 않음(D1)
- 폴백 추출기가 요약·추론·대명사 해결·비인접 라인 결합·화자 신원 매핑을 하지 않음(명시 어미가 있는 라인을 verbatim 복사만)

## Verification strategy
> Zero human intervention - all verification is agent-executed.
- Test decision: TDD — 각 투두의 store/파서/빌더는 구현 전 단위 테스트로 계약을 고정하고, 구현 후 통과; 통합(WS 액션·chromium 인쇄·번들)은 tests-after. 프레임워크: `bun test` (기존 14파일 71테스트 일관). 타입: `tsc` 0 error. 브라우저 증거는 기존 `.omo/evidence/ulw/transcript-overlay-20260730/` 패턴(Aside/Playwright)을 따를 수 있으나 본 계획은 결정론적 bun test + chromium 렌더 단정을 1차로.
- Evidence: `<attemptDir>/task-<N>-meeting-minutes-bundle.<ext>` (attemptDir = `omo ulw-loop status --json`의 currentAttemptDir, 또는 `.omo/evidence/ulw/<session>/<goalId>/a<attempt>`; ulw-loop 밖이면 `.omo/evidence/meeting-minutes-bundle/`)
- 회귀: 각 웨이브 후 기존 `tests/*.test.ts` 71테스트 0 fail 유지; 실시간 슬라이드/오버레이/export 무회귀.

## Execution strategy
### Parallel execution waves
> Target 5-8 todos per wave. Fewer than 3 (except the final) means under-split.

- Wave 1 (Foundation): T1 dispatch→handler-map 리팩터(동작 보존), T2 minutes-store 데이터 모델(전체 스키마), T3 transport chat() 노출 — 병렬, 상호의존 없음
- Wave 2 (Attendee + raw audio): T4 setAttendees WS+영속(dep T1,T2), T5 참석자 입력 UI(dep T4)
- Wave 3 (Extraction): T6 extract.ts — LLM+정밀 폴백+엄격 파서(dep T3), T7 startReview WS(dep T2,T6)
- Wave 4 (Review): T8 review-panel.js(dep T7), T9 updateItem/confirmReview WS(dep T2,T8)
- Wave 5 (Minutes bundle): T10 minutes.ts(dep T2), T11 pdf.ts(dep T10), T12 bundle.ts(dep T9,T11)
- Wave 6 (Versioning + audio): T13 canonical-transcript versioning + 오디오 보존/해시(dep T2) — Wave 3-5와 병렬
- Wave 7 (Conclusion): T14 meeting-conclusion + bundle build on confirm(dep T9,T12,T13)

### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1 handler-map refactor | — | 4,7,9 | 2,3,13 |
| 2 minutes-store data model | — | 4,7,9,10,12,13,14 | 1,3 |
| 3 transport chat() | — | 6 | 1,2,13 |
| 4 attendee backend setAttendees | 1,2 | 5 | 6,10,13 |
| 5 attendee frontend form | 4 | — | 7,10,11,13 |
| 6 extract.ts (LLM + fallback + strict parser) | 3 | 7 | 4,10,13 |
| 7 startReview WS action | 2,6 | 8 | 9-pre,10,13 |
| 8 review-panel.js | 7 | 9 | 10,13 |
| 9 updateItem/confirmReview WS | 2,8 | 12,14 | 10,13 |
| 10 minutes.ts portrait HTML | 2 | 11 | 6,8,13 |
| 11 pdf.ts chromium A4 | 10 | 12 | 13 |
| 12 bundle.ts atomic | 9,11 | 14 | — |
| 13 canonical-transcript versioning + audio | 2 | 14 | 1,3,4,6,10 |
| 14 meeting-conclusion | 9,12,13 | — | — |

## Todos
> Implementation + Test = ONE todo. Never separate.
- [x] 1. server.ts WS dispatch → handler map 리팩터(동작 보존)
  What to do / Must NOT do: server.ts:189-448의 if/else 액션 분기를 `Map<string, (ctx) => void>` 핸들러 맵으로 추출. 기존 액션(startCapture/stopCapture/transcript/exportDeck/exportPdf/exportPng/exportMarkdown/exportJson/reset)의 동작·브로드캐스트·lastSavedPath 갱신을 바이트 동등하게 보존. Must NOT: 동작 변경, 새 액션 추가(이 투두 범위 아님), exportPdf의 design-gate 시각검토 흐름 단순화.
  Parallelization: Wave 1 | Blocked by: — | Blocks: 4,7,9
  References: server.ts:189-448(액션 분기), server.ts:204-245(exportDeck/runGrab), server.ts:270-345(exportPdf design-gate 흐름), server.ts:359-386(exportMarkdown/exportJson), src/session.ts:100(ServerMessage 유니온)
  Acceptance criteria (agent-executable): `bun test` 기존 71테스트 0 fail; `tsc` 0 error; `git diff --check` clean; 단정: handlerMap이 모든 기존 액션을 등록(`handlerMap.has(action)` for each).
  QA scenarios: happy — 각 기존 액션 WS 메시지 송신 시 동일 응답/브로드캐스트/lastSavedPath 갱신(스냅샷 단정). failure — 알 수 없는 액션 시 기존 무시/에러 동작 유지. Evidence `<attemptDir>/task-1-meeting-minutes-bundle.txt`
  Commit: Y | refactor(server): extract WS action dispatch to handler map

- [x] 2. minutes-store.ts — 회의록 도메인 SQLite 스키마(전체) + 메서드
  Range validation contract: `saveCandidates`와 `confirmReview`는 endpoint 복합 FK만 믿지 않고 같은 SQLite 트랜잭션에서 `[source_start_seq, source_end_seq]`의 모든 seq를 `transcript_version_lines`에 조회한다. 중간 seq 하나라도 없거나 버전이 다르면 item 저장·확정을 거부한다.
  Meeting lifecycle contract: `ensurePreparedMeeting(provider, purpose)`는 기존 legacy `meetings.started_at NOT NULL` 제약을 지키며 draft meeting row를 만들고 `meeting_meta.phase='prepared'`, `prepared_at`, `meeting_id`를 반환한다. `activatePreparedMeeting(meetingId)`는 같은 row를 `capturing`으로 전환하고 실제 capture 시각을 metadata에 기록한다. T4의 `setAttendees`가 이 ensure를 호출하며, T5가 반환된 ID를 보관한다. `startCapture`는 이 prepared ID를 받으면 새 `startMeeting()`을 호출하지 않고 `activatePreparedMeeting`으로 같은 meeting을 재사용한다. prepared ID가 없을 때만 기존 legacy start 경로를 사용한다.
  What to do / Must NOT do: 새 `src/minutes-store.ts`, `bun:sqlite` Database 핸들 공유. `PRAGMA foreign_keys = ON` 매 연결마다. 다음 `CREATE TABLE IF NOT EXISTS`(복합 FK로 D5·D3 DB 수준 강제):
  `attendees(meeting_id, attendee_id TEXT PK컬럼, display_name NOT NULL CHECK trim<>'', crm_person_entity_id, sort_order DEFAULT 0, created_at, PK(meeting_id,attendee_id), FK meetings CASCADE, UNIQUE(meeting_id,crm_person_entity_id) WHERE NOT NULL)` — attendee_id가 귀속/담당자 키(crm id 아님).
  `meeting_audio_sources(meeting_id PK, original_audio_sha256 TEXT NOT NULL UNIQUE CHECK len=64, original_audio_path, byte_length, created_at, FK meetings CASCADE)`.
  `transcript_versions(transcript_version_id TEXT PK, meeting_id, version_no CHECK>0, source_kind CHECK IN('live_capture','file_transcription','retranscription','import'), engine, engine_model, created_at, finalized_at, content_sha256 CHECK NULL OR len=64, UNIQUE(meeting_id,version_no), UNIQUE(meeting_id,transcript_version_id), FK meetings CASCADE, CHECK finalized_at NULL OR content_sha256 NOT NULL)`.
  `transcript_version_lines(meeting_id, transcript_version_id, seq CHECK>0, captured_at_ms, audio_start_ms, audio_end_ms CHECK>=start, speaker_turn CHECK NULL OR>0, text NOT NULL CHECK trim<>'', PK(transcript_version_id,seq), UNIQUE(meeting_id,transcript_version_id,seq), FK transcript_versions CASCADE)` — 정본 라인은 이 테이블(레거시 transcript_lines는 호환용 유지, 신규 회의는 듀얼라이트, 기존 회의는 지연 스냅샷 복사). `UNIQUE(meeting_id,transcript_version_id,seq)`가 후보 source 복합FK의 **부모키**다(이 컬럼 조합이 FK 참조 대상).
  `meeting_transcript_state(meeting_id PK, canonical_transcript_version_id NOT NULL, canonical_selected_at, FK)`.
  `meeting_meta(meeting_id PK, purpose TEXT, FK meetings CASCADE)` — 회의 메타(purpose) 전용; 레거시 meetings 테이블 무변경(컬럼 추가 대신 별도 테이블).
  `transcript_line_attributions(...)` — 발화 단위 미래 확장(정본 텍스트 무변경), 마이그레이션 불필요.
  `meeting_reviews(review_id TEXT PK, meeting_id, transcript_version_id, status DEFAULT 'draft' CHECK IN('draft','confirmed'), created_at, updated_at, confirmed_at, confirmed_by, UNIQUE(meeting_id,transcript_version_id), CHECK (draft→confirmed_at NULL) OR (confirmed→confirmed_at NOT NULL), FK)`.
  `decisions(decision_id PK, meeting_id, review_id, description CHECK trim<>'', source_transcript_version_id, source_start_seq, source_end_seq CHECK start<=end, attributed_attendee_id, origin CHECK IN('llm','local_rule','manual'), review_state DEFAULT 'candidate' CHECK IN('candidate','confirmed','rejected'), created_at, updated_at, CHECK confirmed→attributed NOT NULL, 복합FK (meeting,review,source_ver)→meeting_reviews; **source 근거는 두 개의 별도 복합FK** — (meeting_id,source_transcript_version_id,source_start_seq)→transcript_version_lines(meeting_id,transcript_version_id,seq) 와 (meeting_id,source_transcript_version_id,source_end_seq)→동일(부모키=UNIQUE(meeting_id,transcript_version_id,seq)); FK는 양끝점만 검사하므로 saveCandidates/confirmReview는 같은 트랜잭션에서 [source_start_seq,source_end_seq] 구간 내 모든 seq가 transcript_version_lines에 존재하는지 추가 검증(interior check; 하나라도 누락 시 item 거부); 복합FK (meeting,attributed)→attendees)`.
  `action_items(... assignee_attendee_id, attributed_attendee_id, deadline, deadline_text, ... CHECK confirmed→assignee+attributed+deadline NOT NULL, 동일 두-source 복합FK + interior 구간 검증)`.
  `open_items(... attributed_attendee_id, source_*, ... 동일 두-source 복합FK + interior 구간 검증)`.
  `referenced_materials(material_id PK, meeting_id, review_id, material_type CHECK IN('document','figure','link','data','other'), title, uri, notes, source_*(모두 NULL 또는 모두 NOT NULL), review_state, CHECK title 또는 uri 비어있지 않음, 복합FK)`.
  `artifact_bundles(bundle_id PK, meeting_id, review_id, transcript_version_id, bundle_path, status CHECK IN('staging','complete','failed'), created_at, completed_at, FK)`.
  `artifacts(artifact_id PK, bundle_id, artifact_type CHECK IN('minutes_pdf','minutes_json','canonical_transcript','slide_deck','original_audio'), relative_path, media_type, sha256 CHECK len=64, byte_length, created_at, UNIQUE(bundle_id,artifact_type), FK CASCADE)`.
  메서드: addAttendees/attendeesFor, addTranscriptVersion/finalizeTranscriptVersion(content_sha256)/setCanonical/latestVersion, saveCandidates(decisions/actions/opens — 각 item+source 복합FK 같은 트랜잭션, segment 범위 [1,maxSeq] 검증, 근거 없는 item 거부), itemsForReview, confirmReview(status 전이+confirmed_at+재검증 같은 트랜잭션), addAudioSource/findMeetingByAudioHash. Must NOT: transcript_lines/slides 테이블이나 MeetingStore.addLine/addSlideTx 경로 건드림; ALTER TABLE(모두 CREATE IF NOT EXISTS); 기존 (meeting_id,seq) 비유니크 레거시는 스냅샷 전 중복 검증 후 어보트.
  Parallelization: Wave 1 | Blocked by: — | Blocks: 4,7,9,10,12,13,14
  References: src/store.ts:30-66(WAL/busy/synchronous + 기존 DDL 패턴), :45-52,61(transcript_lines 비유니크 — 스냅샷 전 검증), :96-105(addLine seq 단조), docs/ouroboros-seed.yaml ontology_schema, docs/PRODUCT_SPEC.md D3,D5,D8,D9
  Acceptance criteria: `bun test tests/minutes-store.test.ts` — FK로 명단 밖 attendee_id INSERT 거부; source 없는/범위이탈 item 거부; 복합FK로 존재 않는 seq 참조 거부; confirmReview 같은 트랜잭션 재검증; finalizeTranscriptVersion content_sha256 설정; attendee_id TEXT(crm id 아닌 귀속 키); ensureColumn 불필요(모두 CREATE IF NOT EXISTS); 기존 tests/store 회귀 0 fail.
  QA scenarios: happy — addAttendees→attendeesFor; saveCandidates→itemsForReview(kind/description/source_ver/seq 복원); confirmReview→status 전이. failure — 명단 밖 assignee FK 거부; 범위이탈 segment 거부; 미확정 item으로 confirmReview 거부. Evidence `<attemptDir>/task-2-meeting-minutes-bundle.txt`
  Commit: Y | feat(store): add minutes domain schema with composite-FK provenance and review workflow

- [x] 3. LLM transport — generic chat() 노출
  What to do / Must NOT do: `src/llm.ts` LLMClient에 `async chat(prompt, {jsonMode=true, maxTokens?, timeoutMs?}): Promise<string>` 추가(SYSTEM_PROMPT 없이 순수 prompt→출력; `response_format json_object`, GLM reasoning_content는 parseExtractionJson 측 처리). `src/llm-cli.ts`의 모듈-private `runCli`를 export하고 CliLLMClient에 `chat(prompt)` 위임. 기존 detectBlock/ping 동작 유지. Must NOT: detectBlock 프롬프트/튜닝/30s 타임아웃 변경; 새 프로바이더 추가.
  Parallelization: Wave 1 | Blocked by: — | Blocks: 6
  References: src/llm.ts:88(LLMClient), :30-50(parseBlockDetectionJson 패턴), :81(DETECT_TIMEOUT_MS), src/llm-cli.ts:38(runCli), :51-60(타임아웃 reject), :88(CliLLMClient), src/config.ts:LLMProviderConfig/CliLLMConfig
  Acceptance criteria: `bun test tests/llm-transport.test.ts` — chat(prompt)→JSON 문자열(모킹 fetch/spawn); detectBlock 기존 동작 유지; chat 타임아웃 reject. 기존 tests/llm-cli.test.ts 0 fail.
  QA scenarios: happy — chat→JSON; detectBlock 유지. failure — chat 타임아웃/HTTP 에러 reject. Evidence `<attemptDir>/task-3-meeting-minutes-bundle.txt`
  Commit: Y | feat(llm): expose generic chat() transport for non-block extraction

- [x] 4. 참석자 지정 백엔드 — setAttendees WS 액션 + AttendeesUpdate 메시지
  Fixed metadata decision: meeting purpose는 **오직** `meeting_meta(meeting_id, purpose)`에 저장하고 `minutes-store.meetingMeta(meetingId)`로 번들 메타데이터에 조회한다. 이 결정은 이 투두의 이전 `meeting_reviews 또는 별도` 표현을 대체한다.
  Meeting lifecycle boundary: `setAttendees`는 캡처 전에도 호출 가능하며 먼저 `ensurePreparedMeeting(provider,purpose)`를 호출한다. 응답 `attendees` 메시지에 `meeting_id`를 포함하고, 이후 참석자 수정은 같은 draft ID에 대한 replace/upsert만 허용한다. `startCapture {meeting_id}`는 그 ID가 현재 prepared meeting인지 검증한 뒤 같은 row를 capturing으로 활성화한다. 다른 ID이거나 이미 종료된 ID면 거부하고 새 meeting을 암묵적으로 만들지 않는다.
  What to do / Must NOT do: 새 WS 액션 `setAttendees {attendees:[{attendeeId?, name, crmPersonId?}]}`(캡처 전/중, review 확정 전까지 편집). 서버에서 attendee_id 미제공 시 UUID 생성, minutes-store.addAttendees 호출 후 `attendees` 메시지 에코(메타+후보집합). meeting purpose는 `meeting_meta(meeting_id, purpose)`(T2)에 저장(setMeetingPurpose)하고 `minutes-store.meetingMeta(meetingId)`로 번들 메타데이터에 조회한다. ServerMessage에 `AttendeesUpdate {type:'attendees',attendees:[{attendee_id,display_name,crm_person_entity_id?}]}` 추가(가법). Must NOT: CRM DB 읽기/쓰기(crm id는 자유 텍스트 저장만); 참석자 강제(없어도 캡처 가능); 실시간 라벨링.
  Parallelization: Wave 2 | Blocked by: 1,2 | Blocks: 5
  References: server.ts(handler map T1), src/session.ts:100(ServerMessage), src/minutes-store.ts(T2 addAttendees/attendeesFor), docs/PRODUCT_SPEC.md D5
  Acceptance criteria: `bun test tests/attendees-action.test.ts` — setAttendees→addAttendees 영속+attendees 에코; attendeesFor 검증; 같은 meeting 재전송 시 upsert/교체; crm_person_entity_id 옵션 NULL.
  QA scenarios: happy — 3명→에코 3명. failure — 빈 배열/문자열 name 거부. Evidence `<attemptDir>/task-4-meeting-minutes-bundle.txt`
  Commit: Y | feat(server): add setAttendees WS action and AttendeesUpdate message

- [x] 5. 참석자 지정 프론트엔드 — 캡처 전 입력 폼
  Lifecycle UI contract: 참석자 저장 버튼은 `setAttendees`를 먼저 보내고 `attendees.meeting_id`를 local state에 저장한다. 녹음 시작 버튼은 저장된 동일 `meeting_id`를 `startCapture`에 포함한다. 준비된 ID가 없으면 녹음 시작을 막고 참석자 저장 오류를 표시하며, 재연결 시 서버의 draft attendees/meeting_id를 다시 요청한다.
  What to do / Must NOT do: `public/index.html`에 참석자 입력 패널(provider-panel 패턴: hidden 토글, 바깥 클릭 닫기). `public/app.js`에서 폼 제출→setAttendees WS 송신; attendees 메시지 수신→드롭다운 원신(T8용)으로 상태 보관. Must NOT: 참석자를 캡처 시작 하드 게이트로; 자유입력 담당자 필드(드롭다운만, T8).
  Parallelization: Wave 2 | Blocked by: 4 | Blocks: —
  References: public/index.html:95(provider-panel 패턴), public/app.js:5,57,332(overlay 마운트/바깥클릭 패턴), src/session.ts:100(메시지 타입)
  Acceptance criteria: `bun test tests/public-attendees.test.ts` — 폼 입력→setAttendees 송신(WS 스파이); attendees 메시지→상태 보관(드롭다운 데이터 단정); 빈 이름 제출 차단.
  QA scenarios: happy — 3명 입력→상태 보관. failure — 빈 이름 차단; WS 끊김 후 재연결 attendees 복원. Evidence `<attemptDir>/task-5-meeting-minutes-bundle.png`
  Commit: Y | feat(public): add attendee registration form and attendees state

- [x] 6. src/extract.ts — MinutesExtractor(LLM + 정밀 규칙 폴백 + 엄격 파서)
  What to do / Must NOT do: 새 `src/extract.ts`. 형제 인터페이스(BlockDetector와 공유 없음). 계약(ultrabrain 채택):
  `SourceSegmentRef {transcript_version_id:string, start_seq:number, end_seq:number}`(불변 버전에 귀속 — 재전사에도 좌표 유지).
  `MinutesExtractionInput {schemaVersion, meetingDate, timeZone, transcriptVersionId, attendees:[{attendeeId,displayName}], lines:[{seq, speakerTurn:null|number, text}]}` — lines는 store의 영속 버전 라인(transcript_version_lines), MeetingSession 메모리 아님(seq 없고 200문장/50000 truncation — session.ts:117-135,209-212).
  `MinutesExtractionResult {transcriptVersionId, decisions:[{description, sourceSegment, evidenceQuote, suggestedAttributionAttendeeId|null}], actionItems:[..., suggestedAssigneeAttendeeId|null, deadline|null, deadlineText|null], openItems:[...]}`. candidate id는 검증 후 로컬 할당(모델이 신뢰 id 생성 금지).
  LLM 경로: `chat()`로 추출 프롬프트(ultrabrain 시스템 프롬프트 — 근거 우선, seq 재번호금지, evidenceQuote 실제 인용, speakerTurn≠참석자, 근거 없으면 후보 출력 금지, 기한 명시적일 때만 ISO 정규화, 모델 값은 suggestion).
  **엄격 파서 parseMinutesExtractionJson(content, request)**: parseBlockDetectionJson(llm.ts:30)의 강제/절단 동작 금지. 후보 수용 조건: (1)transcriptVersionId==요청 버전, (2)start_seq<=end_seq 양의 정수, (3)양끝과 중간 모든 seq가 그 불변 버전에 존재, (4)인용 seq가 모델 요청에 포함됐던 것, (5)evidenceQuote가 인용 구간 텍스트에 존재, (6)suggested attendee id가 null 또는 요청 참석자 집합 원소. 위반 시 `CandidateRejection{kind, candidateIndex, code:missing_source|wrong_transcript_version|invalid_seq_range|line_not_in_request|line_not_found|non_contiguous_range|evidence_quote_mismatch}`로 진단만 기록(item 행으로 저장 금지). 형제 후보는 생존. 최상위 버전 불일치/비JSON → 전체 배치 실패→폴백.
  **정밀 규칙 폴백**(채택 — 시드 "LLM extraction with local rule-based fallback on LLM failure" 패턴; maybeDetect try/catch — session.ts:249-269): 결정(결정/확정/합의/채택/하기로 했다), 액션(하겠습니다/할게요/맡겠습니다/담당하겠습니다 또는 "X까지 … 완료/공유"), 미결(미정/보류/추후 논의/다음 회의에서/확인 필요/결정하지 못했다) 어미 라인을 **verbatim 복사**해 description, source=그 라인의 (version_id,seq,seq) 단일 구간. assignee suggestion은 그 라인에 등록 참석자 이름 1명만 명시될 때, 그외 null. deadline은 명시 절대일 때만 ISO, 그외 null+deadlineText 원문. 빈 배열도 유효 성공. Must NOT(폴백): 요약/추론/합의 추정/대명사 해결/비인접 라인 결합/speakerTurn→참석자 매핑/토픽이나 슬라이드 기준 item 생성/근거 좌표 날조. 슬라이드 히스테리시스(ADVANCE_THRESHOLD=2) 재사용 금지.
  Must NOT: detectBlock 프롬프트/히스테리시스 건드림; 근거 없는 후보 보존; 전사 전체 화자 귀속; 폴백이 추측.
  Parallelization: Wave 3 | Blocked by: 3 | Blocks: 7
  References: src/llm.ts:30-50(parseBlockDetectionJson — 파서 참조, 강제/절단 금지), :81(DETECT_TIMEOUT_MS), src/llm-cli.ts:38,51-60,88(runCli/타임아웃), src/session.ts:117-135,209-212,249-269(컨텍스트 truncation + maybeDetect 폴백 패턴), src/store.ts:10-15,96-105(StoredLine seq 단조), src/whisper.ts:151-158,310-315(tinydiarize 전환≠신원), docs/PRODUCT_SPEC.md D3,AC-02, docs/ouroboros-seed.yaml ontology_schema(existing_patterns: local rule-based fallback)
  Acceptance criteria: `bun test tests/extract.test.ts` — parseMinutesExtractionJson: 정상 후보 파싱; 7가지 거부 코드 각각 드롭 단정(버전불일치/범위이탈/존재않는seq/요청미포함seq/증거불일치/명단밖id/segment누락); 빈/비JSON→빈 결과(에러 아님)→폴백 진입; 폴백 결정/액션/미결 어미 라인 verbatim 추출(source=단일 seq 구간); 폴백이 비인접 결합/추론 안 함 단정; LLM 경로 모킹 chat round-trip.
  QA scenarios: happy — 전사 20문장+버전ID → 결정/액션/미결 후보 각 sourceSegment(version_id,seq,seq)+evidenceQuote 포함. failure — 모킹 LLM이 segment 없는 후보 반환→전부 드롭; LLM 타임아웃→폴백(명시 어미만)→빈 가능; 최상위 버전 불일치→전체 배치 실패→폴백. Evidence `<attemptDir>/task-6-meeting-minutes-bundle.txt`
  Commit: Y | feat(extract): add MinutesExtractor with versioned source-segment provenance and precision fallback

- [x] 7. startReview WS 액션 — 추출 실행 → review 메시지 브로드캐스트
  What to do / Must NOT do: 새 WS 액션 `startReview`(캡처 stop 후). 핸들러: canonical transcript_version의 lines(transcript_version_lines) → MinutesExtractor.extract → minutes-store.saveCandidates(candidate 저장) → `review` 메시지 브로드캐스트 `{reviewId, transcriptVersionId, items(각 kind/description/sourceSegment/evidenceQuote/segment_text), attendees, transcript:{lines}}`(각 item에 source segment 텍스트 서버 조인해 자체완전 페이로드). review는 버전 귀속(meeting_reviews). ServerMessage에 ReviewUpdate 추가. Must NOT: review 페이로드에 segment 텍스트를 클라이언트 재 fetch하게; 추출 중 블록 없이 status만.
  Parallelization: Wave 3 | Blocked by: 2,6 | Blocks: 8
  References: server.ts(handler map T1, stopCapture server.ts:581), src/extract.ts(T6), src/minutes-store.ts(T2 saveCandidates/itemsForReview/canonical lines), src/session.ts:100(ServerMessage), docs/PRODUCT_SPEC.md D4,AC-02
  Acceptance criteria: `bun test tests/start-review.test.ts` — startReview→extract(모킹)→saveCandidates→review 메시지에 items(sourceSegment+segment_text)+attendees+transcript+reviewId+transcriptVersionId; 빈 전사→items 빈 배열; LLM 실패→폴백 결과 또는 status "추출 실패·재시도".
  QA scenarios: happy — 전사+참석자→후보+근거텍스트 review. failure — 추출 reject→status "실패·재시도", items 빈, 종결 아님. Evidence `<attemptDir>/task-7-meeting-minutes-bundle.txt`
  Commit: Y | feat(server): add startReview action running extraction to version-scoped review payload

- [x] 8. public/review-panel.js — 검토 오버레이(후보 제시·확정·드롭다운 귀속)
  What to do / Must NOT do: 새 `public/review-panel.js`(transcript-overlay.js 패턴의 세 번째 오버레이). review 메시지 수신 시 패널 노출: 각 item 행(설명 + evidenceQuote 인용 + source segment seq 표기 + 담당자/발언자 `<select>` — 옵션은 attendees 페이로드에서만 렌더, 자유입력 없음). 확인/수정/확정 버튼→updateItem/confirmReview WS 송신. Must NOT: 자유입력 담당자(D8); 실시간 라벨링; 전사 전체 귀속 UI.
  Parallelization: Wave 4 | Blocked by: 7 | Blocks: 9
  References: public/transcript-overlay.js(패턴), public/index.html:160(마운트 지점), public/app.js:5,57(createTranscriptOverlay), src/session.ts:100(ReviewUpdate)
  Acceptance criteria: `bun test tests/public-review.test.ts` — review 메시지→각 item 행 렌더; 담당자 select 옵션이 attendees만; evidenceQuote+seq 표시; 확인/수정→updateItem 송신(WS 스파이); 빈 items 시 "후보 없음" 안내.
  QA scenarios: happy — 3 item/2 attendee→행 렌더, 드롭다운 2옵션, 지정→updateItem. failure — attendees 없을 때 드롭다운 비활성; 빈 items 안내. Evidence `<attemptDir>/task-8-meeting-minutes-bundle.png`
  Commit: Y | feat(public): add review-panel overlay with attendee dropdown attribution

- [x] 9. updateItem / confirmReview WS 액션 — 검토 확정 + 상태 전이 + 같은 트랜잭션 재검증
  What to do / Must NOT do: 새 WS 액션 `updateItem {reviewId, itemId, kind, patch}`(description/assignee/attributed/deadline/review_state 패치), `confirmReview {reviewId}`(전 item review_state=confirmed/rejected, meeting_reviews.status=confirmed). 서버에서 assignee/attributed attendee_id가 attendees(meeting_id)에 존재 검증(경계; 복합 FK가 DB 수준 방어심 깊이). confirmReview는 같은 트랜잭션에서 모든 confirmed item의 source 범위 재해석(실패 시 PDF/JSON 생성 안 함, review_status=draft 유지). Must NOT: 명단 밖 id 수용; 미확정 item으로 confirmReview 허용.
  Parallelization: Wave 4 | Blocked by: 2,8 | Blocks: 12,14
  References: server.ts(handler map T1), src/minutes-store.ts(T2 confirmReview 재검증 트랜잭션), src/session.ts:100, docs/PRODUCT_SPEC.md D4,D5,D8,AC-06
  Acceptance criteria: `bun test tests/review-actions.test.ts` — updateItem→patch 영속(attendees 검증); 명단 밖 assignee 거부(서버+FK); confirmReview→전 item status 전이+meeting_reviews.status=confirmed; 미확정 item으로 confirmReview 거부; confirmReview 재검증 실패→draft 유지+아티팩트 생성 안 함.
  QA scenarios: happy — 3 item patch→영속; confirmReview→confirmed. failure — 명단 밖 거부; 미확정로 confirmReview 거부. Evidence `<attemptDir>/task-9-meeting-minutes-bundle.txt`
  Commit: Y | feat(server): add updateItem/confirmReview with attendee validation and re-verification transaction

- [x] 10. src/minutes.ts — 세로 회의록 HTML 템플릿(첫 페이지 완결, 버전 귀속 좌표)
  What to do / Must NOT do: 순수 함수 `buildMinutesHtml(input:{meta, attendees, decisions, actions, open, referencedMaterials, transcript, transcriptVersionId}):string`. 구조: `<section class="first-page">`(메타 헤더 + 결정 표 + 액션 표[담당자/기한 열]) → `break-after:page`; 이후 논의 요약·발언 귀속·참조 자료·전사 원문 부록. 모든 item에 source segment `(version_id, start_seq, end_seq)` 표기(PDF와 JSON이 같은 좌표 — AC-05). deck/theme.css 토큰 공유하는 minutes.css와 짝. 단위 테스트 가능. Must NOT: 슬라이드 16:9 프레임 재사용; 분량이 아닌 구조 강제 위반.
  Parallelization: Wave 5 | Blocked by: 2 | Blocks: 11
  References: src/deck.ts:47,152(buildDeckHtml/buildSlideFiles 순수 함수 패턴), :34(isDenseTopic 타이포 축소), deck/theme.css, docs/PRODUCT_SPEC.md D6, docs/ouroboros-seed.yaml ontology_schema
  Acceptance criteria: `bun test tests/minutes.test.ts` — first-page section(결정+액션 표)+break+부록; 결정/액션 0개여도 첫 페이지 구조 유지; 모든 item source 좌표 표기; esc() 이스케이프; transcriptVersionId 표기.
  QA scenarios: happy — 3결정/2액션→첫 페이지 표+부록. failure — 결정 0개→"결정 사항 없음"+액션 표만. Evidence `<attemptDir>/task-10-meeting-minutes-bundle.txt`
  Commit: Y | feat(minutes): add portrait minutes HTML template with first-page-complete structure

- [x] 11. src/pdf.ts — chromium A4 인쇄 + 첫 페이지 오버플로 측정·축소
  First-page invariant: 결정과 액션은 모두 첫 페이지에 있어야 하며 첫 페이지 분할은 금지한다. `measure-and-shrink`가 한계에 도달하면 PDF를 성공으로 내보내지 않고 명시적 overflow 오류를 반환한다. 여러 페이지 흐름은 부록에만 허용한다.
  What to do / Must NOT do: 새 `src/pdf.ts`. vendored `vendor/ms-playwright`(server.ts:236) chromium으로 `page.pdf({format:'A4', landscape:false, printBackground:true})`. 빌드된 minutes HTML 로드 후 첫 section 렌더링 높이 측정→한 A4 초과 시 타이포 축소 단계(isDenseTopic 스타일, deck.ts:34) 후 재측정→PDF 출력. Must NOT: slides-grab/디자인게이트 사용(세로 문서 아님); 수동 페이지네이션(@page에 위임).
  Parallelization: Wave 5 | Blocked by: 10 | Blocks: 12
  References: server.ts:234-245,236(vendored chromium), node_modules/slides-grab/scripts/html2pdf.js:246-250(측정 패턴 참고), src/deck.ts:34(typo 축소), src/minutes.ts(T10)
  Acceptance criteria: `bun test tests/pdf.test.ts`(chromium 헤드리스) — renderMinutesPdf(html)→PDF 생성(0 bytes 아님); 첫 페이지 결정+액션만(텍스트/페이지 카운트 단정); 결정 과다→축소 후 1페이지 내(측정 단정).
  QA scenarios: happy — 보통 분량→1페이지 첫 페이지 완결. failure — 결정 30개→축소로도 첫 페이지에 못 들어가면 overflow 오류·PDF 미생성(첫 페이지 분할 금지); 부록 다페이지는 허용. Evidence `<attemptDir>/task-11-meeting-minutes-bundle.pdf`
  Commit: Y | feat(pdf): add chromium A4 portrait print with first-page overflow measure-and-shrink

- [x] 12. src/bundle.ts — 원자적 회의 번들 + manifest + minutes.json(버전 귀속 좌표)
  What to do / Must NOT do: 새 `src/bundle.ts`. `exportBundle(meetingId, reviewId)` → `exports/bundle-<meetingId>-<stamp>.tmp/`에 manifest.json, minutes.pdf(T11), minutes.json(ontology 미러 — attendees/decisions/action_items/open_items/referenced_materials, source refs=`(transcript_version_id,start_seq,end_seq)`=transcript.v<ver>.jsonl 좌표 일치, transcript.version_id+content_sha256, crm_person_entity_id 포함), transcript.v<ver>.jsonl(한 줄당 {seq,ts,speaker_turn,text}, content_sha256로 무결성), audio.ref.json({path|null, original_audio_sha256|null}), deck/(기존 덱 export 그대로) 조립 후 `rename()`로 .tmp 제거(원자적). artifact_bundles+artifacts 테이블에 기록(상태 complete는 review confirmed + 4 필수 아티팩트 존재 후). Must NOT: CRM DB 쓰기; 오디오 복사(참조만); manifest target_commit/sha256 누락; confirmed item의 source version≠bundle version인 채 complete 허용.
  Parallelization: Wave 5 | Blocked by: 9,11 | Blocks: 14
  References: server.ts:210-228(deck export 구성 — 재사용), src/minutes.ts(T10), src/pdf.ts(T11), src/minutes-store.ts(T2 itemsForReview/transcript_version_lines/artifact_bundles/artifacts), docs/ouroboros-seed.yaml ontology_schema, docs/PRODUCT_SPEC.md D6,D7,AC-04,AC-05
  Acceptance criteria: `bun test tests/bundle.test.ts` — exportBundle→6 산출물+manifest; minutes.json source 좌표==transcript jsonl (version_id,seq); content_sha256 일치; confirmed item version==bundle version; .tmp 남으면 거부(rename 원자성); 누락 산출물→에러(번들 미생성); artifact_bundles.status=complete는 confirmed+4아티팩트 후만.
  QA scenarios: happy — 확정 회의→번들 6산출물+manifest+complete. failure — minutes/pdf 실패→.tmp 정리+번들 미생성(원자성). Evidence `<attemptDir>/task-12-meeting-minutes-bundle.txt`
  Commit: Y | feat(bundle): add atomic meeting bundle export with version-scoped provenance and manifest

- [x] 13. canonical-transcript versioning + 원본 오디오 보존/해시 중복 감지
  Concrete audio capture contract: `WhisperStream`(src/whisper.ts:284-310)은 텍스트만 받으므로 캡처 시작 시 `rec`/`sox`/`ffmpeg` 중 설정된 `audioRecorderBin`을 같은 `captureId` 장치로 별도 spawn하여 `exports/audio-<meetingId>-<stamp>.tmp.wav`에 녹음한다. stopCapture에서 recorder에 SIGTERM을 보내 WAV 종료를 확인하고 전체 바이트 SHA-256을 계산한 뒤 `meeting_audio_sources`에 원자적으로 INSERT한다. spawn·녹음·종료·해시 중 하나라도 실패하면 `.tmp.wav`를 삭제하고 `meeting_audio_sources` 행을 삽입하지 않는다(`original_audio_sha256 NOT NULL` 유지). 대신 `audio.ref.json`에 `{path:null, original_audio_sha256:null, status:"unavailable", reason:"recorder_failed"}`를 기록하고 해당 회의에 대해 오디오 해시 중복 판정을 주장하지 않는다. 파일 모드는 전사 전에 해시를 조회하고 unique 충돌이면 기존 회의를 반환해 전사를 건너뛴다. `whisper-stream` 텍스트 파이프라인 자체는 개조하지 않는다.
  What to do / Must NOT do: `transcript_versions`/`transcript_version_lines`(T2) 활용. **정본 워크플로우**: 캡처 시작 시 transcript_version_id(UUID) 생성 → 라인은 transcript_version_lines에 단조 seq로 추가(레거시 transcript_lines에도 듀얼라이트 호환) → 캡처 종료 시 content_sha256 계산(finalizeTranscriptVersion) → meeting_transcript_state.canonical 포인터는 finalize 후 설정. **재전사**: 새 version 행(version_no+1, 새 UUID)+전부 새 라인(기존 UPDATE/DELETE 금지)→canonical 자동 변경 안 함→새 draft review+재추출→사용자 승격 시 canonical 포인터만 갱신(기존 후보/번들은 구버전에 잔류). **오디오**: 라이브 마이크 캡처 원본을 meeting_audio_sources에 보존(현재 보존 안 됨 — ultrabrain 지적 위험), 종료 시 sha256 계산+저장; 파일 모드는 전사 전 meeting_audio_sources 해시 조회→중복 시 기존 회의 반환(전사 스킵); unique 제약이 동시 중복 도착 처리(충돌 시 기존 회의 조회). CRM도 같은 조회 독자 수행(공용 모듈 불필요). 레거시 (meeting_id,seq) 비유니크는 스냅샷 전 검증+어보트. Must NOT: 기존 라인 덮어쓰기; 정본 무결성 훼손; 재전사 강제; 좌표 자동 리매핑.
  Parallelization: Wave 6 | Blocked by: 2 | Blocks: 14
  References: src/minutes-store.ts(T2 transcript_versions/transcript_version_lines/meeting_audio_sources/meeting_transcript_state/finalizeTranscriptVersion), src/store.ts:45-52,61(transcript_lines 비유니크), :96-105(addLine), src/whisper.ts(WhisperStream/WhisperCLI), docs/PRODUCT_SPEC.md D9,AC-05, docs/ouroboros-seed.yaml existing_patterns
  Acceptance criteria: `bun test tests/transcript-versioning.test.ts` — 캡처 시작 version_id 생성+듀얼라이트; finalize→content_sha256+canonical 포인터; 재전사→새 version(기존 라인 UPDATE 0건 단정, 보존); latestVersion 증가; canonical 자동 변경 안 됨; 같은 오디오 해시 2회→중복 감지(전사 스킵); 좌표 version 무관히 (version_id,seq)로 일치.
  QA scenarios: happy — v1 전사→재전사 v2(둘 다 보존, v1 후보 잔류). failure — 해시 충돌 가정→중복 감지; 재전사 중 에러→v1 무결성 유지; 라이브 오디오 보존 안 됨 시 보존 경로 추가 검증. Evidence `<attemptDir>/task-13-meeting-minutes-bundle.txt`
  Commit: Y | feat(store): add canonical transcript versioning, raw audio persistence, and audio-hash dedup

- [x] 14. meeting-conclusion — confirmReview → 번들 빌드 → 종결 판정
  What to do / Must NOT do: `confirmReview`(T9) 확정 후 `exportBundle`(T12) 자동 호출 → meeting_reviews.status=confirmed, artifact_bundles.status=complete. 회의 종결 판정(AC-06): (a)전 item confirmed/rejected, (b)minutes PDF+JSON+전사 정본 존재(artifacts 4행), (c)원본-산출물 연결 기록(manifest+artifacts sha256), (d)덱 형제 보존, (e)confirmed item source version==bundle version — 전부 충족 시 concluded. CRM 전달은 종결 조건 아님(선택). Must NOT: 파일 생성만으로 종결; CRM 전달을 종결에 넣음; 미확정 item으로 종결; version 불일치로 종결.
  Parallelization: Wave 7 | Blocked by: 9,12,13 | Blocks: —
  References: src/minutes-store.ts(T2 confirmReview/meeting_reviews/artifact_bundles), src/bundle.ts(T12), src/extract.ts(T6), docs/PRODUCT_SPEC.md AC-06, docs/ouroboros-seed.yaml exit_conditions(meeting_concluded/bundle_exportable/review_cancelled)
  Acceptance criteria: `bun test tests/conclusion.test.ts` — confirmReview(전 확정)→exportBundle→concluded=true; PDF/JSON/전사/덱 존재 단정; version 일치 단정; 미확정 item→concluded=false(거부); 번들 실패→concluded=false(상태 보존, 재시도 가능); CRM 전달 없어도 concluded=true.
  QA scenarios: happy — 전 확정→번들→concluded. failure — item 미확정→종결 거부; version 불일치→종결 거부; 번들 실패→concluded=false(재시도 가능). Evidence `<attemptDir>/task-14-meeting-minutes-bundle.txt`
  Commit: Y | feat(server): add meeting conclusion judgment on review confirmation

## Final verification wave
> Runs in parallel after ALL todos. ALL must APPROVE. Surface results and wait for the user's explicit okay before declaring complete.
- [ ] F1. Plan compliance audit
  References: `.omo/plans/meeting-minutes-bundle.md` 전체 투두·성공 기준, `docs/PRODUCT_SPEC.md` D1-D9/AC-01-06, `docs/ouroboros-seed.yaml` ontology_schema
  Acceptance criteria: `bun test`와 신규 테스트가 exit 0; `tsc` exit 0; `git diff --check` clean; 각 AC가 passing todo/test에 매핑되고 AC-02 provenance rejection, AC-04 six-artifact bundle, AC-05 version-scoped coordinates, AC-06 conclusion judgment가 단정된다.
  QA scenarios: happy — 모든 투두와 AC 매핑 통과. failure — 투두 누락 또는 AC 미매핑이면 F1 FAIL하고 정확한 행을 기록한다. Evidence `<attemptDir>/F1-meeting-minutes-bundle.txt`
  Commit: Y | test(verify): F1 plan compliance audit
  What: 모든 구현 투두가 계획대로 구현됐는지(References/Acceptance/QA/Commit 대조); 스펙 D1-D9 + AC-01-06 매핑 점검; 근거 좌표 (version_id,seq)가 PDF·JSON·transcript jsonl에서 일치.
  VERIFY: `bun test` 전체(신규+기존 71) 0 fail; `tsc` 0 error; `git diff --check` clean; 매 AC verification_method로 산출물 단정.
- [x] F2. Code quality review
  References: 변경된 `src/`, `server.ts`, `public/` 전체, 특히 `src/minutes-store.ts`, `src/extract.ts`, `src/pdf.ts`, `src/bundle.ts`
  Acceptance criteria: 변경 파일 전체 `lsp_diagnostics` error/warning 0; `tsc` exit 0; 신규 모듈별 순수 LOC 250 이하; 폴백에 요약·추론·대명사 해결·비인접 결합·speakerTurn→attendee 매핑이 없다.
  QA scenarios: happy — diagnostics/type/LOC/폴백 감사 모두 통과. failure — 진단·LOC 초과·금지된 폴백 동작이면 F2 FAIL하고 파일·행을 기록한다. Evidence `<attemptDir>/F2-meeting-minutes-bundle.txt`
  Commit: Y | test(verify): F2 code quality review
  What: 250 LOC ceiling(모듈별), strict 타입, 에러 처리(경계 검증), AI slop(과잉 추상/불필요 방어) 부재; server.ts 핸들러맵 가독성; minutes-store 트랜잭션/FK 정확; 폴백이 추측 안 하는지.
  VERIFY: `lsp_diagnostics`(changed files, error/warning) 0; tsc; 수동 경로 점검.
- [x] F3. Real manual QA
  References: `server.ts`, `public/index.html`, `public/app.js`, `public/review-panel.js`, `src/minutes.ts`, `src/pdf.ts`, `src/bundle.ts`; AC-03/AC-04
  Acceptance criteria: `bun run server.ts`로 파일 모드 회의를 참석자 지정→검토→드롭다운 귀속→확정→번들까지 실행하고 manifest, minutes.pdf, minutes.json, transcript.v*.jsonl, audio.ref.json, deck/를 관찰한다. PDF 1페이지를 검사하고 재전사·중복 오디오·기존 export를 실행한다.
  QA scenarios: happy — 모든 산출물과 첫 페이지 완결. failure — 녹음/해시 실패가 false dedup을 만들거나 첫 페이지 overflow가 PDF를 생성하면 F3 FAIL하고 증거를 남긴다. Evidence `<attemptDir>/F3-meeting-minutes-bundle.png` + `.txt`
  Commit: Y | test(verify): F3 real manual QA
  What: 로컬 서버(`bun run server.ts`)에서 마이크/파일 모드 회의 1건 → 참석자 지정 → 종료 → 검토 화면 → 드롭다운 귀속 → 확정 → 번들(6 산출물) → PDF 첫 페이지 결정·액션만 확인; 재전사 1건(새 버전, 기존 보존); 같은 오디오 2회 중복 감지; 회귀(실시간 슬라이드/오버레이/export).
  VERIFY: 브라우저/Aside 스크린샷; PDF 첫 페이지 단정; 기존 export 회귀.
- [ ] F4. Scope fidelity
  References: plan Scope/Must NOT have, `docs/PRODUCT_SPEC.md` 비범위, baseline `921a01513593c0e10181cf01e535a7abe995deb3`
  Acceptance criteria: 별도 dirty-worktree 절차 후 `git status --porcelain`가 이 계획 커밋만 포함; `git rev-parse HEAD`가 baseline의 descendant; `grep -rn 'nodemailer\|smtp\|INSERT INTO.*crm\|speakerLabel.*realtime' src/ server.ts public/`가 0 hit.
  QA scenarios: happy — 비범위 동작 0 hit, unrelated dirty file 0. failure — 금지 통합 또는 dirty file 혼입이면 F4 FAIL하고 경로를 기록한다. Evidence `<attemptDir>/F4-meeting-minutes-bundle.txt`
  Commit: Y | test(verify): F4 scope fidelity
  What: 범위 OUT(이메일/CRM DB 쓰기/실시간 라벨링/전사 전체 식별/미커밋 정리)이 구현에 스며들지 않았는지; dirty worktree(19건)가 이 계획 실행과 섞이지 않았는지(깨끗한 baseline 921a0151에서 시작).
  VERIFY: git status(이 계획 커밋만); grep 스며들 항목 부재; baseline_commit 921a0151 기준.

## Commit strategy
- 각 투두 1커밋(type(scope): summary — 투두에 명시). 원자적, 경로 명시 스테이징(`git add src/... public/... tests/...` — `git add -A`/`git add .` 금지, spec 커밋 지침 준수).
- dirty worktree(미커밋 19건)는 별도 서명 게이트 절차로 먼저 정리; 이 계획은 깨끗한 baseline_commit 921a0151에서 시작.
- 최종: F1-F4 PASS 후 최종 검증 커밋 또는 PR(실행 세션에서 결정).

## Success criteria
- AC-01: 참석자 지정→메타+후보집합+드롭다운 원천(automated_test PASS)
- AC-02: 후보 추출+근거 구간(version_id,seq); 근거 없는 항목 생성 금지(automated_test PASS — parseMinutesExtractionJson 7 거부 코드 드롭 단정)
- AC-03: 검토 화면 확인/수정/확정/드롭다운(manual_review)
- AC-04: 번들 — 세로 회의록 PDF(첫 페이지 완결)+JSON+원본+덱 형제(artifact_inspection)
- AC-05: 전사 정본 보존+좌표 일치(version_id,seq)+재전사 새 버전(automated_test PASS)
- AC-06: 회의 종결 판정(manual_review + artifact_inspection)
- 회귀: 기존 71 테스트 0 fail; 실시간 슬라이드/오버레이/export 무회귀
- 공통 증거 4속성: target_commit, evidence_ref(불변), verified_by, verified_at
