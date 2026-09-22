import { describe, expect, it } from "vitest";
import { combineSpeakers, parseSrt, parseSrtTimestamp } from "./local-diarization.js";

describe("parseSrtTimestamp", () => {
  it("SRT 시간을 초로 변환한다", () => {
    expect(parseSrtTimestamp("00:01:02,500")).toBe(62.5);
  });
});

describe("parseSrt", () => {
  it("청크 오프셋을 포함한 문장 구간을 만든다", () => {
    const result = parseSrt("1\n00:00:01,000 --> 00:00:03,250\n안녕하세요.", 480, 1);
    expect(result).toEqual([{ start: 481, end: 483.25, text: "안녕하세요.", chunkIndex: 1 }]);
  });
});

describe("combineSpeakers", () => {
  it("가장 오래 겹친 화자를 문장에 배정하고 이름을 안정적으로 바꾼다", () => {
    const result = combineSpeakers([
      { start: 1, end: 4, text: "첫 문장", chunkIndex: 0 },
      { start: 4, end: 7, text: "두 번째 문장", chunkIndex: 0 },
      { start: 7, end: 9, text: "세 번째 문장", chunkIndex: 0 },
    ], [
      { start: 0, end: 3.5, speaker: "SPEAKER_02" },
      { start: 3.5, end: 8, speaker: "SPEAKER_01" },
    ]);
    expect(result.map((segment) => segment.speaker)).toEqual(["화자 1", "화자 2", "화자 2"]);
  });
});
