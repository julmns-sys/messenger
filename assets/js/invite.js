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
  const inviteToken = route.page === "invite" ? route.segments[1] : "";
  const currentPath = window.location.pathname + window.location.search + window.location.hash;

  if (!inviteToken) {
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
    const title = data?.title || "Группа";
    const membersCount = Number(data?.members_count || 0);
    const description = typeof data?.description === "string" && data.description.trim()
      ? data.description.trim()
      : "Описание группы пока не добавлено.";

    if (titleNode) {
      titleNode.textContent = title;
    }
    if (subtitleNode) {
      subtitleNode.textContent = `${membersCount} участников`;
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
  }

  async function loadInvite() {
    try {
      const data = await apiFetch(getInviteRoute(inviteToken));
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
        descriptionNode.textContent = "Попросите администратора группы прислать новую invite-ссылку.";
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
    joinButton.textContent = "Вступаем...";
    setInviteStatus("Добавляем вас в группу...", "");

    try {
      const data = await apiFetch(`${getInviteRoute(inviteToken)}/join`, {
        method: "POST"
      });
      const redirectUrl = data?.redirect_url || inviteData?.redirect_url || getChatsRoute();
      setInviteStatus("Готово. Открываем группу...", "success");
      if (openButton) {
        openButton.href = redirectUrl;
        openButton.hidden = false;
      }
      joinButton.textContent = "Вступили";
      window.setTimeout(() => {
        window.location.replace(redirectUrl);
      }, 220);
    } catch (error) {
      isJoining = false;
      joinButton.disabled = false;
      joinButton.textContent = "Вступить в группу";
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
