/**
 * OvO Chat — Obsidian 插件入口
 * Author: munroe153
 *
 * 核心：DeepSeek 官方对话 + 一组内置只读工具；密钥由 Obsidian 内置密钥库托管。
 */

import { Plugin, WorkspaceLeaf } from "obsidian";
import { OVOSettingTab } from "./settings";
import { OVOChatView, CHAT_VIEW_TYPE } from "./view";
import { OVOChatTreeView, TREE_VIEW_TYPE } from "./sidebar";
import { OVOHistoryView, HISTORY_VIEW_TYPE } from "./history";
import { DeepSeekClient, FALLBACK_MODELS } from "./api/deepseek";
import { SessionStore } from "./chat/store";
import { readApiKey } from "./secret";
import { FocusTimer } from "./focus";
import { BuiltinToolRegistry } from "./tools/registry";
import { DEFAULT_SETTINGS, type OVOModelInfo, type OVOSettings } from "./types";
import { normalizeToolbarButtons } from "./toolbar";
import { normalizeDrawingTypes } from "./drawing";

export class OVOChatPlugin extends Plugin {
	settings!: OVOSettings;
	api!: DeepSeekClient;
	store!: SessionStore;
	/** 内置只读工具组 */
	tools!: BuiltinToolRegistry;
	/** 专注时间（命令注册 / 拦截守卫 / 持久化结束时间戳） */
	focus!: FocusTimer;

	/** 最近使用的会话 id（重开标签页时恢复） */
	lastSessionId: string | null = null;

	/** 模型列表缓存有效期（6 小时） */
	private readonly modelTtlMs = 6 * 3600_000;
	/** 进行中的模型列表拉取（并发去重） */
	private modelsInflight: Promise<OVOModelInfo[]> | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.api = new DeepSeekClient();
		this.store = new SessionStore(this);
		this.tools = new BuiltinToolRegistry(this.app, () => this.settings.toolReadMaxChars);

		await this.store.ensureDirs();

		this.focus = new FocusTimer(this);
		this.focus.registerCommand();

		this.registerView(CHAT_VIEW_TYPE, (leaf: WorkspaceLeaf) => new OVOChatView(leaf, this));
		this.registerView(TREE_VIEW_TYPE, (leaf: WorkspaceLeaf) => new OVOChatTreeView(leaf, this));
		this.registerView(HISTORY_VIEW_TYPE, (leaf: WorkspaceLeaf) => new OVOHistoryView(leaf, this));

		this.addRibbonIcon("message-circle", "打开对话窗口", () => {
			void this.activateView();
		});

		this.addCommand({
			id: "open-chat",
			name: "打开对话窗口",
			callback: () => void this.activateView(),
		});

		this.addCommand({
			id: "open-chat-tree",
			name: "打开对话树（侧边栏）",
			callback: () => void this.activateTreeView(),
		});

		this.addCommand({
			id: "new-chat",
			name: "新建对话",
			callback: async () => {
				const view = await this.activateView();
				await view?.newChat();
			},
		});

		this.addCommand({
			id: "open-history",
			name: "打开历史记录",
			callback: () => void this.activateHistoryView(),
		});

		this.addSettingTab(new OVOSettingTab(this.app, this));

