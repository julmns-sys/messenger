const renderedMessages = new Set();
const BOTTOM_THRESHOLD = 24;
const PAGE_SIZE = 30;
const TOP_LOAD_THRESHOLD = 80;
const URL_PATTERN = /((?:https?:\/\/|www\.)[^\s<]+)/gi;
const SERVER_INVITE_URL_PATTERN = /https?:\/\/[^\s<]+\/server-invite\/([A-Za-z0-9_-]+)/i;
const linkPreviewCache = new Map();
const linkPreviewRequests = new Map();
const serverInvitePreviewCache = new Map();
const serverInvitePreviewRequests = new Map();
const THREAD_MESSAGE_SELECTOR = ".message[data-message-id], .wide-message[data-message-id]";
const THREAD_RENDERED_MESSAGE_SELECTOR = ".message:not(.pending), .wide-message:not(.pending)";

function findThreadMessageNode(root, messageId) {
  if (!root || messageId == null) {
    return null;
  }
  return root.querySelector(`.message[data-message-id="${CSS.escape(String(messageId))}"], .wide-message[data-message-id="${CSS.escape(String(messageId))}"]`);
}

function getThreadMessageTargetNode(target) {
  return target?.closest?.(".message[data-message-id], .wide-message[data-message-id]") || null;
}

function areLinkPreviewsEnabled() {
  return !document.body.classList.contains("settings-link-previews-off");
}

function getLiveNotificationSettings() {
  return normalizeAppSettings(readAppSettings());
}

function normalizeExternalUrl(value = "") {
  const rawValue = String(value || "").trim();
  if (!rawValue) {
    return "";
  }

  if (/^https?:\/\//i.test(rawValue)) {
    return rawValue;
  }

  if (/^www\./i.test(rawValue)) {
    return `https://${rawValue}`;
  }

  return "";
}

function renderMessageText(text = "") {
  const source = String(text || "");
  if (!source) {
    return "";
  }

  let lastIndex = 0;
  let html = "";

  source.replace(URL_PATTERN, (match, _group, offset) => {
    const safeUrl = normalizeExternalUrl(match);
    html += escapeHtml(source.slice(lastIndex, offset));
    if (safeUrl) {
      html += `<a class="message-link" href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(match)}</a>`;
    } else {
      html += escapeHtml(match);
    }
    lastIndex = offset + match.length;
    return match;
  });

  html += escapeHtml(source.slice(lastIndex));
  return html;
}

function extractFirstUrl(text = "") {
  const source = String(text || "");
  const match = source.match(URL_PATTERN);
  if (!match?.length) {
    return "";
  }
  return normalizeExternalUrl(match[0]);
}

function extractServerInviteCode(text = "") {
  const match = String(text || "").match(SERVER_INVITE_URL_PATTERN);
  return match?.[1] ? String(match[1]) : "";
}

function renderServerInvitePlaceholder(code = "", url = "") {
  if (!code || !url) {
    return "";
  }
  return `
    <div class="message-server-invite is-loading" data-message-server-invite="${escapeHtml(code)}" data-server-invite-url="${escapeHtml(url)}">
      <span class="message-server-invite-label">Приглашение на сервер</span>
      <strong class="message-server-invite-title">Загружаем сервер...</strong>
      <span class="message-server-invite-meta">Подготавливаем карточку приглашения</span>
      <button class="button" type="button" disabled>Загрузка...</button>
    </div>
  `;
}

function renderServerInviteCard(invite = {}, fallbackUrl = "") {
  const code = String(invite?.code || "");
  const serverId = invite?.server_id != null ? String(invite.server_id) : "";
  const defaultChannelId = invite?.default_channel_id != null ? String(invite.default_channel_id) : "";
  const title = String(invite?.server_name || "Сервер");
  const membersCount = Number(invite?.members_count || 0);
  const onlineCount = Number(invite?.online_count || 0);
  const isExpired = Boolean(invite?.is_expired || invite?.revoked || invite?.is_exhausted);
  const alreadyMember = Boolean(invite?.already_member);
  const canJoin = !isExpired && !alreadyMember;
  const actionLabel = alreadyMember ? "Открыть сервер" : (isExpired ? "Приглашение недоступно" : "Присоединиться");
  const actionAttrs = alreadyMember
    ? `data-server-invite-open="${escapeHtml(serverId)}" data-server-invite-channel="${escapeHtml(defaultChannelId)}"`
    : (canJoin ? `data-server-invite-join="${escapeHtml(code)}"` : "disabled");
  return `
    <div class="message-server-invite" data-message-server-invite="${escapeHtml(code)}" data-server-invite-url="${escapeHtml(fallbackUrl || invite?.url || "")}">
      <span class="message-server-invite-label">Приглашение на сервер</span>
      <strong class="message-server-invite-title">${escapeHtml(title)}</strong>
      <span class="message-server-invite-meta">${escapeHtml(`${membersCount} участников · ${onlineCount} онлайн`)}</span>
      <button class="button" type="button" ${actionAttrs}>${escapeHtml(actionLabel)}</button>
    </div>
  `;
}

function fetchServerInvitePreview(code = "") {
  if (!code) {
    return Promise.reject(new Error("invite code is required"));
  }
  if (serverInvitePreviewCache.has(code)) {
    return Promise.resolve(serverInvitePreviewCache.get(code));
  }
  if (serverInvitePreviewRequests.has(code)) {
    return serverInvitePreviewRequests.get(code);
  }
  const request = apiFetch(`/server-invite/${encodeURIComponent(code)}`)
    .then((payload) => {
      serverInvitePreviewCache.set(code, payload);
      serverInvitePreviewRequests.delete(code);
      return payload;
    })
    .catch((error) => {
      serverInvitePreviewRequests.delete(code);
      throw error;
    });
  serverInvitePreviewRequests.set(code, request);
  return request;
}

function renderMessagePreviewPlaceholder(url = "") {
  if (!url || !areLinkPreviewsEnabled()) {
    return "";
  }

  return `
    <a
      class="message-link-preview is-loading"
      href="${escapeHtml(url)}"
      target="_blank"
      rel="noopener noreferrer"
      data-message-link-preview="true"
      data-preview-url="${escapeHtml(url)}"
    >
      <span class="message-link-preview-domain">${escapeHtml(urlparseHost(url))}</span>
      <strong class="message-link-preview-title">Загружаем preview...</strong>
      <span class="message-link-preview-description">Подготавливаем карточку ссылки</span>
    </a>
  `;
}

