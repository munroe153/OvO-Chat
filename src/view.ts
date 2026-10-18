/**
 * OvO Chat 聊天视图 — 独立标签页，复刻 DeepSeek 网页版体验
 *
 * 会话以「问→答映射」树组织（ChatTurn）：渲染、上下文与统计均基于显示路径
 * （activePath 沿 activeChild 链 + 游标 cursorTurn 截断）。新问句挂到显示路径
 * 末端；重新生成向 turn 追加答案；侧边栏可跳转到任意问句并从该节点续聊。
 *
 * 布局（为 iPad 优化，输入框置顶防止被软键盘遮挡）：
 * ┌─────────────────────────────┐
 * │ 顶栏：标题 / 历史 / 新对话     │
 * ├─────────────────────────────┤
 * │ 工具栏：模型 · 思考强度 · 联网 │  ← 输入区在顶部
 * │ 附件预览                     │
 * │ 输入框              [发送/停止]│
 * ├─────────────────────────────┤
 * │ 消息流（滚动，显示路径）        │
 * └─────────────────────────────┘
 *
 * Author: munroe153
 */

import {
	ItemView,
	WorkspaceLeaf,
	MarkdownRenderer,
	Menu,
	Notice,
	Platform,
	setIcon,
} from "obsidian";
import type { OVOChatPlugin } from "./main";
import type {
	ChatTurn,
	OVOAttachment,
	OVOMessage,
	OVOMessageSource,
	OVOModelInfo,
	OVOSession,
	OVOToolbarButtonId,
	OVOToolCallRecord,
	OVOUsage,
	ThinkingEffort,
} from "./types";
import { genId, activePath, activeAnswerOf, walkTurns } from "./types";
import type { StreamHandlers, StreamResult, ToolCallDraft } from "./api/deepseek";
import { buildAnthropicMessages, estTokens, todayPrompt, WEB_SEARCH_NUDGE } from "./chat/prompt";
import { buildDrawingPrompt } from "./drawing";
import { buildPersonalizationPrompt } from "./personalize";
import { buildSyntaxPrompt, correctAssistantMarkdown } from "./syntax";
import { hasMermaidRenderError, neutralizeMermaidFences, prepareMermaidForRender } from "./mermaid";
import { ConfirmModal } from "./modal";
import type { OVOBuiltinTool } from "./tools/types";
import { errMsg, isImeComposing } from "./util";

export const CHAT_VIEW_TYPE = "ovo-chat-view";

const MAX_IMAGE_BYTES = 16 * 1024 * 1024; // 图片上限（官方上限 32MiB，base64 会膨胀，留余量）
const MAX_TEXT_CHARS = 200_000; // 文本附件上限
const MAX_TOOL_ROUNDS = 8; // 单轮回复的工具调用循环上限（防死循环）

const EFFORT_LABELS: Record<ThinkingEffort, string> = {
	off: "思考：关闭",
	low: "思考：低",
	medium: "思考：中",
	high: "思考：高",
	max: "思考：极大",
};

interface MessageElRefs {
	root: HTMLElement;
	bodyEl?: HTMLElement;
	contentEl: HTMLElement;
	reasoningDetails?: HTMLDetailsElement;
	reasoningBody?: HTMLElement;
	reasoningSummary?: HTMLElement;
	metaEl?: HTMLElement;
	sourcesEl?: HTMLElement;
	searchingEl?: HTMLElement;
	toolsEl?: HTMLElement;
}

export class OVOChatView extends ItemView {
	navigation = false;

	session!: OVOSession;
	/** 临时对话：会话仅存于内存（不落盘，且不注入个性化 / 语法增强提示词） */
	private tempMode = false;
	/** 进入临时对话前的会话（关闭临时对话时恢复；切走则丢弃） */
	private preTempSession: OVOSession | null = null;
	private tempBtn!: HTMLButtonElement;

	/** 游标：续聊位置（显示路径在该 turn 截断，从该节点继续对话；null = 路径延伸到叶子） */
	private cursorTurn: ChatTurn | null = null;
	/** 正在编辑的问句（同一时间仅允许一处编辑态；取消 / 保存 / 整树重渲后清空） */
	private editingTurn: ChatTurn | null = null;
	/** 当前渲染的 turn 元素索引（turnId → 问句/答案元素；跳转定位与答案就地替换用） */
	private turnEls = new Map<string, { questionEl: HTMLElement; answerEl?: HTMLElement }>();

	private model = "deepseek-flash";
	private effort: ThinkingEffort = "high";
	private webSearch = false;
	/** 工具调用模式：开启后把内置工具组提供给模型（会话级开关，初值取设置中的默认值） */
	private toolMode = false;
	/** 绘图模式：开启后向模型注入图表提示词（会话级开关，默认关闭） */
	private drawing = false;

	private pendingAttachments: OVOAttachment[] = [];
	private abort: AbortController | null = null;
	private streaming = false;
	private autoScroll = true;

	private messagesEl!: HTMLElement;
	private messagesWrapEl!: HTMLElement;
	private inputEl!: HTMLTextAreaElement;
	private fileInput!: HTMLInputElement;
	private previewEl!: HTMLElement;
	private titleEl!: HTMLElement;
	private statusRightEl!: HTMLElement;
	private sendBtn!: HTMLButtonElement;
	private modelSelect!: HTMLSelectElement;
	private effortSelect!: HTMLSelectElement;
	private searchChip!: HTMLButtonElement;
	private toolChip!: HTMLButtonElement;
	private drawChip!: HTMLButtonElement;
	private personalizeChip!: HTMLButtonElement;
	private scrollBtn!: HTMLButtonElement;

	private mdRenderTimer: number | null = null;

	constructor(leaf: WorkspaceLeaf, private plugin: OVOChatPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return CHAT_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "OvO Chat";
	}

	getIcon(): string {
		return "message-circle";
	}

	/** 是否正在流式生成（渲染类设置即时刷新时跳过生成中的视图） */
	isStreaming(): boolean {
		return this.streaming;
	}

	async onOpen(): Promise<void> {
		// 关键：Obsidian 不会给视图容器自动加 class（只有 data-type 属性），
		// 必须手动挂上，否则 .ovo-chat-view 上的全部 CSS 变量不生效
		this.contentEl.addClass("ovo-chat-view");

		const s = this.plugin.settings;
		this.model = s.defaultModel || "deepseek-flash";
		this.effort = s.defaultEffort;
		this.webSearch = s.defaultWebSearch;
		this.toolMode = !!s.defaultToolMode;

		const lastId = this.plugin.lastSessionId;
		this.session = (lastId ? await this.plugin.store.getSession(lastId) : null) ?? this.plugin.store.newSession();
		this.plugin.lastSessionId = this.session.id;
		this.cursorTurn = null;
		// 会话文件中附件正文已剥离：打开时按 vaultPath 回读（回读失败降级为占位）
		if (this.session.turns.length) await this.plugin.store.hydrateAttachments(this.session);

		this.buildDom();
		await this.populateModels();
		this.rerenderAll();
	}

	async onClose(): Promise<void> {
		this.abort?.abort();
		if (this.mdRenderTimer) window.clearTimeout(this.mdRenderTimer);
	}

	/* ================= DOM 构建 ================= */

