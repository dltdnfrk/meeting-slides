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
bun install
cp .env.example .env   # 열어서 LLM 키 등을 채워 넣기
```

`.env` 핵심 항목:

| 변수 | 설명 | 기본값 |
|---|---|---|
| `LLM_PROVIDER` | `openai` \| `local` \| `cli` | `cli` |
| `OPENAI_API_KEY` | OpenAI API 키 | — |
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

### macOS 앱으로 실행 (권장)

```bash
bun install
bash scripts/build-app.sh
bash scripts/verify-app.sh "$HOME/Applications/Meeting Slides.app"
open -a "Meeting Slides"
```

빌드는 `$HOME/Applications/Meeting Slides.app`을 만들고 저장소 루트의
`Meeting Slides.app` 심볼릭 링크를 같은 앱으로 연결합니다. 앱은 로컬 Bun 서버를
기동하고 전체 작업 공간을 기본 브라우저에 열며, 메뉴 막대와 네이티브 미니바에는
녹음 상태·타이머·최근 발언·Stop만 투영합니다. 회의 목록, Notes, Transcript, Ask,
검토, 설정과 내보내기는 브라우저 작업 공간에서 사용합니다.

최초 실행 시 Gatekeeper가 막으면 Finder에서 앱을 우클릭해 **열기**를 선택하고,
마이크 및 캘린더 권한 요청은 사용할 기능에 맞게 승인합니다. 앱 번들은 현재
체크아웃의 `server.ts`와 정적 자산을 사용하므로 소스를 이동한 뒤에는 다시
빌드합니다.

### 터미널에서 실행

```bash
# 마이크 실시간 모드 (브라우저 자동 오픈)
bun run dev

# 캡처 장치 목록 확인 (기본 마이크가 아닐 때)
bun run devices

# 오디오 파일로 데모/테스트 (마이크 불필요)
bun run server.ts --file ./sample.m4a
```

브라우저에서 `http://localhost:8787` 접속하면:

- Library의 회의 목록에서 Overview, Notes, Transcript 탭을 전환합니다.
- **녹음 시작**으로 Live 작업 공간에 들어가며, 16:9 슬라이드와 확정 전사가 함께 표시됩니다.
- Live의 **Stop**과 서버 기준 타이머는 시작·녹음·중지 처리 중 계속 보입니다.
- 설정에서 사용 가능한 LLM 프로바이더와 음성 인식 모델을 선택합니다.
- **만들기·저장·내보내기**에서 PowerPoint 초안과 Markdown, JSON, 전사, 웹 슬라이드, PDF, PNG를 생성합니다.
- Ask, 참석자 지정과 회의록 검토는 선택한 회의의 실제 서버 작업을 사용합니다.

> 문장 분할 품질: 한국어 STT는 구두점이 자주 빠지므로, 미완결 조각을 보류해 다음 조각과 병합하는 어셈블러가 전사 파이프라인에 내장돼 있습니다(완결 구두점·화자 전환·60자 상한·종료 시 방출).

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
