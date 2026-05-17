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
        "reply_to_message_id": "INT NULL",
        "reply_preview_text": "TEXT NULL",
        "reply_preview_sender_name": "VARCHAR(255) NULL",
        "reply_preview_message_type": "VARCHAR(32) NULL",
        "preview_url": "VARCHAR(1000) NULL",
        "preview_title": "VARCHAR(255) NULL",
        "preview_description": "VARCHAR(500) NULL",
        "preview_site_name": "VARCHAR(255) NULL",
        "audio_url": "VARCHAR(1000) NULL",
        "audio_mime_type": "VARCHAR(120) NULL",
        "audio_duration_ms": "INT NULL",
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
                ADD COLUMN {column_name} {column_type} NULL
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
        if "login_alerts_enabled" not in existing:
            cursor.execute("""
                ALTER TABLE users
                ADD COLUMN login_alerts_enabled TINYINT(1) NOT NULL DEFAULT 1 AFTER bio
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
        _ensure_user_login_devices_table(conn)
        _ensure_users_security_columns(conn)
        _ensure_group_invites(conn)
        conn.commit()
        cursor.close()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
