/**
 * OvO Chat — Mermaid 安全渲染围栏
 *
 * 模型输出的 Mermaid 语法经常有小毛病（最常见：边标签只写起始引号，如 `-->|"低于30%|`），
 * Obsidian 原生渲染会直接抛出 `Error parsing Mermaid diagram!` 并显示一大段解析错误。
 * 本模块在 Markdown 渲染前做三件事，保证图表「能渲染就渲染，不能渲染就给源码」：
 *
 * 1. 修复：对可被 parse 验证通过的窄修复（边标签 / 节点标签的引号闭合）；
 * 2. 校验：用 Obsidian 公共 API `loadMermaid()` 取得同版本 mermaid 实例，parse 预校验；
 *    原串失败→修复串再试→仍失败则整块降级为「警告 + text 源码代码块」；
 * 3. 流式保护：流式输出期间半截图表不交给 Mermaid，按 text 代码块展示，结束后再正式渲染。
 *
 * 渲染完成后另有 `hasMermaidRenderError` 兜底（预校验没覆盖到的运行时错误 → 整段降级重渲）。
 * 所有处理只作用于渲染副本，绝不写回会话数据。
 *
 * Author: munroe153
 */

import { loadMermaid } from "obsidian";

/* ---------------- 围栏扫描 ---------------- */

const FENCE_OPEN_RE = /^(\s*)(`{3,}|~{3,})(.*)$/;

interface FenceBlock {
	/** 起始行索引 */
	start: number;
	/** 结束行索引（已闭合时为闭合围栏所在行；未闭合时等于行数，作为排他上界） */
	end: number;
	/** 是否正常闭合 */
	closed: boolean;
	/** 围栏字符（` 或 ~） */
	marker: string;
	/** 围栏长度（连续字符数） */
	length: number;
	/** 起始行缩进（保持列表层级） */
	indent: string;
	/** 信息串（已 trim） */
	info: string;
	/** 正文（不含首尾围栏行） */
	code: string;
}

/** 扫描全部围栏代码块（仅顶格或空格缩进；blockquote 内的围栏保持原生行为） */
function scanFences(md: string): FenceBlock[] {
	const lines = md.split("\n");
	const blocks: FenceBlock[] = [];
	let i = 0;
	while (i < lines.length) {
		const m = lines[i].match(FENCE_OPEN_RE);
		if (!m || (m[2][0] === "`" && m[3].includes("`"))) {
			i++;
			continue;
		}
		const marker = m[2][0];
		const length = m[2].length;
		const indent = m[1] ?? "";
		const info = (m[3] ?? "").trim();
		const closeRe = new RegExp(`^\\s*${marker === "`" ? "`" : "~"}{${length},}\\s*$`);
		let end = lines.length;
		let closed = false;
		for (let j = i + 1; j < lines.length; j++) {
			if (closeRe.test(lines[j])) {
				end = j;
				closed = true;
				break;
			}
		}
		blocks.push({
			start: i,
			end,
			closed,
			marker,
			length,
			indent,
			info,
			code: lines.slice(i + 1, end).join("\n"),
		});
		i = closed ? end + 1 : end;
	}
	return blocks;
}

/** 信息串首词是否为 mermaid（允许 ```mermaid title 形式） */
function isMermaidInfo(info: string): boolean {
	return (info.trim().split(/\s+/)[0] ?? "").toLowerCase() === "mermaid";
}

/** 快速判断是否包含 mermaid 围栏（避免纯文本消息也去加载 Mermaid） */
function mayContainMermaid(md: string): boolean {
	return /^\s*(?:`{3,}|~{3,})\s*mermaid\b/im.test(md);
}

/* ---------------- 窄修复 ---------------- */

/**
 * 边标签引号闭合：`-->|"低于30%|` → `-->|"低于30%"|`。
 * 只在「起始引号后、下一个 | 之前没有任何引号」时补一个闭合引号，
 * 已经是 `|"文本"|` 的标签保持原样。
 */
function fixEdgeLabelQuotes(line: string): string {
	let out = line;
	let search = 0;
	while (true) {
		const re = /\|\s*"/g;
		re.lastIndex = search;
		const open = re.exec(out);
		if (!open) break;
		const contentStart = open.index + open[0].length;
		const close = out.indexOf("|", contentStart);
		if (close < 0) break;
		const inner = out.slice(contentStart, close);
		if (inner.includes('"')) {
			search = close + 1;
			continue;
		}
		out = out.slice(0, close) + '"' + out.slice(close);
		search = close + 2;
	}
	return out;
}

/**
 * 节点标签引号闭合：`A["文本]` → `A["文本"]`（同样只补缺失的闭合引号）。
 * 支持 [] / () / {} 及其重复形式（如 ((圆形))）。
 */
function fixNodeLabelQuotes(line: string): string {
	return line.replace(/([[({]+)"([^"\n]*?)([\])}]+)/g, (_all, open: string, inner: string, close: string) => {
		return `${open}"${inner}"${close}`;
	});
}

/** 可被 Mermaid parse 验证通过的窄修复（幂等、异常安全） */
export function repairMermaidSource(code: string): string {
	try {
		return code
			.split("\n")
			.map((line) => fixNodeLabelQuotes(fixEdgeLabelQuotes(line)))
			.join("\n");
	} catch {
		return code;
	}
}

/* ---------------- 校验与缓存 ---------------- */

