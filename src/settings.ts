/**
 * OVO 设置界面 —— 分页风格（密钥 · 界面 · 调参 · 工具 · 提示词 · 高级）
 *
 * 参考 Obsidian Editing Toolbar v4.1.4 的设置界面：顶部横向标签页 + 当前页内容，
 * 仅保留能归入这些分页的设置项，其余（接口地址 / 联网路由 / 自定义模型 /
 * 记录文件夹 / 行为开关等）一律砍掉。
 *
 * - 密钥：Obsidian 内置密钥库中的 DeepSeek API Key 选择与连通性测试
 * - 界面：思考内容 / 搜索来源的折叠行为，对话窗口工具栏按键的显示与排序
 * - 调参：默认模型（按官方 API 动态缓存）+ 思考强度 + 生成参数 + 上下文
 * - 工具：官方服务端 web_search 与内置只读工具组
 * - 提示词：个性化 / 数学增强 / 化学增强 / 绘图增强（页内分节）
 * - 高级：Obsidian 语法修正 / 键盘发送规则（页内分节）
 *
 * Author: munroe153
 */

import { App, Notice, PluginSettingTab, SecretComponent, Setting, setIcon } from "obsidian";
import type { SettingDefinition, SettingDefinitionItem, SettingDefinitionPage } from "obsidian";
import type { OVOChatPlugin } from "./main";
import type { OVOSettings, ThinkingEffort } from "./types";
import { toolbarButtonMeta } from "./toolbar";
import { CHART_TYPES, MERMAID_TYPES, DRAWING_TYPE_IDS, isChartsEnabled, type OVODrawingType } from "./drawing";
import {
	EMOJI_CHOICES,
	ENTHUSIASM_CHOICES,
	LAYOUT_CHOICES,
	TONE_CHOICES,
	WARMTH_CHOICES,
	type OVOChoice,
} from "./personalize";
import { SYNTAX_GROUPS, isChemEnabled, type OVOSyntaxItem } from "./syntax";
import { errMsg } from "./util";

type TabId = "key" | "ui" | "params" | "tools" | "prompts" | "advanced";

interface SettingTabDef {
	id: TabId;
	name: string;
	icon: string;
}

/** 六个分页（顺序即展示顺序） */
const SETTING_TABS: SettingTabDef[] = [
	{ id: "key", name: "密钥", icon: "key-round" },
	{ id: "ui", name: "界面", icon: "layout-dashboard" },
	{ id: "params", name: "调参", icon: "sliders-horizontal" },
	{ id: "tools", name: "工具", icon: "wrench" },
	{ id: "prompts", name: "提示词", icon: "sparkles" },
	{ id: "advanced", name: "高级", icon: "cog" },
];

/** 声明式绘图开关的合成键前缀（drawing:<type id>） */
const DRAWING_KEY_PREFIX = "drawing:";

/** 默认思考强度下拉选项 */
const EFFORT_OPTIONS: Record<string, string> = {
	off: "关闭（禁用思考模式）",
	low: "低（low）",
	medium: "中（medium）",
	high: "高（high）",
	max: "极大（max）",
};

/** 声明式控件中可直接按布尔写入的设置键 */
const BOOLEAN_SETTING_KEYS = new Set<string>([
	"injectTodayDate",
	"defaultToolMode",
	"defaultWebSearch",
	"collapseReasoning",
	"collapseSources",
	"personalizeEnabled",
	"syntaxMathJax",
	"syntaxMhchem",
	"syntaxChem",
	"syntaxTableSpacing",
	"syntaxHighlight",
]);

/** 声明式控件中可直接按字符串写入的设置键 */
const TEXT_SETTING_KEYS = new Set<string>([
	"systemPrompt",
	"stopSequences",
	"tone",
	"warmth",
	"enthusiasm",
	"emojiLevel",
	"layoutStyle",
]);

function isThinkingEffort(value: unknown): value is ThinkingEffort {
	return typeof value === "string" && Object.prototype.hasOwnProperty.call(EFFORT_OPTIONS, value);
}

/** 数值钳制：非法值回落 fallback */
function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
	const n = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(Math.max(n, min), max);
}

/** 整数钳制：非法值回落 fallback */
function clampInt(value: unknown, min: number, max: number, fallback: number): number {
	const n = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(Math.max(Math.round(n), min), max);
}

export class OVOSettingTab extends PluginSettingTab {
	activeTab: TabId = "key";

	/** 档位下拉的动态说明文本节点（声明式 desc；getSettingDefinitions 时重建） */
	private choiceDescNodes = new Map<string, { node: Text; choices: OVOChoice<string>[] }>();

	constructor(app: App, private plugin: OVOChatPlugin) {
		super(app, plugin);
	}

	/**
	 * 声明式设置定义（Obsidian 1.13+）：原生设置页 + 设置搜索索引。
	 *
	 * 标量设置一律使用原生 `control`（toggle / dropdown / text / textarea /
	 * number / slider）；密钥、连接测试、工具栏排序等复合项通过 `render`
	 * 把控件注入原生行。分页与分组与原「分页 UI」保持一致。
	 * 1.13 以下没有声明式 API，仍由下方 display() 渲染分页界面。
	 */
	getSettingDefinitions(): SettingDefinitionItem[] {
		this.choiceDescNodes.clear();
		return [this.keyPage(), this.uiPage(), this.paramsPage(), this.toolsPage(), this.promptsPage(), this.advancedPage()];
	}

