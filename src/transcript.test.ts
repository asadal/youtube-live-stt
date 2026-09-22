import { describe, expect, it } from "vitest";
import { formatElapsedTime, serializeDiarizedSegments, serializeTranscripts } from "./transcript";

const transcripts = [
  { text: "첫 번째 기록", receivedAt: "2026-09-21T10:20:30.000Z" },
  { text: "두 번째 기록", receivedAt: "2026-09-21T10:20:35.000Z" },
];

describe("serializeTranscripts", () => {
  it("텍스트만 내보낸다", () => {
    expect(serializeTranscripts(transcripts, false)).toBe("첫 번째 기록\n두 번째 기록");
  });

  it("선택하면 각 기록의 타임스탬프를 포함한다", () => {
    const result = serializeTranscripts(transcripts, true);
    expect(result).toContain("첫 번째 기록");
    expect(result).toContain("두 번째 기록");
    expect(result.match(/\[/g)).toHaveLength(2);
  });
});

describe("serializeDiarizedSegments", () => {
  it("경과 시간과 화자 이름을 포함한다", () => {
    expect(formatElapsedTime(3661.9)).toBe("01:01:01");
    expect(serializeDiarizedSegments([{
      speaker: "A",
      text: "회의를 시작하겠습니다.",
      start: 1,
      end: 4.2,
      chunkIndex: 0,
    }])).toBe("[00:00:01–00:00:04] A: 회의를 시작하겠습니다.");
  });
});
