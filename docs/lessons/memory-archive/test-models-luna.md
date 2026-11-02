# test-models-luna

> 模型按任务自选（含 Haiku 5.5、Sonnet 5.5），不再固定用 Luna（类型 feedback）

2026-10-29 用户先要求「测试模型都用 luna」，随后改口：「忘掉 luna，你该用啥用啥，包括可以用 haiku5.5 和 sonnet5.5」。

**Why:** 用户在意 token 消耗，但不想被单一模型绑死；希望我按任务难度自己挑。

**How to apply:** 实测时新建的 agent/bot、修测试、排查日志这类轻活，选便宜够用的模型（如 Haiku 5.5、Sonnet 5.5、或 Codex 的较小模型）；写新功能等重活仍按全局约定交 Codex gpt-6.1-terra（10-29 起）。不要默认用最贵的模型（如 Opus）做实测。相关：[[upstream-first-qoder-cli]]、[[real-ui-acceptance]]