	/* ---------------- 声明式分页 ---------------- */

	/** 密钥：Obsidian 内置密钥库选择 + 连通性测试 */
	private keyPage(): SettingDefinitionPage {
		return {
			type: "page",
			name: "密钥",
			desc: "DeepSeek API 密钥与连通性测试",
			items: [
				this.renderDef(
					"API 密钥",
					"从 Obsidian 内置密钥库选择或新建；密钥值由 Obsidian 管理，不写入插件配置。密钥库与当前库绑定，移动端需各自配置。",
					(setting) => this.addApiKeyControl(setting),
					["api key", "deepseek key", "secret", "令牌"]
				),
				this.renderDef(
					"测试连接",
					"验证密钥与网络，并刷新模型列表。",
					(setting) => this.addTestConnectionControl(setting),
					["test connection", "连通性", "验证"]
				),
			],
		};
	}

	/** 界面：消息显示 + 工具栏按键显示与排序 */
	private uiPage(): SettingDefinitionPage {
		return {
			type: "page",
			name: "界面",
			desc: "消息显示与工具栏按键",
			items: [
				{
					type: "group",
					heading: "消息显示",
					items: [
						this.toggleDef("collapseReasoning", "思考内容默认折叠", "默认折叠为一行摘要，点击展开。", [
							"reasoning",
							"思考",
						]),
						this.toggleDef("collapseSources", "搜索来源默认折叠", "默认折叠来源链接，点击展开。", [
							"sources",
							"来源",
						]),
					],
				},
				this.renderDef(
					"工具栏按键",
					"开关控制显示，上下箭头调整顺序。",
					(setting) => {
						setting.settingEl.addClass("ovo-settings-stacked");
						this.addToolbarConfig(setting.settingEl.createDiv("ovo-settings-stacked-body"));
					},
					["toolbar", "按键排序", ...this.plugin.settings.toolbarButtons.map((b) => toolbarButtonMeta(b.id)?.label ?? b.id)]
				),
			],
		};
	}

	/** 调参：模型 / 生成参数 / 上下文 */
	private paramsPage(): SettingDefinitionPage {
		const s = this.plugin.settings;
		const modelOptions: Record<string, string> = {};
		for (const m of this.plugin.getModelsSync()) modelOptions[m.id] = m.label;
		if (!modelOptions[s.defaultModel]) modelOptions[s.defaultModel] = s.defaultModel;

		return {
			type: "page",
			name: "调参",
			desc: "模型、思考强度与生成参数",
			items: [
				{
					type: "group",
					heading: "模型",
					items: [
						this.dropdownDef("defaultModel", "默认模型", "列表由官方 API 动态拉取；对话窗口内可随时切换。", modelOptions, [
							"model",
							"deepseek",
						]),
						this.dropdownDef("defaultEffort", "默认思考强度", "对话窗口可随时调节。", EFFORT_OPTIONS, [
							"effort",
							"thinking",
							"思考强度",
						]),
					],
				},
				{
					type: "group",
					heading: "生成参数",
					items: [
						this.textareaDef(
							"systemPrompt",
							"系统提示词（system prompt）",
							"每轮注入；留空不发送。",
							3,
							"你是一个乐于助人的助手…"
						),
						this.toggleDef("injectTodayDate", "注入当日日期", "注入当日日期（本地时区）；临时对话同样注入。", [
							"date",
							"日期",
						]),
						this.sliderDef("temperature", "temperature（温度）", "0 – 2，越高越有创造性；思考模式下无效。", 0, 2, 0.05),
						this.sliderDef("topP", "top_p（核采样）", "0 – 1；思考模式下仅 0.95–1.0 生效。", 0, 1, 0.01),
						this.numberDef(
							"maxTokens",
							"最大输出（max_tokens）",
							"单次回复最大输出 token 数（注意费用）。",
							1,
							undefined,
							1,
							(v) => (Number.isFinite(v) && v >= 1 ? undefined : "需为 ≥ 1 的整数")
						),
						this.textareaDef("stopSequences", "停止序列（stop_sequences）", "每行一个；留空不启用。", 2),
					],
				},
				{
					type: "group",
					heading: "上下文",
					items: [
						this.numberDef(
							"contextMessages",
							"上下文长度（历史消息条数）",
							"携带的最近消息条数；0 = 全部历史。",
							0,
							undefined,
							1,
							(v) => (Number.isFinite(v) && v >= 0 ? undefined : "需为 ≥ 0 的整数")
						),
						this.numberDef(
							"contextTokenBudget",
							"上下文 token 预算（估算）",
							"按估算 token 从最新向前保留；0 = 不限制。",
							0,
							undefined,
							1,
							(v) => (Number.isFinite(v) && v >= 0 ? undefined : "需为 ≥ 0 的整数")
						),
					],
				},
			],
		};
	}

