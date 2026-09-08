const ALLOWED_STORY_ROLES = new Set([
  "opening", "context", "argument", "decision", "commitment", "closing",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fallbackStoryRole(layout: unknown): string {
  switch (layout) {
    case "hero": return "opening";
    case "summary": return "context";
    case "decision": return "decision";
    case "actions": return "commitment";
    default: return "argument";
  }
}

function stripPayloadPrefix(path: string): string {
  return path.startsWith("payload.") ? path.slice("payload.".length) : path;
}

function isEditorialBindingKey(layout: unknown, key: string): boolean {
  if (layout === "comparison") return /^sides\[\d+\]\.label$/.test(key);
  if (layout === "timeline") return /^events\[\d+\]\.label$/.test(key);
  return false;
}

export function sanitizeModelContent(content: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(content.slides)) return content;
  for (const slide of content.slides) {
    if (!isRecord(slide)) continue;
    const layout = slide.layout;
    if (typeof slide.storyRole === "string" && !ALLOWED_STORY_ROLES.has(slide.storyRole)) {
      slide.storyRole = fallbackStoryRole(layout);
    }
    const editorial = Array.isArray(slide.editorialPaths)
      ? slide.editorialPaths.filter((item): item is string => typeof item === "string").map(stripPayloadPrefix)
      : [];
    const seen = new Set(editorial);
    if (isRecord(slide.bindings)) {
      const bindings: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(slide.bindings)) {
        const stripped = stripPayloadPrefix(key);
        if (isEditorialBindingKey(layout, stripped)) {
          if (!seen.has(stripped)) {
            editorial.push(stripped);
            seen.add(stripped);
          }
          continue;
        }
        bindings[stripped] = value;
      }
      slide.bindings = bindings;
    }
    slide.editorialPaths = editorial;
  }
  return content;
}
