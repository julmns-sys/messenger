from datetime import date, datetime

from flask import Flask, request, jsonify, send_from_directory, redirect, render_template
from flask_cors import CORS
from flask_socketio import SocketIO, emit, join_room
from werkzeug.security import generate_password_hash, check_password_hash
from db import get_db, init_db
import secrets

app = Flask(__name__, static_folder="assets")
CORS(app)
socketio = SocketIO(app, cors_allowed_origins="*")

socket_sessions = {}
user_last_seen = {}


def format_timestamp(value):
    if isinstance(value, datetime):
        return value.isoformat(sep=" ", timespec="seconds")
    if isinstance(value, date):
        return value.isoformat()
    return value


def persist_token(token, user_id):
    conn = get_db()
    conn.execute("""
        INSERT OR REPLACE INTO auth_tokens (token, user_id)
        VALUES (%s, %s)
    """, (token, user_id))
    conn.commit()
    conn.close()


def lookup_user_id_by_token(token):
    if not token:
        return None

    conn = get_db()
    row = conn.execute("""
        SELECT user_id
        FROM auth_tokens
        WHERE token = %s
    """, (token,)).fetchone()
    conn.close()
    return row["user_id"] if row else None


def current_user_id():
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return None

    token = auth.replace("Bearer ", "")
    return lookup_user_id_by_token(token)


def user_id_from_token(token):
    return lookup_user_id_by_token(token)


def get_user_room(user_id):
    return f"user_{int(user_id)}"


def get_online_user_ids():
    return {int(user_id) for user_id in socket_sessions.values() if user_id}


def is_user_online(user_id):
    if not user_id:
        return False
    return int(user_id) in get_online_user_ids()


def get_user_last_seen(user_id):
    if not user_id:
        return None
    return user_last_seen.get(int(user_id))


def emit_presence_updated(user_id):
    if not user_id:
        return
    socketio.emit("presence_updated", {
        "user_id": int(user_id),
        "is_online": is_user_online(user_id),
        "last_seen": format_timestamp(get_user_last_seen(user_id))
    })


def emit_chat_list_updated_for_users(user_ids, chat_type, chat_id):
    payload = {
        "chat_type": chat_type,
        "chat_id": chat_id
    }
    for user_id in {int(user_id) for user_id in user_ids if user_id}:
        socketio.emit("chat_list_updated", payload, room=get_user_room(user_id))


def serialize_user_profile(user):
    return {
        "id": user["id"],
        "name": user["name"],
        "username": user["username"],
        "email": user["email"],
        "bio": user["bio"],
        "is_online": is_user_online(user["id"]),
        "last_seen": format_timestamp(get_user_last_seen(user["id"]))
    }


def serialize_public_user(user):
    return {
        "id": user["id"],
        "name": user["name"],
        "username": user["username"],
        "bio": user["bio"],
        "is_online": is_user_online(user["id"]),
        "last_seen": format_timestamp(get_user_last_seen(user["id"]))
    }


def can_manage_group_admins(conn, user_id, group_id):
    if not user_id:
        return False

    group = conn.execute("""
        SELECT owner_id
        FROM groups
        WHERE id = %s
    """, (group_id,)).fetchone()
    if not group:
        return False

    if group["owner_id"] == user_id:
        return True

    member = conn.execute("""
        SELECT is_admin
        FROM group_members
        WHERE group_id = %s AND user_id = %s
    """, (group_id, user_id)).fetchone()
    return bool(member and member["is_admin"])


def can_manage_group_member(conn, actor_user_id, group_id, target_user_id, group=None, actor_member=None, target_member=None):
    if not actor_user_id or not target_user_id or actor_user_id == target_user_id:
        return False

    if group is None:
        group = conn.execute("""
            SELECT owner_id
            FROM groups
            WHERE id = %s
        """, (group_id,)).fetchone()
    if not group:
        return False

    if target_user_id == group["owner_id"]:
        return False

    if actor_member is None:
        actor_member = conn.execute("""
            SELECT user_id, is_admin
            FROM group_members
            WHERE group_id = %s AND user_id = %s
        """, (group_id, actor_user_id)).fetchone()
    if not actor_member:
        return False

    if target_member is None:
        target_member = conn.execute("""
            SELECT user_id, is_admin
            FROM group_members
            WHERE group_id = %s AND user_id = %s
        """, (group_id, target_user_id)).fetchone()
    if not target_member:
        return False

    if actor_user_id == group["owner_id"]:
        return True

    if not actor_member["is_admin"]:
        return False

    return not bool(target_member["is_admin"])


def emit_group_members_updated(group_id):
    socketio.emit("group_members_updated", {
        "group_id": group_id
    }, room=f"group_{group_id}")


def emit_group_updated(group_id):
    socketio.emit("group_updated", {
        "group_id": group_id
    }, room=f"group_{group_id}")


def generate_group_invite_token(conn):
    token = secrets.token_urlsafe(18)
    while conn.execute("SELECT 1 FROM group_invites WHERE token = %s", (token,)).fetchone():
        token = secrets.token_urlsafe(18)
    return token


def create_group_invite(conn, group_id, created_by):
    token = generate_group_invite_token(conn)
    conn.execute("""
        INSERT INTO group_invites (group_id, token, is_active, created_by)
        VALUES (%s, %s, 1, %s)
    """, (group_id, token, created_by))
    return conn.execute("""
        SELECT group_id, token, created_at
        FROM group_invites
        WHERE token = %s
    """, (token,)).fetchone()


def ensure_active_group_invite(conn, group_id, created_by):
    invite = conn.execute("""
        SELECT group_id, token, created_at
        FROM group_invites
        WHERE group_id = %s AND is_active = 1
        ORDER BY id DESC
        LIMIT 1
    """, (group_id,)).fetchone()
    if invite:
        return invite
    return create_group_invite(conn, group_id, created_by)


def regenerate_group_invite(conn, group_id, created_by):
    conn.execute("""
        UPDATE group_invites
        SET is_active = 0
        WHERE group_id = %s AND is_active = 1
    """, (group_id,))
    return create_group_invite(conn, group_id, created_by)


def build_invite_url(token):
    return f"{request.url_root.rstrip('/')}/invite/{token}"


def serialize_group_invite(invite):
    if not invite:
        return None
    return {
        "token": invite["token"],
        "url": build_invite_url(invite["token"]),
        "path": f"/invite/{invite['token']}",
        "created_at": format_timestamp(invite["created_at"])
    }


def get_group_invite_by_token(conn, token):
    return conn.execute("""
        SELECT
            gi.group_id,
            gi.token,
            gi.created_at,
            g.title,
            g.description,
            g.owner_id
        FROM group_invites gi
        JOIN groups g ON g.id = gi.group_id
        WHERE gi.token = %s AND gi.is_active = 1
        LIMIT 1
    """, (token,)).fetchone()


def request_wants_json():
    accept = (request.headers.get("Accept") or "").lower()
    return "application/json" in accept and "text/html" not in accept


def build_group_response(conn, group_id, viewer_user_id, include_messages=False, limit=None):
    group = conn.execute("""
        SELECT id, title, description, owner_id, created_at
        FROM groups
        WHERE id = %s
    """, (group_id,)).fetchone()
    if not group:
        return None

    viewer_member = conn.execute("""
        SELECT user_id, is_admin
        FROM group_members
        WHERE group_id = %s AND user_id = %s
    """, (group_id, viewer_user_id)).fetchone()
    if not viewer_member:
        return None

    members_count_row = conn.execute("""
        SELECT COUNT(*) AS members_count
        FROM group_members
        WHERE group_id = %s
    """, (group_id,)).fetchone()
    messages_count_row = conn.execute("""
        SELECT COUNT(*) AS messages_count
        FROM group_messages gm
        WHERE gm.group_id = %s
          AND NOT EXISTS (
              SELECT 1
              FROM hidden_group_messages hgm
              WHERE hgm.group_message_id = gm.id AND hgm.user_id = %s
          )
    """, (group_id, viewer_user_id)).fetchone()
    member_rows = conn.execute("""
        SELECT
            u.id,
            u.name,
            u.username,
            u.bio,
            gm.is_admin
        FROM group_members gm
        JOIN users u ON u.id = gm.user_id
        WHERE gm.group_id = %s
        ORDER BY
            CASE WHEN u.id = %s THEN 0 WHEN gm.is_admin = 1 THEN 1 ELSE 2 END,
            COALESCE(u.name, u.username),
            u.username
    """, (group_id, group["owner_id"])).fetchall()

    members = []
    for member in member_rows:
        is_owner = member["id"] == group["owner_id"]
        members.append({
            **serialize_public_user(member),
            "is_admin": bool(member["is_admin"]),
            "is_owner": is_owner,
            "can_manage": can_manage_group_member(
                conn,
                viewer_user_id,
                group_id,
                member["id"],
                group=group,
                actor_member=viewer_member,
                target_member=member
            )
        })

    payload = {
        "id": group["id"],
        "title": group["title"],
        "name": group["title"],
        "description": group["description"],
        "started_at": format_timestamp(group["created_at"]),
        "owner_id": group["owner_id"],
        "can_edit_group": can_edit_group_details(conn, viewer_user_id, group_id),
        "can_add_members": can_add_group_members(conn, viewer_user_id, group_id),
        "can_manage_admins": can_manage_group_admins(conn, viewer_user_id, group_id),
        "members_count": members_count_row["members_count"],
        "messages_count": messages_count_row["messages_count"] if messages_count_row else 0,
        "members": members
    }

    can_manage_invite = can_edit_group_details(conn, viewer_user_id, group_id)
    payload["can_manage_invite"] = can_manage_invite
    payload["invite"] = serialize_group_invite(
        ensure_active_group_invite(conn, group_id, viewer_user_id or group["owner_id"])
    ) if can_manage_invite else None

    if include_messages:
        messages, has_more_messages = fetch_group_messages_page(conn, group_id, viewer_user_id, limit or parse_limit_arg())
        payload["has_more_messages"] = has_more_messages
        payload["messages"] = [
            serialize_group_message(message)
            for message in messages
        ]

    return payload


def can_edit_group_details(conn, user_id, group_id):
    if not user_id:
        return False

    group = conn.execute("""
        SELECT owner_id
        FROM groups
        WHERE id = %s
    """, (group_id,)).fetchone()

    if not group:
        return False

    if group["owner_id"] == user_id:
        return True

    member = conn.execute("""
        SELECT is_admin
        FROM group_members
        WHERE group_id = %s AND user_id = %s
    """, (group_id, user_id)).fetchone()
    return bool(member and member["is_admin"])


def can_add_group_members(conn, user_id, group_id):
    if not user_id:
        return False

    group = conn.execute("""
        SELECT owner_id
        FROM groups
        WHERE id = %s
    """, (group_id,)).fetchone()

    if not group:
        return False

    if group["owner_id"] == user_id:
        return True

    member = conn.execute("""
        SELECT is_admin
        FROM group_members
        WHERE group_id = %s AND user_id = %s
    """, (group_id, user_id)).fetchone()
    return bool(member and member["is_admin"])


