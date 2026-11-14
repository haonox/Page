"use strict";

function createNoteList(notes) {
  const list = document.createElement("ul");
  list.className = "note-list";

  for (const note of notes) {
    const item = document.createElement("li");
    const link = document.createElement("a");
    const date = document.createElement("time");
    const title = document.createElement("span");
    const arrow = document.createElement("span");

    link.className = "note-link";
    link.href = `notes/reader.html?id=${encodeURIComponent(note.id)}`;
    date.className = "note-date";
    date.dateTime = note.date;
    date.textContent = note.date;
    title.className = "note-title";
    title.textContent = note.title;
    arrow.className = "note-arrow";
    arrow.textContent = "→";
    arrow.setAttribute("aria-hidden", "true");

    link.append(date, title, arrow);
    item.append(link);
    list.append(item);
  }

  return list;
}

function renderNotes() {
  const container = document.getElementById("home-notes");
  if (!container) return;

  const notes = window.noteCatalog?.notes;
  if (!Array.isArray(notes)) {
    container.textContent = "文章目录暂时无法载入，请稍后刷新页面。";
    return;
  }

  const count = document.getElementById("note-count");
  if (count) count.textContent = `${notes.length} 篇笔记`;
  if (notes.length === 0) {
    container.textContent = "还没有发布笔记。";
    return;
  }

  // The generated catalog is already ordered from newest to oldest.
  container.replaceChildren(createNoteList(notes));
}

renderNotes();
