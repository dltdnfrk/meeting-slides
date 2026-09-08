import { resolve, sep } from "node:path";

/**
 * URL 경로를 public 디렉터리 안의 실제 파일 경로로 바꾼다.
 *
 * `path.join(publicDir, "/index.html")`이 POSIX에서 `/index.html`로 리셋되는
 * 함정을 피하려고, 요청 경로를 퍼센트 디코딩한 뒤 leading slash를 떼고
 * `resolve()`로 조합한다. `..`나 절대 경로로 public 밖으로 나가면 null을
 * 돌려준다. 탐색뿐 아니라 NUL 바이트도 거부한다.
 */
export function resolvePublicFile(publicDir: string, requestPath: string): string | null {
  if (requestPath.length === 0) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return null;
  }
  const clean = decoded.replace(/\0/g, "");
  const relative = clean.replace(/^[/\\]+/, "");
  const filePath = resolve(publicDir, relative);
  if (filePath !== publicDir && !filePath.startsWith(`${publicDir}${sep}`)) {
    return null;
  }
  return filePath;
}
