// ============================================================
// «ПЛАН ЧИ ПРОГНОЗ» — рушій гри. Ролі: admin / projector / play
// Логіку гри виконує вкладка викладача (admin) — вона «движок».
// Телефони пишуть лише свої дії; проєктор — тільки показує.
// ============================================================
"use strict";

const P = new URLSearchParams(location.search);
const ROLE = P.get("role") || "home";
const CFG = {
  START_CASH: 5000,
  ROUNDS: 3,
  REWARD: { easy: { win: 500, lose: 250 }, mid: { win: 1000, lose: 500 }, deadly: { win: 2000, lose: 1000 } },
  BLANK_REWARD: 1500,
  Q_TIME: { easy: 60, mid: 90, deadly: 120, oralPrep: 120 },
  BET_AMTS: [300, 600],
  RAID_TIME: 30,
  RAID_OK: 100, RAID_BAD: 200,
  DUEL_PRIZE: 800,
  BAILOUT_AT: 300, BAILOUT_GIVE: 2000, BAILOUT_DEBT: 2600,
  TERR_BONUS: 1000,
};
const TEAM_DEFS = [
  { id: "c1", name: "Команда 1", icon: "🔴", color: "#FF4D5E" },
  { id: "c2", name: "Команда 2", icon: "🟠", color: "#FF8A1F" },
  { id: "c3", name: "Команда 3", icon: "🟡", color: "#FFD23F" },
  { id: "c4", name: "Команда 4", icon: "🟢", color: "#2FBF71" },
  { id: "c5", name: "Команда 5", icon: "🔵", color: "#3D8BFF" },
];
// Барабан: 6 гнізд по колу (за годинниковою стрілкою від верху)
const CHAMBERS = ["blank", "easy", "mid", "easy", "mid", "deadly"];
const SPIN_MS = 3800;
const LEVEL_UA = { easy: "Легке", mid: "Середнє", deadly: "Смертельне", blank: "Холостий" };
const LEVEL_ICON = { easy: "🟢", mid: "🟡", deadly: "🔴", blank: "⚪" };

// ---------- стан, який бачать усі ----------
let S = {};        // rooms/<room> повне дерево
let myPid = localStorage.getItem("cartel_pid_" + net.room);
if (!myPid) { myPid = "p" + Math.random().toString(36).slice(2, 9); localStorage.setItem("cartel_pid_" + net.room, myPid); }

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const money = (n) => "$" + (n | 0).toLocaleString("uk-UA");

function st() { return (S && S.state) || {}; }
function teams() { const t = (S && S.teams) || {}; const r = {}; for (const d of TEAM_DEFS) r[d.id] = { name: d.name, cash: CFG.START_CASH, dirty: 0, debt: 0, silenced: {}, ...(t[d.id] || {}) }; return r; }
function players() { return (S && S.players) || {}; }
function me() { return players()[myPid] || null; }
function myTeam() { const m = me(); return m && m.team ? teams()[m.team] : null; }
function teamMembers(tid) { const r = []; const pl = players(); for (const pid in pl) if (pl[pid].team === tid) r.push({ pid, ...pl[pid] }); r.sort((a, b) => (a.ts || 0) - (b.ts || 0)); return r; }
function activeTids() { const r = []; for (const d of TEAM_DEFS) if (teamMembers(d.id).length) r.push(d.id); return r; }
function netWorth(t) { return (t.cash | 0) + (t.dirty | 0) - (t.debt | 0); }
function isSilenced(tid, pid) { const t = teams()[tid]; return !!(t && st().round && t.silenced && t.silenced[pid] === st().round); }
function turnQueue() {
  const r = st().round; const taken = ((st().turnsTaken || {})[r]) || {};
  const ids = activeTids();
  const left = ids.filter((t) => !taken[t] && t !== st().turnTeam).sort((a, b) => netWorth(teams()[a]) - netWorth(teams()[b]));
  return { done: ids.filter((t) => taken[t]), cur: st().turnTeam, left };
}
function queueHTML() {
  const s = st(); if (!s.round || s.phase === "final") return "";
  const q = turnQueue(); const chip = (tid, cls) => { const d = TEAM_DEFS.find((x) => x.id === tid); return `<span class="qchip ${cls}" style="--tc:${d.color}">${d.icon} ${esc(teams()[tid].name)}</span>`; };
  return `<div class="queue"><div class="queue-title">Раунд ${s.round} з ${CFG.ROUNDS}: кожна команда ходить по разу</div>
    <div class="queue-row">${q.done.map((t) => chip(t, "done")).join("")}${q.cur && s.phase !== "between" ? chip(q.cur, "cur") : ""}${q.left.map((t) => chip(t, "left")).join("")}</div>
    <div class="queue-hint">✓ вже ходили · ▶ ходить зараз · далі — від найбіднішої команди</div></div>`;
}
const RULES_HTML = `<ol class="rules">
  <li>Відскануйте QR-код, введіть ім'я й оберіть команду (до 5 осіб). Перший у команді стає капітаном.</li>
  <li>Гра має 3 раунди. У кожному раунді команди ходять <b>по черзі</b>, кожна по одному разу. Першою ходить та, у якої найменше грошей.</li>
  <li>На своєму ході капітан обирає, хто відповідає. Цей гравець обирає тему й крутить барабан: барабан визначає складність питання. Холосте гніздо дає гроші без питання.</li>
  <li>Хто відповів — мовчить до кінця раунду, тож відповідатимуть усі. Поки ходить чужа команда, ваш капітан може поставити на її успіх чи провал.</li>
</ol>`;
function qById(qid) { for (const terr in QUESTIONS) for (const q of QUESTIONS[terr]) if (q.id === qid) return { ...q, terr }; return null; }
function terrDef(id) { return TERRITORIES.find((t) => t.id === id); }
function log(msg) { net.push("log", { t: Date.now(), msg }); }

// ============================================================
// ЗВУК (WebAudio, все синтезоване — файлів не треба)
// ============================================================
const AC = window.AudioContext || window.webkitAudioContext;
let audio = null;
function snd(kind) {
  try {
    if (!audio) audio = new AC();
    if (audio.state === "suspended") audio.resume();
    const t0 = audio.currentTime;
    const beep = (f, dt, dur, type = "square", vol = 0.12) => {
      const o = audio.createOscillator(), g = audio.createGain();
      o.type = type; o.frequency.value = f; o.connect(g); g.connect(audio.destination);
      g.gain.setValueAtTime(vol, t0 + dt); g.gain.exponentialRampToValueAtTime(0.001, t0 + dt + dur);
      o.start(t0 + dt); o.stop(t0 + dt + dur + 0.02);
    };
    const noise = (dt, dur, vol = 0.25) => {
      const n = audio.createBufferSource(), b = audio.createBuffer(1, audio.sampleRate * dur, audio.sampleRate);
      const d = b.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
      n.buffer = b; const g = audio.createGain(); g.gain.value = vol; n.connect(g); g.connect(audio.destination); n.start(t0 + dt);
    };
    if (kind === "click") beep(1200, 0, 0.04, "square", 0.08);
    if (kind === "spin") { const D = SPIN_MS / 1000; for (let k = 1; k <= 36; k++) { const p = k / 36; const t = D * (1 - Math.pow(1 - p, 0.45)); beep(1500, t, 0.018, "square", 0.06); beep(140, t, 0.03, "sine", 0.08); } }
    if (kind === "blank") { beep(500, 0, 0.05); beep(300, 0.07, 0.08); }
    if (kind === "shot") { noise(0, 0.25, 0.35); beep(90, 0, 0.3, "sawtooth", 0.25); }
    if (kind === "win") { beep(523, 0, 0.12, "triangle", 0.18); beep(659, 0.12, 0.12, "triangle", 0.18); beep(784, 0.24, 0.25, "triangle", 0.2); }
    if (kind === "lose") { beep(220, 0, 0.2, "sawtooth", 0.15); beep(160, 0.2, 0.35, "sawtooth", 0.15); }
    if (kind === "siren") for (let i = 0; i < 4; i++) { beep(700, i * 0.4, 0.2, "triangle", 0.2); beep(950, i * 0.4 + 0.2, 0.2, "triangle", 0.2); }
    if (kind === "coin") for (let i = 0; i < 8; i++) beep(1400 + (i % 2) * 300, i * 0.07, 0.05, "triangle", 0.1);
    if (kind === "tick") beep(1000, 0, 0.03, "sine", 0.1);
  } catch (e) {}
}
let lastSndKey = "";
function soundFromState() {
  const s = st();
  const key = (s.spin ? s.spin.status + (s.spin.result || "") : "") + "|" + (s.phase || "") + "|" + (s.revealData ? s.revealData.ts : "");
  if (key === lastSndKey) return; lastSndKey = key;
  if (s.spin && s.spin.status === "spinning") snd("spin");
  else if (s.spin && s.spin.status === "done") snd(s.spin.result === "blank" ? "blank" : "shot");
  if (s.phase === "raid") snd("siren");
  if (s.revealData && Date.now() - s.revealData.ts < 3000) snd(s.revealData.ok >= 0.5 ? "win" : "lose");
}

// ============================================================
// ОЦІНЮВАННЯ ВІДПОВІДЕЙ (частка правильності 0..1)
// ============================================================
function scoreAnswer(q, v) {
  if (v == null) return 0;
  if (q.type === "single") return v === q.correct ? 1 : 0;
  if (q.type === "multi") {
    const c = new Set(q.correct); let ok = 0;
    const vv = Array.isArray(v) ? v : [];
    for (const i of vv) if (c.has(i)) ok++; else ok--; // штраф за зайве
    return Math.max(0, ok) / q.correct.length;
  }
  if (q.type === "order") {
    const vv = Array.isArray(v) ? v : []; let ok = 0;
    for (let i = 0; i < q.items.length; i++) if (vv[i] === i) ok++;
    return ok / q.items.length;
  }
  if (q.type === "match") {
    const vv = Array.isArray(v) ? v : []; let ok = 0;
    for (let i = 0; i < q.pairs.length; i++) if (vv[i] === i) ok++;
    return ok / q.pairs.length;
  }
  if (q.type === "sort2") {
    const vv = Array.isArray(v) ? v : []; let ok = 0;
    for (let i = 0; i < q.items.length; i++) if (vv[i] === q.items[i][1]) ok++;
    return ok / q.items.length;
  }
  return 0;
}


