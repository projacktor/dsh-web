# 架构设计图（architecture）

本文用架构图给出 dsh-web 的整体结构与运行时关系，作为跨包导览。各事实的归属文档不变：仓库规则见根 [AGENTS.md](../AGENTS.md)，包级规则见 [packages/AGENTS.md](../packages/AGENTS.md)，文档标准见 [AGENTS.md](AGENTS.md)，开发流程见 [development.md](development.md)，新插件入桶见 [plugins.md](plugins.md)。

dsh-web 是 DeepSeek Harness Web 的插件 monorepo，皮肤以皮肤中心插件的纯资产包形式存在、经创意工坊分发。插件包只经 `cordis.patch.yml` 与 profile 挂载进 dsh web 宿主；类型只来自官方 `@deepseek-ai/*` NPM SDK（node_modules 解析），不依赖任何 DSH 源码 checkout。

## 全景总览

宿主进程按 profile 的 patch 行挂载各插件 host 半区；浏览器 GUI 经 `window.__ModuleLoader__` 模块表加载各插件 browser 半区；两侧经宿主 loopback HTTP 通信。市场站是作者运营的外部服务（本 fork 不部署站点基础设施）：插件与站点之间只有 HTTPS 清单读取与安装下载，没有任何后台数据上报。

```mermaid
flowchart TB
    subgraph hostbox["dsh web 宿主进程（Node）"]
        PROFILE["web profile：插件行与 node_modules"] --> LOADER["cordis loader：按 patch 行挂载插件"]
        LOADER --> HOST["各插件 host 半区：loopback HTTP 路由、settings 命名空间、agent 公告"]
    end
    subgraph guibox["Web GUI（浏览器）"]
        ML["window.__ModuleLoader__ 模块表"] --> CLIENT["各插件 browser 半区 bundle"]
        CLIENT --> UI["官方槽位 UI：侧栏、设置页、聊天区"]
    end
    SITE["dsh-market.com（作者运营的外部市场）"]
    HOME["$DSH_HOME：skins、pets、agent-presets、.agent-presets"]
    CLIENT -- "loopback HTTP API" --> HOST
    HOST --> HOME
    CLIENT -- "市场清单读取与安装下载（HTTPS）" --> SITE
```

## 仓库目录分层

```text
dsh-web/
├── packages/            # 插件 monorepo：功能插件与聚合包 dsh-web-all（皮肤/宠物/社区索引/预设中心已迁出为卫星仓）
│   └── <name>/          # 独立 cordis bundle 包（host + client 两半区）
├── satellites/          # 4 个卫星仓库 git submodules（dsh-skins、dsh-pet、dsh-community-plugins、dsh-presets）
├── shared/              # 跨包事实源：构建预设、平台模块表、host 与 client 运行时模块
├── scripts/             # 仓库维护工具（aggregate、sync-shared、verify-docs 等）
└── docs/                # 长期文档、发布说明与归档
```

## 插件包解剖

每个包是独立 cordis bundle：`package.json` 的 `dsh.bundle.patch` 指向包内 `cordis.patch.yml`（官方 bundle 清单，`dsh plugin` 依赖它识别与挂载）；`dsh.client` 声明浏览器半区需要注入的模块（`inject`）与 `platform: "web"`；`dsh.engines.dsh` 声明最低宿主版本。源码按 host / client / core 三区组织，规则见 [packages/AGENTS.md](../packages/AGENTS.md)。

```mermaid
flowchart LR
    subgraph pkg["单个插件包"]
        MANIFEST["package.json：dsh.bundle.patch、dsh.client、dsh.engines.dsh"] --> PATCH["cordis.patch.yml：insert 行"]
        PATCH --> HOST["src/index.ts：host 半区（Node）"]
        CLIENT["src/client/：browser 半区（Web GUI）"]
        CORE["src/core/：两半区共享纯逻辑"]
        CORE --> HOST
        CORE --> CLIENT
    end
    HOST -- "注册 loopback 路由、settings 命名空间、agent 公告" --> HOSTSVC["宿主服务"]
    CLIENT -- "__ModuleLoader__.load 注入" --> SLOTS["官方槽位：settings.section、侧栏、dsh-workshop.panel 等"]
```

