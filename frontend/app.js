document.addEventListener('DOMContentLoaded', () => {
    const autoSaveToggle = document.getElementById('auto-save-toggle');
    const chatWindow = document.getElementById('chat-window');
    const inputForm = document.getElementById('input-form');
    const messageInput = document.getElementById('message-input');
    const conversationSelector = document.getElementById('conversation-selector');
    const newChatBtn = document.getElementById('new-chat-btn');

    // --- State Management & Configuration ---
    let cos, cosConfig;
    let conversationHistory = [];
    let currentConversationKey = null;

    // Configure the generation parameters
    const generationConfig = {
        temperature: 1.0,
        maxOutputTokens: 65536, // Increased for the more powerful model
    };

    // Configure the new thinking parameters
    const thinkingConfig = {
        thinkingBudget: 32768, 
    };

    // The new, configurable way to call the AI
    async function getGeminiResponse() {
        const response = await fetch('/api/generate-text', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                conversationHistory,
                generationConfig: generationConfig,
                thinkingConfig: thinkingConfig // Send the new config to the backend
            }),
        });

        const data = await response.json();
        if (!response.ok) {
            throw new Error(`API Error: ${data.error?.message || 'Unknown error'}`);
        }
        return data.text;
    }

    inputForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const userMessage = messageInput.value.trim();
        if (!userMessage) return;

        addMessage('NyAme', userMessage);
        messageInput.value = '';
        messageInput.disabled = true;

        const thinkingMessage = document.createElement('div');
        thinkingMessage.classList.add('message', 'gemini');
        thinkingMessage.innerText = '...';
        chatWindow.appendChild(thinkingMessage);
        chatWindow.scrollTop = chatWindow.scrollHeight;

        try {
            const geminiResponseText = await getGeminiResponse();
            chatWindow.removeChild(thinkingMessage);
            addMessage('Gemini', geminiResponseText);

            if (autoSaveToggle.checked) {
                await saveConversation();
            }

        } catch (error) {
            chatWindow.removeChild(thinkingMessage);
            addMessage('System', `**Error:** ${error.message}`);
        } finally {
            messageInput.disabled = false;
            messageInput.focus();
        }
    });
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

    async function saveConversation() {
        if (!cos || conversationHistory.length < 2) return;
        if (!currentConversationKey) {
            currentConversationKey = `${Date.now()}.json`;
        }
        try {
            await cos.putObject({
                ...cosConfig,
                Key: currentConversationKey,
                Body: JSON.stringify(conversationHistory),
            });
            // Check if the option already exists before reloading the entire list
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

    function startNewChat() {
        chatWindow.innerHTML = '';
        conversationHistory = [];
        currentConversationKey = null;
        conversationSelector.value = "";
        const welcomeMessage = "你好, NyAme。";
        addMessage('Gemini', welcomeMessage);
    }

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

    conversationSelector.addEventListener('change', (e) => loadConversation(e.target.value));
    newChatBtn.addEventListener('click', startNewChat);

    main();
});