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

    time.className = "entry-meta";
    time.dateTime = note.date.replaceAll(".", "-");
    time.textContent = formatDate(note.date);
    link.href = `notes/reader.html?id=${encodeURIComponent(note.id)}`;
    link.textContent = note.title;

    heading.append(link);
    item.append(time, heading);
    list.append(item);
  });

  container.replaceChildren(list);
}

renderNotes();
