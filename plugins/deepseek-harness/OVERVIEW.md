DeepSeek Harness adds a provider to Paseo so you can start agents that run through the official DeepSeek Harness command line tool (`dsh`) on the daemon machine. Paseo shows the conversation in its normal agent view, and the plugin has no screens of its own. It is a community plugin, not an official DeepSeek or Paseo product.

DeepSeek Harness must already be installed, logged in and configured on the daemon machine, with `dsh` on the daemon's `PATH` or set through Paseo's provider `command` override. The provider shows as unavailable, with the reason, if `dsh` reports a version below 0.1.5-rc.1 or cannot be read. It also needs Paseo 0.11.0 or newer and Node.js 22.19.0 or newer on the daemon. The plugin does not install or configure `dsh`. The model and reasoning-effort choices come from the models `dsh` reports, so they follow your DeepSeek Harness setup.

The Usage panel shows your DeepSeek API balance. To get it, the plugin reads the API key the same way `dsh` does, from the environment, `~/.dsh/.credentials.yaml` or `~/.dsh/.env`, and sends it only to DeepSeek's balance endpoint.

Each agent session runs `dsh --profile acp` as a child process under your operating system user, with the daemon's environment plus the session's environment variables. Any credentials in that environment reach `dsh`, and the plugin adds no sandbox or permission policy of its own. `dsh` itself makes the calls to DeepSeek's service.

Resuming a session asks `dsh` to restore its own context. If that fails, the plugin reports the error and does not start a new session. `dsh` does not replay old messages, so after an agent reload or a daemon restart the agent remembers the conversation but its timeline is empty. Provider slash commands, steering and plans are not supported, and Paseo's extra system prompt is not passed to `dsh`. Listing models can leave empty sessions in the `dsh` session list.

Its automated checks pass with the Paseo 0.11.4 SDK, and real turns ran on 0.11.4 and 0.12.0-beta.2 daemons on macOS. Windows and native iOS and Android clients are untested.
