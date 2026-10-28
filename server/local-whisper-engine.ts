import { randomUUID } from "node:crypto";
import type {
  TranscriptionEngine,
  TranscriptionEngineCallbacks,
} from "./transcription-engine.js";

const SAMPLE_RATE = 16_000;
const BYTES_PER_SAMPLE = 2;
const MIN_FLUSH_SECONDS = 0.5;
const OVERLAP_SECONDS = 1;
// 구간 끝에서 이 길이 안의 가장 조용한 지점을 찾아 자른다.
const CUT_SEARCH_SECONDS = 1.5;
// 단어 안의 짧은 틈에서 자르지 않도록 문장 사이 쉼 정도의 길이만 조용한 지점으로 본다.
const QUIET_FRAME_SECONDS = 0.3;
// 구간 전체 평균 음량 대비 이 비율 이하면 말이 끊긴 지점으로 본다.
const QUIET_RMS_RATIO = 0.35;
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

const IGNORED_CHARACTER = /[\s.,!?…~·'"“”‘’()[\]{}:;\-]/;
const IGNORED_CHARACTER_PREFIX = /^[\s.,!?…~·'"“”‘’()[\]{}:;\-]+/;
const MIN_OVERLAP_CHARACTERS = 4;
const MAX_OVERLAP_CHARACTERS = 60;
// 직전 구간 끝이 조금 다르게 인식돼도 겹침으로 볼 수 있도록 허용하는 꼬리 글자 수
const OVERLAP_TAIL_SLACK = 8;

function comparableCharacters(text: string): { characters: string; endIndexes: number[] } {
  let characters = "";
  const endIndexes: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    if (IGNORED_CHARACTER.test(text[index])) continue;
    characters += text[index].toLocaleLowerCase("ko-KR");
    endIndexes.push(index + 1);
  }
  return { characters, endIndexes };
}

// 비슷한 겹침으로 인정할 최대 차이 비율과 최소 점수(겹친 글자 수 - 2 × 다른 글자 수)
const MAX_SIMILAR_DIFFERENCE_RATIO = 0.25;
const MIN_SIMILAR_SCORE = 5;
const SIMILAR_LENGTH_SLACK = 3;

export interface ScoredTranscript {
  text: string;
  // 띄어쓰기·문장부호를 뺀 글자마다의 Whisper 토큰 확률. 알 수 없으면 비워 둔다.
  probabilities?: number[];
}

function rms(pcm: Buffer, start: number, end: number): number {
  let sum = 0;
  for (let offset = start; offset < end; offset += BYTES_PER_SAMPLE) sum += pcm.readInt16LE(offset) ** 2;
  return Math.sqrt(sum / Math.max(1, (end - start) / BYTES_PER_SAMPLE));
}

// 목표 길이 끝부분에서 말이 끊긴 지점을 찾는다. 계속 말하고 있으면 undefined를 돌려준다.
export function findQuietCut(pcm: Buffer, targetBytes: number): number | undefined {
  const bytesPerSecond = SAMPLE_RATE * BYTES_PER_SAMPLE;
  const frameBytes = bytesPerSecond * QUIET_FRAME_SECONDS;
  const searchStart = Math.max(0, targetBytes - bytesPerSecond * CUT_SEARCH_SECONDS);
  let quietest: { offset: number; rms: number } | undefined;
  for (let offset = searchStart; offset + frameBytes <= targetBytes; offset += frameBytes / 2) {
    const value = rms(pcm, offset, offset + frameBytes);
    if (!quietest || value <= quietest.rms) quietest = { offset, rms: value };
  }
  if (!quietest || quietest.rms > rms(pcm, 0, targetBytes) * QUIET_RMS_RATIO) return undefined;
  return quietest.offset + frameBytes / 2;
}

function findExactOverlap(previous: string, current: string): number | undefined {
  const maximum = Math.min(MAX_OVERLAP_CHARACTERS, current.length);
  for (let length = maximum; length >= MIN_OVERLAP_CHARACTERS; length -= 1) {
    const index = previous.lastIndexOf(current.slice(0, length));
    if (index >= 0 && index + length >= previous.length - OVERLAP_TAIL_SLACK) return length;
  }
  return undefined;
}

function editDistance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const next = [i];
    for (let j = 1; j <= b.length; j += 1) {
      next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    row = next;
  }
  return row[b.length];
}

// 같은 오디오가 다른 단어로 인식된 겹침을 찾는다. 점수가 같으면 현재 구간을 덜 지우는 쪽을 고른다.
function findSimilarOverlap(previous: string, current: string): { previousLength: number; currentLength: number } | undefined {
  let best: { previousLength: number; currentLength: number; score: number } | undefined;
  for (let previousLength = MIN_OVERLAP_CHARACTERS; previousLength <= Math.min(MAX_OVERLAP_CHARACTERS, previous.length); previousLength += 1) {
    const tail = previous.slice(-previousLength);
    const longest = Math.min(current.length, previousLength + SIMILAR_LENGTH_SLACK);
    for (let currentLength = Math.max(MIN_OVERLAP_CHARACTERS, previousLength - SIMILAR_LENGTH_SLACK); currentLength <= longest; currentLength += 1) {
      const distance = editDistance(tail, current.slice(0, currentLength));
      const length = Math.max(previousLength, currentLength);
      const score = length - 2 * distance;
      if (distance / length > MAX_SIMILAR_DIFFERENCE_RATIO || score < MIN_SIMILAR_SCORE) continue;
      if (!best || score > best.score || (score === best.score && currentLength < best.currentLength)) {
        best = { previousLength, currentLength, score };
      }
    }
  }
  return best;
}

