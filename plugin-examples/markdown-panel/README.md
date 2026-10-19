# Markdown file panel example

Requires Paseo 0.13.0 or later. Install the editor dependencies, then install this directory:

```sh
cd plugin-examples/markdown-panel
npm install
paseo plugin install "$PWD"
```

Open a `.md` or `.markdown` file in Files. Choose **Rich Markdown — markdown-panel** in the
picker. Check **Don't ask me again** to remember the choice on this device.

Preview contains a CodeMirror editor with Markdown highlighting, line numbers, undo, redo, and
line wrapping. Edits call the host document's `setText`; Paseo owns autosave, the dirty dot,
and external-change conflicts. Source still opens Paseo's editor. Files above 1 MiB or hosts
without editing support render read-only. Native shows selectable, read-only text.

Paseo bundles the editor dependencies into this plugin. They are loaded only on web; the native
path uses React Native primitives. DOM integration lives in `client/web.ts`.

See the [file panel reference](https://paseo.sh/docs/plugins/reference#file-panels).
