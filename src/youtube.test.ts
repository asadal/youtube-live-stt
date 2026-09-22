import { describe, expect, it } from "vitest";
import { getYouTubeVideoId } from "./youtube";

describe("getYouTubeVideoId", () => {
  it.each([
    ["https://www.youtube.com/watch?v=abcdefghijk", "abcdefghijk"],
    ["https://youtu.be/abcdefghijk", "abcdefghijk"],
    ["https://www.youtube.com/live/abcdefghijk", "abcdefghijk"],
    ["https://www.youtube.com/embed/abcdefghijk", "abcdefghijk"],
  ])("%s에서 영상 ID를 추출한다", (url, expected) => {
    expect(getYouTubeVideoId(url)).toBe(expected);
  });

  it("다른 도메인과 잘못된 ID를 거부한다", () => {
    expect(getYouTubeVideoId("https://example.com/watch?v=abcdefghijk")).toBeUndefined();
    expect(getYouTubeVideoId("https://www.youtube.com/watch?v=short")).toBeUndefined();
  });
});
