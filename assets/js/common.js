const chatState = {
  allChats: [],
  allServers: [],
  refreshIntervalId: null,
  refreshListId: null,
  activeServer: null,
  sidebarView: "chats"
};
const CHAT_LIST_SCROLL_KEY = "messenger:chat-list-scroll-top";
const CHAT_TAGS_KEY = "messenger:chat-tags";
const APP_SETTINGS_KEY = "messenger:settings";
const SERVER_CATEGORY_STATE_KEY = "messenger:server-category-state";
const SIDEBAR_VIEW_KEY = "messenger:sidebar-view";
const SIDEBAR_SELECTED_SERVER_KEY = "messenger:selected-server-id";
let chatListActionMenu = null;
let activeChatListItem = null;
let chatListMenuHideTimer = null;
let chatListTouchTimer = null;
let chatListTouchTarget = null;
let chatListRealtimeSocket = null;
let chatListRealtimeBoundListId = null;
let chatListRefreshTimer = null;
let incomingNotificationAudioContext = null;
let lastIncomingNotificationSoundAt = 0;
let chatDeleteUndoToast = null;
let chatTagEditorModal = null;
let groupOwnerLeaveModal = null;
let groupDeleteConfirmModal = null;
let pendingChatDeleteState = null;
let chatDeleteUndoCountdownTimer = null;
let activeChatTagFilter = "all";
const pendingDeletedChatKeys = new Set();
let userRelationConfirmModal = null;
let serverStructureModal = null;
let serverStructureEditorState = null;
let serverSidebarActionMenu = null;
let sidebarServerHeaderMenuHideTimer = null;
let serverSettingsModal = null;
let activeServerSettingsSection = "profile";
let serverSettingsRolesEditorState = null;
let serverInviteModal = null;
let serverInviteModalState = null;
let sidebarSwipeTransition = Promise.resolve();
const SERVER_INVITE_EXPIRATION_OPTIONS = [
  { id: "30m", label: "30 минут" },
  { id: "1h", label: "1 час" },
  { id: "24h", label: "24 часа" },
  { id: "7d", label: "7 дней" },
  { id: "never", label: "Без срока" }
];
const SERVER_INVITE_MAX_USES_OPTIONS = [
  { id: "1", label: "1 раз" },
  { id: "5", label: "5 раз" },
  { id: "10", label: "10 раз" },
  { id: "0", label: "Без лимита" }
];
const SERVER_ROLE_COLOR_PRESETS = [
  "#EF4444",
  "#F97316",
  "#F59E0B",
  "#22C55E",
  "#3B82F6",
  "#8B5CF6",
  "#EC4899",
  "#94A3B8"
];
const SERVER_ROLE_PERMISSION_GROUPS = [
  {
    id: "general",
    title: "Общие права",
    items: [
      { id: "view_server", label: "Просматривать сервер", description: "Позволяет видеть сервер и его структуру." },
      { id: "manage_server", label: "Управлять сервером", description: "Даёт доступ к базовым настройкам сервера." },
      { id: "manage_roles", label: "Управлять ролями", description: "Позволяет создавать, изменять и удалять роли ниже своей роли." },
      { id: "manage_channels", label: "Управлять каналами", description: "Позволяет редактировать и удалять каналы сервера." },
      { id: "view_audit_log", label: "Просматривать журнал аудита", description: "Открывает историю административных действий." }
    ]
  },
  {
    id: "members",
    title: "Участники",
    items: [
      { id: "invite_members", label: "Приглашать участников", description: "Разрешает создавать и отправлять приглашения." },
      { id: "kick_members", label: "Исключать участников", description: "Позволяет удалять участников с сервера." },
      { id: "ban_members", label: "Банить участников", description: "Позволяет полностью закрывать доступ к серверу." },
      { id: "manage_nicknames", label: "Управлять никами", description: "Разрешает менять ники другим участникам." },
      { id: "change_nickname", label: "Изменять свой ник", description: "Разрешает участнику менять собственный ник." }
    ]
  },
  {
    id: "messages",
    title: "Сообщения",
    items: [
      { id: "read_messages", label: "Читать сообщения", description: "Позволяет просматривать сообщения в текстовых каналах." },
      { id: "send_messages", label: "Отправлять сообщения", description: "Разрешает писать сообщения в текстовых каналах." },
      { id: "delete_messages", label: "Удалять сообщения", description: "Позволяет удалять чужие сообщения." },
      { id: "pin_messages", label: "Закреплять сообщения", description: "Позволяет закреплять важные сообщения." },
      { id: "embed_links", label: "Отправлять ссылки", description: "Разрешает публиковать ссылки и предпросмотры." },
      { id: "attach_files", label: "Прикреплять файлы", description: "Позволяет загружать изображения и документы." },
      { id: "mention_everyone", label: "Упоминать @everyone", description: "Разрешает массовые упоминания для участников сервера." },
      { id: "manage_messages", label: "Управлять сообщениями", description: "Даёт расширенный контроль над текстовыми каналами." }
    ]
  },
  {
    id: "voice",
    title: "Голосовые каналы",
    items: [
      { id: "connect_voice", label: "Подключаться", description: "Разрешает входить в голосовые каналы." },
      { id: "speak_voice", label: "Говорить", description: "Позволяет использовать микрофон в голосовых каналах." },
      { id: "mute_members", label: "Отключать микрофон участникам", description: "Даёт право временно заглушать участников." },
      { id: "deafen_members", label: "Отключать звук участникам", description: "Позволяет приглушать звук для участников." },
      { id: "move_members", label: "Перемещать участников", description: "Позволяет переносить участников между каналами." }
    ]
  },
  {
    id: "administration",
    title: "Администрирование",
    items: [
      { id: "administrator", label: "Администратор", description: "Даёт полный доступ ко всем настройкам сервера." }
    ]
  }
];
const SERVER_ROLE_DEFAULT_PERMISSIONS = {
  view_server: true,
  manage_server: false,
  manage_roles: false,
  manage_channels: false,
  view_audit_log: false,
  invite_members: true,
  kick_members: false,
  ban_members: false,
  manage_nicknames: false,
  change_nickname: true,
  read_messages: true,
  send_messages: true,
  delete_messages: false,
  pin_messages: false,
  embed_links: true,
  attach_files: true,
  mention_everyone: false,
  manage_messages: false,
  connect_voice: true,
  speak_voice: true,
  mute_members: false,
  deafen_members: false,
  move_members: false,
  administrator: false,
  display_separately: false,
  mentionable: false
};
const SERVER_CHANNEL_TYPE_OPTIONS = [
  { id: "text", label: "Текстовый канал" },
  { id: "voice", label: "Голосовой канал" },
  { id: "announcements", label: "Канал объявлений" },
  { id: "private", label: "Приватный канал" }
];
const SERVER_CHANNEL_ACCESS_OPTIONS = {
  view: [
    { id: "everyone", label: "Все участники" },
    { id: "selected_roles", label: "Только выбранные роли" },
    { id: "admins", label: "Только администраторы" },
    { id: "owner", label: "Только владелец" }
  ],
  write: [
    { id: "everyone", label: "Все участники" },
    { id: "selected_roles", label: "Только выбранные роли" },
    { id: "moderators_admins", label: "Только модераторы и администраторы" },
    { id: "nobody", label: "Никто, только чтение" }
  ],
  files: [
    { id: "everyone", label: "Все участники" },
    { id: "selected_roles", label: "Только выбранные роли" },
    { id: "moderators_admins", label: "Только модераторы и администраторы" },
    { id: "nobody", label: "Запрещено" }
  ],
  links: [
    { id: "everyone", label: "Все участники" },
    { id: "selected_roles", label: "Только выбранные роли" },
    { id: "moderators_admins", label: "Только модераторы и администраторы" },
    { id: "nobody", label: "Запрещено" }
  ],
  everyone_mentions: [
    { id: "everyone", label: "Все участники" },
    { id: "moderators_admins", label: "Только модераторы и администраторы" },
    { id: "admins", label: "Только администраторы" },
    { id: "nobody", label: "Запрещено" }
  ]
};
const SERVER_CHANNEL_ROLE_PERMISSION_DEFINITIONS = [
  { id: "view_channel", label: "Видеть канал" },
  { id: "read_messages", label: "Читать сообщения" },
  { id: "send_messages", label: "Отправлять сообщения" },
  { id: "send_files", label: "Отправлять файлы" },
  { id: "send_links", label: "Отправлять ссылки" },
  { id: "manage_messages", label: "Управлять сообщениями" },
  { id: "manage_channel", label: "Управлять каналом" }
];
const SERVER_CHANNEL_SLOWMODE_OPTIONS = [
  { id: "off", label: "Выключен" },
  { id: "5s", label: "5 секунд" },
  { id: "30s", label: "30 секунд" },
  { id: "1m", label: "1 минута" },
  { id: "5m", label: "5 минут" },
  { id: "15m", label: "15 минут" }
];
const defaultAppSettings = {
  theme: "light",
  accentColor: "#3390ec",
  textSize: 16,
  surfaceMode: "glass",
  animations: true,
  chatWallpaper: "none",
  transparency: 62,
  uiRadius: 24,
  enterToSend: true,
  messageDensity: "comfortable",
  linkPreviews: true,
  timeFormat: "24",
  notificationSound: true,
  desktopNotifications: false,
  notificationTextPreview: true,
  doNotDisturb: false,
  onlineVisibility: "everyone",
  lastSeenVisibility: "contacts",
  directMessagesPrivacy: "everyone",
  groupInvitesPrivacy: "contacts",
  readReceipts: true,
  typingStatus: true,
  screenshotProtection: false
};

function getUserRelationStorageKey() {
  const currentUser = getCurrentUser() || {};
  return `messenger:user-relations:${currentUser.id || "guest"}`;
}

function readUserRelationState() {
  const rawValue = window.localStorage.getItem(getUserRelationStorageKey());
  if (!rawValue) {
    return { mutedUserIds: [], blockedUserIds: [] };
  }

  try {
    const parsed = JSON.parse(rawValue);
    return {
      mutedUserIds: Array.isArray(parsed?.mutedUserIds) ? parsed.mutedUserIds.map((value) => String(value)) : [],
      blockedUserIds: Array.isArray(parsed?.blockedUserIds) ? parsed.blockedUserIds.map((value) => String(value)) : []
    };
  } catch {
    return { mutedUserIds: [], blockedUserIds: [] };
  }
}

function writeUserRelationState(state) {
  window.localStorage.setItem(getUserRelationStorageKey(), JSON.stringify({
    mutedUserIds: [...new Set((state?.mutedUserIds || []).map((value) => String(value)))],
    blockedUserIds: [...new Set((state?.blockedUserIds || []).map((value) => String(value)))]
  }));
}

function setMutedUserState(userId, isMuted) {
  if (!userId) return;
  const state = readUserRelationState();
  const mutedUserIds = new Set(state.mutedUserIds);
  if (isMuted) {
    mutedUserIds.add(String(userId));
  } else {
    mutedUserIds.delete(String(userId));
  }
  writeUserRelationState({
    ...state,
    mutedUserIds: [...mutedUserIds]
  });
}

function setBlockedUserState(userId, isBlocked) {
  if (!userId) return;
  const state = readUserRelationState();
  const blockedUserIds = new Set(state.blockedUserIds);
  if (isBlocked) {
    blockedUserIds.add(String(userId));
  } else {
    blockedUserIds.delete(String(userId));
  }
  writeUserRelationState({
    ...state,
    blockedUserIds: [...blockedUserIds]
  });
}

function syncUserRelationStateFromProfile(user = {}) {
  if (!user?.id) {
    return;
  }
  if (typeof user.is_muted === "boolean") {
    setMutedUserState(user.id, user.is_muted);
  }
  if (typeof user.is_blocked === "boolean") {
    setBlockedUserState(user.id, user.is_blocked);
  }
}

function syncUserRelationStateFromChats(chats = []) {
  chats
    .filter((chat) => (chat?.type || "direct") === "direct" && chat?.user_id)
    .forEach((chat) => {
      syncUserRelationStateFromProfile({
        id: chat.user_id,
        is_muted: Boolean(chat.is_muted),
        is_blocked: Boolean(chat.is_blocked)
      });
    });
}

function isUserMutedLocally(userId) {
  if (!userId) {
    return false;
  }
  return readUserRelationState().mutedUserIds.includes(String(userId));
}

function getChatStateKey(chatId, chatType = "direct") {
  return `${chatType}:${chatId}`;
}

function readServerCategoryUiState() {
  const rawValue = window.localStorage.getItem(SERVER_CATEGORY_STATE_KEY);
  if (!rawValue) {
    return {};
  }
  try {
    const parsed = JSON.parse(rawValue);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeServerCategoryUiState(state) {
  window.localStorage.setItem(SERVER_CATEGORY_STATE_KEY, JSON.stringify(state || {}));
}

function getServerCategoryUiKey(serverId, categoryId) {
  return `${serverId}:${categoryId}`;
}

function isServerCategoryCollapsed(serverId, categoryId) {
  const state = readServerCategoryUiState();
  return state[getServerCategoryUiKey(serverId, categoryId)] === true;
}

function setServerCategoryCollapsed(serverId, categoryId, collapsed) {
  const state = readServerCategoryUiState();
  const key = getServerCategoryUiKey(serverId, categoryId);
  if (collapsed) {
    state[key] = true;
  } else {
    delete state[key];
  }
  writeServerCategoryUiState(state);
}

function readStoredSidebarView() {
  const rawValue = String(window.localStorage.getItem(SIDEBAR_VIEW_KEY) || "").trim();
  return rawValue === "servers" || rawValue === "server-detail" ? rawValue : "chats";
}

function writeStoredSidebarView(view) {
  const normalizedView = view === "servers" ? "servers" : view === "server-detail" ? "server-detail" : "chats";
  window.localStorage.setItem(SIDEBAR_VIEW_KEY, normalizedView);
}

function readSelectedServerId() {
  const rawValue = String(window.localStorage.getItem(SIDEBAR_SELECTED_SERVER_KEY) || "").trim();
  return rawValue || null;
}

function writeSelectedServerId(serverId) {
  if (!serverId) {
    window.localStorage.removeItem(SIDEBAR_SELECTED_SERVER_KEY);
    return;
  }
  window.localStorage.setItem(SIDEBAR_SELECTED_SERVER_KEY, String(serverId));
}

function readAppSettings() {
  const rawValue = window.localStorage.getItem(APP_SETTINGS_KEY);
  if (!rawValue) return { ...defaultAppSettings };
  try {
    const parsed = JSON.parse(rawValue);
    return {
      ...defaultAppSettings,
      ...(parsed && typeof parsed === "object" ? parsed : {})
    };
  } catch {
    return { ...defaultAppSettings };
  }
}

function saveAppSettings(settings) {
  window.localStorage.setItem(APP_SETTINGS_KEY, JSON.stringify(settings));
}

function getAppSetting(key) {
  return Boolean(readAppSettings()[key]);
}

function renderActionMenuItemContent(iconPath, label) {
  return `
    <img class="menu-item-icon icon-asset" src="${iconPath}" alt="">
    <span class="menu-item-label">${escapeHtml(String(label || ""))}</span>
  `;
}

const SYSTEM_ACCOUNT_USERNAME = "chatik";
const SYSTEM_ACCOUNT_ICON_PATH = "/assets/icons/ui/CPU.svg";

function normalizeUsername(value = "") {
  return String(value || "").trim().replace(/^@+/, "").toLowerCase();
}

function isSystemAccountUsername(value = "") {
  return normalizeUsername(value) === SYSTEM_ACCOUNT_USERNAME;
}

function renderSystemAccountLabel(label, identity = {}, options = {}) {
  const safeLabel = escapeHtml(String(label || ""));
  const username = typeof identity === "string" ? identity : identity?.username;
  const accountKey = normalizeUsername(username || (options.allowLabelFallback ? label : ""));
  if (accountKey !== SYSTEM_ACCOUNT_USERNAME) {
    return safeLabel;
  }

  const className = options.className ? ` ${escapeHtml(String(options.className))}` : "";
  return `
    <span class="system-account-label${className}">
      <span class="system-account-label-text">${safeLabel}</span>
      <img class="system-account-icon icon-asset" src="${SYSTEM_ACCOUNT_ICON_PATH}" alt="" aria-hidden="true">
    </span>
  `;
}

function clampSetting(value, min, max, fallback) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, numericValue));
}

function normalizeAccentColor(color) {
  const value = typeof color === "string" ? color.trim() : "";
  return /^#([0-9a-f]{6})$/i.test(value) ? value : defaultAppSettings.accentColor;
}

function darkenHexColor(color, amount = 0.14) {
  const normalized = normalizeAccentColor(color).replace("#", "");
  const adjust = (start) => {
    const value = Number.parseInt(normalized.slice(start, start + 2), 16);
    const nextValue = Math.max(0, Math.min(255, Math.round(value * (1 - amount))));
    return nextValue.toString(16).padStart(2, "0");
  };
  return `#${adjust(0)}${adjust(2)}${adjust(4)}`;
}

function getChatListPreviewText(lastMessage) {
  if (!lastMessage) {
    return "Нет сообщений";
  }

  const messageType = String(lastMessage.message_type || "text");
  if (messageType === "forwarded_dialog") {
    return "Пересланный диалог";
  }
  if (messageType === "voice") {
    return "Голосовое сообщение";
  }
  if (messageType === "photo") {
    return "Фотография";
  }
  if (messageType === "sticker") {
    return "Стикер";
  }
  if (messageType === "system") {
    return lastMessage.text || "Системное сообщение";
  }

  return lastMessage.text || "Нет сообщений";
}

function normalizeAppSettings(rawSettings = {}) {
  const privacyAudienceValues = ["everyone", "contacts", "nobody"];
  return {
    ...defaultAppSettings,
    ...rawSettings,
    theme: rawSettings.theme === "dark" ? "dark" : "light",
    accentColor: normalizeAccentColor(rawSettings.accentColor || defaultAppSettings.accentColor),
    textSize: clampSetting(rawSettings.textSize, 14, 20, defaultAppSettings.textSize),
    surfaceMode: rawSettings.surfaceMode === "compact" ? "compact" : "glass",
    animations: rawSettings.animations !== false,
    chatWallpaper: ["none", "grid", "aurora", "paper"].includes(rawSettings.chatWallpaper) ? rawSettings.chatWallpaper : "none",
    transparency: clampSetting(rawSettings.transparency, 35, 92, defaultAppSettings.transparency),
    uiRadius: clampSetting(rawSettings.uiRadius, 12, 34, defaultAppSettings.uiRadius),
    enterToSend: rawSettings.enterToSend !== false,
    linkPreviews: rawSettings.linkPreviews !== false,
    timeFormat: rawSettings.timeFormat === "12" ? "12" : "24",
    notificationSound: rawSettings.notificationSound !== false,
    desktopNotifications: rawSettings.desktopNotifications === true,
    notificationTextPreview: rawSettings.notificationTextPreview !== false,
    doNotDisturb: rawSettings.doNotDisturb === true,
    onlineVisibility: privacyAudienceValues.includes(rawSettings.onlineVisibility)
      ? rawSettings.onlineVisibility
      : defaultAppSettings.onlineVisibility,
    lastSeenVisibility: privacyAudienceValues.includes(rawSettings.lastSeenVisibility)
      ? rawSettings.lastSeenVisibility
      : defaultAppSettings.lastSeenVisibility,
    directMessagesPrivacy: privacyAudienceValues.includes(rawSettings.directMessagesPrivacy)
      ? rawSettings.directMessagesPrivacy
      : defaultAppSettings.directMessagesPrivacy,
    groupInvitesPrivacy: privacyAudienceValues.includes(rawSettings.groupInvitesPrivacy)
      ? rawSettings.groupInvitesPrivacy
      : defaultAppSettings.groupInvitesPrivacy,
    readReceipts: rawSettings.readReceipts !== false,
    typingStatus: rawSettings.typingStatus !== false,
    screenshotProtection: rawSettings.screenshotProtection === true,
    messageDensity: ["compact", "comfortable", "spacious"].includes(rawSettings.messageDensity)
      ? rawSettings.messageDensity
      : defaultAppSettings.messageDensity
  };
}

function applyAppSettings(settings = readAppSettings()) {
  const normalizedSettings = normalizeAppSettings(settings);
  const root = document.documentElement;
  const accentDark = darkenHexColor(normalizedSettings.accentColor, 0.14);
  const densityPresets = {
    compact: {
      stackGap: "9px",
      bubblePadding: "7px 12px 5px",
      bubbleRadius: "18px",
      directPadding: "6px 11px 4px",
      directRadius: "17px",
      authorMarginBottom: "3px",
      authorSize: "12px",
      textLineHeight: "1.32",
      previewMarginBottom: "7px",
      previewPadding: "8px 11px",
      metaMarginTop: "3px",
      directMetaMarginTop: "2px"
    },
    comfortable: {
      stackGap: "14px",
      bubblePadding: "10px 16px 7px",
      bubbleRadius: "22px",
      directPadding: "9px 14px 6px",
      directRadius: "20px",
      authorMarginBottom: "6px",
      authorSize: "13px",
      textLineHeight: "1.4",
      previewMarginBottom: "9px",
      previewPadding: "10px 13px",
      metaMarginTop: "4px",
      directMetaMarginTop: "3px"
    },
    spacious: {
      stackGap: "18px",
      bubblePadding: "13px 18px 9px",
      bubbleRadius: "24px",
      directPadding: "11px 16px 8px",
      directRadius: "22px",
      authorMarginBottom: "6px",
      authorSize: "13px",
      textLineHeight: "1.47",
      previewMarginBottom: "10px",
      previewPadding: "11px 14px",
      metaMarginTop: "5px",
      directMetaMarginTop: "4px"
    }
  };
  const densityPreset = densityPresets[normalizedSettings.messageDensity] || densityPresets.comfortable;

  root.classList.toggle("settings-theme-dark", normalizedSettings.theme === "dark");
  document.body.classList.toggle("settings-theme-dark", normalizedSettings.theme === "dark");
  document.body.classList.toggle("settings-surface-compact", normalizedSettings.surfaceMode === "compact");
  document.body.classList.toggle("settings-surface-glass", normalizedSettings.surfaceMode !== "compact");
  document.body.classList.toggle("settings-strong-surface-blur", normalizedSettings.transparency < 65);
  document.body.classList.toggle("settings-reduced-motion", !normalizedSettings.animations);
  document.body.classList.toggle("settings-link-previews-off", !normalizedSettings.linkPreviews);
  document.body.dataset.chatWallpaper = normalizedSettings.chatWallpaper;
  document.body.dataset.timeFormat = normalizedSettings.timeFormat;

  root.style.setProperty("--accent", normalizedSettings.accentColor);
  root.style.setProperty("--accent-dark", accentDark);
  root.style.setProperty("--settings-text-size", `${normalizedSettings.textSize}px`);
  root.style.setProperty("--settings-surface-alpha", String(normalizedSettings.transparency / 100));
  root.style.setProperty("--radius-lg", `${normalizedSettings.uiRadius}px`);
  root.style.setProperty("--radius-md", `${Math.max(12, normalizedSettings.uiRadius - 6)}px`);
  root.style.setProperty("--radius-sm", `${Math.max(10, normalizedSettings.uiRadius - 10)}px`);
  root.style.setProperty("--message-stack-gap", densityPreset.stackGap);
  root.style.setProperty("--message-bubble-padding", densityPreset.bubblePadding);
  root.style.setProperty("--message-bubble-radius", densityPreset.bubbleRadius);
  root.style.setProperty("--message-direct-padding", densityPreset.directPadding);
  root.style.setProperty("--message-direct-radius", densityPreset.directRadius);
  root.style.setProperty("--message-author-margin-bottom", densityPreset.authorMarginBottom);
  root.style.setProperty("--message-author-font-size", densityPreset.authorSize);
  root.style.setProperty("--message-text-line-height", densityPreset.textLineHeight);
  root.style.setProperty("--message-preview-margin-bottom", densityPreset.previewMarginBottom);
  root.style.setProperty("--message-preview-padding", densityPreset.previewPadding);
  root.style.setProperty("--message-meta-margin-top", densityPreset.metaMarginTop);
  root.style.setProperty("--message-direct-meta-margin-top", densityPreset.directMetaMarginTop);

  document.dispatchEvent(new CustomEvent("appsettingschange", {
    detail: normalizedSettings
  }));

  const chatList = document.getElementById("chatList");
  if (chatList && Array.isArray(chatState.allChats)) {
    if (chatState.sidebarView === "server-detail" && chatState.activeServer) {
      renderServerSidebar(chatList, chatState.activeServer);
    } else if (chatState.sidebarView === "servers") {
      renderServerList(chatList, getVisibleServers());
    } else {
      renderChats(chatList, filterChats(getChatSearchQuery()));
    }
  }
}

function initSettingsControls() {
  const settingsRoot = document.querySelector(".sidebar-settings-body");
  const resetButton = document.querySelector("[data-settings-reset='appearance']");
  const settingsSections = document.querySelectorAll(".sidebar-settings-body .sidebar-settings-section");
  const settings = normalizeAppSettings(readAppSettings());
  applyAppSettings(settings);

  if (settingsSections.length) {
    settingsSections.forEach((section) => {
      const head = section.querySelector(":scope > .sidebar-settings-section-head");
      if (!head || head.dataset.collapseBound === "true") {
        return;
      }

      head.dataset.collapseBound = "true";
      section.classList.add("is-collapsible");
      section.classList.add("is-collapsed");
      head.setAttribute("role", "button");
      head.setAttribute("tabindex", "0");
      head.setAttribute("aria-expanded", "false");

      const toggleSection = () => {
        const nextCollapsed = !section.classList.contains("is-collapsed");
        section.classList.toggle("is-collapsed", nextCollapsed);
        head.setAttribute("aria-expanded", nextCollapsed ? "false" : "true");
      };

      head.addEventListener("click", toggleSection);
      head.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") {
          return;
        }
        event.preventDefault();
        toggleSection();
      });
    });
  }

  if (!settingsRoot || settingsRoot.dataset.settingsBound === "true") {
    return;
  }

  settingsRoot.dataset.settingsBound = "true";
  const controlMap = new Map();

  const updateValuePreview = (settingKey, value) => {
    const valueNode = settingsRoot.querySelector(`[data-setting-value="${settingKey}"]`);
    if (!valueNode) {
      return;
    }

    if (settingKey === "textSize" || settingKey === "uiRadius") {
      valueNode.textContent = `${value}px`;
      return;
    }

    if (settingKey === "transparency") {
      valueNode.textContent = `${value}%`;
    }
  };

  settingsRoot.querySelectorAll("[data-setting-control]").forEach((input) => {
    const settingKey = input.dataset.settingControl;
    if (!settingKey) return;
    controlMap.set(settingKey, input);

    if (input.type === "checkbox") {
      input.checked = Boolean(settings[settingKey]);
    } else {
      input.value = String(settings[settingKey]);
    }
    updateValuePreview(settingKey, settings[settingKey]);

    input.addEventListener("input", () => {
      if (settingKey === "desktopNotifications" && input.type === "checkbox" && input.checked) {
        if (typeof window.Notification !== "function") {
          input.checked = false;
          showAppToast("Браузер не поддерживает desktop notifications", { type: "error" });
          return;
        }

        if (window.Notification.permission === "denied") {
          input.checked = false;
          showAppToast("Уведомления браузера заблокированы в настройках", { type: "error" });
          return;
        }

        if (window.Notification.permission === "default") {
          window.Notification.requestPermission().then((permission) => {
            if (permission !== "granted") {
              input.checked = false;
              const revertedSettings = normalizeAppSettings({
                ...readAppSettings(),
                desktopNotifications: false
              });
              saveAppSettings(revertedSettings);
              applyAppSettings(revertedSettings);
              showAppToast("Доступ к уведомлениям не выдан", { type: "error" });
            }
          }).catch(() => {
            input.checked = false;
            showAppToast("Не удалось запросить доступ к уведомлениям", { type: "error" });
          });
        }
      }

      const nextSettings = normalizeAppSettings({
        ...readAppSettings(),
        [settingKey]: input.type === "checkbox" ? input.checked : input.value
      });
      saveAppSettings(nextSettings);
      applyAppSettings(nextSettings);
      updateValuePreview(settingKey, nextSettings[settingKey]);
    });
  });

  if (resetButton && resetButton.dataset.settingsResetBound !== "true") {
    resetButton.dataset.settingsResetBound = "true";
    resetButton.addEventListener("click", () => {
      const nextSettings = normalizeAppSettings({
        ...readAppSettings(),
        theme: defaultAppSettings.theme,
        accentColor: defaultAppSettings.accentColor,
        textSize: defaultAppSettings.textSize,
        surfaceMode: defaultAppSettings.surfaceMode,
        animations: defaultAppSettings.animations,
        chatWallpaper: defaultAppSettings.chatWallpaper,
        transparency: defaultAppSettings.transparency,
        uiRadius: defaultAppSettings.uiRadius,
        linkPreviews: defaultAppSettings.linkPreviews,
        timeFormat: defaultAppSettings.timeFormat,
        messageDensity: defaultAppSettings.messageDensity
      });

      saveAppSettings(nextSettings);
      applyAppSettings(nextSettings);

      controlMap.forEach((input, settingKey) => {
        if (input.type === "checkbox") {
          input.checked = Boolean(nextSettings[settingKey]);
        } else {
          input.value = String(nextSettings[settingKey]);
        }
        updateValuePreview(settingKey, nextSettings[settingKey]);
      });
    });
  }

  initAccountSettingsControls();
  initSecurityControls();
}

