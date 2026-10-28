import {
  Check,
  ChevronDown,
  Clipboard,
  Cloud,
  Cpu,
  Download,
  Eye,
  EyeOff,
  FileAudio,
  LoaderCircle,
  Mic,
  Moon,
  Pause,
  Play,
  ListChecks,
  Radio,
  SearchCheck,
  Sparkles,
  SpellCheck,
  Square,
  Sun,
  Trash2,
  TvMinimalPlay,
  Users,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { startMicrophone, type MicrophoneController } from "./microphone";
import {
  formatElapsedTime,
  groupIntoParagraphs,
  SENTENCES_PER_PARAGRAPH,
  serializeDiarizedSegments,
  serializeTranscripts,
} from "./transcript";
import { getYouTubeVideoId } from "./youtube";

type Theme = "system" | "light" | "dark";
type Source = "youtube" | "microphone";
type Engine = "openai" | "local-whisper";
type DiarizationEngine = "openai" | "local-pyannote";
type Status = "idle" | "connecting" | "live" | "paused" | "stopping" | "stopped" | "error";
type Transcript = { itemId: string; sequence: number; text: string; receivedAt: string };
type Recording = {
  enabled: boolean;
  available: boolean;
  fileName?: string;
  sizeBytes?: number;
  expiresAt?: string;
};
type SessionSnapshot = {
  id: string;
  engine: Engine;
  source: Source;
  status: Exclude<Status, "idle">;
  capabilities: {
    openAIDiarization: boolean;
    localPyannoteDiarization: boolean;
  };
  recording: Recording;
};
type Health = {
  engines: {
    openai: { serverKeyConfigured: boolean };
    localWhisper: { configured: boolean };
  };
  diarizationEngines: {
    openai: { serverKeyConfigured: boolean };
    localPyannote: { configured: boolean };
  };
  analysis: {
    perplexity: { serverKeyConfigured: boolean };
  };
};
type DiarizedSegment = {
  speaker: string;
  text: string;
  start: number;
  end: number;
  chunkIndex: number;
};
type DiarizationResult = {
  text: string;
  segments: DiarizedSegment[];
  chunkCount: number;
  speakerLabelsAreChunkLocal: boolean;
};
type AnalysisTask = "summary" | "fact-check" | "correction";
type AnalysisResult = {
  task: AnalysisTask;
  text: string;
  sources: { title: string; url: string }[];
};
type StreamEvent =
  | { type: "status"; status: Exclude<Status, "idle">; message: string }
  | { type: "partial"; itemId: string; sequence: number; text: string }
  | { type: "final"; itemId: string; sequence: number; text: string; receivedAt: string }
  | { type: "error"; message: string };

const analysisTaskLabel: Record<AnalysisTask, string> = {
  summary: "요약·정리",
  "fact-check": "팩트체크",
  correction: "용어·고유명사 교정",
};
const emptyRecording: Recording = { enabled: true, available: false };
const statusLabel: Record<Status, string> = {
  idle: "대기",
  connecting: "연결 중",
  live: "전사 중",
  paused: "일시중지",
  stopping: "종료 중",
  stopped: "종료",
  error: "오류",
};

function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem("asadal-live-script-theme") as Theme) || "system");

  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = theme === "dark" || (theme === "system" && query.matches);
      document.documentElement.dataset.theme = dark ? "dark" : "light";
    };
    apply();
    query.addEventListener("change", apply);
    localStorage.setItem("asadal-live-script-theme", theme);
    return () => query.removeEventListener("change", apply);
  }, [theme]);

  return { theme, setTheme };
}

function formatBytes(bytes = 0): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function downloadBlob(content: string, fileName: string) {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(href);
}