def can_access_direct_chat(conn, user_id, chat_id):
    if not user_id:
        return False

    chat = conn.execute("""
        SELECT 1
        FROM chats
        WHERE id = %s AND (user1_id = %s OR user2_id = %s)
    """, (chat_id, user_id, user_id)).fetchone()
    return chat is not None


def can_access_group(conn, user_id, group_id):
    if not user_id:
        return False

    member = conn.execute("""
        SELECT 1
        FROM group_members
        WHERE group_id = %s AND user_id = %s
    """, (group_id, user_id)).fetchone()
    return member is not None


def get_direct_chat_member_ids(conn, chat_id):
    row = conn.execute("""
        SELECT user1_id, user2_id
        FROM chats
        WHERE id = %s
    """, (chat_id,)).fetchone()
    if not row:
        return []
    return [row["user1_id"], row["user2_id"]]


def get_group_member_ids(conn, group_id):
    return [
        row["user_id"]
        for row in conn.execute("""
            SELECT user_id
            FROM group_members
            WHERE group_id = %s
        """, (group_id,)).fetchall()
    ]


def serialize_direct_message(message):
    return {
        "id": message["id"],
        "sender_id": message["sender_id"],
        "sender_name": message["sender_name"],
        "text": message["text"],
        "created_at": format_timestamp(message["created_at"]),
        "is_read": bool(message["read_at"]),
        "is_edited": bool(message["edited_at"])
    }


def serialize_group_message(message):
    return {
        "id": message["id"],
        "sender_id": message["sender_id"],
        "sender_name": message["sender_name"],
        "text": message["text"],
        "message_type": message["message_type"] or "text",
        "created_at": format_timestamp(message["created_at"]),
        "is_edited": bool(message["edited_at"])
    }


def mark_direct_chat_as_read(conn, chat_id, reader_id):
    unread_row = conn.execute("""
        SELECT MAX(id) AS upto_message_id
        FROM messages
        WHERE chat_id = %s
          AND sender_id != %s
          AND read_at IS NULL
    """, (chat_id, reader_id)).fetchone()

    upto_message_id = unread_row["upto_message_id"] if unread_row else None
    if not upto_message_id:
        return None

    conn.execute("""
        UPDATE messages
        SET read_at = CURRENT_TIMESTAMP
        WHERE chat_id = %s
          AND sender_id != %s
          AND read_at IS NULL
    """, (chat_id, reader_id))
    conn.commit()

    return upto_message_id


def mark_group_chat_as_read(conn, group_id, reader_id):
    latest_row = conn.execute("""
        SELECT MAX(gm.id) AS upto_message_id
        FROM group_messages gm
        WHERE gm.group_id = %s
          AND gm.message_type = 'text'
          AND NOT EXISTS (
              SELECT 1
              FROM hidden_group_messages hgm
              WHERE hgm.group_message_id = gm.id AND hgm.user_id = %s
          )
    """, (group_id, reader_id)).fetchone()

    upto_message_id = latest_row["upto_message_id"] if latest_row else None
    if not upto_message_id:
        return None

    conn.execute("""
        INSERT INTO group_read_states (group_id, user_id, last_read_message_id, last_read_at)
        VALUES (%s, %s, %s, CURRENT_TIMESTAMP)
        ON DUPLICATE KEY UPDATE
            last_read_message_id = VALUES(last_read_message_id),
            last_read_at = CURRENT_TIMESTAMP
    """, (group_id, reader_id, upto_message_id))
    conn.commit()

    return upto_message_id


def initialize_group_read_state(conn, group_id, user_id):
    latest_row = conn.execute("""
        SELECT MAX(id) AS last_message_id
        FROM group_messages
        WHERE group_id = %s
          AND message_type = 'text'
    """, (group_id,)).fetchone()
    last_message_id = latest_row["last_message_id"] if latest_row else None
    if not last_message_id:
        return

    conn.execute("""
        INSERT OR IGNORE INTO group_read_states (group_id, user_id, last_read_message_id, last_read_at)
        VALUES (%s, %s, %s, CURRENT_TIMESTAMP)
    """, (group_id, user_id, last_message_id))


def get_direct_message_for_chat(conn, chat_id, message_id):
    return conn.execute("""
        SELECT
            m.id,
            m.chat_id,
            m.sender_id,
            u.name AS sender_name,
            m.text,
            m.created_at,
            m.read_at,
            m.edited_at
        FROM messages m
        JOIN users u ON u.id = m.sender_id
        WHERE m.id = %s AND m.chat_id = %s
    """, (message_id, chat_id)).fetchone()


def get_group_message_for_group(conn, group_id, message_id):
    return conn.execute("""
        SELECT
            gm.id,
            gm.group_id,
            gm.sender_id,
            u.name AS sender_name,
            gm.text,
            gm.message_type,
            gm.created_at,
            gm.edited_at
        FROM group_messages gm
        JOIN users u ON u.id = gm.sender_id
        WHERE gm.id = %s AND gm.group_id = %s
    """, (message_id, group_id)).fetchone()


def parse_limit_arg(default=30, maximum=100):
    raw_limit = request.args.get("limit", str(default)).strip()
    try:
        limit = int(raw_limit)
    except (TypeError, ValueError):
        limit = default
    return max(1, min(limit, maximum))


def parse_before_id_arg():
    raw_before = (request.args.get("before") or "").strip()
    if not raw_before:
        return None
    try:
        return int(raw_before)
    except (TypeError, ValueError):
        return None


def parse_query_arg(name="q", max_length=120):
    raw_value = str(request.args.get(name, "") or "").strip()
    if not raw_value:
        return ""
    return raw_value[:max_length]


def parse_message_ids_payload():
    data = request.json or {}
    raw_message_ids = data.get("message_ids", [])

    if not isinstance(raw_message_ids, list) or not raw_message_ids:
        return None, "message_ids должен быть непустым списком"

    message_ids = []
    seen = set()

    for raw_message_id in raw_message_ids:
        try:
            message_id = int(raw_message_id)
        except (TypeError, ValueError):
            return None, "message_ids содержит некорректный id"

        if message_id <= 0:
            return None, "message_ids содержит некорректный id"

        if message_id in seen:
            continue

        seen.add(message_id)
        message_ids.append(message_id)

    return message_ids, None


def fetch_direct_messages_page(conn, chat_id, user_id, limit, before_id=None):
    params = [chat_id, user_id]
    before_clause = ""
    if before_id is not None:
        before_clause = "AND m.id < %s"
        params.append(before_id)
    params.append(limit + 1)

    rows = conn.execute(f"""
        SELECT
            m.id,
            m.sender_id,
            u.name AS sender_name,
            m.text,
            m.created_at,
            m.read_at,
            m.edited_at
        FROM messages m
        JOIN users u ON u.id = m.sender_id
        WHERE m.chat_id = %s
          AND NOT EXISTS (
              SELECT 1
              FROM hidden_messages hm
              WHERE hm.message_id = m.id AND hm.user_id = %s
          )
          {before_clause}
        ORDER BY m.id DESC
        LIMIT %s
    """, params).fetchall()

    has_more = len(rows) > limit
    page_rows = rows[:limit]
    page_rows = list(reversed(page_rows))
    return page_rows, has_more


def fetch_group_messages_page(conn, group_id, user_id, limit, before_id=None):
    params = [group_id, user_id]
    before_clause = ""
    if before_id is not None:
        before_clause = "AND gm.id < %s"
        params.append(before_id)
    params.append(limit + 1)

    rows = conn.execute(f"""
        SELECT
            gm.id,
            gm.sender_id,
            u.name AS sender_name,
            gm.text,
            gm.message_type,
            gm.created_at,
            gm.edited_at
        FROM group_messages gm
        JOIN users u ON u.id = gm.sender_id
        WHERE gm.group_id = %s
          AND NOT EXISTS (
              SELECT 1
              FROM hidden_group_messages hgm
              WHERE hgm.group_message_id = gm.id AND hgm.user_id = %s
          )
          {before_clause}
        ORDER BY gm.id DESC
        LIMIT %s
    """, params).fetchall()

    has_more = len(rows) > limit
    page_rows = rows[:limit]
    page_rows = list(reversed(page_rows))
    return page_rows, has_more


def search_direct_messages(conn, chat_id, user_id, query, limit):
    pattern = f"%{query}%"
    return conn.execute("""
        SELECT
            m.id,
            m.sender_id,
            u.name AS sender_name,
            m.text,
            m.created_at,
            m.read_at,
            m.edited_at
        FROM messages m
        JOIN users u ON u.id = m.sender_id
        WHERE m.chat_id = %s
          AND m.text LIKE %s
          AND NOT EXISTS (
              SELECT 1
              FROM hidden_messages hm
              WHERE hm.message_id = m.id AND hm.user_id = %s
          )
        ORDER BY m.id DESC
        LIMIT %s
    """, (chat_id, pattern, user_id, limit)).fetchall()


def search_group_messages(conn, group_id, user_id, query, limit):
    pattern = f"%{query}%"
    return conn.execute("""
        SELECT
            gm.id,
            gm.sender_id,
            u.name AS sender_name,
            gm.text,
            gm.message_type,
            gm.created_at,
            gm.edited_at
        FROM group_messages gm
        JOIN users u ON u.id = gm.sender_id
        WHERE gm.group_id = %s
          AND gm.text LIKE %s
          AND NOT EXISTS (
              SELECT 1
              FROM hidden_group_messages hgm
              WHERE hgm.group_message_id = gm.id AND hgm.user_id = %s
          )
        ORDER BY gm.id DESC
        LIMIT %s
    """, (group_id, pattern, user_id, limit)).fetchall()


def fetch_direct_message_context(conn, chat_id, user_id, message_id, limit):
    target = conn.execute("""
        SELECT
            m.id,
            m.sender_id,
            u.name AS sender_name,
            m.text,
            m.created_at,
            m.read_at,
            m.edited_at
        FROM messages m
        JOIN users u ON u.id = m.sender_id
        WHERE m.id = %s AND m.chat_id = %s
          AND NOT EXISTS (
              SELECT 1
              FROM hidden_messages hm
              WHERE hm.message_id = m.id AND hm.user_id = %s
          )
    """, (message_id, chat_id, user_id)).fetchone()
    if not target:
        return None

    before_rows = conn.execute("""
        SELECT
            m.id,
            m.sender_id,
            u.name AS sender_name,
            m.text,
            m.created_at,
            m.read_at,
            m.edited_at
        FROM messages m
        JOIN users u ON u.id = m.sender_id
        WHERE m.chat_id = %s
          AND m.id < %s
          AND NOT EXISTS (
              SELECT 1
              FROM hidden_messages hm
              WHERE hm.message_id = m.id AND hm.user_id = %s
          )
        ORDER BY m.id DESC
        LIMIT %s
    """, (chat_id, message_id, user_id, limit)).fetchall()
    after_rows = conn.execute("""
        SELECT
            m.id,
            m.sender_id,
            u.name AS sender_name,
            m.text,
            m.created_at,
            m.read_at,
            m.edited_at
        FROM messages m
        JOIN users u ON u.id = m.sender_id
        WHERE m.chat_id = %s
          AND m.id > %s
          AND NOT EXISTS (
              SELECT 1
              FROM hidden_messages hm
              WHERE hm.message_id = m.id AND hm.user_id = %s
          )
        ORDER BY m.id ASC
        LIMIT %s
    """, (chat_id, message_id, user_id, limit)).fetchall()

    has_more_before = conn.execute("""
        SELECT 1
        FROM messages m
        WHERE m.chat_id = %s
          AND m.id < %s
          AND NOT EXISTS (
              SELECT 1
              FROM hidden_messages hm
              WHERE hm.message_id = m.id AND hm.user_id = %s
          )
        LIMIT 1
    """, (chat_id, before_rows[-1]["id"] if before_rows else message_id, user_id)).fetchone() is not None
    has_more_after = conn.execute("""
        SELECT 1
        FROM messages m
        WHERE m.chat_id = %s
          AND m.id > %s
          AND NOT EXISTS (
              SELECT 1
              FROM hidden_messages hm
              WHERE hm.message_id = m.id AND hm.user_id = %s
          )
        LIMIT 1
    """, (chat_id, after_rows[-1]["id"] if after_rows else message_id, user_id)).fetchone() is not None

    messages = list(reversed(before_rows)) + [target] + list(after_rows)
    return messages, has_more_before, has_more_after


