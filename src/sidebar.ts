/**
 * OvO Chat 侧边栏对话树视图（显示名 "OvO"）
 *
 * - 仅在对话标签页激活时显示当前会话的问答树；否则居中提示「请打开OvO对话窗口」
 * - VSCode Git 树风格：从上往下生长，层级引导线连接父子节点
 * - 每个节点 = 问句摘要 + 多答案徽标（×N）；激活路径整链高亮，游标节点加粗
 * - 点击节点 → 主视图 jumpToTurn(turnId)：切换激活路径并滚动到对应问句
 *
 * Author: munroe153
 */

import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import type { OVOChatPlugin } from "./main";
import type { ChatTurn } from "./types";
import { OVOChatView, CHAT_VIEW_TYPE } from "./view";

export const TREE_VIEW_TYPE = "ovo-chat-tree";

export class OVOChatTreeView extends ItemView {
	/** 最近激活的对话视图（点击树自身时保持内容显示） */
	private lastChatView: OVOChatView | null = null;

	constructor(leaf: WorkspaceLeaf, private plugin: OVOChatPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return TREE_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "OvO";
	}

	getIcon(): string {
		return "git-branch";
	}

	async onOpen(): Promise<void> {
		this.contentEl.addClass("ovo-tree-view");
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.refresh()));
		this.refresh();
	}

	async onClose(): Promise<void> {
		/* 事件随视图注销，无需额外清理 */
	}

	/** 当前应展示的对话视图：直接激活的，或最近激活的（侧边栏树自身成为活动视图时保持内容） */
	private currentChatView(): OVOChatView | null {
		const active = this.app.workspace.getActiveViewOfType(OVOChatView);
		if (active) {
			this.lastChatView = active;
			return active;
		}
		if (this.app.workspace.getActiveViewOfType(OVOChatTreeView) === this && this.lastChatView) {
			// 对话标签页仍打开时保持显示（点击树节点不会让树内容消失）
			const stillOpen = this.app.workspace
				.getLeavesOfType(CHAT_VIEW_TYPE)
				.some((l) => l.view === this.lastChatView);
			if (stillOpen) return this.lastChatView;
		}
		return null;
	}

	/** 重新渲染：激活态判定 + 会话问答树 */
	refresh(): void {
		const root = this.contentEl;
		root.empty();
		const chat = this.currentChatView();
		if (!chat) {
			root.createDiv("ovo-tree-hint").setText("请先打开对话窗口");
			return;
		}
		const session = chat.session;

		// 会话标题
		const head = root.createDiv("ovo-tree-head");
		const icon = head.createSpan("ovo-tree-head-icon");
		setIcon(icon, "git-branch");
		head.createSpan({ cls: "ovo-tree-head-title", text: session.title || "新对话" });

		if (!session.turns.length) {
			root.createDiv("ovo-tree-hint").setText("当前对话为空\n发送消息后在此查看问答分支树");
			return;
		}

		const pathIds = chat.turnPathIds();
		const activeIds = new Set(pathIds);
		const currentId = pathIds[pathIds.length - 1];
		const list = root.createDiv("ovo-tree-list");
		for (const turn of session.turns) {
			this.renderTurnNode(list, turn, activeIds, currentId);
		}
		// 滚动到当前节点（激活路径末端）
		const cur = root.querySelector<HTMLElement>(".ovo-tree-node.is-current");
		cur?.scrollIntoView({ block: "nearest" });
	}

	/** 递归渲染一个节点及其子分支（VSCode Git 树：缩进 + 引导线） */
	private renderTurnNode(parentEl: HTMLElement, turn: ChatTurn, activeIds: Set<string>, currentId?: string): void {
		const row = parentEl.createDiv("ovo-tree-node");
		if (activeIds.has(turn.id)) row.addClass("is-active");
		if (turn.id === currentId) row.addClass("is-current");
		row.setAttribute("aria-label", turn.question.content);
		const label = row.createSpan("ovo-tree-label");
		label.setText(turnSummary(turn.question.content));
		if (turn.answers.length > 1) {
			row.createSpan({ cls: "ovo-tree-badge", text: `×${turn.answers.length}` });
		}
		row.addEventListener("click", () => {
			// 点击树节点时树可能已是活动视图：经 currentChatView 取回主对话视图
			this.currentChatView()?.jumpToTurn(turn.id);
		});
		if (turn.children.length) {
			const kids = parentEl.createDiv("ovo-tree-children");
			for (const child of turn.children) this.renderTurnNode(kids, child, activeIds, currentId);
		}
	}
}

/** 问句摘要：压缩空白 + 宽松截断（实际显示行数由 CSS 限制为最多三行） */
function turnSummary(text: string): string {
	const one = text.replace(/\s+/g, " ").trim();
	if (!one) return "（无文本内容）";
	return one.length > 200 ? one.slice(0, 200) + "…" : one;
}
