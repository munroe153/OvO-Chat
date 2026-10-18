/**
 * DeepSeek 官方 API 客户端
 *
 * 对话接口：**Anthropic 兼容端点**（`POST /anthropic/v1/messages`，流式）
 * - 🔒 锁死官方地址 https://api.deepseek.com/anthropic，不支持任何第三方中转 / 代理；
 * - 随请求内置官方服务端搜索工具 `web_search`（`web_search_20250305`）：由 DeepSeek 服务端执行，
 *   搜索结果以 `web_search_tool_result` 内容块回传，来源 URL 可提取展示；
 * - 思考：`thinking: { type }` + `output_config.effort`（官方兼容表：budget_tokens 被忽略）；
 * - 内置只读工具：以 `{ name, description, input_schema }` 下发，模型以 `tool_use` 发起调用。
 *
 * 文档依据（api-docs.deepseek.com，2026）：
 * - GET /models（OpenAI 兼容）：返回模型 id / name / 上下文窗口等，是获取模型列表的唯一官方来源
 * - Anthropic 兼容：thinking 支持、top_p 仅思考模式生效且下界 0.95、temperature 支持
 *
 * Author: munroe153
 */

import { requestUrl } from "obsidian";
import type { OVOMessageSource, OVOModelInfo, OVOUsage, ThinkingEffort } from "../types";

/** 🔒 锁死的官方接口地址 —— OvO Chat 不支持任何第三方端点 */
const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
/** 🔒 官方 Anthropic 兼容端点（对话统一走此路由） */
const DEEPSEEK_ANTHROPIC_BASE_URL = "https://api.deepseek.com/anthropic";

/**
 * 兜底模型列表：仅在尚未拉到官方模型列表（无密钥 / 网络失败 / 首次启动）时使用。
 * 一旦 `GET /models` 成功，即被动态缓存替代。
 */
export const FALLBACK_MODELS: OVOModelInfo[] = [
	{ id: "deepseek-flash", label: "DeepSeek-V4.1-Flash" },
	{ id: "deepseek-v4-pro", label: "DeepSeek-V4-Pro" },
];

/**
 * 冗余模型 ID：官方保留但已退役的旧别名（请求会被后端映射到当前模型），
 * 以及历史遗留的旧版别名 —— 一律从模型列表中剔除。
 */
const REDUNDANT_MODEL_IDS = new Set([
	"deepseek-chat",
	"deepseek-reasoner",
	"deepseek-v4-flash",
	"deepseek-v4-flash-vision-exp",
]);

interface DeepSeekApiError extends Error {
	status?: number;
}

function apiError(message: string, status?: number): Error {
	const e: DeepSeekApiError = new Error(message);
	e.status = status;
	return e;
}

const FRIENDLY_STATUS: Record<number, string> = {
	400: "请求参数有误（400）",
	401: "API Key 无效或未填写（401）",
	402: "账户余额不足（402），请前往 DeepSeek 开放平台充值",
	403: "无访问权限（403）",
	404: "接口或模型不存在（404），请检查模型 ID",
	422: "请求参数校验失败（422）",
	429: "请求过于频繁（429），请稍后重试",
	500: "DeepSeek 服务内部错误（500）",
	503: "DeepSeek 服务繁忙（503），请稍后重试",
};

export interface StreamHandlers {
	/** 思考（CoT）增量 */
	onReasoning?: (delta: string, full: string) => void;
	/** 正文增量 */
	onText?: (delta: string, full: string) => void;
	/** 联网搜索状态（query） */
	onSearching?: (query: string) => void;
	/** 联网来源（引用） */
	onSources?: (sources: OVOMessageSource[]) => void;
	/** token 用量 */
	onUsage?: (usage: OVOUsage) => void;
	/** 模型发起了一次工具调用（参数已收集完毕） */
	onToolCall?: (call: { id: string; name: string; args: unknown }) => void;
}

