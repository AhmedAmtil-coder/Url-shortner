const state = {
  links: [],
  metrics: {
    totalLinks: 0,
    activeLinks: 0,
    totalClicks: 0,
    lastClickAt: null,
  },
  events: [],
  latest: null,
  selectedSlug: null,
  mode: "instant",
  query: "",
};

const els = {
  form: document.querySelector("#shortenForm"),
  url: document.querySelector("#urlInput"),
  title: document.querySelector("#titleInput"),
  alias: document.querySelector("#aliasInput"),
  expiry: document.querySelector("#expiryInput"),
  color: document.querySelector("#colorInput"),
  note: document.querySelector("#noteInput"),
  resultStatus: document.querySelector("#resultStatus"),
  resultUrl: document.querySelector("#resultUrl"),
  copyLatest: document.querySelector("#copyLatestButton"),
  openLatest: document.querySelector("#openLatestLink"),
  signature: document.querySelector("#signaturePreview"),
  refresh: document.querySelector("#refreshButton"),
  sample: document.querySelector("#sampleButton"),
  search: document.querySelector("#searchInput"),
  linkGrid: document.querySelector("#linkGrid"),
  eventFeed: document.querySelector("#eventFeed"),
  metricLinks: document.querySelector("#metricLinks"),
  metricActive: document.querySelector("#metricActive"),
  metricClicks: document.querySelector("#metricClicks"),
  metricLastClick: document.querySelector("#metricLastClick"),
  phoneTitle: document.querySelector("#phoneTitle"),
  phoneSlug: document.querySelector("#phoneSlug"),
  phoneUrl: document.querySelector("#phoneUrl"),
  toast: document.querySelector("#toast"),
  modeButtons: Array.from(document.querySelectorAll(".mode-button")),
};

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function hostFromUrl(value) {
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return value;
  }
}

function formatDate(value) {
  if (!value) return "Never";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatRelative(value) {
  if (!value) return "No clicks";
  const seconds = Math.max(1, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("is-visible");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => els.toast.classList.remove("is-visible"), 2400);
}

function makeSignature(seed) {
  const text = seed || "short-studio";
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }

  const cells = [];
  for (let index = 0; index < 55; index += 1) {
    const on = ((hash >> index % 16) + index * 7 + text.length) % 3 !== 0;
    cells.push(`<span class="${on ? "is-on" : ""}"></span>`);
  }
  els.signature.innerHTML = cells.join("");
}

function updateMetrics() {
  els.metricLinks.textContent = state.metrics.totalLinks;
  els.metricActive.textContent = state.metrics.activeLinks;
  els.metricClicks.textContent = state.metrics.totalClicks;
  els.metricLastClick.textContent = formatRelative(state.metrics.lastClickAt);
}

function updatePreview(link) {
  const selected = link || state.links[0] || null;
  if (!selected) {
    els.phoneTitle.textContent = "Short Studio";
    els.phoneSlug.textContent = "/new";
    els.phoneUrl.textContent = "localhost";
    return;
  }

  els.phoneTitle.textContent = selected.title || hostFromUrl(selected.url);
  els.phoneSlug.textContent = `/${selected.slug}`;
  els.phoneUrl.textContent = hostFromUrl(selected.url);
  makeSignature(selected.slug + selected.url);
}

function updateResult(link) {
  if (!link) {
    els.resultStatus.textContent = "Ready";
    els.resultUrl.textContent = "short.studio/new";
    els.copyLatest.disabled = true;
    els.openLatest.setAttribute("aria-disabled", "true");
    els.openLatest.href = "#";
    makeSignature("short-studio");
    return;
  }

  state.latest = link;
  els.resultStatus.textContent = "Created";
  els.resultUrl.textContent = link.shortUrl;
  els.copyLatest.disabled = false;
  els.openLatest.removeAttribute("aria-disabled");
  els.openLatest.href = link.shortUrl;
  makeSignature(link.slug + link.url);
  updatePreview(link);
}

function renderEvents() {
  if (!state.events.length) {
    els.eventFeed.innerHTML = `
      <div class="event-item">
        <strong>No click events yet</strong>
        <span>Open one of your short links to populate the stream.</span>
      </div>
    `;
    return;
  }

  els.eventFeed.innerHTML = state.events
    .slice(0, 5)
    .map((event) => {
      const referrer = event.referrer === "Direct" ? "Direct visit" : hostFromUrl(event.referrer);
      return `
        <div class="event-item">
          <strong>/${escapeHtml(event.slug)} opened</strong>
          <span>${escapeHtml(formatRelative(event.at))} from ${escapeHtml(referrer)}</span>
        </div>
      `;
    })
    .join("");
}

function linkMatches(link) {
  if (!state.query) return true;
  const haystack = `${link.title} ${link.slug} ${link.url} ${link.note}`.toLowerCase();
  return haystack.includes(state.query.toLowerCase());
}

