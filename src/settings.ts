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
import type { SettingDefinitionItem } from "obsidian";
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

export class OVOSettingTab extends PluginSettingTab {
	activeTab: TabId = "key";

	constructor(app: App, private plugin: OVOChatPlugin) {
		super(app, plugin);
	}

	/**
	 * 声明式设置定义（Obsidian 1.13+）：供「设置搜索」索引使用。
	 *
	 * 界面渲染仍由下面的 display() 分页实现负责——分页布局在移动端更紧凑，
	 * 且 1.11 / 1.12 上也能正常工作；声明只描述每个设置的名称、说明与控件类型，
	 * 使 1.13+ 的设置搜索能检索到这些设置项。
	 */
	getSettingDefinitions(): SettingDefinitionItem[] {
		const s = this.plugin.settings;
		const models = this.plugin.getModelsSync();
		const modelOptions: Record<string, string> = {};
		for (const m of models) modelOptions[m.id] = m.label;
		if (!models.some((m) => m.id === s.defaultModel)) {
			modelOptions[s.defaultModel] = s.defaultModel;
		}

		return [
			{
				type: "page",
				name: "密钥",
				desc: "DeepSeek API 密钥与连通性测试",
				items: [
					{
						name: "API 密钥",
						desc: "从 Obsidian 内置密钥库选择或新建；密钥值由 Obsidian 管理，不写入插件配置。",
						aliases: ["api key", "deepseek key", "secret"],
					},
					{
						name: "测试连接",
						desc: "验证密钥与网络，并刷新模型列表。",
						aliases: ["test connection", "连通性"],
					},
				],
			},
			{
				type: "page",
				name: "界面",
				desc: "消息显示与工具栏按键",
				items: [
					this.toggleDef("collapseReasoning", "思考内容默认折叠", "默认折叠为一行摘要，点击展开。"),
					this.toggleDef("collapseSources", "搜索来源默认折叠", "默认折叠来源链接，点击展开。"),
					{
						name: "工具栏按键",
						desc: "控制对话窗口工具栏按键的显示与排列顺序。",
						aliases: ["toolbar", "按键排序"],
					},
				],
			},
			{
				type: "page",
				name: "调参",
				desc: "模型、思考强度与生成参数",
				items: [
					{
						name: "默认模型",
						desc: "列表由官方 API 动态拉取；对话窗口内可随时切换。",
						control: { type: "dropdown", key: "defaultModel", options: modelOptions },
					},
					this.dropdownDef("defaultEffort", "默认思考强度", "对话窗口可随时调节。", {
						off: "关闭（禁用思考模式）",
						low: "低（low）",
						medium: "中（medium）",
						high: "高（high）",
						max: "极大（max）",
					}),
					this.textareaDef("systemPrompt", "系统提示词（system prompt）", "每轮注入；留空不发送。"),
					this.toggleDef("injectTodayDate", "注入当日日期", "注入当日日期（本地时区）；临时对话同样注入。"),
					this.sliderDef("temperature", "temperature（温度）", "0 – 2，越高越有创造性；思考模式下无效。", 0, 2, 0.05),
					this.sliderDef("topP", "top_p（核采样）", "0 – 1；思考模式下仅 0.95–1.0 生效。", 0, 1, 0.01),
					this.numberDef("maxTokens", "最大输出（max_tokens）", "单次回复最大输出 token 数（注意费用）。", 1),
					this.textareaDef("stopSequences", "停止序列（stop_sequences）", "每行一个；留空不启用。"),
					this.numberDef("contextMessages", "上下文长度（历史消息条数）", "携带的最近消息条数；0 = 全部历史。", 0),
					this.numberDef("contextTokenBudget", "上下文 token 预算（估算）", "按估算 token 从最新向前保留；0 = 不限制。", 0),
				],
			},
			{
				type: "page",
				name: "工具",
				desc: "联网搜索与只读仓库工具",
				items: [
					this.toggleDef("defaultWebSearch", "新对话默认开启联网搜索", "新对话初值；对话窗口可随时切换。"),
					this.toggleDef("defaultToolMode", "新对话默认开启工具调用", "新对话初值；对话窗口可随时切换。"),
					this.numberDef(
						"toolReadMaxChars",
						"读取范围（字符上限）",
						"内置工具单次读取上限（read_note / get_active_note，1000–200000 字符）。",
						1000,
						200000,
						1000
					),
				],
			},
			{
				type: "page",
				name: "提示词",
				desc: "个性化、数学 / 化学 / 绘图增强",
				items: [
					this.toggleDef("personalizeEnabled", "个性化", "总开关关闭后不注入任何风格 / 排版提示词。"),
					this.choiceDef("tone", "基本风格和语调", TONE_CHOICES),
					this.choiceDef("warmth", "亲切程度", WARMTH_CHOICES),
					this.choiceDef("enthusiasm", "热情程度", ENTHUSIASM_CHOICES),
					this.choiceDef("emojiLevel", "表情符号", EMOJI_CHOICES),
					this.choiceDef("layoutStyle", "布局和视觉元素", LAYOUT_CHOICES),
					this.toggleDef("syntaxMathJax", "数学增强（MathJax）", "注入 $…$ / $$…$$ 数学语法要求。"),
					this.toggleDef("syntaxMhchem", "化学增强（mhchem）", "注入 \\ce{} 化学语法要求。"),
					this.toggleDef("syntaxChem", "化学增强（smiles 代码块）", "注入 ```smiles 代码块要求，需 Chem 插件渲染。"),
					{
						name: "绘图增强",
						desc: "只注入已勾选类型的提示词；是否启用由工具栏「绘图」按键控制。",
						aliases: ["charts", "mermaid", "chart", "图表"],
					},
				],
			},
			{
				type: "page",
				name: "高级",
				desc: "Obsidian 语法修正与键盘发送规则",
				items: [
					this.toggleDef("syntaxTableSpacing", "表格前后留空", "渲染前修正表格前后空行。"),
					this.toggleDef("syntaxHighlight", "==高亮== 归一化", "渲染前统一 ==高亮== 语法。"),
					{
						name: "发送键方案",
						desc: "Enter 发送 / Shift+Enter 换行，或相反；Ctrl/Cmd+Enter 始终发送。",
						aliases: ["keyboard", "enter to send"],
					},
				],
			},
		];
	}

