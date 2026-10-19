# paseo-plugin-switch-provider

Continue a Paseo agent session on another provider and model. Large sessions get a short history with pointers to a transcript file.

Open an agent, press Ctrl+K (⌘K on macOS), and choose **Switch provider…**. Pick a provider, then a model. Paseo opens the new agent in the same workspace.

## Install

```sh
paseo plugin install npm:paseo-plugin-switch-provider
```

Needs Paseo 0.11.2 or later and the `paseo` command on the daemon's PATH. Switching to or from OpenCode also needs the `opencode` command.

See [OVERVIEW.md](OVERVIEW.md) for how it works and its limits.

## License

MIT
