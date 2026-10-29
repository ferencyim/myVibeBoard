# Design

The app uses an independently implemented visual foundation in `packages/app/src/styles/theme.ts`. Reference material supplies color and geometry values only. Keep our own components, Lucide icons and seed-based initial avatars; do not copy another product's code, artwork or identity assets.

## Theme and appearance

Use semantic roles rather than palette colors in product UI. The built-in dark theme uses a neutral canvas and blue accent. The light theme uses the desktop light values on Web, Electron and native. Existing theme choices, plugin themes, automatic system appearance, user font choices and size settings remain available. Do not add another appearance preference for this foundation.

`StyleSheet.create((theme) => ...)` owns reactive styles. Follow [Unistyles](unistyles.md); `useUnistyles()` is forbidden. Read style proxies at render time and preserve caller style arrays. Static token imports are for geometry and animation constants.

### Semantic colors

| Role                     | Token                                      | Dark                              | Light                             |
| ------------------------ | ------------------------------------------ | --------------------------------- | --------------------------------- |
| Canvas                   | `bgCanvas`                                 | `#1a1a1a`                         | `#f5f5f6`                         |
| Outer frame              | `bgFrame`                                  | `#0d0d0d`                         | `#e8e8eb`                         |
| Sidebar                  | `bgSidebar`                                | `#1a1a1a`                         | `#f5f5f6`                         |
| Menu / sheet             | `bgSheet`                                  | `#141414`                         | `#ffffff`                         |
| Sheet inset              | `bgSheetInset`                             | `#101010`                         | `#f0f0f2`                         |
| Group / surface          | `bgGrouped`, `bgSurface`                   | `#212121`                         | `#ffffff`                         |
| Raised surface           | `bgSurfaceRaised`                          | `#242424`                         | `#fcfcfc`                         |
| Control                  | `bgControl`                                | `#212121`                         | `#ffffff`                         |
| Control hover / active   | `bgControlHover`, `bgControlActive`        | `#242424` / `#2a2a2a`             | `#f0f0f2` / `#e8e8eb`             |
| Border / strong          | `border`, `borderStrong`                   | white 3.5% / 4.5%                 | ink 7% / 10%                      |
| Hover tint               | `hoverTint`                                | white 6%                          | ink 5%                            |
| Primary / secondary text | `textPrimary`, `textSecondary`             | `#ffffff` / `#dcdcdc`             | `#141414` / `#3a3a3c`             |
| Muted / dim text         | `textMuted`, `textDim`                     | `#979797` / `#6a6a6a`             | `#6b6b70` / `#8e8e93`             |
| Placeholder              | `textPlaceholder`                          | `#bfbfbf`                         | `#5c5c61`                         |
| Accent / hover / text    | `accent`, `accentHover`, `accentText`      | `#007cf7` / `#1f8fff` / `#42a0ff` | `#007cf7` / `#006ad4` / `#0064c8` |
| Accent soft / strong     | `accentSoft`, `accentSoftStrong`           | blue 16% / 34%                    | blue 12% / 26%                    |
| Success / text           | `success`, `successText`                   | `#31cf76` / `#31cf76`             | `#1fa85a` / `#187a41`             |
| Warning / text           | `warning`, `warningText`                   | `#ff9412` / `#ff9412`             | `#f08a00` / `#9c5200`             |
| Danger / text            | `danger`, `dangerText`                     | `#fd2f3b` / `#ff6069`             | `#e8222d` / `#c0141d`             |
| State soft fills         | `successSoft`, `warningSoft`, `dangerSoft` | green 12%, orange 12%, red 16%    | green 12%, orange 14%, red 12%    |
| Unread                   | `unreadBg`, `unreadText`                   | `#74b9ff` / `#07131f`             | same                              |
| Canvas overlay           | `bgOverlay`                                | canvas 92%                        | canvas 92%                        |
| Dialog overlay / edge    | `dialogOverlay`, `dialogRing`              | black 10% / white 10%             | ink 12% / 10%                     |

