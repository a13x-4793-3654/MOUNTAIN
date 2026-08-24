import { ReactNode, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  makeStyles,
  tokens,
  Title3,
  Subtitle2,
  Button,
  Spinner,
  MessageBar,
  MessageBarBody,
} from "@fluentui/react-components";
import { ArrowLeft20Regular, Edit20Regular, Delete20Regular } from "@fluentui/react-icons";
import {
  fetchPerson,
  PersonDetail as Detail,
  updatePerson,
  deletePerson,
} from "../api/client";
import { fmtDate } from "../util/format";
import LinkedContracts from "../components/LinkedContracts";
import FormDialog from "../components/FormDialog";
import ConfirmDialog from "../components/ConfirmDialog";
import { PERSON_FIELDS, toPersonIn, personToForm } from "../util/formSchemas";

const useStyles = makeStyles({
  topbar: { display: "flex", alignItems: "center", columnGap: "8px", marginBottom: "12px" },
  headCard: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: "16px",
    marginBottom: "12px",
  },
  name: { fontWeight: 700 },
  panel: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: "16px",
    marginBottom: "12px",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "160px 1fr",
    rowGap: "10px",
    columnGap: "12px",
    maxWidth: "760px",
  },
  label: { color: tokens.colorNeutralForeground3 },
  section: { marginTop: "4px", marginBottom: "8px" },
});

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  const s = useStyles();
  return (
    <>
      <div className={s.label}>{label}</div>
      <div>{children}</div>
    </>
  );
}

export default function PersonDetail() {
  const s = useStyles();
  const navigate = useNavigate();
  const { id } = useParams();
  const [data, setData] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  function load() {
    if (!id) return;
    setLoading(true);
    fetchPerson(id)
      .then((d) => setData(d))
      .catch((e) => setError(e?.message ?? "読み込みに失敗しました"))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        <MessageBarBody>{error ?? "名義が見つかりません"}</MessageBarBody>
      </MessageBar>
    );
  }

  const p = data.person;
  const addr =
    (p.prefecture ?? "") + (p.city ?? "") + (p.address1 ?? "") + (p.address2 ?? "");

  return (
    <div>
      <div className={s.topbar}>
        <Button
          appearance="subtle"
          icon={<ArrowLeft20Regular />}
          onClick={() => navigate("/persons")}
        >
          名義一覧へ戻る
        </Button>
        <div style={{ flexGrow: 1 }} />
        <Button icon={<Edit20Regular />} onClick={() => setEditOpen(true)}>
          編集
        </Button>
        <Button
          icon={<Delete20Regular />}
          appearance="subtle"
          onClick={() => setDeleteOpen(true)}
        >
          削除
        </Button>
      </div>

      <div className={s.headCard}>
        <Title3 className={s.name}>{p.full_name}</Title3>
        {p.full_name_kana && (
          <div className={s.label} style={{ marginTop: 4 }}>
            {p.full_name_kana}
          </div>
        )}
      </div>

      <div className={s.panel}>
        <Subtitle2 className={s.section}>基本情報</Subtitle2>
        <div className={s.grid}>
          <InfoRow label="生年月日">{fmtDate(p.birth_date)}</InfoRow>
          <InfoRow label="郵便番号">{p.postal_code ?? "—"}</InfoRow>
          <InfoRow label="住所">{addr || "—"}</InfoRow>
        </div>
      </div>

      <div className={s.panel}>
        <Subtitle2 className={s.section}>関連する契約</Subtitle2>
        <LinkedContracts contracts={data.contracts} />
      </div>

      <FormDialog
        open={editOpen}
        title="名義情報の編集"
        fields={PERSON_FIELDS}
        initial={personToForm(p)}
        onSubmit={async (v) => {
          await updatePerson(p.id, toPersonIn(v));
          load();
        }}
        onClose={() => setEditOpen(false)}
      />
      <ConfirmDialog
        open={deleteOpen}
        title="名義の削除"
        message={`「${p.full_name}」を削除します。よろしいですか？（契約に紐づいている場合は削除できません）`}
        onConfirm={async () => {
          await deletePerson(p.id);
          navigate("/persons");
        }}
        onClose={() => setDeleteOpen(false)}
      />
    </div>
  );
}
