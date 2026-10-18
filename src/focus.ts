/**
 * OvO Chat 专注时间 —— 命令、时长解析与拦截守卫
 *
 * - 执行命令「专注时间」：输入时长（25 / 25m / 1h …）→ 二次确认 → 写入结束时间戳；
 * - 结束时间以**绝对时间戳**持久化在插件设置中（`settings.focusUntil`），重启插件不重置；
 * - 专注期间所有触发生成的操作（发送消息 / 重新生成 / 编辑问句保存）都会被拦截并提示
 *   「当前处于专注时间」，翻看历史对话不受限制；**不支持提前结束**（再次执行命令只查看剩余时间）。
 *
 * Author: munroe153
 */

import { App, Modal, Notice, Setting } from "obsidian";
import type { OVOChatPlugin } from "./main";

/** 专注时长上限（24 小时） */
const FOCUS_MAX_MINUTES = 1440;
/** 时长输入框默认值（分钟） */
const FOCUS_DEFAULT_MINUTES = 25;

/**
 * 解析专注时长（返回分钟；非法返回 null）：
 * - 纯数字 = 分钟（25）；
 * - 支持单位后缀：m / min / 分 / 分钟、h / 时 / 小时；
 * - 支持组合写法：1h30m / 1小时30分钟；
 * - 取值 1 分钟 – 24 小时。
 */
export function parseFocusDuration(input: string): number | null {
	const text = input.trim().toLowerCase().replace(/\s+/g, "");
	if (!text) return null;
	const re = /(\d+(?:\.\d+)?)(小时|h|min|m|分钟|分|时)?/g;
	let total = 0;
	let matched = "";
	let m: RegExpExecArray | null;
	while ((m = re.exec(text))) {
		const n = Number.parseFloat(m[1]);
		if (!Number.isFinite(n)) return null;
		const unit = m[2] ?? "";
		total += unit === "h" || unit === "时" || unit === "小时" ? n * 60 : n;
		matched += m[0];
	}
	if (matched !== text) return null; // 存在无法识别的字符
	const minutes = Math.round(total);
	if (minutes < 1 || minutes > FOCUS_MAX_MINUTES) return null;
	return minutes;
}

/** 分钟 → 可读时长（1 小时 30 分钟 / 25 分钟） */
export function formatDuration(minutes: number): string {
	const h = Math.floor(minutes / 60);
	const m = Math.round(minutes % 60);
	if (h && m) return `${h} 小时 ${m} 分钟`;
	if (h) return `${h} 小时`;
	return `${m} 分钟`;
}

export class FocusTimer {
	constructor(private plugin: OVOChatPlugin) {}

	get app(): App {
		return this.plugin.app;
	}

	/** 注册「专注时间」命令（插件 onload 调用） */
	registerCommand(): void {
		this.plugin.addCommand({
			id: "focus-time",
			name: "专注时间",
			callback: () => this.openDialog(),
		});
	}

	/** 剩余毫秒（未设置或已结束返回 0；纯时间戳比较，重启插件不重置） */
	remainingMs(): number {
		const until = this.plugin.settings.focusUntil;
		if (!until) return 0;
		return Math.max(0, until - Date.now());
	}

	/** 是否处于专注时间 */
	isActive(): boolean {
		return this.remainingMs() > 0;
	}

	/** 剩余分钟（向上取整，用于拦截提示） */
	remainingMinutes(): number {
		return Math.ceil(this.remainingMs() / 60_000);
	}

	/** 开始专注：写入绝对结束时间戳并落盘（返回结束时间戳） */
	async start(minutes: number): Promise<number> {
		const until = Date.now() + minutes * 60_000;
		this.plugin.settings.focusUntil = until;
		await this.plugin.saveSettings();
		return until;
	}

	/** 执行命令：已处于专注时仅提示剩余时间（不支持提前结束），否则打开时长输入 / 确认弹窗 */
	openDialog(): void {
		if (this.isActive()) {
			new Notice(
				`当前处于专注时间，剩余 ${this.remainingMinutes()} 分钟（不可提前结束，结束后可再次设置）`,
				8000
			);
			return;
		}
		new FocusDurationModal(this).open();
	}
}

/** 专注时长弹窗：输入 → 解析结果与结束时刻二次确认（两步在同一弹窗内） */
class FocusDurationModal extends Modal {
	private step: "input" | "confirm" = "input";
	private inputValue = String(FOCUS_DEFAULT_MINUTES);
	private minutes = 0;

	constructor(private timer: FocusTimer) {
		super(timer.app);
	}

	onOpen(): void {
		this.contentEl.addClass("ovo-focus-modal");
		this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private render(): void {
		this.contentEl.empty();
		if (this.step === "input") this.renderInput();
		else this.renderConfirm();
	}

	/** 第一步：输入时长 */
	private renderInput(): void {
		const el = this.contentEl;
		this.titleEl.setText("专注时间");
		el.createEl("p", {
			cls: "ovo-focus-tip",
			text: `输入专注时长：纯数字按分钟计，支持 25 / 25m / 1h / 1小时30分钟 等写法（1 分钟 – 24 小时）。`,
		});
		new Setting(el).setName("专注时长").addText((t) => {
			t.setValue(this.inputValue)
				.setPlaceholder("25 / 25m / 1h")
				.onChange((v) => (this.inputValue = v));
			t.inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
				if (e.key === "Enter") {
					e.preventDefault();
					this.toConfirm();
				}
			});
			window.setTimeout(() => {
				t.inputEl.focus();
				t.inputEl.select();
			}, 0);
		});

		const btns = el.createDiv("modal-button-container");
		btns.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
		btns.createEl("button", { text: "下一步", cls: "mod-cta" }).addEventListener("click", () =>
			this.toConfirm()
		);
	}

	/** 校验输入 → 进入二次确认 */
	private toConfirm(): void {
		const minutes = parseFocusDuration(this.inputValue);
		if (!minutes) {
			new Notice("时长无法识别：请输入 25 / 25m / 1h 这类写法（1 分钟 – 24 小时）", 8000);
			return;
		}
		this.minutes = minutes;
		this.step = "confirm";
		this.render();
	}

	/** 第二步：二次确认时长与结束时刻 */
	private renderConfirm(): void {
		const el = this.contentEl;
		const until = new Date(Date.now() + this.minutes * 60_000);
		const hhmm = until.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
		this.titleEl.setText("确认专注时间");
		el.createEl("p", { cls: "ovo-focus-tip", text: `将开始 ${formatDuration(this.minutes)} 的专注，至 ${hhmm}。` });
		el.createEl("p", {
			cls: "ovo-focus-tip ovo-focus-warn",
			text: "专注期间无法发送对话、重新生成或保存编辑（翻看历史不受限制），且不可提前结束。",
		});

		const btns = el.createDiv("modal-button-container");
		btns.createEl("button", { text: "返回修改" }).addEventListener("click", () => {
			this.step = "input";
			this.render();
		});
		btns.createEl("button", { text: "开始专注", cls: "mod-cta" }).addEventListener("click", () => {
			void (async () => {
				const at = await this.timer.start(this.minutes);
				this.close();
				const end = new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
				new Notice(
					`🎯 专注时间已开始：${formatDuration(this.minutes)}（至 ${end}）。期间无法发送对话，翻看历史不受限。`,
					10_000
				);
			})();
		});
	}
}
