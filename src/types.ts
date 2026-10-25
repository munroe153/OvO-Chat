/**
 * OvO Chat — 共享类型定义
 * Author: munroe153
 */

import { defaultToolbarButtons } from "./toolbar";
import { DRAWING_TYPE_IDS } from "./drawing";

/** 思考强度（映射 DeepSeek 官方 thinking / output_config.effort） */
export type ThinkingEffort = "off" | "low" | "medium" | "high" | "max";

/** 个性化 —— 基本风格和语调 */
export type OVOToneId = "default" | "professional" | "friendly" | "blunt" | "whimsical" | "pragmatic" | "sarcastic";

/** 个性化 —— 三档程度（增强 / 默认 / 减弱） */
export type OVOLevel = "up" | "default" | "down";

/** 个性化 —— 布局和视觉元素 */
export type OVOLayoutStyle = "default" | "concise";

/** 对话窗口工具栏按键 id（顺序与显示由设置「界面」分页控制） */
export type OVOToolbarButtonId =
	| "model"
	| "effort"
	| "webSearch"
	| "toolMode"
	| "drawing"
	| "personalize"
	| "attach"
	| "note";

/** 单个工具栏按键的显示状态（顺序即数组顺序） */
export interface OVOToolbarButton {
	id: OVOToolbarButtonId;
	/** 是否在工具栏中显示 */
	visible: boolean;
}

/** 一个可用模型（来自官方 GET /models 的动态缓存） */
export interface OVOModelInfo {
	/** 模型 ID（请求时作为 model 参数） */
	id: string;
	/** 展示名（官方 name 字段，缺省时回落到 id） */
	label: string;
}

/** 模型列表缓存（随密钥变化 / 时间滚动刷新） */
interface OVOModelCache {
	/** 拉取时间戳（ms） */
	at: number;
	models: OVOModelInfo[];
}

/** 附件（图片 / 文本类文件） */
export interface OVOAttachment {
	/** 唯一 id */
	id: string;
	/** 展示名（含扩展名） */
	name: string;
	/** MIME 类型 */
	mime: string;
	/** 字节大小 */
	size: number;
	/** image：走视觉输入；text：读取内容注入提示词 */
	kind: "image" | "text";
	/** 保存到插件数据目录后的路径（相对库根，形如 .obsidian/plugins/ovo-chat/attachments/…），用于按需回读 */
	vaultPath?: string;
	/** 图片 base64 data URL（data:image/png;base64,...） */
	dataUrl?: string;
	/** 文本附件内容（仅「当前笔记」附加使用；上传附件只支持图片） */
	text?: string;
}

/** 一次工具调用记录（对话窗口工具调用模式） */
export interface OVOToolCallRecord {
	/** 模型调用的工具名（内置工具名） */
	name: string;
	/** 模型给出的参数（对象或原始串） */
	args?: unknown;
	/** 执行结果（截断后的字符串） */
	result?: string;
	ok?: boolean;
	ts?: number;
}

/** 一条对话消息 */
export interface OVOMessage {
	id: string;
	role: "user" | "assistant";
	content: string;
	/** 深度思考（thinking / CoT） */
	reasoning?: string;
	model?: string;
	effort?: ThinkingEffort;
	webSearch?: boolean;
	/** 本轮是否开启了绘图模式（注入 Charts 图表提示词） */
	drawing?: boolean;
	ts: number;
	attachments?: OVOAttachment[];
	error?: boolean;
	usage?: OVOUsage | null;
	durationMs?: number;
	sources?: OVOMessageSource[];
	/** 联网模式下：本次是否实际触发了服务端搜索 */
	searchTriggered?: boolean;
	/** 工具调用模式下：本轮的工具调用轨迹 */
	toolCalls?: OVOToolCallRecord[];
}

export interface OVOMessageSource {
	title?: string;
	url: string;
}

export interface OVOUsage {
	input_tokens?: number;
	output_tokens?: number;
	reasoning_tokens?: number;
}

