import { describe, expect, it } from "vitest";
import {
  AUDIO_TURN_BYTES,
  MIN_AUDIO_TURN_BYTES,
  createSessionUpdate,
  shouldCommitAudioTurn,
  shouldForwardAudio,
  TranscriptionSession,
  type SessionOptions,
} from "./transcription-session.js";

const options: SessionOptions = {
  engine: "openai",
  source: "youtube",
  youtubeUrl: "https://www.youtube.com/watch?v=abcdefghijk",
  prompt: "한국어 뉴스 생방송",
  keywords: ["한겨레", "생성형 AI"],
  delay: "low",
  recordAudio: true,
};

describe("createSessionUpdate", () => {
  it("gpt-live-transcribe에서 지원하지 않는 turn detection을 끈다", () => {
    const event = createSessionUpdate(options);

    expect(event.session.audio.input.turn_detection).toBeNull();
    expect(event.session.audio.input.transcription.model).toBe("gpt-live-transcribe");
    expect(event.session.audio.input.transcription.languages).toEqual(["ko"]);
  });

  it("빈 선택 설정을 API 요청에서 생략한다", () => {
    const event = createSessionUpdate({ ...options, prompt: "", keywords: [] });

    expect(event.session.audio.input.transcription.prompt).toBeUndefined();
    expect(event.session.audio.input.transcription.keywords).toBeUndefined();
  });
});

describe("audio turn size", () => {
  it("24kHz mono PCM16 오디오 5초에 해당한다", () => {
    expect(MIN_AUDIO_TURN_BYTES).toBe(4_800);
    expect(AUDIO_TURN_BYTES).toBe(240_000);
    expect(shouldCommitAudioTurn(AUDIO_TURN_BYTES - 1)).toBe(false);
    expect(shouldCommitAudioTurn(AUDIO_TURN_BYTES)).toBe(true);
  });

  it("실시간 상태에서만 오디오를 전송한다", () => {
    expect(shouldForwardAudio("live")).toBe(true);
    expect(shouldForwardAudio("paused")).toBe(false);
    expect(shouldForwardAudio("stopped")).toBe(false);
  });
});

describe("session snapshot security", () => {
  it("사용자 API 키를 세션 응답에 포함하지 않는다", () => {
    const session = new TranscriptionSession(options, { openAIApiKey: "sk-secret-test-key" });
    expect(JSON.stringify(session.getSnapshot())).not.toContain("sk-secret-test-key");
  });
});
