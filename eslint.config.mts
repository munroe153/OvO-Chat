import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig(
	globalIgnores([
		"node_modules",
		"dist",
		"eslint.config.mts",
		"main.js",
		"main.js.map",
		"esbuild.config.mjs",
		"version-bump.mjs",
		"versions.json",
		"package.json",
		"pnpm-lock.yaml",
		"tsconfig.json",
		".codebuddy",
		"人工测试仓库",
	]),
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: ["manifest.json"],
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: [".json"],
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		files: ["src/settings.ts"],
		rules: {
			// 自定义分页 UI 无法完整映射到声明式设置 API
			"obsidianmd/settings-tab/prefer-setting-definitions": "off",
		},
	},
	{
		rules: {
			"obsidianmd/ui/sentence-case": [
				"warn",
				{
					brands: ["OvO Chat", "OvO", "DeepSeek", "Obsidian", "Mermaid", "Markdown", "GitHub"],
					acronyms: ["AI", "API", "MIT", "URL", "HTTP", "SSE"],
				},
			],
		},
	},
);
