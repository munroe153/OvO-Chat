/**
 * OVO 对话窗口工具栏 —— 按键定义与配置归一化
 *
 * 每个按键由设置「界面」分页控制是否显示与排列顺序；此处集中维护按键的
 * 中文名、说明与图标，视图按设置顺序渲染，设置页据此生成配置清单。
 *
 * Author: munroe153
 */

import type { OVOToolbarButton, OVOToolbarButtonId } from "./types";

interface OVOToolbarButtonMeta {
	id: OVOToolbarButtonId;
	/** 设置页展示名 */
	label: string;
	/** 设置页说明 */
	desc: string;
	/** lucide 图标名 */
	icon: string;
}

/** 全部可用按键（顺序即默认排列顺序） */
const TOOLBAR_BUTTONS: OVOToolbarButtonMeta[] = [
	{ id: "model", label: "模型选择", desc: "切换当前对话使用的模型。", icon: "cpu" },
	{ id: "effort", label: "思考强度", desc: "调节思考强度。", icon: "brain" },
	{ id: "webSearch", label: "联网", desc: "官方服务端联网搜索。", icon: "globe" },
	{ id: "toolMode", label: "工具", desc: "把内置只读工具交给模型。", icon: "wrench" },
	{ id: "drawing", label: "绘图", desc: "注入图表语法提示词。", icon: "pie-chart" },
	{ id: "personalize", label: "个性化", desc: "个性化提示词总开关。", icon: "smile" },
	{ id: "attach", label: "附件", desc: "上传图片 / 文本附件。", icon: "paperclip" },
	{ id: "note", label: "当前笔记", desc: "附加当前活动笔记。", icon: "file-text" },
];

const META_INDEX = new Map(TOOLBAR_BUTTONS.map((b) => [b.id, b]));

export function toolbarButtonMeta(id: OVOToolbarButtonId): OVOToolbarButtonMeta | undefined {
	return META_INDEX.get(id);
}

/** 默认全部显示（顺序即 TOOLBAR_BUTTONS 顺序） */
export function defaultToolbarButtons(): OVOToolbarButton[] {
	return TOOLBAR_BUTTONS.map((b) => ({ id: b.id, visible: true }));
}

/**
 * 归一化已保存的工具栏配置：
 * - 丢弃未知 id 与重复项；
 * - 保留用户顺序与显示状态；
 * - 新增按键（旧版本配置中没有的）追加到末尾并默认显示。
 */
export function normalizeToolbarButtons(saved?: OVOToolbarButton[] | null): OVOToolbarButton[] {
	const out: OVOToolbarButton[] = [];
	const seen = new Set<string>();
	if (Array.isArray(saved)) {
		for (const b of saved) {
			const id = (b as { id?: unknown })?.id as OVOToolbarButtonId;
			if (!id || !META_INDEX.has(id) || seen.has(id)) continue;
			seen.add(id);
			out.push({ id, visible: (b as { visible?: unknown }).visible !== false });
		}
	}
	for (const m of TOOLBAR_BUTTONS) {
		if (!seen.has(m.id)) out.push({ id: m.id, visible: true });
	}
	return out;
}