	private toggleDef(key: keyof OVOSettings, name: string, desc: string): SettingDefinitionItem {
		return { name, desc, control: { type: "toggle", key } };
	}

	private dropdownDef(
		key: keyof OVOSettings,
		name: string,
		desc: string,
		options: Record<string, string>
	): SettingDefinitionItem {
		return { name, desc, control: { type: "dropdown", key, options } };
	}

	private textareaDef(key: keyof OVOSettings, name: string, desc: string): SettingDefinitionItem {
		return { name, desc, control: { type: "textarea", key } };
	}

	private numberDef(
		key: keyof OVOSettings,
		name: string,
		desc: string,
		min?: number,
		max?: number,
		step?: number
	): SettingDefinitionItem {
		return { name, desc, control: { type: "number", key, min, max, step } };
	}

	private sliderDef(
		key: keyof OVOSettings,
		name: string,
		desc: string,
		min: number,
		max: number,
		step: number
	): SettingDefinitionItem {
		return { name, desc, control: { type: "slider", key, min, max, step } };
	}

	private choiceDef<T extends string>(
		key: keyof OVOSettings,
		name: string,
		choices: OVOChoice<T>[]
	): SettingDefinitionItem {
		const options: Record<string, string> = {};
		for (const c of choices) options[c.id] = c.name;
		return { name, desc: choices[0]?.desc ?? "", control: { type: "dropdown", key, options } };
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
		const s = this.plugin.settings;

		new Setting(el)
			.setName("API 密钥")
			.setDesc(
				"从 Obsidian 内置密钥库选择或新建；密钥值由 Obsidian 管理，不写入插件配置。" +
					"密钥库与当前库绑定，移动端需各自配置。"
			)
			.addComponent((c) =>
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

		new Setting(el)
			.setName("测试连接")
			.setDesc("验证密钥与网络，并刷新模型列表。")
			.addButton((b) =>
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
		const list = el.createDiv("ovo-toolbar-config");
		s.toolbarButtons.forEach((btn, idx) => {
			const meta = toolbarButtonMeta(btn.id);
			const setting = new Setting(list).setName(meta?.label ?? btn.id).setDesc(meta?.desc ?? "");
			if (meta?.icon) {
				const icon = setting.nameEl.createSpan("ovo-toolbar-config-icon");
				setIcon(icon, meta.icon);
			}
			setting.addToggle((t) =>
				t.setValue(btn.visible).onChange(async (v) => {
					btn.visible = v;
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
						this.renderSettings();
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
						this.renderSettings();
					})
			);
		});
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
