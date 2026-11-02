# situation-is-not-requirement

> When the user only describes how the UI currently looks, don't record or implement it as a requirement; ask whether it is wrong（类型 feedback，最后修改 2026-11-01T23:15:27.818Z）

On 2026-11-01 the user's earlier message described the bot right-panel tabs as showing only icons. It was recorded in PRODUCT-REQUIREMENTS.md as "bot 右侧面板 tab 仅显示图标" and implemented as an `iconOnly` mode. The user later said this "从来不是需求": they had only described the situation and never said it was a problem or what they wanted; the tabs should have been icon+text like the task panel all along.

**Why:** a plain description of current behaviour can mean either "this is wrong" or "this is how it is". Treating it as a requested change added code and a false PRD entry that had to be reverted.

**How to apply:** when a message describes how something looks or behaves without saying it should change or is a defect, ask once (AskUserQuestion) before writing it into the PRD or coding it. Never invent a mode or flag from a description. See [[real-ui-acceptance]].