## 浏览器半区构建与模块注入

构建统一走 [shared/tsdown.client.ts](../shared/tsdown.client.ts) 预设，产出闭包工厂 bundle：运行时调用 `window.__ModuleLoader__.load` 注入 GUI，external 不打包、经宿主注入的模块表 require 解析。平台模块表 [shared/web-platform.ts](../shared/web-platform.ts) 冻结 react、cordis 与 `dsh-client-ui-*` 等成员，播种、打包 external 与 Vite alias 共用同一清单。CSS Modules 由 lightningcss 编译内联进 bundle。浏览器侧纯度门：`@deepseek-ai/*` 只能 type-only 导入，值导入仅限平台种子表成员，跨插件协作走 cordis 服务或 slot。

```mermaid
flowchart LR
    SRC["插件 TypeScript 源码"] --> TSDOWN["shared/tsdown.client.ts 统一预设"]
    PLATFORM["shared/web-platform.ts 平台模块表"] -- "external 清单" --> TSDOWN
    TSDOWN -- "闭包工厂产物 + lightningcss 内联 CSS" --> BUNDLE["lib/client.js"]
    BUNDLE -- "运行时 window.__ModuleLoader__.load" --> GUI["Web GUI 模块表"]
```

## 聚合包挂载链

[dsh-web-all](../packages/dsh-web-all/aggregate.yml) 是一键装齐全家桶的载具包：`aggregate.yml` 列出 `patchFrom`、`deps`、外部行与默认关闭行，[scripts/aggregate.mjs](../scripts/aggregate.mjs) 生成聚合 `cordis.patch.yml`（子插件行 id 统一加 `web-ui-` 前缀，与独立包安装共存）与 `workspace:*` 依赖；生成文件勿手改，`aggregate:check` 防漂移。profile 侧需 hoisted 布局让 loader 从顶层解析子包；本地开发用 [scripts/link-profile.mjs](../scripts/link-profile.mjs) 把构建产物链进 profile 的 `@linxin666` 命名空间。host 半区经 `mount-once` 防重：同一插件双源加载只注册一次。

```mermaid
flowchart LR
    A["aggregate.yml：patchFrom、deps、rows、inactive"] -- "node scripts/aggregate.mjs 生成" --> B["dsh-web-all：cordis.patch.yml + package.json"]
    B -- "dsh plugin --profile web add link" --> C["web profile（hoisted 布局）"]
    C -- "web-ui-* 行逐条挂载" --> D["14 个仓内家族子包 + 4 个卫星仓外部行"]
    E["mount-once 防重：双源只注册一次"] -.-> D
    F["inactive：ssh、liangshen、skill-explorer 出厂默认关闭"] -.-> D
```

## 设置页槽位体系

设置页的家族入口分两级：一级设置分区（`settings.section`）由 dsh-web-settings（Web UI 插件组）、皮肤中心、桌宠、创意工坊（`dsh-workshop`）各自注册；组内插件卡走 `web-ui.plugin.item` 子槽，创意工坊的资产面板走 `dsh-workshop.panel` 子槽（Presets 面板由 dsh-preset-center 注入）。host 侧用 `installSettingsSection` 注册命名空间，browser 侧用 `settingsScope.bind` 读写；官方插件管理页用 `plugins.bundle.config` 槽承载插件自带配置（按 bundle 包名分派，渲染在该 bundle 的页面上），alpha.2 起旧的 `settings.plugin.item` 槽已不存在。

```mermaid
flowchart TB
    S["Web 设置页"] --> G["settings.section：Web UI 插件组（dsh-web-settings）"]
    G -- "web-ui.plugin.item 子槽" --> C["task-board、remote-web-ui、liangshen 等插件卡"]
    S --> K["settings.section：皮肤中心（skin-center）"]
    S --> P["settings.section：桌宠（dsh-pet）"]
    S --> W["settings.section：创意工坊 dsh-workshop（dsh-market）"]
    W -- "dsh-workshop.panel 子槽" --> F["皮肤、宠物、插件、预设资产面板"]
    F -- "dsh-preset-center 注入" --> F1["Presets 面板"]
    S --> O["plugins.bundle.config：官方 bundle 配置卡（插件管理页）"]
```

