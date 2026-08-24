# MOUNTAIN Excel 精査結果（モックの動作 × DB/仕様の過不足）2026-07-10

## 前提
- 最新版は v5（DB設計266行・DDL561行・ER56行・画面一覧あり）。
- v4 は旧版（DB設計247行・画面一覧/機微情報テーブル未反映）＝ユーザーが開いている版。
- 会社/名義/口座の複数紐付けは中間テーブルで対応済み：
  contract_company_links / contract_person_links / contract_account_links。

## 不足（モックがやっているのに設計に無い動作）
1. 契約番号：contracts に契約番号カラム無し（証券/顧客番号は contract_identifiers に複数）。→Q47
2. 元本（契約金額）：DBに元本カラム無し（"元本"は全シート0件。principalはUPNのみ）。→Q48
3. 名義→所属会社：persons に company_id 無し（名義は契約経由でのみ会社と関連）。→Q49
4. 口座→名義：accounts に person_id 無し（account_holder_kana の文字列のみ）。→Q50
5. 編集ロック：Q17=C を選択済みだが lock/排他テーブル無し・contracts に版数無し
   （version_no は claims の楽観ロックのみ）。→Q51
6. 審査履歴：審査履歴/approval テーブル無し（review_status 上書きのみ）。Q18で承認履歴に言及。→Q52

## 過剰（二重管理・仕様と食い違い）
7. claims.remaining_balance（保存列）と v_contract_balance（計算VIEW）が二重。
   Q43で自動計算に決定済み → 計算に一本化が妥当。→Q53
8. やり取り履歴の発信元/先：DBは from/to company/person 対応済みだが、モックの入力が種別+要約中心。→モック側修正（設計変更不要）
9. 契約一覧の列：Q39=状態・カテゴリ・会社名・名義。モックが残額等を出すなら好みの範囲。→モック側

## 追記する質問（AI質問シート末尾 / IT用語なし / 回答欄は空）
Q47 契約番号の持ち方
Q48 元本（契約金額）の欄
Q49 名義と会社のつながり
Q50 口座・カードの持ち主（名義の紐付け）
Q51 編集ロックの自動解除時間
Q52 審査（承認/差戻し）履歴の表
Q53 残債を計算に一本化してよいか
