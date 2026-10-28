import "dotenv/config";
import express from "express";
import { createServer } from "node:http";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import {
  TranscriptionSession,
  type AudioSource,
  type Delay,
  type DiarizationEngineKind,
  type TranscriptionEngineKind,
} from "./transcription-session.js";
import {
  cleanupExpiredAudio,
  temporaryAudioTtlHours,
} from "./temporary-audio.js";
import { parseYouTubeUrl, sanitizeKeywords } from "./youtube.js";
import { analyzeTranscript, resolvePerplexityApiKey, type AnalysisTask } from "./perplexity.js";

const app = express();
const server = createServer(app);
const microphoneServer = new WebSocketServer({ noServer: true });
const port = Number(process.env.PORT || 3001);
const sessions = new Map<string, TranscriptionSession>();
const allowedDelays = new Set<Delay>(["minimal", "low", "medium", "high", "xhigh"]);
const allowedSources = new Set<AudioSource>(["youtube", "microphone"]);
const allowedEngines = new Set<TranscriptionEngineKind>(["openai", "local-whisper"]);
const allowedAnalysisTasks = new Set<AnalysisTask>(["summary", "fact-check", "correction"]);
const localWhisperUrl = process.env.WHISPER_CPP_URL?.trim();
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(currentDirectory, "..");
const pyannotePythonPath = process.env.PYANNOTE_PYTHON?.trim()
  || path.join(projectDirectory, "vendor", "pyannote-venv", "bin", "python");
const pyannoteScriptPath = path.join(projectDirectory, "scripts", "diarize_pyannote.py");
const localPyannoteConfigured = Boolean(
  localWhisperUrl
  && existsSync(pyannotePythonPath)
  && existsSync(pyannoteScriptPath)
  && (process.env.HUGGINGFACE_TOKEN || process.env.PYANNOTE_MODEL_PATH),
);

// 녹취록 전체를 받으므로 다른 API보다 큰 본문을 허용한다. 32kb 파서보다 먼저 등록해야 한다.
app.post("/api/analysis", express.json({ limit: "2mb" }), async (request, response) => {
  const requestedTask = String(request.body.task ?? "") as AnalysisTask;
  if (!allowedAnalysisTasks.has(requestedTask)) return response.status(400).json({ error: "지원하지 않는 분석 기능입니다." });
  const transcript = String(request.body.transcript ?? "").trim();
  if (!transcript) return response.status(400).json({ error: "분석할 녹취록이 없습니다." });
  const apiKey = resolvePerplexityApiKey(
    process.env.PERPLEXITY_API_KEY,
    String(request.body.perplexityApiKey ?? "").slice(0, 512),
  );
  if (!apiKey) return response.status(503).json({ error: "서버에 PERPLEXITY_API_KEY를 설정하거나 Perplexity API 키를 입력해 주세요." });
  try {
    response.json(await analyzeTranscript(apiKey, requestedTask, transcript, sanitizeKeywords(request.body.keywords)));
  } catch (error) {
    response.status(502).json({ error: error instanceof Error ? error.message : "Perplexity 분석을 처리하지 못했습니다." });
  }
});

app.use(express.json({ limit: "32kb" }));

app.get("/api/health", (_request, response) => {
  response.json({
    ok: true,
    apiKeyConfigured: Boolean(process.env.OPENAI_API_KEY),
    engines: {
      openai: { serverKeyConfigured: Boolean(process.env.OPENAI_API_KEY) },
      localWhisper: { configured: Boolean(localWhisperUrl) },
    },
    diarizationEngines: {
      openai: { serverKeyConfigured: Boolean(process.env.OPENAI_API_KEY) },
      localPyannote: { configured: localPyannoteConfigured },
    },
    analysis: {
      perplexity: { serverKeyConfigured: Boolean(process.env.PERPLEXITY_API_KEY?.trim()) },
    },
    temporaryAudioTtlHours,
  });
});

app.post("/api/sessions", async (request, response) => {
  let session: TranscriptionSession | undefined;
  try {
    const requestedEngine = String(request.body.engine ?? "openai") as TranscriptionEngineKind;
    const engine: TranscriptionEngineKind = allowedEngines.has(requestedEngine) ? requestedEngine : "openai";
    const userApiKey = String(request.body.openAIApiKey ?? "").trim().slice(0, 512);
    const openAIApiKey = userApiKey || process.env.OPENAI_API_KEY;
    if (engine === "openai" && !openAIApiKey) {
      return response.status(503).json({ error: "OpenAI API 키를 입력하거나 서버에 OPENAI_API_KEY를 설정해 주세요." });
    }
    if (engine === "local-whisper" && !localWhisperUrl) {
      return response.status(503).json({ error: "로컬 방식에 필요한 WHISPER_CPP_URL이 설정돼 있지 않습니다." });
    }
    const requestedSource = String(request.body.source ?? "youtube") as AudioSource;
    const source: AudioSource = allowedSources.has(requestedSource) ? requestedSource : "youtube";
    const youtubeUrl = source === "youtube"
      ? parseYouTubeUrl(String(request.body.youtubeUrl ?? "")).toString()
      : undefined;
    const prompt = String(request.body.prompt ?? "").trim().slice(0, 2000);
    const keywords = sanitizeKeywords(request.body.keywords);
    const requestedDelay = String(request.body.delay ?? "low") as Delay;
    const delay: Delay = allowedDelays.has(requestedDelay) ? requestedDelay : "low";
    const recordAudio = request.body.recordAudio !== false;
    session = new TranscriptionSession(
      { engine, source, youtubeUrl, prompt, keywords, delay, recordAudio },
      {
        openAIApiKey,
        localWhisperUrl,
        pyannotePythonPath: localPyannoteConfigured ? pyannotePythonPath : undefined,
        pyannoteScriptPath: localPyannoteConfigured ? pyannoteScriptPath : undefined,
        huggingFaceToken: process.env.HUGGINGFACE_TOKEN,
        pyannoteModelPath: process.env.PYANNOTE_MODEL_PATH,
      },
    );

    sessions.set(session.id, session);
    await session.start();
    response.status(201).json(session.getSnapshot());
  } catch (error) {
    if (session) sessions.delete(session.id);
    response.status(400).json({ error: error instanceof Error ? error.message : "요청을 처리할 수 없습니다." });
  }
});

