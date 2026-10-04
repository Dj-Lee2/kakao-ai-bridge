# 📜 카카오 AI 브리지 · 출처와 이용 조건

## 이 브리지의 코드

기존 카카오 브리지의 검증된 SDK 연결·수신 형태, 방/멤버 검증, 단일 low-level 발송, readback, 원자적 상태 저장 패턴을 바탕으로 새 portable CLI/구조를 작성했습니다. 운영 경로·개인 프롬프트·운영 계정/방/토큰·상태는 가져오지 않았습니다.

이 프로젝트 코드에 대해 권리자의 공개 라이선스를 임의로 지정하지 않았습니다. 루트 `package.json`의 `private: true`, `license: UNLICENSED`는 npm 공개 게시를 막고 브리지 코드의 라이선스 선택이 아직 안 됐음을 표시합니다. 소스 공개는 별도 이용·수정·재배포 허가와 다릅니다. 해당 허가는 권리자에게 확인하세요. 이 표시는 아래 타사 코드의 라이선스를 변경하지 않습니다.

## agent-messenger 2.38.1에서 가져온 카카오 전용 코드

- 원 프로젝트: https://github.com/agent-messenger/agent-messenger
- 고정 배포본: https://registry.npmjs.org/agent-messenger/-/agent-messenger-2.38.1.tgz
- 원본 SHA256: `e72b7af4ad4a61c6263c9814438019ae043a1a339520addfddfa9591b5e4e22a`
- npm gitHead: `801d7c441e5d52c6840954134b4d16994e0df5a3`
- 원본 공개 진입점 `agent-messenger/kakaotalk`에서 도달하는 JavaScript 22개를 **수정 없이** `vendor/kakao-sdk/dist/src`에 보존합니다. 전체 SDK·다른 메신저·상류 CLI를 포함하지 않습니다.
- 별도 이름 `@kakao-ai-bridge/kakao-sdk@2.38.1-kakao.1`은 이 브리지에서 유지하는 부분집합입니다. 상류의 공식 배포나 전체 패키지로 가장하지 않습니다.
- 원본 파일 경로·해시·import 연결·배포본의 고지 파일 목록은 [source-manifest.json](vendor/kakao-sdk/source-manifest.json)에 있습니다. [재생성·원본 대조 방법](docs/SDK-SUBSET.md)도 제공합니다.

### 라이선스: MIT

원본 npm README와 해당 gitHead의 README는 다음처럼 명시합니다.

```text
## License

MIT
```

원본 배포본에는 별도 LICENSE 파일이 없어, [vendor/kakao-sdk/LICENSE](vendor/kakao-sdk/LICENSE)에 MIT 표준 전문과 다음 저작권 고지를 함께 둡니다.

```text
Copyright (c) agent-messenger contributors
(https://github.com/agent-messenger/agent-messenger)
```

상류가 공개하지 않은 개인 저작권자나 연도는 임의로 적지 않았습니다. 근거가 된 [원본 README 전체](vendor/kakao-sdk/provenance/README.upstream.md)는 바이트 변경 없이 보존합니다.

[Kakao protocol 원본 NOTICE](vendor/kakao-sdk/src/platforms/kakaotalk/protocol/NOTICE.md)도 그대로 보존했습니다. 이 고지는 구현을 새로 작성했고 열거한 프로젝트에서 코드를 복사하지 않았다고 설명합니다. MIT 외에 라이선스 미지정·비상업적 조건의 프로토콜 참고자료도 **원문 그대로** 명시합니다. 참고자료 전체가 MIT라고 재표시하지 않습니다. 제외한 LINE 코드의 별도 라이선스를 카카오 코드 전체의 전문으로 대신하지 않습니다.

### 보존한 연결 계약

`loginFlow`, `KakaoTalkClient`, `KakaoTalkListener`와 공개 JavaScript export 전체를 유지합니다. `AGENT_MESSENGER_CONFIG_DIR`라는 상류 환경변수 이름도 그대로 사용하되 전용 상태 폴더로 덮어씁니다. SDK high-level sendMessage의 reconnect/retry, 상류 auth CLI의 로컬 자격증명 추출·debugLog는 사용하지 않습니다. 인증은 임의 구현한 API가 아니라 원본 SDK 함수를 호출합니다.

JavaScript 실행 부분집합이므로 TypeScript 선언·빌드 소스·source map은 포함하지 않습니다. 코드 바이트 보존을 위해 원본 `sourceMappingURL` 주석은 남아 있지만 대응 map 파일은 제공하지 않습니다.

## bson · zod · 검증 도구

실행 의존성은 `bson@6.10.4`(원본과 같은 Long/BSON 처리), `zod@4.6.5`(원본 스키마 처리)입니다. 개발 검증용 AST parser는 `acorn@8.18.0`입니다. 잠금파일로 npm 원 배포본을 설치하며 각 의존성의 권리·고지·라이선스는 해당 패키지 원본을 따릅니다.

## 보안 검증 한계

부분집합 전환 후 전체 `npm audit`의 보고 항목은 0개였습니다. 설치한 의존성을 검사에서 숨긴 결과가 아니라 사용하지 않는 메신저 코드와 dependency edge를 실제로 제거한 결과입니다. 이 숫자는 조회 시점의 알려진 의존성 경고에 한정되며 실계정 안전성·프로토콜 호환성·미발견 취약점 부재를 보증하지 않습니다. 실제 계정 로그인·송수신 및 기존 운영 봇 변경은 하지 않았습니다.
