/**
 * OVO 内置工具组 — 注册表
 *
 * 视图通过 `list()` 取工具定义下发给模型，通过 `execute()` 执行模型发起的调用。
 * `execute()` 永不抛出：未知工具、参数异常、执行失败统一返回 `{ ok: false, text }`，
 * 由视图回写给模型并渲染失败行，不会中断对话。
 *
 * Author: munroe153
 */

import type { App } from "obsidian";
import { createBuiltinTools } from "./builtin";
import type { OVOBuiltinTool, OVOToolResult } from "./types";
import { errMsg } from "../util";

export class BuiltinToolRegistry {
	private readonly tools: OVOBuiltinTool[];
	private readonly index: Map<string, OVOBuiltinTool>;

	/** @param getReadMaxChars 读取工具正文上限的动态取值（接设置「工具 → 读取范围」） */
	constructor(app: App, getReadMaxChars: () => number) {
		this.tools = createBuiltinTools(app, getReadMaxChars);
		this.index = new Map(this.tools.map((t) => [t.name, t]));
	}

	/** 全部内置工具（用于下发给模型与设置页展示） */
	list(): OVOBuiltinTool[] {
		return this.tools;
	}

	/** 工具名清单（用于提示文案） */
	names(): string[] {
		return this.tools.map((t) => t.name);
	}

	/** 执行一个工具调用；永不抛出 */
	async execute(name: string, args: Record<string, unknown>): Promise<OVOToolResult> {
		const tool = this.index.get(name);
		if (!tool) {
			return { ok: false, text: `Unknown tool "${name}". Available tools: ${this.names().join(", ")}` };
		}
		try {
			const r = await tool.execute(args ?? {});
			return { ok: !!r.ok, text: r.text };
		} catch (e) {
			const msg = errMsg(e);
			return { ok: false, text: `Tool ${name} failed: ${msg}` };
		}
	}
}
