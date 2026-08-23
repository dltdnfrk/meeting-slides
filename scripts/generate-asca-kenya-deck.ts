import pptxgen from "pptxgenjs";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const pptx = new pptxgen();
pptx.layout = "LAYOUT_WIDE";
pptx.author = "NeoBio";
pptx.company = "NeoBio";
pptx.subject = "케냐–한국 예방적 식물보건 협력 제안";
pptx.title = "보이지 않는 위험 신호를 보다 · 건강한 작물을 함께 지키다";
pptx.lang = "ko-KR";
pptx.theme = {
  headFontFace: "Apple SD Gothic Neo",
  bodyFontFace: "Apple SD Gothic Neo",
  lang: "ko-KR",
};
pptx.defineSlideMaster({
  title: "LIGHT",
  background: { color: "F5F2E9" },
  objects: [
    { line: { x: 0.58, y: 7.08, w: 12.18, h: 0, line: { color: "D5DED8", width: 0.7 } } },
    { text: { text: "NEOBIO · ASCA WEEK 2026", options: { x: 0.62, y: 7.13, w: 3.5, h: 0.16, fontFace: "Aptos", fontSize: 6.5, color: "78908A", bold: true, charSpacing: 1.2, margin: 0 } } },
  ],
  slideNumber: { x: 12.12, y: 7.11, w: 0.6, h: 0.18, fontFace: "Aptos", fontSize: 7, color: "78908A", align: "right", margin: 0 },
});

const C = {
  forest: "073A34",
  deep: "0A4A40",
  teal: "23B5A0",
  mint: "91D8C8",
  lime: "C6E887",
  cream: "F5F2E9",
  paper: "FFFDF8",
  ink: "17332E",
  muted: "637771",
  line: "D5DED8",
  red: "D96255",
  gold: "E4B95D",
  white: "FFFFFF",
};
const F = "Apple SD Gothic Neo";
const A = "Aptos";
const SW = 13.333;
const SH = 7.5;

function addText(slide: any, text: string, x: number, y: number, w: number, h: number, options: Record<string, unknown> = {}) {
  slide.addText(text, {
    x, y, w, h, fontFace: F, fontSize: 18, color: C.ink, margin: 0,
    breakLine: false, valign: "mid", fit: "shrink", ...options,
  });
}

function addKicker(slide: any, index: string, label: string, dark = false) {
  addText(slide, index, 0.64, 0.42, 0.43, 0.22, { fontFace: A, fontSize: 8.5, bold: true, color: dark ? C.lime : C.teal, charSpacing: 1.2 });
  slide.addShape(pptx.ShapeType.line, { x: 1.12, y: 0.525, w: 0.33, h: 0, line: { color: dark ? "4C786F" : "B7CBC4", width: 1 } });
  addText(slide, label.toUpperCase(), 1.56, 0.42, 4.4, 0.22, { fontFace: A, fontSize: 8.5, bold: true, color: dark ? C.mint : C.muted, charSpacing: 1.4 });
}

function addTitle(slide: any, title: string, subtitle?: string, dark = false) {
  addText(slide, title, 0.64, 0.86, 11.9, 0.72, { fontSize: 27, bold: true, color: dark ? C.white : C.ink, breakLine: true, valign: "top", lineSpacingMultiple: 0.92 });
  if (subtitle) addText(slide, subtitle, 0.66, 1.62, 11.2, 0.38, { fontSize: 11.5, color: dark ? "B8D0CA" : C.muted, valign: "top" });
}

function addPill(slide: any, text: string, x: number, y: number, w: number, fill: string, color: string) {
  slide.addShape(pptx.ShapeType.roundRect, { x, y, w, h: 0.33, rectRadius: 0.08, fill: { color: fill }, line: { color: fill } });
  addText(slide, text, x + 0.08, y + 0.02, w - 0.16, 0.28, { fontFace: A, fontSize: 7.5, bold: true, color, align: "center", charSpacing: 0.9 });
}

function addCell(slide: any, x: number, y: number, r: number, opacity = 22) {
  slide.addShape(pptx.ShapeType.ellipse, { x, y, w: r, h: r, fill: { color: C.teal, transparency: 100 - opacity }, line: { color: C.mint, transparency: 62, width: 1 } });
  slide.addShape(pptx.ShapeType.ellipse, { x: x + r * 0.34, y: y + r * 0.31, w: r * 0.27, h: r * 0.27, fill: { color: C.lime, transparency: 22 }, line: { color: C.lime, transparency: 100 } });
}

