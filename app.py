from datetime import date, datetime, timedelta, timezone
from html import unescape
import hashlib
import json
import os
from pathlib import Path

import re
import shutil
import smtplib
from threading import Lock
import uuid
import json
from email.message import EmailMessage
from email.utils import formataddr
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from flask import Flask, request, jsonify, send_from_directory, redirect, render_template, g
from flask_cors import CORS
from flask_socketio import SocketIO, emit, join_room
from dotenv import load_dotenv
from werkzeug.security import generate_password_hash, check_password_hash
from db import get_db, init_db
import secrets

load_dotenv()

app = Flask(__name__, static_folder="assets")
CORS(app)
socketio = SocketIO(app, cors_allowed_origins="*")

socket_sessions = {}
user_last_seen = {}
typing_sessions = {}
link_preview_cache = {}
runtime_init_lock = Lock()
runtime_initialized = False
LINK_PREVIEW_TIMEOUT = 4
MESSAGE_URL_PATTERN = re.compile(r"((?:https?://|www\.)[^\s<]+)", flags=re.IGNORECASE)
INVITE_URL_PATTERN = re.compile(r"(?:https?://[^\s<]+)?/(?:invite|server-invite)/[A-Za-z0-9_-]+/?", flags=re.IGNORECASE)
BASE_DIR = Path(__file__).resolve().parent
VOICE_UPLOAD_DIR = BASE_DIR / "assets" / "uploads" / "voice"
PHOTO_UPLOAD_DIR = BASE_DIR / "assets" / "uploads" / "photos"
MESSAGE_IMAGE_UPLOAD_DIR = BASE_DIR / "assets" / "uploads" / "messages"
STICKER_LIBRARY_DIR = BASE_DIR / "assets" / "stickers"
STICKER_UPLOAD_DIR = STICKER_LIBRARY_DIR / "uploads" / "packs"
DEFAULT_STICKER_MANIFEST_PATH = STICKER_LIBRARY_DIR / "default" / "manifest.json"
VOICE_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
PHOTO_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
MESSAGE_IMAGE_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
STICKER_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
PHOTO_MESSAGES_ENABLED = str(os.getenv("PHOTO_MESSAGES_ENABLED", "1") or "1").strip().lower() not in {"0", "false", "off", "no"}
VOICE_EXTENSIONS_BY_MIME = {
    "audio/webm": ".webm",
    "audio/ogg": ".ogg",
    "audio/mp4": ".m4a",
    "audio/x-m4a": ".m4a",
    "audio/mpeg": ".mp3",
    "audio/mp3": ".mp3",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
}
PHOTO_EXTENSIONS_BY_MIME = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
}
STICKER_EXTENSIONS_BY_MIME = {
    "image/png": ".png",
    "image/webp": ".webp",
}
MESSAGE_IMAGE_EXTENSIONS_BY_MIME = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
}
GENERIC_MESSAGE_ATTACHMENT_EXTENSION_BY_MIME = {
    "application/pdf": ".pdf",
    "application/zip": ".zip",
    "application/x-zip-compressed": ".zip",
    "application/json": ".json",
    "text/plain": ".txt",
    "text/csv": ".csv",
}
MAX_STICKER_FILE_BYTES = 1 * 1024 * 1024
MAX_MESSAGE_IMAGE_FILE_BYTES = 5 * 1024 * 1024
MAX_MESSAGE_ATTACHMENT_FILE_BYTES = 20 * 1024 * 1024
SYSTEM_USERNAME = "chatik"
SYSTEM_NAME = "Chatik"
SYSTEM_EMAIL = "chatik@system.local"
SYSTEM_BIO = "Системный аккаунт для обновлений и уведомлений безопасности."
SYSTEM_PASSWORD_PLACEHOLDER = "chatik-system-account"
ROLE_USER = "user"
ROLE_ADMIN = "admin"
ROLE_SYSTEM_OWNER = "system_owner"
SYSTEM_OWNER_USERNAME = str(os.getenv("SYSTEM_OWNER_USERNAME", "owner") or "owner").strip().replace("@", "")
SYSTEM_OWNER_NAME = str(os.getenv("SYSTEM_OWNER_NAME", "Messenger Owner") or "Messenger Owner").strip() or "Messenger Owner"
SYSTEM_OWNER_EMAIL = str(os.getenv("SYSTEM_OWNER_EMAIL", "owner@system.local") or "owner@system.local").strip()
SYSTEM_OWNER_PASSWORD = str(os.getenv("SYSTEM_OWNER_PASSWORD", "change-me-owner") or "change-me-owner")
GLOBAL_FILES_SETTING_KEY = "global_file_uploads_enabled"
GLOBAL_STICKERS_SETTING_KEY = "global_stickers_enabled"
EMAIL_VERIFICATION_CODE_TTL_MINUTES = 10
EMAIL_VERIFICATION_RESEND_INTERVAL_SECONDS = 60
SMTP_HOST = str(os.getenv("SMTP_HOST", "") or "").strip()
SMTP_PORT = int(str(os.getenv("SMTP_PORT", "0") or "0").strip() or 0)
SMTP_USER = str(os.getenv("SMTP_USER", "") or "").strip()
SMTP_PASSWORD = str(os.getenv("SMTP_PASSWORD", "") or "").strip()
SMTP_FROM = str(os.getenv("SMTP_FROM", "") or "").strip()
EMAIL_DEV_MODE = str(os.getenv("EMAIL_DEV_MODE", "false") or "false").strip().lower() in {"1", "true", "yes", "on"}
EMAIL_VERIFICATION_REQUIRED = str(os.getenv("EMAIL_VERIFICATION_REQUIRED", "true") or "true").strip().lower() in {"1", "true", "yes", "on"}
SMTP_TIMEOUT_SECONDS = max(5, int(str(os.getenv("SMTP_TIMEOUT_SECONDS", "15") or "15").strip() or 15))
EMAIL_ADDRESS_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
MIN_PASSWORD_LENGTH = 6


@app.context_processor
def inject_feature_flags():
    return {
        "photo_messages_enabled": PHOTO_MESSAGES_ENABLED,
        "global_file_uploads_enabled": is_global_file_uploads_enabled(),
        "global_stickers_enabled": is_global_stickers_enabled()
    }


def ensure_photo_messages_enabled():
    if not PHOTO_MESSAGES_ENABLED:
        raise PermissionError("Отправка фото временно отключена")


def read_runtime_setting(conn, key, default=""):
    row = conn.execute("""
        SELECT setting_value
        FROM app_runtime_settings
        WHERE setting_key = %s
        LIMIT 1
    """, (key,)).fetchone()
    if not row:
        return default
    return row_value(row, "setting_value", default)


def write_runtime_setting(conn, key, value):
    conn.execute("""
        INSERT INTO app_runtime_settings (setting_key, setting_value)
        VALUES (%s, %s)
        ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)
    """, (key, value))


def is_global_file_uploads_enabled():
    conn = get_db()
    try:
        raw_value = read_runtime_setting(conn, GLOBAL_FILES_SETTING_KEY, "1")
        return str(raw_value or "1").strip().lower() not in {"0", "false", "off", "no"}
    finally:
        conn.close()


def ensure_global_file_uploads_enabled():
    if not is_global_file_uploads_enabled():
        raise PermissionError("Отправка файлов по всему мессенджеру отключена")


def is_global_stickers_enabled():
    conn = get_db()
    try:
        raw_value = read_runtime_setting(conn, GLOBAL_STICKERS_SETTING_KEY, "1")
        return str(raw_value or "1").strip().lower() not in {"0", "false", "off", "no"}
    finally:
        conn.close()


def ensure_global_stickers_enabled():
    if not is_global_stickers_enabled():
        raise PermissionError("Отправка стикеров по всему мессенджеру отключена")


def ensure_runtime_initialized():
    global runtime_initialized
    if runtime_initialized:
        return

    with runtime_init_lock:
        if runtime_initialized:
            return
        init_db()
        bootstrap_system_account()
        bootstrap_system_owner_account()
        ensure_default_sticker_pack()
        runtime_initialized = True


@app.before_request
def initialize_runtime_before_request():
    ensure_runtime_initialized()
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return None

    token = auth.replace("Bearer ", "", 1).strip()
    user_id = lookup_user_id_by_token(token)
    if not user_id:
        return None

    conn = get_db()
    try:
        user = fetch_user_auth_state(conn, user_id)
    finally:
        conn.close()

    if not user:
        return None

    g.current_user = user
    if is_ban_active(user):
        return jsonify({"message": "Аккаунт заблокирован"}), 403
    return None


def utcnow():
    return datetime.now(timezone.utc)


def to_db_datetime(value):
    if not isinstance(value, datetime):
        return value
    normalized = value.astimezone(timezone.utc) if value.tzinfo else value.replace(tzinfo=timezone.utc)
    return normalized.replace(tzinfo=None)


def generate_email_verification_code():
    return f"{secrets.randbelow(1_000_000):06d}"


def build_email_verification_expiry():
    return utcnow() + timedelta(minutes=EMAIL_VERIFICATION_CODE_TTL_MINUTES)


def build_email_verification_hash(code):
    return generate_password_hash(str(code))


def build_email_verification_payload():
    code = generate_email_verification_code()
    expires_at = build_email_verification_expiry()
    return code, build_email_verification_hash(code), expires_at


def validate_email_address(value):
    email = str(value or "").strip()
    if not email or len(email) > 255 or not EMAIL_ADDRESS_PATTERN.fullmatch(email):
        raise ValueError("Укажите корректный email")
    return email


def validate_password_value(value):
    password = str(value or "")
    if len(password) < MIN_PASSWORD_LENGTH:
        raise ValueError(f"Пароль должен содержать минимум {MIN_PASSWORD_LENGTH} символов")
    return password


def get_verification_sent_at_from_expiry(expires_at):
    parsed_expires_at = parse_datetime_value(expires_at)
    if not parsed_expires_at:
        return None
    return parsed_expires_at - timedelta(minutes=EMAIL_VERIFICATION_CODE_TTL_MINUTES)


def get_email_verification_sent_at(user):
    return get_verification_sent_at_from_expiry(row_value(user, "email_verification_expires_at"))


def get_change_request_retry_after_seconds(expires_at):
    sent_at = get_verification_sent_at_from_expiry(expires_at)
    if not sent_at:
        return 0
    remaining = EMAIL_VERIFICATION_RESEND_INTERVAL_SECONDS - int((utcnow() - sent_at).total_seconds())
    return max(0, remaining)


def get_email_verification_retry_after_seconds(user):
    sent_at = get_email_verification_sent_at(user)
    if not sent_at:
        return 0
    remaining = EMAIL_VERIFICATION_RESEND_INTERVAL_SECONDS - int((utcnow() - sent_at).total_seconds())
    return max(0, remaining)


def ensure_smtp_configured():
    missing = [
        key for key, value in {
            "SMTP_HOST": SMTP_HOST,
            "SMTP_PORT": SMTP_PORT,
            "SMTP_USER": SMTP_USER,
            "SMTP_PASSWORD": SMTP_PASSWORD,
            "SMTP_FROM": SMTP_FROM,
        }.items() if not value
    ]
    if missing:
        raise RuntimeError("SMTP не настроен")


def send_email_message(message):
    ensure_smtp_configured()
    try:
        if SMTP_PORT == 465:
            with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, timeout=SMTP_TIMEOUT_SECONDS) as smtp:
                smtp.login(SMTP_USER, SMTP_PASSWORD)
                smtp.send_message(message)
            return

        with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=SMTP_TIMEOUT_SECONDS) as smtp:
            smtp.ehlo()
            if SMTP_PORT == 587 or smtp.has_extn("starttls"):
                smtp.starttls()
                smtp.ehlo()
            smtp.login(SMTP_USER, SMTP_PASSWORD)
            smtp.send_message(message)
    except (OSError, smtplib.SMTPException) as exc:
        print(
            f"[EMAIL SMTP] failed via {SMTP_HOST}:{SMTP_PORT}: {exc}",
            flush=True,
        )
        raise RuntimeError("Не удалось отправить email через SMTP") from exc


def send_email_verification_code(email, code):
    send_email_action_code(
        email,
        code,
        subject="Код подтверждения email для /Chatik",
        intro="Ваш код подтверждения",
        fallback_note="Если вы не регистрировались в /Chatik, просто проигнорируйте это письмо."
    )


def send_email_action_code(email, code, *, subject, intro, fallback_note):
    if EMAIL_DEV_MODE:
        print(f"[EMAIL DEV MODE] {subject} for {email}: {code}", flush=True)
        return

    message = EmailMessage()
    message["Subject"] = subject
    message["From"] = formataddr(("Chatik", SMTP_FROM))
    message["To"] = email
    message.set_content(
        f"{intro}: {code}\n\n"
        f"Код действует {EMAIL_VERIFICATION_CODE_TTL_MINUTES} минут.\n"
        f"{fallback_note}\n"
    )
    send_email_message(message)


def is_email_verification_required():
    return EMAIL_VERIFICATION_REQUIRED


def is_user_email_verified(user):
    if not is_email_verification_required():
        return True
    return bool(row_value(user, "email_verified", False))


def mark_user_email_verified(conn, user_id):
    conn.execute("""
        UPDATE users
        SET email_verified = 1,
            email_verification_code_hash = NULL,
            email_verification_expires_at = NULL
        WHERE id = %s
    """, (user_id,))


def issue_auth_payload(user):
    token = secrets.token_hex(32)
    persist_token(token, user["id"])
    return {
        "token": token,
        "user": serialize_user_profile(user)
    }


def format_timestamp(value):
    if isinstance(value, datetime):
        normalized = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
        return normalized.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    if isinstance(value, date):
        return value.isoformat()
    return value


def collapse_spaces(value):
    return re.sub(r"\s+", " ", str(value or "")).strip()


def strip_html_tags(value):
    return re.sub(r"<[^>]+>", " ", str(value or ""))


def extract_meta_content(html, names):
    for name in names:
        patterns = [
            rf'<meta[^>]+property=["\']{re.escape(name)}["\'][^>]+content=["\']([^"\']+)["\']',
            rf'<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']{re.escape(name)}["\']',
            rf'<meta[^>]+name=["\']{re.escape(name)}["\'][^>]+content=["\']([^"\']+)["\']',
            rf'<meta[^>]+content=["\']([^"\']+)["\'][^>]+name=["\']{re.escape(name)}["\']',
        ]
        for pattern in patterns:
            match = re.search(pattern, html, flags=re.IGNORECASE)
            if match:
                return collapse_spaces(unescape(strip_html_tags(match.group(1))))
    return ""


def extract_html_title(html):
    match = re.search(r"<title[^>]*>(.*?)</title>", html, flags=re.IGNORECASE | re.DOTALL)
    if not match:
        return ""
    return collapse_spaces(unescape(strip_html_tags(match.group(1))))


def normalize_preview_url(raw_url):
    value = str(raw_url or "").strip()
    if not value:
        return ""
    if value.startswith("www."):
        value = f"https://{value}"
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return ""
    return value


def extract_message_preview(text):
    source = str(text or "").strip()
    if not source:
        return None

    match = MESSAGE_URL_PATTERN.search(source)
    if not match:
        return None

    normalized_url = normalize_preview_url(match.group(1))
    if not normalized_url:
        return None

    try:
        return build_link_preview(normalized_url)
    except Exception:
        return {
            "url": normalized_url,
            "domain": urlparse(normalized_url).netloc,
            "title": urlparse(normalized_url).netloc,
            "description": "",
            "site_name": ""
        }


def serialize_message_link_preview(message):
    preview_url = row_value(message, "preview_url", "")
    if not preview_url:
        return None

    preview = {
        "url": preview_url,
        "domain": urlparse(preview_url).netloc,
        "title": row_value(message, "preview_title", "") or urlparse(preview_url).netloc,
        "description": row_value(message, "preview_description", "") or "",
        "site_name": row_value(message, "preview_site_name", "") or ""
    }
    return preview


def parse_duration_ms(raw_value, default=0):
    try:
        value = int(raw_value)
    except (TypeError, ValueError):
        return default
    return max(0, min(value, 60 * 60 * 1000))


def serialize_message_audio(message):
    audio_url = row_value(message, "audio_url", "")
    if not audio_url:
        return None

    return {
        "url": audio_url,
        "mime_type": row_value(message, "audio_mime_type", "") or "audio/webm",
        "duration_ms": parse_duration_ms(row_value(message, "audio_duration_ms", 0))
    }


def serialize_message_image(message):
    image_url = row_value(message, "image_url", "")
    if not image_url:
        return None

    return {
        "url": image_url,
        "mime_type": row_value(message, "image_mime_type", "") or "image/jpeg"
    }


def message_has_image_attachments(message):
    attachments = row_value(message, "_attachments", None)
    if isinstance(attachments, list) and attachments:
        return True
    return bool(row_value(message, "has_attachments", False))


def serialize_message_attachments(message):
    attachments = row_value(message, "_attachments", None)
    if isinstance(attachments, list) and attachments:
        return [
            {
                "id": int(row_value(attachment, "id", 0) or 0),
                "url": row_value(attachment, "file_url", "") or row_value(attachment, "url", ""),
                "file_name": row_value(attachment, "file_name", "") or "",
                "mime_type": row_value(attachment, "mime_type", "") or "image/jpeg",
                "size": int(row_value(attachment, "size", 0) or 0),
                "created_at": format_timestamp(row_value(attachment, "created_at"))
            }
            for attachment in attachments
            if row_value(attachment, "file_url", "") or row_value(attachment, "url", "")
        ]

    legacy_image = serialize_message_image(message)
    if not legacy_image:
        return []

    return [{
        "id": None,
        "url": legacy_image["url"],
        "file_name": "",
        "mime_type": legacy_image["mime_type"],
        "size": 0,
        "created_at": format_timestamp(row_value(message, "created_at"))
    }]


def fetch_message_attachments_map(conn, message_scope, message_ids):
    normalized_scope = str(message_scope or "").strip().lower()
    normalized_ids = []
    seen_ids = set()
    for raw_message_id in message_ids or []:
        try:
            message_id = int(raw_message_id)
        except (TypeError, ValueError):
            continue
        if message_id <= 0 or message_id in seen_ids:
            continue
        seen_ids.add(message_id)
        normalized_ids.append(message_id)

    if normalized_scope not in {"direct", "group"} or not normalized_ids:
        return {}

    placeholders = ",".join("%s" for _ in normalized_ids)
    rows = conn.execute(f"""
        SELECT id, message_id, file_url, file_name, mime_type, size, created_at
        FROM message_attachments
        WHERE message_scope = %s
          AND message_id IN ({placeholders})
        ORDER BY id ASC
    """, [normalized_scope, *normalized_ids]).fetchall()

    attachments_map = {message_id: [] for message_id in normalized_ids}
    for row in rows:
        attachments_map.setdefault(int(row["message_id"]), []).append(row)
    return attachments_map


def attach_message_attachments(conn, message_scope, messages):
    if isinstance(messages, dict):
        message_list = [messages]
    else:
        message_list = [message for message in (messages or []) if message]

    if not message_list:
        return messages

    attachments_map = fetch_message_attachments_map(conn, message_scope, [row_value(message, "id", 0) for message in message_list])
    for message in message_list:
        message["_attachments"] = attachments_map.get(int(row_value(message, "id", 0) or 0), [])
        message["has_attachments"] = bool(message["_attachments"])
    return messages


def insert_message_attachments(conn, message_scope, message_id, attachments):
    rows = []
    normalized_scope = str(message_scope or "").strip().lower()
    try:
        normalized_message_id = int(message_id)
    except (TypeError, ValueError):
        return

    for attachment in attachments or []:
        file_url = str(attachment.get("url") or "").strip()
        if not file_url:
            continue
        rows.append((
            normalized_scope,
            normalized_message_id,
            file_url,
            str(attachment.get("file_name") or "photo")[:255],
            str(attachment.get("mime_type") or "image/jpeg")[:120],
            int(attachment.get("size") or 0)
        ))

    if not rows:
        return

    conn.executemany("""
        INSERT INTO message_attachments (
            message_scope,
            message_id,
            file_url,
            file_name,
            mime_type,
            size
        )
        VALUES (%s, %s, %s, %s, %s, %s)
    """, rows)


def fetch_attachment_urls_for_messages(conn, message_scope, message_ids):
    attachments_map = fetch_message_attachments_map(conn, message_scope, message_ids)
    urls = []
    for attachments in attachments_map.values():
        for attachment in attachments:
            file_url = str(row_value(attachment, "file_url", "") or "").strip()
            if file_url:
                urls.append(file_url)
    return urls


def delete_message_attachments(conn, message_scope, message_ids):
    normalized_scope = str(message_scope or "").strip().lower()
    normalized_ids = []
    for raw_message_id in message_ids or []:
        try:
            message_id = int(raw_message_id)
        except (TypeError, ValueError):
            continue
        if message_id > 0:
            normalized_ids.append(message_id)
    if normalized_scope not in {"direct", "group"} or not normalized_ids:
        return

    placeholders = ",".join("%s" for _ in normalized_ids)
    conn.execute(f"""
        DELETE FROM message_attachments
        WHERE message_scope = %s
          AND message_id IN ({placeholders})
    """, [normalized_scope, *normalized_ids])


def serialize_message_sticker(message):
    sticker_id = row_value(message, "sticker_id")
    sticker_path = row_value(message, "sticker_asset_path", "")
    if not sticker_id and not sticker_path:
        return None

    try:
        normalized_sticker_id = int(sticker_id) if sticker_id is not None else None
    except (TypeError, ValueError):
        normalized_sticker_id = None

    return {
        "id": normalized_sticker_id,
        "url": sticker_path or None
    }


def serialize_message_forwarded_from(message):
    forwarded_from_sender_name = row_value(message, "forwarded_from_sender_name", "")
    forwarded_from_user_id = row_value(message, "forwarded_from_user_id")
    if not forwarded_from_sender_name and not forwarded_from_user_id:
        return None

    try:
        normalized_user_id = int(forwarded_from_user_id) if forwarded_from_user_id is not None else None
    except (TypeError, ValueError):
        normalized_user_id = None

    return {
        "user_id": normalized_user_id,
        "sender_name": forwarded_from_sender_name or "Пользователь"
    }


def serialize_message_forwarded_dialog(message):
    raw_payload = row_value(message, "forwarded_dialog_payload", "")
    if not raw_payload:
        return None

    try:
        parsed_payload = json.loads(raw_payload)
    except (TypeError, ValueError, json.JSONDecodeError):
        return None

    raw_items = parsed_payload.get("items", [])
    if not isinstance(raw_items, list) or not raw_items:
        return None

    items = []
    for raw_item in raw_items:
        if not isinstance(raw_item, dict):
            continue

        try:
            original_message_id = int(raw_item.get("original_message_id") or 0)
        except (TypeError, ValueError):
            original_message_id = 0

        try:
            original_sender_id = int(raw_item.get("original_sender_id") or 0)
        except (TypeError, ValueError):
            original_sender_id = 0

        items.append({
            "original_message_id": original_message_id,
            "original_sender_id": original_sender_id,
            "original_sender_name": str(raw_item.get("original_sender_name") or "Пользователь")[:255],
            "text": str(raw_item.get("text") or "")[:4000],
            "created_at": format_timestamp(raw_item.get("created_at")),
            "side": "outgoing" if str(raw_item.get("side") or "").strip().lower() == "outgoing" else "incoming",
            "message_type": str(raw_item.get("message_type") or "text")[:32]
        })

    if not items:
        return None

    return {
        "title": str(parsed_payload.get("title") or "Пересланный диалог")[:120],
        "items": items,
        "total_count": len(items)
    }


def serialize_message_reply(message):
    reply_to_message_id = row_value(message, "reply_to_message_id")
    if not reply_to_message_id:
        return None

    return {
        "message_id": int(reply_to_message_id),
        "sender_name": row_value(message, "reply_preview_sender_name", "") or "Сообщение",
        "text": row_value(message, "reply_preview_text", "") or "",
        "message_type": row_value(message, "reply_preview_message_type", "text") or "text"
    }


def build_forwarded_from_payload(message):
    existing_forward = serialize_message_forwarded_from(message)
    if existing_forward:
        return {
            "forwarded_from_user_id": existing_forward["user_id"],
            "forwarded_from_sender_name": str(existing_forward["sender_name"] or "Пользователь")[:255]
        }

    sender_name = row_value(message, "sender_name", "") or "Пользователь"
    sender_id = row_value(message, "sender_id")
    try:
        normalized_sender_id = int(sender_id) if sender_id is not None else None
    except (TypeError, ValueError):
        normalized_sender_id = None

    return {
        "forwarded_from_user_id": normalized_sender_id,
        "forwarded_from_sender_name": str(sender_name)[:255]
    }


def clone_forwarded_audio(message):
    audio = serialize_message_audio(message)
    if not audio:
        return None

    source_path = next(iter_voice_file_paths([audio["url"]]), None)
    if not source_path or not source_path.exists():
        raise ValueError("Не удалось переслать голосовое сообщение")

    extension = source_path.suffix or ".webm"
    filename = f"{uuid.uuid4().hex}{extension}"
    destination_path = VOICE_UPLOAD_DIR / filename
    shutil.copy2(source_path, destination_path)
    return {
        "url": f"/assets/uploads/voice/{filename}",
        "mime_type": audio["mime_type"],
        "duration_ms": audio["duration_ms"]
    }


def clone_forwarded_image(message):
    image = serialize_message_image(message)
    if not image:
        return None

    source_path = next(iter_photo_file_paths([image["url"]]), None)
    if not source_path or not source_path.exists():
        raise ValueError("Не удалось переслать фотографию")

    extension = source_path.suffix or ".jpg"
    filename = f"{uuid.uuid4().hex}{extension}"
    destination_path = PHOTO_UPLOAD_DIR / filename
    shutil.copy2(source_path, destination_path)
    return {
        "url": f"/assets/uploads/photos/{filename}",
        "mime_type": image["mime_type"]
    }


def clone_forwarded_sticker(message):
    sticker = serialize_message_sticker(message)
    if not sticker:
        return None

    return {
        "id": sticker["id"],
        "url": sticker["url"]
    }


def get_forwarded_dialog_item_text(message):
    message_type = row_value(message, "message_type", "text") or "text"
    if message_type == "voice":
        return "Голосовое сообщение"
    if message_type == "photo":
        return "Фотография"
    if message_type == "sticker":
        return "Стикер"
    if message_has_image_attachments(message) and not (row_value(message, "text", "") or "").strip():
        return "Фотография"
    return row_value(message, "text", "") or ""


def build_forwarded_dialog_payload(messages, owner_user_id):
    items = []

    for message in sorted(messages or [], key=lambda item: int(row_value(item, "id", 0) or 0)):
        message_type = row_value(message, "message_type", "text") or "text"
        if message_type == "system":
            raise ValueError("Системные сообщения нельзя пересылать как диалог")
        if message_type not in {"text", "voice", "photo", "sticker"}:
            raise ValueError("Некоторые выбранные сообщения нельзя переслать как диалог")

        original_sender_id = int(row_value(message, "sender_id", 0) or 0)
        items.append({
            "original_message_id": int(row_value(message, "id", 0) or 0),
            "original_sender_id": original_sender_id,
            "original_sender_name": str(row_value(message, "sender_name", "") or "Пользователь")[:255],
            "text": get_forwarded_dialog_item_text(message),
            "created_at": format_timestamp(row_value(message, "created_at")),
            "side": "outgoing" if original_sender_id == int(owner_user_id or 0) else "incoming",
            "message_type": message_type
        })

    if len(items) < 2:
        raise ValueError("Нужно выбрать минимум два сообщения")

    return {
        "title": "Пересланный диалог",
        "items": items
    }


def build_reply_preview_payload(reply_message):
    if not reply_message:
        return None

    reply_message_type = row_value(reply_message, "message_type", "text") or "text"
    if reply_message_type == "text" and message_has_image_attachments(reply_message):
        reply_message_type = "photo"
    if reply_message_type == "voice":
        reply_preview_text = "Голосовое сообщение"
    elif reply_message_type == "photo":
        reply_preview_text = "Фотография"
    elif reply_message_type == "sticker":
        reply_preview_text = "Стикер"
    elif reply_message_type == "system":
        reply_preview_text = row_value(reply_message, "text", "") or "Системное сообщение"
    else:
        reply_preview_text = row_value(reply_message, "text", "") or "Сообщение"

    return {
        "reply_to_message_id": int(row_value(reply_message, "id", 0) or 0),
        "reply_preview_text": str(reply_preview_text)[:1000],
        "reply_preview_sender_name": (row_value(reply_message, "sender_name", "") or "Сообщение")[:255],
        "reply_preview_message_type": reply_message_type[:32]
    }


def get_direct_reply_target(conn, chat_id, reply_to_message_id):
    try:
        target_message_id = int(reply_to_message_id)
    except (TypeError, ValueError):
        return None
    if target_message_id <= 0:
        return None

    return conn.execute("""
        SELECT
            m.id,
            m.text,
            m.message_type,
            EXISTS (
                SELECT 1
                FROM message_attachments ma
                WHERE ma.message_scope = 'direct' AND ma.message_id = m.id
            ) AS has_attachments,
            u.name AS sender_name
        FROM messages m
        JOIN users u ON u.id = m.sender_id
        WHERE m.id = %s AND m.chat_id = %s
        LIMIT 1
    """, (target_message_id, chat_id)).fetchone()


def get_group_reply_target(conn, group_id, reply_to_message_id):
    try:
        target_message_id = int(reply_to_message_id)
    except (TypeError, ValueError):
        return None
    if target_message_id <= 0:
        return None

    return conn.execute("""
        SELECT
            gm.id,
            gm.text,
            gm.message_type,
            EXISTS (
                SELECT 1
                FROM message_attachments ma
                WHERE ma.message_scope = 'group' AND ma.message_id = gm.id
            ) AS has_attachments,
            u.name AS sender_name
        FROM group_messages gm
        JOIN users u ON u.id = gm.sender_id
        WHERE gm.id = %s AND gm.group_id = %s
        LIMIT 1
    """, (target_message_id, group_id)).fetchone()


def ensure_message_preview_data(conn, table_name, message):
    if not message:
        return False

    if row_value(message, "preview_url"):
        return False

    preview = extract_message_preview(row_value(message, "text", ""))
    if not preview:
        return False

    message["preview_url"] = preview["url"]
    message["preview_title"] = preview["title"][:255]
    message["preview_description"] = preview["description"][:500]
    message["preview_site_name"] = preview["site_name"][:255]

    if conn and row_value(message, "id"):
        conn.execute(f"""
            UPDATE {table_name}
            SET
                preview_url = %s,
                preview_title = %s,
                preview_description = %s,
                preview_site_name = %s
            WHERE id = %s
        """, (
            message["preview_url"],
            message["preview_title"],
            message["preview_description"],
            message["preview_site_name"],
            message["id"]
        ))

    return True


def ensure_message_preview_data_many(conn, table_name, messages):
    touched = False
    for message in messages or []:
        if ensure_message_preview_data(conn, table_name, message):
            touched = True
    if touched and conn:
        conn.commit()
    return messages


def build_link_preview(url):
    normalized_url = normalize_preview_url(url)
    if not normalized_url:
        return None

    cached = link_preview_cache.get(normalized_url)
    if cached:
        return cached

    request_headers = {
        "User-Agent": "ChatikLinkPreview/1.0",
        "Accept-Language": "ru,en;q=0.8"
    }
    req = Request(normalized_url, headers=request_headers)
    with urlopen(req, timeout=LINK_PREVIEW_TIMEOUT) as response:
        content_type = response.headers.get("Content-Type", "")
        if "text/html" not in content_type:
            preview = {
                "url": normalized_url,
                "domain": urlparse(normalized_url).netloc,
                "title": urlparse(normalized_url).netloc,
                "description": "",
                "site_name": ""
            }
            link_preview_cache[normalized_url] = preview
            return preview

        charset = response.headers.get_content_charset() or "utf-8"
        raw_html = response.read(65536)
        html = raw_html.decode(charset, errors="replace")

    title = extract_meta_content(html, ["og:title", "twitter:title"]) or extract_html_title(html) or urlparse(normalized_url).netloc
    description = extract_meta_content(html, ["og:description", "description", "twitter:description"])
    site_name = extract_meta_content(html, ["og:site_name"])
    preview = {
        "url": normalized_url,
        "domain": urlparse(normalized_url).netloc,
        "title": title[:180],
        "description": description[:280],
        "site_name": site_name[:120]
    }
    link_preview_cache[normalized_url] = preview
    return preview


def save_voice_upload(uploaded_file):
    if not uploaded_file or not uploaded_file.filename:
        raise ValueError("Файл голосового сообщения не найден")

    mime_type = str(uploaded_file.mimetype or "").split(";", 1)[0].strip().lower()
    if not mime_type.startswith("audio/"):
        raise ValueError("Поддерживаются только аудиофайлы")

    extension = VOICE_EXTENSIONS_BY_MIME.get(mime_type) or Path(uploaded_file.filename).suffix.lower() or ".webm"
    filename = f"{uuid.uuid4().hex}{extension}"
    VOICE_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    target_path = VOICE_UPLOAD_DIR / filename
    try:
        uploaded_file.save(target_path)
    except OSError as error:
        print(f"[VOICE UPLOAD] failed to save {target_path}: {error}", flush=True)
        raise RuntimeError("Не удалось сохранить голосовое сообщение") from error
    return {
        "url": f"/assets/uploads/voice/{filename}",
        "mime_type": mime_type
    }


def save_photo_upload(uploaded_file):
    if not PHOTO_MESSAGES_ENABLED:
        raise ValueError("Отправка фото временно отключена")
    if not uploaded_file or not uploaded_file.filename:
        raise ValueError("Файл фотографии не найден")

    mime_type = str(uploaded_file.mimetype or "").split(";", 1)[0].strip().lower()
    if mime_type not in PHOTO_EXTENSIONS_BY_MIME:
        raise ValueError("Поддерживаются только JPG, PNG, WEBP и GIF")

    extension = PHOTO_EXTENSIONS_BY_MIME.get(mime_type) or Path(uploaded_file.filename).suffix.lower() or ".jpg"
    filename = f"{uuid.uuid4().hex}{extension}"
    uploaded_file.save(PHOTO_UPLOAD_DIR / filename)
    return {
        "url": f"/assets/uploads/photos/{filename}",
        "mime_type": mime_type
    }


def save_message_image_upload(uploaded_file):
    if not uploaded_file or not uploaded_file.filename:
        raise ValueError("Файл фотографии не найден")

    mime_type = str(uploaded_file.mimetype or "").split(";", 1)[0].strip().lower()
    if mime_type not in MESSAGE_IMAGE_EXTENSIONS_BY_MIME:
        raise ValueError("Поддерживаются только JPG, PNG и WEBP")

    stream = getattr(uploaded_file, "stream", None)
    if stream is not None:
        current_position = stream.tell()
        stream.seek(0, os.SEEK_END)
        file_size = int(stream.tell() or 0)
        stream.seek(current_position)
    else:
        file_size = 0

    if file_size <= 0:
        raise ValueError("Файл фотографии пустой")
    if file_size > MAX_MESSAGE_IMAGE_FILE_BYTES:
        raise ValueError("Размер изображения не должен превышать 5 MB")

    original_name = Path(str(uploaded_file.filename or "photo")).name or "photo"
    extension = MESSAGE_IMAGE_EXTENSIONS_BY_MIME[mime_type]
    filename = f"{uuid.uuid4().hex}{extension}"
    destination_path = MESSAGE_IMAGE_UPLOAD_DIR / filename
    try:
        uploaded_file.save(destination_path)
    except OSError as error:
        print(f"[MESSAGE IMAGE UPLOAD] failed to save {destination_path}: {error}", flush=True)
        raise RuntimeError("Не удалось сохранить изображение") from error

    return {
        "url": f"/assets/uploads/messages/{filename}",
        "file_name": original_name[:255],
        "mime_type": mime_type,
        "size": file_size
    }


