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

async function loadChats(listId = "chatList") {
  const list = document.getElementById(listId);
  if (!list) return [];

  list.innerHTML = '<div class="empty-state">Загрузка чатов...</div>';

  try {
    const chats = await apiFetch("/chats");
    renderChats(list, Array.isArray(chats) ? chats : chats.items || []);
    return chats;
  } catch (error) {
    list.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    return [];
  }
}

function renderChats(list, chats) {
  if (!chats.length) {
    list.innerHTML = '<div class="empty-state">Чатов пока нет</div>';
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
