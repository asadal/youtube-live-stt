import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { stat } from "node:fs/promises";
import type { Response } from "express";
import WebSocket from "ws";
import { diarizeRecording, type DiarizationResult } from "./diarization.js";
import {
  AUDIO_TURN_BYTES,
  MIN_AUDIO_TURN_BYTES,
  OpenAITranscriptionEngine,
  createSessionUpdate,
  shouldCommitAudioTurn,
} from "./openai-transcription-engine.js";
import { LocalWhisperEngine } from "./local-whisper-engine.js";
import { diarizeRecordingLocally } from "./local-diarization.js";
import type {
  EngineTranscriptEvent,
  TranscriptionEngine,
  TranscriptionEngineKind,
} from "./transcription-engine.js";
import {
  createRecordingPath,
  expiresAt,
  removeSessionAudio,
} from "./temporary-audio.js";

export type Delay = "minimal" | "low" | "medium" | "high" | "xhigh";
export type AudioSource = "youtube" | "microphone";
export type SessionStatus = "connecting" | "live" | "paused" | "stopping" | "stopped" | "error";
export type DiarizationEngineKind = "openai" | "local-pyannote";
export type { TranscriptionEngineKind } from "./transcription-engine.js";
export {
  AUDIO_TURN_BYTES,
  MIN_AUDIO_TURN_BYTES,
  createSessionUpdate,
  shouldCommitAudioTurn,
};

export interface SessionOptions {
  engine: TranscriptionEngineKind;
  source: AudioSource;
  youtubeUrl?: string;
  prompt: string;
  keywords: string[];
  delay: Delay;
  recordAudio: boolean;
}

type ClientEvent =
  | { type: "status"; status: SessionStatus; message: string }
  | { type: "partial"; itemId: string; sequence: number; text: string }
  | { type: "final"; itemId: string; sequence: number; text: string; receivedAt: string }
  | { type: "error"; message: string };

const MAX_HISTORY = 500;
const PROCESS_STOP_TIMEOUT_MS = 5_000;

export function shouldForwardAudio(status: SessionStatus): boolean {
  return status === "live";
}

interface TranscriptionServices {
  openAIApiKey?: string;
  localWhisperUrl?: string;
  pyannotePythonPath?: string;
  pyannoteScriptPath?: string;
  huggingFaceToken?: string;
  pyannoteModelPath?: string;
}

export class TranscriptionSession {
  readonly id = randomUUID();
  readonly createdAt = new Date();

  private status: SessionStatus = "connecting";
  private listeners = new Set<Response>();
  private history: ClientEvent[] = [];
  private transcriptionEngine?: TranscriptionEngine;
  private microphoneSocket?: WebSocket;
  private downloader?: ReturnType<typeof spawn>;
  private ffmpeg?: ReturnType<typeof spawn>;
  private stopped = false;
  private engineReady = false;
  private pipelineStarted = false;
  private itemSequences = new Map<string, number>();
  private nextSequence = 0;
  private recordingPath?: string;
  private recordingBytes = 0;
  private diarizationPromise?: Promise<DiarizationResult>;
  private diarizationEngine?: DiarizationEngineKind;

  constructor(
    private readonly options: SessionOptions,
    private readonly services: TranscriptionServices,
  ) {}

  async start(): Promise<void> {
    if (this.options.recordAudio) this.recordingPath = await createRecordingPath(this.id);
    this.emit({
      type: "status",
      status: "connecting",
      message: this.options.engine === "openai"
        ? "OpenAI 전사 서버에 연결하고 있습니다."
        : "Mac의 로컬 Whisper 서버와 모델을 확인하고 있습니다.",
    });

    const callbacks = {
      onReady: () => this.handleEngineReady(),
      onPartial: (event: EngineTranscriptEvent) => this.handlePartial(event),
      onFinal: (event: EngineTranscriptEvent) => this.handleFinal(event),
      onError: (message: string) => this.fail(message),
    };
    if (this.options.engine === "openai") {
      if (!this.services.openAIApiKey) throw new Error("OpenAI API 키가 설정돼 있지 않습니다.");
      this.transcriptionEngine = new OpenAITranscriptionEngine(
        this.services.openAIApiKey,
        this.options,
        callbacks,
      );
    } else {
      if (!this.services.localWhisperUrl) throw new Error("로컬 Whisper 서버 주소가 설정돼 있지 않습니다.");
      this.transcriptionEngine = new LocalWhisperEngine({
        serverUrl: this.services.localWhisperUrl,
        prompt: this.options.prompt,
        keywords: this.options.keywords,
        delay: this.options.delay,
      }, callbacks);
    }
    await this.transcriptionEngine.start();
  }

