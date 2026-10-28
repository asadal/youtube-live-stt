import { describe, expect, it } from "vitest";
import { createAnalysisRequest, parseSonarResponse, resolvePerplexityApiKey } from "./perplexity.js";

describe("resolvePerplexityApiKey", () => {
  it(".env 키가 있으면 화면에서 입력한 키보다 먼저 쓴다", () => {
    expect(resolvePerplexityApiKey("pplx-env", "pplx-user")).toBe("pplx-env");
  });

  it(".env 키가 없으면 화면에서 입력한 키를 쓴다", () => {
    expect(resolvePerplexityApiKey(" ", " pplx-user ")).toBe("pplx-user");
    expect(resolvePerplexityApiKey(undefined, "")).toBeUndefined();
  });
});

describe("createAnalysisRequest", () => {
  it("sonar-pro 모델로 요청하고, 요약은 웹 검색을 끈다", () => {
    const request = createAnalysisRequest("summary", "오늘 회의를 시작합니다.", []);
    expect(request.model).toBe("sonar-pro");
    expect(request.disable_search).toBe(true);
    expect(request.messages[0].role).toBe("system");
    expect(request.messages[1].content).toContain("오늘 회의를 시작합니다.");
  });

  it("팩트체크와 용어 교정은 웹 검색을 쓰고, 교정에는 주요 용어를 넣는다", () => {
    expect(createAnalysisRequest("fact-check", "본문", []).disable_search).toBe(false);
    const correction = createAnalysisRequest("correction", "본문", ["한겨레", "생성형 AI"]);
    expect(correction.disable_search).toBe(false);
    expect(correction.messages[1].content).toContain("한겨레, 생성형 AI");
  });
});

describe("parseSonarResponse", () => {
  it("본문과 함께 [1] 번호 순서 그대로 출처를 꺼낸다", () => {
    const result = parseSonarResponse({
      choices: [{ message: { content: " 결과 [1][2] " } }],
      search_results: [{ title: "기사 A", url: "https://a.example" }, { title: "", url: "https://b.example" }],
    });
    expect(result).toEqual({
      text: "결과 [1][2]",
      sources: [{ title: "기사 A", url: "https://a.example" }, { title: "https://b.example", url: "https://b.example" }],
    });
  });

  it("search_results가 없으면 citations URL을 출처로 쓴다", () => {
    const result = parseSonarResponse({ choices: [{ message: { content: "결과" } }], citations: ["https://a.example"] });
    expect(result.sources).toEqual([{ title: "https://a.example", url: "https://a.example" }]);
  });

  it("오류 응답은 메시지를 담아 예외로 던진다", () => {
    expect(() => parseSonarResponse({ error: { message: "invalid api key" } })).toThrow("invalid api key");
  });
});
