// sipService の状態を React に橋渡しするフック（useSyncExternalStore）。
// getSnapshot は内容が変わらない限り同一参照を返し、無限再描画を防ぐ。
import { useSyncExternalStore } from "react";
import {
  sipService,
  type CallState,
  type PresenceStatus,
  type SipRegistrationState,
} from "./sipService";

export interface SipSnapshot {
  regState: SipRegistrationState;
  callState: CallState;
  remoteNumber: string;
  isMuted: boolean;
  lastError: string | null;
  presence: PresenceStatus;
  consultNumber: string;
}

let cache: SipSnapshot | null = null;
let sig = "";

function getSnapshot(): SipSnapshot {
  const s = sipService;
  const next: SipSnapshot = {
    regState: s.regState,
    callState: s.callState,
    remoteNumber: s.remoteNumber,
    isMuted: s.isMuted,
    lastError: s.lastError,
    presence: s.presence,
    consultNumber: s.consultNumber,
  };
  const nextSig = [
    next.regState,
    next.callState,
    next.remoteNumber,
    next.isMuted ? "1" : "0",
    next.lastError ?? "",
    next.presence,
    next.consultNumber,
  ].join("|");
  if (!cache || nextSig !== sig) {
    cache = next;
    sig = nextSig;
  }
  return cache;
}

function subscribe(cb: () => void): () => void {
  return sipService.subscribe(cb);
}

export function useSipState(): SipSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
