# asadal's Live Script

유튜브 라이브 또는 컴퓨터 마이크의 한국어 음성을 실시간 전사하는 하이브리드 웹앱입니다. 실시간 엔진은 OpenAI Realtime API와 Apple Silicon용 로컬 `whisper.cpp` 중에서, 녹음 후 화자 분리 엔진은 OpenAI API와 로컬 `pyannote.audio community-1` 중에서 각각 선택할 수 있습니다.

## 주요 기능

- 유튜브 라이브와 컴퓨터 마이크 입력
- OpenAI `gpt-live-transcribe` 또는 로컬 Whisper 실시간 전사
- OpenAI `gpt-4o-transcribe-diarize` 또는 로컬 `community-1` 화자 분리
- Apple Silicon의 Metal 가속을 사용하는 `whisper.cpp`
- 영상·마이크 입력과 독립된 전사 시작·일시중지·계속·정지
- 부분 전사와 확정 전사 표시
- 타임스탬프 포함 또는 텍스트 전용 다운로드
- 세션 음성을 운영체제 임시폴더에 MP3로 저장
- 임시 음성·화자 분리 결과 다운로드와 즉시 삭제
- 웹페이지에서 세션용 OpenAI API 키 입력
- 시스템·라이트·다크 테마

웹에서 입력한 API 키는 브라우저 저장소나 파일에 저장하지 않으며, 세션 생성 요청을 통해 서버 메모리로만 전달됩니다. 서버가 응답 본문에 키를 포함하거나 애플리케이션 로그에 직접 기록하지도 않습니다. 공개 배포에서는 반드시 HTTPS를 사용하고 요청 본문 로깅을 꺼야 합니다. 운영 환경에서는 웹 입력보다 서버의 비밀 관리 기능 또는 `OPENAI_API_KEY` 환경 변수를 권장합니다.

## 처리 구조

### 실시간 전사

1. 유튜브 입력은 `yt-dlp`, 마이크 입력은 Web Audio API로 수집합니다.
2. FFmpeg가 음성을 mono PCM16으로 변환합니다.
3. OpenAI 방식은 24kHz PCM을 Realtime WebSocket으로 전송합니다.
4. 로컬 방식은 16kHz PCM을 겹치는 짧은 구간으로 나눠 `whisper.cpp` 서버에 전송합니다.
5. 화자 분리를 켜면 별도로 16kHz mono MP3를 임시폴더에 기록합니다.

### 녹음 후 화자 분리

화자 분리는 실시간 엔진과 독립적으로 선택합니다.

- **OpenAI API**: 녹음을 8분 단위로 나누고 `gpt-4o-transcribe-diarize`에 전송합니다. 긴 녹음의 화자 레이블은 처리 구간마다 다시 시작될 수 있습니다.
- **로컬 pyannote**: `community-1`이 전체 녹음에서 화자 구간을 계산합니다. 같은 녹음을 로컬 Whisper가 SRT 타임스탬프로 다시 전사하고, 서버가 시간 겹침이 가장 큰 화자를 각 문장에 배정합니다. 결과는 익명 레이블 `화자 1`, `화자 2`처럼 표시됩니다.

`community-1`의 `exclusive_speaker_diarization`이 있으면 이를 우선 사용하므로 전사 타임스탬프와 결합하기 쉽습니다. 화자 분리는 사람의 실제 신원을 알아내는 기능이 아닙니다.

## 제어 동작

- **일시중지**는 실시간 전사 엔진으로 보내는 오디오만 멈춥니다. 입력 수신과 임시 녹음은 계속됩니다.
- **계속**은 현재 시점부터 실시간 전사를 재개합니다.
- **정지**는 입력·전사·녹음을 끝내고 MP3 파일을 확정합니다.
- 유튜브 플레이어의 재생·일시중지·탐색은 서버의 전사 상태에 영향을 주지 않습니다.

## 폴더 구조