def save_message_attachment_upload(uploaded_file):
    if not uploaded_file or not uploaded_file.filename:
        raise ValueError("Файл вложения не найден")

    mime_type = str(uploaded_file.mimetype or "").split(";", 1)[0].strip().lower() or "application/octet-stream"
    stream = getattr(uploaded_file, "stream", None)
    if stream is not None:
        current_position = stream.tell()
        stream.seek(0, os.SEEK_END)
        file_size = int(stream.tell() or 0)
        stream.seek(current_position)
    else:
        file_size = 0

    if file_size <= 0:
        raise ValueError("Файл вложения пустой")
    if file_size > MAX_MESSAGE_ATTACHMENT_FILE_BYTES:
        raise ValueError("Размер файла не должен превышать 20 MB")

    original_name = Path(str(uploaded_file.filename or "file")).name or "file"
    original_extension = Path(original_name).suffix.lower()
    extension = (
        original_extension[:16]
        if re.fullmatch(r"\.[a-z0-9]{1,15}", original_extension)
        else GENERIC_MESSAGE_ATTACHMENT_EXTENSION_BY_MIME.get(mime_type, ".bin")
    )
    filename = f"{uuid.uuid4().hex}{extension}"
    destination_path = MESSAGE_IMAGE_UPLOAD_DIR / filename
    try:
        uploaded_file.save(destination_path)
    except OSError as error:
        print(f"[MESSAGE ATTACHMENT UPLOAD] failed to save {destination_path}: {error}", flush=True)
        raise RuntimeError("Не удалось сохранить файл") from error

    return {
        "url": f"/assets/uploads/messages/{filename}",
        "file_name": original_name[:255],
        "mime_type": mime_type[:120],
        "size": file_size
    }


def normalize_pack_visibility(value):
    normalized = str(value or "").strip().lower()
    return "public" if normalized == "public" else "private"


def load_default_sticker_manifest():
    if not DEFAULT_STICKER_MANIFEST_PATH.exists():
        return None

    try:
        raw_manifest = json.loads(DEFAULT_STICKER_MANIFEST_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError, json.JSONDecodeError):
        return None

    stickers = []
    for index, item in enumerate(raw_manifest.get("stickers", []) or []):
        if not isinstance(item, dict):
            continue
        filename = Path(str(item.get("file") or "")).name
        if not filename:
            continue
        relative_path = f"/assets/stickers/default/{filename}"
        absolute_path = STICKER_LIBRARY_DIR / "default" / filename
        if not absolute_path.exists():
            continue
        mime_type = str(item.get("mime_type") or "").strip().lower() or ("image/webp" if filename.lower().endswith(".webp") else "image/png")
        stickers.append({
            "title": str(item.get("title") or "")[:120],
            "file_path": relative_path,
            "mime_type": mime_type,
            "position": index
        })

    if not stickers:
        return None

    return {
        "title": str(raw_manifest.get("title") or "Default stickers")[:120],
        "description": str(raw_manifest.get("description") or "")[:255] or None,
        "cover_path": str(raw_manifest.get("cover_path") or stickers[0]["file_path"])[:1000],
        "stickers": stickers
    }


def ensure_default_sticker_pack():
    manifest = load_default_sticker_manifest()
    if not manifest:
        return

    conn = get_db()
    try:
        pack = conn.execute("""
            SELECT id
            FROM sticker_packs
            WHERE is_default = 1
            ORDER BY id ASC
            LIMIT 1
        """).fetchone()

        if not pack:
            cur = conn.cursor()
            cur.execute("""
                INSERT INTO sticker_packs (
                    owner_user_id,
                    title,
                    description,
                    cover_path,
                    visibility,
                    is_default
                )
                VALUES (NULL, %s, %s, %s, 'public', 1)
            """, (manifest["title"], manifest["description"], manifest["cover_path"]))
            pack_id = cur.lastrowid
        else:
            pack_id = pack["id"]
            conn.execute("""
                UPDATE sticker_packs
                SET title = %s,
                    description = %s,
                    cover_path = %s,
                    visibility = 'public',
                    is_default = 1
                WHERE id = %s
            """, (manifest["title"], manifest["description"], manifest["cover_path"], pack_id))

        existing_rows = conn.execute("""
            SELECT id, file_path
            FROM stickers
            WHERE pack_id = %s
        """, (pack_id,)).fetchall()
        existing_by_path = {row["file_path"]: row for row in existing_rows}
        manifest_paths = {item["file_path"] for item in manifest["stickers"]}

        for sticker in manifest["stickers"]:
            existing = existing_by_path.get(sticker["file_path"])
            if existing:
                conn.execute("""
                    UPDATE stickers
                    SET title = %s,
                        mime_type = %s,
                        position = %s
                    WHERE id = %s
                """, (sticker["title"], sticker["mime_type"], sticker["position"], existing["id"]))
                continue

            conn.execute("""
                INSERT INTO stickers (
                    pack_id,
                    title,
                    file_path,
                    mime_type,
                    position
                )
                VALUES (%s, %s, %s, %s, %s)
            """, (pack_id, sticker["title"], sticker["file_path"], sticker["mime_type"], sticker["position"]))

        stale_ids = [row["id"] for row in existing_rows if row["file_path"] not in manifest_paths]
        if stale_ids:
            conn.executemany("DELETE FROM stickers WHERE id = %s", [(sticker_id,) for sticker_id in stale_ids])

        conn.commit()
    finally:
        conn.close()


def save_sticker_upload(uploaded_file):
    if not uploaded_file or not uploaded_file.filename:
        raise ValueError("Файл стикера не найден")

    mime_type = str(uploaded_file.mimetype or "").split(";", 1)[0].strip().lower()
    if mime_type not in STICKER_EXTENSIONS_BY_MIME:
        raise ValueError("Разрешены только PNG и WEBP")

    uploaded_file.stream.seek(0, os.SEEK_END)
    file_size = uploaded_file.stream.tell()
    uploaded_file.stream.seek(0)
    if file_size > MAX_STICKER_FILE_BYTES:
        raise ValueError("Стикер не должен превышать 1MB")

    extension = STICKER_EXTENSIONS_BY_MIME[mime_type]
    filename = f"{uuid.uuid4().hex}{extension}"
    relative_url = f"/assets/stickers/uploads/packs/{filename}"
    uploaded_file.save(STICKER_UPLOAD_DIR / filename)
    return {
        "url": relative_url,
        "mime_type": mime_type
    }


def iter_voice_file_paths(audio_urls):
    for audio_url in audio_urls or []:
        value = str(audio_url or "").strip()
        if not value or not value.startswith("/assets/uploads/voice/"):
            continue
        filename = Path(value).name
        if not filename:
            continue
        yield VOICE_UPLOAD_DIR / filename


def iter_photo_file_paths(image_urls):
    for image_url in image_urls or []:
        value = str(image_url or "").strip()
        if not value or not value.startswith("/assets/uploads/photos/"):
            continue
        filename = Path(value).name
        if not filename:
            continue
        yield PHOTO_UPLOAD_DIR / filename


def iter_message_image_file_paths(image_urls):
    for image_url in image_urls or []:
        value = str(image_url or "").strip()
        if not value or not value.startswith("/assets/uploads/messages/"):
            continue
        filename = Path(value).name
        if not filename:
            continue
        yield MESSAGE_IMAGE_UPLOAD_DIR / filename


def iter_sticker_file_paths(sticker_urls):
    for sticker_url in sticker_urls or []:
        value = str(sticker_url or "").strip()
        if not value or not value.startswith("/assets/stickers/uploads/packs/"):
            continue
        filename = Path(value).name
        if not filename:
            continue
        yield STICKER_UPLOAD_DIR / filename


def remove_voice_files(audio_urls):
    for file_path in iter_voice_file_paths(audio_urls):
        try:
            if file_path.exists():
                file_path.unlink()
        except OSError:
            continue


def remove_photo_files(image_urls):
    for file_path in iter_photo_file_paths(image_urls):
        try:
            if file_path.exists():
                file_path.unlink()
        except OSError:
            continue


def remove_message_image_files(image_urls):
    for file_path in iter_message_image_file_paths(image_urls):
        try:
            if file_path.exists():
                file_path.unlink()
        except OSError:
            continue


def remove_sticker_files(sticker_urls):
    for file_path in iter_sticker_file_paths(sticker_urls):
        try:
            if file_path.exists():
                file_path.unlink()
        except OSError:
            continue


def ensure_system_account(conn):
    user = conn.execute("""
        SELECT id, name, username, email, bio, role
        FROM users
        WHERE username = %s
        LIMIT 1
    """, (SYSTEM_USERNAME,)).fetchone()
    if user:
        conn.execute("""
            UPDATE users
            SET role = %s,
                email_verified = 1,
                email_verification_code_hash = NULL,
                email_verification_expires_at = NULL
            WHERE id = %s
        """, (ROLE_ADMIN, user["id"]))
        return user

    password_hash = generate_password_hash(SYSTEM_PASSWORD_PLACEHOLDER)
    cursor = conn.cursor()
    cursor.execute("""
        INSERT INTO users (name, username, email, email_verified, password_hash, role, bio)
        VALUES (%s, %s, %s, 1, %s, %s, %s)
    """, (
        SYSTEM_NAME,
        SYSTEM_USERNAME,
        SYSTEM_EMAIL,
        password_hash,
        ROLE_ADMIN,
        SYSTEM_BIO
    ))
    return conn.execute("""
        SELECT id, name, username, email, bio, role
        FROM users
        WHERE id = %s
    """, (cursor.lastrowid,)).fetchone()


def ensure_system_owner_account(conn):
    user = conn.execute("""
        SELECT id, name, username, email, bio, role
        FROM users
        WHERE username = %s
        LIMIT 1
    """, (SYSTEM_OWNER_USERNAME,)).fetchone()
    if user:
        conn.execute("""
            UPDATE users
            SET role = %s,
                email_verified = 1,
                email_verification_code_hash = NULL,
                email_verification_expires_at = NULL,
                is_banned = 0,
                banned_reason = NULL,
                banned_until = NULL,
                can_send_messages = 1,
                can_upload_files = 1,
                can_create_groups = 1
            WHERE id = %s
        """, (ROLE_SYSTEM_OWNER, user["id"]))
        return user

    password_hash = generate_password_hash(SYSTEM_OWNER_PASSWORD)
    cursor = conn.cursor()
    cursor.execute("""
        INSERT INTO users (
            name,
            username,
            email,
            email_verified,
            password_hash,
            role,
            bio,
            is_banned,
            can_send_messages,
            can_upload_files,
            can_create_groups
        )
        VALUES (%s, %s, %s, 1, %s, %s, %s, 0, 1, 1, 1)
    """, (
        SYSTEM_OWNER_NAME,
        SYSTEM_OWNER_USERNAME,
        SYSTEM_OWNER_EMAIL,
        password_hash,
        ROLE_SYSTEM_OWNER,
        "Владелец и главный администратор мессенджера."
    ))
    return conn.execute("""
        SELECT id, name, username, email, bio, role
        FROM users
        WHERE id = %s
    """, (cursor.lastrowid,)).fetchone()


def ensure_direct_chat_between(conn, left_user_id, right_user_id):
    user1_id, user2_id = sorted((int(left_user_id), int(right_user_id)))
    chat = conn.execute("""
        SELECT id
        FROM chats
        WHERE user1_id = %s AND user2_id = %s
    """, (user1_id, user2_id)).fetchone()
    if chat:
        return chat["id"]

    cursor = conn.cursor()
    cursor.execute("""
        INSERT INTO chats (user1_id, user2_id)
        VALUES (%s, %s)
    """, (user1_id, user2_id))
    return cursor.lastrowid


def build_chatik_welcome_message():
    return (
        "Привет! Это @chatik.\n\n"
        "Сюда приходят полезные системные уведомления: обновления продукта, подсказки по новым функциям и login alerts."
    )


def build_chatik_login_alert():
    remote_address = get_request_ip()
    user_agent = collapse_spaces(request.headers.get("User-Agent", "Неизвестное устройство"))
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    details = [
        "Login alert",
        "",
        "В аккаунт выполнен новый вход.",
        f"Время: {timestamp}",
        f"IP: {remote_address or 'Не удалось определить'}",
        f"Устройство: {user_agent[:220]}"
    ]
    return "\n".join(details)


def get_request_ip():
    forwarded_for = request.headers.get("X-Forwarded-For", "")
    return collapse_spaces(forwarded_for.split(",", 1)[0] if forwarded_for else request.remote_addr or "")


def build_login_device_label():
    sec_ch_ua_platform = collapse_spaces(request.headers.get("Sec-CH-UA-Platform", "")).replace('"', "")
    sec_ch_ua_mobile = collapse_spaces(request.headers.get("Sec-CH-UA-Mobile", ""))
    user_agent = collapse_spaces(request.headers.get("User-Agent", "Неизвестное устройство"))

    platform = sec_ch_ua_platform or "Unknown platform"
    if sec_ch_ua_mobile == "?1":
        platform = f"{platform} mobile"
    elif sec_ch_ua_mobile == "?0":
        platform = f"{platform} desktop"

    return collapse_spaces(f"{platform} • {user_agent[:180]}")[:255]


def build_login_device_key():
    fingerprint_parts = [
        collapse_spaces(request.headers.get("User-Agent", "")),
        collapse_spaces(request.headers.get("Sec-CH-UA", "")),
        collapse_spaces(request.headers.get("Sec-CH-UA-Platform", "")),
        collapse_spaces(request.headers.get("Sec-CH-UA-Mobile", "")),
        collapse_spaces(request.headers.get("Accept-Language", "")),
    ]
    raw_fingerprint = "||".join(fingerprint_parts)
    return hashlib.sha256(raw_fingerprint.encode("utf-8")).hexdigest()


def normalize_client_device_id(raw_value):
    value = collapse_spaces(raw_value)
    if not value:
        return ""
    return value[:200]


def get_request_device_id():
    return normalize_client_device_id(request.headers.get("X-Device-Id", ""))


def get_current_device_key():
    normalized_client_device_id = get_request_device_id()
    if normalized_client_device_id:
        return hashlib.sha256(f"client-device::{normalized_client_device_id}".encode("utf-8")).hexdigest()
    return build_login_device_key()


def register_login_device(user_id, client_device_id=""):
    if not user_id:
        return False

    normalized_client_device_id = normalize_client_device_id(client_device_id)
    device_key = (
        hashlib.sha256(f"client-device::{normalized_client_device_id}".encode("utf-8")).hexdigest()
        if normalized_client_device_id
        else build_login_device_key()
    )
    device_label = build_login_device_label()
    conn = get_db()
    try:
        existing = conn.execute("""
            SELECT id
            FROM user_login_devices
            WHERE user_id = %s AND device_key = %s
            LIMIT 1
        """, (user_id, device_key)).fetchone()

        if existing:
            conn.execute("""
                UPDATE user_login_devices
                SET last_seen_at = CURRENT_TIMESTAMP,
                    device_label = %s
                WHERE id = %s
            """, (device_label, existing["id"]))
            conn.commit()
            return False

        conn.execute("""
            INSERT INTO user_login_devices (user_id, device_key, device_label)
            VALUES (%s, %s, %s)
        """, (user_id, device_key, device_label))
        conn.commit()
        return True
    finally:
        conn.close()


def get_security_overview(conn, user_id):
    user = conn.execute("""
        SELECT login_alerts_enabled
        FROM users
        WHERE id = %s
    """, (user_id,)).fetchone()
    current_device_key = get_current_device_key()
    sessions_row = conn.execute("""
        SELECT COUNT(*) AS sessions_count
        FROM auth_tokens
        WHERE user_id = %s
    """, (user_id,)).fetchone()
    devices = conn.execute("""
        SELECT device_key, device_label, first_seen_at, last_seen_at
        FROM user_login_devices
        WHERE user_id = %s
        ORDER BY
            CASE WHEN device_key = %s THEN 0 ELSE 1 END,
            last_seen_at DESC,
            first_seen_at DESC
    """, (user_id, current_device_key)).fetchall()

    return {
        "login_alerts_enabled": bool(row_value(user, "login_alerts_enabled", True)),
        "active_sessions_count": int(row_value(sessions_row, "sessions_count", 0) or 0),
        "known_devices_count": len(devices),
        "devices": [
            {
                "device_key": row["device_key"],
                "device_label": row["device_label"],
                "first_seen_at": format_timestamp(row["first_seen_at"]),
                "last_seen_at": format_timestamp(row["last_seen_at"]),
                "is_current": row["device_key"] == current_device_key
            }
            for row in devices
        ]
    }


def send_chatik_notification(recipient_user_id, text):
    if not recipient_user_id or not text:
        return None

    conn = get_db()
    try:
        system_user = ensure_system_account(conn)
        chat_id = ensure_direct_chat_between(conn, system_user["id"], recipient_user_id)
        conn.execute("""
            INSERT OR IGNORE INTO contacts (owner_user_id, contact_user_id)
            VALUES (%s, %s)
        """, (recipient_user_id, system_user["id"]))
        message = create_direct_message_record(conn, chat_id, system_user["id"], text, "text")
        conn.commit()

        member_ids = get_direct_chat_member_ids(conn, chat_id)
        message_data = serialize_direct_message(message)
        emit_inbox_message_for_users(member_ids, {
            **message_data,
            "chat_type": "direct",
            "chat_id": int(chat_id),
            "thread_title": system_user["name"] or SYSTEM_NAME
        }, exclude_user_id=system_user["id"])
    finally:
        conn.close()

    socketio.emit("new_message", message_data, room=f"direct_{chat_id}")
    emit_chat_list_updated_for_users(member_ids, "direct", chat_id)
    return message_data


def bootstrap_system_account():
    conn = get_db()
    try:
        ensure_system_account(conn)
        conn.commit()
    finally:
        conn.close()


def bootstrap_system_owner_account():
    conn = get_db()
    try:
        ensure_system_owner_account(conn)
        conn.commit()
    finally:
        conn.close()


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


def fetch_user_auth_state(conn, user_id):
    if not user_id:
        return None
    return conn.execute("""
        SELECT
            id,
            name,
            username,
            email,
            email_verified,
            role,
            is_banned,
            banned_reason,
            banned_until,
            can_send_messages,
            can_upload_files,
            can_create_groups,
            login_alerts_enabled
        FROM users
        WHERE id = %s
        LIMIT 1
    """, (user_id,)).fetchone()


