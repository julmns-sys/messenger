function setStatus(message, type = "") {
  const status = document.getElementById("status");
  if (!status) return;
  status.className = `status ${type}`.trim();
  status.textContent = message;
}

document.addEventListener("DOMContentLoaded", () => {
  const form = document.querySelector("form[data-auth]");
  if (!form) return;

  const mode = form.dataset.auth;
  const endpoint = mode === "register" ? "/auth/register" : "/auth/login";
  const params = new URLSearchParams(window.location.search);
  const nextPath = normalizeRedirectPath(params.get("next")) || getPostAuthRedirect();

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    setStatus("Отправка...");

    const formData = new FormData(form);
    const payload = Object.fromEntries(formData.entries());
    payload.device_id = getOrCreateDeviceId();

    try {
      const data = await apiFetch(endpoint, {
        method: "POST",
        body: JSON.stringify(payload)
      });

      if (data.base_url) {
        setApiBase(data.base_url);
      }

      if (data.token) {
        setSession(data.token, {
          ...payload,
          ...(data.user || {})
        });
      }

      setStatus(mode === "register" ? "Аккаунт создан" : "Вход выполнен", "success");
      window.setTimeout(() => {
        const redirectPath = nextPath || consumePostAuthRedirect() || getChatsRoute();
        if (nextPath) {
          consumePostAuthRedirect();
        }
        window.location.href = redirectPath;
      }, 300);
    } catch (error) {
      setStatus(error.message, "error");
    }
  });
});
