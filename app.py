from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from flask_socketio import SocketIO, emit, join_room
from werkzeug.security import generate_password_hash, check_password_hash
from db import get_db, init_db
import secrets

app = Flask(__name__, static_folder="assets")
CORS(app)
socketio = SocketIO(app, cors_allowed_origins="*")

socket_sessions = {}


def persist_token(token, user_id):
    conn = get_db()
    conn.execute("""
        INSERT OR REPLACE INTO auth_tokens (token, user_id)
        VALUES (?, ?)
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
        WHERE token = ?
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


def can_access_direct_chat(conn, user_id, chat_id):
    if not user_id:
        return False

    chat = conn.execute("""
        SELECT 1
        FROM chats
        WHERE id = ? AND (user1_id = ? OR user2_id = ?)
    """, (chat_id, user_id, user_id)).fetchone()
    return chat is not None


def can_access_group(conn, user_id, group_id):
    if not user_id:
        return False

    member = conn.execute("""
        SELECT 1
        FROM group_members
        WHERE group_id = ? AND user_id = ?
    """, (group_id, user_id)).fetchone()
    return member is not None


def serialize_direct_message(message):
    return {
        "id": message["id"],
        "sender_id": message["sender_id"],
        "sender_name": message["sender_name"],
        "text": message["text"],
        "created_at": message["created_at"],
        "is_read": bool(message["read_at"]),
        "is_edited": bool(message["edited_at"])
    }


def serialize_group_message(message):
    return {
        "id": message["id"],
        "sender_id": message["sender_id"],
        "sender_name": message["sender_name"],
        "text": message["text"],
        "created_at": message["created_at"],
        "is_edited": bool(message["edited_at"])
    }


def mark_direct_chat_as_read(conn, chat_id, reader_id):
    unread_row = conn.execute("""
        SELECT MAX(id) AS upto_message_id
        FROM messages
        WHERE chat_id = ?
          AND sender_id != ?
          AND read_at IS NULL
    """, (chat_id, reader_id)).fetchone()

    upto_message_id = unread_row["upto_message_id"] if unread_row else None
    if not upto_message_id:
        return None

    conn.execute("""
        UPDATE messages
        SET read_at = CURRENT_TIMESTAMP
        WHERE chat_id = ?
          AND sender_id != ?
          AND read_at IS NULL
    """, (chat_id, reader_id))
    conn.commit()

    return upto_message_id


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
        WHERE m.id = ? AND m.chat_id = ?
    """, (message_id, chat_id)).fetchone()


def get_group_message_for_group(conn, group_id, message_id):
    return conn.execute("""
        SELECT
            gm.id,
            gm.group_id,
            gm.sender_id,
            u.name AS sender_name,
            gm.text,
            gm.created_at,
            gm.edited_at
        FROM group_messages gm
        JOIN users u ON u.id = gm.sender_id
        WHERE gm.id = ? AND gm.group_id = ?
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
        before_clause = "AND m.id < ?"
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
        WHERE m.chat_id = ?
          AND NOT EXISTS (
              SELECT 1
              FROM hidden_messages hm
              WHERE hm.message_id = m.id AND hm.user_id = ?
          )
          {before_clause}
        ORDER BY m.id DESC
        LIMIT ?
    """, params).fetchall()

    has_more = len(rows) > limit
    page_rows = rows[:limit]
    page_rows = list(reversed(page_rows))
    return page_rows, has_more