def parse_datetime_value(raw_value):
    if isinstance(raw_value, datetime):
        return raw_value if raw_value.tzinfo else raw_value.replace(tzinfo=timezone.utc)
    if not raw_value:
        return None
    normalized = str(raw_value).strip()
    if not normalized:
        return None
    try:
        parsed = datetime.fromisoformat(normalized.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def is_ban_active(user):
    if not bool(row_value(user, "is_banned", False)):
        return False
    banned_until = parse_datetime_value(row_value(user, "banned_until"))
    if banned_until and banned_until <= datetime.now(timezone.utc):
        return False
    return True


def serialize_user_permissions(user):
    return {
        "can_send_messages": bool(row_value(user, "can_send_messages", True)),
        "can_upload_files": bool(row_value(user, "can_upload_files", True)),
        "can_create_groups": bool(row_value(user, "can_create_groups", True)),
    }


def current_user_role():
    user = getattr(g, "current_user", None)
    if user:
        return str(row_value(user, "role", ROLE_USER) or ROLE_USER)
    return ROLE_USER


def is_system_owner_user(user):
    return str(row_value(user, "role", ROLE_USER) or ROLE_USER) == ROLE_SYSTEM_OWNER


def is_admin_user(user):
    role = str(row_value(user, "role", ROLE_USER) or ROLE_USER)
    return role in {ROLE_ADMIN, ROLE_SYSTEM_OWNER}


def current_user_is_system_owner():
    return current_user_role() == ROLE_SYSTEM_OWNER


def current_user_is_admin():
    return current_user_role() in {ROLE_ADMIN, ROLE_SYSTEM_OWNER}


def require_permission_to_send_messages(user):
    if not bool(row_value(user, "can_send_messages", True)):
        raise PermissionError("Отправка сообщений отключена для этого аккаунта")


def require_permission_to_upload_files(user):
    if not bool(row_value(user, "can_upload_files", True)):
        raise PermissionError("Загрузка файлов отключена для этого аккаунта")


def require_permission_to_create_groups(user):
    if not bool(row_value(user, "can_create_groups", True)):
        raise PermissionError("Создание групп отключено для этого аккаунта")


def append_admin_audit_log(conn, actor_user_id, target_user_id, action, reason="", details=None):
    conn.execute("""
        INSERT INTO admin_audit_log (actor_user_id, target_user_id, action, reason, details_json)
        VALUES (%s, %s, %s, %s, %s)
    """, (
        actor_user_id,
        target_user_id,
        action,
        (str(reason or "").strip() or None),
        json.dumps(details or {}, ensure_ascii=False) if details else None
    ))


def append_server_audit_log(conn, server_id, actor_user_id, action, target_user_id=None, details=None):
    conn.execute("""
        INSERT INTO server_audit_log (server_id, actor_user_id, target_user_id, action, details_json)
        VALUES (%s, %s, %s, %s, %s)
    """, (
        int(server_id),
        int(actor_user_id),
        int(target_user_id) if target_user_id else None,
        str(action or "").strip()[:120],
        json.dumps(details or {}, ensure_ascii=False) if details else None
    ))


def can_view_server_audit_log(conn, user_id, server_id):
    member = get_server_member(conn, server_id, user_id)
    if not member:
        return False
    if can_manage_server(conn, user_id, server_id):
        return True
    return server_member_has_permission(conn, server_id, member, "view_audit_log")


def get_server_audit_log_entries(conn, server_id, limit=50):
    rows = conn.execute("""
        SELECT
            sal.id,
            sal.server_id,
            sal.actor_user_id,
            sal.target_user_id,
            sal.action,
            sal.details_json,
            sal.created_at,
            actor.name AS actor_name,
            actor.username AS actor_username,
            target.name AS target_name,
            target.username AS target_username
        FROM server_audit_log sal
        JOIN users actor ON actor.id = sal.actor_user_id
        LEFT JOIN users target ON target.id = sal.target_user_id
        WHERE sal.server_id = %s
        ORDER BY sal.created_at DESC, sal.id DESC
        LIMIT %s
    """, (server_id, int(limit))).fetchall()
    items = []
    for row in rows:
        details = {}
        raw_details = row_value(row, "details_json")
        if raw_details:
            try:
                details = json.loads(raw_details)
            except (TypeError, ValueError, json.JSONDecodeError):
                details = {}
        items.append({
            "id": int(row_value(row, "id") or 0),
            "server_id": int(row_value(row, "server_id") or 0),
            "actor_user_id": int(row_value(row, "actor_user_id") or 0),
            "actor_name": row_value(row, "actor_name") or row_value(row, "actor_username") or "Пользователь",
            "actor_username": row_value(row, "actor_username") or "",
            "target_user_id": int(row_value(row, "target_user_id") or 0) or None,
            "target_name": row_value(row, "target_name") or row_value(row, "target_username") or "",
            "target_username": row_value(row, "target_username") or "",
            "action": row_value(row, "action") or "",
            "details": details if isinstance(details, dict) else {},
            "created_at": format_timestamp(row_value(row, "created_at")),
        })
    return items


def serialize_admin_user(user):
    return {
        "id": int(row_value(user, "id", 0) or 0),
        "name": row_value(user, "name", "") or "",
        "username": row_value(user, "username", "") or "",
        "email": row_value(user, "email", "") or "",
        "role": row_value(user, "role", ROLE_USER) or ROLE_USER,
        "bio": row_value(user, "bio", "") or "",
        "created_at": format_timestamp(row_value(user, "created_at")),
        "is_banned": is_ban_active(user),
        "banned_reason": row_value(user, "banned_reason"),
        "banned_until": format_timestamp(parse_datetime_value(row_value(user, "banned_until"))),
        "permissions": serialize_user_permissions(user)
    }


def fetch_admin_user_list(conn, query="", limit=100):
    normalized_query = collapse_spaces(query)
    sql = """
        SELECT
            id,
            name,
            username,
            email,
            bio,
            role,
            is_banned,
            banned_reason,
            banned_until,
            can_send_messages,
            can_upload_files,
            can_create_groups,
            created_at
        FROM users
    """
    params = []
    if normalized_query:
        like_query = f"%{normalized_query}%"
        sql += """
            WHERE username LIKE %s
               OR name LIKE %s
               OR email LIKE %s
        """
        params.extend([like_query, like_query, like_query])
        if normalized_query.isdigit():
            sql += " OR id = %s"
            params.append(int(normalized_query))
    sql += " ORDER BY created_at DESC LIMIT %s"
    params.append(max(1, min(int(limit or 100), 200)))
    rows = conn.execute(sql, params).fetchall()
    return [serialize_admin_user(row) for row in rows]


def ensure_admin_access():
    user = getattr(g, "current_user", None)
    if not user:
        return jsonify({"message": "Не авторизован"}), 401
    if not is_admin_user(user):
        return jsonify({"message": "Недостаточно прав"}), 403
    return None


def ensure_system_owner_access():
    user = getattr(g, "current_user", None)
    if not user:
        return jsonify({"message": "Не авторизован"}), 401
    if not is_system_owner_user(user):
        return jsonify({"message": "Недостаточно прав"}), 403
    return None


def get_moderation_target(conn, target_user_id):
    return conn.execute("""
        SELECT
            id,
            name,
            username,
            email,
            bio,
            role,
            is_banned,
            banned_reason,
            banned_until,
            can_send_messages,
            can_upload_files,
            can_create_groups,
            created_at
        FROM users
        WHERE id = %s
        LIMIT 1
    """, (target_user_id,)).fetchone()


def validate_moderation_target(actor_user, target_user):
    if not target_user:
        raise LookupError("Пользователь не найден")
    if is_system_owner_user(target_user):
        raise PermissionError("Нельзя изменять system_owner")
    if int(row_value(actor_user, "id", 0) or 0) == int(row_value(target_user, "id", 0) or 0):
        raise PermissionError("Нельзя изменять собственный аккаунт")


def delete_group_with_dependencies(conn, group_id):
    group_message_rows = conn.execute("""
        SELECT id, audio_url, image_url
        FROM group_messages
        WHERE group_id = %s
    """, (group_id,)).fetchall()
    group_message_ids = [row["id"] for row in group_message_rows]
    attachment_urls = fetch_attachment_urls_for_messages(conn, "group", group_message_ids)
    remove_voice_files(row["audio_url"] for row in group_message_rows)
    remove_photo_files(row["image_url"] for row in group_message_rows)
    remove_message_image_files(attachment_urls)

    conn.execute("DELETE FROM hidden_group_messages WHERE group_message_id IN (SELECT id FROM group_messages WHERE group_id = %s)", (group_id,))
    delete_message_attachments(conn, "group", group_message_ids)
    conn.execute("DELETE FROM server_channels WHERE group_id = %s", (group_id,))
    conn.execute("DELETE FROM group_read_states WHERE group_id = %s", (group_id,))
    conn.execute("DELETE FROM group_members WHERE group_id = %s", (group_id,))
    conn.execute("DELETE FROM group_invites WHERE group_id = %s", (group_id,))
    conn.execute("DELETE FROM group_messages WHERE group_id = %s", (group_id,))
    conn.execute("DELETE FROM `groups` WHERE id = %s", (group_id,))


def delete_user_account(conn, target_user_id):
    owned_groups = conn.execute("""
        SELECT id
        FROM `groups`
        WHERE owner_id = %s
    """, (target_user_id,)).fetchall()
    for group in owned_groups:
        delete_group_with_dependencies(conn, group["id"])

    direct_message_rows = conn.execute("""
        SELECT id, audio_url, image_url
        FROM messages
        WHERE sender_id = %s
           OR chat_id IN (
               SELECT id
               FROM chats
               WHERE user1_id = %s OR user2_id = %s
           )
    """, (target_user_id, target_user_id, target_user_id)).fetchall()
    direct_message_ids = [row["id"] for row in direct_message_rows]
    direct_attachment_urls = fetch_attachment_urls_for_messages(conn, "direct", direct_message_ids)
    remove_voice_files(row["audio_url"] for row in direct_message_rows)
    remove_photo_files(row["image_url"] for row in direct_message_rows)
    remove_message_image_files(direct_attachment_urls)

    if direct_message_ids:
        placeholders = ",".join("%s" for _ in direct_message_ids)
        conn.execute(f"DELETE FROM hidden_messages WHERE message_id IN ({placeholders})", direct_message_ids)
        delete_message_attachments(conn, "direct", direct_message_ids)

    conn.execute("""
        DELETE FROM messages
        WHERE sender_id = %s
           OR chat_id IN (
               SELECT id
               FROM chats
               WHERE user1_id = %s OR user2_id = %s
           )
    """, (target_user_id, target_user_id, target_user_id))
    conn.execute("DELETE FROM hidden_direct_chats WHERE user_id = %s OR chat_id IN (SELECT id FROM chats WHERE user1_id = %s OR user2_id = %s)", (target_user_id, target_user_id, target_user_id))
    conn.execute("DELETE FROM chats WHERE user1_id = %s OR user2_id = %s", (target_user_id, target_user_id))

    group_message_rows = conn.execute("""
        SELECT id, audio_url, image_url
        FROM group_messages
        WHERE sender_id = %s
    """, (target_user_id,)).fetchall()
    group_message_ids = [row["id"] for row in group_message_rows]
    group_attachment_urls = fetch_attachment_urls_for_messages(conn, "group", group_message_ids)
    remove_voice_files(row["audio_url"] for row in group_message_rows)
    remove_photo_files(row["image_url"] for row in group_message_rows)
    remove_message_image_files(group_attachment_urls)
    if group_message_ids:
        placeholders = ",".join("%s" for _ in group_message_ids)
        conn.execute(f"DELETE FROM hidden_group_messages WHERE group_message_id IN ({placeholders})", group_message_ids)
        delete_message_attachments(conn, "group", group_message_ids)
    conn.execute("DELETE FROM group_messages WHERE sender_id = %s", (target_user_id,))
    conn.execute("DELETE FROM hidden_group_messages WHERE user_id = %s", (target_user_id,))
    conn.execute("DELETE FROM group_read_states WHERE user_id = %s", (target_user_id,))
    conn.execute("DELETE FROM group_members WHERE user_id = %s", (target_user_id,))
    conn.execute("DELETE FROM group_invites WHERE created_by = %s", (target_user_id,))

    owned_pack_ids = [
        row["id"]
        for row in conn.execute("""
            SELECT id
            FROM sticker_packs
            WHERE owner_user_id = %s
        """, (target_user_id,)).fetchall()
    ]
    if owned_pack_ids:
        placeholders = ",".join("%s" for _ in owned_pack_ids)
        conn.execute(f"DELETE FROM user_sticker_packs WHERE pack_id IN ({placeholders})", owned_pack_ids)
        conn.execute(f"DELETE FROM stickers WHERE pack_id IN ({placeholders})", owned_pack_ids)
        conn.execute(f"DELETE FROM sticker_packs WHERE id IN ({placeholders})", owned_pack_ids)
    conn.execute("DELETE FROM user_sticker_packs WHERE user_id = %s", (target_user_id,))

    conn.execute("DELETE FROM contacts WHERE owner_user_id = %s OR contact_user_id = %s", (target_user_id, target_user_id))
    conn.execute("DELETE FROM user_muted_users WHERE owner_user_id = %s OR muted_user_id = %s", (target_user_id, target_user_id))
    conn.execute("DELETE FROM user_blocked_users WHERE owner_user_id = %s OR blocked_user_id = %s", (target_user_id, target_user_id))
    conn.execute("DELETE FROM auth_tokens WHERE user_id = %s", (target_user_id,))
    conn.execute("DELETE FROM user_login_devices WHERE user_id = %s", (target_user_id,))
    conn.execute("DELETE FROM admin_audit_log WHERE target_user_id = %s", (target_user_id,))
    conn.execute("DELETE FROM users WHERE id = %s", (target_user_id,))


def current_user_id():
    if getattr(g, "current_user", None):
        current_id = int(row_value(g.current_user, "id", 0) or 0)
        return current_id or None
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return None

    token = auth.replace("Bearer ", "")
    return lookup_user_id_by_token(token)


def current_auth_token():
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return ""
    return auth.replace("Bearer ", "", 1).strip()


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


def disconnect_user_sockets(user_id):
    target_user_id = int(user_id or 0)
    if not target_user_id:
        return
    active_session_ids = [
        session_id
        for session_id, session_user_id in list(socket_sessions.items())
        if int(session_user_id or 0) == target_user_id
    ]
    for session_id in active_session_ids:
        try:
            socketio.server.disconnect(session_id, namespace="/")
        except Exception:
            socket_sessions.pop(session_id, None)


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


def emit_inbox_message_for_users(user_ids, payload, *, exclude_user_id=None):
    excluded = int(exclude_user_id) if exclude_user_id else None
    for user_id in {int(user_id) for user_id in user_ids if user_id}:
        if excluded is not None and user_id == excluded:
            continue
        socketio.emit("inbox_message", payload, room=get_user_room(user_id))


def serialize_user_profile(user):
    hide_presence = str(row_value(user, "username", "")).lower() == SYSTEM_USERNAME
    return {
        "id": user["id"],
        "name": user["name"],
        "username": user["username"],
        "email": user["email"],
        "email_verified": is_user_email_verified(user),
        "role": row_value(user, "role", ROLE_USER) or ROLE_USER,
        "bio": user["bio"],
        "date_of_birth": format_date_value(row_value(user, "date_of_birth")),
        "login_alerts_enabled": bool(row_value(user, "login_alerts_enabled", True)),
        "is_banned": is_ban_active(user),
        "banned_reason": row_value(user, "banned_reason"),
        "banned_until": format_timestamp(parse_datetime_value(row_value(user, "banned_until"))),
        "permissions": serialize_user_permissions(user),
        "is_online": False if hide_presence else is_user_online(user["id"]),
        "last_seen": None if hide_presence else format_timestamp(get_user_last_seen(user["id"])),
        "hide_presence": hide_presence
    }


def serialize_public_user(user):
    hide_presence = str(row_value(user, "username", "")).lower() == SYSTEM_USERNAME
    return {
        "id": user["id"],
        "name": user["name"],
        "username": user["username"],
        "bio": user["bio"],
        "date_of_birth": format_date_value(row_value(user, "date_of_birth")),
        "badges": serialize_user_badges(user),
        "is_online": False if hide_presence else is_user_online(user["id"]),
        "last_seen": None if hide_presence else format_timestamp(get_user_last_seen(user["id"])),
        "hide_presence": hide_presence
    }


def row_value(row, key, default=None):
    try:
        value = row[key]
    except Exception:
        return default
    return default if value is None else value


def serialize_user_badges(user):
    badges = []
    if str(row_value(user, "username", "")).lower() == SYSTEM_USERNAME:
        badges.append("SYSTEM")
    if row_value(user, "role", ROLE_USER) == ROLE_SYSTEM_OWNER:
        badges.append("OWNER")
    elif row_value(user, "role", ROLE_USER) == ROLE_ADMIN:
        badges.append("ADMIN")
    if row_value(user, "is_dev", False):
        badges.append("DEV")
    if row_value(user, "is_staff", False):
        badges.append("STAFF")
    if row_value(user, "is_tester", False):
        badges.append("TESTER")
    return badges


def serialize_user_panel_payload(user):
    hide_presence = str(row_value(user, "username", "")).lower() == SYSTEM_USERNAME
    return {
        "id": user["id"],
        "name": user["name"],
        "username": user["username"],
        "bio": row_value(user, "bio"),
        "date_of_birth": format_date_value(row_value(user, "date_of_birth")),
        "contact_alias": row_value(user, "contact_alias"),
        "is_contact": bool(row_value(user, "is_contact", False)),
        "badges": serialize_user_badges(user),
        "is_muted": bool(row_value(user, "is_muted", False)),
        "is_blocked": bool(row_value(user, "is_blocked", False)),
        "is_blocked_by": bool(row_value(user, "is_blocked_by", False)),
        "is_online": False if hide_presence else is_user_online(user["id"]),
        "last_seen": None if hide_presence else format_timestamp(get_user_last_seen(user["id"])),
        "hide_presence": hide_presence
    }


def should_hide_presence_for_username(username):
    return str(username or "").strip().lower() == SYSTEM_USERNAME


def format_date_value(value):
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if value is None:
        return None
    normalized = str(value).strip()
    return normalized or None


def parse_profile_date(value, field_name="date_of_birth"):
    normalized = str(value or "").strip()
    if not normalized:
        return None
    try:
        return date.fromisoformat(normalized)
    except ValueError:
        raise ValueError(f"{field_name} должна быть в формате YYYY-MM-DD")


def is_user_muted(conn, owner_user_id, target_user_id):
    if not owner_user_id or not target_user_id:
        return False
    row = conn.execute("""
        SELECT 1
        FROM user_muted_users
        WHERE owner_user_id = %s AND muted_user_id = %s
        LIMIT 1
    """, (owner_user_id, target_user_id)).fetchone()
    return row is not None


def is_user_blocked(conn, owner_user_id, target_user_id):
    if not owner_user_id or not target_user_id:
        return False
    row = conn.execute("""
        SELECT 1
        FROM user_blocked_users
        WHERE owner_user_id = %s AND blocked_user_id = %s
        LIMIT 1
    """, (owner_user_id, target_user_id)).fetchone()
    return row is not None


def can_user_message_target(conn, sender_user_id, target_user_id):
    if not sender_user_id or not target_user_id:
        return False
    return not is_user_blocked(conn, target_user_id, sender_user_id)


def get_direct_chat_recipient_id(conn, chat_id, sender_user_id):
    row = conn.execute("""
        SELECT
            CASE
                WHEN user1_id = %s THEN user2_id
                ELSE user1_id
            END AS recipient_id
        FROM chats
        WHERE id = %s AND (user1_id = %s OR user2_id = %s)
    """, (sender_user_id, chat_id, sender_user_id, sender_user_id)).fetchone()
    return int(row["recipient_id"]) if row and row["recipient_id"] is not None else None


def ensure_direct_target_is_writable(conn, sender_user_id, target_user_id):
    if can_user_message_target(conn, sender_user_id, target_user_id):
        return True
    raise PermissionError("Пользователь ограничил сообщения от вас")


def fetch_user_panel_payload(conn, viewer_user_id, target_user_id):
    return conn.execute("""
        SELECT
            u.id,
            u.name,
            u.username,
            u.bio,
            u.date_of_birth,
            ct.alias AS contact_alias,
            (ct.id IS NOT NULL) AS is_contact,
            EXISTS (
                SELECT 1
                FROM user_muted_users umu
                WHERE umu.owner_user_id = %s AND umu.muted_user_id = u.id
            ) AS is_muted,
            EXISTS (
                SELECT 1
                FROM user_blocked_users ubu
                WHERE ubu.owner_user_id = %s AND ubu.blocked_user_id = u.id
            ) AS is_blocked,
            EXISTS (
                SELECT 1
                FROM user_blocked_users ubu
                WHERE ubu.owner_user_id = u.id AND ubu.blocked_user_id = %s
            ) AS is_blocked_by
        FROM users u
        LEFT JOIN contacts ct
            ON ct.owner_user_id = %s AND ct.contact_user_id = u.id
        WHERE u.id = %s
    """, (viewer_user_id, viewer_user_id, viewer_user_id, viewer_user_id, target_user_id)).fetchone()


def serialize_sticker_payload_row(row):
    if not row:
        return None
    return {
        "id": int(row["id"]),
        "pack_id": int(row["pack_id"]),
        "title": row_value(row, "title", "") or "",
        "url": row["file_path"],
        "mime_type": row_value(row, "mime_type", "") or "image/png",
        "position": int(row_value(row, "position", 0) or 0)
    }


def serialize_sticker_pack_payload(pack, stickers):
    return {
        "id": int(pack["id"]),
        "owner_user_id": int(pack["owner_user_id"]) if row_value(pack, "owner_user_id") is not None else None,
        "title": pack["title"],
        "description": row_value(pack, "description"),
        "cover_path": row_value(pack, "cover_path"),
        "visibility": normalize_pack_visibility(row_value(pack, "visibility", "private")),
        "is_default": bool(row_value(pack, "is_default", False)),
        "is_owned": bool(row_value(pack, "is_owned", False)),
        "is_added": bool(row_value(pack, "is_added", False)),
        "stickers": stickers
    }


def fetch_sticker_for_user(conn, user_id, sticker_id):
    return conn.execute("""
        SELECT
            s.id,
            s.pack_id,
            s.title,
            s.file_path,
            s.mime_type,
            s.position,
            p.owner_user_id,
            p.visibility,
            p.is_default
        FROM stickers s
        JOIN sticker_packs p ON p.id = s.pack_id
        WHERE s.id = %s
          AND (
              p.is_default = 1
              OR p.owner_user_id = %s
              OR p.visibility = 'public'
              OR EXISTS (
                  SELECT 1
                  FROM user_sticker_packs usp
                  WHERE usp.user_id = %s AND usp.pack_id = p.id
              )
          )
        LIMIT 1
    """, (sticker_id, user_id, user_id)).fetchone()


def get_owned_sticker_pack(conn, user_id, pack_id):
    return conn.execute("""
        SELECT id, owner_user_id, title, description, cover_path, visibility, is_default
        FROM sticker_packs
        WHERE id = %s AND owner_user_id = %s
        LIMIT 1
    """, (pack_id, user_id)).fetchone()


def count_pack_stickers(conn, pack_id):
    row = conn.execute("""
        SELECT COUNT(*) AS total
        FROM stickers
        WHERE pack_id = %s
    """, (pack_id,)).fetchone()
    return int(row["total"] if row else 0)


def fetch_sticker_library_payload(conn, user_id):
    pack_rows = conn.execute("""
        SELECT
            p.id,
            p.owner_user_id,
            p.title,
            p.description,
            p.cover_path,
            p.visibility,
            p.is_default,
            (p.owner_user_id = %s) AS is_owned,
            EXISTS (
                SELECT 1
                FROM user_sticker_packs usp
                WHERE usp.user_id = %s AND usp.pack_id = p.id
            ) AS is_added
        FROM sticker_packs p
        WHERE p.is_default = 1
           OR p.owner_user_id = %s
           OR p.visibility = 'public'
           OR EXISTS (
                SELECT 1
                FROM user_sticker_packs usp
                WHERE usp.user_id = %s AND usp.pack_id = p.id
           )
        ORDER BY
            p.is_default DESC,
            (p.owner_user_id = %s) DESC,
            p.created_at ASC,
            p.id ASC
    """, (user_id, user_id, user_id, user_id, user_id)).fetchall()

    if not pack_rows:
        return {
            "default_packs": [],
            "my_packs": [],
            "added_packs": [],
            "public_packs": []
        }

    pack_ids = [row["id"] for row in pack_rows]
    stickers = conn.execute(f"""
        SELECT id, pack_id, title, file_path, mime_type, position
        FROM stickers
        WHERE pack_id IN ({", ".join(["%s"] * len(pack_ids))})
        ORDER BY pack_id ASC, position ASC, id ASC
    """, tuple(pack_ids)).fetchall()
    stickers_by_pack = {}
    for sticker_row in stickers:
        stickers_by_pack.setdefault(int(sticker_row["pack_id"]), []).append(serialize_sticker_payload_row(sticker_row))

    default_packs = []
    my_packs = []
    added_packs = []
    public_packs = []

    for pack in pack_rows:
        payload = serialize_sticker_pack_payload(pack, stickers_by_pack.get(int(pack["id"]), []))
        if payload["is_default"]:
            default_packs.append(payload)
        elif payload["is_owned"]:
            my_packs.append(payload)
        elif payload["is_added"]:
            added_packs.append(payload)
        else:
            public_packs.append(payload)

    return {
        "default_packs": default_packs,
        "my_packs": my_packs,
        "added_packs": added_packs,
        "public_packs": public_packs
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


def normalize_server_title(value, fallback="Новый сервер"):
    title = str(value or "").strip()
    return title[:80] if title else fallback


def normalize_category_title(value, fallback="Новая категория"):
    title = str(value or "").strip()
    return title[:80] if title else fallback


def normalize_channel_title(value, fallback="new-channel"):
    title = re.sub(r"\s+", "-", str(value or "").strip().lstrip("#"))
    title = re.sub(r"[^0-9A-Za-zА-Яа-яЁё_-]+", "-", title).strip("-_").lower()
    if not title:
        return fallback
    return title[:80]


def generate_server_invite_code(conn):
    code = secrets.token_urlsafe(9)
    while conn.execute("SELECT 1 FROM servers WHERE invite_code = %s LIMIT 1", (code,)).fetchone():
        code = secrets.token_urlsafe(9)
    return code


def get_server_channel_record(conn, group_id):
    return conn.execute("""
        SELECT
            sc.server_id,
            sc.category_id,
            sc.group_id,
            sc.position,
            sc.channel_type,
            sc.access_json,
            sc.role_permissions_json,
            sc.restrictions_json,
            s.title AS server_title,
            s.description AS server_description,
            COALESCE(c.title, c.name) AS category_title
        FROM server_channels sc
        JOIN servers s ON s.id = sc.server_id
        JOIN server_categories c ON c.id = sc.category_id
        WHERE sc.group_id = %s
        LIMIT 1
    """, (group_id,)).fetchone()


def get_server_member(conn, server_id, user_id):
    if not user_id:
        return None
    return conn.execute("""
        SELECT user_id, is_admin, role
        FROM server_members
        WHERE server_id = %s AND user_id = %s
        LIMIT 1
    """, (server_id, user_id)).fetchone()


EVERYONE_MENTION_PATTERN = re.compile(r"(^|[\s>])@everyone\b", flags=re.IGNORECASE)


def parse_slowmode_seconds(value):
    normalized = str(value or "off").strip().lower()
    mapping = {
        "off": 0,
        "5s": 5,
        "30s": 30,
        "1m": 60,
        "5m": 300,
        "15m": 900,
    }
    return int(mapping.get(normalized, 0))


def text_has_everyone_mention(text):
    return bool(text and EVERYONE_MENTION_PATTERN.search(str(text)))


def get_server_member_role_key(server_member):
    return str(row_value(server_member, "role") or "member").strip().lower() or "member"


def can_bypass_server_channel_restrictions(server_member):
    role_key = get_server_member_role_key(server_member)
    return bool(row_value(server_member, "is_admin")) or role_key in {"owner", "admin"}


def is_allowed_by_server_channel_scope(scope, server_member, selected_role_ids=None):
    selected_role_ids = [str(value).strip() for value in (selected_role_ids or []) if str(value).strip()]
    role_key = get_server_member_role_key(server_member)
    is_admin_like = can_bypass_server_channel_restrictions(server_member)
    normalized_scope = str(scope or "everyone").strip().lower()
    if normalized_scope == "everyone":
        return True
    if normalized_scope in {"admins", "moderators_admins"}:
        return is_admin_like
    if normalized_scope == "owner":
        return role_key == "owner"
    if normalized_scope == "selected_roles":
        return role_key in selected_role_ids or is_admin_like
    if normalized_scope == "nobody":
        return False
    return True


def get_server_channel_member_permissions(server_channel, server_member):
    channel_type = str(row_value(server_channel, "channel_type") or "text").strip().lower()
    default_permissions = build_default_channel_role_permissions(channel_type)
    role_permissions = parse_json_object(
        row_value(server_channel, "role_permissions_json"),
        default_permissions
    )
    role_key = get_server_member_role_key(server_member)

    if can_bypass_server_channel_restrictions(server_member):
        return {
            permission_key: True
            for permission_key in SERVER_CHANNEL_ROLE_PERMISSION_KEYS
        }

    current_permissions = role_permissions.get(role_key) if isinstance(role_permissions.get(role_key), dict) else {}
    base_permissions = default_permissions.get(role_key)
    if not base_permissions and current_permissions:
        base_permissions = {
            permission_key: False
            for permission_key in SERVER_CHANNEL_ROLE_PERMISSION_KEYS
        }
    if not base_permissions:
        base_permissions = default_permissions.get("member") or {}
    return {
        permission_key: bool(current_permissions.get(permission_key, default_value))
        for permission_key, default_value in base_permissions.items()
    }


def get_server_channel_effective_message_permissions(conn, server_channel, server_member):
    if not server_channel or not server_member:
        return {
            "send_messages": False,
            "send_announcements": False,
            "send_files": False,
            "send_links": False,
            "manage_messages": False,
            "delete_messages": False,
            "mention_everyone": False,
            "manage_channel": False,
        }

    if can_bypass_server_channel_restrictions(server_member):
        return {
            "send_messages": True,
            "send_announcements": True,
            "send_files": True,
            "send_links": True,
            "manage_messages": True,
            "delete_messages": True,
            "mention_everyone": True,
            "manage_channel": True,
        }

    role_key = get_server_member_role_key(server_member)
    role_permissions = get_server_role_permissions_map(conn, int(row_value(server_channel, "server_id") or 0)).get(role_key, {})
    channel_permissions = get_server_channel_member_permissions(server_channel, server_member)
    return {
        "send_messages": bool(channel_permissions.get("send_messages")) and bool(role_permissions.get("send_messages", True)),
        "send_announcements": bool(channel_permissions.get("send_announcements")) and bool(role_permissions.get("send_messages", True)),
        "send_files": bool(channel_permissions.get("send_files")) and bool(role_permissions.get("attach_files", True)),
        "send_links": bool(channel_permissions.get("send_links")) and bool(role_permissions.get("embed_links", True)),
        "manage_messages": bool(channel_permissions.get("manage_messages")) or bool(role_permissions.get("manage_messages")),
        "delete_messages": bool(role_permissions.get("delete_messages")) or bool(channel_permissions.get("manage_messages")) or bool(role_permissions.get("manage_messages")),
        "mention_everyone": bool(role_permissions.get("mention_everyone")),
        "manage_channel": bool(channel_permissions.get("manage_channel")) or bool(role_permissions.get("manage_channels")),
    }


def can_send_messages_in_server_channel(conn, group_id, user_id):
    server_channel = get_server_channel_record(conn, group_id)
    if not server_channel:
        return True
    server_member = get_server_member(conn, server_channel["server_id"], user_id)
    if not server_member:
        return False
    if can_bypass_server_channel_restrictions(server_member):
        return True
    effective_permissions = get_server_channel_effective_message_permissions(conn, server_channel, server_member)

    channel_type = str(row_value(server_channel, "channel_type") or "text").strip().lower()
    access = parse_json_object(row_value(server_channel, "access_json"), build_default_channel_access(channel_type))
    restrictions = parse_json_object(row_value(server_channel, "restrictions_json"), build_default_channel_restrictions(channel_type))
    selected_role_ids = access.get("selected_role_ids") if isinstance(access.get("selected_role_ids"), list) else []

    if restrictions.get("read_only"):
        return False
    return bool(effective_permissions.get("send_messages")) and is_allowed_by_server_channel_scope(access.get("write"), server_member, selected_role_ids)


def ensure_server_channel_message_allowed(conn, group_id, user_id, text="", includes_files=False, editing=False, message_type="text"):
    server_channel = get_server_channel_record(conn, group_id)
    if not server_channel:
        return
    server_member = get_server_member(conn, server_channel["server_id"], user_id)
    if not server_member:
        raise PermissionError("Недостаточно прав для канала сервера")
    if can_bypass_server_channel_restrictions(server_member):
        return

    access = parse_json_object(row_value(server_channel, "access_json"), build_default_channel_access(
        str(row_value(server_channel, "channel_type") or "text").strip().lower()
    ))
    restrictions = parse_json_object(row_value(server_channel, "restrictions_json"), build_default_channel_restrictions(
        str(row_value(server_channel, "channel_type") or "text").strip().lower()
    ))
    selected_role_ids = access.get("selected_role_ids") if isinstance(access.get("selected_role_ids"), list) else []
    permissions = get_server_channel_effective_message_permissions(conn, server_channel, server_member)
    normalized_message_type = str(message_type or "text").strip().lower() or "text"
    normalized_text = str(text or "")
    has_links = bool(MESSAGE_URL_PATTERN.search(normalized_text))
    has_everyone = text_has_everyone_mention(normalized_text)

    if normalized_message_type == "wide":
        if not permissions.get("send_announcements"):
            raise PermissionError("У вас нет права отправлять объявления в этот канал")
    else:
        if restrictions.get("read_only") and not editing:
            raise PermissionError("Канал работает в режиме только чтения")
        if not permissions.get("send_messages"):
            raise PermissionError("У вас нет права писать в этот канал")
        if not is_allowed_by_server_channel_scope(access.get("write"), server_member, selected_role_ids):
            raise PermissionError("У вас нет права писать в этот канал")
    if includes_files:
        if not permissions.get("send_files"):
            raise PermissionError("У вас нет права отправлять файлы в этот канал")
        if restrictions.get("block_files"):
            raise PermissionError("Отправка файлов в этом канале запрещена")
        if not is_allowed_by_server_channel_scope(access.get("files"), server_member, selected_role_ids):
            raise PermissionError("У вас нет права отправлять файлы в этот канал")
    if has_links:
        if not permissions.get("send_links"):
            raise PermissionError("У вас нет права отправлять ссылки в этот канал")
        if restrictions.get("block_links"):
            raise PermissionError("Ссылки в этом канале запрещены")
        if not is_allowed_by_server_channel_scope(access.get("links"), server_member, selected_role_ids):
            raise PermissionError("У вас нет права отправлять ссылки в этот канал")
    if has_everyone:
        if not permissions.get("mention_everyone"):
            raise PermissionError("У вас нет права упоминать @everyone в этом канале")
        if restrictions.get("block_everyone_mentions"):
            raise PermissionError("Упоминание @everyone в этом канале запрещено")
        if not is_allowed_by_server_channel_scope(access.get("everyone_mentions"), server_member, selected_role_ids):
            raise PermissionError("У вас нет права упоминать @everyone в этом канале")
    if not editing:
        slowmode_seconds = parse_slowmode_seconds(restrictions.get("slowmode"))
        if slowmode_seconds > 0:
            last_message_row = conn.execute("""
                SELECT created_at
                FROM group_messages
                WHERE group_id = %s
                  AND sender_id = %s
                  AND message_type != 'system'
                ORDER BY id DESC
                LIMIT 1
            """, (group_id, user_id)).fetchone()
            last_message_at = parse_datetime_value(row_value(last_message_row, "created_at")) if last_message_row else None
            if last_message_at and (datetime.now(timezone.utc) - last_message_at).total_seconds() < slowmode_seconds:
                raise PermissionError("Слишком быстро. Подождите перед следующей отправкой сообщения")


def can_delete_group_message_for_all(conn, group_id, actor_user_id, message_row):
    if not message_row:
        return False
    if int(row_value(message_row, "sender_id") or 0) == int(actor_user_id or 0):
        return True
    server_channel = get_server_channel_record(conn, group_id)
    if not server_channel:
        return False
    server_member = get_server_member(conn, int(row_value(server_channel, "server_id") or 0), actor_user_id)
    if not server_member:
        return False
    permissions = get_server_channel_effective_message_permissions(conn, server_channel, server_member)
    return bool(permissions.get("manage_messages") or permissions.get("delete_messages"))


def can_access_server(conn, user_id, server_id):
    return get_server_member(conn, server_id, user_id) is not None


def can_manage_server(conn, user_id, server_id):
    if not user_id:
        return False
    server = conn.execute("""
        SELECT owner_id
        FROM servers
        WHERE id = %s
        LIMIT 1
    """, (server_id,)).fetchone()
    if not server:
        return False
    if int(server["owner_id"]) == int(user_id):
        return True
    member = get_server_member(conn, server_id, user_id)
    return bool(member and member["is_admin"])


def server_member_has_permission(conn, server_id, server_member, permission_key):
    if not server_member:
        return False
    role_key = get_server_member_role_key(server_member)
    if role_key == "owner" or bool(row_value(server_member, "is_admin")):
        return True
    permissions = get_server_role_permissions_map(conn, server_id).get(role_key, {})
    if permissions.get("administrator"):
        return True
    return bool(permissions.get(permission_key))


def get_server_assignable_role_names(conn, server_id, actor_user_id):
    server = conn.execute("""
        SELECT owner_id
        FROM servers
        WHERE id = %s
        LIMIT 1
    """, (server_id,)).fetchone()
    if not server:
        return []
    if int(row_value(server, "owner_id") or 0) == int(actor_user_id or 0):
        return [
            str(role.get("name") or "").strip()
            for role in get_server_roles(conn, server_id)
            if str(role.get("name") or "").strip().lower() != "owner"
        ]
    actor_member = get_server_member(conn, server_id, actor_user_id)
    if not actor_member or not server_member_has_permission(conn, server_id, actor_member, "manage_roles"):
        return []
    return [
        str(role.get("name") or "").strip()
        for role in get_server_roles(conn, server_id)
        if str(role.get("name") or "").strip().lower() not in {"owner", "admin"}
    ]


def can_manage_server_member_action(conn, actor_user_id, server_id, target_user_id, permission_key=None, next_role_key=None):
    server = conn.execute("""
        SELECT owner_id
        FROM servers
        WHERE id = %s
        LIMIT 1
    """, (server_id,)).fetchone()
    if not server:
        return False
    owner_id = int(row_value(server, "owner_id") or 0)
    actor_id = int(actor_user_id or 0)
    target_id = int(target_user_id or 0)
    if not actor_id or not target_id or actor_id == target_id:
        return False

    actor_member = get_server_member(conn, server_id, actor_id)
    target_member = get_server_member(conn, server_id, target_id)
    if not actor_member or not target_member:
        return False

    if target_id == owner_id:
        return False

    if actor_id == owner_id:
        if next_role_key == "owner":
            return False
        return True

    if permission_key and not server_member_has_permission(conn, server_id, actor_member, permission_key):
        return False

    target_role_key = get_server_member_role_key(target_member)
    if bool(row_value(target_member, "is_admin")) or target_role_key in {"owner", "admin"}:
        return False

    if next_role_key in {"owner", "admin"}:
        return False

    return True


def normalize_boolean_flag(value, default=False):
    if isinstance(value, bool):
        return value
    if value is None:
        return bool(default)
    if isinstance(value, (int, float)):
        return bool(value)
    normalized = str(value).strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    return bool(default)


SERVER_ROLE_PERMISSION_KEYS = (
    "view_server",
    "manage_server",
    "manage_roles",
    "manage_channels",
    "view_audit_log",
    "invite_members",
    "kick_members",
    "ban_members",
    "manage_nicknames",
    "change_nickname",
    "read_messages",
    "send_messages",
    "delete_messages",
    "pin_messages",
    "embed_links",
    "attach_files",
    "mention_everyone",
    "manage_messages",
    "connect_voice",
    "speak_voice",
    "mute_members",
    "deafen_members",
    "move_members",
    "administrator",
    "display_separately",
    "mentionable",
)


def build_server_role_permissions(enabled_keys=None, enabled=False):
    enabled_keys = set(enabled_keys or [])
    return {
        key: (True if enabled else key in enabled_keys)
        for key in SERVER_ROLE_PERMISSION_KEYS
    }


DEFAULT_SERVER_ROLE_DEFINITIONS = [
    {
        "name": "owner",
        "color": "#f59e0b",
        "position": 300,
        "is_system": True,
        "permissions": build_server_role_permissions(enabled=True),
    },
    {
        "name": "admin",
        "color": "#ef4444",
        "position": 200,
        "is_system": True,
        "permissions": build_server_role_permissions({
            "view_server",
            "manage_server",
            "manage_roles",
            "manage_channels",
            "view_audit_log",
            "invite_members",
            "kick_members",
            "ban_members",
            "manage_nicknames",
            "change_nickname",
            "read_messages",
            "send_messages",
            "delete_messages",
            "pin_messages",
            "embed_links",
            "attach_files",
            "mention_everyone",
            "manage_messages",
            "connect_voice",
            "speak_voice",
            "mute_members",
            "deafen_members",
            "move_members",
            "display_separately",
            "mentionable",
        }),
    },
    {
        "name": "member",
        "color": "#94a3b8",
        "position": 100,
        "is_system": True,
        "permissions": build_server_role_permissions({
            "view_server",
            "change_nickname",
            "read_messages",
            "send_messages",
            "embed_links",
            "attach_files",
            "connect_voice",
            "speak_voice",
        }),
    },
]


def serialize_server_role_row(role_row):
    raw_permissions = row_value(role_row, "permissions_json")
    permissions = {}
    if raw_permissions:
        try:
            permissions = json.loads(raw_permissions)
        except (TypeError, ValueError, json.JSONDecodeError):
            permissions = {}
    return {
        "id": int(row_value(role_row, "id") or 0),
        "server_id": int(row_value(role_row, "server_id") or 0),
        "name": row_value(role_row, "name") or "role",
        "color": row_value(role_row, "color") or "#94a3b8",
        "position": int(row_value(role_row, "position") or 0),
        "is_system": bool(row_value(role_row, "is_system")),
        "permissions": permissions,
        "created_by": row_value(role_row, "created_by"),
        "created_at": format_timestamp(row_value(role_row, "created_at")),
    }


SERVER_CHANNEL_TYPES = {"text", "announcements", "private"}
SERVER_CHANNEL_ROLE_PERMISSION_KEYS = (
    "view_channel",
    "read_messages",
    "send_messages",
    "send_announcements",
    "send_files",
    "send_links",
    "manage_messages",
    "manage_channel",
)


def parse_json_object(value, fallback=None):
    fallback = fallback if isinstance(fallback, dict) else {}
    if not value:
        return dict(fallback)
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError, json.JSONDecodeError):
        return dict(fallback)
    return parsed if isinstance(parsed, dict) else dict(fallback)


def parse_json_list(value, fallback=None):
    fallback = fallback if isinstance(fallback, list) else []
    if not value:
        return list(fallback)
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError, json.JSONDecodeError):
        return list(fallback)
    return parsed if isinstance(parsed, list) else list(fallback)


def build_default_channel_role_permissions(channel_type="text"):
    is_private = channel_type == "private"
    return {
        "owner": {
            key: True for key in SERVER_CHANNEL_ROLE_PERMISSION_KEYS
        },
        "admin": {
            "view_channel": True,
            "read_messages": True,
            "send_messages": channel_type != "voice",
            "send_announcements": True,
            "send_files": channel_type != "voice",
            "send_links": channel_type != "voice",
            "manage_messages": True,
            "manage_channel": True,
        },
        "member": {
            "view_channel": not is_private,
            "read_messages": not is_private,
            "send_messages": channel_type not in {"voice", "announcements"} and not is_private,
            "send_announcements": False,
            "send_files": channel_type == "text" and not is_private,
            "send_links": channel_type == "text" and not is_private,
            "manage_messages": False,
            "manage_channel": False,
        },
    }


def build_default_channel_access(channel_type="text"):
    is_private = channel_type == "private"
    is_announcements = channel_type == "announcements"
    return {
        "view": "selected_roles" if is_private else "everyone",
        "write": "moderators_admins" if is_announcements else ("selected_roles" if is_private else "everyone"),
        "files": "moderators_admins" if is_announcements else ("selected_roles" if is_private else "everyone"),
        "links": "moderators_admins" if is_announcements else ("selected_roles" if is_private else "everyone"),
        "everyone_mentions": "admins" if is_private else "moderators_admins",
        "selected_role_ids": ["owner", "admin"] if is_private else [],
    }


def build_default_channel_rules():
    return [
        "Общайтесь по теме канала.",
        "Не публикуйте спам и вредоносные ссылки.",
    ]


def build_default_channel_restrictions(channel_type="text"):
    return {
        "slowmode": "off",
        "block_links": False,
        "block_files": False,
        "read_only": channel_type == "announcements",
        "block_everyone_mentions": False,
        "block_new_members": False,
    }


def normalize_server_channel_payload(data, existing=None):
    existing = existing or {}
    next_title = normalize_channel_title(data.get("title"), fallback=existing.get("title") or "")
    next_description = str(data.get("description") if data.get("description") is not None else existing.get("description") or "").strip() or None
    next_type = str(data.get("type") or existing.get("type") or "text").strip().lower()
    if next_type not in SERVER_CHANNEL_TYPES:
        next_type = "text"
    default_access = build_default_channel_access(next_type)
    default_role_permissions = build_default_channel_role_permissions(next_type)
    default_rules = build_default_channel_rules()
    default_restrictions = build_default_channel_restrictions(next_type)
    raw_access = data.get("access") if isinstance(data.get("access"), dict) else existing.get("access")
    raw_role_permissions = data.get("role_permissions") if isinstance(data.get("role_permissions"), dict) else existing.get("role_permissions")
    raw_rules = data.get("rules") if isinstance(data.get("rules"), list) else existing.get("rules")
    raw_restrictions = data.get("restrictions") if isinstance(data.get("restrictions"), dict) else existing.get("restrictions")
    access = {
        **default_access,
        **(raw_access if isinstance(raw_access, dict) else {}),
    }
    access["selected_role_ids"] = [
        str(value).strip() for value in (access.get("selected_role_ids") or [])
        if str(value).strip()
    ]
    role_permissions = {}
    source_role_permissions = raw_role_permissions if isinstance(raw_role_permissions, dict) else {}
    for role_key, defaults in default_role_permissions.items():
        current_values = source_role_permissions.get(role_key) if isinstance(source_role_permissions.get(role_key), dict) else {}
        role_permissions[role_key] = {
            permission_key: bool(current_values.get(permission_key, default_value))
            for permission_key, default_value in defaults.items()
        }
    for role_key, values in source_role_permissions.items():
        if role_key in role_permissions or not isinstance(values, dict):
            continue
        role_permissions[str(role_key)] = {
            permission_key: bool(values.get(permission_key))
            for permission_key in SERVER_CHANNEL_ROLE_PERMISSION_KEYS
        }
    rules = [
        str(rule).strip()
        for rule in (raw_rules if isinstance(raw_rules, list) else default_rules)
        if str(rule).strip()
    ]
    restrictions = {
        **default_restrictions,
        **(raw_restrictions if isinstance(raw_restrictions, dict) else {}),
    }
    return {
        "title": next_title,
        "description": next_description,
        "type": next_type,
        "access": access,
        "role_permissions": role_permissions,
        "rules": rules,
        "restrictions": restrictions,
    }


def serialize_server_channel_row(channel_row):
    channel_type = str(row_value(channel_row, "channel_type") or "text").strip().lower()
    if channel_type not in SERVER_CHANNEL_TYPES:
        channel_type = "text"
    existing_payload = {
        "title": row_value(channel_row, "title") or row_value(channel_row, "name") or row_value(channel_row, "group_title") or "channel",
        "description": row_value(channel_row, "description") or row_value(channel_row, "group_description"),
        "type": channel_type,
        "access": parse_json_object(row_value(channel_row, "access_json")),
        "role_permissions": parse_json_object(row_value(channel_row, "role_permissions_json")),
        "rules": parse_json_list(row_value(channel_row, "rules_json")),
        "restrictions": parse_json_object(row_value(channel_row, "restrictions_json")),
    }
    normalized = normalize_server_channel_payload({}, existing_payload)
    return {
        "id": int(row_value(channel_row, "group_id") or row_value(channel_row, "id") or 0),
        "server_channel_id": int(row_value(channel_row, "id") or 0),
        "server_id": int(row_value(channel_row, "server_id") or 0),
        "category_id": int(row_value(channel_row, "category_id") or 0),
        "title": normalized["title"],
        "description": normalized["description"],
        "type": normalized["type"],
        "position": int(row_value(channel_row, "position") or 0),
        "access": normalized["access"],
        "role_permissions": normalized["role_permissions"],
        "rules": normalized["rules"],
        "restrictions": normalized["restrictions"],
        "created_by": row_value(channel_row, "created_by"),
        "created_at": format_timestamp(row_value(channel_row, "created_at")),
    }


def ensure_default_server_roles(conn, server_id, actor_user_id=None):
    for definition in DEFAULT_SERVER_ROLE_DEFINITIONS:
        existing = conn.execute("""
            SELECT id, color, permissions_json
            FROM server_roles
            WHERE server_id = %s AND name = %s
            LIMIT 1
        """, (server_id, definition["name"])).fetchone()
        permissions_json = json.dumps(definition["permissions"], ensure_ascii=False)
        if existing:
            if definition["name"] == "owner":
                conn.execute("""
                    UPDATE server_roles
                    SET color = %s,
                        position = %s,
                        is_system = %s,
                        permissions_json = %s
                    WHERE id = %s
                """, (
                    definition["color"],
                    definition["position"],
                    1 if definition["is_system"] else 0,
                    permissions_json,
                    existing["id"],
                ))
            else:
                next_permissions_json = row_value(existing, "permissions_json") or permissions_json
                next_color = row_value(existing, "color") or definition["color"]
                conn.execute("""
                    UPDATE server_roles
                    SET color = %s,
                        position = %s,
                        is_system = %s,
                        permissions_json = %s
                    WHERE id = %s
                """, (
                    next_color,
                    definition["position"],
                    1 if definition["is_system"] else 0,
                    next_permissions_json,
                    existing["id"],
                ))
            continue
        conn.execute("""
            INSERT INTO server_roles (server_id, name, color, position, is_system, permissions_json, created_by)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
        """, (
            server_id,
            definition["name"],
            definition["color"],
            definition["position"],
            1 if definition["is_system"] else 0,
            permissions_json,
            actor_user_id,
        ))


def get_server_roles(conn, server_id):
    ensure_default_server_roles(conn, server_id)
    rows = conn.execute("""
        SELECT id, server_id, name, color, position, is_system, permissions_json, created_by, created_at
        FROM server_roles
        WHERE server_id = %s
        ORDER BY position DESC, id ASC
    """, (server_id,)).fetchall()
    return [serialize_server_role_row(row) for row in rows]


def generate_server_invite_token(conn):
    code = secrets.token_urlsafe(9)
    while conn.execute("SELECT 1 FROM server_invites WHERE code = %s LIMIT 1", (code,)).fetchone():
        code = secrets.token_urlsafe(9)
    return code


def build_server_invite_url(code):
    return f"{request.url_root.rstrip('/')}/server-invite/{code}"


def get_server_role_permissions_map(conn, server_id):
    permissions_map = {}
    for role in get_server_roles(conn, server_id):
        permissions_map[str(role.get("name") or "").strip().lower()] = (
            role.get("permissions") if isinstance(role.get("permissions"), dict) else {}
        )
    return permissions_map


def can_create_server_invites(conn, user_id, server_id):
    member = get_server_member(conn, server_id, user_id)
    if not member:
        return False
    role_key = get_server_member_role_key(member)
    if role_key in {"owner", "admin"} or bool(row_value(member, "is_admin")):
        return True
    permissions = get_server_role_permissions_map(conn, server_id).get(role_key, {})
    return bool(permissions.get("invite_members"))


def get_server_online_count(conn, server_id):
    member_rows = conn.execute("""
        SELECT user_id
        FROM server_members
        WHERE server_id = %s
    """, (server_id,)).fetchall()
    return sum(1 for row in member_rows if is_user_online(row["user_id"]))


def remove_server_member_from_server(conn, server_id, user_id):
    channel_rows = conn.execute("""
        SELECT group_id
        FROM server_channels
        WHERE server_id = %s
    """, (server_id,)).fetchall()
    group_ids = [int(row["group_id"]) for row in channel_rows if row and row["group_id"]]

    if group_ids:
        conn.executemany("""
            DELETE FROM group_members
            WHERE group_id = %s AND user_id = %s
        """, [(group_id, user_id) for group_id in group_ids])
        conn.executemany("""
            DELETE FROM group_read_states
            WHERE group_id = %s AND user_id = %s
        """, [(group_id, user_id) for group_id in group_ids])

    conn.execute("""
        DELETE FROM server_members
        WHERE server_id = %s AND user_id = %s
    """, (server_id, user_id))


