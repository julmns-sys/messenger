const chatState = {
  allChats: [],
  refreshIntervalId: null,
  refreshListId: null
};

function bindLogout(buttonId = "logoutButton") {
  const logoutButton = document.getElementById(buttonId);
  if (!logoutButton) return;

  logoutButton.addEventListener("click", () => {
    clearSession();
    window.location.href = "login.html";
  });
}

function fillUserBadge(targetId = "currentUserBadge") {
  const target = document.getElementById(targetId);
  const user = getCurrentUser();
  if (!target || !user) return;
  target.textContent = user.username ? `@${user.username}` : user.name || "User";
}

function getChatSearchQuery() {
  return document.querySelector(".sidebar-search .search-input")?.value.trim() || "";
}

async function loadChats(listId = "chatList", options = {}) {
  const { showLoading = true } = options;
  const list = document.getElementById(listId);
  if (!list) return [];

  if (showLoading) {
    list.innerHTML = '<div class="empty-state">Загрузка чатов...</div>';
  }

  try {
    const chats = await apiFetch("/chats");
    const normalizedChats = Array.isArray(chats) ? chats : chats.items || [];
    chatState.allChats = normalizedChats;
    bindChatSearch(listId);
    renderChats(list, filterChats(getChatSearchQuery()));
    return normalizedChats;
  } catch (error) {
    if (showLoading) {
      list.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
      chatState.allChats = [];
      return [];
    }

    return chatState.allChats;
  }
}

function filterChats(query) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return chatState.allChats;
  }

  return chatState.allChats.filter((chat) => {
    const haystack = [
      chat.title,
      chat.username,
      chat.last_message?.text
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    return haystack.includes(normalizedQuery);
  });
}

function bindChatSearch(listId = "chatList") {
  const list = document.getElementById(listId);
  const input = document.querySelector(".sidebar-search .search-input");
  if (!list || !input || input.dataset.chatSearchBound === "true") {
    return;
  }

  input.dataset.chatSearchBound = "true";
  input.addEventListener("input", () => {
    renderChats(list, filterChats(input.value));
  });
}

function stopChatsAutoRefresh() {
  if (chatState.refreshIntervalId) {
    clearInterval(chatState.refreshIntervalId);
    chatState.refreshIntervalId = null;
  }

  chatState.refreshListId = null;
}

function startChatsAutoRefresh(listId = "chatList", intervalMs = 2000) {
  const list = document.getElementById(listId);
  if (!list) return;

  if (chatState.refreshIntervalId && chatState.refreshListId === listId) {
    return;
  }

  stopChatsAutoRefresh();
  chatState.refreshListId = listId;
  chatState.refreshIntervalId = window.setInterval(() => {
    loadChats(listId, { showLoading: false });
  }, intervalMs);
}

window.addEventListener("pagehide", stopChatsAutoRefresh);
window.addEventListener("beforeunload", stopChatsAutoRefresh);

function renderChats(list, chats) {
  if (!chats.length) {
    const hasQuery = Boolean(document.querySelector(".sidebar-search .search-input")?.value.trim());
    list.innerHTML = `<div class="empty-state">${hasQuery ? "Ничего не найдено" : "Чатов пока нет"}</div>`;
    return;
  }

  const currentPath = window.location.pathname.split("/").pop() || "index.html";
  const currentId = new URLSearchParams(window.location.search).get("id");

  list.innerHTML = chats
    .map((chat) => {
      const href = chat.type === "group" ? `group_chat.html?id=${chat.id}` : `chat.html?id=${chat.id}`;
      const preview = chat.last_message?.text || "Нет сообщений";
      const name = chat.title || chat.username || chat.name || "Чат";
      const isGroup = chat.type === "group";
      const active = currentPath === "group_chat.html"
        ? isGroup && String(chat.id) === currentId
        : currentPath === "chat.html"
          ? !isGroup && String(chat.id) === currentId
          : false;

      return `
        <a class="chat-item ${active ? "active" : ""}" href="${href}">
          <div class="avatar">${escapeHtml(initials(name))}</div>
          <div class="chat-meta">
            <div class="chat-topline">
              <h3 class="chat-name">${escapeHtml(name)}</h3>
              <span class="time">${escapeHtml(formatDate(chat.updated_at || chat.last_message?.created_at))}</span>
            </div>
            <p class="chat-preview">${escapeHtml(preview)}</p>
          </div>
        </a>
      `;
    })
    .join("");
}