// ============================================================
// ДІАЛОГИ НА СТОРІНЦІ (системні confirm/alert блокуються в деяких браузерах)
// ============================================================
function uiToast(text) {
  let box = document.getElementById("toasts");
  if (!box) { box = document.createElement("div"); box.id = "toasts"; box.setAttribute("role", "status"); document.body.appendChild(box); }
  const t = document.createElement("div"); t.className = "toast"; t.textContent = text; box.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}
function uiConfirm(text, okLabel) {
  return new Promise((resolve) => {
    const wrap = document.createElement("div"); wrap.className = "modal-wrap";
    wrap.innerHTML = `<div class="modal" role="dialog" aria-modal="true"><p class="modal-text"></p><div class="modal-btns"><button class="btn" data-a="no">Скасувати</button><button class="btn danger-btn" data-a="ok"></button></div></div>`;
    wrap.querySelector(".modal-text").textContent = text;
    wrap.querySelector('[data-a="ok"]').textContent = okLabel || "Так";
    const done = (v) => { wrap.remove(); resolve(v); };
    wrap.addEventListener("click", (e) => { const a = e.target.dataset && e.target.dataset.a; if (a) done(a === "ok"); else if (e.target === wrap) done(false); });
    document.body.appendChild(wrap);
    wrap.querySelector('[data-a="ok"]').focus();
  });
}