def fetch_group_message_context(conn, group_id, user_id, message_id, limit):
    target = conn.execute("""
        SELECT
            gm.id,
            gm.sender_id,
            u.name AS sender_name,
            gm.text,
            gm.message_type,
            gm.created_at,
            gm.edited_at
        FROM group_messages gm
        JOIN users u ON u.id = gm.sender_id
        WHERE gm.id = %s AND gm.group_id = %s
          AND NOT EXISTS (
              SELECT 1
              FROM hidden_group_messages hgm
              WHERE hgm.group_message_id = gm.id AND hgm.user_id = %s
          )
    """, (message_id, group_id, user_id)).fetchone()
    if not target:
        return None

    before_rows = conn.execute("""
        SELECT
            gm.id,
            gm.sender_id,
            u.name AS sender_name,
            gm.text,
            gm.message_type,
            gm.created_at,
            gm.edited_at
        FROM group_messages gm
        JOIN users u ON u.id = gm.sender_id
        WHERE gm.group_id = %s
          AND gm.id < %s
          AND NOT EXISTS (
              SELECT 1
              FROM hidden_group_messages hgm
              WHERE hgm.group_message_id = gm.id AND hgm.user_id = %s
          )
        ORDER BY gm.id DESC
        LIMIT %s
    """, (group_id, message_id, user_id, limit)).fetchall()
    after_rows = conn.execute("""
        SELECT
            gm.id,
            gm.sender_id,
            u.name AS sender_name,
            gm.text,
            gm.message_type,
            gm.created_at,
            gm.edited_at
        FROM group_messages gm
        JOIN users u ON u.id = gm.sender_id
        WHERE gm.group_id = %s
          AND gm.id > %s
          AND NOT EXISTS (
              SELECT 1
              FROM hidden_group_messages hgm
              WHERE hgm.group_message_id = gm.id AND hgm.user_id = %s
          )
        ORDER BY gm.id ASC
        LIMIT %s
    """, (group_id, message_id, user_id, limit)).fetchall()

    has_more_before = conn.execute("""
        SELECT 1
        FROM group_messages gm
        WHERE gm.group_id = %s
          AND gm.id < %s
          AND NOT EXISTS (
              SELECT 1
              FROM hidden_group_messages hgm
              WHERE hgm.group_message_id = gm.id AND hgm.user_id = %s
          )
        LIMIT 1
    """, (group_id, before_rows[-1]["id"] if before_rows else message_id, user_id)).fetchone() is not None
    has_more_after = conn.execute("""
        SELECT 1
        FROM group_messages gm
        WHERE gm.group_id = %s
          AND gm.id > %s
          AND NOT EXISTS (
              SELECT 1
              FROM hidden_group_messages hgm
              WHERE hgm.group_message_id = gm.id AND hgm.user_id = %s
          )
        LIMIT 1
    """, (group_id, after_rows[-1]["id"] if after_rows else message_id, user_id)).fetchone() is not None

    messages = list(reversed(before_rows)) + [target] + list(after_rows)
    return messages, has_more_before, has_more_after


def get_user_display_name(user):
    return user["name"] or user["username"] or "Пользователь"


def create_group_message_record(conn, group_id, sender_id, text, message_type="text"):
    cur = conn.cursor()
    cur.execute("""
        INSERT INTO group_messages (group_id, sender_id, text, message_type)
        VALUES (%s, %s, %s, %s)
    """, (group_id, sender_id, text, message_type))
    return get_group_message_for_group(conn, group_id, cur.lastrowid)


def emit_group_new_message(message, group_id):
    socketio.emit("new_message", {
        **serialize_group_message(message)
    }, room=f"group_{group_id}")
    conn = get_db()
    member_ids = get_group_member_ids(conn, group_id)
    conn.close()
    emit_chat_list_updated_for_users(member_ids, "group", group_id)


@socketio.on("connect")
def handle_connect(auth):
    token = None
    if isinstance(auth, dict):
        token = auth.get("token")

    user_id = user_id_from_token(token)
    was_online = is_user_online(user_id)
    socket_sessions[request.sid] = user_id
    if user_id:
        user_last_seen.pop(int(user_id), None)
        join_room(get_user_room(user_id))
        if not was_online:
            emit_presence_updated(user_id)


@socketio.on("disconnect")
def handle_disconnect():
    user_id = socket_sessions.pop(request.sid, None)
    if user_id and not is_user_online(user_id):
        user_last_seen[int(user_id)] = datetime.utcnow()
        emit_presence_updated(user_id)


@socketio.on("join_chat")
def handle_join_chat(data):
    user_id = socket_sessions.get(request.sid)
    if not user_id:
        emit("join_error", {"message": "Не авторизован"})
        return

    chat_type = (data or {}).get("type")
    chat_id = (data or {}).get("id")

    try:
        chat_id = int(chat_id)
    except (TypeError, ValueError):
        emit("join_error", {"message": "Некорректный chat id"})
        return

    conn = get_db()

    if chat_type == "group":
        allowed = can_access_group(conn, user_id, chat_id)
        room = f"group_{chat_id}"
    else:
        allowed = can_access_direct_chat(conn, user_id, chat_id)
        room = f"direct_{chat_id}"

    conn.close()

    if not allowed:
        emit("join_error", {"message": "Нет доступа к чату"})
        return

    join_room(room)
    emit("join_ok", {"room": room})


def delete_direct_chat_for_user(conn, chat_id, user_id):
    conn.execute("""
        INSERT OR IGNORE INTO hidden_direct_chats (chat_id, user_id)
        VALUES (%s, %s)
    """, (chat_id, user_id))
    conn.execute("""
        INSERT OR IGNORE INTO hidden_messages (message_id, user_id)
        SELECT id, %s
        FROM messages
        WHERE chat_id = %s
    """, (user_id, chat_id))
    conn.commit()


@app.route("/")
def home():
    return render_template(
        "index.html",
        title="/Chatik",
        body_class="page-shell chats-page",
        data_chat_type=None,
        sidebar_action_mode="search",
        sidebar_back_href=None,
        sidebar_back_label=None,
        sidebar_back_icon=None,
    )


@app.get("/search")
def search_page():
    return render_template(
        "search.html",
        title="Search | /Chatik",
        body_class="page-shell",
        data_chat_type=None,
        sidebar_action_mode="back",
        sidebar_back_href="/",
        sidebar_back_label="Chats",
        sidebar_back_icon="←",
    )


@app.get("/chat/<int:chat_id>")
def direct_chat_page(chat_id):
    return render_template(
        "chat.html",
        title="Chat | /Chatik",
        body_class="page-shell thread-page",
        data_chat_type="direct",
        sidebar_action_mode="search",
        sidebar_back_href=None,
        sidebar_back_label=None,
        sidebar_back_icon=None,
    )


@app.get("/chat/user/<int:user_id>")
def direct_chat_draft_page(user_id):
    return render_template(
        "chat.html",
        title="Chat | /Chatik",
        body_class="page-shell thread-page",
        data_chat_type="direct",
        sidebar_action_mode="search",
        sidebar_back_href=None,
        sidebar_back_label=None,
        sidebar_back_icon=None,
    )


@app.get("/group/<int:group_id>")
def group_chat_page(group_id):
    return render_template(
        "group_chat.html",
        title="Group Chat | /Chatik",
        body_class="page-shell thread-page",
        data_chat_type="group",
        sidebar_action_mode="search",
        sidebar_back_href=None,
        sidebar_back_label=None,
        sidebar_back_icon=None,
    )


@app.get("/profile")
def profile_page():
    return render_template(
        "index.html",
        title="/Chatik",
        body_class="page-shell chats-page",
        data_chat_type=None,
        sidebar_action_mode="search",
        sidebar_back_href=None,
        sidebar_back_label=None,
        sidebar_back_icon=None,
    )


@app.get("/create-group")
def create_group_page():
    return send_from_directory(".", "create_group.html")


@app.get("/login")
def login_page():
    return send_from_directory(".", "login.html")


@app.get("/register")
def register_page():
    return send_from_directory(".", "register.html")


@app.get("/invite/<token>")
def invite_page(token):
    conn = get_db()
    invite = get_group_invite_by_token(conn, token)
    user_id = current_user_id()

    if request_wants_json():
        if not invite:
            conn.close()
            return jsonify({"message": "Ссылка приглашения недействительна"}), 404

        members_count_row = conn.execute("""
            SELECT COUNT(*) AS members_count
            FROM group_members
            WHERE group_id = %s
        """, (invite["group_id"],)).fetchone()
        already_member = bool(user_id and can_access_group(conn, user_id, invite["group_id"]))
        payload = {
            "token": invite["token"],
            "group_id": invite["group_id"],
            "title": invite["title"],
            "description": invite["description"],
            "members_count": members_count_row["members_count"] if members_count_row else 0,
            "invite": serialize_group_invite(invite),
            "already_member": already_member,
            "redirect_url": f"/group/{invite['group_id']}" if already_member else None
        }
        conn.close()
        return jsonify(payload)

    conn.close()
    return send_from_directory(".", "invite.html")


@app.get("/index.html")
def legacy_index_page():
    return redirect("/", code=302)


@app.get("/search.html")
def legacy_search_page():
    return redirect("/search", code=302)


@app.get("/create_group.html")
def legacy_create_group_page():
    return redirect("/create-group", code=302)


@app.get("/login.html")
def legacy_login_page():
    return redirect("/login", code=302)


@app.get("/register.html")
def legacy_register_page():
    return redirect("/register", code=302)


@app.get("/chat.html")
def legacy_direct_chat_page():
    chat_id = (request.args.get("id") or "").strip()
    user_id = (request.args.get("user_id") or "").strip()
    if chat_id:
        return redirect(f"/chat/{chat_id}", code=302)
    if user_id:
        return redirect(f"/chat/user/{user_id}", code=302)
    return redirect("/", code=302)


