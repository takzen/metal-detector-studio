// Electron shell for Metal Detector Studio.
//
// One window that boots the whole stack: it spawns the Python backend (uvicorn) and
// the Next.js frontend, waits for them, then shows the app — so a single icon replaces
// "run the backend in one terminal, the frontend in another, then open a browser".
//
// If a backend/frontend is already running on its port, we reuse it instead of spawning
// a duplicate (avoids "port in use"). Child processes are killed when the window closes.

const { app, BrowserWindow } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");
const http = require("node:http");

const FRONTEND_DIR = path.join(__dirname, "..");
const PROJECT_ROOT = path.join(FRONTEND_DIR, "..");
const BACKEND_DIR = path.join(PROJECT_ROOT, "backend");

// Load via localhost (not 127.0.0.1): Next 16's dev server serves on the localhost
// origin and blocks cross-origin dev resources (HMR/chunks) — loading 127.0.0.1 would
// break client-side React in the window (dead tabs, no live data).
const FRONTEND_URL = "http://localhost:3000";
const BACKEND_HEALTH = "http://127.0.0.1:8000/api/health";

const children = [];

function spawnProc(cmd, args, cwd, name) {
  // shell:true so Windows resolves uv.cmd / pnpm.cmd from PATH.
  const proc = spawn(cmd, args, { cwd, shell: true, env: process.env });
  const tag = `[${name}] `;
  proc.stdout.on("data", (d) => process.stdout.write(tag + d));
  proc.stderr.on("data", (d) => process.stderr.write(tag + d));
  proc.on("exit", (code) => console.log(`${tag}exited (${code})`));
  children.push(proc);
  return proc;
}

function isUp(url, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.destroy();
      resolve(true);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitUntilUp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isUp(url)) return true;
    await new Promise((r) => setTimeout(r, 600));
  }
  return false;
}

function killChildren() {
  for (const c of children) {
    try {
      if (process.platform === "win32") {
        // kill the whole tree (next/uvicorn spawn sub-processes)
        spawn("taskkill", ["/pid", String(c.pid), "/f", "/t"]);
      } else {
        c.kill("SIGTERM");
      }
    } catch {
      /* ignore */
    }
  }
}

let win;
function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    title: "Metal Detector Studio",
    icon: path.join(__dirname, "icon.ico"),
    backgroundColor: "#0a0a0a",
    show: false,
  });
  win.removeMenu();
  enableZoom(win);
  win.loadFile(path.join(__dirname, "loading.html"));
  win.once("ready-to-show", () => win.show());
}

// Zoom controls. removeMenu() also strips the default zoom accelerators, so wire them
// back: Ctrl + mouse wheel, and Ctrl + '='/'-'/'0'. Clamped to a sane range.
function enableZoom(w) {
  const wc = w.webContents;
  const ZMIN = 0.4;
  const ZMAX = 3.0;
  const clamp = (z) => Math.min(ZMAX, Math.max(ZMIN, Math.round(z * 100) / 100));

  // Ctrl + mouse wheel (Electron emits zoom-changed for this gesture).
  wc.on("zoom-changed", (_e, dir) => {
    const z = wc.getZoomFactor();
    wc.setZoomFactor(clamp(dir === "in" ? z + 0.1 : z - 0.1));
  });

  // Ctrl + '='/'+' zoom in, Ctrl + '-' zoom out, Ctrl + '0' reset.
  wc.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || !input.control) return;
    const z = wc.getZoomFactor();
    if (input.key === "=" || input.key === "+") {
      wc.setZoomFactor(clamp(z + 0.1));
      event.preventDefault();
    } else if (input.key === "-") {
      wc.setZoomFactor(clamp(z - 0.1));
      event.preventDefault();
    } else if (input.key === "0") {
      wc.setZoomFactor(1);
      event.preventDefault();
    }
  });
}

app.whenReady().then(async () => {
  createWindow();

  // Backend: reuse if already serving, else spawn uvicorn.
  if (!(await isUp(BACKEND_HEALTH))) {
    spawnProc("uv", ["run", "python", "main.py"], BACKEND_DIR, "backend");
  } else {
    console.log("[backend] already running — reusing");
  }

  // Frontend: reuse if already serving, else spawn next dev.
  if (!(await isUp(FRONTEND_URL))) {
    spawnProc("pnpm", ["exec", "next", "dev"], FRONTEND_DIR, "frontend");
  } else {
    console.log("[frontend] already running — reusing");
  }

  const ready = await waitUntilUp(FRONTEND_URL, 90_000);
  if (ready && win && !win.isDestroyed()) {
    win.loadURL(FRONTEND_URL);
  } else if (win && !win.isDestroyed()) {
    win.loadFile(path.join(__dirname, "loading.html"), { hash: "error" });
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  killChildren();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", killChildren);
