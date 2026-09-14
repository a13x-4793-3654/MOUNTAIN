// MOUNTAIN API クライアント（同一オリジンの /api を呼ぶ。開発時は Vite プロキシ経由）
import { acquireApiToken } from "../auth/token";

// 認証が有効ならアクセストークンを Authorization ヘッダに付与する。
async function authHeaders(
  base: Record<string, string>
): Promise<Record<string, string>> {
  const token = await acquireApiToken();
  return token ? { ...base, Authorization: `Bearer ${token}` } : base;
}

export interface ContractListItem {
  id: string;
  contract_no: string;
  contract_summary: string;
  contract_category: string;
  contract_status: string;
  review_status: string;
  started_at: string | null;
  ended_at: string | null;
  category_label: string | null;
  status_label: string | null;
  review_label: string | null;
  company_name: string | null;
  person_name: string | null;
  assignee_name: string | null;
}

export interface ContractListResponse {
  total: number;
  items: ContractListItem[];
}

export interface MasterItem {
  code: string;
  label: string;
}

export interface LinkedCompany {
  id: string;
  link_id?: number;
  company_name: string;
  company_name_kana: string | null;
  prefecture: string | null;
  city: string | null;
  address1: string | null;
  link_category: string | null;
  link_label: string | null;
  phone: string | null;
}

export interface LinkedPerson {
  id: string;
  link_id?: number;
  full_name: string;
  full_name_kana: string | null;
  prefecture: string | null;
  city: string | null;
  address1: string | null;
  link_category: string | null;
  link_label: string | null;
}

export interface LinkedAccount {
  id: string;
  link_id?: number;
  account_category: string;
  account_type: string;
  bank_name: string | null;
  branch_name: string | null;
  account_no_masked: string | null;
  account_holder_kana: string | null;
  expiry_mm_yy: string | null;
  link_category: string | null;
  link_label: string | null;
  is_default: boolean | null;
}

export interface ContractIdentifier {
  id?: number;
  identifier_type: string;
  identifier_type_label?: string | null;
  identifier_value: string;
  is_primary: boolean | null;
}

export interface ContractFlag {
  flag_code: string;
  label: string;
}

export interface CalendarRegistration {
  status: "pending" | "created" | "failed";
  calendar_name: string;
  starts_at: string;
  ends_at: string;
  error: string | null;
}

export interface Communication {
  id: string;
  occurred_at: string | null;
  channel: string | null;
  direction: string | null;
  summary: string;
  details: string | null;
  calendar: CalendarRegistration | null;
}

export interface Claim {
  id: string;
  claim_category: string | null;
  occurred_on: string | null;
  claim_total_amount: number | string | null;
  remaining_balance?: number | string | null;
  paid_amount?: number | string | null;
  due_at: string | null;
  status: string | null;
  methods?: string[];
}

export interface Payment {
  id: string;
  received_at: string | null;
  amount: number | string | null;
  received_method: string | null;
  source_type: string | null;
  receipt_type: string | null;
  has_receipt: boolean | null;
  allocated_amount?: number | string | null;
  alloc_status?: string | null;
}

export interface Lawsuit {
  id: string;
  proc_type: string | null;
  case_name: string | null;
  case_number: string | null;
  court_name: string | null;
  our_side_role: string | null;
  status: string | null;
  claim_amount: number | string | null;
  filed_or_received_on: string | null;
  demand: string | null;
}

export interface ContractFile {
  id: string;
  file_name: string;
  content_type: string | null;
  file_size_bytes: number | string | null;
  tag_text: string | null;
  is_password_protected: boolean | null;
  created_at: string | null;
  has_content?: boolean;
}

export interface ContractDetail {
  contract: Record<string, any>;
  companies: LinkedCompany[];
  persons: LinkedPerson[];
  accounts: LinkedAccount[];
  identifiers: ContractIdentifier[];
  flags: ContractFlag[];
  communications: Communication[];
  claims: Claim[];
  payments: Payment[];
  lawsuits: Lawsuit[];
  files: ContractFile[];
}

export async function getJson<T>(url: string): Promise<T> {
  const headers = await authHeaders({ Accept: "application/json" });
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`API ${res.status}: ${url}`);
  }
  return (await res.json()) as T;
}

export class ApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

export async function sendJson<T>(
  method: "POST" | "PUT" | "DELETE",
  url: string,
  body?: unknown
): Promise<T> {
  const headers = await authHeaders({
    "Content-Type": "application/json",
    Accept: "application/json",
  });
  const res = await fetch(url, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = `API ${res.status}`;
    try {
      const j = await res.json();
      if (j?.detail) msg = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail);
    } catch {
      /* ignore */
    }
    throw new ApiError(msg, res.status);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export function fetchContracts(params: {
  q?: string;
  status?: string;
  category?: string;
}): Promise<ContractListResponse> {
  const usp = new URLSearchParams();
  if (params.q) usp.set("q", params.q);
  if (params.status) usp.set("status", params.status);
  if (params.category) usp.set("category", params.category);
  const qs = usp.toString();
  return getJson<ContractListResponse>(`/api/contracts${qs ? `?${qs}` : ""}`);
}

/** 認証付きで Blob を取得し、ブラウザのダウンロードを起動する。 */
async function downloadBlob(url: string, fallbackName: string): Promise<void> {
  const headers = await authHeaders({});
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`API ${res.status}`);
  const blob = await res.blob();
  const cd = res.headers.get("Content-Disposition") || "";
  // filename*=UTF-8''<encoded>（日本語対応）を優先し、無ければ filename="..." を使う。
  let name = fallbackName;
  const mStar = cd.match(/filename\*=UTF-8''([^;]+)/i);
  const mPlain = cd.match(/filename="?([^";]+)"?/i);
  if (mStar) name = decodeURIComponent(mStar[1]);
  else if (mPlain) name = decodeURIComponent(mPlain[1]);
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(href);
}

/** 契約一覧を CSV でダウンロード（画面の絞り込みに連動）。 */
export async function downloadContractsCsv(params: {
  q?: string;
  status?: string;
  category?: string;
}): Promise<void> {
  const usp = new URLSearchParams();
  if (params.q) usp.set("q", params.q);
  if (params.status) usp.set("status", params.status);
  if (params.category) usp.set("category", params.category);
  const qs = usp.toString();
  await downloadBlob(`/api/contracts.csv${qs ? `?${qs}` : ""}`, "contracts.csv");
}

// ====================== 差し込み印刷：文書テンプレート ======================
export interface DocField {
  token: string;
  label: string;
  link: string;
  entity: string | null;
  source: string | null;
  restrict: string;
  maxlen: number;
  free_input: boolean;
  known: boolean;
}

export interface DocTemplateListItem {
  id: string;
  name: string;
  description: string | null;
  file_name: string;
  is_active: boolean;
  created_at: string | null;
  created_by_name: string | null;
  field_count: number;
  generated_count: number;
}

export interface DocTemplateDetail {
  id: string;
  name: string;
  description: string | null;
  file_name: string;
  is_active: boolean;
  created_at: string | null;
  updated_at: string | null;
  created_by_name: string | null;
  fields: DocField[];
  field_count: number;
  unknown_count: number;
}

export interface DocTemplateUploadResult {
  id: string;
  name: string;
  file_name: string;
  field_count: number;
  unknown_count: number;
  fields: DocField[];
}

export interface DocMergeCatalogField {
  entity: string;
  entity_label: string;
  field: string;
  link: string;
  label: string;
  restrict: string;
}

export interface DocMergeCatalog {
  entities: { key: string; label: string }[];
  restricts: { key: string; label: string }[];
  fields: DocMergeCatalogField[];
}