function initAccountSettingsControls() {
  const emailForm = document.querySelector("[data-account-email-form='true']");
  const passwordForm = document.querySelector("[data-account-password-form='true']");
  const emailStatus = document.querySelector("[data-account-email-status='true']");
  const passwordStatus = document.querySelector("[data-account-password-status='true']");
  const emailRequestButton = document.querySelector("[data-account-email-request]");
  const passwordRequestButton = document.querySelector("[data-account-password-request]");

  syncAccountSettingsSummary();

  const setStatus = (node, message = "", type = "") => {
    if (!node) {
      return;
    }
    node.textContent = message;
    node.className = `status settings-account-status ${type}`.trim();
  };

  if (emailForm && emailForm.dataset.bound !== "true") {
    emailForm.dataset.bound = "true";
    const emailInput = emailForm.querySelector('input[name="email"]');
    const codeInput = emailForm.querySelector('input[name="code"]');

    emailRequestButton?.addEventListener("click", async () => {
      const email = emailInput?.value?.trim() || "";
      if (!email) {
        setStatus(emailStatus, "Введите новый email", "error");
        emailInput?.focus();
        return;
      }

      emailRequestButton.disabled = true;
      setStatus(emailStatus, "Отправка кода...");
      try {
        const response = await apiFetch("/users/me/email-change/request", {
          method: "POST",
          body: JSON.stringify({ email })
        });
        setStatus(emailStatus, response?.message || "Код отправлен", "success");
        codeInput?.focus();
      } catch (error) {
        setStatus(emailStatus, error.message, "error");
      } finally {
        emailRequestButton.disabled = false;
      }
    });

    emailForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const submitButton = emailForm.querySelector('button[type="submit"]');
      const email = emailInput?.value?.trim() || "";
      const code = (codeInput?.value || "").replace(/\D/g, "").slice(0, 6);
      if (!email) {
        setStatus(emailStatus, "Введите новый email", "error");
        emailInput?.focus();
        return;
      }

      submitButton.disabled = true;
      setStatus(emailStatus, "Подтверждение...");
      try {
        const updatedUser = await apiFetch("/users/me/email-change/confirm", {
          method: "POST",
          body: JSON.stringify({ email, code })
        });
        applySidebarProfileUserUpdate(updatedUser);
        emailForm.reset();
        setStatus(emailStatus, "Email обновлён", "success");
      } catch (error) {
        setStatus(emailStatus, error.message, "error");
      } finally {
        submitButton.disabled = false;
      }
    });
  }

  if (passwordForm && passwordForm.dataset.bound !== "true") {
    passwordForm.dataset.bound = "true";
    const passwordInput = passwordForm.querySelector('input[name="password"]');
    const codeInput = passwordForm.querySelector('input[name="code"]');

    passwordRequestButton?.addEventListener("click", async () => {
      const password = passwordInput?.value || "";
      if (password.length < 6) {
        setStatus(passwordStatus, "Пароль должен содержать минимум 6 символов", "error");
        passwordInput?.focus();
        return;
      }

      passwordRequestButton.disabled = true;
      setStatus(passwordStatus, "Отправка кода...");
      try {
        const response = await apiFetch("/users/me/password-change/request", {
          method: "POST",
          body: JSON.stringify({})
        });
        setStatus(passwordStatus, response?.message || "Код отправлен", "success");
        codeInput?.focus();
      } catch (error) {
        setStatus(passwordStatus, error.message, "error");
      } finally {
        passwordRequestButton.disabled = false;
      }
    });

    passwordForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const submitButton = passwordForm.querySelector('button[type="submit"]');
      const password = passwordInput?.value || "";
      const code = (codeInput?.value || "").replace(/\D/g, "").slice(0, 6);
      if (password.length < 6) {
        setStatus(passwordStatus, "Пароль должен содержать минимум 6 символов", "error");
        passwordInput?.focus();
        return;
      }

      submitButton.disabled = true;
      setStatus(passwordStatus, "Подтверждение...");
      try {
        const response = await apiFetch("/users/me/password-change/confirm", {
          method: "POST",
          body: JSON.stringify({ password, code })
        });
        passwordForm.reset();
        setStatus(passwordStatus, response?.message || "Пароль изменён", "success");
      } catch (error) {
        setStatus(passwordStatus, error.message, "error");
      } finally {
        submitButton.disabled = false;
      }
    });
  }
}

function formatSecurityDateTime(value) {
  const date = parseUtcDate(value);
  if (!date) {
    return "Нет данных";
  }

  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: getUserTimeZone(),
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function renderSecurityDevices(devices = []) {
  if (!Array.isArray(devices) || !devices.length) {
    return '<div class="empty-state">Устройства пока не определены</div>';
  }

  return devices.map((device) => {
    const label = String(device?.device_label || "Неизвестное устройство").trim() || "Неизвестное устройство";
    const badges = [
      device?.is_current ? '<span class="thread-member-role owner">Это устройство</span>' : "",
      '<span class="thread-member-role">Входы</span>'
    ].filter(Boolean).join("");

    return `
      <article class="member-item">
        <div class="avatar small">${escapeHtml(initials(label))}</div>
        <div class="result-meta">
          <div class="result-topline">
            <h3 class="result-name">${escapeHtml(label)}</h3>
          </div>
          <p class="result-username">Первый вход: ${escapeHtml(formatSecurityDateTime(device?.first_seen_at))}</p>
          <p class="result-username">Последний вход: ${escapeHtml(formatSecurityDateTime(device?.last_seen_at))}</p>
        </div>
        <div class="thread-info-member-meta">
          ${badges}
        </div>
      </article>
    `;
  }).join("");
}

function initSecurityControls() {
  const root = document.querySelector("[data-security-settings-root='true']");
  if (!root || root.dataset.securityBound === "true") {
    return;
  }

  root.dataset.securityBound = "true";

  const statusNode = root.querySelector("[data-security-status='true']");
  const summaryNode = root.querySelector("[data-security-summary]");
  const devicesNode = root.querySelector("[data-security-devices-list='true']");
  const loginAlertsInput = root.querySelector("[data-security-control='loginAlertsEnabled']");
  const refreshButton = root.querySelector("[data-security-refresh]");
  const terminateButton = root.querySelector("[data-security-terminate-sessions]");

  const setStatus = (message = "", type = "") => {
    if (!statusNode) {
      return;
    }
    statusNode.textContent = message;
    statusNode.className = `status ${type}`.trim();
  };

  const applyOverview = (overview = {}) => {
    if (loginAlertsInput) {
      loginAlertsInput.checked = Boolean(overview.login_alerts_enabled);
    }
    if (summaryNode) {
      const sessionsCount = Number(overview.active_sessions_count || 0);
      const devicesCount = Number(overview.known_devices_count || 0);
      summaryNode.textContent = `${sessionsCount} сессий, ${devicesCount} устройств`;
    }
    if (devicesNode) {
      devicesNode.innerHTML = renderSecurityDevices(overview.devices || []);
    }
  };

  const loadOverview = async (options = {}) => {
    if (!options.silent) {
      setStatus("Загружаем безопасность...");
    }
    try {
      const overview = await apiFetch("/security/overview");
      applyOverview(overview);
      setStatus(options.successMessage || "");
      const currentUser = getCurrentUser();
      if (currentUser && typeof overview.login_alerts_enabled === "boolean") {
        setCurrentUser({
          ...currentUser,
          login_alerts_enabled: overview.login_alerts_enabled
        });
      }
      return overview;
    } catch (error) {
      setStatus(error.message, "error");
      throw error;
    }
  };

  loginAlertsInput?.addEventListener("input", async () => {
    const nextValue = Boolean(loginAlertsInput.checked);
    setStatus("Сохраняем настройки...");
    try {
      const overview = await apiFetch("/security/preferences", {
        method: "PATCH",
        body: JSON.stringify({
          login_alerts_enabled: nextValue
        })
      });
      applyOverview(overview);
      setStatus("Настройки безопасности сохранены", "success");
    } catch (error) {
      loginAlertsInput.checked = !nextValue;
      setStatus(error.message, "error");
    }
  });

  refreshButton?.addEventListener("click", () => {
    void loadOverview({ successMessage: "Данные безопасности обновлены" });
  });

  terminateButton?.addEventListener("click", async () => {
    setStatus("Завершаем другие сессии...");
    terminateButton.disabled = true;
    try {
      const overview = await apiFetch("/security/terminate-other-sessions", {
        method: "POST"
      });
      applyOverview(overview);
      setStatus(`Завершено сессий: ${Math.max(0, Number(overview.revoked_sessions || 0))}`, "success");
    } catch (error) {
      setStatus(error.message, "error");
    } finally {
      terminateButton.disabled = false;
    }
  });

  void loadOverview({ silent: true });
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

function formatPresenceDate(value) {
  const date = parseUtcDate(value);
  if (!date) {
    return "";
  }

  return date.toLocaleDateString("ru-RU", {
    timeZone: getUserTimeZone(),
    day: "numeric",
    month: "long"
  });
}

function formatPresenceHours(hours) {
  const value = Math.max(1, Math.floor(hours));
  return `был(а) в сети ${value} ч назад`;
}

function formatPresenceText(info = {}) {
  if (info?.hide_presence) {
    return "";
  }

  if (info?.is_online) {
    return "в сети";
  }

  const lastSeenDate = parseUtcDate(info?.last_seen);
  if (!lastSeenDate) {
    return "не в сети";
  }

  const diffMs = Math.max(0, Date.now() - lastSeenDate.getTime());
  const diffMinutes = Math.floor(diffMs / 60000);

  if (diffMinutes < 1) {
    return "был(а) в сети только что";
  }

  if (diffMinutes < 60) {
    return `был(а) в сети ${diffMinutes} мин назад`;
  }

  if (diffMinutes < 24 * 60) {
    return formatPresenceHours(diffMinutes / 60);
  }

  return `был(а) в сети ${formatPresenceDate(info.last_seen)}`;
}

function getPresenceState(info = {}) {
  if (info?.hide_presence) {
    return "";
  }
  return info?.is_online ? "online" : "offline";
}

function renderPresenceBadge(info = {}, options = {}) {
  const {
    showDot = true,
    compact = false,
    includeUsername = false
  } = options;
  const state = getPresenceState(info);
  const text = formatPresenceText(info);
  if (!text) {
    return "";
  }
  const username = includeUsername && info?.username ? `<span class="presence-meta">@${escapeHtml(info.username)}</span>` : "";
  const dot = showDot ? `<span class="presence-dot ${state}" aria-hidden="true"></span>` : "";
  const compactClass = compact ? " compact" : "";

  return `
    <span class="presence-badge ${state}${compactClass}">
      ${dot}${username}<span class="presence-label">${escapeHtml(text)}</span>
    </span>
  `;
}

function getUserProfileDisplayName(user = {}) {
  return user?.contact_alias || user?.name || user?.username || "Пользователь";
}

function getUserProfileOriginalName(user = {}) {
  const alias = typeof user?.contact_alias === "string" ? user.contact_alias.trim() : "";
  const originalName = typeof user?.name === "string" ? user.name.trim() : "";
  if (!alias || !originalName || alias === originalName) {
    return "";
  }
  return originalName;
}

function getUserProfileBadges(user = {}) {
  if (Array.isArray(user?.badges)) {
    return user.badges
      .map((badge) => String(badge || "").trim().toUpperCase())
      .filter(Boolean);
  }
  return [];
}

function showAppToast(message, options = {}) {
  const text = String(message || "").trim();
  if (!text) {
    return;
  }

  const toast = document.createElement("div");
  toast.className = `app-toast ${options.type || ""}`.trim();
  toast.textContent = text;
  document.body.appendChild(toast);
  requestAnimationFrame(() => {
    toast.classList.add("visible");
  });
  window.setTimeout(() => {
    toast.classList.remove("visible");
    window.setTimeout(() => {
      toast.remove();
    }, 180);
  }, options.duration || 1600);
}

function getLiveNotificationSettings() {
  return normalizeAppSettings(readAppSettings());
}

function getIncomingNotificationTitle(payload = {}) {
  const threadTitle = String(payload.thread_title || "").trim();
  if ((payload.chat_type || "") === "group") {
    const senderName = String(payload.sender_name || "Новый участник").trim() || "Новый участник";
    return threadTitle ? `${senderName} • ${threadTitle}` : senderName;
  }
  return threadTitle || String(payload.sender_name || "Чат").trim() || "Чат";
}

function getIncomingNotificationBody(payload = {}, settings = getLiveNotificationSettings()) {
  const messageType = String(payload.message_type || "text");
  const fallbackLabel = messageType === "voice"
    ? "Голосовое сообщение"
    : (messageType === "photo" ? "Фотография" : (messageType === "sticker" ? "Стикер" : "Новое сообщение"));
  if (!settings.notificationTextPreview) {
    return fallbackLabel;
  }

  if (messageType === "voice") {
    return "Голосовое сообщение";
  }
  if (messageType === "photo") {
    return "Фотография";
  }
  if (messageType === "sticker") {
    return "Стикер";
  }

  const text = String(payload.text || "").trim();
  return text || fallbackLabel;
}

function playIncomingNotificationSound() {
  const settings = getLiveNotificationSettings();
  if (settings.doNotDisturb || !settings.notificationSound) {
    return;
  }

  const now = Date.now();
  if (now - lastIncomingNotificationSoundAt < 220) {
    return;
  }
  lastIncomingNotificationSoundAt = now;

  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      return;
    }

    incomingNotificationAudioContext = incomingNotificationAudioContext || new AudioContextClass();
    const audioContext = incomingNotificationAudioContext;
    if (audioContext.state === "suspended") {
      void audioContext.resume().catch(() => {});
    }

    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(880, audioContext.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(660, audioContext.currentTime + 0.09);
    gainNode.gain.setValueAtTime(0.0001, audioContext.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.035, audioContext.currentTime + 0.015);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + 0.14);
    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);
    oscillator.start(audioContext.currentTime);
    oscillator.stop(audioContext.currentTime + 0.15);
  } catch {
    // Ignore browser autoplay or audio context failures.
  }
}

function showIncomingDesktopNotification(payload = {}) {
  const settings = getLiveNotificationSettings();
  if (settings.doNotDisturb || !settings.desktopNotifications) {
    return;
  }

  if (typeof window.Notification !== "function" || window.Notification.permission !== "granted") {
    return;
  }

  if (document.visibilityState === "visible" && document.hasFocus()) {
    return;
  }

  try {
    const notification = new window.Notification(getIncomingNotificationTitle(payload), {
      body: getIncomingNotificationBody(payload, settings),
      tag: `${payload.chat_type || "chat"}:${payload.chat_id || "unknown"}`,
      silent: true
    });

    notification.onclick = () => {
      window.focus();
      notification.close();
    };

    window.setTimeout(() => {
      notification.close();
    }, 5000);
  } catch {
    // Ignore notification API failures.
  }
}

function handleGlobalIncomingNotification(payload = {}) {
  const currentUser = getCurrentUser() || {};
  if (!payload || String(payload.sender_id || "") === String(currentUser.id || "")) {
    return;
  }

  if (String(payload.message_type || "text") === "system") {
    return;
  }

  if (isUserMutedLocally(payload.sender_id)) {
    return;
  }

  const route = getCurrentRouteInfo();
  const payloadChatType = String(payload.chat_type || "direct");
  const payloadChatId = String(payload.chat_id || "");
  const currentRouteChatType = String(document.body.dataset.chatType || route.chatType || "direct");
  const currentRouteChatId = String(route.chatId || "");

  if (
    route.chatType
    && currentRouteChatId
    && payloadChatId
    && payloadChatId === currentRouteChatId
    && payloadChatType === currentRouteChatType
  ) {
    return;
  }

  playIncomingNotificationSound();
  showIncomingDesktopNotification(payload);
}

function closeUserProfileActionMenus() {
  document.querySelectorAll("[data-user-profile-menu]").forEach((menu) => {
    menu.classList.remove("visible");
    const card = menu.closest("[data-user-profile-card]");
    const trigger = card?.querySelector("[data-user-profile-menu-trigger]");
    if (trigger) {
      trigger.setAttribute("aria-expanded", "false");
    }
    window.setTimeout(() => {
      if (!menu.classList.contains("visible")) {
        menu.hidden = true;
      }
    }, 160);
  });
}

function toggleUserProfileActionMenu(card) {
  if (!card) {
    return;
  }

  const menu = card.querySelector("[data-user-profile-menu]");
  const trigger = card.querySelector("[data-user-profile-menu-trigger]");
  if (!menu || !trigger) {
    return;
  }

  const isOpen = !menu.hidden && menu.classList.contains("visible");
  closeUserProfileActionMenus();
  if (isOpen) {
    return;
  }

  menu.hidden = false;
  trigger.setAttribute("aria-expanded", "true");
  requestAnimationFrame(() => {
    menu.classList.add("visible");
  });
}

function renderUserProfilePanel(user = {}, options = {}) {
  syncUserRelationStateFromProfile(user);
  const resolvedUserId = String(user?.user_id || user?.id || "");
  const displayName = getUserProfileDisplayName(user);
  const originalName = getUserProfileOriginalName(user);
  const bio = user?.bio && String(user.bio).trim() ? String(user.bio).trim() : "";
  const birthDate = formatProfileBirthDate(user?.date_of_birth);
  const username = user?.username ? `@${user.username}` : "";
  const currentUser = getCurrentUser() || {};
  const canManageRelations = String(currentUser.id || "") !== resolvedUserId;
  const presence = user?.hide_presence
    ? ""
    : renderPresenceBadge(user, { compact: true, includeUsername: false, showDot: false });
  const badges = getUserProfileBadges(user);
  const isContact = Boolean(user?.is_contact);
  const hasAlias = Boolean(user?.contact_alias && String(user.contact_alias).trim());
  const menuMarkup = options.showActions === false
    ? ""
    : `
      <button
        class="sidebar-profile-menu-trigger user-profile-menu-trigger"
        type="button"
        data-user-profile-menu-trigger
        aria-label="Действия профиля"
        aria-haspopup="menu"
        aria-expanded="false"
      ><img class="icon-asset" src="/assets/icons/ui/Meatballs_menu.svg" alt=""></button>
      <div class="sidebar-profile-menu user-profile-action-menu" data-user-profile-menu hidden>
        <button class="sidebar-profile-menu-item" type="button" data-profile-contact-action="copy-username" data-profile-user-id="${escapeHtml(resolvedUserId)}">
          ${renderActionMenuItemContent("/assets/icons/ui/Copy.svg", "Скопировать username")}
        </button>
        ${canManageRelations ? `
          <button class="sidebar-profile-menu-item" type="button" data-profile-contact-action="${user?.is_muted ? "unmute" : "mute"}" data-profile-user-id="${escapeHtml(resolvedUserId)}">
            ${renderActionMenuItemContent(user?.is_muted ? "/assets/icons/ui/notifications_on.svg" : "/assets/icons/ui/sound_mute_fill.svg", user?.is_muted ? "Включить уведомления" : "Отключить уведомления")}
          </button>
          <button class="sidebar-profile-menu-item ${user?.is_blocked ? "" : "danger"}" type="button" data-profile-contact-action="${user?.is_blocked ? "unblock" : "block"}" data-profile-user-id="${escapeHtml(resolvedUserId)}">
            ${renderActionMenuItemContent(user?.is_blocked ? "/assets/icons/ui/block_line.svg" : "/assets/icons/ui/block.svg", user?.is_blocked ? "Разблокировать пользователя" : "Заблокировать пользователя")}
          </button>
        ` : ""}
        ${!isContact ? `
          <button class="sidebar-profile-menu-item" type="button" data-profile-contact-action="add" data-profile-user-id="${escapeHtml(resolvedUserId)}">
            ${renderActionMenuItemContent("/assets/icons/ui/Add_round.svg", "Добавить в контакты")}
          </button>
        ` : `
          <button class="sidebar-profile-menu-item" type="button" data-profile-contact-action="rename" data-profile-user-id="${escapeHtml(resolvedUserId)}">
            ${renderActionMenuItemContent("/assets/icons/ui/Edit_fill.svg", "Переименовать контакт")}
          </button>
          ${hasAlias ? `
            <button class="sidebar-profile-menu-item" type="button" data-profile-contact-action="reset-alias" data-profile-user-id="${escapeHtml(resolvedUserId)}">
              ${renderActionMenuItemContent("/assets/icons/ui/Refresh_2.svg", "Вернуть имя по умолчанию")}
            </button>
          ` : ""}
          <button class="sidebar-profile-menu-item danger" type="button" data-profile-contact-action="remove" data-profile-user-id="${escapeHtml(resolvedUserId)}">
            ${renderActionMenuItemContent("/assets/icons/ui/Trash_line.svg", "Удалить из контактов")}
          </button>
        `}
      </div>
    `;

  return `
    <section class="thread-info-card thread-info-card-profile user-profile-panel-card" data-user-profile-card="true" data-user-profile-id="${escapeHtml(resolvedUserId)}">
      <div class="thread-info-card-eyebrow">${escapeHtml(options.eyebrow || "Profile")}</div>
      ${menuMarkup}
      <div class="thread-info-hero user-profile-panel-hero">
        <div class="avatar thread-info-avatar${options.groupAvatar ? " group-avatar" : ""}">${escapeHtml(initials(displayName))}</div>
        <h3 class="thread-info-name">${renderSystemAccountLabel(displayName, user)}</h3>
        ${originalName ? `<p class="user-profile-original-name">${escapeHtml(originalName)}</p>` : ""}
        <div class="user-profile-identity-row">
          ${username ? `
            <button class="user-profile-username" type="button" data-profile-copy-username="${escapeHtml(String(user.username || ""))}" aria-label="Скопировать username">
              ${renderSystemAccountLabel(username, user)}
            </button>
          ` : `<span class="user-profile-username is-placeholder">username не указан</span>`}
          ${presence}
        </div>
        ${badges.length ? `
          <div class="user-profile-badges">
            ${badges.map((badge) => `<span class="user-profile-badge-chip">${escapeHtml(badge)}</span>`).join("")}
          </div>
        ` : ""}
        ${bio ? `<p class="thread-info-description user-profile-bio">${escapeHtml(bio)}</p>` : ""}
        ${birthDate ? `
          <div class="user-profile-details">
            <div class="user-profile-detail">
              <span class="user-profile-detail-label">Дата рождения</span>
              <strong class="user-profile-detail-value">${escapeHtml(birthDate)}</strong>
            </div>
          </div>
        ` : ""}
        <div class="status user-profile-actions-status" data-user-profile-status></div>
      </div>
    </section>
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
    window.location.href = getLoginRoute();
  });
}

let profileLogoutModal = null;

function buildProfileLogoutModal() {
  if (profileLogoutModal) {
    return profileLogoutModal;
  }

  const modal = document.createElement("div");
  modal.className = "profile-logout-modal";
  modal.hidden = true;
  modal.innerHTML = `
    <div class="profile-logout-backdrop" data-profile-logout-close="true"></div>
    <div class="profile-logout-card" role="dialog" aria-modal="true" aria-labelledby="profileLogoutTitle">
      <div class="profile-logout-header">
        <h3 id="profileLogoutTitle">Выйти из аккаунта?</h3>
        <button type="button" class="profile-logout-close" data-profile-logout-close="true" aria-label="Закрыть"><img class="icon-asset" src="/assets/icons/ui/Close_round.svg" alt=""></button>
      </div>
      <div class="profile-logout-body">
        <div class="profile-logout-actions">
          <button type="button" class="button button-secondary" data-profile-logout-close="true">Отмена</button>
          <button type="button" class="button button-danger" id="profileLogoutConfirm">Выйти</button>
        </div>
        <div class="status profile-logout-status" id="profileLogoutStatus"></div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  profileLogoutModal = modal;
  return modal;
}

function closeProfileLogoutModal() {
  if (!profileLogoutModal) {
    return;
  }
  profileLogoutModal.classList.remove("visible");
  window.setTimeout(() => {
    if (profileLogoutModal && !profileLogoutModal.classList.contains("visible")) {
      profileLogoutModal.hidden = true;
    }
  }, 180);
}

function openProfileLogoutModal() {
  const modal = buildProfileLogoutModal();
  const confirmButton = modal.querySelector("#profileLogoutConfirm");
  const status = modal.querySelector("#profileLogoutStatus");
  if (!confirmButton || !status) {
    return;
  }

  status.textContent = "";
  status.className = "status profile-logout-status";
  confirmButton.disabled = false;
  confirmButton.textContent = "Выйти";
  confirmButton.onclick = () => {
    confirmButton.disabled = true;
    confirmButton.textContent = "Выход...";
    status.textContent = "Завершение сессии...";
    clearSession();
    window.location.href = getLoginRoute();
  };

  modal.hidden = false;
  requestAnimationFrame(() => {
    modal.classList.add("visible");
  });
}

