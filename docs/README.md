# Docs index

`docs/` is the source of truth for system-level and process-level knowledge. Moved out of the root `AGENTS.md` on 2026-11-02 to keep that file short. Project lessons are in [lessons/](lessons/).

| Doc                                                             | What's in it                                                                                                                   |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| [docs/product.md](product.md)                                   | What Paseo is, who it's for, where it's going                                                                                  |
| [docs/vibe/ROUND5-DESIGN.md](vibe/ROUND5-DESIGN.md)             | 第五轮原生任务会话、方案确认、最小离线首消息与 WP-114 最终切换                                                                 |
| [docs/vibe/ROUND8-DESIGN.md](vibe/ROUND8-DESIGN.md)             | 第八轮：#1 即群聊、方案多模型互审、共享探路、任务间方案感知                                                                    |
| [docs/vibe/ROUND9-DESIGN.md](vibe/ROUND9-DESIGN.md)             | 第九轮：离线首消息默认模型、本机模型缓存与任务默认模型设置                                                                     |
| [docs/vibe/ROUND10-DESIGN.md](vibe/ROUND10-DESIGN.md)           | 第十轮：bot（多总 bot/多项目 bot、自配置、记忆、例程、旁线程、可视化回复）与 openbot 风格界面分包                              |
| [docs/vibe/HUB-DESIGN.md](vibe/HUB-DESIGN.md)                   | 资源中枢（调度器与 win-heavy-guard 合并的规则准入）、全局指令、总协调 bot 与 bot 间消息                                        |
| [docs/vibe/ENGINEERING-LESSONS.md](vibe/ENGINEERING-LESSONS.md) | WP-136 至 153 提炼的工程经验：测试与构建环境、插件与宿主 API、Windows 陷阱、性能诊断、UI 验收、流程                            |
| [docs/architecture.md](architecture.md)                         | System design, package layering, WebSocket protocol, agent lifecycle, data flow                                                |
| [docs/agent-lifecycle.md](agent-lifecycle.md)                   | Agent states, parent/child relationships, archive semantics, tabs vs archive, subagents track                                  |
| [docs/data-model.md](data-model.md)                             | File-based JSON persistence, Zod schemas, atomic writes, no migrations                                                         |
| [docs/glossary.md](glossary.md)                                 | Authoritative terminology — UI label wins, no synonyms                                                                         |
| [docs/coding-standards.md](coding-standards.md)                 | Type hygiene, error handling, state design, React patterns, file organization                                                  |
| [docs/design.md](design.md)                                     | Design system — tokens, buttons, hierarchy, density, alignment rails, states, what's forbidden                                 |
| [docs/forms.md](forms.md)                                       | Form architecture — non-React form model, form kit, load-state gating; the schedule form is the golden example                 |
| [docs/hover.md](hover.md)                                       | Hover — the canonical pattern (plain View + onPointerEnter/Leave, separate inner Pressable) and the three ways agents break it |
| [docs/unistyles.md](unistyles.md)                               | Unistyles gotchas — `useUnistyles()` is forbidden, alternatives in order                                                       |
| [docs/floating-panels.md](floating-panels.md)                   | Anchored popovers — Portal/Modal escape for Android, lifecycle gates, keyboard-shared-value, status-bar offset, the flash      |
| [docs/menus.md](menus.md)                                       | The menu engine — popover vs sheet, submenu pages, hover intent, when a decision earns a submenu                               |
| [docs/expo-router.md](expo-router.md)                           | Expo Router route ownership, startup restore, and native blank-screen gotchas                                                  |
| [docs/notifications.md](notifications.md)                       | Notification tap ownership, native replay and acknowledgement, startup handoff, and payload QA                                 |
| [docs/file-icons.md](file-icons.md)                             | Material icon theme integration for the file explorer                                                                          |
| [docs/providers.md](providers.md)                               | Adding a new agent provider end-to-end                                                                                         |
| [docs/forge-providers.md](forge-providers.md)                   | Adding a git forge: registry/manifest, drop-in checklist, self-host/GHES, the two facts tiers                                  |
| [docs/custom-providers.md](custom-providers.md)                 | Custom provider config: Z.AI, Alibaba/Qwen, ACP agents, profiles, custom binaries                                              |
| [docs/plugins.md](plugins.md)                                   | Local plugin manifest, directory source config, RPCs, native surfaces, and attachment sources                                  |
| [docs/website-i18n.md](website-i18n.md)                         | Website languages: locale URLs, translated Markdown pairs, `{#id}` anchors, Chinese style                                      |
| [docs/service-proxy.md](service-proxy.md)                       | Service proxy: exposing workspace scripts at public URLs, DNS setup, reverse proxy config                                      |
| [docs/relay-endpoint-security.md](relay-endpoint-security.md)   | Relay E2EE modes: Noise NK mapping, record framing, negotiation, the `requireProtectedSecurity` flag, close codes              |
| [docs/development.md](development.md)                           | Dev server, build sync gotchas, CLI reference, agent state, Playwright MCP                                                     |
| [docs/rpc-namespacing.md](rpc-namespacing.md)                   | WebSocket RPC naming convention — dotted namespaces and `.request`/`.response` pairs                                           |
| [docs/protocol-compatibility.md](protocol-compatibility.md)     | Why app/daemon versions drift, protocol vs feature contract, capability gating, COMPAT tagging                                 |
| [docs/protocol-validation.md](protocol-validation.md)           | zod-aot generated inbound WebSocket validation, patched compiler regressions, schema-purity rules                              |
| [docs/connected-hosts.md](connected-hosts.md)                   | Daemon-owned host registrations, routed SDK scopes, identity and authority boundaries                                          |
| [docs/permissions.md](permissions.md)                           | Semantic daemon permissions, principals, credentials, pairing invitations, and Hub authority                                   |
| [docs/terminal-performance.md](terminal-performance.md)         | Terminal latency pipeline, coalescing/backpressure invariants, benchmark + perf spec usage                                     |
| [docs/agent-stream-performance.md](agent-stream-performance.md) | Assistant text pipeline — coalescing window, paced reveal, why arrival lumps are smoothed at render                            |
| [docs/markdown-renderer.md](markdown-renderer.md)               | Shared Markdown engine, native selection, links, images and library constraints                                                |
| [docs/native-text-selection.md](native-text-selection.md)       | Native diagram grouping, selection boundaries and leading inline image limitations                                             |
| [docs/file-observation.md](file-observation.md)                 | Recursive watcher ownership, Linux constraints, teardown invariants, and Parcel comparison                                     |
| [docs/testing.md](testing.md)                                   | TDD workflow, determinism, real dependencies over mocks, test organization                                                     |
| [docs/qa.md](qa.md)                                             | QA evidence bar for pull requests — platform matrix, version drift, performance, UI proof                                      |
| [docs/mobile-testing.md](mobile-testing.md)                     | Maestro and mobile test workflows                                                                                              |
| [docs/mobile-panels.md](mobile-panels.md)                       | Compact left/center/right panel ownership, worklet motion, gesture revisions, and Fabric constraints                           |
| [docs/explorer-sidebar.md](explorer-sidebar.md)                 | Explorer sidebar, side-pane, and compact workspace sheet host contracts, lifecycle, placement, routing preferences             |
| [docs/ad-hoc-daemon-testing.md](ad-hoc-daemon-testing.md)       | Isolated in-process daemon test harness                                                                                        |
| [docs/browser-capture-harness.md](browser-capture-harness.md)   | Real-Electron browser screenshot harness and compositor-surface gotcha                                                         |
| [docs/android.md](android.md)                                   | App variants, local/cloud builds, EAS workflows, version codes, F-Droid source builds and store metadata                       |
| [docs/docker.md](docker.md)                                     | Running the daemon and bundled web UI in Docker, volumes, agent images, security                                               |
| [docs/release.md](release.md)                                   | Release playbook, draft releases, completion checklist                                                                         |
| [docs/terminal-activity.md](terminal-activity.md)               | Terminal activity indicators — source-agnostic tracker, agent hook reporting, adding a new hook provider                       |
| [SECURITY.md](../SECURITY.md)                                   | Relay threat model, E2E encryption, DNS rebinding, agent auth                                                                  |
| [public-docs/hub/security.md](../public-docs/hub/security.md)   | Public Hub guide — trust boundaries, untrusted triggers, provider controls, and output authority                               |

