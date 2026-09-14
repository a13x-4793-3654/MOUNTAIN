-- MOUNTAIN system PostgreSQL DDL (production draft)
-- 前提:
-- - PostgreSQL 15+
-- - UUID生成に gen_random_uuid() を使用
-- - 部分一致検索に pg_trgm を使用

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- =========================
-- 共通 / マスタ
-- =========================
CREATE TABLE code_masters (
    id              BIGSERIAL PRIMARY KEY,
    category        VARCHAR(50)  NOT NULL,
    code            VARCHAR(50)  NOT NULL,
    label           VARCHAR(200) NOT NULL,
    sort_order      INT          NOT NULL DEFAULT 0,
    is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
    CONSTRAINT uq_code_masters_category_code UNIQUE (category, code)
);

CREATE TABLE roles (
    id              BIGSERIAL PRIMARY KEY,
    role_key        VARCHAR(100) NOT NULL UNIQUE,
    role_name       VARCHAR(200) NOT NULL,
    description     TEXT,
    -- 標準ロール（true）は削除・識別子変更を不可とし、カスタムロール（false）は管理画面で自由に作成・編集・削除できる
    is_builtin      BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE users (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entra_object_id      UUID         NOT NULL UNIQUE,
    display_name         VARCHAR(200) NOT NULL,
    user_principal_name  VARCHAR(255) NOT NULL UNIQUE,
    mail                 VARCHAR(255),
    profile_image_base64 TEXT,
    cti_ext_num          VARCHAR(20),
    cti_password         VARCHAR(200),
    status               SMALLINT     NOT NULL DEFAULT 0,
    last_signed_in_at    TIMESTAMPTZ,
    created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT ck_users_status CHECK (status IN (0,1,2))
);
CREATE INDEX idx_users_display_name ON users (display_name);
CREATE INDEX idx_users_mail ON users (mail);
CREATE INDEX idx_users_status ON users (status);

CREATE TABLE user_roles (
    user_id UUID   NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_id BIGINT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, role_id)
);

CREATE TABLE entra_group_role_maps (
    entra_group_id   UUID   NOT NULL,
    entra_group_name VARCHAR(200),
    role_id          BIGINT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    PRIMARY KEY (entra_group_id, role_id)
);

-- 権限（パーミッション）カタログ：アプリが提供する「画面アクセス」と「操作」の一覧。
-- category='screen'（画面の表示可否） / 'action'（登録・編集・消込・開示などの操作可否）。
CREATE TABLE permissions (
    perm_key   VARCHAR(100) PRIMARY KEY,
    perm_name  VARCHAR(200) NOT NULL,
    category   VARCHAR(30)  NOT NULL,
    sort_order INT          NOT NULL DEFAULT 0,
    CONSTRAINT ck_permissions_category CHECK (category IN ('screen','action'))
);

-- ロールに割り当てられた権限。ロール（標準／カスタム）ごとに細かく設定できる。
CREATE TABLE role_permissions (
    role_id  BIGINT       NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    perm_key VARCHAR(100) NOT NULL REFERENCES permissions(perm_key) ON DELETE CASCADE,
    PRIMARY KEY (role_id, perm_key)
);

