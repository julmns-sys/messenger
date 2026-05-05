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

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    setStatus("Отправка...");

    const formData = new FormData(form);
    const payload = Object.fromEntries(formData.entries());

    try {
      const data = await apiFetch(endpoint, {
        method: "POST",
        body: JSON.stringify(payload)
      });

      if (data.base_url) {
        setApiBase(data.base_url);
      }

      if (data.token) {
        setSession(data.token, data.user || payload);
      }

      setStatus(mode === "register" ? "Аккаунт создан" : "Вход выполнен", "success");
      window.setTimeout(() => {
        window.location.href = "index.html";
      }, 300);
    } catch (error) {
      setStatus(error.message, "error");
    }
  });
});
