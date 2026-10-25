/**
 * OvO Chat 绘图提示词 —— Charts 图表 + Mermaid 图表语法指引
 *
 * 对话窗口「绘图」按键开启后，把本模块的提示词注入系统消息：
 * - 统计数值类 → ```chart 代码块（YAML 配置），由图库中安装的 Charts 插件渲染；
 * - 结构 / 流程 / 关系类 → ```mermaid 代码块，由 Obsidian 原生渲染（无需安装插件）。
 * 用户可在设置「绘图」分页分组勾选需要的图表类型，启用时只注入勾选类型的提示词。
 *
 * Charts 语法依据 v3.9.0 的代码块处理器（`chart` / `advanced-chart`）与其内部
 * 数据预处理逻辑，支持的顶层键：
 *   type, labels, series[{title,data,...}], width, height, legend, legendPosition,
 *   beginAtZero, stacked, indexAxis, spanGaps, fill, tension, labelColors,
 *   transparency, xTitle/yTitle, xMin/xMax/xReverse/xDisplay/xTickDisplay/xTickPadding,
 *   yMin/yMax/yReverse/yDisplay/yTickDisplay/yTickPadding, rMin/rMax, padding, time
 *
 * Mermaid 仅提供稳定成熟的 6 种类型（流程图 / 时序图 / 甘特图 / 时间线 / 思维导图 / 看板）。
 *
 * Author: munroe153
 */

import type { App } from "obsidian";

/** Charts 插件 id（用于检测是否已安装并启用） */
const CHARTS_PLUGIN_ID = "obsidian-charts";

export interface OVODrawingType {
	id: string;
	/** 设置页展示名 */
	name: string;
	/** 设置页说明 */
	desc: string;
	/** 注入模型的提示词片段 */
	prompt: string;
}

/* ---------------- Charts 图表（```chart · YAML） ---------------- */

/** Charts 通用结构提示词（勾选任一 Charts 类型时注入） */
const CHART_BASE_PROMPT =
	"[Charts — common structure] Put the chart configuration in a standalone ```chart code block. The block must be **YAML** (no JSON, no explanatory prose):\n" +
	"type (chart type) + labels (array of category labels) + series (array of data series, each with title and data). " +
	"`data` must be an array of numbers with the same length as `labels`; add more items under `series` for multiple data sets.\n" +
	"Common style keys: width (e.g., 80%), height, legend (true/false), legendPosition (top/bottom/left/right), " +
	"xTitle / yTitle, beginAtZero, stacked, spanGaps, labelColors.";

/** Charts 图表类型（勾选后才会注入对应提示词） */
export const CHART_TYPES: OVODrawingType[] = [
	{
		id: "bar",
		name: "柱状图 / 条形图",
		desc: "分类数值对比；可做分组、堆叠与横向条形图。",
		prompt:
			"[Bar chart] type: bar. Best for comparing numeric values across categories; add indexAxis: y for a horizontal bar chart. " +
			"Add more items under series for side-by-side comparison; use beginAtZero: true when values start at zero; use stacked: true for stacked comparisons.\n" +
			"Example:\n" +
			"type: bar\nlabels: [Q1, Q2, Q3]\nseries:\n  - title: Sales\n    data: [120, 200, 150]\nbeginAtZero: true",
	},
	{
		id: "line",
		name: "折线图 / 面积图",
		desc: "随时间变化的趋势；可平滑、填充、多序列对比。",
		prompt:
			"[Line / area chart] type: line. Best for trends over time; use tension: 0.3 (0–1) for smooth curves, " +
			"fill: true to fill the area under the line, and spanGaps: true to connect across missing points. Add more items under series for multiple trends, each with its own title; " +
			"add xTitle / yTitle when the axes are ambiguous.\n" +
			"Example:\n" +
			"type: line\nlabels: [Jan, Feb, Mar]\nseries:\n  - title: Visits\n    data: [120, 200, 150]\ntension: 0.3\nfill: true",
	},
	{
		id: "pie",
		name: "饼图",
		desc: "占比构成；各扇区自动分配不同颜色。",
		prompt:
			"[Pie chart] type: pie. Best for part-to-whole composition; labels are the segment names and series should contain exactly one item (title may be empty), " +
			"whose data holds the segment values. You must set labelColors: true, otherwise all segments render in the same color.\n" +
			"Example:\n" +
			"type: pie\nlabels: [R&D, Marketing, Operations]\nseries:\n  - title: \"\"\n    data: [45, 30, 25]\nlabelColors: true",
	},
	{
		id: "doughnut",
		name: "环形图",
		desc: "中间留空的占比图，适合展示构成比例。",
		prompt:
			"[Doughnut chart] type: doughnut. A part-to-whole chart with a hollow center; same usage as the pie chart (labels + a single series item + labelColors: true).\n" +
			"Example:\n" +
			"type: doughnut\nlabels: [Done, In progress, Not started]\nseries:\n  - title: \"\"\n    data: [12, 5, 3]\nlabelColors: true",
	},
	{
		id: "radar",
		name: "雷达图",
		desc: "多维度评分 / 能力对比。",
		prompt:
			"[Radar chart] type: radar. Best for multi-dimensional scoring comparisons; labels are the dimension names and each series item is one comparison object (e.g., different options or people). " +
			"Fix the scale with rMin / rMax when needed, and usually add beginAtZero: true.\n" +
			"Example:\n" +
			"type: radar\nlabels: [Performance, Cost, Usability, Scalability]\nseries:\n  - title: Option A\n    data: [8, 5, 9, 7]\n  - title: Option B\n    data: [6, 8, 7, 6]\nrMin: 0\nrMax: 10",
	},
	{
		id: "polarArea",
		name: "极坐标面积图",
		desc: "扇区角度相同、半径不同的数量对比。",
		prompt:
			"[Polar area chart] type: polarArea. Best for comparing relative magnitudes across categories (equal sector angles, varying radii); " +
			"labels are the category names, series contains one item, and data holds the values. Set labelColors: true to give each sector a different color.\n" +
			"Example:\n" +
			"type: polarArea\nlabels: [Category A, Category B, Category C]\nseries:\n  - title: \"\"\n    data: [30, 20, 12]\nlabelColors: true",
	},
];

