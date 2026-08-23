# F4 M1 installed native-material direct capture

**Terminal verdict: PASS**

Canonical root: `/Users/hyunjun/Documents/MUNI/meeting-slides`  
Installed app: `/Users/hyunjun/Applications/Meeting Slides.app`  
Installed executable SHA-256: `7847745f6d94512434c6ac41e3e3352e5c33825aa3c9f921fc8613d86b8e5281`

## Installed artifact

A fresh `scripts/build-app.sh` run completed with exit 0 and retained the expected repaired executable hash. `scripts/verify-app.sh` passed, and `codesign --verify --deep --strict --verbose=2` reported the bundle valid on disk and satisfying its designated requirement. Bundle id is `com.meetingslides.app`, short version `0.3.0`, bundle version `3`.

## Direct installed pixels

I personally inspected the three exact-hash PNG crops. Each was produced from an immediate full-display `/usr/sbin/screencapture -x`, followed by a one-shot `CGWindowListCopyWindowInfo(.optionOnScreenOnly)` inventory and a Retina 2x `sips` crop with 16 logical points of surrounding context.

- `01-collapsed-idle.png`: repaired ambient HUD material is directly visible at the exact `1136,854,360,56` window bounds. The 16pt rounded silhouette, restrained one-pixel perimeter treatment, soft native shadow, and readable idle/disclosure labels are visible.
- `02-collapsed-live.png`: the exact same repaired material and unchanged `1136,854,360,56` geometry are directly visible. The immediate screenshot landed before the live projection paint; the subsequent same-run AX receipt records `녹음 중`, caption, `05:38`, enabled Stop help, and disclosure semantics. This timing does not weaken M1 material closure because the installed material pixels themselves are direct, and the expanded capture below directly shows the live projection.
- `03-expanded-live.png`: repaired material is directly visible at exact `936,690,560,220` bounds. Background purple visibly influences the translucent HUD at the right while the left remains neutrally ambient. The 16pt corners and restrained stroke/shadow remain intact. `녹음 중`, timer, Stop, collapse, and workspace labels are readable. The transcript is a clearly raised darker layer with three readable speaker lines and the live caption.

Together these installed pixels directly close M1: the former opaque white surface is absent; the native HUD is visibly ambient/translucent, rounded, restrained, readable, and layered without geometry drift.

## AX and state receipts

The three AX receipts record `AXWindow`, `AXGroup`, `AXStaticText`, and `AXButton` roles. Help is present for actionable controls:

- idle Stop: `중지할 녹음이 없습니다`;
- live Stop: `진행 중인 녹음을 중지합니다`;
- expand: `최근 발언과 작업 공간 열기를 함께 봅니다`;
- collapse: `미니바를 한 줄 높이로 접습니다`;
- workspace: `브라우저에서 전체 작업 공간을 엽니다`.

The expanded receipt also records all three semantic transcript labels. Each independent run used direct System Events menu-bar `AXPress` actions, and the expanded run used the proven disclosure `AXPress`.

## Isolation and cleanup

Each state used its own isolated adopted localhost server on port 54831 and its own temporary project marker/state. No microphone input, user database, or external API was used. All three state cleanup receipts report exit 0, marker/default restoration, port free, and app process gone. Final inspection confirmed the canonical marker, no app process, no listener on port 54831, the exact executable hash above, passing bundle verification, and strict codesign.
