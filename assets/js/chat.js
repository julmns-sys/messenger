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
    <button type="button" data-action="select">Выбрать</button>
    <button type="button" data-action="edit">Редактировать</button>
    <button type="button" data-action="delete-me">Удалить у меня</button>
    <button type="button" data-action="delete-all" class="danger">Удалить у всех</button>
  `;
  document.body.appendChild(menu);
  return menu;
}

function buildSelectionToolbar() {
  const toolbar = document.createElement("div");
  toolbar.className = "selection-toolbar";
  toolbar.hidden = true;
  toolbar.innerHTML = `
    <div class="selection-toolbar-copy">
      <span class="selection-toolbar-count">0 сообщений</span>
    </div>
    <div class="selection-toolbar-actions">
      <button type="button" class="selection-toolbar-button" data-action="cancel">Отмена</button>
      <button type="button" class="selection-toolbar-button" data-action="delete-me">Удалить у меня</button>
      <button type="button" class="selection-toolbar-button danger" data-action="delete-all">Удалить у всех</button>
    </div>
  `;
  return toolbar;
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

function fillThreadInfoPanel(info, chatType) {
  const avatarNode = document.getElementById("threadInfoAvatar");
  const nameNode = document.getElementById("threadInfoName");
  const handleNode = document.getElementById("threadInfoHandle");
  const descriptionFactNode = document.getElementById("threadInfoDescriptionFact");
  const descriptionLabelNode = document.getElementById("threadInfoDescriptionLabel");
  const descriptionNode = document.getElementById("threadInfoDescription");
  const typeNode = document.getElementById("threadInfoType");
  const menuTriggerNode = document.getElementById("threadInfoMenuTrigger");
  const membersWrapNode = document.getElementById("threadInfoMembersWrap");
  const membersListNode = document.getElementById("threadInfoMembersList");
  const memberAddTriggerNode = document.getElementById("threadMemberAddTrigger");

  if (!avatarNode || !nameNode || !handleNode || !descriptionNode || !typeNode) {
    return;
  }

  const title = info?.title || info?.name || info?.username || "Чат";
  avatarNode.textContent = initials(title);
  avatarNode.classList.toggle("group-avatar", chatType === "group");
  nameNode.textContent = title;
  handleNode.textContent = chatType === "group"
    ? `${info?.members_count || 0} участников`
    : info?.username ? `@${info.username}` : "Личный чат";
  typeNode.textContent = chatType === "group" ? "Группа" : "Личный чат";

  if (descriptionFactNode && descriptionLabelNode) {
    if (chatType === "group") {
      descriptionFactNode.hidden = false;
      descriptionLabelNode.textContent = "Описание";
      descriptionNode.textContent = info?.description || "Описание группы пока не добавлено";
    } else {
      const hasBio = Boolean(info?.bio && String(info.bio).trim());
      descriptionFactNode.hidden = !hasBio;
      descriptionLabelNode.textContent = "Bio";
      descriptionNode.textContent = hasBio ? info.bio : "";
    }
  }

  if (membersWrapNode && membersListNode) {
    if (chatType === "group") {
      const members = Array.isArray(info?.members) ? info.members : [];
      const canEditGroup = Boolean(info?.can_edit_group);
      const canManageAdmins = Boolean(info?.can_manage_admins);
      membersWrapNode.hidden = false;
      if (menuTriggerNode) {
        menuTriggerNode.hidden = !canEditGroup;
      }
      if (memberAddTriggerNode) {
        memberAddTriggerNode.hidden = !canManageAdmins;
      }
      membersListNode.innerHTML = members.length
        ? members.map((member) => `
          <article
            class="member-item"
            data-member-id="${escapeHtml(String(member.id))}"
            data-member-name="${escapeHtml(member.name || member.username || "User")}"
            data-member-username="${escapeHtml(member.username || "")}"
            data-member-is-admin="${member.is_admin ? "true" : "false"}"
            data-member-is-owner="${member.is_owner ? "true" : "false"}"
          >
            <div class="avatar small">${escapeHtml(initials(member.name || member.username || "U"))}</div>
            <div class="result-meta">
              <div class="result-topline">
                <h3 class="result-name">${escapeHtml(member.name || member.username || "User")}</h3>
                ${member.is_owner ? '<span class="thread-member-role owner">Создатель</span>' : member.is_admin ? '<span class="thread-member-role">Админ</span>' : ""}
              </div>
              <p class="result-username">@${escapeHtml(member.username || "")}</p>
            </div>
            ${canManageAdmins && !member.is_owner ? '<button type="button" class="thread-member-menu-hint" data-member-menu-trigger="true" aria-label="Действия с участником">⋯</button>' : ""}
          </article>
        `).join("")
        : '<div class="empty-state">Участников пока нет</div>';
    } else {
      membersWrapNode.hidden = true;
      if (menuTriggerNode) {
        menuTriggerNode.hidden = true;
      }
      if (memberAddTriggerNode) {
        memberAddTriggerNode.hidden = true;
      }
      membersListNode.innerHTML = "";
    }
  }
}

function renderThreadMemberCandidateResults(results, selectedIds = new Set()) {
  const resultsNode = document.getElementById("threadMemberSearchResults");
  if (!resultsNode) {
    return;
  }

  if (!results.length) {
    resultsNode.innerHTML = '<div class="empty-state">Подходящих пользователей не найдено</div>';
    return;
  }

  resultsNode.innerHTML = results.map((user) => {
    const userId = String(user.id);
    const isSelected = selectedIds.has(userId);
    return `
      <article class="thread-member-option${isSelected ? " selected" : ""}" data-candidate-user-id="${escapeHtml(userId)}">
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