def fetch_group_messages_page(conn, group_id, user_id, limit, before_id=None):
    params = [group_id, user_id]
    before_clause = ""
    if before_id is not None:
        before_clause = "AND gm.id < ?"
        params.append(before_id)
    params.append(limit + 1)

    rows = conn.execute(f"""
        SELECT
            gm.id,
            gm.sender_id,
            u.name AS sender_name,
            gm.text,
            gm.created_at,
            gm.edited_at
        FROM group_messages gm
        JOIN users u ON u.id = gm.sender_id
        WHERE gm.group_id = ?
          AND NOT EXISTS (
              SELECT 1
              FROM hidden_group_messages hgm
              WHERE hgm.group_message_id = gm.id AND hgm.user_id = ?
          )
          {before_clause}
        ORDER BY gm.id DESC
        LIMIT ?
    """, params).fetchall()

    has_more = len(rows) > limit
    page_rows = rows[:limit]
    page_rows = list(reversed(page_rows))
    return page_rows, has_more


@socketio.on("connect")
def handle_connect(auth):
    token = None
    if isinstance(auth, dict):
        token = auth.get("token")

    socket_sessions[request.sid] = user_id_from_token(token)


@socketio.on("disconnect")
def handle_disconnect():
    socket_sessions.pop(request.sid, None)


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
        VALUES (?, ?)
    """, (chat_id, user_id))
    conn.execute("""
        INSERT OR IGNORE INTO hidden_messages (message_id, user_id)
        SELECT id, ?
        FROM messages
        WHERE chat_id = ?
    """, (user_id, chat_id))
    conn.commit()


@app.route("/")
def home():
    return send_from_directory(".", "login.html")


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
            VALUES (?, ?, ?, ?)
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
            "username": username
        }
    })


@app.post("/auth/login")
def login():
    data = request.json

    username = data.get("username", "").strip().replace("@", "")
    password = data.get("password", "")

    conn = get_db()
    user = conn.execute(
        "SELECT * FROM users WHERE username = ?",
        (username,)
    ).fetchone()
    conn.close()

    if not user or not check_password_hash(user["password_hash"], password):
        return jsonify({"message": "Неверный логин или пароль"}), 401

    token = secrets.token_hex(32)
    persist_token(token, user["id"])

    return jsonify({
        "token": token,
        "user": {
            "id": user["id"],
            "name": user["name"],
            "username": user["username"]
        }
    })


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
            c.id AS chat_id
        FROM users u
        LEFT JOIN chats c
            ON (
                ((c.user1_id = ? AND c.user2_id = u.id) OR (c.user2_id = ? AND c.user1_id = u.id))
                AND EXISTS (
                    SELECT 1
                    FROM messages m
                    WHERE m.chat_id = c.id
                )
                AND NOT EXISTS (
                    SELECT 1
                    FROM hidden_direct_chats hdc
                    WHERE hdc.chat_id = c.id AND hdc.user_id = ?
                )
            )
        WHERE u.username LIKE ? AND u.id != ?
        LIMIT 20
    """, (user_id, user_id, user_id, f"%{username}%", user_id)).fetchall()
    conn.close()

    return jsonify([dict(u) for u in users])


@app.get("/users/<int:target_user_id>")
def get_user(target_user_id):
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    conn = get_db()
    user = conn.execute("""
        SELECT id, name, username
        FROM users
        WHERE id = ? AND id != ?
    """, (target_user_id, user_id)).fetchone()
    conn.close()

    if not user:
        return jsonify({"message": "Пользователь не найден"}), 404

    return jsonify(dict(user))


