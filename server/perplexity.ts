// sonar-pro는 Agent API(/v1/agent)에서 지원하지 않아 Sonar 엔드포인트를 쓴다.
const PERPLEXITY_SONAR_URL = "https://api.perplexity.ai/v1/sonar";
const PERPLEXITY_MODEL = "sonar-pro";
const REQUEST_TIMEOUT_MS = 180_000;

export type AnalysisTask = "summary" | "fact-check" | "correction";

export interface AnalysisSource {
  title: string;
  url: string;
}

export interface AnalysisResult {
  text: string;
  sources: AnalysisSource[];
}

// 서버 .env 키를 먼저 쓰고, 없을 때만 화면에서 입력한 키를 쓴다.
export function resolvePerplexityApiKey(envKey: string | undefined, userKey: string | undefined): string | undefined {
  return envKey?.trim() || userKey?.trim() || undefined;
}

const instructions: Record<AnalysisTask, string> = {
  summary: [
    "너는 한국어 녹취록을 정리하는 편집자다.",
    "녹취록에 있는 내용만 사용하고 추측이나 외부 정보를 덧붙이지 않는다.",
    "다음 형식으로 답한다: 한 문단 요약, 핵심 내용 글머리표, 결정 사항·후속 과제(없으면 생략).",
  ].join("\n"),
  "fact-check": [
    "너는 한국어 녹취록의 사실 관계를 검증하는 팩트체커다.",
    "녹취록에서 확인할 수 있는 사실 주장(수치, 날짜, 인물, 기관, 사건)을 골라 웹 검색으로 확인한다.",
    "주장마다 '주장 / 판정(사실·대체로 사실·오류·확인 불가) / 근거'를 적고 근거에는 출처 번호를 붙인다.",
    "의견이나 감상은 검증 대상에서 뺀다.",
  ].join("\n"),
  correction: [
    "너는 음성 인식으로 만든 한국어 녹취록의 용어와 고유명사를 교정하는 교열자다.",
    "잘못 인식된 것으로 보이는 인명, 기관명, 지명, 제품명, 전문 용어를 웹 검색으로 확인해 바로잡는다.",
    "문장 구조나 말투는 바꾸지 않고 용어 표기만 고친다. 확신이 없으면 고치지 않는다.",
    "먼저 '교정 목록'에 '원문 → 교정 (근거)'를 적고, 이어서 '교정본'에 고친 녹취록 전체를 적는다.",
  ].join("\n"),
};

export function createAnalysisRequest(task: AnalysisTask, transcript: string, keywords: string[]) {
  const keywordLine = task === "correction" && keywords.length
    ? `참고할 주요 용어: ${keywords.join(", ")}\n\n`
    : "";
  return {
    model: PERPLEXITY_MODEL,
    messages: [
      { role: "system", content: instructions[task] },
      { role: "user", content: `${keywordLine}녹취록:\n${transcript}` },
    ],
    // 요약은 녹취록만으로 충분하므로 웹 검색을 끈다.
    disable_search: task === "summary",
  };
}

type SonarResponse = {
  error?: { message?: unknown } | string;
  choices?: { message?: { content?: unknown } }[];
  citations?: unknown[];
  search_results?: { title?: unknown; url?: unknown }[];
};

// 본문의 [1], [2] 번호가 search_results 순서를 가리키므로 순서를 바꾸거나 중복을 지우지 않는다.
export function parseSonarResponse(payload: SonarResponse): AnalysisResult {
  if (payload.error) {
    const message = typeof payload.error === "string" ? payload.error : payload.error.message;
    throw new Error(`Perplexity API 오류: ${String(message ?? "알 수 없는 오류")}`);
  }
  const text = String(payload.choices?.[0]?.message?.content ?? "").trim();
  if (!text) throw new Error("Perplexity 응답에 결과 텍스트가 없습니다.");
  const results = payload.search_results?.length
    ? payload.search_results
    : (payload.citations ?? []).map((url) => ({ url }));
  const sources = results
    .map((result) => ({ title: String(("title" in result && result.title) || result.url || ""), url: String(result.url ?? "") }))
    .filter((source) => source.url);
  return { text, sources };
}

export async function analyzeTranscript(
  apiKey: string,
  task: AnalysisTask,
  transcript: string,
  keywords: string[],
): Promise<AnalysisResult> {
  const response = await fetch(PERPLEXITY_SONAR_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(createAnalysisRequest(task, transcript, keywords)),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await response.text();
  let payload: SonarResponse;
  try {
    payload = JSON.parse(body) as SonarResponse;
  } catch {
    throw new Error(`Perplexity API 오류 (${response.status}): ${body.slice(0, 300)}`);
  }
  if (!response.ok && !payload.error) payload.error = `요청 실패 (${response.status})`;
  return parseSonarResponse(payload);
}
