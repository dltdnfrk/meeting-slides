# Meeting Slides

> 실시간 회의 슬라이드 생성기 — 마이크 음성을 whisper.cpp로 전사하고, LLM이 주제 블록을 감지해 브라우저에 슬라이드를 한 장씩 밀어줍니다.
>
> Real-time meeting slides: Korean speech → whisper.cpp STT → LLM topic-block detection → live slides pushed to your browser over WebSocket.

![stack](https://img.shields.io/badge/runtime-Bun-black) ![stt](https://img.shields.io/badge/STT-whisper.cpp-green) ![ui](https://img.shields.io/badge/UI-vanilla%20JS-blue)

## 동작 방식

```
마이크 (또는 오디오 파일)
   │  whisper-stream / whisper-cli (whisper.cpp, 한국어)
   ▼
전사 문장 스트림 ── src/whisper.ts ── ANSI/메타/중복 필터링
   │
   ▼
MeetingSession (src/session.ts)
   ├─ 실시간 자막 (200ms 디바운스)
   └─ N문장마다 LLM 블록 감지 (src/llm.ts, OpenAI-compatible)
        ├─ 주제 전환 + hysteresis(연속 2회) → 새 슬라이드 push
        └─ LLM 장애 시 로컬 규칙 fallback 요약
   ▼
WebSocket /ws ── public/app.js ── 슬라이드·자막·히스토리 렌더
```

- **슬라이드 히스테리시스**: LLM이 "주제 바뀜"을 연속 2회 말해야 실제로 장표를 넘겨서, 오판 스팸을 막습니다.
- **LLM 장애 내성**: API가 죽어도 로컬 규칙 기반 요약으로 계속 동작합니다.
- **로컬 전용 설계**: 서버는 localhost만 바인드하고, WebSocket 업그레이드 시 Origin을 검사해 다른 웹페이지가 전사 내용을 엿보지 못하게 막습니다(CSWSH 방어).

## 요구 사항

- [Bun](https://bun.sh) ≥ 1.x
- [whisper.cpp](https://github.com/ggml-org/whisper.cpp) 바이너리 2개:
  ```bash
  brew install whisper.cpp   # whisper-stream, whisper-cli 제공
  ```
- ggml 모델 파일 (medium 권장, 한국어 품질은 large-v3가 더 좋음):
  ```bash
  mkdir -p models
  curl -L -o models/ggml-medium.bin \
    https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin
  ```
- LLM 프로바이더 1개 (택일):
  - **구독 서비스 CLI** — API 키 없이 구독 인증 재사용: `claude`(Claude Pro/Max) 또는 `codex`(ChatGPT)
  - **Alibaba Token Plan (Bailian)** — GLM-5.2
  - **OpenAI** — gpt-4o-mini 등
  - **로컬 llama.cpp 서버** — API 키 없이 완전 오프라인 가능

## 설치 및 설정

```bash
git clone https://github.com/dltdnfrk/meeting-slides.git
cd meeting-slides
bun install
cp .env.example .env   # 열어서 LLM 키 등을 채워 넣기
```

`.env` 핵심 항목:

| 변수 | 설명 | 기본값 |
|---|---|---|
| `LLM_PROVIDER` | `alibaba` \| `openai` \| `local` \| `cli` | `alibaba` |
| `ALIBABA_TOKEN_PLAN_API_KEY` | Alibaba 키 (`sk-sp-...`) | — |
| `LLM_CLI_BIN` | `cli` 모드 백엔드 CLI (`claude`/`codex`, 구독 인증) | `claude` |
| `LLM_CLI_TIMEOUT_MS` | `cli` 모드 호출 상한 (ms) | `120000` |
| `WHISPER_MODEL_PATH` | ggml 모델 경로 | `./models/ggml-medium.bin` |
| `WHISPER_CAPTURE_ID` | 캡처 장치 ID (`-1`=기본 마이크) | `-1` |
| `WHISPER_STEP_MS` | 오디오 스텝(ms). 작을수록 실시간성↑ 정확도↓ | `3000` |
| `BLOCK_DETECT_SENTENCE_INTERVAL` | LLM 호출 간격(문장 수) | `4` |
| `BLOCK_CONTEXT_WINDOW` | LLM에 보낼 최근 문장 수 | `12` |
| `HTTP_PORT` | 웹 UI 포트 | `8787` |

> **cli 모드 팁**: CLI는 호출마다 기동 비용(수 초)이 들므로 `BLOCK_DETECT_SENTENCE_INTERVAL=8` 정도로 올리는 걸 권장합니다.

## 실행

```bash
# 마이크 실시간 모드 (브라우저 자동 오픈)
bun run dev

# 캡처 장치 목록 확인 (기본 마이크가 아닐 때)
bun run devices

# 오디오 파일로 데모/테스트 (마이크 불필요)
bun run server.ts --file ./sample.m4a
```

브라우저에서 `http://localhost:8787` 접속 후 발언을 시작하면:

- 하단 **아일랜드**에 실시간 자막이 흐르고
- 주제가 잡히면 **슬라이드**가 만들어지고, 주제가 바뀌면 새 장으로 넘어갑니다
- 왼쪽 **히스토리** 썸네일을 클릭하면 지난 슬라이드 미리보기 (재클릭·Esc·안내 바 클릭 시 라이브 복귀)
- **Markdown / JSON 저장**으로 회의록 다운로드
- **초기화**로 세션 리셋

## 프로젝트 구조

```
server.ts        HTTP + WebSocket + 세션 오케스트레이션 (진입점)
src/config.ts    환경 설정 로더 (엄격한 검증)
src/whisper.ts   whisper-stream/cli 자식 프로세스 + stdout 파서
src/llm.ts       OpenAI-compatible 클라이언트 + 블록 감지
src/session.ts   회의 상태 머신 (자막 디바운스, 슬라이드 hysteresis)
public/          바닐라 JS 클라이언트 (슬라이드 스테이지 + 필름스트립)
```

## 보안 메모

- LLM API 키는 `.env`에만 두고 커밋하지 않습니다 (`.gitignore`에 포함).
- WebSocket `/ws`는 `Origin` 헤더가 서버 자신과 다르면 403으로 거부합니다.
- 정적 파일 서빙은 `public/` 디렉터리 밖으로 나갈 수 없습니다.

## License

MIT
