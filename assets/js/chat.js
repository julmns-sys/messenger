const renderedMessages = new Set();
const BOTTOM_THRESHOLD = 24;

function getMessageKey(message) {
  if (message.id != null) {
    return `id:${message.id}`;
  }

  return [
    message.sender_id || "",
    message.sender_name || "",
    message.text || "",
    message.created_at || ""
  ].join("|");
}

function renderReadIndicator(message, own, chatType) {
  if (!own || chatType !== "direct") {
    return "";
  }

  return `
    <span
      class="message-read-indicator ${message.is_read ? "read" : "unread"}"
      aria-label="${message.is_read ? "Прочитано" : "Не прочитано"}"
      title="${message.is_read ? "Прочитано" : "Не прочитано"}"
    >
      <span></span>
      <span></span>
    </span>
  `;
}

function renderMessageItem(message, currentUserId, chatType) {
  const own = String(message.sender_id) === String(currentUserId);
  return `
    <article class="message ${own ? "own" : ""}" ${message.id != null ? `data-message-id="${escapeHtml(String(message.id))}"` : ""}>
      ${!own && message.sender_name ? `<p class="message-author">${escapeHtml(message.sender_name)}</p>` : ""}
      <p class="message-text">${escapeHtml(message.text || "")}</p>
      <div class="message-meta">
        <span class="message-time">${escapeHtml(formatTime(message.created_at))}</span>
        ${renderReadIndicator(message, own, chatType)}
      </div>
    </article>
  `;
}

function renderPendingMessageItem(text) {
  return `
    <article class="message own pending" data-pending-message="true">
      <p class="message-text">${escapeHtml(text || "")}</p>
      <div class="message-meta">
        <span class="message-status-indicator" aria-hidden="true">
          <span></span>
          <span></span>
          <span></span>
        </span>
      </div>
    </article>
  `;
}

function renderMessages(container, messages, currentUserId, chatType) {
  renderedMessages.clear();

  if (!messages.length) {
    container.innerHTML = '<div class="empty-state">Сообщений пока нет</div>';
    return;
  }

  container.innerHTML = messages
    .map((message) => {
      renderedMessages.add(getMessageKey(message));
      return renderMessageItem(message, currentUserId, chatType);
    })
    .join("");

  container.scrollTop = container.scrollHeight;
}

function appendMessage(container, message, currentUserId, chatType) {
  const key = getMessageKey(message);
  if (renderedMessages.has(key)) {
    return false;
  }

  renderedMessages.add(key);

  if (container.querySelector(".empty-state")) {
    container.innerHTML = "";
  }

  container.insertAdjacentHTML("beforeend", renderMessageItem(message, currentUserId, chatType));
  return true;
}

function isNearBottom(container) {
  return container.scrollHeight - container.scrollTop - container.clientHeight <= BOTTOM_THRESHOLD;
}

function scrollMessagesToBottom(container) {
  container.scrollTop = container.scrollHeight;
}

function appendPendingMessage(container, text) {
  if (container.querySelector(".empty-state")) {
    container.innerHTML = "";
  }

  container.insertAdjacentHTML("beforeend", renderPendingMessageItem(text));
  return container.lastElementChild;
}

function removePendingMessage(node) {
  if (node?.parentNode) {
    node.parentNode.removeChild(node);
  }
}

function markOwnMessagesAsRead(container, uptoMessageId) {
  if (!uptoMessageId) return;

  container.querySelectorAll(".message.own[data-message-id]").forEach((node) => {
    const messageId = Number(node.dataset.messageId || "0");
    if (!messageId || messageId > uptoMessageId) {
      return;
    }

    const indicator = node.querySelector(".message-read-indicator");
    if (!indicator) {
      return;
    }

    indicator.classList.remove("unread");
    indicator.classList.add("read");
    indicator.setAttribute("aria-label", "Прочитано");
    indicator.setAttribute("title", "Прочитано");
  });
}