@app.get("/group_chat.html")
def legacy_group_chat_page():
    group_id = (request.args.get("id") or "").strip()
    if group_id:
        return redirect(f"/group/{group_id}", code=302)
    return redirect("/", code=302)


@app.route("/<path:filename>")
def pages(filename):
    return send_from_directory(".", filename)


@app.post("/auth/register")
def register():
    data = request.json

    name = data.get("name", "").strip()
    username = data.get("username", "").strip().replace("@", "")
    email = data.get("email", "").strip()
    password = data.get("password", "")

    if not name or not username or not password:
        return jsonify({"message": "Заполните имя, username и пароль"}), 400

    conn = get_db()
    cur = conn.cursor()

    try:
        password_hash = generate_password_hash(password)

        cur.execute("""
            INSERT INTO users (name, username, email, password_hash)
            VALUES (%s, %s, %s, %s)
        """, (name, username, email, password_hash))

        conn.commit()
        user_id = cur.lastrowid

    except Exception:
        conn.close()
        return jsonify({"message": "Такой username уже занят"}), 400

    conn.close()

    token = secrets.token_hex(32)
    persist_token(token, user_id)

    return jsonify({
        "token": token,
        "user": {
            "id": user_id,
            "name": name,
            "username": username,
            "email": email,
            "bio": ""
        }
    })


@app.post("/auth/login")
def login():
    data = request.json

    username = data.get("username", "").strip().replace("@", "")
    password = data.get("password", "")

    conn = get_db()
    user = conn.execute(
        "SELECT * FROM users WHERE username = %s",
        (username,)
    ).fetchone()
    conn.close()

    if not user or not check_password_hash(user["password_hash"], password):
        return jsonify({"message": "Неверный логин или пароль"}), 401

    token = secrets.token_hex(32)
    persist_token(token, user["id"])

    return jsonify({
        "token": token,
        "user": serialize_user_profile(user)
    })


@app.get("/users/me")
def get_me():
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    conn = get_db()
    user = conn.execute("""
        SELECT id, name, username, email, bio
        FROM users
        WHERE id = %s
    """, (user_id,)).fetchone()
    conn.close()

    if not user:
        return jsonify({"message": "Пользователь не найден"}), 404

    return jsonify(serialize_user_profile(user))


@app.patch("/users/me")
def update_me():
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    data = request.json or {}
    allowed_fields = {
        "name": (data.get("name", ""), 80),
        "username": (data.get("username", ""), 32),
        "email": (data.get("email", ""), 255),
        "bio": (data.get("bio", ""), 50)
    }

    updates = {}
    for field, (raw_value, max_length) in allowed_fields.items():
        if field not in data:
            continue
        value = str(raw_value or "").strip()
        if field == "username":
            value = value.replace("@", "")
        if len(value) > max_length:
            return jsonify({"message": f"{field} слишком длинный"}), 400
        updates[field] = value

    if not updates:
        return jsonify({"message": "Нет данных для обновления"}), 400

    if "name" in updates and not updates["name"]:
        return jsonify({"message": "Имя не может быть пустым"}), 400

    if "username" in updates and not updates["username"]:
        return jsonify({"message": "Username не может быть пустым"}), 400

    conn = get_db()

    if "username" in updates:
        existing_user = conn.execute("""
            SELECT id
            FROM users
            WHERE username = %s AND id != %s
        """, (updates["username"], user_id)).fetchone()
        if existing_user:
            conn.close()
            return jsonify({"message": "Такой username уже занят"}), 400

    assignments = ", ".join(f"{field} = %s" for field in updates.keys())
    params = [*updates.values(), user_id]

    conn.execute(f"""
        UPDATE users
        SET {assignments}
        WHERE id = %s
    """, params)
    conn.commit()

    user = conn.execute("""
        SELECT id, name, username, email, bio
        FROM users
        WHERE id = %s
    """, (user_id,)).fetchone()
    conn.close()

    return jsonify(serialize_user_profile(user))


@app.get("/users/search")
def search_users():
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    username = request.args.get("username", "").replace("@", "")

    conn = get_db()
    users = conn.execute("""
        SELECT
            u.id,
            u.name,
            u.username,
            EXISTS (
                SELECT 1
                FROM contacts ct
                WHERE ct.owner_user_id = %s AND ct.contact_user_id = u.id
            ) AS is_contact,
            c.id AS chat_id
        FROM users u
        LEFT JOIN chats c
            ON (
                ((c.user1_id = %s AND c.user2_id = u.id) OR (c.user2_id = %s AND c.user1_id = u.id))
                AND EXISTS (
                    SELECT 1
                    FROM messages m
                    WHERE m.chat_id = c.id
                )
                AND NOT EXISTS (
                    SELECT 1
                    FROM hidden_direct_chats hdc
                    WHERE hdc.chat_id = c.id AND hdc.user_id = %s
                )
            )
        WHERE u.username LIKE %s AND u.id != %s
        LIMIT 20
    """, (user_id, user_id, user_id, user_id, f"%{username}%", user_id)).fetchall()
    conn.close()

    return jsonify([
        {
            **dict(user),
            "is_online": is_user_online(user["id"]),
            "last_seen": format_timestamp(get_user_last_seen(user["id"]))
        }
        for user in users
    ])


@app.get("/contacts")
def get_contacts():
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    conn = get_db()
    contacts = conn.execute("""
        SELECT
            u.id,
            u.name,
            u.username,
            c.id AS chat_id
        FROM contacts ct
        JOIN users u ON u.id = ct.contact_user_id
        LEFT JOIN chats c
            ON (
                ((c.user1_id = %s AND c.user2_id = u.id) OR (c.user2_id = %s AND c.user1_id = u.id))
                AND NOT EXISTS (
                    SELECT 1
                    FROM hidden_direct_chats hdc
                    WHERE hdc.chat_id = c.id AND hdc.user_id = %s
                )
            )
        WHERE ct.owner_user_id = %s
        ORDER BY COALESCE(u.name, u.username), u.username
    """, (user_id, user_id, user_id, user_id)).fetchall()
    conn.close()

    return jsonify([
        {
            **dict(contact),
            "is_online": is_user_online(contact["id"]),
            "last_seen": format_timestamp(get_user_last_seen(contact["id"]))
        }
        for contact in contacts
    ])


@app.post("/contacts")
def add_contact():
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    data = request.json or {}
    contact_user_id = data.get("user_id") or data.get("contact_user_id")

    try:
        contact_user_id = int(contact_user_id)
    except (TypeError, ValueError):
        return jsonify({"message": "Некорректный user_id"}), 400

    if contact_user_id == user_id:
        return jsonify({"message": "Нельзя добавить себя в контакты"}), 400

    conn = get_db()
    target_user = conn.execute("""
        SELECT id, name, username
        FROM users
        WHERE id = %s
    """, (contact_user_id,)).fetchone()

    if not target_user:
        conn.close()
        return jsonify({"message": "Пользователь не найден"}), 404

    conn.execute("""
        INSERT OR IGNORE INTO contacts (owner_user_id, contact_user_id)
        VALUES (%s, %s)
    """, (user_id, contact_user_id))
    conn.commit()

    chat = conn.execute("""
        SELECT id
        FROM chats
        WHERE (user1_id = %s AND user2_id = %s) OR (user1_id = %s AND user2_id = %s)
        LIMIT 1
    """, (user_id, contact_user_id, contact_user_id, user_id)).fetchone()
    conn.close()

    return jsonify({
        "id": target_user["id"],
        "name": target_user["name"],
        "username": target_user["username"],
        "chat_id": chat["id"] if chat else None,
        "is_contact": True,
        "is_online": is_user_online(target_user["id"]),
        "last_seen": format_timestamp(get_user_last_seen(target_user["id"]))
    }), 201


@app.delete("/contacts/<int:contact_user_id>")
def remove_contact(contact_user_id):
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    conn = get_db()
    conn.execute("""
        DELETE FROM contacts
        WHERE owner_user_id = %s AND contact_user_id = %s
    """, (user_id, contact_user_id))
    conn.commit()
    conn.close()

    return jsonify({"ok": True, "contact_user_id": contact_user_id})


@app.get("/users/<int:target_user_id>")
def get_user(target_user_id):
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    conn = get_db()
    user = conn.execute("""
        SELECT id, name, username, bio
        FROM users
        WHERE id = %s
    """, (target_user_id,)).fetchone()
    conn.close()

    if not user:
        return jsonify({"message": "Пользователь не найден"}), 404

    return jsonify(serialize_public_user(user))


@app.get("/chats")
def get_chats():
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    conn = get_db()
    direct_chats = conn.execute("""
        SELECT
            c.id,
            u.id AS user_id,
            u.username,
            u.name AS title,
            (
                SELECT m.text
                FROM messages m
                WHERE m.chat_id = c.id
                ORDER BY m.created_at DESC, m.id DESC
                LIMIT 1
            ) AS last_message_text,
            (
                SELECT m.created_at
                FROM messages m
                WHERE m.chat_id = c.id
                ORDER BY m.created_at DESC, m.id DESC
                LIMIT 1
            ) AS updated_at,
            (
                SELECT COUNT(*)
                FROM messages m
                WHERE m.chat_id = c.id
                  AND m.sender_id != %s
                  AND m.read_at IS NULL
                  AND NOT EXISTS (
                      SELECT 1
                      FROM hidden_messages hm
                      WHERE hm.message_id = m.id AND hm.user_id = %s
                  )
            ) AS unread_count
        FROM chats c
        JOIN users u
            ON u.id = CASE
                WHEN c.user1_id = %s THEN c.user2_id
                ELSE c.user1_id
            END
        WHERE (c.user1_id = %s OR c.user2_id = %s)
          AND EXISTS (
              SELECT 1
              FROM messages m
              WHERE m.chat_id = c.id
          )
          AND NOT EXISTS (
              SELECT 1
              FROM hidden_direct_chats hdc
              WHERE hdc.chat_id = c.id AND hdc.user_id = %s
          )
    """, (user_id, user_id, user_id, user_id, user_id, user_id)).fetchall()

    group_chats = conn.execute("""
        SELECT
            g.id,
            g.title,
            (
                SELECT gm.text
                FROM group_messages gm
                WHERE gm.group_id = g.id
                  AND NOT EXISTS (
                      SELECT 1
                      FROM hidden_group_messages hgm
                      WHERE hgm.group_message_id = gm.id AND hgm.user_id = %s
                  )
                ORDER BY gm.created_at DESC, gm.id DESC
                LIMIT 1
            ) AS last_message_text,
            (
                SELECT gm.created_at
                FROM group_messages gm
                WHERE gm.group_id = g.id
                  AND NOT EXISTS (
                      SELECT 1
                      FROM hidden_group_messages hgm
                      WHERE hgm.group_message_id = gm.id AND hgm.user_id = %s
                  )
                ORDER BY gm.created_at DESC, gm.id DESC
                LIMIT 1
            ) AS updated_at,
            (
                SELECT COUNT(*)
                FROM group_messages gm
                WHERE gm.group_id = g.id
                  AND gm.message_type = 'text'
                  AND gm.sender_id != %s
                  AND gm.id > COALESCE((
                      SELECT grs.last_read_message_id
                      FROM group_read_states grs
                      WHERE grs.group_id = g.id AND grs.user_id = %s
                  ), 0)
                  AND NOT EXISTS (
                      SELECT 1
                      FROM hidden_group_messages hgm
                      WHERE hgm.group_message_id = gm.id AND hgm.user_id = %s
                  )
            ) AS unread_count
        FROM groups g
        JOIN group_members gmbr ON gmbr.group_id = g.id
        WHERE gmbr.user_id = %s
    """, (user_id, user_id, user_id, user_id, user_id, user_id)).fetchall()
    conn.close()

    chats = [
        {
            "id": chat["id"],
            "type": "direct",
            "user_id": chat["user_id"],
            "username": chat["username"],
            "title": chat["title"],
            "is_online": is_user_online(chat["user_id"]),
            "last_seen": format_timestamp(get_user_last_seen(chat["user_id"])),
            "last_message": {"text": chat["last_message_text"]} if chat["last_message_text"] is not None else None,
            "updated_at": format_timestamp(chat["updated_at"]),
            "unread_count": chat["unread_count"] or 0
        }
        for chat in direct_chats
    ]

    chats.extend([
        {
            "id": group["id"],
            "type": "group",
            "username": None,
            "title": group["title"],
            "last_message": {"text": group["last_message_text"]} if group["last_message_text"] is not None else None,
            "updated_at": format_timestamp(group["updated_at"]),
            "unread_count": group["unread_count"] or 0
        }
        for group in group_chats
    ])

    chats.sort(
        key=lambda chat: (
            chat["updated_at"] is not None,
            chat["updated_at"] or "",
            chat["id"]
        ),
        reverse=True
    )

    return jsonify(chats)