/* ---------------- Mermaid 图表（```mermaid · Obsidian 原生渲染） ---------------- */

/** Mermaid 通用说明（勾选任一 Mermaid 类型时注入） */
const MERMAID_BASE_PROMPT =
	"[Mermaid — common guidance] Put the diagram definition in a standalone ```mermaid code block. The block contains Mermaid syntax with the diagram type on the first line. " +
	"Quote node text that contains special characters (spaces, parentheses, colons, etc.). " +
	"Edge labels must have balanced quotes: write -->|\"label\"|, never -->|\"label|. Keep the structure concise and the number of nodes moderate.";

/** Mermaid 图表类型（仅稳定成熟的 6 种；beta 图表不提供） */
export const MERMAID_TYPES: OVODrawingType[] = [
	{
		id: "mermaid-flowchart",
		name: "流程图",
		desc: "flowchart：流程 / 判断分支 / 子流程。",
		prompt:
			"[Flowchart] flowchart. Direction: flowchart TD (top-down) / LR (left-right) / BT / RL. " +
			"Node shapes: id[rectangle], id(rounded), id{diamond decision}, id((circle)), id[(database)]. " +
			"Edges: A --> B (arrow), A --- B (no arrow), A -->|label| B (conditional text). Use subgraph name … end for sub-processes.\n" +
			"Example:\n```mermaid\nflowchart TD\n  A[Start] --> B{Check condition}\n  B -->|Yes| C[Do task]\n  B -->|No| D[End]\n```",
	},
	{
		id: "mermaid-sequence",
		name: "时序图",
		desc: "sequenceDiagram：参与者之间的消息往来与交互顺序。",
		prompt:
			"[Sequence diagram] sequenceDiagram. Participants: participant A as Name. " +
			"Messages: A->>B: text (solid arrow), A-->>B: text (dashed reply). " +
			"Use loop … end, alt … else … end, par … end for control flow; use activate / deactivate for activation periods.\n" +
			"Example:\n```mermaid\nsequenceDiagram\n  participant U as User\n  participant S as Server\n  U->>S: Send request\n  S-->>U: Return result\n```",
	},
	{
		id: "mermaid-gantt",
		name: "甘特图",
		desc: "gantt：项目排期与任务进度。",
		prompt:
			"[Gantt chart] gantt. Title: title. Date format: dateFormat YYYY-MM-DD. Sections: section Name. " +
			"Tasks: Task name : status, id, start date, duration (e.g., 5d) or start, end date; status tags done / active / crit; chain tasks with after id.\n" +
			"Note: dates must be real values; do not invent them.\n" +
			"Example:\n```mermaid\ngantt\n  title Project plan\n  dateFormat YYYY-MM-DD\n  section Phase 1\n  Research :done, a1, 2026-01-01, 5d\n  Implementation :active, a2, after a1, 10d\n```",
	},
	{
		id: "mermaid-timeline",
		name: "时间线",
		desc: "timeline：按时间段的里程碑事件。",
		prompt:
			"[Timeline] timeline. Title: title. One line per time period: period : event1 : event2 (colon-separated, multiple events allowed).\n" +
			"Example:\n```mermaid\ntimeline\n  title Development history\n  2024 : Kickoff\n  2025 : Private beta : Public beta\n  2026 : General availability\n```",
	},
	{
		id: "mermaid-mindmap",
		name: "思维导图",
		desc: "mindmap：中心主题向外的层级发散。",
		prompt:
			"[Mind map] mindmap. Root node: root((Central topic)). Indent child nodes level by level (two spaces per level). " +
			"Node text can be plain, or specify a shape with id[text] / (text) / ((text)).\n" +
			"Example:\n```mermaid\nmindmap\n  root((Product plan))\n    Features\n      Login\n      Search\n    Experience\n      Performance\n```",
	},
	{
		id: "mermaid-kanban",
		name: "看板",
		desc: "kanban：按列组织的任务状态板。",
		prompt:
			"[Kanban] kanban. Column names on their own line (2-space indent). Tasks under a column (4-space indent), formatted as [Task] or id[Task].\n" +
			"Example:\n```mermaid\nkanban\n  To do\n    [Design API]\n    [Write docs]\n  In progress\n    [Implement core]\n  Done\n    [Project kickoff]\n```",
	},
];

