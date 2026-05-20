const selectedMembers = new Map();
const createGroupState = {
  contacts: [],
  searchResults: [],
  activeSearchRequestId: 0
};

function mergeUsersById(...groups) {
  const users = new Map();
  groups.flat().forEach((user) => {
    if (!user?.id) {
      return;
    }

    const userId = String(user.id);
    users.set(userId, {
      ...(users.get(userId) || {}),
      ...user
    });
  });
  return [...users.values()];
}

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
      <button type="button" data-remove="${escapeHtml(String(user.id))}" aria-label="Убрать участника"><img class="icon-asset" src="/assets/icons/ui/Close_round.svg" alt=""></button>
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
          <h3 class="result-name">${renderSystemAccountLabel(user.name || user.username || "User", user)}</h3>
          <p class="result-username">${user.username ? renderSystemAccountLabel(`@${user.username}`, user) : ""}</p>
        </div>
        <input class="thread-member-option-check" type="checkbox" ${isSelected ? "checked" : ""} aria-label="Выбрать пользователя">
      </article>
    `;
  }).join("");
}

function renderContactsList(contacts) {
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
  return mergeUsersById(createGroupState.contacts, createGroupState.searchResults)
    .find((user) => String(user.id) === String(userId)) || null;
}

function getFilteredCreateGroupUsers(query = "") {
  const normalizedQuery = query.trim().replace(/^@/, "").toLowerCase();
  const sourceUsers = normalizedQuery
    ? mergeUsersById(createGroupState.contacts, createGroupState.searchResults)
    : createGroupState.contacts;

  return normalizedQuery
    ? sourceUsers.filter((user) => {
      const username = String(user.username || "").toLowerCase();
      const name = String(user.name || "").toLowerCase();
      return username.includes(normalizedQuery) || name.includes(normalizedQuery);
    })
    : sourceUsers;
}

function filterContacts(query = "") {
  const normalizedQuery = query.trim().replace(/^@/, "").toLowerCase();
  const filteredContacts = getFilteredCreateGroupUsers(query);
  renderSelectableUsers(
    "memberContactsList",
    filteredContacts,
    normalizedQuery ? "Пользователи не найдены" : "Контактов пока нет"
  );
  return filteredContacts;
}

async function searchUsersForGroup(query = "") {
  const searchStatus = document.getElementById("memberSearchStatus");
  const normalizedQuery = query.trim().replace(/^@/, "");
  const requestId = ++createGroupState.activeSearchRequestId;

  if (!normalizedQuery) {
    createGroupState.searchResults = [];
    const localResults = filterContacts("");
    if (searchStatus) {
      searchStatus.textContent = "";
      searchStatus.className = "status";
    }
    return localResults;
  }

  const localResults = filterContacts(normalizedQuery);
  if (searchStatus) {
    searchStatus.textContent = "Ищем пользователей...";
    searchStatus.className = "status";
  }

  try {
    const data = await apiFetch(`/users/search?username=${encodeURIComponent(normalizedQuery)}`);
    if (requestId !== createGroupState.activeSearchRequestId) {
      return localResults;
    }

    createGroupState.searchResults = Array.isArray(data) ? data : data.items || [];
    const results = filterContacts(normalizedQuery);
    if (searchStatus) {
      searchStatus.textContent = results.length ? `${results.length} найдено` : "Пользователи не найдены";
      searchStatus.className = "status";
    }
    return results;
  } catch (error) {
    if (requestId !== createGroupState.activeSearchRequestId) {
      return localResults;
    }

    createGroupState.searchResults = [];
    const fallbackResults = filterContacts(normalizedQuery);
    if (searchStatus) {
      searchStatus.textContent = fallbackResults.length ? `${fallbackResults.length} найдено` : error.message;
      searchStatus.className = fallbackResults.length ? "status" : "status error";
    }
    return fallbackResults;
  }
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
    const query = searchInput.value;
    if (!query.trim()) {
      createGroupState.searchResults = [];
      createGroupState.activeSearchRequestId += 1;
      filterContacts("");
      if (searchStatus) {
        searchStatus.textContent = "";
        searchStatus.className = "status";
      }
      return;
    }

    filterContacts(query);
  });

  if (searchForm) {
    searchForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const query = searchInput?.value.trim() || "";
      await searchUsersForGroup(query);
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