@app.post("/chats")
@app.post("/chats/direct")
def create_direct_chat():
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    data = request.json or {}
    participant_id = data.get("user_id") or data.get("participant_id")

    if not participant_id:
        return jsonify({"message": "user_id или participant_id обязателен"}), 400

    try:
        participant_id = int(participant_id)
    except (TypeError, ValueError):
        return jsonify({"message": "Некорректный user_id"}), 400

    if participant_id == user_id:
        return jsonify({"message": "Нельзя создать чат с самим собой"}), 400

    user1_id, user2_id = sorted((user_id, participant_id))

    conn = get_db()
    participant = conn.execute(
        "SELECT id, username, name FROM users WHERE id = %s",
        (participant_id,)
    ).fetchone()

    if not participant:
        conn.close()
        return jsonify({"message": "Пользователь не найден"}), 404

    chat = conn.execute("""
        SELECT id
        FROM chats
        WHERE user1_id = %s AND user2_id = %s
    """, (user1_id, user2_id)).fetchone()

    if not chat:
        cur = conn.cursor()
        cur.execute("""
            INSERT INTO chats (user1_id, user2_id)
            VALUES (%s, %s)
        """, (user1_id, user2_id))
        conn.commit()
        chat_id = cur.lastrowid
    else:
        chat_id = chat["id"]

    conn.close()

    return jsonify({
        "id": chat_id,
        "type": "direct",
        "username": participant["username"],
        "title": participant["name"],
        "last_message": None,
        "updated_at": None,
        "started_at": None,
        "messages_count": 0
    })


@app.get("/chats/<int:chat_id>")
def get_chat(chat_id):
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    conn = get_db()
    chat = conn.execute("""
        SELECT
            c.id,
            c.created_at,
            u.id AS user_id,
            u.username,
            u.name,
            u.bio,
            (
                SELECT COUNT(*)
                FROM messages m
                WHERE m.chat_id = c.id
                  AND NOT EXISTS (
                      SELECT 1
                      FROM hidden_messages hm
                      WHERE hm.message_id = m.id AND hm.user_id = %s
                  )
            ) AS messages_count
        FROM chats c
        JOIN users u
            ON u.id = CASE
                WHEN c.user1_id = %s THEN c.user2_id
                ELSE c.user1_id
            END
        WHERE c.id = %s AND (c.user1_id = %s OR c.user2_id = %s)
    """, (user_id, user_id, chat_id, user_id, user_id)).fetchone()

    if not chat:
        conn.close()
        return jsonify({"message": "Чат не найден"}), 404

    read_upto_message_id = mark_direct_chat_as_read(conn, chat_id, user_id)
    limit = parse_limit_arg()
    messages, has_more_messages = fetch_direct_messages_page(conn, chat_id, user_id, limit)
    conn.close()

    if read_upto_message_id:
        socketio.emit("message_read", {
            "chat_id": chat_id,
            "reader_id": user_id,
            "upto_message_id": read_upto_message_id
        }, room=f"direct_{chat_id}")
        emit_chat_list_updated_for_users([user_id], "direct", chat_id)

    return jsonify({
        "id": chat["id"],
        "user_id": chat["user_id"],
        "title": chat["name"] or chat["username"],
        "name": chat["name"],
        "username": chat["username"],
        "bio": chat["bio"],
        "is_online": is_user_online(chat["user_id"]),
        "last_seen": format_timestamp(get_user_last_seen(chat["user_id"])),
        "started_at": format_timestamp(chat["created_at"]),
        "messages_count": chat["messages_count"] or 0,
        "has_more_messages": has_more_messages,
        "messages": [
            serialize_direct_message(message)
            for message in messages
        ]
    })


@app.get("/chats/<int:chat_id>/messages")
def get_chat_messages(chat_id):
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    conn = get_db()
    chat = can_access_direct_chat(conn, user_id, chat_id)
    if not chat:
        conn.close()
        return jsonify({"message": "Чат не найден"}), 404

    limit = parse_limit_arg()
    before_id = parse_before_id_arg()
    messages, has_more = fetch_direct_messages_page(conn, chat_id, user_id, limit, before_id)
    conn.close()

    return jsonify({
        "messages": [serialize_direct_message(message) for message in messages],
        "has_more_messages": has_more
    })


@app.get("/chats/<int:chat_id>/messages/search")
def search_chat_messages(chat_id):
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    query = parse_query_arg()
    if not query:
        return jsonify({"items": []})

    conn = get_db()
    chat = can_access_direct_chat(conn, user_id, chat_id)
    if not chat:
        conn.close()
        return jsonify({"message": "Чат не найден"}), 404

    rows = search_direct_messages(conn, chat_id, user_id, query, parse_limit_arg(default=20, maximum=50))
    conn.close()

    return jsonify({
        "items": [serialize_direct_message(row) for row in rows],
        "query": query
    })


@app.get("/chats/<int:chat_id>/messages/<int:message_id>/context")
def get_chat_message_context(chat_id, message_id):
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    conn = get_db()
    chat = can_access_direct_chat(conn, user_id, chat_id)
    if not chat:
        conn.close()
        return jsonify({"message": "Чат не найден"}), 404

    context_payload = fetch_direct_message_context(
        conn,
        chat_id,
        user_id,
        message_id,
        parse_limit_arg(default=12, maximum=30)
    )
    conn.close()

    if not context_payload:
        return jsonify({"message": "Сообщение не найдено"}), 404

    messages, has_more_before, has_more_after = context_payload
    return jsonify({
        "messages": [serialize_direct_message(message) for message in messages],
        "target_message_id": message_id,
        "has_more_before": has_more_before,
        "has_more_after": has_more_after
    })


@app.post("/chats/<int:chat_id>/messages")
def create_chat_message(chat_id):
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    data = request.json or {}
    text = data.get("text", "").strip()

    if not text:
        return jsonify({"message": "Текст сообщения обязателен"}), 400

    conn = get_db()
    chat = can_access_direct_chat(conn, user_id, chat_id)

    if not chat:
        conn.close()
        return jsonify({"message": "Чат не найден"}), 404

    member_ids = get_direct_chat_member_ids(conn, chat_id)

    cur = conn.cursor()
    conn.execute("DELETE FROM hidden_direct_chats WHERE chat_id = %s", (chat_id,))
    cur.execute("""
        INSERT INTO messages (chat_id, sender_id, text)
        VALUES (%s, %s, %s)
    """, (chat_id, user_id, text))
    conn.commit()

    message = conn.execute("""
        SELECT
            m.id,
            m.sender_id,
            u.name AS sender_name,
            m.text,
            m.created_at,
            m.read_at,
            m.edited_at
        FROM messages m
        JOIN users u ON u.id = m.sender_id
        WHERE m.id = %s
    """, (cur.lastrowid,)).fetchone()
    conn.close()

    message_data = serialize_direct_message(message)

    socketio.emit("new_message", message_data, room=f"direct_{chat_id}")
    emit_chat_list_updated_for_users(member_ids, "direct", chat_id)

    return jsonify(message_data), 201


@app.delete("/chats/<int:chat_id>")
def delete_direct_chat(chat_id):
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    scope = (request.args.get("scope") or "me").strip().lower()
    if scope not in {"me", "all"}:
        return jsonify({"message": "Некорректный scope"}), 400

    conn = get_db()
    if not can_access_direct_chat(conn, user_id, chat_id):
        conn.close()
        return jsonify({"message": "Чат не найден"}), 404

    if scope == "all":
        message_ids = [
            row["id"]
            for row in conn.execute("SELECT id FROM messages WHERE chat_id = %s", (chat_id,)).fetchall()
        ]

        if message_ids:
            placeholders = ",".join("%s" for _ in message_ids)
            conn.execute(f"DELETE FROM hidden_messages WHERE message_id IN ({placeholders})", message_ids)

        conn.execute("DELETE FROM hidden_direct_chats WHERE chat_id = %s", (chat_id,))
        conn.execute("DELETE FROM messages WHERE chat_id = %s", (chat_id,))
        conn.execute("DELETE FROM chats WHERE id = %s", (chat_id,))
        conn.commit()
        conn.close()

        socketio.emit("chat_deleted", {
            "chat_id": chat_id,
            "scope": "all"
        }, room=f"direct_{chat_id}")
        return jsonify({"ok": True})

    delete_direct_chat_for_user(conn, chat_id, user_id)
    conn.close()
    return jsonify({"ok": True})


@app.post("/chats/<int:chat_id>/read")
def mark_chat_read(chat_id):
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    conn = get_db()
    chat = can_access_direct_chat(conn, user_id, chat_id)
    if not chat:
        conn.close()
        return jsonify({"message": "Чат не найден"}), 404

    read_upto_message_id = mark_direct_chat_as_read(conn, chat_id, user_id)
    conn.close()

    if read_upto_message_id:
        socketio.emit("message_read", {
            "chat_id": chat_id,
            "reader_id": user_id,
            "upto_message_id": read_upto_message_id
        }, room=f"direct_{chat_id}")
        emit_chat_list_updated_for_users([user_id], "direct", chat_id)

    return jsonify({
        "ok": True,
        "upto_message_id": read_upto_message_id
    })


