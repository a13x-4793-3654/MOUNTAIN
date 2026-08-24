// 実ソフトフォン（JsSIP）駆動の通話バー。sipService の状態を useSipState で購読し、
// 応答/切電/保留/ミュート/プッシュ(DTMF)/転送 を交換機へ直接指示する。
// 発信元番号は /api/cti/lookup で会社・契約に照会し、画面に表示（スクリーンポップ）。
import { useEffect, useRef, useState } from "react";
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
  MessageBar,
  MessageBarBody,
} from "@fluentui/react-components";
import {
  Pause20Regular,
  Play20Regular,
  Dialpad20Regular,
  CallTransfer20Regular,
  CallEnd20Filled,
  Call20Filled,
  Dismiss20Regular,
  Mic20Regular,
  MicOff20Regular,
  CallInbound20Regular,
  CallOutbound20Regular,
} from "@fluentui/react-icons";
import { useNavigate } from "react-router-dom";
import { sipService } from "../telephony/sipService";
import { useSipState } from "../telephony/useSipState";
import { lookupNumber, type LookupMatch } from "../api/client";
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
    flexWrap: "nowrap",
    columnGap: "14px",
    padding: "10px 16px",
    minWidth: "540px",
    maxWidth: "calc(100vw - 48px)",
    borderRadius: tokens.borderRadiusXLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    boxShadow: tokens.shadow28,
  },
  who: { display: "flex", flexDirection: "column", minWidth: "160px", maxWidth: "240px" },
  name: {
    fontWeight: 600,
    fontSize: "14px",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  num: {
    fontVariantNumeric: "tabular-nums",
    color: tokens.colorNeutralForeground3,
    fontSize: "12px",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  clock: {
    fontVariantNumeric: "tabular-nums",
    fontSize: "18px",
    fontWeight: 700,
    minWidth: "62px",
    textAlign: "center",
    flexShrink: 0,
  },
  spacer: { flex: 1 },
  stateBadge: { flexShrink: 0, whiteSpace: "nowrap" },
  actions: {
    display: "flex",
    columnGap: "8px",
    alignItems: "center",
    flexShrink: 0,
    flexWrap: "nowrap",
    "& button": { whiteSpace: "nowrap", flexShrink: 0, minWidth: "max-content" },
  },
  pad: {
    display: "grid",
    gridTemplateColumns: "repeat(3, 44px)",
    gap: "8px",
    padding: "4px",
  },
  padKey: { minWidth: "44px", height: "44px", fontSize: "16px", fontWeight: 600 },
  dir: { display: "flex", alignItems: "center", columnGap: "6px" },
  chip: {
    position: "fixed",
    left: "18px",
    bottom: "18px",
    zIndex: 999,
    display: "flex",
    alignItems: "center",
    columnGap: "8px",
    padding: "6px 12px",
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    boxShadow: tokens.shadow8,
    fontSize: "12px",
  },
  dot: { width: "9px", height: "9px", borderRadius: "50%" },
  errBar: {
    position: "fixed",
    left: "50%",
    bottom: "84px",
    transform: "translateX(-50%)",
    zIndex: 1001,
    minWidth: "420px",
    maxWidth: "calc(100vw - 48px)",
  },
  linkBtn: { marginTop: "2px", paddingLeft: 0, minWidth: "auto" },
});

const DTMF_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"];

function regColor(state: string): string {
  if (state === "registered") return tokens.colorPaletteGreenBackground3;
  if (state === "registering") return tokens.colorPaletteYellowBackground3;
  return tokens.colorPaletteRedBackground3;
}
function regLabel(state: string): string {
  switch (state) {
    case "registered":
      return "電話 待受中";
    case "registering":
      return "電話 接続中…";
    case "failed":
      return "電話に接続できません";
    default:
      return "電話 未接続";
  }
}
const PRESENCE_LABEL: Record<string, string> = {
  available: "在席中",
  busy: "取り込み中",
  dnd: "通話中（応答不可）",
  away: "離席中",
};

