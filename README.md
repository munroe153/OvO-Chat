# OvO Chat

> 中文文档在本文档后半部分

Mobile-friendly DeepSeek chat for Obsidian with branching conversations, history, web search, read-only vault tools, and chart rendering.

OvO Chat keeps every conversation as a question → answer tree. You can regenerate an answer, edit a sent question, or continue from any node without losing the other branches. All data stays inside the plugin's own data directory.

## Features

- **Branching conversations** — a question can keep multiple answers; any answer can be continued as a new branch.
- **Editable questions** — edit a sent prompt to create a new branch and regenerate the answer immediately.
- **Conversation tree** — a sidebar view shows the whole session; click any question to jump to it and switch the active path.
- **History** — a dedicated tab with search, tags, time filters, sorting, rename, and bulk delete. The top-bar menu shows the 10 most recent sessions.
- **DeepSeek web search** — uses DeepSeek's official server-side `web_search` tool and shows the sources returned by the model.
- **Read-only vault tools** — search notes, read a note, list notes, and read the active note without modifying the vault.
- **Charts and diagrams** — renders Charts blocks and Mermaid diagrams; Mermaid output is pre-validated and falls back to readable source instead of a parser error.
- **Temporary chat and focus time** — temporary sessions stay in memory only; focus time blocks new generations for a chosen duration.
- **Personalization and syntax options** — optional tone/layout prompts, MathJax / mhchem / Chem-SMILES hints, table spacing, and `==highlight==` rendering.
- **Desktop and mobile** — no Node.js or Electron APIs are required.

## Installation

### Community plugins

After the plugin is listed in the Obsidian community directory:

1. Open **Settings → Community plugins → Browse**.
2. Search for **OvO Chat** and install it.
3. Enable the plugin.

### BRAT (beta)

1. Install and enable the **BRAT** community plugin.
2. Run **BRAT: Add a beta plugin for testing**.
3. Enter `munroe153/OvO-Chat` and confirm.
4. Enable **OvO Chat** in **Settings → Community plugins**.

### Manual installation

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest GitHub Release.
2. Create `<vault>/.obsidian/plugins/ovo-chat/` if it does not exist.
3. Copy the three files into that folder.
4. Reload Obsidian and enable **OvO Chat** in **Settings → Community plugins**.

Do not rename `main.js` or `manifest.json`; Obsidian loads them by exact filename.

## Getting started