function buildUserRelationConfirmModal() {
  if (userRelationConfirmModal) {
    return userRelationConfirmModal;
  }

  const modal = document.createElement("div");
  modal.className = "profile-logout-modal user-relation-confirm-modal";
  modal.hidden = true;
  modal.innerHTML = `
    <div class="profile-logout-backdrop" data-user-relation-close="true"></div>
    <div class="profile-logout-card" role="dialog" aria-modal="true" aria-labelledby="userRelationConfirmTitle">
      <div class="profile-logout-header">
        <h3 id="userRelationConfirmTitle">Подтвердите действие</h3>
        <button type="button" class="profile-logout-close" data-user-relation-close="true" aria-label="Закрыть"><img class="icon-asset" src="/assets/icons/ui/Close_round.svg" alt=""></button>
      </div>
      <div class="profile-logout-body">
        <p class="profile-logout-copy" id="userRelationConfirmBody"></p>
        <div class="profile-logout-actions">
          <button type="button" class="button button-secondary" data-user-relation-close="true">Отмена</button>
          <button type="button" class="button button-danger" id="userRelationConfirmSubmit">Подтвердить</button>
        </div>
        <div class="status profile-logout-status" id="userRelationConfirmStatus"></div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  userRelationConfirmModal = modal;
  return modal;
}

function closeUserRelationConfirmModal() {
  if (!userRelationConfirmModal) {
    return;
  }
  userRelationConfirmModal.classList.remove("visible");
  window.setTimeout(() => {
    if (userRelationConfirmModal && !userRelationConfirmModal.classList.contains("visible")) {
      userRelationConfirmModal.hidden = true;
    }
  }, 180);
}

function openUserRelationConfirmModal(options = {}) {
  const modal = buildUserRelationConfirmModal();
  const titleNode = modal.querySelector("#userRelationConfirmTitle");
  const bodyNode = modal.querySelector("#userRelationConfirmBody");
  const confirmButton = modal.querySelector("#userRelationConfirmSubmit");
  const statusNode = modal.querySelector("#userRelationConfirmStatus");

  if (!titleNode || !bodyNode || !confirmButton || !statusNode) {
    return Promise.resolve(false);
  }

  titleNode.textContent = options.title || "Подтвердите действие";
  bodyNode.textContent = options.body || "";
  statusNode.textContent = "";
  statusNode.className = "status profile-logout-status";
  confirmButton.textContent = options.confirmText || "Подтвердить";
  confirmButton.className = `button ${options.danger === false ? "" : "button-danger"}`.trim() || "button";
  confirmButton.disabled = false;

  return new Promise((resolve) => {
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      closeUserRelationConfirmModal();
      resolve(result);
    };

    confirmButton.onclick = () => finish(true);
    modal.onclick = (event) => {
      if (event.target.closest("[data-user-relation-close='true']")) {
        finish(false);
      }
    };

    modal.hidden = false;
    requestAnimationFrame(() => {
      modal.classList.add("visible");
    });
  });
}

function fillUserBadge(targetId = "currentUserBadge") {
  const target = document.getElementById(targetId);
  const user = getCurrentUser();
  const adminLink = document.getElementById("sidebarAdminLink");
  if (adminLink) {
    adminLink.hidden = true;
  }
  if (!target || !user) return;
  const badgeLabel = user.username ? `@${user.username}` : user.name || "User";
  target.innerHTML = renderSystemAccountLabel(badgeLabel, user);
}

function updateAdminLinkVisibility(user) {
  const adminLink = document.getElementById("sidebarAdminLink");
  if (!adminLink) {
    return;
  }
  if (!["admin", "system_owner"].includes(user?.role || "")) {
    adminLink.remove();
    return;
  }
  adminLink.hidden = false;
}

function getSidebarProfileFields() {
  return {
    name: document.getElementById("sidebarProfileNameField"),
    email: document.getElementById("sidebarProfileEmail"),
    username: document.getElementById("sidebarProfileHandle"),
    bio: document.getElementById("sidebarProfileBio"),
    date_of_birth: document.getElementById("sidebarProfileDateOfBirth")
  };
}

function formatProfileBirthDate(value) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return "";
  }

  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return normalized;
  }

  const [, year, month, day] = match;
  const dateValue = new Date(`${year}-${month}-${day}T00:00:00Z`);
  if (Number.isNaN(dateValue.getTime())) {
    return normalized;
  }

  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC"
  }).format(dateValue);
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
    case "date_of_birth":
      return formatProfileBirthDate(user.date_of_birth) || "Не указана";
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

  if (!user || !avatar || !name || !username || !fields.name || !fields.email || !fields.username || !fields.bio || !fields.date_of_birth) {
    return;
  }

  const fullName = user.name || user.username || "Пользователь";
  const usernameValue = user.username ? `@${user.username}` : "Не указан";

  avatar.textContent = initials(fullName);
  name.innerHTML = renderSystemAccountLabel(fullName, user);
  username.innerHTML = renderSystemAccountLabel(usernameValue, user);
  fields.name.innerHTML = renderSystemAccountLabel(getSidebarProfileFieldValue("name", user), user);
  fields.username.innerHTML = renderSystemAccountLabel(getSidebarProfileFieldValue("username", user), user);
  fields.username.setAttribute("aria-label", user.username ? "Скопировать username" : "Username не указан");
  fields.bio.textContent = getSidebarProfileFieldValue("bio", user);
  fields.bio.classList.toggle("multiline", Boolean(user.bio));
  fields.date_of_birth.textContent = getSidebarProfileFieldValue("date_of_birth", user);

  fields.email.textContent = getSidebarProfileFieldValue("email", user);
  fields.email.classList.toggle("is-blurred", Boolean(user.email));
  fields.email.setAttribute("aria-label", user.email ? "Показать email" : "Email не указан");
  fields.email.setAttribute("aria-pressed", "false");
  syncAccountSettingsSummary();
}

function setSidebarProfileEditMode(sidebar, isActive) {
  if (!sidebar) return;
  sidebar.classList.toggle("profile-edit-mode", Boolean(isActive));
  if (!isActive) {
    document.querySelectorAll(".sidebar-profile-fact").forEach(hideSidebarProfileEditor);
  }
}

async function syncSidebarProfile() {
  try {
    const user = await apiFetch("/users/me");
    setCurrentUser(user);
    fillUserBadge();
    updateAdminLinkVisibility(user);
    fillSidebarProfile();
  } catch {
    // Keep local session data if profile sync fails.
  }
}

function getSidebarProfileEditConfig(field) {
  return {
    name: {
      label: "Имя",
      editor: "input",
      maxLength: 80,
      value: (user) => user?.name || ""
    },
    email: {
      label: "Email",
      editor: "input",
      workflow: "email-change",
      maxLength: 255,
      value: () => ""
    },
    password: {
      label: "Пароль",
      editor: "input",
      workflow: "password-change",
      inputType: "password",
      maxLength: 255,
      value: () => ""
    },
    username: {
      label: "Username",
      editor: "input",
      maxLength: 32,
      value: (user) => user?.username || ""
    },
    bio: {
      label: "Bio",
      editor: "contenteditable",
      maxLength: 50,
      value: (user) => user?.bio || ""
    },
    date_of_birth: {
      label: "Дата рождения",
      editor: "input",
      inputType: "date",
      maxLength: 10,
      value: (user) => user?.date_of_birth || ""
    }
  }[field];
}

function createSidebarProfileEditorControl(field, config, value) {
  if (config.editor === "contenteditable") {
    const editor = document.createElement("div");
    editor.className = "sidebar-profile-editor-input";
    editor.dataset.editorField = field;
    editor.dataset.placeholder = `Введите ${config.label.toLowerCase()}`;
    editor.setAttribute("contenteditable", "true");
    editor.setAttribute("role", "textbox");
    editor.setAttribute("aria-multiline", "true");
    editor.spellcheck = true;
    editor.textContent = value;
    editor.classList.toggle("is-empty", !value);
    return editor;
  }

  const input = document.createElement("input");
  input.className = "sidebar-profile-editor-input";
  input.dataset.editorField = field;
  input.type = config.inputType || (field === "email" ? "email" : "text");
  if (config.maxLength) {
    input.maxLength = config.maxLength;
  }
  input.value = value;
  input.placeholder = `Введите ${config.label.toLowerCase()}`;
  input.classList.toggle("is-empty", !value);
  return input;
}

function readSidebarProfileEditorValue(control) {
  if (!control) {
    return "";
  }

  if (control.matches('[contenteditable="true"]')) {
    return (control.textContent || "").trim();
  }

  return (control.value || "").trim();
}

function updateSidebarProfileEditorVisualState(control) {
  if (!control) {
    return;
  }

  control.classList.toggle("is-empty", !readSidebarProfileEditorValue(control));
}

function focusSidebarProfileEditorControl(control) {
  if (!control) {
    return;
  }

  control.focus();
  if (control.matches('[contenteditable="true"]')) {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(control);
    range.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(range);
    return;
  }

  if (typeof control.setSelectionRange === "function") {
    control.setSelectionRange(control.value.length, control.value.length);
  }
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

function applySidebarProfileUserUpdate(updatedUser) {
  setCurrentUser(updatedUser);
  fillUserBadge();
  fillSidebarProfile();
}

function syncAccountSettingsSummary() {
  const currentEmailNode = document.querySelector("[data-account-current-email='true']");
  if (!currentEmailNode) {
    return;
  }

  const user = getCurrentUser();
  const email = String(user?.email || "").trim();
  currentEmailNode.textContent = email ? `Текущий email: ${email}` : "Текущий email: не указан";
}

function createSidebarProfileEditorInput(field, { placeholder = "", type = "text", maxLength = 255 } = {}) {
  const input = document.createElement("input");
  input.className = "sidebar-profile-editor-input";
  input.dataset.editorField = field;
  input.type = type;
  input.placeholder = placeholder;
  input.autocomplete = "off";
  if (maxLength) {
    input.maxLength = maxLength;
  }
  input.addEventListener("input", () => {
    updateSidebarProfileEditorVisualState(input);
  });
  updateSidebarProfileEditorVisualState(input);
  return input;
}

function createSidebarProfileSensitiveEditor(field, factNode) {
  const config = getSidebarProfileEditConfig(field);
  if (!config) {
    return null;
  }

  const editor = document.createElement("form");
  editor.className = "sidebar-profile-editor sidebar-profile-editor-stack";

  const isEmailFlow = config.workflow === "email-change";
  const valueInput = createSidebarProfileEditorInput(field, {
    type: isEmailFlow ? "email" : "password",
    placeholder: isEmailFlow ? "Введите новый email" : "Введите новый пароль",
    maxLength: config.maxLength || 255
  });
  const codeInput = createSidebarProfileEditorInput(`${field}-code`, {
    type: "text",
    placeholder: "Введите код из письма",
    maxLength: 6
  });
  codeInput.inputMode = "numeric";
  codeInput.pattern = "[0-9]*";

  const requestButton = document.createElement("button");
  requestButton.className = "sidebar-profile-editor-button request";
  requestButton.type = "button";
  requestButton.textContent = "Получить код";

  const actions = document.createElement("div");
  actions.className = "sidebar-profile-editor-actions";
  actions.innerHTML = `
    <button class="sidebar-profile-editor-button cancel" type="button">Отмена</button>
    <button class="sidebar-profile-editor-button save" type="submit">Подтвердить</button>
  `;

  editor.appendChild(valueInput);
  editor.appendChild(codeInput);
  editor.appendChild(requestButton);
  editor.appendChild(actions);

  actions.querySelector(".cancel")?.addEventListener("click", () => {
    hideSidebarProfileEditor(factNode);
  });

  requestButton.addEventListener("click", async () => {
    const nextValue = readSidebarProfileEditorValue(valueInput);
    if (isEmailFlow) {
      if (!nextValue) {
        setSidebarProfileStatus(factNode, "Введите новый email", "error");
        focusSidebarProfileEditorControl(valueInput);
        return;
      }
    } else if (nextValue.length < 6) {
      setSidebarProfileStatus(factNode, "Пароль должен содержать минимум 6 символов", "error");
      focusSidebarProfileEditorControl(valueInput);
      return;
    }

    requestButton.disabled = true;
    setSidebarProfileStatus(factNode, "Отправка кода...", "loading");

    try {
      const response = isEmailFlow
        ? await apiFetch("/users/me/email-change/request", {
          method: "POST",
          body: JSON.stringify({ email: nextValue })
        })
        : await apiFetch("/users/me/password-change/request", {
          method: "POST",
          body: JSON.stringify({})
        });

      if (isEmailFlow && response?.email && !readSidebarProfileEditorValue(valueInput)) {
        valueInput.value = response.email;
      }
      setSidebarProfileStatus(factNode, response?.message || "Код отправлен", "success");
      focusSidebarProfileEditorControl(codeInput);
    } catch (error) {
      setSidebarProfileStatus(factNode, error.message, "error");
    } finally {
      requestButton.disabled = false;
    }
  });

  editor.addEventListener("submit", async (event) => {
    event.preventDefault();

    const nextValue = readSidebarProfileEditorValue(valueInput);
    const code = readSidebarProfileEditorValue(codeInput).replace(/\D/g, "").slice(0, 6);
    const confirmButton = actions.querySelector(".save");
    if (confirmButton) {
      confirmButton.disabled = true;
    }

    setSidebarProfileStatus(factNode, "Проверка кода...", "loading");

    try {
      if (isEmailFlow) {
        const updatedUser = await apiFetch("/users/me/email-change/confirm", {
          method: "POST",
          body: JSON.stringify({ email: nextValue, code })
        });
        applySidebarProfileUserUpdate(updatedUser);
        hideSidebarProfileEditor(factNode);
        setSidebarProfileStatus(factNode, "Email обновлён", "success");
      } else {
        const response = await apiFetch("/users/me/password-change/confirm", {
          method: "POST",
          body: JSON.stringify({ password: nextValue, code })
        });
        hideSidebarProfileEditor(factNode);
        setSidebarProfileStatus(factNode, response?.message || "Пароль изменён", "success");
      }

      window.setTimeout(() => {
        setSidebarProfileStatus(factNode, "");
      }, 1600);
    } catch (error) {
      setSidebarProfileStatus(factNode, error.message, "error");
      if (confirmButton) {
        confirmButton.disabled = false;
      }
    }
  });

  [valueInput, codeInput].forEach((input) => {
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        hideSidebarProfileEditor(factNode);
      }
    });
  });

  return {
    editor,
    focusTarget: valueInput
  };
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

  const valueNode = line.querySelector("strong, .sidebar-profile-secret");
  if (valueNode) {
    valueNode.dataset.profileLineItem = "true";
    valueNode.hidden = true;
  }
  if (button) {
    button.dataset.profileLineItem = "true";
    button.hidden = true;
  }

  if (config.workflow === "email-change" || config.workflow === "password-change") {
    const sensitiveEditor = createSidebarProfileSensitiveEditor(field, factNode);
    if (!sensitiveEditor) {
      return;
    }
    line.appendChild(sensitiveEditor.editor);
    focusSidebarProfileEditorControl(sensitiveEditor.focusTarget);
    return;
  }

  const editor = document.createElement("form");
  editor.className = "sidebar-profile-editor";
  const control = createSidebarProfileEditorControl(field, config, config.value(currentUser));

  const actions = document.createElement("div");
  actions.className = "sidebar-profile-editor-actions";
  actions.innerHTML = `
    <button class="sidebar-profile-editor-button cancel" type="button">Отмена</button>
    <button class="sidebar-profile-editor-button save" type="submit">Сохранить</button>
  `;

  editor.appendChild(control);
  editor.appendChild(actions);
  line.appendChild(editor);
  focusSidebarProfileEditorControl(control);

  actions.querySelector(".cancel")?.addEventListener("click", () => {
    hideSidebarProfileEditor(factNode);
  });

  const onSubmit = async () => {
    const nextValue = readSidebarProfileEditorValue(control);
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
  };

  control.addEventListener("input", () => {
    if (config.maxLength && control.matches('[contenteditable="true"]')) {
      const currentValue = control.textContent || "";
      if (currentValue.length > config.maxLength) {
        control.textContent = currentValue.slice(0, config.maxLength);
        focusSidebarProfileEditorControl(control);
      }
    }
    updateSidebarProfileEditorVisualState(control);
  });

  control.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      hideSidebarProfileEditor(factNode);
      return;
    }

    if (field === "bio") {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        void onSubmit();
      }
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      void onSubmit();
    }
  });

  editor.addEventListener("submit", async (event) => {
    event.preventDefault();
    await onSubmit();
  });
}

function setSidebarProfileOpen(sidebar, isOpen) {
  if (!sidebar) return;
  const profilePanel = sidebar.querySelector(".sidebar-panel-profile");
  const settingsPanel = sidebar.querySelector(".sidebar-panel-settings");
  sidebar.classList.toggle("profile-open", Boolean(isOpen));
  sidebar.classList.toggle("settings-open", false);
  if (profilePanel) {
    profilePanel.setAttribute("aria-hidden", isOpen ? "false" : "true");
  }
  if (settingsPanel) {
    settingsPanel.setAttribute("aria-hidden", "true");
  }
}

function setSidebarSettingsOpen(sidebar, isOpen) {
  if (!sidebar) return;
  const profilePanel = sidebar.querySelector(".sidebar-panel-profile");
  const settingsPanel = sidebar.querySelector(".sidebar-panel-settings");
  sidebar.classList.toggle("profile-open", Boolean(isOpen));
  sidebar.classList.toggle("settings-open", Boolean(isOpen));
  if (profilePanel) {
    profilePanel.setAttribute("aria-hidden", isOpen ? "true" : "false");
  }
  if (settingsPanel) {
    settingsPanel.setAttribute("aria-hidden", isOpen ? "false" : "true");
  }
}

function closeSidebarProfileMenu(menuTrigger, menu) {
  if (!menuTrigger || !menu) return;
  menuTrigger.setAttribute("aria-expanded", "false");
  menu.classList.remove("visible");
  window.setTimeout(() => {
    if (!menu.classList.contains("visible")) {
      menu.hidden = true;
    }
  }, 180);
}

function openSidebarProfileMenu(menuTrigger, menu) {
  if (!menuTrigger || !menu) return;
  menu.hidden = false;
  menuTrigger.setAttribute("aria-expanded", "true");
  requestAnimationFrame(() => {
    menu.classList.add("visible");
  });
}

function buildQuickActionsMenu() {
  const menu = document.createElement("div");
  menu.className = "quick-actions-menu";
  menu.hidden = true;
  menu.innerHTML = `
    <button class="quick-actions-menu-item" type="button" data-quick-action="search-user">${renderActionMenuItemContent("/assets/icons/ui/Chat_alt_add.svg", "Написать пользователю")}</button>
    <button class="quick-actions-menu-item" type="button" data-quick-action="create-server">${renderActionMenuItemContent("/assets/icons/ui/Folder.svg", "Создать сервер")}</button>
    <button class="quick-actions-menu-item" type="button" data-quick-action="create-group">${renderActionMenuItemContent("/assets/icons/ui/group.svg", "Создать группу")}</button>
  `;
  document.body.appendChild(menu);
  return menu;
}

function closeQuickActionsMenu(trigger, menu) {
  if (!menu) return;
  if (trigger) {
    trigger.setAttribute("aria-expanded", "false");
  }
  menu.classList.remove("visible");
  window.setTimeout(() => {
    if (!menu.classList.contains("visible")) {
      menu.hidden = true;
    }
  }, 160);
}

function openQuickActionsMenu(trigger, menu) {
  if (!trigger || !menu) return;
  menu.hidden = false;
  trigger.setAttribute("aria-expanded", "true");

  const rect = trigger.getBoundingClientRect();
  const menuWidth = Math.min(240, window.innerWidth - 24);
  const menuHeight = menu.offsetHeight || 164;
  const left = Math.max(12, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 12));
  const top = Math.max(12, Math.min(rect.bottom + 10, window.innerHeight - menuHeight - 12));

  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.style.width = `${menuWidth}px`;

  requestAnimationFrame(() => {
    menu.classList.add("visible");
  });
}

function buildServerStructureModal() {
  if (serverStructureModal) {
    return serverStructureModal;
  }

  const modal = document.createElement("div");
  modal.className = "server-structure-modal";
  modal.hidden = true;
  modal.innerHTML = `
    <div class="server-structure-backdrop" data-server-structure-close="true"></div>
    <div class="server-structure-card" role="dialog" aria-modal="true" aria-labelledby="serverStructureTitle">
      <div class="server-structure-header">
        <h3 id="serverStructureTitle">Создание</h3>
        <button class="icon-button server-structure-close" type="button" data-server-structure-close="true" aria-label="Закрыть">
          <img class="icon-asset" src="/assets/icons/ui/Close_round.svg" alt="">
        </button>
      </div>
      <form class="server-structure-form" id="serverStructureForm">
        <div id="serverStructureBody"></div>
        <div class="status" id="serverStructureStatus"></div>
        <div class="server-structure-actions">
          <button class="button button-secondary" type="button" data-server-structure-close="true">Отмена</button>
          <button class="button" id="serverStructureSubmit" type="submit">Создать</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(modal);
  serverStructureModal = modal;

  function getServerStructureChannelRoles() {
    const roles = sortServerRoles(Array.isArray(chatState.activeServer?.roles) ? chatState.activeServer.roles : []);
    return roles.map((role) => ({
      key: role.is_system ? String(role.name || "") : `role:${role.id}`,
      id: role.id,
      name: String(role.name || "role"),
      color: role.color || "#94A3B8",
      isSystem: Boolean(role.is_system),
      isOwner: String(role.name || "").toLowerCase() === "owner",
      isAdmin: String(role.name || "").toLowerCase() === "admin",
      isMember: String(role.name || "").toLowerCase() === "member"
    }));
  }

  function createServerStructureChannelRoleDefaults(type = "text") {
    const roles = getServerStructureChannelRoles();
    const isPrivate = type === "private";
    const isAnnouncements = type === "announcements";
    return roles.reduce((acc, role) => {
      if (role.isOwner) {
        acc[role.key] = Object.fromEntries(SERVER_CHANNEL_ROLE_PERMISSION_DEFINITIONS.map((permission) => [permission.id, true]));
        return acc;
      }
      if (role.isAdmin) {
        acc[role.key] = {
          view_channel: true,
          read_messages: true,
          send_messages: type !== "voice",
          send_files: type !== "voice",
          send_links: type !== "voice",
          manage_messages: true,
          manage_channel: true
        };
        return acc;
      }
      const base = {
        view_channel: !isPrivate,
        read_messages: !isPrivate,
        send_messages: !isPrivate && !isAnnouncements && type !== "voice",
        send_files: !isPrivate && type === "text",
        send_links: !isPrivate && type === "text",
        manage_messages: false,
        manage_channel: false
      };
      acc[role.key] = base;
      return acc;
    }, {});
  }

  function createServerStructureChannelAccess(type = "text") {
    const isPrivate = type === "private";
    const isAnnouncements = type === "announcements";
    return {
      view: isPrivate ? "selected_roles" : "everyone",
      write: isAnnouncements ? "moderators_admins" : (isPrivate ? "selected_roles" : "everyone"),
      files: isAnnouncements ? "moderators_admins" : (isPrivate ? "selected_roles" : "everyone"),
      links: isAnnouncements ? "moderators_admins" : (isPrivate ? "selected_roles" : "everyone"),
      everyone_mentions: isPrivate ? "admins" : "moderators_admins",
      selected_role_ids: isPrivate ? ["owner", "admin"] : []
    };
  }

  function createServerStructureChannelRestrictions(type = "text") {
    return {
      slowmode: "off",
      block_links: false,
      block_files: false,
      read_only: type === "announcements",
      block_everyone_mentions: false,
      block_new_members: false
    };
  }

  function normalizeServerStructureChannelState(channel = null) {
    const type = ["text", "voice", "announcements", "private"].includes(String(channel?.type || ""))
      ? String(channel.type)
      : "text";
    const roles = getServerStructureChannelRoles();
    const defaultRolePermissions = createServerStructureChannelRoleDefaults(type);
    const inputRolePermissions = channel?.role_permissions && typeof channel.role_permissions === "object"
      ? channel.role_permissions
      : {};
    const rolePermissions = {};
    roles.forEach((role) => {
      const current = inputRolePermissions[role.key] && typeof inputRolePermissions[role.key] === "object"
        ? inputRolePermissions[role.key]
        : {};
      rolePermissions[role.key] = SERVER_CHANNEL_ROLE_PERMISSION_DEFINITIONS.reduce((acc, permission) => {
        acc[permission.id] = role.isOwner
          ? true
          : Boolean(current[permission.id] ?? defaultRolePermissions[role.key]?.[permission.id]);
        return acc;
      }, {});
    });
    return {
      title: String(channel?.title || ""),
      description: String(channel?.description || ""),
      type,
      access: {
        ...createServerStructureChannelAccess(type),
        ...((channel?.access && typeof channel.access === "object") ? channel.access : {})
      },
      rolePermissions,
      rulesEnabled: Array.isArray(channel?.rules) ? channel.rules.length > 0 : true,
      rules: Array.isArray(channel?.rules) && channel.rules.length
        ? channel.rules.map((rule) => String(rule || ""))
        : ["Общайтесь по теме канала.", "Не публикуйте спам и вредоносные ссылки."],
      newRule: "",
      restrictions: {
        ...createServerStructureChannelRestrictions(type),
        ...((channel?.restrictions && typeof channel.restrictions === "object") ? channel.restrictions : {})
      },
      expandedRoleKey: roles[0]?.key || null
    };
  }

  function findActiveServerChannel(groupId) {
    const categories = Array.isArray(chatState.activeServer?.categories) ? chatState.activeServer.categories : [];
    for (const category of categories) {
      const channels = Array.isArray(category?.channels) ? category.channels : [];
      const match = channels.find((channel) => String(channel.id) === String(groupId));
      if (match) {
        return match;
      }
    }
    return null;
  }

  function getServerStructureAccessLabel(groupId, optionId) {
    return SERVER_CHANNEL_ACCESS_OPTIONS[groupId]?.find((item) => item.id === optionId)?.label || optionId;
  }

  function buildServerStructureChannelPreview(state) {
    const selectedRoles = getServerStructureChannelRoles()
      .filter((role) => (state.access.selected_role_ids || []).includes(role.key))
      .map((role) => role.name);
    const parts = [];
    if (state.type === "private") {
      parts.push(`Приватный канал. Доступ есть у ролей: ${selectedRoles.length ? selectedRoles.join(", ") : "owner, admin"}.`);
    } else {
      parts.push(`Канал виден: ${getServerStructureAccessLabel("view", state.access.view).toLowerCase()}.`);
    }
    parts.push(`Писать могут: ${getServerStructureAccessLabel("write", state.access.write).toLowerCase()}.`);
    if (state.restrictions.block_files || state.access.files === "nobody") {
      parts.push("Файлы запрещены.");
    }
    if (state.restrictions.slowmode && state.restrictions.slowmode !== "off") {
      parts.push(`Медленный режим: ${SERVER_CHANNEL_SLOWMODE_OPTIONS.find((item) => item.id === state.restrictions.slowmode)?.label || state.restrictions.slowmode}.`);
    }
    return parts.join(" ");
  }

  function renderServerStructureChoiceChips(groupId, currentValue) {
    return `
      <div class="server-structure-choice-list">
        ${SERVER_CHANNEL_ACCESS_OPTIONS[groupId].map((item) => `
          <button
            class="server-settings-choice-chip ${currentValue === item.id ? "is-active" : ""}"
            type="button"
            data-channel-access-field="${escapeHtml(groupId)}"
            data-channel-access-value="${escapeHtml(item.id)}"
          >${escapeHtml(item.label)}</button>
        `).join("")}
      </div>
    `;
  }

  function renderServerStructureChannelEditor() {
    const state = serverStructureEditorState || normalizeServerStructureChannelState();
    const roles = getServerStructureChannelRoles();
    const selectedRolesVisible = state.type === "private" || state.access.view === "selected_roles" || state.access.write === "selected_roles" || state.access.files === "selected_roles" || state.access.links === "selected_roles";
    return `
      <div class="server-channel-editor">
        <section class="server-channel-editor-section">
          <div class="server-channel-editor-head">
            <h4>Основное</h4>
            <p>Название, описание и тип канала.</p>
          </div>
          <label class="server-settings-field">
            <span class="label">Название канала</span>
            <input class="search-input" id="serverStructureName" type="text" maxlength="80" placeholder="Название канала" value="${escapeHtml(state.title)}" required>
          </label>
          <label class="server-settings-field">
            <span class="label">Описание канала</span>
            <textarea class="thread-group-edit-textarea server-structure-textarea" id="serverStructureDescription" rows="3" placeholder="Кратко опишите, для чего нужен этот канал">${escapeHtml(state.description)}</textarea>
          </label>
          <div class="server-structure-type-grid">
            ${SERVER_CHANNEL_TYPE_OPTIONS.map((option) => `
              <button
                class="server-structure-type-card ${state.type === option.id ? "is-active" : ""}"
                type="button"
                data-channel-type="${escapeHtml(option.id)}"
              >${escapeHtml(option.label)}</button>
            `).join("")}
          </div>
          ${state.type === "private" ? `
            <div class="server-settings-role-notice is-muted">
              <strong>Приватный канал видят только выбранные роли и участники с правом управления сервером.</strong>
            </div>
          ` : ""}
        </section>
        <section class="server-channel-editor-section">
          <div class="server-channel-editor-head">
            <h4>Доступ к каналу</h4>
            <p>Кто видит канал, пишет сообщения и использует вложения.</p>
          </div>
          <div class="server-channel-access-grid">
            <div class="server-structure-choice-group">
              <span class="label">Кто может видеть канал</span>
              ${renderServerStructureChoiceChips("view", state.access.view)}
            </div>
            <div class="server-structure-choice-group">
              <span class="label">Кто может писать в канал</span>
              ${renderServerStructureChoiceChips("write", state.access.write)}
            </div>
            <div class="server-structure-choice-group">
              <span class="label">Кто может отправлять файлы</span>
              ${renderServerStructureChoiceChips("files", state.access.files)}
            </div>
            <div class="server-structure-choice-group">
              <span class="label">Кто может отправлять ссылки</span>
              ${renderServerStructureChoiceChips("links", state.access.links)}
            </div>
            <div class="server-structure-choice-group">
              <span class="label">Кто может упоминать @everyone</span>
              ${renderServerStructureChoiceChips("everyone_mentions", state.access.everyone_mentions)}
            </div>
          </div>
          ${selectedRolesVisible ? `
            <div class="server-channel-role-select-box">
              <span class="label">Роли с доступом</span>
              <div class="server-channel-role-chip-row">
                ${roles.map((role) => `
                  <button
                    class="server-channel-role-chip ${(state.access.selected_role_ids || []).includes(role.key) ? "is-active" : ""}"
                    type="button"
                    data-channel-selected-role="${escapeHtml(role.key)}"
                    ${role.isOwner ? "disabled" : ""}
                  >
                    <span class="server-channel-role-chip-dot" style="background:${escapeHtml(role.color)}"></span>
                    <span>${escapeHtml(role.name)}</span>
                  </button>
                `).join("")}
              </div>
            </div>
          ` : ""}
        </section>
        <section class="server-channel-editor-section">
          <div class="server-channel-editor-head">
            <h4>Роли</h4>
            <p>Права ролей именно в этом канале.</p>
          </div>
          <div class="server-channel-role-editor-list">
            ${roles.map((role) => `
              <section class="server-channel-role-card ${state.expandedRoleKey === role.key ? "is-open" : ""}">
                <button class="server-channel-role-card-head" type="button" data-channel-role-expand="${escapeHtml(role.key)}">
                  <span class="server-channel-role-card-copy">
                    <span class="server-channel-role-chip-dot" style="background:${escapeHtml(role.color)}"></span>
                    <strong>${escapeHtml(role.name)}</strong>
                  </span>
                  <span class="server-channel-role-card-action">${state.expandedRoleKey === role.key ? "Скрыть" : "Настроить"}</span>
                </button>
                ${state.expandedRoleKey === role.key ? `
                  <div class="server-channel-role-card-body">
                    ${SERVER_CHANNEL_ROLE_PERMISSION_DEFINITIONS.map((permission) => `
                      <label class="server-settings-role-toggle-row">
                        <span class="server-settings-role-toggle-copy">
                          <strong>${escapeHtml(permission.label)}</strong>
                        </span>
                        <span class="settings-switch">
                          <input
                            type="checkbox"
                            data-channel-role-key="${escapeHtml(role.key)}"
                            data-channel-role-permission="${escapeHtml(permission.id)}"
                            ${state.rolePermissions?.[role.key]?.[permission.id] ? "checked" : ""}
                            ${role.isOwner ? "disabled" : ""}
                          >
                          <span class="settings-switch-ui"></span>
                        </span>
                      </label>
                    `).join("")}
                  </div>
                ` : ""}
              </section>
            `).join("")}
          </div>
        </section>
        <section class="server-channel-editor-section">
          <div class="server-channel-editor-head">
            <h4>Правила канала</h4>
            <p>Локальные правила, которые действуют только в этом канале.</p>
          </div>
          <label class="server-settings-role-toggle-row">
            <span class="server-settings-role-toggle-copy">
              <strong>Включить правила канала</strong>
              <span>Показывать отдельный список правил для этого канала.</span>
            </span>
            <span class="settings-switch">
              <input type="checkbox" data-channel-rules-enabled="true" ${state.rulesEnabled ? "checked" : ""}>
              <span class="settings-switch-ui"></span>
            </span>
          </label>
          ${state.rulesEnabled ? `
            <div class="server-channel-rule-compose">
              <input class="search-input" id="serverStructureRuleInput" type="text" placeholder="Добавьте новое правило" value="${escapeHtml(state.newRule || "")}">
              <button class="button button-secondary" type="button" data-channel-add-rule="true">Добавить правило</button>
            </div>
            <div class="server-channel-rule-list">
              ${state.rules.map((rule, index) => `
                <div class="server-channel-rule-item">
                  <input class="search-input" type="text" value="${escapeHtml(rule)}" data-channel-rule-index="${escapeHtml(String(index))}">
                  <button class="button button-secondary" type="button" data-channel-delete-rule="${escapeHtml(String(index))}">Удалить</button>
                </div>
              `).join("")}
            </div>
          ` : ""}
        </section>
        <section class="server-channel-editor-section">
          <div class="server-channel-editor-head">
            <h4>Ограничения</h4>
            <p>Медленный режим, запреты и режим только чтения.</p>
          </div>
          <label class="server-settings-field">
            <span class="label">Медленный режим</span>
            <select class="search-input" id="serverStructureSlowmode">
              ${SERVER_CHANNEL_SLOWMODE_OPTIONS.map((option) => `
                <option value="${escapeHtml(option.id)}" ${state.restrictions.slowmode === option.id ? "selected" : ""}>${escapeHtml(option.label)}</option>
              `).join("")}
            </select>
          </label>
          <div class="server-settings-role-switch-list">
            ${[
              ["block_links", "Запрет ссылок"],
              ["block_files", "Запрет файлов"],
              ["read_only", "Только чтение"],
              ["block_everyone_mentions", "Запрет упоминания @everyone"],
              ["block_new_members", "Запрет сообщений от новых участников"]
            ].map(([key, label]) => `
              <label class="server-settings-role-toggle-row">
                <span class="server-settings-role-toggle-copy">
                  <strong>${escapeHtml(label)}</strong>
                </span>
                <span class="settings-switch">
                  <input type="checkbox" data-channel-restriction="${escapeHtml(key)}" ${state.restrictions[key] ? "checked" : ""}>
                  <span class="settings-switch-ui"></span>
                </span>
              </label>
            `).join("")}
          </div>
        </section>
        <section class="server-channel-editor-section">
          <div class="server-channel-editor-head">
            <h4>Предпросмотр доступа</h4>
            <p>${escapeHtml(buildServerStructureChannelPreview(state))}</p>
          </div>
        </section>
      </div>
    `;
  }

  function renderServerStructureSimpleForm(mode, options = {}) {
    const descriptionVisible = mode === "server";
    return `
      <label class="label" for="serverStructureName">Название</label>
      <input class="search-input" id="serverStructureName" type="text" maxlength="80" value="${escapeHtml(options.initialTitle || "")}" required>
      <div class="server-structure-description-wrap" ${descriptionVisible ? "" : "hidden"}>
        <label class="label" for="serverStructureDescription">Описание</label>
        <textarea class="thread-group-edit-textarea" id="serverStructureDescription" rows="4" placeholder="Коротко о сервере">${escapeHtml(options.initialDescription || "")}</textarea>
      </div>
    `;
  }

  function renderServerStructureModalBody(options = {}) {
    const mode = serverStructureModal?.dataset?.mode || "";
    const bodyNode = serverStructureModal?.querySelector("#serverStructureBody");
    if (!bodyNode) {
      return;
    }
    bodyNode.innerHTML = mode === "channel" || mode === "channel-rename"
      ? renderServerStructureChannelEditor()
      : renderServerStructureSimpleForm(mode, options);
  }

  modal._renderBody = renderServerStructureModalBody;
  modal._findChannel = findActiveServerChannel;
  modal._normalizeChannelState = normalizeServerStructureChannelState;

  modal.addEventListener("click", (event) => {
    if (event.target.closest("[data-server-structure-close='true']")) {
      closeServerStructureModal();
      return;
    }
    if (serverStructureModal?.hidden) {
      return;
    }
    if ((modal.dataset.mode === "channel" || modal.dataset.mode === "channel-rename") && serverStructureEditorState) {
      const typeButton = event.target.closest("[data-channel-type]");
      if (typeButton) {
        serverStructureEditorState = normalizeServerStructureChannelState({
          ...serverStructureEditorState,
          type: String(typeButton.dataset.channelType || "text"),
          access: createServerStructureChannelAccess(String(typeButton.dataset.channelType || "text")),
          role_permissions: createServerStructureChannelRoleDefaults(String(typeButton.dataset.channelType || "text")),
          rules: serverStructureEditorState.rules,
          restrictions: {
            ...createServerStructureChannelRestrictions(String(typeButton.dataset.channelType || "text")),
            ...(serverStructureEditorState.restrictions || {})
          }
        });
        if (serverStructureEditorState.type === "private") {
          serverStructureEditorState.access.selected_role_ids = ["owner", "admin"];
          if (serverStructureEditorState.rolePermissions.member) {
            serverStructureEditorState.rolePermissions.member.view_channel = false;
            serverStructureEditorState.rolePermissions.member.read_messages = false;
          }
        }
        renderServerStructureModalBody();
        return;
      }
      const accessButton = event.target.closest("[data-channel-access-field]");
      if (accessButton) {
        const field = String(accessButton.dataset.channelAccessField || "");
        const value = String(accessButton.dataset.channelAccessValue || "");
        serverStructureEditorState.access[field] = value;
        renderServerStructureModalBody();
        return;
      }
      const selectedRoleButton = event.target.closest("[data-channel-selected-role]");
      if (selectedRoleButton) {
        const roleKey = String(selectedRoleButton.dataset.channelSelectedRole || "");
        const activeRoles = new Set(serverStructureEditorState.access.selected_role_ids || []);
        if (activeRoles.has(roleKey)) {
          activeRoles.delete(roleKey);
        } else {
          activeRoles.add(roleKey);
        }
        activeRoles.add("owner");
        if (serverStructureEditorState.type === "private") {
          activeRoles.add("admin");
        }
        serverStructureEditorState.access.selected_role_ids = [...activeRoles];
        renderServerStructureModalBody();
        return;
      }
      const expandRoleButton = event.target.closest("[data-channel-role-expand]");
      if (expandRoleButton) {
        const roleKey = String(expandRoleButton.dataset.channelRoleExpand || "");
        serverStructureEditorState.expandedRoleKey = serverStructureEditorState.expandedRoleKey === roleKey ? null : roleKey;
        renderServerStructureModalBody();
        return;
      }
      const addRuleButton = event.target.closest("[data-channel-add-rule='true']");
      if (addRuleButton) {
        const nextRule = String(serverStructureEditorState.newRule || "").trim();
        if (nextRule) {
          serverStructureEditorState.rules.push(nextRule);
          serverStructureEditorState.newRule = "";
          renderServerStructureModalBody();
        }
        return;
      }
      const deleteRuleButton = event.target.closest("[data-channel-delete-rule]");
      if (deleteRuleButton) {
        const index = Number(deleteRuleButton.dataset.channelDeleteRule || -1);
        if (index >= 0) {
          serverStructureEditorState.rules.splice(index, 1);
          renderServerStructureModalBody();
        }
      }
    }
  });

  modal.addEventListener("input", (event) => {
    if ((modal.dataset.mode !== "channel" && modal.dataset.mode !== "channel-rename") || !serverStructureEditorState) {
      return;
    }
    if (event.target.id === "serverStructureName") {
      serverStructureEditorState.title = String(event.target.value || "");
      return;
    }
    if (event.target.id === "serverStructureDescription") {
      serverStructureEditorState.description = String(event.target.value || "");
      return;
    }
    if (event.target.id === "serverStructureRuleInput") {
      serverStructureEditorState.newRule = String(event.target.value || "");
      return;
    }
    const ruleIndex = event.target.dataset?.channelRuleIndex;
    if (ruleIndex !== undefined) {
      serverStructureEditorState.rules[Number(ruleIndex)] = String(event.target.value || "");
    }
  });

  modal.addEventListener("change", (event) => {
    if ((modal.dataset.mode !== "channel" && modal.dataset.mode !== "channel-rename") || !serverStructureEditorState) {
      return;
    }
    const permissionRoleKey = event.target.dataset?.channelRoleKey;
    const permissionKey = event.target.dataset?.channelRolePermission;
    if (permissionRoleKey && permissionKey) {
      if (serverStructureEditorState.rolePermissions?.[permissionRoleKey]) {
        serverStructureEditorState.rolePermissions[permissionRoleKey][permissionKey] = Boolean(event.target.checked);
      }
      return;
    }
    const restrictionKey = event.target.dataset?.channelRestriction;
    if (restrictionKey) {
      serverStructureEditorState.restrictions[restrictionKey] = Boolean(event.target.checked);
      if (restrictionKey === "read_only" && event.target.checked) {
        serverStructureEditorState.access.write = "nobody";
      }
      renderServerStructureModalBody();
      return;
    }
    if (event.target.dataset?.channelRulesEnabled) {
      serverStructureEditorState.rulesEnabled = Boolean(event.target.checked);
      renderServerStructureModalBody();
      return;
    }
    if (event.target.id === "serverStructureSlowmode") {
      serverStructureEditorState.restrictions.slowmode = String(event.target.value || "off");
      renderServerStructureModalBody();
    }
  });

  modal.querySelector("#serverStructureForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const mode = modal.dataset.mode || "";
    const nameInput = modal.querySelector("#serverStructureName");
    const descriptionInput = modal.querySelector("#serverStructureDescription");
    const statusNode = modal.querySelector("#serverStructureStatus");
    const submitButton = modal.querySelector("#serverStructureSubmit");
    const title = nameInput?.value.trim() || "";
    const description = descriptionInput?.value.trim() || "";
    if (!title) {
      if (statusNode) {
        statusNode.textContent = "Название обязательно";
        statusNode.className = "status error";
      }
      return;
    }

    if (submitButton) {
      submitButton.disabled = true;
    }
    if (statusNode) {
      statusNode.textContent = "Сохраняем...";
      statusNode.className = "status";
    }

    try {
      if (mode === "server") {
        const data = await apiFetch("/servers", {
          method: "POST",
          body: JSON.stringify({
            title,
            description
          })
        });
        closeServerStructureModal();
        const serverId = data?.server_id || data?.server?.id;
        const groupId = data?.group_id || data?.server?.default_channel_id;
        if (serverId) {
          writeSelectedServerId(serverId);
          writeStoredSidebarView("server-detail");
        }
        if (serverId && groupId) {
          window.location.href = getServerChannelRoute(serverId, groupId);
          return;
        }
        if (serverId) {
          window.location.href = getServerRoute(serverId);
        }
        return;
      }

      if (mode === "category") {
        const serverId = modal.dataset.serverId;
        await apiFetch(`/servers/${encodeURIComponent(serverId)}/categories`, {
          method: "POST",
          body: JSON.stringify({ title })
        });
        closeServerStructureModal();
        await loadSidebar("chatList", { showLoading: false });
        return;
      }

      if (mode === "category-rename") {
        const serverId = modal.dataset.serverId;
        const categoryId = modal.dataset.categoryId;
        await apiFetch(`/servers/${encodeURIComponent(serverId)}/categories/${encodeURIComponent(categoryId)}`, {
          method: "PATCH",
          body: JSON.stringify({ title })
        });
        closeServerStructureModal();
        await loadSidebar("chatList", { showLoading: false });
        return;
      }

      if (mode === "channel") {
        const serverId = modal.dataset.serverId;
        const categoryId = modal.dataset.categoryId;
        const data = await apiFetch(`/servers/${encodeURIComponent(serverId)}/channels`, {
          method: "POST",
          body: JSON.stringify({
            title,
            description,
            type: serverStructureEditorState?.type || "text",
            access: serverStructureEditorState?.access || {},
            role_permissions: serverStructureEditorState?.rolePermissions || {},
            rules: serverStructureEditorState?.rulesEnabled ? (serverStructureEditorState?.rules || []) : [],
            restrictions: serverStructureEditorState?.restrictions || {},
            category_id: Number(categoryId)
          })
        });
        closeServerStructureModal();
        const groupId = data?.group_id || data?.id;
        if (serverId && groupId) {
          window.location.href = getServerChannelRoute(serverId, groupId);
          return;
        }
      }

      if (mode === "channel-rename") {
        const serverId = modal.dataset.serverId;
        const groupId = modal.dataset.groupId;
        const data = await apiFetch(`/servers/${encodeURIComponent(serverId)}/channels/${encodeURIComponent(groupId)}`, {
          method: "PATCH",
          body: JSON.stringify({
            title,
            description,
            type: serverStructureEditorState?.type || "text",
            access: serverStructureEditorState?.access || {},
            role_permissions: serverStructureEditorState?.rolePermissions || {},
            rules: serverStructureEditorState?.rulesEnabled ? (serverStructureEditorState?.rules || []) : [],
            restrictions: serverStructureEditorState?.restrictions || {},
          })
        });
        closeServerStructureModal();
        const nextGroupId = data?.group_id || groupId;
        await loadSidebar("chatList", { showLoading: false });
        const route = getCurrentRouteInfo();
        if (String(route.serverId || "") === String(serverId) && String(route.chatId || "") === String(groupId)) {
          window.location.replace(getServerChannelRoute(serverId, nextGroupId));
        }
        return;
      }
    } catch (error) {
      if (statusNode) {
        statusNode.textContent = error.message;
        statusNode.className = "status error";
      }
    } finally {
      if (submitButton) {
        submitButton.disabled = false;
      }
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && serverStructureModal && !serverStructureModal.hidden) {
      closeServerStructureModal();
    }
  });

  return modal;
}