CREATE TABLE audit_logs (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_type   VARCHAR(50) NOT NULL,
    entity_id     UUID        NOT NULL,
    action        VARCHAR(30) NOT NULL,
    before_json   JSONB,
    after_json    JSONB,
    actor_user_id UUID REFERENCES users(id),
    acted_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_audit_logs_entity ON audit_logs (entity_type, entity_id);
CREATE INDEX idx_audit_logs_action ON audit_logs (action);
CREATE INDEX idx_audit_logs_acted_at ON audit_logs (acted_at);

-- =========================
-- 会社 / 名義
-- =========================
CREATE TABLE companies (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_name                VARCHAR(255) NOT NULL,
    company_name_kana           VARCHAR(255),
    corporate_number            VARCHAR(13),
    postal_code                 VARCHAR(7),
    prefecture                  VARCHAR(20),
    city                        VARCHAR(100),
    address1                    VARCHAR(255),
    address2                    VARCHAR(255),
    status_flag                 SMALLINT NOT NULL DEFAULT 0,
    status_reason               TEXT,
    participates_credit_bureaus JSONB,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT ck_companies_status_flag CHECK (status_flag IN (0,1,2))
);
CREATE INDEX idx_companies_company_name ON companies (company_name);
CREATE INDEX idx_companies_company_name_kana ON companies (company_name_kana);
CREATE INDEX idx_companies_corporate_number ON companies (corporate_number);
CREATE INDEX idx_companies_postal_code ON companies (postal_code);
CREATE INDEX idx_companies_prefecture_city ON companies (prefecture, city);
CREATE INDEX idx_companies_status_flag ON companies (status_flag);
CREATE INDEX idx_companies_company_name_trgm ON companies USING gin (company_name gin_trgm_ops);

CREATE TABLE company_phones (
    id                      BIGSERIAL PRIMARY KEY,
    company_id              UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    phone_number            VARCHAR(20) NOT NULL,
    phone_number_normalized VARCHAR(20) NOT NULL,
    phone_type              VARCHAR(50),
    is_primary              BOOLEAN     NOT NULL DEFAULT FALSE,
    note                    VARCHAR(255)
);
CREATE INDEX idx_company_phones_company_id ON company_phones (company_id);
CREATE INDEX idx_company_phones_phone_norm ON company_phones (phone_number_normalized);
CREATE INDEX idx_company_phones_is_primary ON company_phones (is_primary);

CREATE TABLE company_emails (
    id         BIGSERIAL PRIMARY KEY,
    company_id UUID         NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    email      VARCHAR(255) NOT NULL,
    is_primary BOOLEAN      NOT NULL DEFAULT FALSE
);
CREATE INDEX idx_company_emails_company_id ON company_emails (company_id);
CREATE INDEX idx_company_emails_email ON company_emails (email);

CREATE TABLE company_categories (
    company_id    UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    category_code VARCHAR(50) NOT NULL,
    PRIMARY KEY (company_id, category_code)
);
CREATE INDEX idx_company_categories_category_code ON company_categories (category_code);

CREATE TABLE persons (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    full_name      VARCHAR(200) NOT NULL,
    full_name_kana VARCHAR(200),
    birth_date     DATE,
    postal_code    VARCHAR(7),
    prefecture     VARCHAR(20),
    city           VARCHAR(100),
    address1       VARCHAR(255),
    address2       VARCHAR(255),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_persons_full_name ON persons (full_name);
CREATE INDEX idx_persons_full_name_kana ON persons (full_name_kana);
CREATE INDEX idx_persons_birth_date ON persons (birth_date);
CREATE INDEX idx_persons_postal_code ON persons (postal_code);
CREATE INDEX idx_persons_prefecture_city ON persons (prefecture, city);
CREATE INDEX idx_persons_full_name_trgm ON persons USING gin (full_name gin_trgm_ops);
-- ★名義の電話番号は保持しない（Q54）：person_phones は廃止（以下は無効化）
-- CREATE TABLE person_phones (
--     id                      BIGSERIAL PRIMARY KEY,
--     person_id               UUID        NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
--     phone_number            VARCHAR(20) NOT NULL,
--     phone_number_normalized VARCHAR(20) NOT NULL
-- );
-- CREATE INDEX idx_person_phones_person_id ON person_phones (person_id);
-- CREATE INDEX idx_person_phones_phone_norm ON person_phones (phone_number_normalized);

CREATE TABLE person_emails (
    id        BIGSERIAL PRIMARY KEY,
    person_id UUID         NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
    email     VARCHAR(255) NOT NULL
);
CREATE INDEX idx_person_emails_person_id ON person_emails (person_id);
CREATE INDEX idx_person_emails_email ON person_emails (email);

-- =========================
-- 金融情報
-- =========================
CREATE TABLE accounts (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_category     VARCHAR(20)  NOT NULL,
    account_type         VARCHAR(20)  NOT NULL,
    account_role         VARCHAR(20)  NOT NULL,
    bank_code            VARCHAR(4),
    branch_code          VARCHAR(3),
    bank_name            VARCHAR(100),
    branch_name          VARCHAR(100),
    account_no_encrypted BYTEA,
    account_no_masked    VARCHAR(32),
    account_holder_kana  VARCHAR(200),
    expiry_mm_yy         VARCHAR(5),
    cvv2_encrypted       BYTEA,
    incident_code        VARCHAR(2)  NOT NULL DEFAULT '00',
    is_active            BOOLEAN     NOT NULL DEFAULT TRUE,
    search_hash          VARCHAR(128),
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT ck_accounts_category CHECK (account_category IN ('credit','bank')),
    CONSTRAINT ck_accounts_role CHECK (account_role IN ('self','other')),
    CONSTRAINT ck_accounts_expiry CHECK (expiry_mm_yy IS NULL OR expiry_mm_yy ~ '^(0[1-9]|1[0-2])/\d{2}$')
);
CREATE INDEX idx_accounts_category ON accounts (account_category);
CREATE INDEX idx_accounts_type ON accounts (account_type);
CREATE INDEX idx_accounts_role ON accounts (account_role);
CREATE INDEX idx_accounts_bank_branch ON accounts (bank_code, branch_code);
CREATE INDEX idx_accounts_masked ON accounts (account_no_masked);
CREATE INDEX idx_accounts_holder_kana ON accounts (account_holder_kana);
CREATE INDEX idx_accounts_incident ON accounts (incident_code);
CREATE INDEX idx_accounts_search_hash ON accounts (search_hash);

-- =========================
-- 契約
-- =========================
CREATE TABLE contracts (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    contract_no           VARCHAR(30)  NOT NULL UNIQUE,
    contract_category     VARCHAR(50)  NOT NULL,
    contract_summary      VARCHAR(500) NOT NULL,
    contract_status       VARCHAR(30)  NOT NULL,
    review_status         VARCHAR(30)  NOT NULL,
    review_reason         TEXT,
    signed_at             DATE,
    started_at            DATE,
    ended_at              DATE,
    has_recurring_billing BOOLEAN     NOT NULL DEFAULT FALSE,
    billing_rule_json     JSONB,
    assignee_user_id      UUID REFERENCES users(id),
    review_memo           TEXT,
    version_no            INTEGER      NOT NULL DEFAULT 1,
    created_by            UUID NOT NULL REFERENCES users(id),
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_contracts_category ON contracts (contract_category);
CREATE INDEX idx_contracts_status ON contracts (contract_status);
CREATE INDEX idx_contracts_review_status ON contracts (review_status);
CREATE INDEX idx_contracts_signed_at ON contracts (signed_at);
CREATE INDEX idx_contracts_started_at ON contracts (started_at);
CREATE INDEX idx_contracts_ended_at ON contracts (ended_at);
CREATE INDEX idx_contracts_assignee_user_id ON contracts (assignee_user_id);
CREATE INDEX idx_contracts_created_by ON contracts (created_by);
CREATE INDEX idx_contracts_summary_trgm ON contracts USING gin (contract_summary gin_trgm_ops);

CREATE TABLE contract_identifiers (
    id               BIGSERIAL PRIMARY KEY,
    contract_id      UUID         NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
    identifier_type  VARCHAR(50)  NOT NULL,
    identifier_value VARCHAR(255) NOT NULL,
    is_primary       BOOLEAN      NOT NULL DEFAULT FALSE
);
CREATE INDEX idx_contract_ident_contract_id ON contract_identifiers (contract_id);
CREATE INDEX idx_contract_ident_type_value ON contract_identifiers (identifier_type, identifier_value);
CREATE UNIQUE INDEX uq_contract_ident_primary_per_type ON contract_identifiers (contract_id, identifier_type, is_primary) WHERE is_primary = TRUE;

CREATE TABLE contract_flags (
    contract_id UUID        NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
    flag_code   VARCHAR(50) NOT NULL,
    PRIMARY KEY (contract_id, flag_code)
);
CREATE INDEX idx_contract_flags_flag_code ON contract_flags (flag_code);

CREATE TABLE contract_review_tags (
    contract_id UUID         NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
    tag         VARCHAR(100) NOT NULL,
    PRIMARY KEY (contract_id, tag)
);
CREATE INDEX idx_contract_review_tags_tag ON contract_review_tags (tag);

CREATE TABLE contract_company_links (
    id            BIGSERIAL PRIMARY KEY,
    contract_id   UUID        NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
    company_id    UUID        NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
    link_category VARCHAR(50) NOT NULL
);
CREATE INDEX idx_contract_company_links_contract_id ON contract_company_links (contract_id);
CREATE INDEX idx_contract_company_links_company_id ON contract_company_links (company_id);
CREATE INDEX idx_contract_company_links_category ON contract_company_links (link_category);

CREATE TABLE contract_person_links (
    id            BIGSERIAL PRIMARY KEY,
    contract_id   UUID        NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
    person_id     UUID        NOT NULL REFERENCES persons(id) ON DELETE RESTRICT,
    link_category VARCHAR(50) NOT NULL
);
CREATE INDEX idx_contract_person_links_contract_id ON contract_person_links (contract_id);
CREATE INDEX idx_contract_person_links_person_id ON contract_person_links (person_id);
CREATE INDEX idx_contract_person_links_category ON contract_person_links (link_category);

CREATE TABLE contract_account_links (
    id            BIGSERIAL PRIMARY KEY,
    contract_id   UUID        NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
    account_id    UUID        NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    link_category VARCHAR(50) NOT NULL,
    is_default    BOOLEAN     NOT NULL DEFAULT FALSE
);
CREATE INDEX idx_contract_account_links_contract_id ON contract_account_links (contract_id);
CREATE INDEX idx_contract_account_links_account_id ON contract_account_links (account_id);
CREATE INDEX idx_contract_account_links_category ON contract_account_links (link_category);
CREATE UNIQUE INDEX uq_contract_account_default_per_category ON contract_account_links (contract_id, link_category, is_default) WHERE is_default = TRUE;

-- =========================
-- 問合履歴
-- =========================
CREATE TABLE communications (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    contract_id     UUID NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
    occurred_at     TIMESTAMPTZ NOT NULL,
    channel         VARCHAR(30) NOT NULL,
    direction       VARCHAR(10) NOT NULL,
    from_company_id UUID REFERENCES companies(id),
    from_person_id  UUID REFERENCES persons(id),
    to_company_id   UUID REFERENCES companies(id),
    to_person_id    UUID REFERENCES persons(id),
    summary         VARCHAR(255) NOT NULL,
    details         TEXT,
    secret_note     TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT ck_communications_direction CHECK (direction IN ('in','out'))
);
CREATE INDEX idx_communications_contract_id ON communications (contract_id);
CREATE INDEX idx_communications_occurred_at ON communications (occurred_at);
CREATE INDEX idx_communications_channel ON communications (channel);
CREATE INDEX idx_communications_direction ON communications (direction);
CREATE INDEX idx_communications_summary_trgm ON communications USING gin (summary gin_trgm_ops);

CREATE TABLE IF NOT EXISTS communication_calendar_events (
    communication_id UUID PRIMARY KEY REFERENCES communications(id) ON DELETE CASCADE,
    request_id UUID NOT NULL UNIQUE,
    requested_by UUID NOT NULL REFERENCES users(id),
    request_hash VARCHAR(64) NOT NULL,
    group_id UUID NOT NULL,
    calendar_name TEXT NOT NULL,
    starts_at TIMESTAMPTZ NOT NULL,
    ends_at TIMESTAMPTZ NOT NULL,
    graph_payload JSONB NOT NULL,
    status VARCHAR(10) NOT NULL DEFAULT 'pending',
    event_id TEXT,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT ck_communication_calendar_time CHECK (ends_at > starts_at),
    CONSTRAINT ck_communication_calendar_status CHECK (status IN ('pending', 'created', 'failed')),
    CONSTRAINT ck_communication_calendar_event CHECK ((status = 'created') = (event_id IS NOT NULL))
);

CREATE TABLE communication_categories (
    communication_id UUID        NOT NULL REFERENCES communications(id) ON DELETE CASCADE,
    category_type    VARCHAR(10) NOT NULL,
    category_value   VARCHAR(100) NOT NULL,
    PRIMARY KEY (communication_id, category_type, category_value)
);
CREATE INDEX idx_comm_categories_type_value ON communication_categories (category_type, category_value);

-- =========================
-- 請求 / 支払 / 消込
-- =========================
CREATE TABLE claims (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    contract_id         UUID NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
    claim_category      VARCHAR(20)   NOT NULL,
    occurred_on         DATE          NOT NULL,
    new_amount          NUMERIC(18,2) NOT NULL DEFAULT 0,
    carry_over_amount   NUMERIC(18,2) NOT NULL DEFAULT 0,
    claim_total_amount  NUMERIC(18,2) NOT NULL,
    due_at              TIMESTAMPTZ,
    payment_method_json JSONB,
    status              VARCHAR(20)   NOT NULL,
    remaining_balance   NUMERIC(18,2) NOT NULL DEFAULT 0,
    version_no          INT           NOT NULL DEFAULT 1,
    created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT ck_claims_amounts CHECK (claim_total_amount = new_amount + carry_over_amount)
);
CREATE INDEX idx_claims_contract_id ON claims (contract_id);
CREATE INDEX idx_claims_due_status ON claims (contract_id, due_at, status);
CREATE INDEX idx_claims_occurred_on ON claims (occurred_on);
CREATE INDEX idx_claims_status ON claims (status);
CREATE INDEX idx_claims_remaining_balance ON claims (remaining_balance);

CREATE TABLE payments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    contract_id     UUID NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
    received_at     TIMESTAMPTZ   NOT NULL,
    amount          NUMERIC(18,2) NOT NULL,
    received_place  VARCHAR(255),
    received_method VARCHAR(100),
    source_type     VARCHAR(20)   NOT NULL DEFAULT '通常',
    lawsuit_id      UUID,
    receipt_type    VARCHAR(30),
    has_receipt     BOOLEAN       NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_payments_contract_id ON payments (contract_id);
CREATE INDEX idx_payments_received_at ON payments (received_at);
CREATE INDEX idx_payments_lawsuit_id ON payments (lawsuit_id);
CREATE INDEX idx_payments_method ON payments (received_method);

CREATE TABLE payment_allocations (
    id               BIGSERIAL PRIMARY KEY,
    payment_id       UUID          NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
    claim_id         UUID          NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
    allocated_amount NUMERIC(18,2) NOT NULL,
    allocation_order INT           NOT NULL DEFAULT 1,
    CONSTRAINT uq_payment_allocations UNIQUE (payment_id, claim_id)
);
CREATE INDEX idx_payment_allocations_payment_id ON payment_allocations (payment_id);
CREATE INDEX idx_payment_allocations_claim_id ON payment_allocations (claim_id);

CREATE TABLE claim_adjustments (
    id              BIGSERIAL PRIMARY KEY,
    claim_id        UUID          NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
    adjustment_type VARCHAR(30)   NOT NULL,
    amount          NUMERIC(18,2) NOT NULL,
    reason          TEXT,
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_claim_adjustments_claim_id ON claim_adjustments (claim_id);
CREATE INDEX idx_claim_adjustments_type ON claim_adjustments (adjustment_type);

-- =========================
-- 訴訟
-- =========================
-- ★v9：訴訟モデルを「受ける側（＝被告）」視点に拡張（当事者／請求内容／判決・和解／提出書類／強制執行(差押)／経過メモ）
CREATE TABLE lawsuits (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    contract_id           UUID NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
    proc_type             VARCHAR(50)  NOT NULL,
    case_name             VARCHAR(255),
    case_number           VARCHAR(100) NOT NULL,
    court_name            VARCHAR(255) NOT NULL,
    court_clerk           VARCHAR(100),
    our_side_role         VARCHAR(30)  NOT NULL DEFAULT '被告（当方）',
    our_lawyer            VARCHAR(255),
    owner_user_id         UUID REFERENCES users(id),
    claim_amount          NUMERIC(18,2),
    filed_or_received_on  DATE,
    status                VARCHAR(30)  NOT NULL,
    -- 請求内容（相手方の主張）
    demand                TEXT,
    cause                 TEXT,
    delay_interest        VARCHAR(50),
    suit_value            NUMERIC(18,2),
    stamp_fee             NUMERIC(18,2),
    -- 判決・和解
    judgment_result       VARCHAR(30),
    judged_on             DATE,
    accepted_amount       NUMERIC(18,2),
    settled_on            DATE,
    settlement_content    TEXT,
    finalized_on          DATE,
    -- 債務名義・強制執行（差押）※当方が受ける側
    exec_title_type       VARCHAR(50),
    exec_seizure_kind     VARCHAR(255),
    exec_court            VARCHAR(255),
    exec_status           VARCHAR(30),
    exec_collected_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_lawsuits_case UNIQUE (court_name, case_number)
);
CREATE INDEX idx_lawsuits_contract_id ON lawsuits (contract_id);
CREATE INDEX idx_lawsuits_status ON lawsuits (status);

-- 訴訟の当事者（原告/被告/連帯保証人/第三債務者 等。原則、当方＝被告側）
-- 訴訟の当事者（契約に登録済みの人／会社から選択して引き込む。原則、当方＝被告側）※Q55
CREATE TABLE lawsuit_parties (
    id                    BIGSERIAL PRIMARY KEY,
    lawsuit_id            UUID        NOT NULL REFERENCES lawsuits(id) ON DELETE CASCADE,
    party_role            VARCHAR(50) NOT NULL,
    person_id             UUID REFERENCES persons(id),
    company_id            UUID REFERENCES companies(id),
    agent_company_id      UUID REFERENCES companies(id),
    agent_note            VARCHAR(100),
    display_name_snapshot VARCHAR(255),
    CONSTRAINT ck_lawsuit_parties_ref CHECK (person_id IS NOT NULL OR company_id IS NOT NULL)
);
CREATE INDEX idx_lawsuit_parties_lawsuit_id ON lawsuit_parties (lawsuit_id);

CREATE TABLE lawsuit_schedules (
    id            BIGSERIAL PRIMARY KEY,
    lawsuit_id    UUID        NOT NULL REFERENCES lawsuits(id) ON DELETE CASCADE,
    schedule_type VARCHAR(50) NOT NULL,
    scheduled_at  TIMESTAMPTZ NOT NULL,
    place         VARCHAR(255),
    attendee      VARCHAR(100),
    result        VARCHAR(20) NOT NULL DEFAULT '予定',
    completed_at  TIMESTAMPTZ
);
CREATE INDEX idx_lawsuit_schedules_lawsuit_id ON lawsuit_schedules (lawsuit_id);
CREATE INDEX idx_lawsuit_schedules_scheduled_at ON lawsuit_schedules (scheduled_at);

-- 提出書類（答弁書/準備書面/証拠 等。当方／相手方／裁判所）
CREATE TABLE lawsuit_documents (
    id         BIGSERIAL PRIMARY KEY,
    lawsuit_id UUID         NOT NULL REFERENCES lawsuits(id) ON DELETE CASCADE,
    doc_name   VARCHAR(255) NOT NULL,
    side       VARCHAR(20)  NOT NULL,
    due_on     DATE,
    filed_on   DATE,
    state      VARCHAR(20)  NOT NULL DEFAULT '未提出',
    file_id    UUID
);
CREATE INDEX idx_lawsuit_documents_lawsuit_id ON lawsuit_documents (lawsuit_id);

-- 経過メモ（時系列の対応記録）
CREATE TABLE lawsuit_memos (
    id         BIGSERIAL PRIMARY KEY,
    lawsuit_id UUID NOT NULL REFERENCES lawsuits(id) ON DELETE CASCADE,
    memo_on    DATE NOT NULL,
    note       TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_lawsuit_memos_lawsuit_id ON lawsuit_memos (lawsuit_id);

-- =========================
-- ファイル
-- =========================
CREATE TABLE files (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    contract_id           UUID REFERENCES contracts(id) ON DELETE CASCADE,
    file_name             VARCHAR(255) NOT NULL,
    content_type          VARCHAR(100),
    file_size_bytes       BIGINT,
    storage_backend       VARCHAR(30)  NOT NULL,
    storage_key           VARCHAR(500) NOT NULL UNIQUE,
    tag_text              VARCHAR(500),
    is_password_protected BOOLEAN      NOT NULL DEFAULT FALSE,
    created_by            UUID REFERENCES users(id),
    created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_files_contract_id ON files (contract_id);
CREATE INDEX idx_files_storage_backend ON files (storage_backend);
CREATE INDEX idx_files_file_name ON files (file_name);
CREATE INDEX idx_files_tag_text_trgm ON files USING gin (tag_text gin_trgm_ops);

-- ファイルの実体（バイナリ）。メタデータ（files）と分離して保持する。
-- 実ファイルが未登録のレコードには行が存在しない（プレビュー/ダウンロード不可）。
CREATE TABLE file_blobs (
    file_id UUID PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
    content BYTEA NOT NULL
);

CREATE TABLE file_tags (
    file_id UUID         NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    tag     VARCHAR(100) NOT NULL,
    PRIMARY KEY (file_id, tag)
);
CREATE INDEX idx_file_tags_tag ON file_tags (tag);

CREATE TABLE file_access_policies (
    id             BIGSERIAL PRIMARY KEY,
    file_id        UUID        NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    access_scope   VARCHAR(30) NOT NULL,
    target_user_id UUID REFERENCES users(id),
    password_hash  VARCHAR(255)
);
CREATE INDEX idx_file_access_policies_file_id ON file_access_policies (file_id);
CREATE INDEX idx_file_access_policies_scope ON file_access_policies (access_scope);
CREATE INDEX idx_file_access_policies_target_user_id ON file_access_policies (target_user_id);

-- =========================
-- CTI / Teams
-- =========================
CREATE TABLE call_histories (
    id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    call_id                VARCHAR(100) NOT NULL UNIQUE,
    direction              VARCHAR(10)  NOT NULL,
    from_number            VARCHAR(20),
    from_number_normalized VARCHAR(20),
    to_number              VARCHAR(20),
    to_number_normalized   VARCHAR(20),
    started_at             TIMESTAMPTZ NOT NULL,
    ended_at               TIMESTAMPTZ,
    duration_seconds       INT,
    recording_url          VARCHAR(500),
    linked_contract_id     UUID REFERENCES contracts(id),
    created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT ck_call_histories_direction CHECK (direction IN ('in','out'))
);
CREATE INDEX idx_call_histories_from_norm ON call_histories (from_number_normalized);
CREATE INDEX idx_call_histories_to_norm ON call_histories (to_number_normalized);
CREATE INDEX idx_call_histories_linked_contract_id ON call_histories (linked_contract_id);
CREATE INDEX idx_call_histories_started_at ON call_histories (started_at);

CREATE TABLE user_presence (
    user_id         UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    presence_status VARCHAR(30) NOT NULL,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_user_presence_status ON user_presence (presence_status);
CREATE INDEX idx_user_presence_updated_at ON user_presence (updated_at);

CREATE TABLE teams_notifications (
    id                BIGSERIAL PRIMARY KEY,
    notification_type VARCHAR(50) NOT NULL,
    payload_json      JSONB       NOT NULL,
    posted_at         TIMESTAMPTZ,
    status            VARCHAR(20) NOT NULL DEFAULT 'queued',
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_teams_notifications_type ON teams_notifications (notification_type);
CREATE INDEX idx_teams_notifications_posted_at ON teams_notifications (posted_at);
CREATE INDEX idx_teams_notifications_status ON teams_notifications (status);

-- =========================
-- 家計簿
-- =========================
CREATE TABLE household_entries (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    contract_id   UUID REFERENCES contracts(id) ON DELETE SET NULL,
    used_on       DATE          NOT NULL,
    used_place    VARCHAR(255),
    amount        NUMERIC(18,2) NOT NULL,
    category_code VARCHAR(50)   NOT NULL,
    entry_type    VARCHAR(10)   NOT NULL DEFAULT 'expense' CHECK (entry_type IN ('income','expense')),
    created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_household_entries_contract_id ON household_entries (contract_id);
CREATE INDEX idx_household_entries_used_on ON household_entries (used_on);
CREATE INDEX idx_household_entries_category_code ON household_entries (category_code);

-- =========================
-- 推奨トリガ補足（実装時）
-- =========================
-- 1. updated_at 自動更新 trigger
-- 2. 残債・預り金は VIEW v_contract_balance で算出（claims.remaining_balance は廃止）
-- 3. 機微情報のアプリ層暗号化 / 復号監査
-- 4. S情報(secret_note)の列レベル・アプリ権限制御

-- =========================
-- 追加分（2026-07-10 反映）
-- =========================
CREATE TABLE sensitive_access_requests (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    requester_user_id UUID        NOT NULL REFERENCES users(id),
    target_type       VARCHAR(30) NOT NULL,
    target_id         UUID        NOT NULL,
    target_field      VARCHAR(30) NOT NULL,
    reason            TEXT        NOT NULL,
    status            VARCHAR(20) NOT NULL DEFAULT 'pending',
    approver_user_id  UUID        REFERENCES users(id),
    requested_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    decided_at        TIMESTAMPTZ,
    expires_at        TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_sar_status   ON sensitive_access_requests(status);
CREATE INDEX idx_sar_target   ON sensitive_access_requests(target_type, target_id);
CREATE INDEX idx_sar_approver ON sensitive_access_requests(approver_user_id);

-- 家計簿：収入/支出の区分を追加
ALTER TABLE household_entries ADD COLUMN IF NOT EXISTS entry_type VARCHAR(10) NOT NULL DEFAULT 'expense';

-- 契約の残債・預り金（過入金くり越し）算出ビュー
CREATE OR REPLACE VIEW v_contract_balance AS
SELECT c.id AS contract_id,
       COALESCE(cl.claim_total,0) AS claim_total,
       COALESCE(pm.paid_total,0)  AS paid_total,
       COALESCE(cl.claim_total,0) - COALESCE(pm.paid_total,0) AS remaining_balance,
       GREATEST(COALESCE(pm.paid_total,0) - COALESCE(cl.claim_total,0), 0) AS advance_balance
FROM contracts c
LEFT JOIN (SELECT contract_id, SUM(claim_total_amount) AS claim_total FROM claims    GROUP BY contract_id) cl ON cl.contract_id = c.id
LEFT JOIN (SELECT contract_id, SUM(amount)            AS paid_total  FROM payments  GROUP BY contract_id) pm ON pm.contract_id = c.id;

-- =========================
-- 追加分（2026-07-10 第2回反映：契約番号・編集ロック・審査履歴／残債一本化）
-- =========================
-- 契約番号：自動採番の通し番号（表示・検索用）。証券/顧客番号は contract_identifiers を継続使用
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS contract_no VARCHAR(30);
CREATE UNIQUE INDEX uq_contracts_contract_no ON contracts (contract_no);
-- 楽観ロック（保存時の競合検知）。開いている間ロックは edit_locks
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS version_no INT NOT NULL DEFAULT 1;
-- 残債は VIEW 算出へ一本化（列を廃止）
DROP INDEX IF EXISTS idx_claims_remaining_balance;
ALTER TABLE claims DROP COLUMN IF EXISTS remaining_balance;

-- 編集中ロック（開いている間ロック：Q17=C）。expires_at 経過で自動解除、管理者は強制解除可
CREATE TABLE edit_locks (
    id               BIGSERIAL PRIMARY KEY,
    entity_type      VARCHAR(30)  NOT NULL,
    entity_id        UUID         NOT NULL,
    locked_by        UUID         NOT NULL REFERENCES users(id),
    locked_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    expires_at       TIMESTAMPTZ  NOT NULL,
    released_at      TIMESTAMPTZ,
    released_by      UUID         REFERENCES users(id),
    is_force_release BOOLEAN      NOT NULL DEFAULT FALSE
);
CREATE UNIQUE INDEX uq_edit_locks_active ON edit_locks (entity_type, entity_id) WHERE released_at IS NULL;
CREATE INDEX idx_edit_locks_expires ON edit_locks (expires_at);
CREATE INDEX idx_edit_locks_locked_by ON edit_locks (locked_by);

-- 審査（承認/差戻し）履歴：誰が・いつ・どうしたか
CREATE TABLE contract_reviews (
    id            BIGSERIAL PRIMARY KEY,
    contract_id   UUID        NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
    action        VARCHAR(20) NOT NULL,
    actor_user_id UUID        NOT NULL REFERENCES users(id),
    comment       TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT ck_contract_reviews_action CHECK (action IN ('submitted','approved','returned','rejected'))
);
CREATE INDEX idx_contract_reviews_contract_id ON contract_reviews (contract_id);
CREATE INDEX idx_contract_reviews_action ON contract_reviews (action);
CREATE INDEX idx_contract_reviews_actor ON contract_reviews (actor_user_id);

-- =========================
-- 原本ファイル管理（紙の原本の保管）  ★v11
-- 格納場所 / 保管ファイル（バインダー） / 原本。入金の証票も original_documents に「入金証票」として保管管理
-- =========================
ALTER TABLE payments ADD COLUMN IF NOT EXISTS receipt_type VARCHAR(30);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS has_receipt  BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE storage_locations (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        VARCHAR(100) NOT NULL,
    detail      VARCHAR(200),
    note        VARCHAR(500),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_storage_locations_name ON storage_locations (name);

CREATE TABLE storage_files (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    file_code   VARCHAR(50)  NOT NULL UNIQUE,
    title       VARCHAR(255) NOT NULL,
    category    VARCHAR(30),
    location_id UUID REFERENCES storage_locations(id) ON DELETE SET NULL,
    note        VARCHAR(500),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_storage_files_location_id ON storage_files (location_id);
CREATE INDEX idx_storage_files_category ON storage_files (category);

CREATE TABLE original_documents (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    doc_type        VARCHAR(50)  NOT NULL,
    contract_id     UUID REFERENCES contracts(id) ON DELETE SET NULL,
    storage_file_id UUID REFERENCES storage_files(id) ON DELETE SET NULL,
    payment_id      UUID REFERENCES payments(id) ON DELETE CASCADE,
    received_on     DATE,
    status          VARCHAR(20) NOT NULL DEFAULT '保管中',
    borrowed_by     UUID REFERENCES users(id),
    borrowed_at     TIMESTAMPTZ,
    returned_at     TIMESTAMPTZ,
    disposed_at     DATE,
    disposed_by     UUID REFERENCES users(id),
    note            TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT ck_original_documents_status CHECK (status IN ('保管中','貸出中','返却済','廃棄済'))
);
CREATE INDEX idx_original_documents_contract_id ON original_documents (contract_id);
CREATE INDEX idx_original_documents_storage_file_id ON original_documents (storage_file_id);
CREATE INDEX idx_original_documents_payment_id ON original_documents (payment_id);
CREATE INDEX idx_original_documents_status ON original_documents (status);
CREATE INDEX idx_original_documents_doc_type ON original_documents (doc_type);

-- =========================
-- v13 追加：原本の廃棄記録（廃棄日・承認者）  ★R62回答
-- =========================
ALTER TABLE original_documents ADD COLUMN IF NOT EXISTS disposed_at DATE;
ALTER TABLE original_documents ADD COLUMN IF NOT EXISTS disposed_by UUID REFERENCES users(id);

-- =========================
-- v20 追加：着信照会（MOUNTAIN提供）・着信拒否リスト  ★R75/R76回答
--   R75=はい：電話番号→会社/弁護士 の照会を MOUNTAIN 側で提供（現行Vodkaから移行）。
--   R76=はい：着信拒否リスト（拒否フラグ＋理由）を新設し、会社/電話番号単位で管理。
--   ※弁護士/サービサー判定は company_categories.category_code（初期マスタで定義）で付与。
--   ※拒否理由コードは code_masters(category='call_deny_reason')：1=総合的判断/2=複数回の間違い電話/3=一時的。
-- =========================
CREATE TABLE call_deny_list (
    id                      BIGSERIAL PRIMARY KEY,
    phone_number            VARCHAR(20) NOT NULL,
    phone_number_normalized VARCHAR(20) NOT NULL,
    company_id              UUID REFERENCES companies(id) ON DELETE SET NULL,
    reason_code             VARCHAR(10) NOT NULL,
    reason_note             TEXT,
    is_active               BOOLEAN     NOT NULL DEFAULT TRUE,
    created_by              UUID REFERENCES users(id),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT ck_call_deny_reason CHECK (reason_code IN ('1','2','3'))
);
CREATE INDEX idx_call_deny_active_phone ON call_deny_list (phone_number_normalized) WHERE is_active;
CREATE INDEX idx_call_deny_company ON call_deny_list (company_id);

-- 着信照会ビュー（MOUNTAIN が search_by_phone 相当を提供）
CREATE OR REPLACE VIEW v_incoming_phone_lookup AS
SELECT cp.phone_number_normalized,
       c.id           AS company_id,
       c.company_name AS company_name,
       dl.reason_code AS deny_reason_code,
       (dl.id IS NOT NULL) AS is_denied
FROM company_phones cp
JOIN companies c ON c.id = cp.company_id
LEFT JOIN LATERAL (
    SELECT id, reason_code FROM call_deny_list d
    WHERE d.phone_number_normalized = cp.phone_number_normalized AND d.is_active
    LIMIT 1
) dl ON TRUE;

-- ============================================================
-- v22 追加・変更（モック最終化反映：着信拒否の所在変更／通話操作バー・操作ログ／通話録音再生）
-- ============================================================
-- 会社の電話番号ごとに着信拒否（理由付き）を保持
ALTER TABLE company_phones ADD COLUMN IF NOT EXISTS is_blocked        BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE company_phones ADD COLUMN IF NOT EXISTS block_reason_code VARCHAR(10);
ALTER TABLE company_phones ADD COLUMN IF NOT EXISTS block_reason_note TEXT;
ALTER TABLE company_phones ADD COLUMN IF NOT EXISTS blocked_by        UUID REFERENCES users(id);
ALTER TABLE company_phones ADD COLUMN IF NOT EXISTS blocked_at        TIMESTAMPTZ;
CREATE INDEX idx_company_phones_is_blocked ON company_phones (is_blocked) WHERE is_blocked;

-- 通話履歴：結果・録音有無・録音ファイル・対応者
ALTER TABLE call_histories ADD COLUMN IF NOT EXISTS call_result      VARCHAR(20);
ALTER TABLE call_histories ADD COLUMN IF NOT EXISTS has_recording    BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE call_histories ADD COLUMN IF NOT EXISTS recording_file   VARCHAR(300);
ALTER TABLE call_histories ADD COLUMN IF NOT EXISTS operator_user_id UUID REFERENCES users(id);
CREATE INDEX idx_call_histories_operator ON call_histories (operator_user_id);

-- 着信拒否リストを承認制へ（会社に属さない番号：申請→承認→有効）
ALTER TABLE call_deny_list ADD COLUMN IF NOT EXISTS approval_status VARCHAR(10) NOT NULL DEFAULT '1';
ALTER TABLE call_deny_list ADD COLUMN IF NOT EXISTS requested_by    UUID REFERENCES users(id);
ALTER TABLE call_deny_list ADD COLUMN IF NOT EXISTS requested_at    TIMESTAMPTZ;
ALTER TABLE call_deny_list ADD COLUMN IF NOT EXISTS approved_by     UUID REFERENCES users(id);
ALTER TABLE call_deny_list ADD COLUMN IF NOT EXISTS approved_at     TIMESTAMPTZ;
ALTER TABLE call_deny_list ADD COLUMN IF NOT EXISTS reject_note     TEXT;
ALTER TABLE call_deny_list ADD CONSTRAINT ck_call_deny_apstatus CHECK (approval_status IN ('1','2','3'));
-- ※会社に属す番号は company_phones.is_blocked で管理。call_deny_list.company_id は任意（原則未使用）。

-- 通話操作ログ（保留・転送・プッシュ・切電などを1操作=1行で記録）
CREATE TABLE call_operation_logs (
    id               BIGSERIAL PRIMARY KEY,
    call_history_id  UUID        NOT NULL REFERENCES call_histories(id) ON DELETE CASCADE,
    seq_no           INT         NOT NULL,
    offset_seconds   INT         NOT NULL,
    operation_type   VARCHAR(20) NOT NULL,
    detail           VARCHAR(255),
    operated_by      UUID REFERENCES users(id),
    operated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_call_op_logs_call ON call_operation_logs (call_history_id);
CREATE INDEX idx_call_op_logs_operated_by ON call_operation_logs (operated_by);

-- ============================================================
-- Wave F 追加（CTI：発信/在席/留守電/アナウンスの本番同等実装）
-- ============================================================
-- 通話のライブ状態（発信中/通話中/保留中/終了）とドライバ種別・相手表示名
ALTER TABLE call_histories ADD COLUMN IF NOT EXISTS call_status  VARCHAR(20) NOT NULL DEFAULT 'ended';
ALTER TABLE call_histories ADD COLUMN IF NOT EXISTS provider     VARCHAR(20);
ALTER TABLE call_histories ADD COLUMN IF NOT EXISTS contact_name VARCHAR(120);
CREATE INDEX IF NOT EXISTS idx_call_histories_active
    ON call_histories (operator_user_id, call_status);
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_call_histories_status') THEN
        ALTER TABLE call_histories
            ADD CONSTRAINT ck_call_histories_status
            CHECK (call_status IN ('dialing','connected','held','ended'));
    END IF;
END$$;

-- 留守電（ボイスメール）
CREATE TABLE IF NOT EXISTS call_voicemails (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    from_number             VARCHAR(20),
    from_number_normalized  VARCHAR(20),
    contact_name            VARCHAR(120),
    linked_contract_id      UUID REFERENCES contracts(id) ON DELETE SET NULL,
    received_at             TIMESTAMPTZ NOT NULL,
    duration_seconds        INT,
    mailbox                 VARCHAR(20) NOT NULL DEFAULT 'INBOX',
    is_heard                BOOLEAN     NOT NULL DEFAULT FALSE,
    recording_file          VARCHAR(300),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_call_voicemails_received ON call_voicemails (received_at DESC);
CREATE INDEX IF NOT EXISTS idx_call_voicemails_mailbox  ON call_voicemails (mailbox);

-- 着信時アナウンス（ガイダンス）：取り込み中/通話中（応答不可）/離席中
CREATE TABLE IF NOT EXISTS call_announcements (
    ann_key     VARCHAR(20) PRIMARY KEY,
    label       VARCHAR(80) NOT NULL,
    file_name   VARCHAR(200),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by  UUID REFERENCES users(id)
);

-- 着信照会ビュー更新：会社電話の拒否フラグ＋承認済みの拒否リストを反映
CREATE OR REPLACE VIEW v_incoming_phone_lookup AS
SELECT cp.phone_number_normalized,
       c.id           AS company_id,
       c.company_name AS company_name,
       COALESCE(cp.block_reason_code, dl.reason_code) AS deny_reason_code,
       (cp.is_blocked OR dl.id IS NOT NULL)           AS is_denied
FROM company_phones cp
JOIN companies c ON c.id = cp.company_id
LEFT JOIN LATERAL (
    SELECT id, reason_code FROM call_deny_list d
    WHERE d.phone_number_normalized = cp.phone_number_normalized
      AND d.is_active AND d.approval_status = '2'
    LIMIT 1
) dl ON TRUE;

-- =========================
-- ファイル連携（DTM）
-- =========================
CREATE TABLE dtm_transfer (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    contract_id   UUID         NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
    transfer_id   VARCHAR(100) NOT NULL UNIQUE,
    transfer_name VARCHAR(255) NOT NULL,
    external_url  TEXT,
    status        VARCHAR(20)  NOT NULL DEFAULT 'active',
    expires_at    TIMESTAMPTZ,
    created_by    UUID         NOT NULL REFERENCES users(id),
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT ck_dtm_transfer_status CHECK (status IN ('active','expired','closed'))
);
CREATE INDEX idx_dtm_transfer_contract ON dtm_transfer (contract_id);
CREATE INDEX idx_dtm_transfer_status ON dtm_transfer (status);
CREATE INDEX idx_dtm_transfer_created_by ON dtm_transfer (created_by);

CREATE TABLE dtm_transfer_members (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transfer_ref_id UUID         NOT NULL REFERENCES dtm_transfer(id) ON DELETE CASCADE,
    email           VARCHAR(255) NOT NULL,
    member_role     VARCHAR(20)  NOT NULL DEFAULT 'viewer',
    invited_by      UUID         NOT NULL REFERENCES users(id),
    invited_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    notified_at     TIMESTAMPTZ,
    note            TEXT
);
CREATE INDEX idx_dtm_members_transfer ON dtm_transfer_members (transfer_ref_id);
CREATE INDEX idx_dtm_members_email ON dtm_transfer_members (email);
CREATE INDEX idx_dtm_members_invited_by ON dtm_transfer_members (invited_by);
-- ★追加（2026-07-19）通知/承認：Teams・Discord オプトイン
ALTER TABLE users ADD COLUMN IF NOT EXISTS notify_channel    VARCHAR(10) NOT NULL DEFAULT 'teams';
ALTER TABLE users ADD COLUMN IF NOT EXISTS discord_user_id   VARCHAR(32);
ALTER TABLE users ADD COLUMN IF NOT EXISTS discord_linked_at TIMESTAMPTZ;
ALTER TABLE users ADD CONSTRAINT ck_users_notify_channel CHECK (notify_channel IN ('teams','discord','both'));
CREATE UNIQUE INDEX uq_users_discord_user_id ON users (discord_user_id) WHERE discord_user_id IS NOT NULL;
-- 通知/承認の横断記録（Teams/Discord/メール）
CREATE TABLE notification_log (
    id                BIGSERIAL PRIMARY KEY,
    kind              VARCHAR(30) NOT NULL,
    target_type       VARCHAR(30),
    target_id         VARCHAR(64),
    recipient_user_id UUID NOT NULL REFERENCES users(id),
    channel           VARCHAR(10) NOT NULL,
    body_min          TEXT,
    sent_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    action_result     VARCHAR(20),
    read_at           TIMESTAMPTZ,
    CONSTRAINT ck_notification_channel CHECK (channel IN ('teams','discord','mail')),
    CONSTRAINT ck_notification_action  CHECK (action_result IS NULL OR action_result IN ('approved','denied','none'))
);
CREATE INDEX idx_notification_recipient ON notification_log (recipient_user_id);
CREATE INDEX idx_notification_kind      ON notification_log (kind);
CREATE INDEX idx_notification_sent_at   ON notification_log (sent_at);

-- =========================
-- 差し込み印刷：文書テンプレート / 生成文書（2026-07-23）
--   Wordテンプレート(.docx)と生成PDFは BYTEA でDB内に保持（DF/本番でボリューム不要・DB永続で残る）。
-- =========================
CREATE TABLE IF NOT EXISTS doc_templates (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name         VARCHAR(200) NOT NULL,
    description  TEXT,
    file_name    VARCHAR(255) NOT NULL,
    content      BYTEA        NOT NULL,               -- .docx 本体
    fields_json  JSONB        NOT NULL DEFAULT '[]',  -- 解析済みの差し込み項目定義
    is_active    BOOLEAN      NOT NULL DEFAULT TRUE,
    created_by   UUID REFERENCES users(id),
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_doc_templates_name   ON doc_templates (name);
CREATE INDEX IF NOT EXISTS idx_doc_templates_active ON doc_templates (is_active);

CREATE TABLE IF NOT EXISTS doc_generated (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    template_id  UUID NOT NULL REFERENCES doc_templates(id) ON DELETE CASCADE,
    title        VARCHAR(255) NOT NULL,
    inputs_json  JSONB        NOT NULL DEFAULT '{}',  -- 選択レコード + 自由入力 + 解決済み値
    pdf_content  BYTEA,                               -- 生成PDF（再DL用にキャッシュ）
    pdf_size     INTEGER,
    created_by   UUID REFERENCES users(id),
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_doc_generated_template ON doc_generated (template_id);
CREATE INDEX IF NOT EXISTS idx_doc_generated_created  ON doc_generated (created_at DESC);
