from __future__ import annotations

from pathlib import Path
import os
import secrets
from threading import Lock

import mysql.connector
from mysql.connector import errorcode
from mysql.connector.pooling import MySQLConnectionPool
from dotenv import load_dotenv

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent
INIT_SQL_PATH = BASE_DIR / "init_mariadb.sql"

DB_HOST = os.getenv("DB_HOST", "127.0.0.1")
DB_USER = os.getenv("DB_USER", "root")
DB_PASSWORD = os.getenv("DB_PASSWORD", "")
DB_NAME = os.getenv("DB_NAME", "messenger")
DB_POOL_NAME = "messenger_pool"
DB_POOL_SIZE = int(os.getenv("DB_POOL_SIZE", "8"))

_pool_lock = Lock()
_db_pool: MySQLConnectionPool | None = None

TRANSIENT_ERROR_CODES = {
    errorcode.CR_SERVER_GONE_ERROR,
    errorcode.CR_SERVER_LOST,
    errorcode.CR_CONN_HOST_ERROR,
    errorcode.CR_CONNECTION_ERROR,
}


def _db_config(include_database=True):
    config = {
        "host": DB_HOST,
        "user": DB_USER,
        "password": DB_PASSWORD,
        "charset": "utf8mb4",
        "use_unicode": True,
        "autocommit": False,
    }
    if include_database:
        config["database"] = DB_NAME
    return config


def _ensure_database_exists():
    conn = mysql.connector.connect(**_db_config(include_database=False))
    try:
        cursor = conn.cursor()
        cursor.execute(
            f"CREATE DATABASE IF NOT EXISTS `{DB_NAME}` "
            "CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
        )
        conn.commit()
        cursor.close()
    finally:
        conn.close()


def _build_pool():
    global _db_pool
    if _db_pool is not None:
        return _db_pool

    with _pool_lock:
        if _db_pool is None:
            _ensure_database_exists()
            _db_pool = MySQLConnectionPool(
                pool_name=DB_POOL_NAME,
                pool_size=DB_POOL_SIZE,
                pool_reset_session=True,
                **_db_config(include_database=True),
            )
    return _db_pool


def _normalize_query(query: str) -> str:
    statement = query.replace("?", "%s")
    normalized = " ".join(statement.strip().split())

    if normalized.upper().startswith("INSERT OR IGNORE INTO"):
        return _rewrite_insert_or_ignore(statement)

    if normalized.upper().startswith("INSERT OR REPLACE INTO"):
        return _rewrite_insert_or_replace(statement)

    return statement


def _rewrite_insert_or_ignore(query: str) -> str:
    prefix, remainder = query.split("INTO", 1)
    table_and_columns, values_part = remainder.split("VALUES", 1)
    table_name = table_and_columns.split("(", 1)[0].strip()
    column_section = table_and_columns.split("(", 1)[1].rsplit(")", 1)[0]
    first_column = column_section.split(",", 1)[0].strip()
    return (
        f"INSERT INTO {table_name} ({column_section}) VALUES {values_part.strip()} "
        f"ON DUPLICATE KEY UPDATE {first_column} = {first_column}"
    )


def _rewrite_insert_or_replace(query: str) -> str:
    _, remainder = query.split("INTO", 1)
    table_and_columns, values_part = remainder.split("VALUES", 1)
    table_name = table_and_columns.split("(", 1)[0].strip()
    column_section = table_and_columns.split("(", 1)[1].rsplit(")", 1)[0]
    columns = [column.strip() for column in column_section.split(",") if column.strip()]
    update_clause = ", ".join(f"{column} = VALUES({column})" for column in columns)
    return (
        f"INSERT INTO {table_name} ({column_section}) VALUES {values_part.strip()} "
        f"ON DUPLICATE KEY UPDATE {update_clause}"
    )


def _normalize_params(params):
    if params is None:
        return ()
    if isinstance(params, tuple):
        return params
    if isinstance(params, list):
        return tuple(params)
    return params


def _split_sql_script(script: str):
    statements = []
    current = []
    in_single = False
    in_double = False

    for char in script:
        if char == "'" and not in_double:
            in_single = not in_single
        elif char == '"' and not in_single:
            in_double = not in_double

        if char == ";" and not in_single and not in_double:
            statement = "".join(current).strip()
            if statement:
                statements.append(statement)
            current = []
            continue

        current.append(char)

    tail = "".join(current).strip()
    if tail:
        statements.append(tail)
    return statements


