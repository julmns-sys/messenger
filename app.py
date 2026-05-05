from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from flask_socketio import SocketIO, emit, join_room
from werkzeug.security import generate_password_hash, check_password_hash
from db import get_db, init_db
import secrets

app = Flask(__name__, static_folder="assets")
CORS(app)
socketio = SocketIO(app, cors_allowed_origins="*")

tokens = {}
socket_sessions = {}


def current_user_id():
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return None

    token = auth.replace("Bearer ", "")
    return tokens.get(token)


def user_id_from_token(token):
    if not token:
        return None
    return tokens.get(token)


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
    tokens[token] = user_id

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
    tokens[token] = user["id"]

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
        SELECT id, name, username
        FROM users
        WHERE username LIKE ? AND id != ?
        LIMIT 20
    """, (f"%{username}%", user_id)).fetchall()
    conn.close()

    return jsonify([dict(u) for u in users])


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
        WHERE c.user1_id = ? OR c.user2_id = ?
    """, (user_id, user_id, user_id)).fetchall()

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

    messages = conn.execute("""
        SELECT
            m.sender_id,
            u.name AS sender_name,
            m.text,
            m.created_at
        FROM messages m
        JOIN users u ON u.id = m.sender_id
        WHERE m.chat_id = ?
        ORDER BY m.created_at ASC, m.id ASC
    """, (chat_id,)).fetchall()
    conn.close()

    return jsonify({
        "id": chat["id"],
        "title": chat["username"],
        "username": chat["username"],
        "messages": [
            {
                "sender_id": message["sender_id"],
                "sender_name": message["sender_name"],
                "text": message["text"],
                "created_at": message["created_at"]
            }
            for message in messages
        ]
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
    cur.execute("""
        INSERT INTO messages (chat_id, sender_id, text)
        VALUES (?, ?, ?)
    """, (chat_id, user_id, text))
    conn.commit()

    message = conn.execute("""
        SELECT
            m.sender_id,
            u.name AS sender_name,
            m.text,
            m.created_at
        FROM messages m
        JOIN users u ON u.id = m.sender_id
        WHERE m.id = ?
    """, (cur.lastrowid,)).fetchone()
    conn.close()

    message_data = {
        "sender_id": message["sender_id"],
        "sender_name": message["sender_name"],
        "text": message["text"],
        "created_at": message["created_at"]
    }

    socketio.emit("new_message", message_data, room=f"direct_{chat_id}")

    return jsonify(message_data), 201


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

    messages = conn.execute("""
        SELECT
            gm.sender_id,
            u.name AS sender_name,
            gm.text,
            gm.created_at
        FROM group_messages gm
        JOIN users u ON u.id = gm.sender_id
        WHERE gm.group_id = ?
        ORDER BY gm.created_at ASC, gm.id ASC
    """, (group_id,)).fetchall()
    conn.close()

    return jsonify({
        "id": group["id"],
        "title": group["title"],
        "name": group["title"],
        "members_count": members_count_row["members_count"],
        "messages": [
            {
                "sender_id": message["sender_id"],
                "sender_name": message["sender_name"],
                "text": message["text"],
                "created_at": message["created_at"]
            }
            for message in messages
        ]
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
            gm.sender_id,
            u.name AS sender_name,
            gm.text,
            gm.created_at
        FROM group_messages gm
        JOIN users u ON u.id = gm.sender_id
        WHERE gm.id = ?
    """, (cur.lastrowid,)).fetchone()
    conn.close()

    socketio.emit("new_message", {
        "sender_id": message["sender_id"],
        "sender_name": message["sender_name"],
        "text": message["text"],
        "created_at": message["created_at"]
    }, room=f"group_{group_id}")

    return jsonify({"message": "ok"})


if __name__ == "__main__":
    init_db()
    socketio.run(app, host="0.0.0.0", port=8000, debug=True)
