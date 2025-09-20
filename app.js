// 统一脚本：根据 body[data-page] 分三种页面执行
(function () {
  const PAGE = document.body?.dataset?.page || 'index';

  // ------- 公共状态与工具 -------
  let cos, cosConfig;
  let conversationHistory = [];
  let currentConversationKey = null;
  let bucketKeys = [];
  let indexMap = {};
  const INDEX_KEY = 'meta/watch-index.json';

  const generationConfig = { temperature: 1.0, maxOutputTokens: 65536 };
  const thinkingConfig   = { thinkingBudget: 32768 };

  // ---- Markdown & KaTeX 渲染：本地优先，失败降级 ----
  const escapeHTML = (s='') => s.replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  function renderMarkdown(text){
    try { if (window.marked?.parse) return marked.parse(text); } catch {}
    // 降级：仅做最基本的换行与转义
    return `<p>${escapeHTML(String(text||'')).replace(/\n/g,'<br>')}</p>`;
  }
  function renderMathIn(container){
    if (!container) return;
    if (typeof window.renderMathInElement === 'function') {
      try {
        window.renderMathInElement(container, {
          delimiters: [
            { left: '$$', right: '$$', display: true },
            { left: '$',  right: '$',  display: false },
            { left: '\\(', right: '\\)', display: false },
            { left: '\\[', right: '\\]', display: true }
          ],
          throwOnError: false
        });
      } catch {}
    }
  }

  // ---- 小工具 ----
  const fmtTime = (ms) => { try { return new Date(parseInt(String(ms),10)).toLocaleString(); } catch { return ms; } };
  const sanitize = (t='') => t.replace(/```[\s\S]*?```/g,'').replace(/`[^`]*`/g,'').replace(/[#>*_~\[\]\(\)\-!]/g,'').replace(/\s+/g,' ').trim();
  const guessTitle = () => {
    const lastUser = [...conversationHistory].reverse().find(m => m.role === 'user');
    let base = sanitize(lastUser?.parts?.[0]?.text || '') || sanitize((conversationHistory.find(m=>m.role==='user')||{}).parts?.[0]?.text||'');
    if (!base) return '新对话';
    return (/[\u4e00-\u9fa5]/.test(base) ? base.slice(0,16) : base.slice(0,24));
  };
  const b64e = (s) => { try { return btoa(unescape(encodeURIComponent(s))); } catch { return btoa(s); } };
  const b64d = (s) => { try { return decodeURIComponent(escape(atob(s))); } catch { try { return atob(s); } catch { return ''; } } };

  // ---- storage keys ----
  const LS_PENDING_INPUT = 'watchai_pending_input';
  const LS_PENDING_LOAD  = 'watchai_pending_load';
  const LS_CUR_HIST      = 'watchai_cur_history';
  const LS_CUR_KEY       = 'watchai_cur_key';

  function saveBufferLS() {
    try {
      localStorage.setItem(LS_CUR_HIST, JSON.stringify(conversationHistory || []));
      localStorage.setItem(LS_CUR_KEY, currentConversationKey || '');
    } catch {}
  }
  function loadBufferLS() {
    try {
      const h = JSON.parse(localStorage.getItem(LS_CUR_HIST) || '[]');
      const k = localStorage.getItem(LS_CUR_KEY) || '';
      conversationHistory = Array.isArray(h) ? h : [];
      currentConversationKey = k || null;
    } catch {
      conversationHistory = []; currentConversationKey = null;
    }
  }
  function clearBufferLS() {
    try {
      localStorage.removeItem(LS_CUR_HIST);
      localStorage.removeItem(LS_CUR_KEY);
    } catch {}
  }

  // COS
  async function initCOS() {
    const res = await fetch('/api/cos-credentials');
    if (!res.ok) throw new Error('Failed to fetch credentials');
    const sts = await res.json();
    cosConfig = { Bucket: sts.Bucket, Region: sts.Region };
    cos = new COS({
      getAuthorization: (_, cb) => cb({
        TmpSecretId: sts.Credentials.TmpSecretId,
        TmpSecretKey: sts.Credentials.TmpSecretKey,
        XCosSecurityToken: sts.Credentials.Token,
        StartTime: Math.round(Date.now()/1000)-1,
        ExpiredTime: sts.ExpiredTime
      })
    });
  }

  async function loadConversationList() {
    if (!cos) return bucketKeys=[];
    const data = await cos.getBucket({ ...cosConfig, Prefix: '' });
    const list = Array.isArray(data?.Contents) ? data.Contents : [];
    bucketKeys = list
      .map(it => it.Key)
      .filter(k => typeof k==='string' && k.endsWith('.json') && k !== INDEX_KEY)
      .sort((a,b)=>parseInt(b)-parseInt(a));
  }

  async function loadIndexMap() {
    if (!cos) return indexMap={};
    try {
      const data = await cos.getObject({ ...cosConfig, Key: INDEX_KEY });
      indexMap = JSON.parse(data.Body.toString()||'{}') || {};
    } catch { indexMap = {}; }
  }

  async function saveIndexMap() {
    if (!cos) return;
    await cos.putObject({ ...cosConfig, Key: INDEX_KEY, Body: JSON.stringify(indexMap) });
  }

  async function saveConversation() {
    if (!cos || conversationHistory.length < 2) return;
    if (!currentConversationKey) currentConversationKey = `${Date.now()}.json`;
    await cos.putObject({ ...cosConfig, Key: currentConversationKey, Body: JSON.stringify(conversationHistory) });
    const title = guessTitle();
    if (title) { indexMap[currentConversationKey] = title; await saveIndexMap(); }
    saveBufferLS();
  }

  async function deleteConversation(key) {
    if (!cos || !key) return;
    await cos.deleteObject({ ...cosConfig, Key: key });
    if (indexMap[key]) { delete indexMap[key]; await saveIndexMap(); }
    if (currentConversationKey === key) {
      currentConversationKey = null; conversationHistory = []; saveBufferLS();
    }
  }

  async function loadConversation(key) {
    if (!cos || !key) return;
    const data = await cos.getObject({ ...cosConfig, Key: key });
    const loaded = JSON.parse(data.Body.toString());
    currentConversationKey = key;
    conversationHistory = Array.isArray(loaded) ? loaded : [];
    saveBufferLS();
  }

  async function modelReply() {
    const res = await fetch('/api/generate-text', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ conversationHistory, generationConfig, thinkingConfig })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || JSON.stringify(data) || 'API error');
    return data.text || '';
  }

  function pushUser(text){ conversationHistory.push({ role:'user', parts:[{text}] }); saveBufferLS(); }
  function pushModel(text){ conversationHistory.push({ role:'model', parts:[{text}] }); saveBufferLS(); }

  // ------- 页面：index -------
  async function bootIndex() {
    const chatWindow = document.getElementById('chat-window');
    const newChatBtn = document.getElementById('new-chat-btn');
    const autoSaveToggle = document.getElementById('auto-save-toggle');
    const historyControls = document.getElementById('history-controls');

    loadBufferLS();
    try { await initCOS(); await loadIndexMap(); } catch(e){ addMsg('System', `**Error:** 初始化失败: ${e.message}`); }

    // 双通道：URL hash + localStorage
    const params = new URLSearchParams((location.hash || '').replace(/^#/, ''));
    let pendingSend = params.has('send') ? b64d(params.get('send') || '') : '';
    let pendingLoad = params.has('load') ? (params.get('load') || '') : '';
    if (!pendingSend) { try { pendingSend = localStorage.getItem(LS_PENDING_INPUT) || ''; localStorage.removeItem(LS_PENDING_INPUT); } catch {} }
    if (!pendingLoad) { try { pendingLoad = localStorage.getItem(LS_PENDING_LOAD)  || ''; localStorage.removeItem(LS_PENDING_LOAD); } catch {} }
    if (location.hash) history.replaceState(null, '', location.pathname);

    // 展示现有会话或欢迎语
    if (conversationHistory.length) {
      conversationHistory.forEach(msg => addMsg(msg.role==='user'?'NyAme':msg.role==='system'?'System':'Gemini', msg.parts?.[0]?.text||'', false));
    } else {
      addMsg('Gemini', '你好, NyAme。我是 Gemini，准备好开始了吗？', true);
      saveBufferLS();
    }

    // 先加载历史，再处理发送
    if (pendingLoad) {
      try {
        await loadConversation(pendingLoad);
        chatWindow.innerHTML = '';
        conversationHistory.forEach(msg => addMsg(msg.role==='user'?'NyAme':msg.role==='system'?'System':'Gemini', msg.parts?.[0]?.text||'', false));
      } catch(e){ addMsg('System', `**Error:** 载入对话失败: ${e.message}`); }
    }
    if (pendingSend) {
      await sendMessage(pendingSend, { chatWindow, autoSaveToggle });
    }

    // 滚动隐藏顶胶囊
    let last = 0;
    chatWindow.addEventListener('scroll', () => {
      const st = chatWindow.scrollTop;
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

    function addMsg(sender, text, addToBuffer = true){
      const div = document.createElement('div');
      const role = sender.toLowerCase()==='nyame'?'user':sender.toLowerCase()==='system'?'system':'gemini';
      if (addToBuffer && role!=='system') {
        conversationHistory.push({ role: role==='user'?'user':'model', parts:[{text}] });
        saveBufferLS();
      }
      div.className = `message ${role}`;
      div.innerHTML = renderMarkdown(text);
      // 数学渲染
      renderMathIn(div);
      chatWindow.appendChild(div);
      chatWindow.scrollTop = chatWindow.scrollHeight;
    }

    async function sendMessage(userText, env){
      addMsg('NyAme', userText, false); pushUser(userText);
      const thinking = document.createElement('div');
      thinking.className = 'message gemini'; thinking.textContent = '…';
      env.chatWindow.appendChild(thinking); env.chatWindow.scrollTop = env.chatWindow.scrollHeight;

      try {
        const reply = await modelReply();
        env.chatWindow.removeChild(thinking);
        addMsg('Gemini', reply, false); pushModel(reply);
        if (document.getElementById('auto-save-toggle')?.checked) { await saveConversation(); }
      } catch(e){
        env.chatWindow.removeChild(thinking);
        addMsg('System', `**Error:** ${e.message}`, false);
      }
    }
  }

  // ------- 页面：input -------
  function bootInput(){
    const ta = document.getElementById('input-textarea');
    const btn = document.getElementById('input-send-btn');
    btn.addEventListener('click', () => {
      const t = (ta.value||'').trim();
      if (!t) { window.location.href = 'index.html'; return; }
      try { localStorage.setItem(LS_PENDING_INPUT, t); } catch {}
      const payload = encodeURIComponent(b64e(t));
      window.location.href = `index.html#send=${payload}`;
    });
    ta.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') btn.click();
    });
  }

  // ------- 页面：history -------
  async function bootHistory(){
    const listEl = document.getElementById('history-list');
    try { await initCOS(); await loadConversationList(); await loadIndexMap(); }
    catch(e){ listEl.innerHTML = `<div class="list-empty">${escapeHTML('**Error:** '+e.message)}</div>`; return; }

    if (!bucketKeys.length) { listEl.innerHTML = `<div class="list-empty">没有保存的对话</div>`; return; }

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