function addNotes(slide: any, note: string) {
  slide.addNotes(note);
}

// 01 — Cover
{
  const s = pptx.addSlide();
  s.background = { color: C.forest };
  s.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: SW, h: SH, fill: { color: C.forest }, line: { color: C.forest } });
  s.addShape(pptx.ShapeType.arc, { x: 8.6, y: -1.4, w: 5.8, h: 5.8, adjustPoint: 0.28, rotate: 22, fill: { color: C.forest, transparency: 100 }, line: { color: "2B8174", transparency: 36, width: 1.4 } });
  s.addShape(pptx.ShapeType.arc, { x: 8.95, y: -0.7, w: 4.65, h: 4.65, adjustPoint: 0.2, rotate: 184, fill: { color: C.forest, transparency: 100 }, line: { color: C.teal, transparency: 47, width: 1 } });
  addCell(s, 9.35, 1.2, 1.05, 32);
  addCell(s, 10.88, 2.35, 1.55, 25);
  addCell(s, 9.45, 4.35, 0.72, 30);
  addCell(s, 11.82, 5.27, 0.48, 34);
  s.addShape(pptx.ShapeType.line, { x: 9.85, y: 1.73, w: 1.72, h: 1.38, line: { color: C.mint, transparency: 58, width: 1.1, beginArrowType: "none", endArrowType: "none" } });
  s.addShape(pptx.ShapeType.line, { x: 10.1, y: 4.72, w: 1.94, h: 0.8, line: { color: C.mint, transparency: 62, width: 1 } });
  addPill(s, "ASCA WEEK 2026", 0.72, 0.63, 1.72, "124C45", C.lime);
  addText(s, "보이지 않는 위험 신호를 보다", 0.72, 1.5, 7.65, 0.72, { fontSize: 30, bold: true, color: C.white });
  addText(s, "건강한 작물을 함께 지키다", 0.72, 2.28, 7.65, 0.72, { fontSize: 30, bold: true, color: C.lime });
  addText(s, "의과학 세포 이미징에서 출발한 예방적 식물보건 협력", 0.75, 3.34, 7.2, 0.38, { fontSize: 13.5, color: "C0D9D3" });
  s.addShape(pptx.ShapeType.line, { x: 0.74, y: 4.08, w: 5.95, h: 0, line: { color: "4D786F", width: 0.8 } });
  addText(s, "케냐–한국 예방적 식물보건 협력 제안", 0.74, 4.38, 6.85, 0.42, { fontSize: 17, bold: true, color: C.white });
  addText(s, "MIRIVA · Fluorescence imaging probe", 0.74, 5.02, 5.9, 0.3, { fontFace: A, fontSize: 10, color: C.mint, charSpacing: 0.7 });
  addText(s, "홍현준 대표 · 네오바이오", 0.74, 6.55, 4.7, 0.28, { fontSize: 10.5, color: "C0D9D3" });
  addText(s, "KENYA × KOREA", 10.16, 6.7, 2.35, 0.22, { fontFace: A, fontSize: 8.5, bold: true, color: C.lime, align: "right", charSpacing: 1.7 });
  addNotes(s, "ASCA Week 2026에 초청해 주셔서 감사합니다. 네오바이오는 의과학 분야의 세포 이미징 프로브 기술을 농업에 적용하고 있는 한국의 바이오 스타트업입니다. 오늘은 제품 소개에 그치지 않고, 케냐의 전문성과 저희 기술이 만나 어떤 예방적 식물보건 협력을 만들 수 있을지 제안드리고자 합니다. 건강한 작물은 건강한 먹거리와 건강한 삶의 시작입니다.");
}

