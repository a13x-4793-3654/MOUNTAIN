// MOUNTAIN ブラウザ・ソフトフォン（JsSIP ラッパー）。
// FreePBX の WebRTC(WSS) エンドポイントへ直接登録し、内線・外線の発着信を行う。
// 通話制御（発信/応答/保留/転送/DTMF/切電）はブラウザと交換機が直接やり取りし、
// バックエンドの役割は「発信元の照会（スクリーンポップ）」と「終話後の履歴記録」。
//
// 設定は起動時に /api/config から読み込む（getRuntimeConfig().sip）ため、
// 同一の web イメージのまま DF/本番で交換機接続先を切り替えられる。
import JsSIP from "jssip";
import { getRuntimeConfig } from "../auth/runtimeConfig";
import { getJson, sendJson } from "../api/client";

// jssip の RTCSession はライブラリ内部型のため any で扱う（skipLibCheck 環境）。
type RTCSession = any;

export type SipRegistrationState =
  | "unregistered"
  | "registering"
  | "registered"
  | "failed";
export type CallState =
  | "idle"
  | "incoming"
  | "outgoing"
  | "ringing"
  | "active"
  | "held"
  | "consulting"
  | "ending";
export type PresenceStatus = "available" | "busy" | "away" | "dnd";

type Listener = () => void;

function sipCfg() {
  return getRuntimeConfig().sip;
}

function iceServers(): RTCIceServer[] {
  const stun = sipCfg().stun || "stun:stun.l.google.com:19302";
  return [{ urls: stun }];
}

class SipService {
  private ua: JsSIP.UA | null = null;
  private session: RTCSession | null = null;
  private remoteAudio: HTMLAudioElement | null = null;
  private pc: RTCPeerConnection | null = null;
  private trackBound = false;
  private listeners = new Set<Listener>();

  regState: SipRegistrationState = "unregistered";
  callState: CallState = "idle";
  remoteNumber = "";
  isMuted = false;
  lastError: string | null = null;

  /** 現在のプレゼンス状態（在席/取込中/離席/通話中・応答不可） */
  presence: PresenceStatus = "available";

  callStartedAt: number | null = null;
  callAnsweredAt: number | null = null;
  holdAccumMs = 0;
  holdStartedAt: number | null = null;
  callDirection: "inbound" | "outbound" | null = null;
  private myExtension = "";

  private consultSession: RTCSession | null = null;
  private pendingAttendedTransfer = false;
  consultNumber = "";

  audioInputDeviceId = "";
  audioOutputDeviceId = "";

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify() {
    this.listeners.forEach((fn) => fn());
  }

  get isRegistered(): boolean {
    return this.regState === "registered";
  }

  private ensureRemoteAudio(): HTMLAudioElement {
    if (this.remoteAudio) return this.remoteAudio;
    const el = document.createElement("audio");
    el.autoplay = true;
    el.id = "mountain-remote-audio";
    document.body.appendChild(el);
    this.remoteAudio = el;
    if (this.audioOutputDeviceId) {
      void this.applyAudioOutput(el, this.audioOutputDeviceId);
    }
    return el;
  }

  /**
   * リモート音声トラックを <audio> に確実に接続して再生（受話）。
   * Asterisk の応答 SDP に msid が無い場合、track イベントの streams が空になり
   * ev.streams[0] が undefined となって「相手の声が聞こえない」原因になる。
   * その場合はトラック単体から MediaStream を生成して接続する。
   * autoplay 制限時は次のユーザー操作で再生されるため握りつぶす。
   */
  private bindRemoteAudio(pc: RTCPeerConnection): void {
    this.pc = pc;
    // 応答SDP受信時に既に付いている受信トラックを取りこぼさないよう先に反映
    this.flushReceivers(pc);
    if (this.trackBound) return;
    this.trackBound = true;
    pc.addEventListener("track", (ev: RTCTrackEvent) => {
      if (ev.track.kind !== "audio") return;
      const el = this.ensureRemoteAudio();
      const stream =
        ev.streams && ev.streams[0]
          ? ev.streams[0]
          : new MediaStream([ev.track]);
      el.srcObject = stream;
      el.muted = false;
      el.volume = 1;
      const p = el.play();
      if (p && typeof (p as Promise<void>).catch === "function") {
        (p as Promise<void>).catch(() => {
          /* ブラウザの自動再生制限。次のユーザー操作で再生される */
        });
      }
    });
  }

