/**
 * 上下文构建：历史窗口裁剪 + 请求消息格式化
 * Author: munroe153
 */

import type { OVOAttachment, OVOMessage, OVOSettings } from "../types";
import { parseDataUrl } from "../util";

/**
 * 粗略 token 估算：CJK 字符 ≈ 0.6 token/字，其余 ≈ 4 字符/token。
 * 仅用于上下文预算控制，不用于计费。
 */
export function estTokens(text: string): number {
	if (!text) return 0;
	const cjk = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff00-\uffef]/g) || []).length;
	return Math.ceil(cjk * 0.6 + (text.length - cjk) / 4);
}

function attachmentTokens(a: OVOAttachment): number {
	return estTokens(a.text ?? "") + estTokens(a.name ?? "");
}

function messageTokens(m: OVOMessage): number {
	return estTokens(m.content) + estTokens(m.reasoning ?? "") + (m.attachments ?? []).reduce((s, a) => s + attachmentTokens(a), 0);
}

/** 过滤错误消息后按设置裁剪上下文（保证至少携带最后一条） */
function windowedMessages(messages: OVOMessage[], settings: OVOSettings): OVOMessage[] {
	let list = messages.filter((m) => !m.error && (m.content.trim().length > 0 || (m.attachments && m.attachments.length > 0)));
	if (settings.contextMessages > 0 && list.length > settings.contextMessages) {
		list = list.slice(-settings.contextMessages);
	}
	if (settings.contextTokenBudget > 0 && list.length > 1) {
		let budget = settings.contextTokenBudget;
		let cut = 0;
		for (let i = list.length - 1; i >= 0; i--) {
			budget -= messageTokens(list[i]);
			if (budget < 0) {
				cut = i + 1;
				break;
			}
		}
		cut = Math.min(cut, list.length - 1); // 至少保留最后一条
		if (cut > 0) list = list.slice(cut);
	}
	return list;
}

function textWithAttachments(m: OVOMessage): string {
	let text = m.content;
	for (const a of m.attachments ?? []) {
		if (a.kind === "text" && a.text) {
			text += `\n\n---\n📎 Attachment "${a.name}" content:\n\n${a.text}\n---`;
		}
	}
	return text;
}

const WEEKDAYS_EN = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** 「注入当日日期」提示词：按本地时区生成 ISO 日期（附带英文星期） */
export function todayPrompt(now = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
	return `[Current date] Today is ${date} (${WEEKDAYS_EN[now.getDay()]}, local time). Use this as the reference for any date calculations.`;
}

/** 联网模式下的系统指令强化：促使模型实际调用 web_search（而非凭记忆回答） */
export const WEB_SEARCH_NUDGE =
	"[Web search is enabled] This request includes the official server-side web_search tool. Follow these rules:\n" +
	"1. Whenever the question involves information that may change over time (news, dates, prices, sports results, exams, versions, policies, etc.), call web_search first to retrieve the latest results; do not answer from memory.\n" +
	"2. Base the answer on the retrieved results and list the source links at the end.\n" +
	"3. If no reliable results are found, state that clearly; never fabricate them.";

/**
 * 构建 Anthropic 兼容端点（/anthropic/v1/messages）的 messages 数组。
 * - 图片附件 → { type: "image", source: { type: "base64", media_type, data } }（仅 user 消息）
 * - 文本附件内容注入 user 文本
 * - 合并相邻同角色消息（Anthropic 协议要求角色交替）；若首条为 assistant 则丢弃
 */
export function buildAnthropicMessages(messages: OVOMessage[], settings: OVOSettings): unknown[] {
	const raw = windowedMessages(messages, settings);
	type Block = { type: string; text?: string; source?: { type: string; media_type: string; data: string } };
	const merged: { role: "user" | "assistant"; content: string[]; images: OVOAttachment[] }[] = [];
	for (const m of raw) {
		const last = merged[merged.length - 1];
		const text = m.role === "user" ? textWithAttachments(m) : m.content;
		const images = m.role === "user" ? (m.attachments ?? []).filter((a) => a.kind === "image" && a.dataUrl) : [];
		if (last && last.role === m.role) {
			last.content.push(text);
			last.images.push(...images);
		} else {
			merged.push({ role: m.role, content: [text], images });
		}
	}
	// Anthropic 要求首条为 user
	while (merged.length && merged[0].role !== "user") merged.shift();
	if (!merged.length) merged.push({ role: "user", content: ["(empty conversation)"], images: [] });

	return merged.map((m) => {
		const blocks: Block[] = m.content
			.filter((t) => t && t.trim().length > 0)
			.map((t) => ({ type: "text", text: t }));
		if (!blocks.length) blocks.push({ type: "text", text: "(no text content)" });
		for (const img of m.images) {
			const { mediaType, data } = parseDataUrl(img.dataUrl!);
			if (data) {
				// 图片块必须位于文本块之后或之前均可；放在文本后
				blocks.push({ type: "image", source: { type: "base64", media_type: mediaType, data } });
			}
		}
		return { role: m.role, content: blocks };
	});
}
