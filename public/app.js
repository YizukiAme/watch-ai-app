// 统一脚本：根据 body[data-page] 分三种页面执行
(function () {
  const PAGE = document.body && document.body.dataset ? (document.body.dataset.page || 'index') : 'index';

  // ------- 公共状态与工具 -------
  var cos, cosConfig;
  var conversationHistory = [];
  var currentConversationKey = null;
  var bucketKeys = [];
  var indexMap = {};
  var INDEX_KEY = 'meta/watch-index.json';

  var generationConfig = { temperature: 1.0, maxOutputTokens: 65536 };
  var thinkingConfig   = { thinkingBudget: 32768 };

  // ---- 安全转义 ----
  function esc(s){ return String(s||'').replace(/[&<>"']/g,function(m){return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]);}); }

  // ---- 兜底 Markdown 渲染器（不依赖任何库）----
  function miniMarkdown(input){
    var txt = String(input || '');
    txt = esc(txt);
    txt = txt.replace(/```([\s\S]*?)```/g, function(_, code){ return '<pre><code>' + code + '</code></pre>'; });
    txt = txt.replace(/`([^`]+?)`/g, function(_, code){ return '<code>' + code + '</code>'; });
    txt = txt.replace(/\[([^\]]+?)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    txt = txt.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_]+)__/g, '<strong>$1</strong>');
    txt = txt
      .replace(/(^|[\s>])\*([^*\n]+)\*(?=($|[\s<]))/g, '$1<em>$2</em>')
      .replace(/(^|[\s>])_([^_\n]+)_(?=($|[\s<]))/g, '$1<em>$2</em>');

    var lines = txt.split('\n');
    var out = []; var inUL=false, inOL=false, inBQ=false;
    function closeLists(){ if (inUL){ out.push('</ul>'); inUL=false; } if (inOL){ out.push('</ol>'); inOL=false; } }
    function closeBQ(){ if (inBQ){ out.push('</blockquote>'); inBQ=false; } }

    for (var i=0;i<lines.length;i++){
      var line = lines[i];
      var m = line.match(/^(\#{1,6})\s+(.*)$/);
      if (m){ closeLists(); closeBQ(); var level=m[1].length; out.push('<h'+level+'>'+m[2]+'</h'+level+'>'); continue; }
      if (/^>\s?/.test(line)){ closeLists(); if (!inBQ){ out.push('<blockquote>'); inBQ=true; } out.push('<p>'+line.replace(/^>\s?/, '')+'</p>'); continue; } else { closeBQ(); }
      if (/^\s*([-*+])\s+/.test(line)){ if (!inUL){ closeBQ(); if(inOL){out.push('</ol>'); inOL=false;} out.push('<ul>'); inUL=true; } out.push('<li>'+line.replace(/^\s*[-*+]\s+/, '')+'</li>'); continue; }
      else if (inUL && line.trim()===''){ out.push('</ul>'); inUL=false; continue; }
      if (/^\s*\d+\.\s+/.test(line)){ if (!inOL){ closeBQ(); if(inUL){out.push('</ul>'); inUL=false;} out.push('<ol>'); inOL=true; } out.push('<li>'+line.replace(/^\s*\d+\.\s+/, '')+'</li>'); continue; }
      else if (inOL && line.trim()===''){ out.push('</ol>'); inOL=false; continue; }
      if (line.trim()===''){ closeLists(); closeBQ(); continue; }
      closeLists(); out.push('<p>'+line+'</p>');
    }
    closeLists(); closeBQ();
    return out.join('');
  }

  // ---- Markdown & KaTeX：优先用 marked，失败走兜底 ----
  function renderMarkdown(text){
    try {
      var m = window.marked;
      var parse = (m && typeof m.parse === 'function') ? m.parse : (typeof m === 'function') ? m : null;
      if (parse) return parse(String(text == null ? '' : text));
    } catch (e){}
    return miniMarkdown(text);
  }
  function renderMathIn(el){
    if (!el) return;
    if (typeof window.renderMathInElement === 'function'){
      try {
        window.renderMathInElement(el, {
          delimiters: [
            { left: '$$', right: '$$', display: true },
            { left: '$',  right: '$',  display: false },
            { left: '\\(', right: '\\)', display: false },
            { left: '\\[', right: '\\]', display: true }
          ],
          throwOnError: false
        });
      } catch(e){}
    }
  }

  // ---- 其他工具 ----
  function fmtTime(ms){ try { return new Date(parseInt(String(ms),10)).toLocaleString(); } catch (e){ return ms; } }
  function sanitize(t){
    t = String(t||'');
    t = t.replace(/```[\s\S]*?```/g,'').replace(/`[^`]*`/g,'');
    t = t.replace(/[#>*_~\[\]\(\)\-!]/g,'').replace(/\s+/g,' ').trim();
    return t;
  }
  function guessTitle(){
    var lastUser;
    for (var i=conversationHistory.length-1; i>=0; i--){
      if (conversationHistory[i] && conversationHistory[i].role === 'user'){ lastUser = conversationHistory[i]; break; }
    }
    var base = sanitize(lastUser && lastUser.parts && lastUser.parts[0] ? lastUser.parts[0].text : '');
    if (!base){
      for (var j=0;j<conversationHistory.length;j++){
        if (conversationHistory[j] && conversationHistory[j].role === 'user'){
          base = sanitize(conversationHistory[j].parts && conversationHistory[j].parts[0] ? conversationHistory[j].parts[0].text : ''); break;
        }
      }
    }
    if (!base) return '新对话';
    return (/[\u4e00-\u9fa5]/.test(base) ? base.slice(0,16) : base.slice(0,24));
  }

  function b64e(s){ try { return btoa(unescape(encodeURIComponent(s))); } catch(e){ return btoa(s); } }
  function b64d(s){ try { return decodeURIComponent(escape(atob(s))); } catch(e){ try { return atob(s); } catch(e2){ return ''; } } }

  // ---- storage keys ----
  var LS_PENDING_INPUT = 'watchai_pending_input';
  var LS_PENDING_LOAD  = 'watchai_pending_load';
  var LS_CUR_HIST      = 'watchai_cur_history';
  var LS_CUR_KEY       = 'watchai_cur_key';
  var LS_EDIT_INDEX    = 'watchai_edit_index';
  var LS_EDIT_TEXT     = 'watchai_edit_text';

  function saveBufferLS(){
    try {
      localStorage.setItem(LS_CUR_HIST, JSON.stringify(conversationHistory || []));
      localStorage.setItem(LS_CUR_KEY, currentConversationKey || '');
    } catch(e){}
  }
  function loadBufferLS(){
    try {
      var h = JSON.parse(localStorage.getItem(LS_CUR_HIST) || '[]');
      var k = localStorage.getItem(LS_CUR_KEY) || '';
      conversationHistory = Array.isArray(h) ? h : [];
      currentConversationKey = k || null;
    } catch(e){
      conversationHistory = []; currentConversationKey = null;
    }
  }
  function clearBufferLS(){
    try { localStorage.removeItem(LS_CUR_HIST); localStorage.removeItem(LS_CUR_KEY); } catch(e){}
  }

  // COS
  async function initCOS(){
    if (typeof COS !== 'function') throw new Error('COS not defined');
    var res = await fetch('/api/cos-credentials');
    if (!res.ok) throw new Error('Failed to fetch credentials');
    var sts = await res.json();
    cosConfig = { Bucket: sts.Bucket, Region: sts.Region };
    cos = new COS({
      getAuthorization: function(_, cb){
        cb({
          TmpSecretId: sts.Credentials.TmpSecretId,
          TmpSecretKey: sts.Credentials.TmpSecretKey,
          XCosSecurityToken: sts.Credentials.Token,
          StartTime: Math.round(Date.now()/1000)-1,
          ExpiredTime: sts.ExpiredTime
        });
      }
    });
  }

  async function loadConversationList(){
    if (!cos){ bucketKeys=[]; return; }
    var data = await cos.getBucket(Object.assign({}, cosConfig, { Prefix: '' }));
    var list = Array.isArray(data && data.Contents) ? data.Contents : [];
    bucketKeys = list
      .map(function(it){ return it.Key; })
      .filter(function(k){ return typeof k === 'string' && k.endsWith('.json') && k !== INDEX_KEY; })
      .sort(function(a,b){ return parseInt(b)-parseInt(a); });
  }

  async function loadIndexMap(){
    if (!cos){ indexMap={}; return; }
    try {
      var data = await cos.getObject(Object.assign({}, cosConfig, { Key: INDEX_KEY }));
      indexMap = JSON.parse(data.Body.toString() || '{}') || {};
    } catch(e){ indexMap = {}; }
  }

  async function saveIndexMap(){
    if (!cos) return;
    await cos.putObject(Object.assign({}, cosConfig, { Key: INDEX_KEY, Body: JSON.stringify(indexMap) }));
  }

  async function saveConversation(){
    if (!cos || conversationHistory.length < 2) return;
    if (!currentConversationKey) currentConversationKey = String(Date.now()) + '.json';
    await cos.putObject(Object.assign({}, cosConfig, { Key: currentConversationKey, Body: JSON.stringify(conversationHistory) }));
    var title = guessTitle();
    if (title){ indexMap[currentConversationKey] = title; await saveIndexMap(); }
    saveBufferLS();
  }

  async function deleteConversation(key){
    if (!cos || !key) return;
    await cos.deleteObject(Object.assign({}, cosConfig, { Key: key }));
    if (indexMap[key]){ delete indexMap[key]; await saveIndexMap(); }
    if (currentConversationKey === key){
      currentConversationKey = null; conversationHistory = []; saveBufferLS();
    }
  }

  async function loadConversation(key){
    if (!cos || !key) return;
    var data = await cos.getObject(Object.assign({}, cosConfig, { Key: key }));
    var loaded = JSON.parse(data.Body.toString());
    currentConversationKey = key;
    conversationHistory = Array.isArray(loaded) ? loaded : [];
    saveBufferLS();
  }

  async function modelReply(){
    var res = await fetch('/api/generate-text', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ conversationHistory: conversationHistory, generationConfig: generationConfig, thinkingConfig: thinkingConfig })
    });
    var data = await res.json();
    if (!res.ok) throw new Error((data && data.error && data.error.message) || JSON.stringify(data) || 'API error');
    return data.text || '';
  }

  // 流式：优先走 /api/stream，失败再退回非流式
  async function streamReply(onDelta){
    const res = await fetch('/api/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationHistory: conversationHistory, generationConfig: generationConfig, thinkingConfig: thinkingConfig })
    });
    if (!res.ok || !res.body) throw new Error('Stream init failed');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // 处理 SSE：按行解析
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        // 兼容两种：`data: {...}` 或直接 `{...}`
        let jsonStr = '';
        if (line.startsWith('data:')) jsonStr = line.slice(5).trim();
        else if (line.startsWith('{')) jsonStr = line;
        if (!jsonStr) continue;
        if (jsonStr === '[DONE]') continue;
        try {
          const obj = JSON.parse(jsonStr);
          // 从任意结构里尽量抓到文本增量
          const delta = extractTextDelta(obj);
          if (delta) onDelta(delta);
        } catch (_) {
          // 有些实现会发纯文本增量
          if (line && !line.startsWith('event:')) onDelta(line);
        }
      }
    }
  }

  function extractTextDelta(obj){
    // 常见结构：candidates[0].content.parts[].text
    try {
      if (obj && obj.candidates && obj.candidates[0] && obj.candidates[0].content && Array.isArray(obj.candidates[0].content.parts)) {
        return obj.candidates[0].content.parts.map(p => p && p.text ? String(p.text) : '').join('');
      }
    } catch(_) {}
    // 兜底
    if (obj && typeof obj.text === 'string') return obj.text;
    return '';
  }

  function pushUser(text){ conversationHistory.push({ role:'user', parts:[{text:text}] }); saveBufferLS(); }
  function pushModel(text){ conversationHistory.push({ role:'model', parts:[{text:text}] }); saveBufferLS(); }

  // ------- 页面：index -------
  async function bootIndex(){
    var chatWindow = document.getElementById('chat-window');
    var newChatBtn = document.getElementById('new-chat-btn');
    var autoSaveToggle = document.getElementById('auto-save-toggle');
    var historyControls = document.getElementById('history-controls');

    // URL 意图
    var params = new URLSearchParams((location.hash || '').replace(/^#/, ''));
    var hasLoadIntent = params.has('load');
    var hasSendIntent = params.has('send');
    var hasEditIntent = params.has('edit'); // 来自 input 的编辑重发
    var resetIntent   = params.has('reset');

    if (resetIntent) { clearBufferLS(); }
    if (!hasLoadIntent && !hasSendIntent && !hasEditIntent) { clearBufferLS(); } // 冷启动默认新会话

    loadBufferLS();

    try { await initCOS(); await loadIndexMap(); }
    catch(e){ addMsg('System', '**Error:** 初始化失败: ' + e.message); }

    var pendingSend = hasSendIntent ? b64d(params.get('send') || '') : '';
    var pendingLoad = hasLoadIntent ? (params.get('load') || '') : '';

    // 编辑场景：从 localStorage 取编辑位和文本
    var editIndex = -1, editText = '';
    if (hasEditIntent){
      try {
        editIndex = parseInt(localStorage.getItem(LS_EDIT_INDEX) || '-1', 10);
        editText  = localStorage.getItem(LS_EDIT_TEXT) || '';
        localStorage.removeItem(LS_EDIT_INDEX);
        localStorage.removeItem(LS_EDIT_TEXT);
      } catch(_){}
    }

    if (!pendingSend){ try { pendingSend = localStorage.getItem(LS_PENDING_INPUT) || ''; localStorage.removeItem(LS_PENDING_INPUT); } catch(e){} }
    if (location.hash) history.replaceState(null, '', location.pathname);

    // 展示当前缓冲或欢迎语
    if (conversationHistory.length){
      for (var i=0;i<conversationHistory.length;i++){
        var msg = conversationHistory[i];
        addMsg(msg.role==='user'?'NyAme':(msg.role==='system'?'System':'Gemini'), (msg.parts && msg.parts[0] ? msg.parts[0].text : ''), false, i);
      }
    } else {
      addMsg('Gemini', '你好, NyAme。我是 Gemini，准备好开始了吗？', true, -1);
      saveBufferLS();
    }

    // 先加载历史
    if (pendingLoad && cos){
      try {
        await loadConversation(pendingLoad);
        chatWindow.innerHTML = '';
        for (var j=0;j<conversationHistory.length;j++){
          var m2 = conversationHistory[j];
          addMsg(m2.role==='user'?'NyAme':(m2.role==='system'?'System':'Gemini'), (m2.parts && m2.parts[0] ? m2.parts[0].text : ''), false, j);
        }
      } catch(e){ addMsg('System', '**Error:** 载入对话失败: ' + e.message); }
    }

    // 然后处理编辑
    if (hasEditIntent && editIndex >= 0 && editText){
      // 只允许编辑“用户消息”，并截断后续（覆盖历史）
      if (conversationHistory[editIndex] && conversationHistory[editIndex].role === 'user'){
        conversationHistory = conversationHistory.slice(0, editIndex);
        saveBufferLS();
        chatWindow.innerHTML = '';
        for (var k=0;k<conversationHistory.length;k++){
          var m3 = conversationHistory[k];
          addMsg(m3.role==='user'?'NyAme':(m3.role==='system'?'System':'Gemini'), (m3.parts && m3.parts[0] ? m3.parts[0].text : ''), false, k);
        }
        await sendMessage(editText, { chatWindow: chatWindow, autoSaveToggle: autoSaveToggle }, /*stream*/ true);
      } else {
        addMsg('System', '**Error:** 无法编辑：指定位置不是用户消息', false, -1);
      }
    }

    // 最后处理普通发送
    if (pendingSend){
      await sendMessage(pendingSend, { chatWindow: chatWindow, autoSaveToggle: autoSaveToggle }, /*stream*/ true);
    }

    // 顶部胶囊微隐藏
    var last = 0;
    chatWindow.addEventListener('scroll', function(){
      var st = chatWindow.scrollTop || 0;
      if (st > last && st > 30) historyControls.classList.add('hidden');
      else historyControls.classList.remove('hidden');
      last = Math.max(0, st);
    }, { passive:true });

    newChatBtn.addEventListener('click', function(){
      chatWindow.innerHTML = '';
      conversationHistory = [];
      currentConversationKey = null;
      clearBufferLS();
      addMsg('Gemini', '你好, NyAme。我是 Gemini，准备好开始了吗？', true, -1);
      saveBufferLS();
    });

    function addMsg(sender, text, addToBuffer, indexForEdit){
      if (addToBuffer === void 0) addToBuffer = true;
      var div = document.createElement('div');
      var role = (String(sender||'').toLowerCase()==='nyame')?'user':(String(sender||'').toLowerCase()==='system'?'system':'gemini');
      if (addToBuffer && role!=='system'){
        conversationHistory.push({ role: role==='user'?'user':'model', parts:[{text:text}] });
        saveBufferLS();
        indexForEdit = conversationHistory.length - 1;
      }
      div.className = 'message ' + role;
      // 给用户消息加“点一下就编辑”的入口
      if (role === 'user' && typeof indexForEdit === 'number' && indexForEdit >= 0) {
        div.dataset.index = String(indexForEdit);
        div.addEventListener('click', function(){
          // 跳到 input.html 的编辑模式
          var idx = this.dataset.index || '0';
          try { localStorage.setItem(LS_EDIT_INDEX, idx); localStorage.setItem(LS_EDIT_TEXT, text); } catch(_){}
          window.location.href = 'input.html#edit=' + encodeURIComponent(idx);
        });
      }
      div.innerHTML = renderMarkdown(text);
      renderMathIn(div);
      chatWindow.appendChild(div);
      chatWindow.scrollTop = chatWindow.scrollHeight;
      return div;
    }

    async function sendMessage(userText, env, useStream){
      // 插入用户气泡
      const userDiv = addMsg('NyAme', userText, false, -1); pushUser(userText);

      // 占位的模型气泡
      const modelDiv = document.createElement('div');
      modelDiv.className = 'message gemini';
      modelDiv.innerHTML = '…';
      env.chatWindow.appendChild(modelDiv);
      env.chatWindow.scrollTop = env.chatWindow.scrollHeight;

      try {
        if (useStream) {
          let acc = '';
          await streamReply(function(delta){
            acc += String(delta || '');
            // 边流边渲染
            modelDiv.innerHTML = renderMarkdown(acc);
            renderMathIn(modelDiv);
            env.chatWindow.scrollTop = env.chatWindow.scrollHeight;
          });
          pushModel(acc);
        } else {
          const reply = await modelReply();
          modelDiv.innerHTML = renderMarkdown(reply);
          renderMathIn(modelDiv);
          pushModel(reply);
        }
        var autoSave = document.getElementById('auto-save-toggle');
        if (autoSave && autoSave.checked && cos){ await saveConversation(); }
      } catch(e){
        modelDiv.innerHTML = esc('**Error:** ' + e.message);
      }
    }
  }

  // ------- 页面：input -------
  function bootInput(){
    var ta = document.getElementById('input-textarea');
    var btn = document.getElementById('input-send-btn');
    var params = new URLSearchParams((location.hash || '').replace(/^#/, ''));
    var editMode = params.has('edit');
    if (editMode){
      // 预填编辑内容
      try {
        var t = localStorage.getItem('watchai_edit_text') || '';
        if (t) ta.value = t;
        btn.textContent = '更新并发送';
      } catch(_) {}
    }

    btn.addEventListener('click', function(){
      var t = (ta && ta.value ? ta.value : '').trim();
      if (!t){
        window.location.href = 'index.html'; return;
      }
      if (editMode){
        // 把编辑位与文本放回去，然后回主页触发 #edit
        try { localStorage.setItem('watchai_edit_text', t); } catch(_){}
        window.location.href = 'index.html#edit=1';
      } else {
        try { localStorage.setItem('watchai_pending_input', t); } catch(_){}
        var payload = encodeURIComponent(b64e(t));
        window.location.href = 'index.html#send=' + payload;
      }
    });

    ta.addEventListener('keydown', function(e){
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') btn.click();
    });
  }

  // ------- 页面：history -------
  async function bootHistory(){
    var listEl = document.getElementById('history-list');
    try { await initCOS(); await loadConversationList(); await loadIndexMap(); }
    catch(e){ listEl.innerHTML = '<div class="list-empty">'+esc('**Error:** '+e.message)+'</div>'; return; }

    if (!bucketKeys.length){ listEl.innerHTML = '<div class="list-empty">没有保存的对话</div>'; return; }

    bucketKeys.forEach(function(k){
      var row = document.createElement('div'); row.className = 'list-row';

      var a = document.createElement('a');
      a.className = 'list-item';
      a.href = 'index.html#load=' + encodeURIComponent(k);
      a.textContent = indexMap[k] || fmtTime(k.replace('.json',''));

      var del = document.createElement('button'); del.className = 'list-del small'; del.textContent = '删除';
      del.addEventListener('click', async function(ev){
        ev.preventDefault(); ev.stopPropagation();
        var ok = window.confirm('确定删除该会话？此操作不可恢复。');
        if (!ok) return;
        try {
          await deleteConversation(k);
          await loadConversationList(); await loadIndexMap();
          row.remove();
          if (!listEl.childElementCount) listEl.innerHTML = '<div class="list-empty">没有保存的对话</div>';
        } catch(e){ window.alert('删除失败: ' + e.message); }
      });

      row.appendChild(a); row.appendChild(del); listEl.appendChild(row);
    });
  }

  // ------- 启动 -------
  if (PAGE === 'index') { bootIndex(); }
  else if (PAGE === 'input') { bootInput(); }
  else if (PAGE === 'history') { bootHistory(); }
})();
