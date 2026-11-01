# 模型组设计

> 需求：模型选择器新增「模型组」，与 codex、claude、opencode 平级；组内按序号排序的 (provider, 模型) 列表；所有选模型处可选单个模型或模型组；选组后按序号从上到下使用，额度用完或不可用时顺延下一个。

## 数据

`daemon.modelGroups`（`config.json`，与 `daemon.agentProfiles` 同路径接入 persisted-config、MutableDaemonConfig、daemon-config-store、`useDaemonConfig`）：

    ModelGroup = { id: string, name: string, entries: { order: number, provider: string, model: string, thinkingOptionId?: string }[] }

`order` 可由用户改，读取与解析时按 `order` 升序（相同序号保持存储顺序）。新字段全可选，遵守协议向后兼容；客户端按 `server_info.features` 门控编辑入口。

## 选择表示

选择器中用一个合成 provider `modelgroup`（标签「模型组」），每个组一行：`provider="modelgroup"`, `modelId=<groupId>`。因此 `provider/model` 字符串、已有 `parseProviderModel`、定时任务、MCP 创建参数都无需新格式。参考 `new-workspace-screen.tsx` 的 `DEFAULT_MODEL_OPTION` 合成行。

## 解析（创建时）

在 `createAgentCommand`（`kind:"session"` 与 `kind:"mcp"` 两条解析路径入口）把 `modelgroup/<id>` 展开成第一个可用条目：`getProviderAvailability` 为可用，且 `provider usage` 窗口 `remainingPct` 不为 0（有数据时）。展开发生在 `resolveCreateConfig` 与 `agent.create` 钩子之前，下游只见具体 provider/model。落库的是具体 provider/model，并给 agent 打标签 `paseo.model-group=<id>` 与 `paseo.model-group-order=<序号>`。所有条目都不可用时报错并列出每项原因。

## 运行中顺延

订阅 `turn_failed`：错误文本命中额度/限流/过载/模型不可用正则（集中在一个模块、有单测），且 agent 带 `paseo.model-group` 标签时，选组内下一个可用条目：同 provider 用现有改模型能力；跨 provider 则在同 workspace 新建后继 agent 并转交失败的那条用户消息，原 agent 留作历史，时间线写系统提示。组内耗尽时停止并显示原错误。

## 客户端

- `provider-selection.ts` 增加 `buildModelGroupProvider(groups)`，在 `use-agent-form-state.ts`、`agent-controls/index.tsx`、`schedule-form-model.ts`、`metadata-generation-page.tsx`、`plugins/react-native/model-picker-field.tsx`、命令中心的 providers 构造处并入（经 `useDaemonConfig`）。
- 编辑界面：设置页新增「模型组」，参照 `agent-profiles/settings/`：组名可改，条目行有可编辑序号 + 模型选择（复用 `CombinedModelSelector`，传入的 providers 不含 `modelgroup`，即「不显示模型组」）。
- 模型组选择器自身里条目选择器不显示模型组，避免递归。
- 已创建会话可选择模型组；首个条目的 provider 与会话不同时禁用该组。选择时解析首个可用条目并保存组标签，以便后续顺延。
