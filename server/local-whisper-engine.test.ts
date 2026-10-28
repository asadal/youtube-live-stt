import { createServer } from "node:http";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import {
  LocalWhisperEngine,
  addSentencePunctuation,
  createWav,
  findQuietCut,
  parseWhisperResponse,
  removeRepeatedOverlap,
  resolveOverlap,
} from "./local-whisper-engine.js";

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

  it("어절 중간에서 잘린 겹침도 제거한다", () => {
    expect(removeRepeatedOverlap(
      "이제 회의를 시작하겠습니다.",
      "하겠습니다. 첫 안건은 예산입니다",
    )).toBe("첫 안건은 예산입니다");
  });

  it("직전 구간 끝이 조금 달라도 겹친 앞부분을 제거한다", () => {
    expect(removeRepeatedOverlap(
      "인공지능 정책을 논의합니다 음",
      "정책을 논의합니다 다음 안건입니다",
    )).toBe("다음 안건입니다");
  });

  it("짧은 우연한 일치는 제거하지 않는다", () => {
    expect(removeRepeatedOverlap("그래서 시작합니다", "다 같이 봅시다")).toBe("다 같이 봅시다");
  });

  it("공통 구간이 없으면 원문을 유지한다", () => {
    expect(removeRepeatedOverlap("첫 문장입니다", "새 문장입니다")).toBe("새 문장입니다");
  });
});

function tone(seconds: number, amplitude: number): Buffer {
  const pcm = Buffer.alloc(Math.round(seconds * 16_000) * 2);
  for (let offset = 0; offset < pcm.length; offset += 2) {
    pcm.writeInt16LE(Math.round(amplitude * Math.sin(offset / 2 / 8)), offset);
  }
  return pcm;
}

describe("findQuietCut", () => {
  it("구간 끝부분의 말이 끊긴 지점에서 자른다", () => {
    const pcm = Buffer.concat([tone(5, 8_000), tone(0.5, 0), tone(1, 8_000)]);
    const cut = findQuietCut(pcm, 6 * 32_000);
    expect(cut).toBeGreaterThanOrEqual(5 * 32_000);
    expect(cut).toBeLessThanOrEqual(5.5 * 32_000);
  });

  it("단어 사이의 짧은 틈에서는 자르지 않는다", () => {
    const pcm = Buffer.concat([tone(5, 8_000), tone(0.1, 0), tone(1, 8_000)]);
    expect(findQuietCut(pcm, 6 * 32_000)).toBeUndefined();
  });

  it("계속 말하고 있으면 자를 지점이 없다", () => {
    expect(findQuietCut(tone(6, 8_000), 6 * 32_000)).toBeUndefined();
  });
});

describe("resolveOverlap", () => {
  const scored = (text: string, probability: number) => ({
    text,
    probabilities: Array.from(text.replace(/[\s.]/g, ""), () => probability),
  });

  it("단어가 달라진 겹침에서 현재 구간의 신뢰도가 높으면 직전 구간을 고친다", () => {
    const result = resolveOverlap(scored("오늘 회의를 시작하겠슴니다", 0.5), scored("회의를 시작하겠습니다 첫 안건입니다", 0.9));
    expect(result.previous?.text).toBe("오늘 회의를 시작하겠습니다");
    expect(result.current.text).toBe("첫 안건입니다");
  });

  it("직전 구간의 신뢰도가 높으면 직전 구간을 그대로 두고 겹침만 지운다", () => {
    const result = resolveOverlap(scored("오늘 회의를 시작하겠습니다", 0.9), scored("회의를 시작하겠슴니다 첫 안건입니다", 0.5));
    expect(result.previous).toBeUndefined();
    expect(result.current.text).toBe("첫 안건입니다");
  });

  it("신뢰도를 모르면 직전 구간을 유지한다", () => {
    const result = resolveOverlap({ text: "오늘 회의를 시작하겠슴니다" }, { text: "회의를 시작하겠습니다 첫 안건입니다" });
    expect(result.previous).toBeUndefined();
    expect(result.current.text).toBe("첫 안건입니다");
  });

  it("비슷하지 않은 문장은 지우지 않는다", () => {
    expect(resolveOverlap({ text: "첫 문장입니다" }, { text: "새 문장입니다" }).current.text).toBe("새 문장입니다");
  });
});