// 02 — Who we are
{
  const s = pptx.addSlide("LIGHT");
  addKicker(s, "01", "WHO WE ARE");
  addTitle(s, "보이지 않는 생물학적 신호를\n형광으로 보여줍니다", "네오바이오는 의과학 이미징 기술을 농업과 식물보건으로 확장합니다.");
  s.addShape(pptx.ShapeType.roundRect, { x: 0.66, y: 2.35, w: 5.25, h: 3.95, rectRadius: 0.08, fill: { color: C.forest }, line: { color: C.forest } });
  addText(s, "NEOBIO", 1.0, 2.73, 2.5, 0.3, { fontFace: A, fontSize: 11, bold: true, color: C.lime, charSpacing: 2 });
  addText(s, "의과학 세포 이미징에서\n출발한 형광 프로브 기술", 1.0, 3.25, 4.35, 1.05, { fontSize: 23, bold: true, color: C.white, breakLine: true, valign: "top" });
  addText(s, "특정 생물학적 표적과 반응하는 분자를 설계하고,\n그 반응을 빛의 신호로 읽습니다.", 1.0, 4.62, 4.28, 0.73, { fontSize: 12, color: "C1D8D2", breakLine: true, valign: "top", lineSpacingMultiple: 1.1 });
  addPill(s, "SCIENCE → FIELD", 1.0, 5.64, 1.72, "154F47", C.mint);

  const steps = [
    ["01", "표적을 인식하는\n프로브 설계", C.teal],
    ["02", "형광 신호로\n시각화", C.mint],
    ["03", "현장에서 쓰는\n도구로 개발", C.lime],
  ] as const;
  steps.forEach(([n, t, color], i) => {
    const x = 6.45 + i * 2.05;
    s.addShape(pptx.ShapeType.ellipse, { x: x + 0.46, y: 2.72, w: 1.08, h: 1.08, fill: { color, transparency: 78 }, line: { color, width: 1.4 } });
    s.addShape(pptx.ShapeType.ellipse, { x: x + 0.82, y: 3.08, w: 0.36, h: 0.36, fill: { color }, line: { color } });
    addText(s, n, x, 4.17, 2.0, 0.22, { fontFace: A, fontSize: 8, bold: true, color: C.teal, align: "center", charSpacing: 1.2 });
    addText(s, t, x, 4.55, 2.0, 0.72, { fontSize: 14, bold: true, color: C.ink, align: "center", breakLine: true, valign: "top" });
    if (i < 2) s.addShape(pptx.ShapeType.chevron, { x: x + 1.86, y: 3.09, w: 0.35, h: 0.35, fill: { color: "B7C9C3" }, line: { color: "B7C9C3" } });
  });
  addText(s, "핵심은 ‘진단 결과’가 아니라, 보이지 않던 신호를 관찰 가능한 정보로 바꾸는 것입니다.", 6.56, 5.75, 5.65, 0.44, { fontSize: 11.5, color: C.muted, italic: true, align: "center" });
  addNotes(s, "네오바이오의 핵심 역량은 특정 생물학적 표적과 반응하는 형광 프로브를 설계하는 것입니다. 이 기술은 의과학 분야에서 세포와 생물학적 신호를 관찰하던 연구에서 출발했습니다. 저희는 보이지 않던 신호를 관찰 가능한 정보로 바꾸고, 그 기술을 연구실 밖의 농업 현장에서도 활용할 수 있는 형태로 개발하고 있습니다.");
}

