/**
 * OvO Chat 个性化提示词 —— 语气风格 / 亲切度 / 热情度 / 表情符号 / 排版风格
 *
 * 设置「个性化」分页选择后，每轮对话把对应提示词片段注入系统消息（默认档不注入）：
 * - 基本风格和语调：7 项（默认 + 专业可靠 / 亲和友善 / 直言不讳 / 天马行空 / 高效务实 / 吐槽达人）
 * - 亲切程度 / 热情程度 / 表情符号：各三档（增强 / 默认 / 减弱）
 * - 布局和视觉元素：默认 / 简洁
 *
 * 提示词仅约束语气与排版风格，不改变事实性与安全边界；选项表顺序即设置页展示顺序。
 *
 * Author: munroe153
 */

import type { OVOLevel, OVOLayoutStyle, OVOSettings, OVOToneId } from "./types";

/** 一个下拉选项（id 写入设置；prompt 为空串表示默认档、不注入） */
export interface OVOChoice<T extends string> {
	id: T;
	/** 设置页展示名 */
	name: string;
	/** 设置页说明 */
	desc: string;
	/** 注入模型的提示词片段 */
	prompt: string;
}

/* ---------------- 基本风格和语调 ---------------- */

export const TONE_CHOICES: OVOChoice<OVOToneId>[] = [
	{
		id: "default",
		name: "默认",
		desc: "不做语气约束，保持模型原本的表达风格。",
		prompt: "",
	},
	{
		id: "professional",
		name: "专业可靠",
		desc: "结论先行、表述严谨克制，不确定处明确说明。",
		prompt:
			"[Tone] Keep a professional, rigorous, and reliable tone: lead with the conclusion, use precise and restrained wording, and follow standard terminology. " +
			"State uncertainty or disagreement clearly, do not exaggerate or overpromise, and avoid joking phrasing.",
	},
	{
		id: "friendly",
		name: "亲和友善",
		desc: "像朋友一样自然交流，照顾阅读感受。",
		prompt:
			"[Tone] Communicate in a warm, friendly tone: sound like a friend chatting naturally, using \"we\" and \"together\" to close the distance. " +
			"Show understanding and encouragement, and avoid sounding condescending or preachy.",
	},
	{
		id: "blunt",
		name: "直言不讳",
		desc: "先给结论与判断，坦率指出问题与风险。",
		prompt:
			"[Tone] Be direct and outspoken: give the conclusion and judgment first, then the reasons. Point out problems, risks, and mistakes candidly, without hedging or pleasantries. " +
			"Be direct but criticize ideas, not people; keep necessary warnings for high-stakes topics such as safety, medical, or legal matters.",
	},
	{
		id: "whimsical",
		name: "天马行空",
		desc: "大胆联想与假设，多用类比和比喻。",
		prompt:
			"[Tone] Think freely and imaginatively: feel free to branch out, propose bold hypotheses and multiple possibilities, and use vivid analogies and metaphors to aid understanding. " +
			"Still end with a clear, actionable conclusion that stays on topic.",
	},
	{
		id: "pragmatic",
		name: "高效务实",
		desc: "直奔主题，优先给可执行的步骤与结论。",
		prompt:
			"[Tone] Be efficient and pragmatic: get straight to the point, without preamble or restating the user's question. If one sentence is enough, do not write three. " +
			"Prioritize actionable steps, conclusions, and trade-offs; do not expand on background knowledge unless the user asks.",
	},
	{
		id: "sarcastic",
		name: "吐槽达人",
		desc: "允许幽默戏谑地点评，信息依然准确。",
		prompt:
			"[Tone] Use light-hearted sarcasm: you may comment on the issue with humor and playful exaggeration, and use self-deprecation to keep things lively. " +
			"Keep it brief, never offend specific people or groups, and keep all factual content accurate and uncompromised.",
	},
];

/* ---------------- 亲切程度 ---------------- */

