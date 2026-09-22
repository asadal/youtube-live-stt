export type TranscriptionEngineKind = "openai" | "local-whisper";

export interface EngineTranscriptEvent {
  itemId: string;
  text: string;
}

export interface TranscriptionEngineCallbacks {
  onReady(): void;
  onPartial(event: EngineTranscriptEvent): void;
  onFinal(event: EngineTranscriptEvent): void;
  onError(message: string): void;
}

export interface TranscriptionEngine {
  readonly sampleRate: number;
  start(): Promise<void>;
  appendAudio(audio: Buffer): void;
  flush(): Promise<void>;
  stop(): Promise<void>;
}
