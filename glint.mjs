#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const PORT = 9335;
const TARGET_WAIT_MS = 20000;
const STYLE_ID = "glint-css";
const DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const CSS_FILE = path.join(DIRECTORY, "glint.css");
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);
const ID_PATTERN = /^[A-Za-z0-9._-]{1,200}$/;
const execFile = promisify(execFileCallback);

async function main() {
  if (typeof WebSocket !== "function") {
    throw new Error("Glint requires Node.js 22 or newer with global WebSocket support.");
  }

  const command = process.argv[2];
  if (process.argv.length > 3 || (command && command !== "new")) {
    throw new Error("Usage: node glint.mjs [new]");
  }

  const hadCdp = await ensureChatGpt();
  let previousTargetIds = new Set();
  if (command === "new" && hadCdp) {
    previousTargetIds = new Set((await discoverTargets()).map((target) => target.id));
    await startNewChatGptWindow();
    logProcess("opened a new ChatGPT window");
  }

  const cssText = await readCss();
  const applied = await applyWhenReady(cssText, previousTargetIds);
  process.stdout.write(`[glint] applied: ${applied} target(s), ${cssText.length} CSS characters\n`);
}

async function ensureChatGpt() {
  if (await cdpIsAvailable()) {
    logProcess("using existing ChatGPT CDP endpoint");
    return true;
  }

  const action = await startChatGpt();
  logProcess(`${action} ChatGPT with loopback CDP on port ${PORT}`);

  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (await cdpIsAvailable()) {
      logProcess(`ChatGPT CDP is ready on port ${PORT}`);
      return false;
    }
    await delay(500);
  }
  throw new Error(`ChatGPT did not expose CDP on port ${PORT} after launch/restart.`);
}

async function startChatGpt() {
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
    `$arguments = @('--remote-debugging-address=127.0.0.1','--remote-debugging-port=${PORT}')`,
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

async function cdpIsAvailable() {
  try {
    const version = await fetchJson("/json/version");
    if (typeof version?.webSocketDebuggerUrl !== "string") return false;
    const url = validateWebSocket(version.webSocketDebuggerUrl);
    return /^\/devtools\/browser\/[A-Za-z0-9._-]{1,200}$/.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

async function startNewChatGptWindow() {
  const targets = await discoverTargets();
  if (targets.length === 0) throw new Error("No ChatGPT renderer target is available.");

  let lastProbeError;
  for (const target of targets) {
    const ws = new WebSocket(validatePageUrl(target));
    let nextCommandId = 0;
    const command = (method, params) => cdpCommand(ws, ++nextCommandId, method, params);
    let ownsApplicationMenu = false;

    try {
      await waitForWebSocket(ws);
      await command("Runtime.enable");
      ownsApplicationMenu = await rendererControlExists(command, "#application-menu-trigger-file-menu");
      if (!ownsApplicationMenu) continue;

      await clickRendererControl(command, "File", "#application-menu-trigger-file-menu");
      await clickRendererControl(command, "New Window");
      return;
    } catch (error) {
      if (ownsApplicationMenu) {
        throw new Error(`ChatGPT File > New Window could not be invoked: ${error.message}`);
      }
      lastProbeError = error;
    } finally {
      try { ws.close(); } catch {}
    }
  }

  throw new Error(
    `ChatGPT File > New Window could not be invoked: application menu target was not found${lastProbeError ? ` (${lastProbeError.message})` : "."}`,
  );
}

async function rendererControlExists(command, selector) {
  const result = await command("Runtime.evaluate", {
    expression: `Boolean(document.querySelector(${JSON.stringify(selector)}))`,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
    throw new Error(`Renderer evaluation failed: ${detail}`);
  }
  return result.result?.value === true;
}

async function clickRendererControl(command, label, selector) {
  const expression = `(() => {
    const label = ${JSON.stringify(label)};
    const selector = ${JSON.stringify(selector)};
    const candidates = selector
      ? [document.querySelector(selector)]
      : [...document.querySelectorAll('button,[role="button"],[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"]')];
    const element = candidates.find((candidate) => candidate?.textContent?.trim() === label);
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  })()`;

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = await command("Runtime.evaluate", {
      expression,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
      throw new Error(`Renderer evaluation failed: ${detail}`);
    }
    const point = result.result?.value;
    if (point) {
      await command("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: point.x,
        y: point.y,
        button: "left",
        clickCount: 1,
      });
      await command("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: point.x,
        y: point.y,
        button: "left",
        clickCount: 1,
      });
      return;
    }
    await delay(50);
  }
  throw new Error(`ChatGPT renderer control was not found: ${label}`);
}

async function filterApplicationWindowTargets(targets) {
  const matches = await Promise.all(targets.map(async (target) => {
    const ws = new WebSocket(validatePageUrl(target));
    let nextCommandId = 0;
    const command = (method, params) => cdpCommand(ws, ++nextCommandId, method, params);

    try {
      await waitForWebSocket(ws);
      await command("Runtime.enable");
      return await rendererControlExists(command, "#application-menu-trigger-file-menu") ? target : null;
    } finally {
      try { ws.close(); } catch {}
    }
  }));
  return matches.filter(Boolean);
}

function waitForWebSocket(ws) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("CDP WebSocket open timed out")), 5000);
    const finish = (callback, value) => {
      clearTimeout(timeout);
      callback(value);
    };
    ws.addEventListener("open", () => finish(resolve), { once: true });
    ws.addEventListener("error", () => finish(reject, new Error("CDP WebSocket open failed")), { once: true });
  });
}

