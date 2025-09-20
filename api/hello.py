from flask import Flask, jsonify

# Vercel 会寻找一个名为 'app' 的 Flask 实例
app = Flask(__name__)

@app.route('/', defaults={'path': ''})
@app.route('/<path:path>')
def catch_all(path):
    # 这个函数处理所有到 /api/hello 的请求
    return jsonify({
        "message": "Hello from your Python Serverless Function!",
        "your_name": "NyAme"
    })

# 本地调试时可以直接运行 `python api/hello.py`
if __name__ == '__main__':
    app.run(debug=True, port=5001)