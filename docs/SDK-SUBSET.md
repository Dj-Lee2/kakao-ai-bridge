# 📦 카카오 전용 SDK는 어떻게 만들었나요?

## 무엇이 달라졌나요?

여러 메신저를 담은 SDK 전체 대신, `agent-messenger@2.38.1`의 공개 KakaoTalk 진입점에서 실제로 필요한 **JavaScript 22개**만 보관합니다. 원본 바이트는 바꾸지 않았습니다. 동적 인증 import까지 포함했고, 실행 패키지는 `bson@6.10.4`와 `zod@4.6.5`로 한정했습니다.

```text
브리지 → @kakao-ai-bridge/kakao-sdk → 원본 KakaoTalk 22개 모듈
                                  → bson / zod / Node 기본 모듈
```

`vendor/kakao-sdk`는 상류의 공식 패키지가 아닌 이 프로젝트의 전용 부분집합입니다. 원본 `dist/src` 경로를 유지하며 출처 README·protocol NOTICE·각 파일 SHA256·import 목록을 함께 제공합니다. 다른 메신저 구현·CLI·네이티브 선택 의존성·기존 취약 라이브러리는 포함하지 않습니다. 원본 전체 tarball과 `node_modules`도 배포 ZIP에 넣지 않습니다.

## 일반 사용자: 설치 후 확인

```sh
npm ci --ignore-scripts
npm run check
npm test
npm audit --audit-level=low
```

설치만으로 재추출할 필요는 없습니다. `check`는 문법 검사와 함께 고정 source manifest·24개 원본 파일(실행 코드 22개와 README/NOTICE)·생성 메타데이터·실제 import 연결을 검사합니다. 검증은 네트워크 없이 작동하며, 누락된 동적 import·계산된 import·미검토 외부 의존성·추가 파일·변경된 원본을 거부합니다. AST parser인 acorn은 개발 검증용이며 런타임 연결이나 `doctor`에는 필요하지 않습니다.

개발 도구 없이 설치한 `npm ci --omit=dev --ignore-scripts`에서도 브리지 실행·로컬 `doctor`는 지원하지만, 개발 검사·전체 테스트는 기본 설치가 필요합니다. `doctor`는 패키지 식별·버전과 로컬 설정을 확인하는 기능이며 원본 전체 해시 검사나 실제 로그인 검증의 대체물이 아닙니다.

## 유지관리자: 고정 원본과 직접 대조

출처: <https://registry.npmjs.org/agent-messenger/-/agent-messenger-2.38.1.tgz>

1. 신뢰하는 HTTPS 도구로 이 정확한 버전의 tarball을 저장소 **밖**에 내려받습니다.
2. 먼저 기본 `npm ci --ignore-scripts`를 실행합니다.
3. 아래 명령에 내려받은 실제 경로를 넣습니다.

```sh
npm run vendor:check -- --archive /path/to/agent-messenger-2.38.1.tgz
npm run vendor:extract -- --archive /path/to/agent-messenger-2.38.1.tgz --out /new/empty/kakao-sdk
npm run vendor:check -- --archive /path/to/agent-messenger-2.38.1.tgz --out /new/empty/kakao-sdk
```

추출기는 원본 SHA256/SHA512가 고정값과 다르면 압축 해제 전에 실패합니다. 새롭고 비어 있는 폴더에만 쓰며 기존 vendor 파일을 덮어쓰지 않습니다. 두 번 추출한 파일 목록과 바이트는 같습니다. `--archive` 검사는 원본에서 다시 계산한 연결·manifest·고지·생성 파일 전체와 직접 대조합니다. 일반 `check`의 저장된 해시 검증과 이 원본 대조를 구분하세요.

검사기는 정적 import·re-export·문자열 상수의 동적 import를 AST로 추적합니다. 계산된 경로, require/createRequire/eval/Function 로더, 누락된 대상, 패키지 밖 경로 및 미승인 Node 로더 모듈은 자동 추측하지 않고 실패합니다. 범용 악성 JavaScript 분석기나 안전 실행 샌드박스는 아닙니다.

## 변경할 때의 원칙

- SDK 버전을 올리려면 tarball·gitHead·체크섬·출처/고지·import closure를 다시 검토합니다. 실패한 검사만 끄거나 숫자를 바꾸지 마세요.
- 원본 JS를 임의로 패치하거나 취약 라이브러리 이름만 바꾸지 않습니다. 새 import와 의존성이 필요하면 그 이유·라이선스·audit·회귀를 함께 검토합니다.
- 잠금파일을 유지합니다. 개발·선택 의존성까지 전체 audit을 실행하며 예외 목록이나 lock 삭제로 검사를 우회하지 않습니다.
- 원래 브리지 31개 테스트와 실제 Kakao BSON/암호화/단일 WRITE 회귀를 유지했습니다. 더 이상 설치하지 않는 LINE/JOSE/Thrift 테스트 8개는 실제 Kakao 스키마·자격증명·동적 인증·리스너·미디어·분류 검증으로 대체했습니다. 출처와 import-closure 실패 주입 테스트도 추가했습니다.
- 상류 README의 MIT 선언에 따라 `vendor/kakao-sdk/LICENSE`에 MIT 전문과 `agent-messenger contributors` 저작권 고지를 둡니다. 상류가 공개하지 않은 개인 저작권자·연도는 만들지 않습니다. [출처 설명](../NOTICE.md)을 확인하세요.

전체 audit 0개는 **실계정 안전성 보증이 아닙니다.** 테스트는 오프라인 모의 HTTP·전송 계층을 사용하며 실제 계정 로그인/송신은 별도 본인 테스트 계정의 수동 검증 대상입니다.
