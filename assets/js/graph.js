const graphState = {
  currentUser: null,
  chats: [],
  contacts: [],
  userDetails: new Map(),
  groupDetails: new Map(),
  nodes: [],
  edges: [],
  selectedNodeId: null,
  viewport: {
    x: 0,
    y: 0,
    scale: 1
  },
  dragging: null,
  selectionRequestId: 0
};

const graphRefs = {
  stage: null,
  svg: null,
  viewport: null,
  infoPanel: null,
  emptyState: null,
  stageStats: null,
  mobileList: null,
  zoomButtons: []
};

function escapeGraphHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function graphInitials(value) {
  const parts = String(value || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (!parts.length) {
    return "?";
  }

  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase();
  }

  return `${parts[0][0] || ""}${parts[1][0] || ""}`.toUpperCase();
}

function clampGraphValue(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function truncateGraphLabel(value, maxLength = 18) {
  const text = String(value || "").trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

function graphTypeLabel(node) {
  if (!node) {
    return "";
  }
  if (node.entityType === "self") {
    return "Вы";
  }
  return node.entityType === "group" ? "Группа" : "Пользователь";
}

function getGraphNodeRoute(node) {
  if (!node) {
    return "";
  }
  if (node.entityType === "group") {
    return getGroupChatRoute(node.entityId);
  }
  if (node.entityType === "self") {
    return getProfileRoute();
  }
  if (node.chatId) {
    return getDirectChatRoute(node.chatId);
  }
  if (node.userId) {
    return getDirectChatDraftRoute(node.userId);
  }
  return "";
}

function syncGraphRefs() {
  graphRefs.stage = document.getElementById("graphStage");
  graphRefs.svg = document.getElementById("graphSvg");
  graphRefs.viewport = document.getElementById("graphViewport");
  graphRefs.infoPanel = document.getElementById("graphInfoPanel");
  graphRefs.emptyState = document.getElementById("graphEmptyState");
  graphRefs.stageStats = document.getElementById("graphStageStats");
  graphRefs.mobileList = document.getElementById("graphMobileList");
  graphRefs.zoomButtons = [...document.querySelectorAll("[data-graph-zoom]")];
}

async function fetchGraphData() {
  const [currentUser, chats, contacts] = await Promise.all([
    apiFetch("/users/me"),
    apiFetch("/chats"),
    apiFetch("/contacts").catch(() => [])
  ]);

  graphState.currentUser = currentUser;
  graphState.chats = Array.isArray(chats) ? chats : [];
  graphState.contacts = Array.isArray(contacts) ? contacts : [];

  const groupChats = graphState.chats.filter((chat) => chat.type === "group");
  const groupPayloads = await Promise.all(groupChats.map(async (group) => {
    try {
      const details = await apiFetch(`/groups/${group.id}`);
      return [String(group.id), details];
    } catch {
      return null;
    }
  }));

  graphState.groupDetails = new Map(groupPayloads.filter(Boolean));
}

function buildGraphModel() {
  const currentUser = graphState.currentUser;
  if (!currentUser) {
    graphState.nodes = [];
    graphState.edges = [];
    return;
  }

  const nodes = [];
  const edges = [];
  const primaryUsersById = new Map();
  const contactsById = new Map(graphState.contacts.map((contact) => [String(contact.id), contact]));
  const currentUserId = String(currentUser.id);
  const selfNodeId = `self:${currentUserId}`;
  const readUserDetails = (userId) => graphState.userDetails.get(String(userId)) || null;

  nodes.push({
    id: selfNodeId,
    entityType: "self",
    entityId: currentUser.id,
    userId: currentUser.id,
    title: currentUser.name || currentUser.username || "Вы",
    username: currentUser.username,
    bio: currentUser.bio,
    initials: graphInitials(currentUser.name || currentUser.username || "You"),
    ring: "center"
  });

  graphState.chats
    .filter((chat) => chat.type === "direct")
    .forEach((chat) => {
      const userKey = String(chat.user_id);
      const contact = contactsById.get(userKey);
      const userDetails = readUserDetails(chat.user_id);
      const title = userDetails?.contact_alias || contact?.contact_alias || chat.title || chat.name || chat.username || "Чат";
      const existing = primaryUsersById.get(userKey);
      const nextNode = {
        id: `user:${userKey}`,
        entityType: "user",
        entityId: chat.user_id,
        userId: chat.user_id,
        chatId: chat.id,
        username: userDetails?.username || chat.username,
        title,
        secondaryTitle: userDetails?.name || chat.name || contact?.name || title,
        bio: userDetails?.bio || contact?.bio || null,
        isContact: Boolean(userDetails?.is_contact || contact || chat.contact_alias),
        initials: graphInitials(title),
        ring: "primary-user"
      };

      if (existing) {
        Object.assign(existing, nextNode, {
          bio: existing.bio || nextNode.bio
        });
        return;
      }

      primaryUsersById.set(userKey, nextNode);
      nodes.push(nextNode);
      edges.push({
        id: `edge:${selfNodeId}:${nextNode.id}`,
        from: selfNodeId,
        to: nextNode.id,
        kind: "direct"
      });
    });

  graphState.contacts.forEach((contact) => {
    const userKey = String(contact.id);
    if (userKey === currentUserId) {
      return;
    }

    if (primaryUsersById.has(userKey)) {
      const existing = primaryUsersById.get(userKey);
      existing.bio = existing.bio || contact.bio || null;
      existing.isContact = true;
      existing.secondaryTitle = existing.secondaryTitle || contact.name || null;
      return;
    }

    const node = {
      id: `user:${userKey}`,
      entityType: "user",
      entityId: contact.id,
      userId: contact.id,
      chatId: contact.chat_id || null,
      username: readUserDetails(contact.id)?.username || contact.username,
      title: readUserDetails(contact.id)?.contact_alias || contact.contact_alias || contact.name || contact.username || "Контакт",
      secondaryTitle: readUserDetails(contact.id)?.name || contact.name || null,
      bio: readUserDetails(contact.id)?.bio || contact.bio || null,
      isContact: Boolean(readUserDetails(contact.id)?.is_contact ?? true),
      initials: graphInitials(readUserDetails(contact.id)?.contact_alias || contact.contact_alias || contact.name || contact.username || "C"),
      ring: "primary-user"
    };
    primaryUsersById.set(userKey, node);
    nodes.push(node);
    edges.push({
      id: `edge:${selfNodeId}:${node.id}`,
      from: selfNodeId,
      to: node.id,
      kind: "contact"
    });
  });

  const groupNodes = graphState.chats.filter((chat) => chat.type === "group").map((group) => {
    const details = graphState.groupDetails.get(String(group.id));
    const node = {
      id: `group:${group.id}`,
      entityType: "group",
      entityId: group.id,
      title: group.title || "Группа",
      username: null,
      description: details?.description || "",
      membersCount: details?.members_count || 0,
      messagesCount: details?.messages_count || 0,
      initials: graphInitials(group.title || "G"),
      ring: "group"
    };

    nodes.push(node);
    edges.push({
      id: `edge:${selfNodeId}:${node.id}`,
      from: selfNodeId,
      to: node.id,
      kind: "group"
    });
    return node;
  });

  groupNodes.forEach((groupNode) => {
    const details = graphState.groupDetails.get(String(groupNode.entityId));
    const members = Array.isArray(details?.members) ? details.members : [];

    members.forEach((member) => {
      if (String(member.id) === currentUserId) {
        return;
      }

      const primaryUserNode = primaryUsersById.get(String(member.id));
      if (primaryUserNode) {
        edges.push({
          id: `edge:${groupNode.id}:${primaryUserNode.id}`,
          from: groupNode.id,
          to: primaryUserNode.id,
          kind: "member-link"
        });
        return;
      }

      const nodeId = `group-member:${groupNode.entityId}:${member.id}`;
      const userDetails = readUserDetails(member.id);
      nodes.push({
        id: nodeId,
        entityType: "user",
        entityId: member.id,
        userId: member.id,
        title: userDetails?.contact_alias || userDetails?.name || member.name || member.username || "Участник",
        username: userDetails?.username || member.username,
        bio: userDetails?.bio || member.bio || null,
        isContact: Boolean(userDetails?.is_contact),
        groupMemberOnly: true,
        originGroupId: groupNode.entityId,
        initials: graphInitials(userDetails?.contact_alias || userDetails?.name || member.name || member.username || "U"),
        ring: "group-member"
      });
      edges.push({
        id: `edge:${groupNode.id}:${nodeId}`,
        from: groupNode.id,
        to: nodeId,
        kind: "member"
      });
    });
  });

  graphState.nodes = nodes;
  graphState.edges = edges;

  if (!graphState.selectedNodeId || !nodes.some((node) => node.id === graphState.selectedNodeId)) {
    graphState.selectedNodeId = selfNodeId;
  }
}

function layoutGraphNodes() {
  const width = graphRefs.stage?.clientWidth || 960;
  const height = graphRefs.stage?.clientHeight || 640;
  const primaryUsers = graphState.nodes.filter((node) => node.ring === "primary-user");
  const groups = graphState.nodes.filter((node) => node.ring === "group");
  const groupMembers = graphState.nodes.filter((node) => node.ring === "group-member");
  const centerNode = graphState.nodes.find((node) => node.ring === "center");

  if (centerNode) {
    centerNode.x = 0;
    centerNode.y = 0;
    centerNode.radius = 42;
  }

  const minStageSide = Math.max(520, Math.min(width, height));
  const userRadius = Math.max(190, Math.min(260, minStageSide * 0.26));
  const groupRadius = Math.max(300, Math.min(420, minStageSide * 0.4 + Math.max(0, primaryUsers.length - 4) * 6));

  primaryUsers.forEach((node, index) => {
    const angle = (-Math.PI / 2) + ((Math.PI * 2) / Math.max(1, primaryUsers.length)) * index;
    node.x = Math.cos(angle) * userRadius;
    node.y = Math.sin(angle) * userRadius;
    node.radius = 30;
  });

  groups.forEach((node, index) => {
    const angle = (-Math.PI / 2) + (Math.PI / Math.max(3, groups.length)) * 0.35 + ((Math.PI * 2) / Math.max(1, groups.length)) * index;
    node.x = Math.cos(angle) * groupRadius;
    node.y = Math.sin(angle) * groupRadius;
    node.radius = 34;
  });

  const membersByGroup = new Map();
  groupMembers.forEach((node) => {
    const key = String(node.originGroupId);
    if (!membersByGroup.has(key)) {
      membersByGroup.set(key, []);
    }
    membersByGroup.get(key).push(node);
  });

  membersByGroup.forEach((members, groupId) => {
    const groupNode = groups.find((candidate) => String(candidate.entityId) === String(groupId));
    if (!groupNode) {
      return;
    }

    const baseAngle = Math.atan2(groupNode.y, groupNode.x);
    const spread = Math.min(Math.PI * 1.4, Math.max(Math.PI * 0.8, members.length * 0.36));
    const start = baseAngle - spread / 2;
    const radius = 116;
    const step = members.length > 1 ? spread / (members.length - 1) : 0;

    members.forEach((node, index) => {
      const angle = start + step * index;
      node.x = groupNode.x + Math.cos(angle) * radius;
      node.y = groupNode.y + Math.sin(angle) * radius;
      node.radius = 22;
    });
  });
}

function getNodeById(nodeId) {
  return graphState.nodes.find((node) => node.id === nodeId) || null;
}

function renderGraphStats() {
  if (!graphRefs.stageStats) {
    return;
  }

  const visibleNodes = graphState.nodes.filter((node) => node.ring !== "center");
  graphRefs.stageStats.textContent = `${visibleNodes.length} узлов • ${graphState.edges.length} связей`;
}

function renderGraphEdge(edge) {
  const fromNode = getNodeById(edge.from);
  const toNode = getNodeById(edge.to);
  if (!fromNode || !toNode) {
    return "";
  }

  const isConnected = graphState.selectedNodeId && (edge.from === graphState.selectedNodeId || edge.to === graphState.selectedNodeId);
  return `
    <line
      class="graph-edge ${isConnected ? "is-connected" : ""} graph-edge-${escapeGraphHtml(edge.kind)}"
      x1="${fromNode.x}"
      y1="${fromNode.y}"
      x2="${toNode.x}"
      y2="${toNode.y}"
    ></line>
  `;
}

function renderGraphNode(node) {
  const isSelected = node.id === graphState.selectedNodeId;
  const label = truncateGraphLabel(node.title, node.ring === "group-member" ? 14 : 18);
  const radius = node.radius || 28;
  const haloRadius = radius + (node.ring === "center" ? 14 : 12);
  const badgeMarkup = node.entityType === "group"
    ? `
      <circle class="graph-node-badge-bg" cx="${radius - 4}" cy="${radius - 4}" r="11"></circle>
      <text class="graph-node-badge" x="${radius - 4}" y="${radius}">#</text>
    `
    : "";

  return `
    <g
      class="graph-node graph-node-${escapeGraphHtml(node.entityType)} graph-node-${escapeGraphHtml(node.ring)} ${isSelected ? "is-selected" : ""}"
      transform="translate(${node.x} ${node.y})"
      data-node-id="${escapeGraphHtml(node.id)}"
      tabindex="0"
      role="button"
      aria-label="${escapeGraphHtml(node.title)}"
    >
      <circle class="graph-node-halo" r="${haloRadius}"></circle>
      <circle class="graph-node-surface" r="${radius}"></circle>
      <text class="graph-node-initials" y="5">${escapeGraphHtml(node.initials)}</text>
      ${badgeMarkup}
      <text class="graph-node-label" y="${radius + 24}">${escapeGraphHtml(label)}</text>
      ${node.ring === "group-member" ? "" : `<text class="graph-node-meta" y="${radius + 40}">${escapeGraphHtml(graphTypeLabel(node))}</text>`}
    </g>
  `;
}

function applyGraphViewportTransform() {
  if (!graphRefs.viewport || !graphRefs.stage) {
    return;
  }

  const width = graphRefs.stage.clientWidth || 960;
  const height = graphRefs.stage.clientHeight || 640;
  graphRefs.svg?.setAttribute("viewBox", `0 0 ${width} ${height}`);
  graphRefs.viewport.setAttribute(
    "transform",
    `translate(${(width / 2) + graphState.viewport.x} ${(height / 2) + graphState.viewport.y}) scale(${graphState.viewport.scale})`
  );

  graphRefs.zoomButtons.forEach((button) => {
    if (button.dataset.graphZoom === "reset") {
      button.textContent = `${Math.round(graphState.viewport.scale * 100)}%`;
    }
  });
}

function renderGraphScene() {
  if (!graphRefs.viewport || !graphRefs.emptyState || !graphRefs.mobileList) {
    return;
  }

  if (!graphState.nodes.length) {
    graphRefs.viewport.innerHTML = "";
    graphRefs.emptyState.hidden = false;
    graphRefs.mobileList.hidden = false;
    graphRefs.mobileList.innerHTML = "";
    renderGraphStats();
    return;
  }

  graphRefs.emptyState.hidden = true;
  layoutGraphNodes();
  graphRefs.viewport.innerHTML = `
    ${graphState.edges.map(renderGraphEdge).join("")}
    ${graphState.nodes.map(renderGraphNode).join("")}
  `;
  applyGraphViewportTransform();
  bindGraphNodeInteractions();
  renderGraphMobileList();
  renderGraphStats();
}

function renderGraphMobileList() {
  if (!graphRefs.mobileList) {
    return;
  }

  const listNodes = graphState.nodes.filter((node) => node.ring !== "center");
  graphRefs.mobileList.hidden = !listNodes.length;
  graphRefs.mobileList.innerHTML = listNodes.map((node) => `
    <button
      type="button"
      class="graph-mobile-item ${node.id === graphState.selectedNodeId ? "is-active" : ""}"
      data-node-id="${escapeGraphHtml(node.id)}"
    >
      <span class="graph-mobile-item-avatar ${escapeGraphHtml(node.entityType === "group" ? "is-group" : "")}">${escapeGraphHtml(node.initials)}</span>
      <span class="graph-mobile-item-copy">
        <strong>${escapeGraphHtml(node.title)}</strong>
        <span>${escapeGraphHtml(graphTypeLabel(node))}</span>
      </span>
    </button>
  `).join("");

  graphRefs.mobileList.querySelectorAll("[data-node-id]").forEach((button) => {
    button.addEventListener("click", () => {
      void selectGraphNode(button.dataset.nodeId || "");
    });
  });
}

function bindGraphNodeInteractions() {
  graphRefs.viewport?.querySelectorAll("[data-node-id]").forEach((nodeElement) => {
    const select = () => {
      const nodeId = nodeElement.getAttribute("data-node-id") || "";
      void selectGraphNode(nodeId);
    };

    nodeElement.addEventListener("click", select);
    nodeElement.addEventListener("dblclick", (event) => {
      event.preventDefault();
      const nodeId = nodeElement.getAttribute("data-node-id") || "";
      const node = getNodeById(nodeId);
      const route = getGraphNodeRoute(node);
      if (route) {
        window.location.href = route;
      }
    });
    nodeElement.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        select();
      }
    });
  });
}

