// Outside-in uptime monitor for Experimental Horus (Starfleet Development #470, #477).
// Runs on GitHub's runners in the PUBLIC repo HansFalck/horus-experimental-uptime (free Actions
// minutes) - never on the machine that serves the site - so a dead PC, home network or Funnel all
// look the same from here: unreachable. Source of truth: THIS folder in starfleet-development;
// publish.mjs copies it there. All decisions live in monitor-core.mjs (tested); this file only
// probes, talks to GitHub and ntfy, and carries out the actions the core returns.
//
// MODE=watch    (watch.yml)  probe every 60 s for ~5.5 h, alert/repeat/recover, watch the certificates,
//                            then hand over to a successor run (newest run wins).
// MODE=restart  (uptime.yml) every 5 min by GitHub's cron (and the keeper's dispatch): start a watcher
//                            if none is queued or running.
// MODE=drill    (drill.yml)  the watch loop against a test URL and a test ntfy topic, label uptime-drill,
//                            no hand-off, never touches experimental-down issues.
// MODE=probe    (probe.yml)  probe every TARGET once, log UP:/DOWN: lines, exit 0. For the on-call's
//                            `probe --outside`. No GitHub, no ntfy, no certificates, no secrets read.
// No dependencies; Node 22. Secrets: NTFY_TOPIC, FUNNEL_HOST (repo secrets), GITHUB_TOKEN (Actions).
import { appendFileSync } from "node:fs";
import tls from "node:tls";
import {
  adoptIssue,
  backPushText,
  certActions,
  certDaysLeft,
  certPushText,
  certTitle,
  CERT_DEFAULT_DAYS,
  downPushText,
  downTitle,
  formatMarker,
  handoffDecision,
  idleState,
  isUnfinishedRun,
  muteDecision,
  pushDue,
  recordPush,
  restarterDecision,
  resumedState,
  step,
  stateFromIssue,
} from "./monitor-core.mjs";

const env = process.env;
const MODE = env.MODE || "watch";
const DRILL = MODE === "drill";
const TARGETS = (env.TARGETS || "https://app.horus-experimental.no/health").split(",").map((s) => s.trim()).filter(Boolean);
const SCALE = Number(env.SCALE) > 0 ? Number(env.SCALE) : 1;
const TICK_MS = Number(env.TICK_MS) > 0 ? Number(env.TICK_MS) : 60_000;
const RUN_MS = Number(env.RUN_MS) > 0 ? Number(env.RUN_MS) : 5.5 * 3_600_000;
const CERT_EVERY_MS = Number(env.CERT_EVERY_MS) > 0 ? Number(env.CERT_EVERY_MS) : 6 * 3_600_000;
const CERT_DAYS = Number(env.CERT_ALERT_DAYS) > 0 ? Number(env.CERT_ALERT_DAYS) : CERT_DEFAULT_DAYS;
const REPO = env.GITHUB_REPOSITORY;
const TOKEN = env.GITHUB_TOKEN;
const RUN_ID = Number(env.GITHUB_RUN_ID) || 0;
const NTFY_TOPIC = env.NTFY_TOPIC || "";
const NTFY_BASE = env.NTFY_BASE || "https://ntfy.sh";
const API = env.GITHUB_API || "https://api.github.com";
const REF = env.GITHUB_REF_NAME || "main";
const DOWN_LABEL = DRILL ? "uptime-drill" : "experimental-down";
const CERT_LABEL = DRILL ? "uptime-drill" : "experimental-cert";
const TITLE_PREFIX = DRILL ? "DRILL " : "";
const CERT_HOSTS = [
  ["app", env.APP_HOST || "app.horus-experimental.no"],
  ["funnel", env.FUNNEL_HOST || ""],
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);
let pushFailed = false;

// ---- I/O --------------------------------------------------------------------------------------
async function probe(url) {
  const t = Date.now();
  try {
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(25_000) });
    return { ok: res.status >= 200 && res.status < 300, line: `${url} -> HTTP ${res.status} in ${Date.now() - t} ms` };
  } catch (e) {
    return { ok: false, line: `${url} -> no answer (${e.cause?.code || e.name}) after ${Date.now() - t} ms` };
  }
}
async function probeAll() {
  const results = await Promise.all(TARGETS.map(probe));
  return { ok: results.every((r) => r.ok), lines: results.map((r) => r.line) };
}