  attach(response: Response): void {
    this.listeners.add(response);
    for (const event of this.history) this.write(response, event);
    response.on("close", () => this.listeners.delete(response));
  }

  attachMicrophone(socket: WebSocket, sampleRate: number): void {
    if (this.options.source !== "microphone" || this.stopped || this.microphoneSocket) {
      socket.close(1008, "마이크 세션을 연결할 수 없습니다.");
      return;
    }
    if (!Number.isFinite(sampleRate) || sampleRate < 8_000 || sampleRate > 192_000) {
      socket.close(1008, "지원하지 않는 샘플레이트입니다.");
      return;
    }

    this.microphoneSocket = socket;
    this.startMicrophonePipeline(Math.round(sampleRate));
    socket.on("message", (data, isBinary) => {
      const input = this.ffmpeg?.stdin;
      if (!isBinary || this.stopped || !input?.writable) return;
      const chunk = Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.isBuffer(data)
          ? data
          : Buffer.from(new Uint8Array(data));
      input.write(chunk);
    });
    socket.on("close", () => {
      if (!this.stopped && this.status !== "error") this.fail("브라우저의 마이크 연결이 종료됐습니다.");
    });
    socket.on("error", (error) => this.fail(`마이크 전송 오류: ${error.message}`));

    if (this.engineReady) this.setStatus("live", this.liveMessage());
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.setStatus("stopping", "오디오 수집을 종료하고 녹음 파일을 마무리하고 있습니다.");

    this.microphoneSocket?.close(1000, "전사가 종료됐습니다.");
    this.downloader?.kill("SIGTERM");
    const input = this.ffmpeg?.stdin;
    if (this.options.source === "microphone" && input?.writable) input.end();

    await this.waitForFfmpeg();
    await this.transcriptionEngine?.stop();
    await this.refreshRecordingInformation();
    this.setStatus("stopped", this.recordingBytes > 0
      ? "전사가 종료됐습니다. 임시 녹음으로 화자 분리를 실행할 수 있습니다."
      : "전사가 종료됐습니다.");
    for (const listener of this.listeners) listener.end();
    this.listeners.clear();
  }

  pause(): void {
    if (this.stopped || this.status !== "live") return;
    void this.transcriptionEngine?.flush();
    this.setStatus("paused", "실시간 전사만 일시중지했습니다. 임시 녹음은 계속됩니다.");
  }

  resume(): void {
    if (this.stopped || this.status !== "paused") return;
    this.setStatus("live", "실시간 전사를 다시 시작했습니다.");
  }

  async diarize(engine: DiarizationEngineKind): Promise<DiarizationResult> {
    if (this.status !== "stopped") throw new Error("전사를 정지한 뒤 화자 분리를 실행해 주세요.");
    if (!this.recordingPath || this.recordingBytes === 0) throw new Error("화자 분리에 사용할 임시 녹음이 없습니다.");
    if (!this.diarizationPromise || this.diarizationEngine !== engine) {
      this.diarizationEngine = engine;
      if (engine === "openai") {
        if (!this.services.openAIApiKey) throw new Error("OpenAI 화자 분리에는 API 키가 필요합니다.");
        this.diarizationPromise = diarizeRecording(this.recordingPath, this.services.openAIApiKey);
      } else {
        if (!this.services.localWhisperUrl) throw new Error("로컬 화자 분리에는 실행 중인 whisper.cpp 서버가 필요합니다.");
        if (!this.services.pyannotePythonPath || !this.services.pyannoteScriptPath) {
          throw new Error("로컬 pyannote 실행 환경이 설정돼 있지 않습니다.");
        }
        this.diarizationPromise = diarizeRecordingLocally(this.recordingPath, {
          whisperUrl: this.services.localWhisperUrl,
          pythonPath: this.services.pyannotePythonPath,
          scriptPath: this.services.pyannoteScriptPath,
          huggingFaceToken: this.services.huggingFaceToken,
          modelPath: this.services.pyannoteModelPath,
          prompt: this.options.prompt,
          keywords: this.options.keywords,
        });
      }
      this.diarizationPromise = this.diarizationPromise
        .catch((error) => {
          this.diarizationPromise = undefined;
          this.diarizationEngine = undefined;
          throw error;
        });
    }
    return this.diarizationPromise;
  }

