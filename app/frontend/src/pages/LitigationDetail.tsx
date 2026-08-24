import { ReactNode, useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  makeStyles,
  tokens,
  Title3,
  Subtitle2,
  Body1,
  Button,
  Badge,
  Spinner,
  Table,
  TableHeader,
  TableHeaderCell,
  TableRow,
  TableBody,
  TableCell,
  MessageBar,
  MessageBarBody,
} from "@fluentui/react-components";
import {
  ArrowLeft20Regular,
  Open16Regular,
  Add20Regular,
  Edit20Regular,
  Delete20Regular,
} from "@fluentui/react-icons";
import {
  fetchLawsuit,
  LawsuitDetail,
  LawsuitParty,
  LawsuitSchedule,
  LawsuitDocument,
  LawsuitMemo,
  fetchCompanies,
  fetchPersons,
  updateLawsuit,
  deleteLawsuit,
  addParty,
  updateParty,
  deleteParty,
  addSchedule,
  updateSchedule,
  deleteSchedule,
  addDocument,
  updateDocument,
  deleteDocument,
  addMemo,
  updateMemo,
  deleteMemo,
} from "../api/client";
import { fmtYen, fmtDate, fmtDateTime, lawsuitStatusAppearance } from "../util/format";
import FormDialog, { FormField, FormValues, FormValue } from "../components/FormDialog";
import ConfirmDialog from "../components/ConfirmDialog";

const PROC_TYPES = ["通常訴訟", "支払督促", "少額訴訟", "民事調停", "手形・小切手訴訟", "強制執行", "仮差押", "仮処分", "その他"];
const OUR_ROLES = ["被告（当方）", "原告（当方）", "債権者（当方）", "債務者（当方）", "申立人（当方）", "相手方（当方）"];
const LAWSUIT_STATUSES = ["係争中", "和解", "判決", "取下げ", "確定", "終了"];
const PARTY_ROLES = ["原告（相手方）", "被告（相手方）", "債務者（相手方）", "連帯保証人（相手方）", "保証人（相手方）", "第三債務者", "代理人", "その他"];
const SCHEDULE_TYPES = ["口頭弁論", "弁論準備", "審尋", "和解期日", "判決言渡", "進行協議", "その他"];
const SCHEDULE_RESULTS = ["予定", "終了", "続行", "取消"];
const DOC_SIDES = ["当方", "相手方", "裁判所"];
const DOC_STATES = ["未提出", "提出済", "受領"];

function toOpts(items: string[]) {
  return items.map((x) => ({ value: x, label: x }));
}

type DlgSpec = {
  title: string;
  fields: FormField[];
  initial?: FormValues;
  submitLabel?: string;
  onSubmit: (v: FormValues) => Promise<void>;
};
type ConfirmSpec = { title: string; message: string; onConfirm: () => Promise<void> };

const useStyles = makeStyles({
  back: { marginBottom: "12px" },
  head: { display: "flex", alignItems: "center", columnGap: "12px", marginBottom: "4px" },
  spacer: { flexGrow: 1 },
  crumb: { color: tokens.colorNeutralForeground3, fontSize: "12px", marginBottom: "16px" },
  panel: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: "16px",
    marginBottom: "16px",
  },
  panelHead: { display: "flex", alignItems: "center", marginBottom: "10px" },
  grid: {
    display: "grid",
    gridTemplateColumns: "160px 1fr",
    rowGap: "6px",
    columnGap: "12px",
    fontSize: "14px",
  },
  label: { color: tokens.colorNeutralForeground3 },
  mono: { fontVariantNumeric: "tabular-nums" },
});

function Field({ label, value }: { label: string; value: ReactNode }) {
  const s = useStyles();
  return (
    <>
      <div className={s.label}>{label}</div>
      <div>{value ?? "—"}</div>
    </>
  );
}

