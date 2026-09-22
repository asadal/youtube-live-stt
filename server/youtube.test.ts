import { describe, expect, it } from "vitest";
import { parseYouTubeUrl, sanitizeKeywords } from "./youtube.js";

describe("parseYouTubeUrl", () => {
  it("유튜브 라이브 URL을 허용한다", () => {
    expect(parseYouTubeUrl("https://www.youtube.com/watch?v=abc").hostname).toBe(
      "www.youtube.com",
    );
  });

  it("임의 도메인을 거부한다", () => {
    expect(() => parseYouTubeUrl("https://example.com/watch?v=abc")).toThrow();
  });
});

describe("sanitizeKeywords", () => {
  it("빈 값과 허용되지 않은 문자를 제거한다", () => {
    expect(sanitizeKeywords([" 한겨레 ", "", "<script>", 42])).toEqual(["한겨레"]);
  });
});
