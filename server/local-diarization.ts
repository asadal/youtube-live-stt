import { spawn } from "node:child_process";
import { readFile, readdir, rm, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import type { DiarizationResult, DiarizedSegment } from "./diarization.js";

const CHUNK_SECONDS = 8 * 60;
const REQUEST_TIMEOUT_MS = 10 * 60 * 1_000;

interface SpeakerTurn {
  start: number;
  end: number;
  speaker: string;
}

interface TimedTranscript {
  start: number;
  end: number;
  text: string;
  chunkIndex: number;
}

interface AudioChunk {
  filePath: string;
  offset: number;
  index: number;
}

export interface LocalDiarizationOptions {
  whisperUrl: string;
  pythonPath: string;
  scriptPath: string;
  huggingFaceToken?: string;
  modelPath?: string;
  prompt?: string;
  keywords?: string[];
}

function run(command: string, args: string[], environment?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: environment ?? process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", (error) => reject(new Error(`${command} 실행 오류: ${error.message}`)));
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `${command} 종료 코드 ${code}`));
    });
  });
}

async function durationOf(filePath: string): Promise<number> {
  const output = await run("ffprobe", [
    "-v", "error", "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1", filePath,
  ]);
  const duration = Number(output);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("녹음 파일 길이를 확인할 수 없습니다.");
  return duration;
}

async function prepareWavChunks(recordingPath: string): Promise<AudioChunk[]> {
  const chunkDirectory = path.join(path.dirname(recordingPath), "local-diarization-chunks");
  await rm(chunkDirectory, { recursive: true, force: true });
  await mkdir(chunkDirectory, { recursive: true, mode: 0o700 });
  await run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-i", recordingPath,
    "-f", "segment", "-segment_time", String(CHUNK_SECONDS), "-reset_timestamps", "1",
    "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
    path.join(chunkDirectory, "chunk-%03d.wav"),
  ]);
  const names = (await readdir(chunkDirectory)).filter((name) => name.endsWith(".wav")).sort();
  if (!names.length) throw new Error("로컬 전사용 WAV 파일을 만들지 못했습니다.");

  const chunks: AudioChunk[] = [];
  let offset = 0;
  for (const [index, name] of names.entries()) {
    const filePath = path.join(chunkDirectory, name);
    chunks.push({ filePath, offset, index });
    offset += await durationOf(filePath);
  }
  return chunks;
}

export function parseSrtTimestamp(value: string): number {
  const match = value.trim().match(/^(\d+):(\d{2}):(\d{2})[,.](\d{3})$/);
  if (!match) throw new Error(`SRT 타임스탬프 형식이 올바르지 않습니다: ${value}`);
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
}

export function parseSrt(content: string, offset: number, chunkIndex: number): TimedTranscript[] {
  return content.trim().split(/\r?\n\r?\n+/).flatMap((block) => {
    const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) return [];
    const [startValue, endValue] = lines[timingIndex].split("-->").map((value) => value.trim());
    const text = lines.slice(timingIndex + 1).join(" ").replace(/<[^>]+>/g, "").trim();
    if (!text) return [];
    return [{
      start: offset + parseSrtTimestamp(startValue),
      end: offset + parseSrtTimestamp(endValue),
      text,
      chunkIndex,
    }];
  });
}

function overlapDuration(segment: TimedTranscript, turn: SpeakerTurn): number {
  return Math.max(0, Math.min(segment.end, turn.end) - Math.max(segment.start, turn.start));
}

export function combineSpeakers(transcripts: TimedTranscript[], turns: SpeakerTurn[]): DiarizedSegment[] {
  const speakerNames = new Map<string, string>();
  const nameFor = (speaker: string) => {
    const known = speakerNames.get(speaker);
    if (known) return known;
    const name = `화자 ${speakerNames.size + 1}`;
    speakerNames.set(speaker, name);
    return name;
  };

  return transcripts.map((segment) => {
    let selected: SpeakerTurn | undefined;
    let greatestOverlap = 0;
    for (const turn of turns) {
      const overlap = overlapDuration(segment, turn);
      if (overlap > greatestOverlap) {
        greatestOverlap = overlap;
        selected = turn;
      }
    }
    if (!selected && turns.length) {
      const midpoint = (segment.start + segment.end) / 2;
      selected = turns.reduce((closest, turn) => {
        const distance = Math.min(Math.abs(midpoint - turn.start), Math.abs(midpoint - turn.end));
        const closestDistance = Math.min(Math.abs(midpoint - closest.start), Math.abs(midpoint - closest.end));
        return distance < closestDistance ? turn : closest;
      });
    }
    return {
      speaker: selected ? nameFor(selected.speaker) : "화자 미확인",
      text: segment.text,
      start: segment.start,
      end: segment.end,
      chunkIndex: segment.chunkIndex,
    };
  });
}

async function runPyannote(recordingPath: string, options: LocalDiarizationOptions): Promise<SpeakerTurn[]> {
  const environment = {
    ...process.env,
    HUGGINGFACE_TOKEN: options.huggingFaceToken,
    PYANNOTE_MODEL_PATH: options.modelPath,
  };
  const output = await run(options.pythonPath, [options.scriptPath, recordingPath], environment);
  const payload = JSON.parse(output) as { turns?: SpeakerTurn[] };
  if (!Array.isArray(payload.turns)) throw new Error("pyannote 화자 구간 결과가 올바르지 않습니다.");
  return payload.turns.filter((turn) => Number.isFinite(turn.start) && Number.isFinite(turn.end) && turn.end > turn.start);
}

async function transcribeChunk(chunk: AudioChunk, options: LocalDiarizationOptions): Promise<TimedTranscript[]> {
  const bytes = await readFile(chunk.filePath);
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)], { type: "audio/wav" }), path.basename(chunk.filePath));
  form.append("language", "ko");
  form.append("response_format", "srt");
  form.append("temperature", "0.0");
  const prompt = [options.prompt, options.keywords?.length ? options.keywords.join(", ") : ""].filter(Boolean).join("\n");
  if (prompt) form.append("prompt", prompt);
  const response = await fetch(new URL("/inference", options.whisperUrl), {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const content = await response.text();
  if (!response.ok) throw new Error(`로컬 Whisper 후처리 오류 (${response.status}): ${content.slice(0, 300)}`);
  return parseSrt(content, chunk.offset, chunk.index);
}

export async function diarizeRecordingLocally(
  recordingPath: string,
  options: LocalDiarizationOptions,
): Promise<DiarizationResult> {
  await stat(recordingPath);
  const [turns, chunks] = await Promise.all([
    runPyannote(recordingPath, options),
    prepareWavChunks(recordingPath),
  ]);
  const transcripts: TimedTranscript[] = [];
  for (const chunk of chunks) transcripts.push(...await transcribeChunk(chunk, options));
  const segments = combineSpeakers(transcripts, turns);
  return {
    text: segments.map((segment) => segment.text).join("\n"),
    segments,
    chunkCount: chunks.length,
    speakerLabelsAreChunkLocal: false,
  };
}
