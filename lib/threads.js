const BASE = 'https://graph.threads.net/v1.0';

export class ThreadsApi {
  constructor(token, { fetchImpl = globalThis.fetch, base = BASE } = {}) {
    if (!token) throw new Error('THREADS_ACCESS_TOKEN이 설정되지 않았습니다.');
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.base = base;
  }
  async request(method, route, params = {}) {
    const url = new URL(`${this.base}${route}`);
    const values = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) values.set(key, String(value));
    }
    if (method === 'GET') url.search = values.toString();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    let response;
    try {
      response = await this.fetchImpl(url, {
        method, signal: controller.signal,
        headers: { Authorization: `Bearer ${this.token}`,
          ...(method !== 'GET' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
        ...(method !== 'GET' ? { body: values } : {}),
      });
    } catch (error) {
      throw new Error(`Threads API 연결 실패: ${error.message}`);
    } finally { clearTimeout(timeout); }
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.error) {
      const detail = result.error?.message || `HTTP ${response.status}`;
      const err = new Error(`Threads API: ${detail}`);
      err.status = response.status;
      err.code = result.error?.code;
      throw err;
    }
    return result;
  }
  me() { return this.request('GET', '/me', { fields: 'id,username' }); }
  listPosts() { return this.request('GET', '/me/threads', { fields: 'id,text,permalink,timestamp,is_reply', limit: 50 }); }
  async listReplies(postId, maxPages = 10) {
    const replies = []; const seen = new Set();
    let after = null; let truncated = false;
    for (let page = 0; page < maxPages; page++) {
      const result = await this.request('GET', `/${encodeURIComponent(postId)}/replies`, {
        fields: 'id,text,username,timestamp,is_reply_owned_by_me,permalink',
        reverse: false, limit: 100, ...(after ? { after } : {}),
      });
      for (const reply of result.data || []) {
        if (!reply.id || seen.has(reply.id)) continue;
        seen.add(reply.id); replies.push(reply);
      }
      if (!result.paging?.next) return { replies, truncated: false };
      const nextAfter = result.paging?.cursors?.after;
      if (!nextAfter || nextAfter === after) { truncated = true; break; }
      after = nextAfter;
      if (page === maxPages - 1) truncated = true;
    }
    return { replies, truncated };
  }
  async publishReply(replyToId, text) {
    // create text container and publish; do not retry automatically after ambiguous failures
    const created = await this.request('POST', '/me/threads', {
      media_type: 'TEXT', text, reply_to_id: replyToId,
    });
    if (!created.id) throw new Error('Threads가 컨테이너 ID를 반환하지 않았습니다.');
    const published = await this.request('POST', '/me/threads_publish', { creation_id: created.id });
    if (!published.id) throw new Error('Threads가 발행 ID를 반환하지 않았습니다.');
    return { id: published.id, containerId: created.id };
  }
}