function renderGraphInfoPanel() {
  if (!graphRefs.infoPanel) {
    return;
  }

  const node = getNodeById(graphState.selectedNodeId);
  if (!node) {
    graphRefs.infoPanel.innerHTML = `
      <div class="graph-info-empty">
        <p class="graph-info-eyebrow">Узел графа</p>
        <h2>Ничего не выбрано</h2>
        <p>Нажмите на контакт или группу на карте.</p>
      </div>
    `;
    return;
  }

  const route = getGraphNodeRoute(node);
  const usernameMarkup = node.username
    ? `<p class="graph-info-username">@${escapeGraphHtml(node.username)}</p>`
    : "";
  const description = node.entityType === "group"
    ? (node.description || "Групповой чат в вашем графе общения.")
    : (node.bio || (node.entityType === "self" ? "Ваш центральный узел на карте общения." : "Пользователь в вашем графе общения."));
  const facts = [];

  facts.push({ label: "Тип", value: graphTypeLabel(node) });
  if (node.entityType === "group" && node.membersCount) {
    facts.push({ label: "Участники", value: String(node.membersCount) });
  }
  if (node.entityType === "group" && node.messagesCount) {
    facts.push({ label: "Сообщения", value: String(node.messagesCount) });
  }
  if (node.entityType === "user" && node.isContact) {
    facts.push({ label: "Статус", value: "Контакт" });
  }
  if (node.groupMemberOnly) {
    const originGroup = getNodeById(`group:${node.originGroupId}`);
    if (originGroup) {
      facts.push({ label: "Через группу", value: originGroup.title });
    }
  }

  graphRefs.infoPanel.innerHTML = `
    <div class="graph-info-card">
      <p class="graph-info-eyebrow">${escapeGraphHtml(node.entityType === "group" ? "Информация о группе" : "Информация о пользователе")}</p>
      <div class="graph-info-avatar ${escapeGraphHtml(node.entityType === "group" ? "is-group" : "")}">${escapeGraphHtml(node.initials)}</div>
      <h2 class="graph-info-title">${escapeGraphHtml(node.title)}</h2>
      ${usernameMarkup}
      <div class="graph-info-type-chip">${escapeGraphHtml(graphTypeLabel(node))}</div>
      <p class="graph-info-description">${escapeGraphHtml(description)}</p>
      <div class="graph-info-facts">
        ${facts.map((fact) => `
          <div class="graph-info-fact">
            <span>${escapeGraphHtml(fact.label)}</span>
            <strong>${escapeGraphHtml(fact.value)}</strong>
          </div>
        `).join("")}
      </div>
      <div class="graph-info-actions">
        ${route ? `<button class="button" type="button" data-graph-open-node="true">${escapeGraphHtml(node.entityType === "self" ? "Открыть профиль" : "Открыть чат")}</button>` : ""}
      </div>
    </div>
  `;

  const openButton = graphRefs.infoPanel.querySelector("[data-graph-open-node='true']");
  if (openButton && route) {
    openButton.addEventListener("click", () => {
      window.location.href = route;
    });
  }
}

