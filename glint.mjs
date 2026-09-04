#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const DEFAULT_PORT = 9335;
const DEFAULT_INTERVAL_MS = 1500;
const DEFAULT_TARGET_WAIT_MS = 45000;
const TARGET_POLL_INTERVAL_MS = 250;
const STYLE_ID = "glint-css";
const DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CSS_FILE = path.join(DIRECTORY, "glint.css");
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);
const ID_PATTERN = /^[A-Za-z0-9._-]{1,200}$/;
const execFile = promisify(execFileCallback);

async function main() {
  if (typeof WebSocket !== "function") {
    throw new Error("Glint requires Node.js 22 or newer with global WebSocket support.");
  }

  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  if (options.autoStart) await ensureChatGpt(options.port);
  await new GlintApplier(options).run();
}

function printHelp() {
  process.stdout.write([
    "Usage: node glint.mjs [--watch] [--port N]",
    "       [--css-file PATH] [--once] [--browser-id ID] [--interval-ms N]",
    "",
    `Default CSS file: ${DEFAULT_CSS_FILE}`,
    `Default mode starts ChatGPT with loopback CDP on port ${DEFAULT_PORT}, then applies once.`,
    "Use --no-restart to attach without starting or restarting ChatGPT.",
    "Use --watch to keep monitoring targets and CSS changes.",
    "Use --port N to change the ChatGPT debugger/CDP port.",
  ].join("\n") + "\n");
}

async function ensureChatGpt(port) {
  if (await cdpIsAvailable(port)) {
    logProcess("using existing ChatGPT CDP endpoint");
    return;
  }

  const action = await startChatGpt(port);
  logProcess(`${action} ChatGPT with loopback CDP on port ${port}`);

  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (await cdpIsAvailable(port)) {
      logProcess(`ChatGPT CDP is ready on port ${port}`);
      return;
    }
    await delay(500);
  }
  throw new Error(
    `ChatGPT did not expose CDP on port ${port} after launch/restart.`,
  );
}

async function startChatGpt(port) {
  const powershell = [
    "$ErrorActionPreference = 'Stop'",
    "$package = Get-AppxPackage -Name 'OpenAI.Codex' | Select-Object -First 1",
    "if ($null -eq $package) { throw 'OpenAI.Codex package was not found.' }",
    "$executable = Join-Path $package.InstallLocation 'app\\ChatGPT.exe'",
    "if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) { throw 'ChatGPT.exe was not found in the OpenAI.Codex package.' }",
    "$processes = @(Get-Process -Name 'ChatGPT' -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $executable })",
    "$action = if ($processes.Count -gt 0) { 'restarted' } else { 'started' }",
    "if ($processes.Count -gt 0) {",
    "  $processIds = @($processes | ForEach-Object { $_.Id })",
    "  $processes | Stop-Process -Force",
    "  Wait-Process -Id $processIds -Timeout 10 -ErrorAction SilentlyContinue",
    "}",
    `$arguments = @('--remote-debugging-address=127.0.0.1','--remote-debugging-port=${port}')`,
    "Start-Process -FilePath $executable -ArgumentList $arguments | Out-Null",
    "Write-Output $action",
  ].join("\n");
  try {
    const { stdout } = await execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", powershell],
      { encoding: "utf8", maxBuffer: 1024 * 1024 },
    );
    return stdout.trim() || "started";
  } catch (error) {
    throw new Error(`ChatGPT could not be started: ${error.stderr?.trim() || error.message}`);
  }
}

async function cdpIsAvailable(port) {
  try {
    const version = await fetchJson(port, "/json/version");
    getBrowserId(version, port);
    return true;
  } catch {
    return false;
  }
}

function logProcess(message) {
  process.stdout.write(`[glint] launch: ${message}\n`);
}

class GlintApplier {
  constructor(options) {
    this.options = options;
    this.targets = new Map();
    this.browserId = options.browserId;
    this.stopping = false;
    this.lastStatus = "";
  }

  async run() {
    const stop = () => {
      this.stopping = true;
      void this.closeTargets();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);

    if (this.options.once) {
      try {
        const result = await this.syncOnce();
        this.log("applied", `${result.applied} target(s), ${result.cssLength} CSS characters`);
      } finally {
        await this.closeTargets();
      }
      return;
    }

    this.log("watching", `CDP ${this.options.port}, CSS ${this.options.cssFile}`);
    while (!this.stopping) {
      try {
        this.report(await this.sync());
      } catch (error) {
        this.reportError(error);
      }
      await delay(this.options.intervalMs);
    }
    await this.closeTargets();
  }