async function gh(path, init = {}) {
  const res = await fetch(`${API}/repos/${REPO}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, accept: "application/vnd.github+json", "content-type": "application/json", ...(init.headers || {}) },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`GitHub ${init.method || "GET"} ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.status === 204 ? null : res.json();
}
const ghJson = (method, path, body) => gh(path, { method, body: JSON.stringify(body) });

/** One push, 3 tries with back-off. Returns true when ntfy accepted it; never throws. */
async function push(title, message, priority) {
  if (!NTFY_TOPIC) {
    log("ntfy: NTFY_TOPIC not set - no push possible");
    return (pushFailed = true), false;
  }
  for (let i = 1; i <= 3; i++) {
    try {
      const res = await fetch(`${NTFY_BASE}/${encodeURIComponent(NTFY_TOPIC)}`, {
        method: "POST",
        body: message,
        headers: { Title: title, Priority: priority, Tags: priority === "urgent" ? "rotating_light" : "white_check_mark", Click: "https://app.horus-experimental.no" },
        signal: AbortSignal.timeout(15_000),
      });
      log(`ntfy: push "${title}" -> HTTP ${res.status} (attempt ${i})`);
      if (res.ok) return true;
    } catch (e) {
      log(`ntfy: push "${title}" -> ${e.cause?.code || e.name} (attempt ${i})`);
    }
    if (i < 3) await sleep(i * 5_000);
  }
  pushFailed = true;
  return false;
}

async function listIssues(label) {
  return gh(`/issues?state=open&labels=${label}&per_page=30`);
}
// The drill uses ONE label for both kinds, so the kinds are told apart by title.
const isCertIssue = (i) => /\[(app|funnel)\]/.test(i.title);
const listDownIssues = async () => (await listIssues(DOWN_LABEL)).filter((i) => !isCertIssue(i));
// status= takes ONE value and a just-created run can be queued, requested, waiting, pending or
// in_progress, so list unfiltered (newest first) and keep every run that is not finished.
async function listRuns() {
  const r = await gh("/actions/workflows/watch.yml/runs?per_page=30");
  return (r.workflow_runs || []).map((x) => ({ id: x.id, status: x.status })).filter(isUnfinishedRun);
}
async function dispatchWatcher() {
  await ghJson("POST", "/actions/workflows/watch.yml/dispatches", { ref: REF });
}
async function maintenanceText() {
  try {
    const r = await gh(`/contents/maintenance-until.txt?ref=${encodeURIComponent(REF)}`);
    return Buffer.from(r.content || "", "base64").toString("utf8");
  } catch {
    return null;
  }
}

// ---- The outage watcher -------------------------------------------------------------------------
async function applyDownActions(state, actions, now, lines) {
  let s = state;
  for (const a of actions) {
    if (a.type === "open") {
      try {
        const existing = (await listDownIssues())[0];
        if (existing) {
          s = adoptIssue(s, existing); // the issue holds the true since / lastPush
        } else {
          const body =
            `Experimental Horus has been unreachable from the internet (GitHub's runners) since ${new Date(s.since).toISOString()}.\n\n` +
            `Last probe:\n${lines.map((l) => `- ${l}`).join("\n")}\n\n` +
            'Recover by hand: starfleet-development tools/horus-host/README.md, section "Experimental 24/7". ' +
            "This issue closes itself when the address is up again.\n\n" +
            formatMarker(s);
          const issue = await ghJson("POST", "/issues", { title: TITLE_PREFIX + downTitle({ now, since: s.since }), labels: [DOWN_LABEL], body });
          s = { ...s, issueNumber: issue.number };
          log(`issue #${issue.number} opened`);
        }
      } catch (e) {
        log(`issue open failed (will retry): ${e.message}`);
      }
    } else if (a.type === "push") {
      if (a.kind === "back") {
        if (await push("Experimental Horus is back up", backPushText({ now, since: a.since }), "default")) s = { ...s, backPushed: true };
        continue;
      }
      if (!pushDue({ now, since: s.since, lastPush: s.lastPush, scale: SCALE })) continue; // an adopted issue may already have had its push
      const m = muteDecision({ now, untilText: await maintenanceText() });
      if (m.mute) {
        log(`push suppressed: ${m.reason}`);
        continue;
      }
      if (await push("Experimental Horus is DOWN", downPushText({ now, since: s.since }), "urgent")) {
        s = recordPush(s, now);
        if (s.issueNumber != null) {
          try {
            const body = await rebuildBody(s);
            await ghJson("PATCH", `/issues/${s.issueNumber}`, { title: TITLE_PREFIX + downTitle({ now, since: s.since }), body });
          } catch (e) {
            log(`marker update failed: ${e.message}`);
          }
        }
      }
    } else if (a.type === "close") {
      try {
        await ghJson("POST", `/issues/${s.issueNumber}/comments`, { body: `RECOVERED - seen up from outside at ${new Date(now).toISOString()}.\n\n${lines.join("\n")}` });
        await ghJson("PATCH", `/issues/${s.issueNumber}`, { state: "closed" });
        log(`issue #${s.issueNumber} closed`);
        for (const other of await listIssues(DOWN_LABEL)) {
          if (other.number !== s.issueNumber && other.title.includes("EXPERIMENTAL DOWN")) await ghJson("PATCH", `/issues/${other.number}`, { state: "closed" });
        }
        s = { ...s, issueNumber: null };
      } catch (e) {
        log(`issue close failed (will retry): ${e.message}`);
      }
    }
  }
  return s;
}

/** The issue body with a fresh marker; the human text is kept from the current body. */
async function rebuildBody(s) {
  const issue = await gh(`/issues/${s.issueNumber}`);
  const text = (issue.body || "").replace(/<!-- monitor-state .*? -->/s, "").trimEnd();
  return `${text}\n\n${formatMarker(s)}`;
}

// ---- Certificates ---------------------------------------------------------------------------------
function readValidTo(host) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    try {
      const sock = tls.connect({ host, port: Number(env.CERT_PORT) || 443, servername: host, rejectUnauthorized: false, timeout: 15_000 }, () => {
        finish(sock.getPeerCertificate()?.valid_to ?? null);
        sock.destroy();
      });
      sock.on("timeout", () => (sock.destroy(), finish(null)));
      sock.on("error", () => finish(null));
    } catch {
      finish(null);
    }
  });
}

