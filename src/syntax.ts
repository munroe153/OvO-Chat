/**
 * OvO Chat 语法增强 —— 数学 / 化学语法提示词 + Obsidian 语法渲染前修正
 *
 * 设置「语法增强」分页的三个提示词开关（默认关闭）在每轮对话注入系统消息：
 * - MathJax：引导模型用 $…$ / $$…$$ 书写数学公式（Obsidian 原生渲染）；
 * - mhchem：引导模型用 \ce{} 书写化学方程式（Obsidian 内置 mhchem 扩展）；
 * - Chem：引导模型用 ```smiles 代码块输出分子结构（需安装 Chem 插件，id: chem）。
 *
 * 两个「Obsidian 语法修正」开关（默认开启）在渲染前对助手消息副本做非破坏性修正，
 * 不写入会话文件、不改变聊天记录原文：
 * - 表格前后留空：紧贴上下文的表格自动补空行；
 * - ==高亮==：全角 ＝＝ / 三重等号归一为 ==，并去掉标记内侧空格。
 *
 * Author: munroe153
 */

import type { App } from "obsidian";
import type { OVOSettings } from "./types";

/** Chem 插件 id（SMILES 渲染代码块语言为 smiles，每行一条） */
const CHEM_PLUGIN_ID = "chem";

/* ---------------- 提示词片段 ---------------- */

const MATHJAX_PROMPT =
	"[Math] Write all mathematical formulas using MathJax (LaTeX) syntax: inline formulas with $…$, and display formulas on their own line with $$…$$. " +
	"Do not use \\(…\\) or \\[…\\] delimiters, and do not spell formulas with Unicode superscript/subscript characters (e.g., x², H₂O).";

const MHCHEM_PROMPT =
	"[Chemical equations] Write chemical formulas and equations using mhchem's \\ce{} syntax inside math delimiters: " +
	"inline as $\\ce{2H2 + O2 -> 2H2O}$, and display as $$\\ce{...}$$ on its own line. " +
	"Do not spell chemical formulas as plain text outside \\ce{}, and do not use Unicode subscripts.";

const SMILES_PROMPT =
	"[Molecular structures] When showing a molecular structure, put SMILES strings in a standalone ```smiles code block, one SMILES per line. " +
	"Explain what the molecule is in one sentence outside the code block; do not draw structures with ASCII art or describe them in plain prose.";

/**
 * 组装语法增强提示词（系统消息注入用）。
 * 三个开关全部关闭时返回空串（调用方自行过滤）。
 */
export function buildSyntaxPrompt(s: OVOSettings): string {
	const parts: string[] = [];
	if (s.syntaxMathJax) parts.push(MATHJAX_PROMPT);
	if (s.syntaxMhchem) parts.push(MHCHEM_PROMPT);
	if (s.syntaxChem) parts.push(SMILES_PROMPT);
	return parts.join("\n");
}

/** 是否已安装并启用 Chem 插件（用于设置页的安装提示） */
export function isChemEnabled(app: App): boolean {
	const plugins = (app as unknown as { plugins?: { enabledPlugins?: Set<string> } }).plugins;
	return !!plugins?.enabledPlugins?.has(CHEM_PLUGIN_ID);
}

/* ---------------- 设置页清单 ---------------- */

export interface OVOSyntaxItem {
	/** 对应 OVOSettings 中的布尔键 */
	key: "syntaxMathJax" | "syntaxMhchem" | "syntaxChem" | "syntaxTableSpacing" | "syntaxHighlight";
	/** 设置页展示名 */
	name: string;
	/** 设置页说明 */
	desc: string;
}

export interface OVOSyntaxGroup {
	/** 分组标题 */
	name: string;
	/** lucide 图标名 */
	icon: string;
	items: OVOSyntaxItem[];
}

/** 设置页分组（顺序即展示顺序） */
export const SYNTAX_GROUPS: OVOSyntaxGroup[] = [
	{
		name: "数学增强",
		icon: "sigma",
		items: [
			{
				key: "syntaxMathJax",
				name: "MathJax",
				desc: "用 $…$ / $$…$$ 输出公式，Obsidian 原生渲染。",
			},
		],
	},
	{
		name: "化学增强",
		icon: "flask-conical",
		items: [
			{
				key: "syntaxMhchem",
				name: "mhchem（化学方程式渲染）",
				desc: "用 \\ce{} 输出化学式与方程式，Obsidian 内置渲染。",
			},
			{
				key: "syntaxChem",
				name: "Chem 插件（SMILES 渲染）",
				desc: "用 ```smiles 输出分子结构（一行一条），需 Chem 插件。",
			},
		],
	},
	{
		name: "Obsidian 语法修正",
		icon: "wand-2",
		items: [
			{
				key: "syntaxTableSpacing",
				name: "表格前后留空",
				desc: "渲染前自动补空行，不修改原文。",
			},
			{
				key: "syntaxHighlight",
				name: "==高亮==",
				desc: "归一化 == 标记，不修改原文。",
			},
		],
	},
];

/* ---------------- 渲染前修正 ---------------- */

