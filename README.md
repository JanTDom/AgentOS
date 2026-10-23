# AgentOS

AgentOS is a local-first macOS command center for AI agents. It combines project folders, model adapters, routing, network research, evidence, and bounded computer actions in one desktop workspace.

## What works in this first vertical slice

- React/Vite desktop UI with a dark command-center workspace.
- Tauri 2 packaging for macOS `.app` and `.dmg`.
- Intel build target (`x86_64-apple-darwin`) on the current machine.
- Project folder picker and project inspection through the Rust backend.
- Provider adapters for OpenAI-compatible APIs, Anthropic-style Messages APIs, Google OpenAI-compatible endpoints and local Ollama.
- Provider keys sent to macOS Keychain by the backend; keys are never put in the frontend snapshot.
- Safe web fetch with HTTP/HTTPS validation, redirect limits, response-size cap, and private/local address blocking.
- Bounded, approval-gated macOS actions: reveal a project in Finder, open Terminal at a project, open a web URL, and take a screenshot.
- Demo fallback in a normal browser so the information architecture can be reviewed without Tauri.

## Development

```bash
npm install
npm run dev
```

For the desktop shell:

```bash
npm run tauri:dev
```

## macOS installers

The current host is Intel, so the normal bundle creates an Intel installer:

```bash
npm run tauri:build
```

Output:

- `src-tauri/target/release/bundle/macos/AgentOS.app`
- `src-tauri/target/release/bundle/dmg/AgentOS_0.1.0_x64.dmg`

To build an explicit Intel target:

```bash
npm run tauri:build:intel
```

To build a universal binary later, install the missing Rust target and run:

```bash
rustup target add aarch64-apple-darwin
npm run tauri:build:universal
```

Unsigned local builds may require allowing the app in macOS Privacy & Security. Production distribution still needs Apple code signing and notarization.

## Security boundary

The MVP does not give an agent unrestricted mouse/keyboard control. Computer actions are explicit, allowlisted and approval-gated. The network backend blocks localhost and common private ranges and caps responses. Full Accessibility automation belongs in a separate permission and audit layer with an emergency stop.

See [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) for the current boundary and open risks.
