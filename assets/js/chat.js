function renderMessages(container, messages, currentUserId) {
  if (!messages.length) {
    container.innerHTML = '<div class="empty-state">Сообщений пока нет</div>';
    return;
  }

  container.innerHTML = messages
    .map((message) => {
      const own = String(message.sender_id) === String(currentUserId);
      return `
        <article class="message ${own ? "own" : ""}">
          ${!own && message.sender_name ? `<p class="message-author">${escapeHtml(message.sender_name)}</p>` : ""}
          <p class="message-text">${escapeHtml(message.text || "")}</p>
          <span class="message-time">${escapeHtml(formatTime(message.created_at))}</span>
        </article>
      `;
    })
    .join("");

  container.scrollTop = container.scrollHeight;
}

function setChatTitle(title, subtitle = "") {
  const titleNode = document.getElementById("chatTitle");
  const subtitleNode = document.getElementById("chatSubtitle");
  const avatarNode = document.getElementById("chatAvatar");
  if (titleNode) titleNode.textContent = title;
  if (subtitleNode) subtitleNode.textContent = subtitle;
  if (avatarNode) avatarNode.textContent = initials(title || "Чат");
}

document.addEventListener("DOMContentLoaded", async () => {
  requireAuth();
  bindLogout();
  fillUserBadge();
  const chats = await loadChats();

  const params = new URLSearchParams(window.location.search);
  let chatId = params.get("id");
  const userId = params.get("user_id");
  const chatType = document.body.dataset.chatType || "direct";
  const currentUser = getCurrentUser() || {};

  const messagesNode = document.getElementById("messages");
  const composer = document.getElementById("messageForm");
  const status = document.getElementById("messageStatus");

  if (!messagesNode || !composer) {
    return;
  }

  async function ensureDirectChat() {
    if (chatId || chatType === "group" || !userId) return;

    const attempts = [
      { path: "/chats", body: { user_id: userId } },
      { path: "/chats", body: { participant_id: userId } },
      { path: "/chats/direct", body: { user_id: userId } }
    ];

    for (const attempt of attempts) {
      try {
        const data = await apiFetch(attempt.path, {
          method: "POST",
          body: JSON.stringify(attempt.body)
        });
        chatId = String(data.id || data.chat_id || "");
        if (chatId) {
          window.history.replaceState({}, "", `chat.html?id=${encodeURIComponent(chatId)}`);
          return;
        }
      } catch {
        continue;
      }
    }

    throw new Error("Не удалось открыть личный чат");
  }

  async function loadThread() {
    const path = chatType === "group" ? `/groups/${chatId}` : `/chats/${chatId}`;
    const data = await apiFetch(path);
    const currentChat = Array.isArray(chats)
      ? chats.find((chat) => String(chat.id) === String(chatId) && (chat.type || "direct") === chatType)
      : null;
    const title = currentChat?.title || data.title || data.name || data.username || "Чат";
    const subtitle = chatType === "group"
      ? `${(data.members_count || data.members?.length || 0)} участников`
      : data.username ? `@${data.username}` : "в сети";

    setChatTitle(title, subtitle);
    renderMessages(messagesNode, data.messages || [], currentUser.id);
  }

  try {
    await ensureDirectChat();
    if (!chatId) {
      throw new Error("Чат не найден");
    }
    await loadThread();
  } catch (error) {
    messagesNode.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
  }

  composer.addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = document.getElementById("messageInput");
    const text = input.value.trim();
    if (!text) return;

    status.textContent = "Отправка...";

    try {
      const path = chatType === "group" ? `/groups/${chatId}/messages` : `/chats/${chatId}/messages`;
      await apiFetch(path, {
        method: "POST",
        body: JSON.stringify({ text })
      });
      input.value = "";
      status.textContent = "";
      await loadThread();
    } catch (error) {
      status.textContent = error.message;
      status.className = "status error";
    }
  });
});
