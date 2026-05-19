const stickersState = {
  library: null
};

function renderStickerThumb(sticker = {}, options = {}) {
  const removable = Boolean(options.removable);
  return `
    <div class="stickers-thumb">
      <img class="stickers-thumb-image" src="${escapeHtml(String(sticker.url || ""))}" alt="${escapeHtml(sticker.title || "Стикер")}" loading="lazy">
      ${removable ? `
        <button class="stickers-thumb-remove" type="button" data-sticker-delete="${escapeHtml(String(sticker.id || ""))}" data-pack-id="${escapeHtml(String(sticker.pack_id || ""))}" aria-label="Удалить стикер">
          ×
        </button>
      ` : ""}
    </div>
  `;
}

function renderPackCard(pack = {}, options = {}) {
  const editable = Boolean(options.editable);
  const subscribed = Boolean(pack.is_added);
  const cover = pack.cover_path || pack.stickers?.[0]?.url || "";
  const stickers = Array.isArray(pack.stickers) ? pack.stickers : [];

  return `
    <article class="stickers-pack-card" data-pack-card="${escapeHtml(String(pack.id || ""))}">
      <div class="stickers-pack-topline">
        <div class="stickers-pack-cover">
          ${cover ? `<img class="stickers-pack-cover-image" src="${escapeHtml(cover)}" alt="${escapeHtml(pack.title || "Pack")}" loading="lazy">` : `<span>${escapeHtml(initials(pack.title || "SP"))}</span>`}
        </div>
        <div class="stickers-pack-copy">
          <h3>${escapeHtml(pack.title || "Без названия")}</h3>
          <p>${escapeHtml(pack.description || (pack.is_default ? "Дефолтный набор" : (pack.visibility === "public" ? "Public pack" : "Private pack")))}</p>
        </div>
        <div class="stickers-pack-chip-row">
          ${pack.is_default ? '<span class="stickers-pack-chip">Default</span>' : ""}
          ${pack.is_owned ? '<span class="stickers-pack-chip">Мой</span>' : ""}
          ${pack.visibility === "public" && !pack.is_default ? '<span class="stickers-pack-chip">Public</span>' : ""}
        </div>
      </div>

      ${editable ? `
        <form class="stickers-pack-meta-form" data-pack-update-form="${escapeHtml(String(pack.id || ""))}">
          <input class="input" type="text" name="title" maxlength="120" value="${escapeHtml(pack.title || "")}" required>
          <input class="input" type="text" name="description" maxlength="255" value="${escapeHtml(pack.description || "")}" placeholder="Описание">
          <select class="settings-select" name="visibility">
            <option value="private"${pack.visibility === "public" ? "" : " selected"}>Private</option>
            <option value="public"${pack.visibility === "public" ? " selected" : ""}>Public</option>
          </select>
          <div class="stickers-pack-actions">
            <button class="button button-secondary" type="submit">Сохранить</button>
            <button class="button button-danger" type="button" data-pack-delete="${escapeHtml(String(pack.id || ""))}">Удалить pack</button>
          </div>
        </form>
        <form class="stickers-pack-upload-form" data-pack-upload-form="${escapeHtml(String(pack.id || ""))}">
          <input class="input" type="text" name="title" maxlength="120" placeholder="Название стикера (опционально)">
          <input class="input" type="file" name="sticker" accept="image/png,image/webp" required>
          <button class="button" type="submit">Загрузить стикер</button>
        </form>
      ` : `
        <div class="stickers-pack-actions">
          ${pack.is_default ? '<button class="button button-secondary" type="button" disabled>Всегда доступен</button>' : `
            <button class="button ${subscribed ? "button-secondary" : ""}" type="button" data-pack-subscribe="${escapeHtml(String(pack.id || ""))}" data-pack-subscribed="${subscribed ? "true" : "false"}">
              ${subscribed ? "Убрать из моих" : "Добавить себе"}
            </button>
          `}
        </div>
      `}

      <div class="stickers-thumb-grid">
        ${stickers.length ? stickers.map((sticker) => renderStickerThumb(sticker, { removable: editable })).join("") : '<div class="empty-state">Стикеров пока нет</div>'}
      </div>
    </article>
  `;
}

function setStatus(targetId, message = "", type = "") {
  const node = document.getElementById(targetId);
  if (!node) return;
  node.textContent = message;
  node.className = `status ${type}`.trim();
}

function renderStickerPacks() {
  const myList = document.getElementById("myStickerPacksList");
  const libraryList = document.getElementById("stickerLibraryList");
  const library = stickersState.library || {};
  const myPacks = Array.isArray(library.my_packs) ? library.my_packs : [];
  const defaultPacks = Array.isArray(library.default_packs) ? library.default_packs : [];
  const addedPacks = Array.isArray(library.added_packs) ? library.added_packs : [];
  const publicPacks = Array.isArray(library.public_packs) ? library.public_packs : [];

  if (myList) {
    myList.innerHTML = myPacks.length
      ? myPacks.map((pack) => renderPackCard(pack, { editable: true })).join("")
      : '<div class="empty-state">У вас пока нет своих sticker packs</div>';
  }

  if (libraryList) {
    const combined = [...defaultPacks, ...addedPacks, ...publicPacks];
    libraryList.innerHTML = combined.length
      ? combined.map((pack) => renderPackCard(pack, { editable: false })).join("")
      : '<div class="empty-state">Публичных паков пока нет</div>';
  }
}

