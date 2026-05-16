const searchState = {
  results: [],
  contacts: [],
  hasSearched: false,
  activeProfileUserId: null,
  activeProfile: null
};

function renderActionButtonContent(icon, text) {
  return `
    <span class="result-action-icon" aria-hidden="true">${icon}</span>
    <span class="result-action-text">${escapeHtml(text)}</span>
  `;
}

function getContactIds() {
  return new Set(searchState.contacts.map((contact) => String(contact.id)));
}

function getContactByUserId(userId) {
  return searchState.contacts.find((contact) => String(contact.id) === String(userId)) || null;
}

function getDirectChatHref(user) {
  return user.chat_id ? getDirectChatRoute(user.chat_id) : getDirectChatDraftRoute(user.id);
}

function getProfileCardUser(user) {
  const contact = getContactByUserId(user?.id);
  if (!contact) {
    return user;
  }

  return {
    ...user,
    ...contact,
    is_contact: true,
    contact_alias: contact.contact_alias ?? user.contact_alias,
    chat_id: contact.chat_id || user.chat_id
  };
}

function renderListName(user) {
  const displayName = getUserProfileDisplayName(user);
  const originalName = getUserProfileOriginalName(user);
  return `
    <div class="result-topline">
      <h3 class="result-name">${escapeHtml(displayName)}</h3>
    </div>
    ${originalName ? `<p class="result-username">${escapeHtml(originalName)}</p>` : ""}
    <p class="result-username">@${escapeHtml(user.username || "")}</p>
  `;
}

function setSearchUserInfoOpen(isOpen) {
  const contentNode = document.querySelector(".content");
  const panel = document.getElementById("searchUserInfoPanel");
  if (!contentNode || !panel) {
    return;
  }

  contentNode.classList.toggle("thread-info-open", Boolean(isOpen));
  panel.setAttribute("aria-hidden", isOpen ? "false" : "true");
}

function setSearchProfileStatus(message, type = "") {
  const statusNode = document.querySelector("#searchUserInfoProfilePanel [data-user-profile-status]");
  if (!statusNode) {
    return;
  }
  statusNode.textContent = message;
  statusNode.className = `status user-profile-actions-status ${type}`.trim();
}

function fillSearchUserInfoPanel(user) {
  const panelBody = document.getElementById("searchUserInfoProfilePanel");
  if (!panelBody || !user) {
    return;
  }

  panelBody.innerHTML = renderUserProfilePanel(getProfileCardUser(user), { showActions: true });
}

async function refreshActiveProfile() {
  if (!searchState.activeProfileUserId) {
    return;
  }

  const user = await apiFetch(`/users/${encodeURIComponent(searchState.activeProfileUserId)}`);
  searchState.activeProfile = getProfileCardUser(user);
  fillSearchUserInfoPanel(searchState.activeProfile);
}

async function openSearchUserInfo(userId) {
  if (!userId) {
    return;
  }

  const user = await apiFetch(`/users/${encodeURIComponent(userId)}`);
  searchState.activeProfileUserId = String(user.id);
  searchState.activeProfile = getProfileCardUser(user);
  fillSearchUserInfoPanel(searchState.activeProfile);
  setSearchUserInfoOpen(true);
}

function closeSearchUserInfo() {
  searchState.activeProfileUserId = null;
  searchState.activeProfile = null;
  setSearchUserInfoOpen(false);
}

function renderContacts(contacts) {
  const contactsList = document.getElementById("contactsList");
  if (!contactsList) return;

  if (!contacts.length) {
    contactsList.innerHTML = '<div class="empty-state">Контактов пока нет</div>';
    return;
  }

  contactsList.innerHTML = contacts
    .map((user) => `
      <article class="result-item result-item-clickable" data-user-profile-id="${escapeHtml(String(user.id))}">
        <div class="avatar small">${escapeHtml(initials(getUserProfileDisplayName(user)))}</div>
        <div class="result-meta">
          ${renderListName(user)}
        </div>
        <div class="result-actions">
          <a class="button button-secondary result-action-button" href="${getDirectChatHref(user)}" aria-label="Открыть">
            ${renderActionButtonContent("↗", "Открыть")}
          </a>
          <button class="button button-secondary result-action-button result-remove-button" type="button" data-contact-action="remove" data-contact-id="${escapeHtml(String(user.id))}" aria-label="Удалить">
            ${renderActionButtonContent("⌫", "Удалить")}
          </button>
        </div>
      </article>
    `)
    .join("");
}

