# DriveTalk

自托管车辆、语音助手和智能家居控制台：React + TypeScript、Python、Android WebView。

本项目独立于车辆、家居及 AI 服务供应商，并非其官方产品。默认使用合成 Mock 数据，不附带账号权限、私人配置或专有车模。原创代码使用 **GPL-3.0-or-later**；第三方依赖保留各自许可，见 [LICENSE](LICENSE) 和 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 功能与边界

- 车辆状态快照、电量、胎压、温度、位置及显式命令；读取不自动唤醒，结果未知时不重发动作。
- 通用几何体 3D 展示和触摸旋转，不包含厂商 App 提取模型、纹理或动画。
- DeepSeek 流式文本、工具调用和家居指令澄清；可选 Android 本机 Grok 聊天通道。
- 阿里云百炼流式 ASR、Fish Audio 朗读、分句和音频队列。文本请求与语音连接并行准备，实际延迟受网络及供应商影响。
- 前台连续对话、手机 GPS；朗读期间暂停收音，并非全双工语音插话。
- 米家登录、设备发现、MCP 桥接、限流和状态回读。Home Assistant 后端是预留骨架，摄像头专有视频流不保证支持。

真实服务需要自行申请账号、应用和权限。命令受理不等于物理动作完成，不能替代车辆安全功能及现场确认。

## 目录

```text
web-dashboard/    React 界面、Mock、测试
mobile/           Android 外壳及麦克风/GPS 桥接
server/           Python 鉴权、Fleet、AI、ASR、TTS
  smarthome/      设备发现、凭据加密、MCP、适配器
scripts/          发布隐私检查
docs/             自托管说明
```

## 运行 Mock

需要 Node.js 22.18+（推荐 24）与 pnpm。依赖安装需要网络，Mock 不调用付费模型或真实设备。

```sh
cd web-dashboard
pnpm install --frozen-lockfile
cp .env.example .env.local
pnpm dev
```

访问开发地址的 `/dashboard/`。模板默认 `VITE_DATA_MODE=mock`。不要将服务端秘密填入 `VITE_*`，它们会被写入网页产物。

```sh
pnpm test
pnpm build
```

## 后端

Python 3.11+，使用独立虚拟环境：

```sh
python -m venv .venv
. .venv/bin/activate
python -m pip install -r server/requirements-voice.txt
python -B -m unittest discover -s server -p 'test_*.py'
```

按需安装 `server/smarthome/requirements.txt`；缺少可选 MCP SDK 时对应测试会明确跳过。测试仅使用 Mock/loopback，不代表真实服务验证。

参考 `server/.env.example` 与 [自托管说明](docs/SELF_HOSTING.md)。真实配置、私钥、访问令牌、OAuth 数据库及米家凭据须保存在仓库外。后端默认 loopback，仅通过自己的同源 HTTPS 代理公开。

## Android

包名 **`org.drivetalk.app`**，应用名 **DriveTalk**，不覆盖其他私人安装。需要 Android SDK 36、Java 17+、Gradle 9.5.0；不附带签名 APK、签名密钥或 Gradle wrapper 二进制。

```sh
gradle :mobile:testDebugUnitTest :mobile:assembleDebug \
  -PDRIVETALK_HOME_URL=https://your-domain.example/dashboard/
```

将示例域名换为自己的 HTTPS 地址。原生桥接仅允许配置来源和路径，不关闭 TLS 校验。当前桥接支持云端 PCM 流；Vosk 本地备用源码保留，但默认关闭且不附带模型。如需启用，自行取得许可允许使用的 `vosk-model-small-cn-0.22`，放到 `mobile/src/main/assets/`，设置 `-PDRIVETALK_OFFLINE_ASR=true`。该资产目录被 Git 忽略。

## 安全与开源范围

真实控车/控家服务默认关闭，对话页也要求显式授权。公开树不携带原部署的用户身份、域名、设备标识、聊天、定位、密钥、日志或旧 Git 历史。保留必要的供应商协议名及第三方归属，不表示官方合作。

只发布源代码；如再分发 JS bundle、APK、容器，必须补齐实际依赖许可及对应源码。验证边界见 [检查记录](SANITIZATION_REPORT.md)。提交前运行 `python scripts/check_publication.py`，阅读 [SECURITY.md](SECURITY.md) 和 [贡献说明](CONTRIBUTING.md)。扫描不能保证绝对无泄露，仍需人工审核。
