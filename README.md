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

- [Bun](https://bun.sh) **1.3.14** (`.bun-version`에 고정)
- [whisper.cpp](https://github.com/ggml-org/whisper.cpp) 바이너리 2개:
  ```bash
  brew install whisper.cpp   # whisper-stream, whisper-cli 제공
  brew install ffmpeg         # 원본 WAV 보존 및 복구용 recorder
  ```
- ggml 모델 파일 (**large-v3-turbo 권장** — large급 정확도 + 실시간 속도):
  ```bash
  mkdir -p models
  curl -L -o models/ggml-large-v3-turbo.bin \
    https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin
  ```
- LLM 프로바이더 1개 (택일):
  - **구독 서비스 CLI** — API 키 없이 구독 인증 재사용: `claude`(Claude Pro/Max) 또는 `codex`(ChatGPT)
  - **OpenAI** — gpt-4o-mini 등
  - **로컬 llama.cpp 서버** — API 키 없이 완전 오프라인 가능

## 설치 및 설정

```bash
git clone https://github.com/dltdnfrk/meeting-slides.git
cd meeting-slides
bun install --frozen-lockfile
cp .env.example .env   # 열어서 LLM 키 등을 채워 넣기
```

`.env` 핵심 항목:

| 변수 | 설명 | 기본값 |
|---|---|---|
| `LLM_PROVIDER` | `openai` \| `local` \| `cli` | `cli` |
| `OPENAI_API_KEY` | OpenAI API 키 | — |
| `LLM_CLI_BIN` | `cli` 모드 백엔드 CLI (`claude`/`codex`, 구독 인증) | `claude` |
| `LLM_CLI_TIMEOUT_MS` | `cli` 모드 호출 상한 (ms) | `120000` |
| `WHISPER_MODEL_PATH` | ggml 모델 경로 | `./models/ggml-large-v3-turbo.bin` |
| `WHISPER_CAPTURE_ID` | 캡처 장치 ID (`-1`=기본 마이크) | `-1` |
| `WHISPER_STEP_MS` | 오디오 스텝(ms). 작을수록 실시간성↑ 정확도↓ | `3000` |
| `BLOCK_DETECT_SENTENCE_INTERVAL` | LLM 호출 간격(문장 수) | `4` |
| `BLOCK_CONTEXT_WINDOW` | LLM에 보낼 최근 문장 수 | `12` |
| `HTTP_PORT` | 웹 UI 포트 | `8787` |
| `MEETING_SLIDES_AUTOMATION_TOKEN` | 선택적 calendar launcher API Bearer secret. 비우면 API 비활성 | — |

> **cli 모드 팁**: CLI는 호출마다 기동 비용(수 초)이 들므로 `BLOCK_DETECT_SENTENCE_INTERVAL=8` 정도로 올리는 걸 권장합니다.

## 지원 범위

Meeting Slides v1은 **데스크톱 로컬 웹앱**입니다.

- 공식 브라우저: Google Chrome, Aside Browser
- 기준 화면: 1440×900, 1244×836, 1180×820, 최소 1024×768
- 실행 방식: 이 저장소에서 Bun 로컬 서버를 실행한 뒤 브라우저로 접속
- 지원하지 않음: 모바일 브라우저, 모바일 앱, macOS 네이티브 앱

마이크 오디오는 브라우저의 `getUserMedia`가 아니라 로컬 Bun 서버가 실행한
`whisper-stream`/`ffmpeg`가 캡처합니다. 따라서 브라우저 권한 팝업 대신 서버를
실행한 Terminal에 macOS 마이크 권한이 필요합니다. `bun run devices`와
`WHISPER_CAPTURE_ID`로 같은 입력 장치를 명시하세요.

## 실행

```bash
# 1. 고정된 Bun/의존성 설치
bun --version  # 1.3.14
bun install --frozen-lockfile

# 2. 환경 설정
cp .env.example .env
# .env에서 LLM CLI/API, WHISPER_MODEL_PATH, WHISPER_CAPTURE_ID 확인

# 3. 마이크 장치와 모델 준비 상태 확인
bun run devices

# 4. 로컬 서버 실행
bun run dev
```

터미널에 출력된 주소(기본값 `http://localhost:8787`)를 Chrome 또는 Aside Browser로
엽니다. `.env`의 `HTTP_PORT`를 바꾸었다면 해당 포트로 접속합니다.

오디오 파일로 재현 가능한 데모를 실행할 수도 있습니다. 저장소에는 샘플 음원을
포함하지 않으므로, 사용 권한이 있는 WAV/M4A 파일 경로를 넘기세요.

```bash
bun run server.ts --file /absolute/path/to/meeting-sample.m4a
```

## v1 사용자 흐름

1. 우측 **READINESS**에서 앱 서버·AI·음성 인식이 준비 상태인지 확인합니다.
2. 필요하면 **참석자**에서 이름과 CRM ID를 등록합니다.
3. **녹음 시작**을 누르고 회의를 진행합니다.
4. Live 화면에서 한국어 전사와 슬라이드를 확인합니다.
5. **Stop**을 누르고 `중지 중` flush가 끝날 때까지 기다립니다.
6. 회의 목록에서 종료된 회의를 선택해 Overview, Notes, Transcript를 확인합니다.
7. **슬라이드 초안 만들기**로 PowerPoint/scene 슬라이드를 생성하고 filmstrip으로 탐색합니다.
8. **회의 검토**에서 근거 문장을 확인하고 결정·할 일을 적용합니다.
9. **만들기·저장·내보내기**에서 필요한 형식을 저장합니다.
10. 서버를 종료했다가 다시 실행하고 같은 회의를 선택해 전사·슬라이드가 복원되는지 확인합니다.

내보내기 결과는 저장소의 `exports/`에 생성됩니다.

| UI 항목 | 결과 |
|---|---|
| 슬라이드 초안 만들기 | 편집 가능한 `.pptx` 및 scene HTML |
| 회의 메모 | Markdown |
| 데이터 | JSON |
| 전사 원문 | Markdown |
| 웹 슬라이드 | `index.html`과 slide HTML |
| PDF | 검토용 PDF |
| 이미지 | 슬라이드별 PNG |

## 검증

```bash
bunx tsc -p tsconfig.json --noEmit
bun test
```

제품 범위 검증은 Chrome 실제 마이크 경로와 Aside 실제 UI 증거를 함께 사용합니다.
macOS 네이티브 전용 테스트는 v1 데스크톱 웹 제품 게이트에 포함하지 않습니다.

## 화자 분리 (tinydiarize, 실험적)

발화마다 화자(턴) 번호를 감지해 캡션에 색상 칩으로 표시합니다.

```bash
# 1. tdrz 모델 다운로드 (465MB)
curl -L -o models/ggml-small.en-tdrz.bin \
  https://huggingface.co/akashmjn/tinydiarize-whisper.cpp/resolve/main/ggml-small.en-tdrz.bin

# 2. .env에 추가
WHISPER_DIARIZE=true
```

**제약 (중요)**:
- tdrz 모델이 **영어 전용**이라 한국어 회의에서는 전사가 깨집니다. 한국어는 `WHISPER_DIARIZE=false`(기본값)로 두세요. 다국어 tdrz 모델이 나오면 바로 쓸 수 있게 코드는 준비돼 있습니다.
- tinydiar는 화자 "**전환 감지**"이지 "식별"이 아닙니다. 번호가 실제 인물과 1:1로 고정되지 않고 드리프트할 수 있어요(2인 회의처럼 교대 패턴이면 잘 맞습니다).

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

## 재현성과 라이선스

- 런타임은 `.bun-version`, 패키지는 exact version과 `bun.lock`으로 고정합니다. CI/릴리스 검증은 `bun install --frozen-lockfile`을 사용합니다.
- 생성물과 로컬 DB는 Git에 포함하지 않습니다. `meetings.db`는 0600, 내보내기 루트는 0700 권한으로 정규화됩니다.
- 소스 라이선스는 [MIT](./LICENSE)입니다. whisper.cpp, 모델, 폰트, slides-grab 등 제3자 구성요소는 각 라이선스를 따릅니다.
