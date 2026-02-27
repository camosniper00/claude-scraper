const scrapeForm = document.getElementById("scrapeForm");
const urlInput = document.getElementById("urlInput");
const scrapeBtn = document.getElementById("scrapeBtn");
const loader = document.getElementById("loader");
const errorMsg = document.getElementById("errorMsg");
const results = document.getElementById("results");
const sourceLabel = document.getElementById("sourceLabel");
const headlineList = document.getElementById("headlineList");
const filterSection = document.getElementById("filterSection");
const searchInput = document.getElementById("searchInput");
const resultCount = document.getElementById("resultCount");
const emptyState = document.getElementById("emptyState");

let allHeadlines = [];

scrapeForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = urlInput.value.trim();
  if (!url) return;

  showLoading();
  hideError();
  hideResults();

  try {
    const res = await fetch("/api/scrape", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || "Something went wrong");
    }

    if (data.headlines.length === 0) {
      throw new Error(
        "No headlines found on this page. Try a blog listing or homepage."
      );
    }

    allHeadlines = data.headlines;
    renderHeadlines(allHeadlines);
    sourceLabel.textContent = `Results from ${new URL(data.source).hostname}`;
    showResults();
  } catch (err) {
    showError(err.message);
  } finally {
    hideLoading();
  }
});

searchInput.addEventListener("input", () => {
  const query = searchInput.value.trim().toLowerCase();

  if (!query) {
    renderHeadlines(allHeadlines);
    return;
  }

  const filtered = allHeadlines.filter(
    (h) =>
      h.title.toLowerCase().includes(query) ||
      (h.summary && h.summary.toLowerCase().includes(query))
  );

  renderHeadlines(filtered, query);
});

function renderHeadlines(headlines, highlight = "") {
  headlineList.innerHTML = "";

  resultCount.textContent = `${headlines.length} headline${headlines.length !== 1 ? "s" : ""}`;

  headlines.forEach((h, i) => {
    const card = document.createElement("div");
    card.className = "headline-card";
    card.style.animationDelay = `${i * 0.04}s`;

    const title = highlight ? highlightText(h.title, highlight) : escapeHtml(h.title);
    const summary = h.summary
      ? highlight
        ? highlightText(h.summary, highlight)
        : escapeHtml(h.summary)
      : "No summary available.";

    card.innerHTML = `
      <div class="card-number">Headline ${i + 1}</div>
      <h3>${h.link ? `<a href="${escapeAttr(h.link)}" target="_blank" rel="noopener noreferrer">${title}</a>` : title}</h3>
      <p class="summary">${summary}</p>
      ${
        h.link
          ? `<div class="card-meta">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                <polyline points="15 3 21 3 21 9"/>
                <line x1="10" y1="14" x2="21" y2="3"/>
              </svg>
              <a href="${escapeAttr(h.link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(h.link)}</a>
            </div>`
          : ""
      }
    `;

    headlineList.appendChild(card);
  });
}

function highlightText(text, query) {
  const escaped = escapeHtml(text);
  const regex = new RegExp(`(${escapeRegex(query)})`, "gi");
  return escaped.replace(regex, "<mark>$1</mark>");
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function showLoading() {
  loader.classList.remove("hidden");
  emptyState.classList.add("hidden");
  scrapeBtn.disabled = true;
}

function hideLoading() {
  loader.classList.add("hidden");
  scrapeBtn.disabled = false;
}

function showError(msg) {
  errorMsg.textContent = msg;
  errorMsg.classList.remove("hidden");
  emptyState.classList.add("hidden");
}

function hideError() {
  errorMsg.classList.add("hidden");
}

function showResults() {
  results.classList.remove("hidden");
  filterSection.classList.remove("hidden");
  emptyState.classList.add("hidden");
  searchInput.value = "";
  searchInput.focus();
}

function hideResults() {
  results.classList.add("hidden");
  filterSection.classList.add("hidden");
}