		// 后台预热官方模型列表（失败静默，不影响插件加载）
		void this.getModels();
	}

	async loadSettings(): Promise<void> {
		const data = (await this.loadData()) as Partial<OVOSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data ?? {});
		// 归一化工具栏配置：补齐新增按键、丢弃未知项，保留用户顺序与显示状态
		this.settings.toolbarButtons = normalizeToolbarButtons(this.settings.toolbarButtons);
		// 归一化绘图类型勾选（旧配置缺失时回落默认全选）
		this.settings.enabledDrawingTypes = normalizeDrawingTypes(this.settings.enabledDrawingTypes);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/**
	 * 当前 DeepSeek API Key —— 全插件唯一取值出口。
	 * 密钥值取自 Obsidian 内置密钥库，未选择密钥或密钥不存在时返回空串。
	 */
	getApiKey(): string {
		return readApiKey(this.app, this.settings);
	}

	async activateView(): Promise<OVOChatView | null> {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(CHAT_VIEW_TYPE)[0] ?? null;
		if (!leaf) {
			// 在主工作区以新标签页打开，不覆盖当前笔记
			leaf = workspace.getLeaf(true);
			await leaf.setViewState({ type: CHAT_VIEW_TYPE, active: true });
		}
		await workspace.revealLeaf(leaf);
		return (leaf.view as OVOChatView) ?? null;
	}

	/** 在右侧边栏打开对话树视图 */
	async activateTreeView(): Promise<OVOChatTreeView | null> {
		const { workspace } = this.app;
		let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(TREE_VIEW_TYPE)[0] ?? null;
		if (!leaf) {
			leaf = workspace.getRightLeaf(false);
			if (!leaf) return null;
			await leaf.setViewState({ type: TREE_VIEW_TYPE, active: true });
		}
		await workspace.revealLeaf(leaf);
		return (leaf.view as OVOChatTreeView) ?? null;
	}

	/** 在主工作区以标签页打开历史记录（已打开则直接激活） */
	async activateHistoryView(): Promise<OVOHistoryView | null> {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(HISTORY_VIEW_TYPE)[0] ?? null;
		if (!leaf) {
			leaf = workspace.getLeaf(true);
			await leaf.setViewState({ type: HISTORY_VIEW_TYPE, active: true });
		}
		await workspace.revealLeaf(leaf);
		return (leaf.view as OVOHistoryView) ?? null;
	}

	/** 刷新已打开的历史记录页（会话增删改后调用） */
	refreshHistoryViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(HISTORY_VIEW_TYPE)) {
			if (leaf.view instanceof OVOHistoryView) leaf.view.refresh();
		}
	}

	/**
	 * 会话被删除后协调各视图：
	 * 正在展示被删会话的对话视图重置为新对话；最近会话指针同步清理。
	 */
	handleSessionsDeleted(ids: string[]): void {
		const set = new Set(ids);
		if (this.lastSessionId && set.has(this.lastSessionId)) this.lastSessionId = null;
		for (const leaf of this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)) {
			const view = leaf.view;
			if (view instanceof OVOChatView && set.has(view.session.id)) {
				void view.newChat();
			}
		}
		this.notifyTreeChanged();
		this.refreshHistoryViews();
	}

	/** 个性化总开关变更后同步全部对话视图的工具栏选中态 */
	notifyPersonalizeChanged(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)) {
			const view = leaf.view;
			if (view instanceof OVOChatView) view.syncPersonalizeChip();
		}
	}

	/** 会话标题等元信息变更后同步已打开的对话视图标题与侧边栏树 */
	notifySessionMetaChanged(id: string): void {
		for (const leaf of this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)) {
			const view = leaf.view;
			if (view instanceof OVOChatView) view.syncSessionMeta(id);
		}
		this.notifyTreeChanged();
	}

	/** 通知侧边栏对话树刷新（结构 / 激活路径变化时由主视图调用） */
	notifyTreeChanged(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(TREE_VIEW_TYPE)) {
			if (leaf.view instanceof OVOChatTreeView) leaf.view.refresh();
		}
	}

	/** 重渲已打开且未在生成中的对话视图（渲染相关设置变更后即时生效） */
	refreshChatViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)) {
			if (leaf.view instanceof OVOChatView && !leaf.view.isStreaming()) leaf.view.rerenderAll();
		}
	}

	/** 打开本插件设置页 */
	openSettings(): void {
		const setting = (this.app as unknown as { setting?: { open: () => void; openTabById: (id: string) => void } }).setting;
		setting?.open();
		setting?.openTabById(this.manifest.id);
	}

	/** 同步取模型列表：优先动态缓存，无缓存时回落到内置兜底列表（用于同步渲染下拉框） */
	getModelsSync(): OVOModelInfo[] {
		const cache = this.settings.modelCache;
		if (cache?.models?.length) return cache.models;
		return FALLBACK_MODELS;
	}

	/** 清除模型缓存（密钥变更后调用，下次拉取时强制刷新） */
	invalidateModels(): void {
		if (this.settings.modelCache) {
			this.settings.modelCache = null;
			void this.saveSettings();
		}
	}

	/**
	 * 按官方 API 动态拉取并缓存模型列表：
	 * - 命中缓存（未过期且非强制）直接返回；
	 * - 拉取失败 / 未配置密钥时回落到现有缓存或内置兜底列表，不抛异常。
	 */
	async getModels(force = false): Promise<OVOModelInfo[]> {
		const apiKey = this.getApiKey();
		if (!apiKey) return this.getModelsSync();
		const cache = this.settings.modelCache;
		if (!force && cache?.models?.length && Date.now() - cache.at < this.modelTtlMs) return cache.models;
		if (this.modelsInflight) return this.modelsInflight;
		this.modelsInflight = (async () => {
			try {
				const models = await this.api.listModels(apiKey);
				if (models.length) {
					this.settings.modelCache = { at: Date.now(), models };
					await this.saveSettings();
					return models;
				}
			} catch (e) {
				console.debug("[OvO] 拉取官方模型列表失败，使用缓存/兜底列表", e);
			} finally {
				this.modelsInflight = null;
			}
			return this.getModelsSync();
		})();
		return this.modelsInflight;
	}
}

export default OVOChatPlugin;
