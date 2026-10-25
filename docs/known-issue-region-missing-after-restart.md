# Known Issue: region-missing on first request after server restart

> 状态：重启恢复部分修复，热重载 seed 接管已补齐（2026-10-25）；剩余缺口作为使用限制保留，暂不修改宿主
> 影响面：修复前服务重启/插件热重载后的首个恢复请求可能被阻断一次；热重载路径现在由 context 直接接管旧世代 region。

## 现象

OpenCode 服务重启并自动恢复会话后，该会话的第一个请求失败：

```
Session failed
opencode-prompts blocked this request [region-missing]; diagnostics: <...>\opencode-prompts.log
```

前端表现为 502。约 1 分钟后同一会话重新 admission 成功，后续请求全部正常。

## 日志证据（Windows 部署，opencode-prompts.log）

本地 Windows 部署曾三次观察到相同模式：`cleanup/startup ok` 之后第一个 `context` 阶段即报 `region-missing`，随后新的普通消息触发 `admission ok` → `context ok`。原始诊断记录只保留在本地，不公开会话标识、模型选择和部署路径。

以下仅整理阶段顺序，已省略实际时间与请求标识：

```
cleanup   ok
startup   ok（definition 加载成功）
context   region-missing  slot=system count=0   ← 阻断
admission ok count=1                           ← 新的普通消息重新 seed
context   ok
```

## 根因（已核实源码）

重启恢复走的不是普通用户 prompt：

- `packages/core/src/session/execution/restart.ts` 的 `prepareResume` 发布 `SessionEvent.Synthetic`（“The server restarted while you were working…”），然后调用 `execution.resume`。
- 该路径不经过 `SessionPrompt.prepare`，而 `session.prompt` 钩子只在 `packages/core/src/session/prompt.ts` 里触发。
- 恢复后的第一个模型请求仍然触发 `session.context`。插件进程刚重启，`seeds` 是空的内存 Map，宿主 agent system 是配置里的原生文本，不含任何 marker。
- 原实现中，`src/markers.ts` 的 `replaceOwnedRegion` 在 marker 命名空间为 0 时抛 `regionFailure('region-missing', 0)`，请求被阻断。这是「宁可阻断也不静默写错位置」的保护设计。
- 用户随后手动重发消息，走了正常 `session.prompt` → admission 重新 seed → 成功，所以表现为“阻断一次后自愈”。

补充：`SessionModelRequest.baseTranscript` 把 system 构造成 `[agent.system ? agent.system : 宿主默认提示词, initial]`，所以省略和空字符串都使用默认提示词。context 钩子拿到的是可变数组，钩子内替换 part 文本会直接进入本次 LLM 请求。

## 修复

`agents.<id>.system` 不是模板接管的先决条件。省略或设为空字符串都是宿主支持的合法用法；接管后的角色正文由模板提供。下面的第一轮恢复实现只修复了非空原生 system 的场景，不能作为整个问题已经解决的依据。

### 第一轮实现与已确认缺口

方向选**context 降级 reseed**，不依赖恢复路径的钩子顺序。

- `replaceOwnedRegion` 在 `namespace === 0` 时返回 `'missing'`，不再抛错；重复、乱序、被篡改的 marker 仍然抛 `region-malformed` / `region-duplicate`，严格防呆不变。
- 每个 agent 在本次激活第一次接管前捕获一份原生 system 快照（`nativeFor`，同一 agent 的并发调用共享同一个 capture Promise）。admission 和 context 恢复都从这份快照取原生文本，不再在恢复时临时读已经被 seed 的注册表。
- context 遇到 `'missing'` 时：
  1. 取该 agent 的接管前原生快照；
  2. 构造本请求的 seed；
  3. 用 `seedNativeRegion` 把本次 `event.system` 里唯一匹配的原生 part 换成 seed；原生文本为空、缺失或出现多次都视为不可判定，直接 fail-closed；
  4. 用与 admission 相同的 `seedAgent` 路径先严格校验 seed，再写入 `seeds`、注册 transform、reload 并校验 `hasOwnedRegion`（现在要求整个 system 恰好只有两个 marker token）。模板正文混入保留 token 会在写 seed map 和宿主注册表前失败，抛错的 hook 不会把已修改的本次请求发给模型；
  5. 记录 `{"phase":"context","code":"reseeded"}`，本次请求继续。
- admission 与 context 恢复共用 `seedAgent`，避免两条路径的校验逻辑分叉。

### 默认/空 system 的缺口回归