// 03 — Challenge
{
  const s = pptx.addSlide("LIGHT");
  addKicker(s, "02", "OUR CHALLENGE");
  addTitle(s, "우리는 ‘진단 이전’의 예방 단계에\n도전하고 있습니다", "진단을 대체하는 것이 아니라, 위험의 이동을 더 일찍 줄이는 방법을 연구합니다.");
  const y = 3.2;
  s.addShape(pptx.ShapeType.line, { x: 1.12, y: y + 0.42, w: 11.0, h: 0, line: { color: "AFC5BE", width: 2 } });
  const points = [
    { x: 1.22, tag: "접촉", title: "도구·표면", sub: "위험은 이동할 수 있습니다", color: C.teal },
    { x: 4.08, tag: "관찰", title: "초기 위험 신호", sub: "육안으로는 놓치기 쉽습니다", color: C.mint },
    { x: 6.94, tag: "증상", title: "이상 징후", sub: "전문적 확인이 필요합니다", color: C.gold },
    { x: 9.8, tag: "공식", title: "진단·대응", sub: "권한 있는 기관이 수행합니다", color: C.red },
  ];
  points.forEach((p, i) => {
    s.addShape(pptx.ShapeType.ellipse, { x: p.x, y, w: 0.82, h: 0.82, fill: { color: p.color }, line: { color: C.paper, width: 3 } });
    addText(s, String(i + 1), p.x, y + 0.01, 0.82, 0.79, { fontFace: A, fontSize: 13, bold: true, color: i < 3 ? C.forest : C.white, align: "center" });
    addPill(s, p.tag, p.x - 0.05, y - 0.65, 0.92, i < 2 ? "DCEFEA" : "F1E8D4", i < 2 ? C.deep : "8A6531");
    addText(s, p.title, p.x - 0.42, y + 1.08, 1.66, 0.34, { fontSize: 13.5, bold: true, align: "center" });
    addText(s, p.sub, p.x - 0.62, y + 1.53, 2.05, 0.52, { fontSize: 9.5, color: C.muted, align: "center", breakLine: true, valign: "top" });
  });
  s.addShape(pptx.ShapeType.roundRect, { x: 0.92, y: 5.75, w: 5.92, h: 0.76, rectRadius: 0.08, fill: { color: "DDF1EC" }, line: { color: "B6DCD3", width: 1 } });
  addText(s, "예방의 기회", 1.2, 5.97, 1.25, 0.28, { fontSize: 11, bold: true, color: C.deep });
  addText(s, "증상이 나타나기 전, 접촉 지점과 위생 행동을 관리합니다.", 2.55, 5.97, 3.9, 0.28, { fontSize: 10.5, color: C.deep });
  s.addShape(pptx.ShapeType.roundRect, { x: 7.1, y: 5.75, w: 5.12, h: 0.76, rectRadius: 0.08, fill: { color: "F1E8E0" }, line: { color: "E3C8BB", width: 1 } });
  addText(s, "진단의 역할", 7.4, 5.97, 1.25, 0.28, { fontSize: 11, bold: true, color: "7D443B" });
  addText(s, "의심 사례를 확인하고 공식 대응을 결정합니다.", 8.76, 5.97, 3.05, 0.28, { fontSize: 10.5, color: "7D443B" });
  addNotes(s, "식물에서 이상 증상이 확인된 뒤에는 전문기관의 진단과 공식 대응이 반드시 필요합니다. 하지만 위험은 증상이 보이기 전에도 도구와 표면, 묘목 취급 과정, 반복되는 작업 동선을 따라 이동할 수 있습니다. 한국에서 화상병 문제를 경험하며 저희가 주목한 것도 바로 이 지점이었습니다. 진단을 더 빠르게 하는 것만큼, 진단 이전의 예방 행동을 더 일관되게 만드는 것도 중요하다고 보았습니다.");
}

// 04 — Why Kenya
{
  const s = pptx.addSlide("LIGHT");
  addKicker(s, "03", "WHY KENYA — WHY TOGETHER");
  addTitle(s, "케냐의 전문성과 함께\n시작하고자 합니다", "새로운 체계를 가져오는 것이 아니라, 이미 갖춘 역량과 연결되는 도구를 함께 검토합니다.");
  const cards = [
    { x: 0.7, n: "01", title: "식물검역과 연구 기반", sub: "전문기관과 공식 진단 체계", metric: "SCIENCE", color: C.teal },
    { x: 4.52, n: "02", title: "건전 재식재료 경험", sub: "조직배양·증식·건강한 묘목 관리", metric: "CLEAN PLANT", color: C.mint },
    { x: 8.34, n: "03", title: "원예산업 경쟁력", sub: "생산과 수출을 연결하는 농업 생태계", metric: "FIELD", color: C.lime },
  ];
  cards.forEach((c) => {
    s.addShape(pptx.ShapeType.roundRect, { x: c.x, y: 2.38, w: 3.48, h: 3.53, rectRadius: 0.08, fill: { color: C.paper }, line: { color: C.line, width: 1 } });
    s.addShape(pptx.ShapeType.rect, { x: c.x, y: 2.38, w: 3.48, h: 0.08, fill: { color: c.color }, line: { color: c.color } });
    addText(s, c.n, c.x + 0.3, 2.75, 0.5, 0.24, { fontFace: A, fontSize: 9, bold: true, color: C.teal, charSpacing: 1 });
    s.addShape(pptx.ShapeType.ellipse, { x: c.x + 2.5, y: 2.72, w: 0.55, h: 0.55, fill: { color: c.color, transparency: 66 }, line: { color: c.color, width: 1.2 } });
    s.addShape(pptx.ShapeType.ellipse, { x: c.x + 2.71, y: 2.93, w: 0.13, h: 0.13, fill: { color: c.color }, line: { color: c.color } });
    addText(s, c.title, c.x + 0.3, 3.55, 2.85, 0.58, { fontSize: 17, bold: true, breakLine: true, valign: "top" });
    addText(s, c.sub, c.x + 0.3, 4.44, 2.82, 0.68, { fontSize: 11.5, color: C.muted, breakLine: true, valign: "top" });
    addPill(s, c.metric, c.x + 0.3, 5.27, 1.35, "E8F1ED", C.deep);
  });
  s.addShape(pptx.ShapeType.roundRect, { x: 2.5, y: 6.2, w: 8.34, h: 0.5, rectRadius: 0.06, fill: { color: C.forest }, line: { color: C.forest } });
  addText(s, "KENYA의 현장 경험  ×  NEOBIO의 이미징 기술  =  공동검증", 2.75, 6.31, 7.84, 0.26, { fontFace: A, fontSize: 10.5, bold: true, color: C.white, align: "center", charSpacing: 0.2 });
  addNotes(s, "케냐는 경쟁력 있는 농업과 원예산업뿐 아니라, KEPHIS를 중심으로 식물검역과 연구, 공식 진단을 수행할 기반을 갖추고 있습니다. 건강한 묘목과 증식재를 생산하고 관리해 온 경험도 풍부합니다. 따라서 저희가 케냐에 새로운 체계를 가르치려는 것은 아닙니다. 케냐가 이미 가진 전문성과 현장 경험에 네오바이오의 형광 이미징 기술을 더해, 기존 체계와 연결되는 예방 도구를 함께 검토하고자 합니다.");
}

