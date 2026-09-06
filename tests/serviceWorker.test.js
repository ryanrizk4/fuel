import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../sw.js", import.meta.url), "utf8");
const release = await readFile(new URL("../js/release.js", import.meta.url), "utf8");
function harness() {
  const base = "https://fuel.test/fuel/", handlers = {}, stores = new Map();
  let network = async (req) => new Response(`asset:${req.url}`);
  class LocalRequest extends Request { constructor(url, opts) { super(new URL(url, base), opts); } }
  const caches = {
    keys: async () => [...stores.keys()], delete: async (key) => stores.delete(key),
    open: async (name) => {
      if (!stores.has(name)) stores.set(name, new Map());
      const data = stores.get(name), key = (r) => typeof r === "string" ? new URL(r, base).href : r.url;
      return { match: async (r) => data.get(key(r))?.clone(),
        put: async (r, res) => { data.set(key(r), res.clone()); },
        addAll: async (requests) => { for (const r of requests) { const res = await network(r); if (!res.ok) throw new Error("install failed"); data.set(key(r), res.clone()); } },
      };
    },
  };
  const context = vm.createContext({ URL, Request: LocalRequest, Response, caches, location: new URL(base),
    fetch: (...args) => network(...args),
    self: { addEventListener: (name, fn) => { handlers[name] = fn; }, skipWaiting: async () => {}, clients: { claim: async () => {} } },
    importScripts: () => vm.runInContext(release, context),
  });
  vm.runInContext(source, context);
  const dispatch = async (name, request) => {
    let response; const pending = [];
    handlers[name]({ request, waitUntil: (p) => pending.push(p), respondWith: (p) => { response = p; } });
    const result = await response; await Promise.all(pending); return result;
  };
  return { caches, install: () => dispatch("install"), activate: () => dispatch("activate"),
    fetch: (path) => dispatch("fetch", new LocalRequest(path)), network: (fn) => { network = fn; } };
}
test("a freshly installed app serves every imported module and data file offline", async () => {
  const h = harness(); await h.install(); h.network(async () => { throw new Error("offline"); });
  for (const path of ["index.html", "js/app.js", "js/release.js", "js/reloadGuard.js", "js/engine.js", "js/persistence.js", "data/products.json", "data/templates.json"]) {
    const res = await h.fetch(path); assert.equal(res.status, 200, path); assert.match(await res.text(), /asset:/);
  }
  assert.equal((await h.fetch("not-cached")).status, 503);
});
test("server errors do not poison cached nutrition data; shell stays version-coherent", async () => {
  const h = harness(); await h.install();
  h.network(async () => new Response("server error", { status: 503 }));
  assert.match(await (await h.fetch("data/products.json")).text(), /asset:/);
  h.network(async () => new Response("new release"));
  assert.match(await (await h.fetch("js/app.js")).text(), /asset:/);
  h.network(async () => { throw new Error("offline"); });
  assert.match(await (await h.fetch("data/products.json")).text(), /asset:/);
});
test("activation removes old Fuel caches but preserves unrelated origin caches", async () => {
  const h = harness(); await h.install(); await h.caches.open("fuel-old"); await h.caches.open("other-app"); await h.activate();
  const names = await h.caches.keys(); assert.ok(names.includes("other-app")); assert.ok(!names.includes("fuel-old"));
});
