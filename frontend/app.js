document.addEventListener('DOMContentLoaded', () => {
    const chatWindow = document.getElementById('chat-window');
    const inputForm = document.getElementById('input-form');
    const messageInput = document.getElementById('message-input');

    // 模拟添加一条消息
    function addMessage(sender, text) {
        const messageDiv = document.createElement('div');
        messageDiv.classList.add('message', sender.toLowerCase());
        // 使用 marked.js 渲染 Markdown
        messageDiv.innerHTML = marked.parse(text);
        chatWindow.appendChild(messageDiv);
        // 滚动到底部
        chatWindow.scrollTop = chatWindow.scrollHeight;
    }

    // 监听表单提交
    inputForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const userMessage = messageInput.value.trim();
        if (userMessage) {
            addMessage('NyAme', userMessage); // 显示用户自己的消息
            messageInput.value = '';

            // TODO: 在这里调用 Gemini API
            // 模拟 Gemini 回复
            setTimeout(() => {
                addMessage('Gemini', `你刚才说的是：**"${userMessage}"**`);
            }, 1000);
        }
    });

    // 初始化时显示欢迎语
    addMessage('Gemini', '你好, NyAme。准备好开始了吗？');
});