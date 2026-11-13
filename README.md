# OvO Chat

[简体中文](README.zh-CN.md)

> Chat with DeepSeek inside Obsidian — and before you know it, you've grown a tree of questions and answers.

OvO Chat is a third-party Obsidian plugin. It saves every conversation as a "question → answer" tree instead of a straight line you can only scroll down: a single question can have several answers, any answer can be followed up on, and editing an already-sent question won't lose the original branch.

All of the plugin's data lives in its own folder — it won't scatter files around your vault. Works on desktop, iOS, and Android.

---

## What It Can Do

A quick at-a-glance version:

- **Branching conversations**: one question with many answers, continue from any node, edit a question while keeping the original, and no need to start over when a thread goes the wrong way.
- **Conversation tree sidebar**: see the whole branching structure of a session laid out flat; click any node to jump to it.
- **History**: search, tag, filter by date, sort, rename, bulk delete — it's all there.
- **Web search**: calls DeepSeek's official server-side web tool directly, with sources listed under the answer.
- **Reads your notes**: the model can search notes, read notes, list notes, and read the currently open one — all read-only, nothing in your vault gets modified.
- **Charts and diagrams**: supports Charts and Mermaid — flowcharts, sequence diagrams, Gantt charts, mind maps.
- **Image attachments**: upload, paste, or drag and drop; one click drops the current note into the conversation.
- **Temporary chat**: an off-the-record mode that never touches disk — close it and it's gone.
- **Focus time**: block out a stretch of "no chatting" time — a cure for itchy fingers.
- **Personalization**: tune tone, friendliness, enthusiasm, emoji, and layout style.
- **Syntax enhancements**: MathJax formulas, mhchem chemistry, Chem molecular structures, plus rendering fixes for tables and highlights.
- **Works on mobile too**: no Node.js or Electron dependency; `isDesktopOnly` is `false`.

---

## Installation

### Prerequisites

