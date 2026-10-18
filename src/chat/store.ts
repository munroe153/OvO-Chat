/**
 * 会话存储（问答树模型，全部数据位于插件数据目录，不占用库内文件夹）：
 * - sessions/<id>.json：每会话一个「问→答映射」树文件，机器源，用于「继续对话」
 * - sessions.json：轻量索引 [{id,title,createdAt,updatedAt,tags}]（v3），历史列表免读会话全量
 * - attachments/<sessionId>/：附件（图片 / 文本原文），经 adapter 直读写
 *
 * 这些文件位于 .obsidian/plugins/ovo-chat/，Vault 索引不包含插件目录，
 * 因此统一使用 DataAdapter，而不是 Vault 的文件 API。
 *
 * Author: munroe153
 */

import { normalizePath, type DataAdapter } from "obsidian";
import type { ChatTurn, OVOAttachment, OVOMessage, OVOSession } from "../types";
import { genId, normalizeSessionRefs, walkTurns } from "../types";
import type { OVOChatPlugin } from "../main";
import { parseDataUrl } from "../util";

const INDEX_FILE = "sessions.json";
const SESSIONS_DIR = "sessions";

/** 历史记录页使用的最小元信息（只读轻量索引，不读取会话全文） */
export interface OVOSessionMeta {
	id: string;
	title: string;
	/** 创建时间（旧索引缺失时回落 updatedAt） */
	createdAt: number;
	updatedAt: number;
	/** 自定义标签（旧索引缺失时为空数组） */
	tags: string[];
}

interface SessionIndex {
	version: 3;
	sessions: OVOSessionMeta[];
}

/** 单个标签最大长度 / 单会话最多标签数（防手编与异常输入） */
const MAX_TAG_CHARS = 40;
const MAX_TAGS = 20;

/** 标签归一化：仅保留非空字符串、去重、限长限量（不改动顺序） */
export function normalizeTags(tags: unknown): string[] {
	if (!Array.isArray(tags)) return [];
	const out: string[] = [];
	const seen = new Set<string>();
	for (const raw of tags) {
		if (typeof raw !== "string") continue;
		const t = raw.trim().slice(0, MAX_TAG_CHARS);
		if (!t || seen.has(t)) continue;
		seen.add(t);
		out.push(t);
		if (out.length >= MAX_TAGS) break;
	}
	return out;
}

function metaFromSession(s: OVOSession): OVOSessionMeta {
	return {
		id: s.id,
		title: s.title || "新对话",
		createdAt: typeof s.createdAt === "number" ? s.createdAt : s.updatedAt,
		updatedAt: s.updatedAt,
		tags: normalizeTags(s.tags),
	};
}

/** 旧索引条目归一化（v2 无 createdAt / tags） */
function normalizeMeta(e: Partial<OVOSessionMeta> & { id?: unknown }): OVOSessionMeta | null {
	if (!e || typeof e.id !== "string" || !e.id) return null;
	const updatedAt = typeof e.updatedAt === "number" && Number.isFinite(e.updatedAt) ? e.updatedAt : Date.now();
	return {
		id: e.id,
		title: typeof e.title === "string" && e.title.trim() ? e.title : "新对话",
		createdAt: typeof e.createdAt === "number" && Number.isFinite(e.createdAt) ? e.createdAt : updatedAt,
		updatedAt,
		tags: normalizeTags(e.tags),
	};
}

/* ---------------- 会话瘦身（树遍历） ---------------- */

/**
 * 消息瘦身：剥离「可从库内回读」附件的正文（dataUrl/text），只留 vaultPath 引用。
 * 磁盘不驻留 base64 / 附件全文，正文按需经 hydrateAttachments 回读；
 * 无 vaultPath 的附件（保存失败兜底）保留原文，避免数据丢失。只生成副本。
 */
function slimMessage(m: OVOMessage): OVOMessage {
	if (!m.attachments?.length) return m;
	let dirty = false;
	const attachments = m.attachments.map((a) => {
		if (a.vaultPath && (a.dataUrl != null || a.text != null)) {
			dirty = true;
			return { ...a, dataUrl: undefined, text: undefined };
		}
		return a;
	});
	return dirty ? { ...m, attachments } : m;
}

