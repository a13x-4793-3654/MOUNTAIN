-- MOUNTAIN 初期データ（本番用）
-- 業務マスタ（コード区分・ロール・権限・権限割当・着信アナウンス定義）のみを収録し、
-- 架空のサンプル業務データ（会社・名義・契約・入金・電話履歴など）は一切含まない。
-- schema.sql 投入後に、DB初回作成時のみ自動実行される。
--
-- ※ 参照整合のため、内部処理で使う固定IDのシステム利用者2行だけを用意する。
--   （現行アプリは登録者/審査者に固定IDを用いるため。ログイン用アカウントではない）
SET client_encoding = 'UTF8';

-- ========== コードマスタ ==========
INSERT INTO code_masters (category, code, label, sort_order) VALUES
 ('contract_category','loan','融資契約',1),
 ('contract_category','lease','リース契約',2),
 ('contract_category','sales','売買契約',3),
 ('contract_category','service','役務契約',4),
 ('contract_status','active','有効',1),
 ('contract_status','delinquent','延滞',2),
 ('contract_status','litigation','訴訟中',3),
 ('contract_status','closed','完了',4),
 ('review_status','approved','承認済',1),
 ('review_status','pending','審査待ち',2),
 ('review_status','rejected','差戻',3),
 ('link_category','creditor','債権者',1),
 ('link_category','debtor','債務者',2),
 ('link_category','guarantor','保証人',3),
 ('link_category','agent','代理店',4),
 ('link_category','contractor','契約者',5),
 ('link_category','joint_guarantor','連帯保証人',6),
 ('link_category','withdrawal','引落口座',7),
 ('link_category','transfer','振込先',8),
 ('contract_flag','high_priority','重要',1),
 ('contract_flag','has_lawsuit','訴訟あり',2),
 ('contract_flag','watch','要注意',3),
 ('contract_flag','vip','VIP',4)
ON CONFLICT (category, code) DO NOTHING;

-- ========== システム利用者（参照整合用・ログイン不可の内部アカウント） ==========
-- 登録者/審査者などに内部的に使う固定IDのため、本番でも最小限だけ用意する。
-- 実際の利用者は Entra サインイン時に自動登録される（別レコード）。
INSERT INTO users (id, entra_object_id, display_name, user_principal_name, mail, status) VALUES
 ('00000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000001','システム','system@example.com',NULL,0),
 ('00000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-000000000002','システム（審査）','system-review@example.com',NULL,0)
ON CONFLICT (id) DO NOTHING;

-- ========== ロール（RBAC）==========
-- Entra のセキュリティグループに紐づけ、サインイン時に自動付与するロール。
INSERT INTO roles (id, role_key, role_name, description, is_builtin) VALUES
 (1,'admin','管理者','すべての操作／ユーザー・区分・監査ログの管理',TRUE),
 (2,'contract_operator','契約担当','契約の登録・編集・入金消込（機微情報は要承認）',TRUE),
 (3,'approver','承認者','新規登録の審査／機微情報の開示承認',TRUE),
 (4,'reviewer','審査担当','登録内容のチェック（審査）',TRUE),
 (5,'viewer','閲覧のみ','閲覧のみ（機微情報はマスク表示）',TRUE)
ON CONFLICT (role_key) DO NOTHING;
SELECT setval(pg_get_serial_sequence('roles','id'), GREATEST((SELECT MAX(id) FROM roles), 1));

