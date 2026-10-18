/**
 * OvO Chat — 密钥访问层
 *
 * 采用 Obsidian 官方《Store secrets》推荐的「命名引用」模式：
 * - 插件配置（data.json）里只保存密钥的「名字」（SecretStorage 的 id）；
 * - 密钥值由 Obsidian 统一托管（`App.secretStorage`，@since 1.11.4），不落明文；
 * - 全插件通过 `OVOChatPlugin.getApiKey()` 这唯一出口取值。
 *
 * 兼容性：`SecretStorage` 是 Obsidian 核心 API，桌面端与移动端同样可用；
 * 密钥值存放于本地并与具体 vault 绑定，**不随库同步**，移动端需各自选择或新建。
 *
 * Author: munroe153
 */

import type { App } from "obsidian";
import type { OVOSettings } from "./types";

/** 默认密钥名（必须满足密钥库 id 约束：小写字母 / 数字 / 连字符） */
const DEFAULT_SECRET_ID = "ovo-deepseek-key";

/**
 * 规范化密钥名：转小写、非法字符转 `-`、合并连续 `-`、去除首尾 `-`；
 * 结果为空时回落到 {@link DEFAULT_SECRET_ID}。
 *
 * `SecretStorage.setSecret()` 对 id 有 `^[a-z0-9-]+$` 约束，非法 id 会抛异常，
 * 因此所有写入与读取都必须先经此函数。
 */
function normalizeSecretId(name: string): string {
	const id = String(name ?? "")
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^-+|-+$/g, "");
	return id || DEFAULT_SECRET_ID;
}

/** 密钥库是否可用（旧版本 Obsidian 上为 undefined；本插件要求 1.11.4+，此处仅作兜底） */
function hasSecretStorage(app: App): boolean {
	return !!app.secretStorage;
}

/** 读取密钥值；不存在、未设置或容器不可用时统一返回 `""`（不抛异常） */
function getSecret(app: App, id: string): string {
	if (!id) return "";
	if (!hasSecretStorage(app)) return "";
	try {
		return app.secretStorage.getSecret(normalizeSecretId(id)) ?? "";
	} catch (e) {
		console.error("[OvO] 读取密钥失败", e);
		return "";
	}
}

/** 依据 `settings.apiKeySecretId` 解析当前 DeepSeek API Key（未配置时返回 `""`） */
export function readApiKey(app: App, settings: OVOSettings): string {
	if (!settings.apiKeySecretId) return "";
	return getSecret(app, settings.apiKeySecretId).trim();
}