async function loadCertStates() {
  const states = { app: { issueNumber: null, lastPush: null }, funnel: { issueNumber: null, lastPush: null } };
  try {
    for (const issue of await listIssues(CERT_LABEL)) {
      const label = /\[(app|funnel)\]/.exec(issue.title)?.[1];
      if (label && states[label].issueNumber == null && !(DRILL && !issue.title.startsWith(TITLE_PREFIX))) {
        states[label] = { issueNumber: issue.number, lastPush: stateFromIssue(issue).lastPush };
      }
    }
  } catch (e) {
    log(`cert issue lookup failed: ${e.message}`);
  }
  return states;
}

async function checkCerts(states) {
  for (const [label, host] of CERT_HOSTS) {
    if (!host) {
      log(`cert ${label}: host not configured - skipped`);
      continue;
    }
    const now = Date.now();
    const daysLeft = certDaysLeft(await readValidTo(host), now);
    log(daysLeft == null ? `cert ${label}: UNKNOWN (could not read)` : `cert ${label}: ${daysLeft.toFixed(1)} days left`);
    let s = states[label];
    const act = certActions({ daysLeft, threshold: CERT_DAYS, issueNumber: s.issueNumber, lastPush: s.lastPush, now });
    try {
      if (act.open) {
        const found = (await listIssues(CERT_LABEL)).find((i) => i.title.includes(`[${label}]`) && i.title.startsWith(TITLE_PREFIX));
        if (found) s = { ...s, issueNumber: found.number };
        else {
          const issue = await ghJson("POST", "/issues", {
            title: TITLE_PREFIX + certTitle({ label, daysLeft }),
            labels: [CERT_LABEL],
            body: `The ${label} TLS certificate is under ${CERT_DAYS} days from its end. Renew it; see tools/horus-host/README.md in starfleet-development.\n\n${formatMarker({ lastPush: null, pushes: 0 })}`,
          });
          s = { ...s, issueNumber: issue.number };
        }
      }
      if (act.push) {
        if (await push(`Experimental ${label} certificate ends soon`, certPushText({ label, daysLeft }), "urgent")) {
          s = { ...s, lastPush: now };
          if (s.issueNumber != null) await ghJson("PATCH", `/issues/${s.issueNumber}`, { body: await rebuildBody({ ...s, since: null, pushes: 1 }) });
        }
      }
      if (act.close) {
        await ghJson("POST", `/issues/${s.issueNumber}/comments`, { body: `Back above ${CERT_DAYS} days (${daysLeft.toFixed(1)}).` });
        await ghJson("PATCH", `/issues/${s.issueNumber}`, { state: "closed" });
        s = { issueNumber: null, lastPush: null };
      }
    } catch (e) {
      log(`cert ${label} issue work failed: ${e.message}`);
    }
    states[label] = s;
  }
}

