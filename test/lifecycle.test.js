import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import * as geometry from "../lib/geometry.js";

const source = readFileSync(new URL("../lib/index.js", import.meta.url), "utf8");
const defaults = { x: 0, y: 0, width: 1280, height: 820, maximized: false };
const saved = { schema: 1, x: 80, y: 60, width: 1100, height: 700, maximized: true };
const stateOf = ({ x, y, width, height, maximized }) => ({ x, y, width, height, maximized });

// Run the actual plugin with a fake clock, filesystem and Win32 boundary.
// No native window or real DSH state is touched, on any platform.
async function harness(initial = saved) {
  let time = 0;
  let tick, dispose, temporary;
  const h = {
    disk: initial === null ? null : { ...initial },
    current: { ...defaults },
    handle: 1,
    exists: true,
    own: true,
    visible: true,
    reject: false,
    ignore: false,
    failWrite: false,
    failRename: false,
    flags: 0,
    showCmd: null,
    attempts: 0,
    commits: 0,
    writeOptions: [],
    logs: [],
    stopped: false,
    poll(ms = 2000) { time += ms; if (!h.stopped) tick(); },
    dispose() { dispose(); },
    temporaryExists() { return temporary !== undefined; },
  };
  const b = {
    IsWindowVisible: () => h.visible,
    GetAncestor: hwnd => hwnd,
    GA_ROOT: 2,
    IsWindow: hwnd => h.exists && hwnd === h.handle,
    IsZoomed: () => h.showCmd === null && h.current.maximized,
  };
  const context = vm.createContext({
    process: { platform: "win32", execPath: "host.exe", pid: 123, env: {}, argv: [] },
    Date: class extends Date { static now() { return time; } },
    setInterval(fn) { tick = fn; return 1; },
    clearInterval() { h.stopped = true; },
  });
  const dependencies = {
    "node:module": { createRequire: () => () => ({}) },
    "node:fs": {
      readFileSync() {
        if (h.disk === null) throw new Error("ENOENT");
        return JSON.stringify(h.disk);
      },
      writeFileSync(path, body, options) {
        assert.match(path, /\.123\.tmp$/);
        h.writeOptions.push(options);
        temporary = "partial";
        if (h.failWrite) throw new Error("interrupted write");
        temporary = body;
      },
      renameSync(from, to) {
        assert.match(from, /\.123\.tmp$/);
        assert.match(to, /window-state\.json$/);
        if (h.failRename) throw new Error("rename failed");
        h.disk = JSON.parse(temporary);
        temporary = undefined;
        h.commits++;
      },
      unlinkSync() { temporary = undefined; },
      mkdirSync() {},
      existsSync: () => false,
    },
    "node:path": { dirname: () => ".", join: (...parts) => parts.join("/") },
    "node:os": { homedir: () => "home" },
    "./geometry.js": geometry,
    "./win32.js": {
      bindUser32: () => b,
      readPlacement: () => h.exists ? {
        rcNormalPosition: geometry.geometryToRect(h.current),
        showCmd: h.showCmd ?? (h.current.maximized ? 3 : 1),
        flags: h.flags,
      } : null,
      writePlacement(_b, hwnd, rect, showCmd) {
        assert.equal(h.own, true, "never write a foreign window");
        assert.equal(hwnd, h.handle);
        h.attempts++;
        if (h.reject) return false;
        if (!h.ignore) h.current = { ...geometry.rectToGeometry(rect), maximized: showCmd === 3 };
        return true;
      },
      isOnScreen: () => true,
      workAreaOf: () => ({ left: 0, top: 0, right: 1920, bottom: 1080 }),
      windowPid: () => 1,
      processImagePath: () => h.own ? "host.exe" : "browser.exe",
      normalizeExePath: path => path,
      enumTopLevel: (_b, visitor) => { if (h.exists) visitor(h.handle); },
      SW_NORMAL: 1,
      SW_MAXIMIZE: 3,
    },
  };
  const mod = new vm.SourceTextModule(source, {
    context,
    initializeImportMeta(meta) { meta.url = "file:///plugin/lib/index.js"; },
  });
  await mod.link(specifier => {
    const values = dependencies[specifier];
    return new vm.SyntheticModule(Object.keys(values), function () {
      for (const [key, value] of Object.entries(values)) this.setExport(key, value);
    }, { context });
  });
  await mod.evaluate();
  mod.namespace.apply({
    logger: { info: message => h.logs.push(message), warn: message => h.logs.push(message) },
    effect(fn) { dispose = fn(); },
  });
  return h;
}

let passed = 0;
async function test(label, fn) {
  await fn();
  passed++;
  console.log(`  PASS  ${label}`);
}
const settle = h => { h.poll(); h.poll(); h.poll(); };

await test("restoration is verified across polls, then unchanged windows do not write", async () => {
  const h = await harness();
  h.poll();
  assert.equal(h.commits, 0);
  assert.equal(h.logs.some(m => m.includes("已恢复")), false);
  h.poll(); h.poll();
  assert.equal(h.logs.some(m => m.includes("已恢复")), true);
  assert.deepEqual(stateOf(h.disk), stateOf(saved));
  const count = h.commits;
  h.poll(); h.dispose();
  assert.equal(h.commits, count);
});