  async syncOnce() {
    const deadline = Date.now() + DEFAULT_TARGET_WAIT_MS;
    while (true) {
      const result = await this.sync();
      if (result.targetCount > 0) return result;

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(
          `No ChatGPT page target was available on the verified CDP port after ${DEFAULT_TARGET_WAIT_MS / 1000} seconds.`,
        );
      }
      await delay(Math.min(TARGET_POLL_INTERVAL_MS, remaining));
    }
  }

  async sync() {
    const cssText = await readCss(this.options.cssFile);
    const discovered = await discoverTargets(this.options.port, this.browserId);
    if (!this.browserId) {
      this.browserId = discovered.browserId;
      this.log("bound", `CDP browser ${this.browserId}`);
    }

    const seen = new Set();
    let applied = 0;
    for (const target of discovered.targets) {
      seen.add(target.id);
      let managed = this.targets.get(target.id);
      if (!managed || managed.session.closed) {
        if (managed) await managed.close();
        managed = await connectTarget(target, this.options.port, cssText);
        this.targets.set(target.id, managed);
      }
      try {
        if (managed.cssText !== cssText) await managed.update(cssText);
        await managed.session.evaluate(createApplySource(cssText));
        applied += 1;
      } catch (error) {
        await managed.close();
        this.targets.delete(target.id);
        throw new Error(`Target ${target.id} could not be updated: ${error.message}`);
      }
    }

    for (const [targetId, managed] of this.targets) {
      if (!seen.has(targetId)) {
        await managed.close();
        this.targets.delete(targetId);
      }
    }
    return { targetCount: discovered.targets.length, applied, cssLength: cssText.length };
  }

  report(result) {
    const status = `${result.applied} target(s), ${result.cssLength} CSS characters`;
    if (status === this.lastStatus) return;
    this.lastStatus = status;
    this.log("applied", status);
  }

  reportError(error) {
    const status = error?.message ?? String(error);
    if (status === this.lastStatus) return;
    this.lastStatus = status;
    this.log("waiting", status);
  }

  log(event, message) {
    process.stdout.write(`[glint] ${event}: ${message}\n`);
  }

  async closeTargets() {
    const targets = [...this.targets.values()];
    this.targets.clear();
    await Promise.allSettled(targets.map((target) => target.close()));
  }
}

class ManagedTarget {
  constructor(session, cssText) {
    this.session = session;
    this.cssText = cssText;
    this.scriptId = null;
  }

  async install() {
    const result = await this.session.send("Page.addScriptToEvaluateOnNewDocument", {
      source: createApplySource(this.cssText),
    });
    this.scriptId = result.identifier ?? null;
  }

  async update(cssText) {
    if (this.scriptId) {
      await this.session.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: this.scriptId });
      this.scriptId = null;
    }
    this.cssText = cssText;
    await this.install();
  }

  async close() {
    if (this.scriptId && !this.session.closed) {
      try {
        await this.session.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: this.scriptId });
      } catch {
        // The target can disappear before its document script is removed.
      }
      this.scriptId = null;
    }
    this.session.close();
  }
}

class CdpSession {
  constructor(target, port) {
    this.ws = new WebSocket(validatePageUrl(target, port));
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
  }

  async open() {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        try { this.ws.close(); } catch {}
        reject(new Error("CDP WebSocket open timed out"));
      }, 5000);
      this.ws.addEventListener("open", () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
      this.ws.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error("CDP WebSocket open failed"));
      }, { once: true });
    });
    this.ws.addEventListener("message", (event) => this.receive(event));
    this.ws.addEventListener("error", () => this.close());
    this.ws.addEventListener("close", () => this.close());
    await this.send("Runtime.enable");
    await this.send("Page.enable");
  }

  receive(event) {
    let message;
    try { message = JSON.parse(String(event.data)); } catch {
      this.close();
      return;
    }
    if (!message || typeof message !== "object" || message.id === undefined) return;
    const waiter = this.pending.get(message.id);
    if (!waiter) return;
    clearTimeout(waiter.timeout);
    this.pending.delete(message.id);
    if (message.error) {
      waiter.reject(new Error(`${message.error.message ?? "CDP command failed"} (${message.error.code ?? "unknown"})`));
      return;
    }
    waiter.resolve(message.result ?? {});
  }

  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error("CDP session is closed"));
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, 10000);
      this.pending.set(id, { resolve, reject, timeout });
      try { this.ws.send(JSON.stringify({ id, method, params })); } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: false,
    });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
      throw new Error(`Renderer evaluation failed: ${detail}`);
    }
    return result.result?.value;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timeout);
      waiter.reject(new Error("CDP session closed"));
    }
    this.pending.clear();
    try { this.ws.close(); } catch {}
  }
}

async function connectTarget(target, port, cssText) {
  const session = new CdpSession(target, port);
  try {
    await session.open();
    const managed = new ManagedTarget(session, cssText);
    await managed.install();
    await session.evaluate(createApplySource(cssText));
    return managed;
  } catch (error) {
    session.close();
    throw error;
  }
}

function createApplySource(cssText) {
  return `(() => {
  const styleId = ${JSON.stringify(STYLE_ID)};
  const styleText = ${JSON.stringify(cssText)};
  const root = document.documentElement;
  if (!root) return { installed: false, reason: "document root unavailable" };
  let style = document.getElementById(styleId);
  if (style && style.tagName !== "STYLE") {
    return { installed: false, reason: "style id is already owned by another element" };
  }
  if (!style) {
    style = document.createElement("style");
    style.id = styleId;
    (document.head || root).append(style);
  }
  if (style.textContent !== styleText) style.textContent = styleText;
  return { installed: true, cssLength: styleText.length };
})()`;
}

