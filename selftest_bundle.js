/**
 * Headless smoke test for dashboard/plugin.js.
 *
 * The bundle is a browser IIFE that expects window.__HERMES_PLUGIN_SDK__, a DOM
 * and a live React. None of that exists here, so this stubs the minimum needed
 * to actually execute the render path: if the bundle references an undefined
 * constant, throws while building the tree, or fails to register, this fails.
 *
 * Run with:  node selftest_bundle.js
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SOURCE = fs.readFileSync(path.join(__dirname, "dashboard", "plugin.js"), "utf8");
const failures = [];
function check(label, condition, detail) {
  if (condition) {
    console.log(`  [ok  ] ${label}`);
  } else {
    failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
    console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// ─── Minimal React-ish renderer ───────────────────────────────────────
// Renders a createElement tree to a string so we can assert on the output
// without a real renderer. Hooks are single-pass: state setters are recorded
// but do not re-render, which is enough to exercise the render path.
const hookState = [];
let hookIndex = 0;
// Effect bookkeeping, keyed by call order. Without dep tracking a stub that
// re-runs every effect each pass would make loadAll() fire forever and wipe
// the state it just loaded — the opposite of how the real hook behaves.
let effectDeps = new Map();
let effectOrder = [];
let memoDeps = new Map();
let memoValues = new Map();
let memoOrder = [];

function memoize(kind, fn, deps, invoke) {
  const slot = `${kind}:${memoOrder.length++}`;
  if (sameDeps(memoDeps.get(slot), deps)) return memoValues.get(slot);
  memoDeps.set(slot, deps);
  // useMemo takes a factory; useCallback takes the value itself.
  const value = invoke ? fn() : fn;
  memoValues.set(slot, value);
  return value;
}

function sameDeps(a, b) {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function makeRenderer() {
  const React = {
    Fragment: Symbol("Fragment"),
    createElement(type, props, ...children) {
      return { type, props: props || {}, children: children.flat(Infinity) };
    },
  };
  const hooks = {
    useState(initial) {
      const i = hookIndex++;
      // `in` rather than a length check: a test may pre-seed a later hook,
      // leaving earlier indices as holes that must still get their default.
      if (!(i in hookState)) hookState[i] = typeof initial === "function" ? initial() : initial;
      return [hookState[i], (next) => { hookState[i] = typeof next === "function" ? next(hookState[i]) : next; }];
    },
    useRef(initial) {
      const i = hookIndex++;
      if (!(i in hookState)) hookState[i] = { current: initial };
      return hookState[i];
    },
    // useMemo/useCallback must actually memoize: loadAll is wrapped in
    // useCallback and consumed by a useEffect, so a fresh identity every
    // render would restart the load (and its state reset) forever.
    useMemo(fn, deps) { return memoize("memo", fn, deps, true); },
    useCallback(fn, deps) { return memoize("cb", fn, deps, false); },
    useEffect(fn, deps) {
      const slot = effectOrder.length++;
      if (sameDeps(effectDeps.get(slot), deps)) return undefined;
      effectDeps.set(slot, deps);
      try { return fn(); } catch (e) { failures.push(`useEffect threw: ${e.message}`); }
      return undefined;
    },
  };
  return { React, hooks };
}

function render(node, out = []) {
  if (node === null || node === undefined || node === false || node === true) return out;
  if (Array.isArray(node)) { node.forEach((n) => render(n, out)); return out; }
  if (typeof node === "string" || typeof node === "number") { out.push(String(node)); return out; }
  if (node && node.props && node.children) {
    // Include injected raw HTML, otherwise the rendered note body is invisible.
    const html = node.props.dangerouslySetInnerHTML;
    if (html && html.__html) out.push(String(html.__html));
    render(node.children, out);
  }
  return out;
}

// ─── DOM stub ─────────────────────────────────────────────────────────
function makeDom() {
  const head = { children: [], appendChild(el) { this.children.push(el); } };
  const byId = new Map();
  return {
    head,
    body: { appendChild() {} },
    getElementById(id) { return byId.get(id) || null; },
    createElement(tag) {
      return {
        tagName: tag,
        textContent: "",
        id: "",
        _append: null,
        setAttribute() {},
        appendChild(el) { this._append = el; byId.set(this.id, this); },
      };
    },
    querySelector() { return null; },
    addEventListener() {},
    removeEventListener() {},
  };
}

function run({ vaults, notes, folders, tags, graph, note }) {
  const { React, hooks } = makeRenderer();
  // Fresh per-run state: effect deps and hook slots must not leak between
  // cases, or the first effect of a new bundle would look already-run.
  effectDeps = new Map();
  memoDeps = new Map();
  memoValues = new Map();
  hookState.length = 0;
  const registered = [];
  const slotRegistrations = [];
  const calls = [];
  // A bare fetch() carries no session token, so the plugin's API routes would
  // 401. Record any use so the test can assert the bundle never takes that path.
  const fetchCalls = [];
  const bareFetch = (url) => { fetchCalls.push(String(url)); return Promise.reject(new Error("bare fetch used")); };

  const responses = {
    "/vaults": vaults,
    "/notes": notes,
    "/folders": folders,
    "/tags": tags,
    "/graph": graph,
  };
  const fetchJSON = (url) => {
    calls.push(url);
    const key = Object.keys(responses).find((k) => url.includes(k));
    if (url.includes("/notes/")) return Promise.resolve(note);
    if (url.includes("/refresh")) return Promise.resolve({ status: "ok" });
    return Promise.resolve(key ? responses[key] : null);
  };

  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    fetch: bareFetch,
    getComputedStyle: () => ({ getPropertyValue: () => " #4ade80 " }),
    document: makeDom(),
    window: {
      __HERMES_PLUGINS__: {
        register: (name, component) => registered.push({ name, component }),
        registerSlot: (plugin, slot, component) => slotRegistrations.push({ plugin, slot, component }),
      },
      __HERMES_PLUGIN_SDK__: {
        sdkVersion: "1.1.0",
        React,
        hooks,
        fetchJSON,
        authedFetch: () => Promise.resolve({}),
        buildWsUrl: () => Promise.resolve(""),
        components: {},
        utils: { cn: (...a) => a.filter(Boolean).join(" "), timeAgo: () => "", isoTimeAgo: () => "" },
        api: {},
      },
    },
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    ResizeObserver: class { observe() {} disconnect() {} },
    ResizeObserver: undefined,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: "plugin.js" });
  return { registered, slotRegistrations, calls, fetchCalls, React, hooks };
}

const SAMPLE_NOTES = [
  { path: "Index.md", name: "Index", folder: "root", word_count: 120, link_count: 2, tags: ["hub"], modified: 1756000000 },
  { path: "Notes/Status.md", name: "Status", folder: "Notes", word_count: 80, link_count: 1, tags: [], modified: 1756000100 },
];
const SAMPLE_NOTE = {
  name: "Index",
  path: "Index.md",
  folder: "root",
  size: 210,
  modified: 1756000000,
  tags: ["hub", "roadmap"],
  links: ["Status"],
  backlinks: ["Notes/Status.md"],
  content: "# Index\n\nSee [[Status]] and `code`.\n\n- [x] done\n",
  word_count: 5,
};
const SAMPLE_GRAPH = {
  nodes: [
    { id: "Index.md", label: "Index", folder: "root", size: 12 },
    { id: "Notes/Status.md", label: "Status", folder: "Notes", size: 10 },
  ],
  edges: [{ source: "Index.md", target: "Notes/Status.md" }],
};

// Hook order inside ObsidianPlugin(), as declared. The stub hooks are
// single-pass, so seeding a value means indexing this list.
const HOOK = {
  vaults: 0, currentVault: 1, notes: 2, folders: 3, tags: 4, graph: 5,
  selected: 6, content: 7, view: 11, loading: 12, editing: 13, editText: 14,
  saveStatus: 15, error: 16,
};

/** Deepest node whose text content contains `needle`, preferring children. */
function findByText(node, needle) {
  if (!node) return null;
  if (Array.isArray(node)) {
    for (const child of node) { const hit = findByText(child, needle); if (hit) return hit; }
    return null;
  }
  if (typeof node === "object" && node.props) {
    // Children first: an ancestor's text always contains its descendants',
    // so checking self first would always return the root.
    for (const child of node.children) { const hit = findByText(child, needle); if (hit) return hit; }
    if (render(node).join(" ").includes(needle)) return node;
  }
  return null;
}