- `qa/restart-resume.mjs` 支持 `QA_SYSTEM_MODE=configured|omitted|empty` 和 `QA_NEIGHBOR_MODE=parts|wrapped`；两个恢复会话共享同一角色，分别使用 GPT/Kimi 模型规则。`parts` 添加两个独立 GUARD part 和尾部指令，`wrapped` 还在角色正文外包裹前后缀。默认 `configured + parts` 用于验证已支持路径；其余缺口模式保留为失败复现，不能视为通过。
- 修复前实测：v2.0.26 的 `omitted` 和 `empty` 均在自动恢复阶段报 `region-missing`；v2.1.2 的 `omitted` 同样失败，`configured` 成功。
- `test/runtime.test.ts` 已把默认 system fixture 改为真实的非空宿主正文，并加入省略/空值恢复应成功的红灯回归。这是插件的生命周期缺陷，不是需要用户补写原生 system 的配置错误。

### 当前处置与使用建议

- 当前将接口缺口记为插件使用限制，不修改 OpenCode 宿主、不使用私有导入或对象劫持、不覆盖未知 part，也不把默认正文和模板叠加后冒充完整替换。
- 省略/空值的两条“恢复应成功”回归保留，不删除、不改成预期抛错来制造全绿。当前测试状态为 **97 pass / 2 fail**；失败的就是这两条尚未支持的恢复用例。原生 system 省略或为空本身仍是合法配置。
- 遇到 `region-missing` 后，在同一会话发送一条新的普通用户消息以触发 admission；不能保证只等待或重复 resume 就恢复。
- 需要自动恢复时，可配置非空且适合插件禁用时使用的后备 `agents.<id>.system`，不必重复模板内容。它只是绕行办法，不改变模板负责正文的契约；如果更早钩子改写或复制了它，恢复仍可能阻断。
- 中英文 README 已公开说明适用范围和绕行方式；当前生产产物保持第一轮部署版本，不因本次文档变更重建或重载服务。
- 限制收尾实测（v2.1.2，真实隔离宿主 + mock 供应商）：`configured + parts` 的双模型会话恢复成功，`reseeded=2`、`admission=0`、两个邻接 GUARD 及尾部指令保留；`omitted + parts`、`empty + parts`、`configured + wrapped` 均在自动恢复阶段报 `region-missing`，脚本以非零状态退出。后面三项是缺口复现证据，不是验收通过。

### 缺少的宿主能力（已提交上游 issue）

已核对公开 `@opencode/plugin` 2.0.24 声明以及 v2.1.2 对应源码：外部插件的 setup 早于内部 `ConfigAgentPlugin`，后者会把显式 `system: ""` 写回角色；而 context 钩子运行在默认正文生成以及更早钩子修改之后，拿到的只是没有来源信息的可变 part 数组。

例如同一组 `[GUARD, DEFAULT, INITIAL]`，既可能来自“新增独立 GUARD”，也可能来自“角色正文被改成 GUARD，再新增独立 DEFAULT”。没有归属信息时无法同时保证替换正文和保留独立指令。复制宿主默认模板或猜下标不能解决这个问题。

