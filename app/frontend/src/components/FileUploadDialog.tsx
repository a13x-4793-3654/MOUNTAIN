import { useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogSurface,
  DialogBody,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Dropdown,
  Option,
  Switch,
  Field,
  Spinner,
  MessageBar,
  MessageBarBody,
  Text,
} from "@fluentui/react-components";
import { SelectOption } from "./FormDialog";
import { uploadContractFile, uploadFileContent } from "../api/client";
import { fmtFileSize } from "../util/format";

/**
 * 実ファイルのアップロード用ダイアログ。
 *  - 新規登録：contractId（固定）または contractOptions（選択）＋ファイル＋種別＋保護
 *  - 実ファイル追加：attachFileId を指定するとファイル選択のみ（既存レコードに実体を付与）
 */
export default function FileUploadDialog({
  open,
  onClose,
  onDone,
  contractId,
  contractOptions,
  tagOptions,
  attachFileId,
  attachFileName,
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
  contractId?: string;
  contractOptions?: SelectOption[];
  tagOptions?: SelectOption[];
  attachFileId?: string;
  attachFileName?: string;
}) {
  const isAttach = !!attachFileId;
  const [file, setFile] = useState<File | null>(null);
  const [contract, setContract] = useState<string>(contractId ?? "");
  const [tag, setTag] = useState<string>("");
  const [protectedFlag, setProtectedFlag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setFile(null);
      setContract(contractId ?? "");
      setTag("");
      setProtectedFlag(false);
      setError(null);
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const title = isAttach ? "実ファイルを追加" : "ファイルを登録（アップロード）";

  async function submit() {
    if (!file) {
      setError("ファイルを選択してください");
      return;
    }
    if (!isAttach && contractOptions && !contract) {
      setError("契約を選んでください");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (isAttach) {
        await uploadFileContent(attachFileId!, file);
      } else {
        const cid = contractId ?? contract;
        await uploadContractFile(cid, file, tag || null, protectedFlag);
      }
      onDone();
      onClose();
    } catch (e: any) {
      setError(e?.message ?? "アップロードに失敗しました");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(_, d) => { if (!d.open && !busy) onClose(); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{title}</DialogTitle>
          <DialogContent>
            {error && (
              <MessageBar intent="error" style={{ marginBottom: 12 }}>
                <MessageBarBody>{error}</MessageBarBody>
              </MessageBar>
            )}
            <div style={{ display: "grid", rowGap: 12, paddingTop: 4 }}>
              {isAttach && attachFileName && (
                <Text size={200} style={{ color: "#555" }}>
                  対象：{attachFileName}
                </Text>
              )}

              {!isAttach && contractOptions && (
                <Field label="契約" required>
                  <Dropdown
                    placeholder="契約を選んでください"
                    value={contractOptions.find((o) => o.value === contract)?.label ?? ""}
                    selectedOptions={[contract]}
                    onOptionSelect={(_, d) => setContract(d.optionValue ?? "")}
                  >
                    {contractOptions.map((o) => (
                      <Option key={o.value} value={o.value}>
                        {o.label}
                      </Option>
                    ))}
                  </Dropdown>
                </Field>
              )}

              <Field label="ファイル" required hint="PDF・画像・Excel・Word などを選べます（上限30MB）">
                <input
                  ref={inputRef}
                  type="file"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                />
              </Field>
              {file && (
                <Text size={200} style={{ color: "#555" }}>
                  選択中：{file.name}（{fmtFileSize(file.size)}）
                </Text>
              )}

              {!isAttach && tagOptions && (
                <Field label="種別">
                  <Dropdown
                    placeholder="選択してください"
                    value={tagOptions.find((o) => o.value === tag)?.label ?? ""}
                    selectedOptions={[tag]}
                    onOptionSelect={(_, d) => setTag(d.optionValue ?? "")}
                  >
                    {tagOptions.map((o) => (
                      <Option key={o.value} value={o.value}>
                        {o.label}
                      </Option>
                    ))}
                  </Dropdown>
                </Field>
              )}

              {!isAttach && (
                <Field label="パスワード保護（機微・要承認）">
                  <Switch
                    checked={protectedFlag}
                    onChange={(_, d) => setProtectedFlag(d.checked)}
                  />
                </Field>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose} disabled={busy}>
              キャンセル
            </Button>
            <Button appearance="primary" onClick={submit} disabled={busy}>
              {busy ? <Spinner size="tiny" /> : isAttach ? "追加する" : "登録する"}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