Ink in this table is `rgb(20,20,20)`; accent soft fills use `rgb(0,124,247)`. The theme also owns grouped text/borders, tab surfaces, glass, readable text, danger hover, new badges and question-option colors. Keep those values in the theme, not local copies.

Legacy callers continue to use the same exported theme names. These aliases share the new semantic values:

| Existing name                                                                 | Semantic role                                                                           |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `surface0`, `background`, `surfaceWorkspace`                                  | `bgCanvas`                                                                              |
| `surface1`                                                                    | `bgSurface`                                                                             |
| `surface2`, `secondary`, `input`                                              | `bgControl`                                                                             |
| `surface3`, `surfaceSidebarHover`                                             | `bgControlHover`                                                                        |
| `surface4`, `surfaceSidebarSelected`                                          | `bgControlActive`                                                                       |
| `surfaceSidebar`                                                              | `bgSidebar`                                                                             |
| `popover`                                                                     | `bgSheet`                                                                               |
| `muted`                                                                       | `bgGrouped`                                                                             |
| `foreground`, `popoverForeground`, `secondaryForeground`                      | `textPrimary`                                                                           |
| `foregroundMuted`, `mutedForeground`                                          | `textMuted`                                                                             |
| `foregroundExtraMuted`                                                        | `textDim`                                                                               |
| `borderAccent`, `accentBorder`                                                | `borderStrong`                                                                          |
| `interactionHighlight`                                                        | `hoverTint`                                                                             |
| `accentBright`                                                                | `accentText`                                                                            |
| `destructive`                                                                 | `danger`                                                                                |
| `primary`, `primaryForeground`                                                | `surfaceLight`, `textOnLight` in built-in themes; authored action pair in plugin themes |
| `statusSuccess`, `statusWarning`, `statusDanger`                              | State text colors                                                                       |
| `status*Tint`                                                                 | State soft fills                                                                        |
| `statusDotSuccess`, `statusDotWarning`, `statusDotDanger`, `statusDotRunning` | Success, warning, danger, accent                                                        |

`primary` / `primaryForeground` use the neutral inverse action pair: dark `#f0f0f0` / `#141414`, light `#1c1c1e` / `#ffffff`. Plugin themes retain their authored foreground/background pair, including light success and destructive action foregrounds. `accent` is the blue call to action. `success` is a state color and must not alias the accent. Diff additions/deletions and terminal ANSI colors retain their separate readability requirements. Plugin themes derive new surface, text and accent roles from their existing authored contract; new tokens must not make a selected plugin revert to built-in surfaces.

## Typography and geometry

Web and Electron use the system UI stack (`-apple-system`, `BlinkMacSystemFont`, `Segoe UI`, `sans-serif`), with no bundled UI font. Native uses its platform UI font. Preserve user-selected UI and monospace families.

| Tier             | Font / line height | Existing token              |
| ---------------- | ------------------ | --------------------------- |
| Small metadata   | 12 / 16            | `sm`                        |
| Compact metadata | 13 / 18            | `md`                        |
| Interface        | 14 / 20            | `base`                      |
| Body             | 16 / 22            | `lg`, independent `content` |
| Heading          | 18 / 24            | `xl`                        |
| Large heading    | 24 / 30            | `2xl`, legacy `3xl`         |
| Display          | 32 / 38            | `display`, legacy `4xl`     |

Weights are 400, 500, 600 and 700 (`normal`, `medium`, `semibold`, `bold`). Convey row hierarchy through color and weight before increasing size. Content and code size remain independent of interface size. Interface size scales the authored font and line-height ramps together; code and diff line heights follow code size. Avoid local pixel overrides that defeat appearance settings.