async function enrichGraphSelection(node) {
  if (!node) {
    return;
  }

  const requestId = ++graphState.selectionRequestId;

  if (node.entityType === "group") {
    try {
      const details = graphState.groupDetails.get(String(node.entityId)) || await apiFetch(`/groups/${node.entityId}`);
      graphState.groupDetails.set(String(node.entityId), details);
      buildGraphModel();
      if (requestId === graphState.selectionRequestId) {
        renderGraphScene();
        renderGraphInfoPanel();
      }
    } catch {
      return;
    }
    return;
  }

  if (!node.userId || node.entityType === "self") {
    return;
  }

  try {
    const details = await apiFetch(`/users/${node.userId}`);
    graphState.userDetails.set(String(node.userId), details);
    buildGraphModel();
    if (requestId === graphState.selectionRequestId) {
      renderGraphScene();
      renderGraphInfoPanel();
    }
  } catch {
    return;
  }
}

async function selectGraphNode(nodeId) {
  if (!nodeId || !getNodeById(nodeId)) {
    return;
  }

  graphState.selectedNodeId = nodeId;
  renderGraphScene();
  renderGraphInfoPanel();
  await enrichGraphSelection(getNodeById(nodeId));
}

function resetGraphViewport() {
  graphState.viewport.x = 0;
  graphState.viewport.y = 0;
  graphState.viewport.scale = 1;
  applyGraphViewportTransform();
}

