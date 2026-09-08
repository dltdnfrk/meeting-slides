const NOISE = /^(?:[\s\p{P}\p{S}]|um+|uh+|hmm+|mm+|ok(?:ay)?|yes|yeah|yep|no|thanks?|thank\s+you|hello|hi|bye|네+|예+|음+|어+|아+|감사합니다?|고맙습니다?|안녕하세요|좋아요|알겠습니다)+$/iu;

export function hasUsableTranscript(
  lines: readonly { readonly text: string }[],
): boolean {
  return lines.some((line) => {
    const text = line.text.trim();
    return text.length > 0 && /[\p{L}\p{N}]/u.test(text) && !NOISE.test(text);
  });
}
