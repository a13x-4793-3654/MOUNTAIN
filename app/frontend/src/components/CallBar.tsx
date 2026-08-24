import { useCallback, useEffect, useRef, useState } from "react";
import {
  makeStyles,
  tokens,
  Button,
  Badge,
  Text,
  Popover,
  PopoverTrigger,
  PopoverSurface,
  Dialog,
  DialogSurface,
  DialogBody,
  DialogTitle,
  DialogContent,
  DialogActions,
  Input,
} from "@fluentui/react-components";
import {
  Pause20Regular,
  Play20Regular,
  Dialpad20Regular,
  CallTransfer20Regular,
  CallEnd20Filled,
  Call20Filled,
  CallInbound20Regular,
  CallOutbound20Regular,
} from "@fluentui/react-icons";
import {
  ActiveCall,
  fetchActiveCall,
  holdCall,
  unholdCall,
  dtmfCall,
  transferCall,
  hangupCall,
  answerCall,
} from "../api/client";
import { fmtClock } from "../util/format";

const useStyles = makeStyles({
  bar: {
    position: "fixed",
    left: "50%",
    bottom: "18px",
    transform: "translateX(-50%)",
    zIndex: 1000,
    display: "flex",
    alignItems: "center",
    columnGap: "14px",
    padding: "10px 16px",
    minWidth: "520px",
    maxWidth: "calc(100vw - 48px)",
    borderRadius: tokens.borderRadiusXLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    boxShadow: tokens.shadow28,
  },
  who: { display: "flex", flexDirection: "column", minWidth: "160px" },
  name: { fontWeight: 600, fontSize: "14px" },
  num: {
    fontVariantNumeric: "tabular-nums",
    color: tokens.colorNeutralForeground3,
    fontSize: "12px",
  },
  clock: {
    fontVariantNumeric: "tabular-nums",
    fontSize: "18px",
    fontWeight: 700,
    minWidth: "62px",
    textAlign: "center",
  },
  spacer: { flex: 1 },
  actions: { display: "flex", columnGap: "8px", alignItems: "center" },
  pad: {
    display: "grid",
    gridTemplateColumns: "repeat(3, 44px)",
    gap: "8px",
    padding: "4px",
  },
  padKey: {
    minWidth: "44px",
    height: "44px",
    fontSize: "16px",
    fontWeight: 600,
  },
  dir: { display: "flex", alignItems: "center", columnGap: "6px" },
});

const DTMF_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"];

export default function CallBar() {
  const s = useStyles();
  const [active, setActive] = useState<ActiveCall | null>(null);
  const [busy, setBusy] = useState(false);
  const [xferOpen, setXferOpen] = useState(false);
  const [xferTo, setXferTo] = useState("");
  const mounted = useRef(true);

  const poll = useCallback(async () => {
    try {
      const res = await fetchActiveCall();
      if (mounted.current) setActive(res.active);
    } catch {
      /* 通信失敗時は次のポーリングで回復 */
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    poll();
    const t = setInterval(poll, 1200);
    return () => {
      mounted.current = false;
      clearInterval(t);
    };
  }, [poll]);

  if (!active) return null;

  const connected = active.is_connected;
  const held = active.is_on_hold;
  const ringingIn = !connected && (active.is_incoming === true || active.direction === "in");

  async function withBusy(fn: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } catch (e: any) {
      alert(e?.message ?? "操作に失敗しました");
    } finally {
      if (mounted.current) setBusy(false);
      poll();
    }
  }

  const a = active;

  return (
    <div className={s.bar} role="region" aria-label="通話操作バー">
      <div className={s.dir}>
        {a.direction === "out" ? (
          <CallOutbound20Regular style={{ color: tokens.colorBrandForeground1 }} />
        ) : (
          <CallInbound20Regular style={{ color: tokens.colorPaletteGreenForeground1 }} />
        )}
      </div>
      <div className={s.who}>
        <span className={s.name}>{a.contact_name || a.number || "—"}</span>
        <span className={s.num}>
          {a.number}
          {a.contract_no ? ` ・ 契約 ${a.contract_no}` : ""}
        </span>
      </div>
      <Badge
        appearance="tint"
        color={held ? "warning" : connected ? "success" : "informative"}
      >
        {a.state_label}
      </Badge>
      <span className={s.clock}>{fmtClock(a.elapsed_seconds)}</span>
      <div className={s.spacer} />
      <div className={s.actions}>
        {ringingIn && (
          <Button
            appearance="primary"
            icon={<Call20Filled />}
            style={{
              backgroundColor: tokens.colorPaletteGreenBackground3,
              borderColor: tokens.colorPaletteGreenBackground3,
            }}
            disabled={busy}
            onClick={() => withBusy(() => answerCall(a.id))}
          >
            応答
          </Button>
        )}
        {connected && !held && (
          <Button
            appearance="secondary"
            icon={<Pause20Regular />}
            disabled={busy}
            onClick={() => withBusy(() => holdCall(a.id))}
          >
            保留
          </Button>
        )}
        {held && (
          <Button
            appearance="secondary"
            icon={<Play20Regular />}
            disabled={busy}
            onClick={() => withBusy(() => unholdCall(a.id))}
          >
            保留解除
          </Button>
        )}
        {!ringingIn && (
          <Popover positioning="above" withArrow>
            <PopoverTrigger disableButtonEnhancement>
              <Button
                appearance="secondary"
                icon={<Dialpad20Regular />}
                disabled={busy || !connected}
                title={connected ? "プッシュ操作" : "通話がつながると使えます"}
              >
                プッシュ
              </Button>
            </PopoverTrigger>
            <PopoverSurface>
              <div className={s.pad}>
                {DTMF_KEYS.map((k) => (
                  <Button
                    key={k}
                    className={s.padKey}
                    appearance="outline"
                    disabled={busy}
                    onClick={() => withBusy(() => dtmfCall(a.id, k))}
                  >
                    {k}
                  </Button>
                ))}
              </div>
            </PopoverSurface>
          </Popover>
        )}
        {!ringingIn && (
          <Button
            appearance="secondary"
            icon={<CallTransfer20Regular />}
            disabled={busy || !connected}
            onClick={() => {
              setXferTo("");
              setXferOpen(true);
            }}
          >
            転送
          </Button>
        )}
        <Button
          appearance="primary"
          style={{
            backgroundColor: tokens.colorPaletteRedBackground3,
            borderColor: tokens.colorPaletteRedBackground3,
          }}
          icon={<CallEnd20Filled />}
          disabled={busy}
          onClick={() => withBusy(() => hangupCall(a.id).then(() => setActive(null)))}
        >
          {ringingIn ? "拒否" : "切電"}
        </Button>
      </div>

      <Dialog open={xferOpen} onOpenChange={(_, d) => setXferOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>転送先を指定</DialogTitle>
            <DialogContent>
              <Text>転送先の電話番号または内線を入力してください。</Text>
              <Input
                style={{ marginTop: 12, width: "100%" }}
                value={xferTo}
                onChange={(_, d) => setXferTo(d.value)}
                placeholder="例：03-1234-5678 / 内線 101"
              />
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setXferOpen(false)}>
                やめる
              </Button>
              <Button
                appearance="primary"
                icon={<CallTransfer20Regular />}
                disabled={busy || !xferTo.trim()}
                onClick={() =>
                  withBusy(() =>
                    transferCall(a.id, xferTo.trim()).then(() => {
                      setXferOpen(false);
                      setActive(null);
                    })
                  )
                }
              >
                転送する
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}