// ============================================================
// ДВИЖОК (виконується ЛИШЕ у вкладці admin)
// ============================================================
const E = {
  async newGame() {
    if (!(await uiConfirm("Почати нову гру? Гроші, бали й усі приєднані студенти обнуляться — їм доведеться зайти знову.", "Почати нову гру"))) return;
    const init = { state: { phase: "lobby", round: 0, usedQ: {}, turnsTaken: {} }, teams: {}, players: null, votes: null, answers: null, bets: null, influence: null, journal: null, log: null, nada: null };
    for (const d of TEAM_DEFS) init.teams[d.id] = { name: d.name, cash: CFG.START_CASH, dirty: 0, debt: 0, silenced: {} };
    net.set("", init);
  },
  startRound(r) {
    if (!activeTids().length) { uiToast("Ще ніхто не приєднався. Покажіть студентам QR-код на проєкторі й дочекайтеся команд."); return; }
    net.set("state/turnsTaken/" + r, null); // повторний запуск раунду — з чистого аркуша
    const upd = { "state/phase": "turn", "state/round": r, "state/turnTeam": null, "state/q": null, "state/spin": null, "state/revealData": null, "state/event": null };
    // омерта знімається на початку раунду (silenced зберігає номер раунду)
    net.update("", upd);
    log(`— РАУНД ${r} —`);
    E.nextTurn(r);
  },
  nextTurn(r) {
    r = r || st().round;
    const taken = (st().turnsTaken || {})[r] || {};
    const cand = activeTids().filter((t) => !taken[t]);
    if (!cand.length) { net.update("state", { phase: "between", turnTeam: null, q: null, spin: null }); log("Раунд завершено. Час подій Хефи!"); return; }
    cand.sort((a, b) => netWorth(teams()[a]) - netWorth(teams()[b])); // найбідніший ходить першим
    net.update("state", { phase: "turn", turnTeam: cand[0], shooter: null, q: null, spin: null, revealData: null, event: null });
    log(`Хід картелю «${teams()[cand[0]].name}»`);
  },
  setShooter(pid) {
    net.update("state", { shooter: pid, phase: "spin", spin: { status: "idle" } });
  },
  doSpin(terr) {
    // 6 гнізд: 1 холостий, 2 легкі, 2 середні, 1 смертельне
    const idx = Math.floor(Math.random() * 6);
    const result = CHAMBERS[idx];
    net.update("state", { terr, spin: { status: "spinning", idx, result: null, ts: Date.now() } });
    setTimeout(() => {
      const s = st();
      const tid = s.turnTeam;
      if (result === "blank") {
        net.update("state", { spin: { status: "done", idx, result: "blank", ts: Date.now() } });
        setTimeout(() => {
          E.applyMoney(tid, CFG.BLANK_REWARD, false, `⚪ Холостий! «${teams()[tid].name}» забирає ${money(CFG.BLANK_REWARD)} без питання`);
          E.markTurnDone(tid);
          net.update("state", { phase: "turn_end", revealData: { ok: 1, blank: true, delta: CFG.BLANK_REWARD, team: tid, ts: Date.now() } });
        }, 2200);
      } else {
        const q = E.pickQuestion(terr, result);
        if (!q) { log("Питання вичерпано, оберіть іншу територію"); net.update("state", { phase: "spin", spin: { status: "idle" } }); return; }
        net.update("state", { spin: { status: "done", idx, result, ts: Date.now() } });
        setTimeout(() => {
          const deadline = Date.now() + (q.type === "oral" ? CFG.Q_TIME.oralPrep : CFG.Q_TIME[result]) * 1000;
          net.update("", {
            ["state/usedQ/" + q.id]: true,
            "state/phase": "question",
            "state/q": { qid: q.id, terr, level: result, deadline, paused: null, oralReady: false },
          });
        }, 2200);
      }
    }, SPIN_MS + 150);
  },
  pickQuestion(terr, level) {
    const used = st().usedQ || {};
    const pool = QUESTIONS[terr].filter((q) => !used[q.id]);
    let cand = pool.filter((q) => q.level === level);
    if (!cand.length) cand = pool.filter((q) => q.level === (level === "deadly" ? "mid" : level === "easy" ? "mid" : "easy"));
    if (!cand.length) cand = pool;
    return cand.length ? cand[Math.floor(Math.random() * cand.length)] : null;
  },
  markTurnDone(tid) {
    const r = st().round;
    net.set("state/turnsTaken/" + r + "/" + tid, true);
  },
  // --- розкриття відповіді і розрахунок ---
  reveal(forcedOk) {
    const s = st(); if (!s.q) return;
    const q = qById(s.q.qid); const tid = s.turnTeam; const t = teams()[tid];
    let f;
    if (q.type === "oral") f = forcedOk ? 1 : 0;
    else {
      const ans = ((S.answers || {})[q.id] || {}).v;
      f = scoreAnswer(q, ans);
    }
    const rw = CFG.REWARD[s.q.level];
    let delta = 0, dirty = false, txt;
    if (f >= 0.999) { delta = rw.win; dirty = s.q.level === "deadly"; txt = `✅ Повна відповідь: +${money(delta)}${dirty ? " (брудні)" : ""}`; }
    else if (f >= 0.5) { delta = Math.round(rw.win / 2); txt = `🟡 Часткова відповідь (${Math.round(f * 100)}%): +${money(delta)}`; }
    else { delta = -rw.lose; txt = `❌ Провал: −${money(rw.lose)}`; }
    E.applyMoney(tid, delta, dirty, `«${t.name}»: ${txt}`);
    // вплив на територію
    if (f >= 0.999) net.set("influence/" + s.terr + "/" + tid, (((S.influence || {})[s.terr] || {})[tid] | 0) + 1);
    // омерта для стрільця
    if (s.shooter) net.set("teams/" + tid + "/silenced/" + s.shooter, s.round);
    // ставки інших картелів
    const bets = (S.bets || {})[q.id] || {};
    for (const btid in bets) {
      const b = bets[btid]; const bt = teams()[btid]; if (!bt) continue;
      if (f >= 0.5 && f < 0.999 && q.type !== "single") { log(`«${bt.name}»: ставку повернуто (часткова відповідь)`); continue; }
      const success = f >= 0.5;
      if (b.dir === "za") {
        if (success) E.applyMoney(btid, Math.round(b.amt * 0.8), false, `«${bt.name}» вірили — +${money(Math.round(b.amt * 0.8))}`);
        else E.applyMoney(btid, -b.amt, false, `«${bt.name}» вірили даремно — −${money(b.amt)}`);
      } else {
        if (!success) E.applyMoney(btid, b.amt, false, `«${bt.name}» ставили проти — +${money(b.amt)}`);
        else E.applyMoney(btid, -b.amt, false, `«${bt.name}» ставили проти та програли — −${money(b.amt)}`);
      }
    }
    // журнал: особисті голоси всіх, хто голосував
    const votes = (S.votes || {})[q.id] || {};
    for (const pid in votes) {
      if (q.type === "oral") continue;
      net.set("journal/" + pid + "/" + q.id, { ok: scoreAnswer(q, votes[pid].v), terr: s.terr, lvl: s.q.level });
    }
    if (s.shooter && q.type !== "oral") {
      const ans = ((S.answers || {})[q.id] || {}).v;
      net.set("journal/" + s.shooter + "/" + q.id, { ok: f, terr: s.terr, lvl: s.q.level, shooter: true });
    }
    E.markTurnDone(tid);
    net.update("state", { phase: "turn_end", q: null, revealData: { ok: f, qid: q.id, delta, team: tid, dirty, ts: Date.now(), canNada: f >= 0.999 && delta > 0 } });
  },
  applyMoney(tid, delta, dirty, msg) {
    const t = teams()[tid]; if (!t) return;
    if (dirty && delta > 0) net.set("teams/" + tid + "/dirty", (t.dirty | 0) + delta);
    else {
      let cash = (t.cash | 0) + delta;
      if (cash < 0) cash = 0;
      net.set("teams/" + tid + "/cash", cash);
      // санація
      if (cash < CFG.BAILOUT_AT && !t.debt) {
        net.update("teams/" + tid, { cash: cash + CFG.BAILOUT_GIVE, debt: CFG.BAILOUT_DEBT });
        log(`🏦 Санація: «${t.name}» отримує кризовий кредит ${money(CFG.BAILOUT_GIVE)}, борг ${money(CFG.BAILOUT_DEBT)}`);
      }
    }
    if (msg) log(msg);
  },
  payDebt(tid) {
    const t = teams()[tid];
    if (!t || !t.debt) return;
    if ((t.cash | 0) - t.debt < CFG.BAILOUT_AT) { log(`«${t.name}»: замало готівки для погашення боргу`); return; }
    net.update("teams/" + tid, { cash: (t.cash | 0) - t.debt, debt: 0 });
    log(`«${t.name}» погасили борг ${money(t.debt)} 💪`);
  },
  // --- Все або нічого ---
  nada(tid) {
    const rd = st().revealData; if (!rd || rd.team !== tid || !rd.canNada) return;
    const win = Math.random() < 0.5;
    const t = teams()[tid];
    const amt = rd.delta;
    if (win) E.applyMoney(tid, rd.dirty ? 0 : amt, rd.dirty, `🪙 ВСЕ АБО НІЧОГО: «${t.name}» подвоюють! +${money(amt)}`);
    else {
      if (rd.dirty) net.set("teams/" + tid + "/dirty", Math.max(0, (t.dirty | 0) - amt));
      else net.set("teams/" + tid + "/cash", Math.max(0, (t.cash | 0) - amt));
      log(`🪙 ВСЕ АБО НІЧОГО: «${t.name}» втрачають виграш −${money(amt)}`);
    }
    if (win && rd.dirty) net.set("teams/" + tid + "/dirty", (teams()[tid].dirty | 0) + amt);
    net.update("state", { revealData: { ...rd, canNada: false, nada: { win, ts: Date.now() } } });
  },
  // --- Облава ---
  startRaid() {
    const q = RAID_POOL[Math.floor(Math.random() * RAID_POOL.length)];
    net.update("state", { phase: "raid", event: { kind: "raid", q: q.q, a: q.a, expl: q.expl || "", deadline: Date.now() + CFG.RAID_TIME * 1000, id: "raid" + Date.now() }, prevPhase: st().phase });
    net.set("raidVotes", null);
    log("🚔 ОБЛАВА! 30 секунд на відповідь кожному!");
  },
  endRaid() {
    const ev = st().event; if (!ev || ev.kind !== "raid") return;
    const rv = S.raidVotes || {};
    const perTeam = {};
    for (const pid in players()) {
      const p = players()[pid]; if (!p.team) continue;
      const v = rv[pid];
      const ok = v != null && v === ev.a;
      perTeam[p.team] = perTeam[p.team] || { ok: 0, bad: 0 };
      ok ? perTeam[p.team].ok++ : perTeam[p.team].bad++;
    }
    for (const tid in perTeam) {
      const d = perTeam[tid].ok * CFG.RAID_OK - perTeam[tid].bad * CFG.RAID_BAD;
      E.applyMoney(tid, d, false, `🚔 «${teams()[tid].name}»: ${perTeam[tid].ok}✓/${perTeam[tid].bad}✗ → ${d >= 0 ? "+" : ""}${money(d)}`);
    }
    net.update("state", { phase: "between", event: { kind: "raid_result", a: ev.a, expl: ev.expl, perTeam, ts: Date.now() } });
  },
  // --- Лотерея ---
  loteria() {
    const c = LOTERIA_CARDS[Math.floor(Math.random() * LOTERIA_CARDS.length)];
    net.update("state", { event: { kind: "loteria", card: c, ts: Date.now() } });
    log(`🎴 Лотерея: ${c.icon} ${c.name} — ${c.text}`);
    const ts = teams();
    const ids = activeTids();
    const sorted = [...ids].sort((a, b) => netWorth(ts[b]) - netWorth(ts[a]));
    if (c.name === "El Dinero") for (const tid of ids) if (!ts[tid].debt) E.applyMoney(tid, 800, false, null);
    if (c.name === "La Muerte" && sorted[0]) E.applyMoney(sorted[0], -Math.round(ts[sorted[0]].cash * 0.1), false, null);
    if (c.name === "El Diablo") for (const tid of ids) E.applyMoney(tid, -Math.round(ts[tid].cash * 0.1), false, null);
    if (c.name === "El Sol" && sorted.length) E.applyMoney(sorted[sorted.length - 1], 1200, false, null);
    if (c.name === "El Banco") for (const tid of ids) if (ts[tid].dirty) { E.applyMoney(tid, ts[tid].dirty, false, null); net.set("teams/" + tid + "/dirty", 0); }
    if (c.name === "La Policía") setTimeout(() => E.startRaid(), 3500);
    if (c.name === "El Tren") net.set("state/doubleNext", true);
    // La Corona — вручну: Хефа сама проводить обмін кнопками ±
  },
  // --- Дуель ---
  startDuel(t1, t2) {
    const used = st().usedDuel || {};
    const pool = DUEL_POOL.map((q, i) => i).filter((i) => !used[i]);
    if (!pool.length) { log("Дуельні питання вичерпано"); return; }
    const qi = pool[Math.floor(Math.random() * pool.length)];
    net.set("duelAns", null);
    net.update("state", {
      phase: "duel", ["usedDuel/" + qi]: true,
      event: { kind: "duel", qi, t1, t2, deadline: Date.now() + 20000, id: "duel" + Date.now() },
    });
    log(`⚔️ ДУЕЛЬ: «${teams()[t1].name}» проти «${teams()[t2].name}»!`);
  },
  endDuel() {
    const ev = st().event; if (!ev || ev.kind !== "duel") return;
    const q = DUEL_POOL[ev.qi];
    const da = S.duelAns || {};
    let winner = null, best = Infinity;
    for (const tid of [ev.t1, ev.t2]) {
      const a = da[tid];
      if (a && a.v === q.correct && a.t < best) { best = a.t; winner = tid; }
    }
    if (winner) {
      const loser = winner === ev.t1 ? ev.t2 : ev.t1;
      const prize = Math.min(CFG.DUEL_PRIZE, teams()[loser].cash | 0);
      E.applyMoney(loser, -prize, false, null);
      E.applyMoney(winner, prize, false, `⚔️ «${teams()[winner].name}» виграли дуель: +${money(prize)} від суперника`);
    } else log("⚔️ Дуель без переможця — обидва промахнулися");
    net.update("state", { phase: "between", event: { kind: "duel_result", winner, correct: q.opts[q.correct], ts: Date.now() } });
  },
  // --- Відмивання ---
  startLavado() {
    const dirtyTeams = activeTids().filter((tid) => (teams()[tid].dirty | 0) > 0);
    if (!dirtyTeams.length) { log("Брудних грошей ні в кого немає"); return; }
    const used = st().usedLavado || {};
    const pool = LAVADO_POOL.map((q, i) => i).filter((i) => !used[i]);
    const qi = pool.length ? pool[Math.floor(Math.random() * pool.length)] : Math.floor(Math.random() * LAVADO_POOL.length);
    net.set("lavAns", null);
    net.update("state", {
      phase: "lavado", ["usedLavado/" + qi]: true,
      event: { kind: "lavado", qi, teams: dirtyTeams, deadline: Date.now() + 90000, id: "lav" + Date.now() },
    });
    log("🧺 ВІДМИВАННЯ: картелі з брудними грошима виконують завдання!");
  },
  endLavado() {
    const ev = st().event; if (!ev || ev.kind !== "lavado") return;
    const q = LAVADO_POOL[ev.qi];
    const la = S.lavAns || {};
    const res = {};
    for (const tid of ev.teams) {
      const t = teams()[tid];
      const f = scoreAnswer(q, (la[tid] || {}).v);
      if (f >= 0.999) { E.applyMoney(tid, t.dirty, false, `🧺 «${t.name}» відмили ${money(t.dirty)}!`); net.set("teams/" + tid + "/dirty", 0); res[tid] = "ok"; }
      else { const lost = Math.round(t.dirty / 2); net.set("teams/" + tid + "/dirty", t.dirty - lost); log(`🧺 «${t.name}» спалилися: конфісковано ${money(lost)}`); res[tid] = "fail"; }
    }
    net.update("state", { phase: "between", event: { kind: "lavado_result", res, expl: q.expl, ts: Date.now() } });
  },
  // --- Фінал ---
  final() {
    const inf = S.influence || {};
    const terrOwner = {};
    for (const t of TERRITORIES) {
      let best = null, bv = 0;
      for (const tid in inf[t.id] || {}) if (inf[t.id][tid] > bv) { bv = inf[t.id][tid]; best = tid; }
      terrOwner[t.id] = best;
    }
    const rows = activeTids().map((tid) => {
      const t = teams()[tid];
      const terrs = Object.keys(terrOwner).filter((k) => terrOwner[k] === tid);
      const total = (t.cash | 0) - (t.debt | 0) + terrs.length * CFG.TERR_BONUS; // брудні гроші у фінал НЕ йдуть
      return { tid, name: t.name, cash: t.cash | 0, dirty: t.dirty | 0, debt: t.debt | 0, terrs, total };
    }).sort((a, b) => b.total - a.total);
    net.update("state", { phase: "final", event: null, finalData: { rows, terrOwner, ts: Date.now() } });
    log(`👑 Фінал! Переможець — «${rows[0] ? rows[0].name : "?"}»`);
  },
  // --- CSV ---
  exportPlayers() {
    const jl = S.journal || {};
    let csv = "Студент;Команда;Відповідей;Правильно;Точність %;" + TERRITORIES.map((t) => t.sub.split(" · ")[0]).join(";") + "\n";
    for (const pid in players()) {
      const p = players()[pid];
      const j = jl[pid] || {};
      let n = 0, ok = 0; const per = { t1: [0, 0], t2: [0, 0], t3: [0, 0], t4: [0, 0] };
      for (const qid in j) { n++; ok += j[qid].ok; per[j[qid].terr][0] += j[qid].ok; per[j[qid].terr][1]++; }
      csv += `${p.name};${(teams()[p.team] || {}).name || "—"};${n};${ok.toFixed(1)};${n ? Math.round((ok / n) * 100) : 0};` +
        TERRITORIES.map((t) => per[t.id][1] ? Math.round((per[t.id][0] / per[t.id][1]) * 100) + "%" : "—").join(";") + "\n";
    }
    navigator.clipboard.writeText(csv).then(() => uiToast("Таблицю скопійовано. Вставте її в Excel або Google Таблиці."), () => uiToast("Не вдалося скопіювати. Дозвольте браузеру доступ до буфера обміну."));
  },
};

// авто-таймери (лише admin)
if (ROLE === "admin") setInterval(() => {
  const s = st(); const now = Date.now();
  if (s.phase === "question" && s.q && !s.q.paused && s.q.deadline && now > s.q.deadline) {
    const q = qById(s.q.qid);
    if (q.type !== "oral") E.reveal();
  }
  if (s.phase === "raid" && s.event && now > s.event.deadline) E.endRaid();
  if (s.phase === "duel" && s.event && now > s.event.deadline) E.endDuel();
  if (s.phase === "lavado" && s.event && now > s.event.deadline) E.endLavado();
}, 700);

