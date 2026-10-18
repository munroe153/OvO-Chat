/**
 * OvO Chat — 共享弹窗（确认 / 单行文本输入）
 *
 * Author: munroe153
 */

import { App, Modal } from "obsidian";
import { isImeComposing } from "./util";

/** 二次确认弹窗（默认确认按钮为红色「删除」） */
export class ConfirmModal extends Modal {
	constructor(
		app: App,
		private message: string,
		private onConfirm: () => void | Promise<void>,
		private confirmText = "删除"
	) {
		super(app);
	}

	onOpen(): void {
		this.contentEl.createDiv({ text: this.message, cls: "ovo-confirm-text" });
		const btns = this.contentEl.createDiv("modal-button-container");
		btns.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
		const ok = btns.createEl("button", { text: this.confirmText, cls: "mod-warning" });
		ok.addEventListener("click", () => {
			void (async () => {
				this.close();
				await this.onConfirm();
			})();
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** 单行文本输入弹窗（Enter 提交 · Esc 关闭；required 时空白输入不提交） */
export class TextInputModal extends Modal {
	constructor(
		app: App,
		private opts: {
			title: string;
			desc?: string;
			initial?: string;
			placeholder?: string;
			maxLength?: number;
			submitText?: string;
			/** 是否禁止空输入，默认 true */
			required?: boolean;
			onSubmit: (value: string) => void | Promise<void>;
		}
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(this.opts.title);
		if (this.opts.desc) {
			this.contentEl.createDiv({ text: this.opts.desc, cls: "ovo-confirm-text" });
		}
		const input = this.contentEl.createEl("input", {
			type: "text",
			cls: "ovo-modal-input",
			attr: {
				placeholder: this.opts.placeholder ?? "",
				maxlength: String(this.opts.maxLength ?? 200),
			},
		});
		input.value = this.opts.initial ?? "";

		const submit = async () => {
			const value = input.value.trim();
			if (this.opts.required !== false && !value) {
				input.focus();
				return;
			}
			this.close();
			await this.opts.onSubmit(value);
		};

		const btns = this.contentEl.createDiv("modal-button-container");
		btns.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
		const ok = btns.createEl("button", { text: this.opts.submitText ?? "保存", cls: "mod-cta" });
		ok.addEventListener("click", () => void submit());

		input.addEventListener("keydown", (e: KeyboardEvent) => {
			if (e.key === "Enter" && !isImeComposing(e)) {
				e.preventDefault();
				void submit();
			} else if (e.key === "Escape") {
				e.preventDefault();
				this.close();
			}
		});
		window.setTimeout(() => {
			input.focus();
			input.select();
		}, 0);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
