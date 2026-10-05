# 自托管

这是实验性个人部署，不是完整生产运维方案。使用自己的域名、应用注册和账号，不直接公开 Python 端口。

1. 创建非特权服务账号及仓库外的 secrets/状态目录，只允许服务账号访问。
2. 复制 `server/.env.example` 到仓库外并填写自己的配置，按 Fleet 文档注册自己的公钥和 OAuth 回调。
3. 加载私有环境，初始化密钥，启动服务。不要将输出令牌写入日志或公共 Issue。

```sh
set -a
. /path/to/private/drivetalk.env
set +a
python server/drivetalk_server.py init-secrets
python server/drivetalk_server.py serve
```

HTTP 服务默认 `127.0.0.1:8788`。需要语音时，在同一私有环境和虚拟环境中另外启动：

```sh
python server/fish_voice.py    # loopback 8790：TTS WebSocket
python server/aliyun_asr.py    # loopback 8791：ASR WebSocket
```

由自己的服务管理器维护进程。HTTPS 代理将 `/v1/vehicle/ai/voice/live` 转到 8790，`/v1/vehicle/ai/asr/live` 转到 8791，其他 `/v1/vehicle/`、`/v1/smarthome/`、OAuth 及健康检查转到 8788。WebSocket 透传 Upgrade/Connection，流式聊天关闭代理缓冲。不记录请求体、cookie、授权头。

构建网页时设置 `VITE_DATA_MODE=backend`，把 `web-dashboard/dist/` 挂到同源 `/dashboard/`。HTTP、SSE、WS 使用同一个 HTTPS 域名，WS 使用 WSS。Android `DRIVETALK_HOME_URL` 指向该 `/dashboard/`。

用自己的移动访问令牌登录，在设置中填入 AI/ASR/TTS 配置。移动令牌与供应商 API Key 不同，不能混用；Fleet 私钥不放进网页。

真实控车须另行部署受信的签名网关及服务端开关。“明确关闭后备箱”的网关扩展未随本源码提供；只有自己的网关实现且验证兼容协议后才启用，不能用重复切换模拟关闭。

家居是可选模块，安装 `server/smarthome/requirements.txt` 后配置登录和设备授权；生成的凭据、设备清单、二维码和加密密钥不得提交 Git。

首次先验证静态文件、TLS、鉴权失败是否被正确拒绝。付费模型或真实设备测试须由部署者明确发起，不把健康检查当作动作测试。