function closeServerStructureModal() {
  if (!serverStructureModal) {
    return;
  }
  serverStructureEditorState = null;
  serverStructureModal.classList.remove("visible");
  window.setTimeout(() => {
    if (serverStructureModal && !serverStructureModal.classList.contains("visible")) {
      serverStructureModal.hidden = true;
    }
  }, 180);
}

function openServerStructureModal(mode, options = {}) {
  const modal = buildServerStructureModal();
  const titleNode = modal.querySelector("#serverStructureTitle");
  const statusNode = modal.querySelector("#serverStructureStatus");
  const submitButton = modal.querySelector("#serverStructureSubmit");
  const initialChannel = (mode === "channel-rename" && !options.channel && options.groupId)
    ? modal._findChannel?.(options.groupId)
    : options.channel || null;

  modal.dataset.mode = mode;
  modal.dataset.serverId = options.serverId ? String(options.serverId) : "";
  modal.dataset.categoryId = options.categoryId ? String(options.categoryId) : "";
  modal.dataset.groupId = options.groupId ? String(options.groupId) : "";
  modal.hidden = false;
  requestAnimationFrame(() => {
    modal.classList.add("visible");
  });

  if (titleNode) {
    titleNode.textContent = mode === "server"
      ? "Создать сервер"
      : mode === "category-rename"
        ? "Переименовать категорию"
        : mode === "channel-rename"
          ? "Настройки канала"
      : mode === "category"
        ? "Создать категорию"
        : "Создать канал";
  }
  if (submitButton) {
    submitButton.textContent = mode === "channel"
      ? "Создать канал"
      : mode === "category-rename" || mode === "channel-rename"
        ? "Сохранить"
        : "Создать";
    submitButton.disabled = false;
  }
  if (statusNode) {
    statusNode.textContent = "";
    statusNode.className = "status";
  }
  if (mode === "channel" || mode === "channel-rename") {
    serverStructureEditorState = modal._normalizeChannelState?.(initialChannel) || null;
    modal._renderBody?.(options);
    const nameInput = modal.querySelector("#serverStructureName");
    nameInput?.focus();
    return;
  }
  serverStructureEditorState = null;
  modal._renderBody?.({
    initialTitle: options.initialTitle || "",
    initialDescription: options.initialDescription || ""
  });
  const nameInput = modal.querySelector("#serverStructureName");
  const descriptionInput = modal.querySelector("#serverStructureDescription");
  if (nameInput) {
    nameInput.placeholder = mode === "server"
      ? "Например, Product Team"
      : mode === "category-rename"
        ? "Например, Разработка"
        : mode === "channel-rename"
          ? "Например, general"
          : mode === "category"
            ? "Например, Разработка"
            : "Например, general";
  }
  if (descriptionInput) {
    descriptionInput.value = options.initialDescription || "";
  }
  nameInput?.focus();
}

function getServerSettingsSections() {
  return [
    { id: "profile", label: "Профиль сервера" },
    { id: "members", label: "Участники" },
    { id: "roles", label: "Роли" },
    { id: "bans", label: "Баны" },
    { id: "access", label: "Доступ" }
  ];
}

function createServerInviteModalState(server = {}) {
  return {
    serverId: String(server?.id || ""),
    tab: "friends",
    friendQuery: "",
    contacts: [],
    contactsLoading: true,
    invitedFriendIds: new Set(),
    sentInviteKeys: new Set(),
    isCreating: false,
    isSending: false,
    status: "",
    statusType: "",
    generatedInvite: null,
    generatedInviteSettingsKey: "",
    settings: {
      expires_in: "24h",
      max_uses: "0",
      one_time: false,
      only_friends: false,
      require_approval: false
    }
  };
}

function getServerInviteSettingsKey(settings = {}) {
  return JSON.stringify({
    expires_in: String(settings.expires_in || "24h"),
    max_uses: String(settings.max_uses || "0"),
    one_time: Boolean(settings.one_time),
    only_friends: Boolean(settings.only_friends),
    require_approval: Boolean(settings.require_approval)
  });
}

function getFilteredServerInviteFriends() {
  const query = String(serverInviteModalState?.friendQuery || "").trim().toLowerCase();
  const contacts = Array.isArray(serverInviteModalState?.contacts) ? serverInviteModalState.contacts : [];
  if (!query) {
    return contacts;
  }
  return contacts.filter((friend) => (
    String(friend.contact_alias || friend.name || friend.username || "").toLowerCase().includes(query)
    || String(friend.name || friend.username || "").toLowerCase().includes(query)
    || String(friend.username || "").toLowerCase().includes(query)
  ));
}

function normalizeServerInviteContact(contact = {}) {
  const id = Number(contact?.id || 0);
  if (!id) {
    return null;
  }
  const title = String(contact?.contact_alias || contact?.name || contact?.username || "Контакт").trim();
  return {
    id,
    name: String(contact?.name || "").trim(),
    username: String(contact?.username || "").trim(),
    contact_alias: String(contact?.contact_alias || "").trim(),
    avatar_label: initials(title || "Контакт"),
    chat_id: contact?.chat_id ? Number(contact.chat_id) : null,
    is_contact: Boolean(contact?.is_contact ?? true)
  };
}

function renderServerInviteFriendsList(state = serverInviteModalState || {}) {
  const friends = getFilteredServerInviteFriends();
  if (state.contactsLoading && !friends.length) {
    return `
      <div class="server-settings-placeholder">
        <strong>Загружаем контакты...</strong>
        <span>Подготавливаем список ваших друзей и контактов.</span>
      </div>
    `;
  }
  if (!friends.length) {
    return `
      <div class="server-settings-placeholder">
        <strong>Контакты не найдены.</strong>
        <span>В реальном списке контактов пока нет пользователей для приглашения на этот сервер.</span>
      </div>
    `;
  }
  return friends.map((friend) => {
    const invited = state.invitedFriendIds?.has(friend.id);
    const title = String(friend.contact_alias || friend.name || friend.username || "Контакт");
    return `
      <div class="server-invite-friend-row">
        <div class="avatar small server-invite-friend-avatar">${escapeHtml(friend.avatar_label || initials(title))}</div>
        <div class="server-invite-friend-copy">
          <strong>${escapeHtml(title)}</strong>
          <span>${friend.username ? `@${escapeHtml(friend.username)}` : "Контакт"}</span>
        </div>
        <button class="button ${invited ? "button-secondary" : ""}" type="button" data-server-invite-friend="${escapeHtml(friend.id)}" ${invited ? "disabled" : ""}>
          ${invited ? "Приглашён" : "Пригласить"}
        </button>
      </div>
    `;
  }).join("");
}

function updateServerInviteFriendsView() {
  const friendsNode = serverInviteModal?.querySelector(".server-invite-friend-list");
  if (friendsNode) {
    friendsNode.innerHTML = renderServerInviteFriendsList(serverInviteModalState || {});
  }
}

async function loadServerInviteContacts() {
  if (!serverInviteModalState || !chatState.activeServer?.id) {
    return;
  }
  serverInviteModalState.contactsLoading = true;
  serverInviteModalState.contacts = [];
  serverInviteModalState.status = "";
  serverInviteModalState.statusType = "";
  const contentNode = serverInviteModal?.querySelector("[data-server-invite-content]");
  if (contentNode) {
    contentNode.innerHTML = renderServerInviteModalBody(chatState.activeServer || {});
  }
  try {
    const data = await apiFetch(`/servers/${encodeURIComponent(chatState.activeServer.id)}/invite-contacts`, { timeoutMs: 5000 });
    if (!serverInviteModalState) {
      return;
    }
    const apiContacts = (Array.isArray(data) ? data : data.items || [])
      .map((contact) => normalizeServerInviteContact(contact))
      .filter(Boolean);
    serverInviteModalState.contacts = apiContacts;
    serverInviteModalState.contactsLoading = false;
    updateServerInviteFriendsView();
  } catch (error) {
    if (!serverInviteModalState) {
      return;
    }
    serverInviteModalState.contacts = [];
    serverInviteModalState.contactsLoading = false;
    serverInviteModalState.status = error.message || "Не удалось загрузить контакты";
    serverInviteModalState.statusType = "error";
    updateServerInviteFriendsView();
  }
  if (contentNode) {
    contentNode.innerHTML = renderServerInviteModalBody(chatState.activeServer || {});
  }
}

async function ensureServerInviteLinkForModal() {
  if (!chatState.activeServer?.id || !serverInviteModalState) {
    throw new Error("Сервер недоступен");
  }
  const settingsKey = getServerInviteSettingsKey(serverInviteModalState.settings || {});
  if (
    serverInviteModalState.generatedInvite?.url
    && serverInviteModalState.generatedInviteSettingsKey === settingsKey
  ) {
    return serverInviteModalState.generatedInvite;
  }
  const payload = await apiFetch(`/servers/${encodeURIComponent(chatState.activeServer.id)}/invites`, {
    method: "POST",
    body: JSON.stringify(serverInviteModalState.settings)
  });
  serverInviteModalState.generatedInvite = payload?.invite || null;
  serverInviteModalState.generatedInviteSettingsKey = settingsKey;
  await refreshActiveServerInvites(chatState.activeServer.id);
  return serverInviteModalState.generatedInvite;
}

async function inviteContactToServer(contact = {}) {
  if (!contact?.id) {
    throw new Error("Контакт не найден");
  }
  const invite = await ensureServerInviteLinkForModal();
  if (!invite?.url) {
    throw new Error("Не удалось создать ссылку приглашения");
  }
  let chatId = Number(contact.chat_id || 0);
  if (!chatId) {
    const chatPayload = await apiFetch("/chats", {
      method: "POST",
      body: JSON.stringify({ user_id: Number(contact.id) })
    });
    chatId = Number(chatPayload?.id || 0);
  }
  if (!chatId) {
    throw new Error("Не удалось открыть чат с контактом");
  }
  const dedupeKey = `${chatId}::${invite.url}`;
  if (serverInviteModalState?.sentInviteKeys?.has(dedupeKey)) {
    throw new Error("Эта ссылка уже отправлена в этот чат");
  }
  await apiFetch(`/chats/${encodeURIComponent(chatId)}/messages`, {
    method: "POST",
    body: JSON.stringify({ text: invite.url })
  });
  serverInviteModalState?.sentInviteKeys?.add(dedupeKey);
  return { invite, chatId };
}

async function refreshActiveServerInvites(serverId) {
  const [serverPayload, sidebarPayload] = await Promise.all([
    apiFetch(`/servers/${encodeURIComponent(serverId)}`),
    loadSidebar("chatList", { showLoading: false })
  ]);
  chatState.activeServer = serverPayload;
  return sidebarPayload;
}

async function sendServerInviteToCurrentChat(inviteUrl) {
  const route = getCurrentRouteInfo();
  const text = String(inviteUrl || "").trim();
  if (!text) {
    throw new Error("Сначала создайте ссылку приглашения");
  }
  if (route.chatType === "group" && route.chatId) {
    await apiFetch(`/groups/${encodeURIComponent(route.chatId)}/messages`, {
      method: "POST",
      body: JSON.stringify({ text })
    });
    return;
  }
  if (route.chatType === "direct" && route.chatId) {
    await apiFetch(`/chats/${encodeURIComponent(route.chatId)}/messages`, {
      method: "POST",
      body: JSON.stringify({ text })
    });
    return;
  }
  throw new Error("Откройте чат или канал, куда нужно отправить приглашение");
}

function renderServerInviteModalBody(server = {}) {
  const state = serverInviteModalState || createServerInviteModalState(server);
  const activeInvites = Array.isArray(chatState.activeServer?.active_invites) ? chatState.activeServer.active_invites : [];
  const friends = getFilteredServerInviteFriends();
  const statusClass = state.statusType ? `status ${state.statusType}` : "status";
  return `
    <div class="server-invite-modal-layout">
      <header class="server-invite-modal-head">
        <div>
          <h2>Пригласить друзей на сервер</h2>
          <p>Отправьте приглашение другу или создайте ссылку для входа на сервер.</p>
        </div>
      </header>
      <div class="server-invite-tab-row">
        <button class="server-settings-choice-chip ${state.tab === "friends" ? "is-active" : ""}" type="button" data-server-invite-tab="friends">Друзья</button>
        <button class="server-settings-choice-chip ${state.tab === "link" ? "is-active" : ""}" type="button" data-server-invite-tab="link">Ссылка</button>
      </div>
      ${state.tab === "friends" ? `
        <section class="server-settings-section-card">
          <label class="server-settings-field">
            <span class="label">Поиск по друзьям</span>
            <input class="search-input" id="serverInviteFriendSearch" type="text" placeholder="Начните вводить имя" value="${escapeHtml(state.friendQuery || "")}">
          </label>
          <div class="server-invite-friend-list">
            ${renderServerInviteFriendsList(state)}
          </div>
        </section>
      ` : `
        <section class="server-settings-section-card">
          <div class="server-settings-role-form-grid">
            <label class="server-settings-field">
              <span class="label">Срок действия</span>
              <select class="search-input" id="serverInviteExpiresIn">
                ${SERVER_INVITE_EXPIRATION_OPTIONS.map((option) => `
                  <option value="${escapeHtml(option.id)}" ${state.settings.expires_in === option.id ? "selected" : ""}>${escapeHtml(option.label)}</option>
                `).join("")}
              </select>
            </label>
            <label class="server-settings-field">
              <span class="label">Лимит использований</span>
              <select class="search-input" id="serverInviteMaxUses">
                ${SERVER_INVITE_MAX_USES_OPTIONS.map((option) => `
                  <option value="${escapeHtml(option.id)}" ${state.settings.max_uses === option.id ? "selected" : ""}>${escapeHtml(option.label)}</option>
                `).join("")}
              </select>
            </label>
          </div>
          <div class="server-settings-role-switch-list">
            ${[
              ["one_time", "Сделать ссылку одноразовой"],
              ["only_friends", "Только для друзей"],
              ["require_approval", "Требовать подтверждение администратора"]
            ].map(([key, label]) => `
              <label class="server-settings-role-toggle-row">
                <span class="server-settings-role-toggle-copy">
                  <strong>${escapeHtml(label)}</strong>
                </span>
                <span class="settings-switch">
                  <input type="checkbox" data-server-invite-setting-toggle="${escapeHtml(key)}" ${state.settings[key] ? "checked" : ""}>
                  <span class="settings-switch-ui"></span>
                </span>
              </label>
            `).join("")}
          </div>
          <div class="server-settings-actions">
            <button class="button" type="button" data-server-invite-create="true" ${state.isCreating ? "disabled" : ""}>${state.isCreating ? "Создаём..." : "Создать ссылку"}</button>
          </div>
          ${state.generatedInvite?.url ? `
            <div class="server-invite-link-output">
              <label class="server-settings-field">
                <span class="label">Готовая ссылка</span>
                <input class="search-input" type="text" readonly value="${escapeHtml(state.generatedInvite.url)}">
              </label>
              <div class="server-settings-actions">
                <button class="button button-secondary" type="button" data-server-invite-copy="true">Скопировать</button>
                <button class="button" type="button" data-server-invite-send="true" ${state.isSending ? "disabled" : ""}>${state.isSending ? "Отправляем..." : "Отправить в чат"}</button>
              </div>
            </div>
          ` : ""}
        </section>
      `}
      <section class="server-settings-section-card">
        <header class="server-settings-content-head">
          <div>
            <h3>Активные приглашения</h3>
            <p>Список действующих ссылок для сервера ${escapeHtml(server?.title || "Сервер")}.</p>
          </div>
        </header>
        <div class="server-invite-active-list">
          ${activeInvites.length ? activeInvites.map((invite) => `
            <div class="server-invite-active-row">
              <div class="server-invite-active-copy">
                <strong>${escapeHtml(invite.code || "")}</strong>
                <span>${escapeHtml(`${invite.uses || 0}${invite.max_uses ? `/${invite.max_uses}` : ""} использований`)} · ${escapeHtml(invite.expires_at ? `до ${formatTimestamp(invite.expires_at)}` : "без срока")}</span>
              </div>
              <div class="server-invite-active-actions">
                <button class="button button-secondary" type="button" data-server-invite-copy-value="${escapeHtml(invite.url || "")}">Скопировать</button>
                <button class="button button-danger" type="button" data-server-invite-revoke="${escapeHtml(invite.code || "")}">Отозвать</button>
              </div>
            </div>
          `).join("") : `<div class="server-settings-placeholder"><strong>Активных приглашений пока нет.</strong><span>Создайте первую ссылку в соседней вкладке.</span></div>`}
        </div>
      </section>
      <div class="${statusClass}" id="serverInviteStatus">${escapeHtml(state.status || "")}</div>
    </div>
  `;
}

function renderServerSettingsProfileSection(server = {}) {
  const canLeaveServer = !isCurrentUserServerOwner(server);
  return `
    <section class="server-settings-section-card">
      <header class="server-settings-content-head">
        <div>
          <h2>Профиль сервера</h2>
          <p>Основные данные сервера и публичное описание.</p>
        </div>
      </header>
      <div class="server-settings-form-grid">
        <div class="server-settings-avatar-row">
          <div class="server-settings-avatar-preview">${escapeHtml(initials(server?.title || "Сервер"))}</div>
          <div class="server-settings-avatar-copy">
            <strong>Иконка сервера</strong>
            <span>Загрузка изображения будет подключена отдельно.</span>
          </div>
          <button class="button button-secondary server-settings-disabled-button" type="button" disabled>Загрузить изображение</button>
        </div>
        <label class="server-settings-field">
          <span class="label">Название сервера</span>
          <input class="search-input" id="serverSettingsTitleInput" type="text" maxlength="80" value="${escapeHtml(server?.title || "")}">
        </label>
        <label class="server-settings-field">
          <span class="label">Описание сервера</span>
          <textarea class="thread-group-edit-textarea server-settings-textarea" id="serverSettingsDescriptionInput" rows="5" placeholder="Опишите назначение сервера">${escapeHtml(server?.description || "")}</textarea>
        </label>
        <div class="server-settings-actions">
          <button class="button" type="button" data-server-settings-save-profile="true">Сохранить изменения</button>
          ${canLeaveServer ? `<button class="button button-danger" type="button" data-server-settings-leave-server="true">Выйти с сервера</button>` : ""}
        </div>
        <div class="status" id="serverSettingsProfileStatus"></div>
      </div>
    </section>
  `;
}

