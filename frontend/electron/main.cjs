// Electron shell for Metal Detector Studio.
//
// One window that boots the whole stack: it spawns the Python backend (uvicorn) and
// the Next.js frontend, waits for them, then shows the app — so a single icon replaces
// "run the backend in one terminal, the frontend in another, then open a browser".
//
// Ports are NOT assumed. Another project on this machine may already hold 8000/3000, so:
//   - the backend picks the first free port (preferring 8000) and we inject it via
//     METAL_LAB_PORT; the frontend is told where the backend landed via
//     NEXT_PUBLIC_BACKEND_HOST, so the two always agree even when 8000 is taken;
//   - the frontend lets Next fall forward (3000 -> 3001 -> ...) and we parse the real
//     port from its stdout and load that exact URL.
// Reuse only happens when we positively identify OUR backend (200 + our health shape) —
// never a foreign server that merely answers on the same port (that caused /api/health
// -> 404 and a blank window). Child processes are killed synchronously on quit.

const { app, BrowserWindow } = require("electron");
const { spawn, spawnSync } = require("node:child_process");
const path = require("node:path");
const http = require("node:http");
const net = require("node:net");

const FRONTEND_DIR = path.join(__dirname, "..");
const PROJECT_ROOT = path.join(FRONTEND_DIR, "..");
const BACKEND_DIR = path.join(PROJECT_ROOT, "backend");

// Preferred ports; both fall forward if taken. Override via env if ever needed.
const PREFERRED_BACKEND_PORT = Number(process.env.METAL_LAB_PORT) || 8000;
const PREFERRED_FRONTEND_PORT = Number(process.env.METAL_LAB_FRONTEND_PORT) || 3000;

const children = [];

// One command STRING + shell:true (no separate args array) so Windows resolves uv.cmd /
// pnpm.cmd from PATH and Node doesn't warn (DEP0190) about unescaped shell args. Our
// arguments are our own integers/paths — no untrusted input.
function spawnProc(command, cwd, name, extraEnv) {
  const proc = spawn(command, { cwd, shell: true, env: { ...process.env, ...extraEnv } });
  const tag = `[${name}] `;
  proc.stdout.on("data", (d) => process.stdout.write(tag + d));
  proc.stderr.on("data", (d) => process.stderr.write(tag + d));
  proc.on("exit", (code) => console.log(`${tag}exited (${code})`));
  children.push(proc);
  return proc;
}

// True only if OUR backend answers here: 200 on /api/health with our JSON shape. A
// foreign app on the same port (404 / different body) must NOT be mistaken for ours.
function isOurBackend(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/api/health`, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return resolve(false);
      }
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          const j = JSON.parse(body);
          resolve(typeof j.status === "string");
        } catch {
          resolve(false);
        }
      });
    });
    req.on("error", () => resolve(false));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve(false);
    });
  });
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

async function waitForOurBackend(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isOurBackend(port)) return true;
    await new Promise((r) => setTimeout(r, 600));
  }
  return false;
}

// Is a TCP port free to bind on 127.0.0.1?
function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

// First free port at/after `preferred` (so the backend never collides with another app).
async function pickPort(preferred, span = 25) {
  for (let p = preferred; p < preferred + span; p++) {
    if (await portFree(p)) return p;
  }
  return preferred;
}

// Resolve the port Next actually bound to by watching its stdout for the "Local:" line
// (e.g. "http://localhost:3001"). Falls back to the preferred port after the timeout.
function waitForNextPort(proc, fallback, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (p) => {
      if (done) return;
      done = true;
      resolve(p);
    };
    proc.stdout.on("data", (buf) => {
      const m = String(buf).match(/http:\/\/localhost:(\d+)/);
      if (m) finish(Number(m[1]));
    });
    setTimeout(() => finish(fallback), timeoutMs);
  });
}

// Kill leftover dev servers from THIS project — our frontend (next) and backend (main.py),
// never the MCP server (mcp_server.py) or another project (matched by the project folder in
// the command line). Used both at startup (clears orphans from a previous run that didn't
// shut down cleanly — e.g. the console window was closed instead of the app window) and on
// quit (catches the Next worker process that escapes taskkill's process tree).
function killStaleStudioProcs() {
  if (process.platform !== "win32") return;
  const ps =
    "Get-CimInstance Win32_Process | Where-Object { " +
    "($_.Name -eq 'node.exe' -and $_.CommandLine -match 'metal-detector-studio' -and $_.CommandLine -match 'next') -or " +
    "($_.Name -eq 'python.exe' -and $_.CommandLine -match 'metal-detector-studio' -and $_.CommandLine -match 'main\\.py') " +
    "} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
  try {
    spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { stdio: "ignore" });
  } catch {
    /* ignore */
  }
}

// Synchronous so it actually completes before Electron exits — an async taskkill in
// before-quit often doesn't run in time, which is what left orphaned dev servers behind.
let cleanedUp = false;
function killChildren() {
  if (cleanedUp) return;
  cleanedUp = true;
  for (const c of children) {
    if (!c.pid) continue;
    try {
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/pid", String(c.pid), "/f", "/t"], { stdio: "ignore" });
      } else {
        c.kill("SIGTERM");
      }
    } catch {
      /* ignore */
    }
  }
  // Belt-and-suspenders: kill any of our servers that escaped the process tree.
  killStaleStudioProcs();
  children.length = 0;
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

  // Clear orphans from a previous run that didn't exit cleanly (e.g. the console window was
  // closed instead of the app window), so we start from a clean slate with no self-collision.
  killStaleStudioProcs();

  // Backend: reuse only if OUR backend already serves on the preferred port; otherwise
  // pick a free port and spawn it there, injecting the port so it actually binds it.
  let backendPort = PREFERRED_BACKEND_PORT;
  if (await isOurBackend(PREFERRED_BACKEND_PORT)) {
    console.log(`[backend] already running on ${backendPort} — reusing`);
  } else {
    backendPort = await pickPort(PREFERRED_BACKEND_PORT);
    spawnProc("uv run python main.py", BACKEND_DIR, "backend", {
      METAL_LAB_PORT: String(backendPort),
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8",
    });
  }

  // Frontend: always spawn our own and load whatever port it bound to. We do NOT pin the
  // port with `-p`: an explicit port makes Next hard-fail with EADDRINUSE if it's taken,
  // whereas bare `next dev` falls forward (3000 -> 3001 -> ...). We parse the real port it
  // prints. Tell it where the backend landed so the two agree even off the default port.
  const fe = spawnProc(
    `pnpm exec next dev`,
    FRONTEND_DIR,
    "frontend",
    { NEXT_PUBLIC_BACKEND_HOST: `127.0.0.1:${backendPort}` }
  );
  const frontendPort = await waitForNextPort(fe, PREFERRED_FRONTEND_PORT, 90_000);

  // Make sure the backend is actually answering before we show the UI (avoids the window
  // loading while /api/health still 404s during startup).
  await waitForOurBackend(backendPort, 30_000);

  const frontendUrl = `http://localhost:${frontendPort}`;
  const ready = await waitUntilUp(frontendUrl, 90_000);
  if (ready && win && !win.isDestroyed()) {
    console.log(`[electron] backend :${backendPort}  ->  loading ${frontendUrl}`);
    win.loadURL(frontendUrl);
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
