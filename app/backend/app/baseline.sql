-- =====================================================================
-- MOUNTAIN 本番導入用の「土台データ」（初回アクセス時の自動セットアップ内容）
-- ---------------------------------------------------------------------
-- 空のデータベースにアプリが最初に接続したとき（＝Webへの最初のアクセスまでに）、
-- アプリ自身がこのSQLを実行して、業務の土台となる設定を自動で用意する。
--   （app/bootstrap.py の ensure_baseline() が起動時に呼び出す）
--
-- ここに入るのは「業務の土台」だけ：
--   - code_masters       … 区分マスタ（各画面の選択肢を供給）
--   - roles / permissions / role_permissions … 権限（RBAC）の初期セット
--   - call_announcements … 着信アナウンス（ガイダンス）定義
--   - システム利用者 2件 … 参照整合（登録者/審査者の固定ID）のための内部レコード
--
-- 会社・契約・入金などの「サンプル業務データ」は一切含まない
--   → 本番は空のデータベースから始まり、土台だけが自動で整う。
--
-- このSQLは何度実行しても同じ結果になる（冪等）。すべて ON CONFLICT で
-- 既存行を壊さないため、DF（既にデモseed投入済み）では実質「何もしない」。
--
-- ※ 内容は DF で稼働・検証済みの区分／権限セット（_rbac_seed.py・mock_baseline）と一致。
-- =====================================================================
SET client_encoding = 'UTF8';

-- ---------------------------------------------------------------------
-- 1) コードマスタ（区分）: 画面のドロップダウン等を供給する基礎マスタ
--    ※ id は自動採番（BIGSERIAL）に任せ、(category, code) の一意制約で冪等化。
-- ---------------------------------------------------------------------
INSERT INTO code_masters (category, code, label, sort_order) VALUES
  ('contract_category', 'loan',    '融資契約',   1),
  ('contract_category', 'lease',   'リース契約', 2),
  ('contract_category', 'sales',   '売買契約',   3),
  ('contract_category', 'service', '役務契約',   4),
  ('contract_status', 'active',     '有効',   1),
  ('contract_status', 'delinquent', '延滞',   2),
  ('contract_status', 'litigation', '訴訟中', 3),
  ('contract_status', 'closed',     '完了',   4),
  ('review_status', 'approved', '承認済',   1),
  ('review_status', 'pending',  '審査待ち', 2),
  ('review_status', 'rejected', '差戻',     3),
  ('link_category', 'creditor',        '債権者',     1),
  ('link_category', 'debtor',          '債務者',     2),
  ('link_category', 'guarantor',       '保証人',     3),
  ('link_category', 'agent',           '代理店',     4),
  ('link_category', 'contractor',      '契約者',     5),
  ('link_category', 'joint_guarantor', '連帯保証人', 6),
  ('link_category', 'withdrawal',      '引落口座',   7),
  ('link_category', 'transfer',        '振込先',     8),
  ('contract_flag', 'high_priority', '重要',     1),
  ('contract_flag', 'has_lawsuit',   '訴訟あり', 2),
  ('contract_flag', 'watch',         '要注意',   3),
  ('contract_flag', 'vip',           'VIP',      4),
  ('identifier_type', 'customer_no', '顧客番号',       1),
  ('identifier_type', 'case_no',     '案件番号',       2),
  ('identifier_type', 'policy_no',   '証券番号',       3),
  ('identifier_type', 'member_no',   '会員番号',       4),
  ('identifier_type', 'legacy_no',   '旧システム番号', 5),
  ('identifier_type', 'other',       'その他',         6)
ON CONFLICT (category, code) DO NOTHING;

-- ---------------------------------------------------------------------
-- 2) システム利用者（参照整合用の固定ID・ログイン不可の内部アカウント）
--    アプリは登録者/審査者として固定UUIDを NOT NULL 外部キーに書き込むため、
--    本番でもこの2件が無いと契約作成・審査・ファイル登録が失敗する。
--    実際の利用者は Entra サインイン時に自動登録される（別レコード）。
-- ---------------------------------------------------------------------
INSERT INTO users (id, entra_object_id, display_name, user_principal_name, mail, status) VALUES
  ('00000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'システム',        'system@example.com',        NULL, 0),
  ('00000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000002', 'システム（審査）', 'system-review@example.com', NULL, 0)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------
-- 3) ロール（標準5種）: 権限の入れ物。is_builtin=TRUE は削除不可。
--    id は固定（user_roles / group_role_maps の参照を決定的にするため）。
-- ---------------------------------------------------------------------
INSERT INTO roles (id, role_key, role_name, description, is_builtin) VALUES
  (1, 'admin',             '管理者',   'すべての操作／ユーザー・区分・監査ログの管理',       TRUE),
  (2, 'contract_operator', '契約担当', '契約の登録・編集・入金消込（機微情報は要承認）',     TRUE),
  (3, 'approver',          '承認者',   '新規登録の審査／機微情報の開示承認',                 TRUE),
  (4, 'reviewer',          '審査担当', '登録内容のチェック（審査）',                         TRUE),
  (5, 'viewer',            '閲覧のみ', '閲覧のみ（機微情報はマスク表示）',                   TRUE)
ON CONFLICT (role_key) DO NOTHING;
-- 手動INSERT（id指定）は採番を進めないため、次の自動採番を最大値へ整える。
SELECT setval(pg_get_serial_sequence('roles', 'id'), GREATEST((SELECT MAX(id) FROM roles), 1));
UPDATE roles SET is_builtin = TRUE
 WHERE role_key IN ('admin', 'contract_operator', 'approver', 'reviewer', 'viewer');

