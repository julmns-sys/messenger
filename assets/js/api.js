const API = {
  baseUrl: localStorage.getItem("messenger_api_base") || window.location.origin,
  tokenKey: "messenger_token",
  userKey: "messenger_user",
  emailBookKey: "messenger_user_emails"
};

function setApiBase(url) {
  API.baseUrl = url.replace(/\/+$/, "");
  localStorage.setItem("messenger_api_base", API.baseUrl);
}

function getToken() {
  return localStorage.getItem(API.tokenKey);
}

function readEmailBook() {
  const raw = localStorage.getItem(API.emailBookKey);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function rememberUserEmail(user) {
  const username = typeof user?.username === "string" ? user.username.trim() : "";
  const email = typeof user?.email === "string" ? user.email.trim() : "";
  if (!username || !email) {
    return;
  }

  const emailBook = readEmailBook();
  emailBook[username.toLowerCase()] = email;
  localStorage.setItem(API.emailBookKey, JSON.stringify(emailBook));
}

function resolveRememberedEmail(user) {
  if (!user || user.email) {
    return user;
  }

  const username = typeof user.username === "string" ? user.username.trim().toLowerCase() : "";
  if (!username) {
    return user;
  }

  const emailBook = readEmailBook();
  const rememberedEmail = emailBook[username];
  if (!rememberedEmail) {
    return user;
  }

  return {
    ...user,
    email: rememberedEmail
  };
}

function setSession(token, user) {
  localStorage.setItem(API.tokenKey, token);
  if (user) {
    const normalizedUser = resolveRememberedEmail(user);
    localStorage.setItem(API.userKey, JSON.stringify(normalizedUser));
    rememberUserEmail(normalizedUser);
  }
}

function setCurrentUser(user) {
  const token = getToken();
  if (!token || !user) {
    return;
  }
  setSession(token, user);
}

function clearSession() {
  localStorage.removeItem(API.tokenKey);
  localStorage.removeItem(API.userKey);
}

function getCurrentUser() {
  const raw = localStorage.getItem(API.userKey);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function requireAuth() {
  if (!getToken()) {
    window.location.href = "login.html";
  }
}

async function apiFetch(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("Accept", "application/json");

  if (!(options.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const token = getToken();
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const response = await fetch(`${API.baseUrl}${path}`, {
    ...options,
    headers
  });

  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json")
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    const message =
      (payload && payload.message) ||
      (payload && payload.detail) ||
      (typeof payload === "string" ? payload : "Request failed");
    throw new Error(message);
  }

  return payload;
}

function initials(name = "") {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || "")
    .join("") || "?";
}

function getUserTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Moscow";
  } catch {
    return "Europe/Moscow";
  }
}

function parseUtcDate(value) {
  if (!value) return null;

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  const normalized = String(value).trim();
  if (!normalized) return null;

  const isoCandidate = normalized.includes("T")
    ? normalized
    : normalized.replace(" ", "T");
  const utcCandidate = /(?:Z|[+\-]\d{2}:\d{2})$/.test(isoCandidate)
    ? isoCandidate
    : `${isoCandidate}Z`;

  const date = new Date(utcCandidate);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getLocalDateParts(value) {
  const date = parseUtcDate(value);
  if (!date) {
    return null;
  }

  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: getUserTimeZone(),
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );

  return {
    year: Number(parts.year || 0),
    month: Number(parts.month || 0),
    day: Number(parts.day || 0)
  };
}

function getLocalDateKey(value) {
  const parts = getLocalDateParts(value);
  if (!parts) {
    return "";
  }

  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function formatTime(value) {
  const date = parseUtcDate(value);
  if (!date) return "";
  return date.toLocaleTimeString("ru-RU", {
    timeZone: getUserTimeZone(),
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatDate(value) {
  const date = parseUtcDate(value);
  if (!date) return "";
  return date.toLocaleDateString([], {
    timeZone: getUserTimeZone(),
    day: "numeric",
    month: "short"
  });
}

function formatChatDateDivider(value) {
  const date = parseUtcDate(value);
  const parts = getLocalDateParts(value);
  if (!date || !parts) {
    return "";
  }

  const nowParts = getLocalDateParts(new Date());
  if (!nowParts) {
    return "";
  }

  const currentUtc = Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day);
  const targetUtc = Date.UTC(parts.year, parts.month - 1, parts.day);
  const dayDiff = Math.round((currentUtc - targetUtc) / 86400000);

  if (dayDiff === 0) {
    return "Сегодня";
  }

  if (dayDiff === 1) {
    return "Вчера";
  }

  const sameYear = parts.year === nowParts.year;
  return date.toLocaleDateString("ru-RU", {
    timeZone: getUserTimeZone(),
    day: "numeric",
    month: "long",
    ...(sameYear ? {} : { year: "numeric" })
  });
}

function escapeHtml(value = "") {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
