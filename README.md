# 💬 카카오 AI 브리지

허용한 카카오톡 대화방에서 `!ai 질문`을 보내고, 내가 고른 AI의 답을 같은 방에서 받습니다.

[설치·문제 해결](docs/GUIDE.md) · [소스 내려받기](https://github.com/Dj-Lee2/kakao-ai-bridge/releases) · [보안 안내](SECURITY.md)

## 주요 기능

- **AI 연결 선택**: OpenAI 호환 API 또는 OpenClaw 게이트웨이
- **OAuth 기반 AI**: OpenClaw에 로그인한 ChatGPT/Codex 등 지원 제공자 이용
- **허용한 방만 응답**: 방 ID를 직접 지정하며, 비어 있으면 실행 차단
- **명시적 호출만 처리**: 다른 참가자의 `!ai 질문`만 전달하고 봇 자신의 메시지는 제외
- **질문 한 건씩 전달**: 카카오 ID·방 이름·이전 대화는 AI 요청에 포함하지 않음
- **중복·과다 요청 억제**: 요청량 제한, 발송 결과 확인, 불확실한 발송은 재시도하지 않음

```text
카카오톡 → 브리지 → OpenAI 호환 API
                 또는 OpenClaw → OAuth/API로 인증한 AI
         ← 같은 방에 답변 ←
```

## 빠른 시작

Node.js **22.13 이상 24.x 이하**와 npm이 필요합니다. Linux 권장, macOS 실기기 미검증입니다. Windows는 WSL의 Linux 파일시스템을 사용하세요.

### 1. 설치

```sh
git clone https://github.com/Dj-Lee2/kakao-ai-bridge.git
cd kakao-ai-bridge
npm ci --ignore-scripts
npm run setup
```

`setup`은 권한 0600의 `.env`를 만들며 기존 파일을 덮어쓰지 않습니다. root 대신 전용 일반 사용자로 실행하세요.

### 2. AI 연결 선택

`.env`에서 아래 **A 또는 B**를 선택합니다. 카카오 이메일·비밀번호는 이 파일에 넣지 않습니다.

#### A. OpenAI 호환 API

```dotenv
AI_PROVIDER=openai-compatible
AI_BASE_URL=https://api.openai.com/v1
AI_API_KEY=
AI_MODEL=
```

서비스에서 발급한 **API 키**와 정확한 모델 이름을 채우세요. API 기본 주소 뒤에 `/chat/completions`를 붙여 요청합니다. 기존 설정은 `AI_PROVIDER`가 없어도 이 모드로 동작합니다.

#### B. OpenClaw + OAuth

**카카오 전용으로 분리한 OpenClaw 인스턴스와 에이전트**를 먼저 준비합니다. 개인 관리자용 게이트웨이를 그대로 연결하지 마세요.

OpenClaw 쪽에서 지원 제공자에 로그인합니다. 현재 공식 문서의 ChatGPT/Codex 예시이며, `kakao-bridge` 에이전트를 먼저 만들어야 합니다.

```sh
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
KAKAO_TRIGGER_PREFIX=!ai
```

`101`은 예시입니다. 실제 조회한 ID로 바꾸세요.

### 4. 실행

```sh
npm run doctor
npm start
```

`doctor`는 로컬 설정 검사입니다. 실제 카카오 로그인·게이트웨이 연결·OAuth 상태를 검증하지 않습니다. `ready`가 나온 뒤 **다른 참가자**가 허용한 방에서 호출합니다.

```text
!ai 토양 유기물의 역할을 쉽게 설명해 줘
```

종료는 `Ctrl+C`입니다. 검색·일정·자동 공지·장기 기억은 브리지 자체 기능이 아닙니다.

## 운영·개발 참고

- 카카오 공식 봇 API 제품이 아닙니다. 계정 제한·기기 세션 충돌·비공식 프로토콜 변경 위험은 [SECURITY.md](SECURITY.md)를 확인하세요.
- `.env`·`.state/`는 공유하지 마세요. 질문은 선택한 AI로 전송되며 서버의 보관 정책이 적용됩니다. 파일 권한 보호는 암호화가 아닙니다.
- 테스트는 실제 SDK와 모의 전송·로컬 HTTP를 사용합니다. **실제 카카오 로그인·송수신 및 실서비스 OAuth 연결은 미검증**입니다.
- 상세 설치·설정·오류: [GUIDE.md](docs/GUIDE.md) · SDK 원본 검증: [SDK-SUBSET.md](docs/SDK-SUBSET.md)

```sh
npm run check
npm test
npm audit --audit-level=low
```

## 출처·이용 조건

카카오 연결은 `agent-messenger@2.38.1`의 원본 22개 모듈을 사용합니다. 타사 고지·MIT 선언과 LICENSE 전문 부재에 관한 설명은 [NOTICE.md](NOTICE.md)에 보존합니다. 브리지 코드는 **UNLICENSED**이며 이용·수정·재배포 허가는 권리자에게 확인하세요.
