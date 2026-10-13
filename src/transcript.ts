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

export const SENTENCES_PER_PARAGRAPH = 3;

function countSentences(text: string): number {
  return Math.max(1, text.match(/[.?!。？！](?=\s|$)/g)?.length ?? 0);
}

// 연속된 확정 기록을 문장 수 기준으로 묶어 3~4문장 단락을 만든다. 단락 시각은 첫 기록의 시각이다.
export function groupIntoParagraphs<T extends DownloadableTranscript>(
  transcripts: T[],
  minSentences = SENTENCES_PER_PARAGRAPH,
): (DownloadableTranscript & { id: number })[] {
  const paragraphs: (DownloadableTranscript & { id: number })[] = [];
  let current: (DownloadableTranscript & { id: number }) | undefined;
  let sentences = 0;
  transcripts.forEach((item, index) => {
    if (!current) {
      current = { id: index, text: item.text, receivedAt: item.receivedAt };
      paragraphs.push(current);
    } else {
      current.text = `${current.text} ${item.text}`;
    }
    sentences += countSentences(item.text);
    if (sentences >= minSentences) {
      current = undefined;
      sentences = 0;
    }
  });
  return paragraphs;
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