function sliceAfter(transcript: ScoredTranscript, endIndexes: number[], length: number): ScoredTranscript {
  return {
    text: transcript.text.slice(endIndexes[length - 1]).replace(IGNORED_CHARACTER_PREFIX, "").trim(),
    probabilities: transcript.probabilities?.slice(length),
  };
}

function average(values: number[] | undefined): number | undefined {
  return values?.length ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined;
}

// 1초 오디오 겹침 때문에 반복된 현재 구간의 앞부분을 글자 단위로 찾아 제거한다.
export function removeRepeatedOverlap(previous: string, current: string): string {
  const { characters, endIndexes } = comparableCharacters(current);
  const length = findExactOverlap(comparableCharacters(previous).characters, characters);
  return length ? sliceAfter({ text: current }, endIndexes, length).text : current.trim();
}

// 겹친 구간을 한 번만 남긴다. 단어가 달라졌으면 Whisper 신뢰도가 높은 쪽을 남기고,
// 현재 구간이 더 정확하면 고쳐 쓴 직전 구간을 previous로 돌려준다.
export function resolveOverlap(
  previous: ScoredTranscript,
  current: ScoredTranscript,
): { previous?: ScoredTranscript; current: ScoredTranscript } {
  const before = comparableCharacters(previous.text);
  const after = comparableCharacters(current.text);
  const similar = findSimilarOverlap(before.characters, after.characters);
  if (!similar) {
    const exactLength = findExactOverlap(before.characters, after.characters);
    if (exactLength) return { current: sliceAfter(current, after.endIndexes, exactLength) };
    return { current: { text: current.text.trim(), probabilities: current.probabilities } };
  }
  const rest = sliceAfter(current, after.endIndexes, similar.currentLength);
  const keptLength = before.characters.length - similar.previousLength;
  const sameWords = before.characters.slice(keptLength) === after.characters.slice(0, similar.currentLength);
  const previousConfidence = average(previous.probabilities?.slice(keptLength));
  const currentConfidence = average(current.probabilities?.slice(0, similar.currentLength));
  if (sameWords || previousConfidence === undefined || currentConfidence === undefined || currentConfidence <= previousConfidence) {
    return { current: rest };
  }
  const overlapStart = before.endIndexes[keptLength] - 1;
  const overlapEnd = after.endIndexes[similar.currentLength - 1];
  const overlapText = current.text.slice(0, overlapEnd) + (current.text.slice(overlapEnd).match(/^[.?!…]+/)?.[0] ?? "");
  return {
    previous: {
      text: (previous.text.slice(0, overlapStart) + overlapText).trim(),
      probabilities: [
        ...(previous.probabilities ?? []).slice(0, keptLength),
        ...(current.probabilities ?? []).slice(0, similar.currentLength),
      ],
    },
    current: rest,
  };
}

// Whisper가 문장부호를 빠뜨렸을 때 어절 끝 종결어미로 문장 끝을 판단한다.
const QUESTION_ENDING = /(니까|까요|나요|[은는인신던]가요|을까)$/;
const STATEMENT_ENDING = /(니다|[어아여에예해세네지데]요|군요|죠|[었았였겠있없했이한된는]다)$/;
const SENTENCE_PUNCTUATION_END = /[.?!…,~]$/;

export function addSentencePunctuation(text: string): string {
  return text.split(" ").map((word) => {
    if (SENTENCE_PUNCTUATION_END.test(word)) return word;
    if (QUESTION_ENDING.test(word)) return `${word}?`;
    if (STATEMENT_ENDING.test(word)) return `${word}.`;
    return word;
  }).join(" ");
}

// 프롬프트 문장도 마침표로 끝내야 Whisper가 문장부호를 넣는 문체를 따른다.
function asSentence(text: string): string {
  const trimmed = text.trim();
  return !trimmed || SENTENCE_PUNCTUATION_END.test(trimmed) ? trimmed : `${trimmed}.`;
}

type WhisperPayload = {
  text?: unknown;
  error?: unknown;
  segments?: { words?: { word?: unknown; probability?: unknown }[] }[];
};

