function setStatus(message, type = "") {
  const status = document.getElementById("status");
  if (!status) return;
  status.className = `status ${type}`.trim();
  status.textContent = message;
}

function setNodeStatus(node, message, type = "") {
  if (!node) return;
  node.className = `status ${type}`.trim();
  node.textContent = message;
}

function setupVerifyCodeInputs(form) {
  const hiddenCodeInput = form.querySelector('input[name="code"]');
  const codeCells = [...form.querySelectorAll(".verify-code-cell")];
  if (!hiddenCodeInput || codeCells.length !== 6) return;

  const syncCodeValue = () => {
    hiddenCodeInput.value = codeCells.map((cell) => cell.value.trim()).join("");
  };

  const focusCell = (index) => {
    const target = codeCells[index];
    if (!target) return;
    target.focus();
    target.select();
  };

  const applyCode = (rawValue) => {
    const digits = String(rawValue || "").replace(/\D/g, "").slice(0, codeCells.length).split("");
    codeCells.forEach((cell, index) => {
      cell.value = digits[index] || "";
    });
    syncCodeValue();
    const nextEmptyIndex = codeCells.findIndex((cell) => !cell.value);
    focusCell(nextEmptyIndex === -1 ? codeCells.length - 1 : nextEmptyIndex);
  };

  codeCells.forEach((cell, index) => {
    cell.addEventListener("input", () => {
      const digits = cell.value.replace(/\D/g, "");
      if (digits.length > 1) {
        applyCode(digits);
        return;
      }

      cell.value = digits;
      syncCodeValue();
      if (digits && index < codeCells.length - 1) {
        focusCell(index + 1);
      }
    });

    cell.addEventListener("keydown", (event) => {
      if (event.key === "Backspace" && !cell.value && index > 0) {
        event.preventDefault();
        codeCells[index - 1].value = "";
        syncCodeValue();
        focusCell(index - 1);
        return;
      }

      if (event.key === "ArrowLeft" && index > 0) {
        event.preventDefault();
        focusCell(index - 1);
        return;
      }

      if (event.key === "ArrowRight" && index < codeCells.length - 1) {
        event.preventDefault();
        focusCell(index + 1);
      }
    });

    cell.addEventListener("paste", (event) => {
      event.preventDefault();
      applyCode(event.clipboardData?.getData("text") || "");
    });

    cell.addEventListener("focus", () => {
      cell.select();
    });
  });

  form.addEventListener("submit", () => {
    syncCodeValue();
  });
}

document.addEventListener("DOMContentLoaded", () => {
  const form = document.querySelector("form[data-auth]");
  const passwordResetForm = document.querySelector("form[data-password-reset-form='true']");
  const passwordResetRequestButton = document.querySelector("[data-password-reset-request='true']");
  const passwordResetStatus = document.getElementById("passwordResetStatus");
  if (passwordResetForm) {
    setupVerifyCodeInputs(passwordResetForm);
  }
  if (!form) return;

  const mode = form.dataset.auth;
  const params = new URLSearchParams(window.location.search);
  const nextPath = normalizeRedirectPath(params.get("next")) || getPostAuthRedirect();
  const emailInput = form.querySelector('input[name="email"]');
  const resendButton = document.querySelector("[data-resend-email-code]");
  const endpointByMode = {
    register: "/auth/register",
    login: "/auth/login",
    "verify-email": "/auth/verify-email"
  };
  const endpoint = endpointByMode[mode];

  if (!endpoint) return;

  if (mode === "verify-email" && emailInput) {
    emailInput.value = params.get("email") || emailInput.value || "";
    setupVerifyCodeInputs(form);
  }

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

      if (data.need_email_verification) {
        setStatus(data.message || "Подтвердите email", "success");
        window.setTimeout(() => {
          window.location.href = getVerifyEmailRoute(data.email || payload.email || "");
        }, 300);
        return;
      }

      if (data.token) {
        setSession(data.token, {
          ...payload,
          ...(data.user || {})
        });
      }

      const successMessage = mode === "verify-email"
        ? "Email подтверждён"
        : mode === "register"
          ? "Аккаунт создан"
          : "Вход выполнен";
      setStatus(successMessage, "success");
      window.setTimeout(() => {
        const redirectPath = nextPath || consumePostAuthRedirect() || getChatsRoute();
        if (nextPath) {
          consumePostAuthRedirect();
        }
        window.location.href = redirectPath;
      }, 300);
    } catch (error) {
      if (error?.payload?.need_email_verification) {
        window.location.href = getVerifyEmailRoute(error.payload.email || payload.email || "");
        return;
      }
      setStatus(error.message, "error");
    }
  });

  resendButton?.addEventListener("click", async () => {
    const email = emailInput?.value?.trim() || params.get("email") || "";
    if (!email) {
      setStatus("Введите email", "error");
      return;
    }

    setStatus("Отправка кода...");
    resendButton.disabled = true;

    try {
      const data = await apiFetch("/auth/resend-email-code", {
        method: "POST",
        body: JSON.stringify({ email })
      });
      setStatus(data.message || "Код отправлен", "success");
      if (emailInput && !emailInput.value.trim()) {
        emailInput.value = email;
      }
    } catch (error) {
      setStatus(error.message, "error");
    } finally {
      window.setTimeout(() => {
        resendButton.disabled = false;
      }, 1000);
    }
  });

  passwordResetRequestButton?.addEventListener("click", async () => {
    if (!passwordResetForm) return;
    const email = passwordResetForm.querySelector('input[name="email"]')?.value?.trim() || "";
    if (!email) {
      setNodeStatus(passwordResetStatus, "Введите email", "error");
      return;
    }

    passwordResetRequestButton.disabled = true;
    setNodeStatus(passwordResetStatus, "Отправка кода...");

    try {
      const data = await apiFetch("/auth/forgot-password/request", {
        method: "POST",
        body: JSON.stringify({ email })
      });
      setNodeStatus(passwordResetStatus, data.message || "Код отправлен", "success");
    } catch (error) {
      setNodeStatus(passwordResetStatus, error.message, "error");
    } finally {
      window.setTimeout(() => {
        passwordResetRequestButton.disabled = false;
      }, 1000);
    }
  });

  passwordResetForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = passwordResetForm.querySelector('button[type="submit"]');
    const formData = new FormData(passwordResetForm);
    const payload = Object.fromEntries(formData.entries());

    submitButton.disabled = true;
    setNodeStatus(passwordResetStatus, "Сохраняем новый пароль...");

    try {
      const data = await apiFetch("/auth/forgot-password/confirm", {
        method: "POST",
        body: JSON.stringify(payload)
      });
      passwordResetForm.reset();
      passwordResetForm.querySelector('input[name="code"]').value = "";
      passwordResetForm.querySelectorAll(".verify-code-cell").forEach((cell) => {
        cell.value = "";
      });
      setNodeStatus(passwordResetStatus, data.message || "Пароль изменён", "success");
    } catch (error) {
      setNodeStatus(passwordResetStatus, error.message, "error");
    } finally {
      submitButton.disabled = false;
    }
  });
});