OvO Chat uses the DeepSeek API. Create an API key on [platform.deepseek.com](https://platform.deepseek.com) first.

1. Open **Settings → OvO Chat → Keys**.
2. In **DeepSeek API key**, select an existing secret or create a new one (for example `deepseek-api-key`) and paste the key value.
3. Click **Test connection** to verify the key and refresh the model list.

Notes:

- The plugin stores only the **secret name**; the key value is managed by Obsidian's secret storage and is never written to the plugin's `data.json`.
- Secret storage is scoped to the current vault and is **not synced**. Each desktop or mobile device must select or create the key once.
- The minimum supported Obsidian version is **1.11.4**, which introduced the secret storage API.

## Usage

- Type a message and press **Enter** or **Shift+Enter** according to **Settings → Advanced → Keyboard send**; **Ctrl/Cmd+Enter** always sends.
- Use the send button to stop a streaming answer.
- Use the actions below an answer to copy it, regenerate it, or switch between alternative answers.
- Click a question bubble to edit it; saving creates a new branch and regenerates the answer.
- Open the **OvO** sidebar view to browse the question tree and jump to any node. The cursor is runtime-only and resets to the latest path after reopening the plugin.
- Use the top-bar **history** button for the 10 most recent sessions, or **More history** for the full history tab.
- The **ghost** button starts a temporary chat. Temporary chats are never written to disk and are discarded silently when you switch away; they keep only a custom system prompt.
- The **focus** command blocks sending, regenerating, and saving edits until the chosen time. It cannot be ended early.

## Settings

| Tab | What it controls |
| --- | --- |
| **Keys** | DeepSeek API key selection and connection test |
| **Interface** | Reasoning/source collapse behavior and input-toolbar button visibility/order |
| **Parameters** | Default model, thinking effort, temperature, top_p, max_tokens, stop sequences, context length |
| **Tools** | Server-side web search and the built-in read-only vault tools |
| **Prompts** | Personalization, MathJax / mhchem / Chem-SMILES hints, drawing instructions |
| **Advanced** | Markdown syntax fixes and keyboard send behavior |

The personalization master switch is in the chat input toolbar, not in the settings tab.

## Built-in tools

These tools are read-only and can be disabled in **Settings → OvO Chat → Tools**.

| Tool | Description |
| --- | --- |
| `search_notes` | Search Markdown notes and return path, line number, and snippet; supports `folder` and `limit` |
| `read_note` | Read a note by vault path; long notes are truncated according to the configured limit |
| `list_notes` | List note paths, optionally limited to a folder |
| `get_active_note` | Read the currently open note |

## Data and privacy

- Sessions (question/answer trees), the lightweight index, and attachments are stored in `<vault>/.obsidian/plugins/ovo-chat/` (`sessions/`, `sessions.json`, `attachments/<sessionId>/`). No folders are created elsewhere in the vault.
- There is no Markdown export/import; copy individual messages with the copy action.
- Deleting a conversation also deletes its session file and attachment folder.
- The plugin contains **no telemetry or analytics**.
- Network requests go only to the DeepSeek API endpoints used for chat, model listing, and server-side web search. The plugin does not send vault content anywhere except the parts required by the tools you enable and the messages you send.
- API keys are handled by Obsidian's secret storage; the plugin only stores the selected secret name.

## Compatibility

- Obsidian **1.11.4** or newer.
- Desktop, iOS, and Android.
- No Node.js or Electron APIs are used, so `isDesktopOnly` is `false`.

## Development

Requirements: Node.js 20.11+ and pnpm 9.

```bash
pnpm install
pnpm run dev        # watch mode, writes main.js with inline sourcemap
pnpm run check      # tsc --noEmit
pnpm run lint       # ESLint + eslint-plugin-obsidianmd
pnpm run build      # type check + production bundle
```

Build output is a single CommonJS `main.js`; `main.js` is generated and ignored by git. Release assets are built by GitHub Actions from the tag:

```bash
pnpm version 0.1.0 --no-git-tag-version   # updates package.json, manifest.json, versions.json
git add package.json manifest.json versions.json
git commit -m "chore(release): 0.1.0"
git tag -a 0.1.0 -m "0.1.0"                # tag must exactly match manifest.version
git push origin main
git push origin 0.1.0
```

The release workflow verifies that the tag matches `manifest.json`, builds the plugin, generates build provenance, and creates a **draft** GitHub Release with `main.js`, `manifest.json`, and `styles.css`. Review the draft and publish it manually.

Before the first release, make the GitHub repository public and set **Settings → Actions → General → Workflow permissions** to **Read and write permissions** so the workflow can create the release.

## Feedback

Please report bugs and feature requests in [GitHub Issues](https://github.com/munroe153/OvO-Chat/issues). Include your Obsidian version, platform, and the steps to reproduce.

## License

MIT © 2026 munroe153. See [LICENSE](LICENSE).

---

# OvO Chat（中文）

移动端友好的 DeepSeek 分支对话插件：问答树管理、历史记录、联网搜索、只读工具组与 Charts / Mermaid 图表绘制。

OvO Chat 把每段对话保存为「问 → 答」映射树：同一问句可以保留多个答案（一键重新生成），任意答案都能继续追问；编辑已发送的问句会作为新分支保留原问句。全部数据只保存在插件自己的数据目录中。

## 功能

- **分支对话**：同一问句支持多个答案，任意节点都能继续追问。
- **问句可编辑**：编辑已发送的提示词后立即重新生成答案，并保留原问句分支。
- **对话树**：侧边栏「OvO」视图展示整个会话，点击任意问句即可跳转并切换激活路径。
- **历史记录**：独立标签页支持按标题 / 标签搜索，按标签、创建时间、修改时间筛选与排序，并支持重命名、删除和批量删除；顶栏菜单展示最近 10 条。
- **联网搜索**：调用 DeepSeek 官方服务端 `web_search` 工具，并展示模型返回的来源。
- **只读工具组**：检索笔记、读取笔记、列出笔记、读取当前笔记，不会修改库内容。
- **图表绘制**：支持 Charts 代码块与 Mermaid；Mermaid 会先做语法预校验，无法解析时降级为「提示 + 源码」。
- **临时对话与专注时间**：临时对话只存在内存中；专注时间在设定时长内阻止发起新的生成。
- **个性化与语法增强**：可选的语气 / 排版提示词、MathJax / mhchem / Chem-SMILES 提示、表格前后留空与 `==高亮==` 渲染。
- **桌面端与移动端可用**：不依赖 Node.js / Electron API。

## 安装

### 社区插件市场

插件进入 Obsidian 社区目录后：

1. 打开 **设置 → 第三方插件 → 浏览**。
2. 搜索 **OvO Chat** 并安装。
3. 启用插件。

### BRAT（测试版）

1. 安装并启用 **BRAT** 社区插件。
2. 执行 **BRAT: Add a beta plugin for testing**。
3. 输入 `munroe153/OvO-Chat` 并确认。
4. 在 **设置 → 第三方插件** 中启用 **OvO Chat**。

### 手动安装

1. 从最新 GitHub Release 下载 `main.js`、`manifest.json`、`styles.css`。
2. 如不存在，创建 `<库>/.obsidian/plugins/ovo-chat/`。
3. 把三个文件复制到该目录。
4. 重载 Obsidian，在 **设置 → 第三方插件** 中启用 **OvO Chat**。

不要重命名 `main.js` 或 `manifest.json`，Obsidian 按固定文件名加载。

## 快速开始

OvO Chat 使用 DeepSeek API，请先在 [platform.deepseek.com](https://platform.deepseek.com) 创建 API Key。

1. 打开 **设置 → OvO Chat → 密钥**。
2. 在 **DeepSeek API Key** 中选择已有密钥，或新建一个（例如 `deepseek-api-key`）并粘贴密钥值。
3. 点击 **测试连接** 验证密钥并刷新模型列表。

注意事项：

- 插件只保存**密钥名**；密钥值由 Obsidian 内置密钥库托管，不会写入插件的 `data.json`。
- 密钥库与当前库绑定，**不随库同步**；桌面端和移动端需要各自选择或新建一次密钥。
- 最低支持 Obsidian **1.11.4**（密钥库 API 的引入版本）。

## 使用

- 按 **设置 → 高级 → 键盘发送** 的配置使用 **Enter** 或 **Shift+Enter** 发送；**Ctrl/Cmd+Enter** 始终发送。
- 点击发送按钮可在流式生成中停止。
- 答案下方提供复制、重新生成和多答案切换操作。
- 点击问句气泡可编辑；保存后作为新分支重新生成答案。
- 打开侧边栏「OvO」视图可浏览问答树并跳转到任意节点。游标是运行时状态，重开插件后会回到整条激活路径末端。
- 顶栏「历史」菜单展示最近 10 条；末尾「更多历史记录」打开完整历史页。
- 顶栏 ghost 按键进入临时对话：不落盘，切换会话时静默丢弃，只保留自定义 system prompt。
- 专注时间命令会在设定时长内阻止发送、重新生成与保存编辑，且不支持提前结束。

## 设置页

| 分页 | 内容 |
| --- | --- |
| **密钥** | DeepSeek API Key 选择与连接测试 |
| **界面** | 思考内容 / 搜索来源折叠行为，输入区工具栏按键的显示与顺序 |
| **调参** | 默认模型、思考强度、temperature、top_p、max_tokens、停止序列、上下文长度 |
| **工具** | 服务端联网搜索与内置只读工具组 |
| **提示词** | 个性化、MathJax / mhchem / Chem-SMILES、绘图提示 |
| **高级** | Markdown 语法修正与键盘发送行为 |

个性化总开关位于对话输入区工具栏，不在设置页内。

## 内置工具

以下工具均为只读，可在 **设置 → OvO Chat → 工具** 中关闭。

| 工具 | 说明 |
| --- | --- |
| `search_notes` | 检索 Markdown 笔记，返回路径、行号与片段；支持 `folder` 限定目录、`limit` 限制条数 |
| `read_note` | 按库内路径读取一篇笔记全文（超长按设置的读取范围截断） |
| `list_notes` | 列出库内笔记路径，支持 `folder` 限定目录 |
| `get_active_note` | 读取当前打开的笔记 |

## 数据与隐私

- 会话（问答树）、轻量索引与全部附件保存在 `<库>/.obsidian/plugins/ovo-chat/`（`sessions/`、`sessions.json`、`attachments/<sessionId>/`），不在库内生成其他文件夹。
- 不提供 Markdown 全文导出 / 导入；单条消息可通过复制按钮导出。
- 删除对话会一并删除其会话文件与附件目录。
- 插件**不包含遥测或统计**。
- 网络请求仅发往 DeepSeek 的对话、模型列表与服务端联网搜索接口；除你发送的消息与启用的工具所需内容外，不会上传库内容。
- API Key 由 Obsidian 密钥库托管，插件只保存所选的密钥名。

## 兼容性

- Obsidian **1.11.4** 及以上。
- 桌面端、iOS 与 Android。
- 不使用 Node.js / Electron API，因此 `isDesktopOnly` 为 `false`。

## 开发

要求：Node.js 20.11+、pnpm 9。

```bash
pnpm install
pnpm run dev        # 监听模式，生成带内联 sourcemap 的 main.js
pnpm run check      # tsc --noEmit
pnpm run lint       # ESLint + eslint-plugin-obsidianmd
pnpm run build      # 类型检查 + 生产构建
```

构建产物是单个 CommonJS `main.js`，由 esbuild 生成且不入库。发布资产由 GitHub Actions 从 tag 构建：

```bash
pnpm version 0.1.0 --no-git-tag-version   # 同步 package.json / manifest.json / versions.json
git add package.json manifest.json versions.json
git commit -m "chore(release): 0.1.0"
git tag -a 0.1.0 -m "0.1.0"                # tag 必须与 manifest.version 完全一致
git push origin main
git push origin 0.1.0
```

发布工作流会校验 tag 与 `manifest.json` 一致，构建插件、生成来源证明，并创建包含 `main.js`、`manifest.json`、`styles.css` 的 **draft** Release；确认后手动 Publish。

首次发布前，请把 GitHub 仓库设为公开，并在 **Settings → Actions → General → Workflow permissions** 选择 **Read and write permissions**，否则工作流无法创建 Release。

## 反馈

请在 [GitHub Issues](https://github.com/munroe153/OvO-Chat/issues) 报告问题或提出建议，并附上 Obsidian 版本、平台与复现步骤。

## 许可

MIT © 2026 munroe153，详见 [LICENSE](LICENSE)。