- Obsidian **1.11.4** or later (that's the version that ships the secret-storage API the plugin needs).

### Install from the community plugin marketplace (if it's listed)

1. Open **设置 → 第三方插件 → 浏览** (Settings → Community plugins → Browse).
2. Search for **OvO Chat**, then install and enable it.

### Manual installation

1. Download `main.js`, `manifest.json`, and `styles.css` from the releases page.
2. Create the folder `<vault>/.obsidian/plugins/ovo-chat/` in your vault (if it doesn't already exist).
3. Drop the three files in.
4. Reload Obsidian and enable **OvO Chat** under **设置 → 第三方插件**.

> Don't rename `main.js` or `manifest.json` — Obsidian loads them by their fixed names.

---

## First Run: Set Up Your Key

OvO Chat talks to the official DeepSeek API, so first create an API key at [platform.deepseek.com](https://platform.deepseek.com).

1. Open **设置 → OvO Chat → 密钥** (Settings → OvO Chat → Keys).
2. Under **API 密钥** (API key), pick an existing key or create a new one (say, `deepseek-api-key`), then paste the key value in.
3. Click **测试连接** (Test connection). On success it tells you which models are currently available, and refreshes the model list while it's at it.

A few things to keep in mind:

- The plugin only stores the key's **name**; the value is held by Obsidian's built-in secret storage and never written to the plugin's `data.json`.
- Secret storage is bound to the current vault and **does not sync with it**. New computer, new phone — you configure it again on each one.
- You can open the UI without a key, but sending a message will prompt you to set one up.

---

## Opening the Chat Window

Three ways, take your pick:

- Click the **message bubble icon** in the left ribbon.
- Search the command palette for **打开对话窗口**.
- Search the command palette for **新建对话** to start a fresh conversation.

There are a few other commands as well:

| Command | What it does |
| --- | --- |
| 打开对话窗口 | Open or switch to the chat tab |
| 新建对话 | Start a new conversation |
| 打开对话树（侧边栏） | Open the Q&A tree in the right sidebar |
| 打开历史记录 | Open the full history page |
| 专注时间 | Start a focus session |

### What the interface looks like

From top to bottom, the chat window is roughly:

```
┌ Top bar: title / locate / temporary chat / history / new
├ Input area: toolbar + attachment previews + input box + send button
├ Message stream: Q&A / thinking / sources / tool calls
└ Status bar: model + estimated context tokens
```

The input box sits at the top for iPad's sake: it's less likely to be covered when the soft keyboard pops up.

### Sending messages

- By default **Enter sends, Shift+Enter inserts a newline**; you can flip that in **设置 → 高级 → 发送键方案** (Settings → Advanced → Send key scheme).
- **Ctrl/Cmd+Enter always sends** — use that if you can't remember the setting.
- Pressing Enter while picking candidates in a Chinese IME won't send by accident.
- While generating, the send button turns into a **Stop** button; one click cuts it off. Whatever has already been generated is kept, with "已停止生成" (generation stopped) appended at the end.

---

## Core Concept: Growing a Conversation into a Tree

This is where OvO Chat is most different, and it deserves its own section.

An ordinary chat is a single line of questions and answers. In OvO Chat, every question is a node, and a node can carry:

- **Multiple answers**: regenerate the same question a few times and each answer is stored; flip between them at any time.
- **Multiple sub-questions**: follow up from a given answer and a new sub-branch grows.
- **Rewritten questions**: editing an already-sent question creates a sibling branch; the original branch stays exactly as it was.

### Regenerate to collect more answers

Click the **refresh icon** under an answer to generate another answer to the same question. The old one isn't lost — a switcher like `‹ 1/2 ›` appears under the answer, and the arrows page back and forth.

### Edit a question, keep the original branch

Hover over a message you sent (on mobile, tap the pencil button near the bubble) and click the **pencil**:

- The bubble turns into an input box.
- Edit it, then click **保存并生成** (Save and generate) — on desktop you can also just press Enter; Esc cancels.
- The new question is attached as a **sibling** of the original; the original question, all its answers, and its sub-branches are preserved in full.
- After saving, an answer to the new question is generated right away.

### Continue from any node

Open the **OvO** conversation tree in the right sidebar and you'll see the branching structure of the whole session:

- The highlighted line is the active path.
- Each node shows a summary of the question; nodes with more than one answer carry a `×N` badge.
- Click any node and the chat window jumps to that question, truncating the current path there.
- Send a message from there and a new branch grows downward from that node.

> Tip: this "which node am I on" cursor lives only in the current session. Reopen the plugin or the session and you're back at the end of the active path.

### Jump to the last question

The **anchor icon** in the top bar scrolls back to the last question on the current path in one click, without changing any branch state.

---

## History

The **history icon** in the top bar pops up the 10 most recent conversations, with "更多历史记录" (More history) and "删除当前对话" (Delete current conversation) at the bottom.

To see everything, open the full **历史记录** tab:

- **Search**: by title or tag, case-insensitive.
- **Tag filter**: click tag chips; with several selected, a conversation must contain **all** of them.
- **Date filter**: by creation or modification time — today / last 7 days / last 30 days / all.
- **Sort**: by modification or creation time, newest or oldest first.
- **Manage**: each row can edit tags, rename, or delete; you can also tick several and bulk delete.

Tags can be separated by English or Chinese commas — `工作, 读书笔记` — and leaving the field empty clears the tags. Renaming and tag edits **do not** refresh the "modified" timestamp, so they won't scramble your history ordering.

Deleting a conversation can't be undone: the session file and its attachment folder go together.

---

## Web Search

Click the **联网** (Web) button in the input toolbar; the icon lights up when it's on.

- It doesn't scrape the web itself — it uses DeepSeek's official server-side `web_search` tool.
- While searching, it shows "正在联网搜索：关键词…" (Searching the web: keyword…).
- A **来源（N）** (Sources) section appears under the answer, collapsed by default; expand it for the list of links.
- Each answer's metadata is marked **🌐 已联网检索** (web search used) or **⚠️ 未触发联网检索** (web search not triggered), so you can tell whether the model actually searched.
- The plugin also nudges the model: for anything that might be out of date, search first instead of answering from memory.

The web toggle is runtime state of the **current chat window**; the initial value when a window opens is set in **设置 → 工具** (Settings → Tools).

---

## Letting the Model Read Your Notes

Click the **工具** (Tools) button in the input toolbar and the model can call four built-in read-only tools:

| Tool | What it does |
| --- | --- |
| `search_notes` | Search Markdown notes across the vault, returning path, line number, and snippet; supports folder scoping and a result limit |
| `read_note` | Read a whole note by vault path; truncated if it's too long |
| `list_notes` | List note paths in the vault, optionally limited to a single folder |
| `get_active_note` | Read the note you currently have open |

A few practical notes:

- These tools are **strictly read-only** — they never modify, create, or delete any note.
- In a single reply the model can make at most 8 consecutive rounds of tool calls, so it can't loop forever.
- Each call shows as a line in the message; expand "参数 / 结果" (arguments / result) to see exactly what was called and what came back.
- The per-read character cap is set in **设置 → 工具 → 读取范围** (Settings → Tools → Read limit); default 20000, range 1000–200000.
- Tool-call mode is also runtime state for the current chat window; whether it's on by default when a window opens is set in **设置 → 工具** as well.

> Tools and web search can be on at the same time. Web search runs on DeepSeek's servers; the built-in tools run locally in the plugin — they don't get in each other's way.

---

## Attachments and the Current Note

### Image attachments

Three ways to add an image:

- Click **附件** (paperclip) in the toolbar and pick a file.
- **Paste** an image straight into the input box.
- **Drag** an image into the input area.

Limits and details:

- PNG / JPG / GIF / WebP, up to **16MB** each.
- Keep the total attachments in one send under about **40MB**, or it'll be blocked.
- You can preview and remove them individually before sending.
- Images are stored under the plugin folder at `attachments/<session id>/`; the session file keeps only references, so base64 doesn't get smeared everywhere.

### Drop in the current note

Click **当前笔记** (Current note) in the toolbar and the note you have open is attached to this message as a text attachment. Handy for "summarize this for me" or "turn this into an outline."

> File attachments are images only; the current note is the only way to attach text.

---

## Diagram Mode

Click the **绘图** (Draw) button in the input toolbar and the plugin injects chart syntax instructions into the system prompt. After that, just say "draw me a bar chart of quarterly sales" and so on.

### Two kinds of diagrams

**Charts** (`chart` code blocks):

- Requires the **Charts** (`obsidian-charts`) plugin installed and enabled in your vault, otherwise the block won't render as a chart.
- Supports bar / horizontal bar, line / area, pie, donut, radar, and polar area charts.

**Mermaid** (`mermaid` code blocks):

- Rendered natively by Obsidian; no extra plugin needed.
- Supports flowcharts, sequence diagrams, Gantt charts, timelines, mind maps, and kanban.

### Only draw the types you want

Go to **设置 → 提示词 → Charts 图表 / Mermaid 图表** and untick the types you don't need. Diagram mode only injects prompts for the ticked types — saves tokens and keeps things on track. Everything is ticked by default.

### What if the Mermaid comes out broken

The model occasionally makes small Mermaid syntax mistakes (the most common is a missing half-quote on an edge label). The plugin will:

1. First try a narrow fix, e.g. closing the quote.
2. Run a syntax pre-check using Obsidian's own Mermaid instance.
3. If it really can't be fixed, fall back to "⚠️ parse failed + raw source" rather than throwing a parse error in your face.
4. During streaming, a half-finished Mermaid block is shown as a code block first and only properly rendered once the answer is complete.

All of this affects only **what's rendered** — the original text stored in the conversation is untouched.

---

## Temporary Chat (Ghost Mode)

The **ghost icon** in the top bar is temporary chat.

Once it's on:

- The conversation lives only in memory, **never written to disk**, and attachments aren't saved either.
- No personalization prompt and no syntax-enhancement prompt is injected (the current date is still passed to the model).
- The top-bar title becomes "临时对话" (Temporary chat), and after the first message the title is prefixed with "临时 · ".
- Clicking the ghost icon to exit, switching to a history conversation, or starting a new conversation **silently discards** the temporary record.
- Exiting temporary chat returns you to the conversation you were in before.

Good for private, one-off questions you don't want leaving a trace in your history.

---

## Focus Time

Search the command palette for **专注时间** (Focus time):

1. Enter a duration. A plain number is minutes; `25m`, `1h`, `1小时30分钟` all work too. Range: 1 minute to 24 hours.
2. Check the end time and confirm.
3. Once it starts, **sending messages, regenerating, and saving question edits** are all blocked, with a note of how many minutes are left.

The rules are simple and hard:

- Browsing history and reading old conversations is unrestricted.
- **You can't end it early.** It lifts automatically when time's up.
- The end timestamp is stored in plugin settings, so reloading Obsidian doesn't reset it.
- Running the command again during a focus session just tells you how long is left.

---

## Personalization: Make Answers Sound More Like What You Want

The **个性化** (Personalization) button in the input toolbar is the master switch. When it's on, style instructions for the levels chosen in **设置 → 提示词 → 个性化** are injected into the system prompt.

What you can tune:

- **Base style and tone**: 默认 (default), 专业可靠 (professional & reliable), 亲和友善 (friendly), 直言不讳 (blunt), 天马行空 (wildly imaginative), 高效务实 (efficient & pragmatic), 吐槽达人 (snark master).
- **Friendliness**: more / default / less.
- **Enthusiasm**: more / default / less.
- **Emoji**: more / default / less.
- **Layout and visual elements**: default / minimal.

Any dimension left on "default" injects nothing. Turn the master switch off and all your choices are kept but nothing is injected. Temporary chat never injects personalization prompts.

> These prompts only shape tone and layout — they won't make the model make up facts.

---

## Syntax Enhancements

### Math and chemistry

Turn the relevant switches on in **设置 → 提示词**:

- **MathJax**: have the model write formulas with `$…$` and `$$…$$`; Obsidian renders them natively.
- **mhchem**: have the model write chemical formulas with `\ce{}`; Obsidian supports this built in.
- **Chem plugin**: have the model output molecular structures in `smiles` code blocks, one per line. This needs the **Chem** (`chem`) plugin installed; the settings page reminds you if it isn't.

### Pre-render fixes

Under **设置 → 高级 → Obsidian 语法修正** there are two switches, both on by default:

- **Blank lines around tables**: tables pressed right up against body text get blank lines added, so they don't render glued to the surrounding context.
- **`==highlight==` normalization**: full-width `＝＝`, triple equals, and the like are normalized to `==`, and stray spaces inside the markers are trimmed.

Both fixes apply only to the **rendered copy**; the original text saved in the chat log isn't changed. Code blocks, inline code, and formulas aren't touched either.

---

## Settings Reference

| Tab | What's in it |
| --- | --- |
| **密钥** (Keys) | Choose / create a DeepSeek API key, test the connection |
| **界面** (Interface) | Collapse thinking and sources by default; show/hide and reorder toolbar buttons |
| **调参** (Parameters) | Default model, default thinking effort, system prompt, current date, temperature, top_p, max_tokens, stop sequences, context length, and token budget |
| **工具** (Tools) | Whether new conversations default to web search / tool calls; character cap for reading notes |
| **提示词** (Prompts) | Personalization levels; MathJax / mhchem / Chem; chart type checkboxes for Charts and Mermaid |
| **高级** (Advanced) | Table and highlight fixes; send-key scheme |

A few notes on the parameters:

- **temperature**: 0–2, the higher the wilder. Has no effect in thinking mode.
- **top_p**: 0–1. In thinking mode the official API only accepts 0.95–1.0.
- **max_tokens**: 0 means unlimited, left to the server (watch your wallet).
- **Context length**: how many recent messages to carry; 0 means all.
- **Context token budget**: keep messages from the newest backwards within an estimated token budget; 0 means unlimited.

Which toolbar buttons show, and in what order, is also configurable in **设置 → 界面 → 工具栏按键** with toggles and up/down arrows.

---

## Where Data Lives, and Privacy

### Data location

All in the plugin's own folder:

```
<vault>/.obsidian/plugins/ovo-chat/
├── sessions/<session id>.json   # the Q&A tree for each conversation
├── sessions.json                # lightweight index: titles, times, tags
└── attachments/<session id>/    # images and other attachments
```

No folders are created anywhere else in your vault.

### Privacy

- The plugin has **no telemetry, no analytics**.
- Network requests go only to the official DeepSeek endpoints: chat, model list, server-side web search.
- Apart from the messages you send and the note content the model reads when you turn on tools, nothing else in your vault is uploaded.
- The API key is managed by Obsidian's secret storage; the plugin config only stores the key name.
- The endpoint is hard-coded to the official address — **no third-party relays or proxies** are supported.
- Deleting a conversation deletes the session file and its attachment folder, irreversibly.
- There's no full-Markdown export/import; to keep a copy, copy individual messages or save them yourself.

---

## FAQ

**Q: Why isn't the newest model in the model dropdown?**
The model list is pulled from the official `GET /models` at startup and cached for 6 hours. Click **测试连接** under **设置 → 密钥** to force a refresh. Without a key configured, a built-in fallback list is shown.

**Q: Why do I have to set up the key again on mobile?**
Secret storage is bound to the current vault and doesn't sync with it. Every device needs the key selected or created once.

**Q: Web search is on, but there are no sources under the answer?**
Check the answer metadata: if it says **⚠️ 未触发联网检索**, the model didn't actually call search that round. Try rephrasing, explicitly asking it to "search for the latest news," or regenerating.

**Q: The chart code appears but isn't rendered as a chart?**
Charts (`chart` blocks) need the `obsidian-charts` plugin; SMILES needs the `chem` plugin. Mermaid is native to Obsidian. If the Mermaid syntax truly can't be fixed, you'll see "warning + source" rather than a blank screen.

**Q: Why can't I send messages?**
First check whether you got a "当前处于专注时间" (you're in a focus session) popup. If so, you just have to wait — it can't be ended early. If not, check whether your API key is configured.

**Q: What do I do about 401 / 402 / 429?**
The plugin translates common status codes into plain language: 401 means the key is invalid or missing, 402 means insufficient balance, 429 means too many requests. Just follow the prompt.

**Q: Can I use a third-party API relay?**
No. OvO Chat is locked to the official `api.deepseek.com` endpoint.

**Q: Can conversations be exported to Markdown?**
There's no whole-conversation export. Individual messages can be copied as Markdown with the copy button under the bubble.

---

## License

MIT © 2026 munroe153, see [LICENSE](LICENSE).