export default function SipCallBar() {
  const s = useStyles();
  const st = useSipState();
  const navigate = useNavigate();
  const [, setTick] = useState(0);
  const [xferOpen, setXferOpen] = useState(false);
  const [xferTo, setXferTo] = useState("");
  const [match, setMatch] = useState<LookupMatch | null>(null);
  const [blocked, setBlocked] = useState(false);
  const lookedUp = useRef<string>("");

  const inCall = st.callState !== "idle";

  // 通話中は1秒ごとに経過時間を更新
  useEffect(() => {
    if (!inCall) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [inCall]);

  // 発信元照会（スクリーンポップ）
  useEffect(() => {
    const num = st.remoteNumber;
    if (!inCall || !num) {
      setMatch(null);
      setBlocked(false);
      lookedUp.current = "";
      return;
    }
    if (lookedUp.current === num) return;
    lookedUp.current = num;
    lookupNumber(num)
      .then((r) => {
        setBlocked(r.is_blocked);
        setMatch(r.matches[0] ?? null);
      })
      .catch(() => {
        setMatch(null);
        setBlocked(false);
      });
  }, [st.remoteNumber, inCall]);

  const incoming = st.callState === "incoming";
  const active = st.callState === "active";
  const held = st.callState === "held";
  const canControl = active || held;

  const displayName = match?.name || st.remoteNumber || "—";

  return (
    <>
      {/* 電話の待受状態チップ（常時表示） */}
      <div className={s.chip} title={regLabel(st.regState)}>
        <span
          className={s.dot}
          style={{ backgroundColor: regColor(st.regState) }}
        />
        <span>{regLabel(st.regState)}</span>
        <span style={{ color: tokens.colorNeutralForeground3 }}>
          ・{PRESENCE_LABEL[st.presence] ?? st.presence}
        </span>
        {st.regState === "failed" && (
          <Button
            size="small"
            appearance="transparent"
            onClick={() => sipService.clearError()}
          >
            閉じる
          </Button>
        )}
      </div>

      {st.lastError && (
        <div className={s.errBar}>
          <MessageBar intent="error">
            <MessageBarBody>{st.lastError}</MessageBarBody>
            <Button
              size="small"
              appearance="transparent"
              icon={<Dismiss20Regular />}
              onClick={() => sipService.clearError()}
              aria-label="閉じる"
            />
          </MessageBar>
        </div>
      )}

      {inCall && (
        <div className={s.bar} role="region" aria-label="通話操作バー">
          <div className={s.dir}>
            {st.callState === "outgoing" || st.callState === "ringing" ? (
              <CallOutbound20Regular
                style={{ color: tokens.colorBrandForeground1 }}
              />
            ) : (
              <CallInbound20Regular
                style={{ color: tokens.colorPaletteGreenForeground1 }}
              />
            )}
          </div>
          <div className={s.who}>
            <span className={s.name}>
              {displayName}
              {blocked ? "（着信拒否対象）" : ""}
            </span>
            <span className={s.num}>
              {st.remoteNumber}
              {match?.contract_no ? ` ・ 契約 ${match.contract_no}` : ""}
            </span>
            {match?.contract_id && (
              <Button
                className={s.linkBtn}
                size="small"
                appearance="transparent"
                onClick={() => navigate(`/contracts/${match.contract_id}`)}
              >
                契約を開く
              </Button>
            )}
          </div>
          <Badge
            className={s.stateBadge}
            appearance="tint"
            color={
              held
                ? "warning"
                : active
                ? "success"
                : incoming
                ? "danger"
                : "informative"
            }
          >
            {stateLabel(st.callState)}
          </Badge>
          {(active || held) && (
            <span className={s.clock}>{fmtClock(sipService.elapsedSec())}</span>
          )}
          <div className={s.spacer} />

          <div className={s.actions}>
            {incoming && (
              <Button
                appearance="primary"
                icon={<Call20Filled />}
                style={{
                  backgroundColor: tokens.colorPaletteGreenBackground3,
                  borderColor: tokens.colorPaletteGreenBackground3,
                }}
                onClick={() => sipService.answer()}
              >
                応答
              </Button>
            )}

            {canControl && !held && (
              <Button
                appearance="secondary"
                icon={<Pause20Regular />}
                onClick={() => sipService.hold()}
              >
                保留
              </Button>
            )}
            {held && (
              <Button
                appearance="secondary"
                icon={<Play20Regular />}
                onClick={() => sipService.unhold()}
              >
                保留解除
              </Button>
            )}
            {canControl && (
              <Button
                appearance="secondary"
                icon={st.isMuted ? <MicOff20Regular /> : <Mic20Regular />}
                onClick={() => sipService.toggleMute()}
              >
                {st.isMuted ? "ミュート中" : "ミュート"}
              </Button>
            )}
            {canControl && (
              <Popover positioning="above" withArrow>
                <PopoverTrigger disableButtonEnhancement>
                  <Button appearance="secondary" icon={<Dialpad20Regular />}>
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
                        onClick={() => sipService.sendDtmf(k)}
                      >
                        {k}
                      </Button>
                    ))}
                  </div>
                </PopoverSurface>
              </Popover>
            )}
            {canControl && (
              <Button
                appearance="secondary"
                icon={<CallTransfer20Regular />}
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
              onClick={() => sipService.hangup()}
            >
              {incoming ? "拒否" : "切電"}
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
                  <Button
                    appearance="secondary"
                    onClick={() => setXferOpen(false)}
                  >
                    やめる
                  </Button>
                  <Button
                    appearance="primary"
                    icon={<CallTransfer20Regular />}
                    disabled={!xferTo.trim()}
                    onClick={() => {
                      sipService.blindTransfer(xferTo.trim());
                      setXferOpen(false);
                    }}
                  >
                    転送する
                  </Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>
        </div>
      )}
    </>
  );
}

function stateLabel(cs: string): string {
  switch (cs) {
    case "incoming":
      return "着信中";
    case "outgoing":
      return "発信中";
    case "ringing":
      return "呼出中";
    case "active":
      return "通話中";
    case "held":
      return "保留中";
    case "consulting":
      return "相談中";
    case "ending":
      return "終了中";
    default:
      return "";
  }
}
