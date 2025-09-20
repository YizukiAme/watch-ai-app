// 统一脚本：根据 body[data-page] 分三种页面执行
(function () {
  const PAGE = document.body?.dataset?.page || 'index';

  // ------- 配置 -------
  const USE_STREAM = true; // 能流就流，失败自动回退
  const STREAM_API = '/api/generate-text-stream';

  // ------- 公共状态与工具 -------
  let cos, cosConfig;
  let conversationHistory = [];
  let currentConversationKey = null;
  let bucketKeys = [];
  let indexMap = {};
  const INDEX_KEY = 'meta/watch-index.json';

  const generationConfig = { temperature: 1.0, maxOutputTokens: 65536 };
  const thinkingConfig   = { thinkingBudget: 32768 };

  // ---- 安全转义 ----
  const esc = (s='') => s.replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));

  // ---- 兜底 Markdown 渲染器（不依赖任何库）----
  function miniMarkdown(input){
    let txt = String(input || '');
    txt = esc(txt);
    txt = txt.replace(/```([\s\S]*?)```/g, (_, code)=>'<pre><code>'+code+'</code></pre>');
    txt = txt.replace(/`([^`]+?)`/g, (_, code)=>'<code>'+code+'</code>');
    txt = txt.replace(/\[([^\]]+?)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    txt = txt.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_]+)__/g, '<strong>$1</strong>');
    txt = txt
      .replace(/(^|[\s>])\*([^*\n]+)\*(?=($|[\s<]))/g, '$1<em>$2</em>')
      .replace(/(^|[\s>])_([^_\n]+)_(?=($|[\s<]))/g, '$1<em>$2</em>');
    const lines = txt.split('\n'); const out=[]; let inUL=false,inOL=false,inBQ=false;
    const closeLists=()=>{ if(inUL){out.push('</ul>');inUL=false;} if(inOL){out.push('</ol>');inOL=false;} };
    const closeBQ=()=>{ if(inBQ){out.push('</blockquote>');inBQ=false;} };
    for (let line of lines){
      let m;
      if (m = line.match(/^(\#{1,6})\s+(.*)$/)){ closeLists(); closeBQ(); const lv=m[1].length; out.push(`<h${lv}>${m[2]}</h${lv}>`); continue; }
      if (/^>\s?/.test(line)){ closeLists(); if(!inBQ){out.push('<blockquote>'); inBQ=true;} out.push('<p>'+line.replace(/^>\s?/, '')+'</p>'); continue; }
      else { closeBQ(); }
      if (/^\s*([-*+])\s+/.test(line)){ if(!inUL){ closeBQ(); if(inOL){out.push('</ol>'); inOL=false;} out.push('<ul>'); inUL=true; } out.push('<li>'+line.replace(/^\s*[-*+]\s+/, '')+'</li>'); continue; }
      else if (inUL && line.trim()===''){ out.push('</ul>'); inUL=false; continue; }
      if (/^\s*\d+\.\s+/.test(line)){ if(!inOL){ closeBQ(); if(inUL){out.push('</ul>'); inUL=false;} out.push('<ol>'); inOL=true; } out.push('<li>'+line.replace(/^\s*\d+\.\s+/, '')+'</li>'); continue; }
      else if (inOL && line.trim()===''){ out.push('</ol>'); inOL=false; continue; }
      if (line.trim()===''){ closeLists(); closeBQ(); continue; }
      closeLists(); out.push('<p>'+line+'</p>');
    }
    closeLists(); closeBQ(); return out.join('');
  }

  // ---- Markdown & KaTeX：优先 marked，失败走兜底 ----
  function renderMarkdown(text){
    try{
      const m = window.marked;
      const parse = typeof m?.parse === 'function' ? m.parse : (typeof m === 'function' ? m : null);
      if (parse) return parse(String(text ?? ''));
    }catch{}
    return miniMarkdown(text);
  }
  function renderMathIn(el){
    if (!el) return;
    if (typeof window.renderMathInElement === 'function'){
      try{
        window.renderMathInElement(el, {
          delimiters: [
            { left: '$$', right: '$$', display: true },
            { left: '$',  right: '$',  display: false },
            { left: '\\(', right: '\\)', display: false },
            { left: '\\[', right: '\\]', display: true }
          ],
          throwOnError: false
        });
      }catch{}
    }
  }

  // ---- 其他工具 ----
  const fmtTime = (ms)=>{ try{return new Date(parseInt(String(ms),10)).toLocaleString();}catch{return ms;} };
  function sanitize(t){
    t = String(t||'');
    t = t.replace(/```[\s\S]*?```/g,'').replace(/`[^`]*`/g,'').replace(/[#>*_~\[\]\(\)\-!]/g,'').replace(/\s+/g,' ').trim();
    return t;
  }
  function guessTitle(){
    let lastUser = [...conversationHistory].reverse().find(m=>m.role==='user');
    let base = sanitize(lastUser?.parts?.[0]?.text || '') || sanitize((conversationHistory.find(m=>m.role==='user')||{}).parts?.[0]?.text||'');
    if (!base) return '新对话';
    return (/[\u4e00-\u9fa5]/.test(base) ? base.slice(0,16) : base.slice(0,24));
  }
  const b64e=(s)=>{ try { return btoa(unescape(encodeURIComponent(s))); } catch { return btoa(s); } };
  const b64d=(s)=>{ try { return decodeURIComponent(escape(atob(s))); } catch { try { return atob(s); } catch { return ''; } } };

  // ---- storage keys ----
  const LS_PENDING_INPUT = 'watchai_pending_input';
  const LS_PENDING_LOAD  = 'watchai_pending_load';
  const LS_CUR_HIST      = 'watchai_cur_history';
  const LS_CUR_KEY       = 'watchai_cur_key';

  function saveBufferLS(){ try{ localStorage.setItem(LS_CUR_HIST, JSON.stringify(conversationHistory||[])); localStorage.setItem(LS_CUR_KEY, currentConversationKey||''); }catch{} }
  function loadBufferLS(){ try{ const h=JSON.parse(localStorage.getItem(LS_CUR_HIST)||'[]'); const k=localStorage.getItem(LS_CUR_KEY)||''; conversationHistory=Array.isArray(h)?h:[]; currentConversationKey=k||null; }catch{ conversationHistory=[]; currentConversationKey=null; } }
  function clearBufferLS(){ try{ localStorage.removeItem(LS_CUR_HIST); localStorage.removeItem(LS_CUR_KEY); }catch{} }

  // COS
  async function initCOS(){
    if (typeof COS !== 'function') throw new Error('COS not defined');
    const res = await fetch('/api/cos-credentials');
    if (!res.ok) throw new Error('Failed to fetch credentials');
    const sts = await res.json();
    cosConfig = { Bucket: sts.Bucket, Region: sts.Region };
    cos = new COS({ getAuthorization: (_, cb) => cb({
      TmpSecretId: sts.Credentials.TmpSecretId,
      TmpSecretKey: sts.Credentials.TmpSecretKey,
      XCosSecurityToken: sts.Credentials.Token,
      StartTime: Math.round(Date.now()/1000)-1,
      ExpiredTime: sts.ExpiredTime
    })});
  }
  async function loadConversationList(){
    if (!cos){ bucketKeys=[]; return; }
    const data = await cos.getBucket({ ...cosConfig, Prefix: '' });
    const list = Array.isArray(data?.Contents) ? data.Contents : [];
    bucketKeys = list.map(it=>it.Key).filter(k=>typeof k==='string' && k.endsWith('.json') && k!==INDEX_KEY).sort((a,b)=>parseInt(b)-parseInt(a));
  }
  async function loadIndexMap(){
    if (!cos){ indexMap={}; return; }
    try {
      const data = await cos.getObject({ ...cosConfig, Key: INDEX_KEY });
      indexMap = JSON.parse(data.Body.toString()||'{}') || {};
    } catch { indexMap = {}; }
  }
  async function saveIndexMap(){
    if (!cos) return;
    await cos.putObject({ ...cosConfig, Key: INDEX_KEY, Body: JSON.stringify(indexMap) });
  }
  async function saveConversation(){
    if (!cos || conversationHistory.length < 2) return;
    if (!currentConversationKey) currentConversationKey = `${Date.now()}.json`;
    await cos.putObject({ ...cosConfig, Key: currentConversationKey, Body: JSON.stringify(conversationHistory) });
    const title = guessTitle(); if (title){ indexMap[currentConversationKey] = title; await saveIndexMap(); }
    saveBufferLS();
  }
  async function deleteConversation(key){
    if (!cos || !key) return;
    await cos.deleteObject({ ...cosConfig, Key: key });
    if (indexMap[key]){ delete indexMap[key]; await saveIndexMap(); }
    if (currentConversationKey === key){ currentConversationKey = null; conversationHistory = []; saveBufferLS(); }
  }
  async function loadConversation(key){
    if (!cos || !key) return;
    const data = await cos.getObject({ ...cosConfig, Key: key });
    const loaded = JSON.parse(data.Body.toString());
    currentConversationKey = key;
    conversationHistory = Array.isArray(loaded) ? loaded : [];
    saveBufferLS();
  }

  async function modelReply(){
    const res = await fetch('/api/generate-text', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ conversationHistory, generationConfig, thinkingConfig })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || JSON.stringify(data) || 'API error');
    return data.text || '';
  }

  // --- Streaming ---
  function parseGeminiSSEChunk(acc, chunkText){
    // Google 返回的是多段 `data: {json}\n\n`
    const parts = chunkText.split('\n\n');
    for (const p of parts){
      const line = p.trim();
      if (!line.startsWith('data:')) continue;
      const json = line.slice(5).trim();
      if (json === '[DONE]') continue;
      try{
        const obj = JSON.parse(json);
        // 把所有 obj 里的 "text" 字段拼出来（鲁棒点）
        const texts = [];
        (function walk(o){
          if (!o || typeof o!=='object') return;
          if (typeof o.text === 'string') texts.push(o.text);
          for (const k in o){ if (o.hasOwnProperty(k)) walk(o[k]); }
        })(obj);
        const delta = texts.join('');
        if (delta){
          // 处理“整段覆盖”的情况：如果是累积片段，直接替换；否则追加
          if (delta.startsWith(acc.all)) acc.all = delta;
          else acc.all += delta;
        }
      }catch{}
    }
    return acc;
  }

  async function streamModelReply(){
    const res = await fetch(STREAM_API, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ conversationHistory, generationConfig, thinkingConfig }),
    });
    if (!res.ok || !res.body) throw new Error('Stream API error');
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let acc = { all: '' };
    let done, value;
    const pump = async (onDelta)=>{
      while (true){
        ({ done, value } = await reader.read());
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        parseGeminiSSEChunk(acc, chunk);
        onDelta(acc.all);
      }
      return acc.all;
    };
    return { pump };
  }

  function pushUser(text){ conversationHistory.push({ role:'user', parts:[{text}] }); saveBufferLS(); }
  function pushModel(text){ conversationHistory.push({ role:'model', parts:[{text}] }); saveBufferLS(); }

  // ------- 页面：index -------
  async function bootIndex(){
    const chatWindow = document.getElementById('chat-window');
    const newChatBtn = document.getElementById('new-chat-btn');
    const autoSaveToggle = document.getElementById('auto-save-toggle');
    const historyControls = document.getElementById('history-controls');

    // URL 意图
    const params = new URLSearchParams((location.hash || '').replace(/^#/, ''));
    const hasLoadIntent = params.has('load');
    const hasSendIntent = params.has('send');
    const hasResume     = params.has('resume');
    const hasEditIdx    = params.has('edit'); // 仅 index 回来时处理

    if (!hasLoadIntent && !hasSendIntent && !hasResume) { clearBufferLS(); } // 冷启动默认新会话
    loadBufferLS();

    try { await initCOS(); await loadIndexMap(); }
    catch(e){ addMsg('System', `**Error:** 初始化失败: ${e.message}`); }

    let pendingSend = hasSendIntent ? b64d(params.get('send') || '') : '';
    let pendingLoad = hasLoadIntent ? (params.get('load') || '') : '';
    const editIndex  = hasEditIdx ? parseInt(params.get('edit') || '-1', 10) : -1;

    if (!pendingSend){ try { pendingSend = localStorage.getItem(LS_PENDING_INPUT) || ''; localStorage.removeItem(LS_PENDING_INPUT); } catch {} }
    if (location.hash) history.replaceState(null, '', location.pathname);

    // 渲染现有缓冲或欢迎语
    if (conversationHistory.length){
      renderAll();
    } else {
      addMsg('Gemini', '你好, NyAme。我是 Gemini，准备好开始了吗？', true);
      saveBufferLS();
    }

    // 先加载历史，再处理发送/编辑
    if (pendingLoad && cos){
      try {
        await loadConversation(pendingLoad);
        chatWindow.innerHTML = '';
        renderAll();
      } catch(e){ addMsg('System', `**Error:** 载入对话失败: ${e.message}`); }
    }

    if (pendingSend && editIndex >= 0 && editIndex < conversationHistory.length) {
      // 编辑重算：替换这条 user 消息，截断后续对话
      if (conversationHistory[editIndex]?.role !== 'user') {
        addMsg('System', '**Error:** 只能编辑你自己的消息');
      } else {
        conversationHistory[editIndex] = { role:'user', parts:[{ text: pendingSend }] };
        conversationHistory = conversationHistory.slice(0, editIndex + 1);
        saveBufferLS();
        chatWindow.innerHTML = '';
        renderAll();
        await sendMessage('', { chatWindow, autoSaveToggle, noEchoUser: true }); // 已经把用户消息放进去了，不再重复显示
      }
    } else if (pendingSend) {
      await sendMessage(pendingSend, { chatWindow, autoSaveToggle });
    }

    // 顶部胶囊微隐藏
    let last = 0;
    chatWindow.addEventListener('scroll', () => {
      const st = chatWindow.scrollTop || 0;
      if (st > last && st > 30) historyControls.classList.add('hidden');
      else historyControls.classList.remove('hidden');
      last = Math.max(0, st);
    }, { passive:true });

    newChatBtn.addEventListener('click', () => {
      chatWindow.innerHTML = '';
      conversationHistory = [];
      currentConversationKey = null;
      clearBufferLS();
      addMsg('Gemini', '你好, NyAme。我是 Gemini，准备好开始了吗？', true);
      saveBufferLS();
    });

    function renderAll(){
      chatWindow.innerHTML = '';
      conversationHistory.forEach((msg, idx) => {
        const who = msg.role==='user'?'NyAme':(msg.role==='system'?'System':'Gemini');
        const el = addMsg(who, msg.parts?.[0]?.text || '', false);
        if (msg.role==='user') { el.dataset.index = String(idx); el.classList.add('clickable'); }
      });
      // 给“自己的气泡”加点击编辑
      chatWindow.querySelectorAll('.message.user.clickable').forEach(el => {
        el.addEventListener('click', ()=>{
          const idx = parseInt(el.dataset.index || '-1', 10);
          if (idx < 0) return;
          const raw = conversationHistory[idx]?.parts?.[0]?.text || '';
          const href = `input.html#edit=${idx}&text=${encodeURIComponent(b64e(raw))}`;
          window.location.href = href;
        });
      });
    }

    function addMsg(sender, text, addToBuffer = true){
      const div = document.createElement('div');
      const role = sender.toLowerCase()==='nyame'?'user':sender.toLowerCase()==='system'?'system':'gemini';
      if (addToBuffer && role!=='system'){
        conversationHistory.push({ role: role==='user'?'user':'model', parts:[{text}] });
        saveBufferLS();
      }
      div.className = `message ${role}`;
      div.innerHTML = renderMarkdown(text);
      renderMathIn(div);
      chatWindow.appendChild(div);
      chatWindow.scrollTop = chatWindow.scrollHeight;
      return div;
    }

    async function sendMessage(userText, env){
      // 如果是正常发送，追加用户消息；如果是“编辑重算”，noEchoUser=true
      if (!env.noEchoUser) { addMsg('NyAme', userText, false); pushUser(userText); }

      // 渲染中的 assistant 气泡
      const assistantDiv = document.createElement('div');
      assistantDiv.className = 'message gemini';
      assistantDiv.innerHTML = '…';
      env.chatWindow.appendChild(assistantDiv);
      env.chatWindow.scrollTop = env.chatWindow.scrollHeight;

      try {
        if (USE_STREAM && 'ReadableStream' in window) {
          // 流式
          const { pump } = await streamModelReply();
          let lastRendered = '';
          await pump((fullText)=>{
            if (fullText === lastRendered) return;
            lastRendered = fullText;
            assistantDiv.innerHTML = renderMarkdown(fullText);
            renderMathIn(assistantDiv);
            env.chatWindow.scrollTop = env.chatWindow.scrollHeight;
          });
          // 录入对话
          pushModel(lastRendered || assistantDiv.textContent || '');
        } else {
          // 非流式回退
          const reply = await modelReply();
          assistantDiv.innerHTML = renderMarkdown(reply);
          renderMathIn(assistantDiv);
          pushModel(reply);
        }
        if (document.getElementById('auto-save-toggle')?.checked && cos) { await saveConversation(); }
      } catch(e){
        assistantDiv.innerHTML = esc('**Error:** ' + (e?.message || e));
      }
    }
  }

  // ------- 页面：input -------
  function bootInput(){
    const ta  = document.getElementById('input-textarea');
    const btn = document.getElementById('input-send-btn');
    const back = document.querySelector('.ghost-btn.small');

    const params = new URLSearchParams((location.hash || '').replace(/^#/, ''));
    const editIdx = params.has('edit') ? parseInt(params.get('edit')||'-1',10) : -1;
    const prefill = params.has('text') ? b64d(params.get('text')||'') : '';

    if (prefill) ta.value = prefill;

    // 发送
    btn.addEventListener('click', () => {
      const t = (ta.value||'').trim();
      if (!t) { window.location.href = 'index.html#resume'; return; }
      try { localStorage.setItem(LS_PENDING_INPUT, t); } catch {}
      const payload = encodeURIComponent(b64e(t));
      if (editIdx >= 0) window.location.href = `index.html#edit=${editIdx}&send=${payload}`;
      else window.location.href = `index.html#send=${payload}`;
    });

    // 取消：回到 index 并保留当前会话（#resume）
    if (back) back.setAttribute('href', 'index.html#resume');

    ta.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') btn.click();
    });
  }

  // ------- 页面：history -------
  async function bootHistory(){
    const listEl = document.getElementById('history-list');
    try { await initCOS(); await loadConversationList(); await loadIndexMap(); }
    catch(e){ listEl.innerHTML = `<div class="list-empty">${esc('**Error:** '+e.message)}</div>`; return; }

    if (!bucketKeys.length){ listEl.innerHTML = `<div class="list-empty">没有保存的对话</div>`; return; }

    bucketKeys.forEach(k => {
      const row = document.createElement('div'); row.className = 'list-row';
      const a = document.createElement('a');
      a.className = 'list-item';
      a.href = `index.html#load=${encodeURIComponent(k)}`;
      a.textContent = indexMap[k] || fmtTime(k.replace('.json',''));
      const del = document.createElement('button'); del.className = 'list-del small'; del.textContent='删除';
      del.addEventListener('click', async (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        const ok = confirm('确定删除该会话？此操作不可恢复。');
        if (!ok) return;
        try { await deleteConversation(k); await loadConversationList(); await loadIndexMap();
          row.remove(); if (!listEl.childElementCount) listEl.innerHTML = `<div class="list-empty">没有保存的对话</div>`;
        } catch(e){ alert('删除失败: ' + e.message); }
      });
      row.appendChild(a); row.appendChild(del); listEl.appendChild(row);
    });
  }

  // ------- 启动 -------
  if (PAGE === 'index') { bootIndex(); }
  else if (PAGE === 'input') { bootInput(); }
  else if (PAGE === 'history') { bootHistory(); }
})();
