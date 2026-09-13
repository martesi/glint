# Glint

Apply `glint.css` to the ChatGPT desktop renderer through local CDP (Chrome DevTools Protocol).

## Requirements

- Node.js 22+
- ChatGPT desktop (`OpenAI.Codex`)

## Usage

```text
node glint.mjs
```

Glint uses `127.0.0.1:9335`, starting or restarting ChatGPT with loopback CDP when needed. It applies the CSS to current renderer targets and keeps it active across future documents in those targets.

Keep the CDP port on loopback only.

Inspired by [Codex-Dream-Skin](https://github.com/Fei-Away/Codex-Dream-Skin).

MIT. See [LICENSE](LICENSE).
