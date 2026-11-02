// Outside-in uptime check for Experimental Horus (Starfleet Development #470).
// Runs on GitHub's runners in the PUBLIC repo HansFalck/horus-experimental-uptime (free Actions
// minutes) — never on the machine that serves the site — so a dead PC, a dead home network or a
// dead Funnel all look the same from here: unreachable. Source of truth: THIS file in
// starfleet-development; publish.mjs copies it there.
//
// One run: probe the address. Healthy → close any open DOWN issue (+ "recovered" push).
// Failing → keep probing every 30 s for up to WINDOW_MS; if it never recovers inside the
// window (= unreachable for 5 minutes), open ONE "For-Zazu: EXPERIMENTAL DOWN" issue and push
// to the owner's phone via ntfy. An already-open DOWN issue is never re-alerted.
// No dependencies; Node 20+ (fetch). Secrets: NTFY_TOPIC (repo secret), GITHUB_TOKEN (Actions).

const TARGETS = (process.env.TARGETS || "https://app.horus-experimental.no/health")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const WINDOW_MS = Number(process.env.WINDOW_MS || 5 * 60_000);
const STEP_MS = Number(process.env.STEP_MS || 30_000);
const REPO = process.env.GITHUB_REPOSITORY;
const TOKEN = process.env.GITHUB_TOKEN;
const NTFY_TOPIC = process.env.NTFY_TOPIC || "";
const LABEL = "experimental-down";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Any 2xx is up; anything else (or no answer in 25 s) is down. */
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
  const res = await fetch(`https://api.github.com/repos/${REPO}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      ...(init.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`GitHub ${init.method || "GET"} ${path}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

/** Push to the owner's phone; 3 tries with back-off; throws if all fail (the run then fails and Actions emails). */
async function push(title, message, priority) {
  if (!NTFY_TOPIC) throw new Error("NTFY_TOPIC not set - no push possible");
  let last = "";
  for (let i = 1; i <= 3; i++) {
    try {
      const res = await fetch(`https://ntfy.sh/${encodeURIComponent(NTFY_TOPIC)}`, {
        method: "POST",
        body: message,
        headers: {
          Title: title,
          Priority: priority,
          Tags: priority === "urgent" ? "rotating_light" : "white_check_mark",
          Click: "https://app.horus-experimental.no",
        },
        signal: AbortSignal.timeout(15_000),
      });
      console.log(`ntfy: push "${title}" -> HTTP ${res.status} (attempt ${i})`);
      if (res.ok) return;
      last = `HTTP ${res.status}`;
    } catch (e) {
      last = e.cause?.code || e.name;
      console.log(`ntfy: push "${title}" -> ${last} (attempt ${i})`);
    }
    await sleep(i * 5_000);
  }
  throw new Error(`ntfy push failed 3 times (${last})`);
}

const openDownIssues = () => gh(`/issues?state=open&labels=${LABEL}&per_page=10`);

async function main() {
  const startedAt = new Date();
  let r = await probeAll();
  console.log(`${startedAt.toISOString()} ${r.ok ? "UP" : "DOWN"}: ${r.lines.join(" | ")}`);
  let open;
  try {
    open = await openDownIssues();
  } catch (e) {
    // GitHub's API is down: still alert on a real outage (no dedupe possible — a push per run is better than none).
    console.log(`issue lookup failed: ${e.message}`);
    if (r.ok) return;
    open = null;
  }

  if (r.ok) {
    for (const issue of open) {
      await gh(`/issues/${issue.number}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: `RECOVERED - seen up from outside at ${startedAt.toISOString()}.\n\n${r.lines.join("\n")}` }),
      });
      await gh(`/issues/${issue.number}`, { method: "PATCH", body: JSON.stringify({ state: "closed" }) });
      await push("Experimental Horus is back up", `Seen up from outside at ${startedAt.toISOString()}.`, "default");
    }
    return;
  }
  if (open && open.length > 0) return console.log(`already alerted (#${open[0].number}); no re-alert`);

  // Failing and not yet alerted: is it down for the whole window?
  const deadline = Date.now() + WINDOW_MS;
  while (Date.now() < deadline) {
    await sleep(STEP_MS);
    r = await probeAll();
    console.log(`${new Date().toISOString()} ${r.ok ? "UP" : "DOWN"}: ${r.lines.join(" | ")}`);
    if (r.ok) return console.log("recovered inside the window - no alert");
  }
  const mins = Math.round(WINDOW_MS / 60_000);
  // The issue first (it is the dedupe record), but a failed issue never blocks the phone push.
  let issueError = null;
  try {
    await gh("/issues", {
      method: "POST",
      body: JSON.stringify({
        title: `For-Zazu: EXPERIMENTAL DOWN - unreachable from outside for ${mins} min (since ${startedAt.toISOString()})`,
        labels: [LABEL],
        body:
          `Experimental Horus has been unreachable from the internet (GitHub's runners) for ${mins} minutes.\n\n` +
          `Last probe:\n${r.lines.map((l) => `- ${l}`).join("\n")}\n\n` +
          "Recover by hand: starfleet-development tools/horus-host/README.md, section \"Experimental 24/7\". " +
          "This issue closes itself when the address is up again.",
      }),
    });
  } catch (e) {
    issueError = e;
  }
  await push(
    "Experimental Horus is DOWN",
    `Unreachable from outside for ${mins} min (since ${startedAt.toISOString()}). Starfleet has been told.`,
    "urgent"
  );
  if (issueError) throw issueError;
}

main().catch((e) => {
  console.error(`check failed: ${e.message}`);
  process.exit(1);
});