	/** 工具：新对话默认值与读取范围 */
	private toolsPage(): SettingDefinitionPage {
		return {
			type: "page",
			name: "工具",
			desc: "联网搜索与只读仓库工具",
			items: [
				{
					type: "group",
					heading: "新对话默认值",
					items: [
						this.toggleDef("defaultWebSearch", "默认开启联网搜索", "新对话初值；对话窗口可随时切换。", [
							"web search",
							"联网",
						]),
						this.toggleDef("defaultToolMode", "默认开启工具调用", "新对话初值；对话窗口可随时切换。", [
							"tool",
							"工具调用",
						]),
					],
				},
				{
					type: "group",
					heading: "读取范围",
					items: [
						this.numberDef(
							"toolReadMaxChars",
							"字符上限",
							"内置工具单次读取上限（read_note / get_active_note，1000–200000 字符）。",
							1000,
							200000,
							1000,
							(v) => (Number.isFinite(v) && v >= 1000 && v <= 200000 ? undefined : "需在 1000–200000 之间")
						),
					],
				},
			],
		};
	}

	/** 提示词：个性化 + 数学 / 化学 / 绘图增强 */
	private promptsPage(): SettingDefinitionPage {
		return {
			type: "page",
			name: "提示词",
			desc: "个性化、数学 / 化学 / 绘图增强",
			items: [
				{
					type: "group",
					heading: "个性化",
					items: [
						this.toggleDef(
							"personalizeEnabled",
							"启用个性化",
							"总开关关闭后不注入任何风格 / 排版提示词（各档位选择保留）。",
							["personalize", "个性化"]
						),
						this.choiceDef("tone", "基本风格和语调", TONE_CHOICES, ["tone", "语气"]),
						this.choiceDef("warmth", "亲切程度", WARMTH_CHOICES),
						this.choiceDef("enthusiasm", "热情程度", ENTHUSIASM_CHOICES),
						this.choiceDef("emojiLevel", "表情符号", EMOJI_CHOICES),
						this.choiceDef("layoutStyle", "布局和视觉元素", LAYOUT_CHOICES),
					],
				},
				{
					type: "group",
					heading: "数学增强",
					items: [
						this.toggleDef("syntaxMathJax", "MathJax", "用 $…$ / $$…$$ 输出公式，Obsidian 原生渲染。", [
							"math",
							"latex",
							"公式",
						]),
					],
				},
				{
					type: "group",
					heading: "化学增强",
					items: [
						this.toggleDef("syntaxMhchem", "mhchem（化学方程式渲染）", "用 \\ce{} 输出化学式与方程式，Obsidian 内置渲染。", [
							"chem",
							"化学",
						]),
						this.toggleDef(
							"syntaxChem",
							"Chem 插件（SMILES 渲染）",
							"用 ```smiles 输出分子结构（一行一条），需 Chem 插件。",
							["smiles", "chem"]
						),
						this.warnDef("未检测到 Chem 插件", "安装并启用「chem」后，```smiles 代码块才会渲染。", () =>
							!isChemEnabled(this.app)
						),
					],
				},
				{
					type: "group",
					heading: "Charts 图表（```chart）",
					items: [
						this.warnDef("未检测到 Charts 插件", "安装并启用「obsidian-charts」后，```chart 图表才会渲染。", () =>
							!isChartsEnabled(this.app)
						),
						...CHART_TYPES.map((t) => this.drawingTypeDef(t)),
					],
				},
				{
					type: "group",
					heading: "Mermaid 图表（```mermaid）",
					items: MERMAID_TYPES.map((t) => this.drawingTypeDef(t)),
				},
			],
		};
	}

	/** 高级：语法修正 + 键盘发送规则 */
	private advancedPage(): SettingDefinitionPage {
		return {
			type: "page",
			name: "高级",
			desc: "Obsidian 语法修正与键盘发送规则",
			items: [
				{
					type: "group",
					heading: "Obsidian 语法修正",
					items: [
						this.toggleDef("syntaxTableSpacing", "表格前后留空", "渲染前修正表格前后空行。", ["table", "表格"]),
						this.toggleDef("syntaxHighlight", "==高亮== 归一化", "渲染前统一 ==高亮== 语法。", [
							"highlight",
							"高亮",
						]),
					],
				},
				{
					type: "group",
					heading: "键盘发送规则",
					items: [
						this.dropdownDef(
							"enterToSend",
							"发送键方案",
							"Ctrl/Cmd+Enter 始终发送。",
							{
								enter: "Enter 发送 · Shift+Enter 换行",
								shift: "Enter 换行 · Shift+Enter 发送",
							},
							["keyboard", "enter", "发送键"]
						),
					],
				},
			],
		};
	}

	/* ---------------- 控件取值 / 持久化 ---------------- */

	/** 读取控件值：合成键 drawing:<id> 与 enterToSend 需要映射，其余直读 settings */
	getControlValue(key: string): unknown {
		const s = this.plugin.settings;
		if (key.startsWith(DRAWING_KEY_PREFIX)) {
			return s.enabledDrawingTypes.includes(key.slice(DRAWING_KEY_PREFIX.length));
		}
		if (key === "enterToSend") return s.enterToSend ? "enter" : "shift";
		return (s as unknown as Record<string, unknown>)[key];
	}

