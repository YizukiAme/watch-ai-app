document.addEventListener('DOMContentLoaded', () => {
    // --- DOM 元素 ---
    const historyControls = document.getElementById('history-controls');
    const chatWindow = document.getElementById('chat-window');
    const conversationSelector = document.getElementById('conversation-selector');
    const newChatBtn = document.getElementById('new-chat-btn');
    const loadChatBtn = document.getElementById('load-chat-btn');
    const autoSaveToggle = document.getElementById('auto-save-toggle');
    
    // 新增的UI元素
    const fabInputBtn = document.getElementById('fab-input-btn');
    const inputModal = document.getElementById('input-modal');
    const modalTextarea = document.getElementById('modal-textarea');
    const modalSendBtn = document.getElementById('modal-send-btn');
    const modalBackdrop = document.querySelector('.modal-backdrop');

    // --- 状态管理与配置 ---
    let cos, cosConfig;
    let conversationHistory = [];
    let currentConversationKey = null;
    let lastScrollTop = 0; // 用于滚动检测

    // 大模型配置
    const generationConfig = {
        temperature: 1.0,
        maxOutputTokens: 65536,
    };
    const thinkingConfig = {
        thinkingBudget: 32768,
    };

    // --- 核心交互逻辑 ---

    // 1. 根据滚动自动隐藏/显示顶部控制栏
    chatWindow.addEventListener('scroll', () => {
        let scrollTop = chatWindow.scrollTop;
        // 向下滚动超过50px时隐藏
        if (scrollTop > lastScrollTop && scrollTop > 50) {
            historyControls.classList.add('hidden');
        } else { // 向上滚动时显示
            historyControls.classList.remove('hidden');
        }
        lastScrollTop = scrollTop <= 0 ? 0 : scrollTop; // 处理滚动到顶部的情况
    });

    // 2. 悬浮按钮与模态框交互
    fabInputBtn.addEventListener('dblclick', () => {
        inputModal.classList.remove('hidden');
        modalTextarea.focus(); // 自动聚焦到输入框
    });
    
    function hideModal() {
        inputModal.classList.add('hidden');
        modalTextarea.value = ''; // 关闭时清空输入框
    }

    modalSendBtn.addEventListener('click', () => {
        const userMessage = modalTextarea.value.trim();
        if (userMessage) {
            sendMessage(userMessage);
        }
        hideModal();
    });
    
    modalBackdrop.addEventListener('click', hideModal); // 点击模态框背景关闭

    // 3. 自定义按钮触发隐藏的<select>下拉框
    loadChatBtn.addEventListener('click', () => {
        conversationSelector.click();
    });

    // --- 主要功能函数 ---

    /**
     * 应用主入口函数
     */
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
                        ExpiredTime: stsData.ExpiredTime,
                    });
                }
            });
            await loadConversationList();
            startNewChat();
        } catch (error) {
            addMessage('System', `**Error:** Failed to initialize. ${error.message}`);
        }
    }

    /**
     * 从COS加载对话列表并填充下拉框
     */
    async function loadConversationList() {
        if (!cos) return;
        const data = await cos.getBucket({ ...cosConfig, Prefix: '' });
        conversationSelector.innerHTML = '<option value="">Load a conversation...</option>';
        data.Contents.filter(item => item.Key.endsWith('.json')).forEach(item => {
            const option = document.createElement('option');
            option.value = item.Key;
            option.textContent = new Date(parseInt(item.Key.replace('.json', ''))).toLocaleString();
            conversationSelector.appendChild(option);
        });
    }

    /**
     * 从COS加载指定的对话历史
     * @param {string} key - 对话文件的key
     */
    async function loadConversation(key) {
        if (!cos || !key) return;
        try {
            const data = await cos.getObject({ ...cosConfig, Key: key });
            const content = data.Body.toString();
            const loadedHistory = JSON.parse(content);
            currentConversationKey = key;
            conversationHistory = loadedHistory;
            chatWindow.innerHTML = '';
            conversationHistory.forEach(msg => addMessage(msg.role === 'user' ? 'NyAme' : 'Gemini', msg.parts[0].text, false));
        } catch (error) {
            addMessage('System', `**Error:** Could not load conversation. ${error.message}`);
        }
    }

    /**
     * 将当前对话历史保存到COS
     */
    async function saveConversation() {
        if (!cos || conversationHistory.length < 2) return;
        if (!currentConversationKey) {
            currentConversationKey = `${Date.now()}.json`;
        }
        try {
            await cos.putObject({ ...cosConfig, Key: currentConversationKey, Body: JSON.stringify(conversationHistory) });
            // 检查下拉框中是否已存在该选项，避免重复加载
            let exists = false;
            for(let i=0; i<conversationSelector.options.length; i++){
                if(conversationSelector.options[i].value === currentConversationKey) {
                    exists = true;
                    break;
                }
            }
            if(!exists) {
                await loadConversationList();
                conversationSelector.value = currentConversationKey;
            }
        } catch (error) {
            addMessage('System', `**Error:** Could not save conversation. ${error.message}`);
        }
    }

    /**
     * 开始一个新对话
     */
    function startNewChat() {
        chatWindow.innerHTML = '';
        conversationHistory = [];
        currentConversationKey = null;
        conversationSelector.value = "";
        const welcomeMessage = "你好, NyAme。我是 Gemini，准备好开始了吗？";
        addMessage('Gemini', welcomeMessage);
    }

    /**
     * 向聊天窗口添加消息
     * @param {string} sender - 'NyAme', 'Gemini', 或 'System'
     * @param {string} text - 消息内容
     * @param {boolean} addToHistory - 是否将消息添加到历史记录中
     */
    function addMessage(sender, text, addToHistory = true) {
        const senderRole = sender.toLowerCase() === 'nyame' ? 'user' : 'model';
        if (addToHistory && sender !== 'System') {
            conversationHistory.push({ role: senderRole, parts: [{ text }] });
        }
        const messageDiv = document.createElement('div');
        messageDiv.classList.add('message', sender.toLowerCase());
        messageDiv.innerHTML = marked.parse(text);
        chatWindow.appendChild(messageDiv);
        chatWindow.scrollTop = chatWindow.scrollHeight;
    }

    /**
     * 调用后端API以获取Gemini的回复
     * @returns {Promise<string>} - Gemini返回的文本
     */
    async function getGeminiResponse() {
        const response = await fetch('/api/generate-text', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ conversationHistory, generationConfig, thinkingConfig }),
        });
        const data = await response.json();
        if (!response.ok) {
            throw new Error(`API Error: ${data.error?.message || 'Unknown error'}`);
        }
        return data.text;
    }

    /**
     * 核心的消息发送流程
     * @param {string} userMessage - 用户输入的消息
     */
    async function sendMessage(userMessage) {
        addMessage('NyAme', userMessage);
        
        // 显示"思考中"的提示
        const thinkingMessage = document.createElement('div');
        thinkingMessage.classList.add('message', 'gemini');
        thinkingMessage.innerText = '...';
        chatWindow.appendChild(thinkingMessage);
        chatWindow.scrollTop = chatWindow.scrollHeight;

        try {
            const geminiResponseText = await getGeminiResponse();
            chatWindow.removeChild(thinkingMessage);
            addMessage('Gemini', geminiResponseText);
            
            // 根据开关状态决定是否保存
            if (autoSaveToggle.checked) {
                await saveConversation();
            }
        } catch (error) {
            chatWindow.removeChild(thinkingMessage);
            addMessage('System', `**Error:** ${error.message}`);
        }
    }

    // --- 绑定基础事件监听器 ---
    conversationSelector.addEventListener('change', (e) => loadConversation(e.target.value));
    newChatBtn.addEventListener('click', startNewChat);

    // --- 启动应用 ---
    main();
});