@app.patch("/chats/<int:chat_id>/messages/<int:message_id>")
def update_chat_message(chat_id, message_id):
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    data = request.json or {}
    text = data.get("text", "").strip()
    if not text:
        return jsonify({"message": "Текст сообщения обязателен"}), 400

    conn = get_db()
    if not can_access_direct_chat(conn, user_id, chat_id):
        conn.close()
        return jsonify({"message": "Чат не найден"}), 404

    message = get_direct_message_for_chat(conn, chat_id, message_id)
    if not message:
        conn.close()
        return jsonify({"message": "Сообщение не найдено"}), 404

    if message["sender_id"] != user_id:
        conn.close()
        return jsonify({"message": "Можно редактировать только свои сообщения"}), 403

    conn.execute("""
        UPDATE messages
        SET text = %s, edited_at = CURRENT_TIMESTAMP
        WHERE id = %s AND chat_id = %s
    """, (text, message_id, chat_id))
    conn.commit()

    updated_message = get_direct_message_for_chat(conn, chat_id, message_id)
    conn.close()

    payload = {
        "chat_id": chat_id,
        "message": serialize_direct_message(updated_message)
    }
    socketio.emit("message_updated", payload, room=f"direct_{chat_id}")
    return jsonify(payload["message"])


@app.delete("/chats/<int:chat_id>/messages/<int:message_id>")
def delete_chat_message(chat_id, message_id):
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    scope = (request.args.get("scope") or "me").strip().lower()
    if scope not in {"me", "all"}:
        return jsonify({"message": "Некорректный scope"}), 400

    conn = get_db()
    if not can_access_direct_chat(conn, user_id, chat_id):
        conn.close()
        return jsonify({"message": "Чат не найден"}), 404

    message = get_direct_message_for_chat(conn, chat_id, message_id)
    if not message:
        conn.close()
        return jsonify({"message": "Сообщение не найдено"}), 404

    if scope == "all":
        if message["sender_id"] != user_id:
            conn.close()
            return jsonify({"message": "Удалить у всех можно только свои сообщения"}), 403

        conn.execute("DELETE FROM hidden_messages WHERE message_id = %s", (message_id,))
        conn.execute("DELETE FROM messages WHERE id = %s AND chat_id = %s", (message_id, chat_id))
        conn.commit()
        conn.close()

        socketio.emit("message_deleted", {
            "chat_id": chat_id,
            "message_id": message_id,
            "scope": "all"
        }, room=f"direct_{chat_id}")
        return jsonify({"ok": True})

    conn.execute("""
        INSERT OR IGNORE INTO hidden_messages (message_id, user_id)
        VALUES (%s, %s)
    """, (message_id, user_id))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.post("/chats/<int:chat_id>/messages/bulk-delete")
def bulk_delete_chat_messages(chat_id):
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    scope = (request.json or {}).get("scope", "me")
    scope = str(scope).strip().lower()
    if scope not in {"me", "all"}:
        return jsonify({"message": "Некорректный scope"}), 400

    message_ids, error = parse_message_ids_payload()
    if error:
        return jsonify({"message": error}), 400

    conn = get_db()
    if not can_access_direct_chat(conn, user_id, chat_id):
        conn.close()
        return jsonify({"message": "Чат не найден"}), 404

    placeholders = ",".join("%s" for _ in message_ids)
    message_rows = conn.execute(f"""
        SELECT id, sender_id
        FROM messages
        WHERE chat_id = %s AND id IN ({placeholders})
    """, [chat_id, *message_ids]).fetchall()

    found_ids = {row["id"] for row in message_rows}
    missing_ids = [message_id for message_id in message_ids if message_id not in found_ids]
    if missing_ids:
        conn.close()
        return jsonify({"message": "Некоторые сообщения не найдены"}), 404

    if scope == "all":
        foreign_ids = [row["id"] for row in message_rows if row["sender_id"] != user_id]
        if foreign_ids:
            conn.close()
            return jsonify({"message": "Удалить у всех можно только свои сообщения"}), 403

        conn.execute(f"DELETE FROM hidden_messages WHERE message_id IN ({placeholders})", message_ids)
        conn.execute(f"DELETE FROM messages WHERE chat_id = %s AND id IN ({placeholders})", [chat_id, *message_ids])
        conn.commit()
        conn.close()

        for message_id in message_ids:
            socketio.emit("message_deleted", {
                "chat_id": chat_id,
                "message_id": message_id,
                "scope": "all"
            }, room=f"direct_{chat_id}")

        return jsonify({"ok": True, "deleted_ids": message_ids, "scope": scope})

    conn.executemany("""
        INSERT OR IGNORE INTO hidden_messages (message_id, user_id)
        VALUES (%s, %s)
    """, [(message_id, user_id) for message_id in message_ids])
    conn.commit()
    conn.close()
    return jsonify({"ok": True, "deleted_ids": message_ids, "scope": scope})


@app.post("/groups")
def create_group():
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    data = request.json or {}
    title = data.get("title", "").strip()
    description = data.get("description", "").strip()
    member_ids = data.get("member_ids", [])

    if not title:
        return jsonify({"message": "Название группы обязательно"}), 400

    if len(title) > 16:
        return jsonify({"message": "Название группы: максимум 16 символов"}), 400

    if not isinstance(member_ids, list):
        return jsonify({"message": "member_ids должен быть списком"}), 400

    conn = get_db()
    cur = conn.cursor()

    cur.execute("""
        INSERT INTO groups (title, description, owner_id)
        VALUES (%s, %s, %s)
    """, (title, description, user_id))
    group_id = cur.lastrowid

    cur.execute("""
        INSERT OR IGNORE INTO group_members (group_id, user_id, is_admin)
        VALUES (%s, %s, 1)
    """, (group_id, user_id))

    for member_id in member_ids:
        cur.execute("""
            INSERT OR IGNORE INTO group_members (group_id, user_id, is_admin)
            VALUES (%s, %s, 0)
        """, (group_id, member_id))

    initialize_group_read_state(conn, group_id, user_id)
    for member_id in member_ids:
        initialize_group_read_state(conn, group_id, member_id)

    create_group_invite(conn, group_id, user_id)

    conn.commit()
    conn.close()

    return jsonify({
        "id": group_id,
        "title": title,
        "description": description
    }), 201


@app.get("/groups/<int:group_id>")
def get_group(group_id):
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    conn = get_db()
    group_payload = build_group_response(conn, group_id, user_id, include_messages=True)
    read_upto_message_id = None
    if group_payload:
        read_upto_message_id = mark_group_chat_as_read(conn, group_id, user_id)
    conn.close()

    if not group_payload:
        return jsonify({"message": "Группа не найдена"}), 404

    if read_upto_message_id:
        emit_chat_list_updated_for_users([user_id], "group", group_id)

    return jsonify(group_payload)


@app.post("/groups/<int:group_id>/invite/regenerate")
def regenerate_group_invite_endpoint(group_id):
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    conn = get_db()
    group = conn.execute("""
        SELECT id
        FROM groups
        WHERE id = %s
    """, (group_id,)).fetchone()

    if not group:
        conn.close()
        return jsonify({"message": "Группа не найдена"}), 404

    if not can_edit_group_details(conn, user_id, group_id):
        conn.close()
        return jsonify({"message": "Обновить invite-ссылку может только создатель или администратор"}), 403

    invite = regenerate_group_invite(conn, group_id, user_id)
    conn.commit()
    conn.close()
    emit_group_updated(group_id)

    return jsonify({
        "ok": True,
        "invite": serialize_group_invite(invite)
    })


@app.patch("/groups/<int:group_id>")
def update_group(group_id):
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    data = request.json or {}
    title = str(data.get("title", "")).strip()
    description = str(data.get("description", "")).strip()

    if not title:
        return jsonify({"message": "Название группы обязательно"}), 400

    if len(title) > 16:
        return jsonify({"message": "Название группы: максимум 16 символов"}), 400

    conn = get_db()
    group = conn.execute("""
        SELECT id, owner_id, title, description
        FROM groups
        WHERE id = %s
    """, (group_id,)).fetchone()

    if not group:
        conn.close()
        return jsonify({"message": "Группа не найдена"}), 404

    if not can_edit_group_details(conn, user_id, group_id):
        conn.close()
        return jsonify({"message": "Редактировать группу может только владелец или администратор"}), 403

    title_changed = title != (group["title"] or "")
    previous_description = group["description"] or ""
    description_changed = description != previous_description

    if not title_changed and not description_changed:
        payload = build_group_response(conn, group_id, user_id)
        conn.close()
        return jsonify(payload)

    conn.execute("""
        UPDATE groups
        SET title = %s, description = %s
        WHERE id = %s
    """, (title, description, group_id))
    actor = conn.execute("""
        SELECT id, name, username, bio
        FROM users
        WHERE id = %s
    """, (user_id,)).fetchone()
    system_messages = []
    if title_changed:
        system_messages.append(create_group_message_record(
            conn,
            group_id,
            user_id,
            f"{get_user_display_name(actor)} изменил название группы на «{title}»",
            "system"
        ))
    if description_changed:
        system_messages.append(create_group_message_record(
            conn,
            group_id,
            user_id,
            f"{get_user_display_name(actor)} {'изменил описание группы' if description else 'удалил описание группы'}",
            "system"
        ))
    conn.commit()
    updated_group = build_group_response(conn, group_id, user_id)
    conn.close()
    for system_message in system_messages:
        emit_group_new_message(system_message, group_id)
    emit_group_updated(group_id)

    return jsonify(updated_group)


@app.post("/invite/<token>/join")
def join_group_by_invite(token):
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    conn = get_db()
    invite = get_group_invite_by_token(conn, token)
    if not invite:
        conn.close()
        return jsonify({"message": "Ссылка приглашения недействительна"}), 404

    group_id = invite["group_id"]
    if can_access_group(conn, user_id, group_id):
        conn.close()
        return jsonify({
            "ok": True,
            "already_member": True,
            "group_id": group_id,
            "redirect_url": f"/group/{group_id}"
        })

    conn.execute("""
        INSERT OR IGNORE INTO group_members (group_id, user_id, is_admin)
        VALUES (%s, %s, 0)
    """, (group_id, user_id))
    initialize_group_read_state(conn, group_id, user_id)
    actor = conn.execute("""
        SELECT id, name, username, bio
        FROM users
        WHERE id = %s
    """, (user_id,)).fetchone()
    system_message = create_group_message_record(
        conn,
        group_id,
        user_id,
        f"{get_user_display_name(actor)} вступил в группу по ссылке",
        "system"
    )
    conn.commit()
    conn.close()

    emit_group_new_message(system_message, group_id)
    emit_group_members_updated(group_id)
    emit_group_updated(group_id)

    return jsonify({
        "ok": True,
        "group_id": group_id,
        "redirect_url": f"/group/{group_id}"
    })


@app.get("/groups/<int:group_id>/messages")
def get_group_messages(group_id):
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    conn = get_db()
    member = can_access_group(conn, user_id, group_id)
    if not member:
        conn.close()
        return jsonify({"message": "Группа не найдена"}), 404

    limit = parse_limit_arg()
    before_id = parse_before_id_arg()
    messages, has_more = fetch_group_messages_page(conn, group_id, user_id, limit, before_id)
    conn.close()

    return jsonify({
        "messages": [serialize_group_message(message) for message in messages],
        "has_more_messages": has_more
    })


