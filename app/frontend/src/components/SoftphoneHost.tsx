// 通話バーの切り替え役。
// 「交換機のWSS接続先が設定済み」かつ「ログイン中ユーザーに内線が割当済み」なら
// 実ソフトフォン（JsSIP→FreePBX直結）で登録し SipCallBar を表示。
// そうでなければ従来のシミュレータ通話バー（CallBar）を表示する。
// これにより 1つのコード・画面のまま DF/本番で無改修に実機接続へ切り替えられる。
import { useEffect } from "react";
import { useAuth } from "../auth/AuthContext";
import { getRuntimeConfig } from "../auth/runtimeConfig";
import { sipService } from "../telephony/sipService";
import SipCallBar from "./SipCallBar";
import CallBar from "./CallBar";

export default function SoftphoneHost() {
  const { me } = useAuth();
  const cfg = getRuntimeConfig();
  const ext = me?.cti_ext_num?.trim() || "";
  const realMode = !!cfg.sip.wss_url && !!ext;

  useEffect(() => {
    if (!realMode) return;
    sipService.loadAudioPreferences();
    void sipService.requestNotificationPermission();
    void sipService.register(ext, me?.cti_password ?? "");
    return () => {
      sipService.unregister();
    };
    // 内線が変わった時のみ登録し直す
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [realMode, ext]);

  return realMode ? <SipCallBar /> : <CallBar />;
}
