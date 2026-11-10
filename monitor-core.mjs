// Pure decisions of the outside monitor (#477). No I/O, no clock, no env: check.mjs is the thin
// shell that probes, talks to GitHub and ntfy, and executes the actions this file returns.
// Times are epoch milliseconds unless a name ends in Iso/Text. `scale` (drill only) divides the
// confirm window, the repeat intervals and the 3-hour boundary - nothing else.

const MIN = 60_000;
const HOUR = 60 * MIN;

export const CONFIRM_MS = 3 * MIN;
export const MIN_FAILS = 3;
export const BOUNDARY_MS = 3 * HOUR;
export const REPEAT_EARLY_MS = 30 * MIN;
export const REPEAT_LATE_MS = 60 * MIN;
export const CERT_REPEAT_MS = 24 * HOUR;
export const MUTE_MAX_MS = 3 * HOUR;
export const HANDOFF_SPACING_MS = 5 * MIN;
export const CERT_DEFAULT_DAYS = 14;

/** Down is confirmed after >= 3 failed probes AND >= 180 s (scaled) since the first failing one. */
export function isDownConfirmed({ failCount, firstFailAt, now, scale = 1 }) {
  return failCount >= MIN_FAILS && firstFailAt != null && now - firstFailAt >= CONFIRM_MS / scale;
}

/** Push due: never pushed, or the gap since the last push reached 30 min (first 3 h) / 60 min (after). */
export function pushDue({ now, since, lastPush, scale = 1 }) {
  if (lastPush == null) return true;
  const gap = now - since < BOUNDARY_MS / scale ? REPEAT_EARLY_MS : REPEAT_LATE_MS;
  return now - lastPush >= gap / scale;
}

/** "45 min", "2 h", "1 h 30 min", "less than 1 min". */
export function durationWords(ms) {
  const total = Math.floor(Math.max(0, ms) / MIN);
  if (total < 1) return "less than 1 min";
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** Wall clock in Oslo, "17:02". */
export function osloClock(ms) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Oslo", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ms));
}

export const downPushText = ({ now, since }) => `Down for ${durationWords(now - since)}, since ${osloClock(since)} Oslo. Starfleet has been told.`;
export const backPushText = ({ now, since }) => `Back up. It was down for ${durationWords(now - since)} (since ${osloClock(since)} Oslo).`;
export const downTitle = ({ now, since }) =>
  `For-Zazu: EXPERIMENTAL DOWN - unreachable from outside for ${Math.max(0, Math.round((now - since) / MIN))} min (since ${new Date(since).toISOString()})`;

// ---- The state marker in an issue body -------------------------------------------------------
const MARKER = /<!-- monitor-state (\{.*?\}) -->/s;

export function formatMarker({ since = null, lastPush = null, pushes = 0 }) {
  const iso = (t) => (t == null ? null : new Date(t).toISOString());
  return `<!-- monitor-state ${JSON.stringify({ since: iso(since), lastPush: iso(lastPush), pushes })} -->`;
}

/** {since,lastPush,pushes} in ms from an issue; a legacy issue (no or broken marker) reads created_at for both. */
export function stateFromIssue(issue) {
  const created = Date.parse(issue?.created_at ?? "");
  const legacy = { since: Number.isFinite(created) ? created : null, lastPush: Number.isFinite(created) ? created : null, pushes: 1 };
  const m = MARKER.exec(issue?.body ?? "");
  if (!m) return legacy;
  try {
    const o = JSON.parse(m[1]);
    const t = (v) => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null);
    const since = t(o.since) ?? legacy.since;
    return { since, lastPush: t(o.lastPush), pushes: Number.isInteger(o.pushes) ? o.pushes : 0 };
  } catch {
    return legacy;
  }
}

// ---- Maintenance mute -------------------------------------------------------------------------
/** Suppress the PUSH only when maintenance-until.txt holds a valid time in the future, at most 3 h ahead. */
export function muteDecision({ now, untilText }) {
  const until = Date.parse(String(untilText ?? "").trim());
  if (!Number.isFinite(until)) return { mute: false, reason: untilText == null ? "no maintenance file" : "maintenance file unreadable as a time" };
  if (until <= now) return { mute: false, reason: "maintenance window expired" };
  if (until > now + MUTE_MAX_MS) return { mute: false, reason: "maintenance window longer than 3 h - ignored" };
  return { mute: true, reason: `maintenance until ${new Date(until).toISOString()}` };
}