class MariaCursor:
    def __init__(self, connection: "MariaConnection", dictionary=True):
        self._connection = connection
        self._dictionary = dictionary
        self._cursor = None
        self._open_cursor()

    def _open_cursor(self):
        self.close()
        self._connection._ensure_alive()
        self._cursor = self._connection._raw.cursor(dictionary=self._dictionary)

    def _run(self, operation, query, params=None):
        statement = _normalize_query(query)
        values = _normalize_params(params)
        last_error = None

        for attempt in range(2):
            try:
                if self._cursor is None:
                    self._open_cursor()
                operation(statement, values)
                return self
            except mysql.connector.Error as exc:
                last_error = exc
                if attempt == 0 and self._connection._should_retry(exc):
                    self._connection._reconnect()
                    self._open_cursor()
                    continue
                raise

        raise last_error

    def execute(self, query, params=None):
        return self._run(self._cursor.execute, query, params)

    def executemany(self, query, seq_params):
        statement = _normalize_query(query)
        values = [tuple(item) if isinstance(item, list) else item for item in seq_params]
        last_error = None

        for attempt in range(2):
            try:
                if self._cursor is None:
                    self._open_cursor()
                self._cursor.executemany(statement, values)
                return self
            except mysql.connector.Error as exc:
                last_error = exc
                if attempt == 0 and self._connection._should_retry(exc):
                    self._connection._reconnect()
                    self._open_cursor()
                    continue
                raise

        raise last_error

    @property
    def lastrowid(self):
        return getattr(self._cursor, "lastrowid", None)

    @property
    def rowcount(self):
        return getattr(self._cursor, "rowcount", -1)

    def fetchone(self):
        return self._cursor.fetchone() if self._cursor else None

    def fetchall(self):
        return self._cursor.fetchall() if self._cursor else []

    def close(self):
        if self._cursor is not None:
            self._cursor.close()
            self._cursor = None


class MariaConnection:
    def __init__(self, raw_connection):
        self._raw = raw_connection
        self._configure_session()

    def _configure_session(self):
        cursor = self._raw.cursor()
        try:
            cursor.execute("SET time_zone = '+00:00'")
        finally:
            cursor.close()

    def _ensure_alive(self):
        self._raw.ping(reconnect=True, attempts=3, delay=1)

    def _reconnect(self):
        try:
            self._raw.reconnect(attempts=3, delay=1)
        except AttributeError:
            self.close()
            self._raw = _build_pool().get_connection()
        self._configure_session()

    def _should_retry(self, exc):
        return getattr(exc, "errno", None) in TRANSIENT_ERROR_CODES

    def cursor(self, dictionary=True):
        return MariaCursor(self, dictionary=dictionary)

    def execute(self, query, params=None):
        cursor = self.cursor(dictionary=True)
        cursor.execute(query, params)
        return cursor

    def executemany(self, query, seq_params):
        cursor = self.cursor(dictionary=True)
        cursor.executemany(query, seq_params)
        return cursor

    def commit(self):
        self._ensure_alive()
        self._raw.commit()

    def rollback(self):
        self._ensure_alive()
        self._raw.rollback()

    def close(self):
        if self._raw is not None:
            self._raw.close()
            self._raw = None


def get_db():
    raw_connection = _build_pool().get_connection()
    return MariaConnection(raw_connection)


def _ensure_group_invites(conn):
    groups_without_invites = conn.execute("""
        SELECT id, owner_id
        FROM groups
        WHERE id NOT IN (
            SELECT group_id
            FROM group_invites
            WHERE is_active = 1
        )
    """).fetchall()

    if not groups_without_invites:
        return

    cursor = conn.cursor()
    for group in groups_without_invites:
        token = secrets.token_urlsafe(18)
        while conn.execute("SELECT 1 FROM group_invites WHERE token = %s", (token,)).fetchone():
            token = secrets.token_urlsafe(18)
        cursor.execute("""
            INSERT INTO group_invites (group_id, token, is_active, created_by)
            VALUES (%s, %s, 1, %s)
        """, (group["id"], token, group["owner_id"]))


