const renderedMessages = new Set();
const BOTTOM_THRESHOLD = 24;
const PAGE_SIZE = 30;
const TOP_LOAD_THRESHOLD = 80;

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

function renderEditedIndicator(message) {
  if (!message?.is_edited) {
    return "";
  }

  return '<span class="message-edited" title="Сообщение изменено">(изм.)</span>';
}

function renderMessageItem(message, currentUserId, chatType) {
  const own = String(message.sender_id) === String(currentUserId);
  return `
    <article class="message ${own ? "own" : ""}" ${message.id != null ? `data-message-id="${escapeHtml(String(message.id))}"` : ""} data-own="${own ? "true" : "false"}">
      ${!own && message.sender_name ? `<p class="message-author">${escapeHtml(message.sender_name)}</p>` : ""}
      <p class="message-text">${escapeHtml(message.text || "")}</p>
      <div class="message-meta">
        ${renderEditedIndicator(message)}
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

function prependMessages(container, messages, currentUserId, chatType) {
  if (!messages.length) {
    return 0;
  }

  if (container.querySelector(".empty-state")) {
    container.innerHTML = "";
  }

  const nextHtml = [];
  let insertedCount = 0;

  for (const message of messages) {
    const key = getMessageKey(message);
    if (renderedMessages.has(key)) {
      continue;
    }

    renderedMessages.add(key);
    nextHtml.push(renderMessageItem(message, currentUserId, chatType));
    insertedCount += 1;
  }

  if (!nextHtml.length) {
    return 0;
  }

  container.insertAdjacentHTML("afterbegin", nextHtml.join(""));
  return insertedCount;
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

function ensureEmptyState(container) {
  if (container.querySelector(".message") || container.querySelector(".empty-state")) {
    return;
  }

  container.innerHTML = '<div class="empty-state">Сообщений пока нет</div>';
}

function replaceMessageNode(container, message, currentUserId, chatType) {
  const messageNode = container.querySelector(`.message[data-message-id="${CSS.escape(String(message.id))}"]`);
  if (!messageNode) {
    return false;
  }

  messageNode.outerHTML = renderMessageItem(message, currentUserId, chatType);
  return true;
}

function removeMessageNode(container, messageId) {
  const messageNode = container.querySelector(`.message[data-message-id="${CSS.escape(String(messageId))}"]`);
  if (!messageNode) {
    return false;
  }

  renderedMessages.delete(`id:${messageId}`);
  messageNode.remove();
  ensureEmptyState(container);
  return true;
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

function buildMessageActionMenu() {
  const menu = document.createElement("div");
  menu.className = "message-action-menu";
  menu.hidden = true;
  menu.innerHTML = `
    <button type="button" data-action="edit">Редактировать</button>
    <button type="button" data-action="delete-me">Удалить у меня</button>
    <button type="button" data-action="delete-all" class="danger">Удалить у всех</button>
  `;
  document.body.appendChild(menu);
  return menu;
}

function buildEditBanner() {
  const banner = document.createElement("div");
  banner.className = "composer-edit-banner";
  banner.hidden = true;
  banner.innerHTML = `
    <div class="composer-edit-copy">
      <span class="composer-edit-title">Редактирование сообщения</span>
    </div>
    <button type="button" class="composer-edit-cancel">Отмена</button>
  `;
  return banner;
}

function buildDeleteUndoToast() {
  const toast = document.createElement("div");
  toast.className = "delete-undo-toast";
  toast.hidden = true;
  toast.innerHTML = `
    <span class="delete-undo-progress" aria-hidden="true">
      <svg viewBox="0 0 20 20" class="delete-undo-ring">
        <circle class="delete-undo-ring-track" cx="10" cy="10" r="8"></circle>
        <circle class="delete-undo-ring-bar" cx="10" cy="10" r="8"></circle>
      </svg>
    </span>
    <span class="delete-undo-timer" aria-live="polite">3</span>
    <div class="delete-undo-copy">
      <span class="delete-undo-title">Сообщение будет удалено</span>
    </div>
    <button type="button" class="delete-undo-button">Отмена</button>
  `;
  return toast;
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
  const contentBody = document.querySelector(".content-body");
  const status = document.getElementById("messageStatus");
  const input = document.getElementById("messageInput");
  const scrollDownButton = document.getElementById("scrollDownButton");
  const sendButton = composer.querySelector('button[type="submit"]');
  const messageActionMenu = buildMessageActionMenu();
  const editBanner = buildEditBanner();
  const deleteUndoToast = buildDeleteUndoToast();
  let socket = null;
  let selectedUser = null;
  let pendingMessageState = null;
  let isSendingMessage = false;
  let isMarkingRead = false;
  let activeMessageMenuTarget = null;
  let hideMessageMenuTimer = null;
  let editingMessageState = null;
  let touchMenuPressTimer = null;
  let touchMenuTarget = null;
  let touchMenuPoint = null;
  let oldestMessageId = null;
  let hasMoreMessages = false;
  let isLoadingOlder = false;
  let pendingDeleteState = null;
  let deleteUndoCountdownTimer = null;

  if (!messagesNode || !composer || !input || !contentBody) {
    return;
  }

  composer.parentNode.insertBefore(editBanner, composer);
  contentBody.appendChild(deleteUndoToast);

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
    oldestMessageId = null;
    hasMoreMessages = false;
    updateScrollDownButton(messagesNode, scrollDownButton);
  }

  function setEditingMessageState(nextState) {
    editingMessageState = nextState;
    composer.classList.toggle("is-editing", Boolean(nextState));
    editBanner.hidden = !nextState;

    if (nextState) {
      input.value = nextState.text;
      input.placeholder = "Редактирование сообщения";
      if (sendButton) {
        sendButton.textContent = "✓";
        sendButton.setAttribute("aria-label", "Сохранить");
      }
    } else {
      input.placeholder = chatType === "group" ? "Сообщение в группу..." : "Напишите сообщение...";
      if (sendButton) {
        sendButton.textContent = "➤";
        sendButton.setAttribute("aria-label", "Отправить");
      }
    }

    input.focus();
    const caretPos = input.value.length;
    input.setSelectionRange(caretPos, caretPos);
  }

  function hideDeleteUndoToast() {
    if (deleteUndoCountdownTimer) {
      window.clearInterval(deleteUndoCountdownTimer);
      deleteUndoCountdownTimer = null;
    }
    deleteUndoToast.classList.remove("visible");
    window.setTimeout(() => {
      if (!deleteUndoToast.classList.contains("visible")) {
        deleteUndoToast.hidden = true;
      }
    }, 180);
  }

  function showDeleteUndoToast(scope) {
    const titleNode = deleteUndoToast.querySelector(".delete-undo-title");
    const timerNode = deleteUndoToast.querySelector(".delete-undo-timer");
    if (titleNode) {
      titleNode.textContent = scope === "all"
        ? "Сообщение будет удалено у всех"
        : "Сообщение будет удалено";
    }

    let secondsLeft = 3;
    if (timerNode) {
      timerNode.textContent = String(secondsLeft);
    }
    if (deleteUndoCountdownTimer) {
      window.clearInterval(deleteUndoCountdownTimer);
    }
    deleteUndoCountdownTimer = window.setInterval(() => {
      secondsLeft -= 1;
      if (timerNode && secondsLeft > 0) {
        timerNode.textContent = String(secondsLeft);
      }
      if (secondsLeft <= 0 && deleteUndoCountdownTimer) {
        window.clearInterval(deleteUndoCountdownTimer);
        deleteUndoCountdownTimer = null;
      }
    }, 1000);

    deleteUndoToast.hidden = false;
    requestAnimationFrame(() => {
      const ringBar = deleteUndoToast.querySelector(".delete-undo-ring-bar");
      if (ringBar) {
        ringBar.classList.remove("running");
        void ringBar.getBoundingClientRect();
        ringBar.classList.add("running");
      }
      deleteUndoToast.classList.add("visible");
    });
  }

  function restoreRemovedMessage(container, state) {
    if (!state?.messageNode) {
      return;
    }

    const emptyState = container.querySelector(".empty-state");
    if (emptyState) {
      emptyState.remove();
    }

    renderedMessages.add(`id:${state.messageId}`);
    if (state.nextSibling && state.nextSibling.parentNode === container) {
      container.insertBefore(state.messageNode, state.nextSibling);
    } else {
      container.appendChild(state.messageNode);
    }
  }

  async function flushPendingDelete(reason = "commit") {
    if (!pendingDeleteState) {
      return;
    }

    const state = pendingDeleteState;
    pendingDeleteState = null;
    if (state.timerId) {
      window.clearTimeout(state.timerId);
    }

    if (reason === "undo") {
      restoreRemovedMessage(messagesNode, state);
      hideDeleteUndoToast();
      updateScrollDownButton(messagesNode, scrollDownButton);
      return;
    }

    hideDeleteUndoToast();
    try {
      await apiFetch(`${state.basePath}?scope=${state.scope}`, { method: "DELETE" });
      await loadChats("chatList", { showLoading: false });
      if (chatType === "direct") {
        await markCurrentDirectChatAsRead();
      }
    } catch (error) {
      restoreRemovedMessage(messagesNode, state);
      status.textContent = error.message;
      status.className = "status error";
    } finally {
      updateScrollDownButton(messagesNode, scrollDownButton);
    }
  }

  function queueDeleteMessage(basePath, scope, messageId) {
    if (pendingDeleteState) {
      void flushPendingDelete("commit");
    }

    const messageNode = messagesNode.querySelector(`.message[data-message-id="${CSS.escape(String(messageId))}"]`);
    if (!messageNode) {
      return;
    }

    const nextSibling = messageNode.nextElementSibling;
    const removed = removeMessageNode(messagesNode, Number(messageId));
    if (!removed) {
      return;
    }

    const timerId = window.setTimeout(() => {
      void flushPendingDelete("commit");
    }, 3000);

    pendingDeleteState = {
      basePath,
      scope,
      messageId: Number(messageId),
      messageNode,
      nextSibling,
      timerId
    };

    showDeleteUndoToast(scope);
    updateScrollDownButton(messagesNode, scrollDownButton);
  }

  function hideMessageMenu() {
    activeMessageMenuTarget = null;
    if (hideMessageMenuTimer) {
      window.clearTimeout(hideMessageMenuTimer);
      hideMessageMenuTimer = null;
    }

    if (messageActionMenu.hidden) {
      return;
    }

    messageActionMenu.classList.remove("visible");
    hideMessageMenuTimer = window.setTimeout(() => {
      messageActionMenu.hidden = true;
      hideMessageMenuTimer = null;
    }, 160);
  }

  function showMessageMenu(targetNode, clientX, clientY) {
    if (hideMessageMenuTimer) {
      window.clearTimeout(hideMessageMenuTimer);
      hideMessageMenuTimer = null;
    }

    activeMessageMenuTarget = targetNode;
    const isOwnMessage = targetNode.dataset.own === "true";

    messageActionMenu.querySelector('[data-action="edit"]').hidden = !isOwnMessage;
    messageActionMenu.querySelector('[data-action="delete-all"]').hidden = !isOwnMessage;
    messageActionMenu.hidden = false;

    const menuWidth = 180;
    const menuHeight = isOwnMessage ? 122 : 46;
    const left = Math.min(clientX, window.innerWidth - menuWidth - 12);
    const top = Math.min(clientY, window.innerHeight - menuHeight - 12);
    messageActionMenu.style.left = `${Math.max(12, left)}px`;
    messageActionMenu.style.top = `${Math.max(12, top)}px`;
    requestAnimationFrame(() => {
      messageActionMenu.classList.add("visible");
    });
  }

  async function reloadThreadPreservingViewport() {
    const shouldStickToBottom = isNearBottom(messagesNode);
    const distanceFromBottom = messagesNode.scrollHeight - messagesNode.scrollTop;
    await loadThread({ preserveScroll: !shouldStickToBottom, distanceFromBottom });

    if (shouldStickToBottom) {
      scrollMessagesToBottom(messagesNode);
    } else {
      messagesNode.scrollTop = Math.max(0, messagesNode.scrollHeight - distanceFromBottom);
    }
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

  async function fetchMessagesPage(beforeMessageId = null) {
    const basePath = chatType === "group"
      ? `/groups/${chatId}/messages`
      : `/chats/${chatId}/messages`;
    const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (beforeMessageId != null) {
      params.set("before", String(beforeMessageId));
    }
    return apiFetch(`${basePath}?${params.toString()}`);
  }

  function updatePaginationState(messages, nextHasMore) {
    hasMoreMessages = Boolean(nextHasMore);
    oldestMessageId = messages.length ? messages[0].id : null;
  }

  async function loadThread(options = {}) {
    const path = chatType === "group" ? `/groups/${chatId}` : `/chats/${chatId}`;
    const data = await apiFetch(`${path}?limit=${PAGE_SIZE}`);
    const currentChat = Array.isArray(chatState.allChats)
      ? chatState.allChats.find((chat) => String(chat.id) === String(chatId) && (chat.type || "direct") === chatType)
      : null;
    const title = currentChat?.title || data.title || data.name || data.username || "Чат";
    const subtitle = chatType === "group"
      ? `${(data.members_count || data.members?.length || 0)} участников`
      : data.username ? `@${data.username}` : "в сети";

    setChatTitle(title, subtitle);
    const nextMessages = data.messages || [];
    renderMessages(messagesNode, nextMessages, currentUser.id, chatType);
    updatePaginationState(nextMessages, data.has_more_messages);
    if (!options.preserveScroll) {
      scrollMessagesToBottom(messagesNode);
    }
    updateScrollDownButton(messagesNode, scrollDownButton);
  }

  async function loadOlderMessages() {
    if (!chatId || isLoadingOlder || !hasMoreMessages || !oldestMessageId) {
      return;
    }

    isLoadingOlder = true;
    const previousScrollHeight = messagesNode.scrollHeight;
    const previousScrollTop = messagesNode.scrollTop;

    try {
      const data = await fetchMessagesPage(oldestMessageId);
      const olderMessages = data.messages || [];
      const insertedCount = prependMessages(messagesNode, olderMessages, currentUser.id, chatType);

      if (insertedCount > 0) {
        oldestMessageId = olderMessages[0]?.id ?? oldestMessageId;
        const newScrollHeight = messagesNode.scrollHeight;
        messagesNode.scrollTop = previousScrollTop + (newScrollHeight - previousScrollHeight);
      }

      hasMoreMessages = Boolean(data.has_more_messages) && olderMessages.length > 0;
    } catch {
      // Ignore transient pagination errors and allow retry on next scroll.
    } finally {
      isLoadingOlder = false;
      updateScrollDownButton(messagesNode, scrollDownButton);
    }
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

      socket.on("message_updated", async (data) => {
        const roomMatches = chatType === "group"
          ? String(data?.group_id) === String(chatId)
          : String(data?.chat_id) === String(chatId);
        if (!roomMatches) {
          return;
        }

        const replaced = replaceMessageNode(messagesNode, data.message, currentUser.id, chatType);
        if (!replaced) {
          await reloadThreadPreservingViewport();
        }
        await loadChats("chatList", { showLoading: false });
      });

      socket.on("message_deleted", async (data) => {
        const roomMatches = chatType === "group"
          ? String(data?.group_id) === String(chatId)
          : String(data?.chat_id) === String(chatId);
        if (!roomMatches) {
          return;
        }

        const removed = removeMessageNode(messagesNode, Number(data?.message_id || 0));
        if (!removed) {
          await reloadThreadPreservingViewport();
        }
        await loadChats("chatList", { showLoading: false });
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
    hideMessageMenu();
    if (messagesNode.scrollTop <= TOP_LOAD_THRESHOLD) {
      loadOlderMessages();
    }
    updateScrollDownButton(messagesNode, scrollDownButton);
  });

  messagesNode.addEventListener("contextmenu", (event) => {
    const messageNode = event.target.closest(".message[data-message-id]");
    if (!messageNode || messageNode.classList.contains("pending")) {
      return;
    }

    event.preventDefault();
    showMessageMenu(messageNode, event.clientX, event.clientY);
  });

  messagesNode.addEventListener("touchstart", (event) => {
    const touch = event.touches[0];
    const messageNode = event.target.closest(".message[data-message-id]");
    if (!touch || !messageNode || messageNode.classList.contains("pending")) {
      touchMenuTarget = null;
      touchMenuPoint = null;
      return;
    }

    touchMenuTarget = messageNode;
    touchMenuPoint = { x: touch.clientX, y: touch.clientY };
    if (touchMenuPressTimer) {
      window.clearTimeout(touchMenuPressTimer);
    }

    touchMenuPressTimer = window.setTimeout(() => {
      if (!touchMenuTarget || !touchMenuPoint) {
        return;
      }

      showMessageMenu(touchMenuTarget, touchMenuPoint.x, touchMenuPoint.y);
      touchMenuPressTimer = null;
    }, 520);
  }, { passive: true });

  messagesNode.addEventListener("touchmove", (event) => {
    const touch = event.touches[0];
    if (!touchMenuPressTimer || !touch || !touchMenuPoint) {
      return;
    }

    const deltaX = Math.abs(touch.clientX - touchMenuPoint.x);
    const deltaY = Math.abs(touch.clientY - touchMenuPoint.y);
    if (deltaX > 10 || deltaY > 10) {
      window.clearTimeout(touchMenuPressTimer);
      touchMenuPressTimer = null;
      touchMenuTarget = null;
      touchMenuPoint = null;
    }
  }, { passive: true });

  messagesNode.addEventListener("touchend", () => {
    if (touchMenuPressTimer) {
      window.clearTimeout(touchMenuPressTimer);
      touchMenuPressTimer = null;
    }
    touchMenuTarget = null;
    touchMenuPoint = null;
  }, { passive: true });

  messagesNode.addEventListener("touchcancel", () => {
    if (touchMenuPressTimer) {
      window.clearTimeout(touchMenuPressTimer);
      touchMenuPressTimer = null;
    }
    touchMenuTarget = null;
    touchMenuPoint = null;
  }, { passive: true });

  messageActionMenu.addEventListener("click", async (event) => {
    const action = event.target.closest("button")?.dataset.action;
    const targetNode = activeMessageMenuTarget;
    const messageId = targetNode?.dataset.messageId;
    const isOwnMessage = targetNode?.dataset.own === "true";
    hideMessageMenu();

    if (!action || !messageId) {
      return;
    }

    const basePath = chatType === "group"
      ? `/groups/${chatId}/messages/${messageId}`
      : `/chats/${chatId}/messages/${messageId}`;

    try {
      if (action === "edit") {
        if (!isOwnMessage) return;
        const currentText = targetNode?.querySelector(".message-text")?.textContent || "";
        setEditingMessageState({
          messageId,
          text: currentText,
          basePath
        });
        return;
      } else if (action === "delete-me") {
        queueDeleteMessage(basePath, "me", messageId);
        return;
      } else if (action === "delete-all") {
        if (!isOwnMessage) return;
        queueDeleteMessage(basePath, "all", messageId);
        return;
      } else {
        return;
      }

      await loadChats("chatList", { showLoading: false });
      if (chatType === "direct") {
        await markCurrentDirectChatAsRead();
      }
    } catch (error) {
      status.textContent = error.message;
      status.className = "status error";
    }
  });

  document.addEventListener("click", (event) => {
    if (!event.target.closest(".message-action-menu")) {
      hideMessageMenu();
    }
  });

  document.addEventListener("mousedown", (event) => {
    if (!event.target.closest(".message-action-menu") && !event.target.closest(".message[data-message-id]")) {
      hideMessageMenu();
    }
  });

  document.addEventListener("touchstart", (event) => {
    if (!event.target.closest(".message-action-menu") && !event.target.closest(".message[data-message-id]")) {
      hideMessageMenu();
    }
  }, { passive: true });

  document.addEventListener("contextmenu", (event) => {
    if (!event.target.closest(".message-action-menu") && !event.target.closest(".message[data-message-id]")) {
      hideMessageMenu();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (editingMessageState) {
        setEditingMessageState(null);
        input.value = "";
      }
      hideMessageMenu();
    }
  });

  editBanner.querySelector(".composer-edit-cancel")?.addEventListener("click", () => {
    setEditingMessageState(null);
    input.value = "";
    status.textContent = "";
    status.className = "status thread-status";
  });

  deleteUndoToast.querySelector(".delete-undo-button")?.addEventListener("click", () => {
    void flushPendingDelete("undo");
  });

  window.addEventListener("resize", hideMessageMenu);

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

    if (editingMessageState) {
      if (text === editingMessageState.text.trim()) {
        setEditingMessageState(null);
        input.value = "";
        status.textContent = "";
        status.className = "status thread-status";
        return;
      }

      isSendingMessage = true;
      input.disabled = true;
      if (sendButton) {
        sendButton.disabled = true;
      }
      status.textContent = "";
      status.className = "status thread-status";

      try {
        const updatedMessage = await apiFetch(editingMessageState.basePath, {
          method: "PATCH",
          body: JSON.stringify({ text })
        });

        setEditingMessageState(null);
        input.value = "";
        replaceMessageNode(messagesNode, updatedMessage, currentUser.id, chatType);
        await loadChats("chatList", { showLoading: false });
        if (chatType === "direct") {
          await markCurrentDirectChatAsRead();
        }
      } catch (error) {
        status.textContent = error.message;
        status.className = "status error";
      } finally {
        input.disabled = false;
        if (sendButton) {
          sendButton.disabled = false;
        }
        input.focus();
        isSendingMessage = false;
      }
      return;
    }

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

  window.addEventListener("pagehide", () => {
    if (socket) {
      socket.disconnect();
      socket = null;
    }
  });

  window.addEventListener("beforeunload", () => {
    if (socket) {
      socket.disconnect();
      socket = null;
    }
  });
});
