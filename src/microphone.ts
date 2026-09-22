export interface MicrophoneController {
  stop: () => Promise<void>;
}

function websocketUrl(sessionId: string, sampleRate: number): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/api/sessions/${encodeURIComponent(sessionId)}/microphone?sampleRate=${sampleRate}`;
}

function toPcm16(samples: Float32Array): ArrayBuffer {
  const pcm = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    pcm[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return pcm.buffer;
}

function waitForWebSocket(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error("마이크 전송 서버 연결 시간이 초과됐습니다.")), 8_000);
    socket.addEventListener("open", () => {
      window.clearTimeout(timeout);
      resolve();
    }, { once: true });
    socket.addEventListener("error", () => {
      window.clearTimeout(timeout);
      reject(new Error("마이크 전송 서버에 연결하지 못했습니다."));
    }, { once: true });
  });
}

export async function startMicrophone(
  sessionId: string,
  onError: (message: string) => void,
): Promise<MicrophoneController> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("이 브라우저는 마이크 입력을 지원하지 않습니다.");
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  const context = new AudioContext();
  await context.resume();
  const socket = new WebSocket(websocketUrl(sessionId, context.sampleRate));
  socket.binaryType = "arraybuffer";

  try {
    await waitForWebSocket(socket);
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    await context.close();
    throw error;
  }

  let active = true;
  let disconnectAudio: () => void;
  const sendSamples = (samples: Float32Array) => {
    if (!active || socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > 1024 * 1024) {
      onError("네트워크 지연으로 일부 마이크 음성을 전송하지 못했습니다.");
      return;
    }
    socket.send(toPcm16(samples));
  };

  const source = context.createMediaStreamSource(stream);
  const silentGain = context.createGain();
  silentGain.gain.value = 0;

  if (context.audioWorklet) {
    const processorCode = `
      class PcmCaptureProcessor extends AudioWorkletProcessor {
        constructor() {
          super();
          this.pending = new Float32Array(4096);
          this.offset = 0;
        }
        process(inputs) {
          const channel = inputs[0] && inputs[0][0];
          if (!channel) return true;
          let read = 0;
          while (read < channel.length) {
            const count = Math.min(channel.length - read, this.pending.length - this.offset);
            this.pending.set(channel.subarray(read, read + count), this.offset);
            this.offset += count;
            read += count;
            if (this.offset === this.pending.length) {
              const complete = this.pending;
              this.port.postMessage(complete, [complete.buffer]);
              this.pending = new Float32Array(4096);
              this.offset = 0;
            }
          }
          return true;
        }
      }
      registerProcessor("pcm-capture-processor", PcmCaptureProcessor);
    `;
    const moduleUrl = URL.createObjectURL(new Blob([processorCode], { type: "text/javascript" }));
    try {
      await context.audioWorklet.addModule(moduleUrl);
    } finally {
      URL.revokeObjectURL(moduleUrl);
    }
    const worklet = new AudioWorkletNode(context, "pcm-capture-processor");
    worklet.port.onmessage = (event: MessageEvent<Float32Array>) => sendSamples(event.data);
    source.connect(worklet);
    worklet.connect(silentGain).connect(context.destination);
    disconnectAudio = () => {
      worklet.port.onmessage = null;
      worklet.disconnect();
      silentGain.disconnect();
      source.disconnect();
    };
  } else {
    const processor = context.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (event) => sendSamples(event.inputBuffer.getChannelData(0).slice());
    source.connect(processor);
    processor.connect(silentGain).connect(context.destination);
    disconnectAudio = () => {
      processor.onaudioprocess = null;
      processor.disconnect();
      silentGain.disconnect();
      source.disconnect();
    };
  }

  socket.addEventListener("close", (event) => {
    if (active && event.code !== 1000) onError(event.reason || "마이크 서버 연결이 종료됐습니다.");
  });

  return {
    stop: async () => {
      if (!active) return;
      active = false;
      disconnectAudio();
      stream.getTracks().forEach((track) => track.stop());
      if (socket.readyState === WebSocket.OPEN) socket.close(1000, "마이크 입력 종료");
      await context.close();
    },
  };
}
