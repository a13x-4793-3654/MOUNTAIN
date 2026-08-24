import { useEffect, useState } from "react";
import {
  makeStyles,
  tokens,
  Title3,
  Subtitle2,
  Body1,
  Text,
  TabList,
  Tab,
  Button,
  Badge,
  Input,
  Spinner,
  Table,
  TableHeader,
  TableHeaderCell,
  TableRow,
  TableBody,
  TableCell,
  MessageBar,
  MessageBarBody,
  Dialog,
  DialogSurface,
  DialogBody,
  DialogTitle,
  DialogContent,
  DialogActions,
} from "@fluentui/react-components";
import {
  Call20Regular,
  CallInbound20Regular,
  ArrowClockwise20Regular,
  Play20Regular,
  Speaker220Regular,
  Delete16Regular,
  Checkmark16Regular,
} from "@fluentui/react-icons";
import { useNavigate } from "react-router-dom";
import CtiCallsList from "./CtiCallsList";
import { useAuth } from "../auth/AuthContext";
import { getRuntimeConfig } from "../auth/runtimeConfig";
import { sipService } from "../telephony/sipService";
import { useSipState } from "../telephony/useSipState";
import {
  Presence,
  CtiContact,
  Voicemail,
  Announcement,
  fetchPresence,
  setPresence as apiSetPresence,
  fetchCtiContacts,
  originateCall,
  simulateIncoming,
  fetchVoicemails,
  markVoicemailHeard,
  deleteVoicemail,
  fetchAnnouncements,
  uploadAnnouncementAudio,
} from "../api/client";
import {
  presenceLabel,
  presenceColor,
  fmtDateTime,
  fmtDuration,
  mailboxLabel,
  phoneTypeLabel,
} from "../util/format";

const useStyles = makeStyles({
  header: { marginBottom: "4px" },
  crumb: { color: tokens.colorNeutralForeground3, fontSize: "12px", marginBottom: "12px" },
  tabs: { marginBottom: "16px" },
  grid: { display: "grid", gridTemplateColumns: "320px 1fr", columnGap: "24px", rowGap: "16px" },
  card: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: "16px",
  },
  sectionTitle: { marginBottom: "12px" },
  presenceRow: { display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "8px", marginTop: "12px" },
  presenceBtn: { width: "100%" },
  dialInput: {
    width: "100%",
    "& input": {
      fontVariantNumeric: "tabular-nums",
      fontSize: "20px",
      fontWeight: 700,
      textAlign: "center",
      letterSpacing: "1px",
      height: "40px",
    },
    "& input::placeholder": {
      fontSize: "13px",
      fontWeight: 400,
      letterSpacing: "normal",
    },
  },
  pad: { display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "8px", marginTop: "8px" },
  padKey: { minWidth: 0, height: "48px", fontSize: "18px", fontWeight: 600 },
  dialActions: { display: "flex", gap: "8px", marginTop: "12px", flexWrap: "wrap" },
  toolbar: { display: "flex", gap: "8px", alignItems: "center", marginBottom: "12px", flexWrap: "wrap" },
  count: { color: tokens.colorNeutralForeground3, fontSize: "12px" },
  mono: { fontVariantNumeric: "tabular-nums" },
  unheard: { fontWeight: 700 },
  rowActions: { display: "flex", gap: "6px" },
});

const PRESENCE_OPTIONS = ["available", "busy", "dnd", "away"];
const DIAL_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"];

type TabKey = "dial" | "history" | "voicemail" | "announce";

