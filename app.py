from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from werkzeug.security import generate_password_hash, check_password_hash
from db import get_db, init_db
import secrets

app = Flask(__name__, static_folder="assets")
CORS(app)

tokens = {}


def current_user_id():
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return None

    token = auth.replace("Bearer ", "")
    return tokens.get(token)


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


if __name__ == "__main__":
    init_db()
    app.run(host="0.0.0.0", port=8000, debug=True)
