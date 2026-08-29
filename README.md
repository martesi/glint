# Glint

Glint is a small, self-contained CSS applier for the ChatGPT desktop renderer. It uses the renderer's local Chrome DevTools Protocol (CDP) endpoint to install one owned `<style>` element.

It does not start, restart, patch, or monitor the ChatGPT process. ChatGPT must already be running with a loopback CDP endpoint enabled.

Keep the CDP port bound to loopback. CDP provides control over the renderer and should not be exposed to a network interface.

## Requirements

- Node.js 22 or newer
- ChatGPT desktop launched with a loopback CDP port, such as `9335`

The launch configuration needs these arguments:

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
node glint.mjs --css-file /absolute/path/to/custom.css
node glint.mjs --browser-id BROWSER_ID
node glint.mjs --watch --interval-ms 3000
```

Use a path valid for the Node.js runtime; for native Windows Node.js this can be `C:\path\to\custom.css`, while WSL uses paths such as `/mnt/c/path/to/custom.css`. `--port` changes the CDP port only; it does not launch ChatGPT. `--once` is available as an explicit synonym for the default mode.

## Scope and side effects

Glint is intentionally narrow:

- It contacts only `127.0.0.1` and accepts only verified loopback CDP WebSocket URLs.
- It applies only to CDP page targets whose URL uses the `app://` scheme.
- It owns one style element with the id `glint-css` and updates that element's text.
- It registers a matching new-document script so newly loaded renderer documents receive the CSS, and removes that script when Glint exits.
- It does not read or write Dream Skin files, `state.json`, theme files, application packages, or user data.
- It does not remove or rewrite styles owned by the application or another tool.

The included CSS targets the main content surface, its rounded split corner, related fades, and the composer shadow. It deliberately does not set sidebar text, theme colors, or general application variables.

The selectors refer to ChatGPT's internal renderer markup and may need maintenance after a ChatGPT update. This is not an official ChatGPT extension API.

## License

MIT. See [LICENSE](LICENSE).
