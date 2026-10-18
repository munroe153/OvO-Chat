/**
 * OVO 内置工具组 — 只读工具实现
 *
 * 共 4 个：search_notes / read_note / list_notes / get_active_note。
 * 全部只读（不写库）、只使用 Obsidian 跨平台核心 API（vault / workspace），
 * 因此在移动端与桌面端行为一致；不依赖 Node 或 Electron。
 *
 * Author: munroe153
 */

import { normalizePath, TFile, type App } from "obsidian";
import type { OVOBuiltinTool, OVOToolResult } from "./types";
import { errMsg } from "../util";

/* ---------------- 上限（防止大库卡顿与工具回传撑爆上下文） ---------------- */

/** search_notes 单次最多扫描的笔记数 */
const MAX_SEARCH_FILES = 800;
/** search_notes 默认返回条数 / 硬上限 */
const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 50;
/** search_notes 单条片段字符数 */
const MAX_SNIPPET = 200;
/** search_notes 输出总字符数 */
const MAX_SEARCH_OUTPUT = 8000;
/** read_note / get_active_note 正文上限：默认值与可调范围（设置「工具」分页「读取范围」） */
const DEFAULT_NOTE_MAX_CHARS = 20000;
const MIN_NOTE_MAX_CHARS = 1000;
const MAX_NOTE_MAX_CHARS = 200000;

/** 读取范围归一化：非法值回落默认，越界夹到 [MIN, MAX] */
function normalizeReadMax(n: number): number {
	if (!Number.isFinite(n) || n <= 0) return DEFAULT_NOTE_MAX_CHARS;
	return Math.min(Math.max(Math.trunc(n), MIN_NOTE_MAX_CHARS), MAX_NOTE_MAX_CHARS);
}
/** list_notes 默认条数 / 硬上限 */
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;

/* ---------------- 小工具函数 ---------------- */

function ok(text: string): OVOToolResult {
	return { ok: true, text };
}

function fail(text: string): OVOToolResult {
	return { ok: false, text };
}

/** 截断并标注 */
function clip(text: string, max: number, note = "truncated"): string {
	return text.length > max ? `${text.slice(0, max)}\n…(${note}; original length: ${text.length} characters)` : text;
}

function asString(args: Record<string, unknown>, key: string): string {
	const v = args?.[key];
	if (typeof v === "string") return v;
	if (v == null) return "";
	if (typeof v === "number" || typeof v === "boolean") return String(v);
	return JSON.stringify(v) ?? "";
}

