import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { JsonStore } from '../lib/store.js';
import { ReplyEngine } from '../lib/engine.js';

const setup = (replies = []) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'threads-test-'));
  const store = new JsonStore(path.join(dir, 'state.json'));
  store.resetForPost('1234567890', 'https://www.threads.net/@test/post/ABC');
  store.state.settings.delaySeconds = 1;
  const published = [];
  const api = {
    me: async () => ({ id: 'me', username: 'kwongeul' }),
    listReplies: async () => ({ replies, truncated: false }),
    publishReply: async (id, text) => { published.push({ id, text }); return { id: `pub${published.length}` }; },
  };
  const engine = new ReplyEngine(store, api);
  return { store, engine, published, api, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
};
test('댓글마다 동일한 고정 문구를 전송하고 재실행해도 중복 발송하지 않는다', async () => {
  const fixture = setup([
    { id: 'a', username: 'guest1', text: '신청해요', timestamp: '2026-10-30T12:00:00Z' },
    { id: 'b', username: 'guest2', text: '참여합니다', timestamp: '2026-10-30T12:00:01Z' },
  ]);
  try {
    assert.equal((await fixture.engine.sync()).added, 2);
    const result = await fixture.engine.send({ ids: ['a','b'] });
    assert.equal(result.sent, 2);
    assert.equal(fixture.published.length, 2);
    assert.equal(fixture.published[0].text, fixture.published[1].text);
    assert.equal((await fixture.engine.send({ ids: ['a','b'] })).sent, 0);
    assert.equal(fixture.published.length, 2);
  } finally { fixture.cleanup(); }
});
test('본인 댓글을 제외하고, 자동 모드는 활성화 전 댓글을 발송하지 않는다', async () => {
  const fixture = setup([{ id:'self', username:'kwongeul', text:'내 댓글' }, { id:'old', username:'other', text:'이전 댓글' }]);
  try {
    await fixture.engine.sync();
    assert.equal(Object.keys(fixture.store.state.replies).length, 1);
    fixture.store.state.settings.autoEnabled = true;
    fixture.store.state.settings.autoActivatedAt = new Date().toISOString();
    assert.equal((await fixture.engine.send({ mode:'auto' })).sent, 0);
    fixture.api.listReplies = async () => ({ replies: [{ id:'new', username:'newuser', text:'새 댓글' }], truncated:false });
    await new Promise(resolve => setTimeout(resolve, 10));
    await fixture.engine.tick();
    assert.deepEqual(fixture.published.map(x => x.id), ['new']);
  } finally { fixture.cleanup(); }
});
test('API 장애는 확인 필요로 저장하고 재발송하지 않는다', async () => {
  const fixture = setup([{ id:'fail', username:'guest', text:'댓글' }]);
  try {
    await fixture.engine.sync();
    fixture.api.publishReply = async () => { throw new Error('network timeout'); };
    assert.equal((await fixture.engine.send({ ids:['fail'] })).errors, 1);
    assert.equal(fixture.store.state.replies.fail.status, 'uncertain');
    assert.equal((await fixture.engine.send({ ids:['fail'] })).sent, 0);
    const reloaded = new JsonStore(fixture.store.file);
    assert.equal(reloaded.state.replies.fail.status, 'uncertain');
  } finally { fixture.cleanup(); }
});