export default function App() {
  const { theme, setTheme } = useTheme();
  const [engine, setEngine] = useState<Engine>(() => (localStorage.getItem("asadal-live-script-engine") as Engine) || "openai");
  const [openAIApiKey, setOpenAIApiKey] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [diarizationEngine, setDiarizationEngine] = useState<DiarizationEngine>("openai");
  const [capabilities, setCapabilities] = useState<SessionSnapshot["capabilities"]>({
    openAIDiarization: false,
    localPyannoteDiarization: false,
  });
  const [health, setHealth] = useState<Health>();
  const [source, setSource] = useState<Source>("youtube");
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [prompt, setPrompt] = useState("");
  const [keywords, setKeywords] = useState("");
  const [delay, setDelay] = useState("low");
  const [recordAudio, setRecordAudio] = useState(true);
  const [sentencesPerParagraph, setSentencesPerParagraph] = useState(() => Number(localStorage.getItem("asadal-live-script-paragraph-sentences")) || SENTENCES_PER_PARAGRAPH);
  const [sessionId, setSessionId] = useState<string>();
  const [status, setStatus] = useState<Status>("idle");
  const [statusMessage, setStatusMessage] = useState("입력 소스를 선택하고 실시간 기록을 시작하세요.");
  const [transcripts, setTranscripts] = useState<Transcript[]>([]);
  const [partials, setPartials] = useState<Record<string, string>>({});
  const [recording, setRecording] = useState<Recording>(emptyRecording);
  const [diarization, setDiarization] = useState<DiarizationResult>();
  const [diarizing, setDiarizing] = useState(false);
  const [perplexityApiKey, setPerplexityApiKey] = useState("");
  const [showPerplexityKey, setShowPerplexityKey] = useState(false);
  const [analyzingTask, setAnalyzingTask] = useState<AnalysisTask>();
  const [analysis, setAnalysis] = useState<AnalysisResult>();
  const [analysisError, setAnalysisError] = useState("");
  const [copied, setCopied] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const endRef = useRef<HTMLDivElement>(null);
  const eventSourceRef = useRef<EventSource | undefined>(undefined);
  const microphoneRef = useRef<MicrophoneController | undefined>(undefined);
  const downloadMenuRef = useRef<HTMLDetailsElement>(null);

  const isSessionActive = ["connecting", "live", "paused", "stopping"].includes(status);
  const inputReady = source === "microphone" || Boolean(youtubeUrl);
  const selectedEngineReady = engine === "openai"
    ? Boolean(openAIApiKey.trim()) || health?.engines.openai.serverKeyConfigured !== false
    : health?.engines.localWhisper.configured !== false;
  const canStart = inputReady && selectedEngineReady;
  const paragraphs = useMemo(() => groupIntoParagraphs(transcripts, sentencesPerParagraph), [transcripts, sentencesPerParagraph]);
  const fullText = useMemo(() => paragraphs.map((item) => item.text).join("\n"), [paragraphs]);
  const videoId = useMemo(() => getYouTubeVideoId(youtubeUrl), [youtubeUrl]);
  const elapsed = formatElapsedTime(elapsedSeconds);
  const partialText = Object.values(partials).join(" ");
  const perplexityServerKey = Boolean(health?.analysis.perplexity.serverKeyConfigured);
  const analysisReady = Boolean(fullText) && !isSessionActive && !analyzingTask && (perplexityServerKey || Boolean(perplexityApiKey.trim()));
  const engineName = engine === "openai" ? "OpenAI API" : "로컬 Whisper";

  useEffect(() => {
    void fetch("/api/health")
      .then((response) => response.json())
      .then((data: Health) => {
        setHealth(data);
        if (engine === "local-whisper" && !data.engines.localWhisper.configured) setEngine("openai");
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => localStorage.setItem("asadal-live-script-engine", engine), [engine]);
  useEffect(() => localStorage.setItem("asadal-live-script-paragraph-sentences", String(sentencesPerParagraph)), [sentencesPerParagraph]);

  useEffect(() => {
    if (status !== "live") return;
    const timer = window.setInterval(() => setElapsedSeconds((current) => current + 1), 1000);
    return () => window.clearInterval(timer);
  }, [status]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [transcripts, partials]);

  useEffect(() => () => {
    eventSourceRef.current?.close();
    void microphoneRef.current?.stop();
  }, []);

  async function startOrResume() {
    if (status === "paused" && sessionId) {
      await controlSession("resume");
      return;
    }

    setStatus("connecting");
    setStatusMessage(source === "microphone" ? "마이크 사용 권한과 전사 세션을 준비하고 있습니다." : "전사 세션을 준비하고 있습니다.");
    setTranscripts([]);
    setPartials({});
    setDiarization(undefined);
    setRecording({ enabled: recordAudio, available: false });
    setElapsedSeconds(0);
    let newSessionId: string | undefined;

    try {
      eventSourceRef.current?.close();
      await microphoneRef.current?.stop();
      microphoneRef.current = undefined;
      if (sessionId) await fetch(`/api/sessions/${sessionId}`, { method: "DELETE" });

      const response = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          engine,
          openAIApiKey: openAIApiKey.trim() || undefined,
          source,
          youtubeUrl: source === "youtube" ? youtubeUrl : undefined,
          prompt,
          keywords: keywords.split(",").map((item) => item.trim()).filter(Boolean),
          delay,
          recordAudio,
        }),
      });
      const data = await response.json() as SessionSnapshot & { error?: string };
      if (!response.ok) throw new Error(data.error || "세션을 시작하지 못했습니다.");
      newSessionId = data.id;
      setSessionId(data.id);
      setRecording(data.recording);
      setCapabilities(data.capabilities);
      if (!data.capabilities.openAIDiarization && data.capabilities.localPyannoteDiarization) {
        setDiarizationEngine("local-pyannote");
      }
      setOpenAIApiKey("");
      connectEvents(data.id);

      if (source === "microphone") {
        microphoneRef.current = await startMicrophone(data.id, (message) => {
          setStatus("error");
          setStatusMessage(message);
        });
      }
    } catch (error) {
      if (newSessionId) await fetch(`/api/sessions/${newSessionId}`, { method: "DELETE" });
      setStatus("error");
      setStatusMessage(error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다.");
    }
  }

  async function controlSession(action: "pause" | "resume") {
    if (!sessionId) return;
    try {
      const response = await fetch(`/api/sessions/${sessionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "전사 상태를 변경하지 못했습니다.");
    } catch (error) {
      setStatus("error");
      setStatusMessage(error instanceof Error ? error.message : "전사 상태를 변경하지 못했습니다.");
    }
  }

  function connectEvents(id: string) {
    eventSourceRef.current?.close();
    const eventSource = new EventSource(`/api/sessions/${id}/events`);
    eventSourceRef.current = eventSource;
    eventSource.onmessage = (message) => {
      const event = JSON.parse(message.data) as StreamEvent;
      if (event.type === "status") {
        setStatus(event.status);
        setStatusMessage(event.message);
      } else if (event.type === "partial") {
        setPartials((current) => ({ ...current, [event.itemId]: (current[event.itemId] || "") + event.text }));
      } else if (event.type === "final") {
        if (!event.text) return;
        setTranscripts((current) => [...current.filter((item) => item.itemId !== event.itemId), event].sort((a, b) => a.sequence - b.sequence));
        setPartials((current) => {
          const next = { ...current };
          delete next[event.itemId];
          return next;
        });
      } else if (event.type === "error") {
        setStatus("error");
        setStatusMessage(event.message);
      }
    };
    eventSource.onerror = () => {
      if (eventSource.readyState !== EventSource.CLOSED) setStatusMessage("서버 이벤트 연결을 다시 시도하고 있습니다.");
    };
  }

  async function stop() {
    if (!sessionId) return;
    setStatus("stopping");
    try {
      const response = await fetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
      const data = await response.json() as SessionSnapshot & { error?: string };
      if (!response.ok) throw new Error(data.error || "전사를 정지하지 못했습니다.");
      await microphoneRef.current?.stop();
      microphoneRef.current = undefined;
      eventSourceRef.current?.close();
      setRecording(data.recording);
      setStatus("stopped");
      setStatusMessage(data.recording.available
        ? "전사가 종료됐습니다. 임시 녹음으로 화자 분리를 실행할 수 있습니다."
        : "전사가 종료됐습니다.");
    } catch (error) {
      setStatus("error");
      setStatusMessage(error instanceof Error ? error.message : "전사를 정지하지 못했습니다.");
    }
  }

  async function runDiarization() {
    if (!sessionId || !recording.available) return;
    setDiarizing(true);
    try {
      const response = await fetch(`/api/sessions/${sessionId}/diarize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ engine: diarizationEngine }),
      });
      const data = await response.json() as DiarizationResult & { error?: string };
      if (!response.ok) throw new Error(data.error || "화자 분리를 처리하지 못했습니다.");
      setDiarization(data);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "화자 분리를 처리하지 못했습니다.");
    } finally {
      setDiarizing(false);
    }
  }

  async function runAnalysis(task: AnalysisTask) {
    setAnalyzingTask(task);
    setAnalysisError("");
    try {
      const response = await fetch("/api/analysis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          task,
          transcript: fullText,
          keywords: keywords.split(",").map((item) => item.trim()).filter(Boolean),
          perplexityApiKey: perplexityServerKey ? undefined : perplexityApiKey.trim() || undefined,
        }),
      });
      const data = await response.json() as Omit<AnalysisResult, "task"> & { error?: string };
      if (!response.ok) throw new Error(data.error || "Perplexity 분석을 처리하지 못했습니다.");
      setAnalysis({ task, text: data.text, sources: data.sources });
    } catch (error) {
      setAnalysisError(error instanceof Error ? error.message : "Perplexity 분석을 처리하지 못했습니다.");
    } finally {
      setAnalyzingTask(undefined);
    }
  }

  function downloadAnalysis(result: AnalysisResult) {
    // 본문의 [1], [2] 번호와 같은 순서로 출처를 적는다.
    const sources = result.sources.map((source, index) => `[${index + 1}] ${source.title} ${source.url}`).join("\n");
    const content = sources ? `${result.text}\n\n출처\n${sources}\n` : `${result.text}\n`;
    downloadBlob(content, `${result.task}-${new Date().toISOString().slice(0, 10)}.txt`);
  }

  async function deleteRecording() {
    if (!sessionId || !recording.available) return;
    if (!window.confirm("임시 녹음과 화자 분리 결과를 삭제하시겠습니까? 삭제한 음성은 복구할 수 없습니다.")) return;
    const response = await fetch(`/api/sessions/${sessionId}/recording`, { method: "DELETE" });
    const data = await response.json() as SessionSnapshot & { error?: string };
    if (!response.ok) {
      setStatusMessage(data.error || "임시 음성을 삭제하지 못했습니다.");
      return;
    }
    setRecording(data.recording);
    setDiarization(undefined);
    setStatusMessage("임시 녹음을 삭제했습니다.");
  }

  async function copyText() {
    await navigator.clipboard.writeText(fullText);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  function downloadText(includeTimestamps: boolean) {
    const content = serializeTranscripts(paragraphs, includeTimestamps);
    const suffix = includeTimestamps ? "with-timestamps" : "text-only";
    downloadBlob(content, `live-transcript-${new Date().toISOString().slice(0, 10)}-${suffix}.txt`);
    if (downloadMenuRef.current) downloadMenuRef.current.open = false;
  }

  return (
    <div className="app-shell">
      <header className="site-header">
        <a className="brand" href="/" aria-label="asadal's Live Script 홈">
          <span className="brand-mark"><Radio size={18} /></span>
          <span>asadal's Live Script</span>
        </a>
        <div className="theme-switcher" aria-label="화면 테마">
          {(["system", "light", "dark"] as Theme[]).map((item) => (
            <button key={item} className={theme === item ? "active" : ""} onClick={() => setTheme(item)} aria-label={`${item} 테마`}>
              {item === "system" ? <span className="system-icon">A</span> : item === "light" ? <Sun size={16} /> : <Moon size={16} />}
            </button>
          ))}
        </div>
      </header>

      <main>
        <section className="hero">
          <span className="eyebrow"><span className="live-dot" /> HYBRID REALTIME STT</span>
          <h1>라이브 음성을<br /><span>읽을 수 있는 기록</span>으로.</h1>
          <p>OpenAI API와 Mac의 로컬 Whisper 중 상황에 맞는 엔진을 골라 한국어 음성을 실시간으로 기록합니다.</p>
        </section>

        <section className="panel setup-panel">
          <div className="panel-heading">
            <div><span className="step">01</span><h2>전사 설정</h2></div>
            {engine === "openai" ? <Cloud size={22} /> : <Cpu size={22} />}
          </div>

          <div className="setting-label">전사 엔진</div>
          <div className="engine-switcher" aria-label="전사 엔진 선택">
            <button type="button" className={engine === "openai" ? "active" : ""} onClick={() => setEngine("openai")} disabled={isSessionActive}>
              <span className="engine-icon"><Cloud size={18} /></span>
              <span><strong>OpenAI API</strong><small>낮은 지연 · 외부 전송</small></span>
              <i className={health?.engines.openai.serverKeyConfigured || openAIApiKey ? "ready" : ""}>{health ? (health.engines.openai.serverKeyConfigured ? "서버 키" : openAIApiKey ? "입력됨" : "키 필요") : "확인 중"}</i>
            </button>
            <button type="button" className={engine === "local-whisper" ? "active" : ""} onClick={() => setEngine("local-whisper")} disabled={isSessionActive || health?.engines.localWhisper.configured === false}>
              <span className="engine-icon"><Cpu size={18} /></span>
              <span><strong>로컬 Whisper</strong><small>Apple Silicon · 기기 내 처리</small></span>
              <i className={health?.engines.localWhisper.configured ? "ready" : ""}>{health ? (health.engines.localWhisper.configured ? "준비됨" : "미설정") : "확인 중"}</i>
            </button>
          </div>
          <p className="engine-help">{engine === "openai" ? "음성이 OpenAI 서버로 전송되며 부분 전사를 빠르게 표시합니다." : "whisper.cpp 서버가 4~16초 구간으로 처리하므로 문장이 묶여 표시됩니다."}</p>

          <div className="api-key-field">
            <label htmlFor="openai-api-key">OpenAI API 키 <span>{health?.engines.openai.serverKeyConfigured ? "선택 입력 · 입력하면 서버 키보다 우선합니다" : "OpenAI 방식 이용 시 필요합니다"}</span></label>
            <div>
              <input
                id="openai-api-key"
                type={showApiKey ? "text" : "password"}
                value={openAIApiKey}
                onChange={(event) => setOpenAIApiKey(event.target.value)}
                placeholder="sk-proj-..."
                autoComplete="off"
                spellCheck={false}
                disabled={isSessionActive}
              />
              <button type="button" onClick={() => setShowApiKey((value) => !value)} aria-label={showApiKey ? "API 키 숨기기" : "API 키 보기"} disabled={isSessionActive}>
                {showApiKey ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
            <small>키는 브라우저 저장소나 파일에 저장하지 않으며 현재 세션을 위해 서버 메모리에만 보관합니다. 원격 접속에서는 반드시 HTTPS를 사용하세요.</small>
          </div>

          <div className="setting-label source-label">입력 소스</div>
          <div className="source-switcher" aria-label="입력 소스 선택">
            <button type="button" className={source === "youtube" ? "active" : ""} onClick={() => setSource("youtube")} disabled={isSessionActive}>
              <TvMinimalPlay size={17} /> 유튜브 라이브
            </button>
            <button type="button" className={source === "microphone" ? "active" : ""} onClick={() => setSource("microphone")} disabled={isSessionActive}>
              <Mic size={17} /> 컴퓨터 마이크
            </button>
          </div>

          {source === "youtube" ? (
            <div className="source-field">
              <label htmlFor="youtube-url">유튜브 라이브 URL</label>
              <input id="youtube-url" type="url" placeholder="https://www.youtube.com/watch?v=..." value={youtubeUrl} onChange={(event) => setYoutubeUrl(event.target.value)} required disabled={isSessionActive} />
            </div>
          ) : (
            <div className="microphone-notice">
              <span><Mic size={18} /></span>
              <div><strong>브라우저 마이크 사용</strong><p>시작을 누르면 마이크 접근 권한을 요청합니다. localhost 또는 HTTPS 환경에서 사용할 수 있습니다.</p></div>
            </div>
          )}

          <details className="advanced">
            <summary>인식·저장 설정 <ChevronDown size={16} /></summary>
            <div className="advanced-content">
              <div className="field prompt-field">
                <label htmlFor="prompt">음성 맥락</label>
                <textarea id="prompt" rows={3} placeholder="예: 인공지능 정책을 다루는 뉴스 토론" value={prompt} onChange={(event) => setPrompt(event.target.value)} disabled={isSessionActive} />
              </div>
              <div className="field">
                <label htmlFor="keywords">주요 용어 <span>쉼표로 구분</span></label>
                <input id="keywords" placeholder="한겨레, 생성형 AI, 미디어 전략" value={keywords} onChange={(event) => setKeywords(event.target.value)} disabled={isSessionActive} />
              </div>
              <div className="field">
                <label htmlFor="delay">속도와 정확도</label>
                <select id="delay" value={delay} onChange={(event) => setDelay(event.target.value)} disabled={isSessionActive}>
                  <option value="minimal">가장 빠르게</option>
                  <option value="low">빠르게 · 권장</option>
                  <option value="medium">균형</option>
                  <option value="high">정확도 우선</option>
                  <option value="xhigh">최고 정확도</option>
                </select>
              </div>
              <label className="record-option prompt-field">
                <input type="checkbox" checked={recordAudio} onChange={(event) => setRecordAudio(event.target.checked)} disabled={isSessionActive} />
                <span><strong>화자 분리용 임시 음성 저장</strong><small>정지 후 MP3로 내려받거나 화자 분리를 실행할 수 있으며 기본 24시간 뒤 삭제됩니다.</small></span>
              </label>
            </div>
          </details>

          <div className={`status-card ${status}`} role="status">
            <span className="status-icon">{status === "connecting" || status === "stopping" ? <LoaderCircle size={18} className="spin" /> : status === "paused" ? <Pause size={18} /> : <Radio size={18} />}</span>
            <div><strong>{statusLabel[status]}</strong><span>{statusMessage}</span></div>
            <time>{elapsed}</time>
          </div>
        </section>

        <section className="live-stage">
          <section className="panel video-panel">
            <div className="panel-heading media-heading">
              <div><span className="step">02</span><h2>{source === "youtube" ? "라이브 방송" : "마이크 입력"}</h2></div>
              {status === "live" && <span className="live-badge"><i /> LIVE</span>}
            </div>
            <div className="video-frame">
              {source === "youtube" ? (videoId ? (
                <iframe
                  src={`https://www.youtube-nocookie.com/embed/${videoId}?rel=0`}
                  title="유튜브 라이브 방송"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                  referrerPolicy="strict-origin-when-cross-origin"
                  allowFullScreen
                />
              ) : (
                <div className="video-placeholder"><span><TvMinimalPlay size={28} /></span><strong>방송 미리보기</strong><p>유효한 유튜브 링크를 입력하면<br />이곳에 영상이 표시됩니다.</p></div>
              )) : (
                <div className={`microphone-stage ${status === "live" ? "active" : ""}`}>
                  <span className="microphone-orbit"><Mic size={34} /></span>
                  <strong>{status === "live" ? "마이크를 듣고 있습니다" : "마이크 입력 대기"}</strong>
                  <p>헤드폰을 사용하면 스피커 소리의 재입력을 줄일 수 있습니다.</p>
                </div>
              )}
            </div>
            <footer className="video-footer">
              <span>{source === "youtube" ? (videoId ? "유튜브 플레이어 연결됨" : "영상 대기 중") : "브라우저 마이크"}</span>
              <span>일시중지는 실시간 전사만 멈추며 임시 녹음은 계속됩니다.</span>
            </footer>
          </section>

          <section className="panel transcript-panel">
            <div className="panel-heading transcript-heading">
              <div><span className="step">03</span><h2>실시간 기록</h2></div>
              <div className="transcript-tools">
                <div className="recording-controls" aria-label="실시간 기록 제어">
                  <button className="control-button start" type="button" onClick={startOrResume} disabled={!canStart || status === "connecting" || status === "live" || status === "stopping"}>
                    <Play size={14} fill="currentColor" /> {status === "paused" ? "계속" : "시작"}
                  </button>
                  <button className="control-button" type="button" onClick={() => controlSession("pause")} disabled={status !== "live"}>
                    <Pause size={14} fill="currentColor" /> 일시중지
                  </button>
                  <button className="control-button stop" type="button" onClick={stop} disabled={!sessionId || !["connecting", "live", "paused", "error"].includes(status)}>
                    <Square size={13} fill="currentColor" /> 정지
                  </button>
                </div>
                <div className="actions">
                  <select className="paragraph-select" value={sentencesPerParagraph} onChange={(event) => setSentencesPerParagraph(Number(event.target.value))} aria-label="단락 길이" title="단락 길이: 이 문장 수 이상 모이면 다음 단락으로 나눕니다.">
                    {[1, 2, 3, 4, 5, 6, 8, 10].map((count) => <option key={count} value={count}>{count === 1 ? "문장마다" : `${count}문장씩`}</option>)}
                  </select>
                  <button type="button" onClick={copyText} disabled={!fullText} aria-label="텍스트 복사">{copied ? <Check size={17} /> : <Clipboard size={17} />}</button>
                  <details className="download-menu" ref={downloadMenuRef}>
                    <summary className={!fullText ? "disabled" : ""} aria-label="텍스트 다운로드" onClick={(event) => { if (!fullText) event.preventDefault(); }}><Download size={17} /></summary>
                    {fullText && <div className="download-options"><button type="button" onClick={() => downloadText(true)}>타임스탬프 포함</button><button type="button" onClick={() => downloadText(false)}>텍스트만</button></div>}
                  </details>
                </div>
              </div>
            </div>
            <div className="transcript-body" aria-live="polite">
              {!transcripts.length && !partialText ? (
                <div className="empty-state"><div className="sound-wave"><i /><i /><i /><i /><i /></div><strong>아직 기록이 없습니다</strong><span>실시간 기록을 시작하면 이곳에 텍스트가 나타납니다.</span></div>
              ) : (
                <div className="transcript-list">
                  {paragraphs.map((item) => <p key={item.id}><time>{new Date(item.receivedAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}</time><span>{item.text}</span></p>)}
                  {partialText && <p className="partial"><time>지금</time><span>{partialText}<i className="cursor" /></span></p>}
                  <div ref={endRef} />
                </div>
              )}
            </div>
            <footer className="transcript-footer"><span>{paragraphs.length}개 단락</span><span>한국어 · {engineName}</span></footer>
          </section>
        </section>

        {recordAudio && (sessionId || status === "idle") && (
          <section className="panel postprocess-panel">
            <div className="panel-heading postprocess-heading">
              <div><span className="step">04</span><h2>임시 음성·화자 분리</h2></div>
              <Users size={22} />
            </div>
            {recording.available && sessionId ? (
              <>
                <div className="recording-summary">
                  <span className="file-icon"><FileAudio size={22} /></span>
                  <div><strong>{recording.fileName}</strong><span>{formatBytes(recording.sizeBytes)} · {recording.expiresAt ? `${new Date(recording.expiresAt).toLocaleString("ko-KR")} 자동 삭제` : "임시 저장"}</span></div>
                  <div className="recording-actions">
                    <a className="small-button" href={`/api/sessions/${sessionId}/recording`}><Download size={14} /> 음성 다운로드</a>
                    <button className="small-button primary" type="button" onClick={runDiarization} disabled={diarizing || (diarizationEngine === "openai" ? !capabilities.openAIDiarization : !capabilities.localPyannoteDiarization)}>{diarizing ? <LoaderCircle size={14} className="spin" /> : <Users size={14} />} {diarizing ? "분석 중" : "화자 분리"}</button>
                    <button className="small-button danger-text" type="button" onClick={deleteRecording} disabled={diarizing}><Trash2 size={14} /> 삭제</button>
                  </div>
                </div>
                <div className="diarization-engine-row">
                  <div><strong>화자 분리 엔진</strong><span>전사 엔진과 별도로 선택할 수 있습니다.</span></div>
                  <div className="diarization-switcher">
                    <button type="button" className={diarizationEngine === "openai" ? "active" : ""} onClick={() => { setDiarizationEngine("openai"); setDiarization(undefined); }} disabled={diarizing || !capabilities.openAIDiarization}>OpenAI API</button>
                    <button type="button" className={diarizationEngine === "local-pyannote" ? "active" : ""} onClick={() => { setDiarizationEngine("local-pyannote"); setDiarization(undefined); }} disabled={diarizing || !capabilities.localPyannoteDiarization}>로컬 pyannote</button>
                  </div>
                </div>
                {diarization && (
                  <div className="diarization-result">
                    <div className="result-heading">
                      <div><strong>화자 분리 결과</strong><span>{diarizationEngine === "openai" ? "OpenAI API" : "pyannote community-1"} · {diarization.segments.length}개 발화 · {diarization.chunkCount}개 처리 구간</span></div>
                      <button className="small-button" type="button" onClick={() => downloadBlob(serializeDiarizedSegments(diarization.segments), `speaker-transcript-${new Date().toISOString().slice(0, 10)}.txt`)}><Download size={14} /> 결과 다운로드</button>
                    </div>
                    {diarization.speakerLabelsAreChunkLocal && <p className="chunk-warning">긴 녹음은 여러 파일로 나눠 처리하므로 화자 표시는 각 처리 구간 안에서만 일관됩니다.</p>}
                    <div className="speaker-list">
                      {diarization.segments.map((segment, index) => (
                        <article key={`${segment.chunkIndex}-${segment.start}-${index}`}>
                          <div><time>{formatElapsedTime(segment.start)}</time><span className="speaker-badge">{diarization.speakerLabelsAreChunkLocal ? `구간 ${segment.chunkIndex + 1} · ` : ""}{segment.speaker}</span></div>
                          <p>{segment.text}</p>
                        </article>
                      ))}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div className="postprocess-empty"><FileAudio size={24} /><div><strong>{status === "stopped" ? "저장된 음성이 없습니다" : "전사를 정지하면 임시 음성이 준비됩니다"}</strong><span>정지 후 OpenAI API 또는 로컬 pyannote로 화자를 분리할 수 있습니다.</span></div></div>
            )}
          </section>
        )}

        <section className="panel postprocess-panel analysis-panel">
          <div className="panel-heading postprocess-heading">
            <div><span className="step">{recordAudio ? "05" : "04"}</span><h2>LLM 분석 · Perplexity</h2></div>
            <Sparkles size={22} />
          </div>
          <div className="analysis-setup">
            <div className="api-key-field">
              <label htmlFor="perplexity-api-key">Perplexity API 키 <span>{perplexityServerKey ? "서버 .env 키를 사용합니다" : health ? "서버 키가 없어 입력한 키를 사용합니다" : "확인 중"}</span></label>
              <div>
                <input
                  id="perplexity-api-key"
                  type={showPerplexityKey ? "text" : "password"}
                  value={perplexityApiKey}
                  onChange={(event) => setPerplexityApiKey(event.target.value)}
                  placeholder={perplexityServerKey ? "서버 키 사용 중" : "pplx-..."}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={perplexityServerKey || Boolean(analyzingTask)}
                />
                <button type="button" onClick={() => setShowPerplexityKey((value) => !value)} aria-label={showPerplexityKey ? "API 키 숨기기" : "API 키 보기"} disabled={perplexityServerKey}>
                  {showPerplexityKey ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
              <small>서버의 PERPLEXITY_API_KEY가 있으면 그 키를 먼저 쓰고, 없을 때만 여기 입력한 키를 씁니다. 입력한 키는 저장하지 않고 분석 요청에만 사용합니다.</small>
            </div>
            <div className="analysis-actions">
              <button className="small-button primary" type="button" onClick={() => runAnalysis("summary")} disabled={!analysisReady}>{analyzingTask === "summary" ? <LoaderCircle size={14} className="spin" /> : <ListChecks size={14} />} 요약·정리</button>
              <button className="small-button primary" type="button" onClick={() => runAnalysis("fact-check")} disabled={!analysisReady}>{analyzingTask === "fact-check" ? <LoaderCircle size={14} className="spin" /> : <SearchCheck size={14} />} 팩트체크</button>
              <button className="small-button primary" type="button" onClick={() => runAnalysis("correction")} disabled={!analysisReady}>{analyzingTask === "correction" ? <LoaderCircle size={14} className="spin" /> : <SpellCheck size={14} />} 용어·고유명사 교정</button>
            </div>
            {analysisError && <p className="analysis-help analysis-error" role="alert">{analysisError}</p>}
            <p className="analysis-help">{isSessionActive ? "전사를 정지하면 기록 전체로 분석할 수 있습니다." : fullText ? "실시간 기록 전체를 Perplexity로 보냅니다. 팩트체크와 교정은 웹 검색을 함께 사용합니다." : "실시간 기록이 생기면 분석할 수 있습니다."}</p>
          </div>
          {analysis && (
            <div className="diarization-result">
              <div className="result-heading">
                <div><strong>{analysisTaskLabel[analysis.task]} 결과</strong><span>Perplexity sonar-pro · 출처 {analysis.sources.length}개</span></div>
                <button className="small-button" type="button" onClick={() => downloadAnalysis(analysis)}><Download size={14} /> 결과 다운로드</button>
              </div>
              <div className="analysis-text">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" /> }}>{analysis.text}</ReactMarkdown>
              </div>
              {analysis.sources.length > 0 && (
                <ol className="analysis-sources">
                  {analysis.sources.map((source, index) => <li key={`${index}-${source.url}`}><a href={source.url} target="_blank" rel="noreferrer">{source.title}</a></li>)}
                </ol>
              )}
            </div>
          )}
        </section>
      </main>
      <footer className="site-footer"><span>asadal's Live Script</span><span>임시 음성은 설정된 보존 시간이 지나면 자동 삭제됩니다.</span></footer>
    </div>
  );
}