  /** pc に既に存在する受信音声トラックを <audio> へ確実に接続する。 */
  private flushReceivers(pc: RTCPeerConnection): void {
    try {
      const tracks = (pc.getReceivers?.() ?? [])
        .map((r) => r.track)
        .filter((t): t is MediaStreamTrack => !!t && t.kind === "audio");
      if (!tracks.length) return;
      const el = this.ensureRemoteAudio();
      el.srcObject = new MediaStream(tracks);
      el.muted = false;
      el.volume = 1;
      const p = el.play();
      if (p && typeof (p as Promise<void>).catch === "function") {
        (p as Promise<void>).catch(() => {});
      }
    } catch {
      /* ignore */
    }
  }

  /**
   * 通話成立後に呼ぶ確実な受話接続。JsSIP の session.connection から
   * RTCPeerConnection を取得し、受信トラックを <audio> に接続する。
   * "peerconnection" イベントに依存せず取りこぼしを防ぐ。
   */
  private attachRemoteMedia(): void {
    const pc =
      this.pc ??
      ((this.session as unknown as { connection?: RTCPeerConnection })
        ?.connection ??
        null);
    if (!pc) return;
    this.bindRemoteAudio(pc);
  }

  private buildAudioConstraint(): MediaTrackConstraints | true {
    if (this.audioInputDeviceId) {
      return { deviceId: { exact: this.audioInputDeviceId } };
    }
    return true;
  }

  private async applyAudioOutput(
    el: HTMLAudioElement,
    deviceId: string
  ): Promise<void> {
    try {
      const anyEl = el as HTMLAudioElement & {
        setSinkId?: (id: string) => Promise<void>;
      };
      if (typeof anyEl.setSinkId === "function") {
        await anyEl.setSinkId(deviceId);
      }
    } catch (e) {
      this.lastError = `出力デバイス切替失敗: ${(e as Error).message}`;
      this.notify();
    }
  }

