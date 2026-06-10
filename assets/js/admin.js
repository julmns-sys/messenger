function formatBanLabel(user = {}) {
  if (!user.is_banned) {
    return "Активен";
  }
  if (user.banned_until) {
    return `Бан до ${formatDateTime(user.banned_until)}`;
  }
  return "Заблокирован";
}

function formatDateTime(value) {
  const date = parseUtcDate(value);
  if (!date) {
    return "";
  }
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function renderAdminUserCard(user = {}) {
  const perms = user.permissions || {};
  return `
    <article class="admin-user-card" data-admin-user-id="${escapeHtml(String(user.id || ""))}">
      <div class="admin-user-head">
        <div class="admin-user-ident">
          <div class="avatar admin-user-avatar">${escapeHtml(initials(user.name || user.username || "U"))}</div>
          <div class="admin-user-copy">
            <h3>${escapeHtml(user.name || "Без имени")}</h3>
            <p>@${escapeHtml(user.username || "")} · ID ${escapeHtml(String(user.id || ""))}</p>
            <p>${escapeHtml(user.email || "Email не указан")}</p>
          </div>
        </div>
        <div class="admin-user-badges">
          <span class="admin-user-role">${escapeHtml(user.role || "user")}</span>
          <span class="admin-user-state${user.is_banned ? " danger" : ""}">${escapeHtml(formatBanLabel(user))}</span>
        </div>
      </div>

      <div class="admin-user-controls">
        <label class="admin-permission-toggle">
          <input type="checkbox" data-permission-toggle="can_send_messages" ${perms.can_send_messages ? "checked" : ""} ${user.role === "system_owner" ? "disabled" : ""}>
          <span>Отправка сообщений</span>
        </label>
        <label class="admin-permission-toggle">
          <input type="checkbox" data-permission-toggle="can_upload_files" ${perms.can_upload_files ? "checked" : ""} ${user.role === "system_owner" ? "disabled" : ""}>
          <span>Загрузка файлов</span>
        </label>
        <label class="admin-permission-toggle">
          <input type="checkbox" data-permission-toggle="can_create_groups" ${perms.can_create_groups ? "checked" : ""} ${user.role === "system_owner" ? "disabled" : ""}>
          <span>Создание групп</span>
        </label>
      </div>

      <div class="admin-user-ban-form">
        <input class="input" type="text" data-ban-reason placeholder="Причина" value="${escapeHtml(user.banned_reason || "")}" ${user.role === "system_owner" ? "disabled" : ""}>
        <input class="input" type="datetime-local" data-ban-until value="${user.banned_until ? escapeHtml(String(user.banned_until).replace("Z", "").slice(0, 16)) : ""}" ${user.role === "system_owner" ? "disabled" : ""}>
      </div>

      <div class="admin-user-actions">
        <button class="button ${user.is_banned ? "button-secondary" : "button-danger"}" type="button" data-admin-ban-action="${user.is_banned ? "unban" : "ban"}" ${user.role === "system_owner" ? "disabled" : ""}>
          ${user.is_banned ? "Разбанить" : "Забанить"}
        </button>
        <button class="button button-danger" type="button" data-admin-delete-user="true" ${user.role === "system_owner" ? "disabled" : ""}>
          Удалить аккаунт
        </button>
      </div>
    </article>
  `;
}

const adminState = {
  users: [],
  settings: {
    global_file_uploads_enabled: true,
    global_stickers_enabled: true
  }
};

function setAdminStatus(message = "", type = "") {
  const node = document.getElementById("adminUsersStatus");
  if (!node) return;
  node.textContent = message;
  node.className = `status ${type}`.trim();
}

function renderAdminUsers() {
  const list = document.getElementById("adminUsersList");
  if (!list) return;
  list.innerHTML = adminState.users.length
    ? adminState.users.map((user) => renderAdminUserCard(user)).join("")
    : '<div class="empty-state">Пользователи не найдены</div>';
}

async function loadAdminUsers(query = "") {
  setAdminStatus("Загрузка пользователей...", "loading");
  try {
    const payload = query.trim()
      ? await apiFetch(`/admin/users/search?query=${encodeURIComponent(query.trim())}`)
      : await apiFetch("/admin/users");
    adminState.users = Array.isArray(payload.items) ? payload.items : [];
    renderAdminUsers();
    setAdminStatus("");
  } catch (error) {
    setAdminStatus(error.message, "error");
  }
}

async function loadAdminSettings() {
  const payload = await apiFetch("/admin/settings");
  adminState.settings = {
    global_file_uploads_enabled: Boolean(payload.global_file_uploads_enabled),
    global_stickers_enabled: Boolean(payload.global_stickers_enabled)
  };
  const filesToggle = document.getElementById("adminGlobalFilesToggle");
  const stickersToggle = document.getElementById("adminGlobalStickersToggle");
  if (filesToggle) {
    filesToggle.checked = adminState.settings.global_file_uploads_enabled;
  }
  if (stickersToggle) {
    stickersToggle.checked = adminState.settings.global_stickers_enabled;
  }
}

function updateAdminUser(user) {
  const index = adminState.users.findIndex((item) => Number(item.id) === Number(user.id));
  if (index === -1) {
    adminState.users.unshift(user);
  } else {
    adminState.users[index] = user;
  }
  renderAdminUsers();
}

document.addEventListener("DOMContentLoaded", async () => {
  applyAppSettings();
  requireAuth();
  bindLogout();
  fillUserBadge();
  initSidebarProfile();
  await loadSidebar();
  startChatsAutoRefresh();

  const currentUser = getCurrentUser();
  if (!["admin", "system_owner"].includes(currentUser?.role || "")) {
    window.location.href = getChatsRoute();
    return;
  }

  const list = document.getElementById("adminUsersList");
  const searchInput = document.getElementById("adminUserSearchInput");
  const searchButton = document.getElementById("adminUserSearchButton");
  const globalFilesToggle = document.getElementById("adminGlobalFilesToggle");
  const globalStickersToggle = document.getElementById("adminGlobalStickersToggle");
  const runtimeFilesSetting = document.getElementById("adminRuntimeFilesSetting");
  const runtimeStickersSetting = document.getElementById("adminRuntimeStickersSetting");
  const canManageRuntimeSettings = currentUser?.role === "system_owner";

  if (runtimeFilesSetting) {
    runtimeFilesSetting.hidden = !canManageRuntimeSettings;
  }
  if (runtimeStickersSetting) {
    runtimeStickersSetting.hidden = !canManageRuntimeSettings;
  }

  if (canManageRuntimeSettings) {
    await loadAdminSettings();
  }
  await loadAdminUsers();

  globalFilesToggle?.addEventListener("change", async () => {
    if (!canManageRuntimeSettings) {
      return;
    }
    try {
      const payload = await apiFetch("/admin/settings", {
        method: "PATCH",
        body: JSON.stringify({
          global_file_uploads_enabled: Boolean(globalFilesToggle.checked)
        })
      });
      adminState.settings.global_file_uploads_enabled = Boolean(payload.global_file_uploads_enabled);
      globalFilesToggle.checked = adminState.settings.global_file_uploads_enabled;
      setAdminStatus(
        adminState.settings.global_file_uploads_enabled
          ? "Глобальная отправка файлов включена"
          : "Глобальная отправка файлов отключена",
        "success"
      );
    } catch (error) {
      globalFilesToggle.checked = adminState.settings.global_file_uploads_enabled;
      setAdminStatus(error.message, "error");
    }
  });

  globalStickersToggle?.addEventListener("change", async () => {
    if (!canManageRuntimeSettings) {
      return;
    }
    try {
      const payload = await apiFetch("/admin/settings", {
        method: "PATCH",
        body: JSON.stringify({
          global_stickers_enabled: Boolean(globalStickersToggle.checked)
        })
      });
      adminState.settings.global_stickers_enabled = Boolean(payload.global_stickers_enabled);
      globalStickersToggle.checked = adminState.settings.global_stickers_enabled;
      setAdminStatus(
        adminState.settings.global_stickers_enabled
          ? "Глобальная отправка стикеров включена"
          : "Глобальная отправка стикеров отключена",
        "success"
      );
    } catch (error) {
      globalStickersToggle.checked = adminState.settings.global_stickers_enabled;
      setAdminStatus(error.message, "error");
    }
  });

  searchButton?.addEventListener("click", () => {
    void loadAdminUsers(searchInput?.value || "");
  });

  searchInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void loadAdminUsers(searchInput.value || "");
    }
  });

  list?.addEventListener("change", async (event) => {
    const checkbox = event.target.closest("[data-permission-toggle]");
    const card = event.target.closest("[data-admin-user-id]");
    if (!checkbox || !card) {
      return;
    }
    const userId = card.dataset.adminUserId;
    const payload = {
      can_send_messages: Boolean(card.querySelector('[data-permission-toggle="can_send_messages"]')?.checked),
      can_upload_files: Boolean(card.querySelector('[data-permission-toggle="can_upload_files"]')?.checked),
      can_create_groups: Boolean(card.querySelector('[data-permission-toggle="can_create_groups"]')?.checked)
    };
    try {
      const updated = await apiFetch(`/admin/users/${encodeURIComponent(userId)}/permissions`, {
        method: "PATCH",
        body: JSON.stringify(payload)
      });
      updateAdminUser(updated);
      setAdminStatus("Права обновлены", "success");
    } catch (error) {
      setAdminStatus(error.message, "error");
      void loadAdminUsers(searchInput?.value || "");
    }
  });

  list?.addEventListener("click", async (event) => {
    const deleteButton = event.target.closest("[data-admin-delete-user]");
    const deleteCard = event.target.closest("[data-admin-user-id]");
    if (deleteButton && deleteCard) {
      const userId = deleteCard.dataset.adminUserId;
      const reason = String(deleteCard.querySelector("[data-ban-reason]")?.value || "").trim();
      if (!window.confirm("Удалить аккаунт полностью? Это удалит чаты, сообщения, группы и связанные данные пользователя.")) {
        return;
      }
      try {
        await apiFetch(`/admin/users/${encodeURIComponent(userId)}`, {
          method: "DELETE",
          body: JSON.stringify({ reason })
        });
        adminState.users = adminState.users.filter((user) => Number(user.id) !== Number(userId));
        renderAdminUsers();
        setAdminStatus("Аккаунт удалён", "success");
      } catch (error) {
        setAdminStatus(error.message, "error");
      }
      return;
    }

    const actionButton = event.target.closest("[data-admin-ban-action]");
    const card = event.target.closest("[data-admin-user-id]");
    if (!actionButton || !card) {
      return;
    }
    const userId = card.dataset.adminUserId;
    const action = actionButton.dataset.adminBanAction;
    const reason = String(card.querySelector("[data-ban-reason]")?.value || "").trim();
    const bannedUntilRaw = String(card.querySelector("[data-ban-until]")?.value || "").trim();
    try {
      const updated = await apiFetch(`/admin/users/${encodeURIComponent(userId)}/${action}`, {
        method: "POST",
        body: JSON.stringify(action === "ban" ? {
          reason,
          banned_until: bannedUntilRaw ? new Date(bannedUntilRaw).toISOString() : null
        } : { reason })
      });
      updateAdminUser(updated);
      setAdminStatus(action === "ban" ? "Пользователь заблокирован" : "Пользователь разблокирован", "success");
    } catch (error) {
      setAdminStatus(error.message, "error");
    }
  });
});
