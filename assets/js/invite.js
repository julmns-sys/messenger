function setInviteStatus(message, type = "") {
  const status = document.getElementById("inviteStatus");
  if (!status) {
    return;
  }
  status.textContent = message;
  status.className = `status invite-status ${type}`.trim();
}

document.addEventListener("DOMContentLoaded", () => {
  const titleNode = document.getElementById("inviteTitle");
  const subtitleNode = document.getElementById("inviteSubtitle");
  const descriptionNode = document.getElementById("inviteDescription");
  const avatarNode = document.getElementById("inviteAvatar");
  const joinButton = document.getElementById("inviteJoinButton");
  const openButton = document.getElementById("inviteOpenButton");
  const route = getCurrentRouteInfo();
  const isGroupInvite = route.page === "invite";
  const isServerInvite = route.page === "server-invite";
  const inviteCode = isGroupInvite || isServerInvite ? route.segments[1] : "";
  const inviteRoute = isServerInvite ? getServerInviteRoute(inviteCode) : getInviteRoute(inviteCode);
  const entityLabel = isServerInvite ? "сервер" : "группу";
  const currentPath = window.location.pathname + window.location.search + window.location.hash;

  if (!inviteCode) {
    setInviteStatus("Ссылка приглашения недействительна", "error");
    if (joinButton) {
      joinButton.disabled = true;
    }
    return;
  }

  if (!getToken()) {
    setPostAuthRedirect(currentPath);
    const next = encodeURIComponent(currentPath);
    window.location.replace(`${getLoginRoute()}?next=${next}`);
    return;
  }

  let inviteData = null;
  let isJoining = false;

  function renderInvite(data) {
    inviteData = data;
    const title = isServerInvite
      ? (data?.server_name || "Сервер")
      : (data?.title || "Группа");
    const membersCount = Number(data?.members_count || 0);
    const onlineCount = Number(data?.online_count || 0);
    const description = isServerInvite
      ? (data?.already_member
          ? "Вы уже состоите на этом сервере."
          : data?.require_approval
            ? "Для вступления может потребоваться подтверждение."
            : "Откройте приглашение и присоединитесь к серверу.")
      : (typeof data?.description === "string" && data.description.trim()
          ? data.description.trim()
          : "Описание группы пока не добавлено.");

    if (titleNode) {
      titleNode.textContent = title;
    }
    if (subtitleNode) {
      subtitleNode.textContent = isServerInvite
        ? `${membersCount} участников${onlineCount > 0 ? ` · ${onlineCount} онлайн` : ""}`
        : `${membersCount} участников`;
    }
    if (descriptionNode) {
      descriptionNode.textContent = description;
    }
    if (avatarNode) {
      avatarNode.textContent = initials(title);
    }
    if (openButton && data?.redirect_url) {
      openButton.href = data.redirect_url;
    }
    if (joinButton) {
      joinButton.textContent = data?.already_member
        ? (isServerInvite ? "Открыть сервер" : "Открыть группу")
        : (isServerInvite ? "Вступить на сервер" : "Вступить в группу");
    }
  }

  async function loadInvite() {
    try {
      const data = await apiFetch(inviteRoute);
      if (data?.already_member && data.redirect_url) {
        window.location.replace(data.redirect_url);
        return;
      }

      renderInvite(data);
      if (joinButton) {
        joinButton.disabled = false;
      }
      setInviteStatus("");
    } catch (error) {
      if (error.message === "Не авторизован") {
        setPostAuthRedirect(currentPath);
        const next = encodeURIComponent(currentPath);
        window.location.replace(`${getLoginRoute()}?next=${next}`);
        return;
      }

      if (titleNode) {
        titleNode.textContent = "Ссылка недействительна";
      }
      if (subtitleNode) {
        subtitleNode.textContent = "Приглашение больше не работает";
      }
      if (descriptionNode) {
        descriptionNode.textContent = `Попросите администратора прислать новую ссылку на ${entityLabel}.`;
      }
      if (joinButton) {
        joinButton.disabled = true;
      }
      if (openButton) {
        openButton.hidden = true;
      }
      setInviteStatus(error.message, "error");
    }
  }

  joinButton?.addEventListener("click", async () => {
    if (isJoining || !inviteData) {
      return;
    }

    isJoining = true;
    joinButton.disabled = true;
    joinButton.textContent = isServerInvite ? "Подключаем..." : "Вступаем...";
    setInviteStatus(isServerInvite ? "Подключаем вас к серверу..." : "Добавляем вас в группу...", "");

    try {
      const data = await apiFetch(`${inviteRoute}/join`, {
        method: "POST"
      });
      const redirectUrl = data?.redirect_url || inviteData?.redirect_url || getChatsRoute();
      const pendingApproval = Boolean(data?.pending_approval);
      if (pendingApproval) {
        isJoining = false;
        joinButton.disabled = false;
        joinButton.textContent = "Ожидает подтверждения";
        setInviteStatus("Заявка отправлена. Ожидайте подтверждения администратора.", "success");
        return;
      }
      if (isServerInvite && data?.server_id) {
        try {
          writeSelectedServerId(String(data.server_id));
          writeStoredSidebarView("server-detail");
        } catch {
          // Ignore local sidebar state persistence failures.
        }
      }
      setInviteStatus(isServerInvite ? "Готово. Открываем сервер..." : "Готово. Открываем группу...", "success");
      if (openButton) {
        openButton.href = redirectUrl;
        openButton.hidden = false;
      }
      joinButton.textContent = isServerInvite ? "Подключено" : "Вступили";
      window.setTimeout(() => {
        window.location.replace(redirectUrl);
      }, 220);
    } catch (error) {
      isJoining = false;
      joinButton.disabled = false;
      joinButton.textContent = isServerInvite ? "Вступить на сервер" : "Вступить в группу";
      if (error.message === "Не авторизован") {
        setPostAuthRedirect(currentPath);
        const next = encodeURIComponent(currentPath);
        window.location.replace(`${getLoginRoute()}?next=${next}`);
        return;
      }
      setInviteStatus(error.message, "error");
    }
  });

  void loadInvite();
});
