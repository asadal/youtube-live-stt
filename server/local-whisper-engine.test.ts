import { createServer } from "node:http";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { LocalWhisperEngine, createWav, removeRepeatedOverlap } from "./local-whisper-engine.js";

describe("createWav", () => {
  it("16kHz mono PCM16 WAV 헤더를 만든다", () => {
    const pcm = Buffer.alloc(32_000);
    const wav = createWav(pcm);

    expect(wav.subarray(0, 4).toString()).toBe("RIFF");
    expect(wav.subarray(8, 12).toString()).toBe("WAVE");
    expect(wav.readUInt32LE(24)).toBe(16_000);
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.readUInt32LE(40)).toBe(pcm.length);
  });
});

describe("removeRepeatedOverlap", () => {
  it("겹친 앞부분을 제거한다", () => {
    expect(removeRepeatedOverlap(
      "오늘 회의에서는 인공지능 정책을 논의합니다",
      "인공지능 정책을 논의합니다 다음 안건입니다",
    )).toBe("다음 안건입니다");
  });

  it("공통 구간이 없으면 원문을 유지한다", () => {
    expect(removeRepeatedOverlap("첫 문장입니다", "새 문장입니다")).toBe("새 문장입니다");
  });
});

describe("LocalWhisperEngine", () => {
  it("whisper.cpp 서버의 JSON 전사를 확정 이벤트로 전달한다", async () => {
    const server = createServer((request, response) => {
      if (request.url === "/") {
        response.end("ready");
        return;
      }
      request.resume();
      request.on("end", () => {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ text: "안녕하세요 반갑습니다" }));
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("테스트 서버 주소를 확인할 수 없습니다.");
    const finalTexts: string[] = [];
    const errors: string[] = [];
    const engine = new LocalWhisperEngine({
      serverUrl: `http://127.0.0.1:${address.port}`,
      prompt: "한국어 인터뷰",
      keywords: [],
      delay: "minimal",
    }, {
      onReady: () => undefined,
      onPartial: () => undefined,
      onFinal: (event) => finalTexts.push(event.text),
      onError: (message) => errors.push(message),
    });

    try {
      await engine.start();
      engine.appendAudio(Buffer.alloc(16_000));
      await engine.stop();
      expect(errors).toEqual([]);
      expect(finalTexts).toEqual(["안녕하세요 반갑습니다"]);
    } finally {
      server.close();
      await once(server, "close");
    }
  });
});