// ============================================================
// РЕНДЕР
// ============================================================
let unsub = null;
function boot() {
  document.body.dataset.role = ROLE;
  unsub = net.onValue("", (data) => { S = data || {}; render(); soundFromState(); });
  document.addEventListener("click", () => { if (!audio && AC) try { audio = new AC(); } catch (e) {} }, { once: true });
  if (ROLE === "projector") setInterval(renderTimerOnly, 500);
  if (ROLE === "play") setInterval(renderTimerOnly, 500);
  if (ROLE === "admin") setInterval(renderTimerOnly, 500);
}
function renderTimerOnly() {
  const t = $("#timer"); if (!t) return;
  const s = st(); let dl = null;
  if (s.phase === "question" && s.q) dl = s.q.paused ? null : s.q.deadline;
  if (s.event && s.event.deadline && ["raid", "duel", "lavado"].includes(s.phase)) dl = s.event.deadline;
  if (!dl) { t.textContent = s.q && s.q.paused ? "⏸" : ""; return; }
  const left = Math.max(0, Math.ceil((dl - Date.now()) / 1000));
  t.textContent = "⏱ " + left + " с";
  t.classList.toggle("danger", left <= 10);
  if (left <= 5 && left > 0 && ROLE === "projector") snd("tick");
}

let renderPending = false;
function render() {
  const app = $("#app"); if (!app) return;
  // Поки студент вибирає в списку чи вводить текст — не перемальовуємо (інакше список закривається)
  const a = document.activeElement;
  if (a && app.contains(a) && (a.tagName === "SELECT" || a.tagName === "INPUT" || a.tagName === "TEXTAREA")) {
    if (!renderPending) { renderPending = true; a.addEventListener("blur", () => setTimeout(() => { renderPending = false; render(); }, 400), { once: true }); }
    return;
  }
  if (ROLE === "home") return renderHome(app);
  if (ROLE === "projector") return renderProjector(app);
  if (ROLE === "play") return renderPlay(app);
  if (ROLE === "admin") return renderAdmin(app);
}

// ---------- ГОЛОВНА ----------
function renderHome(app) {
  app.innerHTML = `
  <div class="home">
    <div class="papel"></div>
    <h1 class="title-big">ПЛАН ЧИ ПРОГНОЗ</h1>
    <div class="subtitle">Командна гра картелів з теми «Фінансове планування та прогнозування». Оберіть, з якого пристрою ви заходите.</div>
    <div class="home-cards">
      <a class="home-card" href="?role=projector&room=${net.room}"><div class="hc-icon">📽️</div><h3>Проєктор</h3><p>Великий екран аудиторії</p></a>
      <a class="home-card" href="?role=play&room=${net.room}"><div class="hc-icon">📱</div><h3>Студент</h3><p>Вхід із телефона</p></a>
      <a class="home-card" href="?role=admin&room=${net.room}"><div class="hc-icon">👑</div><h3>La Jefa</h3><p>Пульт викладача</p></a>
    </div>
    <div class="mode-badge">${net.mode === "firebase" ? "🟢 Онлайн (Firebase)" : "🟠 Локальний режим — вкладки одного браузера"}</div>
  </div>`;
}

// ---------- спільні шматки ----------
function leaderboardHTML(compact) {
  const ids = activeTids();
  const sorted = [...ids].sort((a, b) => netWorth(teams()[b]) - netWorth(teams()[a]));
  return `<div class="lb">` + sorted.map((tid, i) => {
    const t = teams()[tid]; const d = TEAM_DEFS.find((x) => x.id === tid);
    return `<div class="lb-row ${st().turnTeam === tid ? "turn" : ""}" style="--tc:${d.color}">
      <span class="lb-pos">${i + 1}</span><span class="lb-ico">${d.icon}</span>
      <span class="lb-name">${esc(t.name)}</span>
      <span class="lb-cash">${money(t.cash)}</span>
      ${t.dirty ? `<span class="lb-dirty" title="брудні гроші">🧺${money(t.dirty)}</span>` : ""}
      ${t.debt ? `<span class="lb-debt" title="борг">🏦−${money(t.debt)}</span>` : ""}
      ${compact ? "" : `<span class="lb-n">${teamMembers(tid).length} ос.</span>`}
    </div>`;
  }).join("") + `</div>`;
}
function territoriesHTML(clickable) {
  const inf = S.influence || {};
  return `<div class="terr-grid">` + TERRITORIES.map((t) => {
    let own = "", bv = 0;
    for (const tid in inf[t.id] || {}) if (inf[t.id][tid] > bv) { bv = inf[t.id][tid]; own = tid; }
    const d = TEAM_DEFS.find((x) => x.id === own);
    const used = st().usedQ || {};
    const left = QUESTIONS[t.id].filter((q) => !used[q.id]).length;
    return `<div class="terr ${clickable && left ? "clickable" : ""} ${left ? "" : "empty"}" data-terr="${t.id}" style="--oc:${d ? d.color : "transparent"}">
      <div class="terr-ico">${t.icon}</div><div class="terr-name">${t.name}</div>
      <div class="terr-sub">${t.sub}</div>
      <div class="terr-own">${d ? d.icon + " " + esc(teams()[own].name) : "нічия"}</div>
      <div class="terr-left">${left} питань</div>
    </div>`;
  }).join("") + `</div>`;
}
function barrelHTML() {
  const sp = st().spin || {};
  const spinning = sp.status === "spinning";
  const done = sp.status === "done";
  const idx = sp.idx | 0;
  const result = done ? sp.result : null;
  const target = 360 * 6 + ((360 - idx * 60) % 360); // гніздо idx зупиняється під бойком угорі
  const elapsed = spinning ? Math.max(0, Date.now() - (sp.ts || Date.now())) : 0;
  const COL = { blank: "#FFF3DC", easy: "#2FBF71", mid: "#FFA41B", deadly: "#E5007D" };
  const chambers = CHAMBERS.map((k, i) => {
    const a = (i * 60 - 90) * Math.PI / 180;
    const x = 100 + 52 * Math.cos(a), y = 100 + 52 * Math.sin(a);
    const hit = done && i === idx;
    return `<g class="ch ${hit ? "hit" : ""}"><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="21" fill="${COL[k]}" stroke="#0E0A24" stroke-width="4"/>
      <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="11" fill="#0E0A24" opacity=".85"/>
      <text x="${x.toFixed(1)}" y="${(y + 5).toFixed(1)}" text-anchor="middle" font-size="14" fill="#FFF3DC" font-weight="800">${k === "blank" ? "×" : k === "easy" ? "1" : k === "mid" ? "2" : "3"}</text></g>`;
  }).join("");
  // жолобки між гніздами — як на справжньому барабані
  const flutes = [0, 1, 2, 3, 4, 5].map((i) => {
    const a = (i * 60 - 60) * Math.PI / 180;
    return `<ellipse cx="${(100 + 82 * Math.cos(a)).toFixed(1)}" cy="${(100 + 82 * Math.sin(a)).toFixed(1)}" rx="7" ry="13" transform="rotate(${i * 60 - 60 + 90} ${(100 + 82 * Math.cos(a)).toFixed(1)} ${(100 + 82 * Math.sin(a)).toFixed(1)})" fill="#2A1D5C"/>`;
  }).join("");
  const style = spinning
    ? `--rot:${target}deg;--dur:${SPIN_MS}ms;animation-delay:-${Math.min(elapsed, SPIN_MS)}ms`
    : `transform:rotate(${done ? target : 0}deg)`;
  return `<div class="barrel-wrap">
    <div class="barrel ${done ? "landed" : ""}">
      <svg class="pin" viewBox="0 0 40 30" aria-hidden="true"><path d="M2 2 H38 L20 28 Z" fill="#FFF3DC" stroke="#0E0A24" stroke-width="4" stroke-linejoin="round"/></svg>
      <svg class="cyl ${spinning ? "spinning" : ""}" viewBox="0 0 200 200" style="${style}" role="img" aria-label="Барабан">
        <circle cx="100" cy="100" r="96" fill="#3B2D78" stroke="#0E0A24" stroke-width="6"/>
        ${flutes}
        ${chambers}
        <circle cx="100" cy="100" r="15" fill="#FFA41B" stroke="#0E0A24" stroke-width="4"/>
      </svg>
    </div>
    <div class="barrel-legend"><span>× холосте</span><span>1 легке</span><span>2 середнє</span><span>3 смертельне</span></div>
    ${result ? `<div class="barrel-result lvl-${result}">${LEVEL_ICON[result]} ${LEVEL_UA[result]}${result === "blank" ? " — без питання, +" + money(CFG.BLANK_REWARD) : ""}</div>` : spinning ? `<div class="barrel-result dim">Барабан крутиться…</div>` : ""}
  </div>`;
}
function questionBodyHTML(q, forRole, myAnswer) {
  let inner = "";
  const dis = forRole === "view" ? "disabled" : "";
  if (q.type === "single" || q.type === "multi") {
    inner = `<div class="opts">` + q.opts.map((o, i) => {
      const sel = Array.isArray(myAnswer) ? myAnswer.includes(i) : myAnswer === i;
      return `<button class="opt ${sel ? "sel" : ""}" data-i="${i}" ${dis}>${"АБВГД"[i] || i + 1}. ${esc(o)}</button>`;
    }).join("") + `</div>` + (q.type === "multi" ? `<div class="hint">Обери ${q.need} варіанти</div>` : "");
  }
  if (q.type === "order") {
    const ord = Array.isArray(myAnswer) && myAnswer.length === q.items.length ? myAnswer : q.items.map((_, i) => i);
    inner = `<div class="order-list">` + ord.map((idx, pos) => `
      <div class="order-item"><span class="order-num">${pos + 1}</span><span>${esc(q.items[idx])}</span>
      ${forRole === "view" ? "" : `<span class="order-btns"><button class="ob" data-pos="${pos}" data-dir="-1">▲</button><button class="ob" data-pos="${pos}" data-dir="1">▼</button></span>`}</div>`).join("") + `</div>`;
  }
  if (q.type === "match") {
    const sel = Array.isArray(myAnswer) ? myAnswer : q.pairs.map(() => null);
    inner = `<div class="match-list">` + q.pairs.map((p, i) => `
      <div class="match-row"><div class="match-left">${esc(p[0])}</div>
      <select class="match-sel" data-i="${i}" ${dis}><option value="">— обери —</option>${q.pairs.map((pp, j) => `<option value="${j}" ${sel[i] === j ? "selected" : ""}>${esc(pp[1])}</option>`).join("")}</select></div>`).join("") + `</div>`;
  }
  if (q.type === "sort2") {
    const sel = Array.isArray(myAnswer) ? myAnswer : q.items.map(() => null);
    inner = `<div class="sort2-head"><span>A: ${esc(q.colA)}</span><span>B: ${esc(q.colB)}</span></div><div class="sort2-list">` + q.items.map((it, i) => `
      <div class="sort2-row"><span>${esc(it[0])}</span><span class="s2btns">
      <button class="s2 ${sel[i] === "A" ? "sel" : ""}" data-i="${i}" data-v="A" ${dis}>A</button>
      <button class="s2 ${sel[i] === "B" ? "sel" : ""}" data-i="${i}" data-v="B" ${dis}>B</button></span></div>`).join("") + `</div>`;
  }
  if (q.type === "oral") inner = `<div class="oral-note">🎤 Усна відповідь. Команда готує аргументи й відповідає Хефі вголос.</div>`;
  return inner;
}

