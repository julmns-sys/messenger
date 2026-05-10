const chatState = {
  allChats: [],
  refreshIntervalId: null,
  refreshListId: null
};
const CHAT_LIST_SCROLL_KEY = "messenger:chat-list-scroll-top";
const CHAT_TAGS_KEY = "messenger:chat-tags";
let chatListActionMenu = null;
let activeChatListItem = null;
let chatListMenuHideTimer = null;
let chatListTouchTimer = null;
let chatListTouchTarget = null;
let chatDeleteUndoToast = null;
let chatTagEditorModal = null;
let pendingChatDeleteState = null;
let chatDeleteUndoCountdownTimer = null;
const pendingDeletedChatKeys = new Set();

function getChatStateKey(chatId, chatType = "direct") {
  return `${chatType}:${chatId}`;
}

function readChatTags() {
  const rawValue = window.localStorage.getItem(CHAT_TAGS_KEY);
  if (!rawValue) return {};
  try {
    const parsed = JSON.parse(rawValue);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveChatTags(tagMap) {
  window.localStorage.setItem(CHAT_TAGS_KEY, JSON.stringify(tagMap));
}

function normalizeChatTagColor(color) {
  const normalized = typeof color === "string" ? color.trim() : "";
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(normalized) ? normalized : "#3390ec";
}

function getChatTag(chatId, chatType = "direct") {
  const chatTags = readChatTags();
  const tag = chatTags[getChatStateKey(chatId, chatType)];
  if (!tag || typeof tag !== "object") {
    return null;
  }

  const label = typeof tag.label === "string" ? tag.label.trim() : "";
  if (!label) {
    return null;
  }

  return {
    label: label.slice(0, 16),
    color: normalizeChatTagColor(tag.color)
  };
}

function setChatTag(chatId, chatType, tag) {
  const chatKey = getChatStateKey(chatId, chatType);
  const chatTags = readChatTags();
  const label = typeof tag?.label === "string" ? tag.label.trim().slice(0, 16) : "";

  if (!label) {
    delete chatTags[chatKey];
    saveChatTags(chatTags);
    return;
  }

  chatTags[chatKey] = {
    label,
    color: normalizeChatTagColor(tag.color)
  };
  saveChatTags(chatTags);
}

function hexToRgb(color) {
  const normalized = normalizeChatTagColor(color).replace("#", "");
  const value = normalized.length === 3
    ? normalized.split("").map((part) => `${part}${part}`).join("")
    : normalized;
  return {
    r: Number.parseInt(value.slice(0, 2), 16),
    g: Number.parseInt(value.slice(2, 4), 16),
    b: Number.parseInt(value.slice(4, 6), 16)
  };
}

function getChatTagStyleVars(color) {
  const { r, g, b } = hexToRgb(color);
  const textR = Math.max(28, Math.round(r * 0.58));
  const textG = Math.max(28, Math.round(g * 0.58));
  const textB = Math.max(28, Math.round(b * 0.58));

  return {
    background: `rgba(${r}, ${g}, ${b}, 0.18)`,
    border: `rgba(${r}, ${g}, ${b}, 0.34)`,
    text: `rgb(${textR}, ${textG}, ${textB})`,
    solid: `rgb(${r}, ${g}, ${b})`
  };
}

function getChatTagMarkup(chatId, chatType) {
  const tag = getChatTag(chatId, chatType);
  if (!tag) {
    return "";
  }

  const styleVars = getChatTagStyleVars(tag.color);
  return `
    <span
      class="chat-kind-label chat-custom-label"
      style="--chat-tag-bg: ${styleVars.background}; --chat-tag-border: ${styleVars.border}; --chat-tag-text: ${styleVars.text}; --chat-tag-solid: ${styleVars.solid};"
    >${escapeHtml(tag.label)}</span>
  `;
}

function readChatListScroll() {
  const rawValue = window.sessionStorage.getItem(CHAT_LIST_SCROLL_KEY);
  const scrollTop = Number.parseInt(rawValue || "", 10);
  return Number.isFinite(scrollTop) ? Math.max(0, scrollTop) : 0;
}

function saveChatListScroll(list) {
  if (!list) return;
  window.sessionStorage.setItem(CHAT_LIST_SCROLL_KEY, String(Math.max(0, list.scrollTop || 0)));
}

function restoreChatListScroll(list, fallbackScrollTop = 0) {
  if (!list) return;
  const targetScrollTop = fallbackScrollTop > 0 ? fallbackScrollTop : readChatListScroll();
  requestAnimationFrame(() => {
    list.scrollTop = targetScrollTop;
  });
}

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

function getSidebarProfileFields() {
  return {
    name: document.getElementById("sidebarProfileNameField"),
    email: document.getElementById("sidebarProfileEmail"),
    username: document.getElementById("sidebarProfileHandle"),
    bio: document.getElementById("sidebarProfileBio"),
    id: document.getElementById("sidebarProfileId")
  };
}

function getSidebarProfileFieldValue(field, user) {
  if (!user) return "";

  switch (field) {
    case "name":
      return user.name || "Не указано";
    case "email":
      return user.email || "Не указана";
    case "username":
      return user.username ? `@${user.username}` : "Не указан";
    case "bio":
      return user.bio || "Не указана";
    case "id":
      return user.id ? String(user.id) : "-";
    default:
      return "";
  }
}

function fillSidebarProfile() {
  const user = getCurrentUser();
  const avatar = document.getElementById("sidebarProfileAvatar");
  const name = document.getElementById("sidebarProfileName");
  const username = document.getElementById("sidebarProfileUsername");
  const fields = getSidebarProfileFields();

  if (!user || !avatar || !name || !username || !fields.name || !fields.email || !fields.username || !fields.bio || !fields.id) {
    return;
  }

  const fullName = user.name || user.username || "Пользователь";
  const usernameValue = user.username ? `@${user.username}` : "Не указан";

  avatar.textContent = initials(fullName);
  name.textContent = fullName;
  username.textContent = usernameValue;
  fields.name.textContent = getSidebarProfileFieldValue("name", user);
  fields.username.textContent = getSidebarProfileFieldValue("username", user);
  fields.bio.textContent = getSidebarProfileFieldValue("bio", user);
  fields.bio.classList.toggle("multiline", Boolean(user.bio));
  fields.id.textContent = getSidebarProfileFieldValue("id", user);

  fields.email.textContent = getSidebarProfileFieldValue("email", user);
  fields.email.classList.toggle("is-blurred", Boolean(user.email));
  fields.email.setAttribute("aria-label", user.email ? "Показать email" : "Email не указан");
  fields.email.setAttribute("aria-pressed", "false");
}

function setSidebarProfileEditMode(sidebar, isActive) {
  if (!sidebar) return;
  const toggleButton = document.getElementById("sidebarProfileEditToggle");
  sidebar.classList.toggle("profile-edit-mode", Boolean(isActive));
  if (toggleButton) {
    toggleButton.textContent = isActive ? "Готово" : "Изменить";
    toggleButton.setAttribute("aria-pressed", isActive ? "true" : "false");
  }
  if (!isActive) {
    document.querySelectorAll(".sidebar-profile-fact").forEach(hideSidebarProfileEditor);
  }
}

async function syncSidebarProfile() {
  try {
    const user = await apiFetch("/users/me");
    setCurrentUser(user);
    fillUserBadge();
    fillSidebarProfile();
  } catch {
    // Keep local session data if profile sync fails.
  }
}

function getSidebarProfileEditConfig(field) {
  return {
    name: {
      label: "Имя",
      multiline: false,
      maxLength: 80,
      value: (user) => user?.name || ""
    },
    email: {
      label: "Email",
      multiline: false,
      maxLength: 255,
      value: (user) => user?.email || ""
    },
    username: {
      label: "Username",
      multiline: false,
      maxLength: 32,
      value: (user) => user?.username || ""
    },
    bio: {
      label: "Bio",
      multiline: true,
      maxLength: 50,
      value: (user) => user?.bio || ""
    }
  }[field];
}

function hideSidebarProfileEditor(factNode) {
  const editor = factNode?.querySelector(".sidebar-profile-editor");
  const line = factNode?.querySelector(".sidebar-profile-line");
  const status = factNode?.querySelector(".sidebar-profile-inline-status");

  if (editor) {
    editor.remove();
  }
  if (line) {
    line.classList.remove("editing");
    line.querySelectorAll("[data-profile-line-item]").forEach((node) => {
      node.hidden = false;
    });
  }
  if (status) {
    status.remove();
  }
}

function setSidebarProfileStatus(factNode, message, type = "") {
  if (!factNode) return;

  let status = factNode.querySelector(".sidebar-profile-inline-status");
  if (!message) {
    if (status) status.remove();
    return;
  }

  if (!status) {
    status = document.createElement("div");
    status.className = "sidebar-profile-inline-status";
    status.innerHTML = `
      <span class="sidebar-profile-inline-status-indicator" aria-hidden="true"></span>
      <span class="sidebar-profile-inline-status-text"></span>
    `;
    factNode.appendChild(status);
  }

  status.className = `sidebar-profile-inline-status ${type}`.trim();
  const textNode = status.querySelector(".sidebar-profile-inline-status-text");
  if (textNode) {
    textNode.textContent = message;
  }
}

async function saveSidebarProfileField(field, value) {
  const updatedUser = await apiFetch("/users/me", {
    method: "PATCH",
    body: JSON.stringify({ [field]: value })
  });

  setCurrentUser(updatedUser);
  fillUserBadge();
  fillSidebarProfile();
  return updatedUser;
}

function openSidebarProfileEditor(field) {
  const sidebar = document.querySelector(".sidebar");
  const button = document.querySelector(`[data-profile-edit="${field}"]`);
  const factNode = button?.closest(".sidebar-profile-fact");
  const line = factNode?.querySelector(".sidebar-profile-line");
  const config = getSidebarProfileEditConfig(field);
  const currentUser = getCurrentUser();

  if (!sidebar || !factNode || !line || !config) {
    return;
  }

  setSidebarProfileEditMode(sidebar, true);

  document.querySelectorAll(".sidebar-profile-fact").forEach((node) => {
    if (node !== factNode) {
      hideSidebarProfileEditor(node);
    }
  });

  hideSidebarProfileEditor(factNode);
  line.classList.add("editing");
  setSidebarProfileStatus(factNode, "");

  line.querySelectorAll("strong, button").forEach((node) => {
    if (!node.classList.contains("sidebar-profile-editor-button")) {
      node.dataset.profileLineItem = "true";
      node.hidden = true;
    }
  });

  const editor = document.createElement("form");
  editor.className = "sidebar-profile-editor";

  const input = document.createElement("input");

  input.className = "sidebar-profile-editor-input";
  input.type = field === "email" ? "email" : "text";
  if (config.maxLength) {
    input.maxLength = config.maxLength;
  }
  input.value = config.value(currentUser);
  input.placeholder = `Введите ${config.label.toLowerCase()}`;

  const actions = document.createElement("div");
  actions.className = "sidebar-profile-editor-actions";
  actions.innerHTML = `
    <button class="sidebar-profile-editor-button cancel" type="button">Отмена</button>
    <button class="sidebar-profile-editor-button save" type="submit">Сохранить</button>
  `;

  editor.appendChild(input);
  editor.appendChild(actions);
  line.appendChild(editor);
  input.focus();
  if (typeof input.setSelectionRange === "function") {
    input.setSelectionRange(input.value.length, input.value.length);
  }

  actions.querySelector(".cancel")?.addEventListener("click", () => {
    hideSidebarProfileEditor(factNode);
  });

  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      hideSidebarProfileEditor(factNode);
    }
  });

  editor.addEventListener("submit", async (event) => {
    event.preventDefault();
    const nextValue = input.value.trim();
    const saveButton = actions.querySelector(".save");
    if (saveButton) saveButton.disabled = true;
    setSidebarProfileStatus(factNode, "Сохранение...", "loading");

    try {
      await saveSidebarProfileField(field, nextValue);
      hideSidebarProfileEditor(factNode);
      setSidebarProfileStatus(factNode, "Сохранено", "success");
      window.setTimeout(() => {
        setSidebarProfileStatus(factNode, "");
      }, 1200);
    } catch (error) {
      setSidebarProfileStatus(factNode, error.message, "error");
      if (saveButton) saveButton.disabled = false;
    }
  });
}