// 05 — The gap + MIRIVA
{
  const s = pptx.addSlide();
  s.background = { color: C.forest };
  addKicker(s, "04", "THE OPPORTUNITY", true);
  addTitle(s, "공식 진단 이전에 함께 보완할 수 있는\n예방 단계가 있습니다", undefined, true);
  const items = ["작업 도구와\n접촉 표면", "묘목·증식재\n취급 과정", "사람과 장비의\n반복 작업 동선"];
  items.forEach((text, i) => {
    const x = 0.72 + i * 2.23;
    s.addShape(pptx.ShapeType.roundRect, { x, y: 2.25, w: 1.92, h: 1.65, rectRadius: 0.07, fill: { color: "124A43" }, line: { color: "386D64", width: 1 } });
    addText(s, `0${i + 1}`, x + 0.2, 2.5, 0.42, 0.2, { fontFace: A, fontSize: 7.5, bold: true, color: C.lime, charSpacing: 1 });
    addText(s, text, x + 0.2, 2.93, 1.52, 0.66, { fontSize: 13, bold: true, color: C.white, breakLine: true, valign: "top" });
  });
  addText(s, "위험은 보이지 않아도\n접촉을 따라 이동할 수 있습니다.", 0.74, 4.38, 6.2, 0.9, { fontSize: 20, bold: true, color: C.white, breakLine: true, valign: "top" });
  addText(s, "그래서 네오바이오는 ‘확진’이 아닌\n예방 행동을 위한 표적 위험 선별을 제안합니다.", 0.76, 5.55, 5.6, 0.72, { fontSize: 12.5, color: "BDD5CF", breakLine: true, valign: "top" });

  s.addShape(pptx.ShapeType.roundRect, { x: 7.42, y: 1.7, w: 5.15, h: 4.93, rectRadius: 0.09, fill: { color: C.paper }, line: { color: C.paper } });
  addText(s, "MIRIVA", 7.8, 2.05, 1.55, 0.32, { fontFace: A, fontSize: 15, bold: true, color: C.deep, charSpacing: 1.8 });
  addText(s, "현장 선별 개념", 9.22, 2.08, 2.2, 0.26, { fontSize: 10.5, color: C.muted });
  const proc = [
    { x: 7.82, title: "적용", sub: "도구·표면·식물체에\n프로브 분무", color: C.teal },
    { x: 9.43, title: "반응", sub: "약 10분간\n반응·자연건조", color: C.mint },
    { x: 11.04, title: "관찰", sub: "365nm 광원으로\n형광 확인", color: C.lime },
  ];
  proc.forEach((p, i) => {
    s.addShape(pptx.ShapeType.ellipse, { x: p.x, y: 2.78, w: 0.9, h: 0.9, fill: { color: p.color, transparency: 62 }, line: { color: p.color, width: 1.5 } });
    s.addShape(pptx.ShapeType.ellipse, { x: p.x + 0.32, y: 3.1, w: 0.26, h: 0.26, fill: { color: p.color }, line: { color: p.color } });
    addText(s, p.title, p.x - 0.16, 3.9, 1.22, 0.3, { fontSize: 13, bold: true, color: C.ink, align: "center" });
    addText(s, p.sub, p.x - 0.28, 4.33, 1.46, 0.7, { fontSize: 9.2, color: C.muted, align: "center", breakLine: true, valign: "top" });
    if (i < 2) s.addShape(pptx.ShapeType.chevron, { x: p.x + 1.14, y: 3.08, w: 0.28, h: 0.28, fill: { color: "A9BEB7" }, line: { color: "A9BEB7" } });
  });
  s.addShape(pptx.ShapeType.roundRect, { x: 7.82, y: 5.42, w: 4.34, h: 0.77, rectRadius: 0.06, fill: { color: "E4F1ED" }, line: { color: "C4DED7" } });
  addText(s, "현재 검증 표적", 8.08, 5.6, 1.25, 0.22, { fontSize: 9.5, bold: true, color: C.deep });
  addText(s, "화상병균", 9.37, 5.58, 0.88, 0.24, { fontSize: 11.5, bold: true, color: C.deep });
  addText(s, "형광은 확진이 아닌 추가 조치·공식 검토를 위한 선별 신호입니다.", 7.84, 6.35, 4.38, 0.25, { fontSize: 8.8, color: "B6CEC8", italic: true, align: "center" });
  addNotes(s, "저희가 함께 살펴보고 싶은 지점은 공식 진단 이전의 접촉과 위생 단계입니다. 작업 도구와 표면, 묘목 취급 과정, 사람과 장비의 반복 동선은 일부 병원체의 이동 경로가 될 수 있습니다. MIRIVA는 프로브를 적용하고 약 10분간 반응·건조한 뒤, 365나노미터 광원 아래에서 형광을 관찰하는 방식입니다. 현재 프로브는 화상병균을 표적으로 합니다. 형광은 확진이 아니라 추가 위생 조치나 공식 확인이 필요하다는 선별 신호입니다.");
}

