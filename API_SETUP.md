# Drive Talk 接入教程：准备什么、申请哪些 API、怎么接入

这份教程对应本仓库公开源码，而不是某个已经配好账号的私人部署。**源码不附带 API Key、Tesla 权限、米家登录、服务器或现成签名 APK。** 先运行 Mock，再按需要逐项接入；每接通一项再开下一项，便于排错。

供应商入口、模型和收费可能变化。申请流程按 2026-10-05 查阅的官方资料整理，具体权限与价格以自己的控制台为准。本文所有域名、路径与配置占位符都需要换成自己的，不要直接照填示例域名。

## 导航

- [一、按功能准备账号与凭据](#checklist)
- [二、先部署自己的 HTTPS 服务](#hosting)
- [三、Tesla Fleet API：注册、车主授权、车辆配对](#tesla)
- [四、DeepSeek：文本、工具调用与控车](#deepseek)
- [五、阿里云百炼：流式语音识别 ASR](#asr)
- [六、Fish Audio：音色与语音朗读 TTS](#tts)
- [七、Grok：Android 手机直连聊天](#grok)
- [八、高德地图：JSAPI Key 与安全密钥](#amap)
- [九、米家：扫码发现设备与控家](#xiaomi)
- [十、Home Assistant 与尚未开放的功能](#future)
- [十一、手机安装、权限、费用与排错](#troubleshooting)

<a id="checklist"></a>

## 一、按功能准备账号与凭据

| 想使用的功能 | 要准备什么 | 去哪里申请 / 获取 | 填到哪里 |
| --- | --- | --- | --- |
| 只体验界面和模拟交互 | Node.js、pnpm | 无需任何 API | `VITE_DATA_MODE=mock` |
| 读取真实车辆数据 | 自有域名、HTTPS、Tesla 开发者应用、车主账号 | [Tesla 开发者平台](https://developer.tesla.com/) | 服务端 Tesla 环境配置，再完成 OAuth |
| 真实控车 | 上述条件 + P-256 密钥、虚拟钥匙、签名网关 | [Tesla Vehicle Command SDK](https://github.com/teslamotors/vehicle-command) | 服务端签名代理配置 |
| DeepSeek 对话和工具控车 / 控家 | DeepSeek API Key、可用模型 ID、API 余额 | [DeepSeek API 控制台](https://platform.deepseek.com/api_keys) | App 设置里的 DeepSeek 卡片 |
| 听懂说话（ASR） | 百炼北京区 API Key、同一业务空间 Workspace ID、模型权限 | [百炼北京区 API Key](https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key) | App 设置里的阿里云语音识别卡片 |
| 朗读回复（TTS） | Fish Audio **.org** 的 API Key、账户可用音色 ID、额度 | [Fish Audio API 账户页](https://fishaudio.org/zh/account?section=api) | App 设置里的 Fish Audio 卡片 |
| 手机 Grok 聊天 | xAI API Key、可用模型 ID、API 额度 | [xAI API 控制台](https://console.x.ai/) | Android App 的 Grok 手机直连卡片 |
| 显示高德地图 | Web 端 JSAPI Key、配套 `jscode` | [高德应用管理](https://console.amap.com/dev/key/app) | Key 填网页构建变量；`jscode` 留在反向代理 |
| 米家设备发现 / 控家 | 有设备的米家账号、扫码授权、服务器依赖 | [小米账号](https://account.xiaomi.com/)及米家 App | App 的米家账号与设备卡片 |
| 手机 GPS、麦克风 | 系统权限、支持桥接的 Android 安装包 | 无需另买地图 / 语音 API 来申请权限 | 手机系统和 App 权限设置 |

**最少组合：** Mock 不需要账号；真实车况需要 Tesla；语音控车需要 Tesla + 签名网关 + DeepSeek + ASR + TTS。地图、Grok、米家均可按需增加。

当前公开服务端的启动配置要求 Tesla Client ID、域名和回调地址；AI / 家居设置也依赖已登录的真实后端会话。它不是只填一个聊天 Key 就能独立启动的通用聊天客户端。

### 不要混淆这些东西

| 名称 | 用途 | 注意 |
| --- | --- | --- |
| Tesla Client ID / Client Secret | 标识自己的开发者应用 | Secret 只放服务端私有文件 |
| Tesla OAuth access / refresh token | 车主授予应用的权限 | 后端自动处理；不填 App 登录框 |
| 车辆指令私钥 | 给车辆指令签名 | 私钥绝不能放公网；配套公钥才需要公开 |
| DriveTalk 手机访问令牌 | 登录自己的 DriveTalk 服务 | 不是 Tesla Secret，也不是供应商 API Key |
| DeepSeek / xAI / Fish / 百炼 API Key | 调用各自供应商 | 互不通用；聊天会员也不是这些 Key |
| Workspace ID / 音色 ID / 模型 ID | 指定空间、音色或模型 | 不是密钥，但必须对应自己有权使用的资源 |
| 高德 JSAPI Key / `jscode` | 加载地图 / 代理鉴权 | 只有 JSAPI Key 允许出现在网页构建里 |

<a id="hosting"></a>

## 二、先部署自己的 HTTPS 服务

### 2.1 基础设施

准备 Linux 服务器、自己控制的域名、有效 HTTPS 证书、Python 3.11+、Node.js 22.18+（推荐 24）和 pnpm。需要 Android 安装包时再准备 Java 17+、SDK 36、Gradle 9.5.0，见 [README](README.md)。

域名解析到自己的服务器。云安全组对外放行网站必需的 80 / 443；SSH 只给自己的管理来源。Python 的 8788 / 8790 / 8791 和签名代理不直接公开。大陆服务器使用域名提供服务时，按云厂商要求处理备案等部署条件。

先按 README 跑 Mock。真实环境只保留自己的配置，**不要复制他人的 `.env`、数据库、证书或账号文件**。

### 2.2 服务端私有配置

在仓库外建立仅服务账号可读写的私有目录；复制 [server/.env.example](server/.env.example) 到例如 `/opt/drivetalk/secrets/drivetalk.env`。在自己的编辑器里填写，不把密钥粘到 Issue 或聊天截图。

安装依赖并加载环境（以下命令从本仓库根目录执行；目录权限应由部署者预先配置）：

```sh
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r server/requirements-voice.txt

set -a
. /opt/drivetalk/secrets/drivetalk.env
set +a
python server/drivetalk_server.py init-secrets
```

`init-secrets` 用于初始化后端加密密钥和手机访问令牌。默认位置分别是 `/opt/drivetalk/secrets/token-encryption.key` 和 `/opt/drivetalk/secrets/mobile-api-token`。已有部署请保留这些文件；换密钥会影响已保存凭据的读取。数据库默认在 `/var/lib/drivetalk/state.sqlite3`。把密钥与数据库作为私有备份保管，不提交 Git。

完成下面 Tesla 注册配置后，分别启动三个常驻服务；每个终端 / systemd 服务都要加载同一份私有环境：

```sh
python server/drivetalk_server.py serve  # 127.0.0.1:8788，车辆、AI、账号
python server/fish_voice.py             # 127.0.0.1:8790，TTS 中继
python server/aliyun_asr.py             # 127.0.0.1:8791，ASR 中继
```

这是三个独立进程，不是在一个终端连续运行三条阻塞命令。正式部署用服务管理器维持进程，不能只启动第一个就认为语音已接通。更多运维边界见 [自托管说明](docs/SELF_HOSTING.md)。

### 2.3 HTTPS、流式聊天和 WebSocket 转发

网页、API、OAuth 回调、SSE、WSS 必须使用**同一个 HTTPS 来源**。下表是反向代理的路由要求，不是把三个服务合并成一个端口：

| 公网路径 | 内部目标 | 必需处理 |
| --- | --- | --- |
| `/dashboard/` | `web-dashboard/dist/` 静态文件 | 保留部署前缀，提供网页资源 |
| `/.well-known/appspecific/com.tesla.3p.public-key.pem` | Tesla 公钥文件 | 可公开读取；绝非私钥 |
| `/v1/vehicle/ai/voice/live` | `127.0.0.1:8790` | WebSocket Upgrade、WSS |
| `/v1/vehicle/ai/asr/live` | `127.0.0.1:8791` | WebSocket Upgrade、WSS |
| 其他 `/v1/vehicle/`、`/v1/smarthome/` | `127.0.0.1:8788` | 透传 Cookie；SSE 关闭缓冲 |
| `/auth/tesla/start`、`/oauth/callback`、`/healthz` | `127.0.0.1:8788` | 保留查询参数、正常 HTTPS 重定向 |

Nginx 的两个 WebSocket 路由需各自设置以下参数，并使用表中的不同 `proxy_pass` 目标；HTTP / SSE 路由不要强行套 WebSocket 升级头：

```nginx
# 放到相应 WebSocket location 中，端口按上表选择。
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
proxy_set_header Host $host;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_read_timeout 300s;
proxy_buffering off;
```

不要在日志里记录请求体、Cookie、Authorization、登录二维码链接或 OAuth 查询参数。不要用关闭 TLS 校验或放宽来源校验来解决连接失败。

网页的 `.env.local` 使用：

```dotenv
VITE_DATA_MODE=backend
VITE_VEHICLE_BACKEND_PATH=/v1/vehicle
VITE_VEHICLE_COMMAND_PROXY_URL=/v1/vehicle
```

`pnpm build` 后部署 `web-dashboard/dist/` 至同源 `/dashboard/`。构建变量改变后需要重新构建，不是改服务器文件后浏览器就自动更新。`VITE_VEHICLE_COMMAND_PROXY_URL` 是 **DriveTalk API 路径**，不是手机直接访问 Tesla 签名网关的地址。

在自己的 App“控制 / 设置 → 账户与数据来源”中填写生成的 **DriveTalk 手机访问令牌**，选择“记住登录”，点击“连接并读取真实快照”。当前可记住登录 30 天；AI、ASR、TTS、米家设置要求真实后端连接和记住登录。仅限私人设备使用此选项。

<a id="tesla"></a>

## 三、Tesla Fleet API：注册、车主授权、车辆配对

**这是三个不同步骤：开发者应用注册 → 车主 OAuth 授权 → 虚拟钥匙配对。** 能看见车辆不等于可以签名控车，手机里出现第三方应用也不等于已添加车辆钥匙。

### 3.1 去哪里申请、需要拿到什么

从 [Tesla Fleet API 入门与申请入口](https://developer.tesla.com/docs/fleet-api/getting-started/what-is-fleet-api)进入应用申请，使用已验证并满足平台要求的 Tesla 账号，按控制台要求提交真实应用资料。应用名称不要与已有应用重复，也不要假冒官方应用。

登记自己的网站来源、域名和 OAuth 回调，例如：

```text
网站来源：https://console.example.invalid
应用域名：console.example.invalid
OAuth 回调：https://console.example.invalid/oauth/callback
```

本项目使用的权限字符串是 `openid offline_access vehicle_device_data vehicle_location vehicle_cmds`。根据希望开放的功能申请车辆数据、位置、命令权限；车主授权时也要选择相应权限。`offline_access` 用于后端刷新授权，不能替代车辆命令权限。

取得自己的 **Client ID / Client Secret**。将 Secret 单独保存在服务账号可读、权限为 `600` 的私有文件中，例如 `/opt/drivetalk/secrets/tesla-client-secret`，文件内容只放 Secret。Client ID 和文件路径填入服务端环境。

### 3.2 生成并公开公钥

以下命令只适用于**首次创建的新部署**；已经配对的车辆不要随意覆盖密钥。预先创建目录并设置服务账号所有权：

```sh
umask 077
openssl ecparam -name prime256v1 -genkey -noout \
  -out /opt/drivetalk/secrets/vehicle-private-key.pem
openssl ec -in /opt/drivetalk/secrets/vehicle-private-key.pem -pubout \
  -out /var/www/drivetalk/.well-known/appspecific/com.tesla.3p.public-key.pem
# 公钥需要让网站静态服务读取；私钥仍保持仅服务账号可读。
chmod 644 /var/www/drivetalk/.well-known/appspecific/com.tesla.3p.public-key.pem
```

让 HTTPS 网站实际提供这个地址：

```text
https://自己的域名/.well-known/appspecific/com.tesla.3p.public-key.pem
```

浏览器打开应得到 PEM 公钥，不是 HTML 登录页、404 或 SPA 首页。公开源码的 `verify-registration` 还会读取上述 `/var/www/drivetalk/.well-known/...` 本地文件；若网站使用其他目录，须让此核对路径仍保存同一份公钥。生成规则和配对流程参见 [Tesla 虚拟钥匙开发指南](https://developer.tesla.com/docs/fleet-api/virtual-keys/developer-guide)。

### 3.3 配置区域并注册应用

国行账号的模板为：

```dotenv
TESLA_CLIENT_ID=replace_with_your_client_id
TESLA_CLIENT_SECRET_FILE=/opt/drivetalk/secrets/tesla-client-secret
TESLA_DOMAIN=console.example.invalid
TESLA_REDIRECT_URI=https://console.example.invalid/oauth/callback
TESLA_AUTH_BASE=https://auth.tesla.cn/oauth2/v3
TESLA_FLEET_API_BASE=https://fleet-api.prd.cn.vn.cloud.tesla.cn
TESLA_SCOPES="openid offline_access vehicle_device_data vehicle_location vehicle_cmds"
TESLA_VEHICLE_VIN=
```

用**账号 / 车辆所属区域**选 Fleet 地址，不是按云服务器的位置选择。其他区域请从 [Tesla 认证说明](https://developer.tesla.com/docs/fleet-api/authentication/overview)核对区域地址；不要把海外 Fleet URL 和中国授权地址随意混搭。

加载私有环境、确认公钥可访问后，从仓库根目录执行：

```sh
python server/drivetalk_server.py register
python server/drivetalk_server.py verify-registration
```

第一条会向 Tesla 注册自己的域名，第二条核对公钥。开发者控制台资料正确不代表已经完成这一步。

### 3.4 完成车主授权与钥匙配对

启动后端并在浏览器打开自己网站的 `/auth/tesla/start`，登录拥有目标车辆的 Tesla 账号并授予权限。成功返回自己的 `/oauth/callback` 后，后端保存加密授权。不要手动把 OAuth token 发给前端或放进网页变量。

随后按 Tesla 配对流程打开虚拟钥匙链接：官方文档的通用形式为 `https://www.tesla.com/_ak/自己的域名`；中国区可使用 `https://www.tesla.cn/_ak/自己的域名` 入口，是否可用以 Tesla 当前区域服务为准。用装有 Tesla App 的手机完成车辆钥匙确认，域名必须与注册、公钥地址一致。不要把 `.com` / `.cn` 跳转差异误当作网站 443 未开放。

可由部署者主动运行只读检查（这些是真实 Tesla 请求，不是离线测试）：

```sh
python server/drivetalk_server.py verify-user-region
python server/drivetalk_server.py verify-vehicle-access
```

多辆车时在私有环境指定自己的 `TESLA_VEHICLE_VIN`，不要在公开 Issue 展示车辆识别码。

### 3.5 签名网关接入，才能开放真实命令

按 [Tesla 官方 Vehicle Command SDK](https://github.com/teslamotors/vehicle-command) 的 HTTP Proxy 文档另外部署 `tesla-http-proxy`。需要自己的**车辆指令私钥**、网关 **TLS 证书 / TLS 私钥**和可验证的证书信任链；网关 TLS 密钥不是车辆指令密钥。

把网关限定在同机 loopback HTTPS，使用与证书名称匹配的地址。本项目服务端配置示例：

```dotenv
DRIVETALK_COMMANDS_ENABLED=true
DRIVETALK_SIGNING_PROXY_URL=https://localhost:4443
DRIVETALK_SIGNING_PROXY_CA_FILE=/opt/drivetalk/secrets/proxy-ca.pem
DRIVETALK_TRUNK_CLOSE_ENABLED=false
```

网关部署、车辆配对、TLS 和区域路由都需完成；不能只将 `COMMANDS_ENABLED` 改成 `true`。TLS 信任文件用自己的 CA / 自签证书，且证书需包含使用的主机名称，不能靠 `verify=false` 绕过。

**重要边界：** 公开源码不附带“明确关闭后备箱”的自定义网关扩展 `drivetalk_close_trunk`。标准签名代理不会因为改了一个变量就自动获得此扩展；自己的网关实现并验证兼容后，才能开启 `DRIVETALK_TRUNK_CLOSE_ENABLED`。不要用重复发送后备箱切换命令假装“关闭”。设置页标为“未接入”的高级功能也不会因申请了 `vehicle_cmds` 自动开放。

当前车况是按需读取的**快照**，不是 Fleet Telemetry 实时流。健康检查中 `telemetry: not_configured` 不妨碍快照，但也不代表已经实现实时车速、胎压、位置推送。车机摄像头访问不是本仓库已实现的功能。

<a id="deepseek"></a>

## 四、DeepSeek：文本、工具调用与控车

1. 打开 [DeepSeek API Key 管理](https://platform.deepseek.com/api_keys)，注册 / 登录开发者账户，创建专用于本项目的 Key，并准备 API 余额。
2. 从 [官方 API 文档](https://api-docs.deepseek.com/)查找当前模型 ID。本项目默认 `deepseek-flash`；模型名称不能凭感觉写“4.1 flash”或聊天产品昵称，必须是接口接受且账号可用的标识。
3. 登录 DriveTalk 后，在“控制 / 设置 → DeepSeek 私人 AI 助手”中填写 Key、模型 ID、可选人设，保存并启用。
4. 在对话界面使用 DeepSeek 通道。工具由自己的后端提供，不需要在 DeepSeek 控制台逐个创建控车函数；但实际动作仍需要车辆签名网关或米家授权。

**现有调用地址为 `https://api.deepseek.com/chat/completions`。** 界面中若出现“阿里云 DeepSeek”字样，不意味着接受百炼 Key：本项目服务器可以部署在阿里云，但这个通道使用的是 DeepSeek 官方 API。不要填 DashScope / 百炼 Key。

Key、模型和人设经自己的后端保存。显示“已配置”只表示保存成功，不保证余额、模型权限和网络正常。用户实际发送消息会产生供应商调用费用；人设不改变设备工具的服务端校验规则。

<a id="asr"></a>

## 五、阿里云百炼：流式语音识别 ASR

**ASR 把声音转成文字，不负责生成回复或朗读。** 当前通道固定使用北京区 `fun-asr-realtime`。

### 5.1 申请入口

- [百炼北京区控制台](https://bailian.console.aliyun.com/cn-beijing/model/market)：登录阿里云账号，按平台要求开通服务，检查语音识别模型是否有调用权限。
- [北京区 API Key 页面](https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key)：在目标业务空间创建 API Key。
- [官方 API Key 获取说明](https://help.aliyun.com/zh/model-studio/get-api-key)：区域和权限选择说明。
- [Workspace ID 获取说明](https://help.aliyun.com/zh/model-studio/obtain-the-app-id-and-workspace-id)：找不到 ID 时按此页面操作。

进入控制台先确认地域是“华北 2（北京）”，再确认业务空间。通过顶部业务空间切换器的详情 / 信息入口查看 ID；有管理权限时也可进入业务空间管理查看 ID 列。布局可能变化，找的是 **Workspace ID**，不是“默认业务空间”这个显示名称、阿里云账号 ID 或应用 APP ID。

Key 和 Workspace ID 必须属于同一北京区业务空间，并具备模型权限；不要把杭州区 Key、RAM AccessKey ID / Secret、旧版 NLS AppKey 或 Coding Plan 凭据填进来。

### 5.2 填到 App、核对中继

在“控制 / 设置 → 语音识别 · 阿里云主引擎”填写北京区 API Key 与 Workspace ID，保存启用。无需把 Key 加进 `VITE_*`。

本项目服务端根据空间拼接以下供应商地址：

```text
wss://<WorkspaceID>.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference
```

手机连接的是自己的 `/v1/vehicle/ai/asr/live`，再由 8791 中继连接百炼。确认 8791 常驻进程、WSS 升级和同源 Cookie 都通畅，然后允许手机麦克风权限，进行一次明确的识别测试。模型接口资料见 [Fun-ASR 实时识别](https://help.aliyun.com/en/model-studio/fun-asr-realtime)。

当前会话在停止说话约 2 秒后结束一轮；朗读期间暂停收音。无文字时先检查系统的隐身 / 隐私模式、麦克风权限及输入音量，不要直接归因于模型精度。连续会话依赖前台运行，不承诺锁屏全天候收音。

费用在阿里云账户按实际服务规则结算。查看 [百炼账单与费用管理](https://help.aliyun.com/zh/model-studio/bill-query-and-cost-management)，设置预算提醒；少量充值不意味着永久免费。

<a id="tts"></a>

## 六、Fish Audio：音色与语音朗读 TTS

### 6.1 先确认供应商域名

**本仓库接入 `fishaudio.org`，不是 `fish.audio`。两个域名的 API Key、余额、音色 ID 和协议不能混用。** 不要仅凭“Fish Audio”名称判断凭据是否适配。

从 [Fish Audio .org 官网](https://fishaudio.org/zh/)注册 / 登录，在 [API 账户页](https://fishaudio.org/zh/account?section=api)创建 API Key、检查积分或 API 额度。按自己的账号页面完成平台要求的验证。本项目配置没有第二个额外“验证密钥”输入框。

申请和取音色步骤参见 [Fish Audio .org 快速开始](https://docs.fishaudio.org/zh/docs/getting-started)。API Key 创建后妥善保存，不要用 Cookie、网页登录密码或音色 ID 替代。

### 6.2 社区音色 / 自己克隆的音色怎么用

先选自己有权使用且账户 API 可访问的音色。通过平台音色详情 / 可用音色列表取得 **voiceId**；官方文档提供查询可用音色的 `GET /api/open/v1/voices` 接口。需要 API 调用时由自己私下带 Key 查询，不把完整返回的私人音色列表贴到公开 Issue。

填写的是 ID，不是音色名称、音色详情网页 URL 或样音下载 URL。本项目接受 32 位十六进制 ID 或对应 UUID 格式。社区页面能播放样音，不保证这个音色已授权给自己的 API；若列表中不可用，先核对平台权限、模型与音色兼容性。

### 6.3 接到 App

在“控制 / 设置 → Fish Audio”填写 **.org API Key** 和音色 ID，保存并启用。当前客户端指定 `fishaudio-s21pro-flash`，后端会查询供应商 capabilities；不能靠换一个 ID 让不同服务或不兼容模型自动适配。

公开实现的供应商地址是：

```text
能力查询：https://realtime.fishaudio.org/v3/tts/capabilities
流式合成：wss://realtime.fishaudio.org/v3/tts/live
```

自己的手机连接 `/v1/vehicle/ai/voice/live`，由 8790 中继进行合成。文本分句、合成、音频排队播放构成流水线；不需要用户另买音频播放器 API，但需要中继进程和 WSS 正常。

“合成失败”不一定是余额不足：也可能是 Key 用错平台、音色不可用、capabilities / WebSocket 不通，或者前端音频解码 / 缓冲出错。供应商已扣费不等于手机已经成功播放，排查时不要反复合成来“测试余额”。

<a id="grok"></a>

## 七、Grok：Android 手机直连聊天

当前公开版本的 Grok 是 **Android 原生桥接直连 xAI API**，不是云服务器上的 `grok2api`，也不需要按旧方案额外购买 GCP 或部署 WARP。普通浏览器没有这个原生桥接。

1. 在 [xAI API 控制台](https://console.x.ai/)登录，选择自己的团队，创建 API Key，检查 API 额度和权限。
2. 在 [xAI 模型文档](https://docs.x.ai/developers/models)确认模型 ID；须选择可用于本项目 Chat Completions 调用的模型，不要用显示名称或仅支持其他接口的模型。
3. 在自己构建的 Android App“控制 / 设置 → Grok · 手机直连官方 API”中填写 Key、模型 ID和可选人设，保存启用。
4. 在聊天界面选择 Grok。手机网络必须能正常使用 xAI API；若使用代理，需确认覆盖这个 App 的连接。

本机调用地址为 `https://api.x.ai/v1/chat/completions`；Key 在手机端加密保存，不上传阿里云后端。官方入口与调用方式见 [xAI API 文档](https://docs.x.ai/overview)。网页上按钮不可用时，不是要求再填写第二份 Secret。

**Grok 通道当前只聊天，不接车辆 / 家居工具；要执行动作请选择 DeepSeek。** xAI 控制台的 API 额度应单独核对，不能把 Grok / X 消费者会员当作本项目 API 余额。403 需要检查账号、区域、模型及网络返回，不能保证换一台服务器或开代理一定解决。

<a id="amap"></a>

## 八、高德地图：JSAPI Key 与安全密钥

1. 在 [高德开放平台应用管理](https://console.amap.com/dev/key/app)注册开发者并创建应用。
2. 添加 Key，服务平台选 **Web 端（JSAPI）**，不是 Android SDK Key，也不是普通 Web 服务 Key。设置自己网站的域名白名单。
3. 取得 JSAPI Key 和配套安全密钥 `jscode`。官方 [Key 与安全代理准备说明](https://lbs.amap.com/api/javascript-api/guide/abc/prepare)介绍了申请和代理配置；本项目加载的地图版本是 JS API 2.0。
4. 将 JSAPI Key 填入 `web-dashboard/.env.local` 的 `VITE_AMAP_JS_KEY`，重新 `pnpm build`。**`jscode` 不填网页、不提交 Git。**

前端已经使用 `serviceHost = 当前来源 + /_AMapService`。部署者需要在同源 Nginx 上设置高德代理；Python 服务不会自动实现此路径。下面是基础 Web 服务位置配置示意，合并到自己现有的 HTTPS `server` 中，替换占位符：

```nginx
location /_AMapService/ {
    set $args "$args&jscode=REPLACE_WITH_YOUR_SECURITY_JSCODE";
    proxy_pass https://restapi.amap.com/;
    proxy_ssl_server_name on;
    proxy_ssl_verify on;
    proxy_ssl_trusted_certificate /etc/ssl/certs/ca-certificates.crt;
    access_log off;
}
```

这是固定上游代理，不是任意网址转发器；应限制只供自己网站使用，并按自己的配额配置访问频率。若启用自定义地图 / 海外矢量地图，按官方说明再添加对应的 `/v4/map/styles`、`/v3/vectormap` 路由。配置文件包含安全密钥，只能私下保存，`nginx -t` 成功后再重新加载。

地图不显示时检查 Key 平台类型、白名单、`/_AMapService` 路由、`jscode` 与构建是否更新。车辆坐标来自 Fleet 快照，高德只负责地图及相关查询；手机 GPS 测速不是实时读取车辆速度。地图 API 配额与车况 API 配额是两回事。

<a id="xiaomi"></a>

## 九、米家：扫码发现设备与控家

### 9.1 不需要逐台申请开发者 Key

此模块使用米家账号扫码授权和第三方 [mijia-api 项目](https://github.com/Do1e/mijia-api)，不是小米向个人签发的一套通用官方 OpenAPI Key。先确保自己的设备在米家 App 中可见，家庭 / 房间信息也在米家中整理好。

服务端安装可选依赖，并设置私有凭据目录：

```sh
. .venv/bin/activate
python -m pip install -r server/smarthome/requirements.txt
```

```dotenv
SMARTHOME_CREDENTIAL_DIR=/var/lib/drivetalk/mijia
SMARTHOME_CONTROL_ENABLED=1
```

目录必须是绝对路径，由运行服务的账号拥有、权限 `700`，其中凭据文件权限 `600`。加载新的环境后重启自己的后端。只想发现而不控家时将 `SMARTHOME_CONTROL_ENABLED` 保持 `0`。

### 9.2 App 中完成一次登录和设备选择

1. 先连接 DriveTalk 并记住登录，进入“控制 / 设置 → 米家账号与设备”。
2. 点击“登录小米账号”。在另一台设备展示二维码，用米家 App 扫码确认；同手机可使用页面提供的官方登录链接。
3. 等待登录 / 同步完成；不要在等待中连续重复点击。失败时先“读取任务状态”，按冷却时间再尝试。
4. 查看自动发现的设备、家庭、房间、在线状态和适配状态。家庭 / 房间来源是账号返回信息，不是 AI 根据设备名猜出来的；未分配的房间需要在米家内补充。
5. 已适配的灯具、插座、空调可能默认选中；检查列表并取消不想开放的设备，再“保存并允许所选设备控家”。服务器总开关仍决定能否执行。
6. 在 DeepSeek 对话中明确描述设备和动作。多个同名设备时补充家庭 / 房间，状态回读未确认不代表一定失败，不要重复下发。

登录凭据和目录加密保存在自己服务器的 `auth.enc`、`inventory.enc` 等文件，密钥为同目录 `credential.key`。丢失密钥不能通过重新生成解开旧文件；私下备份整套文件，并保护登录二维码。

### 9.3 自动发现不等于全部可控

当前按 MIOT 能力适配灯具、插座、空调：开关，以及型号支持的亮度、色温、温度、模式、风速。新型号能否自动生成控制绑定取决于实际规格，并非设备在列表中就支持全部功能。

门锁、摄像头、路由器、手机、音箱、体脂秤、电视盒子等可被发现，但目前不因此开放控制。**摄像头抓拍 / 短视频 Tool 是保留接口，当前返回未配置；没有内置通用 P2P → RTSP 转换。** 不需要为尚未实现的功能先购买其他视频 API。

App 登录后的自动发现流程不要求逐台手填 `did/siid/piid`。单独使用 MCP / provider 框架的开发者可以参考 [配置模板](server/smarthome/config.example.json)；不要把模板里未填写的设备属性当作已验证映射。MCP 是工具协议，不是需要额外购买的云端模型服务。

<a id="future"></a>

## 十、Home Assistant 与尚未开放的功能

Home Assistant 接口是**迁移预留骨架**，不是当前可直接替换的已完成后端。未来需要自己运行 HA、配置 [小米官方 Xiaomi Home 集成](https://github.com/XiaoMi/ha_xiaomi_home)，并按 [HA REST API](https://developers.home-assistant.io/docs/api/rest/)取得自己实例的地址和长期访问令牌。

本仓库的 `HomeAssistantProvider` 状态归一化 / 写入仍未实现；仅把 `provider` 改成 `ha` 或填一个 HA Token 不会接通。摄像头媒体、门锁等功能也需专门适配后才能使用。

同样，当前没有可申请一个 Key 就启用的 Fleet Telemetry 接收器、车机摄像头接口、iOS 原生语音桥接或官方 App 专有模型。公开车模是通用几何体，不需要下载厂商 APK 来开始使用。

<a id="troubleshooting"></a>

## 十一、手机安装、权限、费用与排错

### 11.1 Android 安装自己的版本

参照 [README Android 构建](README.md#android)，将编译参数 `DRIVETALK_HOME_URL` 设为自己的 HTTPS `/dashboard/` 地址。包名为 `org.drivetalk.app`。不要安装来路不明、带他人账号配置的 APK。

安装后允许麦克风 / 定位，检查系统隐私模式；GPS 在室内可能无有效定位。网页更新不等于原生桥接更新，涉及麦克风、GPS、Grok 桥接代码时还需要重新构建并安装 APK。当前没有提供可直接安装的 iOS 包。

### 11.2 从低风险检查到实际使用

先确认 `/dashboard/` 和 `/healthz` 正常，再登录读取车况，然后依次保存 AI、ASR、TTS、地图、米家配置。`healthz` 中 `ok` 只证明本服务响应，`teslaAuthorized` 只反映保存的授权状态；两者都不能代替当前供应商可达、模型权限、车辆配对及设备动作验证。

先做不发送动作的配置和权限检查；自己决定进行短文本 / 语音试用时再检查费用。真实车辆 / 家居动作测试由设备所有者明确发起。示例命令、Mock 测试、设置保存成功都不等于真车测试通过。

### 11.3 常见问题

| 现象 | 优先检查 |
| --- | --- |
| AI / ASR / TTS 保存按钮灰色 | 是否真实后端连接、记住登录；字段是否完整；当前能力接口是否可用 |
| HTTP 401 / 登录失效 | DriveTalk 会话、手机令牌、供应商 Key 分层检查；不要把它们互换 |
| HTTP 403 | 供应商权限 / 区域 / 模型 / 来源；不能一律判定为 IP 被封 |
| HTTP 409 | 看本项目具体错误：可能为状态不明、指令冲突、前置条件未满足；不等同于 HTTP 429 |
| HTTP 429 / 服务限流中 | 遵守返回的冷却 / Retry-After，降低刷新频率，避免按钮连点；不要自动重发动作 |
| 车况可读但命令失败 | 车辆钥匙配对、命令权限、签名网关 TLS、车辆在线状态及区域地址 |
| 关闭后备箱不可用 | 是否真的实现并验证了自定义关闭扩展；标准代理并不自动提供 |
| 文本有回复但没有声音 | 8790 进程、WSS、Fish **.org** Key、音色权限、播放缓冲；不只检查余额 |
| 正在收音但没有文字 | 麦克风隐私 / 隐身模式、权限、PCM 音频；再检查 8791、百炼地域和空间 |
| 手机正常但服务器供应商超时 | 分别检查服务器 DNS、TLS、出口和 WSS；手机网络通不证明云服务器通 |
| 地图空白 | JSAPI 类型、域名白名单、`/_AMapService`、安全密钥、构建产物 |
| 米家扫码失败 / 任务未确认 | 私有目录所有权 / 权限、可选依赖、扫码是否过期、任务冷却；不要删密钥重试 |
| 发现设备却不能控制 | 是否适配、授权选择、服务器总开关、设备在线；发现本身不是兼容承诺 |
| 配置了 Grok 却不能控车 | 当前 Grok 通道是本机聊天；真实工具使用 DeepSeek 通道 |

### 11.4 费用和隐私清单

- 云主机、域名、HTTPS 运维和各供应商调用费用由使用者承担；免费额度、会员、API 积分和账户余额分别核对。
- DeepSeek / xAI 会收到发送给它们的对话，百炼收到识别音频，Fish 收到朗读文本，高德收到必要地图请求，小米连接自己的设备账户。只启用自己接受的数据路径。
- 服务器端 Key / OAuth 数据加密保存在自己的服务中；Grok Key 保存在自己的 Android 手机；高德安全密钥留在私有反向代理配置。
- 发布源码、提 Issue 或截图前清除密钥、域名对应身份、车辆 / 设备标识、位置、账号列表、音色私有信息、二维码和日志。不要上传 `.env`、状态数据库、私钥或 APK 签名材料。
- 服务端秘密不能放 `VITE_*`。前端打包会把这些变量写到任何访问者都可下载的文件里。

接入完成的标志是：自己能解释每项凭据属于哪个供应商、存在哪里、调用经过哪台设备，并逐项验证自己需要的功能。**不需要使用的服务，先不申请、不充值、不启用。**