// ---- Modes ----------------------------------------------------------------------------------------------
async function watch() {
  const started = Date.now();
  const deadline = started + RUN_MS;
  let state = idleState();
  try {
    const open = await listDownIssues();
    if (DRILL) {
      for (const i of open) await ghJson("PATCH", `/issues/${i.number}`, { state: "closed" }); // leftovers of an earlier drill
    } else if (open[0]) {
      state = resumedState(open[0], started);
      log(`resuming open outage #${open[0].number}`);
    }
  } catch (e) {
    log(`issue lookup failed: ${e.message} - carrying on with no memory of earlier alerts`);
  }
  const certStates = await loadCertStates();
  let nextCert = 0;
  let lastDispatchAt = null;
  for (let tick = 0; ; tick++) {
    const t0 = Date.now();
    try {
    const r = await probeAll();
    log(`${r.ok ? "UP" : "DOWN"}: ${r.lines.join(" | ")}`);
    const res = step(state, r.ok, t0, { scale: SCALE });
    state = await applyDownActions(res.state, res.actions, t0, r.lines);
    if (state.alerted && r.ok && state.backPushed && state.issueNumber == null) state = idleState();

    if (t0 >= nextCert) {
      nextCert = t0 + CERT_EVERY_MS;
      await checkCerts(certStates).catch((e) => log(`cert check failed: ${e.message}`));
    }
    if (DRILL) {
      if (t0 >= deadline) break;
    } else if (t0 >= deadline || tick % 5 === 0) {
      try {
        const runs = await listRuns();
        const verdict = handoffDecision({ now: t0, deadline, myId: RUN_ID, runs, lastDispatchAt });
        if (verdict === "exit") {
          markHandedOff();
          return log("a newer watcher is running - this run ends");
        }
        if (verdict === "dispatch") {
          await dispatchWatcher();
          lastDispatchAt = t0;
          log("successor watcher dispatched");
        }
      } catch (e) {
        log(`hand-off check failed: ${e.message}`);
      }
    }
    } catch (e) {
      log(`tick failed (carrying on): ${e.message}`);
    }
    await sleep(Math.max(0, TICK_MS - (Date.now() - t0)));
  }
  if (DRILL && state.issueNumber != null) {
    await ghJson("PATCH", `/issues/${state.issueNumber}`, { state: "closed" }).catch(() => {});
  }
  if (DRILL) {
    for (const s of Object.values(certStates)) if (s.issueNumber != null) await ghJson("PATCH", `/issues/${s.issueNumber}`, { state: "closed" }).catch(() => {});
  }
}

/** A clean hand-off (a newer watcher is running): tell watch.yml, so its crash step does not add a successor. */
function markHandedOff() {
  if (env.GITHUB_OUTPUT) {
    try {
      appendFileSync(env.GITHUB_OUTPUT, "handed_off=true\n");
    } catch (e) {
      log(`could not write the hand-off flag: ${e.message}`);
    }
  }
}

async function restart() {
  const runs = await listRuns();
  if (restarterDecision(runs) === "skip") return log("a watcher is queued or running - nothing to do");
  await dispatchWatcher();
  log("no watcher was running - dispatched one");
}

/** One probe, one line in the watcher's format (oncall's lastCheckLineIsUp reads it). Always succeeds. */
async function probeOnce() {
  const r = await probeAll();
  log(`${r.ok ? "UP" : "DOWN"}: ${r.lines.join(" | ")}`);
}

(MODE === "probe" ? probeOnce() : MODE === "restart" ? restart() : watch())
  .then(() => {
    if (pushFailed) {
      console.error("a push failed during this run");
      process.exitCode = 1;
    }
  })
  .catch((e) => {
    console.error(`check failed: ${e.message}`);
    process.exitCode = 1;
  });