// 06 — Outcomes
{
  const s = pptx.addSlide("LIGHT");
  addKicker(s, "05", "SHARED OUTCOMES");
  addTitle(s, "제품 하나가 아니라,\n현장 행동의 변화를 함께 만듭니다", "협력의 가치는 기술보다 ‘확인–조치–연결’의 일관된 과정에 있습니다.");
  const outcomes = [
    { x: 0.7, n: "01", title: "예방 행동의\n표준화", sub: "확인하고, 세척하고,\n기록하는 일관된 과정", color: C.teal },
    { x: 4.52, n: "02", title: "공식 검사와의\n더 이른 연결", sub: "의심 지점을 선별하고\n권한 있는 기관으로 연결", color: C.mint },
    { x: 8.34, n: "03", title: "케냐 우선 과제의\n공동개발", sub: "현지 중요 작물·병원체를 위한\n새로운 프로브 연구", color: C.lime },
  ];
  outcomes.forEach((o) => {
    s.addShape(pptx.ShapeType.roundRect, { x: o.x, y: 2.36, w: 3.48, h: 3.43, rectRadius: 0.08, fill: { color: C.paper }, line: { color: C.line } });
    s.addShape(pptx.ShapeType.ellipse, { x: o.x + 0.3, y: 2.73, w: 0.56, h: 0.56, fill: { color: o.color }, line: { color: o.color } });
    addText(s, o.n, o.x + 0.3, 2.74, 0.56, 0.54, { fontFace: A, fontSize: 9, bold: true, color: C.forest, align: "center" });
    addText(s, o.title, o.x + 0.3, 3.58, 2.88, 0.98, { fontSize: 18.5, bold: true, breakLine: true, valign: "top" });
    addText(s, o.sub, o.x + 0.3, 4.86, 2.85, 0.73, { fontSize: 11, color: C.muted, breakLine: true, valign: "top" });
  });
  s.addShape(pptx.ShapeType.roundRect, { x: 1.35, y: 6.12, w: 10.63, h: 0.58, rectRadius: 0.07, fill: { color: C.forest }, line: { color: C.forest } });
  addText(s, "원칙", 1.68, 6.27, 0.55, 0.23, { fontFace: A, fontSize: 8, bold: true, color: C.lime, charSpacing: 1 });
  addText(s, "MIRIVA는 PCR과 공식 진단을 대체하지 않습니다. 진단과 규제 판단은 케냐의 권한 있는 기관에 있습니다.", 2.43, 6.23, 9.1, 0.3, { fontSize: 10.5, color: C.white, align: "center" });
  addNotes(s, "저희가 만들고 싶은 변화는 새로운 제품 하나를 사용하는 데 그치지 않습니다. 도구와 표면을 확인하고, 필요한 위생 조치를 취하고, 그 결과를 기록하는 과정을 더 일관되게 만드는 것이 첫 번째 목표입니다. 두 번째는 의심 지점을 더 일찍 선별해 공식 검사로 연결하는 것입니다. 장기적으로는 케냐가 중요하게 생각하는 작물과 병원체를 선정하고, 현지 과제에 맞는 프로브를 함께 연구할 수 있다고 생각합니다.");
}