// ---- The down/up state machine ----------------------------------------------------------------
export function idleState() {
  return { failCount: 0, firstFailAt: null, alerted: false, since: null, lastPush: null, pushes: 0, issueNumber: null, backPushed: false };
}

/** State of a monitor resuming an open issue: the outage is already confirmed. */
export function resumedState(issue, now) {
  const st = stateFromIssue(issue);
  const since = st.since ?? now;
  return { ...idleState(), alerted: true, since, failCount: MIN_FAILS, firstFailAt: since, lastPush: st.lastPush, pushes: st.pushes, issueNumber: issue.number };
}

/** After a push really went out. */
export const recordPush = (s, now) => ({ ...s, lastPush: now, pushes: s.pushes + 1 });

/**
 * One probe result in, next state + actions out. Actions: open | push{kind:down|repeat|back} | close.
 * The shell reports success back (recordPush / issueNumber / backPushed); a failed action is simply
 * returned again by the next tick, because the state it depends on did not move.
 */
export function step(state, ok, now, { scale = 1 } = {}) {
  const s = { ...state };
  const actions = [];
  if (ok) {
    if (!s.alerted) return { state: idleState(), actions };
    if (s.pushes > 0 && !s.backPushed) actions.push({ type: "push", kind: "back", since: s.since });
    if (s.issueNumber != null) actions.push({ type: "close" });
    return actions.length ? { state: s, actions } : { state: idleState(), actions };
  }
  s.backPushed = false;
  if (s.firstFailAt == null) {
    s.firstFailAt = now;
    s.failCount = 0;
  }
  s.failCount += 1;
  if (!s.alerted && isDownConfirmed({ failCount: s.failCount, firstFailAt: s.firstFailAt, now, scale })) {
    s.alerted = true;
    s.since = s.firstFailAt;
    s.lastPush = null;
    s.pushes = 0;
  }
  if (s.alerted) {
    if (s.issueNumber == null) actions.push({ type: "open" });
    if (pushDue({ now, since: s.since, lastPush: s.lastPush, scale })) {
      actions.push({ type: "push", kind: s.lastPush == null ? "down" : "repeat", since: s.since });
    }
  }
  return { state: s, actions };
}

// ---- Hand-off between watcher runs and the restarter --------------------------------------------
/**
 * runs: [{id,status}] of watch.yml. Newest wins: a newer run in progress -> this one exits.
 * Past the deadline with no newer run in progress or queued, and not dispatched in the last 5 min -> dispatch.
 */
export function handoffDecision({ now, deadline, myId, runs, lastDispatchAt = null }) {
  const newer = runs.filter((r) => Number(r.id) > Number(myId));
  if (newer.some((r) => r.status === "in_progress")) return "exit";
  if (now < deadline) return "continue";
  if (newer.length > 0) return "continue";
  if (lastDispatchAt != null && now - lastDispatchAt < HANDOFF_SPACING_MS) return "continue";
  return "dispatch";
}

/** Restarter: dispatch a watcher only when none is queued or in progress. */
export const restarterDecision = (runs) => (runs.some((r) => r.status === "queued" || r.status === "in_progress") ? "skip" : "dispatch");

// ---- Certificates ----------------------------------------------------------------------------------
/** Whole-and-fractional days from now to valid_to; null when unreadable. */
export function certDaysLeft(validTo, now) {
  const t = Date.parse(validTo ?? "");
  return Number.isFinite(t) ? (t - now) / (24 * HOUR) : null;
}

/** {open,push,close} for one certificate. Exactly the threshold is NOT under it. Unknown raises nothing. */
export function certActions({ daysLeft, threshold = CERT_DEFAULT_DAYS, issueNumber, lastPush, now }) {
  const none = { open: false, push: false, close: false };
  if (daysLeft == null) return none;
  if (daysLeft >= threshold) return { ...none, close: issueNumber != null };
  return { open: issueNumber == null, push: lastPush == null || now - lastPush >= CERT_REPEAT_MS, close: false };
}

export const certPushText = ({ label, daysLeft }) => `The ${label} certificate has ${Math.max(0, Math.floor(daysLeft))} days left.`;
export const certTitle = ({ label, daysLeft }) => `For-Zazu: EXPERIMENTAL CERTIFICATE [${label}] expires in ${Math.max(0, Math.floor(daysLeft))} days`;