function isCurrentUserServerOwner(server = {}) {
  const currentUser = getCurrentUser() || {};
  const ownerId = String(server?.owner_id || "").trim();
  const currentUserId = String(currentUser.id || "").trim();
  const explicitOwnerFlag = server?.is_owner;

  if (explicitOwnerFlag === true || explicitOwnerFlag === 1 || explicitOwnerFlag === "1") {
    return true;
  }
  if (explicitOwnerFlag === false || explicitOwnerFlag === 0 || explicitOwnerFlag === "0") {
    return false;
  }
  return Boolean(ownerId && currentUserId && ownerId === currentUserId);
}

function renderServerSettingsMembersSection(server = {}) {
  return `
    <section class="server-settings-section-card">
      <header class="server-settings-content-head">
        <div>
          <h2>Участники</h2>
          <p>Список участников сервера и их текущий статус.</p>
        </div>
      </header>
      <div class="server-settings-members-table-wrap">
        <div class="server-settings-members-table">
          <div class="server-settings-members-row is-head">
            <div>Участник</div>
            <div>Роль</div>
            <div>Статус</div>
            <div>Действия</div>
          </div>
          <div class="server-settings-members-empty">
            <strong>Здесь будет список участников сервера.</strong>
            <span>Для таблицы участников нужен отдельный endpoint. Сервер: ${escapeHtml(server?.title || "Сервер")}.</span>
          </div>
        </div>
      </div>
    </section>
  `;
}

function getServerRoleSystemRank(role = {}) {
  const normalizedName = String(role?.name || "").trim().toLowerCase();
  if (normalizedName === "owner") return 0;
  if (normalizedName === "admin") return 1;
  if (normalizedName === "member") return 2;
  return 3;
}

function sortServerRoles(roles = []) {
  return [...roles].sort((left, right) => {
    const leftRank = getServerRoleSystemRank(left);
    const rightRank = getServerRoleSystemRank(right);
    if (leftRank !== rightRank) {
      return leftRank - rightRank;
    }
    if (leftRank < 3) {
      return (right.position || 0) - (left.position || 0);
    }
    const positionDiff = (right.position || 0) - (left.position || 0);
    if (positionDiff !== 0) {
      return positionDiff;
    }
    return String(left.name || "").localeCompare(String(right.name || ""), "ru");
  });
}

function normalizeServerRoleColor(value) {
  const normalizedValue = String(value || "").trim().toUpperCase();
  return /^#[0-9A-F]{6}$/.test(normalizedValue) ? normalizedValue : "#94A3B8";
}

function normalizeServerRolePermissions(role = {}) {
  const nextPermissions = { ...SERVER_ROLE_DEFAULT_PERMISSIONS };
  const rawPermissions = role?.permissions && typeof role.permissions === "object"
    ? role.permissions
    : {};
  Object.keys(nextPermissions).forEach((key) => {
    if (key in rawPermissions) {
      nextPermissions[key] = Boolean(rawPermissions[key]);
    }
  });
  if (String(role?.name || "").trim().toLowerCase() === "owner") {
    Object.keys(nextPermissions).forEach((key) => {
      nextPermissions[key] = true;
    });
  }
  if (nextPermissions.administrator) {
    Object.keys(nextPermissions).forEach((key) => {
      nextPermissions[key] = true;
    });
  }
  return nextPermissions;
}

function cloneServerRole(role = {}) {
  const normalizedName = String(role?.name || "").trim() || "Новая роль";
  const normalizedColor = normalizeServerRoleColor(role?.color);
  return {
    ...role,
    name: normalizedName,
    nameInput: String(role?.nameInput ?? normalizedName),
    color: normalizedColor,
    colorInput: String(role?.colorInput ?? normalizedColor),
    permissions: normalizeServerRolePermissions(role),
    is_system: Boolean(role?.is_system)
  };
}

function createServerSettingsRolesState(server = {}) {
  const roles = sortServerRoles(Array.isArray(server?.roles) ? server.roles : []).map(cloneServerRole);
  return {
    serverId: String(server?.id || ""),
    selectedRoleId: roles[0]?.id ? String(roles[0].id) : null,
    roles,
    status: "",
    statusType: "",
    isSaving: false
  };
}

function ensureServerSettingsRolesState(server = {}) {
  const serverId = String(server?.id || "");
  if (!serverSettingsRolesEditorState || serverSettingsRolesEditorState.serverId !== serverId) {
    serverSettingsRolesEditorState = createServerSettingsRolesState(server);
  }
  return serverSettingsRolesEditorState;
}

function getSelectedServerSettingsRole() {
  const state = serverSettingsRolesEditorState;
  if (!state?.selectedRoleId) {
    return null;
  }
  return state.roles.find((role) => String(role.id) === String(state.selectedRoleId)) || null;
}

function isOwnerServerRole(role = {}) {
  return String(role?.name || "").trim().toLowerCase() === "owner";
}

function isSystemServerRole(role = {}) {
  return Boolean(role?.is_system);
}

function canRenameServerRole(role = {}) {
  return !isSystemServerRole(role);
}

function canDeleteServerRole(role = {}) {
  return !isSystemServerRole(role);
}

function canMoveServerRole(role = {}) {
  return !isSystemServerRole(role);
}

function canEditServerRoleColor(role = {}) {
  return !isOwnerServerRole(role);
}

function getServerRoleListDescription(role = {}) {
  if (isOwnerServerRole(role)) {
    return "Владелец сервера";
  }
  return isSystemServerRole(role) ? "Системная роль" : "Пользовательская роль";
}

function getServerRoleDisplayName(role = {}) {
  return String(role?.name || "").trim() || "Новая роль";
}

function setServerSettingsRolesStatus(message = "", type = "", options = {}) {
  if (!serverSettingsRolesEditorState) {
    return;
  }
  serverSettingsRolesEditorState.status = message;
  serverSettingsRolesEditorState.statusType = type;
  if (options.isSaving !== undefined) {
    serverSettingsRolesEditorState.isSaving = Boolean(options.isSaving);
  }
}

function syncActiveServerRolesFromState() {
  if (!chatState.activeServer || !serverSettingsRolesEditorState) {
    return;
  }
  chatState.activeServer = {
    ...(chatState.activeServer || {}),
    roles: sortServerRoles(serverSettingsRolesEditorState.roles).map((role) => ({
      id: role.id,
      server_id: role.server_id,
      name: role.name,
      color: role.color,
      position: role.position,
      is_system: role.is_system,
      permissions: { ...(role.permissions || {}) },
      created_by: role.created_by,
      created_at: role.created_at
    }))
  };
}

function rerenderServerSettingsRolesSection(options = {}) {
  if (!serverSettingsModal || activeServerSettingsSection !== "roles") {
    return;
  }
  const preserveFocus = options.preserveFocus !== false;
  const activeElement = document.activeElement;
  const restoreSelector = activeElement?.dataset?.roleField
    ? `[data-role-field="${activeElement.dataset.roleField}"]`
    : null;
  const selectionStart = typeof activeElement?.selectionStart === "number" ? activeElement.selectionStart : null;
  const selectionEnd = typeof activeElement?.selectionEnd === "number" ? activeElement.selectionEnd : null;
  renderServerSettingsModal(chatState.activeServer || {});
  if (!preserveFocus || !restoreSelector) {
    return;
  }
  requestAnimationFrame(() => {
    const nextField = serverSettingsModal?.querySelector(restoreSelector);
    if (!nextField || typeof nextField.focus !== "function") {
      return;
    }
    nextField.focus();
    if (selectionStart !== null && selectionEnd !== null && typeof nextField.setSelectionRange === "function") {
      nextField.setSelectionRange(selectionStart, selectionEnd);
    }
  });
}

function renderServerSettingsRolesSection(server = {}) {
  const state = ensureServerSettingsRolesState(server);
  const roles = sortServerRoles(state.roles);
  const selectedRole = getSelectedServerSettingsRole();
  const statusClass = state.statusType ? `status ${state.statusType}` : "status";

  return `
    <section class="server-settings-section-card server-settings-roles-card">
      <header class="server-settings-content-head server-settings-roles-head">
        <div>
          <h2>Роли</h2>
          <p>Создавайте роли, настраивайте права и управляйте доступом участников сервера.</p>
        </div>
        <button class="button button-secondary" type="button" data-server-settings-create-role="true" ${state.isSaving ? "disabled" : ""}>Создать роль</button>
      </header>
      <div class="${statusClass}" id="serverSettingsRolesStatus">${escapeHtml(state.status || "")}</div>
      <div class="server-settings-roles-layout">
        <aside class="server-settings-roles-sidebar">
          <div class="server-settings-roles-list">
            ${roles.map((role, index) => {
              const roleId = String(role.id || "");
              const selected = String(state.selectedRoleId || "") === roleId;
              const moveUpDisabled = !canMoveServerRole(role) || roles.slice(0, index).every((item) => isSystemServerRole(item));
              const moveDownDisabled = !canMoveServerRole(role) || roles.slice(index + 1).every((item) => isSystemServerRole(item));
              return `
                <div class="server-settings-role-list-item ${selected ? "is-active" : ""}">
                  <button
                    class="server-settings-role-list-select"
                    type="button"
                    data-server-role-select="${escapeHtml(roleId)}"
                  >
                  <span class="server-settings-role-list-marker" style="background:${escapeHtml(role.color || "#94A3B8")}"></span>
                  <span class="server-settings-role-list-copy">
                    <span class="server-settings-role-list-title-row">
                      <strong>${escapeHtml(getServerRoleDisplayName(role))}</strong>
                      ${role.is_system ? `<span class="server-settings-role-badge">Системная роль</span>` : ""}
                    </span>
                    <span>${escapeHtml(getServerRoleListDescription(role))}</span>
                  </span>
                  </button>
                  <span class="server-settings-role-list-controls">
                    ${canMoveServerRole(role) ? `
                      <span class="server-settings-role-order-buttons">
                        <button class="server-settings-role-order-button ${moveUpDisabled ? "is-disabled" : ""}" type="button" data-server-role-move="up" data-server-role-id="${escapeHtml(roleId)}" ${moveUpDisabled || state.isSaving ? "disabled" : ""}>↑</button>
                        <button class="server-settings-role-order-button ${moveDownDisabled ? "is-disabled" : ""}" type="button" data-server-role-move="down" data-server-role-id="${escapeHtml(roleId)}" ${moveDownDisabled || state.isSaving ? "disabled" : ""}>↓</button>
                      </span>
                    ` : ""}
                  </span>
                </div>
              `;
            }).join("")}
          </div>
        </aside>
        <div class="server-settings-role-editor">
          ${selectedRole ? `
            <div class="server-settings-role-editor-scroll">
              <section class="server-settings-role-panel">
                <div class="server-settings-role-panel-head">
                  <div>
                    <h3>${escapeHtml(getServerRoleDisplayName(selectedRole))}</h3>
                    <p>Основные параметры роли, её отображение и базовый вид.</p>
                  </div>
                  ${selectedRole.is_system ? `<span class="server-settings-role-badge">Системная роль</span>` : ""}
                </div>
                ${isOwnerServerRole(selectedRole) ? `
                  <div class="server-settings-role-notice">
                    <strong>Роль владельца имеет все права и не может быть изменена.</strong>
                  </div>
                ` : isSystemServerRole(selectedRole) ? `
                  <div class="server-settings-role-notice is-muted">
                    <strong>Название системной роли закреплено, но права и отображение можно настраивать.</strong>
                  </div>
                ` : ""}
                <div class="server-settings-role-form-grid">
                  <label class="server-settings-field">
                    <span class="label">Название роли</span>
                    <input
                      class="search-input"
                      type="text"
                      maxlength="80"
                      value="${escapeHtml(selectedRole.nameInput || getServerRoleDisplayName(selectedRole))}"
                      data-role-field="name"
                      ${canRenameServerRole(selectedRole) ? "" : "disabled"}
                    >
                  </label>
                  <div class="server-settings-role-color-card">
                    <label class="server-settings-field">
                      <span class="label">Цвет роли</span>
                      <div class="server-settings-role-color-input-row">
                        <span class="server-settings-role-live-swatch" style="background:${escapeHtml(selectedRole.color || "#94A3B8")}"></span>
                        <input
                          class="search-input server-settings-role-color-input"
                          type="text"
                          maxlength="7"
                          value="${escapeHtml(selectedRole.colorInput || selectedRole.color || "#94A3B8")}"
                          data-role-field="color"
                          ${canEditServerRoleColor(selectedRole) ? "" : "disabled"}
                        >
                      </div>
                    </label>
                    <div class="server-settings-role-color-presets">
                      ${SERVER_ROLE_COLOR_PRESETS.map((color) => `
                        <button
                          class="server-settings-role-color-preset ${String(selectedRole.color || "").toUpperCase() === color ? "is-active" : ""}"
                          type="button"
                          data-server-role-color-preset="${escapeHtml(color)}"
                          aria-label="Выбрать цвет ${escapeHtml(color)}"
                          style="background:${escapeHtml(color)}"
                          ${canEditServerRoleColor(selectedRole) ? "" : "disabled"}
                        ></button>
                      `).join("")}
                    </div>
                  </div>
                </div>
                <div class="server-settings-role-preview-card">
                  <span class="server-settings-role-preview-label">Предпросмотр</span>
                  <div class="server-settings-role-preview-pill" style="--role-accent:${escapeHtml(selectedRole.color || "#94A3B8")}">
                    <span class="server-settings-role-preview-dot"></span>
                    <span>${escapeHtml(getServerRoleDisplayName(selectedRole))}</span>
                  </div>
                </div>
                <div class="server-settings-role-switch-list">
                  <label class="server-settings-role-toggle-row">
                    <span class="server-settings-role-toggle-copy">
                      <strong>Отображать участников с этой ролью отдельно</strong>
                      <span>Выводит участников с ролью в отдельной группе.</span>
                    </span>
                    <span class="settings-switch">
                      <input type="checkbox" data-role-field="display_separately" ${selectedRole.permissions?.display_separately ? "checked" : ""} ${isOwnerServerRole(selectedRole) ? "disabled" : ""}>
                      <span class="settings-switch-ui"></span>
                    </span>
                  </label>
                  <label class="server-settings-role-toggle-row">
                    <span class="server-settings-role-toggle-copy">
                      <strong>Разрешить упоминать эту роль</strong>
                      <span>Разрешает участникам упоминать роль в сообщениях.</span>
                    </span>
                    <span class="settings-switch">
                      <input type="checkbox" data-role-field="mentionable" ${selectedRole.permissions?.mentionable ? "checked" : ""} ${isOwnerServerRole(selectedRole) ? "disabled" : ""}>
                      <span class="settings-switch-ui"></span>
                    </span>
                  </label>
                </div>
              </section>
              <section class="server-settings-role-panel">
                <div class="server-settings-role-panel-head">
                  <div>
                    <h3>Права</h3>
                    <p>Разрешения сгруппированы по областям, как в редакторе ролей Discord.</p>
                  </div>
                </div>
                ${selectedRole.permissions?.administrator ? `
                  <div class="server-settings-role-warning">
                    <strong>Это право даёт полный доступ ко всем настройкам сервера.</strong>
                  </div>
                ` : ""}
                <div class="server-settings-role-permission-groups">
                  ${SERVER_ROLE_PERMISSION_GROUPS.map((group) => `
                    <section class="server-settings-role-permission-group">
                      <header>
                        <h4>${escapeHtml(group.title)}</h4>
                      </header>
                      <div class="server-settings-role-permission-list">
                        ${group.items.map((permission) => `
                          <label class="server-settings-role-toggle-row">
                            <span class="server-settings-role-toggle-copy">
                              <strong>${escapeHtml(permission.label)}</strong>
                              <span>${escapeHtml(permission.description)}</span>
                            </span>
                            <span class="settings-switch">
                              <input
                                type="checkbox"
                                data-role-permission-toggle="${escapeHtml(permission.id)}"
                                ${selectedRole.permissions?.[permission.id] ? "checked" : ""}
                                ${isOwnerServerRole(selectedRole) ? "disabled" : ""}
                              >
                              <span class="settings-switch-ui"></span>
                            </span>
                          </label>
                        `).join("")}
                      </div>
                    </section>
                  `).join("")}
                </div>
              </section>
              <div class="server-settings-role-editor-actions">
                ${canDeleteServerRole(selectedRole) ? `
                  <button class="button button-danger" type="button" data-server-settings-delete-role="${escapeHtml(String(selectedRole.id || ""))}" ${state.isSaving ? "disabled" : ""}>Удалить роль</button>
                ` : `<span class="server-settings-role-system-hint">Системные роли удалить нельзя.</span>`}
                <button class="button" type="button" data-server-settings-save-role="${escapeHtml(String(selectedRole.id || ""))}" ${isOwnerServerRole(selectedRole) || state.isSaving ? "disabled" : ""}>Сохранить изменения</button>
              </div>
            </div>
          ` : `
            <div class="server-settings-placeholder server-settings-role-empty-state">
              <strong>Выберите роль для редактирования.</strong>
              <span>Слева доступен список ролей сервера и порядок их приоритета.</span>
            </div>
          `}
        </div>
      </div>
    </section>
  `;
}

function renderServerSettingsBansSection() {
  return `
    <section class="server-settings-section-card">
      <header class="server-settings-content-head">
        <div>
          <h2>Баны</h2>
          <p>Пользователи, которым закрыт доступ к серверу.</p>
        </div>
      </header>
      <div class="server-settings-placeholder">
        <strong>Пока нет забаненных пользователей.</strong>
        <span>Когда появится API банов, список можно будет подключить без смены layout.</span>
      </div>
    </section>
  `;
}

function renderServerSettingsAccessSection(server = {}) {
  const activeInvites = Array.isArray(server?.active_invites) ? server.active_invites : [];
  const canInviteMembers = Boolean(server?.can_invite_members);
  return `
    <section class="server-settings-section-card">
      <header class="server-settings-content-head">
        <div>
          <h2>Доступ</h2>
          <p>Как пользователи могут попасть на сервер и какие правила действуют.</p>
        </div>
        <button class="button" type="button" data-server-open-invite-modal="true" ${canInviteMembers ? "" : "disabled"}>Пригласить друзей</button>
      </header>
      <div class="server-settings-access-grid">
        <div class="server-settings-choice-group">
          <span class="label">Как можно присоединиться к вашему серверу?</span>
          <div class="server-settings-choice-list">
            <button class="server-settings-choice-chip is-active" type="button">Только по приглашению</button>
            <button class="server-settings-choice-chip" type="button">По заявке</button>
            <button class="server-settings-choice-chip" type="button">Публичный</button>
          </div>
        </div>
        <div class="settings-item server-settings-inline-item">
          <div class="settings-copy">
            <strong>Сервер с возрастным ограничением</strong>
            <span>Отметьте, если сервер содержит контент 18+.</span>
          </div>
          <label class="settings-switch" aria-label="Сервер с возрастным ограничением">
            <input type="checkbox">
            <span class="settings-switch-ui"></span>
          </label>
        </div>
        <div class="settings-item server-settings-inline-item">
          <div class="settings-copy">
            <strong>Правила сервера</strong>
            <span>Добавьте базовые правила для участников сервера ${escapeHtml(server?.title || "")}.</span>
          </div>
          <label class="settings-switch" aria-label="Правила сервера">
            <input type="checkbox" checked>
            <span class="settings-switch-ui"></span>
          </label>
        </div>
        <div class="server-settings-rules-box">
          <label class="server-settings-field">
            <span class="label">Новое правило</span>
            <div class="server-settings-rule-input-row">
              <input class="search-input" type="text" placeholder="Введите правило" disabled>
              <button class="button button-secondary server-settings-disabled-button" type="button" disabled>Добавить</button>
            </div>
          </label>
          <div class="server-settings-rule-list">
            <div class="server-settings-rule-item">1. Уважайте участников сервера.</div>
            <div class="server-settings-rule-item">2. Не публикуйте спам и вредоносные ссылки.</div>
          </div>
        </div>
        <section class="server-settings-section-card server-settings-invite-list-card">
          <header class="server-settings-content-head">
            <div>
              <h3>Активные приглашения</h3>
              <p>Управляйте ссылками доступа к серверу.</p>
            </div>
          </header>
          <div class="server-invite-active-list">
            ${activeInvites.length ? activeInvites.map((invite) => `
              <div class="server-invite-active-row">
                <div class="server-invite-active-copy">
                  <strong>${escapeHtml(invite.code || "")}</strong>
                  <span>${escapeHtml(`${invite.uses || 0}${invite.max_uses ? `/${invite.max_uses}` : ""} использований`)} · ${escapeHtml(invite.expires_at ? `до ${formatTimestamp(invite.expires_at)}` : "без срока")}</span>
                </div>
                <div class="server-invite-active-actions">
                  <button class="button button-secondary" type="button" data-server-invite-copy-value="${escapeHtml(invite.url || "")}">Скопировать</button>
                  <button class="button button-danger" type="button" data-server-invite-revoke="${escapeHtml(invite.code || "")}" ${canInviteMembers ? "" : "disabled"}>Отозвать</button>
                </div>
              </div>
            `).join("") : `
              <div class="server-settings-placeholder">
                <strong>Активных приглашений нет.</strong>
                <span>${canInviteMembers ? "Создайте первую ссылку для входа на сервер." : "У вас нет права управлять приглашениями."}</span>
              </div>
            `}
          </div>
        </section>
      </div>
    </section>
  `;
}

function renderServerSettingsContent(server = {}, section = "profile") {
  if (section === "members") {
    return renderServerSettingsMembersSection(server);
  }
  if (section === "roles") {
    return renderServerSettingsRolesSection(server);
  }
  if (section === "bans") {
    return renderServerSettingsBansSection(server);
  }
  if (section === "access") {
    return renderServerSettingsAccessSection(server);
  }
  return renderServerSettingsProfileSection(server);
}

function renderServerSettingsModal(server = {}) {
  if (!serverSettingsModal) {
    return;
  }

  const navNode = serverSettingsModal.querySelector("[data-server-settings-nav]");
  const contentNode = serverSettingsModal.querySelector("[data-server-settings-content]");
  const captionNode = serverSettingsModal.querySelector("[data-server-settings-server-name]");

  if (captionNode) {
    captionNode.textContent = server?.title || "Сервер";
  }

  if (navNode) {
    navNode.innerHTML = getServerSettingsSections().map((section) => `
      <button
        class="server-settings-nav-item ${activeServerSettingsSection === section.id ? "is-active" : ""}"
        type="button"
        data-server-settings-section="${escapeHtml(section.id)}"
      >
        ${escapeHtml(section.label)}
      </button>
    `).join("");
  }

  if (contentNode) {
    contentNode.innerHTML = renderServerSettingsContent(server, activeServerSettingsSection);
  }
}

function closeServerSettingsModal() {
  if (!serverSettingsModal) {
    return;
  }
  serverSettingsModal.classList.remove("visible");
  window.setTimeout(() => {
    if (serverSettingsModal && !serverSettingsModal.classList.contains("visible")) {
      serverSettingsModal.hidden = true;
    }
  }, 180);
}

function openServerSettingsModal(section = "profile") {
  if (!chatState.activeServer) {
    showAppToast("Сначала откройте сервер", { type: "error" });
    return;
  }
  buildServerSettingsModal();
  activeServerSettingsSection = section;
  if (section === "roles") {
    serverSettingsRolesEditorState = createServerSettingsRolesState(chatState.activeServer);
  }
  renderServerSettingsModal(chatState.activeServer);
  serverSettingsModal.hidden = false;
  requestAnimationFrame(() => {
    serverSettingsModal?.classList.add("visible");
  });
}

function closeServerInviteModal() {
  if (!serverInviteModal) {
    return;
  }
  serverInviteModal.classList.remove("visible");
  window.setTimeout(() => {
    if (serverInviteModal && !serverInviteModal.classList.contains("visible")) {
      serverInviteModal.hidden = true;
    }
  }, 180);
}

async function openServerInviteModal() {
  return openServerInviteModalForServer(null);
}

async function resolveActiveServerContext(preferredServerId = null) {
  const route = getCurrentRouteInfo();
  const resolvedServerId = preferredServerId || chatState.activeServer?.id || route.serverId;
  if (!resolvedServerId) {
    throw new Error("Сначала откройте сервер");
  }

  let server = chatState.activeServer;
  const shouldRefreshServer =
    !server
    || String(server.id || "") !== String(resolvedServerId)
    || server.can_invite_members === undefined;

  if (shouldRefreshServer) {
    server = await apiFetch(`/servers/${encodeURIComponent(resolvedServerId)}`);
    chatState.activeServer = server;
  }

  if (!server?.id) {
    throw new Error("Сервер недоступен");
  }

  if (chatState.sidebarView === "server-detail") {
    setSidebarMode("server-detail", server);
  }

  return server;
}

function showServerInviteModal(server) {
  buildServerInviteModal();
  serverInviteModalState = createServerInviteModalState(server);
  const contentNode = serverInviteModal?.querySelector("[data-server-invite-content]");
  if (contentNode) {
    contentNode.innerHTML = renderServerInviteModalBody(server);
  }
  void loadServerInviteContacts();
  serverInviteModal.hidden = false;
  requestAnimationFrame(() => {
    serverInviteModal?.classList.add("visible");
  });
}

async function openServerInviteModalForServer(preferredServerId = null) {
  try {
    const server = await resolveActiveServerContext(preferredServerId);
    if (!server.can_invite_members) {
      showAppToast("У вас нет права создавать приглашения", { type: "error" });
      return;
    }
    showServerInviteModal(server);
  } catch (error) {
    showAppToast(error.message || "Не удалось открыть приглашение", { type: "error" });
  }
}

async function handleSidebarServerHeaderAction(action, options = {}) {
  const normalizedAction = String(action || "").trim();
  const route = getCurrentRouteInfo();
  const serverId = options.serverId || chatState.activeServer?.id || route.serverId;

  if (!normalizedAction) {
    return;
  }
  if (!serverId) {
    showAppToast("Сначала откройте сервер", { type: "error" });
    return;
  }

  if (normalizedAction === "invite") {
    await openServerInviteModalForServer(serverId);
    return;
  }

  if (normalizedAction === "settings") {
    openServerSettingsModal("profile");
    return;
  }

  if (normalizedAction === "leave") {
    await leaveServerById(serverId, {
      origin: "header-menu"
    });
    return;
  }

  if (normalizedAction === "create-category") {
    openServerStructureModal("category", {
      serverId
    });
    return;
  }

  if (normalizedAction === "create-channel") {
    const server = await resolveActiveServerContext(serverId);
    const firstCategoryId = Array.isArray(server?.categories) ? server.categories[0]?.id : null;
    if (!firstCategoryId) {
      showAppToast("Сначала создайте категорию", { type: "error", duration: 1900 });
      return;
    }
    openServerStructureModal("channel", {
      serverId,
      categoryId: firstCategoryId
    });
  }
}