@app.get("/groups/<int:group_id>/messages/search")
def search_group_messages_endpoint(group_id):
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    query = parse_query_arg()
    if not query:
        return jsonify({"items": []})

    conn = get_db()
    member = can_access_group(conn, user_id, group_id)
    if not member:
        conn.close()
        return jsonify({"message": "Группа не найдена"}), 404

    rows = search_group_messages(conn, group_id, user_id, query, parse_limit_arg(default=20, maximum=50))
    conn.close()

    return jsonify({
        "items": [serialize_group_message(row) for row in rows],
        "query": query
    })


@app.get("/groups/<int:group_id>/messages/<int:message_id>/context")
def get_group_message_context_endpoint(group_id, message_id):
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    conn = get_db()
    member = can_access_group(conn, user_id, group_id)
    if not member:
        conn.close()
        return jsonify({"message": "Группа не найдена"}), 404

    context_payload = fetch_group_message_context(
        conn,
        group_id,
        user_id,
        message_id,
        parse_limit_arg(default=12, maximum=30)
    )
    conn.close()

    if not context_payload:
        return jsonify({"message": "Сообщение не найдено"}), 404

    messages, has_more_before, has_more_after = context_payload
    return jsonify({
        "messages": [serialize_group_message(message) for message in messages],
        "target_message_id": message_id,
        "has_more_before": has_more_before,
        "has_more_after": has_more_after
    })


@app.post("/groups/<int:group_id>/read")
def mark_group_read(group_id):
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    conn = get_db()
    member = can_access_group(conn, user_id, group_id)
    if not member:
        conn.close()
        return jsonify({"message": "Группа не найдена"}), 404

    read_upto_message_id = mark_group_chat_as_read(conn, group_id, user_id)
    conn.close()

    if read_upto_message_id:
        emit_chat_list_updated_for_users([user_id], "group", group_id)

    return jsonify({
        "ok": True,
        "upto_message_id": read_upto_message_id
    })


@app.delete("/groups/<int:group_id>/messages")
def clear_group_messages_for_user(group_id):
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    conn = get_db()
    if not can_access_group(conn, user_id, group_id):
        conn.close()
        return jsonify({"message": "Группа не найдена"}), 404

    message_ids = [
        row["id"]
        for row in conn.execute("""
            SELECT id
            FROM group_messages
            WHERE group_id = %s
        """, (group_id,)).fetchall()
    ]

    if message_ids:
        conn.executemany("""
            INSERT OR IGNORE INTO hidden_group_messages (group_message_id, user_id)
            VALUES (%s, %s)
        """, [(message_id, user_id) for message_id in message_ids])

    conn.commit()
    conn.close()

    return jsonify({
        "ok": True,
        "group_id": group_id,
        "cleared_count": len(message_ids)
    })


@app.delete("/groups/<int:group_id>/leave")
def leave_group(group_id):
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    conn = get_db()
    group = conn.execute("""
        SELECT owner_id
        FROM groups
        WHERE id = %s
    """, (group_id,)).fetchone()

    if not group:
        conn.close()
        return jsonify({"message": "Группа не найдена"}), 404

    member = can_access_group(conn, user_id, group_id)
    if not member:
        conn.close()
        return jsonify({"message": "Вы не состоите в группе"}), 404

    if group["owner_id"] == user_id:
        transferable_members = conn.execute("""
            SELECT u.id, u.name, u.username, u.bio, gm.is_admin
            FROM group_members gm
            JOIN users u ON u.id = gm.user_id
            WHERE gm.group_id = %s AND gm.user_id != %s
            ORDER BY COALESCE(u.name, u.username), u.username
        """, (group_id, user_id)).fetchall()
        conn.close()
        return jsonify({
            "message": "Создатель группы должен выбрать действие перед выходом",
            "code": "owner_leave_requires_action",
            "can_delete_group": True,
            "can_transfer_owner": bool(transferable_members),
            "transferable_members": [
                {
                    **serialize_public_user(member_row),
                    "is_admin": bool(member_row["is_admin"])
                }
                for member_row in transferable_members
            ]
        }), 409

    conn.execute("""
        DELETE FROM group_members
        WHERE group_id = %s AND user_id = %s
    """, (group_id, user_id))
    conn.execute("""
        DELETE FROM group_read_states
        WHERE group_id = %s AND user_id = %s
    """, (group_id, user_id))
    actor = conn.execute("""
        SELECT id, name, username, bio
        FROM users
        WHERE id = %s
    """, (user_id,)).fetchone()
    system_message = create_group_message_record(
        conn,
        group_id,
        user_id,
        f"{get_user_display_name(actor)} вышел из группы",
        "system"
    )
    conn.commit()
    conn.close()
    emit_group_new_message(system_message, group_id)
    emit_group_members_updated(group_id)

    return jsonify({
        "ok": True,
        "group_id": group_id,
        "user_id": user_id
    })


@app.delete("/groups/<int:group_id>")
def delete_group(group_id):
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    conn = get_db()
    group = conn.execute("""
        SELECT owner_id
        FROM groups
        WHERE id = %s
    """, (group_id,)).fetchone()

    if not group:
        conn.close()
        return jsonify({"message": "Группа не найдена"}), 404

    if group["owner_id"] != user_id:
        conn.close()
        return jsonify({"message": "Удалить группу может только создатель"}), 403

    group_message_ids = [
        row["id"]
        for row in conn.execute("""
            SELECT id
            FROM group_messages
            WHERE group_id = %s
        """, (group_id,)).fetchall()
    ]

    if group_message_ids:
        placeholders = ",".join("%s" for _ in group_message_ids)
        conn.execute(f"""
            DELETE FROM hidden_group_messages
            WHERE group_message_id IN ({placeholders})
        """, group_message_ids)

    conn.execute("DELETE FROM group_messages WHERE group_id = %s", (group_id,))
    conn.execute("DELETE FROM group_read_states WHERE group_id = %s", (group_id,))
    conn.execute("DELETE FROM group_members WHERE group_id = %s", (group_id,))
    conn.execute("DELETE FROM group_invites WHERE group_id = %s", (group_id,))
    conn.execute("DELETE FROM groups WHERE id = %s", (group_id,))
    conn.commit()
    conn.close()

    return jsonify({
        "ok": True,
        "group_id": group_id
    })


@app.post("/groups/<int:group_id>/transfer-owner")
def transfer_group_owner(group_id):
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    data = request.json or {}
    new_owner_id = data.get("new_owner_id")

    try:
        new_owner_id = int(new_owner_id)
    except (TypeError, ValueError):
        return jsonify({"message": "Некорректный new_owner_id"}), 400

    conn = get_db()
    group = conn.execute("""
        SELECT owner_id
        FROM groups
        WHERE id = %s
    """, (group_id,)).fetchone()

    if not group:
        conn.close()
        return jsonify({"message": "Группа не найдена"}), 404

    if group["owner_id"] != user_id:
        conn.close()
        return jsonify({"message": "Передать группу может только создатель"}), 403

    if new_owner_id == user_id:
        conn.close()
        return jsonify({"message": "Нужно выбрать другого участника"}), 400

    target_member = conn.execute("""
        SELECT user_id
        FROM group_members
        WHERE group_id = %s AND user_id = %s
    """, (group_id, new_owner_id)).fetchone()
    if not target_member:
        conn.close()
        return jsonify({"message": "Участник не найден"}), 404

    conn.execute("""
        UPDATE groups
        SET owner_id = %s
        WHERE id = %s
    """, (new_owner_id, group_id))
    conn.execute("""
        UPDATE group_members
        SET is_admin = 1
        WHERE group_id = %s AND user_id = %s
    """, (group_id, new_owner_id))
    conn.execute("""
        DELETE FROM group_members
        WHERE group_id = %s AND user_id = %s
    """, (group_id, user_id))
    new_owner = conn.execute("""
        SELECT id, name, username, bio
        FROM users
        WHERE id = %s
    """, (new_owner_id,)).fetchone()
    system_message = create_group_message_record(
        conn,
        group_id,
        user_id,
        f"{get_user_display_name(new_owner)} стал создателем группы",
        "system"
    )
    conn.commit()
    conn.close()
    emit_group_new_message(system_message, group_id)
    emit_group_members_updated(group_id)

    return jsonify({
        "ok": True,
        "group_id": group_id,
        "new_owner_id": new_owner_id,
        "removed_user_id": user_id
    })


@app.post("/groups/<int:group_id>/members")
def add_group_members(group_id):
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    data = request.json or {}
    raw_member_ids = data.get("member_ids")
    if raw_member_ids is None:
        single_member_id = data.get("user_id") or data.get("member_user_id")
        raw_member_ids = [single_member_id] if single_member_id is not None else []

    if not isinstance(raw_member_ids, list):
        return jsonify({"message": "member_ids должен быть списком"}), 400

    member_ids = []
    for raw_id in raw_member_ids:
        try:
            member_id = int(raw_id)
        except (TypeError, ValueError):
            return jsonify({"message": "Некорректный member_id"}), 400
        if member_id != user_id and member_id not in member_ids:
            member_ids.append(member_id)

    if not member_ids:
        return jsonify({"message": "Выберите хотя бы одного пользователя"}), 400

    conn = get_db()
    if not can_add_group_members(conn, user_id, group_id):
        conn.close()
        return jsonify({"message": "Недостаточно прав"}), 403

    group = conn.execute("""
        SELECT id
        FROM groups
        WHERE id = %s
    """, (group_id,)).fetchone()
    if not group:
        conn.close()
        return jsonify({"message": "Группа не найдена"}), 404

    placeholders = ",".join("%s" for _ in member_ids)
    users = conn.execute(f"""
        SELECT id, name, username, bio
        FROM users
        WHERE id IN ({placeholders})
    """, member_ids).fetchall()
    found_user_ids = {user["id"] for user in users}
    missing_user_ids = [member_id for member_id in member_ids if member_id not in found_user_ids]
    if missing_user_ids:
        conn.close()
        return jsonify({"message": "Некоторые пользователи не найдены"}), 404

    existing_rows = conn.execute(f"""
        SELECT user_id
        FROM group_members
        WHERE group_id = %s AND user_id IN ({placeholders})
    """, [group_id, *member_ids]).fetchall()
    existing_member_ids = {row["user_id"] for row in existing_rows}
    new_member_ids = [member_id for member_id in member_ids if member_id not in existing_member_ids]

    if not new_member_ids:
        conn.close()
        return jsonify({"message": "Все выбранные пользователи уже в группе"}), 400

    conn.executemany("""
        INSERT INTO group_members (group_id, user_id, is_admin)
        VALUES (%s, %s, 0)
    """, [(group_id, member_id) for member_id in new_member_ids])
    for member_id in new_member_ids:
        initialize_group_read_state(conn, group_id, member_id)
    added_user_ids = set(new_member_ids)
    system_messages = [
        create_group_message_record(
            conn,
            group_id,
            user_id,
            f"{get_user_display_name(user)} добавлен в группу",
            "system"
        )
        for user in users
        if user["id"] in added_user_ids
    ]
    conn.commit()
    conn.close()
    emit_chat_list_updated_for_users(new_member_ids, "group", group_id)
    for system_message in system_messages:
        emit_group_new_message(system_message, group_id)
    emit_group_members_updated(group_id)

    added_members = [
        {
            **serialize_public_user(user),
            "is_admin": False,
            "is_owner": False
        }
        for user in users
        if user["id"] in set(new_member_ids)
    ]

    return jsonify({
        "ok": True,
        "group_id": group_id,
        "added_count": len(added_members),
        "members": added_members
    }), 201