function setSidebarProfileOpen(sidebar, isOpen) {
  if (!sidebar) return;
  const profilePanel = sidebar.querySelector(".sidebar-panel-profile");
  sidebar.classList.toggle("profile-open", Boolean(isOpen));
  if (profilePanel) {
    profilePanel.setAttribute("aria-hidden", isOpen ? "false" : "true");
  }
}

function initSidebarProfile() {
  const sidebar = document.querySelector(".sidebar");
  const badge = document.getElementById("currentUserBadge");
  const backButton = document.getElementById("sidebarProfileBack");
  const emailButton = document.getElementById("sidebarProfileEmail");
  const editToggleButton = document.getElementById("sidebarProfileEditToggle");
  const editButtons = document.querySelectorAll("[data-profile-edit]");

  fillSidebarProfile();

  if (!sidebar || !badge || !backButton || !editToggleButton || badge.dataset.profileBound === "true") {
    return;
  }

  badge.dataset.profileBound = "true";
  badge.addEventListener("click", () => {
    setSidebarProfileOpen(sidebar, true);
    setSidebarProfileEditMode(sidebar, false);
    void syncSidebarProfile();
  });

  backButton.addEventListener("click", () => {
    setSidebarProfileOpen(sidebar, false);
    setSidebarProfileEditMode(sidebar, false);
  });

  editToggleButton.addEventListener("click", () => {
    const nextState = !sidebar.classList.contains("profile-edit-mode");
    setSidebarProfileEditMode(sidebar, nextState);
  });

  if (emailButton && !emailButton.dataset.toggleBound) {
    emailButton.dataset.toggleBound = "true";
    emailButton.addEventListener("click", () => {
      if (!emailButton.textContent || emailButton.textContent === "Не указана") {
        return;
      }

      const nextBlurState = !emailButton.classList.contains("is-blurred");
      emailButton.classList.toggle("is-blurred", nextBlurState);
      emailButton.setAttribute("aria-pressed", nextBlurState ? "false" : "true");
      emailButton.setAttribute("aria-label", nextBlurState ? "Показать email" : "Скрыть email");
    });
  }

  editButtons.forEach((button) => {
    button.addEventListener("click", () => {
      openSidebarProfileEditor(button.dataset.profileEdit);
    });
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && sidebar.classList.contains("profile-open")) {
      setSidebarProfileOpen(sidebar, false);
      setSidebarProfileEditMode(sidebar, false);
    }
  });
}