	/** 写入控件值：校验 / 钳制后落盘，并触发对应副作用 */
	async setControlValue(key: string, value: unknown): Promise<void> {
		const s = this.plugin.settings;
		const raw = s as unknown as Record<string, unknown>;

		if (key.startsWith(DRAWING_KEY_PREFIX)) {
			const id = key.slice(DRAWING_KEY_PREFIX.length);
			if (!DRAWING_TYPE_IDS.includes(id)) return;
			const enabled = new Set(s.enabledDrawingTypes);
			if (value === true) enabled.add(id);
			else enabled.delete(id);
			// 按固定顺序归一，保证配置文件稳定
			s.enabledDrawingTypes = DRAWING_TYPE_IDS.filter((x) => enabled.has(x));
		} else if (key === "enterToSend") {
			s.enterToSend = value === "enter";
		} else if (key === "defaultModel") {
			if (typeof value !== "string" || !value.trim()) return;
			s.defaultModel = value;
		} else if (key === "defaultEffort") {
			if (!isThinkingEffort(value)) return;
			s.defaultEffort = value;
		} else if (key === "temperature") {
			s.temperature = clampNumber(value, 0, 2, s.temperature);
		} else if (key === "topP") {
			s.topP = clampNumber(value, 0, 1, s.topP);
		} else if (key === "maxTokens") {
			s.maxTokens = clampInt(value, 1, Number.MAX_SAFE_INTEGER, s.maxTokens);
		} else if (key === "contextMessages") {
			s.contextMessages = clampInt(value, 0, Number.MAX_SAFE_INTEGER, s.contextMessages);
		} else if (key === "contextTokenBudget") {
			s.contextTokenBudget = clampInt(value, 0, Number.MAX_SAFE_INTEGER, s.contextTokenBudget);
		} else if (key === "toolReadMaxChars") {
			s.toolReadMaxChars = clampInt(value, 1000, 200000, s.toolReadMaxChars);
		} else if (BOOLEAN_SETTING_KEYS.has(key)) {
			raw[key] = value === true;
		} else if (TEXT_SETTING_KEYS.has(key)) {
			raw[key] = typeof value === "string" ? value : "";
		} else {
			return;
		}

		await this.plugin.saveSettings();
		this.afterControlChange(key);
	}

	/** 控件写入后的联动：档位说明、个性化禁用态、语法修正重渲 */
	private afterControlChange(key: string): void {
		const entry = this.choiceDescNodes.get(key);
		if (entry) {
			const current = (this.plugin.settings as unknown as Record<string, unknown>)[key];
			const value = typeof current === "string" ? current : "";
			entry.node.nodeValue = entry.choices.find((c) => c.id === value)?.desc ?? "";
		}
		if (key === "personalizeEnabled") {
			this.syncDomState();
			this.plugin.notifyPersonalizeChanged();
		}
		if (
			key === "syntaxTableSpacing" ||
			key === "syntaxHighlight" ||
			key === "collapseReasoning" ||
			key === "collapseSources"
		) {
			this.plugin.refreshChatViews();
		}
	}

	/** 就地重算声明式控件的 disabled 谓词（1.13+；旧版本没有该 API） */
	private syncDomState(): void {
		const fn = (this as unknown as { refreshDomState?: () => void }).refreshDomState;
		if (typeof fn === "function") fn.call(this);
	}

	/* ---------------- 定义辅助 ---------------- */

	private toggleDef(key: keyof OVOSettings, name: string, desc: string, aliases?: string[]): SettingDefinition {
		return { name, desc, aliases, control: { type: "toggle", key } };
	}

	private dropdownDef(
		key: keyof OVOSettings,
		name: string,
		desc: string,
		options: Record<string, string>,
		aliases?: string[]
	): SettingDefinition {
		return { name, desc, aliases, control: { type: "dropdown", key, options } };
	}

	private textareaDef(
		key: keyof OVOSettings,
		name: string,
		desc: string,
		rows?: number,
		placeholder?: string
	): SettingDefinition {
		return { name, desc, control: { type: "textarea", key, rows, placeholder } };
	}

	private numberDef(
		key: keyof OVOSettings,
		name: string,
		desc: string,
		min?: number,
		max?: number,
		step?: number,
		validate?: (value: number) => string | void
	): SettingDefinition {
		return { name, desc, control: { type: "number", key, min, max, step, validate } };
	}

	private sliderDef(
		key: keyof OVOSettings,
		name: string,
		desc: string,
		min: number,
		max: number,
		step: number
	): SettingDefinition {
		return {
			name,
			desc,
			control: { type: "slider", key, min, max, step, displayFormat: (v) => String(v) },
		};
	}

	/** 个性化档位：说明随当前选项变化（描述用 DocumentFragment，文本节点就地更新） */
	private choiceDef<T extends string>(
		key: keyof OVOSettings,
		name: string,
		choices: OVOChoice<T>[],
		aliases?: string[]
	): SettingDefinition {
		const current = (this.plugin.settings as unknown as Record<string, unknown>)[key as string] as T;
		const node = document.createTextNode(this.choiceDesc(choices, current));
		const desc = createFragment();
		desc.appendChild(node);
		this.choiceDescNodes.set(key, { node, choices });

		const options: Record<string, string> = {};
		for (const c of choices) options[c.id] = c.name;
		return {
			name,
			desc,
			aliases,
			control: {
				type: "dropdown",
				key,
				options,
				// 总开关关闭时档位保留但不可修改
				disabled: () => !this.plugin.settings.personalizeEnabled,
			},
		};
	}