@app.patch("/groups/<int:group_id>/members/<int:member_user_id>")
def update_group_member_role(group_id, member_user_id):
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    data = request.json or {}
    if "is_admin" not in data:
        return jsonify({"message": "is_admin обязателен"}), 400

    conn = get_db()
    group = conn.execute("""
        SELECT owner_id
        FROM groups
        WHERE id = %s
    """, (group_id,)).fetchone()
    if not group:
        conn.close()
        return jsonify({"message": "Группа не найдена"}), 404

    member = conn.execute("""
        SELECT user_id, is_admin
        FROM group_members
        WHERE group_id = %s AND user_id = %s
    """, (group_id, member_user_id)).fetchone()
    if not member:
        conn.close()
        return jsonify({"message": "Участник не найден"}), 404

    actor_member = conn.execute("""
        SELECT user_id, is_admin
        FROM group_members
        WHERE group_id = %s AND user_id = %s
    """, (group_id, user_id)).fetchone()
    if not actor_member:
        conn.close()
        return jsonify({"message": "Недостаточно прав"}), 403

    if not can_manage_group_member(
        conn,
        user_id,
        group_id,
        member_user_id,
        group=group,
        actor_member=actor_member,
        target_member=member
    ):
        conn.close()
        return jsonify({"message": "Недостаточно прав"}), 403

    target_user = conn.execute("""
        SELECT id, name, username, bio
        FROM users
        WHERE id = %s
    """, (member_user_id,)).fetchone()
    is_admin = bool(data.get("is_admin"))
    conn.execute("""
        UPDATE group_members
        SET is_admin = %s
        WHERE group_id = %s AND user_id = %s
    """, (1 if is_admin else 0, group_id, member_user_id))
    system_message = create_group_message_record(
        conn,
        group_id,
        user_id,
        f"{get_user_display_name(target_user)} {'стал администратором' if is_admin else 'больше не администратор'}",
        "system"
    )
    conn.commit()
    conn.close()
    emit_group_new_message(system_message, group_id)
    emit_group_members_updated(group_id)

    return jsonify({
        "ok": True,
        "group_id": group_id,
        "member_user_id": member_user_id,
        "is_admin": is_admin
    })


@app.delete("/groups/<int:group_id>/members/<int:member_user_id>")
def remove_group_member(group_id, member_user_id):
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    conn = get_db()
    group = conn.execute("""
        SELECT owner_id
        FROM groups
        WHERE id = %s
    """, (group_id,)).fetchone()
    if not group:
        conn.close()
        return jsonify({"message": "Группа не найдена"}), 404

    if member_user_id == group["owner_id"]:
        conn.close()
        return jsonify({"message": "Нельзя удалить создателя группы"}), 400

    member = conn.execute("""
        SELECT user_id, is_admin
        FROM group_members
        WHERE group_id = %s AND user_id = %s
    """, (group_id, member_user_id)).fetchone()
    if not member:
        conn.close()
        return jsonify({"message": "Участник не найден"}), 404

    actor_member = conn.execute("""
        SELECT user_id, is_admin
        FROM group_members
        WHERE group_id = %s AND user_id = %s
    """, (group_id, user_id)).fetchone()
    if not actor_member:
        conn.close()
        return jsonify({"message": "Недостаточно прав"}), 403

    if not can_manage_group_member(
        conn,
        user_id,
        group_id,
        member_user_id,
        group=group,
        actor_member=actor_member,
        target_member=member
    ):
        conn.close()
        return jsonify({"message": "Недостаточно прав"}), 403

    actor_user = conn.execute("""
        SELECT id, name, username, bio
        FROM users
        WHERE id = %s
    """, (user_id,)).fetchone()
    target_user = conn.execute("""
        SELECT id, name, username, bio
        FROM users
        WHERE id = %s
    """, (member_user_id,)).fetchone()
    conn.execute("""
        DELETE FROM group_members
        WHERE group_id = %s AND user_id = %s
    """, (group_id, member_user_id))
    conn.execute("""
        DELETE FROM group_read_states
        WHERE group_id = %s AND user_id = %s
    """, (group_id, member_user_id))
    system_message = create_group_message_record(
        conn,
        group_id,
        user_id,
        f"{get_user_display_name(actor_user)} удалил {get_user_display_name(target_user)} из группы",
        "system"
    )
    conn.commit()
    conn.close()
    emit_group_new_message(system_message, group_id)
    emit_group_members_updated(group_id)

    return jsonify({
        "ok": True,
        "group_id": group_id,
        "member_user_id": member_user_id
    })


@app.post("/groups/<int:group_id>/messages")
def create_group_message(group_id):
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    conn = get_db()
    member = can_access_group(conn, user_id, group_id)

    if not member:
        conn.close()
        return jsonify({"message": "Группа не найдена"}), 404

    data = request.json or {}
    text = data.get("text", "").strip()
    message_type = str(data.get("message_type", "text") or "text").strip().lower()

    if not text:
        conn.close()
        return jsonify({"message": "Текст сообщения обязателен"}), 400
    if message_type != "text":
        conn.close()
        return jsonify({"message": "Нельзя отправлять системные сообщения вручную"}), 403

    message = create_group_message_record(conn, group_id, user_id, text, "text")
    conn.commit()
    conn.close()

    emit_group_new_message(message, group_id)

    return jsonify(serialize_group_message(message)), 201


@app.patch("/groups/<int:group_id>/messages/<int:message_id>")
def update_group_message(group_id, message_id):
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    data = request.json or {}
    text = data.get("text", "").strip()
    if not text:
        return jsonify({"message": "Текст сообщения обязателен"}), 400

    conn = get_db()
    if not can_access_group(conn, user_id, group_id):
        conn.close()
        return jsonify({"message": "Группа не найдена"}), 404

    message = get_group_message_for_group(conn, group_id, message_id)
    if not message:
        conn.close()
        return jsonify({"message": "Сообщение не найдено"}), 404

    if (message["message_type"] or "text") != "text":
        conn.close()
        return jsonify({"message": "Системные сообщения нельзя редактировать"}), 403

    if message["sender_id"] != user_id:
        conn.close()
        return jsonify({"message": "Можно редактировать только свои сообщения"}), 403

    conn.execute("""
        UPDATE group_messages
        SET text = %s, edited_at = CURRENT_TIMESTAMP
        WHERE id = %s AND group_id = %s
    """, (text, message_id, group_id))
    conn.commit()

    updated_message = get_group_message_for_group(conn, group_id, message_id)
    conn.close()

    payload = {
        "group_id": group_id,
        "message": serialize_group_message(updated_message)
    }
    socketio.emit("message_updated", payload, room=f"group_{group_id}")
    return jsonify(payload["message"])


@app.delete("/groups/<int:group_id>/messages/<int:message_id>")
def delete_group_message(group_id, message_id):
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    scope = (request.args.get("scope") or "me").strip().lower()
    if scope not in {"me", "all"}:
        return jsonify({"message": "Некорректный scope"}), 400

    conn = get_db()
    if not can_access_group(conn, user_id, group_id):
        conn.close()
        return jsonify({"message": "Группа не найдена"}), 404

    message = get_group_message_for_group(conn, group_id, message_id)
    if not message:
        conn.close()
        return jsonify({"message": "Сообщение не найдено"}), 404

    if scope == "all" and (message["message_type"] or "text") != "text":
        conn.close()
        return jsonify({"message": "Системные сообщения нельзя удалять у всех"}), 403

    if scope == "all":
        if message["sender_id"] != user_id:
            conn.close()
            return jsonify({"message": "Удалить у всех можно только свои сообщения"}), 403

        conn.execute("DELETE FROM hidden_group_messages WHERE group_message_id = %s", (message_id,))
        conn.execute("DELETE FROM group_messages WHERE id = %s AND group_id = %s", (message_id, group_id))
        conn.commit()
        conn.close()

        socketio.emit("message_deleted", {
            "group_id": group_id,
            "message_id": message_id,
            "scope": "all"
        }, room=f"group_{group_id}")
        return jsonify({"ok": True})

    conn.execute("""
        INSERT OR IGNORE INTO hidden_group_messages (group_message_id, user_id)
        VALUES (%s, %s)
    """, (message_id, user_id))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.post("/groups/<int:group_id>/messages/bulk-delete")
def bulk_delete_group_messages(group_id):
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    scope = (request.json or {}).get("scope", "me")
    scope = str(scope).strip().lower()
    if scope not in {"me", "all"}:
        return jsonify({"message": "Некорректный scope"}), 400

    message_ids, error = parse_message_ids_payload()
    if error:
        return jsonify({"message": error}), 400

    conn = get_db()
    if not can_access_group(conn, user_id, group_id):
        conn.close()
        return jsonify({"message": "Группа не найдена"}), 404

    placeholders = ",".join("%s" for _ in message_ids)
    message_rows = conn.execute(f"""
        SELECT id, sender_id, message_type
        FROM group_messages
        WHERE group_id = %s AND id IN ({placeholders})
    """, [group_id, *message_ids]).fetchall()

    found_ids = {row["id"] for row in message_rows}
    missing_ids = [message_id for message_id in message_ids if message_id not in found_ids]
    if missing_ids:
        conn.close()
        return jsonify({"message": "Некоторые сообщения не найдены"}), 404

    if scope == "all":
        system_ids = [row["id"] for row in message_rows if (row["message_type"] or "text") != "text"]
        if system_ids:
            conn.close()
            return jsonify({"message": "Системные сообщения нельзя удалять у всех"}), 403

        foreign_ids = [row["id"] for row in message_rows if row["sender_id"] != user_id]
        if foreign_ids:
            conn.close()
            return jsonify({"message": "Удалить у всех можно только свои сообщения"}), 403

        conn.execute(f"DELETE FROM hidden_group_messages WHERE group_message_id IN ({placeholders})", message_ids)
        conn.execute(f"DELETE FROM group_messages WHERE group_id = %s AND id IN ({placeholders})", [group_id, *message_ids])
        conn.commit()
        conn.close()

        for message_id in message_ids:
            socketio.emit("message_deleted", {
                "group_id": group_id,
                "message_id": message_id,
                "scope": "all"
            }, room=f"group_{group_id}")

        return jsonify({"ok": True, "deleted_ids": message_ids, "scope": scope})

    conn.executemany("""
        INSERT OR IGNORE INTO hidden_group_messages (group_message_id, user_id)
        VALUES (%s, %s)
    """, [(message_id, user_id) for message_id in message_ids])
    conn.commit()
    conn.close()
    return jsonify({"ok": True, "deleted_ids": message_ids, "scope": scope})


if __name__ == "__main__":
    init_db()
    socketio.run(app, host="0.0.0.0", port=8000, debug=True)