async function applyWhenReady(cssText, previousTargetIds = new Set()) {
  const deadline = Date.now() + TARGET_WAIT_MS;
  let lastError;

  while (true) {
    try {
      const discoveredTargets = (await discoverTargets()).filter((target) => !previousTargetIds.has(target.id));
      const targets = await filterApplicationWindowTargets(discoveredTargets);
      if (targets.length > 0) {
        await Promise.all(targets.map((target) => applyToTarget(target, cssText)));
        return targets.length;
      }
    } catch (error) {
      lastError = error;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(
        `ChatGPT CDP was not ready after ${TARGET_WAIT_MS / 1000} seconds${lastError ? `: ${lastError.message}` : "."}`,
      );
    }
    await delay(Math.min(250, remaining));
  }
}

async function applyToTarget(target, cssText) {
  const ws = new WebSocket(validatePageUrl(target));

  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("CDP WebSocket open timed out")), 5000);
      const finish = (callback, value) => {
        clearTimeout(timeout);
        callback(value);
      };
      ws.addEventListener("open", () => finish(resolve), { once: true });
      ws.addEventListener("error", () => finish(reject, new Error("CDP WebSocket open failed")), { once: true });
    });

    await cdpCommand(ws, 1, "Runtime.enable");
    await cdpCommand(ws, 2, "Page.enable");
    await cdpCommand(ws, 3, "Page.addScriptToEvaluateOnNewDocument", {
      source: createApplySource(cssText),
    });
    const result = await cdpCommand(ws, 4, "Runtime.evaluate", {
      expression: createApplySource(cssText),
    });

    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
      throw new Error(`Renderer evaluation failed: ${detail}`);
    }
  } catch (error) {
    throw new Error(`Target ${target.id} could not be updated: ${error.message}`);
  } finally {
    try { ws.close(); } catch {}
  }
}

function cdpCommand(ws, id, method, params) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(reject, new Error(`CDP command timed out: ${method}`)), 10000);
    const finish = (callback, value) => {
      clearTimeout(timeout);
      ws.removeEventListener("message", onMessage);
      ws.removeEventListener("error", onError);
      ws.removeEventListener("close", onClose);
      callback(value);
    };
    const onMessage = (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        finish(reject, new Error("CDP returned invalid JSON"));
        return;
      }
      if (message?.id !== id) return;
      if (message.error) {
        finish(reject, new Error(`${message.error.message ?? "CDP command failed"} (${message.error.code ?? "unknown"})`));
        return;
      }
      finish(resolve, message.result ?? {});
    };
    const onError = () => finish(reject, new Error("CDP WebSocket failed"));
    const onClose = () => finish(reject, new Error("CDP WebSocket closed"));

    ws.addEventListener("message", onMessage);
    ws.addEventListener("error", onError, { once: true });
    ws.addEventListener("close", onClose, { once: true });
    try {
      ws.send(JSON.stringify({ id, method, params }));
    } catch (error) {
      finish(reject, error);
    }
  });
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

async function readCss() {
  try {
    return await fs.readFile(CSS_FILE, "utf8");
  } catch (error) {
    throw new Error(`CSS file could not be read (${CSS_FILE}): ${error.message}`);
  }
}

async function discoverTargets() {
  const rawTargets = await fetchJson("/json/list");
  if (!Array.isArray(rawTargets)) throw new Error("CDP target list is not an array.");
  return rawTargets.filter(isChatGptTarget);
}

async function fetchJson(resource) {
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}${resource}`, {
      redirect: "error",
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) throw new Error(`CDP HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    throw new Error(`CDP endpoint unavailable at ${resource}: ${error.message}`);
  }
}

function isChatGptTarget(target) {
  if (!target || typeof target !== "object" || target.type !== "page") return false;
  if (typeof target.id !== "string" || !ID_PATTERN.test(target.id)) return false;
  if (typeof target.url !== "string" || !target.url.startsWith("app://")) return false;
  try {
    validatePageUrl(target);
    return true;
  } catch {
    return false;
  }
}

function validatePageUrl(target) {
  if (typeof target.webSocketDebuggerUrl !== "string") {
    throw new Error("CDP page target had no WebSocket URL.");
  }
  const url = validateWebSocket(target.webSocketDebuggerUrl);
  if (new URL(url).pathname !== `/devtools/page/${target.id}`) {
    throw new Error("CDP page URL did not match target id.");
  }
  return url;
}

function validateWebSocket(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("CDP returned an invalid WebSocket URL.");
  }
  if (url.protocol !== "ws:"
    || !LOOPBACK_HOSTS.has(url.hostname)
    || Number(url.port) !== PORT
    || url.username
    || url.password
    || url.search
    || url.hash) {
    throw new Error("Rejected a CDP WebSocket URL outside the verified loopback endpoint.");
  }
  return url.href;
}

function logProcess(message) {
  process.stdout.write(`[glint] launch: ${message}\n`);
}

try {
  await main();
} catch (error) {
  process.stderr.write(`[glint] error: ${error?.message ?? error}\n`);
  process.exitCode = 1;
}
