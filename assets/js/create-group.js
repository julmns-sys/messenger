const selectedMembers = new Map();

function renderSelectedMembers() {
  const container = document.getElementById("selectedMembers");
  if (!container) return;

  const users = [...selectedMembers.values()];
  if (!users.length) {
    container.innerHTML = '<p class="muted">Добавьте хотя бы одного участника</p>';
    return;
  }

  container.innerHTML = users
    .map((user) => `
      <span class="chip">
        @${escapeHtml(user.username)}
        <button type="button" data-remove="${escapeHtml(String(user.id))}">×</button>
      </span>
    `)
    .join("");

  container.querySelectorAll("[data-remove]").forEach((button) => {
    button.addEventListener("click", () => {
      selectedMembers.delete(button.dataset.remove);
      renderSelectedMembers();
    });
  });
}

function renderMemberSearch(results) {
  const list = document.getElementById("memberSearchResults");
  if (!list) return;

  if (!results.length) {
    list.innerHTML = '<div class="empty-state">Пользователи не найдены</div>';
    return;
  }

  list.innerHTML = results
    .map((user) => `
      <article class="member-item">
        <div class="avatar small">${escapeHtml(initials(user.name || user.username || "U"))}</div>
        <div class="result-meta">
          <h3 class="result-name">${escapeHtml(user.name || user.username || "User")}</h3>
          <p class="result-username">@${escapeHtml(user.username || "")}</p>
        </div>
        <button class="button button-secondary" type="button" data-add="${escapeHtml(String(user.id))}">Добавить</button>
      </article>
    `)
    .join("");

  list.querySelectorAll("[data-add]").forEach((button) => {
    button.addEventListener("click", () => {
      const user = results.find((item) => String(item.id) === button.dataset.add);
      if (!user) return;
      selectedMembers.set(String(user.id), user);
      renderSelectedMembers();
    });
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  requireAuth();
  bindLogout();
  fillUserBadge();
  initSidebarProfile();
  await loadChats();
  renderSelectedMembers();

  const searchForm = document.getElementById("memberSearchForm");
  const createForm = document.getElementById("createGroupForm");
  const status = document.getElementById("groupStatus");

  if (searchForm) {
    searchForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const username = document.getElementById("memberSearchInput").value.trim().replace(/^@/, "");
      if (!username) return;

      try {
        const data = await apiFetch(`/users/search?username=${encodeURIComponent(username)}`);
        renderMemberSearch(Array.isArray(data) ? data : data.items || []);
      } catch (error) {
        status.textContent = error.message;
        status.className = "status error";
      }
    });
  }

  if (createForm) {
    createForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const title = document.getElementById("groupTitle").value.trim();
      const description = document.getElementById("groupDescription").value.trim();
      const memberIds = [...selectedMembers.keys()];

      if (!title || !memberIds.length) {
        status.textContent = "Укажите название и добавьте участников";
        status.className = "status error";
        return;
      }

      status.textContent = "Создание группы...";
      status.className = "status";

      try {
        const group = await apiFetch("/groups", {
          method: "POST",
          body: JSON.stringify({
            title,
            description,
            member_ids: memberIds
          })
        });

        window.location.href = `group_chat.html?id=${encodeURIComponent(group.id)}`;
      } catch (error) {
        status.textContent = error.message;
        status.className = "status error";
      }
    });
  }
});