	private buildDom(): void {
		const root = this.contentEl;
		root.empty();
		const chat = root.createDiv("ovo-chat");

		/* ---- 顶栏 ---- */
		const topbar = chat.createDiv("ovo-topbar");
		const logo = topbar.createDiv("ovo-logo");
		setIcon(logo, "message-circle");
		this.titleEl = topbar.createDiv("ovo-title");
		this.titleEl.setText(this.session.title || "新对话");
		topbar.createDiv("ovo-topbar-spacer");

		const mkTopBtn = (icon: string, tooltip: string, cb: (evt: MouseEvent) => void) => {
			const btn = topbar.createEl("button", { cls: "ovo-icon-btn clickable-icon" });
			btn.setAttribute("aria-label", tooltip);
			setIcon(btn, icon);
			btn.addEventListener("click", cb);
			return btn;
		};
		mkTopBtn("anchor", "定位到最后一个问句", () => this.jumpToLastQuestion());
		this.tempBtn = mkTopBtn("ghost", "临时对话（不保存对话记录）", () => void this.toggleTempMode());
		mkTopBtn("history", "历史对话", (e) => void this.showHistory(e));
		mkTopBtn("plus", "新对话", () => void this.newChat());

		/* ---- 输入区（顶部） ---- */
		const composer = chat.createDiv("ovo-composer");

		// 工具栏：按键的显示与顺序由设置「界面」分页控制
		const toolbar = composer.createDiv("ovo-toolbar");
		const factories: Record<OVOToolbarButtonId, () => HTMLElement> = {
			model: () => this.buildModelSelect(toolbar),
			effort: () => this.buildEffortSelect(toolbar),
			webSearch: () => this.buildSearchChip(toolbar),
			toolMode: () => this.buildToolChip(toolbar),
			drawing: () => this.buildDrawChip(toolbar),
			personalize: () => this.buildPersonalizeChip(toolbar),
			attach: () => this.buildAttachChip(toolbar),
			note: () => this.buildNoteChip(toolbar),
		};
		for (const btn of this.plugin.settings.toolbarButtons) {
			if (!btn.visible) continue;
			const factory = factories[btn.id];
			if (factory) toolbar.appendChild(factory());
		}

		// 隐藏文件选择器
		this.fileInput = composer.createEl("input", {
			type: "file",
			attr: { multiple: "true", accept: "image/*,.md,.markdown,.txt,.json,.csv,.yaml,.yml,.xml,.html,.css,.js,.ts,.py,.sh,.log" },
		});
		this.fileInput.hide();
		this.fileInput.addEventListener("change", () => {
			const files = Array.from(this.fileInput.files ?? []);
			this.fileInput.value = "";
			void this.addFiles(files);
		});

		this.previewEl = composer.createDiv("ovo-att-preview");
		this.previewEl.hide();

		const inputRow = composer.createDiv("ovo-input-row");
		this.inputEl = inputRow.createEl("textarea", {
			cls: "ovo-input",
			attr: {
				placeholder: this.sendHint(),
				rows: "1",
			},
		});
		this.inputEl.addEventListener("input", () => this.autoResize());
		this.inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
			if (e.key !== "Enter") return;
			if (isImeComposing(e)) return; // 中文输入法
			// 桌面端与移动端行为一致：Ctrl/Cmd+Enter 始终发送；
			// Enter 与 Shift+Enter 的分工按设置「个性化 → 键盘发送」
			const shouldSend =
				e.ctrlKey || e.metaKey || (this.plugin.settings.enterToSend ? !e.shiftKey : e.shiftKey);
			if (shouldSend) {
				e.preventDefault();
				void this.send();
			}
		});
		this.inputEl.addEventListener("paste", (e: ClipboardEvent) => {
			const files = Array.from(e.clipboardData?.files ?? []);
			if (files.length) {
				e.preventDefault();
				void this.addFiles(files);
			}
		});

		this.sendBtn = inputRow.createEl("button", { cls: "ovo-send-btn" });
		this.sendBtn.setAttribute("aria-label", "发送");
		setIcon(this.sendBtn, "arrow-up");
		this.sendBtn.addEventListener("click", () => {
			if (this.streaming) {
				this.stop();
			} else {
				void this.send();
			}
		});

		// 拖放附件
		composer.addEventListener("dragover", (e) => e.preventDefault());
		composer.addEventListener("drop", (e) => {
			e.preventDefault();
			const files = Array.from(e.dataTransfer?.files ?? []);
			if (files.length) void this.addFiles(files);
		});

		/* ---- 消息流 ---- */
		this.messagesWrapEl = chat.createDiv("ovo-messages-wrap");
		this.messagesEl = this.messagesWrapEl.createDiv("ovo-messages");
		this.messagesEl.addEventListener("scroll", () => {
			const el = this.messagesEl;
			this.autoScroll = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
			this.scrollBtn.toggle(!this.autoScroll);
		});
		this.scrollBtn = this.messagesWrapEl.createEl("button", { cls: "ovo-scroll-bottom" });
		setIcon(this.scrollBtn, "arrow-down");
		this.scrollBtn.setAttribute("aria-label", "滚动到底部");
		this.scrollBtn.hide();
		this.scrollBtn.addEventListener("click", () => {
			this.autoScroll = true;
			this.scrollBottom(true);
		});

		/* ---- 状态栏 ---- */
		const status = chat.createDiv("ovo-status");
		status.createSpan({ text: "🔒 DeepSeek 官方接口 · Anthropic 兼容" });
		this.statusRightEl = status.createSpan("ovo-status-right");
		this.updateStatus();
	}

	/** 输入框占位提示（桌面端按「键盘发送」设置给出对应组合键说明） */
	private sendHint(): string {
		return this.plugin.settings.enterToSend
			? "给 DeepSeek 发送消息…（Enter 发送 · Shift+Enter 换行）"
			: "给 DeepSeek 发送消息…（Shift+Enter 发送 · Enter 换行）";
	}

	/* ---- 工具栏按键（按设置顺序动态创建） ---- */

	private buildModelSelect(toolbar: HTMLElement): HTMLElement {
		this.modelSelect = toolbar.createEl("select", { cls: "ovo-select" });
		this.modelSelect.setAttribute("aria-label", "模型");
		this.modelSelect.addEventListener("change", () => {
			this.model = this.modelSelect.value;
			this.updateStatus();
		});
		return this.modelSelect;
	}

	private buildEffortSelect(toolbar: HTMLElement): HTMLElement {
		this.effortSelect = toolbar.createEl("select", { cls: "ovo-select" });
		this.effortSelect.setAttribute("aria-label", "思考强度");
		for (const key of ["off", "low", "medium", "high", "max"] as ThinkingEffort[]) {
			this.effortSelect.createEl("option", { value: key, text: EFFORT_LABELS[key] });
		}
		this.effortSelect.value = this.effort;
		this.effortSelect.addEventListener("change", () => {
			this.effort = this.effortSelect.value as ThinkingEffort;
		});
		return this.effortSelect;
	}

	private buildSearchChip(toolbar: HTMLElement): HTMLElement {
		this.searchChip = toolbar.createEl("button", { cls: "ovo-chip" });
		this.searchChip.setAttribute("aria-label", "联网搜索（官方 API 内置 web_search）");
		const globe = this.searchChip.createSpan("ovo-chip-icon");
		setIcon(globe, "globe");
		this.searchChip.createSpan({ text: "联网" });
		this.refreshSearchChip();
		this.searchChip.addEventListener("click", () => {
			this.webSearch = !this.webSearch;
			this.refreshSearchChip();
			new Notice(
				this.webSearch
					? "🌐 联网模式已开启（DeepSeek 官方服务端 web_search）"
					: "联网模式已关闭"
			);
		});
		return this.searchChip;
	}

	private buildToolChip(toolbar: HTMLElement): HTMLElement {
		this.toolChip = toolbar.createEl("button", { cls: "ovo-chip" });
		this.toolChip.setAttribute("aria-label", "工具调用模式（把内置工具组交给模型调用）");
		const wrench = this.toolChip.createSpan("ovo-chip-icon");
		setIcon(wrench, "wrench");
		this.toolChip.createSpan({ text: "工具" });
		this.refreshToolChip();
		this.toolChip.addEventListener("click", () => {
			this.toolMode = !this.toolMode;
			this.refreshToolChip();
			if (this.toolMode) {
				const tools = this.plugin.tools.list();
				if (!tools.length) {
					this.toolMode = false;
					this.refreshToolChip();
					new Notice("当前没有可用的内置工具", 8000);
				} else {
					new Notice(
						`🔧 工具调用模式已开启（${tools.length} 个：${tools.map((t) => t.name).join("、")}）` +
							"\n模型将按需调用内置只读工具（检索 / 读取笔记），结果自动回传",
						8000
					);
				}
			} else {
				new Notice("工具调用模式已关闭");
			}
		});
		return this.toolChip;
	}

	private buildDrawChip(toolbar: HTMLElement): HTMLElement {
		this.drawChip = toolbar.createEl("button", { cls: "ovo-chip" });
		this.drawChip.setAttribute("aria-label", "绘图模式（注入图表语法提示词）");
		const icon = this.drawChip.createSpan("ovo-chip-icon");
		setIcon(icon, "pie-chart");
		this.drawChip.createSpan({ text: "绘图" });
		this.refreshDrawChip();
		this.drawChip.addEventListener("click", () => {
			this.drawing = !this.drawing;
			this.refreshDrawChip();
			if (this.drawing) {
				const n = this.plugin.settings.enabledDrawingTypes.length;
				new Notice(`✏️ 绘图模式已开启（注入 ${n} 种图表提示词）`, 8000);
			} else {
				new Notice("绘图模式已关闭");
			}
		});
		return this.drawChip;
	}

	/** 个性化总开关（全局持久化设置，原设置页内的 Toggle 已移到此处） */
	private buildPersonalizeChip(toolbar: HTMLElement): HTMLElement {
		this.personalizeChip = toolbar.createEl("button", { cls: "ovo-chip" });
		this.personalizeChip.setAttribute("aria-label", "个性化（风格 / 表达程度 / 排版提示词注入的总开关）");
		const icon = this.personalizeChip.createSpan("ovo-chip-icon");
		setIcon(icon, "smile");
		this.personalizeChip.createSpan({ text: "个性化" });
		this.refreshPersonalizeChip();
		this.personalizeChip.addEventListener("click", () => {
			const on = !this.plugin.settings.personalizeEnabled;
			this.plugin.settings.personalizeEnabled = on;
			void this.plugin.saveSettings();
			// 其他已打开的对话标签页同步选中态
			this.plugin.notifyPersonalizeChanged();
			new Notice(
				on
					? "🎨 个性化已开启：按设置中的档位注入风格 / 排版提示词"
					: "个性化已关闭：不注入风格 / 排版提示词（档位选择保留）"
			);
		});
		return this.personalizeChip;
	}

	private buildAttachChip(toolbar: HTMLElement): HTMLElement {
		const attachBtn = toolbar.createEl("button", { cls: "ovo-chip" });
		attachBtn.setAttribute("aria-label", "上传附件（图片 / Markdown / 文本）");
		const clip = attachBtn.createSpan("ovo-chip-icon");
		setIcon(clip, "paperclip");
		attachBtn.createSpan({ text: "附件" });
		attachBtn.addEventListener("click", () => this.fileInput.click());
		return attachBtn;
	}

	private buildNoteChip(toolbar: HTMLElement): HTMLElement {
		const noteBtn = toolbar.createEl("button", { cls: "ovo-chip" });
		noteBtn.setAttribute("aria-label", "附加当前笔记");
		const noteIcon = noteBtn.createSpan("ovo-chip-icon");
		setIcon(noteIcon, "file-text");
		noteBtn.createSpan({ text: "当前笔记" });
		noteBtn.addEventListener("click", () => void this.attachActiveNote());
		return noteBtn;
	}

	private refreshSearchChip(): void {
		this.searchChip.toggleClass("is-active", this.webSearch);
	}

	private refreshToolChip(): void {
		this.toolChip.toggleClass("is-active", this.toolMode);
	}

	private refreshDrawChip(): void {
		this.drawChip.toggleClass("is-active", this.drawing);
	}

	private refreshPersonalizeChip(): void {
		this.personalizeChip?.toggleClass("is-active", this.plugin.settings.personalizeEnabled);
	}

	/* ================= 模型列表 ================= */

	private async populateModels(): Promise<void> {
		// 先用缓存/兜底列表即时填充，再按官方 API 动态刷新
		this.fillModelOptions(this.plugin.getModelsSync());
		const models = await this.plugin.getModels();
		this.fillModelOptions(models);
	}

	private fillModelOptions(models: OVOModelInfo[]): void {
		const sel = this.modelSelect;
		if (!sel) return; // 模型按键被隐藏时不渲染下拉框
		const prev = sel.value || this.model;
		sel.empty();
		const seen = new Set<string>();
		for (const m of models) {
			if (seen.has(m.id)) continue;
			sel.createEl("option", { value: m.id, text: m.label });
			seen.add(m.id);
		}
		if (!seen.has(prev)) sel.createEl("option", { value: prev, text: prev });
		sel.value = prev;
	}

	/* ================= 渲染消息（显示路径） ================= */

	/** 显示路径：激活路径 + 游标截断（游标不在当前路径上时回落完整激活路径） */
	private displayPath(): ChatTurn[] {
		const path = activePath(this.session);
		if (!this.cursorTurn) return path;
		const i = path.indexOf(this.cursorTurn);
		if (i < 0) {
			this.cursorTurn = null;
			return path;
		}
		return path.slice(0, i + 1);
	}

	rerenderAll(): void {
		this.messagesEl.empty();
		this.turnEls.clear();
		this.editingTurn = null;
		this.titleEl.setText(this.session.title || "新对话");
		const path = this.displayPath();
		if (!path.length) {
			this.renderEmptyState();
		} else {
			for (const turn of path) this.renderTurn(turn);
		}
		this.autoScroll = true;
		this.scrollBottom(true);
		this.updateStatus();
		// 侧边栏对话树同步（结构 / 激活路径变化）
		this.plugin.notifyTreeChanged();
	}

	private renderEmptyState(): void {
		const empty = this.messagesEl.createDiv("ovo-empty");
		if (this.tempMode) {
			empty.createDiv("ovo-empty-title").setText("临时对话");
			empty
				.createDiv("ovo-empty-tip")
				.setText(
					"本次对话不会保存（含附件）、不注入个性化与语法增强提示词，退出后即消失\n翻看历史对话 / 新建对话会退出临时对话；点击顶栏「幽灵」按键可主动退出"
				);
			return;
		}
		empty.createDiv("ovo-empty-title").setText("你好，我是 AI 助手");
		empty
			.createDiv("ovo-empty-tip")
			.setText(
				"在上方输入框开始对话 · 可切换模型、调节思考强度、开启联网搜索\n支持上传图片（视觉）与 Markdown / 文本附件，也可直接附加当前笔记\n对话以问答树保存：可编辑提问、重新生成答案、从任意节点继续对话"
			);
	}

	/** 渲染一个 turn：问句气泡 + 当前激活答案块 */
	private renderTurn(turn: ChatTurn): void {
		this.renderQuestionEl(turn);
		const ans = activeAnswerOf(turn);
		if (ans) this.renderAnswerEl(turn, ans, false);
	}

	/** 渲染问句气泡（data-turn-id 供侧边栏跳转定位；编辑取消时就地恢复） */
	private renderQuestionEl(turn: ChatTurn): HTMLElement {
		const m = turn.question;
		const entry = this.turnEls.get(turn.id);
		const old = entry?.questionEl;
		const el = this.messagesEl.createDiv(`ovo-msg ovo-msg-user${m.error ? " ovo-msg-error" : ""}`);
		el.dataset.turnId = turn.id;
		if (old && old !== el) {
			old.after(el);
			old.remove();
		}
		el.createDiv("ovo-bubble-side"); // 布局占位
		const col = el.createDiv("ovo-user-col");
		const bubble = col.createDiv("ovo-bubble");
		// 附件
		const atts = m.attachments ?? [];
		if (atts.length) {
			const row = bubble.createDiv("ovo-att-row");
			for (const a of atts) {
				if (a.kind === "image" && a.dataUrl) {
					const img = row.createEl("img", { cls: "ovo-att-img" });
					img.src = a.dataUrl;
					img.alt = a.name;
				} else {
					const chip = row.createDiv("ovo-att-chip");
					const icon = chip.createSpan();
					setIcon(icon, "file-text");
					chip.createSpan({ text: a.name, cls: "ovo-att-name" });
				}
			}
		}
		// 输入文本与回答文本使用同一渲染方案（markdown-rendered）
		const content = bubble.createDiv("ovo-msg-content markdown-rendered");
		void this.renderMarkdownInto(content, m.content, false);
		// 操作条：复制 / 编辑（编辑保存后原问句保留为兄弟分支）
		const actions = col.createDiv("ovo-msg-actions ovo-msg-actions-user");
		this.mkActionBtn(actions, "copy", "复制 Markdown", () => void this.copyMessage(turn.question));
		this.mkActionBtn(actions, "pencil", "编辑问句（保留原问句为分支）", () => this.startEditQuestion(turn));
		if (entry) entry.questionEl = el;
		else this.turnEls.set(turn.id, { questionEl: el });
		return el;
	}

	/**
	 * 渲染答案块（assistant 消息）：
	 * - 常规渲染：插到该 turn 的问句之后（路径顺序）；
	 * - 重新生成 / 流式：就地替换旧答案块，不改变后续兄弟元素位置。
	 */
	private renderAnswerEl(turn: ChatTurn, m: OVOMessage, streaming: boolean): MessageElRefs {
		const el = this.messagesEl.createDiv(
			`ovo-msg ovo-msg-assistant${m.error ? " ovo-msg-error" : ""}${streaming ? " is-streaming" : ""}`
		);
		const entry = this.turnEls.get(turn.id);
		const anchor = entry?.answerEl ?? entry?.questionEl ?? null;
		if (anchor && anchor !== el) {
			anchor.after(el);
			if (entry?.answerEl && entry.answerEl !== el) entry.answerEl.remove();
		}
		if (entry) entry.answerEl = el;
		else this.turnEls.set(turn.id, { questionEl: el, answerEl: el });

		const avatar = el.createDiv("ovo-avatar");
		avatar.setText("D");
		const body = el.createDiv("ovo-msg-body");

		const refs: MessageElRefs = { root: el, bodyEl: body, contentEl: body.createDiv() };

		refs.searchingEl = body.createDiv("ovo-searching");
		refs.searchingEl.hide();

		if (streaming || (m.toolCalls && m.toolCalls.length)) {
			refs.toolsEl = body.createDiv("ovo-tool-calls");
			if (m.toolCalls?.length) this.renderToolCallsInto(refs.toolsEl, m.toolCalls, streaming);
		}

		if (streaming || (m.reasoning && m.reasoning.length)) {
			const details = body.createEl("details", { cls: "ovo-reasoning" });
			refs.reasoningDetails = details;
			// 流式中始终展开；结束后按设置决定默认折叠 / 展开
			details.open = streaming || !this.plugin.settings.collapseReasoning;
			const summary = details.createEl("summary");
			refs.reasoningSummary = summary;
			summary.addClass("is-streaming");
			summary.setText(streaming ? "思考中…" : "已深度思考");
			refs.reasoningBody = details.createDiv("ovo-reasoning-body");
			refs.reasoningBody.setText(m.reasoning ?? "");
		}

		refs.contentEl.remove(); // 移除占位，改为正文容器
		refs.contentEl = body.createDiv("ovo-msg-content markdown-rendered");
		void this.renderMarkdownInto(refs.contentEl, m.content, streaming, !streaming);

		refs.sourcesEl = body.createDiv("ovo-sources");
		if (m.sources?.length) this.renderSources(refs.sourcesEl, m.sources);

		refs.metaEl = body.createDiv("ovo-msg-meta");
		refs.metaEl.setText(this.assistantMeta(m, streaming));
		// 操作条（复制 / 重新生成 / 多答案切换）：流式中暂不渲染，结束后补挂
		if (!streaming) this.appendAnswerActions(body, turn, m);
		return refs;
	}

	private assistantMeta(m: OVOMessage, streaming: boolean): string {
		if (streaming) return "";
		const parts: string[] = [];
		if (m.model) parts.push(m.model);
		if (m.durationMs) parts.push(`${(m.durationMs / 1000).toFixed(1)} 秒`);
		if (m.webSearch) parts.push(m.searchTriggered ? "🌐 已联网检索" : "⚠️ 未触发联网检索");
		if (m.drawing) parts.push("✏️ 绘图");
		if (m.toolCalls?.length) parts.push(`🔧 ${m.toolCalls.length} 次工具调用`);
		if (m.usage) {
			const u = m.usage;
			const seg = [];
			if (u.input_tokens != null) seg.push(`输入 ${u.input_tokens.toLocaleString()}`);
			if (u.output_tokens != null) seg.push(`输出 ${u.output_tokens.toLocaleString()}`);
			if (seg.length) parts.push(seg.join(" / "));
		}
		return parts.join(" · ");
	}

	private renderSources(el: HTMLElement, sources: OVOMessageSource[]): void {
		el.empty();
		if (!sources.length) return;
		// 来源列表默认折叠（可在设置「界面」分页改为默认展开）；流式刷新时保留用户当前的展开状态
		const prevOpen = el.querySelector("details")?.open;
		const details = el.createEl("details", { cls: "ovo-sources-details" });
		details.open = prevOpen ?? !this.plugin.settings.collapseSources;
		const label = details.createEl("summary", { cls: "ovo-sources-label" });
		const icon = label.createSpan();
		setIcon(icon, "globe");
		label.createSpan({ text: `来源（${sources.length}）` });
		const list = details.createDiv("ovo-sources-list");
		sources.slice(0, 12).forEach((s, i) => {
			const a = list.createEl("a", { text: s.title ? `${i + 1}. ${s.title}` : s.url });
			a.href = s.url;
			a.target = "_blank";
			a.rel = "noopener noreferrer";
		});
	}

	/** 渲染工具调用轨迹（历史：静态；streaming：允许动态更新行状态） */
	private renderToolCallsInto(el: HTMLElement, records: OVOToolCallRecord[], running: boolean): void {
		el.empty();
		for (const r of records) {
			this.renderToolCallLine(el, r, running && !r.result);
		}
	}

	private renderToolCallLine(el: HTMLElement, r: OVOToolCallRecord, pending: boolean): HTMLElement {
		const line = el.createDiv(`ovo-tool-call${pending ? " is-running" : ""}${r.ok === false ? " is-error" : ""}`);
		const icon = line.createSpan("ovo-tool-call-icon");
		setIcon(icon, pending ? "loader" : r.ok === false ? "x" : "check");
		const label = line.createSpan("ovo-tool-call-name");
		label.setText(
			pending ? `🔧 正在调用工具 ${r.name}…` : `🔧 ${r.name}${r.ok === false ? " · 失败" : ""}`
		);
		if (r.result && !pending) {
			const detail = line.createEl("details", { cls: "ovo-tool-call-detail" });
			detail.createEl("summary").setText("参数 / 结果");
			detail.createDiv("ovo-tool-call-body").setText(
				`${r.args != null ? "参数：" + safeJson(r.args) + "\n" : ""}结果：${r.result}`
			);
		}
		return line;
	}

	/**
	 * 渲染 Markdown 到元素。
	 * - fix=true：先做「语法增强 → Obsidian 语法修正」（仅助手消息、非流式；只作用于渲染副本）；
	 * - 流式：Mermaid 围栏降级为 text 代码块，避免半截语法反复报错；
	 * - 最终渲染：Mermaid 围栏先做修复 / 校验，无法解析时降级为源码展示。
	 */
	private async renderMarkdownInto(el: HTMLElement, md: string, cursor: boolean, fix = false): Promise<void> {
		el.empty();
		let text = fix ? correctAssistantMarkdown(md, this.plugin.settings) : md;
		if (cursor) text = neutralizeMermaidFences(text);
		else text = await prepareMermaidForRender(text);
		if (cursor) text += " ▍";
		if (!text.trim()) return;
		try {
			await MarkdownRenderer.render(this.app, text, el, "", this);
		} catch (e) {
			// 渲染失败退回纯文本
			el.setText(text);
			console.debug("[OvO] Markdown 渲染失败", e);
			return;
		}
		// 兜底：预校验未覆盖的运行时错误 → 整段 Mermaid 降级后重渲一次（不递归）
		if (!cursor && hasMermaidRenderError(el)) {
			const safe = neutralizeMermaidFences(text);
			const note = safe !== text ? "> ⚠️ 部分 Mermaid 图表无法渲染，已改为显示源码。\n\n" : "";
			el.empty();
			try {
				await MarkdownRenderer.render(this.app, note + safe, el, "", this);
			} catch {
				el.setText(text);
			}
		}
	}

	private scheduleStreamRender(refs: MessageElRefs, m: OVOMessage): void {
		if (this.mdRenderTimer) return;
		this.mdRenderTimer = window.setTimeout(() => {
			this.mdRenderTimer = null;
			void this.renderMarkdownInto(refs.contentEl, m.content, true);
		}, 140);
	}

	private scrollBottom(force = false): void {
		if (force || this.autoScroll) {
			this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
		}
	}

	/* ================= 消息操作（复制 / 编辑 / 重新生成） ================= */

	/** 小图标操作按钮（透明底，悬停显现） */
	private mkActionBtn(parent: HTMLElement, icon: string, tooltip: string, onClick: () => void): HTMLButtonElement {
		const btn = parent.createEl("button", { cls: "ovo-action-btn clickable-icon" });
		btn.setAttribute("aria-label", tooltip);
		setIcon(btn, icon);
		btn.addEventListener("click", (e) => {
			e.stopPropagation();
			onClick();
		});
		return btn;
	}

	/** 复制消息 Markdown 原文到剪贴板 */
	private async copyMessage(m: OVOMessage): Promise<void> {
		try {
			await navigator.clipboard.writeText(m.content);
			new Notice("已复制到剪贴板");
		} catch {
			new Notice("复制失败：剪贴板不可用");
		}
	}

	/** 答案操作条：多答案切换 ‹ n/m › · 复制 · 重新生成 */
	private appendAnswerActions(body: HTMLElement, turn: ChatTurn, m: OVOMessage): void {
		const actions = body.createDiv("ovo-msg-actions");
		if (turn.answers.length > 1) {
			this.mkActionBtn(actions, "chevron-left", "上一个答案", () => this.switchAnswer(turn, -1));
			actions.createSpan({ cls: "ovo-answer-count", text: `${turn.activeAnswer + 1}/${turn.answers.length}` });
			this.mkActionBtn(actions, "chevron-right", "下一个答案", () => this.switchAnswer(turn, 1));
		}
		this.mkActionBtn(actions, "copy", "复制 Markdown", () => void this.copyMessage(m));
		this.mkActionBtn(actions, "refresh-cw", "重新生成", () => this.regenerate(turn));
	}

	/** 切换同问句下的答案（重新生成产生的多个答案，同问不同答） */
	private switchAnswer(turn: ChatTurn, dir: -1 | 1): void {
		if (this.streaming) return;
		const n = turn.answers.length;
		if (n <= 1) return;
		turn.activeAnswer = ((turn.activeAnswer + dir) % n + n) % n;
		this.renderAnswerEl(turn, turn.answers[turn.activeAnswer], false);
		this.updateStatus();
	}

	/** 一键重新生成：向该问句追加新答案并激活（旧答案可经 ‹ n/m › 回切） */
	private regenerate(turn: ChatTurn): void {
		if (this.streaming) return;
		if (this.blockedByFocus()) return;
		if (!this.plugin.getApiKey()) {
			new Notice("请先在设置中选择或新建 API 密钥（Obsidian 内置密钥库）");
			this.plugin.openSettings();
			return;
		}
		void this.generate(turn);
	}

	/** 编辑问句：气泡内联 textarea（Enter 保存 · Esc 取消） */
	private startEditQuestion(turn: ChatTurn): void {
		if (this.streaming || this.editingTurn) return;
		const entry = this.turnEls.get(turn.id);
		const bubble = entry?.questionEl.querySelector<HTMLElement>(".ovo-bubble");
		if (!bubble) return;
		this.editingTurn = turn;
		const original = turn.question.content;

		bubble.empty();
		const ta = bubble.createEl("textarea", { cls: "ovo-input ovo-edit-input" });
		ta.value = original;
		ta.rows = Math.min(10, Math.max(2, original.split("\n").length));
		ta.style.height = Math.max(ta.scrollHeight, 60) + "px";
		const editActions = bubble.createDiv("ovo-edit-actions");
		const cancelBtn = editActions.createEl("button", { text: "取消", cls: "ovo-edit-cancel" });
		const saveBtn = editActions.createEl("button", { text: "保存并生成", cls: "ovo-edit-save" });

		const cancel = () => {
			this.editingTurn = null;
			this.renderQuestionEl(turn); // 就地恢复原文与操作条
		};
		const save = () => {
			const text = ta.value.trim();
			if (!text) {
				new Notice("问句内容不能为空");
				return;
			}
			if (this.blockedByFocus()) return;
			if (!this.plugin.getApiKey()) {
				new Notice("请先在设置中选择或新建 API 密钥（Obsidian 内置密钥库）");
				this.plugin.openSettings();
				return;
			}
			this.editingTurn = null;
			this.saveEditedQuestion(turn, text);
		};
		cancelBtn.addEventListener("click", cancel);
		saveBtn.addEventListener("click", save);
		ta.addEventListener("keydown", (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				cancel();
				return;
			}
			if (e.key === "Enter" && !e.shiftKey && !isImeComposing(e) && !Platform.isMobile) {
				e.preventDefault();
				save();
			}
		});
		ta.focus();
		ta.setSelectionRange(ta.value.length, ta.value.length);
	}

	/**
	 * 保存编辑：编辑版问句作为「与原问句同级」的新分支挂载（原问句及其答案 / 子树完整保留），
	 * 切换显示路径到新分支后立即重新生成答案。
	 */
	private saveEditedQuestion(turn: ChatTurn, text: string): void {
		const userMsg: OVOMessage = { id: genId("m"), role: "user", content: text, ts: Date.now() };
		const newTurn: ChatTurn = {
			id: genId("t"),
			question: userMsg,
			answers: [],
			activeAnswer: 0,
			children: [],
			activeChild: 0,
		};
		const parent = this.findParentOf(turn);
		if (parent) {
			parent.children.push(newTurn);
			parent.activeChild = parent.children.length - 1;
		} else {
			this.session.turns.push(newTurn);
			this.session.activeTurn = this.session.turns.length - 1;
		}
		this.cursorTurn = null;
		// 显示路径切换到新分支：重渲染出编辑版问句，随后流式生成答案
		this.rerenderAll();
		const ephemeral = this.tempMode; // 临时对话：不落盘
		void (async () => {
			if (!ephemeral) await this.plugin.store.saveSession(this.session);
			await this.generate(newTurn);
		})();
	}

	/** 找到某 turn 的父节点（根级返回 null） */
	private findParentOf(target: ChatTurn): ChatTurn | null {
		for (const t of walkTurns(this.session.turns)) {
			if (t.children.includes(target)) return t;
		}
		return null;
	}

	/* ================= 附件 ================= */

	private async addFiles(files: File[]): Promise<void> {
		for (const f of files) {
			const isImage = f.type.startsWith("image/") || /\.(png|jpe?g|gif|webp)$/i.test(f.name);
			if (isImage) {
				if (f.size > MAX_IMAGE_BYTES) {
					new Notice(`图片《${f.name}》超过 16MB，已跳过`);
					continue;
				}
				const dataUrl = await readFileAsDataUrl(f);
				this.pendingAttachments.push({
					id: genId("a"),
					name: f.name || "image.png",
					mime: f.type || "image/png",
					size: f.size,
					kind: "image",
					dataUrl,
				});
			} else {
				let text = await f.text();
				if (text.length > MAX_TEXT_CHARS) {
					text = text.slice(0, MAX_TEXT_CHARS);
					new Notice(`附件《${f.name}》内容过长，已截断至 20 万字符`);
				}
				this.pendingAttachments.push({
					id: genId("a"),
					name: f.name || "file.txt",
					mime: f.type || "text/plain",
					size: f.size,
					kind: "text",
					text,
				});
			}
		}
		this.renderPreview();
	}

	private async attachActiveNote(): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (!file) {
			new Notice("当前没有活动笔记");
			return;
		}
		const text = await this.app.vault.read(file);
		this.pendingAttachments.push({
			id: genId("a"),
			name: file.name,
			mime: "text/markdown",
			size: text.length,
			kind: "text",
			text,
		});
		this.renderPreview();
		new Notice(`已附加当前笔记：${file.name}`);
	}

	private renderPreview(): void {
		this.previewEl.empty();
		this.previewEl.toggle(this.pendingAttachments.length > 0);
		for (const a of this.pendingAttachments) {
			const chip = this.previewEl.createDiv("ovo-att-chip");
			if (a.kind === "image" && a.dataUrl) {
				chip.createEl("img", { cls: "ovo-att-img ovo-att-img-sm", attr: { src: a.dataUrl } });
			} else {
				const icon = chip.createSpan();
				setIcon(icon, "file-text");
			}
			chip.createSpan({ text: a.name, cls: "ovo-att-name" });
			const rm = chip.createEl("button", { cls: "ovo-att-remove clickable-icon" });
			setIcon(rm, "x");
			rm.setAttribute("aria-label", "移除附件");
			rm.addEventListener("click", () => {
				this.pendingAttachments = this.pendingAttachments.filter((x) => x.id !== a.id);
				this.renderPreview();
			});
		}
	}

	private estimatePayloadSize(): number {
		return this.pendingAttachments.reduce((s, a) => s + (a.dataUrl?.length ?? 0), 0);
	}

	/* ================= 发送 / 生成 ================= */

	private setStreamState(on: boolean): void {
		this.streaming = on;
		this.sendBtn.toggleClass("is-stop", on);
		this.sendBtn.setAttribute("aria-label", on ? "停止生成" : "发送");
		this.sendBtn.empty();
		setIcon(this.sendBtn, on ? "square" : "arrow-up");
	}

	private stop(): void {
		this.abort?.abort();
	}

	/**
	 * 专注时间拦截：所有触发生成的操作（发送 / 重新生成 / 编辑保存）调用。
	 * 处于专注时间时提示并返回 true；翻看历史对话不受限制。
	 */
	private blockedByFocus(): boolean {
		const focus = this.plugin.focus;
		if (!focus?.isActive()) return false;
		new Notice(`当前处于专注时间（剩余 ${focus.remainingMinutes()} 分钟），暂不能发起对话`, 8000);
		return true;
	}

	private async send(): Promise<void> {
		if (this.streaming) return;
		// 临时对话：本轮的附件与提问一律不落盘（发起时固定，避免流式期间模式切换）
		const ephemeral = this.tempMode;
		const text = this.inputEl.value.trim();
		if (!text && !this.pendingAttachments.length) return;
		if (this.blockedByFocus()) return;
		if (!this.plugin.getApiKey()) {
			new Notice("请先在设置中选择或新建 API 密钥（Obsidian 内置密钥库）");
			this.plugin.openSettings();
			return;
		}
		if (this.estimatePayloadSize() > 40 * 1024 * 1024) {
			new Notice("附件总体积过大，请减少图片数量或压缩后重试");
			return;
		}

		const userMsg: OVOMessage = {
			id: genId("m"),
			role: "user",
			content: text,
			ts: Date.now(),
		};
		if (this.pendingAttachments.length) {
			userMsg.attachments = this.pendingAttachments.slice();
			// 临时对话：附件正文仅留在内存，不写入插件附件目录
			if (!ephemeral) {
				userMsg.attachments = await this.plugin.store.persistAttachments(this.session.id, userMsg.attachments);
			}
		}
		this.pendingAttachments = [];
		this.renderPreview();
		this.inputEl.value = "";
		this.autoResize();

		// 新问句挂到显示路径末端：无根则新建根分支，否则作为末端 turn 的新子分支（原分支保留）
		const isFirstRoot = !this.session.turns.length;
		const turn: ChatTurn = {
			id: genId("t"),
			question: userMsg,
			answers: [],
			activeAnswer: 0,
			children: [],
			activeChild: 0,
		};
		const path = this.displayPath();
		const last = path[path.length - 1];
		if (last) {
			last.children.push(turn);
			last.activeChild = last.children.length - 1;
		} else {
			this.session.turns.push(turn);
			this.session.activeTurn = this.session.turns.length - 1;
		}
		this.cursorTurn = null; // 新问句即当前路径末端

		if (isFirstRoot && text) {
			// 临时对话标题加「临时」前缀：提醒记录不会保存
			this.session.title = (ephemeral ? "临时 · " : "") + text.replace(/\s+/g, " ").slice(0, 24);
			this.titleEl.setText(this.session.title);
		}
		const empty = this.messagesEl.querySelector(".ovo-empty");
		if (empty) empty.remove();
		this.renderQuestionEl(turn);
		this.scrollBottom(true);
		// 双写第一次：发出的提问立即落盘（崩溃恢复语义）；临时对话不落盘
		if (!ephemeral) await this.plugin.store.saveSession(this.session);
		this.plugin.notifyTreeChanged();

		await this.generate(turn);
	}

	/** 组装生成上下文：显示路径上至目标 turn 的问句为止（目标 turn 的旧答案不计入，重新生成语义） */
	private contextMessages(target: ChatTurn): OVOMessage[] {
		const out: OVOMessage[] = [];
		for (const t of this.displayPath()) {
			out.push(t.question);
			if (t !== target) {
				const a = activeAnswerOf(t);
				if (a) out.push(a);
			}
		}
		return out;
	}

	private async generate(turn: ChatTurn): Promise<void> {
		const s = this.plugin.settings;
		const session = this.session; // 流式期间会话可能被切换：落盘目标固定为发起时的会话
		const ephemeral = this.tempMode; // 临时对话：本轮不落盘、不注入个性化 / 语法增强提示词
		const assistantMsg: OVOMessage = {
			id: genId("m"),
			role: "assistant",
			content: "",
			reasoning: "",
			model: this.model,
			effort: this.effort,
			webSearch: this.webSearch,
			drawing: this.drawing,
			ts: Date.now(),
		};
		const refs = this.renderAnswerEl(turn, assistantMsg, true);
		this.setStreamState(true);
		this.autoScroll = true;
		this.scrollBottom(true);

		this.abort = new AbortController();
		const started = Date.now();
		let reasoningStart = 0;
		let reasoningEnd = 0;
		let searched = false;
		const toolRecords: OVOToolCallRecord[] = [];

		const handlers: StreamHandlers = {
			onReasoning: (delta: string, full: string) => {
				if (!reasoningStart) reasoningStart = Date.now();
				assistantMsg.reasoning = full;
				if (refs.reasoningBody) refs.reasoningBody.setText(full);
				if (refs.reasoningSummary) refs.reasoningSummary.setText("思考中…");
				if (refs.reasoningDetails) refs.reasoningDetails.open = true;
			},
			onText: (delta: string, full: string) => {
				if (reasoningStart && !reasoningEnd) reasoningEnd = Date.now();
				assistantMsg.content = full;
				// 正文开始输出时，按设置收起思考过程（与 DeepSeek 网页版一致）
				if (refs.reasoningDetails && this.plugin.settings.collapseReasoning) refs.reasoningDetails.open = false;
				this.scheduleStreamRender(refs, assistantMsg);
				this.scrollBottom();
			},
			onSearching: (query: string) => {
				searched = true;
				if (refs.searchingEl) {
					refs.searchingEl.show();
					refs.searchingEl.empty();
					const icon = refs.searchingEl.createSpan();
					setIcon(icon, "globe");
					refs.searchingEl.createSpan({ text: query ? `正在联网搜索：${query}…` : "正在联网搜索…" });
				}
			},
			onSources: (sources: OVOMessageSource[]) => {
				assistantMsg.sources = sources;
				if (refs.sourcesEl) this.renderSources(refs.sourcesEl, sources);
			},
			onUsage: (usage: OVOUsage) => {
				assistantMsg.usage = usage;
				this.updateStatus();
			},
			onToolCall: (call: { id: string; name: string; args: unknown }) => {
				// 协议层报告模型发起工具调用：先记录 pending 轨迹（结果由 agent loop 执行后回填）
				const rec: OVOToolCallRecord = { name: call.name, args: call.args, ts: Date.now() };
				toolRecords.push(rec);
				if (refs.toolsEl) {
					this.renderToolCallLine(refs.toolsEl, rec, true);
					this.scrollBottom();
				}
			},
		};

		// 工具调用模式：收集内置工具（无工具时按普通对话执行）
		const tools = this.toolMode ? this.plugin.tools.list() : [];

		try {
			// 组装系统提示词：用户自定义 + 当日日期 + 个性化 + 语法增强 + 联网强化 + 绘图（按需注入）
			// 临时对话只跳过个性化与语法增强；日期属于客观信息，照常注入
			const extras: string[] = [];
			if (s.injectTodayDate) extras.push(todayPrompt());
			const personal = ephemeral ? "" : buildPersonalizationPrompt(s);
			if (personal) extras.push(personal);
			const syntax = ephemeral ? "" : buildSyntaxPrompt(s);
			if (syntax) extras.push(syntax);
			if (this.webSearch) extras.push(WEB_SEARCH_NUDGE);
			if (this.drawing) extras.push(buildDrawingPrompt(s.enabledDrawingTypes));
			const base = s.systemPrompt.trim();
			const sys = [base, ...extras].filter(Boolean).join("\n\n");

			// 统一走 DeepSeek 官方 Anthropic 兼容端点；联网时内置官方服务端 web_search
			const result = await this.runAnthropicAgent(
				{
					model: this.model,
					effort: this.effort,
					payload: buildAnthropicMessages(this.contextMessages(turn), s),
					system: sys,
				},
				tools,
				handlers,
				refs,
				toolRecords,
				this.webSearch
			);
			Object.assign(assistantMsg, result);

			assistantMsg.searchTriggered = searched;
			assistantMsg.toolCalls = toolRecords.length ? toolRecords : undefined;
			assistantMsg.durationMs = Date.now() - started;
			if (!assistantMsg.content.trim() && !assistantMsg.reasoning?.trim()) {
				assistantMsg.content = "*(模型未返回内容)*";
				assistantMsg.error = true;
			}
		} catch (err) {
			const aborted = this.abort?.signal.aborted;
			if (aborted) {
				assistantMsg.content += "\n\n*⏹ 已停止生成*";
			} else {
				const msg = errMsg(err);
				assistantMsg.error = true;
				assistantMsg.content = `⚠️ ${msg}`;
				new Notice(`OvO Chat 请求失败：${msg}`, 8000);
			}
		} finally {
			if (this.mdRenderTimer) {
				window.clearTimeout(this.mdRenderTimer);
				this.mdRenderTimer = null;
			}
			if (reasoningStart && !reasoningEnd) reasoningEnd = Date.now();
			// 答案入集并激活（同问不同答；重新生成后可回切旧答案）
			turn.answers.push(assistantMsg);
			turn.activeAnswer = turn.answers.length - 1;
			this.setStreamState(false);
			this.abort = null;

			// 最终渲染（就地完成，不整树重渲）
			refs.root.removeClass("is-streaming");
			refs.root.toggleClass("ovo-msg-error", !!assistantMsg.error);
			if (refs.reasoningDetails) {
				refs.reasoningDetails.open = !this.plugin.settings.collapseReasoning;
				refs.reasoningSummary?.removeClass("is-streaming");
				const sec = reasoningStart && reasoningEnd ? Math.round((reasoningEnd - reasoningStart) / 1000) : 0;
				refs.reasoningSummary?.setText(assistantMsg.reasoning ? (sec ? `已深度思考（用时 ${sec} 秒）` : "已深度思考") : "");
			}
			refs.searchingEl?.hide();
			if (refs.toolsEl && assistantMsg.toolCalls?.length) {
				this.renderToolCallsInto(refs.toolsEl, assistantMsg.toolCalls, false);
			}
			await this.renderMarkdownInto(refs.contentEl, assistantMsg.content, false, true);
			if (refs.metaEl) refs.metaEl.setText(this.assistantMeta(assistantMsg, false));
			if (assistantMsg.sources?.length && refs.sourcesEl) this.renderSources(refs.sourcesEl, assistantMsg.sources);
			// 操作条（复制 / 重新生成 / 多答案切换）在流式结束后补挂
			if (refs.bodyEl) this.appendAnswerActions(refs.bodyEl, turn, assistantMsg);

			// 双写第二次：生成完成后落盘（含答案与用量）；临时对话不落盘、不记为最近会话
			if (!ephemeral) {
				await this.plugin.store.saveSession(session);
				this.plugin.lastSessionId = session.id;
			}
			if (this.session === session) {
				this.updateStatus();
				this.scrollBottom();
			}
		}
	}

	/* ================= 工具调用 Agent 循环 ================= */

	/** 内置工具 → Anthropic tool 格式（DeepSeek Anthropic 兼容端点） */
	private buildAnthropicTools(tools: OVOBuiltinTool[]): unknown[] {
		return tools.map((t) => ({
			name: t.name,
			description: t.description,
			input_schema: t.parameters,
		}));
	}

	/** 执行一个模型请求的内置工具调用，并回写轨迹与 UI（永不抛出） */
	private async execTool(
		tc: ToolCallDraft,
		records: OVOToolCallRecord[],
		refs: MessageElRefs
	): Promise<{ text: string }> {
		// 参数已由协议层解析一次；解析失败保持既有回退语义（原始串包进 _raw）
		const args: Record<string, unknown> = tc.args ?? { _raw: tc.arguments };
		const r = await this.plugin.tools.execute(tc.name, args);
		// onToolCall 已建 pending 记录；找不到时补建
		let rec = [...records].reverse().find((x) => x.name === tc.name && !x.result);
		if (!rec) {
			rec = { name: tc.name, args, ts: Date.now() };
			records.push(rec);
		}
		rec.args = args;
		rec.ok = r.ok;
		rec.result = briefResult(r.text);
		if (refs.toolsEl) this.renderToolCallsInto(refs.toolsEl, records, true);
		this.scrollBottom();
		return { text: r.text };
	}

	/**
	 * Anthropic 兼容端点的 Agent 循环（联网 + 内置工具可同时开启）：
	 * web_search 由服务端执行；模型 tool_use（内置工具）→ 执行 → tool_result 回传 → 继续生成
	 */
	private async runAnthropicAgent(
		payload: { model: string; effort: ThinkingEffort; payload: unknown[]; system?: string },
		builtinTools: OVOBuiltinTool[],
		handlers: StreamHandlers,
		refs: MessageElRefs,
		records: OVOToolCallRecord[],
		webSearch: boolean
	): Promise<StreamResult> {
		const s = this.plugin.settings;
		const apiKey = this.plugin.getApiKey();
		const tools = builtinTools.length ? this.buildAnthropicTools(builtinTools) : undefined;
		const convo: unknown[] = Array.isArray(payload.payload) ? [...payload.payload] : [];
		let round = 0;
		while (true) {
			const result = await this.plugin.api.anthropicStream(
				convo,
				{
					apiKey,
					model: payload.model,
					effort: payload.effort,
					temperature: s.temperature,
					topP: s.topP,
					maxTokens: s.maxTokens,
					stop: parseStop(s.stopSequences),
					system: payload.system,
					webSearch,
					tools,
					signal: this.abort?.signal,
				},
				handlers
			);
			if (!tools || !result.toolCalls?.length) return result;
			if (++round > MAX_TOOL_ROUNDS) {
				result.content += "\n\n*（已达到单次回复的工具调用轮次上限，停止继续调用）*";
				return result;
			}
			// 回传 assistant 内容块（thinking / text / tool_use），随后以 tool_result 回传结果
			const blocks: unknown[] = [];
			if (result.reasoning.trim()) blocks.push({ type: "thinking", thinking: result.reasoning });
			if (result.content.trim()) blocks.push({ type: "text", text: result.content });
			for (const tc of result.toolCalls) {
				// 解析失败保持既有回退语义（空对象）
				const input: unknown = tc.args ?? {};
				blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input });
			}
			if (!blocks.length) blocks.push({ type: "text", text: "(tool call)" });
			convo.push({ role: "assistant", content: blocks });
			const toolResults: unknown[] = [];
			for (const tc of result.toolCalls) {
				const exec = await this.execTool(tc, records, refs);
				toolResults.push({ type: "tool_result", tool_use_id: tc.id, content: exec.text });
			}
			convo.push({ role: "user", content: toolResults });
		}
	}

	private autoResize(): void {
		this.inputEl.setCssProps({ height: "auto" });
		this.inputEl.setCssProps({
			height: Math.min(this.inputEl.scrollHeight, window.innerHeight * 0.28) + "px",
		});
	}

	/** token 估算缓存：消息一旦写入即不可变（内容长度即指纹），避免每次状态刷新对全文重算 */
	private tokenCache = new WeakMap<OVOMessage, { len: number; rlen: number; tokens: number }>();

	private msgTokens(m: OVOMessage): number {
		const rlen = (m.reasoning ?? "").length;
		const cached = this.tokenCache.get(m);
		if (cached && cached.len === m.content.length && cached.rlen === rlen) return cached.tokens;
		const tokens = estTokens(m.content) + estTokens(m.reasoning ?? "");
		this.tokenCache.set(m, { len: m.content.length, rlen, tokens });
		return tokens;
	}

	private updateStatus(): void {
		let tokens = 0;
		for (const t of this.displayPath()) {
			tokens += this.msgTokens(t.question);
			const a = activeAnswerOf(t);
			if (a) tokens += this.msgTokens(a);
		}
		this.statusRightEl.setText(`模型 ${this.model} · 上下文约 ${tokens.toLocaleString()} tokens`);
	}

	/* ================= 会话管理 ================= */

	/* ================= 临时对话 ================= */

	/**
	 * 临时对话开关（顶栏历史按键左侧）：
	 * - 开启：新建仅存于内存的会话（不落盘、不注入个性化 / 语法增强提示词），并弹出 Tips；
	 * - 关闭：丢弃临时会话，恢复进入前的会话（不存在时回到普通新对话）。
	 */
	private async toggleTempMode(): Promise<void> {
		if (this.streaming) this.stop();
		if (this.tempMode) {
			const prev = this.preTempSession;
			this.leaveTempMode();
			this.session = prev ?? this.plugin.store.newSession();
			this.plugin.lastSessionId = this.session.id;
			this.cursorTurn = null;
			this.rerenderAll();
			new Notice(prev ? "临时对话已关闭：临时记录已丢弃，已回到原对话" : "临时对话已关闭：临时记录已丢弃");
			return;
		}
		this.preTempSession = this.session;
		this.tempMode = true;
		this.session = this.plugin.store.newSession();
		this.session.title = "临时对话";
		this.cursorTurn = null;
		this.refreshTempBtn();
		this.rerenderAll();
		new Notice(
			"🕶️ 临时对话已开启：不注入个性化 / 语法增强提示词，对话与附件都不保存，退出后即消失",
			10000
		);
	}

	/** 退出临时模式（丢弃临时会话的内存数据，不产生任何磁盘写入；返回此前是否处于临时模式） */
	private leaveTempMode(): boolean {
		if (!this.tempMode) return false;
		this.tempMode = false;
		this.preTempSession = null;
		this.refreshTempBtn();
		return true;
	}

	/** 同步临时对话按键选中态 */
	private refreshTempBtn(): void {
		this.tempBtn?.toggleClass("is-active", this.tempMode);
	}

	async newChat(): Promise<void> {
		if (this.streaming) this.stop();
		this.leaveTempMode(); // 临时对话：新建即静默丢弃
		this.session = this.plugin.store.newSession();
		this.plugin.lastSessionId = this.session.id;
		this.cursorTurn = null;
		this.rerenderAll();
		this.inputEl.focus();
	}

	/** 打开（切换）一个历史会话 */
	async openSession(id: string): Promise<void> {
		if (this.streaming) this.stop();
		this.leaveTempMode(); // 临时对话：打开历史会话即静默丢弃
		const s = await this.plugin.store.getSession(id);
		if (!s) {
			new Notice("会话读取失败或已不存在");
			return;
		}
		this.session = s;
		this.plugin.lastSessionId = s.id;
		this.cursorTurn = null;
		this.rerenderAll();
		// 会话文件中附件正文已剥离：回读缺失正文后重渲染一次（仅当确有补齐）
		void this.plugin.store.hydrateAttachments(s).then((changed) => {
			if (changed && this.session === s) this.rerenderAll();
		});
	}

	/** 当前显示路径的 turn id 序列（侧边栏高亮：整链高亮 + 末端为游标节点） */
	turnPathIds(): string[] {
		return this.displayPath().map((t) => t.id);
	}

	/** 历史页重命名后同步标题（store 已更新同一会话对象，这里只刷新顶栏文本） */
	syncSessionMeta(id: string): void {
		if (this.session.id !== id) return;
		this.titleEl.setText(this.session.title || "新对话");
	}

	/** 个性化总开关在其他视图被切换后同步按键选中态 */
	syncPersonalizeChip(): void {
		this.refreshPersonalizeChip();
	}

	/** 锚点定位：滚动到当前显示路径的最后一个问句（不改变游标与激活路径） */
	private jumpToLastQuestion(): void {
		const path = this.displayPath();
		const last = path[path.length - 1];
		if (!last) {
			new Notice("当前对话还没有问句");
			return;
		}
		const el =
			this.turnEls.get(last.id)?.questionEl ??
			this.messagesEl.querySelector<HTMLElement>(`[data-turn-id="${last.id}"]`);
		if (!el) {
			new Notice("未找到最后一个问句");
			return;
		}
		this.autoScroll = false;
		el.scrollIntoView({ behavior: "smooth", block: "start" });
	}

	/** 跳转到指定问句：激活路径切换到该节点（游标截断，可从该节点续聊）并滚动定位 */
	jumpToTurn(turnId: string): void {
		if (this.streaming) return;
		const chain = findTurnChain(this.session.turns, turnId);
		if (!chain.length) return;
		const rootIdx = this.session.turns.indexOf(chain[0]);
		if (rootIdx < 0) return;
		this.session.activeTurn = rootIdx;
		for (let i = 0; i + 1 < chain.length; i++) {
			const parent = chain[i];
			parent.activeChild = Math.max(0, parent.children.indexOf(chain[i + 1]));
		}
		this.cursorTurn = chain[chain.length - 1];
		this.rerenderAll();
		this.autoScroll = false;
		const target = this.messagesEl.querySelector<HTMLElement>(`[data-turn-id="${turnId}"]`);
		target?.scrollIntoView({ behavior: "smooth", block: "start" });
	}

	private async showHistory(evt: MouseEvent): Promise<void> {
		const menu = new Menu();
		const entries = await this.plugin.store.listSessions();
		menu.addItem((item) =>
			item.setTitle("新对话").setIcon("plus").onClick(() => void this.newChat())
		);
		menu.addSeparator();
		if (!entries.length) {
			menu.addItem((item) => item.setTitle("（暂无历史对话）").setDisabled(true));
		}
		for (const e of entries.slice(0, 10)) {
			menu.addItem((item) =>
				item
					.setTitle(`${e.title} · ${new Date(e.updatedAt).toLocaleDateString()}`)
					.setIcon(e.id === this.session.id ? "check" : "message-square")
					.onClick(() => void this.openSession(e.id))
			);
		}
		menu.addItem((item) =>
			item
				.setTitle("更多历史记录")
				.setIcon("arrow-right")
				.onClick(() => void this.plugin.activateHistoryView())
		);
		menu.addSeparator();
		if (this.tempMode) {
			// 临时对话无落盘数据，无需删除
			menu.addItem((item) =>
				item.setTitle("临时对话：记录不会保存").setIcon("ghost").setDisabled(true)
			);
		} else {
			menu.addItem((item) =>
				item
					.setTitle("删除当前对话")
					.setIcon("trash-2")
				.onClick(() => {
					new ConfirmModal(
						this.app,
						`确定删除对话「${this.session.title}」及其全部数据（会话文件 / 附件）？`,
						async () => {
							await this.plugin.store.deleteSession(this.session.id);
							await this.newChat();
						}
					).open();
				})
			);
		}
		menu.showAtMouseEvent(evt);
	}

}

/** 从根列表深度搜索目标 turn，返回根→目标的链；未找到返回空数组 */
function findTurnChain(turns: ChatTurn[], id: string): ChatTurn[] {
	for (const t of turns) {
		if (t.id === id) return [t];
		const sub = findTurnChain(t.children, id);
		if (sub.length) return [t, ...sub];
	}
	return [];
}

function parseStop(raw: string): string[] | undefined {
	const list = raw
		.split("\n")
		.map((x) => x.trim())
		.filter(Boolean);
	return list.length ? list : undefined;
}

/** 工具结果摘要（展示用）：压缩后截断 */
function briefResult(text: string, max = 400): string {
	const one = text.replace(/\s+/g, " ").trim();
	return one.length > max ? one.slice(0, max) + `…（共 ${text.length} 字符）` : one;
}

/** 安全序列化（展示用） */
function safeJson(v: unknown): string {
	try {
		const s = typeof v === "string" ? v : JSON.stringify(v);
		return (s ?? "").slice(0, 400);
	} catch {
		return String(v);
	}
}

function readFileAsDataUrl(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
		reader.onerror = () => reject(reader.error ?? new Error("无法读取文件"));
		reader.readAsDataURL(file);
	});
}
