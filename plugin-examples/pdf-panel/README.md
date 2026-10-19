# PDF file panel example

Requires Paseo 0.13.0 or later. Install this directory with
`paseo plugin install /absolute/path/to/plugin-examples/pdf-panel`, then open a `.pdf` in Files.

The panel passes Paseo's local document URL to `DocumentFrame` on web and iOS.
Files up to 50 MiB match. Android shows the filename, size, and a message that inline PDF rendering is unavailable. The plugin does not read files or construct daemon URLs.

See the [file panel reference](https://paseo.sh/docs/plugins/reference#file-panels).

Inline PDF rendering needs a daemon from Paseo 0.13.0 or later; see the
[DocumentFrame reference](https://paseo.sh/docs/plugins/reference#documentframe).