// whisper.cpp verbose_json 응답에서 본문과 글자별 확률을 꺼낸다.
export function parseWhisperResponse(body: string): ScoredTranscript {
  let payload: WhisperPayload;
  try {
    payload = JSON.parse(body) as WhisperPayload;
  } catch (error) {
    if (error instanceof SyntaxError) return { text: body.replace(/\s+/g, " ").trim() };
    throw error;
  }
  if (payload.error) throw new Error(String(payload.error));
  const text = String(payload.text ?? "").replace(/\s+/g, " ").trim();
  const probabilities: number[] = [];
  for (const segment of payload.segments ?? []) {
    for (const word of segment.words ?? []) {
      for (const character of String(word.word ?? "")) {
        if (!IGNORED_CHARACTER.test(character)) probabilities.push(Number(word.probability));
      }
    }
  }
  const matches = probabilities.length > 0
    && probabilities.length === comparableCharacters(text).characters.length
    && probabilities.every(Number.isFinite);
  return { text, probabilities: matches ? probabilities : undefined };
}

// 음성 맥락·주요 용어 문장을 Whisper가 그대로 따라 쓴 부분을 지운다.
export function removePromptEcho(transcript: ScoredTranscript, promptSentences: string[]): ScoredTranscript {
  let text = transcript.text;
  for (const sentence of promptSentences) {
    text = text.split(sentence).join(" ").split(sentence.replace(/[.?!…]+$/, "")).join(" ");
  }
  text = text.replace(/\s+/g, " ").replace(IGNORED_CHARACTER_PREFIX, "").trim();
  if (text === transcript.text) return transcript;
  // 글자가 빠졌으므로 글자별 확률은 더 이상 맞지 않는다.
  return { text };
}

export class LocalWhisperEngine implements TranscriptionEngine {
  readonly sampleRate = SAMPLE_RATE;

  private pcm = Buffer.alloc(0);
  private processing = Promise.resolve();
  private previousTranscript = "";
  private lastEmitted?: ScoredTranscript & { itemId: string };
  // 남은 PCM이 이미 전사한 오디오 1초로 시작하는지 여부
  private pendingOverlap = false;
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
      this.queueTranscription(remaining, this.pendingOverlap);
      this.pendingOverlap = false;
    }
    await this.processing;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.flush();
  }

  private queueCompleteWindows(): void {
    while (this.pcm.length >= this.windowBytes) {
      const startsWithOverlap = this.pendingOverlap;
      const quietCut = findQuietCut(this.pcm, this.windowBytes);
      if (quietCut !== undefined) {
        // 말이 끊긴 지점에서 자르면 오디오를 겹칠 필요가 없다.
        const window = this.pcm.subarray(0, quietCut);
        this.pcm = this.pcm.subarray(quietCut);
        this.pendingOverlap = false;
        this.queueTranscription(window, startsWithOverlap);
        continue;
      }
      const window = this.pcm.subarray(0, this.windowBytes);
      const overlap = window.subarray(Math.max(0, window.length - this.overlapBytes));
      this.pcm = Buffer.concat([overlap, this.pcm.subarray(this.windowBytes)]);
      this.pendingOverlap = true;
      this.queueTranscription(window, startsWithOverlap);
    }
  }

  private queueTranscription(pcm: Buffer, startsWithOverlap: boolean): void {
    this.processing = this.processing
      .then(() => this.transcribe(pcm, startsWithOverlap))
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        this.callbacks.onError(detail);
      });
  }

  private async transcribe(pcm: Buffer, startsWithOverlap: boolean): Promise<void> {
    const wav = createWav(pcm);
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "realtime.wav");
    form.append("language", "ko");
    form.append("response_format", "verbose_json");
    form.append("temperature", "0.0");
    form.append("temperature_inc", "0.2");
    form.append("no_timestamps", "true");
    form.append("suppress_non_speech", "true");
    // Whisper는 프롬프트를 앞선 대본으로 보고 말이 없는 구간에서 그대로 따라 쓰기도 하므로
    // "주요 용어:", "직전 문맥:" 같은 라벨 없이 대본처럼 이어지는 문장만 넣는다.
    const promptSentences = [
      asSentence(this.options.prompt),
      this.options.keywords.length ? asSentence(this.options.keywords.join(", ")) : "",
    ].filter(Boolean);
    const prompt = [...promptSentences, this.previousTranscript.slice(-300)].filter(Boolean).join("\n");
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

    const parsed = removePromptEcho(parseWhisperResponse(body), promptSentences);
    if (!parsed.text) return;
    const transcript = { ...parsed, text: addSentencePunctuation(parsed.text) };
    this.previousTranscript = transcript.text;
    const resolved = startsWithOverlap && this.lastEmitted
      ? resolveOverlap(this.lastEmitted, transcript)
      : { current: transcript };
    if (resolved.previous && this.lastEmitted) {
      // 같은 itemId로 다시 보내면 화면의 직전 기록이 고쳐진 내용으로 바뀐다.
      this.lastEmitted = {
        ...resolved.previous,
        text: addSentencePunctuation(resolved.previous.text),
        itemId: this.lastEmitted.itemId,
      };
      this.callbacks.onFinal({ itemId: this.lastEmitted.itemId, text: this.lastEmitted.text });
    }
    if (!resolved.current.text) return;
    this.lastEmitted = { ...resolved.current, itemId: randomUUID() };
    this.callbacks.onFinal({ itemId: this.lastEmitted.itemId, text: this.lastEmitted.text });
  }
}
