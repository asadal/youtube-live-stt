import { describe, expect, it } from "vitest";
import { formatElapsedTime, groupIntoParagraphs, serializeDiarizedSegments, serializeTranscripts } from "./transcript";

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

describe("groupIntoParagraphs", () => {
  const at = (second: number) => `2026-09-21T10:20:${String(second).padStart(2, "0")}.000Z`;

  it("짧은 기록을 3문장 이상 단락으로 묶고 첫 기록 시각을 쓴다", () => {
    const result = groupIntoParagraphs([
      { text: "안녕하세요.", receivedAt: at(1) },
      { text: "오늘 회의를 시작합니다.", receivedAt: at(2) },
      { text: "첫 안건은 예산입니다. 자료를 보시죠.", receivedAt: at(3) },
      { text: "다음 단락의 시작입니다.", receivedAt: at(4) },
    ]);
    expect(result.map((item) => item.text)).toEqual([
      "안녕하세요. 오늘 회의를 시작합니다. 첫 안건은 예산입니다. 자료를 보시죠.",
      "다음 단락의 시작입니다.",
    ]);
    expect(result[0].receivedAt).toBe(at(1));
    expect(result[1].receivedAt).toBe(at(4));
  });

  it("문장부호가 없는 기록도 한 문장으로 센다", () => {
    const result = groupIntoParagraphs([
      { text: "첫째", receivedAt: at(1) },
      { text: "둘째", receivedAt: at(2) },
      { text: "셋째", receivedAt: at(3) },
      { text: "넷째", receivedAt: at(4) },
    ]);
    expect(result.map((item) => item.text)).toEqual(["첫째 둘째 셋째", "넷째"]);
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
