// 文件: api/cos-credentials.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { sts } from 'tencentcloud-sdk-nodejs';

const StsClient = sts.v20180813.Client;

// 从环境变量中读取所有必需的配置
const {
    TENCENT_COS_SECRET_ID,
    TENCENT_COS_SECRET_KEY,
    TENCENT_COS_BUCKET_NAME,
    TENCENT_COS_REGION,
    TENCENT_APP_ID // 我们新的、可靠的 APPID
} = process.env;

export default async function handler(req: VercelRequest, res: VercelResponse) {
    // 检查所有环境变量是否都已配置
    if (!TENCENT_COS_SECRET_ID || !TENCENT_COS_SECRET_KEY || !TENCENT_COS_BUCKET_NAME || !TENCENT_COS_REGION || !TENCENT_APP_ID) {
        return res.status(500).json({ error: "Server environment variables for COS are not fully configured." });
    }

    // 这是最稳健的策略写法：将存储桶级操作和对象级操作的资源分开定义
    const policy = {
        'version': '2.0',
        'statement': [
            {
                // 权限1：允许列出存储桶中的对象 (e.g., 获取对话列表)
                'action': [
                    'cos:GetBucket'
                ],
                'effect': 'allow',
                // 资源路径指向存储桶本身
                'resource': [`qcs::cos:${TENCENT_COS_REGION}:uid/${TENCENT_APP_ID}:${TENCENT_COS_BUCKET_NAME}/`],
            },
            {
                // 权限2：允许对存储桶中的任何对象进行读写 (e.g., 读取/保存对话记录)
                'action': [
                    'cos:GetObject',
                    'cos:PutObject',
                    'cos:DeleteObject',
                ],
                'effect': 'allow',
                // 资源路径指向存储桶内的所有对象
                'resource': [`qcs::cos:${TENCENT_COS_REGION}:uid/${TENCENT_APP_ID}:${TENCENT_COS_BUCKET_NAME}/*`],
            },
        ],
    };

    const client = new StsClient({
        credential: { secretId: TENCENT_COS_SECRET_ID, secretKey: TENCENT_COS_SECRET_KEY },
        region: TENCENT_COS_REGION,
        profile: { httpProfile: { endpoint: "sts.tencentcloudapi.com" } },
    });

    try {
        const data = await client.GetFederationToken({
            Name: "watch-ai-app-user",
            Policy: JSON.stringify(policy),
            DurationSeconds: 1800, // 30分钟有效期
        });
            // 在返回的数据中，附加上前端需要的公开配置信息
        return res.status(200).json({
            ...data, // 包含 Credentials, ExpiredTime 等
            Bucket: TENCENT_COS_BUCKET_NAME, // 新增
            Region: TENCENT_COS_REGION,       // 新增
        });
        
    } catch (error: any) {
        console.error("Error fetching Tencent STS credentials:", error);
        return res.status(500).json({ error: error.message || "An unexpected error occurred." });
    }
}