/** 一轮「问→答映射」：问句 + 答案集（重新生成）+ 子分支（编辑 / 续聊） */
export interface ChatTurn {
	id: string;
	/** 问句（含附件） */
	question: OVOMessage;
	/** 答案集：重新生成追加（同问不同答） */
	answers: OVOMessage[];
	/** 当前激活答案索引（读盘归一化时钳制） */
	activeAnswer: number;
	/** 子问句分支（基于该映射继续对话 / 编辑问句产生） */
	children: ChatTurn[];
	/** 当前激活子分支索引（读盘归一化时钳制） */
	activeChild: number;
}

/** 一次完整对话（会话）：以「问→答映射」树组织 */
export interface OVOSession {
	id: string;
	title: string;
	createdAt: number;
	updatedAt: number;
	/** 自定义标签（历史记录页管理与筛选；不影响对话内容） */
	tags: string[];
	/** 根问句（编辑首问会产生多根） */
	turns: ChatTurn[];
	/** 当前激活的根分支索引（读盘归一化时钳制） */
	activeTurn: number;
}

/** 索引钳制：len<=0 或非法值返回 0，否则夹到 [0, len-1] */
export function clampIdx(i: unknown, len: number): number {
	if (len <= 0) return 0;
	const n = typeof i === "number" && Number.isFinite(i) ? Math.trunc(i) : 0;
	return Math.min(Math.max(n, 0), len - 1);
}

/** 深度优先遍历全部 turn（含所有分支） */
export function* walkTurns(turns: ChatTurn[]): Generator<ChatTurn> {
	for (const t of turns) {
		yield t;
		yield* walkTurns(t.children);
	}
}

/** 激活路径：根 turn 起沿 activeChild 链收集（渲染 / 上下文 / 统计的唯一依据） */
export function activePath(session: OVOSession): ChatTurn[] {
	const path: ChatTurn[] = [];
	let turn: ChatTurn | undefined = session.turns[clampIdx(session.activeTurn, session.turns.length)];
	while (turn) {
		path.push(turn);
		turn = turn.children[clampIdx(turn.activeChild, turn.children.length)];
	}
	return path;
}

/** turn 的当前激活答案（尚无答案时为 undefined） */
export function activeAnswerOf(turn: ChatTurn): OVOMessage | undefined {
	return turn.answers[clampIdx(turn.activeAnswer, turn.answers.length)];
}

/** 读盘归一化：钳制会话与全部 turn 的索引引用（防手编或损坏数据） */
export function normalizeSessionRefs(session: OVOSession): void {
	session.activeTurn = clampIdx(session.activeTurn, session.turns.length);
	for (const t of walkTurns(session.turns)) {
		t.activeAnswer = clampIdx(t.activeAnswer, t.answers.length);
		t.activeChild = clampIdx(t.activeChild, t.children.length);
	}
}

export interface OVOSettings {
	/**
	 * DeepSeek 官方 API Key 的「密钥名」——Obsidian 内置密钥库（SecretStorage）中的 id。
	 * 设置文件里只保存这个名字，密钥值由 Obsidian 统一安全管理；
	 * 取值请一律使用 `OVOChatPlugin.getApiKey()`。
	 */
	apiKeySecretId: string;

	/* ---- 调参 ---- */
	defaultModel: string;
	defaultEffort: ThinkingEffort;
	systemPrompt: string;
	/** 温度：0 – 2 */
	temperature: number;
	/** 核采样：0 – 1（思考模式下官方仅在 0.95–1.0 生效） */
	topP: number;
	/** 单次回复最大输出 token 数；0 = 不限制（请求不发送 max_tokens，交由服务端决定） */
	maxTokens: number;
	/** 每行一个停止序列；空 = 不启用 */
	stopSequences: string;
	/** 携带的最大历史消息条数；0 = 不限制 */
	contextMessages: number;
	/** 上下文 token 估算预算；0 = 不限制 */
	contextTokenBudget: number;
	/** 每轮对话在系统提示词注入当日日期（年 / 月 / 日） */
	injectTodayDate: boolean;