interface CommonOptions {
	apiKey: string;
	model: string;
	effort: ThinkingEffort;
	temperature?: number;
	topP?: number;
	maxTokens?: number;
	/** 停止序列（Anthropic：stop_sequences） */
	stop?: string[];
	signal?: AbortSignal;
}

/** 协议无关的工具调用描述（模型发起；参数在本层解析一次，消费方不再重复 JSON.parse） */
export interface ToolCallDraft {
	id: string;
	name: string;
	/** 原始参数串（展示 / 解析失败时回退用） */
	arguments: string;
	/** 解析成功的参数对象；解析失败时缺省（各消费方按既有回退语义处理） */
	args?: Record<string, unknown>;
}

export interface StreamResult {
	content: string;
	reasoning: string;
	usage?: OVOUsage | null;
	sources?: OVOMessageSource[];
	/** 模型请求的工具调用（工具调用模式下） */
	toolCalls?: ToolCallDraft[];
}

/** 解析官方 GET /models 返回，剔除冗余别名并按展示名去重 */
function normalizeModels(json: unknown): OVOModelInfo[] {
	const data = (json as { data?: unknown })?.data;
	if (!Array.isArray(data)) return [];
	const out: OVOModelInfo[] = [];
	const seenId = new Set<string>();
	const seenLabel = new Set<string>();
	for (const raw of data) {
		if (!raw || typeof raw !== "object") continue;
		const rec = raw as { id?: unknown; name?: unknown };
		const id = typeof rec.id === "string" ? rec.id.trim() : "";
		if (!id || seenId.has(id) || REDUNDANT_MODEL_IDS.has(id)) continue;
		const label = (typeof rec.name === "string" && rec.name.trim()) || id;
		// 同一展示名的多个别名（含遗留名）只保留首个规范 id
		if (seenLabel.has(label)) continue;
		seenId.add(id);
		seenLabel.add(label);
		out.push({ id, label });
	}
	return out;
}

/* ---------------- Anthropic 流式事件（只声明本插件读取的字段） ---------------- */

interface AnthropicUsagePayload {
	input_tokens?: number;
	output_tokens?: number;
}

interface AnthropicWebSearchResult {
	type?: string;
	url?: string;
	title?: string;
}

interface AnthropicContentBlock {
	type?: string;
	id?: string;
	name?: string;
	content?: AnthropicWebSearchResult[];
}

interface AnthropicDelta {
	type?: string;
	thinking?: string;
	text?: string;
	partial_json?: string;
}

interface AnthropicStreamEvent {
	type?: string;
	message?: { usage?: AnthropicUsagePayload };
	usage?: AnthropicUsagePayload;
	index?: number;
	content_block?: AnthropicContentBlock;
	delta?: AnthropicDelta;
	error?: { message?: string };
}

export class DeepSeekClient {
	/**
	 * 拉取 DeepSeek 官方模型列表（GET /models，OpenAI 兼容）
	 * 已剔除退役别名 / 重复展示名。
	 */
	async listModels(apiKey: string): Promise<OVOModelInfo[]> {
		const res = await requestUrl({
			url: `${DEEPSEEK_BASE_URL}/models`,
			method: "GET",
			headers: { Authorization: `Bearer ${apiKey}` },
			throw: false,
		});
		if (res.status !== 200) {
			throw apiError(FRIENDLY_STATUS[res.status] ?? `HTTP ${res.status}`, res.status);
		}
		return normalizeModels(res.json);
	}