// ---------- ПРОЄКТОР ----------
function renderProjector(app) {
  const s = st();
  let main = "";
  const playURL = location.origin + location.pathname + "?role=play&room=" + net.room;
  if (!s.phase || s.phase === "lobby") {
    main = `<div class="proj-lobby">
      <h1 class="title-big">ПЛАН ЧИ ПРОГНОЗ</h1>
      <div class="lobby-grid"><div class="qr-box"><div id="qrcode"></div><div class="qr-url">${esc(playURL)}</div></div>
      <div class="lobby-rules"><h2>Як грати</h2>${RULES_HTML}</div></div>
      <div class="lobby-teams">${TEAM_DEFS.map((d) => {
        const ms = teamMembers(d.id);
        return `<div class="lob-team" style="--tc:${d.color}"><div class="lt-head">${d.icon} ${esc((teams()[d.id] || d).name)}</div>
        ${ms.map((m) => `<div class="lt-m">${esc(m.name)}${(teams()[d.id] || {}).captain === m.pid ? " 👑" : ""}</div>`).join("") || `<div class="lt-m dim">— вільно —</div>`}</div>`;
      }).join("")}</div></div>`;
  } else if (s.phase === "final" && s.finalData) {
    const r = s.finalData.rows;
    main = `<div class="podium-wrap"><h1 class="title-big">EL CÁRTEL SUPREMO</h1><div class="podium">
      ${[1, 0, 2].map((pos) => r[pos] ? `<div class="pod pod-${pos}"><div class="pod-ico">${TEAM_DEFS.find((d) => d.id === r[pos].tid).icon}</div>
        <div class="pod-name">${esc(r[pos].name)}</div><div class="pod-cash">${money(r[pos].total)}</div>
        <div class="pod-terr">${r[pos].terrs.map((t) => terrDef(t).icon).join(" ") || ""}</div>
        <div class="pod-base">${["🥇", "🥈", "🥉"][pos]}</div></div>` : "").join("")}
    </div>
    <div class="final-rest">${r.slice(3).map((x, i) => `<div>${i + 4}. ${esc(x.name)} — ${money(x.total)}</div>`).join("")}</div></div>`;
  } else {
    // ігрові фази
    const t = s.turnTeam ? teams()[s.turnTeam] : null;
    const d = s.turnTeam ? TEAM_DEFS.find((x) => x.id === s.turnTeam) : null;
    let center = "";
    if (s.phase === "turn") center = `<div class="center-msg">${d ? d.icon : ""} Ходить <b style="color:${d ? d.color : "#fff"}">${t ? esc(t.name) : ""}</b><br><span class="dim">Капітан обирає на телефоні, хто відповідатиме</span></div>${territoriesHTML(false)}`;
    if (s.phase === "spin") {
      const shooterName = s.shooter && players()[s.shooter] ? players()[s.shooter].name : "?";
      center = (s.spin && s.spin.status !== "idle") ? barrelHTML() : `<div class="center-msg">🔫 Стрілець — <b>${esc(shooterName)}</b><br><span class="dim">Обирає територію та крутить барабан…</span></div>${territoriesHTML(false)}`;
    }
    if (s.phase === "question" && s.q) {
      const q = qById(s.q.qid);
      const bets = (S.bets || {})[q.id] || {};
      center = `<div class="q-card proj">
        <div class="q-meta">${terrDef(s.terr).icon} ${terrDef(s.terr).name} · ${LEVEL_ICON[s.q.level]} ${LEVEL_UA[s.q.level]} · відповідає «${esc(t.name)}»</div>
        <div class="q-text">${esc(q.q)}</div>
        ${questionBodyHTML(q, "view")}
        ${q.type === "oral" && s.q.oralReady ? `<div class="oral-ready">🎤 Команда готова відповідати!</div>` : ""}
        <div class="bets-strip">${Object.keys(bets).map((btid) => {
          const bd = TEAM_DEFS.find((x) => x.id === btid);
          return `<span class="bet-chip" style="--tc:${bd.color}">${bd.icon} ${bets[btid].dir === "za" ? "ЗА" : "ПРОТИ"} ${money(bets[btid].amt)}</span>`;
        }).join("") || `<span class="dim">Інші картелі можуть робити ставки…</span>`}</div>
      </div>`;
    }
    if (s.phase === "turn_end" && s.revealData) {
      const rd = s.revealData;
      const q = rd.qid ? qById(rd.qid) : null;
      center = `<div class="reveal ${rd.ok >= 0.999 ? "good" : rd.ok >= 0.5 ? "part" : "bad"}">
        <div class="reveal-big">${rd.blank ? "⚪ ХОЛОСТИЙ!" : rd.ok >= 0.999 ? "✅ ПРАВИЛЬНО!" : rd.ok >= 0.5 ? "🟡 ЧАСТКОВО (" + Math.round(rd.ok * 100) + "%)" : "💥 ПРОВАЛ!"}</div>
        <div class="reveal-delta">${rd.delta >= 0 ? "+" : ""}${money(rd.delta)}${rd.dirty ? " 🧺 (треба відмити!)" : ""}</div>
        ${rd.nada ? `<div class="nada-res">🪙 Все або нічого: ${rd.nada.win ? "ПОДВОЄННЯ!" : "ВСЕ ЗГОРІЛО!"}</div>` : ""}
        ${q && q.expl ? `<div class="reveal-expl">${esc(q.expl)}</div>` : ""}
      </div>`;
    }
    if (s.phase === "raid" && s.event) center = `<div class="raid-card"><div class="raid-head">🚔 ОБЛАВА ПОЛІЦІЇ 🚔</div><div class="q-text">${esc(s.event.q)}</div><div class="raid-sub">Кожен відповідає на СВОЄМУ телефоні: ТАК чи НІ!</div></div>`;
    if (s.event && s.event.kind === "raid_result") center = `<div class="raid-card done"><div class="raid-head">Облаву завершено</div><div class="q-text">Правильна відповідь: <b>${s.event.a ? "ТАК" : "НІ"}</b></div>${s.event.expl ? `<div class="reveal-expl">${esc(s.event.expl)}</div>` : ""}</div>`;
    if (s.phase === "duel" && s.event) {
      const q = DUEL_POOL[s.event.qi];
      const n1 = teams()[s.event.t1], n2 = teams()[s.event.t2];
      center = `<div class="duel-card"><div class="duel-head">⚔️ «${esc(n1.name)}» проти «${esc(n2.name)}» ⚔️</div><div class="q-text">${esc(q.q)}</div><div class="raid-sub">Хто ШВИДШЕ правильно відповість на телефоні!</div></div>`;
    }
    if (s.event && s.event.kind === "duel_result") center = `<div class="duel-card done"><div class="duel-head">${s.event.winner ? "🏆 Перемога «" + esc(teams()[s.event.winner].name) + "»!" : "Обидва промахнулись"}</div><div class="q-text">Відповідь: ${esc(s.event.correct)}</div></div>`;
    if (s.phase === "lavado" && s.event) {
      const q = LAVADO_POOL[s.event.qi];
      center = `<div class="lav-card"><div class="lav-head">🧺 ВІДМИВАННЯ ГРОШЕЙ</div><div class="q-text">${esc(q.q)}</div><div class="raid-sub">Відповідають картелі: ${s.event.teams.map((tid) => teams()[tid].name).join(", ")}</div></div>`;
    }
    if (s.event && s.event.kind === "loteria") center = `<div class="loteria-card"><div class="lot-ico">${s.event.card.icon}</div><div class="lot-name">${esc(s.event.card.name)}</div><div class="lot-text">${esc(s.event.card.text)}</div></div>`;
    if (s.phase === "between" && (!s.event || ["raid_result", "duel_result", "lavado_result"].includes(s.event.kind) === false) && !center) center = `<div class="center-msg">Раунд ${s.round} завершено.<br><span class="dim">La Jefa вирішує, що далі…</span></div>${territoriesHTML(false)}`;
    if (!center) center = territoriesHTML(false);

    main = `<div class="proj-game">
      <div class="proj-top"><span class="round-badge">Раунд ${s.round || "—"}/${CFG.ROUNDS}</span><span class="title-small">План чи Прогноз</span><span id="timer" class="timer"></span></div>
      <div class="proj-main">${center}</div>
      <div class="proj-side">${queueHTML()}${leaderboardHTML(true)}<div class="log-box">${Object.values(S.log || {}).sort((a, b) => b.t - a.t).slice(0, 6).map((l) => `<div class="log-line">${esc(l.msg)}</div>`).join("")}</div></div>
    </div>`;
  }
  app.innerHTML = `<div class="papel"></div>` + main;
  if ((!s.phase || s.phase === "lobby") && window.QRCode) {
    const qel = $("#qrcode"); if (qel) { qel.innerHTML = ""; new QRCode(qel, { text: playURL, width: 200, height: 200, colorDark: "#0E0A24", colorLight: "#FFF3DC" }); }
  }
}