function getChatSearchQuery() {
  return document.querySelector(".sidebar-search .search-input")?.value.trim() || "";
}

function getVisibleChats() {
  return chatState.allChats.filter((chat) => !pendingDeletedChatKeys.has(getChatStateKey(chat.id, chat.type || "direct")));
}

async function loadChats(listId = "chatList", options = {}) {
  const { showLoading = true } = options;
  const list = document.getElementById(listId);
  if (!list) return [];

  bindChatListScrollPersistence(listId);
  bindChatListActions(listId);

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
  const visibleChats = getVisibleChats();
  if (!normalizedQuery) {
    return visibleChats;
  }

  return visibleChats.filter((chat) => {
    const customTag = getChatTag(chat.id, chat.type || "direct");
    const haystack = [
      chat.title,
      chat.username,
      chat.last_message?.text,
      customTag?.label
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

function bindChatListScrollPersistence(listId = "chatList") {
  const list = document.getElementById(listId);
  if (!list || list.dataset.chatScrollBound === "true") {
    return;
  }

  list.dataset.chatScrollBound = "true";
  list.addEventListener("scroll", () => {
    saveChatListScroll(list);
  }, { passive: true });

  list.addEventListener("click", (event) => {
    if (event.target.closest(".chat-item")) {
      saveChatListScroll(list);
    }
  });
}

function buildChatListActionMenu() {
  if (chatListActionMenu) {
    return chatListActionMenu;
  }

  const menu = document.createElement("div");
  menu.className = "chat-list-action-menu";
  menu.hidden = true;
  document.body.appendChild(menu);
  chatListActionMenu = menu;
  return menu;
}

function buildChatTagEditorModal() {
  if (chatTagEditorModal) {
    return chatTagEditorModal;
  }

  const modal = document.createElement("div");
  modal.className = "chat-tag-editor-modal";
  modal.hidden = true;
  modal.innerHTML = `
    <div class="chat-tag-editor-backdrop" data-chat-tag-close="true"></div>
    <div class="chat-tag-editor-card" role="dialog" aria-modal="true" aria-label="Редактирование тега">
      <div class="chat-tag-editor-header">
        <h3>Тег чата</h3>
        <button type="button" class="chat-tag-editor-close" data-chat-tag-close="true" aria-label="Закрыть">×</button>
      </div>
      <form class="chat-tag-editor-form">
        <label class="label" for="chatTagLabelInput">Название</label>
        <input class="input" id="chatTagLabelInput" name="label" type="text" maxlength="16" placeholder="Например, Работа">
        <label class="label" for="chatTagColorInput">Цвет</label>
        <div class="chat-tag-editor-color-row">
          <input class="chat-tag-editor-color" id="chatTagColorInput" name="color" type="color" value="#3390ec">
          <div class="chat-tag-editor-preview">
            <span class="chat-kind-label chat-custom-label" id="chatTagPreviewLabel">Новый тег</span>
          </div>
        </div>
        <div class="chat-tag-editor-actions">
          <button class="button button-secondary" type="button" data-chat-tag-remove="true">Удалить тег</button>
          <button class="button" type="submit">Сохранить</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(modal);
  chatTagEditorModal = modal;
  return modal;
}

function buildChatDeleteUndoToast() {
  if (chatDeleteUndoToast) {
    return chatDeleteUndoToast;
  }

  const toast = document.createElement("div");
  toast.className = "chat-delete-undo-toast";
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
      <span class="delete-undo-title">Чат будет удален</span>
    </div>
    <button type="button" class="delete-undo-button">Отмена</button>
  `;
  document.body.appendChild(toast);
  chatDeleteUndoToast = toast;
  return toast;
}

function hideChatDeleteUndoToast() {
  if (chatDeleteUndoCountdownTimer) {
    window.clearInterval(chatDeleteUndoCountdownTimer);
    chatDeleteUndoCountdownTimer = null;
  }
  if (!chatDeleteUndoToast) {
    return;
  }

  chatDeleteUndoToast.classList.remove("visible");
  window.setTimeout(() => {
    if (chatDeleteUndoToast && !chatDeleteUndoToast.classList.contains("visible")) {
      chatDeleteUndoToast.hidden = true;
    }
  }, 180);
}

function showChatDeleteUndoToast(scope) {
  const toast = buildChatDeleteUndoToast();
  const titleNode = toast.querySelector(".delete-undo-title");
  const timerNode = toast.querySelector(".delete-undo-timer");
  if (titleNode) {
    titleNode.textContent = scope === "all"
      ? "Чат будет удален у всех"
      : "Чат будет удален";
  }

  let secondsLeft = 3;
  if (timerNode) {
    timerNode.textContent = String(secondsLeft);
  }
  if (chatDeleteUndoCountdownTimer) {
    window.clearInterval(chatDeleteUndoCountdownTimer);
  }
  chatDeleteUndoCountdownTimer = window.setInterval(() => {
    secondsLeft -= 1;
    if (timerNode && secondsLeft > 0) {
      timerNode.textContent = String(secondsLeft);
    }
    if (secondsLeft <= 0 && chatDeleteUndoCountdownTimer) {
      window.clearInterval(chatDeleteUndoCountdownTimer);
      chatDeleteUndoCountdownTimer = null;
    }
  }, 1000);

  toast.hidden = false;
  requestAnimationFrame(() => {
    const ringBar = toast.querySelector(".delete-undo-ring-bar");
    if (ringBar) {
      ringBar.classList.remove("running");
      void ringBar.getBoundingClientRect();
      ringBar.classList.add("running");
    }
    toast.classList.add("visible");
  });
}

function hideChatListActionMenu() {
  activeChatListItem = null;
  if (chatListMenuHideTimer) {
    window.clearTimeout(chatListMenuHideTimer);
    chatListMenuHideTimer = null;
  }
  if (!chatListActionMenu || chatListActionMenu.hidden) {
    return;
  }

  chatListActionMenu.classList.remove("visible");
  chatListMenuHideTimer = window.setTimeout(() => {
    if (chatListActionMenu) {
      chatListActionMenu.hidden = true;
    }
    chatListMenuHideTimer = null;
  }, 140);
}

function showChatListActionMenu(targetNode, clientX, clientY) {
  const menu = buildChatListActionMenu();
  if (chatListMenuHideTimer) {
    window.clearTimeout(chatListMenuHideTimer);
    chatListMenuHideTimer = null;
  }

  activeChatListItem = targetNode;
  const chatType = targetNode?.dataset.chatType || "direct";
  menu.innerHTML = chatType === "direct"
    ? `
      <button type="button" data-action="edit-tag">Изменить тег</button>
      <button type="button" data-action="delete-me">Удалить у меня</button>
      <button type="button" data-action="delete-all" class="danger">Удалить у всех</button>
    `
    : `
      <button type="button" data-action="edit-tag">Изменить тег</button>
    `;
  menu.hidden = false;
  const menuRect = menu.getBoundingClientRect();
  const menuWidth = menuRect.width || 180;
  const menuHeight = menuRect.height || 84;
  const left = Math.min(clientX, window.innerWidth - menuWidth - 12);
  const top = Math.min(clientY, window.innerHeight - menuHeight - 12);
  menu.style.left = `${Math.max(12, left)}px`;
  menu.style.top = `${Math.max(12, top)}px`;
  requestAnimationFrame(() => {
    menu.classList.add("visible");
  });
}

function closeChatTagEditorModal() {
  if (!chatTagEditorModal) {
    return;
  }
  chatTagEditorModal.classList.remove("visible");
  window.setTimeout(() => {
    if (chatTagEditorModal && !chatTagEditorModal.classList.contains("visible")) {
      chatTagEditorModal.hidden = true;
    }
  }, 180);
}

function updateChatTagPreview(modal) {
  const labelInput = modal.querySelector('#chatTagLabelInput');
  const colorInput = modal.querySelector('#chatTagColorInput');
  const preview = modal.querySelector('#chatTagPreviewLabel');
  if (!labelInput || !colorInput || !preview) {
    return;
  }

  const label = labelInput.value.trim() || "Новый тег";
  const color = normalizeChatTagColor(colorInput.value);
  const styleVars = getChatTagStyleVars(color);
  preview.textContent = label;
  preview.style.setProperty("--chat-tag-bg", styleVars.background);
  preview.style.setProperty("--chat-tag-border", styleVars.border);
  preview.style.setProperty("--chat-tag-text", styleVars.text);
  preview.style.setProperty("--chat-tag-solid", styleVars.solid);
}

function openChatTagEditor(chatItem, listId = "chatList") {
  const modal = buildChatTagEditorModal();
  const labelInput = modal.querySelector('#chatTagLabelInput');
  const colorInput = modal.querySelector('#chatTagColorInput');
  const removeButton = modal.querySelector('[data-chat-tag-remove="true"]');
  const form = modal.querySelector('.chat-tag-editor-form');
  const chatId = chatItem?.dataset.chatId;
  const chatType = chatItem?.dataset.chatType || "direct";

  if (!modal || !labelInput || !colorInput || !removeButton || !form || !chatId) {
    return;
  }

  const currentTag = getChatTag(chatId, chatType);
  labelInput.value = currentTag?.label || "";
  colorInput.value = currentTag?.color || "#3390ec";
  removeButton.hidden = !currentTag;
  updateChatTagPreview(modal);

  form.onsubmit = (event) => {
    event.preventDefault();
    setChatTag(chatId, chatType, {
      label: labelInput.value,
      color: colorInput.value
    });
    renderChats(document.getElementById(listId), filterChats(getChatSearchQuery()));
    closeChatTagEditorModal();
  };

  removeButton.onclick = () => {
    setChatTag(chatId, chatType, { label: "", color: colorInput.value });
    renderChats(document.getElementById(listId), filterChats(getChatSearchQuery()));
    closeChatTagEditorModal();
  };

  modal.hidden = false;
  requestAnimationFrame(() => {
    modal.classList.add("visible");
  });
  labelInput.focus();
}

function getActiveDirectChatContext() {
  const currentPath = window.location.pathname.split("/").pop() || "index.html";
  const currentId = new URLSearchParams(window.location.search).get("id");
  return {
    currentPath,
    currentId
  };
}

async function deleteDirectChatFromList(chatItem, scope, listId = "chatList") {
  const chatId = chatItem?.dataset.chatId;
  const chatType = chatItem?.dataset.chatType;
  if (!chatId || chatType !== "direct") {
    return;
  }

  const chatKey = getChatStateKey(chatId, chatType);

  if (pendingChatDeleteState) {
    await flushPendingChatDelete("commit", listId);
  }

  pendingDeletedChatKeys.add(chatKey);
  renderChats(document.getElementById(listId), filterChats(getChatSearchQuery()));

  pendingChatDeleteState = {
    chatId,
    chatType,
    chatKey,
    scope,
    listId,
    timerId: window.setTimeout(() => {
      void flushPendingChatDelete("commit", listId);
    }, 3000)
  };

  showChatDeleteUndoToast(scope);
}

async function flushPendingChatDelete(reason = "commit", listId = "chatList") {
  if (!pendingChatDeleteState) {
    return;
  }

  const state = pendingChatDeleteState;
  pendingChatDeleteState = null;
  if (state.timerId) {
    window.clearTimeout(state.timerId);
  }

  if (reason === "undo") {
    pendingDeletedChatKeys.delete(state.chatKey);
    renderChats(document.getElementById(state.listId || listId), filterChats(getChatSearchQuery()));
    hideChatDeleteUndoToast();
    return;
  }

  hideChatDeleteUndoToast();

  try {
    await apiFetch(`/chats/${encodeURIComponent(state.chatId)}?scope=${encodeURIComponent(state.scope)}`, {
      method: "DELETE"
    });
    pendingDeletedChatKeys.delete(state.chatKey);
    await loadChats(state.listId || listId, { showLoading: false });

    const { currentPath, currentId } = getActiveDirectChatContext();
    if (currentPath === "chat.html" && String(currentId) === String(state.chatId)) {
      window.location.href = "index.html";
    }
  } catch (error) {
    pendingDeletedChatKeys.delete(state.chatKey);
    renderChats(document.getElementById(state.listId || listId), filterChats(getChatSearchQuery()));
    hideChatDeleteUndoToast();
    window.alert(error.message);
  }
}

function bindChatListActions(listId = "chatList") {
  const list = document.getElementById(listId);
  if (!list || list.dataset.chatActionsBound === "true") {
    return;
  }

  buildChatListActionMenu();
  buildChatDeleteUndoToast();
  buildChatTagEditorModal();
  list.dataset.chatActionsBound = "true";

  list.addEventListener("contextmenu", (event) => {
    const chatItem = event.target.closest(".chat-item");
    if (!chatItem) {
      return;
    }

    event.preventDefault();
    showChatListActionMenu(chatItem, event.clientX, event.clientY);
  });

  list.addEventListener("touchstart", (event) => {
    const touch = event.touches[0];
    const chatItem = event.target.closest(".chat-item");
    if (!touch || !chatItem) {
      chatListTouchTarget = null;
      return;
    }

    chatListTouchTarget = chatItem;
    if (chatListTouchTimer) {
      window.clearTimeout(chatListTouchTimer);
    }

    chatListTouchTimer = window.setTimeout(() => {
      if (!chatListTouchTarget) {
        return;
      }
      showChatListActionMenu(chatListTouchTarget, touch.clientX, touch.clientY);
      chatListTouchTimer = null;
    }, 520);
  }, { passive: true });

  list.addEventListener("touchend", () => {
    if (chatListTouchTimer) {
      window.clearTimeout(chatListTouchTimer);
      chatListTouchTimer = null;
    }
    chatListTouchTarget = null;
  }, { passive: true });

  list.addEventListener("touchcancel", () => {
    if (chatListTouchTimer) {
      window.clearTimeout(chatListTouchTimer);
      chatListTouchTimer = null;
    }
    chatListTouchTarget = null;
  }, { passive: true });

  chatListActionMenu.addEventListener("click", async (event) => {
    const action = event.target.closest("button")?.dataset.action;
    const targetItem = activeChatListItem;
    hideChatListActionMenu();
    if (!action || !targetItem) {
      return;
    }

    if (action === "edit-tag") {
      openChatTagEditor(targetItem, listId);
      return;
    }

    try {
      await deleteDirectChatFromList(targetItem, action === "delete-all" ? "all" : "me", listId);
    } catch (error) {
      window.alert(error.message);
    }
  });

  chatDeleteUndoToast.querySelector(".delete-undo-button")?.addEventListener("click", () => {
    void flushPendingChatDelete("undo", listId);
  });

  document.addEventListener("click", (event) => {
    if (!event.target.closest(".chat-list-action-menu")) {
      hideChatListActionMenu();
    }
  });

  document.addEventListener("mousedown", (event) => {
    if (
      !event.target.closest(".chat-list-action-menu") &&
      !event.target.closest(".chat-item") &&
      !event.target.closest(".chat-tag-editor-card")
    ) {
      hideChatListActionMenu();
    }
  });

  chatTagEditorModal.addEventListener("click", (event) => {
    if (event.target.closest('[data-chat-tag-close="true"]')) {
      closeChatTagEditorModal();
    }
  });

  chatTagEditorModal.querySelector('#chatTagLabelInput')?.addEventListener("input", () => {
    updateChatTagPreview(chatTagEditorModal);
  });

  chatTagEditorModal.querySelector('#chatTagColorInput')?.addEventListener("input", () => {
    updateChatTagPreview(chatTagEditorModal);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && chatTagEditorModal && !chatTagEditorModal.hidden) {
      closeChatTagEditorModal();
    }
  });

  window.addEventListener("resize", hideChatListActionMenu);
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
window.addEventListener("pagehide", () => {
  saveChatListScroll(document.getElementById("chatList"));
});
window.addEventListener("beforeunload", () => {
  saveChatListScroll(document.getElementById("chatList"));
});

function renderChats(list, chats) {
  const previousScrollTop = list.scrollTop;

  if (!chats.length) {
    const hasQuery = Boolean(document.querySelector(".sidebar-search .search-input")?.value.trim());
    list.innerHTML = `<div class="empty-state">${hasQuery ? "Ничего не найдено" : "Чатов пока нет"}</div>`;
    restoreChatListScroll(list, previousScrollTop);
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
      const customTagMarkup = getChatTagMarkup(chat.id, chat.type || "direct");
      const active = currentPath === "group_chat.html"
        ? isGroup && String(chat.id) === currentId
        : currentPath === "chat.html"
          ? !isGroup && String(chat.id) === currentId
          : false;

      return `
        <a class="chat-item ${active ? "active" : ""}" href="${href}" data-chat-id="${escapeHtml(String(chat.id))}" data-chat-type="${escapeHtml(chat.type || "direct")}">
          <div class="avatar ${isGroup ? "group-avatar" : ""}">
            ${escapeHtml(initials(name))}
            ${isGroup ? '<span class="chat-kind-badge" aria-hidden="true">👥</span>' : ""}
          </div>
          <div class="chat-meta">
            <div class="chat-topline">
              <div class="chat-title-row">
                <h3 class="chat-name">${escapeHtml(name)}</h3>
                ${customTagMarkup}
              </div>
              <span class="time">${escapeHtml(formatDate(chat.updated_at || chat.last_message?.created_at))}</span>
            </div>
            <p class="chat-preview">${escapeHtml(preview)}</p>
          </div>
        </a>
      `;
    })
    .join("");

  restoreChatListScroll(list, previousScrollTop);
}
