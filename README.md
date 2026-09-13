# Glint

Glint is a small, self-contained CSS applier for the ChatGPT desktop renderer. It uses the renderer's local Chrome DevTools Protocol (CDP) endpoint to install one owned `<style>` element.

Glint checks for an existing endpoint on port `9335`. If none is available, it finds the installed `OpenAI.Codex` package, restarts ChatGPT when necessary, and launches `ChatGPT.exe` with loopback CDP enabled.

Keep the CDP port bound to loopback. CDP provides control over the renderer and should not be exposed to a network interface.

## Requirements

- Node.js 22 or newer
- ChatGPT desktop installed as the Windows `OpenAI.Codex` package

Glint supplies these arguments when starting ChatGPT:

```text
--remote-debugging-address=127.0.0.1 --remote-debugging-port=9335
```

## Usage

From this directory:

```text
node glint.mjs
```

Glint waits up to 20 seconds for a ChatGPT page target, applies `glint.css` to every current ChatGPT renderer target, then exits.

## Scope and side effects

Glint is intentionally narrow:

- It contacts only `127.0.0.1:9335` and accepts only verified loopback CDP WebSocket URLs.
- It applies only to CDP page targets whose URL uses the `app://` scheme.
- It owns one style element with the id `glint-css` and updates that element's text.
- It does not read or write Dream Skin files, `state.json`, theme files, or user data.
- It does not remove or rewrite styles owned by the application or another tool.

The included CSS targets the main content surface, its rounded split corner, related fades, and the composer shadow. It deliberately does not set sidebar text, theme colors, or general application variables.

The selectors refer to ChatGPT's internal renderer markup and may need maintenance after a ChatGPT update. This is not an official ChatGPT extension API.

## Reference

Inspired by [Codex-Dream-Skin](https://github.com/Fei-Away/Codex-Dream-Skin).

## License

MIT. See [LICENSE](LICENSE).