function renderLinks() {
  const links = state.links.filter(linkMatches);

  if (!links.length) {
    els.linkGrid.innerHTML = `
      <div class="empty-state">
        <div>
          <strong>No matching links</strong>
          <p>Create a link or clear search.</p>
        </div>
      </div>
    `;
    return;
  }

  els.linkGrid.innerHTML = links
    .map((link) => {
      const selected = state.selectedSlug === link.slug ? " is-selected" : "";
      const expired = link.isExpired ? "Expired" : "Active";
      const note = link.note || hostFromUrl(link.url);
      return `
        <article class="link-card${selected}" data-slug="${escapeHtml(link.slug)}">
          <div class="card-topline">
            <span class="card-chip">/${escapeHtml(link.slug)}</span>
            <span class="color-dot ${escapeHtml(link.color)}" aria-hidden="true"></span>
          </div>
          <div>
            <h3>${escapeHtml(link.title || hostFromUrl(link.url))}</h3>
            <a class="link-url" href="${escapeHtml(link.shortUrl)}" target="_blank" rel="noreferrer">${escapeHtml(link.shortUrl)}</a>
          </div>
          <p>${escapeHtml(note)}</p>
          <p>${Number(link.clicks || 0)} clicks · ${expired}${link.expiresAt ? ` · Expires ${escapeHtml(formatDate(link.expiresAt))}` : ""}</p>
          <div class="card-actions">
            <button class="tiny-button" type="button" data-action="select" data-slug="${escapeHtml(link.slug)}">Focus</button>
            <button class="tiny-button" type="button" data-action="copy" data-url="${escapeHtml(link.shortUrl)}">Copy</button>
            <a class="tiny-button" href="${escapeHtml(link.shortUrl)}" target="_blank" rel="noreferrer">Open</a>
            <button class="tiny-button danger" type="button" data-action="delete" data-slug="${escapeHtml(link.slug)}">Archive</button>
          </div>
        </article>
      `;
    })
    .join("");
}

function renderAll() {
  updateMetrics();
  renderEvents();
  renderLinks();
  updatePreview(state.links.find((link) => link.slug === state.selectedSlug) || state.latest);
}

async function api(path, options = {}) {
  const headers = {};
  if (options.body) headers["Content-Type"] = "application/json";
  const response = await fetch(path, {
    headers,
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || "Request failed");
  }
  return data;
}

async function loadLinks() {
  const data = await api("/api/links");
  state.links = data.links || [];
  state.metrics = data.metrics || state.metrics;
  state.events = data.events || [];
  if (!state.selectedSlug && state.links[0]) state.selectedSlug = state.links[0].slug;
  renderAll();
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }
  showToast("Copied");
}

function setMode(mode) {
  state.mode = mode;
  els.modeButtons.forEach((button) => {
    const active = button.dataset.mode === mode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });

  if (mode === "campaign") {
    els.note.placeholder = "Channel, creative, owner, or placement";
    els.alias.placeholder = "launch-campaign";
    if (!els.title.value) els.title.value = "Campaign landing page";
  }

  if (mode === "limited") {
    const date = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
    els.expiry.value = date.toISOString().slice(0, 16);
    els.alias.placeholder = "private-drop";
  }

  if (mode === "instant") {
    els.note.placeholder = "Launch audience, placement, or owner";
    els.alias.placeholder = "spring-event";
  }
}

async function submitForm(event) {
  event.preventDefault();
  const button = els.form.querySelector(".primary-button");
  button.disabled = true;
  els.resultStatus.textContent = "Creating";

  try {
    const payload = {
      url: els.url.value,
      title: els.title.value,
      alias: els.alias.value,
      expiresAt: els.expiry.value || null,
      color: els.color.value,
      note: els.note.value,
    };
    const data = await api("/api/shorten", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    await loadLinks();
    state.selectedSlug = data.link.slug;
    updateResult(data.link);
    renderAll();
    showToast("Short link created");
  } catch (error) {
    els.resultStatus.textContent = "Needs attention";
    showToast(error.message);
  } finally {
    button.disabled = false;
  }
}

async function archiveLink(slug) {
  try {
    await api(`/api/links/${encodeURIComponent(slug)}`, { method: "DELETE" });
    if (state.selectedSlug === slug) state.selectedSlug = null;
    await loadLinks();
    showToast("Archived");
  } catch (error) {
    showToast(error.message);
  }
}

function fillSample() {
  const suffix = Math.floor(Date.now() / 1000).toString(36);
  els.url.value = "https://www.apple.com/apple-events/";
  els.title.value = "Apple Events";
  els.alias.value = `event-${suffix}`;
  els.color.value = "graphite";
  els.note.value = "Homepage placement and launch share";
  setMode("campaign");
  els.url.focus();
}

els.form.addEventListener("submit", submitForm);
els.refresh.addEventListener("click", () => loadLinks().then(() => showToast("Refreshed")));
els.sample.addEventListener("click", fillSample);
els.copyLatest.addEventListener("click", () => {
  if (state.latest) copyText(state.latest.shortUrl);
});
els.search.addEventListener("input", (event) => {
  state.query = event.target.value;
  renderLinks();
});
els.modeButtons.forEach((button) => {
  button.addEventListener("click", () => setMode(button.dataset.mode));
});

els.linkGrid.addEventListener("click", async (event) => {
  const target = event.target.closest("[data-action]");
  if (!target) return;
  const action = target.dataset.action;

  if (action === "copy") {
    await copyText(target.dataset.url);
    return;
  }

  if (action === "select") {
    state.selectedSlug = target.dataset.slug;
    const link = state.links.find((item) => item.slug === state.selectedSlug);
    updateResult(link);
    renderAll();
    return;
  }

  if (action === "delete") {
    await archiveLink(target.dataset.slug);
  }
});

makeSignature("short-studio");
loadLinks().catch((error) => {
  showToast(error.message);
  renderAll();
});
