import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_MESSAGE = `이벤트에 참여해 주셔서 감사합니다!\n\n권글 BOOK LAB에서 준비한 무료 책쓰기 특강에 초대합니다.\n\n무료특강 신청하기\nhttps://kwongeulbooklab.netlify.app/free-class\n\n신청 후 카카오톡 오픈채팅방에도 입장해 주세요. 특강 참여 안내를 전달해 드립니다.\nhttps://open.kakao.com/o/gbhFXQTi\n\n무료특강에서 뵙겠습니다!`;

export const defaultState = () => ({
  settings: {
    targetPostId: '', targetPermalink: '',
    message: DEFAULT_MESSAGE, autoEnabled: false, autoActivatedAt: null,
    dailyMax: 40, perBatchMax: 10, delaySeconds: 5,
  },
  replies: {}, history: [],
  sync: { lastAt: null, lastError: null, truncated: false, count: 0 },
});

export class JsonStore {
  constructor(file) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) {
      const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.state = defaultState();
      Object.assign(this.state, loaded);
      this.state.settings = { ...defaultState().settings, ...(loaded.settings || {}) };
      // Restore auto mode, but never automatically retry an in-flight API request.
      for (const item of Object.values(this.state.replies || {})) {
        if (item.status === 'sending') item.status = 'uncertain';
      }
      this.save();
    } else { this.state = defaultState(); this.save(); }
  }
  save() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
  resetForPost(id, permalink = '') {
    this.state.settings.targetPostId = id;
    this.state.settings.targetPermalink = permalink;
    this.state.settings.autoEnabled = false;
    this.state.settings.autoActivatedAt = null;
    this.state.replies = {};
    this.state.history = [];
    this.state.sync = { lastAt: null, lastError: null, truncated: false, count: 0 };
    this.save();
  }
}