def get_server_members_for_settings(conn, server_id, viewer_user_id=None):
    server = conn.execute("""
        SELECT id, owner_id
        FROM servers
        WHERE id = %s
        LIMIT 1
    """, (server_id,)).fetchone()
    if not server:
        return []

    member_rows = conn.execute("""
        SELECT
            u.id,
            u.name,
            u.username,
            u.bio,
            sm.is_admin,
            sm.role
        FROM server_members sm
        JOIN users u ON u.id = sm.user_id
        WHERE sm.server_id = %s
        ORDER BY
            CASE
                WHEN u.id = %s THEN 0
                WHEN sm.is_admin = 1 OR LOWER(COALESCE(sm.role, '')) = 'admin' THEN 1
                ELSE 2
            END,
            COALESCE(u.name, u.username),
            u.username
    """, (server_id, server["owner_id"])).fetchall()

    viewer_id = int(viewer_user_id or 0)
    assignable_role_names = get_server_assignable_role_names(conn, server_id, viewer_id) if viewer_id else []
    roles_by_key = {
        str(role_name).strip().lower(): str(role_name).strip()
        for role_name in assignable_role_names
        if str(role_name).strip()
    }
    members = []
    for member in member_rows:
        role_key = get_server_member_role_key(member)
        member_user_id = int(row_value(member, "id") or 0)
        can_kick_member = bool(viewer_id) and can_manage_server_member_action(
            conn,
            viewer_id,
            server_id,
            member_user_id,
            permission_key="kick_members",
        )
        can_ban_member = bool(viewer_id) and can_manage_server_member_action(
            conn,
            viewer_id,
            server_id,
            member_user_id,
            permission_key="ban_members",
        )
        assignable_roles = [
            roles_by_key[role_name]
            for role_name in roles_by_key
            if can_manage_server_member_action(
                conn,
                viewer_id,
                server_id,
                member_user_id,
                permission_key="manage_roles",
                next_role_key=role_name,
            )
        ]
        can_manage_member = can_kick_member or can_ban_member or bool(assignable_roles)
        members.append({
            **serialize_public_user(member),
            "is_admin": bool(row_value(member, "is_admin")),
            "is_owner": member_user_id == int(row_value(server, "owner_id") or 0),
            "server_role": role_key,
            "can_manage": can_manage_member,
            "can_kick": can_kick_member,
            "can_ban": can_ban_member,
            "assignable_roles": assignable_roles,
        })
    return members


def get_server_members_directory(conn, server_id):
    return [
        {
            **member,
            "can_manage": False,
            "can_kick": False,
            "can_ban": False,
            "assignable_roles": [],
        }
        for member in get_server_members_for_settings(conn, server_id, None)
    ]


def serialize_server_invite_row(invite_row, server_row=None, viewer_member=None):
    if not invite_row:
        return None
    expires_at = parse_datetime_value(row_value(invite_row, "expires_at"))
    max_uses = row_value(invite_row, "max_uses")
    uses_count = int(row_value(invite_row, "uses_count") or 0)
    is_expired = bool(expires_at and expires_at <= datetime.now(timezone.utc))
    is_revoked = bool(row_value(invite_row, "revoked"))
    is_exhausted = bool(max_uses is not None and uses_count >= int(max_uses))
    server_id = int(row_value(invite_row, "server_id") or row_value(server_row, "id") or 0)
    default_channel_id = row_value(server_row, "default_channel_id")
    server_name = row_value(invite_row, "server_title") or row_value(server_row, "title") or "Сервер"
    members_count = int(row_value(invite_row, "members_count") or row_value(server_row, "members_count") or 0)
    online_count = int(row_value(invite_row, "online_count") or row_value(server_row, "online_count") or 0)
    already_member = bool(viewer_member)
    return {
        "id": int(row_value(invite_row, "id") or 0),
        "code": row_value(invite_row, "code") or "",
        "server_id": server_id,
        "server_name": server_name,
        "server_avatar": None,
        "created_by": row_value(invite_row, "created_by"),
        "created_at": format_timestamp(row_value(invite_row, "created_at")),
        "expires_at": format_timestamp(expires_at),
        "max_uses": int(max_uses) if max_uses is not None else None,
        "uses": uses_count,
        "only_friends": bool(row_value(invite_row, "only_friends")),
        "one_time": bool(row_value(invite_row, "one_time")),
        "require_approval": bool(row_value(invite_row, "require_approval")),
        "revoked": is_revoked,
        "is_expired": is_expired,
        "is_exhausted": is_exhausted,
        "is_active": not (is_revoked or is_expired or is_exhausted),
        "members_count": members_count,
        "online_count": online_count,
        "already_member": already_member,
        "default_channel_id": int(default_channel_id) if default_channel_id else None,
        "url": build_server_invite_url(row_value(invite_row, "code") or ""),
        "path": f"/server-invite/{row_value(invite_row, 'code') or ''}",
    }


def get_server_summary_for_invites(conn, server_id):
    server_row = conn.execute("""
        SELECT
            s.id,
            s.title,
            s.invite_code,
            (
                SELECT COUNT(*)
                FROM server_members sm
                WHERE sm.server_id = s.id
            ) AS members_count
        FROM servers s
        WHERE s.id = %s
        LIMIT 1
    """, (server_id,)).fetchone()
    if not server_row:
        return None
    server_row = dict(server_row)
    server_row["online_count"] = get_server_online_count(conn, server_id)
    default_channel_row = conn.execute("""
        SELECT sc.group_id
        FROM server_channels sc
        WHERE sc.server_id = %s
        ORDER BY sc.position, sc.id
        LIMIT 1
    """, (server_id,)).fetchone()
    server_row["default_channel_id"] = row_value(default_channel_row, "group_id")
    return server_row


def get_server_primary_invite(conn, server_id):
    return conn.execute("""
        SELECT
            si.id,
            si.server_id,
            si.code,
            si.created_by,
            si.expires_at,
            si.max_uses,
            si.uses_count,
            si.only_friends,
            si.one_time,
            si.require_approval,
            si.revoked,
            si.created_at
        FROM servers s
        JOIN server_invites si
          ON si.server_id = s.id
         AND si.code = s.invite_code
        WHERE s.id = %s
          AND si.revoked = 0
        LIMIT 1
    """, (server_id,)).fetchone()


def get_active_server_invites(conn, server_id):
    return conn.execute("""
        SELECT id, server_id, code, created_by, expires_at, max_uses, uses_count,
               only_friends, one_time, require_approval, revoked, created_at
        FROM server_invites
        WHERE server_id = %s
          AND revoked = 0
        ORDER BY created_at DESC, id DESC
    """, (server_id,)).fetchall()


def ensure_server_primary_invite(conn, server_id, actor_user_id=None):
    server = conn.execute("""
        SELECT id, owner_id, invite_code
        FROM servers
        WHERE id = %s
        LIMIT 1
    """, (server_id,)).fetchone()
    if not server:
        return None

    code = str(row_value(server, "invite_code") or "").strip()
    if not code:
        code = generate_server_invite_code(conn)
        conn.execute("""
            UPDATE servers
            SET invite_code = %s
            WHERE id = %s
        """, (code, server_id))

    conn.execute("""
        UPDATE server_invites
        SET revoked = 1
        WHERE server_id = %s
          AND code != %s
          AND revoked = 0
    """, (server_id, code))

    invite = conn.execute("""
        SELECT id
        FROM server_invites
        WHERE code = %s
        LIMIT 1
    """, (code,)).fetchone()
    created_by = int(actor_user_id or row_value(server, "owner_id") or 0)
    if invite:
        conn.execute("""
            UPDATE server_invites
            SET server_id = %s,
                created_by = %s,
                expires_at = NULL,
                max_uses = NULL,
                only_friends = 0,
                one_time = 0,
                require_approval = 0,
                revoked = 0
            WHERE id = %s
        """, (server_id, created_by, invite["id"]))
    else:
        conn.execute("""
            INSERT INTO server_invites (
                server_id, code, created_by, expires_at, max_uses, only_friends, one_time, require_approval, revoked
            )
            VALUES (%s, %s, %s, NULL, NULL, 0, 0, 0, 0)
        """, (server_id, code, created_by))

    return conn.execute("""
        SELECT id, server_id, code, created_by, expires_at, max_uses, uses_count,
               only_friends, one_time, require_approval, revoked, created_at
        FROM server_invites
        WHERE code = %s
        LIMIT 1
    """, (code,)).fetchone()


def create_server_invite(conn, server_id, created_by, settings=None):
    settings = settings if isinstance(settings, dict) else {}
    code = generate_server_invite_token(conn)
    expires_at = settings.get("expires_at")
    max_uses = settings.get("max_uses")
    conn.execute("""
        INSERT INTO server_invites (
            server_id, code, created_by, expires_at, max_uses, only_friends, one_time, require_approval, revoked
        )
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 0)
    """, (
        server_id,
        code,
        created_by,
        to_db_datetime(expires_at) if isinstance(expires_at, datetime) else None,
        max_uses,
        1 if settings.get("only_friends") else 0,
        1 if settings.get("one_time") else 0,
        1 if settings.get("require_approval") else 0,
    ))
    return conn.execute("""
        SELECT id, server_id, code, created_by, expires_at, max_uses, uses_count,
               only_friends, one_time, require_approval, revoked, created_at
        FROM server_invites
        WHERE code = %s
        LIMIT 1
    """, (code,)).fetchone()


def get_server_invite_by_code(conn, code):
    invite = conn.execute("""
        SELECT
            si.id,
            si.server_id,
            si.code,
            si.created_by,
            si.expires_at,
            si.max_uses,
            si.uses_count,
            si.only_friends,
            si.one_time,
            si.require_approval,
            si.revoked,
            si.created_at,
            s.title AS server_title
        FROM server_invites si
        JOIN servers s ON s.id = si.server_id
        WHERE si.code = %s
        LIMIT 1
    """, (code,)).fetchone()
    if invite:
        return invite
    server = conn.execute("""
        SELECT id
        FROM servers
        WHERE invite_code = %s
        LIMIT 1
    """, (code,)).fetchone()
    if not server:
        return None
    return ensure_server_primary_invite(conn, int(server["id"]))

def get_server_member_ids(conn, server_id):
    rows = conn.execute("""
        SELECT user_id
        FROM server_members
        WHERE server_id = %s
    """, (server_id,)).fetchall()
    return [int(row["user_id"]) for row in rows]


def get_server_category(conn, server_id, category_id):
    return conn.execute("""
        SELECT id, server_id, COALESCE(title, name) AS title, position
        FROM server_categories
        WHERE server_id = %s AND id = %s
        LIMIT 1
    """, (server_id, category_id)).fetchone()


def get_server_channel(conn, server_id, group_id):
    return conn.execute("""
        SELECT
            sc.id,
            sc.server_id,
            sc.category_id,
            sc.group_id,
            sc.name,
            sc.description,
            sc.channel_type,
            sc.access_json,
            sc.role_permissions_json,
            sc.rules_json,
            sc.restrictions_json,
            sc.created_by,
            sc.created_at,
            g.title AS group_title,
            g.description AS group_description,
            COALESCE(sc.title, sc.name, g.title) AS title,
            sc.position
        FROM server_channels sc
        JOIN `groups` g ON g.id = sc.group_id
        WHERE sc.server_id = %s AND sc.group_id = %s
        LIMIT 1
    """, (server_id, group_id)).fetchone()


def emit_server_structure_updated_for_users(user_ids, server_id):
    payload = {
        "server_id": int(server_id)
    }
    for user_id in {int(user_id) for user_id in user_ids if user_id}:
        socketio.emit("server_structure_updated", payload, room=get_user_room(user_id))


def emit_server_structure_updated(conn, server_id):
    emit_server_structure_updated_for_users(get_server_member_ids(conn, server_id), server_id)


def get_first_server_channel_id(conn, server_id, user_id):
    row = conn.execute("""
        SELECT sc.group_id
        FROM server_channels sc
        JOIN group_members gm ON gm.group_id = sc.group_id
        WHERE sc.server_id = %s AND gm.user_id = %s
        ORDER BY sc.position, sc.id
        LIMIT 1
    """, (server_id, user_id)).fetchone()
    return row["group_id"] if row else None


def create_server_channel_group(conn, server_id, category_id, creator_user_id, title, description=None, channel_type="text", access=None, role_permissions=None, rules=None, restrictions=None):
    normalized_title = normalize_channel_title(title)
    normalized_payload = normalize_server_channel_payload({
        "title": normalized_title,
        "description": description,
        "type": channel_type,
        "access": access,
        "role_permissions": role_permissions,
        "rules": rules,
        "restrictions": restrictions,
    })
    next_position_row = conn.execute("""
        SELECT COALESCE(MAX(position), -1) + 1 AS next_position
        FROM server_channels
        WHERE server_id = %s AND category_id = %s
    """, (server_id, category_id)).fetchone()
    next_position = int(next_position_row["next_position"] or 0)

    conn.execute("""
        INSERT INTO `groups` (title, description, owner_id)
        VALUES (%s, %s, %s)
    """, (normalized_payload["title"], normalized_payload["description"], creator_user_id))
    group_id = conn.execute("SELECT LAST_INSERT_ID() AS id").fetchone()["id"]

    server_members = conn.execute("""
        SELECT user_id, is_admin
        FROM server_members
        WHERE server_id = %s
    """, (server_id,)).fetchall()
    member_rows = [
        (group_id, int(member["user_id"]), 1 if int(member["user_id"]) == int(creator_user_id) or bool(member["is_admin"]) else 0)
        for member in server_members
    ]
    if member_rows:
        conn.executemany("""
            INSERT OR IGNORE INTO group_members (group_id, user_id, is_admin)
            VALUES (%s, %s, %s)
        """, member_rows)
        for _, member_user_id, _ in member_rows:
            initialize_group_read_state(conn, group_id, member_user_id)

    conn.execute("""
        INSERT INTO server_channels (
            server_id, category_id, group_id, title, name, slug, description, channel_type,
            access_json, role_permissions_json, rules_json, restrictions_json, position, created_by
        )
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
    """, (
        server_id,
        category_id,
        group_id,
        normalized_payload["title"],
        normalized_payload["title"],
        normalized_payload["title"],
        normalized_payload["description"],
        normalized_payload["type"],
        json.dumps(normalized_payload["access"], ensure_ascii=False),
        json.dumps(normalized_payload["role_permissions"], ensure_ascii=False),
        json.dumps(normalized_payload["rules"], ensure_ascii=False),
        json.dumps(normalized_payload["restrictions"], ensure_ascii=False),
        next_position,
        creator_user_id,
    ))
    append_server_audit_log(conn, server_id, creator_user_id, "create_channel", details={
        "category_id": category_id,
        "group_id": group_id,
        "title": normalized_payload["title"],
        "type": normalized_payload["type"],
    })
    return group_id


def create_server_with_defaults(conn, owner_id, title, description="", allow_member_invites=False):
    normalized_title = normalize_server_title(title)
    invite_code = generate_server_invite_code(conn)
    conn.execute("""
        INSERT INTO servers (title, description, owner_id, invite_code, allow_member_invites)
        VALUES (%s, %s, %s, %s, %s)
    """, (
        normalized_title,
        str(description or "").strip() or None,
        owner_id,
        invite_code,
        1 if allow_member_invites else 0,
    ))
    server_id = conn.execute("SELECT LAST_INSERT_ID() AS id").fetchone()["id"]
    conn.execute("""
        INSERT INTO server_members (server_id, user_id, is_admin)
        VALUES (%s, %s, 1)
    """, (server_id, owner_id))
    conn.execute("""
        UPDATE server_members
        SET role = 'owner'
        WHERE server_id = %s AND user_id = %s
    """, (server_id, owner_id))
    ensure_default_server_roles(conn, server_id, owner_id)
    conn.execute("""
        INSERT INTO server_categories (server_id, title, name, position, created_by)
        VALUES (%s, %s, %s, 0, %s)
    """, (server_id, "Общий", "Общий", owner_id))
    category_id = conn.execute("SELECT LAST_INSERT_ID() AS id").fetchone()["id"]
    group_id = create_server_channel_group(conn, server_id, category_id, owner_id, "general")
    ensure_server_primary_invite(conn, server_id, owner_id)
    return {
        "server_id": server_id,
        "category_id": category_id,
        "group_id": group_id
    }


def build_server_response(conn, server_id, viewer_user_id):
    server = conn.execute("""
        SELECT s.id, s.title, s.description, s.owner_id, s.invite_code, s.allow_member_invites, s.created_at
        FROM servers s
        JOIN server_members sm ON sm.server_id = s.id
        WHERE s.id = %s AND sm.user_id = %s
        LIMIT 1
    """, (server_id, viewer_user_id)).fetchone()
    if not server:
        return None

    categories = conn.execute("""
        SELECT id, COALESCE(title, name) AS title, position
        FROM server_categories
        WHERE server_id = %s
        ORDER BY position, id
    """, (server_id,)).fetchall()
    channel_rows = conn.execute("""
        SELECT
            sc.id,
            sc.category_id,
            sc.group_id,
            sc.position,
            sc.description,
            sc.channel_type,
            sc.access_json,
            sc.role_permissions_json,
            sc.rules_json,
            sc.restrictions_json,
            sc.created_by,
            sc.created_at,
            COALESCE(sc.title, sc.name, g.title) AS title,
            (
                SELECT gm.text
                FROM group_messages gm
                WHERE gm.group_id = sc.group_id
                  AND NOT EXISTS (
                      SELECT 1
                      FROM hidden_group_messages hgm
                      WHERE hgm.group_message_id = gm.id AND hgm.user_id = %s
                  )
                ORDER BY gm.created_at DESC, gm.id DESC
                LIMIT 1
            ) AS last_message_text,
            (
                SELECT gm.message_type
                FROM group_messages gm
                WHERE gm.group_id = sc.group_id
                  AND NOT EXISTS (
                      SELECT 1
                      FROM hidden_group_messages hgm
                      WHERE hgm.group_message_id = gm.id AND hgm.user_id = %s
                  )
                ORDER BY gm.created_at DESC, gm.id DESC
                LIMIT 1
            ) AS last_message_type,
            (
                SELECT gm.created_at
                FROM group_messages gm
                WHERE gm.group_id = sc.group_id
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
                WHERE gm.group_id = sc.group_id
                  AND gm.message_type != 'system'
                  AND gm.sender_id != %s
                  AND gm.id > COALESCE((
                      SELECT grs.last_read_message_id
                      FROM group_read_states grs
                      WHERE grs.group_id = sc.group_id AND grs.user_id = %s
                  ), 0)
                  AND NOT EXISTS (
                      SELECT 1
                      FROM hidden_group_messages hgm
                      WHERE hgm.group_message_id = gm.id AND hgm.user_id = %s
                  )
            ) AS unread_count
        FROM server_channels sc
        JOIN `groups` g ON g.id = sc.group_id
        JOIN group_members gmbr ON gmbr.group_id = sc.group_id
        WHERE sc.server_id = %s AND gmbr.user_id = %s
        ORDER BY sc.position, sc.id
    """, (
        viewer_user_id,
        viewer_user_id,
        viewer_user_id,
        viewer_user_id,
        viewer_user_id,
        viewer_user_id,
        server_id,
        viewer_user_id
    )).fetchall()

    channels_by_category = {}
    total_unread = 0
    latest_updated_at = server["created_at"]
    latest_preview = None
    default_channel_id = None
    for channel in channel_rows:
        if default_channel_id is None:
            default_channel_id = channel["group_id"]
        unread_count = int(channel["unread_count"] or 0)
        total_unread += unread_count
        channel_updated_at = channel["updated_at"] or server["created_at"]
        if channel_updated_at and (latest_updated_at is None or channel_updated_at > latest_updated_at):
            latest_updated_at = channel_updated_at
            latest_preview = {
                "text": channel["last_message_text"],
                "message_type": channel["last_message_type"] or "text"
            } if channel["last_message_text"] is not None or channel["last_message_type"] is not None else None
        serialized_channel = serialize_server_channel_row(channel)
        channels_by_category.setdefault(channel["category_id"], []).append({
            **serialized_channel,
            "unread_count": unread_count,
            "updated_at": format_timestamp(channel["updated_at"]),
            "last_message": {
                "text": channel["last_message_text"],
                "message_type": channel["last_message_type"] or "text"
            } if channel["last_message_text"] is not None or channel["last_message_type"] is not None else None
        })

    can_invite_members = can_create_server_invites(conn, viewer_user_id, server_id)
    can_manage_current_server = can_manage_server(conn, viewer_user_id, server_id)
    can_view_audit_current_server = can_view_server_audit_log(conn, viewer_user_id, server_id)
    roles = get_server_roles(conn, server_id)

    return {
        "id": server["id"],
        "title": server["title"],
        "description": server["description"],
        "started_at": format_timestamp(server["created_at"]),
        "owner_id": server["owner_id"],
        "invite_code": row_value(server, "invite_code"),
        "allow_member_invites": bool(row_value(server, "allow_member_invites")),
        "is_owner": int(server["owner_id"]) == int(viewer_user_id),
        "can_manage_server": can_manage_current_server,
        "can_view_audit_log": can_view_audit_current_server,
        "default_channel_id": default_channel_id,
        "unread_count": total_unread,
        "updated_at": format_timestamp(latest_updated_at),
        "last_message": latest_preview,
        "can_invite_members": can_invite_members,
        "roles": roles,
        "member_directory": get_server_members_directory(conn, server_id),
        "members": get_server_members_for_settings(conn, server_id, viewer_user_id) if can_manage_current_server else [],
        "audit_log": get_server_audit_log_entries(conn, server_id) if can_view_audit_current_server else [],
        "active_invites": [
            serialize_server_invite_row(
                invite_row,
                server_row={
                    "id": server["id"],
                    "title": server["title"],
                    "members_count": conn.execute(
                        "SELECT COUNT(*) AS total FROM server_members WHERE server_id = %s",
                        (server_id,)
                    ).fetchone()["total"],
                    "online_count": get_server_online_count(conn, server_id),
                    "default_channel_id": default_channel_id,
                },
                viewer_member=get_server_member(conn, server_id, viewer_user_id)
            )
            for invite_row in get_active_server_invites(conn, server_id)
        ] if can_invite_members else [],
        "categories": [
            {
                "id": category["id"],
                "title": category["title"],
                "position": int(category["position"] or 0),
                "channels": channels_by_category.get(category["id"], [])
            }
            for category in categories
        ]
    }


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
        "can_send_messages": True,
        "members_count": members_count_row["members_count"],
        "messages_count": messages_count_row["messages_count"] if messages_count_row else 0,
        "current_user_permissions": {
            "send_messages": True,
            "send_announcements": False,
            "manage_messages": bool(viewer_member and viewer_member["is_admin"]),
            "manage_channel": False,
        },
        "members": members
    }

    can_manage_invite = can_edit_group_details(conn, viewer_user_id, group_id)
    payload["can_manage_invite"] = can_manage_invite
    payload["invite"] = serialize_group_invite(
        ensure_active_group_invite(conn, group_id, viewer_user_id or group["owner_id"])
    ) if can_manage_invite else None

    server_channel = get_server_channel_record(conn, group_id)
    if server_channel:
        server_member = get_server_member(conn, server_channel["server_id"], viewer_user_id)
        channel_permissions = get_server_channel_effective_message_permissions(conn, server_channel, server_member) if server_member else {}
        payload["server"] = {
            "id": server_channel["server_id"],
            "title": server_channel["server_title"],
            "description": server_channel["server_description"],
            "category_id": server_channel["category_id"],
            "category_title": server_channel["category_title"]
        }
        payload["can_send_messages"] = can_send_messages_in_server_channel(conn, group_id, viewer_user_id)
        payload["current_user_permissions"] = {
            "send_messages": bool(payload["can_send_messages"]),
            "send_announcements": bool(channel_permissions.get("send_announcements")),
            "send_files": bool(channel_permissions.get("send_files")),
            "send_links": bool(channel_permissions.get("send_links")),
            "delete_messages": bool(channel_permissions.get("delete_messages")),
            "manage_messages": bool(channel_permissions.get("manage_messages")),
            "manage_channel": bool(channel_permissions.get("manage_channel")),
        }
        payload["can_edit_group"] = False
        payload["can_add_members"] = False
        payload["can_manage_admins"] = False
        payload["can_manage_invite"] = False
        payload["invite"] = None

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


def get_typing_room(chat_type, chat_id):
    return f"group_{int(chat_id)}" if chat_type == "group" else f"direct_{int(chat_id)}"


def get_typing_context(conn, user_id, chat_type, chat_id):
    if chat_type == "group":
        if not can_access_group(conn, user_id, chat_id):
            return None
        user = conn.execute("""
            SELECT id, name, username
            FROM users
            WHERE id = %s
        """, (user_id,)).fetchone()
        return {
            "room": get_typing_room(chat_type, chat_id),
            "chat_type": "group",
            "chat_id": int(chat_id),
            "user": user
        }

    if not can_access_direct_chat(conn, user_id, chat_id):
        return None

    chat = conn.execute("""
        SELECT user1_id, user2_id
        FROM chats
        WHERE id = %s
    """, (chat_id,)).fetchone()
    if not chat:
        return None

    recipient_id = chat["user2_id"] if int(chat["user1_id"]) == int(user_id) else chat["user1_id"]
    recipient = conn.execute("""
        SELECT id, name, username
        FROM users
        WHERE id = %s
    """, (recipient_id,)).fetchone()
    return {
        "room": get_typing_room(chat_type, chat_id),
        "chat_type": "direct",
        "chat_id": int(chat_id),
        "user": recipient
    }


def clear_typing_session(sid, *, emit_stop=True):
    state = typing_sessions.pop(sid, None)
    if not state or not emit_stop:
        return

    socketio.emit("typing_stopped", {
        "chat_type": state["chat_type"],
        "chat_id": state["chat_id"],
        "user_id": state["user_id"]
    }, room=state["room"], skip_sid=sid)


def serialize_direct_message(message):
    return {
        "id": message["id"],
        "sender_id": message["sender_id"],
        "sender_name": message["sender_name"],
        "text": message["text"],
        "message_type": row_value(message, "message_type", "text") or "text",
        "reply": serialize_message_reply(message),
        "forwarded_from": serialize_message_forwarded_from(message),
        "forwarded_dialog": serialize_message_forwarded_dialog(message),
        "link_preview": serialize_message_link_preview(message),
        "audio": serialize_message_audio(message),
        "image": serialize_message_image(message),
        "attachments": serialize_message_attachments(message),
        "sticker": serialize_message_sticker(message),
        "created_at": format_timestamp(message["created_at"]),
        "is_read": bool(message["read_at"]),
        "is_edited": bool(message["edited_at"])
    }