## Writing docs

- **Integrate, don't append.** Find the doc that owns the subject and rewrite the part that is now wrong. The standard failure is finishing a task and adding a paragraph to the bottom of the closest-looking doc; ten tasks later the doc is a pile of paragraphs in discovery order. `docs/custom-providers.md` is what that looks like.
- **Don't document logic.** Prose that restates code drifts from the code and loses. Write down what the code can't tell you: why something is shaped the way it is, the gotcha that cost an afternoon, conventions nothing enforces, constraints that span packages or versions. If a reader could get it in two minutes by opening the file, cut it.
- **One fact, one doc.** Every other mention is a link. If you are about to write the same paragraph in two docs, one of them is a link.
- **Respect the layers.** `CONTRIBUTING.md` and this file name things and link out. Activity docs like `docs/qa.md` and `docs/testing.md` set the bar for a kind of work. Subject docs like `docs/unistyles.md` own one thing completely. A layer never re-explains the one below it.
- **One subject per doc.** If the subject doesn't fit in a sentence, split the doc. A section per provider, vendor, or platform is a table plus one worked example.
- **Delete.** Obsolete sections go. Prefer a `packages/app/src/thing.ts:120` reference over a pasted block.
- **New doc?** Add a row to the table above and link it from the docs that should send readers there.
- Code-level facts belong in comments next to the code, not here.

## Doc voice

Plain and short. Second person. State the rule, then the reason when the reason isn't obvious. Match the doc you're editing.

Do not:

- Write a sentence to land a point. "It's not X, it's Y", "That's not a Z, that's a W", and every other setup-and-punchline shape.
- Add a clause that only asserts importance: "and that matters", "which is what keeps it working", "this is critical".
- Use "honest", "robust", "seamless", "powerful", "simply", "just", "delightful".
- Restate something you already said, in different words, for emphasis.
- Hedge with "generally", "typically", or "you may want to" when the answer is "do this".
- Clear your throat: "It's worth noting that", "In order to", "This section covers".
