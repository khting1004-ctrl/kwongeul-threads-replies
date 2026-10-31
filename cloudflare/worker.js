const BASE='https://graph.threads.net/v1.0';
const json=(v,s=200)=>new Response(JSON.stringify(v),{status:s,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'}});
const defaults={targetPostId:'',targetPermalink:'',message:'이벤트 참여 감사합니다! 무료 책쓰기 특강 신청: https://kwongeulbooklab.netlify.app/free-class\n오픈채팅 입장: https://open.kakao.com/o/gbhFXQTi',autoEnabled:false,autoActivatedAt:null,dailyMax:0,perBatchMax:5,delaySeconds:5};
const now=()=>new Date().toISOString();
async function config(env){const row=await env.DB.prepare("SELECT value FROM config WHERE key='settings'").first();return {...defaults,...(row?JSON.parse(row.value):{})};}
async function save(env,s){await env.DB.prepare("INSERT INTO config(key,value) VALUES('settings',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(JSON.stringify(s)).run();}
async function graph(env,path,params={},method='GET'){if(!env.THREADS_ACCESS_TOKEN)throw Error('Threads API 토큰을 Cloudflare Secrets에 입력하세요.');let url=new URL(BASE+path);for(const [k,v] of Object.entries(params))if(method==='GET')url.searchParams.set(k,String(v));let opt={method,headers:{Authorization:'Bearer '+env.THREADS_ACCESS_TOKEN}};if(method==='POST'){opt.headers['content-type']='application/x-www-form-urlencoded';opt.body=new URLSearchParams(params);}const resp=await fetch(url,opt);const data=await resp.json();if(!resp.ok)throw Error(data.error?.message||'Threads API '+resp.status);return data;}
async function pages(env,path,fields,maxPages=25){
  let out=[],after='',nextUrl='',more=false;
  const seen=new Set();
  for(let i=0;i<maxPages;i++){
    let result;
    if(nextUrl){
      const u=new URL(nextUrl);
      if(u.hostname!=='graph.threads.net'||u.protocol!=='https:')throw Error('잘못된 Threads 페이지 이동 주소입니다.');
      const res=await fetch(nextUrl,{headers:{Authorization:'Bearer '+env.THREADS_ACCESS_TOKEN}});
      result=await res.json();
      if(!res.ok)throw Error(result.error?.message||'Threads 페이지 조회 실패');
    } else {
      result=await graph(env,path,{fields,limit:100,...(after?{after}:{})});
    }
    const batch=result.data||[];
    out.push(...batch);
    const forward=result.paging?.next||'';
    const cursor=result.paging?.cursors?.after||'';
    if(!batch.length||(!forward&&!cursor)||(cursor&&seen.has(cursor))){more=false;break;}
    if(cursor)seen.add(cursor);
    nextUrl=forward;
    after=cursor;
    more=true;
    if(!forward&&!cursor)break;
  }
  return {data:out,truncated:more};
}
async function snapshot(env){const s=await config(env);const all=await env.DB.prepare('SELECT * FROM replies ORDER BY timestamp DESC LIMIT 1000').all();const history=await env.DB.prepare('SELECT * FROM history ORDER BY id DESC LIMIT 150').all();const rows=all.results||[];const counts=await env.DB.prepare('SELECT status,COUNT(*) AS n FROM replies GROUP BY status').all();const countByStatus=Object.fromEntries((counts.results||[]).map(r=>[r.status,r.n]));const today=now().slice(0,10);const sentToday=await env.DB.prepare("SELECT count(*) AS n FROM history WHERE status='sent' AND substr(at,1,10)=?").bind(today).first();return {connected:!!env.THREADS_ACCESS_TOKEN,busy:false,settings:s,sync:{lastAt:null,lastError:null,truncated:false,count:rows.length},stats:{pending:countByStatus.pending||0,sent:countByStatus.sent||0,uncertain:countByStatus.uncertain||0,sentToday:sentToday?.n||0},replies:rows.map(x=>({...x,firstSeenAt:x.first_seen_at,sentAt:x.sent_at,publishedId:x.published_id})),history:(history.results||[]).map(x=>({replyId:x.reply_id,username:x.username,status:x.status,at:x.at,error:x.error}))};}
async function sync(env){
  const s=await config(env);
  if(!s.targetPostId)throw Error('이벤트 게시물을 선택하세요.');
  const me=await graph(env,'/me',{fields:'id,username'});
  const fields='id,text,username,timestamp,permalink,is_reply_owned_by_me';
  const path='/'+s.targetPostId+'/replies';
  let after=s.scanCursor||'';
  let fetched=0,added=0,hasMore=false;
  const seen=new Set();
  for(let i=0;i<4;i++){
    const page=await graph(env,path,{fields,limit:100,...(after?{after}:{})});
    const rows=page.data||[];
    fetched+=rows.length;
    const inserts=rows.filter(x=>!x.is_reply_owned_by_me&&x.username?.toLowerCase()!==me.username?.toLowerCase());
    for(let k=0;k<inserts.length;k+=50){
      const batch=inserts.slice(k,k+50).map(x=>env.DB.prepare("INSERT OR IGNORE INTO replies(id,username,text,timestamp,first_seen_at,status) VALUES(?,?,?,?,?,'pending')").bind(x.id,x.username||'',x.text||'',x.timestamp||now(),now()));
      if(batch.length){const results=await env.DB.batch(batch);added+=results.reduce((total,r)=>total+(r.meta?.changes||0),0);}
    }
    const cursor=page.paging?.cursors?.after || (()=>{
      const url=page.paging?.next;
      if(!url)return '';
      try{return new URL(url).searchParams.get('after')||'';}catch{return '';}
    })();
    if(!rows.length||!cursor||cursor===after||seen.has(cursor)){
      hasMore=false;after='';break;
    }
    seen.add(cursor);
    after=cursor;
    hasMore=true;
  }
  s.scanCursor=hasMore?after:'';
  await save(env,s);
  return {added,fetched,hasMore,truncated:hasMore};
}
async function send(env,ids=null,auto=false){const s=await config(env);if(auto&&!s.autoEnabled)return {sent:0};const today=now().slice(0,10);const todayRow=await env.DB.prepare("SELECT count(*) AS n FROM history WHERE status='sent' AND substr(at,1,10)=?").bind(today).first();const allowance=s.dailyMax===0?Number.MAX_SAFE_INTEGER:Math.max(0,s.dailyMax-(todayRow?.n||0));const limit=Math.min(20,Math.max(1,s.perBatchMax),allowance);if(!limit)return {sent:0,capReached:true};let rows=(await env.DB.prepare("SELECT * FROM replies WHERE status='pending' ORDER BY timestamp LIMIT 1000").all()).results||[];if(ids)rows=rows.filter(x=>ids.includes(x.id));if(auto)rows=rows.filter(x=>s.autoActivatedAt&&x.timestamp>=s.autoActivatedAt);rows=rows.slice(0,limit);let sent=0,errors=0;for(const x of rows){const claimed=await env.DB.prepare("UPDATE replies SET status='sending' WHERE id=? AND status='pending'").bind(x.id).run();if(!claimed.meta?.changes)continue;try{const draft=await graph(env,'/me/threads',{media_type:'TEXT',text:s.message,reply_to_id:x.id},'POST');if(!draft.id)throw Error('Threads 답글 작성 ID가 없습니다.');const created=await graph(env,'/me/threads_publish',{creation_id:draft.id},'POST');if(!created.id)throw Error('Threads 답글 발행 ID가 없습니다.');await env.DB.prepare("UPDATE replies SET status='sent',sent_at=?,published_id=? WHERE id=?").bind(now(),created.id||'',x.id).run();await env.DB.prepare("INSERT INTO history(reply_id,username,status,at) VALUES(?,?,'sent',?)").bind(x.id,x.username,now()).run();sent++;}catch(e){await env.DB.prepare("UPDATE replies SET status='uncertain',error=? WHERE id=?").bind(e.message,x.id).run();await env.DB.prepare("INSERT INTO history(reply_id,username,status,at,error) VALUES(?,?,'uncertain',?)").bind(x.id,x.username,now(),e.message).run();errors++;break;}}return {sent,errors,remaining:Math.max(0,rows.length-sent-errors)};}

function decodeThreadsPostUrl(input){
  let url;
  try{url=new URL(String(input||'').trim());}catch{throw Error('Threads 게시물 주소를 입력하세요.');}
  if(url.protocol!=='https:'||!['threads.com','www.threads.com','threads.net','www.threads.net'].includes(url.hostname))throw Error('threads.com 또는 threads.net 게시물 주소만 지원합니다.');
  const match=url.pathname.match(/^\/@([A-Za-z0-9_.]+)\/post\/([A-Za-z0-9_-]{5,16})\/?$/);
  if(!match)throw Error('게시물 원본 주소 형식이 필요합니다: threads.com/@계정/post/게시물코드');
  const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let id=0n;
  for(const c of match[2]){const digit=alphabet.indexOf(c);if(digit<0)throw Error('게시물 코드가 올바르지 않습니다.');id=id*64n+BigInt(digit);}
  return {id:id.toString(),username:match[1].toLowerCase()};
}
async function resolveLink(env,link){
  const decoded=decodeThreadsPostUrl(link);
  const fields='id,username,text,permalink,timestamp,is_reply,root_post,replied_to';
  let item;
  try{item=await graph(env,'/'+decoded.id,{fields});}
  catch(e){throw Error('해당 게시물 코드를 Threads API에서 조회하지 못했습니다: '+e.message);}
  if(item.username&&item.username.toLowerCase()!==decoded.username)throw Error('링크의 작성자와 API 조회 결과가 일치하지 않습니다.');
  const rootId=String(item.root_post?.id||(!item.is_reply?item.id:'')||'');
  if(!rootId)throw Error('이 댓글의 원본 게시물 ID를 조회하지 못했습니다. 댓글의 root_post 필드에 접근할 수 있는지 확인해 주세요.');
  let root=item;
  if(rootId!==String(item.id))root=await graph(env,'/'+rootId,{fields:'id,username,text,permalink,timestamp,is_reply'});
  const me=await graph(env,'/me',{fields:'id,username'});
  if(!root.username||root.username.toLowerCase()!==me.username.toLowerCase())throw Error('찾은 원본이 @'+me.username+' 소유 게시물이 아닙니다'+(root.username?' (원본: @'+root.username+')':'')+'. 계정 또는 링크를 확인하세요.');
  if(root.is_reply)throw Error('최상위 원본 게시물이 아니라 답글입니다.');
  return {source:{id:item.id,username:item.username||decoded.username,text:item.text||'',isReply:!!item.is_reply},target:{id:String(root.id),username:root.username,text:root.text||'',permalink:root.permalink||'',timestamp:root.timestamp||''}};
}

async function datedItems(env,path,fields,start,end){
  const found=[];let after='',truncated=false;const seen=new Set();
  for(let i=0;i<12;i++){
    const result=await graph(env,path,{fields,limit:100,since:start,until:end,...(after?{after}:{})});
    found.push(...(result.data||[]));
    const next=result.paging?.next||'';
    let cursor=result.paging?.cursors?.after||'';
    if(!cursor&&next){try{cursor=new URL(next).searchParams.get('after')||'';}catch{}}
    if(!next||!cursor||seen.has(cursor)){truncated=false;break;}
    seen.add(cursor);after=cursor;truncated=true;
  }
  return {items:found,truncated};
}
async function findEventOnDate(env){
  const start=Math.floor(Date.parse('2026-10-15T00:00:00+09:00')/1000);
  const end=Math.floor(Date.parse('2026-10-19T00:00:00+09:00')/1000);
  const me=await graph(env,'/me',{fields:'id,username'});
  const candidates=new Map(),problems=[];
  let postsCount=0,repliesCount=0,unverifiedRoots=[],partial=false;
  try{
    const own=await datedItems(env,'/me/threads','id,username,text,timestamp,permalink,is_reply,shortcode',start,end);
    postsCount=own.items.length;partial=partial||own.truncated;
    for(const p of own.items){
      if(p.is_reply||p.username?.toLowerCase()!==me.username?.toLowerCase())continue;
      candidates.set(String(p.id),{id:String(p.id),text:p.text||'',timestamp:p.timestamp||'',permalink:p.permalink||'',source:'내 게시물 목록'});
    }
  }catch(e){problems.push('내 게시물 조회: '+e.message);}
  try{
    const mine=await datedItems(env,'/me/replies','id,text,username,timestamp,permalink,root_post,replied_to,is_reply',start,end);
    repliesCount=mine.items.length;partial=partial||mine.truncated;
    const roots=[...new Set(mine.items.map(p=>String(p.root_post?.id||'')).filter(Boolean))].slice(0,35);
    for(const rootId of roots){
      if(candidates.has(rootId))continue;
      try{
        const p=await graph(env,'/'+rootId,{fields:'id,username,text,timestamp,permalink,is_reply'});
        if(p.username?.toLowerCase()!==me.username?.toLowerCase()||p.is_reply)continue;
        candidates.set(rootId,{id:rootId,text:p.text||'',timestamp:p.timestamp||'',permalink:p.permalink||'',source:'내 답글 기록에서 확인'});
      }catch(e){unverifiedRoots.push({id:rootId,error:e.message});}
    }
  }catch(e){problems.push('내 답글 기록 조회: '+e.message);}
  const ranked=[...candidates.values()].sort((a,b)=>{
    const aScore=(/전자책|SEO|무료|50페이지/.test(a.text)?10:0)+(a.timestamp?.slice(0,10)==='2026-10-16'?3:0);
    const bScore=(/전자책|SEO|무료|50페이지/.test(b.text)?10:0)+(b.timestamp?.slice(0,10)==='2026-10-16'?3:0);
    return bScore-aScore||String(a.timestamp).localeCompare(String(b.timestamp));
  });
  return {account:me.username,range:'2026-10-15 ~ 2026-10-18 (한국시간)',candidates:ranked.slice(0,80),postsCount,repliesCount,unverifiedRoots:unverifiedRoots.slice(0,8),partial,problems};
}
async function handle(req,env){const u=new URL(req.url),key=req.method+' '+u.pathname;const body=req.method==='POST'?await req.json():{};if(key==='GET /health')return {ok:true};if(key==='GET /api/state')return snapshot(env);if(key==='GET /api/profile'||key==='GET /api/connection'){const p=await graph(env,'/me',{fields:'id,username'});return key.endsWith('connection')?{connected:true,...p}:p;}if(key==='GET /api/find-event')return findEventOnDate(env);if(key==='POST /api/resolve-link')return resolveLink(env,body.url);if(key==='GET /api/posts'){const result=await pages(env,'/me/threads','id,text,permalink,timestamp,is_reply,shortcode');return {posts:result.data.filter(x=>!x.is_reply),truncated:result.truncated};}if(key==='POST /api/target'){if(!/^\d{5,30}$/.test(String(body.id||'')))throw Error('게시물 ID가 올바르지 않습니다.');const s=await config(env);if(s.targetPostId!==body.id){await env.DB.batch([env.DB.prepare('DELETE FROM replies'),env.DB.prepare('DELETE FROM history')]);s.autoEnabled=false;s.autoActivatedAt=null;s.scanCursor='';}s.targetPostId=body.id;s.targetPermalink=body.permalink||'';await save(env,s);return snapshot(env);}if(key==='POST /api/settings'){const s=await config(env);if(typeof body.message!=='string'||body.message.length<5||[...body.message].length>500)throw Error('답글은 5~500자여야 합니다.');for(const [k,lo,hi] of [['dailyMax',0,1000000],['perBatchMax',1,20],['delaySeconds',3,60]])if(!Number.isInteger(Number(body[k]))||Number(body[k])<lo||Number(body[k])>hi)throw Error('발송 설정을 확인하세요: '+k);Object.assign(s,{message:body.message,dailyMax:Number(body.dailyMax),perBatchMax:Number(body.perBatchMax),delaySeconds:Number(body.delaySeconds)});await save(env,s);return snapshot(env);}if(key==='POST /api/sync')return {...await sync(env),state:await snapshot(env)};if(key==='POST /api/auto'){const s=await config(env);if(body.enabled){await sync(env);s.autoActivatedAt=now();}s.autoEnabled=!!body.enabled;await save(env,s);return snapshot(env);}if(key==='POST /api/send'){if(!Array.isArray(body.ids)||body.ids.length<1||body.ids.length>20)throw Error('발송할 댓글을 선택하세요.');return {result:await send(env,body.ids,false),state:await snapshot(env)};}if(key==='POST /api/mark-reviewed'){if(!['sent','pending'].includes(body.status))throw Error('상태 오류');const row=await env.DB.prepare("UPDATE replies SET status=?,error=NULL WHERE id=? AND status='uncertain'").bind(body.status,body.id).run();if(!row.meta?.changes)throw Error('확인 필요 댓글이 아닙니다.');return snapshot(env);}throw Error('존재하지 않는 API입니다.');}
export default {async fetch(req,env){const path=new URL(req.url).pathname;if(path==='/health')return json({ok:true});if(!path.startsWith('/api/'))return env.ASSETS?env.ASSETS.fetch(req):new Response('Not found',{status:404});if(!env.ADMIN_PASSWORD||env.ADMIN_PASSWORD.length<12)return json({error:'ADMIN_PASSWORD 미설정'},503);const header=req.headers.get('Authorization')||'';let auth='';try{if(header.startsWith('Basic '))auth=atob(header.slice(6)).split(':').slice(1).join(':');}catch{}if(auth!==env.ADMIN_PASSWORD)return new Response('관리자 인증 필요',{status:401,headers:{'WWW-Authenticate':'Basic realm="Threads Admin"','access-control-allow-origin':'*'}});try{return json(await handle(req,env));}catch(e){return json({error:e.message},400);}},async scheduled(event,env,ctx){ctx.waitUntil((async()=>{const s=await config(env);if(s.autoEnabled&&env.THREADS_ACCESS_TOKEN){await sync(env);await send(env,null,true);}})().catch(console.error));}};