export function fetchDocMergeCatalog(): Promise<DocMergeCatalog> {
  return getJson<DocMergeCatalog>("/api/doc-merge/catalog");
}

export function fetchDocTemplates(): Promise<{ items: DocTemplateListItem[] }> {
  return getJson<{ items: DocTemplateListItem[] }>("/api/doc-templates");
}

export function fetchDocTemplate(id: string): Promise<DocTemplateDetail> {
  return getJson<DocTemplateDetail>(`/api/doc-templates/${id}`);
}

/** Word(.docx) / Excel(.xlsx) テンプレートをアップロード（multipart）。差し込み項目を解析して返す。 */
export async function uploadDocTemplate(
  file: File,
  name: string,
  description: string
): Promise<DocTemplateUploadResult> {
  // FormData では Content-Type をブラウザに任せる（boundary 付与のため手動設定しない）。
  const headers = await authHeaders({ Accept: "application/json" });
  const fd = new FormData();
  fd.append("file", file);
  fd.append("name", name);
  fd.append("description", description);
  const res = await fetch("/api/doc-templates", { method: "POST", headers, body: fd });
  if (!res.ok) {
    let msg = `API ${res.status}`;
    try {
      const j = await res.json();
      if (j?.detail) msg = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail);
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return (await res.json()) as DocTemplateUploadResult;
}

export function updateDocTemplate(
  id: string,
  body: { name: string; description: string | null; is_active: boolean }
): Promise<{ ok: boolean }> {
  return sendJson<{ ok: boolean }>("PUT", `/api/doc-templates/${id}`, body);
}

export function deleteDocTemplate(id: string): Promise<{ ok: boolean }> {
  return sendJson<{ ok: boolean }>("DELETE", `/api/doc-templates/${id}`);
}

/** テンプレートの元ファイル（Word / Excel）をダウンロード。 */
export async function downloadDocTemplateFile(id: string, fallbackName: string): Promise<void> {
  await downloadBlob(`/api/doc-templates/${id}/file`, fallbackName);
}

// ====================== 差し込み印刷：差し込み（生成） ======================
export interface DocResolveResult {
  values: Record<string, string>;
  selection: {
    contract_id: string | null;
    company_id: string | null;
    person_id: string | null;
    account_id: string | null;
  };
  labels: {
    contract: string | null;
    company: string | null;
    person: string | null;
    account: string | null;
  };
}

export interface DocMergeSelection {
  contract_id?: string | null;
  company_id?: string | null;
  person_id?: string | null;
  account_id?: string | null;
}

/** 選択レコードから各差し込み項目の値を引き当てる。 */
export function resolveDocMerge(
  templateId: string,
  selection: DocMergeSelection
): Promise<DocResolveResult> {
  return sendJson<DocResolveResult>("POST", "/api/doc-merge/resolve", {
    template_id: templateId,
    ...selection,
  });
}

export interface DocGenerateResult {
  id: string;
  title: string;
  pdf_size: number;
}

/** 差し込み値から PDF を生成して保存する。 */
export function generateDocument(body: {
  template_id: string;
  title?: string;
  values: Record<string, string>;
  selection?: DocMergeSelection;
}): Promise<DocGenerateResult> {
  return sendJson<DocGenerateResult>("POST", "/api/doc-merge/generate", body);
}

// ====================== 差し込み印刷：作成履歴 ======================
export interface DocGeneratedListItem {
  id: string;
  title: string;
  pdf_size: number | null;
  created_at: string | null;
  template_id: string;
  template_name: string | null;
  created_by_name: string | null;
}

export interface DocGeneratedDetail {
  id: string;
  title: string;
  pdf_size: number | null;
  created_at: string | null;
  updated_at: string | null;
  template_id: string;
  template_name: string | null;
  template_active: boolean | null;
  created_by_name: string | null;
  inputs: {
    values?: Record<string, string>;
    selection?: DocMergeSelection;
    fields?: DocField[];
    template_name?: string;
  };
}

export function fetchGeneratedDocs(): Promise<{ items: DocGeneratedListItem[] }> {
  return getJson<{ items: DocGeneratedListItem[] }>("/api/doc-generated");
}

export function fetchGeneratedDoc(id: string): Promise<DocGeneratedDetail> {
  return getJson<DocGeneratedDetail>(`/api/doc-generated/${id}`);
}

export async function downloadGeneratedPdf(id: string, fallbackName: string): Promise<void> {
  await downloadBlob(`/api/doc-generated/${id}/pdf`, fallbackName);
}

export function regenerateDocument(
  id: string,
  body: { title?: string; values: Record<string, string>; selection?: DocMergeSelection }
): Promise<DocGenerateResult> {
  return sendJson<DocGenerateResult>("PUT", `/api/doc-generated/${id}`, body);
}

export function deleteGeneratedDoc(id: string): Promise<{ ok: boolean }> {
  return sendJson<{ ok: boolean }>("DELETE", `/api/doc-generated/${id}`);
}

export function fetchContract(id: string): Promise<ContractDetail> {
  return getJson<ContractDetail>(`/api/contracts/${id}`);
}

export function fetchMaster(category: string): Promise<MasterItem[]> {
  return getJson<MasterItem[]>(`/api/masters/${category}`);
}

// ===== 会社（台帳） =====
export interface CompanyListItem {
  id: string;
  company_name: string;
  company_name_kana: string | null;
  prefecture: string | null;
  city: string | null;
  status_flag: number | null;
  phone: string | null;
  contract_count: number | string | null;
}

export interface LinkedContract {
  id: string;
  contract_no: string;
  contract_summary: string | null;
  contract_status: string | null;
  status_label: string | null;
  link_category: string | null;
  link_label: string | null;
  is_default?: boolean | null;
}

export interface CompanyPhone {
  id: number;
  phone_number: string;
  phone_type: string | null;
  is_primary: boolean | null;
  note: string | null;
}

export interface CompanyDetail {
  company: Record<string, any>;
  phones: CompanyPhone[];
  contracts: LinkedContract[];
}

export function fetchCompanies(params: {
  q?: string;
  status?: string;
  limit?: number;
  offset?: number;
}): Promise<{ total: number; items: CompanyListItem[] }> {
  const usp = new URLSearchParams();
  if (params.q) usp.set("q", params.q);
  if (params.status) usp.set("status", params.status);
  if (params.limit != null) usp.set("limit", String(params.limit));
  if (params.offset != null) usp.set("offset", String(params.offset));
  const qs = usp.toString();
  return getJson(`/api/companies${qs ? `?${qs}` : ""}`);
}

export function fetchCompany(id: string): Promise<CompanyDetail> {
  return getJson<CompanyDetail>(`/api/companies/${id}`);
}

// ===== 名義（台帳） =====
export interface PersonListItem {
  id: string;
  full_name: string;
  full_name_kana: string | null;
  birth_date: string | null;
  prefecture: string | null;
  city: string | null;
  contract_count: number | string | null;
}

export interface PersonDetail {
  person: Record<string, any>;
  contracts: LinkedContract[];
}

export function fetchPersons(params: {
  q?: string;
  limit?: number;
  offset?: number;
}): Promise<{ total: number; items: PersonListItem[] }> {
  const usp = new URLSearchParams();
  if (params.q) usp.set("q", params.q);
  if (params.limit != null) usp.set("limit", String(params.limit));
  if (params.offset != null) usp.set("offset", String(params.offset));
  const qs = usp.toString();
  return getJson(`/api/persons${qs ? `?${qs}` : ""}`);
}

export function fetchPerson(id: string): Promise<PersonDetail> {
  return getJson<PersonDetail>(`/api/persons/${id}`);
}

// ===== 口座・カード（台帳） =====
export interface AccountListItem {
  id: string;
  account_category: string;
  account_type: string;
  account_role: string | null;
  bank_name: string | null;
  branch_name: string | null;
  account_no_masked: string | null;
  account_holder_kana: string | null;
  expiry_mm_yy: string | null;
  is_active: boolean | null;
  contract_count: number | string | null;
}

export interface AccountDetail {
  account: Record<string, any>;
  contracts: LinkedContract[];
}

export function fetchAccounts(params: {
  q?: string;
  category?: string;
  limit?: number;
  offset?: number;
}): Promise<{ total: number; items: AccountListItem[] }> {
  const usp = new URLSearchParams();
  if (params.q) usp.set("q", params.q);
  if (params.category) usp.set("category", params.category);
  if (params.limit != null) usp.set("limit", String(params.limit));
  if (params.offset != null) usp.set("offset", String(params.offset));
  const qs = usp.toString();
  return getJson(`/api/accounts${qs ? `?${qs}` : ""}`);
}

export function fetchAccount(id: string): Promise<AccountDetail> {
  return getJson<AccountDetail>(`/api/accounts/${id}`);
}

// ===== 電話・CTI（通話履歴） =====
export interface CallListItem {
  id: string;
  call_id: string;
  direction: string;
  from_number: string | null;
  to_number: string | null;
  started_at: string | null;
  duration_seconds: number | null;
  call_result: string | null;
  has_recording: boolean | null;
  contract_id: string | null;
  contract_no: string | null;
  operator_name: string | null;
}

export interface CallOperation {
  seq_no: number;
  offset_seconds: number;
  operation_type: string;
  detail: string | null;
  operated_at: string | null;
  operated_by_name: string | null;
}

export interface CallDetail {
  call: Record<string, any>;
  operations: CallOperation[];
}

export function fetchCalls(params: {
  q?: string;
  direction?: string;
  result?: string;
}): Promise<{ total: number; items: CallListItem[] }> {
  const usp = new URLSearchParams();
  if (params.q) usp.set("q", params.q);
  if (params.direction) usp.set("direction", params.direction);
  if (params.result) usp.set("result", params.result);
  const qs = usp.toString();
  return getJson(`/api/calls${qs ? `?${qs}` : ""}`);
}

export function fetchCall(id: string): Promise<CallDetail> {
  return getJson<CallDetail>(`/api/calls/${id}`);
}

// ===== 電話・CTI（発信・在席・留守電・アナウンス） =====
export interface PbxPushResult {
  state: "ok" | "skipped" | "error";
  reason?: string;
  detail?: string;
}

export interface Presence {
  status: string;
  label: string;
  pbx?: PbxPushResult;
}

export interface ActiveCall {
  id: string;
  call_id: string;
  direction: string;
  number: string | null;
  contact_name: string | null;
  contract_id: string | null;
  contract_no: string | null;
  status: string;
  is_connected: boolean;
  is_incoming?: boolean;
  is_on_hold: boolean;
  elapsed_seconds: number;
  state_label: string;
  provider: string;
}

export interface CtiContact {
  name: string;
  number: string;
  label: string | null;
  is_primary: boolean | null;
  is_blocked: boolean | null;
}

export interface Voicemail {
  id: string;
  from_number: string | null;
  contact_name: string | null;
  received_at: string | null;
  duration_seconds: number | null;
  mailbox: string;
  is_heard: boolean;
  recording_file: string | null;
  contract_id: string | null;
  contract_no: string | null;
}

export interface Announcement {
  ann_key: string;
  label: string;
  file_name: string | null;
  updated_at: string | null;
}

export function fetchPresence(): Promise<Presence> {
  return getJson<Presence>(`/api/cti/presence`);
}
export function setPresence(status: string): Promise<Presence> {
  return sendJson<Presence>("PUT", `/api/cti/presence`, { status });
}
export function fetchActiveCall(): Promise<{ active: ActiveCall | null }> {
  return getJson<{ active: ActiveCall | null }>(`/api/cti/active`);
}
export function fetchCtiContacts(): Promise<{ items: CtiContact[] }> {
  return getJson<{ items: CtiContact[] }>(`/api/cti/contacts`);
}
export function originateCall(body: {
  number: string;
  contact_name?: string | null;
  contract_id?: string | null;
}): Promise<ActiveCall> {
  return sendJson<ActiveCall>("POST", `/api/cti/originate`, body);
}
export function holdCall(id: string): Promise<ActiveCall> {
  return sendJson<ActiveCall>("POST", `/api/cti/calls/${id}/hold`);
}
export function unholdCall(id: string): Promise<ActiveCall> {
  return sendJson<ActiveCall>("POST", `/api/cti/calls/${id}/unhold`);
}
export function dtmfCall(id: string, digit: string): Promise<ActiveCall> {
  return sendJson<ActiveCall>("POST", `/api/cti/calls/${id}/dtmf`, { digit });
}
export function transferCall(id: string, destination: string): Promise<{ ended: boolean }> {
  return sendJson<{ ended: boolean }>("POST", `/api/cti/calls/${id}/transfer`, { destination });
}
export function hangupCall(id: string): Promise<{ ended: boolean }> {
  return sendJson<{ ended: boolean }>("POST", `/api/cti/calls/${id}/hangup`);
}
export function answerCall(id: string): Promise<ActiveCall> {
  return sendJson<ActiveCall>("POST", `/api/cti/calls/${id}/answer`);
}
export function simulateIncoming(body?: {
  number?: string;
  contact_name?: string;
  contract_id?: string;
}): Promise<ActiveCall> {
  return sendJson<ActiveCall>("POST", `/api/cti/simulate-incoming`, body ?? {});
}
export function fetchVoicemails(): Promise<{ items: Voicemail[] }> {
  return getJson<{ items: Voicemail[] }>(`/api/cti/voicemails`);
}
export function markVoicemailHeard(id: string): Promise<{ ok: boolean }> {
  return sendJson<{ ok: boolean }>("POST", `/api/cti/voicemails/${id}/heard`);
}
export function deleteVoicemail(id: string): Promise<void> {
  return sendJson<void>("DELETE", `/api/cti/voicemails/${id}`);
}
export function fetchAnnouncements(): Promise<{ items: Announcement[] }> {
  return getJson<{ items: Announcement[] }>(`/api/cti/announcements`);
}
export function updateAnnouncement(
  key: string,
  body: { file_name: string; label?: string }
): Promise<{ ok: boolean }> {
  return sendJson<{ ok: boolean }>("PUT", `/api/cti/announcements/${key}`, body);
}
export async function uploadAnnouncementAudio(
  key: string,
  file: File
): Promise<{ ok: boolean; file_name: string; pbx: PbxPushResult }> {
  // FormData では Content-Type をブラウザに任せる（boundary 付与のため手動設定しない）。
  const headers = await authHeaders({ Accept: "application/json" });
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch(`/api/cti/announcements/${key}/audio`, {
    method: "POST",
    headers,
    body: fd,
  });
  if (!res.ok) {
    let msg = `API ${res.status}`;
    try {
      const j = await res.json();
      if (j?.detail) msg = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail);
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return (await res.json()) as { ok: boolean; file_name: string; pbx: PbxPushResult };
}

// ===== ソフトフォン：発信元照会（スクリーンポップ） =====
export interface LookupMatch {
  kind: string;
  company_id: string;
  name: string;
  contract_id: string | null;
  contract_no: string | null;
}
export interface LookupResult {
  number: string;
  normalized: string;
  is_blocked: boolean;
  matches: LookupMatch[];
}
export function lookupNumber(number: string): Promise<LookupResult> {
  return getJson<LookupResult>(
    `/api/cti/lookup?number=${encodeURIComponent(number)}`
  );
}

// ===== ホーム（ダッシュボード） =====
export interface DashboardKpis {
  contracts_total: number;
  contracts_delinquent: number;
  contracts_litigation: number;
  contracts_active: number;
  reviews_pending: number;
  overdue_count: number;
  overdue_amount: number | string;
  lawsuits_active: number;
  calls_missed: number;
}

export interface DashboardTask {
  kind: string;
  severity: string;
  title: string;
  detail: string;
  due_at?: string | null;
  occurred_at?: string | null;
  to: string;
}

export interface DashboardRecent {
  kind: string;
  occurred_at: string | null;
  title: string;
  detail: string;
  to: string;
}

export interface DashboardData {
  kpis: DashboardKpis;
  tasks: DashboardTask[];
  recent: DashboardRecent[];
}

export function fetchDashboard(): Promise<DashboardData> {
  return getJson<DashboardData>(`/api/dashboard`);
}

// ===== 請求・入金（billing） =====
export interface BillingClaim {
  id: string;
  contract_id: string;
  contract_no: string;
  claim_category: string | null;
  occurred_on: string | null;
  claim_total_amount: number | string | null;
  remaining_balance?: number | string | null;
  paid_amount?: number | string | null;
  due_at: string | null;
  status: string | null;
  company_name: string | null;
  methods?: string[];
}
export interface BillingPayment {
  id: string;
  contract_id: string;
  contract_no: string;
  received_at: string | null;
  amount: number | string | null;
  received_method: string | null;
  source_type: string | null;
  receipt_type: string | null;
  has_receipt: boolean | null;
  allocated_amount?: number | string | null;
  alloc_status?: string | null;
  company_name: string | null;
}
export interface BillingData {
  kpis: Record<string, number | string>;
  claims: BillingClaim[];
  payments: BillingPayment[];
}
export function fetchBilling(params: { q?: string; status?: string }): Promise<BillingData> {
  const usp = new URLSearchParams();
  if (params.q) usp.set("q", params.q);
  if (params.status) usp.set("status", params.status);
  const qs = usp.toString();
  return getJson<BillingData>(`/api/billing${qs ? `?${qs}` : ""}`);
}

// ===== 審査（review） =====
export interface ReviewPending {
  id: string;
  contract_no: string;
  contract_summary: string;
  contract_category: string | null;
  category_label: string | null;
  created_at: string | null;
  review_reason: string | null;
  assignee_name: string | null;
  company_name: string | null;
  person_name: string | null;
  similar_count: number;
}
export interface SimilarContract {
  id: string;
  contract_no: string;
  contract_summary: string | null;
  category_label: string | null;
  status_label: string | null;
  review_label: string | null;
  review_status: string | null;
  created_at: string | null;
  company_name: string | null;
  person_name: string | null;
  same_company: boolean;
  same_person: boolean;
  same_identifier: boolean;
  reasons: string[];
}
export interface SimilarResult {
  base: {
    contract_no: string;
    contract_summary: string | null;
    company_name: string | null;
    person_name: string | null;
  };
  items: SimilarContract[];
}
export function fetchSimilarContracts(contractId: string): Promise<SimilarResult> {
  return getJson<SimilarResult>(`/api/reviews/${contractId}/similar`);
}
export interface ReviewHistory {
  id: number;
  contract_id: string;
  contract_no: string;
  action: string;
  comment: string | null;
  created_at: string | null;
  actor_name: string | null;
}
export interface ReviewData {
  pending: ReviewPending[];
  history: ReviewHistory[];
}
export function fetchReviews(): Promise<ReviewData> {
  return getJson<ReviewData>(`/api/reviews`);
}
export interface ReviewDetail {
  id: string;
  contract_no: string;
  contract_summary: string;
  contract_category: string | null;
  category_label: string | null;
  created_at: string | null;
  review_reason: string | null;
  review_status: string | null;
  review_label: string | null;
  assignee_name: string | null;
  company_name: string | null;
  person_name: string | null;
  similar_count: number;
}
export function fetchReviewDetail(contractId: string): Promise<ReviewDetail> {
  return getJson<ReviewDetail>(`/api/reviews/${contractId}`);
}

// ===== 訴訟（litigation） =====
export interface LawsuitListItem {
  id: string;
  contract_id: string;
  contract_no: string;
  proc_type: string | null;
  case_name: string | null;
  case_number: string | null;
  court_name: string | null;
  our_side_role: string | null;
  status: string | null;
  claim_amount: number | string | null;
  filed_or_received_on: string | null;
  opponent_name: string | null;
  next_schedule_at: string | null;
  next_schedule_type: string | null;
}
export interface LawsuitParty {
  id?: number;
  party_role: string;
  display_name_snapshot: string | null;
  agent_note: string | null;
  company_id?: string | null;
  person_id?: string | null;
}
export interface LawsuitSchedule {
  id?: number;
  schedule_type: string;
  scheduled_at: string | null;
  place: string | null;
  attendee: string | null;
  result: string | null;
  completed_at: string | null;
}
export interface LawsuitDocument {
  id?: number;
  doc_name: string;
  side: string | null;
  due_on: string | null;
  filed_on: string | null;
  state: string | null;
}
export interface LawsuitMemo {
  id?: number;
  memo_on: string;
  note: string;
}
export interface LawsuitDetail {
  lawsuit: Record<string, any>;
  parties: LawsuitParty[];
  schedules: LawsuitSchedule[];
  documents: LawsuitDocument[];
  memos: LawsuitMemo[];
}
export function fetchLawsuits(params: { q?: string; status?: string }): Promise<{ total: number; items: LawsuitListItem[] }> {
  const usp = new URLSearchParams();
  if (params.q) usp.set("q", params.q);
  if (params.status) usp.set("status", params.status);
  const qs = usp.toString();
  return getJson(`/api/lawsuits${qs ? `?${qs}` : ""}`);
}
export function fetchLawsuit(id: string): Promise<LawsuitDetail> {
  return getJson<LawsuitDetail>(`/api/lawsuits/${id}`);
}

// ---- 訴訟の書き込み（Wave B）----
export interface LawsuitIn {
  proc_type: string;
  case_number: string;
  court_name: string;
  status: string;
  our_side_role?: string | null;
  case_name?: string | null;
  court_clerk?: string | null;
  our_lawyer?: string | null;
  claim_amount?: number | null;
  suit_value?: number | null;
  filed_or_received_on?: string | null;
  demand?: string | null;
  cause?: string | null;
}
export interface PartyIn {
  party_role: string;
  company_id?: string | null;
  person_id?: string | null;
  agent_note?: string | null;
}
export interface ScheduleIn {
  schedule_type: string;
  scheduled_at: string;
  place?: string | null;
  attendee?: string | null;
  result?: string | null;
}
export interface DocumentIn {
  doc_name: string;
  side: string;
  due_on?: string | null;
  filed_on?: string | null;
  state?: string | null;
}
export interface MemoIn {
  memo_on: string;
  note: string;
}
export function createLawsuit(contractId: string, body: LawsuitIn): Promise<{ id: string }> {
  return sendJson("POST", `/api/contracts/${contractId}/lawsuits`, body);
}
export function updateLawsuit(id: string, body: LawsuitIn): Promise<{ ok: boolean }> {
  return sendJson("PUT", `/api/lawsuits/${id}`, body);
}
export function deleteLawsuit(id: string): Promise<{ ok: boolean }> {
  return sendJson("DELETE", `/api/lawsuits/${id}`);
}
export function addParty(lawsuitId: string, body: PartyIn): Promise<{ id: number }> {
  return sendJson("POST", `/api/lawsuits/${lawsuitId}/parties`, body);
}
export function updateParty(id: number, body: PartyIn): Promise<{ ok: boolean }> {
  return sendJson("PUT", `/api/lawsuit-parties/${id}`, body);
}
export function deleteParty(id: number): Promise<{ ok: boolean }> {
  return sendJson("DELETE", `/api/lawsuit-parties/${id}`);
}
export function addSchedule(lawsuitId: string, body: ScheduleIn): Promise<{ id: number }> {
  return sendJson("POST", `/api/lawsuits/${lawsuitId}/schedules`, body);
}
export function updateSchedule(id: number, body: ScheduleIn): Promise<{ ok: boolean }> {
  return sendJson("PUT", `/api/lawsuit-schedules/${id}`, body);
}
export function deleteSchedule(id: number): Promise<{ ok: boolean }> {
  return sendJson("DELETE", `/api/lawsuit-schedules/${id}`);
}
export function addDocument(lawsuitId: string, body: DocumentIn): Promise<{ id: number }> {
  return sendJson("POST", `/api/lawsuits/${lawsuitId}/documents`, body);
}
export function updateDocument(id: number, body: DocumentIn): Promise<{ ok: boolean }> {
  return sendJson("PUT", `/api/lawsuit-documents/${id}`, body);
}
export function deleteDocument(id: number): Promise<{ ok: boolean }> {
  return sendJson("DELETE", `/api/lawsuit-documents/${id}`);
}
export function addMemo(lawsuitId: string, body: MemoIn): Promise<{ id: number }> {
  return sendJson("POST", `/api/lawsuits/${lawsuitId}/memos`, body);
}
export function updateMemo(id: number, body: MemoIn): Promise<{ ok: boolean }> {
  return sendJson("PUT", `/api/lawsuit-memos/${id}`, body);
}
export function deleteMemo(id: number): Promise<{ ok: boolean }> {
  return sendJson("DELETE", `/api/lawsuit-memos/${id}`);
}

// ===== ファイル（library） =====
export interface FileItem {
  id: string;
  contract_id: string | null;
  contract_no: string | null;
  file_name: string;
  content_type: string | null;
  file_size_bytes: number | string | null;
  tag_text: string | null;
  is_password_protected: boolean | null;
  created_at: string | null;
  created_by_name: string | null;
  company_name: string | null;
  has_content?: boolean;
}
export interface FilesData {
  kpis: Record<string, number | string>;
  total: number;
  items: FileItem[];
}
export function fetchFiles(params: { q?: string }): Promise<FilesData> {
  const usp = new URLSearchParams();
  if (params.q) usp.set("q", params.q);
  const qs = usp.toString();
  return getJson<FilesData>(`/api/files${qs ? `?${qs}` : ""}`);
}

// ===== 原本管理（originals） =====
export interface OriginalDoc {
  id: string;
  doc_type: string;
  contract_id: string | null;
  contract_no: string | null;
  received_on: string | null;
  status: string;
  note: string | null;
  storage_file_id: string | null;
  disposed_at: string | null;
  disposed_by_name: string | null;
  file_code: string | null;
  file_title: string | null;
  borrowed_by_name: string | null;
  borrowed_at: string | null;
}
export interface StorageFile {
  id: string;
  file_code: string;
  title: string;
  category: string | null;
  note: string | null;
  location_id: string | null;
  location_name: string | null;
  doc_count: number | string;
}
export interface StorageLocation {
  id: string;
  name: string;
  detail: string | null;
  note: string | null;
  file_count: number | string;
}
export interface OriginalsData {
  kpis: Record<string, number | string>;
  documents: OriginalDoc[];
  storage_files: StorageFile[];
  locations: StorageLocation[];
}
export function fetchOriginals(): Promise<OriginalsData> {
  return getJson<OriginalsData>(`/api/originals`);
}

// ===== 家計簿（household） =====
export interface HouseholdEntry {
  id: string;
  contract_id: string | null;
  contract_no: string | null;
  used_on: string | null;
  used_place: string | null;
  amount: number | string | null;
  category_code: string | null;
  entry_type: string | null;
}
export interface HouseholdData {
  kpis: Record<string, number | string>;
  entries: HouseholdEntry[];
}
export function fetchHousehold(params: { q?: string; entry_type?: string }): Promise<HouseholdData> {
  const usp = new URLSearchParams();
  if (params.q) usp.set("q", params.q);
  if (params.entry_type) usp.set("entry_type", params.entry_type);
  const qs = usp.toString();
  return getJson<HouseholdData>(`/api/household${qs ? `?${qs}` : ""}`);
}

// ===== 管理（admin） =====
export interface AdminUser {
  id: string;
  display_name: string;
  user_principal_name: string;
  mail: string | null;
  status: number;
  notify_channel: string | null;
  discord_user_id: string | null;
  discord_linked_at: string | null;
  last_signed_in_at: string | null;
  cti_ext_num: string | null;
  has_cti_password: boolean;
}
export interface CodeMaster {
  id: number;
  category: string;
  code: string;
  label: string;
  sort_order: number | null;
  is_active: boolean;
}
export interface DenyItem {
  id: number;
  phone_number: string;
  reason_code: string;
  reason_note: string | null;
  is_active: boolean;
  approval_status: string;
  reject_note: string | null;
  requested_at: string | null;
  approved_at: string | null;
  created_at: string | null;
  company_id: string | null;
  company_name: string | null;
  created_by_name: string | null;
  approved_by_name: string | null;
}
export interface AuditItem {
  id: string;
  entity_type: string;
  entity_id: string;
  action: string;
  before_json: any;
  after_json: any;
  acted_at: string | null;
  actor_name: string | null;
}
export interface NotifItem {
  id: number;
  notification_type: string;
  payload_json: any;
  posted_at: string | null;
  status: string;
  created_at: string | null;
}
export interface RoleItem {
  id: number;
  role_key: string;
  role_name: string;
  description: string | null;
  is_builtin: boolean;
  user_count: number;
  permissions: string[];
}
export interface PermissionItem {
  perm_key: string;
  perm_name: string;
  category: "screen" | "action";
  sort_order: number;
}
export interface GroupRoleMap {
  entra_group_id: string;
  entra_group_name: string | null;
  role_id: number;
  role_key: string;
  role_name: string;
}
export interface MockResetStatus {
  enabled: boolean;
  baseline_present: boolean;
  at: string;
  timezone: string;
  next_run: string | null;
  last_run: {
    at: string;
    trigger: string;
    duration_ms: number;
    tables?: number;
    counts?: Record<string, number | null>;
    ok: boolean;
  } | null;
}
export interface AdminData {
  users: AdminUser[];
  code_masters: CodeMaster[];
  deny_list: DenyItem[];
  audit: AuditItem[];
  notifications: NotifItem[];
  roles: RoleItem[];
  permissions: PermissionItem[];
  group_role_maps: GroupRoleMap[];
  mock_reset?: MockResetStatus;
}
export function fetchAdmin(): Promise<AdminData> {
  return getJson<AdminData>(`/api/admin`);
}

// ===== DF専用：モックデータの初期化（毎日0時に自動／管理者は手動実行も可能） =====
export interface MockResetResult {
  ok: boolean;
  trigger: string;
  duration_ms: number;
  tables: number;
  counts_before: Record<string, number | null>;
  counts_after: Record<string, number | null>;
}
export function runMockReset(): Promise<MockResetResult> {
  return sendJson("POST", "/api/admin/mock-reset");
}

// ===== 書き込み：ロール（カスタムロールの作成・編集・削除／権限の割り当て） =====
export interface RoleIn {
  role_key?: string; // 作成時のみ
  role_name: string;
  description?: string | null;
  permissions: string[];
}
export function createRole(body: RoleIn): Promise<{ ok: boolean; id: number }> {
  return sendJson("POST", "/api/admin/roles", body);
}
export function updateRole(roleId: number, body: RoleIn): Promise<{ ok: boolean }> {
  return sendJson("PUT", `/api/admin/roles/${roleId}`, body);
}
export function deleteRole(roleId: number): Promise<{ ok: boolean }> {
  return sendJson("DELETE", `/api/admin/roles/${roleId}`);
}

// ===== 書き込み：ロール ⇔ Entra セキュリティグループの対応（RBAC） =====
export interface GroupRoleMapIn {
  entra_group_id: string;
  entra_group_name?: string | null;
  role_id: number;
}
export function createGroupRoleMap(body: GroupRoleMapIn): Promise<{ ok: boolean }> {
  return sendJson("POST", "/api/admin/group-role-maps", body);
}
export function renameGroupRoleMap(
  groupId: string,
  entra_group_name: string | null,
): Promise<{ ok: boolean }> {
  return sendJson("PUT", `/api/admin/group-role-maps/${groupId}`, { entra_group_name });
}
export function deleteGroupRoleMap(groupId: string, roleId: number): Promise<{ ok: boolean }> {
  return sendJson("DELETE", `/api/admin/group-role-maps/${groupId}/${roleId}`);
}

// ===== 読み取り：サインイン診断（groups クレームが届いているかの確認） =====
export interface AuthSelfCheckMap {
  group_id: string;
  group_name: string | null;
  role_key: string;
  role_name: string;
  caller_is_member: boolean;
}
export interface AuthSelfCheck {
  mode: string;
  token_present: boolean;
  groups_claim_present: boolean;
  groups_overage: boolean;
  groups_count: number;
  caller_upn?: string | null;
  maps: AuthSelfCheckMap[];
  any_match: boolean;
}
export function fetchAuthSelfCheck(): Promise<AuthSelfCheck> {
  return getJson<AuthSelfCheck>(`/api/admin/auth-selfcheck`);
}

// ===== 書き込み：会社・名義・口座（Phase 2） =====
export interface CompanyIn {
  company_name: string;
  company_name_kana?: string | null;
  corporate_number?: string | null;
  postal_code?: string | null;
  prefecture?: string | null;
  city?: string | null;
  address1?: string | null;
  address2?: string | null;
  status_flag?: number;
  status_reason?: string | null;
  phone?: string | null;
}
export function createCompany(body: CompanyIn): Promise<{ id: string }> {
  return sendJson("POST", "/api/companies", body);
}
export function updateCompany(id: string, body: CompanyIn): Promise<{ ok: boolean }> {
  return sendJson("PUT", `/api/companies/${id}`, body);
}
export function deleteCompany(id: string): Promise<{ ok: boolean }> {
  return sendJson("DELETE", `/api/companies/${id}`);
}

export interface PersonIn {
  full_name: string;
  full_name_kana?: string | null;
  birth_date?: string | null;
  postal_code?: string | null;
  prefecture?: string | null;
  city?: string | null;
  address1?: string | null;
  address2?: string | null;
}
export function createPerson(body: PersonIn): Promise<{ id: string }> {
  return sendJson("POST", "/api/persons", body);
}
export function updatePerson(id: string, body: PersonIn): Promise<{ ok: boolean }> {
  return sendJson("PUT", `/api/persons/${id}`, body);
}
export function deletePerson(id: string): Promise<{ ok: boolean }> {
  return sendJson("DELETE", `/api/persons/${id}`);
}

export interface AccountIn {
  account_category: string;
  account_type: string;
  account_role: string;
  bank_code?: string | null;
  branch_code?: string | null;
  bank_name?: string | null;
  branch_name?: string | null;
  account_no_masked?: string | null;
  account_no?: string | null;
  cvv2?: string | null;
  account_holder_kana?: string | null;
  expiry_mm_yy?: string | null;
  incident_code?: string;
  is_active?: boolean;
}
export function createAccount(body: AccountIn): Promise<{ id: string }> {
  return sendJson("POST", "/api/accounts", body);
}
export function updateAccount(id: string, body: AccountIn): Promise<{ ok: boolean }> {
  return sendJson("PUT", `/api/accounts/${id}`, body);
}
export function deleteAccount(id: string): Promise<{ ok: boolean }> {
  return sendJson("DELETE", `/api/accounts/${id}`);
}

// 機微情報の開示（権限 action.sensitive.reveal 保持者のみ・監査ログ記録）
export interface RevealResult {
  account_no: string;
  cvv2: string | null;
  expiry_mm_yy: string | null;
}
export function revealAccountNo(id: string, reason?: string): Promise<RevealResult> {
  return sendJson("POST", `/api/accounts/${id}/reveal`, { reason: reason ?? null });
}

// ===== 書き込み：業務アクション（Phase 2 第2弾） =====
// 審査：承認 / 差し戻し / 否決
export interface ReviewActionIn {
  action: "approved" | "returned" | "rejected";
  comment?: string | null;
}
export function postReviewAction(
  contractId: string,
  body: ReviewActionIn,
): Promise<{ id: number; review_status: string; action: string }> {
  return sendJson("POST", `/api/reviews/${contractId}/action`, body);
}

// 入金登録
export interface PaymentIn {
  contract_id: string;
  received_at: string;
  amount: number;
  received_method?: string | null;
  received_place?: string | null;
  source_type?: string | null;
  receipt_type?: string | null;
  has_receipt?: boolean | null;
}
export function createPayment(body: PaymentIn): Promise<{ id: string }> {
  return sendJson("POST", "/api/payments", body);
}

// 家計簿：収支の登録 / 削除
export interface HouseholdIn {
  used_on: string;
  amount: number;
  category_code: string;
  entry_type?: string;
  used_place?: string | null;
  contract_id?: string | null;
}
export function createHousehold(body: HouseholdIn): Promise<{ id: string }> {
  return sendJson("POST", "/api/household", body);
}
export function updateHousehold(id: string, body: HouseholdIn): Promise<{ ok: boolean }> {
  return sendJson("PUT", `/api/household/${id}`, body);
}
export function deleteHousehold(id: string): Promise<{ ok: boolean }> {
  return sendJson("DELETE", `/api/household/${id}`);
}

// ===== 会社の電話番号（複数管理） =====
export interface CompanyPhoneIn {
  phone_number: string;
  phone_type?: string | null;
  is_primary?: boolean;
  note?: string | null;
}
export function createCompanyPhone(
  companyId: string,
  body: CompanyPhoneIn,
): Promise<{ id: number }> {
  return sendJson("POST", `/api/companies/${companyId}/phones`, body);
}
export function updateCompanyPhone(
  phoneId: number,
  body: CompanyPhoneIn,
): Promise<{ ok: boolean }> {
  return sendJson("PUT", `/api/company-phones/${phoneId}`, body);
}
export function deleteCompanyPhone(phoneId: number): Promise<{ ok: boolean }> {
  return sendJson("DELETE", `/api/company-phones/${phoneId}`);
}

// 着信拒否：追加 / 解除
export interface DenyIn {
  phone_number: string;
  reason_code: string;
  reason_note?: string | null;
  company_id?: string | null;
}
export function createDeny(body: DenyIn): Promise<{ id: number }> {
  return sendJson("POST", "/api/deny", body);
}
export function updateDeny(id: number, body: DenyIn): Promise<{ ok: boolean }> {
  return sendJson("PUT", `/api/deny/${id}`, body);
}
export function approveDeny(id: number): Promise<{ ok: boolean }> {
  return sendJson("POST", `/api/deny/${id}/approve`);
}
export function rejectDeny(id: number, note: string | null): Promise<{ ok: boolean }> {
  return sendJson("POST", `/api/deny/${id}/reject`, { note });
}
export function liftDeny(id: number): Promise<{ ok: boolean }> {
  return sendJson("POST", `/api/deny/${id}/lift`);
}
export function deleteDeny(id: number): Promise<{ ok: boolean }> {
  return sendJson("DELETE", `/api/deny/${id}`);
}

// 管理：ユーザーの新規・編集・削除
export interface UserIn {
  display_name: string;
  user_principal_name: string;
  mail?: string | null;
  status: number;
  cti_ext_num?: string | null;
  cti_password?: string | null;
}
export function createUser(body: UserIn): Promise<{ id: string }> {
  return sendJson("POST", "/api/admin/users", body);
}
export function updateUser(id: string, body: UserIn): Promise<{ ok: boolean }> {
  return sendJson("PUT", `/api/admin/users/${id}`, body);
}
export function deleteUser(id: string): Promise<{ ok: boolean }> {
  return sendJson("DELETE", `/api/admin/users/${id}`);
}

// 管理：コードマスタ（分類・区分）の新規・編集・削除
export interface MasterIn {
  category: string;
  code: string;
  label: string;
  sort_order: number;
  is_active: boolean;
}
export function createMaster(body: MasterIn): Promise<{ id: number }> {
  return sendJson("POST", "/api/admin/masters", body);
}
export function updateMaster(id: number, body: MasterIn): Promise<{ ok: boolean }> {
  return sendJson("PUT", `/api/admin/masters/${id}`, body);
}
export function deleteMaster(id: number): Promise<{ ok: boolean }> {
  return sendJson("DELETE", `/api/admin/masters/${id}`);
}

// 原本：貸出 / 返却
export function lendOriginal(id: string): Promise<{ ok: boolean; status: string }> {
  return sendJson("POST", `/api/originals/${id}/lend`);
}
export function returnOriginal(id: string): Promise<{ ok: boolean; status: string }> {
  return sendJson("POST", `/api/originals/${id}/return`);
}

// 原本：新規・編集・削除・廃棄
export interface OriginalIn {
  doc_type: string;
  contract_id?: string | null;
  storage_file_id?: string | null;
  received_on?: string | null;
  note?: string | null;
}
export function createOriginal(body: OriginalIn): Promise<{ id: string }> {
  return sendJson("POST", "/api/originals", body);
}
export function updateOriginal(id: string, body: OriginalIn): Promise<{ ok: boolean }> {
  return sendJson("PUT", `/api/originals/${id}`, body);
}
export function deleteOriginal(id: string): Promise<{ ok: boolean }> {
  return sendJson("DELETE", `/api/originals/${id}`);
}
export function disposeOriginal(id: string): Promise<{ ok: boolean; status: string }> {
  return sendJson("POST", `/api/originals/${id}/dispose`);
}

// 保管ファイル：新規・編集・削除
export interface StorageFileIn {
  file_code: string;
  title: string;
  category?: string | null;
  location_id?: string | null;
  note?: string | null;
}
export function createStorageFile(body: StorageFileIn): Promise<{ id: string }> {
  return sendJson("POST", "/api/storage-files", body);
}
export function updateStorageFile(id: string, body: StorageFileIn): Promise<{ ok: boolean }> {
  return sendJson("PUT", `/api/storage-files/${id}`, body);
}
export function deleteStorageFile(id: string): Promise<{ ok: boolean }> {
  return sendJson("DELETE", `/api/storage-files/${id}`);
}

// 格納場所：新規・編集・削除
export interface StorageLocationIn {
  name: string;
  detail?: string | null;
  note?: string | null;
}
export function createStorageLocation(body: StorageLocationIn): Promise<{ id: string }> {
  return sendJson("POST", "/api/storage-locations", body);
}
export function updateStorageLocation(id: string, body: StorageLocationIn): Promise<{ ok: boolean }> {
  return sendJson("PUT", `/api/storage-locations/${id}`, body);
}
export function deleteStorageLocation(id: string): Promise<{ ok: boolean }> {
  return sendJson("DELETE", `/api/storage-locations/${id}`);
}

// ===== 書き込み：契約の新規作成・編集（Phase 2 第3弾） =====
export interface UserLite {
  id: string;
  display_name: string;
}
export function fetchUsers(): Promise<UserLite[]> {
  return getJson<UserLite[]>("/api/users");
}

export interface ContractPartyIn {
  kind: "company" | "person";
  id: string;
  link_category?: string | null;
}
export interface ContractCreateIn {
  contract_category: string;
  contract_summary?: string | null;
  signed_at?: string | null;
  started_at?: string | null;
  ended_at?: string | null;
  assignee_user_id?: string | null;
  // 当事者（新方式）。会社・個人を任意の件数で指定できる（会社対名義・個人対個人 等に対応）。
  parties?: ContractPartyIn[];
  // 従来方式（後方互換）。単一の会社・名義。
  company_id?: string | null;
  company_link_category?: string | null;
  person_id?: string | null;
  person_link_category?: string | null;
  identifier_type?: string | null;
  identifier_value?: string | null;
  identifier_is_primary?: boolean;
}
export function createContract(
  body: ContractCreateIn,
): Promise<{ id: string; contract_no: string }> {
  return sendJson("POST", "/api/contracts", body);
}

export interface ContractUpdateIn {
  contract_category: string;
  contract_summary: string;
  contract_status: string;
  signed_at?: string | null;
  started_at?: string | null;
  ended_at?: string | null;
  has_recurring_billing: boolean;
  assignee_user_id?: string | null;
  review_memo?: string | null;
}
export function updateContract(
  id: string,
  body: ContractUpdateIn,
): Promise<{ ok: boolean }> {
  return sendJson("PUT", `/api/contracts/${id}`, body);
}

// ===== 書き込み：契約の紐付・識別子・履歴・請求・入金・ファイル（Phase 2 第4弾） =====

// 会社リンク
export function addCompanyLink(
  contractId: string,
  body: { entity_id: string; link_category: string },
): Promise<{ link_id: number }> {
  return sendJson("POST", `/api/contracts/${contractId}/company-links`, body);
}
export function updateCompanyLink(
  linkId: number,
  body: { link_category: string },
): Promise<{ ok: boolean }> {
  return sendJson("PUT", `/api/contract-company-links/${linkId}`, body);
}
export function deleteCompanyLink(linkId: number): Promise<{ ok: boolean }> {
  return sendJson("DELETE", `/api/contract-company-links/${linkId}`);
}

// 名義リンク
export function addPersonLink(
  contractId: string,
  body: { entity_id: string; link_category: string },
): Promise<{ link_id: number }> {
  return sendJson("POST", `/api/contracts/${contractId}/person-links`, body);
}
export function updatePersonLink(
  linkId: number,
  body: { link_category: string },
): Promise<{ ok: boolean }> {
  return sendJson("PUT", `/api/contract-person-links/${linkId}`, body);
}
export function deletePersonLink(linkId: number): Promise<{ ok: boolean }> {
  return sendJson("DELETE", `/api/contract-person-links/${linkId}`);
}

// 口座・カードリンク
export function addAccountLink(
  contractId: string,
  body: { entity_id: string; link_category: string; is_default?: boolean },
): Promise<{ link_id: number }> {
  return sendJson("POST", `/api/contracts/${contractId}/account-links`, body);
}
export function updateAccountLink(
  linkId: number,
  body: { link_category: string; is_default?: boolean },
): Promise<{ ok: boolean }> {
  return sendJson("PUT", `/api/contract-account-links/${linkId}`, body);
}
export function deleteAccountLink(linkId: number): Promise<{ ok: boolean }> {
  return sendJson("DELETE", `/api/contract-account-links/${linkId}`);
}

// 外部管理番号（識別子）
export interface IdentifierIn {
  identifier_type: string;
  identifier_value: string;
  is_primary?: boolean;
}
export function addIdentifier(
  contractId: string,
  body: IdentifierIn,
): Promise<{ id: number }> {
  return sendJson("POST", `/api/contracts/${contractId}/identifiers`, body);
}
export function updateIdentifier(
  identId: number,
  body: IdentifierIn,
): Promise<{ ok: boolean }> {
  return sendJson("PUT", `/api/identifiers/${identId}`, body);
}
export function deleteIdentifier(identId: number): Promise<{ ok: boolean }> {
  return sendJson("DELETE", `/api/identifiers/${identId}`);
}

// やり取り履歴
export interface CommunicationIn {
  occurred_at?: string | null;
  channel?: string | null;
  direction?: string | null;
  summary: string;
  details?: string | null;
  calendar?: {
    request_id: string;
    starts_at: string;
    ends_at: string;
  };
}
export interface CommunicationCreated {
  id: string;
  calendar: CalendarRegistration | null;
}
export function addCommunication(
  contractId: string,
  body: CommunicationIn,
): Promise<CommunicationCreated> {
  return sendJson("POST", `/api/contracts/${contractId}/communications`, body);
}
export function updateCommunication(
  commId: string,
  body: Omit<CommunicationIn, "calendar">,
): Promise<{ ok: boolean }> {
  return sendJson("PUT", `/api/communications/${commId}`, body);
}
export function deleteCommunication(commId: string): Promise<{ ok: boolean }> {
  return sendJson("DELETE", `/api/communications/${commId}`);
}
export function retryCommunicationCalendar(commId: string): Promise<CalendarRegistration> {
  return sendJson("POST", `/api/communications/${commId}/calendar/retry`);
}

// 請求（claims）
export interface ClaimIn {
  claim_category: string;
  occurred_on: string;
  due_at?: string | null;
  new_amount: number;
  carry_over_amount: number;
  status: string;
  methods?: string[];
  memo?: string | null;
}
export function createClaim(
  contractId: string,
  body: ClaimIn,
): Promise<{ id: string }> {
  return sendJson("POST", `/api/contracts/${contractId}/claims`, body);
}
export function updateClaim(claimId: string, body: ClaimIn): Promise<{ ok: boolean }> {
  return sendJson("PUT", `/api/claims/${claimId}`, body);
}
export function deleteClaim(claimId: string): Promise<{ ok: boolean }> {
  return sendJson("DELETE", `/api/claims/${claimId}`);
}

// 入金の編集・削除
export interface PaymentUpdateIn {
  received_at: string;
  amount: number;
  received_method?: string | null;
  received_place?: string | null;
  source_type?: string | null;
  receipt_type?: string | null;
  has_receipt?: boolean | null;
}
export function updatePayment(
  paymentId: string,
  body: PaymentUpdateIn,
): Promise<{ ok: boolean }> {
  return sendJson("PUT", `/api/payments/${paymentId}`, body);
}
export function deletePayment(paymentId: string): Promise<{ ok: boolean }> {
  return sendJson("DELETE", `/api/payments/${paymentId}`);
}

// 契約ファイル（メタデータのみ）
export interface FileCreateIn {
  file_name: string;
  tag_text?: string | null;
  is_password_protected?: boolean;
}
export function createContractFile(
  contractId: string,
  body: FileCreateIn,
): Promise<{ id: string }> {
  return sendJson("POST", `/api/contracts/${contractId}/files`, body);
}
export function updateFile(
  fileId: string,
  body: FileCreateIn,
): Promise<{ ok: boolean }> {
  return sendJson("PUT", `/api/files/${fileId}`, body);
}
export function deleteFile(fileId: string): Promise<{ ok: boolean }> {
  return sendJson("DELETE", `/api/files/${fileId}`);
}

/** 実ファイルをアップロードして契約に添付（実体をDB保存）。 */
export async function uploadContractFile(
  contractId: string,
  file: File,
  tagText?: string | null,
  isProtected?: boolean,
): Promise<{ id: string }> {
  const headers = await authHeaders({ Accept: "application/json" });
  const fd = new FormData();
  fd.append("file", file);
  if (tagText) fd.append("tag_text", tagText);
  fd.append("is_password_protected", isProtected ? "true" : "false");
  const res = await fetch(`/api/contracts/${contractId}/files/upload`, {
    method: "POST",
    headers,
    body: fd,
  });
  if (!res.ok) {
    let msg = `API ${res.status}`;
    try {
      const j = await res.json();
      if (j?.detail) msg = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail);
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return (await res.json()) as { id: string };
}

/** 既存ファイルに実体（バイナリ）を追加／差し替え。 */
export async function uploadFileContent(fileId: string, file: File): Promise<{ ok: boolean }> {
  const headers = await authHeaders({ Accept: "application/json" });
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch(`/api/files/${fileId}/content`, {
    method: "POST",
    headers,
    body: fd,
  });
  if (!res.ok) {
    let msg = `API ${res.status}`;
    try {
      const j = await res.json();
      if (j?.detail) msg = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail);
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return (await res.json()) as { ok: boolean };
}

/** プレビュー用に、認証付きで実体を取得して Blob を返す。 */
export async function fetchFileBlob(fileId: string): Promise<Blob> {
  const headers = await authHeaders({});
  const res = await fetch(`/api/files/${fileId}/content`, { headers });
  if (!res.ok) {
    let msg = `API ${res.status}`;
    try {
      const j = await res.json();
      if (j?.detail) msg = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail);
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return await res.blob();
}

/** ファイルの実体をダウンロード。 */
export async function downloadFileContent(fileId: string, fallbackName: string): Promise<void> {
  await downloadBlob(`/api/files/${fileId}/content?dl=1`, fallbackName);
}

// 契約の削除
export function deleteContract(id: string): Promise<{ ok: boolean }> {
  return sendJson("DELETE", `/api/contracts/${id}`);
}

// ============================================================
// 入力補助（住所・銀行・法人番号）— サーバー側プロキシ経由
// ============================================================
export interface PostalCandidate {
  postal_code: string;
  prefecture: string;
  city: string;
  town: string;
}
export function lookupPostal(zip: string): Promise<{ found: boolean; candidates: PostalCandidate[] }> {
  return getJson(`/api/lookup/postal?zip=${encodeURIComponent(zip)}`);
}

export interface BankItem {
  code: string;
  name: string;
  kana: string;
}
export function lookupBankSearch(name: string): Promise<{ items: BankItem[] }> {
  return getJson(`/api/lookup/bank/search?name=${encodeURIComponent(name)}`);
}
export function lookupBranchSearch(code: string, name: string): Promise<{ items: BankItem[] }> {
  return getJson(
    `/api/lookup/bank/${encodeURIComponent(code)}/branch/search?name=${encodeURIComponent(name)}`,
  );
}

export interface CorporateInfo {
  found: boolean;
  corporate_number?: string;
  name?: string;
  kana?: string;
  postal_code?: string;
  prefecture?: string;
  city?: string;
  street_number?: string;
  business_summary?: string;
}
export function lookupCorporate(number: string): Promise<CorporateInfo> {
  return getJson(`/api/lookup/corporate?number=${encodeURIComponent(number)}`);
}