	private choiceDesc<T extends string>(choices: OVOChoice<T>[], id: T): string {
		return choices.find((c) => c.id === id)?.desc ?? "";
	}

	/** 自定义渲染行（把命令式控件注入原生设置行） */
	private renderDef(
		name: string,
		desc: string,
		render: (setting: Setting) => void,
		aliases?: string[]
	): SettingDefinition {
		return { name, desc, aliases, render };
	}

	/** 依赖外部插件是否安装的提示行（纯文字，不提供控件） */
	private warnDef(name: string, desc: string, visible: () => boolean): SettingDefinition {
		return {
			name,
			desc,
			visible,
			render: (setting) => {
				setting.settingEl.addClass("ovo-settings-warnrow");
			},
		};
	}

	/** 单个绘图类型开关（合成键 drawing:<id>） */
	private drawingTypeDef(type: OVODrawingType): SettingDefinition {
		return {
			name: type.name,
			desc: type.desc,
			aliases: ["drawing", "绘图", type.id],
			control: { type: "toggle", key: `${DRAWING_KEY_PREFIX}${type.id}` },
		};
	}

	display(): void {
		this.renderSettings();
	}

	/** 自定义分页设置界面（display 仅作为 Obsidian 的入口） */
	private renderSettings(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass("ovo-settings");

		// 标签页导航
		const tabsEl = containerEl.createDiv("ovo-settings-tabs");
		for (const tab of SETTING_TABS) {
			const tabEl = tabsEl.createDiv(`ovo-settings-tab${this.activeTab === tab.id ? " is-active" : ""}`);
			setIcon(tabEl, tab.icon);
			tabEl.createSpan({ text: tab.name });
			tabEl.addEventListener("click", () => {
				if (this.activeTab === tab.id) return;
				this.activeTab = tab.id;
				this.renderSettings();
			});
		}

		// 当前页内容
		const contentEl = containerEl.createDiv("ovo-settings-content");
		switch (this.activeTab) {
			case "key":
				this.renderKeyTab(contentEl);
				break;
			case "ui":
				this.renderUiTab(contentEl);
				break;
			case "params":
				this.renderParamsTab(contentEl);
				break;
			case "tools":
				this.renderToolsTab(contentEl);
				break;
			case "prompts":
				this.renderPromptsTab(contentEl);
				break;
			case "advanced":
				this.renderAdvancedTab(contentEl);
				break;
		}
	}

	/* ================= 密钥 ================= */

	private renderKeyTab(el: HTMLElement): void {
		new Setting(el)
			.setName("API 密钥")
			.setDesc(
				"从 Obsidian 内置密钥库选择或新建；密钥值由 Obsidian 管理，不写入插件配置。" +
					"密钥库与当前库绑定，移动端需各自配置。"
			)
			.then((setting) => this.addApiKeyControl(setting));

		new Setting(el)
			.setName("测试连接")
			.setDesc("验证密钥与网络，并刷新模型列表。")
			.then((setting) => this.addTestConnectionControl(setting));
	}

	/* ================= 共享控件（声明式 render 与旧分页复用） ================= */

	/** API 密钥选择器（Obsidian 内置密钥库） */
	private addApiKeyControl(setting: Setting): void {
		const s = this.plugin.settings;
		setting.addComponent((c) =>
			new SecretComponent(this.app, c)
				.setValue(s.apiKeySecretId ?? "")
				.onChange(async (v) => {
					s.apiKeySecretId = v ?? "";
					await this.plugin.saveSettings();
					// 换密钥即刷新模型列表缓存
					this.plugin.invalidateModels();
					void this.plugin.getModels(true);
				})
		);
	}

	/** 连接测试按钮：成功后写入模型列表缓存 */
	private addTestConnectionControl(setting: Setting): void {
		setting.addButton((b) =>
			b.setButtonText("测试连接").onClick(async () => {
				const apiKey = this.plugin.getApiKey();
				if (!apiKey) {
					new Notice("请先选择或新建密钥", 8000);
					return;
				}
				b.setDisabled(true);
				b.setButtonText("测试中…");
				try {
					const models = await this.plugin.api.listModels(apiKey);
					new Notice(
						models.length
							? `✅ 连接成功，可用模型：${models.map((m) => m.label).join("、")}`
							: "✅ 连接成功（未返回模型列表）",
						8000
					);
					this.plugin.settings.modelCache = { at: Date.now(), models };
					await this.plugin.saveSettings();
				} catch (e) {
					new Notice(`❌ 连接失败：${errMsg(e)}`, 10000);
				} finally {
					b.setDisabled(false);
					b.setButtonText("测试连接");
				}
			})
		);
	}

