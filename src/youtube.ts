const YOUTUBE_HOSTS = ["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"];

export function getYouTubeVideoId(value: string): string | undefined {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    let candidate: string | null = null;

    if (host === "youtu.be") {
      candidate = url.pathname.split("/").filter(Boolean)[0] ?? null;
    } else if (YOUTUBE_HOSTS.includes(host)) {
      candidate = url.searchParams.get("v");
      if (!candidate) {
        const parts = url.pathname.split("/").filter(Boolean);
        if (["live", "embed", "shorts"].includes(parts[0])) candidate = parts[1] ?? null;
      }
    }

    return candidate && /^[A-Za-z0-9_-]{11}$/.test(candidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
}