async function readCss(cssFile) {
  try {
    return await fs.readFile(cssFile, "utf8");
  } catch (error) {
    throw new Error(`CSS file could not be read (${cssFile}): ${error.message}`);
  }
}

async function discoverTargets(port, expectedBrowserId) {
  const [version, rawTargets] = await Promise.all([
    fetchJson(port, "/json/version"),
    fetchJson(port, "/json/list"),
  ]);
  const browserId = getBrowserId(version, port);
  if (expectedBrowserId && browserId !== expectedBrowserId) {
    throw new Error(`CDP browser identity changed from ${expectedBrowserId} to ${browserId}.`);
  }
  if (!Array.isArray(rawTargets)) throw new Error("CDP target list is not an array.");
  return { browserId, targets: rawTargets.filter((target) => isChatGptTarget(target, port)) };
}

async function fetchJson(port, resource) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);
  try {
    const response = await fetch(`http://127.0.0.1:${port}${resource}`, {
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`CDP HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(`CDP endpoint timed out: ${resource}`);
    throw new Error(`CDP endpoint unavailable at ${resource}: ${error.message}`);
  } finally {
    clearTimeout(timeout);
  }
}

function getBrowserId(version, port) {
  if (!version || typeof version.webSocketDebuggerUrl !== "string") {
    throw new Error("CDP version response did not contain a browser WebSocket URL.");
  }
  const url = validateWebSocket(version.webSocketDebuggerUrl, port, "browser");
  const match = new URL(url).pathname.match(/^\/devtools\/browser\/([A-Za-z0-9._-]{1,200})$/);
  if (!match) throw new Error("CDP browser WebSocket URL had an invalid identity path.");
  return match[1];
}

function isChatGptTarget(target, port) {
  if (!target || typeof target !== "object" || target.type !== "page") return false;
  if (typeof target.id !== "string" || !ID_PATTERN.test(target.id)) return false;
  if (typeof target.url !== "string" || !target.url.startsWith("app://")) return false;
  try {
    validatePageUrl(target, port);
    return true;
  } catch {
    return false;
  }
}

function validatePageUrl(target, port) {
  if (typeof target.webSocketDebuggerUrl !== "string") {
    throw new Error("CDP page target had no WebSocket URL.");
  }
  const url = validateWebSocket(target.webSocketDebuggerUrl, port, "page");
  if (new URL(url).pathname !== `/devtools/page/${target.id}`) {
    throw new Error("CDP page URL did not match target id.");
  }
  return url;
}

function validateWebSocket(rawUrl, port, kind) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("CDP returned an invalid WebSocket URL.");
  }
  const expectedPath = kind === "browser" ? /^\/devtools\/browser\// : /^\/devtools\/page\//;
  if (url.protocol !== "ws:"
    || !LOOPBACK_HOSTS.has(url.hostname)
    || Number(url.port) !== port
    || url.username
    || url.password
    || url.search
    || url.hash
    || !expectedPath.test(url.pathname)) {
    throw new Error("Rejected a CDP WebSocket URL outside the verified loopback endpoint.");
  }
  return url.href;
}

function parseArgs(argv) {
  const values = {
    once: true,
    autoStart: true,
    cssFile: DEFAULT_CSS_FILE,
    port: DEFAULT_PORT,
    browserId: null,
    intervalMs: DEFAULT_INTERVAL_MS,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--once") values.once = true;
    else if (arg === "--watch") values.once = false;
    else if (arg === "--no-restart") values.autoStart = false;
    else if (arg === "--css-file") values.cssFile = path.resolve(requireValue(argv[++index], "css-file"));
    else if (arg === "--port") values.port = parseInteger(argv[++index], "port");
    else if (arg === "--browser-id") values.browserId = requireValue(argv[++index], "browser-id");
    else if (arg === "--interval-ms") values.intervalMs = parseInteger(argv[++index], "interval-ms");
    else if (arg === "--help") return { ...values, help: true };
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (values.help) return values;
  if (values.port < 1024 || values.port > 65535) throw new Error(`Invalid port: ${values.port}`);
  if (values.browserId !== null && !ID_PATTERN.test(values.browserId)) {
    throw new Error(`Invalid browser ID: ${values.browserId}`);
  }
  if (values.intervalMs < 250 || values.intervalMs > 60000) {
    throw new Error(`Invalid interval-ms: ${values.intervalMs}`);
  }
  return values;
}

function requireValue(value, name) {
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`);
  return value;
}

function parseInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`Invalid ${name}: ${value}`);
  return parsed;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

try {
  await main();
} catch (error) {
  process.stderr.write(`[glint] error: ${error?.message ?? error}\n`);
  process.exitCode = 1;
}