-- ---------------------------------------------------------------------
-- 4) 権限（パーミッション）カタログ（画面14 + 操作20）
--    category='screen'：各画面の表示可否 / 'action'：登録・編集・消込・開示などの操作可否
-- ---------------------------------------------------------------------
INSERT INTO permissions (perm_key, perm_name, category, sort_order) VALUES
  ('screen.home',       'ホーム',                 'screen', 10),
  ('screen.contracts',  '契約',                   'screen', 20),
  ('screen.billing',    '請求・入金',             'screen', 30),
  ('screen.review',     '審査',                   'screen', 40),
  ('screen.companies',  '会社',                   'screen', 50),
  ('screen.persons',    '名義',                   'screen', 60),
  ('screen.accounts',   '口座・カード',           'screen', 70),
  ('screen.cti',        '電話・CTI',              'screen', 80),
  ('screen.litigation', '訴訟',                   'screen', 90),
  ('screen.files',      'ファイル',               'screen', 100),
  ('screen.originals',  '原本管理',               'screen', 110),
  ('screen.documents',  '差し込み印刷・作成履歴', 'screen', 120),
  ('screen.household',  '家計簿',                 'screen', 130),
  ('screen.admin',      '管理',                   'screen', 140),
  ('action.contract.create',   '契約：新規登録',                                     'action', 210),
  ('action.contract.update',   '契約：編集',                                         'action', 211),
  ('action.contract.delete',   '契約：削除',                                         'action', 212),
  ('action.contract.link',     '契約：関連付け（会社・名義・口座・外部番号・交渉履歴）', 'action', 213),
  ('action.company.manage',    '会社：登録・編集・削除',                             'action', 220),
  ('action.person.manage',     '名義：登録・編集・削除',                             'action', 221),
  ('action.account.manage',    '口座・カード：登録・編集・削除',                     'action', 222),
  ('action.billing.claim',     '請求：登録・編集・削除',                             'action', 230),
  ('action.billing.payment',   '入金：登録・編集・削除（消込）',                     'action', 231),
  ('action.review.approve',    '審査：承認',                                         'action', 240),
  ('action.review.reject',     '審査：差し戻し・否決',                               'action', 241),
  ('action.litigation.manage', '訴訟：登録・編集・削除',                             'action', 250),
  ('action.file.manage',       'ファイル：添付・編集・削除',                         'action', 260),
  ('action.original.manage',   '原本：登録・編集・削除',                             'action', 261),
  ('action.original.lend',     '原本：貸出・返却',                                   'action', 262),
  ('action.original.dispose',  '原本：廃棄',                                         'action', 263),
  ('action.document.template', '差し込み：テンプレート作成・編集・削除',             'action', 270),
  ('action.document.generate', '差し込み：印刷実行・作成履歴管理',                   'action', 271),
  ('action.household.manage',  '家計簿：登録・編集・削除',                           'action', 280),
  ('action.sensitive.reveal',  '機微情報：口座・カード番号の開示',                   'action', 290)
ON CONFLICT (perm_key) DO NOTHING;

-- ---------------------------------------------------------------------
-- 5) ロール → 権限（既定マッピング）
--    管理者は全権限。管理画面「ロール・権限」で各ロールの権限を自由に増減できる。
-- ---------------------------------------------------------------------
INSERT INTO role_permissions (role_id, perm_key)
SELECT r.id, p.perm_key
FROM roles r
JOIN permissions p ON (
      (r.role_key = 'admin')
   OR (r.role_key = 'contract_operator' AND p.perm_key IN (
        'screen.home','screen.contracts','screen.billing','screen.companies','screen.persons',
        'screen.accounts','screen.cti','screen.files','screen.originals','screen.documents',
        'action.contract.create','action.contract.update','action.contract.link',
        'action.company.manage','action.person.manage','action.account.manage',
        'action.billing.claim','action.billing.payment',
        'action.file.manage','action.original.manage','action.original.lend',
        'action.document.template','action.document.generate'))
   OR (r.role_key = 'approver' AND p.perm_key IN (
        'screen.home','screen.contracts','screen.review','screen.billing','screen.companies',
        'screen.persons','screen.accounts','screen.litigation','screen.documents',
        'action.review.approve','action.review.reject','action.sensitive.reveal'))
   OR (r.role_key = 'reviewer' AND p.perm_key IN (
        'screen.home','screen.contracts','screen.review','screen.companies','screen.persons',
        'screen.accounts','screen.files','screen.originals','screen.documents',
        'action.review.approve','action.review.reject'))
   OR (r.role_key = 'viewer' AND p.perm_key IN (
        'screen.home','screen.contracts','screen.billing','screen.review','screen.companies',
        'screen.persons','screen.accounts','screen.files','screen.originals','screen.documents',
        'screen.household'))
)
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------
-- 6) 着信アナウンス（ガイダンス）定義: 取り込み中・応答不可・離席中
--    音声ファイル名は初期値（管理画面で差し替え可能）。
-- ---------------------------------------------------------------------
INSERT INTO call_announcements (ann_key, label, file_name) VALUES
  ('busy',   '取り込み中ガイダンス',       'busy.wav'),
  ('dnd',    '通話中（応答不可）ガイダンス', 'dnd.wav'),
  ('unavail', '離席中ガイダンス',           'unavail.wav')
ON CONFLICT (ann_key) DO NOTHING;
