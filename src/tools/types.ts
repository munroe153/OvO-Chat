/**
 * OVO 内置工具组 — 类型定义
 *
 * 工具由插件自带（不再有扩展体系）：只读、开箱可用、跨平台（桌面端与移动端一致）。
 * Author: munroe153
 */

/** 工具执行结果：`ok=false` 表示执行失败，`text` 会作为失败原因回写给模型 */
export interface OVOToolResult {
	ok: boolean;
	text: string;
}

/** 一个内置工具的定义 */
export interface OVOBuiltinTool {
	/** 对模型暴露的工具名（snake_case） */
	name: string;
	/** 设置页展示用的中文名 */
	label: string;
	/** 给模型看的功能说明 */
	description: string;
	/** 参数 JSON Schema（OpenAI function parameters / Anthropic input_schema 通用） */
	parameters: Record<string, unknown>;
	/** 执行；返回值会序列化后回传给模型。异常由注册表兜底，此处可不做防御 */
	execute(args: Record<string, unknown>): Promise<OVOToolResult>;
}
