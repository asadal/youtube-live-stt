const ALLOWED_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
]);

export function parseYouTubeUrl(value: string): URL {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error("올바른 유튜브 URL을 입력해 주세요.");
  }

  if (url.protocol !== "https:" || !ALLOWED_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error("HTTPS 유튜브 URL만 사용할 수 있습니다.");
  }

  return url;
}

export function sanitizeKeywords(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => !/[<>\r\n]/.test(item))
    .slice(0, 50);
}
