# opencode-prompts

[English](README.en.md) | 简体中文

OpenCode v2 的提示词插件：给你配置里已有的角色换上自己写的完整提示词，按模型挑模板。

## 能干嘛

- 角色正文整个换成你的文件；不同模型（GPT、Kimi、GLM……）可以给不同模板。
- 模板里挖槽位，内容来自内联字符串、文件、或运行时数据（角色 / 模型 / 工具列表）。
- 槽位规则严格：声明了就得恰好用一次，不想用就显式写 `{{名字:omit}}`。写错了会把消息拦在模型外面，原因进日志，不会悄悄退回原生提示词。
- 改模板文件，下一条消息就生效，不用重启。禁用插件、或把角色移出定义，就恢复角色原有配置。

不注册角色、不改权限、不动默认模型——定义里的 agent ID 只是接管名单。

## 安装

需要 Bun 和 OpenCode v2（验证版本 2.0.24）。

```bash
bun install --frozen-lockfile
bun run build
```

然后在 v2 配置的 `plugins` 里加一条，`package` 指向本仓库**目录**：

```jsonc
{
  "plugins": [
    {
      "package": "/绝对路径/opencode-prompts",
      "options": { "definition": "/绝对路径/我的提示词.jsonc" }
    }
  ]
}
```

选项：`definition` 必填（定义文件路径；相对路径从当前项目算，支持 `~`）；`logFile` 可选（默认是定义文件旁的 `opencode-prompts.log`）；`enabled` 默认 `true`。

## 定义文件

```jsonc
{
  "agents": {
    "build": {                        // 你配置里已有的角色 ID
      "template": { "file": "templates/default.md" },
      "slots": {
        "身份": { "file": "slots/identity.md" },
        "模型信息": { "runtime": "model" }
      },
      "rules": [
        { "models": ["*gpt-*"], "template": { "file": "templates/gpt.md" } }
      ]
    }
  }
}
```

- `template`：内联字符串或 `{ "file": "…" }`；`file` 相对定义文件所在目录。
- `slots`：三种来源——字符串、`{ "file": "…" }`、`{ "runtime": "agent" | "model" | "tools" }`。
- `rules`：对完整的 `providerID/modelID` 做大小写敏感的 glob（`*` 可以跨 `/`）。按数组顺序，命中的都生效，后面的覆盖前面的字段；`excludeModels` 命中就跳过整条。
- 模板里 `{{名字}}` 引用槽位，`{{名字:omit}}` 显式不用；每个声明过的槽位必须恰好出现一次。槽位内容是纯字符串拼接，不会二次解析。

完整可跑的例子在 `examples/`，复制整目录、把角色 ID 换成你自己的就能用。`schema.json` 可以给编辑器做补全。

## 排错

消息被拦下时看日志：JSONL，每行带 `phase`、`code`、`hint` 和文件位置。常见的几种——定义 JSON 语法错（`definition-json`）、槽位没用上或重复（`slot-missing` / `slot-repeated`）、模板文件读不到（`template-file`）、角色在宿主里不存在（`agent-missing`）。修好文件直接再发一条，同会话恢复，不用重启。

## 其他

- 离线预览渲染结果，不用启动 OpenCode：

  ```bash
  node --input-type=module -e "
  import { loadDefinition, preparePrompt } from './dist/core.js';
  const file = './examples/prompts.jsonc';
  const def = loadDefinition(file);
  const prepared = preparePrompt(def, file, 'build', 'openai/gpt-5');
  console.log(prepared.render({ agent: 'build', model: { providerID: 'openai', id: 'gpt-5' }, tools: {} }));
  "
  ```

- 完整 QA：`node qa/native-v2.mjs`，在隔离环境里起官方二进制和 mock 供应商跑 26 个用例。
- 验证环境：官方 v2.0.24 + Linux/WSL2 + 本地 mock。
- MIT，见 [LICENSE](LICENSE)。