/** 行内受保护片段：行内代码 / 行内公式（这些区域内不做任何修正） */
const INLINE_PROTECT_RE = /(`[^`]*`|\$[^$\n]*\$|\\\([^)]*\\\)|\\\[[^\]]*\\\])/g;

/** 表格分隔行（| --- | :---: 等），要求含 | 且每格至少 3 个连字符（降低误判） */
function isTableDelimiter(line: string): boolean {
	if (!line.includes("|")) return false;
	return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line);
}

/** 表格数据行：含 | 且非空行 */
function isTableRow(line: string): boolean {
	return line.includes("|") && line.trim().length > 0;
}

/**
 * 单行高亮归一化：
 * - 全角 ＝＝（成对出现时）转半角 ==；=== 收敛为 ==；
 * - 标记数量不成对或存在长等号串（如分隔线）时保守放弃；
 * - 成对时去掉 == 内侧的空格 / 制表符（不影响标记外侧的空格）。
 */
function fixHighlightLine(line: string): string {
	if (/={4,}|＝{4,}/.test(line)) return line; // 长等号串（分隔线等）不处理
	const fullWidth = line.match(/＝{2,3}/g)?.length ?? 0;
	if (fullWidth > 0 && fullWidth % 2 !== 0) return line; // 全角等号须成对才转换
	let s = line.replace(/＝{2,3}/g, "==").replace(/={3}/g, "==");
	const marks = s.match(/==/g)?.length ?? 0;
	if (marks < 2 || marks % 2 !== 0) return s; // 未成对：不继续处理，避免误伤
	s = s.replace(/==([^=\n]+?)==/g, (m, inner: string) => {
		const t = inner.trim();
		return t ? `==${t}==` : m;
	});
	return s;
}

/** 内容行修正：保护行内代码 / 行内公式后再做高亮归一化（反引号不成对时整行不处理） */
function fixContentLine(line: string): string {
	if (((line.match(/`/g) ?? []).length & 1) === 1) return line;
	const parts = line.split(INLINE_PROTECT_RE);
	for (let i = 0; i < parts.length; i += 2) {
		parts[i] = fixHighlightLine(parts[i]);
	}
	return parts.join("");
}

/**
 * 表格前后留空：识别「表头 + 分隔行」起始的表格块，在块前 / 块后各补一个空行。
 * 仅处理顶格（不缩进）且在代码块 / 块级公式之外的表格，避免破坏缩进代码块与列表层级。
 */
function applyTableSpacing(lines: string[], protect: boolean[]): string[] {
	const out: string[] = [];
	let i = 0;
	while (i < lines.length) {
		if (
			!protect[i] &&
			/^\S/.test(lines[i]) &&
			isTableRow(lines[i]) &&
			i + 1 < lines.length &&
			!protect[i + 1] &&
			/^\S/.test(lines[i + 1]) &&
			isTableDelimiter(lines[i + 1])
		) {
			if (out.length && out[out.length - 1].trim() !== "") out.push("");
			out.push(lines[i], lines[i + 1]);
			i += 2;
			while (i < lines.length && !protect[i] && isTableRow(lines[i])) {
				out.push(lines[i]);
				i++;
			}
			if (i < lines.length && lines[i].trim() !== "") out.push("");
			continue;
		}
		out.push(lines[i]);
		i++;
	}
	return out;
}

/**
 * 渲染前修正助手消息（纯函数、幂等、异常安全）：
 * 围栏代码块、块级公式（$$…$$）整段跳过，行内代码 / 行内公式在行内跳过；
 * 两个开关均关闭时原样返回。修正只作用于渲染副本，绝不写回会话数据。
 */
export function correctAssistantMarkdown(md: string, s: OVOSettings): string {
	if (!s.syntaxTableSpacing && !s.syntaxHighlight) return md;
	try {
		const raw = md.split("\n");
		const lines: string[] = new Array<string>(raw.length);
		/** 受保护行（围栏代码块 / 块级公式内）：不做任何修正 */
		const protect: boolean[] = new Array<boolean>(raw.length).fill(false);
		let fence: string | null = null;
		let mathBlock = false;
		for (let i = 0; i < raw.length; i++) {
			const line = raw[i];
			const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
			if (fence) {
				lines[i] = line;
				protect[i] = true;
				if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = null;
				continue;
			}
			if (fenceMatch) {
				fence = fenceMatch[1];
				lines[i] = line;
				protect[i] = true;
				continue;
			}
			const dollars = (line.match(/\$\$/g) ?? []).length;
			if (mathBlock) {
				lines[i] = line;
				protect[i] = true;
				if (dollars % 2 === 1) mathBlock = false;
				continue;
			}
			if (dollars % 2 === 1) {
				mathBlock = true;
				lines[i] = line;
				protect[i] = true;
				continue;
			}
			lines[i] = s.syntaxHighlight ? fixContentLine(line) : line;
		}
		const out = s.syntaxTableSpacing ? applyTableSpacing(lines, protect) : lines;
		return out.join("\n");
	} catch (e) {
		console.debug("[OvO] 渲染前语法修正失败，按原文渲染", e);
		return md;
	}
}
