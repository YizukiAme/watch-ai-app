document.addEventListener('DOMContentLoaded', () => {
  // --- DOM ---
  const historyControls = document.getElementById('history-controls');
  const chatWindow = document.getElementById('chat-window');

  const newChatBtn = document.getElementById('new-chat-btn');
  const loadChatBtn = document.getElementById('load-chat-btn');
  const autoSaveToggle = document.getElementById('auto-save-toggle');

  const composeBtn = document.getElementById('compose-btn');

  const inputModal = document.getElementById('input-modal');
  const modalTextarea = document.getElementById('modal-textarea');
  const modalSendBtn = document.getElementById('modal-send-btn');
  const modalCancelBtn = document.getElementById('modal-cancel-btn');

  const listModal = document.getElementById('list-modal');
  const listCloseBtn = document.getElementById('list-close-btn');
  const conversationList = document.getElementById('conversation-list');

  // --- 状态 ---
  let cos, cosConfig;
  let conversationHistory = [];
  let currentConversationKey = null;
  let lastScrollTop = 0;

  let bucketKeys = []; // 所有会话 key（时间戳.json）
  let indexMap = {};   // meta/watch-index.json: { key: title }

  const INDEX_KEY = 'meta/watch-index.json';

  // --- 模型配置 ---
  const generationConfig = { temperature: 1.0, maxOutputTokens: 65536 };
  const thinkingConfig = { thinkingBudget: 32768 };

  // --- 工具函数 ---
  const fmtTime = (ms) => {
    try { return new Date(parseInt(String(ms), 10)).toLocaleString(); }
    catch { return ms; }
  };

  const sanitize = (t) =>
    (t || '')
      .replace(/```[\s\S]*?```/g, '')
      .replace(/`[^`]*`/g, '')
      .replace(/[#>*_~\[\]\(\)\-!]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

  const guessTitle = () => {
    const lastUser = [...conversationHistory].reverse().find(m => m.role === 'user');
    let base = sanitize(lastUser?.parts?.[0]?.text || '');
    if (!base) {
      const firstUser = conversationHistory.find(m => m.role === 'user');
      base = sanitize(firstUser?.parts?.[0]?.text || '');
    }
    if (!base) return '新对话';
    const limit = /[\u4e00-\u9fa5]/.test(base) ? 16 : 24;
    return base.slice(0, limit);
  };

  const openPanel = (el) => { el.classList.remove('hidden'); updateComposeVisibility(); };
  const closePanel = (el) => { el.classList.add('hidden'); updateComposeVisibility(); };

  const isAtBottom = () =>
    Math.abs(chatWindow.scrollHeight - chatWindow.scrollTop - chatWindow.clientHeight) < 4;

  function updateComposeVisibility() {
    const panelsOpen = !inputModal.classList.contains('hidden') || !listModal.classList.contains('hidden');
    const show = isAtBottom() && !panelsOpen;
    composeBtn.classList.toggle('hidden', !show);
    chatWindow.classList.toggle('has-compose', show); // 仅增加内边距，不画底栏
  }

  // --- 滚动联动：隐藏顶栏 + 控制 Type 按钮显隐 ---
  chatWindow.addEventListener('scroll', () => {
    const scrollTop = chatWindow.scrollTop;
    if (scrollTop > lastScrollTop && scrollTop > 30) historyControls.classList.add('hidden');
    else historyControls.classList.remove('hidden');
    lastScrollTop = scrollTop <= 0 ? 0 : scrollTop;

    updateComposeVisibility();
  });

  // --- 输入面板交互（全屏） ---
  composeBtn.addEventListener('click', () => {
    openPanel(inputModal);
    modalTextarea.focus();
  });
  modalSendBtn.addEventListener('click', () => {
    const text = modalTextarea.value.trim();
    if (text) sendMessage(text);
    modalTextarea.value = '';
    closePanel(inputModal);
  });
  modalCancelBtn.addEventListener('click', () => {
    modalTextarea.value = '';
    closePanel(inputModal);
  });

  // 背景点击：全屏面板下默认不启用点击背景关闭，防误触
  document.querySelectorAll('#input-modal .modal-backdrop, #list-modal .modal-backdrop')
    .forEach((bk) => bk.addEventListener('click', (e) => { /* no-op */ }));

  // --- 历史列表交互（全屏） ---
  loadChatBtn.addEventListener('click', async () => {
    await loadConversationList();
    await loadIndexMap();
    renderConversationList();
    openPanel(listModal);
  });
  listCloseBtn.addEventListener('click', () => closePanel(listModal));

  function renderConversationList() {
    conversationList.innerHTML = '';
    if (!bucketKeys.length) {
      const empty = document.createElement('div');
      empty.className = 'list-empty';
      empty.textContent = '没有保存的对话';
      conversationList.appendChild(empty);
      return;
    }
    bucketKeys.forEach((k) => {
      const row = document.createElement('div');
      row.className = 'list-row';

      const item = document.createElement('button');
      item.className = 'list-item';
      item.dataset.key = k;
      item.textContent = indexMap[k] || fmtTime(k.replace('.json', ''));
      item.addEventListener('click', async () => {
        await loadConversation(k);
        closePanel(listModal);
      });
      if (k === currentConversationKey) item.classList.add('active');

      const del = document.createElement('button');
      del.className = 'list-del';
      del.textContent = '删除';
      del.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const ok = confirm('确定删除该会话？此操作不可恢复。');
        if (!ok) return;
        await deleteConversation(k);
        await loadConversationList();
        await loadIndexMap();
        renderConversationList();
      });

      row.appendChild(item);
      row.appendChild(del);
      conversationList.appendChild(row);
    });
  }

  // --- COS 基础 ---
  async function main() {
    try {
      const credsResponse = await fetch('/api/cos-credentials');
      if (!credsResponse.ok) throw new Error('Failed to fetch credentials');
      const stsData = await credsResponse.json();

      cosConfig = { Bucket: stsData.Bucket, Region: stsData.Region };
      cos = new COS({
        getAuthorization: (options, callback) => {
          callback({
            TmpSecretId: stsData.Credentials.TmpSecretId,
            TmpSecretKey: stsData.Credentials.TmpSecretKey,
            XCosSecurityToken: stsData.Credentials.Token,
            StartTime: Math.round(Date.now() / 1000) - 1,
            ExpiredTime: stsData.ExpiredTime
          });
        }
      });

      await loadConversationList();
      await loadIndexMap();
      startNewChat();
    } catch (error) {
      addMessage('System', `**Error:** 初始化失败: ${error.message}`);
    }
  }

  async function loadConversationList() {
    if (!cos) return;
    try {
      const data = await cos.getBucket({ ...cosConfig, Prefix: '' });
      const list = Array.isArray(data?.Contents) ? data.Contents : [];
      bucketKeys = list
        .map((it) => it.Key)
        .filter((k) => typeof k === 'string' && k.endsWith('.json') && k !== INDEX_KEY)
        .sort((a, b) => parseInt(b) - parseInt(a));
    } catch (e) {
      bucketKeys = [];
      addMessage('System', `**Error:** 读取历史列表失败: ${e.message}`);
    }
  }

  async function loadIndexMap() {
    if (!cos) return (indexMap = {});
    try {
      const data = await cos.getObject({ ...cosConfig, Key: INDEX_KEY });
      const content = data.Body.toString();
      indexMap = JSON.parse(content) || {};
    } catch {
      indexMap = {};
    }
  }

  async function saveIndexMap() {
    if (!cos) return;
    try {
      await cos.putObject({
        ...cosConfig,
        Key: INDEX_KEY,
        Body: JSON.stringify(indexMap)
      });
    } catch (e) {
      addMessage('System', `**Error:** 保存索引失败: ${e.message}`);
    }
  }

  async function deleteConversation(key) {
    if (!cos || !key) return;
    try {
      await cos.deleteObject({ ...cosConfig, Key: key });
      if (indexMap[key]) {
        delete indexMap[key];
        await saveIndexMap();
      }
      if (currentConversationKey === key) startNewChat();
    } catch (e) {
      addMessage('System', `**Error:** 删除失败: ${e.message}`);
    }
  }

  async function loadConversation(key) {
    if (!cos || !key) return;
    try {
      const data = await cos.getObject({ ...cosConfig, Key: key });
      const content = data.Body.toString();
      const loaded = JSON.parse(content);
      currentConversationKey = key;
      conversationHistory = loaded;
      chatWindow.innerHTML = '';
      conversationHistory.forEach((msg) =>
        addMessage(msg.role === 'user' ? 'NyAme' : 'Gemini', msg.parts?.[0]?.text ?? '', false)
      );
      chatWindow.scrollTop = chatWindow.scrollHeight;
      updateComposeVisibility();
    } catch (error) {
      addMessage('System', `**Error:** 载入对话失败: ${error.message}`);
    }
  }

  async function saveConversation() {
    if (!cos || conversationHistory.length < 2) return;
    if (!currentConversationKey) currentConversationKey = `${Date.now()}.json`;
    try {
      await cos.putObject({
        ...cosConfig,
        Key: currentConversationKey,
        Body: JSON.stringify(conversationHistory)
      });
      await loadConversationList();
    } catch (error) {
      addMessage('System', `**Error:** 保存失败: ${error.message}`);
    }
  }

  async function updateTitleMeta() {
    if (!currentConversationKey) return;
    const title = guessTitle();
    if (!title) return;
    indexMap[currentConversationKey] = title;
    await saveIndexMap();
  }

  function startNewChat() {
    chatWindow.innerHTML = '';
    conversationHistory = [];
    currentConversationKey = null;
    addMessage('Gemini', '你好, NyAme。我是 Gemini，准备好开始了吗？');
    updateComposeVisibility();
  }

  function addMessage(sender, text, addToHistory = true) {
    const senderRole = sender.toLowerCase() === 'nyame' ? 'user'
                      : sender.toLowerCase() === 'system' ? 'system'
                      : 'model';
    if (addToHistory && senderRole !== 'system') {
      conversationHistory.push({ role: senderRole === 'user' ? 'user' : 'model', parts: [{ text }] });
    }
    const div = document.createElement('div');
    div.classList.add('message', senderRole === 'user' ? 'user' : senderRole === 'system' ? 'system' : 'gemini');
    div.innerHTML = marked.parse(text);
    chatWindow.appendChild(div);
    chatWindow.scrollTop = chatWindow.scrollHeight;
    updateComposeVisibility();
  }

  async function getGeminiResponse() {
    const response = await fetch('/api/generate-text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationHistory, generationConfig, thinkingConfig })
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(`API Error: ${data.error?.message || JSON.stringify(data) || 'Unknown error'}`);
    }
    return data.text;
  }

  async function sendMessage(userMessage) {
    addMessage('NyAme', userMessage);

    const thinking = document.createElement('div');
    thinking.classList.add('message', 'gemini');
    thinking.textContent = '…';
    chatWindow.appendChild(thinking);
    chatWindow.scrollTop = chatWindow.scrollHeight;
    updateComposeVisibility();

    try {
      const reply = await getGeminiResponse();
      chatWindow.removeChild(thinking);
      addMessage('Gemini', reply);

      if (autoSaveToggle.checked) {
        await saveConversation();
        await updateTitleMeta();
      }
    } catch (error) {
      chatWindow.removeChild(thinking);
      addMessage('System', `**Error:** ${error.message}`);
    }
  }

  // 顶部按钮
  newChatBtn.addEventListener('click', startNewChat);

  // 启动
  main();
});
