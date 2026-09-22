import { randomUUID } from "node:crypto";
import type {
  TranscriptionEngine,
  TranscriptionEngineCallbacks,
} from "./transcription-engine.js";

const SAMPLE_RATE = 16_000;
const BYTES_PER_SAMPLE = 2;
const MIN_FLUSH_SECONDS = 0.5;
const OVERLAP_SECONDS = 1;
const REQUEST_TIMEOUT_MS = 120_000;

type Delay = "minimal" | "low" | "medium" | "high" | "xhigh";

export interface LocalWhisperOptions {
  serverUrl: string;
  prompt: string;
  keywords: string[];
  delay: Delay;
}

const chunkSeconds: Record<Delay, number> = {
  minimal: 4,
  low: 6,
  medium: 8,
  high: 12,
  xhigh: 16,
};

export function createWav(pcm: Buffer, sampleRate = SAMPLE_RATE): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * BYTES_PER_SAMPLE;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(BYTES_PER_SAMPLE, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function comparableToken(token: string): string {
  return token.toLocaleLowerCase("ko-KR").replace(/[\s.,!?…~·'"“”‘’()[\]{}:;\-]/g, "");
}

export function removeRepeatedOverlap(previous: string, current: string): string {
  const previousWords = previous.trim().split(/\s+/).filter(Boolean);
  const currentWords = current.trim().split(/\s+/).filter(Boolean);
  const maximum = Math.min(16, previousWords.length, currentWords.length);
  for (let length = maximum; length >= 2; length -= 1) {
    const previousTail = previousWords.slice(-length).map(comparableToken).join("|");
    const currentHead = currentWords.slice(0, length).map(comparableToken).join("|");
    if (previousTail === currentHead) return currentWords.slice(length).join(" ").trim();
  }
  return current.trim();
}

export class LocalWhisperEngine implements TranscriptionEngine {
  readonly sampleRate = SAMPLE_RATE;

  private pcm = Buffer.alloc(0);
  private processing = Promise.resolve();
  private previousTranscript = "";
  private stopping = false;
  private readonly windowBytes: number;
  private readonly overlapBytes = SAMPLE_RATE * BYTES_PER_SAMPLE * OVERLAP_SECONDS;

  constructor(
    private readonly options: LocalWhisperOptions,
    private readonly callbacks: TranscriptionEngineCallbacks,
  ) {
    this.windowBytes = SAMPLE_RATE * BYTES_PER_SAMPLE * chunkSeconds[options.delay];
  }

  async start(): Promise<void> {
    const response = await fetch(new URL("/", this.options.serverUrl), {
      signal: AbortSignal.timeout(5_000),
    }).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`로컬 Whisper 서버에 연결할 수 없습니다: ${detail}`);
    });
    if (!response.ok) throw new Error(`로컬 Whisper 서버 상태 오류 (${response.status})`);
    this.callbacks.onReady();
  }

  appendAudio(chunk: Buffer): void {
    if (this.stopping || chunk.length === 0) return;
    this.pcm = Buffer.concat([this.pcm, chunk]);
    this.queueCompleteWindows();
  }

  async flush(): Promise<void> {
    this.queueCompleteWindows();
    const minimumBytes = SAMPLE_RATE * BYTES_PER_SAMPLE * MIN_FLUSH_SECONDS;
    if (this.pcm.length >= minimumBytes) {
      const remaining = this.pcm;
      this.pcm = Buffer.alloc(0);
      this.queueTranscription(remaining);
    }
    await this.processing;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.flush();
  }

  private queueCompleteWindows(): void {
    while (this.pcm.length >= this.windowBytes) {
      const window = this.pcm.subarray(0, this.windowBytes);
      const overlap = window.subarray(Math.max(0, window.length - this.overlapBytes));
      this.pcm = Buffer.concat([overlap, this.pcm.subarray(this.windowBytes)]);
      this.queueTranscription(window);
    }
  }

  private queueTranscription(pcm: Buffer): void {
    this.processing = this.processing
      .then(() => this.transcribe(pcm))
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        this.callbacks.onError(detail);
      });
  }

  private async transcribe(pcm: Buffer): Promise<void> {
    const wav = createWav(pcm);
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "realtime.wav");
    form.append("language", "ko");
    form.append("response_format", "json");
    form.append("temperature", "0.0");
    form.append("temperature_inc", "0.2");
    form.append("no_timestamps", "true");
    form.append("suppress_non_speech", "true");
    const prompt = [
      this.options.prompt,
      this.options.keywords.length ? `주요 용어: ${this.options.keywords.join(", ")}` : "",
      this.previousTranscript ? `직전 문맥: ${this.previousTranscript.slice(-300)}` : "",
    ].filter(Boolean).join("\n");
    if (prompt) {
      form.append("prompt", prompt);
      form.append("carry_initial_prompt", "true");
    }

    const response = await fetch(new URL("/inference", this.options.serverUrl), {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`로컬 Whisper 전사 오류 (${response.status}): ${body.slice(0, 300)}`);

    let text = body;
    try {
      const payload = JSON.parse(body) as { text?: unknown; error?: unknown };
      if (payload.error) throw new Error(String(payload.error));
      text = String(payload.text ?? "");
    } catch (error) {
      if (error instanceof SyntaxError) text = body;
      else throw error;
    }
    text = text.replace(/\s+/g, " ").trim();
    if (!text) return;
    const novelText = removeRepeatedOverlap(this.previousTranscript, text);
    this.previousTranscript = text;
    if (!novelText) return;
    this.callbacks.onFinal({ itemId: randomUUID(), text: novelText });
  }
}