export const WARMTH_CHOICES: OVOChoice<OVOLevel>[] = [
	{
		id: "up",
		name: "增强",
		desc: "更亲切的口吻，可用口语化表达与适当共情。",
		prompt:
			"[Warmth] Be a little warmer: use conversational phrasing and appropriate care or empathy (e.g., \"No rush\", \"Good question\") to close the distance with the user.",
	},
	{
		id: "default",
		name: "默认",
		desc: "不做约束。",
		prompt: "",
	},
	{
		id: "down",
		name: "减弱",
		desc: "礼貌但不亲昵，就事论事。",
		prompt: "[Warmth] Be a little more reserved: remain polite and professional, but avoid being overly intimate, making small talk, or padding with empathy; focus on the matter itself.",
	},
];

/* ---------------- 热情程度 ---------------- */

export const ENTHUSIASM_CHOICES: OVOChoice<OVOLevel>[] = [
	{
		id: "up",
		name: "增强",
		desc: "语气积极，适当表达认可与鼓励。",
		prompt: "[Enthusiasm] Show more energy: use a positive, upbeat tone, offer appropriate recognition and encouragement, and make the answer more engaging—without being over the top.",
	},
	{
		id: "default",
		name: "默认",
		desc: "不做约束。",
		prompt: "",
	},
	{
		id: "down",
		name: "减弱",
		desc: "语气平实冷静，不渲染情绪。",
		prompt: "[Enthusiasm] Be calmer: keep the tone plain and objective, avoid exclamation marks and emotional wording, and simply state facts and conclusions.",
	},
];

/* ---------------- 表情符号 ---------------- */

export const EMOJI_CHOICES: OVOChoice<OVOLevel>[] = [
	{
		id: "up",
		name: "增强",
		desc: "适度用 emoji 点缀小标题与要点。",
		prompt:
			"[Emoji] Use emoji in moderation to enhance expression: you may add them to headings or bullet points (e.g., ✅ ⚠️ 💡), " +
			"but do not overuse them, add one to every sentence, or replace words with emoji.",
	},
	{
		id: "default",
		name: "默认",
		desc: "不做约束。",
		prompt: "",
	},
	{
		id: "down",
		name: "减弱",
		desc: "不使用表情符号，保持纯文字。",
		prompt: "[Emoji] Do not use emoji or emoticons; keep the response plain text.",
	},
];

/* ---------------- 布局和视觉元素 ---------------- */

export const LAYOUT_CHOICES: OVOChoice<OVOLayoutStyle>[] = [
	{
		id: "default",
		name: "默认",
		desc: "允许标题、列表、加粗、表格等丰富排版。",
		prompt: "",
	},
	{
		id: "concise",
		name: "简洁",
		desc: "以自然段落为主，少用装饰性排版。",
		prompt:
			"[Layout] Keep the layout as simple as possible: prefer natural paragraphs and avoid multi-level headings, bold text, lists, and tables unless truly necessary. " +
			"Use lists or tables only when the content genuinely needs structure (e.g., parallel steps or comparative data), with at most two levels.",
	},
];

/* ---------------- 组装 ---------------- */

function promptOf<T extends string>(choices: OVOChoice<T>[], id: T): string {
	return choices.find((c) => c.id === id)?.prompt ?? "";
}

/**
 * 组装个性化提示词（系统消息注入用）。
 * 总开关关闭、或各维度均选「默认」档时返回空串（调用方自行过滤）。
 */
export function buildPersonalizationPrompt(s: OVOSettings): string {
	if (!s.personalizeEnabled) return "";
	return [
		promptOf(TONE_CHOICES, s.tone),
		promptOf(WARMTH_CHOICES, s.warmth),
		promptOf(ENTHUSIASM_CHOICES, s.enthusiasm),
		promptOf(EMOJI_CHOICES, s.emojiLevel),
		promptOf(LAYOUT_CHOICES, s.layoutStyle),
	]
		.filter(Boolean)
		.join("\n");
}
