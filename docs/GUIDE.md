# 🛠️ 카카오 AI 브리지 · 설치와 운영 안내

본인 카카오 계정의 명시적으로 허용한 방에서 `!ai 질문`을 받으면, 본인이 설정한 OpenAI 호환 AI 서비스에 질문 한 건을 전달하고 같은 방에 답합니다.

흐름: 카카오톡 → 이 브리지 → 본인의 AI endpoint → 이 브리지 → 원래 허용 방

공식 카카오 봇 API가 아닌 `agent-messenger@2.38.1`의 [카카오 전용 22개 모듈](SDK-SUBSET.md) 기반입니다. 계정 제한, 비공식 프로토콜 변경, 다른 기기 세션 충돌 위험이 있습니다. 운영 준비 완료나 카카오 승인 제품이 아닙니다. 중요한 개인 계정 대신 본인 소유의 별도 테스트 계정을 권장합니다. 타인 계정, 기존 운영 봇의 세션, 개인 AI 게이트웨이 자격증명을 복사하지 마세요.

## 포함한 것 / 포함하지 않은 것

포함:
- 이메일·비밀번호를 직접 입력하는 카카오 보조기기 등록/로그인
- 방 ID 허용목록, `!ai` 호출, 단일 텍스트 질의/답변
- OpenAI 호환 `POST /v1/chat/completions`와 명시적 OpenClaw 게이트웨이 모드(OAuth 기반 AI 포함)
- 비공개 로컬 세션 저장, 중복 억제, 제한된 큐/요청량, 종료 시 연결 닫기
- 네트워크 연결 없는 설정 진단 및 mock 기반 회귀 테스트

미포함:
- 조직별 팀 명령, 포장계획 수집, Zoom 등 업무서비스 OAuth, 일정, 뉴스 수집·검색, 자동 공지, 예약 발송
- 장기 기억, 방 사이 기록 공유, 첨부파일, 음성/이미지 처리, 파일/명령 실행 도구
- 이전 메시지 탐색, 오프라인 동안의 메시지 복구, 자동 재접속·자동 발송 재시도
- Docker/서버 자동 배포, 운영 계정 로그인 검증

## 실행 환경

Node.js 22.13 이상 24.x 이하와 npm이 필요합니다(22.x/24.x LTS 권장). Linux/macOS POSIX 권한 모델을 사용합니다. Linux에서 실제 검증했으며 macOS는 아직 실기기 검증하지 않았습니다. 네이티브 Windows는 보안 파일권한 차이 때문에 거부합니다. Windows에서는 WSL의 Linux 파일시스템을 사용하세요(`/mnt/c`는 피하세요).

전용 일반 사용자로 실행하고 root를 사용하지 마세요. 프로젝트, `.env`, 상태 디렉터리를 다른 사람이 쓸 수 있는 공유 폴더에 두지 마세요. 의존성 잠금은 재현성을 높일 뿐 취약점 부재를 의미하지 않습니다. 현재 고정 의존성의 알려진 보안 주의사항은 아래와 [NOTICE.md](../NOTICE.md)를 확인하세요.

## 빠른 시작