	/** 工具栏按键清单（显示开关 + 上下排序；重建时就地刷新，避免整页重绘） */
	private addToolbarConfig(container: HTMLElement): void {
		container.empty();
		const s = this.plugin.settings;
		s.toolbarButtons.forEach((btn, idx) => {
			const meta = toolbarButtonMeta(btn.id);
			const setting = new Setting(container).setName(meta?.label ?? btn.id).setDesc(meta?.desc ?? "");
			if (meta?.icon) {
				const icon = setting.nameEl.createSpan("ovo-toolbar-config-icon");
				setIcon(icon, meta.icon);
			}
			setting.addToggle((t) =>
				t.setValue(btn.visible).onChange(async (v) => {
					// 按 id 定位，避免排序后闭包引用过期
					const item = s.toolbarButtons.find((b) => b.id === btn.id);
					if (item) item.visible = v;
					await this.plugin.saveSettings();
				})
			);
			setting.addExtraButton((b) =>
				b
					.setIcon("chevron-up")
					.setTooltip("上移")
					.setDisabled(idx === 0)
					.onClick(async () => {
						this.moveToolbarButton(idx, -1);
						await this.plugin.saveSettings();
						this.addToolbarConfig(container);
					})
			);
			setting.addExtraButton((b) =>
				b
					.setIcon("chevron-down")
					.setTooltip("下移")
					.setDisabled(idx === s.toolbarButtons.length - 1)
					.onClick(async () => {
						this.moveToolbarButton(idx, 1);
						await this.plugin.saveSettings();
						this.addToolbarConfig(container);
					})
			);
		});
	}

	/* ================= 调参 ================= */

	private renderParamsTab(el: HTMLElement): void {
		const s = this.plugin.settings;

		new Setting(el)
			.setName("默认模型")
			.setDesc("列表由官方 API 动态拉取；对话窗口内可随时切换。")
			.addDropdown((d) => {
				const models = this.plugin.getModelsSync();
				for (const m of models) d.addOption(m.id, m.label);
				if (!models.some((m) => m.id === s.defaultModel)) {
					d.addOption(s.defaultModel, s.defaultModel);
				}
				d.setValue(s.defaultModel).onChange(async (v) => {
					s.defaultModel = v;
					await this.plugin.saveSettings();
				});
			});

		new Setting(el)
			.setName("默认思考强度")
			.setDesc("对话窗口可随时调节。")
			.addDropdown((d) => {
				d.addOption("off", "关闭（禁用思考模式）");
				d.addOption("low", "低（low）");
				d.addOption("medium", "中（medium）");
				d.addOption("high", "高（high）");
				d.addOption("max", "极大（max）");
				d.setValue(s.defaultEffort).onChange(async (v) => {
					s.defaultEffort = v as ThinkingEffort;
					await this.plugin.saveSettings();
				});
			});

		new Setting(el)
			.setName("系统提示词（system prompt）")
			.setDesc("每轮注入；留空不发送。")
			.addTextArea((t) => {
				t.setValue(s.systemPrompt)
					.setPlaceholder("你是一个乐于助人的助手…")
					.onChange(async (v) => {
						s.systemPrompt = v;
						await this.plugin.saveSettings();
					});
				t.inputEl.rows = 3;
				t.inputEl.addClass("ovo-settings-input-wide");
			});

		new Setting(el)
			.setName("注入当日日期")
			.setDesc("注入当日日期（本地时区）；临时对话同样注入。")
			.addToggle((t) =>
				t.setValue(s.injectTodayDate).onChange(async (v) => {
					s.injectTodayDate = v;
					await this.plugin.saveSettings();
				})
			);

		this.slider(el, "temperature（温度）", "0 – 2，越高越有创造性；思考模式下无效。", s.temperature, 0, 2, 0.05, (v) => (s.temperature = v));
		this.slider(el, "top_p（核采样）", "0 – 1；思考模式下仅 0.95–1.0 生效。", s.topP, 0, 1, 0.01, (v) => (s.topP = v));

		new Setting(el)
			.setName("最大输出（max_tokens）")
			.setDesc("单次回复最大输出 token 数（注意费用）。")
			.addText((t) =>
				t.setValue(String(s.maxTokens)).onChange(async (v) => {
					const n = parseInt(v, 10);
					if (!Number.isNaN(n) && n > 0) {
						s.maxTokens = n;
						await this.plugin.saveSettings();
					}
				})
			);

		new Setting(el)
			.setName("停止序列（stop_sequences）")
			.setDesc("每行一个；留空不启用。")
			.addTextArea((t) => {
				t.setValue(s.stopSequences).onChange(async (v) => {
					s.stopSequences = v;
					await this.plugin.saveSettings();
				});
				t.inputEl.rows = 2;
				t.inputEl.addClass("ovo-settings-input-wide");
			});

		new Setting(el)
			.setName("上下文长度（历史消息条数）")
			.setDesc("携带的最近消息条数；0 = 全部历史。")
			.addText((t) =>
				t.setValue(String(s.contextMessages)).onChange(async (v) => {
					const n = parseInt(v, 10);
					if (!Number.isNaN(n) && n >= 0) {
						s.contextMessages = n;
						await this.plugin.saveSettings();
					}
				})
			);

		new Setting(el)
			.setName("上下文 token 预算（估算）")
			.setDesc("按估算 token 从最新向前保留；0 = 不限制。")
			.addText((t) =>
				t.setValue(String(s.contextTokenBudget)).onChange(async (v) => {
					const n = parseInt(v, 10);
					if (!Number.isNaN(n) && n >= 0) {
						s.contextTokenBudget = n;
						await this.plugin.saveSettings();
					}
				})
			);
	}

