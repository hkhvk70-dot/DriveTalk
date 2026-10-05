# 第三方依赖与分发注意事项

原依赖核对日期：2026-10-04；公开版更新：2026-10-05。原创业务代码使用 GPL-3.0-or-later，见根目录 LICENSE。下列第三方依赖保留自己的许可证与原始署名，不被项目总许可替换。本文件不是法律意见。

此候选副本不分发 `node_modules`、Python 虚拟环境、Android 依赖缓存、Gradle 二进制、APK 或第三方 SDK 源码。安装或构建时下载的依赖仍适用它们各自的许可证。本表不能替代实际分发版本的完整 LICENSE / NOTICE 文件。

## 已核对的直接依赖

前端版本以候选副本的 `web-dashboard/pnpm-lock.yaml` 为准。下列版本已与本地安装包的 `package.json` 和可用的许可证文本核对；上游链接供复核。版本或依赖改变后须重新检查。

| 组件 | 已核版本 | 许可 / 注意事项 | 上游许可来源 |
| --- | --- | --- | --- |
| React、React DOM | 19.3.0 | MIT | [React LICENSE](https://github.com/facebook/react/blob/main/LICENSE) |
| Three.js | 0.186.1 | MIT | [Three.js LICENSE](https://github.com/mrdoob/three.js/blob/dev/LICENSE) |
| React Three Fiber | 9.8.1 | MIT；核对安装包元数据与上游许可证 | [Fiber LICENSE](https://github.com/pmndrs/react-three-fiber/blob/master/LICENSE) |
| Drei | 10.7.9 | MIT | [Drei LICENSE](https://github.com/pmndrs/drei/blob/master/LICENSE) |
| Zustand | 5.0.15 | MIT | [Zustand LICENSE](https://github.com/pmndrs/zustand/blob/main/LICENSE) |
| Lucide React | 0.468.0 | ISC；许可文件同时说明部分图标源于 Feather（MIT），不得丢弃该归属 | [Lucide LICENSE](https://github.com/lucide-icons/lucide/blob/main/LICENSE) |
| React Router DOM | 7.18.4 | MIT | [React Router LICENSE](https://github.com/remix-run/react-router/blob/main/LICENSE.md) |
| Tailwind CSS、Tailwind Vite 插件 | 4.3.3 | MIT | [Tailwind LICENSE](https://github.com/tailwindlabs/tailwindcss/blob/main/LICENSE) |
| Vite | 7.3.6 | MIT；发布包 LICENSE.md 另含其内嵌依赖声明，不能只复制第一段 | [Vite LICENSE](https://github.com/vitejs/vite/blob/main/LICENSE) |
| Vite React 插件 | 5.2.0 | MIT | [插件 LICENSE](https://github.com/vitejs/vite-plugin-react/blob/main/LICENSE) |
| TypeScript | 5.9.3 | Apache-2.0 | [TypeScript LICENSE](https://github.com/microsoft/TypeScript/blob/main/LICENSE.txt) |
| `@types/react`、`@types/react-dom`、`@types/three` | 19.3.0 / 19.3.0 / 0.186.0 | MIT；保留各安装包自身的作者归属 | [DefinitelyTyped LICENSE](https://github.com/DefinitelyTyped/DefinitelyTyped/blob/master/LICENSE) |

Python requirements 使用版本范围，没有完整锁定所有传递依赖。以下是已核对的上游许可，不代表范围内每个历史或将来版本已逐一审核。

| 组件 / 要求 | 核对结果 | 上游许可来源 |
| --- | --- | --- |
| cryptography `>=42,<46`（智能家居要求 `>=44,<46`） | 45.0.7 上游采用 Apache-2.0 OR BSD-3-Clause；wheel 可能携带更多底层组件许可 | [45.0.7 LICENSE](https://github.com/pyca/cryptography/blob/45.0.7/LICENSE) |
| websockets `>=15.0.1,<16` | BSD-3-Clause | [websockets LICENSE](https://github.com/python-websockets/websockets/blob/main/LICENSE) |
| msgpack `>=1.1,<2` | Apache-2.0 | [msgpack COPYING](https://github.com/msgpack/msgpack-python/blob/main/COPYING) |
| 官方 MCP Python SDK `>=1.28,<2` | MIT | [MCP SDK LICENSE](https://github.com/modelcontextprotocol/python-sdk/blob/main/LICENSE) |
| mijiaAPI `>=4,<5` | **GPL-3.0-or-later**；4.4.0 元数据与上游 GPL v3 文本已核对，正式分发前必须处理相容性 | [4.4.0 元数据](https://github.com/Do1e/mijia-api/blob/v4.4.0/pyproject.toml)、[LICENSE](https://github.com/Do1e/mijia-api/blob/main/LICENSE) |
| qrcode `>=8,<9` | BSD-3-Clause；许可还保留原始 QR 实现的 MIT 归属与商标说明 | [qrcode LICENSE](https://github.com/lincolnloop/python-qrcode/blob/main/LICENSE) |

Android 当前直接使用 AndroidX Activity 1.8.0；构建工具声明包括 Android Gradle Plugin、Kotlin 插件和 Foojay resolver。AndroidX、Kotlin、Gradle 与 Foojay 上游许可为 Apache-2.0，见 [AndroidX](https://github.com/androidx/androidx/blob/androidx-main/LICENSE.txt)、[Kotlin](https://github.com/JetBrains/kotlin/blob/master/license/LICENSE.txt)、[Gradle](https://github.com/gradle/gradle/blob/master/LICENSE)、[Foojay resolver](https://github.com/gradle/foojay-toolchains/blob/main/LICENSE)。本轮未完整解析 Android 最终依赖图，也未逐个核验 AGP 制品及 AndroidX 传递依赖的 POM、LICENSE、NOTICE；不得据此标记整套 APK 的许可审核完成。Android SDK 下载与使用还须遵守 SDK 自身条款。

### 新增 Android 语音依赖

| 组件 | 当前声明 | 上游许可 |
| --- | --- | --- |
| Vosk Android | 0.3.75 | [Apache-2.0](https://github.com/alphacep/vosk-api/blob/master/COPYING)；不附带识别模型 |
| JNA | 5.18.1 | [Apache-2.0 或 LGPL-2.1-or-later 双许可](https://github.com/java-native-access/jna/blob/master/LICENSE)；实际分发时保留对应声明 |
| JUnit（仅测试） | 4.13.2 | [EPL-1.0](https://github.com/junit-team/junit4/blob/main/LICENSE-junit.txt) |

上述链接核对了上游许可文本，不代表已经逐项审计最终 APK 内全部 native/transitive 组件。当前只发布源码，不发布本地编译的 APK、模型、依赖或打包后的 JS。

## 分发注意事项

1. **智能家居适配器直接导入 GPL SDK。** 项目原创代码选用 GPL-3.0-or-later，与此 SDK 的许可方向一致；分发实际容器、安装包或组合制品时仍需履行完整许可义务，不能仅凭可选依赖或独立进程忽略对应源码要求。
2. **传递依赖尚未完整审计。** R3F / Drei、Vite、MCP、Python wheel 和 Android 构建都会引入额外组件。实际发布须固定版本并生成完整依赖及许可清单（SBOM），核对每个制品的原始版权、LICENSE 和 NOTICE。
3. **只给许可链接不能满足所有再分发义务。** 分发含第三方代码的 JS bundle、APK、wheel 或容器时，把对应原始许可和应保留的归属随制品提供；Apache NOTICE、MIT / ISC 版权文本、BSD 声明和 GPL 对应源码要求分别处理。不要给第三方代码换署名。
4. **服务条款不是代码许可。** Tesla Fleet API、Xiaomi / 米家、Home Assistant、DeepSeek、xAI、Fish Audio 和高德服务需使用者自行取得有效凭据及允许的调用权限。商业服务可用性、内容条款、商标和数据权利未由本清单授予。

## 不包含的素材与商标

不分发从厂商 App 提取的 GLB、纹理、动画、APK、厂商标志或音色样本；默认车辆展示采用自行组合的通用几何体。没有取得相应再分发授权的外部模型、声音、字体、地图数据或摄像头媒体，不应加入仓库或安装包。

供应商名称只用于描述接口兼容性和第三方归属，不表示合作、认证或官方产品。Home Assistant 官方 Xiaomi Home 集成代码没有复制进此目录；未来如需使用，须另行核对其完整许可证和使用范围。临时项目名称本身也尚未完成商标检索。