type MermaidVerdict = "ok" | "repaired" | "bad";

interface CachedVerdict {
	verdict: MermaidVerdict;
	/** verdict === "repaired" 时的修复结果 */
	fixed?: string;
}

const MAX_CACHE = 300;
const verdictCache = new Map<string, CachedVerdict>();
let mermaidPromise: Promise<unknown> | null = null;

/** 加载 Mermaid（缓存 Promise；任何失败都 fail-open 为 null，不阻断普通渲染） */
function getMermaid(): Promise<unknown> {
	if (!mermaidPromise) {
		try {
			mermaidPromise = Promise.resolve(loadMermaid()).catch((e) => {
				console.debug("[OvO] Mermaid 加载失败，图表按原生方式渲染", e);
				return null;
			});
		} catch (e) {
			console.debug("[OvO] Mermaid 加载失败，图表按原生方式渲染", e);
			mermaidPromise = Promise.resolve(null);
		}
	}
	return mermaidPromise ?? Promise.resolve(null);
}

/** parse 校验：Mermaid 不可用 / 无 parse 时视为通过（fail-open） */
async function parseOk(source: string): Promise<boolean> {
	const mermaid = (await getMermaid()) as { parse?: (text: string) => boolean | Promise<boolean> } | null;
	if (!mermaid || typeof mermaid.parse !== "function") return true;
	try {
		const r = await mermaid.parse(source);
		return r !== false;
	} catch {
		return false;
	}
}

function remember(source: string, verdict: CachedVerdict): void {
	if (verdictCache.size >= MAX_CACHE) {
		const first = verdictCache.keys().next().value;
		if (first !== undefined) verdictCache.delete(first);
	}
	verdictCache.set(source, verdict);
}

/** 判定一个代码块：原串可解析 → ok；修复后可解析 → repaired；都失败 → bad */
async function classify(source: string): Promise<CachedVerdict> {
	const cached = verdictCache.get(source);
	if (cached) return cached;
	if (await parseOk(source)) {
		const v: CachedVerdict = { verdict: "ok" };
		remember(source, v);
		return v;
	}
	const fixed = repairMermaidSource(source);
	if (fixed !== source && (await parseOk(fixed))) {
		const v: CachedVerdict = { verdict: "repaired", fixed };
		remember(source, v);
		return v;
	}
	const v: CachedVerdict = { verdict: "bad" };
	remember(source, v);
	return v;
}

/* ---------------- Markdown 变换 ---------------- */

/** 降级块：警告 + 源码 text 代码块（围栏长度按源码内最长反引号串加一，避免提前闭合） */
function fallbackBlock(code: string, indent: string): string {
	const src = code.replace(/\s+$/, "");
	const longest = (src.match(/`+/g) ?? []).reduce((max, s) => Math.max(max, s.length), 2);
	const fence = "`".repeat(Math.max(3, longest + 1));
	const body = src.split("\n").map((line) => `${indent}${line}`);
	return [
		`${indent}> ⚠️ **Mermaid 图表解析失败**：已尝试自动修复语法，仍无法渲染，以下为原始源码。`,
		"",
		`${indent}${fence}text`,
		...body,
		`${indent}${fence}`,
	].join("\n");
}

/**
 * 最终渲染前处理：校验每个 mermaid 围栏，修复可修复的，降级不可渲染的。
 * 不含 mermaid 围栏时原样返回（零开销快路径）。异常时原样返回，绝不阻断渲染。
 */
export async function prepareMermaidForRender(md: string): Promise<string> {
	if (!mayContainMermaid(md)) return md;
	try {
		const lines = md.split("\n");
		const blocks = scanFences(md).filter((b) => isMermaidInfo(b.info));
		if (!blocks.length) return md;
		// 从后往前替换，避免行号偏移
		for (let i = blocks.length - 1; i >= 0; i--) {
			const b = blocks[i];
			const verdict = await classify(b.code);
			if (verdict.verdict === "ok") continue;
			if (verdict.verdict === "repaired" && verdict.fixed != null) {
				lines.splice(b.start + 1, b.end - b.start - 1, ...verdict.fixed.split("\n"));
				continue;
			}
			const total = b.closed ? b.end - b.start + 1 : b.end - b.start;
			lines.splice(b.start, total, ...fallbackBlock(b.code, b.indent).split("\n"));
		}
		return lines.join("\n");
	} catch (e) {
		console.debug("[OvO] Mermaid 预校验失败，按原文渲染", e);
		return md;
	}
}

/**
 * 流式渲染保护：把 mermaid 围栏的信息串改成 text（半截图表按代码展示，
 * 避免每 140ms 一次解析报错），图表在最终渲染时再正式呈现。
 */
export function neutralizeMermaidFences(md: string): string {
	if (!mayContainMermaid(md)) return md;
	try {
		const lines = md.split("\n");
		for (const b of scanFences(md)) {
			if (!isMermaidInfo(b.info)) continue;
			lines[b.start] = `${b.indent}${b.marker.repeat(b.length)}text`;
		}
		return lines.join("\n");
	} catch {
		return md;
	}
}

/** 渲染结果中是否出现 Obsidian 原生 Mermaid 错误提示（兜底检测） */
export function hasMermaidRenderError(el: HTMLElement): boolean {
	const text = el.textContent ?? "";
	return text.includes("Error parsing Mermaid diagram") || text.includes("Parse error on line");
}