function urlparseHost(url = "") {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

function renderMessagePreviewCard(preview = {}, fallbackUrl = "") {
  const url = preview?.url || fallbackUrl;
  const domain = preview?.site_name || preview?.domain || urlparseHost(url);
  const title = preview?.title || urlparseHost(url);
  const description = preview?.description || "";

  return `
    <a
      class="message-link-preview"
      href="${escapeHtml(url)}"
      target="_blank"
      rel="noopener noreferrer"
      data-message-link-preview="true"
      data-preview-url="${escapeHtml(url)}"
    >
      <span class="message-link-preview-domain">${escapeHtml(domain)}</span>
      <strong class="message-link-preview-title">${escapeHtml(title)}</strong>
      ${description ? `<span class="message-link-preview-description">${escapeHtml(description)}</span>` : ""}
    </a>
  `;
}

function getMessagePreviewData(message = {}) {
  const preview = message?.link_preview;
  if (!preview?.url) {
    return null;
  }
  return {
    url: preview.url,
    domain: preview.domain || urlparseHost(preview.url),
    title: preview.title || urlparseHost(preview.url),
    description: preview.description || "",
    site_name: preview.site_name || ""
  };
}

function getMessageAudioData(message = {}) {
  const audio = message?.audio;
  if (!audio?.url) {
    return null;
  }
  return {
    url: audio.url,
    mime_type: audio.mime_type || "audio/webm",
    duration_ms: Number(audio.duration_ms || 0)
  };
}

function getMessageImageData(message = {}) {
  const image = message?.image;
  if (!image?.url) {
    return null;
  }
  return {
    url: image.url,
    mime_type: image.mime_type || "image/jpeg"
  };
}

function normalizeMessageAttachment(attachment = {}) {
  const url = String(attachment?.url || attachment?.file_url || "").trim();
  if (!url) {
    return null;
  }
  return {
    id: attachment?.id ?? null,
    url,
    file_name: String(attachment?.file_name || "").trim(),
    mime_type: attachment?.mime_type || "image/jpeg",
    size: Number(attachment?.size || 0)
  };
}

function getMessageAttachments(message = {}) {
  const rawAttachments = Array.isArray(message?.attachments) ? message.attachments : [];
  const attachments = rawAttachments
    .map((attachment) => normalizeMessageAttachment(attachment))
    .filter(Boolean);
  if (attachments.length) {
    return attachments;
  }

  const legacyImage = getMessageImageData(message);
  if (!legacyImage?.url) {
    return [];
  }

  return [normalizeMessageAttachment({
    url: legacyImage.url,
    mime_type: legacyImage.mime_type,
    file_name: "photo"
  })].filter(Boolean);
}

function renderMessageAttachments(attachments = []) {
  if (!attachments.length) {
    return "";
  }

  return `
    <div class="message-attachments" data-count="${escapeHtml(String(Math.min(attachments.length, 6)))}">
      ${attachments.map((attachment, index) => `
        <button
          class="message-image"
          type="button"
          data-image-modal-src="${escapeHtml(attachment.url)}"
          data-image-modal-index="${escapeHtml(String(index))}"
          aria-label="Открыть фотографию ${escapeHtml(String(index + 1))}"
        >
          <img src="${escapeHtml(attachment.url)}" alt="Фотография" loading="lazy">
        </button>
      `).join("")}
    </div>
  `;
}

function renderMessageStandardBody(message = {}) {
  const text = String(message?.text || "");
  const hasText = Boolean(text.trim());
  const attachments = getMessageAttachments(message);
  const previewUrl = extractFirstUrl(text);
  const serverInviteCode = extractServerInviteCode(text);
  const previewData = getMessagePreviewData(message);

  if (previewData?.url) {
    linkPreviewCache.set(previewData.url, previewData);
  }

  return `
    ${hasText ? `<p class="message-text">${renderMessageText(text)}</p>` : ""}
    ${hasText ? (
      serverInviteCode
        ? renderServerInvitePlaceholder(serverInviteCode, previewUrl)
        : (areLinkPreviewsEnabled() && previewData ? renderMessagePreviewCard(previewData, previewData.url) : renderMessagePreviewPlaceholder(previewUrl))
    ) : ""}
    ${renderMessageAttachments(attachments)}
  `;
}

function renderPhotoMessageBody(message = {}, pending = false) {
  const attachment = getMessageAttachments(message)[0] || getMessageImageData(message) || {};
  const imageUrl = escapeHtml(attachment?.url || "");
  const imageType = escapeHtml(attachment?.mime_type || "image/jpeg");
  return `
    <div class="photo-message${pending ? " pending" : ""}">
      <img class="photo-message-image" src="${imageUrl}" alt="Фотография" loading="lazy" ${pending ? "" : `data-image-modal-src="${imageUrl}" data-photo-type="${imageType}"`}>
      ${pending ? '<span class="photo-message-status">Отправляем фото...</span>' : ""}
    </div>
  `;
}

function getMessageStickerData(message = {}) {
  const sticker = message?.sticker;
  if (!sticker?.url) {
    return null;
  }
  return {
    id: sticker.id || null,
    url: sticker.url
  };
}

function renderStickerMessageBody(message = {}, pending = false) {
  const sticker = getMessageStickerData(message);
  const stickerUrl = escapeHtml(sticker?.url || "");
  return `
    <div class="sticker-message${pending ? " pending" : ""}">
      <img class="sticker-message-image" src="${stickerUrl}" alt="Стикер" loading="lazy">
      ${pending ? '<span class="sticker-message-status">Отправляем стикер...</span>' : ""}
    </div>
  `;
}

const COMPOSER_ACTION_ICONS = {
  idle: "/assets/icons/ui/Mic.svg",
  save: "/assets/icons/ui/Check_fill.svg",
  recording: "/assets/icons/ui/Stop_fill.svg"
};
const VOICE_TOGGLE_ICON_MARKUP = {
  play: `
    <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
      <path d="M8 6.78v10.44c0 1.1 1.2 1.79 2.16 1.23l8.36-5.22a1.41 1.41 0 0 0 0-2.46l-8.36-5.22C9.2 4.99 8 5.68 8 6.78Z"></path>
    </svg>
  `,
  pause: `
    <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
      <path d="M8.5 6.5A1.5 1.5 0 0 1 10 8v8a1.5 1.5 0 1 1-3 0V8a1.5 1.5 0 0 1 1.5-1.5Zm7 0A1.5 1.5 0 0 1 17 8v8a1.5 1.5 0 1 1-3 0V8a1.5 1.5 0 0 1 1.5-1.5Z"></path>
    </svg>
  `
};

function formatVoiceDuration(durationMs = 0) {
  const totalSeconds = Math.max(0, Math.round(Number(durationMs || 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatVoiceTime(seconds = 0) {
  const safeSeconds = Math.max(0, Math.floor(Number(seconds || 0)));
  const minutes = Math.floor(safeSeconds / 60);
  const restSeconds = safeSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(restSeconds).padStart(2, "0")}`;
}

function renderVoiceMessageBody(message = {}, pending = false) {
  const audio = getMessageAudioData(message);
  const durationLabel = formatVoiceDuration(audio?.duration_ms || 0);
  const audioUrl = escapeHtml(audio?.url || "");
  const audioType = escapeHtml(audio?.mime_type || "audio/webm");
  return `
    <div class="voice-message${pending ? " pending" : ""}">
      ${pending ? `
        <div class="voice-message-head">
          <span class="voice-message-icon" aria-hidden="true">…</span>
          <span class="voice-message-label">Отправляем голосовое...</span>
          <span class="voice-message-duration">${durationLabel}</span>
        </div>
      ` : `
        <div class="voice-message-player" data-voice-player="true">
          <audio class="voice-message-audio" preload="metadata" playsinline webkit-playsinline="true" src="${audioUrl}" data-duration-ms="${escapeHtml(String(audio?.duration_ms || 0))}">
            <source src="${audioUrl}" type="${audioType}">
          </audio>
          <button class="voice-message-play" type="button" data-voice-toggle="true" aria-label="Воспроизвести голосовое сообщение">
            <span class="voice-message-play-icon" aria-hidden="true">${VOICE_TOGGLE_ICON_MARKUP.play}</span>
          </button>
          <div class="voice-message-main">
            <div class="voice-message-topline">
              <span class="voice-message-label">Голосовое сообщение</span>
              <span class="voice-message-time" data-voice-time="current">00:00</span>
            </div>
            <button class="voice-message-progress" type="button" data-voice-seek="true" aria-label="Перемотать голосовое сообщение">
              <span class="voice-message-progress-track"></span>
              <span class="voice-message-progress-fill" data-voice-progress-fill="true" style="width: 0%"></span>
              <span class="voice-message-progress-thumb" data-voice-progress-thumb="true" style="left: 0%"></span>
            </button>
            <div class="voice-message-meta">
              <span class="voice-message-wave" aria-hidden="true">
                <span></span><span></span><span></span><span></span><span></span>
              </span>
              <span class="voice-message-time" data-voice-time="duration">${durationLabel}</span>
            </div>
          </div>
        </div>
      `}
    </div>
  `;
}

let activeVoiceAudio = null;

function isVoicePlaybackCompleted(audio, durationOverride = null) {
  if (!audio) {
    return false;
  }

  const fallbackDuration = Number(audio.dataset.durationMs || 0) / 1000;
  const duration = durationOverride ?? (Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : fallbackDuration);
  if (!(duration > 0)) {
    return false;
  }

  const currentTime = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
  return currentTime >= Math.max(0, duration - 0.15);
}

function syncVoicePlayerState(player) {
  if (!player) {
    return;
  }

  const audio = player.querySelector(".voice-message-audio");
  const toggle = player.querySelector("[data-voice-toggle]");
  const currentTimeNode = player.querySelector('[data-voice-time="current"]');
  const durationNode = player.querySelector('[data-voice-time="duration"]');
  const fillNode = player.querySelector("[data-voice-progress-fill]");
  const thumbNode = player.querySelector("[data-voice-progress-thumb]");
  if (!audio || !toggle || !currentTimeNode || !durationNode || !fillNode || !thumbNode) {
    return;
  }

  const currentTime = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
  const fallbackDuration = Number(audio.dataset.durationMs || 0) / 1000;
  const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : fallbackDuration;
  const isCompleted = player.dataset.voiceCompleted === "true" || isVoicePlaybackCompleted(audio, duration);
  const visibleCurrentTime = isCompleted ? duration : currentTime;
  const progress = duration > 0
    ? (isCompleted ? 100 : Math.min(100, Math.max(0, (currentTime / duration) * 100)))
    : 0;

  player.classList.toggle("is-playing", !audio.paused && !audio.ended);
  player.classList.toggle("is-ready", duration > 0);
  player.classList.toggle("is-completed", isCompleted);
  toggle.setAttribute("aria-label", audio.paused || audio.ended ? "Воспроизвести голосовое сообщение" : "Поставить голосовое на паузу");
  const iconNode = toggle.querySelector(".voice-message-play-icon");
  if (iconNode) {
    iconNode.innerHTML = audio.paused || audio.ended ? VOICE_TOGGLE_ICON_MARKUP.play : VOICE_TOGGLE_ICON_MARKUP.pause;
  }
  currentTimeNode.textContent = formatVoiceTime(visibleCurrentTime);
  durationNode.textContent = formatVoiceTime(duration);
  fillNode.style.width = `${progress}%`;
  thumbNode.style.left = `${progress}%`;
}

function initializeVoicePlayers(container) {
  if (!container) {
    return;
  }

  container.querySelectorAll('[data-voice-player="true"]').forEach((player) => {
    if (player.dataset.voiceBound === "true") {
      syncVoicePlayerState(player);
      return;
    }

    const audio = player.querySelector(".voice-message-audio");
    if (!audio) {
      return;
    }

    player.dataset.voiceBound = "true";
    ["loadedmetadata", "timeupdate", "play", "pause", "ended"].forEach((eventName) => {
      audio.addEventListener(eventName, () => {
        if (eventName === "play") {
          if (activeVoiceAudio && activeVoiceAudio !== audio) {
            activeVoiceAudio.pause();
          }
          activeVoiceAudio = audio;
          if (!isVoicePlaybackCompleted(audio)) {
            player.dataset.voiceCompleted = "false";
          }
        }
        if (eventName === "timeupdate" && !isVoicePlaybackCompleted(audio)) {
          player.dataset.voiceCompleted = "false";
        }
        if (eventName === "ended") {
          player.dataset.voiceCompleted = "true";
        }
        if ((eventName === "pause" || eventName === "ended") && activeVoiceAudio === audio && (audio.paused || audio.ended)) {
          activeVoiceAudio = null;
        }
        syncVoicePlayerState(player);
      });
    });

    syncVoicePlayerState(player);
  });
}

async function fetchLinkPreview(url = "") {
  if (!url) {
    return null;
  }
  if (linkPreviewCache.has(url)) {
    return linkPreviewCache.get(url);
  }
  if (linkPreviewRequests.has(url)) {
    return linkPreviewRequests.get(url);
  }

  const request = apiFetch(`/link-preview?url=${encodeURIComponent(url)}`)
    .then((preview) => {
      linkPreviewCache.set(url, preview);
      linkPreviewRequests.delete(url);
      return preview;
    })
    .catch((error) => {
      linkPreviewRequests.delete(url);
      throw error;
    });

  linkPreviewRequests.set(url, request);
  return request;
}

function hydrateLinkPreviews(container) {
  if (!container || !areLinkPreviewsEnabled()) {
    return;
  }

  container.querySelectorAll("[data-message-link-preview]").forEach((node) => {
    const url = String(node.dataset.previewUrl || "").trim();
    if (!url || node.dataset.previewResolved === "true") {
      return;
    }

    const cachedPreview = linkPreviewCache.get(url);
    if (cachedPreview) {
      node.outerHTML = renderMessagePreviewCard(cachedPreview, url);
      return;
    }

    node.dataset.previewResolved = "pending";
    fetchLinkPreview(url)
      .then((preview) => {
        const targetNode = container.querySelector(`[data-message-link-preview][data-preview-url="${CSS.escape(url)}"]`);
        if (!targetNode) {
          return;
        }
        targetNode.outerHTML = renderMessagePreviewCard(preview, url);
      })
      .catch(() => {
        const targetNode = container.querySelector(`[data-message-link-preview][data-preview-url="${CSS.escape(url)}"]`);
        if (!targetNode) {
          return;
        }
        targetNode.classList.remove("is-loading");
        targetNode.dataset.previewResolved = "true";
        const titleNode = targetNode.querySelector(".message-link-preview-title");
        const descriptionNode = targetNode.querySelector(".message-link-preview-description");
        if (titleNode) {
          titleNode.textContent = urlparseHost(url);
        }
        if (descriptionNode) {
          descriptionNode.textContent = "Открыть ссылку";
        }
      });
  });
}

function hydrateServerInviteCards(container) {
  if (!container) {
    return;
  }

  container.querySelectorAll("[data-message-server-invite]").forEach((node) => {
    const code = String(node.dataset.messageServerInvite || "").trim();
    const url = String(node.dataset.serverInviteUrl || "").trim();
    if (!code || node.dataset.previewResolved === "true") {
      return;
    }

    const cachedInvite = serverInvitePreviewCache.get(code);
    if (cachedInvite) {
      node.outerHTML = renderServerInviteCard(cachedInvite, url);
      return;
    }

    node.dataset.previewResolved = "pending";
    fetchServerInvitePreview(code)
      .then((invite) => {
        const targetNode = container.querySelector(`[data-message-server-invite="${CSS.escape(code)}"]`);
        if (!targetNode) {
          return;
        }
        targetNode.outerHTML = renderServerInviteCard(invite, url);
      })
      .catch(() => {
        const targetNode = container.querySelector(`[data-message-server-invite="${CSS.escape(code)}"]`);
        if (!targetNode) {
          return;
        }
        targetNode.classList.remove("is-loading");
        targetNode.dataset.previewResolved = "true";
        const titleNode = targetNode.querySelector(".message-server-invite-title");
        const metaNode = targetNode.querySelector(".message-server-invite-meta");
        if (titleNode) {
          titleNode.textContent = "Приглашение недоступно";
        }
        if (metaNode) {
          metaNode.textContent = "Ссылка истекла или была отозвана";
        }
      });
  });
}

function getMessageKey(message) {
  if (message.id != null) {
    return `id:${message.id}`;
  }

  return [
    message.sender_id || "",
    message.sender_name || "",
    message.message_type || "text",
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

function getReplyPreviewText(reply = {}) {
  const messageType = String(reply?.message_type || "text");
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
    return String(reply?.text || "").trim() || "Системное сообщение";
  }
  return String(reply?.text || "").trim() || "Сообщение";
}

function renderMessageReplyPreview(reply = {}) {
  const messageId = Number(reply?.message_id || 0);
  if (!messageId) {
    return "";
  }

  return `
    <button type="button" class="message-reply-preview" data-reply-jump-id="${escapeHtml(String(messageId))}">
      <span class="message-reply-preview-author">${escapeHtml(String(reply?.sender_name || "Сообщение"))}</span>
      <span class="message-reply-preview-text">${escapeHtml(getReplyPreviewText(reply))}</span>
    </button>
  `;
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

function renderMessageForwardedMeta(forwardedFrom = {}) {
  const senderName = String(forwardedFrom?.sender_name || "").trim();
  if (!senderName) {
    return "";
  }

  const forwardedUserId = Number(forwardedFrom?.user_id || 0);
  const label = `Переслано от ${senderName}`;
  if (forwardedUserId) {
    return `
      <button
        type="button"
        class="message-forwarded-meta message-forwarded-meta-button"
        data-forwarded-from-user-id="${escapeHtml(String(forwardedUserId))}"
      >${escapeHtml(label)}</button>
    `;
  }

  return `<div class="message-forwarded-meta">${escapeHtml(label)}</div>`;
}

function getForwardedDialogItemText(item = {}) {
  const messageType = String(item?.message_type || "text");
  if (messageType === "voice") {
    return "Голосовое сообщение";
  }
  if (messageType === "photo") {
    return "Фотография";
  }
  if (messageType === "sticker") {
    return "Стикер";
  }
  if (getMessageAttachments(item).length && !String(item?.text || "").trim()) {
    return "Фотография";
  }
  return String(item?.text || "").trim() || "Сообщение";
}

function renderForwardedDialogCard(forwardedDialog = {}) {
  const items = Array.isArray(forwardedDialog?.items) ? forwardedDialog.items : [];
  if (!items.length) {
    return "";
  }

  const previewCount = 4;
  const title = String(forwardedDialog?.title || "Пересланный диалог").trim() || "Пересланный диалог";
  const collapsedCount = Math.max(0, items.length - previewCount);

  return `
    <section class="forwarded-dialog-card" data-forwarded-dialog-card="true">
      <div class="forwarded-dialog-card-header">
        <strong class="forwarded-dialog-card-title">${escapeHtml(title)}</strong>
        <span class="forwarded-dialog-card-count">${escapeHtml(formatSelectedMessagesCount(items.length))}</span>
      </div>
      <div class="forwarded-dialog-thread">
        ${items.map((item, index) => {
          const isOutgoing = String(item?.side || "incoming") === "outgoing";
          const isCollapsed = index >= previewCount;
          return `
            <article class="forwarded-dialog-item ${isOutgoing ? "outgoing" : "incoming"}" ${isCollapsed ? 'hidden data-forwarded-dialog-hidden-item="true"' : ""}>
              <div class="forwarded-dialog-item-head">
                <span class="forwarded-dialog-item-author">${escapeHtml(String(item?.original_sender_name || "Пользователь"))}</span>
                <span class="forwarded-dialog-item-time">${escapeHtml(formatTime(item?.created_at || ""))}</span>
              </div>
              <div class="forwarded-dialog-item-bubble">
                <p class="forwarded-dialog-item-text">${renderMessageText(getForwardedDialogItemText(item))}</p>
              </div>
            </article>
          `;
        }).join("")}
      </div>
      ${collapsedCount > 0 ? `
        <button type="button" class="forwarded-dialog-toggle" data-forwarded-dialog-toggle="expand">
          Показать полностью (${escapeHtml(String(collapsedCount))})
        </button>
      ` : ""}
    </section>
  `;
}

function renderDateDivider(value) {
  const label = formatChatDateDivider(value);
  if (!label) {
    return "";
  }

  return `<div class="message-date-divider" data-date-divider="true"><span class="message-date-divider-pill">${escapeHtml(label)}</span></div>`;
}

function formatThreadInfoDate(value) {
  const date = parseUtcDate(value);
  if (!date) {
    return "Пока нет";
  }

  return date.toLocaleDateString("ru-RU", {
    timeZone: getUserTimeZone(),
    day: "numeric",
    month: "long",
    year: "numeric"
  });
}

function formatThreadInfoCount(value) {
  const numericValue = Number(value || 0);
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return "0";
  }

  return new Intl.NumberFormat("ru-RU").format(Math.round(numericValue));
}

function isWideMessage(message) {
  const messageType = String(message?.message_type || message?.type || "").trim().toLowerCase();
  const layout = String(message?.layout || "").trim().toLowerCase();
  return messageType === "wide" || messageType === "special" || layout === "wide";
}

function renderWideMessage(message, currentUserId) {
  const own = String(message?.sender_id || "") === String(currentUserId || "");
  return `
    <article class="wide-message ${own ? "own" : ""}" ${message?.id != null ? `data-message-id="${escapeHtml(String(message.id))}"` : ""} data-message-type="${escapeHtml(String(message?.message_type || message?.type || "wide"))}" data-created-at="${escapeHtml(String(message?.created_at || ""))}" data-own="${own ? "true" : "false"}">
      <div class="wide-message-header">
        <div class="wide-message-author">${escapeHtml(message?.sender_name || "Пользователь")}</div>
        <span class="wide-message-badge">${escapeHtml(message?.badge || "Объявление")}</span>
      </div>
      <div class="wide-message-text">${renderMessageText(message?.text || "")}</div>
      <div class="wide-message-footer">
        <span class="message-time">${escapeHtml(formatTime(message?.created_at || ""))}</span>
      </div>
    </article>
  `;
}

function renderMessageItem(message, currentUserId, chatType) {
  const isSystem = (message.message_type || "text") === "system";
  const isVoice = (message.message_type || "text") === "voice";
  const isSticker = (message.message_type || "text") === "sticker";
  const isForwardedDialog = (message.message_type || "text") === "forwarded_dialog";
  const attachments = getMessageAttachments(message);
  const hasAttachments = attachments.length > 0;
  const hasText = Boolean(String(message?.text || "").trim());
  const own = !isSystem && String(message.sender_id) === String(currentUserId);
  const messageClasses = ["message"];
  if (own) {
    messageClasses.push("own");
  }
  if (chatType === "direct") {
    messageClasses.push("message-direct");
  }
  if (hasAttachments) {
    messageClasses.push("message-has-attachments");
  }
  if (hasAttachments && !hasText) {
    messageClasses.push("message-attachments-only");
  }

  if (isSystem) {
    return `
      <article
        class="message system"
        ${message.id != null ? `data-message-id="${escapeHtml(String(message.id))}"` : ""}
        data-message-type="system"
        data-created-at="${escapeHtml(String(message.created_at || ""))}"
        data-own="false"
      >
        <span class="message-system-pill">${escapeHtml(message.text || "")}</span>
      </article>
    `;
  }
  if (isWideMessage(message)) {
    return renderWideMessage(message, currentUserId);
  }
  return `
    <article class="${messageClasses.join(" ")}" ${message.id != null ? `data-message-id="${escapeHtml(String(message.id))}"` : ""} data-message-type="${escapeHtml(String(message.message_type || "text"))}" data-created-at="${escapeHtml(String(message.created_at || ""))}" data-own="${own ? "true" : "false"}">
      ${!own && message.sender_name && chatType === "group" ? `<button type="button" class="message-author message-author-button" data-message-author-id="${escapeHtml(String(message.sender_id || ""))}" data-message-author-name="${escapeHtml(message.sender_name)}">${renderSystemAccountLabel(message.sender_name, message.sender_username || "", { allowLabelFallback: true })}</button>` : ""}
      ${renderMessageForwardedMeta(message.forwarded_from)}
      ${renderMessageReplyPreview(message.reply)}
      ${isForwardedDialog ? renderForwardedDialogCard(message.forwarded_dialog) : isVoice ? renderVoiceMessageBody(message) : isSticker ? renderStickerMessageBody(message) : renderMessageStandardBody(message)}
      <div class="message-meta">
        ${renderEditedIndicator(message)}
        <span class="message-time">${escapeHtml(formatTime(message.created_at))}</span>
        ${renderReadIndicator(message, own, chatType)}
      </div>
    </article>
  `;
}

function renderPendingMessageItem(text, chatType, options = {}) {
  const directClass = chatType === "direct" ? " message-direct" : "";
  if (options.type === "wide") {
    return `
      <article class="wide-message own pending" data-pending-message="true" data-message-type="wide" data-own="true">
        <div class="wide-message-header">
          <div class="wide-message-author">${escapeHtml(options.senderName || "Вы")}</div>
          <span class="wide-message-badge">${escapeHtml(options.badge || "Объявление")}</span>
        </div>
        <div class="wide-message-text">${renderMessageText(text || "")}</div>
        <div class="wide-message-footer">
          <span class="message-status-indicator" aria-hidden="true">
            <span></span>
            <span></span>
            <span></span>
          </span>
        </div>
      </article>
    `;
  }
  if (Array.isArray(options.attachments) && options.attachments.length) {
    return `
      <article class="message own pending${directClass}" data-pending-message="true" data-own="true">
        ${text ? `<p class="message-text">${renderMessageText(text)}</p>` : ""}
        ${renderMessageAttachments(options.attachments)}
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

  if (options.type === "voice") {
    return `
      <article class="message own pending${directClass}" data-pending-message="true" data-message-type="voice" data-own="true">
        ${renderVoiceMessageBody({
          audio: { duration_ms: Number(options.durationMs || 0) }
        }, true)}
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

  if (options.type === "photo") {
    return `
      <article class="message own pending${directClass}" data-pending-message="true" data-message-type="photo" data-own="true">
        ${renderPhotoMessageBody({
          image: { url: options.previewUrl || "" }
        }, true)}
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

  if (options.type === "sticker") {
    return `
      <article class="message own pending${directClass}" data-pending-message="true" data-message-type="sticker" data-own="true">
        ${renderStickerMessageBody({
          sticker: { url: options.previewUrl || "" }
        }, true)}
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

  return `
    <article class="message own pending${directClass}" data-pending-message="true" data-own="true">
      <p class="message-text">${renderMessageText(text || "")}</p>
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

function rebuildDateDividers(container) {
  if (!container) {
    return;
  }

  container.querySelectorAll('[data-date-divider="true"]').forEach((node) => node.remove());

  let previousDateKey = "";
  const messageNodes = [...container.querySelectorAll(THREAD_RENDERED_MESSAGE_SELECTOR)];
  for (const messageNode of messageNodes) {
    const createdAt = messageNode.dataset.createdAt || "";
    const dateKey = getLocalDateKey(createdAt);
    if (!dateKey) {
      continue;
    }

    if (dateKey !== previousDateKey) {
      messageNode.insertAdjacentHTML("beforebegin", renderDateDivider(createdAt));
      previousDateKey = dateKey;
    }
  }
}

function isSystemMessageNode(messageNode) {
  return messageNode?.dataset.messageType === "system";
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
  rebuildDateDividers(container);
  initializeVoicePlayers(container);
  hydrateLinkPreviews(container);
  hydrateServerInviteCards(container);
}

function renderMessagesSkeleton() {
  return `
    <div class="messages-skeleton" aria-hidden="true">
      <div class="message-skeleton-row">
        <span class="message-skeleton-avatar skeleton"></span>
        <div class="message-skeleton-bubble">
          <span class="skeleton skeleton-text lg" style="width:42%"></span>
          <span class="skeleton skeleton-text" style="width:78%"></span>
          <span class="skeleton skeleton-text" style="width:64%"></span>
        </div>
      </div>
      <div class="message-skeleton-row own">
        <div class="message-skeleton-bubble">
          <span class="skeleton skeleton-text" style="width:72%"></span>
          <span class="skeleton skeleton-text" style="width:88%"></span>
        </div>
      </div>
      <div class="message-skeleton-row">
        <span class="message-skeleton-avatar skeleton"></span>
        <div class="message-skeleton-bubble">
          <span class="skeleton skeleton-text lg" style="width:36%"></span>
          <span class="skeleton skeleton-text" style="width:68%"></span>
          <span class="message-skeleton-media skeleton"></span>
        </div>
      </div>
      <div class="message-skeleton-row own">
        <div class="message-skeleton-bubble">
          <span class="skeleton skeleton-text" style="width:84%"></span>
          <span class="skeleton skeleton-text" style="width:58%"></span>
        </div>
      </div>
    </div>
  `;
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
  rebuildDateDividers(container);
  initializeVoicePlayers(container);
  hydrateLinkPreviews(container);
  hydrateServerInviteCards(container);
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
  rebuildDateDividers(container);
  initializeVoicePlayers(container);
  hydrateLinkPreviews(container);
  hydrateServerInviteCards(container);
  return insertedCount;
}

function isNearBottom(container) {
  return container.scrollHeight - container.scrollTop - container.clientHeight <= BOTTOM_THRESHOLD;
}

function scrollMessagesToBottom(container) {
  container.scrollTop = container.scrollHeight;
}

function appendPendingMessage(container, text, chatType, options = {}) {
  if (container.querySelector(".empty-state")) {
    container.innerHTML = "";
  }

  container.insertAdjacentHTML("beforeend", renderPendingMessageItem(text, chatType, options));
  return container.lastElementChild;
}

function removePendingMessage(node) {
  if (node?.parentNode) {
    node.parentNode.removeChild(node);
  }
}

function ensureEmptyState(container) {
  if (container.querySelector(".message, .wide-message") || container.querySelector(".empty-state")) {
    return;
  }

  container.innerHTML = '<div class="empty-state">Сообщений пока нет</div>';
}

function replaceMessageNode(container, message, currentUserId, chatType) {
  const messageNode = findThreadMessageNode(container, message.id);
  if (!messageNode) {
    return false;
  }

  messageNode.outerHTML = renderMessageItem(message, currentUserId, chatType);
  rebuildDateDividers(container);
  initializeVoicePlayers(container);
  hydrateLinkPreviews(container);
  hydrateServerInviteCards(container);
  return true;
}

function removeMessageNode(container, messageId) {
  const messageNode = findThreadMessageNode(container, messageId);
  if (!messageNode) {
    return false;
  }

  renderedMessages.delete(`id:${messageId}`);
  messageNode.remove();
  rebuildDateDividers(container);
  ensureEmptyState(container);
  return true;
}

function markOwnMessagesAsRead(container, uptoMessageId) {
  if (!uptoMessageId) return;

  container.querySelectorAll('.message.own[data-message-id], .wide-message.own[data-message-id]').forEach((node) => {
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
    <button type="button" data-action="reply">${renderActionMenuItemContent("/assets/icons/ui/Refund_back.svg", "Ответить")}</button>
    <button type="button" data-action="forward">${renderActionMenuItemContent("/assets/icons/ui/Refund_Forward.svg", "Переслать")}</button>
    <button type="button" data-action="select">${renderActionMenuItemContent("/assets/icons/ui/Check_round_fill.svg", "Выбрать")}</button>
    <button type="button" data-action="edit">${renderActionMenuItemContent("/assets/icons/ui/Edit_fill.svg", "Редактировать")}</button>
    <button type="button" data-action="delete-me">${renderActionMenuItemContent("/assets/icons/ui/Trash_line.svg", "Удалить у меня")}</button>
    <button type="button" data-action="delete-all" class="danger">${renderActionMenuItemContent("/assets/icons/ui/Trash.svg", "Удалить у всех")}</button>
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
      <button type="button" class="selection-toolbar-button" data-action="forward-dialog">Переслать как диалог</button>
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

function buildReplyBanner() {
  const banner = document.createElement("div");
  banner.className = "composer-reply-banner";
  banner.hidden = true;
  banner.innerHTML = `
    <div class="composer-reply-copy">
      <span class="composer-reply-title">Ответ</span>
      <strong class="composer-reply-author"></strong>
      <span class="composer-reply-text"></span>
    </div>
    <button type="button" class="composer-reply-cancel">Отмена</button>
  `;
  return banner;
}

function buildForwardModal() {
  const modal = document.createElement("div");
  modal.className = "forward-modal";
  modal.hidden = true;
  modal.innerHTML = `
    <div class="forward-modal-backdrop" data-forward-close="true"></div>
    <div class="forward-modal-card" role="dialog" aria-modal="true" aria-labelledby="forwardModalTitle">
      <div class="forward-modal-header">
        <div>
          <h3 class="forward-modal-title" id="forwardModalTitle">Переслать сообщение</h3>
          <p class="forward-modal-subtitle">Выберите чат, куда отправить сообщение</p>
        </div>
        <button type="button" class="icon-button" data-forward-close="true" aria-label="Закрыть"><img class="icon-asset" src="/assets/icons/ui/Close_round.svg" alt=""></button>
      </div>
      <input type="search" class="search-input forward-modal-search" placeholder="Поиск по чатам" data-forward-search>
      <div class="status forward-modal-status" data-forward-status></div>
      <div class="forward-modal-list" data-forward-list></div>
    </div>
  `;
  document.body.appendChild(modal);
  return modal;
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

function buildImageModal() {
  const modal = document.createElement("div");
  modal.className = "image-modal";
  modal.hidden = true;
  modal.innerHTML = `
    <div class="image-modal-backdrop" data-image-modal-close="true"></div>
    <div class="image-modal-dialog" role="dialog" aria-modal="true" aria-label="Просмотр изображения">
      <div class="image-modal-toolbar">
        <div class="image-modal-counter" data-image-modal-counter="true">1 / 1</div>
        <div class="image-modal-actions">
          <button type="button" class="icon-button image-modal-close" data-image-modal-close="true" aria-label="Закрыть">
            <img class="icon-asset" src="/assets/icons/ui/Close_round.svg" alt="">
          </button>
        </div>
      </div>
      <div class="image-modal-stage">
        <button type="button" class="image-modal-nav image-modal-nav-side is-prev" data-image-modal-nav="prev" aria-label="Предыдущее фото">
          <img class="icon-asset" src="/assets/icons/ui/Arrow_left.svg" alt="">
        </button>
        <div class="image-modal-viewport">
          <div class="image-modal-track" data-image-modal-track="true"></div>
        </div>
        <button type="button" class="image-modal-nav image-modal-nav-side is-next" data-image-modal-nav="next" aria-label="Следующее фото">
          <img class="icon-asset" src="/assets/icons/ui/Arrow_right.svg" alt="">
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  return modal;
}

function setChatTitle(titleOrInfo, subtitle = "", desktopSubtitle = "", desktopPresence = "") {
  const titleNode = document.getElementById("chatTitle");
  const subtitleNode = document.getElementById("chatSubtitle");
  const desktopSubtitleNode = document.getElementById("chatSubtitleDesktop");
  const desktopPresenceNode = document.getElementById("chatPresenceDesktop");
  const avatarNode = document.getElementById("chatAvatar");
  const info = titleOrInfo && typeof titleOrInfo === "object" ? titleOrInfo : null;
  const title = info ? (info.title || info.name || info.username || "Чат") : String(titleOrInfo || "Чат");
  if (titleNode) titleNode.innerHTML = renderSystemAccountLabel(title, info || {});
  if (subtitleNode) subtitleNode.innerHTML = subtitle;
  if (desktopSubtitleNode) desktopSubtitleNode.textContent = desktopSubtitle;
  if (desktopPresenceNode) desktopPresenceNode.innerHTML = desktopPresence;
  if (avatarNode) avatarNode.textContent = initials(title || "Чат");
}

function renderTypingBadge(label, options = {}) {
  const {
    compact = true,
    showDots = true
  } = options;
  const compactClass = compact ? " compact" : "";
  const dots = showDots ? `
    <span class="typing-dots" aria-hidden="true">
      <span></span>
      <span></span>
      <span></span>
    </span>
  ` : "";

  return `
    <span class="presence-badge typing${compactClass}">
      ${dots}<span class="presence-label">${escapeHtml(label)}</span>
    </span>
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

function renderDirectChatSubtitle(info) {
  if (info?.hide_presence) {
    return "";
  }
  return renderPresenceBadge(info, { compact: true, includeUsername: false, showDot: false });
}

function renderDirectChatDesktopPresence(info) {
  if (info?.hide_presence) {
    return "";
  }
  return renderPresenceBadge(info, { compact: true, includeUsername: false, showDot: false });
}

function renderDirectChatDesktopSubtitle(info) {
  return info?.username ? `@${info.username}` : "";
}

function getGroupPresenceText(info = {}) {
  const membersCount = Number(info?.members_count || info?.members?.length || 0);
  return `${membersCount} участников`;
}

function renderThreadMemberAvatar(member = {}) {
  const displayName = member?.name || member?.username || "U";
  const avatarLabel = member?.avatar_label || initials(displayName);
  const avatarUrl = String(
    member?.avatar_url || member?.photo_url || member?.profile_photo_url || ""
  ).trim();
  const presenceDot = !member?.hide_presence && member?.is_online
    ? '<span class="presence-dot online thread-member-presence-dot" aria-hidden="true"></span>'
    : "";

  if (avatarUrl) {
    return `
      <div class="avatar small thread-member-avatar has-image">
        <img src="${escapeHtml(avatarUrl)}" alt="${escapeHtml(displayName)}" loading="lazy">
        ${presenceDot}
      </div>
    `;
  }

  return `
    <div class="avatar small thread-member-avatar">
      ${escapeHtml(avatarLabel)}
      ${presenceDot}
    </div>
  `;
}

function renderGroupProfilePanel(info = {}) {
  const title = info?.title || "Группа";
  const isServerChannel = Boolean(getCurrentRouteInfo()?.serverId);
  if (isServerChannel) {
    return `
      <section class="thread-info-channel-heading">
        <h3 class="thread-info-name thread-info-channel-title">${escapeHtml(title)}</h3>
      </section>
    `;
  }
  return `
    <section class="thread-info-card thread-info-card-profile">
      <div class="thread-info-hero">
        <div class="avatar group-avatar thread-info-avatar">${escapeHtml(initials(title))}</div>
        <h3 class="thread-info-name">${escapeHtml(title)}</h3>
        <p class="thread-info-handle">${escapeHtml(getGroupPresenceText(info))}</p>
      </div>
    </section>
  `;
}

function fillThreadInfoPanel(info, chatType) {
  const profilePanelNode = document.getElementById("threadInfoProfilePanel");
  const chatCardNode = document.getElementById("threadInfoChatCard");
  const startedAtNode = document.getElementById("threadInfoStartedAt");
  const messagesCountNode = document.getElementById("threadInfoMessagesCount");
  const tagNode = document.getElementById("threadInfoTag");
  const menuTriggerNode = document.getElementById("threadInfoMenuTrigger");
  const inviteFactNode = document.getElementById("threadInfoInviteFact");
  const inviteLinkNode = document.getElementById("threadInfoInviteLink");
  const inviteCopyNode = document.getElementById("threadInfoInviteCopy");
  const inviteRegenerateNode = document.getElementById("threadInfoInviteRegenerate");
  const inviteStatusNode = document.getElementById("threadInfoInviteStatus");
  const membersWrapNode = document.getElementById("threadInfoMembersWrap");
  const membersListNode = document.getElementById("threadInfoMembersList");
  const memberAddTriggerNode = document.getElementById("threadMemberAddTrigger");

  if (!profilePanelNode || !startedAtNode || !messagesCountNode || !tagNode) {
    return;
  }

  const threadInfoType = chatType || "direct";
  const isEmbeddedUserProfile = threadInfoType === "direct" && document.body.dataset.chatType === "group";
  const title = getUserProfileDisplayName(info) || info?.title || info?.username || "Чат";
  const customTag = info?.id != null ? getChatTag(info.id, threadInfoType) : null;
  profilePanelNode.innerHTML = threadInfoType === "group"
    ? renderGroupProfilePanel(info)
    : renderUserProfilePanel({
        ...info,
        title
      }, { showActions: true });
  if (chatCardNode) {
    chatCardNode.hidden = isEmbeddedUserProfile;
  }
  startedAtNode.textContent = formatThreadInfoDate(info?.started_at);
  messagesCountNode.textContent = formatThreadInfoCount(info?.messages_count);

  if (customTag) {
    const styleVars = getChatTagStyleVars(customTag.color);
    tagNode.innerHTML = `
      <span
        class="chat-kind-label chat-custom-label"
        style="--chat-tag-bg: ${styleVars.background}; --chat-tag-border: ${styleVars.border}; --chat-tag-text: ${styleVars.text}; --chat-tag-solid: ${styleVars.solid};"
      >${escapeHtml(customTag.label)}</span>
    `;
  } else {
    tagNode.innerHTML = "";
  }

  if (inviteFactNode && inviteLinkNode && inviteCopyNode && inviteRegenerateNode && inviteStatusNode) {
    if (!isEmbeddedUserProfile && threadInfoType === "group" && info?.can_manage_invite && info?.invite?.url) {
      inviteFactNode.hidden = false;
      const inviteUrl = info.invite.url;
      const inviteLinkTextNode = document.getElementById("threadInfoInviteLinkText");
      if (inviteLinkTextNode) {
        inviteLinkTextNode.textContent = inviteUrl;
      } else {
        inviteLinkNode.textContent = inviteUrl;
      }
      inviteLinkNode.href = inviteUrl;
      inviteLinkNode.title = inviteUrl;
      inviteCopyNode.hidden = false;
      inviteRegenerateNode.hidden = false;
    } else {
      const inviteLinkTextNode = document.getElementById("threadInfoInviteLinkText");
      isThreadInviteExpanded = false;
      inviteFactNode.hidden = true;
      if (inviteLinkTextNode) {
        inviteLinkTextNode.textContent = "";
      } else {
        inviteLinkNode.textContent = "";
      }
      inviteLinkNode.removeAttribute("href");
      inviteLinkNode.removeAttribute("title");
      inviteCopyNode.hidden = true;
      inviteRegenerateNode.hidden = true;
      inviteStatusNode.textContent = "";
      inviteStatusNode.className = "status thread-info-invite-status";
    }
  }

  if (membersWrapNode && membersListNode) {
    if (!isEmbeddedUserProfile && threadInfoType === "group") {
      const members = Array.isArray(info?.members) ? info.members : [];
      const canEditGroup = Boolean(info?.can_edit_group);
      const canAddMembers = Boolean(info?.can_add_members);
      const threadInfoEditActionButton = document.querySelector('#threadInfoActionMenu [data-thread-info-action="edit-group"]');
      const isServerChannel = Boolean(getCurrentRouteInfo()?.serverId);
      membersWrapNode.hidden = isServerChannel;
      if (menuTriggerNode) {
        menuTriggerNode.hidden = !canEditGroup;
        menuTriggerNode.setAttribute("aria-label", isServerChannel ? "Действия канала" : "Действия группы");
      }
      if (threadInfoEditActionButton) {
        threadInfoEditActionButton.textContent = isServerChannel ? "Настройки канала" : "Редактировать группу";
      }
      if (memberAddTriggerNode) {
        memberAddTriggerNode.hidden = isServerChannel || !canAddMembers;
      }
      membersListNode.innerHTML = isServerChannel
        ? ""
        : members.length
        ? members.map((member) => `
          <article
            class="member-item"
            data-member-id="${escapeHtml(String(member.id))}"
            data-member-name="${escapeHtml(member.name || member.username || "User")}"
            data-member-username="${escapeHtml(member.username || "")}"
            data-member-is-admin="${member.is_admin ? "true" : "false"}"
            data-member-is-owner="${member.is_owner ? "true" : "false"}"
            data-member-can-manage="${member.can_manage ? "true" : "false"}"
          >
            ${renderThreadMemberAvatar(member)}
            <div class="result-meta">
              <div class="result-topline">
                <h3 class="result-name">${renderSystemAccountLabel(member.name || member.username || "User", member)}</h3>
                ${member.is_owner ? '<span class="thread-member-role owner">Создатель</span>' : member.is_admin ? '<span class="thread-member-role">Админ</span>' : ""}
              </div>
              <p class="result-username">${member.username ? renderSystemAccountLabel(`@${member.username}`, member) : ""}</p>
            </div>
            ${member.can_manage ? '<button type="button" class="thread-member-menu-hint" data-member-menu-trigger="true" aria-label="Действия с участником"><img class="icon-asset" src="/assets/icons/ui/Meatballs_menu.svg" alt=""></button>' : ""}
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
          <h3 class="result-name">${renderSystemAccountLabel(user.name || user.username || "User", user)}</h3>
          <p class="result-username">${user.username ? renderSystemAccountLabel(`@${user.username}`, user) : ""}</p>
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

function renderThreadSearchResults(results, chatType) {
  if (!Array.isArray(results) || !results.length) {
    return '<div class="empty-state">Ничего не найдено</div>';
  }

  return results.map((message) => {
    const authorName = message.sender_name || (chatType === "group" ? "Участник" : "Пользователь");
    const messageLabel = getMessageAttachments(message).length && !String(message.text || "").trim()
      ? "Фотография"
      : (message.text || "");
    return `
    <button
      class="thread-info-search-result"
      type="button"
      data-thread-search-message-id="${escapeHtml(String(message.id || ""))}"
    >
      <span class="thread-info-search-result-head">
        <strong class="thread-info-search-result-name">${escapeHtml(authorName)}</strong>
        <span class="thread-info-search-result-time">${escapeHtml(formatChatDateDivider(message.created_at) || formatDate(message.created_at))}, ${escapeHtml(formatTime(message.created_at))}</span>
      </span>
      <span class="thread-info-search-result-text">${escapeHtml(messageLabel)}</span>
    </button>
  `;
  }).join("");
}

function setInviteActionButton(button, iconPath, label) {
  if (!button) {
    return;
  }
  button.innerHTML = `
    <img class="menu-item-icon icon-asset" src="${iconPath}" alt="">
    <span class="menu-item-label">${escapeHtml(label)}</span>
  `;
  button.setAttribute("aria-label", label);
  button.setAttribute("title", label);
}

function setMessageSearchTarget(messageId) {
  document.querySelectorAll(".message.search-target, .wide-message.search-target").forEach((node) => {
    node.classList.remove("search-target");
  });

  if (!messageId) {
    return null;
  }

  const targetNode = findThreadMessageNode(document, messageId);
  if (!targetNode) {
    return null;
  }

  targetNode.classList.add("search-target");
  window.setTimeout(() => {
    targetNode.classList.remove("search-target");
  }, 2200);
  return targetNode;
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
  applyAppSettings();
  requireAuth();
  bindLogout();
  fillUserBadge();
  initSidebarProfile();
  await loadSidebar();
  startChatsAutoRefresh();

  const route = getCurrentRouteInfo();
  let chatId = route.chatId;
  let userId = route.userId;
  let serverId = route.serverId;
  let chatType = document.body.dataset.chatType || route.chatType || "direct";
  const currentUser = getCurrentUser() || {};

  if (!chatId && serverId) {
    try {
      const server = chatState.activeServer || await apiFetch(`/servers/${encodeURIComponent(serverId)}`);
      const defaultChannelId = server?.default_channel_id;
      if (defaultChannelId) {
        window.location.replace(getServerChannelRoute(serverId, defaultChannelId));
        return;
      }
      chatState.activeServer = server;
    } catch {
      window.location.replace(getChatsRoute());
      return;
    }
  }

  const messagesNode = document.getElementById("messages");
  const composer = document.getElementById("messageForm");
  const contentBody = document.querySelector(".content-body");
  const contentNode = document.querySelector(".content");
  const contentHeaderNode = document.querySelector(".content-header");
  const status = document.getElementById("messageStatus");
  const input = document.getElementById("messageInput");
  const scrollDownButton = document.getElementById("scrollDownButton");
  const titleNode = document.getElementById("chatTitle");
  const subtitleNode = document.getElementById("chatSubtitle");
  const threadInfoCloseButton = document.getElementById("threadInfoClose");
  const threadInfoMenuTrigger = document.getElementById("threadInfoMenuTrigger");
  const threadInfoActionMenu = document.getElementById("threadInfoActionMenu");
  const threadInfoInviteFact = document.getElementById("threadInfoInviteFact");
  const threadInfoInviteToggle = document.getElementById("threadInfoInviteToggle");
  const threadInfoInviteHint = document.getElementById("threadInfoInviteHint");
  const threadInfoInvitePanel = document.getElementById("threadInfoInvitePanel");
  const threadInfoInviteLink = document.getElementById("threadInfoInviteLink");
  const threadInfoInviteLinkText = document.getElementById("threadInfoInviteLinkText");
  const threadInfoInviteCopy = document.getElementById("threadInfoInviteCopy");
  const threadInfoInviteRegenerate = document.getElementById("threadInfoInviteRegenerate");
  const threadInfoInviteStatus = document.getElementById("threadInfoInviteStatus");
  const threadInfoMembersListNode = document.getElementById("threadInfoMembersList");
  const threadInfoEditActionButton = document.querySelector('#threadInfoActionMenu [data-thread-info-action="edit-group"]');
  const threadInfoSearchAction = document.getElementById("threadInfoSearchAction");
  const threadInfoSearchPanel = document.getElementById("threadInfoSearchPanel");
  const threadInfoSearchInput = document.getElementById("threadInfoSearchInput");
  const threadInfoSearchStatus = document.getElementById("threadInfoSearchStatus");
  const threadInfoSearchResults = document.getElementById("threadInfoSearchResults");
  const threadInfoSearchReset = document.getElementById("threadInfoSearchReset");
  const threadMobileSearchTrigger = document.getElementById("threadMobileSearchTrigger");
  const threadMobileSearch = document.getElementById("threadMobileSearch");
  const threadMobileSearchClose = document.getElementById("threadMobileSearchClose");
  const threadMobileSearchInput = document.getElementById("threadMobileSearchInput");
  const threadMobileSearchClear = document.getElementById("threadMobileSearchClear");
  const threadMobileSearchStatus = document.getElementById("threadMobileSearchStatus");
  const threadMobileSearchResults = document.getElementById("threadMobileSearchResults");
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
  const composerModeNode = document.getElementById("composerMode");
  const cancelWideModeButton = document.getElementById("cancelWideMode");
  const wideMessageButton = document.getElementById("wideMessageButton");
  const sendButton = composer?.querySelector('button[type="submit"]');
  const composerSendMenu = document.getElementById("composerSendMenu");
  const composerSendSuperButton = document.getElementById("composerSendSuperButton");
  const photoMessageButton = document.getElementById("photoMessageButton");
  const photoMessageInput = document.getElementById("photoMessageInput");
  const composerAttachmentsNode = document.getElementById("composerAttachments");
  const stickerPickerButton = document.getElementById("stickerPickerButton");
  const stickerPickerPopup = document.getElementById("stickerPickerPopup");
  const stickerPackTabs = document.getElementById("stickerPackTabs");
  const stickerGrid = document.getElementById("stickerGrid");
  const stickerPickerStatus = document.getElementById("stickerPickerStatus");
  const COMPOSER_MAX_HEIGHT = 144;
  const MESSAGE_IMAGE_MAX_DIMENSION = 1280;
  const MESSAGE_IMAGE_QUALITY = 0.78;
  const SUPPORTED_MESSAGE_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
  const messageActionMenu = buildMessageActionMenu();
  const editBanner = buildEditBanner();
  const replyBanner = buildReplyBanner();
  const forwardModal = buildForwardModal();
  const deleteUndoToast = buildDeleteUndoToast();
  const imageModal = buildImageModal();
  const selectionToolbar = buildSelectionToolbar();
  const threadMemberActionMenu = buildThreadMemberActionMenu();
  const threadBlockNotice = (() => {
    if (!composerWrap) {
      return null;
    }
    const noticeNode = document.createElement("div");
    noticeNode.className = "thread-block-notice";
    noticeNode.hidden = true;
    composerWrap.prepend(noticeNode);
    return noticeNode;
  })();
  let socket = null;
  let selectedUser = null;
  let currentThreadInfo = null;
  let activeThreadInfoView = null;
  let activeThreadInfoType = chatType;
  let pendingMessageState = null;
  let isSendingMessage = false;
  let isMarkingRead = false;
  let activeMessageMenuTarget = null;
  let hideMessageMenuTimer = null;
  let editingMessageState = null;
  let replyMessageState = null;
  let composerMode = "normal";
  let forwardMessageState = null;
  let selectedForwardTargetKey = "";
  let touchMenuPressTimer = null;
  let touchMenuTarget = null;
  let touchMenuPoint = null;
  let swipeReplyTarget = null;
  let swipeReplyStartPoint = null;
  let swipeReplyTracking = false;
  let threadMemberTouchTimer = null;
  let activeThreadMemberItem = null;
  let stickerLibraryState = null;
  let activeStickerPackId = "";

  function getComposerPlaceholder() {
    return composerMode === "wide" ? "Напишите объявление..." : "";
  }

  function canUseWideComposerMode() {
    return chatType === "group"
      && Boolean(currentThreadInfo?.server)
      && Boolean(currentThreadInfo?.current_user_permissions?.send_announcements);
  }

  function canSendNormalMessages() {
    return chatType !== "group"
      || !currentThreadInfo?.server
      || Boolean(currentThreadInfo?.can_send_messages);
  }

  function setComposerWideMode(nextMode) {
    const normalizedMode = nextMode === "wide" && canUseWideComposerMode() ? "wide" : "normal";
    if (normalizedMode === "wide" && editingMessageState) {
      setEditingMessageState(null);
    }
    composerMode = normalizedMode;
    input.placeholder = editingMessageState ? "Редактирование сообщения" : getComposerPlaceholder();
    composer.classList.toggle("is-wide-mode", composerMode === "wide");
    if (composerModeNode) {
      composerModeNode.hidden = composerMode !== "wide";
      composerModeNode.classList.toggle("active", composerMode === "wide");
    }
    if (wideMessageButton) {
      wideMessageButton.hidden = !canUseWideComposerMode();
      wideMessageButton.disabled = !canSendNormalMessages() && canUseWideComposerMode();
      wideMessageButton.classList.toggle("active", composerMode === "wide");
      wideMessageButton.setAttribute("aria-pressed", composerMode === "wide" ? "true" : "false");
    }
    updateComposerActionButton();
    resizeComposerInput();
  }

  function syncWideComposerControls() {
    if (!canSendNormalMessages() && canUseWideComposerMode()) {
      composerMode = "wide";
    }
    if (!canUseWideComposerMode() && composerMode === "wide") {
      composerMode = "normal";
    }
    setComposerWideMode(composerMode);
  }

  function syncComposerAvailability() {
    const canSendAnything = canSendNormalMessages() || canUseWideComposerMode();
    composer.hidden = !canSendAnything;
    composerWrap.hidden = !canSendAnything;
    syncWideComposerControls();
    if (!canSendAnything) {
      input.value = "";
      setComposerWideMode("normal");
      resizeComposerInput();
      updateComposerActionButton();
    }
  }
  let isLoadingStickerLibrary = false;
  let stickerPickerHideTimer = null;
  let threadMemberContacts = [];
  let threadMemberSearchDirectory = [];
  let filteredThreadMemberCandidates = [];
  let activeThreadMemberSearchRequestId = 0;
  let isSubmittingThreadMembers = false;
  let isSavingGroupDetails = false;
  let isRefreshingInviteLink = false;
  let isThreadInviteExpanded = false;
  let oldestMessageId = null;
  let hasMoreMessages = false;
  let isLoadingOlder = false;
  let pendingDeleteState = null;
  let deleteUndoCountdownTimer = null;
  let isSelectionMode = false;
  let composerAttachmentId = 0;
  let composerAttachments = [];
  let activeImageGallery = [];
  let activeImageIndex = 0;
  let imageModalTouchStartX = 0;
  let imageModalTouchDeltaX = 0;

  setChatTitle("Загрузка...", "Подготавливаем переписку", "Подготавливаем переписку");
  if (messagesNode) {
    messagesNode.innerHTML = renderMessagesSkeleton();
  }
  let isDraggingImageModal = false;
  let activeThreadNavigationToken = 0;
  let threadSearchDebounceTimer = null;
  let activeThreadSearchRequestId = 0;
  let isShowingSearchContext = false;
  let isMobileThreadSearchOpen = false;
  let typingPauseTimer = null;
  let typingCooldownTimer = null;
  let mediaRecorder = null;
  let recordingChunks = [];
  let recordingStream = null;
  let recordingStartedAt = 0;
  let isRecordingVoice = false;
  let recordingAudioContext = null;
  let recordingAnalyser = null;
  let recordingAnalyserData = null;
  let recordingLevelRafId = null;
  let typingState = {
    isSending: false,
    lastStartAt: 0,
    localActive: false,
    remoteUsers: new Map()
  };
  const selectedMessageIds = new Set();
  const committedDeleteEchoIds = new Set();

  if (!messagesNode || !composer || !input || !contentBody || !composerWrap || !contentNode) {
    return;
  }

  composer.parentNode.insertBefore(editBanner, composer);
  composer.parentNode.insertBefore(replyBanner, composer);
  contentBody.insertBefore(selectionToolbar, composerWrap);
  contentBody.appendChild(deleteUndoToast);

  function hideComposerSendMenu() {
    if (!composerSendMenu || composerSendMenu.hidden) {
      return;
    }
    composerSendMenu.hidden = true;
    sendButton?.setAttribute("aria-expanded", "false");
  }

  function openComposerSendMenu(clientX, clientY) {
    if (!composerSendMenu || !sendButton || !canUseWideComposerMode()) {
      return;
    }
    composerSendMenu.hidden = false;
    sendButton.setAttribute("aria-expanded", "true");
    const wrapRect = composerWrap.getBoundingClientRect();
    const menuRect = composerSendMenu.getBoundingClientRect();
    const left = Math.max(12, Math.min(clientX - wrapRect.left - menuRect.width + 18, wrapRect.width - menuRect.width - 12));
    const top = Math.max(12, Math.min(clientY - wrapRect.top - menuRect.height - 10, wrapRect.height - menuRect.height - 12));
    composerSendMenu.style.left = `${left}px`;
    composerSendMenu.style.top = `${top}px`;
  }

  function disconnectRealtime() {
    emitTypingStop();
    if (socket) {
      socket.disconnect();
      socket = null;
    }
  }

  function syncSidebarActiveThread() {
    const currentRoute = getCurrentRouteInfo();
    document.querySelectorAll(".chat-item.active").forEach((node) => {
      node.classList.remove("active");
    });
    document.querySelectorAll(".server-channel-row.active, .server-channel-item.active").forEach((node) => {
      node.classList.remove("active");
    });

    if (currentRoute.page === "direct-chat" && currentRoute.chatId) {
      const activeChatItem = document.querySelector(`.chat-item[data-chat-type="direct"][data-chat-id="${CSS.escape(String(currentRoute.chatId))}"]`);
      activeChatItem?.classList.add("active");
      return;
    }

    if (currentRoute.page === "group-chat" && currentRoute.chatId) {
      if (chatState.sidebarView === "server-detail" && currentRoute.serverId) {
        const activeChannel = document.querySelector(`.server-channel-item[data-chat-id="${CSS.escape(String(currentRoute.chatId))}"]`);
        activeChannel?.classList.add("active");
        activeChannel?.closest(".server-channel-row")?.classList.add("active");
        return;
      }

      const activeGroupItem = document.querySelector(`.chat-item[data-chat-type="group"][data-chat-id="${CSS.escape(String(currentRoute.chatId))}"]`);
      activeGroupItem?.classList.add("active");
    }
  }

  function resetThreadUiForNavigation() {
    activeThreadNavigationToken += 1;
    closeThreadInfoActionMenu();
    closeThreadMemberAddModal();
    closeThreadGroupEditModal();
    closeThreadSearchPanel();
    closeMobileThreadSearchMode();
    setThreadInfoOpen(false);
    hideMessageMenu();
    hideThreadMemberActionMenu();
    hideStickerPicker();
    closeForwardModal();
    closeImageModal();
    exitSelectionMode();
    setEditingMessageState(null);
    setReplyMessageState(null);
    clearComposerAttachments();
    selectedUser = null;
    currentThreadInfo = null;
    activeThreadInfoView = null;
    oldestMessageId = null;
    hasMoreMessages = false;
    isShowingSearchContext = false;
    if (threadSearchDebounceTimer) {
      window.clearTimeout(threadSearchDebounceTimer);
      threadSearchDebounceTimer = null;
    }
    if (typingPauseTimer) {
      window.clearTimeout(typingPauseTimer);
      typingPauseTimer = null;
    }
    if (typingCooldownTimer) {
      window.clearTimeout(typingCooldownTimer);
      typingCooldownTimer = null;
    }
    typingState.remoteUsers.clear();
    typingState.localActive = false;
    pendingMessageState = null;
    forwardMessageState = null;
    selectedForwardTargetKey = "";
    composerMode = "normal";
    status.textContent = "";
    status.className = "status thread-status";
    input.value = "";
    input.placeholder = getComposerPlaceholder();
    composer.hidden = false;
    composerWrap.hidden = false;
    resizeComposerInput();
    syncWideComposerControls();
    updateComposerActionButton();
    setChatTitle("Загрузка...", "Подготавливаем переписку", "Подготавливаем переписку");
    messagesNode.innerHTML = renderMessagesSkeleton();
    updateScrollDownButton(messagesNode, scrollDownButton);
  }

  async function switchThreadRoute(nextRoute, targetPath) {
    const nextPage = nextRoute?.page;
    if (nextPage !== "direct-chat" && nextPage !== "group-chat" && nextPage !== "server") {
      window.location.href = targetPath;
      return;
    }

    chatId = nextRoute.chatId || null;
    userId = nextRoute.userId || null;
    serverId = nextRoute.serverId || null;
    chatType = nextRoute.chatType || (nextPage === "group-chat" ? "group" : "direct");
    activeThreadInfoType = chatType;
    document.body.dataset.chatType = chatType;

    disconnectRealtime();
    resetThreadUiForNavigation();
    syncSidebarActiveThread();

    const navigationToken = activeThreadNavigationToken;
    let sidebarServerPromise = null;

    if (serverId) {
      const serverPreview = Array.isArray(chatState?.allServers)
        ? chatState.allServers.find((server) => String(server?.id || "") === String(serverId))
        : null;
      if (typeof writeSelectedServerId === "function") {
        writeSelectedServerId(serverId);
      }
      if (typeof writeStoredSidebarView === "function") {
        writeStoredSidebarView("server-detail");
      }
      if (typeof setSidebarMode === "function") {
        setSidebarMode("server-detail", serverPreview || chatState.activeServer || {
          id: serverId,
          title: serverPreview?.title || "Сервер",
          description: serverPreview?.description || ""
        });
      }
      if (typeof loadServerDetail === "function") {
        sidebarServerPromise = loadServerDetail(serverId, "chatList", { showLoading: true });
      }
    }

    try {
      if (!chatId && serverId) {
        const server = (sidebarServerPromise ? await sidebarServerPromise : null)
          || chatState.activeServer
          || await apiFetch(`/servers/${encodeURIComponent(serverId)}`);
        const defaultChannelId = server?.default_channel_id;
        if (defaultChannelId) {
          window.history.replaceState({}, "", getServerChannelRoute(serverId, defaultChannelId));
          await switchThreadRoute(getCurrentRouteInfo(), getServerChannelRoute(serverId, defaultChannelId));
          return;
        }
        chatState.activeServer = server;
      }

      if (chatId) {
        await loadThread();
        if (navigationToken !== activeThreadNavigationToken) {
          return;
        }
        await markCurrentChatAsRead();
        if (navigationToken !== activeThreadNavigationToken) {
          return;
        }
        connectRealtime();
      } else if (chatType !== "group" && userId) {
        const user = await loadSelectedUser();
        if (navigationToken !== activeThreadNavigationToken) {
          return;
        }
        renderPendingDirectChat(user);
      } else if (serverId) {
        messagesNode.innerHTML = '<div class="empty-state">В этом сервере пока нет каналов. Создайте первый канал в одной из категорий.</div>';
        status.textContent = "";
        composer.hidden = true;
      } else {
        throw new Error("Чат не найден");
      }
    } catch (error) {
      if (navigationToken !== activeThreadNavigationToken) {
        return;
      }
      messagesNode.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    }
  }

  function bindThreadRouteNavigation() {
    const list = document.getElementById("chatList");
    if (!list || list.dataset.threadRouteNavigationBound === "true") {
      return;
    }

    list.dataset.threadRouteNavigationBound = "true";
    list.addEventListener("click", (event) => {
      const link = event.target.closest(".chat-item[href], .server-channel-item[href]");
      if (!link) {
        return;
      }

      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }

      const href = String(link.getAttribute("href") || "").trim();
      if (!href || href.startsWith("http")) {
        return;
      }

      const targetUrl = new URL(href, window.location.origin);
      if (targetUrl.origin !== window.location.origin) {
        return;
      }

      const targetPath = `${targetUrl.pathname}${targetUrl.search}`;
      const currentPath = `${window.location.pathname}${window.location.search}`;
      if (targetPath === currentPath) {
        event.preventDefault();
        return;
      }

      event.preventDefault();
      window.history.pushState({}, "", targetPath);
      void switchThreadRoute(getCurrentRouteInfo(), targetPath);
    });

    window.addEventListener("popstate", () => {
      const nextRoute = getCurrentRouteInfo();
      if (nextRoute.page === "direct-chat" || nextRoute.page === "group-chat" || nextRoute.page === "server") {
        void switchThreadRoute(nextRoute, `${window.location.pathname}${window.location.search}`);
        return;
      }
      window.location.reload();
    });
  }

  bindThreadRouteNavigation();

  function setComposerBusyState(isBusy) {
    input.disabled = isBusy;
    if (sendButton) {
      sendButton.disabled = isBusy;
    }
    if (photoMessageButton) {
      photoMessageButton.disabled = isBusy || Boolean(editingMessageState);
    }
    if (stickerPickerButton) {
      stickerPickerButton.disabled = isBusy;
    }
    updateComposerActionButton();
  }

  function revokeComposerAttachmentPreview(attachment) {
    if (attachment?.previewUrl) {
      URL.revokeObjectURL(attachment.previewUrl);
    }
  }

  function clearComposerAttachments() {
    composerAttachments.forEach((attachment) => revokeComposerAttachmentPreview(attachment));
    composerAttachments = [];
    if (photoMessageInput) {
      photoMessageInput.value = "";
    }
    renderComposerAttachments();
  }

  function removeComposerAttachment(attachmentId) {
    const nextAttachments = [];
    for (const attachment of composerAttachments) {
      if (attachment.id === attachmentId) {
        revokeComposerAttachmentPreview(attachment);
        continue;
      }
      nextAttachments.push(attachment);
    }
    composerAttachments = nextAttachments;
    renderComposerAttachments();
  }

  function renderComposerAttachments() {
    if (!composerAttachmentsNode) {
      return;
    }

    if (!composerAttachments.length) {
      composerAttachmentsNode.hidden = true;
      composerAttachmentsNode.innerHTML = "";
      updateComposerActionButton();
      return;
    }

    composerAttachmentsNode.hidden = false;
    composerAttachmentsNode.innerHTML = composerAttachments.map((attachment, index) => `
      <div class="composer-preview-item">
        <img class="composer-preview" src="${escapeHtml(attachment.previewUrl)}" alt="Предпросмотр фото ${escapeHtml(String(index + 1))}">
        <button
          class="composer-preview-remove"
          type="button"
          data-remove-composer-attachment="${escapeHtml(String(attachment.id))}"
          aria-label="Удалить фотографию"
        >×</button>
      </div>
    `).join("");
    updateComposerActionButton();
  }

  function isSupportedMessageImageFile(file) {
    return SUPPORTED_MESSAGE_IMAGE_TYPES.has(String(file?.type || "").toLowerCase());
  }

  function getMessageImageFilename(name = "photo") {
    const baseName = String(name || "photo").replace(/\.[^.]+$/, "").trim() || "photo";
    return `${baseName}.jpg`;
  }

  function loadImageForCompression(file) {
    return new Promise((resolve, reject) => {
      const objectUrl = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => {
        URL.revokeObjectURL(objectUrl);
        resolve(image);
      };
      image.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        reject(new Error("Не удалось обработать изображение"));
      };
      image.src = objectUrl;
    });
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) {
          resolve(blob);
          return;
        }
        reject(new Error("Не удалось сжать изображение"));
      }, type, quality);
    });
  }

  async function compressImage(file) {
    const image = await loadImageForCompression(file);
    const originalWidth = Math.max(1, Number(image.naturalWidth || image.width || 1));
    const originalHeight = Math.max(1, Number(image.naturalHeight || image.height || 1));
    const scale = Math.min(1, MESSAGE_IMAGE_MAX_DIMENSION / Math.max(originalWidth, originalHeight));
    const targetWidth = Math.max(1, Math.round(originalWidth * scale));
    const targetHeight = Math.max(1, Math.round(originalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) {
      throw new Error("Canvas недоступен для обработки изображения");
    }
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, targetWidth, targetHeight);
    context.drawImage(image, 0, 0, targetWidth, targetHeight);
    const blob = await canvasToBlob(canvas, "image/jpeg", MESSAGE_IMAGE_QUALITY);
    return new File([blob], getMessageImageFilename(file?.name), {
      type: "image/jpeg",
      lastModified: Date.now()
    });
  }

  function getComposerAttachmentPayload() {
    return composerAttachments.map((attachment) => ({
      url: attachment.previewUrl
    }));
  }

  function appendComposerAttachments(files = []) {
    const validFiles = [];
    const unsupportedFiles = [];
    for (const file of files) {
      if (!file) {
        continue;
      }
      if (!isSupportedMessageImageFile(file)) {
        unsupportedFiles.push(file.name || "Файл");
        continue;
      }
      validFiles.push(file);
    }

    if (validFiles.length) {
      composerAttachments = composerAttachments.concat(validFiles.map((file) => ({
        id: composerAttachmentId += 1,
        file,
        previewUrl: URL.createObjectURL(file)
      })));
      renderComposerAttachments();
      status.textContent = "";
      status.className = "status thread-status";
    }

    if (unsupportedFiles.length) {
      status.textContent = `Поддерживаются только JPG, PNG и WEBP: ${unsupportedFiles.join(", ")}`;
      status.className = "status error";
    }
  }

  function syncImageModal() {
    const trackNode = imageModal?.querySelector('[data-image-modal-track="true"]');
    const counterNode = imageModal?.querySelector('[data-image-modal-counter="true"]');
    const prevButton = imageModal?.querySelector('[data-image-modal-nav="prev"]');
    const nextButton = imageModal?.querySelector('[data-image-modal-nav="next"]');
    if (!imageModal || !trackNode || !activeImageGallery.length) {
      return;
    }
    const safeIndex = Math.min(Math.max(activeImageIndex, 0), activeImageGallery.length - 1);
    activeImageIndex = safeIndex;
    if (trackNode.dataset.gallerySignature !== activeImageGallery.join("|")) {
      trackNode.dataset.gallerySignature = activeImageGallery.join("|");
      trackNode.innerHTML = activeImageGallery.map((src, index) => `
        <div class="image-modal-slide" data-image-modal-slide="${escapeHtml(String(index))}">
          <img class="image-modal-image" src="${escapeHtml(src)}" alt="Просмотр изображения ${escapeHtml(String(index + 1))}">
        </div>
      `).join("");
    }
    trackNode.classList.remove("is-dragging");
    trackNode.style.transition = "";
    trackNode.style.transform = `translateX(-${safeIndex * 100}%)`;
    if (counterNode) {
      counterNode.textContent = `${safeIndex + 1} / ${activeImageGallery.length}`;
    }
    if (prevButton) {
      prevButton.disabled = activeImageGallery.length <= 1;
    }
    if (nextButton) {
      nextButton.disabled = activeImageGallery.length <= 1;
    }
  }

  function stepImageModal(direction = 1) {
    if (!activeImageGallery.length) {
      return;
    }
    activeImageIndex = (activeImageIndex + direction + activeImageGallery.length) % activeImageGallery.length;
    syncImageModal();
  }

  function updateImageModalDrag(deltaX = 0) {
    const trackNode = imageModal?.querySelector('[data-image-modal-track="true"]');
    const viewportNode = imageModal?.querySelector(".image-modal-viewport");
    if (!trackNode || !viewportNode || !activeImageGallery.length) {
      return;
    }

    let clampedDeltaX = Number(deltaX || 0);
    if ((activeImageIndex === 0 && clampedDeltaX > 0) || (activeImageIndex === activeImageGallery.length - 1 && clampedDeltaX < 0)) {
      clampedDeltaX *= 0.32;
    }

    trackNode.classList.add("is-dragging");
    trackNode.style.transition = "none";
    trackNode.style.transform = `translateX(calc(-${activeImageIndex * 100}% + ${clampedDeltaX}px))`;
    imageModalTouchDeltaX = clampedDeltaX;
  }

  function settleImageModalDrag() {
    const viewportNode = imageModal?.querySelector(".image-modal-viewport");
    const viewportWidth = Math.max(1, viewportNode?.clientWidth || 1);
    const threshold = Math.min(140, viewportWidth * 0.18);
    const deltaX = imageModalTouchDeltaX;

    isDraggingImageModal = false;
    imageModalTouchDeltaX = 0;
    if (Math.abs(deltaX) >= threshold && activeImageGallery.length > 1) {
      stepImageModal(deltaX > 0 ? -1 : 1);
      return;
    }
    syncImageModal();
  }

  function openImageModal(src = "", gallery = [], startIndex = 0) {
    if (!imageModal || !src) {
      return;
    }
    activeImageGallery = Array.isArray(gallery) && gallery.length ? gallery : [src];
    const fallbackIndex = activeImageGallery.indexOf(src);
    activeImageIndex = startIndex >= 0 ? startIndex : (fallbackIndex >= 0 ? fallbackIndex : 0);
    syncImageModal();
    imageModal.hidden = false;
    document.body.classList.add("modal-open");
  }

  function closeImageModal() {
    const trackNode = imageModal?.querySelector('[data-image-modal-track="true"]');
    if (!imageModal || imageModal.hidden) {
      return;
    }
    imageModal.hidden = true;
    if (trackNode) {
      trackNode.innerHTML = "";
      trackNode.style.transform = "translateX(0)";
      trackNode.dataset.gallerySignature = "";
    }
    activeImageGallery = [];
    activeImageIndex = 0;
    imageModalTouchStartX = 0;
    imageModalTouchDeltaX = 0;
    isDraggingImageModal = false;
    document.body.classList.remove("modal-open");
  }

  function hideStickerPicker() {
    if (!stickerPickerPopup || stickerPickerPopup.hidden) {
      return;
    }
    if (stickerPickerHideTimer) {
      window.clearTimeout(stickerPickerHideTimer);
      stickerPickerHideTimer = null;
    }
    stickerPickerPopup.classList.remove("is-open");
    stickerPickerButton?.setAttribute("aria-expanded", "false");
    stickerPickerHideTimer = window.setTimeout(() => {
      stickerPickerPopup.hidden = true;
      stickerPickerHideTimer = null;
    }, 220);
  }

  function setStickerPickerStatus(message = "", type = "") {
    if (!stickerPickerStatus) {
      return;
    }
    stickerPickerStatus.textContent = message;
    stickerPickerStatus.className = `sticker-picker-status ${type}`.trim();
  }

  function flattenStickerPacks(library = {}) {
    return [
      ...(Array.isArray(library.default_packs) ? library.default_packs : []),
      ...(Array.isArray(library.my_packs) ? library.my_packs : []),
      ...(Array.isArray(library.added_packs) ? library.added_packs : [])
    ];
  }

  function renderStickerPicker() {
    if (!stickerPackTabs || !stickerGrid) {
      return;
    }

    const packs = flattenStickerPacks(stickerLibraryState);
    if (!packs.length) {
      stickerPackTabs.innerHTML = "";
      stickerGrid.innerHTML = '<div class="sticker-picker-empty">Стикеров пока нет</div>';
      return;
    }

    const activePack = packs.find((pack) => String(pack.id) === String(activeStickerPackId)) || packs[0];
    activeStickerPackId = String(activePack.id);

    stickerPackTabs.innerHTML = packs.map((pack) => `
      <button
        class="sticker-pack-tab${String(pack.id) === activeStickerPackId ? " is-active" : ""}"
        type="button"
        data-sticker-pack-id="${escapeHtml(String(pack.id))}"
      >
        ${escapeHtml(pack.title || "Pack")}
      </button>
    `).join("");

    const stickers = Array.isArray(activePack.stickers) ? activePack.stickers : [];
    stickerGrid.innerHTML = stickers.length
      ? stickers.map((sticker) => `
          <button
            class="sticker-grid-item"
            type="button"
            data-sticker-id="${escapeHtml(String(sticker.id || ""))}"
            data-sticker-url="${escapeHtml(String(sticker.url || ""))}"
            aria-label="Отправить стикер"
          >
            <img class="sticker-grid-image" src="${escapeHtml(String(sticker.url || ""))}" alt="${escapeHtml(sticker.title || "Стикер")}" loading="lazy">
          </button>
        `).join("")
      : '<div class="sticker-picker-empty">В этом паке пока нет стикеров</div>';
  }

  async function loadStickerLibrary(force = false) {
    if (isLoadingStickerLibrary || (stickerLibraryState && !force)) {
      return stickerLibraryState;
    }

    isLoadingStickerLibrary = true;
    setStickerPickerStatus("Загрузка стикеров...", "loading");
    try {
      stickerLibraryState = await apiFetch("/sticker-library");
      const packs = flattenStickerPacks(stickerLibraryState);
      activeStickerPackId = packs.length ? String(packs[0].id || "") : "";
      renderStickerPicker();
      setStickerPickerStatus("", "");
      return stickerLibraryState;
    } catch (error) {
      setStickerPickerStatus(error.message, "error");
      throw error;
    } finally {
      isLoadingStickerLibrary = false;
    }
  }

  async function showStickerPicker() {
    if (!stickerPickerPopup) {
      return;
    }

    if (stickerPickerPopup.hidden) {
      if (stickerPickerHideTimer) {
        window.clearTimeout(stickerPickerHideTimer);
        stickerPickerHideTimer = null;
      }
      stickerPickerPopup.hidden = false;
      stickerPickerButton?.setAttribute("aria-expanded", "true");
      window.requestAnimationFrame(() => {
        stickerPickerPopup.classList.add("is-open");
      });
      try {
        await loadStickerLibrary();
      } catch {
        // keep popup open with error state
      }
      return;
    }

    hideStickerPicker();
  }

  function resizeComposerInput() {
    if (!input) {
      return;
    }

    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, COMPOSER_MAX_HEIGHT)}px`;
  }

  function updateComposerActionButton() {
    if (sendButton) {
      const hasText = Boolean(input.value.trim());
      const hasAttachments = composerAttachments.length > 0;
      const canRecordVoice = canSendNormalMessages() && composerMode !== "wide" && !hasAttachments && !editingMessageState;
      const state = isRecordingVoice ? "recording" : (editingMessageState ? "save" : ((hasText || hasAttachments || composerMode === "wide") ? "send" : "idle"));
      const labels = {
        idle: canRecordVoice ? "Записать голосовое сообщение" : "Отправить сообщение",
        send: "Отправить сообщение",
        save: "Сохранить изменения",
        recording: "Остановить запись голосового сообщения"
      };
      const titles = {
        idle: canRecordVoice ? "Голосовое сообщение" : "Отправить",
        send: "Отправить",
        save: "Сохранить",
        recording: "Остановить запись"
      };
      sendButton.dataset.composerState = state;
      sendButton.setAttribute("aria-label", labels[state]);
      sendButton.setAttribute("title", titles[state]);
      sendButton.innerHTML = state === "send"
        ? '<span class="composer-action-glyph" aria-hidden="true">➤</span>'
        : `<img class="icon-asset" src="${COMPOSER_ACTION_ICONS[state]}" alt="">`;
      sendButton.disabled = isSendingMessage || (Boolean(input.disabled) && !isRecordingVoice);
      sendButton.style.setProperty("--voice-record-level", isRecordingVoice ? "0.28" : "0");
      sendButton.style.setProperty("--voice-record-scale", isRecordingVoice ? "1" : "0");
    }
    if (photoMessageButton) {
      photoMessageButton.disabled = isSendingMessage || Boolean(input.disabled) || Boolean(editingMessageState) || composerMode === "wide";
    }
  }

  function stopRecordingLevelMeter() {
    if (recordingLevelRafId) {
      window.cancelAnimationFrame(recordingLevelRafId);
      recordingLevelRafId = null;
    }
    if (recordingAudioContext) {
      recordingAudioContext.close().catch(() => {});
      recordingAudioContext = null;
    }
    recordingAnalyser = null;
    recordingAnalyserData = null;
    if (sendButton) {
      sendButton.style.setProperty("--voice-record-level", "0");
      sendButton.style.setProperty("--voice-record-scale", "0");
    }
  }

  function startRecordingLevelMeter(stream) {
    stopRecordingLevelMeter();
    if (!stream || !window.AudioContext) {
      return;
    }

    try {
      recordingAudioContext = new window.AudioContext();
      const source = recordingAudioContext.createMediaStreamSource(stream);
      recordingAnalyser = recordingAudioContext.createAnalyser();
      recordingAnalyser.fftSize = 256;
      recordingAnalyser.smoothingTimeConstant = 0.72;
      recordingAnalyserData = new Uint8Array(recordingAnalyser.fftSize);
      source.connect(recordingAnalyser);

      const tick = () => {
        if (!recordingAnalyser || !recordingAnalyserData || !isRecordingVoice) {
          return;
        }

        recordingAnalyser.getByteTimeDomainData(recordingAnalyserData);
        let sum = 0;
        for (let index = 0; index < recordingAnalyserData.length; index += 1) {
          const normalized = (recordingAnalyserData[index] - 128) / 128;
          sum += normalized * normalized;
        }
        const rms = Math.sqrt(sum / recordingAnalyserData.length);
        const level = Math.min(1, rms * 4.8);
        const glow = 0.24 + level * 0.42;
        const scale = 0.62 + level * 0.85;
        if (sendButton) {
          sendButton.style.setProperty("--voice-record-level", glow.toFixed(3));
          sendButton.style.setProperty("--voice-record-scale", scale.toFixed(3));
        }
        recordingLevelRafId = window.requestAnimationFrame(tick);
      };

      recordingLevelRafId = window.requestAnimationFrame(tick);
    } catch {
      stopRecordingLevelMeter();
    }
  }

  function releaseRecordingStream() {
    stopRecordingLevelMeter();
    if (recordingStream) {
      recordingStream.getTracks().forEach((track) => track.stop());
      recordingStream = null;
    }
  }

  async function sendVoiceMessage(blob, durationMs) {
    const shouldStickToBottom = isNearBottom(messagesNode);
    const pendingMessageNode = appendPendingMessage(messagesNode, "", chatType, {
      type: "voice",
      durationMs
    });
    pendingMessageState = { text: "", node: pendingMessageNode, type: "voice" };
    if (shouldStickToBottom) {
      scrollMessagesToBottom(messagesNode);
    }
    updateScrollDownButton(messagesNode, scrollDownButton);

    try {
      const hadChatId = Boolean(chatId);
      if (!hadChatId && chatType !== "group") {
        await createDirectChatOnFirstMessage();
      }

      const formData = new FormData();
      const voiceExtension = blob.type.includes("ogg")
        ? "ogg"
        : (blob.type.includes("mp4") || blob.type.includes("m4a") ? "m4a" : "webm");
      formData.append("voice", blob, `voice-message.${voiceExtension}`);
      formData.append("duration_ms", String(Math.max(0, Math.round(durationMs))));
      if (replyMessageState?.messageId) {
        formData.append("reply_to_id", String(replyMessageState.messageId));
      }
      const path = chatType === "group" ? `/groups/${chatId}/voice` : `/chats/${chatId}/voice`;
      const sentMessage = await apiFetch(path, {
        method: "POST",
        body: formData
      });

      removePendingMessage(pendingMessageNode);
      pendingMessageState = null;
      appendMessage(messagesNode, sentMessage, currentUser.id, chatType);
      syncMessageSelectionState(sentMessage.id);
      if (shouldStickToBottom) {
        scrollMessagesToBottom(messagesNode);
      }

      if (!hadChatId && chatType !== "group") {
        await loadSidebar("chatList", { showLoading: false });
        await loadThread();
        await markCurrentChatAsRead();
        connectRealtime();
      }
      setReplyMessageState(null);
      status.textContent = "";
      status.className = "status thread-status";
    } catch (error) {
      status.textContent = error.message;
      status.className = "status error";
    } finally {
      if (pendingMessageState?.node === pendingMessageNode) {
        removePendingMessage(pendingMessageNode);
        pendingMessageState = null;
      }
      updateScrollDownButton(messagesNode, scrollDownButton);
    }
  }

  async function sendPhotoMessage(file) {
    if (!file) {
      return;
    }

    const shouldStickToBottom = isNearBottom(messagesNode);
    const previewUrl = URL.createObjectURL(file);
    const pendingMessageNode = appendPendingMessage(messagesNode, "", chatType, {
      type: "photo",
      previewUrl
    });
    pendingMessageState = { text: "", node: pendingMessageNode, type: "photo" };
    setComposerBusyState(true);
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

      const formData = new FormData();
      formData.append("photo", file, file.name || "photo-message");
      if (replyMessageState?.messageId) {
        formData.append("reply_to_id", String(replyMessageState.messageId));
      }
      const path = chatType === "group" ? `/groups/${chatId}/photo` : `/chats/${chatId}/photo`;
      const sentMessage = await apiFetch(path, {
        method: "POST",
        body: formData
      });

      removePendingMessage(pendingMessageNode);
      pendingMessageState = null;
      appendMessage(messagesNode, sentMessage, currentUser.id, chatType);
      syncMessageSelectionState(sentMessage.id);
      if (shouldStickToBottom) {
        scrollMessagesToBottom(messagesNode);
      }

      if (!hadChatId && chatType !== "group") {
        await loadSidebar("chatList", { showLoading: false });
        await loadThread();
        await markCurrentChatAsRead();
        connectRealtime();
      }
      setReplyMessageState(null);
      status.textContent = "";
      status.className = "status thread-status";
    } catch (error) {
      status.textContent = error.message;
      status.className = "status error";
    } finally {
      URL.revokeObjectURL(previewUrl);
      if (pendingMessageState?.node === pendingMessageNode) {
        removePendingMessage(pendingMessageNode);
        pendingMessageState = null;
      }
      setComposerBusyState(false);
      updateScrollDownButton(messagesNode, scrollDownButton);
      if (photoMessageInput) {
        photoMessageInput.value = "";
      }
    }
  }

  async function sendStickerMessage(sticker) {
    const stickerId = Number(sticker?.id || 0);
    const previewUrl = String(sticker?.url || "").trim();
    if (!stickerId || !previewUrl) {
      return;
    }

    const shouldStickToBottom = isNearBottom(messagesNode);
    const pendingMessageNode = appendPendingMessage(messagesNode, "", chatType, {
      type: "sticker",
      previewUrl
    });
    pendingMessageState = { text: "", node: pendingMessageNode, type: "sticker" };
    setComposerBusyState(true);
    hideStickerPicker();
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

      const path = chatType === "group" ? `/groups/${chatId}/sticker` : `/chats/${chatId}/sticker`;
      const sentMessage = await apiFetch(path, {
        method: "POST",
        body: JSON.stringify({
          sticker_id: stickerId,
          reply_to_id: replyMessageState?.messageId || null
        })
      });

      removePendingMessage(pendingMessageNode);
      pendingMessageState = null;
      appendMessage(messagesNode, sentMessage, currentUser.id, chatType);
      syncMessageSelectionState(sentMessage.id);
      if (shouldStickToBottom) {
        scrollMessagesToBottom(messagesNode);
      }

      if (!hadChatId && chatType !== "group") {
        await loadSidebar("chatList", { showLoading: false });
        await loadThread();
        await markCurrentChatAsRead();
        connectRealtime();
      }
      setReplyMessageState(null);
      status.textContent = "";
      status.className = "status thread-status";
    } catch (error) {
      status.textContent = error.message;
      status.className = "status error";
    } finally {
      if (pendingMessageState?.node === pendingMessageNode) {
        removePendingMessage(pendingMessageNode);
        pendingMessageState = null;
      }
      setComposerBusyState(false);
      updateScrollDownButton(messagesNode, scrollDownButton);
    }
  }

  async function startVoiceRecording() {
    if (isSendingMessage || isRecordingVoice || editingMessageState) {
      return;
    }
    if (!window.MediaRecorder || !navigator.mediaDevices?.getUserMedia) {
      status.textContent = "Запись голосовых не поддерживается в этом браузере";
      status.className = "status error";
      return;
    }

    try {
      emitTypingStop();
      recordingStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      startRecordingLevelMeter(recordingStream);
      const mimeCandidates = [
        "audio/mp4;codecs=mp4a.40.2",
        "audio/mp4",
        "audio/x-m4a",
        "audio/webm;codecs=opus",
        "audio/ogg;codecs=opus",
        "audio/webm",
        "audio/ogg"
      ];
      const mimeType = mimeCandidates.find((candidate) => window.MediaRecorder.isTypeSupported?.(candidate)) || "";
      mediaRecorder = mimeType ? new MediaRecorder(recordingStream, { mimeType }) : new MediaRecorder(recordingStream);
      recordingChunks = [];
      mediaRecorder.addEventListener("dataavailable", (event) => {
        if (event.data && event.data.size > 0) {
          recordingChunks.push(event.data);
        }
      });
      mediaRecorder.addEventListener("stop", async () => {
        const recordedType = mediaRecorder?.mimeType || mimeType || "audio/webm";
        const blob = new Blob(recordingChunks, { type: recordedType });
        const durationMs = Math.max(0, Date.now() - recordingStartedAt);
        recordingChunks = [];
        mediaRecorder = null;
        releaseRecordingStream();
        isRecordingVoice = false;
        setComposerBusyState(false);
        updateComposerActionButton();

        if (!blob.size || durationMs < 400) {
          status.textContent = "Запись слишком короткая";
          status.className = "status error";
          return;
        }

        isSendingMessage = true;
        setComposerBusyState(true);
        status.textContent = "Отправляем голосовое...";
        status.className = "status thread-status";
        try {
          await sendVoiceMessage(blob, durationMs);
        } finally {
          isSendingMessage = false;
          setComposerBusyState(false);
          input.focus();
        }
      }, { once: true });

      mediaRecorder.start(250);
      recordingStartedAt = Date.now();
      isRecordingVoice = true;
      input.disabled = true;
      if (photoMessageButton) {
        photoMessageButton.disabled = true;
      }
      updateComposerActionButton();
      status.textContent = "";
      status.className = "status thread-status";
    } catch (error) {
      releaseRecordingStream();
      mediaRecorder = null;
      isRecordingVoice = false;
      updateComposerActionButton();
      status.textContent = "Не удалось начать запись";
      status.className = "status error";
    }
  }

  function stopVoiceRecording() {
    if (!isRecordingVoice || !mediaRecorder) {
      return;
    }
    status.textContent = "Обрабатываем запись...";
    status.className = "status thread-status";
    if (mediaRecorder.state === "recording" && typeof mediaRecorder.requestData === "function") {
      try {
        mediaRecorder.requestData();
      } catch {
        // Some mobile browsers reject manual flush during shutdown.
      }
    }
    mediaRecorder.stop();
  }

  async function submitComposerMessage(options = {}) {
    const forceWide = Boolean(options.forceWide);
    if (isSendingMessage || isRecordingVoice) return;

    const rawText = input.value.trim();
    const wideCommandMatch = rawText.match(/^\/(?:wide|announce)\s+([\s\S]+)$/i);
    const isWideCommand = Boolean(wideCommandMatch);
    const isWideSubmit = forceWide || composerMode === "wide" || (isWideCommand && canUseWideComposerMode());
    const text = isWideCommand ? String(wideCommandMatch?.[1] || "").trim() : rawText;
    const hasAttachments = composerAttachments.length > 0;

    if (forceWide && !canUseWideComposerMode()) {
      return;
    }
    if (!text && !hasAttachments) {
      if (forceWide) {
        status.textContent = "Введите текст для суперсообщения";
        status.className = "status error";
      }
      return;
    }
    if (isWideSubmit && hasAttachments) {
      status.textContent = "Широкие сообщения пока не поддерживают вложения";
      status.className = "status error";
      return;
    }

    if (editingMessageState) {
      emitTypingStop();
      if (text === editingMessageState.text.trim()) {
        setEditingMessageState(null);
        input.value = "";
        resizeComposerInput();
        updateComposerActionButton();
        status.textContent = "";
        status.className = "status thread-status";
        return;
      }

      isSendingMessage = true;
      setComposerBusyState(true);
      status.textContent = "";
      status.className = "status thread-status";

      try {
        const updatedMessage = await apiFetch(editingMessageState.basePath, {
          method: "PATCH",
          body: JSON.stringify({ text })
        });

        setEditingMessageState(null);
        input.value = "";
        resizeComposerInput();
        updateComposerActionButton();
        replaceMessageNode(messagesNode, updatedMessage, currentUser.id, chatType);
        syncMessageSelectionState(updatedMessage.id);
        await loadSidebar("chatList", { showLoading: false });
        await markCurrentChatAsRead();
      } catch (error) {
        status.textContent = error.message;
        status.className = "status error";
      } finally {
        isSendingMessage = false;
        setComposerBusyState(false);
        input.focus();
      }
      return;
    }

    isSendingMessage = true;
    typingState.isSending = true;
    emitTypingStop();
    const shouldStickToBottom = isNearBottom(messagesNode);
    const pendingMessageNode = appendPendingMessage(messagesNode, text, chatType, {
      type: isWideSubmit ? "wide" : "text",
      badge: isWideSubmit ? "Объявление" : "",
      senderName: currentUser?.name || "Вы",
      attachments: getComposerAttachmentPayload()
    });
    pendingMessageState = { text, node: pendingMessageNode };
    setComposerBusyState(true);
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
      let requestBody;
      if (hasAttachments) {
        const compressedImages = await Promise.all(
          composerAttachments.map((attachment) => compressImage(attachment.file))
        );
        const formData = new FormData();
        formData.append("text", text);
        if (replyMessageState?.messageId) {
          formData.append("reply_to_id", String(replyMessageState.messageId));
        }
        compressedImages.forEach((file) => {
          formData.append("images[]", file, file.name || "photo.jpg");
        });
        requestBody = formData;
      } else {
        const payload = {
          text,
          reply_to_id: replyMessageState?.messageId || null
        };
        if (isWideSubmit) {
          payload.type = "wide";
          payload.layout = "wide";
          payload.badge = "Объявление";
        }
        requestBody = JSON.stringify(payload);
      }

      const sentMessage = await apiFetch(path, {
        method: "POST",
        body: requestBody
      });

      removePendingMessage(pendingMessageNode);
      pendingMessageState = null;
      input.value = "";
      resizeComposerInput();
      clearComposerAttachments();
      setComposerWideMode("normal");
      appendMessage(messagesNode, sentMessage, currentUser.id, chatType);
      syncMessageSelectionState(sentMessage.id);
      await loadThread();
      if (shouldStickToBottom) {
        scrollMessagesToBottom(messagesNode);
      }

      if (!hadChatId && chatType !== "group") {
        await loadSidebar("chatList", { showLoading: false });
        await markCurrentChatAsRead();
        connectRealtime();
      }
      setReplyMessageState(null);
      status.textContent = "";
    } catch (error) {
      status.textContent = error.message;
      status.className = "status error";
    } finally {
      if (pendingMessageState?.node === pendingMessageNode) {
        removePendingMessage(pendingMessageNode);
        pendingMessageState = null;
      }
      typingState.isSending = false;
      isSendingMessage = false;
      setComposerBusyState(false);
      updateComposerActionButton();
      input.focus();
      updateScrollDownButton(messagesNode, scrollDownButton);
    }
  }

  function getBaseHeaderStatus() {
    if (chatType === "group") {
      const groupStatus = serverId ? "" : getGroupPresenceText(currentThreadInfo || {});
      return {
        mobile: {
          mode: "text",
          value: groupStatus
        },
        desktopSubtitle: groupStatus,
        desktopPresence: ""
      };
    }

    return {
      mobile: {
        mode: "html",
        value: renderDirectChatSubtitle(currentThreadInfo || {})
      },
      desktopSubtitle: renderDirectChatDesktopSubtitle(currentThreadInfo || {}),
      desktopPresence: renderDirectChatDesktopPresence(currentThreadInfo || {})
    };
  }

  function getTypingBadgeLabel() {
    const activeUsers = [...typingState.remoteUsers.values()];
    if (!activeUsers.length) {
      return "";
    }

    if (chatType === "group") {
      if (activeUsers.length === 1) {
        return `${activeUsers[0].name || "Кто-то"} печатает...`;
      }
      return "Несколько человек печатают...";
    }

    return "печатает...";
  }

  function getHeaderTypingOverride() {
    const label = getTypingBadgeLabel();
    if (!label) {
      return null;
    }

    const badge = renderTypingBadge(label, { compact: true, showDots: true });
    if (chatType === "group") {
      return {
        mobile: {
          mode: "html",
          value: badge
        },
        desktopSubtitle: "",
        desktopPresence: badge
      };
    }

    return {
      mobile: {
        mode: "html",
        value: badge
      },
      desktopSubtitle: renderDirectChatDesktopSubtitle(currentThreadInfo || {}),
      desktopPresence: badge
    };
  }

  function applyHeaderStatus(statusConfig) {
    const subtitleDesktopNode = document.getElementById("chatSubtitleDesktop");
    const presenceDesktopNode = document.getElementById("chatPresenceDesktop");
    const subtitleMobileNode = document.getElementById("chatSubtitle");
    if (subtitleMobileNode) {
      if (statusConfig?.mobile?.mode === "html") {
        subtitleMobileNode.innerHTML = statusConfig.mobile.value || "";
      } else {
        subtitleMobileNode.textContent = statusConfig?.mobile?.value || "";
      }
    }
    if (subtitleDesktopNode) {
      subtitleDesktopNode.textContent = statusConfig?.desktopSubtitle || "";
    }
    if (presenceDesktopNode) {
      presenceDesktopNode.innerHTML = statusConfig?.desktopPresence || "";
      presenceDesktopNode.classList.toggle("is-empty", !statusConfig?.desktopPresence);
    }
  }

  function renderHeaderStatus() {
    applyHeaderStatus(getHeaderTypingOverride() || getBaseHeaderStatus());
  }

  function scheduleTypingStatusRefresh() {
    if (typingCooldownTimer) {
      window.clearTimeout(typingCooldownTimer);
    }
    typingCooldownTimer = window.setTimeout(() => {
      renderHeaderStatus();
    }, 40);
  }

  function refreshVisibleMessageTimes() {
    messagesNode.querySelectorAll(".message[data-created-at], .wide-message[data-created-at]").forEach((node) => {
      const timeNode = node.querySelector(".message-time");
      if (!timeNode) {
        return;
      }
      timeNode.textContent = formatTime(node.dataset.createdAt || "");
    });
    rebuildDateDividers(messagesNode);
  }

  function setRemoteTypingUser(userId, payload = {}) {
    if (!userId || String(userId) === String(currentUser.id)) {
      return;
    }
    const key = String(userId);
    const previousUser = typingState.remoteUsers.get(key);
    if (previousUser?.timeoutId) {
      window.clearTimeout(previousUser.timeoutId);
    }
    const timeoutId = window.setTimeout(() => {
      clearRemoteTypingUser(key, true);
    }, 2600);
    typingState.remoteUsers.set(key, {
      id: String(userId),
      name: payload.name || payload.username || "Кто-то",
      timeoutId
    });
    renderHeaderStatus();
  }

  function clearRemoteTypingUser(userId, delayed = true) {
    if (!userId) {
      return;
    }
    const key = String(userId);
    const existingUser = typingState.remoteUsers.get(key);
    if (existingUser?.timeoutId) {
      window.clearTimeout(existingUser.timeoutId);
    }
    typingState.remoteUsers.delete(key);
    if (delayed) {
      scheduleTypingStatusRefresh();
      return;
    }
    renderHeaderStatus();
  }

  function emitTypingStop() {
    if (typingPauseTimer) {
      window.clearTimeout(typingPauseTimer);
      typingPauseTimer = null;
    }
    if (!socket || !chatId || !typingState.localActive) {
      return;
    }
    typingState.localActive = false;
    socket.emit("typing_stop", {
      type: chatType === "group" ? "group" : "direct",
      id: chatId
    });
  }

  function scheduleTypingStop() {
    if (typingPauseTimer) {
      window.clearTimeout(typingPauseTimer);
    }
    typingPauseTimer = window.setTimeout(() => {
      emitTypingStop();
    }, 1200);
  }

  function emitTypingStart(force = false) {
    if (!socket || !chatId || typingState.isSending) {
      return;
    }
    const now = Date.now();
    if (!force && now - typingState.lastStartAt < 1500) {
      scheduleTypingStop();
      return;
    }
    typingState.lastStartAt = now;
    typingState.localActive = true;
    socket.emit("typing_start", {
      type: chatType === "group" ? "group" : "direct",
      id: chatId
    });
    scheduleTypingStop();
  }

  function handleComposerTyping() {
    if (!input.value.trim()) {
      emitTypingStop();
      return;
    }
    emitTypingStart();
  }

  function setThreadInfoOpen(isOpen) {
    contentNode.classList.toggle("thread-info-open", Boolean(isOpen));
    const panel = document.getElementById("threadInfoPanel");
    if (panel) {
      panel.setAttribute("aria-hidden", isOpen ? "false" : "true");
    }
  }

  function getThreadSearchUI(kind = isMobileThreadSearchOpen ? "mobile" : "desktop") {
    if (kind === "mobile") {
      return {
        panel: threadMobileSearch,
        input: threadMobileSearchInput,
        status: threadMobileSearchStatus,
        results: threadMobileSearchResults
      };
    }

    return {
      panel: threadInfoSearchPanel,
      input: threadInfoSearchInput,
      status: threadInfoSearchStatus,
      results: threadInfoSearchResults
    };
  }

  function syncThreadSearchInputs(value = "", source = "") {
    if (source !== "desktop" && threadInfoSearchInput && threadInfoSearchInput.value !== value) {
      threadInfoSearchInput.value = value;
    }
    if (source !== "mobile" && threadMobileSearchInput && threadMobileSearchInput.value !== value) {
      threadMobileSearchInput.value = value;
    }
  }

  function setThreadSearchStatus(message, type = "", kind = isMobileThreadSearchOpen ? "mobile" : "desktop") {
    const ui = getThreadSearchUI(kind);
    if (!ui?.status) {
      return;
    }
    ui.status.textContent = message;
    ui.status.className = `status thread-info-search-status ${type}`.trim();
  }

  function clearThreadSearchResults(kind = isMobileThreadSearchOpen ? "mobile" : "desktop") {
    const ui = getThreadSearchUI(kind);
    if (ui?.results) {
      ui.results.innerHTML = "";
    }
  }

  function closeThreadSearchPanel() {
    if (!threadInfoSearchPanel) {
      return;
    }
    threadInfoSearchPanel.hidden = true;
    if (threadSearchDebounceTimer) {
      window.clearTimeout(threadSearchDebounceTimer);
      threadSearchDebounceTimer = null;
    }
  }

  function openThreadSearchPanel() {
    if (!threadInfoSearchPanel) {
      return;
    }
    threadInfoSearchPanel.hidden = false;
    if (!chatId) {
      setThreadSearchStatus("Сообщений для поиска пока нет", "", "desktop");
      clearThreadSearchResults("desktop");
      return;
    }
    setThreadSearchStatus("Введите текст для поиска", "", "desktop");
    threadInfoSearchInput?.focus();
  }

  function closeMobileThreadSearchMode() {
    if (!threadMobileSearch) {
      return;
    }
    isMobileThreadSearchOpen = false;
    document.body.classList.remove("thread-mobile-search-open");
    threadMobileSearch.classList.remove("visible");
    window.setTimeout(() => {
      if (!threadMobileSearch.classList.contains("visible")) {
        threadMobileSearch.hidden = true;
      }
    }, 180);
    if (threadSearchDebounceTimer) {
      window.clearTimeout(threadSearchDebounceTimer);
      threadSearchDebounceTimer = null;
    }
  }

  function openMobileThreadSearchMode() {
    if (!threadMobileSearch) {
      return;
    }
    isMobileThreadSearchOpen = true;
    document.body.classList.add("thread-mobile-search-open");
    threadMobileSearch.hidden = false;
    syncThreadSearchInputs(threadInfoSearchInput?.value || threadMobileSearchInput?.value || "", "");
    requestAnimationFrame(() => {
      threadMobileSearch.classList.add("visible");
    });

    if (!chatId) {
      setThreadSearchStatus("Сообщений для поиска пока нет", "", "mobile");
      clearThreadSearchResults("mobile");
      return;
    }

    const query = threadMobileSearchInput?.value.trim() || "";
    if (query) {
      void runThreadMessageSearch(query, "mobile");
    } else {
      setThreadSearchStatus("Введите текст для поиска", "", "mobile");
      clearThreadSearchResults("mobile");
    }
    threadMobileSearchInput?.focus();
  }

  async function restoreLatestThreadView(kind = isMobileThreadSearchOpen ? "mobile" : "desktop") {
    if (!chatId) {
      return;
    }
    isShowingSearchContext = false;
    await loadThread();
    const ui = getThreadSearchUI(kind);
    const query = ui?.input?.value.trim() || "";
    setThreadSearchStatus(query ? "Показаны последние сообщения" : "Введите текст для поиска", "", kind);
  }

  async function focusMessageFromSearch(messageId, kind = isMobileThreadSearchOpen ? "mobile" : "desktop") {
    if (!messageId || !chatId) {
      return;
    }

    const existingNode = findThreadMessageNode(messagesNode, messageId);
    if (existingNode) {
      existingNode.scrollIntoView({ block: "center", behavior: "smooth" });
      setMessageSearchTarget(messageId);
      setThreadSearchStatus("Сообщение найдено", "success", kind);
      return;
    }

    const contextPath = chatType === "group"
      ? `/groups/${chatId}/messages/${messageId}/context?limit=12`
      : `/chats/${chatId}/messages/${messageId}/context?limit=12`;

    setThreadSearchStatus("Загружаем фрагмент переписки...", "", kind);
    const data = await apiFetch(contextPath);
    const contextMessages = Array.isArray(data?.messages) ? data.messages : [];
    renderMessages(messagesNode, contextMessages, currentUser.id, chatType);
    oldestMessageId = contextMessages.length ? contextMessages[0].id : null;
    hasMoreMessages = Boolean(data?.has_more_before) && contextMessages.length > 0;
    isShowingSearchContext = true;
    updateScrollDownButton(messagesNode, scrollDownButton);
    requestAnimationFrame(() => {
      const targetNode = setMessageSearchTarget(messageId);
      targetNode?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
    setThreadSearchStatus(
      data?.has_more_after ? "Показан фрагмент истории. Кнопка «Последние» вернёт к текущим сообщениям." : "Сообщение найдено",
      data?.has_more_after ? "" : "success",
      kind
    );
  }

  async function runThreadMessageSearch(query, kind = isMobileThreadSearchOpen ? "mobile" : "desktop") {
    const ui = getThreadSearchUI(kind);
    if (!ui?.results) {
      return;
    }

    if (!chatId) {
      setThreadSearchStatus("Сообщений для поиска пока нет", "", kind);
      clearThreadSearchResults(kind);
      return;
    }

    const normalizedQuery = query.trim();
    syncThreadSearchInputs(normalizedQuery, kind);
    if (!normalizedQuery) {
      setThreadSearchStatus("Введите текст для поиска", "", kind);
      clearThreadSearchResults(kind);
      return;
    }

    const requestId = ++activeThreadSearchRequestId;
    setThreadSearchStatus("Ищем...", "", kind);

    try {
      const searchPath = chatType === "group"
        ? `/groups/${chatId}/messages/search?q=${encodeURIComponent(normalizedQuery)}&limit=20`
        : `/chats/${chatId}/messages/search?q=${encodeURIComponent(normalizedQuery)}&limit=20`;
      const data = await apiFetch(searchPath);
      if (requestId !== activeThreadSearchRequestId) {
        return;
      }
      const results = Array.isArray(data?.items) ? data.items : [];
      ui.results.innerHTML = renderThreadSearchResults(results, chatType);
      setThreadSearchStatus(results.length ? `Найдено: ${results.length}` : "Ничего не найдено", results.length ? "" : "error", kind);
    } catch (error) {
      if (requestId !== activeThreadSearchRequestId) {
        return;
      }
      clearThreadSearchResults(kind);
      setThreadSearchStatus(error.message, "error", kind);
    }
  }

  function setActiveThreadInfoView(info, infoType = chatType) {
    activeThreadInfoView = info || null;
    activeThreadInfoType = infoType || chatType;
  }

  function setThreadInfoHeading(title, subtitle) {
    const titleNode = document.querySelector(".thread-info-title");
    const subtitleNode = document.querySelector(".thread-info-subtitle");
    if (titleNode) {
      titleNode.textContent = title;
    }
    if (subtitleNode) {
      subtitleNode.textContent = subtitle;
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

  function setThreadInviteStatus(message, type = "") {
    if (!threadInfoInviteStatus) {
      return;
    }
    threadInfoInviteStatus.textContent = message;
    threadInfoInviteStatus.className = `status thread-info-invite-status ${type}`.trim();
  }

  function setThreadProfileStatus(message, type = "") {
    const statusNode = document.querySelector("#threadInfoProfilePanel [data-user-profile-status]");
    if (!statusNode) {
      return;
    }
    statusNode.textContent = message;
    statusNode.className = `status user-profile-actions-status ${type}`.trim();
  }

  function updateThreadBlockNotice() {
    if (!threadBlockNotice) {
      return;
    }

    if (chatType !== "direct") {
      threadBlockNotice.hidden = true;
      threadBlockNotice.textContent = "";
      return;
    }

    const targetInfo = currentThreadInfo || activeThreadInfoView;
    if (!targetInfo) {
      threadBlockNotice.hidden = true;
      threadBlockNotice.textContent = "";
      return;
    }

    if (targetInfo.is_blocked) {
      threadBlockNotice.hidden = false;
      threadBlockNotice.className = "thread-block-notice is-blocked";
      threadBlockNotice.textContent = "Вы заблокировали этого пользователя";
      return;
    }

    if (targetInfo.is_blocked_by) {
      threadBlockNotice.hidden = false;
      threadBlockNotice.className = "thread-block-notice is-restricted";
      threadBlockNotice.textContent = "Пользователь ограничил сообщения от вас";
      return;
    }

    threadBlockNotice.hidden = true;
    threadBlockNotice.textContent = "";
  }

  function syncThreadUserProfileState(nextProfile) {
    if (!nextProfile?.id) {
      return;
    }

    syncUserRelationStateFromProfile(nextProfile);

    const targetUserId = String(nextProfile.id);
    if (currentThreadInfo && String(currentThreadInfo.user_id || currentThreadInfo.id || "") === targetUserId) {
      currentThreadInfo = {
        ...currentThreadInfo,
        ...nextProfile,
        title: getUserProfileDisplayName({
          ...currentThreadInfo,
          ...nextProfile
        })
      };
    }

    if (activeThreadInfoView && String(activeThreadInfoView.user_id || activeThreadInfoView.id || "") === targetUserId) {
      activeThreadInfoView = {
        ...activeThreadInfoView,
        ...nextProfile,
        title: getUserProfileDisplayName({
          ...activeThreadInfoView,
          ...nextProfile
        })
      };
    }

    if (chatType === "direct" && currentThreadInfo && String(currentThreadInfo.user_id || currentThreadInfo.id || "") === targetUserId) {
      setChatTitle(currentThreadInfo);
      renderHeaderStatus();
    }

    fillThreadInfoPanel(
      activeThreadInfoType === chatType ? currentThreadInfo : activeThreadInfoView,
      activeThreadInfoType === chatType ? chatType : activeThreadInfoType
    );
    updateThreadBlockNotice();
  }

  async function refreshThreadUserProfile(userId) {
    if (!userId) {
      return;
    }
    const targetUserId = String(userId);
    const currentDirectThreadUserId = currentThreadInfo
      ? String(currentThreadInfo.user_id || currentThreadInfo.id || "")
      : "";
    if (chatType === "direct" && currentDirectThreadUserId === targetUserId) {
      await refreshCurrentThreadInfo();
      await loadSidebar("chatList", { showLoading: false });
      return;
    }
    const profile = await apiFetch(`/users/${encodeURIComponent(userId)}`);
    syncThreadUserProfileState(profile);
    await loadSidebar("chatList", { showLoading: false });
  }

  async function handleThreadProfileAction(action, profileUserId) {
    if (!action || !profileUserId) {
      return;
    }

    setThreadProfileStatus("", "");

    try {
      const currentProfile = activeThreadInfoView && String(activeThreadInfoView.id || activeThreadInfoView.user_id || "") === String(profileUserId)
        ? activeThreadInfoView
        : currentThreadInfo;
      const profileName = getUserProfileDisplayName(currentProfile || { id: profileUserId, name: "Пользователь" });

      if (action === "mute" || action === "unmute") {
        setThreadProfileStatus(action === "mute" ? "Отключаем уведомления..." : "Включаем уведомления...", "");
        const profile = await apiFetch(`/users/${encodeURIComponent(profileUserId)}/mute`, {
          method: action === "mute" ? "POST" : "DELETE"
        });
        syncThreadUserProfileState(profile);
        await loadSidebar("chatList", { showLoading: false });
        setThreadProfileStatus(action === "mute" ? "Уведомления отключены" : "Уведомления включены", "success");
        return;
      }

      if (action === "block" || action === "unblock") {
        const confirmed = await openUserRelationConfirmModal({
          title: action === "block" ? "Заблокировать пользователя?" : "Разблокировать пользователя?",
          body: action === "block"
            ? `${profileName} больше не сможет писать вам первым, а новые сообщения от него будут скрыты.`
            : `${profileName} снова сможет писать вам как обычный пользователь.`,
          confirmText: action === "block" ? "Заблокировать" : "Разблокировать",
          danger: action === "block"
        });
        if (!confirmed) {
          return;
        }

        setThreadProfileStatus(action === "block" ? "Блокируем пользователя..." : "Снимаем блокировку...", "");
        const profile = await apiFetch(`/users/${encodeURIComponent(profileUserId)}/block`, {
          method: action === "block" ? "POST" : "DELETE"
        });
        syncThreadUserProfileState(profile);
        await loadSidebar("chatList", { showLoading: false });
        setThreadProfileStatus(action === "block" ? "Пользователь заблокирован" : "Пользователь разблокирован", "success");
        return;
      }

      if (action === "add") {
        setThreadProfileStatus("Добавляем контакт...", "");
        await apiFetch("/contacts", {
          method: "POST",
          body: JSON.stringify({ user_id: profileUserId })
        });
        await refreshThreadUserProfile(profileUserId);
        setThreadProfileStatus("Контакт добавлен", "success");
        return;
      }

      if (action === "remove") {
        setThreadProfileStatus("Удаляем контакт...", "");
        await apiFetch(`/contacts/${encodeURIComponent(profileUserId)}`, {
          method: "DELETE"
        });
        await refreshThreadUserProfile(profileUserId);
        setThreadProfileStatus("Контакт удален", "success");
        return;
      }

      if (action === "rename") {
        const nextAlias = window.prompt("Новое имя контакта", currentProfile?.contact_alias || currentProfile?.name || "");
        if (nextAlias == null) {
          return;
        }
        setThreadProfileStatus("Сохраняем имя контакта...", "");
        await apiFetch(`/contacts/${encodeURIComponent(profileUserId)}`, {
          method: "PATCH",
          body: JSON.stringify({ alias: nextAlias })
        });
        await refreshThreadUserProfile(profileUserId);
        setThreadProfileStatus("Имя контакта обновлено", "success");
        return;
      }

      if (action === "reset-alias") {
        setThreadProfileStatus("Возвращаем исходное имя...", "");
        await apiFetch(`/contacts/${encodeURIComponent(profileUserId)}/alias`, {
          method: "DELETE"
        });
        await refreshThreadUserProfile(profileUserId);
        setThreadProfileStatus("Имя контакта сброшено", "success");
      }
    } catch (error) {
      setThreadProfileStatus(error.message, "error");
    }
  }

  function updateThreadInviteControls() {
    const canManageInvite = chatType === "group" && Boolean(currentThreadInfo?.can_manage_invite && currentThreadInfo?.invite?.url);
    if (threadInfoInviteFact) {
      threadInfoInviteFact.hidden = !canManageInvite;
    }
    if (threadInfoInviteToggle) {
      threadInfoInviteToggle.disabled = !canManageInvite;
    }
    if (threadInfoInviteCopy) {
      threadInfoInviteCopy.disabled = !canManageInvite || isRefreshingInviteLink;
      setInviteActionButton(threadInfoInviteCopy, "/assets/icons/ui/Copy.svg", "Скопировать");
    }
    if (threadInfoInviteRegenerate) {
      threadInfoInviteRegenerate.disabled = !canManageInvite || isRefreshingInviteLink;
      setInviteActionButton(
        threadInfoInviteRegenerate,
        "/assets/icons/ui/Refresh_2.svg",
        isRefreshingInviteLink ? "Обновляем ссылку..." : "Обновить ссылку"
      );
    }
  }

  function setThreadInviteExpanded(isExpanded) {
    const canManageInvite = chatType === "group" && Boolean(currentThreadInfo?.can_manage_invite && currentThreadInfo?.invite?.url);
    isThreadInviteExpanded = Boolean(isExpanded) && canManageInvite;
    if (threadInfoInviteToggle) {
      threadInfoInviteToggle.setAttribute("aria-expanded", isThreadInviteExpanded ? "true" : "false");
      threadInfoInviteToggle.classList.toggle("is-open", isThreadInviteExpanded);
    }
    if (threadInfoInvitePanel) {
      if (isThreadInviteExpanded) {
        threadInfoInvitePanel.hidden = false;
      }
      threadInfoInvitePanel.classList.toggle("is-open", isThreadInviteExpanded);
      threadInfoInvitePanel.setAttribute("aria-hidden", isThreadInviteExpanded ? "false" : "true");
    }
    if (threadInfoInviteFact) {
      threadInfoInviteFact.classList.toggle("is-open", isThreadInviteExpanded);
    }
    if (threadInfoInviteHint) {
      threadInfoInviteHint.textContent = isThreadInviteExpanded
        ? "Нажмите, чтобы скрыть ссылку"
        : "Нажмите, чтобы показать ссылку";
    }
    syncThreadInvitePanelHeight();
  }

  function syncThreadInvitePanelHeight() {
    if (!threadInfoInvitePanel) {
      return;
    }

    const inner = threadInfoInvitePanel.firstElementChild;
    if (!(inner instanceof HTMLElement)) {
      return;
    }

    if (isThreadInviteExpanded) {
      const nextHeight = `${inner.scrollHeight}px`;
      threadInfoInvitePanel.style.maxHeight = nextHeight;
      threadInfoInvitePanel.style.opacity = "1";
      return;
    }

    threadInfoInvitePanel.style.maxHeight = "0px";
    threadInfoInvitePanel.style.opacity = "0";
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
    syncUserRelationStateFromProfile(selectedUser);
    currentThreadInfo = selectedUser;
    setActiveThreadInfoView(currentThreadInfo, chatType);
    updateThreadBlockNotice();
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
    syncUserRelationStateFromProfile(currentThreadInfo);
    if (chatType === "group") {
      setChatTitle(title);
      renderHeaderStatus();
      if (!currentThreadInfo.can_add_members) {
        closeThreadMemberAddModal();
      }
      if (!currentThreadInfo.can_edit_group) {
        closeThreadGroupEditModal();
      }
      if (activeThreadMemberItem) {
        hideThreadMemberActionMenu();
      }
      syncComposerAvailability();
    }
    if (!activeThreadInfoView || activeThreadInfoType === chatType) {
      setActiveThreadInfoView(currentThreadInfo, chatType);
    }
    fillThreadInfoPanel(
      activeThreadInfoType === chatType ? currentThreadInfo : activeThreadInfoView,
      activeThreadInfoType === chatType ? chatType : activeThreadInfoType
    );
    setThreadInviteExpanded(isThreadInviteExpanded);
    updateThreadInviteControls();
    updateThreadBlockNotice();
  }

  async function copyThreadInviteLink() {
    const inviteUrl = currentThreadInfo?.invite?.url;
    if (!inviteUrl) {
      return;
    }

    if (!navigator.clipboard?.writeText) {
      setThreadInviteStatus("Буфер обмена недоступен в этом браузере", "error");
      return;
    }

    try {
      await navigator.clipboard.writeText(inviteUrl);
      if (threadInfoInviteCopy) {
        setInviteActionButton(threadInfoInviteCopy, "/assets/icons/ui/Check_fill.svg", "Скопировано");
      }
      setThreadInviteStatus("Ссылка скопирована", "success");
      window.setTimeout(() => {
        if (!isRefreshingInviteLink) {
          updateThreadInviteControls();
        }
      }, 1600);
    } catch (error) {
      setThreadInviteStatus("Не удалось скопировать ссылку", "error");
    }
  }

  async function regenerateThreadInviteLink() {
    if (!chatId || chatType !== "group" || !currentThreadInfo?.can_manage_invite || isRefreshingInviteLink) {
      return;
    }

    isRefreshingInviteLink = true;
    updateThreadInviteControls();
    setThreadInviteStatus("Обновляем ссылку...", "");

    try {
      const data = await apiFetch(`/groups/${encodeURIComponent(chatId)}/invite/regenerate`, {
        method: "POST"
      });
      currentThreadInfo = {
        ...currentThreadInfo,
        invite: data.invite || currentThreadInfo.invite
      };
      if (!activeThreadInfoView || activeThreadInfoType === chatType) {
        setActiveThreadInfoView(currentThreadInfo, chatType);
      }
      fillThreadInfoPanel(
        activeThreadInfoType === chatType ? currentThreadInfo : activeThreadInfoView,
        activeThreadInfoType === chatType ? chatType : activeThreadInfoType
      );
      setThreadInviteExpanded(isThreadInviteExpanded);
      setThreadInviteStatus("Ссылка обновлена", "success");
    } catch (error) {
      setThreadInviteStatus(error.message, "error");
    } finally {
      isRefreshingInviteLink = false;
      updateThreadInviteControls();
    }
  }

  async function openMessageAuthorProfile(authorUserId) {
    if (!authorUserId) {
      return;
    }

    const profile = await apiFetch(`/users/${encodeURIComponent(authorUserId)}`);
    closeThreadInfoActionMenu();
    closeThreadMemberAddModal();
    closeThreadGroupEditModal();
    setThreadInfoHeading("Профиль", "Информация о пользователе");
    setActiveThreadInfoView({
      ...profile,
      title: profile.name || profile.username || "Пользователь"
    }, "direct");
    fillThreadInfoPanel(activeThreadInfoView, activeThreadInfoType);
    updateThreadInviteControls();
    setThreadInfoOpen(true);
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

  function canManageThreadMember(memberItem) {
    return memberItem?.dataset.memberCanManage === "true";
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

  function mergeThreadMemberUsers(...groups) {
    const users = new Map();
    groups.flat().forEach((user) => {
      if (!user?.id) {
        return;
      }

      const userId = String(user.id);
      users.set(userId, {
        ...(users.get(userId) || {}),
        ...user
      });
    });
    return [...users.values()];
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
    const baseCandidatesSource = normalizedQuery
      ? mergeThreadMemberUsers(threadMemberContacts, threadMemberSearchDirectory)
      : threadMemberContacts;
    const baseCandidates = baseCandidatesSource.filter((user) => !existingMemberIds.has(String(user.id)));
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

  async function searchThreadMemberDirectory(query = "") {
    const normalizedQuery = query.trim().replace(/^@/, "");
    const requestId = ++activeThreadMemberSearchRequestId;

    if (!normalizedQuery) {
      threadMemberSearchDirectory = [];
      filterThreadMemberCandidates("", true);
      return;
    }

    filterThreadMemberCandidates(normalizedQuery, true);
    setThreadMemberAddStatus("Ищем пользователей...", "");

    try {
      const data = await apiFetch(`/users/search?username=${encodeURIComponent(normalizedQuery)}`);
      if (requestId !== activeThreadMemberSearchRequestId) {
        return;
      }

      threadMemberSearchDirectory = Array.isArray(data) ? data : data.items || [];
      filterThreadMemberCandidates(normalizedQuery, true);
    } catch (error) {
      if (requestId !== activeThreadMemberSearchRequestId) {
        return;
      }

      threadMemberSearchDirectory = [];
      filterThreadMemberCandidates(normalizedQuery, true);
      if (!filteredThreadMemberCandidates.length) {
        setThreadMemberAddStatus(error.message, "error");
      }
    }
  }

  async function openThreadMemberAddModal() {
    if (!threadMemberAddModal || chatType !== "group" || !currentThreadInfo?.can_add_members) {
      return;
    }

    threadMemberAddModal.hidden = false;
    if (threadMemberAddInput) {
      threadMemberAddInput.value = "";
    }
    if (threadMemberSearchResults) {
      threadMemberSearchResults.innerHTML = "";
    }
    threadMemberSearchDirectory = [];
    activeThreadMemberSearchRequestId += 1;
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
    threadMemberSearchDirectory = [];
    filteredThreadMemberCandidates = [];
    activeThreadMemberSearchRequestId += 1;
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
    if (!memberItem || !canManageThreadMember(memberItem)) {
      return;
    }

    const isAdmin = memberItem.dataset.memberIsAdmin === "true";
    threadMemberActionMenu.innerHTML = `
      <button type="button" data-member-action="toggle-admin">${renderActionMenuItemContent("/assets/icons/ui/Chield_check_fill.svg", isAdmin ? "Снять админа" : "Сделать админом")}</button>
      <button type="button" data-member-action="remove-member" class="danger">${renderActionMenuItemContent("/assets/icons/ui/Trash_line.svg", "Удалить из группы")}</button>
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
    currentThreadInfo = user ? { ...user, title } : null;
    setActiveThreadInfoView(currentThreadInfo, chatType);
    setChatTitle(currentThreadInfo || title);
    renderHeaderStatus();
    fillThreadInfoPanel(currentThreadInfo, chatType);
    updateThreadInviteControls();
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
    const node = findThreadMessageNode(messagesNode, messageId);
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
    const forwardDialogButton = selectionToolbar.querySelector('[data-action="forward-dialog"]');
    const selectedNodes = [...selectedMessageIds].map((messageId) => (
      findThreadMessageNode(messagesNode, messageId)
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

    if (forwardDialogButton) {
      forwardDialogButton.disabled = count < 2;
      forwardDialogButton.hidden = count < 2;
    }

    if (count === 0) {
      isSelectionMode = false;
      selectionToolbar.hidden = true;
      document.body.classList.remove("selection-mode");
    }
  }

  function clearSelectedMessages() {
    selectedMessageIds.forEach((messageId) => {
      const node = findThreadMessageNode(messagesNode, messageId);
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
    if (isSystemMessageNode(messageNode)) {
      return;
    }

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
    const messageNodes = [...messagesNode.querySelectorAll(THREAD_MESSAGE_SELECTOR)];

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
        ? findThreadMessageNode(container, item.anchorNextId)
        : null;
      if (nextAnchor) {
        container.insertBefore(item.messageNode, nextAnchor);
        return;
      }

      const prevAnchor = item.anchorPrevId
        ? findThreadMessageNode(container, item.anchorPrevId)
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
    if (nextState) {
      setReplyMessageState(null);
      clearComposerAttachments();
    }
    composer.classList.toggle("is-editing", Boolean(nextState));
    editBanner.hidden = !nextState;

    if (nextState) {
      input.value = nextState.text;
      input.placeholder = "Редактирование сообщения";
    } else {
      input.placeholder = getComposerPlaceholder();
    }

    resizeComposerInput();
    updateComposerActionButton();
    input.focus();
    const caretPos = input.value.length;
    input.setSelectionRange(caretPos, caretPos);
  }

  function setReplyMessageState(nextState) {
    replyMessageState = nextState;
    composer.classList.toggle("is-replying", Boolean(nextState));
    replyBanner.hidden = !nextState;

    if (!nextState) {
      return;
    }

    if (editingMessageState) {
      setEditingMessageState(null);
    }

    const authorNode = replyBanner.querySelector(".composer-reply-author");
    const textNode = replyBanner.querySelector(".composer-reply-text");
    if (authorNode) {
      authorNode.textContent = nextState.senderName || "Сообщение";
    }
    if (textNode) {
      textNode.textContent = getReplyPreviewText({
        text: nextState.text,
        message_type: nextState.messageType
      });
    }
    input.focus();
  }

  function getForwardPreviewText(state = {}) {
    return getReplyPreviewText({
      text: state.text,
      message_type: state.messageType
    });
  }

  function getForwardTargets(query = "") {
    const normalizedQuery = String(query || "").trim().toLowerCase();
    const currentChatKey = chatId ? `${chatType}:${chatId}` : "";
    const chats = Array.isArray(chatState.allChats) ? chatState.allChats : [];

    return chats.filter((chat) => {
      const targetType = chat.type || "direct";
      const targetKey = `${targetType}:${chat.id}`;
      if (!chat?.id || targetKey === currentChatKey) {
        return false;
      }
      if (!normalizedQuery) {
        return true;
      }
      const haystack = [
        chat.title,
        chat.username ? `@${chat.username}` : "",
        chat.last_message?.text || ""
      ].join(" ").toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }

  function renderForwardTargetItem(chat) {
    const targetType = chat.type || "direct";
    const targetKey = `${targetType}:${chat.id}`;
    const subtitle = targetType === "group"
      ? (chat.description || "Групповой чат")
      : (chat.username ? `@${chat.username}` : "Личный чат");
    return `
      <button
        type="button"
        class="forward-target-item${selectedForwardTargetKey === targetKey ? " is-selected" : ""}"
        data-forward-target-key="${escapeHtml(targetKey)}"
        data-forward-target-id="${escapeHtml(String(chat.id))}"
        data-forward-target-type="${escapeHtml(targetType)}"
      >
        <span class="forward-target-avatar">${escapeHtml(initials(chat.title || "Чат"))}</span>
        <span class="forward-target-copy">
          <strong>${escapeHtml(chat.title || "Чат")}</strong>
          <span>${escapeHtml(subtitle)}</span>
        </span>
      </button>
    `;
  }

  function renderForwardTargetList(query = "") {
    const listNode = forwardModal.querySelector("[data-forward-list]");
    const statusNode = forwardModal.querySelector("[data-forward-status]");
    if (!listNode || !statusNode) {
      return;
    }

    const targets = getForwardTargets(query);
    if (!targets.length) {
      listNode.innerHTML = "";
      statusNode.textContent = query ? "Ничего не найдено" : "Нет доступных чатов для пересылки";
      statusNode.className = "status forward-modal-status";
      return;
    }

    statusNode.textContent = forwardMessageState
      ? forwardMessageState.mode === "dialog"
        ? `Выбрано: ${forwardMessageState.text || "несколько сообщений"}`
        : `Сообщение от ${forwardMessageState.senderName || "пользователя"}`
      : "";
    statusNode.className = "status forward-modal-status";
    listNode.innerHTML = targets.map(renderForwardTargetItem).join("");
  }

  function closeForwardModal() {
    forwardModal.classList.remove("visible");
    window.setTimeout(() => {
      if (!forwardModal.classList.contains("visible")) {
        forwardModal.hidden = true;
      }
    }, 160);
    forwardMessageState = null;
    selectedForwardTargetKey = "";
    const statusNode = forwardModal.querySelector("[data-forward-status]");
    const searchNode = forwardModal.querySelector("[data-forward-search]");
    const listNode = forwardModal.querySelector("[data-forward-list]");
    if (statusNode) {
      statusNode.textContent = "";
      statusNode.className = "status forward-modal-status";
    }
    if (searchNode) {
      searchNode.value = "";
    }
    if (listNode) {
      listNode.innerHTML = "";
    }
  }

  function openForwardModal(nextState) {
    if (!nextState || (!nextState.messageId && !Array.isArray(nextState.messageIds))) {
      return;
    }

    forwardMessageState = nextState;
    selectedForwardTargetKey = "";
    const titleNode = forwardModal.querySelector(".forward-modal-title");
    const subtitleNode = forwardModal.querySelector(".forward-modal-subtitle");
    if (titleNode) {
      titleNode.textContent = nextState.mode === "dialog" ? "Переслать как диалог" : "Переслать сообщение";
    }
    if (subtitleNode) {
      subtitleNode.textContent = nextState.mode === "dialog"
        ? "Выберите чат, куда отправить мини-переписку"
        : "Выберите чат, куда отправить сообщение";
    }
    renderForwardTargetList("");
    forwardModal.hidden = false;
    requestAnimationFrame(() => {
      forwardModal.classList.add("visible");
    });
    forwardModal.querySelector("[data-forward-search]")?.focus();
  }

  async function submitForwardMessage(targetChatId, targetChatType) {
    if (!forwardMessageState || (!forwardMessageState.messageId && !Array.isArray(forwardMessageState.messageIds))) {
      return;
    }

    const statusNode = forwardModal.querySelector("[data-forward-status]");
    const isDialogForward = forwardMessageState.mode === "dialog";
    const basePath = isDialogForward
      ? (chatType === "group" ? `/groups/${chatId}/messages/forward-dialog` : `/chats/${chatId}/messages/forward-dialog`)
      : (chatType === "group" ? `/groups/${chatId}/messages/${forwardMessageState.messageId}` : `/chats/${chatId}/messages/${forwardMessageState.messageId}`);

    if (statusNode) {
      statusNode.textContent = isDialogForward ? "Пересылаем диалог..." : "Пересылаем сообщение...";
      statusNode.className = "status forward-modal-status";
    }

    try {
      await apiFetch(isDialogForward ? basePath : `${basePath}/forward`, {
        method: "POST",
        body: JSON.stringify({
          ...(isDialogForward ? { message_ids: forwardMessageState.messageIds || [] } : {}),
          target_chat_id: targetChatId,
          target_chat_type: targetChatType
        })
      });
      if (isDialogForward) {
        exitSelectionMode();
      }
      closeForwardModal();
      showAppToast(isDialogForward ? "Диалог переслан" : "Сообщение переслано");
      await loadSidebar("chatList", { showLoading: false });
    } catch (error) {
      if (statusNode) {
        statusNode.textContent = error.message;
        statusNode.className = "status forward-modal-status error";
      }
    }
  }

  function buildReplyStateFromMessageNode(messageNode) {
    if (!messageNode) {
      return null;
    }

    const messageId = Number(messageNode.dataset.messageId || 0);
    if (!messageId) {
      return null;
    }

    const authorButton = messageNode.querySelector(".message-author");
    return {
      messageId,
      mode: "single",
      senderName: authorButton?.textContent?.trim()
        || (messageNode.dataset.own === "true" ? (currentUser?.name || currentUser?.username || "Вы") : "")
        || "Сообщение",
      text: messageNode.querySelector(".message-text")?.textContent
        || messageNode.querySelector(".message-forwarded-meta")?.textContent
        || "",
      messageType: String(messageNode.dataset.messageType || "text")
    };
  }

  function buildForwardDialogStateFromSelection() {
    const selectedItems = collectSelectedMessageItems();
    if (selectedItems.length < 2) {
      return null;
    }

    return {
      mode: "dialog",
      messageIds: selectedItems
        .sort((left, right) => (left.originalIndex || 0) - (right.originalIndex || 0))
        .map((item) => item.messageId),
      senderName: "Пересланный диалог",
      text: formatSelectedMessagesCount(selectedItems.length),
      messageType: "forwarded_dialog"
    };
  }

  function resetSwipeReplyState() {
    if (swipeReplyTarget) {
      swipeReplyTarget.classList.remove("is-swipe-replying");
      swipeReplyTarget.style.removeProperty("--swipe-reply-offset");
    }
    swipeReplyTarget = null;
    swipeReplyStartPoint = null;
    swipeReplyTracking = false;
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
      await loadSidebar("chatList", { showLoading: false });
      await markCurrentChatAsRead();
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

    const messageNode = findThreadMessageNode(messagesNode, messageId);
    if (!messageNode) {
      return;
    }

    const removedItem = {
      messageId: Number(messageId),
      messageNode,
      nextSibling: messageNode.nextElementSibling,
      anchorNextId: Number(messageNode.nextElementSibling?.dataset?.messageId || "0") || null,
      anchorPrevId: Number(messageNode.previousElementSibling?.dataset?.messageId || "0") || null,
      originalIndex: [...messagesNode.querySelectorAll(THREAD_MESSAGE_SELECTOR)].findIndex((node) => node === messageNode)
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
    const isTextMessage = (targetNode.dataset.messageType || "text") === "text";

    messageActionMenu.querySelector('[data-action="edit"]').hidden = !isOwnMessage || !isTextMessage;
    messageActionMenu.querySelector('[data-action="delete-all"]').hidden = !isOwnMessage;
    messageActionMenu.hidden = false;

    const menuWidth = 180;
    const menuHeight = isOwnMessage ? (isTextMessage ? 244 : 204) : 184;
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

  async function markCurrentChatAsRead() {
    if (!chatId || isMarkingRead) {
      return;
    }

    const readPath = chatType === "group" ? `/groups/${chatId}/read` : `/chats/${chatId}/read`;
    isMarkingRead = true;
    try {
      const result = await apiFetch(readPath, {
        method: "POST"
      });
      if (chatType === "direct" && result?.upto_message_id) {
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

    let lastError = null;
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
        window.history.replaceState({}, "", getDirectChatRoute(chatId));
        return chatId;
      } catch (error) {
        lastError = error;
        if (/ограничил сообщения/i.test(String(error?.message || ""))) {
          throw error;
        }
      }
    }

    throw lastError || new Error("Не удалось создать личный чат");
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

    currentThreadInfo = {
      ...data,
      title
    };
    setActiveThreadInfoView(currentThreadInfo, chatType);
    setChatTitle(currentThreadInfo);
    renderHeaderStatus();
    fillThreadInfoPanel(currentThreadInfo, chatType);
    updateThreadInviteControls();
    syncComposerAvailability();
    const nextMessages = data.messages || [];
    exitSelectionMode();
    renderMessages(messagesNode, nextMessages, currentUser.id, chatType);
    updatePaginationState(nextMessages, data.has_more_messages);
    isShowingSearchContext = false;
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

        if (String(message.sender_id) !== String(currentUser.id)) {
          markCurrentChatAsRead();
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
        await loadSidebar("chatList", { showLoading: false });
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
        await loadSidebar("chatList", { showLoading: false });
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

        window.location.href = getChatsRoute();
      });

      socket.on("presence_updated", async (data) => {
        const targetUserId = String(data?.user_id || "");
        const isOnline = Boolean(data?.is_online);
        const lastSeen = data?.last_seen || null;

        let shouldRerender = false;

        if (currentThreadInfo && String(currentThreadInfo.user_id || currentThreadInfo.id || "") === targetUserId) {
          currentThreadInfo = {
            ...currentThreadInfo,
            is_online: isOnline,
            last_seen: lastSeen
          };
          shouldRerender = true;
        }

        if (activeThreadInfoType === "direct" && activeThreadInfoView && String(activeThreadInfoView.user_id || activeThreadInfoView.id || "") === targetUserId) {
          activeThreadInfoView = {
            ...activeThreadInfoView,
            is_online: isOnline,
            last_seen: lastSeen
          };
          shouldRerender = true;
        }

        if (shouldRerender && currentThreadInfo) {
          setChatTitle(currentThreadInfo);
          renderHeaderStatus();
        }

        if (shouldRerender) {
          fillThreadInfoPanel(
            activeThreadInfoType === chatType ? currentThreadInfo : activeThreadInfoView,
            activeThreadInfoType === chatType ? chatType : activeThreadInfoType
          );
          updateThreadInviteControls();
        }

        await loadSidebar("chatList", { showLoading: false });
      });

      socket.on("typing_started", (data) => {
        const roomMatches = chatType === "group"
          ? String(data?.chat_id) === String(chatId) && data?.chat_type === "group"
          : String(data?.chat_id) === String(chatId) && data?.chat_type === "direct";
        if (!roomMatches) {
          return;
        }
        setRemoteTypingUser(data?.user_id, data || {});
      });

      socket.on("typing_stopped", (data) => {
        const roomMatches = chatType === "group"
          ? String(data?.chat_id) === String(chatId) && data?.chat_type === "group"
          : String(data?.chat_id) === String(chatId) && data?.chat_type === "direct";
        if (!roomMatches) {
          return;
        }
        clearRemoteTypingUser(data?.user_id, true);
      });

      socket.on("group_members_updated", async (data) => {
        if (chatType !== "group" || String(data?.group_id) !== String(chatId)) {
          return;
        }

        try {
          await refreshCurrentThreadInfo();
        } catch {
          window.location.href = getChatsRoute();
        }
      });

      socket.on("group_updated", async (data) => {
        if (chatType !== "group" || String(data?.group_id) !== String(chatId)) {
          return;
        }

        try {
          await refreshCurrentThreadInfo();
          await loadSidebar("chatList", { showLoading: false });
        } catch {
          window.location.href = getChatsRoute();
        }
      });
    }

    socket.emit("join_chat", joinPayload);
  }

  try {
    if (chatId) {
      await loadThread();
      await markCurrentChatAsRead();
      connectRealtime();
    } else if (chatType !== "group" && userId) {
      const user = await loadSelectedUser();
      renderPendingDirectChat(user);
    } else if (serverId) {
      messagesNode.innerHTML = '<div class="empty-state">В этом сервере пока нет каналов. Создайте первый канал в одной из категорий.</div>';
      status.textContent = "";
      composer.hidden = true;
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
    setThreadInfoHeading("Информация", "Панель чата");
    setActiveThreadInfoView(currentThreadInfo, chatType);
    fillThreadInfoPanel(activeThreadInfoView, activeThreadInfoType);
    updateThreadInviteControls();
    setThreadInfoOpen(true);
  }

  contentHeaderNode?.addEventListener("click", (event) => {
    if (
      event.target.closest("a, button, input, textarea, select, label")
      || event.target.closest(".thread-back")
      || event.target.closest(".thread-mobile-search-trigger")
    ) {
      return;
    }
    openThreadInfoPanel();
  });
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
      closeThreadInfoActionMenu();
      if (serverId && chatId && typeof openServerStructureModal === "function") {
        openServerStructureModal("channel-rename", {
          serverId,
          groupId: chatId
        });
        return;
      }
      openThreadGroupEditModal();
    }
  });

  document.getElementById("threadInfoProfilePanel")?.addEventListener("click", (event) => {
    const menuTrigger = event.target.closest("[data-user-profile-menu-trigger]");
    if (menuTrigger) {
      event.preventDefault();
      event.stopPropagation();
      toggleUserProfileActionMenu(menuTrigger.closest("[data-user-profile-card]"));
      return;
    }

    const usernameButton = event.target.closest("[data-profile-copy-username]");
    if (usernameButton) {
      closeUserProfileActionMenus();
      const username = String(usernameButton.dataset.profileCopyUsername || "").trim();
      if (!username) {
        return;
      }
      if (!navigator.clipboard?.writeText) {
        setThreadProfileStatus("Буфер обмена недоступен", "error");
        return;
      }
      navigator.clipboard.writeText(`@${username}`)
        .then(() => {
          showAppToast("Username скопирован");
          setThreadProfileStatus("", "");
        })
        .catch(() => {
          setThreadProfileStatus("Не удалось скопировать username", "error");
        });
      return;
    }

    const actionButton = event.target.closest("[data-profile-contact-action]");
    if (!actionButton) {
      return;
    }

    closeUserProfileActionMenus();

    if (actionButton.dataset.profileContactAction === "copy-username") {
      const currentProfile = activeThreadInfoView && activeThreadInfoType === "direct" ? activeThreadInfoView : currentThreadInfo;
      const username = String(currentProfile?.username || "").trim();
      if (!username) {
        setThreadProfileStatus("Username не указан", "error");
        return;
      }
      if (!navigator.clipboard?.writeText) {
        setThreadProfileStatus("Буфер обмена недоступен", "error");
        return;
      }
      navigator.clipboard.writeText(`@${username}`)
        .then(() => {
          showAppToast("Username скопирован");
          setThreadProfileStatus("", "");
        })
        .catch(() => {
          setThreadProfileStatus("Не удалось скопировать username", "error");
        });
      return;
    }

    void handleThreadProfileAction(
      actionButton.dataset.profileContactAction,
      actionButton.dataset.profileUserId
    );
  });

  threadInfoInviteCopy?.addEventListener("click", () => {
    void copyThreadInviteLink();
  });

  threadInfoInviteToggle?.addEventListener("click", () => {
    if (threadInfoInviteFact?.hidden) {
      return;
    }
    setThreadInviteExpanded(!isThreadInviteExpanded);
  });

  threadInfoInvitePanel?.addEventListener("transitionend", (event) => {
    if (event.propertyName !== "max-height") {
      return;
    }
    if (!isThreadInviteExpanded) {
      threadInfoInvitePanel.hidden = true;
    }
  });

  window.addEventListener("resize", () => {
    if (isThreadInviteExpanded) {
      syncThreadInvitePanelHeight();
    }
  });

  threadInfoSearchAction?.addEventListener("click", () => {
    if (threadInfoSearchPanel?.hidden) {
      openThreadSearchPanel();
      return;
    }
    closeThreadSearchPanel();
  });

  threadInfoSearchInput?.addEventListener("input", () => {
    syncThreadSearchInputs(threadInfoSearchInput.value || "", "desktop");
    if (threadSearchDebounceTimer) {
      window.clearTimeout(threadSearchDebounceTimer);
    }
    threadSearchDebounceTimer = window.setTimeout(() => {
      threadSearchDebounceTimer = null;
      void runThreadMessageSearch(threadInfoSearchInput.value || "", "desktop");
    }, 220);
  });

  threadInfoSearchResults?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-thread-search-message-id]");
    const messageId = Number(button?.dataset.threadSearchMessageId || "0");
    if (!messageId) {
      return;
    }
    void focusMessageFromSearch(messageId, "desktop");
  });

  threadInfoSearchReset?.addEventListener("click", () => {
    void restoreLatestThreadView("desktop");
  });

  threadMobileSearchTrigger?.addEventListener("click", () => {
    closeThreadInfoActionMenu();
    closeThreadMemberAddModal();
    closeThreadGroupEditModal();
    setThreadInfoOpen(false);
    openMobileThreadSearchMode();
  });

  threadMobileSearchClose?.addEventListener("click", () => {
    closeMobileThreadSearchMode();
  });

  threadMobileSearchClear?.addEventListener("click", () => {
    syncThreadSearchInputs("", "");
    clearThreadSearchResults("mobile");
    setThreadSearchStatus("Введите текст для поиска", "", "mobile");
    threadMobileSearchInput?.focus();
  });

  threadMobileSearchInput?.addEventListener("input", () => {
    syncThreadSearchInputs(threadMobileSearchInput.value || "", "mobile");
    if (threadSearchDebounceTimer) {
      window.clearTimeout(threadSearchDebounceTimer);
    }
    threadSearchDebounceTimer = window.setTimeout(() => {
      threadSearchDebounceTimer = null;
      void runThreadMessageSearch(threadMobileSearchInput.value || "", "mobile");
    }, 220);
  });

  threadMobileSearchResults?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-thread-search-message-id]");
    const messageId = Number(button?.dataset.threadSearchMessageId || "0");
    if (!messageId) {
      return;
    }
    closeMobileThreadSearchMode();
    void focusMessageFromSearch(messageId, "mobile");
  });

  threadInfoInviteRegenerate?.addEventListener("click", () => {
    void regenerateThreadInviteLink();
  });

  threadInfoMembersListNode?.addEventListener("contextmenu", (event) => {
    const memberItem = event.target.closest(".member-item[data-member-id]");
    if (!memberItem || chatType !== "group" || !canManageThreadMember(memberItem)) {
      return;
    }

    event.preventDefault();
    showThreadMemberActionMenu(memberItem, event.clientX, event.clientY);
  });

  threadInfoMembersListNode?.addEventListener("click", (event) => {
    const trigger = event.target.closest("[data-member-menu-trigger]");
    if (!trigger || chatType !== "group") {
      return;
    }

    const memberItem = trigger.closest(".member-item[data-member-id]");
    if (!memberItem || !canManageThreadMember(memberItem)) {
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
    if (!touch || !memberItem || chatType !== "group" || !canManageThreadMember(memberItem)) {
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
    void searchThreadMemberDirectory(threadMemberAddInput.value);
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
      setChatTitle(currentThreadInfo.title);
      renderHeaderStatus();
      fillThreadInfoPanel(currentThreadInfo, chatType);
      updateThreadInviteControls();
      await loadSidebar("chatList", { showLoading: false });
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

    if (!getAppSetting("enterToSend")) {
      return;
    }

    if (!input.value.trim()) {
      event.preventDefault();
      return;
    }

    event.preventDefault();
    composer.requestSubmit();
  });

  input.addEventListener("input", () => {
    resizeComposerInput();
    updateComposerActionButton();
    handleComposerTyping();
  });

  input.addEventListener("blur", () => {
    emitTypingStop();
  });

  photoMessageButton?.addEventListener("click", () => {
    if (isSendingMessage || isRecordingVoice) {
      return;
    }
    hideStickerPicker();
    photoMessageInput?.click();
  });

  photoMessageInput?.addEventListener("change", () => {
    const files = [...(photoMessageInput.files || [])];
    if (!files.length) {
      return;
    }
    appendComposerAttachments(files);
    photoMessageInput.value = "";
  });

  composerAttachmentsNode?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-remove-composer-attachment]");
    if (!button) {
      return;
    }
    const attachmentId = Number(button.dataset.removeComposerAttachment || "0");
    if (!attachmentId) {
      return;
    }
    removeComposerAttachment(attachmentId);
  });

  stickerPickerButton?.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (isSendingMessage || isRecordingVoice) {
      return;
    }
    await showStickerPicker();
  });

  stickerPackTabs?.addEventListener("click", (event) => {
    const tab = event.target.closest("[data-sticker-pack-id]");
    if (!tab) {
      return;
    }
    activeStickerPackId = String(tab.dataset.stickerPackId || "");
    renderStickerPicker();
  });

  stickerGrid?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-sticker-id]");
    if (!button) {
      return;
    }
    const stickerId = Number(button.dataset.stickerId || "0");
    const stickerUrl = String(button.dataset.stickerUrl || "");
    if (!stickerId || !stickerUrl) {
      return;
    }
    void sendStickerMessage({ id: stickerId, url: stickerUrl });
  });

  stickerPickerPopup?.addEventListener("click", (event) => {
    event.stopPropagation();
  });

  sendButton?.addEventListener("click", async (event) => {
    if (isSendingMessage) {
      event.preventDefault();
      return;
    }

    const hasText = Boolean(input.value.trim());
    const hasAttachments = composerAttachments.length > 0;
    if (isRecordingVoice) {
      event.preventDefault();
      stopVoiceRecording();
      return;
    }

    if (!hasText && !hasAttachments && !editingMessageState && composerMode !== "wide") {
      event.preventDefault();
      await startVoiceRecording();
    }
  });

  sendButton?.addEventListener("contextmenu", async (event) => {
    event.preventDefault();
    openComposerSendMenu(event.clientX, event.clientY);
  });

  composerSendSuperButton?.addEventListener("click", async () => {
    hideComposerSendMenu();
    await submitComposerMessage({ forceWide: true });
  });

  wideMessageButton?.addEventListener("click", () => {
    if (!canUseWideComposerMode() || isSendingMessage || isRecordingVoice) {
      return;
    }
    setComposerWideMode(composerMode === "wide" ? "normal" : "wide");
    input.focus();
  });

  cancelWideModeButton?.addEventListener("click", () => {
    setComposerWideMode("normal");
    input.focus();
  });

  messagesNode.addEventListener("click", (event) => {
    const imageTrigger = event.target.closest("[data-image-modal-src]");
    if (imageTrigger) {
      const attachmentsNode = imageTrigger.closest(".message-attachments");
      const gallery = attachmentsNode
        ? [...attachmentsNode.querySelectorAll("[data-image-modal-src]")].map((node) => String(node.dataset.imageModalSrc || "").trim()).filter(Boolean)
        : [String(imageTrigger.dataset.imageModalSrc || "").trim()].filter(Boolean);
      const startIndex = Number(imageTrigger.dataset.imageModalIndex || "0");
      openImageModal(String(imageTrigger.dataset.imageModalSrc || "").trim(), gallery, startIndex);
      return;
    }

    const serverInviteJoinButton = event.target.closest("[data-server-invite-join]");
    if (serverInviteJoinButton) {
      event.preventDefault();
      const inviteCode = String(serverInviteJoinButton.dataset.serverInviteJoin || "").trim();
      if (!inviteCode || serverInviteJoinButton.disabled) {
        return;
      }
      serverInviteJoinButton.disabled = true;
      serverInviteJoinButton.textContent = "Подключаем...";
      apiFetch(`/server-invite/${encodeURIComponent(inviteCode)}/join`, {
        method: "POST"
      }).then((payload) => {
        const invite = payload?.invite;
        if (invite?.code) {
          serverInvitePreviewCache.set(invite.code, invite);
        }
        if (payload?.pending_approval) {
          serverInviteJoinButton.textContent = "Заявка отправлена";
          showAppToast("Заявка на вступление отправлена");
          return;
        }
        if (payload?.redirect_url) {
          window.location.href = payload.redirect_url;
          return;
        }
        serverInviteJoinButton.textContent = "Вы присоединились";
      }).catch((error) => {
        serverInviteJoinButton.disabled = false;
        serverInviteJoinButton.textContent = "Присоединиться";
        showAppToast(error.message || "Не удалось принять приглашение", { type: "error" });
      });
      return;
    }

    const serverInviteOpenButton = event.target.closest("[data-server-invite-open]");
    if (serverInviteOpenButton) {
      event.preventDefault();
      const serverId = String(serverInviteOpenButton.dataset.serverInviteOpen || "").trim();
      const groupId = String(serverInviteOpenButton.dataset.serverInviteChannel || "").trim();
      window.location.href = serverId && groupId ? getServerChannelRoute(serverId, groupId) : getServerRoute(serverId);
      return;
    }
  });

  imageModal?.addEventListener("click", (event) => {
    if (event.target.closest("[data-image-modal-close]")) {
      closeImageModal();
      return;
    }
    const navButton = event.target.closest("[data-image-modal-nav]");
    if (navButton) {
      stepImageModal(navButton.dataset.imageModalNav === "prev" ? -1 : 1);
    }
  });

  imageModal?.addEventListener("touchstart", (event) => {
    imageModalTouchStartX = Number(event.touches?.[0]?.clientX || 0);
    imageModalTouchDeltaX = 0;
    isDraggingImageModal = activeImageGallery.length > 1;
  }, { passive: true });

  imageModal?.addEventListener("touchmove", (event) => {
    if (!isDraggingImageModal || activeImageGallery.length <= 1) {
      return;
    }
    const touchX = Number(event.touches?.[0]?.clientX || 0);
    updateImageModalDrag(touchX - imageModalTouchStartX);
  }, { passive: true });

  imageModal?.addEventListener("touchend", (event) => {
    if (!isDraggingImageModal || activeImageGallery.length <= 1) {
      return;
    }
    const touchEndX = Number(event.changedTouches?.[0]?.clientX || 0);
    updateImageModalDrag(touchEndX - imageModalTouchStartX);
    settleImageModalDrag();
  }, { passive: true });

  imageModal?.addEventListener("touchcancel", () => {
    if (!isDraggingImageModal) {
      return;
    }
    settleImageModalDrag();
  }, { passive: true });

  messagesNode.addEventListener("scroll", () => {
    hideMessageMenu();
    hideStickerPicker();
    if (messagesNode.scrollTop <= TOP_LOAD_THRESHOLD) {
      loadOlderMessages();
    }
    updateScrollDownButton(messagesNode, scrollDownButton);
  });

  messagesNode.addEventListener("contextmenu", (event) => {
    const messageNode = getThreadMessageTargetNode(event.target);
    if (!messageNode || messageNode.classList.contains("pending") || isSystemMessageNode(messageNode)) {
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
    const authorTrigger = event.target.closest("[data-message-author-id]");
    if (authorTrigger && chatType === "group") {
      event.preventDefault();
      event.stopPropagation();
      void openMessageAuthorProfile(authorTrigger.dataset.messageAuthorId);
      return;
    }

    const forwardedTrigger = event.target.closest("[data-forwarded-from-user-id]");
    if (forwardedTrigger) {
      event.preventDefault();
      event.stopPropagation();
      void openMessageAuthorProfile(forwardedTrigger.dataset.forwardedFromUserId);
      return;
    }

    const voiceToggle = event.target.closest("[data-voice-toggle]");
    if (voiceToggle) {
      event.preventDefault();
      const player = voiceToggle.closest('[data-voice-player="true"]');
      const audio = player?.querySelector(".voice-message-audio");
      if (!audio) {
        return;
      }
      if (audio.paused || audio.ended) {
        if (audio.ended || player?.dataset.voiceCompleted === "true") {
          player.dataset.voiceCompleted = "false";
          audio.currentTime = 0;
        }
        void audio.play().catch(() => {});
      } else {
        audio.pause();
      }
      return;
    }

    const voiceSeek = event.target.closest("[data-voice-seek]");
    if (voiceSeek) {
      event.preventDefault();
      const player = voiceSeek.closest('[data-voice-player="true"]');
      const audio = player?.querySelector(".voice-message-audio");
      if (!audio) {
        return;
      }
      const rect = voiceSeek.getBoundingClientRect();
      const ratio = rect.width > 0 ? Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)) : 0;
      const fallbackDuration = Number(audio.dataset.durationMs || 0) / 1000;
      const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : fallbackDuration;
      if (duration > 0) {
        audio.currentTime = duration * ratio;
        if (player && ratio < 0.999) {
          player.dataset.voiceCompleted = "false";
        }
        syncVoicePlayerState(player);
      }
      return;
    }

    const replyJumpNode = event.target.closest("[data-reply-jump-id]");
    if (replyJumpNode) {
      event.preventDefault();
      const targetMessageId = Number(replyJumpNode.dataset.replyJumpId || 0);
      if (targetMessageId) {
        void focusMessageFromSearch(targetMessageId, isMobileThreadSearchOpen ? "mobile" : "desktop");
      }
      return;
    }

    const forwardedDialogToggle = event.target.closest("[data-forwarded-dialog-toggle]");
    if (forwardedDialogToggle) {
      event.preventDefault();
      const cardNode = forwardedDialogToggle.closest("[data-forwarded-dialog-card]");
      if (!cardNode) {
        return;
      }

      const hiddenItems = [...cardNode.querySelectorAll("[data-forwarded-dialog-hidden-item]")];
      const isExpanded = forwardedDialogToggle.dataset.forwardedDialogToggle === "collapse";
      hiddenItems.forEach((node) => {
        node.hidden = isExpanded;
      });
      forwardedDialogToggle.dataset.forwardedDialogToggle = isExpanded ? "expand" : "collapse";
      forwardedDialogToggle.textContent = isExpanded
        ? `Показать полностью (${hiddenItems.length})`
        : "Свернуть";
      return;
    }

    const messageNode = getThreadMessageTargetNode(event.target);
    if (!isSelectionMode || !messageNode || messageNode.classList.contains("pending") || isSystemMessageNode(messageNode)) {
      return;
    }

    event.preventDefault();
    toggleMessageSelection(messageNode);
  });

  messagesNode.addEventListener("touchstart", (event) => {
    const touch = event.touches[0];
    const messageNode = getThreadMessageTargetNode(event.target);
    if (!touch || !messageNode || messageNode.classList.contains("pending") || isSystemMessageNode(messageNode)) {
      touchMenuTarget = null;
      touchMenuPoint = null;
      return;
    }

    touchMenuTarget = messageNode;
    touchMenuPoint = { x: touch.clientX, y: touch.clientY };
    swipeReplyTarget = messageNode;
    swipeReplyStartPoint = { x: touch.clientX, y: touch.clientY };
    swipeReplyTracking = true;
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

    if (!swipeReplyTracking || !swipeReplyTarget || !swipeReplyStartPoint) {
      return;
    }

    const replyDeltaX = touch.clientX - swipeReplyStartPoint.x;
    const replyDeltaY = touch.clientY - swipeReplyStartPoint.y;
    if (Math.abs(replyDeltaY) > 28) {
      resetSwipeReplyState();
      return;
    }

    const clampedOffset = Math.max(0, Math.min(88, replyDeltaX));
    swipeReplyTarget.style.setProperty("--swipe-reply-offset", `${clampedOffset}px`);
    swipeReplyTarget.classList.toggle("is-swipe-replying", clampedOffset > 8);
  }, { passive: true });

  messagesNode.addEventListener("touchend", () => {
    if (swipeReplyTracking && swipeReplyTarget) {
      const offset = Number.parseFloat(swipeReplyTarget.style.getPropertyValue("--swipe-reply-offset") || "0");
      if (offset >= 56) {
        const replyState = buildReplyStateFromMessageNode(swipeReplyTarget);
        if (replyState) {
          setReplyMessageState(replyState);
        }
      }
    }
    resetSwipeReplyState();
    if (touchMenuPressTimer) {
      window.clearTimeout(touchMenuPressTimer);
      touchMenuPressTimer = null;
    }
    touchMenuTarget = null;
    touchMenuPoint = null;
  }, { passive: true });

  messagesNode.addEventListener("touchcancel", () => {
    resetSwipeReplyState();
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
      if (action === "reply") {
        const replyState = buildReplyStateFromMessageNode(targetNode);
        if (replyState) {
          setReplyMessageState(replyState);
        }
        return;
      } else if (action === "forward") {
        const forwardState = buildReplyStateFromMessageNode(targetNode);
        if (forwardState) {
          openForwardModal(forwardState);
        }
        return;
      } else if (action === "select") {
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

      await loadSidebar("chatList", { showLoading: false });
      await markCurrentChatAsRead();
    } catch (error) {
      status.textContent = error.message;
      status.className = "status error";
    }
  });

  document.addEventListener("click", (event) => {
    if (!event.target.closest("#composerSendMenu") && !event.target.closest(".send-button")) {
      hideComposerSendMenu();
    }
    if (!event.target.closest(".message-action-menu")) {
      hideMessageMenu();
    }
    if (!event.target.closest(".thread-member-action-menu") && !event.target.closest("[data-member-menu-trigger]")) {
      hideThreadMemberActionMenu();
    }
    if (!event.target.closest("[data-user-profile-card]")) {
      closeUserProfileActionMenus();
    }
  });

  document.addEventListener("mousedown", (event) => {
    if (!event.target.closest("#composerSendMenu") && !event.target.closest(".send-button")) {
      hideComposerSendMenu();
    }
    if (!event.target.closest(".message-action-menu") && !getThreadMessageTargetNode(event.target)) {
      hideMessageMenu();
    }
    if (!event.target.closest(".thread-member-action-menu") && !event.target.closest(".member-item[data-member-id]")) {
      hideThreadMemberActionMenu();
    }
  });

  document.addEventListener("touchstart", (event) => {
    if (!event.target.closest("#composerSendMenu") && !event.target.closest(".send-button")) {
      hideComposerSendMenu();
    }
    if (!event.target.closest(".message-action-menu") && !getThreadMessageTargetNode(event.target)) {
      hideMessageMenu();
    }
    if (!event.target.closest(".thread-member-action-menu") && !event.target.closest(".member-item[data-member-id]")) {
      hideThreadMemberActionMenu();
    }
  }, { passive: true });

  document.addEventListener("contextmenu", (event) => {
    if (!event.target.closest("#composerSendMenu") && !event.target.closest(".send-button")) {
      hideComposerSendMenu();
    }
    if (!event.target.closest(".message-action-menu") && !getThreadMessageTargetNode(event.target)) {
      hideMessageMenu();
    }
    if (!event.target.closest(".thread-member-action-menu") && !event.target.closest(".member-item[data-member-id]")) {
      hideThreadMemberActionMenu();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      hideComposerSendMenu();
      if (!forwardModal.hidden) {
        closeForwardModal();
        return;
      }
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
      if (replyMessageState) {
        setReplyMessageState(null);
      }
      hideMessageMenu();
      hideThreadMemberActionMenu();
      closeUserProfileActionMenus();
    }
  });

  editBanner.querySelector(".composer-edit-cancel")?.addEventListener("click", () => {
    setEditingMessageState(null);
    input.value = "";
    status.textContent = "";
    status.className = "status thread-status";
  });

  replyBanner.querySelector(".composer-reply-cancel")?.addEventListener("click", () => {
    setReplyMessageState(null);
  });

  forwardModal.addEventListener("click", (event) => {
    const closeTrigger = event.target.closest("[data-forward-close]");
    if (closeTrigger) {
      closeForwardModal();
      return;
    }

    const targetTrigger = event.target.closest("[data-forward-target-key]");
    if (!targetTrigger) {
      return;
    }

    selectedForwardTargetKey = targetTrigger.dataset.forwardTargetKey || "";
    renderForwardTargetList(forwardModal.querySelector("[data-forward-search]")?.value || "");
    void submitForwardMessage(
      Number(targetTrigger.dataset.forwardTargetId || 0),
      targetTrigger.dataset.forwardTargetType || "direct"
    );
  });

  forwardModal.querySelector("[data-forward-search]")?.addEventListener("input", (event) => {
    renderForwardTargetList(event.target.value || "");
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

    if (action === "forward-dialog") {
      const forwardDialogState = buildForwardDialogStateFromSelection();
      if (forwardDialogState) {
        openForwardModal(forwardDialogState);
      }
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
    await submitComposerMessage();
  });

  window.addEventListener("pagehide", () => {
    emitTypingStop();
    releaseRecordingStream();
    if (typingCooldownTimer) {
      window.clearTimeout(typingCooldownTimer);
      typingCooldownTimer = null;
    }
    if (socket) {
      socket.disconnect();
      socket = null;
    }
  });

  document.addEventListener("appsettingschange", () => {
    refreshVisibleMessageTimes();
  });

  window.addEventListener("beforeunload", () => {
    emitTypingStop();
    if (typingCooldownTimer) {
      window.clearTimeout(typingCooldownTimer);
      typingCooldownTimer = null;
    }
    if (socket) {
      socket.disconnect();
      socket = null;
    }
  });

  resizeComposerInput();
  updateComposerActionButton();

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && imageModal && !imageModal.hidden) {
      closeImageModal();
      return;
    }
    if (event.key === "ArrowLeft" && imageModal && !imageModal.hidden) {
      stepImageModal(-1);
      return;
    }
    if (event.key === "ArrowRight" && imageModal && !imageModal.hidden) {
      stepImageModal(1);
      return;
    }
    if (event.key === "Escape" && stickerPickerPopup && !stickerPickerPopup.hidden) {
      hideStickerPicker();
      return;
    }
    if (event.key === "Escape" && isMobileThreadSearchOpen) {
      closeMobileThreadSearchMode();
      return;
    }
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
    if (!stickerPickerPopup || stickerPickerPopup.hidden) {
      return;
    }
    if (event.target.closest("#stickerPickerPopup") || event.target.closest("#stickerPickerButton")) {
      return;
    }
    hideStickerPicker();
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
