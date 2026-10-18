/**
 * OvO Chat — 历史记录独立标签页
 *
 * 只读 sessions.json 轻量索引（id / title / createdAt / updatedAt / tags），不加载会话全文：
 * - 搜索：标题 + 标签（大小写不敏感）
 * - 筛选：标签多选（需全部匹配）+ 时间预设范围（按创建 / 修改时间）
 * - 排序：修改时间 / 创建时间 的升序与降序
 * - 管理：打开会话、弹窗编辑标签、弹窗重命名、删除与批量删除
 *
 * 修改元信息不刷新 updatedAt（见 SessionStore.updateSessionMeta），保证「修改时间」语义稳定。
 *
 * Author: munroe153
 */

import { ItemView, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type { OVOChatPlugin } from "./main";
import type { OVOSessionMeta } from "./chat/store";
import { ConfirmModal, TextInputModal } from "./modal";

export const HISTORY_VIEW_TYPE = "ovo-history-view";

type SortKey = "updatedDesc" | "updatedAsc" | "createdDesc" | "createdAsc";
type TimeField = "updatedAt" | "createdAt";
type TimeRange = "all" | "today" | "7d" | "30d";

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
	{ value: "updatedDesc", label: "修改时间：新 → 旧" },
	{ value: "updatedAsc", label: "修改时间：旧 → 新" },
	{ value: "createdDesc", label: "创建时间：新 → 旧" },
	{ value: "createdAsc", label: "创建时间：旧 → 新" },
];

const RANGE_OPTIONS: { value: TimeRange; label: string }[] = [
	{ value: "all", label: "全部时间" },
	{ value: "today", label: "今天" },
	{ value: "7d", label: "近 7 天" },
	{ value: "30d", label: "近 30 天" },
];

interface HistoryState {
	query: string;
	/** 已选标签（AND：会话需包含全部所选标签） */
	tags: string[];
	sort: SortKey;
	timeField: TimeField;
	range: TimeRange;
	/** 已勾选会话 id（批量删除） */
	selected: Set<string>;
}

export class OVOHistoryView extends ItemView {
	private entries: OVOSessionMeta[] = [];
	private allTags: string[] = [];
	private state: HistoryState = {
		query: "",
		tags: [],
		sort: "updatedDesc",
		timeField: "updatedAt",
		range: "all",
		selected: new Set(),
	};

	/** DOM 是否已构建完成（避免视图初始化竞态下直接刷新） */
	private ready = false;
	private countEl!: HTMLElement;
	private tagBarEl!: HTMLElement;
	private batchAllCheck!: HTMLInputElement;
	private batchInfoEl!: HTMLElement;
	private batchDeleteBtn!: HTMLButtonElement;
	private listEl!: HTMLElement;

	constructor(leaf: WorkspaceLeaf, private plugin: OVOChatPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return HISTORY_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "历史记录";
	}

	getIcon(): string {
		return "history";
	}

