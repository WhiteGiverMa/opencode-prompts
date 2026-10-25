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

## 使用限制：重启后的自动恢复

接管后的角色正文由插件模板决定，**不要求**你在 OpenCode 的 `agents.<id>.system` 里重复填写提示词。省略该字段或设为 `""` 都是合法配置；宿主此时使用自带的默认提示词。但当前公开插件 API 没有提供可靠的正文归属信息，也没有在恢复请求选取角色前执行的 preflight 钩子，因此还不能完整支持以下自动恢复场景：

| 场景 | 当前行为 |
| --- | --- |
| 未被插件接管的角色 | 保持宿主行为，不受此限制影响 |
| 已接管角色收到新的普通用户消息 | 先执行 admission，再使用模板；原生 `system` 可以省略或为空 |
| 服务重启后自动恢复已接管角色，且原生 `system` 非空、在请求中能唯一精确匹配 | 自动重新 seed，日志记 `context/reseeded` |
| 自动恢复已接管角色，但原生 `system` 省略或为 `""` | 本次恢复请求可能报 `region-missing`，在发给模型前阻断 |
| 自动恢复时，其他钩子已改写、包裹或复制了无 marker 的原生正文，导致不能唯一精确匹配 | 同样保守阻断，不猜测应覆盖哪个 part |

这是**已知的恢复兼容性缺口，不是用户配置错误**。插件不会靠覆盖 `system[0]` 或保留默认正文再追加模板来绕过保护。其他插件新增的独立 part 会保留；已有有效 marker 时，marker 外的前后缀也会保留。

遇到该错误后，在同一会话**发送一条新的普通消息**，让 admission 重新建立 seed；仅等待、点击继续或重复 synthetic/resume 不保证恢复。若需要自动恢复，可在 OpenCode 配置中给受管理角色设置一段非空、适合插件禁用时使用的后备 `system`。它不是模板正文，也不必复制模板内容；这是当前版本的绕行办法，并且仍受上述其他钩子改写限制影响。`system: ""` 不表示完全没有 system。

### 热重载

插件自己被 OpenCode 热重载时，宿主可能保留上一世代的完整 marker，或没有把新世代的 transform 写回注册表。现在 `context` 会直接接管旧世代遗留的 owned region，日志记 `seed-deferred`，请求继续；只有外来、重复、乱序或被改写的 marker 才会阻断。`agent.transform` 因此退化为尽力同步注册表，实际请求正文由 context 保证。

本项目目前不修改宿主、不放宽归属检查；完整支持等待宿主提供可靠的 preflight 或正文归属接口。复现、证据与接口缺口见 [已知问题记录](docs/known-issue-region-missing-after-restart.md)。

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
- 重启恢复 QA：`node qa/restart-resume.mjs`，在隔离的 `serve --service` 中途 SIGKILL 两个共享角色、使用不同模型的会话。默认验证非空原生 system 和独立 neighbor part 的恢复；`QA_SYSTEM_MODE=omitted` / `empty` 复现已知缺口，`QA_NEIGHBOR_MODE=wrapped` 复现恢复前正文被包裹的限制。这些缺口用例当前预期以非零状态退出，不代表已修复。可用 `OPENCODE_V2_BINARY` 指定宿主二进制。
- 热重载 QA：`node qa/hot-reload.mjs`（默认修改插件产物触发）或 `QA_RELOAD_MODE=config node qa/hot-reload.mjs`（写配置新增插件触发），在隔离 `serve --service` 的在飞回合中热重载插件，验证旧世代 region 被接管、没有 `seed-missing`。
- 验证环境：官方 v2.0.24 + Linux/WSL2 + 本地 mock。
- MIT，见 [LICENSE](LICENSE)。
