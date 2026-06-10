document.addEventListener("DOMContentLoaded", async () => {
  requireAuth();
  bindLogout();
  fillUserBadge();
  initSidebarProfile();
  await loadSidebar();
  startChatsAutoRefresh();
});