function buildServerInviteModal() {
  if (serverInviteModal) {
    return serverInviteModal;
  }

  const modal = document.createElement("div");
  modal.className = "server-settings-modal server-invite-modal-shell";
  modal.hidden = true;
  modal.innerHTML = `
    <div class="server-settings-backdrop" data-server-invite-close="true"></div>
    <div class="server-settings-dialog server-invite-dialog" role="dialog" aria-modal="true" aria-labelledby="serverInviteHeading">
      <section class="server-settings-content-wrap server-invite-content-wrap">
        <h1 class="server-settings-shell-title" id="serverInviteHeading">Приглашение на сервер</h1>
        <button class="server-settings-close" type="button" data-server-invite-close="true" aria-label="Закрыть окно приглашения">
          <span class="server-settings-close-icon">×</span>
          <span class="server-settings-close-copy">ESC</span>
        </button>
        <div class="server-settings-content" data-server-invite-content></div>
      </section>
    </div>
  `;
  document.body.appendChild(modal);
  serverInviteModal = modal;

  const rerender = () => {
    const contentNode = serverInviteModal?.querySelector("[data-server-invite-content]");
    if (contentNode) {
      contentNode.innerHTML = renderServerInviteModalBody(chatState.activeServer || {});
    }
  };

  modal.addEventListener("click", (event) => {
    if (event.target.closest("[data-server-invite-close='true']")) {
      closeServerInviteModal();
      return;
    }
    const tabButton = event.target.closest("[data-server-invite-tab]");
    if (tabButton && serverInviteModalState) {
      serverInviteModalState.tab = String(tabButton.dataset.serverInviteTab || "friends");
      rerender();
      return;
    }
    const friendButton = event.target.closest("[data-server-invite-friend]");
    if (friendButton && serverInviteModalState) {
      const contactId = String(friendButton.dataset.serverInviteFriend || "");
      const contact = (serverInviteModalState.contacts || []).find((item) => String(item.id) === contactId);
      friendButton.disabled = true;
      friendButton.textContent = "Отправляем...";
      inviteContactToServer(contact).then(() => {
        serverInviteModalState.invitedFriendIds.add(contactId);
        serverInviteModalState.status = `Приглашение отправлено контакту ${contact?.contact_alias || contact?.name || contact?.username || ""}`.trim();
        serverInviteModalState.statusType = "success";
        rerender();
      }).catch((error) => {
        friendButton.disabled = false;
        friendButton.textContent = "Пригласить";
        serverInviteModalState.status = error.message || "Не удалось отправить приглашение";
        serverInviteModalState.statusType = "error";
        rerender();
      });
      return;
    }
    const createButton = event.target.closest("[data-server-invite-create='true']");
    if (createButton && chatState.activeServer?.id && serverInviteModalState) {
      serverInviteModalState.isCreating = true;
      serverInviteModalState.status = "Создаём ссылку...";
      serverInviteModalState.statusType = "";
      rerender();
      ensureServerInviteLinkForModal().then(async (invite) => {
        serverInviteModalState.generatedInvite = invite || null;
        serverInviteModalState.isCreating = false;
        serverInviteModalState.status = "Ссылка создана";
        serverInviteModalState.statusType = "success";
        rerender();
        if (activeServerSettingsSection === "access" && !serverSettingsModal?.hidden) {
          renderServerSettingsModal(chatState.activeServer || {});
        }
      }).catch((error) => {
        serverInviteModalState.isCreating = false;
        serverInviteModalState.status = error.message || "Не удалось создать ссылку";
        serverInviteModalState.statusType = "error";
        rerender();
      });
      return;
    }
    const copyButton = event.target.closest("[data-server-invite-copy='true'], [data-server-invite-copy-value]");
    if (copyButton) {
      const value = String(copyButton.dataset.serverInviteCopyValue || serverInviteModalState?.generatedInvite?.url || "").trim();
      if (!value) {
        showAppToast("Ссылка ещё не создана", { type: "error" });
        return;
      }
      navigator.clipboard.writeText(value).then(() => {
        if (serverInviteModalState) {
          serverInviteModalState.status = "Ссылка скопирована";
          serverInviteModalState.statusType = "success";
          rerender();
        }
      }).catch(() => {
        showAppToast("Не удалось скопировать ссылку", { type: "error" });
      });
      return;
    }
    const sendButton = event.target.closest("[data-server-invite-send='true']");
    if (sendButton && serverInviteModalState?.generatedInvite?.url) {
      serverInviteModalState.isSending = true;
      serverInviteModalState.status = "Отправляем ссылку...";
      serverInviteModalState.statusType = "";
      rerender();
      sendServerInviteToCurrentChat(serverInviteModalState.generatedInvite.url).then(() => {
        serverInviteModalState.isSending = false;
        serverInviteModalState.status = "Приглашение отправлено в чат";
        serverInviteModalState.statusType = "success";
        rerender();
      }).catch((error) => {
        serverInviteModalState.isSending = false;
        serverInviteModalState.status = error.message || "Не удалось отправить приглашение";
        serverInviteModalState.statusType = "error";
        rerender();
      });
      return;
    }
    const revokeButton = event.target.closest("[data-server-invite-revoke]");
    if (revokeButton && chatState.activeServer?.id) {
      const code = String(revokeButton.dataset.serverInviteRevoke || "");
      apiFetch(`/servers/${encodeURIComponent(chatState.activeServer.id)}/invites/${encodeURIComponent(code)}`, {
        method: "DELETE"
      }).then(async () => {
        await refreshActiveServerInvites(chatState.activeServer.id);
        if (serverInviteModalState) {
          serverInviteModalState.status = "Приглашение отозвано";
          serverInviteModalState.statusType = "success";
        }
        rerender();
        if (activeServerSettingsSection === "access" && !serverSettingsModal?.hidden) {
          renderServerSettingsModal(chatState.activeServer || {});
        }
      }).catch((error) => {
        if (serverInviteModalState) {
          serverInviteModalState.status = error.message || "Не удалось отозвать приглашение";
          serverInviteModalState.statusType = "error";
          rerender();
        }
      });
    }
  });

  modal.addEventListener("input", (event) => {
    if (!serverInviteModalState) {
      return;
    }
    if (event.target.id === "serverInviteFriendSearch") {
      serverInviteModalState.friendQuery = String(event.target.value || "");
      updateServerInviteFriendsView();
    }
  });

  modal.addEventListener("change", (event) => {
    if (!serverInviteModalState) {
      return;
    }
    let settingsChanged = false;
    if (event.target.id === "serverInviteExpiresIn") {
      serverInviteModalState.settings.expires_in = String(event.target.value || "24h");
      settingsChanged = true;
    }
    if (event.target.id === "serverInviteMaxUses") {
      serverInviteModalState.settings.max_uses = String(event.target.value || "0");
      settingsChanged = true;
    }
    const toggleKey = event.target.dataset?.serverInviteSettingToggle;
    if (toggleKey) {
      serverInviteModalState.settings[toggleKey] = Boolean(event.target.checked);
      settingsChanged = true;
    }
    if (settingsChanged) {
      serverInviteModalState.generatedInvite = null;
      serverInviteModalState.generatedInviteSettingsKey = "";
      serverInviteModalState.status = "";
      serverInviteModalState.statusType = "";
      rerender();
    }
  });

  return modal;
}

async function leaveServerById(serverId, options = {}) {
  const normalizedServerId = String(serverId || "").trim();
  if (!normalizedServerId) {
    showAppToast("Сначала откройте сервер", { type: "error" });
    return false;
  }

  const activeServer = chatState.activeServer && String(chatState.activeServer.id || "") === normalizedServerId
    ? chatState.activeServer
    : await resolveActiveServerContext(normalizedServerId);
  const serverTitle = activeServer?.title || "Сервер";
  const confirmed = await openUserRelationConfirmModal({
    title: "Выйти с сервера?",
    body: `Вы покинете сервер «${serverTitle}». Чтобы вернуться, потребуется новое приглашение.`,
    confirmText: "Выйти",
    danger: true
  });
  if (!confirmed) {
    return false;
  }

  const statusNode = options.statusNode || null;
  const triggerButton = options.triggerButton || null;
  if (triggerButton) {
    triggerButton.disabled = true;
  }
  if (statusNode) {
    statusNode.textContent = "Выходим с сервера...";
    statusNode.className = "status";
  }

  try {
    await apiFetch(`/servers/${encodeURIComponent(normalizedServerId)}/leave`, {
      method: "DELETE"
    });
    closeServerSettingsModal();
    closeSidebarServerHeaderMenu();
    chatState.activeServer = null;
    writeSelectedServerId(null);
    writeStoredSidebarView("chats");
    await loadSidebar("chatList", { showLoading: false });
    const route = getCurrentRouteInfo();
    if (String(route.serverId || "") === normalizedServerId) {
      window.location.href = getChatsRoute();
      return true;
    }
    showAppToast("Вы вышли с сервера");
    return true;
  } catch (error) {
    if (triggerButton) {
      triggerButton.disabled = false;
    }
    if (statusNode) {
      statusNode.textContent = error.message || "Не удалось выйти с сервера";
      statusNode.className = "status error";
      return false;
    }
    throw error;
  }
}

function buildServerSettingsModal() {
  if (serverSettingsModal) {
    return serverSettingsModal;
  }

  const modal = document.createElement("div");
  modal.className = "server-settings-modal";
  modal.hidden = true;
  modal.innerHTML = `
    <div class="server-settings-backdrop" data-server-settings-close="true"></div>
    <div class="server-settings-dialog" role="dialog" aria-modal="true" aria-labelledby="serverSettingsHeading">
      <aside class="server-settings-sidebar">
        <div class="server-settings-sidebar-caption">СЕРВЕР <span data-server-settings-server-name>Server</span></div>
        <div class="server-settings-sidebar-nav" data-server-settings-nav></div>
      </aside>
      <section class="server-settings-content-wrap">
        <h1 class="server-settings-shell-title" id="serverSettingsHeading">Настройки сервера</h1>
        <button class="server-settings-close" type="button" data-server-settings-close="true" aria-label="Закрыть настройки сервера">
          <span class="server-settings-close-icon">×</span>
          <span class="server-settings-close-copy">ESC</span>
        </button>
        <div class="server-settings-content" data-server-settings-content></div>
      </section>
    </div>
  `;
  document.body.appendChild(modal);
  serverSettingsModal = modal;

  modal.addEventListener("click", (event) => {
    if (event.target.closest("[data-server-settings-close='true']")) {
      closeServerSettingsModal();
      return;
    }

    const navButton = event.target.closest("[data-server-settings-section]");
    if (navButton) {
      activeServerSettingsSection = String(navButton.dataset.serverSettingsSection || "profile");
      if (activeServerSettingsSection === "roles") {
        serverSettingsRolesEditorState = createServerSettingsRolesState(chatState.activeServer || {});
      }
      renderServerSettingsModal(chatState.activeServer || {});
      return;
    }

    const openInviteButton = event.target.closest("[data-server-open-invite-modal='true']");
    if (openInviteButton) {
      openServerInviteModal();
      return;
    }

    const saveProfileButton = event.target.closest("[data-server-settings-save-profile='true']");
    if (saveProfileButton) {
      const titleInput = modal.querySelector("#serverSettingsTitleInput");
      const descriptionInput = modal.querySelector("#serverSettingsDescriptionInput");
      const statusNode = modal.querySelector("#serverSettingsProfileStatus");
      const nextTitle = String(titleInput?.value || "").trim();
      const nextDescription = String(descriptionInput?.value || "").trim();

      if (!nextTitle) {
        if (statusNode) {
          statusNode.textContent = "Название сервера обязательно";
          statusNode.className = "status error";
        }
        return;
      }

      chatState.activeServer = {
        ...(chatState.activeServer || {}),
        title: nextTitle,
        description: nextDescription
      };
      renderServerSettingsModal(chatState.activeServer);
      setSidebarMode(chatState.sidebarView, chatState.activeServer);
      if (statusNode) {
        statusNode.textContent = "Изменения сохранены локально. Серверный PATCH можно подключить следующим шагом.";
        statusNode.className = "status success";
      }
      showAppToast("Профиль сервера обновлён локально");
      return;
    }

    const leaveServerButton = event.target.closest("[data-server-settings-leave-server='true']");
    if (leaveServerButton && chatState.activeServer?.id) {
      void leaveServerById(chatState.activeServer.id, {
        statusNode: modal.querySelector("#serverSettingsProfileStatus"),
        triggerButton: leaveServerButton,
        origin: "server-settings"
      });
      return;
    }

    const createRoleButton = event.target.closest("[data-server-settings-create-role='true']");
    if (createRoleButton && chatState.activeServer?.id) {
      ensureServerSettingsRolesState(chatState.activeServer);
      setServerSettingsRolesStatus("Создаём роль...", "", { isSaving: true });
      rerenderServerSettingsRolesSection({ preserveFocus: false });
      apiFetch(`/servers/${encodeURIComponent(chatState.activeServer.id)}/roles`, {
        method: "POST",
        body: JSON.stringify({
          name: "Новая роль",
          color: "#94A3B8",
          permissions: { ...SERVER_ROLE_DEFAULT_PERMISSIONS }
        }),
      }).then((data) => {
        const newRole = data?.role;
        if (!newRole) {
          throw new Error("Не удалось создать роль");
        }
        serverSettingsRolesEditorState.roles = sortServerRoles([
          ...serverSettingsRolesEditorState.roles,
          cloneServerRole(newRole)
        ]);
        serverSettingsRolesEditorState.selectedRoleId = String(newRole.id);
        setServerSettingsRolesStatus("Роль создана", "success", { isSaving: false });
        syncActiveServerRolesFromState();
        rerenderServerSettingsRolesSection({ preserveFocus: false });
      }).catch((error) => {
        setServerSettingsRolesStatus(error.message || "Не удалось создать роль", "error", { isSaving: false });
        rerenderServerSettingsRolesSection({ preserveFocus: false });
      });
      return;
    }

    const selectRoleButton = event.target.closest("[data-server-role-select]");
    if (selectRoleButton) {
      ensureServerSettingsRolesState(chatState.activeServer || {});
      serverSettingsRolesEditorState.selectedRoleId = String(selectRoleButton.dataset.serverRoleSelect || "");
      rerenderServerSettingsRolesSection({ preserveFocus: false });
      return;
    }

    const colorPresetButton = event.target.closest("[data-server-role-color-preset]");
    if (colorPresetButton) {
      const selectedRole = getSelectedServerSettingsRole();
      if (!selectedRole || !canEditServerRoleColor(selectedRole)) {
        return;
      }
      selectedRole.color = normalizeServerRoleColor(colorPresetButton.dataset.serverRoleColorPreset || "#94A3B8");
      selectedRole.colorInput = selectedRole.color;
      rerenderServerSettingsRolesSection();
      return;
    }

    const moveRoleButton = event.target.closest("[data-server-role-move]");
    if (moveRoleButton && chatState.activeServer?.id) {
      ensureServerSettingsRolesState(chatState.activeServer);
      const roleId = String(moveRoleButton.dataset.serverRoleId || "");
      const direction = String(moveRoleButton.dataset.serverRoleMove || "");
      const orderedRoles = sortServerRoles(serverSettingsRolesEditorState.roles);
      const userRoles = orderedRoles.filter((role) => !role.is_system);
      const currentIndex = userRoles.findIndex((role) => String(role.id) === roleId);
      if (currentIndex === -1) {
        return;
      }
      const targetIndex = direction === "up" ? currentIndex - 1 : currentIndex + 1;
      if (targetIndex < 0 || targetIndex >= userRoles.length) {
        return;
      }
      const nextUserRoles = [...userRoles];
      [nextUserRoles[currentIndex], nextUserRoles[targetIndex]] = [nextUserRoles[targetIndex], nextUserRoles[currentIndex]];
      nextUserRoles.forEach((role, index) => {
        role.position = 90 - (index * 10);
      });
      setServerSettingsRolesStatus("Обновляем порядок ролей...", "", { isSaving: true });
      rerenderServerSettingsRolesSection({ preserveFocus: false });
      Promise.all(nextUserRoles.map((role) => apiFetch(
        `/servers/${encodeURIComponent(chatState.activeServer.id)}/roles/${encodeURIComponent(role.id)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ position: role.position })
        }
      ))).then((responses) => {
        const updatedRoles = responses
          .map((response) => cloneServerRole(response?.role))
          .filter(Boolean);
        const updatedRoleMap = new Map(updatedRoles.map((role) => [String(role.id), role]));
        serverSettingsRolesEditorState.roles = sortServerRoles(serverSettingsRolesEditorState.roles.map((role) => (
          updatedRoleMap.get(String(role.id)) || role
        )));
        setServerSettingsRolesStatus("Порядок ролей обновлён", "success", { isSaving: false });
        syncActiveServerRolesFromState();
        rerenderServerSettingsRolesSection({ preserveFocus: false });
      }).catch((error) => {
        setServerSettingsRolesStatus(error.message || "Не удалось изменить порядок ролей", "error", { isSaving: false });
        rerenderServerSettingsRolesSection({ preserveFocus: false });
      });
      return;
    }

    const deleteRoleButton = event.target.closest("[data-server-settings-delete-role]");
    if (deleteRoleButton && chatState.activeServer?.id) {
      const roleId = String(deleteRoleButton.dataset.serverSettingsDeleteRole || "");
      const role = ensureServerSettingsRolesState(chatState.activeServer).roles.find((item) => String(item.id) === roleId);
      if (!role || !canDeleteServerRole(role)) {
        return;
      }
      openUserRelationConfirmModal({
        title: "Удалить роль?",
        body: `Роль «${getServerRoleDisplayName(role)}» будет удалена без возможности восстановления.`,
        confirmText: "Удалить роль",
        danger: true
      }).then((confirmed) => {
        if (!confirmed) {
          return;
        }
        setServerSettingsRolesStatus("Удаляем роль...", "", { isSaving: true });
        rerenderServerSettingsRolesSection({ preserveFocus: false });
        apiFetch(`/servers/${encodeURIComponent(chatState.activeServer.id)}/roles/${encodeURIComponent(roleId)}`, {
          method: "DELETE",
        }).then(() => {
          const currentRoles = sortServerRoles(serverSettingsRolesEditorState.roles);
          const removedIndex = currentRoles.findIndex((item) => String(item.id) === roleId);
          serverSettingsRolesEditorState.roles = currentRoles.filter((item) => String(item.id) !== roleId);
          const fallbackRole = serverSettingsRolesEditorState.roles[removedIndex] || serverSettingsRolesEditorState.roles[removedIndex - 1] || serverSettingsRolesEditorState.roles[0] || null;
          serverSettingsRolesEditorState.selectedRoleId = fallbackRole ? String(fallbackRole.id) : null;
          setServerSettingsRolesStatus("Роль удалена", "success", { isSaving: false });
          syncActiveServerRolesFromState();
          rerenderServerSettingsRolesSection({ preserveFocus: false });
        }).catch((error) => {
          setServerSettingsRolesStatus(error.message || "Не удалось удалить роль", "error", { isSaving: false });
          rerenderServerSettingsRolesSection({ preserveFocus: false });
        });
      });
      return;
    }

    const saveRoleButton = event.target.closest("[data-server-settings-save-role]");
    if (saveRoleButton && chatState.activeServer?.id) {
      const selectedRole = getSelectedServerSettingsRole();
      if (!selectedRole || isOwnerServerRole(selectedRole)) {
        return;
      }
      setServerSettingsRolesStatus("Сохраняем роль...", "", { isSaving: true });
      rerenderServerSettingsRolesSection({ preserveFocus: false });
      apiFetch(`/servers/${encodeURIComponent(chatState.activeServer.id)}/roles/${encodeURIComponent(selectedRole.id)}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: getServerRoleDisplayName(selectedRole),
          color: selectedRole.color,
          permissions: normalizeServerRolePermissions(selectedRole)
        }),
      }).then((data) => {
        const updatedRole = data?.role;
        if (!updatedRole) {
          throw new Error("Не удалось обновить роль");
        }
        serverSettingsRolesEditorState.roles = sortServerRoles(serverSettingsRolesEditorState.roles.map((role) => (
          String(role.id) === String(updatedRole.id) ? cloneServerRole(updatedRole) : role
        )));
        serverSettingsRolesEditorState.selectedRoleId = String(updatedRole.id);
        setServerSettingsRolesStatus("Роль обновлена", "success", { isSaving: false });
        syncActiveServerRolesFromState();
        rerenderServerSettingsRolesSection({ preserveFocus: false });
      }).catch((error) => {
        setServerSettingsRolesStatus(error.message || "Не удалось обновить роль", "error", { isSaving: false });
        rerenderServerSettingsRolesSection({ preserveFocus: false });
      });
      return;
    }

    const orderButton = event.target.closest("[data-server-role-move]");
    if (orderButton) {
      event.preventDefault();
      return;
    }
  });

  modal.addEventListener("input", (event) => {
    if (activeServerSettingsSection !== "roles") {
      return;
    }
    const selectedRole = getSelectedServerSettingsRole();
    if (!selectedRole) {
      return;
    }
    const fieldName = event.target?.dataset?.roleField;
    if (fieldName === "name") {
      const nextNameInput = String(event.target.value || "").slice(0, 80);
      selectedRole.nameInput = nextNameInput;
      selectedRole.name = String(nextNameInput || "").trim() || "Новая роль";
      rerenderServerSettingsRolesSection();
      return;
    }
    if (fieldName === "color") {
      selectedRole.colorInput = String(event.target.value || "").toUpperCase().slice(0, 7);
      if (/^#[0-9A-F]{6}$/.test(selectedRole.colorInput)) {
        selectedRole.color = normalizeServerRoleColor(selectedRole.colorInput);
      }
      rerenderServerSettingsRolesSection();
    }
  });

  modal.addEventListener("change", (event) => {
    if (activeServerSettingsSection !== "roles") {
      return;
    }
    const selectedRole = getSelectedServerSettingsRole();
    if (!selectedRole) {
      return;
    }
    const fieldName = event.target?.dataset?.roleField;
    if (fieldName === "color") {
      selectedRole.colorInput = /^#[0-9A-F]{6}$/.test(String(selectedRole.colorInput || ""))
        ? selectedRole.colorInput
        : selectedRole.color;
      rerenderServerSettingsRolesSection({ preserveFocus: false });
      return;
    }
    if (fieldName === "display_separately" || fieldName === "mentionable") {
      selectedRole.permissions[fieldName] = Boolean(event.target.checked);
      rerenderServerSettingsRolesSection({ preserveFocus: false });
      return;
    }
    const permissionKey = event.target?.dataset?.rolePermissionToggle;
    if (!permissionKey) {
      return;
    }
    const isEnabled = Boolean(event.target.checked);
    if (permissionKey === "administrator") {
      Object.keys(selectedRole.permissions).forEach((key) => {
        selectedRole.permissions[key] = isEnabled;
      });
      rerenderServerSettingsRolesSection({ preserveFocus: false });
      return;
    }
    selectedRole.permissions[permissionKey] = isEnabled;
    if (!isEnabled && selectedRole.permissions.administrator) {
      selectedRole.permissions.administrator = false;
    }
    if (isEnabled) {
      const everyPermissionEnabled = SERVER_ROLE_PERMISSION_GROUPS
        .flatMap((group) => group.items.map((item) => item.id))
        .filter((permissionId) => permissionId !== "administrator")
        .every((permissionId) => selectedRole.permissions[permissionId]);
      if (everyPermissionEnabled) {
        selectedRole.permissions.administrator = true;
      }
    }
    rerenderServerSettingsRolesSection({ preserveFocus: false });
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && serverSettingsModal && !serverSettingsModal.hidden) {
      closeServerSettingsModal();
    }
  });

  return modal;
}

function buildServerSidebarActionMenu() {
  if (serverSidebarActionMenu) {
    return serverSidebarActionMenu;
  }

  const menu = document.createElement("div");
  menu.className = "chat-list-action-menu server-sidebar-action-menu";
  menu.hidden = true;
  document.body.appendChild(menu);
  serverSidebarActionMenu = menu;

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && serverSidebarActionMenu && !serverSidebarActionMenu.hidden) {
      hideServerSidebarActionMenu();
    }
  });
  window.addEventListener("resize", hideServerSidebarActionMenu);
  return menu;
}

function hideServerSidebarActionMenu() {
  if (!serverSidebarActionMenu) {
    return;
  }
  serverSidebarActionMenu.classList.remove("visible");
  window.setTimeout(() => {
    if (serverSidebarActionMenu && !serverSidebarActionMenu.classList.contains("visible")) {
      serverSidebarActionMenu.hidden = true;
    }
  }, 140);
}

function closeSidebarServerHeaderMenu() {
  const trigger = document.getElementById("sidebarServerMenuTrigger");
  const menu = document.getElementById("sidebarServerDropdown");
  if (!menu || !trigger) {
    return;
  }
  trigger.setAttribute("aria-expanded", "false");
  trigger.classList.remove("is-open");
  menu.classList.remove("visible");
  if (sidebarServerHeaderMenuHideTimer) {
    window.clearTimeout(sidebarServerHeaderMenuHideTimer);
  }
  sidebarServerHeaderMenuHideTimer = window.setTimeout(() => {
    if (!menu.classList.contains("visible")) {
      menu.hidden = true;
    }
    sidebarServerHeaderMenuHideTimer = null;
  }, 160);
}

function openSidebarServerHeaderMenu() {
  const trigger = document.getElementById("sidebarServerMenuTrigger");
  const menu = document.getElementById("sidebarServerDropdown");
  if (!menu || !trigger || trigger.disabled || chatState.sidebarView !== "server-detail") {
    return;
  }

  const canManageServer = Boolean(chatState.activeServer?.can_manage_server);
  const canInviteMembers = Boolean(chatState.activeServer?.can_invite_members);
  const isServerOwner = isCurrentUserServerOwner(chatState.activeServer || {});
  menu.querySelectorAll("[data-server-header-action]").forEach((button) => {
    const action = String(button.dataset.serverHeaderAction || "");
    button.hidden = false;
    button.style.display = "";
    let shouldDisable = false;
    if (action === "invite") {
      shouldDisable = !canInviteMembers;
    } else if (action === "leave") {
      button.hidden = isServerOwner;
      button.style.display = isServerOwner ? "none" : "";
      shouldDisable = false;
    } else {
      shouldDisable = !canManageServer;
    }
    button.disabled = shouldDisable;
  });

  if (sidebarServerHeaderMenuHideTimer) {
    window.clearTimeout(sidebarServerHeaderMenuHideTimer);
    sidebarServerHeaderMenuHideTimer = null;
  }
  menu.hidden = false;
  trigger.setAttribute("aria-expanded", "true");
  trigger.classList.add("is-open");
  requestAnimationFrame(() => {
    menu.classList.add("visible");
  });
}

function bindSidebarServerHeaderMenu() {
  const trigger = document.getElementById("sidebarServerMenuTrigger");
  const menu = document.getElementById("sidebarServerDropdown");
  if (!trigger || !menu || trigger.dataset.serverHeaderMenuBound === "true") {
    return;
  }

  trigger.dataset.serverHeaderMenuBound = "true";
  trigger.addEventListener("click", (event) => {
    if (chatState.sidebarView !== "server-detail" || trigger.disabled) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    if (menu.hidden) {
      openSidebarServerHeaderMenu();
      return;
    }
    closeSidebarServerHeaderMenu();
  });

  menu.addEventListener("click", async (event) => {
    const actionButton = event.target.closest("[data-server-header-action]");
    if (!actionButton || actionButton.disabled) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    const action = String(actionButton.dataset.serverHeaderAction || "");
    const route = getCurrentRouteInfo();
    const serverId = chatState.activeServer?.id || route.serverId;
    closeSidebarServerHeaderMenu();

    if (!serverId) {
      showAppToast("Сначала откройте сервер", { type: "error" });
      return;
    }

    try {
      await handleSidebarServerHeaderAction(action, { serverId });
    } catch (error) {
      showAppToast(error.message || "Не удалось выполнить действие", { type: "error" });
    }
  });

  document.addEventListener("click", (event) => {
    if (!event.target.closest("#sidebarServerMenuTrigger") && !event.target.closest("#sidebarServerDropdown")) {
      closeSidebarServerHeaderMenu();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && serverInviteModal && !serverInviteModal.hidden) {
      closeServerInviteModal();
      return;
    }
    if (event.key === "Escape" && !menu.hidden) {
      closeSidebarServerHeaderMenu();
    }
  });

  window.addEventListener("resize", closeSidebarServerHeaderMenu);
}

function showServerSidebarActionMenu(anchor, mode, payload = {}) {
  const menu = buildServerSidebarActionMenu();
  const serverId = payload.serverId ? String(payload.serverId) : "";
  const categoryId = payload.categoryId ? String(payload.categoryId) : "";
  const groupId = payload.groupId ? String(payload.groupId) : "";
  const targetTitle = String(payload.title || "").trim() || (mode === "category" ? "Категория" : "Канал");
  const targetLabel = mode === "category" ? "Категория" : "Канал";

  menu.dataset.mode = mode;
  menu.dataset.serverId = serverId;
  menu.dataset.categoryId = categoryId;
  menu.dataset.groupId = groupId;
  menu.dataset.title = payload.title || "";
  menu.innerHTML = `
    <div class="server-sidebar-action-menu-header">
      <div class="server-sidebar-action-menu-label">${escapeHtml(targetLabel)}</div>
      <div class="server-sidebar-action-menu-target">${escapeHtml(targetTitle)}</div>
    </div>
    <button type="button" data-server-sidebar-action="rename">${renderActionMenuItemContent("/assets/icons/ui/Edit_fill.svg", "Переименовать")}</button>
    <button type="button" data-server-sidebar-action="delete" class="danger">${renderActionMenuItemContent("/assets/icons/ui/Trash.svg", "Удалить")}</button>
  `;
  menu.hidden = false;
  const menuWidth = 200;
  const fallbackRect = anchor?.getBoundingClientRect ? anchor.getBoundingClientRect() : null;
  const pointX = Number(anchor?.clientX);
  const pointY = Number(anchor?.clientY);
  const left = Number.isFinite(pointX)
    ? Math.max(12, Math.min(pointX, window.innerWidth - menuWidth - 12))
    : Math.max(12, Math.min((fallbackRect?.right || 12) - menuWidth, window.innerWidth - menuWidth - 12));
  const top = Number.isFinite(pointY)
    ? Math.max(12, Math.min(pointY, window.innerHeight - 120))
    : Math.max(12, Math.min((fallbackRect?.bottom || 12) + 8, window.innerHeight - 120));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.style.width = `${menuWidth}px`;

  requestAnimationFrame(() => {
    menu.classList.add("visible");
  });
}

async function handleServerSidebarDeleteAction(mode, payload = {}) {
  const serverId = String(payload.serverId || "");
  const route = getCurrentRouteInfo();

  if (mode === "category") {
    const confirmed = await openUserRelationConfirmModal({
      title: "Удалить категорию",
      body: `Категория "${payload.title || "Категория"}" будет удалена вместе со всеми её каналами.`,
      confirmText: "Удалить",
      danger: true
    });
    if (!confirmed) {
      return;
    }
    const response = await apiFetch(`/servers/${encodeURIComponent(serverId)}/categories/${encodeURIComponent(payload.categoryId)}`, {
      method: "DELETE"
    });
    const deletedIds = new Set((response?.deleted_channel_ids || []).map((value) => String(value)));
    const refreshedServer = await loadSidebar("chatList", { showLoading: false });
    const nextChannelId = refreshedServer?.default_channel_id;
    if (deletedIds.has(String(route.chatId || ""))) {
      if (nextChannelId) {
        window.location.replace(getServerChannelRoute(serverId, nextChannelId));
      } else {
        window.location.replace(getServerRoute(serverId));
      }
    }
    return;
  }

  if (mode === "channel") {
    const confirmed = await openUserRelationConfirmModal({
      title: "Удалить канал",
      body: `Канал "${payload.title || "Канал"}" будет удалён вместе со всеми сообщениями.`,
      confirmText: "Удалить",
      danger: true
    });
    if (!confirmed) {
      return;
    }
    await apiFetch(`/servers/${encodeURIComponent(serverId)}/channels/${encodeURIComponent(payload.groupId)}`, {
      method: "DELETE"
    });
    const refreshedServer = await loadSidebar("chatList", { showLoading: false });
    const nextChannelId = refreshedServer?.default_channel_id;
    if (String(route.chatId || "") === String(payload.groupId || "")) {
      if (nextChannelId) {
        window.location.replace(getServerChannelRoute(serverId, nextChannelId));
      } else {
        window.location.replace(getServerRoute(serverId));
      }
    }
  }
}

