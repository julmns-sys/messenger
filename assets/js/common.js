const chatState = {
  allChats: [],
  refreshIntervalId: null,
  refreshListId: null
};
const CHAT_LIST_SCROLL_KEY = "messenger:chat-list-scroll-top";
const CHAT_TAGS_KEY = "messenger:chat-tags";
const APP_SETTINGS_KEY = "messenger:settings";
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

function getChatStateKey(chatId, chatType = "direct") {
  return `${chatType}:${chatId}`;
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
    renderChats(chatList, filterChats(getChatSearchQuery()));
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

  initSecurityControls();
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
  const fallbackLabel = messageType === "voice" ? "Голосовое сообщение" : "Новое сообщение";
  if (!settings.notificationTextPreview) {
    return fallbackLabel;
  }

  if (messageType === "voice") {
    return "Голосовое сообщение";
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
  const displayName = getUserProfileDisplayName(user);
  const originalName = getUserProfileOriginalName(user);
  const bio = user?.bio && String(user.bio).trim() ? String(user.bio).trim() : "";
  const username = user?.username ? `@${user.username}` : "";
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
      >⋯</button>
      <div class="sidebar-profile-menu user-profile-action-menu" data-user-profile-menu hidden>
        <button class="sidebar-profile-menu-item" type="button" data-profile-contact-action="copy-username" data-profile-user-id="${escapeHtml(String(user.id || ""))}">
          Скопировать username
        </button>
        ${!isContact ? `
          <button class="sidebar-profile-menu-item" type="button" data-profile-contact-action="add" data-profile-user-id="${escapeHtml(String(user.id || ""))}">
            Добавить в контакты
          </button>
        ` : `
          <button class="sidebar-profile-menu-item" type="button" data-profile-contact-action="rename" data-profile-user-id="${escapeHtml(String(user.id || ""))}">
            Переименовать контакт
          </button>
          ${hasAlias ? `
            <button class="sidebar-profile-menu-item" type="button" data-profile-contact-action="reset-alias" data-profile-user-id="${escapeHtml(String(user.id || ""))}">
              Вернуть имя по умолчанию
            </button>
          ` : ""}
          <button class="sidebar-profile-menu-item danger" type="button" data-profile-contact-action="remove" data-profile-user-id="${escapeHtml(String(user.id || ""))}">
            Удалить из контактов
          </button>
        `}
      </div>
    `;

  return `
    <section class="thread-info-card thread-info-card-profile user-profile-panel-card" data-user-profile-card="true" data-user-profile-id="${escapeHtml(String(user.id || ""))}">
      <div class="thread-info-card-eyebrow">${escapeHtml(options.eyebrow || "Profile")}</div>
      ${menuMarkup}
      <div class="thread-info-hero user-profile-panel-hero">
        <div class="avatar thread-info-avatar${options.groupAvatar ? " group-avatar" : ""}">${escapeHtml(initials(displayName))}</div>
        <h3 class="thread-info-name">${escapeHtml(displayName)}</h3>
        ${originalName ? `<p class="user-profile-original-name">${escapeHtml(originalName)}</p>` : ""}
        <div class="user-profile-identity-row">
          ${username ? `
            <button class="user-profile-username" type="button" data-profile-copy-username="${escapeHtml(String(user.username || ""))}" aria-label="Скопировать username">
              ${escapeHtml(username)}
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
        <button type="button" class="profile-logout-close" data-profile-logout-close="true" aria-label="Закрыть">×</button>
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
    bio: document.getElementById("sidebarProfileBio")
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

  if (!user || !avatar || !name || !username || !fields.name || !fields.email || !fields.username || !fields.bio) {
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

  fields.email.textContent = getSidebarProfileFieldValue("email", user);
  fields.email.classList.toggle("is-blurred", Boolean(user.email));
  fields.email.setAttribute("aria-label", user.email ? "Показать email" : "Email не указан");
  fields.email.setAttribute("aria-pressed", "false");
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
      maxLength: 255,
      value: (user) => user?.email || ""
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
  input.type = field === "email" ? "email" : "text";
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
    <button class="quick-actions-menu-item" type="button" data-quick-action="search-user">Написать пользователю</button>
    <button class="quick-actions-menu-item" type="button" data-quick-action="open-graph">Граф общения</button>
    <button class="quick-actions-menu-item" type="button" data-quick-action="create-group">Создать группу</button>
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
  initSettingsControls();
  const route = getCurrentRouteInfo();

  if (!sidebar || !badge || !backButton || !menuTrigger || !menu || badge.dataset.profileBound === "true") {
    return;
  }

  badge.dataset.profileBound = "true";
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
  return chatState.allChats.filter((chat) => !pendingDeletedChatKeys.has(getChatStateKey(chat.id, chat.type || "direct")));
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
  container.innerHTML = [
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
    button.classList.toggle("active", button.dataset.chatTagFilter === activeChatTagFilter);
  });
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

  container.addEventListener("click", (event) => {
    const trigger = event.target.closest("[data-chat-tag-filter]");
    if (!trigger) {
      return;
    }

    activeChatTagFilter = trigger.dataset.chatTagFilter || "all";
    updateChatListView(container.dataset.listId || listId);
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
  renderChats(list, filterChats(getChatSearchQuery()));
}

function scheduleChatListRefresh(listId = "chatList", delayMs = 0) {
  if (chatListRefreshTimer) {
    window.clearTimeout(chatListRefreshTimer);
  }

  chatListRefreshTimer = window.setTimeout(() => {
    chatListRefreshTimer = null;
    loadChats(listId, { showLoading: false });
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
  chatListRealtimeSocket.on("presence_updated", refreshSidebar);
  chatListRealtimeSocket.on("inbox_message", (payload) => {
    handleGlobalIncomingNotification(payload);
    refreshSidebar();
  });
}

async function loadChats(listId = "chatList", options = {}) {
  const { showLoading = true } = options;
  const list = document.getElementById(listId);
  if (!list) return [];

  bindChatListScrollPersistence(listId);
  bindChatListActions(listId);
  initChatListRealtime(listId);

  if (showLoading) {
    list.innerHTML = '<div class="empty-state">Загрузка чатов...</div>';
  }

  try {
    const chats = await apiFetch("/chats");
    const normalizedChats = Array.isArray(chats) ? chats : chats.items || [];
    chatState.allChats = normalizedChats;
    bindChatSearch(listId);
    updateChatListView(listId);
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
        <button type="button" class="group-owner-leave-close" data-group-owner-close="true" aria-label="Закрыть">×</button>
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
        <button type="button" class="group-delete-confirm-close" data-group-delete-close="true" aria-label="Закрыть">×</button>
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
  menu.innerHTML = chatType === "direct"
    ? `
      <button type="button" data-action="edit-tag">Изменить тег</button>
      <button type="button" data-action="delete-me">Удалить у меня</button>
      <button type="button" data-action="delete-all" class="danger">Удалить у всех</button>
    `
    : `
      <button type="button" data-action="edit-tag">Изменить тег</button>
      <button type="button" data-action="clear-group-history">Очистить историю</button>
      <button type="button" data-action="leave-group" class="danger">Выйти из группы</button>
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
          <h3 class="result-name">${escapeHtml(member.name || member.username || "User")}</h3>
          <p class="result-username">@${escapeHtml(member.username || "")}</p>
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
        await loadChats(listId, { showLoading: false });
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
      await loadChats(listId, { showLoading: false });
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
    await loadChats(state.listId || listId, { showLoading: false });

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
  await loadChats(listId, { showLoading: false });

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
    await loadChats(listId, { showLoading: false });
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
      const href = chat.type === "group" ? getGroupChatRoute(chat.id) : getDirectChatRoute(chat.id);
      const preview = getChatListPreviewText(chat.last_message);
      const name = chat.title || chat.username || chat.name || "Чат";
      const isGroup = chat.type === "group";
      const customTagMarkup = getChatTagMarkup(chat.id, chat.type || "direct");
      const isOnline = !isGroup && Boolean(chat.is_online);
      const active = route.page === "group-chat"
        ? isGroup && String(chat.id) === String(route.chatId)
        : route.page === "direct-chat"
          ? !isGroup && String(chat.id) === String(route.chatId)
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
          <div class="avatar ${isGroup ? "group-avatar" : ""}">
            ${escapeHtml(initials(name))}
            ${isGroup ? '<span class="chat-kind-badge" aria-hidden="true">👥</span>' : isOnline ? '<span class="presence-dot online" aria-hidden="true"></span>' : ""}
          </div>
          <div class="chat-meta">
            <div class="chat-main">
              <div class="chat-title-row">
                <h3 class="chat-name">${escapeHtml(name)}</h3>
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