Spacing steps are 2, 4, 6, 8, 12, 16, 24 and 32 (`spacing[0.5]` through `spacing[8]`). Existing larger layout spacing names remain available. Radii are `xs=4`, `sm=6`, `md=8`, `lg=12`, `card=14`, `xl=20`, `full=999`; legacy `base=4` and `2xl=20` remain available. Control heights are 24, 28, 32, 36 and 40 (`controlHeight.xs/sm/md/lg/xl`). Icon sizes remain 12, 14, 16 and 20 with stroke 1.5.

Motion durations are fast 120, normal 160, slow 200 and overlay 240 ms. Curves are `cubic-bezier(.23,1,.32,1)` and `cubic-bezier(.77,0,.175,1)`. Consumers must respect system reduced motion: omit scale and animated transitions when enabled. Do not animate hover geometry.

## Primitive ownership

New screens consume `packages/app/src/ui/`. Existing components in `components/ui/` remain the canonical implementation when adapted there; do not add parallel menu engines, confirmation state, tooltip portals or sheet presenters. Reuse [menus](menus.md), [floating panels](floating-panels.md) and existing form state contracts from [forms](forms.md).

| Primitive              | Contract                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------- |
| Button                 | `default`, `secondary`, `outline`, `ghost`, `destructive`, `link`; heights xs 24, sm 32, default/md 36, lg 40 |
| IconButton             | Required accessible label; optional tooltip; fixed hit area                                                   |
| Input / Textarea       | Semantic control surface, placeholder color and focus ring; disabled state                                    |
| Switch                 | 36 × 20, 16 thumb, 2 inset                                                                                    |
| Menu                   | Width 192–288, 32 item height, outer radius 14, item radius 10; destructive item uses danger colors           |
| Dialog / ConfirmDialog | Centered on desktop; confirmation max width 460 and radius 20; keyboard dismissal and focus ownership         |
| Sheet                  | Bottom presentation on Android and narrow layouts, with safe-area and keyboard clearance                      |
| Tooltip                | Web hover only, 350 ms delay, no pointer events; accessible action label exists independently                 |
| ListRow                | Minimum height 54; settings row 64; avatar slot, title/subtitle and trailing accessory                        |
| Avatar                 | Image URI or our own seed-colored circle with initial; no borrowed generated graphics                         |
| Badge                  | Semantic foreground and soft fill                                                                             |
| StatusIndicator        | Working three-dot capsule, responded mark, unread count, waiting symbol, failure cross and routine clock      |

Use one blue primary action per surface. Destructive page actions are quiet until confirmation; destructive fill belongs to the confirming action. Rows and groups use spacing and restrained surface contrast. A group may have one outside border and interior separators; avoid boxing each individual row. Pane chrome uses one divider.

Avatar fallback is identity, not a status signal. Its stable hue comes from the seed hash or an explicit hue. Chinese names use the first character; English initials are uppercase. Do not use a provider logo or another product's avatar algorithm as a fallback.

## Interaction and layout

Follow [hover.md](hover.md): track hover on a plain `View` when it controls another element, and put actions in inner `Pressable`s. Self-contained button hover styling may use its own state. Keep hover hitboxes fixed. A revealed action remains mounted while its menu is open and stays accessible on touch layouts.

Press scale is 0.97 for controls and 0.99 for rows, except under reduced motion. Disabled opacity is 0.45. Focus uses a 1 px neutral ring from `textMuted`, never an extra layout border. Hover tint changes the background rather than fading the entire control. Icon-only actions always expose an accessible label.

Screens retain their current layout during the visual-foundation package. Navigation, sidebar, conversation and settings restructuring belong to their later packages. Settings groups use their existing shared rails and safe-area ownership. Keep scroll clearance for floating actions and retain native touch access to actions that Web reveals on hover.

Open `/ui-preview` in a development build (production redirects to `/`). Use the preview to review dark/light colors, component variants, disabled/focus/pressed behavior, long labels and status shapes before composing new screens. Verify Web/Electron keyboard and pointer behavior and Android touch presentation. See [QA](qa.md) for the platform evidence bar.
