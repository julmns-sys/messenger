function renderResults(results) {
  const resultList = document.getElementById("resultList");
  if (!resultList) return;

  if (!results.length) {
    resultList.innerHTML = '<div class="empty-state">Ничего не найдено</div>';
    return;
  }

  resultList.innerHTML = results
    .map((user) => `
      <article class="result-item">
        <div class="avatar small">${escapeHtml(initials(user.name || user.username || "U"))}</div>
        <div class="result-meta">
          <div class="result-topline">
            <h3 class="result-name">${escapeHtml(user.name || user.username || "User")}</h3>
          </div>
          <p class="result-username">@${escapeHtml(user.username || "")}</p>
        </div>
        <a class="button button-secondary" href="chat.html?${user.chat_id ? `id=${encodeURIComponent(user.chat_id)}` : `user_id=${encodeURIComponent(user.id)}`}">Открыть</a>
      </article>
    `)
    .join("");
}

document.addEventListener("DOMContentLoaded", async () => {
  requireAuth();
  bindLogout();
  fillUserBadge();
  initSidebarProfile();
  await loadChats();

  const form = document.getElementById("searchForm");
  const input = document.getElementById("searchInput");
  const status = document.getElementById("searchStatus");

  if (!form || !input) return;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const query = input.value.trim().replace(/^@/, "");
    if (!query) return;

    status.textContent = "Поиск...";

    try {
      const data = await apiFetch(`/users/search?username=${encodeURIComponent(query)}`);
      const results = Array.isArray(data) ? data : data.items || [];
      renderResults(results);
      status.textContent = `${results.length} найдено`;
      status.className = "status";
    } catch (error) {
      status.textContent = error.message;
      status.className = "status error";
    }
  });
});