// 07 — Collaboration proposal
{
  const s = pptx.addSlide("LIGHT");
  addKicker(s, "06", "COLLABORATION PROPOSAL");
  addTitle(s, "작게 검증하고,\n함께 결정합니다", "처음부터 도입을 결정하지 않습니다. 가능성과 한계를 같은 기준으로 확인합니다.");
  const stages = [
    { x: 0.72, n: "01", title: "우선 과제 공동 정의", sub: "작물 · 표적 병원체 · 사용 환경 선정", tag: "DEFINE", color: C.teal },
    { x: 4.52, n: "02", title: "소규모 공동검증", sub: "공인 검사와 비교해 성능 · 사용성 평가", tag: "VALIDATE", color: C.mint },
    { x: 8.32, n: "03", title: "다음 단계 공동 결정", sub: "기준 충족 시 현장평가 · 공동개발 검토", tag: "DECIDE", color: C.lime },
  ];
  stages.forEach((st, i) => {
    s.addShape(pptx.ShapeType.roundRect, { x: st.x, y: 2.43, w: 3.48, h: 2.72, rectRadius: 0.08, fill: { color: i === 1 ? C.forest : C.paper }, line: { color: i === 1 ? C.forest : C.line, width: 1 } });
    addPill(s, st.tag, st.x + 0.3, 2.76, 1.18, i === 1 ? "154F47" : "E5EFEB", i === 1 ? C.lime : C.deep);
    addText(s, st.n, st.x + 2.7, 2.76, 0.44, 0.24, { fontFace: A, fontSize: 9, bold: true, color: st.color, align: "right", charSpacing: 1 });
    addText(s, st.title, st.x + 0.3, 3.45, 2.85, 0.54, { fontSize: 17, bold: true, color: i === 1 ? C.white : C.ink, valign: "top" });
    addText(s, st.sub, st.x + 0.3, 4.25, 2.82, 0.54, { fontSize: 10.5, color: i === 1 ? "BED4CE" : C.muted, breakLine: true, valign: "top" });
    if (i < 2) s.addShape(pptx.ShapeType.chevron, { x: st.x + 3.58, y: 3.63, w: 0.43, h: 0.43, fill: { color: "A8BDB6" }, line: { color: "A8BDB6" } });
  });
  s.addShape(pptx.ShapeType.roundRect, { x: 1.03, y: 5.55, w: 11.26, h: 1.05, rectRadius: 0.08, fill: { color: "DFF1EC" }, line: { color: "B7DDD4", width: 1 } });
  addText(s, "TODAY’S ASK", 1.36, 5.86, 1.45, 0.22, { fontFace: A, fontSize: 8.5, bold: true, color: C.deep, charSpacing: 1.1 });
  addText(s, "구매가 아니라, 성공 기준을 먼저 합의하는 공동검증", 2.92, 5.78, 8.75, 0.39, { fontSize: 15.5, bold: true, color: C.deep, align: "center" });
  addNotes(s, "저희가 제안하는 협력은 처음부터 큰 사업이나 현장 도입을 결정하는 방식이 아닙니다. 먼저 케냐 전문가들과 중요한 작물과 병원체, 사용 환경을 함께 정의하고 싶습니다. 다음으로 제한된 환경에서 공인 검사 결과와 비교해 기술의 가능성과 한계를 검증합니다. 결과가 사전에 합의한 기준을 충족할 때 현장평가나 케냐 우선 병원체를 위한 공동개발을 검토합니다. 오늘의 제안은 구매가 아니라 성공 기준을 함께 정하는 공동검증입니다.");
}