// ---------- ТЕЛЕФОН СТУДЕНТА ----------
let draftAnswer = null, draftQid = null;
function renderPlay(app) {
  const s = st(); const m = me();
  // --- вхід ---
  if (!m || !m.team) {
    app.innerHTML = `<div class="papel"></div><div class="join">
      <h2 class="title-small">План чи Прогноз</h2>
      <input id="pname" class="inp" maxlength="24" placeholder="Твоє ім'я та прізвище" value="${esc((me() || {}).name || "")}">
      <div class="join-teams">${TEAM_DEFS.map((d) => {
        const n = teamMembers(d.id).length;
        return `<button class="jt ${n >= 5 ? "full" : ""}" data-t="${d.id}" style="--tc:${d.color}" ${n >= 5 ? "disabled" : ""}>${d.icon} ${esc((teams()[d.id] || d).name)} <span class="jt-n">${n}/5</span></button>`;
      }).join("")}</div></div>`;
    app.querySelectorAll(".jt").forEach((b) => b.onclick = () => {
      const name = $("#pname").value.trim();
      if (!name) { $("#pname").focus(); return; }
      const tid = b.dataset.t;
      net.set("players/" + myPid, { name, team: tid, ts: Date.now() });
      if (!(teams()[tid] || {}).captain) net.set("teams/" + tid + "/captain", myPid);
      snd("click");
    });
    return;
  }
  const tid = m.team; const t = teams()[tid] || {}; const d = TEAM_DEFS.find((x) => x.id === tid);
  const isCap = t.captain === myPid;
  const silenced = isSilenced(tid, myPid);
  const myTurn = s.turnTeam === tid;
  const shooter = s.shooter === myPid;

  let body = "";
  // --- лобі ---
  if (!s.phase || s.phase === "lobby") {
    body = `<div class="center-msg">Ти в команді «${esc(t.name)}»!<br><span class="dim">Чекаємо, поки викладач почне гру.</span></div>
    ${isCap ? `<div class="cap-tools"><label class="small dim" for="tname">Ти капітан. Можеш дати команді назву:</label><input id="tname" class="inp" maxlength="18" value="${esc(t.name)}"><button class="btn" id="rename">Зберегти назву</button></div>` : ""}
    <details class="rules-box"><summary>Як грати</summary>${RULES_HTML}</details>`;
  }
  // --- вибір стрільця (тільки капітан, свій хід) ---
  else if (s.phase === "turn" && myTurn && isCap) {
    const ms = teamMembers(tid).filter((x) => !isSilenced(tid, x.pid));
    body = `<div class="phase-head">🔫 Обери стрільця</div><div class="dim small">Хто відповів — мовчить до кінця раунду (омерта)</div>
    <div class="shooter-list">${ms.map((x) => `<button class="btn shooter-btn" data-p="${x.pid}">${esc(x.name)}${x.pid === myPid ? " (я)" : ""}</button>`).join("") || "<div>Усі в омерті! Хефа, пропустіть хід."}</div>`;
  }
  else if (s.phase === "turn" && myTurn) body = `<div class="center-msg">Твій картель ходить!<br><span class="dim">Капітан обирає стрільця…</span></div>`;
  else if (s.phase === "turn") body = `<div class="center-msg">Ходить «${esc((teams()[s.turnTeam] || {}).name || "")}»</div>`;
  // --- спін ---
  else if (s.phase === "spin") {
    if (shooter && (!s.spin || s.spin.status === "idle")) {
      body = `<div class="phase-head">Обери територію і тисни на барабан</div>${territoriesHTML(true)}
      <button class="btn big danger-btn" id="spinBtn" disabled>🔫 КРУТИТИ БАРАБАН</button><div class="dim small" id="spinHint">Спершу обери територію</div>`;
    } else body = (s.spin && s.spin.status !== "idle") ? barrelHTML() : `<div class="center-msg">${myTurn ? "Стрілець обирає територію…" : "Ходить «" + esc((teams()[s.turnTeam] || {}).name || "") + "»"}</div>`;
  }
  // --- питання ---
  else if (s.phase === "question" && s.q) {
    const q = qById(s.q.qid);
    if (draftQid !== q.id) { draftQid = q.id; draftAnswer = null; }
    if (myTurn) {
      const canAct = (shooter || !silenced) && q.type !== "oral";
      const myVote = shooter ? draftAnswer : (((S.votes || {})[q.id] || {})[myPid] || {}).v != null ? ((S.votes || {})[q.id] || {})[myPid].v : draftAnswer;
      body = `<div class="q-card">
        <div class="q-meta">${terrDef(s.terr).icon} ${LEVEL_ICON[s.q.level]} ${LEVEL_UA[s.q.level]}</div>
        <div class="q-text">${esc(q.q)}</div>
        ${questionBodyHTML(q, canAct ? "act" : "view", draftAnswer)}
        ${q.type === "oral"
          ? (shooter ? `<button class="btn big" id="oralReady" ${s.q.oralReady ? "disabled" : ""}>${s.q.oralReady ? "Чекаємо Хефу…" : "🎤 МИ ГОТОВІ ВІДПОВІДАТИ"}</button>` : `<div class="dim">Готуйте аргументи разом!</div>`)
          : shooter
            ? `<button class="btn big danger-btn" id="submitFinal">✅ ФІНАЛЬНА ВІДПОВІДЬ КАРТЕЛЮ</button>
               <div class="advice">${teamMembers(tid).filter((x) => x.pid !== myPid && ((S.votes || {})[q.id] || {})[x.pid]).map((x) => `<div class="adv-row">💬 ${esc(x.name)} проголосував(ла)</div>`).join("")}</div>`
            : silenced
              ? `<div class="omerta">🤫 Омерта: ти вже відповідав — мовчи до кінця раунду</div>`
              : `<button class="btn" id="sendVote">💬 Надіслати пораду стрільцю</button><div class="dim small">Стрілець побачить твій варіант</div>`}
      </div>`;
    } else {
      // ставки інших картелів
      const myBet = ((S.bets || {})[q.id] || {})[tid];
      body = `<div class="q-card">
        <div class="q-meta">Відповідає «${esc((teams()[s.turnTeam] || {}).name || "")}»</div>
        <div class="q-text">${esc(q.q)}</div>
        ${isCap ? (myBet ? `<div class="bet-done">Ставка зроблена: ${myBet.dir === "za" ? "ЗА" : "ПРОТИ"} ${money(myBet.amt)}</div>` :
          `<div class="phase-head">💸 Ставки</div><div class="bet-grid">
            ${CFG.BET_AMTS.map((a) => `<button class="btn bet-btn za" data-dir="za" data-amt="${a}">ЗА +80%<br>${money(a)}</button>`).join("")}
            ${CFG.BET_AMTS.map((a) => `<button class="btn bet-btn pr" data-dir="pr" data-amt="${a}">ПРОТИ +100%<br>${money(a)}</button>`).join("")}
          </div><div class="dim small">Вгадаєш — заробиш. Ні — втратиш ставку.</div>`) : `<div class="dim">Капітан може зробити ставку за/проти</div>`}
      </div>`;
    }
  }
  // --- результат ---
  else if (s.phase === "turn_end" && s.revealData) {
    const rd = s.revealData;
    body = `<div class="reveal ${rd.ok >= 0.999 ? "good" : rd.ok >= 0.5 ? "part" : "bad"}">
      <div class="reveal-big">${rd.blank ? "⚪ ХОЛОСТИЙ!" : rd.ok >= 0.999 ? "✅ ПРАВИЛЬНО" : rd.ok >= 0.5 ? "🟡 ЧАСТКОВО" : "💥 ПРОВАЛ"}</div>
      ${rd.team === tid ? `<div class="reveal-delta">${rd.delta >= 0 ? "+" : ""}${money(rd.delta)}${rd.dirty ? " 🧺" : ""}</div>` : ""}
      ${rd.team === tid && isCap && rd.canNada ? `<button class="btn big danger-btn" id="nadaBtn">🪙 ВСЕ АБО НІЧОГО (подвоїти чи втратити)</button>` : ""}
      ${rd.nada ? `<div class="nada-res">🪙 ${rd.nada.win ? "ПОДВОЄННЯ!" : "Втрачено все…"}</div>` : ""}
    </div>`;
  }
  // --- облава ---
  else if (s.phase === "raid" && s.event) {
    const myV = (S.raidVotes || {})[myPid];
    body = `<div class="raid-card"><div class="raid-head">🚔 ОБЛАВА</div><div class="q-text">${esc(s.event.q)}</div>
    ${myV != null ? `<div class="bet-done">Твоя відповідь: ${myV ? "ТАК" : "НІ"}</div>` : `<div class="yn"><button class="btn big yes" id="rYes">ТАК</button><button class="btn big no" id="rNo">НІ</button></div>`}</div>`;
  }
  // --- дуель ---
  else if (s.phase === "duel" && s.event) {
    const q = DUEL_POOL[s.event.qi];
    const inDuel = [s.event.t1, s.event.t2].includes(tid);
    const already = ((S.duelAns || {})[tid] || {}).by;
    body = `<div class="duel-card"><div class="duel-head">⚔️ ДУЕЛЬ</div><div class="q-text">${esc(q.q)}</div>
    ${inDuel && isCap && !already ? `<div class="opts">${q.opts.map((o, i) => `<button class="opt" data-duel="${i}">${esc(o)}</button>`).join("")}</div>` :
      inDuel ? `<div class="dim">${already ? "Відповідь надіслано!" : "Відповідає капітан!"}</div>` : `<div class="dim">Спостерігаємо…</div>`}</div>`;
  }
  // --- відмивання ---
  else if (s.phase === "lavado" && s.event) {
    const q = { ...LAVADO_POOL[s.event.qi], id: "lav" };
    const inLav = s.event.teams.includes(tid);
    if (draftQid !== s.event.id) { draftQid = s.event.id; draftAnswer = null; }
    const already = ((S.lavAns || {})[tid] || {}).by;
    body = `<div class="lav-card"><div class="lav-head">🧺 ВІДМИВАННЯ · ${money(t.dirty)}</div><div class="q-text">${esc(q.q)}</div>
    ${inLav && isCap && !already ? questionBodyHTML(q, "act", draftAnswer) + `<button class="btn big" id="lavSubmit">✅ Відмити</button>` :
      inLav ? `<div class="dim">${already ? "Надіслано!" : "Відповідає капітан — радьте йому вголос!"}</div>` : `<div class="dim">У вас чисті гроші 😇</div>`}</div>`;
  }
  else if (s.phase === "final" && s.finalData) {
    const row = s.finalData.rows.find((r) => r.tid === tid);
    const pos = s.finalData.rows.indexOf(row) + 1;
    body = `<div class="center-msg">${pos === 1 ? "👑 ВИ — EL CÁRTEL SUPREMO!" : pos + "-ме місце"}<br><b>${money(row ? row.total : 0)}</b></div>`;
  }
  else body = `<div class="center-msg">Раунд ${s.round || ""}<br><span class="dim">Чекаємо на Хефу…</span></div>`;

  // моя статистика по темах
  const j = (S.journal || {})[myPid] || {};
  let n = 0, ok = 0; for (const k in j) { n++; ok += j[k].ok; }

  app.innerHTML = `<div class="papel"></div><div class="play">
    <div class="play-top" style="--tc:${d.color}">
      <span>${d.icon} ${esc(t.name)}</span>
      <span class="play-cash">${money(t.cash)}${t.dirty ? " 🧺" + money(t.dirty) : ""}${t.debt ? " 🏦−" + money(t.debt) : ""}</span>
      <span id="timer" class="timer"></span>
      <button class="exit" id="exitBtn" title="Вийти з команди">✕</button>
    </div>
    ${nowBanner(s, tid, isCap, myTurn, shooter, silenced)}
    <div class="play-body">${body}</div>
    <div class="play-foot">${esc(m.name)}${isCap ? " 👑 капітан" : ""}${silenced ? " · 🤫 омерта" : ""} · точність: ${n ? Math.round((ok / n) * 100) + "%" : "—"}
    ${isCap && t.debt && (t.cash - t.debt) >= CFG.BAILOUT_AT ? `<button class="btn mini" id="payDebt">Погасити борг</button>` : ""}</div>
  </div>`;

  // --- обробники ---
  $("#exitBtn") && ($("#exitBtn").onclick = async () => {
    if (!(await uiConfirm("Вийти з команди? Місце звільниться, і ти зможеш обрати іншу.", "Вийти"))) return;
    net.set("players/" + myPid, null);
    if (isCap) { const rest = teamMembers(tid).filter((x) => x.pid !== myPid); net.set("teams/" + tid + "/captain", rest.length ? rest[0].pid : null); }
  });
  $("#rename") && ($("#rename").onclick = () => { const v = $("#tname").value.trim(); if (v) net.set("teams/" + tid + "/name", v); });
  $("#payDebt") && ($("#payDebt").onclick = () => E.payDebt(tid));
  app.querySelectorAll(".shooter-btn").forEach((b) => b.onclick = () => { E.setShooter(b.dataset.p); snd("click"); });
  // вибір території + спін (стрілець)
  let chosenTerr = null;
  app.querySelectorAll(".terr.clickable").forEach((b) => b.onclick = () => {
    chosenTerr = b.dataset.terr;
    app.querySelectorAll(".terr").forEach((x) => x.classList.toggle("picked", x === b));
    const sb = $("#spinBtn"); if (sb) { sb.disabled = false; $("#spinHint").textContent = "Територія: " + terrDef(chosenTerr).name; }
    snd("click");
  });
  $("#spinBtn") && ($("#spinBtn").onclick = () => { if (chosenTerr) { E.doSpin(chosenTerr); snd("click"); } });
  // відповіді
  bindAnswerInputs(app, s);
  $("#submitFinal") && ($("#submitFinal").onclick = () => {
    const q = qById(s.q.qid);
    if (draftAnswer == null) { uiToast("Спершу обери відповідь"); return; }
    if (q.type === "multi" && (!Array.isArray(draftAnswer) || draftAnswer.length !== q.need)) { uiToast("Треба обрати рівно " + q.need); return; }
    net.set("answers/" + q.id, { v: draftAnswer, t: Date.now(), by: myPid });
    E.reveal();
  });
  $("#sendVote") && ($("#sendVote").onclick = () => {
    if (draftAnswer == null) { uiToast("Спершу обери варіант"); return; }
    net.set("votes/" + s.q.qid + "/" + myPid, { v: draftAnswer, t: Date.now() });
    snd("click");
  });
  $("#oralReady") && ($("#oralReady").onclick = () => net.set("state/q/oralReady", true));
  $("#nadaBtn") && ($("#nadaBtn").onclick = () => { snd("coin"); E.nada(tid); });
  app.querySelectorAll(".bet-btn").forEach((b) => b.onclick = () => {
    const amt = +b.dataset.amt;
    if ((t.cash | 0) < amt) { uiToast("Не вистачає готівки на цю ставку"); return; }
    net.set("bets/" + s.q.qid + "/" + tid, { dir: b.dataset.dir, amt, by: myPid });
    E.applyMoney(tid, -amt, false, null); // ставка списується одразу, повернення при виграші = ставка+прибуток
    snd("coin");
  });
  $("#rYes") && ($("#rYes").onclick = () => { net.set("raidVotes/" + myPid, true); snd("click"); });
  $("#rNo") && ($("#rNo").onclick = () => { net.set("raidVotes/" + myPid, false); snd("click"); });
  app.querySelectorAll("[data-duel]").forEach((b) => b.onclick = () => net.set("duelAns/" + tid, { v: +b.dataset.duel, t: Date.now(), by: myPid }));
  $("#lavSubmit") && ($("#lavSubmit").onclick = () => {
    if (draftAnswer == null) { uiToast("Спершу дай відповідь"); return; }
    net.set("lavAns/" + tid, { v: draftAnswer, t: Date.now(), by: myPid });
  });
}

