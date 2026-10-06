# 💬 카카오 AI 브리지

허용한 카카오톡 대화방에서 평소처럼 말을 걸면, 내가 고른 AI가 같은 방에서 답합니다. 단체방에서는 AI에게 한 말에만 답합니다.

[설치·문제 해결](docs/GUIDE.md) · [소스 내려받기](https://github.com/Dj-Lee2/kakao-ai-bridge/releases) · [보안 안내](SECURITY.md)

## 주요 기능

- **AI 연결 선택**: AI 제공자 API 직접 연결, OpenClaw, Hermes
- **OAuth 기반 AI**: OpenClaw 또는 Hermes에서 지원 제공자에 로그인해 이용
- **허용한 방만 응답**: 방 ID를 직접 지정하며, 비어 있으면 실행 차단
- **1:1 방은 바로 대화**: 접두어 없이 보낸 메시지에 답하고 봇 자신의 메시지는 제외
- **단체방은 나에게 한 말만**: @멘션·봇 메시지에 답장·이름 호출·`!ai` 접두어, 또는 직전 답변에 이어지는 말을 AI가 판별해 응답
- **최소 전달**: 1:1 방은 질문 한 건만, 단체방은 판별·답변에 필요한 최근 대화 몇 줄만 AI에 전달. 카카오 ID·방 이름은 포함하지 않음
- **중복·과다 요청 억제**: 요청량 제한, 발송 결과 확인, 불확실한 발송은 재시도하지 않음

```text
카카오톡 → 브리지 → OpenAI 호환 API
                 또는 OpenClaw / Hermes → OAuth/API로 인증한 AI
         ← 같은 방에 답변 ←
```

## 먼저, 어떤 방식으로 연결할까요?

아래 **세 가지 중 하나만** 선택하세요. OpenClaw와 Hermes를 둘 다 설치할 필요는 없습니다.

- **A. AI 제공자 API 직접 연결** — 브리지만 설치합니다. AI 제공자에서 발급받은 API 키로 직접 요청합니다. OpenClaw·Hermes는 필요 없습니다.
- **B. OpenClaw 연결** — 브리지 외에 **OpenClaw를 별도로 설치·실행**합니다. AI 제공자 로그인/API 키 설정은 OpenClaw에서 하고, 브리지는 OpenClaw의 주소와 게이트웨이 접속 토큰을 사용합니다.
- **C. Hermes 연결** — 브리지 외에 **Hermes를 별도로 설치·실행**합니다. AI 제공자 로그인/API 키 설정은 Hermes에서 하고, 브리지는 Hermes의 주소와 API 서버 접속 키를 사용합니다.

**AI 제공자 API 키**는 AI 서비스를 이용하는 인증입니다. **OpenClaw·Hermes 서버 접속 키**는 내가 준비한 서버에 들어가는 비밀번호 같은 것으로, AI 이용권이나 제공자 인증을 대신하지 않습니다. 서버 접속 키만 적어 넣어도 프로그램이 자동 설치되거나 AI 로그인이 되는 것은 아닙니다.

OpenClaw·Hermes는 브리지와 같은 컴퓨터 또는 별도 서버에서 실행할 수 있습니다. 아래 `127.0.0.1` 예시는 **같은 컴퓨터·같은 네트워크 공간** 기준입니다. 다른 서버나 Docker 컨테이너라면 주소가 달라지며, 원격 연결은 비공개 접근 경로와 HTTPS를 준비하세요.

## 빠른 시작

Node.js **22.13 이상 24.x 이하**와 npm이 필요합니다. Linux 권장, macOS 실기기 미검증입니다. Windows는 WSL의 Linux 파일시스템을 사용하세요.

### 1. 설치

```sh
git clone https://github.com/Dj-Lee2/kakao-ai-bridge.git
cd kakao-ai-bridge
npm ci --ignore-scripts
npm run setup
```

`setup`은 권한 0600의 `.env`를 만들며 기존 파일을 덮어쓰지 않습니다. root 대신 전용 일반 사용자로 실행하세요. **이 `npm ci`는 브리지 의존성만 설치합니다. OpenClaw·Hermes는 설치하지 않습니다.**

### 2. AI 연결 선택

**브리지 폴더의 `kakao-ai-bridge/.env`**에서 아래 **A·B·C 중 하나**를 선택합니다. 카카오 이메일·비밀번호는 이 파일에 넣지 않습니다.

#### A. OpenAI 호환 API

```dotenv
AI_PROVIDER=openai-compatible
AI_BASE_URL=https://api.openai.com/v1
AI_API_KEY=
AI_MODEL=
```

서비스에서 발급한 **API 키**와 정확한 모델 이름을 채우세요. API 기본 주소 뒤에 `/chat/completions`를 붙여 요청합니다. 기존 설정은 `AI_PROVIDER`가 없어도 이 모드로 동작합니다.

#### B. OpenClaw + OAuth

**먼저 OpenClaw를 설치하세요.** 카카오 전용 일반 사용자 환경에서 [공식 설치 안내](https://docs.openclaw.ai/start/getting-started)에 따라 설치·초기 설정을 마칩니다. Linux/macOS 설치 명령은 다음과 같습니다.

```sh
curl -fsSL https://openclaw.ai/install.sh | bash
```

OpenClaw의 Node.js 요구 버전은 브리지와 다를 수 있습니다. 같은 환경에서는 두 프로그램의 지원 범위를 모두 만족하는 버전을 사용하세요.

**카카오 전용으로 분리한 OpenClaw 인스턴스와 에이전트**를 준비합니다. 개인 관리자용 게이트웨이를 그대로 연결하지 마세요. 설치 후 아래 순서로 진행합니다: **전용 에이전트 생성 → 제공자 로그인·모델 선택 → HTTP API·게이트웨이 인증 설정 → 게이트웨이 실행 → 브리지 설정**.

OpenClaw 쪽에서 지원 제공자에 로그인합니다. 현재 공식 문서의 ChatGPT/Codex 예시이며, `kakao-bridge` 에이전트를 먼저 만들어야 합니다.

```sh
openclaw agents add kakao-bridge
openclaw models auth login --provider openai --agent kakao-bridge
```

로그인 후 해당 에이전트의 모델을 선택하고 `gateway.http.endpoints.chatCompletions.enabled=true`를 설정합니다. 단계별 준비는 [OpenClaw 연결 안내](docs/GUIDE.md#b-openclaw--oauth)를 따르세요.

브리지의 `.env`:

```dotenv
AI_PROVIDER=openclaw
OPENCLAW_BASE_URL=http://127.0.0.1:18789/v1
OPENCLAW_GATEWAY_TOKEN=
OPENCLAW_AGENT_ID=kakao-bridge
```

- `OPENCLAW_GATEWAY_TOKEN`: **전용 게이트웨이 접속 토큰**입니다. 제공자의 OAuth 토큰이나 API 키가 아닙니다. 로컬 연결에도 필수입니다.
- `OPENCLAW_AGENT_ID`: 실제 등록된 전용 에이전트 ID입니다. `default` 별칭은 거부하며, 요청 모델은 `openclaw/<ID>`로 지정합니다.
- 이 모드에서는 `AI_BASE_URL`·`AI_API_KEY`·`AI_MODEL`을 사용하지 않습니다. 실제 AI 모델·로그인·토큰 갱신은 OpenClaw가 관리합니다.

OAuth 저장소를 복사하거나 OAuth 토큰을 `AI_API_KEY`에 넣지 마세요. 모든 제공자·구독이 OAuth를 지원하는 것은 아니며, 사용 가능 모델·요금·제한은 해당 서비스 정책을 따릅니다.

**게이트웨이 토큰은 운영자 권한입니다.** 에이전트 지정만으로 권한이 제한되지 않습니다. 전용 인스턴스에서 파일·셸·외부 서비스 도구를 제한하고 loopback 또는 비공개 네트워크에서만 연결하세요. 원격 연결은 HTTPS가 필요합니다.

#### C. Hermes + API 키 또는 OAuth

**먼저 Hermes를 설치하세요.** [공식 안내](https://hermes-agent.nousresearch.com/docs/)에 따라 전용 일반 사용자 환경에서 설치합니다. Linux/macOS/WSL 설치 명령:

```sh
curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash
```

개인 설정을 복제하지 않고 카카오 전용 프로필을 만든 뒤, **그 프로필에서** AI 제공자와 모델을 선택하고 API 키 입력 또는 지원되는 OAuth 로그인을 완료합니다.

```sh
hermes profile create kakao-bridge
hermes -p kakao-bridge setup
hermes -p kakao-bridge config env-path
```

**① Hermes 쪽 `.env`** — 마지막 명령이 표시한 파일을 편집합니다. 기본 설치 경로는 `~/.hermes/profiles/kakao-bridge/.env`입니다. 기존 제공자 설정을 지우지 말고 다음 항목을 추가·수정하세요.

```dotenv
API_SERVER_ENABLED=true
API_SERVER_HOST=127.0.0.1
API_SERVER_PORT=8650
API_SERVER_KEY=여기에_직접_생성한_긴_무작위_접속키
API_SERVER_MODEL_NAME=kakao-bridge
```

`API_SERVER_KEY`는 AI 업체에서 발급받는 키가 아니라 **이 Hermes 서버용으로 직접 정하는 접속 비밀값**입니다. 예시 문구를 그대로 사용하지 마세요. 비밀번호 관리자로 긴 무작위 값을 만들고 파일은 본인만 읽을 수 있게 보호하세요.

전용 프로필의 도구·파일 접근·기억 설정을 확인한 뒤 API 서버를 실행하고, 브리지 사용 중에는 계속 켜 둡니다.

```sh
hermes -p kakao-bridge gateway run
```

**② 브리지 쪽 `.env`** — `kakao-ai-bridge/.env`에 아래를 설정합니다. Hermes의 `.env`와는 **서로 다른 파일**입니다.

```dotenv
AI_PROVIDER=openai-compatible
AI_BASE_URL=http://127.0.0.1:8650/v1
AI_API_KEY=위_API_SERVER_KEY와_동일한_접속키
AI_MODEL=kakao-bridge
```

- `AI_API_KEY`에는 **Hermes의 `API_SERVER_KEY`와 정확히 같은 값**을 넣습니다. 제공자 API 키나 OAuth 토큰을 복사하는 칸이 아닙니다.
- `AI_MODEL`은 Hermes가 공개하는 서버 모델 이름입니다. 위 `API_SERVER_MODEL_NAME`과 맞춥니다. 실제 AI 제공자·모델은 Hermes 프로필에서 설정합니다.
- 별도 `hermes` provider 값은 없습니다. Hermes의 OpenAI 호환 API를 사용하므로 `AI_PROVIDER=openai-compatible`이 맞습니다.
- 프로필 분리는 OS 권한 격리가 아닙니다. 개인 관리자 계정 대신 전용 OS 사용자와 최소권한 도구 설정을 사용하세요. 브리지에서 질문만 보내더라도 Hermes는 서버 쪽 기억·문맥·도구를 사용할 수 있습니다.

서버 설정은 [Hermes 공식 API 안내](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/open-webui)를 참고하세요. 이 브리지 연결에 **Open WebUI 자체를 설치할 필요는 없습니다.**

### 3. 카카오 로그인과 방 선택

본인 소유 테스트 계정으로, 화면 공유·녹화를 끄고 실행합니다.

```sh
npm run login
npm run rooms
```

로그인 명령에서 이메일·비밀번호를 숨김 입력하고 휴대폰 인증을 진행합니다. 비밀번호는 저장하지 않습니다.

조회한 방 ID를 `.env`에 입력하세요. 여러 방은 쉼표로 구분하며 공백은 넣지 않습니다. 참가자에게 AI 전송 사실을 알리고 동의를 받으세요.

```dotenv
KAKAO_ALLOWED_ROOMS=101
KAKAO_REPLY_MODE=auto
KAKAO_BOT_NAMES=이삭이,이삭
```

- `KAKAO_REPLY_MODE=auto`(기본): 1:1 방은 모든 텍스트에, 단체방은 AI에게 한 말에만 답합니다. `prefix`로 바꾸면 모든 방에서 `!ai 질문`에만 답합니다.
- `KAKAO_BOT_NAMES`: 첫 번째가 AI의 이름이고, 나머지는 부르는 말입니다. 이름은 글자가 포함되면 인식하므로 `이삭`을 넣으면 "이삭아", "이삭이"도 알아듣습니다. 봇 계정의 카카오 닉네임은 자동으로 포함됩니다.

`101`은 예시입니다. 실제 조회한 ID로 바꾸세요.

### 4. 실행

```sh
npm run doctor
npm start
```

`doctor`는 로컬 설정 검사입니다. 실제 카카오 로그인·게이트웨이 연결·OAuth 상태를 검증하지 않습니다. `ready`가 나온 뒤 **다른 참가자**가 허용한 방에서 말을 겁니다.

```text
(1:1 방)  토양 유기물의 역할을 쉽게 설명해 줘
(단체방)  이삭아, 토양 유기물의 역할을 쉽게 설명해 줘
```

종료는 `Ctrl+C`입니다. 검색·일정·자동 공지·장기 기억은 브리지 자체 기능이 아닙니다.

## 운영·개발 참고

- 카카오 공식 봇 API 제품이 아닙니다. 계정 제한·기기 세션 충돌·비공식 프로토콜 변경 위험은 [SECURITY.md](SECURITY.md)를 확인하세요.
- `.env`·`.state/`는 공유하지 마세요. 질문은 선택한 AI로 전송되며 서버의 보관 정책이 적용됩니다. 파일 권한 보호는 암호화가 아닙니다.
- 자동 테스트는 실제 SDK와 모의 전송·로컬 HTTP를 사용합니다. 실제 카카오 계정의 1:1 방 수신→OpenClaw 답변→발송 확인 왕복은 2026-10-04에 확인했습니다. OpenClaw 실서비스 OAuth 신규 로그인·갱신은 이 저장소의 검증 범위가 아닙니다. Hermes는 제한된 임시 로컬 API 서버에서 키 누락/오류 차단과 브리지→실제 AI 응답을 확인했습니다. 이는 전체 게이트웨이 상시 운영·신규 OAuth 로그인·토큰 갱신 검증을 뜻하지 않습니다.
- 상세 설치·설정·오류: [GUIDE.md](docs/GUIDE.md) · SDK 원본 검증: [SDK-SUBSET.md](docs/SDK-SUBSET.md)

```sh
npm run check
npm test
npm audit --audit-level=low
```

## 출처·이용 조건

카카오 연결은 `agent-messenger@2.38.1`의 원본 22개 모듈을 사용합니다. 해당 모듈은 MIT 라이선스이며 저작권 고지와 전문은 [vendor/kakao-sdk/LICENSE](vendor/kakao-sdk/LICENSE), 출처 설명은 [NOTICE.md](NOTICE.md)에 있습니다. 브리지 코드는 **UNLICENSED**이며 이용·수정·재배포 허가는 권리자에게 확인하세요.
