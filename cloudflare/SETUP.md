# Cloudflare 배포 안내

1. Cloudflare에서 Workers & Pages를 엽니다.
2. D1 데이터베이스 `kwongeul-threads-db`를 생성합니다.
3. `cloudflare/schema.sql`의 SQL을 D1 콘솔에서 실행합니다.
4. Worker를 생성하고 `cloudflare/worker.js`를 배포합니다.
5. Worker의 D1 binding 이름을 `DB`로 설정하고 생성한 D1을 연결합니다.
6. Secrets에 `ADMIN_PASSWORD`(12자 이상)와 `THREADS_ACCESS_TOKEN`을 저장합니다. 토큰은 GitHub에 넣지 않습니다.
7. Cron Trigger를 `*/5 * * * *`로 설정합니다.
8. Netlify에서 `/api/*`를 Worker 주소로 프록시하도록 설정합니다.

주의: 현재 코드는 초기 구현이며, 실계정 검증 및 인증/동시성 검토 전에는 자동 발송을 활성화하지 마세요.