```text
youtube-live-stt/
├── server/
│   ├── index.ts                       # Express API·WebSocket·정적 서버
│   ├── transcription-session.ts       # 입력·전사·녹음 세션
│   ├── openai-transcription-engine.ts # OpenAI Realtime 어댑터
│   ├── local-whisper-engine.ts        # whisper.cpp 실시간 어댑터
│   ├── diarization.ts                 # OpenAI 화자 분리
│   ├── local-diarization.ts           # pyannote·Whisper 결과 결합
│   ├── temporary-audio.ts             # 임시 녹음 관리
│   └── *.test.ts
├── src/
│   ├── App.tsx                        # UI와 세션 상태
│   ├── microphone.ts                  # 브라우저 마이크 PCM 캡처
│   ├── transcript.ts                  # 다운로드 형식
│   ├── styles.css                     # 반응형·테마 스타일
│   └── *.test.ts
├── scripts/
│   ├── setup-whisper-mac.sh
│   ├── start-whisper-mac.sh
│   ├── setup-pyannote-mac.sh
│   └── diarize_pyannote.py
├── .env.example
├── .gitignore
├── package.json
└── vite.config.ts
```

## 요구 사항

- Node.js 20 이상, npm
- FFmpeg와 FFprobe
- 유튜브 입력용 `yt-dlp`
- OpenAI 방식: 유효한 API 키와 해당 모델 사용 권한
- 로컬 실시간 전사: Apple Silicon Mac, CMake, `whisper.cpp`
- 로컬 화자 분리: Python 3.10 이상, Hugging Face 계정·토큰, `community-1` 약관 동의
- 마이크 입력: 최신 Chrome, Edge, Firefox 또는 Safari

```bash
brew install ffmpeg yt-dlp cmake python
```

## 설치

```bash
git clone <YOUR_REPOSITORY_URL>
cd youtube-live-stt
npm install
cp .env.example .env
```

`.env` 예시:

```dotenv
# 서버 공용 키는 선택 사항입니다. 웹에서도 세션별로 입력할 수 있습니다.
OPENAI_API_KEY=sk-proj-your-key
WHISPER_CPP_URL=http://127.0.0.1:8080

# 로컬 화자 분리용. community-1 약관 동의 후 read 토큰을 설정합니다.
HUGGINGFACE_TOKEN=hf_your-read-token
# PYANNOTE_PYTHON=/absolute/path/to/vendor/pyannote-venv/bin/python
# PYANNOTE_MODEL_PATH=/absolute/path/to/offline/community-1

PORT=3001
TEMP_AUDIO_TTL_HOURS=24
# TEMP_AUDIO_DIR=/absolute/path/to/private/temp-directory
```

| 환경 변수 | 기본값 | 설명 |
|---|---:|---|
| `OPENAI_API_KEY` | 없음 | 서버 공용 OpenAI 키. 웹 입력 키가 있으면 해당 세션에서는 웹 입력 키를 우선 사용 |
| `WHISPER_CPP_URL` | 없음 | 로컬 `whisper-server` 주소. 로컬 실시간 전사와 로컬 화자 분리 전사에 사용 |
| `HUGGINGFACE_TOKEN` | 없음 | `community-1` 다운로드용 Hugging Face read 토큰 |
| `PYANNOTE_PYTHON` | `vendor/pyannote-venv/bin/python` | pyannote 가상환경 Python 경로 |
| `PYANNOTE_MODEL_PATH` | Hugging Face 모델 ID | 미리 받은 오프라인 모델 디렉터리 |
| `PORT` | `3001` | 프로덕션 서버 포트 |
| `TEMP_AUDIO_TTL_HOURS` | `24` | 임시 음성 보존 시간 |
| `TEMP_AUDIO_DIR` | 운영체제 임시폴더 | 임시 음성 저장 위치 |

`.env`, 가상환경, 모델 파일과 임시 음성은 Git에서 제외됩니다.

## Apple Silicon 로컬 엔진

### whisper.cpp

