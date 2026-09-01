# Glint

Glint is a small, self-contained CSS applier for the ChatGPT desktop renderer. It uses the renderer's local Chrome DevTools Protocol (CDP) endpoint to install one owned `<style>` element.

By default, Glint checks for an existing endpoint and otherwise finds the installed `OpenAI.Codex` package. If ChatGPT is already running from that package without the requested CDP endpoint, Glint restarts it and launches `ChatGPT.exe` with loopback CDP enabled.

Keep the CDP port bound to loopback. CDP provides control over the renderer and should not be exposed to a network interface.

## Requirements

- Node.js 22 or newer
- ChatGPT desktop installed as the Windows `OpenAI.Codex` package for automatic startup, or an already-running loopback CDP endpoint

The automatic startup path supplies these arguments:

```text
--remote-debugging-address=127.0.0.1 --remote-debugging-port=9335
```

## Usage

From this directory:

```text
node glint.mjs
```

The default is a one-shot application. To keep Glint attached while ChatGPT creates targets or the CSS file changes:

```text
node glint.mjs --watch
```

Useful options:

```text
node glint.mjs --port 9444
node glint.mjs --no-restart
node glint.mjs --css-file /absolute/path/to/custom.css
node glint.mjs --browser-id BROWSER_ID
node glint.mjs --watch --interval-ms 3000
```

Use a path valid for the Node.js runtime; for native Windows Node.js this can be `C:\path\to\custom.css`, while WSL uses paths such as `/mnt/c/path/to/custom.css`. `--port` changes the CDP port used for both startup and attachment. `--no-restart` skips automatic startup/restart and only attaches to an existing endpoint. `--once` is available as an explicit synonym for the default mode.

## Scope and side effects

Glint is intentionally narrow:

- It contacts only `127.0.0.1` and accepts only verified loopback CDP WebSocket URLs.
- It applies only to CDP page targets whose URL uses the `app://` scheme.
- It owns one style element with the id `glint-css` and updates that element's text.
- It registers a matching new-document script so newly loaded renderer documents receive the CSS, and removes that script when Glint exits.
- It does not read or write Dream Skin files, `state.json`, theme files, or user data. The default startup path only queries the installed `OpenAI.Codex` package to locate `ChatGPT.exe`.
- It does not remove or rewrite styles owned by the application or another tool.

The included CSS targets the main content surface, its rounded split corner, related fades, and the composer shadow. It deliberately does not set sidebar text, theme colors, or general application variables.

The selectors refer to ChatGPT's internal renderer markup and may need maintenance after a ChatGPT update. This is not an official ChatGPT extension API.

## Reference

Inspired by [Codex-Dream-Skin](https://github.com/Fei-Away/Codex-Dream-Skin).

## License

MIT. See [LICENSE](LICENSE).
