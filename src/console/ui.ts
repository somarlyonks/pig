/**
 * The console UI is one self-contained page: a status board and a command box.
 * It reads `/api/state` and posts `/api/commands`, and it is useless without the
 * console API behind it. Nothing in PiG depends on it.
 */
export function renderConsoleHtml(): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>PiG console</title>
<style>
:root { color-scheme: light dark; --line: #8883; --accent: #2f81f7; }
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif; }
header { display: flex; gap: 12px; align-items: center; padding: 12px 20px; border-bottom: 1px solid var(--line); }
header h1 { font-size: 16px; margin: 0; }
header input { flex: 1; max-width: 380px; }
main { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); gap: 20px; padding: 20px; }
@media (max-width: 900px) { main { grid-template-columns: 1fr; } }
section { border: 1px solid var(--line); border-radius: 8px; padding: 12px 16px; margin-bottom: 20px; }
section h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; opacity: .7; margin: 0 0 10px; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { text-align: left; padding: 4px 8px 4px 0; vertical-align: top; }
th { opacity: .6; font-weight: 500; }
code, pre, input, select, textarea, button { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
input, select, textarea, button { background: transparent; color: inherit; border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; }
textarea { width: 100%; min-height: 130px; }
button { cursor: pointer; }
button.primary { border-color: var(--accent); color: var(--accent); }
.field { margin-bottom: 8px; }
.field label { display: block; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; opacity: .6; margin-bottom: 3px; }
.field input, .field select { width: 100%; }
.muted { opacity: .6; }
.pill { border: 1px solid var(--line); border-radius: 99px; padding: 1px 8px; font-size: 11px; }
.bad { color: #d1242f; }
.good { color: #1a7f37; }
pre.out { white-space: pre-wrap; word-break: break-word; margin: 0; }
</style>
</head>
<body>
<header>
  <h1>PiG console</h1>
  <input id="token" type="password" placeholder="console admin token" autocomplete="off" />
  <button id="refresh">Refresh</button>
  <span id="status" class="muted"></span>
</header>
<main>
  <div>
    <section>
      <h2>Workers</h2>
      <div id="workers" class="muted">No token yet.</div>
    </section>
    <section>
      <h2>Recent jobs</h2>
      <div id="jobs" class="muted">-</div>
    </section>
    <section>
      <h2>Dispatches</h2>
      <div id="dispatches" class="muted">-</div>
    </section>
  </div>
  <div>
    <section>
      <h2>Ask</h2>
      <div class="field"><label>Message</label><textarea id="ask" style="min-height:70px"></textarea></div>
      <button id="askbtn" class="primary">Ask</button>
      <pre id="answer" class="out muted" style="margin-top:10px"></pre>
      <div id="proposals"></div>
    </section>
    <section>
      <h2>Command</h2>
      <div class="field"><label>Worker</label><select id="worker"></select></div>
      <div class="field"><label>Capability</label><select id="capability"></select></div>
      <div class="field"><label>Actor (GitHub login)</label><input id="actor" placeholder="octocat" /></div>
      <div class="field"><label>Params (JSON)</label><textarea id="params">{}</textarea></div>
      <button id="propose" class="primary">Propose</button>
      <button id="send" disabled>Confirm and send</button>
      <pre id="proposal" class="out muted" style="margin-top:10px"></pre>
    </section>
    <section>
      <h2>Enroll a worker</h2>
      <div class="field"><label>Label</label><input id="label" placeholder="pig-cloudflare" /></div>
      <button id="enroll">Create enrollment token</button>
      <pre id="enrollment" class="out muted" style="margin-top:10px"></pre>
    </section>
  </div>
</main>
<script>
const $ = (id) => document.getElementById(id);
let state = null;
let proposal = null;

function headers() {
  return { authorization: "Bearer " + ($("token").value || ""), "content-type": "application/json" };
}
function setStatus(text, bad) {
  $("status").textContent = text;
  $("status").className = bad ? "bad" : "muted";
}
function cell(text) {
  const td = document.createElement("td");
  td.textContent = text == null ? "" : String(text);
  return td;
}

async function api(path, options) {
  const response = await fetch(path, { ...options, headers: headers() });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

function renderWorkers() {
  const target = $("workers");
  target.className = "";
  target.innerHTML = "";
  if (!state || state.workers.length === 0) {
    target.className = "muted";
    target.textContent = "No workers registered.";
    return;
  }
  for (const worker of state.workers) {
    const block = document.createElement("div");
    block.style.marginBottom = "12px";
    const head = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = worker.workerId;
    const kind = document.createElement("span");
    kind.className = "pill";
    kind.textContent = worker.kind;
    head.appendChild(name);
    head.appendChild(document.createTextNode(" "));
    const session = document.createElement("span");
    session.className = "pill";
    session.textContent = worker.sessionState === "unknown" ? "never polled" : worker.sessionState;
    head.appendChild(session);
    head.appendChild(document.createTextNode(" "));
    head.appendChild(kind);
    head.appendChild(document.createTextNode(" "));
    const session = document.createElement("span");
    session.className = "pill";
    session.textContent = worker.sessionState === "unknown" ? "never polled" : worker.sessionState;
    head.appendChild(session);
    head.appendChild(document.createTextNode(" "));
    const obs = document.createElement("span");
    obs.className = "muted";
    obs.textContent = worker.observations
      .map((entry) => entry.repo + ": " + (entry.ok ? new Date(entry.observedAt).toLocaleTimeString() : "error"))
      .join(" · ");
    head.appendChild(obs);
    block.appendChild(head);
    const caps = document.createElement("div");
    caps.className = "muted";
    caps.textContent = worker.capabilities.map((c) => c.name + (c.dangerous ? "!" : "")).join(", ");
    block.appendChild(caps);
    target.appendChild(block);
  }
}

function renderJobs() {
  const target = $("jobs");
  target.className = "";
  target.innerHTML = "";
  if (!state || state.jobs.length === 0) {
    target.className = "muted";
    target.textContent = "Nothing observed yet.";
    return;
  }
  const table = document.createElement("table");
  table.innerHTML = "<thead><tr><th>Job</th><th>Repo</th><th>Kind</th><th>Origin</th><th>Status</th><th>Detail</th></tr></thead>";
  const body = document.createElement("tbody");
  for (const entry of state.jobs.slice(0, 25)) {
    const row = document.createElement("tr");
    row.appendChild(cell(entry.job.id.slice(0, 8)));
    row.appendChild(cell(entry.repo));
    row.appendChild(cell(entry.job.kind));
    row.appendChild(cell(entry.job.origin));
    const status = cell(entry.job.status);
    status.className = entry.job.status === "failed" ? "bad" : entry.job.status === "succeeded" ? "good" : "";
    row.appendChild(status);
    row.appendChild(cell(entry.job.error || entry.job.summary || ""));
    body.appendChild(row);
  }
  table.appendChild(body);
  target.appendChild(table);
}

function renderDispatches() {
  const target = $("dispatches");
  target.className = "";
  target.innerHTML = "";
  if (!state || state.dispatches.length === 0) {
    target.className = "muted";
    target.textContent = "No commands dispatched yet.";
    return;
  }
  const table = document.createElement("table");
  table.innerHTML = "<thead><tr><th>Key</th><th>Capability</th><th>State</th><th>Job</th></tr></thead>";
  const body = document.createElement("tbody");
  for (const entry of state.dispatches) {
    const row = document.createElement("tr");
    row.appendChild(cell(entry.dispatchKey));
    row.appendChild(cell(entry.capability));
    const stateCell = cell(entry.state);
    stateCell.className = entry.state === "rejected" ? "bad" : entry.state === "accepted" ? "good" : "";
    row.appendChild(stateCell);
    row.appendChild(cell(entry.jobId || entry.error || ""));
    body.appendChild(row);
  }
  table.appendChild(body);
  target.appendChild(table);
}

function renderControls() {
  const workerSelect = $("worker");
  const capabilitySelect = $("capability");
  workerSelect.innerHTML = "";
  for (const worker of state ? state.workers : []) {
    const option = document.createElement("option");
    option.value = worker.workerId;
    option.textContent = worker.workerId + " (" + worker.kind + ")";
    workerSelect.appendChild(option);
  }
  capabilitySelect.innerHTML = "";
  const selected = (state ? state.workers : []).find((w) => w.workerId === workerSelect.value);
  for (const capability of selected ? selected.capabilities : []) {
    const option = document.createElement("option");
    option.value = capability.name;
    option.textContent = capability.name + (capability.dangerous ? " (needs confirmation)" : "");
    capabilitySelect.appendChild(option);
  }
}

async function load(refresh) {
  if (!$("token").value) return setStatus("Enter the admin token.", true);
  setStatus("loading…");
  const result = await api("/api/state" + (refresh ? "?refresh=1" : ""));
  if (result.status !== 200) return setStatus("state failed: " + (result.body.error || result.status), true);
  state = result.body;
  renderWorkers();
  renderJobs();
  renderDispatches();
  renderControls();
  setStatus("updated " + new Date(state.now).toLocaleTimeString());
}

async function propose() {
  proposal = null;
  $("send").disabled = true;
  let params;
  try {
    params = JSON.parse($("params").value || "{}");
  } catch (error) {
    $("proposal").textContent = "Params are not valid JSON.";
    return;
  }
  const result = await api("/api/commands", {
    method: "POST",
    body: JSON.stringify({
      workerId: $("worker").value,
      capability: $("capability").value,
      actor: $("actor").value,
      params,
    }),
  });
  if (result.status === 409 && result.body.requiresConfirmation) {
    proposal = result.body.proposal;
    $("proposal").textContent =
      "Needs confirmation:\\n" + JSON.stringify(proposal, null, 2);
    $("send").disabled = false;
    return;
  }
  $("proposal").textContent =
    result.status + "\\n" + JSON.stringify(result.body, null, 2);
  if (result.status === 202) load(true);
}

async function send() {
  if (!proposal) return;
  $("send").disabled = true;
  const result = await api("/api/commands", {
    method: "POST",
    body: JSON.stringify({
      workerId: proposal.workerId,
      capability: proposal.capability,
      actor: proposal.actor,
      params: proposal.params,
      proposalId: proposal.proposalId,
      confirm: true,
    }),
  });
  $("proposal").textContent = result.status + "\\n" + JSON.stringify(result.body, null, 2);
  proposal = null;
  load(true);
}

async function enroll() {
  const result = await api("/api/enrollments", {
    method: "POST",
    body: JSON.stringify({ label: $("label").value || "worker" }),
  });
  $("enrollment").textContent = result.status + "\\n" + JSON.stringify(result.body, null, 2);
}

async function ask() {
  $("answer").textContent = "thinking…";
  $("proposals").innerHTML = "";
  const result = await api("/api/assistant", {
    method: "POST",
    body: JSON.stringify({ message: $("ask").value, actor: $("actor").value }),
  });
  if (result.status !== 200) {
    $("answer").textContent = result.status + " " + (result.body.error || "");
    return;
  }
  $("answer").textContent = result.body.reply || "";
  for (const proposal of result.body.proposals || []) {
    const block = document.createElement("div");
    block.style.marginTop = "8px";
    const text = document.createElement("div");
    text.className = "muted";
    text.textContent =
      proposal.rationale + " — " + proposal.workerId + " · " + proposal.capability +
      " · " + JSON.stringify(proposal.params);
    const button = document.createElement("button");
    button.textContent = proposal.dangerous ? "Confirm and send" : "Send";
    button.onclick = async () => {
      button.disabled = true;
      const sent = await api("/api/commands", {
        method: "POST",
        body: JSON.stringify({
          workerId: proposal.workerId,
          capability: proposal.capability,
          actor: proposal.actor,
          params: proposal.params,
          proposalId: proposal.proposalId,
          confirm: true,
        }),
      });
      text.textContent = sent.status + " " + JSON.stringify(sent.body);
      load(true);
    };
    block.appendChild(text);
    block.appendChild(button);
    $("proposals").appendChild(block);
  }
}

$("askbtn").onclick = ask;
$("refresh").onclick = () => load(true);
$("propose").onclick = propose;
$("send").onclick = send;
$("enroll").onclick = enroll;
$("worker").onchange = () => { $("capability").value = ""; renderControls(); };
$("token").onchange = () => load(false);
load(false);
</script>
</body>
</html>`;
}
