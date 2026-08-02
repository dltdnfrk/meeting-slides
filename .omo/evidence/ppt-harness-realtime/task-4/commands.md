# Task 4 — Live stage MeetingCard renderer + CSS

Worktree: /Users/hyunjun/Documents/MUNI/meeting-slides-worktree-ppt-harness
Parent commit: 3f46a1708307ea71bea5f096bd649df37a2a6aa8
Date: 2026-08-02T12:45:03Z

## Commands

### bun test tests/public-shell.test.ts
```

tests/public-shell.test.ts:
(pass) 라이브 MeetingCard 렌더 > 슬라이드가 없으면 플레이스홀더를 유지한다 [18.17ms]
(pass) 라이브 MeetingCard 렌더 > kicker/emphasis 포함 카드가 모두 렌더된다 [5.55ms]
(pass) 라이브 MeetingCard 렌더 > 375px 폭에서 가로 오버플로가 없다 [3.28ms]
(pass) 라이브 MeetingCard 렌더 > kicker/emphasis 없는 레거시 슬라이드도 제목/불릿만으로 렌더된다 [1.34ms]
(pass) 라이브 MeetingCard 렌더 > 불릿이 비어도 제목 카드가 깨지지 않는다 [1.02ms]
(pass) 라이브 MeetingCard 렌더 > 히스토리 미리보기에서도 같은 카드 레이아웃을 쓴다 [44.12ms]
(pass) HTML 이스케이프 > 모델 텍스트의 마크업이 실행되지 않는다 [1.58ms]

 7 pass
 0 fail
 26 expect() calls
Ran 7 tests across 1 file. [1455.00ms]
```

### bun test (full suite)
```

 87 pass
 0 fail
 267 expect() calls
Ran 87 tests across 13 files. [2.01s]
```

### bunx tsc -p tsconfig.json --noEmit
```
exit=0
```

### git diff --check
```
exit=0
```

### product JS syntax
```
app.js syntax OK
```