-- ========== 権限（パーミッション）カタログ ==========
-- category='screen'：各画面（左メニュー）の表示可否 / 'action'：登録・編集・消込・開示などの操作可否
INSERT INTO permissions (perm_key, perm_name, category, sort_order) VALUES
 ('screen.home','ホーム','screen',10),
 ('screen.contracts','契約','screen',20),
 ('screen.billing','請求・入金','screen',30),
 ('screen.review','審査','screen',40),
 ('screen.companies','会社','screen',50),
 ('screen.persons','名義','screen',60),
 ('screen.accounts','口座・カード','screen',70),
 ('screen.cti','電話・CTI','screen',80),
 ('screen.litigation','訴訟','screen',90),
 ('screen.files','ファイル','screen',100),
 ('screen.originals','原本管理','screen',110),
 ('screen.documents','差し込み印刷・作成履歴','screen',120),
 ('screen.household','家計簿','screen',130),
 ('screen.admin','管理','screen',140),
 -- 操作権限（action）：画面ごと・操作の種類ごとに細かく割り当てられる
 ('action.contract.create','契約：新規登録','action',210),
 ('action.contract.update','契約：編集','action',211),
 ('action.contract.delete','契約：削除','action',212),
 ('action.contract.link','契約：関連付け（会社・名義・口座・外部番号・交渉履歴）','action',213),
 ('action.company.manage','会社：登録・編集・削除','action',220),
 ('action.person.manage','名義：登録・編集・削除','action',221),
 ('action.account.manage','口座・カード：登録・編集・削除','action',222),
 ('action.billing.claim','請求：登録・編集・削除','action',230),
 ('action.billing.payment','入金：登録・編集・削除（消込）','action',231),
 ('action.review.approve','審査：承認','action',240),
 ('action.review.reject','審査：差し戻し・否決','action',241),
 ('action.litigation.manage','訴訟：登録・編集・削除','action',250),
 ('action.file.manage','ファイル：添付・編集・削除','action',260),
 ('action.original.manage','原本：登録・編集・削除','action',261),
 ('action.original.lend','原本：貸出・返却','action',262),
 ('action.original.dispose','原本：廃棄','action',263),
 ('action.document.template','差し込み：テンプレート作成・編集・削除','action',270),
 ('action.document.generate','差し込み：印刷実行・作成履歴管理','action',271),
 ('action.household.manage','家計簿：登録・編集・削除','action',280),
 ('action.sensitive.reveal','機微情報：口座・カード番号の開示','action',290)
ON CONFLICT (perm_key) DO NOTHING;

-- ========== ロール → 権限（既定）==========
-- 管理者は全権限。管理画面「ロール・権限」で各ロールの権限を自由に増減できる。
INSERT INTO role_permissions (role_id, perm_key)
SELECT r.id, p.perm_key
FROM roles r
JOIN permissions p ON (
      -- 管理者：すべての権限
      (r.role_key = 'admin')
      -- 契約担当：契約まわりの画面＋契約・取引先・請求入金・ファイル・原本・差し込みの操作
   OR (r.role_key = 'contract_operator' AND p.perm_key IN (
        'screen.home','screen.contracts','screen.billing','screen.companies','screen.persons',
        'screen.accounts','screen.cti','screen.files','screen.originals','screen.documents',
        'action.contract.create','action.contract.update','action.contract.link',
        'action.company.manage','action.person.manage','action.account.manage',
        'action.billing.claim','action.billing.payment',
        'action.file.manage','action.original.manage','action.original.lend',
        'action.document.template','action.document.generate'))
      -- 承認者：審査（承認・差し戻し）＋機微情報の開示
   OR (r.role_key = 'approver' AND p.perm_key IN (
        'screen.home','screen.contracts','screen.review','screen.billing','screen.companies',
        'screen.persons','screen.accounts','screen.litigation','screen.documents',
        'action.review.approve','action.review.reject','action.sensitive.reveal'))
      -- 審査担当：審査画面の閲覧＋審査の実施（承認・差し戻し）
   OR (r.role_key = 'reviewer' AND p.perm_key IN (
        'screen.home','screen.contracts','screen.review','screen.companies','screen.persons',
        'screen.accounts','screen.files','screen.originals','screen.documents',
        'action.review.approve','action.review.reject'))
      -- 閲覧のみ：管理・電話・訴訟を除く画面の閲覧（操作権限なし）
   OR (r.role_key = 'viewer' AND p.perm_key IN (
        'screen.home','screen.contracts','screen.billing','screen.review','screen.companies',
        'screen.persons','screen.accounts','screen.files','screen.originals','screen.documents',
        'screen.household'))
)
ON CONFLICT DO NOTHING;

-- ========== 着信アナウンス（call_announcements） ==========
INSERT INTO call_announcements (ann_key, label, file_name) VALUES
 ('busy','取り込み中ガイダンス','busy.wav'),
 ('dnd','通話中（応答不可）ガイダンス','dnd.wav'),
 ('unavail','離席中ガイダンス','unavail.wav')
;