function nowBanner(s, tid, isCap, myTurn, shooter, silenced) {
  const ph = s.phase; const other = s.turnTeam && teams()[s.turnTeam] ? teams()[s.turnTeam].name : "";
  let txt = "";
  if (!ph || ph === "lobby") txt = "Ти в грі. Чекай старту.";
  else if (ph === "final") txt = "Гру завершено.";
  else if (ph === "raid") txt = "Облава! Відповідай сам — ТАК чи НІ.";
  else if (ph === "duel") txt = "Дуель двох команд — відповідає капітан, хто швидше.";
  else if (ph === "lavado") txt = "Відмивання: команди з «брудними» грошима виконують завдання.";
  else if (ph === "between") txt = "Раунд завершено. Чекай, що вирішить викладач.";
  else if (myTurn) {
    if (ph === "turn") txt = isCap ? "Ваш хід! Обери, хто відповідає." : "Ваш хід! Капітан обирає, хто відповідає.";
    else if (ph === "spin") txt = shooter ? "Обери тему і крути барабан." : "Ваш гравець крутить барабан.";
    else if (ph === "question") txt = shooter ? "Ти відповідаєш за команду. Порадься й натисни «Фінальна відповідь»." : silenced ? "Ти вже відповідав у цьому раунді — тільки слухай." : "Підкажи відповідачу: обери варіант і надішли пораду.";
    else txt = "Дивись результат на проєкторі.";
  } else {
    if (ph === "question") txt = isCap ? `Відповідає «${other}». Можеш поставити на них.` : `Відповідає «${other}». Ваш капітан може зробити ставку.`;
    else txt = `Зараз хід «${other}». Ваша черга буде пізніше в цьому раунді.`;
  }
  return `<div class="now-banner" role="status">${txt}</div>`;
}
function bindAnswerInputs(app, s) {
  const getQ = () => {
    if (s.phase === "lavado" && s.event) return LAVADO_POOL[s.event.qi];
    return s.q ? qById(s.q.qid) : null;
  };
  app.querySelectorAll(".opt[data-i]").forEach((b) => b.onclick = () => {
    const q = getQ(); const i = +b.dataset.i;
    if (q.type === "single") draftAnswer = i;
    else {
      draftAnswer = Array.isArray(draftAnswer) ? [...draftAnswer] : [];
      const ix = draftAnswer.indexOf(i);
      ix >= 0 ? draftAnswer.splice(ix, 1) : draftAnswer.push(i);
    }
    snd("click"); render();
  });
  app.querySelectorAll(".ob").forEach((b) => b.onclick = () => {
    const q = getQ();
    if (!Array.isArray(draftAnswer) || draftAnswer.length !== q.items.length) draftAnswer = q.items.map((_, i) => i);
    const pos = +b.dataset.pos, dir = +b.dataset.dir, np = pos + dir;
    if (np < 0 || np >= draftAnswer.length) return;
    [draftAnswer[pos], draftAnswer[np]] = [draftAnswer[np], draftAnswer[pos]];
    snd("click"); render();
  });
  app.querySelectorAll(".match-sel").forEach((sel) => sel.onchange = () => {
    const q = getQ();
    if (!Array.isArray(draftAnswer)) draftAnswer = q.pairs.map(() => null);
    draftAnswer[+sel.dataset.i] = sel.value === "" ? null : +sel.value;
  });
  app.querySelectorAll(".s2").forEach((b) => b.onclick = () => {
    const q = getQ();
    if (!Array.isArray(draftAnswer)) draftAnswer = q.items.map(() => null);
    draftAnswer[+b.dataset.i] = b.dataset.v;
    snd("click"); render();
  });
}