function slimTurn(t: ChatTurn): ChatTurn {
	const question = slimMessage(t.question);
	const answers = t.answers.map(slimMessage);
	const children = t.children.map(slimTurn);
	if (
		question === t.question &&
		!answers.some((a, i) => a !== t.answers[i]) &&
		!children.some((c, i) => c !== t.children[i])
	) {
		return t;
	}
	return { ...t, question, answers, children };
}

/** 会话瘦身（写盘统一调用；活跃会话在内存中仍持有附件正文） */
function slimSession(s: OVOSession): OVOSession {
	const turns = s.turns.map(slimTurn);
	return turns.some((t, i) => t !== s.turns[i]) ? { ...s, turns } : s;
}

export class SessionStore {
	/** 索引内存缓存：首次读盘后持有，写操作同步更新（外部手编索引会被覆盖，已知代价） */
	private indexCache: OVOSessionMeta[] | null = null;
	/** 已打开会话的内存缓存（含回读的附件正文，切换会话免重复读盘） */
	private loaded = new Map<string, OVOSession>();

	constructor(private plugin: OVOChatPlugin) {}

	/* ---------------- 基础目录 ---------------- */

	get pluginDir(): string {
		const dir = this.plugin.manifest.dir;
		return dir ?? normalizePath(`${this.plugin.app.vault.configDir}/plugins/${this.plugin.manifest.id}`);
	}

	get indexPath(): string {
		return normalizePath(`${this.pluginDir}/${INDEX_FILE}`);
	}

	get sessionsDir(): string {
		return normalizePath(`${this.pluginDir}/${SESSIONS_DIR}`);
	}

	private sessionPath(id: string): string {
		return normalizePath(`${this.pluginDir}/${SESSIONS_DIR}/${id}.json`);
	}

	/** 附件根目录（插件数据目录内，随插件数据一并管理与删除） */
	get attachmentsRoot(): string {
		return normalizePath(`${this.pluginDir}/attachments`);
	}

	async ensureDirs(): Promise<void> {
		await this.ensureFolder(this.pluginDir);
		await this.ensureFolder(this.sessionsDir);
		await this.ensureFolder(this.attachmentsRoot);
	}

	/** 逐级创建文件夹（经 adapter 直建，插件目录内的文件夹不走库索引） */
	private async ensureFolder(path: string): Promise<void> {
		const adapter = this.plugin.app.vault.adapter;
		const parts = path.split("/").filter(Boolean);
		let cur = "";
		for (const p of parts) {
			cur = cur ? `${cur}/${p}` : p;
			if (!(await adapter.exists(cur))) {
				try {
					await adapter.mkdir(cur);
				} catch {
					// 已存在或并发创建，忽略
				}
			}
		}
	}

	/* ---------------- 索引与会话读写 ---------------- */

	/** 历史列表（轻量索引，按更新时间倒序） */
	async listSessions(): Promise<OVOSessionMeta[]> {
		if (!this.indexCache) {
			try {
				if (await this.plugin.app.vault.adapter.exists(this.indexPath)) {
					const raw = await this.plugin.app.vault.adapter.read(this.indexPath);
					const idx = JSON.parse(raw) as SessionIndex;
					this.indexCache = (idx.sessions ?? [])
						.map((e) => normalizeMeta(e))
						.filter((e): e is OVOSessionMeta => !!e)
						.sort((a, b) => b.updatedAt - a.updatedAt);
				} else {
					this.indexCache = [];
				}
			} catch (e) {
				console.error("[OvO] 读取会话索引失败", e);
				this.indexCache = [];
			}
		}
		return this.indexCache;
	}

	private async persistIndex(): Promise<void> {
		const idx: SessionIndex = { version: 3, sessions: this.indexCache ?? [] };
		await this.plugin.app.vault.adapter.write(this.indexPath, JSON.stringify(idx));
	}