/** Find a node by its `className` prop. */
function findByClass(node, className) {
  if (!node) return null;
  if (Array.isArray(node)) {
    for (const child of node) { const hit = findByClass(child, className); if (hit) return hit; }
    return null;
  }
  if (typeof node === "object" && node.props) {
    for (const child of node.children) { const hit = findByClass(child, className); if (hit) return hit; }
    if (node.props.className === className) return node;
  }
  return null;
}

/** Let the stub's resolved promises settle, then re-render. */
async function renderApp(component, { passes = 6, onSettled = null } = {}) {
  let text = "";
  let err = null;
  for (let i = 0; i < passes; i++) {
    hookIndex = 0;
    effectOrder = [];
    memoOrder = [];
    try {
      const tree = component();
      text = render(tree).join(" ");
    } catch (e) { err = e; break; }
    // Flush the fetchJSON promise chain so state settles between passes.
    await new Promise((resolve) => setImmediate(resolve));
    // `onSettled` simulates user interaction once the first data load has
    // landed. It cannot run earlier: loadAll() deliberately clears `selected`
    // when it (re)loads, exactly as it does in the real app. It may be a
    // single function (runs after pass 1) or a map of pass index -> function
    // for sequences that must wait for a later settle (e.g. opening the
    // editor after the note body has arrived).
    if (!onSettled) continue;
    if (typeof onSettled === "function") { if (i === 1) onSettled(); }
    else if (onSettled[i]) onSettled[i]();
  }
  return { text, err };
}

