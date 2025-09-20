// 统一脚本：根据 body[data-page] 分三种页面执行
(function () {
  const PAGE = document.body?.dataset?.page || 'index';

  // ------- 公共状态与工具 -------
  let cos, cosConfig;
  let conversationHistory = [];          // 当前缓冲（跨页用 sessionStorage 保持）
  let currentConversationKey = null;
  let bucketKeys = [];
  let indexMap = {};
  const INDEX_KEY = 'meta/watch-index.json';

  const generationConfig = { temperature: 1.0, maxOutputTokens: 65536 };
  const thinkingConfig   = { thinkingBudget: 32768 };

  const escapeHTML = (s='') => s.replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  function md(text){ try{ if(window.marked?.parse) return marked.parse(text); }catch{} return `<p>${escapeHTML(text)}</p>`; }
  const fmtTime = (ms) => { try { return new Date(parseInt(String(ms),10)).toLocaleString(); } catch { return ms; } };
  const sanitize = (t='') => t.replace(/```[\s\S]*?```/g,'').replace(/`[^`]*`/g,'').replace(/[#>*_~\[\]\(\)\-!]/g,'').replace(/\s+/g,' ').trim();
  const guessTitle = () => {
    const lastUser = [...conversationHistory].reverse().find(m => m.role === 'user');
    let base = sanitize(lastUser?.parts?.[0]?.text || '') || sanitize((conversationHistory.find(m=>m.role==='user')||{}).parts?.[0]?.text||'');
    if (!base) return '新对话';
    return (/[\u4e00-\u9fa5]/.test(base) ? base.slice(0,16) : base.slice(0,24));
  };

  // sessionStorage 持久化（跨 index/input/history）
  const SS_KEY = 'watchai_current_history';
  const SS_KEY_CUR = 'watchai_current_key';
  function saveBuffer() {
    try {
      sessionStorage.setItem(SS_KEY, JSON.stringify(conversationHistory||[]));
      sessionStorage.setItem(SS_KEY_CUR, currentConversationKey || '');
    } catch {}
  }
  function loadBuffer() {
    try {
      const h = JSON.parse(sessionStorage.getItem(SS_KEY)||'[]');
      const k = sessionStorage.getItem(SS_KEY_CUR)||'';
      if (Array.isArray(h)) conversationHistory = h; else conversationHistory = [];
      currentConversationKey = k || null;
    } catch { conversationHistory = []; currentConversationKey = null; }
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
    saveBuffer();
  }

  async function deleteConversation(key) {
    if (!cos || !key) return;
    await cos.deleteObject({ ...cosConfig, Key: key });
    if (indexMap[key]) { delete indexMap[key]; await saveIndexMap(); }
    if (currentConversationKey === key) { currentConversationKey = null; conversationHistory = []; saveBuffer(); }
  }

  async function loadConversation(key) {
    if (!cos || !key) return;
    const data = await cos.getObject({ ...cosConfig, Key: key });
    const loaded = JSON.parse(data.Body.toString());
    currentConversationKey = key;
    conversationHistory = Array.isArray(loaded) ? loaded : [];
    saveBuffer();
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

  function pushUser(text){ conversationHistory.push({ role:'user', parts:[{text}] }); saveBuffer(); }
  function pushModel(text){ conversationHistory.push({ role:'model', parts:[{text}] }); saveBuffer(); }

  // ------- 页面：index -------
  async function bootIndex() {
    // DOM
    const chatWindow = document.getElementById('chat-window');
    const newChatBtn = document.getElementById('new-chat-btn');
    const autoSaveToggle = document.getElementById('auto-save-toggle');
    const historyControls = document.getElementById('history-controls');

    loadBuffer(); // 恢复缓冲
    try { await initCOS(); await loadIndexMap(); } catch(e){ addMsg('System', `**Error:** 初始化失败: ${e.message}`); }

    // 恢复展示或欢迎语
    if (conversationHistory.length) {
      conversationHistory.forEach(msg => addMsg(msg.role==='user'?'NyAme':msg.role==='system'?'System':'Gemini', msg.parts?.[0]?.text||'', false));
    } else {
      addMsg('Gemini', '你好, NyAme。我是 Gemini，准备好开始了吗？', true);
    }

    // pending 输入（input.html 填的）：
    const pending = sessionStorage.getItem('watchai_pending_input') || '';
    if (pending) {
      sessionStorage.removeItem('watchai_pending_input');
      await sendMessage(pending, { chatWindow, autoSaveToggle });
    }

    // pending 加载历史：
    const pendingLoad = sessionStorage.getItem('watchai_pending_load_key') || '';
    if (pendingLoad) {
      sessionStorage.removeItem('watchai_pending_load_key');
      try {
        await loadConversation(pendingLoad);
        chatWindow.innerHTML = '';
        conversationHistory.forEach(msg => addMsg(msg.role==='user'?'NyAme':msg.role==='system'?'System':'Gemini', msg.parts?.[0]?.text||'', false));
      } catch(e) {
        addMsg('System', `**Error:** 载入对话失败: ${e.message}`);
      }
    }

    // 滚动时顶部栏隐藏一点点
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
      saveBuffer();
      addMsg('Gemini', '你好, NyAme。我是 Gemini，准备好开始了吗？', true);
    });

    // 渲染帮助函数
    function addMsg(sender, text, addToBuffer = true){
      const div = document.createElement('div');
      const role = sender.toLowerCase()==='nyame'?'user':sender.toLowerCase()==='system'?'system':'gemini';
      if (addToBuffer && role!=='system') pushUserOrModel(role, text);
      div.className = `message ${role}`;
      div.innerHTML = md(text);
      chatWindow.appendChild(div);
      chatWindow.scrollTop = chatWindow.scrollHeight;
    }
    function pushUserOrModel(role, text){
      const rec = { role: role==='user'?'user':'model', parts:[{text}] };
      conversationHistory.push(rec); saveBuffer();
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
    loadBuffer(); // 只是为了连贯，发送仍走 index
    const ta = document.getElementById('input-textarea');
    const btn = document.getElementById('input-send-btn');

    // 键盘 Enter 发送（手表可能没有回车，保留按钮）
    ta.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        btn.click();
      }
    });

    btn.addEventListener('click', () => {
      const t = (ta.value||'').trim();
      if (!t) { window.location.href = 'index.html'; return; }
      // 放到 sessionStorage，回到 index 再发送
      sessionStorage.setItem('watchai_pending_input', t);
      window.location.href = 'index.html';
    });
  }

  // ------- 页面：history -------
  async function bootHistory(){
    try { await initCOS(); await loadConversationList(); await loadIndexMap(); }
    catch(e){ renderListError(`**Error:** 初始化失败: ${e.message}`); return; }
    renderList();

    function renderListError(msg){
      const list = document.getElementById('history-list');
      list.innerHTML = `<div class="list-empty">${escapeHTML(msg)}</div>`;
    }

    function renderList(){
      const list = document.getElementById('history-list');
      list.innerHTML = '';
      if (!bucketKeys.length) {
        list.innerHTML = `<div class="list-empty">没有保存的对话</div>`;
        return;
      }
      bucketKeys.forEach(k => {
        const row = document.createElement('div'); row.className = 'list-row';
        const item = document.createElement('button'); item.className='list-item';
        item.textContent = indexMap[k] || fmtTime(k.replace('.json',''));
        if (k === (sessionStorage.getItem(SS_KEY_CUR)||'')) item.classList.add('active');
        item.addEventListener('click', () => {
          sessionStorage.setItem('watchai_pending_load_key', k);
          window.location.href = 'index.html';
        });

        const del = document.createElement('button'); del.className = 'list-del small'; del.textContent='删除';
        del.addEventListener('click', async (ev) => {
          ev.stopPropagation();
          const ok = confirm('确定删除该会话？此操作不可恢复。');
          if (!ok) return;
          try { await deleteConversation(k); await loadConversationList(); await loadIndexMap(); renderList(); }
          catch(e){ alert('删除失败: ' + e.message); }
        });

        row.appendChild(item); row.appendChild(del); list.appendChild(row);
      });
    }
  }

  // ------- 启动 -------
  if (PAGE === 'index') bootIndex();
  else if (PAGE === 'input') bootInput();
  else if (PAGE === 'history') bootHistory();
})();