@app.get("/chats")
def get_chats():
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    conn = get_db()
    direct_chats = conn.execute("""
        SELECT
            c.id,
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
            ) AS updated_at
        FROM chats c
        JOIN users u
            ON u.id = CASE
                WHEN c.user1_id = ? THEN c.user2_id
                ELSE c.user1_id
            END
        WHERE (c.user1_id = ? OR c.user2_id = ?)
          AND EXISTS (
              SELECT 1
              FROM messages m
              WHERE m.chat_id = c.id
          )
          AND NOT EXISTS (
              SELECT 1
              FROM hidden_direct_chats hdc
              WHERE hdc.chat_id = c.id AND hdc.user_id = ?
          )
    """, (user_id, user_id, user_id, user_id)).fetchall()

    group_chats = conn.execute("""
        SELECT
            g.id,
            g.title,
            (
                SELECT gm.text
                FROM group_messages gm
                WHERE gm.group_id = g.id
                ORDER BY gm.created_at DESC, gm.id DESC
                LIMIT 1
            ) AS last_message_text,
            (
                SELECT gm.created_at
                FROM group_messages gm
                WHERE gm.group_id = g.id
                ORDER BY gm.created_at DESC, gm.id DESC
                LIMIT 1
            ) AS updated_at
        FROM groups g
        JOIN group_members gmbr ON gmbr.group_id = g.id
        WHERE gmbr.user_id = ?
    """, (user_id,)).fetchall()
    conn.close()

    chats = [
        {
            "id": chat["id"],
            "type": "direct",
            "username": chat["username"],
            "title": chat["title"],
            "last_message": {"text": chat["last_message_text"]} if chat["last_message_text"] is not None else None,
            "updated_at": chat["updated_at"]
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
            "updated_at": group["updated_at"]
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
        "SELECT id, username, name FROM users WHERE id = ?",
        (participant_id,)
    ).fetchone()

    if not participant:
        conn.close()
        return jsonify({"message": "Пользователь не найден"}), 404

    chat = conn.execute("""
        SELECT id
        FROM chats
        WHERE user1_id = ? AND user2_id = ?
    """, (user1_id, user2_id)).fetchone()

    if not chat:
        cur = conn.cursor()
        cur.execute("""
            INSERT INTO chats (user1_id, user2_id)
            VALUES (?, ?)
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
        "updated_at": None
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
            u.username
        FROM chats c
        JOIN users u
            ON u.id = CASE
                WHEN c.user1_id = ? THEN c.user2_id
                ELSE c.user1_id
            END
        WHERE c.id = ? AND (c.user1_id = ? OR c.user2_id = ?)
    """, (user_id, chat_id, user_id, user_id)).fetchone()

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

    return jsonify({
        "id": chat["id"],
        "title": chat["username"],
        "username": chat["username"],
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

    cur = conn.cursor()
    conn.execute("DELETE FROM hidden_direct_chats WHERE chat_id = ?", (chat_id,))
    cur.execute("""
        INSERT INTO messages (chat_id, sender_id, text)
        VALUES (?, ?, ?)
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
        WHERE m.id = ?
    """, (cur.lastrowid,)).fetchone()
    conn.close()

    message_data = serialize_direct_message(message)

    socketio.emit("new_message", message_data, room=f"direct_{chat_id}")

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
            for row in conn.execute("SELECT id FROM messages WHERE chat_id = ?", (chat_id,)).fetchall()
        ]

        if message_ids:
            placeholders = ",".join("?" for _ in message_ids)
            conn.execute(f"DELETE FROM hidden_messages WHERE message_id IN ({placeholders})", message_ids)

        conn.execute("DELETE FROM hidden_direct_chats WHERE chat_id = ?", (chat_id,))
        conn.execute("DELETE FROM messages WHERE chat_id = ?", (chat_id,))
        conn.execute("DELETE FROM chats WHERE id = ?", (chat_id,))
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
        SET text = ?, edited_at = CURRENT_TIMESTAMP
        WHERE id = ? AND chat_id = ?
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

        conn.execute("DELETE FROM hidden_messages WHERE message_id = ?", (message_id,))
        conn.execute("DELETE FROM messages WHERE id = ? AND chat_id = ?", (message_id, chat_id))
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
        VALUES (?, ?)
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

    placeholders = ",".join("?" for _ in message_ids)
    message_rows = conn.execute(f"""
        SELECT id, sender_id
        FROM messages
        WHERE chat_id = ? AND id IN ({placeholders})
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
        conn.execute(f"DELETE FROM messages WHERE chat_id = ? AND id IN ({placeholders})", [chat_id, *message_ids])
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
        VALUES (?, ?)
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

    if not isinstance(member_ids, list):
        return jsonify({"message": "member_ids должен быть списком"}), 400

    conn = get_db()
    cur = conn.cursor()

    cur.execute("""
        INSERT INTO groups (title, description, owner_id)
        VALUES (?, ?, ?)
    """, (title, description, user_id))
    group_id = cur.lastrowid

    cur.execute("""
        INSERT OR IGNORE INTO group_members (group_id, user_id)
        VALUES (?, ?)
    """, (group_id, user_id))

    for member_id in member_ids:
        cur.execute("""
            INSERT OR IGNORE INTO group_members (group_id, user_id)
            VALUES (?, ?)
        """, (group_id, member_id))

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
    member = can_access_group(conn, user_id, group_id)

    if not member:
        conn.close()
        return jsonify({"message": "Группа не найдена"}), 404

    group = conn.execute("""
        SELECT id, title
        FROM groups
        WHERE id = ?
    """, (group_id,)).fetchone()

    members_count_row = conn.execute("""
        SELECT COUNT(*) AS members_count
        FROM group_members
        WHERE group_id = ?
    """, (group_id,)).fetchone()
    limit = parse_limit_arg()
    messages, has_more_messages = fetch_group_messages_page(conn, group_id, user_id, limit)
    conn.close()

    return jsonify({
        "id": group["id"],
        "title": group["title"],
        "name": group["title"],
        "members_count": members_count_row["members_count"],
        "has_more_messages": has_more_messages,
        "messages": [
            serialize_group_message(message)
            for message in messages
        ]
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

    if not text:
        conn.close()
        return jsonify({"message": "Текст сообщения обязателен"}), 400

    cur = conn.cursor()
    cur.execute("""
        INSERT INTO group_messages (group_id, sender_id, text)
        VALUES (?, ?, ?)
    """, (group_id, user_id, text))
    conn.commit()

    message = conn.execute("""
        SELECT
            gm.id,
            gm.sender_id,
            u.name AS sender_name,
            gm.text,
            gm.created_at,
            gm.edited_at
        FROM group_messages gm
        JOIN users u ON u.id = gm.sender_id
        WHERE gm.id = ?
    """, (cur.lastrowid,)).fetchone()
    conn.close()

    socketio.emit("new_message", {
        **serialize_group_message(message)
    }, room=f"group_{group_id}")

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

    if message["sender_id"] != user_id:
        conn.close()
        return jsonify({"message": "Можно редактировать только свои сообщения"}), 403

    conn.execute("""
        UPDATE group_messages
        SET text = ?, edited_at = CURRENT_TIMESTAMP
        WHERE id = ? AND group_id = ?
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

    if scope == "all":
        if message["sender_id"] != user_id:
            conn.close()
            return jsonify({"message": "Удалить у всех можно только свои сообщения"}), 403

        conn.execute("DELETE FROM hidden_group_messages WHERE group_message_id = ?", (message_id,))
        conn.execute("DELETE FROM group_messages WHERE id = ? AND group_id = ?", (message_id, group_id))
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
        VALUES (?, ?)
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

    placeholders = ",".join("?" for _ in message_ids)
    message_rows = conn.execute(f"""
        SELECT id, sender_id
        FROM group_messages
        WHERE group_id = ? AND id IN ({placeholders})
    """, [group_id, *message_ids]).fetchall()

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

        conn.execute(f"DELETE FROM hidden_group_messages WHERE group_message_id IN ({placeholders})", message_ids)
        conn.execute(f"DELETE FROM group_messages WHERE group_id = ? AND id IN ({placeholders})", [group_id, *message_ids])
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
        VALUES (?, ?)
    """, [(message_id, user_id) for message_id in message_ids])
    conn.commit()
    conn.close()
    return jsonify({"ok": True, "deleted_ids": message_ids, "scope": scope})


if __name__ == "__main__":
    init_db()
    socketio.run(app, host="0.0.0.0", port=8000, debug=True)