function renderResults(results) {
  const resultList = document.getElementById("resultList");
  if (!resultList) return;

  if (!searchState.hasSearched) {
    resultList.hidden = true;
    resultList.innerHTML = "";
    return;
  }

  resultList.hidden = false;

  if (!results.length) {
    resultList.innerHTML = '<div class="empty-state">Пользователь не найден</div>';
    return;
  }

  const contactIds = getContactIds();

  resultList.innerHTML = results
    .map((rawUser) => {
      const user = getProfileCardUser(rawUser);
      const isContact = contactIds.has(String(user.id)) || Boolean(user.is_contact);
      return `
        <article class="result-item result-item-clickable" data-user-profile-id="${escapeHtml(String(user.id))}">
          <div class="avatar small">${escapeHtml(initials(getUserProfileDisplayName(user)))}</div>
          <div class="result-meta">
            ${renderListName(user)}
          </div>
          <div class="result-actions">
            <a class="button button-secondary result-action-button" href="${getDirectChatHref(user)}" aria-label="Открыть">
              ${renderActionButtonContent("↗", "Открыть")}
            </a>
            <button
              class="button button-secondary result-action-button ${isContact ? "result-remove-button" : ""}"
              type="button"
              data-contact-action="${isContact ? "remove" : "add"}"
              data-contact-id="${escapeHtml(String(user.id))}"
              aria-label="${isContact ? "Убрать из контактов" : "Добавить в контакты"}"
            >${renderActionButtonContent(isContact ? "⌫" : "+", isContact ? "Убрать" : "В контакты")}</button>
          </div>
        </article>
      `;
    })
    .join("");
}

function refreshSearchResults() {
  renderResults(searchState.results);
}

async function loadContacts() {
  const contactsStatus = document.getElementById("contactsStatus");
  try {
    const data = await apiFetch("/contacts");
    searchState.contacts = Array.isArray(data) ? data : data.items || [];
    renderContacts(searchState.contacts);
    refreshSearchResults();
    if (contactsStatus) {
      contactsStatus.textContent = searchState.contacts.length ? `${searchState.contacts.length} в контактах` : "";
      contactsStatus.className = "status";
    }
    if (searchState.activeProfileUserId) {
      await refreshActiveProfile();
    }
  } catch (error) {
    if (contactsStatus) {
      contactsStatus.textContent = error.message;
      contactsStatus.className = "status error";
    }
  }
}

async function addContact(userId) {
  const contactsStatus = document.getElementById("contactsStatus");
  try {
    await apiFetch("/contacts", {
      method: "POST",
      body: JSON.stringify({ user_id: userId })
    });
    if (contactsStatus) {
      contactsStatus.textContent = "Контакт добавлен";
      contactsStatus.className = "status success";
    }
    await loadContacts();
  } catch (error) {
    if (contactsStatus) {
      contactsStatus.textContent = error.message;
      contactsStatus.className = "status error";
    }
    throw error;
  }
}

async function removeContact(userId) {
  const contactsStatus = document.getElementById("contactsStatus");
  try {
    await apiFetch(`/contacts/${encodeURIComponent(userId)}`, {
      method: "DELETE"
    });
    if (contactsStatus) {
      contactsStatus.textContent = "Контакт удален";
      contactsStatus.className = "status success";
    }
    await loadContacts();
  } catch (error) {
    if (contactsStatus) {
      contactsStatus.textContent = error.message;
      contactsStatus.className = "status error";
    }
    throw error;
  }
}

async function renameContact(userId) {
  const currentUser = searchState.activeProfile && String(searchState.activeProfile.id) === String(userId)
    ? searchState.activeProfile
    : getContactByUserId(userId);
  const nextAlias = window.prompt("Новое имя контакта", currentUser?.contact_alias || currentUser?.name || "");
  if (nextAlias == null) {
    return;
  }

  await apiFetch(`/contacts/${encodeURIComponent(userId)}`, {
    method: "PATCH",
    body: JSON.stringify({ alias: nextAlias })
  });
  await loadContacts();
}

async function resetContactAlias(userId) {
  await apiFetch(`/contacts/${encodeURIComponent(userId)}/alias`, {
    method: "DELETE"
  });
  await loadContacts();
}