  async deleteRecording(): Promise<void> {
    if (!this.stopped) throw new Error("전사를 정지한 뒤 임시 음성을 삭제해 주세요.");
    await removeSessionAudio(this.id);
    this.recordingPath = undefined;
    this.recordingBytes = 0;
    this.diarizationPromise = undefined;
    this.diarizationEngine = undefined;
  }

  getRecordingPath(): string | undefined {
    return this.recordingBytes > 0 ? this.recordingPath : undefined;
  }

  getSnapshot() {
    return {
      id: this.id,
      engine: this.options.engine,
      source: this.options.source,
      status: this.status,
      createdAt: this.createdAt.toISOString(),
      capabilities: {
        openAIDiarization: Boolean(this.services.openAIApiKey),
        localPyannoteDiarization: Boolean(
          this.services.localWhisperUrl
          && this.services.pyannotePythonPath
          && this.services.pyannoteScriptPath,
        ),
      },
      recording: {
        enabled: this.options.recordAudio,
        available: this.recordingBytes > 0,
        fileName: this.recordingBytes > 0 ? `asadal-live-script-${this.id}.mp3` : undefined,
        sizeBytes: this.recordingBytes || undefined,
        expiresAt: this.options.recordAudio ? expiresAt(this.createdAt) : undefined,
      },
    };
  }

  private handleEngineReady(): void {
    if (this.engineReady) return;
    this.engineReady = true;
    if (this.options.source === "youtube") this.startYouTubePipeline();
    else if (this.pipelineStarted) this.setStatus("live", this.liveMessage());
    else this.setStatus("connecting", "브라우저의 마이크 연결을 기다리고 있습니다.");
  }

  private handlePartial(event: EngineTranscriptEvent): void {
    this.emit({
      type: "partial",
      itemId: event.itemId,
      sequence: this.sequenceFor(event.itemId),
      text: event.text,
    });
  }

  private handleFinal(event: EngineTranscriptEvent): void {
    this.emit({
      type: "final",
      itemId: event.itemId,
      sequence: this.sequenceFor(event.itemId),
      text: event.text.trim(),
      receivedAt: new Date().toISOString(),
    });
  }

  private sequenceFor(itemId: string): number {
    const known = this.itemSequences.get(itemId);
    if (known !== undefined) return known;
    const sequence = this.nextSequence++;
    this.itemSequences.set(itemId, sequence);
    return sequence;
  }

