import { mkdir, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_TTL_HOURS = 24;

function parsePositiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const temporaryAudioRoot = path.resolve(
  process.env.TEMP_AUDIO_DIR || path.join(os.tmpdir(), "asadal-live-script"),
);
export const temporaryAudioTtlHours = parsePositiveNumber(
  process.env.TEMP_AUDIO_TTL_HOURS,
  DEFAULT_TTL_HOURS,
);

export function expiresAt(createdAt: Date): string {
  return new Date(createdAt.getTime() + temporaryAudioTtlHours * 60 * 60 * 1000).toISOString();
}

export async function createRecordingPath(sessionId: string): Promise<string> {
  const directory = path.join(temporaryAudioRoot, sessionId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return path.join(directory, "recording.mp3");
}

export async function removeSessionAudio(sessionId: string): Promise<void> {
  await rm(path.join(temporaryAudioRoot, sessionId), { recursive: true, force: true });
}

export async function cleanupExpiredAudio(
  now = Date.now(),
  excludedSessionIds = new Set<string>(),
): Promise<void> {
  await mkdir(temporaryAudioRoot, { recursive: true, mode: 0o700 });
  const entries = await readdir(temporaryAudioRoot, { withFileTypes: true });
  const ttlMilliseconds = temporaryAudioTtlHours * 60 * 60 * 1000;

  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .filter((entry) => !excludedSessionIds.has(entry.name))
      .map(async (entry) => {
        const directory = path.join(temporaryAudioRoot, entry.name);
        const information = await stat(directory);
        if (now - information.mtimeMs > ttlMilliseconds) {
          await rm(directory, { recursive: true, force: true });
        }
      }),
  );
}