app.get("/api/sessions/:id", (request, response) => {
  const session = sessions.get(request.params.id);
  if (!session) return response.status(404).json({ error: "전사 세션을 찾을 수 없습니다." });
  response.json(session.getSnapshot());
});

app.get("/api/sessions/:id/events", (request, response) => {
  const session = sessions.get(request.params.id);
  if (!session) return response.status(404).json({ error: "전사 세션을 찾을 수 없습니다." });

  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("Connection", "keep-alive");
  response.flushHeaders();
  session.attach(response);
});

app.patch("/api/sessions/:id", (request, response) => {
  const session = sessions.get(request.params.id);
  if (!session) return response.status(404).json({ error: "전사 세션을 찾을 수 없습니다." });

  const action = String(request.body.action ?? "");
  if (action === "pause") session.pause();
  else if (action === "resume") session.resume();
  else return response.status(400).json({ error: "지원하지 않는 세션 제어 명령입니다." });

  response.json(session.getSnapshot());
});

app.delete("/api/sessions/:id", async (request, response) => {
  const session = sessions.get(request.params.id);
  if (!session) return response.status(404).json({ error: "전사 세션을 찾을 수 없습니다." });
  await session.stop();
  response.json(session.getSnapshot());
});

app.post("/api/sessions/:id/diarize", async (request, response) => {
  const session = sessions.get(request.params.id);
  if (!session) return response.status(404).json({ error: "전사 세션을 찾을 수 없습니다." });
  try {
    const requestedEngine = String(request.body.engine ?? "openai") as DiarizationEngineKind;
    const engine: DiarizationEngineKind = requestedEngine === "local-pyannote" ? "local-pyannote" : "openai";
    response.json(await session.diarize(engine));
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : "화자 분리를 처리하지 못했습니다." });
  }
});

app.get("/api/sessions/:id/recording", (request, response) => {
  const session = sessions.get(request.params.id);
  const recordingPath = session?.getRecordingPath();
  if (!session || !recordingPath) return response.status(404).json({ error: "임시 녹음 파일을 찾을 수 없습니다." });
  const snapshot = session.getSnapshot();
  response.download(recordingPath, snapshot.recording.fileName || "recording.mp3");
});

app.delete("/api/sessions/:id/recording", async (request, response) => {
  const session = sessions.get(request.params.id);
  if (!session) return response.status(404).json({ error: "전사 세션을 찾을 수 없습니다." });
  try {
    await session.deleteRecording();
    response.json(session.getSnapshot());
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : "임시 음성을 삭제하지 못했습니다." });
  }
});

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  const match = url.pathname.match(/^\/api\/sessions\/([^/]+)\/microphone$/);
  const session = match ? sessions.get(decodeURIComponent(match[1])) : undefined;
  if (!session) {
    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }

  const sampleRate = Number(url.searchParams.get("sampleRate"));
  microphoneServer.handleUpgrade(request, socket, head, (webSocket) => {
    session.attachMicrophone(webSocket, sampleRate);
  });
});

const staticDirectory = path.resolve(currentDirectory, "../dist");
app.use(express.static(staticDirectory));
app.use((_request, response) => response.sendFile(path.join(staticDirectory, "index.html")));

void cleanupExpiredAudio().catch((error) => console.error("임시 음성 정리 오류:", error));
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  const ttlMilliseconds = temporaryAudioTtlHours * 60 * 60 * 1000;
  const cleanup = async () => {
    for (const [id, session] of sessions) {
      const snapshot = session.getSnapshot();
      if (snapshot.status === "stopped" && now - session.createdAt.getTime() > ttlMilliseconds) {
        await session.deleteRecording();
        sessions.delete(id);
      }
    }
    await cleanupExpiredAudio(now, new Set(sessions.keys()));
  };
  void cleanup().catch((error) => console.error("임시 음성 정리 오류:", error));
}, 60 * 60 * 1000);
cleanupTimer.unref();

server.listen(port, () => console.log(`asadal's Live Script server: http://localhost:${port}`));

function shutdown() {
  clearInterval(cleanupTimer);
  void Promise.all([...sessions.values()].map((session) => session.stop()))
    .finally(() => server.close(() => process.exit(0)));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
