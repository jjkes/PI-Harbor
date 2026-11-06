# PI-Harbor Desktop

面向 AI 助手的本地优先桌面工作区：Electron 外壳 + Rust 宿主核心 + pi Agent
Harness + 可安装插件。

本项目是 [PI-Desktop](https://github.com/vastsa/PI-Desktop) 的**独立分支（fork）**，
与原项目无隶属关系，也未获得其背书或支持。关于本分支的问题请提到
[本仓库 issues](../../issues)，不要提到上游。

> **当前发布线：0.2.x（早期预览）。** 最新版本为 v0.2.1，发布在本仓库的 Releases；
> 版本号从本分支自己的 0.1.0 起算，不再延续上游版本线。

## 与上游的差异

- 独立的应用身份：`top.jjkets.pi-harbor`、产品名 *PI-Harbor Desktop*、独立的安装包与桌面项命名。因此同一台机器同时安装本分支和上游时，
  两者的数据目录与单实例锁互不干扰。
- 独立的更新源、反馈入口与发布流水线。
- **不使用插件中心。** 插件目录是托管在本仓库的静态文件
  `marketplace/catalog.json`，下载直接使用目录条目里给出的包地址，插件评论不可用。
  不会再访问上游的 `plugins.aiuo.net`。
- macOS 构建需要使用你自己的证书签名与公证；发布流水线里是占位身份，并依赖你自己
  配置的 secrets。

逐项改动记录见 [CHANGES.md](CHANGES.md)。

## 环境要求

- Node.js 22+ 与 pnpm（`corepack enable pnpm`）
- Rust 稳定版工具链（宿主核心是原生二进制）
- 对应平台的桌面外壳构建工具链（见上游开发者文档）

## 开发

```bash
pnpm install
pnpm build          # 构建全部 JS 工作区 + release 版 host-core
pnpm test           # JS 测试 + cargo test -p host-core
pnpm typecheck
pnpm dev            # 启动桌面应用
```

打包命令与上游一致：`pnpm --filter @pi-harbor/desktop run dist:mac | dist:win |
dist:linux`。本地打包不需要签名证书；但**发布** macOS 版本需要你自己的 Developer
ID 与公证凭据，配置为仓库 secrets。

设计与规格文档在 `docs/`，插件开发指南是 `docs/plugin-development.md`，均继承自
上游，描述的是双方共享的架构。

## 分支维护

`docs/FORK.md` 列出分支所有者仍需自行准备的东西（签名证书、插件目录内容、应用商店
上架信息），以及如何持续合并上游改动。

## 许可证

LGPL-3.0-or-later。本分发整体以 GNU Lesser General Public License v3.0 or later
授权，见 [LICENSE](LICENSE)。上游版权声明、分叉点与第三方组件许可证记录在
[NOTICE](NOTICE)，具体改动清单在 [CHANGES.md](CHANGES.md)。发布的二进制随附源码：
本仓库对应 tag。

“PI-Desktop”、PI-Desktop 标识以及上游 GitHub 组织属于上游项目的商标。本分支使用
自己的名称、图标与标识，不主张任何隶属或背书关系。