	/** 读取一个会话（内存缓存 → 磁盘；读盘后钳制全部索引引用） */
	async getSession(id: string): Promise<OVOSession | null> {
		const cached = this.loaded.get(id);
		if (cached) return cached;
		try {
			const path = this.sessionPath(id);
			if (!(await this.plugin.app.vault.adapter.exists(path))) return null;
			const raw = await this.plugin.app.vault.adapter.read(path);
			const session = JSON.parse(raw) as OVOSession;
			if (!session || !Array.isArray(session.turns)) return null;
			normalizeSessionRefs(session);
			// 旧会话文件没有 tags / createdAt：读盘时归一化（不要求用户迁移）
			if (typeof session.updatedAt !== "number") session.updatedAt = Date.now();
			if (typeof session.createdAt !== "number") session.createdAt = session.updatedAt;
			if (typeof session.title !== "string" || !session.title.trim()) session.title = "新对话";
			session.tags = normalizeTags(session.tags);
			this.loaded.set(id, session);
			return session;
		} catch (e) {
			console.error("[OvO] 读取会话失败", id, e);
			return null;
		}
	}

	newSession(): OVOSession {
		return {
			id: genId("s"),
			title: "新对话",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			tags: [],
			turns: [],
			activeTurn: 0,
		};
	}

	/** 写会话文件（瘦身副本）——不触碰时间戳与索引 */
	private async writeSessionFile(session: OVOSession): Promise<void> {
		await this.plugin.app.vault.adapter.write(
			this.sessionPath(session.id),
			JSON.stringify(slimSession(session))
		);
	}

	/** 保存会话：写会话文件（瘦身副本）+ 更新索引条目（对话活动，刷新 updatedAt） */
	async saveSession(session: OVOSession): Promise<void> {
		session.updatedAt = Date.now();
		session.tags = normalizeTags(session.tags);
		this.loaded.set(session.id, session);
		await this.writeSessionFile(session);
		const entries = await this.listSessions();
		const entry = metaFromSession(session);
		const i = entries.findIndex((e) => e.id === session.id);
		if (i >= 0) entries[i] = entry;
		else entries.unshift(entry);
		entries.sort((a, b) => b.updatedAt - a.updatedAt);
		await this.persistIndex();
		// 历史记录页若已打开，同步刷新（读的是内存索引，代价很低）
		this.plugin.refreshHistoryViews();
	}

	/**
	 * 更新会话元信息（标题 / 标签）：只改索引与文件，**不刷新 updatedAt**
	 * （重命名 / 打标签不是对话活动，不能改变历史页「修改时间」的排序）。
	 * 会话文件缺失时仍更新索引并返回 true，避免历史页数据不可管理。
	 */
	async updateSessionMeta(id: string, patch: { title?: string; tags?: string[] }): Promise<boolean> {
		const entries = await this.listSessions();
		const entry = entries.find((e) => e.id === id);
		if (!entry) return false;
		if (patch.title !== undefined) {
			const title = patch.title.trim().slice(0, 80);
			entry.title = title || "新对话";
		}
		if (patch.tags !== undefined) entry.tags = normalizeTags(patch.tags);
		await this.persistIndex();
		const session = await this.getSession(id);
		if (session) {
			if (patch.title !== undefined) session.title = entry.title;
			if (patch.tags !== undefined) session.tags = entry.tags.slice();
			await this.writeSessionFile(session);
		}
		return true;
	}

	/** 批量删除会话：索引只写一次，再逐个清理会话文件 / 附件目录 / 内存缓存 */
	async deleteSessions(ids: string[]): Promise<void> {
		const set = new Set(ids.filter(Boolean));
		if (!set.size) return;
		const entries = await this.listSessions();
		this.indexCache = entries.filter((e) => !set.has(e.id)); // filter 产生新数组，需同步缓存
		await this.persistIndex();
		const adapter = this.plugin.app.vault.adapter;
		for (const id of set) {
			try {
				const path = this.sessionPath(id);
				if (await adapter.exists(path)) await adapter.remove(path);
			} catch {
				/* ignore */
			}
			const dir = normalizePath(`${this.attachmentsRoot}/${id}`);
			try {
				if (await adapter.exists(dir)) await adapter.rmdir(dir, true);
			} catch {
				/* ignore */
			}
			this.loaded.delete(id);
		}
	}