이 소스를 받은 뒤 프로젝트 디렉터리에서 실행합니다. 저장소: https://github.com/Dj-Lee2/kakao-ai-bridge

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run setup
```

`setup`은 `.env.example`을 `.env`로 생성하고 권한을 0600으로 제한합니다. 기존 파일은 덮어쓰지 않습니다. 카카오/AI 네트워크 요청은 하지 않습니다. `.npmrc`도 설치 스크립트와 선택적 의존성을 기본 비활성화합니다. 카카오 기능에는 이 설치 방식으로 충분한지 테스트합니다. SDK의 다른 메신저 기능은 지원 대상이 아닙니다.

### 1. 본인의 AI 설정

비공개 편집기로 **브리지 폴더의 `.env`**를 열고 A·B·C 중 하나를 선택합니다. C는 [README의 Hermes 설치·연결 안내](../README.md#c-hermes--api-키-또는-oauth)를 따르세요. 브리지 설치는 OpenClaw·Hermes를 자동 설치하지 않습니다. 카카오 이메일·비밀번호는 넣지 않습니다. 셸 환경변수가 `.env`보다 우선하며, 식별자의 공백·대소문자를 자동 보정하지 않습니다.

#### A. OpenAI 호환 API

```dotenv
AI_PROVIDER=openai-compatible
AI_BASE_URL=https://api.openai.com/v1
AI_API_KEY=
AI_MODEL=
```

서비스에서 발급/확인한 API 키와 모델 이름을 입력하세요. `AI_PROVIDER`를 생략한 기존 설정도 이 모드입니다. `AI_BASE_URL`은 `/v1` 등 API 기본 경로이며 코드가 `/chat/completions`를 붙입니다. 원격 서비스는 HTTPS만 허용하고 localhost/127.0.0.1/[::1]의 HTTP는 키 없이 사용할 수 있습니다. URL 안 계정정보·쿼리·fragment는 거부하고 리디렉션은 따르지 않습니다.

#### B. OpenClaw + OAuth

```text
브리지 ──게이트웨이 토큰──▶ 전용 OpenClaw 에이전트 ──제공자 OAuth──▶ AI
```

브리지는 OpenClaw의 Chat Completions API를 호출합니다. 브라우저 로그인·제공자 자격증명 보관·갱신은 OpenClaw가 맡으며, 브리지는 OAuth 저장소를 읽거나 복사하지 않습니다. 게이트웨이에 API 키로 인증한 모델을 설정해도 같은 경로를 사용할 수 있습니다. `AI_PROVIDER=openclaw` 자체가 OAuth를 강제하거나 모든 제공자의 구독을 지원한다는 뜻은 아닙니다.

**OpenClaw 쪽 준비** — 먼저 [공식 설치 안내](https://docs.openclaw.ai/start/getting-started)에 따라 전용 일반 사용자 환경에 OpenClaw를 설치하고 초기 설정을 마치세요. 다음은 브리지가 아닌, 별도로 설치한 OpenClaw에서 수행합니다.

1. 개인 운영 게이트웨이와 분리된 **카카오 전용 인스턴스**를 준비하세요. 별도 OS 사용자와 전용 상태·작업공간을 권장합니다. 개인 파일·기억·운영 서비스 인증정보를 공유하지 말고, 해당 설치/프로필이 선택됐는지 확인한 후 진행하세요.
2. 전용 에이전트를 만들고 **같은 에이전트**에 로그인합니다. 아래는 현재 공식 문서의 ChatGPT/Codex OAuth 예시입니다. 이미 만든 전용 에이전트가 있으면 실제 ID를 두 명령에 사용하세요. 인증자료 복사를 선택하거나 기존 저장소를 수동 복사하지 마세요.

   ```sh
   openclaw agents add kakao-bridge
   openclaw models auth login --provider openai --agent kakao-bridge
   openclaw models status --agent kakao-bridge
   ```

   OpenClaw가 안내하는 브라우저에서 직접 로그인합니다. 해당 에이전트의 모델은 OpenClaw 설정 UI에서 선택하세요. 모델 선택·지원 인증 방식은 설치 버전과 제공자에 따라 다릅니다. Claude CLI 재사용 등 다른 경로는 [공식 OAuth 안내](https://docs.openclaw.ai/concepts/oauth)를 따르세요. OAuth 만료·갱신 실패는 OpenClaw 쪽에서 재인증하며, ChatGPT 등 구독과 API 과금은 서로 다를 수 있습니다.
3. 전용 게이트웨이에서 token 인증(`gateway.auth.mode="token"`)을 설정하고 접속 토큰을 준비하세요. **Chat Completions는 기본 비활성**이므로 기존 설정에 다음을 병합합니다. 전체 설정을 이 조각으로 덮어쓰지 마세요. 적용·재시작은 해당 OpenClaw 버전의 안내를 따릅니다.

   ```json5
   {
     gateway: {
       http: {
         endpoints: {
           chatCompletions: { enabled: true }
         }
       }
     }
   }
   ```

4. 게이트웨이를 loopback 또는 비공개 네트워크에만 노출하고, 에이전트의 파일·셸·외부 서비스·다른 에이전트 접근 권한을 서버에서 제한하세요. 최소 프로필 이름이나 프롬프트만 믿지 말고 실제 적용 권한을 확인해야 합니다. **게이트웨이 토큰은 인스턴스 운영자 권한**이며 `OPENCLAW_AGENT_ID`는 라우팅 선택이지 토큰의 권한 범위가 아닙니다. 공용 인터넷에 공개하거나 개인 관리자 인스턴스에 연결하지 마세요.

**브리지 `.env` 설정:**

```dotenv
AI_PROVIDER=openclaw
OPENCLAW_BASE_URL=http://127.0.0.1:18789/v1
OPENCLAW_GATEWAY_TOKEN=
OPENCLAW_AGENT_ID=kakao-bridge
```

- `OPENCLAW_BASE_URL`: `/v1`로 끝나는 기본 주소입니다. 코드가 `/chat/completions`를 붙입니다. 끝의 `/`는 허용합니다. 프록시 접두 경로도 `/bridge/v1`처럼 지정할 수 있습니다. 완성된 endpoint·인증정보·쿼리·fragment·공백·경로 보정 입력은 거부합니다. 원격은 HTTPS만, HTTP는 localhost/127.0.0.1/[::1]만 허용합니다. HTTPS라고 비공개 서버임이 보장되는 것은 아니므로 네트워크 격리를 별도로 확인하세요.
- `OPENCLAW_GATEWAY_TOKEN`: 전용 게이트웨이의 **접속 토큰**을 입력합니다. 제공자 API 키나 OAuth access/refresh token이 아니며 `Bearer ` 접두사도 넣지 않습니다. 비어 있으면 loopback에서도 차단합니다. password/trusted-proxy/무인증 게이트웨이 모드는 이 전용 어댑터의 지원 대상이 아닙니다.
- `OPENCLAW_AGENT_ID`: 실제 등록한 전용 ID를 정확히 입력합니다. 이 브리지는 영문 소문자로 시작하는 1~64자의 소문자·숫자·`_`·`-`만 허용하고, 기본 에이전트로 바뀔 수 있는 `default` 별칭은 거부합니다. 대소문자나 오타를 보정하지 않습니다. 존재 여부·최소권한 여부는 서버에서 확인해야 합니다.
- 이 모드의 `AI_BASE_URL`·`AI_API_KEY`·`AI_MODEL`은 무시합니다. `AI_TIMEOUT_MS`·`AI_MAX_OUTPUT_TOKENS` 등 공통 제한은 계속 적용됩니다.

요청은 `Authorization: Bearer <게이트웨이 토큰>`, `model: "openclaw/<에이전트 ID>"`, `stream: false`를 사용합니다. 제공자 모델을 강제로 바꾸는 `x-openclaw-model`이나 세션·권한 override 헤더는 보내지 않습니다. `user`는 매 요청 새 난수라 카카오 방/사용자 ID를 노출하거나 대화를 의도적으로 이어 붙이지 않습니다. 다만 서버의 작업공간·기억·보관 정책을 끄는 기능은 아닙니다.

OpenClaw에는 `max_completion_tokens`, 일반 API에는 기존 `max_tokens`로 예산을 전달합니다. 일부 OAuth 백엔드는 토큰 예산을 엄격하게 적용하지 않을 수 있습니다. 응답에 초과 사용량이 보고되면 거부하고 출력 길이도 제한하지만, 이미 사용된 토큰·비용이나 서버 도구 실행을 취소하지는 못합니다. tool-call 응답은 실행하지 않고 거부합니다. 서버 내부 도구 실행은 이 제한과 별개이며 브리지의 프롬프트는 권한 통제가 아닙니다.

공식 문서: [Gateway HTTP API](https://docs.openclaw.ai/gateway/openai-http-api) · [OAuth](https://docs.openclaw.ai/concepts/oauth) · [에이전트](https://docs.openclaw.ai/cli/agents) · [모델·인증 CLI](https://docs.openclaw.ai/cli/models). 명령이 설치 버전과 다르면 해당 버전 문서를 먼저 확인하세요.

### 2. 본인 카카오 로그인

화면 공유·터미널 녹화를 끄고 직접 터미널에서 실행합니다.

```sh
npm run login
```

이메일과 비밀번호 모두 화면에 표시하지 않습니다. 비밀번호를 CLI 인자, 파일, 환경변수로 받지 않으며 저장하지 않습니다. SDK의 데스크톱 토큰 추출 CLI도 호출하지 않습니다.

실제 SDK의 `loginFlow`를 사용합니다: tablet 슬롯에서 `force:false` 로그인 → 미등록이면 인증코드 요청 → 휴대폰 승인용 코드를 터미널에 표시 → 기기 등록 확인을 polling → 같은 기기 UUID로 다시 로그인. 인증코드는 사용자가 휴대폰에 입력하기 위해 로컬 TTY에만 의도적으로 표시됩니다. 비밀번호/토큰/SDK 응답 전체는 출력하지 않습니다. 이 인증 화면도 캡처/로그로 공유하지 마세요.

슬롯 점유·인증 실패 시 중단하며 자동 강제 로그인은 없습니다. 다른 PC/태블릿 세션을 끊을 수 있는 `--force`/슬롯 변경 옵션은 제공하지 않습니다. 휴대폰 앱에서 본인 기기 상태를 직접 확인한 뒤 다시 시도하세요. Kakao가 추가 검증/계정 제한을 요구하면 이를 우회하지 마세요.

저장되는 access/refresh token과 기기 UUID는 `.state/session.json`에 있습니다. 파일 0600/디렉터리 0700이며 암호화나 OS 키체인은 아닙니다. 같은 OS 사용자·관리자는 읽을 수 있습니다. refresh token은 저장하지만 자동 갱신은 구현하지 않았습니다. 만료/거부되면 봇을 종료하고 `npm run login`을 다시 실행하세요. 실패한 로그인은 이전 정상 세션을 덮어쓰지 않습니다.

### 3. 방 ID 확인과 허용목록 설정

```sh
npm run rooms
```

`yes` 확인 후 카카오에 접속하여 `rooms` 배열에 방 ID·종류·이름을 출력합니다. 메시지 본문은 출력하거나 발송하지 않습니다. 이 목록도 개인정보일 수 있으므로 공유하지 마세요. SDK의 방 목록 조회는 서버 메타데이터를 읽습니다. SDK 2.38.1의 재접속 증분 목록이 비어 있으면 이 패키지 전용 SDK 상태에서 현재 로그인 기기 UUID에 해당하는 version 2 `chatIds`만 후보로 읽고 각 ID를 `getChat`으로 다시 확인합니다. 전역 인증/상태를 읽거나 동기화 파일을 초기화하지 않습니다. 복구 후보는 최대 500개/전체 60초로 제한합니다. `source`, `incomplete`, `failedCount`로 부분/빈 조회를 표시하며 exit 1이면 “방이 없음”으로 단정하면 안 됩니다. 휴대폰에서 원하는 방의 존재와 계정을 확인하고 재시도하세요. 알 수 없는 room ID를 추측해서 입력하지 마세요.

본인이 동의를 받은 테스트 방 ID를 `.env`에 정확하게 입력합니다. 아래 숫자는 테스트용 예시입니다.

```dotenv
KAKAO_ALLOWED_ROOMS=101
# 여러 방: KAKAO_ALLOWED_ROOMS=101,102
```

빈 값은 모든 방 차단이며 `start`가 SDK import/로그인보다 먼저 실패합니다. `*`, 이름 기반 자동 선택, 모든 방 허용은 없습니다. 최대 10개 방, 일반 `DirectChat`/`MultiChat`만 지원하며 오픈채팅/메모/채널/알 수 없는 타입은 거부합니다. 그룹은 최대 100명입니다. 읽힌 멤버 목록이 완전하고 본인 계정이 포함되어야 시작합니다. 그룹 구성원 모두가 명시적인 호출로 AI에 내용을 보낼 수 있으므로 참가자의 동의를 먼저 받으세요.

### 4. 확인하고 시작

```sh
npm run doctor
npm start
```

`doctor`는 로컬 설정·세션 형식·권한·SDK 고정 버전·잠금 상태를 검사합니다. `aiProvider`, `aiAuth`와 OpenClaw의 경우 `openclawAgentId`를 표시하며 주소·토큰은 출력하지 않습니다. 네트워크에 접속하지 않으므로 게이트웨이 endpoint 활성화·에이전트 존재/권한·OAuth 상태·실제 Kakao 로그인 성공은 검증하지 않습니다. 기존 상태의 전용 SDK 하위 폴더가 없으면 생성할 수 있습니다. 설정이 비었을 때 exit 1은 정상적인 안전 차단입니다.

`ready` 이벤트가 나오면 허용 방에서 다른 구성원 계정으로 `!ai 안녕하세요`처럼 호출합니다. 명령 접두사 바로 뒤 공백이 필요합니다. 봇 자신의 메시지는 처리하지 않습니다. 중단은 Ctrl+C입니다. 인증서 우회/TLS 비활성화는 지원하지 않습니다.

## 안전·개인정보 경계

- 선택된 방의 유효한 `!ai` 질문 내용은 설정한 AI 서비스에 전송됩니다. 그 서비스의 보관/학습/국외 이전 정책은 별도입니다. 비밀정보, 민감한 개인정보, 인증정보를 보내지 마세요.
- AI 요청에는 질문 한 건과 고정 시스템 프롬프트만 들어갑니다. 방 이름, 카카오 방/사용자 ID, 이전 기록은 넣지 않으며 방 간 대화 기록도 없습니다. 회신 대상은 원래 허용 방에 고정됩니다. AI 출력이 방을 바꾸거나 명령을 실행할 수 없습니다.
- SDK의 카카오 연결 자체는 계정 전체의 초기 채팅 메타데이터를 받으며 전용 `sdk/`에 방 ID/동기화 watermark 등을 보관할 수 있습니다. “허용되지 않은 방 정보를 SDK조차 받지 않는다”는 보장이 아닙니다. AI로 전달하는 범위를 제한하는 것입니다.
- `AGENT_MESSENGER_CONFIG_DIR`를 import 전에 전용 `.state/sdk`로 덮어써 기존 전역 SDK 상태를 사용하지 않습니다. 세션은 브리지 자체 저장소에서 명시적으로 전달합니다.
- 프로필 요청 성공과 설정된 selfId의 일관성은 확인하지만, 이 SDK의 `getProfile().user_id`는 설정 ID에서 나옵니다. 독립적인 서버 token 소유권 증명으로 해석하면 안 됩니다. 본인의 실제 `loginFlow` 결과로 만든 세션만 사용하세요.
- 시작·추론 전·발송 전 방과 전체 멤버 목록을 검증합니다. 현재 검증된 멤버만 질문할 수 있습니다. 멤버 변화/연결 끊김/킥/애매한 발송 결과가 감지되면 중단합니다. 검증 직후 발생하는 서버 측 멤버 변경까지 원자적으로 막을 수는 없습니다.
- 새 실시간 메시지만 처리합니다. 시작 이전·120초 초과·미래 timestamp·첨부 타입·너무 긴 내용은 무시합니다. 시작 시 초 단위 timestamp 경계의 메시지가 빠질 수 있습니다. 재접속/과거 기록 보충은 없습니다.
- 처리 전에 로그 ID와 요청량을 디스크에 저장합니다. 재시작 시 중복 AI/발송을 억제하되, 장애 때 질문이 누락될 수 있는 at-most-once 지향입니다. 정확히 한 번 전달 보장이 아닙니다. 방별 큰 로그 ID보다 뒤늦게 도착한 작은 로그 ID는 버립니다.
- 기본 방별 5초 cooldown, 시간당 30건(고정 시간 구간), 전체 대기 20건입니다. 기본 입력 4000자/출력 1800자, AI timeout 60초, HTTP 응답 256KiB 제한입니다. 초과/AI 오류에 별도 오류 메시지를 카카오로 보내지 않습니다.
- low-level SDK WRITE를 한 번만 호출하고 응답을 원래 방에서 readback합니다. ACK 손실·readback 실패 시 재발송하지 않고 중단합니다. 이미 전송된 메시지를 취소할 수 없으며 타임아웃은 반드시 서버 취소를 의미하지 않습니다.
- 로컬 원문·AI 대화 로그를 저장하지 않습니다. 로그는 제한된 이벤트 코드이며 state에는 세션, SDK 메타데이터, 방별 커서·요청량만 보관합니다. 사용자 정의 `BRIDGE_STATE_DIR`는 저장소 밖에 두거나 로그인 전에 `.gitignore`에 정확한 경로를 추가하고 백업에서도 제외하세요. 기본 `.state/` 외에 ledger/lock/session/SDK sync 파일명도 방어적으로 제외하지만 모든 임의 경로를 보장하지는 않습니다.

## 문제 해결

- `room_allowlist_empty`: `.env`의 허용 방 목록을 직접 지정합니다. 우회 기본값은 없습니다.
- `AI_MODEL_required` / `AI_API_KEY_required`: 일반 API 모드에서 서비스가 제공한 정확한 모델/키를 입력합니다. 이 모드의 loopback HTTP에서는 key를 생략할 수 있습니다.
- `invalid_AI_PROVIDER`: `openai-compatible` 또는 `openclaw`를 정확히 입력합니다.
- `OPENCLAW_AGENT_ID_required` / `invalid_OPENCLAW_AGENT_ID`: 전용 에이전트 ID를 정확히 입력하세요. `default`, 대문자, 공백, 경로/별칭은 거부합니다.
- `OPENCLAW_GATEWAY_TOKEN_required` / `invalid_OPENCLAW_GATEWAY_TOKEN`: 전용 게이트웨이 토큰을 입력하세요. API 키로 대체하거나 `Bearer ` 접두사를 붙이지 마세요.
- `invalid_OPENCLAW_BASE_URL` / `insecure_OPENCLAW_BASE_URL`: `/v1`로 끝나는 주소와 전송 보안 조건을 확인하세요.
- `ai_http_failed`: 원문 응답은 출력하지 않습니다. OpenClaw 쪽에서 token 인증, Chat Completions 활성화, 에이전트·모델 선택, 해당 에이전트의 OAuth 상태를 확인하세요. 권한을 넓히거나 무인증으로 우회하지 마세요.
- `interactive_terminal_required`: 파이프/자동화 세션이 아니라 본인 터미널에서 login/rooms를 실행합니다.
- `tablet_slot_occupied_no_force`: 기존 태블릿 기기를 본인 앱에서 확인하세요. 자동 세션 탈취/강제 해제는 하지 않습니다.
- `kakao_login_failed` / `operation_failed`: 인증 또는 SDK/네트워크 오류입니다. 원래 예외에 민감한 값이 있을 수 있어 그대로 출력하지 않습니다. 인터넷/시간 설정/본인 계정 상태를 확인하세요. SDK debug 출력은 켜지 마세요.
- `unsafe_private_file` / `unsafe_state_directory`: 소유자 전용 권한인지 확인하세요. `.env`/세션은 0600, 상태 디렉터리는 0700입니다. symlink·hardlink 파일은 거부합니다. 본인 경로인지 확인 없이 일괄 chmod하지 마세요.
- `state_locked`: 동일 상태에 다른 login/rooms/start가 동작 중이거나 비정상 종료 잠금이 남았습니다. `.state/lock.json`의 PID와 해당 프로세스가 실제로 종료됐는지 확인한 뒤에만 그 잠금 파일을 직접 제거합니다. 브리지가 임의로 stale lock을 훔치지 않습니다.
- `membership_changed` / `kakao_disconnected`: 안전을 위해 종료했습니다. 허용 방의 현재 참가자와 계정 상태를 확인한 뒤 수동 재시작하세요.
- `send_unverified` / `send_rejected` / `invalid_send_receipt`: 전송 여부가 불확실할 수 있습니다. 원래 방을 직접 확인하고 자동 재발송하지 마세요.
- 계정 변경: 먼저 종료하고 이전 상태를 비공개 위치로 보관한 뒤 새 상태 디렉터리를 사용하세요. 이전 계정의 ledger와 새 세션을 섞으면 거부합니다. 로컬 세션 삭제가 서버 기기 등록 해제는 아닙니다. 서버 등록은 휴대폰 카카오 앱에서 직접 관리합니다.

## 검증과 알려진 한계

```sh
npm ci --ignore-scripts
npm run check
npm test
npm audit --audit-level=low
```

테스트는 실제 고정 SDK import, 실제 SDK `loginFlow`의 mock HTTP 등록 순서, 두 AI 모드 각각의 실제 SDK listener mock push → 로컬 HTTP → mock 단일 WRITE/readback, 설정/권한/중복/발신자/종료/CLI 차단을 실행합니다. OpenClaw 요청의 경로·Bearer·에이전트·예산·세션 분리와 잘못된 입력·리디렉션·HTTP 오류·tool-call·응답 크기·타임아웃 거부도 검사합니다. 카카오 서버로 실제 로그인하거나 메시지를 보내지 않습니다. 실제 카카오 계정 연동, 실서비스 OpenClaw/OAuth 로그인·갱신, 여러 OS/AI 제공자 호환성은 미검증입니다. 서비스별 파라미터 차이 때문에 `max_tokens` 등을 받지 않는 일반 API endpoint는 지원하지 않을 수 있습니다. Responses API/stream/tool-call 출력은 지원하지 않습니다.

카카오 전용 부분집합으로 전환해 사용하지 않는 메신저와 의존성 자체를 제거했습니다. 실행 패키지는 `bson@6.10.4`, `zod@4.6.5`이며 개발용 parser까지 포함한 전체 audit에서 보고 항목 0개를 확인했습니다. 원본 22개 모듈·출처 고지·정적/동적 import를 대조하며 잠금파일·스캐너 검사를 유지합니다. 이는 알려진 의존성 경고 기준이며 취약점 부재/운영 보안 승인을 뜻하지 않습니다. `npm audit fix --force`는 실행하지 마세요. SDK 변경은 [재현·출처 검사](SDK-SUBSET.md)와 API/인증/안전 회귀 검증을 함께 진행해야 합니다.

## 라이선스와 출처

[NOTICE.md](../NOTICE.md)를 확인하세요. 이 브리지의 새 코드는 권리자의 공개 라이선스 선택 전이므로 `private: true`, `UNLICENSED` 상태입니다. 이는 권리자 대신 배포 라이선스를 선택하지 않았다는 뜻입니다. 소스 공개는 오픈소스 라이선스 부여와 다릅니다. 별도 이용·수정·재배포 허가는 권리자에게 확인하세요. 카카오 전용 원본 JavaScript 22개와 원본 README·protocol NOTICE는 `vendor/kakao-sdk`에 보존합니다. 상류 README의 MIT 선언을 근거로 사용하되, 최상위 LICENSE 전문과 package.json license 필드가 없다는 사실도 함께 알립니다. 없는 저작권자나 허가문을 만들지 않았습니다. 나머지 npm 의존성은 잠금파일로 설치합니다.