// 08 — Closing
{
  const s = pptx.addSlide();
  s.background = { color: C.forest };
  s.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: SW, h: SH, fill: { color: C.forest }, line: { color: C.forest } });
  addCell(s, 10.08, 0.7, 1.46, 24);
  addCell(s, 11.53, 1.86, 0.78, 34);
  addCell(s, 10.76, 3.4, 1.78, 18);
  addKicker(s, "07", "NEXT CONVERSATION", true);
  addText(s, "작은 기술 대화에서\n협력을 시작하고 싶습니다", 0.7, 1.15, 7.4, 1.35, { fontSize: 30, bold: true, color: C.white, breakLine: true, valign: "top" });
  const asks = ["케냐 측 기술·연구 파트너 연결", "공동 기술 워크숍 개최", "우선 과제와 검증 기준 합의"];
  asks.forEach((ask, i) => {
    const y = 3.02 + i * 0.74;
    s.addShape(pptx.ShapeType.ellipse, { x: 0.74, y, w: 0.32, h: 0.32, fill: { color: i === 2 ? C.lime : C.teal }, line: { color: i === 2 ? C.lime : C.teal } });
    addText(s, String(i + 1), 0.74, y, 0.32, 0.31, { fontFace: A, fontSize: 7.5, bold: true, color: C.forest, align: "center" });
    addText(s, ask, 1.3, y - 0.01, 5.85, 0.34, { fontSize: 14.5, bold: true, color: C.white });
  });
  s.addShape(pptx.ShapeType.line, { x: 0.72, y: 5.57, w: 7.24, h: 0, line: { color: "49766D", width: 0.8 } });
  addText(s, "건강한 작물은", 0.72, 5.84, 2.52, 0.39, { fontSize: 18, bold: true, color: C.white });
  addText(s, "건강한 먹거리와 건강한 삶의 시작입니다.", 2.95, 5.84, 5.07, 0.39, { fontSize: 18, bold: true, color: C.lime });
  addText(s, "그 시작을 케냐와 함께 만들고 싶습니다.", 0.72, 6.35, 7.5, 0.34, { fontSize: 14, color: "C0D8D2" });
  addText(s, "홍현준 대표", 9.72, 5.54, 2.18, 0.3, { fontSize: 12.5, bold: true, color: C.white, align: "right" });
  addText(s, "NEOBIO", 9.72, 5.98, 2.18, 0.28, { fontFace: A, fontSize: 10, bold: true, color: C.lime, align: "right", charSpacing: 1.8 });
  addText(s, "www.neobio.town", 9.72, 6.43, 2.18, 0.24, { fontFace: A, fontSize: 9, color: C.mint, align: "right" });
  addNotes(s, "오늘 저희가 요청드리는 것은 제품 구매나 큰 규모의 사업 결정이 아닙니다. 먼저 케냐의 식물보건 전문가와 네오바이오가 한자리에 모여, 케냐가 중요하게 생각하는 과제를 논의하고 싶습니다. 그리고 작게 검증할 수 있는 범위와 성공 기준을 함께 정하고자 합니다. 케냐의 현장 경험과 전문성, 네오바이오의 이미징 기술이 만난다면 의미 있는 예방 도구를 함께 만들 수 있다고 생각합니다. 건강한 작물은 건강한 먹거리와 건강한 삶의 시작입니다. 감사합니다.");
}

const output = resolve(process.env.PPTX_OUTPUT ?? resolve(process.cwd(), "exports/ASCA-Week-2026_Kenya-Korea-Plant-Health_NeoBio.pptx"));
mkdirSync(dirname(output), { recursive: true });
console.log(`Writing ${output}`);
await pptx.writeFile({ fileName: output, compression: false });
console.log(output);
