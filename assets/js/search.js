const searchState = {
  results: [],
  contacts: []
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

function getDirectChatHref(user) {
  return `chat.html?${user.chat_id ? `id=${encodeURIComponent(user.chat_id)}` : `user_id=${encodeURIComponent(user.id)}`}`;
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
      <article class="result-item">
        <div class="avatar small">${escapeHtml(initials(user.name || user.username || "U"))}</div>
        <div class="result-meta">
          <div class="result-topline">
            <h3 class="result-name">${escapeHtml(user.name || user.username || "User")}</h3>
          </div>
          <p class="result-username">@${escapeHtml(user.username || "")}</p>
        </div>
        <div class="result-actions">
          <a class="button button-secondary result-action-button" href="${getDirectChatHref(user)}" aria-label="Открыть">
            ${renderActionButtonContent("↗", "Открыть")}
          </a>
          <button class="button button-secondary result-action-button result-remove-button" type="button" data-remove-contact="${escapeHtml(String(user.id))}" aria-label="Удалить">
            ${renderActionButtonContent("⌫", "Удалить")}
          </button>
        </div>
      </article>
    `)
    .join("");

  contactsList.querySelectorAll("[data-remove-contact]").forEach((button) => {
    button.addEventListener("click", async () => {
      await removeContact(button.dataset.removeContact);
    });
  });
}

function renderResults(results) {
  const resultList = document.getElementById("resultList");
  if (!resultList) return;

  if (!results.length) {
    resultList.innerHTML = '<div class="empty-state">Ничего не найдено</div>';
    return;
  }

  const contactIds = getContactIds();

  resultList.innerHTML = results
    .map((user) => {
      const isContact = contactIds.has(String(user.id)) || Boolean(user.is_contact);
      return `
        <article class="result-item">
          <div class="avatar small">${escapeHtml(initials(user.name || user.username || "U"))}</div>
          <div class="result-meta">
            <div class="result-topline">
              <h3 class="result-name">${escapeHtml(user.name || user.username || "User")}</h3>
            </div>
            <p class="result-username">@${escapeHtml(user.username || "")}</p>
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

  resultList.querySelectorAll("[data-contact-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      const userId = button.dataset.contactId;
      if (!userId) return;

      if (button.dataset.contactAction === "remove") {
        await removeContact(userId);
        return;
      }

      await addContact(userId);
    });
  });
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
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  requireAuth();
  bindLogout();
  fillUserBadge();
  initSidebarProfile();
  await loadChats();
  await loadContacts();

  const form = document.getElementById("searchForm");
  const input = document.getElementById("searchInput");
  const status = document.getElementById("searchStatus");

  if (!form || !input) return;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const query = input.value.trim().replace(/^@/, "");
    if (!query) return;

    status.textContent = "Поиск...";
    status.className = "status";

    try {
      const data = await apiFetch(`/users/search?username=${encodeURIComponent(query)}`);
      searchState.results = Array.isArray(data) ? data : data.items || [];
      renderResults(searchState.results);
      status.textContent = `${searchState.results.length} найдено`;
      status.className = "status";
    } catch (error) {
      status.textContent = error.message;
      status.className = "status error";
    }
  });
});