建议上游增加一个 **awaited primary-request preflight**：插件激活完成后、选取本次角色快照前执行，只需公开 `sessionID`，供插件先建立 owned seed，再由现有 context 用本请求的模型和工具渲染正文。候选接线位置为宿主 `packages/core/src/session/runner/llm.ts` 的 `prepareContext`、`context.select` 之前，公开类型涉及 `packages/plugin/src/{promise,effect}/session.ts`。已作为功能请求提交上游 [anomalyco/opencode#58572](https://github.com/anomalyco/opencode/issues/58572)（2026-10-24，提交前核实 dev `24b5ed8bcc` 路径仍在原位；相近 issue #57214 / #58390 / #56032 已在文中区分），不是当前可用 API；本轮没有实施宿主补丁。

## 第一轮验证记录（非当前全量通过声明）

- `bun run typecheck`、`bun run build` 干净；`bun test` 98 pass / 0 fail。
- 新增单测：有配置原生 system 的重启恢复、两个并发请求共享接管前快照、无配置/重复原生文本 fail-closed、模板正文混入保留 marker 在写状态前失败、seed 被后续 transform 破坏时拒绝、前置 part 保留。
- 新增活体回归 `qa/restart-resume.mjs`：真实 `opencode2 serve --service`（v2.0.26）+ mock provider，两个会话共享同一个 managed agent，各自对话中途 `SIGKILL`，重启后恢复：
  - 恢复请求 `admission` 记录为 0（证明走的是 synthetic 恢复路径）；
  - 日志出现 2 条 `context/reseeded`，没有 `region-missing`；
  - 每个恢复后的 system 保留更早注册 neighbor 钩子 prepend 的 GUARD part 与 tail，原生正文消失，恰好一个完整 marker 对；
  - 两个会话都返回正常 assistant 文本。
- 原有完整套件 `qa/native-v2.mjs` 在 v2.0.26 上 26/26 通过。
- 2.0.24 二进制在本机已不在原位，活体验证用 2.0.26；插件 peer 范围是 `>=2.0.24 <3`。

上述 98 pass / 0 fail 是第一轮实现的历史结果。加入合法省略/空 system 的恢复需求后，当前是 99 条中的 97 pass / 2 fail；不能引用旧结果声称缺口已修复。当前测试替身模拟宿主默认正文；隔离活体验证使用真实 OpenCode 进程和重启恢复、测试替身模型供应商；生产服务重启与真实远程模型验证没有执行。

## Windows 部署（2026-10-23）

- 已同步 24 个 `dist` 构建文件，逐文件 hash 与 WSL 产物一致；入口、package.json 和依赖未改。
- Windows OpenCode v2.1.2 记录新的 `cleanup/startup ok`，插件 API 显示 active，服务进程保持不变，没有重启服务。
- Windows 原生 Node v24.15.0 已从部署路径导入插件入口，并用隔离的临时定义和 synthetic host 驱动两个无 admission 的恢复 context，确认 `reseeded=2` 且邻接 part 保留。没有发送生产模型请求或主动重启生产服务；Windows 生产重启恢复仍未实测。
- 旧产物备份、部署路径、进程信息和完整收据只保留在 Git 忽略的本地证据目录，不随源码发布。

## 热重载 seed 接管（2026-10-25）

2026-10-25 的 live 故障补齐了同一生命周期的热重载分支：

- 写入配置触发全量插件重载后，`opencode-prompts.log` 没有出现新世代的 `cleanup/startup`，下一次在飞请求的 `context` 直接报 `seed-missing`，后续 admission 连续被阻断，直到服务重启。
- 根因不是 `agents.<id>.system` 为空：旧世代可能把完整的 owned region 留在宿主角色里，或新世代的 `agent.transform` 没有落盘；`seedAgent` 在 reload 后检查不到新世代 marker，于是抛 `seed-missing`。空/省略 system 走的是 `region-missing`，两者可区分。
- 修复把 context 渲染作为权威路径：
  - `classifyOwnedRegion` 区分 `current` / `stale` / `none` / `foreign`；
  - `replaceAnyOwnedRegion` 直接接管上一世代遗留的完整 marker 对，generation 只是内部标识；
  - `seedAgent` 在 reload 后只把 `stale` / `none` 记为 `deferred`，不再阻断请求；
  - admission 和 context 写 `seed-deferred` 日志后继续；`foreign`、重复、乱序或改写 marker 仍然 fail-closed。
- 验证：
  - 新增单测覆盖旧世代 marker 接管、admission defer、邻接 part 保留；当前 `99 pass / 2 fail`，失败的两条仍是既有的 omitted/empty 恢复缺口。
  - `qa/hot-reload.mjs` 在隔离 v2.1.2 上分别用「修改插件产物」和「写配置新增插件」触发热重载，均在在飞回合后 `reseeded` 成功。
  - live 构建触发的 11:21 热重载后没有 `seed-missing`；11:28 的 admission/context 均为 `ok`。
- 代价：`agent.transform` 现在只保证注册表尽力同步，请求正确性由 context 保证。这是热重载期间旧 transform 仍可能覆盖注册表时的必要降级；外来 marker 仍不会被猜测覆盖。

## 残余边界

- marker 存在但重复/乱序/被改写：仍然阻断，不会自愈。
- 只有被插件定义接管的角色才需要恢复 owned region；未接管的默认角色保持宿主行为，不会仅因没有原生 system 而触发 `region-missing`。被接管的角色没有配置原生 system（宿主使用默认提示词）时，插件拿不到可证明归属的 part 身份，恢复会 fail-closed。非空原生 system 只有在能唯一精确匹配时才支持恢复；完整覆盖省略/空值和任意更早钩子的组合，需要宿主补充可靠的接管时机或正文归属接口。
- 更早注册的 context 钩子如果 prepend 独立 part，恢复只替换精确匹配的原生 part，不会覆盖它；如果原生文本本身被改写或在多个 part 中重复，则 fail-closed。
- `session.compaction` / `session.generate` 有各自的钩子，不走 context reseed；它们不会因此被阻断，但也不会在这次修复中获得 seed 刷新。

## 关联

- 源码：`src/markers.ts`（`replaceOwnedRegion` / `seedNativeRegion`）、`src/runtime.ts`（`seedAgent` / context 恢复）、`src/server.ts`（钩子接线）
- 宿主源码：`packages/core/src/session/execution/restart.ts`、`packages/core/src/session/prompt.ts`、`packages/core/src/session/model-request.ts`
- 诊断日志：默认在定义文件旁的 `opencode-prompts.log`，也可用 `logFile` 指定。
- 活体回归脚本：`qa/restart-resume.mjs`；运行后生成的机器相关收据位于 Git 忽略的 `.omo/evidence/`。
