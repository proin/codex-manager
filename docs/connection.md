# Codex 연결

앱은 컴퓨터에 설치된 Codex CLI의 `app-server`를 실행하여 계정을 연결합니다. 셸 설정을 불러오지 않고 실행 파일을 찾으므로 Finder에서 실행해도 동작합니다. 자동 탐색으로 찾지 못한 경우 앱 설정에서 Codex 실행 파일을 선택합니다.

## 로그인과 계정 분리

계정을 추가한 뒤 ChatGPT 로그인 화면에서 사용할 계정으로 로그인합니다. 각 계정에는 별도 `CODEX_HOME` 폴더를 배정하고 Codex의 `keyring` 저장 방식을 설정합니다. 운영체제의 인증 정보 저장소를 사용하며, 폴더 경로별로 로그인 정보를 구분합니다. 기존 Codex 앱이나 CLI의 로그인 파일을 복사하지 않습니다.

## 사용량과 초기화권

| 기능 | Codex 요청 |
| --- | --- |
| 로그인 시작 | `account/login/start` |
| 로그인 취소 | `account/login/cancel` |
| 계정 정보 | `account/read` |
| 사용량과 초기화권 조회 | `account/rateLimits/read` |
| 기간별 토큰 사용량 조회 | `account/usage/read` |
| 초기화권 사용 | `account/rateLimitResetCredit/consume` |
| 로그아웃 | `account/logout` |

사용량은 서버가 제공하는 기간별 사용 비율과 다음 갱신 시간을 표시합니다. 초기화권 정보가 제공되지 않으면 보유 수량을 0으로 처리하지 않습니다. 초기화권 목록에는 서버가 반환한 ID, 발급일, 만료일, 상태를 표시합니다. 사용자가 목록에서 선택하고 확인 알림을 승인하면 해당 ID를 `creditId`로 전송합니다. 전송 전에 선택한 항목의 사용 가능 상태와 기간을 다시 조회합니다. 처리 후 사용량과 보유 수량을 다시 조회합니다. 같은 요청을 재시도할 때는 동일한 초기화권 ID와 요청 식별자를 사용합니다.

연결 방식과 요청 형식은 [OpenAI 공식 Codex App Server 문서](https://learn.chatgpt.com/docs/app-server)에 설명되어 있습니다.

## 호스트의 Codex 계정 전환

호스트의 **계정 전환**은 SSH로 해당 서버의 Codex App Server를 실행하고 `account/login/start`의 `chatgptDeviceCode` 방식으로 시작합니다. 인증 주소와 일회용 코드만 앱에 표시합니다. 사용자가 브라우저에서 인증을 완료하면 `account/read`로 서버의 계정을 다시 조회합니다. 기존 계정을 미리 로그아웃하거나 로그인 파일을 직접 수정하지 않습니다. 취소 시 `account/login/cancel`을 보내고 SSH 연결을 종료합니다. 인증 코드와 로그인 진행 상태는 파일에 저장하지 않습니다.

기기 코드 로그인은 ChatGPT 보안 설정 또는 워크스페이스 권한에서 허용되어 있어야 합니다. [OpenAI 기기 코드 로그인 안내](https://learn.chatgpt.com/docs/auth#login-on-headless-devices)

## 실행 점검

```sh
npm test
node scripts/smoke-runtime.cjs
```

두 번째 명령은 임시 폴더에서 로그인하지 않은 `app-server`를 실행합니다. 설치된 CLI가 로그인·사용량·초기화권 요청을 제공하는지 검사하고, 초기 연결과 빈 계정 응답, 로그인 전 사용량 조회 거부를 점검합니다. 임시 폴더는 종료 시 삭제합니다.

개발 중 Codex CLI 0.149.0으로 위 연결 점검을 통과했습니다. 실제 계정의 로그인 완료, 사용량 조회, 초기화권 사용 결과는 사용자 로그인 후 점검해야 합니다. 자동 점검은 로그인을 시작하거나 초기화권을 사용하지 않습니다.

## 문구 검토

- [x] 문서와 안내 문장을 문어체로 작성했습니다.
- [x] 기능명과 상태를 명확한 용어로 표기했습니다.
- [x] 점검한 기능과 로그인 후 점검할 기능을 구분했습니다.
