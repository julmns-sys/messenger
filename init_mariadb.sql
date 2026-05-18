CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    username VARCHAR(32) NOT NULL UNIQUE,
    email VARCHAR(255) NULL,
    password_hash VARCHAR(255) NOT NULL,
    bio TEXT NULL,
    login_alerts_enabled TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS auth_tokens (
    token VARCHAR(255) PRIMARY KEY,
    user_id INT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_auth_tokens_user_id (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_login_devices (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    device_key CHAR(64) NOT NULL,
    device_label VARCHAR(255) NOT NULL,
    first_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_user_login_device (user_id, device_key),
    INDEX idx_user_login_devices_user_id (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS chats (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user1_id INT NOT NULL,
    user2_id INT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_chat_users (user1_id, user2_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS contacts (
    id INT AUTO_INCREMENT PRIMARY KEY,
    owner_user_id INT NOT NULL,
    contact_user_id INT NOT NULL,
    alias VARCHAR(255) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_contact_pair (owner_user_id, contact_user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_muted_users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    owner_user_id INT NOT NULL,
    muted_user_id INT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_user_muted_pair (owner_user_id, muted_user_id),
    INDEX idx_user_muted_owner (owner_user_id),
    INDEX idx_user_muted_target (muted_user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_blocked_users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    owner_user_id INT NOT NULL,
    blocked_user_id INT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_user_blocked_pair (owner_user_id, blocked_user_id),
    INDEX idx_user_blocked_owner (owner_user_id),
    INDEX idx_user_blocked_target (blocked_user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS messages (
    id INT AUTO_INCREMENT PRIMARY KEY,
    chat_id INT NOT NULL,
    sender_id INT NOT NULL,
    text TEXT NOT NULL,
    message_type VARCHAR(32) NOT NULL DEFAULT 'text',
    reply_to_message_id INT NULL,
    reply_preview_text TEXT NULL,
    reply_preview_sender_name VARCHAR(255) NULL,
    reply_preview_message_type VARCHAR(32) NULL,
    forwarded_from_user_id INT NULL,
    forwarded_from_sender_name VARCHAR(255) NULL,
    forwarded_dialog_payload LONGTEXT NULL,
    preview_url VARCHAR(1000) NULL,
    preview_title VARCHAR(255) NULL,
    preview_description VARCHAR(500) NULL,
    preview_site_name VARCHAR(255) NULL,
    audio_url VARCHAR(1000) NULL,
    audio_mime_type VARCHAR(120) NULL,
    audio_duration_ms INT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    read_at TIMESTAMP NULL DEFAULT NULL,
    edited_at TIMESTAMP NULL DEFAULT NULL,
    INDEX idx_messages_chat_id (chat_id),
    INDEX idx_messages_chat_id_id (chat_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `groups` (
    id INT AUTO_INCREMENT PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    description TEXT NULL,
    owner_id INT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS group_members (
    id INT AUTO_INCREMENT PRIMARY KEY,
    group_id INT NOT NULL,
    user_id INT NOT NULL,
    is_admin TINYINT(1) NOT NULL DEFAULT 0,
    UNIQUE KEY uniq_group_member (group_id, user_id),
    INDEX idx_group_members_group_id (group_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS group_messages (
    id INT AUTO_INCREMENT PRIMARY KEY,
    group_id INT NOT NULL,
    sender_id INT NOT NULL,
    text TEXT NOT NULL,
    message_type VARCHAR(32) NOT NULL DEFAULT 'text',
    reply_to_message_id INT NULL,
    reply_preview_text TEXT NULL,
    reply_preview_sender_name VARCHAR(255) NULL,
    reply_preview_message_type VARCHAR(32) NULL,
    forwarded_from_user_id INT NULL,
    forwarded_from_sender_name VARCHAR(255) NULL,
    forwarded_dialog_payload LONGTEXT NULL,
    preview_url VARCHAR(1000) NULL,
    preview_title VARCHAR(255) NULL,
    preview_description VARCHAR(500) NULL,
    preview_site_name VARCHAR(255) NULL,
    audio_url VARCHAR(1000) NULL,
    audio_mime_type VARCHAR(120) NULL,
    audio_duration_ms INT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    edited_at TIMESTAMP NULL DEFAULT NULL,
    INDEX idx_group_messages_group_id (group_id),
    INDEX idx_group_messages_group_id_id (group_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS hidden_messages (
    id INT AUTO_INCREMENT PRIMARY KEY,
    message_id INT NOT NULL,
    user_id INT NOT NULL,
    UNIQUE KEY uniq_hidden_message (message_id, user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS hidden_direct_chats (
    id INT AUTO_INCREMENT PRIMARY KEY,
    chat_id INT NOT NULL,
    user_id INT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_hidden_direct_chat (chat_id, user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS hidden_group_messages (
    id INT AUTO_INCREMENT PRIMARY KEY,
    group_message_id INT NOT NULL,
    user_id INT NOT NULL,
    UNIQUE KEY uniq_hidden_group_message (group_message_id, user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS group_read_states (
    id INT AUTO_INCREMENT PRIMARY KEY,
    group_id INT NOT NULL,
    user_id INT NOT NULL,
    last_read_message_id INT NULL,
    last_read_at TIMESTAMP NULL DEFAULT NULL,
    UNIQUE KEY uniq_group_read_state (group_id, user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS group_invites (
    id INT AUTO_INCREMENT PRIMARY KEY,
    group_id INT NOT NULL,
    token VARCHAR(255) NOT NULL UNIQUE,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_by INT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_group_invites_group_active (group_id, is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
