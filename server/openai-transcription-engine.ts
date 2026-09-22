import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type {
  TranscriptionEngine,
  TranscriptionEngineCallbacks,
} from "./transcription-engine.js";

const OPENAI_URL = "wss://api.openai.com/v1/realtime?intent=transcription";
export const OPENAI_SAMPLE_RATE = 24_000;
export const MIN_AUDIO_TURN_BYTES = OPENAI_SAMPLE_RATE * 2 * 0.1;
export const AUDIO_TURN_BYTES = OPENAI_SAMPLE_RATE * 2 * 5;

export interface OpenAIEngineOptions {
  prompt: string;
  keywords: string[];
  delay: "minimal" | "low" | "medium" | "high" | "xhigh";
}

export function shouldCommitAudioTurn(bufferedBytes: number): boolean {
  return bufferedBytes >= AUDIO_TURN_BYTES;
}

export function createSessionUpdate(options: OpenAIEngineOptions) {
  return {
    type: "session.update",
    session: {
      type: "transcription",
      audio: {
        input: {
          format: { type: "audio/pcm", rate: OPENAI_SAMPLE_RATE },
          transcription: {
            model: "gpt-live-transcribe",
            prompt: options.prompt || undefined,
            keywords: options.keywords.length ? options.keywords : undefined,
            languages: ["ko"],
            delay: options.delay,
          },
          turn_detection: null,
        },
      },
    },
  };
}

export class OpenAITranscriptionEngine implements TranscriptionEngine {
  readonly sampleRate = OPENAI_SAMPLE_RATE;

  private socket?: WebSocket;
  private audioBytesSinceCommit = 0;
  private stopping = false;

  constructor(
    private readonly apiKey: string,
    private readonly options: OpenAIEngineOptions,
    private readonly callbacks: TranscriptionEngineCallbacks,
  ) {}

  async start(): Promise<void> {
    const socket = new WebSocket(OPENAI_URL, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    this.socket = socket;
    socket.on("open", () => socket.send(JSON.stringify(createSessionUpdate(this.options))));
    socket.on("message", (raw) => this.handleEvent(raw.toString()));
    socket.on("error", (error) => this.callbacks.onError(`OpenAI 연결 오류: ${error.message}`));
    socket.on("close", () => {
      if (!this.stopping) this.callbacks.onError("OpenAI 연결이 예기치 않게 종료됐습니다.");
    });
  }

  appendAudio(chunk: Buffer): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    for (let offset = 0; offset < chunk.length; offset += 4_800) {
      const audio = chunk.subarray(offset, Math.min(offset + 4_800, chunk.length));
      this.socket.send(JSON.stringify({
        type: "input_audio_buffer.append",
        audio: audio.toString("base64"),
      }));
      this.audioBytesSinceCommit += audio.length;
      if (shouldCommitAudioTurn(this.audioBytesSinceCommit)) void this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.audioBytesSinceCommit === 0 || this.socket?.readyState !== WebSocket.OPEN) return;
    if (this.audioBytesSinceCommit < MIN_AUDIO_TURN_BYTES) {
      this.socket.send(JSON.stringify({ type: "input_audio_buffer.clear" }));
      this.audioBytesSinceCommit = 0;
      return;
    }
    this.socket.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    this.audioBytesSinceCommit = 0;
  }

  async stop(): Promise<void> {
    const hadBufferedAudio = this.audioBytesSinceCommit > 0;
    await this.flush();
    if (hadBufferedAudio) await new Promise((resolve) => setTimeout(resolve, 500));
    this.stopping = true;
    this.socket?.close();
  }

  private handleEvent(raw: string): void {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }

    if (event.type === "session.updated" || event.type === "transcription_session.updated") {
      this.callbacks.onReady();
      return;
    }
    if (event.type === "conversation.item.input_audio_transcription.delta") {
      this.callbacks.onPartial({
        itemId: String(event.item_id ?? "current"),
        text: String(event.delta ?? ""),
      });
      return;
    }
    if (event.type === "conversation.item.input_audio_transcription.completed") {
      this.callbacks.onFinal({
        itemId: String(event.item_id ?? randomUUID()),
        text: String(event.transcript ?? "").trim(),
      });
      return;
    }
    if (event.type === "error") {
      const detail = event.error as { message?: string } | undefined;
      this.callbacks.onError(detail?.message || "OpenAI 전사 처리 중 오류가 발생했습니다.");
    }
  }
}
