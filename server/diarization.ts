import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

const MAX_UPLOAD_BYTES = 24 * 1024 * 1024;
const MAX_SINGLE_FILE_SECONDS = 10 * 60;
const CHUNK_SECONDS = 8 * 60;

export interface DiarizedSegment {
  speaker: string;
  text: string;
  start: number;
  end: number;
  chunkIndex: number;
}

export interface DiarizationResult {
  text: string;
  segments: DiarizedSegment[];
  chunkCount: number;
  speakerLabelsAreChunkLocal: boolean;
}

interface AudioChunk {
  filePath: string;
  offset: number;
  index: number;
}

interface OpenAIDiarizationResponse {
  text?: unknown;
  segments?: Array<Record<string, unknown>>;
  error?: { message?: string };
}

export function normalizeSegments(
  payload: OpenAIDiarizationResponse,
  offset: number,
  chunkIndex: number,
): DiarizedSegment[] {
  if (!Array.isArray(payload.segments)) return [];
  return payload.segments.flatMap((segment) => {
    const text = String(segment.text ?? "").trim();
    const start = Number(segment.start);
    const end = Number(segment.end);
    if (!text || !Number.isFinite(start) || !Number.isFinite(end)) return [];
    return [{
      speaker: String(segment.speaker ?? "화자"),
      text,
      start: Math.max(0, start + offset),
      end: Math.max(0, end + offset),
      chunkIndex,
    }];
  });
}

async function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const process = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    process.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    process.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    process.on("error", (error) => reject(new Error(`${command} 실행 오류: ${error.message}`)));
    process.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${command} 실행 오류: ${stderr.trim() || `종료 코드 ${code}`}`));
    });
  });
}

async function durationOf(filePath: string): Promise<number> {
  const output = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    filePath,
  ]);
  const duration = Number(output);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("녹음 파일 길이를 확인할 수 없습니다.");
  return duration;
}

async function prepareChunks(recordingPath: string): Promise<AudioChunk[]> {
  const information = await stat(recordingPath);
  const duration = await durationOf(recordingPath);
  if (information.size <= MAX_UPLOAD_BYTES && duration <= MAX_SINGLE_FILE_SECONDS) {
    return [{ filePath: recordingPath, offset: 0, index: 0 }];
  }

  const chunkDirectory = path.join(path.dirname(recordingPath), "chunks");
  await rm(chunkDirectory, { recursive: true, force: true });
  await mkdir(chunkDirectory, { recursive: true, mode: 0o700 });
  await run("ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    "-i", recordingPath,
    "-f", "segment",
    "-segment_time", String(CHUNK_SECONDS),
    "-reset_timestamps", "1",
    "-c", "copy",
    path.join(chunkDirectory, "chunk-%03d.mp3"),
  ]);

  const fileNames = (await readdir(chunkDirectory))
    .filter((fileName) => fileName.endsWith(".mp3"))
    .sort();
  if (!fileNames.length) throw new Error("긴 녹음을 분할하지 못했습니다.");

  const chunks: AudioChunk[] = [];
  let offset = 0;
  for (const [index, fileName] of fileNames.entries()) {
    const filePath = path.join(chunkDirectory, fileName);
    const chunkSize = (await stat(filePath)).size;
    if (chunkSize > MAX_UPLOAD_BYTES) throw new Error("분할된 음성 파일이 OpenAI 업로드 제한을 초과했습니다.");
    chunks.push({ filePath, offset, index });
    offset += await durationOf(filePath);
  }
  return chunks;
}

async function transcribeChunk(chunk: AudioChunk, apiKey: string): Promise<OpenAIDiarizationResponse> {
  const bytes = await readFile(chunk.filePath);
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)], { type: "audio/mpeg" }), path.basename(chunk.filePath));
  form.append("model", "gpt-4o-transcribe-diarize");
  form.append("response_format", "diarized_json");
  form.append("chunking_strategy", "auto");

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  const payload = await response.json() as OpenAIDiarizationResponse;
  if (!response.ok) throw new Error(payload.error?.message || `화자 분리 API 오류 (${response.status})`);
  return payload;
}

export async function diarizeRecording(recordingPath: string, apiKey: string): Promise<DiarizationResult> {
  const chunks = await prepareChunks(recordingPath);
  const segments: DiarizedSegment[] = [];
  const texts: string[] = [];

  for (const chunk of chunks) {
    const payload = await transcribeChunk(chunk, apiKey);
    segments.push(...normalizeSegments(payload, chunk.offset, chunk.index));
    const text = String(payload.text ?? "").trim();
    if (text) texts.push(text);
  }

  return {
    text: texts.join("\n"),
    segments,
    chunkCount: chunks.length,
    speakerLabelsAreChunkLocal: chunks.length > 1,
  };
}
