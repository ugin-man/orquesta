"use strict";

const { FIXTURE_COPY, buildWorkbenchView } = globalThis.OrquestaWorkbenchViewModel;
let state = null;
let busy = false;

function el(id) { return document.getElementById(id); }
function show(element, visible) { element.hidden = !visible; }
function setText(id, value) { el(id).textContent = value === null || value === undefined || value === "" ? "—" : String(value); }

function element(tag, options = {}) {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = String(options.text);
  return node;
}

async function request(route, options) {
  const response = await fetch(route, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.message || "Request failed");
  return body;
}

function setBusy(next) {
  busy = next;
  for (const button of document.querySelectorAll("button")) button.disabled = next;
  el("workspace").setAttribute("aria-busy", String(next));
}

function renderTabs() {
  const tabs = (state.fixtures || []).map((fixture) => {
    const copy = FIXTURE_COPY[fixture.fixture_id];
    const button = element("button", { className: fixture.fixture_id === state.current_fixture ? "active" : "" });
    button.type = "button";
    button.dataset.testid = `fixture-${fixture.fixture_id}`;
    button.setAttribute("aria-pressed", String(fixture.fixture_id === state.current_fixture));
    button.append(element("span", { text: copy.eyebrow }), document.createTextNode(copy.tab));
    button.addEventListener("click", () => loadFixture(fixture.fixture_id));
    return button;
  });
  el("fixture-tabs").replaceChildren(...tabs);
}

function renderNeeds(view) {
  const cards = view.needs.map((need) => {
    const card = element("article", { className: "need-card" });
    card.append(
      element("span", { text: `NEED ${String(need.index).padStart(2, "0")}` }),
      element("strong", { text: need.needId }),
      element("p", { text: `${need.mode} · ${need.verification}` }),
    );
    return card;
  });
  el("need-list").replaceChildren(...cards);
}

function renderCandidates(view) {
  const cards = view.candidates.map((candidate) => {
    const card = element("article", { className: `candidate-card ${candidate.eligibility}` });
    card.dataset.testid = `candidate-${candidate.candidateId}`;
    if (candidate.selected) card.classList.add("selected");
    const heading = element("div", { className: "candidate-heading" });
    const identity = element("div");
    identity.append(
      element("span", { text: candidate.selected ? "PROPOSED" : candidate.highestRawScore ? "RAW SCORE LEADER" : candidate.mode.toUpperCase() }),
      element("h4", { text: candidate.candidateId }),
    );
    const score = element("div", { className: "score" });
    score.append(element("strong", { text: candidate.score.toFixed(2) }), element("span", { text: `−${candidate.uncertaintyPenalty} uncertainty` }));
    heading.append(identity, score);

    const gates = element("div", { className: "gate-list" });
    for (const gate of candidate.gates) gates.append(element("span", { className: `gate ${gate.status}`, text: `${gate.name}: ${gate.status}` }));

    const detail = element("details");
    detail.append(element("summary", { text: `${candidate.axisContributions.length}軸の寄与を見る` }));
    const axes = element("dl", { className: "axis-grid" });
    for (const axis of candidate.axisContributions) {
      axes.append(element("dt", { text: axis.axis }), element("dd", { text: `${axis.value} → +${axis.contribution}` }));
    }
    detail.append(axes);

    card.append(heading, gates);
    if (candidate.rejectionReasons.length) card.append(element("p", { className: "rejection", text: `棄却: ${candidate.rejectionReasons.join(", ")} gate` }));
    card.append(detail);
    return card;
  });
  el("candidate-grid").replaceChildren(...cards);
}

function renderList(id, values, emptyText) {
  const items = values.length ? values : [emptyText];
  el(id).replaceChildren(...items.map((value) => element("li", { text: value })));
}

function renderWorkspace() {
  renderTabs();
  setText("journal-status", `${state.journal.batch_count} batches · ${state.journal.event_count} events`);
  const hasFixture = Boolean(state.current_fixture);
  show(el("empty-state"), !hasFixture);
  show(el("workspace"), hasFixture);
  if (!hasFixture) return;

  const view = buildWorkbenchView(state, { selectedFixtureId: state.current_fixture });
  setText("outcome-eyebrow", view.outcome.eyebrow);
  setText("outcome-title", view.outcome.title);
  setText("outcome-summary", view.outcome.summary);
  setText("decision-mode", view.decision.mode.toUpperCase());
  setText("phase-id", view.phaseId);
  setText("task-intent-summary", view.outcome.summary);
  setText("need-count", `${view.needs.length} needs`);
  renderNeeds(view);
  renderCandidates(view);

  setText("approval-status", view.decision.approvalStatus);
  setText("decision-provider", view.decision.providerId);
  setText("decision-cost", view.decision.cost.status === "estimated" ? `${view.decision.cost.resolution_total_cost} estimated` : "unknown");
  setText("raw-leader", `${view.decision.rawLeaderId}${view.decision.rawLeaderEligible ? " · eligible" : " · rejected"}`);
  setText("rejection-gate", view.decision.rejectionGate || "none");
  setText("context-status", view.contextPack.status);
  renderList("required-reading", view.contextPack.requiredReading, "なし。既存providerを読む必要はありません。");
  setText("audition-status", view.limits.audition);

  el("timeline").replaceChildren(...view.timeline.map((eventType, index) => {
    const item = element("span");
    item.append(element("b", { text: index + 1 }), document.createTextNode(eventType));
    return item;
  }));

  const providerEvidence = view.evidence.providers.flatMap((provider) => [
    `${provider.providerId} · ${provider.sourceType}`,
    ...provider.evidenceRefs.map((reference) => `↳ ${reference}`),
  ]);
  renderList("provider-evidence", providerEvidence, "provider evidenceなし");
  renderList("limitations", view.limits.items, "なし");
}

async function loadFixture(fixtureId) {
  if (busy) return;
  setBusy(true);
  show(el("error-banner"), false);
  try {
    state = await request(`/api/v4/fixtures/${fixtureId}/load`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    renderWorkspace();
  } catch (error) {
    el("error-banner").textContent = error.message;
    show(el("error-banner"), true);
  } finally {
    setBusy(false);
  }
}

el("replay-button").addEventListener("click", async () => {
  if (busy) return;
  setBusy(true);
  show(el("error-banner"), false);
  try {
    state = await request("/api/v4/replay", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    renderWorkspace();
  } catch (error) {
    el("error-banner").textContent = error.message;
    show(el("error-banner"), true);
  } finally {
    setBusy(false);
  }
});

request("/api/v4/state").then((next) => {
  state = next;
  renderWorkspace();
}).catch((error) => {
  el("error-banner").textContent = error.message;
  show(el("error-banner"), true);
});
