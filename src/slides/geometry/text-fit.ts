import type {
  FitAttempt,
  FitTrace,
  TextFitPolicy,
  TextMeasurer,
} from "./contract.ts";

interface FitInput {
  readonly text: string;
  readonly width: number;
  readonly height: number;
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly policy: TextFitPolicy;
  readonly measurer: TextMeasurer;
}

function measuredWidth(
  text: string,
  fontFamily: string,
  fontSize: number,
  measurer: TextMeasurer,
): number {
  return measurer.measure({ text, fontFamily, fontSize }).width;
}

function breakWord(
  word: string,
  maxWidth: number,
  fontFamily: string,
  fontSize: number,
  measurer: TextMeasurer,
): string[] {
  const chunks: string[] = [];
  let chunk = "";
  for (const character of [...word]) {
    const candidate = chunk + character;
    if (chunk !== "" && measuredWidth(candidate, fontFamily, fontSize, measurer) > maxWidth) {
      chunks.push(chunk);
      chunk = character;
    } else {
      chunk = candidate;
    }
  }
  if (chunk !== "" || chunks.length === 0) chunks.push(chunk);
  return chunks;
}

function wrapParagraph(
  paragraph: string,
  input: FitInput,
  fontSize: number,
): string[] {
  if (paragraph === "") return [""];
  const words = paragraph.trim().split(/\s+/u);
  const lines: string[] = [];
  let line = "";

  const append = (part: string): void => {
    if (line === "") {
      line = part;
      return;
    }
    const candidate = `${line} ${part}`;
    if (measuredWidth(candidate, input.fontFamily, fontSize, input.measurer) <= input.width) {
      line = candidate;
    } else {
      lines.push(line);
      line = part;
    }
  };

  for (const word of words) {
    if (measuredWidth(word, input.fontFamily, fontSize, input.measurer) <= input.width ||
        input.policy.overflowWrap === "normal") {
      append(word);
      continue;
    }
    const chunks = breakWord(
      word, input.width, input.fontFamily, fontSize, input.measurer,
    );
    for (const chunk of chunks) append(chunk);
  }
  if (line !== "" || lines.length === 0) lines.push(line);
  return lines;
}

function linesAt(input: FitInput, fontSize: number): string[] {
  if (input.policy.mode !== "wrap") return [input.text];
  return input.text.split("\n").flatMap((paragraph) => wrapParagraph(paragraph, input, fontSize));
}

function attemptAt(input: FitInput, fontSize: number): FitAttempt {
  const lines = linesAt(input, fontSize);
  let width = 0;
  let height = 0;
  for (const line of lines) {
    const measurement = input.measurer.measure({
      text: line,
      fontFamily: input.fontFamily,
      fontSize,
    });
    width = Math.max(width, measurement.width);
    height += measurement.height;
  }
  return {
    fontSize,
    lines,
    width,
    height,
    fits: width <= input.width && height <= input.height,
  };
}

export function fitText(input: FitInput): FitTrace {
  const attempts: FitAttempt[] = [];
  const first = attemptAt(input, input.fontSize);
  attempts.push(first);

  if (first.fits) {
    const outcome = first.fontSize < input.policy.fontFloor ? "below-floor" : "fit";
    return trace(input, attempts, first, outcome);
  }
  if (input.policy.mode === "reject") {
    return trace(input, attempts, first, "rejected");
  }
  if (input.policy.mode === "wrap") {
    return trace(input, attempts, first, "overflow");
  }

  let fontSize = input.fontSize;
  let final = first;
  while (!final.fits && fontSize > 1) {
    fontSize = Math.max(1, fontSize - 1);
    final = attemptAt(input, fontSize);
    attempts.push(final);
  }
  const outcome = final.fits
    ? final.fontSize < input.policy.fontFloor ? "below-floor" : "fit"
    : "overflow";
  return trace(input, attempts, final, outcome);
}

function trace(
  input: FitInput,
  attempts: readonly FitAttempt[],
  final: FitAttempt,
  outcome: FitTrace["outcome"],
): FitTrace {
  return {
    policy: input.policy.mode,
    requestedFontSize: input.fontSize,
    finalFontSize: final.fontSize,
    fontFloor: input.policy.fontFloor,
    outcome,
    lines: final.lines,
    attempts,
  };
}
