const selectedMembers = new Map();
const createGroupState = {
  contacts: []
};

function getSelectedMemberIds() {
  return new Set([...selectedMembers.keys()]);
}

function updateCreateGroupButtonState() {
  const submitButton = document.querySelector('#createGroupForm button[type="submit"]');
  const titleInput = document.getElementById("groupTitle");
  if (!submitButton || !titleInput) {
    return;
  }

  const hasTitle = Boolean(titleInput.value.trim());
  const hasMembers = selectedMembers.size > 0;
  submitButton.disabled = !(hasTitle && hasMembers);
}

function toggleMemberSelection(user) {
  if (!user?.id) {
    return;
  }

  const userId = String(user.id);
  if (selectedMembers.has(userId)) {
    selectedMembers.delete(userId);
  } else {
    selectedMembers.set(userId, user);
  }

  renderSelectedMembers();
  renderContactsList(createGroupState.contacts);
  updateCreateGroupButtonState();
}

function renderSelectedMembers() {
  const container = document.getElementById("selectedMembers");
  if (!container) return;

  const users = [...selectedMembers.values()];
  if (!users.length) {
    container.innerHTML = '<p class="muted">Добавьте хотя бы одного участника</p>';
    return;
  }

  container.innerHTML = users.map((user) => `
    <span class="chip">
      @${escapeHtml(user.username)}
      <button type="button" data-remove="${escapeHtml(String(user.id))}" aria-label="Убрать участника">×</button>
    </span>
  `).join("");

  container.querySelectorAll("[data-remove]").forEach((button) => {
    button.addEventListener("click", () => {
      selectedMembers.delete(button.dataset.remove);
      renderSelectedMembers();
      renderContactsList(createGroupState.contacts);
      updateCreateGroupButtonState();
    });
  });
}

function renderSelectableUsers(listId, users, emptyMessage) {
  const list = document.getElementById(listId);
  if (!list) return;

  if (!users.length) {
    list.innerHTML = `<div class="empty-state">${escapeHtml(emptyMessage)}</div>`;
    return;
  }

  const selectedIds = getSelectedMemberIds();
  list.innerHTML = users.map((user) => {
    const userId = String(user.id);
    const isSelected = selectedIds.has(userId);
    return `
      <article class="thread-member-option${isSelected ? " selected" : ""}" data-select-user="${escapeHtml(userId)}" data-list-id="${escapeHtml(listId)}">
        <div class="avatar small">${escapeHtml(initials(user.name || user.username || "U"))}</div>
        <div class="result-meta">
          <h3 class="result-name">${escapeHtml(user.name || user.username || "User")}</h3>
          <p class="result-username">@${escapeHtml(user.username || "")}</p>
        </div>
        <input class="thread-member-option-check" type="checkbox" ${isSelected ? "checked" : ""} aria-label="Выбрать пользователя">
      </article>
    `;
  }).join("");
}

function renderContactsList(contacts) {
  createGroupState.contacts = contacts;
  renderSelectableUsers("memberContactsList", contacts, "Контактов пока нет");
}

async function loadContacts() {
  const status = document.getElementById("memberContactsStatus");
  const list = document.getElementById("memberContactsList");
  const searchInput = document.getElementById("memberSearchInput");

  if (status) {
    status.textContent = "Загрузка контактов...";
    status.className = "status";
  }
  if (list) {
    list.innerHTML = '<div class="empty-state">Загрузка контактов...</div>';
  }

  try {
    const data = await apiFetch("/contacts");
    const contacts = Array.isArray(data) ? data : data.items || [];
    createGroupState.contacts = contacts;
    renderContactsList(contacts);
    filterContacts(searchInput?.value || "");
    if (status) {
      status.textContent = contacts.length ? `${contacts.length} контактов` : "";
      status.className = "status";
    }
  } catch (error) {
    createGroupState.contacts = [];
    renderContactsList([]);
    if (status) {
      status.textContent = error.message;
      status.className = "status error";
    }
  }
}

function findUserById(userId) {
  return createGroupState.contacts.find((user) => String(user.id) === String(userId)) || null;
}

function filterContacts(query = "") {
  const normalizedQuery = query.trim().replace(/^@/, "").toLowerCase();
  const filteredContacts = normalizedQuery
    ? createGroupState.contacts.filter((user) => {
      const username = String(user.username || "").toLowerCase();
      const name = String(user.name || "").toLowerCase();
      return username.includes(normalizedQuery) || name.includes(normalizedQuery);
    })
    : createGroupState.contacts;

  renderSelectableUsers("memberContactsList", filteredContacts, normalizedQuery ? "Контакты не найдены" : "Контактов пока нет");
}

document.addEventListener("DOMContentLoaded", async () => {
  requireAuth();
  bindLogout();
  fillUserBadge();
  initSidebarProfile();
  await loadChats();
  renderSelectedMembers();
  await loadContacts();
  updateCreateGroupButtonState();

  const searchForm = document.getElementById("memberSearchForm");
  const createForm = document.getElementById("createGroupForm");
  const searchInput = document.getElementById("memberSearchInput");
  const searchStatus = document.getElementById("memberSearchStatus");
  const groupStatus = document.getElementById("groupStatus");
  const titleInput = document.getElementById("groupTitle");
  const contactsList = document.getElementById("memberContactsList");

  titleInput?.addEventListener("input", updateCreateGroupButtonState);

  const bindSelectionList = (node) => {
    node?.addEventListener("click", (event) => {
      const card = event.target.closest("[data-select-user]");
      if (!card) {
        return;
      }

      const user = findUserById(card.dataset.selectUser);
      if (!user) {
        return;
      }

      toggleMemberSelection(user);
    });
  };

  bindSelectionList(contactsList);

  searchInput?.addEventListener("input", () => {
    filterContacts(searchInput.value);
    if (searchStatus) {
      searchStatus.textContent = "";
      searchStatus.className = "status";
    }
  });

  if (searchForm) {
    searchForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const query = searchInput?.value.trim() || "";

      if (searchStatus) {
        searchStatus.textContent = query ? "Поиск по контактам..." : "";
        searchStatus.className = "status";
      }
      filterContacts(query);
      if (searchStatus) {
        const normalizedQuery = query.trim();
        if (!normalizedQuery) {
          searchStatus.textContent = "";
        } else {
          const filteredCount = document.querySelectorAll('#memberContactsList [data-select-user]').length;
          searchStatus.textContent = filteredCount ? `${filteredCount} найдено` : "Контакты не найдены";
        }
        searchStatus.className = "status";
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
        if (groupStatus) {
          groupStatus.textContent = "Укажите название и добавьте участников";
          groupStatus.className = "status error";
        }
        return;
      }

      if (title.length > 16) {
        if (groupStatus) {
          groupStatus.textContent = "Название группы: максимум 16 символов";
          groupStatus.className = "status error";
        }
        return;
      }

      if (groupStatus) {
        groupStatus.textContent = "Создание группы...";
        groupStatus.className = "status";
      }

      try {
        const group = await apiFetch("/groups", {
          method: "POST",
          body: JSON.stringify({
            title,
            description,
            member_ids: memberIds
          })
        });

        setChatTag(group.id, "group", {
          label: "Группа",
          color: "#5ec7aa"
        });
        window.location.href = getGroupChatRoute(group.id);
      } catch (error) {
        if (groupStatus) {
          groupStatus.textContent = error.message;
          groupStatus.className = "status error";
        }
      }
    });
  }
});