	/* ================= 提示词：个性化 ================= */

	private renderPersonalSection(el: HTMLElement): void {
		const s = this.plugin.settings;
		const on = s.personalizeEnabled;

		this.note(
			el,
			on
				? "总开关在对话工具栏「个性化」按键；选「默认」档不注入。"
				: "个性化已关闭（工具栏「个性化」按键），档位保留但不注入。",
			on ? undefined : "warn"
		);

		this.choiceSetting(el, "基本风格和语调", TONE_CHOICES, s.tone, (v) => (s.tone = v), on);

		this.heading(el, "表达程度", "gauge", true);
		this.choiceSetting(el, "亲切程度", WARMTH_CHOICES, s.warmth, (v) => (s.warmth = v), on);
		this.choiceSetting(el, "热情程度", ENTHUSIASM_CHOICES, s.enthusiasm, (v) => (s.enthusiasm = v), on);
		this.choiceSetting(el, "表情符号", EMOJI_CHOICES, s.emojiLevel, (v) => (s.emojiLevel = v), on);

		this.choiceSetting(el, "布局和视觉元素", LAYOUT_CHOICES, s.layoutStyle, (v) => (s.layoutStyle = v), on);
	}

	/* ================= 高级：键盘发送 ================= */

	private renderKeyboardSection(el: HTMLElement): void {
		const s = this.plugin.settings;
		new Setting(el)
			.setName("发送键方案")
			.setDesc("Ctrl/Cmd+Enter 始终发送。")
			.addDropdown((d) => {
				d.addOption("enter", "Enter 发送 · Shift+Enter 换行");
				d.addOption("shift", "Enter 换行 · Shift+Enter 发送");
				d.setValue(s.enterToSend ? "enter" : "shift").onChange(async (v) => {
					s.enterToSend = v === "enter";
					await this.plugin.saveSettings();
				});
			});
	}

	/** 下拉选择（选项自带说明：切换时同步更新设置项说明文字；disabled 用于总开关关闭时置灰） */
	private choiceSetting<T extends string>(
		el: HTMLElement,
		name: string,
		choices: OVOChoice<T>[],
		value: T,
		assign: (v: T) => void,
		disabled = false
	): void {
		const setting = new Setting(el).setName(name);
		const updateDesc = (id: T) => setting.setDesc(choices.find((c) => c.id === id)?.desc ?? "");
		updateDesc(value);
		setting.addDropdown((d) => {
			for (const c of choices) d.addOption(c.id, c.name);
			d.setValue(value).onChange(async (v) => {
				assign(v as T);
				updateDesc(v as T);
				await this.plugin.saveSettings();
			});
			if (disabled) d.setDisabled(true);
		});
		if (disabled) setting.setDisabled(true);
	}

	/* ================= 提示词：语法增强（按分节调用） ================= */

	private renderSyntaxSection(el: HTMLElement, keys: OVOSyntaxItem["key"][]): void {
		const s = this.plugin.settings;
		const wanted = new Set<OVOSyntaxItem["key"]>(keys);
		const items = SYNTAX_GROUPS.flatMap((g) => g.items).filter((i) => wanted.has(i.key));
		for (const item of items) {
			new Setting(el)
				.setName(item.name)
				.setDesc(item.desc)
				.addToggle((t) =>
					t.setValue(s[item.key]).onChange(async (v) => {
						s[item.key] = v;
						await this.plugin.saveSettings();
						// 两个渲染修正开关即时生效：重渲已打开的对话视图
						if (item.key === "syntaxTableSpacing" || item.key === "syntaxHighlight") {
							this.plugin.refreshChatViews();
						}
					})
				);
		}
		// 化学增强：仅在 Chem 插件缺失时提示安装
		if (wanted.has("syntaxChem") && !isChemEnabled(this.app)) {
			this.note(el, "未检测到 Chem 插件：安装并启用「chem」后，```smiles 代码块才会渲染。", "warn");
		}
	}

	/* ================= 分页：提示词 ================= */

	private renderPromptsTab(el: HTMLElement): void {
		this.heading(el, "个性化", "smile");
		this.renderPersonalSection(el);

		this.heading(el, "数学增强", "sigma");
		this.renderSyntaxSection(el, ["syntaxMathJax"]);

		this.heading(el, "化学增强", "flask-conical");
		this.renderSyntaxSection(el, ["syntaxMhchem", "syntaxChem"]);

		this.heading(el, "绘图增强", "pie-chart");
		this.renderDrawingSection(el);
	}

	/* ================= 分页：高级 ================= */

	private renderAdvancedTab(el: HTMLElement): void {
		this.heading(el, "Obsidian 语法修正", "wand-2");
		this.renderSyntaxSection(el, ["syntaxTableSpacing", "syntaxHighlight"]);

		this.heading(el, "键盘发送规则", "keyboard");
		this.renderKeyboardSection(el);
	}

	/* ================= 工具 ================= */