document.addEventListener("DOMContentLoaded", async () => {
  applyAppSettings();
  requireAuth();
  bindLogout();
  fillUserBadge();
  initSidebarProfile();
  await loadChats();
  await loadContacts();

  const form = document.getElementById("searchForm");
  const input = document.getElementById("searchInput");
  const status = document.getElementById("searchStatus");
  const contactsList = document.getElementById("contactsList");
  const resultList = document.getElementById("resultList");
  const infoCloseButton = document.getElementById("searchUserInfoClose");
  const profilePanel = document.getElementById("searchUserInfoProfilePanel");

  if (!form || !input) return;

  infoCloseButton?.addEventListener("click", () => {
    closeSearchUserInfo();
  });

  const openProfileFromList = (event) => {
    if (event.target.closest(".result-actions")) {
      return;
    }

    const card = event.target.closest("[data-user-profile-id]");
    if (!card) {
      return;
    }

    void openSearchUserInfo(card.dataset.userProfileId);
  };

  contactsList?.addEventListener("click", openProfileFromList);
  resultList?.addEventListener("click", openProfileFromList);

  const handleListContactAction = async (event) => {
    const button = event.target.closest("[data-contact-action]");
    if (!button) {
      return;
    }

    const userId = button.dataset.contactId;
    if (!userId) {
      return;
    }

    if (button.dataset.contactAction === "remove") {
      await removeContact(userId);
      return;
    }

    await addContact(userId);
  };

  contactsList?.addEventListener("click", (event) => {
    void handleListContactAction(event);
  });

  resultList?.addEventListener("click", (event) => {
    void handleListContactAction(event);
  });

  profilePanel?.addEventListener("click", async (event) => {
    const menuTrigger = event.target.closest("[data-user-profile-menu-trigger]");
    if (menuTrigger) {
      event.preventDefault();
      event.stopPropagation();
      toggleUserProfileActionMenu(menuTrigger.closest("[data-user-profile-card]"));
      return;
    }

    const usernameButton = event.target.closest("[data-profile-copy-username]");
    if (usernameButton) {
      closeUserProfileActionMenus();
      const username = String(usernameButton.dataset.profileCopyUsername || "").trim();
      if (!username) {
        return;
      }
      if (!navigator.clipboard?.writeText) {
        setSearchProfileStatus("Буфер обмена недоступен", "error");
        return;
      }
      try {
        await navigator.clipboard.writeText(`@${username}`);
        showAppToast("Username скопирован");
        setSearchProfileStatus("", "");
      } catch {
        setSearchProfileStatus("Не удалось скопировать username", "error");
      }
      return;
    }

    const actionButton = event.target.closest("[data-profile-contact-action]");
    if (!actionButton) {
      return;
    }

    closeUserProfileActionMenus();

    const action = actionButton.dataset.profileContactAction;
    const userId = actionButton.dataset.profileUserId;
    if (!action || !userId) {
      return;
    }

    try {
      if (action === "copy-username") {
        const username = String(searchState.activeProfile?.username || "").trim();
        if (!username) {
          setSearchProfileStatus("Username не указан", "error");
          return;
        }
        if (!navigator.clipboard?.writeText) {
          setSearchProfileStatus("Буфер обмена недоступен", "error");
          return;
        }
        await navigator.clipboard.writeText(`@${username}`);
        showAppToast("Username скопирован");
        setSearchProfileStatus("", "");
        return;
      }

      if (action === "add") {
        setSearchProfileStatus("Добавляем контакт...", "");
        await addContact(userId);
        setSearchProfileStatus("Контакт добавлен", "success");
        return;
      }

      if (action === "remove") {
        setSearchProfileStatus("Удаляем контакт...", "");
        await removeContact(userId);
        setSearchProfileStatus("Контакт удален", "success");
        return;
      }

      if (action === "rename") {
        setSearchProfileStatus("Сохраняем имя контакта...", "");
        await renameContact(userId);
        setSearchProfileStatus("Имя контакта обновлено", "success");
        return;
      }

      if (action === "reset-alias") {
        setSearchProfileStatus("Возвращаем исходное имя...", "");
        await resetContactAlias(userId);
        setSearchProfileStatus("Имя контакта сброшено", "success");
      }
    } catch (error) {
      setSearchProfileStatus(error.message, "error");
    }
  });

  input.addEventListener("input", () => {
    if (input.value.trim()) {
      return;
    }

    searchState.results = [];
    searchState.hasSearched = false;
    renderResults(searchState.results);
    status.textContent = "";
    status.className = "status";
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const query = input.value.trim().replace(/^@/, "");
    if (!query) {
      searchState.results = [];
      searchState.hasSearched = false;
      renderResults(searchState.results);
      status.textContent = "";
      status.className = "status";
      return;
    }

    status.textContent = "Поиск...";
    status.className = "status";

    try {
      const data = await apiFetch(`/users/search?username=${encodeURIComponent(query)}`);
      searchState.results = Array.isArray(data) ? data : data.items || [];
      searchState.hasSearched = true;
      renderResults(searchState.results);
      status.textContent = `${searchState.results.length} найдено`;
      status.className = "status";
    } catch (error) {
      searchState.hasSearched = true;
      searchState.results = [];
      renderResults(searchState.results);
      status.textContent = error.message;
      status.className = "status error";
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeUserProfileActionMenus();
      const panel = document.getElementById("searchUserInfoPanel");
      if (panel?.getAttribute("aria-hidden") === "false") {
        closeSearchUserInfo();
      }
    }
  });

  document.addEventListener("click", (event) => {
    if (!event.target.closest("[data-user-profile-card]")) {
      closeUserProfileActionMenus();
    }
  });
});