function bindGraphViewport() {
  if (!graphRefs.svg || !graphRefs.stage) {
    return;
  }

  graphRefs.zoomButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const action = button.dataset.graphZoom;
      if (action === "in") {
        graphState.viewport.scale = clampGraphValue(graphState.viewport.scale * 1.12, 0.55, 2.4);
      } else if (action === "out") {
        graphState.viewport.scale = clampGraphValue(graphState.viewport.scale / 1.12, 0.55, 2.4);
      } else {
        resetGraphViewport();
        return;
      }
      applyGraphViewportTransform();
    });
  });

  graphRefs.stage.addEventListener("wheel", (event) => {
    event.preventDefault();
    const delta = event.deltaY < 0 ? 1.08 : 0.92;
    graphState.viewport.scale = clampGraphValue(graphState.viewport.scale * delta, 0.55, 2.4);
    applyGraphViewportTransform();
  }, { passive: false });

  graphRefs.svg.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target.closest("[data-node-id]")) {
      return;
    }

    graphState.dragging = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      startX: graphState.viewport.x,
      startY: graphState.viewport.y
    };
    graphRefs.svg.setPointerCapture(event.pointerId);
    graphRefs.stage.classList.add("is-panning");
  });

  graphRefs.svg.addEventListener("pointermove", (event) => {
    if (!graphState.dragging || graphState.dragging.pointerId !== event.pointerId) {
      return;
    }

    const factor = 1 / Math.max(graphState.viewport.scale, 0.55);
    graphState.viewport.x = graphState.dragging.startX + ((event.clientX - graphState.dragging.x) * factor);
    graphState.viewport.y = graphState.dragging.startY + ((event.clientY - graphState.dragging.y) * factor);
    applyGraphViewportTransform();
  });

  const stopDrag = (event) => {
    if (!graphState.dragging || graphState.dragging.pointerId !== event.pointerId) {
      return;
    }
    graphState.dragging = null;
    graphRefs.stage.classList.remove("is-panning");
    if (graphRefs.svg.hasPointerCapture(event.pointerId)) {
      graphRefs.svg.releasePointerCapture(event.pointerId);
    }
  };

  graphRefs.svg.addEventListener("pointerup", stopDrag);
  graphRefs.svg.addEventListener("pointercancel", stopDrag);
  graphRefs.svg.addEventListener("dblclick", (event) => {
    if (event.target.closest("[data-node-id]")) {
      return;
    }
    resetGraphViewport();
  });

  window.addEventListener("resize", () => {
    renderGraphScene();
    renderGraphInfoPanel();
  });
}

async function initGraphPage() {
  if (!document.querySelector(".graph-content")) {
    return;
  }

  requireAuth();
  syncGraphRefs();
  fillUserBadge();
  initSidebarProfile();
  bindGraphViewport();
  await loadSidebar();
  startChatsAutoRefresh();
  await fetchGraphData();
  buildGraphModel();
  renderGraphScene();
  renderGraphInfoPanel();
  if (graphState.selectedNodeId) {
    await enrichGraphSelection(getNodeById(graphState.selectedNodeId));
  }
}

document.addEventListener("DOMContentLoaded", () => {
  void initGraphPage();
});
