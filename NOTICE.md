# 📜 카카오 AI 브리지 · 출처와 이용 조건

## 이 브리지의 코드

기존 카카오 브리지의 검증된 SDK 연결·수신 형태, 방/멤버 검증, 단일 low-level 발송, readback, 원자적 상태 저장 패턴을 바탕으로 새 portable CLI/구조를 작성했습니다. 검토한 기존 소스는 `kakao-vps-20261001/bridge-src`, `bridge-reference`, `deploy/Dockerfile`, `kakao-team-20261002/bridge-integration`, `kakao-zoom-20261001/deploy/bridge-main.mjs`입니다. 운영 경로·개인 프롬프트·운영 계정/방/토큰·상태는 가져오지 않았습니다.

이 프로젝트 코드에 대해 권리자의 공개 라이선스를 임의로 지정하지 않았습니다. `package.json`의 `private: true`, `license: UNLICENSED`는 npm 공개 게시를 막고 라이선스 선택이 아직 안 됐음을 표시합니다. 파일명 LICENSE로 새 권리/허가문을 만들지 않았습니다. 소스는 공개하되 별도 오픈소스 이용·수정·재배포 라이선스는 아직 부여하지 않았습니다. 해당 허가는 권리자에게 확인하세요.

## agent-messenger 2.38.1

- 원 프로젝트: https://github.com/agent-messenger/agent-messenger
- npm: https://www.npmjs.com/package/agent-messenger/v/2.38.1
- 고정 배포본: https://registry.npmjs.org/agent-messenger/-/agent-messenger-2.38.1.tgz
- 원 프로젝트와 npm 배포본 README는 License 섹션에서 MIT라고 선언합니다.
- 검토한 고정 npm 배포본에는 최상위 전문 LICENSE 파일이 없고 package.json의 license 필드도 없습니다. README의 MIT 선언을 기록하되, 이 묶음에서 완전한 권리자/저작권 문구를 추정하거나 SDK 전체에 새 라이선스를 부여하지 않습니다. 공개 재배포 전 upstream의 전문/고지 요건을 확인하세요.
- SDK 내부의 protocol/vendor별 고지·라이선스는 각각에 적용됩니다. 일부 vendor의 MIT 파일을 SDK 전체의 라이선스 전문으로 대신하지 마세요.
- 이 소스 묶음은 SDK 코드를 복사해 vendoring하지 않습니다. 설치 시 npm에서 잠금파일에 따라 가져옵니다. node_modules나 upstream tarball을 배포 묶음에 포함하지 마세요.

실제로 확인한 API/구현:
- public export `agent-messenger/kakaotalk`: `loginFlow`, `KakaoTalkClient`, `KakaoTalkListener`
- `dist/src/platforms/kakaotalk/auth/kakao-login.js`: tablet/force:false, passcode generate/register, 승인 후 재로그인
- `client.js`: 명시적 oauthToken/userId/deviceUuid/deviceType 로그인, acquireSession, 방/멤버/readback API
- `listener.js`: message/disconnected/error/member_joined/member_left, error 후 start가 resolve될 수 있는 계약
- `dist/src/shared/utils/config-dir.js`: `AGENT_MESSENGER_CONFIG_DIR`
- `protocol/session.js`: low-level 단일 `sendMessage(Long,text)`

SDK high-level sendMessage의 reconnect/retry, SDK auth CLI의 로컬 자격증명 추출 및 debugLog(원 응답에 토큰 포함 가능)는 사용하지 않습니다. 인증 과정은 자체 구현/추측한 HTTP API가 아니라 실제 고정 SDK 함수를 호출합니다.

## bson 및 기타 의존성

`bson@6.10.4`를 고정해 실제 SDK와 같은 Long 인코딩에 사용합니다. 각 의존성의 권리·고지·라이선스는 원 배포본과 package-lock.json의 메타데이터를 확인하세요. 이 프로젝트의 UNLICENSED 표시는 타사 의존성의 라이선스를 변경하지 않습니다.

## 보안 검증 한계

실행한 `npm audit --omit=optional`은 영향받는 의존성 항목 7개(high 6, moderate 1)를 보고했습니다. 원 패키지의 여러 메신저 경로에서 파생됩니다. 실제 카카오 경로의 도달성/악용 가능성은 이 수치만으로 판단할 수 없습니다. SDK를 pin한 것은 재현성·API 계약을 위한 것이며 보안 보증이 아닙니다. 자동 강제 수정/다운그레이드를 하지 않았습니다.

`npm ci --ignore-scripts --omit=optional`은 의존성 설치 후크를 비활성화할 뿐 의존성 자체 실행의 위험을 제거하지 않습니다. 실제 계정/프로덕션 서버 검증 없이 로컬 candidate로만 제공합니다.