export default function Cti() {
  const s = useStyles();
  const navigate = useNavigate();
  const [tab, setTab] = useState<TabKey>("dial");

  // 実ソフトフォン（JsSIP直結）モードか、シミュレータかを判定
  const { me } = useAuth();
  const realMode = !!getRuntimeConfig().sip.wss_url && !!me?.cti_ext_num?.trim();
  const sip = useSipState();

  // ---- 発信・在席 ----
  const [presence, setPresence] = useState<Presence | null>(null);
  const [contacts, setContacts] = useState<CtiContact[]>([]);
  const [dialNo, setDialNo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [loadingTop, setLoadingTop] = useState(false);

  // ---- 留守電 ----
  const [voicemails, setVoicemails] = useState<Voicemail[]>([]);
  const [vmLoading, setVmLoading] = useState(false);

  // ---- アナウンス ----
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [annEdit, setAnnEdit] = useState<Announcement | null>(null);
  const [annFileObj, setAnnFileObj] = useState<File | null>(null);
  const [annUploading, setAnnUploading] = useState(false);

  async function loadTop() {
    setLoadingTop(true);
    setError(null);
    try {
      const [p, c] = await Promise.all([fetchPresence(), fetchCtiContacts()]);
      setPresence(p);
      setContacts(c.items);
    } catch (e: any) {
      setError(e?.message ?? "読み込みに失敗しました");
    } finally {
      setLoadingTop(false);
    }
  }

  async function loadVoicemails() {
    setVmLoading(true);
    try {
      const r = await fetchVoicemails();
      setVoicemails(r.items);
    } catch (e: any) {
      setError(e?.message ?? "読み込みに失敗しました");
    } finally {
      setVmLoading(false);
    }
  }

  async function loadAnnouncements() {
    try {
      const r = await fetchAnnouncements();
      setAnnouncements(r.items);
    } catch (e: any) {
      setError(e?.message ?? "読み込みに失敗しました");
    }
  }

  useEffect(() => {
    loadTop();
    loadVoicemails();
    loadAnnouncements();
  }, []);

  function flash(msg: string) {
    setInfo(msg);
    setError(null);
    setTimeout(() => setInfo(null), 4000);
  }

  async function changePresence(status: string) {
    try {
      if (realMode) {
        await sipService.setPresence(status as any);
        setPresence({ status, label: presenceLabel(status) });
      } else {
        const p = await apiSetPresence(status);
        setPresence(p);
      }
    } catch (e: any) {
      setError(e?.message ?? "在席状況の変更に失敗しました");
    }
  }

  async function doOriginate(number: string, name?: string | null) {
    const num = number.trim();
    if (!num) return;
    setError(null);
    // 実モード：ブラウザから交換機へ直接発信（JsSIP）
    if (realMode) {
      if (sip.regState !== "registered") {
        setError("電話がまだ使えません（接続中）。少し待ってからお試しください。");
        return;
      }
      sipService.call(num);
      flash(`発信しました：${name ? `${name}（${num}）` : num}。下部の通話バーで操作できます。`);
      setDialNo("");
      return;
    }
    try {
      await originateCall({ number: num, contact_name: name ?? null });
      flash(`発信しました：${name ? `${name}（${num}）` : num}。下部の通話バーで操作できます。`);
      setDialNo("");
    } catch (e: any) {
      setError(e?.message ?? "発信に失敗しました");
    }
  }

  async function doSimulate() {
    setError(null);
    try {
      await simulateIncoming();
      flash("着信をシミュレートしました。画面下部の通話バーで『応答』または『拒否』ができます（検証用）。");
    } catch (e: any) {
      setError(e?.message ?? "着信シミュレートに失敗しました");
    }
  }

  return (
    <div>
      <div className={s.header}>
        <Title3>電話・CTI</Title3>
      </div>
      <div className={s.crumb}>
        電話の発信・在席状況・留守電・アナウンスを管理します。通話中の操作（保留・転送・プッシュ・切電）は画面下部の通話バーで行います。
      </div>

      {error && (
        <MessageBar intent="error" style={{ marginBottom: 12 }}>
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}
      {info && (
        <MessageBar intent="success" style={{ marginBottom: 12 }}>
          <MessageBarBody>{info}</MessageBarBody>
        </MessageBar>
      )}

      <TabList
        className={s.tabs}
        selectedValue={tab}
        onTabSelect={(_, d) => setTab(d.value as TabKey)}
      >
        <Tab value="dial">発信・在席状況</Tab>
        <Tab value="history">通話履歴</Tab>
        <Tab value="voicemail">
          留守電
          {voicemails.some((v) => !v.is_heard) && (
            <Badge appearance="filled" color="danger" style={{ marginLeft: 6 }}>
              {voicemails.filter((v) => !v.is_heard).length}
            </Badge>
          )}
        </Tab>
        <Tab value="announce">アナウンス</Tab>
      </TabList>

      {tab === "dial" && (
        <div className={s.grid}>
          {/* 在席状況 + ダイヤルパッド */}
          <div>
            <div className={s.card} style={{ marginBottom: 16 }}>
              <Subtitle2 className={s.sectionTitle}>在席状況</Subtitle2>
              <div>
                現在：
                <Badge appearance="filled" color={presenceColor(presence?.status)} style={{ marginLeft: 8 }}>
                  {presenceLabel(presence?.status)}
                </Badge>
              </div>
              <div className={s.presenceRow}>
                {PRESENCE_OPTIONS.map((p) => (
                  <Button
                    key={p}
                    size="small"
                    className={s.presenceBtn}
                    appearance={presence?.status === p ? "primary" : "secondary"}
                    onClick={() => changePresence(p)}
                  >
                    {presenceLabel(p)}
                  </Button>
                ))}
              </div>
            </div>

            <div className={s.card}>
              <Subtitle2 className={s.sectionTitle}>ダイヤル発信</Subtitle2>
              <Input
                className={s.dialInput}
                value={dialNo}
                onChange={(_, d) =>
                  setDialNo(d.value.replace(/[^0-9*#+]/g, ""))
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter" && dialNo.trim()) doOriginate(dialNo);
                }}
                input={{ autoFocus: true, inputMode: "tel" }}
                placeholder="番号を入力（キーボードでも入力できます）"
                aria-label="発信する電話番号"
              />
              <div className={s.pad}>
                {DIAL_KEYS.map((k) => (
                  <Button
                    key={k}
                    className={s.padKey}
                    appearance="outline"
                    onClick={() => setDialNo((v) => v + k)}
                  >
                    {k}
                  </Button>
                ))}
              </div>
              <div className={s.dialActions}>
                <Button appearance="secondary" style={{ minWidth: 0 }} onClick={() => setDialNo((v) => v.slice(0, -1))}>
                  ⌫ 消す
                </Button>
                <Button appearance="secondary" style={{ minWidth: 0 }} onClick={() => setDialNo("")}>
                  クリア
                </Button>
                <Button
                  appearance="primary"
                  icon={<Call20Regular />}
                  disabled={!dialNo.trim()}
                  style={{ marginLeft: "auto", minWidth: 0 }}
                  onClick={() => doOriginate(dialNo)}
                >
                  発信
                </Button>
              </div>
            </div>
          </div>

          {/* クリック発信の連絡先 */}
          <div className={s.card}>
            <div className={s.toolbar}>
              <Subtitle2>連絡先から発信</Subtitle2>
              <span className={s.count}>{loadingTop ? "読み込み中…" : `${contacts.length} 件`}</span>
              {!realMode && (
                <Button
                  size="small"
                  appearance="secondary"
                  icon={<CallInbound20Regular />}
                  onClick={doSimulate}
                  style={{ marginLeft: "auto" }}
                  title="検証用：着信が来た状態を再現します"
                >
                  着信をシミュレート
                </Button>
              )}
              <Button size="small" appearance="secondary" icon={<ArrowClockwise20Regular />} onClick={loadTop} style={realMode ? { marginLeft: "auto" } : undefined}>
                更新
              </Button>
            </div>
            {loadingTop && contacts.length === 0 ? (
              <Spinner label="読み込み中…" />
            ) : (
              <Table aria-label="連絡先" size="small">
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>会社</TableHeaderCell>
                    <TableHeaderCell>電話番号</TableHeaderCell>
                    <TableHeaderCell>用途</TableHeaderCell>
                    <TableHeaderCell />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {contacts.map((c, i) => (
                    <TableRow key={`${c.number}-${i}`}>
                      <TableCell>
                        {c.name}
                        {c.is_primary && (
                          <Badge appearance="tint" color="brand" style={{ marginLeft: 6 }}>
                            代表
                          </Badge>
                        )}
                        {c.is_blocked && (
                          <Badge appearance="tint" color="danger" style={{ marginLeft: 6 }}>
                            着信拒否
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className={s.mono}>{c.number}</TableCell>
                      <TableCell>{phoneTypeLabel(c.label)}</TableCell>
                      <TableCell>
                        <Button
                          size="small"
                          appearance="primary"
                          icon={<Call20Regular />}
                          onClick={() => doOriginate(c.number, c.name)}
                        >
                          発信
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                  {contacts.length === 0 && !loadingTop && (
                    <TableRow>
                      <TableCell colSpan={4}>
                        <Body1>連絡先（会社の電話番号）がありません。</Body1>
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            )}
          </div>
        </div>
      )}

      {tab === "history" && <CtiCallsList />}

      {tab === "voicemail" && (
        <div className={s.card}>
          <div className={s.toolbar}>
            <Subtitle2>留守電</Subtitle2>
            <span className={s.count}>{vmLoading ? "読み込み中…" : `${voicemails.length} 件`}</span>
            <Button
              size="small"
              appearance="secondary"
              icon={<ArrowClockwise20Regular />}
              onClick={loadVoicemails}
              style={{ marginLeft: "auto" }}
            >
              更新
            </Button>
          </div>
          {vmLoading && voicemails.length === 0 ? (
            <Spinner label="読み込み中…" />
          ) : (
            <Table aria-label="留守電" size="small">
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>相手</TableHeaderCell>
                  <TableHeaderCell>受信日時</TableHeaderCell>
                  <TableHeaderCell>長さ</TableHeaderCell>
                  <TableHeaderCell>保存先</TableHeaderCell>
                  <TableHeaderCell>状態</TableHeaderCell>
                  <TableHeaderCell>契約</TableHeaderCell>
                  <TableHeaderCell />
                </TableRow>
              </TableHeader>
              <TableBody>
                {voicemails.map((v) => (
                  <TableRow key={v.id}>
                    <TableCell className={!v.is_heard ? s.unheard : undefined}>
                      {v.contact_name || v.from_number || "—"}
                      <div className={s.mono} style={{ fontSize: 12, color: tokens.colorNeutralForeground3 }}>
                        {v.from_number}
                      </div>
                    </TableCell>
                    <TableCell>{fmtDateTime(v.received_at)}</TableCell>
                    <TableCell className={s.mono}>{fmtDuration(v.duration_seconds)}</TableCell>
                    <TableCell>{mailboxLabel(v.mailbox)}</TableCell>
                    <TableCell>
                      {v.is_heard ? (
                        <Badge appearance="tint" color="informative">再生済み</Badge>
                      ) : (
                        <Badge appearance="filled" color="danger">未再生</Badge>
                      )}
                    </TableCell>
                    <TableCell className={s.mono}>
                      {v.contract_no ? (
                        <Button
                          size="small"
                          appearance="subtle"
                          onClick={() => v.contract_id && navigate(`/contracts/${v.contract_id}`)}
                        >
                          {v.contract_no}
                        </Button>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell>
                      <div className={s.rowActions}>
                        <Button
                          size="small"
                          appearance="subtle"
                          icon={<Play20Regular />}
                          disabled
                          title="録音の再生はPBX接続後に有効になります"
                        >
                          再生
                        </Button>
                        {!v.is_heard && (
                          <Button
                            size="small"
                            appearance="subtle"
                            icon={<Checkmark16Regular />}
                            onClick={async () => {
                              await markVoicemailHeard(v.id);
                              loadVoicemails();
                            }}
                          >
                            再生済みにする
                          </Button>
                        )}
                        <Button
                          size="small"
                          appearance="subtle"
                          icon={<Delete16Regular />}
                          onClick={async () => {
                            if (!confirm("この留守電を削除しますか？")) return;
                            await deleteVoicemail(v.id);
                            loadVoicemails();
                          }}
                        >
                          削除
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
                {voicemails.length === 0 && !vmLoading && (
                  <TableRow>
                    <TableCell colSpan={7}>
                      <Body1>留守電はありません。</Body1>
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          )}
        </div>
      )}

      {tab === "announce" && (
        <div className={s.card}>
          <div className={s.toolbar}>
            <Subtitle2>着信アナウンス（ガイダンス）</Subtitle2>
            <Button
              size="small"
              appearance="secondary"
              icon={<ArrowClockwise20Regular />}
              onClick={loadAnnouncements}
              style={{ marginLeft: "auto" }}
            >
              更新
            </Button>
          </div>
          <div className={s.crumb}>
            相手の状態（取り込み中・通話中・離席中）に応じて流す音声ガイダンスです。音声ファイル（WAV
            など）を選んで登録すると、電話交換機（FreePBX）に反映されます。
          </div>
          <Table aria-label="アナウンス" size="small">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>種類</TableHeaderCell>
                <TableHeaderCell>音声ファイル</TableHeaderCell>
                <TableHeaderCell>更新日時</TableHeaderCell>
                <TableHeaderCell />
              </TableRow>
            </TableHeader>
            <TableBody>
              {announcements.map((a) => (
                <TableRow key={a.ann_key}>
                  <TableCell>{a.label}</TableCell>
                  <TableCell className={s.mono}>{a.file_name || "（未設定）"}</TableCell>
                  <TableCell>{fmtDateTime(a.updated_at)}</TableCell>
                  <TableCell>
                    <Button
                      size="small"
                      appearance="secondary"
                      icon={<Speaker220Regular />}
                      onClick={() => {
                        setAnnEdit(a);
                        setAnnFileObj(null);
                      }}
                    >
                      音声を差し替え
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {announcements.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4}>
                    <Body1>アナウンスの設定がありません。</Body1>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={annEdit !== null} onOpenChange={(_, d) => !d.open && setAnnEdit(null)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>音声ガイダンスの差し替え</DialogTitle>
            <DialogContent>
              <Text>{annEdit?.label}</Text>
              <div className={s.crumb} style={{ marginTop: 8 }}>
                現在のファイル：{annEdit?.file_name || "（未設定）"}
              </div>
              <input
                type="file"
                accept="audio/*,.wav"
                style={{ marginTop: 12, width: "100%" }}
                onChange={(e) => setAnnFileObj(e.target.files?.[0] ?? null)}
              />
              <div className={s.crumb} style={{ marginTop: 8 }}>
                音声ファイルを選んで「登録する」を押すと、電話交換機（FreePBX）に反映されます。
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setAnnEdit(null)}>
                やめる
              </Button>
              <Button
                appearance="primary"
                disabled={!annFileObj || annUploading}
                onClick={async () => {
                  if (!annEdit || !annFileObj) return;
                  setAnnUploading(true);
                  try {
                    const r = await uploadAnnouncementAudio(annEdit.ann_key, annFileObj);
                    setAnnEdit(null);
                    setAnnFileObj(null);
                    loadAnnouncements();
                    if (r.pbx?.state === "ok") {
                      flash("音声ガイダンスを登録し、電話交換機に反映しました。");
                    } else if (r.pbx?.state === "skipped") {
                      flash("音声ガイダンスを登録しました。（電話交換機への反映は未設定のため行っていません）");
                    } else {
                      flash(
                        "音声ガイダンスを登録しました。ただし電話交換機への反映に失敗しました：" +
                          (r.pbx?.detail || r.pbx?.reason || "不明なエラー")
                      );
                    }
                  } catch (e: any) {
                    setError(e?.message ?? "差し替えに失敗しました");
                  } finally {
                    setAnnUploading(false);
                  }
                }}
              >
                {annUploading ? "登録中..." : "登録する"}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}