기본 모델은 실시간성과 품질의 균형을 고려한 `large-v3-turbo`입니다.

```bash
npm run whisper:setup:mac
npm run whisper:mac
```

정확도를 더 우선하려면 설치와 실행에 모두 모델 변수를 지정합니다.

```bash
WHISPER_MODEL=large-v3 npm run whisper:setup:mac
WHISPER_MODEL=large-v3 npm run whisper:mac
```

서버는 기본적으로 `127.0.0.1:8080`에만 바인딩됩니다.

### pyannote.audio community-1

먼저 [모델 페이지](https://huggingface.co/pyannote/speaker-diarization-community-1)에서 사용 조건에 동의하고 read 토큰을 만듭니다. 그다음 전용 가상환경을 설치합니다.

```bash
npm run pyannote:setup:mac
```

출력된 `PYANNOTE_PYTHON`과 `HUGGINGFACE_TOKEN`을 `.env`에 설정한 뒤 앱 서버를 다시 시작합니다. 최초 실행은 모델을 내려받기 때문에 시간이 걸리고 네트워크가 필요합니다. 이후 완전한 오프라인 실행이 필요하면 모델을 로컬 디렉터리에 준비하고 `PYANNOTE_MODEL_PATH`를 지정합니다.

이 프로젝트는 Apple Silicon에서 pyannote를 CPU로 실행합니다. 공식 문서에 CUDA 사용 예시는 있지만 MPS 가속 절차는 명시돼 있지 않아 안정성을 우선한 설정입니다. 긴 녹음은 처리 시간이 상당할 수 있습니다.

## 실행

로컬 Whisper를 사용할 때는 첫 번째 터미널에서 실행합니다.

```bash
npm run whisper:mac
```

두 번째 터미널에서 개발 서버를 실행합니다.

```bash
npm run dev
```

브라우저에서 `http://localhost:5173`을 엽니다. 프로덕션은 다음과 같습니다.

```bash
npm run build
npm start
```

기본 프로덕션 주소는 `http://localhost:3001`입니다. 원격 배포는 HTTPS와 WebSocket 업그레이드 전달이 필요합니다.

## 사용 방법

1. OpenAI API 또는 로컬 Whisper를 선택합니다.
2. OpenAI를 선택하고 서버 키가 없다면 웹 입력란에 API 키를 입력합니다.
3. 유튜브 라이브 또는 컴퓨터 마이크를 선택합니다.
4. 화자 분리가 필요하면 임시 음성 저장을 켭니다.
5. **시작**, **일시중지**, **계속**, **정지**로 전사 상태를 제어합니다.
6. 정지 후 OpenAI 또는 로컬 pyannote 화자 분리 엔진을 선택해 실행합니다.
7. 결과와 임시 음성을 내려받고, 민감한 녹음은 즉시 삭제합니다.

브라우저 마이크는 보안 컨텍스트에서만 동작합니다. `localhost`는 허용되지만 원격 배포에는 HTTPS가 필요합니다.

## 임시 음성 관리

- 파일은 운영체제 임시폴더 아래 세션별 비공개 디렉터리의 `recording.mp3`에 저장됩니다.
- 서버 시작 시 보존 시간이 지난 파일을 정리하며, 실행 중에는 한 시간마다 만료 세션을 정리합니다.
- UI의 삭제 버튼은 해당 세션 음성과 분할 파일을 즉시 삭제합니다.
- 서버가 재시작되면 메모리의 세션과 전사 결과는 사라집니다.

음성에는 개인정보가 포함될 수 있습니다. 참여자 고지·동의, 접근 권한, 보존 기간과 디스크 암호화 정책을 운영 환경에 맞게 마련하세요.

## API

| 메서드 | 경로 | 설명 |
|---|---|---|
| `GET` | `/api/health` | 실시간·화자 분리 엔진 준비 상태 |
| `POST` | `/api/sessions` | 전사 세션 시작 |
| `GET` | `/api/sessions/:id` | 세션·녹음 상태 |
| `GET` | `/api/sessions/:id/events` | SSE 실시간 전사 이벤트 |
| `WS` | `/api/sessions/:id/microphone` | PCM16 마이크 입력 |
| `PATCH` | `/api/sessions/:id` | 전사 일시중지·재개 |
| `DELETE` | `/api/sessions/:id` | 입력·전사·녹음 정지 |
| `POST` | `/api/sessions/:id/diarize` | 선택 엔진으로 화자 분리 |
| `GET` | `/api/sessions/:id/recording` | 임시 MP3 다운로드 |
| `DELETE` | `/api/sessions/:id/recording` | 임시 음성 삭제 |

세션 생성 요청의 `openAIApiKey`는 선택 사항이며 API 응답에는 포함되지 않습니다.

```json
{
  "engine": "openai",
  "source": "microphone",
  "openAIApiKey": "sk-proj-session-key",
  "prompt": "한국어 인터뷰",
  "keywords": ["생성형 AI"],
  "delay": "low",
  "recordAudio": true
}
```

화자 분리 엔진 선택:

```json
{ "engine": "local-pyannote" }
```

## 점검 명령

```bash
npm run typecheck
npm test
npm run build
```

실제 통합 테스트에는 선택한 API 키 또는 실행 중인 로컬 엔진과 접근 가능한 입력이 필요합니다.

## 구현 제약

- 로컬 Whisper HTTP 서버는 네이티브 스트리밍 API가 아니므로 짧은 구간을 반복 전사합니다. 문장 표시가 늦거나 경계에서 드물게 반복·누락될 수 있습니다.
- OpenAI 화자 분리의 파일 업로드 한도에 맞추기 위해 긴 파일을 분할하며, 구간 사이 화자 신원은 자동으로 이어지지 않습니다.
- 로컬 화자 분리는 Whisper SRT 문장과 pyannote 구간의 시간 겹침으로 화자를 배정하므로 동시 발화와 매우 짧은 맞장구는 틀릴 수 있습니다.
- 로컬 pyannote 실행에도 로컬 Whisper 서버가 필요합니다. pyannote는 화자 구간만 만들고 발화 텍스트는 만들지 않기 때문입니다.
- 웹 입력 API 키는 서버 프로세스가 살아 있는 동안 해당 세션 객체의 메모리에 존재합니다. 세션 삭제·만료 또는 서버 종료 전까지 즉시 폐기되는 구조는 아닙니다.

## 운영 시 주의사항

- 처리 권한이 있는 음성만 전사하고 방송 저작권·유튜브 이용약관·녹음 관련 법규를 확인하세요.
- 공개 서비스에서는 인증, 세션 소유권 검증, 요청 제한, 비용 한도, CSRF·WebSocket Origin 검증을 추가하세요.
- 액세스 로그와 오류 수집 도구가 `/api/sessions` 요청 본문을 기록하지 않도록 설정하세요.
- 임시폴더는 웹 서버 계정만 접근하도록 제한하고 로컬 모델 서버를 외부에 공개하지 마세요.

## GitHub에 올리기

```bash
git init
git add .
git commit -m "Add selectable local diarization"
git branch -M main
git remote add origin <YOUR_REPOSITORY_URL>
git push -u origin main
```

## 공식 문서

- [OpenAI Realtime transcription](https://developers.openai.com/api/docs/guides/realtime-transcription)
- [OpenAI Speech to text](https://developers.openai.com/api/docs/guides/speech-to-text)
- [OpenAI API production best practices](https://developers.openai.com/api/docs/guides/production-best-practices)
- [pyannote community-1 모델 카드](https://huggingface.co/pyannote/speaker-diarization-community-1)
- [whisper.cpp](https://github.com/ggml-org/whisper.cpp)
- [whisper.cpp HTTP 서버](https://github.com/ggml-org/whisper.cpp/tree/master/examples/server)