## 皮肤系统

皮肤是纯资产目录：事实源在独立仓 [dsh-skins](https://github.com/zhu1090093659/dsh-skins) 的 `skins/`（47 个内置皮肤，本仓以 submodule `satellites/dsh-skins` 的 gitlink 固定要读的提交），npm 包 `files` 白名单只随发默认皮肤 blue-fantasy，其余由创意工坊按需安装到 `$DSH_HOME/skins/<id>/`（同 id 遮蔽内置）。skin-repo 双源发现并做 v2 manifest fail-closed 校验；样式经 `transformSkinCss` 安全管线强制作用域到 `html[data-dsh-skin]` 并按白名单过滤；启用互斥由 `dsh-skin use` 客户端原子切换管理，不改 `cordis.patch.yml`。插件输出语义属性（`data-dsh-plugin` / `data-dsh-part`）才承诺完整换肤覆盖，契约见 [semantic-attrs-v1.md](https://github.com/zhu1090093659/dsh-skins/blob/main/contracts/semantic-attrs-v1.md)。

```mermaid
flowchart LR
    B["内置：独立仓 dsh-skins 的 skins/ 下 47 个皮肤目录（按 gitlink 固定提交）"] --> R["skin-repo 双源发现：v2 manifest fail-closed 校验"]
    U["$DSH_HOME/skins/：工坊按需安装，同 id 遮蔽内置"] --> R
    R -- "transformSkinCss：作用域 + 白名单" --> CSS["html data-dsh-skin 作用域样式"]
    CSS --> SW["运行时无刷新原子切换（dsh-skin use 互斥）"]
    N["npm 包 files 白名单仅随发 blue-fantasy"] -.-> B
```

## 创意工坊

创意工坊站（dsh-market.com）由上游作者运营，是本 fork 之外的服务：卡片只对它发起用户触发的 HTTPS 读取（清单、统计、预览与资产下载），不发送任何遥测、点赞或安装事件。资产安装经本包 host 半区的仅回环网关落盘到 `$DSH_HOME` 对应目录并写入 provenance 清单；插件一键安装走官方插件管理器。内容的事实源（皮肤、宠物、社区索引、预设）在四个卫星仓中维护，经各自仓库发布后由上游站点收录；卫星内容与站点收录的对应关系由上游仓库的文档拥有，本仓只钉扎卫星包版本。在无法访问该站的部署里，卡片保留浏览入口并展示加载失败，一切本机能力（已装列表、复制命令、本机管理入口）不受影响。

```mermaid
flowchart LR
    SITE["dsh-market.com（作者运营的外部市场）"]
    CARD["创意工坊卡片（dsh-market 插件）"] -- "清单 / 统计 / 预览（HTTPS GET，用户触发）" --> SITE
    CARD -- "资产下载经 host 仅回环网关" --> HOME["$DSH_HOME：skins、pets、agent-presets"]
    CARD -- "插件一键安装" --> PM["官方插件管理器"]
```

## 共享层与同步管线

[shared/](../shared/tsdown.client.ts) 是跨包事实源：构建预设与平台模块表之外，`host/` 提供 dsh-home 解析、mount-once、poll-guard、run-guarded、loopback 等宿主侧模块，`client/` 提供设置卡三件套、侧栏入口、sse-leader 等浏览器侧模块。[scripts/sync-shared.mjs](../scripts/sync-shared.mjs) 把副本生成进各消费包（带 generated 头，禁手改），`test:scripts` 的 drift 门禁防副本漂移。两个包（dsh-market、dsh-web-all）提交 `lib/` 构建产物，卫星仓各自在自己的 CI 里守同样的规则，指纹由 `libs:write` 记录、`libs:check` 把关。

```mermaid
flowchart LR
    subgraph sharedbox["shared/（唯一事实源）"]
        PRESET["tsdown.client.ts 构建预设"]
        PLATFORM["web-platform.ts 平台模块表"]
        HOSTM["host/：dsh-home、mount-once、poll-guard、loopback 等"]
        CLIENTM["client/：设置卡三件套、sidebar-entry、sse-leader 等"]
    end
    sharedbox -- "scripts/sync-shared.mjs 生成副本（generated 头）" --> PKGS["消费包 src/ 内同步副本"]
    GATE["test:scripts drift 门禁"] -.-> PKGS
```

## DSH_HOME 数据目录

| 路径 | 用途 | 管理者 |
| --- | --- | --- |
| `$DSH_HOME/profiles/<name>/` | profile：插件行与 node_modules（`@linxin666` 命名空间可被 link-profile 链接到本地构建） | `dsh plugin`、scripts/link-profile.mjs |
| `$DSH_HOME/skins/<id>/` | 用户皮肤资产，同 id 遮蔽内置 | 皮肤中心、创意工坊按需安装 |
| `$DSH_HOME/pets/` | 宠物资产、装饰与语音配置 | dsh-pet、创意工坊按需安装 |
| `$DSH_HOME/agent-presets/<id>/` | 预设库：市场下载落盘于此；宿主半区把它声明给 agent preset 注册表后才生效 | dsh-preset-center、dsh-liangshen |

## 家族包一览

下表仅作导览；权威描述以各包 `package.json` 与 README 为准，聚合关系以 [aggregate.yml](../packages/dsh-web-all/aggregate.yml) 为准。

| 包 | 职责 |
| --- | --- |
| dsh-web-all | 聚合载具包：一键装齐全家桶（含 compat 桥接层） |
| dsh-web-settings | 设置页一级分区：家族插件启停开关与配置表单（`web-ui.plugin.item` 子槽） |
| dsh-plugin-manager | 官方插件页的更新检查：单包区块、列表级检查/批量更新/重启工具条（安装、启停、卸载归官方页面） |
| dsh-market | 创意工坊商店卡：浏览 dsh-market.com 并一键安装皮肤、宠物、插件、预设 |
| dsh-preset-center | 社区预设：惰性库、启停、工坊 Presets 面板（独立仓，以已发布包消费） |
| dsh-community-plugins | community.json 社区插件索引数据源（独立仓，以已发布包消费；惰性 cordis 行） |
| dsh-skins | 皮肤中心：皮肤资产、试穿、无刷新原子切换（独立仓，以已发布包消费） |
| dsh-pet | 注册表驱动桌宠：响应模型活动、命名与好感度（独立仓，以已发布包消费） |
| dsh-task-board | 宿主权威任务板：真实会话执行与 cron 调度 |
| dsh-task-board-github | 任务看板外部提供方扩展：GitHub Issues 同步（默认开启，设置可关） |
| dsh-git-graph | 空会话 git 分支选择器与提交图 |
| dsh-ssh | 远程 SSH：PTY 终端、SFTP、端口转发与 agent 工具 |
| dsh-remote-web-ui | 扫码配对远程访问与可撤销设备会话 |
| dsh-update | 家族自更新：探测 npm 上的新版本并在当前 profile 内就地执行更新 |
| dsh-session-archive | 会话归档：批量归档恢复、级联删除、自动清理策略 |
| dsh-session-id | 侧栏底部 Session ID 面板（纯浏览器半区） |
| dsh-usage | 用量统计：provider 余额、套餐配额与实时 token 流水 |
| dsh-skill-explorer | 技能中心：按来源浏览、启停、创建技能 |
| dsh-model-capabilities | 自定义 provider 的按模型能力声明 |
| dsh-liangshen | 梁神 agent 预设与模式拨杆 |
| dsh-i18n | 俄语语言包与全家族 ru 词典 |

## 门禁与发布流

日常与合并门禁的执行方式见 [development.md](development.md)；发布流程见 [publish-prep.md](publish-prep.md)：tag 是版本唯一来源，[release.yml](../.github/workflows/release.yml) 在 tag 推送后用 scripts/verify-version.mjs 校验各包版本与 tag 一致，再发布 `@linxin666/dsh-*`。

```mermaid
flowchart TB
    DEV["dev 分支改动"] --> G["门禁：typecheck、test、docs:check、i18n:check、aggregate:check、libs:check、test:scripts"]
    G --> M["维护者集成：dev 测试通过后合入 main"]
    M --> T["从 main 打 vX.Y.Z tag"]
    T -- "release.yml + verify-version" --> NPM["npm 发布 @linxin666/dsh-*"]
```