await test("failed Win32 restore retries without saving defaults or reporting success", async () => {
  const h = await harness();
  h.reject = true;
  h.poll(); h.poll();
  assert.equal(h.attempts, 2);
  assert.equal(h.commits, 0);
  assert.equal(h.logs.some(m => m.includes("已恢复")), false);
  h.reject = false;
  settle(h);
  assert.deepEqual(stateOf(h.current), stateOf(saved));
  assert.equal(h.logs.some(m => m.includes("已恢复")), true);
});

await test("success return without the requested placement is not accepted", async () => {
  const h = await harness();
  h.ignore = true;
  h.poll(); h.poll();
  assert.equal(h.attempts, 2);
  assert.equal(h.commits, 0);
  h.dispose();
  assert.deepEqual(h.disk, saved);
});

await test("startup resetting the size causes another restore before recording", async () => {
  const h = await harness();
  h.poll();
  h.current = { ...defaults };
  h.poll();
  assert.equal(h.attempts, 2);
  assert.equal(h.commits, 0);
  h.poll(); h.poll();
  assert.deepEqual(stateOf(h.disk), stateOf(saved));
});

await test("persistent restore failure times out and preserves state even on dispose", async () => {
  const h = await harness();
  h.reject = true;
  for (let i = 0; i < 8; i++) h.poll();
  assert.equal(h.attempts, 5);
  assert.equal(h.commits, 0);
  assert.equal(h.logs.some(m => m.includes("超时")), true);
  h.dispose();
  assert.deepEqual(h.disk, saved);
});

await test("dispose before the first poll cannot save an unrestored default window", async () => {
  const h = await harness();
  h.dispose();
  assert.deepEqual(h.disk, saved);
  assert.equal(h.commits, 0);
});

await test("dispose during startup verification preserves the previous record", async () => {
  const h = await harness();
  h.poll();
  h.current = { ...defaults };
  h.dispose();
  assert.deepEqual(h.disk, saved);
});

await test("a replacement window restores the latest persisted user adjustment", async () => {
  const h = await harness();
  settle(h);
  h.current = { x: 120, y: 90, width: 1200, height: 900, maximized: false };
  h.poll();
  const latest = stateOf(h.disk);
  h.handle = 2;
  h.current = { ...defaults };
  settle(h);
  assert.deepEqual(h.current, latest);
  assert.deepEqual(stateOf(h.disk), latest);
});

await test("dispose cannot save a replacement window that has not been restored", async () => {
  const h = await harness();
  settle(h);
  h.handle = 2;
  h.current = { ...defaults };
  h.dispose();
  assert.deepEqual(stateOf(h.disk), stateOf(saved));
});

await test("a later replacement gets a fresh window-discovery deadline", async () => {
  const h = await harness();
  settle(h);
  h.poll(120_000);
  h.exists = false;
  h.poll();
  assert.equal(h.stopped, false);
  h.exists = true;
  h.handle = 2;
  h.current = { ...defaults };
  settle(h);
  assert.deepEqual(stateOf(h.current), stateOf(saved));
});

await test("normal exit captures a final adjustment even when the window is hidden", async () => {
  const h = await harness();
  settle(h);
  h.current = { x: 110, y: 100, width: 1150, height: 750, maximized: false };
  h.visible = false;
  h.dispose();
  assert.deepEqual(stateOf(h.disk), h.current);
});

await test("periodic state survives abrupt termination without dispose", async () => {
  const first = await harness();
  settle(first);
  first.current = { x: 150, y: 90, width: 1000, height: 800, maximized: false };
  first.poll();
  const second = await harness(first.disk);
  settle(second);
  assert.deepEqual(second.current, first.current);
});

await test("a minimized maximized window retains its maximized restore state", async () => {
  const h = await harness();
  settle(h);
  h.showCmd = 2;
  h.flags = 2; // WPF_RESTORETOMAXIMIZED
  h.poll(); h.dispose();
  assert.equal(h.disk.maximized, true);
});

await test("recycled foreign handles are never restored or recorded", async () => {
  const h = await harness();
  settle(h);
  const count = h.commits;
  h.own = false;
  h.current = { ...defaults };
  h.poll(); h.dispose();
  assert.equal(h.commits, count);
  assert.equal(h.attempts, 1);
});

await test("first run records the current window without restoring", async () => {
  const h = await harness(null);
  h.poll();
  assert.deepEqual(stateOf(h.disk), defaults);
  assert.equal(h.attempts, 0);
});

await test("newer schemas are neither applied nor overwritten", async () => {
  const initial = { ...saved, schema: 2 };
  const h = await harness(initial);
  settle(h); h.dispose();
  assert.deepEqual(h.disk, initial);
  assert.equal(h.attempts, 0);
});

for (const failure of ["failWrite", "failRename"]) {
  await test(`${failure}: atomic save preserves the old record and retries`, async () => {
    const h = await harness();
    settle(h);
    const before = { ...h.disk };
    h.current = { ...defaults, width: 1050 };
    h[failure] = true;
    h.poll();
    assert.deepEqual(h.disk, before);
    assert.equal(h.temporaryExists(), false);
    h[failure] = false;
    h.poll();
    assert.deepEqual(stateOf(h.disk), h.current);
    assert.ok(h.writeOptions.every(options => options.flush === true));
  });
}

await test("invalid geometry cannot corrupt a valid record", async () => {
  const h = await harness();
  settle(h);
  h.current = { ...defaults, width: 0 };
  h.poll(); h.dispose();
  assert.deepEqual(stateOf(h.disk), stateOf(saved));
});

console.log(`\nlifecycle.test.js: ${passed} passed`);
