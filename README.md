# 권글 BOOK LAB — Threads 이벤트 댓글 자동 답글

**GitHub 관리형 v1.5** · Windows 실행 · GitHub Actions 코드 검사 · Render 자동 배포

한 개의 Threads 이벤트 게시물을 선택하고, 댓글마다 **동일한 고정 문구**를 답글로 보내는 관리자 웹 프로그램입니다. AI 답글/DM 기능은 없습니다. Meta 공식 API에 로그인 토큰과 권한이 연결되기 전에는 게시물을 불러오거나 발송하지 못합니다.

## 처음 시작하기 (가장 쉬운 방법)

1. `깃허브_업로드와_업데이트_안내.md`를 읽고 GitHub에서 **Private 저장소**를 만드세요.
2. 이 폴더의 **파일과 하위 폴더**를 GitHub에 업로드하세요. ZIP 파일 자체만 올리면 실행되지 않습니다.
3. 코드 업데이트는 GitHub에 변경을 Commit / Push 하는 방식으로 관리합니다.
4. Render에서 GitHub 저장소를 연결하고 `render.yaml` Blueprint로 서비스 생성하면 `main` 변경 후 **GitHub Actions 검사가 통과했을 때만** 자동 배포되도록 설정되어 있습니다.
5. Threads API 토큰과 관리자 비밀번호는 **Render 환경변수**에서만 입력합니다. `.env`는 GitHub에 업로드하지 않습니다.

## 로컬 Windows 실행

- Node.js **20 이상** 설치 (권장: 최신 LTS)
- `start_windows.bat`을 더블클릭하면 기본 비밀번호를 자동 생성하고 서버가 시작됩니다.
- 관리자 화면: `http://localhost:3000` · 사용자명 `admin` · 비밀번호는 `.env`의 `ADMIN_PASSWORD` 또는 새로 생성된 `LOGIN_PASSWORD.txt`
- 서버 창을 닫으면 로컬 자동 확인도 중지됩니다.
- GitHub에서 변경 내용을 로컬에 받아오려면 **GitHub Desktop → Fetch origin → Pull origin**, 또는 Git으로 복제한 폴더에서 `로컬_깃허브_업데이트.bat` 실행 후 서버 재시작.

## 사용 순서

1. Meta for Developers에서 Threads 권한과 액세스 토큰 발급
2. 관리자 화면에서 API 연결 확인
3. **게시물 불러오기** → 이벤트 게시물 선택
4. **공통 답글 작성** → 문구 저장
5. **새 댓글 확인** → 먼저 댓글 한 건에 수동 테스트
6. 테스트가 성공한 다음 **자동 응답 시작**

기존 댓글은 명시적으로 선택하여 수동 발송하고, 자동 모드는 활성화 뒤 새롭게 발견된 댓글만 처리합니다. 발송 이력은 `DATA_DIR/state.json`에 보관해 중복 처리를 방지합니다.

## 발송 제한과 주의사항

- 관리자 화면의 일일 최대를 `0`으로 설정할 수 있으며 이는 **프로그램 내부 상한만 해제**합니다. **Meta API 전송 제한·스팸 정책은 계속 적용**됩니다.
- 기본값: 하루 40회 · 한 번에 10회 · 건당 5초 간격(관리 화면 수정 가능)
- API 오류/타임아웃은 확인 필요로 기록하며 임의 재전송하지 않습니다.
- 본인 댓글을 제외하고, 선택된 이벤트 게시물에 대해서만 동작합니다.
- 매번 동일한 홍보 문구를 과다 발송하면 플랫폼에서 제한될 수 있습니다. 이벤트 참여를 요청한 대상에만 사용하세요.

## 저장소 보안

`.gitignore`가 `.env`, `LOGIN_PASSWORD.txt`, `data/state.json`을 제외합니다. GitHub에 **비밀번호나 API 토큰을 파일로 업로드하지 마세요**. 이미 올렸다면 저장소에서 파일만 삭제해도 과거 커밋에 남을 수 있으니 토큰·비밀번호를 즉시 교체하세요. 저장소는 Private 권장입니다.

## Render 서버 자동 배포

- GitHub `main`에 Push → GitHub Actions 테스트 → 통과 시 Render 자동 배포 (`autoDeployTrigger: checksPass`)
- Render에서 **Blueprint**를 생성하여 `render.yaml`을 읽도록 해야 합니다. 단순히 코드를 GitHub에 올리는 것만으로는 서버가 생성되지 않습니다.
- Render 환경 변수: `THREADS_ACCESS_TOKEN` · `ADMIN_PASSWORD` (12자 이상); `DATA_DIR=/data`는 설정에 포함
- `render.yaml`의 `plan: starter`와 1 GB 디스크는 **요금이 발생할 수 있는 구성**입니다. 배포 전에 가격을 확인하세요.
- Render에 **영구 디스크**가 없으면 재배포 시 댓글 이력을 잃고 중복 발송 위험이 있습니다. 디스크를 삭제하거나 새 서비스로 교체하면 이전 기록을 별도 이전해야 합니다.
- 로컬 PC와 Render 서버에서 동시에 자동 응답을 켜지 마세요.

## 테스트

```bash
npm test
```

현재 단위 테스트는 모의 API 기반이며 **Threads 실계정으로 실제 발송까지 검증한 결과는 아닙니다.** GitHub Actions에서도 실제 댓글은 발송하지 않습니다.

공식 문서: https://developers.facebook.com/docs/threads/ · https://render.com/docs/deploys
