export interface DownloadableTranscript {
  text: string;
  receivedAt: string;
}

export interface DownloadableDiarizedSegment {
  speaker: string;
  text: string;
  start: number;
  end: number;
  chunkIndex: number;
}

export function formatTimestamp(isoTimestamp: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(isoTimestamp));
}

export function serializeTranscripts(
  transcripts: DownloadableTranscript[],
  includeTimestamps: boolean,
): string {
  return transcripts
    .map((item) => (includeTimestamps ? `[${formatTimestamp(item.receivedAt)}] ${item.text}` : item.text))
    .join("\n");
}

export function formatElapsedTime(seconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainder = totalSeconds % 60;
  return [hours, minutes, remainder].map((value) => String(value).padStart(2, "0")).join(":");
}

export function serializeDiarizedSegments(segments: DownloadableDiarizedSegment[]): string {
  return segments.map((segment) => (
    `[${formatElapsedTime(segment.start)}–${formatElapsedTime(segment.end)}] ${segment.speaker}: ${segment.text}`
  )).join("\n");
}