def _ensure_server_tables(conn):
    cursor = conn.cursor(dictionary=False)
    try:
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS servers (
                id INT AUTO_INCREMENT PRIMARY KEY,
                title VARCHAR(255) NOT NULL,
                description TEXT NULL,
                owner_id INT NOT NULL,
                invite_code VARCHAR(255) NULL,
                allow_member_invites TINYINT(1) NOT NULL DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        """)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS server_members (
                id INT AUTO_INCREMENT PRIMARY KEY,
                server_id INT NOT NULL,
                user_id INT NOT NULL,
                is_admin TINYINT(1) NOT NULL DEFAULT 0,
                role VARCHAR(32) NOT NULL DEFAULT 'member',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uniq_server_member (server_id, user_id),
                INDEX idx_server_members_server_id (server_id),
                INDEX idx_server_members_user_id (user_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        """)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS server_banned_users (
                id INT AUTO_INCREMENT PRIMARY KEY,
                server_id INT NOT NULL,
                user_id INT NOT NULL,
                created_by INT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uniq_server_banned_user (server_id, user_id),
                INDEX idx_server_banned_users_server_id (server_id),
                INDEX idx_server_banned_users_user_id (user_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        """)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS server_audit_log (
                id INT AUTO_INCREMENT PRIMARY KEY,
                server_id INT NOT NULL,
                actor_user_id INT NOT NULL,
                target_user_id INT NULL,
                action VARCHAR(120) NOT NULL,
                details_json LONGTEXT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_server_audit_server_created (server_id, created_at),
                INDEX idx_server_audit_actor (actor_user_id),
                INDEX idx_server_audit_target (target_user_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        """)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS server_categories (
                id INT AUTO_INCREMENT PRIMARY KEY,
                server_id INT NOT NULL,
                title VARCHAR(255) NOT NULL,
                position INT NOT NULL DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_server_categories_server_id (server_id),
                INDEX idx_server_categories_server_position (server_id, position)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        """)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS server_channels (
                id INT AUTO_INCREMENT PRIMARY KEY,
                server_id INT NOT NULL,
                category_id INT NOT NULL,
                group_id INT NOT NULL,
                position INT NOT NULL DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uniq_server_channel_group (group_id),
                INDEX idx_server_channels_server_id (server_id),
                INDEX idx_server_channels_category_id (category_id),
                INDEX idx_server_channels_server_category_position (server_id, category_id, position)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        """)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS server_roles (
                id INT AUTO_INCREMENT PRIMARY KEY,
                server_id INT NOT NULL,
                name VARCHAR(80) NOT NULL,
                color VARCHAR(32) NOT NULL DEFAULT '#94a3b8',
                position INT NOT NULL DEFAULT 0,
                is_system TINYINT(1) NOT NULL DEFAULT 0,
                permissions_json LONGTEXT NULL,
                created_by INT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uniq_server_role_name (server_id, name),
                INDEX idx_server_roles_server_id (server_id),
                INDEX idx_server_roles_server_position (server_id, position)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        """)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS server_invites (
                id INT AUTO_INCREMENT PRIMARY KEY,
                server_id INT NOT NULL,
                code VARCHAR(64) NOT NULL,
                created_by INT NOT NULL,
                expires_at DATETIME NULL,
                max_uses INT NULL,
                uses_count INT NOT NULL DEFAULT 0,
                only_friends TINYINT(1) NOT NULL DEFAULT 0,
                one_time TINYINT(1) NOT NULL DEFAULT 0,
                require_approval TINYINT(1) NOT NULL DEFAULT 0,
                revoked TINYINT(1) NOT NULL DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uniq_server_invite_code (code),
                INDEX idx_server_invites_server_id (server_id),
                INDEX idx_server_invites_created_by (created_by)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        """)

        cursor.execute("""
            SELECT TABLE_NAME, COLUMN_NAME
            FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = %s
              AND TABLE_NAME IN ('server_audit_log', 'server_banned_users', 'server_categories', 'server_channels', 'server_invites', 'server_members', 'server_roles', 'servers')
        """, (DB_NAME,))
        existing = {}
        for table_name, column_name in cursor.fetchall() or []:
            existing.setdefault(table_name, set()).add(column_name)

        if "invite_code" not in existing.get("servers", set()):
            cursor.execute("""
                ALTER TABLE servers
                ADD COLUMN invite_code VARCHAR(255) NULL AFTER owner_id
            """)
        if "allow_member_invites" not in existing.get("servers", set()):
            cursor.execute("""
                ALTER TABLE servers
                ADD COLUMN allow_member_invites TINYINT(1) NOT NULL DEFAULT 0 AFTER invite_code
            """)

        if "is_admin" not in existing.get("server_members", set()):
            cursor.execute("""
                ALTER TABLE server_members
                ADD COLUMN is_admin TINYINT(1) NOT NULL DEFAULT 0 AFTER user_id
            """)
        if "role" not in existing.get("server_members", set()):
            cursor.execute("""
                ALTER TABLE server_members
                ADD COLUMN role VARCHAR(32) NOT NULL DEFAULT 'member' AFTER is_admin
            """)
        cursor.execute("""
            UPDATE server_members
            SET
                is_admin = CASE
                    WHEN COALESCE(role, 'member') IN ('owner', 'admin') THEN 1
                    ELSE COALESCE(is_admin, 0)
                END,
                role = CASE
                    WHEN COALESCE(is_admin, 0) = 1 AND COALESCE(role, '') NOT IN ('owner', 'admin') THEN 'admin'
                    WHEN COALESCE(role, '') = '' THEN 'member'
                    ELSE role
                END
        """)

        if "color" not in existing.get("server_roles", set()):
            cursor.execute("""
                ALTER TABLE server_roles
                ADD COLUMN color VARCHAR(32) NOT NULL DEFAULT '#94a3b8' AFTER name
            """)
        if "position" not in existing.get("server_roles", set()):
            cursor.execute("""
                ALTER TABLE server_roles
                ADD COLUMN position INT NOT NULL DEFAULT 0 AFTER color
            """)
        if "is_system" not in existing.get("server_roles", set()):
            cursor.execute("""
                ALTER TABLE server_roles
                ADD COLUMN is_system TINYINT(1) NOT NULL DEFAULT 0 AFTER position
            """)
        if "permissions_json" not in existing.get("server_roles", set()):
            cursor.execute("""
                ALTER TABLE server_roles
                ADD COLUMN permissions_json LONGTEXT NULL AFTER is_system
            """)
        if "created_by" not in existing.get("server_roles", set()):
            cursor.execute("""
                ALTER TABLE server_roles
                ADD COLUMN created_by INT NULL AFTER permissions_json
            """)

        if "title" not in existing.get("server_categories", set()):
            cursor.execute("""
                ALTER TABLE server_categories
                ADD COLUMN title VARCHAR(255) NULL AFTER server_id
            """)
        if "name" not in existing.get("server_categories", set()):
            cursor.execute("""
                ALTER TABLE server_categories
                ADD COLUMN name VARCHAR(255) NULL AFTER title
            """)
        if "created_by" not in existing.get("server_categories", set()):
            cursor.execute("""
                ALTER TABLE server_categories
                ADD COLUMN created_by INT NULL AFTER position
            """)
        cursor.execute("""
            UPDATE server_categories
            SET
                title = COALESCE(NULLIF(title, ''), name),
                name = COALESCE(NULLIF(name, ''), title)
            WHERE title IS NULL OR title = '' OR name IS NULL OR name = ''
        """)

        if "title" not in existing.get("server_channels", set()):
            cursor.execute("""
                ALTER TABLE server_channels
                ADD COLUMN title VARCHAR(255) NULL AFTER group_id
            """)
        if "name" not in existing.get("server_channels", set()):
            cursor.execute("""
                ALTER TABLE server_channels
                ADD COLUMN name VARCHAR(255) NULL AFTER title
            """)
        if "slug" not in existing.get("server_channels", set()):
            cursor.execute("""
                ALTER TABLE server_channels
                ADD COLUMN slug VARCHAR(255) NULL AFTER name
            """)
        if "created_by" not in existing.get("server_channels", set()):
            cursor.execute("""
                ALTER TABLE server_channels
                ADD COLUMN created_by INT NULL AFTER position
            """)
        if "description" not in existing.get("server_channels", set()):
            cursor.execute("""
                ALTER TABLE server_channels
                ADD COLUMN description TEXT NULL AFTER slug
            """)
        if "channel_type" not in existing.get("server_channels", set()):
            cursor.execute("""
                ALTER TABLE server_channels
                ADD COLUMN channel_type VARCHAR(32) NOT NULL DEFAULT 'text' AFTER description
            """)
        if "access_json" not in existing.get("server_channels", set()):
            cursor.execute("""
                ALTER TABLE server_channels
                ADD COLUMN access_json LONGTEXT NULL AFTER channel_type
            """)
        if "role_permissions_json" not in existing.get("server_channels", set()):
            cursor.execute("""
                ALTER TABLE server_channels
                ADD COLUMN role_permissions_json LONGTEXT NULL AFTER access_json
            """)
        if "rules_json" not in existing.get("server_channels", set()):
            cursor.execute("""
                ALTER TABLE server_channels
                ADD COLUMN rules_json LONGTEXT NULL AFTER role_permissions_json
            """)
        if "restrictions_json" not in existing.get("server_channels", set()):
            cursor.execute("""
                ALTER TABLE server_channels
                ADD COLUMN restrictions_json LONGTEXT NULL AFTER rules_json
            """)
        if "legacy_room_id" not in existing.get("server_channels", set()):
            cursor.execute("""
                ALTER TABLE server_channels
                ADD COLUMN legacy_room_id INT NULL AFTER created_by
            """)
        cursor.execute("""
            UPDATE server_channels
            SET
                title = COALESCE(NULLIF(title, ''), name),
                name = COALESCE(NULLIF(name, ''), title),
                slug = COALESCE(NULLIF(slug, ''), title, name)
            WHERE title IS NULL OR title = '' OR name IS NULL OR name = '' OR slug IS NULL OR slug = ''
        """)
    finally:
        cursor.close()


def _ensure_contacts_alias_column(conn):
    cursor = conn.cursor(dictionary=False)
    try:
        cursor.execute("""
            SELECT 1
            FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = %s
              AND TABLE_NAME = 'contacts'
              AND COLUMN_NAME = 'alias'
            LIMIT 1
        """, (DB_NAME,))
        exists = cursor.fetchone()
        if not exists:
            cursor.execute("""
                ALTER TABLE contacts
                ADD COLUMN alias VARCHAR(255) NULL AFTER contact_user_id
            """)
    finally:
        cursor.close()


def _ensure_message_preview_columns(conn, table_name):
    expected_columns = {
        "message_type": "VARCHAR(32) NOT NULL DEFAULT 'text'",
        "badge": "VARCHAR(64) NULL",
        "reply_to_message_id": "INT NULL",
        "reply_preview_text": "TEXT NULL",
        "reply_preview_sender_name": "VARCHAR(255) NULL",
        "reply_preview_message_type": "VARCHAR(32) NULL",
        "forwarded_from_user_id": "INT NULL",
        "forwarded_from_sender_name": "VARCHAR(255) NULL",
        "forwarded_dialog_payload": "LONGTEXT NULL",
        "preview_url": "VARCHAR(1000) NULL",
        "preview_title": "VARCHAR(255) NULL",
        "preview_description": "VARCHAR(500) NULL",
        "preview_site_name": "VARCHAR(255) NULL",
        "audio_url": "VARCHAR(1000) NULL",
        "audio_mime_type": "VARCHAR(120) NULL",
        "audio_duration_ms": "INT NULL",
        "image_url": "VARCHAR(1000) NULL",
        "image_mime_type": "VARCHAR(120) NULL",
        "sticker_id": "INT NULL",
        "sticker_asset_path": "VARCHAR(1000) NULL",
    }
    cursor = conn.cursor(dictionary=False)
    try:
        cursor.execute("""
            SELECT COLUMN_NAME
            FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = %s
              AND TABLE_NAME = %s
        """, (DB_NAME, table_name))
        existing = {row[0] for row in cursor.fetchall() or []}
        for column_name, column_type in expected_columns.items():
            if column_name in existing:
                continue
            cursor.execute(f"""
                ALTER TABLE {table_name}
                ADD COLUMN {column_name} {column_type}
            """)
    finally:
        cursor.close()


def _ensure_message_attachments_table(conn):
    cursor = conn.cursor(dictionary=False)
    try:
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS message_attachments (
                id INT AUTO_INCREMENT PRIMARY KEY,
                message_scope VARCHAR(16) NOT NULL,
                message_id INT NOT NULL,
                file_url VARCHAR(1000) NOT NULL,
                file_name VARCHAR(255) NOT NULL,
                mime_type VARCHAR(120) NOT NULL,
                size INT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_message_attachments_scope_message (message_scope, message_id),
                INDEX idx_message_attachments_created (created_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        """)
    finally:
        cursor.close()


def _ensure_user_login_devices_table(conn):
    cursor = conn.cursor(dictionary=False)
    try:
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS user_login_devices (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT NOT NULL,
                device_key CHAR(64) NOT NULL,
                device_label VARCHAR(255) NOT NULL,
                first_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uniq_user_login_device (user_id, device_key),
                INDEX idx_user_login_devices_user_id (user_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        """)
    finally:
        cursor.close()


def _ensure_users_security_columns(conn):
    cursor = conn.cursor(dictionary=False)
    try:
        cursor.execute("""
            SELECT COLUMN_NAME
            FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = %s
              AND TABLE_NAME = 'users'
        """, (DB_NAME,))
        existing = {row[0] for row in cursor.fetchall() or []}
        added_email_verified = False
        if "email_verified" not in existing:
            cursor.execute("""
                ALTER TABLE users
                ADD COLUMN email_verified TINYINT(1) NOT NULL DEFAULT 0 AFTER email
            """)
            added_email_verified = True
        if "email_verification_code_hash" not in existing:
            cursor.execute("""
                ALTER TABLE users
                ADD COLUMN email_verification_code_hash VARCHAR(255) NULL AFTER email_verified
            """)
        if "email_verification_expires_at" not in existing:
            cursor.execute("""
                ALTER TABLE users
                ADD COLUMN email_verification_expires_at DATETIME NULL AFTER email_verification_code_hash
            """)
        if "pending_email" not in existing:
            cursor.execute("""
                ALTER TABLE users
                ADD COLUMN pending_email VARCHAR(255) NULL AFTER email_verification_expires_at
            """)
        if "email_change_code_hash" not in existing:
            cursor.execute("""
                ALTER TABLE users
                ADD COLUMN email_change_code_hash VARCHAR(255) NULL AFTER pending_email
            """)
        if "email_change_expires_at" not in existing:
            cursor.execute("""
                ALTER TABLE users
                ADD COLUMN email_change_expires_at DATETIME NULL AFTER email_change_code_hash
            """)
        if "password_change_code_hash" not in existing:
            cursor.execute("""
                ALTER TABLE users
                ADD COLUMN password_change_code_hash VARCHAR(255) NULL AFTER email_change_expires_at
            """)
        if "password_change_expires_at" not in existing:
            cursor.execute("""
                ALTER TABLE users
                ADD COLUMN password_change_expires_at DATETIME NULL AFTER password_change_code_hash
            """)
        if "role" not in existing:
            cursor.execute("""
                ALTER TABLE users
                ADD COLUMN role VARCHAR(32) NOT NULL DEFAULT 'user' AFTER password_hash
            """)
        if "date_of_birth" not in existing:
            cursor.execute("""
                ALTER TABLE users
                ADD COLUMN date_of_birth DATE NULL AFTER bio
            """)
        if "is_banned" not in existing:
            cursor.execute("""
                ALTER TABLE users
                ADD COLUMN is_banned TINYINT(1) NOT NULL DEFAULT 0 AFTER date_of_birth
            """)
        if "banned_reason" not in existing:
            cursor.execute("""
                ALTER TABLE users
                ADD COLUMN banned_reason TEXT NULL AFTER is_banned
            """)
        if "banned_until" not in existing:
            cursor.execute("""
                ALTER TABLE users
                ADD COLUMN banned_until DATETIME NULL AFTER banned_reason
            """)
        if "can_send_messages" not in existing:
            cursor.execute("""
                ALTER TABLE users
                ADD COLUMN can_send_messages TINYINT(1) NOT NULL DEFAULT 1 AFTER banned_until
            """)
        if "can_upload_files" not in existing:
            cursor.execute("""
                ALTER TABLE users
                ADD COLUMN can_upload_files TINYINT(1) NOT NULL DEFAULT 1 AFTER can_send_messages
            """)
        if "can_create_groups" not in existing:
            cursor.execute("""
                ALTER TABLE users
                ADD COLUMN can_create_groups TINYINT(1) NOT NULL DEFAULT 1 AFTER can_upload_files
            """)
        if "login_alerts_enabled" not in existing:
            cursor.execute("""
                ALTER TABLE users
                ADD COLUMN login_alerts_enabled TINYINT(1) NOT NULL DEFAULT 1 AFTER date_of_birth
            """)
        if added_email_verified:
            cursor.execute("""
                UPDATE users
                SET email_verified = 1
            """)
    finally:
        cursor.close()


def _ensure_user_relations_tables(conn):
    cursor = conn.cursor(dictionary=False)
    try:
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS user_muted_users (
                id INT AUTO_INCREMENT PRIMARY KEY,
                owner_user_id INT NOT NULL,
                muted_user_id INT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uniq_user_muted_pair (owner_user_id, muted_user_id),
                INDEX idx_user_muted_owner (owner_user_id),
                INDEX idx_user_muted_target (muted_user_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        """)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS user_blocked_users (
                id INT AUTO_INCREMENT PRIMARY KEY,
                owner_user_id INT NOT NULL,
                blocked_user_id INT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uniq_user_blocked_pair (owner_user_id, blocked_user_id),
                INDEX idx_user_blocked_owner (owner_user_id),
                INDEX idx_user_blocked_target (blocked_user_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        """)
    finally:
        cursor.close()


def _ensure_sticker_tables(conn):
    cursor = conn.cursor(dictionary=False)
    try:
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS sticker_packs (
                id INT AUTO_INCREMENT PRIMARY KEY,
                owner_user_id INT NULL,
                title VARCHAR(120) NOT NULL,
                description VARCHAR(255) NULL,
                cover_path VARCHAR(1000) NULL,
                visibility VARCHAR(16) NOT NULL DEFAULT 'private',
                is_default TINYINT(1) NOT NULL DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_sticker_packs_owner (owner_user_id),
                INDEX idx_sticker_packs_default (is_default),
                INDEX idx_sticker_packs_visibility (visibility)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        """)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS stickers (
                id INT AUTO_INCREMENT PRIMARY KEY,
                pack_id INT NOT NULL,
                title VARCHAR(120) NULL,
                file_path VARCHAR(1000) NOT NULL,
                mime_type VARCHAR(120) NOT NULL,
                position INT NOT NULL DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_stickers_pack (pack_id),
                INDEX idx_stickers_pack_position (pack_id, position)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        """)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS user_sticker_packs (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT NOT NULL,
                pack_id INT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uniq_user_sticker_pack (user_id, pack_id),
                INDEX idx_user_sticker_packs_user (user_id),
                INDEX idx_user_sticker_packs_pack (pack_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        """)
    finally:
        cursor.close()


def _ensure_admin_audit_table(conn):
    cursor = conn.cursor(dictionary=False)
    try:
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS admin_audit_log (
                id INT AUTO_INCREMENT PRIMARY KEY,
                actor_user_id INT NOT NULL,
                target_user_id INT NOT NULL,
                action VARCHAR(64) NOT NULL,
                reason TEXT NULL,
                details_json LONGTEXT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_admin_audit_actor (actor_user_id),
                INDEX idx_admin_audit_target (target_user_id),
                INDEX idx_admin_audit_created (created_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        """)
    finally:
        cursor.close()


def _ensure_runtime_settings_table(conn):
    cursor = conn.cursor(dictionary=False)
    try:
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS app_runtime_settings (
                setting_key VARCHAR(120) PRIMARY KEY,
                setting_value VARCHAR(4000) NULL,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        """)
    finally:
        cursor.close()


def init_db():
    if not INIT_SQL_PATH.exists():
        raise FileNotFoundError(f"MariaDB schema file not found: {INIT_SQL_PATH}")

    conn = get_db()
    try:
        cursor = conn.cursor(dictionary=False)
        script = INIT_SQL_PATH.read_text(encoding="utf-8")
        for statement in _split_sql_script(script):
            cursor.execute(statement)
        _ensure_contacts_alias_column(conn)
        _ensure_message_preview_columns(conn, "messages")
        _ensure_message_preview_columns(conn, "group_messages")
        _ensure_message_attachments_table(conn)
        _ensure_server_tables(conn)
        _ensure_user_login_devices_table(conn)
        _ensure_users_security_columns(conn)
        _ensure_user_relations_tables(conn)
        _ensure_sticker_tables(conn)
        _ensure_admin_audit_table(conn)
        _ensure_runtime_settings_table(conn)
        _ensure_group_invites(conn)
        conn.commit()
        cursor.close()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
