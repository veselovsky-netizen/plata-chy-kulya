// ============================================================
// NET — шар синхронізації.
// Якщо в firebase-config.js задано window.FIREBASE_CONFIG → Firebase RTDB.
// Інакше — локальний режим (localStorage + BroadcastChannel):
// працює між вкладками одного браузера, зручно для тестування.
// API: net.set(path,val) net.update(path,obj) net.get(path)
//      net.onValue(path,cb) net.push(path,val) net.mode
// Шляхи — рядки виду "teams/t1/cash" відносно кімнати.
// ============================================================
(function () {
  const params = new URLSearchParams(location.search);
  const ROOM = (params.get("room") || "main").replace(/[^a-zA-Z0-9_-]/g, "") || "main";

  // ---------- helpers ----------
  function pget(obj, path) {
    if (!path) return obj;
    let cur = obj;
    for (const k of path.split("/")) {
      if (cur == null) return null;
      cur = cur[k];
    }
    return cur === undefined ? null : cur;
  }
  function pset(obj, path, val) {
    const keys = path.split("/");
    let cur = obj;
    for (let i = 0; i < keys.length - 1; i++) {
      if (typeof cur[keys[i]] !== "object" || cur[keys[i]] === null) cur[keys[i]] = {};
      cur = cur[keys[i]];
    }
    if (val === null) delete cur[keys[keys.length - 1]];
    else cur[keys[keys.length - 1]] = val;
  }

  let net;

  if (window.FIREBASE_CONFIG && window.firebase) {
    // ---------- FIREBASE MODE ----------
    firebase.initializeApp(window.FIREBASE_CONFIG);
    const db = firebase.database();
    const root = () => db.ref("rooms/" + ROOM);
    const ref = (p) => (p ? root().child(p) : root());
    net = {
      mode: "firebase",
      room: ROOM,
      set: (p, v) => ref(p).set(v),
      update: (p, o) => ref(p).update(o),
      get: (p) => ref(p).get().then((s) => s.val()),
      push: (p, v) => root().child(p).push(v),
      onValue: (p, cb) => {
        const ref = p ? root().child(p) : root();
        const h = ref.on("value", (s) => cb(s.val()));
        return () => ref.off("value", h);
      },
      serverNow: () => Date.now(), // достатньо для таймерів на парі
    };
  } else {
    // ---------- LOCAL MODE ----------
    const KEY = "cartel_" + ROOM;
    const bc = ("BroadcastChannel" in window) ? new BroadcastChannel(KEY) : null;
    const listeners = []; // {path, cb}

    function load() {
      try { return JSON.parse(localStorage.getItem(KEY)) || {}; }
      catch (e) { return {}; }
    }
    function save(data) { localStorage.setItem(KEY, JSON.stringify(data)); }
    function notifyAll() {
      const data = load();
      for (const l of listeners) {
        try { l.cb(JSON.parse(JSON.stringify(pget(data, l.path)))); } catch (e) { console.error(e); }
      }
    }
    if (bc) bc.onmessage = notifyAll;
    window.addEventListener("storage", (e) => { if (e.key === KEY) notifyAll(); });

    function broadcast() { if (bc) bc.postMessage("upd"); notifyAll(); }

    net = {
      mode: "local",
      room: ROOM,
      set: (p, v) => {
        if (!p) { save(v && typeof v === "object" ? v : {}); broadcast(); return Promise.resolve(); }
        const d = load(); pset(d, p, v === undefined ? null : v); save(d); broadcast(); return Promise.resolve();
      },
      update: (p, o) => {
        const d = load();
        for (const k in o) pset(d, (p ? p + "/" : "") + k, o[k]);
        save(d); broadcast(); return Promise.resolve();
      },
      get: (p) => Promise.resolve(JSON.parse(JSON.stringify(pget(load(), p)))),
      push: (p, v) => {
        const id = "k" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
        const d = load(); pset(d, p + "/" + id, v); save(d); broadcast();
        return Promise.resolve({ key: id });
      },
      onValue: (p, cb) => {
        const l = { path: p, cb };
        listeners.push(l);
        // перший виклик одразу
        setTimeout(() => { try { cb(JSON.parse(JSON.stringify(pget(load(), p)))); } catch (e) {} }, 0);
        return () => { const i = listeners.indexOf(l); if (i >= 0) listeners.splice(i, 1); };
      },
      serverNow: () => Date.now(),
      _wipe: () => { save({}); broadcast(); },
    };
  }

  window.net = net;
})();
