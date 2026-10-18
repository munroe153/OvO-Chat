/**
 * 共享小工具（无 Obsidian / 业务依赖）
 * Author: munroe153
 */

/** 从任意异常值提取可展示的信息（Error 取 message，其余 String 化） */
export function errMsg(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/** 输入法组合态：优先 isComposing，兼容旧版 WebView 的 keyCode 229 */
export function isImeComposing(e: KeyboardEvent): boolean {
	return e.isComposing || (e as unknown as { keyCode?: number }).keyCode === 229;
}

/**
 * 解析 data URL（`data:<mime>;base64,<data>`）。
 * 不匹配时返回空 data（mediaType 回落 image/png，与历史实现一致）。
 */
export function parseDataUrl(dataUrl: string): { mediaType: string; data: string } {
	const match = dataUrl.match(/^data:([^;]+);base64,(.*)$/s);
	if (!match) return { mediaType: "image/png", data: "" };
	return { mediaType: match[1], data: match[2] };
}