  async listAudioDevices(): Promise<{
    inputs: MediaDeviceInfo[];
    outputs: MediaDeviceInfo[];
  }> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
    } catch {
      /* 許可拒否でも enumerate は試みる */
    }
    const all = await navigator.mediaDevices.enumerateDevices();
    return {
      inputs: all.filter((d) => d.kind === "audioinput"),
      outputs: all.filter((d) => d.kind === "audiooutput"),
    };
  }

  setAudioInputDevice(deviceId: string): void {
    this.audioInputDeviceId = deviceId;
    try {
      localStorage.setItem("mountain.audioInput", deviceId);
    } catch {
      /* ignore */
    }
    this.notify();
  }

  async setAudioOutputDevice(deviceId: string): Promise<void> {
    this.audioOutputDeviceId = deviceId;
    try {
      localStorage.setItem("mountain.audioOutput", deviceId);
    } catch {
      /* ignore */
    }
    if (this.remoteAudio) {
      await this.applyAudioOutput(this.remoteAudio, deviceId);
    }
    this.notify();
  }

  loadAudioPreferences(): void {
    try {
      this.audioInputDeviceId = localStorage.getItem("mountain.audioInput") ?? "";
      this.audioOutputDeviceId =
        localStorage.getItem("mountain.audioOutput") ?? "";
    } catch {
      /* ignore */
    }
  }

  async register(extension: string, password: string): Promise<void> {
    const cfg = sipCfg();
    if (!cfg.wss_url) {
      throw new Error("交換機の接続先（WSS）が未設定です");
    }
    if (!extension) {
      throw new Error("内線番号が割り当てられていません");
    }
    if (this.ua) {
      this.ua.stop();
      this.ua = null;
    }
    this.myExtension = extension;
    const socket = new JsSIP.WebSocketInterface(cfg.wss_url);
    this.ua = new JsSIP.UA({
      sockets: [socket],
      uri: `sip:${extension}@${cfg.realm}`,
      password,
      register: true,
      session_timers: false,
      user_agent: "MOUNTAIN-Web/1.0",
    });

    this.regState = "registering";
    this.lastError = null;
    this.notify();

    this.ua.on("registered", () => {
      this.regState = "registered";
      this.notify();
      void this.refreshPresence();
    });
    this.ua.on("unregistered", () => {
      this.regState = "unregistered";
      this.notify();
    });
    this.ua.on("registrationFailed", (e: any) => {
      this.regState = "failed";
      this.lastError = `登録失敗: ${e?.cause ?? "不明"}`;
      this.notify();
    });
    this.ua.on("newRTCSession", (data: any) => this.handleNewSession(data));

    this.ua.start();
  }

  unregister(): void {
    try {
      this.session?.terminate();
    } catch {
      /* ignore */
    }
    this.session = null;
    this.ua?.stop();
    this.ua = null;
    this.regState = "unregistered";
    this.callState = "idle";
    this.notify();
  }

  private handleNewSession(data: {
    session: RTCSession;
    originator: "local" | "remote";
  }) {
    const session = data.session;

    // アテンドトランスファの相談コールはメイン session を上書きしない
    if (data.originator === "local" && this.pendingAttendedTransfer) {
      this.consultSession = session;
      this.pendingAttendedTransfer = false;
      this.consultNumber = session.remote_identity?.uri?.user ?? "";
      this.callState = "consulting";
      this.notify();
      session.on("peerconnection", (e: { peerconnection: RTCPeerConnection }) => {
        this.bindRemoteAudio(e.peerconnection);
      });
      session.on("ended", () => this.handleConsultEnded());
      session.on("failed", (e: any) => {
        this.lastError = `相談コール失敗: ${e?.cause ?? ""}`;
        this.handleConsultEnded();
      });
      return;
    }

    this.session = session;
    this.callStartedAt = Date.now();
    this.callAnsweredAt = null;
    this.holdAccumMs = 0;
    this.holdStartedAt = null;

    if (data.originator === "remote") {
      this.callState = "incoming";
      this.callDirection = "inbound";
      this.remoteNumber = session.remote_identity?.uri?.user ?? "不明";
      this.showIncomingNotification(this.remoteNumber);
      if (this.presence === "available") {
        void this.setPresence("busy");
      }
    } else {
      this.callState = "outgoing";
      this.callDirection = "outbound";
      this.remoteNumber = session.remote_identity?.uri?.user ?? "";
    }
    this.notify();

    session.on("progress", () => {
      // 発信（outbound）のみ「呼出中」に遷移。着信中(incoming)は上書きしない。
      // JsSIPは着信INVITE受信時に自動で180 Ringingを返し progress を発火するため、
      // ここでガードしないと着信中→呼出中に化けて「応答」ボタンが消える。
      if (this.callDirection === "outbound") {
        this.callState = "ringing";
        this.notify();
      }
    });
    session.on("accepted", () => {
      this.callState = "active";
      this.callAnsweredAt = Date.now();
      this.notify();
      this.attachRemoteMedia();
    });
    session.on("confirmed", () => {
      this.callState = "active";
      if (!this.callAnsweredAt) this.callAnsweredAt = Date.now();
      this.notify();
      this.attachRemoteMedia();
    });
    session.on("ended", () => this.finalizeCall());
    session.on("failed", (e: any) => {
      this.lastError = `通話失敗: ${e?.cause ?? ""}`;
      this.finalizeCall();
    });
    session.on("peerconnection", (e: { peerconnection: RTCPeerConnection }) => {
      this.bindRemoteAudio(e.peerconnection);
    });
  }

  /** 通話終了処理: タイマー停止 + ログ保存 + プレゼンス復帰 */
  private finalizeCall() {
    const startedAt = this.callStartedAt;
    const answeredAt = this.callAnsweredAt;
    const endedAt = Date.now();
    if (this.holdStartedAt) {
      this.holdAccumMs += endedAt - this.holdStartedAt;
      this.holdStartedAt = null;
    }
    const direction = this.callDirection;
    const remote = this.remoteNumber;

    this.callState = "idle";
    this.session = null;
    this.pc = null;
    this.trackBound = false;
    this.callStartedAt = null;
    this.callAnsweredAt = null;
    this.isMuted = false;
    this.notify();

    if (this.presence === "busy") {
      void this.setPresence("available");
    }

    if (startedAt && direction) {
      const ringSec = Math.max(
        0,
        Math.round(((answeredAt ?? endedAt) - startedAt) / 1000)
      );
      const talkSec = answeredAt
        ? Math.max(0, Math.round((endedAt - answeredAt) / 1000))
        : 0;
      const holdSec = Math.round(this.holdAccumMs / 1000);
      void sendJson("POST", "/api/cti/logs", {
        direction: direction === "outbound" ? "out" : "in",
        from_number: direction === "outbound" ? this.myExtension : remote,
        to_number: direction === "outbound" ? remote : this.myExtension,
        started_at: new Date(startedAt).toISOString(),
        ...(answeredAt
          ? { answered_at: new Date(answeredAt).toISOString() }
          : {}),
        ended_at: new Date(endedAt).toISOString(),
        ring_sec: ringSec,
        talk_sec: talkSec,
        hold_sec: holdSec,
      }).catch(() => {
        /* ベストエフォート */
      });
    }
    this.holdAccumMs = 0;
    this.callDirection = null;
  }

  call(target: string): void {
    if (!this.ua || this.regState !== "registered") {
      this.lastError = "電話がまだ使えません（登録待ち）";
      this.notify();
      return;
    }
    const t = (target || "").trim();
    if (!t) return;
    const sipUri = `sip:${t}@${sipCfg().realm}`;
    this.ua.call(sipUri, {
      mediaConstraints: { audio: this.buildAudioConstraint(), video: false },
      pcConfig: { iceServers: iceServers() },
      rtcOfferConstraints: {
        offerToReceiveAudio: true,
        offerToReceiveVideo: false,
      },
    });
  }

  answer(): void {
    if (!this.session || this.callState !== "incoming") return;
    this.session.answer({
      mediaConstraints: { audio: this.buildAudioConstraint(), video: false },
      pcConfig: { iceServers: iceServers() },
    });
  }

  hangup(): void {
    try {
      this.session?.terminate();
    } catch {
      /* ignore */
    }
  }

  hold(): void {
    if (!this.session || this.callState !== "active") return;
    this.session.hold();
    this.holdStartedAt = Date.now();
    this.callState = "held";
    this.notify();
  }

  unhold(): void {
    if (!this.session || this.callState !== "held") return;
    this.session.unhold();
    if (this.holdStartedAt) {
      this.holdAccumMs += Date.now() - this.holdStartedAt;
      this.holdStartedAt = null;
    }
    this.callState = "active";
    this.notify();
  }

  toggleMute(): void {
    if (!this.session) return;
    if (this.isMuted) this.session.unmute({ audio: true });
    else this.session.mute({ audio: true });
    this.isMuted = !this.isMuted;
    this.notify();
  }

  sendDtmf(tone: string): void {
    this.session?.sendDTMF(tone);
  }

  /** ブラインド転送 (REFER)。指定番号へ無条件に転送して自分は切断。 */
  blindTransfer(target: string): void {
    if (
      !this.session ||
      (this.callState !== "active" && this.callState !== "held")
    ) {
      this.lastError = "通話中のみ転送できます";
      this.notify();
      return;
    }
    const sipUri = `sip:${target}@${sipCfg().realm}`;
    try {
      this.session.refer(sipUri);
    } catch (e) {
      this.lastError = `転送失敗: ${(e as Error).message}`;
      this.notify();
    }
  }

  /** アテンドトランスファ開始（相談転送）。 */
  attendedTransferStart(target: string): void {
    if (!this.ua || !this.session) {
      this.lastError = "通話中ではありません";
      this.notify();
      return;
    }
    if (this.callState !== "active" && this.callState !== "held") {
      this.lastError = "アテンドトランスファ開始不可な状態です";
      this.notify();
      return;
    }
    if (this.consultSession) {
      this.lastError = "すでに相談中です";
      this.notify();
      return;
    }
    if (this.callState === "active") this.hold();
    this.pendingAttendedTransfer = true;
    const sipUri = `sip:${target}@${sipCfg().realm}`;
    try {
      this.ua.call(sipUri, {
        mediaConstraints: { audio: this.buildAudioConstraint(), video: false },
        pcConfig: { iceServers: iceServers() },
        rtcOfferConstraints: {
          offerToReceiveAudio: true,
          offerToReceiveVideo: false,
        },
      });
    } catch (e) {
      this.pendingAttendedTransfer = false;
      this.lastError = `相談発信失敗: ${(e as Error).message}`;
      this.notify();
    }
  }

  /** アテンドトランスファ完了。 */
  attendedTransferComplete(): void {
    if (!this.session || !this.consultSession) {
      this.lastError = "相談コールがありません";
      this.notify();
      return;
    }
    try {
      this.session.refer(
        this.consultSession.remote_identity.uri.toString(),
        { replaces: this.consultSession }
      );
    } catch (e) {
      this.lastError = `転送完了失敗: ${(e as Error).message}`;
      this.notify();
    }
  }

  /** アテンドトランスファ中止。 */
  attendedTransferCancel(): void {
    if (this.consultSession) {
      try {
        this.consultSession.terminate();
      } catch {
        /* ignore */
      }
    }
    this.handleConsultEnded();
  }

  private handleConsultEnded(): void {
    this.consultSession = null;
    this.consultNumber = "";
    if (this.session && this.callState === "consulting") {
      try {
        this.session.unhold();
        if (this.holdStartedAt) {
          this.holdAccumMs += Date.now() - this.holdStartedAt;
          this.holdStartedAt = null;
        }
        this.callState = "active";
      } catch {
        this.callState = "held";
      }
    }
    this.notify();
  }

  clearError(): void {
    this.lastError = null;
    this.notify();
  }

  /** プレゼンスをサーバーへ反映（PUT /api/cti/presence）。 */
  async setPresence(status: PresenceStatus): Promise<void> {
    this.presence = status;
    this.notify();
    try {
      await sendJson("PUT", "/api/cti/presence", { status });
    } catch {
      /* オフライン時は許容 */
    }
  }

  /** GET /api/cti/presence で現在のプレゼンスを取得して同期。 */
  async refreshPresence(): Promise<void> {
    try {
      const r = await getJson<{ status?: string }>("/api/cti/presence");
      const s = r?.status as PresenceStatus | undefined;
      if (s && ["available", "busy", "away", "dnd"].includes(s)) {
        this.presence = s;
        this.notify();
      }
    } catch {
      /* ignore */
    }
  }

  elapsedSec(): number {
    const base = this.callAnsweredAt ?? this.callStartedAt;
    if (!base) return 0;
    return Math.floor((Date.now() - base) / 1000);
  }

  async requestNotificationPermission(): Promise<NotificationPermission> {
    if (!("Notification" in window)) return "denied";
    if (Notification.permission === "default") {
      return await Notification.requestPermission();
    }
    return Notification.permission;
  }

  private showIncomingNotification(from: string): void {
    if (!("Notification" in window) || Notification.permission !== "granted")
      return;
    try {
      const n = new Notification("着信", {
        body: `${from} からの着信`,
        tag: "mountain-incoming",
        requireInteraction: true,
        icon: "/favicon.svg",
      });
      n.onclick = () => {
        window.focus();
        n.close();
      };
    } catch {
      /* ignore */
    }
  }
}

export const sipService = new SipService();