	/** 删除单个会话（`deleteSessions` 的便捷入口） */
	async deleteSession(id: string): Promise<void> {
		await this.deleteSessions([id]);
	}

	/* ---------------- 附件持久化 ---------------- */

	async persistAttachments(sessionId: string, attachments: OVOAttachment[]): Promise<OVOAttachment[]> {
		if (!attachments.length) return attachments;
		const adapter = this.plugin.app.vault.adapter;
		const dir = normalizePath(`${this.attachmentsRoot}/${sessionId}`);
		await this.ensureFolder(dir);
		const out: OVOAttachment[] = [];
		let n = 0;
		for (const a of attachments) {
			if (a.vaultPath) {
				out.push(a);
				continue;
			}
			n++;
			const safeName = sanitizeFileName(a.name) || `file-${n}`;
			const path = await uniquePath(dir, safeName, adapter);
			try {
				if (a.kind === "image" && a.dataUrl) {
					const buf = dataUrlToArrayBuffer(a.dataUrl);
					await adapter.writeBinary(path, buf);
				} else if (a.kind === "text") {
					await adapter.write(path, a.text ?? "");
				}
				out.push({ ...a, vaultPath: path });
			} catch (e) {
				console.error("[OvO] 附件保存失败", e);
				out.push(a);
			}
		}
		return out;
	}

	/**
	 * 从插件数据目录回读附件正文到对象（image→dataUrl / text→text）；已带正文或缺路径时跳过。
	 * 返回是否补上了内容；回读失败静默（渲染时降级为占位，不抛异常）。
	 */
	private async readAttachmentBody(a: OVOAttachment): Promise<boolean> {
		if (!a.vaultPath || a.dataUrl || a.text) return false;
		const adapter = this.plugin.app.vault.adapter;
		try {
			if (!(await adapter.exists(a.vaultPath))) return false;
			if (a.kind === "image") {
				const buf = await adapter.readBinary(a.vaultPath);
				a.dataUrl = `data:${a.mime || "image/png"};base64,${arrayBufferToBase64(buf)}`;
			} else {
				a.text = await adapter.read(a.vaultPath);
			}
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * 按需回读会话中缺失的附件正文（全树遍历，含未激活分支；索引持久化已剥离正文）。
	 * 返回是否有内容被补齐（调用方据此决定是否需要重渲染）。
	 */
	async hydrateAttachments(session: OVOSession): Promise<boolean> {
		let changed = false;
		for (const turn of walkTurns(session.turns)) {
			for (const m of [turn.question, ...turn.answers]) {
				for (const a of m.attachments ?? []) {
					if (await this.readAttachmentBody(a)) changed = true;
				}
			}
		}
		return changed;
	}

}

/* ---------------- 工具函数 ---------------- */

function sanitizeFileName(name: string): string {
	return name
		.replace(/[\\/:*?"<>|#^[\]]/g, "_")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 80);
}

/** 生成不与现有文件冲突的路径（插件数据目录内，经 adapter 检查；名称已 sanitize） */
async function uniquePath(dir: string, name: string, adapter: DataAdapter): Promise<string> {
	const dot = name.lastIndexOf(".");
	const stem = dot > 0 ? name.slice(0, dot) : name;
	const ext = dot > 0 ? name.slice(dot) : "";
	let path = normalizePath(`${dir}/${name}`);
	let i = 1;
	while (await adapter.exists(path)) {
		path = normalizePath(`${dir}/${stem}-${i}${ext}`);
		i++;
	}
	return path;
}

function dataUrlToArrayBuffer(dataUrl: string): ArrayBuffer {
	const bin = atob(parseDataUrl(dataUrl).data);
	const buf = new ArrayBuffer(bin.length);
	const view = new Uint8Array(buf);
	for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i);
	return buf;
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
	// Obsidian 环境提供 arrayBufferToBase64；此处独立实现避免依赖
	const bytes = new Uint8Array(buf);
	let bin = "";
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(bin);
}