// ---------- ПУЛЬТ ВИКЛАДАЧА ----------
function renderAdmin(app) {
  const s = st();
  const q = s.q ? qById(s.q.qid) : null;
  const playURL = location.origin + location.pathname + "?role=play&room=" + net.room;
  const step = adminStep(s);
  const left = `
    <div class="adm-box step-box">
      <div class="adm-title">Що робити зараз</div>
      <p class="step-text">${step.text}</p>
      ${step.btn ? `<button class="btn big step-btn" id="aStep">${step.btn}</button>` : ""}
    </div>
    <div class="adm-box">
      <div class="adm-title">Гра</div>
      <button class="btn" id="aNext">⏭ Пропустити хід / наступний хід</button>
      <button class="btn gold" id="aFinal">👑 Фінал і подіум</button>
      <button class="btn" id="aNew">🔄 Нова гра (скинути все)</button>
    </div>
    <div class="adm-box">
      <div class="adm-title">Події Хефи</div>
      <button class="btn" id="aRaid">🚔 Облава</button>
      <button class="btn" id="aLot">🎴 Лотерея</button>
      <button class="btn" id="aLav">🧺 Відмивання</button>
      <div class="duel-pick">⚔️ Дуель: <select id="aD1">${activeTids().map((t) => `<option value="${t}">${esc((teams()[t] || TEAM_DEFS.find((x) => x.id === t)).name)}</option>`).join("")}</select>
      <select id="aD2">${activeTids().map((t) => `<option value="${t}">${esc((teams()[t] || TEAM_DEFS.find((x) => x.id === t)).name)}</option>`).join("")}</select>
      <button class="btn mini" id="aDuel">Старт</button></div>
    </div>
    <div class="adm-box">
      <div class="adm-title">Таймер <span id="timer" class="timer"></span></div>
      <button class="btn mini" id="aPause">${s.q && s.q.paused ? "▶ Продовжити" : "⏸ Пауза"}</button>
      <button class="btn mini" id="aPlus">+15 с</button>
      <button class="btn mini" id="aRevealNow">Розкрити зараз</button>
    </div>
    <div class="adm-box">
      <div class="adm-title">Сервіс</div>
      <button class="btn mini" id="aCopy">🔗 Копіювати посилання для студентів</button>
      <button class="btn mini" id="aCSV">📋 Таблиця оцінок (Excel)</button>
      <div class="dim small">Кімната: ${net.room} · ${net.mode === "firebase" ? "Firebase" : "локально"}</div>
    </div>`;

  let center = `<div class="adm-box"><div class="adm-title">Фаза: ${s.phase || "—"}</div>`;
  if (q) {
    center += `<div class="cheat"><div class="cheat-head">🤫 Шпаргалка Хефи</div>
      <div class="q-text small">${esc(q.q)}</div>
      <div class="cheat-ans">${cheatAnswer(q)}</div>
      ${q.expl ? `<div class="cheat-expl">${esc(q.expl)}</div>` : ""}
      ${q.type === "oral" ? `<div class="oral-judge"><button class="btn yes" id="aOralOk">✅ Зарахувати</button><button class="btn no" id="aOralNo">❌ Не зарахувати</button></div>` : ""}
    </div>`;
  } else if (s.phase === "raid" && s.event) {
    center += `<div class="cheat"><div class="q-text small">${esc(s.event.q)}</div><div class="cheat-ans">Відповідь: ${s.event.a ? "ТАК" : "НІ"}</div>
    <button class="btn" id="aRaidEnd">Завершити облаву</button></div>`;
  } else if (s.phase === "duel" && s.event) {
    const dq = DUEL_POOL[s.event.qi];
    center += `<div class="cheat"><div class="q-text small">${esc(dq.q)}</div><div class="cheat-ans">Відповідь: ${esc(dq.opts[dq.correct])}</div>
    <button class="btn" id="aDuelEnd">Завершити дуель</button></div>`;
  } else if (s.phase === "lavado" && s.event) {
    const lq = LAVADO_POOL[s.event.qi];
    center += `<div class="cheat"><div class="q-text small">${esc(lq.q)}</div><div class="cheat-ans">${cheatAnswer(lq)}</div>
    <button class="btn" id="aLavEnd">Завершити відмивання</button></div>`;
  } else center += `<div class="dim">Питання зараз немає. Обери дію зліва або чекай на хід команд.</div>`;
  center += `</div>
  <div class="adm-box"><div class="adm-title">Журнал</div><div class="log-box tall">${Object.values(S.log || {}).sort((a, b) => b.t - a.t).slice(0, 30).map((l) => `<div class="log-line">${esc(l.msg)}</div>`).join("")}</div></div>`;

  const right = `<div class="adm-box"><div class="adm-title">Картелі</div>
    ${TEAM_DEFS.map((d) => {
      const t = teams()[d.id] || d; const ms = teamMembers(d.id);
      if (!ms.length) return `<div class="adm-team dim">${d.icon} ${esc(t.name)} — порожньо</div>`;
      return `<div class="adm-team" style="--tc:${d.color}">
        <div class="at-head">${d.icon} <b>${esc(t.name)}</b> · ${money(t.cash)}${t.dirty ? " 🧺" + money(t.dirty) : ""}${t.debt ? " 🏦−" + money(t.debt) : ""}
          <span class="at-btns"><button class="btn mini" data-adj="${d.id}|500">+500</button><button class="btn mini" data-adj="${d.id}|-500">−500</button>
          ${t.debt ? `<button class="btn mini" data-paydebt="${d.id}">борг</button>` : ""}</span></div>
        ${ms.map((x) => `<div class="at-m ${isSilenced(d.id, x.pid) ? "sil" : ""}" data-cap="${d.id}|${x.pid}">${t.captain === x.pid ? "👑 " : ""}${esc(x.name)}${isSilenced(d.id, x.pid) ? " 🤫" : ""}</div>`).join("")}
      </div>`;
    }).join("")}
    <div class="dim small">Клік по імені — зробити капітаном</div>
  </div>`;

  app.innerHTML = `<div class="papel"></div><div class="admin">
    <div class="adm-col">${left}</div><div class="adm-col wide">${center}</div><div class="adm-col">${right}</div>
  </div>`;

  // handlers
  $("#aNew").onclick = () => E.newGame();
  $("#aStep") && ($("#aStep").onclick = () => step.act());
  $("#aNext").onclick = () => E.nextTurn();
  $("#aFinal").onclick = async () => { if (await uiConfirm("Оголосити фінал? Гра завершиться, на проєкторі з'явиться подіум.", "Оголосити фінал")) E.final(); };
  $("#aRaid").onclick = () => E.startRaid();
  $("#aLot").onclick = () => E.loteria();
  $("#aLav").onclick = () => E.startLavado();
  $("#aDuel").onclick = () => { const a = $("#aD1").value, b = $("#aD2").value; if (a !== b) E.startDuel(a, b); };
  $("#aPause").onclick = () => { if (!s.q) return; s.q.paused ? net.update("state/q", { paused: null, deadline: Date.now() + s.q.pausedLeft }) : net.update("state/q", { paused: true, pausedLeft: Math.max(0, s.q.deadline - Date.now()) }); };
  $("#aPlus").onclick = () => { if (s.q) net.set("state/q/deadline", (s.q.deadline || Date.now()) + 15000); };
  $("#aRevealNow").onclick = () => { if (q && q.type !== "oral") E.reveal(); };
  $("#aOralOk") && ($("#aOralOk").onclick = () => E.reveal(true));
  $("#aOralNo") && ($("#aOralNo").onclick = () => E.reveal(false));
  $("#aRaidEnd") && ($("#aRaidEnd").onclick = () => E.endRaid());
  $("#aDuelEnd") && ($("#aDuelEnd").onclick = () => E.endDuel());
  $("#aLavEnd") && ($("#aLavEnd").onclick = () => E.endLavado());
  $("#aCopy").onclick = () => navigator.clipboard.writeText(playURL).then(() => uiToast("Посилання скопійовано: " + playURL), () => uiToast("Скопіюйте вручну: " + playURL));
  $("#aCSV").onclick = () => E.exportPlayers();
  app.querySelectorAll("[data-adj]").forEach((b) => b.onclick = () => { const [tid, d] = b.dataset.adj.split("|"); E.applyMoney(tid, +d, false, `Хефа: «${teams()[tid].name}» ${+d > 0 ? "+" : ""}${money(+d)}`); });
  app.querySelectorAll("[data-paydebt]").forEach((b) => b.onclick = () => E.payDebt(b.dataset.paydebt));
  app.querySelectorAll("[data-cap]").forEach((elm) => elm.onclick = () => { const [tid, pid] = elm.dataset.cap.split("|"); net.set("teams/" + tid + "/captain", pid); });
}
function adminStep(s) {
  const ph = s.phase; const r = s.round | 0; const n = activeTids().length;
  const tname = s.turnTeam && teams()[s.turnTeam] ? "«" + esc(teams()[s.turnTeam].name) + "»" : "";
  if (!ph || ph === "lobby") return n
    ? { text: `Приєдналось команд: <b>${n}</b>. Коли всі студенти в командах — починайте.`, btn: "▶ Почати раунд 1", act: () => E.startRound(1) }
    : { text: "Відкрийте проєктор і покажіть студентам QR-код. Тут з'являться команди, щойно хтось приєднається." };
  if (ph === "turn") return { text: `Ходить ${tname}. Капітан на телефоні обирає, хто відповідає.`, btn: "⏭ Пропустити хід цієї команди", act: () => E.nextTurn() };
  if (ph === "spin") return { text: `Гравець ${tname} обирає тему й крутить барабан.` };
  if (ph === "question") { const q = s.q && qById(s.q.qid);
    if (q && q.type === "oral") return { text: s.q.oralReady ? "Команда готова. Вислухайте відповідь, звірте зі шпаргалкою й оцініть кнопками нижче." : "Усне питання: команда готується. Таймер зупиниться, коли вони натиснуть «Готові»." };
    return { text: `${tname} відповідає. Відповідь перевіриться сама, коли вони підтвердять або скінчиться час.`, btn: "Розкрити відповідь зараз", act: () => E.reveal() }; }
  if (ph === "turn_end") return { text: "Обговоріть правильну відповідь на проєкторі, потім передайте хід далі.", btn: "➡️ Наступна команда", act: () => E.nextTurn() };
  if (ph === "raid" || ph === "duel" || ph === "lavado") return { text: "Триває подія. Вона завершиться автоматично за таймером." };
  if (ph === "between") return r < CFG.ROUNDS
    ? { text: `Раунд ${r} завершено. За бажанням запустіть подію (облава, лотерея, дуель) або почніть наступний раунд.`, btn: `▶ Почати раунд ${r + 1}`, act: () => E.startRound(r + 1) }
    : { text: "Усі раунди зіграно. Час оголосити переможця.", btn: "👑 Оголосити фінал", act: () => E.final() };
  if (ph === "final") return { text: "Гру завершено. Скопіюйте таблицю оцінок у розділі «Сервіс»." };
  return { text: "" };
}
function cheatAnswer(q) {
  if (q.type === "single") return "Відповідь: " + esc(q.opts[q.correct]);
  if (q.type === "multi") return "Відповіді: " + q.correct.map((i) => esc(q.opts[i])).join(" · ");
  if (q.type === "order") return "Порядок: " + q.items.map((x) => esc(x)).join(" → ");
  if (q.type === "match") return q.pairs.map((p) => esc(p[0]) + " → " + esc(p[1])).join("<br>");
  if (q.type === "sort2") return q.items.map((it) => (it[1] === "A" ? "A" : "B") + ": " + esc(it[0])).join("<br>");
  if (q.type === "oral") return "Усне питання — оцінюєте ви.";
  return "";
}

document.addEventListener("DOMContentLoaded", boot);