export default function LitigationDetail() {
  const s = useStyles();
  const { id } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState<LawsuitDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [companyOpts, setCompanyOpts] = useState<{ value: string; label: string }[]>([]);
  const [personOpts, setPersonOpts] = useState<{ value: string; label: string }[]>([]);
  const [dlg, setDlg] = useState<DlgSpec | null>(null);
  const [confirm, setConfirm] = useState<ConfirmSpec | null>(null);

  function load() {
    if (!id) return;
    return fetchLawsuit(id)
      .then(setData)
      .catch((e) => setError(e?.message ?? "読み込みに失敗しました"));
  }

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    Promise.all([
      fetchLawsuit(id).then(setData),
      fetchCompanies({}).then((r) =>
        setCompanyOpts(r.items.map((c) => ({ value: c.id, label: c.company_name })))
      ),
      fetchPersons({}).then((r) =>
        setPersonOpts(r.items.map((p) => ({ value: p.id, label: p.full_name })))
      ),
    ])
      .catch((e) => setError(e?.message ?? "読み込みに失敗しました"))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) {
    return (
      <div style={{ padding: 24 }}>
        <Spinner label="読み込み中…" />
      </div>
    );
  }
  if (error || !data) {
    return (
      <MessageBar intent="error">
        <MessageBarBody>{error ?? "訴訟を読み込めません"}</MessageBarBody>
      </MessageBar>
    );
  }

  const l = data.lawsuit;
  const num = (v: FormValue): number | null => {
    const t = String(v ?? "").trim();
    return t === "" ? null : Number(t);
  };

  // ---- 案件（編集・削除）----
  function openEditLawsuit() {
    setDlg({
      title: "案件情報の編集",
      submitLabel: "保存する",
      fields: [
        { key: "proc_type", label: "手続", type: "select", required: true, options: toOpts(PROC_TYPES) },
        { key: "case_name", label: "事件名", type: "text" },
        { key: "case_number", label: "事件番号", type: "text", required: true },
        { key: "court_name", label: "裁判所", type: "text", required: true },
        { key: "our_side_role", label: "当方の立場", type: "select", options: toOpts(OUR_ROLES) },
        { key: "status", label: "状態", type: "select", required: true, options: toOpts(LAWSUIT_STATUSES) },
        { key: "claim_amount", label: "相手方の請求額（円）", type: "number" },
        { key: "suit_value", label: "訴額（円）", type: "number" },
        { key: "filed_or_received_on", label: "提訴・受領日", type: "date" },
        { key: "our_lawyer", label: "当方の代理人", type: "text" },
        { key: "court_clerk", label: "裁判所書記官", type: "text" },
        { key: "demand", label: "請求の趣旨", type: "textarea" },
        { key: "cause", label: "請求の原因", type: "textarea" },
      ],
      initial: {
        proc_type: l.proc_type ?? "",
        case_name: l.case_name ?? "",
        case_number: l.case_number ?? "",
        court_name: l.court_name ?? "",
        our_side_role: l.our_side_role ?? "",
        status: l.status ?? "",
        claim_amount: l.claim_amount ?? "",
        suit_value: l.suit_value ?? "",
        filed_or_received_on: (l.filed_or_received_on ?? "").slice(0, 10),
        our_lawyer: l.our_lawyer ?? "",
        court_clerk: l.court_clerk ?? "",
        demand: l.demand ?? "",
        cause: l.cause ?? "",
      },
      onSubmit: async (v) => {
        await updateLawsuit(l.id, {
          proc_type: String(v.proc_type),
          case_number: String(v.case_number).trim(),
          court_name: String(v.court_name).trim(),
          status: String(v.status),
          our_side_role: String(v.our_side_role ?? "").trim() || null,
          case_name: String(v.case_name ?? "").trim() || null,
          court_clerk: String(v.court_clerk ?? "").trim() || null,
          our_lawyer: String(v.our_lawyer ?? "").trim() || null,
          claim_amount: num(v.claim_amount),
          suit_value: num(v.suit_value),
          filed_or_received_on: String(v.filed_or_received_on ?? "").trim() || null,
          demand: String(v.demand ?? "").trim() || null,
          cause: String(v.cause ?? "").trim() || null,
        });
        setDlg(null);
        await load();
      },
    });
  }

  function delThisLawsuit() {
    setConfirm({
      title: "訴訟の削除",
      message: "この訴訟案件と、当事者・期日・提出書類・経過メモをすべて削除します。よろしいですか？",
      onConfirm: async () => {
        await deleteLawsuit(l.id);
        setConfirm(null);
        navigate("/litigation");
      },
    });
  }

  // ---- 当事者 ----
  const partyFields: FormField[] = [
    { key: "party_role", label: "立場", type: "select", required: true, options: toOpts(PARTY_ROLES) },
    { key: "company_id", label: "会社（どちらか）", type: "select", options: [{ value: "", label: "（なし）" }, ...companyOpts] },
    { key: "person_id", label: "名義人（どちらか）", type: "select", options: [{ value: "", label: "（なし）" }, ...personOpts] },
    { key: "agent_note", label: "代理人・備考", type: "text" },
  ];
  function partyBody(v: FormValues) {
    return {
      party_role: String(v.party_role),
      company_id: String(v.company_id ?? "").trim() || null,
      person_id: String(v.person_id ?? "").trim() || null,
      agent_note: String(v.agent_note ?? "").trim() || null,
    };
  }
  function openAddParty() {
    setDlg({
      title: "当事者の追加",
      fields: partyFields,
      initial: { party_role: "", company_id: "", person_id: "", agent_note: "" },
      onSubmit: async (v) => {
        await addParty(l.id, partyBody(v));
        setDlg(null);
        await load();
      },
    });
  }
  function openEditParty(p: LawsuitParty) {
    setDlg({
      title: "当事者の編集",
      fields: partyFields,
      initial: {
        party_role: p.party_role ?? "",
        company_id: p.company_id ?? "",
        person_id: p.person_id ?? "",
        agent_note: p.agent_note ?? "",
      },
      onSubmit: async (v) => {
        await updateParty(p.id!, partyBody(v));
        setDlg(null);
        await load();
      },
    });
  }
  function delPartyRow(p: LawsuitParty) {
    setConfirm({
      title: "当事者の削除",
      message: `「${p.display_name_snapshot ?? "この当事者"}」を削除します。よろしいですか？`,
      onConfirm: async () => {
        await deleteParty(p.id!);
        setConfirm(null);
        await load();
      },
    });
  }

  // ---- 期日 ----
  const schedFields: FormField[] = [
    { key: "schedule_type", label: "種別", type: "select", required: true, options: toOpts(SCHEDULE_TYPES) },
    { key: "scheduled_at", label: "日付", type: "date", required: true },
    { key: "place", label: "場所", type: "text" },
    { key: "attendee", label: "出席者", type: "text" },
    { key: "result", label: "結果", type: "select", options: toOpts(SCHEDULE_RESULTS) },
  ];
  function schedBody(v: FormValues) {
    return {
      schedule_type: String(v.schedule_type),
      scheduled_at: String(v.scheduled_at).trim(),
      place: String(v.place ?? "").trim() || null,
      attendee: String(v.attendee ?? "").trim() || null,
      result: String(v.result ?? "").trim() || null,
    };
  }
  function openAddSchedule() {
    setDlg({
      title: "期日の追加",
      fields: schedFields,
      initial: { schedule_type: "", scheduled_at: "", place: "", attendee: "", result: "予定" },
      onSubmit: async (v) => {
        await addSchedule(l.id, schedBody(v));
        setDlg(null);
        await load();
      },
    });
  }
  function openEditSchedule(sc: LawsuitSchedule) {
    setDlg({
      title: "期日の編集",
      fields: schedFields,
      initial: {
        schedule_type: sc.schedule_type ?? "",
        scheduled_at: (sc.scheduled_at ?? "").slice(0, 10),
        place: sc.place ?? "",
        attendee: sc.attendee ?? "",
        result: sc.result ?? "予定",
      },
      onSubmit: async (v) => {
        await updateSchedule(sc.id!, schedBody(v));
        setDlg(null);
        await load();
      },
    });
  }
  function delScheduleRow(sc: LawsuitSchedule) {
    setConfirm({
      title: "期日の削除",
      message: `「${sc.schedule_type}（${fmtDate(sc.scheduled_at)}）」を削除します。よろしいですか？`,
      onConfirm: async () => {
        await deleteSchedule(sc.id!);
        setConfirm(null);
        await load();
      },
    });
  }

  // ---- 提出書類 ----
  const docFields: FormField[] = [
    { key: "doc_name", label: "書類名", type: "text", required: true },
    { key: "side", label: "提出側", type: "select", required: true, options: toOpts(DOC_SIDES) },
    { key: "due_on", label: "期限", type: "date" },
    { key: "filed_on", label: "提出日", type: "date" },
    { key: "state", label: "状態", type: "select", options: toOpts(DOC_STATES) },
  ];
  function docBody(v: FormValues) {
    return {
      doc_name: String(v.doc_name).trim(),
      side: String(v.side),
      due_on: String(v.due_on ?? "").trim() || null,
      filed_on: String(v.filed_on ?? "").trim() || null,
      state: String(v.state ?? "").trim() || null,
    };
  }
  function openAddDocument() {
    setDlg({
      title: "提出書類の追加",
      fields: docFields,
      initial: { doc_name: "", side: "当方", due_on: "", filed_on: "", state: "未提出" },
      onSubmit: async (v) => {
        await addDocument(l.id, docBody(v));
        setDlg(null);
        await load();
      },
    });
  }
  function openEditDocument(d: LawsuitDocument) {
    setDlg({
      title: "提出書類の編集",
      fields: docFields,
      initial: {
        doc_name: d.doc_name ?? "",
        side: d.side ?? "当方",
        due_on: (d.due_on ?? "").slice(0, 10),
        filed_on: (d.filed_on ?? "").slice(0, 10),
        state: d.state ?? "未提出",
      },
      onSubmit: async (v) => {
        await updateDocument(d.id!, docBody(v));
        setDlg(null);
        await load();
      },
    });
  }
  function delDocumentRow(d: LawsuitDocument) {
    setConfirm({
      title: "提出書類の削除",
      message: `「${d.doc_name}」を削除します。よろしいですか？`,
      onConfirm: async () => {
        await deleteDocument(d.id!);
        setConfirm(null);
        await load();
      },
    });
  }

  // ---- 経過メモ ----
  const memoFields: FormField[] = [
    { key: "memo_on", label: "日付", type: "date", required: true },
    { key: "note", label: "内容", type: "textarea", required: true },
  ];
  function memoBody(v: FormValues) {
    return { memo_on: String(v.memo_on).trim(), note: String(v.note).trim() };
  }
  function openAddMemo() {
    setDlg({
      title: "経過メモの追加",
      fields: memoFields,
      initial: { memo_on: "", note: "" },
      onSubmit: async (v) => {
        await addMemo(l.id, memoBody(v));
        setDlg(null);
        await load();
      },
    });
  }
  function openEditMemo(m: LawsuitMemo) {
    setDlg({
      title: "経過メモの編集",
      fields: memoFields,
      initial: { memo_on: (m.memo_on ?? "").slice(0, 10), note: m.note ?? "" },
      onSubmit: async (v) => {
        await updateMemo(m.id!, memoBody(v));
        setDlg(null);
        await load();
      },
    });
  }
  function delMemoRow(m: LawsuitMemo) {
    setConfirm({
      title: "経過メモの削除",
      message: "この経過メモを削除します。よろしいですか？",
      onConfirm: async () => {
        await deleteMemo(m.id!);
        setConfirm(null);
        await load();
      },
    });
  }

  return (
    <div>
      <Button
        className={s.back}
        appearance="subtle"
        icon={<ArrowLeft20Regular />}
        onClick={() => navigate("/litigation")}
      >
        訴訟一覧へ戻る
      </Button>

      <div className={s.head}>
        <Title3>{l.case_name || l.case_number || "訴訟案件"}</Title3>
        <Badge appearance="tint" color={lawsuitStatusAppearance(l.status)}>
          {l.status ?? "—"}
        </Badge>
        <div className={s.spacer} />
        <Button appearance="secondary" icon={<Edit20Regular />} onClick={openEditLawsuit}>
          案件を編集
        </Button>
        <Button appearance="subtle" icon={<Delete20Regular />} onClick={delThisLawsuit}>
          訴訟を削除
        </Button>
      </div>
      <div className={s.crumb}>
        契約番号 {l.contract_no}
        {l.contract_summary ? `　${l.contract_summary}` : ""}
      </div>

      <div className={s.panel}>
        <div className={s.panelHead}>
          <Subtitle2>案件情報</Subtitle2>
        </div>
        <div className={s.grid}>
          <Field label="手続" value={l.proc_type} />
          <Field label="事件名" value={l.case_name} />
          <Field label="事件番号" value={<span className={s.mono}>{l.case_number ?? "—"}</span>} />
          <Field label="裁判所" value={l.court_name} />
          <Field label="当方の立場" value={l.our_side_role} />
          <Field label="当方の代理人" value={l.our_lawyer} />
          <Field label="相手方の請求額" value={<span className={s.mono}>{fmtYen(l.claim_amount)}</span>} />
          <Field label="訴額" value={<span className={s.mono}>{fmtYen(l.suit_value)}</span>} />
          <Field label="申立・受領日" value={fmtDate(l.filed_or_received_on)} />
          <Field label="請求の趣旨" value={l.demand} />
          <Field label="請求の原因" value={l.cause} />
          <Field
            label="契約"
            value={
              <Button
                size="small"
                appearance="subtle"
                icon={<Open16Regular />}
                onClick={() => navigate(`/contracts/${l.contract_id}`)}
              >
                契約を開く（{l.contract_no}）
              </Button>
            }
          />
        </div>
      </div>

      <div className={s.panel}>
        <div className={s.panelHead}>
          <Subtitle2>当事者（{data.parties.length}）</Subtitle2>
          <div className={s.spacer} />
          <Button size="small" appearance="secondary" icon={<Add20Regular />} onClick={openAddParty}>
            当事者を追加
          </Button>
        </div>
        <Table aria-label="当事者" size="small">
          <TableHeader>
            <TableRow>
              <TableHeaderCell>立場</TableHeaderCell>
              <TableHeaderCell>名称</TableHeaderCell>
              <TableHeaderCell>代理人・備考</TableHeaderCell>
              <TableHeaderCell>操作</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.parties.map((p, i) => (
              <TableRow key={p.id ?? i}>
                <TableCell>{p.party_role}</TableCell>
                <TableCell>{p.display_name_snapshot ?? "—"}</TableCell>
                <TableCell>{p.agent_note ?? "—"}</TableCell>
                <TableCell>
                  <Button size="small" appearance="subtle" icon={<Edit20Regular />} onClick={() => openEditParty(p)}>
                    編集
                  </Button>
                  <Button size="small" appearance="subtle" icon={<Delete20Regular />} onClick={() => delPartyRow(p)}>
                    削除
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {data.parties.length === 0 && (
              <TableRow>
                <TableCell colSpan={4}>
                  <Body1>当事者の登録がありません。</Body1>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <div className={s.panel}>
        <div className={s.panelHead}>
          <Subtitle2>期日（{data.schedules.length}）</Subtitle2>
          <div className={s.spacer} />
          <Button size="small" appearance="secondary" icon={<Add20Regular />} onClick={openAddSchedule}>
            期日を追加
          </Button>
        </div>
        <Table aria-label="期日" size="small">
          <TableHeader>
            <TableRow>
              <TableHeaderCell>種別</TableHeaderCell>
              <TableHeaderCell>日時</TableHeaderCell>
              <TableHeaderCell>場所</TableHeaderCell>
              <TableHeaderCell>出席者</TableHeaderCell>
              <TableHeaderCell>結果</TableHeaderCell>
              <TableHeaderCell>操作</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.schedules.map((sc, i) => (
              <TableRow key={sc.id ?? i}>
                <TableCell>{sc.schedule_type}</TableCell>
                <TableCell>{fmtDateTime(sc.scheduled_at)}</TableCell>
                <TableCell>{sc.place ?? "—"}</TableCell>
                <TableCell>{sc.attendee ?? "—"}</TableCell>
                <TableCell>{sc.result ?? "—"}</TableCell>
                <TableCell>
                  <Button size="small" appearance="subtle" icon={<Edit20Regular />} onClick={() => openEditSchedule(sc)}>
                    編集
                  </Button>
                  <Button size="small" appearance="subtle" icon={<Delete20Regular />} onClick={() => delScheduleRow(sc)}>
                    削除
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {data.schedules.length === 0 && (
              <TableRow>
                <TableCell colSpan={6}>
                  <Body1>期日の登録がありません。</Body1>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <div className={s.panel}>
        <div className={s.panelHead}>
          <Subtitle2>提出書類（{data.documents.length}）</Subtitle2>
          <div className={s.spacer} />
          <Button size="small" appearance="secondary" icon={<Add20Regular />} onClick={openAddDocument}>
            書類を追加
          </Button>
        </div>
        <Table aria-label="提出書類" size="small">
          <TableHeader>
            <TableRow>
              <TableHeaderCell>書類名</TableHeaderCell>
              <TableHeaderCell>提出側</TableHeaderCell>
              <TableHeaderCell>期限</TableHeaderCell>
              <TableHeaderCell>提出日</TableHeaderCell>
              <TableHeaderCell>状態</TableHeaderCell>
              <TableHeaderCell>操作</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.documents.map((d, i) => (
              <TableRow key={d.id ?? i}>
                <TableCell>{d.doc_name}</TableCell>
                <TableCell>{d.side ?? "—"}</TableCell>
                <TableCell>{fmtDate(d.due_on)}</TableCell>
                <TableCell>{fmtDate(d.filed_on)}</TableCell>
                <TableCell>{d.state ?? "—"}</TableCell>
                <TableCell>
                  <Button size="small" appearance="subtle" icon={<Edit20Regular />} onClick={() => openEditDocument(d)}>
                    編集
                  </Button>
                  <Button size="small" appearance="subtle" icon={<Delete20Regular />} onClick={() => delDocumentRow(d)}>
                    削除
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {data.documents.length === 0 && (
              <TableRow>
                <TableCell colSpan={6}>
                  <Body1>提出書類の登録がありません。</Body1>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <div className={s.panel}>
        <div className={s.panelHead}>
          <Subtitle2>経過メモ（{data.memos.length}）</Subtitle2>
          <div className={s.spacer} />
          <Button size="small" appearance="secondary" icon={<Add20Regular />} onClick={openAddMemo}>
            メモを追加
          </Button>
        </div>
        <Table aria-label="経過メモ" size="small">
          <TableHeader>
            <TableRow>
              <TableHeaderCell>日付</TableHeaderCell>
              <TableHeaderCell>内容</TableHeaderCell>
              <TableHeaderCell>操作</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.memos.map((m, i) => (
              <TableRow key={m.id ?? i}>
                <TableCell>{fmtDate(m.memo_on)}</TableCell>
                <TableCell>{m.note}</TableCell>
                <TableCell>
                  <Button size="small" appearance="subtle" icon={<Edit20Regular />} onClick={() => openEditMemo(m)}>
                    編集
                  </Button>
                  <Button size="small" appearance="subtle" icon={<Delete20Regular />} onClick={() => delMemoRow(m)}>
                    削除
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {data.memos.length === 0 && (
              <TableRow>
                <TableCell colSpan={3}>
                  <Body1>経過メモの登録がありません。</Body1>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {dlg && (
        <FormDialog
          open
          title={dlg.title}
          fields={dlg.fields}
          initial={dlg.initial}
          submitLabel={dlg.submitLabel}
          onSubmit={dlg.onSubmit}
          onClose={() => setDlg(null)}
        />
      )}
      {confirm && (
        <ConfirmDialog
          open
          title={confirm.title}
          message={confirm.message}
          confirmLabel="実行する"
          onConfirm={confirm.onConfirm}
          onClose={() => setConfirm(null)}
        />
      )}
    </div>
  );
}