function asInt(args: Record<string, unknown>, key: string, def: number, min: number, max: number): number {
	const raw = args?.[key];
	const n = typeof raw === "number" ? raw : typeof raw === "string" ? parseInt(raw, 10) : NaN;
	if (!Number.isFinite(n)) return def;
	return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** 文件夹过滤：库内相对路径前缀匹配 */
function inFolder(path: string, folder: string): boolean {
	if (!folder) return true;
	const f = folder.replace(/^\.?\/+|\/+$/g, "");
	if (!f) return true;
	return path === f || path.startsWith(`${f}/`);
}

/**
 * 检索匹配器：按空白拆词，全部词都命中（大小写不敏感）才算匹配。
 * 自实现而不用 fuzzy 检索：对中英文子串都能按字面命中，行为可预期。
 */
function makeMatcher(query: string): (line: string) => boolean {
	const terms = query
		.toLowerCase()
		.split(/\s+/)
		.filter(Boolean);
	if (!terms.length) return () => false;
	return (line: string) => {
		const lower = line.toLowerCase();
		return terms.every((t) => lower.includes(t));
	};
}

/* ---------------- 工具实现 ---------------- */

export function createBuiltinTools(app: App, getReadMaxChars: () => number): OVOBuiltinTool[] {
	/** 读取一篇笔记（供 read_note / get_active_note 共用；上限随设置「读取范围」动态取值） */
	const readNote = async (file: TFile): Promise<OVOToolResult> => {
		try {
			const content = await app.vault.cachedRead(file);
			const header = `# ${file.path} (${content.length} characters)`;
			return ok(clip(`${header}\n\n${content}`, normalizeReadMax(getReadMaxChars())));
		} catch (e) {
			return fail(`Failed to read "${file.path}": ${errMsg(e)}`);
		}
	};

	return [
		{
			name: "search_notes",
			label: "全库检索",
			description:
				"Search Markdown notes in the Obsidian vault and return matching note paths, line numbers, and context snippets. " +
				"When multiple keywords are separated by spaces, all must match. Use `folder` to limit to a subfolder and `limit` to cap the number of results.",
			parameters: {
				type: "object",
				properties: {
					query: { type: "string", description: "Search keywords (separate multiple terms with spaces; all must match)" },
					folder: { type: "string", description: "Optional. Limit the search to a folder (vault-relative path)" },
					limit: { type: "number", description: `Optional. Maximum number of results; default ${DEFAULT_SEARCH_LIMIT}` },
				},
				required: ["query"],
			},
			execute: async (args) => {
				const query = asString(args, "query").trim();
				if (!query) return fail('Parameter "query" must not be empty');
				const folder = asString(args, "folder").trim();
				const limit = asInt(args, "limit", DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT);

				const files = app.vault.getMarkdownFiles().filter((f) => inFolder(f.path, folder));
				if (!files.length) {
					return fail(`No Markdown notes found in the vault${folder ? ` under "${folder}"` : ""}`);
				}

				const match = makeMatcher(query);
				const lines: string[] = [];
				let scanned = 0;
				let hits = 0;
				let clipped = false;

				for (const file of files) {
					if (hits >= limit) break;
					if (scanned >= MAX_SEARCH_FILES) {
						clipped = true;
						break;
					}
					scanned++;
					let content = "";
					try {
						content = await app.vault.cachedRead(file);
					} catch {
						continue;
					}
					const rows = content.split(/\r?\n/);
					for (let i = 0; i < rows.length; i++) {
						if (hits >= limit) break;
						if (!match(rows[i])) continue;
						hits++;
						lines.push(`${file.path}:${i + 1} · ${clip(rows[i].trim(), MAX_SNIPPET, "line truncated")}`);
					}
				}

				if (!lines.length) return ok(`No notes matched "${query}" (scanned ${scanned} notes).`);

				const head = `Found ${hits} matches for "${query}"${hits >= limit ? ` (showing first ${limit})` : ""}:`;
				const body = clip(lines.join("\n"), MAX_SEARCH_OUTPUT, "results truncated");
				const tail = clipped
					? `\n\n(Only the first ${MAX_SEARCH_FILES} notes were scanned. Narrow the folder scope and try again.)`
					: "";
				return ok(`${head}\n${body}${tail}`);
			},
		},

		{
			name: "read_note",
			label: "读取笔记",
			description:
				"Read the full content of a Markdown note by its vault-relative path (long content is truncated). " +
				"Use list_notes to browse paths or search_notes to find them.",
			parameters: {
				type: "object",
				properties: {
					path: { type: "string", description: "Vault-relative path, e.g. folder/note.md" },
				},
				required: ["path"],
			},
			execute: async (args) => {
				const raw = asString(args, "path").trim();
				if (!raw) return fail('Parameter "path" must not be empty');
				const path = normalizePath(raw);
				const file = app.vault.getAbstractFileByPath(path);
				if (!file) {
					return fail(`Note "${path}" not found. Use list_notes to browse paths or search_notes to search content.`);
				}
				if (!(file instanceof TFile)) {
					return fail(`"${path}" is a folder, not a note file.`);
				}
				return readNote(file);
			},
		},

		{
			name: "list_notes",
			label: "列出笔记",
			description: "List the vault-relative paths of Markdown notes. Use `folder` to limit to a subfolder.",
			parameters: {
				type: "object",
				properties: {
					folder: { type: "string", description: "Optional. Limit to a folder (vault-relative path)" },
					limit: { type: "number", description: `Optional. Maximum number of results; default ${DEFAULT_LIST_LIMIT}` },
				},
			},
			execute: async (args) => {
				const folder = asString(args, "folder").trim();
				const limit = asInt(args, "limit", DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT);
				const files = app.vault
					.getMarkdownFiles()
					.filter((f) => inFolder(f.path, folder))
					.sort((a, b) => a.path.localeCompare(b.path));
				if (!files.length) {
					return fail(`No Markdown notes found in the vault${folder ? ` under "${folder}"` : ""}`);
				}
				const shown = files.slice(0, limit).map((f) => f.path);
				const head = `${files.length} notes${folder ? ` (limited to "${folder}")` : ""}; showing ${shown.length}:`;
				const tail =
					files.length > shown.length
						? `\n\n(${files.length - shown.length} more not listed; narrow the scope with folder.)`
						: "";
				return ok(`${head}\n${shown.join("\n")}${tail}`);
			},
		},

		{
			name: "get_active_note",
			label: "读取当前笔记",
			description: "Read the note currently open (active) in Obsidian, returning its path and full content.",
			parameters: { type: "object", properties: {} },
			execute: async () => {
				const file = app.workspace.getActiveFile();
				if (!file) return fail("No note is currently open (the active note is empty).");
				if (!(file instanceof TFile)) return fail("The active item is not a note file.");
				return readNote(file);
			},
		},
	];
}