	async onOpen(): Promise<void> {
		this.contentEl.addClass("ovo-history-view");
		this.buildDom();
		this.ready = true;
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) => {
				if (leaf === this.leaf) void this.reload();
			})
		);
		await this.reload();
	}

	async onClose(): Promise<void> {
		/* 事件随视图注销，无需额外清理 */
	}

	/** 供插件在会话增删改后主动刷新（DOM 未就绪时跳过，onOpen 会自行加载） */
	refresh(): void {
		if (this.ready) void this.reload();
	}

	/* ================= DOM 构建 ================= */

	private buildDom(): void {
		const root = this.contentEl;
		root.empty();
		const wrap = root.createDiv("ovo-history");

		/* ---- 标题 ---- */
		const head = wrap.createDiv("ovo-history-head");
		const icon = head.createSpan("ovo-history-head-icon");
		setIcon(icon, "history");
		head.createSpan({ cls: "ovo-history-head-title", text: "历史记录" });
		this.countEl = head.createSpan("ovo-history-count");
		const refreshBtn = head.createEl("button", { cls: "ovo-icon-btn clickable-icon" });
		refreshBtn.setAttribute("aria-label", "刷新");
		setIcon(refreshBtn, "refresh-cw");
		refreshBtn.addEventListener("click", () => void this.reload());

		/* ---- 搜索 / 排序 ---- */
		const toolbar = wrap.createDiv("ovo-history-toolbar");
		const search = toolbar.createEl("input", {
			type: "search",
			cls: "ovo-history-search",
			attr: { placeholder: "搜索标题或标签…" },
		});
		search.addEventListener("input", () => {
			this.state.query = search.value;
			this.renderList();
		});
		const sortSel = toolbar.createEl("select", { cls: "ovo-select ovo-history-sort" });
		sortSel.setAttribute("aria-label", "排序");
		for (const o of SORT_OPTIONS) sortSel.createEl("option", { value: o.value, text: o.label });
		sortSel.value = this.state.sort;
		sortSel.addEventListener("change", () => {
			this.state.sort = sortSel.value as SortKey;
			this.renderList();
		});

		/* ---- 时间筛选 ---- */
		const filters = wrap.createDiv("ovo-history-filters");
		const fieldSel = filters.createEl("select", { cls: "ovo-select" });
		fieldSel.setAttribute("aria-label", "时间依据");
		fieldSel.createEl("option", { value: "updatedAt", text: "按修改时间" });
		fieldSel.createEl("option", { value: "createdAt", text: "按创建时间" });
		fieldSel.value = this.state.timeField;
		fieldSel.addEventListener("change", () => {
			this.state.timeField = fieldSel.value as TimeField;
			this.renderList();
		});
		const rangeSel = filters.createEl("select", { cls: "ovo-select" });
		rangeSel.setAttribute("aria-label", "时间范围");
		for (const o of RANGE_OPTIONS) rangeSel.createEl("option", { value: o.value, text: o.label });
		rangeSel.value = this.state.range;
		rangeSel.addEventListener("change", () => {
			this.state.range = rangeSel.value as TimeRange;
			this.renderList();
		});

		/* ---- 标签筛选 ---- */
		this.tagBarEl = wrap.createDiv("ovo-history-tags");

		/* ---- 批量操作条 ---- */
		const batch = wrap.createDiv("ovo-history-batch");
		const allLabel = batch.createEl("label");
		this.batchAllCheck = allLabel.createEl("input", { type: "checkbox" });
		allLabel.createSpan({ text: "全选当前结果" });
		this.batchAllCheck.addEventListener("change", () => {
			const list = this.filtered();
			for (const e of list) {
				if (this.batchAllCheck.checked) this.state.selected.add(e.id);
				else this.state.selected.delete(e.id);
			}
			this.renderList();
		});
		this.batchInfoEl = batch.createSpan({ cls: "ovo-history-batch-info" });
		this.batchDeleteBtn = batch.createEl("button", { cls: "mod-warning", text: "删除所选" });
		this.batchDeleteBtn.addEventListener("click", () => this.confirmDelete([...this.state.selected]));
		const clearBtn = batch.createEl("button", { text: "取消选择" });
		clearBtn.addEventListener("click", () => {
			this.state.selected.clear();
			this.renderList();
		});

		/* ---- 列表 ---- */
		this.listEl = wrap.createDiv("ovo-history-list");
	}

	/* ================= 数据与渲染 ================= */

	private async reload(): Promise<void> {
		this.entries = await this.plugin.store.listSessions();
		const alive = new Set(this.entries.map((e) => e.id));
		for (const id of [...this.state.selected]) {
			if (!alive.has(id)) this.state.selected.delete(id);
		}
		this.allTags = Array.from(new Set(this.entries.flatMap((e) => e.tags))).sort((a, b) =>
			a.localeCompare(b, "zh")
		);
		// 已不存在的标签从筛选条件中移除
		this.state.tags = this.state.tags.filter((t) => this.allTags.includes(t));
		this.countEl.setText(`共 ${this.entries.length} 条`);
		this.renderTagBar();
		this.renderList();
	}

	/** 时间范围起点（本地自然日）；全部时间返回 null */
	private rangeStart(): number | null {
		if (this.state.range === "all") return null;
		const d = new Date();
		d.setHours(0, 0, 0, 0);
		const days = this.state.range === "today" ? 0 : this.state.range === "7d" ? 6 : 29;
		d.setDate(d.getDate() - days);
		return d.getTime();
	}

	/** 过滤 + 排序后的列表（只操作索引，不读会话全文） */
	private filtered(): OVOSessionMeta[] {
		const q = this.state.query.trim().toLowerCase();
		const cutoff = this.rangeStart();
		const tags = this.state.tags;
		const field = this.state.timeField;
		const list = this.entries.filter((e) => {
			if (q && !(e.title.toLowerCase().includes(q) || e.tags.some((t) => t.toLowerCase().includes(q)))) {
				return false;
			}
			if (tags.length && !tags.every((t) => e.tags.includes(t))) return false;
			if (cutoff != null && e[field] < cutoff) return false;
			return true;
		});
		const sorters: Record<SortKey, (a: OVOSessionMeta, b: OVOSessionMeta) => number> = {
			updatedDesc: (a, b) => b.updatedAt - a.updatedAt,
			updatedAsc: (a, b) => a.updatedAt - b.updatedAt,
			createdDesc: (a, b) => b.createdAt - a.createdAt,
			createdAsc: (a, b) => a.createdAt - b.createdAt,
		};
		return list.sort(sorters[this.state.sort]);
	}

	private renderTagBar(): void {
		this.tagBarEl.empty();
		if (!this.allTags.length) {
			this.tagBarEl.hide();
			return;
		}
		this.tagBarEl.show();
		this.tagBarEl.createSpan({ cls: "ovo-history-tags-label", text: "标签：" });
		for (const tag of this.allTags) {
			const chip = this.tagBarEl.createEl("button", { cls: "ovo-history-tag-chip", text: tag });
			chip.toggleClass("is-active", this.state.tags.includes(tag));
			chip.addEventListener("click", () => {
				this.state.tags = this.state.tags.includes(tag)
					? this.state.tags.filter((t) => t !== tag)
					: [...this.state.tags, tag];
				this.renderTagBar();
				this.renderList();
			});
		}
		if (this.state.tags.length) {
			const clear = this.tagBarEl.createEl("button", { cls: "ovo-history-tag-clear", text: "清除标签筛选" });
			clear.addEventListener("click", () => {
				this.state.tags = [];
				this.renderTagBar();
				this.renderList();
			});
		}
	}

	private renderList(): void {
		const list = this.filtered();
		this.countEl.setText(
			list.length === this.entries.length ? `共 ${this.entries.length} 条` : `共 ${this.entries.length} 条 · 当前 ${list.length} 条`
		);
		this.listEl.empty();

		if (!this.entries.length) {
			this.listEl.createDiv("ovo-history-empty").setText(
				"暂无历史记录\n在对话窗口发送第一条消息后，这里会显示全部对话"
			);
			this.renderBatchBar(list);
			return;
		}
		if (!list.length) {
			this.listEl.createDiv("ovo-history-empty").setText(
				"没有匹配的历史记录\n试试更换关键词、切换时间范围或清除标签筛选"
			);
			this.renderBatchBar(list);
			return;
		}

		for (const entry of list) this.listEl.appendChild(this.renderRow(entry));
		this.renderBatchBar(list);
	}

	private renderBatchBar(list: OVOSessionMeta[] = this.filtered()): void {
		const selected = this.state.selected;
		this.batchInfoEl.setText(`已选 ${selected.size} 项`);
		this.batchDeleteBtn.disabled = selected.size === 0;
		const allSelected = list.length > 0 && list.every((e) => selected.has(e.id));
		this.batchAllCheck.checked = allSelected;
		this.batchAllCheck.indeterminate = !allSelected && list.some((e) => selected.has(e.id));
	}

	private renderRow(entry: OVOSessionMeta): HTMLElement {
		const row = this.listEl.createDiv("ovo-history-item");
		row.toggleClass("is-selected", this.state.selected.has(entry.id));

		const check = row.createEl("input", { type: "checkbox", cls: "ovo-history-check" });
		check.checked = this.state.selected.has(entry.id);
		check.setAttribute("aria-label", `选择「${entry.title}」`);
		check.addEventListener("click", (e) => e.stopPropagation());
		check.addEventListener("change", () => {
			if (check.checked) this.state.selected.add(entry.id);
			else this.state.selected.delete(entry.id);
			row.toggleClass("is-selected", check.checked);
			this.renderBatchBar();
		});

		const main = row.createDiv("ovo-history-item-main");
		const title = main.createDiv("ovo-history-item-title");
		title.setText(entry.title || "新对话");
		title.setAttribute("title", entry.title || "新对话");
		main.createDiv("ovo-history-item-meta").setText(
			`创建 ${formatTime(entry.createdAt)} · 修改 ${formatTime(entry.updatedAt)}`
		);
		const tags = main.createDiv("ovo-history-item-tags");
		if (entry.tags.length) {
			for (const tag of entry.tags) tags.createSpan({ cls: "ovo-history-tag", text: tag });
		} else {
			tags.createSpan({ cls: "ovo-history-tag is-empty", text: "无标签" });
		}
		main.addEventListener("click", (e) => {
			if ((e.target as HTMLElement | null)?.closest("input, button")) return;
			void this.openSession(entry.id);
		});

		const actions = row.createDiv("ovo-history-item-actions");
		this.mkAction(actions, "tag", "编辑标签", () => this.editTags(entry));
		this.mkAction(actions, "pencil", "重命名", () => this.rename(entry));
		this.mkAction(actions, "trash-2", "删除", () => this.confirmDelete([entry.id]));
		return row;
	}

	private mkAction(parent: HTMLElement, icon: string, tooltip: string, cb: () => void): HTMLButtonElement {
		const btn = parent.createEl("button", { cls: "ovo-icon-btn clickable-icon" });
		btn.setAttribute("aria-label", tooltip);
		setIcon(btn, icon);
		btn.addEventListener("click", (e) => {
			e.stopPropagation();
			cb();
		});
		return btn;
	}

	/* ================= 操作 ================= */

	/** 打开会话：先激活对话标签页，再切入对应会话 */
	private async openSession(id: string): Promise<void> {
		const chat = await this.plugin.activateView();
		if (!chat) {
			new Notice("无法打开对话窗口");
			return;
		}
		await chat.openSession(id);
	}

	private editTags(entry: OVOSessionMeta): void {
		new TextInputModal(this.app, {
			title: "编辑标签",
			desc: "多个标签用逗号分隔（支持中文逗号）；留空表示清除全部标签。单标签最多 24 字符，最多 20 个。",
			initial: entry.tags.join(", "),
			placeholder: "例如：工作, 读书笔记",
			maxLength: 600,
			required: false,
			onSubmit: async (value) => {
				const tags = parseTags(value);
				const ok = await this.plugin.store.updateSessionMeta(entry.id, { tags });
				if (!ok) {
					new Notice("会话不存在或已被删除");
					await this.reload();
					return;
				}
				await this.reload();
			},
		}).open();
	}

	private rename(entry: OVOSessionMeta): void {
		new TextInputModal(this.app, {
			title: "重命名对话",
			initial: entry.title || "",
			placeholder: "会话标题",
			maxLength: 80,
			submitText: "保存",
			onSubmit: async (value) => {
				const title = value.trim().slice(0, 80) || "新对话";
				const ok = await this.plugin.store.updateSessionMeta(entry.id, { title });
				if (!ok) {
					new Notice("会话不存在或已被删除");
					await this.reload();
					return;
				}
				// 已打开的对话视图 / 侧边栏树同步标题
				this.plugin.notifySessionMetaChanged(entry.id);
				await this.reload();
			},
		}).open();
	}

	private confirmDelete(ids: string[]): void {
		if (!ids.length) return;
		const one = ids.length === 1 ? this.entries.find((e) => e.id === ids[0]) : undefined;
		const label = one ? `「${one.title}」` : `选中的 ${ids.length} 个对话`;
		new ConfirmModal(
			this.app,
			`确定删除${label}及其全部数据（会话文件 / 附件）？此操作不可撤销。`,
			async () => {
				await this.plugin.store.deleteSessions(ids);
				for (const id of ids) this.state.selected.delete(id);
				this.plugin.handleSessionsDeleted(ids);
				await this.reload();
			}
		).open();
	}
}

/* ---------------- 工具函数 ---------------- */

/** 标签输入解析：英文 / 中文逗号分隔，去空白、去重、单标签限 24 字符、最多 20 个 */
function parseTags(raw: string): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const part of raw.split(/[,，]/)) {
		const tag = part.trim().slice(0, 24);
		if (!tag || seen.has(tag)) continue;
		seen.add(tag);
		out.push(tag);
		if (out.length >= 20) break;
	}
	return out;
}

/** 时间展示：同年显示月-日 时:分，跨年显示完整日期 */
function formatTime(ts: number): string {
	if (!Number.isFinite(ts)) return "—";
	const d = new Date(ts);
	const now = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	const day = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
	if (d.getFullYear() !== now.getFullYear()) return `${d.getFullYear()}-${day}`;
	return `${day} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