function buildThreadMemberActionMenu() {
  const menu = document.createElement("div");
  menu.className = "thread-member-action-menu";
  menu.hidden = true;
  document.body.appendChild(menu);
  return menu;
}

function syncGroupChatTitleInState(chatId, nextTitle) {
  if (!Array.isArray(chatState.allChats)) {
    return;
  }
  const currentChat = chatState.allChats.find((chat) => String(chat.id) === String(chatId) && (chat.type || "direct") === "group");
  if (currentChat) {
    currentChat.title = nextTitle;
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  requireAuth();
  bindLogout();
  fillUserBadge();
  initSidebarProfile();
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
  const contentNode = document.querySelector(".content");
  const status = document.getElementById("messageStatus");
  const input = document.getElementById("messageInput");
  const scrollDownButton = document.getElementById("scrollDownButton");
  const titleNode = document.getElementById("chatTitle");
  const subtitleNode = document.getElementById("chatSubtitle");
  const headerAvatarNode = document.getElementById("chatAvatar");
  const threadInfoCloseButton = document.getElementById("threadInfoClose");
  const threadInfoMenuTrigger = document.getElementById("threadInfoMenuTrigger");
  const threadInfoActionMenu = document.getElementById("threadInfoActionMenu");
  const threadInfoMembersListNode = document.getElementById("threadInfoMembersList");
  const threadMemberAddTrigger = document.getElementById("threadMemberAddTrigger");
  const threadMemberAddModal = document.getElementById("threadMemberAddModal");
  const threadMemberAddClose = document.getElementById("threadMemberAddClose");
  const threadMemberAddInput = document.getElementById("threadMemberAddInput");
  const threadMemberAddStatus = document.getElementById("threadMemberAddStatus");
  const threadMemberSearchResults = document.getElementById("threadMemberSearchResults");
  const threadMemberAddSubmit = document.getElementById("threadMemberAddSubmit");
  const threadGroupEditModal = document.getElementById("threadGroupEditModal");
  const threadGroupEditForm = document.getElementById("threadGroupEditForm");
  const threadGroupEditTitleInput = document.getElementById("threadGroupEditTitleInput");
  const threadGroupEditDescriptionInput = document.getElementById("threadGroupEditDescriptionInput");
  const threadGroupEditStatus = document.getElementById("threadGroupEditStatus");
  const threadGroupEditSubmit = document.getElementById("threadGroupEditSubmit");
  const composerWrap = composer?.closest(".composer-wrap");
  const sendButton = composer?.querySelector('button[type="submit"]');
  const messageActionMenu = buildMessageActionMenu();
  const editBanner = buildEditBanner();
  const deleteUndoToast = buildDeleteUndoToast();
  const selectionToolbar = buildSelectionToolbar();
  const threadMemberActionMenu = buildThreadMemberActionMenu();
  let socket = null;
  let selectedUser = null;
  let currentThreadInfo = null;
  let pendingMessageState = null;
  let isSendingMessage = false;
  let isMarkingRead = false;
  let activeMessageMenuTarget = null;
  let hideMessageMenuTimer = null;
  let editingMessageState = null;
  let touchMenuPressTimer = null;
  let touchMenuTarget = null;
  let touchMenuPoint = null;
  let threadMemberTouchTimer = null;
  let activeThreadMemberItem = null;
  let threadMemberContacts = [];
  let filteredThreadMemberCandidates = [];
  let isSubmittingThreadMembers = false;
  let isSavingGroupDetails = false;
  let oldestMessageId = null;
  let hasMoreMessages = false;
  let isLoadingOlder = false;
  let pendingDeleteState = null;
  let deleteUndoCountdownTimer = null;
  let isSelectionMode = false;
  const selectedMessageIds = new Set();
  const committedDeleteEchoIds = new Set();

  if (!messagesNode || !composer || !input || !contentBody || !composerWrap || !contentNode) {
    return;
  }

  composer.parentNode.insertBefore(editBanner, composer);
  contentBody.insertBefore(selectionToolbar, composerWrap);
  contentBody.appendChild(deleteUndoToast);

  function setThreadInfoOpen(isOpen) {
    contentNode.classList.toggle("thread-info-open", Boolean(isOpen));
    const panel = document.getElementById("threadInfoPanel");
    if (panel) {
      panel.setAttribute("aria-hidden", isOpen ? "false" : "true");
    }
  }

  function closeThreadInfoActionMenu() {
    if (!threadInfoActionMenu || !threadInfoMenuTrigger) {
      return;
    }
    threadInfoMenuTrigger.setAttribute("aria-expanded", "false");
    threadInfoActionMenu.classList.remove("visible");
    window.setTimeout(() => {
      if (!threadInfoActionMenu.classList.contains("visible")) {
        threadInfoActionMenu.hidden = true;
      }
    }, 160);
  }

  function openThreadInfoActionMenu() {
    if (!threadInfoActionMenu || !threadInfoMenuTrigger) {
      return;
    }
    threadInfoActionMenu.hidden = false;
    threadInfoMenuTrigger.setAttribute("aria-expanded", "true");
    requestAnimationFrame(() => {
      threadInfoActionMenu.classList.add("visible");
    });
  }

  function setThreadGroupEditStatus(message, type = "") {
    if (!threadGroupEditStatus) {
      return;
    }
    threadGroupEditStatus.textContent = message;
    threadGroupEditStatus.className = `status thread-group-edit-status ${type}`.trim();
  }

  function closeThreadGroupEditModal() {
    if (!threadGroupEditModal || isSavingGroupDetails) {
      return;
    }
    threadGroupEditModal.hidden = true;
    setThreadGroupEditStatus("");
  }

  function openThreadGroupEditModal() {
    if (!threadGroupEditModal || chatType !== "group" || !currentThreadInfo?.can_edit_group) {
      return;
    }
    closeThreadInfoActionMenu();
    threadGroupEditModal.hidden = false;
    setThreadGroupEditStatus("");
    if (threadGroupEditTitleInput) {
      threadGroupEditTitleInput.value = currentThreadInfo?.title || currentThreadInfo?.name || "";
    }
    if (threadGroupEditDescriptionInput) {
      threadGroupEditDescriptionInput.value = currentThreadInfo?.description || "";
    }
    if (threadGroupEditSubmit) {
      threadGroupEditSubmit.disabled = false;
      threadGroupEditSubmit.textContent = "Сохранить";
    }
    threadGroupEditTitleInput?.focus();
  }

  async function loadSelectedUser() {
    if (chatId || chatType === "group" || !userId) {
      return null;
    }

    selectedUser = await apiFetch(`/users/${encodeURIComponent(userId)}`);
    currentThreadInfo = selectedUser;
    return selectedUser;
  }

  async function refreshCurrentThreadInfo() {
    if (!chatId) {
      return;
    }

    const path = chatType === "group" ? `/groups/${chatId}?limit=1` : `/chats/${chatId}?limit=1`;
    const data = await apiFetch(path);
    const currentChat = Array.isArray(chatState.allChats)
      ? chatState.allChats.find((chat) => String(chat.id) === String(chatId) && (chat.type || "direct") === chatType)
      : null;
    const title = currentChat?.title || data.title || data.name || data.username || "Чат";
    currentThreadInfo = {
      ...data,
      title
    };
    if (chatType === "group") {
      setChatTitle(title, `${data.members_count || data.members?.length || 0} участников`);
    }
    fillThreadInfoPanel(currentThreadInfo, chatType);
  }

  function hideThreadMemberActionMenu() {
    activeThreadMemberItem = null;
    threadMemberActionMenu.classList.remove("visible");
    window.setTimeout(() => {
      if (!threadMemberActionMenu.classList.contains("visible")) {
        threadMemberActionMenu.hidden = true;
      }
    }, 120);
  }

  function setThreadMemberAddStatus(message, type = "") {
    if (!threadMemberAddStatus) {
      return;
    }
    threadMemberAddStatus.textContent = message;
    threadMemberAddStatus.className = `status thread-member-add-status ${type}`.trim();
  }

  function getCurrentGroupMemberIds() {
    return new Set(
      Array.isArray(currentThreadInfo?.members)
        ? currentThreadInfo.members.map((member) => String(member.id))
        : []
    );
  }

  function getSelectedThreadMemberIds() {
    if (!threadMemberSearchResults) {
      return new Set();
    }
    return new Set(
      [...threadMemberSearchResults.querySelectorAll('.thread-member-option.selected[data-candidate-user-id]')]
        .map((node) => String(node.dataset.candidateUserId))
    );
  }

  function updateThreadMemberSubmitState() {
    if (!threadMemberAddSubmit) {
      return;
    }
    const selectedCount = getSelectedThreadMemberIds().size;
    threadMemberAddSubmit.hidden = selectedCount === 0;
    threadMemberAddSubmit.disabled = selectedCount === 0 || isSubmittingThreadMembers;
    threadMemberAddSubmit.textContent = selectedCount > 0 ? `Добавить (${selectedCount})` : "Добавить";
  }

  function filterThreadMemberCandidates(query = "", preserveSelection = true) {
    const normalizedQuery = query.trim().replace(/^@/, "").toLowerCase();
    const existingMemberIds = getCurrentGroupMemberIds();
    const selectedIds = preserveSelection ? getSelectedThreadMemberIds() : new Set();
    const baseCandidates = threadMemberContacts.filter((user) => !existingMemberIds.has(String(user.id)));
    filteredThreadMemberCandidates = normalizedQuery
      ? baseCandidates.filter((user) => {
        const username = String(user.username || "").toLowerCase();
        const name = String(user.name || "").toLowerCase();
        return username.includes(normalizedQuery) || name.includes(normalizedQuery);
      })
      : baseCandidates;
    renderThreadMemberCandidateResults(filteredThreadMemberCandidates, selectedIds);
    setThreadMemberAddStatus(
      filteredThreadMemberCandidates.length
        ? "Выберите одного или нескольких пользователей"
        : "Подходящих пользователей не найдено",
      filteredThreadMemberCandidates.length ? "" : "error"
    );
    updateThreadMemberSubmitState();
  }

  async function openThreadMemberAddModal() {
    if (!threadMemberAddModal || chatType !== "group" || !currentThreadInfo?.can_manage_admins) {
      return;
    }

    threadMemberAddModal.hidden = false;
    if (threadMemberAddInput) {
      threadMemberAddInput.value = "";
    }
    if (threadMemberSearchResults) {
      threadMemberSearchResults.innerHTML = "";
    }
    if (threadMemberAddSubmit) {
      threadMemberAddSubmit.hidden = true;
      threadMemberAddSubmit.disabled = true;
      threadMemberAddSubmit.textContent = "Добавить";
    }
    setThreadMemberAddStatus("Загрузка...", "");

    try {
      const data = await apiFetch("/contacts");
      threadMemberContacts = Array.isArray(data) ? data : data.items || [];
      filterThreadMemberCandidates("", false);
      threadMemberAddInput?.focus();
    } catch (error) {
      threadMemberContacts = [];
      filteredThreadMemberCandidates = [];
      setThreadMemberAddStatus(error.message, "error");
      updateThreadMemberSubmitState();
    }
  }

  function closeThreadMemberAddModal() {
    if (!threadMemberAddModal) {
      return;
    }
    threadMemberAddModal.hidden = true;
    threadMemberContacts = [];
    filteredThreadMemberCandidates = [];
    isSubmittingThreadMembers = false;
    if (threadMemberAddInput) {
      threadMemberAddInput.value = "";
    }
    if (threadMemberSearchResults) {
      threadMemberSearchResults.innerHTML = "";
    }
    setThreadMemberAddStatus("");
    updateThreadMemberSubmitState();
  }

  function showThreadMemberActionMenu(memberItem, clientX, clientY) {
    if (!memberItem || memberItem.dataset.memberIsOwner === "true") {
      return;
    }

    const isAdmin = memberItem.dataset.memberIsAdmin === "true";
    threadMemberActionMenu.innerHTML = `
      <button type="button" data-member-action="toggle-admin">${isAdmin ? "Снять админа" : "Сделать админом"}</button>
      <button type="button" data-member-action="remove-member" class="danger">Удалить из группы</button>
    `;
    activeThreadMemberItem = memberItem;
    threadMemberActionMenu.hidden = false;
    const menuWidth = 190;
    const menuHeight = 84;
    const left = Math.min(clientX, window.innerWidth - menuWidth - 12);
    const top = Math.min(clientY, window.innerHeight - menuHeight - 12);
    threadMemberActionMenu.style.left = `${Math.max(12, left)}px`;
    threadMemberActionMenu.style.top = `${Math.max(12, top)}px`;
    requestAnimationFrame(() => {
      threadMemberActionMenu.classList.add("visible");
    });
  }

  function renderPendingDirectChat(user) {
    const title = user?.name || user?.username || "Чат";
    const subtitle = user?.username ? `@${user.username}` : "";
    currentThreadInfo = user ? { ...user, title } : null;
    setChatTitle(title, subtitle);
    fillThreadInfoPanel(currentThreadInfo, chatType);
    renderMessages(messagesNode, [], currentUser.id, chatType);
    selectedMessageIds.clear();
    isSelectionMode = false;
    oldestMessageId = null;
    hasMoreMessages = false;
    document.body.classList.remove("selection-mode");
    selectionToolbar.hidden = true;
    updateScrollDownButton(messagesNode, scrollDownButton);
  }

  function formatSelectedMessagesCount(count) {
    const mod10 = count % 10;
    const mod100 = count % 100;
    if (mod10 === 1 && mod100 !== 11) {
      return `${count} сообщение`;
    }
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
      return `${count} сообщения`;
    }
    return `${count} сообщений`;
  }

  function formatDeleteToastTitle(scope, count = 1) {
    const noun = formatSelectedMessagesCount(count);
    if (scope === "all") {
      return count > 1 ? `${noun} будут удалены у всех` : "Сообщение будет удалено у всех";
    }

    return count > 1 ? `${noun} будут удалены` : "Сообщение будет удалено";
  }

  function syncMessageSelectionState(messageId) {
    const node = messagesNode.querySelector(`.message[data-message-id="${CSS.escape(String(messageId))}"]`);
    if (!node) {
      return;
    }

    node.classList.toggle("selected", selectedMessageIds.has(Number(messageId)));
  }

  function updateSelectionToolbar() {
    const count = selectedMessageIds.size;
    const countNode = selectionToolbar.querySelector(".selection-toolbar-count");
    const deleteAllButton = selectionToolbar.querySelector('[data-action="delete-all"]');
    const deleteMeButton = selectionToolbar.querySelector('[data-action="delete-me"]');
    const selectedNodes = [...selectedMessageIds].map((messageId) => (
      messagesNode.querySelector(`.message[data-message-id="${CSS.escape(String(messageId))}"]`)
    )).filter(Boolean);
    const allOwn = selectedNodes.length > 0 && selectedNodes.every((node) => node.dataset.own === "true");

    document.body.classList.toggle("selection-mode", isSelectionMode);
    selectionToolbar.hidden = !isSelectionMode;

    if (countNode) {
      countNode.textContent = formatSelectedMessagesCount(count);
    }

    if (deleteMeButton) {
      deleteMeButton.disabled = count === 0;
    }

    if (deleteAllButton) {
      deleteAllButton.disabled = count === 0 || !allOwn;
      deleteAllButton.hidden = !allOwn;
    }

    if (count === 0) {
      isSelectionMode = false;
      selectionToolbar.hidden = true;
      document.body.classList.remove("selection-mode");
    }
  }

  function clearSelectedMessages() {
    selectedMessageIds.forEach((messageId) => {
      const node = messagesNode.querySelector(`.message[data-message-id="${CSS.escape(String(messageId))}"]`);
      if (node) {
        node.classList.remove("selected");
      }
    });
    selectedMessageIds.clear();
    updateSelectionToolbar();
  }

  function exitSelectionMode() {
    clearSelectedMessages();
    isSelectionMode = false;
    selectionToolbar.hidden = true;
    document.body.classList.remove("selection-mode");
  }

  function toggleMessageSelection(messageNode) {
    const messageId = Number(messageNode?.dataset.messageId || "0");
    if (!messageId) {
      return;
    }

    isSelectionMode = true;
    if (selectedMessageIds.has(messageId)) {
      selectedMessageIds.delete(messageId);
    } else {
      selectedMessageIds.add(messageId);
    }

    syncMessageSelectionState(messageId);
    updateSelectionToolbar();
  }

  function enterSelectionMode(messageNode) {
    hideMessageMenu();
    if (editingMessageState) {
      setEditingMessageState(null);
      input.value = "";
    }
    if (!messageNode) {
      return;
    }
    if (!isSelectionMode) {
      isSelectionMode = true;
      selectionToolbar.hidden = false;
    }
    toggleMessageSelection(messageNode);
  }

  function collectSelectedMessageItems() {
    const selectedIds = new Set(selectedMessageIds);
    const messageNodes = [...messagesNode.querySelectorAll(".message[data-message-id]")];

    return messageNodes
      .map((node, index) => {
        const messageId = Number(node.dataset.messageId || "0");
        const nextAnchorNode = messageNodes.slice(index + 1).find((candidate) => {
          const candidateId = Number(candidate.dataset.messageId || "0");
          return candidateId && !selectedIds.has(candidateId);
        });
        const prevAnchorNode = [...messageNodes.slice(0, index)].reverse().find((candidate) => {
          const candidateId = Number(candidate.dataset.messageId || "0");
          return candidateId && !selectedIds.has(candidateId);
        });

        return {
          messageId,
          messageNode: node,
          nextSibling: node.nextElementSibling,
          anchorNextId: Number(nextAnchorNode?.dataset.messageId || "0") || null,
          anchorPrevId: Number(prevAnchorNode?.dataset.messageId || "0") || null,
          originalIndex: index
        };
      })
      .filter((item) => item.messageId && selectedIds.has(item.messageId));
  }

  function restoreRemovedMessages(container, items) {
    if (!Array.isArray(items) || !items.length) {
      return;
    }

    const emptyState = container.querySelector(".empty-state");
    if (emptyState) {
      emptyState.remove();
    }

    [...items]
      .sort((left, right) => (left.originalIndex || 0) - (right.originalIndex || 0))
      .forEach((item) => {
      if (!item?.messageNode) {
        return;
      }

      item.messageNode.classList.remove("selected");
      renderedMessages.add(`id:${item.messageId}`);
      const nextAnchor = item.anchorNextId
        ? container.querySelector(`.message[data-message-id="${CSS.escape(String(item.anchorNextId))}"]`)
        : null;
      if (nextAnchor) {
        container.insertBefore(item.messageNode, nextAnchor);
        return;
      }

      const prevAnchor = item.anchorPrevId
        ? container.querySelector(`.message[data-message-id="${CSS.escape(String(item.anchorPrevId))}"]`)
        : null;
      if (prevAnchor?.parentNode === container) {
        prevAnchor.insertAdjacentElement("afterend", item.messageNode);
        return;
      }

      if (item.nextSibling && item.nextSibling.parentNode === container) {
        container.insertBefore(item.messageNode, item.nextSibling);
        return;
      }

      container.appendChild(item.messageNode);
    });
  }

  function queuePendingDelete(state) {
    if (pendingDeleteState) {
      void flushPendingDelete("commit");
    }

    pendingDeleteState = {
      ...state,
      timerId: window.setTimeout(() => {
        void flushPendingDelete("commit");
      }, 3000)
    };

    showDeleteUndoToast(state.scope, state.removedItems.length);
    updateScrollDownButton(messagesNode, scrollDownButton);
  }

  function queueBulkDelete(scope, messageItems) {
    if (!chatId || !messageItems.length) {
      return false;
    }

    const messageIds = messageItems.map((item) => item.messageId);
    const path = chatType === "group"
      ? `/groups/${chatId}/messages/bulk-delete`
      : `/chats/${chatId}/messages/bulk-delete`;

    let removedCount = 0;
    messageItems.forEach((item) => {
      item.messageNode.classList.remove("selected");
      if (removeMessageNode(messagesNode, item.messageId)) {
        removedCount += 1;
      }
    });

    if (!removedCount) {
      return false;
    }

    queuePendingDelete({
      scope,
      removedItems: messageItems,
      request: {
        path,
        options: {
          method: "POST",
          body: JSON.stringify({
            message_ids: messageIds,
            scope
          })
        }
      }
    });

    return true;
  }

  async function deleteSelectedMessages(scope) {
    if (!chatId || !selectedMessageIds.size) {
      return;
    }

    const messageItems = collectSelectedMessageItems();
    const actionButtons = selectionToolbar.querySelectorAll("button");

    if (pendingDeleteState) {
      await flushPendingDelete("commit");
    }

    actionButtons.forEach((button) => {
      button.disabled = true;
    });
    status.textContent = "";
    status.className = "status thread-status";

    try {
      if (!queueBulkDelete(scope, messageItems)) {
        return;
      }
      exitSelectionMode();
    } catch (error) {
      status.textContent = error.message;
      status.className = "status error";
      updateSelectionToolbar();
    } finally {
      actionButtons.forEach((button) => {
        button.disabled = false;
      });
      updateScrollDownButton(messagesNode, scrollDownButton);
    }
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

  function showDeleteUndoToast(scope, count = 1) {
    const titleNode = deleteUndoToast.querySelector(".delete-undo-title");
    const timerNode = deleteUndoToast.querySelector(".delete-undo-timer");
    if (titleNode) {
      titleNode.textContent = formatDeleteToastTitle(scope, count);
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
      restoreRemovedMessages(messagesNode, state.removedItems);
      hideDeleteUndoToast();
      updateScrollDownButton(messagesNode, scrollDownButton);
      return;
    }

    hideDeleteUndoToast();
    try {
      await apiFetch(state.request.path, state.request.options);
      state.removedItems.forEach((item) => {
        committedDeleteEchoIds.add(item.messageId);
      });
      await loadChats("chatList", { showLoading: false });
      if (chatType === "direct") {
        await markCurrentDirectChatAsRead();
      }
    } catch (error) {
      restoreRemovedMessages(messagesNode, state.removedItems);
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

    if (isSelectionMode) {
      exitSelectionMode();
    }

    const messageNode = messagesNode.querySelector(`.message[data-message-id="${CSS.escape(String(messageId))}"]`);
    if (!messageNode) {
      return;
    }

    const removedItem = {
      messageId: Number(messageId),
      messageNode,
      nextSibling: messageNode.nextElementSibling,
      anchorNextId: Number(messageNode.nextElementSibling?.dataset?.messageId || "0") || null,
      anchorPrevId: Number(messageNode.previousElementSibling?.dataset?.messageId || "0") || null,
      originalIndex: [...messagesNode.querySelectorAll(".message[data-message-id]")].findIndex((node) => node === messageNode)
    };
    messageNode.classList.remove("selected");
    const removed = removeMessageNode(messagesNode, Number(messageId));
    if (!removed) {
      return;
    }

    queuePendingDelete({
      scope,
      removedItems: [removedItem],
      request: {
        path: `${basePath}?scope=${scope}`,
        options: { method: "DELETE" }
      }
    });
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
    const menuHeight = isOwnMessage ? 164 : 84;
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

    currentThreadInfo = {
      ...data,
      title
    };
    setChatTitle(title, subtitle);
    fillThreadInfoPanel(currentThreadInfo, chatType);
    const nextMessages = data.messages || [];
    exitSelectionMode();
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

        syncMessageSelectionState(message.id);

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
        } else {
          syncMessageSelectionState(data.message.id);
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

        const messageId = Number(data?.message_id || 0);
        if (committedDeleteEchoIds.has(messageId)) {
          committedDeleteEchoIds.delete(messageId);
          return;
        }

        const removed = removeMessageNode(messagesNode, messageId);
        selectedMessageIds.delete(messageId);
        updateSelectionToolbar();
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

      socket.on("chat_deleted", (data) => {
        if (chatType !== "direct" || String(data?.chat_id) !== String(chatId)) {
          return;
        }

        window.location.href = "index.html";
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

  function openThreadInfoPanel() {
    if (!currentThreadInfo) {
      return;
    }
    closeThreadInfoActionMenu();
    closeThreadMemberAddModal();
    fillThreadInfoPanel(currentThreadInfo, chatType);
    setThreadInfoOpen(true);
  }

  titleNode?.addEventListener("click", openThreadInfoPanel);
  subtitleNode?.addEventListener("click", openThreadInfoPanel);
  headerAvatarNode?.addEventListener("click", openThreadInfoPanel);
  threadInfoMenuTrigger?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (threadInfoActionMenu?.hidden) {
      openThreadInfoActionMenu();
      return;
    }
    closeThreadInfoActionMenu();
  });
  threadInfoCloseButton?.addEventListener("click", () => {
    closeThreadInfoActionMenu();
    closeThreadMemberAddModal();
    closeThreadGroupEditModal();
    setThreadInfoOpen(false);
  });

  threadInfoActionMenu?.addEventListener("click", (event) => {
    const action = event.target.closest("button")?.dataset.threadInfoAction;
    if (action === "edit-group") {
      openThreadGroupEditModal();
    }
  });

  threadInfoMembersListNode?.addEventListener("contextmenu", (event) => {
    const memberItem = event.target.closest(".member-item[data-member-id]");
    if (!memberItem || chatType !== "group" || !currentThreadInfo?.can_manage_admins) {
      return;
    }

    event.preventDefault();
    showThreadMemberActionMenu(memberItem, event.clientX, event.clientY);
  });

  threadInfoMembersListNode?.addEventListener("click", (event) => {
    const trigger = event.target.closest("[data-member-menu-trigger]");
    if (!trigger || chatType !== "group" || !currentThreadInfo?.can_manage_admins) {
      return;
    }

    const memberItem = trigger.closest(".member-item[data-member-id]");
    if (!memberItem) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    const rect = trigger.getBoundingClientRect();
    showThreadMemberActionMenu(memberItem, rect.right, rect.bottom + 6);
  });

  threadInfoMembersListNode?.addEventListener("touchstart", (event) => {
    const touch = event.touches[0];
    const memberItem = event.target.closest(".member-item[data-member-id]");
    if (!touch || !memberItem || chatType !== "group" || !currentThreadInfo?.can_manage_admins) {
      return;
    }

    if (threadMemberTouchTimer) {
      window.clearTimeout(threadMemberTouchTimer);
    }

    activeThreadMemberItem = memberItem;
    threadMemberTouchTimer = window.setTimeout(() => {
      showThreadMemberActionMenu(memberItem, touch.clientX, touch.clientY);
      threadMemberTouchTimer = null;
    }, 520);
  }, { passive: true });

  threadInfoMembersListNode?.addEventListener("touchend", () => {
    if (threadMemberTouchTimer) {
      window.clearTimeout(threadMemberTouchTimer);
      threadMemberTouchTimer = null;
    }
  }, { passive: true });

  threadInfoMembersListNode?.addEventListener("touchcancel", () => {
    if (threadMemberTouchTimer) {
      window.clearTimeout(threadMemberTouchTimer);
      threadMemberTouchTimer = null;
    }
  }, { passive: true });

  threadMemberAddTrigger?.addEventListener("click", () => {
    void openThreadMemberAddModal();
  });

  threadMemberAddClose?.addEventListener("click", () => {
    closeThreadMemberAddModal();
  });

  threadMemberAddModal?.addEventListener("click", (event) => {
    if (event.target === threadMemberAddModal) {
      closeThreadMemberAddModal();
    }
  });

  threadGroupEditModal?.addEventListener("click", (event) => {
    if (event.target.closest("[data-group-edit-close=\"true\"]")) {
      closeThreadGroupEditModal();
    }
  });

  threadMemberAddInput?.addEventListener("input", () => {
    filterThreadMemberCandidates(threadMemberAddInput.value);
  });

  threadMemberSearchResults?.addEventListener("click", (event) => {
    const option = event.target.closest(".thread-member-option[data-candidate-user-id]");
    if (!option) {
      return;
    }
    option.classList.toggle("selected");
    const checkbox = option.querySelector(".thread-member-option-check");
    if (checkbox) {
      checkbox.checked = option.classList.contains("selected");
    }
    updateThreadMemberSubmitState();
  });

  threadMemberAddSubmit?.addEventListener("click", async () => {
    if (!chatId || chatType !== "group" || isSubmittingThreadMembers) {
      return;
    }

    const memberIds = [...getSelectedThreadMemberIds()];
    if (!memberIds.length) {
      updateThreadMemberSubmitState();
      return;
    }

    isSubmittingThreadMembers = true;
    updateThreadMemberSubmitState();
    setThreadMemberAddStatus("Добавление...", "");

    try {
      await apiFetch(`/groups/${encodeURIComponent(chatId)}/members`, {
        method: "POST",
        body: JSON.stringify({ member_ids: memberIds })
      });
      await refreshCurrentThreadInfo();
      closeThreadMemberAddModal();
    } catch (error) {
      isSubmittingThreadMembers = false;
      setThreadMemberAddStatus(error.message, "error");
      updateThreadMemberSubmitState();
    }
  });

  threadGroupEditForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!chatId || chatType !== "group" || isSavingGroupDetails) {
      return;
    }

    const nextTitle = threadGroupEditTitleInput?.value.trim() || "";
    const nextDescription = threadGroupEditDescriptionInput?.value.trim() || "";

    if (!nextTitle) {
      setThreadGroupEditStatus("Название группы обязательно", "error");
      threadGroupEditTitleInput?.focus();
      return;
    }

    isSavingGroupDetails = true;
    if (threadGroupEditSubmit) {
      threadGroupEditSubmit.disabled = true;
      threadGroupEditSubmit.textContent = "Сохранение...";
    }
    setThreadGroupEditStatus("Сохраняем...", "");

    try {
      const data = await apiFetch(`/groups/${encodeURIComponent(chatId)}`, {
        method: "PATCH",
        body: JSON.stringify({
          title: nextTitle,
          description: nextDescription
        })
      });

      syncGroupChatTitleInState(chatId, data.title || nextTitle);
      currentThreadInfo = {
        ...currentThreadInfo,
        ...data,
        title: data.title || nextTitle,
        description: typeof data.description === "string" ? data.description : nextDescription
      };
      setChatTitle(currentThreadInfo.title, `${currentThreadInfo.members_count || currentThreadInfo.members?.length || 0} участников`);
      fillThreadInfoPanel(currentThreadInfo, chatType);
      await loadChats("chatList", { showLoading: false });
      isSavingGroupDetails = false;
      closeThreadGroupEditModal();
    } catch (error) {
      setThreadGroupEditStatus(error.message, "error");
    } finally {
      isSavingGroupDetails = false;
      if (threadGroupEditSubmit) {
        threadGroupEditSubmit.disabled = false;
        threadGroupEditSubmit.textContent = "Сохранить";
      }
    }
  });

  threadMemberActionMenu.addEventListener("click", async (event) => {
    const action = event.target.closest("button")?.dataset.memberAction;
    const memberItem = activeThreadMemberItem;
    hideThreadMemberActionMenu();
    if (!action || !memberItem || !chatId) {
      return;
    }

    const memberUserId = memberItem.dataset.memberId;
    if (!memberUserId) {
      return;
    }

    try {
      if (action === "toggle-admin") {
        const nextAdminState = memberItem.dataset.memberIsAdmin !== "true";
        await apiFetch(`/groups/${encodeURIComponent(chatId)}/members/${encodeURIComponent(memberUserId)}`, {
          method: "PATCH",
          body: JSON.stringify({ is_admin: nextAdminState })
        });
      }

      if (action === "remove-member") {
        await apiFetch(`/groups/${encodeURIComponent(chatId)}/members/${encodeURIComponent(memberUserId)}`, {
          method: "DELETE"
        });
      }

      await refreshCurrentThreadInfo();
    } catch (error) {
      window.alert(error.message);
    }
  });

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
    if (isSelectionMode) {
      toggleMessageSelection(messageNode);
      return;
    }
    showMessageMenu(messageNode, event.clientX, event.clientY);
  });

  messagesNode.addEventListener("click", (event) => {
    const messageNode = event.target.closest(".message[data-message-id]");
    if (!isSelectionMode || !messageNode || messageNode.classList.contains("pending")) {
      return;
    }

    event.preventDefault();
    toggleMessageSelection(messageNode);
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
      if (action === "select") {
        enterSelectionMode(targetNode);
        return;
      } else if (action === "edit") {
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
    if (!event.target.closest(".thread-member-action-menu") && !event.target.closest("[data-member-menu-trigger]")) {
      hideThreadMemberActionMenu();
    }
  });

  document.addEventListener("mousedown", (event) => {
    if (!event.target.closest(".message-action-menu") && !event.target.closest(".message[data-message-id]")) {
      hideMessageMenu();
    }
    if (!event.target.closest(".thread-member-action-menu") && !event.target.closest(".member-item[data-member-id]")) {
      hideThreadMemberActionMenu();
    }
  });

  document.addEventListener("touchstart", (event) => {
    if (!event.target.closest(".message-action-menu") && !event.target.closest(".message[data-message-id]")) {
      hideMessageMenu();
    }
    if (!event.target.closest(".thread-member-action-menu") && !event.target.closest(".member-item[data-member-id]")) {
      hideThreadMemberActionMenu();
    }
  }, { passive: true });

  document.addEventListener("contextmenu", (event) => {
    if (!event.target.closest(".message-action-menu") && !event.target.closest(".message[data-message-id]")) {
      hideMessageMenu();
    }
    if (!event.target.closest(".thread-member-action-menu") && !event.target.closest(".member-item[data-member-id]")) {
      hideThreadMemberActionMenu();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (!threadMemberAddModal?.hidden) {
        closeThreadMemberAddModal();
        return;
      }
      if (isSelectionMode) {
        exitSelectionMode();
      }
      if (editingMessageState) {
        setEditingMessageState(null);
        input.value = "";
      }
      hideMessageMenu();
      hideThreadMemberActionMenu();
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

  selectionToolbar.addEventListener("click", (event) => {
    const action = event.target.closest("button")?.dataset.action;
    if (!action) {
      return;
    }

    if (action === "cancel") {
      exitSelectionMode();
      return;
    }

    if (action === "delete-me" || action === "delete-all") {
      void deleteSelectedMessages(action === "delete-all" ? "all" : "me");
    }
  });

  window.addEventListener("resize", () => {
    hideMessageMenu();
    hideThreadMemberActionMenu();
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
        syncMessageSelectionState(updatedMessage.id);
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
      syncMessageSelectionState(sentMessage.id);
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

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && threadInfoActionMenu && !threadInfoActionMenu.hidden) {
      closeThreadInfoActionMenu();
      return;
    }
    if (event.key === "Escape" && threadGroupEditModal && !threadGroupEditModal.hidden) {
      closeThreadGroupEditModal();
      return;
    }
    if (event.key === "Escape" && contentNode.classList.contains("thread-info-open")) {
      closeThreadInfoActionMenu();
      closeThreadMemberAddModal();
      closeThreadGroupEditModal();
      setThreadInfoOpen(false);
    }
  });

  document.addEventListener("click", (event) => {
    if (!threadInfoActionMenu || threadInfoActionMenu.hidden) {
      return;
    }
    if (event.target.closest("#threadInfoActionMenu") || event.target.closest("#threadInfoMenuTrigger")) {
      return;
    }
    closeThreadInfoActionMenu();
  });
});
