const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export class ReplyEngine {
  constructor(store, api) { this.store = store; this.api = api; this.busy = false; this.profile = null; }
  async exclusive(fn) {
    if (this.busy) throw Object.assign(new Error('다른 작업이 진행 중입니다.'), { status: 409 });
    this.busy = true;
    try { return await fn(); } finally { this.busy = false; }
  }
  async sync() {
    const st = this.store.state;
    if (!st.settings.targetPostId) throw new Error('이벤트 게시물을 먼저 선택하세요.');
    try {
      this.profile ||= await this.api.me();
      const { replies, truncated } = await this.api.listReplies(st.settings.targetPostId);
      let added = 0;
      for (const r of replies) {
        if (r.is_reply_owned_by_me === true ||
            (this.profile.username && r.username?.toLowerCase() === this.profile.username.toLowerCase())) continue;
        if (!st.replies[r.id]) {
          st.replies[r.id] = {
            id: r.id, username: r.username || '알 수 없음', text: r.text || '',
            timestamp: r.timestamp || null, permalink: r.permalink || '',
            firstSeenAt: new Date().toISOString(), status: 'pending',
            sentAt: null, publishedId: null, error: null,
          };
          added++;
        }
      }
      st.sync = { lastAt: new Date().toISOString(), lastError: null, truncated, count: replies.length };
      this.store.save();
      return { added, fetched: replies.length, truncated };
    } catch (err) {
      st.sync.lastError = err.message;
      this.store.save();
      throw err;
    }
  }
  sentToday() {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const startMs = start.getTime();
    return this.store.state.history.filter(h => h.status === 'sent' && Date.parse(h.at) >= startMs).length;
  }
  async send({ mode = 'manual', ids = null } = {}) {
    const st = this.store.state;
    const s = st.settings;
    if (!s.targetPostId || !s.message.trim()) throw new Error('게시물과 발송 문구를 설정하세요.');
    if (mode === 'auto' && !s.autoEnabled) return { sent: 0, skipped: 0 };
    const cap = Math.max(0, s.dailyMax === 0 ? s.perBatchMax : Math.min(s.perBatchMax, s.dailyMax - this.sentToday()));
    let items = Object.values(st.replies).filter(r => r.status === 'pending');
    if (Array.isArray(ids)) items = items.filter(r => ids.includes(r.id));
    if (mode === 'auto') items = items.filter(r => s.autoActivatedAt && r.firstSeenAt > s.autoActivatedAt);
    items.sort((a, b) => (a.timestamp || a.firstSeenAt).localeCompare(b.timestamp || b.firstSeenAt));
    const selected = items.slice(0, cap);
    let sent = 0, errors = 0;
    for (const r of selected) {
      // Persist before network request, so crashes can't silently resend.
      r.status = 'sending'; r.error = null;
      const template = s.message; this.store.save();
      try {
        const result = await this.api.publishReply(r.id, template);
        r.status = 'sent'; r.sentAt = new Date().toISOString(); r.publishedId = result.id;
        st.history.unshift({ replyId: r.id, username: r.username, status: 'sent', at: r.sentAt, publishedId: result.id });
        sent++;
      } catch (err) {
        r.status = 'uncertain'; r.error = err.message;
        st.history.unshift({ replyId: r.id, username: r.username, status: 'uncertain', at: new Date().toISOString(), error: err.message });
        errors++;
        this.store.save();
        // Stop to avoid rate-limit bursts or duplicating an uncertain publish.
        break;
      }
      this.store.save();
      if (selected.length > 1 && r !== selected.at(-1)) await sleep(Math.max(1, s.delaySeconds) * 1000);
    }
    return { sent, errors, remaining: Object.values(st.replies).filter(r => r.status === 'pending').length,
      capReached: s.dailyMax > 0 && this.sentToday() >= s.dailyMax };
  }
  async tick() {
    if (!this.store.state.settings.autoEnabled || this.busy) return;
    return this.exclusive(async () => {
      const scanned = await this.sync();
      const sent = await this.send({ mode: 'auto' });
      return { ...scanned, ...sent };
    });
  }
}
