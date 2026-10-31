const $ = id => document.getElementById(id);
let current = null;
let posts = [];
let resolvedTarget = null;
let busy = false;
const selectedIds = new Set();
const fmt = date => {
  if (!date) return '날짜 정보 없음';
  const d = new Date(date);
  return Number.isNaN(d.getTime()) ? '날짜 정보 없음' : d.toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};
function toast(message, error = false) {
  const el = $('toast');
  el.textContent = message;
  el.className = `toast visible${error ? ' error' : ''}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.className = 'toast', 5500);
}
async function api(path, body) {
  const options = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const r = await fetch('/api/' + path, options);
  const type = r.headers.get('content-type') || '';
  if (!type.includes('application/json')) {
    throw new Error('Cloudflare Worker API가 JSON을 반환하지 않았습니다. 배포 상태와 관리자 인증을 확인하세요.');
  }
  const result = await r.json();
  if (!r.ok) throw new Error(result.error || `HTTP ${r.status}`);
  return result;
}
async function task(callback) {
  if (busy) return;
  busy = true;
  for (const button of document.querySelectorAll('button')) button.disabled = true;
  try { await callback(); }
  catch (error) { toast(error.message, true); }
  finally { busy = false; for (const button of document.querySelectorAll('button')) button.disabled = false; }
}
function setText(element, value) { element.textContent = value; }
function render(state, { preserveMessage = false } = {}) {
  current = state;
  $('connection').textContent = state.connected ? '● API 토큰 설정됨' : '● API 토큰 미설정';
  $('connection').classList.toggle('online', state.connected);
  $('pendingCount').textContent = state.stats.pending;
  $('sentCount').textContent = state.stats.sent;
  $('todayCount').textContent = `${state.stats.sentToday} / ${state.settings.dailyMax === 0 ? "제한 없음*" : state.settings.dailyMax}`;
  $('uncertainCount').textContent = state.stats.uncertain;
  if (!preserveMessage) {
    $('message').value = state.settings.message;
    $('dailyMax').value = state.settings.dailyMax;
    $('batchMax').value = state.settings.perBatchMax;
    $('delaySeconds').value = state.settings.delaySeconds;
  }
  updateCount();
  const chosen = state.settings.targetPostId;
  $('selectedPost').textContent = chosen
    ? `선택됨 · ${chosen}${state.settings.targetPermalink ? '\n' + state.settings.targetPermalink : ''}`
    : '아직 선택된 게시물이 없습니다.';
  $('selectedPost').style.whiteSpace = 'pre-wrap';
  const on = state.settings.autoEnabled;
  $('autoStatus').textContent = on ? '● 자동 응답 실행 중' : '○ 자동 응답 꺼짐';
  $('autoStatus').className = `auto-status${on ? ' on' : ''}`;
  $('toggleAuto').textContent = on ? '자동 응답 중지' : '자동 응답 시작';
  const cron = state.cronHealth;
  const health = $('cronHealth');
  if (!cron) health.textContent = '예약 실행 기록 없음 · Cloudflare 배포 및 Cron Trigger 설정 확인 필요';
  else {
    const minutes = Math.round((Date.now() - new Date(cron.lastRunAt).getTime()) / 60000);
    const stale = !Number.isFinite(minutes) || minutes > 12;
    const activated = state.settings.autoActivatedAt;
    const recent = cron.newestTimestamp;
    const latestBeforeActivation = recent && activated && new Date(recent) < new Date(activated);
    health.textContent = '마지막 자동 실행: ' + fmt(cron.lastRunAt) + ' (' + (Number.isFinite(minutes) ? minutes + '분 전' : '시간 확인 불가') + ') · 단계: ' + cron.stage + ' · 조회: ' + (cron.fetched ?? '?') + '건 · 신규 수집: ' + cron.added + ' · 발송: ' + cron.sent + ' · 실패: ' + cron.errors + ' · 자동 발송 대기: ' + (state.eligibleAutoPending || 0) + (activated ? ' · 자동 시작: ' + fmt(activated) : '') + (recent ? ' · 마지막 조회 댓글: ' + fmt(recent) : '') + (latestBeforeActivation ? ' · 마지막 댓글이 자동 시작 이전에 작성되어 자동 발송 대상이 아닙니다' : '') + (cron.lastError ? ' · 오류: ' + cron.lastError : '') + (stale ? ' · 예약 작업이 12분 이상 실행되지 않았습니다' : '');
  }
  selectedIds.forEach(id => { if (!state.replies.some(r => r.id === id && r.status === 'pending')) selectedIds.delete(id); });
  renderReplies();
  renderHistory();
}
function updateCount() { $('charCount').textContent = `${[...$('message').value].length} / 500자`; }
function tag(text, css) { const el = document.createElement('span'); el.textContent = text; el.className = css; return el; }
function renderReplies() {
  const list = $('replyList'); list.replaceChildren();
  const items = current?.replies || [];
  if (!items.length) {
    const empty = tag('조회된 댓글이 없습니다. 이벤트 게시물을 선택하고 새 댓글 확인을 눌러 주세요.', 'empty');
    list.append(empty);
  }
  const stats = { pending: '발송 대기', sent: '발송 완료', uncertain: '확인 필요', sending: '발송 중' };
  for (const r of items) {
    const item = document.createElement('div'); item.className = 'reply-item';
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.className = 'reply-check';
    checkbox.disabled = r.status !== 'pending'; checkbox.checked = selectedIds.has(r.id);
    checkbox.setAttribute('aria-label', `@${r.username} 댓글 선택`);
    checkbox.addEventListener('change', () => { if (checkbox.checked) selectedIds.add(r.id); else selectedIds.delete(r.id); selectionUI(); });
    const body = document.createElement('div'); body.className = 'reply-body';
    const user = document.createElement('div'); user.className = 'reply-user';
    if (r.permalink && /^https:\/\/(www\.)?(threads\.net|threads\.com)\//.test(r.permalink)) {
      const link = document.createElement('a'); link.href = r.permalink; link.target = '_blank'; link.rel = 'noopener noreferrer';
      link.textContent = '@' + r.username; user.append(link);
    } else user.append(tag('@' + r.username, ''));
    user.append(tag(fmt(r.timestamp), 'when'));
    const message = tag(r.text, 'reply-text'); message.title = r.id;
    body.append(user, message);
    if (r.status === 'uncertain') {
      const reason = tag(r.error || '실제 발송 여부를 스레드에서 확인하세요.', 'reply-text');
      const review = document.createElement('div'); review.className = 'review';
      const confirmSent = document.createElement('button'); confirmSent.textContent = 'Threads에서 발송 확인함';
      const reset = document.createElement('button'); reset.textContent = '미발송 확인 · 다시 대기';
      confirmSent.addEventListener('click', () => reviewStatus(r.id, 'sent'));
      reset.addEventListener('click', () => reviewStatus(r.id, 'pending'));
      review.append(confirmSent, reset); body.append(reason, review);
    }
    item.append(checkbox, body, tag(stats[r.status] || r.status, `status ${r.status}`));
    list.append(item);
  }
  selectionUI();
}
function renderHistory() {
  const list = $('history'); list.replaceChildren();
  const entries = current?.history || [];
  if (!entries.length) { list.append(tag('아직 발송 기록이 없습니다.', 'empty')); return; }
  for (const h of entries.slice(0, 30)) {
    const row = document.createElement('div'); row.className = 'history-item';
    const who = tag(`@${h.username}  ·  ${h.status === 'sent' ? '답글 발송 완료' : h.status === 'reviewed_sent' ? '발송 확인 처리' : '상태 확인 필요'}`, '');
    const when = document.createElement('small'); when.textContent = fmt(h.at);
    row.append(who, when); list.append(row);
  }
}
function selectionUI() {
  $('selectionCount').textContent = `${selectedIds.size}개 선택됨`;
  const pending = (current?.replies || []).filter(r => r.status === 'pending');
  $('selectAll').checked = !!pending.length && pending.every(r => selectedIds.has(r.id));
}
async function reviewStatus(id, status) {
  const prompt = status === 'pending'
    ? '실제 Threads에서 발송되지 않은 것을 확인했습니까? 다시 대기로 돌리면 재발송할 수 있습니다.'
    : '실제 Threads에서 해당 답글이 발송된 것을 확인했습니까?';
  if (!confirm(prompt)) return;
  await task(async () => { render(await api('mark-reviewed', { id, status }), { preserveMessage: true }); toast('상태를 수정했습니다.'); });
}
$('message').addEventListener('input', updateCount);
function filterPosts() {
  const search=$('postSearch').value.trim().toLowerCase().replace(/\\s+/g,'');
  const select=$('postSelect');
  const previous=select.value;
  const filtered=posts.filter(p=>{
    const haystack=(fmt(p.timestamp)+' '+(p.text||'')+' '+(p.permalink||'')+' '+(p.shortcode||'')+' '+p.id).toLowerCase().replace(/\\s+/g,'');
    return !search||haystack.includes(search);
  });
  select.replaceChildren();
  const first=document.createElement('option');
  first.value=''; first.textContent='게시물을 선택하세요';
  select.append(first);
  for(const p of filtered){
    const option=document.createElement('option');
    option.value=p.id;
    option.textContent=fmt(p.timestamp)+' · '+(p.text||'이미지/동영상 게시물').replace(/\\s+/g,' ').slice(0,85);
    select.append(option);
  }
  const chosen=current?.settings.targetPostId;
  if(filtered.some(p=>p.id===previous))select.value=previous;
  else if(filtered.some(p=>p.id===chosen))select.value=chosen;
  $('postSearchStatus').textContent='검색 결과 '+filtered.length+'개 / 조회한 게시물 '+posts.length+'개';
}
$('postSearch').addEventListener('input',filterPosts);
$('loadPosts').addEventListener('click',()=>task(async()=>{
  const response=await api('posts');
  posts=response.posts;
  filterPosts();
  toast('게시물 '+posts.length+'개 조회 완료. 10. 16. 또는 전자책을 검색하세요.'+(response.truncated?' 일부 오래된 게시물은 API 조회 제한으로 제외될 수 있습니다.':''));
}));



$('expandKnownShares').addEventListener('click',()=>task(async()=>{
  const links=['https://www.threads.com/share/BASEmG9L1_/','https://www.threads.com/share/_0Uy9xAXL/'];
  const out=[];
  for(const link of links){
    try{
      const r=await api('expand-share',{url:link});
      out.push('공유 주소: '+link+'\n'+(r.canonical?'변환된 원본: '+r.canonical+'\n원본 ID: '+r.id+'\n계정 일치: '+(r.sameAccount?'예':'아니요')+'\nAPI 게시물 인증: '+(r.verified?'성공':'미확인'+(r.apiError?' ('+r.apiError+')':'')):'확인 불가: '+r.reason));
    }catch(e){out.push('공유 주소: '+link+'\n조회 오류: '+e.message);}
  }
  $('shareExpandResult').textContent=out.join('\n\n');
  toast('기존 공유 링크 검사를 마쳤습니다. 원본 주소 확인 결과를 검토하세요.');
}));
$('findOctoberEvent').addEventListener('click',()=>task(async()=>{
  $('octoberEventResult').textContent='@kwongeul 게시물과 답글 기록을 확인하고 있습니다.';
  const result=await api('find-event');
  if(result.candidates.length){
    posts=result.candidates;
    $('postSearch').value='';
    filterPosts();
    const first=posts.find(p=>/전자책|SEO|50페이지|무료/.test(p.text))||posts[0];
    $('postSelect').value=first.id;
    $('octoberEventResult').textContent='검색 대상: '+result.range+'\n찾은 원본 '+posts.length+'개 · 내 게시물 '+result.postsCount+'건 · 내 답글 '+result.repliesCount+'건\n\n첫 번째 후보: '+fmt(first.timestamp)+' · '+first.source+'\n'+(first.text||'(텍스트 정보 없음)').slice(0,230)+'\n\n※ 후보 내용을 확인한 후 보라색 [이 게시물을 이벤트 대상으로 설정] 버튼을 눌러주세요.'+(result.partial?'\n일부 페이지는 더 확인이 필요합니다.':'')+(result.problems.length?'\n주의: '+result.problems.join(' / '):'');
    toast('이벤트 게시물 후보를 찾았습니다. 내용을 확인하고 선택하세요.');
  }else{
    $('octoberEventResult').textContent='기간: '+result.range+'\n이 기간에 API로 조회된 내 게시물 '+result.postsCount+'개, 내 답글 '+result.repliesCount+'개입니다.\n소유권이 확인된 이벤트 원본을 찾지 못했습니다.'+(result.unverifiedRoots.length?'\n내 답글에서 발견했지만 조회 권한이 없는 원본 '+result.unverifiedRoots.length+'개가 있습니다.':'')+(result.problems.length?'\n조회 오류: '+result.problems.join(' / '):'')+'\n조회되지 않는 글을 다른 글로 대체해 자동 발송하지 않습니다.';
    toast('Threads API에서 원본을 찾지 못했습니다. 결과 메시지를 확인하세요.',true);
  }
}));
$('replyLinkInput').value='https://www.threads.com/@gimgyeonghwa173/post/Dej-ykMj4wX';
$('resolveReplyLink').addEventListener('click',()=>task(async()=>{
  resolvedTarget=null;
  $('selectResolvedPost').hidden=true;
  $('resolvedLinkStatus').textContent='Threads 공식 API에서 원본 게시물 확인 중...';
  const result=await api('resolve-link',{url:$('replyLinkInput').value.trim()});
  resolvedTarget=result.target;
  $('resolvedLinkStatus').textContent='댓글 주소: @'+result.source.username+'\n확인된 원본: @'+result.target.username+' · '+(result.target.timestamp?fmt(result.target.timestamp):'날짜 미확인')+'\n본문: '+(result.target.text||'(텍스트 없음)').slice(0,210)+'\n원본 ID: '+result.target.id+'\n아래 버튼을 눌러야만 이벤트 대상으로 지정됩니다.';
  $('selectResolvedPost').hidden=false;
  toast('원본 게시물을 찾았습니다. 내용을 확인한 뒤 지정하세요.');
}));
$('selectResolvedPost').addEventListener('click',()=>task(async()=>{
  if(!resolvedTarget)throw Error('먼저 원본 게시물을 조회하세요.');
  if(current?.settings.targetPostId&&current.settings.targetPostId!==resolvedTarget.id&&!confirm('이벤트 게시물을 바꾸면 현재 댓글과 발송 기록이 초기화됩니다. 계속할까요?'))return;
  render(await api('target',{id:resolvedTarget.id,permalink:resolvedTarget.permalink}),{preserveMessage:true});
  toast('원본 게시물을 이벤트 대상으로 지정했습니다. 아직 답글은 발송하지 않았습니다.');
}));
$('selectPost').addEventListener('click', () => task(async () => {
  const post = posts.find(p => p.id === $('postSelect').value);
  if (!post) throw new Error('이벤트 게시물을 먼저 선택해 주세요.');
  if (current?.settings.targetPostId && current.settings.targetPostId !== post.id && !confirm('이벤트 게시물을 바꾸면 현재 댓글/발송 기록이 초기화됩니다. 계속할까요?')) return;
  render(await api('target', { id: post.id, permalink: post.permalink || '' }), { preserveMessage: true });
  toast('이벤트 게시물이 설정되었습니다.');
}));
$('saveSettings').addEventListener('click', () => task(async () => {
  const message = $('message').value;
  const limit = { message, dailyMax: Number($('dailyMax').value), perBatchMax: Number($('batchMax').value), delaySeconds: Number($('delaySeconds').value) };
  render(await api('settings', limit)); toast('공통 답글 문구와 발송 제한을 저장했습니다.');
}));
$('refreshComments').addEventListener('click', () => task(async () => {
  let added=0,fetched=0,more=false,passes=0;
  do {
    const response=await api('sync', {});
    render(response.state,{preserveMessage:true});
    added+=response.added;
    fetched+=response.fetched;
    more=!!response.hasMore;
    passes++;
    toast('댓글 '+fetched+'개 확인, 신규 '+added+'개 저장'+(more?' · 추가 조회 중':' · 조회 완료'));
  } while(more&&passes<25);
  if(more)toast('조회량이 많습니다. 현재 '+fetched+'개 확인. 다시 새 댓글 확인을 누르면 이어서 조회합니다.');
}));
$('toggleAuto').addEventListener('click', () => task(async () => {
  const enabled = !current?.settings.autoEnabled;
  if (enabled) {
    if (!confirm('이제부터 새로 발견되는 이벤트 댓글에 같은 문구를 실제로 자동 발송합니다. 기존 댓글은 자동 발송되지 않습니다. 시작할까요?')) return;
  }
  render(await api('auto', { enabled }), { preserveMessage: true });
  toast(enabled ? '자동 응답을 시작했습니다. 새 댓글만 자동 처리합니다.' : '자동 응답을 중지했습니다.');
}));
$('selectAll').addEventListener('change', () => {
  const pending = (current?.replies || []).filter(r => r.status === 'pending');
  if ($('selectAll').checked) pending.forEach(r => selectedIds.add(r.id));
  else pending.forEach(r => selectedIds.delete(r.id));
  renderReplies();
});
$('sendSelected').addEventListener('click', () => task(async () => {
  const ids = [...selectedIds].slice(0, 20);
  if (!ids.length) throw new Error('대기 중인 댓글을 선택해 주세요.');
  if (!confirm(`선택한 ${ids.length}개 댓글에 아래 공통 문구로 실제 답글을 발송합니다.\n\n${current.settings.message}\n\n발송하시겠습니까?`)) return;
  const response = await api('send', { ids }); selectedIds.clear();
  render(response.state, { preserveMessage: true });
  toast(`${response.result.sent}개 발송 완료${response.result.errors ? ' · 일부 상태 확인 필요' : ''}${response.result.capReached ? ' · 오늘 발송 상한 도달' : ''}`);
}));
async function refreshSilent() {
  if (busy || document.visibilityState !== 'visible') return;
  try { const result = await api('state'); render(result, { preserveMessage: true }); }
  catch { /* Keep the dashboard usable during a brief outage. */ }
}
(async () => {
  try { render(await api('state')); }
  catch (err) { toast(`초기 로드 실패: ${err.message}`, true); }
})();
setInterval(refreshSilent, 15000);

$('verifyConnection').addEventListener('click', () => task(async () => {
  const profile = await api('connection');
  $('connectionGuide').textContent = `연결 성공: @${profile.username}. 이제 게시물 불러오기를 누르세요.`;
  toast(`Threads @${profile.username} 계정 연결 확인 완료`);
}));