function initQuickActionsMenu() {
  const triggers = [...document.querySelectorAll("[data-quick-actions-trigger='true']")];
  if (!triggers.length) {
    return;
  }

  let menu = document.querySelector(".quick-actions-menu");
  if (!menu) {
    menu = buildQuickActionsMenu();
  }

  let activeTrigger = null;

  const closeMenu = () => {
    closeQuickActionsMenu(activeTrigger, menu);
    activeTrigger = null;
  };

  const navigateForAction = (action) => {
    if (action === "search-user") {
      window.location.href = getSearchRoute();
      return;
    }
    if (action === "open-graph") {
      window.location.href = getGraphRoute();
      return;
    }
    if (action === "create-group") {
      window.location.href = getCreateGroupRoute();
      return;
    }
    if (action === "create-server") {
      openServerStructureModal("server");
    }
  };

  triggers.forEach((trigger) => {
    if (trigger.dataset.quickActionsBound === "true") {
      return;
    }

    trigger.dataset.quickActionsBound = "true";
    trigger.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();

      if (activeTrigger === trigger && !menu.hidden) {
        closeMenu();
        return;
      }

      if (activeTrigger && activeTrigger !== trigger) {
        activeTrigger.setAttribute("aria-expanded", "false");
      }

      activeTrigger = trigger;
      openQuickActionsMenu(trigger, menu);
    });
  });

  if (menu.dataset.quickActionsBound === "true") {
    return;
  }

  menu.dataset.quickActionsBound = "true";

  menu.addEventListener("click", (event) => {
    const action = event.target.closest("[data-quick-action]")?.dataset.quickAction;
    if (!action) {
      return;
    }
    closeMenu();
    navigateForAction(action);
  });

  document.addEventListener("click", (event) => {
    if (menu.hidden) {
      return;
    }
    if (event.target.closest(".quick-actions-menu") || event.target.closest("[data-quick-actions-trigger='true']")) {
      return;
    }
    closeMenu();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !menu.hidden) {
      closeMenu();
    }
  });

  window.addEventListener("resize", () => {
    if (!menu.hidden) {
      closeMenu();
    }
  });
}

function initSidebarProfile() {
  const sidebar = document.querySelector(".sidebar");
  const badge = document.getElementById("currentUserBadge");
  const backButton = document.getElementById("sidebarProfileBack");
  const emailButton = document.getElementById("sidebarProfileEmail");
  const usernameButton = document.getElementById("sidebarProfileHandle");
  const profileFacts = document.querySelector(".sidebar-profile-facts");
  const menuTrigger = document.getElementById("sidebarProfileMenuTrigger");
  const menu = document.getElementById("sidebarProfileMenu");
  const editActionButton = document.getElementById("sidebarProfileEditAction");
  const logoutButton = document.getElementById("sidebarProfileLogout");
  const settingsButton = document.getElementById("sidebarSettingsOpen");
  const settingsBackButton = document.getElementById("sidebarSettingsBack");
  const editButtons = document.querySelectorAll("[data-profile-edit]");

  fillSidebarProfile();
  buildProfileLogoutModal();
  initQuickActionsMenu();
  buildServerStructureModal();
  buildServerSettingsModal();
  buildServerSidebarActionMenu();
  initSettingsControls();
  void syncSidebarProfile();
  const route = getCurrentRouteInfo();

  if (!sidebar || !badge || !backButton || !menuTrigger || !menu || badge.dataset.profileBound === "true") {
    return;
  }

  badge.dataset.profileBound = "true";
  document.addEventListener("click", (event) => {
    const categoryToggle = event.target.closest("[data-server-category-toggle]");
    if (categoryToggle) {
      event.preventDefault();
      const serverId = categoryToggle.dataset.serverId;
      const categoryId = categoryToggle.dataset.serverCategoryToggle;
      const nextCollapsed = !isServerCategoryCollapsed(serverId, categoryId);
      setServerCategoryCollapsed(serverId, categoryId, nextCollapsed);
      const list = document.getElementById("chatList");
      if (list && chatState.activeServer) {
        renderServerSidebar(list, chatState.activeServer);
      }
      return;
    }

    const createCategoryTrigger = event.target.closest("[data-server-create-category]");
    if (createCategoryTrigger) {
      event.preventDefault();
      openServerStructureModal("category", {
        serverId: createCategoryTrigger.dataset.serverCreateCategory
      });
      return;
    }

    const createChannelTrigger = event.target.closest("[data-server-create-channel]");
    if (createChannelTrigger) {
      event.preventDefault();
      openServerStructureModal("channel", {
        serverId: createChannelTrigger.dataset.serverCreateChannel,
        categoryId: createChannelTrigger.dataset.serverCategoryId
      });
      return;
    }

    const serverSidebarAction = event.target.closest("[data-server-sidebar-action]");
    if (serverSidebarAction && serverSidebarActionMenu && !serverSidebarActionMenu.hidden) {
      event.preventDefault();
      const action = serverSidebarAction.dataset.serverSidebarAction;
      const mode = serverSidebarActionMenu.dataset.mode || "";
      const payload = {
        serverId: serverSidebarActionMenu.dataset.serverId,
        categoryId: serverSidebarActionMenu.dataset.categoryId,
        groupId: serverSidebarActionMenu.dataset.groupId,
        title: serverSidebarActionMenu.dataset.title || ""
      };
      hideServerSidebarActionMenu();
      if (action === "rename") {
        openServerStructureModal(mode === "category" ? "category-rename" : "channel-rename", {
          serverId: payload.serverId,
          categoryId: payload.categoryId,
          groupId: payload.groupId,
          initialTitle: payload.title
        });
        return;
      }
      if (action === "delete") {
        void handleServerSidebarDeleteAction(mode, payload);
        return;
      }
    }

    if (serverSidebarActionMenu && !serverSidebarActionMenu.hidden) {
      if (!event.target.closest(".server-sidebar-action-menu")) {
        hideServerSidebarActionMenu();
      }
    }
  });

  document.addEventListener("contextmenu", (event) => {
    if (!chatState.activeServer?.can_manage_server) {
      return;
    }
    const channelNode = event.target.closest("[data-server-channel-context]");
    if (channelNode) {
      event.preventDefault();
      showServerSidebarActionMenu({
        clientX: event.clientX,
        clientY: event.clientY
      }, "channel", {
        serverId: channelNode.dataset.serverId,
        groupId: channelNode.dataset.serverChannelContext,
        title: channelNode.dataset.serverChannelTitle || ""
      });
      return;
    }

    const categoryNode = event.target.closest("[data-server-category-context]");
    if (categoryNode) {
      event.preventDefault();
      showServerSidebarActionMenu({
        clientX: event.clientX,
        clientY: event.clientY
      }, "category", {
        serverId: categoryNode.dataset.serverId,
        categoryId: categoryNode.dataset.serverCategoryContext,
        title: categoryNode.dataset.serverCategoryTitle || ""
      });
    }
  });

  badge.addEventListener("click", () => {
    setSidebarProfileOpen(sidebar, true);
    setSidebarProfileEditMode(sidebar, false);
    closeSidebarProfileMenu(menuTrigger, menu);
    void syncSidebarProfile();
  });

  backButton.addEventListener("click", () => {
    if (route.page === "profile") {
      window.location.href = getChatsRoute();
      return;
    }
    setSidebarProfileOpen(sidebar, false);
    setSidebarProfileEditMode(sidebar, false);
    closeSidebarProfileMenu(menuTrigger, menu);
  });

  menuTrigger.addEventListener("click", (event) => {
    event.stopPropagation();
    if (menu.hidden) {
      openSidebarProfileMenu(menuTrigger, menu);
      return;
    }
    closeSidebarProfileMenu(menuTrigger, menu);
  });

  editActionButton?.addEventListener("click", () => {
    const nextState = !sidebar.classList.contains("profile-edit-mode");
    setSidebarProfileEditMode(sidebar, nextState);
    closeSidebarProfileMenu(menuTrigger, menu);
  });

  logoutButton?.addEventListener("click", () => {
    closeSidebarProfileMenu(menuTrigger, menu);
    openProfileLogoutModal();
  });

  settingsButton?.addEventListener("click", () => {
    closeSidebarProfileMenu(menuTrigger, menu);
    setSidebarSettingsOpen(sidebar, true);
  });

  settingsBackButton?.addEventListener("click", () => {
    setSidebarProfileOpen(sidebar, true);
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

  if (usernameButton && !usernameButton.dataset.copyBound) {
    usernameButton.dataset.copyBound = "true";
    usernameButton.addEventListener("click", async () => {
      const user = getCurrentUser();
      const usernameValue = String(user?.username || "").trim();
      if (!usernameValue) {
        return;
      }

      try {
        await navigator.clipboard.writeText(`@${usernameValue}`);
      } catch {
        // Silent fail to match lightweight sidebar interactions.
      }
    });
  }

  editButtons.forEach((button) => {
    button.addEventListener("click", () => {
      openSidebarProfileEditor(button.dataset.profileEdit);
    });
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !menu.hidden) {
      closeSidebarProfileMenu(menuTrigger, menu);
      return;
    }
    if (event.key === "Escape" && profileLogoutModal && !profileLogoutModal.hidden) {
      closeProfileLogoutModal();
      return;
    }
    if (event.key === "Escape" && sidebar.classList.contains("settings-open")) {
      setSidebarProfileOpen(sidebar, true);
      return;
    }
    if (event.key === "Escape" && sidebar.classList.contains("profile-open")) {
      setSidebarProfileOpen(sidebar, false);
      setSidebarProfileEditMode(sidebar, false);
    }
  });

  document.addEventListener("click", (event) => {
    if (menu.hidden) return;
    if (event.target.closest("#sidebarProfileMenu") || event.target.closest("#sidebarProfileMenuTrigger")) {
      return;
    }
    closeSidebarProfileMenu(menuTrigger, menu);
  });

  document.addEventListener("click", (event) => {
    if (!sidebar.classList.contains("profile-edit-mode")) {
      return;
    }
    if (event.target.closest(".sidebar-profile-facts")) {
      return;
    }
    if (event.target.closest("#sidebarProfileMenu") || event.target.closest("#sidebarProfileMenuTrigger")) {
      return;
    }
    if (profileFacts) {
      setSidebarProfileEditMode(sidebar, false);
    }
  });

  profileLogoutModal?.addEventListener("click", (event) => {
    if (event.target.closest("[data-profile-logout-close=\"true\"]")) {
      closeProfileLogoutModal();
    }
  });

  if (route.page === "profile") {
    setSidebarProfileOpen(sidebar, true);
    setSidebarProfileEditMode(sidebar, false);
  }
}

function getChatSearchQuery() {
  return document.querySelector(".sidebar-search .search-input")?.value.trim() || "";
}

function getVisibleChats() {
  return chatState.allChats.filter((chat) => (
    (chat?.type || "direct") !== "server"
    && !pendingDeletedChatKeys.has(getChatStateKey(chat.id, chat.type || "direct"))
  ));
}

function getVisibleServers() {
  return chatState.allServers.filter((server) => !pendingDeletedChatKeys.has(getChatStateKey(server.id, "server")));
}

function getChatFilterMode() {
  return chatState.sidebarView === "servers" || chatState.sidebarView === "server-detail" ? "servers" : activeChatTagFilter;
}

function getChatTagFilterOptions() {
  const tagMap = new Map();

  getVisibleChats().forEach((chat) => {
    const tag = getChatTag(chat.id, chat.type || "direct");
    if (!tag) {
      return;
    }

    const key = `${tag.label}::${tag.color}`;
    if (!tagMap.has(key)) {
      tagMap.set(key, {
        key,
        label: tag.label,
        color: tag.color
      });
    }
  });

  return [...tagMap.values()].sort((left, right) => left.label.localeCompare(right.label, "ru-RU"));
}

function isChatMatchingActiveTagFilter(chat) {
  if (chatState.sidebarView === "servers") {
    return false;
  }
  if (activeChatTagFilter === "all") {
    return true;
  }

  const tag = getChatTag(chat.id, chat.type || "direct");
  if (activeChatTagFilter === "untagged") {
    return !tag;
  }

  if (!tag || !activeChatTagFilter.startsWith("tag:")) {
    return false;
  }

  return `tag:${tag.label}::${tag.color}` === activeChatTagFilter;
}

function normalizeActiveChatTagFilter() {
  if (activeChatTagFilter === "all" || activeChatTagFilter === "untagged") {
    return;
  }

  const hasActiveTag = getChatTagFilterOptions().some((tag) => `tag:${tag.key}` === activeChatTagFilter);
  if (!hasActiveTag) {
    activeChatTagFilter = "all";
  }
}

function renderChatTagFilters(listId = "chatList") {
  const container = document.getElementById("chatTagFilters");
  if (!container) {
    return;
  }

  const tags = getChatTagFilterOptions();
  normalizeActiveChatTagFilter();
  container.dataset.listId = listId;
  const activeFilter = getChatFilterMode();
  container.innerHTML = [
    `
      <button
        type="button"
        class="chat-tag-filter-chip chat-tag-filter-chip-icon"
        data-chat-tag-filter="servers"
        aria-label="Серверы"
        title="Серверы"
      >
        <img class="icon-asset" src="/assets/icons/ui/Folder.svg" alt="">
      </button>
    `,
    '<button type="button" class="chat-tag-filter-chip" data-chat-tag-filter="all">Все</button>',
    '<button type="button" class="chat-tag-filter-chip" data-chat-tag-filter="untagged">Без тега</button>',
    ...tags.map((tag) => {
      const styleVars = getChatTagStyleVars(tag.color);
      return `
        <button
          type="button"
          class="chat-tag-filter-chip chat-tag-filter-chip-custom"
          data-chat-tag-filter="${escapeHtml(`tag:${tag.key}`)}"
          style="--chat-tag-bg: ${styleVars.background}; --chat-tag-border: ${styleVars.border}; --chat-tag-text: ${styleVars.text}; --chat-tag-solid: ${styleVars.solid};"
        >${escapeHtml(tag.label)}</button>
      `;
    })
  ].join("");

  container.querySelectorAll("[data-chat-tag-filter]").forEach((button) => {
    button.classList.toggle("active", button.dataset.chatTagFilter === activeFilter);
  });
}

function waitForSidebarSwipeTransition(element, expectedClassName, timeoutMs = 320) {
  return new Promise((resolve) => {
    if (!element) {
      resolve();
      return;
    }

    let resolved = false;
    const finish = () => {
      if (resolved) {
        return;
      }
      resolved = true;
      element.removeEventListener("transitionend", handleTransitionEnd);
      window.clearTimeout(timerId);
      resolve();
    };
    const handleTransitionEnd = (event) => {
      if (event.target !== element || !element.classList.contains(expectedClassName)) {
        return;
      }
      finish();
    };
    const timerId = window.setTimeout(finish, timeoutMs);
    element.addEventListener("transitionend", handleTransitionEnd);
  });
}

async function animateSidebarContentSwipe(direction, updateContent) {
  const run = async () => {
    const content = document.getElementById("sidebarMainContent");
    const prefersReducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    if (!content || prefersReducedMotion || !getAppSetting("animations")) {
      return updateContent();
    }

    const normalizedDirection = direction === "right" ? "right" : "left";
    content.dataset.swipeDirection = normalizedDirection;
    content.classList.remove("is-swiping-in", "is-ready");
    content.classList.add("is-swiping-out");
    await waitForSidebarSwipeTransition(content, "is-swiping-out", 260);

    await updateContent();

    content.classList.remove("is-swiping-out");
    content.classList.add("is-swiping-in");
    await new Promise((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)));
    content.classList.add("is-ready");
    await waitForSidebarSwipeTransition(content, "is-ready", 280);
    content.classList.remove("is-swiping-in", "is-ready");
    delete content.dataset.swipeDirection;
  };

  sidebarSwipeTransition = sidebarSwipeTransition
    .catch(() => {})
    .then(run);

  return sidebarSwipeTransition;
}

function bindChatTagFilters(listId = "chatList") {
  const container = document.getElementById("chatTagFilters");
  if (!container || container.dataset.chatTagFiltersBound === "true") {
    return;
  }

  container.dataset.chatTagFiltersBound = "true";
  let dragStartX = 0;
  let dragStartScrollLeft = 0;
  let isDragging = false;

  container.addEventListener("click", async (event) => {
    const trigger = event.target.closest("[data-chat-tag-filter]");
    if (!trigger) {
      return;
    }

    const nextFilter = trigger.dataset.chatTagFilter || "all";
    if (nextFilter === "servers") {
      writeStoredSidebarView("servers");
      await animateSidebarContentSwipe("left", async () => {
        await loadServers(container.dataset.listId || listId, { showLoading: false });
      });
      return;
    }

    activeChatTagFilter = nextFilter;
    const previousSidebarMode = chatState.sidebarView;
    const route = getCurrentRouteInfo();
    writeStoredSidebarView("chats");
    writeSelectedServerId(null);
    chatState.activeServer = null;
    setSidebarMode("chats");
    if (route.serverId || previousSidebarMode === "server-detail") {
      window.location.replace(getChatsRoute());
      return;
    }
    await loadChats(container.dataset.listId || listId, { showLoading: false, renderList: true });
  });

  container.addEventListener("wheel", (event) => {
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX) && event.deltaX === 0) {
      return;
    }
    if (container.scrollWidth <= container.clientWidth) {
      return;
    }

    event.preventDefault();
    const delta = Math.abs(event.deltaX) > 0 ? event.deltaX : event.deltaY;
    container.scrollLeft += delta;
  }, { passive: false });

  container.addEventListener("mousedown", (event) => {
    if (event.button !== 0 || container.scrollWidth <= container.clientWidth) {
      return;
    }

    isDragging = true;
    dragStartX = event.clientX;
    dragStartScrollLeft = container.scrollLeft;
    container.classList.add("is-dragging");
  });

  window.addEventListener("mousemove", (event) => {
    if (!isDragging) {
      return;
    }

    const deltaX = event.clientX - dragStartX;
    container.scrollLeft = dragStartScrollLeft - deltaX;
  });

  window.addEventListener("mouseup", () => {
    if (!isDragging) {
      return;
    }

    isDragging = false;
    container.classList.remove("is-dragging");
  });
}

function updateChatListView(listId = "chatList") {
  const list = document.getElementById(listId);
  if (!list) {
    return;
  }

  bindChatTagFilters(listId);
  renderChatTagFilters(listId);
  if (chatState.sidebarView === "servers") {
    renderServerList(list, getVisibleServers());
    return;
  }
  renderChats(list, filterChats(getChatSearchQuery()));
}

function renderChatListSkeleton(count = 8) {
  return `
    <div class="chat-list-skeleton" aria-hidden="true">
      ${Array.from({ length: count }, (_, index) => `
        <div class="chat-skeleton-item">
          <span class="chat-skeleton-avatar skeleton"></span>
          <div class="chat-skeleton-body">
            <span class="skeleton skeleton-text lg" style="width:${index % 3 === 0 ? 58 : index % 3 === 1 ? 72 : 64}%"></span>
            <span class="skeleton skeleton-text" style="width:${index % 2 === 0 ? 82 : 67}%"></span>
          </div>
          <div class="chat-skeleton-side">
            <span class="skeleton skeleton-text sm chat-skeleton-time"></span>
            <span class="chat-skeleton-badge skeleton"></span>
          </div>
        </div>
      `).join("")}
    </div>
  `;
}

function renderServerSidebarSkeleton() {
  return `
    <div class="chat-list-skeleton" aria-hidden="true">
      <div class="server-sidebar-shell">
        <div class="server-sidebar-head">
          <div class="server-sidebar-copy" style="width:100%">
            <span class="skeleton skeleton-text sm" style="width:24%"></span>
            <span class="skeleton skeleton-text lg" style="width:56%; margin-top:8px"></span>
            <span class="skeleton skeleton-text" style="width:72%; margin-top:8px"></span>
          </div>
          <span class="chat-skeleton-badge skeleton" style="width:42px; height:42px"></span>
        </div>
        <div class="server-category-card">
          <div class="server-category-head">
            <span class="skeleton skeleton-text" style="width:34%"></span>
            <span class="chat-skeleton-badge skeleton" style="width:38px; height:38px"></span>
          </div>
          <div class="server-channel-list">
            <div class="chat-skeleton-item" style="padding:10px 0">
              <span class="chat-skeleton-avatar skeleton" style="width:34px;height:34px"></span>
              <div class="chat-skeleton-body">
                <span class="skeleton skeleton-text" style="width:44%"></span>
                <span class="skeleton skeleton-text sm" style="width:68%"></span>
              </div>
            </div>
            <div class="chat-skeleton-item" style="padding:10px 0">
              <span class="chat-skeleton-avatar skeleton" style="width:34px;height:34px"></span>
              <div class="chat-skeleton-body">
                <span class="skeleton skeleton-text" style="width:52%"></span>
                <span class="skeleton skeleton-text sm" style="width:61%"></span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

function scheduleChatListRefresh(listId = "chatList", delayMs = 0) {
  if (chatListRefreshTimer) {
    window.clearTimeout(chatListRefreshTimer);
  }

  chatListRefreshTimer = window.setTimeout(() => {
    chatListRefreshTimer = null;
    loadSidebar(listId, { showLoading: false });
  }, Math.max(0, delayMs));
}

function initChatListRealtime(listId = "chatList") {
  chatListRealtimeBoundListId = listId;
  if (typeof io !== "function") {
    return;
  }

  if (chatListRealtimeSocket) {
    return;
  }

  chatListRealtimeSocket = io(API.baseUrl, {
    auth: {
      token: getToken()
    }
  });

  const refreshSidebar = () => {
    scheduleChatListRefresh(chatListRealtimeBoundListId || listId, 20);
  };

  chatListRealtimeSocket.on("chat_list_updated", refreshSidebar);
  chatListRealtimeSocket.on("chat_deleted", refreshSidebar);
  chatListRealtimeSocket.on("group_updated", refreshSidebar);
  chatListRealtimeSocket.on("group_members_updated", refreshSidebar);
  chatListRealtimeSocket.on("server_structure_updated", refreshSidebar);
  chatListRealtimeSocket.on("presence_updated", refreshSidebar);
  chatListRealtimeSocket.on("inbox_message", (payload) => {
    handleGlobalIncomingNotification(payload);
    refreshSidebar();
  });
}

async function loadChats(listId = "chatList", options = {}) {
  const { showLoading = true, renderList = true } = options;
  const list = document.getElementById(listId);
  if (!list) return [];

  if (renderList) {
    setSidebarMode("chats");
  }
  bindSidebarServerNavigation(listId);
  bindChatListScrollPersistence(listId);
  bindChatListActions(listId);
  initChatListRealtime(listId);

  if (showLoading && renderList) {
    list.innerHTML = renderChatListSkeleton();
  }

  try {
    const chats = await apiFetch("/chats");
    const normalizedChats = Array.isArray(chats) ? chats : chats.items || [];
    chatState.allChats = normalizedChats;
    syncUserRelationStateFromChats(normalizedChats);
    if (renderList) {
      writeStoredSidebarView("chats");
      setSidebarMode("chats");
    }
    bindChatSearch(listId);
    if (renderList) {
      updateChatListView(listId);
    }
    return normalizedChats;
  } catch (error) {
    if (showLoading && renderList) {
      list.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
      chatState.allChats = [];
      return [];
    }

    return chatState.allChats;
  }
}

function getServerSidebarPreviewText(lastMessage) {
  return getChatListPreviewText(lastMessage);
}

function getServerChannelIconPath(channel = {}) {
  const channelType = String(channel?.type || "text");
  if (channelType === "voice") return "/assets/icons/ui/Mic.svg";
  if (channelType === "announcements") return "/assets/icons/ui/notifications_on.svg";
  if (channelType === "private") return "/assets/icons/ui/Lable_fill.svg";
  return "/assets/icons/ui/comment.svg";
}

function getServerSidebarQuery() {
  return document.querySelector(".sidebar-search .search-input")?.value.trim().toLowerCase() || "";
}

function renderServerList(list, servers = []) {
  if (!list) {
    return;
  }

  const query = getServerSidebarQuery();
  const route = getCurrentRouteInfo();
  const selectedServerId = String(route.serverId || readSelectedServerId() || "");
  const filteredServers = !query
    ? servers
    : servers.filter((server) => {
      const haystack = [
        server?.title,
        server?.description,
        getServerSidebarPreviewText(server?.last_message)
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    });

  if (!filteredServers.length) {
    list.innerHTML = `
      <div class="server-list-shell">
        <div class="empty-state">
          ${query ? "Попробуйте изменить запрос" : "У вас пока нет серверов"}
        </div>
        ${query ? "" : '<button class="button" type="button" data-quick-action-server-create="true">Создать сервер</button>'}
      </div>
    `;
    return;
  }

  list.innerHTML = `
    <div class="server-list-shell">
      ${filteredServers.map((server) => {
        const unreadCount = Math.max(0, Number(server?.unread_count || 0));
        const unreadLabel = unreadCount > 99 ? "99+" : String(unreadCount);
        const active = String(server?.id || "") === selectedServerId;
        const preview = server?.description || getServerSidebarPreviewText(server?.last_message);
        const href = server?.default_channel_id
          ? getServerChannelRoute(server.id, server.default_channel_id)
          : getServerRoute(server.id);
        return `
          <a class="chat-item ${active ? "active" : ""}" href="${href}" data-server-open-id="${escapeHtml(String(server.id || ""))}" data-chat-id="${escapeHtml(String(server.id || ""))}" data-chat-type="server">
            <div class="avatar server-avatar">
              ${escapeHtml(initials(server?.title || "Сервер"))}
              <span class="chat-kind-badge chat-kind-badge-icon" aria-hidden="true"><img class="icon-asset" src="/assets/icons/ui/Folder.svg" alt=""></span>
            </div>
            <div class="chat-meta">
              <div class="chat-main">
                <div class="chat-title-row">
                  <h3 class="chat-name">${escapeHtml(server?.title || "Сервер")}</h3>
                </div>
                <p class="chat-preview">${escapeHtml(preview || "Нет активности")}</p>
              </div>
              <div class="chat-side${unreadCount > 0 ? " has-unread" : ""}">
                <span class="time">${escapeHtml(formatDate(server?.updated_at || server?.started_at))}</span>
                ${unreadCount > 0 ? `<span class="chat-unread-wrap"><span class="chat-unread-badge">${escapeHtml(unreadLabel)}</span></span>` : ""}
              </div>
            </div>
          </a>
        `;
      }).join("")}
    </div>
  `;
}

function renderServerSidebar(list, server) {
  if (!list) {
    return;
  }

  const route = getCurrentRouteInfo();
  const currentGroupId = String(route.chatId || "");
  const query = getServerSidebarQuery();
  const categories = Array.isArray(server?.categories) ? server.categories : [];
  const filteredCategories = categories
    .map((category) => {
      const normalizedCategoryTitle = String(category?.title || "").toLowerCase();
      const channels = Array.isArray(category?.channels) ? category.channels : [];
      const filteredChannels = !query
        ? channels
        : channels.filter((channel) => {
          const preview = getServerSidebarPreviewText(channel.last_message);
          return [
            channel?.title,
            preview,
            category?.title
          ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase()
            .includes(query);
        });
      if (query && !filteredChannels.length && !normalizedCategoryTitle.includes(query)) {
        return null;
      }
      return {
        ...category,
        channels: filteredChannels,
        isCollapsed: query ? false : isServerCategoryCollapsed(server?.id, category?.id)
      };
    })
    .filter(Boolean);

  if (!categories.length) {
    list.innerHTML = `
      <div class="server-sidebar-shell">
        <div class="empty-state">${server?.can_manage_server ? "В этом сервере пока нет категорий. Создайте первую." : "В этом сервере пока нет категорий."}</div>
      </div>
    `;
    return;
  }

  if (!filteredCategories.length) {
    list.innerHTML = `
      <div class="server-sidebar-shell">
        <div class="empty-state">Ничего не найдено</div>
      </div>
    `;
    return;
  }

  list.innerHTML = `
    <div class="server-sidebar-shell">
      <div class="server-category-list">
        ${filteredCategories.map((category) => `
          <section
            class="server-category-card ${category.isCollapsed ? "is-collapsed" : ""}"
            data-server-category-context="${escapeHtml(String(category.id || ""))}"
            data-server-id="${escapeHtml(String(server.id || ""))}"
            data-server-category-title="${escapeHtml(category.title || "")}"
          >
            <header class="server-category-head">
              <button
                class="server-category-toggle"
                type="button"
                data-server-category-toggle="${escapeHtml(String(category.id || ""))}"
                data-server-id="${escapeHtml(String(server.id || ""))}"
                aria-expanded="${category.isCollapsed ? "false" : "true"}"
              >
                <img class="icon-asset server-category-chevron" src="${category.isCollapsed ? "/assets/icons/ui/Expand_right.svg" : "/assets/icons/ui/Expand_down.svg"}" alt="">
                <h4 class="server-category-title">${escapeHtml(category.title || "Категория")}</h4>
              </button>
              ${server?.can_manage_server ? `
                <div class="server-category-actions">
                  <button class="icon-button server-category-action" type="button" data-server-create-channel="${escapeHtml(String(server.id || ""))}" data-server-category-id="${escapeHtml(String(category.id || ""))}" aria-label="Создать канал">
                    <img class="icon-asset" src="/assets/icons/ui/Add_round.svg" alt="">
                  </button>
                </div>
              ` : ""}
            </header>
            <div class="server-channel-list" ${category.isCollapsed ? 'hidden' : ''}>
              ${(Array.isArray(category.channels) ? category.channels : []).map((channel) => {
                const unreadCount = Math.max(0, Number(channel?.unread_count || 0));
                const unreadLabel = unreadCount > 99 ? "99+" : String(unreadCount);
                const previewText = channel?.description || getServerSidebarPreviewText(channel.last_message);
                return `
                  <div
                    class="server-channel-row ${String(channel?.id || "") === currentGroupId ? "active" : ""}"
                    data-server-channel-context="${escapeHtml(String(channel.id || ""))}"
                    data-server-id="${escapeHtml(String(server.id || ""))}"
                    data-server-channel-title="${escapeHtml(channel.title || "")}"
                  >
                    <a
                      class="server-channel-item ${String(channel?.id || "") === currentGroupId ? "active" : ""}"
                      href="${getServerChannelRoute(server.id, channel.id)}"
                      data-chat-id="${escapeHtml(String(channel.id || ""))}"
                      data-chat-type="group"
                    >
                      <span class="server-channel-icon" aria-hidden="true">
                        <img class="icon-asset" src="${getServerChannelIconPath(channel)}" alt="">
                      </span>
                      <span class="server-channel-copy">
                        <strong class="server-channel-name">${escapeHtml(channel.title || "channel")}</strong>
                        <span class="server-channel-preview">${escapeHtml(previewText || "Канал сервера")}</span>
                      </span>
                      ${unreadCount > 0 ? `<span class="chat-unread-badge">${escapeHtml(unreadLabel)}</span>` : ""}
                    </a>
                  </div>
                `;
              }).join("") || '<div class="empty-state compact">Каналов пока нет</div>'}
            </div>
          </section>
        `).join("")}
      </div>
    </div>
  `;
}

function renderServerDetail(list, server) {
  renderServerSidebar(list, server);
}

async function loadServerDetail(serverId, listId = "chatList", options = {}) {
  const { showLoading = true } = options;
  const list = document.getElementById(listId);
  if (!list || !serverId) {
    return null;
  }

  bindChatTagFilters(listId);
  if (chatState.activeServer && String(chatState.activeServer.id || "") === String(serverId)) {
    setSidebarMode("server-detail", chatState.activeServer);
  }
  if (showLoading) {
    list.innerHTML = renderServerSidebarSkeleton();
  }

  try {
    const server = await apiFetch(`/servers/${encodeURIComponent(serverId)}`);
    chatState.activeServer = server;
    writeSelectedServerId(serverId);
    writeStoredSidebarView("server-detail");
    setSidebarMode("server-detail", server);
    renderServerDetail(list, server);
    renderChatTagFilters(listId);
    return server;
  } catch (error) {
    chatState.activeServer = null;
    const route = getCurrentRouteInfo();
    const errorMessage = String(error?.message || "");
    const isMissingServer = errorMessage === "Сервер не найден";
    if (isMissingServer) {
      writeSelectedServerId(null);
      writeStoredSidebarView("chats");
      setSidebarMode("chats");
      if (route.serverId) {
        window.location.replace(getChatsRoute());
        return null;
      }
      await loadChats(listId, { showLoading: false, renderList: true });
      return null;
    }
    list.innerHTML = `<div class="empty-state">${escapeHtml(errorMessage)}</div>`;
    return null;
  }
}

async function loadServers(listId = "chatList", options = {}) {
  const { showLoading = true } = options;
  const list = document.getElementById(listId);
  if (!list) {
    return [];
  }

  bindChatTagFilters(listId);
  bindSidebarServerNavigation(listId);
  bindChatSearch(listId);
  if (showLoading) {
    list.innerHTML = renderChatListSkeleton(6);
  }

  try {
    const servers = await apiFetch("/servers");
    const normalizedServers = Array.isArray(servers) ? servers : servers.items || [];
    chatState.allServers = normalizedServers;
    chatState.activeServer = null;
    writeStoredSidebarView("servers");
    setSidebarMode("servers");
    renderServerList(list, normalizedServers);
    renderChatTagFilters(listId);
    return normalizedServers;
  } catch (error) {
    chatState.allServers = [];
    list.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    return [];
  }
}

async function loadSidebar(listId = "chatList", options = {}) {
  const route = getCurrentRouteInfo();
  const preferredView = readStoredSidebarView();
  if (route.serverId) {
    writeSelectedServerId(route.serverId);
    writeStoredSidebarView("server-detail");
    await loadChats(listId, {
      showLoading: false,
      renderList: false
    });
    return loadServerDetail(route.serverId, listId, options);
  }

  chatState.activeServer = null;
  if (preferredView === "servers") {
    return loadServers(listId, options);
  }
  if (preferredView === "server-detail" && readSelectedServerId()) {
    await loadChats(listId, {
      showLoading: false,
      renderList: false
    });
    return loadServerDetail(readSelectedServerId(), listId, options);
  }

  setSidebarMode("chats");
  return loadChats(listId, options);
}

function bindSidebarServerNavigation(listId = "chatList") {
  const list = document.getElementById(listId);
  const backButton = document.getElementById("sidebarServerBack");
  bindSidebarServerHeaderMenu();

  if (backButton && backButton.dataset.serverBackBound !== "true") {
    backButton.dataset.serverBackBound = "true";
    backButton.addEventListener("click", async () => {
      writeStoredSidebarView("servers");
      await loadServers(listId, { showLoading: false });
    });
  }

  if (!list || list.dataset.sidebarServerActionsBound === "true") {
    return;
  }

  list.dataset.sidebarServerActionsBound = "true";
  list.addEventListener("click", (event) => {
    const createServerTrigger = event.target.closest("[data-quick-action-server-create='true']");
    if (createServerTrigger) {
      event.preventDefault();
      openServerStructureModal("server");
      return;
    }

    const serverLink = event.target.closest("[data-server-open-id]");
    if (serverLink) {
      writeSelectedServerId(serverLink.dataset.serverOpenId);
      writeStoredSidebarView("server-detail");
    }
  });
}

function filterChats(query) {
  const normalizedQuery = query.trim().toLowerCase();
  const visibleChats = getVisibleChats().filter(isChatMatchingActiveTagFilter);
  if (!normalizedQuery) {
    return visibleChats;
  }

  return visibleChats.filter((chat) => {
    const customTag = getChatTag(chat.id, chat.type || "direct");
    const haystack = [
      chat.title,
      chat.username,
      getChatListPreviewText(chat.last_message),
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
    if (chatState.sidebarView === "server-detail" && chatState.activeServer) {
      renderServerSidebar(list, chatState.activeServer);
      return;
    }
    if (chatState.sidebarView === "servers") {
      renderServerList(list, getVisibleServers());
      return;
    }
    updateChatListView(listId);
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
        <button type="button" class="chat-tag-editor-close" data-chat-tag-close="true" aria-label="Закрыть"><img class="icon-asset" src="/assets/icons/ui/Close_round.svg" alt=""></button>
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

function buildGroupOwnerLeaveModal() {
  if (groupOwnerLeaveModal) {
    return groupOwnerLeaveModal;
  }

  const modal = document.createElement("div");
  modal.className = "group-owner-leave-modal";
  modal.hidden = true;
  modal.innerHTML = `
    <div class="group-owner-leave-backdrop" data-group-owner-close="true"></div>
    <div class="group-owner-leave-card" role="dialog" aria-modal="true" aria-labelledby="groupOwnerLeaveTitle">
      <div class="group-owner-leave-header">
        <h3 id="groupOwnerLeaveTitle">Выход создателя</h3>
        <button type="button" class="group-owner-leave-close" data-group-owner-close="true" aria-label="Закрыть"><img class="icon-asset" src="/assets/icons/ui/Close_round.svg" alt=""></button>
      </div>
      <div class="group-owner-leave-body">
        <p class="group-owner-leave-copy" id="groupOwnerLeaveCopy">Выберите действие перед выходом из группы.</p>
        <div class="group-owner-leave-options">
          <button type="button" class="button button-danger group-owner-leave-option" data-owner-leave-action="delete-group">
            Удалить группу для всех
          </button>
        </div>
        <div class="group-owner-leave-transfer" id="groupOwnerLeaveTransfer">
          <div class="group-owner-leave-transfer-title">Новый создатель</div>
          <div class="group-owner-leave-members" id="groupOwnerLeaveMembers"></div>
          <button type="button" class="button group-owner-leave-submit" id="groupOwnerLeaveSubmit" hidden disabled>
            Передать права и выйти
          </button>
        </div>
        <div class="status group-owner-leave-status" id="groupOwnerLeaveStatus"></div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  groupOwnerLeaveModal = modal;
  return modal;
}

