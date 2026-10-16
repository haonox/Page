"use strict";

function formatDate(value) {
  const date = new Date(`${value.replaceAll(".", "-")}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function renderNotes() {
  const catalog = window.noteCatalog;
  const container = document.getElementById("home-notes");

  if (!container) return;

  if (!catalog || !Array.isArray(catalog.notes)) {
    container.innerHTML = "<p>文章目录暂时无法载入，请稍后刷新页面。</p>";
    return;
  }

  const list = document.createElement("ul");
  list.className = "entry-list post-list";

  catalog.notes.forEach((note) => {
    const item = document.createElement("li");
    const time = document.createElement("time");
    const heading = document.createElement("h3");
    const link = document.createElement("a");

    link.className = "post-row-link";
    link.href = `notes/reader.html?id=${encodeURIComponent(note.id)}`;
    time.className = "entry-meta";
    time.dateTime = note.date.replaceAll(".", "-");
    time.textContent = formatDate(note.date);
    heading.textContent = note.title;

    link.append(time, heading);
    item.append(link);
    list.append(item);
  });

  container.replaceChildren(list);
}

function initTabs() {
  const tabs = [...document.querySelectorAll("[data-tab]")];
  const panels = [...document.querySelectorAll("[data-panel]")];

  if (tabs.length === 0 || panels.length === 0) return;

  const activate = (name, moveFocus = false) => {
    tabs.forEach((tab) => {
      const selected = tab.dataset.tab === name;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      if (selected && moveFocus) tab.focus();
    });

    panels.forEach((panel) => {
      panel.hidden = panel.dataset.panel !== name;
    });
  };

  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => activate(tab.dataset.tab));
    tab.addEventListener("keydown", (event) => {
      let nextIndex;
      if (event.key === "ArrowRight") nextIndex = (index + 1) % tabs.length;
      if (event.key === "ArrowLeft") nextIndex = (index - 1 + tabs.length) % tabs.length;
      if (event.key === "Home") nextIndex = 0;
      if (event.key === "End") nextIndex = tabs.length - 1;
      if (nextIndex === undefined) return;

      event.preventDefault();
      activate(tabs[nextIndex].dataset.tab, true);
    });
  });
}

renderNotes();
initTabs();
