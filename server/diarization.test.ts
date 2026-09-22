import { describe, expect, it } from "vitest";
import { normalizeSegments } from "./diarization.js";

describe("normalizeSegments", () => {
  it("분할 파일의 시간 오프셋과 구간 번호를 더한다", () => {
    const result = normalizeSegments({
      segments: [{ speaker: "A", text: " 안녕하세요 ", start: 1.5, end: 3.25 }],
    }, 900, 1);

    expect(result).toEqual([{
      speaker: "A",
      text: "안녕하세요",
      start: 901.5,
      end: 903.25,
      chunkIndex: 1,
    }]);
  });

  it("불완전한 세그먼트는 제외한다", () => {
    expect(normalizeSegments({ segments: [{ text: "", start: 0, end: 1 }] }, 0, 0)).toEqual([]);
  });
});