function buildGroupDeleteConfirmModal() {
  if (groupDeleteConfirmModal) {
    return groupDeleteConfirmModal;
  }

  const modal = document.createElement("div");
  modal.className = "group-delete-confirm-modal";
  modal.hidden = true;
  modal.innerHTML = `
    <div class="group-delete-confirm-backdrop" data-group-delete-close="true"></div>
    <div class="group-delete-confirm-card" role="dialog" aria-modal="true" aria-labelledby="groupDeleteConfirmTitle">
      <div class="group-delete-confirm-header">
        <h3 id="groupDeleteConfirmTitle">Удалить группу</h3>
        <button type="button" class="group-delete-confirm-close" data-group-delete-close="true" aria-label="Закрыть"><img class="icon-asset" src="/assets/icons/ui/Close_round.svg" alt=""></button>
      </div>
      <div class="group-delete-confirm-body">
        <p class="group-delete-confirm-copy">Вы уверены, что хотите удалить группу для всех участников?</p>
        <p class="group-delete-confirm-note">Это действие нельзя отменить.</p>
        <div class="group-delete-confirm-actions">
          <button type="button" class="button button-secondary" data-group-delete-close="true">Отмена</button>
          <button type="button" class="button button-danger" id="groupDeleteConfirmSubmit">Удалить группу</button>
        </div>
        <div class="status group-delete-confirm-status" id="groupDeleteConfirmStatus"></div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  groupDeleteConfirmModal = modal;
  return modal;
}

function closeGroupOwnerLeaveModal() {
  if (!groupOwnerLeaveModal) {
    return;
  }
  groupOwnerLeaveModal.classList.remove("visible");
  window.setTimeout(() => {
    if (groupOwnerLeaveModal && !groupOwnerLeaveModal.classList.contains("visible")) {
      groupOwnerLeaveModal.hidden = true;
    }
  }, 180);
}

function closeGroupDeleteConfirmModal() {
  if (!groupDeleteConfirmModal) {
    return;
  }
  groupDeleteConfirmModal.classList.remove("visible");
  window.setTimeout(() => {
    if (groupDeleteConfirmModal && !groupDeleteConfirmModal.classList.contains("visible")) {
      groupDeleteConfirmModal.hidden = true;
    }
  }, 180);
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
  if (chatType === "server") {
    hideChatListActionMenu();
    return;
  }
  menu.innerHTML = chatType === "direct"
    ? `
      <button type="button" data-action="edit-tag">${renderActionMenuItemContent("/assets/icons/ui/Lable_fill.svg", "Изменить тег")}</button>
      <button type="button" data-action="delete-me">${renderActionMenuItemContent("/assets/icons/ui/Trash_line.svg", "Удалить у меня")}</button>
      <button type="button" data-action="delete-all" class="danger">${renderActionMenuItemContent("/assets/icons/ui/Trash.svg", "Удалить у всех")}</button>
    `
    : `
      <button type="button" data-action="edit-tag">${renderActionMenuItemContent("/assets/icons/ui/Lable_fill.svg", "Изменить тег")}</button>
      <button type="button" data-action="clear-group-history">${renderActionMenuItemContent("/assets/icons/ui/Trash_line.svg", "Очистить историю")}</button>
      <button type="button" data-action="leave-group" class="danger">${renderActionMenuItemContent("/assets/icons/ui/Out.svg", "Выйти из группы")}</button>
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
    updateChatListView(listId);
    closeChatTagEditorModal();
  };

  removeButton.onclick = () => {
    setChatTag(chatId, chatType, { label: "", color: colorInput.value });
    updateChatListView(listId);
    closeChatTagEditorModal();
  };

  modal.hidden = false;
  requestAnimationFrame(() => {
    modal.classList.add("visible");
  });
  labelInput.focus();
}

function getActiveDirectChatContext() {
  const route = getCurrentRouteInfo();
  return {
    currentPath: route.page,
    currentId: route.chatId
  };
}

function getActiveThreadContext() {
  const route = getCurrentRouteInfo();
  return {
    currentPath: route.page,
    currentId: route.chatId
  };
}

function setGroupOwnerLeaveStatus(message, type = "") {
  const modal = buildGroupOwnerLeaveModal();
  const status = modal.querySelector("#groupOwnerLeaveStatus");
  if (!status) {
    return;
  }
  status.textContent = message;
  status.className = `status group-owner-leave-status ${type}`.trim();
}

function renderGroupOwnerTransferMembers(members, selectedMemberId = "") {
  const modal = buildGroupOwnerLeaveModal();
  const membersNode = modal.querySelector("#groupOwnerLeaveMembers");
  const submitButton = modal.querySelector("#groupOwnerLeaveSubmit");
  if (!membersNode || !submitButton) {
    return;
  }

  if (!members.length) {
    membersNode.innerHTML = '<div class="empty-state">Нет участников для передачи прав</div>';
    submitButton.hidden = true;
    submitButton.disabled = true;
    return;
  }

  membersNode.innerHTML = members.map((member) => {
    const isSelected = String(member.id) === String(selectedMemberId);
    return `
      <article class="group-owner-leave-member${isSelected ? " selected" : ""}" data-owner-member-id="${escapeHtml(String(member.id))}">
        <div class="avatar small">${escapeHtml(initials(member.name || member.username || "U"))}</div>
        <div class="result-meta">
          <h3 class="result-name">${renderSystemAccountLabel(member.name || member.username || "User", member)}</h3>
          <p class="result-username">${member.username ? renderSystemAccountLabel(`@${member.username}`, member) : ""}</p>
        </div>
        <input class="group-owner-leave-member-check" type="radio" name="groupOwnerLeaveMember" ${isSelected ? "checked" : ""} aria-label="Выбрать участника">
      </article>
    `;
  }).join("");

  submitButton.hidden = false;
  submitButton.disabled = !selectedMemberId;
}

function openGroupOwnerLeaveModal(groupContext, payload, listId = "chatList") {
  const modal = buildGroupOwnerLeaveModal();
  const confirmModal = buildGroupDeleteConfirmModal();
  const copy = modal.querySelector("#groupOwnerLeaveCopy");
  const transferWrap = modal.querySelector("#groupOwnerLeaveTransfer");
  const submitButton = modal.querySelector("#groupOwnerLeaveSubmit");
  const deleteButton = modal.querySelector('[data-owner-leave-action="delete-group"]');
  const transferableMembers = Array.isArray(payload?.transferable_members) ? payload.transferable_members : [];
  let selectedMemberId = "";
  let isSubmitting = false;

  if (!copy || !transferWrap || !submitButton || !deleteButton || !confirmModal) {
    return;
  }

  modal.dataset.groupId = String(groupContext.groupId);
  modal.dataset.listId = listId;
  modal.dataset.currentPath = groupContext.currentPath || "";
  modal.dataset.currentId = groupContext.currentId || "";
  modal.dataset.selectedMemberId = "";
  copy.textContent = payload?.can_transfer_owner
    ? "Удалите группу для всех или сразу выберите нового владельца."
    : "В группе нет других участников, поэтому передать права нельзя.";
  transferWrap.hidden = false;
  renderGroupOwnerTransferMembers(transferableMembers, "");
  deleteButton.disabled = false;
  deleteButton.classList.remove("active");
  setGroupOwnerLeaveStatus("");

  const updateSubmitState = () => {
    const canTransfer = payload?.can_transfer_owner && Boolean(selectedMemberId);
    submitButton.hidden = !payload?.can_transfer_owner;
    submitButton.disabled = !canTransfer || isSubmitting;
    submitButton.textContent = isSubmitting ? "Передача..." : "Передать права и выйти";
  };

  const setSubmittingState = (nextState) => {
    isSubmitting = nextState;
    deleteButton.disabled = nextState;
    updateSubmitState();
  };

  deleteButton.onclick = () => {
    if (isSubmitting) {
      return;
    }
    const confirmSubmit = confirmModal.querySelector("#groupDeleteConfirmSubmit");
    const confirmStatus = confirmModal.querySelector("#groupDeleteConfirmStatus");
    if (!confirmSubmit || !confirmStatus) {
      return;
    }

    confirmStatus.textContent = "";
    confirmStatus.className = "status group-delete-confirm-status";
    confirmSubmit.disabled = false;
    confirmSubmit.textContent = "Удалить группу";
    confirmSubmit.onclick = async () => {
      confirmSubmit.disabled = true;
      confirmSubmit.textContent = "Удаление...";
      confirmStatus.textContent = "Удаление группы...";

      try {
        await apiFetch(`/groups/${encodeURIComponent(groupContext.groupId)}`, {
          method: "DELETE"
        });
        closeGroupDeleteConfirmModal();
        closeGroupOwnerLeaveModal();
        await loadSidebar(listId, { showLoading: false });
        if (groupContext.currentPath === "group-chat" && String(groupContext.currentId) === String(groupContext.groupId)) {
          window.location.href = getChatsRoute();
        }
      } catch (error) {
        confirmSubmit.disabled = false;
        confirmSubmit.textContent = "Удалить группу";
        confirmStatus.textContent = error.message;
        confirmStatus.className = "status group-delete-confirm-status error";
      }
    };

    confirmModal.hidden = false;
    requestAnimationFrame(() => {
      confirmModal.classList.add("visible");
    });
  };

  const membersNode = modal.querySelector("#groupOwnerLeaveMembers");
  membersNode.onclick = (event) => {
    const memberNode = event.target.closest("[data-owner-member-id]");
    if (!memberNode || isSubmitting) {
      return;
    }
    selectedMemberId = String(memberNode.dataset.ownerMemberId || "");
    modal.dataset.selectedMemberId = selectedMemberId;
    renderGroupOwnerTransferMembers(transferableMembers, selectedMemberId);
    updateSubmitState();
  };

  submitButton.onclick = async () => {
    if (!selectedMemberId || isSubmitting) {
      return;
    }

    setSubmittingState(true);
    setGroupOwnerLeaveStatus("Передача прав...", "");

    try {
      await apiFetch(`/groups/${encodeURIComponent(groupContext.groupId)}/transfer-owner`, {
        method: "POST",
        body: JSON.stringify({ new_owner_id: selectedMemberId })
      });
      closeGroupOwnerLeaveModal();
      await loadSidebar(listId, { showLoading: false });
      if (groupContext.currentPath === "group-chat" && String(groupContext.currentId) === String(groupContext.groupId)) {
        window.location.href = getChatsRoute();
      }
    } catch (error) {
      setSubmittingState(false);
      setGroupOwnerLeaveStatus(error.message, "error");
    }
  };

  modal.hidden = false;
  requestAnimationFrame(() => {
    modal.classList.add("visible");
  });
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
  updateChatListView(listId);

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
    updateChatListView(state.listId || listId);
    hideChatDeleteUndoToast();
    return;
  }

  hideChatDeleteUndoToast();

  try {
    await apiFetch(`/chats/${encodeURIComponent(state.chatId)}?scope=${encodeURIComponent(state.scope)}`, {
      method: "DELETE"
    });
    pendingDeletedChatKeys.delete(state.chatKey);
    await loadSidebar(state.listId || listId, { showLoading: false });

    const { currentPath, currentId } = getActiveDirectChatContext();
    if (currentPath === "direct-chat" && String(currentId) === String(state.chatId)) {
      window.location.href = getChatsRoute();
    }
  } catch (error) {
    pendingDeletedChatKeys.delete(state.chatKey);
    updateChatListView(state.listId || listId);
    hideChatDeleteUndoToast();
    window.alert(error.message);
  }
}

async function clearGroupHistoryFromList(chatItem, listId = "chatList") {
  const groupId = chatItem?.dataset.chatId;
  const chatType = chatItem?.dataset.chatType;
  if (!groupId || chatType !== "group") {
    return;
  }

  await apiFetch(`/groups/${encodeURIComponent(groupId)}/messages`, {
    method: "DELETE"
  });
  await loadSidebar(listId, { showLoading: false });

  const { currentPath, currentId } = getActiveThreadContext();
  if (currentPath === "group-chat" && String(currentId) === String(groupId)) {
    window.location.reload();
  }
}

async function leaveGroupFromList(chatItem, listId = "chatList") {
  const groupId = chatItem?.dataset.chatId;
  const chatType = chatItem?.dataset.chatType;
  if (!groupId || chatType !== "group") {
    return;
  }

  const url = `${API.baseUrl}/groups/${encodeURIComponent(groupId)}/leave`;
  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${getToken()}`
  };

  const response = await fetch(url, {
    method: "DELETE",
    headers
  });

  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json")
    ? await response.json()
    : await response.text();

  if (response.ok) {
    await loadSidebar(listId, { showLoading: false });
    const { currentPath, currentId } = getActiveThreadContext();
    if (currentPath === "group-chat" && String(currentId) === String(groupId)) {
      window.location.href = getChatsRoute();
    }
    return;
  }

  if (response.status === 409 && payload?.code === "owner_leave_requires_action") {
    const groupContext = {
      groupId,
      ...getActiveThreadContext()
    };
    openGroupOwnerLeaveModal(groupContext, payload, listId);
    return;
  }

  const message =
    (payload && payload.message) ||
    (payload && payload.detail) ||
    (typeof payload === "string" ? payload : "Request failed");
  throw new Error(message);
}

function bindChatListActions(listId = "chatList") {
  const list = document.getElementById(listId);
  if (!list || list.dataset.chatActionsBound === "true") {
    return;
  }

  buildChatListActionMenu();
  buildChatDeleteUndoToast();
  buildChatTagEditorModal();
  buildGroupOwnerLeaveModal();
  buildGroupDeleteConfirmModal();
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
      if (action === "delete-me" || action === "delete-all") {
        await deleteDirectChatFromList(targetItem, action === "delete-all" ? "all" : "me", listId);
        return;
      }

      if (action === "clear-group-history") {
        await clearGroupHistoryFromList(targetItem, listId);
        return;
      }

      if (action === "leave-group") {
        await leaveGroupFromList(targetItem, listId);
      }
    } catch (error) {
      window.alert(error.message);
    }
  });

  chatDeleteUndoToast.querySelector(".delete-undo-button")?.addEventListener("click", () => {
    void flushPendingChatDelete("undo", listId);
  });

  groupOwnerLeaveModal?.addEventListener("click", (event) => {
    if (event.target.closest("[data-group-owner-close=\"true\"]")) {
      closeGroupOwnerLeaveModal();
    }
  });

  groupDeleteConfirmModal?.addEventListener("click", (event) => {
    if (event.target.closest("[data-group-delete-close=\"true\"]")) {
      closeGroupDeleteConfirmModal();
    }
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
      !event.target.closest(".chat-tag-editor-card") &&
      !event.target.closest(".group-owner-leave-card")
    ) {
      hideChatListActionMenu();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && groupDeleteConfirmModal && !groupDeleteConfirmModal.hidden) {
      closeGroupDeleteConfirmModal();
      return;
    }
    if (event.key === "Escape" && groupOwnerLeaveModal && !groupOwnerLeaveModal.hidden) {
      closeGroupOwnerLeaveModal();
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
    loadSidebar(listId, { showLoading: false });
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

function setSidebarMode(mode = "chats", server = null) {
  const sidebar = document.querySelector(".sidebar");
  const tagBar = document.getElementById("chatTagFilters");
  const searchWrap = document.querySelector(".sidebar-search");
  const searchInput = document.querySelector(".sidebar-search .search-input");
  const brandNode = document.getElementById("sidebarBrand");
  const subtitleNode = document.getElementById("sidebarServerSubtitle");
  const userBadge = document.getElementById("currentUserBadge");
  const actionsNode = document.getElementById("sidebarActions");
  const backButton = document.getElementById("sidebarServerBack");
  const brandTrigger = document.getElementById("sidebarServerMenuTrigger");
  const normalizedMode = mode === "servers" ? "servers" : mode === "server-detail" ? "server-detail" : "chats";
  const isChatsMode = normalizedMode === "chats";
  const isServerListMode = normalizedMode === "servers";
  const isServerDetailMode = normalizedMode === "server-detail";

  chatState.sidebarView = normalizedMode;
  sidebar?.classList.toggle("is-server-detail", isServerDetailMode);
  if (tagBar) {
    tagBar.hidden = isServerDetailMode;
  }
  if (searchWrap) {
    searchWrap.hidden = false;
  }
  if (searchInput) {
    searchInput.placeholder = isChatsMode
      ? "Ваши чаты"
      : isServerListMode
        ? "Ваши серверы"
        : `Каналы ${server?.title ? `в ${server.title}` : "сервера"}`;
  }
  if (brandNode) {
    brandNode.textContent = isServerDetailMode ? (server?.title || "Сервер") : "/Chatik";
  }
  if (brandTrigger) {
    brandTrigger.disabled = !isServerDetailMode;
    brandTrigger.classList.toggle("is-interactive", isServerDetailMode);
    brandTrigger.setAttribute("aria-expanded", "false");
    if (!isServerDetailMode) {
      closeSidebarServerHeaderMenu();
    }
  }
  if (subtitleNode) {
    const subtitle = isServerDetailMode
      ? String(server?.description || "").trim() || "Структура сервера"
      : "";
    subtitleNode.textContent = subtitle;
    subtitleNode.hidden = !isServerDetailMode;
  }
  if (userBadge) {
    userBadge.hidden = isServerDetailMode;
  }
  if (actionsNode) {
    actionsNode.hidden = isServerDetailMode;
  }
  if (backButton) {
    backButton.hidden = !isServerDetailMode;
    backButton.style.display = isServerDetailMode ? "inline-flex" : "none";
  }
}

function renderChats(list, chats) {
  const previousScrollTop = list.scrollTop;

  if (!chats.length) {
    const hasQuery = Boolean(document.querySelector(".sidebar-search .search-input")?.value.trim());
    const hasTagFilter = activeChatTagFilter !== "all";
    const emptyMessage = hasQuery
      ? "Ничего не найдено"
      : hasTagFilter
        ? "Нет чатов по выбранному тегу"
        : "Чатов пока нет";
    list.innerHTML = `<div class="empty-state">${emptyMessage}</div>`;
    restoreChatListScroll(list, previousScrollTop);
    return;
  }

  const route = getCurrentRouteInfo();

  list.innerHTML = chats
    .map((chat) => {
      const isGroup = chat.type === "group";
      const isServer = chat.type === "server";
      const href = isServer
        ? getServerRoute(chat.id)
        : isGroup
          ? getGroupChatRoute(chat.id, chat.server_id || null)
          : getDirectChatRoute(chat.id);
      const preview = getChatListPreviewText(chat.last_message);
      const name = chat.title || chat.username || chat.name || "Чат";
      const customTagMarkup = getChatTagMarkup(chat.id, chat.type || "direct");
      const isOnline = !isGroup && !isServer && Boolean(chat.is_online);
      const active = route.page === "group-chat"
        ? (isServer && String(chat.id) === String(route.serverId))
          || (isGroup && String(chat.id) === String(route.chatId))
        : route.page === "direct-chat"
          ? !isGroup && !isServer && String(chat.id) === String(route.chatId)
          : route.page === "server"
            ? isServer && String(chat.id) === String(route.serverId)
          : false;
      const unreadCount = Math.max(0, Number(chat.unread_count || 0));
      const unreadLabel = unreadCount > 99 ? "99+" : String(unreadCount);
      const unreadMarkup = unreadCount > 0
        ? `
          <span class="chat-unread-wrap">
            <span class="chat-unread-badge" aria-label="Непрочитанных сообщений: ${escapeHtml(unreadLabel)}">${escapeHtml(unreadLabel)}</span>
          </span>
        `
        : "";

      return `
        <a class="chat-item ${active ? "active" : ""}" href="${href}" data-chat-id="${escapeHtml(String(chat.id))}" data-chat-type="${escapeHtml(chat.type || "direct")}">
          <div class="avatar ${isServer ? "server-avatar" : isGroup ? "group-avatar" : ""}">
            ${escapeHtml(initials(name))}
            ${isServer
              ? '<span class="chat-kind-badge chat-kind-badge-icon" aria-hidden="true"><img class="icon-asset" src="/assets/icons/ui/Folder.svg" alt=""></span>'
              : isGroup
                ? '<span class="chat-kind-badge chat-kind-badge-icon" aria-hidden="true"><img class="icon-asset" src="/assets/icons/ui/group.svg" alt=""></span>'
                : isOnline
                  ? '<span class="presence-dot online" aria-hidden="true"></span>'
                  : ""}
          </div>
          <div class="chat-meta">
            <div class="chat-main">
              <div class="chat-title-row">
                <h3 class="chat-name">${renderSystemAccountLabel(name, chat)}</h3>
                ${customTagMarkup}
              </div>
              <p class="chat-preview">${escapeHtml(preview)}</p>
            </div>
            <div class="chat-side${unreadCount > 0 ? " has-unread" : ""}">
              <span class="time">${escapeHtml(formatDate(chat.updated_at || chat.last_message?.created_at))}</span>
              ${unreadMarkup}
            </div>
          </div>
        </a>
      `;
    })
    .join("");

  restoreChatListScroll(list, previousScrollTop);
}
(function () {
  function syncServerChatModeClass() {
    const serverSearchField = Array.from(document.querySelectorAll("input, textarea")).find((node) => {
      const placeholder = (node.getAttribute("placeholder") || "").trim();
      return placeholder.startsWith("Каналы в ");
    });

    document.body.classList.toggle("server-chat-mode", Boolean(serverSearchField));
  }

  function startServerChatModeSync() {
    if (!document.body) {
      return;
    }
    syncServerChatModeClass();
    window.setInterval(syncServerChatModeClass, 800);
  }

  if (document.body) {
    startServerChatModeSync();
  } else {
    window.addEventListener("DOMContentLoaded", startServerChatModeSync, { once: true });
  }
})();
