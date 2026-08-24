import { useState } from "react";
import {
  Dialog,
  DialogSurface,
  DialogBody,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Input,
  Spinner,
  MessageBar,
  MessageBarBody,
  Text,
} from "@fluentui/react-components";
import { Search24Regular } from "@fluentui/react-icons";
import {
  lookupBankSearch,
  lookupBranchSearch,
  BankItem,
} from "../api/client";

export interface BankSelection {
  bank_code: string;
  bank_name: string;
  branch_code?: string;
  branch_name?: string;
}

// 銀行名・支店名から検索して、コードと名称をまとめて拾うダイアログ（逆引き対応）。
export default function BankLookupDialog({
  open,
  onSelect,
  onClose,
}: {
  open: boolean;
  onSelect: (sel: BankSelection) => void;
  onClose: () => void;
}) {
  const [bankKw, setBankKw] = useState("");
  const [banks, setBanks] = useState<BankItem[]>([]);
  const [bank, setBank] = useState<BankItem | null>(null);
  const [branchKw, setBranchKw] = useState("");
  const [branches, setBranches] = useState<BankItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setBankKw("");
    setBanks([]);
    setBank(null);
    setBranchKw("");
    setBranches([]);
    setError(null);
  }

  async function searchBanks() {
    if (!bankKw.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const r = await lookupBankSearch(bankKw.trim());
      setBanks(r.items);
      if (r.items.length === 0) setError("該当する銀行が見つかりませんでした");
    } catch {
      setError("銀行検索に接続できませんでした");
    } finally {
      setBusy(false);
    }
  }

  async function pickBank(b: BankItem) {
    setBank(b);
    setBranches([]);
    setBranchKw("");
    setError(null);
  }

  async function searchBranches() {
    if (!bank || !branchKw.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const r = await lookupBranchSearch(bank.code, branchKw.trim());
      setBranches(r.items);
      if (r.items.length === 0) setError("該当する支店が見つかりませんでした");
    } catch {
      setError("支店検索に接続できませんでした");
    } finally {
      setBusy(false);
    }
  }

  function chooseBranch(br: BankItem) {
    if (!bank) return;
    onSelect({
      bank_code: bank.code,
      bank_name: bank.name,
      branch_code: br.code,
      branch_name: br.name,
    });
    reset();
    onClose();
  }

  function chooseBankOnly() {
    if (!bank) return;
    onSelect({ bank_code: bank.code, bank_name: bank.name });
    reset();
    onClose();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(_, d) => {
        if (!d.open) {
          reset();
          onClose();
        }
      }}
    >
      <DialogSurface>
        <DialogBody>
          <DialogTitle>銀行・支店を検索</DialogTitle>
          <DialogContent>
            {error && (
              <MessageBar intent="warning" style={{ marginBottom: 12 }}>
                <MessageBarBody>{error}</MessageBarBody>
              </MessageBar>
            )}

            {/* 銀行の検索 */}
            <Text weight="semibold">1. 銀行名で検索</Text>
            <div style={{ display: "flex", gap: 8, margin: "6px 0 10px" }}>
              <Input
                style={{ flex: 1 }}
                placeholder="例）みずほ / 三菱UFJ / ゆうちょ"
                value={bankKw}
                onChange={(_, d) => setBankKw(d.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") searchBanks();
                }}
              />
              <Button icon={<Search24Regular />} onClick={searchBanks} disabled={busy}>
                検索
              </Button>
            </div>
            {!bank && banks.length > 0 && (
              <div style={{ maxHeight: 160, overflowY: "auto", border: "1px solid #eee", borderRadius: 4 }}>
                {banks.map((b) => (
                  <div
                    key={b.code}
                    onClick={() => pickBank(b)}
                    style={{ padding: "6px 10px", cursor: "pointer", borderBottom: "1px solid #f3f3f3" }}
                  >
                    {b.name}（{b.code}）<span style={{ color: "#888" }}>{b.kana}</span>
                  </div>
                ))}
              </div>
            )}

            {/* 支店の検索 */}
            {bank && (
              <>
                <div style={{ margin: "8px 0" }}>
                  <Text weight="semibold">選択中の銀行：</Text> {bank.name}（{bank.code}）
                  <Button size="small" appearance="subtle" onClick={() => setBank(null)} style={{ marginLeft: 8 }}>
                    選び直す
                  </Button>
                </div>
                <Text weight="semibold">2. 支店名で検索</Text>
                <div style={{ display: "flex", gap: 8, margin: "6px 0 10px" }}>
                  <Input
                    style={{ flex: 1 }}
                    placeholder="例）新宿 / 本店 / 渋谷"
                    value={branchKw}
                    onChange={(_, d) => setBranchKw(d.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") searchBranches();
                    }}
                  />
                  <Button icon={<Search24Regular />} onClick={searchBranches} disabled={busy}>
                    検索
                  </Button>
                </div>
                {branches.length > 0 && (
                  <div style={{ maxHeight: 160, overflowY: "auto", border: "1px solid #eee", borderRadius: 4 }}>
                    {branches.map((br) => (
                      <div
                        key={br.code}
                        onClick={() => chooseBranch(br)}
                        style={{ padding: "6px 10px", cursor: "pointer", borderBottom: "1px solid #f3f3f3" }}
                      >
                        {br.name}（{br.code}）<span style={{ color: "#888" }}>{br.kana}</span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
            {busy && <Spinner size="tiny" style={{ marginTop: 8 }} />}
          </DialogContent>
          <DialogActions>
            {bank && (
              <Button appearance="secondary" onClick={chooseBankOnly}>
                この銀行だけ反映
              </Button>
            )}
            <Button appearance="secondary" onClick={onClose}>
              閉じる
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