function updateScrollDownButton(container, button) {
  if (!button) return;
  button.classList.toggle("visible", !isNearBottom(container));
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
  await loadChats();
  startChatsAutoRefresh();

  const params = new URLSearchParams(window.location.search);
  let chatId = params.get("id");
  const userId = params.get("user_id");
  const chatType = document.body.dataset.chatType || "direct";
  const currentUser = getCurrentUser() || {};

  const messagesNode = document.getElementById("messages");
  const composer = document.getElementById("messageForm");
  const status = document.getElementById("messageStatus");
  const input = document.getElementById("messageInput");
  const scrollDownButton = document.getElementById("scrollDownButton");
  const sendButton = composer.querySelector('button[type="submit"]');
  let socket = null;
  let selectedUser = null;
  let pendingMessageState = null;
  let isSendingMessage = false;
  let isMarkingRead = false;

  if (!messagesNode || !composer || !input) {
    return;
  }

  async function loadSelectedUser() {
    if (chatId || chatType === "group" || !userId) {
      return null;
    }

    selectedUser = await apiFetch(`/users/${encodeURIComponent(userId)}`);
    return selectedUser;
  }

  function renderPendingDirectChat(user) {
    const title = user?.name || user?.username || "Чат";
    const subtitle = user?.username ? `@${user.username}` : "";
    setChatTitle(title, subtitle);
    renderMessages(messagesNode, [], currentUser.id, chatType);
    updateScrollDownButton(messagesNode, scrollDownButton);
  }

  async function markCurrentDirectChatAsRead() {
    if (chatType !== "direct" || !chatId || isMarkingRead) {
      return;
    }

    isMarkingRead = true;
    try {
      const result = await apiFetch(`/chats/${chatId}/read`, {
        method: "POST"
      });
      if (result?.upto_message_id) {
        markOwnMessagesAsRead(messagesNode, Number(result.upto_message_id));
      }
    } catch {
      // Ignore transient read receipt errors.
    } finally {
      isMarkingRead = false;
    }
  }

  async function createDirectChatOnFirstMessage() {
    if (chatId || chatType === "group" || !userId) {
      return chatId;
    }

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
        const createdChatId = String(data.id || data.chat_id || "");
        if (!createdChatId) {
          continue;
        }

        chatId = createdChatId;
        window.history.replaceState({}, "", `chat.html?id=${encodeURIComponent(chatId)}`);
        return chatId;
      } catch {
        continue;
      }
    }

    throw new Error("Не удалось создать личный чат");
  }

  async function loadThread() {
    const path = chatType === "group" ? `/groups/${chatId}` : `/chats/${chatId}`;
    const data = await apiFetch(path);
    const currentChat = Array.isArray(chatState.allChats)
      ? chatState.allChats.find((chat) => String(chat.id) === String(chatId) && (chat.type || "direct") === chatType)
      : null;
    const title = currentChat?.title || data.title || data.name || data.username || "Чат";
    const subtitle = chatType === "group"
      ? `${(data.members_count || data.members?.length || 0)} участников`
      : data.username ? `@${data.username}` : "в сети";

    setChatTitle(title, subtitle);
    renderMessages(messagesNode, data.messages || [], currentUser.id, chatType);
    scrollMessagesToBottom(messagesNode);
    updateScrollDownButton(messagesNode, scrollDownButton);
  }

  function connectRealtime() {
    if (typeof io !== "function" || !chatId) {
      return;
    }

    const joinPayload = {
      type: chatType === "group" ? "group" : "direct",
      id: chatId
    };

    if (!socket) {
      socket = io(API.baseUrl, {
        auth: {
          token: getToken()
        }
      });

      socket.on("connect", () => {
        socket.emit("join_chat", joinPayload);
      });

      socket.on("new_message", (message) => {
        const shouldStickToBottom = isNearBottom(messagesNode);
        if (
          pendingMessageState &&
          String(message.sender_id) === String(currentUser.id) &&
          String(message.text || "") === String(pendingMessageState.text || "")
        ) {
          removePendingMessage(pendingMessageState.node);
          pendingMessageState = null;
        }

        const appended = appendMessage(messagesNode, message, currentUser.id, chatType);

        if (!appended) {
          return;
        }

        if (shouldStickToBottom) {
          scrollMessagesToBottom(messagesNode);
        }

        if (chatType === "direct" && String(message.sender_id) !== String(currentUser.id)) {
          markCurrentDirectChatAsRead();
        }

        updateScrollDownButton(messagesNode, scrollDownButton);
      });

      socket.on("message_read", (data) => {
        if (
          chatType !== "direct" ||
          String(data?.chat_id) !== String(chatId) ||
          String(data?.reader_id) === String(currentUser.id)
        ) {
          return;
        }

        markOwnMessagesAsRead(messagesNode, Number(data?.upto_message_id || 0));
      });
    }

    socket.emit("join_chat", joinPayload);
  }

  try {
    if (chatId) {
      await loadThread();
      await markCurrentDirectChatAsRead();
      connectRealtime();
    } else if (chatType !== "group" && userId) {
      const user = await loadSelectedUser();
      renderPendingDirectChat(user);
    } else {
      throw new Error("Чат не найден");
    }
  } catch (error) {
    messagesNode.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
  }

  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey) {
      return;
    }

    if (!input.value.trim()) {
      event.preventDefault();
      return;
    }

    event.preventDefault();
    composer.requestSubmit();
  });

  messagesNode.addEventListener("scroll", () => {
    updateScrollDownButton(messagesNode, scrollDownButton);
  });

  if (scrollDownButton) {
    scrollDownButton.addEventListener("click", () => {
      scrollMessagesToBottom(messagesNode);
      updateScrollDownButton(messagesNode, scrollDownButton);
    });
  }

  composer.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (isSendingMessage) return;

    const text = input.value.trim();
    if (!text) return;

    isSendingMessage = true;
    const shouldStickToBottom = isNearBottom(messagesNode);
    const pendingMessageNode = appendPendingMessage(messagesNode, text);
    pendingMessageState = { text, node: pendingMessageNode };
    input.value = "";
    input.disabled = true;
    if (sendButton) {
      sendButton.disabled = true;
    }
    if (shouldStickToBottom) {
      scrollMessagesToBottom(messagesNode);
    }
    updateScrollDownButton(messagesNode, scrollDownButton);

    status.textContent = "";
    status.className = "status thread-status";

    try {
      const hadChatId = Boolean(chatId);
      if (!hadChatId && chatType !== "group") {
        await createDirectChatOnFirstMessage();
      }

      const path = chatType === "group" ? `/groups/${chatId}/messages` : `/chats/${chatId}/messages`;
      const sentMessage = await apiFetch(path, {
        method: "POST",
        body: JSON.stringify({ text })
      });

      removePendingMessage(pendingMessageNode);
      pendingMessageState = null;
      appendMessage(messagesNode, sentMessage, currentUser.id, chatType);
      if (shouldStickToBottom) {
        scrollMessagesToBottom(messagesNode);
      }

      if (!hadChatId && chatType !== "group") {
        await loadChats("chatList", { showLoading: false });
        await loadThread();
        await markCurrentDirectChatAsRead();
        connectRealtime();
      }
      status.textContent = "";
    } catch (error) {
      status.textContent = error.message;
      status.className = "status error";
    } finally {
      if (pendingMessageState?.node === pendingMessageNode) {
        removePendingMessage(pendingMessageNode);
        pendingMessageState = null;
      }
      input.disabled = false;
      if (sendButton) {
        sendButton.disabled = false;
      }
      input.focus();
      isSendingMessage = false;
      updateScrollDownButton(messagesNode, scrollDownButton);
    }
  });
});