/* ---------------- 组装与归一化 ---------------- */

/** 全部图表类型 id（Charts + Mermaid，顺序即设置页展示顺序） */
export const DRAWING_TYPE_IDS: string[] = [...CHART_TYPES, ...MERMAID_TYPES].map((t) => t.id);

/** 0.0.4 及更早版本的 TikZ 绘图类型 id（用于配置迁移） */
const LEGACY_DRAWING_TYPE_IDS = new Set(["geometry", "function", "flowchart", "physics", "chart", "diagram"]);

/**
 * 归一化已勾选的绘图类型：
 * - 丢弃未知 id，保留用户勾选（含空集，表示不注入具体类型提示词）；
 * - 旧版本（TikZ 类型）配置全部为未知 id 时，回落为默认全选。
 */
export function normalizeDrawingTypes(ids?: string[]): string[] {
	if (!Array.isArray(ids)) return [...DRAWING_TYPE_IDS];
	const known = new Set(DRAWING_TYPE_IDS);
	const kept = ids.filter((id) => known.has(id));
	if (!kept.length && ids.some((id) => LEGACY_DRAWING_TYPE_IDS.has(id))) return [...DRAWING_TYPE_IDS];
	return kept;
}

/**
 * 组装绘图提示词：总纲 + 按勾选组注入通用结构说明 + 勾选类型的提示词片段。
 * 未勾选任何类型时只返回总纲，保证模型仍能输出基本图表。
 */
export function buildDrawingPrompt(enabledIds: string[]): string {
	const parts: string[] = [
		"[Drawing mode is on] When a diagram or chart is needed, put the configuration in a standalone code block and explain the chart's meaning in one or two sentences outside the block. " +
			"Numbers must come from the user's data or real data in the conversation—never invent them. If the data is insufficient, ask the user first.",
	];
	const chartsOn = CHART_TYPES.some((t) => enabledIds.includes(t.id));
	const mermaidOn = MERMAID_TYPES.some((t) => enabledIds.includes(t.id));
	if (chartsOn) parts.push(CHART_BASE_PROMPT);
	if (mermaidOn) parts.push(MERMAID_BASE_PROMPT);
	for (const t of CHART_TYPES) {
		if (enabledIds.includes(t.id)) parts.push(t.prompt);
	}
	for (const t of MERMAID_TYPES) {
		if (enabledIds.includes(t.id)) parts.push(t.prompt);
	}
	return parts.join("\n\n");
}

/** 是否已安装并启用 Charts 插件 */
export function isChartsEnabled(app: App): boolean {
	const plugins = (app as unknown as { plugins?: { enabledPlugins?: Set<string> } }).plugins;
	return !!plugins?.enabledPlugins?.has(CHARTS_PLUGIN_ID);
}