	/**
	 * Anthropic 兼容端点流式对话（POST /anthropic/v1/messages，stream: true）
	 *
	 * - 服务端联网搜索：opts.webSearch 时附带 `{ type: "web_search_20250305", name: "web_search" }`，
	 *   由 DeepSeek 服务端执行；过程以 server_tool_use / web_search_tool_result 内容块返回；
	 * - 内置工具：opts.tools（Anthropic 格式 `{ name, description, input_schema }`），
	 *   模型以 tool_use 内容块发起调用，宿主执行后以 tool_result 回传（多轮工具循环）；
	 * - 思考：`thinking: { type }` + `output_config.effort`（官方兼容表：budget_tokens 被忽略）。
	 */
	async anthropicStream(
		messages: unknown[],
		opts: CommonOptions & { system?: string; webSearch?: boolean; tools?: unknown[] },
		handlers: StreamHandlers
	): Promise<StreamResult> {
		const body: Record<string, unknown> = {
			model: opts.model,
			messages,
			stream: true,
			max_tokens: opts.maxTokens ?? 8192,
		};
		if (opts.system && opts.system.trim()) body.system = opts.system.trim();
		// 思考强度：off → 显式关闭；其余 → 开启思考并设置 effort（medium 映射为 high）
		if (opts.effort === "off") {
			body.thinking = { type: "disabled" };
			body.reasoning = { effort: "none" };
		} else {
			body.thinking = { type: "enabled" };
			const effortMap: Record<string, string> = { low: "low", medium: "high", high: "high", max: "max" };
			body.output_config = { effort: effortMap[opts.effort] ?? "high" };
		}
		if (opts.temperature != null) body.temperature = opts.temperature;
		if (opts.topP != null) body.top_p = opts.topP;
		if (opts.stop && opts.stop.length) body.stop_sequences = opts.stop;
		const allTools: unknown[] = [];
		if (opts.webSearch) allTools.push({ type: "web_search_20250305", name: "web_search" });
		if (opts.tools && opts.tools.length) allTools.push(...opts.tools);
		if (allTools.length) body.tools = allTools;

		// SSE 需要逐块读取增量，Obsidian 的 requestUrl 不支持流式响应；
		// 非流式的模型列表接口仍使用 requestUrl（见 listModels）。
		const res = await window.fetch(`${DEEPSEEK_ANTHROPIC_BASE_URL}/v1/messages`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-api-key": opts.apiKey,
				"anthropic-version": "2023-06-01",
			},
			body: JSON.stringify(body),
			signal: opts.signal,
		});
		await this.assertOk(res);

		let content = "";
		let reasoning = "";
		let usage: OVOUsage | undefined;
		const sources: OVOMessageSource[] = [];
		const addSource = (s: OVOMessageSource) => {
			if (s.url && !sources.some((x) => x.url === s.url)) sources.push(s);
		};
		// 内容块跟踪：index → { kind, jsonBuf, id, name }
		type BlockKind = "server_tool_use" | "tool_use" | "other";
		const blocks = new Map<number, { kind: BlockKind; jsonBuf: string; id: string; name: string }>();
		const toolCalls: ToolCallDraft[] = [];
		let textBlocks = 0;

		let eventName = "";
		for await (const line of this.sseLines(res)) {
			if (line.startsWith("event:")) {
				eventName = line.slice(6).trim();
				continue;
			}
			if (!line.startsWith("data:")) continue;
			const raw = line.slice(5).trim();
			if (!raw) continue;
			let evt: AnthropicStreamEvent;
			try {
				evt = JSON.parse(raw) as AnthropicStreamEvent;
			} catch {
				continue;
			}
			const type: string = evt.type ?? eventName;
			switch (type) {
				case "message_start": {
					const u = evt.message?.usage;
					if (u) {
						usage = { input_tokens: u.input_tokens, output_tokens: u.output_tokens };
						handlers.onUsage?.(usage);
					}
					break;
				}
				case "content_block_start": {
					const block = evt.content_block ?? {};
					const idx = evt.index ?? 0;
					if (block.type === "server_tool_use" || block.type === "tool_use") {
						blocks.set(idx, {
							kind: block.type === "server_tool_use" ? "server_tool_use" : "tool_use",
							jsonBuf: "",
							id: block.id ?? "",
							name: block.name ?? "",
						});
						if (block.type === "server_tool_use") handlers.onSearching?.("");
					} else {
						blocks.set(idx, { kind: "other", jsonBuf: "", id: "", name: "" });
						if (block.type === "web_search_tool_result") {
							const results = block.content;
							if (Array.isArray(results)) {
								for (const r of results) {
									if (r.type === "web_search_result" || r.url) {
										addSource({ url: r.url ?? "", title: r.title });
									}
								}
								if (sources.length) handlers.onSources?.(sources);
							}
						} else if (block.type === "text") {
							if (textBlocks > 0) content += "\n\n";
							textBlocks++;
						}
					}
					break;
				}
				case "content_block_delta": {
					const delta = evt.delta ?? {};
					if (delta.type === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking) {
						reasoning += delta.thinking;
						handlers.onReasoning?.(delta.thinking, reasoning);
					} else if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text) {
						content += delta.text;
						handlers.onText?.(delta.text, content);
					} else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
						const blk = blocks.get(evt.index ?? -1);
						if (blk) blk.jsonBuf += delta.partial_json;
					}
					break;
				}
				case "content_block_stop": {
					const idx = evt.index ?? -1;
					const blk = blocks.get(idx);
					if (blk) {
						if (blk.kind === "server_tool_use") {
							try {
								const parsed = JSON.parse(blk.jsonBuf || "{}") as { query?: string };
								handlers.onSearching?.(typeof parsed.query === "string" ? parsed.query : "");
							} catch {
								handlers.onSearching?.("");
							}
						} else if (blk.kind === "tool_use" && blk.name) {
							const raw = blk.jsonBuf || "{}";
							let args: Record<string, unknown> | undefined;
							try {
								args = (JSON.parse(raw) as Record<string, unknown>) ?? undefined;
							} catch {
								args = undefined;
							}
							toolCalls.push({ id: blk.id, name: blk.name, arguments: raw, args });
							// onToolCall 的 args 语义与原实现一致：解析成功为对象，失败为原始串
							handlers.onToolCall?.({ id: blk.id, name: blk.name, args: args ?? raw });
						}
						blocks.delete(idx);
					}
					break;
				}
				case "message_delta": {
					const u = evt.usage;
					if (u) {
						usage = {
							...(usage ?? {}),
							input_tokens: usage?.input_tokens ?? u.input_tokens,
							output_tokens: u.output_tokens,
						};
						handlers.onUsage?.(usage);
					}
					break;
				}
				case "message_stop": {
					if (sources.length) handlers.onSources?.(sources);
					return {
						content,
						reasoning,
						usage: usage ?? null,
						sources,
						toolCalls: toolCalls.length ? toolCalls : undefined,
					};
				}
				case "error": {
					const err = evt.error ?? {};
					throw apiError(`生成失败：${err.message ?? JSON.stringify(err)}`);
				}
				default:
					break;
			}
		}
		return {
			content,
			reasoning,
			usage: usage ?? null,
			sources,
			toolCalls: toolCalls.length ? toolCalls : undefined,
		};
	}

	private async assertOk(res: Response): Promise<void> {
		if (res.ok) return;
		let detail = "";
		try {
			const text = await res.text();
			try {
				const j = JSON.parse(text) as { error?: { message?: string }; message?: string };
				detail = j.error?.message ?? j.message ?? text;
			} catch {
				detail = text;
			}
		} catch {
			/* ignore */
		}
		detail = (detail || "").slice(0, 300);
		throw apiError(
			`${FRIENDLY_STATUS[res.status] ?? `HTTP ${res.status}`}${detail ? "：" + detail : ""}`,
			res.status
		);
	}

	/** 将 SSE 流切分为行 */
	private async *sseLines(res: Response): AsyncGenerator<string> {
		if (!res.body) throw apiError("响应不含可读流（可能是网络或代理问题）");
		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buf = "";
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buf += decoder.decode(value, { stream: true });
				let idx: number;
				while ((idx = buf.indexOf("\n")) >= 0) {
					const line = buf.slice(0, idx).replace(/\r$/, "");
					buf = buf.slice(idx + 1);
					yield line;
				}
			}
			if (buf.trim()) yield buf.trim();
		} finally {
			try {
				reader.releaseLock();
			} catch {
				/* ignore */
			}
		}
	}
}
