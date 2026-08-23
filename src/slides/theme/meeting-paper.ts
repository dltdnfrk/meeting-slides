import type { Theme } from "../model/plan.ts";
import { deepFreeze } from "./immutable.ts";

export type StyleProfile = Readonly<Theme>;

export const MEETING_PAPER_STYLE_PROFILE: StyleProfile = deepFreeze({
  id: "meeting-paper-v1",
  canvas: { width: 1280, height: 720 },
  font: {
    family: "Pretendard Variable",
    localPath: "fonts/pretendard-variable.woff2",
    sha256: "9599f12fd42fc0bce1cd50b47a0c022e108d7aa64dd0d1bb0ed44f3282d900b4",
  },
  colors: {
    paper: "F6F1E8",
    raised: "FFFDF8",
    ink: "14213D",
    muted: "5B6475",
    rule: "D9D2C4",
    coral: "AD4B2F",
    blue: "335C81",
    focus: "1E5AA8",
  },
  spacing: { xs: 8, sm: 16, md: 24, lg: 48, xl: 80 },
  typography: {
    display: { size: 64, lineHeight: 68, weight: 700 },
    heading: { size: 36, lineHeight: 42, weight: 700 },
    body: { size: 22, lineHeight: 30, weight: 400 },
    label: { size: 16, lineHeight: 20, weight: 600 },
  },
  stroke: { thin: 1, strong: 3 },
  radius: { small: 8, large: 24 },
});