def serialize_group_message(message):
    message_type = row_value(message, "message_type", "text") or "text"
    return {
        "id": message["id"],
        "sender_id": message["sender_id"],
        "sender_name": message["sender_name"],
        "text": message["text"],
        "reply": serialize_message_reply(message),
        "forwarded_from": serialize_message_forwarded_from(message),
        "forwarded_dialog": serialize_message_forwarded_dialog(message),
        "link_preview": serialize_message_link_preview(message),
        "audio": serialize_message_audio(message),
        "image": serialize_message_image(message),
        "attachments": serialize_message_attachments(message),
        "sticker": serialize_message_sticker(message),
        "message_type": message_type,
        "type": message_type,
        "layout": "wide" if message_type in {"wide", "special"} else None,
        "badge": row_value(message, "badge"),
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
          AND gm.message_type != 'system'
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
          AND message_type != 'system'
    """, (group_id,)).fetchone()
    last_message_id = latest_row["last_message_id"] if latest_row else None
    if not last_message_id:
        return

    conn.execute("""
        INSERT OR IGNORE INTO group_read_states (group_id, user_id, last_read_message_id, last_read_at)
        VALUES (%s, %s, %s, CURRENT_TIMESTAMP)
    """, (group_id, user_id, last_message_id))


def get_direct_message_for_chat(conn, chat_id, message_id):
    message = conn.execute("""
        SELECT
            m.id,
            m.chat_id,
            m.sender_id,
            u.name AS sender_name,
            m.text,
            m.message_type,
            m.reply_to_message_id,
            m.reply_preview_text,
            m.reply_preview_sender_name,
            m.reply_preview_message_type,
            m.forwarded_from_user_id,
            m.forwarded_from_sender_name,
            m.forwarded_dialog_payload,
            m.preview_url,
            m.preview_title,
            m.preview_description,
            m.preview_site_name,
            m.audio_url,
            m.audio_mime_type,
            m.audio_duration_ms,
            m.image_url,
            m.image_mime_type,
            m.sticker_id,
            m.sticker_asset_path,
            m.created_at,
            m.read_at,
            m.edited_at
        FROM messages m
        JOIN users u ON u.id = m.sender_id
        WHERE m.id = %s AND m.chat_id = %s
    """, (message_id, chat_id)).fetchone()
    if ensure_message_preview_data(conn, "messages", message):
        conn.commit()
    attach_message_attachments(conn, "direct", message)
    return message


def get_group_message_for_group(conn, group_id, message_id):
    message = conn.execute("""
        SELECT
            gm.id,
            gm.group_id,
            gm.sender_id,
            u.name AS sender_name,
            gm.text,
            gm.message_type,
            gm.badge,
            gm.reply_to_message_id,
            gm.reply_preview_text,
            gm.reply_preview_sender_name,
            gm.reply_preview_message_type,
            gm.forwarded_from_user_id,
            gm.forwarded_from_sender_name,
            gm.forwarded_dialog_payload,
            gm.preview_url,
            gm.preview_title,
            gm.preview_description,
            gm.preview_site_name,
            gm.audio_url,
            gm.audio_mime_type,
            gm.audio_duration_ms,
            gm.image_url,
            gm.image_mime_type,
            gm.sticker_id,
            gm.sticker_asset_path,
            gm.created_at,
            gm.edited_at
        FROM group_messages gm
        JOIN users u ON u.id = gm.sender_id
        WHERE gm.id = %s AND gm.group_id = %s
    """, (message_id, group_id)).fetchone()
    if ensure_message_preview_data(conn, "group_messages", message):
        conn.commit()
    attach_message_attachments(conn, "group", message)
    return message


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


def parse_message_create_payload():
    content_type = str(request.content_type or "").split(";", 1)[0].strip().lower()
    if request.files or content_type == "multipart/form-data":
        text = str(request.form.get("text", "") or "").strip()
        message_type = str(request.form.get("type", "") or "").strip()
        layout = str(request.form.get("layout", "") or "").strip()
        badge = str(request.form.get("badge", "") or "").strip()
        reply_to_id = request.form.get("reply_to_id")
        images = request.files.getlist("images[]") or request.files.getlist("images")
        files = request.files.getlist("files[]") or request.files.getlist("files")
        return {
            "text": text,
            "type": message_type,
            "layout": layout,
            "badge": badge,
            "reply_to_id": reply_to_id,
            "images": [image for image in images if image and image.filename],
            "files": [file for file in files if file and file.filename],
            "is_multipart": True
        }

    data = request.get_json(silent=True) or {}
    return {
        "text": str(data.get("text", "") or "").strip(),
        "type": str(data.get("type", "") or "").strip(),
        "layout": str(data.get("layout", "") or "").strip(),
        "badge": str(data.get("badge", "") or "").strip(),
        "reply_to_id": data.get("reply_to_id"),
        "images": [],
        "files": [],
        "is_multipart": False
    }


def text_contains_invite_link(text):
    return bool(text and INVITE_URL_PATTERN.search(str(text).strip()))


def is_duplicate_recent_direct_invite(conn, chat_id, sender_id, text):
    if not text_contains_invite_link(text):
        return False
    row = conn.execute("""
        SELECT sender_id, text, message_type
        FROM messages
        WHERE chat_id = %s
        ORDER BY id DESC
        LIMIT 1
    """, (chat_id,)).fetchone()
    if not row:
        return False
    return (
        int(row_value(row, "sender_id", 0) or 0) == int(sender_id)
        and str(row_value(row, "message_type", "") or "") == "text"
        and str(row_value(row, "text", "") or "").strip() == str(text or "").strip()
    )


def is_duplicate_recent_group_invite(conn, group_id, sender_id, text):
    if not text_contains_invite_link(text):
        return False
    row = conn.execute("""
        SELECT sender_id, text, message_type
        FROM group_messages
        WHERE group_id = %s
        ORDER BY id DESC
        LIMIT 1
    """, (group_id,)).fetchone()
    if not row:
        return False
    return (
        int(row_value(row, "sender_id", 0) or 0) == int(sender_id)
        and str(row_value(row, "message_type", "") or "") == "text"
        and str(row_value(row, "text", "") or "").strip() == str(text or "").strip()
    )


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
            m.message_type,
            m.reply_to_message_id,
            m.reply_preview_text,
            m.reply_preview_sender_name,
            m.reply_preview_message_type,
            m.forwarded_from_user_id,
            m.forwarded_from_sender_name,
            m.forwarded_dialog_payload,
            m.preview_url,
            m.preview_title,
            m.preview_description,
            m.preview_site_name,
            m.audio_url,
            m.audio_mime_type,
            m.audio_duration_ms,
            m.image_url,
            m.image_mime_type,
            m.sticker_id,
            m.sticker_asset_path,
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
    ensure_message_preview_data_many(conn, "messages", page_rows)
    attach_message_attachments(conn, "direct", page_rows)
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
            gm.badge,
            gm.reply_to_message_id,
            gm.reply_preview_text,
            gm.reply_preview_sender_name,
            gm.reply_preview_message_type,
            gm.forwarded_from_user_id,
            gm.forwarded_from_sender_name,
            gm.forwarded_dialog_payload,
            gm.preview_url,
            gm.preview_title,
            gm.preview_description,
            gm.preview_site_name,
            gm.audio_url,
            gm.audio_mime_type,
            gm.audio_duration_ms,
            gm.image_url,
            gm.image_mime_type,
            gm.sticker_id,
            gm.sticker_asset_path,
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
    ensure_message_preview_data_many(conn, "group_messages", page_rows)
    attach_message_attachments(conn, "group", page_rows)
    return page_rows, has_more


def search_direct_messages(conn, chat_id, user_id, query, limit):
    pattern = f"%{query}%"
    rows = conn.execute("""
        SELECT
            m.id,
            m.sender_id,
            u.name AS sender_name,
            m.text,
            m.message_type,
            m.reply_to_message_id,
            m.reply_preview_text,
            m.reply_preview_sender_name,
            m.reply_preview_message_type,
            m.forwarded_from_user_id,
            m.forwarded_from_sender_name,
            m.forwarded_dialog_payload,
            m.preview_url,
            m.preview_title,
            m.preview_description,
            m.preview_site_name,
            m.audio_url,
            m.audio_mime_type,
            m.audio_duration_ms,
            m.image_url,
            m.image_mime_type,
            m.sticker_id,
            m.sticker_asset_path,
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
    rows = ensure_message_preview_data_many(conn, "messages", rows)
    attach_message_attachments(conn, "direct", rows)
    return rows


def search_group_messages(conn, group_id, user_id, query, limit):
    pattern = f"%{query}%"
    rows = conn.execute("""
        SELECT
            gm.id,
            gm.sender_id,
            u.name AS sender_name,
            gm.text,
            gm.message_type,
            gm.badge,
            gm.reply_to_message_id,
            gm.reply_preview_text,
            gm.reply_preview_sender_name,
            gm.reply_preview_message_type,
            gm.forwarded_from_user_id,
            gm.forwarded_from_sender_name,
            gm.forwarded_dialog_payload,
            gm.preview_url,
            gm.preview_title,
            gm.preview_description,
            gm.preview_site_name,
            gm.audio_url,
            gm.audio_mime_type,
            gm.audio_duration_ms,
            gm.image_url,
            gm.image_mime_type,
            gm.sticker_id,
            gm.sticker_asset_path,
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
    rows = ensure_message_preview_data_many(conn, "group_messages", rows)
    attach_message_attachments(conn, "group", rows)
    return rows


def fetch_direct_message_context(conn, chat_id, user_id, message_id, limit):
    target = conn.execute("""
        SELECT
            m.id,
            m.sender_id,
            u.name AS sender_name,
            m.text,
            m.message_type,
            m.reply_to_message_id,
            m.reply_preview_text,
            m.reply_preview_sender_name,
            m.reply_preview_message_type,
            m.forwarded_from_user_id,
            m.forwarded_from_sender_name,
            m.forwarded_dialog_payload,
            m.preview_url,
            m.preview_title,
            m.preview_description,
            m.preview_site_name,
            m.audio_url,
            m.audio_mime_type,
            m.audio_duration_ms,
            m.image_url,
            m.image_mime_type,
            m.sticker_id,
            m.sticker_asset_path,
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
    target_touched = ensure_message_preview_data(conn, "messages", target)

    before_rows = conn.execute("""
        SELECT
            m.id,
            m.sender_id,
            u.name AS sender_name,
            m.text,
            m.message_type,
            m.reply_to_message_id,
            m.reply_preview_text,
            m.reply_preview_sender_name,
            m.reply_preview_message_type,
            m.forwarded_from_user_id,
            m.forwarded_from_sender_name,
            m.forwarded_dialog_payload,
            m.preview_url,
            m.preview_title,
            m.preview_description,
            m.preview_site_name,
            m.audio_url,
            m.audio_mime_type,
            m.audio_duration_ms,
            m.image_url,
            m.image_mime_type,
            m.sticker_id,
            m.sticker_asset_path,
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
            m.message_type,
            m.reply_to_message_id,
            m.reply_preview_text,
            m.reply_preview_sender_name,
            m.reply_preview_message_type,
            m.forwarded_from_user_id,
            m.forwarded_from_sender_name,
            m.forwarded_dialog_payload,
            m.preview_url,
            m.preview_title,
            m.preview_description,
            m.preview_site_name,
            m.audio_url,
            m.audio_mime_type,
            m.audio_duration_ms,
            m.image_url,
            m.image_mime_type,
            m.sticker_id,
            m.sticker_asset_path,
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

    ensure_message_preview_data_many(conn, "messages", before_rows)
    ensure_message_preview_data_many(conn, "messages", after_rows)
    if target_touched:
        conn.commit()
    messages = list(reversed(before_rows)) + [target] + list(after_rows)
    attach_message_attachments(conn, "direct", messages)
    return messages, has_more_before, has_more_after


def fetch_group_message_context(conn, group_id, user_id, message_id, limit):
    target = conn.execute("""
        SELECT
            gm.id,
            gm.sender_id,
            u.name AS sender_name,
            gm.text,
            gm.message_type,
            gm.badge,
            gm.reply_to_message_id,
            gm.reply_preview_text,
            gm.reply_preview_sender_name,
            gm.reply_preview_message_type,
            gm.forwarded_from_user_id,
            gm.forwarded_from_sender_name,
            gm.forwarded_dialog_payload,
            gm.preview_url,
            gm.preview_title,
            gm.preview_description,
            gm.preview_site_name,
            gm.audio_url,
            gm.audio_mime_type,
            gm.audio_duration_ms,
            gm.image_url,
            gm.image_mime_type,
            gm.sticker_id,
            gm.sticker_asset_path,
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
    target_touched = ensure_message_preview_data(conn, "group_messages", target)

    before_rows = conn.execute("""
        SELECT
            gm.id,
            gm.sender_id,
            u.name AS sender_name,
            gm.text,
            gm.message_type,
            gm.badge,
            gm.reply_to_message_id,
            gm.reply_preview_text,
            gm.reply_preview_sender_name,
            gm.reply_preview_message_type,
            gm.forwarded_from_user_id,
            gm.forwarded_from_sender_name,
            gm.forwarded_dialog_payload,
            gm.preview_url,
            gm.preview_title,
            gm.preview_description,
            gm.preview_site_name,
            gm.audio_url,
            gm.audio_mime_type,
            gm.audio_duration_ms,
            gm.image_url,
            gm.image_mime_type,
            gm.sticker_id,
            gm.sticker_asset_path,
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
            gm.badge,
            gm.reply_to_message_id,
            gm.reply_preview_text,
            gm.reply_preview_sender_name,
            gm.reply_preview_message_type,
            gm.forwarded_from_user_id,
            gm.forwarded_from_sender_name,
            gm.forwarded_dialog_payload,
            gm.preview_url,
            gm.preview_title,
            gm.preview_description,
            gm.preview_site_name,
            gm.audio_url,
            gm.audio_mime_type,
            gm.audio_duration_ms,
            gm.image_url,
            gm.image_mime_type,
            gm.sticker_id,
            gm.sticker_asset_path,
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

    ensure_message_preview_data_many(conn, "group_messages", before_rows)
    ensure_message_preview_data_many(conn, "group_messages", after_rows)
    if target_touched:
        conn.commit()
    messages = list(reversed(before_rows)) + [target] + list(after_rows)
    attach_message_attachments(conn, "group", messages)
    return messages, has_more_before, has_more_after


def get_user_display_name(user):
    return user["name"] or user["username"] or "Пользователь"


def create_direct_message_record(conn, chat_id, sender_id, text, message_type="text", audio=None, image=None, sticker=None, reply_to_message=None, forwarded_from=None, forwarded_dialog_payload=None):
    preview = extract_message_preview(text) if message_type == "text" else None
    reply_preview = build_reply_preview_payload(reply_to_message)
    forwarded_payload = forwarded_from or {}
    forwarded_dialog_payload_json = json.dumps(forwarded_dialog_payload, ensure_ascii=False) if forwarded_dialog_payload else None
    cur = conn.cursor()
    cur.execute("""
        INSERT INTO messages (
            chat_id,
            sender_id,
            text,
            message_type,
            reply_to_message_id,
            reply_preview_text,
            reply_preview_sender_name,
            reply_preview_message_type,
            forwarded_from_user_id,
            forwarded_from_sender_name,
            forwarded_dialog_payload,
            preview_url,
            preview_title,
            preview_description,
            preview_site_name,
            audio_url,
            audio_mime_type,
            audio_duration_ms,
            image_url,
            image_mime_type,
            sticker_id,
            sticker_asset_path
        )
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
    """, (
        chat_id,
        sender_id,
        text,
        message_type,
        reply_preview["reply_to_message_id"] if reply_preview else None,
        reply_preview["reply_preview_text"] if reply_preview else None,
        reply_preview["reply_preview_sender_name"] if reply_preview else None,
        reply_preview["reply_preview_message_type"] if reply_preview else None,
        forwarded_payload.get("forwarded_from_user_id"),
        forwarded_payload.get("forwarded_from_sender_name"),
        forwarded_dialog_payload_json,
        preview["url"] if preview else None,
        preview["title"][:255] if preview else None,
        preview["description"][:500] if preview else None,
        preview["site_name"][:255] if preview else None,
        audio["url"] if audio else None,
        audio["mime_type"] if audio else None,
        parse_duration_ms(audio.get("duration_ms")) if audio else None,
        image["url"] if image else None,
        image["mime_type"] if image else None,
        sticker["id"] if sticker else None,
        sticker["url"] if sticker else None
    ))
    return get_direct_message_for_chat(conn, chat_id, cur.lastrowid)


def create_group_message_record(conn, group_id, sender_id, text, message_type="text", audio=None, image=None, sticker=None, reply_to_message=None, forwarded_from=None, forwarded_dialog_payload=None, badge=None):
    preview = extract_message_preview(text) if message_type == "text" else None
    reply_preview = build_reply_preview_payload(reply_to_message)
    forwarded_payload = forwarded_from or {}
    forwarded_dialog_payload_json = json.dumps(forwarded_dialog_payload, ensure_ascii=False) if forwarded_dialog_payload else None
    cur = conn.cursor()
    cur.execute("""
        INSERT INTO group_messages (
            group_id,
            sender_id,
            text,
            message_type,
            badge,
            reply_to_message_id,
            reply_preview_text,
            reply_preview_sender_name,
            reply_preview_message_type,
            forwarded_from_user_id,
            forwarded_from_sender_name,
            forwarded_dialog_payload,
            preview_url,
            preview_title,
            preview_description,
            preview_site_name,
            audio_url,
            audio_mime_type,
            audio_duration_ms,
            image_url,
            image_mime_type,
            sticker_id,
            sticker_asset_path
        )
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
    """, (
        group_id,
        sender_id,
        text,
        message_type,
        str(badge or "").strip()[:64] or None,
        reply_preview["reply_to_message_id"] if reply_preview else None,
        reply_preview["reply_preview_text"] if reply_preview else None,
        reply_preview["reply_preview_sender_name"] if reply_preview else None,
        reply_preview["reply_preview_message_type"] if reply_preview else None,
        forwarded_payload.get("forwarded_from_user_id"),
        forwarded_payload.get("forwarded_from_sender_name"),
        forwarded_dialog_payload_json,
        preview["url"] if preview else None,
        preview["title"][:255] if preview else None,
        preview["description"][:500] if preview else None,
        preview["site_name"][:255] if preview else None,
        audio["url"] if audio else None,
        audio["mime_type"] if audio else None,
        parse_duration_ms(audio.get("duration_ms")) if audio else None,
        image["url"] if image else None,
        image["mime_type"] if image else None,
        sticker["id"] if sticker else None,
        sticker["url"] if sticker else None
    ))
    return get_group_message_for_group(conn, group_id, cur.lastrowid)


def emit_group_new_message(message, group_id):
    socketio.emit("new_message", {
        **serialize_group_message(message)
    }, room=f"group_{group_id}")
    conn = get_db()
    member_ids = get_group_member_ids(conn, group_id)
    group = conn.execute("SELECT title FROM groups WHERE id = %s", (group_id,)).fetchone()
    emit_inbox_message_for_users(member_ids, {
        **serialize_group_message(message),
        "chat_type": "group",
        "chat_id": int(group_id),
        "thread_title": row_value(group, "title", "") or "Группа"
    }, exclude_user_id=message["sender_id"])
    conn.close()
    emit_chat_list_updated_for_users(member_ids, "group", group_id)


def build_forward_message_data(message):
    message_type = row_value(message, "message_type", "text") or "text"
    if message_type == "system":
        raise ValueError("Системные сообщения нельзя пересылать")
    if message_type not in {"text", "voice", "photo", "sticker"}:
        raise ValueError("Этот тип сообщения пока нельзя пересылать")

    return {
        "text": row_value(message, "text", "") or "",
        "message_type": message_type,
        "audio": clone_forwarded_audio(message) if message_type == "voice" else None,
        "image": clone_forwarded_image(message) if message_type == "photo" else None,
        "sticker": clone_forwarded_sticker(message) if message_type == "sticker" else None,
        "forwarded_from": build_forwarded_from_payload(message)
    }


def fetch_direct_messages_by_ids(conn, chat_id, message_ids):
    if not message_ids:
        return []

    placeholders = ",".join("%s" for _ in message_ids)
    rows = conn.execute(f"""
        SELECT
            m.id,
            m.sender_id,
            u.name AS sender_name,
            m.text,
            m.message_type,
            m.created_at
        FROM messages m
        JOIN users u ON u.id = m.sender_id
        WHERE m.chat_id = %s
          AND m.id IN ({placeholders})
        ORDER BY m.id ASC
    """, [chat_id, *message_ids]).fetchall()
    attach_message_attachments(conn, "direct", rows)
    return rows or []


def fetch_group_messages_by_ids(conn, group_id, message_ids):
    if not message_ids:
        return []

    placeholders = ",".join("%s" for _ in message_ids)
    rows = conn.execute(f"""
        SELECT
            gm.id,
            gm.sender_id,
            u.name AS sender_name,
            gm.text,
            gm.message_type,
            gm.created_at
        FROM group_messages gm
        JOIN users u ON u.id = gm.sender_id
        WHERE gm.group_id = %s
          AND gm.id IN ({placeholders})
        ORDER BY gm.id ASC
    """, [group_id, *message_ids]).fetchall()
    attach_message_attachments(conn, "group", rows)
    return rows or []


def forward_message_to_target(conn, sender_id, target_chat_type, target_chat_id, source_message):
    if target_chat_type == "group":
        if not can_access_group(conn, sender_id, target_chat_id):
            raise LookupError("Группа не найдена")
        message_data = build_forward_message_data(source_message)
        ensure_server_channel_message_allowed(
            conn,
            target_chat_id,
            sender_id,
            text=message_data["text"],
            includes_files=bool(message_data["audio"] or message_data["image"]),
            editing=False
        )
        message = create_group_message_record(
            conn,
            target_chat_id,
            sender_id,
            message_data["text"],
            message_data["message_type"],
            audio=message_data["audio"],
            image=message_data["image"],
            sticker=message_data["sticker"],
            forwarded_from=message_data["forwarded_from"]
        )
        conn.commit()
        emit_group_new_message(message, target_chat_id)
        return serialize_group_message(message)

    chat = can_access_direct_chat(conn, sender_id, target_chat_id)
    if not chat:
        raise LookupError("Чат не найден")

    recipient_user_id = get_direct_chat_recipient_id(conn, target_chat_id, sender_id)
    ensure_direct_target_is_writable(conn, sender_id, recipient_user_id)

    message_data = build_forward_message_data(source_message)
    conn.execute("DELETE FROM hidden_direct_chats WHERE chat_id = %s", (target_chat_id,))
    message = create_direct_message_record(
        conn,
        target_chat_id,
        sender_id,
        message_data["text"],
        message_data["message_type"],
        audio=message_data["audio"],
        image=message_data["image"],
        sticker=message_data["sticker"],
        forwarded_from=message_data["forwarded_from"]
    )
    conn.commit()
    member_ids = get_direct_chat_member_ids(conn, target_chat_id)
    message_data_payload = serialize_direct_message(message)
    emit_inbox_message_for_users(member_ids, {
        **message_data_payload,
        "chat_type": "direct",
        "chat_id": int(target_chat_id),
        "thread_title": message["sender_name"] or "Чат"
    }, exclude_user_id=sender_id)
    socketio.emit("new_message", message_data_payload, room=f"direct_{target_chat_id}")
    emit_chat_list_updated_for_users(member_ids, "direct", target_chat_id)
    return message_data_payload


def forward_dialog_to_target(conn, sender_id, target_chat_type, target_chat_id, dialog_payload):
    dialog_title = str(dialog_payload.get("title") or "Пересланный диалог")[:255]
    if target_chat_type == "group":
        if not can_access_group(conn, sender_id, target_chat_id):
            raise LookupError("Группа не найдена")
        ensure_server_channel_message_allowed(
            conn,
            target_chat_id,
            sender_id,
            text=dialog_title,
            includes_files=False,
            editing=False
        )
        message = create_group_message_record(
            conn,
            target_chat_id,
            sender_id,
            dialog_title,
            "forwarded_dialog",
            forwarded_dialog_payload=dialog_payload
        )
        conn.commit()
        emit_group_new_message(message, target_chat_id)
        return serialize_group_message(message)

    chat = can_access_direct_chat(conn, sender_id, target_chat_id)
    if not chat:
        raise LookupError("Чат не найден")

    recipient_user_id = get_direct_chat_recipient_id(conn, target_chat_id, sender_id)
    ensure_direct_target_is_writable(conn, sender_id, recipient_user_id)

    conn.execute("DELETE FROM hidden_direct_chats WHERE chat_id = %s", (target_chat_id,))
    message = create_direct_message_record(
        conn,
        target_chat_id,
        sender_id,
        dialog_title,
        "forwarded_dialog",
        forwarded_dialog_payload=dialog_payload
    )
    conn.commit()
    member_ids = get_direct_chat_member_ids(conn, target_chat_id)
    message_data_payload = serialize_direct_message(message)
    emit_inbox_message_for_users(member_ids, {
        **message_data_payload,
        "chat_type": "direct",
        "chat_id": int(target_chat_id),
        "thread_title": message["sender_name"] or "Чат"
    }, exclude_user_id=sender_id)
    socketio.emit("new_message", message_data_payload, room=f"direct_{target_chat_id}")
    emit_chat_list_updated_for_users(member_ids, "direct", target_chat_id)
    return message_data_payload


@socketio.on("connect")
def handle_connect(auth):
    token = None
    if isinstance(auth, dict):
        token = auth.get("token")

    user_id = user_id_from_token(token)
    if user_id:
        conn = get_db()
        try:
            user = fetch_user_auth_state(conn, user_id)
        finally:
            conn.close()
        if not user or is_ban_active(user):
            return False
    was_online = is_user_online(user_id)
    socket_sessions[request.sid] = user_id
    if user_id:
        user_last_seen.pop(int(user_id), None)
        join_room(get_user_room(user_id))
        if not was_online:
            emit_presence_updated(user_id)


@socketio.on("disconnect")
def handle_disconnect():
    clear_typing_session(request.sid)
    user_id = socket_sessions.pop(request.sid, None)
    if user_id and not is_user_online(user_id):
        user_last_seen[int(user_id)] = datetime.now(timezone.utc)
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


@socketio.on("typing_start")
def handle_typing_start(data):
    user_id = socket_sessions.get(request.sid)
    if not user_id:
        emit("join_error", {"message": "Не авторизован"})
        return

    chat_type = "group" if (data or {}).get("type") == "group" else "direct"
    chat_id = (data or {}).get("id")

    try:
        chat_id = int(chat_id)
    except (TypeError, ValueError):
        emit("join_error", {"message": "Некорректный chat id"})
        return

    conn = get_db()
    context = get_typing_context(conn, user_id, chat_type, chat_id)
    conn.close()
    if not context:
        emit("join_error", {"message": "Нет доступа к чату"})
        return

    previous_state = typing_sessions.get(request.sid)
    if previous_state and (
        previous_state["room"] != context["room"] or
        previous_state["user_id"] != int(user_id)
    ):
        clear_typing_session(request.sid)

    typing_sessions[request.sid] = {
        "room": context["room"],
        "chat_type": context["chat_type"],
        "chat_id": context["chat_id"],
        "user_id": int(user_id)
    }

    user = context["user"]
    socketio.emit("typing_started", {
        "chat_type": context["chat_type"],
        "chat_id": context["chat_id"],
        "user_id": int(user_id),
        "name": (user["name"] if user and user["name"] else (user["username"] if user and user["username"] else "Кто-то")),
        "username": user["username"] if user else None
    }, room=context["room"], skip_sid=request.sid)


@socketio.on("typing_stop")
def handle_typing_stop(data):
    user_id = socket_sessions.get(request.sid)
    state = typing_sessions.get(request.sid)
    if not user_id or not state:
        return

    chat_type = "group" if (data or {}).get("type") == "group" else "direct"
    chat_id = (data or {}).get("id")

    try:
        chat_id = int(chat_id)
    except (TypeError, ValueError):
        return

    if state["chat_type"] != chat_type or int(state["chat_id"]) != chat_id or int(state["user_id"]) != int(user_id):
        return

    clear_typing_session(request.sid)


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


@app.get("/graph")
def graph_page():
    return render_template(
        "graph.html",
        title="Граф общения | /Chatik",
        body_class="page-shell graph-page",
        data_chat_type=None,
        sidebar_action_mode="search",
        sidebar_back_href=None,
        sidebar_back_label=None,
        sidebar_back_icon=None,
    )


@app.get("/stickers")
def stickers_page():
    return render_template(
        "stickers.html",
        title="Мои стикеры | /Chatik",
        body_class="page-shell stickers-page",
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


@app.get("/server/<int:server_id>")
def server_page(server_id):
    return render_template(
        "group_chat.html",
        title="Server | /Chatik",
        body_class="page-shell thread-page",
        data_chat_type="group",
        sidebar_action_mode="search",
        sidebar_back_href=None,
        sidebar_back_label=None,
        sidebar_back_icon=None,
    )


@app.get("/server/<int:server_id>/channel/<int:group_id>")
def server_channel_page(server_id, group_id):
    return render_template(
        "group_chat.html",
        title="Server Channel | /Chatik",
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


@app.get("/admin")
def admin_page():
    return render_template(
        "admin.html",
        title="Admin | /Chatik",
        body_class="page-shell chats-page",
        data_chat_type=None,
        sidebar_action_mode="search",
        sidebar_back_href=None,
        sidebar_back_label=None,
        sidebar_back_icon=None,
    )


@app.get("/login")
def login_page():
    return send_from_directory(".", "login.html")


@app.get("/forgot-password")
def forgot_password_page():
    return send_from_directory(".", "forgot_password.html")


@app.get("/register")
def register_page():
    return send_from_directory(".", "register.html")


@app.get("/verify-email")
def verify_email_page():
    return send_from_directory(".", "verify_email.html")


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


@app.errorhandler(404)
def handle_not_found(error):
    prefers_html = (
        request.method == "GET"
        and request.accept_mimetypes.best_match(["text/html", "application/json"]) == "text/html"
        and request.accept_mimetypes["text/html"] >= request.accept_mimetypes["application/json"]
    )
    if prefers_html:
        return render_template("404.html"), 404
    return jsonify({"message": "Страница не найдена"}), 404


@app.get("/server-invite/<code>")
def server_invite_page(code):
    conn = get_db()
    invite = get_server_invite_by_code(conn, code)
    user_id = current_user_id()

    if request_wants_json():
        if not invite:
            conn.close()
            return jsonify({"message": "Ссылка приглашения недействительна"}), 404
        server_summary = get_server_summary_for_invites(conn, invite["server_id"])
        viewer_member = get_server_member(conn, invite["server_id"], user_id) if user_id else None
        payload = serialize_server_invite_row(invite, server_summary, viewer_member)
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


@app.get("/graph.html")
def legacy_graph_page():
    return redirect("/graph", code=302)


@app.get("/create_group.html")
def legacy_create_group_page():
    return redirect("/create-group", code=302)


@app.get("/admin.html")
def legacy_admin_page():
    return redirect("/admin", code=302)


@app.get("/login.html")
def legacy_login_page():
    return redirect("/login", code=302)


@app.get("/register.html")
def legacy_register_page():
    return redirect("/register", code=302)


@app.get("/verify_email.html")
def legacy_verify_email_page():
    return redirect("/verify-email", code=302)


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
    data = request.json or {}

    name = data.get("name", "").strip()
    username = data.get("username", "").strip().replace("@", "")
    try:
        email = validate_email_address(data.get("email", ""))
        password = validate_password_value(data.get("password", ""))
    except ValueError as error:
        return jsonify({"message": str(error)}), 400

    if not name or not username or not email:
        return jsonify({"message": "Заполните имя, username, email и пароль"}), 400
    if username.lower() in {SYSTEM_USERNAME.lower(), SYSTEM_OWNER_USERNAME.lower()}:
        return jsonify({"message": "Этот username зарезервирован"}), 400

    conn = get_db()
    cur = conn.cursor()
    user_id = None
    verification_code = ""

    try:
        password_hash = generate_password_hash(password)
        verification_hash = None
        verification_expires_at = None
        email_verified = 1 if not is_email_verification_required() else 0
        if is_email_verification_required():
            verification_code, verification_hash, verification_expires_at = build_email_verification_payload()

        cur.execute("""
            INSERT INTO users (
                name,
                username,
                email,
                email_verified,
                email_verification_code_hash,
                email_verification_expires_at,
                password_hash,
                role
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
        """, (
            name,
            username,
            email,
            email_verified,
            verification_hash,
            to_db_datetime(verification_expires_at),
            password_hash,
            ROLE_USER,
        ))

        conn.commit()
        user_id = cur.lastrowid

    except Exception:
        conn.close()
        return jsonify({"message": "Такой username уже занят"}), 400

    created_user = conn.execute("SELECT * FROM users WHERE id = %s", (user_id,)).fetchone()
    if not is_email_verification_required():
        try:
            send_chatik_notification(created_user["id"], build_chatik_welcome_message())
        except Exception:
            pass
        conn.close()
        return jsonify(issue_auth_payload(created_user)), 201

    try:
        send_email_verification_code(email, verification_code)
    except Exception:
        try:
            if user_id:
                conn.execute("DELETE FROM users WHERE id = %s", (user_id,))
                conn.commit()
        finally:
            conn.close()
        return jsonify({"message": "Не удалось отправить код подтверждения. Попробуйте позже."}), 500

    conn.close()

    return jsonify({
        "need_email_verification": True,
        "email": email,
        "message": "Подтвердите email. Мы отправили 6-значный код."
    }), 201


@app.post("/auth/login")
def login():
    data = request.json or {}

    username = data.get("username", "").strip().replace("@", "")
    password = data.get("password", "")
    client_device_id = data.get("device_id", "")

    conn = get_db()
    user = conn.execute(
        "SELECT * FROM users WHERE username = %s",
        (username,)
    ).fetchone()

    if not user or not check_password_hash(user["password_hash"], password):
        conn.close()
        return jsonify({"message": "Неверный логин или пароль"}), 401
    if is_ban_active(user):
        conn.close()
        return jsonify({"message": "Аккаунт заблокирован"}), 403
    if not is_user_email_verified(user):
        conn.close()
        return jsonify({
            "message": "Подтвердите email",
            "need_email_verification": True,
            "email": row_value(user, "email", "") or ""
        }), 403

    if not bool(row_value(user, "email_verified", False)):
        mark_user_email_verified(conn, user["id"])
        conn.commit()
        user = conn.execute("SELECT * FROM users WHERE id = %s", (user["id"],)).fetchone()
    conn.close()

    auth_payload = issue_auth_payload(user)
    try:
        is_new_device = register_login_device(user["id"], client_device_id)
        if is_new_device and bool(row_value(user, "login_alerts_enabled", True)):
            send_chatik_notification(user["id"], build_chatik_login_alert())
    except Exception:
        pass

    return jsonify(auth_payload)


@app.post("/auth/forgot-password/request")
def request_forgot_password():
    data = request.json or {}
    try:
        email = validate_email_address(data.get("email", ""))
    except ValueError:
        return jsonify({"message": "Если аккаунт существует, код скоро придет на email."})

    conn = get_db()
    try:
        user = conn.execute("""
            SELECT *
            FROM users
            WHERE LOWER(email) = LOWER(%s)
            LIMIT 1
        """, (email,)).fetchone()

        if not user or not is_user_email_verified(user):
            return jsonify({"message": "Если аккаунт существует, код скоро придет на email."})

        retry_after = get_change_request_retry_after_seconds(row_value(user, "password_change_expires_at"))
        if retry_after > 0:
            return jsonify({
                "message": f"Повторная отправка доступна через {retry_after} сек.",
                "retry_after": retry_after
            }), 429

        code, code_hash, expires_at = build_email_verification_payload()
        conn.execute("""
            UPDATE users
            SET password_change_code_hash = %s,
                password_change_expires_at = %s
            WHERE id = %s
        """, (code_hash, to_db_datetime(expires_at), user["id"]))
        conn.commit()
        target_user_id = user["id"]
    finally:
        conn.close()

    try:
        send_email_action_code(
            email,
            code,
            subject="Код восстановления пароля для /Chatik",
            intro="Ваш код для восстановления пароля",
            fallback_note="Если вы не запрашивали восстановление пароля в /Chatik, просто проигнорируйте это письмо."
        )
    except Exception:
        conn = get_db()
        try:
            conn.execute("""
                UPDATE users
                SET password_change_code_hash = NULL,
                    password_change_expires_at = NULL
                WHERE id = %s
            """, (target_user_id,))
            conn.commit()
        finally:
            conn.close()
        return jsonify({"message": "Не удалось отправить код подтверждения. Попробуйте позже."}), 500

    return jsonify({"message": "Если аккаунт существует, код скоро придет на email."})


@app.post("/auth/forgot-password/confirm")
def confirm_forgot_password():
    data = request.json or {}
    try:
        email = validate_email_address(data.get("email", ""))
        password = validate_password_value(data.get("password", ""))
    except ValueError as error:
        return jsonify({"message": str(error)}), 400

    code = str(data.get("code", "")).strip()
    if not re.fullmatch(r"\d{6}", code):
        return jsonify({"message": "Неверный код подтверждения"}), 400

    conn = get_db()
    try:
        user = conn.execute("""
            SELECT *
            FROM users
            WHERE LOWER(email) = LOWER(%s)
            LIMIT 1
        """, (email,)).fetchone()
        if not user or not is_user_email_verified(user):
            return jsonify({"message": "Неверный код подтверждения"}), 400

        code_hash = row_value(user, "password_change_code_hash", "")
        expires_at = parse_datetime_value(row_value(user, "password_change_expires_at"))
        if not code_hash or not expires_at or expires_at <= utcnow():
            conn.execute("""
                UPDATE users
                SET password_change_code_hash = NULL,
                    password_change_expires_at = NULL
                WHERE id = %s
            """, (user["id"],))
            conn.commit()
            return jsonify({"message": "Код недействителен или истек"}), 400

        if not check_password_hash(code_hash, code):
            return jsonify({"message": "Неверный код подтверждения"}), 400

        conn.execute("""
            UPDATE users
            SET password_hash = %s,
                password_change_code_hash = NULL,
                password_change_expires_at = NULL
            WHERE id = %s
        """, (generate_password_hash(password), user["id"]))
        conn.commit()
        return jsonify({"message": "Пароль восстановлен. Теперь вы можете войти."})
    finally:
        conn.close()


@app.post("/auth/verify-email")
def verify_email():
    data = request.json or {}

    email = data.get("email", "").strip()
    code = str(data.get("code", "")).strip()
    client_device_id = data.get("device_id", "")

    if not is_email_verification_required():
        return jsonify({
            "message": "Подтверждение email временно отключено. Войдите в аккаунт.",
            "verification_disabled": True
        }), 400

    if not email or not re.fullmatch(r"\d{6}", code):
        return jsonify({"message": "Неверный код подтверждения"}), 400

    conn = get_db()
    user = conn.execute("""
        SELECT *
        FROM users
        WHERE email = %s
        LIMIT 1
    """, (email,)).fetchone()

    if not user:
        conn.close()
        return jsonify({"message": "Неверный код подтверждения"}), 400
    if bool(row_value(user, "email_verified", False)):
        conn.close()
        return jsonify({"message": "Email уже подтвержден"}), 400

    expires_at = parse_datetime_value(row_value(user, "email_verification_expires_at"))
    code_hash = row_value(user, "email_verification_code_hash", "")
    if not expires_at or expires_at <= utcnow() or not code_hash:
        conn.execute("""
            UPDATE users
            SET email_verification_code_hash = NULL,
                email_verification_expires_at = NULL
            WHERE id = %s
        """, (user["id"],))
        conn.commit()
        conn.close()
        return jsonify({"message": "Код недействителен или истек"}), 400
    if not check_password_hash(code_hash, code):
        conn.close()
        return jsonify({"message": "Неверный код подтверждения"}), 400

    conn.execute("""
        UPDATE users
        SET email_verified = 1,
            email_verification_code_hash = NULL,
            email_verification_expires_at = NULL
        WHERE id = %s
    """, (user["id"],))
    conn.commit()
    verified_user = conn.execute("SELECT * FROM users WHERE id = %s", (user["id"],)).fetchone()
    conn.close()

    auth_payload = issue_auth_payload(verified_user)
    try:
        is_new_device = register_login_device(verified_user["id"], client_device_id)
        if is_new_device and bool(row_value(verified_user, "login_alerts_enabled", True)):
            send_chatik_notification(verified_user["id"], build_chatik_login_alert())
        send_chatik_notification(verified_user["id"], build_chatik_welcome_message())
    except Exception:
        pass

    return jsonify(auth_payload)


@app.post("/auth/resend-email-code")
def resend_email_code():
    data = request.json or {}
    email = data.get("email", "").strip()

    if not is_email_verification_required():
        return jsonify({
            "message": "Подтверждение email временно отключено.",
            "verification_disabled": True
        })

    if not email:
        return jsonify({"message": "Email обязателен"}), 400

    conn = get_db()
    user = conn.execute("""
        SELECT *
        FROM users
        WHERE email = %s
        LIMIT 1
    """, (email,)).fetchone()

    if not user:
        conn.close()
        return jsonify({"message": "Если аккаунт существует, код скоро придет на email."})
    if bool(row_value(user, "email_verified", False)):
        conn.close()
        return jsonify({"message": "Email уже подтвержден", "already_verified": True})

    retry_after = get_email_verification_retry_after_seconds(user)
    if retry_after > 0:
        conn.close()
        return jsonify({
            "message": f"Повторная отправка доступна через {retry_after} сек.",
            "retry_after": retry_after
        }), 429

    code, code_hash, expires_at = build_email_verification_payload()
    conn.execute("""
        UPDATE users
        SET email_verification_code_hash = %s,
            email_verification_expires_at = %s
        WHERE id = %s
    """, (code_hash, to_db_datetime(expires_at), user["id"]))
    conn.commit()
    conn.close()

    try:
        send_email_verification_code(email, code)
    except Exception:
        return jsonify({"message": "Не удалось отправить код подтверждения. Попробуйте позже."}), 500

    return jsonify({"message": "Если аккаунт существует, код скоро придет на email."})


@app.get("/users/me")
def get_me():
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    conn = get_db()
    user = conn.execute("""
        SELECT id, name, username, email, email_verified, role, bio, date_of_birth, login_alerts_enabled,
               is_banned, banned_reason, banned_until,
               can_send_messages, can_upload_files, can_create_groups
        FROM users
        WHERE id = %s
    """, (user_id,)).fetchone()
    conn.close()

    if not user:
        return jsonify({"message": "Пользователь не найден"}), 404

    return jsonify(serialize_user_profile(user))


@app.post("/users/me/email-change/request")
def request_email_change():
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    data = request.json or {}
    try:
        next_email = validate_email_address(data.get("email", ""))
    except ValueError as error:
        return jsonify({"message": str(error)}), 400

    conn = get_db()
    try:
        user = conn.execute("""
            SELECT *
            FROM users
            WHERE id = %s
            LIMIT 1
        """, (user_id,)).fetchone()
        if not user:
            return jsonify({"message": "Пользователь не найден"}), 404

        current_email = str(row_value(user, "email", "") or "").strip()
        if current_email.lower() == next_email.lower():
            return jsonify({"message": "Укажите другой email"}), 400

        existing_user = conn.execute("""
            SELECT id
            FROM users
            WHERE LOWER(email) = LOWER(%s) AND id != %s
            LIMIT 1
        """, (next_email, user_id)).fetchone()
        if existing_user:
            return jsonify({"message": "Этот email уже используется"}), 400

        retry_after = get_change_request_retry_after_seconds(row_value(user, "email_change_expires_at"))
        if retry_after > 0:
            return jsonify({
                "message": f"Повторная отправка доступна через {retry_after} сек.",
                "retry_after": retry_after
            }), 429

        code, code_hash, expires_at = build_email_verification_payload()
        conn.execute("""
            UPDATE users
            SET pending_email = %s,
                email_change_code_hash = %s,
                email_change_expires_at = %s
            WHERE id = %s
        """, (next_email, code_hash, to_db_datetime(expires_at), user_id))
        conn.commit()
    finally:
        conn.close()

    try:
        send_email_action_code(
            next_email,
            code,
            subject="Код смены email для /Chatik",
            intro="Ваш код для подтверждения нового email",
            fallback_note="Если вы не запрашивали смену email в /Chatik, просто проигнорируйте это письмо."
        )
    except Exception:
        conn = get_db()
        try:
            conn.execute("""
                UPDATE users
                SET pending_email = NULL,
                    email_change_code_hash = NULL,
                    email_change_expires_at = NULL
                WHERE id = %s
            """, (user_id,))
            conn.commit()
        finally:
            conn.close()
        return jsonify({"message": "Не удалось отправить код подтверждения. Попробуйте позже."}), 500

    return jsonify({
        "message": "Мы отправили код подтверждения на новый email.",
        "email": next_email
    })


@app.post("/users/me/email-change/confirm")
def confirm_email_change():
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    data = request.json or {}
    try:
        next_email = validate_email_address(data.get("email", ""))
    except ValueError as error:
        return jsonify({"message": str(error)}), 400

    code = str(data.get("code", "")).strip()
    if not re.fullmatch(r"\d{6}", code):
        return jsonify({"message": "Неверный код подтверждения"}), 400

    conn = get_db()
    try:
        user = conn.execute("""
            SELECT *
            FROM users
            WHERE id = %s
            LIMIT 1
        """, (user_id,)).fetchone()
        if not user:
            return jsonify({"message": "Пользователь не найден"}), 404

        pending_email = str(row_value(user, "pending_email", "") or "").strip()
        code_hash = row_value(user, "email_change_code_hash", "")
        expires_at = parse_datetime_value(row_value(user, "email_change_expires_at"))
        if pending_email.lower() != next_email.lower() or not code_hash or not expires_at or expires_at <= utcnow():
            conn.execute("""
                UPDATE users
                SET pending_email = NULL,
                    email_change_code_hash = NULL,
                    email_change_expires_at = NULL
                WHERE id = %s
            """, (user_id,))
            conn.commit()
            return jsonify({"message": "Код недействителен или истек"}), 400

        if not check_password_hash(code_hash, code):
            return jsonify({"message": "Неверный код подтверждения"}), 400

        existing_user = conn.execute("""
            SELECT id
            FROM users
            WHERE LOWER(email) = LOWER(%s) AND id != %s
            LIMIT 1
        """, (next_email, user_id)).fetchone()
        if existing_user:
            return jsonify({"message": "Этот email уже используется"}), 400

        conn.execute("""
            UPDATE users
            SET email = %s,
                email_verified = 1,
                pending_email = NULL,
                email_change_code_hash = NULL,
                email_change_expires_at = NULL
            WHERE id = %s
        """, (next_email, user_id))
        conn.commit()

        updated_user = conn.execute("""
            SELECT id, name, username, email, email_verified, role, bio, date_of_birth, login_alerts_enabled,
                   is_banned, banned_reason, banned_until,
                   can_send_messages, can_upload_files, can_create_groups
            FROM users
            WHERE id = %s
        """, (user_id,)).fetchone()
        return jsonify(serialize_user_profile(updated_user))
    finally:
        conn.close()


@app.post("/users/me/password-change/request")
def request_password_change():
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    conn = get_db()
    try:
        user = conn.execute("""
            SELECT *
            FROM users
            WHERE id = %s
            LIMIT 1
        """, (user_id,)).fetchone()
        if not user:
            return jsonify({"message": "Пользователь не найден"}), 404

        email = str(row_value(user, "email", "") or "").strip()
        if not email:
            return jsonify({"message": "Сначала добавьте email в профиль"}), 400
        if not is_user_email_verified(user):
            return jsonify({"message": "Сначала подтвердите текущий email"}), 400

        retry_after = get_change_request_retry_after_seconds(row_value(user, "password_change_expires_at"))
        if retry_after > 0:
            return jsonify({
                "message": f"Повторная отправка доступна через {retry_after} сек.",
                "retry_after": retry_after
            }), 429

        code, code_hash, expires_at = build_email_verification_payload()
        conn.execute("""
            UPDATE users
            SET password_change_code_hash = %s,
                password_change_expires_at = %s
            WHERE id = %s
        """, (code_hash, to_db_datetime(expires_at), user_id))
        conn.commit()
    finally:
        conn.close()

    try:
        send_email_action_code(
            email,
            code,
            subject="Код смены пароля для /Chatik",
            intro="Ваш код для смены пароля",
            fallback_note="Если вы не запрашивали смену пароля в /Chatik, срочно проверьте безопасность аккаунта."
        )
    except Exception:
        conn = get_db()
        try:
            conn.execute("""
                UPDATE users
                SET password_change_code_hash = NULL,
                    password_change_expires_at = NULL
                WHERE id = %s
            """, (user_id,))
            conn.commit()
        finally:
            conn.close()
        return jsonify({"message": "Не удалось отправить код подтверждения. Попробуйте позже."}), 500

    return jsonify({"message": "Мы отправили код подтверждения на ваш email."})


@app.post("/users/me/password-change/confirm")
def confirm_password_change():
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    data = request.json or {}
    code = str(data.get("code", "")).strip()
    if not re.fullmatch(r"\d{6}", code):
        return jsonify({"message": "Неверный код подтверждения"}), 400

    try:
        password = validate_password_value(data.get("password", ""))
    except ValueError as error:
        return jsonify({"message": str(error)}), 400

    conn = get_db()
    try:
        user = conn.execute("""
            SELECT *
            FROM users
            WHERE id = %s
            LIMIT 1
        """, (user_id,)).fetchone()
        if not user:
            return jsonify({"message": "Пользователь не найден"}), 404

        code_hash = row_value(user, "password_change_code_hash", "")
        expires_at = parse_datetime_value(row_value(user, "password_change_expires_at"))
        if not code_hash or not expires_at or expires_at <= utcnow():
            conn.execute("""
                UPDATE users
                SET password_change_code_hash = NULL,
                    password_change_expires_at = NULL
                WHERE id = %s
            """, (user_id,))
            conn.commit()
            return jsonify({"message": "Код недействителен или истек"}), 400

        if not check_password_hash(code_hash, code):
            return jsonify({"message": "Неверный код подтверждения"}), 400

        conn.execute("""
            UPDATE users
            SET password_hash = %s,
                password_change_code_hash = NULL,
                password_change_expires_at = NULL
            WHERE id = %s
        """, (generate_password_hash(password), user_id))
        conn.commit()
        return jsonify({"message": "Пароль успешно изменен"})
    finally:
        conn.close()


@app.get("/security/overview")
def get_security_overview_endpoint():
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    conn = get_db()
    try:
        return jsonify(get_security_overview(conn, user_id))
    finally:
        conn.close()


@app.patch("/security/preferences")
def update_security_preferences():
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    data = request.json or {}
    if "login_alerts_enabled" not in data:
        return jsonify({"message": "login_alerts_enabled обязателен"}), 400

    login_alerts_enabled = bool(data.get("login_alerts_enabled"))
    conn = get_db()
    try:
        conn.execute("""
            UPDATE users
            SET login_alerts_enabled = %s
            WHERE id = %s
        """, (1 if login_alerts_enabled else 0, user_id))
        conn.commit()
        return jsonify(get_security_overview(conn, user_id))
    finally:
        conn.close()


@app.post("/security/terminate-other-sessions")
def terminate_other_sessions():
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    current_token = current_auth_token()
    if not current_token:
        return jsonify({"message": "Не удалось определить текущую сессию"}), 400

    conn = get_db()
    try:
        cursor = conn.execute("""
            DELETE FROM auth_tokens
            WHERE user_id = %s AND token != %s
        """, (user_id, current_token))
        conn.commit()
        overview = get_security_overview(conn, user_id)
        return jsonify({
            "ok": True,
            "revoked_sessions": max(0, cursor.rowcount),
            **overview
        })
    finally:
        conn.close()


@app.patch("/users/me")
def update_me():
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    data = request.json or {}
    if "email" in data:
        return jsonify({"message": "Для смены email используйте подтверждение кодом"}), 400

    allowed_fields = {
        "name": (data.get("name", ""), 80),
        "username": (data.get("username", ""), 32),
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

    if "date_of_birth" in data:
        try:
            updates["date_of_birth"] = parse_profile_date(data.get("date_of_birth"), "Дата рождения")
        except ValueError as error:
            return jsonify({"message": str(error)}), 400

    if not updates:
        return jsonify({"message": "Нет данных для обновления"}), 400

    if "name" in updates and not updates["name"]:
        return jsonify({"message": "Имя не может быть пустым"}), 400

    if "username" in updates and not updates["username"]:
        return jsonify({"message": "Username не может быть пустым"}), 400
    if "username" in updates and updates["username"].lower() in {SYSTEM_USERNAME.lower(), SYSTEM_OWNER_USERNAME.lower()}:
        return jsonify({"message": "Этот username зарезервирован"}), 400

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
        SELECT id, name, username, email, role, bio, date_of_birth, login_alerts_enabled,
               email_verified,
               is_banned, banned_reason, banned_until,
               can_send_messages, can_upload_files, can_create_groups
        FROM users
        WHERE id = %s
    """, (user_id,)).fetchone()
    conn.close()

    return jsonify(serialize_user_profile(user))


@app.get("/admin/users")
def get_admin_users():
    access_error = ensure_admin_access()
    if access_error:
        return access_error

    conn = get_db()
    try:
        return jsonify({
            "items": fetch_admin_user_list(conn, "", parse_limit_arg(default=80, maximum=200))
        })
    finally:
        conn.close()


@app.get("/admin/settings")
def get_admin_settings():
    access_error = ensure_system_owner_access()
    if access_error:
        return access_error

    return jsonify({
        "global_file_uploads_enabled": is_global_file_uploads_enabled(),
        "global_stickers_enabled": is_global_stickers_enabled()
    })


@app.patch("/admin/settings")
def update_admin_settings():
    access_error = ensure_system_owner_access()
    if access_error:
        return access_error

    actor_user = getattr(g, "current_user", None) or {}
    data = request.json or {}
    if "global_file_uploads_enabled" not in data and "global_stickers_enabled" not in data:
        return jsonify({"message": "Нужен хотя бы один runtime-флаг"}), 400

    reason = collapse_spaces(data.get("reason", ""))
    conn = get_db()
    try:
        details = {}
        if "global_file_uploads_enabled" in data:
            details["global_file_uploads_enabled"] = bool(data.get("global_file_uploads_enabled"))
            write_runtime_setting(conn, GLOBAL_FILES_SETTING_KEY, "1" if details["global_file_uploads_enabled"] else "0")
        if "global_stickers_enabled" in data:
            details["global_stickers_enabled"] = bool(data.get("global_stickers_enabled"))
            write_runtime_setting(conn, GLOBAL_STICKERS_SETTING_KEY, "1" if details["global_stickers_enabled"] else "0")
        append_admin_audit_log(
            conn,
            actor_user["id"],
            actor_user["id"],
            "runtime_settings_update",
            reason,
            details=details
        )
        conn.commit()
        return jsonify({
            "global_file_uploads_enabled": is_global_file_uploads_enabled(),
            "global_stickers_enabled": is_global_stickers_enabled()
        })
    finally:
        conn.close()


@app.get("/admin/users/search")
def search_admin_users():
    access_error = ensure_admin_access()
    if access_error:
        return access_error

    query = request.args.get("query", "") or request.args.get("q", "")
    conn = get_db()
    try:
        return jsonify({
            "items": fetch_admin_user_list(conn, query, parse_limit_arg(default=40, maximum=200)),
            "query": collapse_spaces(query)
        })
    finally:
        conn.close()


@app.patch("/admin/users/<int:target_user_id>/permissions")
def update_admin_user_permissions(target_user_id):
    access_error = ensure_system_owner_access()
    if access_error:
        return access_error

    actor_user = getattr(g, "current_user", None) or {}
    data = request.json or {}
    updates = {}
    for field in ("can_send_messages", "can_upload_files", "can_create_groups"):
        if field in data:
            updates[field] = 1 if bool(data.get(field)) else 0

    if not updates:
        return jsonify({"message": "Нет данных для обновления"}), 400

    reason = collapse_spaces(data.get("reason", ""))
    conn = get_db()
    try:
        target_user = get_moderation_target(conn, target_user_id)
        validate_moderation_target(actor_user, target_user)
        assignments = ", ".join(f"{field} = %s" for field in updates.keys())
        conn.execute(f"""
            UPDATE users
            SET {assignments}
            WHERE id = %s
        """, [*updates.values(), target_user_id])
        append_admin_audit_log(
            conn,
            actor_user["id"],
            target_user_id,
            "permissions_update",
            reason,
            details={key: bool(value) for key, value in updates.items()}
        )
        conn.commit()
        updated_user = get_moderation_target(conn, target_user_id)
        return jsonify(serialize_admin_user(updated_user))
    except LookupError as error:
        conn.rollback()
        return jsonify({"message": str(error)}), 404
    except PermissionError as error:
        conn.rollback()
        return jsonify({"message": str(error)}), 403
    finally:
        conn.close()


@app.post("/admin/users/<int:target_user_id>/ban")
def ban_admin_user(target_user_id):
    access_error = ensure_admin_access()
    if access_error:
        return access_error

    actor_user = getattr(g, "current_user", None) or {}
    data = request.json or {}
    reason = collapse_spaces(data.get("reason", ""))
    banned_until = parse_datetime_value(data.get("banned_until"))

    conn = get_db()
    try:
        target_user = get_moderation_target(conn, target_user_id)
        validate_moderation_target(actor_user, target_user)
        conn.execute("""
            UPDATE users
            SET is_banned = 1,
                banned_reason = %s,
                banned_until = %s
            WHERE id = %s
        """, (
            reason or None,
            banned_until.astimezone(timezone.utc).replace(tzinfo=None) if banned_until else None,
            target_user_id
        ))
        conn.execute("DELETE FROM auth_tokens WHERE user_id = %s", (target_user_id,))
        append_admin_audit_log(
            conn,
            actor_user["id"],
            target_user_id,
            "ban_user",
            reason,
            details={"banned_until": format_timestamp(banned_until)}
        )
        conn.commit()
        disconnect_user_sockets(target_user_id)
        return jsonify(serialize_admin_user(get_moderation_target(conn, target_user_id)))
    except LookupError as error:
        conn.rollback()
        return jsonify({"message": str(error)}), 404
    except PermissionError as error:
        conn.rollback()
        return jsonify({"message": str(error)}), 403
    finally:
        conn.close()


@app.post("/admin/users/<int:target_user_id>/unban")
def unban_admin_user(target_user_id):
    access_error = ensure_admin_access()
    if access_error:
        return access_error

    actor_user = getattr(g, "current_user", None) or {}
    reason = collapse_spaces((request.json or {}).get("reason", ""))
    conn = get_db()
    try:
        target_user = get_moderation_target(conn, target_user_id)
        validate_moderation_target(actor_user, target_user)
        conn.execute("""
            UPDATE users
            SET is_banned = 0,
                banned_reason = NULL,
                banned_until = NULL
            WHERE id = %s
        """, (target_user_id,))
        append_admin_audit_log(conn, actor_user["id"], target_user_id, "unban_user", reason, details={})
        conn.commit()
        return jsonify(serialize_admin_user(get_moderation_target(conn, target_user_id)))
    except LookupError as error:
        conn.rollback()
        return jsonify({"message": str(error)}), 404
    except PermissionError as error:
        conn.rollback()
        return jsonify({"message": str(error)}), 403
    finally:
        conn.close()


@app.delete("/admin/users/<int:target_user_id>")
def delete_admin_user(target_user_id):
    access_error = ensure_admin_access()
    if access_error:
        return access_error

    actor_user = getattr(g, "current_user", None) or {}
    reason = collapse_spaces((request.json or {}).get("reason", ""))
    conn = get_db()
    try:
        target_user = get_moderation_target(conn, target_user_id)
        validate_moderation_target(actor_user, target_user)
        target_summary = {
            "id": int(target_user["id"]),
            "username": target_user["username"],
            "email": target_user["email"],
            "role": target_user["role"]
        }
        delete_user_account(conn, target_user_id)
        append_admin_audit_log(
            conn,
            actor_user["id"],
            target_user_id,
            "delete_user",
            reason,
            details=target_summary
        )
        conn.commit()
        disconnect_user_sockets(target_user_id)
        return jsonify({
            "ok": True,
            "deleted_user_id": target_user_id
        })
    except LookupError as error:
        conn.rollback()
        return jsonify({"message": str(error)}), 404
    except PermissionError as error:
        conn.rollback()
        return jsonify({"message": str(error)}), 403
    finally:
        conn.close()


@app.get("/users/search")
def search_users():
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    query = request.args.get("username", "").replace("@", "").strip()
    if not query:
        return jsonify([])

    conn = get_db()
    users = conn.execute("""
        SELECT
            u.id,
            u.name,
            u.username,
            u.bio,
            u.date_of_birth,
            ct.alias AS contact_alias,
            EXISTS (
                SELECT 1
                FROM contacts ct
                WHERE ct.owner_user_id = %s AND ct.contact_user_id = u.id
            ) AS is_contact,
            c.id AS chat_id
        FROM users u
        LEFT JOIN contacts ct
            ON ct.owner_user_id = %s AND ct.contact_user_id = u.id
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
        WHERE (
            u.username LIKE %s
            OR COALESCE(u.name, '') LIKE %s
        ) AND u.id != %s
        LIMIT 20
    """, (user_id, user_id, user_id, user_id, user_id, f"%{query}%", f"%{query}%", user_id)).fetchall()
    conn.close()

    return jsonify([
        {
            **serialize_user_panel_payload(user),
            "chat_id": user["chat_id"]
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
            u.bio,
            u.date_of_birth,
            ct.alias AS contact_alias,
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
        ORDER BY COALESCE(NULLIF(ct.alias, ''), u.name, u.username), u.username
    """, (user_id, user_id, user_id, user_id)).fetchall()
    conn.close()

    return jsonify([
        {
            **serialize_user_panel_payload({
                **dict(contact),
                "is_contact": True
            }),
            "chat_id": contact["chat_id"]
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
        "contact_alias": None,
        "is_contact": True,
        "badges": [],
        "is_online": False if should_hide_presence_for_username(target_user["username"]) else is_user_online(target_user["id"]),
        "last_seen": None if should_hide_presence_for_username(target_user["username"]) else format_timestamp(get_user_last_seen(target_user["id"])),
        "hide_presence": should_hide_presence_for_username(target_user["username"])
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


@app.patch("/contacts/<int:contact_user_id>")
def update_contact_alias(contact_user_id):
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    data = request.json or {}
    alias = str(data.get("alias", "")).strip()
    if not alias:
        return jsonify({"message": "Введите новое имя контакта"}), 400
    if len(alias) > 255:
        return jsonify({"message": "Имя контакта: максимум 255 символов"}), 400

    conn = get_db()
    contact = conn.execute("""
        SELECT 1
        FROM contacts
        WHERE owner_user_id = %s AND contact_user_id = %s
    """, (user_id, contact_user_id)).fetchone()
    if not contact:
        conn.close()
        return jsonify({"message": "Контакт не найден"}), 404

    conn.execute("""
        UPDATE contacts
        SET alias = %s
        WHERE owner_user_id = %s AND contact_user_id = %s
    """, (alias, user_id, contact_user_id))
    conn.commit()
    conn.close()

    return jsonify({
        "ok": True,
        "contact_user_id": contact_user_id,
        "contact_alias": alias
    })


@app.delete("/contacts/<int:contact_user_id>/alias")
def reset_contact_alias(contact_user_id):
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    conn = get_db()
    contact = conn.execute("""
        SELECT 1
        FROM contacts
        WHERE owner_user_id = %s AND contact_user_id = %s
    """, (user_id, contact_user_id)).fetchone()
    if not contact:
        conn.close()
        return jsonify({"message": "Контакт не найден"}), 404

    conn.execute("""
        UPDATE contacts
        SET alias = NULL
        WHERE owner_user_id = %s AND contact_user_id = %s
    """, (user_id, contact_user_id))
    conn.commit()
    conn.close()

    return jsonify({
        "ok": True,
        "contact_user_id": contact_user_id,
        "contact_alias": None
    })


@app.get("/users/<int:target_user_id>")
def get_user(target_user_id):
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    conn = get_db()
    user = fetch_user_panel_payload(conn, user_id, target_user_id)
    conn.close()

    if not user:
        return jsonify({"message": "Пользователь не найден"}), 404

    return jsonify(serialize_user_panel_payload(user))


@app.get("/sticker-library")
def get_sticker_library():
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    conn = get_db()
    try:
        library = fetch_sticker_library_payload(conn, user_id)
        library.update({
            "limits": {
                "max_pack_stickers": 120,
                "max_file_bytes": MAX_STICKER_FILE_BYTES,
                "allowed_mime_types": sorted(STICKER_EXTENSIONS_BY_MIME.keys())
            }
        })
        return jsonify(library)
    finally:
        conn.close()


@app.post("/sticker-packs")
def create_sticker_pack():
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    data = request.json or {}
    title = str(data.get("title", "") or "").strip()
    description = str(data.get("description", "") or "").strip()
    visibility = normalize_pack_visibility(data.get("visibility"))

    if not title:
        return jsonify({"message": "Название пака обязательно"}), 400
    if len(title) > 120:
        return jsonify({"message": "Название пака слишком длинное"}), 400
    if len(description) > 255:
        return jsonify({"message": "Описание пака слишком длинное"}), 400

    conn = get_db()
    try:
        cur = conn.cursor()
        cur.execute("""
            INSERT INTO sticker_packs (
                owner_user_id,
                title,
                description,
                cover_path,
                visibility,
                is_default
            )
            VALUES (%s, %s, %s, NULL, %s, 0)
        """, (user_id, title, description or None, visibility))
        conn.commit()
        pack = get_owned_sticker_pack(conn, user_id, cur.lastrowid)
        return jsonify(serialize_sticker_pack_payload(pack, [])), 201
    finally:
        conn.close()


@app.patch("/sticker-packs/<int:pack_id>")
def update_sticker_pack(pack_id):
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    data = request.json or {}
    updates = {}

    if "title" in data:
        title = str(data.get("title", "") or "").strip()
        if not title:
            return jsonify({"message": "Название пака обязательно"}), 400
        if len(title) > 120:
            return jsonify({"message": "Название пака слишком длинное"}), 400
        updates["title"] = title

    if "description" in data:
        description = str(data.get("description", "") or "").strip()
        if len(description) > 255:
            return jsonify({"message": "Описание пака слишком длинное"}), 400
        updates["description"] = description or None

    if "visibility" in data:
        updates["visibility"] = normalize_pack_visibility(data.get("visibility"))

    if not updates:
        return jsonify({"message": "Нет данных для обновления"}), 400

    conn = get_db()
    try:
        pack = get_owned_sticker_pack(conn, user_id, pack_id)
        if not pack or pack["is_default"]:
            return jsonify({"message": "Пак не найден"}), 404

        assignments = ", ".join(f"{field} = %s" for field in updates.keys())
        conn.execute(f"""
            UPDATE sticker_packs
            SET {assignments}
            WHERE id = %s
        """, [*updates.values(), pack_id])
        conn.commit()

        refreshed_pack = get_owned_sticker_pack(conn, user_id, pack_id)
        stickers = conn.execute("""
            SELECT id, pack_id, title, file_path, mime_type, position
            FROM stickers
            WHERE pack_id = %s
            ORDER BY position ASC, id ASC
        """, (pack_id,)).fetchall()
        return jsonify(serialize_sticker_pack_payload(
            {**dict(refreshed_pack), "is_owned": True, "is_added": False},
            [serialize_sticker_payload_row(row) for row in stickers]
        ))
    finally:
        conn.close()


@app.delete("/sticker-packs/<int:pack_id>")
def delete_sticker_pack(pack_id):
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    conn = get_db()
    try:
        pack = get_owned_sticker_pack(conn, user_id, pack_id)
        if not pack or pack["is_default"]:
            return jsonify({"message": "Пак не найден"}), 404

        conn.execute("DELETE FROM user_sticker_packs WHERE pack_id = %s", (pack_id,))
        conn.execute("DELETE FROM stickers WHERE pack_id = %s", (pack_id,))
        conn.execute("DELETE FROM sticker_packs WHERE id = %s", (pack_id,))
        conn.commit()
        return jsonify({"ok": True, "deleted_pack_id": pack_id})
    finally:
        conn.close()


@app.post("/sticker-packs/<int:pack_id>/stickers")
def upload_pack_sticker(pack_id):
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401
    try:
        ensure_global_file_uploads_enabled()
        require_permission_to_upload_files(getattr(g, "current_user", None) or {})
    except PermissionError as error:
        return jsonify({"message": str(error)}), 403

    conn = get_db()
    try:
        pack = get_owned_sticker_pack(conn, user_id, pack_id)
        if not pack or pack["is_default"]:
            return jsonify({"message": "Пак не найден"}), 404
        if count_pack_stickers(conn, pack_id) >= 120:
            return jsonify({"message": "В паке может быть максимум 120 стикеров"}), 400

        try:
            sticker_file = save_sticker_upload(request.files.get("sticker"))
        except ValueError as error:
            return jsonify({"message": str(error)}), 400

        title = str(request.form.get("title", "") or "").strip()[:120] or None
        next_position = count_pack_stickers(conn, pack_id)
        cur = conn.cursor()
        cur.execute("""
            INSERT INTO stickers (
                pack_id,
                title,
                file_path,
                mime_type,
                position
            )
            VALUES (%s, %s, %s, %s, %s)
        """, (pack_id, title, sticker_file["url"], sticker_file["mime_type"], next_position))

        if not row_value(pack, "cover_path"):
            conn.execute("""
                UPDATE sticker_packs
                SET cover_path = %s
                WHERE id = %s
            """, (sticker_file["url"], pack_id))

        conn.commit()
        row = conn.execute("""
            SELECT id, pack_id, title, file_path, mime_type, position
            FROM stickers
            WHERE id = %s
        """, (cur.lastrowid,)).fetchone()
        return jsonify(serialize_sticker_payload_row(row)), 201
    finally:
        conn.close()


@app.delete("/sticker-packs/<int:pack_id>/stickers/<int:sticker_id>")
def delete_pack_sticker(pack_id, sticker_id):
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    conn = get_db()
    try:
        pack = get_owned_sticker_pack(conn, user_id, pack_id)
        if not pack or pack["is_default"]:
            return jsonify({"message": "Пак не найден"}), 404

        sticker = conn.execute("""
            SELECT id, file_path
            FROM stickers
            WHERE id = %s AND pack_id = %s
            LIMIT 1
        """, (sticker_id, pack_id)).fetchone()
        if not sticker:
            return jsonify({"message": "Стикер не найден"}), 404

        conn.execute("DELETE FROM stickers WHERE id = %s", (sticker_id,))
        remaining = conn.execute("""
            SELECT id, file_path
            FROM stickers
            WHERE pack_id = %s
            ORDER BY position ASC, id ASC
            LIMIT 1
        """, (pack_id,)).fetchone()
        conn.execute("""
            UPDATE sticker_packs
            SET cover_path = %s
            WHERE id = %s AND cover_path = %s
        """, (row_value(remaining, "file_path"), pack_id, sticker["file_path"]))
        conn.commit()
        return jsonify({"ok": True, "deleted_sticker_id": sticker_id})
    finally:
        conn.close()


@app.post("/sticker-packs/<int:pack_id>/subscribe")
def subscribe_sticker_pack(pack_id):
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    conn = get_db()
    try:
        pack = conn.execute("""
            SELECT id, owner_user_id, visibility, is_default
            FROM sticker_packs
            WHERE id = %s
            LIMIT 1
        """, (pack_id,)).fetchone()
        if not pack:
            return jsonify({"message": "Пак не найден"}), 404
        if pack["owner_user_id"] == user_id or pack["is_default"]:
            return jsonify({"ok": True, "pack_id": pack_id})
        if normalize_pack_visibility(pack["visibility"]) != "public":
            return jsonify({"message": "Пак недоступен"}), 403

        conn.execute("""
            INSERT OR IGNORE INTO user_sticker_packs (user_id, pack_id)
            VALUES (%s, %s)
        """, (user_id, pack_id))
        conn.commit()
        return jsonify({"ok": True, "pack_id": pack_id})
    finally:
        conn.close()


@app.delete("/sticker-packs/<int:pack_id>/subscribe")
def unsubscribe_sticker_pack(pack_id):
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    conn = get_db()
    try:
        conn.execute("""
            DELETE FROM user_sticker_packs
            WHERE user_id = %s AND pack_id = %s
        """, (user_id, pack_id))
        conn.commit()
        return jsonify({"ok": True, "pack_id": pack_id})
    finally:
        conn.close()


@app.post("/users/<int:target_user_id>/mute")
def mute_user(target_user_id):
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401
    if target_user_id == user_id:
        return jsonify({"message": "Нельзя отключить уведомления для самого себя"}), 400

    conn = get_db()
    target_user = conn.execute("SELECT id FROM users WHERE id = %s", (target_user_id,)).fetchone()
    if not target_user:
        conn.close()
        return jsonify({"message": "Пользователь не найден"}), 404

    conn.execute("""
        INSERT OR IGNORE INTO user_muted_users (owner_user_id, muted_user_id)
        VALUES (%s, %s)
    """, (user_id, target_user_id))
    conn.commit()
    payload = fetch_user_panel_payload(conn, user_id, target_user_id)
    conn.close()
    return jsonify(serialize_user_panel_payload(payload))


@app.delete("/users/<int:target_user_id>/mute")
def unmute_user(target_user_id):
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401
    if target_user_id == user_id:
        return jsonify({"message": "Нельзя изменить уведомления для самого себя"}), 400

    conn = get_db()
    target_user = conn.execute("SELECT id FROM users WHERE id = %s", (target_user_id,)).fetchone()
    if not target_user:
        conn.close()
        return jsonify({"message": "Пользователь не найден"}), 404

    conn.execute("""
        DELETE FROM user_muted_users
        WHERE owner_user_id = %s AND muted_user_id = %s
    """, (user_id, target_user_id))
    conn.commit()
    payload = fetch_user_panel_payload(conn, user_id, target_user_id)
    conn.close()
    return jsonify(serialize_user_panel_payload(payload))


@app.post("/users/<int:target_user_id>/block")
def block_user(target_user_id):
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401
    if target_user_id == user_id:
        return jsonify({"message": "Нельзя заблокировать самого себя"}), 400

    conn = get_db()
    target_user = conn.execute("SELECT id FROM users WHERE id = %s", (target_user_id,)).fetchone()
    if not target_user:
        conn.close()
        return jsonify({"message": "Пользователь не найден"}), 404

    conn.execute("""
        INSERT OR IGNORE INTO user_blocked_users (owner_user_id, blocked_user_id)
        VALUES (%s, %s)
    """, (user_id, target_user_id))
    conn.commit()
    payload = fetch_user_panel_payload(conn, user_id, target_user_id)
    conn.close()
    return jsonify(serialize_user_panel_payload(payload))


@app.delete("/users/<int:target_user_id>/block")
def unblock_user(target_user_id):
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401
    if target_user_id == user_id:
        return jsonify({"message": "Нельзя изменить блокировку для самого себя"}), 400

    conn = get_db()
    target_user = conn.execute("SELECT id FROM users WHERE id = %s", (target_user_id,)).fetchone()
    if not target_user:
        conn.close()
        return jsonify({"message": "Пользователь не найден"}), 404

    conn.execute("""
        DELETE FROM user_blocked_users
        WHERE owner_user_id = %s AND blocked_user_id = %s
    """, (user_id, target_user_id))
    conn.commit()
    payload = fetch_user_panel_payload(conn, user_id, target_user_id)
    conn.close()
    return jsonify(serialize_user_panel_payload(payload))


@app.get("/link-preview")
def get_link_preview():
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    url = request.args.get("url", "")
    normalized_url = normalize_preview_url(url)
    if not normalized_url:
        return jsonify({"message": "Некорректная ссылка"}), 400

    try:
        preview = build_link_preview(normalized_url)
    except Exception:
        return jsonify({"message": "Не удалось загрузить preview ссылки"}), 502

    if not preview:
        return jsonify({"message": "Preview недоступен"}), 404

    return jsonify(preview)


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
            u.name AS original_name,
            ct.alias AS contact_alias,
            u.name AS title,
            EXISTS (
                SELECT 1
                FROM user_muted_users umu
                WHERE umu.owner_user_id = %s AND umu.muted_user_id = u.id
            ) AS is_muted,
            EXISTS (
                SELECT 1
                FROM user_blocked_users ubu
                WHERE ubu.owner_user_id = %s AND ubu.blocked_user_id = u.id
            ) AS is_blocked,
            EXISTS (
                SELECT 1
                FROM user_blocked_users ubu
                WHERE ubu.owner_user_id = u.id AND ubu.blocked_user_id = %s
            ) AS is_blocked_by,
            (
                SELECT m.text
                FROM messages m
                WHERE m.chat_id = c.id
                ORDER BY m.created_at DESC, m.id DESC
                LIMIT 1
            ) AS last_message_text,
            (
                SELECT m.message_type
                FROM messages m
                WHERE m.chat_id = c.id
                ORDER BY m.created_at DESC, m.id DESC
                LIMIT 1
            ) AS last_message_type,
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
        LEFT JOIN contacts ct
            ON ct.owner_user_id = %s AND ct.contact_user_id = u.id
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
    """, (user_id, user_id, user_id, user_id, user_id, user_id, user_id, user_id, user_id, user_id)).fetchall()

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
                SELECT gm.message_type
                FROM group_messages gm
                WHERE gm.group_id = g.id
                  AND NOT EXISTS (
                      SELECT 1
                      FROM hidden_group_messages hgm
                      WHERE hgm.group_message_id = gm.id AND hgm.user_id = %s
                  )
                ORDER BY gm.created_at DESC, gm.id DESC
                LIMIT 1
            ) AS last_message_type,
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
                  AND gm.message_type != 'system'
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
          AND NOT EXISTS (
              SELECT 1
              FROM server_channels sc
              WHERE sc.group_id = g.id
          )
    """, (user_id, user_id, user_id, user_id, user_id, user_id, user_id)).fetchall()
    server_rows = conn.execute("""
        SELECT
            s.id,
            s.title,
            s.created_at,
            (
                SELECT gm.text
                FROM server_channels sc
                JOIN group_messages gm ON gm.group_id = sc.group_id
                WHERE sc.server_id = s.id
                  AND NOT EXISTS (
                      SELECT 1
                      FROM hidden_group_messages hgm
                      WHERE hgm.group_message_id = gm.id AND hgm.user_id = %s
                  )
                ORDER BY gm.created_at DESC, gm.id DESC
                LIMIT 1
            ) AS last_message_text,
            (
                SELECT gm.message_type
                FROM server_channels sc
                JOIN group_messages gm ON gm.group_id = sc.group_id
                WHERE sc.server_id = s.id
                  AND NOT EXISTS (
                      SELECT 1
                      FROM hidden_group_messages hgm
                      WHERE hgm.group_message_id = gm.id AND hgm.user_id = %s
                  )
                ORDER BY gm.created_at DESC, gm.id DESC
                LIMIT 1
            ) AS last_message_type,
            (
                SELECT gm.created_at
                FROM server_channels sc
                JOIN group_messages gm ON gm.group_id = sc.group_id
                WHERE sc.server_id = s.id
                  AND NOT EXISTS (
                      SELECT 1
                      FROM hidden_group_messages hgm
                      WHERE hgm.group_message_id = gm.id AND hgm.user_id = %s
                  )
                ORDER BY gm.created_at DESC, gm.id DESC
                LIMIT 1
            ) AS updated_at,
            (
                SELECT SUM(
                    CASE
                        WHEN gm.message_type != 'system'
                         AND gm.sender_id != %s
                         AND gm.id > COALESCE((
                             SELECT grs.last_read_message_id
                             FROM group_read_states grs
                             WHERE grs.group_id = sc.group_id AND grs.user_id = %s
                         ), 0)
                         AND NOT EXISTS (
                             SELECT 1
                             FROM hidden_group_messages hgm
                             WHERE hgm.group_message_id = gm.id AND hgm.user_id = %s
                         )
                        THEN 1
                        ELSE 0
                    END
                )
                FROM server_channels sc
                JOIN group_messages gm ON gm.group_id = sc.group_id
                WHERE sc.server_id = s.id
            ) AS unread_count,
            (
                SELECT sc.group_id
                FROM server_channels sc
                JOIN group_members gmbr ON gmbr.group_id = sc.group_id
                WHERE sc.server_id = s.id AND gmbr.user_id = %s
                ORDER BY sc.position, sc.id
                LIMIT 1
            ) AS default_channel_id
        FROM servers s
        JOIN server_members sm ON sm.server_id = s.id
        WHERE sm.user_id = %s
    """, (
        user_id,
        user_id,
        user_id,
        user_id,
        user_id,
        user_id,
        user_id,
        user_id
    )).fetchall()
    conn.close()

    chats = [
        {
            "id": chat["id"],
            "type": "direct",
            "user_id": chat["user_id"],
            "username": chat["username"],
            "title": chat["contact_alias"] or chat["title"],
            "name": chat["original_name"],
            "contact_alias": chat["contact_alias"],
            "is_muted": bool(chat["is_muted"]),
            "is_blocked": bool(chat["is_blocked"]),
            "is_blocked_by": bool(chat["is_blocked_by"]),
            "is_online": False if should_hide_presence_for_username(chat["username"]) else is_user_online(chat["user_id"]),
            "last_seen": None if should_hide_presence_for_username(chat["username"]) else format_timestamp(get_user_last_seen(chat["user_id"])),
            "hide_presence": should_hide_presence_for_username(chat["username"]),
            "last_message": {
                "text": chat["last_message_text"],
                "message_type": chat["last_message_type"] or "text"
            } if chat["last_message_text"] is not None or chat["last_message_type"] is not None else None,
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
            "last_message": {
                "text": group["last_message_text"],
                "message_type": group["last_message_type"] or "text"
            } if group["last_message_text"] is not None or group["last_message_type"] is not None else None,
            "updated_at": format_timestamp(group["updated_at"]),
            "unread_count": group["unread_count"] or 0
        }
        for group in group_chats
    ])
    chats.extend([
        {
            "id": server["id"],
            "type": "server",
            "username": None,
            "title": server["title"],
            "default_channel_id": server["default_channel_id"],
            "last_message": {
                "text": server["last_message_text"],
                "message_type": server["last_message_type"] or "text"
            } if server["last_message_text"] is not None or server["last_message_type"] is not None else None,
            "updated_at": format_timestamp(server["updated_at"] or server["created_at"]),
            "unread_count": int(server["unread_count"] or 0)
        }
        for server in server_rows
        if server["default_channel_id"]
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


@app.get("/servers")
def get_servers():
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    conn = get_db()
    try:
        server_rows = conn.execute("""
            SELECT
                s.id,
                s.title,
                s.description,
                s.created_at,
                (
                    SELECT gm.text
                    FROM server_channels sc
                    JOIN group_messages gm ON gm.group_id = sc.group_id
                    WHERE sc.server_id = s.id
                      AND NOT EXISTS (
                          SELECT 1
                          FROM hidden_group_messages hgm
                          WHERE hgm.group_message_id = gm.id AND hgm.user_id = %s
                      )
                    ORDER BY gm.created_at DESC, gm.id DESC
                    LIMIT 1
                ) AS last_message_text,
                (
                    SELECT gm.message_type
                    FROM server_channels sc
                    JOIN group_messages gm ON gm.group_id = sc.group_id
                    WHERE sc.server_id = s.id
                      AND NOT EXISTS (
                          SELECT 1
                          FROM hidden_group_messages hgm
                          WHERE hgm.group_message_id = gm.id AND hgm.user_id = %s
                      )
                    ORDER BY gm.created_at DESC, gm.id DESC
                    LIMIT 1
                ) AS last_message_type,
                (
                    SELECT gm.created_at
                    FROM server_channels sc
                    JOIN group_messages gm ON gm.group_id = sc.group_id
                    WHERE sc.server_id = s.id
                      AND NOT EXISTS (
                          SELECT 1
                          FROM hidden_group_messages hgm
                          WHERE hgm.group_message_id = gm.id AND hgm.user_id = %s
                      )
                    ORDER BY gm.created_at DESC, gm.id DESC
                    LIMIT 1
                ) AS updated_at,
                (
                    SELECT SUM(
                        CASE
                            WHEN gm.message_type != 'system'
                             AND gm.sender_id != %s
                             AND gm.id > COALESCE((
                                 SELECT grs.last_read_message_id
                                 FROM group_read_states grs
                                 WHERE grs.group_id = sc.group_id AND grs.user_id = %s
                             ), 0)
                             AND NOT EXISTS (
                                 SELECT 1
                                 FROM hidden_group_messages hgm
                                 WHERE hgm.group_message_id = gm.id AND hgm.user_id = %s
                             )
                            THEN 1
                            ELSE 0
                        END
                    )
                    FROM server_channels sc
                    JOIN group_messages gm ON gm.group_id = sc.group_id
                    WHERE sc.server_id = s.id
                ) AS unread_count,
                (
                    SELECT sc.group_id
                    FROM server_channels sc
                    JOIN group_members gmbr ON gmbr.group_id = sc.group_id
                    WHERE sc.server_id = s.id AND gmbr.user_id = %s
                    ORDER BY sc.position, sc.id
                    LIMIT 1
                ) AS default_channel_id
            FROM servers s
            JOIN server_members sm ON sm.server_id = s.id
            WHERE sm.user_id = %s
            ORDER BY COALESCE(updated_at, s.created_at) DESC, s.id DESC
        """, (
            user_id,
            user_id,
            user_id,
            user_id,
            user_id,
            user_id,
            user_id,
            user_id
        )).fetchall()

        return jsonify([
            {
                "id": server["id"],
                "type": "server",
                "title": server["title"],
                "description": server["description"],
                "default_channel_id": server["default_channel_id"],
                "last_message": {
                    "text": server["last_message_text"],
                    "message_type": server["last_message_type"] or "text"
                } if server["last_message_text"] is not None or server["last_message_type"] is not None else None,
                "started_at": format_timestamp(server["created_at"]),
                "updated_at": format_timestamp(server["updated_at"] or server["created_at"]),
                "unread_count": int(server["unread_count"] or 0)
            }
            for server in server_rows
        ])
    finally:
        conn.close()


@app.get("/servers/<int:server_id>")
def get_server(server_id):
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    conn = get_db()
    try:
        payload = build_server_response(conn, server_id, user_id)
        if not payload:
            return jsonify({"message": "Сервер не найден"}), 404
        return jsonify(payload)
    finally:
        conn.close()


@app.patch("/servers/<int:server_id>")
def update_server(server_id):
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    data = request.json or {}
    conn = get_db()
    try:
        if not can_manage_server(conn, user_id, server_id):
            return jsonify({"message": "Недостаточно прав"}), 403

        server = conn.execute("""
            SELECT id, title, description, allow_member_invites
            FROM servers
            WHERE id = %s
            LIMIT 1
        """, (server_id,)).fetchone()
        if not server:
            return jsonify({"message": "Сервер не найден"}), 404

        next_title = normalize_server_title(data.get("title"), fallback=row_value(server, "title") or "")
        next_description = str(
            data.get("description")
            if data.get("description") is not None
            else row_value(server, "description") or ""
        ).strip() or None
        next_allow_member_invites = normalize_boolean_flag(
            data.get("allow_member_invites"),
            default=bool(row_value(server, "allow_member_invites")),
        )

        if not next_title:
            return jsonify({"message": "Название сервера обязательно"}), 400

        conn.execute("""
            UPDATE servers
            SET title = %s,
                description = %s,
                allow_member_invites = %s
            WHERE id = %s
        """, (
            next_title,
            next_description,
            1 if next_allow_member_invites else 0,
            server_id,
        ))
        append_server_audit_log(conn, server_id, user_id, "update_server_profile", details={
            "title": next_title,
            "description": next_description or "",
            "allow_member_invites": bool(next_allow_member_invites),
        })
        conn.commit()

        payload = build_server_response(conn, server_id, user_id)
        return jsonify({"server": payload})
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


@app.delete("/servers/<int:server_id>/audit-log")
def clear_server_audit_log(server_id):
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    conn = get_db()
    try:
        server = conn.execute("""
            SELECT owner_id
            FROM servers
            WHERE id = %s
            LIMIT 1
        """, (server_id,)).fetchone()
        if not server:
            return jsonify({"message": "Сервер не найден"}), 404
        if int(row_value(server, "owner_id") or 0) != int(user_id):
            return jsonify({"message": "Только создатель сервера может очистить журнал аудита"}), 403

        conn.execute("""
            DELETE FROM server_audit_log
            WHERE server_id = %s
        """, (server_id,))
        append_server_audit_log(conn, server_id, user_id, "clear_audit_log")
        conn.commit()
        return jsonify({"ok": True, "server_id": server_id})
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


@app.get("/servers/<int:server_id>/invites")
def get_server_invites(server_id):
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    conn = get_db()
    try:
        if not can_access_server(conn, user_id, server_id):
            return jsonify({"message": "Сервер не найден"}), 404
        if not can_create_server_invites(conn, user_id, server_id):
            return jsonify({"message": "У вас нет прав приглашать участников на этот сервер"}), 403
        server_summary = get_server_summary_for_invites(conn, server_id)
        viewer_member = get_server_member(conn, server_id, user_id)
        invites = [
            serialize_server_invite_row(invite_row, server_summary, viewer_member)
            for invite_row in get_active_server_invites(conn, server_id)
        ]
        return jsonify({"items": invites})
    finally:
        conn.close()


@app.get("/servers/<int:server_id>/invite-contacts")
def get_server_invite_contacts(server_id):
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    conn = get_db()
    try:
        if not can_access_server(conn, user_id, server_id):
            return jsonify({"message": "Сервер не найден"}), 404
        if not can_create_server_invites(conn, user_id, server_id):
            return jsonify({"message": "У вас нет прав приглашать участников на этот сервер"}), 403

        contacts = conn.execute("""
            SELECT
                u.id,
                u.name,
                u.username,
                u.bio,
                u.date_of_birth,
                ct.alias AS contact_alias,
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
              AND NOT EXISTS (
                  SELECT 1
                  FROM server_members sm
                  WHERE sm.server_id = %s
                    AND sm.user_id = u.id
              )
            ORDER BY COALESCE(NULLIF(ct.alias, ''), u.name, u.username), u.username
        """, (user_id, user_id, user_id, user_id, server_id)).fetchall()

        return jsonify({
            "items": [
                {
                    **serialize_user_panel_payload({
                        **dict(contact),
                        "is_contact": True
                    }),
                    "chat_id": contact["chat_id"]
                }
                for contact in contacts
            ]
        })
    finally:
        conn.close()


@app.post("/servers/<int:server_id>/invites")
def create_server_invite_endpoint(server_id):
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    data = request.json or {}
    expires_in = str(data.get("expires_in") or "never").strip().lower()
    max_uses_raw = str(data.get("max_uses") if data.get("max_uses") is not None else "0").strip().lower()
    duration_map = {
        "30m": timedelta(minutes=30),
        "1h": timedelta(hours=1),
        "24h": timedelta(hours=24),
        "7d": timedelta(days=7),
        "never": None,
    }
    max_uses_map = {
        "1": 1,
        "5": 5,
        "10": 10,
        "0": None,
        "unlimited": None,
    }
    if expires_in not in duration_map:
        expires_in = "never"
    if max_uses_raw not in max_uses_map:
        max_uses_raw = "0"

    conn = get_db()
    try:
        if not can_access_server(conn, user_id, server_id):
            return jsonify({"message": "Сервер не найден"}), 404
        if not can_create_server_invites(conn, user_id, server_id):
            return jsonify({"message": "У вас нет прав приглашать участников на этот сервер"}), 403
        expires_delta = duration_map[expires_in]
        invite = create_server_invite(conn, server_id, user_id, {
            "expires_at": datetime.now(timezone.utc) + expires_delta if expires_delta else None,
            "max_uses": max_uses_map[max_uses_raw],
            "only_friends": False,
            "one_time": bool(data.get("one_time")),
            "require_approval": False,
        })
        append_server_audit_log(conn, server_id, user_id, "create_invite", details={
            "code": row_value(invite, "code"),
            "max_uses": max_uses_map[max_uses_raw],
            "one_time": bool(data.get("one_time")),
            "expires_at": format_timestamp(row_value(invite, "expires_at")),
        })
        conn.commit()
        server_summary = get_server_summary_for_invites(conn, server_id)
        viewer_member = get_server_member(conn, server_id, user_id)
        return jsonify({
            "invite": serialize_server_invite_row(invite, server_summary, viewer_member)
        }), 201
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


@app.delete("/servers/<int:server_id>/invites/<code>")
def revoke_server_invite(server_id, code):
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    conn = get_db()
    try:
        if not can_access_server(conn, user_id, server_id):
            return jsonify({"message": "Сервер не найден"}), 404
        if not can_create_server_invites(conn, user_id, server_id):
            return jsonify({"message": "У вас нет прав приглашать участников на этот сервер"}), 403
        invite = conn.execute("""
            SELECT id
            FROM server_invites
            WHERE server_id = %s AND code = %s
            LIMIT 1
        """, (server_id, code)).fetchone()
        if not invite:
            return jsonify({"message": "Приглашение не найдено"}), 404
        conn.execute("""
            UPDATE server_invites
            SET revoked = 1
            WHERE server_id = %s AND code = %s
        """, (server_id, code))
        conn.execute("""
            UPDATE servers
            SET invite_code = CASE WHEN invite_code = %s THEN NULL ELSE invite_code END
            WHERE id = %s
        """, (code, server_id))
        append_server_audit_log(conn, server_id, user_id, "revoke_invite", details={
            "code": code,
        })
        conn.commit()
        return jsonify({"ok": True, "code": code})
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


@app.delete("/servers/<int:server_id>/leave")
def leave_server(server_id):
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    conn = get_db()
    try:
        server = conn.execute("""
            SELECT id, title, owner_id
            FROM servers
            WHERE id = %s
            LIMIT 1
        """, (server_id,)).fetchone()
        if not server:
            return jsonify({"message": "Сервер не найден"}), 404

        member = get_server_member(conn, server_id, user_id)
        if not member:
            return jsonify({"message": "Вы не состоите на сервере"}), 404

        if int(server["owner_id"]) == int(user_id):
            return jsonify({"message": "Владелец сервера пока не может выйти без передачи владения или удаления сервера"}), 409

        remove_server_member_from_server(conn, server_id, user_id)
        conn.commit()

        remaining_member_ids = get_server_member_ids(conn, server_id)
        emit_chat_list_updated_for_users([user_id], "server", server_id)
        emit_server_structure_updated_for_users([*remaining_member_ids, user_id], server_id)

        return jsonify({
            "ok": True,
            "server_id": server_id,
            "user_id": user_id
        })
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


@app.delete("/servers/<int:server_id>/members/<int:target_user_id>")
def remove_server_member(server_id, target_user_id):
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    conn = get_db()
    try:
        if not can_manage_server_member_action(conn, user_id, server_id, target_user_id, permission_key="kick_members"):
            return jsonify({"message": "Недостаточно прав"}), 403
        target_member = get_server_member(conn, server_id, target_user_id)
        if not target_member:
            return jsonify({"message": "Участник не найден"}), 404

        remove_server_member_from_server(conn, server_id, target_user_id)
        append_server_audit_log(conn, server_id, user_id, "remove_member", target_user_id=target_user_id)
        conn.commit()

        remaining_member_ids = get_server_member_ids(conn, server_id)
        emit_chat_list_updated_for_users([target_user_id], "server", server_id)
        emit_server_structure_updated_for_users([*remaining_member_ids, target_user_id], server_id)

        return jsonify({
            "ok": True,
            "server_id": server_id,
            "user_id": int(target_user_id),
        })
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


@app.post("/servers/<int:server_id>/members/<int:target_user_id>/ban")
def ban_server_member(server_id, target_user_id):
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    conn = get_db()
    try:
        if not can_manage_server_member_action(conn, user_id, server_id, target_user_id, permission_key="ban_members"):
            return jsonify({"message": "Недостаточно прав"}), 403
        target_member = get_server_member(conn, server_id, target_user_id)
        if not target_member:
            return jsonify({"message": "Участник не найден"}), 404

        conn.execute("""
            INSERT IGNORE INTO server_banned_users (server_id, user_id, created_by)
            VALUES (%s, %s, %s)
        """, (server_id, target_user_id, user_id))
        remove_server_member_from_server(conn, server_id, target_user_id)
        append_server_audit_log(conn, server_id, user_id, "ban_member", target_user_id=target_user_id)
        conn.commit()

        remaining_member_ids = get_server_member_ids(conn, server_id)
        emit_chat_list_updated_for_users([target_user_id], "server", server_id)
        emit_server_structure_updated_for_users([*remaining_member_ids, target_user_id], server_id)

        return jsonify({
            "ok": True,
            "server_id": server_id,
            "user_id": int(target_user_id),
            "banned": True,
        })
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


@app.patch("/servers/<int:server_id>/members/<int:target_user_id>")
def update_server_member(server_id, target_user_id):
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    conn = get_db()
    try:
        data = request.json or {}
        next_role_name = str(data.get("role") or "").strip()
        next_role_key = next_role_name.lower()
        if not next_role_name:
            return jsonify({"message": "Роль обязательна"}), 400
        if not can_manage_server_member_action(
            conn,
            user_id,
            server_id,
            target_user_id,
            permission_key="manage_roles",
            next_role_key=next_role_key,
        ):
            return jsonify({"message": "Недостаточно прав"}), 403

        target_member = get_server_member(conn, server_id, target_user_id)
        if not target_member:
            return jsonify({"message": "Участник не найден"}), 404

        available_roles = {
            str(role.get("name") or "").strip().lower(): str(role.get("name") or "").strip()
            for role in get_server_roles(conn, server_id)
            if str(role.get("name") or "").strip()
        }
        if next_role_key not in available_roles:
            return jsonify({"message": "Роль не найдена"}), 404

        conn.execute("""
            UPDATE server_members
            SET role = %s,
                is_admin = %s
            WHERE server_id = %s AND user_id = %s
        """, (
            available_roles[next_role_key],
            1 if next_role_key == "admin" else 0,
            server_id,
            target_user_id,
        ))
        append_server_audit_log(conn, server_id, user_id, "assign_role", target_user_id=target_user_id, details={
            "role": available_roles[next_role_key],
        })
        conn.commit()

        emit_server_structure_updated(conn, server_id)
        return jsonify({
            "ok": True,
            "server_id": server_id,
            "user_id": int(target_user_id),
            "role": available_roles[next_role_key],
        })
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


@app.post("/servers/<int:server_id>/roles")
def create_server_role(server_id):
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    conn = get_db()
    try:
        if not can_manage_server(conn, user_id, server_id):
            return jsonify({"message": "Недостаточно прав"}), 403
        ensure_default_server_roles(conn, server_id, user_id)
        data = request.json or {}
        name = str(data.get("name") or "").strip()[:80]
        color = str(data.get("color") or "#94a3b8").strip()[:32] or "#94a3b8"
        if not name:
            return jsonify({"message": "Название роли обязательно"}), 400
        exists = conn.execute("""
            SELECT id
            FROM server_roles
            WHERE server_id = %s AND LOWER(name) = LOWER(%s)
            LIMIT 1
        """, (server_id, name)).fetchone()
        if exists:
            return jsonify({"message": "Роль с таким названием уже существует"}), 409
        next_position_row = conn.execute("""
            SELECT CASE
                WHEN MIN(position) IS NULL THEN 90
                ELSE MIN(position) - 10
            END AS next_position
            FROM server_roles
            WHERE server_id = %s
              AND is_system = 0
        """, (server_id,)).fetchone()
        next_position = int(next_position_row["next_position"] or 90)
        permissions = data.get("permissions") if isinstance(data.get("permissions"), dict) else {}
        conn.execute("""
            INSERT INTO server_roles (server_id, name, color, position, is_system, permissions_json, created_by)
            VALUES (%s, %s, %s, %s, 0, %s, %s)
        """, (
            server_id,
            name,
            color,
            next_position,
            json.dumps(permissions, ensure_ascii=False),
            user_id,
        ))
        role_id = conn.execute("SELECT LAST_INSERT_ID() AS id").fetchone()["id"]
        append_server_audit_log(conn, server_id, user_id, "create_role", details={
            "name": name,
            "color": color,
        })
        conn.commit()
        role_row = conn.execute("""
            SELECT id, server_id, name, color, position, is_system, permissions_json, created_by, created_at
            FROM server_roles
            WHERE id = %s
            LIMIT 1
        """, (role_id,)).fetchone()
        return jsonify({"role": serialize_server_role_row(role_row)}), 201
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


@app.patch("/servers/<int:server_id>/roles/<int:role_id>")
def update_server_role(server_id, role_id):
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    conn = get_db()
    try:
        if not can_manage_server(conn, user_id, server_id):
            return jsonify({"message": "Недостаточно прав"}), 403
        role_row = conn.execute("""
            SELECT id, server_id, name, color, position, is_system, permissions_json, created_by, created_at
            FROM server_roles
            WHERE id = %s AND server_id = %s
            LIMIT 1
        """, (role_id, server_id)).fetchone()
        if not role_row:
            return jsonify({"message": "Роль не найдена"}), 404
        data = request.json or {}
        current_name = str(row_value(role_row, "name") or "")
        current_color = str(row_value(role_row, "color") or "#94a3b8")
        current_position = int(row_value(role_row, "position") or 0)
        is_system_role = bool(row_value(role_row, "is_system"))
        raw_next_color = data.get("color")
        next_name = str(data.get("name") or row_value(role_row, "name") or "").strip()[:80]
        next_color = str(data.get("color") or current_color).strip()[:32] or "#94a3b8"
        next_position = int(data.get("position") if data.get("position") is not None else current_position)
        if is_system_role and next_name != current_name:
            return jsonify({"message": "Системную роль нельзя переименовать"}), 400
        if is_system_role and next_position != current_position:
            return jsonify({"message": "Порядок системных ролей нельзя изменить"}), 400
        permissions = data.get("permissions")
        if current_name == "owner":
            if next_position != current_position or next_name != current_name:
                return jsonify({"message": "Роль владельца не может быть изменена"}), 400
            if raw_next_color is not None or isinstance(permissions, dict):
                return jsonify({"message": "Роль владельца не может быть изменена"}), 400
            next_color = current_color
            permissions_json = json.dumps(build_server_role_permissions(enabled=True), ensure_ascii=False)
        else:
            permissions_json = (
                json.dumps(permissions, ensure_ascii=False)
                if isinstance(permissions, dict)
                else row_value(role_row, "permissions_json")
            )
        duplicate = conn.execute("""
            SELECT id
            FROM server_roles
            WHERE server_id = %s AND LOWER(name) = LOWER(%s) AND id != %s
            LIMIT 1
        """, (server_id, next_name, role_id)).fetchone()
        if duplicate:
            return jsonify({"message": "Роль с таким названием уже существует"}), 409
        conn.execute("""
            UPDATE server_roles
            SET name = %s,
                color = %s,
                position = %s,
                permissions_json = %s
            WHERE id = %s AND server_id = %s
        """, (next_name, next_color, next_position, permissions_json, role_id, server_id))
        append_server_audit_log(conn, server_id, user_id, "update_role", details={
            "role_id": role_id,
            "name": next_name,
            "color": next_color,
            "position": next_position,
        })
        conn.commit()
        updated_row = conn.execute("""
            SELECT id, server_id, name, color, position, is_system, permissions_json, created_by, created_at
            FROM server_roles
            WHERE id = %s
            LIMIT 1
        """, (role_id,)).fetchone()
        return jsonify({"role": serialize_server_role_row(updated_row)})
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


@app.delete("/servers/<int:server_id>/roles/<int:role_id>")
def delete_server_role(server_id, role_id):
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    conn = get_db()
    try:
        if not can_manage_server(conn, user_id, server_id):
            return jsonify({"message": "Недостаточно прав"}), 403
        role_row = conn.execute("""
            SELECT id, name, is_system
            FROM server_roles
            WHERE id = %s AND server_id = %s
            LIMIT 1
        """, (role_id, server_id)).fetchone()
        if not role_row:
            return jsonify({"message": "Роль не найдена"}), 404
        if bool(row_value(role_row, "is_system")):
            return jsonify({"message": "Системную роль нельзя удалить"}), 400
        conn.execute("""
            DELETE FROM server_roles
            WHERE id = %s AND server_id = %s
        """, (role_id, server_id))
        append_server_audit_log(conn, server_id, user_id, "delete_role", details={
            "role_id": role_id,
            "name": row_value(role_row, "name") or "",
        })
        conn.commit()
        return jsonify({"ok": True, "role_id": role_id})
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


@app.post("/servers")
def create_server():
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    try:
        require_permission_to_create_groups(getattr(g, "current_user", None) or {})
    except PermissionError as error:
        return jsonify({"message": str(error)}), 403

    data = request.json or {}
    title = normalize_server_title(data.get("title"), fallback="")
    description = str(data.get("description") or "").strip()
    allow_member_invites = normalize_boolean_flag(data.get("allow_member_invites"), default=False)
    if not title:
        return jsonify({"message": "Название сервера обязательно"}), 400

    conn = get_db()
    try:
        created = create_server_with_defaults(conn, user_id, title, description, allow_member_invites)
        conn.commit()
        payload = build_server_response(conn, created["server_id"], user_id)
        return jsonify({
            "server": payload,
            "server_id": created["server_id"],
            "category_id": created["category_id"],
            "group_id": created["group_id"]
        }), 201
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


@app.post("/servers/<int:server_id>/categories")
def create_server_category(server_id):
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    conn = get_db()
    try:
        if not can_manage_server(conn, user_id, server_id):
            return jsonify({"message": "Недостаточно прав"}), 403
        data = request.json or {}
        title = normalize_category_title(data.get("title"), fallback="")
        if not title:
            return jsonify({"message": "Название категории обязательно"}), 400
        next_position_row = conn.execute("""
            SELECT COALESCE(MAX(position), -1) + 1 AS next_position
            FROM server_categories
            WHERE server_id = %s
        """, (server_id,)).fetchone()
        next_position = int(next_position_row["next_position"] or 0)
        conn.execute("""
            INSERT INTO server_categories (server_id, title, name, position, created_by)
            VALUES (%s, %s, %s, %s, %s)
        """, (server_id, title, title, next_position, user_id))
        category_id = conn.execute("SELECT LAST_INSERT_ID() AS id").fetchone()["id"]
        append_server_audit_log(conn, server_id, user_id, "create_category", details={
            "category_id": category_id,
            "title": title,
        })
        conn.commit()
        emit_server_structure_updated(conn, server_id)
        return jsonify({
            "id": category_id,
            "server_id": server_id,
            "title": title,
            "position": next_position
        }), 201
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


@app.post("/servers/<int:server_id>/channels")
@app.post("/servers/<int:server_id>/rooms")
def create_server_channel(server_id):
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    conn = get_db()
    try:
        if not can_manage_server(conn, user_id, server_id):
            return jsonify({"message": "Недостаточно прав"}), 403
        data = request.json or {}
        try:
            category_id = int(data.get("category_id"))
        except (TypeError, ValueError):
            return jsonify({"message": "Некорректная категория"}), 400
        category = conn.execute("""
            SELECT id
            FROM server_categories
            WHERE id = %s AND server_id = %s
            LIMIT 1
        """, (category_id, server_id)).fetchone()
        if not category:
            return jsonify({"message": "Категория не найдена"}), 404
        payload = normalize_server_channel_payload(data)
        if not payload["title"]:
            return jsonify({"message": "Название канала обязательно"}), 400
        group_id = create_server_channel_group(
            conn,
            server_id,
            category_id,
            user_id,
            payload["title"],
            description=payload["description"],
            channel_type=payload["type"],
            access=payload["access"],
            role_permissions=payload["role_permissions"],
            rules=payload["rules"],
            restrictions=payload["restrictions"],
        )
        conn.commit()
        emit_server_structure_updated(conn, server_id)
        emit_chat_list_updated_for_users(get_server_member_ids(conn, server_id), "server", server_id)
        channel = get_server_channel(conn, server_id, group_id)
        return jsonify({
            **serialize_server_channel_row(channel),
            "group_id": group_id
        }), 201
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


@app.patch("/servers/<int:server_id>/categories/<int:category_id>")
def update_server_category(server_id, category_id):
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    conn = get_db()
    try:
        if not can_manage_server(conn, user_id, server_id):
            return jsonify({"message": "Недостаточно прав"}), 403
        category = get_server_category(conn, server_id, category_id)
        if not category:
            return jsonify({"message": "Категория не найдена"}), 404
        data = request.json or {}
        title = normalize_category_title(data.get("title"), fallback="")
        if not title:
            return jsonify({"message": "Название категории обязательно"}), 400
        conn.execute("""
            UPDATE server_categories
            SET title = %s, name = %s
            WHERE id = %s AND server_id = %s
        """, (title, title, category_id, server_id))
        append_server_audit_log(conn, server_id, user_id, "update_category", details={
            "category_id": category_id,
            "title": title,
        })
        conn.commit()
        emit_server_structure_updated(conn, server_id)
        return jsonify({
            "id": category_id,
            "server_id": server_id,
            "title": title
        })
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


@app.delete("/servers/<int:server_id>/categories/<int:category_id>")
def delete_server_category(server_id, category_id):
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    conn = get_db()
    try:
        if not can_manage_server(conn, user_id, server_id):
            return jsonify({"message": "Недостаточно прав"}), 403
        category = get_server_category(conn, server_id, category_id)
        if not category:
            return jsonify({"message": "Категория не найдена"}), 404
        channel_rows = conn.execute("""
            SELECT group_id
            FROM server_channels
            WHERE server_id = %s AND category_id = %s
            ORDER BY position, id
        """, (server_id, category_id)).fetchall()
        for channel in channel_rows:
            delete_group_with_dependencies(conn, channel["group_id"])
        conn.execute("""
            DELETE FROM server_categories
            WHERE id = %s AND server_id = %s
        """, (category_id, server_id))
        append_server_audit_log(conn, server_id, user_id, "delete_category", details={
            "category_id": category_id,
            "deleted_channel_ids": [int(row["group_id"]) for row in channel_rows],
        })
        conn.commit()
        emit_server_structure_updated(conn, server_id)
        emit_chat_list_updated_for_users(get_server_member_ids(conn, server_id), "server", server_id)
        return jsonify({
            "ok": True,
            "server_id": server_id,
            "category_id": category_id,
            "deleted_channel_ids": [int(row["group_id"]) for row in channel_rows]
        })
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


@app.patch("/servers/<int:server_id>/channels/<int:group_id>")
@app.patch("/servers/<int:server_id>/rooms/<int:group_id>")
def update_server_channel(server_id, group_id):
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    conn = get_db()
    try:
        if not can_manage_server(conn, user_id, server_id):
            return jsonify({"message": "Недостаточно прав"}), 403
        channel = get_server_channel(conn, server_id, group_id)
        if not channel:
            return jsonify({"message": "Канал не найден"}), 404
        data = request.json or {}
        payload = normalize_server_channel_payload(data, serialize_server_channel_row(channel))
        if not payload["title"]:
            return jsonify({"message": "Название канала обязательно"}), 400
        conn.execute("""
            UPDATE server_channels
            SET title = %s,
                name = %s,
                slug = %s,
                description = %s,
                channel_type = %s,
                access_json = %s,
                role_permissions_json = %s,
                rules_json = %s,
                restrictions_json = %s
            WHERE server_id = %s AND group_id = %s
        """, (
            payload["title"],
            payload["title"],
            payload["title"],
            payload["description"],
            payload["type"],
            json.dumps(payload["access"], ensure_ascii=False),
            json.dumps(payload["role_permissions"], ensure_ascii=False),
            json.dumps(payload["rules"], ensure_ascii=False),
            json.dumps(payload["restrictions"], ensure_ascii=False),
            server_id,
            group_id,
        ))
        conn.execute("""
            UPDATE `groups`
            SET title = %s, description = %s
            WHERE id = %s
        """, (payload["title"], payload["description"], group_id))
        append_server_audit_log(conn, server_id, user_id, "update_channel", details={
            "group_id": group_id,
            "title": payload["title"],
            "type": payload["type"],
        })
        conn.commit()
        emit_group_updated(group_id)
        emit_server_structure_updated(conn, server_id)
        emit_chat_list_updated_for_users(get_server_member_ids(conn, server_id), "server", server_id)
        updated_channel = get_server_channel(conn, server_id, group_id)
        return jsonify({
            **serialize_server_channel_row(updated_channel),
            "group_id": group_id
        })
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


@app.delete("/servers/<int:server_id>/channels/<int:group_id>")
@app.delete("/servers/<int:server_id>/rooms/<int:group_id>")
def delete_server_channel(server_id, group_id):
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    conn = get_db()
    try:
        if not can_manage_server(conn, user_id, server_id):
            return jsonify({"message": "Недостаточно прав"}), 403
        channel = get_server_channel(conn, server_id, group_id)
        if not channel:
            return jsonify({"message": "Канал не найден"}), 404
        delete_group_with_dependencies(conn, group_id)
        append_server_audit_log(conn, server_id, user_id, "delete_channel", details={
            "group_id": group_id,
            "title": row_value(channel, "title") or "",
        })
        conn.commit()
        emit_server_structure_updated(conn, server_id)
        emit_chat_list_updated_for_users(get_server_member_ids(conn, server_id), "server", server_id)
        return jsonify({
            "ok": True,
            "server_id": server_id,
            "group_id": group_id
        })
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


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

    try:
        ensure_direct_target_is_writable(conn, user_id, participant_id)
    except PermissionError as error:
        conn.close()
        return jsonify({"message": str(error)}), 403

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
            u.date_of_birth,
            ct.alias AS contact_alias,
            (ct.id IS NOT NULL) AS is_contact,
            EXISTS (
                SELECT 1
                FROM user_muted_users umu
                WHERE umu.owner_user_id = %s AND umu.muted_user_id = u.id
            ) AS is_muted,
            EXISTS (
                SELECT 1
                FROM user_blocked_users ubu
                WHERE ubu.owner_user_id = %s AND ubu.blocked_user_id = u.id
            ) AS is_blocked,
            EXISTS (
                SELECT 1
                FROM user_blocked_users ubu
                WHERE ubu.owner_user_id = u.id AND ubu.blocked_user_id = %s
            ) AS is_blocked_by,
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
        LEFT JOIN contacts ct
            ON ct.owner_user_id = %s AND ct.contact_user_id = u.id
        WHERE c.id = %s AND (c.user1_id = %s OR c.user2_id = %s)
    """, (user_id, user_id, user_id, user_id, user_id, user_id, chat_id, user_id, user_id)).fetchone()

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

    hide_presence = should_hide_presence_for_username(chat["username"])
    return jsonify({
        "id": chat["id"],
        "user_id": chat["user_id"],
        "title": chat["contact_alias"] or chat["name"] or chat["username"],
        "name": chat["name"],
        "username": chat["username"],
        "bio": chat["bio"],
        "date_of_birth": format_date_value(chat["date_of_birth"]),
        "contact_alias": chat["contact_alias"],
        "is_contact": bool(chat["is_contact"]),
        "badges": serialize_user_badges(chat),
        "is_muted": bool(chat["is_muted"]),
        "is_blocked": bool(chat["is_blocked"]),
        "is_blocked_by": bool(chat["is_blocked_by"]),
        "is_online": False if hide_presence else is_user_online(chat["user_id"]),
        "last_seen": None if hide_presence else format_timestamp(get_user_last_seen(chat["user_id"])),
        "hide_presence": hide_presence,
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
    try:
        require_permission_to_send_messages(getattr(g, "current_user", None) or {})
    except PermissionError as error:
        return jsonify({"message": str(error)}), 403

    payload = parse_message_create_payload()
    text = payload["text"]
    reply_to_id = payload["reply_to_id"]
    images = payload["images"]
    files = payload.get("files") or []

    if not text and not images and not files:
        return jsonify({"message": "Текст сообщения или файл обязательны"}), 400

    attachments = []
    if images or files:
        try:
            current_user = getattr(g, "current_user", None) or {}
            ensure_global_file_uploads_enabled()
            require_permission_to_upload_files(current_user)
        except PermissionError as error:
            return jsonify({"message": str(error)}), 403

    conn = get_db()
    chat = can_access_direct_chat(conn, user_id, chat_id)

    if not chat:
        conn.close()
        return jsonify({"message": "Чат не найден"}), 404

    recipient_user_id = get_direct_chat_recipient_id(conn, chat_id, user_id)
    try:
        ensure_direct_target_is_writable(conn, user_id, recipient_user_id)
    except PermissionError as error:
        conn.close()
        return jsonify({"message": str(error)}), 403

    reply_to_message = None
    if reply_to_id is not None:
        reply_to_message = get_direct_reply_target(conn, chat_id, reply_to_id)
        if not reply_to_message:
            conn.close()
            return jsonify({"message": "Сообщение для ответа не найдено"}), 404
    if images or files:
        try:
            attachments = [save_message_image_upload(image) for image in images]
            attachments.extend(save_message_attachment_upload(file) for file in files)
        except ValueError as error:
            conn.close()
            return jsonify({"message": str(error)}), 400
        except RuntimeError as error:
            conn.close()
            return jsonify({"message": str(error)}), 500
    if text and not images and not files and reply_to_id is None and is_duplicate_recent_direct_invite(conn, chat_id, user_id, text):
        conn.close()
        return jsonify({"message": "Эта ссылка уже была отправлена последним сообщением"}), 409
    conn.execute("DELETE FROM hidden_direct_chats WHERE chat_id = %s", (chat_id,))
    message = create_direct_message_record(
        conn,
        chat_id,
        user_id,
        text,
        "text",
        reply_to_message=reply_to_message
    )
    if attachments:
        insert_message_attachments(conn, "direct", message["id"], attachments)
        message = get_direct_message_for_chat(conn, chat_id, message["id"])
    conn.commit()
    member_ids = get_direct_chat_member_ids(conn, chat_id)
    message_data = serialize_direct_message(message)
    emit_inbox_message_for_users(member_ids, {
        **message_data,
        "chat_type": "direct",
        "chat_id": int(chat_id),
        "thread_title": message["sender_name"] or "Чат"
    }, exclude_user_id=user_id)
    conn.close()

    socketio.emit("new_message", message_data, room=f"direct_{chat_id}")
    emit_chat_list_updated_for_users(member_ids, "direct", chat_id)

    return jsonify(message_data), 201


@app.post("/chats/<int:chat_id>/voice")
def create_chat_voice_message(chat_id):
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401
    try:
        current_user = getattr(g, "current_user", None) or {}
        ensure_global_file_uploads_enabled()
        require_permission_to_send_messages(current_user)
        require_permission_to_upload_files(current_user)
    except PermissionError as error:
        return jsonify({"message": str(error)}), 403

    conn = get_db()
    chat = can_access_direct_chat(conn, user_id, chat_id)
    if not chat:
        conn.close()
        return jsonify({"message": "Чат не найден"}), 404

    recipient_user_id = get_direct_chat_recipient_id(conn, chat_id, user_id)
    try:
        ensure_direct_target_is_writable(conn, user_id, recipient_user_id)
    except PermissionError as error:
        conn.close()
        return jsonify({"message": str(error)}), 403

    try:
        audio = save_voice_upload(request.files.get("voice"))
    except ValueError as error:
        conn.close()
        return jsonify({"message": str(error)}), 400
    except RuntimeError as error:
        conn.close()
        return jsonify({"message": str(error)}), 500

    duration_ms = parse_duration_ms(request.form.get("duration_ms"))
    reply_to_id = request.form.get("reply_to_id")
    reply_to_message = None
    if reply_to_id is not None and str(reply_to_id).strip():
        reply_to_message = get_direct_reply_target(conn, chat_id, reply_to_id)
        if not reply_to_message:
            conn.close()
            return jsonify({"message": "Сообщение для ответа не найдено"}), 404
    conn.execute("DELETE FROM hidden_direct_chats WHERE chat_id = %s", (chat_id,))
    message = create_direct_message_record(
        conn,
        chat_id,
        user_id,
        "",
        "voice",
        audio={
            "url": audio["url"],
            "mime_type": audio["mime_type"],
            "duration_ms": duration_ms
        },
        reply_to_message=reply_to_message
    )
    conn.commit()
    member_ids = get_direct_chat_member_ids(conn, chat_id)
    message_data = serialize_direct_message(message)
    emit_inbox_message_for_users(member_ids, {
        **message_data,
        "chat_type": "direct",
        "chat_id": int(chat_id),
        "thread_title": message["sender_name"] or "Чат"
    }, exclude_user_id=user_id)
    conn.close()
    socketio.emit("new_message", message_data, room=f"direct_{chat_id}")
    emit_chat_list_updated_for_users(member_ids, "direct", chat_id)
    return jsonify(message_data), 201


@app.post("/chats/<int:chat_id>/sticker")
def create_chat_sticker_message(chat_id):
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401
    try:
        ensure_global_stickers_enabled()
        require_permission_to_send_messages(getattr(g, "current_user", None) or {})
    except PermissionError as error:
        return jsonify({"message": str(error)}), 403

    data = request.json or {}
    try:
        sticker_id = int(data.get("sticker_id"))
    except (TypeError, ValueError):
        return jsonify({"message": "Некорректный sticker_id"}), 400

    conn = get_db()
    chat = can_access_direct_chat(conn, user_id, chat_id)
    if not chat:
        conn.close()
        return jsonify({"message": "Чат не найден"}), 404

    recipient_user_id = get_direct_chat_recipient_id(conn, chat_id, user_id)
    try:
        ensure_direct_target_is_writable(conn, user_id, recipient_user_id)
    except PermissionError as error:
        conn.close()
        return jsonify({"message": str(error)}), 403

    sticker = fetch_sticker_for_user(conn, user_id, sticker_id)
    if not sticker:
        conn.close()
        return jsonify({"message": "Стикер недоступен"}), 404

    reply_to_id = data.get("reply_to_id")
    reply_to_message = None
    if reply_to_id is not None:
        reply_to_message = get_direct_reply_target(conn, chat_id, reply_to_id)
        if not reply_to_message:
            conn.close()
            return jsonify({"message": "Сообщение для ответа не найдено"}), 404

    conn.execute("DELETE FROM hidden_direct_chats WHERE chat_id = %s", (chat_id,))
    message = create_direct_message_record(
        conn,
        chat_id,
        user_id,
        "",
        "sticker",
        sticker={
            "id": int(sticker["id"]),
            "url": sticker["file_path"]
        },
        reply_to_message=reply_to_message
    )
    conn.commit()
    member_ids = get_direct_chat_member_ids(conn, chat_id)
    message_data = serialize_direct_message(message)
    emit_inbox_message_for_users(member_ids, {
        **message_data,
        "chat_type": "direct",
        "chat_id": int(chat_id),
        "thread_title": message["sender_name"] or "Чат"
    }, exclude_user_id=user_id)
    conn.close()
    socketio.emit("new_message", message_data, room=f"direct_{chat_id}")
    emit_chat_list_updated_for_users(member_ids, "direct", chat_id)
    return jsonify(message_data), 201


@app.post("/chats/<int:chat_id>/photo")
def create_chat_photo_message(chat_id):
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401
    try:
        current_user = getattr(g, "current_user", None) or {}
        ensure_global_file_uploads_enabled()
        require_permission_to_send_messages(current_user)
        require_permission_to_upload_files(current_user)
    except PermissionError as error:
        return jsonify({"message": str(error)}), 403

    conn = get_db()
    chat = can_access_direct_chat(conn, user_id, chat_id)
    if not chat:
        conn.close()
        return jsonify({"message": "Чат не найден"}), 404

    recipient_user_id = get_direct_chat_recipient_id(conn, chat_id, user_id)
    try:
        ensure_photo_messages_enabled()
        ensure_direct_target_is_writable(conn, user_id, recipient_user_id)
        image = save_photo_upload(request.files.get("photo"))
    except PermissionError as error:
        conn.close()
        return jsonify({"message": str(error)}), 403
    except ValueError as error:
        conn.close()
        return jsonify({"message": str(error)}), 400

    reply_to_id = request.form.get("reply_to_id")
    reply_to_message = None
    if reply_to_id is not None and str(reply_to_id).strip():
        reply_to_message = get_direct_reply_target(conn, chat_id, reply_to_id)
        if not reply_to_message:
            conn.close()
            return jsonify({"message": "Сообщение для ответа не найдено"}), 404

    conn.execute("DELETE FROM hidden_direct_chats WHERE chat_id = %s", (chat_id,))
    message = create_direct_message_record(
        conn,
        chat_id,
        user_id,
        "",
        "photo",
        image=image,
        reply_to_message=reply_to_message
    )
    conn.commit()
    member_ids = get_direct_chat_member_ids(conn, chat_id)
    message_data = serialize_direct_message(message)
    emit_inbox_message_for_users(member_ids, {
        **message_data,
        "chat_type": "direct",
        "chat_id": int(chat_id),
        "thread_title": message["sender_name"] or "Чат"
    }, exclude_user_id=user_id)
    conn.close()
    socketio.emit("new_message", message_data, room=f"direct_{chat_id}")
    emit_chat_list_updated_for_users(member_ids, "direct", chat_id)
    return jsonify(message_data), 201


@app.post("/chats/<int:chat_id>/messages/<int:message_id>/forward")
def forward_chat_message(chat_id, message_id):
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401
    try:
        require_permission_to_send_messages(getattr(g, "current_user", None) or {})
    except PermissionError as error:
        return jsonify({"message": str(error)}), 403

    data = request.json or {}
    target_chat_type = "group" if str(data.get("target_chat_type", "direct")).strip().lower() == "group" else "direct"
    try:
        target_chat_id = int(data.get("target_chat_id"))
    except (TypeError, ValueError):
        return jsonify({"message": "Некорректный целевой чат"}), 400

    conn = get_db()
    if not can_access_direct_chat(conn, user_id, chat_id):
        conn.close()
        return jsonify({"message": "Чат не найден"}), 404

    message = get_direct_message_for_chat(conn, chat_id, message_id)
    if not message:
        conn.close()
        return jsonify({"message": "Сообщение не найдено"}), 404

    try:
        forwarded_message = forward_message_to_target(conn, user_id, target_chat_type, target_chat_id, message)
    except ValueError as error:
        conn.close()
        return jsonify({"message": str(error)}), 400
    except PermissionError as error:
        conn.close()
        return jsonify({"message": str(error)}), 403
    except LookupError as error:
        conn.close()
        return jsonify({"message": str(error)}), 404

    conn.close()
    return jsonify(forwarded_message), 201


@app.post("/chats/<int:chat_id>/messages/forward-dialog")
def forward_chat_messages_as_dialog(chat_id):
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401
    try:
        require_permission_to_send_messages(getattr(g, "current_user", None) or {})
    except PermissionError as error:
        return jsonify({"message": str(error)}), 403

    message_ids, error = parse_message_ids_payload()
    if error:
        return jsonify({"message": error}), 400
    if len(message_ids) < 2:
        return jsonify({"message": "Нужно выбрать минимум два сообщения"}), 400

    data = request.json or {}
    target_chat_type = "group" if str(data.get("target_chat_type", "direct")).strip().lower() == "group" else "direct"
    try:
        target_chat_id = int(data.get("target_chat_id"))
    except (TypeError, ValueError):
        return jsonify({"message": "Некорректный целевой чат"}), 400

    conn = get_db()
    if not can_access_direct_chat(conn, user_id, chat_id):
        conn.close()
        return jsonify({"message": "Чат не найден"}), 404

    source_messages = fetch_direct_messages_by_ids(conn, chat_id, message_ids)
    if len(source_messages) != len(message_ids):
        conn.close()
        return jsonify({"message": "Некоторые сообщения не найдены"}), 404

    try:
        forwarded_message = forward_dialog_to_target(
            conn,
            user_id,
            target_chat_type,
            target_chat_id,
            build_forwarded_dialog_payload(source_messages, user_id)
        )
    except ValueError as error:
        conn.close()
        return jsonify({"message": str(error)}), 400
    except PermissionError as error:
        conn.close()
        return jsonify({"message": str(error)}), 403
    except LookupError as error:
        conn.close()
        return jsonify({"message": str(error)}), 404

    conn.close()
    return jsonify(forwarded_message), 201


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
        message_rows = conn.execute("SELECT id, audio_url, image_url FROM messages WHERE chat_id = %s", (chat_id,)).fetchall()
        message_ids = [
            row["id"]
            for row in message_rows
        ]
        voice_urls = [row["audio_url"] for row in message_rows]
        image_urls = [row["image_url"] for row in message_rows]
        attachment_urls = fetch_attachment_urls_for_messages(conn, "direct", message_ids)

        if message_ids:
            placeholders = ",".join("%s" for _ in message_ids)
            conn.execute(f"DELETE FROM hidden_messages WHERE message_id IN ({placeholders})", message_ids)
            delete_message_attachments(conn, "direct", message_ids)

        conn.execute("DELETE FROM hidden_direct_chats WHERE chat_id = %s", (chat_id,))
        conn.execute("DELETE FROM messages WHERE chat_id = %s", (chat_id,))
        conn.execute("DELETE FROM chats WHERE id = %s", (chat_id,))
        conn.commit()
        conn.close()
        remove_voice_files(voice_urls)
        remove_photo_files(image_urls)
        remove_message_image_files(attachment_urls)

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
    try:
        require_permission_to_send_messages(getattr(g, "current_user", None) or {})
    except PermissionError as error:
        return jsonify({"message": str(error)}), 403

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

    if (message["message_type"] or "text") not in {"text", "wide", "special"}:
        conn.close()
        return jsonify({"message": "Редактировать можно только текстовые и суперсообщения"}), 403

    if message["sender_id"] != user_id:
        conn.close()
        return jsonify({"message": "Можно редактировать только свои сообщения"}), 403

    preview = extract_message_preview(text)
    conn.execute("""
        UPDATE messages
        SET
            text = %s,
            preview_url = %s,
            preview_title = %s,
            preview_description = %s,
            preview_site_name = %s,
            audio_url = NULL,
            audio_mime_type = NULL,
            audio_duration_ms = NULL,
            edited_at = CURRENT_TIMESTAMP
        WHERE id = %s AND chat_id = %s
    """, (
        text,
        preview["url"] if preview else None,
        preview["title"][:255] if preview else None,
        preview["description"][:500] if preview else None,
        preview["site_name"][:255] if preview else None,
        message_id,
        chat_id
    ))
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
            return jsonify({"message": "У вас нет права удалять это сообщение у всех"}), 403

        voice_url = message.get("audio_url")
        image_url = message.get("image_url")
        attachment_urls = fetch_attachment_urls_for_messages(conn, "direct", [message_id])
        conn.execute("DELETE FROM hidden_messages WHERE message_id = %s", (message_id,))
        delete_message_attachments(conn, "direct", [message_id])
        conn.execute("DELETE FROM messages WHERE id = %s AND chat_id = %s", (message_id, chat_id))
        conn.commit()
        conn.close()
        remove_voice_files([voice_url])
        remove_photo_files([image_url])
        remove_message_image_files(attachment_urls)

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
        SELECT id, sender_id, audio_url, image_url
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
            return jsonify({"message": "У вас нет права удалять некоторые сообщения у всех"}), 403

        voice_urls = [row["audio_url"] for row in message_rows]
        image_urls = [row["image_url"] for row in message_rows]
        attachment_urls = fetch_attachment_urls_for_messages(conn, "direct", message_ids)
        conn.execute(f"DELETE FROM hidden_messages WHERE message_id IN ({placeholders})", message_ids)
        delete_message_attachments(conn, "direct", message_ids)
        conn.execute(f"DELETE FROM messages WHERE chat_id = %s AND id IN ({placeholders})", [chat_id, *message_ids])
        conn.commit()
        conn.close()
        remove_voice_files(voice_urls)
        remove_photo_files(image_urls)
        remove_message_image_files(attachment_urls)

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
    try:
        require_permission_to_create_groups(getattr(g, "current_user", None) or {})
    except PermissionError as error:
        return jsonify({"message": str(error)}), 403

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


@app.post("/server-invite/<code>/join")
def join_server_by_invite(code):
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401

    conn = get_db()
    try:
        invite = get_server_invite_by_code(conn, code)
        if not invite:
            return jsonify({"message": "Ссылка приглашения недействительна"}), 404

        server_id = int(invite["server_id"])
        viewer_member = get_server_member(conn, server_id, user_id)
        server_summary = get_server_summary_for_invites(conn, server_id)
        serialized_invite = serialize_server_invite_row(invite, server_summary, viewer_member)
        if not serialized_invite["is_active"]:
            return jsonify({"message": "Приглашение больше недоступно", "invite": serialized_invite}), 400

        if viewer_member:
            redirect_url = (
                f"/server/{server_id}/channel/{serialized_invite['default_channel_id']}"
                if serialized_invite["default_channel_id"]
                else f"/server/{server_id}"
            )
            return jsonify({
                "ok": True,
                "already_member": True,
                "server_id": server_id,
                "redirect_url": redirect_url,
                "invite": serialized_invite,
            })

        ban_row = conn.execute("""
            SELECT 1
            FROM server_banned_users
            WHERE server_id = %s AND user_id = %s
            LIMIT 1
        """, (server_id, user_id)).fetchone()
        if ban_row:
            return jsonify({"message": "Вы заблокированы на этом сервере"}), 403

        if bool(invite["only_friends"]):
            is_friend = conn.execute("""
                SELECT 1
                FROM contacts
                WHERE (owner_user_id = %s AND contact_user_id = %s)
                   OR (owner_user_id = %s AND contact_user_id = %s)
                LIMIT 1
            """, (user_id, invite["created_by"], invite["created_by"], user_id)).fetchone()
            if not is_friend:
                return jsonify({"message": "Это приглашение доступно только друзьям"}), 403

        if bool(invite["require_approval"]):
            return jsonify({
                "ok": True,
                "pending_approval": True,
                "server_id": server_id,
                "invite": serialized_invite,
            }), 202

        conn.execute("""
            INSERT INTO server_members (server_id, user_id, is_admin, role)
            VALUES (%s, %s, 0, 'member')
        """, (server_id, user_id))
        channel_rows = conn.execute("""
            SELECT group_id
            FROM server_channels
            WHERE server_id = %s
        """, (server_id,)).fetchall()
        if channel_rows:
            conn.executemany("""
                INSERT IGNORE INTO group_members (group_id, user_id, is_admin)
                VALUES (%s, %s, 0)
            """, [(int(row["group_id"]), user_id) for row in channel_rows])
            for row in channel_rows:
                initialize_group_read_state(conn, int(row["group_id"]), user_id)
        conn.execute("""
            UPDATE server_invites
            SET uses_count = uses_count + 1,
                revoked = CASE WHEN one_time = 1 THEN 1 ELSE revoked END
            WHERE id = %s
        """, (invite["id"],))
        conn.commit()

        joined_summary = get_server_summary_for_invites(conn, server_id)
        joined_invite = get_server_invite_by_code(conn, code)
        redirect_url = (
            f"/server/{server_id}/channel/{joined_summary['default_channel_id']}"
            if joined_summary and joined_summary.get("default_channel_id")
            else f"/server/{server_id}"
        )
        emit_chat_list_updated_for_users([user_id], "server", server_id)
        emit_server_structure_updated(conn, server_id)
        return jsonify({
            "ok": True,
            "server_id": server_id,
            "redirect_url": redirect_url,
            "invite": serialize_server_invite_row(joined_invite, joined_summary, get_server_member(conn, server_id, user_id)),
        }), 201
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


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

    if get_server_channel_record(conn, group_id):
        conn.close()
        return jsonify({"message": "Канал сервера нельзя удалять как обычную группу"}), 400

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
    voice_urls = [
        row["audio_url"]
        for row in conn.execute("""
            SELECT audio_url
            FROM group_messages
            WHERE group_id = %s
        """, (group_id,)).fetchall()
    ]
    image_urls = [
        row["image_url"]
        for row in conn.execute("""
            SELECT image_url
            FROM group_messages
            WHERE group_id = %s
        """, (group_id,)).fetchall()
    ]
    attachment_urls = fetch_attachment_urls_for_messages(conn, "group", group_message_ids)

    if group_message_ids:
        placeholders = ",".join("%s" for _ in group_message_ids)
        conn.execute(f"""
            DELETE FROM hidden_group_messages
            WHERE group_message_id IN ({placeholders})
        """, group_message_ids)

    conn.execute("DELETE FROM group_messages WHERE group_id = %s", (group_id,))
    delete_message_attachments(conn, "group", group_message_ids)
    conn.execute("DELETE FROM group_read_states WHERE group_id = %s", (group_id,))
    conn.execute("DELETE FROM group_members WHERE group_id = %s", (group_id,))
    conn.execute("DELETE FROM group_invites WHERE group_id = %s", (group_id,))
    conn.execute("DELETE FROM groups WHERE id = %s", (group_id,))
    conn.commit()
    conn.close()
    remove_voice_files(voice_urls)
    remove_photo_files(image_urls)
    remove_message_image_files(attachment_urls)

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
    try:
        require_permission_to_send_messages(getattr(g, "current_user", None) or {})
    except PermissionError as error:
        return jsonify({"message": str(error)}), 403

    conn = get_db()
    member = can_access_group(conn, user_id, group_id)

    if not member:
        conn.close()
        return jsonify({"message": "Группа не найдена"}), 404

    payload = parse_message_create_payload()
    text = payload["text"]
    raw_type = str(payload.get("type") or "").strip().lower()
    raw_layout = str(payload.get("layout") or "").strip().lower()
    message_type = "wide" if raw_type in {"wide", "special"} or raw_layout == "wide" else "text"
    badge = str(payload.get("badge") or "").strip()[:64] or None
    reply_to_id = payload["reply_to_id"]
    images = payload["images"]
    files = payload.get("files") or []

    if not text and not images and not files:
        conn.close()
        return jsonify({"message": "Текст сообщения или файл обязательны"}), 400
    if message_type == "wide" and (images or files):
        conn.close()
        return jsonify({"message": "Широкие сообщения пока не поддерживают вложения"}), 400
    if images or files:
        try:
            current_user = getattr(g, "current_user", None) or {}
            ensure_global_file_uploads_enabled()
            require_permission_to_upload_files(current_user)
        except PermissionError as error:
            conn.close()
            return jsonify({"message": str(error)}), 403

    reply_to_message = None
    if reply_to_id is not None:
        reply_to_message = get_group_reply_target(conn, group_id, reply_to_id)
        if not reply_to_message:
            conn.close()
            return jsonify({"message": "Сообщение для ответа не найдено"}), 404
    attachments = []
    if images or files:
        try:
            attachments = [save_message_image_upload(image) for image in images]
            attachments.extend(save_message_attachment_upload(file) for file in files)
        except ValueError as error:
            conn.close()
            return jsonify({"message": str(error)}), 400
        except RuntimeError as error:
            conn.close()
            return jsonify({"message": str(error)}), 500
    try:
        ensure_server_channel_message_allowed(
            conn,
            group_id,
            user_id,
            text=text,
            includes_files=bool(images or files),
            editing=False,
            message_type=message_type
        )
    except PermissionError as error:
        conn.close()
        return jsonify({"message": str(error)}), 403
    if message_type == "text" and text and not images and not files and reply_to_id is None and is_duplicate_recent_group_invite(conn, group_id, user_id, text):
        conn.close()
        return jsonify({"message": "Эта ссылка уже была отправлена последним сообщением"}), 409

    message = create_group_message_record(
        conn,
        group_id,
        user_id,
        text,
        message_type,
        reply_to_message=reply_to_message,
        badge=badge or ("Объявление" if message_type == "wide" else None)
    )
    if attachments:
        insert_message_attachments(conn, "group", message["id"], attachments)
        message = get_group_message_for_group(conn, group_id, message["id"])
    conn.commit()
    conn.close()

    emit_group_new_message(message, group_id)

    return jsonify(serialize_group_message(message)), 201


@app.post("/groups/<int:group_id>/voice")
def create_group_voice_message(group_id):
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401
    try:
        current_user = getattr(g, "current_user", None) or {}
        ensure_global_file_uploads_enabled()
        require_permission_to_send_messages(current_user)
        require_permission_to_upload_files(current_user)
    except PermissionError as error:
        return jsonify({"message": str(error)}), 403

    conn = get_db()
    member = can_access_group(conn, user_id, group_id)
    if not member:
        conn.close()
        return jsonify({"message": "Группа не найдена"}), 404

    try:
        audio = save_voice_upload(request.files.get("voice"))
    except ValueError as error:
        conn.close()
        return jsonify({"message": str(error)}), 400
    except RuntimeError as error:
        conn.close()
        return jsonify({"message": str(error)}), 500

    duration_ms = parse_duration_ms(request.form.get("duration_ms"))
    reply_to_id = request.form.get("reply_to_id")
    reply_to_message = None
    if reply_to_id is not None and str(reply_to_id).strip():
        reply_to_message = get_group_reply_target(conn, group_id, reply_to_id)
        if not reply_to_message:
            conn.close()
            return jsonify({"message": "Сообщение для ответа не найдено"}), 404
    try:
        ensure_server_channel_message_allowed(
            conn,
            group_id,
            user_id,
            text="",
            includes_files=True,
            editing=False
        )
    except PermissionError as error:
        conn.close()
        return jsonify({"message": str(error)}), 403

    message = create_group_message_record(
        conn,
        group_id,
        user_id,
        "",
        "voice",
        audio={
            "url": audio["url"],
            "mime_type": audio["mime_type"],
            "duration_ms": duration_ms
        },
        reply_to_message=reply_to_message
    )
    conn.commit()
    conn.close()

    emit_group_new_message(message, group_id)
    return jsonify(serialize_group_message(message)), 201


@app.post("/groups/<int:group_id>/photo")
def create_group_photo_message(group_id):
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401
    try:
        current_user = getattr(g, "current_user", None) or {}
        ensure_global_file_uploads_enabled()
        require_permission_to_send_messages(current_user)
        require_permission_to_upload_files(current_user)
    except PermissionError as error:
        return jsonify({"message": str(error)}), 403

    conn = get_db()
    member = can_access_group(conn, user_id, group_id)
    if not member:
        conn.close()
        return jsonify({"message": "Группа не найдена"}), 404

    try:
        ensure_photo_messages_enabled()
        image = save_photo_upload(request.files.get("photo"))
    except PermissionError as error:
        conn.close()
        return jsonify({"message": str(error)}), 403
    except ValueError as error:
        conn.close()
        return jsonify({"message": str(error)}), 400

    reply_to_id = request.form.get("reply_to_id")
    reply_to_message = None
    if reply_to_id is not None and str(reply_to_id).strip():
        reply_to_message = get_group_reply_target(conn, group_id, reply_to_id)
        if not reply_to_message:
            conn.close()
            return jsonify({"message": "Сообщение для ответа не найдено"}), 404
    try:
        ensure_server_channel_message_allowed(
            conn,
            group_id,
            user_id,
            text="",
            includes_files=True,
            editing=False
        )
    except PermissionError as error:
        conn.close()
        return jsonify({"message": str(error)}), 403

    message = create_group_message_record(
        conn,
        group_id,
        user_id,
        "",
        "photo",
        image=image,
        reply_to_message=reply_to_message
    )
    conn.commit()
    conn.close()

    emit_group_new_message(message, group_id)
    return jsonify(serialize_group_message(message)), 201


@app.post("/groups/<int:group_id>/sticker")
def create_group_sticker_message(group_id):
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401
    try:
        ensure_global_stickers_enabled()
        require_permission_to_send_messages(getattr(g, "current_user", None) or {})
    except PermissionError as error:
        return jsonify({"message": str(error)}), 403

    data = request.json or {}
    try:
        sticker_id = int(data.get("sticker_id"))
    except (TypeError, ValueError):
        return jsonify({"message": "Некорректный sticker_id"}), 400

    conn = get_db()
    member = can_access_group(conn, user_id, group_id)
    if not member:
        conn.close()
        return jsonify({"message": "Группа не найдена"}), 404

    sticker = fetch_sticker_for_user(conn, user_id, sticker_id)
    if not sticker:
        conn.close()
        return jsonify({"message": "Стикер недоступен"}), 404

    reply_to_id = data.get("reply_to_id")
    reply_to_message = None
    if reply_to_id is not None:
        reply_to_message = get_group_reply_target(conn, group_id, reply_to_id)
        if not reply_to_message:
            conn.close()
            return jsonify({"message": "Сообщение для ответа не найдено"}), 404
    try:
        ensure_server_channel_message_allowed(
            conn,
            group_id,
            user_id,
            text="",
            includes_files=False,
            editing=False
        )
    except PermissionError as error:
        conn.close()
        return jsonify({"message": str(error)}), 403

    message = create_group_message_record(
        conn,
        group_id,
        user_id,
        "",
        "sticker",
        sticker={
            "id": int(sticker["id"]),
            "url": sticker["file_path"]
        },
        reply_to_message=reply_to_message
    )
    conn.commit()
    conn.close()

    emit_group_new_message(message, group_id)
    return jsonify(serialize_group_message(message)), 201


@app.post("/groups/<int:group_id>/messages/<int:message_id>/forward")
def forward_group_message(group_id, message_id):
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401
    try:
        require_permission_to_send_messages(getattr(g, "current_user", None) or {})
    except PermissionError as error:
        return jsonify({"message": str(error)}), 403

    data = request.json or {}
    target_chat_type = "group" if str(data.get("target_chat_type", "direct")).strip().lower() == "group" else "direct"
    try:
        target_chat_id = int(data.get("target_chat_id"))
    except (TypeError, ValueError):
        return jsonify({"message": "Некорректный целевой чат"}), 400

    conn = get_db()
    if not can_access_group(conn, user_id, group_id):
        conn.close()
        return jsonify({"message": "Группа не найдена"}), 404

    message = get_group_message_for_group(conn, group_id, message_id)
    if not message:
        conn.close()
        return jsonify({"message": "Сообщение не найдено"}), 404

    try:
        forwarded_message = forward_message_to_target(conn, user_id, target_chat_type, target_chat_id, message)
    except ValueError as error:
        conn.close()
        return jsonify({"message": str(error)}), 400
    except PermissionError as error:
        conn.close()
        return jsonify({"message": str(error)}), 403
    except LookupError as error:
        conn.close()
        return jsonify({"message": str(error)}), 404

    conn.close()
    return jsonify(forwarded_message), 201


@app.post("/groups/<int:group_id>/messages/forward-dialog")
def forward_group_messages_as_dialog(group_id):
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401
    try:
        require_permission_to_send_messages(getattr(g, "current_user", None) or {})
    except PermissionError as error:
        return jsonify({"message": str(error)}), 403

    message_ids, error = parse_message_ids_payload()
    if error:
        return jsonify({"message": error}), 400
    if len(message_ids) < 2:
        return jsonify({"message": "Нужно выбрать минимум два сообщения"}), 400

    data = request.json or {}
    target_chat_type = "group" if str(data.get("target_chat_type", "direct")).strip().lower() == "group" else "direct"
    try:
        target_chat_id = int(data.get("target_chat_id"))
    except (TypeError, ValueError):
        return jsonify({"message": "Некорректный целевой чат"}), 400

    conn = get_db()
    if not can_access_group(conn, user_id, group_id):
        conn.close()
        return jsonify({"message": "Группа не найдена"}), 404

    source_messages = fetch_group_messages_by_ids(conn, group_id, message_ids)
    if len(source_messages) != len(message_ids):
        conn.close()
        return jsonify({"message": "Некоторые сообщения не найдены"}), 404

    try:
        forwarded_message = forward_dialog_to_target(
            conn,
            user_id,
            target_chat_type,
            target_chat_id,
            build_forwarded_dialog_payload(source_messages, user_id)
        )
    except ValueError as error:
        conn.close()
        return jsonify({"message": str(error)}), 400
    except PermissionError as error:
        conn.close()
        return jsonify({"message": str(error)}), 403
    except LookupError as error:
        conn.close()
        return jsonify({"message": str(error)}), 404

    conn.close()
    return jsonify(forwarded_message), 201


@app.patch("/groups/<int:group_id>/messages/<int:message_id>")
def update_group_message(group_id, message_id):
    user_id = current_user_id()
    if not user_id:
        return jsonify({"message": "Не авторизован"}), 401
    try:
        require_permission_to_send_messages(getattr(g, "current_user", None) or {})
    except PermissionError as error:
        return jsonify({"message": str(error)}), 403

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

    if (message["message_type"] or "text") not in {"text", "wide", "special"}:
        conn.close()
        return jsonify({"message": "Редактировать можно только текстовые и суперсообщения"}), 403

    if message["sender_id"] != user_id:
        conn.close()
        return jsonify({"message": "Можно редактировать только свои сообщения"}), 403
    try:
        ensure_server_channel_message_allowed(
            conn,
            group_id,
            user_id,
            text=text,
            includes_files=False,
            editing=True
        )
    except PermissionError as error:
        conn.close()
        return jsonify({"message": str(error)}), 403

    preview = extract_message_preview(text)
    conn.execute("""
        UPDATE group_messages
        SET
            text = %s,
            preview_url = %s,
            preview_title = %s,
            preview_description = %s,
            preview_site_name = %s,
            audio_url = NULL,
            audio_mime_type = NULL,
            audio_duration_ms = NULL,
            edited_at = CURRENT_TIMESTAMP
        WHERE id = %s AND group_id = %s
    """, (
        text,
        preview["url"] if preview else None,
        preview["title"][:255] if preview else None,
        preview["description"][:500] if preview else None,
        preview["site_name"][:255] if preview else None,
        message_id,
        group_id
    ))
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

    if scope == "all" and (message["message_type"] or "text") == "system":
        conn.close()
        return jsonify({"message": "Системные сообщения нельзя удалять у всех"}), 403

    if scope == "all":
        if message["sender_id"] != user_id:
            conn.close()
            return jsonify({"message": "Удалить у всех можно только свои сообщения"}), 403

        voice_url = message.get("audio_url")
        image_url = message.get("image_url")
        attachment_urls = fetch_attachment_urls_for_messages(conn, "group", [message_id])
        conn.execute("DELETE FROM hidden_group_messages WHERE group_message_id = %s", (message_id,))
        delete_message_attachments(conn, "group", [message_id])
        conn.execute("DELETE FROM group_messages WHERE id = %s AND group_id = %s", (message_id, group_id))
        conn.commit()
        conn.close()
        remove_voice_files([voice_url])
        remove_photo_files([image_url])
        remove_message_image_files(attachment_urls)

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
        SELECT id, sender_id, message_type, audio_url, image_url
        FROM group_messages
        WHERE group_id = %s AND id IN ({placeholders})
    """, [group_id, *message_ids]).fetchall()

    found_ids = {row["id"] for row in message_rows}
    missing_ids = [message_id for message_id in message_ids if message_id not in found_ids]
    if missing_ids:
        conn.close()
        return jsonify({"message": "Некоторые сообщения не найдены"}), 404

    if scope == "all":
        system_ids = [row["id"] for row in message_rows if (row["message_type"] or "text") == "system"]
        if system_ids:
            conn.close()
            return jsonify({"message": "Системные сообщения нельзя удалять у всех"}), 403

        foreign_ids = [row["id"] for row in message_rows if row["sender_id"] != user_id]
        if foreign_ids:
            conn.close()
            return jsonify({"message": "Удалить у всех можно только свои сообщения"}), 403

        voice_urls = [row["audio_url"] for row in message_rows]
        image_urls = [row["image_url"] for row in message_rows]
        attachment_urls = fetch_attachment_urls_for_messages(conn, "group", message_ids)
        conn.execute(f"DELETE FROM hidden_group_messages WHERE group_message_id IN ({placeholders})", message_ids)
        delete_message_attachments(conn, "group", message_ids)
        conn.execute(f"DELETE FROM group_messages WHERE group_id = %s AND id IN ({placeholders})", [group_id, *message_ids])
        conn.commit()
        conn.close()
        remove_voice_files(voice_urls)
        remove_photo_files(image_urls)
        remove_message_image_files(attachment_urls)

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
    bootstrap_system_account()
    socketio.run(app, host="0.0.0.0", port=8000, debug=True)