	private renderToolsTab(el: HTMLElement): void {
		const s = this.plugin.settings;

		new Setting(el)
			.setName("新对话默认开启联网搜索")
			.setDesc("新对话初值；对话窗口可随时切换。")
			.addToggle((t) =>
				t.setValue(s.defaultWebSearch).onChange(async (v) => {
					s.defaultWebSearch = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(el)
			.setName("新对话默认开启工具调用")
			.setDesc("新对话初值；对话窗口可随时切换。")
			.addToggle((t) =>
				t.setValue(s.defaultToolMode).onChange(async (v) => {
					s.defaultToolMode = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(el)
			.setName("读取范围（字符上限）")
			.setDesc("内置工具单次读取上限（read_note / get_active_note，1000–200000 字符）。")
			.addText((t) =>
				t.setValue(String(s.toolReadMaxChars)).onChange(async (v) => {
					const n = parseInt(v, 10);
					if (!Number.isNaN(n) && n >= 1000 && n <= 200000) {
						s.toolReadMaxChars = n;
						await this.plugin.saveSettings();
					}
				})
			);
	}

	/* ================= 界面 ================= */

	private renderUiTab(el: HTMLElement): void {
		const s = this.plugin.settings;

		this.heading(el, "消息显示", "eye");
		new Setting(el)
			.setName("思考内容默认折叠")
			.setDesc("默认折叠为一行摘要，点击展开。")
			.addToggle((t) =>
				t.setValue(s.collapseReasoning).onChange(async (v) => {
					s.collapseReasoning = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(el)
			.setName("搜索来源默认折叠")
			.setDesc("默认折叠来源链接，点击展开。")
			.addToggle((t) =>
				t.setValue(s.collapseSources).onChange(async (v) => {
					s.collapseSources = v;
					await this.plugin.saveSettings();
				})
			);

		this.heading(el, "工具栏按键", "layout-grid");
		this.note(el, "开关控制显示，上下箭头调整顺序。");
		this.addToolbarConfig(el.createDiv("ovo-toolbar-config"));
	}

	/** 调整工具栏按键顺序（就地交换 settings.toolbarButtons） */
	private moveToolbarButton(index: number, delta: number): void {
		const list = this.plugin.settings.toolbarButtons;
		const target = index + delta;
		if (target < 0 || target >= list.length) return;
		const [item] = list.splice(index, 1);
		list.splice(target, 0, item);
	}

	/* ================= 提示词：绘图增强 ================= */

	private renderDrawingSection(el: HTMLElement): void {
		this.note(el, "只注入已勾选类型的提示词；是否启用由工具栏「绘图」按键控制。");

		/* ---- Charts 图表（```chart） ---- */
		this.heading(el, "Charts 图表（```chart）", "pie-chart", true);
		if (!isChartsEnabled(this.app)) {
			this.note(el, "未检测到 Charts 插件：安装并启用「obsidian-charts」后，```chart 图表才会渲染。", "warn");
		}
		this.drawingTypesList(el, CHART_TYPES);

		/* ---- Mermaid 图表（```mermaid · Obsidian 原生渲染） ---- */
		this.heading(el, "Mermaid 图表（```mermaid）", "workflow", true);
		this.drawingTypesList(el, MERMAID_TYPES);
	}

	/** 图表类型勾选列表（按传入分组展示；保存时按全量固定顺序归一，保证配置稳定） */
	private drawingTypesList(el: HTMLElement, types: OVODrawingType[]): void {
		const s = this.plugin.settings;
		const list = el.createDiv("ovo-drawing-list");
		for (const t of types) {
			new Setting(list)
				.setName(t.name)
				.setDesc(t.desc)
				.addToggle((tg) =>
					tg.setValue(s.enabledDrawingTypes.includes(t.id)).onChange(async (v) => {
						const enabled = new Set(s.enabledDrawingTypes);
						if (v) enabled.add(t.id);
						else enabled.delete(t.id);
						s.enabledDrawingTypes = DRAWING_TYPE_IDS.filter((id) => enabled.has(id));
						await this.plugin.saveSettings();
					})
				);
		}
	}

	/* ================= 小部件 ================= */

	private heading(el: HTMLElement, text: string, icon: string, sub = false): void {
		const head = el.createDiv(`ovo-settings-heading${sub ? " is-sub" : ""}`);
		const iconEl = head.createSpan("ovo-settings-heading-icon");
		setIcon(iconEl, icon);
		head.createSpan({ cls: "ovo-settings-heading-text", text });
	}

	private note(el: HTMLElement, text: string, variant?: "warn"): void {
		const div = el.createDiv({ cls: "ovo-settings-note", text });
		if (variant) div.addClass(`is-${variant}`);
	}

	private slider(
		containerEl: HTMLElement,
		name: string,
		desc: string,
		value: number,
		min: number,
		max: number,
		step: number,
		assign: (v: number) => void
	): void {
		const setting = new Setting(containerEl).setName(name).setDesc(desc);
		const label = setting.controlEl.createDiv("ovo-slider-value");
		label.setText(String(value));
		setting.addSlider((sl) => {
			sl.setLimits(min, max, step)
				.setValue(value)
				.onChange(async (v) => {
					assign(v);
					label.setText(String(v));
					await this.plugin.saveSettings();
				});
			sl.sliderEl.addClass("ovo-settings-slider");
		});
	}
}