	/* ---- 工具 ---- */
	/** 新对话是否默认开启「工具调用」（内置只读工具组） */
	defaultToolMode: boolean;
	/** 新对话是否默认开启官方服务端联网搜索 */
	defaultWebSearch: boolean;
	/** 读笔记工具（read_note / get_active_note）单次读取的字符上限 */
	toolReadMaxChars: number;

	/* ---- 界面 ---- */
	/** 思考内容默认折叠（关闭则默认展开） */
	collapseReasoning: boolean;
	/** 搜索来源默认折叠（关闭则默认展开） */
	collapseSources: boolean;
	/** 对话窗口工具栏按键的显示与排列顺序 */
	toolbarButtons: OVOToolbarButton[];

	/* ---- 绘图 ---- */
	/** 已勾选的绘图类型（启用绘图模式时只注入这些类型的提示词） */
	enabledDrawingTypes: string[];

	/* ---- 个性化（语调 / 程度 / 排版；选「默认」档时不注入） ---- */
	/** 个性化总开关：由对话输入区工具栏「个性化」按键切换（设置页只提供档位）；关闭后不注入任何风格 / 排版提示词 */
	personalizeEnabled: boolean;
	/** 基本风格和语调 */
	tone: OVOToneId;
	/** 亲切程度 */
	warmth: OVOLevel;
	/** 热情程度 */
	enthusiasm: OVOLevel;
	/** 表情符号 */
	emojiLevel: OVOLevel;
	/** 布局和视觉元素 */
	layoutStyle: OVOLayoutStyle;
	/** 键盘发送（仅桌面端）：true = Enter 发送 · Shift+Enter 换行；false = Enter 换行 · Shift+Enter 发送 */
	enterToSend: boolean;

	/* ---- 语法增强 ---- */
	/** 数学：注入 MathJax（$…$ / $$…$$）语法要求 */
	syntaxMathJax: boolean;
	/** 化学：注入 mhchem（\ce{}）语法要求 */
	syntaxMhchem: boolean;
	/** 化学：注入 ```smiles 代码块要求（需 Chem 插件渲染） */
	syntaxChem: boolean;
	/** 渲染前修正：表格前后留空 */
	syntaxTableSpacing: boolean;
	/** 渲染前修正：==高亮== 归一化 */
	syntaxHighlight: boolean;

	/* ---- 专注时间 ---- */
	/** 专注结束时间戳（ms）；null = 未处于专注时间。持久化保存，重启插件不重置 */
	focusUntil: number | null;

	/** 模型列表缓存（官方 GET /models 动态拉取；设置界面不展示原始项） */
	modelCache: OVOModelCache | null;
}

export const DEFAULT_SETTINGS: OVOSettings = {
	apiKeySecretId: "",
	defaultModel: "deepseek-flash",
	defaultEffort: "high",
	systemPrompt: "",
	temperature: 1.0,
	topP: 0.95,
	maxTokens: 8192,
	stopSequences: "",
	contextMessages: 0,
	contextTokenBudget: 64000,
	injectTodayDate: true,
	defaultToolMode: false,
	defaultWebSearch: false,
	toolReadMaxChars: 20000,
	collapseReasoning: true,
	collapseSources: true,
	toolbarButtons: defaultToolbarButtons(),
	enabledDrawingTypes: DRAWING_TYPE_IDS,
	personalizeEnabled: true,
	tone: "default",
	warmth: "default",
	enthusiasm: "default",
	emojiLevel: "default",
	layoutStyle: "default",
	enterToSend: true,
	syntaxMathJax: false,
	syntaxMhchem: false,
	syntaxChem: false,
	syntaxTableSpacing: true,
	syntaxHighlight: true,
	focusUntil: null,
	modelCache: null,
};

export function genId(prefix = "m"): string {
	return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}