describe("addSentencePunctuation", () => {
  it("종결어미 뒤에 빠진 마침표와 물음표를 붙인다", () => {
    expect(addSentencePunctuation("오늘 회의를 시작하겠습니다 첫 안건은 예산입니다 자료를 보시죠 질문이 있으신가요"))
      .toBe("오늘 회의를 시작하겠습니다. 첫 안건은 예산입니다. 자료를 보시죠. 질문이 있으신가요?");
  });

  it("이미 있는 문장부호와 문장 중간 어절은 그대로 둔다", () => {
    expect(addSentencePunctuation("네, 좋습니다. 그래서 다 같이 갑니까?")).toBe("네, 좋습니다. 그래서 다 같이 갑니까?");
  });
});

describe("parseWhisperResponse", () => {
  it("verbose_json 토큰 확률을 글자별로 펼친다", () => {
    const result = parseWhisperResponse(JSON.stringify({
      text: " 안녕 하세요.",
      segments: [{ words: [{ word: " 안녕", probability: 0.9 }, { word: " 하세요.", probability: 0.6 }] }],
    }));
    expect(result).toEqual({ text: "안녕 하세요.", probabilities: [0.9, 0.9, 0.6, 0.6, 0.6] });
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
      expect(finalTexts).toEqual(["안녕하세요. 반갑습니다."]);
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("프롬프트에 라벨 문구를 넣지 않고, 프롬프트를 따라 쓴 문장은 기록에서 뺀다", async () => {
    const replies = ["오늘 회의를 시작합니다", "한국어 인터뷰. 인공지능, 정책. 첫 안건입니다"];
    const prompts: string[] = [];
    const server = createServer(async (request, response) => {
      if (request.url === "/") {
        response.end("ready");
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const form = await new Response(Buffer.concat(chunks), { headers: { "content-type": request.headers["content-type"]! } }).formData();
      // multipart 전송 중 줄바꿈이 \r\n으로 바뀐다.
      prompts.push(String(form.get("prompt")).replace(/\r\n/g, "\n"));
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ text: replies.shift() }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("테스트 서버 주소를 확인할 수 없습니다.");
    const finalTexts: string[] = [];
    const engine = new LocalWhisperEngine({
      serverUrl: `http://127.0.0.1:${address.port}`,
      prompt: "한국어 인터뷰",
      keywords: ["인공지능", "정책"],
      delay: "minimal",
    }, {
      onReady: () => undefined,
      onPartial: () => undefined,
      onFinal: (event) => finalTexts.push(event.text),
      onError: (message) => { throw new Error(message); },
    });

    try {
      await engine.start();
      engine.appendAudio(tone(6, 8_000));
      await engine.stop();
      expect(prompts).toEqual([
        "한국어 인터뷰.\n인공지능, 정책.",
        "한국어 인터뷰.\n인공지능, 정책.\n오늘 회의를 시작합니다.",
      ]);
      expect(finalTexts).toEqual(["오늘 회의를 시작합니다.", "첫 안건입니다."]);
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("겹친 오디오가 더 정확하게 다시 인식되면 같은 itemId로 직전 기록을 고친다", async () => {
    const replies = [
      { text: "오늘 회의를 시작하겠슴니다", probability: 0.4 },
      { text: "회의를 시작하겠습니다 첫 안건입니다", probability: 0.9 },
    ];
    const server = createServer((request, response) => {
      if (request.url === "/") {
        response.end("ready");
        return;
      }
      request.resume();
      request.on("end", () => {
        const reply = replies.shift()!;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          text: reply.text,
          segments: [{ words: reply.text.split(" ").map((word) => ({ word: ` ${word}`, probability: reply.probability })) }],
        }));
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("테스트 서버 주소를 확인할 수 없습니다.");
    const finals: { itemId: string; text: string }[] = [];
    const engine = new LocalWhisperEngine({
      serverUrl: `http://127.0.0.1:${address.port}`,
      prompt: "",
      keywords: [],
      delay: "minimal",
    }, {
      onReady: () => undefined,
      onPartial: () => undefined,
      onFinal: (event) => finals.push(event),
      onError: (message) => { throw new Error(message); },
    });

    try {
      await engine.start();
      // 쉬지 않고 말하는 6초: 4초 구간을 자른 뒤 1초를 겹쳐 남은 3초와 함께 보낸다.
      engine.appendAudio(tone(6, 8_000));
      await engine.stop();
      expect(finals.map((event) => event.text)).toEqual([
        "오늘 회의를 시작하겠슴니다.",
        "오늘 회의를 시작하겠습니다.",
        "첫 안건입니다.",
      ]);
      expect(finals[1].itemId).toBe(finals[0].itemId);
      expect(finals[2].itemId).not.toBe(finals[0].itemId);
    } finally {
      server.close();
      await once(server, "close");
    }
  });
});