async function main() {
  console.log("\n== plugin.js (populated vault) ==");
  {
    const r = run({
      vaults: [
        { name: "TestVault", path: "/tmp/TestVault", note_count: 2 },
        { name: "OtherVault", path: "/tmp/OtherVault", note_count: 5 },
      ],
      notes: SAMPLE_NOTES, folders: [{ name: "root", count: 1 }], tags: [{ tag: "hub", count: 1 }],
      graph: SAMPLE_GRAPH, note: SAMPLE_NOTE,
    });
    check("registers exactly one component", r.registered.length === 1, `got ${r.registered.length}`);
    check("registers under the manifest name", r.registered[0] && r.registered[0].name === "obsidian-memory",
      r.registered[0] && r.registered[0].name);
    check("registers a function component", typeof r.registered[0].component === "function");

    hookState.length = 0;
    const { text, err } = await renderApp(r.registered[0].component);
    check("component renders without throwing", !err, err && `${err.name}: ${err.message}`);
    check("offers the vault switcher with more than one vault",
      text.includes("TestVault") && text.includes("OtherVault"), text.slice(0, 200));
    check("shows the note count summary", text.includes("2 notes"), text.slice(0, 200));
    check("lists note titles", text.includes("Index") && text.includes("Status"));
    check("lists the folder filter", text.includes("root"));
    check("requests data through the documented prefix",
      r.calls.length > 0 && r.calls.every((u) => u.startsWith("/api/plugins/obsidian-memory")),
      r.calls.join(" | "));
    check("loads notes, folders, tags and graph",
      ["/notes", "/folders", "/tags", "/graph"].every((p) => r.calls.some((u) => u.includes(p))),
      r.calls.join(" | "));
    check("never puts note content in a list request URL",
      !r.calls.some((u) => u.includes("content=")), r.calls.join(" | "));
  }

  console.log("\n== plugin.js (note selected) ==");
  {
    const r = run({
      vaults: [{ name: "TestVault", path: "/tmp/TestVault", note_count: 2 }],
      notes: SAMPLE_NOTES, folders: [{ name: "root", count: 1 }], tags: [{ tag: "hub", count: 1 }],
      graph: SAMPLE_GRAPH, note: SAMPLE_NOTE,
    });
    hookState.length = 0;
    // Simulate clicking the first note in the sidebar list.
    const { text, err } = await renderApp(r.registered[0].component, {
      onSettled: () => { hookState[HOOK.selected] = "Index.md"; },
    });
    check("renders the selected note without throwing", !err, err && `${err.name}: ${err.message}`);
    check("fetches the selected note", r.calls.some((u) => u.includes("/notes/Index.md")),
      r.calls.join(" | "));
    check("no error banner", hookState[HOOK.error] === "", String(hookState[HOOK.error]));
    check("shows the note title and body", text.includes("Index") && text.includes("See"), text.slice(0, 300));
    check("renders the backlink list", text.includes("Linked from") && text.includes("Status"),
      text.slice(0, 300));
    check("shows note tags", text.includes("#hub") && text.includes("#roadmap"));
    check("formats the modified timestamp", /\d{1,2}\s\w{3}\s\d{4}/.test(text), text.slice(0, 300));
    check("renders markdown into the viewer", text.includes("om-wikilink") || text.includes("om-p"),
      text.slice(0, 300));
  }

  console.log("\n== plugin.js (saving a note) ==");
  {
    const r = run({
      vaults: [{ name: "TestVault", path: "/tmp/TestVault", note_count: 2 }],
      notes: SAMPLE_NOTES, folders: [], tags: [], graph: SAMPLE_GRAPH, note: SAMPLE_NOTE,
    });
    hookState.length = 0;
    // Settle the initial load, select a note, then enter edit mode with a
    // body — the state a user reaches by clicking Edit and typing.
    let saveButton = null;
    const { text, err } = await renderApp(r.registered[0].component, {
      onSettled: {
        // Select the note; the selection effect re-runs and clears `editing`,
        // so the editor has to be entered on a later settle.
        1: () => { hookState[HOOK.selected] = "Index.md"; },
        3: () => {
          hookState[HOOK.editing] = true;
          hookState[HOOK.editText] = "# Index\n\nSaved by the user.\n";
        },
      },
    });
    check("renders the editor without throwing", !err, err && `${err.name}: ${err.message}`);

    // Drive the real Save button rather than calling saveEdit directly.
    const root = (() => { hookIndex = 0; effectOrder = []; memoOrder = []; return r.registered[0].component(); })();
    const editor = findByClass(root, "om-note-edit");
    check("shows the edit buffer in a textarea",
      !!editor && String(editor.props.value).includes("Saved by the user."),
      editor ? String(editor.props.value).slice(0, 80) : "no textarea found");

    saveButton = findByText(root, "Save");
    check("exposes a Save button", !!(saveButton && saveButton.props.onClick), "no Save button found");
    if (saveButton && saveButton.props.onClick) {
      await saveButton.props.onClick();
      await new Promise((resolve) => setImmediate(resolve));
      const put = r.calls.find((u) => u.includes("content=") && u.includes("/notes/"));
      check("saving issues a PUT through fetchJSON", !!put, r.calls.join(" | "));
      check("saving targets the selected note", !!put && put.includes("/notes/Index.md"), String(put));
      check("saving sends the edited body", !!put && decodeURIComponent(put).includes("Saved by the user."),
        String(put && decodeURIComponent(put).slice(0, 120)));
      check("never calls a bare window.fetch (it would 401)", r.fetchCalls.length === 0,
        r.fetchCalls.join(" | "));
    }
  }

  console.log("\n== plugin.js (empty vault) ==");  {
    const r = run({ vaults: [], notes: [], folders: [], tags: [], graph: { nodes: [], edges: [] }, note: null });
    hookState.length = 0;
    const { text, err } = await renderApp(r.registered[0].component);
    check("renders with no vaults", !err, err && `${err.name}: ${err.message}`);
    check("explains how to configure a vault",
      text.includes("No Obsidian vault found") && text.includes("OBSIDIAN_VAULT_PATH"), text.slice(0, 240));
  }

  console.log("\n== plugin.js (ambiguous wikilink target) ==");
  {
    const r = run({
      vaults: [{ name: "TestVault", path: "/tmp/TestVault", note_count: 1 }],
      notes: SAMPLE_NOTES, folders: [], tags: [], graph: SAMPLE_GRAPH, note: null,
    });
    hookState.length = 0;
    const { text, err } = await renderApp(r.registered[0].component, {
      onSettled: () => { hookState[HOOK.selected] = "README"; },
    });
    check("does not throw when a note cannot be opened", !err, err && `${err.name}: ${err.message}`);
    check("keeps rendering after a failed note open", text.includes("Obsidian Memory"), text.slice(0, 160));
  }

  console.log("\n== plugin.js (no SDK / no registry) ==");
  for (const [label, win] of [
    ["no registry", { __HERMES_PLUGIN_SDK__: { React: {}, hooks: {} } }],
    ["no SDK", { __HERMES_PLUGINS__: { register() {} } }],
  ]) {
    let threw = null;
    try {
      vm.runInContext(SOURCE, vm.createContext({ window: win, document: makeDom(), console }), { filename: "plugin.js" });
    } catch (e) { threw = e; }
    check(`degrades quietly with ${label}`, threw === null, threw && threw.message);
  }

  console.log("\n" + "=".repeat(60));
  if (failures.length) {
    console.log(`${failures.length} FAILURE(S):`);
    for (const f of failures) console.log("  -", f);
    process.exit(1);
  }
  console.log("All checks passed.");
}

main().catch((e) => { console.error(e); process.exit(1); });

console.log("\n" + "=".repeat(60));
if (failures.length) {
  console.log(`${failures.length} FAILURE(S):`);
  for (const f of failures) console.log("  -", f);
  process.exit(1);
}
console.log("All checks passed.");