async function loadStickerLibrary() {
  try {
    const library = await apiFetch("/sticker-library");
    stickersState.library = library;
    renderStickerPacks();
    setStatus("myStickerPacksStatus", "");
    setStatus("stickerLibraryStatus", "");
  } catch (error) {
    setStatus("myStickerPacksStatus", error.message, "error");
    setStatus("stickerLibraryStatus", error.message, "error");
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  applyAppSettings();
  requireAuth();
  bindLogout();
  fillUserBadge();
  initSidebarProfile();
  await loadChats();
  startChatsAutoRefresh();

  const createForm = document.getElementById("stickerPackCreateForm");
  const myList = document.getElementById("myStickerPacksList");
  const libraryList = document.getElementById("stickerLibraryList");

  await loadStickerLibrary();

  createForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const title = document.getElementById("stickerPackTitle")?.value.trim() || "";
    const description = document.getElementById("stickerPackDescription")?.value.trim() || "";
    const visibility = document.getElementById("stickerPackVisibility")?.value || "private";
    setStatus("stickerPackCreateStatus", "Создаём pack...", "loading");
    try {
      await apiFetch("/sticker-packs", {
        method: "POST",
        body: JSON.stringify({ title, description, visibility })
      });
      createForm.reset();
      setStatus("stickerPackCreateStatus", "Pack создан", "success");
      await loadStickerLibrary();
    } catch (error) {
      setStatus("stickerPackCreateStatus", error.message, "error");
    }
  });

  myList?.addEventListener("submit", async (event) => {
    const metaForm = event.target.closest("[data-pack-update-form]");
    const uploadForm = event.target.closest("[data-pack-upload-form]");
    if (!metaForm && !uploadForm) {
      return;
    }
    event.preventDefault();

    if (metaForm) {
      const packId = metaForm.dataset.packUpdateForm;
      const formData = new FormData(metaForm);
      try {
        await apiFetch(`/sticker-packs/${encodeURIComponent(packId)}`, {
          method: "PATCH",
          body: JSON.stringify({
            title: String(formData.get("title") || "").trim(),
            description: String(formData.get("description") || "").trim(),
            visibility: String(formData.get("visibility") || "private")
          })
        });
        await loadStickerLibrary();
      } catch (error) {
        setStatus("myStickerPacksStatus", error.message, "error");
      }
      return;
    }

    if (uploadForm) {
      const packId = uploadForm.dataset.packUploadForm;
      const payload = new FormData(uploadForm);
      try {
        await apiFetch(`/sticker-packs/${encodeURIComponent(packId)}/stickers`, {
          method: "POST",
          body: payload
        });
        uploadForm.reset();
        await loadStickerLibrary();
      } catch (error) {
        setStatus("myStickerPacksStatus", error.message, "error");
      }
    }
  });

  myList?.addEventListener("click", async (event) => {
    const deletePackButton = event.target.closest("[data-pack-delete]");
    if (deletePackButton) {
      const packId = deletePackButton.dataset.packDelete;
      try {
        await apiFetch(`/sticker-packs/${encodeURIComponent(packId)}`, { method: "DELETE" });
        await loadStickerLibrary();
      } catch (error) {
        setStatus("myStickerPacksStatus", error.message, "error");
      }
      return;
    }

    const deleteStickerButton = event.target.closest("[data-sticker-delete]");
    if (deleteStickerButton) {
      const packId = deleteStickerButton.dataset.packId;
      const stickerId = deleteStickerButton.dataset.stickerDelete;
      try {
        await apiFetch(`/sticker-packs/${encodeURIComponent(packId)}/stickers/${encodeURIComponent(stickerId)}`, { method: "DELETE" });
        await loadStickerLibrary();
      } catch (error) {
        setStatus("myStickerPacksStatus", error.message, "error");
      }
    }
  });

  libraryList?.addEventListener("click", async (event) => {
    const subscribeButton = event.target.closest("[data-pack-subscribe]");
    if (!subscribeButton) {
      return;
    }
    const packId = subscribeButton.dataset.packSubscribe;
    const subscribed = subscribeButton.dataset.packSubscribed === "true";
    try {
      await apiFetch(`/sticker-packs/${encodeURIComponent(packId)}/subscribe`, {
        method: subscribed ? "DELETE" : "POST"
      });
      await loadStickerLibrary();
    } catch (error) {
      setStatus("stickerLibraryStatus", error.message, "error");
    }
  });
});