  private startYouTubePipeline(): void {
    if (this.pipelineStarted || !this.options.youtubeUrl) return;
    this.pipelineStarted = true;
    const downloader = spawn(
      "yt-dlp",
      ["--no-playlist", "--no-warnings", "-f", "bestaudio/best", "-o", "-", this.options.youtubeUrl],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const ffmpeg = this.spawnFfmpeg(["-i", "pipe:0"]);
    this.downloader = downloader;
    if (!downloader.stdout || !ffmpeg.stdin) {
      this.fail("유튜브 오디오 파이프를 만들지 못했습니다.");
      return;
    }
    downloader.stdout.pipe(ffmpeg.stdin);
    this.setStatus("live", this.liveMessage());

    let downloaderError = "";
    downloader.stderr.on("data", (chunk: Buffer) => (downloaderError += chunk.toString()));
    downloader.on("error", (error) => this.fail(this.commandError("yt-dlp", error.message)));
    downloader.on("close", (code) => {
      if (!this.stopped && code && code !== 0) this.fail(`유튜브 오디오를 가져오지 못했습니다. ${downloaderError.trim()}`);
    });
  }

  private startMicrophonePipeline(sampleRate: number): void {
    if (this.pipelineStarted) return;
    this.pipelineStarted = true;
    this.spawnFfmpeg(["-f", "s16le", "-ar", String(sampleRate), "-ac", "1", "-i", "pipe:0"]);
  }

  private spawnFfmpeg(inputArguments: string[]): ReturnType<typeof spawn> {
    const argumentsList = [
      "-hide_banner", "-loglevel", "error",
      ...inputArguments,
      "-map", "0:a:0", "-ac", "1", "-ar", String(this.transcriptionEngine?.sampleRate ?? 16_000), "-f", "s16le", "pipe:1",
    ];
    if (this.recordingPath) {
      argumentsList.push(
        "-map", "0:a:0", "-ac", "1", "-ar", "16000",
        "-c:a", "libmp3lame", "-b:a", "48k", "-y", this.recordingPath,
      );
    }
    const ffmpeg = spawn("ffmpeg", argumentsList, { stdio: ["pipe", "pipe", "pipe"] });
    this.ffmpeg = ffmpeg;
    let ffmpegError = "";
    ffmpeg.stderr.on("data", (chunk: Buffer) => (ffmpegError += chunk.toString()));
    ffmpeg.on("error", (error) => this.fail(this.commandError("FFmpeg", error.message)));
    ffmpeg.on("close", (code) => {
      if (!this.stopped && code && code !== 0) this.fail(`오디오 변환이 중단됐습니다. ${ffmpegError.trim()}`);
    });
    ffmpeg.stdout.on("data", (chunk: Buffer) => this.forwardPcm(chunk));
    return ffmpeg;
  }

  private forwardPcm(chunk: Buffer): void {
    if (!shouldForwardAudio(this.status)) return;
    this.transcriptionEngine?.appendAudio(chunk);
  }

  private async waitForFfmpeg(): Promise<void> {
    const ffmpeg = this.ffmpeg;
    if (!ffmpeg || ffmpeg.exitCode !== null) return;
    const closed = once(ffmpeg, "close").then(() => undefined);
    const timedOut = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), PROCESS_STOP_TIMEOUT_MS));
    const result = await Promise.race([closed, timedOut]);
    if (result === "timeout" && ffmpeg.exitCode === null) {
      ffmpeg.kill("SIGTERM");
      await Promise.race([once(ffmpeg, "close"), new Promise((resolve) => setTimeout(resolve, 1_000))]);
    }
  }

  private async refreshRecordingInformation(): Promise<void> {
    if (!this.recordingPath) return;
    try {
      this.recordingBytes = (await stat(this.recordingPath)).size;
    } catch {
      this.recordingBytes = 0;
    }
  }

  private commandError(command: string, detail: string): string {
    if (detail.includes("ENOENT")) return `${command}가 설치돼 있지 않습니다. README의 설치 절차를 확인해 주세요.`;
    return `${command} 실행 오류: ${detail}`;
  }

  private fail(message: string): void {
    if (this.status === "error" || this.stopped) return;
    this.status = "error";
    this.emit({ type: "error", message });
    this.emit({ type: "status", status: "error", message });
    this.microphoneSocket?.close(1011, "전사 오류");
    this.downloader?.kill("SIGTERM");
    this.ffmpeg?.kill("SIGTERM");
    void this.transcriptionEngine?.stop();
  }

  private liveMessage(): string {
    const source = this.options.source === "youtube" ? "유튜브 라이브" : "컴퓨터 마이크";
    const engine = this.options.engine === "openai" ? "OpenAI" : "로컬 Whisper";
    return `${source} 음성을 ${engine}로 한국어 전사하고 있습니다.`;
  }

  private setStatus(status: SessionStatus, message: string): void {
    this.status = status;
    this.emit({ type: "status", status, message });
  }

  private emit(event: ClientEvent): void {
    this.history.push(event);
    if (this.history.length > MAX_HISTORY) this.history.shift();
    for (const listener of this.listeners) this.write(listener, event);
  }

  private write(response: Response, event: ClientEvent): void {
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  }
}
