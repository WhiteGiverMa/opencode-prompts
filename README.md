# opencode-prompts

[English](README.en.md) | 简体中文

给 [OpenCode](https://github.com/anomalyco/opencode) v2 用的 MIT 提示词插件：让已有的原生角色使用你自己写的一份完整提示词，并按模型选择模板和槽位。

- 不预设角色集合，不附带任何角色的行为正文。定义文件里的 agent ID 必须是你自己配置里已有的角色。
- 被管理的角色使用你的正文；移出定义、禁用或卸载后恢复该角色原有配置，包括原先的 `system`，不强制换成厂商模板。
- 定义、模板、槽位文件的改动，下一次请求生效。不用重新构建，也不重启服务。
- 渲染失败不会静默回退到原生提示词，而是拦住这条消息，并把原因写进结构化日志。

源码仓库：[WhiteGiverMa/opencode-prompts](https://github.com/WhiteGiverMa/opencode-prompts)。当前版本 0.1.0，尚未发布到 npm、没有部署到生产环境。端到端验证覆盖官方 OpenCode v2.0.24 + Linux/WSL2 + 本地 mock 供应商，详见[验证范围](#验证范围)。

## 安装

前置：Bun；官方 OpenCode v2（验证版本 2.0.24）。

```bash
cd /path/to/opencode-prompts
bun install --frozen-lockfile
bun run build
```

构建生成 `dist/`。仓库根目录的 `server.js` 只是再导出 `dist/server.js` 的入口。然后把插件以**目录**形式加进 OpenCode v2 配置：

```jsonc
// opencode.json（v2）
{
  "plugins": [
    {
      "package": "/绝对路径/到/opencode-prompts",
      "options": {
        "definition": "/绝对路径/到/我的提示词.jsonc"
      }
    }
  ]
}
```

要点：

- `package` 指向仓库根**目录**，不要指向单个文件。v2 通过包入口加载，根 `server.js` 再导出 `dist/server.js`。
- 插件不注册角色：你原有的 `agents` 配置、`default_agent`、权限和模型偏好保持原样。定义里的 agent ID 只是"接管名单"。
- 修完 `plugins` 配置，宿主会自己重载插件（实测 1 秒级检查、最长约 20 秒收敛，不用重启宿主进程）。首次安装时重启一次 OpenCode 最稳妥。
- 不要为了这个插件去全局安装，也不要覆盖或改造 v1 环境。

### 模块选项

| 选项 | 必填 | 含义 |
| --- | --- | --- |
| `definition` | 是 | 定义文件的路径。相对路径从**当前项目目录**算起，支持 `~` 前缀。 |
| `logFile` | 否 | 诊断日志路径。相对路径同上；默认写在定义文件同目录的 `opencode-prompts.log`。 |
| `enabled` | 否 | 默认 `true`。设为 `false` 时不读定义、不注册任何钩子，等同未启用。 |

注意两套相对路径不一样：模块选项从**当前项目**算起；定义文件里 `template` 和 `slots` 的 `file` 从**定义文件所在目录**算起（同样支持 `~` 和绝对路径）。

启用时未知选项会报错，例如 `enabeld` 不会被当成 `enabled`。日志路径不能与定义、模板或槽位文件重合，包括符号链接/硬链接别名；发生冲突时只向 stderr 记录并阻断，不修改输入文件。

## 快速冒烟

1. 按上面构建并写好配置，重启 OpenCode v2。
2. 用被管理的角色随便发一句话。
3. 打开 `opencode-prompts.log`，应出现 `"phase":"admission","code":"ok"`。
4. 改一行模板文件，再发一句：新正文立即生效，不用重启。
5. 把 `enabled` 设为 `false` 或移除 `plugins` 条目：该角色恢复原生正文。

## 定义文件

完整可跑示例在 [`examples/prompts.jsonc`](examples/prompts.jsonc)，字段骨架：

```jsonc
{
  "version": 1,                       // 可选，出现时只能是数字 1
  "$schema": "../schema.json",        // 可选，只要求非空字符串
  "agents": {
    "build": {                        // 必须是已有的原生角色 ID
      "template": "正文……",           // 字符串，或 { "file": "模板路径" }
      "slots": {
        "名字": "内联字符串",          // 也可以 { "file": "…" }
        "运行数据": { "runtime": "agent" } // 或 "model" / "tools"
      },
      "allowRepeatedSlots": false,    // 可选，默认 false
      "rules": [
        {
          "models": ["openai/gpt-*"], // 必填，至少一项
          "excludeModels": ["openai/gpt-3*"],
          "template": { "file": "templates/gpt.md" },
          "slots": { "名字": "换成这个" }
        }
      ]
    }
  }
}
```

- `agents` 的键是原生角色 ID。插件不会创建角色，也不会改权限或默认模型。定义里写了一个宿主中不存在的角色时，该角色的消息会被拦住并记 `agent-missing`。
- 一个 policy 只认识 `template`、`slots`、`allowRepeatedSlots`、`rules`；一条 rule 只认识 `models`、`excludeModels`、`template`、`slots`、`allowRepeatedSlots`。多写字段直接报 `definition-shape`，不会静默忽略。
- `template`：内联字符串或 `{ "file": "…" }`。省略默认模板时，必须有匹配的 rule 提供模板，否则该次请求报 `template-missing`。
- `slots`：自定义名字的渲染位置。名字非空，不能包含空白、`{`、`}`、`:`。三种来源：
  - 字符串：直接内联；
  - `{ "file": "…" }`：读取该文件（UTF-8）；
  - `{ "runtime": "agent" | "model" | "tools" }`：插入宿主给的原始数据。字符串原样，其它值按 2 空格缩进的 JSON 输出。
- `rules` 按数组顺序匹配，能匹配的都生效，后面的覆盖前面的字段。`slots` 是**按名字合并**：后面规则只覆盖它写到的名字，其余槽位保持原样。
- `models` 模式对完整的 `providerID/modelID` 做锚定、大小写敏感的 glob 匹配，`*` 和 `?` 也能跨过 `/`。例如 `openai/gpt-*` 匹配 `openai/gpt-5`，`openai/*` 匹配 `openai` 下的所有模型，`*/gpt-4o` 匹配任意供应商的 `gpt-4o`。没有"家族"推断，全按字面模式；`excludeModels` 里任一模式命中就跳过整条规则。
- 最终模板里，每个声明过的槽位必须恰好出现一次：`{{名字}}` 表示使用，`{{名字:omit}}` 表示显式省略。重复使用同一槽位要 `allowRepeatedSlots: true`；`{{名字:omit}}` 本身不能重复；同一个槽位不能又用又 omit；模板引用未声明的名字报 `slot-unknown`；空名字或未知修饰符（只支持 `:omit`）报 `template-parse`。
- `{{名字:omit}}` 的槽位不会读取它的来源文件。`\{{` 转义成字面量 `{{`。
- 插入的槽位内容只做字符串拼接，不会被当成模板再解析一遍：内容里的 `{{……}}`、`$&` 之类都按原样保留。
- 定义文件用 JSONC：支持注释和尾逗号。

也可以完全不启动 OpenCode，直接用编译核心自检定义和渲染结果：

```bash
node --input-type=module -e "
import { loadDefinition, preparePrompt } from './dist/core.js';
const file = './examples/prompts.jsonc';
const def = loadDefinition(file);
const prepared = preparePrompt(def, file, 'assistant', 'openai/gpt-5');
console.log(prepared.render({ agent: 'assistant', model: { providerID: 'openai', id: 'gpt-5' }, tools: {} }));
"
```

这是模板选择与渲染的预览；自检里的 `tools: {}` 不是实际工具目录。运行时数据以宿主为准。把模型换成 `anthropic/claude-sonnet-4-6` 可以看到默认模板。

## 生效时机

- 定义、模板、槽位文件：下一次消息生效，不构建、不重启。
- 定义里的角色增删：角色从定义移除后，下一次发消息时恢复原生正文并记 `restored`；新加入的角色在下一次发消息时被接管。
- 插件的种子替换发生在"准入"阶段，也就是你要先用那个角色发一条消息，它才会被改到。
- 插件挂载后先只注册准入与上下文钩子；真正写种子的 `agent.transform` 在第一次有角色被接管时才注册，避免抢在原生配置构建之前动角色。
- 启动时定义就是坏的：准入钩子照常挂着，每次发送都会被拦住并记日志；把定义修好后，下一次发送即恢复，同一会话可用。
- 普通主/子代理的每次请求都会重新读取定义并渲染，不会复用上一次的渲染结果。

## 出错怎么查

默认日志是定义文件同目录的 `opencode-prompts.log`，每行一条 JSON（JSONL）。`logFile` 可以改路径。模块选项本身写错（比如没写 `definition`）时，日志只能写到服务端 stderr，因为这时还不知道日志文件在哪。

每行至少有 `ts`、`phase`、`code`、`hint`；能确定时还会带 `session`、`agent`、`model`、`file`、`slot`、`count`、`locations`（行列号）。日志只写路径、槽位名、错误码、计数和位置，不写提示词正文、槽位内容、文件内容或凭据。

`phase` 的四种取值：

| phase | 含义 |
| --- | --- |
| `startup` | 插件启动时加载定义的结果。 |
| `admission` | 一次消息尝试准入：解析角色和模型、校验定义、准备种子。失败会拦住这条消息，模型不会被调用，会话里也不会留下这条用户消息。 |
| `context` | 一次实际模型请求前的重新渲染。 |
| `cleanup` | 禁用或卸载时的清理。 |

`code` 为 `ok`、`unmanaged`、`restored` 时是正常信息，其余都需要处理：

| code | 含义与处理 |
| --- | --- |
| `options-invalid` | 模块选项不对：检查必填 `definition`、选项拼写和类型，并确认 `logFile` 没有指向任何输入文件。修正插件 options 后等待宿主重载。 |
| `definition-read`、`template-file`、`slot-file` | 路径不存在或读不了。看日志里的 `file` 字段，检查路径与权限。 |
| `definition-json` | JSONC 语法错误。按 `locations` 的行列号修。 |
| `definition-shape` | 字段形状不对：未知字段、类型错误、空字符串等。对照 `schema.json`。 |
| `template-missing` | 该模型没有任何匹配规则提供模板。补默认 `template` 或补 rule。 |
| `template-parse` | 占位符语法错：空名字、未知修饰符、`{{` 没闭合。 |
| `slot-unknown`、`slot-missing`、`slot-repeated`、`slot-omit-repeated`、`slot-conflict` | 槽位和模板对不上：未声明、没引用、重复使用（未开 `allowRepeatedSlots`）、重复 omit、又用又 omit。按 `hint` 改模板或 `slots`。 |
| `slot-value`、`runtime-value` | 使用中的槽位没有可用值。通常是内部前置条件失效，或运行数据没拿到。 |
| `agent-missing`、`agent-unresolved`、`model-unresolved` | 角色在宿主里不存在，或者会话没有角色/模型且宿主给不出默认值。检查原生配置。 |
| `tools-unavailable` | 有工具的输入 schema 转不成普通 JSON，`tools` 槽位在准入时渲染不出来。禁用该工具，或去掉 `tools` 槽位。 |
| `seed-missing`、`unmanaged-marked`、`region-missing`、`region-duplicate`、`region-malformed` | 种子或插件标记区域状态不对。再发一次消息重试；`region-duplicate` 说明正文里出现了重复的插件标记。 |
| `unexpected` | 插件表面之外的问题，看 OpenCode 服务端日志。 |

定义、模板或槽位内容修好后直接再发一条消息即可：每次准入都会重新读取，同一会话不需要重建或重启。插件 options 的拼写、类型或日志冲突则应修正 OpenCode 配置，等待插件重载。

界面里可能出现宿主自带的"发送失败"提示。那是原生的通用失败通知，插件不提供自定义 toast 或弹窗，排查看日志。

## 禁用与回滚

插件不改你的项目源码，也不改你的 OpenCode 配置；它只会往定义文件同目录（或 `logFile` 指定处）追加诊断日志。回滚就是撤掉引用：

1. 先等在途的这一轮对话跑完。禁用或卸载只影响之后的请求，不会取消已经在跑的任务；已经准入的那一帧也不会被重写。
2. 三选一：
   - 把模块选项 `enabled` 设为 `false`；
   - 从 `plugins` 数组移除这个条目；
   - 只想回滚某个角色：把该角色从定义的 `agents` 里删掉，其余角色继续被管理。
3. 对应角色在下一次发消息时恢复原生正文。角色移除的日志是 `restored`；禁用或卸载是对应实例的 `cleanup`。
4. 想彻底清掉：删除配置条目和仓库目录即可。

禁用、移除条目、重新加回这三种切换都在 QA 里验证过。

## 验证范围

- 宿主：官方、未打补丁的 OpenCode **v2.0.24**。配置形态按 v2 的 `plugins: [{ package, options }]`。更早或更新的版本没有验证。
- 平台：Linux/WSL2。Windows 没有 QA。
- 供应商：本地回环 mock，请求与响应都是合成数据。没有做过真实模型的指令遵从、缓存命中或跨供应商行为验证。
- 26 个用例全部通过，详见 `.omo/evidence/native-v2-2.0.24.json`：启动坏定义拦截与修复、原生角色透传、完整替换与保留宿主/其它插件的系统段落、默认角色与模型解析、按模型切模板和槽位、重复槽位 opt-in、热改模板与槽位、每请求重渲染、原生子代理继承模型、六类坏定义拦截且不泄漏正文、移出定义恢复、禁用/卸载/重加、并发会话与跨项目隔离，以及日志与定义/模板冲突、错误选项拼写的阻断和恢复。
- 复跑 QA：`node qa/native-v2.mjs`。默认使用 `$HOME/.local/opt/opencode-v2/2.0.24` 下的官方二进制，可用 `OPENCODE_V2_BINARY=/path/to/opencode2` 覆盖；它在隔离的 HOME、配置、数据库和临时目录里启动宿主与 mock，不碰生产配置和 4097/4098 端口，报告写到 `.omo/evidence/native-v2-2.0.24.json`。详细报告含本机路径与合成会话标识，只在本地生成，不提交到 Git；仓库保留交付摘要和可复跑驱动。

关于后台辅助调用：标题生成、压缩、generate 这类宿主内部的辅助模型请求，不属于"每次对话都按你的定义渲染"的保证范围；实测里标题请求保持原生提示词。不要指望用定义去管理这些隐藏的维护角色。

## 例子与 schema

- [`examples/prompts.jsonc`](examples/prompts.jsonc)：可直接拷贝的定义。把 `assistant` 换成你实际用的角色 ID（例如 `build`），路径按需改。
- [`examples/templates/default.md`](examples/templates/default.md)、[`examples/templates/gpt.md`](examples/templates/gpt.md)：默认模板与 GPT 家族模板，含动态槽位和 `{{…:omit}}`。
- [`examples/slots/common.md`](examples/slots/common.md)：共享槽位文件。
- [`schema.json`](schema.json)：与解码器同构的 JSON Schema，可给编辑器做补全和校验。

## Provenance

同一工作区里另有一份 OMO（oh-my-openagent）LTS 的 legacy 提示词开关补丁：`../.omo/evidence/20261007-opencode-prompts/legacy-prompts-gates.patch`，位于本仓库之外。它和本 MIT 包相互独立，**没有应用、没有部署**。不要把其中的内容搬进本仓库。

## License

MIT，见 [LICENSE](LICENSE)。
